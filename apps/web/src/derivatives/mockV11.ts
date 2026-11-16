/**
 * Development mock (`?mock=1`, see mock.ts) — the V11 sections. Before this file the mock answered 503 to everything outside
 * /derivatives, so in mock mode the Markets explorer, Private markets, Risk, the Dashboard and Activity were error screens and the
 * quote websocket retried against a dev proxy with nothing behind it (a console error every few seconds).
 * What is simulated, and what is not — each answer has the shape of the real route, so the screens render their normal states:
 *   /markets-hub, /markets-hub/underlyings[/:symbol]   the mock's own perpetuals (same instruments and prices as the terminal); no spot rows
 *   /private-markets                                   an EMPTY listing (the screen's own « nothing listed » state); a detail is a 404
 *   /risk/state, /mandates                             switches off, empty books, no limit stored, no mandate; every WRITE is refused (503 `not_simulated`)
 *   /trading/orders, /trading/positions                empty lists; every other /trading route is refused (503 `not_simulated`)
 *   /dashboard/status, /dashboard/summary              every section `{ ok: false, error: { code: 'not_simulated' } }` — the panels say « unavailable »
 *   /dashboard/activity, /activity, /plans             empty
 *   /portfolio, /networks, /accounts, /agents, /security/audit, /alerts   empty, so that Home and the shell draw
 *   websocket /api/v1/stream                           never connects: the socket closes at once, without touching the network, and the quote
 *                                                      client settles in its `fallback` state (screens keep their polling and say so)
 * Dev-only like the rest of the mock: imported by mock.ts alone, which main.tsx loads behind `import.meta.env.DEV`.
 */
import type { HubRow, HubVenue } from '../markets';
import type { Instrument, Ticker } from './types';

export type Outcome = { status: number; json: unknown };
export interface V11Ctx { now: number; markets: () => { inst: Instrument; ticker: Omit<Ticker, 'ts'> }[]; venueName: (id: string) => string }

export const NOT_SIMULATED = { error: 'not_simulated', message: 'mock mode: this route is not simulated' } as const;
const ok = (json: unknown): Outcome => ({ status: 200, json });
const refuse = (): Outcome => ({ status: 503, json: NOT_SIMULATED });
const unavailable = { ok: false, error: { code: 'not_simulated', message: NOT_SIMULATED.message } } as const;
const num = (s: string | null | undefined): number | null => (s === null || s === undefined || !Number.isFinite(Number(s)) ? null : Number(s));
const usd = (n: number | null): string | null => (n === null ? null : n.toFixed(2));

