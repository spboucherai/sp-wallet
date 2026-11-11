// Polkadot (Asset Hub) through the real Signer: passkey approval bound to the intent, plugin build + sign with the signer's
// SLIP-0010 ed25519 key handle; the result decoded by @polkadot/types with the real runtime metadata and verified independently.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { encodeAddress, signatureVerify } from '@polkadot/util-crypto';
import { buildPolkadotTx, intentHash, NETWORKS, type Intent } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../src/keys.ts';
import { Signer } from '../src/signer.ts';
import { Store } from '../src/store.ts';

// Public BIP-39 test vector mnemonic — never used outside tests.
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const keys = deriveKeys(TEST_MNEMONIC);
const DEST = '15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5';
const X = { spec_version: '2005002', tx_version: '15', nonce: '7', era_block: '23003852', era_hash: '0x4d2e7de0e3ad3b97381a325870f0d232cfb84c7c227c8b17e7e9c86534201be9', era_period: '256' };
const registry = new TypeRegistry();
registry.setMetadata(new Metadata(registry, gunzipSync(readFileSync(new URL('../../../packages/core/test/fixtures/polkadot-asset-hub-metadata.hex.gz', import.meta.url)))));

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'spw-signer-polkadot-'));
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
  policyVersion: 4, network: 'polkadot', chainRef: NETWORKS.polkadot.chainRef, asset: 'native', symbol: 'DOT', decimals: 10, amount: '12500000000', from: keys.addresses.polkadot!, to: DEST, maxFee: '18000000', x: X, ...over });

describe('Polkadot through the signer', () => {
  it("derives the SLIP-0010 ed25519 account m/44'/354'/0'/0'/0' (Trust Wallet's derivation)", () => {
    // Trust Wallet, wallet-core CoinAddressDerivationTests.kt (POLKADOT)
    expect(deriveKeys('shoot island position soft burden budget tooth cruel issue economy destroy above').addresses.polkadot).toBe('13nN6BGAoJwd7Nw1XxeBCx5YcBXuYnL94Mh7i3xBprqVSsFk');
    expect(keys.addresses.polkadot).toBe(encodeAddress(keys.handle(NETWORKS.polkadot).publicKey, 0));
    expect(keys.addresses.polkadot).toMatch(/^1[1-9A-HJ-NP-Za-km-z]{46,47}$/);
  });

  it('signs an approved DOT transfer that @polkadot/types decodes and whose signature verifies independently', async () => {
    const { signer, pk, t } = await setup();
    const i = intent(t);
    const r = await signer.sign(i, pk.assert(intentHash(i)));
    const raw = Buffer.from(r.raw.slice(2), 'hex');
    const xt = registry.createType('Extrinsic', raw);
    expect(xt.toHex()).toBe(r.raw);
    expect(xt.hash.toHex()).toBe(r.txid);
    expect(xt.signer.toString()).toBe(keys.addresses.polkadot);
    expect(xt.method.section + '.' + xt.method.method).toBe('balances.transferKeepAlive');
    expect((xt.method.args[0] as unknown as { value: { toString(): string } }).value.toString()).toBe(DEST);
    expect(xt.method.args[1]!.toString()).toBe('12500000000');
    expect(xt.nonce.toNumber()).toBe(7);
    expect(xt.tip.toString()).toBe('0');
    expect(xt.era.asMortalEra.period.toNumber()).toBe(256);
    expect(xt.era.asMortalEra.birth(23003900)).toBe(23003852);
    const b = buildPolkadotTx(i, NETWORKS.polkadot);
    const sig = raw.subarray(raw.length - b.call.length - b.extra.length - 64, raw.length - b.call.length - b.extra.length);
    expect(signatureVerify(b.payload, sig, keys.addresses.polkadot!)).toMatchObject({ isValid: true, crypto: 'ed25519' });
  });

  it('refuses everything else', async () => {
    const { signer, pk, t } = await setup();
    const tryIt = (i: Intent) => signer.sign(i, pk.assert(intentHash(i)));
    const good = intent(t);
    const approval = pk.assert(intentHash(good));
    await expect(signer.sign({ ...good, amount: '12500000001' }, approval)).rejects.toThrow(/approval/); // approval bound to other fields
    await expect(signer.sign({ ...good, x: { ...X, nonce: '8' } }, approval)).rejects.toThrow(/approval/);
    await expect(signer.sign({ ...good, x: { ...X, era_period: '128' } }, approval)).rejects.toThrow(/approval/);
    await expect(tryIt(intent(t, { amount: '600000000001' }))).rejects.toThrow(/per-transaction/);
    await expect(tryIt(intent(t, { maxFee: '500000001' }))).rejects.toThrow(/fee ceiling/);
    await expect(tryIt(intent(t, { x: { ...X, tx_version: '16' } }))).rejects.toThrow(/has not been reviewed/); // runtime upgrade changed the transaction format
    await expect(tryIt(intent(t, { x: { ...X, era_period: '65536' } }))).rejects.toThrow(/era_period/);
    await expect(tryIt(intent(t, { chainRef: '91b171bb158e2d3848fa23a9f1c25182fb8e20313b2c1eb49219da7a70ce90c3' }))).rejects.toThrow(/chain/); // the relay chain
    await expect(tryIt(intent(t, { from: DEST, to: keys.addresses.polkadot! }))).rejects.toThrow(/not controlled|does not control/);
    await expect(tryIt(intent(t, { to: keys.addresses.polkadot! }))).rejects.toThrow(/destination equals source/);
    await expect(tryIt(intent(t, { to: 'G9xV2EatmrjRC1FLPexc3ddqNRRzCsAdURU8RFiAAJX6ppY' }))).rejects.toThrow(/address/); // Kusama
    await expect(tryIt(intent(t, { asset: '1984' }))).rejects.toThrow(/only native DOT/);
    await expect(tryIt(intent(t, { memo: 'x' }))).rejects.toThrow(/memo/);
    await expect(tryIt(intent(t, { x: { ...X, tip: '1000000000' } }))).rejects.toThrow(/unknown or missing/);
    expect(() => tryIt(intent(t, { x: undefined }))).toThrow(/chain section/); // no approval can even be formed
    await expect(signer.sign(good, approval, { metadata: '0x00' })).rejects.toThrow(/helper data/);
    const r = await signer.sign(good, approval); // still usable, and only once
    expect(registry.createType('Extrinsic', r.raw).isSigned).toBe(true);
    await expect(signer.sign(good, pk.assert(intentHash(good)))).rejects.toThrow(/already signed/);
  });
});
