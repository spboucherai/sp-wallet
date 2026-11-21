/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/mm.ts
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

// V11 — live market making on Hyperliquid: the client of /api/v1/mm and the pure rules of its screens (screens/mmPanel.tsx).
// No React here; every function is tested in apps/web/test/mm.test.ts.
//
// Rules this file keeps:
//   - ONE MODE PER REQUEST: every read of a session, of fills or of an attribution names exactly one `mode=`.
//   - the go-live checklist is ORDERED and the server's `goLive.steps` are the truth: a step can be acted on only when every
//     step before it is done; nothing here marks a step done.
//   - a value of the quoting mandate is never clamped: the form shows the compiled bound of each field (GET /mm/bounds), may
//     refuse to send a value outside it, and the server's refusal (code + message) is shown as it came.
//   - "pull" and "flatten" never depend on a lock, a halt or the checklist.
import type { Key } from './i18n';

// ------------------------------------------------------------------------------------------------------------------ the server's shapes
export type MmMode = 'paper' | 'live';
export type BreakerAction = 'pull' | 'flatten' | 'halt';
export interface MmQuote { clientId: string; side: 'buy' | 'sell'; price: string; size: string; state: string; ageMs: number; distanceBps: string | null }
export interface MmSwitch { deadline: number | null; armed: boolean; lapsesToday: number; venueTriggersPerDay: number; signerStopsAt: number }
export interface MmStatus { phase?: string; reason?: string | null; ending?: unknown; position?: string; positionUsd?: string | null; mid?: string | null; quotes?: MmQuote[]; blockedSides?: string[]; activeBreakers?: string[];
  halted?: string | boolean | null; manual?: 'pull' | 'flatten' | null; lock?: string | null; switch?: MmSwitch; mandate?: { id: string; phase: string | null; expiresAt: number; quotesLeftHour: number | null; quotesLeftDay: number | null } | null;
  schedule?: { hours: { startUtcMinute: number; endUtcMinute: number } | null; endsAt: number } | null;
  stream?: { status: unknown; synced: boolean; streamOrders: number; streamFills: number; audits: number; divergences: number; gaps: number; lastAuditAt: number | null } | null; simulated?: boolean; ts?: number }
export interface MmPnl { totalUsd?: string; spreadCaptureUsd?: string; inventoryPnlUsd?: string; feesUsd?: string; fundingUsd?: string; position?: string; fills?: number; volumeUsd?: string; bpsOfVolume?: string | null }
export interface MmMarkout { horizonMs: number; fills: number; meanBps: string | null; weightedMeanBps: string | null; worstBps: string | null }
export interface MmBudget { limitPerMinute?: number; usedLastMinute?: number; peakPerMinute?: number; restWeight?: number; exchangeWeight?: number; signerWeightEstimate?: number; address?: { remaining: number | null; orders: number; cancels: number; heartbeats: number } }
export interface SessionView { id: string; mode: MmMode; instrument: string; network: string; state: 'running' | 'stopped' | 'abandoned'; policy: string; startedAt: number; endedAt: number | null; endReason: string | null; heartbeatAt: number; stale: boolean;
  counters: Record<string, number>; pnl: MmPnl; markouts: MmMarkout[]; refusals: Record<string, number>; budget: MmBudget; breakers: { ts: number; code: string; action: string }[]; status: MmStatus; simulated: boolean; label: string }
