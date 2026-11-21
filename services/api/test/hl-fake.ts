/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/hl-fake.ts
 * Module           : services
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

// Scripted fake of the Hyperliquid exchange + info endpoints, for the live execution tests. No network.
//
// Built from what was recorded and what is documented:
//  - asset tables and market contexts are the recorded fixtures (packages/derivatives/test/fixtures/hyperliquid/<network>-meta.json,
//    -metaAndAssetCtxs.json); the BTC ticker and book are scripted on top;
//  - like the venue, it RECOVERS THE SIGNER from the signature over its own hash of the payload: an action signed by a key that
//    is neither the account nor one of its approved API wallets is answered "User or API Wallet 0x… does not exist."
//    (recorded: testnet-exchange-proof.json), an account that never deposited "Must deposit before performing actions. User: 0x…";
//  - answer shapes: exchange `{status:"ok",response:{type,data:{statuses:[{resting:{oid}}|{filled:{totalSz,avgPx,oid}}|{error}|"success"]}}}`
//    (exchange-endpoint page), `orderStatus` / `userRole` / `activeAssetData` as read live on testnet on 2026-11-11.
// What the real venue does in cases this fake decides by itself (the status of a partly filled IOC order, the wording of an
// expired action) is NOT verified; see docs/v4/venues/hyperliquid.md, section 13.
import { readFileSync } from 'node:fs';
import { D, type DecStr } from '@spw/derivatives';
import { buildApproveAgent, l1SignPayload, recoverTypedDataSigner } from '../../../packages/derivatives/src/venues/hyperliquid/signing.ts';

type Net = 'mainnet' | 'testnet';
const fixture = (net: Net, name: string): any => JSON.parse(readFileSync(new URL(`../../../packages/derivatives/test/fixtures/hyperliquid/${net}-${name}.json`, import.meta.url), 'utf8')).body;
const dec = (x: DecStr) => D.from(x);
const TAKER = '0.00045';

interface FakeOrder { oid: number; coin: string; side: 'B' | 'A'; limitPx: string; origSz: string; sz: string; cloid: string | null; timestamp: number; status: string; statusTimestamp: number; reduceOnly: boolean; tif: string | null;
  isTrigger: boolean; triggerPx: string; orderType: string }
interface FakeUser { funded: boolean; usdc: DecStr; agents: Map<string, { name: string; validUntil: number | null }>; positions: Map<string, { szi: DecStr; entryPx: DecStr }>; leverage: Map<string, { type: 'cross' | 'isolated'; value: number }>;
  orders: FakeOrder[]; fills: any[]; funding: any[] }
export type ExchangeFault = 'lost_before' | 'lost_after' | 'garbage_after' | 'http502_before' | null;

export class FakeHl {
  readonly net: Net;
  readonly host: string;
  readonly now: () => number;
  meta: any;
  ctxs: any[];
  /** scripted BTC market */
  mark = '70000'; oracle = '70000';
  bids: [string, string][] = [['69995', '1'], ['69990', '2']];
  asks: [string, string][] = [['70005', '1'], ['70010', '2']];
  users = new Map<string, FakeUser>();
  /** what happens to the NEXT exchange request (then back to normal) */
  fault: ExchangeFault = null;
  /** every request received, in order */
  calls: { path: string; type: string; body: any }[] = [];
  private oid = 1000;
  private tid = 5000;

  constructor(net: Net, now: () => number) {
    this.net = net; this.now = now; this.host = net === 'mainnet' ? 'api.hyperliquid.xyz' : 'api.hyperliquid-testnet.xyz';
    this.meta = structuredClone(fixture(net, 'meta'));
    this.ctxs = structuredClone(fixture(net, 'metaAndAssetCtxs')[1]);
  }

