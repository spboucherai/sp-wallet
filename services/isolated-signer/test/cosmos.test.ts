// Cosmos Hub through the real Signer: passkey approval bound to the intent, plugin build + sign with the signer's key handle.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { decodePubkey, decodeTxRaw, DirectSecp256k1HdWallet, makeAuthInfoBytes, makeSignBytes, makeSignDoc, Registry } from '@cosmjs/proto-signing';
import { defaultRegistryTypes } from '@cosmjs/stargate';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { intentHash, NETWORKS, type Intent } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../src/keys.ts';
import { Signer } from '../src/signer.ts';
import { Store } from '../src/store.ts';

// Public BIP-39 test vector mnemonic — never used outside tests.
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const keys = deriveKeys(TEST_MNEMONIC);
const DEST = 'cosmos1wnacchusmacys78rxcr640gjpz000f87gnz6zf';
const X = { account_number: '1425847', sequence: '7', gas_limit: '200000', fee_amount: '1500', timeout_height: '33821256' };
const sdkWallet = await DirectSecp256k1HdWallet.fromMnemonic(TEST_MNEMONIC, { prefix: 'cosmos' });
const [sdkAccount] = await sdkWallet.getAccounts();
const registry = new Registry(defaultRegistryTypes);

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'spw-signer-cosmos-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('setup-token').digest('hex');
  const t = Math.floor(Date.now() / 1000);
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => t);
  const pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 'setup-token' });
  return { signer, pk, t };
}
let seq = 0;
const intent = (t: number, over: Partial<Intent> = {}): Intent => ({ v: 1, proposalId: `7a1c1f0e-8f5f-4b1e-9c56-${String(++seq).padStart(12, '0')}`, keyId: keys.keyId, createdAt: t, expiresAt: t + 90,
  policyVersion: 4, network: 'cosmos', chainRef: NETWORKS.cosmos.chainRef, asset: 'native', symbol: 'ATOM', decimals: 6, amount: '3000000', from: keys.addresses.cosmos!, to: DEST, maxFee: '1500',
  memo: '104588310', x: X, ...over });

