import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { TronWeb, utils as tronUtils } from 'tronweb';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  buildTronTx, canonicalBytes, DEFAULT_POLICY, getAsset, intentHash, NETWORKS, normalizeAddress, pluginFor, toHex, tronAddressFromPublicKey,
  tronPlugin, tronWire, type Intent, type KeyHandle,
} from '../src/index.ts';

// Public BIP-39 test vector mnemonic — holds no funds of ours, never used outside tests.
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const net = NETWORKS.tron;
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
// official SDK: derivation m/44'/195'/0'/0/0, address, offline transaction building (no network: unroutable host, never contacted)
const sdkAccount = TronWeb.fromMnemonic(MNEMONIC, "m/44'/195'/0'/0/0");
const tw = new TronWeb({ fullHost: 'http://127.0.0.1:9' });
const priv = Uint8Array.from(Buffer.from(sdkAccount.privateKey.slice(2), 'hex'));
const pub = secp256k1.getPublicKey(priv, true);
const ME = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH';
const DEST = 'TKHuVq1oKVruCGLvqVexFs6dawKv6fQgFs';

/** same shape as the signer's key handle (services/isolated-signer/src/keys.ts) */
const key: KeyHandle = { curve: 'secp256k1', publicKey: pub, signDigest: (digest) => {
  const sig = secp256k1.sign(digest, priv, { prehash: false, lowS: true, format: 'recovered' });
  const compact = sig.slice(1);
  return { compact, recovery: sig[0]!, der: secp256k1.Signature.fromBytes(compact, 'compact').toBytes('der') };
} };

const TS = 1_794_354_657_628, EXP = 1_794_354_717_000;
const now = Math.floor(TS / 1000);
const base = { v: 1 as const, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-0123456789abcdef', createdAt: now, expiresAt: now + 120, policyVersion: 2,
  network: 'tron', chainRef: net.chainRef, from: ME, to: DEST };
const X = { ref_block_bytes: '2660', ref_block_hash: 'afad6ef83bbf9b23', expiration: String(EXP), timestamp: String(TS) };
const trx: Intent = { ...base, asset: 'native', symbol: 'TRX', decimals: 6, amount: '1000000', maxFee: '1100000', x: X };
const usdt: Intent = { ...base, asset: USDT, symbol: 'USDT', decimals: 6, amount: '1000000', maxFee: '31000000', x: { ...X, fee_limit: '30000000' } };
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const header = (x: Record<string, string>) => ({ ref_block_bytes: x.ref_block_bytes!, ref_block_hash: x.ref_block_hash!, expiration: Number(x.expiration), timestamp: Number(x.timestamp) });
/** the same transfer built by tronweb, offline */
async function sdkTx(i: Intent) {
  if (i.asset === 'native') return tw.transactionBuilder.sendTrx(i.to, Number(i.amount), i.from, { blockHeader: header(i.x!) });
  const r = await tw.transactionBuilder.triggerSmartContract(i.asset, 'transfer(address,uint256)',
    { feeLimit: Number(i.x!.fee_limit), callValue: 0, txLocal: true, blockHeader: header(i.x!) } as never,
    [{ type: 'address', value: i.to }, { type: 'uint256', value: i.amount }], i.from);
  return r.transaction;
}