/** one perpetual of the mock as a row of the explorer (packages of the real answer: services/api/src/markets-hub) */
export function hubRow(inst: Instrument, t: Omit<Ticker, 'ts'>, venueName: string, now: number): HubRow {
  const mark = num(t.mark), oi = num(t.openInterest), rate = num(t.funding), sec = inst.fundingIntervalSec || 3600, dydx = inst.venue === 'dydx';
  return {
    id: inst.id, kind: 'perp', venue: inst.venue, venueName, symbol: inst.symbol, base: inst.base, quote: inst.quote, status: inst.status,
    underlying: inst.base, category: inst.category ?? 'crypto', multiplier: '1', mapping: { rule: 'mock', unmapped: null, note: '' },
    price: t.mark, priceKind: 'mark', unitPrice: t.mark, change24h: t.change24h, volume24hUsd: t.volume24h,
    funding: rate === null ? null : { rate: t.funding!, intervalSec: sec, perHour: ((rate * 3600) / sec).toFixed(10), annualised: ((rate * 31_536_000) / sec).toFixed(8) },
    openInterest: t.openInterest, openInterestUsd: usd(mark !== null && oi !== null ? mark * oi : null), maxLeverage: inst.maxLeverage,
    tradable: !dydx && inst.status === 'active', tradableReason: dydx ? 'dydx_jurisdiction' : inst.status === 'halted' ? 'instrument_halted' : inst.status === 'reduce_only' ? 'instrument_reduce_only' : null,
    paper: true, restriction: null, sourceTs: now, ageMs: 0, stale: false, staleAfterMs: 30_000, source: 'mock',
  };
}
const SORT: Record<string, (r: HubRow) => number | string> = {
  volume: (r) => num(r.volume24hUsd) ?? -1, openInterest: (r) => num(r.openInterestUsd) ?? -1, funding: (r) => num(r.funding?.annualised) ?? -Infinity, change: (r) => num(r.change24h) ?? -Infinity, symbol: (r) => r.symbol,
};
/** the explorer's listing over the mock's perpetuals: the filters, the sort and the page of the real route */
export function hubList(ctx: V11Ctx, q: URLSearchParams): Outcome {
  const all = ctx.markets().map((m) => hubRow(m.inst, m.ticker, ctx.venueName(m.inst.venue), ctx.now));
  const kind = q.get('kind') ?? 'perp', venue = q.get('venue') ?? '', category = q.get('category') ?? '', text = (q.get('q') ?? '').trim().toUpperCase(), tradable = q.get('tradable') ?? '';
  let rows = kind === 'spot' ? [] : all.filter((r) => (!venue || r.venue === venue) && (!category || r.category === category) && (!text || r.symbol.toUpperCase().includes(text) || r.base.toUpperCase().includes(text))
    && (tradable === '' || r.tradable === (tradable === 'yes')));
  const key = SORT[q.get('sort') ?? 'volume'] ?? SORT.volume!, dir = q.get('dir') === 'asc' ? 1 : -1;
  rows = [...rows].sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
  const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 50)), offset = Math.max(0, Number(q.get('offset')) || 0);
  const venues: HubVenue[] = [...new Set(all.map((r) => r.venue))].map((v) => ({ id: v, name: ctx.venueName(v), status: 'ok', rows: all.filter((r) => r.venue === v).length, ageMs: 0, restriction: null, error: null }));
  return ok({ rows: rows.slice(offset, offset + limit), total: rows.length, offset, limit, counts: { spot: 0, perp: all.length, tradable: all.filter((r) => r.tradable).length, stale: 0 }, venues,
    errors: [], locks: [], cache: { ageMs: 0, ttlMs: 10_000 }, ts: ctx.now });
}
function underlyings(ctx: V11Ctx): Outcome {
  const all = ctx.markets().map((m) => hubRow(m.inst, m.ticker, ctx.venueName(m.inst.venue), ctx.now));
  return ok({ underlyings: [...new Set(all.map((r) => r.base))].map((u) => { const rows = all.filter((r) => r.base === u), venues = [...new Set(rows.map((r) => r.venue))];
    return { underlying: u, category: 'crypto', venues, instruments: rows.length, comparable: venues.length > 1, volume24hUsd: usd(rows.reduce((s, r) => s + (num(r.volume24hUsd) ?? 0), 0)) }; }), ts: ctx.now });
}
const switchOff = { on: false, at: null, by: null, reason: null };
const emptyBook = (book: string) => ({ book, equity: '0', peakEquity: '0', grossExposure: '0', leverage: null, errors: [], byAsset: [], byVenue: [], collateral: [], positions: [] });
const noLimits = (mode: 'paper' | 'live') => ({ mode, stored: {}, defaults: {}, effective: {}, missing: [], missingForAutomation: [], ownerOrdersRefused: false, automationOrdersRefused: false });

