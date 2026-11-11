import { createHash, timingSafeEqual } from 'node:crypto';
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  baseUnits, bridgeOf, buildBtcTx, buildCctpBurnTxs, buildCctpMintTx, cctpMintRetryBytes, verifyCctpMint, buildEvmSwapTxs, buildEvmTx, checkMandateOrder, checkOrderPrice, getAsset, MandateSchema, mandateHash, priceSymbolOf, validateMandate, vaultKeyId, buildSolMessage, checkPolicy, getNetwork, IntentSchema, intentHash, pluginFor,
  solWireTransaction, toB64u, type CctpMintGas, type Intent, type Mandate,
} from '@spw/core';
import { buildSolSwapMessage, solV1Wire } from '@spw/core'; // Jupiter swaps on Solana (kept apart from the shared import line)
import type { Keys } from './keys.ts';
import { noPrices, type PriceView } from './prices.ts';
import type { Store, StoredCredential } from './store.ts';
import { venueAuthorize, venueKeyAddress, venueRevoke, venueSign, venueStatus, type VenueCtx, type VenueSignRequest } from './venue.ts';

export class SignerError extends Error { constructor(public code: string, msg: string) { super(msg); } }
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest();
export interface SignerConfig { rpId: string; origin: string }
export interface SignResult { raw: string; txid: string; hash: string; /** swaps with a token input: the exact-amount approval that must be mined first */ pre?: { raw: string; txid: string } }

export class Signer {
  constructor(private keys: Keys, private store: Store, private cfg: SignerConfig, private now: () => number = () => Math.floor(Date.now() / 1000), private prices: PriceView = noPrices) {}

