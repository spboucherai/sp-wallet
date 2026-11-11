// Cosmos SDK plugin (Cosmos Hub), proven against the official JavaScript SDK: @cosmjs/proto-signing + @cosmjs/stargate 0.39.0
// (protobuf codecs from cosmjs-types 0.11.0).
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { decodePubkey, decodeTxRaw, DirectSecp256k1HdWallet, DirectSecp256k1Wallet, encodePubkey, makeAuthInfoBytes, makeSignBytes, makeSignDoc, Registry } from '@cosmjs/proto-signing';
import { defaultRegistryTypes } from '@cosmjs/stargate';
import { SignMode } from 'cosmjs-types/cosmos/tx/signing/v1beta1/signing';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import {
  canonicalBytes, COSMOS_MAX_GAS, cosmosAddressBytes, cosmosAddressFromPublicKey, cosmosMemo, cosmosPlugin, cosmosSignDoc, cosmosSimulationTx, cosmosTxid,
  DEFAULT_POLICY, intentHash, isValidAddress, NETWORKS, normalizeAddress, pluginFor, toHex, type Intent, type KeyHandle, type NetworkDef,
} from '../src/index.ts';

// Public BIP-39 test vector mnemonic — holds no funds of ours, never used outside tests.
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
/** Address of that mnemonic at m/44'/118'/0'/0/0 as published by the usual tools; it exists on cosmoshub-4 (account 1425847) with the public key below. */
const VECTOR_ADDRESS = 'cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4', VECTOR_PUBKEY_B64 = 'Ak9OKtmcNNYLm6YoPJQxqEGK+GcyEpYfl6d7Y3f80Fti';
const net = NETWORKS.cosmos;
const node = HDKey.fromMasterSeed(mnemonicToSeedSync(TEST_MNEMONIC)).derive(cosmosPlugin.path(net));
const priv = node.privateKey!, pub = node.publicKey!;
/** Same shape as the signer's key handle (services/isolated-signer/src/keys.ts). */
const handleOf = (sk: Uint8Array): KeyHandle => ({ curve: 'secp256k1', publicKey: secp256k1.getPublicKey(sk, true), signDigest: (digest) => {
  const sig = secp256k1.sign(digest, sk, { prehash: false, lowS: true, format: 'recovered' });
  const compact = sig.slice(1);
  return { compact, recovery: sig[0]!, der: secp256k1.Signature.fromBytes(compact, 'compact').toBytes('der') };
} });
const key = handleOf(priv);
const sdkWallet = await DirectSecp256k1HdWallet.fromMnemonic(TEST_MNEMONIC, { prefix: 'cosmos' }); // cosmjs default path = m/44'/118'/0'/0/0
const [sdkAccount] = await sdkWallet.getAccounts();
const registry = new Registry(defaultRegistryTypes);

const DEST = 'cosmos1wnacchusmacys78rxcr640gjpz000f87gnz6zf', DEST2 = 'cosmos1dkaw0wlutmwqfw7dyn4s5mlv7nj6xjax2a73q7';
const now = 1_800_000_000;
const X = { account_number: '1425847', sequence: '7', gas_limit: '200000', fee_amount: '1500', timeout_height: '33821256' };
const base: Intent = { v: 1, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-0123456789abcdef', createdAt: now, expiresAt: now + 90, policyVersion: 3,
  network: 'cosmos', chainRef: net.chainRef, asset: 'native', symbol: 'ATOM', decimals: 6, amount: '2500000', from: VECTOR_ADDRESS, to: DEST, maxFee: '1500', x: X };
const withMemo: Intent = { ...base, memo: '104588310' };
const B64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const bytes = (b64: string) => Uint8Array.from(Buffer.from(b64, 'base64'));

