import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { Address, beginCell, Cell, comment, external, internal, loadMessage, loadMessageRelaxed, SendMode, storeMessage, storeStateInit } from '@ton/core';
import { mnemonicToPrivateKey, signVerify } from '@ton/crypto';
import { WalletContractV4 } from '@ton/ton';
import {
  buildTonTransfer, canonicalBytes, DEFAULT_POLICY, intentHash, isValidAddress, NETWORKS, normalizeAddress, pluginFor, toHex, TON_MAINNET_ZEROSTATE, TON_MAX_VALIDITY_SEC,
  TON_SUBWALLET_ID, TON_V4R2_CODE_BOC, TON_V4R2_CODE_HASH, tonAccountId, tonAddressOf, tonCommentBytes, tonFormatAddress, tonNormalizeAddress, tonParseAddress, tonParseBoc,
  tonPlugin, tonRawAddress, tonReadExternal, tonSerializeBoc, tonStateInit, tonV4R2Code, tonWalletData,
  type Intent, type KeyHandle, type NetworkDef,
} from '../src/index.ts';

const net = NETWORKS.ton as NetworkDef;
const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// BIP-39 seed of the public test mnemonic (empty passphrase) — the published BIP-39 test vector
const SEED = hexToBytes('5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4');

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
const PRIV = slip10(SEED, tonPlugin.path(net));
const PUB = ed25519.getPublicKey(PRIV);
const key: KeyHandle = { curve: 'ed25519', publicKey: PUB, signMessage: (m) => ed25519.sign(m, PRIV) };
/** the official SDK's wallet v4R2 for the same public key */
const sdkWallet = WalletContractV4.create({ workchain: 0, publicKey: Buffer.from(PUB) });
const FROM = 'UQAzWZa6nM5mJev91wGc7VCSfBoIsYRqKJpV78N8Add9-RKY';
const OTHER_PUB = ed25519.getPublicKey(slip10(SEED, "m/44'/607'/1'"));
const TO = tonAddressOf(OTHER_PUB);

const now = 1_800_000_000;
const base: Intent = {
  v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-0123456789abcdef', createdAt: now, expiresAt: now + 120, policyVersion: 2,
  network: 'ton', chainRef: TON_MAINNET_ZEROSTATE, asset: 'native', symbol: 'TON', decimals: 9, amount: '1500000000', from: FROM, to: TO, maxFee: '5000000',
  x: { seqno: '7', validUntil: String(now + 300), bounce: '1', sendMode: '3', stateInit: '0' },
};
const withX = (x: Record<string, string>, over: Partial<Intent> = {}): Intent => ({ ...base, ...over, x: { ...base.x!, ...x } });
const deploy = (over: Partial<Intent> = {}) => withX({ seqno: '0', stateInit: '1', bounce: '0' }, over);

/** The same transfer built by the official SDK (@ton/ton WalletContractV4 + @ton/core) from the same fields, signed by the same key. */
async function sdk(i: Intent): Promise<{ signingHash: Buffer; body: Cell; message: Cell; normalized: Buffer }> {
  const x = i.x!;
  let signingHash: Buffer = Buffer.alloc(0);
  const body = await sdkWallet.createTransfer({
    seqno: Number(x.seqno), timeout: Number(x.validUntil), sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
    signer: async (c: Cell) => { signingHash = c.hash(); return Buffer.from(ed25519.sign(c.hash(), PRIV)); },
    messages: [internal({ to: Address.parse(i.to), value: BigInt(i.amount), bounce: x.bounce === '1', body: i.memo })],
  });
  // what the SDK's provider sends: external({ to, init: needed ? init : null, body }) → storeMessage → toBoc()
  const message = beginCell().store(storeMessage(external({ to: sdkWallet.address, init: x.stateInit === '1' ? sdkWallet.init : null, body }))).endCell();
  const normalized = beginCell().store(storeMessage(external({ to: sdkWallet.address, body }), { forceRef: true })).endCell().hash();
  return { signingHash, body, message, normalized };
}

