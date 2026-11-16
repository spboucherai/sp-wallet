// Hyperliquid venue adapter — read side (dossier: docs/v4/venues/hyperliquid.md). Perpetuals of the first perp dex only
// (the validator-operated USDC dex; spot is out of scope). v11: builder-deployed HIP-3 dexes are READ through `adapter.builder`
// (builder.ts) — market data only; the VenueAdapter methods, the asset table and the trading object stay on the first dex.
// Every answer goes through zod (schemas.ts); every amount stays a decimal string.
import { D } from '../../decimal.ts';
import type { AccountState, Candle, FundingPayment, Position } from '../../models.ts';
import type { Capabilities, VenueAdapter } from '../../venue.ts';
import { createHlBuilderDexes, type HlBuilderDexes } from './builder.ts';
import { createHlHttp, type HlHttp, type HlHttpOptions } from './http.ts';
import {
  hlCandles, hlClearinghouseState, hlFills, hlFrontendOpenOrders, hlFundingHistory, hlHistoricalOrders, hlL2Book, hlMeta, hlMetaAndAssetCtxs, hlTrades, hlUserFunding,
  type HlAssetCtx, type HlMeta,
} from './schemas.ts';
import type { HlNetwork } from './signing.ts';
import { createHlStream, type HlStreamOptions } from './stream.ts';
import { createHlTrading, type HlAsset, type HlTrading, type HlTradingOptions } from './trading.ts';

import { HL_INTERVAL_MS, HL_MAX_CANDLES, hlAccount, hlBook, hlErr as err, hlFillOf, hlInstrument, hlOrder, hlPublicTrade, hlTicker, parseHl } from './mappers.ts';

const ID = 'hyperliquid' as const;

// --- adapter -------------------------------------------------------------------------------------------------------------------
export interface HyperliquidOptions extends Omit<HlHttpOptions, 'budget'> {
  /** how long the asset table (meta) is reused for symbol checks; default 60 s */
  metaTtlMs?: number;
  /** stream settings (WebSocket constructor, heartbeat, backoff) */
  stream?: Omit<HlStreamOptions, 'network' | 'now'>;
  /** trading settings; the adapter never holds a key */
  trading?: Pick<HlTradingOptions, 'allowMainnetExchange' | 'vaultAddress' | 'expiresAfterMs'>;
  /** a known asset table (e.g. pinned by the signer): `adapter.trading` is then available synchronously */
  assets?: HlAsset[];
  /** wait between the retries of a builder-dex annotation that answered null (tests pass a no-op) */
  sleep?: (ms: number) => Promise<void>;
}

export interface HyperliquidAdapter extends VenueAdapter {
  readonly id: 'hyperliquid';
  readonly http: HlHttp;
  /** asset table from `meta`: symbol → asset index (the integer used in actions) and szDecimals */
  assets(): Promise<HlAsset[]>;
  /** trading object bound to the asset table read from the venue (buildOrder / describe need the asset indices) */
  loadTrading(): Promise<HlTrading>;
  stream: NonNullable<VenueAdapter['stream']>;
  /** v11: builder-deployed (HIP-3) perp dexes, read side only — market data, never an order (builder.ts) */
  readonly builder: HlBuilderDexes;
  /** closes the websocket and stops every timer */
  close(): void;
}