describe('TRON address', () => {
  it('derives the test-mnemonic address exactly like the official SDK (m/44\'/195\'/0\'/0/0)', () => {
    expect(sdkAccount.address).toBe(ME);
    expect(tronPlugin.path(net)).toBe("m/44'/195'/0'/0/0");
    expect(tronPlugin.address(net, pub)).toBe(ME);
    expect(tronAddressFromPublicKey(secp256k1.getPublicKey(priv, false))).toBe(ME);
    expect(pluginFor(net)).toBe(tronPlugin);
  });
  it('matches the SDK for random keys (property)', () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (k) => {
      if (!secp256k1.utils.isValidSecretKey(k)) return true;
      return tronPlugin.address(net, secp256k1.getPublicKey(k, true)) === TronWeb.address.fromPrivateKey(hex(k));
    }), { numRuns: 40 });
  });
  it('normalizes only canonical base58check mainnet addresses', () => {
    expect(normalizeAddress('tron', ` ${DEST} `)).toBe(DEST);
    expect(normalizeAddress('tron', USDT)).toBe(USDT);
    for (const bad of [
      '4166426c7ac3d98b29191063833345b6bc540d7278', // hex form
      'TKHuVq1oKVruCGLvqVexFs6dawKv6fQgFt', // checksum
      'tkhuvq1okvrucglvqvexfs6dawkv6fqgfs', // case
      'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', // zero address
      '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'TKHuVq1oKVruCGLvqVexFs6dawKv6fQgF', '',
    ]) expect(() => normalizeAddress('tron', bad), bad).toThrow();
    // a valid base58check string with another version byte (0xa0 = TRON testnet prefix) is refused
    const other = TronWeb.address.fromHex('a0' + '66426c7ac3d98b29191063833345b6bc540d7278');
    expect(() => normalizeAddress('tron', other)).toThrow();
  });
});

describe('TRON registry', () => {
  it('lists TRX and exactly one token, USDT, with a policy cap and a fee ceiling', () => {
    expect(net.family).toBe('tron');
    expect(net.coinType).toBe(195);
    expect(net.chainRef).toBe('00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc');
    expect(net.rpc.length).toBe(2);
    expect(net.tokens.map((t) => [t.id, t.symbol, t.decimals])).toEqual([[USDT, 'USDT', 6]]);
    expect(getAsset('tron', USDT).symbol).toBe('USDT');
    expect(() => getAsset('tron', 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8')).toThrow(); // USDC on TRON: not allowlisted
    expect(DEFAULT_POLICY.perTx['tron:TRX']).toBe('150000000');
    expect(DEFAULT_POLICY.perTx['tron:USDT']).toBe('50000000');
    expect(DEFAULT_POLICY.maxFee.tron).toBe('40000000');
  });
  it('hashes a TRON intent (x section) and refuses a foreign chain section', () => {
    expect(toHex(intentHash(usdt))).toMatch(/^[0-9a-f]{64}$/);
    expect(toHex(intentHash(usdt))).not.toBe(toHex(intentHash({ ...usdt, x: { ...usdt.x!, fee_limit: '30000001' } })));
    const { x: _x, ...noX } = usdt;
    expect(() => canonicalBytes(noX as Intent)).toThrow();
  });
});

describe('TRON transaction encoding vs the official SDK (tronweb, offline)', () => {
  it('TRX transfer: raw_data and txid are byte-identical', async () => {
    const mine = buildTronTx(trx, net), sdk = await sdkTx(trx);
    expect(hex(mine.rawData)).toBe(sdk.raw_data_hex);
    expect(hex(mine.txid)).toBe(sdk.txID);
    expect(mine.kind).toBe('TransferContract');
    expect(tronPlugin.build(trx, net).signDocs.map(hex)).toEqual([sdk.txID]);
  });
  it('USDT transfer: raw_data and txid are byte-identical', async () => {
    const mine = buildTronTx(usdt, net), sdk = await sdkTx(usdt);
    expect(hex(mine.rawData)).toBe(sdk.raw_data_hex);
    expect(hex(mine.txid)).toBe(sdk.txID);
    expect(mine.feeLimit).toBe(30_000_000n);
    expect(mine.bandwidthBytes).toBe(345); // what mainnet charges for this shape (net_usage of real USDT transfers)
  });
  it('the SDK decodes our bytes back to the same fields (and nothing else: no memo, no permission id, no call value)', () => {
    const d = tronUtils.deserializeTx.deserializeTransaction('TriggerSmartContract', hex(buildTronTx(usdt, net).rawData));
    expect({ ...d, contract: undefined, ref_block_hash: d.ref_block_hash.toLowerCase() }).toEqual({ contract: undefined, data: '', fee_limit: 30_000_000, ref_block_bytes: '2660',
      ref_block_hash: 'afad6ef83bbf9b23', expiration: EXP, timestamp: TS, scripts: '', auths: [] });
    expect(d.contract.length).toBe(1);
    expect(d.contract[0].type).toBe('TriggerSmartContract');
    expect(d.contract[0].Permission_id).toBe(0);
    const v = d.contract[0].parameter.value;
    expect(TronWeb.address.fromHex(v.owner_address)).toBe(ME);
    expect(TronWeb.address.fromHex(v.contract_address)).toBe(USDT);
    expect(v.data.toLowerCase()).toBe('a9059cbb' + '00000000000000000000000066426c7ac3d98b29191063833345b6bc540d7278' + '00000000000000000000000000000000000000000000000000000000000f4240');
    expect(v.call_value ?? 0).toBe(0);
    expect(v.call_token_value ?? 0).toBe(0);
    const n = tronUtils.deserializeTx.deserializeTransaction('TransferContract', hex(buildTronTx(trx, net).rawData));
    expect(n.contract.length).toBe(1);
    expect(n.fee_limit).toBe(0);
    const w = n.contract[0].parameter.value;
    expect([TronWeb.address.fromHex(w.owner_address), TronWeb.address.fromHex(w.to_address), w.amount]).toEqual([ME, DEST, 1_000_000]);
  });
  it('byte-identical for arbitrary parameters (property)', async () => {
    const hexN = (n: number) => fc.uint8Array({ minLength: n, maxLength: n }).map(hex);
    const dest = fc.uint8Array({ minLength: 32, maxLength: 32 }).filter((k) => secp256k1.utils.isValidSecretKey(k)).map((k) => tronAddressFromPublicKey(secp256k1.getPublicKey(k, true)));
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.bigInt({ min: 1n, max: (1n << 53n) - 1n }), dest, hexN(2), hexN(8),
      fc.integer({ min: 1, max: 86_399_999 }), fc.integer({ min: -600_000, max: 600_000 }), fc.integer({ min: 1, max: 2_000_000_000 }),
      async (token, amount, to, rbb, rbh, life, skew, feeLimit) => {
        const timestamp = now * 1000 + skew, expiration = Math.min(timestamp + life, (now + 120) * 1000 + 600_000);
        fc.pre(expiration > timestamp && to !== ME);
        const x = { ref_block_bytes: rbb, ref_block_hash: rbh, expiration: String(expiration), timestamp: String(timestamp), ...(token ? { fee_limit: String(feeLimit) } : {}) };
        const i: Intent = { ...(token ? usdt : trx), to, amount: amount.toString(), maxFee: '20000000000', x };
        const mine = buildTronTx(i, net), sdk = await sdkTx(i);
        return hex(mine.rawData) === sdk.raw_data_hex && hex(mine.txid) === sdk.txID;
      }), { numRuns: 60 });
  });
  it('token amounts above 2^53 are encoded exactly', async () => {
    const i: Intent = { ...usdt, amount: '123456789012345678901234567890' };
    const sdk = await sdkTx(i);
    expect(hex(buildTronTx(i, net).rawData)).toBe(sdk.raw_data_hex);
  });
});

