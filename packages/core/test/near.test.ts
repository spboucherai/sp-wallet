import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import { KeyType, PublicKey } from '@near-js/crypto';
import { actionCreators, createTransaction, decodeSignedTransaction, decodeTransaction, encodeTransaction, Signature, SignedTransaction } from '@near-js/transactions';
import {
  buildNearTx, canonicalBytes, DEFAULT_POLICY, intentHash, IntentSchema, isValidAddress, NEAR_GAS_BOUND_IMPLICIT, NEAR_GAS_BOUND_NAMED, NEAR_MAINNET_GENESIS,
  NEAR_MAX_GAS_PRICE, nearAccountKind, nearDecodeHash, nearFeeCeiling, nearImplicitAccount, nearPlugin, nearSignedTxInfo, NETWORKS, normalizeAddress, parseUnits,
  pluginFor, toHex, type Intent, type KeyHandle, type NetworkDef,
} from '../src/index.ts';

// near-seed-phrase (the derivation used by NEAR wallets) is CommonJS without types
const { parseSeedPhrase, KEY_DERIVATION_PATH } = createRequire(import.meta.url)('near-seed-phrase') as {
  parseSeedPhrase: (phrase: string, path?: string) => { publicKey: string; secretKey: string }; KEY_DERIVATION_PATH: string;
};

const net = NETWORKS.near as NetworkDef;
const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
// Public BIP-39 test mnemonic (known to everyone, used here for derivation and signing vectors only; nothing is ever broadcast) and its BIP-39 seed.
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SEED = hexToBytes('5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4');
/** the wallet's NEAR account for that mnemonic, as produced by near-seed-phrase 0.2.1 (m/44'/397'/0') */
const ACCOUNT_0 = '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412';

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
const PRIV = slip10(SEED, nearPlugin.path(net));
const PUB = ed25519.getPublicKey(PRIV);
const FROM = nearImplicitAccount(PUB);
const OTHER = nearImplicitAccount(ed25519.getPublicKey(slip10(SEED, "m/44'/397'/1'")));
const key: KeyHandle = { curve: 'ed25519', publicKey: PUB, signMessage: (m) => ed25519.sign(m, PRIV) };
const BLOCK = 'bRJrdMWsAoEJdNrSK1KXJFHwGC16Rtth9NhP6ZomSBh'; // a real mainnet block hash (height 223991714)

const now = 1_800_000_000;
const base: Intent = {
  v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-0123456789abcdef', createdAt: now, expiresAt: now + 120, policyVersion: 4,
  network: 'near', chainRef: NEAR_MAINNET_GENESIS, asset: 'native', symbol: 'NEAR', decimals: 24, amount: '1250000000000000000000001', from: FROM, to: 'alice.near',
  maxFee: '2000000000000000000000', x: { nonce: '223991684000002', blockHash: BLOCK },
};
const toImplicit = (over: Partial<Intent> = {}): Intent => ({ ...base, to: OTHER, maxFee: '20000000000000000000000', ...over });
const withX = (x: Record<string, string>, over: Partial<Intent> = {}): Intent => ({ ...base, ...over, x: { ...base.x!, ...x } });

/** The same transaction built by the official SDK from the same fields. */
const sdkTx = (i: Intent) => createTransaction(i.from, PublicKey.fromString('ed25519:' + base58.encode(hexToBytes(i.from))), i.to, BigInt(i.x!.nonce!),
  [actionCreators.transfer(BigInt(i.amount))], base58.decode(i.x!.blockHash!));

