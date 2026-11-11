import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import { mnemonicToSeedSync } from '@scure/bip39';
import { bcs } from '@mysten/sui/bcs';
import { messageWithIntent, parseSerializedSignature } from '@mysten/sui/cryptography';
import { Ed25519Keypair, Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import {
  buildSuiTx, canonicalBytes, DEFAULT_POLICY, intentHash, isValidAddress, NETWORKS, normalizeAddress, pluginFor,
  SUI_MAINNET_GENESIS, SUI_MAX_GAS_COINS, suiAddressFromPublicKey, suiFormatPayment, suiParsePayment, suiParseRaw, suiPlugin, suiTxDigest, toHex,
  type Intent, type KeyHandle, type NetworkDef, type SuiObjectRef,
} from '../src/index.ts';

const net = NETWORKS.sui as NetworkDef;
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'; // public BIP-39 test vector
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

/** SLIP-0010 ed25519 (hardened only), independent of the signer's implementation and of the SDK. */
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
const PRIV = slip10(SEED, suiPlugin.path(net));
const PUB = ed25519.getPublicKey(PRIV);
const SDK_KP = Ed25519Keypair.deriveKeypair(MNEMONIC); // official SDK, default Sui path
const FROM = suiAddressFromPublicKey(PUB);
const TO = suiAddressFromPublicKey(ed25519.getPublicKey(slip10(SEED, "m/44'/784'/1'/0'/0'")));
const key: KeyHandle = { curve: 'ed25519', publicKey: PUB, signMessage: (m) => ed25519.sign(m, PRIV) };

const digestOf = (seed: number) => base58.encode(blake2b(Uint8Array.of(seed), { dkLen: 32 }));
const COIN_A: SuiObjectRef = { objectId: '0x' + '1a'.repeat(32), version: 1065912677n, digest: digestOf(1) };
const COIN_B: SuiObjectRef = { objectId: '0x' + 'c7'.repeat(32), version: 7n, digest: digestOf(2) };
const now = 1_800_000_000;
const base: Intent = {
  v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-0123456789abcdef', createdAt: now, expiresAt: now + 120, policyVersion: 2,
  network: 'sui', chainRef: SUI_MAINNET_GENESIS, asset: 'native', symbol: 'SUI', decimals: 9, amount: '1250000000', from: FROM, to: TO, maxFee: '5000000',
  x: { payment: suiFormatPayment([COIN_A]), gasPrice: '100', gasBudget: '4152000', expiration: '1308' },
};
const withX = (x: Record<string, string>, over: Partial<Intent> = {}): Intent => ({ ...base, ...over, x: { ...base.x!, ...x } });

/** The same transaction built offline by the official SDK from the same fields (no client: every input is explicit). */
async function sdkBytes(i: Intent): Promise<Uint8Array> {
  const x = i.x!, tx = new Transaction();
  tx.setSender(i.from);
  tx.setGasPrice(BigInt(x.gasPrice!));
  tx.setGasBudget(BigInt(x.gasBudget!));
  tx.setExpiration({ Epoch: x.expiration! });
  tx.setGasPayment(suiParsePayment(x.payment).map((p) => ({ objectId: p.objectId, version: p.version.toString(), digest: p.digest })));
  const [coin] = tx.splitCoins(tx.gas, [BigInt(i.amount)]);
  tx.transferObjects([coin!], i.to);
  return tx.build();
}

describe('sui: registration', () => {
  it('is registered with the pinned identity, derivation, limits and two sources', () => {
    expect(pluginFor(net)).toBe(suiPlugin);
    expect(net.chainRef).toBe('4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S');
    // the well-known mainnet chain identifier is the first four bytes of the genesis checkpoint digest
    expect(toHex(base58.decode(net.chainRef).subarray(0, 4))).toBe('35834a8a');
    expect(base58.decode(net.chainRef).length).toBe(32);
    expect([net.family, net.coinType, net.memo, net.activation, net.native.symbol, net.native.decimals, net.tokens.length]).toEqual(['sui', 784, undefined, undefined, 'SUI', 9, 0]);
    expect(suiPlugin.path(net)).toBe("m/44'/784'/0'/0'/0'");
    expect(() => suiPlugin.path({ ...net, coinType: 501 })).toThrow();
    expect(new Set(net.rpc.map((u) => new URL(u).host)).size).toBe(2);
    expect(DEFAULT_POLICY.perTx['sui:SUI']).toBe('60000000000');
    expect(DEFAULT_POLICY.maxFee.sui).toBe('50000000');
  });
});

describe('sui: keys and addresses', () => {
  it('derives the address the official SDK derives for the public test mnemonic', () => {
    expect(toHex(PUB)).toBe(toHex(SDK_KP.getPublicKey().toRawBytes()));
    expect(FROM).toBe(SDK_KP.toSuiAddress());
    expect(suiPlugin.address(net, PUB)).toBe(SDK_KP.getPublicKey().toSuiAddress());
    expect(FROM).toBe('0x5e93a736d04fbb25737aa40bee40171ef79f65fae833749e3c089fe7cc2161f1');
    expect(TO).toBe(Ed25519Keypair.deriveKeypair(MNEMONIC, "m/44'/784'/1'/0'/0'").toSuiAddress());
  });
  it('matches the vector published in the Sui SDK test suite (ed25519-keypair.test.ts)', () => {
    const m = 'film crazy soon outside stand loop subway crumble thrive popular green nuclear struggle pistol arm wife phrase warfare march wheat nephew ask sunny firm';
    const pub = ed25519.getPublicKey(slip10(mnemonicToSeedSync(m), "m/44'/784'/0'/0'/0'"));
    expect(suiAddressFromPublicKey(pub)).toBe('0xa2d14fad60c56049ecf75246a481934691214ce413e6a8ae2fe6834c173a6133');
    expect(b64(pub)).toBe('ImR/7u82MGC9QgWhZxoV8QoSNnZZGLG19jjYLzPPxGk=');
  });
  it('computes addresses like the official SDK (property)', () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (k) => {
      const a = suiAddressFromPublicKey(k);
      return a === new Ed25519PublicKey(k).toSuiAddress() && isValidSuiAddress(a) && normalizeSuiAddress(a) === a && normalizeAddress('sui', a) === a;
    }));
    expect(() => suiAddressFromPublicKey(new Uint8Array(33))).toThrow();
  });
  it('accepts only full 32-byte addresses; lowers hex case, pads nothing, refuses reserved addresses', () => {
    expect(normalizeAddress('sui', `  ${TO} `)).toBe(TO);
    expect(normalizeAddress('sui', '0x' + TO.slice(2).toUpperCase())).toBe(TO);
    const bad = [
      TO.slice(2), TO.slice(0, -1), TO + '0', '0X' + TO.slice(2), TO.slice(0, -1) + 'g', '0x2', '0x5', '0x' + '0'.repeat(64), '0x' + '0'.repeat(63) + '2', '0x' + '0'.repeat(63) + '6',
      '0x' + '0'.repeat(60) + 'dee9', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S', 'alice.sui', '@alice', '',
    ];
    for (const a of bad) expect(isValidAddress('sui', a), a).toBe(false);
    expect(isValidAddress('sui', '0x' + '0'.repeat(59) + '10000')).toBe(true); // first address above the reserved range
  });
});

