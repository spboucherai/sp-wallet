import dns from 'node:dns';
import net from 'node:net';
import { config } from './config.ts';
import { migrate } from './db.ts';
import { buildServer } from './server.ts';
import { startAgentEngine } from './agents/live.ts';
import { startPerpAgentEngine } from './agents/perp-live.ts'; // v6 perp agents
import { assertFresh, getSeries, type Interval, type MarketSymbol } from './market/index.ts';
import { startMarketWorker } from './market/worker.ts';
import { startWorkers } from './worker.ts';
import { startDerivativesWorker } from './derivatives/worker.ts';
import { startLiveWorker } from './derivatives/live.ts';

// Node's default happy-eyeballs gives each address only 250 ms: on this network that makes public RPC connections fail at random.
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamilyAttemptTimeout(2500);

await migrate();
const app = await buildServer();
await app.listen({ port: config.port, host: config.host });
if (config.workers) {
  startWorkers(); startMarketWorker();
  startDerivativesWorker(); // paper accounts only: public market data in, simulated fills out; no signer, no venue trading endpoint
  startLiveWorker(); // venue accounts: reconciliation only (reads); with no authorized account it does nothing
  // trading agents: decisions only on bars the market engine declares fresh, complete and consistent across sources
  startAgentEngine({
    series: async (s, i, limit) => (await getSeries(s as MarketSymbol, i as Interval, { limit })).bars,
    assertFresh: async (s, i) => { await assertFresh(s as MarketSymbol, i as Interval); },
  });
  startPerpAgentEngine(); // v6 perp agents (paper only): venue bars + funding in, simulated orders on their paper accounts out
}
console.log(`sp-wallet api listening on ${config.host}:${config.port} origin=${config.origin} broadcast=${config.broadcast ? 'on' : 'OFF'}`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void app.close().then(() => process.exit(0)); });
