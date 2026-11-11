// Cardano plugin: addresses against the CIP-19 vectors and the official serialization library, the transaction decoded and
// re-encoded by that library byte for byte, fee and minimum-ADA formulas against it, every fail-closed case, and the strict
// decoder run on real mainnet transactions (fixtures recorded by scripts/record-cardano-polkadot-fixtures.mts).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { bech32 } from '@scure/base';
import { mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  buildCardanoTx, canonicalBytes, cardanoAddressBytes, cardanoBaseAddress, cardanoDecodeTx, cardanoFormatInputs, cardanoMinAda, cardanoMinFee, cardanoParseInputs, cardanoPlugin,
  cardanoTxid, cborDecode, CARDANO_MAINNET_MAGIC, CARDANO_MAX_INPUTS, CARDANO_PATHS, CARDANO_SLOT_ZERO_UNIX, DEFAULT_POLICY, intentHash, isValidAddress, NETWORKS, normalizeAddress, pluginFor, toHex,
  type Intent, type KeyHandle, type NetworkDef,
} from '../src/index.ts';

const net = NETWORKS.cardano as NetworkDef;
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'; // public BIP-39 test vector
const H = 0x80000000;
// keys derived by the OFFICIAL library (independent of the signer's BIP32-Ed25519 code, which has its own test)
const account = CSL.Bip32PrivateKey.from_bip39_entropy(mnemonicToEntropy(MNEMONIC, wordlist), new Uint8Array(0)).derive(H + 1852).derive(H + 1815).derive(H);
const payPrv = account.derive(0).derive(0).to_raw_key(), stakePrv = account.derive(2).derive(0).to_raw_key();
const PAY = payPrv.to_public().as_bytes(), STAKE = stakePrv.to_public().as_bytes();
const PUB = Uint8Array.from([...PAY, ...STAKE]);
const key: KeyHandle = { curve: 'ed25519', publicKey: PUB, signMessage: (m) => payPrv.sign(m).to_bytes() };
const FROM = cardanoBaseAddress(PAY, STAKE);
// CIP-19 test vectors (https://github.com/cardano-foundation/CIPs/blob/master/CIP-0019/README.md)
const CIP19 = {
  vk: 'addr_vk1w0l2sr2zgfm26ztc6nl9xy8ghsk5sh6ldwemlpmp9xylzy4dtf7st80zhd', stakeVk: 'stake_vk1px4j0r2fk7ux5p23shz8f3y5y2qam7s954rgf3lg5merqcj6aetsft99wu',
  t0: 'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x',
  t1: 'addr1z8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gten0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs9yc0hh',
  t2: 'addr1yx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerkr0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shs2z78ve',
  t3: 'addr1x8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gt7r0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shskhj42g',
  t4: 'addr1gx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer5pnz75xxcrzqf96k',
  t6: 'addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8',
  t7: 'addr1w8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtcyjy7wx',
  t14: 'stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw',
  test0: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae',
};
const TO = CIP19.t0;
const now = 1_794_420_000, SLOT = now - CARDANO_SLOT_ZERO_UNIX;
const IN_A = { txid: 'd805937a8b98ac498a4e116c820bbc3fa316e8774583cf0468eea9223304c299', index: 0, value: 50_000_000n };
const IN_B = { txid: '0f2d0167d0437446051e9543f6e2db38fe29c67ddc11b7e33a22eab5c0ab68a1', index: 3, value: 1_500_000n };
const base: Intent = {
  v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-0123456789abcdef', createdAt: now, expiresAt: now + 120, policyVersion: 4,
  network: 'cardano', chainRef: CARDANO_MAINNET_MAGIC, asset: 'native', symbol: 'ADA', decimals: 6, amount: '2500000', from: FROM, to: TO, maxFee: '200000',
  x: { inputs: cardanoFormatInputs([IN_A]), fee: '169021', change: '47330979', ttl: String(SLOT + 900) },
};
const withX = (x: Record<string, string>, over: Partial<Intent> = {}): Intent => ({ ...base, ...over, x: { ...base.x!, ...x } });
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const lin = CSL.LinearFee.new(CSL.BigNum.from_str('44'), CSL.BigNum.from_str('155381'));

