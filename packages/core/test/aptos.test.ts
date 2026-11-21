/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/core/test/aptos.test.ts
 * Module           : core
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-11
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import {
  Account, AccountAddress, AuthenticationKey, ChainId, Deserializer, Ed25519PrivateKey, Ed25519PublicKey, Ed25519Signature, EntryFunction, RawTransaction, SignedTransaction, SimpleTransaction,
  TransactionAuthenticatorEd25519, TransactionPayloadEntryFunction, U64, generateSignedTransaction, generateSignedTransactionForSimulation, generateSigningMessageForTransaction, generateUserTransactionHash,
} from '@aptos-labs/ts-sdk';
import {
  APTOS_MAINNET_CHAIN_ID, aptosAddressOf, aptosAptStore, aptosDecodeAddress, aptosPlugin, aptosRawBytes, aptosSignedTx, aptosSimulationTx, aptosTxid, buildAptosTx, canonicalBytes, DEFAULT_POLICY,
  intentHash, isValidAddress, NETWORKS, normalizeAddress, pluginFor, toHex, type Intent, type KeyHandle, type NetworkDef,
} from '../src/index.ts';

const net = NETWORKS.aptos as NetworkDef;
const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// BIP-39 seed of the public test mnemonic (empty passphrase)
const SEED = hexToBytes('5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4');
// Account 0 of the public test mnemonic in Petra / @aptos-labs/ts-sdk (m/44'/637'/0'/0'/0'). The account exists on mainnet.
const VECTOR = { address: '0xeb663b681209e7087d681c5d3eed12aaa8e1915e7c87794542c3f96e94b3d3bf', publicKey: '0xa686f0309ab80312979606cfccc10ea2740147ae6888351488d11c46f08fbf60' };

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
const PRIV = slip10(SEED, aptosPlugin.path(net));
const PUB = ed25519.getPublicKey(PRIV);
const FROM = VECTOR.address;
const TO = aptosAddressOf(ed25519.getPublicKey(slip10(SEED, "m/44'/637'/1'/0'/0'")));
const THIRD = aptosAddressOf(ed25519.getPublicKey(slip10(SEED, "m/44'/637'/2'/0'/0'")));
const key: KeyHandle = { curve: 'ed25519', publicKey: PUB, signMessage: (m) => ed25519.sign(m, PRIV) };
const sdkAccount = () => Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(PRIV, false), legacy: true });

const now = 1_800_000_000;
const base: Intent = {
  v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-0123456789abcdef', createdAt: now, expiresAt: now + 120, policyVersion: 4,
  network: 'aptos', chainRef: '1', asset: 'native', symbol: 'APT', decimals: 8, amount: '125000000', from: FROM, to: TO, maxFee: '1000000',
  x: { sequence_number: '129', max_gas_amount: '8122', gas_unit_price: '100', expiration_timestamp_secs: String(now + 180) },
};
const withX = (x: Record<string, string>, over: Partial<Intent> = {}): Intent => ({ ...base, ...over, x: { ...base.x!, ...x } });

/** The same transaction built by the official SDK from the same fields. */
function sdkRaw(i: Intent): RawTransaction {
  const x = i.x!;
  const payload = new TransactionPayloadEntryFunction(EntryFunction.build('0x1::aptos_account', 'transfer', [], [AccountAddress.from(i.to), new U64(BigInt(i.amount))]));
  return new RawTransaction(AccountAddress.from(i.from), BigInt(x.sequence_number!), payload, BigInt(x.max_gas_amount!), BigInt(x.gas_unit_price!), BigInt(x.expiration_timestamp_secs!), new ChainId(1));
}

describe('aptos: registration', () => {
  it('is registered with the pinned identity, derivation, limits and two sources', () => {
    expect(pluginFor(net)).toBe(aptosPlugin);
    expect([net.family, net.id, net.chainRef, net.coinType, net.memo, net.activation, net.native.symbol, net.native.decimals]).toEqual(['aptos', 'aptos', '1', 637, undefined, undefined, 'APT', 8]);
    expect(APTOS_MAINNET_CHAIN_ID).toBe(1);
    expect(aptosPlugin.curve).toBe('ed25519');
    expect(aptosPlugin.path(net)).toBe("m/44'/637'/0'/0'/0'");
    expect(() => aptosPlugin.path({ ...net, coinType: 501 })).toThrow();
    expect(new Set(net.rpc.map((u) => new URL(u).host)).size).toBe(2);
    expect(DEFAULT_POLICY.perTx['aptos:APT']).toBe('8800000000');
    expect(DEFAULT_POLICY.daily['aptos:APT']).toBe('17600000000');
    expect(DEFAULT_POLICY.maxFee.aptos).toBe('10000000');
  });
});