describe('sui: transaction bytes equal the official SDK', () => {
  const many = Array.from({ length: SUI_MAX_GAS_COINS }, (_v, k) => ({ objectId: '0x' + (k + 1).toString(16).padStart(64, '0').replace(/^0{4}/, 'beef'), version: BigInt(k + 1), digest: digestOf(k + 10) }));
  const cases: [string, Intent][] = [
    ['one gas coin', base],
    ['two gas coins', withX({ payment: suiFormatPayment([COIN_A, COIN_B]) })],
    ['two gas coins, other order', withX({ payment: suiFormatPayment([COIN_B, COIN_A]) })],
    [`${SUI_MAX_GAS_COINS} gas coins`, withX({ payment: suiFormatPayment(many) })],
    ['1 MIST, smallest budget', withX({ gasPrice: '1', gasBudget: '1' }, { amount: '1' })],
    // (the SDK holds an epoch in a JavaScript number, so it can only be compared up to 2^53 - 1; see the u64 test below)
    ['u64 max amount and version, largest epoch the SDK can hold', withX({ payment: suiFormatPayment([{ ...COIN_A, version: (1n << 64n) - 1n }]), expiration: '9007199254740991' }, { amount: '18446744073709551615' })],
    ['largest budget, epoch 0', withX({ gasBudget: '50000000000', gasPrice: '50000', expiration: '0' }, { maxFee: '50000000000' })],
    ['digest with leading zero bytes', withX({ payment: suiFormatPayment([{ ...COIN_A, digest: base58.encode(Uint8Array.from({ length: 32 }, (_v, k) => (k < 3 ? 0 : k))) }]) })],
  ];
  for (const [name, i] of cases) it(name, async () => {
    const ours = buildSuiTx(i, net), ref = await sdkBytes(i);
    expect(toHex(ours.tx)).toBe(toHex(ref));
    // decoded by the SDK's BCS schema and re-encoded: identical
    expect(toHex(bcs.TransactionData.serialize(bcs.TransactionData.parse(ours.tx)).toBytes())).toBe(toHex(ours.tx));
    const back = Transaction.from(ours.tx);
    expect(toHex(await back.build())).toBe(toHex(ours.tx));
    expect(await back.getDigest()).toBe(ours.txid);
    expect(suiTxDigest(ref)).toBe(ours.txid);
    expect(toHex(ours.signingDigest)).toBe(toHex(blake2b(messageWithIntent('TransactionData', ref), { dkLen: 32 })));
    const { signDocs, describe: d } = suiPlugin.build(i, net);
    expect(signDocs.map(toHex)).toEqual([toHex(ours.signingDigest)]);
    expect(d.txid).toBe(ours.txid);
  });
  it('decodes, with the SDK, to exactly the approved fields and nothing else', () => {
    const i = withX({ payment: suiFormatPayment([COIN_A, COIN_B]) });
    const d = bcs.TransactionData.parse(buildSuiTx(i, net).tx);
    expect(d.$kind).toBe('V1');
    const v1 = d.V1!;
    expect(v1.sender).toBe(i.from);
    expect(v1.expiration).toMatchObject({ $kind: 'Epoch', Epoch: 1308 });
    expect(v1.gasData).toEqual({ owner: i.from, price: '100', budget: '4152000', payment: [COIN_A, COIN_B].map((p) => ({ objectId: p.objectId, version: p.version.toString(), digest: p.digest })) });
    const ptb = v1.kind.ProgrammableTransaction!;
    expect(ptb.inputs).toHaveLength(2);
    expect(ptb.inputs[0]).toMatchObject({ $kind: 'Pure', Pure: { bytes: b64(bcs.u64().serialize(i.amount).toBytes()) } });
    expect(ptb.inputs[1]).toMatchObject({ $kind: 'Pure', Pure: { bytes: b64(bcs.Address.serialize(i.to).toBytes()) } });
    expect(ptb.commands).toHaveLength(2);
    expect(ptb.commands[0]).toMatchObject({ $kind: 'SplitCoins', SplitCoins: { coin: { $kind: 'GasCoin' }, amounts: [{ $kind: 'Input', Input: 0 }] } });
    expect(ptb.commands[1]).toMatchObject({ $kind: 'TransferObjects', TransferObjects: { objects: [{ $kind: 'NestedResult', NestedResult: [0, 0] }], address: { $kind: 'Input', Input: 1 } } });
  });
  it('writes the expiration epoch as a full little-endian u64', () => {
    const a = buildSuiTx(withX({ expiration: '18446744073709551615' }), net).tx, b = buildSuiTx(base, net).tx;
    expect(toHex(a.subarray(a.length - 9))).toBe('01' + 'ff'.repeat(8));
    expect(toHex(b.subarray(b.length - 9))).toBe('011c05000000000000'); // Epoch(1308)
    expect(toHex(a.subarray(0, a.length - 8))).toBe(toHex(b.subarray(0, b.length - 8)));
  });
  it('property: any valid field combination', async () => {
    const ref = fc.record({ id: fc.uint8Array({ minLength: 32, maxLength: 32 }), version: fc.bigInt({ min: 1n, max: (1n << 64n) - 1n }), digest: fc.uint8Array({ minLength: 32, maxLength: 32 }) });
    await fc.assert(fc.asyncProperty(
      fc.bigInt({ min: 1n, max: (1n << 64n) - 1n }), fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.uniqueArray(ref, { minLength: 1, maxLength: 5, selector: (r) => toHex(r.id) }),
      fc.bigInt({ min: 1n, max: 100_000n }), fc.bigInt({ min: 100_000n, max: 50_000_000_000n }), fc.bigInt({ min: 0n, max: BigInt(Number.MAX_SAFE_INTEGER) }),
      async (amount, dest, refs, gasPrice, gasBudget, epoch) => {
        const to = '0x' + toHex(dest), payment = refs.map((r) => ({ objectId: '0x' + toHex(r.id), version: r.version, digest: base58.encode(r.digest) }));
        fc.pre(to !== FROM && !/^0x0{60}/.test(to) && payment.every((p) => p.objectId !== to && p.objectId !== FROM));
        const i = withX({ payment: suiFormatPayment(payment), gasPrice: gasPrice.toString(), gasBudget: gasBudget.toString(), expiration: epoch.toString() }, { amount: amount.toString(), to, maxFee: gasBudget.toString() });
        const ours = buildSuiTx(i, net), sdk = await sdkBytes(i);
        return toHex(ours.tx) === toHex(sdk) && ours.txid === suiTxDigest(sdk);
      }), { numRuns: 200 });
  });
});

