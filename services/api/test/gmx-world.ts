/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/gmx-world.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
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

// The scripted GMX chain of the tests, shared: the same fake as services/api/test/derivatives-gmx.test.ts (copied from it, not
// changed) — it "mines" the signed transactions it is handed, decodes them with the same ABI as the fork proof and emits real
// EventEmitter logs. No network: nothing is broadcast anywhere.
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, keccak256, pad, parseTransaction, toHex, type Abi, type Hex } from 'viem';
import { decodeGmxCalldata, GMX_EVENT_EMITTER_ABI, GMX_MARKETS, GMX_PINS, type GmxCreateOrderParams } from '@spw/derivatives/live';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { UserError } from '../src/config.ts';
import type { Clock } from './derivatives-helpers.ts';

export const gmxKeys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
export const ME = gmxKeys.addresses.evm, GMX_ETH = GMX_MARKETS.find((m) => m.priceSymbol === 'ETH')!, USDC = GMX_ETH.collateral[0]!.token, VAULT = GMX_PINS.orderVault.address;
type Chain = import('../src/derivatives/gmx-chain.ts').GmxChain;
type Order = import('../src/derivatives/gmx-chain.ts').GmxChainOrder;
type Receipt = import('../src/derivatives/gmx-chain.ts').GmxReceipt;

const EV2 = (GMX_EVENT_EMITTER_ABI as any[]).find((x) => x.name === 'EventLog2');
type Items = { address?: [string, string][]; uint?: [string, bigint][]; int?: [string, bigint][]; bool?: [string, boolean][]; bytes32?: [string, string][]; bytes?: [string, string][]; string?: [string, string][]; addressArr?: [string, string[]][]; bytes32Arr?: [string, string[]][] };
/** a real EventEmitter log, ABI-encoded like the contract does */
function gmxLog(name: string, key: string, account: string, it: Items) {
  const g = (items: [string, unknown][] = [], arr: [string, unknown][] = []) => ({ items: items.map(([k, value]) => ({ key: k, value })), arrayItems: arr.map(([k, value]) => ({ key: k, value })) });
  const data = { addressItems: g(it.address, it.addressArr), uintItems: g(it.uint), intItems: g(it.int), boolItems: g(it.bool), bytes32Items: g(it.bytes32, it.bytes32Arr), bytesItems: g(it.bytes), stringItems: g(it.string) };
  return { address: GMX_PINS.eventEmitter.address, topics: encodeEventTopics({ abi: GMX_EVENT_EMITTER_ABI as Abi, eventName: 'EventLog2', args: { eventNameHash: name, topic1: key, topic2: pad(account as Hex) } } as never) as string[],
    data: encodeAbiParameters(EV2.inputs.filter((x: any) => !x.indexed), [GMX_PINS.orderHandler.address, name, data] as never) };
}
const transferLog = (token: string, from: string, to: string, value: bigint) => ({ address: token, topics: [keccak256(toHex('Transfer(address,address,uint256)')), pad(from as Hex), pad(to as Hex)], data: pad(toHex(value)) });