describe('ton: registration', () => {
  it('is registered with the pinned identity, derivation, limits and two sources', () => {
    expect(net).toMatchObject({ id: 'ton', family: 'ton', coinType: 607, memo: 'text', chainRef: '17a3a92992aabea785a7a090985a265cd31f323d849da51239737e321fb05569', native: { id: 'native', symbol: 'TON', decimals: 9 }, tokens: [] });
    // the same hash as in the network's global config (base64 there)
    expect(Buffer.from('F6OpKZKqvqeFp6CQmFomXNMfMj2EnaUSOXN+Mh+wVWk=', 'base64').toString('hex')).toBe(net.chainRef);
    expect(net.activation).toBeUndefined();
    expect(net.rpc).toHaveLength(2);
    expect(new Set(net.rpc.map((u) => new URL(u).host)).size).toBe(2);
    expect(pluginFor(net)).toBe(tonPlugin);
    expect([tonPlugin.family, tonPlugin.curve, tonPlugin.path(net)]).toEqual(['ton', 'ed25519', "m/44'/607'/0'"]);
    expect(() => tonPlugin.path({ ...net, coinType: 148 })).toThrow(/607/);
    expect([DEFAULT_POLICY.perTx['ton:TON'], DEFAULT_POLICY.daily['ton:TON'], DEFAULT_POLICY.maxFee.ton]).toEqual(['45000000000', '90000000000', '50000000']);
  });
});

describe('ton: wallet contract and addresses', () => {
  it('embeds the wallet v4R2 code of the official SDK, with the well-known code hash', () => {
    expect(toHex(tonV4R2Code().hash)).toBe(TON_V4R2_CODE_HASH);
    expect(sdkWallet.init.code.hash().toString('hex')).toBe(TON_V4R2_CODE_HASH);
    expect(TON_V4R2_CODE_HASH).toBe('feb5ff6820e2ff0d9483e7e0d62c817d846789fb4ae580c878866d959dabd5c0');
    expect(Buffer.from(tonSerializeBoc(tonV4R2Code())).equals(sdkWallet.init.code.toBoc())).toBe(true);
    expect(sdkWallet.walletId).toBe(TON_SUBWALLET_ID);
    expect(TON_V4R2_CODE_BOC.length).toBeGreaterThan(900);
  });
  it('derives the same address as WalletContractV4.create for the public test mnemonic at m/44\'/607\'/0\'', () => {
    const st = tonStateInit(PUB);
    expect(toHex(st.hash)).toBe(beginCell().store(storeStateInit(sdkWallet.init)).endCell().hash().toString('hex'));
    expect(toHex(st.refs[1]!.hash)).toBe(sdkWallet.init.data.hash().toString('hex'));
    expect(toHex(tonAccountId(PUB))).toBe(sdkWallet.address.hash.toString('hex'));
    const addr = tonPlugin.address(net, PUB);
    expect(addr).toBe(sdkWallet.address.toString({ bounceable: false, urlSafe: true, testOnly: false }));
    expect(addr).toBe(FROM); // pinned: "UQ…" = non-bounceable
    expect(tonRawAddress(addr)).toBe('0:335996ba9cce6625ebfdd7019ced50927c1a08b1846a289a55efc37c01d77df9');
    expect(tonWalletData(st.refs[1]!)).toEqual({ seqno: 0, subwalletId: TON_SUBWALLET_ID, publicKey: PUB, plugins: false });
  });
  it('is NOT the address a TON-native wallet (Tonkeeper) derives from the same words: the key derivation differs', async () => {
    const native = await mnemonicToPrivateKey(MNEMONIC.split(' ')); // TON's own scheme (PBKDF2 over the phrase, no BIP-39 seed, no path)
    const theirs = WalletContractV4.create({ workchain: 0, publicKey: native.publicKey }).address.toString({ bounceable: false });
    expect(theirs).not.toBe(FROM);
    expect(Buffer.from(PUB).equals(native.publicKey)).toBe(false);
  });
  it('formats and parses like the official SDK (property)', () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }).filter((b) => b.some((v) => v !== 0)), (id) => {
      const a = new Address(0, Buffer.from(id));
      const canonical = a.toString({ bounceable: false, urlSafe: true });
      expect(tonFormatAddress(id)).toBe(canonical);
      expect(tonFormatAddress(id, { bounceable: true })).toBe(a.toString({ bounceable: true, urlSafe: true }));
      for (const form of [canonical, a.toString({ bounceable: true, urlSafe: true }), a.toString({ bounceable: true, urlSafe: false }), a.toString({ bounceable: false, urlSafe: false }), a.toRawString(), a.toRawString().toUpperCase().replace('0:', '0:')]) {
        expect(tonNormalizeAddress(form)).toBe(canonical);
        expect(toHex(tonParseAddress(form))).toBe(toHex(id));
      }
      expect(Address.parse(tonFormatAddress(id)).equals(a)).toBe(true);
    }), { numRuns: 200 });
  });
  it('accepts EQ…, UQ… and raw destinations and normalizes them to one form; refuses everything else', () => {
    const a = Address.parse(TO);
    const eq = a.toString({ bounceable: true }), uq = a.toString({ bounceable: false });
    expect([eq.slice(0, 2), uq.slice(0, 2)]).toEqual(['EQ', 'UQ']);
    for (const form of [eq, uq, a.toRawString()]) expect(normalizeAddress('ton', form)).toBe(TO);
    expect(normalizeAddress('ton', `  ${eq} `)).toBe(TO);
    expect(isValidAddress('ton', eq)).toBe(true);
    const flip = (s: string, k: number) => s.slice(0, k) + (s[k] === 'A' ? 'B' : 'A') + s.slice(k + 1);
    const bad: [string, RegExp][] = [
      [a.toString({ bounceable: true, testOnly: true }), /testnet/], // kQ…
      [a.toString({ bounceable: false, testOnly: true }), /testnet/], // 0Q…
      [new Address(-1, a.hash).toString(), /workchain 0/], // masterchain, user-friendly
      [`-1:${a.hash.toString('hex')}`, /workchain 0/],
      [`1:${a.hash.toString('hex')}`, /workchain 0/],
      [flip(eq, 20), /checksum/],
      [flip(eq, 47), /checksum|encoding/],
      [eq.slice(0, 47), /48 characters/],
      [eq + 'A', /48 characters/],
      [`0:${a.hash.toString('hex').slice(2)}`, /48 characters/],
      [`0:${'0'.repeat(64)}`, /zero address/],
      [new Address(0, Buffer.alloc(32)).toString(), /zero address/],
      ['-_'.repeat(12) + '+/'.repeat(12), /mixed base64/],
      ['GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX', /48 characters/],
      ['', /48 characters/],
    ];
    for (const [addr, re] of bad) { expect(() => tonPlugin.normalizeAddress(net, addr), addr).toThrow(re); expect(isValidAddress('ton', addr)).toBe(false); }
    // a valid checksum over an unknown tag byte is still refused
    const raw = Buffer.from(eq.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); raw[0] = 0x12;
    let crc = 0; for (const byte of raw.subarray(0, 34)) { crc ^= byte << 8; for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
    raw[34] = crc >> 8; raw[35] = crc & 0xff;
    expect(() => tonParseAddress(raw.toString('base64url'))).toThrow(/flags/);
  });
});

