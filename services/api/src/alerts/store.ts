// Alerts storage: tables, owner settings, small state store. The tables are created here (not in db.ts) so the alerts layer stays
// in its own files; `migrateAlerts()` is idempotent and is called when the routes are registered and when the dispatcher starts.
import { z } from 'zod';
import { ALERT_DEFS, type AlertParams, type AlertSeverity, type AlertSubject } from '@spw/core';
import { getSetting, setSetting, sql } from '../db.ts';

const SCHEMA = `
create table if not exists alerts (
  id bigserial primary key, ts timestamptz not null, kind text not null, severity text not null,
  params jsonb not null default '{}', subject jsonb, dedupe_key text, source text not null default 'rule', source_id text,
  count int not null default 1, read_at timestamptz, delivery text not null default 'pending', channels jsonb not null default '{}',
  created_at timestamptz not null default now());
create unique index if not exists alerts_dedupe on alerts (dedupe_key) where dedupe_key is not null;
create unique index if not exists alerts_source on alerts (source, source_id, kind) where source_id is not null;
create index if not exists alerts_unread on alerts (id) where read_at is null;
create index if not exists alerts_pending on alerts (id) where delivery = 'pending';
-- one row per tailed table: the id up to which events were turned into alerts
-- (floor = the id at which tailing began: nothing at or before it is ever turned into an alert)
create table if not exists alert_cursors (source text primary key, cursor bigint not null, floor bigint not null default 0);
-- ids already handled inside the overlap window of a tailed table whose ids can commit out of order (bigserial)
create table if not exists alert_seen (source text not null, id bigint not null, primary key (source, id));
-- rule state that must survive a restart (debounce clocks, known devices, counters)
create table if not exists alert_state (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
create table if not exists push_subscriptions (
  id uuid primary key, endpoint text unique not null, p256dh text not null, auth text not null, label text not null default '',
  locale text not null default 'fr', ua text not null default '', created_at timestamptz not null default now(),
  last_ok_at timestamptz, last_error text, failures int not null default 0);
`;
let migrated: Promise<void> | null = null;
export function migrateAlerts(force = false): Promise<void> {
  if (force || !migrated) migrated = sql.unsafe(SCHEMA).then(() => {});
  return migrated;
}

export interface AlertRow {
  id: string; ts: Date; kind: string; severity: AlertSeverity; params: AlertParams; subject: AlertSubject | null; dedupe_key: string | null;
  source: string; source_id: string | null; count: number; read_at: Date | null; delivery: string; channels: Record<string, unknown>; created_at: Date;
}

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const validTz = (tz: string): boolean => { try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch { return false; } };
export const ThresholdsSchema = z.strictObject({
  /** a transfer or swap still not final after this many minutes */
  stuckMinutes: z.number().int().min(5).max(1440),
  bridgeStuckMinutes: z.number().int().min(10).max(2880),
  /** at most one "order filled" notification per agent per this many minutes (0 = one per order) */
  agentDigestMinutes: z.number().int().min(0).max(1440),
  staleBars: z.number().int().min(1).max(100),
  signalFailures: z.number().int().min(1).max(50),
  /** absolute funding payment, in the account's collateral currency (USD) */
  fundingUsd: z.number().min(0).max(1_000_000),
  diskFreePct: z.number().min(1).max(50),
  backupHours: z.number().int().min(1).max(720),
  /** a connector must be down this long before an alert, so a flapping feed says nothing */
  feedDebounceSec: z.number().int().min(30).max(3600),
  unknownOrderSec: z.number().int().min(15).max(3600),
});
export const AlertSettingsSchema = z.strictObject({
  rules: z.record(z.string(), z.boolean()),
  quiet: z.strictObject({ enabled: z.boolean(), start: HHMM, end: HHMM, tz: z.string().min(1).max(64).refine(validTz, 'unknown time zone') }),
  /** amounts, prices and reasons in push notifications (lock screen). Off by default. */
  showDetails: z.boolean(),
  /** push notifications and webhook calls per hour, criticals excepted */
  capPerHour: z.number().int().min(1).max(500),
  thresholds: ThresholdsSchema,
  webhook: z.strictObject({ enabled: z.boolean(), url: z.string().max(500), details: z.boolean() }),
});
export type AlertSettings = z.infer<typeof AlertSettingsSchema>;

export const DEFAULT_SETTINGS: AlertSettings = {
  rules: Object.fromEntries(ALERT_DEFS.filter((d) => !d.fixed).map((d) => [d.kind, d.on])),
  quiet: { enabled: false, start: '22:00', end: '07:00', tz: 'America/Toronto' },
  showDetails: false, capPerHour: 20,
  thresholds: { stuckMinutes: 30, bridgeStuckMinutes: 90, agentDigestMinutes: 30, staleBars: 3, signalFailures: 3, fundingUsd: 5, diskFreePct: 10, backupHours: 36, feedDebounceSec: 180, unknownOrderSec: 60 },
  webhook: { enabled: false, url: '', details: false },
};
const KEY = 'alerts';
let cachedSettings: { at: number; v: AlertSettings } | null = null;
/** stored settings merged over the defaults: a kind added by a release gets its default switch, an unknown key is dropped */
export async function alertSettings(fresh = false): Promise<AlertSettings> {
  if (!fresh && cachedSettings && Date.now() - cachedSettings.at < 3000) return cachedSettings.v;
  const s = await getSetting<Partial<AlertSettings>>(KEY, {});
  const rules = { ...DEFAULT_SETTINGS.rules };
  for (const k of Object.keys(rules)) if (typeof s.rules?.[k] === 'boolean') rules[k] = s.rules[k]!;
  const merged = { rules, quiet: { ...DEFAULT_SETTINGS.quiet, ...s.quiet }, showDetails: s.showDetails ?? DEFAULT_SETTINGS.showDetails, capPerHour: s.capPerHour ?? DEFAULT_SETTINGS.capPerHour,
    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...s.thresholds }, webhook: { ...DEFAULT_SETTINGS.webhook, ...s.webhook } };
  const p = AlertSettingsSchema.safeParse(merged);
  const v = p.success ? p.data : DEFAULT_SETTINGS;
  cachedSettings = { at: Date.now(), v };
  return v;
}
export async function saveAlertSettings(v: AlertSettings): Promise<AlertSettings> {
  await setSetting(KEY, AlertSettingsSchema.parse(v));
  cachedSettings = null;
  return alertSettings(true);
}

type Q = typeof sql;
export async function getState<T>(key: string, dflt: T, q: Q = sql): Promise<T> {
  const [r] = await q<{ value: T }[]>`select value from alert_state where key = ${key}`;
  return r ? r.value : dflt;
}
export async function putState(key: string, value: unknown, q: Q = sql): Promise<void> {
  await q`insert into alert_state (key, value, updated_at) values (${key}, ${q.json(value as never)}, now()) on conflict (key) do update set value = excluded.value, updated_at = now()`;
}
export async function delState(key: string, q: Q = sql): Promise<void> { await q`delete from alert_state where key = ${key}`; }
