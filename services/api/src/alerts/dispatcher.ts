/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/alerts/dispatcher.ts
 * Module           : alerts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// The ONE alert dispatcher.
//
// How events become alerts — and why exactly once
// ------------------------------------------------
// The money code is not touched: it already records everything important in three append-only tables (audit_events — the hash
// chain —, deriv_risk_events, research_log). The dispatcher TAILS those tables by id. One pass is one database transaction that
//   1. takes an advisory lock (one dispatcher at a time, even with two API processes),
//   2. reads the rows after the stored cursor,
//   3. inserts the alerts they produce,
//   4. advances the cursor,
// and commits all of it together. A crash anywhere before the commit leaves the cursor where it was and no alert written: the
// next pass redoes the same rows. A crash after the commit has both the alerts and the new cursor. There is no window in which
// an event is consumed without its alert, or an alert written without the event being consumed — no in-memory queue, no hook
// that could fire inside a money transaction that later rolls back, nothing lost while the process is down (the rows wait).
//
// audit_events numbers its rows under a lock held until commit, so its ids become visible in order and a plain cursor is exact.
// The two bigserial tables can commit out of order (a transaction that took id 5 may commit after id 6 is visible): for them the
// pass re-reads an overlap window behind the cursor and records the ids it handled in `alert_seen`, in the same transaction, so
// a late row is picked up once and an already handled row is skipped. A unique index on (source, source_id, kind) is the last
// line: the same event cannot produce the same alert twice whatever happens above.
//
// Delivery (push, webhook) is a second step on rows marked `pending`. A row is claimed (pending → sent) BEFORE the network call:
// a crash in between loses that notification rather than repeating it — the alert itself is in the app either way. At most once.
import { alertDef, safeParams, type AlertParams, type AlertSeverity, type AlertSubject } from '@spw/core';
import { sql } from '../db.ts';
import { diskFree, lastBackup } from '../monitor/health.ts';
import { conditionDrafts, type ConditionDeps } from './conditions.ts';
import { deriveAlerts, pinDraft, pinOf, type AlertEvent, type Draft } from './rules.ts';
import { vapidKeys, vapidSubject, webhookSecret } from './secrets.ts';
import { alertSettings, getState, migrateAlerts, putState, type AlertRow, type AlertSettings } from './store.ts';
import { sendWebhook } from './webhook.ts';
import { sendPush, type PushOutcome } from './webpush.ts';

type Q = typeof sql;
export interface DispatcherDeps extends ConditionDeps {
  fetch: typeof fetch;
  origin: string;
  /** audit rows younger than this wait one pass (a route writes its audit row a moment before the rows the rule reads) */
  settleMs: number;
  /** tests: webhook to a local http receiver */
  allowHttpWebhook: boolean;
  /** tests: fault injection inside the tailing transaction (throwing here is a crash before the commit) */
  fault?: (stage: 'before_cursor', source: string) => void;
}
interface Source { name: 'audit' | 'risk' | 'research'; overlap: number; max(q: Q): Promise<number>; read(q: Q, after: number, limit: number): Promise<AlertEvent[]> }
const OVERLAP = 200, BATCH = 500;
const SOURCES: Source[] = [
  { name: 'audit', overlap: 0,
    max: async (q) => Number((await q<{ m: string | null }[]>`select max(seq) as m from audit_events`)[0]?.m ?? 0),
    read: async (q, after, limit) => (await q<{ seq: string; ts: string; type: string; actor: string; data: Record<string, unknown> }[]>`select seq, ts, type, actor, data from audit_events where seq > ${after} order by seq limit ${limit}`)
      .map((r) => ({ source: 'audit' as const, id: Number(r.seq), ts: new Date(r.ts), type: r.type, actor: r.actor, data: r.data ?? {} })) },
  { name: 'risk', overlap: OVERLAP,
    max: async (q) => Number((await q<{ m: string | null }[]>`select max(id) as m from deriv_risk_events`)[0]?.m ?? 0),
    read: async (q, after, limit) => (await q<{ id: string; account_id: string; ts: Date; kind: string; code: string | null; message: string; data: Record<string, unknown> }[]>`
      select id, account_id, ts, kind, code, message, data from deriv_risk_events where id > ${after} order by id limit ${limit}`)
      .map((r) => ({ source: 'risk' as const, id: Number(r.id), ts: r.ts, type: r.kind, code: r.code, message: r.message, accountId: r.account_id, data: r.data ?? {} })) },
  { name: 'research', overlap: OVERLAP,
    max: async (q) => Number((await q<{ m: string | null }[]>`select max(id) as m from research_log`)[0]?.m ?? 0),
    read: async (q, after, limit) => (await q<{ id: string; agent_id: string | null; ts: Date; kind: string; title: string; body: string }[]>`
      select id, agent_id, ts, kind, title, body from research_log where id > ${after} order by id limit ${limit}`)
      .map((r) => ({ source: 'research' as const, id: Number(r.id), ts: r.ts, type: r.kind, title: r.title, message: r.body, agentId: r.agent_id, data: {} })) },
];

