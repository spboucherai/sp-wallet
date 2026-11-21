/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/derivatives/gmx-chain.ts
 * Module           : derivatives
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

// GMX v2 trading (v8) — the chain side of the execution engine: everything it READS from Arbitrum One (pins, roles, markets,
// balances, the wallet's positions and orders through GMX's Reader, receipts, order events) and the two things it SENDS
// (already signed transactions). No key exists here. Tests replace this port with a scripted fake (GmxChain).
//
// Pins fail closed: the bytecode of every pinned contract must hash to the pinned value on EVERY registry RPC endpoint, the
// pinned ExchangeRouter and OrderHandler must still hold their roles in RoleStore, the ExchangeRouter's immutables must be the
// pinned Router / OrderHandler / DataStore, and each pinned market must read back from Reader. Anything else =
// "GMX a publié de nouveaux contrats : nouvelle revue nécessaire" (docs/v4/venues/gmx.md Part C).
import { createHash } from 'node:crypto';
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, erc20Abi, hexToBigInt, hexToNumber, keccak256, numberToHex, pad, parseAbi, toEventSelector, type Hex } from 'viem';
import { getNetwork } from '@spw/core';
import {
  decodeGmxEvent, GMX_DATASTORE_ABI, GMX_DATASTORE_KEYS, GMX_MARKETS, GMX_PINNED_CONTRACTS, GMX_PINS, GMX_READER_ABI, GMX_REQUEST_EXPIRATION_SEC, GMX_REQUIRED_ROLES, GMX_ROLE_KEYS, GMX_ROLE_STORE_ABI, gmxExecutionGas, gmxKey,
  type GmxEvent,
} from '@spw/derivatives/live';
import { rpcAny, rpcOne, rpcQuorum } from '../chains/rpc.ts';
import { UserError } from '../config.ts';

export interface GmxLog { address: string; topics: string[]; data: string }
export interface GmxReceipt { ok: boolean; blockNumber: number; gasUsed: bigint; effectiveGasPrice: bigint; logs: GmxLog[] }
export interface GmxChainPosition { key: string; market: string; collateralToken: string; isLong: boolean; sizeInUsd: bigint; sizeInTokens: bigint; collateralAmount: bigint; increasedAtTime: number }
export interface GmxChainOrder {
  key: string; account: string; receiver: string; cancellationReceiver: string; callbackContract: string; uiFeeReceiver: string; market: string; initialCollateralToken: string; swapPathLength: number;
  orderType: number; sizeDeltaUsd: bigint; initialCollateralDeltaAmount: bigint; acceptablePrice: bigint; executionFee: bigint; updatedAtTime: number; isLong: boolean; isFrozen: boolean;
}
export interface GmxPinCheck { ok: boolean; problems: string[]; checkedAt: number }
export interface GmxCall { from: string; to: string; data: string; value: bigint }
export interface GmxChain {
  /** never throws for a mismatch (that is `ok: false` with the problems); throws UserError `chain_unreadable` when the chain cannot be read */
  checkPins(me: string | null): Promise<GmxPinCheck>;
  balances(me: string): Promise<{ usdc: bigint; eth: bigint; weth: bigint; usdcAllowance: bigint }>;
  /** base fee of the latest block, the tip this wallet uses, and the wallet's pending nonce — every RPC endpoint must agree on the nonce */
  txParams(me: string): Promise<{ baseFee: bigint; tip: bigint; nonce: number }>;
  /** gas the contracts price an execution at (GasUtils.adjustGasLimitForEstimate), per order type */
  executionGas(): Promise<{ increase: bigint; decrease: bigint }>;
  positions(me: string): Promise<GmxChainPosition[]>;
  orders(me: string): Promise<GmxChainOrder[]>;
  /** null = no such order on-chain (executed, cancelled, or never created) */
  order(key: string): Promise<GmxChainOrder | null>;
  /** null when the call cannot be estimated (it would revert, or the node is unreachable) */
  estimateGas(c: GmxCall): Promise<bigint | null>;
  /** null = the call succeeds against the current state; otherwise why not. `unreachable` = no answer, try again */
  simulate(c: GmxCall): Promise<null | { unreachable: boolean; error: string }>;
  broadcast(raw: string): Promise<void>;
  receipt(txid: string): Promise<GmxReceipt | null>;
  /** events of the pinned EventEmitter whose first topic key is `key` (OrderExecuted, OrderCancelled, OrderFrozen…), from `fromBlock` */
  orderEvents(key: string, fromBlock: number): Promise<{ event: GmxEvent; txid: string; blockNumber: number }[]>;
}

