// NEXT — the routes the wallet contract added (analytics, universal search). The contract itself is spec.ts; the routes it
// describes live where they always did (server.ts, transfers.ts, prefs.ts, events.ts, alerts/, dashboard/).
import type { FastifyInstance } from 'fastify';
import type { Currency } from '../portfolio.ts';
import { analyticsRoutes } from './analytics.ts';
import { searchRoutes } from './search.ts';

export function walletApiRoutes(app: FastifyInstance, deps: { currency: () => Promise<Currency> }): void {
  analyticsRoutes(app, deps);
  searchRoutes(app);
}
export { contactLabeler, csvCell, NO_CONTROL } from './labels.ts';
export { validationFields } from './validation.ts';
