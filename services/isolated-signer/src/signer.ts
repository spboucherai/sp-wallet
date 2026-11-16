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
import { buildXswapBtcTx, buildXswapEvmTxs, verifyXswap, type NetworkDef } from '@spw/core'; // THORChain native swaps
// v8 — Solana ↔ EVM USDC (Circle CCTP on Solana): every transaction is built here from the approved intent or bridge record
import { buildCctpSolBurnMessage, buildCctpSolMintMessage, buildCctpSolReclaimMessage, buildSolTokenAccountMessage, CCTP_SOL_NETWORK, CCTP_SOL_RECLAIM_WINDOW_SEC, cctpSolMintRetryBytes, cctpSolReclaimBytes, SolTokenAccountSchema, solTokenAccountHash, solV1WireSigned, type SolBudget } from '@spw/core';
import { noVaults, type VaultView } from './vaults.ts';
import type { Keys } from './keys.ts';
import { noPrices, type PriceView } from './prices.ts';
import type { Store, StoredBridge, StoredCredential } from './store.ts';
import { venueAuthorizationAgain, venueAuthorize, venueKeyAddress, venueRevoke, venueSign, venueStatus, type VenueCtx, type VenueSignRequest } from './venue.ts';
import { venueDepositVerdict, venueWithdraw } from './venue-collateral.ts';
import { venueMandateApprove, venueMandateRevoke, venueMandateSign, venueMandateStatus, type VenueMandateSignRequest } from './venue-mandate.ts';
import { noVenueReader, type VenueReader } from './venue-read.ts';
import { venueQuotingApprove, venueQuotingRevoke, venueQuotingSign, venueQuotingStatus, type VenueQuotingSignRequest } from './venue-quoting.ts'; // V11 market making
import { checkPolicyNoSpend } from '@spw/core'; // v8 GMX: decrease / cancel move no asset amount
import { gmxAuthorize, gmxPlainVerdict, gmxPrepare, gmxRevoke, gmxStatus } from './venue-gmx.ts'; // v8 GMX v2 orders (wallet transactions built here)

export class SignerError extends Error { constructor(public code: string, msg: string) { super(msg); } }
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest();
export interface SignerConfig { rpId: string; origin: string }
export interface SignResult { raw: string; txid: string; hash: string; /** swaps with a token input: the exact-amount approval that must be mined first */ pre?: { raw: string; txid: string };
  /** v8, a burn on Solana: public key of the one-time event account the signer generated and co-signed with */ eventAccount?: string }

export class Signer {
  constructor(private keys: Keys, private store: Store, private cfg: SignerConfig, private now: () => number = () => Math.floor(Date.now() / 1000), private prices: PriceView = noPrices, private venueInfo: VenueReader = noVenueReader, private vaults: VaultView = noVaults) {}

