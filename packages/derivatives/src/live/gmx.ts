/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/live/gmx.ts
 * Module           : live
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
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

// GMX v2 (GMX Synthetics) on Arbitrum One — the part of live trading shared by the isolated signer and the API (v8).
// Pure: no network, no clock, no key. Facts, sources and evidence: docs/v4/venues/gmx.md, Part C.
//
// A GMX order is an ON-CHAIN TRANSACTION of the wallet's own key: there is no venue account and no trading key. So the
// signer BUILDS the transaction itself, from an owner-approved intent (packages/core/src/intent.ts, section `gmx`) and the
// constants pinned here; nothing a provider or the API built is ever signed:
//
//   ERC20(collateral).approve(Router, amount)                       exact amount, only when asked (increase)
//   ExchangeRouter.multicall{value: executionFee}([
//     sendWnt(OrderVault, executionFee),                             wraps msg.value into the order vault = the keeper's fee
//     sendTokens(collateral, OrderVault, amount),                    increase only; Router.pluginTransfer(token, msg.sender, …)
//     createOrder(params) ])
//   ExchangeRouter.cancelOrder(key)                                  cancel
//
// What the verified sources say (ExchangeRouter 0x7dE39FF2…, OrderHandler 0xa5D2d452…, Router, read on Arbiscan 2026-11-11):
//   - `sendTokens` pulls from `msg.sender` only (`router.pluginTransfer(token, msg.sender, receiver, amount)`), through the
//     allowance given to `Router`; `Router.pluginTransfer` is `onlyRouterPlugin` (a role in RoleStore);
//   - `createOrder` records `account = msg.sender`; for an increase the collateral of the order is what the vault MEASURED
//     (`orderVault.recordTransferIn`), the execution fee is the WNT the vault measured (≥ `params.numbers.executionFee`);
//   - every output of an executed order goes to `receiver`; a cancelled increase returns its collateral to
//     `cancellationReceiver` and the unused execution fee to `cancellationReceiver` (to `receiver` on execution or freeze);
//   - `cancelOrder(key)` requires `order.account == msg.sender`; a market order can be cancelled by its account only
//     `REQUEST_EXPIRATION_TIME` (300 s, DataStore) after its creation; keepers (`ORDER_KEEPER`) may cancel it after the same delay.
// With receiver = cancellationReceiver = the wallet, no callback contract, no UI fee receiver, no swap path and no
// referral code, the only addresses that can receive anything from an order are GMX's own contracts and the wallet.
//
// THE PINNED TABLE IS A TRUST INPUT OF THE SIGNER: it ships in its bundle and is never received from the API.
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, keccak256, type Abi, type Hex, type TransactionSerializableEIP1559 } from 'viem';
import { z } from 'zod';
import { D, type DecStr } from '../decimal.ts';
import { DecStrSchema } from '../models.ts';
import { hex } from './canonical.ts';

// ---------------------------------------------------------------------------------------------------------------------------
// Pins

export interface GmxPin { /** EIP-55 */ readonly address: string; /** SHA-256 of the runtime bytecode, identical on both registry RPC endpoints */ readonly codeSha256: string; readonly codeBytes: number }
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;

/**
 * GMX contracts are NOT proxies: GMX ships new logic as NEW deployments and moves the roles in RoleStore. A new
 * ExchangeRouter therefore has another address (this table then no longer matches GMX's documentation), and the old one
 * loses `CONTROLLER` / `ROUTER_PLUGIN` (the on-chain role check then fails). Either way trading stops until this table is
 * reviewed again — docs/v4/venues/gmx.md "How to re-review after a GMX release".
 */
export const GMX_PINS = {
  /** an authorization commits to this identifier: a re-review that changes the table voids every authorization */
  id: 'gmx-v2-arbitrum-2026-11-11',
  reviewed: '2026-11-11: addresses = docs.gmx.io/docs/api/contracts/addresses + gmx-synthetics deployments/arbitrum (branch updates @ bf30ebb4); runtime bytecode hashed on both registry RPC endpoints; verified sources of ExchangeRouter and OrderHandler read on Arbiscan (solc 0.8.29, not proxies)',
  network: 'arbitrum', chainId: 42161,
  exchangeRouter: { address: '0x7dE39FF2e232A2203196788d37e234cF8F1b83f1', codeSha256: '76169686cbf23f3e226d92841776b8e1f1b0647ebc7a76ce29a75eb014bffde5', codeBytes: 20999 },
  /** the ERC-20 spender: `Router.pluginTransfer` is the only code that moves the wallet's tokens */
  router: { address: '0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6', codeSha256: 'f50f32351ad61911d5a96e82483ce53780e61eec6cd2a12ccdd85f5637544484', codeBytes: 1503 },
  orderVault: { address: '0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5', codeSha256: 'e3e5559ff93aefd36027dfa7deb77ff350028c80fded2687456243e680dc0669', codeBytes: 4570 },
  dataStore: { address: '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8', codeSha256: '0524e4f2a73947f6e74c2a3e33bc399c56db0d5a6d428ab5c013957a0964f77b', codeBytes: 10443 },
  reader: { address: '0xfA26cBb46e2614609406de08CA1Dc7f70a684184', codeSha256: 'a8ac6f41c73e92794168cda29d75d90831e433f865e666cb72136eddd4ba5fc7', codeBytes: 23870 },
  /** immutable of the ExchangeRouter (constructor argument); holds the order logic (linked libraries are part of its bytecode) */
  orderHandler: { address: '0xa5D2d45228ee2E3A18AB122B2cE84997d008f4Eb', codeSha256: '2113ebc4aa3bd22b80e44e075eea137aabdfb67438883b9e3ee14e5cb6f5e06e', codeBytes: 24525 },
  roleStore: { address: '0x3c3d99FD298f679DBC2CEcd132b4eC4d0F5e6e72', codeSha256: 'd50d6f1e6c1b751b9c8a90a26e7a1d04939f281b9a0ee322fecd7c8d50d19de1', codeBytes: 2342 },
  eventEmitter: { address: '0xC8ee91A54287DB53897056e12D9819156D3822Fb', codeSha256: '29e899318a0b8cbc8cce0cbae83f88efcfb72970d34bf1fed7bb2898a0e8db78', codeBytes: 7998 },
  /** wrapped native token the execution fee is paid in (DataStore key WNT) */
  wnt: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  /** read-only dry run of the latest order (SimulationRouter.simulateExecuteLatestOrder); not on the signing path */
  simulationRouter: { address: '0xaD3051cB1aE3a86b335f12A9a41BD4d995a137ea', codeSha256: 'ff09bf6a840bc854949cb03f7604488a6fcac20576e65850940fec11d7ba82d4', codeBytes: 6994 },
} as const;
export const GMX_PINNED_CONTRACTS = ['exchangeRouter', 'router', 'orderVault', 'dataStore', 'reader', 'orderHandler', 'roleStore', 'eventEmitter'] as const;
export type GmxPinnedContract = (typeof GMX_PINNED_CONTRACTS)[number];

