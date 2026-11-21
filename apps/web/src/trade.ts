/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/trade.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-16
 * Last Modified    : 2026-11-16
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

/**
 * V11 Trade — typed client of the owner's side of `/api/v1/trading/*` (the UNIFIED orders, positions, the order preview with
 * every check of the risk engine and of the mandate, the deterministic command line) and the pure helpers of the screen.
 * No React here: everything below is tested without a browser (apps/web/test/v11-trade.test.ts).
 *
 * The existing order panels (paper, venue account, GMX) keep their own routes and their own logic; this module only READS the
 * unified view of what they place, asks the unified preview once before a confirmation, and runs command lines.
 */
import { api, get, post, type ApiError } from './api';
import type { OrderBody } from './derivatives/types';
import type { Key } from './i18n';

// ---------------------------------------------------------------------------------------------------------------- the twelve states
/** the unified order state machine (services/api/src/trading-api/spec.ts ORDER_STATES; the unit test compares the two lists) */
export const ORDER_STATES = ['CREATED', 'VALIDATED', 'AWAITING_APPROVAL', 'APPROVED', 'SUBMITTING', 'SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'FAILED', 'UNKNOWN'] as const;
export type OrderState = (typeof ORDER_STATES)[number];
export const FINAL_STATES: readonly OrderState[] = ['FILLED', 'CANCELLED', 'REJECTED', 'FAILED'];
export type StateTone = 'mute' | 'ok' | 'info' | 'warn' | 'danger';
/**
 * How a state reads: icon + word, never a colour alone. UNKNOWN is « being verified with the venue »: the outcome is not known
 * yet — it is NOT final and NOT a failure, so it is never drawn in the failure tone.
 */
export const STATE_LOOK: Record<OrderState, { tone: StateTone; icon: string }> = {
  CREATED: { tone: 'mute', icon: 'list' }, VALIDATED: { tone: 'mute', icon: 'check' }, AWAITING_APPROVAL: { tone: 'warn', icon: 'key' }, APPROVED: { tone: 'info', icon: 'key' },
  SUBMITTING: { tone: 'info', icon: 'up' }, SUBMITTED: { tone: 'info', icon: 'clock' }, PARTIALLY_FILLED: { tone: 'info', icon: 'clock' }, FILLED: { tone: 'ok', icon: 'check' },
  CANCELLED: { tone: 'mute', icon: 'x' }, REJECTED: { tone: 'danger', icon: 'x' }, FAILED: { tone: 'danger', icon: 'warn' }, UNKNOWN: { tone: 'info', icon: 'clock' },
};
const isState = (s: string): s is OrderState => (ORDER_STATES as readonly string[]).includes(s);
/** a state the screen does not know (a newer server) is shown as being verified — never as a failure, never as done */
export const stateOf = (s: string): OrderState => (isState(s) ? s : 'UNKNOWN');
export const stateKey = (s: string): Key => `v11TrOs_${stateOf(s)}` as Key;
export const stateLook = (s: string): { tone: StateTone; icon: string } => STATE_LOOK[stateOf(s)];
export const isFinal = (s: string): boolean => (FINAL_STATES as readonly string[]).includes(s);

// ---------------------------------------------------------------------------------------------------------------- rows
export type Mode = 'paper' | 'live';
export interface UnifiedOrder {
  id: string; mode: Mode; venue: string; network: string; accountId: string | null; instrument: string | null; side: string | null; type: string; status: string; engineStatus: string | null; final: boolean;
  size?: string | null; price?: string | null; triggerPrice?: string | null; reduceOnly?: boolean; tif?: string; filled?: string; avgFillPrice?: string | null;
  reasonCode?: string | null; reason?: string | null; rejectCode?: string | null; origin?: string; mandateId?: string | null; notionalUsd?: string | null; createdAt: number; updatedAt: number;
}
export interface UnifiedPosition { id: string; mode: Mode; venue: string; accountId: string; instrument: string | null; side: 'long' | 'short'; size: string; entryPrice: string; markPrice: string | null; unrealizedPnl: string | null; source: string }
export interface Transition { seq: number; from: string; to: string; event: string; reason: string; detail: string | null; at: number }
export interface RiskCheck { id: string; ok: boolean; observed: string | null; limit: string | null; detail: string; exempt: boolean }
export interface Refusal { stage: 'key' | 'lock' | 'mandate' | 'risk' | 'engine'; code: string; message: string; reasons?: string[] }
export interface CanonicalOrder { venue: string; network: string; instrument: string; marketKind: 'spot' | 'perp'; side: 'buy' | 'sell'; type: string; size: string | null; notional: string | null; limitPrice: string | null; triggerPrice: string | null;
  reduceOnly: boolean; tif: string; maxSlippageBps: number; maxFeeUsd: string; leverage: string | null; mode: string; mandateId: string | null; expiresAt: number }
export interface PreviewAnswer {
  order: CanonicalOrder; hash: string; resolved: { size: string | null; worstPrice: string | null; notionalUsd: string | null } | null; wouldExecute: boolean; refusals: Refusal[];
  approval: { required: boolean; by: 'owner_passkey' | 'mandate' | 'none' };
  risk: { decision: 'allow' | 'deny'; reducing: boolean; checks: RiskCheck[] };
  mandate: { id: string; decision: 'allow' | 'deny'; reasons: string[] } | null;
  engine: { name: string }; account: { id: string | null; venue: string; network: string; equity?: string | null; freeCollateral?: string | null }; ts: number;
}
export interface Attached { role: 'stop_loss' | 'take_profit'; placed: boolean; note: string }
export type CommandAnswer =
  | { kind: 'query'; command: string; mode: Mode; dryRun: boolean; query: string; data: Record<string, unknown> }
  | { kind: 'control'; command: string; mode: Mode; dryRun: boolean; executed: boolean; control: { type: 'cancel_order' | 'cancel_all' | 'kill_switch_on' | 'stop_all_agents' }; orders?: string[]; results?: { id: string; ok: boolean }[] }
  | { kind: 'order'; command: string; mode: Mode; dryRun: boolean; executed: false; order: CanonicalOrder; hash: string; attached: Attached[] }
  | { kind: 'order'; command: string; mode: Mode; dryRun: boolean; executed: true; order: UnifiedOrder; canonical: CanonicalOrder; hash: string; idempotent: boolean; approval: Record<string, unknown> | null; attached: Attached[] };
export interface Question { field: string; options: string[]; message: string }
export type CommandDefaults = Partial<{ spotNetwork: string; spotQuote: string; perpVenue: string; perpNetworkByVenue: Record<string, string>; perpLeverage: string; perpMarginMode: 'cross' | 'isolated'; maxFeeBps: number; maxSlippageBps: number; orderTtlMs: number }> & Record<string, unknown>;

// ---------------------------------------------------------------------------------------------------------------- client
const T = '/trading';
const key = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;
export const tapi = {
  orders: (o: { open?: boolean; mode?: Mode; limit?: number; cursor?: string } = {}) => get<{ orders: UnifiedOrder[]; nextCursor: string | null; ts: number }>(`${T}/orders?limit=${o.limit ?? 50}${o.open === undefined ? '' : `&open=${o.open}`}${o.mode ? `&mode=${o.mode}` : ''}${o.cursor ? `&cursor=${encodeURIComponent(o.cursor)}` : ''}`),
  order: (id: string) => get<{ order: UnifiedOrder; fills: { id: string; price: string; size: string; fee: string; feeAsset: string; ts: number }[]; history?: Transition[] }>(`${T}/orders/${encodeURIComponent(id)}`),
  positions: () => get<{ positions: UnifiedPosition[]; errors: { source: string; message: string }[]; ts: number }>(`${T}/positions`),
  preview: (body: UnifiedOrderRequest) => post<PreviewAnswer>(`${T}/orders/preview`, body, { 'idempotency-key': key('ui-preview') }),
  cancel: (id: string) => api<{ order: UnifiedOrder; sent: boolean; changed: boolean }>('DELETE', `${T}/orders/${encodeURIComponent(id)}`, {}, { 'idempotency-key': key('ui-cancel') }),
  close: (id: string) => post<{ order: UnifiedOrder; approval: Record<string, unknown> | null }>(`${T}/positions/${encodeURIComponent(id)}/close`, {}, { 'idempotency-key': key('ui-close') }),
  command: (text: string, mode: Mode, accountId: string | null, dryRun: boolean, idem: string) => post<CommandAnswer>(`${T}/commands`, { text, mode, dryRun, ...(accountId ? { accountId } : {}) }, { 'idempotency-key': idem }),
  defaults: async (): Promise<CommandDefaults> => (await get<{ defaults: CommandDefaults }>('/developer/command-defaults')).defaults ?? {},
  setDefaults: async (d: CommandDefaults): Promise<CommandDefaults> => (await api<{ defaults: CommandDefaults }>('PUT', '/developer/command-defaults', { defaults: d })).defaults,
};

// ---------------------------------------------------------------------------------------------------------------- preview of a panel's order
export interface UnifiedOrderRequest { mode: Mode; accountId?: string; instrument: string; side: 'buy' | 'sell'; type: string; size: string; price?: string; triggerPrice?: string; reduceOnly: boolean; tif: string; slippageBps?: number; leverage?: string }
/**
 * The order an existing panel is about to confirm, as the unified preview takes it. Nothing is added or rounded: absent fields
 * stay absent. A market order's `price` in a panel is its WORST acceptable price (a bound the panel computed from its own
 * slippage setting): the unified route takes the bound as `slippageBps` or derives its own — the panel's worst price is not sent.
 */
export function toUnifiedRequest(mode: Mode, accountId: string, b: Pick<OrderBody, 'instrument' | 'side' | 'type' | 'size' | 'price' | 'triggerPrice' | 'reduceOnly' | 'tif'> & { leverage?: string; slippageBps?: number }): UnifiedOrderRequest {
  const market = b.type === 'market' || b.type === 'stop_market' || b.type === 'take_profit_market';
  return { mode, accountId, instrument: b.instrument, side: b.side as 'buy' | 'sell', type: b.type, size: b.size, ...(b.price && !market ? { price: b.price } : {}), ...(b.triggerPrice ? { triggerPrice: b.triggerPrice } : {}),
    reduceOnly: b.reduceOnly, tif: b.tif, ...(b.slippageBps ? { slippageBps: b.slippageBps } : {}), ...(mode === 'paper' && b.leverage ? { leverage: b.leverage } : {}) };
}
/** the ids of the risk engine's checks that have a sentence (`v11TrCk_<id>`); a check the screen does not know keeps its id, in monospace */
export const RISK_CHECKS = ['input_valid', 'read_only', 'kill_switch', 'reduce_only_valid', 'venue_allowed', 'instrument_allowed', 'instrument_status', 'signer_status', 'venue_connection',
  'price_freshness', 'price_consistency', 'order_notional', 'daily_notional', 'order_rate_minute', 'order_rate_hour', 'order_rate_day',
  'position_size', 'order_leverage', 'account_leverage', 'gross_exposure', 'net_exposure', 'asset_exposure', 'venue_exposure', 'collateral_concentration',
  'daily_loss', 'total_loss', 'drawdown', 'liquidation_distance', 'slippage', 'min_liquidity', 'context_complete'] as const;
export const checkKey = (id: string): Key | null => ((RISK_CHECKS as readonly string[]).includes(id) ? (`v11TrCk_${id}` as Key) : null);
/** failing checks first, then the ones that passed, then the exempt ones (a reduction is exempt from the exposure limits); the server's order inside each group */
export function sortChecks(checks: readonly RiskCheck[]): RiskCheck[] { const rank = (c: RiskCheck) => (!c.ok && !c.exempt ? 0 : c.exempt ? 2 : 1); return [...checks].sort((a, b) => rank(a) - rank(b)); }
export const checkCounts = (checks: readonly RiskCheck[]): { failed: number; passed: number; exempt: number } => ({ failed: checks.filter((c) => !c.ok && !c.exempt).length, passed: checks.filter((c) => c.ok && !c.exempt).length, exempt: checks.filter((c) => c.exempt).length });

// ---------------------------------------------------------------------------------------------------------------- unified blotter
/** an order that still rests or waits: what « open orders » lists. UNKNOWN stays here until the venue has answered. */
export const isOpen = (o: Pick<UnifiedOrder, 'status' | 'final'>): boolean => !o.final && !isFinal(o.status);
/** attached protection, as its order type says: a reduce-only stop is a stop loss, a reduce-only take-profit a take profit */
export function attachedRole(o: Pick<UnifiedOrder, 'type' | 'reduceOnly'>): 'stop_loss' | 'take_profit' | null {
  if (!o.reduceOnly) return null;
  return o.type.startsWith('stop') ? 'stop_loss' : o.type.startsWith('take_profit') ? 'take_profit' : null;
}
/** live and paper are two lists: nothing is ever added across them */
export function byMode<T extends { mode: Mode }>(rows: readonly T[]): { live: T[]; paper: T[] } { return { live: rows.filter((r) => r.mode === 'live'), paper: rows.filter((r) => r.mode === 'paper') }; }
/** the protections attached to a position: the open reduce-only stops and take-profits of the same account and instrument */
export function protectionsOf(p: Pick<UnifiedPosition, 'accountId' | 'instrument' | 'mode'>, orders: readonly UnifiedOrder[]): UnifiedOrder[] {
  return orders.filter((o) => isOpen(o) && o.mode === p.mode && o.accountId === p.accountId && o.instrument === p.instrument && attachedRole(o) !== null);
}

// ---------------------------------------------------------------------------------------------------------------- command line
export const PARSE_CODES = ['empty', 'too_long', 'bad_character', 'unknown_command', 'expected_asset', 'expected_perp', 'expected_amount', 'expected_quote', 'expected_price', 'expected_venue',
  'expected_keyword', 'expected_id', 'bad_number', 'bad_percent', 'bad_leverage', 'duplicate_option', 'unexpected_token'] as const;
export const UNRESOLVABLE_CODES = ['no_instrument', 'no_position', 'missing_balance', 'missing_reference_price', 'fee_cap_not_expressible', 'zero_size', 'inconsistent_prices', 'no_client_id_format', 'invalid_order'] as const;
export const QUESTION_FIELDS = ['venue', 'network', 'instrument', 'quote', 'leverage', 'marginMode', 'maxFeeBps', 'maxSlippageBps', 'orderTtlMs'] as const;
export type CommandProblem =
  | { kind: 'questions'; questions: Question[] }
  | { kind: 'parse'; code: string; token: number | null }
  | { kind: 'unresolvable'; code: string }
  | { kind: 'refused'; code: string; failed: string[]; reasons: string[] }
  | { kind: 'error'; code: string };
/** what a refused command line means for the screen — from the error's CODE and its `data`, never from its English sentence */
export function commandProblem(e: unknown): CommandProblem {
  const x = e as Partial<ApiError>, body = (x?.body ?? {}) as { data?: { questions?: Question[]; code?: string; token?: number; failed?: string[]; reasons?: string[] } }, d = body.data ?? {};
  const code = String(x?.code ?? 'error');
  if (code === 'ambiguous_command') return { kind: 'questions', questions: Array.isArray(d.questions) ? d.questions : [] };
  if (code === 'parse_error') return { kind: 'parse', code: String(d.code ?? 'unknown_command'), token: typeof d.token === 'number' ? d.token : null };
  if ((UNRESOLVABLE_CODES as readonly string[]).includes(code)) return { kind: 'unresolvable', code };
  if (code === 'risk_denied' || code === 'kill_switch_active' || code === 'read_only_mode' || code === 'mandate_denied') return { kind: 'refused', code, failed: d.failed ?? [], reasons: d.reasons ?? [] };
  return { kind: 'error', code };
}
const SPOT_VERBS = /^(BUY|SELL|ACHETER|ACHETE|ACHÈTE|VENDRE|VENDS|VEND)\b/i;
export const isSpotCommand = (text: string): boolean => SPOT_VERBS.test(text.trim());
/** the venue a command names (`… ON <venue>` / `SUR <venue>`), lower case; null when it names none */
export function venueIn(text: string): string | null { const m = /\b(?:ON|SUR)\s+([a-z0-9][a-z0-9-]{0,31})\s*$/i.exec(text.trim()) ?? /\b(?:ON|SUR)\s+([a-z0-9][a-z0-9-]{0,31})\b/i.exec(text); return m ? m[1]!.toLowerCase() : null; }
/**
 * An answer to one question. Two kinds: what the grammar itself can say is written INTO the line (`ON <venue>`, `x<leverage>`,
 * `FOR <quote>`), so the line stays the whole order; what only the owner's stored defaults can say (fee cap, slippage bound,
 * validity, margin mode, network) is a change of those defaults. `null`: the value cannot be used as it is.
 */
export function answerQuestion(text: string, defaults: CommandDefaults, field: string, value: string): { text: string } | { defaults: CommandDefaults } | null {
  const v = value.trim(), line = text.trim().replace(/\s+/g, ' ');
  if (v === '') return null;
  const int = (max: number): number | null => (/^\d{1,9}$/.test(v) && Number(v) >= 1 && Number(v) <= max ? Number(v) : null);
  switch (field) {
    case 'venue': return /^[a-z0-9][a-z0-9-]{0,31}$/.test(v) ? { text: `${line.replace(/\s+(?:ON|SUR)\s+\S+$/i, '')} ON ${v}` } : null;
    case 'instrument': { const venue = v.includes(':') ? v.slice(0, v.indexOf(':')) : ''; return /^[a-z0-9][a-z0-9-]{0,31}$/.test(venue) ? { text: `${line.replace(/\s+(?:ON|SUR)\s+\S+$/i, '')} ON ${venue}` } : null; }
    case 'leverage': { if (!/^(?:[1-9]\d{0,2})(?:\.\d{1,2})?$/.test(v)) return null; const on = /\s+(?:ON|SUR)\s+\S+$/i.exec(line); const head = on ? line.slice(0, on.index) : line; return { text: `${head} x${v}${on ? on[0] : ''}` }; }
    case 'quote': return /^[A-Za-z0-9.]{1,15}$/.test(v) ? (isSpotCommand(line) && /^(SELL|VENDRE|VENDS|VEND)\b/i.test(line) ? { text: `${line.replace(/\s+(?:FOR|POUR|CONTRE)\s+\S+/i, '')} FOR ${v.toUpperCase()}` } : { defaults: { ...defaults, spotQuote: v.toUpperCase() } }) : null;
    case 'marginMode': return v === 'cross' || v === 'isolated' ? { defaults: { ...defaults, perpMarginMode: v } } : null;
    case 'maxFeeBps': { const n = /^\d{1,5}$/.test(v) && Number(v) <= 10_000 ? Number(v) : null; return n === null ? null : { defaults: { ...defaults, maxFeeBps: n } }; }
    case 'maxSlippageBps': { const n = int(500); return n === null ? null : { defaults: { ...defaults, maxSlippageBps: n } }; }
    case 'orderTtlMs': { const s = int(86_400); return s === null ? null : { defaults: { ...defaults, orderTtlMs: s * 1000 } }; }   // typed in seconds
    case 'network': {
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(v)) return null;
      if (isSpotCommand(line)) return { defaults: { ...defaults, spotNetwork: v } };
      const venue = venueIn(line) ?? defaults.perpVenue;
      return venue ? { defaults: { ...defaults, perpNetworkByVenue: { ...(defaults.perpNetworkByVenue ?? {}), [venue]: v } } } : null;
    }
    default: return null;
  }
}
/** examples of the grammar, shown under the input (the grammar reads English and French keywords) */
export const COMMAND_EXAMPLES = ['LONG BTC-PERP 500 x2', 'CLOSE BTC-PERP 50%', 'SHOW POSITIONS', 'CANCEL ALL'] as const;