/** The same transaction built by the official library from the same fields. */
function sdkTx(i: Intent): { body: CSL.TransactionBody; hex: string } {
  const x = i.x!, ins = CSL.TransactionInputs.new();
  for (const u of cardanoParseInputs(x.inputs)) ins.add(CSL.TransactionInput.new(CSL.TransactionHash.from_hex(u.txid), u.index));
  const outs = CSL.TransactionOutputs.new();
  const out = (addr: string, v: string) => CSL.TransactionOutput.new(CSL.Address.from_bech32(addr), CSL.Value.new(CSL.BigNum.from_str(v)));
  outs.add(out(i.to, i.amount));
  if (x.change !== '0') outs.add(out(i.from, x.change!));
  const body = CSL.TransactionBody.new_tx_body(ins, outs, CSL.BigNum.from_str(x.fee!));
  body.set_ttl(CSL.BigNum.from_str(x.ttl!));
  return { body, hex: body.to_hex() };
}

describe('Cardano addresses', () => {
  it('builds the CIP-19 base address from the published keys, and the address the official library derives for the test mnemonic', () => {
    const vk = bech32.decodeToBytes(CIP19.vk).bytes, svk = bech32.decodeToBytes(CIP19.stakeVk).bytes;
    expect(cardanoBaseAddress(vk, svk)).toBe(CIP19.t0);
    const sdk = CSL.BaseAddress.new(1, CSL.Credential.from_keyhash(payPrv.to_public().hash()), CSL.Credential.from_keyhash(stakePrv.to_public().hash())).to_address().to_bech32();
    expect(FROM).toBe(sdk);
    expect(FROM).toBe('addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv');
    expect(cardanoPlugin.address(net, PUB)).toBe(FROM);
    expect(cardanoPlugin.path(net)).toBe("m/1852'/1815'/0'/0/0");
    expect(CARDANO_PATHS.stake).toBe("m/1852'/1815'/0'/2/0");
    expect(cardanoPlugin.keyScheme).toBe('cip1852');
    expect(pluginFor(net)).toBe(cardanoPlugin);
    expect(() => cardanoPlugin.address(net, PAY)).toThrow(/64 bytes/);
    expect(() => cardanoPlugin.address(net, new Uint8Array(64).fill(2))).toThrow();
  });

  it('accepts key-payment mainnet addresses and refuses everything else', () => {
    for (const a of [CIP19.t0, CIP19.t2, CIP19.t6, FROM]) { expect(normalizeAddress('cardano', a)).toBe(a); expect(CSL.Address.from_bech32(a).network_id()).toBe(1); }
    expect(normalizeAddress('cardano', CIP19.t0.toUpperCase())).toBe(CIP19.t0); // QR codes
    expect(cardanoAddressBytes(CIP19.t6).stake).toBeUndefined();
    expect(hex(cardanoAddressBytes(CIP19.t0).bytes)).toBe(CSL.Address.from_bech32(CIP19.t0).to_hex());
    for (const a of [CIP19.t1, CIP19.t3, CIP19.t7]) expect(() => normalizeAddress('cardano', a)).toThrow(/script addresses are refused/);
    for (const a of [CIP19.t4, CIP19.t14, CIP19.test0, 'Ae2tdPwUPEZFSi1cTyL1ZL6bgixhc2vSy5heg6Zg9uP7PpumkAJ82Qprt8b', 'DdzFFzCqrhsytpTj8Y1uDmPpD9PRvsq5cJLFDmVVQuLC8tzz2nmXxQgbzE5yXGd1p4VRN7Gf1qV7pJK9Hh3t3bFzgkL5CuNQ2JhU2zpW',
      CIP19.t0.slice(0, -1) + 'q', CIP19.t0.slice(0, -2), CIP19.t0 + 'q', 'A' + CIP19.t0.slice(1), '', 'addr1', 'cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4', '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'])
      expect(isValidAddress('cardano', a), a).toBe(false);
    // right checksum, wrong content: a base-address header on an enterprise-length payload, an unknown type, bech32m
    const enc = (b: Uint8Array) => bech32.encode('addr', bech32.toWords(b), 200);
    expect(isValidAddress('cardano', enc(Uint8Array.from([0x01, ...new Uint8Array(28)])))).toBe(false);
    expect(isValidAddress('cardano', enc(Uint8Array.from([0x91, ...new Uint8Array(28)])))).toBe(false);
    expect(isValidAddress('cardano', enc(Uint8Array.from([0x60, ...new Uint8Array(28)])))).toBe(false); // testnet enterprise
    expect(isValidAddress('cardano', enc(Uint8Array.from([0x61, ...new Uint8Array(28)])))).toBe(true);
  });
});

