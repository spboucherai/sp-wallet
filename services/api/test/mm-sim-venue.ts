// A deterministic Hyperliquid look-alike for the market-making engine: it replays a RECORDED tape (top of book and trades of
// the public feed) and answers the two endpoints the engine and the signer talk to — `info` and `exchange` — with the venue's
// own shapes and rules as documented (docs/V11-MARKET-MAKING.md §2):
//
//   exchange   the signature must recover to the account's API wallet; nonce single-use; `expiresAfter` enforced; `order`
//              batches (tick, lot, "minimum value of $10", post-only rejection against the CURRENT book, reduce-only), `cancel`,
//              `cancelByCloid`, `scheduleCancel` (≥ 5 s ahead, fires and cancels everything, 10 triggers per UTC day); the
//              address-based rate limit (10 000 + 1 per USDC traded; a batch of n counts n; cancels have their own allowance)
//   info       frontendOpenOrders, clearinghouseState, activeAssetData, userRateLimit, orderStatus (by oid or cloid),
//              userFillsByTime
//
// FILLS ARE MODELLED, not observed. A resting order of ours was never in the real book, so:
//   - it joins the queue BEHIND the size displayed at its price when it is placed (and never ahead of less than that);
//   - a recorded trade at its price consumes the queue first, then fills it; a trade strictly THROUGH its price fills it whole;
//   - a later book whose opposite best is at or through its price fills it (the market crossed it), at its own price;
//   - cancellations ahead of it move it up only when the displayed size falls below its queue position.
// No latency, no market impact, no priority fees of competitors. It is the conservative rule of the paper engine
// (`mmFills`: only a price trading strictly through the quote) plus an explicit queue for trades AT the quote.
// A TEST DOUBLE OF THE VENUE, not a paper model: the product's ONE paper fill model is `mmFills` (agent-runtime/families.ts),
// behind src/mm/paper-venue.ts. The fills modelled here exist to exercise the LIVE path (real signer code, the live adapter,
// the stream reconcile) deterministically. `onUser` delivers what the venue's user streams would: order updates and fills.
import { D, type DecStr } from '@spw/derivatives';
import { hlFormatPrice, hlFormatSize, l1SignPayload, recoverTypedDataSigner, type HlAsset, type HlNetwork, type MsgpackValue } from '@spw/derivatives/hyperliquid';

export type TapeEvent =
  /** top of book: venue time, best bid, its size, best ask, its size */
  | { t: number; k: 'b'; bid: string; bidSz: string; ask: string; askSz: string }
  /** a public trade: aggressor side ('B' = a buyer lifted the ask), price, size */
  | { t: number; k: 't'; side: 'B' | 'A'; px: string; sz: string };
export interface SimVenueOptions {
  network: HlNetwork; assets: HlAsset[]; coin: string; account: string; agent: string;
  tape: TapeEvent[]; startEquity: DecStr;
  makerFee?: DecStr; takerFee?: DecStr;
  /** cumulative volume the address starts with (USDC): the address rate limit is 10 000 + this + what the session trades */
  startVolume?: number;
  /** address-based requests already consumed, and a position held when the session starts (valued at the first mid, inside `startEquity`) */
  startUsed?: number; startPosition?: DecStr;
  leverage?: number;
}
interface SimOrder { oid: number; cloid: string | null; side: 'B' | 'A'; px: string; sz: string; origSz: string; reduceOnly: boolean; tif: string; timestamp: number; queueAhead: string }
interface SimFill { coin: string; px: string; sz: string; side: 'B' | 'A'; time: number; startPosition: string; dir: string; closedPnl: string; hash: string; oid: number; crossed: boolean; fee: string; tid: number; feeToken: string; cloid?: string }
const d = D.from, s = D.str;

