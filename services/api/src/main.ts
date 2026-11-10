import dns from 'node:dns';
import net from 'node:net';
import { config } from './config.ts';
import { migrate } from './db.ts';
import { buildServer } from './server.ts';
import { startWorkers } from './worker.ts';

// Node's default happy-eyeballs gives each address only 250 ms: on this network that makes public RPC connections fail at random.
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamilyAttemptTimeout(2500);

await migrate();
const app = await buildServer();
await app.listen({ port: config.port, host: config.host });
if (config.workers) startWorkers();
console.log(`sp-wallet api listening on ${config.host}:${config.port} origin=${config.origin} broadcast=${config.broadcast ? 'on' : 'OFF'}`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void app.close().then(() => process.exit(0)); });