describe('Cardano transaction', () => {
  it('is decoded by the official library and re-encoded byte for byte; body, id, signature, fee and minimum ADA agree', () => {
    for (const i of [base, withX({ inputs: cardanoFormatInputs([IN_B, IN_A]), change: '48830979' }), withX({ change: '0', fee: '200000' }, { amount: '49800000' })]) {
      const b = buildCardanoTx(i, net), s = cardanoPlugin.sign(i, net, key);
      const raw = Buffer.from(s.raw, 'hex');
      expect(hex(b.body)).toBe(sdkTx(i).hex);                                   // body = what CSL builds from the same fields
      const tx = CSL.Transaction.from_hex(s.raw);
      expect(tx.to_hex()).toBe(s.raw);                                          // CSL round-trip, byte-identical
      expect(tx.is_valid()).toBe(true);
      expect(tx.auxiliary_data()).toBeUndefined();
      expect(CSL.FixedTransaction.from_hex(s.raw).transaction_hash().to_hex()).toBe(s.txid);
      expect(s.txid).toBe(hex(blake2b(b.body, { dkLen: 32 })));
      expect(cardanoTxid(s.raw)).toBe(s.txid);
      expect(raw.length).toBe(b.size);
      const w = tx.witness_set().vkeys()!;
      expect(w.len()).toBe(1);
      expect(w.get(0).vkey().public_key().to_hex()).toBe(hex(PAY));
      expect(w.get(0).vkey().public_key().verify(Buffer.from(s.txid, 'hex'), w.get(0).signature())).toBe(true);
      expect(ed25519.verify(Buffer.from(w.get(0).signature().to_hex(), 'hex'), Buffer.from(s.txid, 'hex'), PAY)).toBe(true);
      expect(cardanoPlugin.build(i, net).signDocs.map(hex)).toEqual([s.txid]);
      // fee: the library's minimum for these exact bytes equals the linear formula on the size the builder reports
      expect(CSL.min_fee(tx, lin).to_str()).toBe(cardanoMinFee(b.size, 44n, 155381n).toString());
      const body = tx.body();
      expect(body.fee().to_str()).toBe(i.x!.fee);
      expect(body.ttl_bignum()!.to_str()).toBe(i.x!.ttl);
      expect(body.outputs().len()).toBe(i.x!.change === '0' ? 1 : 2);
      expect(body.outputs().get(0).address().to_bech32()).toBe(TO);
      expect(body.outputs().get(0).amount().coin().to_str()).toBe(i.amount);
      expect(body.outputs().get(0).amount().multiasset()).toBeUndefined();
      if (i.x!.change !== '0') { expect(body.outputs().get(1).address().to_bech32()).toBe(FROM); expect(body.outputs().get(1).amount().coin().to_str()).toBe(i.x!.change); }
      for (const k of [0, 1].slice(0, body.outputs().len())) {
        const o = body.outputs().get(k);
        expect(CSL.min_ada_for_output(o, CSL.DataCost.new_coins_per_byte(CSL.BigNum.from_str('4310'))).to_str()).toBe(cardanoMinAda(o.address().to_bech32(), BigInt(o.amount().coin().to_str()), 4310n).toString());
      }
      // strict decoder
      const d = cardanoDecodeTx(raw);
      expect(d).toMatchObject({ txid: s.txid, fee: b.fee, ttl: b.ttl, bodyKeys: [0, 1, 2, 3], valid: true, hasAuxiliaryData: false });
      expect(d.inputs).toEqual(b.inputs.map(({ txid, index }) => ({ txid, index })));
      expect(d.outputs[0]).toEqual({ address: TO, addressHex: hex(cardanoAddressBytes(TO).bytes), lovelace: b.amount, assets: 0, extras: false });
    }
    expect(buildCardanoTx(base, net).size).toBe(296);
    expect(cardanoMinAda(CIP19.t0, 1n, 4310n)).toBe(969750n);   // (160 + 65) × 4310: what wallets show as "minimum 0.97 ADA"
    expect(cardanoMinAda(CIP19.t6, 1n, 4310n)).toBe(849070n);   // enterprise address: 28 bytes shorter
  });

  it('binds every field of the intent', () => {
    const ref = cardanoPlugin.sign(base, net, key);
    const variants: Intent[] = [
      { ...base, amount: '2500001', x: { ...base.x!, change: '47330978' } }, { ...base, to: CIP19.t6 }, withX({ fee: '169022', change: '47330978' }), withX({ ttl: String(SLOT + 901) }),
      withX({ inputs: cardanoFormatInputs([{ ...IN_A, index: 1 }]) }), withX({ inputs: cardanoFormatInputs([{ ...IN_A, txid: 'e' + IN_A.txid.slice(1) }]) }),
    ];
    const seen = new Set([ref.raw]);
    for (const v of variants) { const s = cardanoPlugin.sign(v, net, key); expect(seen.has(s.raw)).toBe(false); seen.add(s.raw); expect(toHex(intentHash(v))).not.toBe(toHex(intentHash(base))); }
    expect(cardanoPlugin.sign(base, net, key)).toEqual(ref); // deterministic
    expect(canonicalBytes(base).length).toBeGreaterThan(100);
  });

  it('fails closed', () => {
    const bad = (i: Intent, re: RegExp) => { expect(() => cardanoPlugin.build(i, net), String(re)).toThrow(re); expect(() => cardanoPlugin.sign(i, net, key)).toThrow(re); };
    bad({ ...base, chainRef: '1' }, /chain identity/);                               // preprod magic
    bad({ ...base, network: 'cosmos' }, /not a Cardano intent/);
    expect(() => cardanoPlugin.build(base, { ...net, chainRef: '1' })).toThrow(/only mainnet/);
    expect(() => cardanoPlugin.build(base, NETWORKS.sui as NetworkDef)).toThrow(/not a Cardano intent/);
    bad({ ...base, asset: 'f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b6988069555344' }, /only native ADA/);
    bad({ ...base, symbol: 'DOT' }, /asset metadata/);
    bad({ ...base, decimals: 8 }, /asset metadata/);
    bad({ ...base, memo: 'hello' }, /memo/);
    bad({ ...base, amount: '0', x: { ...base.x!, change: '49830979' } }, /amount must be positive/);
    bad({ ...base, to: FROM }, /destination equals source/);
    bad({ ...base, to: CIP19.t7 }, /script addresses/);
    bad({ ...base, to: CIP19.test0 }, /invalid address/);
    bad({ ...base, to: CIP19.t14 }, /invalid address/);
    bad({ ...base, from: CIP19.t6, to: FROM }, /base address/);
    bad({ ...base, maxFee: '169020' }, /fee above approved maximum/);
    bad(withX({ fee: '0', change: '47500000' }), /x\.fee out of range/);
    bad(withX({ fee: '0169021' }), /canonical/);
    bad(withX({ change: '47330980' }), /inputs do not equal/);                        // would create or destroy 1 lovelace
    bad(withX({ fee: '169020' }), /inputs do not equal/);
    bad(withX({ inputs: cardanoFormatInputs([IN_A]).replace(':50000000', ':50000001') }), /inputs do not equal/);
    bad(withX({ ttl: String(SLOT) }), /already closed/);
    bad(withX({ ttl: String(SLOT + 7201) }), /too long/);
    bad(withX({ ttl: '0' }), /x\.ttl out of range/);
    bad(withX({ inputs: '' }), /x\.inputs is missing/);
    bad(withX({ inputs: `${IN_A.txid}:0:50000000,${IN_A.txid}:0:50000000` }), /sorted/);
    bad(withX({ inputs: `${IN_A.txid}:0:50000000,${IN_B.txid}:3:1500000` }), /sorted/);
    bad(withX({ inputs: `${IN_A.txid.toUpperCase()}:0:50000000` }), /txid:index:lovelace/);
    bad(withX({ inputs: `${IN_A.txid}:00:50000000` }), /txid:index:lovelace/);
    bad(withX({ inputs: `${IN_A.txid}:65536:50000000` }), /txid:index:lovelace/);
    bad(withX({ inputs: `${IN_A.txid}:0:50000000:1` }), /txid:index:lovelace/);
    bad(withX({ inputs: Array.from({ length: CARDANO_MAX_INPUTS + 1 }, (_, k) => `${String(k).padStart(64, '0')}:0:1`).join(',') }), /too many inputs/);
    bad(withX({ metadata: 'x' }), /unknown or missing/);
    bad({ ...base, x: { inputs: base.x!.inputs!, fee: base.x!.fee!, change: base.x!.change! } }, /unknown or missing/);
    bad({ ...base, x: undefined }, /missing Cardano parameters/);
    bad({ ...base, evm: { nonce: 0, gasLimit: '1', maxFeePerGas: '1', maxPriorityFeePerGas: '1' } }, /unexpected chain section/);
    expect(() => cardanoPlugin.build(base, net, { prevTx: {} })).toThrow(/helper data/);
    expect(() => cardanoPlugin.sign(base, net, key, { publicKey: hex(PUB) })).toThrow(/helper data/);
    // keys: another wallet's key, a secp256k1 handle, a key that signs something else
    const other = Uint8Array.from([...STAKE, ...PAY]);
    expect(() => cardanoPlugin.sign(base, net, { ...key, publicKey: other })).toThrow(/does not control/);
    expect(() => cardanoPlugin.sign(base, net, { curve: 'secp256k1', publicKey: PUB })).toThrow(/ed25519/);
    expect(() => cardanoPlugin.sign(base, net, { ...key, signMessage: () => payPrv.sign(new Uint8Array(32)).to_bytes() })).toThrow(/self-check/);
    expect(() => cardanoPlugin.sign(base, net, { ...key, signMessage: () => new Uint8Array(63) })).toThrow(/self-check/);
    expect(() => cardanoTxid('00')).toThrow();
    expect(DEFAULT_POLICY.perTx['cardano:ADA']).toBe('285000000');
    expect(DEFAULT_POLICY.maxFee.cardano).toBe('500000');
  });

  it('any valid combination of fields round-trips through the official library', () => {
    fc.assert(fc.property(fc.bigInt({ min: 1n, max: 45_000_000_000_000_000n }), fc.bigInt({ min: 1n, max: 5_000_000n }), fc.bigInt({ min: 0n, max: 1_000_000_000_000n }), fc.integer({ min: 1, max: 7200 }),
      fc.uniqueArray(fc.tuple(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.integer({ min: 0, max: 600 })), { minLength: 1, maxLength: CARDANO_MAX_INPUTS, selector: ([t, n]) => hex(t) + ':' + n }),
      (amount, fee, change, dt, refs) => {
        const total = amount + fee + change, n = BigInt(refs.length);
        fc.pre(total >= n);
        const ins = refs.map(([t, index], k) => ({ txid: hex(t), index, value: k === 0 ? total - (n - 1n) : 1n }));
        const i: Intent = { ...base, amount: amount.toString(), maxFee: fee.toString(), x: { inputs: cardanoFormatInputs(ins), fee: fee.toString(), change: change.toString(), ttl: String(SLOT + dt) } };
        const s = cardanoPlugin.sign(i, net, key);
        expect(CSL.Transaction.from_hex(s.raw).to_hex()).toBe(s.raw);
        expect(hex(buildCardanoTx(i, net).body)).toBe(sdkTx(i).hex);
        expect(CSL.FixedTransaction.from_hex(s.raw).transaction_hash().to_hex()).toBe(s.txid);
      }), { numRuns: 60 });
  });
});