  status() {
    const s = this.store.state, today = new Date(this.now() * 1000).toISOString().slice(0, 10);
    return {
      keyId: this.keys.keyId, addresses: this.keys.addresses, halted: s.halted,
      enrollmentOpen: s.credentials.length === 0 && s.setupTokenHash !== null,
      credentials: s.credentials.map((c) => ({ id: c.id, addedAt: c.addedAt })),
      policy: this.store.policy,
      spentToday: Object.fromEntries(Object.entries(s.spent).filter(([k]) => k.startsWith(today)).map(([k, v]) => [k.slice(11), v])),
      journalHead: this.store.journalHead()?.hash ?? null, journalLength: this.store.journalHead()?.seq ?? 0,
      bridges: Object.entries(s.bridges ?? {}).map(([id, b]) => ({ id, ...b.bridge, approvedAt: b.approvedAt, burnTxid: b.burnTxid, mintTxid: b.mint?.txid ?? null, mintSignatures: b.mint?.signatures ?? 0,
        ...(b.sol ? { eventAccount: b.sol.eventAccount, reclaimTxid: b.reclaim?.txid ?? null, reclaimSignatures: b.reclaim?.signatures ?? 0 } : {}) })),
      mandates: Object.values(s.mandates ?? {}).map((m) => ({ mandate: m.mandate, approvedAt: m.approvedAt, revoked: m.revoked, revokedAt: m.revokedAt ?? null,
        expired: this.now() >= m.mandate.expiresAt, today: m.usage[today] ?? { sold: {}, orders: 0 } })),
      venues: venueStatus(this.venueCtx()),
      venueMandates: venueMandateStatus(this.venueCtx()),
      venueQuotingMandates: venueQuotingStatus(this.venueCtx()), // V11
      gmx: gmxStatus(this.venueCtx()), // v8
    };
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Live derivatives (venue.ts). The trading key is a dedicated key; the main key signs only the venue's agent approval,
  // inside venueAuthorize, after the owner's passkey approved the canonical authorization.
  private venueCtx(): VenueCtx {
    return { keys: this.keys, store: this.store, now: this.now, prices: this.prices, venueInfo: this.venueInfo, verify: (a, c) => this.verifyAssertion(a, c), fail: (code, msg) => new SignerError(code, msg) };
  }
  venueKey(venue: unknown, network: unknown) { return venueKeyAddress(this.venueCtx(), venue, network); }
  venueAuthorize(authorization: unknown, assertion?: AuthenticationResponseJSON) { return venueAuthorize(this.venueCtx(), authorization, assertion); }
  venueRevoke(authorizationId: string) { return venueRevoke(this.venueCtx(), authorizationId); }
  /** V11: the stored answer of an authorization, again (a lost answer no longer locks the venue account) — nothing is signed */
  venueAuthorization(authorizationId: string) { return venueAuthorizationAgain(this.venueCtx(), authorizationId); }
  venueSign(req: VenueSignRequest) { return venueSign(this.venueCtx(), req); }
  /** collateral: withdraw3 to the wallet's own address, the second (and last) kind of venue message the main key signs */
  venueWithdraw(withdrawal: unknown, assertion?: AuthenticationResponseJSON) { return venueWithdraw(this.venueCtx(), withdrawal, assertion); }
  // derivative mandates (venue-mandate.ts): one passkey approval, then orders without a passkey inside limits enforced here
  venueMandateApprove(mandate: unknown, assertion?: AuthenticationResponseJSON) { return venueMandateApprove(this.venueCtx(), mandate, assertion); }
  venueMandateSign(req: VenueMandateSignRequest) { return venueMandateSign(this.venueCtx(), req); }
  venueMandateRevoke(mandateId: string) { return venueMandateRevoke(this.venueCtx(), mandateId); }
  // V11 quoting mandates (venue-quoting.ts): one passkey approval, then post-only quotes, reduce-only orders, cancels and the
  // venue's dead man's switch without a passkey, inside limits enforced here
  venueQuotingApprove(mandate: unknown, assertion?: AuthenticationResponseJSON) { return venueQuotingApprove(this.venueCtx(), mandate, assertion); }
  venueQuotingSign(req: VenueQuotingSignRequest) { return venueQuotingSign(this.venueCtx(), req); }
  venueQuotingRevoke(mandateId: string) { return venueQuotingRevoke(this.venueCtx(), mandateId); }
  // v8 GMX v2: the venue policy (passkey, once); orders themselves go through `sign` with an intent carrying a `gmx` section
  gmxAuthorize(authorization: unknown, assertion?: AuthenticationResponseJSON) { return gmxAuthorize(this.venueCtx(), authorization, assertion); }
  gmxRevoke(authorizationId: string) { return gmxRevoke(this.venueCtx(), authorizationId); }

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
    // V11 (D2): ONE mandate in force per vault. A second one is refused rather than silently superseding the first: its daily
    // caps would add up with the first one's, and replacing limits must be a visible act (revoke — no passkey — then approve).
    // Same rule as derivative mandates (venue-mandate.ts). A vault is one HD account whatever the network, so the rule is per index.
    for (const other of Object.values(st.state.mandates ?? {})) {
      if (other.mandate.vaultIndex === m.vaultIndex && !other.revoked && now < other.mandate.expiresAt) deny('conflict', 'another mandate is active on this vault: revoke it first');
    }
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
    if (rec.bridge.toNetwork === CCTP_SOL_NETWORK) return this.bridgeMintSol(id, rec, req, deny); // v8: the mint is a Solana transaction
    const g = req.evm!;
    if (!g || typeof g.nonce !== 'number' || [g.gasLimit, g.maxFeePerGas, g.maxPriorityFeePerGas].some((v) => typeof v !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(v))) deny('bad_request', 'malformed gas parameters');
    if (typeof req.message !== 'string' || typeof req.attestation !== 'string' || req.message.length > 4000 || req.attestation.length > 2000) deny('bad_request', 'malformed message');
    const b = rec.bridge;
    // v8: a bridge from Solana names its EVM recipient; both ends must be this wallet's own addresses. Between EVM networks the rule is the previous one.
    if (b.recipient === undefined ? (b.wallet !== this.keys.addresses.evm || this.keys.addresses[b.toNetwork] !== b.wallet)
      : (this.keys.addresses[b.fromNetwork] !== b.wallet || this.keys.addresses[b.toNetwork] !== b.recipient)) deny('wrong_source', 'bridge is not for this wallet');
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

  // ---------------------------------------------------------------------------------------------------------------------
  // v8 — Solana ↔ EVM (Circle CCTP V2 on Solana, packages/core/src/cctp-sol-tx.ts). Same rules as the EVM mint above.

  /** The mint of an EVM → Solana bridge: receive_message, payer = the wallet, credited account = the wallet's own USDC token account. */
  private async bridgeMintSol(id: string, rec: StoredBridge, req: BridgeMintRequest, deny: (code: string, msg: string) => never): Promise<BridgeMintResult> {
    const st = this.store, now = this.now(), b = rec.bridge, g = req.sol;
    if (!g || typeof g.recentBlockhash !== 'string' || !Number.isInteger(g.lastValidBlockHeight) || !Number.isInteger(g.computeUnitLimit) || typeof g.computeUnitPrice !== 'string') return deny('bad_request', 'malformed transaction parameters');
    if (typeof req.message !== 'string' || typeof req.attestation !== 'string' || req.message.length > 4000 || req.attestation.length > 2000) deny('bad_request', 'malformed message');
    if (b.recipient === undefined || this.keys.addresses[b.fromNetwork] !== b.wallet || this.keys.addresses[b.toNetwork] !== b.recipient) deny('wrong_source', 'bridge is not for this wallet');
    const ceiling = st.policy.maxFee[b.toNetwork];
    if (ceiling === undefined) deny('policy', 'no fee ceiling in the policy for the destination network');
    let built, v;
    try { v = verifyCctpMint(b, req.message, req.attestation); built = buildCctpSolMintMessage(b, req.message, req.attestation, g, baseUnits(ceiling!)); }
    catch (e) { return deny('unsupported', (e as Error).message); }
    for (const [other, r] of Object.entries(st.state.bridges ?? {})) if (other !== id && r.mint?.messageHash === v.messageHash) deny('replay', 'this message already served another bridge');
    const params = [v.messageHash, req.attestation.toLowerCase(), g.recentBlockhash, g.lastValidBlockHeight, g.computeUnitLimit, g.computeUnitPrice].join('|');
    let signatures = 1;
    if (rec.mint) {
      if (rec.mint.params === params && !req.assertion) return { raw: rec.mint.raw, txid: rec.mint.txid, messageHash: v.messageHash, minted: v.minted.toString(), replayed: true }; // same bytes, no new signature
      if (!req.assertion) deny('replay', 'a mint was already signed for this bridge; another signature needs the owner\'s passkey');
      if (rec.mint.signatures >= 6) deny('policy', 'too many mint signatures for this bridge');
      try { await this.verifyAssertion(req.assertion!, new Uint8Array(sha(cctpSolMintRetryBytes(id, v.messageHash, g)))); } catch (e) { deny((e as SignerError).code ?? 'bad_approval', (e as Error).message); }
      signatures = rec.mint.signatures + 1;
    }
    const sig = ed25519.sign(built.msg, this.keys.solSeed);
    const raw = Buffer.from(solV1WireSigned([sig], built.msg)).toString('base64'), txid = base58.encode(sig);
    rec.mint = { messageHash: v.messageHash, txid, raw, params, signedAt: now, signatures };
    st.prune(now);
    st.log('bridge.mint.ok', { proposalId: id, messageHash: v.messageHash, fromNetwork: b.fromNetwork, toNetwork: b.toNetwork, amount: b.amount, minted: v.minted.toString(), feeExecuted: v.msg.body.feeExecuted.toString(), txid, signatures, burnTxid: rec.burnTxid, tokenAccount: built.tokenAccount });
    st.save(); // durable before the signature leaves
    return { raw, txid, messageHash: v.messageHash, minted: v.minted.toString(), replayed: false };
  }

  /**
   * The rent of the event account of a Solana burn, back to the wallet (reclaim_event_account). The program lets only the
   * recorded rent payer sign for it — the wallet — and pays the wallet; the one-time event key is not needed and no longer
   * exists. Every reclaim signature needs the owner's passkey over the exact transaction parameters.
   */
  async signBridgeReclaim(req: BridgeReclaimRequest): Promise<{ raw: string; txid: string; eventAccount: string }> {
    const st = this.store, now = this.now();
    const id = String(req?.proposalId ?? '');
    const deny = (code: string, msg: string): never => { st.log('bridge.reclaim.denied', { proposalId: id, code, msg }); st.save(); throw new SignerError(code, msg); };
    const rec = st.state.bridges?.[id];
    if (!rec) throw new SignerError('not_found', 'no approved bridge with this id');
    if (st.state.halted) deny('policy', 'emergency halt is active');
    const b = rec.bridge, g = req.sol, ev = rec.sol?.eventAccount;
    if (!ev || b.fromNetwork !== CCTP_SOL_NETWORK) return deny('unsupported', 'this bridge has no event account to reclaim');
    if (!g || typeof g.recentBlockhash !== 'string' || !Number.isInteger(g.lastValidBlockHeight) || !Number.isInteger(g.computeUnitLimit) || typeof g.computeUnitPrice !== 'string') return deny('bad_request', 'malformed transaction parameters');
    if (typeof req.message !== 'string' || typeof req.attestation !== 'string' || req.message.length > 4000 || req.attestation.length > 2000) deny('bad_request', 'malformed message');
    if (this.keys.addresses[b.fromNetwork] !== b.wallet) deny('wrong_source', 'bridge is not for this wallet');
    // the program refuses before the account is five days old; the approval is older than the account, so this only saves a wasted fee
    if (now < rec.approvedAt + CCTP_SOL_RECLAIM_WINDOW_SEC) deny('policy', 'the deposit cannot be reclaimed before five days');
    const ceiling = st.policy.maxFee[b.fromNetwork];
    if (ceiling === undefined) deny('policy', 'no fee ceiling in the policy for Solana');
    if ((rec.reclaim?.signatures ?? 0) >= 12) deny('policy', 'too many reclaim signatures for this bridge');
    let built;
    try { built = buildCctpSolReclaimMessage(b, ev, req.message, req.attestation, g, baseUnits(ceiling!)); } catch (e) { return deny('unsupported', (e as Error).message); }
    if (!req.assertion) deny('bad_approval', 'reclaiming the deposit needs the owner\'s passkey');
    try { await this.verifyAssertion(req.assertion!, new Uint8Array(sha(cctpSolReclaimBytes(id, ev, built.messageHash, g)))); } catch (e) { deny((e as SignerError).code ?? 'bad_approval', (e as Error).message); }
    const sig = ed25519.sign(built.msg, this.keys.solSeed), txid = base58.encode(sig);
    rec.reclaim = { txid, signedAt: now, signatures: (rec.reclaim?.signatures ?? 0) + 1 };
    st.log('bridge.reclaim.ok', { proposalId: id, eventAccount: ev, txid, signatures: rec.reclaim.signatures });
    st.save();
    return { raw: Buffer.from(solV1WireSigned([sig], built.msg)).toString('base64'), txid, eventAccount: ev };
  }

  /**
   * Open the wallet's own USDC token account on Solana (needed before USDC can be burned toward Solana). Passkey over the
   * canonical request; the only possible effect is that account, owned by the wallet, and its rent deposit paid by the wallet.
   */
  async signSolTokenAccount(raw: unknown, assertion?: AuthenticationResponseJSON): Promise<{ raw: string; txid: string; hash: string; tokenAccount: string }> {
    const st = this.store, now = this.now();
    const parsed = SolTokenAccountSchema.safeParse(raw);
    if (!parsed.success) throw new SignerError('bad_request', 'malformed request');
    const r = parsed.data, hash = solTokenAccountHash(r);
    const deny = (code: string, msg: string): never => { st.log('sol.token_account.denied', { requestId: r.requestId, code, msg }); st.save(); throw new SignerError(code, msg); };
    if (r.keyId !== this.keys.keyId) deny('wrong_key', 'request targets another key');
    if (r.owner !== this.keys.addresses[CCTP_SOL_NETWORK]) deny('wrong_source', 'the token account is not for this wallet');
    if (st.state.used[r.requestId] !== undefined) deny('replay', 'request already signed');
    if (st.state.halted) deny('policy', 'emergency halt is active');
    if (r.policyVersion !== st.policy.version) deny('policy', 'policy version changed');
    if (r.expiresAt <= now) deny('policy', 'approval window expired');
    if (r.createdAt > now + 60 || r.expiresAt - r.createdAt > st.policy.maxApprovalTtlSec) deny('policy', 'validity window is not acceptable');
    if (BigInt(r.maxFee) > baseUnits(st.policy.maxFee[CCTP_SOL_NETWORK] ?? '0')) deny('policy', 'fee ceiling above policy');
    let built;
    try { built = buildSolTokenAccountMessage(r); } catch (e) { return deny('unsupported', (e as Error).message); }
    if (!assertion) deny('bad_approval', 'opening the token account needs the owner\'s passkey');
    try { await this.verifyAssertion(assertion!, hash); } catch (e) { deny((e as SignerError).code ?? 'bad_approval', (e as Error).message); }
    st.state.used[r.requestId] = r.expiresAt; st.prune(now);
    const sig = ed25519.sign(built.msg, this.keys.solSeed), txid = base58.encode(sig);
    st.log('sol.token_account.ok', { requestId: r.requestId, hash: Buffer.from(hash).toString('hex'), tokenAccount: r.tokenAccount, mint: r.mint, txid });
    st.save();
    return { raw: Buffer.from(solV1WireSigned([sig], built.msg)).toString('base64'), txid, hash: Buffer.from(hash).toString('hex'), tokenAccount: r.tokenAccount };
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Native cross-chain swap (THORChain). Everything is rebuilt from the intent: the memo pays the wallet's own address on the
  // destination chain at least the approved minimum, the transaction pays the committed vault and nothing else. The vault key
  // itself cannot be proven offline, so it must be confirmed, now, by every THORNode operator this signer can reach (at least
  // three, its own list, no API in the path). Fails closed. Runs before the passkey is looked at; nothing is recorded on refusal.
  private async xswapBuild(i: Intent, net: NetworkDef, aux?: Record<string, unknown>): Promise<() => Promise<{ raw: string; txid: string; pre?: { raw: string; txid: string } }>> {
    const dest = this.keys.addresses[i.xswap!.toNetwork] ?? '';
    const plan = verifyXswap(i, dest);
    const utxo = net.family === 'btc' ? buildXswapBtcTx(i, dest, aux) : null, evm = net.family === 'evm' ? buildXswapEvmTxs(i, dest) : null;
    if (!utxo && !evm) throw new Error('THORChain swaps are not defined for this network family');
    let v;
    try { v = await this.vaults.check(plan.want); } catch (e) { throw new SignerError('vault_unconfirmed', `the vault is not confirmed by the signer's THORNode operators: ${(e as Error).message.slice(0, 200)}`); }
    return async () => {
      this.store.log('xswap.vault_confirmed', { proposalId: i.proposalId, vault: i.xswap!.vault, vaultPubKey: i.xswap!.vaultPubKey, operators: v.operators, silent: v.silent, height: v.height, churnHeight: v.statusSince });
      if (utxo) { utxo.sign(this.keys.utxoPriv(net)); utxo.finalize(); return { raw: utxo.hex, txid: utxo.id }; }
      const acct = privateKeyToAccount(`0x${Buffer.from(this.keys.evmPriv).toString('hex')}`);
      const raw = await acct.signTransaction(evm!.deposit), pre = evm!.approve ? await acct.signTransaction(evm!.approve) : null;
      return { raw, txid: keccak256(raw), ...(pre ? { pre: { raw: pre, txid: keccak256(pre) } } : {}) };
    };
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
    // venue deposits (venue-collateral.ts): pinned bridge, native USDC, floor above the venue minimum; a plain transfer to a venue bridge is refused
    const vd = venueDepositVerdict(i, own!);
    if (vd) deny('venue_deposit', vd);
    // v8 GMX: a plain transfer to a pinned GMX contract is refused (funds reach GMX only through an order built below)
    const gv = gmxPlainVerdict(i);
    if (gv) deny('gmx', gv);

    const day = new Date(now * 1000).toISOString().slice(0, 10), spendKey = `${day}|${i.network}:${i.symbol}`;
    // v8 GMX: a decrease or a cancellation moves no asset amount (amount = 0, checked by the builder): the amount limits have nothing to bound, everything else applies
    // V11 (B-01): the emergency halt never blocks a risk reduction. For a GMX decrease or cancellation the halt is therefore not
    // judged here, on the intent's own word, but below, once this signer has BUILT the transaction and seen that it can only
    // reduce (`reducesOnly`). Everything else — transfers, swaps, bridges, deposits, GMX increases — is refused under halt as before.
    const gmxExit = !!i.gmx && i.gmx.action !== 'increase';
    const verdict = gmxExit ? checkPolicyNoSpend(st.policy, i, now, false) : checkPolicy(st.policy, i, BigInt(st.state.spent[spendKey] ?? '0'), now, st.state.halted);
    if (!verdict.ok) deny('policy', verdict.reason);

    // Rebuild the chain transaction from the intent alone; any unsupported shape throws here.
    let build: () => Promise<{ raw: string; txid: string; pre?: { raw: string; txid: string }; eventAccount?: string }>;
    if (i.gmx) {
      // v8 GMX v2 order: authorization, pinned contracts, transaction built from the intent, venue policy at the signer's own prices (venue-gmx.ts)
      let ready: Awaited<ReturnType<typeof gmxPrepare>>;
      try { ready = await gmxPrepare(this.venueCtx(), i, own!); } catch (e) { return deny(e instanceof SignerError ? e.code : 'unsupported', (e as Error).message); }
      if (st.state.halted && !ready.reducesOnly) deny('policy', 'emergency halt is active: only a GMX decrease or cancellation is signed');
      build = async () => {
        const acct = privateKeyToAccount(`0x${Buffer.from(this.keys.evmPriv).toString('hex')}`);
        const raw = await acct.signTransaction(ready.main), pre = ready.approve ? await acct.signTransaction(ready.approve) : null;
        ready.commit(keccak256(raw));
        return { raw, txid: keccak256(raw), ...(pre ? { pre: { raw: pre, txid: keccak256(pre) } } : {}) };
      };
    } else if (i.xswap) {
      // native cross-chain swap: memo and transaction are rebuilt here, and the vault is confirmed by this signer's own THORNode operators
      try { build = await this.xswapBuild(i, net, aux); } catch (e) { return deny(e instanceof SignerError ? e.code : 'unsupported', (e as Error).message); }
    } else
    try {
      if (i.bridge && net.family === 'sol') {
        // v8 — USDC burned on Solana for the wallet's own EVM address. Nothing comes from outside: the single instruction
        // (deposit_for_burn) and all its accounts are derived here. The program needs a second signer, the account that will
        // hold the message: its keypair is generated HERE, signs this one transaction and is dropped — the program never asks
        // for it again (the rent is reclaimed later with the wallet's signature alone). Its public key is recorded.
        if (aux && Object.keys(aux).length > 0) throw new Error('a bridge takes no helper data: the signer builds the transaction itself');
        buildCctpSolBurnMessage(i, EVENT_ACCOUNT_PROBE); // every check of the intent, before the approval is looked at
        if (this.keys.addresses[i.bridge.toNetwork] !== i.bridge.recipient) throw new Error('the recipient is not this wallet\'s own address on the destination network');
        if (st.policy.maxFee[i.bridge.toNetwork] === undefined) throw new Error('no fee ceiling in the policy for the destination network');
        if (st.state.bridges?.[i.proposalId]) throw new Error('bridge already recorded');
        build = async () => {
          const eventKey = ed25519.utils.randomSecretKey();
          try {
            const eventAccount = base58.encode(ed25519.getPublicKey(eventKey));
            const msg = buildCctpSolBurnMessage(i, eventAccount);
            const sig = ed25519.sign(msg, this.keys.solSeed), txid = base58.encode(sig);
            (st.state.bridges ??= {})[i.proposalId] = { bridge: bridgeOf(i), approvedAt: now, burnTxid: txid, sol: { eventAccount } };
            return { raw: Buffer.from(solV1WireSigned([sig, ed25519.sign(msg, eventKey)], msg)).toString('base64'), txid, eventAccount };
          } finally { eventKey.fill(0); }
        };
      } else if (i.bridge) {
        // nothing provider-built: approval and burn are rebuilt from the intent and the pinned tables
        if (i.swap) throw new Error('an intent is a swap or a bridge, not both');
        const txs = buildCctpBurnTxs(i);
        // v8: toward Solana the intent names the wallet's Solana address (the mint recipient is its USDC token account); between EVM networks it is `own`, as before
        if (this.keys.addresses[i.bridge.toNetwork] !== (i.bridge.recipient ?? own)) throw new Error('the destination network is not served by the same wallet address');
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
      ...(i.xswap ? { xswap: i.xswap.provider, toNetwork: i.xswap.toNetwork, toAsset: i.xswap.toAsset, minOut: i.xswap.minOut, vault: i.xswap.vault, vaultPubKey: i.xswap.vaultPubKey, memo: i.xswap.memo } : {}),
      ...(i.bridge ? { bridge: i.bridge.provider, toNetwork: i.bridge.toNetwork, cctpMaxFee: i.bridge.maxFee, minFinalityThreshold: i.bridge.minFinalityThreshold, ...(i.bridge.recipient !== undefined ? { recipient: i.bridge.recipient } : {}), ...(out.eventAccount ? { eventAccount: out.eventAccount } : {}) } : {}),
      ...(i.venueDeposit ? { venueDeposit: i.venueDeposit.venue, venueNetwork: i.venueDeposit.venueNetwork, route: i.venueDeposit.route } : {}),
      ...(i.gmx ? { gmx: i.gmx.action, market: i.gmx.market, sizeDeltaUsd: i.gmx.sizeDeltaUsd, isLong: i.gmx.isLong } : {}) });
    st.save();
    return { ...out, hash: Buffer.from(hash).toString('hex') };
  }
}

export interface BridgeMintRequest { proposalId: string; message: string; attestation: string; /** EVM destination */ evm?: CctpMintGas; /** v8: Solana destination */ sol?: SolBudget; assertion?: AuthenticationResponseJSON }
export interface BridgeReclaimRequest { proposalId: string; message: string; attestation: string; sol: SolBudget; assertion?: AuthenticationResponseJSON }
/** any valid public key that is not the wallet: lets the intent be checked in full before the one-time event key exists */
const EVENT_ACCOUNT_PROBE = 'SysvarC1ock11111111111111111111111111111111';
export interface BridgeMintResult { raw: string; txid: string; messageHash: string; minted: string; replayed: boolean }

export function enrollChallenge(credId: string, publicKey: string): Uint8Array {
  return new Uint8Array(sha(`SPW-ENROLL-v1\n${credId}\n${publicKey}`));
}
