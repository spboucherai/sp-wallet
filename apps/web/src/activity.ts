/**
 * V11 Activity — typed client of `GET /api/v1/dashboard/activity` (one history of every operation: wallet movements, plans,
 * unified orders of every venue and mode, risk denials, and the agent / mandate / key / security events of the audit chain)
 * and the pure helpers of the screen (no React here: apps/web/test/v11-activity.test.ts tests them without a browser).
 * READ-ONLY. The server answers CODES; the sentences are in the `v11Ac` block of i18n.ts.
 */
import { get } from './api';

export const ACTIVITY_KINDS = ['transfer', 'receive', 'swap', 'bridge', 'plan', 'order', 'agent', 'mandate', 'risk', 'key', 'security'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export type ActivityMode = 'live' | 'paper' | 'research' | null;
export interface ActivityItem {
  id: string; kind: ActivityKind; source: 'wallet' | 'plans' | 'orders' | 'decisions' | 'audit'; at: string; mode: ActivityMode; venue: string | null; network: string | null;
  principal: { kind: string; id: string } | null; code: string; params: Record<string, string | number | boolean | null>;
  status: string | null; instrument: string | null; side: string | null; amount: { value: string; symbol: string | null } | null; received: { value: string; symbol: string | null } | null;
  ref: { type: 'proposal' | 'deposit' | 'order' | 'audit' | 'decision' | 'plan'; id: string }; txid: string | null; explorer: string | null;
  /** wallet items: the row of GET /activity itself (the screen keeps its detailed view of it) */
  wallet?: Record<string, unknown>;
}
export interface ActivityPage { items: ActivityItem[]; nextCursor: string | null; errors: { source: string; code: string; message: string }[];
  audit: { intact: boolean; brokenAt: number | null; total: number; checkedAt: number } | null; bounds: { perSource: number; plans: number }; ts: number }
export interface OrderTransition { seq: number; from: string; to: string; event: string; reason: string; detail: string | null; at: number }

// ---------------------------------------------------------------------------------------------------------------- filters
export const RANGES = ['all', 'today', '7d', '30d', 'custom'] as const;
export type Range = (typeof RANGES)[number];
export const PRINCIPALS = ['owner', 'agent', 'api_key', 'system'] as const;
export interface ActivityFilters { kind: ActivityKind | ''; mode: '' | 'live' | 'paper'; venue: string; principal: (typeof PRINCIPALS)[number] | ''; range: Range; /** `custom`: local dates, YYYY-MM-DD */ from: string; to: string }
export const defaultActivityFilters = (): ActivityFilters => ({ kind: '', mode: '', venue: '', principal: '', range: 'all', from: '', to: '' });
export const filtersActive = (f: ActivityFilters): boolean => f.kind !== '' || f.mode !== '' || f.venue !== '' || f.principal !== '' || (f.range !== 'all' && !(f.range === 'custom' && !f.from && !f.to));
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** the instants a range means on THIS device: a day starts and ends at the device's own midnight */
export function rangeBounds(f: Pick<ActivityFilters, 'range' | 'from' | 'to'>, now = Date.now()): { from: string | null; to: string | null } {
  const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d; };
  if (f.range === 'today') return { from: startOfDay(now).toISOString(), to: null };
  if (f.range === '7d' || f.range === '30d') return { from: startOfDay(now - (f.range === '7d' ? 6 : 29) * 86_400_000).toISOString(), to: null };
  if (f.range !== 'custom') return { from: null, to: null };
  const day = (s: string, end: boolean): string | null => { if (!DAY.test(s)) return null; const [y, m, d] = s.split('-').map(Number) as [number, number, number]; const x = end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d); return Number.isFinite(x.getTime()) ? x.toISOString() : null; };
  return { from: day(f.from, false), to: day(f.to, true) };
}
/** the query string of a filter set (empty filters are left out), shared by the list and by the CSV link */
export function activityQuery(f: ActivityFilters, o: { limit?: number; cursor?: string | null; now?: number } = {}): string {
  const b = rangeBounds(f, o.now);
  const p: [string, string][] = [['kind', f.kind], ['mode', f.mode], ['venue', f.venue], ['principal', f.principal], ['from', b.from ?? ''], ['to', b.to ?? ''], ['limit', o.limit ? String(o.limit) : ''], ['cursor', o.cursor ?? '']];
  const s = p.filter(([, v]) => v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return s ? `?${s}` : '';
}
export const PAGE = 50;
export const activityApi = {
  page: (f: ActivityFilters, cursor: string | null) => get<ActivityPage>(`/dashboard/activity${activityQuery(f, { limit: PAGE, cursor })}`),
  order: (id: string) => get<{ order: Record<string, unknown>; fills: unknown[]; history?: OrderTransition[] }>(`/trading/orders/${encodeURIComponent(id)}`),
  csvHref: (f: ActivityFilters) => `/api/v1/dashboard/activity.csv${activityQuery(f)}`,
};
/** how often the first page is re-read while the screen is visible */
export const HEAD_REFRESH_MS = 20_000;
/**
 * NEXT: the first page re-read on the interval, laid over the pages read so far — first, so that `mergePages` keeps ITS version of
 * an item (its newer state). A head older than the pages themselves (they were re-read since) is left out.
 */
export function withHead<P>(pages: readonly P[], head: { page: P; at: number } | null, pagesReadAt: number): P[] {
  return head && pages.length > 0 && head.at > pagesReadAt ? [head.page, ...pages] : [...pages];
}
/** the pages read so far as one list: an item is shown once (a page re-read while the list moves may repeat one) */
export function mergePages(pages: readonly Pick<ActivityPage, 'items'>[]): ActivityItem[] {
  const seen = new Set<string>(), out: ActivityItem[] = [];
  for (const p of pages) for (const i of p.items) if (!seen.has(i.id)) { seen.add(i.id); out.push(i); }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- unified order states
export const ORDER_STATES = ['CREATED', 'VALIDATED', 'AWAITING_APPROVAL', 'APPROVED', 'SUBMITTING', 'SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'FAILED', 'UNKNOWN'] as const;
export type OrderState = (typeof ORDER_STATES)[number];
export type StateTone = 'mute' | 'ok' | 'info' | 'warn' | 'danger';
const STATE_VIEW: Record<OrderState, { tone: StateTone; icon: string }> = {
  CREATED: { tone: 'mute', icon: 'list' }, VALIDATED: { tone: 'info', icon: 'check' }, AWAITING_APPROVAL: { tone: 'warn', icon: 'key' }, APPROVED: { tone: 'info', icon: 'key' },
  SUBMITTING: { tone: 'info', icon: 'up' }, SUBMITTED: { tone: 'info', icon: 'clock' }, PARTIALLY_FILLED: { tone: 'info', icon: 'clock' }, FILLED: { tone: 'ok', icon: 'check' },
  CANCELLED: { tone: 'mute', icon: 'x' }, REJECTED: { tone: 'danger', icon: 'x' }, FAILED: { tone: 'danger', icon: 'x' },
  // UNKNOWN is NOT a failure: the outcome at the venue is being verified — information tone, a clock, never red
  UNKNOWN: { tone: 'info', icon: 'clock' },
};
/** label key, tone and icon of a unified order state; a word this screen does not know is shown as it is, neutral */
export function orderStateView(state: string | null): { key: string | null; tone: StateTone; icon: string; final: boolean } {
  const s = (ORDER_STATES as readonly string[]).includes(state ?? '') ? (state as OrderState) : null;
  return s ? { key: `v11AcOs_${s}`, ...STATE_VIEW[s], final: s === 'FILLED' || s === 'CANCELLED' || s === 'REJECTED' || s === 'FAILED' } : { key: null, tone: 'mute', icon: 'list', final: false };
}
/** how a transition draws in the Timeline: the last one of an order still in flight is the current step; a refusal or a failure is `failed`; UNKNOWN is `current`, never failed */
export function transitionStep(to: string, last: boolean): 'done' | 'current' | 'failed' {
  if (to === 'REJECTED' || to === 'FAILED') return 'failed';
  return last && !orderStateView(to).final ? 'current' : 'done';
}

// ---------------------------------------------------------------------------------------------------------------- titles
/** audit event types that have a sentence (`v11AcEv_<type with dots as underscores>`); another event shows its kind's generic sentence and its code */
export const EVENT_CODES = ['risk.limits_replaced', 'risk.limits_seeded', 'risk.limits_change_prepared', 'risk.auto_replaced', 'halt.on',
  'mandate.created', 'mandate.approved', 'mandate.revoked', 'mandate.approval_refused', 'mandate.integrity_failed', 'mandate.revoke_failed',
  'apikey.created', 'apikey.revoked', 'apikey.rotated', 'apikey.updated', 'apikey.denied', 'apikey.approval_failed', 'webhook.created', 'webhook.deleted', 'webhook.secret_rotated',
  'agent.created', 'agent.start', 'agent.stop', 'agent.stopped', 'agent.mode', 'agent.backtest_requested', 'agent.order_filled', 'agent.order_refused', 'agent.withdraw', 'strategy.registered', 'strategy.approved', 'strategy.backtested',
  'login.ok', 'login.failed', 'owner.setup', 'device.added', 'sessions.revoked', 'deriv.paper.account_created', 'deriv.paper.liquidation', 'deriv.paper.reset', 'deriv.paper.halt', 'deriv.paper.policy_replaced', 'deriv.live.account_created', 'deriv.live.authorized', 'deriv.live.revoked'] as const;
export const eventKey = (code: string): string | null => ((EVENT_CODES as readonly string[]).includes(code) ? `v11AcEv_${code.replace(/\./g, '_')}` : null);
/** a switch event says which way it went: `risk.kill_switch` + `engaged` → `…_on` / `…_off` */
export const switchKey = (i: Pick<ActivityItem, 'code' | 'params'>): string | null => (i.code === 'risk.kill_switch' || i.code === 'risk.read_only' ? `v11AcEv_${i.code.replace(/\./g, '_')}_${i.params.engaged === false ? 'off' : 'on'}` : null);
export const RISK_CHECKS = ['input_valid', 'read_only', 'kill_switch', 'reduce_only_valid', 'venue_allowed', 'instrument_allowed', 'instrument_status', 'signer_status', 'venue_connection',
  'price_freshness', 'price_consistency', 'order_notional', 'daily_notional', 'order_rate_minute', 'order_rate_hour', 'order_rate_day', 'position_size', 'order_leverage', 'account_leverage',
  'gross_exposure', 'net_exposure', 'asset_exposure', 'venue_exposure', 'collateral_concentration', 'daily_loss', 'total_loss', 'drawdown', 'liquidation_distance', 'slippage', 'min_liquidity', 'context_complete'] as const;
export const checkKey = (id: string): string | null => ((RISK_CHECKS as readonly string[]).includes(id) ? `v11AcChk_${id}` : null);
export const failedChecks = (i: Pick<ActivityItem, 'params'>): string[] => String(i.params.failed ?? '').split(',').filter(Boolean);
/** day key of an instant on this device (YYYY-MM-DD), for the day groups */
export const dayKey = (d: string | number | Date): string => new Date(d).toLocaleDateString('en-CA');
export function groupByDay<T extends { at: string }>(items: readonly T[]): { key: string; items: T[] }[] {
  const groups: { key: string; items: T[] }[] = [];
  for (const i of items) { const k = dayKey(i.at), g = groups[groups.length - 1]; if (g && g.key === k) g.items.push(i); else groups.push({ key: k, items: [i] }); }
  return groups;
}
