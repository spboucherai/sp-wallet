// GET /api/v1/dashboard/status — what the shell shows on EVERY screen (the risk indicator of the header): the two global
// switches of the risk engine and whether the owner's live limits are complete. Two settings reads of the risk service;
// no venue is read, no exposure is computed (that is /api/v1/risk/state, asked by the Risk screen only).
// Each of the two sources fails on its own, like the other /dashboard routes.
import type { FastifyInstance } from 'fastify';
import { UserError } from '../config.ts';
import type { DashboardOpts } from './index.ts';
import { section } from './summary.ts';

export function registerDashboardStatus(app: FastifyInstance, { execution }: DashboardOpts): void {
  app.get('/api/v1/dashboard/status', async (req) => {
    if (req.principal?.kind !== 'owner') throw new UserError('owner_only', 'this route is for the owner\'s session', 403);
    const { risk } = execution;
    const [switches, limits] = await Promise.all([
      section(async () => { const s = await risk.switches(); return { killSwitch: { on: s.killSwitch.on, at: s.killSwitch.at }, readOnly: { on: s.readOnly.on, at: s.readOnly.at } }; }),
      section(async () => { const l = await risk.limits('live'); return { missing: l.missing.length, ownerOrdersRefused: l.ownerOrdersRefused ?? false, automationOrdersRefused: l.automationOrdersRefused ?? false }; }),
    ]);
    return { ts: Date.now(), switches, liveLimits: limits };
  });
}