describe('ton: cells and bags of cells equal @ton/core', () => {
  /** a random cell DAG built with the SDK: each cell may reference up to four earlier ones (so sub-cells are shared), the last is the root */
  const tree = fc.array(fc.tuple(fc.array(fc.boolean(), { maxLength: 1023 }), fc.array(fc.nat(), { maxLength: 4 })), { minLength: 1, maxLength: 12 }).map((specs) => {
    const cells: Cell[] = [];
    for (const [bits, refs] of specs) {
      const b = beginCell();
      for (const v of bits) b.storeBit(v);
      if (cells.length > 0) for (const r of refs) b.storeRef(cells[r % cells.length]!);
      cells.push(b.endCell());
    }
    return cells[cells.length - 1]!;
  });
  it('hashes, parses and serializes any ordinary cell tree byte-for-byte like the SDK (property)', () => {
    fc.assert(fc.property(tree, fc.boolean(), (c, idx) => {
      const ours = tonParseBoc(c.toBoc({ idx }));
      expect(toHex(ours.hash)).toBe(c.hash().toString('hex'));
      expect(ours.depth).toBe(c.depth());
      expect(Buffer.from(tonSerializeBoc(ours)).equals(c.toBoc())).toBe(true);
    }), { numRuns: 150 });
  });
  it('refuses exotic cells, truncated or corrupted containers and several roots', () => {
    const lib = beginCell().storeUint(2, 8).storeBuffer(Buffer.alloc(32, 7)).endCell({ exotic: true });
    expect(() => tonParseBoc(beginCell().storeRef(lib).endCell().toBoc())).toThrow(/exotic/);
    const good = beginCell().storeUint(5, 13).storeRef(beginCell().storeUint(1, 8).endCell()).endCell().toBoc();
    expect(toHex(tonParseBoc(good).hash)).toBe(Cell.fromBoc(good)[0]!.hash().toString('hex'));
    expect(() => tonParseBoc(good.subarray(0, good.length - 1))).toThrow();
    const corrupt = Buffer.from(good); corrupt[corrupt.length - 6]! ^= 1;
    expect(() => tonParseBoc(corrupt)).toThrow(/checksum/);
    const magic = Buffer.from(good); magic[0] = 0;
    expect(() => tonParseBoc(magic)).toThrow(/not a bag of cells/);
    const backRef = Buffer.from(beginCell().storeRef(beginCell().endCell()).endCell().toBoc({ crc32: false })); backRef[backRef.length - 3] = 0; // root pointing at itself
    expect(() => tonParseBoc(backRef)).toThrow(/reference/);
    expect(() => tonParseBoc(new Uint8Array(0))).toThrow();
    // parsing must not modify the caller's buffer
    const copy = Buffer.from(good); tonParseBoc(good); expect(good.equals(copy)).toBe(true);
  });
});

