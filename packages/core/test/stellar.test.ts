import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { Account, Asset, Keypair, Memo, MuxedAccount, Networks, Operation, StrKey, TransactionBuilder, type Transaction } from '@stellar/stellar-base';
import {
  buildStellarTx, canonicalBytes, DEFAULT_POLICY, formatUnits, intentHash, isValidAddress, NETWORKS, normalizeAddress, pluginFor,
  STELLAR_PUBNET_PASSPHRASE, stellarDecodeAccount, stellarEncodeAccount, stellarEnvelopeTxid, stellarMemoType, stellarPlugin, toHex,
  type Intent, type KeyHandle, type NetworkDef,
} from '../src/index.ts';

const net = NETWORKS.stellar as NetworkDef;
const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));

// SEP-0005 "Test 5": BIP-39 seed of the public mnemonic `abandon ×11 about` (empty passphrase) and its published Stellar accounts.
// https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0005.md
const SEP5_SEED = hexToBytes('5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4');
const SEP5 = [
  ["m/44'/148'/0'", 'GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX', 'SBUV3MRWKNS6AYKZ6E6MOUVF2OYMON3MIUASWL3JLY5E3ISDJFELYBRZ'],
  ["m/44'/148'/1'", 'GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV', 'SCHDCVCWGAKGIMTORV6K5DYYV3BY4WG3RA4M6MCBGJLHUCWU2MC6DL66'],
  ["m/44'/148'/2'", 'GBFPWBTN4AXHPWPTQVQBP4KRZ2YVYYOGRMV2PEYL2OBPPJDP7LECEVHR', 'SAPLVTLUXSDLFRDGCCFLPDZMTCEVMP3ZXTM74EBJCVKZKM34LGQPF7K3'],
] as const;

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
const PRIV = slip10(SEP5_SEED, stellarPlugin.path(net));
const PUB = ed25519.getPublicKey(PRIV);
const FROM = SEP5[0][1], TO = SEP5[1][1];
const key: KeyHandle = { curve: 'ed25519', publicKey: PUB, signMessage: (m) => ed25519.sign(m, PRIV) };

const now = 1_800_000_000;
const base: Intent = {
  v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-0123456789abcdef', createdAt: now, expiresAt: now + 120, policyVersion: 4,
  network: 'stellar', chainRef: STELLAR_PUBNET_PASSPHRASE, asset: 'native', symbol: 'XLM', decimals: 7, amount: '125000000', from: FROM, to: TO, maxFee: '20000',
  x: { op: 'payment', sequence: '2390162185806736', fee: '10112', maxTime: String(now + 180), memoType: 'none' },
};
const withX = (x: Record<string, string>, over: Partial<Intent> = {}): Intent => ({ ...base, ...over, x: { ...base.x!, ...x } });

/** The same transaction built by the official SDK from the same fields. */
function sdkTx(i: Intent): Transaction {
  const x = i.x!;
  const b = new TransactionBuilder(new Account(i.from, (BigInt(x.sequence!) - 1n).toString()), {
    fee: x.fee!, networkPassphrase: Networks.PUBLIC, timebounds: { minTime: 0, maxTime: x.maxTime! },
    memo: x.memoType === 'text' ? Memo.text(i.memo!) : x.memoType === 'id' ? Memo.id(i.memo!) : Memo.none(),
  });
  const amount = formatUnits(BigInt(i.amount), 7);
  b.addOperation(x.op === 'payment' ? Operation.payment({ destination: i.to, asset: Asset.native(), amount }) : Operation.createAccount({ destination: i.to, startingBalance: amount }));
  return b.build();
}
const sdkTxBytes = (t: Transaction) => new Uint8Array(t.toEnvelope().v1().tx().toXDR());

describe('stellar: registration', () => {
  it('is registered with the pinned identity, derivation, limits and two sources', () => {
    expect(pluginFor(net)).toBe(stellarPlugin);
    expect(net.chainRef).toBe(Networks.PUBLIC);
    expect(toHex(sha256(new TextEncoder().encode(net.chainRef)))).toBe('7ac33997544e3175d266bd022439b22cdb16508c01163f26e5cb2a3e1045a979'); // pubnet network id
    expect([net.family, net.coinType, net.memo, net.activation, net.native.decimals]).toEqual(['stellar', 148, 'text', '1', 7]);
    expect(stellarPlugin.path(net)).toBe("m/44'/148'/0'");
    expect(() => stellarPlugin.path({ ...net, coinType: 501 })).toThrow();
    expect(new Set(net.rpc.map((u) => new URL(u).host)).size).toBe(2);
    expect(DEFAULT_POLICY.perTx['stellar:XLM']).toBe('3500000000');
    expect(DEFAULT_POLICY.maxFee.stellar).toBe('1000000');
  });
});