export class SimVenue {
  now: number;
  private i = 0;
  private bid = '0'; private bidSz = '0'; private ask = '0'; private askSz = '0'; private bookTs = 0;
  private orders: SimOrder[] = [];
  private history = new Map<string, { order: SimOrder; status: string; statusTimestamp: number }>();   // by cloid and by `oid:<n>`
  private position = '0'; private cash: string; private entry = '0';
  fills: SimFill[] = [];
  private nonces = new Set<number>();
  private oid = 1000; private tid = 1;
  private scheduled: number | null = null;
  private triggers: Record<string, number> = {};
  private used = 0; private cancelUsed = 0; private volume: number; private lastThrottled = -Infinity;
  /** failure injection */
  down = false;                       // info and exchange unreachable
  infoDown = false;
  /** what the NEXT exchange request does: answer lost after it was applied, lost before, or an unreadable answer */
  failNextExchange: 'lost_after_apply' | 'lost_before_apply' | 'garbage' | null = null;
  readonly log: { t: number; type: string; n: number; result: string }[] = [];
  /** the venue's user streams (orderUpdates, userFills) as the stream client would deliver them; set by a test */
  onUser: ((ev: { type: 'orders'; orders: { instrument: string; venueOrderId: string; clientId: string | null; side: 'buy' | 'sell'; price: string; size: string; remaining: string; status: 'open' | 'filled' | 'cancelled' | 'rejected'; venueStatus: string; createdAt: number; updatedAt: number }[] }
    | { type: 'fills'; snapshot: boolean; fills: { instrument: string; orderId: string; clientId: string | null; side: 'buy' | 'sell'; price: string; size: string; fee: string; feeAsset: string; closedPnl: string; ts: number; id: string; liquidation: boolean }[] }) => void) | null = null;
  /** every info and exchange request the venue saw, with its documented IP weight (packages/derivatives http.ts) */
  readonly requests: { t: number; kind: 'info' | 'exchange'; type: string; weight: number }[] = [];
  private emitOrder(o: SimOrder, status: 'open' | 'filled' | 'cancelled' | 'rejected', venueStatus: string): void {
    this.onUser?.({ type: 'orders', orders: [{ instrument: `hyperliquid:${this.o.coin}`, venueOrderId: String(o.oid), clientId: o.cloid, side: o.side === 'B' ? 'buy' : 'sell', price: o.px, size: o.origSz, remaining: o.sz, status, venueStatus, createdAt: o.timestamp, updatedAt: this.now }] });
  }
  readonly maker: string; readonly taker: string;
  private asset: HlAsset;

  constructor(private o: SimVenueOptions) {
    this.asset = o.assets.find((a) => a.symbol === o.coin) ?? (() => { throw new Error('coin not in the asset table'); })();
    this.cash = o.startEquity; this.volume = o.startVolume ?? 0;
    this.maker = o.makerFee ?? '0.00015'; this.taker = o.takerFee ?? '0.00045';
    this.now = o.tape[0]?.t ?? 0; this.used = o.startUsed ?? 0;
    this.advance(this.now);
    if (o.startPosition && this.bookTs) { this.position = s(d(o.startPosition)); this.cash = s(D.sub(d(o.startEquity), D.mul(d(o.startPosition), d(this.mid())))); }
  }

  // ---- market ---------------------------------------------------------------------------------------------------------------
  top() { return { bid: this.bid, bidSize: this.bidSz, ask: this.ask, askSize: this.askSz, ts: this.bookTs }; }
  mid(): string { return s(D.div(D.add(d(this.bid), d(this.ask)), d('2'), 8, 'half_even')); }
  get done(): boolean { return this.i >= this.o.tape.length; }
  get end(): number { return this.o.tape[this.o.tape.length - 1]?.t ?? this.now; }
  openCount(): number { return this.orders.length; }
  scheduledAt(): number | null { return this.scheduled; }
  triggersToday(): number { return this.triggers[this.day()] ?? 0; }
  accountValue(): string { return s(D.add(d(this.cash), D.mul(d(this.position), d(this.bookTs ? this.mid() : '0')))); }
  positionSize(): string { return this.position; }
  rateLimit() { return { cumVlm: this.volume.toFixed(2), nRequestsUsed: this.used, nRequestsCap: 10_000 + Math.floor(this.volume), nRequestsSurplus: 0 }; }
  private day(): string { return new Date(this.now).toISOString().slice(0, 10); }