export class FakeChain {
  clock: Clock;
  pinsOk = true; unreadable = false;
  usdc = 100_000_000n; eth = 10n ** 16n; allowance = 0n; nonce = 5; block = 1000;
  orders = new Map<string, Order>(); positions: Awaited<ReturnType<Chain['positions']>> = [];
  receipts = new Map<string, Receipt>(); events = new Map<string, { event: any; txid: string; blockNumber: number }[]>();
  pending: { raw: string; txid: string }[] = []; broadcasts: string[] = [];
  revertNext: string | null = null; simulateError: string | null = null; hideEvents = false; seq = 0;
  constructor(clock: Clock) { this.clock = clock; }
  private txid(tag: string) { return keccak256(toHex(`${tag}-${++this.seq}`)); }
  async checkPins() { if (this.unreadable) throw new UserError('chain_unreadable', 'Arbitrum could not be read', 503); return this.pinsOk ? { ok: true, problems: [], checkedAt: this.clock.now() } : { ok: false, problems: ['exchangeRouter no longer holds the CONTROLLER role in GMX\'s RoleStore'], checkedAt: this.clock.now() }; }
  async balances() { return { usdc: this.usdc, eth: this.eth, weth: 0n, usdcAllowance: this.allowance }; }
  async txParams() { return { baseFee: 20_000_000n, tip: 1_000_000n, nonce: this.nonce }; }
  async executionGas() { return { increase: 4_149_674n, decrease: 4_149_674n }; }
  orders2 = async () => [...this.orders.values()];
  async order(key: string) { return this.orders.get(key) ?? null; }
  async estimateGas() { return 900_000n; }
  async simulate() { return this.simulateError ? { unreachable: false, error: this.simulateError } : null; }
  async broadcast(raw: string) { if (!this.broadcasts.includes(raw)) this.broadcasts.push(raw); const txid = keccak256(raw as Hex); if (!this.pending.some((p) => p.txid === txid) && !this.receipts.has(txid)) this.pending.push({ raw, txid }); }
  async receipt(txid: string) { return this.receipts.get(txid) ?? null; }
  async orderEvents(key: string) { return this.hideEvents ? [] : (this.events.get(key) ?? []); }
  private emit(key: string, e: { address: string; topics: string[]; data: string }, txid: string, blockNumber: number, dec: (l: any) => any) { const l = this.events.get(key) ?? []; l.push({ event: dec(e), txid, blockNumber }); this.events.set(key, l); }
  dec!: (l: any) => any;
  /** mine everything that was broadcast: approvals set the allowance, order transactions create an order and emit OrderCreated, cancellations cancel */
  mine(): string[] {
    const keysMade: string[] = [];
    for (const { raw, txid } of this.pending.splice(0)) {
      const tx = parseTransaction(raw as Hex), blockNumber = ++this.block, base = { blockNumber, gasUsed: 930_000n, effectiveGasPrice: 20_000_000n };
      this.nonce = Math.max(this.nonce, (tx.nonce ?? 0) + 1);
      if (this.revertNext === 'next') { this.revertNext = null; this.receipts.set(txid, { ...base, ok: false, logs: [] }); continue; }
      if (tx.to!.toLowerCase() === USDC.toLowerCase()) { const d = decodeFunctionData({ abi: erc20Abi, data: tx.data! }); if (d.functionName !== 'approve' || d.args[0] !== GMX_PINS.router.address) throw new Error('unexpected token call'); this.allowance = d.args[1] as bigint; this.receipts.set(txid, { ...base, ok: true, logs: [] }); continue; }
      if (tx.to!.toLowerCase() !== GMX_PINS.exchangeRouter.address.toLowerCase()) throw new Error('a transaction went to an unexpected address');
      const d = decodeGmxCalldata(tx.data!);
      if (d.fn === 'cancelOrder') {
        const key = String(d.calls[0]!.args[0]), o = this.orders.get(key);
        if (!o) { this.receipts.set(txid, { ...base, ok: false, logs: [] }); continue; }
        const logs = this.cancelLogs(o, 'USER_INITIATED_CANCEL', '0x');
        this.orders.delete(key); this.receipts.set(txid, { ...base, ok: true, logs });
        this.emit(key, logs[0]!, txid, blockNumber, this.dec);
        continue;
      }
      const p = d.calls[d.calls.length - 1]!.args[0] as GmxCreateOrderParams, fee = d.calls[0]!.args[1] as bigint, increase = p.orderType === 2;
      if ((tx.value ?? 0n) !== fee) throw new Error('msg.value is not the execution fee');
      if (increase) { const amount = d.calls[1]!.args[2] as bigint; if (this.allowance < amount) { this.receipts.set(txid, { ...base, ok: false, logs: [] }); continue; } this.allowance -= amount; this.usdc -= amount; }
      this.eth -= fee;
      const key = keccak256(toHex(`order-${++this.seq}`));
      const o: Order = { key, account: ME, receiver: p.addresses.receiver, cancellationReceiver: p.addresses.cancellationReceiver, callbackContract: p.addresses.callbackContract, uiFeeReceiver: p.addresses.uiFeeReceiver, market: p.addresses.market, initialCollateralToken: p.addresses.initialCollateralToken,
        swapPathLength: p.addresses.swapPath.length, orderType: p.orderType, sizeDeltaUsd: p.numbers.sizeDeltaUsd, initialCollateralDeltaAmount: p.numbers.initialCollateralDeltaAmount, acceptablePrice: p.numbers.acceptablePrice, executionFee: fee,
        updatedAtTime: Math.floor(this.clock.now() / 1000), isLong: p.isLong, isFrozen: false };
      this.orders.set(key, o); keysMade.push(key);
      this.receipts.set(txid, { ...base, ok: true, logs: [gmxLog('OrderCreated', key, ME, {
        address: [['account', ME], ['receiver', o.receiver], ['callbackContract', o.callbackContract], ['uiFeeReceiver', o.uiFeeReceiver], ['market', o.market], ['initialCollateralToken', o.initialCollateralToken], ['cancellationReceiver', o.cancellationReceiver]], addressArr: [['swapPath', []]],
        uint: [['orderType', BigInt(o.orderType)], ['decreasePositionSwapType', 0n], ['sizeDeltaUsd', o.sizeDeltaUsd], ['initialCollateralDeltaAmount', o.initialCollateralDeltaAmount], ['triggerPrice', 0n], ['acceptablePrice', o.acceptablePrice], ['executionFee', fee], ['callbackGasLimit', 0n],
          ['minOutputAmount', 0n], ['uiFeeFactor', 0n], ['updatedAtTime', BigInt(o.updatedAtTime)], ['validFromTime', 0n], ['srcChainId', 0n]],
        bool: [['isLong', o.isLong], ['shouldUnwrapNativeToken', false], ['autoCancel', false]], bytes32: [['key', key]], bytes32Arr: [['dataList', []]] })] });
    }
    return keysMade;
  }
  private cancelLogs(o: Order, reason: string, reasonBytes: string) {
    const logs = [gmxLog('OrderCancelled', o.key, ME, { bytes32: [['key', o.key]], address: [['account', ME]], string: [['reason', reason]], bytes: [['reasonBytes', reasonBytes]] })];
    if (o.orderType === 2) { this.usdc += o.initialCollateralDeltaAmount; logs.push(transferLog(USDC, VAULT, ME, o.initialCollateralDeltaAmount) as never); }
    this.eth += o.executionFee / 3n;
    logs.push(gmxLog('ExecutionFeeRefund', o.key, ME, { address: [['receiver', ME]], uint: [['refundFeeAmount', o.executionFee / 3n]] }));
    return logs;
  }
  /** what a GMX keeper does: execute at a price (contract units), cancel with an error, or freeze */
  keeper(key: string, what: 'execute' | 'cancel' | 'freeze', price = 2063_550000000000n) {
    const o = this.orders.get(key)!, txid = this.txid('keeper'), blockNumber = ++this.block, base = { blockNumber, gasUsed: 3_000_000n, effectiveGasPrice: 20_000_000n, ok: true };
    if (what === 'freeze') { o.isFrozen = true; const l = gmxLog('OrderFrozen', key, ME, { bytes32: [['key', key]], address: [['account', ME]], string: [['reason', 'frozen for a test']], bytes: [['reasonBytes', '0x']] }); this.receipts.set(txid, { ...base, logs: [l] }); this.emit(key, l, txid, blockNumber, this.dec); return txid; }
    this.orders.delete(key);
    if (what === 'cancel') { const logs = this.cancelLogs(o, '', '0xe09ad0e9'); this.receipts.set(txid, { ...base, logs }); this.emit(key, logs[0]!, txid, blockNumber, this.dec); return txid; }
    const increase = o.orderType === 2, logs: any[] = [gmxLog('OrderExecuted', key, ME, { bytes32: [['key', key]], address: [['account', ME]], uint: [['secondaryOrderType', 0n]] })];
    if (increase) {
      const fee = (o.sizeDeltaUsd / 10n ** 24n) * 4n / 10_000n; // 0.04 % in USDC base units
      this.positions = [{ key: keccak256(toHex('position')), market: o.market, collateralToken: USDC, isLong: o.isLong, sizeInUsd: o.sizeDeltaUsd, sizeInTokens: o.sizeDeltaUsd / price, collateralAmount: o.initialCollateralDeltaAmount - fee, increasedAtTime: Math.floor(this.clock.now() / 1000) }];
      logs.push(gmxLog('PositionIncrease', key, ME, { address: [['account', ME], ['market', o.market]], uint: [['sizeInUsd', o.sizeDeltaUsd], ['executionPrice', price], ['sizeDeltaUsd', o.sizeDeltaUsd]], int: [['priceImpactUsd', -3n * 10n ** 27n]], bool: [['isLong', o.isLong]], bytes32: [['orderKey', key]] }),
        gmxLog('PositionFeesCollected', key, ME, { uint: [['positionFeeAmount', fee], ['collateralTokenPrice.min', 10n ** 24n]], bytes32: [['orderKey', key]] }));
    } else {
      const pos = this.positions[0]!, back = pos.collateralAmount - 30_000n; this.positions = []; this.usdc += back;
      logs.push(gmxLog('PositionDecrease', key, ME, { address: [['account', ME], ['market', o.market]], uint: [['sizeInUsd', 0n], ['executionPrice', price], ['sizeDeltaUsd', o.sizeDeltaUsd]], int: [['basePnlUsd', 0n], ['priceImpactUsd', -14n * 10n ** 27n]], bool: [['isLong', o.isLong]], bytes32: [['orderKey', key]] }),
        transferLog(USDC, o.market, ME, back));
    }
    this.eth += o.executionFee / 3n;
    logs.push(gmxLog('ExecutionFeeRefund', key, ME, { address: [['receiver', ME]], uint: [['refundFeeAmount', o.executionFee / 3n]] }));
    this.receipts.set(txid, { ...base, logs }); this.emit(key, logs[0]!, txid, blockNumber, this.dec);
    return txid;
  }
}
