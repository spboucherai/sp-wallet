// Polkadot plugin: SS58 and derivation against Trust Wallet's published vector and @polkadot/util-crypto, the extrinsic and its
// signing payload against @polkadot/types loaded with the real Asset Hub metadata, every fail-closed case, and the strict
// decoder run on real Asset Hub transfers (fixtures recorded by scripts/record-cardano-polkadot-fixtures.mts).
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { mnemonicToSeedSync } from '@scure/bip39';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { decodeAddress, encodeAddress, signatureVerify } from '@polkadot/util-crypto';
import {
  buildPolkadotTx, canonicalBytes, DEFAULT_POLICY, intentHash, isValidAddress, NETWORKS, normalizeAddress, pluginFor, polkadotAccountId, polkadotAddressFromPublicKey, polkadotDecodeExtrinsic,
  polkadotEra, polkadotParseRaw, polkadotPlugin, POLKADOT_ASSET_HUB_GENESIS, POLKADOT_EXTENSIONS, POLKADOT_REVIEWED, scaleCompact, ScaleReader, ss58Encode, toHex,
  type Intent, type KeyHandle, type NetworkDef,
} from '../src/index.ts';

const net = NETWORKS.polkadot as NetworkDef;
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'; // public BIP-39 test vector
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** SLIP-0010 ed25519 (hardened only), independent of the signer's implementation. */
function slip10(seed: Uint8Array, path: string): Uint8Array {
  let I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
  for (const seg of path.split('/').slice(1)) {
    if (!seg.endsWith("'")) throw new Error('hardened only');
    const data = new Uint8Array(37);
    data.set(I.subarray(0, 32), 1);
    new DataView(data.buffer).setUint32(33, (Number(seg.slice(0, -1)) | 0x80000000) >>> 0);
    I = hmac(sha512, I.subarray(32), data);
  }
  return I.slice(0, 32);
}
const SEED = mnemonicToSeedSync(MNEMONIC);
const PRIV = slip10(SEED, polkadotPlugin.path(net)), PUB = ed25519.getPublicKey(PRIV);
const FROM = polkadotAddressFromPublicKey(PUB);
const TO = polkadotAddressFromPublicKey(ed25519.getPublicKey(slip10(SEED, "m/44'/354'/1'/0'/0'")));
const key: KeyHandle = { curve: 'ed25519', publicKey: PUB, signMessage: (m) => ed25519.sign(m, PRIV) };

// the official type registry, loaded with the metadata the plugin was reviewed against
const fx = JSON.parse(readFileSync(new URL('./fixtures/polkadot-asset-hub.json', import.meta.url), 'utf8')) as { genesis: string; version: { specName: string; specVersion: number; transactionVersion: number }; transfers: { block: number; blockHash: string; index: number; hex: string; events?: string }[] };
const META = gunzipSync(readFileSync(new URL('./fixtures/polkadot-asset-hub-metadata.hex.gz', import.meta.url)));
const registry = new TypeRegistry();
const metadata = new Metadata(registry, META);
registry.setMetadata(metadata);

const now = 1_794_420_000;
const ERA_HASH = '0x4d2e7de0e3ad3b97381a325870f0d232cfb84c7c227c8b17e7e9c86534201be9';
const base: Intent = {
  v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-0123456789abcdef', createdAt: now, expiresAt: now + 90, policyVersion: 4,
  network: 'polkadot', chainRef: POLKADOT_ASSET_HUB_GENESIS, asset: 'native', symbol: 'DOT', decimals: 10, amount: '12500000000', from: FROM, to: TO, maxFee: '500000000',
  x: { spec_version: '2005002', tx_version: '15', nonce: '7', era_block: '23003852', era_hash: ERA_HASH, era_period: '128' },
};
const withX = (x: Record<string, string>, over: Partial<Intent> = {}): Intent => ({ ...base, ...over, x: { ...base.x!, ...x } });

