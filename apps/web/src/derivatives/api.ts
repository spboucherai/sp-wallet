/**
 * Typed client of the derivatives routes — exactly the table "API contract (wave 2: read-only and paper)" of
 * docs/v4/DERIVATIVES-ARCHITECTURE.md, nothing else. There is no live-trading call in this file: those are in `live.ts`.
 *
 * Where the table leaves a shape open, the expectation is written next to the call and a small normaliser accepts the obvious
 * variants, so a backend deviation shows up as a missing value («—») rather than a crash:
 * Reconciled with the backend (docs/v4/API-WAVE2-NOTES.md, services/api/src/derivatives/routes.ts):
 *  - timestamps are milliseconds since the epoch;
 *  - `instruments`, `tickers`, `compare` carry `errors: [{ venue, message }]` when a venue could not be read (the others are
 *    still answered); `market` carries `errors: { book?, trades?, liquidity? }`;
 *  - `compare.rows[]`: `funding` per hour (what longs pay), `fundingVenue: { rate, intervalSec }`, `depthUsd1pct` (+ bid / ask),
 *    `restriction`;
 *  - `accounts/:id` is flat: the account fields + `orders`, `fills`, `funding`,
 *    `riskEvents: [{ id, ts, kind, code, message, data }]`, `equity: [{ ts, equity, … }]`;
 *  - preview → `{ risk, estimate, request, ts }`; `estimate.liquidationPrice` is `{ value, source: 'estimate', method } | null`;
 *  - a market order may send `price: null` + `slippageBps`: the server derives the worst price from the book;
 *  - a risk-engine refusal is HTTP 422 `{ error: <risk code>, message }`; a PAPER-ENGINE rejection is HTTP 200 with
 *    `order.status: 'rejected'` and `order.rejectReason`;
 *  - `Idempotency-Key` (8–100 chars of [A-Za-z0-9._:-]) on order placement and on close; a `clientId` in the body is refused.
 */
import { ApiError, get, post } from '../api';
import { numToDecStr } from './dec';
import type { AccountDetail, Candle, CompareRow, DerivAccount, FundingHistory, Instrument, Interval, Market, OrderBody, Placed, Preview, RiskCode, RiskPolicy, Ticker, VenueId, VenueInfo, VenueReadError, Watch } from './types';

const B = '/derivatives';
const qs = (o: Record<string, string | number | undefined>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  return p ? `?${p}` : '';
};
const ms = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && !Number.isNaN(Date.parse(x)) ? Date.parse(x) : null);
const ds = (x: unknown): string | null => (typeof x === 'string' ? x : typeof x === 'number' && Number.isFinite(x) ? numToDecStr(x) : null);
const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);

function normCompare(r: any): CompareRow {
  return { venue: r.venue, instrument: r.instrument, mark: ds(r.mark) ?? '0', index: ds(r.index), funding: ds(r.funding),
    fundingVenue: { rate: ds(r.fundingVenue?.rate), intervalSec: typeof r.fundingVenue?.intervalSec === 'number' ? r.fundingVenue.intervalSec : null },
    spreadBps: ds(r.spreadBps), depthUsd1pct: ds(r.depthUsd1pct), depthBidUsd1pct: ds(r.depthBidUsd1pct), depthAskUsd1pct: ds(r.depthAskUsd1pct), restriction: r.restriction ?? null,
    takerFeeBps: ds(r.takerFeeBps), maxLeverage: ds(r.maxLeverage) ?? '1',
    collateral: String(r.collateral ?? ''), settlement: String(r.settlement ?? ''), notes: arr<string>(r.notes) };
}
function normDetail(j: any): AccountDetail {
  const a = j;
  return { ...(a as DerivAccount), positions: arr(a.positions), openOrders: arr(a.openOrders), orders: arr(a.orders), fills: arr(a.fills), funding: arr(a.funding),
    riskEvents: arr<any>(a.riskEvents).map((e) => ({ id: String(e.id ?? `${e.ts}${e.kind}`), ts: ms(e.ts) ?? 0, kind: String(e.kind ?? 'event'), code: typeof e.code === 'string' ? e.code : null,
      instrument: typeof e.data?.instrument === 'string' ? e.data.instrument : typeof e.data?.request?.instrument === 'string' ? e.data.request.instrument : null, detail: String(e.message ?? '') })),
    equityHistory: arr<any>(a.equity).map((p) => ({ ts: ms(p.ts) ?? 0, equity: ds(p.equity) ?? '0' })) };
}

