import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { base58 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { PublicKey } from '@near-js/crypto';
import { decodeSignedTransaction, encodeTransaction } from '@near-js/transactions';
import { intentHash, NETWORKS, verifyAuditChain, type Intent } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../src/keys.ts';
import { Signer } from '../src/signer.ts';
import { Store } from '../src/store.ts';

// Public BIP-39 test vector mnemonic: known to everyone, used for vectors only; nothing signed here ever leaves the test.
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const keys = deriveKeys(MNEMONIC);
const { parseSeedPhrase } = createRequire(import.meta.url)('near-seed-phrase') as { parseSeedPhrase: (phrase: string, path?: string) => { publicKey: string } };
const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const IMPLICIT = Buffer.from(PublicKey.fromString(parseSeedPhrase(MNEMONIC, "m/44'/397'/1'").publicKey).data).toString('hex');
const BLOCK = 'bRJrdMWsAoEJdNrSK1KXJFHwGC16Rtth9NhP6ZomSBh';

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'spw-signer-near-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('setup-token').digest('hex');
  const t = Math.floor(Date.now() / 1000);
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => t);
  const pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 'setup-token' });
  return { store, signer, pk, t };
}
let n = 0;
const near = (t: number, over: Partial<Intent> = {}): Intent => ({
  v: 1, proposalId: `6f1c1f0e-8f5f-4b1e-9c56-${String(++n).padStart(12, '0')}`, keyId: keys.keyId, createdAt: t, expiresAt: t + 120, policyVersion: 3,
  network: 'near', chainRef: NETWORKS.near.chainRef, asset: 'native', symbol: 'NEAR', decimals: 24, amount: '2500000000000000000000007', from: keys.addresses.near!, to: 'alice.near',
  maxFee: '2000000000000000000000', x: { nonce: '223991684000002', blockHash: BLOCK }, ...over,
});

describe('near through the signer', () => {
  it("derives the account NEAR wallets derive from the mnemonic (m/44'/397'/0', implicit account)", () => {
    expect(keys.addresses.near).toBe('5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412');
    expect(keys.addresses.near).toBe(Buffer.from(PublicKey.fromString(parseSeedPhrase(MNEMONIC).publicKey).data).toString('hex'));
  });

  it('signs an approved NEAR transfer; the official SDK decodes it and verifies the signature', async () => {
    const { signer, pk, t, store } = await setup();
    const i = near(t);
    const r = await signer.sign(i, pk.assert(intentHash(i)));
    const d = decodeSignedTransaction(Buffer.from(r.raw, 'base64')) as any; // borsh-deserialized plain fields
    const tx = d.transaction, hash = sha256(encodeTransaction(tx));
    expect(r.txid).toBe(base58.encode(hash));
    expect([tx.signerId, tx.receiverId, tx.nonce, base58.encode(Uint8Array.from(tx.blockHash))]).toEqual([i.from, 'alice.near', 223991684000002n, BLOCK]);
    expect(tx.actions).toHaveLength(1);
    expect(Object.keys(tx.actions[0])).toEqual(['transfer']);
    expect(tx.actions[0].transfer.deposit).toBe(2500000000000000000000007n); // 24 decimals, exact
    expect(Buffer.from(Uint8Array.from(tx.publicKey.ed25519Key.data)).toString('hex')).toBe(i.from);
    expect(PublicKey.fromString(parseSeedPhrase(MNEMONIC).publicKey).verify(hash, Uint8Array.from(d.signature.ed25519Signature.data))).toBe(true);
    expect(verifyAuditChain(store.state.journal)).toBeNull();
    await expect(signer.sign(i, pk.assert(intentHash(i)))).rejects.toThrow(/already signed/);
  });

  it('signs a transfer to an implicit account only with the higher approved fee ceiling; an approval cannot be reused for other bytes', async () => {
    const { signer, pk, t } = await setup();
    const i = near(t, { to: IMPLICIT, maxFee: '20000000000000000000000' });
    const r = await signer.sign(i, pk.assert(intentHash(i)));
    expect((decodeSignedTransaction(Buffer.from(r.raw, 'base64')) as any).transaction.receiverId).toBe(IMPLICIT);
    const a = near(t), swapped = { ...a, x: { ...a.x!, nonce: '223991684000003' } };
    await expect(signer.sign(swapped, pk.assert(intentHash(a)))).rejects.toThrow(/approval/);
    const b = near(t), other = { ...b, to: 'mallory.near' };
    await expect(signer.sign(other, pk.assert(intentHash(b)))).rejects.toThrow(/approval/);
  });

  it('refuses unsupported or out-of-policy NEAR intents before looking at the approval', async () => {
    const { signer, pk, t } = await setup();
    const cases: [Partial<Intent>, RegExp][] = [
      [{ chainRef: 'FWJ9kR6KFWoyMoNjpLXXGHeuiy7tEY6GmoFeCA5yuc6b' }, /chain identity/], // testnet genesis
      [{ from: IMPLICIT }, /not controlled/],
      [{ to: keys.addresses.near!, maxFee: '20000000000000000000000' }, /equals source/],
      [{ to: 'Alice.near' }, /upper-case/],
      [{ to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' }, /not supported/],
      [{ asset: 'usdt.tether-token.near' }, /native/],
      [{ to: IMPLICIT }, /fee above approved maximum/], // an implicit destination needs the higher ceiling
      [{ maxFee: '1999999999999999999999' }, /fee above approved maximum/],
      [{ x: { ...near(t).x!, extra: '1' } }, /unknown or missing/],
      [{ x: { nonce: '0', blockHash: BLOCK } }, /canonical/],
      [{ x: { nonce: '5', blockHash: 'ab'.repeat(32) } }, /invalid NEAR hash/],
      [{ memo: 'x' }, /memo/],
      [{ amount: '14000000000000000000000001' }, /per-transaction limit/], // default cap: 14 NEAR
      [{ to: IMPLICIT, maxFee: '20000000000000000000001' }, /fee ceiling/],
    ];
    for (const [over, re] of cases) { const i = near(t, over); await expect(signer.sign(i, pk.assert(intentHash(i))), JSON.stringify(over)).rejects.toThrow(re); }
  });
});