describe('near: registration', () => {
  it('is registered with the pinned identity, derivation, limits and two sources', () => {
    expect(pluginFor(net)).toBe(nearPlugin);
    expect(net.chainRef).toBe('EPnLgE7iEq9s7yTkos96M3cWymH5avBAPm3qx3NXqR8H');
    expect([net.id, net.family, net.coinType, net.memo, net.activation, net.native.symbol, net.native.decimals, net.tokens.length]).toEqual(['near', 'near', 397, undefined, undefined, 'NEAR', 24, 0]);
    expect(nearPlugin.path(net)).toBe("m/44'/397'/0'");
    expect(nearPlugin.path(net)).toBe(KEY_DERIVATION_PATH); // the path NEAR wallets use
    expect(() => nearPlugin.path({ ...net, coinType: 501 })).toThrow();
    expect(new Set(net.rpc.map((u) => new URL(u).host)).size).toBe(2);
    expect(DEFAULT_POLICY.perTx['near:NEAR']).toBe(parseUnits('14', 24).toString());
    expect(DEFAULT_POLICY.daily['near:NEAR']).toBe('28000000000000000000000000');
    // the policy fee ceiling admits the worst case of both transfer kinds, and nothing larger than 0.02 NEAR
    expect(BigInt(DEFAULT_POLICY.maxFee.near!)).toBe(nearFeeCeiling(OTHER));
    expect(nearFeeCeiling('alice.near')).toBe(NEAR_GAS_BOUND_NAMED * NEAR_MAX_GAS_PRICE);
    expect([nearFeeCeiling('alice.near'), nearFeeCeiling(OTHER)]).toEqual([2_000_000_000_000_000_000_000n, 20_000_000_000_000_000_000_000n]);
    expect(NEAR_GAS_BOUND_IMPLICIT).toBeGreaterThan(8_349_895_375_000n); // protocol 88: send + execution gas of a transfer creating an implicit account
    expect(NEAR_GAS_BOUND_NAMED).toBeGreaterThan(446_365_125_000n);
  });
});

describe('near: keys and addresses', () => {
  it('derives the same account as near-seed-phrase for the public test mnemonic', () => {
    for (const path of ["m/44'/397'/0'", "m/44'/397'/1'"]) {
      const sdk = parseSeedPhrase(MNEMONIC, path), pub = ed25519.getPublicKey(slip10(SEED, path));
      expect('ed25519:' + base58.encode(pub)).toBe(sdk.publicKey);
      expect(nearPlugin.address(net, pub)).toBe(Buffer.from(PublicKey.fromString(sdk.publicKey).data).toString('hex'));
      expect(base58.encode(Uint8Array.from([...slip10(SEED, path), ...pub]))).toBe(sdk.secretKey.replace('ed25519:', ''));
    }
    expect(parseSeedPhrase(MNEMONIC).publicKey).toBe('ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25');
    expect(FROM).toBe(ACCOUNT_0);
    expect(() => nearImplicitAccount(new Uint8Array(33))).toThrow();
  });
  it('implicit account id = lowercase hex of the key (property), accepted as a destination', () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (k) => {
      const a = nearImplicitAccount(k);
      return a === Buffer.from(k).toString('hex') && nearAccountKind(a) === 'implicit' && normalizeAddress('near', a) === a;
    }));
  });
  it('accepts valid named accounts and nothing else', () => {
    const good = ['alice.near', 'near', 'aa', 'a.b', 'app.alice.near', 'a-b_c.d1.near', '100.near', 'x'.repeat(64), 'bridge-mng.near', 'usdt.tether-token.near', '0'.repeat(63) + 'g', 'f'.repeat(63), 'f'.repeat(62) + '.f'];
    for (const a of good) { expect(nearAccountKind(a), a).toBe('named'); expect(normalizeAddress('near', a)).toBe(a); }
    const bad = [
      '', 'a', 'x'.repeat(65), 'Alice.near', 'ALICE.NEAR', FROM.toUpperCase(), 'alice..near', '.alice', 'alice.', '-alice', 'alice-', '_a', 'a_', 'a-.b', 'a._b', 'a--b', 'a__b', 'a-_b',
      'alice near', 'alice@near', 'alice.near\n', 'ålice.near', 'alice.near/', 'alice,near', 'al*ce', '😀😀',
      'system', // reserved virtual account
      '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', '0X70997970C51812DC3A010C7D01B50E0D17DC79C8', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', // Ethereum-style implicit accounts: refused
      '0s70997970c51812dc3a010c7d01b50e0d17dc79c8', '0u70997970c51812dc3a010c7d01b50e0d17dc79c8', // deterministic / universal accounts: refused
      'ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25', '6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25', // a public key is not an account id
      'GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV', 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8',
    ];
    for (const a of bad) { expect(() => nearAccountKind(a), JSON.stringify(a)).toThrow(); if (a.trim() === a) expect(isValidAddress('near', a), JSON.stringify(a)).toBe(false); }
    expect(() => nearAccountKind(undefined as never)).toThrow();
    expect(normalizeAddress('near', '  alice.near ')).toBe('alice.near'); // the shared entry point trims surrounding whitespace only
    expect(nearAccountKind('f'.repeat(64))).toBe('implicit');
    // An all-lowercase address of another chain is a syntactically valid NEAR name (no such account exists on NEAR):
    // the grammar cannot tell, so the API refuses a named destination that does not exist on-chain (see the adapter tests).
    expect(nearAccountKind('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')).toBe('named');
  });
  it('agrees with the reference account id grammar (property)', () => {
    // near-account-id: 2..64 chars, /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/
    const re = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
    const special = (s: string) => s === 'system' || /^0[a-z][0-9a-f]{40}$/.test(s);
    fc.assert(fc.property(fc.string({ unit: fc.constantFrom('a', 'b', 'z', '0', '9', '.', '-', '_', 'A', ' '), minLength: 0, maxLength: 12 }), (s) => {
      const want = s.length >= 2 && re.test(s) && !special(s);
      let got = true;
      try { nearAccountKind(s); } catch { got = false; }
      return got === want;
    }), { numRuns: 3000 });
  });
});