/** local HH:MM of an instant in a time zone */
export function localMinutes(now: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  return Number(parts.find((p) => p.type === 'hour')!.value) * 60 + Number(parts.find((p) => p.type === 'minute')!.value);
}
export function inQuietHours(now: number, q: AlertSettings['quiet']): boolean {
  if (!q.enabled) return false;
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)), a = m(q.start), b = m(q.end), t = localMinutes(now, q.tz);
  if (a === b) return false;
  return a < b ? t >= a && t < b : t >= a || t < b;                  // a window that crosses midnight
}

export class AlertDispatcher {
  readonly deps: DispatcherDeps;
  private readonly listeners = new Set<() => void>();
  private lastConditions = 0;
  constructor(deps: DispatcherDeps) { this.deps = deps; }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  changed(): void { for (const l of [...this.listeners]) { try { l(); } catch { /* a listener must not break the others */ } } }

  /** Insert one alert (or bump a digest). Returns true when a row was created or bumped. Honors the owner's switch for the kind. */
  async raise(draft: Draft, o: { q?: Q; ts?: Date; source?: string; sourceId?: string; settings?: AlertSettings } = {}): Promise<boolean> {
    const def = alertDef(draft.kind), q = o.q ?? sql, s = o.settings ?? await alertSettings();
    if (!def) return false;
    if (!def.fixed && s.rules[draft.kind] === false) return false;
    const severity: AlertSeverity = draft.severity ?? def.severity, ts = o.ts ?? new Date(this.deps.now());
    const params: AlertParams = Object.fromEntries(Object.entries(draft.params).filter(([, v]) => v !== undefined));
    const subject: AlertSubject | null = draft.subject ?? null;
    const ins = await q`insert into alerts (ts, kind, severity, params, subject, dedupe_key, source, source_id)
      values (${ts}, ${draft.kind}, ${severity}, ${q.json(params as never)}, ${subject ? q.json(subject as never) : null}, ${draft.dedupe ?? null}, ${o.source ?? 'rule'}, ${o.sourceId ?? null})
      on conflict do nothing returning id`;
    if (ins.length) return true;
    if (!draft.bump || !draft.dedupe) return false;
    // digest: the alert of this window already exists — count this event on it (and show it as unread again)
    const up = await q`update alerts set count = count + 1, params = (params || ${q.json(params as never)}) || jsonb_build_object('count', count + 1), ts = ${ts}, read_at = null
      where dedupe_key = ${draft.dedupe} returning id`;
    return up.length > 0;
  }