/** The same transfer as cosmjs builds it: TxBody, AuthInfo and SignDoc bytes. */
function sdkDoc(i: Intent, n: NetworkDef = net, publicKey: Uint8Array = pub) {
  const bodyBytes = registry.encodeTxBody({
    messages: [{ typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: { fromAddress: i.from, toAddress: i.to, amount: [{ denom: n.cosmos!.denom, amount: i.amount }] } }],
    memo: i.memo ?? '', timeoutHeight: BigInt(i.x!.timeout_height!) });
  const authInfoBytes = makeAuthInfoBytes([{ pubkey: encodePubkey({ type: 'tendermint/PubKeySecp256k1', value: B64(publicKey) }), sequence: BigInt(i.x!.sequence!) }],
    [{ denom: n.cosmos!.denom, amount: i.x!.fee_amount! }], Number(i.x!.gas_limit), undefined, undefined, SignMode.SIGN_MODE_DIRECT);
  const signDoc = makeSignDoc(bodyBytes, authInfoBytes, n.chainRef, Number(i.x!.account_number));
  return { bodyBytes, authInfoBytes, signDoc, signBytes: makeSignBytes(signDoc) };
}
/** cosmjs signs the SignDoc and assembles TxRaw. */
async function sdkSign(i: Intent, wallet: { signDirect: DirectSecp256k1HdWallet['signDirect'] } = sdkWallet, n: NetworkDef = net, publicKey: Uint8Array = pub) {
  const d = sdkDoc(i, n, publicKey);
  const { signature, signed } = await wallet.signDirect(i.from, d.signDoc);
  const raw = TxRaw.encode({ bodyBytes: signed.bodyBytes, authInfoBytes: signed.authInfoBytes, signatures: [bytes(signature.signature)] }).finish();
  return { raw: B64(raw), txid: toHex(sha256(raw)).toUpperCase(), signature: bytes(signature.signature) };
}

describe('cosmos: registration', () => {
  it('is registered as a plugin family with the pinned network definition and policy', () => {
    expect(pluginFor(net)).toBe(cosmosPlugin);
    expect(net).toMatchObject({ id: 'cosmos', family: 'cosmos', name: 'Cosmos Hub', chainRef: 'cosmoshub-4', coinType: 118, memo: 'text', cosmos: { bech32: 'cosmos', denom: 'uatom' } });
    expect(net.activation).toBeUndefined();
    expect(net.native).toEqual({ id: 'native', symbol: 'ATOM', name: 'Cosmos', decimals: 6 });
    expect(net.tokens).toEqual([]);
    expect(net.rpc.length).toBe(2);
    expect(new Set(net.rpc.map((u) => new URL(u).host.split('.').slice(-2).join('.'))).size).toBe(2);
    expect(DEFAULT_POLICY.perTx['cosmos:ATOM']).toBe('36000000');
    expect(DEFAULT_POLICY.daily['cosmos:ATOM']).toBe('72000000');
    expect(DEFAULT_POLICY.maxFee.cosmos).toBe('50000');
    expect(Object.values(NETWORKS).filter((n) => n.family === 'cosmos').map((n) => n.id)).toEqual(['cosmos']); // only Cosmos Hub is registered
  });
});

