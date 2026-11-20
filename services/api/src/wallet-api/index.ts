// NEXT — the routes the wallet contract added (analytics, universal search). The contract itself is spec.ts; the routes it
// describes live where they always did (server.ts, transfers.ts, prefs.ts, events.ts, alerts/, dashboard/).
import type { FastifyInstance } from 'fastify';
import type { Currency } from '../portfolio.ts';
import { analyticsRoutes } from './analytics.ts';
import { buildWalletOpenApi } from './openapi.ts';
import { searchRoutes } from './search.ts';

export function walletApiRoutes(app: FastifyInstance, deps: { currency: () => Promise<Currency> }): void {
  // the contract itself, as built into this server (the bytes of docs/openapi/wallet-v1.json): owner session, like every route
  let doc: ReturnType<typeof buildWalletOpenApi> | null = null;
  app.get('/api/v1/openapi.json', async () => (doc ??= buildWalletOpenApi()));
  analyticsRoutes(app, deps);
  searchRoutes(app);
}
export { contactLabeler, csvCell, NO_CONTROL } from './labels.ts';
export { controlIssue, validationFields } from './validation.ts';