  /** events → alerts, one transaction (see the header). Returns the number of alerts created or bumped. */
  async tail(): Promise<number> {
    const settings = await alertSettings(), settleBefore = this.deps.now() - this.deps.settleMs;
    const n = await sql.begin(async (tx) => {
      const q = tx as unknown as Q;
      await tx`select pg_advisory_xact_lock(7707002)`;
      let made = 0;
      for (const src of SOURCES) {
        const [c] = await tx<{ cursor: string; floor: string }[]>`select cursor, floor from alert_cursors where source = ${src.name} for update`;
        if (!c) {                                                    // first run: start from the present, history is not replayed
          const m = await src.max(q);
          await tx`insert into alert_cursors (source, cursor, floor) values (${src.name}, ${m}, ${m})`;
          continue;
        }
        const cursor = Number(c.cursor), floor = Number(c.floor);
        let rows = await src.read(q, Math.max(floor, cursor - src.overlap), BATCH);
        if (src.name === 'audit') { const k = rows.findIndex((r) => r.ts.getTime() > settleBefore); if (k >= 0) rows = rows.slice(0, k); }
        if (!rows.length) continue;
        let fresh = rows;
        if (src.overlap > 0) {
          const claimed = await tx<{ id: string }[]>`insert into alert_seen ${tx(rows.map((r) => ({ source: src.name, id: r.id })))} on conflict do nothing returning id`;
          const set = new Set(claimed.map((r) => Number(r.id)));
          fresh = rows.filter((r) => set.has(r.id));
        }
        for (const ev of fresh) {
          // a rule that fails on one event must not stop the others: its work is rolled back to a savepoint and the event is skipped
          try {
            await tx.savepoint(async (sp) => {
              const sq = sp as unknown as Q;
              for (const d of await deriveAlerts(ev, { q: sq, settings })) if (await this.raise(d, { q: sq, ts: ev.ts, source: ev.source, sourceId: String(ev.id), settings })) made += 1;
            });
          } catch (e) { console.error(`[alerts] rule failed on ${ev.source} #${ev.id} (${ev.type}): ${(e as Error).message.slice(0, 200)}`); }
        }
        this.deps.fault?.('before_cursor', src.name);
        const next = Math.max(cursor, rows[rows.length - 1]!.id);
        await tx`update alert_cursors set cursor = ${next} where source = ${src.name}`;
        if (src.overlap > 0) await tx`delete from alert_seen where source = ${src.name} and id <= ${next - src.overlap}`;
      }
      return made;
    });
    if (n > 0) this.changed();
    return n;
  }

  /** polled conditions (stuck transfers, expiring mandates, signer, connectors, audit chain, backup, disk, loops) */
  async conditions(): Promise<number> {
    const settings = await alertSettings();
    let n = 0;
    for (const d of await conditionDrafts(this.deps, settings)) if (await this.raise(d, { settings })) n += 1;
    if (n > 0) this.changed();
    return n;
  }

  /** a refusal seen at the HTTP layer that is recorded nowhere else (pinned code changed, asset table mismatch, signer refusals) */
  async signal(code: string, message: string): Promise<void> {
    const ts = new Date(this.deps.now()), what = pinOf(code, message);
    let d: Draft | null = null;
    if (what) d = pinDraft(what, message, ts);
    else if (code === 'asset_table_mismatch') d = { kind: 'deriv.asset_table_mismatch', params: {}, dedupe: `asset_table:${Math.floor(ts.getTime() / 3_600_000)}` };
    else if (code.startsWith('signer_') && code !== 'signer_unreachable') d = { kind: 'security.signer_refused', params: { reason: message.slice(0, 160) }, dedupe: `signer_refused:${Math.floor(ts.getTime() / 900_000)}`, bump: true };
    if (d && (await this.raise(d, { ts }))) this.changed();
  }

  /** pending alerts → push and webhook, with quiet hours and the hourly cap */
  async deliver(): Promise<{ sent: number; quiet: number; capped: number }> {
    const now = this.deps.now(), s = await alertSettings(), out = { sent: 0, quiet: 0, capped: 0 };
    const hour = Math.floor(now / 3_600_000);
    let cap = await getState<{ bucket: number; sent: number; suppressed: number }>('cap', { bucket: hour, sent: 0, suppressed: 0 });
    if (cap.bucket !== hour) {
      // the hour is over: ONE summary for everything the cap held back
      if (cap.suppressed > 0) await this.raise({ kind: 'system.alerts_capped', params: { count: cap.suppressed }, dedupe: `cap:${cap.bucket}` }, { settings: s });
      cap = { bucket: hour, sent: 0, suppressed: 0 };
      await putState('cap', cap);
    }
    const rows = await sql<AlertRow[]>`select * from alerts where delivery = 'pending' order by id limit 100`;
    if (!rows.length) return out;
    const subs = await sql<{ id: string; endpoint: string; p256dh: string; auth: string; locale: string }[]>`select id, endpoint, p256dh, auth, locale from push_subscriptions`;
    const hook = s.webhook.enabled && s.webhook.url ? webhookSecret() : null;
    for (const a of rows) {
      const critical = a.severity === 'critical';
      const decision = subs.length === 0 && !hook ? 'inapp'
        : Date.now() - a.created_at.getTime() > 3_600_000 ? 'stale'
        : !critical && inQuietHours(now, s.quiet) ? 'quiet'
        : !critical && a.kind !== 'system.alerts_capped' && cap.sent >= s.capPerHour ? 'capped' : 'sent';
      // claim first: a crash after this line never repeats a notification
      const claim = await sql`update alerts set delivery = ${decision} where id = ${a.id} and delivery = 'pending' returning id`;
      if (!claim.length) continue;
      if (decision === 'quiet') { out.quiet += 1; continue; }
      if (decision === 'capped') { out.capped += 1; cap.suppressed += 1; await putState('cap', cap); continue; }
      if (decision !== 'sent') continue;
      cap.sent += 1; await putState('cap', cap); out.sent += 1;
      const channels: Record<string, unknown> = {};
      if (subs.length) {
        const res = await Promise.all(subs.map((sub) => this.pushOne(sub, a, s.showDetails)));
        channels.push = { sent: res.filter((r) => r.ok).length, failed: res.filter((r) => !r.ok && !r.gone).length, removed: res.filter((r) => !r.ok && r.gone).length };
      }
      if (hook) {
        const r = await sendWebhook(s.webhook.url, hook, a, s.webhook.details, { now, fetch: this.deps.fetch, allowHttp: this.deps.allowHttpWebhook });
        channels.webhook = { ok: r.ok, status: r.status };
      }
      await sql`update alerts set channels = ${sql.json(channels as never)} where id = ${a.id}`;
    }
    return out;
  }

