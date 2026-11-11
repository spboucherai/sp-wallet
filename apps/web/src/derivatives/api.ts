/**
 * Typed client of the derivatives routes — exactly the table "API contract (wave 2: read-only and paper)" of
 * docs/v4/DERIVATIVES-ARCHITECTURE.md, nothing else. There is no live-trading call in this file because there is no such route.
 *
 * Where the table leaves a shape open, the expectation is written next to the call and a small normaliser accepts the obvious
 * variants, so a backend deviation shows up as a missing value («—») rather than a crash:
 *  - timestamps: milliseconds since the epoch (ISO strings are accepted);
 *  - `venues[].lastOkAt`: ms or ISO or null;
 *  - `compare.rows[].funding`: per-hour decimal string, with `fundingIntervalSec` beside it — or an object
 *    `{ perHour, intervalSec }`; `spreadBps`, `depthUsd1pct`, `takerFeeBps`: decimal strings (JSON numbers are accepted);
 *  - `accounts/:id`: `{ account: {…}, orders, fills, funding, riskEvents, equityHistory }` — or the same fields flat;
 *    `riskEvents[]`: `{ ts, kind, instrument?, detail }` (also `message` / `reason`); `equityHistory[]`: `{ ts, equity }`;
 *  - preview `estimate.liquidationPrice`: `{ value: DecStr | null, source: 'estimate', method }` or null;
 *  - refusal of an order: HTTP 422, body `{ error: <risk code>, message: <reason> }` (also `{ code, reason }` or `{ risk: {…} }`);
 *  - `Idempotency-Key` header on order placement and on close.
 */
import { ApiError, get, post } from '../api';
import { numToDecStr } from './dec';
import type { AccountDetail, Candle, CompareRow, DerivAccount, FundingHistory, Instrument, Interval, Market, OrderBody, Placed, Preview, RiskCode, RiskPolicy, Ticker, VenueId, VenueInfo, Watch } from './types';

const B = '/derivatives';
const qs = (o: Record<string, string | number | undefined>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  return p ? `?${p}` : '';
};
const ms = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && !Number.isNaN(Date.parse(x)) ? Date.parse(x) : null);
const ds = (x: unknown): string | null => (typeof x === 'string' ? x : typeof x === 'number' && Number.isFinite(x) ? numToDecStr(x) : null);
const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);

function normCompare(r: any): CompareRow {
  const f = r?.funding;
  const obj = f !== null && typeof f === 'object';
  return { venue: r.venue, instrument: r.instrument, mark: ds(r.mark) ?? '0', index: ds(r.index),
    funding: obj ? ds(f.perHour ?? f.rate ?? f.value) : ds(f),
    fundingIntervalSec: (obj ? f.intervalSec : undefined) ?? r.fundingIntervalSec ?? null,
    spreadBps: ds(r.spreadBps), depthUsd1pct: ds(r.depthUsd1pct), takerFeeBps: ds(r.takerFeeBps), maxLeverage: ds(r.maxLeverage) ?? '1',
    collateral: String(r.collateral ?? ''), settlement: String(r.settlement ?? ''), notes: arr<string>(r.notes) };
}
function normDetail(j: any): AccountDetail {
  const a = j?.account && typeof j.account === 'object' ? { ...j, ...j.account } : j;
  return { ...(a as DerivAccount), positions: arr(a.positions), openOrders: arr(a.openOrders), orders: arr(a.orders), fills: arr(a.fills), funding: arr(a.funding),
    riskEvents: arr<any>(a.riskEvents).map((e) => ({ ts: ms(e.ts ?? e.at ?? e.createdAt) ?? 0, kind: String(e.kind ?? e.type ?? e.code ?? 'event'), instrument: e.instrument ?? null, detail: String(e.detail ?? e.message ?? e.reason ?? '') })),
    equityHistory: arr<any>(a.equityHistory).map((p) => ({ ts: ms(p.ts ?? p.at) ?? 0, equity: ds(p.equity) ?? '0' })) };
}