/** The signing payload of the same transfer, encoded by @polkadot/types. */
function sdkPayload(i: Intent): Uint8Array {
  const x = i.x!;
  const method = registry.createType('Call', { callIndex: [10, 3], args: { dest: { Id: i.to }, value: i.amount } });
  const era = registry.createType('ExtrinsicEra', { current: Number(x.era_block), period: Number(x.era_period) });
  const p = registry.createType('ExtrinsicPayload', { method: method.toHex(), era: era.toHex(), nonce: Number(x.nonce), tip: 0, assetId: null, mode: 0, metadataHash: null,
    specVersion: Number(x.spec_version), transactionVersion: Number(x.tx_version), genesisHash: '0x' + i.chainRef, blockHash: x.era_hash }, { version: 4 });
  return p.toU8a({ method: true });
}

describe('Polkadot addresses and keys', () => {
  it("derives Trust Wallet's published m/44'/354'/0'/0'/0' address, and what @polkadot/util-crypto encodes", () => {
    // https://github.com/trustwallet/wallet-core/blob/master/android/app/src/androidTest/java/com/trustwallet/core/app/blockchains/CoinAddressDerivationTests.kt
    const tw = slip10(mnemonicToSeedSync('shoot island position soft burden budget tooth cruel issue economy destroy above'), "m/44'/354'/0'/0'/0'");
    expect(polkadotAddressFromPublicKey(ed25519.getPublicKey(tw))).toBe('13nN6BGAoJwd7Nw1XxeBCx5YcBXuYnL94Mh7i3xBprqVSsFk');
    expect(polkadotPlugin.path(net)).toBe("m/44'/354'/0'/0'/0'");
    expect(polkadotPlugin.curve).toBe('ed25519');
    expect(polkadotPlugin.keyScheme).toBeUndefined();
    expect(FROM).toBe(encodeAddress(PUB, 0));
    expect(polkadotPlugin.address(net, PUB)).toBe(FROM);
    expect(hex(polkadotAccountId(FROM))).toBe(hex(decodeAddress(FROM)));
    expect(pluginFor(net)).toBe(polkadotPlugin);
    expect(() => polkadotPlugin.address(net, new Uint8Array(33))).toThrow(/32 bytes/);
    fc.assert(fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (a) => { const s = ss58Encode(0, a); expect(s).toBe(encodeAddress(a, 0)); expect(hex(polkadotAccountId(s))).toBe(hex(a)); }), { numRuns: 200 });
  });

  it('accepts Polkadot (prefix 0) account addresses only', () => {
    for (const a of [FROM, TO, '13nN6BGAoJwd7Nw1XxeBCx5YcBXuYnL94Mh7i3xBprqVSsFk', '15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5']) expect(normalizeAddress('polkadot', a)).toBe(a);
    const kusama = encodeAddress(PUB, 2), generic = encodeAddress(PUB, 42), hub = encodeAddress(PUB, 1);
    for (const a of [kusama, generic, hub, 'G9xV2EatmrjRC1FLPexc3ddqNRRzCsAdURU8RFiAAJX6ppY', FROM.slice(0, -1), FROM + '1', FROM.slice(0, -1) + (FROM.endsWith('2') ? '3' : '2'), '1' + FROM, '0x' + hex(PUB), hex(PUB), '',
      encodeAddress(new Uint8Array(32), 0), 'cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4'])
      expect(isValidAddress('polkadot', a), a).toBe(false);
    expect(() => normalizeAddress('polkadot', kusama)).toThrow(/invalid address/);
    expect(() => normalizeAddress('polkadot', encodeAddress(new Uint8Array(32), 0))).toThrow(/zero account/);
  });
});