describe('stellar: keys and addresses', () => {
  it('derives the SEP-0005 published accounts for the public test mnemonic', () => {
    for (const [path, address, secret] of SEP5) {
      const priv = slip10(SEP5_SEED, path);
      expect(toHex(priv)).toBe(Keypair.fromSecret(secret).rawSecretKey().toString('hex'));
      expect(stellarPlugin.address(net, ed25519.getPublicKey(priv))).toBe(address);
    }
    expect(stellarPlugin.address(net, PUB)).toBe('GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX');
  });
  it('encodes and decodes like the official SDK (property)', () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (k) => {
      const a = stellarEncodeAccount(k);
      return a === StrKey.encodeEd25519PublicKey(Buffer.from(k)) && toHex(stellarDecodeAccount(a)) === toHex(k) && normalizeAddress('stellar', a) === a;
    }));
  });
  it('refuses everything that is not a canonical G… account id', () => {
    const muxed = new MuxedAccount(new Account(TO, '0'), '42').accountId();
    expect(muxed).toMatch(/^M/);
    expect(() => normalizeAddress('stellar', muxed)).toThrow(/muxed/);
    const bad = [
      TO.toLowerCase(), TO.slice(0, -1), TO + 'A', TO.slice(0, -1) + (TO.endsWith('A') ? 'B' : 'A'), 'X' + TO.slice(1), TO.replace('G', 'g'), ` ${TO}`.slice(0, 56),
      SEP5[1][2], // a secret seed is not an address
      StrKey.encodeContract(Buffer.alloc(32, 7)), StrKey.encodePreAuthTx(Buffer.alloc(32, 7)), StrKey.encodeSha256Hash(Buffer.alloc(32, 7)),
      '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', '',
    ];
    for (const a of bad) expect(isValidAddress('stellar', a), a).toBe(false);
    // every single-character substitution breaks the checksum
    for (let k = 1; k < 56; k += 5) { const c = TO[k] === 'A' ? 'B' : 'A'; expect(isValidAddress('stellar', TO.slice(0, k) + c + TO.slice(k + 1))).toBe(false); }
    expect(normalizeAddress('stellar', `  ${TO} `)).toBe(TO); // the shared entry point trims surrounding whitespace only
  });
});

describe('stellar: memo rule', () => {
  it('classifies deterministically', () => {
    expect(stellarMemoType(undefined)).toBe('none');
    for (const m of ['0', '1', '123456', '18446744073709551615']) expect(stellarMemoType(m), m).toBe('id');
    for (const m of ['007', '18446744073709551616', '99999999999999999999', '12 34', '-1', '1.5', '+1', '１２３', 'hello', 'x'.repeat(28), 'é'.repeat(14), '1234567890123456789012345678'])
      expect(stellarMemoType(m), m).toBe('text');
    for (const m of ['', 'x'.repeat(29), 'é'.repeat(15), '12345678901234567890123456789', '\ud800'])
      expect(() => stellarMemoType(m), JSON.stringify(m)).toThrow();
  });
});