describe('aptos: keys and addresses', () => {
  it('derives the account of the public test mnemonic exactly like the official SDK (Petra path)', () => {
    expect('0x' + toHex(PUB)).toBe(VECTOR.publicKey);
    expect(aptosPlugin.address(net, PUB)).toBe(VECTOR.address);
    for (const k of [0, 1, 2]) {
      const path = `m/44'/637'/${k}'/0'/0'`;
      const sdk = Account.fromDerivationPath({ path, mnemonic: MNEMONIC, legacy: true });
      const pub = ed25519.getPublicKey(slip10(SEED, path));
      expect(toHex(pub)).toBe(toHex(sdk.publicKey.toUint8Array()));
      expect(aptosAddressOf(pub)).toBe(sdk.accountAddress.toString());
      expect(aptosAddressOf(pub)).toBe(sdk.accountAddress.toStringLong());
      // legacy Ed25519 authentication key = sha3-256(public key || 0x00); the address is that key
      expect(aptosAddressOf(pub)).toBe(AuthenticationKey.fromPublicKey({ publicKey: new Ed25519PublicKey(pub) }).derivedAddress().toStringLong());
      expect(aptosAddressOf(pub)).toBe('0x' + toHex(sha3_256(Uint8Array.from([...pub, 0]))));
    }
    expect(Account.fromDerivationPath({ path: aptosPlugin.path(net), mnemonic: MNEMONIC, legacy: true }).accountAddress.toString()).toBe(VECTOR.address);
    expect(() => aptosAddressOf(new Uint8Array(33))).toThrow();
  });
  it('accepts only the canonical long form and normalizes hexadecimal case', () => {
    expect(normalizeAddress('aptos', TO)).toBe(TO);
    expect(normalizeAddress('aptos', ` ${TO} `)).toBe(TO);
    expect(normalizeAddress('aptos', '0x' + TO.slice(2).toUpperCase())).toBe(TO);
    expect(toHex(aptosDecodeAddress(TO))).toBe(TO.slice(2));
    const bad = [
      TO.slice(2), TO.slice(0, -1), TO + '0', '0X' + TO.slice(2), TO.slice(0, -1) + 'g', '0x1', '0xa', '0x' + '0'.repeat(64), '0x' + '0'.repeat(63) + '1', '0x' + '0'.repeat(63) + 'a', '0x' + '0'.repeat(63) + 'f',
      '0x' + TO.slice(3), 'GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX', '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', '', `${TO}\n0x`,
    ];
    for (const a of bad) expect(isValidAddress('aptos', a), a).toBe(false);
    expect(isValidAddress('aptos', '0x' + '0'.repeat(62) + '10')).toBe(true); // first address after the reserved range
    expect(() => aptosDecodeAddress('0x' + TO.slice(2).toUpperCase())).toThrow(/lowercase/); // the builder itself never normalizes
    for (const a of [TO, FROM, THIRD]) expect(AccountAddress.fromStringStrict(a).toStringLong()).toBe(a);
  });
  it('derives the primary APT store address like the framework (observed on mainnet)', () => {
    // transaction 0xbdcc8c2b…d8c9 (version 7994900991): deposit event names this store for this recipient
    expect(aptosAptStore('0xab764b960a745488b4a0fbf01f4237b7f1601332a15ef163300e9d6ff705d0db')).toBe('0xbdec6261bc2da1fd1755a9b34fd32e0e277e5d5ecf3773421c4f93f6b46fd2aa');
  });
});