export type StepId = 'paper' | 'evidence' | 'jurisdiction' | 'testnet' | 'mandate' | 'locks';
export interface GoLiveStep { id: StepId; done: boolean; evidence: Record<string, unknown>; missing: string | null }
export interface GoLive { steps: GoLiveStep[]; ready: boolean; network: 'mainnet' | 'testnet' | null }
export interface MmMandate { id: string; state: string; phase: string; integrity: string | null; hash: string; quoting: { section: { terms: Record<string, unknown>; engine: Record<string, unknown> }; hash: string; maxima: Record<string, string> } | null; expiresAt: number; signer: unknown }
export interface MmView { agentId: string; state: string; mode: string; universe: string[]; venues: string[]; config: Record<string, unknown>; configVersion: number; session: SessionView | null; sessions: SessionView[]; mandate: MmMandate | null; goLive: GoLive; ts: number }
export interface MmFill { id: string; side: 'buy' | 'sell'; price: string; size: string; fee: string; maker: boolean; reduce: boolean; mid: string | null; ts: number; markoutsBps: { '1s': string | null; '10s': string | null; '60s': string | null }; markoutsDone: boolean }
export interface MmFills { mode: MmMode; simulated: boolean; fills: MmFill[] }
export interface MmPerformance { mode: MmMode; label: string; sessions: number; fills: number; volumeUsd: string; attribution: { totalUsd: string; spreadCaptureUsd: string; inventoryPnlUsd: string; feesUsd: string; fundingUsd: string; bpsOfVolume: string | null };
  markouts: { horizon: '1s' | '10s' | '60s'; fills: number; meanBps: string | null }[]; note: string }
export interface MmEvidence { evidence: { version: string; lab: { source: string; ranOn: string; sample: string; result: string; figures: Record<string, unknown> }; simulation: { source: string; result: string; figures: Record<string, unknown> }; fees: string; statement: { fr: string; en: string } };
  statement: string; sha256: string; jurisdiction: { text: string; sha256: string; version: string; source: string }; minPaperMinutes: number }
export interface MmLock { code: string; message: string; setting: string }
export interface MmNetLock { network: string; lock: MmLock | null; consulted: string[] }
export interface MmBounds { signer: Record<string, number | string>; section: Record<string, number | string>; breakers: { code: string; default: BreakerAction; alwaysStops: boolean }[]; locks: { mainnet: MmNetLock; testnet: MmNetLock } }
export interface QuotingApproval { kind: 'quoting'; mandateId: string; mandate: Record<string, unknown>; hash: string; quoting: { hash: string; maxima: Record<string, string>; table: string };
  signer: { shape: string; hash: string; acknowledgement: { text: string; sha256?: string }; options: unknown; exclusivity?: string }; binding: { hash: string; options: unknown };
  hashes: { tradingMandate: string; quotingSection: string; signerMandate: string; approvalIntent: string }; note: string }

// ------------------------------------------------------------------------------------------------------------------ requests: one mode each
export const MM_POLL_MS = 2000;
/** the session view is polled every 2 s while its section is on screen, and not at all otherwise */
export const pollInterval = (visible: boolean): number | false => (visible ? MM_POLL_MS : false);
export const mmAgentUrl = (id: string, mode: MmMode): string => `/mm/agents/${id}?mode=${mode}`;
export const mmFillsUrl = (id: string, mode: MmMode, limit = 100): string => `/mm/agents/${id}/fills?mode=${mode}&limit=${limit}`;
export const mmPerfUrl = (id: string, mode: MmMode): string => `/mm/agents/${id}/performance?mode=${mode}`;
export const mmEvidenceUrl = (locale: 'fr' | 'en'): string => `/mm/evidence?locale=${locale}`;
/** where the go-live flow of an agent opens (the Risk screen links here) */
export const goLivePath = (agentId: string): string => `/agents/${agentId}?mm=live`;

// ------------------------------------------------------------------------------------------------------------------ the ordered checklist
export const STEP_ORDER: readonly StepId[] = ['paper', 'evidence', 'jurisdiction', 'testnet', 'mandate', 'locks'];
export interface StepGate { id: StepId; n: number; done: boolean; /** every step before it is done and this one is not: the owner acts here */ actionable: boolean;
  /** a step before it is missing */ locked: boolean; /** the testnet step is not asked of a mandate that is itself on testnet */ skipped: boolean; missing: string | null; evidence: Record<string, unknown> }