describe('Polkadot SCALE', () => {
  it('compact integers match @polkadot/types and round-trip through the strict reader', () => {
    fc.assert(fc.property(fc.oneof(fc.bigInt({ min: 0n, max: 70000n }), fc.bigInt({ min: 0n, max: (1n << 128n) - 1n }), fc.constantFrom(63n, 64n, 16383n, 16384n, (1n << 30n) - 1n, 1n << 30n, (1n << 64n) - 1n)), (v) => {
      const mine = scaleCompact(v);
      expect(hex(mine)).toBe(hex(registry.createType('Compact<u128>', v).toU8a()));
      const r = new ScaleReader(mine);
      expect(r.compact()).toBe(v);
      expect(r.done).toBe(true);
    }), { numRuns: 300 });
    for (const b of [[0x01, 0x00], [0xfd, 0x00], [0x02, 0x00, 0x00, 0x00], [0xfe, 0xff, 0x00, 0x00], [0x03, 0xff, 0xff, 0xff, 0x3f], [0x07, 1, 0, 0, 0, 0], [0x33, ...new Array(16).fill(0), 1]])
      expect(() => new ScaleReader(Uint8Array.from(b)).compact(), hex(Uint8Array.from(b))).toThrow();
    for (const [period, block] of [[64, 23003852n], [128, 23003852n], [256, 1n], [16, 4294967295n], [32, 31n]] as [number, bigint][])
      expect(hex(polkadotEra(period, block))).toBe(hex(registry.createType('ExtrinsicEra', { current: Number(block), period }).toU8a()));
    for (const p of [0, 8, 100, 512, 1.5]) expect(() => polkadotEra(p, 1n)).toThrow(/power of two/);
  });
});