describe('ton: the transfer equals the official SDK', () => {
  const cases: [string, Intent][] = [
    ['plain transfer, bounceable', base],
    ['non-bounceable', withX({ bounce: '0' })],
    ['text comment', { ...base, memo: 'invoice 4242' }],
    ['numeric comment (exchange memo)', { ...base, memo: '109284756' }],
    ['multi-byte comment', { ...base, memo: 'café ☕ – 送金 😀' }],
    ['comment of 120 characters (continued in a second cell)', { ...base, memo: 'x'.repeat(120) }],
    ['longest multi-byte comment (three cells)', { ...base, memo: '😀'.repeat(60) }],
    ['first transfer: deploys the wallet (StateInit attached, seqno 0)', deploy()],
    ['first transfer with a long comment', deploy({ memo: 'é'.repeat(120) })],
    ['seqno 0 without StateInit (wallet deployed by someone else)', withX({ seqno: '0' })],
    ['1 nanoton', { ...base, amount: '1' }],
    ['largest amount of the policy and beyond', { ...base, amount: '5000000000000000000' }],
    ['highest seqno', withX({ seqno: '4294967294' })],
  ];
  for (const [name, i] of cases) it(name, async () => {
    const ref = await sdk(i);
    const built = tonPlugin.build(i, net);
    expect(built.signDocs).toHaveLength(1);
    expect(toHex(built.signDocs[0]!)).toBe(ref.signingHash.toString('hex')); // what is signed: the cell hash of the v4 signing message
    const signed = tonPlugin.sign(i, net, key);
    expect(Buffer.from(signed.raw, 'base64').equals(ref.message.toBoc())).toBe(true); // byte-identical bag of cells
    expect(signed.txid).toBe(ref.normalized.toString('hex'));
    const back = tonReadExternal(signed.raw);
    expect([back.cellHash, back.txid, back.stateInit, toHex(back.accountId), toHex(back.body.hash)])
      .toEqual([ref.message.hash().toString('hex'), signed.txid, i.x!.stateInit === '1', sdkWallet.address.hash.toString('hex'), ref.body.hash().toString('hex')]);
  });

  it('property: any valid field combination is byte-identical', async () => {
    const memo = fc.option(fc.string({ unit: 'grapheme', minLength: 1, maxLength: 40 }).filter((s) => s.length <= 120 && new TextDecoder().decode(new TextEncoder().encode(s)) === s), { nil: undefined });
    await fc.assert(fc.asyncProperty(fc.bigInt({ min: 1n, max: (1n << 120n) - 1n }), fc.integer({ min: 0, max: 0xfffffffe }), fc.integer({ min: 120, max: TON_MAX_VALIDITY_SEC }), fc.boolean(), fc.boolean(), memo,
      fc.uint8Array({ minLength: 32, maxLength: 32 }).filter((b) => b.some((v) => v !== 0)), async (amount, seqno, validity, bounce, init, m, dest) => {
        const i: Intent = { ...base, amount: amount.toString(), to: tonFormatAddress(dest), ...(m === undefined ? {} : { memo: m }),
          x: { seqno: init ? '0' : String(seqno), validUntil: String(now + validity), bounce: bounce ? '1' : '0', sendMode: '3', stateInit: init ? '1' : '0' } };
        const ref = await sdk(i), signed = tonPlugin.sign(i, net, key);
        expect(toHex(tonPlugin.build(i, net).signDocs[0]!)).toBe(ref.signingHash.toString('hex'));
        expect(Buffer.from(signed.raw, 'base64').equals(ref.message.toBoc())).toBe(true);
        expect(signed.txid).toBe(ref.normalized.toString('hex'));
      }), { numRuns: 120 });
  });

  it('the SDK decodes the signed message to exactly the approved fields, and the signature verifies', () => {
    for (const i of [{ ...base, memo: 'hello TON' }, deploy()]) {
      const signed = tonPlugin.sign(i, net, key);
      const msg = loadMessage(Cell.fromBase64(signed.raw).beginParse());
      expect(msg.info.type).toBe('external-in');
      if (msg.info.type !== 'external-in') throw new Error('unreachable');
      expect([msg.info.dest.toString({ bounceable: false }), msg.info.src, msg.info.importFee]).toEqual([i.from, null, 0n]);
      if (i.x!.stateInit === '1') {
        expect(msg.init!.code!.hash().toString('hex')).toBe(TON_V4R2_CODE_HASH);
        expect(msg.init!.data!.equals(sdkWallet.init.data)).toBe(true);
        expect([msg.init!.splitDepth ?? null, msg.init!.special ?? null, msg.init!.libraries?.size ?? 0]).toEqual([null, null, 0]);
        // the address is the hash of exactly this StateInit
        expect(beginCell().store(storeStateInit(msg.init!)).endCell().hash().equals(msg.info.dest.hash)).toBe(true);
      } else expect(msg.init ?? null).toBeNull();
      const s = msg.body.beginParse();
      const signature = s.loadBuffer(64);
      const signingHash = beginCell().storeSlice(s).endCell().hash(); // the rest of the body is the signing message
      expect(signingHash.toString('hex')).toBe(toHex(tonPlugin.build(i, net).signDocs[0]!));
      expect(ed25519.verify(signature, signingHash, PUB)).toBe(true);
      expect(signVerify(signingHash, signature, Buffer.from(PUB))).toBe(true); // @ton/crypto (tweetnacl), what the contract's check_signature does
      expect(signVerify(signingHash, signature, Buffer.from(OTHER_PUB))).toBe(false);
      expect([s.loadUint(32), s.loadUint(32), s.loadUint(32), s.loadUint(8), s.loadUint(8)]).toEqual([TON_SUBWALLET_ID, Number(i.x!.validUntil), Number(i.x!.seqno), 0, 3]);
      expect([s.remainingBits, s.remainingRefs]).toEqual([0, 1]); // one outgoing message, nothing else
      const out = loadMessageRelaxed(s.loadRef().beginParse());
      if (out.info.type !== 'internal') throw new Error('expected an internal message');
      expect([out.info.dest.toString({ bounceable: false }), out.info.value.coins, out.info.value.other ?? null, out.info.bounce, out.info.bounced, out.info.ihrDisabled, out.info.src ?? null, out.init ?? null])
        .toEqual([i.to, BigInt(i.amount), null, i.x!.bounce === '1', false, true, null, null]);
      expect(out.body.equals(i.memo === undefined ? Cell.EMPTY : comment(i.memo))).toBe(true);
    }
  });

  it('describes the transfer for the approval screen', () => {
    expect(tonPlugin.build(deploy({ memo: 'hi' }), net).describe).toMatchObject({ operation: 'Transfer (native TON, wallet v4R2)', from: FROM, to: TO, amountNano: '1500000000', seqno: '0', validUntil: String(now + 300), bounce: 'no', sendMode: '3', deploysWallet: 'yes', comment: 'hi' });
  });
});

