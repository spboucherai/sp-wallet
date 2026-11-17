/**
 * V11 Markets explorer and venue comparator — typed client of `/api/v1/markets-hub/*` and the pure helpers of the two screens
 * (no React here: everything below is tested without a browser, apps/web/test/markets.test.ts).
 *
 * READ-ONLY: every route is a GET on public market data. Nothing here places, prepares or signs anything.
 * Amounts typed by the owner go through the wallet's single amount rule (`amount.ts`).
 */
import { get } from './api';
import { parseAmountInput, type AmountLocale } from './amount';
import { venueShown } from './venues';

export type Category = 'crypto' | 'equity' | 'pre_ipo' | 'commodity' | 'fx';
export const CATEGORIES: readonly Category[] = ['crypto', 'equity', 'pre_ipo', 'commodity', 'fx'];
export const HUB_VENUES = ['hyperliquid', 'gmx', 'dydx', 'edgex'] as const;
/** the venues the owner is offered (venues.ts): filters, stream status */
export const SHOWN_HUB_VENUES: readonly (typeof HUB_VENUES)[number][] = HUB_VENUES.filter(venueShown);
export type HubSort = 'volume' | 'openInterest' | 'funding' | 'change' | 'symbol';
export interface HubFunding { rate: string; intervalSec: number; perHour: string; annualised: string }
export interface HubRow {
  id: string; kind: 'spot' | 'perp'; venue: string; venueName: string; symbol: string; base: string; quote: string; status: string;
  underlying: string | null; category: Category | null; multiplier: string | null; mapping: { rule: string | null; unmapped: string | null; note: string };
  price: string | null; priceKind: 'mark' | 'close_1h'; unitPrice: string | null; change24h: string | null; volume24hUsd: string | null; funding: HubFunding | null;
  openInterest: string | null; openInterestUsd: string | null; maxLeverage: string | null;
  tradable: boolean; tradableReason: string | null; paper: boolean; restriction: string | null;
  sourceTs: number | null; ageMs: number | null; stale: boolean; staleAfterMs: number; source: string;
  networks?: { network: string; asset: string }[]; priceSource?: string | null; priceOutlier?: boolean;
}
export interface HubVenue { id: string; name: string; status: 'ok' | 'stale' | 'error'; rows: number; ageMs: number | null; restriction: string | null; error: string | null }
export interface HubList { rows: HubRow[]; total: number; offset: number; limit: number; counts: { spot: number; perp: number; tradable: number; stale: number }; venues: HubVenue[]; errors: { source: string; message: string }[];
  locks: { id: string; on: boolean }[]; cache: { ageMs: number; ttlMs: number }; ts: number }
export interface HubUnderlying { underlying: string; category: Category | null; venues: string[]; instruments: number; comparable: boolean; volume24hUsd: string | null }
export interface UnderlyingDetail { underlying: string; category: Category | null; spot: HubRow[]; instruments: HubRow[]; notCompared: HubRow[]; errors: { source: string; message: string }[] }

export interface Figure { value: string | null; reason: string | null; basis: string | null }
export const COST_ITEMS = ['entrySlippageUsd', 'exitSlippageUsd', 'entryFeeUsd', 'exitFeeUsd', 'fundingUsd'] as const;
export type CostItem = (typeof COST_ITEMS)[number];
export interface VenueCost extends Record<CostItem, Figure> {
  executionModel: 'order_book' | 'pool'; midPrice: Figure; spreadBps: Figure; sizeBase: Figure; entryAvgPrice: Figure; entrySlippageBps: Figure; fundingRatePerHour: Figure;
  collateralRequiredUsd: Figure; liquidationPrice: Figure; liquidationDistanceBps: Figure; maxLeverage: Figure; totalCostUsd: Figure; totalCostBps: Figure; missing: CostItem[]; assumptions: string[];
}
export interface DepthLevel { bps: string; bidUsd: string; askUsd: string; bidComplete: boolean; askComplete: boolean }
export interface CompareRow {
  venue: string; venueName: string; instrument: string; symbol: string; underlying: string; multiplier: string; alternatives: string[];
  tradable: boolean; tradableReason: string | null; restriction: string | null; price: { mark: string | null; index: string | null; mid: string | null };
  depth: DepthLevel[] | null; depthReason: string | null; fees: { takerRate: string; makerRate: string; source: string; asOf: string } | null;
  funding: { rate: string; intervalSec: number; perHour: string; annualised: string; assumption: string } | null; maintenance: { fraction: string; basis: string } | null;
  cost: VenueCost | null; priceOutlier: boolean; ageMs: number | null; stale: boolean; staleAfterMs: number; error: string | null;
}
export interface Coded { code: string; text: string }
export interface Discrepancy { longVenue: string; shortVenue: string; longInstrument: string; shortInstrument: string; grossGapBps: string | null; netEdgeEstimateBps: string | null;
  costsUsd: { feesUsd: string; exitSlippageUsd: string; fundingUsd: string } | null; flagged: boolean; reason: string | null; actionableFromWallet: boolean; assumptions: Coded[]; risks: Coded[] }
