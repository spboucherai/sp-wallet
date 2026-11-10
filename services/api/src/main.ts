import { config } from './config.ts';
import { migrate } from './db.ts';
import { buildServer } from './server.ts';
import { startWorkers } from './worker.ts';

await migrate();
const app = await buildServer();
await app.listen({ port: config.port, host: config.host });
if (config.workers) startWorkers();
console.log(`sp-wallet api listening on ${config.host}:${config.port} origin=${config.origin} broadcast=${config.broadcast ? 'on' : 'OFF'}`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void app.close().then(() => process.exit(0)); });