  user(address: string): FakeUser {
    const a = address.toLowerCase();
    let u = this.users.get(a);
    if (!u) { u = { funded: false, usdc: '0', agents: new Map(), positions: new Map(), leverage: new Map(), orders: [], fills: [], funding: [] }; this.users.set(a, u); }
    return u;
  }
  /** the account deposited: the venue now knows it */
  fund(address: string, usdc: DecStr): void { const u = this.user(address); u.funded = true; u.usdc = usdc; }
  exchangeCalls(type?: string): number { return this.calls.filter((c) => c.path === '/exchange' && (!type || c.type === type)).length; }
  setMid(mid: number): void { this.mark = String(mid); this.oracle = String(mid); this.bids = [[String(mid - 5), '1'], [String(mid - 10), '2']]; this.asks = [[String(mid + 5), '1'], [String(mid + 10), '2']]; }
  /** an order placed from somewhere else than the wallet (the venue's own interface, another API wallet) */
  foreignOrder(address: string, o: { coin?: string; side?: 'B' | 'A'; px: string; sz: string }): number {
    const oid = ++this.oid;
    this.user(address).orders.push({ oid, coin: o.coin ?? 'BTC', side: o.side ?? 'B', limitPx: o.px, origSz: o.sz, sz: o.sz, cloid: null, timestamp: this.now(), status: 'open', statusTimestamp: this.now(), reduceOnly: false, tif: 'Gtc',
      isTrigger: false, triggerPx: '0.0', orderType: 'Limit' });
    return oid;
  }
  removeOrder(address: string, oid: number): void { const u = this.user(address); u.orders = u.orders.filter((o) => o.oid !== oid); }
  /** the position changed without the wallet (liquidation, a trade from another interface) */
  forcePosition(address: string, coin: string, szi: DecStr, entryPx: DecStr = this.mark): void {
    const u = this.user(address);
    if (D.isZero(dec(szi))) u.positions.delete(coin); else u.positions.set(coin, { szi, entryPx });
  }
  ethMark(): string { return D.str(D.quantize(dec(this.ctxOf('ETH').markPx), dec('0.1'), 'down')); }
  openOrders(address: string): FakeOrder[] { return this.user(address).orders.filter((o) => o.status === 'open'); }

  private assetIndex(coin: string): number { return this.meta.universe.findIndex((u: any) => u.name === coin); }
  private coinOf(asset: number): string | null { return this.meta.universe[asset]?.name ?? null; }
  private ctxOf(coin: string): any {
    const c = this.ctxs[this.assetIndex(coin)];
    return coin === 'BTC' ? { ...c, markPx: this.mark, oraclePx: this.oracle, midPx: D.str(D.div(D.add(dec(this.bids[0]![0]), dec(this.asks[0]![0])), dec('2'), 1, 'down')) } : c;
  }
  private levOf(u: FakeUser, coin: string) { return u.leverage.get(coin) ?? { type: 'cross' as const, value: 20 }; }
  private owner(signer: string): { address: string; user: FakeUser } | null {
    const direct = this.users.get(signer);
    if (direct?.funded) return { address: signer, user: direct };
    for (const [address, user] of this.users) {
      const ag = user.agents.get(signer);
      if (user.funded && ag && (ag.validUntil === null || ag.validUntil > this.now())) return { address, user };
    }
    return null;
  }

  // ------------------------------------------------------------------ info

