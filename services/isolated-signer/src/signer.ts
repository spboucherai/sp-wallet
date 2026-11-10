import { createHash, timingSafeEqual } from 'node:crypto';
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  baseUnits, buildBtcTx, buildEvmTx, buildSolMessage, checkPolicy, getNetwork, IntentSchema, intentHash, pluginFor,
  solWireTransaction, toB64u, type Intent,
} from '@spw/core';
import type { Keys } from './keys.ts';
import type { Store, StoredCredential } from './store.ts';

export class SignerError extends Error { constructor(public code: string, msg: string) { super(msg); } }
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest();
export interface SignerConfig { rpId: string; origin: string }
export interface SignResult { raw: string; txid: string; hash: string }

export class Signer {
  constructor(private keys: Keys, private store: Store, private cfg: SignerConfig, private now: () => number = () => Math.floor(Date.now() / 1000)) {}

  status() {
    const s = this.store.state, today = new Date(this.now() * 1000).toISOString().slice(0, 10);
    return {
      keyId: this.keys.keyId, addresses: this.keys.addresses, halted: s.halted,
      enrollmentOpen: s.credentials.length === 0 && s.setupTokenHash !== null,
      credentials: s.credentials.map((c) => ({ id: c.id, addedAt: c.addedAt })),
      policy: this.store.policy,
      spentToday: Object.fromEntries(Object.entries(s.spent).filter(([k]) => k.startsWith(today)).map(([k, v]) => [k.slice(11), v])),
      journalHead: s.journal[s.journal.length - 1]?.hash ?? null, journalLength: s.journal.length,
    };
  }

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
    if (i.to === own) deny('self_send', 'destination equals source');
    if (st.state.used[i.proposalId] !== undefined) deny('replay', 'proposal already signed');

    const day = new Date(now * 1000).toISOString().slice(0, 10), spendKey = `${day}|${i.network}:${i.symbol}`;
    const verdict = checkPolicy(st.policy, i, BigInt(st.state.spent[spendKey] ?? '0'), now, st.state.halted);
    if (!verdict.ok) deny('policy', verdict.reason);

    // Rebuild the chain transaction from the intent alone; any unsupported shape throws here.
    let build: () => Promise<{ raw: string; txid: string }>;
    try {
      if (net.family === 'evm') {
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
    st.log('sign.ok', { proposalId: i.proposalId, hash: Buffer.from(hash).toString('hex'), network: i.network, symbol: i.symbol, amount: i.amount, to: i.to, txid: out.txid });
    st.save();
    return { ...out, hash: Buffer.from(hash).toString('hex') };
  }
}

export function enrollChallenge(credId: string, publicKey: string): Uint8Array {
  return new Uint8Array(sha(`SPW-ENROLL-v1\n${credId}\n${publicKey}`));
}