export const dapi = {
  venues: async (): Promise<VenueInfo[]> => arr<any>((await get(`${B}/venues`)).venues).map((v) => ({ ...v, lastOkAt: ms(v.lastOkAt), restriction: v.restriction ?? null })),
  instruments: async (venue?: VenueId): Promise<Instrument[]> => arr((await get(`${B}/instruments${qs({ venue })}`)).instruments),
  tickers: async (venue?: VenueId): Promise<{ tickers: Ticker[]; ts: number }> => { const j = await get(`${B}/tickers${qs({ venue })}`); return { tickers: arr(j.tickers), ts: ms(j.ts) ?? Date.now() }; },
  market: async (instrument: string): Promise<Market> => { const j = await get(`${B}/market${qs({ instrument })}`); return { instrument: j.instrument, ticker: j.ticker, book: j.book ?? null, liquidity: j.liquidity ?? null, trades: arr(j.trades) }; },
  candles: async (instrument: string, interval: Interval, limit: number): Promise<Candle[]> => arr((await get(`${B}/candles${qs({ instrument, interval, limit })}`)).candles),
  funding: async (instrument: string, hours: number): Promise<FundingHistory> => { const j = await get(`${B}/funding${qs({ instrument, hours })}`); return { history: arr(j.history), intervalSec: Number(j.intervalSec) || 3600 }; },
  /** Server-Sent Events: `ticker` (Ticker), `book` (Book), `trades` (PublicTrade[] or one PublicTrade), `status` (`{ status }` or the bare word) */
  streamUrl: (instrument: string): string => `/api/v1${B}/stream${qs({ instrument })}`,
  compare: async (base: string): Promise<CompareRow[]> => arr<any>((await get(`${B}/compare${qs({ base })}`)).rows).map(normCompare),
  accounts: async (): Promise<DerivAccount[]> => arr((await get(`${B}/accounts`)).accounts),
  /** always creates a PAPER account */
  createAccount: async (body: { venue: VenueId; label: string; collateral: string; policy?: Partial<RiskPolicy> }): Promise<DerivAccount> => { const j = await post(`${B}/accounts`, body); return (j.account ?? j) as DerivAccount; },
  account: async (id: string): Promise<AccountDetail> => normDetail(await get(`${B}/accounts/${encodeURIComponent(id)}`)),
  setPolicy: (id: string, policy: RiskPolicy) => post(`${B}/accounts/${encodeURIComponent(id)}/policy`, policy),
  preview: async (id: string, body: OrderBody): Promise<Preview> => { const j = await post(`${B}/accounts/${encodeURIComponent(id)}/orders/preview`, body); return { risk: j.risk, estimate: j.estimate ?? null }; },
  placeOrder: async (id: string, body: OrderBody, key: string): Promise<Placed> => { const j = await post(`${B}/accounts/${encodeURIComponent(id)}/orders`, body, { 'idempotency-key': key }); return { order: j.order, fills: arr(j.fills) }; },
  cancel: (id: string, clientId: string) => post(`${B}/accounts/${encodeURIComponent(id)}/orders/${encodeURIComponent(clientId)}/cancel`),
  close: async (id: string, instrument: string, fraction: string, key: string): Promise<Placed> => { const j = await post(`${B}/accounts/${encodeURIComponent(id)}/close`, { instrument, fraction }, { 'idempotency-key': key }); return { order: j.order, fills: arr(j.fills) }; },
  reset: (id: string) => post(`${B}/accounts/${encodeURIComponent(id)}/reset`),
  watch: async (account: string, venue: VenueId): Promise<Watch> => { const j = await get(`${B}/watch${qs({ account, venue })}`); return { state: j.state ?? j.account, positions: arr(j.positions), openOrders: arr(j.openOrders) }; },
};

/** the risk engine's refusal carried by a 422 answer, or null when the error is something else */
export function riskRefusal(e: unknown): { code: RiskCode | string; reason: string } | null {
  if (!(e instanceof ApiError) || e.status !== 422) return null;
  const b = (e.body ?? {}) as any;
  const code = b.code ?? b.risk?.code ?? b.error ?? e.code;
  return { code: String(code), reason: String(b.reason ?? b.risk?.reason ?? b.message ?? '') };
}
/** paper trading is offered on a venue that has market data, orders and no restriction (or says so itself with `paper`) */
export const paperAllowed = (v: VenueInfo | undefined): boolean => !!v && (v.paper ?? (v.capabilities?.marketData === true && v.capabilities?.orders === true && !v.restriction));