export function createHyperliquidAdapter(o: HyperliquidOptions): HyperliquidAdapter {
  const network: HlNetwork = o.network, now = o.now ?? Date.now, http = createHlHttp(o), metaTtlMs = o.metaTtlMs ?? 60_000;
  let cached: { at: number; assets: HlAsset[] } | null = null;
  const remember = (meta: HlMeta): HlAsset[] => {
    const assets = meta.universe.map((u, i) => ({ symbol: u.name, asset: i, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, isolatedOnly: hlInstrument(u).marginModes.length === 1, delisted: u.isDelisted === true }));
    cached = { at: now(), assets };
    return assets;
  };
  const assets = async (): Promise<HlAsset[]> => {
    if (cached && now() - cached.at < metaTtlMs) return cached.assets;
    return remember(parseHl(hlMeta, await http.info({ type: 'meta' }), 'meta'));
  };
  const known = async (symbol: string): Promise<HlAsset> => {
    const a = (await assets()).find((x) => x.symbol === symbol);
    if (!a) throw err('unsupported', `unknown instrument '${String(symbol).slice(0, 40)}'`);
    return a;
  };
  const ctxs = async (): Promise<{ meta: HlMeta; ctxs: HlAssetCtx[]; ts: number }> => {
    const [meta, c] = parseHl(hlMetaAndAssetCtxs, await http.info({ type: 'metaAndAssetCtxs' }), 'metaAndAssetCtxs');
    if (c.length !== meta.universe.length) throw err('bad_answer', 'metaAndAssetCtxs: universe and contexts differ in length');
    remember(meta);
    return { meta, ctxs: c, ts: now() }; // the venue gives no timestamp for this answer: time of receipt
  };
  const stream = createHlStream({ ...o.stream, network, now });

  const capabilities: Capabilities = {
    marketData: true, account: true, orders: true,
    orderTypes: ['limit', 'market', 'stop_market', 'stop_limit', 'take_profit_market', 'take_profit_limit'], tif: ['gtc', 'ioc', 'alo'],
    modify: false, leverage: true, marginModes: ['cross', 'isolated'], subaccounts: false, testnet: true, stream: true,
    notes: [
      'No fixed tick: prices have at most 5 significant figures and at most 6 − szDecimals decimals; Instrument.tickSize is the finest step.',
      'Market orders are sent as immediate-or-cancel limit orders at the worst acceptable price (price is required).',
      'Stop and take-profit orders need both triggerPrice and price (the limit after triggering; for the *_market types it is the slippage bound).',
      'Trading goes through an API wallet approved by the account; this adapter builds and verifies actions and never holds a key.',
      'First perp dex only: no spot, no sub-accounts or vaults (vaultAddress is not used).',
      'Builder-deployed (HIP-3) dexes are read-only (`adapter.builder`: instruments, tickers, book, candles) and NOT tradable through the wallet — reason code builder_dex_read_only: they are absent from instruments(), from the asset table and from the trading object.',
      'Order modification (modify / batchModify) is not implemented: cancel and place again.',
      'Ticker.volume24h is USD notional; Ticker.ts is the time of receipt (the venue gives none); funding is the hourly rate.',
    ],
  };

  return {
    id: ID, network, capabilities, http, assets, builder: createHlBuilderDexes({ http, now, ...(o.sleep ? { sleep: o.sleep } : {}) }), trading: o.assets ? createHlTrading({ network, assets: o.assets, http, now, ...o.trading }) : undefined, close: () => stream.close(),
    stream(sub, on, onStatus) {
      if (sub.type === 'account') return stream.subscribe(sub, on, onStatus);
      // The server DROPS the connection on a subscription to an unknown coin (close 1006, no message — observed 2026-11-10),
      // which would take every other subscription down with it: the symbol is checked against the venue's table first.
      let cancelled = false, unsubscribe: (() => void) | null = null;
      assets().then((table) => {
        if (cancelled) return;
        if (!table.some((a) => a.symbol === sub.symbol)) { on({ type: 'invalid', channel: 'subscribe', reason: `unknown instrument '${String(sub.symbol).slice(0, 40)}'` }); return; }
        unsubscribe = stream.subscribe(sub, on, onStatus);
      }, (e: unknown) => { if (!cancelled) on({ type: 'invalid', channel: 'subscribe', reason: `asset table unavailable (${e instanceof Error ? e.message : 'error'})`.slice(0, 160) }); });
      return () => { cancelled = true; unsubscribe?.(); };
    },
    async loadTrading() { return createHlTrading({ network, assets: await assets(), http, now, ...o.trading }); },

    async instruments() { return parseHl(hlMeta, await http.info({ type: 'meta' }), 'meta').universe.map(hlInstrument); },

    async tickers() {
      const { meta, ctxs: c, ts } = await ctxs();
      return meta.universe.map((u, i) => hlTicker(u.name, c[i]!, ts));
    },

    async book(symbol, depth) {
      if (depth !== undefined && (!Number.isInteger(depth) || depth < 1)) throw err('unsupported', 'depth must be a positive integer');
      await known(symbol);
      const b = parseHl(hlL2Book, await http.info({ type: 'l2Book', coin: symbol }), 'l2Book');
      if (b.coin !== symbol) throw err('bad_answer', 'l2Book: answer is for another coin');
      return hlBook(b, depth);
    },

    async trades(symbol, limit) {
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw err('unsupported', 'limit must be a positive integer');
      await known(symbol);
      const t = parseHl(hlTrades, await http.info({ type: 'recentTrades', coin: symbol }), 'recentTrades');
      if (t.some((x) => x.coin !== symbol)) throw err('bad_answer', 'recentTrades: answer is for another coin');
      const out = t.map(hlPublicTrade).sort((a, b) => b.ts - a.ts); // newest first
      return limit === undefined ? out : out.slice(0, limit);
    },

    async candles(symbol, interval, q) {
      const step = HL_INTERVAL_MS[interval];
      if (!step) throw err('unsupported', `interval '${String(interval)}' is not supported`);
      const limit = q.limit ?? 500;
      if (!Number.isInteger(limit) || limit < 1 || limit > HL_MAX_CANDLES) throw err('unsupported', `limit must be between 1 and ${HL_MAX_CANDLES}`);
      await known(symbol);
      const end = q.end ?? now(), start = q.start ?? end - limit * step;
      if (!(start < end)) throw err('unsupported', 'start must be before end');
      const c = parseHl(hlCandles, await http.info({ type: 'candleSnapshot', req: { coin: symbol, interval, startTime: start, endTime: end } }), 'candleSnapshot');
      if (c.some((x) => x.s !== symbol || x.i !== interval)) throw err('bad_answer', 'candleSnapshot: answer is for another coin or interval');
      const out: Candle[] = c.map((x) => ({ ts: x.t, open: x.o, high: x.h, low: x.l, close: x.c, volume: x.v })).sort((a, b) => a.ts - b.ts);
      for (const x of out) if (D.cmp(D.from(x.low), D.from(x.high)) > 0) throw err('bad_answer', 'candleSnapshot: low above high');
      return q.start !== undefined ? out.slice(0, limit) : out.slice(-limit);
    },

    async fundingHistory(symbol, q) {
      await known(symbol);
      const body: Record<string, unknown> = { coin: symbol, startTime: q.start };
      if (q.end !== undefined) body.endTime = q.end;
      const f = parseHl(hlFundingHistory, await http.info({ type: 'fundingHistory', ...body }), 'fundingHistory');
      if (f.some((x) => x.coin !== symbol)) throw err('bad_answer', 'fundingHistory: answer is for another coin');
      return f.map((x) => ({ ts: x.time, rate: x.fundingRate, premium: x.premium })).sort((a, b) => a.ts - b.ts);
    },

    async account(account) {
      const user = hlAccount(account);
      const s = parseHl(hlClearinghouseState, await http.info({ type: 'clearinghouseState', user }), 'clearinghouseState');
      const equity = D.from(s.marginSummary.accountValue), used = D.from(s.marginSummary.totalMarginUsed);
      const upnl = s.assetPositions.reduce((n, p) => D.add(n, D.from(p.position.unrealizedPnl)), D.from('0'));
      const free = D.sub(equity, used);
      const state: AccountState = {
        venue: ID, account: user, equity: D.str(equity),
        collateral: D.str(D.sub(equity, upnl)),                 // account value without unrealized PnL (derived exactly from venue fields)
        freeCollateral: free.m < 0n ? '0' : D.str(free),        // account value − margin used (derived exactly from venue fields)
        marginUsed: D.str(used), maintenanceMargin: s.crossMaintenanceMarginUsed, // cross positions only (the venue gives no isolated total)
        withdrawable: s.withdrawable, ts: s.time, source: 'venue',
      };
      return state;
    },

    async positions(account) {
      const user = hlAccount(account);
      const s = parseHl(hlClearinghouseState, await http.info({ type: 'clearinghouseState', user }), 'clearinghouseState');
      const open = s.assetPositions.map((p) => p.position).filter((p) => !D.isZero(D.from(p.szi)));
      if (open.length === 0) return [];
      const { meta, ctxs: c } = await ctxs(); // the account state carries no mark price: read the venue's own
      return open.map((p): Position => {
        const i = meta.universe.findIndex((u) => u.name === p.coin);
        if (i < 0) throw err('bad_answer', `position on unknown instrument '${p.coin}'`);
        if (p.entryPx === null) throw err('bad_answer', `position ${p.coin}: no entry price`);
        const szi = D.from(p.szi);
        return {
          instrument: `${ID}:${p.coin}`, side: szi.m > 0n ? 'long' : 'short', size: D.str(D.abs(szi)), entryPrice: p.entryPx, markPrice: c[i]!.markPx,
          liquidationPrice: p.liquidationPx, leverage: String(p.leverage.value), marginMode: p.leverage.type, margin: p.marginUsed,
          unrealizedPnl: p.unrealizedPnl, realizedPnl: null, fundingPaid: p.cumFunding.sinceOpen, source: 'venue',
        };
      });
    },

    async openOrders(account) {
      const user = hlAccount(account);
      const o2 = parseHl(hlFrontendOpenOrders, await http.info({ type: 'frontendOpenOrders', user }), 'frontendOpenOrders');
      return o2.map((x) => hlOrder(x, 'open', x.timestamp));
    },

    async orderHistory(account, q) {
      const user = hlAccount(account), limit = q?.limit;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw err('unsupported', 'limit must be a positive integer');
      const h = parseHl(hlHistoricalOrders, await http.info({ type: 'historicalOrders', user }), 'historicalOrders');
      // one entry per status change; keep the latest status of each order (same timestamp: the more final one)
      const rank = (st: string): number => (st === 'open' ? 0 : st === 'triggered' ? 1 : 2);
      const latest = new Map<number, (typeof h)[number]>();
      for (const x of h) {
        const p = latest.get(x.order.oid);
        if (!p || x.statusTimestamp > p.statusTimestamp || (x.statusTimestamp === p.statusTimestamp && rank(x.status) > rank(p.status))) latest.set(x.order.oid, x);
      }
      const out = [...latest.values()].map((x) => hlOrder(x.order, x.status, x.statusTimestamp)).sort((a, b) => b.updatedAt - a.updatedAt);
      return limit === undefined ? out : out.slice(0, limit);
    },

    async fills(account, q) {
      const user = hlAccount(account), limit = q?.limit;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw err('unsupported', 'limit must be a positive integer');
      const body = q?.start !== undefined ? { type: 'userFillsByTime', user, startTime: q.start } : { type: 'userFills', user };
      const f = parseHl(hlFills, await http.info(body), body.type);
      const out = f.map(hlFillOf).sort((a, b) => b.ts - a.ts);
      return limit === undefined ? out : out.slice(0, limit);
    },

    async funding(account, q) {
      const user = hlAccount(account);
      const f = parseHl(hlUserFunding, await http.info({ type: 'userFunding', user, startTime: q?.start ?? now() - 7 * 86_400_000 }), 'userFunding');
      // amount: USDC credited (+) or debited (−) to the account; size: the signed position (negative = short) at the payment
      return f.map((x): FundingPayment => ({ instrument: `${ID}:${x.delta.coin}`, amount: x.delta.usdc, rate: x.delta.fundingRate, size: x.delta.szi, ts: x.time })).sort((a, b) => a.ts - b.ts);
    },
  };
}
