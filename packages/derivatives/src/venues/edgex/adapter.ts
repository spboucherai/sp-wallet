// edgeX Perps V2 — READ-ONLY MARKET-DATA adapter (docs/V11-EXCHANGE-INTEGRATIONS.md, docs/v11/research/edgex-api.md).
//
// Scope, by decision: edgeX's Terms of Use name Canada as a blocked jurisdiction and the wallet's owner is in Québec. Like
// dYdX, the venue is integrated for its PUBLIC market data only and nothing here works around the restriction. This file
// contains no account call, no private endpoint, no request signing, no order building and no order submission; `trading` is
// undefined and every account method throws `VenueUnavailable('edgex_account_restricted_jurisdiction')`.
//
// Only endpoints verified live on 2026-11-15 are used (GET, no header, no key):
//   /api/v2/public/meta/getMetaData            instruments (contract id ↔ symbol is resolved from here, never hard-coded)
//   /api/v2/public/contract-labels             category tabs (undocumented, optional: the adapter works without it)
//   /api/v2/public/quote/getTicker?contractId= one contract per call (REST fallback of `tickers()`)
//   /api/v2/public/quote/getDepth              level 15 or 200 only
//   /api/v2/public/quote/getKline              newest first, ≤ 1000 per page, `offsetData` paging
//   /api/v2/public/funding/getFundingRatePage  settlements, newest first, `offsetData` paging
//   wss://…/api/v1/public/ws                   ticker.{id}, ticker.all.1s, depth.{id}.15|200, trades.{id}
// Rate limits are not published by edgeX: the defaults below are deliberately slow and every cadence is an option.
import type { z } from 'zod';
import type { DecStr } from '../../decimal.ts';
import { VenueError, VenueUnavailable, type AccountState, type Book, type Candle, type Fill, type FundingPayment, type InstrumentCategory, type Order, type Position, type PublicTrade, type Ticker } from '../../models.ts';
import type { Capabilities, StreamStatus, StreamSub, VenueAdapter } from '../../venue.ts';
import { venueError, venueHttp } from '../http.ts';
import { EDGEX, bookOf, categoriesOf, instrumentId, instrumentOf, tickerOf, type EdgeXInstrument } from './map.ts';
import { EdgeXStream, type EdgeXStreamEvent, type EdgeXWebSocketCtor } from './stream.ts';
import * as W from './wire.ts';

/** Pinned public endpoints (mainnet). edgeX has no public testnet: every testnet host is behind a Cloudflare Access login. */
export const EDGEX_ENDPOINTS = {
  mainnet: { rest: 'https://edgex-prod-v2.edgex.exchange', ws: 'wss://edgex-quote-prod-v2.edgex.exchange/api/v1/public/ws' },
} as const;

/** machine-readable reasons carried by `VenueUnavailable` and by the capability notes */
export const EDGEX_REASONS = {
  account: 'edgex_account_restricted_jurisdiction',
  trading: 'edgex_trading_restricted_jurisdiction',
  trades: 'edgex_trades_unavailable',
} as const;
export const EDGEX_TERMS_URL = 'https://edgex-1.gitbook.io/edgeX-documentation/about/terms-of-use';

const KLINE = { '1m': 'MINUTE_1', '5m': 'MINUTE_5', '15m': 'MINUTE_15', '1h': 'HOUR_1', '4h': 'HOUR_4', '1d': 'DAY_1' } as const;
/** `getKline` refuses more than 1000 rows per page (INVALID_GET_PAGE_SIZE) */
const KLINE_PAGE = 1000;
const KLINE_MAX_PAGES = 5;
/** the docs say ≤ 100 for `getFundingRatePage`; the live gateway accepted more, neither bound is relied on */
const FUNDING_PAGE = 100;
const FUNDING_MAX_PAGES = 20;