describe('cosmos: keys and addresses', () => {
  it("derives m/44'/118'/0'/0/0 of the public test mnemonic to the published address (and to what cosmjs derives)", () => {
    expect(cosmosPlugin.curve).toBe('secp256k1');
    expect(cosmosPlugin.path(net)).toBe("m/44'/118'/0'/0/0");
    expect(sdkAccount!.address).toBe(VECTOR_ADDRESS); // the published vector, confirmed by the official SDK
    expect(cosmosPlugin.address(net, pub)).toBe(VECTOR_ADDRESS);
    expect(B64(pub)).toBe(VECTOR_PUBKEY_B64);
    expect(B64(sdkAccount!.pubkey)).toBe(VECTOR_PUBKEY_B64);
    expect(cosmosAddressFromPublicKey('cosmos', pub)).toBe(VECTOR_ADDRESS);
  });
  it('matches cosmjs for random keys and prefixes (property)', async () => {
    await fc.assert(fc.asyncProperty(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.constantFrom('cosmos', 'osmo', 'celestia'), async (seed, prefix) => {
      fc.pre(secp256k1.utils.isValidSecretKey(seed));
      const [a] = await (await DirectSecp256k1Wallet.fromKey(seed, prefix)).getAccounts();
      const mine = cosmosAddressFromPublicKey(prefix, secp256k1.getPublicKey(seed, true));
      return mine === a!.address && toHex(cosmosAddressBytes(prefix, mine)).length === 40;
    }), { numRuns: 40 });
  });
  it('accepts canonical account addresses of this chain only', () => {
    expect(normalizeAddress('cosmos', DEST)).toBe(DEST);
    expect(normalizeAddress('cosmos', ` ${DEST} `)).toBe(DEST); // the shared entry point trims
    expect(cosmosPlugin.normalizeAddress(net, VECTOR_ADDRESS)).toBe(VECTOR_ADDRESS);
    expect(isValidAddress('cosmos', DEST2)).toBe(true);
    expect(() => cosmosPlugin.normalizeAddress(net, ` ${DEST}`)).toThrow();
    expect(() => normalizeAddress('cosmos', DEST.toUpperCase())).toThrow(); // valid bech32, but not the normalized form
    expect(() => normalizeAddress('cosmos', DEST.slice(0, -1) + (DEST.endsWith('f') ? 'g' : 'f'))).toThrow(/checksum/);
    expect(() => normalizeAddress('cosmos', 'cosmos1Wnacchusmacys78rxcr640gjpz000f87gnz6zf')).toThrow();
    expect(() => normalizeAddress('cosmos', cosmosAddressFromPublicKey('osmo', pub))).toThrow(/cosmos1/); // same key, another chain's prefix
    expect(() => normalizeAddress('cosmos', cosmosAddressFromPublicKey('cosmosvaloper', pub))).toThrow(); // validator operator address
    expect(() => normalizeAddress('cosmos', 'cosmos1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsgcqu0')).toThrow(); // 32-byte (module / interchain account) address
    expect(() => normalizeAddress('cosmos', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toThrow();
    expect(() => normalizeAddress('cosmos', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8')).toThrow();
    expect(() => normalizeAddress('cosmos', '')).toThrow();
    expect(() => normalizeAddress('bitcoin', DEST)).toThrow();
    expect(() => cosmosPlugin.address(net, pub.slice(1))).toThrow(/33-byte/);
    expect(() => cosmosPlugin.address(NETWORKS.bitcoin, pub)).toThrow(/not a Cosmos/);
    expect(() => cosmosPlugin.path(NETWORKS.xrpl)).toThrow(/not a Cosmos/);
  });
});

describe('cosmos: transaction bytes against cosmjs', () => {
  const cases: Intent[] = [base, withMemo, { ...base, memo: 'Dépôt №7 — ok ✅' },
    { ...base, x: { ...X, account_number: '0', sequence: '0' } }, // proto3 omits zero-valued fields
    { ...base, amount: '9007199254740993000000', maxFee: '50000', x: { account_number: '9223372036854775807', sequence: '9223372036854775807', gas_limit: COSMOS_MAX_GAS.toString(), fee_amount: '50000', timeout_height: '9223372036854775807' } }];
  it('SignDoc bytes are byte-identical to makeSignBytes(makeSignDoc(...)) of cosmjs', () => {
    for (const i of cases) {
      const mine = cosmosSignDoc(i, net, pub);
      const sdk = i.x!.account_number!.length > 15 ? null : sdkDoc(i); // cosmjs takes the account number as a JS number
      if (sdk) expect(toHex(mine)).toBe(toHex(sdk.signBytes));
      // build() with the (verified) public key returns exactly those bytes; without it, the same document minus the key
      expect(toHex(cosmosPlugin.build(i, net, { publicKey: toHex(pub) }).signDocs[0]!)).toBe(toHex(mine));
      expect(cosmosPlugin.build(i, net, { publicKey: toHex(pub) }).signDocs.length).toBe(1);
      expect(toHex(cosmosPlugin.build(i, net).signDocs[0]!)).not.toBe(toHex(mine));
    }
  });
  it('the signed TxRaw is byte-identical to cosmjs signDirect + TxRaw, decodes to the intent fields, and the signature verifies', async () => {
    for (const i of cases.slice(0, 4)) {
      const mine = cosmosPlugin.sign(i, net, key);
      const sdk = await sdkSign(i);
      expect(mine.raw).toBe(sdk.raw);
      expect(mine.txid).toBe(sdk.txid);
      expect(mine.txid).toMatch(/^[0-9A-F]{64}$/);
      expect(cosmosTxid(mine.raw)).toBe(mine.txid);

      const raw = bytes(mine.raw), d = decodeTxRaw(raw);
      expect(d.body.messages.length).toBe(1);
      expect(d.body.messages[0]!.typeUrl).toBe('/cosmos.bank.v1beta1.MsgSend');
      expect(registry.decode(d.body.messages[0]!)).toEqual({ fromAddress: VECTOR_ADDRESS, toAddress: DEST, amount: [{ denom: 'uatom', amount: i.amount }] });
      expect(d.body.memo).toBe(i.memo ?? '');
      expect(d.body.timeoutHeight).toBe(BigInt(i.x!.timeout_height!));
      expect([d.body.extensionOptions, d.body.nonCriticalExtensionOptions]).toEqual([[], []]);
      expect(d.authInfo.signerInfos.length).toBe(1);
      const s = d.authInfo.signerInfos[0]!;
      expect(decodePubkey(s.publicKey!)).toEqual({ type: 'tendermint/PubKeySecp256k1', value: VECTOR_PUBKEY_B64 });
      expect(s.modeInfo).toEqual({ single: { mode: SignMode.SIGN_MODE_DIRECT }, multi: undefined });
      expect(s.sequence).toBe(BigInt(i.x!.sequence!));
      expect(d.authInfo.fee).toMatchObject({ amount: [{ denom: 'uatom', amount: i.x!.fee_amount }], gasLimit: BigInt(i.x!.gas_limit!), payer: '', granter: '' });
      expect(d.authInfo.tip).toBeUndefined();
      // canonical for the official codec: decoding and re-encoding every layer gives the same bytes
      const t = TxRaw.decode(raw);
      expect(B64(TxRaw.encode(t).finish())).toBe(mine.raw);
      expect(toHex(registry.encodeTxBody({ messages: [{ typeUrl: d.body.messages[0]!.typeUrl, value: registry.decode(d.body.messages[0]!) }], memo: d.body.memo, timeoutHeight: d.body.timeoutHeight }))).toBe(toHex(t.bodyBytes));
      // signature: 64 bytes r||s, low-S, over sha256(SignDoc), verified with noble against the public key and equal to the SDK's
      expect(d.signatures.length).toBe(1);
      const sig = d.signatures[0]!, digest = sha256(cosmosSignDoc(i, net, pub));
      expect(sig.length).toBe(64);
      expect(toHex(sig)).toBe(toHex(sdk.signature));
      expect(secp256k1.verify(sig, digest, pub, { prehash: false, lowS: true })).toBe(true);
      expect(toHex(digest)).toBe(toHex(sha256(sdkDoc(i).signBytes)));
    }
  });
  it('matches cosmjs for arbitrary transfers (property)', async () => {
    const u53 = fc.bigInt({ min: 0n, max: 9_007_199_254_740_991n });
    const memo = fc.option(fc.string({ unit: 'grapheme', minLength: 1, maxLength: 40 }).filter((m) => { try { cosmosMemo(m); return true; } catch { return false; } }), { nil: undefined });
    await fc.assert(fc.asyncProperty(fc.bigInt({ min: 1n, max: 10n ** 30n }), fc.bigInt({ min: 1n, max: 50_000n }), u53, u53, fc.bigInt({ min: 1n, max: COSMOS_MAX_GAS }), fc.bigInt({ min: 1n, max: 1n << 62n }), memo,
      fc.uint8Array({ minLength: 32, maxLength: 32 }), async (amount, fee, accountNumber, sequence, gas, timeout, m, destSeed) => {
        fc.pre(secp256k1.utils.isValidSecretKey(destSeed));
        const to = cosmosAddressFromPublicKey('cosmos', secp256k1.getPublicKey(destSeed, true));
        const i: Intent = { ...base, amount: amount.toString(), to, maxFee: fee.toString(), ...(m !== undefined ? { memo: m } : {}),
          x: { account_number: accountNumber.toString(), sequence: sequence.toString(), gas_limit: gas.toString(), fee_amount: fee.toString(), timeout_height: timeout.toString() } };
        const mine = cosmosPlugin.sign(i, net, key), sdk = await sdkSign(i);
        return toHex(cosmosSignDoc(i, net, pub)) === toHex(sdkDoc(i).signBytes) && mine.raw === sdk.raw && mine.txid === sdk.txid;
      }), { numRuns: 60 });
  });
  it('the simulation form is the same transfer without public key and with an empty signature', () => {
    for (const i of [base, withMemo]) {
      const sim = decodeTxRaw(bytes(cosmosSimulationTx(i, net))), signed = decodeTxRaw(bytes(cosmosPlugin.sign(i, net, key).raw));
      expect(sim.body).toEqual(signed.body);
      expect(sim.authInfo.fee).toEqual(signed.authInfo.fee);
      expect(sim.authInfo.signerInfos.length).toBe(1);
      expect(sim.authInfo.signerInfos[0]!.publicKey).toBeUndefined();
      expect(sim.authInfo.signerInfos[0]!.sequence).toBe(7n);
      expect(sim.signatures.map((s) => s.length)).toEqual([0]);
    }
    expect(() => cosmosSimulationTx({ ...base, amount: '0' }, net)).toThrow(/positive/);
    expect(() => cosmosSimulationTx({ ...base, maxFee: '1' }, net)).toThrow(/approved maximum/);
  });
  it('chain parameters come from the network definition: another Cosmos SDK chain is a registry entry', async () => {
    // not registered anywhere: only shows that chain id, prefix and denom are data, with the same proof against cosmjs
    const osmo: NetworkDef = { ...net, id: 'osmosis', name: 'Osmosis', chainRef: 'osmosis-1', native: { id: 'native', symbol: 'OSMO', name: 'Osmosis', decimals: 6 }, cosmos: { bech32: 'osmo', denom: 'uosmo' } };
    const from = cosmosPlugin.address(osmo, pub), to = cosmosAddressFromPublicKey('osmo', secp256k1.getPublicKey(new Uint8Array(32).fill(9), true));
    expect(from).toBe((await (await DirectSecp256k1HdWallet.fromMnemonic(TEST_MNEMONIC, { prefix: 'osmo' })).getAccounts())[0]!.address);
    const i: Intent = { ...withMemo, network: 'osmosis', chainRef: 'osmosis-1', symbol: 'OSMO', from, to };
    const w = await DirectSecp256k1Wallet.fromKey(priv, 'osmo');
    expect(toHex(cosmosSignDoc(i, osmo, pub))).toBe(toHex(sdkDoc(i, osmo).signBytes));
    expect(cosmosPlugin.sign(i, osmo, key).raw).toBe((await sdkSign(i, w, osmo)).raw);
    // the same intent fields on the two chains never share a signature: chain id, denom and addresses differ
    expect(() => cosmosPlugin.sign({ ...i, from: VECTOR_ADDRESS }, osmo, key)).toThrow(/osmo1/);
    expect(() => cosmosPlugin.sign(base, osmo, key)).toThrow(/not for this network/);
    expect(() => cosmosPlugin.build(i, { ...osmo, cosmos: undefined })).toThrow(/not a Cosmos/);
    expect(() => cosmosPlugin.build(i, { ...osmo, cosmos: { bech32: 'Osmo', denom: 'uosmo' } })).toThrow(/invalid Cosmos SDK network/);
  });
  it('is deterministic and the intent hash covers the chain parameters and the memo', () => {
    expect(cosmosPlugin.sign(base, net, key)).toEqual(cosmosPlugin.sign(base, net, key));
    const h = toHex(intentHash(base));
    for (const m of [{ memo: '1' }, { x: { ...X, sequence: '8' } }, { x: { ...X, account_number: '1425848' } }, { x: { ...X, timeout_height: '33821257' } }, { x: { ...X, gas_limit: '200001' } },
      { x: { ...X, fee_amount: '1499' } }, { amount: '2500001' }, { to: DEST2 }])
      expect(toHex(intentHash({ ...base, ...m }))).not.toBe(h);
    expect(canonicalBytes(base).length).toBeGreaterThan(0);
    expect(() => canonicalBytes({ ...base, x: undefined })).toThrow(/chain section/);
  });
});

describe('cosmos: fail closed', () => {
  const bad = (m: Partial<Intent>, aux?: Record<string, unknown>) => () => cosmosPlugin.build({ ...base, ...m }, net, aux);
  it('refuses another chain, another family, foreign sections', () => {
    expect(bad({ chainRef: 'cosmoshub-3' })).toThrow(/wrong chain/);
    expect(bad({ chainRef: 'theta-testnet-001' })).toThrow(/wrong chain/);
    expect(bad({ chainRef: NETWORKS.bitcoin.chainRef })).toThrow(/wrong chain/);
    expect(bad({ network: 'solana' })).toThrow(/not for this/);
    expect(() => cosmosPlugin.build(base, NETWORKS.bitcoin)).toThrow(/not a Cosmos/);
    expect(() => cosmosPlugin.build(base, NETWORKS.xrpl)).toThrow(/not a Cosmos/);
    expect(() => cosmosPlugin.build(base, { ...net, chainRef: 'osmosis-1' })).toThrow(/wrong chain/);
    expect(bad({ evm: { nonce: 0, gasLimit: '21000', maxFeePerGas: '1', maxPriorityFeePerGas: '1' } })).toThrow(/foreign/);
    expect(bad({ btc: { inputs: [{ txid: 'aa'.repeat(32), vout: 0, value: '1' }], change: '0', fee: '1' } })).toThrow(/foreign/);
  });
  it('refuses anything but the native coin', () => {
    expect(bad({ asset: 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2' })).toThrow(/only native ATOM/);
    expect(bad({ asset: 'uatom' })).toThrow(/only native ATOM/);
    expect(bad({ symbol: 'OSMO' })).toThrow(/only native ATOM/);
    expect(bad({ decimals: 18 })).toThrow(/only native ATOM/);
  });
  it('refuses invalid, non-normalized and foreign addresses and a self-send', () => {
    expect(bad({ to: ` ${DEST}` })).toThrow(/invalid address/);
    expect(bad({ to: DEST.toUpperCase() })).toThrow(/invalid address/);
    expect(bad({ to: DEST.slice(0, -1) + 'q' })).toThrow(/checksum/);
    expect(bad({ from: VECTOR_ADDRESS.slice(0, -2) + 'qq' })).toThrow(/checksum/);
    expect(bad({ to: cosmosAddressFromPublicKey('osmo', pub) })).toThrow(/invalid address/);
    expect(bad({ to: cosmosAddressFromPublicKey('cosmosvaloper', pub) })).toThrow(/invalid address/);
    expect(bad({ to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' })).toThrow(/invalid address/);
    expect(bad({ to: VECTOR_ADDRESS })).toThrow(/destination equals source/);
  });
  it('refuses bad amounts, fees and gas', () => {
    expect(bad({ amount: '0' })).toThrow(/amount must be positive/);
    expect(bad({ amount: '-1' })).toThrow();
    expect(bad({ amount: '1.5' })).toThrow();
    expect(bad({ amount: '01' })).toThrow();
    expect(bad({ maxFee: '1499' })).toThrow(/fee above the approved maximum/);
    expect(bad({ x: { ...X, fee_amount: '1501' } })).toThrow(/fee above the approved maximum/);
    expect(bad({ x: { ...X, fee_amount: '0' } })).toThrow(/fee must be positive/);
    expect(bad({ x: { ...X, fee_amount: '01500' } })).toThrow(/invalid fee_amount/);
    expect(bad({ x: { ...X, gas_limit: '0' } })).toThrow(/gas_limit out of range/);
    expect(bad({ x: { ...X, gas_limit: (COSMOS_MAX_GAS + 1n).toString() } })).toThrow(/gas_limit out of range/);
    expect(bad({ x: { ...X, timeout_height: '0' } })).toThrow(/timeout_height is required/);
  });
  it('refuses unknown, missing or malformed chain parameters and memos', () => {
    expect(bad({ x: undefined })).toThrow(/missing/);
    expect(bad({ x: { ...X, granter: DEST2 } })).toThrow(/unknown or missing/); // e.g. an attempt to make someone else pay the fee
    expect(bad({ x: { ...X, fee_denom: 'ibc/ABC' } })).toThrow(/unknown or missing/);
    expect(bad({ x: { ...X, unordered: '1' } })).toThrow(/unknown or missing/);
    const { timeout_height: _t, ...noTimeout } = X;
    expect(bad({ x: noTimeout })).toThrow(/unknown or missing/);
    expect(bad({ x: { ...noTimeout, timeoutHeight: '33821256' } })).toThrow(/unknown or missing/);
    for (const k of Object.keys(X) as (keyof typeof X)[])
      for (const v of ['-1', '9223372036854775808', '1e3', '0x10', '', ' 5', '05', '1.0', '18446744073709551616'])
        expect(bad({ x: { ...X, [k]: v } }), `${k} ${JSON.stringify(v)}`).toThrow();
    for (const v of ['', ' 104588310', '104588310 ', 'a\nb', 'tab\there', '\u0000', 'x'.repeat(257), '\ud800'])
      expect(bad({ memo: v }), `memo ${JSON.stringify(v)}`).toThrow(/memo/);
    expect(bad({ memo: 'é'.repeat(128) })).not.toThrow(); // 256 bytes
    expect(bad({ memo: 'é'.repeat(129) })).toThrow(/too long/);
    expect(cosmosMemo(undefined)).toBe('');
    expect(cosmosMemo('104588310')).toBe('104588310');
  });
  it('accepts helper data only when it is the matching public key', () => {
    expect(bad({}, { publicKey: toHex(pub) })).not.toThrow();
    expect(bad({}, {})).not.toThrow();
    expect(bad({}, { prevTx: {} })).toThrow(/unknown helper/);
    expect(bad({}, { publicKey: toHex(pub), extra: 1 })).toThrow(/unknown helper/);
    expect(bad({}, { publicKey: 'zz' })).toThrow(/unknown helper/);
    expect(bad({}, { publicKey: toHex(secp256k1.getPublicKey(new Uint8Array(32).fill(7), true)) })).toThrow(/does not match/);
    expect(() => cosmosSignDoc(base, net, secp256k1.getPublicKey(new Uint8Array(32).fill(7), true))).toThrow(/does not match/);
    expect(() => cosmosPlugin.sign(base, net, key, { prevTx: {} })).toThrow(/unknown helper/);
  });
  it('sign() refuses a key that is not the source account, a wrong curve, and a bad signature from the key module', () => {
    const otherPriv = new Uint8Array(32).fill(7);
    expect(() => cosmosPlugin.sign(base, net, handleOf(otherPriv))).toThrow(/not controlled/);
    expect(() => cosmosPlugin.sign(base, net, { curve: 'ed25519', publicKey: pub.slice(1), signMessage: () => new Uint8Array(64) })).toThrow(/secp256k1/);
    expect(() => cosmosPlugin.sign(base, net, { ...key, signDigest: undefined })).toThrow(/secp256k1/);
    expect(() => cosmosPlugin.sign(base, net, { ...key, signDigest: handleOf(otherPriv).signDigest })).toThrow(/self-check/); // signs with another private key
    const highS: KeyHandle = { ...key, signDigest: (d) => { // non-canonical (high-S) signature: the chain rejects it
      const s = secp256k1.Signature.fromBytes(key.signDigest!(d).compact, 'compact');
      const flipped = new secp256k1.Signature(s.r, secp256k1.Point.CURVE().n - s.s);
      return { compact: flipped.toBytes('compact'), recovery: 0, der: flipped.toBytes('der') }; } };
    expect(() => cosmosPlugin.sign(base, net, highS)).toThrow(/self-check/);
    expect(() => cosmosPlugin.sign(base, net, { ...key, signDigest: (d) => ({ ...key.signDigest!(d), compact: key.signDigest!(d).der }) })).toThrow(/self-check/); // DER instead of r||s
    expect(() => cosmosPlugin.sign({ ...base, amount: '0' }, net, key)).toThrow(/positive/);
    expect(() => cosmosPlugin.sign({ ...base, maxFee: '1' }, net, key)).toThrow(/approved maximum/);
    expect(() => cosmosTxid('not base64!')).toThrow(/invalid transaction payload/);
    expect(() => cosmosTxid('')).toThrow(/invalid transaction payload/);
  });
  it('changing any intent field changes the signed bytes or throws', () => {
    const ref = cosmosPlugin.sign(base, net, key);
    const changes: Partial<Intent>[] = [{ amount: '2500001' }, { to: DEST2 }, { memo: '7' }, { memo: '07' }, { x: { ...X, sequence: '8' } }, { x: { ...X, account_number: '1425848' } },
      { x: { ...X, timeout_height: '33821257' } }, { x: { ...X, gas_limit: '200001' } }, { x: { ...X, fee_amount: '1499' } }, { maxFee: '1501', x: { ...X, fee_amount: '1501' } }];
    const seen = new Set([ref.raw]), docs = new Set([toHex(cosmosPlugin.build(base, net).signDocs[0]!)]);
    for (const c of changes) {
      const r = cosmosPlugin.sign({ ...base, ...c }, net, key), doc = toHex(cosmosPlugin.build({ ...base, ...c }, net).signDocs[0]!);
      expect(seen.has(r.raw), JSON.stringify(c)).toBe(false);
      expect(docs.has(doc), JSON.stringify(c)).toBe(false);
      expect(r.txid).not.toBe(ref.txid);
      seen.add(r.raw); docs.add(doc);
    }
    for (const c of [{ from: DEST2 }, { chainRef: 'cosmoshub-5' }, { asset: 'uatom' }, { symbol: 'XLM' }, { decimals: 7 }, { network: 'bitcoin' }, { maxFee: '1499' }] as Partial<Intent>[])
      expect(() => cosmosPlugin.sign({ ...base, ...c }, net, key), JSON.stringify(c)).toThrow();
    // fields that are not part of the chain transaction are still bound by the approval (intent hash)
    for (const c of [{ proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a12' }, { keyId: 'spw-fedcba9876543210' }, { expiresAt: now + 46 }, { createdAt: now + 1 }, { policyVersion: 4 }, { maxFee: '1501' }] as Partial<Intent>[])
      expect(toHex(intentHash({ ...base, ...c }))).not.toBe(toHex(intentHash(base)));
  });
});
