// The signer and a Jupiter swap on Solana: recorded mainnet transactions re-addressed to the test key. No network.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { compileSolV1Message, decodeSolV1Message, intentHash, JUPITER_PROGRAM, solMessageHash, verifyAuditChain, type Intent } from '@spw/core';
import { ixInputs, jupFixture, readdress, solAta } from '../../../tests/helpers/jupiter-fixtures.ts';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../src/keys.ts';
import { Signer, SignerError } from '../src/signer.ts';
import { Store } from '../src/store.ts';

const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'); // public test vector, holds nothing
const ME = keys.addresses.solana!, RP = 'wallet.test', ORIGIN = 'https://wallet.test';
function setup(now: number) {
  const dir = mkdtempSync(join(tmpdir(), 'spw-signer-jup-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('t').digest('hex');
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => now), pk = new TestPasskey(RP, ORIGIN);
  return { store, signer, pk, ready: signer.enroll({ credential: pk.credential(), setupToken: 't' }) };
}
let seq = 0;
const fresh = (name: string, o: Partial<Intent> = {}) => { const f = jupFixture(name); return { f, ...readdress(f, ME, keys.keyId, { proposalId: `7a1c1f0e-8f5f-4b1e-9c56-${String(++seq).padStart(12, '0')}`, ...o }) }; };
const code = async (p: Promise<unknown>) => p.then(() => 'signed', (e: SignerError) => `${e.code}: ${e.message}`);

describe('signing a Jupiter swap', () => {
  it.each(['usdc-bonk', 'usdc-sol', 'sol-usdc', 'usdc-pyusd', 'usdc-jup'])('%s: decodes, checks and signs the exact approved bytes with the wallet key', async (name) => {
    const { intent, message, msg } = fresh(name), s = setup(intent.createdAt + 5); await s.ready;
    const r = await s.signer.sign(intent, s.pk.assert(intentHash(intent)), { swapMessage: message });
    const wire = Buffer.from(r.raw, 'base64'), sig = wire.subarray(wire.length - 64);
    expect(wire.subarray(0, wire.length - 64).equals(Buffer.from(msg))).toBe(true); // v1 wire format: message, then the signature
    expect(ed25519.verify(sig, msg, base58.decode(ME))).toBe(true);
    expect(r.txid).toBe(base58.encode(sig)); expect(r.hash).toBe(Buffer.from(intentHash(intent)).toString('hex')); expect(r.pre).toBeUndefined();
    const last = s.store.state.journal.at(-1)!;
    expect(last.type).toBe('sign.ok'); expect(last.data).toMatchObject({ swap: 'jupiter', toAsset: intent.swap!.toAsset, minOut: intent.swap!.minOut, amount: intent.amount, network: 'solana' });
    expect(verifyAuditChain(s.store.state.journal)).toBeNull(); // no broken link
    // counted against the daily limit like a send, and never signed twice
    expect(s.store.state.spent[`${new Date((intent.createdAt + 5) * 1000).toISOString().slice(0, 10)}|solana:${intent.symbol}`]).toBe(intent.amount);
    expect(await code(s.signer.sign(intent, s.pk.assert(intentHash(intent)), { swapMessage: message }))).toMatch(/^replay/);
  });

  it('refuses without the message, with another message, and with a message for another wallet', async () => {
    const { intent, message, f } = fresh('usdc-bonk'), s = setup(intent.createdAt + 5); await s.ready;
    const ok = () => s.pk.assert(intentHash(intent));
    expect(await code(s.signer.sign(intent, ok()))).toMatch(/^unsupported: swap message is not base64/);
    expect(await code(s.signer.sign(intent, ok(), { swapMessage: fresh('usdc-jup').message }))).toMatch(/^unsupported: message does not match the approved hash/);
    expect(await code(s.signer.sign(intent, ok(), { swapData: message }))).toMatch(/^unsupported: swap message is not base64/); // the EVM helper name is not read
    // the recorded transaction itself (for the public address it was built for): its payer is not this signer's wallet
    const foreign = { ...f.intent, keyId: keys.keyId, proposalId: intent.proposalId };
    expect(await code(s.signer.sign(foreign, s.pk.assert(intentHash(foreign)), { swapMessage: f.message }))).toMatch(/^wrong_source/);
    const mine = { ...foreign, from: ME, to: ME }; // intent claims the wallet, message still pays from the other address
    expect(await code(s.signer.sign(mine, s.pk.assert(intentHash(mine)), { swapMessage: f.message }))).toMatch(/^unsupported: fee payer is not the wallet/);
    expect(await code(s.signer.sign({ ...intent, to: f.wallet }, ok(), { swapMessage: message }))).toMatch(/^self_send: a swap must deliver to the wallet itself/);
    expect(s.store.state.journal.filter((j) => j.type === 'sign.ok')).toHaveLength(0);
    expect(await code(s.signer.sign(intent, ok(), { swapMessage: message }))).toBe('signed'); // none of the refusals burned the proposal
  });

  it('a malicious API cannot get a mutated transaction signed, whatever intent it presents', async () => {
    const { intent, msg } = fresh('usdc-bonk'), s = setup(intent.createdAt + 5); await s.ready;
    const m = decodeSolV1Message(msg), third = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
    const tries: [string, (x: ReturnType<typeof ixInputs>, k: number) => void, RegExp][] = [
      ['destination', (x, k) => { x[k]!.accounts[5]!.pubkey = solAta(third, 'BONK'); }, /destination token account is not the wallet's own/],
      ['minimum', (x, k) => { const d = Buffer.from(x[k]!.data); d.writeUInt16LE(900, 25); x[k]!.data = new Uint8Array(d); }, /less than the approved minimum/],
      ['fee', (x, k) => { const d = Buffer.from(x[k]!.data); d.writeUInt16LE(100, 27); x[k]!.data = new Uint8Array(d); }, /platform fee/],
      ['transfer', (x) => { x.push({ program: '11111111111111111111111111111111', accounts: [{ pubkey: ME, signer: true, writable: true }, { pubkey: third, signer: false, writable: true }], data: new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) }); }, /unexpected program/],
      ['wallet in the route', (x, k) => { x[k]!.accounts.push({ pubkey: ME, signer: true, writable: false }); }, /reaches into the wallet's accounts/],
    ];
    for (const [, mut, why] of tries) {
      const x = ixInputs(m), k = x.findIndex((q) => q.program === JUPITER_PROGRAM); mut(x, k);
      const bad = compileSolV1Message({ payer: ME, blockhash: m.blockhash, instructions: x, computeUnitLimit: m.computeUnitLimit, priorityFeeLamports: m.priorityFeeLamports, loadedAccountsDataSizeLimit: m.loadedAccountsDataSizeLimit });
      const i2: Intent = { ...intent, proposalId: `7a1c1f0e-8f5f-4b1e-9c56-${String(++seq).padStart(12, '0')}`, swap: { ...intent.swap!, dataHash: solMessageHash(bad) } };
      expect(await code(s.signer.sign(i2, s.pk.assert(intentHash(i2)), { swapMessage: Buffer.from(bad).toString('base64') }))).toMatch(why);
    }
    expect(s.store.state.journal.filter((j) => j.type === 'sign.denied')).toHaveLength(tries.length);
    expect(Object.keys(s.store.state.spent)).toHaveLength(0);
  });

  it('policy, approval and halt apply as for a send', async () => {
    const { intent, message } = fresh('usdc-bonk'), s = setup(intent.createdAt + 5); await s.ready;
    const sign = (i: Intent, a = s.pk.assert(intentHash(i))) => code(s.signer.sign(i, a, { swapMessage: message }));
    expect(await sign({ ...intent, amount: '60000000' })).toMatch(/^policy: amount above per-transaction limit for solana:USDC/);
    expect(await sign({ ...intent, maxFee: '3000001' })).toMatch(/^policy: fee ceiling above policy/);
    expect(await sign({ ...intent, expiresAt: intent.createdAt + 1 })).toMatch(/^policy: approval window expired/);
    expect(await sign({ ...intent, policyVersion: 1 })).toMatch(/^policy: policy version changed/);
    expect(await sign({ ...intent, keyId: 'spw-0000000000000000' })).toMatch(/^wrong_key/);
    expect(() => intentHash({ ...intent, network: 'base', chainRef: '8453' })).toThrow(/does not match network/); // a Jupiter intent cannot even be hashed for an EVM network
    const other: Intent = { ...intent, swap: { ...intent.swap!, minOut: '1' } };
    expect(await sign(intent, s.pk.assert(intentHash(other)))).toMatch(/^bad_approval/); // the passkey approved other terms
    expect(await sign(intent, new TestPasskey(RP, ORIGIN).assert(intentHash(intent)))).toMatch(/^unknown_credential/);
    s.store.state.spent[`${new Date((intent.createdAt + 5) * 1000).toISOString().slice(0, 10)}|solana:USDC`] = '80000000';
    expect(await sign(intent)).toMatch(/^policy: daily limit exceeded/);
    s.store.state.spent = {};
    s.signer.halt();
    expect(await sign(intent)).toMatch(/^policy: emergency halt is active/);
  });

  it('an agent mandate cannot sign a Solana swap', async () => {
    const { intent, message } = fresh('usdc-bonk'), s = setup(intent.createdAt + 5); await s.ready;
    await expect(s.signer.signDelegated('no-such-mandate', intent, { swapMessage: message })).rejects.toThrow(/unknown mandate/);
  });
});