export const EDGEX_CAPABILITIES: Capabilities = {
  marketData: true, account: false, orders: false, orderTypes: [], tif: [], modify: false, leverage: false,
  marginModes: [], subaccounts: false, testnet: false, stream: true,
  notes: [
    `Trading unavailable [${EDGEX_REASONS.trading}]: edgeX's Terms of Use exclude persons located in the United States of America or Canada ("Blocked Persons") from its interface and from perpetual contracts, and prohibit using a VPN to get around it (${EDGEX_TERMS_URL}, read 2026-11-15). The wallet's owner is in Québec: no order is built, signed or sent, and nothing is simulated.`,
    `Account reads unavailable [${EDGEX_REASONS.account}]: no edgeX account is created or read; every account method of the adapter throws.`,
    'Market data only, from public endpoints verified live on 2026-11-15. edgeX publishes no rate limits: requests are throttled conservatively and a 429 is answered by backing off.',
    'Recent trades have no REST endpoint: they come from the public websocket (trades.{contractId}); when it cannot be reached, trades are reported unavailable rather than empty.',
    'Ticker.ts and Book.ts are the time the answer was received: edgeX stamps neither. Ticker.funding is the running forecast for the current funding interval (4 h on every contract on 2026-11-15); Ticker.volume24h is the 24 h turnover in USDC.',
    'Instrument.category: the isStock / isFx flags of the metadata give equity and fx; the category tabs of the edgeX app (an undocumented endpoint) add pre_ipo and commodity, and crypto for the rest. Without the tabs, contracts that are neither stock nor fx carry no category. edgeX publishes no contract specification for its pre-IPO perpetuals (unit, index sources, what happens at an IPO): none is stated here.',
    'Contracts that edgeX itself hides (enableDisplay false) are not listed. No public testnet exists.',
  ],
};

export interface EdgeXAdapterOptions {
  fetch?: typeof fetch; now?: () => number; restUrl?: string; wsUrl?: string;
  /** websocket implementation; `null` disables the websocket (tickers then come from REST, trades are unavailable) */
  WebSocket?: EdgeXWebSocketCtor | null;
  /** injectable wait (tests) */
  sleep?: (ms: number) => Promise<void>;
  /** per-request timeout. Default 10 s (with the single retry, a venue that hangs holds an all-venue answer for about 20 s at most). */
  timeoutMs?: number;
  /** one retry after a transport failure or a 5xx (never after a 429). Default 1. */
  retries?: number;
  /** metadata (contract list) is re-read after this long. Default 5 min. */
  metaTtlMs?: number;
  /** read the app's category tabs (undocumented endpoint). Default true. */
  labels?: boolean;
  /** REST fallback of `tickers()`: simultaneous `getTicker` calls, and how often a full sweep may start. Defaults 4 and 15 s. */
  tickerConcurrency?: number; tickerSweepMs?: number;
  /** REST fallback: a ticker read longer ago than this is not returned. Default 60 s. */
  tickerRestMaxAgeMs?: number;
  /** websocket tickers (ticker.all.1s): oldest frame still served, and how long the first frame is waited for. Defaults 5 s and 4 s. */
  tickerStreamMaxAgeMs?: number; tickerStreamWaitMs?: number;
  /** an internal websocket subscription (all tickers, trades of a contract) is kept this long after its last use. Default 60 s. */
  streamIdleMs?: number;
  /** `trades()`: how long the websocket snapshot is waited for. Default 6 s. */
  tradesWaitMs?: number;
  /** after an HTTP 429 no request is sent for this long, doubling up to the maximum. Defaults 5 s and 120 s. */
  rateLimitBackoffMs?: number; rateLimitBackoffMaxMs?: number;
  /** depth channel of `stream({ type: 'book' })`. Default 15. */
  streamBookLevel?: 15 | 200;
}

export interface EdgeXAdapter extends VenueAdapter {
  readonly trading: undefined;
  instruments(): Promise<EdgeXInstrument[]>;
  stream(sub: StreamSub, on: (ev: unknown) => void, onStatus: (s: StreamStatus) => void): () => void;
  /** where `tickers()` last came from, and the state of the 429 backoff (diagnostics, smoke script) */
  diagnostics(): { tickerSource: 'websocket' | 'rest' | null; rateLimitedUntil: number; restCalls: number; stream: ReturnType<EdgeXStream['stats']>;
    /** listings of the last metadata read that failed validation and were left out */ skippedContracts: { contract: string; reason: string }[] };
  /** closes the websocket and every timer */
  close(): void;
}

interface Meta { at: number; byName: Map<string, W.Contract>; instruments: EdgeXInstrument[]; shown: Set<string>; skipped: { contract: string; reason: string }[] }