describe('Cosmos Hub through the signer', () => {
  it("derives the published m/44'/118'/0'/0/0 address of the test mnemonic", () => {
    expect(keys.addresses.cosmos).toBe('cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4');
    expect(keys.addresses.cosmos).toBe(sdkAccount!.address);
  });

  it('signs an approved ATOM transfer that the official SDK decodes, reproduces byte for byte, and whose signature verifies', async () => {
    const { signer, pk, t } = await setup();
    const i = intent(t);
    const r = await signer.sign(i, pk.assert(intentHash(i)));
    const d = decodeTxRaw(Uint8Array.from(Buffer.from(r.raw, 'base64')));
    expect(d.body.messages.length).toBe(1);
    expect(d.body.messages[0]!.typeUrl).toBe('/cosmos.bank.v1beta1.MsgSend');
    expect(registry.decode(d.body.messages[0]!)).toEqual({ fromAddress: keys.addresses.cosmos, toAddress: DEST, amount: [{ denom: 'uatom', amount: '3000000' }] });
    expect(d.body).toMatchObject({ memo: '104588310', timeoutHeight: 33821256n, extensionOptions: [], nonCriticalExtensionOptions: [] });
    expect(d.authInfo.fee).toMatchObject({ amount: [{ denom: 'uatom', amount: '1500' }], gasLimit: 200000n, payer: '', granter: '' });
    expect(d.authInfo.signerInfos.length).toBe(1);
    expect(d.authInfo.signerInfos[0]!.sequence).toBe(7n);
    expect(decodePubkey(d.authInfo.signerInfos[0]!.publicKey!)).toEqual({ type: 'tendermint/PubKeySecp256k1', value: Buffer.from(sdkAccount!.pubkey).toString('base64') });

    // the same transfer built and signed by cosmjs
    const bodyBytes = registry.encodeTxBody({ messages: [{ typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: { fromAddress: i.from, toAddress: DEST, amount: [{ denom: 'uatom', amount: '3000000' }] } }],
      memo: '104588310', timeoutHeight: 33821256n });
    const authInfoBytes = makeAuthInfoBytes([{ pubkey: d.authInfo.signerInfos[0]!.publicKey!, sequence: 7 }], [{ denom: 'uatom', amount: '1500' }], 200000, undefined, undefined);
    const signDoc = makeSignDoc(bodyBytes, authInfoBytes, 'cosmoshub-4', 1425847);
    const { signature } = await sdkWallet.signDirect(i.from, signDoc);
    const sdkRaw = TxRaw.encode({ bodyBytes, authInfoBytes, signatures: [Uint8Array.from(Buffer.from(signature.signature, 'base64'))] }).finish();
    expect(r.raw).toBe(Buffer.from(sdkRaw).toString('base64'));
    expect(r.txid).toBe(createHash('sha256').update(sdkRaw).digest('hex').toUpperCase());
    expect(secp256k1.verify(d.signatures[0]!, createHash('sha256').update(makeSignBytes(signDoc)).digest(), sdkAccount!.pubkey, { prehash: false, lowS: true })).toBe(true);
  });

  it('refuses everything else', async () => {
    const { signer, pk, t } = await setup();
    const tryIt = (i: Intent) => signer.sign(i, pk.assert(intentHash(i)));
    const good = intent(t);
    const approval = pk.assert(intentHash(good));
    await expect(signer.sign({ ...good, amount: '3000001' }, approval)).rejects.toThrow(/approval/); // approval bound to other fields
    await expect(signer.sign({ ...good, memo: '104588311' }, approval)).rejects.toThrow(/approval/);
    await expect(signer.sign({ ...good, memo: undefined }, approval)).rejects.toThrow(/approval/);
    await expect(signer.sign({ ...good, x: { ...X, sequence: '8' } }, approval)).rejects.toThrow(/approval/);
    await expect(signer.sign({ ...good, x: { ...X, timeout_height: '99999999' } }, approval)).rejects.toThrow(/approval/);
    await expect(tryIt(intent(t, { amount: '36000001' }))).rejects.toThrow(/per-transaction/);
    await expect(tryIt(intent(t, { maxFee: '50001', x: { ...X, fee_amount: '50001' } }))).rejects.toThrow(/fee ceiling/);
    await expect(tryIt(intent(t, { x: { ...X, fee_amount: '1501' } }))).rejects.toThrow(/approved maximum/);
    await expect(tryIt(intent(t, { chainRef: 'theta-testnet-001' }))).rejects.toThrow(/chain/);
    await expect(tryIt(intent(t, { from: DEST, to: 'cosmos1dkaw0wlutmwqfw7dyn4s5mlv7nj6xjax2a73q7' }))).rejects.toThrow(/source/);
    await expect(tryIt(intent(t, { to: keys.addresses.cosmos! }))).rejects.toThrow(/destination equals source/);
    await expect(tryIt(intent(t, { to: 'osmo19rl4cm2hmr8afy4kldpxz3fka4jguq0a5m7df8' }))).rejects.toThrow(/address/);
    await expect(tryIt(intent(t, { asset: 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2' }))).rejects.toThrow(/only native ATOM/);
    await expect(tryIt(intent(t, { memo: ' 104588310' }))).rejects.toThrow(/memo/);
    await expect(tryIt(intent(t, { x: { ...X, granter: DEST } }))).rejects.toThrow(/unknown or missing/);
    expect(() => tryIt(intent(t, { x: undefined }))).toThrow(/chain section/); // no approval can even be formed
    await expect(signer.sign(intent(t, { x: undefined }), approval)).rejects.toThrow();
    await expect(signer.sign(good, approval, { prevTx: {} })).rejects.toThrow(/helper data/);
    const r = await signer.sign(good, approval); // still usable, and only once
    expect(decodeTxRaw(Uint8Array.from(Buffer.from(r.raw, 'base64'))).signatures[0]!.length).toBe(64);
    await expect(signer.sign(good, pk.assert(intentHash(good)))).rejects.toThrow(/already signed/);
  });
});