describe('stellar: transaction bytes equal the official SDK', () => {
  const cases: [string, Intent][] = [
    ['payment, no memo', base],
    ['payment, text memo', withX({ memoType: 'text' }, { memo: 'invoice 2026-11' })],
    ['payment, UTF-8 text memo needing XDR padding', withX({ memoType: 'text' }, { memo: 'café ☕' })],
    ['payment, 28-byte text memo', withX({ memoType: 'text' }, { memo: 'x'.repeat(28) })],
    ['payment, leading-zero numeric memo stays text', withX({ memoType: 'text' }, { memo: '007' })],
    ['payment, numeric memo as MEMO_ID', withX({ memoType: 'id' }, { memo: '123456789' })],
    ['payment, largest MEMO_ID', withX({ memoType: 'id' }, { memo: '18446744073709551615' })],
    ['payment, 1 stroop, minimum fee', withX({ fee: '100' }, { amount: '1' })],
    ['payment, int64 max amount and sequence', withX({ sequence: '9223372036854775807' }, { amount: '9223372036854775807' })],
    ['createAccount, 1 XLM', withX({ op: 'createAccount' }, { amount: '10000000' })],
    ['createAccount with MEMO_ID', withX({ op: 'createAccount', memoType: 'id' }, { amount: '25000000', memo: '0' })],
  ];
  for (const [name, i] of cases) it(name, () => {
    const ours = buildStellarTx(i, net), ref = sdkTx(i);
    expect(toHex(ours.tx)).toBe(toHex(sdkTxBytes(ref)));
    expect(toHex(ours.hash)).toBe(ref.hash().toString('hex'));
    expect(toHex(ours.hash)).toBe(toHex(sha256(new Uint8Array(ref.signatureBase()))));
    const { signDocs, describe: d } = stellarPlugin.build(i, net);
    expect(signDocs.map(toHex)).toEqual([toHex(ours.hash)]);
    expect(d.txid).toBe(ref.hash().toString('hex'));
  });
  it('property: any valid field combination', () => {
    const memo = fc.oneof(fc.constant(undefined), fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }).map(String), fc.string({ minLength: 1, maxLength: 9, unit: 'grapheme' }).filter((s) => { try { stellarMemoType(s); return true; } catch { return false; } }));
    fc.assert(fc.property(
      fc.bigInt({ min: 10_000_000n, max: (1n << 63n) - 1n }), fc.bigInt({ min: 1n, max: (1n << 63n) - 1n }), fc.integer({ min: 100, max: 0xffffffff }),
      fc.integer({ min: now + 120, max: now + 900 }), fc.boolean(), memo, fc.uint8Array({ minLength: 32, maxLength: 32 }),
      (amount, sequence, fee, maxTime, create, m, dest) => {
        const i = withX({ op: create ? 'createAccount' : 'payment', sequence: sequence.toString(), fee: String(fee), maxTime: String(maxTime), memoType: stellarMemoType(m) },
          { amount: amount.toString(), maxFee: String(fee), to: stellarEncodeAccount(dest), ...(m === undefined ? {} : { memo: m }) });
        const ours = buildStellarTx(i, net), ref = sdkTx(i);
        return toHex(ours.tx) === toHex(sdkTxBytes(ref)) && toHex(ours.hash) === ref.hash().toString('hex');
      }), { numRuns: 300 });
  });
});

describe('stellar: signing', () => {
  it('produces the envelope the SDK produces, and the SDK verifies the signature', () => {
    for (const i of [base, withX({ op: 'createAccount', memoType: 'text' }, { amount: '15000000', memo: 'welcome' })]) {
      const signed = stellarPlugin.sign(i, net, key);
      // decode with the SDK: fields, re-encoding and signature
      const tx = TransactionBuilder.fromXDR(signed.raw, Networks.PUBLIC) as Transaction;
      expect(tx.toEnvelope().toXDR('base64')).toBe(signed.raw);
      expect(tx.hash().toString('hex')).toBe(signed.txid);
      expect(tx.source).toBe(i.from);
      expect(tx.fee).toBe(i.x!.fee);
      expect(tx.sequence).toBe(i.x!.sequence);
      expect(tx.timeBounds).toEqual({ minTime: '0', maxTime: i.x!.maxTime });
      expect(tx.ledgerBounds ?? null).toBeNull();
      expect(tx.operations.length).toBe(1);
      const op = tx.operations[0]!;
      expect(op.source).toBeUndefined();
      if (i.x!.op === 'payment') {
        expect(op.type).toBe('payment');
        if (op.type === 'payment') { expect(op.destination).toBe(i.to); expect(op.asset.isNative()).toBe(true); expect(op.amount).toBe('12.5000000'); }
        expect(tx.memo.type).toBe('none');
      } else {
        expect(op.type).toBe('createAccount');
        if (op.type === 'createAccount') { expect(op.destination).toBe(i.to); expect(op.startingBalance).toBe('1.5000000'); }
        expect([tx.memo.type, tx.memo.value?.toString()]).toEqual(['text', 'welcome']);
      }
      expect(tx.signatures.length).toBe(1);
      const kp = Keypair.fromPublicKey(i.from);
      expect(tx.signatures[0]!.hint().toString('hex')).toBe(kp.signatureHint().toString('hex'));
      expect(kp.verify(tx.hash(), tx.signatures[0]!.signature())).toBe(true);
      expect(ed25519.verify(new Uint8Array(tx.signatures[0]!.signature()), hexToBytes(signed.txid), PUB)).toBe(true);
      // the SDK signing the SDK-built transaction with the same seed gives the same bytes (ed25519 is deterministic)
      const ref = sdkTx(i);
      ref.sign(Keypair.fromRawEd25519Seed(Buffer.from(PRIV)));
      expect(ref.toEnvelope().toXDR('base64')).toBe(signed.raw);
      expect(stellarEnvelopeTxid(net, signed.raw)).toBe(signed.txid);
    }
  });
  it('refuses a key that does not control the source, the wrong curve, and a bad signature', () => {
    const other = slip10(SEP5_SEED, "m/44'/148'/1'");
    expect(() => stellarPlugin.sign(base, net, { curve: 'ed25519', publicKey: ed25519.getPublicKey(other), signMessage: (m) => ed25519.sign(m, other) })).toThrow(/does not control/);
    expect(() => stellarPlugin.sign(base, net, { curve: 'secp256k1', publicKey: new Uint8Array(33), signDigest: () => { throw new Error('no'); } })).toThrow(/ed25519/);
    expect(() => stellarPlugin.sign(base, net, { curve: 'ed25519', publicKey: PUB })).toThrow(/ed25519/);
    expect(() => stellarPlugin.sign(base, net, { curve: 'ed25519', publicKey: PUB, signMessage: (m) => ed25519.sign(m, other) })).toThrow(/self-check/);
  });
});