describe('TRON encoding vs java-tron (recorded mainnet data)', () => {
  // Transaction 9dc1c48f…d1b3, block 87880468 (irreversible), read from two public full nodes on 2026-11-10.
  it('reproduces a real mainnet TRX transfer: raw_data_hex, txID and the bandwidth it was charged', () => {
    const ts = 1_794_315_198_458, c = Math.floor(ts / 1000);
    const real: Intent = { ...base, createdAt: c, expiresAt: c + 120, from: 'TEYtK8nj6LXrWtEvbGoiAYaV6Rzqs7hFpd', to: 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi',
      asset: 'native', symbol: 'TRX', decimals: 6, amount: '7', maxFee: '1000000',
      x: { ref_block_bytes: 'f301', ref_block_hash: '8d1e8e380c40a4c6', expiration: '1794315258000', timestamp: String(ts) } };
    const t = buildTronTx(real, net);
    expect(hex(t.rawData)).toBe('0a02f30122088d1e8e380c40a4c640909198ac9c345a65080112610a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412300a1541323f0babf73d763030d62d11dcb3e3e72c1398a9121541d1c4bb7b2f39aba5707711719b2236b5b605af2e180770fabf94ac9c34');
    expect(hex(t.txid)).toBe('9dc1c48fc17d0bb3ff8942095b24d3a2d4f147e0debc779d0372126d4d00d1b3');
    expect(t.bandwidthBytes).toBe(265); // receipt.net_usage of that transaction
    expect(t.worstFee).toBe(265_000n);
  });
  // Answer of /wallet/createtransaction (tron-rpc.publicnode.com, 2026-11-10) for these parameters; scripts/smoke-tron.mts repeats
  // the comparison live for both shapes.
  it('reproduces what a full node builds for the same transfer', () => {
    const from = 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi';
    const a = buildTronTx({ ...trx, from, to: DEST }, net);
    expect(hex(a.rawData)).toBe('0a0226602208afad6ef83bbf9b2340c8c280bf9c345a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a1541d1c4bb7b2f39aba5707711719b2236b5b605af2e12154166426c7ac3d98b29191063833345b6bc540d727818c0843d70dcf2fcbe9c34');
    expect(hex(a.txid)).toBe('720a71525a4aa8ac8fcf8e00c1f5e7dcf6aeafdb7ce732ed7ddb4ad12f5bd157');
  });
});