  /** replay the tape up to `to` (venue time), firing the dead man's switch when its time comes */
  advance(to: number): void {
    const tape = this.o.tape;
    for (;;) {
      const e = tape[this.i], next = e && e.t <= to ? e.t : Infinity;
      if (this.scheduled !== null && this.scheduled <= Math.min(next, to)) { this.now = Math.max(this.now, this.scheduled); this.fire(); continue; }
      if (!e || e.t > to) break;
      this.now = Math.max(this.now, e.t); this.i += 1;
      if (e.k === 'b') { this.bid = e.bid; this.bidSz = e.bidSz; this.ask = e.ask; this.askSz = e.askSz; this.bookTs = e.t; this.onBook(); } else this.onTrade(e);
    }
    this.now = Math.max(this.now, to);
  }
  /** a SYNTHETIC trade (not from the recording), for tests that need a fill at a chosen moment */
  injectTrade(side: 'B' | 'A', px: string, sz: string): void { this.onTrade({ t: this.now, k: 't', side, px, sz }); }
  private fire(): void {
    this.scheduled = null;
    this.triggers[this.day()] = (this.triggers[this.day()] ?? 0) + 1;
    const n = this.orders.length;
    for (const o of this.orders) this.close(o, 'scheduledCancel');
    this.orders = [];
    this.log.push({ t: this.now, type: 'scheduleCancel.fired', n, result: 'ok' });
  }
  private close(o: SimOrder, status: string): void { if (!o.reduceOnly || status !== 'filled') this.emitOrder(o, status === 'filled' ? 'filled' : /Rejected$|^rejected$/.test(status) ? 'rejected' : 'cancelled', status); const rec = { order: { ...o }, status, statusTimestamp: this.now }; if (o.cloid) this.history.set(o.cloid, rec); this.history.set(`oid:${o.oid}`, rec); }
  private onBook(): void {
    for (const o of [...this.orders]) {
      // the market moved to or through the order: it would have traded
      if (o.side === 'B' ? D.lte(d(this.ask), d(o.px)) : D.gte(d(this.bid), d(o.px))) { this.fill(o, o.sz, o.px, false); continue; }
      // cancellations ahead: the queue position is never larger than what is displayed at the price
      const shown = o.side === 'B' ? (o.px === this.bid ? this.bidSz : null) : (o.px === this.ask ? this.askSz : null);
      if (shown !== null && D.lt(d(shown), d(o.queueAhead))) o.queueAhead = shown;
    }
  }
  private onTrade(e: Extract<TapeEvent, { k: 't' }>): void {
    for (const o of [...this.orders]) {
      // a seller hit bids ('A') can fill our bid; a buyer lifted asks ('B') can fill our ask
      if (o.side === 'B' ? e.side !== 'A' : e.side !== 'B') continue;
      const through = o.side === 'B' ? D.lt(d(e.px), d(o.px)) : D.gt(d(e.px), d(o.px));
      if (through) { this.fill(o, o.sz, o.px, false); continue; }
      if (e.px !== s(d(o.px)) && !D.eq(d(e.px), d(o.px))) continue;
      const left = D.sub(d(e.sz), d(o.queueAhead));
      if (D.lte(left, D.zero)) { o.queueAhead = s(D.sub(d(o.queueAhead), d(e.sz))); continue; }
      o.queueAhead = '0';
      this.fill(o, s(D.min(left, d(o.sz))), o.px, false);
    }
  }
  private fill(o: SimOrder, size: string, px: string, taker: boolean): void {
    const sz = d(size), price = d(px), buy = o.side === 'B', before = d(this.position), fee = D.mul(D.mul(price, sz), d(taker ? this.taker : this.maker));
    const after = buy ? D.add(before, sz) : D.sub(before, sz);
    this.cash = s(D.sub(buy ? D.sub(d(this.cash), D.mul(price, sz)) : D.add(d(this.cash), D.mul(price, sz)), fee));
    this.fills.push({ coin: this.o.coin, px: s(price), sz: s(sz), side: o.side, time: this.now, startPosition: s(before), dir: buy ? 'Open Long' : 'Open Short', closedPnl: '0', hash: `0x${(this.tid).toString(16).padStart(64, '0')}`, oid: o.oid, crossed: taker,
      fee: s(D.div(fee, D.one, 8, 'half_even')), tid: this.tid++, feeToken: 'USDC', ...(o.cloid ? { cloid: o.cloid } : {}) });
    this.position = s(after); this.volume += Number(s(D.mul(price, sz)));
    { const f = this.fills[this.fills.length - 1]!; this.onUser?.({ type: 'fills', snapshot: false, fills: [{ instrument: `hyperliquid:${f.coin}`, orderId: String(f.oid), clientId: f.cloid ?? null, side: f.side === 'B' ? 'buy' : 'sell', price: f.px, size: f.sz, fee: f.fee, feeAsset: 'USDC', closedPnl: '0', ts: f.time, id: `${f.hash}-${f.tid}`, liquidation: false }] }); }
    o.sz = s(D.sub(d(o.sz), sz));
    if (D.isZero(d(o.sz))) { this.orders = this.orders.filter((x) => x !== o); this.close(o, 'filled'); }
    void this.entry;
  }