  private info(b: any): unknown {
    const t = this.now();
    switch (b.type) {
      case 'meta': return this.meta;
      case 'metaAndAssetCtxs': return [this.meta, this.meta.universe.map((u: any) => this.ctxOf(u.name))];
      case 'l2Book': {
        const lv = (rows: [string, string][]) => rows.map(([px, sz]) => ({ px, sz, n: 1 }));
        if (b.coin === 'BTC') return { coin: 'BTC', time: t, levels: [lv(this.bids), lv(this.asks)] };
        // any other coin: one level each side of its recorded mark (nothing is ever matched against it)
        const mark = dec(this.ctxOf(b.coin).markPx), one = D.quantize(D.div(mark, dec('1000'), 6, 'down'), dec('0.1'), 'up');
        return { coin: b.coin, time: t, levels: [lv([[D.str(D.quantize(D.sub(mark, one), dec('0.1'), 'down')), '1']]), lv([[D.str(D.quantize(D.add(mark, one), dec('0.1'), 'up')), '1']])] };
      }
      case 'clearinghouseState': {
        const u = this.user(b.user);
        let upnl = D.zero, used = D.zero, ntl = D.zero;
        const assetPositions = [...u.positions].map(([coin, p]) => {
          const mark = dec(this.ctxOf(coin).markPx), szi = dec(p.szi), lev = this.levOf(u, coin);
          const value = D.mul(D.abs(szi), mark), pnl = D.mul(szi, D.sub(mark, dec(p.entryPx))), margin = D.div(value, dec(String(lev.value)), 6, 'up');
          upnl = D.add(upnl, pnl); used = D.add(used, margin); ntl = D.add(ntl, value);
          return { type: 'oneWay', position: { coin, szi: p.szi, leverage: lev, entryPx: p.entryPx, positionValue: D.str(value), unrealizedPnl: D.str(pnl), returnOnEquity: '0.0', liquidationPx: null, marginUsed: D.str(margin),
            maxLeverage: 40, cumFunding: { allTime: '0.0', sinceOpen: '0.0', sinceChange: '0.0' } } };
        });
        const value = D.add(dec(u.usdc), upnl), summary = { accountValue: D.str(value), totalNtlPos: D.str(ntl), totalRawUsd: u.usdc, totalMarginUsed: D.str(used) };
        const free = D.sub(value, used);
        return { marginSummary: summary, crossMarginSummary: summary, crossMaintenanceMarginUsed: D.str(D.div(used, dec('2'), 6, 'up')), withdrawable: D.isNeg(free) ? '0.0' : D.str(free), assetPositions, time: t };
      }
      case 'frontendOpenOrders': return this.openOrders(b.user).map((o) => this.wireOrder(o));
      case 'userFills': return [...this.user(b.user).fills].reverse();
      case 'userFillsByTime': return this.user(b.user).fills.filter((f) => f.time >= b.startTime);
      case 'userFunding': return this.user(b.user).funding.filter((f) => f.time >= b.startTime);
      case 'orderStatus': {
        const o = this.user(b.user).orders.find((x) => (typeof b.oid === 'number' ? x.oid === b.oid : x.cloid === b.oid));
        return o ? { status: 'order', order: { order: this.wireOrder(o), status: o.status, statusTimestamp: o.statusTimestamp } } : { status: 'unknownOid' };
      }
      case 'userRole': {
        const a = String(b.user).toLowerCase();
        for (const [address, user] of this.users) if (user.agents.has(a)) return { role: 'agent', data: { user: address } };
        return this.users.get(a)?.funded ? { role: 'user' } : { role: 'missing' };
      }
      case 'activeAssetData': { const u = this.user(b.user); return { user: b.user, coin: b.coin, leverage: this.levOf(u, b.coin), maxTradeSzs: ['0.0', '0.0'], availableToTrade: ['0.0', '0.0'], markPx: this.ctxOf(b.coin).markPx }; }
      default: throw new Error(`fake: no info answer for ${b.type}`);
    }
  }
  private wireOrder(o: FakeOrder) {
    return { coin: o.coin, side: o.side, limitPx: o.limitPx, sz: o.sz, oid: o.oid, timestamp: o.timestamp, triggerCondition: 'N/A', isTrigger: o.isTrigger, triggerPx: o.triggerPx, children: [], isPositionTpsl: false,
      reduceOnly: o.reduceOnly, orderType: o.orderType, origSz: o.origSz, tif: o.tif, cloid: o.cloid };
  }

  // ------------------------------------------------------------------ exchange