describe('Cardano codecs on real mainnet transactions', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/cardano-mainnet-txs.json', import.meta.url), 'utf8')) as { txs: { txid: string; cbor: string; fee: string; ttl: string | null; size: number; inputs: string[]; outputs: { address: string; lovelace: string; assets: number }[] }[] };
  it('decodes them to what the indexer reports and recomputes their transaction id from the body bytes', () => {
    expect(fx.txs.length).toBeGreaterThanOrEqual(5);
    let tagged = 0, assets = 0;
    for (const t of fx.txs) {
      const raw = Buffer.from(t.cbor, 'hex');
      const d = cardanoDecodeTx(raw, { strict: false });
      expect(d.txid, t.txid).toBe(t.txid);
      expect(raw.length - 1).toBe(t.size); // the ledger's size leaves the validity flag out
      expect(d.fee.toString()).toBe(t.fee);
      expect(d.ttl === null ? null : d.ttl.toString()).toBe(t.ttl);
      expect(d.inputs.map((u) => `${u.txid}#${u.index}`).sort()).toEqual(t.inputs);
      expect(d.outputs.map((o) => ({ address: o.address, lovelace: o.lovelace.toString(), assets: o.assets }))).toEqual(t.outputs);
      for (const w of d.witnesses) expect(ed25519.verify(w.signature, Buffer.from(t.txid, 'hex'), w.publicKey)).toBe(true); // real signatures verify against our id
      expect(CSL.FixedTransaction.from_hex(t.cbor).transaction_hash().to_hex()).toBe(t.txid);
      if (t.cbor.slice(4, 14).includes('d90102')) tagged++;
      if (t.outputs.some((o) => o.assets > 0)) assets++;
    }
    expect(tagged).toBeGreaterThan(0); // Conway tagged sets, as this wallet writes them
    expect(assets).toBeGreaterThan(0); // multi-asset outputs are recognized (and never spent by this wallet)
  });
  it('strict mode refuses non-canonical and foreign CBOR', () => {
    expect(cborDecode(Uint8Array.of(0x18, 0x18))).toBe(24n);
    for (const b of [[0x18, 0x17], [0x19, 0x00, 0xff], [0x1a, 0, 0, 0xff, 0xff], [0x1b, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff], [0x9f, 0xff], [0x20], [0x61, 0x61], [0xfb, 0, 0, 0, 0, 0, 0, 0, 0], [0x00, 0x00], [0x82, 0x00], [0xa2, 0x00, 0x00, 0x00, 0x01], [0x5a, 0xff, 0xff, 0xff, 0xff]])
      expect(() => cborDecode(Uint8Array.from(b)), hex(Uint8Array.from(b))).toThrow();
    expect(cborDecode(Uint8Array.of(0x9f, 0x01, 0xff), { strict: false })).toEqual([1n]);
    expect(cborDecode(Uint8Array.of(0x20), { strict: false })).toBe(-1n);
  });
});