  // ---- info -----------------------------------------------------------------------------------------------------------------
  async info(body: any): Promise<unknown> {
    if (this.down || this.infoDown) throw new Error('fetch failed');
    this.requests.push({ t: this.now, kind: 'info', type: String(body?.type), weight: ['l2Book', 'allMids', 'clearinghouseState', 'orderStatus', 'spotClearinghouseState', 'exchangeStatus'].includes(String(body?.type)) ? 2 : 20 });
    if (typeof body?.user === 'string' && body.user.toLowerCase() !== this.o.account) throw new Error('HTTP 422');
    const row = (o: SimOrder) => ({ coin: this.o.coin, side: o.side, limitPx: o.px, sz: o.sz, oid: o.oid, timestamp: o.timestamp, origSz: o.origSz, triggerCondition: 'N/A', isTrigger: false, triggerPx: '0.0', children: [], isPositionTpsl: false,
      reduceOnly: o.reduceOnly, orderType: 'Limit', tif: o.tif, cloid: o.cloid });
    switch (body?.type) {
      case 'frontendOpenOrders': return this.orders.map(row);
      case 'clearinghouseState': {
        const pos = d(this.position), value = D.mul(D.abs(pos), d(this.mid()));
        const summary = { accountValue: this.accountValue(), totalNtlPos: s(value), totalRawUsd: this.cash, totalMarginUsed: '0.0' };
        const assetPositions = D.isZero(pos) ? [] : [{ type: 'oneWay', position: { coin: this.o.coin, szi: this.position, entryPx: this.mid(), positionValue: s(value), unrealizedPnl: '0.0', liquidationPx: null, marginUsed: '0.0',
          leverage: { type: 'cross', value: this.o.leverage ?? 3 }, cumFunding: { allTime: '0.0', sinceOpen: '0.0', sinceChange: '0.0' } } }];
        return { marginSummary: summary, crossMarginSummary: summary, crossMaintenanceMarginUsed: '0.0', withdrawable: '0.0', assetPositions, time: this.now };
      }
      case 'activeAssetData': return { user: body.user, coin: body.coin, leverage: { type: 'cross', value: this.o.leverage ?? 3 }, markPx: this.mid() };
      case 'userRateLimit': return this.rateLimit();
      case 'userFillsByTime': return this.fills.filter((f) => f.time >= (body.startTime ?? 0));
      case 'orderStatus': {
        const key = typeof body.oid === 'string' ? body.oid : `oid:${body.oid}`;
        const live = this.orders.find((o) => (typeof body.oid === 'string' ? o.cloid === body.oid : o.oid === body.oid));
        if (live) return { status: 'order', order: { order: row(live), status: 'open', statusTimestamp: live.timestamp } };
        const h = this.history.get(key);
        return h ? { status: 'order', order: { order: row(h.order), status: h.status, statusTimestamp: h.statusTimestamp } } : { status: 'unknownOid' };
      }
      default: throw new Error(`sim venue: no answer for info ${String(body?.type)}`);
    }
  }

