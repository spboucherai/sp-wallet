// Routes of GMX v2 trading (v8) — all under /api/v1/derivatives/gmx. Authentication and CSRF are the global hook of server.ts.
// Nothing here holds a key or judges a passkey: assertions go to the isolated signer untouched. Shapes: docs/v4/API-LIVE-NOTES.md.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { jurisdictionAck } from '@spw/derivatives/live';
import { UserError } from '../config.ts';
import { venueFailure } from './data.ts';
import { GmxApproveAuthSchema, GmxAssertionSchema, GmxAuthBodySchema, GmxCloseBodySchema, GmxHaltBodySchema, GmxLimitsBodySchema, GmxOrderBodySchema, type GmxService } from './gmx-exec.ts';
import { gmx } from './gmx-live.ts';

const P = '/api/v1/derivatives/gmx';
const IDEMPOTENCY = /^[A-Za-z0-9._:-]{8,100}$/;

export function gmxRoutes(app: FastifyInstance, given?: GmxService): void {
  const svc = (): GmxService => given ?? gmx();
  const op = (req: FastifyRequest): string => z.uuid().parse((req.params as { opId: string }).opId);
  const locale = (req: FastifyRequest): 'fr' | 'en' => ((req.query as { locale?: unknown } | undefined)?.locale === 'fr' ? 'fr' : 'en');
  const idem = (req: FastifyRequest): string => { const k = req.headers['idempotency-key']; if (typeof k !== 'string' || !IDEMPOTENCY.test(k)) throw new UserError('idempotency', 'an Idempotency-Key header (8 to 100 characters: letters, digits, . _ : -) is required', 400); return k; };
  /** a chain or a venue that cannot be read is a 503, a request that is refused a 4xx — never a 500 */
  const run = <T>(fn: (s: GmxService, req: FastifyRequest, reply: FastifyReply) => Promise<T>) => async (req: FastifyRequest, reply: FastifyReply): Promise<T> => { try { return await fn(svc(), req, reply); } catch (e) { throw venueFailure(e); } };

  // the account is the wallet's own address: settings, pins, balances, authorization, positions and pending orders read on-chain, the engine's operations
  app.get(`${P}/status`, run(async (s, req) => s.status(locale(req))));
  app.get(`${P}/jurisdiction`, run(async () => ({ venue: 'gmx' as const, fr: jurisdictionAck('gmx', 'fr'), en: jurisdictionAck('gmx', 'en') })));
  // enabling: prepare (venue policy + acknowledgement text + WebAuthn request) → approve (assertion); disabling: revoke (no passkey)
  app.post(`${P}/authorization/prepare`, run(async (s, req) => s.prepareAuthorization(GmxAuthBodySchema.parse(req.body))));
  app.post(`${P}/authorization/approve`, run(async (s, req) => s.approveAuthorization(GmxApproveAuthSchema.parse(req.body), locale(req))));
  app.post(`${P}/authorization/revoke`, run(async (s, req) => s.revoke(locale(req))));
  // orders: preview (nothing stored) → prepare (stored proposal, WebAuthn request over the intent hash) → approve (assertion)
  app.post(`${P}/orders/preview`, run(async (s, req) => s.preview(GmxOrderBodySchema.parse(req.body))));
  app.post(`${P}/orders`, run(async (s, req) => s.prepareOrder(GmxOrderBodySchema.parse(req.body), idem(req))));
  app.post(`${P}/positions/close`, run(async (s, req) => s.prepareClose(GmxCloseBodySchema.parse(req.body), idem(req))));
  app.post(`${P}/orders/:opId/cancel`, run(async (s, req) => s.prepareCancel(op(req))));
  app.post(`${P}/operations/:opId/approve`, run(async (s, req) => s.approve(op(req), GmxAssertionSchema.parse(req.body).assertion)));
  app.post(`${P}/operations/:opId/withdraw`, run(async (s, req) => s.withdraw(op(req))));
  // V11: kill switch and loss limits (new risk only). Halting and tightening are free; lifting the halt and raising a limit need the passkey (prepare → approve)
  app.post(`${P}/halt`, run(async (s, req) => s.halt(GmxHaltBodySchema.parse(req.body ?? {}), locale(req))));
  app.post(`${P}/resume/prepare`, run(async (s) => s.prepareRisk('gmx-resume')));
  app.post(`${P}/resume`, run(async (s, req) => s.approveRisk('gmx-resume', z.strictObject({ assertion: z.record(z.string(), z.unknown()).optional() }).parse(req.body ?? {}).assertion, locale(req))));
  app.post(`${P}/limits`, run(async (s, req) => s.setLimits(GmxLimitsBodySchema.parse(req.body), locale(req))));
  app.post(`${P}/limits/prepare`, run(async (s, req) => s.prepareRisk('gmx-limits', GmxLimitsBodySchema.parse(req.body))));
  app.post(`${P}/limits/approve`, run(async (s, req) => s.approveRisk('gmx-limits', GmxAssertionSchema.parse(req.body).assertion, locale(req))));
  app.get(`${P}/operations/:opId`, run(async (s, req) => s.operation(op(req))));
}
