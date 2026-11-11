// Routes of controlled live trading — all under /api/v1/derivatives/live. Authentication and CSRF are the global hook of
// server.ts. Decimals are strings. Exact shapes: docs/v4/API-LIVE-NOTES.md. Nothing here holds a key or judges a passkey:
// assertions are passed to the isolated signer untouched.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RiskPolicySchema } from '@spw/derivatives';
import { jurisdictionAck } from '@spw/derivatives/live';
import { UserError } from '../config.ts';
import { venueFailure } from './data.ts';
import { ApproveAuthorizationSchema, ApproveMandateSchema, AssertionBodySchema, AuthorizationBodySchema, CreateLiveAccountSchema, HaltBodySchema, LeverageBodySchema, MandateBodySchema, RevokeBodySchema, type LiveService } from './exec.ts';
import { liveLocale } from './live-texts.ts';
import { live } from './live.ts';
import { CloseBodySchema, OrderBodySchema } from './paper.ts';

const P = '/api/v1/derivatives/live';
export const MAX_LIVE_STREAMS = 8;
const IDEMPOTENCY = /^[A-Za-z0-9._:-]{8,100}$/;

export function liveRoutes(app: FastifyInstance, svc: LiveService = live()): void {
  let streams = 0;
  app.addHook('onClose', async () => { svc.deps.venues.close(); });
  const id = (req: FastifyRequest): string => z.uuid().parse((req.params as { id: string }).id);
  const clientId = (req: FastifyRequest): string => z.string().regex(IDEMPOTENCY).parse((req.params as { clientId: string }).clientId);
  const idempotencyKey = (req: FastifyRequest, required: boolean): string | undefined => {
    const k = req.headers['idempotency-key'];
    if (k === undefined && !required) return undefined;
    if (typeof k !== 'string' || !IDEMPOTENCY.test(k)) throw new UserError('idempotency', 'an Idempotency-Key header (8 to 100 characters: letters, digits, . _ : -) is required', 400);
    return k;
  };
  /** a venue that cannot be read is a 503, a request it refuses a 422 — never a 500 */
  const run = <T>(fn: (req: FastifyRequest, reply: FastifyReply) => Promise<T>) => async (req: FastifyRequest, reply: FastifyReply): Promise<T> => { try { return await fn(req, reply); } catch (e) { throw venueFailure(e); } };

  /** `?locale=fr|en` selects the language of the server-authored sentences (default en); codes never change */
  const locale = (req: FastifyRequest) => liveLocale((req.query as { locale?: unknown } | undefined)?.locale);
  app.get(`${P}/config`, run(async (req) => svc.config(locale(req))));
  app.get(`${P}/jurisdiction`, run(async (req) => {
    const q = z.object({ venue: z.literal('hyperliquid').default('hyperliquid') }).parse(req.query);
    return { venue: q.venue, fr: jurisdictionAck(q.venue, 'fr'), en: jurisdictionAck(q.venue, 'en') };
  }));
  app.post(`${P}/venue-key`, run(async (req) => { const b = z.strictObject({ venue: z.string().max(40), network: z.string().max(20) }).parse(req.body); return svc.venueKey(b.venue, b.network); }));

  app.get(`${P}/accounts`, run(async () => ({ accounts: await svc.list(), ts: svc.now() })));
  app.post(`${P}/accounts`, run(async (req) => svc.createAccount(CreateLiveAccountSchema.parse(req.body))));
  app.get(`${P}/accounts/:id`, run(async (req) => svc.get(id(req))));
  app.get(`${P}/accounts/:id/collateral`, run(async (req) => svc.collateral(id(req), locale(req))));

  // enabling: prepare (authorization + acknowledgement text + WebAuthn request) → approve (assertion) ; disabling: revoke (no passkey)
  app.post(`${P}/accounts/:id/authorization/prepare`, run(async (req) => svc.prepareAuthorization(id(req), AuthorizationBodySchema.parse(req.body))));
  app.post(`${P}/accounts/:id/authorization/approve`, run(async (req) => svc.approveAuthorization(id(req), ApproveAuthorizationSchema.parse(req.body))));
  app.post(`${P}/accounts/:id/authorization/revoke`, run(async (req) => svc.revoke(id(req), RevokeBodySchema.parse(req.body ?? {}))));
  app.post(`${P}/accounts/:id/policy`, run(async (req) => svc.setPolicy(id(req), RiskPolicySchema.strict().parse(req.body))));

  // MANDATE_LIVE: prepare (canonical mandate + acknowledgement text + WebAuthn request) → approve (assertion) ; revoke (no passkey).
  // There is NO route that places a mandate order: only the server-side agent runtime can (derivatives/mandate.ts).
  app.get(`${P}/accounts/:id/mandate`, run(async (req) => svc.mandateStatus(id(req))));
  app.post(`${P}/accounts/:id/mandate/prepare`, run(async (req) => svc.prepareMandate(id(req), MandateBodySchema.parse(req.body))));
  app.post(`${P}/accounts/:id/mandate/approve`, run(async (req) => svc.approveMandate(id(req), ApproveMandateSchema.parse(req.body))));
  app.post(`${P}/accounts/:id/mandate/revoke`, run(async (req) => svc.revokeMandate(id(req), RevokeBodySchema.parse(req.body ?? {}))));

  // orders: preview (nothing stored) → propose (stored, WebAuthn request over the order hash) → approve (assertion) ; cancel (no passkey)
  app.post(`${P}/accounts/:id/orders/preview`, run(async (req) => svc.preview(id(req), OrderBodySchema.parse(req.body))));
  app.post(`${P}/accounts/:id/orders`, run(async (req) => svc.propose(id(req), OrderBodySchema.parse(req.body), idempotencyKey(req, true)!)));
  app.post(`${P}/accounts/:id/orders/:clientId/approve`, run(async (req) => svc.approveOrder(id(req), clientId(req), AssertionBodySchema.parse(req.body).assertion)));
  app.post(`${P}/accounts/:id/orders/:clientId/cancel`, run(async (req) => svc.cancelOrder(id(req), clientId(req))));

  app.post(`${P}/accounts/:id/leverage`, run(async (req) => svc.proposeLeverage(id(req), LeverageBodySchema.parse(req.body))));
  app.post(`${P}/accounts/:id/leverage/:actionId/approve`, run(async (req) =>
    svc.approveLeverage(id(req), z.uuid().parse((req.params as { actionId: string }).actionId), AssertionBodySchema.parse(req.body).assertion)));

  // kill switch: three separate, explicit actions
  app.post(`${P}/accounts/:id/halt`, run(async (req) => svc.halt(id(req), HaltBodySchema.parse(req.body ?? {}))));
  app.post(`${P}/accounts/:id/resume`, run(async (req) => svc.resume(id(req))));
  app.post(`${P}/accounts/:id/cancel-all`, run(async (req) => svc.cancelAll(id(req))));
  app.post(`${P}/accounts/:id/close`, run(async (req) => svc.close(id(req), CloseBodySchema.parse(req.body), idempotencyKey(req, false))));
  app.post(`${P}/accounts/:id/rebase`, run(async (req) => svc.rebase(id(req))));
  /** one reconciliation pass now (the worker runs one every few seconds) */
  app.post(`${P}/accounts/:id/reconcile`, run(async (req) => { const r = await svc.reconcile(id(req)); return { ...r, account: await svc.get(id(req)) }; }));

  // Server-Sent Events: `status` and `account` first, then `account` (venue state after each reconciliation), `order`, `action`, `risk`, `status`
  app.get(`${P}/accounts/:id/stream`, run(async (req, reply) => {
    const account = id(req);
    const first = await svc.get(account);
    if (streams >= MAX_LIVE_STREAMS) throw new UserError('too_many_streams', `at most ${MAX_LIVE_STREAMS} live account streams at once`, 429);
    streams += 1;
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const write = (chunk: string): void => { if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(chunk); };
    // `halt` is the OWNER's halt (as in every later `status` and `account` event); `halted` is the effective reason new orders are refused
    write(`event: status\ndata: ${JSON.stringify({ mode: first.mode, modes: first.modes, halt: first.halt, halted: first.halted, divergence: first.divergence, ts: svc.now() })}\n\n`);
    write(`event: account\ndata: ${JSON.stringify({ ...first.venueState, divergence: first.divergence, halt: first.halt, mode: first.mode })}\n\n`);
    const off = svc.subscribe(account, (ev) => write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`));
    const beat = setInterval(() => write(': keep-alive\n\n'), 15_000);
    beat.unref();
    let done = false;
    const end = (): void => { if (done) return; done = true; streams -= 1; clearInterval(beat); off(); if (!reply.raw.writableEnded) reply.raw.end(); };
    req.raw.on('close', end); reply.raw.on('close', end); reply.raw.on('error', end);
  }));
}