export function createEdgeXAdapter(o: EdgeXAdapterOptions = {}): EdgeXAdapter {
  const now = o.now ?? Date.now, base = o.restUrl ?? EDGEX_ENDPOINTS.mainnet.rest;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); (t as { unref?: () => void }).unref?.(); }));
  const http = venueHttp(EDGEX, o.fetch, { timeoutMs: o.timeoutMs ?? 10_000 });
  const retries = o.retries ?? 1, metaTtlMs = o.metaTtlMs ?? 300_000, streamIdleMs = o.streamIdleMs ?? 60_000;
  const backoffMin = o.rateLimitBackoffMs ?? 5_000, backoffMax = o.rateLimitBackoffMaxMs ?? 120_000;
  const stream = new EdgeXStream({ url: o.wsUrl ?? EDGEX_ENDPOINTS.mainnet.ws, WebSocket: o.WebSocket, now });
  let limitedUntil = 0, limitStep = 0, restCalls = 0, tickerSource: 'websocket' | 'rest' | null = null, closed = false;

  // ------------------------------------------------------------------ REST

  /** GET → envelope → `data` validated. 429 starts a backoff during which nothing is sent; HTML or malformed JSON is `bad_answer`. */
  const call = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
    const left = limitedUntil - now();
    if (left > 0) throw venueError(EDGEX, 'rate_limited', `backing off after an HTTP 429 for another ${Math.ceil(left / 1000)} s`);
    let a: { status: number; text: string };
    for (let attempt = 0; ; attempt++) {
      restCalls += 1;
      try { a = await http.raw(`${base}${path}`); break; }
      catch (e) {
        if (e instanceof VenueError && e.code === 'rate_limited') { limitStep = Math.min(backoffMax, limitStep ? limitStep * 2 : backoffMin); limitedUntil = now() + limitStep; throw e; }
        if (attempt < retries && e instanceof VenueError && e.code === 'unavailable') { await sleep(250 * (attempt + 1)); continue; }
        throw e;
      }
    }
    const where = path.split('?')[0]!;
    let body: unknown;
    try { body = JSON.parse(a.text); } catch { throw venueError(EDGEX, 'bad_answer', `non-JSON answer (HTTP ${a.status}) from ${where}`); }
    const env = W.envelope.safeParse(body);
    if (!env.success) throw venueError(EDGEX, 'bad_answer', `${where}: not the edgeX answer envelope`);
    if (env.data.code !== 'SUCCESS') throw venueError(EDGEX, 'rejected', `${env.data.code}: ${(env.data.msg ?? '').slice(0, 160)}`);
    if (a.status < 200 || a.status >= 300) throw venueError(EDGEX, 'rejected', `HTTP ${a.status} from ${where}`);
    const p = schema.safeParse(env.data.data);
    if (!p.success) { const i = p.error.issues[0]; throw venueError(EDGEX, 'bad_answer', `${where}: ${i ? `${i.path.join('.')} ${i.message}` : 'schema mismatch'}`.slice(0, 300)); }
    limitStep = 0;
    return p.data;
  };
  const q = (p: Record<string, string | number | undefined>) => Object.entries(p).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');

  // ------------------------------------------------------------------ metadata

  let meta: Meta | null = null, metaLoading: Promise<Meta> | null = null;
  const loadMeta = (force = false): Promise<Meta> => {
    if (meta && !force && now() - meta.at < metaTtlMs) return Promise.resolve(meta);
    metaLoading ??= (async () => {
      const [raw, labels] = await Promise.all([
        call('/api/v2/public/meta/getMetaData', W.metaData),
        // optional and undocumented: without it the category falls back to what the metadata flags prove
        o.labels === false ? Promise.resolve(null) : call('/api/v2/public/contract-labels', W.contractLabels).then(categoriesOf, (): Map<string, InstrumentCategory> | null => null),
      ]);
      // each contract is validated alone: a listing that cannot be read is left out and reported, the others are served
      const contracts: W.Contract[] = [], skipped: Meta['skipped'] = [], instruments: EdgeXInstrument[] = [];
      const nameOf = (x: unknown): string => String((x as { contractName?: unknown } | null)?.contractName ?? '?').slice(0, 40);
      for (const x of raw.contractList) {
        const p = W.contract.safeParse(x);
        if (p.success) contracts.push(p.data); else { const i = p.error.issues[0]; skipped.push({ contract: nameOf(x), reason: `${i?.path.join('.') ?? ''} ${i?.message ?? 'invalid'}`.trim().slice(0, 120) }); }
      }
      if (!contracts.length) throw venueError(EDGEX, 'bad_answer', `/api/v2/public/meta/getMetaData: no readable contract (${skipped[0]?.contract}: ${skipped[0]?.reason})`);
      const m: W.MetaData = { ...raw, contractList: contracts };
      for (const c of contracts) {
        if (!c.enableDisplay) continue;
        try { instruments.push(instrumentOf(c, m, labels)); } catch (e) { skipped.push({ contract: c.contractName, reason: e instanceof Error ? e.message.slice(0, 120) : 'invalid' }); }
      }
      meta = { at: now(), byName: new Map(contracts.map((c) => [c.contractName, c])), instruments, shown: new Set(instruments.map((i) => i.symbol)), skipped };
      return meta;
    })().finally(() => { metaLoading = null; });
    return metaLoading;
  };
  /** symbol (contract name) → contract, resolved from live metadata; an unknown symbol is looked up once more in fresh metadata */
  const contractOf = async (symbol: string): Promise<W.Contract> => {
    if (typeof symbol !== 'string' || !W.CONTRACT_NAME_RE.test(symbol)) throw venueError(EDGEX, 'rejected', 'invalid contract name');
    let m = await loadMeta(), c = m.byName.get(symbol);
    if (!c && now() - m.at > 10_000) { m = await loadMeta(true); c = m.byName.get(symbol); }
    if (!c) throw venueError(EDGEX, 'rejected', `unknown contract '${symbol}'`);
    return c;
  };

  // ------------------------------------------------------------------ internal websocket subscriptions (kept while used)

  const held = new Map<string, { off: () => void; timer: ReturnType<typeof setTimeout> | null }>();
  const release = (channel: string): void => { const h = held.get(channel); if (!h) return; held.delete(channel); if (h.timer) clearTimeout(h.timer); try { h.off(); } catch { /* already closed */ } };
  /** opens the channel if it is not held, and (re)starts its idle timer */
  const hold = (channel: string, on: (ev: EdgeXStreamEvent) => void): void => {
    let h = held.get(channel);
    if (!h) { h = { off: stream.subscribe(channel, on, () => {}), timer: null }; held.set(channel, h); }
    if (h.timer) clearTimeout(h.timer);
    h.timer = setTimeout(() => release(channel), streamIdleMs);
    (h.timer as { unref?: () => void }).unref?.();
  };

  // ------------------------------------------------------------------ tickers

  const ALL = 'ticker.all.1s';
  let allTickers: { tickers: Ticker[]; at: number } | null = null, allWaiters: (() => void)[] = [];
  const onAll = (ev: EdgeXStreamEvent): void => {
    if (ev.type !== 'tickers') return;
    allTickers = { tickers: ev.tickers, at: now() };
    const w = allWaiters; allWaiters = []; for (const f of w) f();
  };
  const fromStream = async (m: Meta): Promise<Ticker[] | null> => {
    if (!stream.available || closed) return null;
    const maxAge = o.tickerStreamMaxAgeMs ?? 5_000, fresh = () => (allTickers && now() - allTickers.at <= maxAge ? allTickers.tickers : null);
    try { hold(ALL, onAll); } catch { return null; }
    let t = fresh();
    if (!t) {
      await Promise.race([new Promise<void>((r) => { allWaiters.push(r); }), sleep(o.tickerStreamWaitMs ?? 4_000)]);
      t = fresh();
    }
    return t ? t.filter((x) => m.shown.has(x.instrument.slice(EDGEX.length + 1))) : null;
  };

  const restCache = new Map<string, Ticker>();
  let sweeping: Promise<void> | null = null, lastSweepAt = -Infinity, sweepError: unknown = null;
  /** one `getTicker` per displayed contract, a few at a time; a 429 stops the sweep at once */
  const sweep = (m: Meta): Promise<void> => {
    sweeping ??= (async () => {
      lastSweepAt = now(); sweepError = null;
      const todo = m.instruments.map((i) => i.edgex.contractId);
      let stop = false;
      const worker = async (): Promise<void> => {
        for (;;) {
          const id = todo.shift();
          if (id === undefined || stop || closed) return;
          try {
            const t = (await call(`/api/v2/public/quote/getTicker?${q({ contractId: id })}`, W.tickers))[0];
            if (t && t.contractId === id) restCache.set(t.contractName, tickerOf(t, now()));
          } catch (e) { sweepError ??= e; if (e instanceof VenueError && e.code === 'rate_limited') stop = true; }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(16, o.tickerConcurrency ?? 4)) }, worker));
    })().finally(() => { sweeping = null; });
    return sweeping;
  };
  const fromRest = async (m: Meta): Promise<Ticker[]> => {
    if (sweeping || now() - lastSweepAt >= (o.tickerSweepMs ?? 15_000)) await sweep(m);
    const maxAge = o.tickerRestMaxAgeMs ?? 60_000, t = now();
    const out = [...restCache.entries()].filter(([name, x]) => m.shown.has(name) && t - x.ts <= maxAge).map(([, x]) => x);
    if (!out.length) throw sweepError ?? venueError(EDGEX, 'unavailable', 'no ticker could be read');
    return out;
  };

  // ------------------------------------------------------------------ trades (websocket only)

  const noTrades = (why: string, code: 'unavailable' | 'unsupported' = 'unavailable') =>
    new VenueUnavailable(EDGEX_REASONS.trades, { venue: EDGEX, code, message: `edgex: recent trades are unavailable: ${why} (edgeX has no REST endpoint for trades; they come from its public websocket)` });

  const refuseAccount = async (): Promise<never> => {
    throw new VenueUnavailable(EDGEX_REASONS.account, { venue: EDGEX, message: `edgex: account reads are not available: edgeX's Terms of Use exclude persons located in Canada (${EDGEX_TERMS_URL})` });
  };

  return {
    id: EDGEX, network: 'mainnet', capabilities: EDGEX_CAPABILITIES, trading: undefined,

    async instruments(): Promise<EdgeXInstrument[]> { return (await loadMeta()).instruments; },

    async tickers(): Promise<Ticker[]> {
      const m = await loadMeta();
      const live = await fromStream(m);
      if (live && live.length) { tickerSource = 'websocket'; return live; }
      const rest = await fromRest(m);
      tickerSource = 'rest';
      return rest;
    },

    async book(symbol: string, depth = 50): Promise<Book> {
      const c = await contractOf(symbol);
      const d = (await call(`/api/v2/public/quote/getDepth?${q({ contractId: c.contractId, level: depth <= 15 ? 15 : 200 })}`, W.depths))[0];   // only 15 and 200 exist
      if (!d || d.contractId !== c.contractId) throw venueError(EDGEX, 'bad_answer', `getDepth: no book for ${symbol}`);
      return bookOf(d, depth, now());
    },

    async trades(symbol: string, limit = 100): Promise<PublicTrade[]> {
      const c = await contractOf(symbol);
      if (!stream.available) throw noTrades('no websocket is available here', 'unsupported');
      if (closed) throw noTrades('the adapter is closed');
      const channel = `trades.${c.contractId}`;
      let wake: (() => void) | null = null, refused: string | null = null;
      const on = (ev: EdgeXStreamEvent): void => { if (ev.type === 'error') refused = ev.message; if (ev.type === 'trades' || ev.type === 'error') wake?.(); };
      try { hold(channel, on); } catch (e) { throw noTrades(e instanceof Error ? e.message : 'subscription failed'); }
      let t = stream.recentTrades(channel);
      if (t === null) {
        // a short-lived subscription: the channel's first frame is a snapshot of the most recent trades
        const waitMs = o.tradesWaitMs ?? 6_000;
        for (let waited = 0; t === null && refused === null && waited < waitMs;) {
          const step = Math.min(250, waitMs - waited);
          await Promise.race([new Promise<void>((r) => { wake = r; }), sleep(step)]);
          waited += step;
          t = stream.recentTrades(channel);
        }
        wake = null;
      }
      if (t === null) { release(channel); throw noTrades(refused ?? 'the websocket did not deliver the trade snapshot in time'); }
      return t.slice(0, Math.max(1, limit));
    },

    async candles(symbol, interval, r): Promise<Candle[]> {
      const c = await contractOf(symbol), want = Math.max(1, Math.min(r.limit ?? 500, KLINE_PAGE * KLINE_MAX_PAGES));
      const out = new Map<number, Candle>();
      let offsetData = '';
      for (let page = 0; page < KLINE_MAX_PAGES && out.size < want; page++) {
        const p = await call(`/api/v2/public/quote/getKline?${q({ contractId: c.contractId, klineType: KLINE[interval], priceType: 'LAST_PRICE', size: Math.min(KLINE_PAGE, want - out.size),
          filterBeginKlineTimeInclusive: r.start, filterEndKlineTimeExclusive: r.end, offsetData })}`, W.klinePage);
        // newest first; `klineTime` is the candle's open time; volume is in base units
        for (const k of p.dataList) out.set(k.klineTime, { ts: k.klineTime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.size });
        if (!p.nextPageOffsetData || p.dataList.length === 0) break;
        offsetData = p.nextPageOffsetData;
      }
      return [...out.values()].sort((a, b) => a.ts - b.ts).slice(-want);
    },

    async fundingHistory(symbol, f) {
      const c = await contractOf(symbol);
      const out = new Map<number, { ts: number; rate: DecStr; premium: DecStr | null }>();
      let offsetData = '';
      for (let page = 0; page < FUNDING_MAX_PAGES; page++) {
        // settlements only (without the filter the venue answers one running record per minute); newest first
        const p = await call(`/api/v2/public/funding/getFundingRatePage?${q({ contractId: c.contractId, size: FUNDING_PAGE, filterSettlementFundingRate: 'true', offsetData })}`, W.fundingPage);
        let oldest = Infinity;
        for (const x of p.dataList) {
          oldest = Math.min(oldest, x.fundingTime);
          if (x.isSettlement && x.contractId === c.contractId && x.fundingTime >= f.start && (f.end === undefined || x.fundingTime <= f.end)) out.set(x.fundingTime, { ts: x.fundingTime, rate: x.fundingRate, premium: x.premiumIndex ?? null });
        }
        if (!p.nextPageOffsetData || p.dataList.length === 0 || oldest <= f.start) break;
        offsetData = p.nextPageOffsetData;
      }
      return [...out.values()].sort((a, b) => a.ts - b.ts);
    },

    // no account exists and none is read: the venue's terms exclude the owner's country
    account: refuseAccount as (a: string) => Promise<AccountState>, positions: refuseAccount as (a: string) => Promise<Position[]>,
    openOrders: refuseAccount as (a: string) => Promise<Order[]>, orderHistory: refuseAccount as (a: string) => Promise<Order[]>,
    fills: refuseAccount as (a: string) => Promise<Fill[]>, funding: refuseAccount as (a: string) => Promise<FundingPayment[]>,

    stream(sub: StreamSub, on: (ev: unknown) => void, onStatus: (s: StreamStatus) => void): () => void {
      if (sub.type === 'account') throw new VenueUnavailable(EDGEX_REASONS.account, { venue: EDGEX, message: 'edgex: account streams are not available (the venue\'s terms exclude Canada)' });
      if (typeof sub.symbol !== 'string' || !W.CONTRACT_NAME_RE.test(sub.symbol)) throw venueError(EDGEX, 'rejected', 'invalid contract name');
      if (!stream.available) throw venueError(EDGEX, 'unsupported', 'no WebSocket implementation available');
      let off: (() => void) | null = null, cancelled = false;
      // the channel is named by the contract id, which only the metadata gives
      contractOf(sub.symbol).then((c) => {
        if (cancelled) return;
        const channel = sub.type === 'book' ? `depth.${c.contractId}.${o.streamBookLevel ?? 15}` : sub.type === 'trades' ? `trades.${c.contractId}` : `ticker.${c.contractId}`;
        off = stream.subscribe(channel, on as (ev: EdgeXStreamEvent) => void, onStatus);
      }, (e: unknown) => {
        if (cancelled) return;
        try { on({ type: 'error', message: e instanceof Error ? e.message.slice(0, 200) : 'subscription failed' }); onStatus('stale'); } catch { /* a consumer must not break the adapter */ }
      });
      return () => { cancelled = true; off?.(); off = null; };
    },

    diagnostics: () => ({ tickerSource, rateLimitedUntil: limitedUntil, restCalls, stream: stream.stats(), skippedContracts: meta?.skipped ?? [] }),
    close(): void { closed = true; for (const k of [...held.keys()]) release(k); stream.close(); const w = allWaiters; allWaiters = []; for (const f of w) f(); },
  };
}
export { instrumentId as edgexInstrumentId };