/** The checklist in the order the owner completes it. `done` is the server's word only; the gate is: all previous steps done. */
export function checklist(g: GoLive): StepGate[] {
  let open = true;
  return STEP_ORDER.map((id, k) => {
    const s = g.steps.find((x) => x.id === id), done = s?.done === true, skipped = id === 'testnet' && !done && g.network === 'testnet', ok = done || skipped;
    const gate: StepGate = { id, n: k + 1, done, actionable: open && !ok, locked: !open && !ok, skipped, missing: s?.missing ?? null, evidence: s?.evidence ?? {} };
    open = open && ok;
    return gate;
  });
}
export const stepState = (s: StepGate): 'done' | 'current' | 'next' => (s.done ? 'done' : s.actionable ? 'current' : 'next');
export const stepKey = (id: StepId): Key => (`mmStep_${id}` as Key);
/** the six checks of the owner-run testnet step, in the order of the design note */
export const TESTNET_CHECKS = ['schedule', 'alo', 'expires', 'lag', 'cloid', 'ratelimit'] as const;
export const testnetCheckKey = (c: (typeof TESTNET_CHECKS)[number]): Key => (`mmTn_${c}` as Key);
export const TESTNET_NOTE_MIN = 10;
export const testnetNoteOk = (note: string): boolean => note.trim().length >= TESTNET_NOTE_MIN && note.trim().length <= 500;

// ------------------------------------------------------------------------------------------------------------------ figures
/** a decimal string of the server is negative */
export const isNegative = (x: string | number | null | undefined): boolean => x !== null && x !== undefined && /^\s*-\s*\d*\.?\d*[1-9]/.test(String(x));
/** Figures of the evidence as they are: every leaf of the object, by its path, with the server's own text. Nothing is rounded or dropped. */
export function flatFigures(o: Record<string, unknown>, prefix = ''): { path: string; value: string }[] {
  return Object.entries(o).flatMap(([k, v]) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? flatFigures(v as Record<string, unknown>, `${prefix}${k}.`) : [{ path: `${prefix}${k}`, value: String(v) }]));
}
/** a markout of one fill: the server's figure, "pending" until the tape has been read, a dash when the tape had no mid at the horizon */
export function markoutCell(bps: string | null | undefined, done: boolean): { kind: 'value' | 'pending' | 'none'; text: string } {
  if (bps !== null && bps !== undefined) return { kind: 'value', text: bps };
  return done ? { kind: 'none', text: '—' } : { kind: 'pending', text: '' };
}
export const HORIZONS = ['1s', '10s', '60s'] as const;
export const horizonOf = (ms: number): string => (ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`);
/** HH:MM:SS UTC of a timestamp — the dead man's switch deadline is read to the second */
export const hmsUtc = (ts: number): string => new Date(ts).toISOString().slice(11, 19);
/** the line of the dead man's switch: armed until when, and the triggers of the day against the venue's limit and the signer's stop */
export function switchFacts(sw: MmSwitch | undefined | null): { armed: boolean; until: string | null; used: number; of: number; stopsAt: number; atStop: boolean } | null {
  if (!sw) return null;
  return { armed: sw.armed === true && sw.deadline !== null, until: sw.deadline !== null ? hmsUtc(sw.deadline) : null, used: sw.lapsesToday ?? 0, of: sw.venueTriggersPerDay ?? 10, stopsAt: sw.signerStopsAt ?? 8, atStop: (sw.lapsesToday ?? 0) >= (sw.signerStopsAt ?? 8) };
}
export const ageText = (ms: number): string => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.floor((ms % 60_000) / 1000)} s`);
export const baseOf = (instrument: string): string => instrument.slice(instrument.indexOf(':') + 1);
export const PHASE_TONE: Record<string, 'ok' | 'info' | 'warn' | 'danger' | 'mute'> = { quoting: 'ok', starting: 'info', pulled: 'warn', stopping: 'warn', halted: 'danger', stopped: 'mute', idle: 'mute' };

// ------------------------------------------------------------------------------------------------------------------ commands
/**
 * Which of the three commands can be pressed. Pull and flatten: as soon as there is a session in the view, or — on the live
 * tab — as soon as the agent is live (the API then acts itself, under the agent's lease). They are NEVER disabled by a lock,
 * a halt, a breaker or the checklist. Resume needs a running session.
 */
export function commandState(v: Pick<MmView, 'mode' | 'session'>, tab: MmMode): { pull: boolean; flatten: boolean; resume: boolean } {
  const running = v.session !== null && v.session.state === 'running', can = running || (tab === 'live' && (v.mode === 'LIVE' || v.session !== null));
  return { pull: can, flatten: can, resume: running };
}

