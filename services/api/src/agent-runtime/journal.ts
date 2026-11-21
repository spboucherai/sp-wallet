/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/agent-runtime/journal.ts
 * Module           : agent-runtime
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
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

// The agent journal and the signal history.
//
// Journal = the `research_log` table, extended (mode, severity, code, config_version, ref): every decision, order, fill, error,
// risk denial, mandate event and state change of an agent, in one per-agent, per-mode timeline. The older call sites that
// insert without a mode get the agent's current mode from a database trigger (db.ts), so no line is ever mode-less.
//
// Signals = the `agent_signals` table (perp_agent_signals generalised): one row per agent, MODE and bar (or decision instant
// for the stream engine), with the configuration version, the strategy hash, a digest of the inputs, the output and the
// decision taken on it: acted, or skipped with a reason code.
import { sql } from '../db.ts';
import { canonicalJson, sha256Hex, type DbMode } from './model.ts';

export const JOURNAL_KINDS = ['decision', 'order', 'fill', 'error', 'risk', 'mandate', 'state', 'proposal', 'hold', 'stop', 'flag', 'live', 'research', 'job'] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];
export type Severity = 'info' | 'warning' | 'error';
export interface JournalEntry { mode?: DbMode; kind: JournalKind; code?: string | null; severity?: Severity; title: string; body?: string; data?: unknown; ref?: Record<string, unknown> | null; configVersion?: number | null }

/** Append to an agent's journal. Never throws: the journal must not break the thing it describes. */
export async function journal(agentId: string, e: JournalEntry): Promise<void> {
  try {
    await sql`insert into research_log (agent_id, kind, title, body, data, mode, severity, code, config_version, ref)
      values (${agentId}, ${e.kind}, ${e.title.slice(0, 200)}, ${(e.body ?? '').slice(0, 2000)}, ${e.data === undefined ? null : sql.json(e.data as never)}, ${e.mode ?? null}, ${e.severity ?? 'info'}, ${e.code ?? null},
        ${e.configVersion ?? null}, ${e.ref ? sql.json(e.ref as never) : null})`;
  } catch { /* the database is down: the caller's own error says so */ }
}

export const inputsDigest = (inputs: unknown): string => sha256Hex(canonicalJson(inputs));

export const REASON_CODES = ['acted', 'at_target', 'no_valid_signal', 'data_not_fresh', 'data_gap', 'risk_limit', 'kill_switch', 'orders_refused', 'orders_deferred', 'no_quote', 'below_threshold', 'inventory_limit',
  'edge_below_threshold', 'research_mode', 'loss_limit', 'other_version', 'no_market'] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface SignalRow { id: string; agent_id: string; bar: Date; mode: DbMode; kind: string; config_version: number; strategy_sha256: string; inputs_digest: string | null; status: string; reason: string;
  decision: 'pending' | 'acted' | 'skipped'; reason_code: string | null; weights: unknown; scaled: unknown; scale: string | null; equity: string | null; targets: unknown; orders: unknown; created_at: Date; updated_at: Date }

/** Record the output of a strategy BEFORE anything is done with it. An existing row for (agent, mode, bar) is returned as it is:
 *  a restart reads the decision back instead of computing another one. */
export async function recordSignal(s: { agentId: string; mode: DbMode; kind: string; bar: number; configVersion: number; strategySha256: string; inputsDigest: string | null; output: unknown; status: 'decided' | 'hold'; reason?: string }): Promise<SignalRow> {
  const [row] = await sql<SignalRow[]>`insert into agent_signals (agent_id, bar, mode, kind, config_version, strategy_sha256, inputs_digest, status, reason, decision, reason_code, weights)
    values (${s.agentId}, ${new Date(s.bar)}, ${s.mode}, ${s.kind}, ${s.configVersion}, ${s.strategySha256}, ${s.inputsDigest}, ${s.status}, ${(s.reason ?? '').slice(0, 300)}, ${s.status === 'hold' ? 'skipped' : 'pending'},
      ${s.status === 'hold' ? 'no_valid_signal' : null}, ${s.output === null || s.output === undefined ? null : sql.json(s.output as never)})
    on conflict (agent_id, mode, bar) do update set updated_at = now() returning *`;
  return row!;
}
export const getSignal = async (agentId: string, mode: DbMode, bar: number): Promise<SignalRow | null> =>
  (await sql<SignalRow[]>`select * from agent_signals where agent_id = ${agentId} and mode = ${mode} and bar = ${new Date(bar)}`)[0] ?? null;

/** What was done with a signal. `acted` = at least one order was placed; `skipped` carries the reason code. */
export async function decideSignal(id: string, d: { decision: 'acted' | 'skipped'; reasonCode: ReasonCode; reason?: string; orders?: unknown; equity?: string | number | null; targets?: unknown; scaled?: unknown; scale?: string | null; status?: string }): Promise<void> {
  await sql`update agent_signals set decision = ${d.decision}, reason_code = ${d.reasonCode}, reason = case when ${d.reason ?? null}::text is null then reason else ${(d.reason ?? '').slice(0, 300)} end,
    orders = coalesce(${d.orders === undefined ? null : sql.json(d.orders as never)}, orders), equity = coalesce(${d.equity === undefined || d.equity === null ? null : String(d.equity)}::numeric, equity),
    targets = coalesce(${d.targets === undefined ? null : sql.json(d.targets as never)}, targets), scaled = coalesce(${d.scaled === undefined ? null : sql.json(d.scaled as never)}, scaled), scale = coalesce(${d.scale ?? null}, scale),
    status = coalesce(${d.status ?? null}, status), updated_at = now() where id = ${id}`;
}

/** the decision a finished perp bar amounts to, from its order results (perp-engine.ts writes `orders.list`) */
export function decisionOf(results: { status?: unknown }[], planned: number): { decision: 'acted' | 'skipped'; reasonCode: ReasonCode } {
  const sent = results.filter((r) => ['filled', 'partially_filled', 'open', 'cancelled'].includes(String(r.status))).length;
  if (sent > 0) return { decision: 'acted', reasonCode: 'acted' };
  if (results.some((r) => r.status === 'deferred')) return { decision: 'skipped', reasonCode: 'orders_deferred' };
  if (results.some((r) => r.status === 'refused' || r.status === 'rejected')) return { decision: 'skipped', reasonCode: 'orders_refused' };
  return { decision: 'skipped', reasonCode: planned > 0 ? 'orders_refused' : 'at_target' };
}
