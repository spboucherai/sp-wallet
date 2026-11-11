// XRP Ledger plugin, proven against the official SDK (xrpl.js 5.3.0 = ripple-binary-codec + ripple-address-codec + ripple-keypairs).
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { classicAddressToXAddress, decode, encode, encodeForSigning, hashes, isValidClassicAddress, verifySignature, Wallet } from 'xrpl';
import {
  canonicalBytes, DEFAULT_POLICY, intentHash, isValidAddress, NETWORKS, normalizeAddress, pluginFor, sha512Half, toHex,
  xrplAddressFromPublicKey, xrplPlugin, xrplSigningBytes, xrplTxid, type Intent, type KeyHandle,
} from '../src/index.ts';

// Public BIP-39 test vector mnemonic — holds no funds of ours, never used outside tests.
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
/** Address of that mnemonic at m/44'/144'/0'/0/0 as published by the usual BIP-44 tools (and present on the main ledger). */
const VECTOR_ADDRESS = 'rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3';
const net = NETWORKS.xrpl;
const wallet = Wallet.fromMnemonic(TEST_MNEMONIC, { derivationPath: xrplPlugin.path(net) });
const pub = Uint8Array.from(Buffer.from(wallet.publicKey, 'hex'));
const priv = Uint8Array.from(Buffer.from(wallet.privateKey, 'hex')).slice(-32); // xrpl.js prefixes secp256k1 keys with 00
/** Same shape as the signer's key handle (services/isolated-signer/src/keys.ts). */
const key: KeyHandle = { curve: 'secp256k1', publicKey: pub, signDigest: (digest) => {
  const sig = secp256k1.sign(digest, priv, { prehash: false, lowS: true, format: 'recovered' });
  const compact = sig.slice(1);
  return { compact, recovery: sig[0]!, der: secp256k1.Signature.fromBytes(compact, 'compact').toBytes('der') };
} };
const DEST = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', DEST2 = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
const now = 1_800_000_000;
const base: Intent = { v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-0123456789abcdef', createdAt: now, expiresAt: now + 45, policyVersion: 2,
  network: 'xrpl', chainRef: net.chainRef, asset: 'native', symbol: 'XRP', decimals: 6, amount: '2500000', from: VECTOR_ADDRESS, to: DEST, maxFee: '12',
  x: { sequence: '210', lastLedgerSequence: '108249099', fee: '12' } };
const withTag: Intent = { ...base, memo: '4294967295' };
const HEX = (b: Uint8Array) => toHex(b).toUpperCase();

/** The same payment as xrpl.js sees it. */
function sdkTx(i: Intent, signingPubKey = wallet.publicKey) {
  return { TransactionType: 'Payment' as const, Account: i.from, Destination: i.to, Amount: i.amount, Fee: i.x!.fee!, Flags: 0x80000000,
    Sequence: Number(i.x!.sequence), LastLedgerSequence: Number(i.x!.lastLedgerSequence), SigningPubKey: signingPubKey,
    ...(i.memo !== undefined ? { DestinationTag: Number(i.memo) } : {}) };
}

describe('xrpl: registration', () => {
  it('is registered as a plugin family with the pinned network definition and policy', () => {
    expect(pluginFor(net)).toBe(xrplPlugin);
    expect(net).toMatchObject({ id: 'xrpl', family: 'xrpl', name: 'XRP Ledger', coinType: 144, memo: 'uint32', activation: '1' });
    expect(net.native).toEqual({ id: 'native', symbol: 'XRP', name: 'XRP', decimals: 6 });
    expect(net.rpc.length).toBe(2);
    expect(new Set(net.rpc.map((u) => new URL(u).host.split('.').slice(-2).join('.'))).size).toBe(2);
    expect(DEFAULT_POLICY.perTx['xrpl:XRP']).toBe('47000000');
    expect(DEFAULT_POLICY.daily['xrpl:XRP']).toBe('94000000');
    expect(DEFAULT_POLICY.maxFee.xrpl).toBe('100000');
  });
});

