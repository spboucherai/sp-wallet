/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/dashboard/summary.ts
 * Module           : dashboard
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

// GET /api/v1/dashboard/summary — the one read behind the Dashboard panels of Home. It COMPOSES what other services already
// compute and adds no figure of its own:
//   books.paper / .live / .liveTestnet   risk service `exposure(book)` — accounts, positions, exposure per asset and venue,
//                                        leverage, distances to liquidation, realized / unrealized PnL of the book. Three
//                                        separate books: there is NO figure across modes, here or on the screen.
//   risk                                 risk service — kill switch, read-only mode, the live limits that are not set yet
//   agents                               the agents table through the runtime's own vocabulary (lifecycleOf, modeOf): counts
//   agentsPnl                            monitor `pnl()` — today's equity difference per agent, grouped by the mode the
//                                        agent is in (one sum per mode, never across modes; research has no PnL)
//   health                               monitor `collectConnectors` — signer reachable, connectors that fail, late loops
//   audit                                monitor `auditChainStatus` — the hash chain of the audit journal
// Each section fails on its own: `{ ok: false, error: { code, message } }` for the source that could not be read (or that
// took longer than SECTION_TIMEOUT_MS), the others are answered. The screen translates `code`; `message` is for the logs.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { lifecycleOf, modeOf } from '../agent-runtime/model.ts';
import { alertSettings } from '../alerts/store.ts';
import { UserError } from '../config.ts';
import { sql } from '../db.ts';
import { pnl } from '../monitor/aggregate.ts';
import { auditChainStatus, collectConnectors } from '../monitor/health.ts';
import type { BookKey } from '../risk/service.ts';
import { signer } from '../signer-client.ts';
import { healthCache, loopStats } from '../worker.ts';
import type { DashboardOpts } from './index.ts';

export type Section<T> = { ok: true; data: T; asOf: number } | { ok: false; error: { code: string; message: string } };
export const SECTION_TIMEOUT_MS = 8_000;
/** one source, isolated: its answer, or why it could not be read (the code of a UserError, `timeout`, else `source_failed`) */
export async function section<T>(fn: () => Promise<T>, timeoutMs = SECTION_TIMEOUT_MS): Promise<Section<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new UserError('timeout', `no answer within ${timeoutMs} ms`, 504)), timeoutMs); });
    return { ok: true, data: await Promise.race([fn(), late]), asOf: Date.now() };
  } catch (e) {
    const x = e as { code?: unknown; message?: unknown };
    return { ok: false, error: { code: typeof x?.code === 'string' && /^[a-z0-9_]{1,60}$/.test(x.code) ? x.code : 'source_failed', message: String(x?.message ?? e).slice(0, 200) } };
  } finally { clearTimeout(timer); }
}

const MODES = ['research', 'paper', 'live'] as const;
type AgentMode = (typeof MODES)[number];
interface ModePnl { abs: number | null; /** agents of the mode whose figure is in `abs` */ agents: number; /** a series starts inside the day: the figure covers less than the day */ partial: boolean; /** why `abs` is null */ reason: 'research_no_pnl' | 'no_snapshot' | null }

/** counts per lifecycle and per mode, in the runtime's own vocabulary */
async function agentCounts() {
  const rows = await sql<{ id: string; state: string; mode: string }[]>`select id, state, mode from agents`;
  const zero = () => ({ active: 0, paused: 0, stopped: 0 });
  const byMode: Record<AgentMode, ReturnType<typeof zero>> = { research: zero(), paper: zero(), live: zero() }, total = zero();
  for (const a of rows) { const l = lifecycleOf(a.state), m = modeOf(a); total[l] += 1; byMode[m][l] += 1; }
  return { count: rows.length, total, byMode };
}
/** today's PnL of the agents, one figure per mode (monitor `pnl()`: equity differences between stored snapshots, flows included) */
async function agentPnlToday(now: number) {
  const [rows, p] = await Promise.all([sql<{ id: string; state: string; mode: string }[]>`select id, state, mode from agents`, pnl(now, (await alertSettings()).quiet.tz)]);
  const modeById = new Map(rows.map((a) => [a.id, modeOf(a)]));
  const out: Record<AgentMode, ModePnl> = { research: { abs: null, agents: 0, partial: false, reason: 'research_no_pnl' }, paper: { abs: null, agents: 0, partial: false, reason: 'no_snapshot' }, live: { abs: null, agents: 0, partial: false, reason: 'no_snapshot' } };
  for (const a of p.agents) {
    const m = modeById.get(a.id);
    if (!m || m === 'research' || !a.today) continue;
    const o = out[m];
    o.abs = Math.round(((o.abs ?? 0) + a.today.abs) * 100) / 100; o.agents += 1; o.partial = o.partial || a.today.partial; o.reason = null;
  }
  return { tz: p.tz, note: p.note, today: out };
}
async function health(now: number) {
  const { connectors, signer: st } = await collectConnectors({ now: () => now, signerStatus: () => signer.status().catch(() => null), rpcHealth: () => [...healthCache.values()], loops: () => [...loopStats.values()] });
  const loops = [...loopStats.values()];
  return {
    signer: st ? { reachable: true, halted: st.halted } : { reachable: false, halted: null },
    connectors: { total: connectors.length, ok: connectors.filter((c) => c.ok === true).length, notMeasured: connectors.filter((c) => c.ok === null).length,
      failing: connectors.filter((c) => c.ok === false).map((c) => ({ id: c.id, group: c.group, name: c.name, lastSuccessAt: c.lastSuccessAt })) },
    loops: { total: loops.length, late: loops.filter((l) => l.lastOkAt !== null && now - l.lastOkAt > Math.max(3 * l.everyMs, 60_000)).map((l) => l.name) },
  };
}

export function registerDashboardSummary(app: FastifyInstance, { execution }: DashboardOpts): void {
  const ownerOnly = (req: FastifyRequest): void => { if (req.principal?.kind !== 'owner') throw new UserError('owner_only', 'this route is for the owner\'s session', 403); };
  app.get('/api/v1/dashboard/summary', async (req) => {
    ownerOnly(req);
    z.object({}).parse(req.query ?? {});
    const { risk } = execution, now = Date.now();
    const book = (b: BookKey) => section(() => risk.exposure(b));
    const [paper, live, liveTestnet, riskState, agents, agentsPnl, healthS, audit] = await Promise.all([
      book('paper'), book('live-mainnet'), book('live-testnet'),
      section(async () => { const [switches, l] = await Promise.all([risk.switches(), risk.limits('live')]);
        return { switches, live: { missing: l.missing, missingForAutomation: l.missingForAutomation ?? [], ownerOrdersRefused: l.ownerOrdersRefused ?? false, automationOrdersRefused: l.automationOrdersRefused ?? false } }; }),
      section(agentCounts), section(() => agentPnlToday(now)), section(() => health(now)), section(() => auditChainStatus(now)),
    ]);
    return { ts: now, books: { paper, live, liveTestnet }, risk: riskState, agents, agentsPnl, health: healthS, audit };
  });
}
