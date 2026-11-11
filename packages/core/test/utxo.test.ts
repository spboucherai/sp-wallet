// Dogecoin (legacy P2PKH through the `btc` family) and Bitcoin Cash (plugin family `bch`).
// Every signed transaction is checked by an implementation that shares no code with the builder:
// bitcoinjs-lib (Dogecoin: independent decoding and legacy signature hash) and libauth's Bitcoin Cash virtual machine.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as bitcoin from 'bitcoinjs-lib';
import {
  cashAddressToLockingBytecode, createVirtualMachineBCH, decodeTransaction, encodeCashAddress, encodeTransaction, hashTransaction,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { createBase58check, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { p2pkh } from '@scure/btc-signer';
import {
  bchPlugin, bchSighash, bchTxid, btcParams, buildBchTx, buildBtcTx, canonicalBytes, cashaddrDecode, cashaddrEncode, checkPolicy, decodeBchTx,
  DEFAULT_POLICY, encodeBchInputs, encodeBchTx, estimateBchSize, estimateBtcVsize, intentHash, isValidAddress, NETWORKS, normalizeAddress,
  pluginFor, type Intent, type KeyHandle,
} from '../src/index.ts';

// Public BIP-39 test vector mnemonic — holds no funds, never used outside tests.
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
const derive = (path: string) => { const k = root.derive(path); return { priv: k.privateKey!, pub: k.publicKey! }; };
/** Same shape as the signer's key handle: the plugin only ever sees this callback. */
const handleOf = ({ priv, pub }: { priv: Uint8Array; pub: Uint8Array }): KeyHandle => ({
  curve: 'secp256k1', publicKey: pub,
  signDigest: (digest) => {
    const sig = secp256k1.sign(digest, priv, { prehash: false, lowS: true, format: 'recovered' });
    const compact = sig.slice(1);
    return { compact, recovery: sig[0]!, der: secp256k1.Signature.fromBytes(compact, 'compact').toBytes('der') };
  },
});
const hash160 = (b: Uint8Array) => ripemd160(sha256(b));
const now = 1_800_000_000;
const base = { v: 1 as const, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-0123456789abcdef', createdAt: now, expiresAt: now + 120, policyVersion: 3 };

// ------------------------------------------------------------------------------------------------ Dogecoin

const DOGE = NETWORKS.dogecoin;
const DOGE_JS: bitcoin.Network = { messagePrefix: '\x19Dogecoin Signed Message:\n', bech32: 'doge', bip32: { public: 0x02facafd, private: 0x02fac398 }, pubKeyHash: 0x1e, scriptHash: 0x16, wif: 0x9e };
const dogeKey = derive("m/44'/3'/0'/0/0");
// first address of m/44'/3'/0'/0 for this seed in bip_utils' published vectors (tests/bip/bip44/test_bip44.py, Dogecoin)
const DOGE_ADDR = 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC';
const DOGE_TO = 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L';

/** A synthetic previous transaction paying `value` to `addr` at output 1 (output 0 pays someone else). */
function prevTx(addr: string, value: bigint, salt: number): { hex: string; txid: string } {
  const t = new bitcoin.Transaction();
  t.version = 1;
  t.addInput(new Uint8Array(32).fill(salt), 0, 0xffffffff, Uint8Array.of(0x51));
  t.addOutput(bitcoin.address.toOutputScript(DOGE_TO, DOGE_JS), 123_456_789n);
  t.addOutput(bitcoin.address.toOutputScript(addr, DOGE_JS), value);
  return { hex: t.toHex(), txid: t.getId() };
}
const prevA = prevTx(DOGE_ADDR, 30_000_000_000n, 7), prevB = prevTx(DOGE_ADDR, 5_000_000_000n, 9);
const dogeAux = { prevTx: { [prevA.txid]: prevA.hex, [prevB.txid]: prevB.hex } };
const dogeIntent: Intent = { ...base, network: 'dogecoin', chainRef: DOGE.chainRef, asset: 'native', symbol: 'DOGE', decimals: 8, amount: '32000000000',
  from: DOGE_ADDR, to: DOGE_TO, maxFee: '100000000',
  btc: { inputs: [{ txid: prevA.txid, vout: 1, value: '30000000000' }, { txid: prevB.txid, vout: 1, value: '5000000000' }], change: '2996000000', fee: '4000000' } };

function signDoge(i: Intent, aux: Record<string, unknown> = dogeAux): string {
  const tx = buildBtcTx(i, aux);
  tx.sign(dogeKey.priv);
  tx.finalize();
  return tx.hex;
}

/**
 * Independent check of a signed legacy transaction: decode with bitcoinjs-lib, then evaluate each input's P2PKH script
 * (OP_DUP OP_HASH160 <hash> OP_EQUALVERIFY OP_CHECKSIG) with bitcoinjs-lib's signature hash and strict signature decoding.
 */
function verifyLegacy(raw: string, prevouts: { script: Uint8Array; value: bigint }[]): { tx: bitcoin.Transaction; fee: bigint } {
  const tx = bitcoin.Transaction.fromHex(raw);
  expect(tx.toHex()).toBe(raw);
  expect(tx.hasWitnesses()).toBe(false);
  expect(tx.ins.length).toBe(prevouts.length);
  tx.ins.forEach((input, k) => {
    const chunks = bitcoin.script.decompile(input.script)!;
    expect(chunks.length).toBe(2);
    const [sigWithType, pub] = chunks as [Uint8Array, Uint8Array];
    const lock = bitcoin.script.decompile(prevouts[k]!.script)!;
    expect(lock.length).toBe(5);
    expect([lock[0], lock[1], lock[3], lock[4]]).toEqual([bitcoin.opcodes.OP_DUP, bitcoin.opcodes.OP_HASH160, bitcoin.opcodes.OP_EQUALVERIFY, bitcoin.opcodes.OP_CHECKSIG]);
    expect(hex.encode(hash160(pub))).toBe(hex.encode(lock[2] as Uint8Array)); // OP_EQUALVERIFY
    const { signature, hashType } = bitcoin.script.signature.decode(sigWithType); // strict DER
    expect(hashType).toBe(bitcoin.Transaction.SIGHASH_ALL);
    const digest = tx.hashForSignature(k, prevouts[k]!.script, hashType);
    expect(secp256k1.verify(signature, digest, pub, { prehash: false, lowS: true }), `input ${k}`).toBe(true); // OP_CHECKSIG
  });
  const fee = prevouts.reduce((s, p) => s + p.value, 0n) - tx.outs.reduce((s, o) => s + o.value, 0n);
  return { tx, fee };
}

describe('Dogecoin (legacy P2PKH)', () => {
  const lock = bitcoin.address.toOutputScript(DOGE_ADDR, DOGE_JS);

  it('registry: coin type 3, legacy P2PKH, Dogecoin Core soft dust limit, default-deny caps', () => {
    expect(DOGE).toMatchObject({ family: 'btc', coinType: 3, chainRef: '1a91e3dace36e2be3bf030a65679fe821aa1d6ef92e7c9902eb318182c355691' });
    expect(DOGE.utxo).toMatchObject({ pubKeyHash: 0x1e, scriptHash: 0x16, kind: 'pkh', dust: 1_000_000 });
    expect(DOGE.utxo!.bech32).toBeUndefined();
    expect(DOGE.rpc.length).toBe(2);
    expect(DEFAULT_POLICY.perTx['dogecoin:DOGE']).toBe('70000000000');
    expect(DEFAULT_POLICY.maxFee.dogecoin).toBe('100000000');
    expect(checkPolicy(DEFAULT_POLICY, dogeIntent, 0n, now, false)).toEqual({ ok: true });
    expect(checkPolicy(DEFAULT_POLICY, { ...dogeIntent, amount: '70000000001' }, 0n, now, false).ok).toBe(false);
    expect(checkPolicy(DEFAULT_POLICY, { ...dogeIntent, maxFee: '100000001' }, 0n, now, false).ok).toBe(false);
  });

  it('derives the published address for the test mnemonic (m/44\'/3\'/0\'/0/0), also with bitcoinjs-lib', () => {
    expect(p2pkh(dogeKey.pub, btcParams(DOGE)).address).toBe(DOGE_ADDR);
    expect(bitcoin.payments.p2pkh({ pubkey: dogeKey.pub, network: DOGE_JS }).address).toBe(DOGE_ADDR);
  });

  it('validates Dogecoin addresses only', () => {
    expect(normalizeAddress('dogecoin', DOGE_ADDR)).toBe(DOGE_ADDR);
    expect(normalizeAddress('dogecoin', 'A2ZTaCjZFTMrYqebSpLZLE7WNeB6EgUDXs')).toBe('A2ZTaCjZFTMrYqebSpLZLE7WNeB6EgUDXs'); // P2SH (0x16)
    for (const bad of ['DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgD', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'LaMT348PWRnrqeeWArpwQPbuanpXDZGEUz',
      'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh', 'bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6'])
      expect(isValidAddress('dogecoin', bad), bad).toBe(false);
    expect(isValidAddress('bitcoin', DOGE_ADDR)).toBe(false);
    expect(isValidAddress('litecoin', DOGE_ADDR)).toBe(false);
  });

  it('builds and signs a two-input transfer that bitcoinjs-lib decodes and verifies input by input', () => {
    const raw = signDoge(dogeIntent);
    const { tx, fee } = verifyLegacy(raw, [{ script: lock, value: 30_000_000_000n }, { script: lock, value: 5_000_000_000n }]);
    expect(tx.ins.map((x) => `${hex.encode(Uint8Array.from(x.hash).reverse())}:${x.index}`)).toEqual([`${prevA.txid}:1`, `${prevB.txid}:1`]);
    expect(tx.outs.length).toBe(2);
    expect(bitcoin.address.fromOutputScript(tx.outs[0]!.script, DOGE_JS)).toBe(DOGE_TO);
    expect(tx.outs[0]!.value).toBe(32_000_000_000n);
    expect(bitcoin.address.fromOutputScript(tx.outs[1]!.script, DOGE_JS)).toBe(DOGE_ADDR); // change only to the wallet
    expect(tx.outs[1]!.value).toBe(2_996_000_000n);
    expect(fee).toBe(4_000_000n);
    expect(tx.locktime).toBe(0);
    // the size estimate used for the fee is an upper bound of the real size
    expect(estimateBtcVsize(2, DOGE_TO, true, DOGE)).toBeGreaterThanOrEqual(raw.length / 2);
    // no change output when the intent says so; P2SH destination
    const p2sh = 'A2ZTaCjZFTMrYqebSpLZLE7WNeB6EgUDXs';
    const one = signDoge({ ...dogeIntent, to: p2sh, amount: '29990000000', btc: { inputs: [dogeIntent.btc!.inputs[0]!], change: '0', fee: '10000000' } });
    const r = verifyLegacy(one, [{ script: lock, value: 30_000_000_000n }]);
    expect(r.tx.outs.length).toBe(1);
    expect(bitcoin.address.fromOutputScript(r.tx.outs[0]!.script, DOGE_JS)).toBe(p2sh);
    expect(r.fee).toBe(10_000_000n);
  });

  it('a signature made over other data does not verify (the check above is not vacuous)', () => {
    const tx = bitcoin.Transaction.fromHex(signDoge(dogeIntent));
    const [sigWithType, pub] = bitcoin.script.decompile(tx.ins[0]!.script) as [Uint8Array, Uint8Array];
    const { signature } = bitcoin.script.signature.decode(sigWithType);
    tx.outs[0]!.value += 1n;
    expect(secp256k1.verify(signature, tx.hashForSignature(0, lock, 1), pub, { prehash: false })).toBe(false);
  });

  it('verifies the unauthenticated previous transactions against the approved inputs', () => {
    const b = dogeIntent.btc!;
    expect(() => buildBtcTx(dogeIntent)).toThrow(/missing previous transaction/);
    expect(() => buildBtcTx(dogeIntent, { prevTx: { [prevA.txid]: prevA.hex } })).toThrow(/missing previous transaction/);
    // a previous transaction that is not the one named by the input
    expect(() => buildBtcTx(dogeIntent, { prevTx: { ...dogeAux.prevTx, [prevA.txid]: prevB.hex } })).toThrow(/does not match input txid/);
    // an inflated input value (legacy signatures do not commit to it: the difference would silently become fee)
    expect(() => buildBtcTx({ ...dogeIntent, btc: { ...b, inputs: [{ ...b.inputs[0]!, value: '31000000000' }, b.inputs[1]!], change: '3996000000' } }, dogeAux)).toThrow(/does not match the approved input/);
    // an output that does not pay the wallet
    expect(() => buildBtcTx({ ...dogeIntent, amount: '100000000', btc: { ...b, inputs: [{ ...b.inputs[0]!, vout: 0, value: '123456789' }], change: '19456789' } }, dogeAux)).toThrow(/does not match the approved input/);
    expect(() => buildBtcTx({ ...dogeIntent, btc: { ...b, inputs: [{ ...b.inputs[0]!, vout: 2 }, b.inputs[1]!] } }, dogeAux)).toThrow();
  });

  it('fails closed', () => {
    const b = dogeIntent.btc!;
    const bad = (m: Partial<Intent>, re: RegExp) => expect(() => buildBtcTx({ ...dogeIntent, ...m }, dogeAux), re.source).toThrow(re);
    bad({ btc: { ...b, fee: '4000001' } }, /inputs != outputs/);
    bad({ maxFee: '3999999' }, /fee exceeds/);
    bad({ amount: '999999', btc: { ...b, change: '34995000001' } }, /amount below dust/);
    bad({ amount: '34995500000', btc: { ...b, change: '500000' } }, /change below dust/);
    bad({ btc: { ...b, inputs: [b.inputs[0]!, b.inputs[0]!] } }, /duplicate/);
    bad({ chainRef: NETWORKS.litecoin.chainRef }, /chain identity/);
    bad({ asset: 'DOGE' }, /asset/);
    bad({ symbol: 'LTC' }, /asset/);
    bad({ decimals: 6 }, /asset/);
    bad({ to: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa' }, /./);
    bad({ to: ` ${DOGE_TO}` }, /./);
    bad({ from: 'A2ZTaCjZFTMrYqebSpLZLE7WNeB6EgUDXs' }, /P2PKH/);
    expect(() => canonicalBytes({ ...dogeIntent, btc: undefined, x: { inputs: 'a' } })).toThrow(/chain section/);
  });

  it('changing any intent field changes the signed bytes, the approval hash, or throws', () => {
    const ref = signDoge(dogeIntent), refHash = hex.encode(intentHash(dogeIntent)), b = dogeIntent.btc!;
    const muts: Partial<Intent>[] = [
      { to: 'DMhCxuxFe98xQhic6QEFdw7gWBCy6u9jMS' },
      { amount: '32000000001', btc: { ...b, change: '2995999999' } },
      { btc: { ...b, change: '2995000000', fee: '5000000' } },
      { btc: { ...b, inputs: [b.inputs[1]!, b.inputs[0]!] } },
      { amount: '32000000001' }, { maxFee: '1' }, { from: DOGE_TO }, { network: 'litecoin' }, { chainRef: 'x' },
    ];
    for (const m of muts) {
      let out: string | null = null;
      try { out = signDoge({ ...dogeIntent, ...m }); } catch { /* refused */ }
      expect(out, JSON.stringify(m)).not.toBe(ref);
      let h: string | null = null;
      try { h = hex.encode(intentHash({ ...dogeIntent, ...m })); } catch { /* refused */ }
      expect(h).not.toBe(refHash);
    }
  });
});

// ------------------------------------------------------------------------------------------------ CashAddr

const BCH = NETWORKS.bitcoincash;
const b58 = createBase58check(sha256);

describe('CashAddr (specification vectors)', () => {
  // https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/cashaddr.md — "Examples of address translation"
  const TRANSLATION: [string, string][] = [
    ['1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu', 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'],
    ['1KXrWXciRDZUpQwQmuM1DbwsKDLYAYsVLR', 'bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy'],
    ['16w1D5WRVKJuZUsSRzdLp9w3YGcgoxDXb', 'bitcoincash:qqq3728yw0y47sqn6l2na30mcw6zm78dzqre909m2r'],
    ['3CWFddi6m4ndiGyKqzYvsFYagqDLPVMTzC', 'bitcoincash:ppm2qsznhks23z7629mms6s4cwef74vcwvn0h829pq'],
    ['3LDsS579y7sruadqu11beEJoTjdFiFCdX4', 'bitcoincash:pr95sy3j9xwd2ap32xkykttr4cvcu7as4yc93ky28e'],
    ['31nwvkZwyPdgzjBJZXfDmSWsC4ZLKpYyUw', 'bitcoincash:pqq3728yw0y47sqn6l2na30mcw6zm78dzq5ucqzc37'],
  ];
  // same document — "Larger Test Vectors": [type, address, payload]
  const LARGER: [number, string, string][] = [
    [0, 'bitcoincash:qr6m7j9njldwwzlg9v7v53unlr4jkmx6eylep8ekg2', 'F5BF48B397DAE70BE82B3CCA4793F8EB2B6CDAC9'],
    [1, 'bchtest:pr6m7j9njldwwzlg9v7v53unlr4jkmx6eyvwc0uz5t', 'F5BF48B397DAE70BE82B3CCA4793F8EB2B6CDAC9'],
    [1, 'pref:pr6m7j9njldwwzlg9v7v53unlr4jkmx6ey65nvtks5', 'F5BF48B397DAE70BE82B3CCA4793F8EB2B6CDAC9'],
    [15, 'prefix:0r6m7j9njldwwzlg9v7v53unlr4jkmx6ey3qnjwsrf', 'F5BF48B397DAE70BE82B3CCA4793F8EB2B6CDAC9'],
    [0, 'bitcoincash:q9adhakpwzztepkpwp5z0dq62m6u5v5xtyj7j3h2ws4mr9g0', '7ADBF6C17084BC86C1706827B41A56F5CA32865925E946EA'],
    [1, 'bchtest:p9adhakpwzztepkpwp5z0dq62m6u5v5xtyj7j3h2u94tsynr', '7ADBF6C17084BC86C1706827B41A56F5CA32865925E946EA'],
    [1, 'pref:p9adhakpwzztepkpwp5z0dq62m6u5v5xtyj7j3h2khlwwk5v', '7ADBF6C17084BC86C1706827B41A56F5CA32865925E946EA'],
    [15, 'prefix:09adhakpwzztepkpwp5z0dq62m6u5v5xtyj7j3h2p29kc2lp', '7ADBF6C17084BC86C1706827B41A56F5CA32865925E946EA'],
    [0, 'bitcoincash:qgagf7w02x4wnz3mkwnchut2vxphjzccwxgjvvjmlsxqwkcw59jxxuz', '3A84F9CF51AAE98A3BB3A78BF16A6183790B18719126325BFC0C075B'],
    [1, 'bchtest:pgagf7w02x4wnz3mkwnchut2vxphjzccwxgjvvjmlsxqwkcvs7md7wt', '3A84F9CF51AAE98A3BB3A78BF16A6183790B18719126325BFC0C075B'],
    [1, 'pref:pgagf7w02x4wnz3mkwnchut2vxphjzccwxgjvvjmlsxqwkcrsr6gzkn', '3A84F9CF51AAE98A3BB3A78BF16A6183790B18719126325BFC0C075B'],
    [15, 'prefix:0gagf7w02x4wnz3mkwnchut2vxphjzccwxgjvvjmlsxqwkc5djw8s9g', '3A84F9CF51AAE98A3BB3A78BF16A6183790B18719126325BFC0C075B'],
    [0, 'bitcoincash:qvch8mmxy0rtfrlarg7ucrxxfzds5pamg73h7370aa87d80gyhqxq5nlegake', '3173EF6623C6B48FFD1A3DCC0CC6489B0A07BB47A37F47CFEF4FE69DE825C060'],
    [1, 'bchtest:pvch8mmxy0rtfrlarg7ucrxxfzds5pamg73h7370aa87d80gyhqxq7fqng6m6', '3173EF6623C6B48FFD1A3DCC0CC6489B0A07BB47A37F47CFEF4FE69DE825C060'],
    [1, 'pref:pvch8mmxy0rtfrlarg7ucrxxfzds5pamg73h7370aa87d80gyhqxq4k9m7qf9', '3173EF6623C6B48FFD1A3DCC0CC6489B0A07BB47A37F47CFEF4FE69DE825C060'],
    [15, 'prefix:0vch8mmxy0rtfrlarg7ucrxxfzds5pamg73h7370aa87d80gyhqxqsh6jgp6w', '3173EF6623C6B48FFD1A3DCC0CC6489B0A07BB47A37F47CFEF4FE69DE825C060'],
    [0, 'bitcoincash:qnq8zwpj8cq05n7pytfmskuk9r4gzzel8qtsvwz79zdskftrzxtar994cgutavfklv39gr3uvz', 'C07138323E00FA4FC122D3B85B9628EA810B3F381706385E289B0B25631197D194B5C238BEB136FB'],
    [1, 'bchtest:pnq8zwpj8cq05n7pytfmskuk9r4gzzel8qtsvwz79zdskftrzxtar994cgutavfklvmgm6ynej', 'C07138323E00FA4FC122D3B85B9628EA810B3F381706385E289B0B25631197D194B5C238BEB136FB'],
    [1, 'pref:pnq8zwpj8cq05n7pytfmskuk9r4gzzel8qtsvwz79zdskftrzxtar994cgutavfklv0vx5z0w3', 'C07138323E00FA4FC122D3B85B9628EA810B3F381706385E289B0B25631197D194B5C238BEB136FB'],
    [15, 'prefix:0nq8zwpj8cq05n7pytfmskuk9r4gzzel8qtsvwz79zdskftrzxtar994cgutavfklvwsvctzqy', 'C07138323E00FA4FC122D3B85B9628EA810B3F381706385E289B0B25631197D194B5C238BEB136FB'],
    [0, 'bitcoincash:qh3krj5607v3qlqh5c3wq3lrw3wnuxw0sp8dv0zugrrt5a3kj6ucysfz8kxwv2k53krr7n933jfsunqex2w82sl', 'E361CA9A7F99107C17A622E047E3745D3E19CF804ED63C5C40C6BA763696B98241223D8CE62AD48D863F4CB18C930E4C'],
    [1, 'bchtest:ph3krj5607v3qlqh5c3wq3lrw3wnuxw0sp8dv0zugrrt5a3kj6ucysfz8kxwv2k53krr7n933jfsunqnzf7mt6x', 'E361CA9A7F99107C17A622E047E3745D3E19CF804ED63C5C40C6BA763696B98241223D8CE62AD48D863F4CB18C930E4C'],
    [1, 'pref:ph3krj5607v3qlqh5c3wq3lrw3wnuxw0sp8dv0zugrrt5a3kj6ucysfz8kxwv2k53krr7n933jfsunqjntdfcwg', 'E361CA9A7F99107C17A622E047E3745D3E19CF804ED63C5C40C6BA763696B98241223D8CE62AD48D863F4CB18C930E4C'],
    [15, 'prefix:0h3krj5607v3qlqh5c3wq3lrw3wnuxw0sp8dv0zugrrt5a3kj6ucysfz8kxwv2k53krr7n933jfsunqakcssnmn', 'E361CA9A7F99107C17A622E047E3745D3E19CF804ED63C5C40C6BA763696B98241223D8CE62AD48D863F4CB18C930E4C'],
    [0, 'bitcoincash:qmvl5lzvdm6km38lgga64ek5jhdl7e3aqd9895wu04fvhlnare5937w4ywkq57juxsrhvw8ym5d8qx7sz7zz0zvcypqscw8jd03f', 'D9FA7C4C6EF56DC4FF423BAAE6D495DBFF663D034A72D1DC7D52CBFE7D1E6858F9D523AC0A7A5C34077638E4DD1A701BD017842789982041'],
    [1, 'bchtest:pmvl5lzvdm6km38lgga64ek5jhdl7e3aqd9895wu04fvhlnare5937w4ywkq57juxsrhvw8ym5d8qx7sz7zz0zvcypqs6kgdsg2g', 'D9FA7C4C6EF56DC4FF423BAAE6D495DBFF663D034A72D1DC7D52CBFE7D1E6858F9D523AC0A7A5C34077638E4DD1A701BD017842789982041'],
    [1, 'pref:pmvl5lzvdm6km38lgga64ek5jhdl7e3aqd9895wu04fvhlnare5937w4ywkq57juxsrhvw8ym5d8qx7sz7zz0zvcypqsammyqffl', 'D9FA7C4C6EF56DC4FF423BAAE6D495DBFF663D034A72D1DC7D52CBFE7D1E6858F9D523AC0A7A5C34077638E4DD1A701BD017842789982041'],
    [15, 'prefix:0mvl5lzvdm6km38lgga64ek5jhdl7e3aqd9895wu04fvhlnare5937w4ywkq57juxsrhvw8ym5d8qx7sz7zz0zvcypqsgjrqpnw8', 'D9FA7C4C6EF56DC4FF423BAAE6D495DBFF663D034A72D1DC7D52CBFE7D1E6858F9D523AC0A7A5C34077638E4DD1A701BD017842789982041'],
    [0, 'bitcoincash:qlg0x333p4238k0qrc5ej7rzfw5g8e4a4r6vvzyrcy8j3s5k0en7calvclhw46hudk5flttj6ydvjc0pv3nchp52amk97tqa5zygg96mtky5sv5w', 'D0F346310D5513D9E01E299978624BA883E6BDA8F4C60883C10F28C2967E67EC77ECC7EEEAEAFC6DA89FAD72D11AC961E164678B868AEEEC5F2C1DA08884175B'],
    [1, 'bchtest:plg0x333p4238k0qrc5ej7rzfw5g8e4a4r6vvzyrcy8j3s5k0en7calvclhw46hudk5flttj6ydvjc0pv3nchp52amk97tqa5zygg96mc773cwez', 'D0F346310D5513D9E01E299978624BA883E6BDA8F4C60883C10F28C2967E67EC77ECC7EEEAEAFC6DA89FAD72D11AC961E164678B868AEEEC5F2C1DA08884175B'],
    [1, 'pref:plg0x333p4238k0qrc5ej7rzfw5g8e4a4r6vvzyrcy8j3s5k0en7calvclhw46hudk5flttj6ydvjc0pv3nchp52amk97tqa5zygg96mg7pj3lh8', 'D0F346310D5513D9E01E299978624BA883E6BDA8F4C60883C10F28C2967E67EC77ECC7EEEAEAFC6DA89FAD72D11AC961E164678B868AEEEC5F2C1DA08884175B'],
    [15, 'prefix:0lg0x333p4238k0qrc5ej7rzfw5g8e4a4r6vvzyrcy8j3s5k0en7calvclhw46hudk5flttj6ydvjc0pv3nchp52amk97tqa5zygg96ms92w6845', 'D0F346310D5513D9E01E299978624BA883E6BDA8F4C60883C10F28C2967E67EC77ECC7EEEAEAFC6DA89FAD72D11AC961E164678B868AEEEC5F2C1DA08884175B'],
  ];

  it('translates the specification\'s legacy addresses', () => {
    for (const [legacy, cash] of TRANSLATION) {
      const raw = b58.decode(legacy), type = raw[0] === 0 ? 0 : 1;
      expect(cashaddrEncode('bitcoincash', type, raw.slice(1))).toBe(cash);
      const d = cashaddrDecode(cash);
      expect([d.prefix, d.type, hex.encode(d.hash)]).toEqual(['bitcoincash', type, hex.encode(raw.slice(1))]);
      expect(normalizeAddress('bitcoincash', cash)).toBe(cash);
      if (type === 0) expect(normalizeAddress('bitcoincash', legacy)).toBe(cash);
      else expect(() => normalizeAddress('bitcoincash', legacy)).toThrow(/ambiguous/); // "3…" may be a Bitcoin SegWit script
    }
  });

  it('encodes and decodes every larger test vector (160 to 512 bits, four prefixes)', () => {
    expect(LARGER.length).toBe(32);
    for (const [type, addr, payload] of LARGER) {
      const prefix = addr.split(':')[0]!;
      expect(cashaddrEncode(prefix, type, hex.decode(payload.toLowerCase()))).toBe(addr);
      const d = cashaddrDecode(addr);
      expect([d.prefix, d.type, hex.encode(d.hash).toUpperCase()]).toEqual([prefix, type, payload]);
      expect(cashaddrDecode(addr.split(':')[1]!, prefix).type).toBe(type); // prefix supplied by context
      expect(cashaddrDecode(addr.toUpperCase()).type).toBe(type);
    }
  });

  it('rejects every single-character substitution, mixed case, wrong prefix and malformed strings', () => {
    const good = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', body = good.split(':')[1]!;
    for (let k = 0; k < body.length; k++) for (const ch of 'qpzry9x8gf2tvdw0s3jn54khce6mua7l') {
      if (ch === body[k]) continue;
      expect(() => cashaddrDecode(`bitcoincash:${body.slice(0, k)}${ch}${body.slice(k + 1)}`)).toThrow();
    }
    expect(() => cashaddrDecode('bitcoincash:Qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a')).toThrow(/mixed/);
    expect(() => cashaddrDecode(body)).toThrow(/prefix/);
    expect(() => cashaddrDecode(body, 'bchtest')).toThrow(/checksum/); // the prefix is part of the checksum
    expect(() => cashaddrDecode(`bchtest:${body}`)).toThrow(/checksum/);
    expect(() => cashaddrDecode('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6b')).toThrow();
    expect(() => cashaddrDecode('bitcoincash:')).toThrow();
    expect(() => cashaddrDecode('a:b:c')).toThrow();
    expect(() => cashaddrEncode('bitcoincash', 0, new Uint8Array(21))).toThrow();
  });

  it('agrees with libauth on random hashes', () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 20, maxLength: 20 }), fc.boolean(), (h, sh) => {
      const ours = cashaddrEncode('bitcoincash', sh ? 1 : 0, h);
      const theirs = encodeCashAddress({ prefix: 'bitcoincash', type: sh ? 'p2sh' : 'p2pkh', payload: h });
      return typeof theirs !== 'string' && theirs.address === ours && normalizeAddress('bitcoincash', ours) === ours;
    }), { numRuns: 200 });
  });

  it('the wallet accepts only Bitcoin Cash P2PKH / P2SH destinations and always returns the prefixed lowercase form', () => {
    const a = 'bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy';
    expect(normalizeAddress('bitcoincash', a.split(':')[1]!)).toBe(a);
    expect(normalizeAddress('bitcoincash', a.toUpperCase())).toBe(a);
    expect(normalizeAddress('bitcoincash', `  ${a} `)).toBe(a);
    const h20 = hex.decode('f5bf48b397dae70be82b3cca4793f8eb2b6cdac9');
    for (const bad of [
      'bchtest:pr6m7j9njldwwzlg9v7v53unlr4jkmx6eyvwc0uz5t', // testnet
      cashaddrEncode('bitcoincash', 2, h20), cashaddrEncode('bitcoincash', 3, h20), // token-aware types
      cashaddrEncode('bitcoincash', 1, new Uint8Array(32).fill(7)), // 32-byte script hash
      cashaddrEncode('simpleledger', 0, h20), cashaddrEncode('ecash', 0, h20),
      'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC', 'LaMT348PWRnrqeeWArpwQPbuanpXDZGEUz',
      '1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggv', '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', '',
    ]) expect(isValidAddress('bitcoincash', bad), bad).toBe(false);
    expect(isValidAddress('bitcoin', a)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ Bitcoin Cash

const bchKey = derive("m/44'/145'/0'/0/0"), bchHandle = handleOf(bchKey);
// first address of m/44'/145'/0'/0 for this seed in bip_utils' published vectors (tests/bip/bip44/test_bip44.py, BitcoinCash)
const BCH_ADDR = 'bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6', BCH_LEGACY = '1mW6fDEMjKrDHvLvoEsaeLxSCzZBf3Bfg';
const BCH_TO = 'bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy';
const IN_A = { txid: 'aa'.repeat(32), vout: 1, value: 150_000n }, IN_B = { txid: '0123456789abcdef'.repeat(4), vout: 0, value: 60_000n };
const bchIntent: Intent = { ...base, network: 'bitcoincash', chainRef: BCH.chainRef, asset: 'native', symbol: 'BCH', decimals: 8, amount: '180000',
  from: BCH_ADDR, to: BCH_TO, maxFee: '50000', x: { inputs: encodeBchInputs([IN_A, IN_B]), change: '29600', fee: '400' } };
const plugin = pluginFor(BCH);
const vm = createVirtualMachineBCH(true); // standard (relay) rules
const lockOf = (addr: string) => { const r = cashAddressToLockingBytecode(addr); if (typeof r === 'string') throw new Error(r); return r.bytecode; };

/** libauth decodes the transaction and runs every input through the Bitcoin Cash virtual machine. */
function vmVerify(raw: string, sources: { addr: string; value: bigint }[]): string | true {
  const tx = decodeTransaction(hex.decode(raw));
  if (typeof tx === 'string') return tx;
  return vm.verify({ transaction: tx, sourceOutputs: sources.map((s) => ({ lockingBytecode: lockOf(s.addr), valueSatoshis: s.value })) });
}

describe('Bitcoin Cash signature digest (Bitcoin Cash Node vectors)', () => {
  // bitcoin-cash-node src/test/data/sighash.json: every vector whose hash type is SIGHASH_ALL|FORKID (low byte 0x41; the
  // upper bits are a random fork id). [raw transaction, script code, input index, hash type, digest]; the amount is 0.
  const VECTORS: [string, string, number, number, string][] = [
    ['13938a7d011e4545c281cbd8c6c85c796194285adb908ab052755cf65b60c5f7fc7e0e125c020000000953530000ac6a526a00d36774ce04d94bb802000000000600516353ac63f9f9fe000000000000b0123a05000000000251ace0b7c10400000000055351abab6300000000', '5300655100', 0, 467995457, '6bfb3e169f83f480b12c45223182650ae9dfa1e6be45e42a70b4bfdbf75cf923'],
    ['753ca84702758209899178670a37c457207494591a31ece76b9654e35d9e38e3e0879462e2030000000952ab515253acab63656d0120aae21ec8043302ace9d58d296672649452875895946eaf44942c410b16df1cef2f020000000400635200ffffffff0348b17202000000000665526a525365d8ada10300000000056563510051d47f54030000000009536aab65abac0052652963ff8d', '', 0, -1911846847, 'd550d784646703f7db64c8755a5cd58b8ea736e6e344542bd206c21cc569a82e'],
    ['ddadc1eb045d16b79907449cc9f00f7f74e4b8dc891417c1ffed225d5f6665980ca500d3df0000000005acab53ac5277506c8885fe8846264f4e1d2721b4a4d0795bd55d2cf5a43164713a42b813995408024d0200000007abab00635353abffffffff6992b2678018777756025009c13fec6e53b7d1b59ae5f36cb771c61a43a8161d010000000353ababffffffff0c59a711c690c00a13a9d3a9125d3b45db372c26841d9b902932310246695b1c01000000046a51ac006176e522016ef66d0300000000010000000000', 'ab6a6a63516aac65', 0, -1625231295, 'd6fe4e12b301525576c14ca489d6edb914c5326f02c63ed5097b78ad6c51d827'],
    ['b70fefc0023bff2a865f7dada7a5f57b8ea9351a4cae4dd639de6cd5ae4e0156df0e4628b4010000000763655153526365ffffffff3a1fbc317ab7a6a7cfcb6e28fef05f5a7c0da6b874d8e61259da947d14a0e9070000000003ac65abffffffff0291e50903000000000251ac299d31050000000002630000000000', 'ab6aacacac5200', 1, -358440639, 'b23f645bdf00519876d9e9fad62f25e94403ee8add3af9294c9acda93ea3e5b9'],
  ];
  it('reproduces the published digests and re-encodes the vectors byte for byte', () => {
    for (const [raw, script, index, hashType, digest] of VECTORS) {
      const tx = decodeBchTx(hex.decode(raw));
      expect(hex.encode(encodeBchTx(tx))).toBe(raw);
      expect((hashType >>> 0) & 0xff).toBe(0x41);
      expect(hex.encode(bchSighash(tx, index, hex.decode(script), 0n, hashType >>> 0).reverse())).toBe(digest); // uint256 is printed reversed
    }
  });
  it('refuses any other signature hash type', () => {
    const tx = decodeBchTx(hex.decode(VECTORS[0]![0]));
    for (const t of [0x01, 0x40, 0x42, 0x43, 0xc1, 0x61, 0x81]) expect(() => bchSighash(tx, 0, new Uint8Array(0), 0n, t)).toThrow(/SIGHASH_ALL/);
    expect(() => bchSighash(tx, 5, new Uint8Array(0), 0n)).toThrow(/index/);
    expect(() => decodeBchTx(hex.decode(VECTORS[0]![0] + '00'))).toThrow(/trailing/);
    expect(() => decodeBchTx(hex.decode(VECTORS[0]![0].slice(0, -2)))).toThrow(/truncated/);
  });
});

describe('Bitcoin Cash plugin', () => {
  it('registry and policy', () => {
    expect(BCH).toMatchObject({ family: 'bch', coinType: 145, chainRef: '0000000000000000029e471c41818d24b8b74c911071c4ef0b4a0509f9b5a8ce' });
    expect(BCH.utxo).toMatchObject({ cashaddr: 'bitcoincash', kind: 'pkh', dust: 546, refHeight: 661648 });
    expect(BCH.chainRef).not.toBe(NETWORKS.bitcoin.chainRef); // the genesis block is shared with Bitcoin and identifies nothing
    expect(BCH.rpc.length).toBe(2);
    expect(plugin).toBe(bchPlugin);
    expect(plugin.path(BCH)).toBe("m/44'/145'/0'/0/0");
    expect(DEFAULT_POLICY.perTx['bitcoincash:BCH']).toBe('20000000');
    expect(checkPolicy(DEFAULT_POLICY, bchIntent, 0n, now, false)).toEqual({ ok: true });
    expect(checkPolicy(DEFAULT_POLICY, { ...bchIntent, amount: '20000001' }, 0n, now, false).ok).toBe(false);
    expect(checkPolicy(DEFAULT_POLICY, { ...bchIntent, maxFee: '50001' }, 0n, now, false).ok).toBe(false);
  });

  it('derives the published address for the test mnemonic (m/44\'/145\'/0\'/0/0), also with libauth', () => {
    expect(plugin.address(BCH, bchKey.pub)).toBe(BCH_ADDR);
    expect(normalizeAddress('bitcoincash', BCH_LEGACY)).toBe(BCH_ADDR);
    const theirs = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: hash160(bchKey.pub) });
    expect(typeof theirs !== 'string' && theirs.address).toBe(BCH_ADDR);
    expect(() => plugin.address(BCH, new Uint8Array(65))).toThrow();
    expect(() => plugin.address(NETWORKS.dogecoin, bchKey.pub)).toThrow();
  });

  it('signs a two-input transfer that libauth decodes identically and its virtual machine accepts', () => {
    const { signDocs, describe: d } = plugin.build(bchIntent, BCH);
    expect(signDocs.length).toBe(2);
    expect(d).toEqual({ to: BCH_TO, amount: '180000', change: '29600', fee: '400', inputs: '2' });
    const signed = plugin.sign(bchIntent, BCH, bchHandle);
    const tx = decodeTransaction(hex.decode(signed.raw));
    if (typeof tx === 'string') throw new Error(tx);
    expect(hex.encode(encodeTransaction(tx))).toBe(signed.raw); // byte-identical after libauth's decode/encode
    expect(hashTransaction(hex.decode(signed.raw))).toBe(signed.txid);
    expect(bchTxid(hex.decode(signed.raw))).toBe(signed.txid);
    expect(tx.version).toBe(2);
    expect(tx.locktime).toBe(0);
    expect(tx.inputs.map((x) => `${hex.encode(x.outpointTransactionHash)}:${x.outpointIndex}:${x.sequenceNumber}`)).toEqual([`${IN_A.txid}:1:4294967295`, `${IN_B.txid}:0:4294967295`]);
    expect(tx.outputs.map((o) => [(lockingBytecodeToCashAddress({ bytecode: o.lockingBytecode, prefix: 'bitcoincash' }) as { address: string }).address, o.valueSatoshis, o.token]))
      .toEqual([[BCH_TO, 180_000n, undefined], [BCH_ADDR, 29_600n, undefined]]); // change only to the wallet
    const sources = [{ addr: BCH_ADDR, value: IN_A.value }, { addr: BCH_ADDR, value: IN_B.value }];
    expect(vmVerify(signed.raw, sources)).toBe(true);
    // every signature is over the digest the builder announced, and ends with SIGHASH_ALL|FORKID
    tx.inputs.forEach((input, k) => {
      const sigLen = input.unlockingBytecode[0]!, sig = input.unlockingBytecode.slice(1, 1 + sigLen), pub = input.unlockingBytecode.slice(2 + sigLen);
      expect(sig[sig.length - 1]).toBe(0x41);
      expect(hex.encode(pub)).toBe(hex.encode(bchKey.pub));
      expect(secp256k1.verify(sig.slice(0, -1), signDocs[k]!, pub, { prehash: false, lowS: true, format: 'der' })).toBe(true);
    });
    // the fee estimate is an upper bound of the real size, and the fee pays at least 1 sat/byte
    expect(estimateBchSize(2, false, true)).toBeGreaterThanOrEqual(signed.raw.length / 2);
    expect(400).toBeGreaterThanOrEqual(signed.raw.length / 2);
    expect(hex.encode(encodeBchTx(decodeBchTx(hex.decode(signed.raw))))).toBe(signed.raw);
  });

  it('the virtual machine rejects the transaction when an input value, a source script or any byte differs', () => {
    const signed = plugin.sign(bchIntent, BCH, bchHandle);
    const good = [{ addr: BCH_ADDR, value: IN_A.value }, { addr: BCH_ADDR, value: IN_B.value }];
    expect(vmVerify(signed.raw, good)).toBe(true);
    // the digest commits to the input values: a lying indexer cannot turn the difference into fee
    expect(vmVerify(signed.raw, [{ addr: BCH_ADDR, value: IN_A.value + 1n }, good[1]!])).not.toBe(true);
    expect(vmVerify(signed.raw, [good[0]!, { addr: BCH_TO, value: IN_B.value }])).not.toBe(true);
    const t = decodeBchTx(hex.decode(signed.raw));
    t.outputs[0]!.value += 1n;
    expect(vmVerify(hex.encode(encodeBchTx(t)), good)).not.toBe(true);
    const u = decodeBchTx(hex.decode(signed.raw));
    u.outputs[1]!.script = u.outputs[0]!.script;
    expect(vmVerify(hex.encode(encodeBchTx(u)), good)).not.toBe(true);
  });

  it('single input, no change, pay-to-script-hash destination', () => {
    const p2sh = 'bitcoincash:ppm2qsznhks23z7629mms6s4cwef74vcwvn0h829pq';
    const i: Intent = { ...bchIntent, to: p2sh, amount: '149800', x: { inputs: encodeBchInputs([IN_A]), change: '0', fee: '200' } };
    const signed = plugin.sign(i, BCH, bchHandle);
    const tx = decodeTransaction(hex.decode(signed.raw));
    if (typeof tx === 'string') throw new Error(tx);
    expect(tx.outputs.length).toBe(1);
    expect(hex.encode(tx.outputs[0]!.lockingBytecode)).toBe(hex.encode(lockOf(p2sh)));
    expect(vmVerify(signed.raw, [{ addr: BCH_ADDR, value: IN_A.value }])).toBe(true);
    expect(estimateBchSize(1, true, false)).toBeGreaterThanOrEqual(signed.raw.length / 2);
  });

  it('is deterministic and agrees with the standalone builder', () => {
    expect(plugin.sign(bchIntent, BCH, bchHandle)).toEqual(plugin.sign(bchIntent, BCH, bchHandle));
    const unsigned = buildBchTx(bchIntent, BCH);
    expect(unsigned.inputs.every((x) => x.script.length === 0)).toBe(true);
    expect(unsigned.outputs.map((o) => o.value)).toEqual([180_000n, 29_600n]);
  });

  it('fails closed', () => {
    const x = bchIntent.x!;
    const bad = (m: Partial<Intent>, re: RegExp) => {
      expect(() => plugin.build({ ...bchIntent, ...m }, BCH), re.source).toThrow(re);
      expect(() => plugin.sign({ ...bchIntent, ...m }, BCH, bchHandle), re.source).toThrow(re);
    };
    bad({ chainRef: NETWORKS.bitcoin.chainRef }, /chain identity/);
    bad({ network: 'bitcoin' }, /another network/);
    bad({ asset: 'bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6' }, /asset/);
    bad({ symbol: 'BTC' }, /asset/);
    bad({ decimals: 6 }, /asset/);
    bad({ memo: 'hello' }, /memo/);
    bad({ to: 'qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy' }, /destination not normalized/);
    bad({ to: BCH_TO.toUpperCase() }, /destination not normalized/);
    bad({ to: '1KXrWXciRDZUpQwQmuM1DbwsKDLYAYsVLR' }, /destination not normalized/);
    bad({ to: 'bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuz' }, /checksum/);
    bad({ to: 'bchtest:pr6m7j9njldwwzlg9v7v53unlr4jkmx6eyvwc0uz5t' }, /not a Bitcoin Cash address/);
    bad({ to: BCH_ADDR }, /destination equals source/);
    bad({ from: 'bitcoincash:ppm2qsznhks23z7629mms6s4cwef74vcwvn0h829pq' }, /source must be P2PKH/);
    bad({ from: BCH_LEGACY }, /source not normalized/);
    bad({ maxFee: '399' }, /fee exceeds/);
    bad({ x: { ...x, fee: '0', change: '30000' } }, /fee must be positive/);
    bad({ x: { ...x, fee: '401' } }, /inputs != outputs/);
    bad({ amount: '180001' }, /inputs != outputs/);
    bad({ amount: '0', x: { ...x, change: '209600' } }, /dust/);
    bad({ amount: '545', x: { ...x, change: '209055' } }, /amount below dust/);
    bad({ amount: '209055', x: { ...x, change: '545' } }, /change below dust/);
    bad({ x: { inputs: x.inputs!, fee: '400' } }, /unknown or missing/);
    bad({ x: { ...x, locktime: '1' } }, /unknown or missing/);
    bad({ x: { ...x, sighash: '65' } }, /unknown or missing/);
    bad({ x: undefined }, /chain section/);
    bad({ btc: { inputs: [{ txid: IN_A.txid, vout: 1, value: '150000' }], change: '0', fee: '400' } }, /chain section/);
    bad({ x: { ...x, change: '029600' } }, /malformed/);
    bad({ x: { ...x, fee: '-400' } }, /malformed/);
    bad({ x: { ...x, inputs: `${x.inputs},${x.inputs!.split(',')[0]}`, change: '179600' } }, /duplicate input/);
    bad({ x: { ...x, inputs: '' } }, /malformed input/);
    bad({ x: { ...x, inputs: `${'AA'.repeat(32)}:1:210000` } }, /malformed input/);
    bad({ x: { ...x, inputs: `${IN_A.txid}:1:0210000` } }, /malformed input/);
    bad({ x: { ...x, inputs: `${IN_A.txid}:4294967296:210000` } }, /malformed input/);
    bad({ x: { ...x, inputs: `${IN_A.txid}:1:210000 ` } }, /malformed input/);
    bad({ x: { ...x, inputs: `${IN_A.txid}:1:0,${IN_B.txid}:0:210000` } }, /input value/);
    bad({ x: { ...x, inputs: Array.from({ length: 51 }, (_, k) => `${IN_A.txid}:${k}:1000`).join(',') } }, /number of inputs/);
    // a key that does not control the source address, or a handle that cannot sign digests
    expect(() => plugin.sign(bchIntent, BCH, handleOf(dogeKey))).toThrow(/does not control/);
    expect(() => plugin.sign(bchIntent, BCH, { curve: 'ed25519', publicKey: new Uint8Array(32) })).toThrow(/secp256k1/);
    expect(() => plugin.sign(bchIntent, BCH, { ...bchHandle, signDigest: (dg) => handleOf(dogeKey).signDigest!(dg) })).toThrow(/self-check/);
    expect(() => plugin.build(bchIntent, NETWORKS.dogecoin)).toThrow(/not a Bitcoin Cash network/);
    // the canonical intent refuses a chain section of the wrong family
    expect(() => canonicalBytes({ ...bchIntent, x: undefined, btc: { inputs: [{ txid: IN_A.txid, vout: 1, value: '150000' }], change: '0', fee: '400' } })).toThrow(/chain section/);
  });

  it('changing any intent field changes the signed bytes, the approval hash, or throws', () => {
    const ref = plugin.sign(bchIntent, BCH, bchHandle).raw, refHash = hex.encode(intentHash(bchIntent)), x = bchIntent.x!;
    const muts: Partial<Intent>[] = [
      { to: 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a' },
      { amount: '180001', x: { ...x, change: '29599' } },
      { x: { ...x, change: '29500', fee: '500' } },
      { x: { ...x, inputs: encodeBchInputs([IN_B, IN_A]) } },
      { x: { ...x, inputs: encodeBchInputs([{ ...IN_A, vout: 2 }, IN_B]) } },
      { x: { ...x, inputs: encodeBchInputs([{ ...IN_A, value: 150_001n }, IN_B]), change: '29601' } },
      { amount: '180001' }, { maxFee: '1' }, { from: BCH_TO }, { chainRef: 'x' }, { network: 'dogecoin' }, { memo: '1' },
    ];
    for (const m of muts) {
      let out: string | null = null;
      try { out = plugin.sign({ ...bchIntent, ...m }, BCH, bchHandle).raw; } catch { /* refused */ }
      expect(out, JSON.stringify(m)).not.toBe(ref);
      let h: string | null = null;
      try { h = hex.encode(intentHash({ ...bchIntent, ...m })); } catch { /* refused */ }
      expect(h).not.toBe(refHash);
    }
    // properties the approval hash covers but the transaction does not: the hash still changes
    for (const m of [{ maxFee: '49999' }, { expiresAt: now + 121 }, { proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a12' }])
      expect(hex.encode(intentHash({ ...bchIntent, ...m }))).not.toBe(refHash);
  });

  it('random valid transfers always pass libauth\'s virtual machine', () => {
    fc.assert(fc.property(
      fc.array(fc.tuple(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.nat(5), fc.bigInt(1000n, 5_000_000n)), { minLength: 1, maxLength: 6 }),
      fc.bigInt(546n, 900n), fc.bigInt(1n, 400n), fc.boolean(),
      (ins, amount, fee, sh) => {
        const inputs = ins.map(([h, vout, value], k) => ({ txid: hex.encode(Uint8Array.from([k, ...h.slice(1)])), vout, value }));
        const total = inputs.reduce((s, u) => s + u.value, 0n), change = total - amount - fee;
        const i: Intent = { ...bchIntent, to: sh ? 'bitcoincash:ppm2qsznhks23z7629mms6s4cwef74vcwvn0h829pq' : BCH_TO, amount: amount.toString(),
          x: { inputs: encodeBchInputs(inputs), change: (change < 546n ? 0n : change).toString(), fee: (change < 546n ? fee + change : fee).toString() }, maxFee: '100000' };
        if (change < 546n && fee + change > 100_000n) return true;
        const signed = plugin.sign(i, BCH, bchHandle);
        return vmVerify(signed.raw, inputs.map((u) => ({ addr: BCH_ADDR, value: u.value }))) === true;
      }), { numRuns: 60 });
  });
});
