// One call from server.ts: the owner's market-making routes on the execution layer of this server instance.
import type { FastifyInstance } from 'fastify';
import { agentRuntime } from '../agents/runtime-bindings.ts';
import type { Execution } from '../orders/index.ts';
import { standaloneMm } from './bind.ts';
import { mmRoutes } from './routes.ts';
import type { MmRuntime } from './runtime.ts';

export function registerMm(app: FastifyInstance, ex: Execution): void {
  let own: MmRuntime | null = null;
  app.addHook('onClose', async () => { own?.close(); });
  mmRoutes(app, { execution: ex, now: () => ex.risk.now(), local: () => agentRuntime()?.stream?.mm ?? null, emergency: () => (own ??= standaloneMm(ex)) });
}