  private fill(u: FakeUser, o: FakeOrder, px: DecStr, sz: DecStr): void {
    const signed = o.side === 'B' ? dec(sz) : D.neg(dec(sz)), cur = u.positions.get(o.coin), before = cur ? dec(cur.szi) : D.zero, after = D.add(before, signed);
    let closedPnl = D.zero, entry = cur ? dec(cur.entryPx) : dec(px);
    const reducing = !D.isZero(before) && D.sign(before) !== D.sign(signed);
    if (reducing) {
      const closed = D.min(D.abs(before), dec(sz));
      closedPnl = D.mul(D.mul(closed, D.sub(dec(px), entry)), D.isPos(before) ? D.one : D.neg(D.one));
      if (D.sign(after) !== D.sign(before) && !D.isZero(after)) entry = dec(px);
    } else entry = D.isZero(before) ? dec(px) : D.div(D.add(D.mul(D.abs(before), entry), D.mul(dec(sz), dec(px))), D.abs(after), 6, 'half_even');
    if (D.isZero(after)) u.positions.delete(o.coin); else u.positions.set(o.coin, { szi: D.str(after), entryPx: D.str(entry) });
    const fee = D.div(D.mul(D.mul(dec(sz), dec(px)), dec(TAKER)), D.one, 6, 'up');
    u.usdc = D.str(D.sub(D.add(dec(u.usdc), closedPnl), fee));
    const tid = ++this.tid;
    u.fills.push({ coin: o.coin, px, sz, side: o.side, time: this.now(), startPosition: D.str(before), dir: reducing ? 'Close' : 'Open', closedPnl: D.str(closedPnl), hash: `0x${tid.toString(16).padStart(64, '0')}`, oid: o.oid, crossed: true,
      fee: D.str(fee), tid, cloid: o.cloid, feeToken: 'USDC', twapId: null });
    o.sz = D.str(D.sub(dec(o.sz), dec(sz)));
  }

  private place(u: FakeUser, w: any): unknown {
    const coin = this.coinOf(w.a);
    if (coin !== 'BTC') return { error: `fake: only BTC has a book (asset ${w.a})` };
    if (!w.r && D.lt(D.mul(dec(w.p), dec(w.s)), dec('10'))) return { error: 'Order must have minimum value of $10.' };
    if (w.c && u.orders.some((o) => o.cloid === w.c)) return { error: 'fake: duplicate cloid' };
    const t = this.now(), buy = w.b === true, trigger = 'trigger' in w.t, tif = trigger ? null : w.t.limit.tif;
    const o: FakeOrder = { oid: ++this.oid, coin, side: buy ? 'B' : 'A', limitPx: w.p, origSz: w.s, sz: w.s, cloid: w.c ?? null, timestamp: t, status: 'open', statusTimestamp: t, reduceOnly: w.r, tif,
      isTrigger: trigger, triggerPx: trigger ? w.t.trigger.triggerPx : '0.0', orderType: trigger ? (w.t.trigger.tpsl === 'sl' ? (w.t.trigger.isMarket ? 'Stop Market' : 'Stop Limit') : w.t.trigger.isMarket ? 'Take Profit Market' : 'Take Profit Limit') : 'Limit' };
    if (trigger) { u.orders.push(o); return 'waitingForTrigger'; }
    const book = buy ? this.asks : this.bids, crosses = (px: string) => (buy ? D.lte(dec(px), dec(w.p)) : D.gte(dec(px), dec(w.p)));
    if (tif === 'Alo') {
      if (book[0] && crosses(book[0][0])) return { error: `Post only order would have immediately matched, bbo was ${this.bids[0]![0]}@${this.asks[0]![0]}.` };
      u.orders.push(o); return { resting: { oid: o.oid, ...(o.cloid ? { cloid: o.cloid } : {}) } };
    }
    let cost = D.zero, got = D.zero;
    for (const level of book) {
      if (!crosses(level[0]) || D.isZero(dec(o.sz))) break;
      const take = D.min(dec(o.sz), dec(level[1]));
      if (D.isZero(take)) continue;
      this.fill(u, o, level[0], D.str(take));
      level[1] = D.str(D.sub(dec(level[1]), take));
      cost = D.add(cost, D.mul(take, dec(level[0]))); got = D.add(got, take);
    }
    if (D.isZero(got)) {
      if (tif === 'Ioc') return { error: `Order could not immediately match against any resting orders. asset=${w.a}` };
      u.orders.push(o); return { resting: { oid: o.oid, ...(o.cloid ? { cloid: o.cloid } : {}) } };
    }
    u.orders.push(o);
    const whole = D.isZero(dec(o.sz));
    if (whole) o.status = 'filled'; else if (tif === 'Ioc') o.status = 'canceled';
    o.statusTimestamp = t;
    if (!whole && tif === 'Gtc') return { resting: { oid: o.oid, ...(o.cloid ? { cloid: o.cloid } : {}) } };
    return { filled: { totalSz: D.str(got), avgPx: D.str(D.div(cost, got, 6, 'half_even')), oid: o.oid, ...(o.cloid ? { cloid: o.cloid } : {}) } };
  }