describe('aptos: transaction bytes against @aptos-labs/ts-sdk', () => {
  const variants: Intent[] = [
    base,
    withX({ sequence_number: '0', max_gas_amount: '200', gas_unit_price: '150' }, { amount: '1' }),
    withX({ sequence_number: '18446744073709551615', max_gas_amount: '2000000', gas_unit_price: '100' }, { amount: '18446744073709551615', maxFee: '200000000', to: THIRD }),
    withX({ sequence_number: '1579867', max_gas_amount: '1', gas_unit_price: '1000000' }, { amount: '8800000000', from: TO, to: FROM }),
  ];
  it('the raw transaction and signing message are byte-identical to the SDK and decode to the same fields', () => {
    for (const i of variants) {
      const b = buildAptosTx(i, net), ref = sdkRaw(i);
      expect(toHex(b.rawTx)).toBe(toHex(ref.bcsToBytes()));
      expect(toHex(b.signingMessage)).toBe(toHex(generateSigningMessageForTransaction(new SimpleTransaction(ref))));
      expect(toHex(b.signingMessage.subarray(0, 32))).toBe(toHex(sha3_256(new TextEncoder().encode('APTOS::RawTransaction'))));
      expect(aptosPlugin.build(i, net).signDocs.map(toHex)).toEqual([toHex(b.signingMessage)]);
      // decoded by the SDK: every field is the approved one, and re-encoding gives the same bytes
      const d = new Deserializer(b.rawTx), tx = RawTransaction.deserialize(d);
      expect(d.remaining()).toBe(0);
      expect(toHex(tx.bcsToBytes())).toBe(toHex(b.rawTx));
      const x = i.x!;
      expect([tx.sender.toStringLong(), tx.sequence_number, tx.max_gas_amount, tx.gas_unit_price, tx.expiration_timestamp_secs, tx.chain_id.chainId])
        .toEqual([i.from, BigInt(x.sequence_number!), BigInt(x.max_gas_amount!), BigInt(x.gas_unit_price!), BigInt(x.expiration_timestamp_secs!), 1]);
      const ef = (tx.payload as TransactionPayloadEntryFunction).entryFunction;
      expect(tx.payload).toBeInstanceOf(TransactionPayloadEntryFunction);
      expect([ef.module_name.address.toString(), ef.module_name.name.identifier, ef.function_name.identifier, ef.type_args.length, ef.args.length]).toEqual(['0x1', 'aptos_account', 'transfer', 0, 2]);
      expect(toHex(ef.args[0]!.bcsToBytes())).toBe(i.to.slice(2)); // BCS address
      expect(toHex(ef.args[1]!.bcsToBytes())).toBe(toHex(new U64(BigInt(i.amount)).bcsToBytes())); // BCS u64, little-endian
      expect(b.maxFee).toBe(BigInt(x.max_gas_amount!) * BigInt(x.gas_unit_price!));
      expect(b.describe).toMatchObject({ from: i.from, to: i.to, amountOctas: i.amount, chainId: '1', maxFeeOctas: b.maxFee.toString() });
    }
  });
  it('property: any valid field combination encodes like the SDK', () => {
    const u64 = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n });
    fc.assert(fc.property(u64, fc.bigInt({ min: 1n, max: (1n << 64n) - 1n }), fc.bigInt({ min: 1n, max: 2_000_000n }), fc.bigInt({ min: 100n, max: 1_000_000n }), fc.integer({ min: 120, max: 900 }), fc.uint8Array({ minLength: 32, maxLength: 32 }),
      (seq, amount, gas, price, life, dest) => {
        const to = '0x' + toHex(dest);
        fc.pre(to !== FROM && dest.subarray(0, 31).some((v) => v !== 0));
        const i = withX({ sequence_number: seq.toString(), max_gas_amount: gas.toString(), gas_unit_price: price.toString(), expiration_timestamp_secs: String(now + life) }, { amount: amount.toString(), to, maxFee: (gas * price).toString() });
        expect(toHex(buildAptosTx(i, net).rawTx)).toBe(toHex(sdkRaw(i).bcsToBytes()));
      }), { numRuns: 300 });
  });
});