export const dapi = {
  venues: async (): Promise<VenueInfo[]> => arr<any>((await get(`${B}/venues`)).venues).map((v) => ({ ...v, lastOkAt: ms(v.lastOkAt), restriction: v.restriction ?? null })),
  /** all venues when `venue` is absent; a venue that cannot be read is in `errors`, the others are still listed */
  instruments: async (venue?: VenueId): Promise<{ instruments: Instrument[]; errors: VenueReadError[] }> => { const j = await get(`${B}/instruments${qs({ venue })}`); return { instruments: arr(j.instruments), errors: arr(j.errors) }; },
  tickers: async (venue?: VenueId): Promise<{ tickers: Ticker[]; ts: number; errors: VenueReadError[] }> => { const j = await get(`${B}/tickers${qs({ venue })}`); return { tickers: arr(j.tickers), ts: ms(j.ts) ?? Date.now(), errors: arr(j.errors) }; },
  market: async (instrument: string): Promise<Market> => { const j = await get(`${B}/market${qs({ instrument })}`); return { instrument: j.instrument, ticker: j.ticker, book: j.book ?? null, liquidity: j.liquidity ?? null, trades: arr(j.trades), errors: j.errors ?? {} }; },
  candles: async (instrument: string, interval: Interval, limit: number): Promise<Candle[]> => arr((await get(`${B}/candles${qs({ instrument, interval, limit })}`)).candles),
  funding: async (instrument: string, hours: number): Promise<FundingHistory> => { const j = await get(`${B}/funding${qs({ instrument, hours })}`); return { history: arr(j.history), intervalSec: Number(j.intervalSec) || 3600 }; },
  /** Server-Sent Events: `status` `{ status, ts }` (first event), `ticker` (Ticker), `book` (Book), `trades` `{ instrument, trades }`, `error` `{ message, ts }` */
  streamUrl: (instrument: string): string => `/api/v1${B}/stream${qs({ instrument })}`,
  compare: async (base: string): Promise<{ rows: CompareRow[]; errors: VenueReadError[] }> => { const j = await get(`${B}/compare${qs({ base })}`); return { rows: arr<any>(j.rows).map(normCompare), errors: arr(j.errors) }; },
  accounts: async (): Promise<DerivAccount[]> => arr((await get(`${B}/accounts`)).accounts),
  /** always creates a PAPER account (collateral between 10 and 1 000 000 000); answers the account detail */
  createAccount: async (body: { venue: VenueId; label: string; collateral: string; policy?: Partial<RiskPolicy> }): Promise<DerivAccount> => (await post(`${B}/accounts`, body)) as DerivAccount,
  account: async (id: string): Promise<AccountDetail> => normDetail(await get(`${B}/accounts/${encodeURIComponent(id)}`)),
  setPolicy: (id: string, policy: RiskPolicy) => post(`${B}/accounts/${encodeURIComponent(id)}/policy`, policy),
  preview: async (id: string, body: OrderBody): Promise<Preview> => { const j = await post(`${B}/accounts/${encodeURIComponent(id)}/orders/preview`, body); return { risk: j.risk, estimate: j.estimate ?? null, request: j.request ?? null }; },
  placeOrder: async (id: string, body: OrderBody, key: string): Promise<Placed> => { const j = await post(`${B}/accounts/${encodeURIComponent(id)}/orders`, body, { 'idempotency-key': key }); return { order: j.order, fills: arr(j.fills) }; },
  cancel: (id: string, clientId: string) => post(`${B}/accounts/${encodeURIComponent(id)}/orders/${encodeURIComponent(clientId)}/cancel`),
  /** a reduce-only market order; the server bounds it at `slippageBps` (default 50) from the book */
  close: async (id: string, instrument: string, fraction: string, key: string): Promise<Placed> => { const j = await post(`${B}/accounts/${encodeURIComponent(id)}/close`, { instrument, fraction }, { 'idempotency-key': key }); return { order: j.order, fills: arr(j.fills) }; },
  reset: (id: string) => post(`${B}/accounts/${encodeURIComponent(id)}/reset`),
  watch: async (account: string, venue: VenueId): Promise<Watch> => { const j = await get(`${B}/watch${qs({ account, venue })}`); return { state: j.state, positions: arr(j.positions), openOrders: arr(j.openOrders) }; },
};

/** codes of packages/derivatives/src/risk.ts (`RISK_CODES`): each has its sentence in i18n (`rk_<code>`) */
export const RISK_CODES: ReadonlySet<string> = new Set(['bad_policy', 'bad_order', 'bad_input', 'mode_read_only', 'halted', 'instrument_mismatch', 'instrument_not_allowed', 'instrument_halted', 'instrument_reduce_only',
  'data_mismatch', 'stale_ticker', 'stale_book', 'price_required', 'trigger_required', 'bad_mark', 'price_deviation', 'mark_index_divergence', 'price_not_on_tick', 'size_not_on_lot', 'below_min_size', 'below_min_notional',
  'reduce_only_would_increase', 'reduce_only_would_flip', 'leverage_exceeded', 'order_notional_exceeded', 'gross_exposure_exceeded', 'position_notional_exceeded', 'insufficient_collateral', 'liquidation_too_close',
  'daily_loss_exceeded', 'total_loss_exceeded', 'order_rate_minute', 'order_rate_day', 'duplicate_client_id']);
/** the risk engine's refusal carried by a 422 answer, or null when the error is something else */
export function riskRefusal(e: unknown): { code: RiskCode | string; reason: string } | null {
  if (!(e instanceof ApiError) || e.status !== 422 || !RISK_CODES.has(e.code)) return null;   // other 422s (no_position, paper_unsupported…) are ordinary errors
  return { code: e.code, reason: e.message === 'error' ? '' : e.message };
}
/** paper trading is offered on a venue that has market data, orders and no restriction (or says so itself with `paper`) */
export const paperAllowed = (v: VenueInfo | undefined): boolean => !!v && (v.paper ?? (v.capabilities?.marketData === true && v.capabilities?.orders === true && !v.restriction));
