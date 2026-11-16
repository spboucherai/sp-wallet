/**
 * V11 Dashboard — typed client of `GET /api/v1/dashboard/summary` and the pure helpers of the panels (no React here:
 * everything below is tested without a browser, apps/web/test/v11-dashboard.test.ts).
 *
 * READ-ONLY. The answer is made of sections that fail on their own: a section is `{ ok: true, data }` or
 * `{ ok: false, error: { code } }` — the panel of a failed source says « indisponible » with the reason, the others show.
 * Paper, testnet and real money are three separate books: nothing here adds a figure of one to a figure of another.
 */
import { get } from './api';

export type Section<T> = { ok: true; data: T; asOf: number } | { ok: false; error: { code: string; message: string } };
export const BOOKS = ['live', 'liveTestnet', 'paper'] as const;   // real money first
export type BookId = (typeof BOOKS)[number];
export interface BookPosition { venue: string; accountId: string; asset: string; instrument: string; side: 'long' | 'short'; size: string; markPrice: string; notional: string; leverage: string;
  liquidationPrice: string | null; liquidationDistanceBps: string | null; unrealizedPnl: string }
export interface BookAccount { venue: string; accountId: string; equity: string; collateral: string; freeCollateral: string; marginUsed: string; shareBps: string | null }
export interface Book { book: string; ts: number; equity: string; grossExposure: string; leverage: string | null;
  byAsset: { asset: string; long: string; short: string; net: string }[]; byVenue: { venue: string; gross: string }[]; collateral: BookAccount[]; positions: BookPosition[]; errors: string[];
  pnl: { realizedToday: string; unrealizedToday: string; realizedInception: string; unrealizedInception: string } }
export interface Switch { on: boolean; at: number | null; reason: string | null }
export interface RiskState { switches: { killSwitch: Switch; readOnly: Switch }; live: { missing: string[]; missingForAutomation: string[]; ownerOrdersRefused: boolean; automationOrdersRefused: boolean } }
export type AgentMode = 'research' | 'paper' | 'live';
export interface Counts { active: number; paused: number; stopped: number }
export interface Agents { count: number; total: Counts; byMode: Record<AgentMode, Counts> }
export interface ModePnl { abs: number | null; agents: number; partial: boolean; reason: 'research_no_pnl' | 'no_snapshot' | null }
export interface AgentsPnl { tz: string; note: string; today: Record<AgentMode, ModePnl> }
export interface Health { signer: { reachable: boolean; halted: boolean | null }; connectors: { total: number; ok: number; notMeasured: number; failing: { id: string; group: string; name: string; lastSuccessAt: number | null }[] }; loops: { total: number; late: string[] } }
export interface Audit { checkedAt: number; total: number; intact: boolean; brokenAt: number | null }
export interface Summary { ts: number; books: Record<BookId, Section<Book>>; risk: Section<RiskState>; agents: Section<Agents>; agentsPnl: Section<AgentsPnl>; health: Section<Health>; audit: Section<Audit> }

export const dashboardApi = { summary: () => get<Summary>('/dashboard/summary') };

/** reason codes of a failed section that have a sentence (`v11DbErr_<code>`); anything else reads as the generic one */
export const ERROR_CODES = ['timeout', 'source_failed', 'service_unavailable', 'signer_unreachable', 'offline'] as const;
export const errKey = (code: string | null | undefined): string => `v11DbErr_${code && (ERROR_CODES as readonly string[]).includes(code) ? code : 'other'}`;

/** a book with nothing in it (no account, no position): shown as one quiet line rather than as empty tables */
export const bookEmpty = (b: Book): boolean => b.collateral.length === 0 && b.positions.length === 0;
/** the position closest to its liquidation price in one book — null when no position has a liquidation price */
export function nearestLiquidation(positions: readonly BookPosition[]): BookPosition | null {
  let best: BookPosition | null = null;
  for (const p of positions) { if (p.liquidationDistanceBps === null || !Number.isFinite(Number(p.liquidationDistanceBps))) continue; if (!best || Number(p.liquidationDistanceBps) < Number(best.liquidationDistanceBps)) best = p; }
  return best;
}
/** under 10 % from liquidation: said in words and with the warning tone */
export const liquidationNear = (bps: string | null): boolean => bps !== null && Number(bps) < 1000;
/** basis points → a fraction string for `pct()` (« 1250 » → « 0.125 ») */
export const bpsToFraction = (bps: string): string => (Number(bps) / 10_000).toFixed(6);
/** the ids of the quote engine for the positions on screen (a venue's own instrument id), without duplicates, at most `max` */
export const quoteIds = (s: Summary | undefined, max = 30): string[] => [...new Set(BOOKS.flatMap((b) => { const x = s?.books[b]; return x?.ok ? x.data.positions.map((p) => p.instrument) : []; }))].slice(0, max);

export type RiskLevel = 'halted' | 'read_only' | 'limits_missing' | 'ok';
/** the one state the risk panel leads with: the kill switch first, then read-only mode, then live limits that are not set */
export const riskLevel = (r: RiskState): RiskLevel => (r.switches.killSwitch.on ? 'halted' : r.switches.readOnly.on ? 'read_only' : r.live.ownerOrdersRefused || r.live.automationOrdersRefused ? 'limits_missing' : 'ok');
export type SystemLevel = 'ok' | 'degraded' | 'down';
/** system status in one word: the signer unreachable or a broken audit chain is `down`; a failing connector or a late loop is `degraded` */
export function systemLevel(h: Section<Health>, a: Section<Audit>): SystemLevel {
  if ((h.ok && !h.data.signer.reachable) || (a.ok && !a.data.intact)) return 'down';
  if (!h.ok || !a.ok || h.data.connectors.failing.length > 0 || h.data.loops.late.length > 0 || h.data.signer.halted === true) return 'degraded';
  return 'ok';
}