  private async exchange(b: any): Promise<unknown> {
    const a = b.action, err = (response: string) => ({ status: 'err', response });
    if (a.type === 'approveAgent') {
      const td = buildApproveAgent({ network: this.net, agentAddress: a.agentAddress, agentName: a.agentName ?? null, nonce: a.nonce, signatureChainId: a.signatureChainId }).typedData;
      const signer = await recoverTypedDataSigner(td, b.signature), u = this.users.get(signer);
      if (!u?.funded) return err(`Must deposit before performing actions. User: ${signer}`);
      const m = /^(.*?)(?: valid_until (\d{13}))?$/.exec(a.agentName ?? '')!;
      for (const [addr, ag] of u.agents) if (ag.name === m[1]) u.agents.delete(addr);          // same name: the previous API wallet is replaced
      u.agents.set(a.agentAddress, { name: m[1]!, validUntil: m[2] ? Number(m[2]) : null });
      return { status: 'ok', response: { type: 'default' } };
    }
    const td = l1SignPayload(a, { network: this.net, nonce: b.nonce, vaultAddress: b.vaultAddress ?? null, expiresAfter: b.expiresAfter ?? null }).typedData;
    const signer = await recoverTypedDataSigner(td, b.signature), own = this.owner(signer);
    if (!own) return err(`User or API Wallet ${signer} does not exist.`);
    const u = own.user;
    if (a.type === 'order') return { status: 'ok', response: { type: 'order', data: { statuses: a.orders.map((w: any) => this.place(u, w)) } } };
    if (a.type === 'cancel' || a.type === 'cancelByCloid') {
      const statuses = a.cancels.map((c: any) => {
        const o = u.orders.find((x) => (a.type === 'cancel' ? x.oid === c.o : x.cloid === c.cloid));
        if (!o || o.status !== 'open') return { error: 'Order was never placed, already canceled, or filled.' };
        o.status = 'canceled'; o.statusTimestamp = this.now();
        return 'success';
      });
      return { status: 'ok', response: { type: 'cancel', data: { statuses } } };
    }
    if (a.type === 'updateLeverage') { u.leverage.set(this.coinOf(a.asset)!, { type: a.isCross ? 'cross' : 'isolated', value: a.leverage }); return { status: 'ok', response: { type: 'default' } }; }
    return err(`fake: unsupported action ${a.type}`);
  }

  /** the injected fetch of one network; any other host is a test failure */
  fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url)), body = JSON.parse(String(init?.body ?? '{}'));
    if (u.host !== this.host) throw new Error(`fake ${this.net}: request to ${u.host}`);
    const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/info') { this.calls.push({ path: '/info', type: body.type, body }); return json(this.info(body)); }
    if (u.pathname !== '/exchange') throw new Error(`fake: unknown path ${u.pathname}`);
    this.calls.push({ path: '/exchange', type: body.action?.type, body });
    const fault = this.fault; this.fault = null;
    const timeout = () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; return e; };
    if (fault === 'lost_before') throw timeout();
    if (fault === 'http502_before') return new Response('bad gateway', { status: 502 });
    const answer = await this.exchange(body);
    if (fault === 'lost_after') throw timeout();
    if (fault === 'garbage_after') return new Response('<html>upstream error</html>', { status: 200 });
    return json(answer);
  }) as unknown as typeof fetch;
}

/** one fetch for both networks: each host goes to its own fake */
export function routeFetch(fakes: FakeHl[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const host = new URL(String(url)).host, f = fakes.find((x) => x.host === host);
    if (!f) throw new Error(`no fake venue for ${host}: the tests must never reach a real endpoint`);
    return f.fetch(url as never, init);
  }) as unknown as typeof fetch;
}