describe('TRON signing', () => {
  it.each([['TRX', trx], ['USDT', usdt]] as const)('%s: signature equals the SDK\'s, verifies, and the wire bytes equal the SDK protobuf', async (_n, i) => {
    const out = tronPlugin.sign(i, net, key);
    const sdk = await sdkTx(i);
    const signed = await tw.trx.sign(sdk, sdkAccount.privateKey.slice(2));
    expect(out.txid).toBe(sdk.txID);
    const raw = Uint8Array.from(Buffer.from(out.raw, 'hex'));
    const sig = raw.subarray(raw.length - 65);
    expect(hex(sig)).toBe(signed.signature[0]!.toLowerCase()); // RFC 6979 + low-S: deterministic, so identical to tronweb's
    // noble: verifies against the public key, and the recovery byte recovers the same key
    const digest = sha256(buildTronTx(i, net).rawData);
    expect(secp256k1.verify(sig.subarray(0, 64), digest, pub, { prehash: false })).toBe(true);
    const rec = secp256k1.Signature.fromBytes(sig.subarray(0, 64), 'compact').addRecoveryBit(sig[64]! - 27).recoverPublicKey(digest).toBytes(true);
    expect(hex(rec)).toBe(hex(pub));
    // broadcast payload = protobuf Transaction { raw_data, signature }, as serialized by the SDK's own protobuf classes
    const pb = tronUtils.transaction.txJsonToPb(sdk);
    pb.addSignature(Uint8Array.from(Buffer.from(signed.signature[0]!, 'hex')));
    expect(out.raw).toBe(hex(pb.serializeBinary()));
    expect(out.raw).toBe(hex(tronWire(buildTronTx(i, net).rawData, sig)));
  });
  it('refuses to sign for an address the key does not control', () => {
    const other = secp256k1.getPublicKey(sha256(new TextEncoder().encode('another test key')), true);
    expect(() => tronPlugin.sign(trx, net, { ...key, publicKey: other })).toThrow(/not controlled/);
    expect(() => tronPlugin.sign(trx, net, { curve: 'ed25519', publicKey: pub, signMessage: () => new Uint8Array(64) })).toThrow();
    // a handle that returns a signature made with another key is caught by the self-check
    const rogue = sha256(new TextEncoder().encode('rogue'));
    const bad: KeyHandle = { ...key, signDigest: (d) => { const s = secp256k1.sign(d, rogue, { prehash: false, lowS: true, format: 'recovered' }); return { compact: s.slice(1), recovery: s[0]!, der: new Uint8Array() }; } };
    expect(() => tronPlugin.sign(trx, net, bad)).toThrow(/self-check/);
  });
});