export interface CompareAnswer { underlying: string; category: string | null; request: Record<string, unknown>; rows: CompareRow[]; discrepancies: Discrepancy[]; texts: { disclaimer: string; discrepancy: string; assumptions: Coded[] };
  warnings: string[]; errors: { source: string; message: string }[]; ts: number }

// ---------------------------------------------------------------------------------------------------------------- client
export interface HubFilters { kind: 'spot' | 'perp'; venue: string; category: Category | ''; q: string; tradable: '' | 'yes' | 'no'; sort: HubSort; dir: 'asc' | 'desc'; limit: number; offset: number }
export const defaultFilters = (kind: 'spot' | 'perp' = 'perp'): HubFilters => ({ kind, venue: '', category: '', q: '', tradable: '', sort: 'volume', dir: 'desc', limit: 50, offset: 0 });
/** the query string of a filter set: empty filters are left out, the search is trimmed */
export function hubQuery(f: HubFilters): string {
  const p: [string, string][] = [['kind', f.kind], ['venue', f.kind === 'spot' ? '' : f.venue], ['category', f.kind === 'spot' ? '' : f.category], ['q', f.q.trim().slice(0, 40)], ['tradable', f.tradable], ['sort', f.sort], ['dir', f.dir],
    ['limit', String(f.limit)], ['offset', String(f.offset)]];
  return `?${p.filter(([, v]) => v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}
/** a click on a column: the same column flips the direction; another one starts descending (ascending for the name) */
export const nextSort = (f: Pick<HubFilters, 'sort' | 'dir'>, col: HubSort): Pick<HubFilters, 'sort' | 'dir' | 'offset'> =>
  ({ sort: col, dir: f.sort === col ? (f.dir === 'desc' ? 'asc' : 'desc') : col === 'symbol' ? 'asc' : 'desc', offset: 0 });
export interface CompareParams { underlying: string; side: 'long' | 'short'; notional: string; leverage: string; horizonHours: string }
export const compareQuery = (p: CompareParams): string => `?underlying=${encodeURIComponent(p.underlying)}&side=${p.side}&notional=${p.notional}&leverage=${p.leverage}&horizonHours=${p.horizonHours}`;

export const mapi = {
  list: (f: HubFilters) => get<HubList>(`/markets-hub${hubQuery(f)}`),
  underlyings: async (): Promise<HubUnderlying[]> => { const j = await get<{ underlyings: HubUnderlying[] }>('/markets-hub/underlyings'); return Array.isArray(j.underlyings) ? j.underlyings : []; },
  underlying: (symbol: string) => get<UnderlyingDetail>(`/markets-hub/underlyings/${encodeURIComponent(symbol)}`),
  compare: (p: CompareParams) => get<CompareAnswer>(`/markets-hub/compare${compareQuery(p)}`),
};

// ---------------------------------------------------------------------------------------------------------------- the comparator's form
export interface CompareForm { underlying: string; side: 'long' | 'short'; notional: string; leverage: string; horizon: string }
export const defaultCompareForm = (underlying = 'BTC'): CompareForm => ({ underlying, side: 'long', notional: '1000', leverage: '3', horizon: '24' });
export type FormProblem = { field: 'notional' | 'leverage' | 'horizon'; error: 'empty' | 'invalid' | 'ambiguous' | 'too_many_decimals' | 'range' };
export const COMPARE_BOUNDS = { notionalMax: 1_000_000_000, leverageMax: 200, horizonMax: 8760 } as const;
/**
 * What the form sends, or the first field that cannot be read. The three numbers go through the wallet's single amount rule
 * (`parseAmountInput`): « 1 000,50 » and "1,000.50" are both one thousand and a half; a text the rule calls ambiguous ("1,000" on an English
 * screen) is refused, never guessed.
 */
export function compareParams(f: CompareForm, locale: AmountLocale): { ok: true; params: CompareParams } | { ok: false; problem: FormProblem } {
  const read = (field: FormProblem['field'], text: string, maxDecimals: number, max: number, zeroOk: boolean): string | FormProblem => {
    const r = parseAmountInput(text, locale, { maxDecimals });
    if (!r.ok) return { field, error: r.error };
    const n = Number(r.value);
    return (zeroOk ? n < 0 : n <= 0) || n > max ? { field, error: 'range' } : r.value;
  };
  const notional = read('notional', f.notional, 8, COMPARE_BOUNDS.notionalMax, false); if (typeof notional !== 'string') return { ok: false, problem: notional };
  const leverage = read('leverage', f.leverage, 8, COMPARE_BOUNDS.leverageMax, false); if (typeof leverage !== 'string') return { ok: false, problem: leverage };
  const horizon = read('horizon', f.horizon, 4, COMPARE_BOUNDS.horizonMax, true); if (typeof horizon !== 'string') return { ok: false, problem: horizon };
  return { ok: true, params: { underlying: f.underlying, side: f.side, notional, leverage, horizonHours: horizon } };
}

// ---------------------------------------------------------------------------------------------------------------- reading a row
/** how fresh a row is: `fresh` under half its bound, `aging` under the bound, `stale` beyond it or when the server says so, `none` without a figure */
export function freshness(r: Pick<HubRow, 'ageMs' | 'stale' | 'staleAfterMs' | 'price'>): 'fresh' | 'aging' | 'stale' | 'none' {
  if (r.price === null || r.ageMs === null) return 'none';
  if (r.stale || r.ageMs > r.staleAfterMs) return 'stale';
  return r.ageMs > r.staleAfterMs / 2 ? 'aging' : 'fresh';
}
/** « 12 s », « 4 min », « 3 h », « 2 j » */
export const ageLabel = (ms: number | null, locale: string): string => (ms === null ? '—' : ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : ms < 172_800_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 86_400_000)} ${locale === 'fr' ? 'j' : 'd'}`);