describe('Polkadot transfer', () => {
  it('produces the signing payload @polkadot/types encodes, and an extrinsic it decodes back field for field', () => {
    for (const i of [base, withX({ nonce: '0', era_period: '64', era_block: '1' }, { amount: '1' }), withX({ nonce: '70000', spec_version: '4294967295' }, { amount: '340282366920938463463374607431768211455' })]) {
      const b = buildPolkadotTx(i, net);
      expect(hex(b.payload)).toBe(hex(sdkPayload(i)));
      expect(b.payload.length).toBeLessThanOrEqual(256);
      expect(b.signDoc).toBe(b.payload); // signed as is: only payloads longer than 256 bytes are hashed first
      expect(hex(b.call)).toBe(hex(registry.createType('Call', { callIndex: [10, 3], args: { dest: { Id: i.to }, value: i.amount } }).toU8a()));
      const s = polkadotPlugin.sign(i, net, key);
      const raw = Buffer.from(s.raw.slice(2), 'hex');
      const xt = registry.createType('Extrinsic', raw);
      expect(xt.toHex()).toBe(s.raw);                                        // official round-trip, byte-identical
      expect(xt.hash.toHex()).toBe(s.txid);
      expect(xt.version).toBe(0x84); // signed, version 4
      expect(xt.isSigned).toBe(true);
      expect(xt.signer.toString()).toBe(i.from);
      expect(xt.method.section + '.' + xt.method.method).toBe('balances.transferKeepAlive');
      expect((xt.method.args[0] as unknown as { value: { toString(): string } }).value.toString()).toBe(i.to);
      expect(xt.method.args[1]!.toString()).toBe(i.amount);
      expect(xt.nonce.toString()).toBe(i.x!.nonce);
      expect(xt.tip.toString()).toBe('0');
      expect(xt.era.isMortalEra).toBe(true);
      expect(xt.era.asMortalEra.period.toNumber()).toBe(Number(i.x!.era_period));
      expect(xt.era.asMortalEra.birth(Number(i.x!.era_block) + 5)).toBe(Number(i.x!.era_block)); // the era starts exactly at the named block
      const multi = xt.signature as unknown as { isEd25519: boolean; asEd25519: { toU8a(): Uint8Array } } & { toU8a(): Uint8Array };
      const sig = raw.subarray(raw.length - b.call.length - b.extra.length - 64, raw.length - b.call.length - b.extra.length);
      expect(signatureVerify(b.payload, sig, i.from)).toMatchObject({ isValid: true, crypto: 'ed25519' }); // independent verification
      expect(ed25519.verify(sig, b.payload, PUB)).toBe(true);
      void multi;
      expect(polkadotParseRaw(s.raw).txid).toBe(s.txid);
      expect(s.txid).toBe('0x' + hex(blake2b(raw, { dkLen: 32 })));
      expect(polkadotPlugin.build(i, net).signDocs.map(hex)).toEqual([hex(b.payload)]);
      const d = polkadotDecodeExtrinsic(raw);
      expect(d).toMatchObject({ signatureType: 0, nonce: BigInt(i.x!.nonce!), tip: 0n, mode: 0, pallet: 10, callIndex: 3, value: BigInt(i.amount) });
      expect(ss58Encode(0, d.dest)).toBe(i.to);
    }
  });

  it('the reviewed pins are those of the recorded runtime', () => {
    expect(fx.genesis).toBe('0x' + POLKADOT_ASSET_HUB_GENESIS);
    expect(fx.version).toMatchObject({ specName: POLKADOT_REVIEWED.specName, transactionVersion: POLKADOT_REVIEWED.transactionVersion });
    expect(fx.version.specVersion).toBeGreaterThanOrEqual(POLKADOT_REVIEWED.minSpecVersion);
    const latest = metadata.asLatest as unknown as { extrinsic: { transactionExtensions: { identifier: { toString(): string } }[] }; pallets: { name: { toString(): string }; index: { toNumber(): number } }[] };
    expect(latest.extrinsic.transactionExtensions.map((e) => e.identifier.toString())).toEqual(POLKADOT_EXTENSIONS.map((e) => e[0]));
    expect(latest.pallets.find((p) => p.name.toString() === POLKADOT_REVIEWED.pallet.name)!.index.toNumber()).toBe(POLKADOT_REVIEWED.pallet.index);
    const call = registry.findMetaCall(Uint8Array.of(POLKADOT_REVIEWED.pallet.index, POLKADOT_REVIEWED.call.index));
    expect(call.section + '.' + call.method).toBe('balances.transferKeepAlive');
  });

  it('binds every field of the intent', () => {
    const ref = polkadotPlugin.sign(base, net, key);
    const variants: Intent[] = [{ ...base, amount: '12500000001' }, { ...base, to: FROM, from: FROM }, withX({ nonce: '8' }), withX({ era_block: '23003853' }), withX({ era_hash: '0x' + '11'.repeat(32) }),
      withX({ era_period: '64' }), withX({ spec_version: '2005003' })].filter((v) => v.to !== v.from);
    const seen = new Set([ref.raw]);
    for (const v of variants) { const s = polkadotPlugin.sign(v, net, key); expect(seen.has(s.raw)).toBe(false); seen.add(s.raw); expect(toHex(intentHash(v))).not.toBe(toHex(intentHash(base))); }
    expect(polkadotPlugin.sign(base, net, key)).toEqual(ref); // ed25519 is deterministic
    expect(canonicalBytes(base).length).toBeGreaterThan(100);
  });

  it('fails closed', () => {
    const bad = (i: Intent, re: RegExp) => { expect(() => polkadotPlugin.build(i, net), String(re)).toThrow(re); expect(() => polkadotPlugin.sign(i, net, key)).toThrow(re); };
    bad({ ...base, chainRef: '91b171bb158e2d3848fa23a9f1c25182fb8e20313b2c1eb49219da7a70ce90c3' }, /chain identity/); // the relay chain
    bad({ ...base, network: 'cosmos' }, /not a Polkadot intent/);
    expect(() => polkadotPlugin.build(base, { ...net, chainRef: '91b171bb158e2d3848fa23a9f1c25182fb8e20313b2c1eb49219da7a70ce90c3' })).toThrow(/only Polkadot Asset Hub/);
    bad({ ...base, asset: '1984' }, /only native DOT/);
    bad({ ...base, symbol: 'KSM' }, /asset metadata/);
    bad({ ...base, decimals: 12 }, /asset metadata/);
    bad({ ...base, memo: 'x' }, /memo/);
    bad({ ...base, amount: '0' }, /amount must be positive/);
    bad({ ...base, amount: '340282366920938463463374607431768211456' }, /amount out of range/);
    bad({ ...base, to: FROM }, /destination equals source/);
    bad({ ...base, to: encodeAddress(decodeAddress(TO), 2) }, /invalid address/);
    bad({ ...base, to: encodeAddress(new Uint8Array(32), 0) }, /zero account/);
    bad({ ...base, from: encodeAddress(PUB, 42) }, /invalid address/);
    bad(withX({ tx_version: '16' }), /has not been reviewed/);                  // a runtime upgrade changed the transaction format
    bad(withX({ tx_version: '14' }), /has not been reviewed/);
    bad(withX({ spec_version: '2005001' }), /x\.spec_version out of range/);
    bad(withX({ nonce: '4294967296' }), /x\.nonce out of range/);
    bad(withX({ nonce: '07' }), /canonical/);
    bad(withX({ era_period: '100' }), /power of two/);
    bad(withX({ era_period: '512' }), /x\.era_period out of range/);            // never immortal, never longer than 256 blocks
    bad(withX({ era_period: '8' }), /x\.era_period out of range/);
    bad(withX({ era_block: '0' }), /x\.era_block out of range/);
    bad(withX({ era_hash: ERA_HASH.slice(2) }), /x\.era_hash/);
    bad(withX({ era_hash: ERA_HASH.toUpperCase() }), /x\.era_hash/);
    bad(withX({ era_hash: '0x' + '00'.repeat(32) }), /x\.era_hash is empty/);
    bad(withX({ tip: '1' }), /unknown or missing/);
    bad(withX({ call: '0a00' }), /unknown or missing/);
    bad({ ...base, x: { ...base.x!, nonce: undefined as unknown as string } }, /canonical|unknown or missing/);
    bad({ ...base, x: undefined }, /missing Polkadot parameters/);
    bad({ ...base, sol: { recentBlockhash: 'x'.repeat(40), lastValidBlockHeight: 1, createAta: false, computeUnitLimit: 1, computeUnitPrice: '0' } }, /unexpected chain section/);
    expect(() => polkadotPlugin.build(base, net, { metadata: '0x' })).toThrow(/helper data/);
    const other = ed25519.getPublicKey(slip10(SEED, "m/44'/354'/1'/0'/0'"));
    expect(() => polkadotPlugin.sign(base, net, { ...key, publicKey: other })).toThrow(/does not control/);
    expect(() => polkadotPlugin.sign(base, net, { curve: 'secp256k1', publicKey: PUB })).toThrow(/ed25519/);
    expect(() => polkadotPlugin.sign(base, net, { ...key, signMessage: (m) => ed25519.sign(m.subarray(1), PRIV) })).toThrow(/self-check/);
    expect(() => polkadotParseRaw('0x00')).toThrow();
    expect(DEFAULT_POLICY.perTx['polkadot:DOT']).toBe('600000000000');
    expect(DEFAULT_POLICY.maxFee.polkadot).toBe('500000000');
    expect(DEFAULT_POLICY.version).toBe(4);
  });
});