describe('xrpl: keys and addresses', () => {
  it("derives m/44'/144'/0'/0/0 of the public test mnemonic to the published address (and to what xrpl.js derives)", () => {
    expect(xrplPlugin.curve).toBe('secp256k1');
    expect(xrplPlugin.path(net)).toBe("m/44'/144'/0'/0/0");
    expect(xrplPlugin.address(net, pub)).toBe(VECTOR_ADDRESS);
    expect(wallet.classicAddress).toBe(VECTOR_ADDRESS);
    expect(xrplAddressFromPublicKey(pub)).toBe(VECTOR_ADDRESS);
  });
  it('matches xrpl.js for random keys (property)', () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (seed) => {
      fc.pre(secp256k1.utils.isValidSecretKey(seed));
      const pk = secp256k1.getPublicKey(seed, true);
      const w = new Wallet(HEX(pk), '00' + HEX(seed));
      return xrplPlugin.address(net, pk) === w.classicAddress && isValidClassicAddress(xrplPlugin.address(net, pk));
    }), { numRuns: 40 });
  });
  it('accepts canonical classic addresses only', () => {
    expect(normalizeAddress('xrpl', DEST)).toBe(DEST);
    expect(normalizeAddress('xrpl', ` ${DEST} `)).toBe(DEST); // the shared entry point trims
    expect(xrplPlugin.normalizeAddress(net, VECTOR_ADDRESS)).toBe(VECTOR_ADDRESS);
    expect(() => xrplPlugin.normalizeAddress(net, ` ${DEST}`)).toThrow();
    const x = classicAddressToXAddress(DEST, 12345, false), xNoTag = classicAddressToXAddress(DEST, false, false);
    expect(() => normalizeAddress('xrpl', x)).toThrow(/X-addresses are not supported/);
    expect(() => normalizeAddress('xrpl', xNoTag)).toThrow(/X-addresses are not supported/);
    expect(() => normalizeAddress('xrpl', classicAddressToXAddress(DEST, false, true))).toThrow(/X-addresses/); // testnet form
    expect(() => normalizeAddress('xrpl', DEST.slice(0, -1) + (DEST.endsWith('e') ? 'f' : 'e'))).toThrow(/checksum|invalid/);
    expect(() => normalizeAddress('xrpl', DEST.toLowerCase())).toThrow();
    expect(() => normalizeAddress('xrpl', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toThrow();
    expect(() => normalizeAddress('xrpl', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toThrow(); // Bitcoin base58 alphabet / version
    expect(() => normalizeAddress('xrpl', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8')).toThrow();
    expect(() => normalizeAddress('xrpl', 'sEdTM1uX8pu2do5XvTnutH6HsouMaM2')).toThrow(); // a seed is not an address
    expect(() => normalizeAddress('xrpl', '')).toThrow();
    expect(isValidAddress('xrpl', DEST2)).toBe(true);
    expect(() => normalizeAddress('bitcoin', DEST)).toThrow();
  });
});

describe('xrpl: transaction bytes against the official codec', () => {
  it('signing bytes = STX prefix + ripple-binary-codec encodeForSigning (with and without destination tag)', () => {
    for (const i of [base, withTag, { ...base, memo: '0' }]) {
      const mine = xrplSigningBytes(i, net, pub);
      expect(HEX(mine)).toBe(encodeForSigning(sdkTx(i)));
      expect(HEX(mine).startsWith('53545800')).toBe(true);
      // build() with the (verified) public key returns exactly those bytes
      expect(HEX(xrplPlugin.build(i, net, { signingPubKey: wallet.publicKey }).signDocs[0]!)).toBe(HEX(mine));
      // build() without the key: same transaction, empty SigningPubKey
      expect(HEX(xrplPlugin.build(i, net).signDocs[0]!)).toBe(encodeForSigning(sdkTx(i, '')));
    }
  });
  it('the signed blob is byte-identical to xrpl.js Wallet.sign, decodes to the intent fields, and the signature verifies', () => {
    for (const i of [base, withTag, { ...base, memo: '0' }, { ...base, amount: '99999999999999999', maxFee: '100000', x: { sequence: '4294967295', lastLedgerSequence: '4294967295', fee: '100000' } }]) {
      const mine = xrplPlugin.sign(i, net, key);
      const sdk = wallet.sign(sdkTx(i));
      expect(mine.raw).toBe(sdk.tx_blob);
      expect(mine.txid).toBe(sdk.hash);
      expect(mine.txid).toBe(hashes.hashSignedTx(mine.raw));
      expect(xrplTxid(mine.raw.toLowerCase())).toBe(mine.txid);
      expect(encode(decode(mine.raw) as never)).toBe(mine.raw); // canonical for the official codec
      const d = decode(mine.raw) as Record<string, unknown>;
      const { TxnSignature, ...rest } = d;
      expect(rest).toEqual(sdkTx(i));
      expect(Object.keys(d).sort()).toEqual(['Account', 'Amount', 'Destination', ...(i.memo !== undefined ? ['DestinationTag'] : []), 'Fee', 'Flags', 'LastLedgerSequence', 'Sequence', 'SigningPubKey', 'TransactionType', 'TxnSignature'].sort());
      expect(verifySignature(mine.raw)).toBe(true); // official SDK
      const digest = sha512Half(xrplSigningBytes(i, net, pub));
      expect(secp256k1.verify(Uint8Array.from(Buffer.from(String(TxnSignature), 'hex')), digest, pub, { prehash: false, format: 'der', lowS: true })).toBe(true); // noble
    }
  });
  it('matches the official codec for arbitrary payments (property)', () => {
    const u32 = fc.integer({ min: 1, max: 0xffffffff });
    fc.assert(fc.property(fc.bigInt({ min: 1n, max: 100_000_000_000_000_000n }), fc.bigInt({ min: 1n, max: 1_000_000n }), u32, u32,
      fc.option(fc.integer({ min: 0, max: 0xffffffff }), { nil: undefined }), fc.uint8Array({ minLength: 20, maxLength: 20 }), (amount, fee, seq, lls, tag, destId) => {
        fc.pre(destId.some((b, k) => (k < 19 ? b !== 0 : b > 1)));
        const to = xrplAddressFromPublicKeyHash(destId);
        const i: Intent = { ...base, amount: amount.toString(), to, maxFee: fee.toString(), x: { sequence: String(seq), lastLedgerSequence: String(lls), fee: fee.toString() }, ...(tag !== undefined ? { memo: String(tag) } : {}) };
        const s = xrplPlugin.sign(i, net, key);
        return HEX(xrplSigningBytes(i, net, pub)) === encodeForSigning(sdkTx(i)) && s.raw === wallet.sign(sdkTx(i)).tx_blob && verifySignature(s.raw);
      }), { numRuns: 60 });
  });
  it('is deterministic and the intent hash covers the chain parameters and the tag', () => {
    expect(xrplPlugin.sign(base, net, key)).toEqual(xrplPlugin.sign(base, net, key));
    const h = toHex(intentHash(base));
    for (const m of [{ memo: '1' }, { x: { ...base.x!, sequence: '211' } }, { x: { ...base.x!, lastLedgerSequence: '108249100' } }, { x: { ...base.x!, fee: '11' } }, { amount: '2500001' }, { to: DEST2 }])
      expect(toHex(intentHash({ ...base, ...m }))).not.toBe(h);
    expect(canonicalBytes(base).length).toBeGreaterThan(0);
    expect(() => canonicalBytes({ ...base, x: undefined })).toThrow(/chain section/);
  });
});

/** classic address of a raw account id, through the official address codec */
function xrplAddressFromPublicKeyHash(id: Uint8Array): string {
  const blob = '1200002280000000240000000161400000000000000168400000000000000A73008114' + HEX(id) + '8314' + HEX(id);
  return String((decode(blob) as { Account: string }).Account);
}

describe('xrpl: fail closed', () => {
  const bad = (m: Partial<Intent>, aux?: Record<string, unknown>) => () => xrplPlugin.build({ ...base, ...m }, net, aux);
  it('refuses another chain, another family, foreign sections', () => {
    expect(bad({ chainRef: NETWORKS.bitcoin.chainRef })).toThrow(/wrong chain/);
    expect(bad({ chainRef: net.chainRef.toLowerCase() })).toThrow(/wrong chain/);
    expect(bad({ network: 'solana' })).toThrow(/not for this/);
    expect(() => xrplPlugin.build(base, NETWORKS.bitcoin)).toThrow(/not for this/);
    expect(() => xrplPlugin.build(base, { ...net, chainRef: 'AB'.repeat(32) })).toThrow(/wrong chain/);
    expect(bad({ evm: { nonce: 0, gasLimit: '21000', maxFeePerGas: '1', maxPriorityFeePerGas: '1' } })).toThrow(/foreign/);
    expect(bad({ btc: { inputs: [{ txid: 'aa'.repeat(32), vout: 0, value: '1' }], change: '0', fee: '1' } })).toThrow(/foreign/);
  });
  it('refuses anything but native XRP', () => {
    expect(bad({ asset: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' })).toThrow(/only native XRP/); // an issuer account (issued currency)
    expect(bad({ asset: 'USD' })).toThrow(/only native XRP/);
    expect(bad({ symbol: 'RLUSD' })).toThrow(/only native XRP/);
    expect(bad({ decimals: 8 })).toThrow(/only native XRP/);
  });
  it('refuses invalid, non-normalized, X- and black-hole addresses and a self-send', () => {
    expect(bad({ to: classicAddressToXAddress(DEST, 7, false) })).toThrow(/X-addresses/);
    expect(bad({ to: ` ${DEST}` })).toThrow(/invalid/);
    expect(bad({ to: DEST.slice(0, -1) + 'z' })).toThrow();
    expect(bad({ from: DEST.slice(0, -2) + 'zz' })).toThrow();
    expect(bad({ to: VECTOR_ADDRESS })).toThrow(/destination equals source/);
    expect(bad({ to: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp' })).toThrow(/black-hole/); // ACCOUNT_ZERO
    expect(bad({ to: 'rrrrrrrrrrrrrrrrrrrrBZbvji' })).toThrow(/black-hole/); // ACCOUNT_ONE
    expect(bad({ to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' })).toThrow();
  });
  it('refuses bad amounts and fees', () => {
    expect(bad({ amount: '0' })).toThrow(/amount must be positive/);
    expect(bad({ amount: '100000000000000001' })).toThrow(/out of range/);
    expect(bad({ amount: '-1' })).toThrow();
    expect(bad({ amount: '1.5' })).toThrow();
    expect(bad({ maxFee: '11' })).toThrow(/fee above the approved maximum/);
    expect(bad({ x: { ...base.x!, fee: '0' } })).toThrow(/fee must be positive/);
    expect(bad({ x: { ...base.x!, fee: '012' } })).toThrow();
    expect(bad({ maxFee: '1000001', x: { ...base.x!, fee: '1000001' } })).toThrow(/absolute/);
  });
  it('refuses unknown, missing or malformed chain parameters and tags', () => {
    expect(bad({ x: undefined })).toThrow(/missing/);
    expect(bad({ x: { ...base.x!, flags: '131072' } })).toThrow(/unknown or missing/); // e.g. an attempt at tfPartialPayment
    expect(bad({ x: { ...base.x!, sendMax: '1' } })).toThrow(/unknown or missing/);
    expect(bad({ x: { sequence: '210', fee: '12' } })).toThrow(/unknown or missing/);
    expect(bad({ x: { sequence: '210', lastLedgerSequence: '108249099', Fee: '12' } })).toThrow(/unknown or missing/);
    for (const v of ['0', '-1', '4294967296', '1e3', '0x10', '', ' 5', '05']) {
      expect(bad({ x: { ...base.x!, sequence: v } }), `sequence ${v}`).toThrow();
      expect(bad({ x: { ...base.x!, lastLedgerSequence: v } }), `lastLedgerSequence ${v}`).toThrow();
    }
    for (const v of ['-1', '4294967296', 'abc', '', '01', '1.0', ' 1', '12345678901']) expect(bad({ memo: v }), `tag ${v}`).toThrow(/destination tag/);
  });
  it('accepts helper data only when it is the matching public key', () => {
    expect(bad({}, { signingPubKey: wallet.publicKey })).not.toThrow();
    expect(bad({}, {})).not.toThrow();
    expect(bad({}, { prevTx: {} })).toThrow(/unknown helper/);
    expect(bad({}, { signingPubKey: wallet.publicKey, extra: 1 })).toThrow(/unknown helper/);
    expect(bad({}, { signingPubKey: 'zz' })).toThrow(/unknown helper/);
    expect(bad({}, { signingPubKey: HEX(secp256k1.getPublicKey(new Uint8Array(32).fill(7), true)) })).toThrow(/does not match/);
  });
  it('sign() refuses a key that is not the source account, a wrong curve, and a bad signature from the key module', () => {
    const otherPriv = new Uint8Array(32).fill(7);
    const other: KeyHandle = { ...key, publicKey: secp256k1.getPublicKey(otherPriv, true) };
    expect(() => xrplPlugin.sign(base, net, other)).toThrow(/not controlled/);
    expect(() => xrplPlugin.sign(base, net, { curve: 'ed25519', publicKey: pub.slice(1), signMessage: () => new Uint8Array(64) })).toThrow(/secp256k1/);
    expect(() => xrplPlugin.sign(base, net, { ...key, signDigest: undefined })).toThrow(/secp256k1/);
    const wrongKeySigner: KeyHandle = { ...key, signDigest: (d) => { // signs with another private key
      const sig = secp256k1.sign(d, otherPriv, { prehash: false, lowS: true, format: 'recovered' }); const compact = sig.slice(1);
      return { compact, recovery: sig[0]!, der: secp256k1.Signature.fromBytes(compact, 'compact').toBytes('der') }; } };
    expect(() => xrplPlugin.sign(base, net, wrongKeySigner)).toThrow(/self-check/);
    const highS: KeyHandle = { ...key, signDigest: (d) => { // non-canonical (high-S) signature
      const s = secp256k1.Signature.fromBytes(key.signDigest!(d).compact, 'compact');
      const flipped = new secp256k1.Signature(s.r, secp256k1.Point.CURVE().n - s.s);
      return { compact: flipped.toBytes('compact'), recovery: 0, der: flipped.toBytes('der') }; } };
    expect(() => xrplPlugin.sign(base, net, highS)).toThrow(/self-check/);
    expect(() => xrplPlugin.sign({ ...base, amount: '0' }, net, key)).toThrow(/positive/);
    expect(() => xrplPlugin.sign({ ...base, maxFee: '1' }, net, key)).toThrow(/approved maximum/);
  });
  it('changing any intent field changes the signed bytes or throws', () => {
    const ref = xrplPlugin.sign(base, net, key);
    const changes: Partial<Intent>[] = [{ amount: '2500001' }, { to: DEST2 }, { memo: '7' }, { x: { ...base.x!, sequence: '211' } },
      { x: { ...base.x!, lastLedgerSequence: '108249100' } }, { maxFee: '13', x: { ...base.x!, fee: '13' } }];
    const seen = new Set([ref.raw]);
    for (const c of changes) {
      const r = xrplPlugin.sign({ ...base, ...c }, net, key);
      expect(seen.has(r.raw), JSON.stringify(c)).toBe(false);
      expect(r.txid).not.toBe(ref.txid);
      seen.add(r.raw);
    }
    for (const c of [{ from: DEST2 }, { chainRef: '1' }, { asset: 'USD' }, { symbol: 'XLM' }, { decimals: 7 }, { network: 'bitcoin' }, { maxFee: '11' }] as Partial<Intent>[])
      expect(() => xrplPlugin.sign({ ...base, ...c }, net, key), JSON.stringify(c)).toThrow();
    // fields that are not part of the ledger transaction are still bound by the approval (intent hash)
    for (const c of [{ proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a12' }, { keyId: 'spw-fedcba9876543210' }, { expiresAt: now + 46 }, { createdAt: now + 1 }, { policyVersion: 3 }, { maxFee: '13' }] as Partial<Intent>[])
      expect(toHex(intentHash({ ...base, ...c }))).not.toBe(toHex(intentHash(base)));
  });
});