describe('sui: signing', () => {
  it('produces the signature the SDK produces, and the SDK verifies it', async () => {
    for (const i of [base, withX({ payment: suiFormatPayment([COIN_A, COIN_B]) }, { amount: '1' })]) {
      const signed = suiPlugin.sign(i, net, key);
      const { tx, signature, txid } = suiParseRaw(signed.raw);
      expect(txid).toBe(signed.txid);
      expect(toHex(tx)).toBe(toHex(await sdkBytes(i)));
      expect(await Transaction.from(tx).getDigest()).toBe(signed.txid);
      // serialized signature: flag 0x00 || 64-byte signature || 32-byte public key
      expect(signature.length).toBe(97);
      expect(signature[0]).toBe(0);
      expect(toHex(signature.subarray(65))).toBe(toHex(PUB));
      const parsed = parseSerializedSignature(b64(signature));
      expect(parsed.signatureScheme).toBe('ED25519');
      expect(parsed.signatureScheme === 'ED25519' && toHex(parsed.publicKey)).toBe(toHex(PUB));
      // the SDK verifies it as a transaction signature of the sender, and refuses it for anyone else or any other bytes
      const pk = await verifyTransactionSignature(tx, b64(signature), { address: i.from });
      expect(pk.toSuiAddress()).toBe(i.from);
      await expect(verifyTransactionSignature(tx, b64(signature), { address: TO })).rejects.toThrow();
      const other = tx.slice(); other[5] = other[5]! ^ 1;
      await expect(verifyTransactionSignature(other, b64(signature))).rejects.toThrow();
      // noble, against the raw public key, over blake2b-256(intent prefix || tx)
      expect(ed25519.verify(signature.subarray(1, 65), blake2b(Uint8Array.from([0, 0, 0, ...tx]), { dkLen: 32 }), PUB)).toBe(true);
      // the SDK signing the same bytes with the same mnemonic gives the same serialized signature (ed25519 is deterministic)
      const ref = await SDK_KP.signTransaction(tx);
      expect(ref.signature).toBe(b64(signature));
      expect(ref.bytes).toBe(b64(tx));
    }
  });
  it('refuses a key that does not control the source, the wrong curve, and a bad signature', () => {
    const other = slip10(SEED, "m/44'/784'/1'/0'/0'");
    expect(() => suiPlugin.sign(base, net, { curve: 'ed25519', publicKey: ed25519.getPublicKey(other), signMessage: (m) => ed25519.sign(m, other) })).toThrow(/does not control/);
    expect(() => suiPlugin.sign(base, net, { curve: 'secp256k1', publicKey: new Uint8Array(33), signDigest: () => { throw new Error('no'); } })).toThrow(/ed25519/);
    expect(() => suiPlugin.sign(base, net, { curve: 'ed25519', publicKey: PUB })).toThrow(/ed25519/);
    expect(() => suiPlugin.sign(base, net, { curve: 'ed25519', publicKey: PUB, signMessage: (m) => ed25519.sign(m, other) })).toThrow(/self-check/);
  });
  it('parses only its own broadcast payload', () => {
    const raw = suiPlugin.sign(base, net, key).raw;
    const [t, s] = raw.split(':') as [string, string];
    for (const bad of ['', t, `${t}:`, `${t}:${s}:${s}`, `${t}:${s.slice(4)}`, `${t} :${s}`, `${t}:${b64(Uint8Array.from([1, ...Buffer.from(s, 'base64').subarray(1)]))}`, `AAAA:${s}`])
      expect(() => suiParseRaw(bad), bad.slice(0, 20)).toThrow();
  });
});