describe('stellar: fail closed', () => {
  const muxed = new MuxedAccount(new Account(TO, '0'), '1').accountId();
  const bad: [string, Intent, RegExp][] = [
    ['wrong passphrase in the intent', { ...base, chainRef: Networks.TESTNET }, /identity/],
    ['another network id', { ...base, network: 'solana' }, /not a Stellar intent/],
    ['token asset', { ...base, asset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' }, /native/],
    ['wrong symbol', { ...base, symbol: 'USDC' }, /metadata/],
    ['wrong decimals', { ...base, decimals: 6 }, /metadata/],
    ['amount zero', { ...base, amount: '0' }, /positive/],
    ['amount above int64', { ...base, amount: '9223372036854775808' }, /range/],
    ['amount not canonical', { ...base, amount: '0125' }, /base-unit/],
    ['destination equals source', { ...base, to: FROM }, /equals source/],
    ['muxed destination', { ...base, to: muxed }, /muxed/],
    ['lower-case destination', { ...base, to: TO.toLowerCase() }, /invalid Stellar address/],
    ['destination with a bad checksum', { ...base, to: TO.slice(0, -1) + (TO.endsWith('A') ? 'B' : 'A') }, /Stellar address/],
    ['invalid source', { ...base, from: FROM.slice(0, 55) + '=' }, /invalid Stellar address/],
    ['fee above maxFee', withX({ fee: '20001' }), /above approved maximum/],
    ['fee below the network minimum', withX({ fee: '99' }), /range/],
    ['fee above uint32', withX({ fee: '4294967296' }, { maxFee: '5000000000' }), /range/],
    ['fee not canonical', withX({ fee: '0100' }), /canonical/],
    ['fee negative', withX({ fee: '-100' }), /canonical/],
    ['unknown x key', withX({ data: 'AAAA' }), /unknown or missing/],
    ['extra operation hint', withX({ op2: 'payment' }), /unknown or missing/],
    ['missing x key', { ...base, x: { op: 'payment', sequence: '5', fee: '100', maxTime: String(now + 180) } }, /unknown or missing/],
    ['no x section', (() => { const { x: _x, ...r } = base; return r as Intent; })(), /missing Stellar parameters/],
    ['foreign chain section', { ...base, sol: { recentBlockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N', lastValidBlockHeight: 1, createAta: false, computeUnitLimit: 1, computeUnitPrice: '0' } }, /unexpected chain section/],
    ['unknown operation', withX({ op: 'accountMerge' }), /x\.op/],
    ['operation in another case', withX({ op: 'Payment' }), /x\.op/],
    ['createAccount below 1 XLM', withX({ op: 'createAccount' }, { amount: '9999999' }), /at least 1 XLM/],
    ['sequence zero', withX({ sequence: '0' }), /range/],
    ['sequence above int64', withX({ sequence: '9223372036854775808' }), /range/],
    ['sequence not canonical', withX({ sequence: '0x10' }), /canonical/],
    ['time bound zero (no expiry)', withX({ maxTime: '0' }), /range/],
    ['time bound in the past', withX({ maxTime: String(now) }), /not after/],
    ['time bound before the approval window ends', withX({ maxTime: String(now + 119) }), /before the approval window/],
    ['time bound too far away', withX({ maxTime: String(now + 901) }), /too far/],
    ['memo present but memoType none', { ...base, memo: 'hello' }, /memoType/],
    ['numeric memo declared as text', withX({ memoType: 'text' }, { memo: '12345' }), /memoType/],
    ['text memo declared as id', withX({ memoType: 'id' }, { memo: 'hello' }), /memoType/],
    ['memoType without memo', withX({ memoType: 'text' }), /memoType/],
    ['unknown memoType', withX({ memoType: 'hash' }, { memo: 'ab'.repeat(32) }), /memo/],
    ['memo longer than 28 bytes', withX({ memoType: 'text' }, { memo: 'x'.repeat(29) }), /too long/],
    ['empty memo', withX({ memoType: 'text' }, { memo: '' }), /empty/],
  ];
  for (const [name, i, re] of bad) it(name, () => {
    expect(() => stellarPlugin.build(i, net)).toThrow(re);
    expect(() => stellarPlugin.sign(i, net, key)).toThrow(re);
  });
  it('refuses a network definition that is not the pinned public network', () => {
    expect(() => stellarPlugin.build({ ...base, chainRef: Networks.TESTNET }, { ...net, chainRef: Networks.TESTNET })).toThrow(/public network/);
    expect(() => stellarPlugin.build(base, { ...net, family: 'evm' })).toThrow(/not a Stellar intent/);
    expect(() => stellarPlugin.build({ ...base, symbol: 'ABC' }, { ...net, native: { ...net.native, symbol: 'ABC', id: 'ABC' } })).toThrow(/native/);
  });
  it('the intent schema and hash accept the Stellar section and bind every field', () => {
    expect(() => canonicalBytes(base)).not.toThrow();
    expect(() => canonicalBytes((() => { const { x: _x, ...r } = base; return r as Intent; })())).toThrow(/does not match network/);
    expect(() => canonicalBytes({ ...base, x: { ...base.x!, 'bad key': '1' } })).toThrow();
  });
  it('changing any intent field changes the signed bytes or throws', () => {
    const ref = toHex(stellarPlugin.build(base, net).signDocs[0]!);
    const txMuts: Intent[] = [
      { ...base, amount: '125000001' }, { ...base, to: SEP5[2][1] }, { ...base, from: SEP5[2][1] },
      withX({ fee: '10113' }), withX({ sequence: '2390162185806737' }), withX({ maxTime: String(now + 181) }), withX({ op: 'createAccount' }),
      withX({ memoType: 'text' }, { memo: 'a' }), withX({ memoType: 'id' }, { memo: '1' }),
    ];
    const seen = new Set([ref]);
    for (const m of txMuts) seen.add(toHex(stellarPlugin.build(m, net).signDocs[0]!));
    expect(seen.size).toBe(txMuts.length + 1);
    // '1' as MEMO_ID and '1' as MEMO_TEXT can never be confused: the type is fixed by the rule
    expect(() => stellarPlugin.build(withX({ memoType: 'text' }, { memo: '1' }), net)).toThrow();
    // fields that are not part of the Stellar transaction either throw or leave it unchanged, and always change the approved intent hash
    const other: Intent[] = [
      { ...base, chainRef: 'Test SDF Network ; September 2015' }, { ...base, network: 'solana' }, { ...base, asset: 'other' }, { ...base, symbol: 'XLN' }, { ...base, decimals: 8 },
      { ...base, maxFee: '10111' }, { ...base, createdAt: now + 200 }, { ...base, expiresAt: now + 181 }, { ...base, v: 2 as never },
      { ...base, maxFee: '20001' }, { ...base, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a12' }, { ...base, keyId: 'spw-0123456789abcdee' }, { ...base, policyVersion: 5 },
    ];
    const h0 = toHex(intentHash(base));
    other.forEach((m, k) => {
      let out: string | null = null;
      try { out = toHex(stellarPlugin.build(m, net).signDocs[0]!); } catch { /* refused */ }
      if (k < 9) expect(out, `mutation ${k}`).toBeNull(); else expect(out).toBe(ref);
      let h: string | null = null;
      try { h = toHex(intentHash(m)); } catch { /* refused by the schema */ }
      expect(h).not.toBe(h0);
    });
    for (const m of txMuts) expect(toHex(intentHash(m))).not.toBe(h0);
  });
});