/** RoleStore role keys = keccak256(abi.encode(<name>)) (role/Role.sol) */
export const GMX_ROLE_KEYS = {
  CONTROLLER: '0x97adf037b2472f4a6a9825eff7d2dd45e37f2dc308df2a260d6a72af4189a65b',
  ROUTER_PLUGIN: '0xc82e6cc76072f8edb32d42796e58e13ab6e145524eb6b36c073be82f20d410f3',
  ORDER_KEEPER: '0x40a07f8f0fc57fcf18b093d96362a8e661eaac7b7e6edbf66f242111f83a6794',
} as const;
/** the roles the pinned contracts must still hold for an order to be creatable through them: read on-chain before every preparation */
export const GMX_REQUIRED_ROLES: readonly { holder: GmxPinnedContract; role: keyof typeof GMX_ROLE_KEYS; why: string }[] = [
  { holder: 'exchangeRouter', role: 'CONTROLLER', why: 'the ExchangeRouter calls OrderHandler.createOrder / cancelOrder (onlyController)' },
  { holder: 'exchangeRouter', role: 'ROUTER_PLUGIN', why: 'the ExchangeRouter calls Router.pluginTransfer (onlyRouterPlugin)' },
  { holder: 'orderHandler', role: 'CONTROLLER', why: 'the OrderHandler writes orders to the DataStore and moves the OrderVault (onlyController)' },
];
/** DataStore keys = keccak256(abi.encode(<name>)) (data/Keys.sol), values read 2026-11-11 in the comment */
export const GMX_DATASTORE_KEYS = {
  REQUEST_EXPIRATION_TIME: '0xf664ba0f4e5389df44705cd100171228b74c4f050a9f00bd873e95d25c49a273', // 300
  INCREASE_ORDER_GAS_LIMIT: '0x983e0a7f5307213e84497f2543331fe5e404db14ddf98f98dc956e0ee3ab6875', // 3 000 000
  DECREASE_ORDER_GAS_LIMIT: '0xfce7a3444b72c2d30987163c1f2e6c00cffa03bf0b6ca2f077e8db006b4cae8b', // 3 000 000
  ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1: '0x39288f227e5db9a793e9f4afb15aa22b77dbb7e410ffc973c816a19a6ed921cd', // 133 637
  ESTIMATED_GAS_FEE_PER_ORACLE_PRICE: '0xf95915378e4358fb5f51ae0fd75853a15a29a978eb14b73d5c5b7d69d3b9fccc', // 338 679
  ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR: '0xce135f2a886cf6d862269f215b1e64498fa09cb04f90b771b163399df2a82b81', // 1e30
} as const;
/** a DataStore key or a role key by name: keccak256(abi.encode(name)) */
export const gmxKey = (name: string): Hex => keccak256(encodeAbiParameters([{ type: 'string' }], [name]));
/** documented and read on-chain 2026-11-11 (DataStore REQUEST_EXPIRATION_TIME): a market order can be cancelled by its account after this */
export const GMX_REQUEST_EXPIRATION_SEC = 300;
/** oracle prices of a position order without a swap path (GasUtils.estimateOrderOraclePriceCount) */
export const GMX_ORACLE_PRICE_COUNT = 3n;

export interface GmxGasParams { /** INCREASE_ORDER_GAS_LIMIT or DECREASE_ORDER_GAS_LIMIT */ orderGasLimit: bigint; baseAmount: bigint; perOraclePrice: bigint; multiplierFactor: bigint }
/** `GasUtils.adjustGasLimitForEstimate` of a position order without swap path or callback: the gas the contracts price the execution at */
export const gmxExecutionGas = (p: GmxGasParams): bigint => p.baseAmount + p.perOraclePrice * GMX_ORACLE_PRICE_COUNT + (p.orderGasLimit * p.multiplierFactor) / 10n ** 30n;
/**
 * The execution fee this wallet sends: the contracts require `tx.gasprice × gmxExecutionGas` at creation (else
 * `InsufficientExecutionFee`); the wallet sends that gas at 1.5 × the current base fee plus its own tip, so that a base fee
 * that rises by up to half before inclusion does not make the creation revert. The keeper keeps what its execution cost; the
 * rest comes back to the wallet (`receiver` on execution, `cancellationReceiver` on cancellation — both the wallet).
 */
export const gmxExecutionFee = (executionGas: bigint, baseFeePerGas: bigint, tip: bigint): bigint => executionGas * ((baseFeePerGas * 3n) / 2n + tip);

