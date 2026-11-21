/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/test/hyperliquid/signing.test.ts
 * Module           : derivatives
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
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

// Signing library against the OFFICIAL SDK:
//  A. every signature vector of hyperliquid-python-sdk tests/signing_test.py (master 2fdb18f, 2026-06-04), ported one for one —
//     same private key, same actions, same expected r / s / v;
//  B. cross-vectors produced by running the official SDK itself (0.24.0, signing.py identical to master) for the action types
//     its test file does not cover: cancel, cancelByCloid, updateLeverage, expiresAfter, more order shapes, approveAgent,
//     usdClassTransfer, withdraw3 (fixtures/hyperliquid/sdk-vectors.json, generator next to it).
import { describe, expect, it } from 'vitest';
import {
  HL_PRIMARY, HL_USD_SEND_TYPES, buildApproveAgent, buildUsdClassTransferTypedDataOnly, buildWithdraw3TypedDataOnly, createHlTrading, l1ActionHash, l1SignPayload,
  l1TypedData, msgpackEncode, normalizeSignature, recoverTypedDataSigner, signatureFromHex, userSignedTypedData, type HlAsset, type MsgpackValue,
} from '../../src/venues/hyperliquid/index.ts';
import type { Instrument, OrderRequest } from '../../src/index.ts';
import { SDK_TEST_KEY, raw, sameSig, signWith } from './helpers.ts';

const signL1 = async (action: MsgpackValue, vault: string | null, nonce: number, expiresAfter: number | null, mainnet: boolean) =>
  signWith(SDK_TEST_KEY, l1SignPayload(action, { network: mainnet ? 'mainnet' : 'testnet', nonce, vaultAddress: vault, expiresAfter }).typedData);
const expectSig = (got: { r: string; s: string; v: number }, r: string, s: string, v: number) => expect(sameSig(got, { r, s, v }), `got ${JSON.stringify(got)}`).toBe(true);

// The SDK tests place orders on "ETH" with an explicit asset index (1 or 4). A two-row asset table reproduces that through the
// real builder, so that the order vectors exercise buildOrder end to end and not a hand-written action.
const eth = (asset: number): { assets: HlAsset[]; instrument: Instrument } => ({
  assets: [{ symbol: 'ETH', asset, szDecimals: 4, maxLeverage: 25, isolatedOnly: false, delisted: false }],
  instrument: { venue: 'hyperliquid', symbol: 'ETH', id: 'hyperliquid:ETH', base: 'ETH', quote: 'USD', kind: 'perpetual', collateral: 'USDC', settlement: '', tickSize: '0.01', lotSize: '0.0001',
    minOrderSize: null, minNotional: '10', maxLeverage: '25', marginModes: ['cross', 'isolated'], fundingIntervalSec: 3600, markPriceMethod: '', status: 'active' },
});
const req = (o: Partial<OrderRequest>): OrderRequest => ({ instrument: 'hyperliquid:ETH', side: 'buy', type: 'limit', size: '100', price: '100', triggerPrice: null, reduceOnly: false, tif: 'gtc', clientId: 'x', ...o });
/** the SDK vectors without cloid: build with the real builder, then drop the `c` field that our builder always sets */
const withoutCloid = (a: { type: 'order'; orders: { c?: string }[]; grouping: 'na' }) => ({ ...a, orders: a.orders.map(({ c: _c, ...o }) => o) }) as unknown as MsgpackValue;

