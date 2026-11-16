// The owner's routes of market making: /api/v1/mm. The owner's session only — an API key never reaches these paths (the gate
// of server.ts refuses a key outside /api/v1/trading, and `ownerOnly` refuses it here again). A key starts, pauses and stops a
// market-making agent through the agents routes of the trading API, like any agent; it reads the agent there too.
//
//   GET  /api/v1/mm/evidence                         the lab study and the simulation AS THEY ARE (negative), the fees, the jurisdiction text
//   GET  /api/v1/mm/bounds                           the compiled maxima of a quoting mandate (each field of the form shows its own)
//   GET  /api/v1/mm/agents/:id?mode=paper|live       the session NOW (quotes, age, distance, inventory, breakers, switch), past sessions, the checklist, the locks
//   GET  /api/v1/mm/agents/:id/fills?mode=           fills with their markouts
//   GET  /api/v1/mm/agents/:id/performance?mode=     attribution and performance of ONE mode
//   POST /api/v1/mm/agents/:id/command               { command: pull | flatten | resume } — pull and flatten work under every lock and halt
//   POST /api/v1/mm/agents/:id/golive/ack            { step: evidence | jurisdiction | testnet, locale, note? }
//   POST /api/v1/mm/recover                          a lost approval answer, signer-side orphans (mandates/service.ts recoverQuoting)
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { QUOTING_MANDATE_BOUNDS, jurisdictionAck } from '@spw/derivatives/live';
import { QUOTING_SECTION_BOUNDS } from '@spw/trading';
import { BREAKER_CODES, DEFAULT_BREAKER_ACTION } from '@spw/trading/mm';
import { UserError } from '../config.ts';
import { audit } from '../db.ts';
import { acquireLease, releaseLease } from '../agent-runtime/leases.ts';
import { loadAgent } from '../agent-runtime/store.ts';
import type { Execution } from '../orders/index.ts';
import { envMmLocks, mmNetworkSelection } from './live-adapter.ts';
import { acknowledge, evidenceSha256, goLiveChecklist, minPaperMinutes, MM_EVIDENCE } from './lifecycle.ts';
import type { MmAgentRow, MmRuntime } from './runtime.ts';
import { listFills, listSessions, mmPerformance, postCommand, runningSession, type MmMode } from './sessions.ts';

const P = '/api/v1/mm';
const Id = z.object({ id: z.uuid() });
const Mode = z.object({ mode: z.enum(['paper', 'live']).default('paper') });
const ownerOnly = (req: FastifyRequest): void => { if (req.principal?.kind !== 'owner') throw new UserError('owner_only', 'this route is for the owner\'s session', 403); };
const dbMode = (m: 'paper' | 'live'): MmMode => (m === 'live' ? 'LIVE' : 'PAPER');
/** a session whose worker has not written for this long is taken for dead (the lease then tells) */
export const SESSION_STALE_MS = 20_000;

export interface MmRouteDeps { execution: Execution; now: () => number;
  /** the quoting sessions of THIS process, when its agent workers run here; null = another process runs them */
  local: () => MmRuntime | null;
  /** a runtime able to act for the owner when no worker runs the agent's session (pull / flatten) */
  emergency: () => MmRuntime | null }