describe('TRON builder fails closed', () => {
  const bad = (name: string, i: Intent, re?: RegExp) => it(name, () => { if (re) expect(() => tronPlugin.build(i, net)).toThrow(re); else expect(() => tronPlugin.build(i, net)).toThrow(); });
  const withX = (i: Intent, patch: Record<string, string | undefined>): Intent => {
    const x: Record<string, string> = { ...i.x! };
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete x[k]; else x[k] = v; }
    return { ...i, x };
  };
  it('accepts the two reference intents', () => { expect(() => tronPlugin.build(trx, net)).not.toThrow(); expect(() => tronPlugin.build(usdt, net)).not.toThrow(); });
  bad('wrong genesis', { ...trx, chainRef: NETWORKS.bitcoin.chainRef }, /chain identity/);
  bad('another network id', { ...trx, network: 'solana' }, /not a TRON intent/);
  it('another network definition', () => expect(() => tronPlugin.build(trx, NETWORKS.solana)).toThrow(/not a TRON intent/));
  bad('hex-form source', { ...trx, from: '41c8599111f29c1e1e061265b4af93ea1f274ad78a' });
  bad('destination with surrounding space', { ...trx, to: ` ${DEST}` });
  bad('destination with a bad checksum', { ...trx, to: 'TKHuVq1oKVruCGLvqVexFs6dawKv6fQgFt' });
  bad('EVM destination', { ...trx, to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' });
  bad('zero-address destination', { ...trx, to: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb' }, /zero address/);
  bad('destination equal to source', { ...trx, to: ME }, /source equals destination/);
  bad('TRX sent to the token contract', { ...trx, to: USDT }, /token contract/);
  bad('USDT sent to the token contract', { ...usdt, to: USDT }, /token contract/);
  bad('token that is not allowlisted', { ...usdt, asset: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', symbol: 'USDC' }, /not allowlisted/);
  bad('EVM token address as asset', { ...usdt, asset: '0xdAC17F958D2ee523a2206206994597C13D831ec7' }, /not allowlisted/);
  bad('wrong symbol', { ...usdt, symbol: 'USDC' }, /metadata/);
  bad('wrong decimals', { ...trx, decimals: 18 }, /metadata/);
  bad('zero amount', { ...trx, amount: '0' }, /positive/);
  bad('zero token amount', { ...usdt, amount: '0' }, /positive/);
  bad('native amount beyond int64', { ...trx, amount: (1n << 63n).toString() }, /out of range/);
  bad('token amount beyond uint256', { ...usdt, amount: (1n << 256n).toString() });
  bad('native fee above maxFee (bandwidth burn)', { ...trx, maxFee: '266999' }, /fee exceeds/);
  bad('fee_limit above maxFee', { ...usdt, maxFee: '30000000' }, /fee exceeds/);
  bad('fee_limit + bandwidth above maxFee', { ...usdt, maxFee: '30344999' }, /fee exceeds/);
  it('fee exactly at maxFee is accepted', () => {
    expect(() => tronPlugin.build({ ...trx, maxFee: '267000' }, net)).not.toThrow();
    expect(() => tronPlugin.build({ ...usdt, maxFee: '30345000' }, net)).not.toThrow();
  });
  bad('fee_limit of zero', withX(usdt, { fee_limit: '0' }), /fee_limit/);
  bad('fee_limit above the protocol maximum', { ...withX(usdt, { fee_limit: '15000000001' }), maxFee: '99000000000' }, /fee_limit/);
  bad('fee_limit on a native transfer', withX(trx, { fee_limit: '1' }), /exactly/);
  bad('missing fee_limit on a token transfer', withX(usdt, { fee_limit: undefined }), /exactly/);
  bad('unknown x key', withX(trx, { data: '00' }), /exactly/);
  bad('permission id smuggled in x', withX(usdt, { permission_id: '2' }), /exactly/);
  bad('call_value smuggled in x', withX(usdt, { call_value: '1' }), /exactly/);
  for (const k of ['ref_block_bytes', 'ref_block_hash', 'expiration', 'timestamp']) bad(`missing x.${k}`, withX(trx, { [k]: undefined }), /exactly/);
  bad('no x section', (() => { const { x: _x, ...r } = trx; return r as Intent; })(), /missing TRON parameters/);
  bad('foreign evm section', { ...trx, evm: { nonce: 0, gasLimit: '21000', maxFeePerGas: '1', maxPriorityFeePerGas: '1' } }, /foreign/);
  bad('memo', { ...trx, memo: 'hello' }, /memo/);
  bad('ref_block_bytes wrong length', withX(trx, { ref_block_bytes: '266000' }));
  bad('ref_block_bytes uppercase', withX(trx, { ref_block_bytes: '26AB' }));
  bad('ref_block_hash wrong length', withX(trx, { ref_block_hash: 'afad6ef83bbf9b' }));
  bad('expiration not decimal', withX(trx, { expiration: '0x1' }));
  bad('expiration with leading zero', withX(trx, { expiration: '0' + EXP }));
  bad('expiration before timestamp', withX(trx, { expiration: String(TS) }), /after timestamp/);
  bad('expiration a day away', withX(trx, { expiration: String(TS + 86_400_000) }));
  bad('expiration outliving the approval window', withX(trx, { expiration: String((now + 120) * 1000 + 600_001) }), /approval window/);
  bad('timestamp far from the approval window', withX(trx, { timestamp: String(TS - 700_000) }), /approval window/);
  bad('negative timestamp', withX(trx, { timestamp: '-1' }));
});

describe('TRON: every intent field that reaches the chain changes the signed bytes or throws', () => {
  const sig = (i: Intent): string | null => { try { return tronPlugin.sign(i, net, key).raw; } catch { return null; } };
  const OTHER = 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi';
  const mutations: [string, (i: Intent) => Intent][] = [
    ['amount', (i) => ({ ...i, amount: '1000001' })],
    ['to', (i) => ({ ...i, to: OTHER })],
    ['from', (i) => ({ ...i, from: OTHER })],
    ['asset', (i) => (i.asset === 'native' ? { ...usdt } : { ...trx })],
    ['network', (i) => ({ ...i, network: 'solana' })],
    ['chainRef', (i) => ({ ...i, chainRef: i.chainRef.replace(/.$/, 'd') })],
    ['symbol', (i) => ({ ...i, symbol: 'XXX' })],
    ['decimals', (i) => ({ ...i, decimals: 8 })],
    ['x.ref_block_bytes', (i) => ({ ...i, x: { ...i.x!, ref_block_bytes: '2661' } })],
    ['x.ref_block_hash', (i) => ({ ...i, x: { ...i.x!, ref_block_hash: 'afad6ef83bbf9b24' } })],
    ['x.expiration', (i) => ({ ...i, x: { ...i.x!, expiration: String(EXP + 1) } })],
    ['x.timestamp', (i) => ({ ...i, x: { ...i.x!, timestamp: String(TS + 1) } })],
    ['x.fee_limit', (i) => ({ ...i, x: { ...i.x!, fee_limit: '29999999' } })],
    ['maxFee below the fee', (i) => ({ ...i, maxFee: '1' })],
    ['memo', (i) => ({ ...i, memo: '1' })],
  ];
  for (const [label, ref] of [['TRX', trx], ['USDT', usdt]] as const)
    for (const [name, f] of mutations) it(`${label}: ${name}`, () => {
      const a = sig(ref), b = sig(f(ref));
      expect(a).not.toBeNull();
      expect(b === null || b !== a).toBe(true);
    });
  it('same intent, same bytes (deterministic)', () => { expect(sig(usdt)).toBe(sig({ ...usdt, x: { ...usdt.x! } })); });
  it('fields outside the transaction (proposal id, approval window, larger fee ceiling) change the approved hash, not the bytes', () => {
    for (const j of [{ ...usdt, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a12' }, { ...usdt, expiresAt: usdt.expiresAt + 1 }, { ...usdt, maxFee: '31000001' }, { ...usdt, policyVersion: 3 }]) {
      expect(sig(j)).toBe(sig(usdt));
      expect(toHex(intentHash(j))).not.toBe(toHex(intentHash(usdt)));
    }
  });
});
