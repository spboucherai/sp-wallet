/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/alerts/conditions.ts
 * Module           : alerts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-19
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

// Condition rules: things that are true for a while rather than events (a transfer still pending, a mandate close to its end,
// a signer that stopped answering, a missing backup…). They are polled; every alert carries a dedupe key naming the episode, so
// a condition that stays true — or a process that restarts while it is true — says it once. Reads only.
import { createHash } from 'node:crypto';
import { getNetwork } from '@spw/core';
import { credentialSets } from '../auth.ts'; // NEXT: signer passkeys vs the application's table
import { sql } from '../db.ts';
import { auditChainStatus, collectConnectors, diskFree, lastBackup, type HealthDeps } from '../monitor/health.ts';
import { derivAccount, INTERVAL_MS, type Draft } from './rules.ts';
import { delState, getState, putState, type AlertSettings } from './store.ts';
import { labStatus, type LabStatus } from '../agents/lab.ts'; // v8

export interface ConditionDeps extends HealthDeps {
  backup(): ReturnType<typeof lastBackup>;
  disk(): ReturnType<typeof diskFree>;
  /** v8: health of the OS sandbox of strategy code (default: the real one) */
  lab?(): Promise<LabStatus>;
}
const netName = (id: string): string => { try { return getNetwork(id).name; } catch { return id; } };
const TERMINAL_BAD = ['failed', 'rejected', 'expired', 'replaced', 'draft', 'pending_approval', 'approved'];

/** "bad for long enough" → 'down' once; back to good after a 'down' → 'up' once. The clock is in the database: a restart changes nothing. */
async function debounce(key: string, bad: boolean | null, now: number, afterMs: number): Promise<{ edge: 'down' | 'up' | null; since: number }> {
  const k = `deb:${key}`, st = await getState<{ since: number; alerted: boolean } | null>(k, null);
  if (bad) {
    if (!st) { await putState(k, { since: now, alerted: false }); return { edge: null, since: now }; }
    if (!st.alerted && now - st.since >= afterMs) { await putState(k, { since: st.since, alerted: true }); return { edge: 'down', since: st.since }; }
    return { edge: null, since: st.since };
  }
  if (st) { await delState(k); return { edge: bad === false && st.alerted ? 'up' : null, since: st.since }; }
  return { edge: null, since: now };
}

