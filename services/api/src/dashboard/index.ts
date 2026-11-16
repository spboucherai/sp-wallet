// V11 interface — /api/v1/dashboard: small READ-ONLY aggregates for the Dashboard and Activity screens. Nothing here holds
// business logic: every figure is read from an existing service (portfolio, risk service, unified orders, agents, monitor,
// audit chain) and each source fails on its own — a source that cannot be read is answered as
// `{ ok: false, error: { code, message } }` and the others are still answered.
// Owner session only: the prefix is outside /api/v1/trading, so the gate of server.ts refuses an API key (`key_path_forbidden`).
import type { FastifyInstance } from 'fastify';
import type { Execution } from '../orders/index.ts';
import { registerDashboardActivity } from './activity.ts';
import { registerDashboardStatus } from './status.ts';
import { registerDashboardSummary } from './summary.ts';

export interface DashboardOpts { execution: Execution }
export const DASHBOARD_PREFIX = '/api/v1/dashboard';
export function dashboardRoutes(app: FastifyInstance, opts: DashboardOpts): void {
  registerDashboardStatus(app, opts);
  registerDashboardSummary(app, opts);
  registerDashboardActivity(app, opts);
}