describe('sui: fail closed', () => {
  const pay = (refs: { objectId: string; version: string; digest: string }[]) => refs.map((r) => `${r.objectId}:${r.version}:${r.digest}`).join(',');
  const A = { objectId: COIN_A.objectId, version: COIN_A.version.toString(), digest: COIN_A.digest };
  const bad: [string, Intent, RegExp][] = [
    ['wrong genesis in the intent', { ...base, chainRef: '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD' }, /identity/], // Sui testnet
    ['short chain identifier instead of the digest', { ...base, chainRef: '35834a8a' }, /identity/],
    ['another network id', { ...base, network: 'solana' }, /not a Sui intent/],
    ['token asset (USDC)', { ...base, asset: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC' }, /native/],
    ['wrong symbol', { ...base, symbol: 'USDC' }, /metadata/],
    ['wrong decimals', { ...base, decimals: 6 }, /metadata/],
    ['amount zero', { ...base, amount: '0' }, /positive/],
    ['amount above u64', { ...base, amount: '18446744073709551616' }, /range/],
    ['amount not canonical', { ...base, amount: '0125' }, /base-unit/],
    ['destination equals source', { ...base, to: FROM }, /equals source/],
    ['upper-case destination', { ...base, to: '0x' + TO.slice(2).toUpperCase() }, /invalid Sui address/],
    ['short destination', { ...base, to: '0x' + '0'.repeat(20) + '2' }, /invalid Sui address/],
    ['destination without 0x', { ...base, to: TO.slice(2) + '00' }, /invalid Sui address/],
    ['zero address', { ...base, to: '0x' + '0'.repeat(64) }, /reserved/],
    ['system object as destination', { ...base, to: '0x' + '0'.repeat(63) + '5' }, /reserved/],
    ['invalid source', { ...base, from: FROM.slice(0, 65) + 'G' }, /invalid Sui address/],
    ['memo', { ...base, memo: 'hello' }, /memo/],
    ['budget above maxFee', withX({ gasBudget: '5000001' }), /above approved maximum/],
    ['budget above the protocol maximum', withX({ gasBudget: '50000000001' }, { maxFee: '60000000000' }), /protocol maximum/],
    ['budget zero', withX({ gasBudget: '0' }), /range/],
    ['budget below one gas unit', withX({ gasBudget: '99' }), /below the price/],
    ['budget not canonical', withX({ gasBudget: '04152000' }), /canonical/],
    ['budget negative', withX({ gasBudget: '-1' }), /canonical/],
    ['budget above u64', withX({ gasBudget: '18446744073709551616' }, { maxFee: '18446744073709551616' }), /range/],
    ['gas price zero', withX({ gasPrice: '0' }), /range/],
    ['gas price in hex', withX({ gasPrice: '0x64' }), /canonical/],
    ['expiration missing value', withX({ expiration: '' }), /canonical/],
    ['expiration above u64', withX({ expiration: '18446744073709551616' }), /range/],
    ['unknown x key', withX({ sponsor: TO }), /unknown or missing/],
    ['extra command hint', withX({ moveCall: '0x2::coin::burn' }), /unknown or missing/],
    ['missing x key', { ...base, x: { payment: base.x!.payment!, gasPrice: '100', gasBudget: '4152000' } }, /unknown or missing/],
    ['no x section', (() => { const { x: _x, ...r } = base; return r as Intent; })(), /missing Sui parameters/],
    ['foreign chain section', { ...base, sol: { recentBlockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N', lastValidBlockHeight: 1, createAta: false, computeUnitLimit: 1, computeUnitPrice: '0' } }, /unexpected chain section/],
    ['no gas coin', withX({ payment: '' }), /missing/],
    ['too many gas coins', withX({ payment: pay(Array.from({ length: SUI_MAX_GAS_COINS + 1 }, (_v, k) => ({ ...A, objectId: '0x' + (k + 0x10000).toString(16).padStart(64, '0') }))) }), /too many/],
    ['duplicate gas coin', withX({ payment: pay([A, A]) }), /duplicate/],
    ['gas coin id not canonical', withX({ payment: pay([{ ...A, objectId: '0x1a' }]) }), /invalid Sui address/],
    ['gas coin id upper case', withX({ payment: pay([{ ...A, objectId: A.objectId.toUpperCase().replace('0X', '0x') }]) }), /invalid Sui address/],
    ['gas coin version zero', withX({ payment: pay([{ ...A, version: '0' }]) }), /range/],
    ['gas coin version not canonical', withX({ payment: pay([{ ...A, version: '01' }]) }), /canonical/],
    ['gas coin version above u64', withX({ payment: pay([{ ...A, version: '18446744073709551616' }]) }), /range/],
    ['gas coin digest too short', withX({ payment: pay([{ ...A, digest: base58.encode(new Uint8Array(31).fill(7)) }]) }), /digest/],
    ['gas coin digest too long', withX({ payment: pay([{ ...A, digest: base58.encode(new Uint8Array(33).fill(7)) }]) }), /digest/],
    ['gas coin digest not base58', withX({ payment: pay([{ ...A, digest: A.digest.slice(0, -1) + '0' }]) }), /digest/],
    ['gas coin with a fourth field', withX({ payment: `${pay([A])}:1` }), /objectId:version:digest/],
    ['trailing separator', withX({ payment: `${pay([A])},` }), /objectId:version:digest/],
    ['whitespace in payment', withX({ payment: ` ${pay([A])}` }), /invalid Sui address/],
    ['gas coin is the destination', withX({ payment: pay([{ ...A, objectId: TO }]) }), /cannot be the sender or the destination/],
    ['gas coin is the sender', withX({ payment: pay([{ ...A, objectId: FROM }]) }), /cannot be the sender or the destination/],
  ];
  for (const [name, i, re] of bad) it(name, () => {
    expect(() => suiPlugin.build(i, net)).toThrow(re);
    expect(() => suiPlugin.sign(i, net, key)).toThrow(re);
  });
  it('refuses a network definition that is not the pinned mainnet', () => {
    const testnet = '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD';
    expect(() => suiPlugin.build({ ...base, chainRef: testnet }, { ...net, chainRef: testnet })).toThrow(/only mainnet/);
    expect(() => suiPlugin.build(base, { ...net, family: 'evm' })).toThrow(/not a Sui intent/);
    expect(() => suiPlugin.build({ ...base, symbol: 'ABC' }, { ...net, native: { ...net.native, symbol: 'ABC', id: 'ABC' } })).toThrow(/native/);
  });
  it('the intent schema and hash accept the Sui section and bind every field', () => {
    expect(() => canonicalBytes(base)).not.toThrow();
    expect(() => canonicalBytes(withX({ payment: suiFormatPayment(Array.from({ length: SUI_MAX_GAS_COINS }, (_v, k) => ({ ...COIN_A, objectId: '0x' + (k + 0x10000).toString(16).padStart(64, '0'), version: (1n << 64n) - 1n }))) }))).not.toThrow();
    expect(() => canonicalBytes((() => { const { x: _x, ...r } = base; return r as Intent; })())).toThrow(/does not match network/);
    expect(() => canonicalBytes({ ...base, x: { ...base.x!, 'bad key': '1' } })).toThrow();
  });
  it('changing any intent field changes the signed bytes or throws', () => {
    const ref = toHex(suiPlugin.build(base, net).signDocs[0]!);
    const other3 = suiAddressFromPublicKey(ed25519.getPublicKey(slip10(SEED, "m/44'/784'/2'/0'/0'")));
    const txMuts: Intent[] = [
      { ...base, amount: '1250000001' }, { ...base, to: other3 }, { ...base, from: other3 },
      withX({ gasPrice: '101' }), withX({ gasBudget: '4152001' }), withX({ expiration: '1309' }),
      withX({ payment: suiFormatPayment([{ ...COIN_A, version: COIN_A.version + 1n }]) }), withX({ payment: suiFormatPayment([{ ...COIN_A, digest: digestOf(3) }]) }),
      withX({ payment: suiFormatPayment([{ ...COIN_A, objectId: COIN_B.objectId }]) }), withX({ payment: suiFormatPayment([COIN_A, COIN_B]) }), withX({ payment: suiFormatPayment([COIN_B, COIN_A]) }),
    ];
    const seen = new Set([ref]);
    for (const m of txMuts) seen.add(toHex(suiPlugin.build(m, net).signDocs[0]!));
    expect(seen.size).toBe(txMuts.length + 1);
    // fields that are not part of the Sui transaction either throw or leave it unchanged, and always change the approved intent hash
    const other: Intent[] = [
      { ...base, chainRef: '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD' }, { ...base, network: 'solana' }, { ...base, asset: 'other' }, { ...base, symbol: 'SUL' }, { ...base, decimals: 8 },
      { ...base, maxFee: '4151999' }, { ...base, memo: 'x' }, { ...base, v: 2 as never },
      { ...base, maxFee: '5000001' }, { ...base, createdAt: now + 1 }, { ...base, expiresAt: now + 121 }, { ...base, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a12' }, { ...base, keyId: 'spw-0123456789abcdee' }, { ...base, policyVersion: 3 },
    ];
    const h0 = toHex(intentHash(base));
    other.forEach((m, k) => {
      let out: string | null = null;
      try { out = toHex(suiPlugin.build(m, net).signDocs[0]!); } catch { /* refused */ }
      if (k < 8) expect(out, `mutation ${k}`).toBeNull(); else expect(out).toBe(ref);
      let h: string | null = null;
      try { h = toHex(intentHash(m)); } catch { /* refused by the schema */ }
      expect(h).not.toBe(h0);
    });
    for (const m of txMuts) expect(toHex(intentHash(m))).not.toBe(h0);
  });
});
