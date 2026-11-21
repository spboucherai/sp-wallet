/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/derivatives-gmx.test.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
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

// GMX v2 trading, end to end inside the process: the REAL engine (gmx-exec.ts) and its routes, the REAL isolated signer class
// (public test mnemonic, real WebAuthn assertions from a software passkey, a scripted price view), PostgreSQL (database
// one per run, test-db.ts label deriv_gmx), GMX market data replayed from recorded fixtures, and a scripted fake of the
// chain side (GmxChain) that "mines" the signed transactions it is handed: it decodes them with the same ABI as the fork proof
// and emits real EventEmitter logs (EventLog2, ABI-encoded) for OrderCreated / OrderExecuted / OrderCancelled / OrderFrozen.
// No network: nothing is broadcast anywhere. The real contracts are exercised by scripts/fork-gmx.mts.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, keccak256, pad, parseTransaction, toHex, type Abi, type Hex } from 'viem';
import { D } from '@spw/derivatives';
import { decodeGmxCalldata, GMX_EVENT_EMITTER_ABI, GMX_MARKETS, GMX_PINS, gmxAuthorizationHash, gmxUsdToRaw, type GmxCreateOrderParams } from '@spw/derivatives/live';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import type { PriceView } from '../../isolated-signer/src/prices.ts';
import { Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';
import { Clock, fixtureVenues, useDatabase, passkeyVerifier } from './derivatives-helpers.ts';

const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const ME = keys.addresses.evm, ETH = GMX_MARKETS.find((m) => m.priceSymbol === 'ETH')!, BTC = GMX_MARKETS.find((m) => m.priceSymbol === 'BTC')!, USDC = ETH.collateral[0]!.token, VAULT = GMX_PINS.orderVault.address;

let sql: any, ex: typeof import('../src/derivatives/gmx-exec.ts'), rt: typeof import('../src/derivatives/gmx-routes.ts'), dv: typeof import('../src/derivatives/index.ts'), UserError: typeof import('../src/config.ts').UserError;
type Svc = import('../src/derivatives/gmx-exec.ts').GmxService;
type Chain = import('../src/derivatives/gmx-chain.ts').GmxChain;
type Order = import('../src/derivatives/gmx-chain.ts').GmxChainOrder;
type Receipt = import('../src/derivatives/gmx-chain.ts').GmxReceipt;

beforeAll(async () => {
  await useDatabase('deriv_gmx');
  const db = await import('../src/db.ts');
  sql = db.sql;
  await db.migrate(); await db.migrate();
  ex = await import('../src/derivatives/gmx-exec.ts'); rt = await import('../src/derivatives/gmx-routes.ts'); dv = await import('../src/derivatives/index.ts');
  UserError = (await import('../src/config.ts')).UserError;
});
beforeEach(async () => { await sql`truncate deriv_gmx_ops, proposals`; });
afterAll(async () => { await sql?.end(); });

// --------------------------------------------------------------------------------------------------------------------------
// the scripted chain

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

class FakeChain {
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

// --------------------------------------------------------------------------------------------------------------------------

interface World { clock: Clock; chain: FakeChain; port: Chain; svc: Svc; signer: Signer; store: Store; pk: TestPasskey; settings: { liveMainnet: boolean; gmxLive: boolean }; px: { ETH: number; BTC: number; USDC: number }; app: ReturnType<typeof fastify>; mid: string }
async function world(o: { settings?: Partial<World['settings']>; authorize?: boolean } = {}): Promise<World> {
  const clock = new Clock(), v = fixtureVenues(clock), d = dv.createDerivatives({ registry: dv.createRegistry(v.adapters, clock.now), now: clock.now });
  const m = await d.data.market(ETH.instrument), mid = D.str(D.div(D.add(D.from(m.liquidity!.oracleMin), D.from(m.liquidity!.oracleMax)), D.from('2'), 6, 'half_even'));
  const px = { ETH: Number(mid), BTC: 73_700, USDC: 1 };
  const prices: PriceView = { get: async (symbols) => Object.fromEntries(symbols.map((s): [string, number] => { const p = (px as Record<string, number | undefined>)[s]; if (p === undefined || !(p > 0)) throw new Error(`no price for ${s}`); return [s, p]; })) };
  const dir = mkdtempSync(join(tmpdir(), 'spw-gmx-api-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => Math.floor(clock.now() / 1000), prices);
  const pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 'tok' });
  const chain = new FakeChain(clock);
  const mod = await import('@spw/derivatives/live');
  chain.dec = (l) => mod.decodeGmxEvent(l);
  const port: Chain = { checkPins: () => chain.checkPins(), balances: () => chain.balances(), txParams: () => chain.txParams(), executionGas: () => chain.executionGas(), positions: async () => chain.positions, orders: () => chain.orders2(), order: (k) => chain.order(k),
    estimateGas: () => chain.estimateGas(), simulate: () => chain.simulate(), broadcast: (r) => chain.broadcast(r), receipt: (t) => chain.receipt(t), orderEvents: (k) => chain.orderEvents(k) };
  const settings = { liveMainnet: true, gmxLive: true, ...o.settings };
  const sp = { status: async () => signer.status() as never, sign: (i: unknown, a: unknown) => signer.sign(i, a as never), gmxAuthorize: (a: unknown, as: unknown) => signer.gmxAuthorize(a, as as never), gmxRevoke: async (id: string) => signer.gmxRevoke(id) };
  const svc = new ex.GmxService({ chain: port, signer: sp, now: clock.now, rpId: RP, credentials: async () => [{ id: pk.id, transports: ['internal'] }], settings: () => settings, verifyOwner: passkeyVerifier(pk, RP, ORIGIN),
    market: { market: async (id) => { const x = await d.data.market(id); return { instrument: x.instrument, ticker: x.ticker, liquidity: x.liquidity }; }, apiPositions: async () => [] } });
  const app = fastify();
  app.setErrorHandler((e: any, _q, reply) => { reply.status(e.status ?? (e.name === 'ZodError' ? 400 : 500)).send({ error: e.code ?? 'bad_request', message: e.message }); });
  rt.gmxRoutes(app, svc);
  const w: World = { clock, chain, port, svc, signer, store, pk, settings, px, app, mid };
  if (o.authorize !== false && settings.gmxLive && settings.liveMainnet) await authorize(w);
  return w;
}
async function authorize(w: World, over: Record<string, unknown> = {}) {
  const prep = await w.svc.prepareAuthorization({ allowedMarkets: [ETH.market], maxLeverage: 3, maxOrderSizeUsd: '100', maxOrdersPerDay: 5, maxPriceDeviationBps: 100, days: 7, locale: 'fr', ...over } as never);
  return w.svc.approveAuthorization({ authorization: prep.authorization, assertion: w.pk.assert(Buffer.from(prep.hash, 'hex')) as never }, 'fr');
}
const hashOf = (prepared: { operation: { hash: string | null } }) => Buffer.from(prepared.operation.hash!, 'hex');
const LONG = { market: ETH.market, side: 'long' as const, action: 'increase' as const, collateral: '20', leverage: '3', slippageBps: 50 };
let idem = 0;
const key = () => `gmx-test-${String(++idem).padStart(6, '0')}`;
/** prepare + approve + mine the approval and the order transaction: returns the operation in `created` and the order key */
async function place(w: World, body: Record<string, unknown> = LONG) {
  const prep = await w.svc.prepareOrder(body as never, key());
  await w.svc.approve(prep.operation.id, w.pk.assert(hashOf(prep)));
  w.chain.mine(); await w.svc.step(); // the approval (when there is one) is mined; the order transaction leaves
  const made = w.chain.mine(); await w.svc.step();
  const op = (await w.svc.operation(prep.operation.id)).operation;
  return { prep, op, key: made[0] ?? op.orderKey! };
}
const refusal = async (p: Promise<unknown>) => p.then(() => { throw new Error('was not refused'); }, (e: any) => ({ code: e.code as string, status: e.status as number, message: String(e.message) }));

describe('locks: two server settings, the authorization, the pins', () => {
  it('with the GMX setting off: reading works, nothing can be prepared, and the status says it is a server setting', async () => {
    const w = await world({ settings: { gmxLive: false } });
    const s = await w.svc.status('fr');
    expect(s.tradable).toBe(false);
    expect(s.blockers).toEqual(['gmx_setting_off', 'not_authorized']);
    expect(s.blockerText.gmx_setting_off).toMatch(/SPW_DERIV_GMX_LIVE.*réglage du serveur/);
    expect(s.account?.address).toBe(ME); expect(s.wallet?.usdc).toBe('100'); expect(s.pins.ok).toBe(true); expect(s.markets.map((m) => m.base)).toEqual(['BTC', 'ETH']);
    expect(await refusal(w.svc.prepareOrder(LONG as never, key()))).toMatchObject({ code: 'gmx_disabled', status: 403 });
    expect(await refusal(w.svc.prepareAuthorization({ allowedMarkets: [ETH.market], maxLeverage: 3, maxOrderSizeUsd: '100', maxOrdersPerDay: 5, maxPriceDeviationBps: 100, days: 7, locale: 'fr' }))).toMatchObject({ code: 'gmx_disabled' });
    expect((await w.svc.preview(LONG as never)).blockers).toContain('gmx_setting_off'); // a preview is an estimate: allowed, and it says why nothing can follow
    expect(w.chain.broadcasts).toHaveLength(0);
  });
  it('with the mainnet setting off: refused too', async () => {
    const w = await world({ settings: { liveMainnet: false } });
    expect((await w.svc.status()).blockers).toContain('mainnet_setting_off');
    expect(await refusal(w.svc.prepareOrder(LONG as never, key()))).toMatchObject({ code: 'mainnet_disabled', status: 403 });
  });
  it('authorization: the signer stores the policy after a passkey over its canonical hash; without it nothing is prepared; revoking needs no passkey', async () => {
    const w = await world({ authorize: false });
    expect(await refusal(w.svc.prepareOrder(LONG as never, key()))).toMatchObject({ code: 'not_authorized', status: 409 });
    const prep = await w.svc.prepareAuthorization({ allowedMarkets: [ETH.market], maxLeverage: 3, maxOrderSizeUsd: '100', maxOrdersPerDay: 5, maxPriceDeviationBps: 100, days: 7, locale: 'fr' });
    expect(prep.hash).toBe(Buffer.from(gmxAuthorizationHash(prep.authorization)).toString('hex'));
    expect(prep.ack.text).toMatch(/GMX v2/); expect(prep.authorization.contracts).toBe(GMX_PINS.id); expect(prep.authorization.account).toBe(ME.toLowerCase());
    expect(await refusal(w.svc.approveAuthorization({ authorization: { ...prep.authorization, policy: { ...prep.authorization.policy, maxLeverage: 20 } }, assertion: w.pk.assert(Buffer.from(prep.hash, 'hex')) as never }))).toMatchObject({ code: 'bad_approval' });
    const s = await w.svc.approveAuthorization({ authorization: prep.authorization, assertion: w.pk.assert(Buffer.from(prep.hash, 'hex')) as never }, 'fr');
    expect(s.tradable).toBe(true); expect(s.blockers).toEqual([]); expect(s.authorization).toMatchObject({ state: 'active', policy: { maxLeverage: 3, maxOrderSizeUsd: '100' } });
    expect(s.markets.find((m) => m.base === 'ETH')!.allowed).toBe(true); expect(s.markets.find((m) => m.base === 'BTC')!.allowed).toBe(false);
    const r = await w.svc.revoke('fr');
    expect(r.tradable).toBe(false); expect(r.blockers).toEqual(['authorization_revoked']);
    expect(await refusal(w.svc.prepareOrder(LONG as never, key()))).toMatchObject({ code: 'not_authorized' });
  });
  it('pins fail closed: before preparing, and again at the moment the signed order would leave', async () => {
    const w = await world();
    w.chain.pinsOk = false;
    const s = await w.svc.status('fr');
    expect(s.blockers).toEqual(['contracts_changed']); expect(s.pins).toMatchObject({ ok: false }); expect(s.blockerText.contracts_changed).toMatch(/GMX a publié de nouveaux contrats : nouvelle revue nécessaire/);
    expect(await refusal(w.svc.prepareOrder(LONG as never, key()))).toMatchObject({ code: 'contract_changed', status: 503 });
    w.chain.pinsOk = true;
    const prep = await w.svc.prepareOrder(LONG as never, key());
    await w.svc.approve(prep.operation.id, w.pk.assert(hashOf(prep)));
    w.chain.mine(); // the approval is mined…
    w.chain.pinsOk = false; // …and GMX replaces its router before the order leaves
    await w.svc.step();
    const op = (await w.svc.operation(prep.operation.id)).operation;
    expect(op).toMatchObject({ state: 'failed', final: true }); expect(op.error).toMatch(/nouvelle revue nécessaire.*not sent.*approval of the Router stays/);
    expect(w.chain.broadcasts).toHaveLength(1); // the approval only
    w.chain.unreadable = true;
    expect((await w.svc.status()).blockers).toContain('chain_unreadable');
    expect(await refusal(w.svc.prepareOrder(LONG as never, key()))).toMatchObject({ code: 'chain_unreadable', status: 503 });
  });
});

describe('an increase, from the estimate to the reconciled execution', () => {
  it('preview: fees from the venue\'s own factors, labelled estimates; the risk engine sees the wallet and the chain', async () => {
    const w = await world(), p = await w.svc.preview(LONG as never), e = p.estimate;
    expect(p.order).toMatchObject({ marketName: 'ETH/USD [WETH-USDC]', side: 'long', action: 'increase', collateral: '20', sizeUsd: '60', leverage: '3', slippageBps: 50 });
    expect(e.source).toBe('estimate');
    expect(Number(e.acceptablePrice)).toBeCloseTo(Number(e.oracleMax) * 1.005, 6); // a long opens at the oracle max; worst price 50 bps above
    expect(['4', '6']).toContain(e.positionFee.bps); expect(Number(e.positionFee.usd)).toBeCloseTo(60 * Number(e.positionFee.bps) / 10_000, 6);
    expect(e.executionFee.sentWei).toBe((4_149_674n * (30_000_000n + 1_000_000n)).toString()); // gas the contracts price × (1.5 × base fee + tip)
    expect(Number(e.priceImpact.uncertaintyUsd)).toBe(Math.abs(Number(e.priceImpact.usd)));
    expect(Number(e.liquidationPrice)).toBeGreaterThan(Number(w.mid) * 0.6); expect(Number(e.liquidationPrice)).toBeLessThan(Number(w.mid));
    expect(p.risk).toEqual({ ok: true }); expect(p.blockers).toEqual([]); expect(p.signerWould).toBeNull();
    const big = await w.svc.preview({ ...LONG, leverage: '4' } as never);
    expect(big.signerWould).toMatch(/leverage 4× is above the authorized 3×/);
    expect(await sql`select count(*)::int as n from deriv_gmx_ops`).toEqual([{ n: 0 }]);
  });
  it('prepare shows exactly what the passkey signs; approve → approval mined → order sent → created → executed by the keeper, reconciled from events', async () => {
    const w = await world();
    const prep = await w.svc.prepareOrder(LONG as never, key());
    expect(prep.operation).toMatchObject({ kind: 'increase', state: 'pending_approval', marketName: 'ETH/USD [WETH-USDC]', side: 'long', collateral: '20', sizeUsd: '60', needsApproval: true });
    expect(Object.fromEntries(prep.fields.map((f) => [f.label, f.value]))).toMatchObject({ action: 'increase', side: 'long', orderType: 'MarketIncrease', sizeUsd: '60', exchangeRouter: GMX_PINS.exchangeRouter.address, router: GMX_PINS.router.address, orderVault: VAULT });
    expect(Object.fromEntries(prep.fixed.map((f) => [f.label, f.value]))).toMatchObject({ receiver: ME, cancellationReceiver: ME, callbackContract: 'none (0x0)', uiFeeReceiver: 'none (0x0)', swapPath: 'empty', referralCode: 'none' });
    expect(prep.intent.gmx).toMatchObject({ action: 'increase', market: ETH.market, collateralToken: USDC, sizeDeltaUsd: gmxUsdToRaw('60').toString(), approveGas: '60000' });
    expect(prep.options!.challenge).toBe(hashOf(prep).toString('base64url'));
    expect((await w.svc.prepareOrder(LONG as never, `gmx-test-${String(idem).padStart(6, '0')}`)).operation.id).toBe(prep.operation.id); // idempotent
    const [p0] = await sql`select kind, state, amount::text, to_addr from proposals where id = ${prep.operation.proposalId}`;
    expect(p0).toEqual({ kind: 'gmx', state: 'pending_approval', amount: '20000000', to_addr: GMX_PINS.exchangeRouter.address });

    expect(await refusal(w.svc.approve(prep.operation.id, new TestPasskey(RP, ORIGIN).assert(hashOf(prep))))).toMatchObject({ code: 'unknown_credential' });
    expect((await w.svc.operation(prep.operation.id)).operation).toMatchObject({ state: 'failed' }); // a refused approval ends the proposal: nothing was signed
    expect(w.chain.broadcasts).toHaveLength(0);

    const again = await w.svc.prepareOrder(LONG as never, key());
    let op = (await w.svc.approve(again.operation.id, w.pk.assert(hashOf(again)))).operation;
    expect(op.state).toBe('signed'); expect(w.chain.broadcasts).toHaveLength(1); // only the exact-amount approval left
    const approval = parseTransaction(w.chain.broadcasts[0] as Hex);
    expect(decodeFunctionData({ abi: erc20Abi, data: approval.data! })).toMatchObject({ functionName: 'approve', args: [GMX_PINS.router.address, 20_000_000n] });
    w.chain.mine(); await w.svc.step();
    op = (await w.svc.operation(op.id)).operation;
    expect(op.state).toBe('sent'); expect(w.chain.broadcasts).toHaveLength(2);
    const [k] = w.chain.mine(); await w.svc.step();
    op = (await w.svc.operation(op.id)).operation;
    expect(op).toMatchObject({ state: 'created', final: false, orderKey: k, error: null, overdue: false });
    expect(op.cancellableAt).toBe(op.orderCreatedAt! + 300_000);
    let s = await w.svc.status();
    expect(s.pendingOrders).toMatchObject([{ key: k, orderType: 'MarketIncrease', side: 'long', sizeUsd: '60', collateral: '20', opId: op.id, frozen: false }]);
    expect(s.wallet).toMatchObject({ usdc: '80' }); expect(s.positions).toEqual([]);
    w.clock.advance(11 * 60_000); expect((await w.svc.operation(op.id)).operation).toMatchObject({ state: 'created', overdue: true }); // no keeper yet: said, not assumed

    const kx = w.chain.keeper(k!, 'execute'); await w.svc.step();
    op = (await w.svc.operation(op.id)).operation;
    expect(op).toMatchObject({ state: 'executed', final: true, error: null });
    expect(op.outcome).toMatchObject({ event: 'OrderExecuted', txid: kx, executionPrice: '2063.55', sizeUsd: '60', positionFeeUsd: '0.024', priceImpactUsd: '-0.003', cancelledBy: null });
    expect(Number(op.outcome!.executionFeeRefundEth)).toBeGreaterThan(0);
    s = await w.svc.status();
    expect(s.pendingOrders).toEqual([]);
    expect(s.positions).toMatchObject([{ marketName: 'ETH/USD [WETH-USDC]', side: 'long', sizeUsd: '60', collateral: '19.976', collateralSymbol: 'USDC', source: 'chain', venueApi: { agrees: false } }]);
    expect(Number(s.positions[0]!.liquidationPrice)).toBeLessThan(Number(s.positions[0]!.entryPrice));
    expect(s.authorization!.today).toEqual({ increases: 1, reduces: 0 });
    expect(w.store.state.journal.filter((j) => j.type === 'gmx.sign.ok')).toHaveLength(1);
  });
  it('a second order while a transaction of the wallet is in flight is refused; an allowance already in place needs no approval', async () => {
    const w = await world();
    const a = await w.svc.prepareOrder(LONG as never, key());
    await w.svc.approve(a.operation.id, w.pk.assert(hashOf(a)));
    expect(await refusal(w.svc.prepareOrder(LONG as never, key()))).toMatchObject({ code: 'pending_tx', status: 409 });
    await sql`truncate deriv_gmx_ops, proposals`;
    const w2 = await world(); w2.chain.allowance = 20_000_000n;
    const b = await w2.svc.prepareOrder(LONG as never, key());
    expect(b.operation.needsApproval).toBe(false); expect(b.intent.gmx!.approveGas).toBe('0'); expect(b.intent.evm!.gasLimit).toBe('1170000'); // estimate × 1.3
    await w2.svc.approve(b.operation.id, w2.pk.assert(hashOf(b)));
    expect((await w2.svc.operation(b.operation.id)).operation.state).toBe('sent');
  });
});

describe('refusals', () => {
  it('risk engine, wallet limits, balances, a market outside the table — nothing is stored', async () => {
    const w = await world();
    expect(await refusal(w.svc.prepareOrder({ ...LONG, leverage: '4' } as never, key()))).toMatchObject({ code: 'venue_policy', status: 422 }); // the signer's own rule, applied before asking
    expect(await refusal(w.svc.prepareOrder({ ...LONG, collateral: '60', leverage: '1' } as never, key()))).toMatchObject({ code: 'policy' }); // above the wallet's 50 USDC per transfer
    expect((await refusal(w.svc.prepareOrder({ ...LONG, market: BTC.market } as never, key()))).code).toMatch(/^risk_/); // pinned, not authorized
    expect(await refusal(w.svc.prepareOrder({ ...LONG, market: '0x450bb6774Dd8a756274E0ab4107953259d2ac541' } as never, key()))).toMatchObject({ code: 'unknown_market' });
    w.chain.usdc = 15_000_000n;
    expect(await refusal(w.svc.prepareOrder({ ...LONG, leverage: '2' } as never, key()))).toMatchObject({ code: 'risk_insufficient_collateral' }); // the risk engine's account view is the wallet's own USDC
    expect((await refusal(w.svc.prepareOrder(LONG as never, key()))).code).toBe('risk_leverage_exceeded'); // 60 USD on a wallet worth 15
    w.chain.usdc = 100_000_000n; w.chain.eth = 10n ** 13n;
    expect(await refusal(w.svc.prepareOrder(LONG as never, key()))).toMatchObject({ code: 'insufficient_gas' });
    expect(await refusal(w.svc.prepareClose({ market: ETH.market, side: 'long', fraction: '1', slippageBps: 50 }, key()))).toMatchObject({ code: 'no_position' });
    expect(await sql`select count(*)::int as n from deriv_gmx_ops`).toEqual([{ n: 0 }]);
  });
  it('the signer has the last word: its own price moved away after the preparation → refused, the proposal ends, nothing is sent', async () => {
    const w = await world(), prep = await w.svc.prepareOrder(LONG as never, key());
    w.px.ETH = Number(w.mid) * 1.03;
    const r = await refusal(w.svc.approve(prep.operation.id, w.pk.assert(hashOf(prep))));
    expect(r.code).toBe('price'); expect(r.message).toMatch(/more than 100 bps away from the signer's own ETH price/);
    const op = (await w.svc.operation(prep.operation.id)).operation;
    expect(op).toMatchObject({ state: 'failed', final: true }); expect(op.error).toMatch(/the signer refused/);
    expect(await sql`select state from proposals where id = ${op.proposalId}`).toEqual([{ state: 'failed' }]);
    expect(w.chain.broadcasts).toHaveLength(0);
  });
  it('before the passkey: withdrawn by the owner, or expired — nothing was signed', async () => {
    const w = await world(), a = await w.svc.prepareOrder(LONG as never, key());
    expect((await w.svc.withdraw(a.operation.id)).operation).toMatchObject({ state: 'withdrawn', final: true });
    expect(await refusal(w.svc.approve(a.operation.id, w.pk.assert(hashOf(a))))).toMatchObject({ code: 'bad_state' });
    const b = await w.svc.prepareOrder(LONG as never, key());
    w.clock.advance(181_000);
    expect(await refusal(w.svc.approve(b.operation.id, w.pk.assert(hashOf(b))))).toMatchObject({ code: 'expired', status: 410 });
    expect((await w.svc.operation(b.operation.id)).operation).toMatchObject({ state: 'expired', final: true });
    expect(w.store.state.journal.filter((j) => j.type === 'sign.ok')).toHaveLength(0);
  });
});

describe('the order state machine after creation', () => {
  it('cancelled by the keeper: the reason from the event, and the collateral verified back in the wallet', async () => {
    const w = await world(), { op, key: k } = await place(w);
    expect(op.state).toBe('created');
    const tx = w.chain.keeper(k, 'cancel'); await w.svc.step();
    const done = (await w.svc.operation(op.id)).operation;
    expect(done).toMatchObject({ state: 'cancelled', final: true });
    expect(done.outcome).toMatchObject({ event: 'OrderCancelled', txid: tx, reasonCode: '0xe09ad0e9', cancelledBy: 'keeper', collateralReturned: true, collateralOut: '20' });
    expect(done.error).toMatch(/GMX cancelled the order.*the collateral came back to the wallet/);
    expect((await w.svc.status()).wallet!.usdc).toBe('100');
  });
  it('cancelled by the owner: refused before the request expiration, then a cancelOrder built by the signer', async () => {
    const w = await world(), { op, key: k } = await place(w);
    const early = await refusal(w.svc.prepareCancel(op.id));
    expect(early).toMatchObject({ code: 'not_yet_cancellable', status: 409 }); expect(early.message).toMatch(/300 s after its creation/);
    w.clock.advance(301_000);
    const prep = await w.svc.prepareCancel(op.id);
    expect(prep.operation).toMatchObject({ kind: 'cancel', state: 'pending_approval', orderKey: k, targetOpId: op.id, needsApproval: false, collateral: null });
    expect(prep.intent).toMatchObject({ asset: 'native', amount: '0', gmx: { action: 'cancel', orderKey: k, executionFee: '0' } });
    expect(Object.fromEntries(prep.fields.map((f) => [f.label, f.value]))).toMatchObject({ action: 'cancel', orderKey: k });
    await w.svc.approve(prep.operation.id, w.pk.assert(hashOf(prep)));
    const sent = parseTransaction(w.chain.broadcasts[w.chain.broadcasts.length - 1] as Hex);
    expect(decodeGmxCalldata(sent.data!)).toMatchObject({ fn: 'cancelOrder', calls: [{ args: [k] }] }); expect(sent.value ?? 0n).toBe(0n);
    w.chain.mine(); await w.svc.step();
    expect((await w.svc.operation(prep.operation.id)).operation).toMatchObject({ state: 'done', final: true });
    const target = (await w.svc.operation(op.id)).operation;
    expect(target).toMatchObject({ state: 'cancelled', final: true, outcome: { reason: 'USER_INITIATED_CANCEL', cancelledBy: 'owner', collateralReturned: true } });
    expect(await refusal(w.svc.prepareCancel(op.id))).toMatchObject({ code: 'bad_state' });
    expect((await w.svc.status()).authorization!.today).toEqual({ increases: 1, reduces: 1 });
  });
  it('frozen: shown as frozen, cancellable at once, then cancelled', async () => {
    const w = await world(), { op, key: k } = await place(w);
    w.chain.keeper(k, 'freeze'); await w.svc.step();
    const fr = (await w.svc.operation(op.id)).operation;
    expect(fr).toMatchObject({ state: 'frozen', final: false, outcome: { event: 'OrderFrozen', reason: 'frozen for a test' } }); expect(fr.cancellableAt).toBe(fr.orderCreatedAt);
    expect((await w.svc.status()).pendingOrders).toMatchObject([{ frozen: true }]);
    const prep = await w.svc.prepareCancel(op.id); // no delay for a frozen order
    await w.svc.approve(prep.operation.id, w.pk.assert(hashOf(prep))); w.chain.mine(); await w.svc.step();
    expect((await w.svc.operation(op.id)).operation).toMatchObject({ state: 'cancelled', final: true });
  });
  it('never found: an order that left the store without a visible event is `unknown`, never assumed — and resolves when the event appears', async () => {
    const w = await world(), { op, key: k } = await place(w);
    w.chain.hideEvents = true; w.chain.keeper(k, 'execute');
    await w.svc.step();
    expect((await sql`select state from deriv_gmx_ops where id = ${op.id}`)[0].state).toBe('created'); // gone from the order store, no event yet: not assumed either way
    for (let n = 0; n < 6; n++) await w.svc.step();
    const u = (await w.svc.operation(op.id)).operation;
    expect(u).toMatchObject({ state: 'unknown', final: false }); expect(u.error).toMatch(/outcome unknown/);
    w.chain.hideEvents = false; await w.svc.step();
    expect((await w.svc.operation(op.id)).operation).toMatchObject({ state: 'executed', final: true, error: null });
  });
  it('the order transaction reverts, or is never seen: failed / unknown, with what stays in place', async () => {
    const w = await world(), prep = await w.svc.prepareOrder(LONG as never, key());
    await w.svc.approve(prep.operation.id, w.pk.assert(hashOf(prep)));
    w.chain.mine(); await w.svc.step(); w.chain.revertNext = 'next'; w.chain.mine(); await w.svc.step();
    const f = (await w.svc.operation(prep.operation.id)).operation;
    expect(f).toMatchObject({ state: 'failed', final: true }); expect(f.error).toMatch(/reverted on-chain: no order was created.*approval of the Router stays in place/);
    expect(await sql`select state from proposals where id = ${f.proposalId}`).toEqual([{ state: 'failed' }]);
    w.chain.allowance = 0n;
    const b = await w.svc.prepareOrder(LONG as never, key());
    await w.svc.approve(b.operation.id, w.pk.assert(hashOf(b))); w.chain.mine(); await w.svc.step();
    w.chain.pending.splice(0); // the order transaction is dropped by the network
    w.clock.advance(16 * 60_000); await w.svc.step();
    const u = (await w.svc.operation(b.operation.id)).operation;
    expect(u).toMatchObject({ state: 'unknown', final: false, orderKey: null }); expect(u.error).toMatch(/no receipt was found/);
    await w.chain.broadcast(w.chain.broadcasts[w.chain.broadcasts.length - 1]!); w.chain.mine(); await w.svc.step(); // it lands after all
    expect((await w.svc.operation(b.operation.id)).operation).toMatchObject({ state: 'created', error: null });
  });
  it('the simulation right before sending refuses a transaction that would revert', async () => {
    const w = await world(), prep = await w.svc.prepareOrder(LONG as never, key());
    await w.svc.approve(prep.operation.id, w.pk.assert(hashOf(prep)));
    w.chain.mine(); w.chain.simulateError = 'execution reverted: InsufficientExecutionFee'; await w.svc.step();
    const op = (await w.svc.operation(prep.operation.id)).operation;
    expect(op.state).toBe('failed'); expect(op.error).toMatch(/would revert now \(execution reverted: InsufficientExecutionFee\); it was not sent/);
    expect(w.chain.broadcasts).toHaveLength(1);
  });
  it('restart: a new engine instance on the same database continues every operation where it was', async () => {
    const w = await world(), prep = await w.svc.prepareOrder(LONG as never, key());
    await w.svc.approve(prep.operation.id, w.pk.assert(hashOf(prep)));
    const again = new ex.GmxService(w.svc.deps); // the process restarted between the signature and the approval's receipt
    w.chain.mine(); await again.step();
    expect((await again.operation(prep.operation.id)).operation.state).toBe('sent');
    const [k] = w.chain.mine(); const third = new ex.GmxService(w.svc.deps); await third.step();
    expect((await third.operation(prep.operation.id)).operation).toMatchObject({ state: 'created', orderKey: k });
    w.chain.keeper(k!, 'execute'); await new ex.GmxService(w.svc.deps).step();
    expect((await third.operation(prep.operation.id)).operation.state).toBe('executed');
  });
});

describe('closing a position', () => {
  it('a MarketDecrease of the on-chain size: no token leaves the wallet, no approval; executed → the collateral is back', async () => {
    const w = await world(), { key: k } = await place(w);
    w.chain.keeper(k, 'execute'); await w.svc.step();
    const prep = await w.svc.prepareClose({ market: ETH.market, side: 'long', fraction: '1', slippageBps: 50 }, key());
    expect(prep.operation).toMatchObject({ kind: 'decrease', sizeUsd: '60', collateral: null, needsApproval: false });
    expect(prep.intent).toMatchObject({ amount: '0', asset: USDC, gmx: { action: 'decrease', orderType: 'MarketDecrease', sizeDeltaUsd: gmxUsdToRaw('60').toString(), approveGas: '0' } });
    expect(Number(prep.operation.acceptablePrice)).toBeLessThan(Number(w.mid)); // a long closes at the oracle min; worst price below
    const [row] = await sql`select asset, amount::text from proposals where id = ${prep.operation.proposalId}`;
    expect(row.asset).toBe('native'); expect(BigInt(row.amount)).toBe(BigInt(prep.intent.maxFee)); // the record shows the native coin that may leave: fees only
    const before = w.chain.usdc;
    await w.svc.approve(prep.operation.id, w.pk.assert(hashOf(prep)));
    const [k2] = w.chain.mine(); await w.svc.step();
    expect(w.chain.usdc).toBe(before);
    expect((await w.svc.operation(prep.operation.id)).operation).toMatchObject({ state: 'created', orderKey: k2 });
    w.chain.keeper(k2!, 'execute'); await w.svc.step();
    const op = (await w.svc.operation(prep.operation.id)).operation;
    expect(op).toMatchObject({ state: 'executed', outcome: { event: 'OrderExecuted', pnlUsd: '0', priceImpactUsd: '-0.014', collateralOut: '19.946' } });
    const s = await w.svc.status();
    expect(s.positions).toEqual([]); expect(s.wallet!.usdc).toBe('99.946'); expect(s.authorization!.today).toEqual({ increases: 1, reduces: 1 });
    const half = await refusal(w.svc.prepareClose({ market: ETH.market, side: 'long', fraction: '0.5', slippageBps: 50 }, key()));
    expect(half.code).toBe('no_position');
  });
});

describe('the derivatives router and GMX', () => {
  it('says the wallet can open a pinned GMX market when the engine is tradable, with the wallet USDC as collateral — and only reads GMX otherwise', async () => {
    const clock = new Clock(), v = fixtureVenues(clock);
    const chain = { read: async (eth: { value: string; source: string } | null) => ({ gasPriceEth: '0.00000000002', ethUsd: eth?.value ?? null, ethUsdSource: eth?.source ?? 'none', gmxExecutionFeeEth: '0.00008', gmxExecutionFeeNote: 'fixture', ts: clock.now() }) };
    const state = { tradable: true, usdc: '100' as string | null };
    const d = dv.createDerivatives({ registry: dv.createRegistry(v.adapters, clock.now), now: clock.now, chain, gmx: { tradability: async () => ({ ...state }) } });
    const ask = async () => (await d.router!.route({ base: 'BTC', side: 'long', notionalUsd: '60', leverage: '3', type: 'market', reduceOnly: false })).candidates.filter((c) => c.venue === 'gmx');
    const codes = (c: Awaited<ReturnType<typeof ask>>[number]) => c.eligibility.reasons.map((r) => r.code);
    let c = await ask();
    const pinned = c.find((x) => x.instrument === BTC.instrument)!, other = c.find((x) => x.instrument !== BTC.instrument)!;
    expect(pinned.eligibility).toMatchObject({ executableNow: true, executableAs: 'live' });
    expect(codes(pinned)).not.toContain('wallet_cannot_trade_here'); expect(codes(pinned)).not.toContain('no_collateral_account');
    expect(other.eligibility.executableNow).toBe(false); // another BTC pool of GMX: not in the pinned table
    state.usdc = '5'; clock.advance(11_000);
    c = await ask();
    expect(codes(c.find((x) => x.instrument === BTC.instrument)!)).toContain('insufficient_collateral_there');
    state.tradable = false; clock.advance(11_000);
    c = await ask();
    expect(c.find((x) => x.instrument === BTC.instrument)!.eligibility.executableNow).toBe(false);
    expect(codes(c.find((x) => x.instrument === BTC.instrument)!)).toContain('wallet_cannot_trade_here');
  });
});

describe('routes', () => {
  it('shapes, idempotency header, errors as codes', async () => {
    const w = await world();
    const get = async (url: string) => { const r = await w.app.inject({ method: 'GET', url }); return { status: r.statusCode, body: r.json() }; };
    const post = async (url: string, payload: unknown, headers: Record<string, string> = {}) => { const r = await w.app.inject({ method: 'POST', url, payload: payload as never, headers }); return { status: r.statusCode, body: r.json() }; };
    const st = await get('/api/v1/derivatives/gmx/status?locale=fr');
    expect(st.status).toBe(200); expect(st.body).toMatchObject({ venue: 'gmx', network: 'arbitrum', chainId: 42161, tradable: true, settings: { liveMainnet: true, gmxLive: true }, positionsSource: 'chain', facts: { requestExpirationSec: 300, twoStep: true } });
    expect((await get('/api/v1/derivatives/gmx/jurisdiction')).body.fr.text).toMatch(/GMX v2/);
    expect((await post('/api/v1/derivatives/gmx/orders/preview', LONG)).body.estimate.source).toBe('estimate');
    expect((await post('/api/v1/derivatives/gmx/orders', LONG)).status).toBe(400);
    expect((await post('/api/v1/derivatives/gmx/orders/preview', { ...LONG, receiver: ME })).status).toBe(400); // strict body: no field for a receiver
    const made = await post('/api/v1/derivatives/gmx/orders', LONG, { 'idempotency-key': key() });
    expect(made.status).toBe(200); expect(made.body.operation.state).toBe('pending_approval');
    const ok = await post(`/api/v1/derivatives/gmx/operations/${made.body.operation.id}/approve`, { assertion: w.pk.assert(Buffer.from(made.body.operation.hash, 'hex')) });
    expect(ok.status).toBe(200); expect(ok.body.operation.state).toBe('signed');
    expect((await post(`/api/v1/derivatives/gmx/orders/${made.body.operation.id}/cancel`, {})).status).toBe(409);
    expect((await get(`/api/v1/derivatives/gmx/operations/${made.body.operation.id}`)).body.operation.id).toBe(made.body.operation.id);
    expect((await post('/api/v1/derivatives/gmx/authorization/revoke', {})).body.tradable).toBe(false);
  });
});

// =========================================================================================================================
// V11 Phase B

describe('V11 B-01 / B-02: the server settings and the signer\'s halt stop new positions, never the way out', () => {
  it('with both settings off AND the emergency halt on: a pending order is cancelled and a position closed, with the passkey; an increase is refused at every step', async () => {
    const w = await world(), first = await place(w);
    w.chain.keeper(first.key, 'execute'); await w.svc.step();                                   // a long ETH position exists on-chain
    const second = await place(w, { ...LONG, collateral: '10' });                               // and a second order is pending (no keeper yet)
    expect(second.op.state).toBe('created');
    w.settings.gmxLive = false; w.settings.liveMainnet = false; w.signer.halt();                // everything that can be switched off is off
    const s = await w.svc.status();
    expect(s.tradable).toBe(false);
    expect(s.blockers).toEqual(expect.arrayContaining(['gmx_setting_off', 'mainnet_setting_off', 'signer_halted']));
    expect(s.blockerText.signer_halted).toMatch(/Closing a position and cancelling a pending order stay possible/);
    // new risk: refused, nothing stored, nothing signed
    const sent = w.chain.broadcasts.length, journal = w.store.state.journal.length;
    expect(await refusal(w.svc.prepareOrder(LONG as never, key()))).toMatchObject({ code: 'gmx_disabled', status: 403 });
    w.settings.gmxLive = true;
    expect(await refusal(w.svc.prepareOrder(LONG as never, key()))).toMatchObject({ code: 'mainnet_disabled', status: 403 });
    w.settings.liveMainnet = true;
    expect(await refusal(w.svc.prepareOrder(LONG as never, key()))).toMatchObject({ code: 'halted', status: 423 });
    expect(await refusal(w.svc.prepareAuthorization({ allowedMarkets: [ETH.market], maxLeverage: 3, maxOrderSizeUsd: '100', maxOrdersPerDay: 5, maxPriceDeviationBps: 100, days: 7, locale: 'fr' }))).toMatchObject({ code: 'halted' });
    w.settings.gmxLive = false; w.settings.liveMainnet = false;
    expect(w.chain.broadcasts.length).toBe(sent); expect(w.store.state.journal.length).toBe(journal);
    // the pending order: cancelled
    w.clock.advance(301_000);
    const c = await w.svc.prepareCancel(second.op.id);
    await w.svc.approve(c.operation.id, w.pk.assert(hashOf(c)));
    expect(decodeGmxCalldata(parseTransaction(w.chain.broadcasts.at(-1) as Hex).data!)).toMatchObject({ fn: 'cancelOrder' });
    w.chain.mine(); await w.svc.step();
    expect((await w.svc.operation(second.op.id)).operation).toMatchObject({ state: 'cancelled', final: true, outcome: { cancelledBy: 'owner', collateralReturned: true } });
    // the position: closed
    const close = await w.svc.prepareClose({ market: ETH.market, side: 'long', fraction: '1', slippageBps: 50 }, key());
    expect(close.intent).toMatchObject({ amount: '0', gmx: { action: 'decrease', orderType: 'MarketDecrease' } });
    expect(await refusal(w.svc.approve(close.operation.id, w.pk.assert(new Uint8Array(32))))).toMatchObject({ code: 'bad_approval' });   // still the passkey, judged by the signer
    const again = await w.svc.prepareClose({ market: ETH.market, side: 'long', fraction: '1', slippageBps: 50 }, key());
    await w.svc.approve(again.operation.id, w.pk.assert(hashOf(again)));
    const [k2] = w.chain.mine(); await w.svc.step();
    w.chain.keeper(k2!, 'execute'); await w.svc.step();
    expect((await w.svc.operation(again.operation.id)).operation).toMatchObject({ state: 'executed', final: true });
    expect((await w.svc.status()).positions).toEqual([]);
    expect(w.store.state.journal.filter((j) => j.type === 'gmx.sign.ok').slice(-2).map((j) => j.data.action)).toEqual(['cancel', 'decrease']);
  });
});

describe('V11 B-10: real loss limits and a kill switch for GMX (new risk only)', () => {
  it('the limits are derived from the authorization (5 % / 20 % of the allowed gross exposure), counted on the wallet\'s executed orders, and stop an increase — never a close', async () => {
    const w = await world(), a = await place(w);
    w.chain.keeper(a.key, 'execute'); await w.svc.step();
    const s0 = await w.svc.status();
    expect(s0.risk).toMatchObject({ halt: null, maxDailyLoss: '15', maxTotalLoss: '60', defaults: { maxDailyLoss: '15', maxTotalLoss: '60' }, realizedToday: expect.any(String) });
    expect(ex.gmxDefaultLimits({ maxOrderSizeUsd: '100' })).toEqual({ maxDailyLoss: '15', maxTotalLoss: '60' });          // the fractions of a Hyperliquid account
    expect((await w.svc.preview({ ...LONG, collateral: '10' } as never)).risk).toEqual({ ok: true });                     // before V11 the limits were 1e9: nothing could ever trip
    // a realised loss of 16 USD today (as the keeper's events would report it on an executed order of this wallet)
    await sql`update deriv_gmx_ops set outcome = outcome || '{"pnlUsd":"-15.9","positionFeeUsd":"0.1"}'::jsonb where id = ${a.op.id}`;
    expect((await w.svc.status()).risk).toMatchObject({ realizedToday: '-16', realizedTotal: '-16' });
    const r = await refusal(w.svc.prepareOrder({ ...LONG, collateral: '10' } as never, key()));
    expect(r).toMatchObject({ code: 'risk_daily_loss_exceeded', status: 422 });
    expect(r.message).toMatch(/limit −15/);
    expect((await w.svc.preview({ ...LONG, collateral: '10' } as never)).risk).toMatchObject({ ok: false, code: 'daily_loss_exceeded' });
    // closing is never refused by a loss limit
    const close = await w.svc.prepareClose({ market: ETH.market, side: 'long', fraction: '1', slippageBps: 50 }, key());
    expect(close.operation).toMatchObject({ kind: 'decrease', state: 'pending_approval' });
    await w.svc.withdraw(close.operation.id);
    // the total limit, with a small loss today
    await sql`update deriv_gmx_ops set outcome = outcome || '{"pnlUsd":"-70"}'::jsonb, done_at = done_at - interval '2 days' where id = ${a.op.id}`;
    expect((await w.svc.status()).risk).toMatchObject({ realizedToday: '0', realizedTotal: '-70.1' });
    expect(await refusal(w.svc.prepareOrder({ ...LONG, collateral: '10' } as never, key()))).toMatchObject({ code: 'risk_total_loss_exceeded' });
  });

  it('tightening is free, raising a limit needs the passkey over the canonical intent — once', async () => {
    const w = await world();
    expect((await w.svc.setLimits({ maxDailyLoss: '5', maxTotalLoss: '20' })).risk).toMatchObject({ maxDailyLoss: '5', maxTotalLoss: '20' });
    expect(await w.svc.prepareRisk('gmx-limits', { maxDailyLoss: '4', maxTotalLoss: '20' })).toMatchObject({ needed: false });
    for (const up of [{ maxDailyLoss: '5.01', maxTotalLoss: '20' }, { maxDailyLoss: '5', maxTotalLoss: '1000000000' }])
      expect(await refusal(w.svc.setLimits(up))).toMatchObject({ code: 'passkey_required', status: 403 });
    expect((await w.svc.status()).risk).toMatchObject({ maxDailyLoss: '5', maxTotalLoss: '20' });
    const prep = await w.svc.prepareRisk('gmx-limits', { maxDailyLoss: '12', maxTotalLoss: '50' });
    expect(prep).toMatchObject({ needed: true, loosened: ['maxDailyLoss', 'maxTotalLoss'], intent: { kind: 'gmx-limits', limits: { maxDailyLoss: '12', maxTotalLoss: '50' } } });
    expect(prep.hash).toBe(Buffer.from(ex.gmxRiskIntentHash(prep.intent!)).toString('hex'));
    expect(await refusal(w.svc.approveRisk('gmx-limits', undefined))).toMatchObject({ code: 'passkey_required' });
    expect(await refusal(w.svc.approveRisk('gmx-limits', w.pk.assert(new Uint8Array(32))))).toMatchObject({ code: 'bad_approval', status: 403 });
    expect(await refusal(w.svc.approveRisk('gmx-limits', new TestPasskey(RP, ORIGIN).assert(Buffer.from(prep.hash!, 'hex'))))).toMatchObject({ code: 'bad_approval' });
    expect(await refusal(w.svc.approveRisk('gmx-limits', w.pk.assert(ex.gmxRiskIntentHash({ ...prep.intent!, limits: { maxDailyLoss: '1000000000', maxTotalLoss: '1000000000' } }))))).toMatchObject({ code: 'bad_approval' });
    expect((await w.svc.status()).risk).toMatchObject({ maxDailyLoss: '5' });
    const ok = w.pk.assert(Buffer.from(prep.hash!, 'hex'));
    expect((await w.svc.approveRisk('gmx-limits', ok)).risk).toMatchObject({ maxDailyLoss: '12', maxTotalLoss: '50' });
    expect(await refusal(w.svc.approveRisk('gmx-limits', ok))).toMatchObject({ code: 'bad_state' });                        // single use
    const late = await w.svc.prepareRisk('gmx-limits', { maxDailyLoss: '13', maxTotalLoss: '50' });
    w.clock.advance(300_001);
    expect(await refusal(w.svc.approveRisk('gmx-limits', w.pk.assert(Buffer.from(late.hash!, 'hex'))))).toMatchObject({ code: 'expired', status: 410 });
    // a new authorization — approved with the passkey — starts from the defaults again
    await w.svc.revoke();
    await authorize(w, { maxOrderSizeUsd: '50' });
    expect((await w.svc.status()).risk).toMatchObject({ halt: null, maxDailyLoss: '7.5', maxTotalLoss: '30' });
  });

  it('kill switch: halting is free and stops increases only; lifting it needs the passkey', async () => {
    const w = await world(), a = await place(w);
    w.chain.keeper(a.key, 'execute'); await w.svc.step();
    const pending = await w.svc.prepareOrder({ ...LONG, collateral: '10' } as never, key());                               // an increase under review
    const h = await w.svc.halt({ reason: 'test' });
    expect(h.risk!.halt).toMatch(/^halted by the owner: test/);
    expect(h.blockers).toContain('gmx_halted'); expect(h.tradable).toBe(false);
    expect((await w.svc.operation(pending.operation.id)).operation).toMatchObject({ state: 'withdrawn', final: true });   // it ends with the halt
    expect(await refusal(w.svc.prepareOrder({ ...LONG, collateral: '10' } as never, key()))).toMatchObject({ code: 'risk_halted', status: 422 });
    expect((await w.svc.preview({ ...LONG, collateral: '10' } as never)).blockers).toContain('gmx_halted');
    // the way out
    const close = await w.svc.prepareClose({ market: ETH.market, side: 'long', fraction: '1', slippageBps: 50 }, key());
    await w.svc.approve(close.operation.id, w.pk.assert(hashOf(close)));
    const [k2] = w.chain.mine(); await w.svc.step(); w.chain.keeper(k2!, 'execute'); await w.svc.step();
    expect((await w.svc.status()).positions).toEqual([]);
    // lifting
    expect(await refusal(w.svc.approveRisk('gmx-resume', undefined))).toMatchObject({ code: 'passkey_required' });
    const prep = await w.svc.prepareRisk('gmx-resume');
    expect(prep).toMatchObject({ needed: true, intent: { kind: 'gmx-resume', limits: null, subject: h.risk!.halt } });
    expect(await refusal(w.svc.approveRisk('gmx-resume', w.pk.assert(new Uint8Array(32))))).toMatchObject({ code: 'bad_approval' });
    await w.svc.halt({ reason: 'again' });                                                                                 // replaced meanwhile: the first approval does not lift the second
    expect(await refusal(w.svc.approveRisk('gmx-resume', w.pk.assert(Buffer.from(prep.hash!, 'hex'))))).toMatchObject({ code: 'bad_state' });
    const p2 = await w.svc.prepareRisk('gmx-resume');
    const s = await w.svc.approveRisk('gmx-resume', w.pk.assert(Buffer.from(p2.hash!, 'hex')));
    expect(s.risk!.halt).toBeNull(); expect(s.blockers).not.toContain('gmx_halted');
    expect(await w.svc.prepareRisk('gmx-resume')).toMatchObject({ needed: false });
    // without a verifier the server refuses rather than waves through
    const bare = new ex.GmxService({ ...w.svc.deps, verifyOwner: undefined });
    await bare.halt({ reason: 'bare' });
    expect(await refusal(bare.prepareRisk('gmx-resume'))).toMatchObject({ code: 'passkey_unavailable', status: 503 });
    expect(await refusal(bare.approveRisk('gmx-resume', w.pk.assert(new Uint8Array(32))))).toMatchObject({ code: 'passkey_unavailable' });
  });

  it('routes: /halt, /limits (+ prepare / approve), /resume (+ prepare)', async () => {
    const w = await world();
    const post = async (path: string, payload: unknown = {}) => { const r = await w.app.inject({ method: 'POST', url: `/api/v1/derivatives/gmx${path}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) }); return { status: r.statusCode, json: r.json() }; };
    expect((await post('/limits', { maxDailyLoss: '5', maxTotalLoss: '20' })).json.risk).toMatchObject({ maxDailyLoss: '5' });
    expect(await post('/limits', { maxDailyLoss: '50', maxTotalLoss: '20' })).toMatchObject({ status: 403, json: { error: 'passkey_required' } });
    expect((await post('/limits', { maxDailyLoss: '-1', maxTotalLoss: '20' })).status).toBe(400);
    const lp = await post('/limits/prepare', { maxDailyLoss: '50', maxTotalLoss: '20' });
    expect(lp.json).toMatchObject({ needed: true, loosened: ['maxDailyLoss'] });
    expect((await post('/limits/approve', { assertion: w.pk.assert(Buffer.from(lp.json.hash, 'hex')) })).json.risk).toMatchObject({ maxDailyLoss: '50' });
    expect((await post('/halt', { reason: 'http' })).json.blockers).toContain('gmx_halted');
    expect(await post('/resume')).toMatchObject({ status: 403, json: { error: 'passkey_required' } });
    const rp = await post('/resume/prepare');
    expect((await post('/resume', { assertion: w.pk.assert(Buffer.from(rp.json.hash, 'hex')) })).json.risk.halt).toBeNull();
  });
});
