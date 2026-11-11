import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Address, beginCell, Cell, comment, loadMessage, loadMessageRelaxed } from '@ton/core';
import { signVerify } from '@ton/crypto';
import { WalletContractV4 } from '@ton/ton';
import { intentHash, NETWORKS, verifyAuditChain, type Intent } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../src/keys.ts';
import { Signer } from '../src/signer.ts';
import { Store } from '../src/store.ts';

// Public BIP-39 test vector mnemonic — holds no funds, never used outside tests.
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const PUB = Buffer.from(keys.handle(NETWORKS.ton).publicKey);
const wallet = WalletContractV4.create({ workchain: 0, publicKey: PUB });
const DEST = 'UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI'; // TON Foundation wallet, canonical (non-bounceable) form

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'spw-signer-ton-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('setup-token').digest('hex');
  const t = Math.floor(Date.now() / 1000);
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => t);
  const pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 'setup-token' });
  return { store, signer, pk, t };
}
let n = 0;
const ton = (t: number, over: Partial<Intent> = {}): Intent => ({
  v: 1, proposalId: `6f1c1f0e-8f5f-4b1e-9c56-${String(++n).padStart(12, '0')}`, keyId: keys.keyId, createdAt: t, expiresAt: t + 120, policyVersion: 3,
  network: 'ton', chainRef: NETWORKS.ton.chainRef, asset: 'native', symbol: 'TON', decimals: 9, amount: '2500000000', from: keys.addresses.ton!, to: DEST, maxFee: '5000000',
  memo: 'order 4242', x: { seqno: '12', validUntil: String(t + 300), bounce: '1', sendMode: '3', stateInit: '0' }, ...over,
});
/** decode a signed external message with the official SDK */
function decode(raw: string) {
  const msg = loadMessage(Cell.fromBase64(raw).beginParse());
  if (msg.info.type !== 'external-in') throw new Error('not external-in');
  const s = msg.body.beginParse();
  const signature = s.loadBuffer(64), signingHash = beginCell().storeSlice(s).endCell().hash();
  const head = { subwallet: s.loadUint(32), validUntil: s.loadUint(32), seqno: s.loadUint(32), op: s.loadUint(8), mode: s.loadUint(8), refs: s.remainingRefs };
  const out = loadMessageRelaxed(s.loadRef().beginParse());
  if (out.info.type !== 'internal') throw new Error('not internal');
  return { dest: msg.info.dest, init: msg.init ?? null, signature, signingHash, head, out: out.info, body: out.body };
}

describe('ton through the signer', () => {
  it('derives the v4R2 wallet of the mnemonic at m/44\'/607\'/0\' (same address as the official SDK)', () => {
    expect(keys.addresses.ton).toBe('UQAzWZa6nM5mJev91wGc7VCSfBoIsYRqKJpV78N8Add9-RKY');
    expect(keys.addresses.ton).toBe(wallet.address.toString({ bounceable: false }));
  });

  it('signs an approved transfer; the official SDK decodes it and the signature verifies', async () => {
    const { signer, pk, t, store } = await setup();
    const i = ton(t);
    const r = await signer.sign(i, pk.assert(intentHash(i)));
    const d = decode(r.raw);
    expect(d.dest.equals(wallet.address)).toBe(true);
    expect(d.init).toBeNull();
    expect(d.head).toEqual({ subwallet: 698983191, validUntil: t + 300, seqno: 12, op: 0, mode: 3, refs: 1 });
    expect([d.out.dest.equals(Address.parse(DEST)), d.out.value.coins, d.out.bounce]).toEqual([true, 2_500_000_000n, true]);
    expect(d.body.equals(comment('order 4242'))).toBe(true);
    expect(signVerify(d.signingHash, d.signature, PUB)).toBe(true);
    expect(r.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyAuditChain(store.state.journal)).toBeNull();
    await expect(signer.sign(i, pk.assert(intentHash(i)))).rejects.toThrow(/already signed/);
  });

  it('attaches the wallet StateInit only when the approved intent says so, and the bounce flag is part of the approval', async () => {
    const { signer, pk, t } = await setup();
    const { memo: _m, ...rest } = ton(t);
    const first: Intent = { ...rest, x: { ...rest.x!, seqno: '0', stateInit: '1', bounce: '0' } };
    const d = decode((await signer.sign(first, pk.assert(intentHash(first)))).raw);
    expect(d.init!.code!.equals(wallet.init.code) && d.init!.data!.equals(wallet.init.data)).toBe(true);
    expect([d.head.seqno, d.out.bounce, d.body.equals(Cell.EMPTY)]).toEqual([0, false, true]);
    // an approval given for a bounceable transfer cannot be reused for a non-bounceable one, nor for another seqno
    const a = ton(t);
    await expect(signer.sign({ ...a, x: { ...a.x!, bounce: '0' } }, pk.assert(intentHash(a)))).rejects.toThrow(/approval/);
    await expect(signer.sign({ ...a, x: { ...a.x!, seqno: '13' } }, pk.assert(intentHash(a)))).rejects.toThrow(/approval/);
  });

  it('refuses unsupported or out-of-policy TON intents before looking at the approval', async () => {
    const { signer, pk, t } = await setup();
    const cases: [Partial<Intent>, RegExp][] = [
      [{ chainRef: '823f81f306ff02694f935cf5021548e3ce2b86b529812af6a12148879e95a128' }, /chain identity/], // testnet zero state
      [{ from: DEST }, /not controlled/],
      [{ to: keys.addresses.ton! }, /equals source/],
      [{ to: Address.parse(DEST).toString({ bounceable: true }) }, /canonical/],
      [{ to: Address.parse(DEST).toString({ bounceable: false, testOnly: true }) }, /testnet/],
      [{ asset: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs' }, /native/], // USDT jetton master
      [{ x: { ...ton(t).x!, sendMode: '128' } }, /sendMode/],
      [{ x: { ...ton(t).x!, stateInit: '1' } }, /first message/],
      [{ x: { ...ton(t).x!, extra: '1' } }, /unknown or missing/],
      [{ x: { ...ton(t).x!, validUntil: String(t + 3600) } }, /too far/],
      [{ amount: '45000000001' }, /per-transaction limit/], // default cap: 45 TON
      [{ maxFee: '50000001' }, /fee ceiling/],
    ];
    for (const [over, re] of cases) { const i = ton(t, over); await expect(signer.sign(i, pk.assert(intentHash(i))), JSON.stringify(over)).rejects.toThrow(re); }
  });
});
