import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Keypair, Networks, TransactionBuilder, type Transaction } from '@stellar/stellar-base';
import { intentHash, NETWORKS, verifyAuditChain, type Intent } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../src/keys.ts';
import { Signer } from '../src/signer.ts';
import { Store } from '../src/store.ts';

// Public BIP-39 test vector mnemonic — holds no funds, never used outside tests.
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const DEST = 'GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV'; // SEP-0005 test 5, account 1

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'spw-signer-xlm-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('setup-token').digest('hex');
  const t = Math.floor(Date.now() / 1000);
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => t);
  const pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 'setup-token' });
  return { store, signer, pk, t };
}
let n = 0;
const xlm = (t: number, over: Partial<Intent> = {}): Intent => ({
  v: 1, proposalId: `6f1c1f0e-8f5f-4b1e-9c56-${String(++n).padStart(12, '0')}`, keyId: keys.keyId, createdAt: t, expiresAt: t + 120, policyVersion: 2,
  network: 'stellar', chainRef: NETWORKS.stellar.chainRef, asset: 'native', symbol: 'XLM', decimals: 7, amount: '25000000', from: keys.addresses.stellar!, to: DEST, maxFee: '10112',
  memo: '4242', x: { op: 'payment', sequence: '2390162185806736', fee: '10112', maxTime: String(t + 180), memoType: 'id' }, ...over,
});

describe('stellar through the signer', () => {
  it('derives the SEP-0005 account from the mnemonic (m/44\'/148\'/0\')', () => {
    expect(keys.addresses.stellar).toBe('GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX');
  });

  it('signs an approved XLM payment; the official SDK decodes it and verifies the signature', async () => {
    const { signer, pk, t, store } = await setup();
    const i = xlm(t);
    const r = await signer.sign(i, pk.assert(intentHash(i)));
    const tx = TransactionBuilder.fromXDR(r.raw, Networks.PUBLIC) as Transaction;
    expect(tx.hash().toString('hex')).toBe(r.txid);
    expect([tx.source, tx.fee, tx.sequence, tx.timeBounds?.maxTime, tx.memo.type, tx.memo.value]).toEqual([i.from, '10112', i.x!.sequence, String(t + 180), 'id', '4242']);
    expect(tx.operations).toHaveLength(1);
    const op = tx.operations[0]!;
    expect(op.type === 'payment' && op.destination === DEST && op.asset.isNative() && op.amount === '2.5000000').toBe(true);
    expect(tx.signatures).toHaveLength(1);
    expect(Keypair.fromPublicKey(keys.addresses.stellar!).verify(tx.hash(), tx.signatures[0]!.signature())).toBe(true);
    expect(verifyAuditChain(store.state.journal)).toBeNull();
    await expect(signer.sign(i, pk.assert(intentHash(i)))).rejects.toThrow(/already signed/);
  });

  it('signs a CreateAccount only when the approved intent says so', async () => {
    const { signer, pk, t } = await setup();
    const { memo: _m, ...rest } = xlm(t);
    const i: Intent = { ...rest, x: { ...rest.x!, op: 'createAccount', memoType: 'none' } };
    const r = await signer.sign(i, pk.assert(intentHash(i)));
    const op = (TransactionBuilder.fromXDR(r.raw, Networks.PUBLIC) as Transaction).operations[0]!;
    expect(op.type === 'createAccount' && op.destination === DEST && op.startingBalance === '2.5000000').toBe(true);
    // an approval given for a payment cannot be reused for the other operation
    const pay = xlm(t), swapped = { ...pay, x: { ...pay.x!, op: 'createAccount' } };
    await expect(signer.sign(swapped, pk.assert(intentHash(pay)))).rejects.toThrow(/approval/);
  });

  it('refuses unsupported or out-of-policy Stellar intents before looking at the approval', async () => {
    const { signer, pk, t } = await setup();
    const cases: [Partial<Intent>, RegExp][] = [
      [{ chainRef: 'Test SDF Network ; September 2015' }, /chain identity/],
      [{ from: DEST }, /not controlled/],
      [{ to: keys.addresses.stellar! }, /equals source/],
      [{ to: DEST.toLowerCase() }, /Stellar address/],
      [{ asset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' }, /native/],
      [{ x: { ...xlm(t).x!, fee: '10113' } }, /above approved maximum/],
      [{ x: { ...xlm(t).x!, memoType: 'text' } }, /memoType/],
      [{ x: { ...xlm(t).x!, extra: '1' } }, /unknown or missing/],
      [{ x: { ...xlm(t).x!, maxTime: String(t + 3600) } }, /too far/],
      [{ amount: '3500000001' }, /per-transaction limit/], // default cap: 350 XLM
      [{ maxFee: '1000001', x: { ...xlm(t).x!, fee: '1000001' } }, /fee ceiling/],
    ];
    for (const [over, re] of cases) { const i = xlm(t, over); await expect(signer.sign(i, pk.assert(intentHash(i))), JSON.stringify(over)).rejects.toThrow(re); }
  });
});