describe('A. official SDK vectors (tests/signing_test.py)', () => {
  it('test_phantom_agent_creation_matches_production', () => {
    const { assets, instrument } = eth(4);
    const built = createHlTrading({ network: 'mainnet', assets }).buildOrder(req({ size: '0.0147', price: '1670.1', tif: 'ioc' }), { instrument, nonce: 1677777606040 });
    const action = withoutCloid(built.action);
    expect(action).toEqual({ type: 'order', orders: [{ a: 4, b: true, p: '1670.1', s: '0.0147', r: false, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' });
    expect(l1ActionHash(action, null, 1677777606040, null)).toBe('0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908');
  });

  it('test_l1_action_signing_matches', async () => {
    const action = { type: 'dummy', num: 100000000000 }; // float_to_int_for_hashing(1000)
    expectSig(await signL1(action, null, 0, null, true), '0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298', '0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8', 27);
    expectSig(await signL1(action, null, 0, null, false), '0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510', '0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613', 28);
  });

  it('test_l1_action_signing_order_matches', async () => {
    const { assets, instrument } = eth(1);
    const action = withoutCloid(createHlTrading({ network: 'mainnet', assets }).buildOrder(req({}), { instrument, nonce: 1 }).action);
    expect(action).toEqual({ type: 'order', orders: [{ a: 1, b: true, p: '100', s: '100', r: false, t: { limit: { tif: 'Gtc' } } }], grouping: 'na' });
    expectSig(await signL1(action, null, 0, null, true), '0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e', '0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e', 28);
    expectSig(await signL1(action, null, 0, null, false), '0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54', '0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5', 27);
  });

  it('test_l1_action_signing_order_with_cloid_matches', async () => {
    const { assets, instrument } = eth(1);
    // a clientId that already is a cloid is used unchanged
    const action = createHlTrading({ network: 'mainnet', assets }).buildOrder(req({ clientId: '0x00000000000000000000000000000001' }), { instrument, nonce: 1 }).action as unknown as MsgpackValue;
    expect(action).toEqual({ type: 'order', orders: [{ a: 1, b: true, p: '100', s: '100', r: false, t: { limit: { tif: 'Gtc' } }, c: '0x00000000000000000000000000000001' }], grouping: 'na' });
    expectSig(await signL1(action, null, 0, null, true), '0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3', '0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da', 27);
    expectSig(await signL1(action, null, 0, null, false), '0xeba0664bed2676fc4e5a743bf89e5c7501aa6d870bdb9446e122c9466c5cd16d', '0x7f3e74825c9114bc59086f1eebea2928c190fdfbfde144827cb02b85bbe90988', 28);
  });

  it('test_l1_action_signing_matches_with_vault', async () => {
    const action = { type: 'dummy', num: 100000000000 }, vault = '0x1719884eb866cb12b2287399b15f7db5e7d775ea';
    expectSig(await signL1(action, vault, 0, null, true), '0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239', '0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c', 28);
    expectSig(await signL1(action, vault, 0, null, false), '0xe281d2fb5c6e25ca01601f878e4d69c965bb598b88fac58e475dd1f5e56c362b', '0x7ddad27e9a238d045c035bc606349d075d5c5cd00a6cd1da23ab5c39d4ef0f60', 27);
  });

  it('test_l1_action_signing_tpsl_order_matches', async () => {
    const { assets, instrument } = eth(1);
    const action = withoutCloid(createHlTrading({ network: 'mainnet', assets }).buildOrder(req({ type: 'stop_market', triggerPrice: '103' }), { instrument, nonce: 1 }).action);
    expect(action).toEqual({ type: 'order', orders: [{ a: 1, b: true, p: '100', s: '100', r: false, t: { trigger: { isMarket: true, triggerPx: '103', tpsl: 'sl' } } }], grouping: 'na' });
    expectSig(await signL1(action, null, 0, null, true), '0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9', '0x6b5bb6bb0633b710aa22b721dd9dee6d083646a5f8e581a20b545be6c1feb405', 27);
    expectSig(await signL1(action, null, 0, null, false), '0x971c554d917c44e0e1b6cc45d8f9404f32172a9d3b3566262347d0302896a2e4', '0x206257b104788f80450f8e786c329daa589aa0b32ba96948201ae556d5637eac', 28);
  });

  it('test_sign_usd_transfer_action (generic user-signed machinery; usdSend itself is not exposed)', async () => {
    const td = userSignedTypedData(HL_PRIMARY.usdSend, HL_USD_SEND_TYPES, { hyperliquidChain: 'Testnet', destination: '0x5e9ee1089755c3435139848e47e6635505d5a13a', amount: '1', time: 1687816341423 }, '0x66eee');
    expectSig(await signWith(SDK_TEST_KEY, td), '0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073', '0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7', 27);
  });

  it('test_sign_withdraw_from_bridge_action', async () => {
    const { typedData, action } = buildWithdraw3TypedDataOnly({ network: 'testnet', destination: '0x5e9ee1089755c3435139848e47e6635505d5a13a', amount: '1', time: 1687816341423 });
    expect(action).toEqual({ type: 'withdraw3', hyperliquidChain: 'Testnet', signatureChainId: '0x66eee', destination: '0x5e9ee1089755c3435139848e47e6635505d5a13a', amount: '1', time: 1687816341423 });
    expectSig(await signWith(SDK_TEST_KEY, typedData), '0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9', '0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881', 28);
  });

  it('test_create_sub_account_action', async () => {
    const action = { type: 'createSubAccount', name: 'example' };
    expectSig(await signL1(action, null, 0, null, true), '0x51096fe3239421d16b671e192f574ae24ae14329099b6db28e479b86cdd6caa7', '0xb71f7d293af92d3772572afb8b102d167a7cef7473388286bc01f52a5c5b423', 27);
    expectSig(await signL1(action, null, 0, null, false), '0xa699e3ed5c2b89628c746d3298b5dc1cca604694c2c855da8bb8250ec8014a5b', '0x53f1b8153a301c72ecc655b1c315d64e1dcea3ee58921fd7507e35818fcc1584', 28);
  });

  it('test_sub_account_transfer_action', async () => {
    const action = { type: 'subAccountTransfer', subAccountUser: '0x1d9470d4b963f552e6f671a81619d395877bf409', isDeposit: true, usd: 10 };
    expectSig(await signL1(action, null, 0, null, true), '0x43592d7c6c7d816ece2e206f174be61249d651944932b13343f4d13f306ae602', '0x71a926cb5c9a7c01c3359ec4c4c34c16ff8107d610994d4de0e6430e5cc0f4c9', 28);
    expectSig(await signL1(action, null, 0, null, false), '0xe26574013395ad55ee2f4e0575310f003c5bb3351b5425482e2969fa51543927', '0xefb08999196366871f919fd0e138b3a7f30ee33e678df7cfaf203e25f0a4278', 28);
  });

  it('test_schedule_cancel_action', async () => {
    const a1 = { type: 'scheduleCancel' };
    expectSig(await signL1(a1, null, 0, null, true), '0x6cdfb286702f5917e76cd9b3b8bf678fcc49aec194c02a73e6d4f16891195df9', '0x6557ac307fa05d25b8d61f21fb8a938e703b3d9bf575f6717ba21ec61261b2a0', 27);
    expectSig(await signL1(a1, null, 0, null, false), '0xc75bb195c3f6a4e06b7d395acc20bbb224f6d23ccff7c6a26d327304e6efaeed', '0x342f8ede109a29f2c0723bd5efb9e9100e3bbb493f8fb5164ee3d385908233df', 28);
    const a2 = { type: 'scheduleCancel', time: 123456789 };
    expectSig(await signL1(a2, null, 0, null, true), '0x609cb20c737945d070716dcc696ba030e9976fcf5edad87afa7d877493109d55', '0x16c685d63b5c7a04512d73f183b3d7a00da5406ff1f8aad33f8ae2163bab758b', 28);
    expectSig(await signL1(a2, null, 0, null, false), '0x4e4f2dbd4107c69783e251b7e1057d9f2b9d11cee213441ccfa2be63516dc5bc', '0x706c656b23428c8ba356d68db207e11139ede1670481a9e01ae2dfcdb0e1a678', 27);
  });
});

describe('B. cross-vectors generated with the official SDK 0.24.0', () => {
  const v = raw('sdk-vectors.json') as {
    sdk: string; address: string;
    l1: { name: string; action: MsgpackValue; vaultAddress: string | null; nonce: number; expiresAfter: number | null; network: 'mainnet' | 'testnet'; connectionId: string; signature: { r: string; s: string; v: number } }[];
    user: { name: string; kind: string; action: any; network: 'mainnet' | 'testnet'; signature: { r: string; s: string; v: number } }[];
  };

  it('holds the expected number of vectors', () => {
    expect(v.sdk).toBe('hyperliquid-python-sdk 0.24.0');
    expect(v.l1.length).toBe(34);
    expect(v.user.length).toBe(12);
  });

  it.each(v.l1.map((x) => [`${x.name} (${x.network})`, x] as const))('L1: %s', async (_n, x) => {
    expect(l1ActionHash(x.action, x.vaultAddress, x.nonce, x.expiresAfter)).toBe(x.connectionId);
    const td = l1SignPayload(x.action, { network: x.network, nonce: x.nonce, vaultAddress: x.vaultAddress, expiresAfter: x.expiresAfter }).typedData;
    expect(sameSig(await signWith(SDK_TEST_KEY, td), x.signature)).toBe(true);
    expect(await recoverTypedDataSigner(td, x.signature)).toBe(v.address);
  });

  it.each(v.user.map((x) => [`${x.name} (${x.network})`, x] as const))('user-signed: %s', async (_n, x) => {
    const a = x.action;
    expect(a.signatureChainId).toBe('0x66eee');
    const built = x.kind === 'approveAgent' ? buildApproveAgent({ network: x.network, agentAddress: a.agentAddress, agentName: a.agentName === '' ? null : a.agentName, nonce: a.nonce })
      : x.kind === 'usdClassTransfer' ? buildUsdClassTransferTypedDataOnly({ network: x.network, amount: a.amount, toPerp: a.toPerp, nonce: a.nonce })
      : buildWithdraw3TypedDataOnly({ network: x.network, destination: a.destination, amount: a.amount, time: a.time });
    expect(built.typedData.message.hyperliquidChain).toBe(a.hyperliquidChain);
    expect(sameSig(await signWith(SDK_TEST_KEY, built.typedData), x.signature)).toBe(true);
    expect(await recoverTypedDataSigner(built.typedData, x.signature)).toBe(v.address);
    // the action that is sent holds the same values that were signed (the unnamed agent omits agentName, as the SDK does)
    for (const [k, val] of Object.entries(built.action)) expect(k === 'agentName' || a[k] === val || String(a[k]).toLowerCase() === val, k).toBe(true);
  });
});

describe('msgpack encoder and helpers', () => {
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  it('encodes the subset exactly as the msgpack specification says', () => {
    expect(hex(msgpackEncode(null))).toBe('c0');
    expect(hex(msgpackEncode([true, false]))).toBe('92c3c2');
    expect(hex(msgpackEncode(127))).toBe('7f');
    expect(hex(msgpackEncode(128))).toBe('cc80');
    expect(hex(msgpackEncode(65535))).toBe('cdffff');
    expect(hex(msgpackEncode(65536))).toBe('ce00010000');
    expect(hex(msgpackEncode(4294967296))).toBe('cf0000000100000000');
    expect(hex(msgpackEncode(1700000000000))).toBe('cf0000018bcfe56800');
    expect(hex(msgpackEncode(-1))).toBe('ff');
    expect(hex(msgpackEncode(-33))).toBe('d0df');
    expect(hex(msgpackEncode(-32769))).toBe('d2ffff7fff');
    expect(hex(msgpackEncode('a'.repeat(31)))).toBe(`bf${'61'.repeat(31)}`);
    expect(hex(msgpackEncode('a'.repeat(32)))).toBe(`d920${'61'.repeat(32)}`);
    expect(hex(msgpackEncode('é'))).toBe('a2c3a9');
    expect(hex(msgpackEncode({ type: 'noop' }))).toBe('81a474797065a46e6f6f70');
    expect(hex(msgpackEncode(Array.from({ length: 16 }, () => 0)))).toBe(`dc0010${'00'.repeat(16)}`);
  });
  it('keeps insertion order and refuses what must never be in a signed action', () => {
    expect(hex(msgpackEncode({ b: 1, a: 2 }))).not.toBe(hex(msgpackEncode({ a: 2, b: 1 })));
    expect(() => msgpackEncode(1.5)).toThrow(/safe integers/);
    expect(() => msgpackEncode(NaN)).toThrow();
    expect(() => msgpackEncode(2 ** 60)).toThrow();
    expect(() => msgpackEncode({ x: undefined } as never)).toThrow(/unsupported/);
    expect(() => msgpackEncode({ 1: 'x' } as never)).toThrow(/integer-like/);
    expect(() => msgpackEncode(new Date() as never)).toThrow(/plain objects/);
    expect(() => msgpackEncode(10n as never)).toThrow(/unsupported/);
  });
  it('the action hash changes with every input', () => {
    const a = { type: 'cancel', cancels: [{ a: 1, o: 2 }] }, base = l1ActionHash(a, null, 5, null);
    expect(l1ActionHash(a, null, 6, null)).not.toBe(base);
    expect(l1ActionHash(a, '0x1719884eb866cb12b2287399b15f7db5e7d775ea', 5, null)).not.toBe(base);
    expect(l1ActionHash(a, null, 5, 9)).not.toBe(base);
    expect(l1ActionHash({ type: 'cancel', cancels: [{ o: 2, a: 1 }] }, null, 5, null)).not.toBe(base); // field order matters
    expect(l1ActionHash(a, '0x1719884EB866CB12B2287399B15F7DB5E7D775EA', 5, null)).toBe(l1ActionHash(a, '0x1719884eb866cb12b2287399b15f7db5e7d775ea', 5, null));
    expect(() => l1ActionHash(a, null, -1, null)).toThrow();
    expect(() => l1ActionHash(a, '0x12', 1, null)).toThrow();
  });
  it('phantom agent typed data: domain Exchange, chain 1337, source a / b', () => {
    const id = `0x${'ab'.repeat(32)}` as const;
    expect(l1TypedData(id, 'mainnet')).toMatchObject({ domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' }, primaryType: 'Agent', message: { source: 'a', connectionId: id } });
    expect(l1TypedData(id, 'testnet').message.source).toBe('b');
    expect(() => l1TypedData('0x12' as never, 'mainnet')).toThrow();
  });
  it('signature forms', () => {
    const s = signatureFromHex(`0x${'11'.repeat(32)}${'22'.repeat(32)}1b`);
    expect(s).toEqual({ r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}`, v: 27 });
    expect(signatureFromHex(`0x${'11'.repeat(32)}${'22'.repeat(32)}01`).v).toBe(28);
    expect(normalizeSignature({ r: '0x1', s: '0x2', v: 28 })).toEqual({ r: `0x${'0'.repeat(63)}1`, s: `0x${'0'.repeat(63)}2`, v: 28 });
    expect(() => normalizeSignature({ r: '0x1', s: '0x2', v: 1 })).toThrow();
    expect(() => signatureFromHex('0x12')).toThrow();
  });
  it('user-signed builders refuse malformed input', () => {
    expect(() => buildApproveAgent({ network: 'testnet', agentAddress: '0x12', agentName: null, nonce: 1 })).toThrow();
    expect(() => buildApproveAgent({ network: 'testnet', agentAddress: `0x${'1'.repeat(40)}`, agentName: 'bad name!', nonce: 1 })).toThrow();
    expect(() => buildWithdraw3TypedDataOnly({ network: 'testnet', destination: `0x${'1'.repeat(40)}`, amount: '1e3', time: 1 })).toThrow();
    expect(() => buildUsdClassTransferTypedDataOnly({ network: 'testnet', amount: '-1', toPerp: true, nonce: 1 })).toThrow();
    expect(() => userSignedTypedData('X', [{ name: 'a', type: 'string' }], { a: 'x', b: 'y' }, '0x66eee')).toThrow();
  });
});