describe('near: transaction bytes', () => {
  const cases: [string, Intent][] = [
    ['to a named account', base],
    ['to an implicit account', toImplicit()],
    ['1 yoctoNEAR', { ...base, amount: '1' }],
    ['a 24-decimal amount with every digit significant', { ...base, amount: '13999999999999999999999999' }],
    ['the largest u128', { ...base, amount: ((1n << 128n) - 1n).toString() }],
    ['the largest nonce', withX({ nonce: ((1n << 64n) - 1n).toString() })],
    ['a 2-character receiver', { ...base, to: 'aa' }],
    ['a 64-character named receiver', { ...base, to: 'x'.repeat(64) }],
  ];
  for (const [name, i] of cases) it(`is byte-identical to @near-js/transactions: ${name}`, () => {
    const b = buildNearTx(i, net), sdk = sdkTx(i);
    expect(toHex(b.tx)).toBe(toHex(encodeTransaction(sdk)));
    expect(toHex(b.hash)).toBe(toHex(sha256(encodeTransaction(sdk))));
    expect(b.txid).toBe(base58.encode(sha256(encodeTransaction(sdk))));
    // decoded by the SDK, every field is the approved one
    const d = decodeTransaction(b.tx) as any; // borsh-deserialized plain fields
    expect([d.signerId, d.receiverId, d.nonce, base58.encode(Uint8Array.from(d.blockHash)), d.actions.length]).toEqual([i.from, i.to, BigInt(i.x!.nonce!), i.x!.blockHash, 1]);
    expect(Object.keys(d.actions[0])).toEqual(['transfer']);
    expect(d.actions[0].transfer.deposit).toBe(BigInt(i.amount));
    expect(Object.keys(d.publicKey)).toEqual(['ed25519Key']);
    expect(toHex(Uint8Array.from(d.publicKey.ed25519Key.data))).toBe(i.from);
    expect(toHex(encodeTransaction(d))).toBe(toHex(b.tx)); // re-encoded by the SDK: unchanged
    expect(nearPlugin.build(i, net).signDocs.map(toHex)).toEqual([toHex(b.hash)]);
  });
  it('is byte-identical to the SDK for arbitrary fields (property)', () => {
    const name = fc.stringMatching(/^[a-z0-9]{1,10}(\.[a-z0-9]{1,10}){0,2}$/).filter((s) => s.length >= 2 && isValidAddress('near', s));
    fc.assert(fc.property(fc.bigInt({ min: 1n, max: (1n << 128n) - 1n }), fc.bigInt({ min: 1n, max: (1n << 64n) - 1n }), fc.uint8Array({ minLength: 32, maxLength: 32 }),
      fc.oneof(name, fc.uint8Array({ minLength: 32, maxLength: 32 }).map((k) => Buffer.from(k).toString('hex'))), (amount, nonce, block, to) => {
        fc.pre(to !== FROM);
        const i: Intent = { ...base, to, amount: amount.toString(), maxFee: '20000000000000000000000', x: { nonce: nonce.toString(), blockHash: base58.encode(block) } };
        return toHex(buildNearTx(i, net).tx) === toHex(encodeTransaction(sdkTx(i)));
      }), { numRuns: 300 });
  });
  it('known layout: signer, key, nonce, receiver, block hash, one Transfer', () => {
    const b = buildNearTx(base, net);
    const le = (v: bigint, bytes: number) => Array.from({ length: bytes }, (_, k) => Number((v >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, '0')).join('');
    const hex = le(64n, 4) + Buffer.from(FROM).toString('hex') + '00' + FROM + le(223991684000002n, 8) + le(10n, 4) + Buffer.from('alice.near').toString('hex')
      + toHex(base58.decode(BLOCK)) + le(1n, 4) + '03' + le(1250000000000000000000001n, 16);
    expect(hex.length / 2).toBe(4 + 64 + 33 + 8 + 4 + 10 + 32 + 4 + 17);
    expect(toHex(b.tx)).toBe(hex);
    expect(b.describe).toMatchObject({ from: FROM, to: 'alice.near', amountYocto: base.amount, nonce: '223991684000002', blockHash: BLOCK, feeCeilingYocto: '2000000000000000000000', txid: b.txid });
  });
});

describe('near: signing', () => {
  for (const [name, i] of [['named', base], ['implicit', toImplicit()]] as const) it(`signs sha256(borsh tx); the SDK decodes the result and verifies the signature (${name})`, () => {
    const s = nearPlugin.sign(i, net, key), raw = Buffer.from(s.raw, 'base64');
    const d = decodeSignedTransaction(raw) as any; // borsh-deserialized plain fields
    expect(toHex(encodeTransaction(d.transaction))).toBe(toHex(encodeTransaction(sdkTx(i))));
    const hash = sha256(encodeTransaction(d.transaction));
    expect(s.txid).toBe(base58.encode(hash));
    expect(Object.keys(d.signature)).toEqual(['ed25519Signature']);
    const sig = Uint8Array.from(d.signature.ed25519Signature.data);
    const sdkKey = PublicKey.fromString('ed25519:' + base58.encode(Uint8Array.from(d.transaction.publicKey.ed25519Key.data)));
    expect(sdkKey.toString()).toBe(parseSeedPhrase(MNEMONIC).publicKey);
    expect(sdkKey.verify(hash, sig)).toBe(true); // @near-js/crypto
    expect(ed25519.verify(sig, hash, PUB)).toBe(true); // noble
    expect(sdkKey.verify(sha256(Uint8Array.from([...hash, 1])), sig)).toBe(false);
    // the SDK serializes the same signed transaction to the same bytes
    const sdkSigned = new SignedTransaction({ transaction: sdkTx(i), signature: new Signature({ keyType: KeyType.ED25519, data: sig }) });
    expect(toHex(sdkSigned.encode())).toBe(toHex(raw));
    expect(raw.length).toBe(encodeTransaction(sdkTx(i)).length + 65);
    expect(nearSignedTxInfo(s.raw)).toEqual({ txid: s.txid, signerId: FROM });
    expect(nearPlugin.sign(i, net, key)).toEqual(s); // deterministic
  });
  it('refuses a key that does not control the source account, or of the wrong kind', () => {
    const otherPriv = slip10(SEED, "m/44'/397'/1'");
    const other: KeyHandle = { curve: 'ed25519', publicKey: ed25519.getPublicKey(otherPriv), signMessage: (m) => ed25519.sign(m, otherPriv) };
    expect(() => nearPlugin.sign(base, net, other)).toThrow(/does not control/);
    expect(() => nearPlugin.sign(base, net, { curve: 'secp256k1', publicKey: new Uint8Array(33) })).toThrow(/ed25519/);
    expect(() => nearPlugin.sign(base, net, { curve: 'ed25519', publicKey: PUB })).toThrow(/ed25519/);
    expect(() => nearPlugin.sign(base, net, { ...key, signMessage: () => new Uint8Array(64) })).toThrow(/self-check/);
    expect(() => nearPlugin.sign(base, net, { ...key, signMessage: (m) => ed25519.sign(m, otherPriv) })).toThrow(/self-check/);
  });
  it('nearSignedTxInfo refuses anything that is not a signed transaction of this wallet', () => {
    const raw = Buffer.from(nearPlugin.sign(base, net, key).raw, 'base64');
    const flip = (k: number) => { const c = Buffer.from(raw); c[k]! ^= 1; return c.toString('base64'); };
    for (const bad of ['', 'not base64!', raw.subarray(0, 100).toString('base64'), flip(0), flip(10), flip(68), flip(80), flip(raw.length - 65)]) expect(() => nearSignedTxInfo(bad), bad.slice(0, 20)).toThrow();
    expect(nearSignedTxInfo(flip(120)).txid).not.toBe(nearSignedTxInfo(raw.toString('base64')).txid);
  });
});

describe('near: fail closed', () => {
  const bad: [string, Intent, RegExp][] = [
    ['wrong chain reference', { ...base, chainRef: 'FWJ9kR6KFWoyMoNjpLXXGHeuiy7tEY6GmoFeCA5yuc6b' }, /chain identity/], // testnet genesis
    ['another network id', { ...base, network: 'stellar' }, /not a NEAR intent/],
    ['unsupported intent version', { ...base, v: 2 as never }, /version/],
    ['a token instead of the native coin', { ...base, asset: 'usdt.tether-token.near' }, /only native NEAR/],
    ['wrong symbol', { ...base, symbol: 'NEAT' }, /metadata/],
    ['wrong decimals', { ...base, decimals: 18 }, /metadata/],
    ['amount zero', { ...base, amount: '0' }, /positive/],
    ['amount negative', { ...base, amount: '-1' }, /invalid base-unit/],
    ['amount with a fraction', { ...base, amount: '1.5' }, /invalid base-unit/],
    ['amount above u128', { ...base, amount: (1n << 128n).toString() }, /out of range/],
    ['destination equals source', { ...base, to: FROM, maxFee: '20000000000000000000000' }, /equals source/],
    ['destination in upper case', { ...base, to: 'Alice.near' }, /upper-case/],
    ['implicit destination in upper case', toImplicit({ to: OTHER.toUpperCase() }), /upper-case/],
    ['destination with a space', { ...base, to: 'alice.near ' }, /invalid NEAR account id/],
    ['Ethereum-style destination', { ...base, to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' }, /not supported/],
    ['reserved destination', { ...base, to: 'system' }, /reserved/],
    ['too short destination', { ...base, to: 'a' }, /2 to 64/],
    ['source is a named account', { ...base, from: 'x'.repeat(20) + '.near' }, /source is not an implicit/],
    ['source in upper case', { ...base, from: FROM.toUpperCase() }, /upper-case/],
    ['fee ceiling above maxFee (named)', { ...base, maxFee: '1999999999999999999999' }, /fee above approved maximum/],
    ['fee ceiling above maxFee (implicit destination costs more)', toImplicit({ maxFee: '19999999999999999999999' }), /fee above approved maximum/],
    ['implicit destination with the named ceiling', { ...base, to: OTHER }, /fee above approved maximum/],
    ['maxFee zero', { ...base, maxFee: '0' }, /fee above approved maximum/],
    ['a memo', { ...base, memo: 'hello' }, /memo/],
    ['unknown x key', withX({ gas: '1' }), /unknown or missing/],
    ['action smuggled in x', withX({ action: 'FunctionCall' }), /unknown or missing/],
    ['missing nonce', { ...base, x: { blockHash: BLOCK } }, /unknown or missing/],
    ['missing block hash', { ...base, x: { nonce: '5' } }, /unknown or missing/],
    ['no x section', (() => { const { x: _x, ...r } = base; return r as Intent; })(), /missing NEAR parameters/],
    ['foreign chain section', { ...base, sol: { recentBlockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N', lastValidBlockHeight: 1, createAta: false, computeUnitLimit: 1, computeUnitPrice: '0' } }, /unexpected chain section/],
    ['nonce zero', withX({ nonce: '0' }), /canonical/],
    ['nonce with a leading zero', withX({ nonce: '05' }), /canonical/],
    ['nonce in hex', withX({ nonce: '0x10' }), /canonical/],
    ['nonce above u64', withX({ nonce: (1n << 64n).toString() }), /out of range/],
    ['block hash too short', withX({ blockHash: BLOCK.slice(0, 30) }), /invalid NEAR hash/],
    ['block hash of 31 bytes', withX({ blockHash: base58.encode(new Uint8Array(31).fill(7)) }), /invalid NEAR hash/],
    ['block hash of 33 bytes', withX({ blockHash: base58.encode(new Uint8Array(33).fill(7)) }), /invalid NEAR hash/],
    ['block hash with a non-base58 character', withX({ blockHash: BLOCK.slice(0, -1) + '0' }), /invalid NEAR hash/],
    ['block hash in hex', withX({ blockHash: 'ab'.repeat(32) }), /invalid NEAR hash/],
    ['empty block hash', withX({ blockHash: '' }), /invalid NEAR hash/],
  ];
  for (const [name, i, re] of bad) it(name, () => {
    expect(() => nearPlugin.build(i, net)).toThrow(re);
    expect(() => nearPlugin.sign(i, net, key)).toThrow(re);
  });
  it('refuses a network definition that is not the pinned mainnet', () => {
    const testnet = 'FWJ9kR6KFWoyMoNjpLXXGHeuiy7tEY6GmoFeCA5yuc6b';
    expect(() => nearPlugin.build({ ...base, chainRef: testnet }, { ...net, chainRef: testnet })).toThrow(/only mainnet/);
    expect(() => nearPlugin.build(base, { ...net, family: 'evm' })).toThrow(/not a NEAR intent/);
    expect(() => nearPlugin.build({ ...base, symbol: 'ABC' }, { ...net, native: { ...net.native, symbol: 'ABC', id: 'ABC' } })).toThrow(/native/);
  });
  it('hash decoding is canonical', () => {
    expect(toHex(nearDecodeHash(BLOCK))).toBe(toHex(base58.decode(BLOCK)));
    expect(nearDecodeHash('1'.repeat(32)).every((b) => b === 0)).toBe(true);
    for (const h of ['1' + BLOCK, BLOCK + '1', ' ' + BLOCK, BLOCK + ' ', BLOCK.replace('b', 'l')]) expect(() => nearDecodeHash(h)).toThrow();
  });
  it('the intent schema and hash accept the NEAR section (short named destinations included) and bind every field', () => {
    expect(() => canonicalBytes(base)).not.toThrow();
    expect(() => canonicalBytes({ ...base, to: 'aa' })).not.toThrow();
    expect(IntentSchema.safeParse({ ...base, to: 'a' }).success).toBe(false);
    expect(IntentSchema.safeParse({ ...base, from: 'alice.near' }).success).toBe(false); // a source is never this short
    expect(() => canonicalBytes((() => { const { x: _x, ...r } = base; return r as Intent; })())).toThrow(/does not match network/);
    expect(() => canonicalBytes({ ...base, x: { ...base.x!, 'bad key': '1' } })).toThrow();
  });
  it('changing any intent field changes the signed bytes or throws', () => {
    const ref = toHex(nearPlugin.build(base, net).signDocs[0]!);
    const txMuts: Intent[] = [
      { ...base, amount: '1250000000000000000000002' }, { ...base, amount: '1250000000000000000000000' }, { ...base, to: 'alice.neas' }, { ...base, to: 'alice.near.near' },
      { ...base, to: OTHER, maxFee: '20000000000000000000000' }, { ...base, from: OTHER },
      withX({ nonce: '223991684000003' }), withX({ blockHash: 'Gi1nwG4WGSBuQi6eqRsim7CynVKj4w3hfy1uQS5fw9bB' }),
    ];
    const seen = new Set([ref]);
    for (const m of txMuts) seen.add(toHex(nearPlugin.build(m, net).signDocs[0]!));
    expect(seen.size).toBe(txMuts.length + 1);
    // fields that are not part of the NEAR transaction either throw or leave it unchanged, and always change the approved intent hash
    const other: Intent[] = [
      { ...base, chainRef: 'FWJ9kR6KFWoyMoNjpLXXGHeuiy7tEY6GmoFeCA5yuc6b' }, { ...base, network: 'solana' }, { ...base, asset: 'other' }, { ...base, symbol: 'NEAT' }, { ...base, decimals: 8 },
      { ...base, maxFee: '1999999999999999999999' }, { ...base, memo: 'x' }, { ...base, v: 2 as never },
      { ...base, maxFee: '2000000000000000000001' }, { ...base, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a12' }, { ...base, keyId: 'spw-0123456789abcdee' }, { ...base, policyVersion: 5 },
      { ...base, createdAt: now + 1 }, { ...base, expiresAt: now + 121 },
    ];
    const h0 = toHex(intentHash(base));
    other.forEach((m, k) => {
      let out: string | null = null;
      try { out = toHex(nearPlugin.build(m, net).signDocs[0]!); } catch { /* refused */ }
      if (k < 8) expect(out, `mutation ${k}`).toBeNull(); else expect(out).toBe(ref);
      let h: string | null = null;
      try { h = toHex(intentHash(m)); } catch { /* refused by the schema */ }
      expect(h).not.toBe(h0);
    });
    for (const m of txMuts) expect(toHex(intentHash(m))).not.toBe(h0);
  });
});
