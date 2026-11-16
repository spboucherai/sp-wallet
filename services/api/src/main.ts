import dns from 'node:dns';
import net from 'node:net';
import { config } from './config.ts';
import { migrate } from './db.ts';
import { buildServer } from './server.ts';
import { bindAgentRuntime } from './agents/runtime-bindings.ts'; // v11: agent workers (leases, job queue, stream engine, supervisor)
import { emitWebhook } from './trading-api/webhooks.ts';
import { assertFresh, getSeries, type Interval, type MarketSymbol } from './market/index.ts';
import { startMarketWorker } from './market/worker.ts';
import { startWorkers } from './worker.ts';
import { startDerivativesWorker } from './derivatives/worker.ts';
import { startLiveWorker } from './derivatives/live.ts';
import { startCollateralWorker } from './derivatives/collateral.ts';
import { startGmxWorker } from './derivatives/gmx-live.ts'; // v8
import { startAlerts } from './alerts/dispatcher.ts'; // v6-alerts
import { capabilitiesLine } from './capabilities.ts'; // v8
import { labStatus } from './agents/lab.ts'; // v8
import { applyRpcExtra } from './rpc-extra.ts'; // v11

// Node's default happy-eyeballs gives each address only 250 ms: on this network that makes public RPC connections fail at random.
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamilyAttemptTimeout(2500);

// v11: operator-supplied additional RPC endpoints (rpc-extra.ts) — a third endpoint lets a network survive one degraded source
const rpcExtra = applyRpcExtra();
if (Object.keys(rpcExtra).length) console.log(`[startup] SPW_RPC_EXTRA: ${Object.entries(rpcExtra).map(([n, u]) => `${n}+${u.length}`).join(' ')}`);
await migrate();
const app = await buildServer();
await app.listen({ port: config.port, host: config.host });
if (config.workers) {
  startWorkers(); startMarketWorker();
  startDerivativesWorker(); // paper accounts only: public market data in, simulated fills out; no signer, no venue trading endpoint
  startLiveWorker(); // venue accounts: reconciliation only (reads); with no authorized account it does nothing
  startCollateralWorker(); // deposits and withdrawals in flight: venue ledger + the wallet's own chain records (reads; re-sends only already signed withdrawals)
  startGmxWorker(); // v8 GMX: tracks the wallet's own orders on-chain until executed, cancelled or frozen (reads; relays only already signed transactions)
  await startAlerts(); // v6-alerts: ONE dispatcher tailing the audit chain, risk events and research log; read-only on those tables
}
// v11 trading agents. The order gateway and the kill switch are BOUND here (dependency injection): `bindAgentRuntime` binds the
// adapter over the existing engine seams and the local kill switch; the execution workstream passes its own `gateway` /
// `killSwitch` in this call and nothing else changes. The workers run in this process when SPW_WORKERS=on (default, as before),
// or in the separate `sp-wallet-agents` process (agent-worker-main.ts, SPW_WORKERS=agents) when this one runs with SPW_WORKERS=api.
const agents = bindAgentRuntime({
  // decisions only on bars the market engine declares fresh, complete and consistent across sources
  market: { series: async (s, i, limit) => (await getSeries(s as MarketSymbol, i as Interval, { limit })).bars, assertFresh: async (s, i) => { await assertFresh(s as MarketSymbol, i as Interval); } },
  emit: (event, data) => emitWebhook(event, data),
});
if (config.agentWorkers) agents.start(); // spot + perp bar engines (paper and live), the stream engine (research and paper), the risk supervisor, the job queue
console.log(`sp-wallet api listening on ${config.host}:${config.port} origin=${config.origin} broadcast=${config.broadcast ? 'on' : 'OFF'} workers=${process.env.SPW_WORKERS ?? 'on'} agent-workers=${config.agentWorkers ? `in-process (${agents.worker})` : 'not in this process'}`);
// v8: which optional capabilities are on, and which variable is missing for the others (names only, never a value)
console.log(`[startup] ${capabilitiesLine()}`);
void labStatus().then((l) => console.log(`[startup] strategy sandbox: ${l.mode}${l.ok ? ' (confined, self-test passed)' : ` — ${l.reason}${l.mode === 'unavailable' ? ' — signals and backtests will NOT run' : ''}`}`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void app.close().then(() => process.exit(0)); });