  /** one encrypted push to one device; a subscription the push service no longer knows (404/410) is removed */
  async pushOne(sub: { id: string; endpoint: string; p256dh: string; auth: string; locale: string }, a: Pick<AlertRow, 'id' | 'kind' | 'severity' | 'params' | 'subject' | 'count' | 'ts'>, details: boolean): Promise<PushOutcome & { gone?: boolean }> {
    const p = { ...a.params, count: a.params.count ?? a.count };
    // minimal payload: a kind and parameters; without "show details" only names, networks and counts leave the server
    const payload = JSON.stringify({ v: 1, id: Number(a.id), kind: a.kind, sev: a.severity, ts: a.ts.getTime(), l: sub.locale === 'en' ? 'en' : 'fr', d: details, p: details ? p : safeParams(p), s: a.subject });
    const r = await sendPush(sub, Buffer.from(payload), vapidKeys(), { subject: vapidSubject(this.deps.origin), urgency: a.severity === 'critical' ? 'high' : 'normal', ttl: a.severity === 'critical' ? 86_400 : 14_400, fetch: this.deps.fetch });
    if (r.ok) await sql`update push_subscriptions set last_ok_at = now(), last_error = null, failures = 0 where id = ${sub.id}`;
    else if (r.gone) await sql`delete from push_subscriptions where id = ${sub.id}`;
    else await sql`update push_subscriptions set failures = failures + 1, last_error = ${r.error} where id = ${sub.id}`;
    return r;
  }

  async step(): Promise<void> {
    await this.tail();
    const now = Date.now();
    if (now - this.lastConditions >= 30_000) { this.lastConditions = now; await this.conditions(); }
    await this.deliver();
  }
}

let shared: AlertDispatcher | null = null;
/** the process-wide dispatcher on the real signer client, RPC health cache and worker heartbeats */
export async function alerts(): Promise<AlertDispatcher> {
  if (shared) return shared;
  const [{ config }, { signer }, worker] = await Promise.all([import('../config.ts'), import('../signer-client.ts'), import('../worker.ts')]);
  shared = new AlertDispatcher({
    now: Date.now, fetch, origin: config.origin, settleMs: 1500, allowHttpWebhook: false,
    signerStatus: () => signer.status().catch(() => null), rpcHealth: () => [...worker.healthCache.values()], loops: () => [...worker.loopStats.values()],
    backup: () => lastBackup(), disk: () => diskFree(),
  });
  return shared;
}
/** tests: replace the process-wide dispatcher */
export const setAlerts = (d: AlertDispatcher | null): void => { shared = d; };

export const ALERTS_STEP_MS = 5_000;
/** Started with the other workers. Says once that the API (re)started. */
export async function startAlerts(): Promise<void> {
  await migrateAlerts();
  const d = await alerts(), { loop } = await import('../worker.ts');
  vapidKeys();                                                       // generate the key pair at first start, not at the first subscription
  const boot = Date.now();
  await d.raise({ kind: 'system.api_restarted', params: {}, dedupe: `boot:${boot}` }).catch((e: Error) => console.error(`[alerts] ${e.message}`));
  loop('alerts', () => d.step(), ALERTS_STEP_MS);
}