// ------------------------------------------------------------------------------------------------------------------ refusals, verbatim
export interface Refusal { code: string; message: string; status: number; steps: GoLiveStep[] | null }
/** the server's refusal as it came: its code, its sentence, and the steps a `golive_incomplete` lists */
export function refusalOf(e: unknown): Refusal | null {
  const x = e as { name?: string; code?: string; message?: string; status?: number; body?: { data?: { steps?: GoLiveStep[] }; steps?: GoLiveStep[] } };
  if (x?.name === 'NotAllowedError') return null;                                    // a cancelled passkey prompt says nothing
  return { code: String(x?.code ?? 'error'), message: String(x?.message ?? ''), status: Number(x?.status ?? 0), steps: x?.body?.data?.steps ?? x?.body?.steps ?? null };
}

// ------------------------------------------------------------------------------------------------------------------ the enforced-by table, verbatim
export interface TableRow { cells: string[]; header: boolean; raw: string }
/** The Markdown table of the approval, row by row. Cells keep the server's text character for character; only the `|---|` rule is not a row. */
export function tableRows(md: string): TableRow[] {
  const lines = md.split('\n').map((l) => l.trim()).filter(Boolean), out: TableRow[] = [];
  for (let k = 0; k < lines.length; k++) {
    const raw = lines[k]!;
    if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(raw)) continue;
    const cells = raw.startsWith('|') ? raw.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()) : [raw];
    out.push({ cells, header: /^\|?\s*:?-{2,}/.test(lines[k + 1] ?? ''), raw });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------ the quoting mandate form
