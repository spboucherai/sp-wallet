// sp-wallet-agents — the agent workers as their OWN process (optional).
//
//   SPW_WORKERS=agents node dist/agents.mjs        this process: the agent runtime only (bar engines, stream engine, supervisor,
//                                                  job queue). No HTTP server, no other worker.
//   SPW_WORKERS=api    node dist/api.mjs           the API process next to it: HTTP + every other worker, NOT the agent runtime.
//   SPW_WORKERS=on     node dist/api.mjs           the default, unchanged: everything in the API process; this file is not used.
//
// Same code, same database, same signer client and the same bindings as main.ts (`bindAgentRuntime`). Running both an API with
// SPW_WORKERS=on and this process is SAFE (per-agent leases, claimed jobs) but pointless. This process does not migrate the
// schema: the API does, and must have started once on this version.
import dns from 'node:dns';
import net from 'node:net';
import { bindAgentRuntime } from './agents/runtime-bindings.ts';
import { createExecution, installGates } from './orders/index.ts';
import { onTransition } from './orders/store.ts';
import { labStatus } from './agents/lab.ts';
import { sql } from './db.ts';
import { assertFresh, getSeries, type Interval, type MarketSymbol } from './market/index.ts';
import { applyRpcExtra } from './rpc-extra.ts';
import { emitWebhook } from './trading-api/webhooks.ts';

dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamilyAttemptTimeout(2500);

if (process.env.SPW_WORKERS !== 'agents') { console.error('sp-wallet-agents: start this process with SPW_WORKERS=agents (and the API with SPW_WORKERS=api); nothing was started'); process.exit(2); }
applyRpcExtra();
const [ready] = await sql<{ ok: boolean }[]>`select to_regclass('agent_jobs') is not null and to_regclass('agent_leases') is not null as ok`;
if (!ready?.ok) { console.error('sp-wallet-agents: the database has no agent runtime tables yet — start the API on this version once (it migrates), then this process'); await sql.end(); process.exit(3); }

// The execution layer of THIS process — the same services as the API's (`registerExecution`), without the HTTP routes and
// without the supervisor loop (the API process reconciles UNKNOWN orders and supervises the mandates): the order service, the
// risk engine in front of every engine path (`installGates`: paper and venue engines, the spot signer guard), the trading
// mandates, and `order.updated` for every transition this process makes.
const execution = createExecution();
installGates(execution, {});
onTransition(async (row, e) => { await emitWebhook('order.updated', { orderId: row.id, mode: row.mode, venue: row.venue, instrument: row.instrument, status: e.to, previous: e.from, event: e.event, reason: e.reason, seq: e.seq,
  principal: `${row.principal_kind}:${row.principal_id}`, mandateId: row.mandate_id }); });
const agents = bindAgentRuntime({
  execution,
  market: { series: async (s, i, limit) => (await getSeries(s as MarketSymbol, i as Interval, { limit })).bars, assertFresh: async (s, i) => { await assertFresh(s as MarketSymbol, i as Interval); } },
  // the delivery worker of the webhooks runs in the API process; this one only queues the events
  emit: (event, data) => emitWebhook(event, data),
});
// operator settings (all optional, milliseconds): the cadence of the bar engines, of the job queue and of the supervisor
const ms = (name: string): number | undefined => { const n = Number(process.env[name]); return Number.isFinite(n) && n >= 100 ? Math.floor(n) : undefined; };
const bar = ms('SPW_AGENT_BAR_MS'), jobs = ms('SPW_AGENT_JOBS_MS'), sup = ms('SPW_AGENT_SUPERVISOR_MS');
const stop = agents.start({ ...(bar ? { barMs: bar } : {}), ...(jobs ? { jobsMs: jobs } : {}), ...(sup ? { supervisorMs: sup } : {}) });
console.log(`sp-wallet agents worker ${agents.worker} started (bar engines, stream engine, supervisor, job queue)`);
void labStatus().then((l) => console.log(`[startup] strategy sandbox: ${l.mode}${l.ok ? ' (confined, self-test passed)' : ` — ${l.reason}${l.mode === 'unavailable' ? ' — signals and backtests will NOT run' : ''}`}`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { stop(); void sql.end({ timeout: 5 }).then(() => process.exit(0)); });