export function mmRoutes(app: FastifyInstance, d: MmRouteDeps): void {
  app.addHook('preHandler', async (req) => { const p = req.url.split('?')[0]!; if (p === P || p.startsWith(`${P}/`)) ownerOnly(req); });
  const agentOf = async (id: string) => { const a = await loadAgent(id); if ((a.family ?? '') !== 'market_making') throw new UserError('not_market_making_agent', 'this agent is not a market-making agent', 409); return a; };

  app.get(`${P}/evidence`, async (req) => {
    const locale = z.object({ locale: z.enum(['fr', 'en']).default('en') }).parse(req.query).locale, ack = jurisdictionAck('hyperliquid', locale);
    return { evidence: MM_EVIDENCE, statement: MM_EVIDENCE.statement[locale], sha256: evidenceSha256(locale), jurisdiction: { text: ack.text, sha256: ack.sha256, version: ack.version, source: ack.source }, minPaperMinutes: minPaperMinutes() };
  });
  app.get(`${P}/bounds`, async () => ({ signer: QUOTING_MANDATE_BOUNDS, section: QUOTING_SECTION_BOUNDS, breakers: BREAKER_CODES.map((code) => ({ code, default: DEFAULT_BREAKER_ACTION[code], alwaysStops: ['consecutive_rejects', 'drawdown_session', 'drawdown_day'].includes(code) })),
    locks: { mainnet: mmNetworkSelection('mainnet', envMmLocks(process.env)), testnet: mmNetworkSelection('testnet', envMmLocks(process.env)) } }));

  app.get(`${P}/agents/:id`, async (req) => {
    const a = await agentOf(Id.parse(req.params).id), mode = Mode.parse(req.query).mode, now = d.now();
    const run = await runningSession(a.id), sessions = await listSessions(a.id, dbMode(mode), 20), q = await d.execution.mandates.quotingFor(a.id);
    const view = (s: NonNullable<typeof run>) => ({ id: s.id, mode: s.mode === 'LIVE' ? 'live' : 'paper', instrument: s.instrument, network: s.network, state: s.state, policy: s.policy, startedAt: s.started_at.getTime(), endedAt: s.ended_at?.getTime() ?? null, endReason: s.end_reason,
      heartbeatAt: s.heartbeat_at.getTime(), stale: s.state === 'running' && now - s.heartbeat_at.getTime() > SESSION_STALE_MS, counters: s.counters, pnl: s.pnl, markouts: s.markouts, refusals: s.refusals, budget: s.budget, breakers: s.breakers, status: s.status, mandateId: s.mandate_id,
      simulated: s.mode === 'PAPER', label: s.mode === 'PAPER' ? 'PAPER — SIMULATED fills on real books' : `LIVE — ${s.network}` });
    return { agentId: a.id, state: a.state, mode: a.mode, family: a.family, universe: a.universe, venues: (a.runtime as { venues?: string[] } | null)?.venues ?? [], config: (a.runtime as { config?: unknown } | null)?.config ?? {}, configVersion: a.config_version,
      session: run && (run.mode === dbMode(mode)) ? view(run) : null, sessions: sessions.map(view),
      mandate: q ? { id: q.row.id, state: q.row.state, phase: q.phase, integrity: q.integrity, hash: q.row.hash, quoting: q.row.quoting, expiresAt: q.row.mandate.notAfter * 1000, signer: q.row.signer } : null,
      goLive: await goLiveChecklist(a, d.execution.mandates, { now }), ts: now };
  });
  app.get(`${P}/agents/:id/fills`, async (req) => {
    const a = await agentOf(Id.parse(req.params).id), q = z.object({ mode: z.enum(['paper', 'live']).default('paper'), limit: z.coerce.number().int().min(1).max(500).default(100), session: z.uuid().optional() }).parse(req.query);
    return { mode: q.mode, simulated: q.mode === 'paper', fills: await listFills(a.id, dbMode(q.mode), { limit: q.limit, ...(q.session ? { sessionId: q.session } : {}) }) };
  });
  app.get(`${P}/agents/:id/performance`, async (req) => { const a = await agentOf(Id.parse(req.params).id); return mmPerformance(a.id, dbMode(Mode.parse(req.query).mode)); });

  app.post(`${P}/agents/:id/command`, async (req) => {
    const a = await agentOf(Id.parse(req.params).id), b = z.strictObject({ command: z.enum(['pull', 'flatten', 'resume']) }).parse(req.body), now = d.now();
    await audit('mm.command', 'owner', { agent: a.id, command: b.command }).catch(() => {});
    // 1. the session runs in this process: the instruction is given to its engine at once
    if (d.local()?.instruct(a.id, b.command, 'owner')) return { taken: 'engine', command: b.command };
    // 2. it runs in another process whose worker is alive: the instruction waits in the session row (taken within a couple of seconds)
    const run = await runningSession(a.id);
    if (run && now - run.heartbeat_at.getTime() <= SESSION_STALE_MS) { const p = await postCommand(a.id, b.command, 'owner', now); if (p) return { taken: 'queued', command: b.command, sessionId: p.sessionId }; }
    if (b.command === 'resume') throw new UserError('no_session', 'no quoting session is running for this agent: there is nothing to resume', 409);
    // 3. no worker runs it (it died, or the agent is stopped): this process acts itself, under the agent's lease — live only (a paper book holds nothing real)
    if (a.mode !== 'LIVE' && !(run && run.mode === 'LIVE')) return { taken: 'nothing', command: b.command, note: 'no live session and nothing on a venue for this agent' };
    const rt = d.emergency();
    if (!rt) throw new UserError('mm_unavailable', 'this process cannot reach the venue for this agent; use the kill switch, or revoke the mandate (the dead man\'s switch cancels what rests)', 503);
    const lease = await acquireLease(a.id, `owner-command:${process.pid}`, { ttlMs: 90_000 });
    if (!lease) throw new UserError('session_busy', 'a worker holds this agent but its session does not answer: try again in a few seconds, or use the kill switch', 409);
    try { return { taken: 'direct', command: b.command, result: await rt.emergency(a as unknown as MmAgentRow, b.command, 'owner') }; }
    catch (e) { throw new UserError('command_failed', `the ${b.command} could not be completed: ${(e as Error).message.slice(0, 200)}`, 502); }
    finally { await releaseLease(lease).catch(() => {}); }
  });
  app.post(`${P}/agents/:id/golive/ack`, async (req) => {
    const a = await agentOf(Id.parse(req.params).id), b = z.strictObject({ step: z.enum(['evidence', 'jurisdiction', 'testnet']), locale: z.enum(['fr', 'en']).default('en'), acknowledged: z.literal(true), note: z.string().max(500).optional() }).parse(req.body);
    const acks = await acknowledge(a.id, b.step, { locale: b.locale, ...(b.note ? { note: b.note } : {}) }, d.now());
    await audit('mm.golive_ack', 'owner', { agent: a.id, step: b.step, sha256: b.step === 'testnet' ? null : acks[b.step]?.sha256 ?? null }).catch(() => {});
    return { goLive: await goLiveChecklist(await loadAgent(a.id), d.execution.mandates, { now: d.now() }) };
  });
  app.post(`${P}/recover`, async () => d.execution.mandates.recoverQuoting());
}