const sha = (h: string) => createHash('sha256').update(Buffer.from(h.slice(2), 'hex')).digest('hex');
const eq = (a: unknown, b: string) => String(a).toLowerCase() === b.toLowerCase();
const P = GMX_PINS;
const routerViews = parseAbi(['function router() view returns (address)', 'function orderHandler() view returns (address)', 'function dataStore() view returns (address)', 'function roleStore() view returns (address)']);
const EVENT_LOG_2 = toEventSelector('EventLog2(address,string,string,bytes32,bytes32,(((string,address)[],(string,address[])[]),((string,uint256)[],(string,uint256[])[]),((string,int256)[],(string,int256[])[]),((string,bool)[],(string,bool[])[]),((string,bytes32)[],(string,bytes32[])[]),((string,bytes)[],(string,bytes[])[]),((string,string)[],(string,string[])[])))');
/** Position.getPositionKey: keccak256(abi.encode(account, market, collateralToken, isLong)) */
export const gmxPositionKey = (account: string, market: string, collateralToken: string, isLong: boolean): string =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bool' }], [account as Hex, market as Hex, collateralToken as Hex, isLong]));
const PIN_TTL_MS = 60_000, GAS_TTL_MS = 600_000, LOG_SPAN = 40_000;

export function realGmxChain(now: () => number = Date.now): GmxChain {
  const n = getNetwork(P.network), urls = n.rpc;
  const unreadable = (e: unknown): never => { if (e instanceof UserError && !/^rpc_/.test(e.code)) throw e; throw new UserError('chain_unreadable', `Arbitrum could not be read (${(e as Error).message.slice(0, 120)}); nothing was prepared`, 503); };
  const callAny = (to: string, data: Hex) => rpcAny<Hex>(urls, 'eth_call', [{ to, data }, 'latest']);
  const callAll = (to: string, data: Hex) => rpcQuorum<Hex>(urls, 'eth_call', [{ to, data }, 'latest'], (a, b) => a.toLowerCase() === b.toLowerCase());
  const reader = async (fn: 'getMarket' | 'getAccountPositions' | 'getAccountOrders' | 'getOrder', args: unknown[], all = false): Promise<any> =>
    decodeFunctionResult({ abi: GMX_READER_ABI, functionName: fn, data: await (all ? callAll : callAny)(P.reader.address, encodeFunctionData({ abi: GMX_READER_ABI, functionName: fn, args } as never)) } as never);
  const uint = async (key: string) => hexToBigInt(await callAny(P.dataStore.address, encodeFunctionData({ abi: GMX_DATASTORE_ABI, functionName: 'getUint', args: [key as Hex] })));
  const orderOf = (key: string, o: any): GmxChainOrder => ({ key: key.toLowerCase(), account: o.addresses.account, receiver: o.addresses.receiver, cancellationReceiver: o.addresses.cancellationReceiver, callbackContract: o.addresses.callbackContract,
    uiFeeReceiver: o.addresses.uiFeeReceiver, market: o.addresses.market, initialCollateralToken: o.addresses.initialCollateralToken, swapPathLength: o.addresses.swapPath.length, orderType: Number(o.numbers.orderType), sizeDeltaUsd: o.numbers.sizeDeltaUsd,
    initialCollateralDeltaAmount: o.numbers.initialCollateralDeltaAmount, acceptablePrice: o.numbers.acceptablePrice, executionFee: o.numbers.executionFee, updatedAtTime: Number(o.numbers.updatedAtTime), isLong: o.flags.isLong, isFrozen: o.flags.isFrozen });
  let pins: { at: number; me: string | null; v: GmxPinCheck } | null = null, gas: { at: number; v: { increase: bigint; decrease: bigint } } | null = null;

  return {
    async checkPins(me) {
      if (pins && pins.v.ok && pins.me === me && now() - pins.at < PIN_TTL_MS) return pins.v;
      const problems: string[] = [];
      try {
        // 1. bytecode, on every endpoint
        await Promise.all(GMX_PINNED_CONTRACTS.map(async (c) => {
          const code = await rpcQuorum<string>(urls, 'eth_getCode', [P[c].address, 'latest']);
          if (sha(code) !== P[c].codeSha256) problems.push(`the bytecode of ${c} (${P[c].address}) is not the reviewed one`);
        }));
        // 2. roles: a router GMX has replaced loses them
        await Promise.all(GMX_REQUIRED_ROLES.map(async (r) => {
          const has = decodeFunctionResult({ abi: GMX_ROLE_STORE_ABI, functionName: 'hasRole', data: await callAll(P.roleStore.address, encodeFunctionData({ abi: GMX_ROLE_STORE_ABI, functionName: 'hasRole', args: [P[r.holder].address as Hex, GMX_ROLE_KEYS[r.role]] })) });
          if (has !== true) problems.push(`${r.holder} no longer holds the ${r.role} role in GMX's RoleStore`);
        }));
        // 3. wiring: the router's immutables, the fee token, the cancellation delay, the markets
        for (const [fn, want] of [['router', P.router.address], ['orderHandler', P.orderHandler.address], ['dataStore', P.dataStore.address], ['roleStore', P.roleStore.address]] as const) {
          const got = decodeFunctionResult({ abi: routerViews, functionName: fn, data: await callAll(P.exchangeRouter.address, encodeFunctionData({ abi: routerViews, functionName: fn })) });
          if (!eq(got, want)) problems.push(`ExchangeRouter.${fn}() is not the pinned address`);
        }
        const wnt = decodeFunctionResult({ abi: GMX_DATASTORE_ABI, functionName: 'getAddress', data: await callAll(P.dataStore.address, encodeFunctionData({ abi: GMX_DATASTORE_ABI, functionName: 'getAddress', args: [gmxKey('WNT')] })) });
        if (!eq(wnt, P.wnt)) problems.push('the wrapped native token of the DataStore is not the pinned one');
        if ((await uint(GMX_DATASTORE_KEYS.REQUEST_EXPIRATION_TIME)) !== BigInt(GMX_REQUEST_EXPIRATION_SEC)) problems.push('the request expiration time changed');
        for (const m of GMX_MARKETS) {
          const x = await reader('getMarket', [P.dataStore.address, m.market], true);
          if (!eq(x.marketToken, m.market) || !eq(x.indexToken, m.indexToken) || !eq(x.longToken, m.longToken) || !eq(x.shortToken, m.shortToken)) problems.push(`the market ${m.name} no longer reads back as pinned`);
        }
        // 4. an EIP-7702 delegation on the wallet address would run someone's code on every coin received
        if (me && (await rpcQuorum<string>(urls, 'eth_getCode', [me, 'latest'])) !== '0x') problems.push('the wallet address carries code (delegation)');
      } catch (e) { unreadable(e); }
      const v = { ok: problems.length === 0, problems, checkedAt: now() };
      pins = { at: now(), me, v };
      return v;
    },
    async balances(me) {
      try {
        const erc = async (token: string, fn: 'balanceOf' | 'allowance', args: string[]) => hexToBigInt(await callAny(token, encodeFunctionData({ abi: erc20Abi, functionName: fn, args } as never)));
        const usdc = GMX_MARKETS[0]!.collateral[0]!.token;
        const [u, e, w, a] = await Promise.all([erc(usdc, 'balanceOf', [me]), rpcAny<Hex>(urls, 'eth_getBalance', [me, 'latest']), erc(P.wnt, 'balanceOf', [me]), erc(usdc, 'allowance', [me, P.router.address])]);
        return { usdc: u, eth: hexToBigInt(e), weth: w, usdcAllowance: a };
      } catch (e) { return unreadable(e); }
    },
    async txParams(me) {
      try {
        const [block, nonce] = await Promise.all([rpcAny<{ baseFeePerGas: Hex }>(urls, 'eth_getBlockByNumber', ['latest', false]), rpcQuorum<Hex>(urls, 'eth_getTransactionCount', [me, 'pending'])]);
        return { baseFee: hexToBigInt(block.baseFeePerGas), tip: 1_000_000n, nonce: hexToNumber(nonce) };
      } catch (e) { return unreadable(e); }
    },
    async executionGas() {
      if (gas && now() - gas.at < GAS_TTL_MS) return gas.v;
      try {
        const K = GMX_DATASTORE_KEYS;
        const [inc, dec, baseAmount, perOraclePrice, multiplierFactor] = await Promise.all([uint(K.INCREASE_ORDER_GAS_LIMIT), uint(K.DECREASE_ORDER_GAS_LIMIT), uint(K.ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1), uint(K.ESTIMATED_GAS_FEE_PER_ORACLE_PRICE), uint(K.ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR)]);
        // a wrong key reads zero: never turn that into a fee of zero
        if (inc === 0n || dec === 0n || multiplierFactor === 0n) throw new Error('GMX DataStore answered zero for a gas parameter');
        const v = { increase: gmxExecutionGas({ orderGasLimit: inc, baseAmount, perOraclePrice, multiplierFactor }), decrease: gmxExecutionGas({ orderGasLimit: dec, baseAmount, perOraclePrice, multiplierFactor }) };
        gas = { at: now(), v };
        return v;
      } catch (e) { return unreadable(e); }
    },
    async positions(me) {
      try {
        const ps = await reader('getAccountPositions', [P.dataStore.address, me, 0n, 100n]) as any[];
        return ps.map((p) => ({ key: gmxPositionKey(p.addresses.account, p.addresses.market, p.addresses.collateralToken, p.flags.isLong), market: p.addresses.market, collateralToken: p.addresses.collateralToken, isLong: p.flags.isLong,
          sizeInUsd: p.numbers.sizeInUsd, sizeInTokens: p.numbers.sizeInTokens, collateralAmount: p.numbers.collateralAmount, increasedAtTime: Number(p.numbers.increasedAtTime) }));
      } catch (e) { return unreadable(e); }
    },
    async orders(me) {
      try { return (await reader('getAccountOrders', [P.dataStore.address, me, 0n, 100n]) as any[]).map((x) => orderOf(x.orderKey, x.order)); } catch (e) { return unreadable(e); }
    },
    async order(key) {
      try { const o = orderOf(key, await reader('getOrder', [P.dataStore.address, key])); return /^0x0{40}$/.test(o.account) ? null : o; } catch (e) { return unreadable(e); }
    },
    async estimateGas(c) {
      // every endpoint must answer; the larger estimate is kept
      const rs = await Promise.allSettled(urls.map((u) => rpcOne<Hex>(u, 'eth_estimateGas', [{ from: c.from, to: c.to, data: c.data, value: numberToHex(c.value) }])));
      if (rs.some((r) => r.status === 'rejected')) return null;
      return rs.map((r) => hexToBigInt((r as PromiseFulfilledResult<Hex>).value)).reduce((x, y) => (y > x ? y : x));
    },
    async simulate(c) {
      // on EVERY endpoint: one revert is a refusal, one silence is "try again"
      const rs = await Promise.allSettled(urls.map((u) => rpcOne<string>(u, 'eth_call', [{ from: c.from, to: c.to, data: c.data, value: numberToHex(c.value) }, 'latest'])));
      const bad = rs.flatMap((r) => (r.status === 'rejected' ? [r.reason as Error & { rpcCode?: number }] : []));
      const revert = bad.find((e) => e.rpcCode !== undefined);
      if (revert) return { unreachable: false, error: revert.message.slice(0, 160) };
      return bad.length ? { unreachable: true, error: bad[0]!.message.slice(0, 160) } : null;
    },
    async broadcast(raw) {
      // to every endpoint: a transaction already known is not an error
      const rs = await Promise.allSettled(urls.map((u) => rpcOne<string>(u, 'eth_sendRawTransaction', [raw])));
      if (rs.every((r) => r.status === 'rejected' && !/already known|nonce too low|known transaction/i.test(String((r.reason as Error).message)))) throw new Error(String((rs[0] as PromiseRejectedResult).reason?.message ?? 'broadcast failed').slice(0, 200));
    },
    async receipt(txid) {
      const rc = await rpcAny<{ status: Hex; blockNumber: Hex; gasUsed: Hex; effectiveGasPrice: Hex; logs: GmxLog[] } | null>(urls, 'eth_getTransactionReceipt', [txid]).catch(() => null);
      return rc ? { ok: hexToNumber(rc.status) === 1, blockNumber: hexToNumber(rc.blockNumber), gasUsed: hexToBigInt(rc.gasUsed), effectiveGasPrice: hexToBigInt(rc.effectiveGasPrice ?? '0x0'), logs: rc.logs } : null;
    },
    async orderEvents(key, fromBlock) {
      try {
        const head = hexToNumber(await rpcAny<Hex>(urls, 'eth_blockNumber', []));
        const out: { event: GmxEvent; txid: string; blockNumber: number }[] = [];
        for (let from = fromBlock; from <= head; from += LOG_SPAN) {
          const logs = await rpcAny<(GmxLog & { transactionHash: string; blockNumber: Hex; removed?: boolean })[]>(urls, 'eth_getLogs', [{ address: P.eventEmitter.address, topics: [EVENT_LOG_2, null, pad(key as Hex)], fromBlock: numberToHex(from), toBlock: numberToHex(Math.min(head, from + LOG_SPAN - 1)) }]);
          for (const l of logs) { if (l.removed) continue; const event = decodeGmxEvent(l); if (event) out.push({ event, txid: l.transactionHash, blockNumber: hexToNumber(l.blockNumber) }); }
          if (from + LOG_SPAN > fromBlock + 20 * LOG_SPAN) break; // at most ~2 days of Arbitrum blocks per pass
        }
        return out;
      } catch (e) { return unreadable(e); }
    },
  };
}