describe('Polkadot codecs on real Asset Hub transfers', () => {
  it('decodes real signed transfers exactly as @polkadot/types does and re-encodes them byte for byte', () => {
    expect(fx.transfers.length).toBeGreaterThanOrEqual(5);
    const schemes = new Set<number>();
    for (const t of fx.transfers) {
      const raw = Buffer.from(t.hex.slice(2), 'hex');
      const d = polkadotDecodeExtrinsic(raw), xt = registry.createType('Extrinsic', raw);
      schemes.add(d.signatureType);
      expect(ss58Encode(0, d.signer)).toBe(xt.signer.toString());
      expect(d.nonce.toString()).toBe(xt.nonce.toString());
      expect(d.tip.toString()).toBe(xt.tip.toString());
      expect([d.pallet, d.callIndex]).toEqual([...xt.method.callIndex]);
      expect(['transferKeepAlive', 'transferAllowDeath']).toContain(xt.method.method);
      expect(ss58Encode(0, d.dest)).toBe((xt.method.args[0] as unknown as { value: { toString(): string } }).value.toString());
      expect(d.value.toString()).toBe(xt.method.args[1]!.toString());
      expect(d.era ? d.era.period : 0).toBe(xt.era.isMortalEra ? xt.era.asMortalEra.period.toNumber() : 0);
      expect(hex(d.call)).toBe(hex(xt.method.toU8a()));
      // rebuilt from the decoded fields with this module's encoders: identical bytes
      const inner = Uint8Array.from([0x84, 0x00, ...d.signer, d.signatureType, ...d.signature, ...d.extra, d.pallet, d.callIndex, 0x00, ...d.dest, ...scaleCompact(d.value)]);
      expect(hex(Uint8Array.from([...scaleCompact(BigInt(inner.length)), ...inner]))).toBe(t.hex.slice(2));
    }
    expect(schemes.has(0)).toBe(true); // ed25519 accounts transact on Asset Hub today
  });
});