  // ---- exchange -------------------------------------------------------------------------------------------------------------
  async exchange(body: any): Promise<unknown> {
    if (this.down) throw new Error('fetch failed');
    const mode = this.failNextExchange; this.failNextExchange = null;
    this.requests.push({ t: this.now, kind: 'exchange', type: String(body?.action?.type), weight: 1 });
    if (mode === 'lost_before_apply') throw new Error('The operation was aborted due to timeout');
    const answer = await this.apply(body);
    if (mode === 'lost_after_apply') throw new Error('The operation was aborted due to timeout');
    if (mode === 'garbage') return '<html>502 Bad Gateway</html>';
    return answer;
  }
  private async apply(body: any): Promise<unknown> {
    const err = (response: string) => ({ status: 'err', response });
    const { action, nonce, signature, vaultAddress, expiresAfter } = body ?? {};
    const type = String(action?.type);
    const done = (n: number, result: string, answer: unknown) => { this.log.push({ t: this.now, type, n, result }); return answer; };
    if (vaultAddress !== null) return done(0, 'err', err('Vault not registered'));
    // the venue recovers the signer from the signature over the action hash; an API wallet it does not know is refused
    let who: string;
    try { who = await recoverTypedDataSigner(l1SignPayload(action as MsgpackValue, { network: this.o.network, nonce, vaultAddress: null, expiresAfter: expiresAfter ?? null }).typedData, signature); } catch { return done(0, 'err', err('Failed to deserialize the JSON body')); }
    if (who !== this.o.agent) return done(0, 'err', err(`User or API Wallet ${who} does not exist.`));
    if (this.nonces.has(nonce)) return done(0, 'err', err('Invalid nonce: duplicate nonce'));
    if (!(nonce > this.now - 2 * 86_400_000 && nonce < this.now + 86_400_000)) return done(0, 'err', err('Invalid nonce: outside the window'));
    this.nonces.add(nonce);
    const n = type === 'order' ? action.orders.length : type === 'cancel' || type === 'cancelByCloid' ? action.cancels.length : 1, isCancel = type === 'cancel' || type === 'cancelByCloid';
    if (typeof expiresAfter === 'number' && this.now > expiresAfter) { this.used += 5 * n; return done(n, 'expired', err('Action already expired')); }
    // address-based limit: "1 request per 1 USDC traded … initial buffer of 10000"; cancels: min(limit + 100000, limit × 2)
    const cap = 10_000 + Math.floor(this.volume), cancelCap = Math.min(cap + 100_000, cap * 2);
    if (isCancel ? this.cancelUsed + this.used + n > cancelCap : this.used + n > cap) {
      if (this.now - this.lastThrottled < 10_000) return done(n, 'rate_limited', err(`Too many cumulative requests sent (${this.used + n} > ${cap}) for cumulative volume traded $${this.volume.toFixed(2)}.`));
      this.lastThrottled = this.now;                                                                // "one request every 10 seconds"
    }
    if (isCancel) this.cancelUsed += n; else this.used += n;

    if (type === 'scheduleCancel') {
      if (action.time === undefined) { this.scheduled = null; return done(1, 'ok', { status: 'ok', response: { type: 'default' } }); }
      if (action.time < this.now + 5000) return done(1, 'err', err('Scheduled cancel time too early, must be at least 5 seconds from now'));
      if ((this.triggers[this.day()] ?? 0) >= 10) return done(1, 'err', err('Cannot set scheduled cancel time: 10 triggers used today'));
      this.scheduled = action.time;
      return done(1, 'ok', { status: 'ok', response: { type: 'default' } });
    }
    if (isCancel) {
      const statuses = (action.cancels as any[]).map((c) => {
        const o = this.orders.find((x) => (type === 'cancel' ? x.oid === c.o : x.cloid === c.cloid));
        if (!o) return { error: 'Order was never placed, already canceled, or filled.' };
        this.orders = this.orders.filter((x) => x !== o); this.close(o, 'canceled');
        return 'success';
      });
      return done(n, 'ok', { status: 'ok', response: { type: 'cancel', data: { statuses } } });
    }
    if (type === 'order') {
      const statuses = (action.orders as any[]).map((w) => this.place(w));
      return done(n, 'ok', { status: 'ok', response: { type: 'order', data: { statuses } } });
    }
    return done(1, 'err', err(`Unsupported action ${type}`));
  }
  private place(w: any): unknown {
    if (w.a !== this.asset.asset) return { error: 'Invalid asset' };
    const p = hlFormatPrice(w.p, this.asset.szDecimals), z = hlFormatSize(w.s, this.asset.szDecimals);
    if (!p.ok || p.wire !== w.p) return { error: 'Price must be divisible by tick size.' };
    if (!z.ok || z.wire !== w.s) return { error: 'Order has invalid size.' };
    const tif = w.t?.limit?.tif as string, buy = w.b === true, px = d(w.p), sz = d(w.s), pos = d(this.position);
    if (!w.r && D.lt(D.mul(px, sz), d('10'))) return { error: 'Order must have minimum value of $10.' };
    if (w.c && (this.orders.some((o) => o.cloid === w.c))) return { error: 'Client order id already in use.' };
    const order: SimOrder = { oid: this.oid++, cloid: w.c ?? null, side: buy ? 'B' : 'A', px: w.p, sz: w.s, origSz: w.s, reduceOnly: w.r === true, tif, timestamp: this.now, queueAhead: '0' };
    const reject = (status: string, error: string) => { this.close(order, status); return { error }; };
    if (w.r) {
      if (D.isZero(pos) || (buy ? D.isPos(pos) : D.isNeg(pos))) return reject('reduceOnlyRejected', 'Reduce only order would increase position.');
      if (D.gt(sz, D.abs(pos))) { order.sz = s(D.abs(pos)); }                                         // a reduce-only order never flips the position
    }
    const crosses = buy ? D.gte(px, d(this.ask)) : D.lte(px, d(this.bid));
    if (tif === 'Alo') {
      if (crosses) return reject('badAloPxRejected', `Post only order would have immediately matched, bbo was ${this.bid}@${this.ask}.`);
      order.queueAhead = buy ? (w.p === this.bid ? this.bidSz : '0') : (w.p === this.ask ? this.askSz : '0');   // behind what is displayed at that price
      this.orders.push(order); this.emitOrder(order, 'open', 'open');
      return { resting: { oid: order.oid, ...(order.cloid ? { cloid: order.cloid } : {}) } };
    }
    if (tif === 'Ioc') {
      if (!crosses) return reject('iocCancelRejected', 'Order could not immediately match against any resting orders.');
      // an IOC takes the displayed size at the best price, at that price (no depth beyond the top is recorded)
      const avail = d(buy ? this.askSz : this.bidSz), take = D.min(d(order.sz), avail), at = buy ? this.ask : this.bid;
      if (!D.isPos(take)) return reject('iocCancelRejected', 'Order could not immediately match against any resting orders.');
      this.fill(order, s(take), at, true);
      if (!D.isZero(d(order.sz))) this.close(order, 'canceled');
      return { filled: { totalSz: s(take), avgPx: at, oid: order.oid, ...(order.cloid ? { cloid: order.cloid } : {}) } };
    }
    if (crosses) return reject('rejected', 'the simulated venue takes Gtc orders only when they rest');
    this.orders.push(order);
    return { resting: { oid: order.oid, ...(order.cloid ? { cloid: order.cloid } : {}) } };
  }
}