describe('ton: signing', () => {
  it('refuses a key that does not control the source wallet, the wrong curve, and a bad signature', () => {
    expect(() => tonPlugin.sign(base, net, { curve: 'ed25519', publicKey: OTHER_PUB, signMessage: key.signMessage })).toThrow(/does not control/);
    expect(() => tonPlugin.sign(base, net, { curve: 'secp256k1', publicKey: PUB, signDigest: () => ({ compact: new Uint8Array(64), recovery: 0, der: new Uint8Array(70) }) })).toThrow(/ed25519/);
    expect(() => tonPlugin.sign(base, net, { curve: 'ed25519', publicKey: PUB })).toThrow(/ed25519/);
    expect(() => tonPlugin.sign(base, net, { ...key, signMessage: () => new Uint8Array(64) })).toThrow(/self-check/);
    expect(() => tonPlugin.sign(base, net, { ...key, signMessage: (m) => ed25519.sign(m, slip10(SEED, "m/44'/607'/1'")) })).toThrow(/self-check/);
    expect(() => tonPlugin.sign({ ...base, from: TO, to: FROM }, net, key)).toThrow(/does not control/);
  });
  it('is deterministic', () => {
    expect(tonPlugin.sign(base, net, key)).toEqual(tonPlugin.sign(structuredClone(base), net, key));
  });
});