/** the answer of a V11 route, or null when the path is not one of this file's (mock.ts goes on with its own routes) */
export function v11Route(method: string, path: string, q: URLSearchParams, ctx: V11Ctx): Outcome | null {
  const get = method === 'GET';
  if (path === '/markets-hub') return get ? hubList(ctx, q) : refuse();
  if (path === '/markets-hub/underlyings') return underlyings(ctx);
  if (path.startsWith('/markets-hub/underlyings/')) { const u = decodeURIComponent(path.slice('/markets-hub/underlyings/'.length)).toUpperCase();
    const rows = ctx.markets().filter((m) => m.inst.base === u).map((m) => hubRow(m.inst, m.ticker, ctx.venueName(m.inst.venue), ctx.now));
    return rows.length ? ok({ underlying: u, category: 'crypto', spot: [], instruments: rows, notCompared: [], errors: [] }) : { status: 404, json: { error: 'unknown_underlying', message: 'unknown underlying' } }; }
  if (path.startsWith('/markets-hub/')) return refuse();
  if (path === '/private-markets') return ok({ markets: [], companies: [], excluded: [], venues: [], venuesWithoutAdapter: [], notice: { tradable: false, code: 'display_only', text: '' }, filter: { delisted: q.get('delisted') === 'true' || q.get('delisted') === '1' },
    position: { side: q.get('side') === 'short' ? 'short' : 'long', size: q.get('size') ?? '1' }, ts: ctx.now });
  if (path.startsWith('/private-markets/')) return { status: 404, json: { error: 'unknown_market', message: 'mock mode: no private market is simulated' } };
  if (path === '/risk/state' && get) return ok({ switches: { killSwitch: switchOff, readOnly: switchOff }, limits: { paper: noLimits('paper'), live: noLimits('live') },
    exposure: { paper: emptyBook('paper'), live: emptyBook('live-mainnet'), liveTestnet: emptyBook('live-testnet') }, decisions: [], locks: [] });
  if (path === '/mandates' && get) return ok({ mandates: [] });
  if (path.startsWith('/risk/') || path.startsWith('/mandates')) return refuse();
  if (path === '/trading/orders' && get) return ok({ orders: [], nextCursor: null, ts: ctx.now });
  if (path === '/trading/positions' && get) return ok({ positions: [], errors: [], ts: ctx.now });
  if (path.startsWith('/trading/')) return refuse();
  if (path === '/dashboard/status') return ok({ ts: ctx.now, switches: unavailable, liveLimits: unavailable });
  if (path === '/dashboard/summary') return ok({ ts: ctx.now, books: { paper: unavailable, live: unavailable, liveTestnet: unavailable }, risk: unavailable, agents: unavailable, agentsPnl: unavailable, health: unavailable, audit: unavailable });
  if (path === '/dashboard/activity') return ok({ items: [], nextCursor: null, errors: [], audit: null, bounds: { perSource: 0, plans: 0 }, kinds: [], ts: ctx.now });
  if (path.startsWith('/dashboard/')) return refuse();
  // what the shell and Home ask on every visit: an empty wallet rather than an « offline » page
  if (path === '/portfolio') return ok({ asOf: new Date(ctx.now).toISOString(), pricesAsOf: null, pricesStale: false, prices: null, balances: [], pending: [], halted: false });
  if (path === '/networks') return ok([]);
  if (path === '/accounts') return ok({ keyId: 'mock', signerReachable: true, accounts: [] });
  if (path === '/agents' && get) return ok({ agents: [] });
  if (path === '/activity') return ok({ items: [] });
  if (path === '/plans' && get) return ok({ plans: [] });
  if (path === '/alerts' && get) return ok({ items: [] });
  if (path === '/security/audit') return ok({ events: [], intact: true, brokenAt: null, total: 0 });
  return null;
}

/**
 * The quote engine's websocket in mock mode: it never opens. The close is dispatched on the next task — nothing goes to the
 * network, so the browser logs nothing — and the client counts a failed connection; after three it says `fallback`.
 */
export class MockQuoteSocket {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null; onmessage: ((ev: { data: unknown }) => void) | null = null; onclose: ((ev: { code?: number }) => void) | null = null; onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) { setTimeout(() => { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code: 1006 }); }, 30); }
  send(): void { /* never open */ }
  close(): void { this.readyState = 3; }
  addEventListener(): void { /* the quote client uses the on* handlers */ }
  removeEventListener(): void { /* idem */ }
}
export const isQuoteStream = (url: string): boolean => { try { return new URL(url, location.origin).pathname === '/api/v1/stream'; } catch { return false; } };