export async function conditionDrafts(d: ConditionDeps, s: AlertSettings): Promise<Draft[]> {
  const now = d.now(), th = s.thresholds, out: Draft[] = [];
  // the alerts layer only looks at what happened after it first ran: no flood of history on the first start
  let epoch = await getState<number | null>('epoch', null);
  if (epoch === null) { epoch = now; await putState('epoch', now); }

  // 1 — transfers, swaps and bridges still not final
  const stuck = await sql<{ id: string; kind: string; network: string; state: string; phase: string | null; created_at: Date }[]>`
    select id, kind, network, state, bridge->>'phase' as phase, created_at from proposals
    where (kind <> 'bridge' and state in ('signed','broadcast','confirming','reorged') and created_at < ${new Date(now - th.stuckMinutes * 60_000)})
       or (kind = 'bridge' and state <> all(${TERMINAL_BAD}) and coalesce(bridge->>'phase', '') <> 'done' and created_at < ${new Date(now - th.bridgeStuckMinutes * 60_000)})`;
  for (const p of stuck) {
    const state = p.kind === 'bridge' && p.phase && p.state === 'finalized' ? (p.phase === 'attesting' ? '@attesting' : p.phase.startsWith('mint') ? '@minting' : p.phase) : `@${p.state}`;
    out.push({ kind: 'transfer.stuck', params: { what: `@${p.kind === 'swap' ? 'swap' : p.kind === 'bridge' ? 'bridge' : 'transfer'}`, network: netName(p.network), state, minutes: Math.floor((now - p.created_at.getTime()) / 60_000) },
      subject: { type: 'proposal', id: p.id, network: p.network }, dedupe: `stuck:${p.id}` });
  }

  // 2 — mandates about to expire (72 h, then 24 h)
  const agents = await sql<{ id: string; name: string; state: string; interval: string; last_bar: Date | null; mandate_id: string | null; mandate: { expiresAt?: number } | null }[]>`
    select id, name, state, interval, last_bar, mandate_id, mandate from agents where state in ('PAPER_TRADING', 'LIVE')`;
  for (const a of agents) {
    const exp = (a.mandate?.expiresAt ?? 0) * 1000;
    if (a.state === 'LIVE' && a.mandate_id && exp > now) {
      const left = exp - now, hours = left <= 24 * 3_600_000 ? 24 : left <= 72 * 3_600_000 ? 72 : 0;
      if (hours) out.push({ kind: 'mandate.expiring', severity: hours === 24 ? 'warning' : 'info', params: { agent: a.name, hours }, subject: { type: 'agent', id: a.id }, dedupe: `mandate:${a.mandate_id}:${hours}` });
    }
    // 3 — an active agent that has not completed a bar for too long (stale or inconsistent market data: it holds, and says nothing)
    const iv = INTERVAL_MS[a.interval] ?? 3_600_000;
    if (a.last_bar && now - a.last_bar.getTime() > (th.staleBars + 2) * iv)
      out.push({ kind: 'agent.data_stale', params: { agent: a.name, bars: Math.floor((now - a.last_bar.getTime()) / iv) - 1, interval: a.interval }, subject: { type: 'agent', id: a.id }, dedupe: `stale:${a.id}:${a.last_bar.getTime()}` });
  }

  // 4 — a live order the venue never confirmed nor denied
  const unknown = await sql<{ account_id: string; client_id: string; instrument: string }[]>`
    select o.account_id, o.client_id, o.instrument from deriv_orders o join deriv_accounts a on a.id = o.account_id
    where o.state = 'unknown' and not o.final and o.updated_at < ${new Date(now - th.unknownOrderSec * 1000)}`;
  for (const o of unknown) out.push({ kind: 'deriv.order_unknown', params: { account: (await derivAccount(sql, o.account_id)).label, clientId: o.client_id, instrument: o.instrument, seconds: th.unknownOrderSec },
    subject: { type: 'account', id: o.account_id }, dedupe: `unknown:${o.account_id}:${o.client_id}` });

  // 5 — a liquidation reported by a venue (paper liquidations come from the audit chain, labelled simulated)
  const since = new Date(Math.max(epoch, now - 48 * 3_600_000));
  const liq = await sql<{ account_id: string; fill_id: string; instrument: string; size: string; price: string }[]>`
    select f.account_id, f.fill_id, f.instrument, f.size::text as size, f.price::text as price from deriv_fills f join deriv_accounts a on a.id = f.account_id where f.liquidation and f.ts > ${since}`;
  for (const f of liq) out.push({ kind: 'deriv.live.liquidation', params: { account: (await derivAccount(sql, f.account_id)).label, instrument: f.instrument, size: f.size, price: f.price },
    subject: { type: 'account', id: f.account_id }, dedupe: `liq:${f.account_id}:${f.fill_id}` });

  // 6 — funding payments above the owner's threshold
  const funding = await sql<{ account_id: string; instrument: string; ts: Date; amount: string }[]>`
    select account_id, instrument, ts, amount::text as amount from deriv_funding where ts > ${since} and abs(amount) >= ${th.fundingUsd}`;
  for (const f of funding) { const acct = await derivAccount(sql, f.account_id);
    out.push({ kind: 'deriv.funding', params: { account: acct.label, mode: acct.mode, instrument: f.instrument, amount: Number(f.amount).toFixed(2) }, subject: { type: 'account', id: f.account_id }, dedupe: `funding:${f.account_id}:${f.instrument}:${f.ts.getTime()}` }); }

  // 7 — signer and every other connector, debounced
  const { connectors, signer } = await collectConnectors(d);
  const sig = await debounce('signer', signer === null, now, Math.min(th.feedDebounceSec, 120) * 1000);
  if (sig.edge === 'down') out.push({ kind: 'security.signer_unreachable', params: { minutes: Math.max(1, Math.round((now - sig.since) / 60_000)) }, dedupe: `signer.down:${sig.since}` });
  if (sig.edge === 'up') out.push({ kind: 'security.signer_back', params: {}, dedupe: `signer.up:${sig.since}` });
  if (signer) {
    const policyHash = createHash('sha256').update(JSON.stringify(signer.policy ?? null)).digest('hex').slice(0, 16), version = (signer.policy as { version?: number } | undefined)?.version ?? null;
    const prev = await getState<{ halted: boolean; policyHash: string } | null>('signer', null);
    if (prev && prev.halted !== signer.halted) out.push({ kind: signer.halted ? 'security.signer_halted' : 'security.signer_unhalted', params: {}, dedupe: `signer.halt:${signer.halted}:${now}` });
    if (prev && prev.policyHash !== policyHash) out.push({ kind: 'security.policy_changed', params: { what: '@signer', detail: version === null ? '' : `version ${version}` }, dedupe: `signer.policy:${policyHash}` });
    if (!prev || prev.halted !== signer.halted || prev.policyHash !== policyHash) await putState('signer', { halted: signer.halted, policyHash });
    // NEXT: the signer's passkeys against the application's table, looked at on every pass. A divergence that lasts is written to the
    // audit chain there (auth.ts `credentialSets`); the alert `security.credential_mismatch` is derived from that event (rules.ts).
    await credentialSets(signer, now).catch(() => {});
  }
  for (const c of connectors) {
    if (c.id === 'signer') continue;
    const r = await debounce(`conn:${c.id}`, c.ok === null ? null : !c.ok, now, th.feedDebounceSec * 1000);
    const subject = c.group === 'rpc' ? { type: 'network' as const, network: c.id.slice(4) } : { type: 'none' as const };
    if (r.edge === 'down') out.push({ kind: 'conn.down', params: { name: c.name, minutes: Math.max(1, Math.round((now - r.since) / 60_000)) }, subject, dedupe: `conn.down:${c.id}:${r.since}` });
    if (r.edge === 'up') out.push({ kind: 'conn.up', params: { name: c.name }, subject, dedupe: `conn.up:${c.id}:${r.since}` });
  }

  // 8 — audit chain
  const audit = await auditChainStatus(now);
  if (!audit.intact) out.push({ kind: 'security.audit_broken', params: { seq: audit.brokenAt ?? 0 }, dedupe: `audit_broken:${audit.brokenAt}` });

  // 9 — backup, disk, worker loops (a reminder per day while it lasts)
  const dayKey = new Date(now).toISOString().slice(0, 10);
  const b = d.backup();
  if (b && b.lastAt !== null && now - b.lastAt > th.backupHours * 3_600_000) out.push({ kind: 'system.backup_missing', params: { hours: Math.floor((now - b.lastAt) / 3_600_000) }, dedupe: `backup:${dayKey}` });
  const disk = await d.disk();
  if (disk && disk.freePct < th.diskFreePct) out.push({ kind: 'system.disk_low', params: { pct: disk.freePct }, dedupe: `disk:${dayKey}` });
  for (const l of d.loops()) if (l.failures >= 5) out.push({ kind: 'system.worker_failing', params: { loop: l.name, count: l.failures, reason: l.lastError ?? '' }, dedupe: `loop:${l.name}:${Math.floor(now / (6 * 3_600_000))}` });
  // 10 — v8: the OS sandbox of strategy code. Unavailable = no signal and no backtest runs (fail closed): said once per
  // episode (on the second poll in a row that finds it broken), and once when it is back; the development switch that turns confinement off is said once per day while it is set.
  const lab = await (d.lab ?? labStatus)().catch(() => null);
  if (lab) {
    const r = await debounce('lab', lab.mode === 'unavailable', now, 0);
    if (r.edge === 'down') out.push({ kind: 'system.lab_sandbox_unavailable', params: { reason: (lab.reason ?? '').slice(0, 200) }, dedupe: `lab.down:${r.since}` });
    if (r.edge === 'up') out.push({ kind: 'system.lab_sandbox_back', params: {}, dedupe: `lab.up:${r.since}` });
    if (lab.mode === 'off') out.push({ kind: 'system.lab_sandbox_off', params: {}, dedupe: `lab.off:${dayKey}` });
  }
  return out;
}