describe('ton: fail closed', () => {
  const eq = Address.parse(TO).toString({ bounceable: true });
  const bad: [string, Intent, RegExp][] = [
    ['another chain identity (testnet zero state)', { ...base, chainRef: '823f81f306ff02694f935cf5021548e3ce2b86b529812af6a12148879e95a128' }, /chain identity/],
    ['another network id', { ...base, network: 'stellar' }, /not a TON intent/],
    ['a jetton', { ...base, asset: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs' }, /only native/],
    ['wrong symbol', { ...base, symbol: 'USDT' }, /metadata/],
    ['wrong decimals', { ...base, decimals: 6 }, /metadata/],
    ['destination in bounceable form (not canonical)', { ...base, to: eq }, /canonical/],
    ['destination in raw form', { ...base, to: tonRawAddress(TO) }, /canonical/],
    ['destination in non-URL-safe base64', { ...base, to: tonFormatAddress(new Uint8Array(32).fill(0xfb)).replace(/-/g, '+').replace(/_/g, '/') }, /canonical/],
    ['testnet destination', { ...base, to: Address.parse(TO).toString({ bounceable: false, testOnly: true }) }, /testnet/],
    ['masterchain destination', { ...base, to: new Address(-1, Address.parse(TO).hash).toString({ bounceable: false }) }, /workchain 0/],
    ['invalid destination', { ...base, to: TO.slice(0, 47) + (TO.endsWith('A') ? 'B' : 'A') }, /TON address/],
    ['source not canonical', { ...base, from: Address.parse(FROM).toString({ bounceable: true }) }, /canonical/],
    ['destination equals source', { ...base, to: FROM }, /equals source/],
    ['zero amount', { ...base, amount: '0' }, /positive/],
    ['non-canonical amount', { ...base, amount: '01' }, /base-unit/],
    ['amount beyond 120 bits', { ...base, amount: (1n << 120n).toString() }, /out of range/],
    ['no fee budget', { ...base, maxFee: '0' }, /fee budget/],
    ['missing parameters', { ...base, x: undefined }, /missing TON parameters/],
    ['missing key', { ...base, x: { seqno: '7', validUntil: String(now + 300), bounce: '1', sendMode: '3' } }, /unknown or missing/],
    ['unknown key', withX({ subwallet: '1' }), /unknown or missing/],
    ['unknown key replacing one', { ...base, x: { seqno: '7', validUntil: String(now + 300), bounce: '1', sendMode: '3', stateinit: '0' } }, /unknown or missing/],
    ['non-canonical seqno', withX({ seqno: '07' }), /canonical/],
    ['negative seqno', withX({ seqno: '-1' }), /canonical/],
    ['seqno out of range', withX({ seqno: '4294967295' }), /out of range/],
    ['valid_until not after creation', withX({ validUntil: String(now) }), /not after/],
    ['valid_until before the approval window ends', withX({ validUntil: String(now + 119) }), /before the approval window/],
    ['valid_until too far', withX({ validUntil: String(now + TON_MAX_VALIDITY_SEC + 1) }), /too far/],
    ['valid_until of the SDK\'s "never expires" convention', withX({ validUntil: '4294967295' }), /out of range/],
    ['send mode 128 (send the whole balance)', withX({ sendMode: '128' }), /sendMode/],
    ['send mode 130', withX({ sendMode: '130' }), /sendMode/],
    ['send mode 35 (destroy the wallet if empty)', withX({ sendMode: '35' }), /sendMode/],
    ['send mode 1', withX({ sendMode: '1' }), /sendMode/],
    ['send mode 0', withX({ sendMode: '0' }), /sendMode/],
    ['bounce not a flag', withX({ bounce: 'true' }), /x\.bounce/],
    ['stateInit not a flag', withX({ stateInit: 'yes' }), /x\.stateInit/],
    ['StateInit on a later message', withX({ stateInit: '1' }), /first message/],
    ['empty comment', { ...base, memo: '' }, /empty comment/],
    ['comment with a lone surrogate', { ...base, memo: 'a\ud800b' }, /Unicode/],
    ['an EVM section', { ...base, evm: { nonce: 1, gasLimit: '21000', maxFeePerGas: '1', maxPriorityFeePerGas: '1' } }, /unexpected chain section/],
    ['intent version', { ...base, v: 2 as unknown as 1 }, /version/],
  ];
  for (const [name, i, re] of bad) it(name, () => {
    expect(() => tonPlugin.build(i, net)).toThrow(re);
    expect(() => tonPlugin.sign(i, net, key)).toThrow(re);
  });
  it('refuses a network definition that is not the pinned main network', () => {
    const testnet = { ...net, chainRef: '823f81f306ff02694f935cf5021548e3ce2b86b529812af6a12148879e95a128' };
    expect(() => buildTonTransfer({ ...base, chainRef: testnet.chainRef }, testnet)).toThrow(/main network/);
    expect(() => buildTonTransfer(base, { ...net, family: 'stellar' })).toThrow(/not a TON intent/);
    expect(() => buildTonTransfer(base, { ...net, native: { ...net.native, decimals: 6 } })).toThrow(/metadata/);
  });
  it('comment bytes: UTF-8, never empty', () => {
    expect(Buffer.from(tonCommentBytes('é☕')).toString('hex')).toBe('c3a9e29895');
    expect(() => tonCommentBytes('')).toThrow();
  });
  it('the intent schema and hash accept the TON section and bind every field', () => {
    expect(canonicalBytes(base).length).toBeGreaterThan(100);
    expect(() => canonicalBytes({ ...base, x: undefined })).toThrow(/chain section/);
    const h = toHex(intentHash(base));
    for (const k of Object.keys(base.x!)) expect(toHex(intentHash(withX({ [k]: k === 'validUntil' ? String(now + 301) : k === 'seqno' ? '8' : k === 'sendMode' ? '1' : base.x![k] === '1' ? '0' : '1' }))), k).not.toBe(h);
    expect(toHex(intentHash({ ...base, memo: 'a' }))).not.toBe(h);
  });
  it('changing any intent field changes the signed bytes or throws', () => {
    const ref = tonPlugin.sign(base, net, key);
    const changed: Partial<Intent>[] = [
      { amount: '1500000001' }, { to: tonFormatAddress(new Uint8Array(32).fill(9)) }, { memo: 'a' }, { from: TO }, { chainRef: 'x' }, { network: 'tron' }, { asset: 'x' }, { symbol: 'XLM' }, { decimals: 8 },
      { x: { ...base.x!, seqno: '8' } }, { x: { ...base.x!, validUntil: String(now + 301) } }, { x: { ...base.x!, bounce: '0' } }, { x: { ...base.x!, sendMode: '2' } }, { x: { ...base.x!, stateInit: '1' } },
      { expiresAt: now + 400 }, { createdAt: now + 400 },
    ];
    for (const c of changed) {
      let out: { raw: string; txid: string } | undefined;
      try { out = tonPlugin.sign({ ...base, ...c }, net, key); } catch { continue; }
      expect(out.raw, JSON.stringify(c)).not.toBe(ref.raw);
      expect(out.txid, JSON.stringify(c)).not.toBe(ref.txid);
    }
    // x.stateInit changes the envelope (not the signature, which never covers the StateInit, nor the normalized id)
    const a = tonPlugin.sign(withX({ seqno: '0' }), net, key), b = tonPlugin.sign(withX({ seqno: '0', stateInit: '1' }), net, key);
    expect(a.raw).not.toBe(b.raw);
    expect(a.txid).toBe(b.txid);
    expect(tonReadExternal(a.raw).cellHash).not.toBe(tonReadExternal(b.raw).cellHash);
    // TON has no fee field on the wire: maxFee is bound by the approval (intent hash) only
    expect(tonPlugin.sign({ ...base, maxFee: '6000000' }, net, key).raw).toBe(ref.raw);
    expect(toHex(intentHash({ ...base, maxFee: '6000000' }))).not.toBe(toHex(intentHash(base)));
  });
});