/** reason codes of `tradableReason` that have a sentence in i18n (`mkWhy_<code>`); anything else falls back to `mkWhy_other` */
export const TRADABLE_REASONS = ['dydx_jurisdiction', 'edgex_jurisdiction', 'hl_builder_dex', 'hl_asset_not_pinned', 'gmx_market_not_pinned', 'instrument_halted', 'instrument_reduce_only', 'spot_no_swap_route', 'spot_cash_leg'] as const;
export const reasonKey = (code: string | null): string => `mkWhy_${code !== null && (TRADABLE_REASONS as readonly string[]).includes(code) ? code : 'other'}`;
export const UNMAPPED_REASONS = ['bad_ticker', 'builder_dex_unreviewed', 'multiplier_unreviewed', 'no_category_metadata', 'ticker_not_reviewed', 'ticker_in_two_asset_classes'] as const;
export const unmappedKey = (code: string | null): string => `mkUnmapped_${code !== null && (UNMAPPED_REASONS as readonly string[]).includes(code) ? code : 'other'}`;
/** codes of the comparator's own sentences (`texts.assumptions`, a discrepancy's `assumptions` and `risks`) → `cpText_<code>` */
export const TEXT_CODES = ['cost_1', 'cost_2', 'cost_3', 'cost_4', 'cost_5', 'cost_6', 'pool_1', 'pool_2', 'price_guard', 'not_tradable',
  'disc_assume_1', 'disc_assume_2', 'disc_assume_3', 'disc_assume_4', 'disc_assume_5', 'disc_assume_6', 'disc_risk_1', 'disc_risk_2', 'disc_risk_3', 'disc_risk_4', 'disc_risk_5', 'disc_risk_6'] as const;
/** the i18n key of a coded sentence, or null: the server's own sentence is then shown as it is */
export const textKey = (code: string): string | null => ((TEXT_CODES as readonly string[]).includes(code) ? `cpText_${code}` : null);

/**
 * Where a tap on a row leads:
 *   spot → the existing Asset screen (first network of the registry asset);
 *   a perp the wallet can trade, or can paper-trade → the Futures terminal on that instrument;
 *   anything else → a read-only market sheet (chart, book, funding) — never an order form.
 */
export type RowTarget = { kind: 'asset'; network: string; asset: string } | { kind: 'futures'; instrument: string } | { kind: 'sheet'; instrument: string };
export function rowTarget(r: Pick<HubRow, 'kind' | 'id' | 'tradable' | 'networks'>): RowTarget {
  if (r.kind === 'spot') { const n = r.networks?.[0]; return n ? { kind: 'asset', network: n.network, asset: n.asset } : { kind: 'sheet', instrument: r.id }; }
  return r.tradable ? { kind: 'futures', instrument: r.id } : { kind: 'sheet', instrument: r.id };
}

/** the five cost components of a row, in the order of the total; `usd` null carries its reason */
export function costItems(c: VenueCost | null): { id: CostItem; usd: string | null; reason: string | null; basis: string | null }[] {
  return COST_ITEMS.map((id) => ({ id, usd: c?.[id]?.value ?? null, reason: c ? c[id]?.reason ?? null : null, basis: c?.[id]?.basis ?? null }));
}
/** fraction → « 10,95 % » without float formatting surprises on the sign (a negative zero never shows) */
export function pctText(fraction: string | null, dp: number, locale: string, sign = false): string {
  if (fraction === null || !Number.isFinite(Number(fraction))) return '—';
  const v = Number(fraction) * 100, r = Number(v.toFixed(dp));
  const s = new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { minimumFractionDigits: dp, maximumFractionDigits: dp }).format(Math.abs(r));
  return `${r < 0 ? '−' : sign && r > 0 ? '+' : ''}${s} %`;
}
/** the pairs worth showing: those with an estimate first (highest first, as the server sorts them), at most `n` */
export const topDiscrepancies = (d: readonly Discrepancy[], n = 4): Discrepancy[] => d.filter((x) => x.netEdgeEstimateBps !== null).slice(0, n);
/** the words the two screens must never use about an estimate (the test greps the i18n block and the API texts) */
export const FORBIDDEN_WORDING = /profit|guarant|risk[- ]?free|riskless|sans risque|garanti|b[ée]n[ée]fice|gain assur/i;