const SCALE = 18;
const toBig = (s: string): bigint => { const [i = '0', f = ''] = s.split('.'); return BigInt(i || '0') * 10n ** BigInt(SCALE) + BigInt((f + '0'.repeat(SCALE)).slice(0, SCALE) || '0'); };
const fromBig = (b: bigint): string => { const i = b / 10n ** BigInt(SCALE), f = (b % 10n ** BigInt(SCALE)).toString().padStart(SCALE, '0').replace(/0+$/, ''); return f ? `${i}.${f}` : `${i}`; };
export const DEC = /^(0|[1-9]\d{0,17})(\.\d{1,18})?$/;
const INT = /^(0|[1-9]\d{0,8})$/;
/** exact decimal: a + b × n (what must fit the position limit: hard inventory plus every quote of one side) */
export const addMul = (a: string, b: string, n: number): string => fromBig(toBig(a) + toBig(b) * BigInt(n));
export const cleanDec = (s: string): string => s.replace(',', '.').replace(/[^0-9.]/g, '').replace(/^0+(?=\d)/, '');
export const cleanInt = (s: string): string => s.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
/** "HH:MM" (UTC) → minute of the day, or null */
export const parseHm = (s: string): number | null => { const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

export const MONEY_FIELDS = ['maxCapitalUsd', 'floorEquityUsd', 'maxLeverage', 'maxOrderNotionalUsd', 'softInventoryUsd', 'hardInventoryUsd', 'dailyTurnoverUsd', 'maxSessionLossUsd', 'maxDailyLossUsd', 'maxFeeUsd'] as const;
export const INT_FIELDS = ['levelsPerSide', 'minHalfSpreadBps', 'maxDistanceBps', 'burstActions', 'actionsPerMinute', 'quotesPerHour', 'quotesPerDay', 'deadManSeconds', 'maxSessionMinutes', 'stopBeforeExpiryS', 'days', 'perMinute', 'perHour', 'perDay', 'maxSlippageBps'] as const;
export type MoneyField = (typeof MONEY_FIELDS)[number];
export type IntField = (typeof INT_FIELDS)[number];
export type NumField = MoneyField | IntField;
export interface QuotingDraft extends Record<NumField, string> { accountId: string; label: string; hoursStart: string; hoursEnd: string; breakers: Record<string, BreakerAction>; flattenOnStop: boolean }
/** what the form needs to know of the agent: the section must say what its configuration says */
export interface QuotingAgent { id: string; instrument: string; strategySha256: string; policy: string; quoteSizeUsd: string; minHalfSpreadBps: number; capitalUsd: string; maxInventoryUsd: string }
export function quotingAgent(v: Pick<MmView, 'agentId' | 'universe' | 'config'>, o: { strategySha256: string; capitalUsd: string }): QuotingAgent {
  const c = v.config as { policy?: string; quoteSizeUsd?: unknown; minHalfSpreadBps?: unknown; maxInventoryUsd?: unknown };
  return { id: v.agentId, instrument: `hyperliquid:${v.universe[0] ?? ''}`, strategySha256: o.strategySha256, policy: c.policy ?? 'spread_inventory', quoteSizeUsd: String(c.quoteSizeUsd ?? ''), minHalfSpreadBps: Number(c.minHalfSpreadBps ?? NaN),
    capitalUsd: o.capitalUsd, maxInventoryUsd: String(c.maxInventoryUsd ?? '') };
}

const num = (x: unknown): number => Number(x);
export type Group = 'capital' | 'quotes' | 'rates' | 'session' | 'unwind';
export interface FieldDef { key: NumField; group: Group; unit: string; /** the compiled range of the field, from GET /mm/bounds and the agent */ range: (b: MmBounds, d: QuotingDraft, a: QuotingAgent) => { min?: number; max?: number; rel?: string } }
/** EVERY numeric field of the form, with where its bound comes from. A field without a bound cannot be added: `range` is required. */
export const FIELDS: readonly FieldDef[] = [
  { key: 'maxCapitalUsd', group: 'capital', unit: 'USD', range: (b, d) => ({ max: num(b.signer.maxGrossExposure) / Math.max(1, Number(d.maxLeverage) || 1), rel: `maxCapitalUsd × maxLeverage ≤ ${b.signer.maxGrossExposure}` }) },
  { key: 'floorEquityUsd', group: 'capital', unit: 'USD', range: () => ({ rel: '> 0, < maxCapitalUsd' }) },
  { key: 'maxLeverage', group: 'capital', unit: '×', range: (b) => ({ min: 1, max: num(b.signer.maxLeverage) }) },
  { key: 'maxOrderNotionalUsd', group: 'quotes', unit: 'USD', range: (b, _d, a) => ({ min: Number(a.quoteSizeUsd) || num(b.section.minQuoteSizeUsd), max: num(b.signer.maxQuoteNotional), rel: `maxOrderNotionalUsd × levelsPerSide ≤ ${b.signer.maxRestingNotionalPerSide}` }) },
  { key: 'levelsPerSide', group: 'quotes', unit: '', range: (b) => ({ min: 1, max: Math.min(num(b.signer.maxRestingPerSide), Math.floor(num(b.signer.maxRestingTotal) / 2)) }) },
  { key: 'minHalfSpreadBps', group: 'quotes', unit: 'bps', range: (b, _d, a) => ({ min: num(b.signer.minHalfSpreadBpsFloor), ...(Number.isFinite(a.minHalfSpreadBps) ? { max: Math.floor(a.minHalfSpreadBps) } : {}), rel: '< maxDistanceBps' }) },
  { key: 'maxDistanceBps', group: 'quotes', unit: 'bps', range: (b) => ({ min: num(b.signer.minHalfSpreadBpsFloor) + 1, max: num(b.signer.maxDistanceBpsCeiling) }) },
  { key: 'softInventoryUsd', group: 'quotes', unit: 'USD', range: () => ({ rel: '> 0, < hardInventoryUsd' }) },
  { key: 'hardInventoryUsd', group: 'quotes', unit: 'USD', range: (b) => ({ max: num(b.signer.maxInventoryNotional), rel: `hardInventoryUsd + quoteSizeUsd × levelsPerSide ≤ ${b.signer.maxInventoryNotional}` }) },
  { key: 'burstActions', group: 'rates', unit: '', range: (b) => ({ min: 1, max: num(b.signer.maxBurstActions) }) },
  { key: 'actionsPerMinute', group: 'rates', unit: '/ min', range: (b) => ({ min: 1, max: num(b.signer.maxActionsPerMinute) }) },
  { key: 'quotesPerHour', group: 'rates', unit: '/ h', range: (b) => ({ min: 1, max: num(b.signer.maxOrdersPerHour), rel: '≤ quotesPerDay' }) },
  { key: 'quotesPerDay', group: 'rates', unit: '/ 24 h', range: (b) => ({ min: 1, max: num(b.signer.maxOrdersPerDay) }) },
  { key: 'dailyTurnoverUsd', group: 'rates', unit: 'USD', range: (b) => ({ max: num(b.signer.maxDailyTurnover) }) },
  { key: 'deadManSeconds', group: 'rates', unit: 's', range: (b) => ({ min: num(b.signer.minDeadManSeconds), max: num(b.signer.maxDeadManSeconds) }) },
  { key: 'maxSessionMinutes', group: 'session', unit: 'min', range: (b) => ({ min: num(b.section.minSessionMinutes), max: num(b.section.maxSessionMinutes) }) },
  { key: 'maxSessionLossUsd', group: 'session', unit: 'USD', range: (b) => ({ max: num(b.section.maxSessionLossUsd), rel: '≤ maxDailyLossUsd' }) },
  { key: 'maxDailyLossUsd', group: 'session', unit: 'USD', range: () => ({ rel: '≥ maxSessionLossUsd' }) },
  { key: 'stopBeforeExpiryS', group: 'session', unit: 's', range: (b) => ({ min: num(b.section.minStopBeforeExpiryS), max: num(b.section.maxStopBeforeExpiryS) }) },
  { key: 'days', group: 'session', unit: '', range: (b) => ({ min: 1, max: num(b.signer.maxDays) }) },
  { key: 'perMinute', group: 'unwind', unit: '/ min', range: () => ({ min: 1, rel: '≤ perHour' }) },
  { key: 'perHour', group: 'unwind', unit: '/ h', range: () => ({ min: 1, rel: '≤ perDay' }) },
  { key: 'perDay', group: 'unwind', unit: '/ 24 h', range: () => ({ min: 1, max: 500 }) },
  { key: 'maxSlippageBps', group: 'unwind', unit: 'bps', range: (b) => ({ min: num(b.signer.minReduceDeviationBps), max: num(b.signer.maxReduceDeviationBps) }) },
  { key: 'maxFeeUsd', group: 'unwind', unit: 'USD', range: () => ({ rel: '> 0' }) },
];
export const GROUPS: readonly Group[] = ['capital', 'quotes', 'rates', 'session', 'unwind'];
export const fieldKey = (k: NumField): Key => (`mmF_${k}` as Key);
export const groupKey = (g: Group): Key => (`mmG_${g}` as Key);
/** the bound of a field as it is shown next to it: `min…max`, `≤ max`, `≥ min`, then the relation to another field when there is one */
export function boundText(f: FieldDef, b: MmBounds, d: QuotingDraft, a: QuotingAgent): string {
  const r = f.range(b, d, a), n = (x: number) => String(Math.floor(x * 1e6) / 1e6);
  const span = r.min !== undefined && r.max !== undefined ? `${n(r.min)}…${n(r.max)}` : r.max !== undefined ? `≤ ${n(r.max)}` : r.min !== undefined ? `≥ ${n(r.min)}` : '';
  return [span, r.rel ?? ''].filter(Boolean).join(' · ');
}
const isMoney = (k: NumField): k is MoneyField => (MONEY_FIELDS as readonly string[]).includes(k);

/** first values of the form: what the agent's configuration says where the section must say the same, cautious figures elsewhere — all of them editable, none sent before the owner presses create */
export function emptyQuotingDraft(a: QuotingAgent, b: MmBounds): QuotingDraft {
  const hard = DEC.test(a.maxInventoryUsd) && Number(a.maxInventoryUsd) > 0 ? a.maxInventoryUsd : '250', cap = DEC.test(a.capitalUsd) && Number(a.capitalUsd) > 0 ? a.capitalUsd : '1000';
  const half = Number.isFinite(a.minHalfSpreadBps) ? Math.max(num(b.signer.minHalfSpreadBpsFloor), Math.floor(a.minHalfSpreadBps)) : num(b.signer.minHalfSpreadBpsFloor);
  return { accountId: '', label: `MM ${baseOf(a.instrument)}`, maxCapitalUsd: cap, floorEquityUsd: fromBig((toBig(cap) * 8n) / 10n), maxLeverage: '1', maxOrderNotionalUsd: a.quoteSizeUsd, softInventoryUsd: fromBig(toBig(hard) / 2n), hardInventoryUsd: hard,
    levelsPerSide: '1', minHalfSpreadBps: String(half), maxDistanceBps: '150', burstActions: '10', actionsPerMinute: '30', quotesPerHour: '1200', quotesPerDay: '10000', dailyTurnoverUsd: '100000', deadManSeconds: '30',
    hoursStart: '', hoursEnd: '', maxSessionMinutes: '60', maxSessionLossUsd: '25', maxDailyLossUsd: '25', stopBeforeExpiryS: '300', days: '1', perMinute: '5', perHour: '60', perDay: '200', maxSlippageBps: '50', maxFeeUsd: '25',
    breakers: Object.fromEntries(b.breakers.map((x) => [x.code, x.default])), flattenOnStop: false };
}
/** the position limit sent with the mandate: exactly what the section needs — hard inventory + quote size × quotes per side */
export const positionLimit = (d: QuotingDraft, a: QuotingAgent): string | null => (DEC.test(d.hardInventoryUsd) && DEC.test(a.quoteSizeUsd) && INT.test(d.levelsPerSide) ? addMul(d.hardInventoryUsd, a.quoteSizeUsd, Number(d.levelsPerSide)) : null);

export interface DraftProblem { field: string; bound: string }
/**
 * Why the form is not sent yet: a field that is not a number, or a value outside the bound shown next to it. The value typed
 * is never changed — the owner corrects it, or the server refuses it with its code.
 */
export function draftProblems(d: QuotingDraft, b: MmBounds, a: QuotingAgent): DraftProblem[] {
  const out: DraftProblem[] = [], bad = (field: string, bound: string) => { if (!out.some((p) => p.field === field)) out.push({ field, bound }); };
  if (!d.accountId) bad('accountId', '');
  if (!d.label.trim() || d.label.trim().length > 60) bad('label', '1…60');
  if (!DEC.test(a.quoteSizeUsd)) bad('quoteSizeUsd', 'config.quoteSizeUsd');
  for (const f of FIELDS) {
    const v = d[f.key], r = f.range(b, d, a), text = boundText(f, b, d, a);
    if (!(isMoney(f.key) ? DEC.test(v) && Number(v) > 0 : INT.test(v))) { bad(f.key, text); continue; }
    if ((r.min !== undefined && Number(v) < r.min) || (r.max !== undefined && Number(v) > r.max)) bad(f.key, text);
  }
  const n = (k: NumField) => Number(d[k]), q = Number(a.quoteSizeUsd), lv = n('levelsPerSide');
  if (!(n('floorEquityUsd') < n('maxCapitalUsd'))) bad('floorEquityUsd', '< maxCapitalUsd');
  if (!(n('softInventoryUsd') < n('hardInventoryUsd'))) bad('softInventoryUsd', '< hardInventoryUsd');
  if (!(n('minHalfSpreadBps') < n('maxDistanceBps'))) bad('minHalfSpreadBps', '< maxDistanceBps');
  if (!(n('quotesPerHour') <= n('quotesPerDay'))) bad('quotesPerHour', '≤ quotesPerDay');
  if (!(n('maxSessionLossUsd') <= n('maxDailyLossUsd'))) bad('maxDailyLossUsd', '≥ maxSessionLossUsd');
  if (!(n('perMinute') <= n('perHour'))) bad('perMinute', '≤ perHour');
  if (!(n('perHour') <= n('perDay'))) bad('perHour', '≤ perDay');
  if (!(n('maxCapitalUsd') * n('maxLeverage') <= num(b.signer.maxGrossExposure))) bad('maxCapitalUsd', `maxCapitalUsd × maxLeverage ≤ ${b.signer.maxGrossExposure}`);
  if (!(n('maxOrderNotionalUsd') * lv <= num(b.signer.maxRestingNotionalPerSide))) bad('maxOrderNotionalUsd', `maxOrderNotionalUsd × levelsPerSide ≤ ${b.signer.maxRestingNotionalPerSide}`);
  if (!(n('hardInventoryUsd') + q * lv <= num(b.signer.maxInventoryNotional))) bad('hardInventoryUsd', `hardInventoryUsd + quoteSizeUsd × levelsPerSide ≤ ${b.signer.maxInventoryNotional}`);
  const hs = d.hoursStart.trim(), he = d.hoursEnd.trim();
  if ((hs || he) && (parseHm(hs) === null || parseHm(he) === null || parseHm(hs) === parseHm(he))) bad('hours', 'HH:MM–HH:MM UTC');
  for (const x of b.breakers) if (x.alwaysStops && d.breakers[x.code] === 'pull') bad(`breakers.${x.code}`, 'flatten | halt');
  return out;
}
/** the actions a breaker may be given: one that always stops the session cannot be softened to a plain pull */
export const breakerChoices = (x: { alwaysStops: boolean }): BreakerAction[] => (x.alwaysStops ? ['flatten', 'halt'] : ['pull', 'flatten', 'halt']);

/** The body of POST /mandates for a quoting mandate: the owner's values as typed. `policy` and `quoteSizeUsd` are the agent's (the server refuses anything else). */
export function quotingBody(d: QuotingDraft, a: QuotingAgent, locale: 'fr' | 'en'): Record<string, unknown> {
  const i = (k: IntField) => Number(d[k]), hs = parseHm(d.hoursStart), he = parseHm(d.hoursEnd);
  return {
    principal: { kind: 'agent', id: a.id }, mode: 'live', accountIds: [d.accountId], instruments: [a.instrument], marketKinds: ['perp'], orderTypes: ['limit'],
    maxCapitalUsd: d.maxCapitalUsd, maxOrderNotionalUsd: d.maxOrderNotionalUsd, maxPositionNotionalUsd: positionLimit(d, a), maxLeverage: d.maxLeverage, maxDailyLossUsd: d.maxDailyLossUsd, floorEquityUsd: d.floorEquityUsd,
    days: i('days'), frequency: { perMinute: i('perMinute'), perHour: i('perHour'), perDay: i('perDay') }, maxSlippageBps: i('maxSlippageBps'), maxFeeUsd: d.maxFeeUsd, stopConditions: [], strategySha256: a.strategySha256, label: d.label.trim(), locale,
    quoting: {
      terms: { levelsPerSide: i('levelsPerSide'), minHalfSpreadBps: i('minHalfSpreadBps'), maxDistanceBps: i('maxDistanceBps'), burstActions: i('burstActions'), actionsPerMinute: i('actionsPerMinute'), quotesPerHour: i('quotesPerHour'), quotesPerDay: i('quotesPerDay'),
        dailyTurnoverUsd: d.dailyTurnoverUsd, deadManSeconds: i('deadManSeconds') },
      engine: { policy: a.policy, quoteSizeUsd: a.quoteSizeUsd, softInventoryUsd: d.softInventoryUsd, hardInventoryUsd: d.hardInventoryUsd, maxSessionMinutes: i('maxSessionMinutes'), hours: hs !== null && he !== null ? { startUtcMinute: hs, endUtcMinute: he } : null,
        maxSessionLossUsd: d.maxSessionLossUsd, stopBeforeExpiryS: i('stopBeforeExpiryS'), breakers: { ...d.breakers }, flattenOnStop: d.flattenOnStop },
    },
  };
}

// ------------------------------------------------------------------------------------------------------------------ Risk: the quoting mandates
export interface MandateRow { id: string; kind?: string; label: string; principal: { kind: string; id: string }; state: string; phase: string; notAfter?: number; mandate?: { notAfter?: number }; integrity?: { ok: boolean; reason: string | null } | null }
export const quotingMandates = <T extends { kind?: string }>(rows: readonly T[]): T[] => rows.filter((m) => m.kind === 'quoting');
export const canRevoke = (m: { state: string }): boolean => m.state === 'active' || m.state === 'created' || m.state === 'pending_signer';
export const canApprove = (m: { state: string }): boolean => m.state === 'created' || m.state === 'pending_signer';
/** Monitor: the two capability lines of market making read their label from the `mm` block */
export const capKey = (id: string): Key => ((id.startsWith('deriv_mm_') ? `mmCap_${id}` : `hdCap_${id}`) as Key);