describe('aptos: signing', () => {
  it('signs to the exact bytes the SDK produces; the SDK decodes and verifies the signature; the hash follows the Aptos rule', () => {
    for (const i of [base, withX({ sequence_number: '0' }, { amount: '1', to: THIRD })]) {
      const signed = aptosPlugin.sign(i, net, key), bytes = aptosRawBytes(signed.raw), b = buildAptosTx(i, net);
      expect(signed.raw).toMatch(/^0x[0-9a-f]+$/);
      // the SDK signing the SDK-built transaction with the same key gives the same bytes (ed25519 is deterministic)
      const transaction = new SimpleTransaction(sdkRaw(i)), account = sdkAccount();
      expect(account.accountAddress.toStringLong()).toBe(FROM);
      const senderAuthenticator = account.signTransactionWithAuthenticator(transaction);
      expect(toHex(bytes)).toBe(toHex(generateSignedTransaction({ transaction, senderAuthenticator })));
      expect(signed.txid).toBe(generateUserTransactionHash({ transaction, senderAuthenticator }));
      expect(signed.txid).toBe(aptosTxid(bytes));
      expect(signed.txid).toBe('0x' + toHex(sha3_256(Uint8Array.from([...sha3_256(new TextEncoder().encode('APTOS::Transaction')), 0, ...bytes]))));
      // decoded by the SDK: an Ed25519 authenticator carrying our key and a signature the SDK verifies over the signing message
      const d = new Deserializer(bytes), st = SignedTransaction.deserialize(d);
      expect(d.remaining()).toBe(0);
      expect(toHex(st.raw_txn.bcsToBytes())).toBe(toHex(b.rawTx));
      expect(st.authenticator).toBeInstanceOf(TransactionAuthenticatorEd25519);
      const auth = st.authenticator as TransactionAuthenticatorEd25519;
      expect(toHex(auth.public_key.toUint8Array())).toBe(toHex(PUB));
      expect(auth.public_key.verifySignature({ message: b.signingMessage, signature: auth.signature })).toBe(true);
      expect(auth.public_key.verifySignature({ message: generateSigningMessageForTransaction(transaction), signature: new Ed25519Signature(auth.signature.toUint8Array()) })).toBe(true);
      expect(ed25519.verify(auth.signature.toUint8Array(), b.signingMessage, PUB)).toBe(true);
      expect(auth.public_key.verifySignature({ message: buildAptosTx({ ...i, amount: '2' }, net).signingMessage, signature: auth.signature })).toBe(false);
      expect(toHex(aptosSignedTx(b.rawTx, PUB, auth.signature.toUint8Array()))).toBe(toHex(bytes));
    }
  });
  it('builds the simulation payloads like the SDK (zeroed signature, or no authenticator when the key is unknown)', async () => {
    const transaction = new SimpleTransaction(sdkRaw(base)), raw = buildAptosTx(base, net).rawTx;
    const zeroed = aptosSimulationTx(raw, PUB);
    expect(toHex(zeroed)).toBe(toHex(await generateSignedTransactionForSimulation({ transaction, signerPublicKey: new Ed25519PublicKey(PUB) })));
    expect(toHex(zeroed.subarray(zeroed.length - 64))).toBe('00'.repeat(64));
    expect(ed25519.verify(zeroed.subarray(zeroed.length - 64), buildAptosTx(base, net).signingMessage, PUB)).toBe(false); // can never be submitted
    expect(toHex(aptosSimulationTx(raw))).toBe(toHex(await generateSignedTransactionForSimulation({ transaction })));
    expect(toHex(aptosSimulationTx(raw))).toBe(toHex(raw) + '0404');
  });
  it('refuses a key that does not control the source, the wrong curve, and a bad signature', () => {
    const other = slip10(SEED, "m/44'/637'/1'/0'/0'");
    expect(() => aptosPlugin.sign(base, net, { curve: 'ed25519', publicKey: ed25519.getPublicKey(other), signMessage: (m) => ed25519.sign(m, other) })).toThrow(/does not control/);
    expect(() => aptosPlugin.sign(base, net, { curve: 'secp256k1', publicKey: new Uint8Array(33), signDigest: () => { throw new Error('no'); } })).toThrow(/ed25519/);
    expect(() => aptosPlugin.sign(base, net, { curve: 'ed25519', publicKey: PUB })).toThrow(/ed25519/);
    expect(() => aptosPlugin.sign(base, net, { curve: 'ed25519', publicKey: PUB, signMessage: (m) => ed25519.sign(m, other) })).toThrow(/self-check/);
    expect(() => aptosRawBytes('0x00')).toThrow();
    expect(() => aptosRawBytes(aptosPlugin.sign(base, net, key).raw.slice(2))).toThrow();
  });
});