export interface GmxMarketPin {
  /** GM market token = the market's identifier */
  readonly market: string; readonly name: string;
  /** read adapter instrument id (`gmx:<GMX API symbol>`) */
  readonly instrument: string;
  readonly indexToken: string; readonly indexDecimals: number;
  /** symbol the signer prices the index with (Coinbase + Kraken) */
  readonly priceSymbol: string;
  readonly longToken: string; readonly shortToken: string;
  /** collateral tokens accepted by THIS wallet for the market (a subset of the market's long/short tokens) */
  readonly collateral: readonly { readonly token: string; readonly symbol: string; readonly decimals: number; readonly priceSymbol: string }[];
}
const USDC = { token: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6, priceSymbol: 'USDC' } as const;
/** Markets this wallet trades. Each row was read back from `Reader.getMarket(dataStore, market)` on both RPC endpoints on 2026-11-11; the API reads it again before every order. */
export const GMX_MARKETS: readonly GmxMarketPin[] = [
  { market: '0x47c031236e19d024b42f8AE6780E44A573170703', name: 'BTC/USD [WBTC.b-USDC]', instrument: 'gmx:BTC/USD [BTC-USDC]', indexToken: '0x47904963fc8b2340414262125aF798B9655E58Cd', indexDecimals: 8, priceSymbol: 'BTC',
    longToken: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', shortToken: USDC.token, collateral: [USDC] },
  { market: '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336', name: 'ETH/USD [WETH-USDC]', instrument: 'gmx:ETH/USD [WETH-USDC]', indexToken: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', indexDecimals: 18, priceSymbol: 'ETH',
    longToken: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', shortToken: USDC.token, collateral: [USDC] },
];
const lc = (a: string) => a.toLowerCase();
const same = (a: string, b: string) => lc(a) === lc(b);
export const gmxMarket = (market: string): GmxMarketPin | null => GMX_MARKETS.find((m) => same(m.market, market)) ?? null;
export const gmxMarketByInstrument = (instrument: string): GmxMarketPin | null => GMX_MARKETS.find((m) => m.instrument === instrument) ?? null;

// ---------------------------------------------------------------------------------------------------------------------------
// ABI (from the verified sources; compared in the tests with real transactions and events)

const ADDRESSES = [
  { name: 'receiver', type: 'address' }, { name: 'cancellationReceiver', type: 'address' }, { name: 'callbackContract', type: 'address' }, { name: 'uiFeeReceiver', type: 'address' },
  { name: 'market', type: 'address' }, { name: 'initialCollateralToken', type: 'address' }, { name: 'swapPath', type: 'address[]' },
] as const;
const NUMBERS = [
  { name: 'sizeDeltaUsd', type: 'uint256' }, { name: 'initialCollateralDeltaAmount', type: 'uint256' }, { name: 'triggerPrice', type: 'uint256' }, { name: 'acceptablePrice', type: 'uint256' },
  { name: 'executionFee', type: 'uint256' }, { name: 'callbackGasLimit', type: 'uint256' }, { name: 'minOutputAmount', type: 'uint256' }, { name: 'validFromTime', type: 'uint256' },
] as const;
export const GMX_EXCHANGE_ROUTER_ABI = [
  { type: 'function', name: 'multicall', stateMutability: 'payable', inputs: [{ name: 'data', type: 'bytes[]' }], outputs: [{ name: 'results', type: 'bytes[]' }] },
  { type: 'function', name: 'sendWnt', stateMutability: 'payable', inputs: [{ name: 'receiver', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'sendTokens', stateMutability: 'payable', inputs: [{ name: 'token', type: 'address' }, { name: 'receiver', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'cancelOrder', stateMutability: 'payable', inputs: [{ name: 'key', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'createOrder', stateMutability: 'payable', outputs: [{ type: 'bytes32' }], inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'addresses', type: 'tuple', components: ADDRESSES }, { name: 'numbers', type: 'tuple', components: NUMBERS },
    { name: 'orderType', type: 'uint8' }, { name: 'decreasePositionSwapType', type: 'uint8' }, { name: 'isLong', type: 'bool' }, { name: 'shouldUnwrapNativeToken', type: 'bool' },
    { name: 'autoCancel', type: 'bool' }, { name: 'referralCode', type: 'bytes32' }, { name: 'dataList', type: 'bytes32[]' }] }] },
] as const;

const ORDER_PROPS = { type: 'tuple', components: [
  { name: 'addresses', type: 'tuple', components: [{ name: 'account', type: 'address' }, ...ADDRESSES] },
  { name: 'numbers', type: 'tuple', components: [
    { name: 'orderType', type: 'uint8' }, { name: 'decreasePositionSwapType', type: 'uint8' }, { name: 'sizeDeltaUsd', type: 'uint256' }, { name: 'initialCollateralDeltaAmount', type: 'uint256' },
    { name: 'triggerPrice', type: 'uint256' }, { name: 'acceptablePrice', type: 'uint256' }, { name: 'executionFee', type: 'uint256' }, { name: 'callbackGasLimit', type: 'uint256' },
    { name: 'minOutputAmount', type: 'uint256' }, { name: 'uiFeeFactor', type: 'uint256' }, { name: 'updatedAtTime', type: 'uint256' }, { name: 'validFromTime', type: 'uint256' }, { name: 'srcChainId', type: 'uint256' }] },
  { name: 'flags', type: 'tuple', components: [{ name: 'isLong', type: 'bool' }, { name: 'shouldUnwrapNativeToken', type: 'bool' }, { name: 'isFrozen', type: 'bool' }, { name: 'autoCancel', type: 'bool' }] },
  { name: '_dataList', type: 'bytes32[]' }] } as const;
const POSITION_PROPS = { type: 'tuple', components: [
  { name: 'addresses', type: 'tuple', components: [{ name: 'account', type: 'address' }, { name: 'market', type: 'address' }, { name: 'collateralToken', type: 'address' }] },
  { name: 'numbers', type: 'tuple', components: [
    { name: 'sizeInUsd', type: 'uint256' }, { name: 'sizeInTokens', type: 'uint256' }, { name: 'collateralAmount', type: 'uint256' }, { name: 'pendingImpactAmount', type: 'int256' },
    { name: 'borrowingFactor', type: 'uint256' }, { name: 'fundingFeeAmountPerSize', type: 'uint256' }, { name: 'longTokenClaimableFundingAmountPerSize', type: 'uint256' },
    { name: 'shortTokenClaimableFundingAmountPerSize', type: 'uint256' }, { name: 'increasedAtTime', type: 'uint256' }, { name: 'decreasedAtTime', type: 'uint256' }] },
  { name: 'flags', type: 'tuple', components: [{ name: 'isLong', type: 'bool' }] }] } as const;
const RANGE = [{ name: 'dataStore', type: 'address' }, { name: 'account', type: 'address' }, { name: 'start', type: 'uint256' }, { name: 'end', type: 'uint256' }] as const;
export const GMX_READER_ABI = [
  { type: 'function', name: 'getMarket', stateMutability: 'view', inputs: [{ name: 'dataStore', type: 'address' }, { name: 'key', type: 'address' }],
    outputs: [{ type: 'tuple', components: [{ name: 'marketToken', type: 'address' }, { name: 'indexToken', type: 'address' }, { name: 'longToken', type: 'address' }, { name: 'shortToken', type: 'address' }] }] },
  { type: 'function', name: 'getAccountPositions', stateMutability: 'view', inputs: RANGE, outputs: [{ ...POSITION_PROPS, type: 'tuple[]' }] },
  { type: 'function', name: 'getAccountOrders', stateMutability: 'view', inputs: RANGE, outputs: [{ type: 'tuple[]', components: [{ name: 'orderKey', type: 'bytes32' }, { ...ORDER_PROPS, name: 'order' }] }] },
  { type: 'function', name: 'getOrder', stateMutability: 'view', inputs: [{ name: 'dataStore', type: 'address' }, { name: 'key', type: 'bytes32' }], outputs: [ORDER_PROPS] },
] as const;
export const GMX_ROLE_STORE_ABI = [{ type: 'function', name: 'hasRole', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }, { name: 'roleKey', type: 'bytes32' }], outputs: [{ type: 'bool' }] }] as const;
export const GMX_DATASTORE_ABI = [
  { type: 'function', name: 'getUint', stateMutability: 'view', inputs: [{ name: 'key', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getAddress', stateMutability: 'view', inputs: [{ name: 'key', type: 'bytes32' }], outputs: [{ type: 'address' }] },
] as const;

const kv = (name: string, t: string) => ({ name, type: 'tuple', components: [
  { name: 'items', type: 'tuple[]', components: [{ name: 'key', type: 'string' }, { name: 'value', type: t }] },
  { name: 'arrayItems', type: 'tuple[]', components: [{ name: 'key', type: 'string' }, { name: 'value', type: `${t}[]` }] }] });
const EVENT_DATA = { name: 'eventData', type: 'tuple', components: [kv('addressItems', 'address'), kv('uintItems', 'uint256'), kv('intItems', 'int256'), kv('boolItems', 'bool'), kv('bytes32Items', 'bytes32'), kv('bytesItems', 'bytes'), kv('stringItems', 'string')] };
const EV_HEAD = [{ name: 'msgSender', type: 'address', indexed: false }, { name: 'eventName', type: 'string', indexed: false }, { name: 'eventNameHash', type: 'string', indexed: true }];
/** EventEmitter (event/EventEmitter.sol): every GMX event is one of these three, with a generic key/value payload */
export const GMX_EVENT_EMITTER_ABI = [
  { type: 'event', name: 'EventLog', inputs: [...EV_HEAD, { ...EVENT_DATA, indexed: false }] },
  { type: 'event', name: 'EventLog1', inputs: [...EV_HEAD, { name: 'topic1', type: 'bytes32', indexed: true }, { ...EVENT_DATA, indexed: false }] },
  { type: 'event', name: 'EventLog2', inputs: [...EV_HEAD, { name: 'topic1', type: 'bytes32', indexed: true }, { name: 'topic2', type: 'bytes32', indexed: true }, { ...EVENT_DATA, indexed: false }] },
] as unknown as Abi;

export const GMX_ORDER_TYPE = { MarketSwap: 0, LimitSwap: 1, MarketIncrease: 2, LimitIncrease: 3, MarketDecrease: 4, LimitDecrease: 5, StopLossDecrease: 6, Liquidation: 7, StopIncrease: 8 } as const;
export const GMX_ORDER_TYPE_NAMES = ['MarketSwap', 'LimitSwap', 'MarketIncrease', 'LimitIncrease', 'MarketDecrease', 'LimitDecrease', 'StopLossDecrease', 'Liquidation', 'StopIncrease'] as const;

// ---------------------------------------------------------------------------------------------------------------------------
// Exact conversions

export const GMX_USD_DECIMALS = 30;
const U256_MAX = (1n << 256n) - 1n;
const UINT = /^(0|[1-9]\d{0,77})$/;
/** decimal string → integer × 10^decimals; throws when the value has more decimals than the unit can carry (never rounds) */
export function scaleExact(x: DecStr, decimals: number): bigint {
  const d = D.from(x);
  if (d.m < 0n) throw new Error('negative value');
  if (d.s <= decimals) return d.m * 10n ** BigInt(decimals - d.s);
  const div = 10n ** BigInt(d.s - decimals);
  if (d.m % div !== 0n) throw new Error(`${x} has more than ${decimals} decimals`);
  return d.m / div;
}
/** integer × 10^decimals → canonical decimal string */
export const unscale = (raw: bigint, decimals: number): DecStr => D.str({ m: raw, s: decimals });
export const gmxUsdToRaw = (usd: DecStr): bigint => scaleExact(usd, GMX_USD_DECIMALS);
export const gmxUsdFromRaw = (raw: bigint): DecStr => unscale(raw, GMX_USD_DECIMALS);
/** GMX contract price of an index token: USD per smallest token unit × 10^30 = USD per whole token × 10^(30 − decimals) */
export const gmxPriceDecimals = (indexDecimals: number): number => { if (!Number.isInteger(indexDecimals) || indexDecimals < 0 || indexDecimals > 30) throw new Error('bad token decimals'); return GMX_USD_DECIMALS - indexDecimals; };
export const gmxPriceToRaw = (price: DecStr, indexDecimals: number): bigint => scaleExact(price, gmxPriceDecimals(indexDecimals));
export const gmxPriceFromRaw = (raw: bigint, indexDecimals: number): DecStr => unscale(raw, gmxPriceDecimals(indexDecimals));
/** worst acceptable price from a reference price and a slippage bound: longs open / shorts close ABOVE the reference, the others below; rounded to the unit towards the worse side */
export function gmxAcceptablePrice(reference: DecStr, slippageBps: number, o: { isLong: boolean; increase: boolean; indexDecimals: number }): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new Error('slippage out of range');
  const up = o.isLong === o.increase, ref = D.from(reference), k = gmxPriceDecimals(o.indexDecimals);
  const factor = D.from(String(up ? 10_000 + slippageBps : 10_000 - slippageBps));
  const d = D.div(D.mul(ref, factor), D.from('10000'), k, up ? 'up' : 'down');
  return scaleExact(D.str(d), k);
}

// ---------------------------------------------------------------------------------------------------------------------------
// The intent section and its verification (signer and API apply the same function)

export const GMX_GAS = { orderMin: 400_000n, orderMax: 6_000_000n, cancelMin: 200_000n, cancelMax: 6_000_000n, approveMin: 30_000n, approveMax: 120_000n } as const;
export interface GmxSection {
  venue: 'gmx-v2'; action: 'increase' | 'decrease' | 'cancel'; authorizationId: string; exchangeRouter: string; router: string; orderVault: string;
  market: string; indexToken: string; collateralToken: string; orderType: 'MarketIncrease' | 'MarketDecrease' | 'None'; isLong: boolean;
  sizeDeltaUsd: string; acceptablePrice: string; triggerPrice: string; executionFee: string; approveGas: string; orderKey?: string | undefined;
}
/** the fields of a wallet intent this file reads (structural: the derivatives package does not import the core package) */
export interface GmxIntent {
  network: string; chainRef: string; asset: string; symbol: string; decimals: number; amount: string; from: string; to: string; maxFee: string;
  memo?: string | undefined; swap?: unknown; bridge?: unknown; xswap?: unknown; venueDeposit?: unknown; gmx?: GmxSection | undefined;
  evm?: { nonce: number; gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string } | undefined;
}
export interface GmxCreateOrderParams {
  addresses: { receiver: Hex; cancellationReceiver: Hex; callbackContract: Hex; uiFeeReceiver: Hex; market: Hex; initialCollateralToken: Hex; swapPath: readonly Hex[] };
  numbers: { sizeDeltaUsd: bigint; initialCollateralDeltaAmount: bigint; triggerPrice: bigint; acceptablePrice: bigint; executionFee: bigint; callbackGasLimit: bigint; minOutputAmount: bigint; validFromTime: bigint };
  orderType: number; decreasePositionSwapType: number; isLong: boolean; shouldUnwrapNativeToken: boolean; autoCancel: boolean; referralCode: Hex; dataList: readonly Hex[];
}
export interface GmxPlan {
  action: GmxSection['action']; market: GmxMarketPin | null; collateral: GmxMarketPin['collateral'][number] | null;
  /** collateral base units sent with an increase; 0 otherwise */ amount: bigint;
  sizeDeltaUsd: bigint; acceptablePrice: bigint; executionFee: bigint; isLong: boolean; orderKey: Hex | null;
  gas: bigint; approveGas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; nonce: number;
  /** null for a cancel */ params: GmxCreateOrderParams | null;
}
const uint = (s: string, what: string): bigint => { if (!UINT.test(s)) throw new Error(`malformed ${what}`); const v = BigInt(s); if (v > U256_MAX) throw new Error(`${what} out of range`); return v; };

/**
 * The fixed part of every order this wallet creates — NOT chosen by the API, not even present in the intent:
 *   receiver = cancellationReceiver = the wallet; callbackContract = 0 and callbackGasLimit = 0 (no third-party code runs);
 *   uiFeeReceiver = 0 (no UI fee); swapPath = [] (the collateral is the market's own token, nothing is swapped);
 *   decreasePositionSwapType = NoSwap; referralCode = 0; dataList = []; validFromTime = 0 and triggerPrice = 0 (market orders);
 *   autoCancel = false (it only applies to LimitDecrease / StopLossDecrease);
 *   shouldUnwrapNativeToken = false, always: token outputs arrive as ERC-20 (a WETH profit as WETH);
 *   minOutputAmount = 0: with an empty swap path nothing is swapped, so for an increase the "output" is the collateral itself
 *     (the check compares the collateral with itself) and for a decrease it is collateral ± PnL − fees, whose price risk is
 *     what `acceptablePrice` bounds; a non-zero value would only add a way for a close to be cancelled.
 */
export function gmxCreateOrderParams(own: string, p: { market: string; collateralToken: string; sizeDeltaUsd: bigint; amount: bigint; acceptablePrice: bigint; executionFee: bigint; increase: boolean; isLong: boolean }): GmxCreateOrderParams {
  return {
    addresses: { receiver: own as Hex, cancellationReceiver: own as Hex, callbackContract: ZERO_ADDRESS, uiFeeReceiver: ZERO_ADDRESS, market: p.market as Hex, initialCollateralToken: p.collateralToken as Hex, swapPath: [] },
    numbers: { sizeDeltaUsd: p.sizeDeltaUsd, initialCollateralDeltaAmount: p.increase ? p.amount : 0n, triggerPrice: 0n, acceptablePrice: p.acceptablePrice, executionFee: p.executionFee, callbackGasLimit: 0n, minOutputAmount: 0n, validFromTime: 0n },
    orderType: p.increase ? GMX_ORDER_TYPE.MarketIncrease : GMX_ORDER_TYPE.MarketDecrease, decreasePositionSwapType: 0, isLong: p.isLong, shouldUnwrapNativeToken: false, autoCancel: false,
    referralCode: ZERO_BYTES32 as Hex, dataList: [],
  };
}

/** Check every field of a GMX intent against the pinned tables. `own` is the wallet's own address, from the caller's own knowledge. Throws with the reason. */
export function verifyGmxIntent(i: GmxIntent, own: string): GmxPlan {
  const g = i.gmx, e = i.evm;
  if (!g || !e) throw new Error('not a GMX intent');
  if (i.swap || i.bridge || i.xswap || i.venueDeposit || i.memo !== undefined) throw new Error('a GMX order is neither a swap, a bridge, a deposit nor a transfer with a memo');
  if (g.venue !== 'gmx-v2') throw new Error('unknown venue');
  if (i.network !== GMX_PINS.network || i.chainRef !== String(GMX_PINS.chainId)) throw new Error('GMX orders are made on Arbitrum One only');
  if (!/^0x[0-9a-fA-F]{40}$/.test(own) || i.from !== own) throw new Error('a GMX order is created from the wallet\'s own address only');
  if (g.exchangeRouter !== GMX_PINS.exchangeRouter.address || i.to !== GMX_PINS.exchangeRouter.address) throw new Error('the destination is not the pinned GMX ExchangeRouter');
  if (g.router !== GMX_PINS.router.address) throw new Error('the token spender is not the pinned GMX Router');
  if (g.orderVault !== GMX_PINS.orderVault.address) throw new Error('the vault is not the pinned GMX OrderVault');
  const amount = uint(i.amount, 'amount'), size = uint(g.sizeDeltaUsd, 'size'), price = uint(g.acceptablePrice, 'acceptable price'), fee = uint(g.executionFee, 'execution fee'), trigger = uint(g.triggerPrice, 'trigger price');
  const gas = uint(e.gasLimit, 'gas limit'), approveGas = uint(g.approveGas, 'approval gas'), maxFeePerGas = uint(e.maxFeePerGas, 'max fee per gas'), tip = uint(e.maxPriorityFeePerGas, 'priority fee');
  if (!Number.isInteger(e.nonce) || e.nonce < 0) throw new Error('bad nonce');
  if (tip > maxFeePerGas) throw new Error('priority fee above max fee');
  if (trigger !== 0n) throw new Error('market orders carry no trigger price');
  // what may leave the wallet in the native coin: gas of both transactions and the execution fee
  if ((gas + approveGas) * maxFeePerGas + fee > uint(i.maxFee, 'fee ceiling')) throw new Error('gas and execution fee exceed the approved maximum');
  const base = { amount, sizeDeltaUsd: size, acceptablePrice: price, executionFee: fee, isLong: g.isLong, gas, approveGas, maxFeePerGas, maxPriorityFeePerGas: tip, nonce: e.nonce };

  if (g.action === 'cancel') {
    if (g.orderType !== 'None' || !g.orderKey || !/^0x[0-9a-f]{64}$/.test(g.orderKey) || g.orderKey === ZERO_BYTES32) throw new Error('a cancellation names the order key and nothing else');
    if (g.market !== ZERO_ADDRESS || g.indexToken !== ZERO_ADDRESS || g.collateralToken !== ZERO_ADDRESS || g.isLong || size !== 0n || price !== 0n || fee !== 0n || approveGas !== 0n) throw new Error('a cancellation carries no order field');
    if (i.asset !== 'native' || i.symbol !== 'ETH' || i.decimals !== 18 || amount !== 0n) throw new Error('a cancellation moves no asset');
    if (gas < GMX_GAS.cancelMin || gas > GMX_GAS.cancelMax) throw new Error('cancellation gas limit out of range');
    return { ...base, action: 'cancel', market: null, collateral: null, orderKey: g.orderKey as Hex, params: null };
  }
  if (g.orderKey !== undefined) throw new Error('only a cancellation names an order key');
  const m = gmxMarket(g.market);
  if (!m || g.market !== m.market) throw new Error('this market is not in the wallet\'s pinned GMX market table');
  if (g.indexToken !== m.indexToken) throw new Error('the index token is not the one of the pinned market');
  const c = m.collateral.find((x) => x.token === g.collateralToken);
  if (!c) throw new Error('this collateral token is not accepted for the market');
  if (i.asset !== c.token || i.symbol !== c.symbol || i.decimals !== c.decimals) throw new Error('the intent asset is not the collateral token');
  if (size === 0n) throw new Error('the size must be positive');
  if (price === 0n) throw new Error('the acceptable price must be positive');
  if (fee === 0n) throw new Error('the execution fee must be positive');
  if (gas < GMX_GAS.orderMin || gas > GMX_GAS.orderMax) throw new Error('order gas limit out of range');
  const increase = g.action === 'increase';
  if (increase) {
    if (g.orderType !== 'MarketIncrease') throw new Error('an increase is a MarketIncrease order');
    if (amount === 0n) throw new Error('an increase sends collateral');
    if (approveGas !== 0n && (approveGas < GMX_GAS.approveMin || approveGas > GMX_GAS.approveMax)) throw new Error('approval gas out of range');
  } else {
    if (g.orderType !== 'MarketDecrease') throw new Error('a decrease is a MarketDecrease order');
    if (amount !== 0n) throw new Error('a decrease sends no collateral');
    if (approveGas !== 0n) throw new Error('a decrease needs no token approval');
  }
  const params = gmxCreateOrderParams(own, { market: m.market, collateralToken: c.token, sizeDeltaUsd: size, amount, acceptablePrice: price, executionFee: fee, increase, isLong: g.isLong });
  return { ...base, action: g.action, market: m, collateral: c, orderKey: null, params };
}

/** calldata of the one ExchangeRouter call of a plan */
export function gmxCalldata(plan: GmxPlan): Hex {
  const enc = (functionName: 'sendWnt' | 'sendTokens' | 'createOrder' | 'cancelOrder' | 'multicall', args: unknown[]) => encodeFunctionData({ abi: GMX_EXCHANGE_ROUTER_ABI, functionName, args } as never);
  if (plan.action === 'cancel') return enc('cancelOrder', [plan.orderKey]);
  const calls: Hex[] = [enc('sendWnt', [GMX_PINS.orderVault.address, plan.executionFee])];
  if (plan.action === 'increase') calls.push(enc('sendTokens', [plan.collateral!.token, GMX_PINS.orderVault.address, plan.amount]));
  calls.push(enc('createOrder', [plan.params]));
  return enc('multicall', [calls]);
}

export interface GmxDecodedCall { fn: string; args: readonly unknown[] }
/** Decode an ExchangeRouter call (a multicall is expanded). Refuses bytes that do not re-encode to themselves (trailing data, non-canonical encoding). */
export function decodeGmxCalldata(data: string): { fn: string; calls: GmxDecodedCall[] } {
  const one = (d: Hex): GmxDecodedCall => {
    const x = decodeFunctionData({ abi: GMX_EXCHANGE_ROUTER_ABI, data: d });
    if (lc(encodeFunctionData({ abi: GMX_EXCHANGE_ROUTER_ABI, functionName: x.functionName, args: x.args } as never)) !== lc(d)) throw new Error('calldata is not canonical');
    return { fn: x.functionName, args: (x.args ?? []) as readonly unknown[] };
  };
  const top = one(data as Hex);
  if (top.fn !== 'multicall') return { fn: top.fn, calls: [top] };
  return { fn: 'multicall', calls: (top.args[0] as Hex[]).map(one) };
}

/**
 * The transactions the signer signs for a GMX intent: an exact-amount approval of the pinned Router when asked, then the one
 * ExchangeRouter call. Built from the intent alone, then READ BACK: the bytes are decoded again and every value-moving field
 * is compared with the plan, so that an encoding mistake here cannot produce a signature.
 */
export function buildGmxTxs(i: GmxIntent, own: string): { plan: GmxPlan; approve: TransactionSerializableEIP1559 | null; main: TransactionSerializableEIP1559 } {
  const plan = verifyGmxIntent(i, own), data = gmxCalldata(plan), back = decodeGmxCalldata(data);
  const bad = (): never => { throw new Error('the GMX transaction does not read back as expected'); };
  const vault = GMX_PINS.orderVault.address;
  if (plan.action === 'cancel') { if (back.fn !== 'cancelOrder' || back.calls.length !== 1 || back.calls[0]!.args[0] !== plan.orderKey) bad(); }
  else {
    const names = back.calls.map((c) => c.fn).join(',');
    if (back.fn !== 'multicall' || names !== (plan.action === 'increase' ? 'sendWnt,sendTokens,createOrder' : 'sendWnt,createOrder')) bad();
    const w = back.calls[0]!.args; if (w[0] !== vault || w[1] !== plan.executionFee) bad();
    if (plan.action === 'increase') { const t = back.calls[1]!.args; if (t[0] !== plan.collateral!.token || t[1] !== vault || t[2] !== plan.amount) bad(); }
    const p = back.calls[back.calls.length - 1]!.args[0] as GmxCreateOrderParams, a = p.addresses, n = p.numbers;
    if (!same(a.receiver, own) || !same(a.cancellationReceiver, own) || a.callbackContract !== ZERO_ADDRESS || a.uiFeeReceiver !== ZERO_ADDRESS || a.market !== plan.market!.market || a.initialCollateralToken !== plan.collateral!.token || a.swapPath.length !== 0
      || n.sizeDeltaUsd !== plan.sizeDeltaUsd || n.initialCollateralDeltaAmount !== plan.amount || n.triggerPrice !== 0n || n.acceptablePrice !== plan.acceptablePrice || n.executionFee !== plan.executionFee || n.callbackGasLimit !== 0n
      || n.minOutputAmount !== 0n || n.validFromTime !== 0n || p.orderType !== (plan.action === 'increase' ? 2 : 4) || p.decreasePositionSwapType !== 0 || p.isLong !== plan.isLong || p.shouldUnwrapNativeToken !== false || p.autoCancel !== false
      || p.referralCode !== ZERO_BYTES32 || p.dataList.length !== 0) bad();
  }
  const common = { type: 'eip1559' as const, chainId: GMX_PINS.chainId, maxFeePerGas: plan.maxFeePerGas, maxPriorityFeePerGas: plan.maxPriorityFeePerGas };
  const approve = plan.approveGas === 0n ? null : { ...common, nonce: plan.nonce, gas: plan.approveGas, to: plan.collateral!.token as Hex, value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [GMX_PINS.router.address as Hex, plan.amount] }) }; // exact amount, never unlimited; the spender is the Router
  const main = { ...common, nonce: plan.nonce + (approve ? 1 : 0), gas: plan.gas, to: GMX_PINS.exchangeRouter.address as Hex, value: plan.action === 'cancel' ? 0n : plan.executionFee, data };
  return { plan, approve, main };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Events

export interface GmxEvent { eventName: string; msgSender: string; topic1: string | null; topic2: string | null; fields: Record<string, unknown> }
/** Decode one log of the pinned EventEmitter into its name and a flat key → value map. Returns null for a log that is not one of its three events. */
export function decodeGmxEvent(log: { address: string; topics: readonly string[]; data: string }): GmxEvent | null {
  if (!same(log.address, GMX_PINS.eventEmitter.address)) return null;
  let ev: { eventName: string; args: Record<string, unknown> };
  try { ev = decodeEventLog({ abi: GMX_EVENT_EMITTER_ABI, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] }) as never; } catch { return null; }
  const d = ev.args.eventData as Record<string, { items: { key: string; value: unknown }[]; arrayItems: { key: string; value: unknown }[] }>;
  const fields: Record<string, unknown> = {};
  for (const group of Object.values(d)) { for (const it of group.items) fields[it.key] = it.value; for (const it of group.arrayItems) fields[it.key] = it.value; }
  return { eventName: String(ev.args.eventName), msgSender: String(ev.args.msgSender), topic1: (ev.args.topic1 as string | undefined) ?? null, topic2: (ev.args.topic2 as string | undefined) ?? null, fields };
}
/** the order key of an order event (`OrderCreated`, `OrderExecuted`, `OrderCancelled`, `OrderFrozen`, `OrderUpdated`) */
export const gmxEventKey = (e: GmxEvent): string | null => (typeof e.fields.key === 'string' ? lc(e.fields.key) : e.topic1 ? lc(e.topic1) : null);

/** Compare an `OrderCreated` event with the plan that was approved, field by field. Returns the differences (empty = identical). */
export function gmxOrderCreatedDiff(e: GmxEvent, plan: GmxPlan, own: string): string[] {
  const f = e.fields, out: string[] = [], p = plan.params;
  if (e.eventName !== 'OrderCreated' || !p) return ['not an OrderCreated event of a create plan'];
  const eq = (name: string, got: unknown, want: unknown) => { const g = typeof got === 'string' ? lc(got) : got, w = typeof want === 'string' ? lc(want) : want; if (g !== w) out.push(`${name}: ${String(got)} ≠ ${String(want)}`); };
  eq('account', f.account, own); eq('receiver', f.receiver, own); eq('cancellationReceiver', f.cancellationReceiver, own); eq('callbackContract', f.callbackContract, ZERO_ADDRESS); eq('uiFeeReceiver', f.uiFeeReceiver, ZERO_ADDRESS);
  eq('market', f.market, p.addresses.market); eq('initialCollateralToken', f.initialCollateralToken, p.addresses.initialCollateralToken);
  if (!Array.isArray(f.swapPath) || f.swapPath.length !== 0) out.push('swapPath is not empty');
  eq('orderType', f.orderType, BigInt(p.orderType)); eq('decreasePositionSwapType', f.decreasePositionSwapType, 0n); eq('sizeDeltaUsd', f.sizeDeltaUsd, p.numbers.sizeDeltaUsd);
  eq('initialCollateralDeltaAmount', f.initialCollateralDeltaAmount, p.numbers.initialCollateralDeltaAmount); eq('triggerPrice', f.triggerPrice, 0n); eq('acceptablePrice', f.acceptablePrice, p.numbers.acceptablePrice);
  eq('executionFee', f.executionFee, p.numbers.executionFee); eq('callbackGasLimit', f.callbackGasLimit, 0n); eq('minOutputAmount', f.minOutputAmount, 0n); eq('uiFeeFactor', f.uiFeeFactor, 0n);
  eq('validFromTime', f.validFromTime, 0n); eq('srcChainId', f.srcChainId, 0n); eq('isLong', f.isLong, p.isLong); eq('shouldUnwrapNativeToken', f.shouldUnwrapNativeToken, false); eq('autoCancel', f.autoCancel, false);
  if (!Array.isArray(f.dataList) || f.dataList.length !== 0) out.push('dataList is not empty');
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Venue policy: the authorization the owner approves once with a passkey, stored and enforced by the signer

export const GMX_POLICY_BOUNDS = { maxLeverage: 20, maxOrdersPerDay: 100, minPriceBandBps: 10, maxPriceBandBps: 1000, maxMarkets: 8, maxDays: 90,
  /** hard ceiling of the execution fee of one order whatever the authorization says: 0.002 ETH */ maxExecutionFeeWei: 2_000_000_000_000_000n,
  /** decreases and cancellations signed per UTC day (they reduce risk; each still costs gas and an execution fee) */ reduceActionsPerDay: 100 } as const;
const enc = new TextEncoder();
const ADDRESS_LC = /^0x[0-9a-f]{40}$/;
const PosUsd = DecStrSchema.refine((x) => !x.startsWith('-') && /[1-9]/.test(x) && (x.split('.')[1]?.length ?? 0) <= GMX_USD_DECIMALS, 'a positive USD amount');

export const GmxPolicySchema = z.strictObject({
  /** GM market addresses (EIP-55), each in the pinned market table */
  allowedMarkets: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).min(1).max(GMX_POLICY_BOUNDS.maxMarkets),
  /** an increase is refused when sizeDeltaUsd > maxLeverage × the collateral sent, valued at the signer's OWN price */
  maxLeverage: z.number().int().min(1).max(GMX_POLICY_BOUNDS.maxLeverage),
  /** largest sizeDeltaUsd of one increase, in USD */
  maxOrderSizeUsd: PosUsd,
  /** increases signed per UTC day */
  maxOrdersPerDay: z.number().int().min(1).max(GMX_POLICY_BOUNDS.maxOrdersPerDay),
  /** the acceptable price must be within this band of the signer's OWN price of the index asset */
  maxPriceDeviationBps: z.number().int().min(GMX_POLICY_BOUNDS.minPriceBandBps).max(GMX_POLICY_BOUNDS.maxPriceBandBps),
  /** largest execution fee of one order, wei */
  maxExecutionFeeWei: z.string().regex(UINT),
});
export type GmxPolicy = z.infer<typeof GmxPolicySchema>;

export const GmxAuthorizationSchema = z.strictObject({
  v: z.literal(1), authorizationId: z.uuid(), keyId: z.string().min(8).max(80),
  venue: z.literal('gmx'), network: z.literal('arbitrum'),
  /** the account IS the wallet's own address (lower case): GMX has no venue account */
  account: z.string().regex(ADDRESS_LC),
  /** one passkey per order; nothing else exists for GMX */
  mode: z.literal('MANUAL_LIVE'),
  /** the reviewed contract set (GMX_PINS.id) and its entry point */
  contracts: z.string().min(4).max(60), exchangeRouter: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  policy: GmxPolicySchema,
  createdAt: z.number().int().positive(), expiresAt: z.number().int().positive(),
  /** SHA-256 of the jurisdiction acknowledgement text that was shown to the owner */
  ackSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type GmxAuthorization = z.infer<typeof GmxAuthorizationSchema>;

export function gmxAuthorizationBytes(a: GmxAuthorization): Uint8Array {
  const x = GmxAuthorizationSchema.parse(a), p = x.policy;
  const fields: [string, string][] = [
    ['v', '1'], ['authorizationId', x.authorizationId], ['keyId', x.keyId], ['venue', x.venue], ['network', x.network], ['account', x.account], ['mode', x.mode], ['contracts', x.contracts], ['exchangeRouter', x.exchangeRouter],
    ['policy.allowedMarkets', [...p.allowedMarkets].sort().join(',')], ['policy.maxLeverage', String(p.maxLeverage)], ['policy.maxOrderSizeUsd', D.str(D.from(p.maxOrderSizeUsd))], ['policy.maxOrdersPerDay', String(p.maxOrdersPerDay)],
    ['policy.maxPriceDeviationBps', String(p.maxPriceDeviationBps)], ['policy.maxExecutionFeeWei', p.maxExecutionFeeWei],
    ['createdAt', String(x.createdAt)], ['expiresAt', String(x.expiresAt)], ['ackSha256', x.ackSha256],
  ];
  const parts: Uint8Array[] = [enc.encode('SPW-GMX-AUTH-v1'), new Uint8Array([0])];
  for (const [k, v] of fields) { const kb = enc.encode(k), vb = enc.encode(v), head = new Uint8Array(6); new DataView(head.buffer).setUint16(0, kb.length); new DataView(head.buffer).setUint32(2, vb.length); parts.push(head, kb, vb); }
  const out = new Uint8Array(parts.reduce((n, q) => n + q.length, 0));
  let at = 0; for (const q of parts) { out.set(q, at); at += q.length; }
  return out;
}
export const gmxAuthorizationHash = (a: GmxAuthorization): Uint8Array => sha256(gmxAuthorizationBytes(a));
export const gmxAuthorizationHashHex = (a: GmxAuthorization): string => hex(gmxAuthorizationHash(a));

/** Structural validity at approval time. The signer additionally checks the key id, that the account is ITS OWN address, the acknowledgement hash and the passkey. */
export function validateGmxAuthorization(a: GmxAuthorization, nowSec: number): void {
  if (a.contracts !== GMX_PINS.id || a.exchangeRouter !== GMX_PINS.exchangeRouter.address) throw new Error('the authorization names another GMX contract set than the one this build reviewed');
  if (new Set(a.policy.allowedMarkets.map(lc)).size !== a.policy.allowedMarkets.length) throw new Error('duplicate market');
  for (const m of a.policy.allowedMarkets) { const pin = gmxMarket(m); if (!pin || pin.market !== m) throw new Error(`${m} is not in the pinned GMX market table`); }
  if (BigInt(a.policy.maxExecutionFeeWei) === 0n || BigInt(a.policy.maxExecutionFeeWei) > GMX_POLICY_BOUNDS.maxExecutionFeeWei) throw new Error('execution fee ceiling out of range');
  gmxUsdToRaw(a.policy.maxOrderSizeUsd);
  if (a.expiresAt <= nowSec) throw new Error('authorization already expired');
  if (a.createdAt > nowSec + 120 || a.createdAt < nowSec - 600) throw new Error('authorization creation time is not current');
  if (a.expiresAt - a.createdAt > GMX_POLICY_BOUNDS.maxDays * 86400) throw new Error(`an authorization lasts at most ${GMX_POLICY_BOUNDS.maxDays} days`);
}

/**
 * The venue policy applied to one plan, with the signer's own prices (USD per whole unit, as numbers from its two exchanges).
 * Returns null when the plan fits, otherwise the reason. A cancellation is bound by nothing here: it can only bring an order's
 * collateral back to the wallet.
 */
export function gmxPolicyVerdict(policy: GmxPolicy, plan: GmxPlan, px: { index: number; collateral: number } | null): string | null {
  if (plan.action === 'cancel') return null;
  const m = plan.market!, c = plan.collateral!;
  if (!policy.allowedMarkets.some((x) => x === m.market)) return `${m.name} is not allowed by the authorization`;
  if (plan.executionFee > BigInt(policy.maxExecutionFeeWei) || plan.executionFee > GMX_POLICY_BOUNDS.maxExecutionFeeWei) return `execution fee ${plan.executionFee} wei is above the authorized ${policy.maxExecutionFeeWei}`;
  if (!px || !(px.index > 0) || !(px.collateral > 0) || !Number.isFinite(px.index) || !Number.isFinite(px.collateral)) return 'no price';
  // the acceptable price against the signer's own price of the index asset, both in the contract's price unit
  const k = gmxPriceDecimals(m.indexDecimals), mid = scaleExact(px.index.toFixed(Math.min(8, k)), k);
  const gap = plan.acceptablePrice > mid ? plan.acceptablePrice - mid : mid - plan.acceptablePrice;
  if (gap * 10_000n > BigInt(policy.maxPriceDeviationBps) * mid) return `acceptable price ${gmxPriceFromRaw(plan.acceptablePrice, m.indexDecimals)} is more than ${policy.maxPriceDeviationBps} bps away from the signer's own ${m.priceSymbol} price ${gmxPriceFromRaw(mid, m.indexDecimals)}`;
  if (plan.action === 'increase') {
    if (plan.sizeDeltaUsd > gmxUsdToRaw(policy.maxOrderSizeUsd)) return `order size ${gmxUsdFromRaw(plan.sizeDeltaUsd)} USD is above the authorized ${policy.maxOrderSizeUsd}`;
    // leverage = size ÷ value of the collateral sent, at the signer's own price of the collateral token (8 decimals)
    const collPx = scaleExact(px.collateral.toFixed(8), 8);
    const collateralUsd = plan.amount * collPx * 10n ** BigInt(GMX_USD_DECIMALS - 8 - c.decimals);
    if (plan.sizeDeltaUsd > BigInt(policy.maxLeverage) * collateralUsd) return `leverage ${D.str(D.div(D.from(plan.sizeDeltaUsd), D.from(collateralUsd === 0n ? 1n : collateralUsd), 2, 'up'))}× is above the authorized ${policy.maxLeverage}×`;
  }
  return null;
}