  status() {
    const s = this.store.state, today = new Date(this.now() * 1000).toISOString().slice(0, 10);
    return {
      keyId: this.keys.keyId, addresses: this.keys.addresses, halted: s.halted,
      enrollmentOpen: s.credentials.length === 0 && s.setupTokenHash !== null,
      credentials: s.credentials.map((c) => ({ id: c.id, addedAt: c.addedAt })),
      policy: this.store.policy,
      spentToday: Object.fromEntries(Object.entries(s.spent).filter(([k]) => k.startsWith(today)).map(([k, v]) => [k.slice(11), v])),
      journalHead: s.journal[s.journal.length - 1]?.hash ?? null, journalLength: s.journal.length,
      bridges: Object.entries(s.bridges ?? {}).map(([id, b]) => ({ id, ...b.bridge, approvedAt: b.approvedAt, burnTxid: b.burnTxid, mintTxid: b.mint?.txid ?? null, mintSignatures: b.mint?.signatures ?? 0 })),
      mandates: Object.values(s.mandates ?? {}).map((m) => ({ mandate: m.mandate, approvedAt: m.approvedAt, revoked: m.revoked, revokedAt: m.revokedAt ?? null,
        expired: this.now() >= m.mandate.expiresAt, today: m.usage[today] ?? { sold: {}, orders: 0 } })),
      venues: venueStatus(this.venueCtx()),
    };
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Live derivatives (venue.ts). The trading key is a dedicated key; the main key signs only the venue's agent approval,
  // inside venueAuthorize, after the owner's passkey approved the canonical authorization.
  private venueCtx(): VenueCtx {
    return { keys: this.keys, store: this.store, now: this.now, prices: this.prices, verify: (a, c) => this.verifyAssertion(a, c), fail: (code, msg) => new SignerError(code, msg) };
  }
  venueKey(venue: unknown, network: unknown) { return venueKeyAddress(this.venueCtx(), venue, network); }
  venueAuthorize(authorization: unknown, assertion?: AuthenticationResponseJSON) { return venueAuthorize(this.venueCtx(), authorization, assertion); }
  venueRevoke(authorizationId: string) { return venueRevoke(this.venueCtx(), authorizationId); }
  venueSign(req: VenueSignRequest) { return venueSign(this.venueCtx(), req); }

  private async verifyAssertion(assertion: AuthenticationResponseJSON, challenge: Uint8Array): Promise<StoredCredential> {
    const cred = this.store.state.credentials.find((c) => c.id === assertion.id);
    if (!cred) throw new SignerError('unknown_credential', 'approval was not made with an enrolled passkey');
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response: assertion, expectedChallenge: toB64u(challenge), expectedOrigin: this.cfg.origin, expectedRPID: this.cfg.rpId,
        credential: { id: cred.id, publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')), counter: cred.counter, transports: cred.transports as never },
        requireUserVerification: true,
      });
    } catch (e) { throw new SignerError('bad_approval', `approval verification failed: ${(e as Error).message}`); }
    if (!v.verified || !v.authenticationInfo.userVerified) throw new SignerError('bad_approval', 'approval not verified');
    cred.counter = v.authenticationInfo.newCounter;
    return cred;
  }

  /** First passkey needs the one-time setup token; later ones need an assertion from an already enrolled passkey. */
  async enroll(req: { credential: { id: string; publicKey: string; counter: number; transports?: string[] }; setupToken?: string; assertion?: AuthenticationResponseJSON }): Promise<void> {
    const s = this.store.state, c = req.credential;
    if (!/^[A-Za-z0-9_-]{16,1024}$/.test(c.id) || !/^[A-Za-z0-9_-]{40,2048}$/.test(c.publicKey)) throw new SignerError('bad_request', 'malformed credential');
    if (s.credentials.some((x) => x.id === c.id)) throw new SignerError('conflict', 'credential already enrolled');
    if (s.credentials.length === 0) {
      const given = sha(req.setupToken ?? ''), want = Buffer.from(s.setupTokenHash ?? '', 'hex');
      if (want.length !== 32 || !timingSafeEqual(given, want)) throw new SignerError('forbidden', 'invalid setup token');
      s.setupTokenHash = null; // single use
    } else {
      if (!req.assertion) throw new SignerError('forbidden', 'existing passkey approval required');
      await this.verifyAssertion(req.assertion, enrollChallenge(c.id, c.publicKey));
    }
    s.credentials.push({ id: c.id, publicKey: c.publicKey, counter: c.counter, transports: c.transports, addedAt: new Date().toISOString() });
    this.store.log('credential.enrolled', { id: c.id });
    this.store.save();
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Agent vaults and mandates. A vault key signs only (a) swaps that fit a mandate the owner approved with a passkey, and
  // (b) transfers back to the owner's own address. The owner's key (account 0) is never reachable from these paths.

  vaultAddress(index: number): string { return this.keys.vault(index).address; }

  /** The owner approves a mandate with a passkey assertion over its canonical hash. Limits can only be set here. */
  async approveMandate(raw: unknown, assertion: AuthenticationResponseJSON): Promise<{ mandateId: string; hash: string }> {
    const st = this.store, now = this.now();
    const parsed = MandateSchema.safeParse(raw);
    if (!parsed.success) throw new SignerError('bad_request', 'malformed mandate');
    const m: Mandate = parsed.data;
    const hash = mandateHash(m);
    const deny = (code: string, msg: string): never => { st.log('mandate.denied', { mandateId: m.mandateId, code, msg }); st.save(); throw new SignerError(code, msg); };
    if (st.state.halted) deny('policy', 'emergency halt is active');
    if (m.keyId !== this.keys.keyId) deny('wrong_key', 'mandate targets another key');
    if (m.vault !== this.vaultAddress(m.vaultIndex)) deny('wrong_vault', 'vault address does not match this signer\'s derivation');
    if (st.state.mandates?.[m.mandateId]) deny('replay', 'mandate already recorded');
    try { validateMandate(m, now); } catch (e) { deny('unsupported', (e as Error).message); }
    // v5 (agents on every execution-enabled network): no mandate on a network whose fee ceiling this signer's policy does not set
    if (st.policy.maxFee[m.network] === undefined) deny('policy', 'no fee ceiling in the policy for the mandate\'s network');
    try { await this.verifyAssertion(assertion, hash); } catch (e) { deny((e as SignerError).code ?? 'bad_approval', (e as Error).message); }
    (st.state.mandates ??= {})[m.mandateId] = { mandate: m, approvedAt: new Date(now * 1000).toISOString(), revoked: false, usage: {} };
    st.log('mandate.approved', { mandateId: m.mandateId, hash: Buffer.from(hash).toString('hex'), vaultIndex: m.vaultIndex, vault: m.vault, network: m.network, assets: m.assets.length, expiresAt: m.expiresAt, strategy: m.strategySha256 });
    st.save();
    return { mandateId: m.mandateId, hash: Buffer.from(hash).toString('hex') };
  }

  /** Stopping is always safe: no passkey needed. A revoked mandate can never be re-activated. */
  revokeMandate(mandateId: string): void {
    const sm = this.store.state.mandates?.[mandateId];
    if (!sm) throw new SignerError('not_found', 'unknown mandate');
    if (!sm.revoked) { sm.revoked = true; sm.revokedAt = new Date(this.now() * 1000).toISOString(); this.store.log('mandate.revoked', { mandateId }); this.store.save(); }
  }

  /** Sign one order for an agent vault. No passkey: the mandate is the authorization, and every bound is checked here. */
  async signDelegated(mandateId: string, rawIntent: unknown, aux?: Record<string, unknown>): Promise<SignResult> {
    const st = this.store, now = this.now();
    const sm = st.state.mandates?.[mandateId];
    if (!sm) throw new SignerError('not_found', 'unknown mandate');
    const parsed = IntentSchema.safeParse(rawIntent);
    if (!parsed.success) throw new SignerError('bad_request', 'malformed intent');
    const i: Intent = parsed.data, m = sm.mandate, hash = intentHash(i);
    const deny = (code: string, msg: string): never => { st.log('delegated.denied', { mandateId, proposalId: i.proposalId, code, msg }); st.save(); throw new SignerError(code, msg); };
    if (st.state.used[i.proposalId] !== undefined) deny('replay', 'order already signed');
    let net; try { net = getNetwork(i.network); } catch { return deny('wrong_chain', 'unknown network'); }
    if (i.chainRef !== net.chainRef) deny('wrong_chain', 'chain identity mismatch');
    const vault = this.keys.vault(m.vaultIndex);
    if (vault.address !== m.vault) deny('wrong_vault', 'vault derivation mismatch');
    const day = new Date(now * 1000).toISOString().slice(0, 10);
    const usage = sm.usage[day] ?? { sold: {}, orders: 0 };
    const verdict = checkMandateOrder(m, i, usage, now, { halted: st.state.halted, revoked: sm.revoked, maxFee: st.policy.maxFee[i.network] });
    if (!verdict.ok) deny('mandate', verdict.reason);
    let txs;
    try { txs = buildEvmSwapTxs(i, typeof aux?.swapData === 'string' ? aux.swapData : ''); } // recipient = vault, minimum output, exact amount: same checks as for the owner
    catch (e) { return deny('unsupported', (e as Error).message); }
    // the signer's own price check: the guaranteed output must be worth close to what is given up, at prices it fetched itself
    // v5: each asset is valued at the exchange price of the market symbol it TRACKS (WETH as ETH, cbBTC as BTC…): a wrapper
    // that has lost its peg cannot deliver that value, so the check below refuses the order (fail closed)
    const outAsset = getAsset(i.network, i.swap!.toAsset);
    let px: Record<string, number>;
    try {
      const pIn = priceSymbolOf(getAsset(i.network, i.asset)).symbol, pOut = priceSymbolOf(outAsset).symbol;
      const got = await this.prices.get([pIn, pOut]);
      px = { [i.symbol]: got[pIn]!, [outAsset.symbol]: got[pOut]! };
    } catch (e) { return deny('no_price', `market price unavailable (${(e as Error).message.slice(0, 80)}); order refused`); }
    const fair = checkOrderPrice(m, i, px, outAsset.symbol, outAsset.decimals);
    if (!fair.ok) deny('price', fair.reason);
    // count the order before releasing a signature
    usage.sold[i.asset] = (BigInt(usage.sold[i.asset] ?? '0') + baseUnits(i.amount)).toString(); usage.orders += 1; sm.usage[day] = usage;
    st.state.used[i.proposalId] = i.expiresAt; st.prune(now);
    const acct = privateKeyToAccount(`0x${Buffer.from(vault.priv).toString('hex')}`);
    const raw = await acct.signTransaction(txs.swap), pre = txs.approve ? await acct.signTransaction(txs.approve) : null;
    const out: SignResult = { raw, txid: keccak256(raw), hash: Buffer.from(hash).toString('hex'), ...(pre ? { pre: { raw: pre, txid: keccak256(pre) } } : {}) };
    st.log('delegated.ok', { mandateId, proposalId: i.proposalId, hash: out.hash, symbol: i.symbol, amount: i.amount, toAsset: i.swap!.toAsset, minOut: i.swap!.minOut, txid: out.txid });
    st.save();
    return out;
  }

  /** Move funds out of a vault — only ever to the owner's own address. Works for revoked and expired mandates too. */
  async signReturn(mandateId: string, rawIntent: unknown): Promise<SignResult> {
    const st = this.store, now = this.now();
    const sm = st.state.mandates?.[mandateId];
    if (!sm) throw new SignerError('not_found', 'unknown mandate');
    const parsed = IntentSchema.safeParse(rawIntent);
    if (!parsed.success) throw new SignerError('bad_request', 'malformed intent');
    const i: Intent = parsed.data, m = sm.mandate, hash = intentHash(i);
    const deny = (code: string, msg: string): never => { st.log('return.denied', { mandateId, proposalId: i.proposalId, code, msg }); st.save(); throw new SignerError(code, msg); };
    if (st.state.used[i.proposalId] !== undefined) deny('replay', 'already signed');
    if (i.swap) deny('unsupported', 'a return is a plain transfer');
    if (i.keyId !== vaultKeyId(m.keyId, m.vaultIndex) || i.network !== m.network) deny('wrong_key', 'intent is not for this vault');
    const vault = this.keys.vault(m.vaultIndex);
    if (i.from !== vault.address) deny('wrong_source', 'source is not the vault');
    if (i.to !== this.keys.addresses.evm) deny('wrong_destination', 'a vault can only pay the owner\'s own address');
    if (i.expiresAt <= now || i.expiresAt - i.createdAt > 300) deny('policy', 'validity window is not acceptable');
    const fee = st.policy.maxFee[i.network];
    if (fee === undefined || baseUnits(i.maxFee) > baseUnits(fee)) deny('policy', 'fee ceiling above policy');
    let tx; try { tx = buildEvmTx(i); } catch (e) { return deny('unsupported', (e as Error).message); }
    st.state.used[i.proposalId] = i.expiresAt; st.prune(now);
    const raw = await privateKeyToAccount(`0x${Buffer.from(vault.priv).toString('hex')}`).signTransaction(tx);
    const out = { raw, txid: keccak256(raw), hash: Buffer.from(hash).toString('hex') };
    st.log('return.ok', { mandateId, proposalId: i.proposalId, symbol: i.symbol, amount: i.amount, txid: out.txid });
    st.save();
    return out;
  }

  /**
   * Bring funds back from an agent vault to the owner, on any EVM network, with or without a mandate (a vault that never had
   * one, or funds sent to the vault's address on another network than the agent's). No passkey: the only possible destination
   * is the owner's own address, so the worst a compromised API can do with this is move the owner's vault funds to the owner.
   */
  async signVaultReturn(index: number, rawIntent: unknown): Promise<SignResult> {
    const st = this.store, now = this.now();
    if (!Number.isInteger(index) || index < 1) throw new SignerError('bad_request', 'bad vault index');
    const parsed = IntentSchema.safeParse(rawIntent);
    if (!parsed.success) throw new SignerError('bad_request', 'malformed intent');
    const i: Intent = parsed.data, hash = intentHash(i);
    const deny = (code: string, msg: string): never => { st.log('return.denied', { vaultIndex: index, proposalId: i.proposalId, code, msg }); st.save(); throw new SignerError(code, msg); };
    if (st.state.used[i.proposalId] !== undefined) deny('replay', 'already signed');
    if (i.swap || (i as { bridge?: unknown }).bridge) deny('unsupported', 'a return is a plain transfer');
    let net; try { net = getNetwork(i.network); } catch { return deny('wrong_chain', 'unknown network'); }
    if (net.family !== 'evm' || i.chainRef !== net.chainRef) deny('wrong_chain', 'vaults exist on EVM networks only');
    if (i.keyId !== vaultKeyId(this.keys.keyId, index)) deny('wrong_key', 'intent is not for this vault');
    const vault = this.keys.vault(index);
    if (i.from !== vault.address) deny('wrong_source', 'source is not the vault');
    if (i.to !== this.keys.addresses.evm) deny('wrong_destination', 'a vault can only pay the owner\'s own address');
    if (i.expiresAt <= now || i.expiresAt - i.createdAt > 300) deny('policy', 'validity window is not acceptable');
    const fee = st.policy.maxFee[i.network];
    if (fee === undefined || baseUnits(i.maxFee) > baseUnits(fee)) deny('policy', 'fee ceiling above policy');
    let tx; try { tx = buildEvmTx(i); } catch (e) { return deny('unsupported', (e as Error).message); }
    st.state.used[i.proposalId] = i.expiresAt; st.prune(now);
    const raw = await privateKeyToAccount(`0x${Buffer.from(vault.priv).toString('hex')}`).signTransaction(tx);
    const out = { raw, txid: keccak256(raw), hash: Buffer.from(hash).toString('hex') };
    st.log('return.ok', { vaultIndex: index, network: i.network, proposalId: i.proposalId, symbol: i.symbol, amount: i.amount, txid: out.txid });
    st.save();
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Second leg of a bridge. The owner's passkey approval of the burn committed to the whole transfer (route, amount, fee
  // ceiling, recipient = the wallet). This signs the matching receiveMessage on the destination: it can only mint the
  // wallet's own burned USDC to the wallet's own address, and costs at most the policy fee ceiling of that network.
  //   - exactly one signature per bridge without a passkey; an identical request returns the same bytes again;
  //   - any further signature (stuck or replaced transaction) needs a fresh passkey assertion over the exact new parameters;
  //   - one message serves one bridge only.
  async signBridgeMint(req: BridgeMintRequest): Promise<BridgeMintResult> {
    const st = this.store, now = this.now();
    const id = String(req?.proposalId ?? '');
    const deny = (code: string, msg: string): never => { st.log('bridge.mint.denied', { proposalId: id, code, msg }); st.save(); throw new SignerError(code, msg); };
    const rec = st.state.bridges?.[id];
    if (!rec) throw new SignerError('not_found', 'no approved bridge with this id');
    if (st.state.halted) deny('policy', 'emergency halt is active');
    const g = req.evm;
    if (!g || typeof g.nonce !== 'number' || [g.gasLimit, g.maxFeePerGas, g.maxPriorityFeePerGas].some((v) => typeof v !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(v))) deny('bad_request', 'malformed gas parameters');
    if (typeof req.message !== 'string' || typeof req.attestation !== 'string' || req.message.length > 4000 || req.attestation.length > 2000) deny('bad_request', 'malformed message');
    const b = rec.bridge;
    if (b.wallet !== this.keys.addresses.evm || this.keys.addresses[b.toNetwork] !== b.wallet) deny('wrong_source', 'bridge is not for this wallet');
    const ceiling = st.policy.maxFee[b.toNetwork];
    if (ceiling === undefined) deny('policy', 'no fee ceiling in the policy for the destination network');
    let tx, v;
    try { v = verifyCctpMint(b, req.message, req.attestation); tx = buildCctpMintTx(b, req.message, req.attestation, g, baseUnits(ceiling!)); }
    catch (e) { return deny('unsupported', (e as Error).message); }
    for (const [other, r] of Object.entries(st.state.bridges ?? {})) if (other !== id && r.mint?.messageHash === v.messageHash) deny('replay', 'this message already served another bridge');
    const params = [v.messageHash, req.attestation.toLowerCase(), g.nonce, g.gasLimit, g.maxFeePerGas, g.maxPriorityFeePerGas].join('|');
    let signatures = 1;
    if (rec.mint) {
      if (rec.mint.params === params && !req.assertion) return { raw: rec.mint.raw, txid: rec.mint.txid, messageHash: v.messageHash, minted: v.minted.toString(), replayed: true }; // same bytes, no new signature
      if (!req.assertion) deny('replay', 'a mint was already signed for this bridge; another signature needs the owner\'s passkey');
      if (rec.mint.signatures >= 6) deny('policy', 'too many mint signatures for this bridge');
      try { await this.verifyAssertion(req.assertion!, new Uint8Array(sha(cctpMintRetryBytes(id, v.messageHash, g)))); } catch (e) { deny((e as SignerError).code ?? 'bad_approval', (e as Error).message); }
      signatures = rec.mint.signatures + 1;
    }
    const raw = await privateKeyToAccount(`0x${Buffer.from(this.keys.evmPriv).toString('hex')}`).signTransaction(tx!);
    const txid = keccak256(raw);
    rec.mint = { messageHash: v.messageHash, txid, raw, params, signedAt: now, signatures };
    st.prune(now);
    st.log('bridge.mint.ok', { proposalId: id, messageHash: v.messageHash, fromNetwork: b.fromNetwork, toNetwork: b.toNetwork, amount: b.amount, minted: v.minted.toString(), feeExecuted: v.msg.body.feeExecuted.toString(), txid, signatures, burnTxid: rec.burnTxid });
    st.save(); // durable before the signature leaves
    return { raw, txid, messageHash: v.messageHash, minted: v.minted.toString(), replayed: false };
  }

  halt(): void {
    this.store.state.halted = true;
    this.store.log('halt.on', {});
    this.store.save();
  }

  async sign(rawIntent: unknown, assertion: AuthenticationResponseJSON, aux?: Record<string, unknown>): Promise<SignResult> {
    const st = this.store, now = this.now();
    const parsed = IntentSchema.safeParse(rawIntent);
    if (!parsed.success) throw new SignerError('bad_request', 'malformed intent');
    const i: Intent = parsed.data;
    const hash = intentHash(i);
    const deny = (code: string, msg: string): never => {
      st.log('sign.denied', { proposalId: i.proposalId, hash: Buffer.from(hash).toString('hex'), code, msg });
      st.save();
      throw new SignerError(code, msg);
    };
    if (i.keyId !== this.keys.keyId) deny('wrong_key', 'intent targets another key');
    let net;
    try { net = getNetwork(i.network); } catch { return deny('wrong_chain', 'unknown network'); }
    if (i.chainRef !== net.chainRef) deny('wrong_chain', 'chain identity mismatch');
    const own = this.keys.addresses[net.id];
    if (!own) deny('wrong_chain', 'no key for this network');
    if (i.from !== own) deny('wrong_source', 'source address is not controlled by this signer');
    if (i.swap || i.bridge ? i.to !== own : i.to === own) deny('self_send', i.swap ? 'a swap must deliver to the wallet itself' : i.bridge ? 'a bridge must deliver to the wallet itself' : 'destination equals source');
    if (st.state.used[i.proposalId] !== undefined) deny('replay', 'proposal already signed');

    const day = new Date(now * 1000).toISOString().slice(0, 10), spendKey = `${day}|${i.network}:${i.symbol}`;
    const verdict = checkPolicy(st.policy, i, BigInt(st.state.spent[spendKey] ?? '0'), now, st.state.halted);
    if (!verdict.ok) deny('policy', verdict.reason);

    // Rebuild the chain transaction from the intent alone; any unsupported shape throws here.
    let build: () => Promise<{ raw: string; txid: string; pre?: { raw: string; txid: string } }>;
    try {
      if (i.bridge) {
        // nothing provider-built: approval and burn are rebuilt from the intent and the pinned tables
        if (i.swap) throw new Error('an intent is a swap or a bridge, not both');
        const txs = buildCctpBurnTxs(i);
        if (this.keys.addresses[i.bridge.toNetwork] !== own) throw new Error('the destination network is not served by the same wallet address');
        if (st.policy.maxFee[i.bridge.toNetwork] === undefined) throw new Error('no fee ceiling in the policy for the destination network');
        if (st.state.bridges?.[i.proposalId]) throw new Error('bridge already recorded');
        build = async () => {
          const acct = privateKeyToAccount(`0x${Buffer.from(this.keys.evmPriv).toString('hex')}`);
          const raw = await acct.signTransaction(txs.burn);
          const pre = txs.approve ? await acct.signTransaction(txs.approve) : null;
          // the approved bridge is recorded with the burn it authorised: it is the only authority for the later mint
          (st.state.bridges ??= {})[i.proposalId] = { bridge: bridgeOf(i), approvedAt: now, burnTxid: keccak256(raw) };
          return { raw, txid: keccak256(raw), ...(pre ? { pre: { raw: pre, txid: keccak256(pre) } } : {}) };
        };
      } else if (i.swap && net.family === 'sol') {
        // Jupiter on Solana: the message bytes come as unauthenticated helper data; the signer decodes them and checks the
        // single signer, every instruction, the wallet's own token accounts, the exact input and the minimum output
        const msg = buildSolSwapMessage(i, typeof aux?.swapMessage === 'string' ? aux.swapMessage : '');
        build = async () => {
          const sig = ed25519.sign(msg, this.keys.solSeed);
          return { raw: Buffer.from(solV1Wire(sig, msg)).toString('base64'), txid: base58.encode(sig) };
        };
      } else if (i.swap) {
        // the provider calldata comes as unauthenticated helper data: it must hash to the approved value and pass every check
        const data = typeof aux?.swapData === 'string' ? aux.swapData : '';
        const txs = buildEvmSwapTxs(i, data);
        build = async () => {
          const acct = privateKeyToAccount(`0x${Buffer.from(this.keys.evmPriv).toString('hex')}`);
          const raw = await acct.signTransaction(txs.swap);
          const pre = txs.approve ? await acct.signTransaction(txs.approve) : null;
          return { raw, txid: keccak256(raw), ...(pre ? { pre: { raw: pre, txid: keccak256(pre) } } : {}) };
        };
      } else if (net.family === 'evm') {
        const tx = buildEvmTx(i);
        build = async () => {
          const raw = await privateKeyToAccount(`0x${Buffer.from(this.keys.evmPriv).toString('hex')}`).signTransaction(tx);
          return { raw, txid: keccak256(raw) };
        };
      } else if (net.family === 'btc') {
        const tx = buildBtcTx(i, aux);
        build = async () => { tx.sign(this.keys.utxoPriv(net)); tx.finalize(); return { raw: tx.hex, txid: tx.id }; };
      } else if (net.family === 'sol') {
        const msg = buildSolMessage(i);
        build = async () => {
          const sig = ed25519.sign(msg, this.keys.solSeed);
          return { raw: Buffer.from(solWireTransaction(sig, msg)).toString('base64'), txid: base58.encode(sig) };
        };
      } else {
        const plugin = pluginFor(net);
        plugin.build(i, net, aux); // must throw on anything unsupported, before the approval is even looked at
        build = async () => plugin.sign(i, net, this.keys.handle(net), aux);
      }
    } catch (e) { return deny('unsupported', (e as Error).message); }

    // The passkey assertion's challenge IS the intent hash: approval is bound to these exact fields.
    try { await this.verifyAssertion(assertion, hash); } catch (e) { deny((e as SignerError).code ?? 'bad_approval', (e as Error).message); }

    // Persist replay marker + spend + journal BEFORE releasing a signature.
    st.state.used[i.proposalId] = i.expiresAt;
    st.state.spent[spendKey] = (BigInt(st.state.spent[spendKey] ?? '0') + baseUnits(i.amount)).toString();
    st.prune(now);
    const out = await build!();
    st.log('sign.ok', { proposalId: i.proposalId, hash: Buffer.from(hash).toString('hex'), network: i.network, symbol: i.symbol, amount: i.amount, to: i.to, txid: out.txid, ...(i.swap ? { swap: i.swap.provider, toAsset: i.swap.toAsset, minOut: i.swap.minOut } : {}),
      ...(i.bridge ? { bridge: i.bridge.provider, toNetwork: i.bridge.toNetwork, cctpMaxFee: i.bridge.maxFee, minFinalityThreshold: i.bridge.minFinalityThreshold } : {}) });
    st.save();
    return { ...out, hash: Buffer.from(hash).toString('hex') };
  }
}

export interface BridgeMintRequest { proposalId: string; message: string; attestation: string; evm: CctpMintGas; assertion?: AuthenticationResponseJSON }
export interface BridgeMintResult { raw: string; txid: string; messageHash: string; minted: string; replayed: boolean }

export interface DelegatedSigner {
  vaultAddress(index: number): string;
  approveMandate(raw: unknown, assertion: AuthenticationResponseJSON): Promise<{ mandateId: string; hash: string }>;
  revokeMandate(mandateId: string): void;
  signDelegated(mandateId: string, rawIntent: unknown, aux?: Record<string, unknown>): Promise<SignResult>;
  signReturn(mandateId: string, rawIntent: unknown): Promise<SignResult>;
}

export function enrollChallenge(credId: string, publicKey: string): Uint8Array {
  return new Uint8Array(sha(`SPW-ENROLL-v1\n${credId}\n${publicKey}`));
}