describe('aptos: fail closed', () => {
  const bad: [string, Intent, RegExp][] = [
    ['testnet chain id in the intent', { ...base, chainRef: '2' }, /identity/],
    ['another network id', { ...base, network: 'solana' }, /not an Aptos intent/],
    ['token asset', { ...base, asset: '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b' }, /native/],
    ['coin type as asset', { ...base, asset: '0x1::aptos_coin::AptosCoin' }, /native/],
    ['wrong symbol', { ...base, symbol: 'USDC' }, /metadata/],
    ['wrong decimals', { ...base, decimals: 6 }, /metadata/],
    ['amount zero', { ...base, amount: '0' }, /positive/],
    ['amount above u64', { ...base, amount: '18446744073709551616' }, /range/],
    ['amount not canonical', { ...base, amount: '0125' }, /base-unit/],
    ['amount negative', { ...base, amount: '-5' }, /base-unit/],
    ['destination equals source', { ...base, to: FROM }, /equals source/],
    ['upper-case destination', { ...base, to: '0x' + TO.slice(2).toUpperCase() }, /invalid Aptos address/],
    ['destination without leading zeros restored', { ...base, to: '0x' + TO.slice(3) }, /invalid Aptos address/],
    ['destination without 0x', { ...base, to: TO.slice(2) }, /invalid Aptos address/],
    ['framework address as destination', { ...base, to: '0x' + '0'.repeat(63) + '1' }, /reserved/],
    ['APT metadata object as destination', { ...base, to: '0x' + '0'.repeat(63) + 'a' }, /reserved/],
    ['invalid source', { ...base, from: FROM.slice(0, -1) + 'z' }, /invalid Aptos address/],
    ['reserved source', { ...base, from: '0x' + '0'.repeat(64) }, /reserved/],
    ['memo', { ...base, memo: 'hello' }, /no memo/],
    ['fee above maxFee', withX({ max_gas_amount: '10001' }), /above approved maximum/],
    ['fee above maxFee through the price', withX({ gas_unit_price: '124' }), /above approved maximum/],
    ['gas price below the network minimum', withX({ gas_unit_price: '99' }), /range/],
    ['gas price zero', withX({ gas_unit_price: '0' }), /range/],
    ['gas price above u64', withX({ gas_unit_price: '18446744073709551616' }, { maxFee: '9'.repeat(30) }), /range/],
    ['gas limit zero', withX({ max_gas_amount: '0' }), /range/],
    ['gas limit above the network maximum', withX({ max_gas_amount: '2000001' }, { maxFee: '300000000' }), /range/],
    ['gas limit not canonical', withX({ max_gas_amount: '08122' }), /canonical/],
    ['gas limit negative', withX({ max_gas_amount: '-1' }), /canonical/],
    ['sequence above u64', withX({ sequence_number: '18446744073709551616' }), /range/],
    ['sequence not canonical', withX({ sequence_number: '0x81' }), /canonical/],
    ['sequence empty', withX({ sequence_number: '' }), /canonical/],
    ['expiration zero', withX({ expiration_timestamp_secs: '0' }), /range/],
    ['expiration in the past', withX({ expiration_timestamp_secs: String(now) }), /not after/],
    ['expiration before the approval window ends', withX({ expiration_timestamp_secs: String(now + 119) }), /before the approval window/],
    ['expiration too far away', withX({ expiration_timestamp_secs: String(now + 901) }), /too far/],
    ['unknown x key', withX({ payload: '00' }), /unknown or missing/],
    ['another function', withX({ function: '0x1::coin::transfer' }), /unknown or missing/],
    ['chain id override', withX({ chain_id: '1' }), /unknown or missing/],
    ['missing x key', { ...base, x: { sequence_number: '1', max_gas_amount: '200', gas_unit_price: '100' } }, /unknown or missing/],
    ['renamed x key', { ...base, x: { sequenceNumber: '1', max_gas_amount: '200', gas_unit_price: '100', expiration_timestamp_secs: String(now + 180) } }, /unknown or missing/],
    ['no x section', (() => { const { x: _x, ...r } = base; return r as Intent; })(), /missing Aptos parameters/],
    ['foreign chain section', { ...base, evm: { nonce: 0, gasLimit: '21000', maxFeePerGas: '1', maxPriorityFeePerGas: '1' } }, /unexpected chain section/],
    ['unsupported intent version', { ...base, v: 2 as never }, /version/],
  ];
  for (const [name, i, re] of bad) it(name, () => {
    expect(() => aptosPlugin.build(i, net)).toThrow(re);
    expect(() => aptosPlugin.sign(i, net, key)).toThrow(re);
  });
  it('refuses a network definition that is not the pinned main network', () => {
    expect(() => aptosPlugin.build({ ...base, chainRef: '2' }, { ...net, chainRef: '2' })).toThrow(/main network/);
    expect(() => aptosPlugin.build(base, { ...net, family: 'evm' })).toThrow(/not an Aptos intent/);
    expect(() => aptosPlugin.build({ ...base, network: 'aptos2' }, { ...net, id: 'aptos2' })).not.toThrow(); // the id is only a registry key; the chain id is what is signed
    expect(() => aptosPlugin.build({ ...base, symbol: 'ABC' }, { ...net, native: { ...net.native, symbol: 'ABC', id: 'ABC' } })).toThrow(/native/);
    expect(() => aptosPlugin.build({ ...base, decimals: 6 }, { ...net, native: { ...net.native, decimals: 6 } })).toThrow(/metadata/);
  });
  it('the intent schema and hash accept the Aptos section and bind every field', () => {
    expect(() => canonicalBytes(base)).not.toThrow();
    expect(() => canonicalBytes((() => { const { x: _x, ...r } = base; return r as Intent; })())).toThrow(/does not match network/);
    expect(() => canonicalBytes({ ...base, x: { ...base.x!, 'bad key': '1' } })).toThrow();
  });
  it('changing any intent field changes the signed bytes or throws', () => {
    const ref = toHex(aptosPlugin.build(base, net).signDocs[0]!);
    const txMuts: Intent[] = [
      { ...base, amount: '125000001' }, { ...base, to: THIRD }, { ...base, from: THIRD },
      withX({ sequence_number: '130' }), withX({ max_gas_amount: '8123' }), withX({ gas_unit_price: '101' }), withX({ expiration_timestamp_secs: String(now + 181) }),
    ];
    const seen = new Set([ref]);
    for (const m of txMuts) seen.add(toHex(aptosPlugin.build(m, net).signDocs[0]!));
    expect(seen.size).toBe(txMuts.length + 1);
    const signedRef = aptosPlugin.sign(base, net, key);
    for (const m of txMuts.filter((t) => t.from === FROM)) {
      const s = aptosPlugin.sign(m, net, key);
      expect(s.raw).not.toBe(signedRef.raw);
      expect(s.txid).not.toBe(signedRef.txid);
    }
    // fields that are not part of the Aptos transaction either throw or leave it unchanged, and always change the approved intent hash
    const other: Intent[] = [
      { ...base, chainRef: '2' }, { ...base, network: 'solana' }, { ...base, asset: 'other' }, { ...base, symbol: 'APTT' }, { ...base, decimals: 9 },
      { ...base, maxFee: '812199' }, { ...base, createdAt: now + 200 }, { ...base, expiresAt: now + 181 }, { ...base, v: 2 as never }, { ...base, memo: '1' },
      { ...base, maxFee: '1000001' }, { ...base, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a12' }, { ...base, keyId: 'spw-0123456789abcdee' }, { ...base, policyVersion: 5 },
    ];
    const h0 = toHex(intentHash(base));
    other.forEach((m, k) => {
      let out: string | null = null;
      try { out = toHex(aptosPlugin.build(m, net).signDocs[0]!); } catch { /* refused */ }
      if (k < 10) expect(out, `mutation ${k}`).toBeNull(); else expect(out).toBe(ref);
      let h: string | null = null;
      try { h = toHex(intentHash(m)); } catch { /* refused by the schema */ }
      expect(h).not.toBe(h0);
    });
    for (const m of txMuts) expect(toHex(intentHash(m))).not.toBe(h0);
  });
});
