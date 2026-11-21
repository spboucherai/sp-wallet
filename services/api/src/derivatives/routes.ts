/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/derivatives/routes.ts
 * Module           : derivatives
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-11
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// Routes of the derivatives module — the "API contract (wave 2)" table of docs/v4/DERIVATIVES-ARCHITECTURE.md, route for route.
// Authentication and CSRF are the global hook of server.ts. Decimals are strings. Read-only and paper only: the live
// trading routes are in live-routes.ts.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RiskPolicySchema, type VenueId } from '@spw/derivatives';
import { UserError } from '../config.ts';
import { CANDLE_INTERVALS, DATA_BOUNDS, FUNDING_MAX_HOURS } from './data.ts';
import { derivatives, type Derivatives } from './index.ts';
import { CloseBodySchema, CreateBodySchema, OrderBodySchema } from './paper.ts';
import { localizeCompare, localizeInstruments, localizeRoute, textLocale } from './market-texts.ts'; // v8 hardening: `locale` on the read routes

const P = '/api/v1/derivatives';
/** Server-Sent Events connections served at once (one owner, a few tabs) */
export const MAX_STREAMS = 24;
const InstrumentQuery = z.string().min(3).max(120);
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const IDEMPOTENCY = /^[A-Za-z0-9._:-]{8,100}$/;

export function derivativesRoutes(app: FastifyInstance, d: Derivatives = derivatives()): void {
  const { registry: reg, data, paper } = d;
  let streams = 0;
  app.addHook('onClose', async () => { data.close(); });

  const accountId = (req: { params: unknown }): string => z.uuid().parse((req.params as { id: string }).id);
  const idempotencyKey = (req: { headers: Record<string, unknown> }, required: boolean): string | undefined => {
    const k = req.headers['idempotency-key'];
    if (k === undefined && !required) return undefined;
    if (typeof k !== 'string' || !IDEMPOTENCY.test(k)) throw new UserError('idempotency', 'an Idempotency-Key header (8 to 100 characters: letters, digits, . _ : -) is required', 400);
    return k;
  };
  /** one venue, or all of them: a venue that cannot be read is listed in `errors`, the others are still answered */
  const perVenue = async <T>(venue: string | undefined, read: (id: VenueId) => Promise<{ value: T[]; ts: number }>): Promise<{ items: T[]; ts: number; errors: { venue: VenueId; message: string }[] }> => {
    if (venue !== undefined) { const r = await read(reg.get(venue).id); return { items: r.value, ts: r.ts, errors: [] }; }
    const ids = reg.list().map((v) => v.id), got = await Promise.allSettled(ids.map((id) => read(id)));
    const items: T[] = [], errors: { venue: VenueId; message: string }[] = [];
    let ts = data.now(), first: unknown = null;
    got.forEach((g, k) => {
      if (g.status === 'fulfilled') { items.push(...g.value.value); ts = Math.min(ts, g.value.ts); }
      else { first ??= g.reason; errors.push({ venue: ids[k]!, message: g.reason instanceof Error ? g.reason.message.slice(0, 200) : 'error' }); }
    });
    if (errors.length === ids.length && first) throw first;
    return { items, ts, errors };
  };

  // ------------------------------------------------------------------ venues and market data

  app.get(`${P}/venues`, async () => {
    // a venue that was never read has no health yet: its (cached) instrument list is read so that `status` means something
    await Promise.all(reg.list().map((v) => data.instruments(v.id).catch(() => null)));
    return {
      venues: reg.list().map((v) => {
        const h = reg.health(v.id);
        return { id: v.id, name: v.name, network: v.adapter.network, capabilities: v.adapter.capabilities, status: h.status, lastOkAt: h.lastOkAt, restriction: v.restriction,
          lastError: h.lastError, paper: v.restriction === null && v.facts.paperFees !== null && v.facts.hasOrderBook, orderBook: v.facts.hasOrderBook };
      }),
      bounds: DATA_BOUNDS, ts: data.now(),
    };
  });

  app.get(`${P}/instruments`, async (req) => {
    const q = z.object({ venue: z.string().max(40).optional(), locale: z.string().max(8).optional() }).parse(req.query);
    const r = await perVenue(q.venue, (id) => data.instruments(id));
    return localizeInstruments({ instruments: r.items, ts: r.ts, errors: r.errors }, textLocale(q.locale));   // v8: `?locale=fr|en` (default en = the adapters' own strings)
  });

  app.get(`${P}/tickers`, async (req) => {
    const q = z.object({ venue: z.string().max(40).optional() }).parse(req.query);
    const r = await perVenue(q.venue, (id) => data.tickers(id));
    return { tickers: r.items, ts: r.ts, source: 'venue' as const, errors: r.errors };
  });

  app.get(`${P}/market`, async (req) => data.market(z.object({ instrument: InstrumentQuery }).parse(req.query).instrument));

  app.get(`${P}/candles`, async (req) => {
    const q = z.object({ instrument: InstrumentQuery, interval: z.enum(CANDLE_INTERVALS).default('1h'), limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(req.query);
    const inst = await data.instrument(q.instrument), r = await data.candles(inst, q.interval, q.limit);
    return { instrument: inst.id, interval: q.interval, candles: r.value, ts: r.ts, source: 'venue' as const };
  });

  app.get(`${P}/funding`, async (req) => {
    const q = z.object({ instrument: InstrumentQuery, hours: z.coerce.number().int().min(1).max(FUNDING_MAX_HOURS).default(24) }).parse(req.query);
    const inst = await data.instrument(q.instrument), r = await data.funding(inst, q.hours);
    return { instrument: inst.id, history: r.value, intervalSec: inst.fundingIntervalSec, ts: r.ts, source: 'venue' as const };
  });

  // Server-Sent Events: `status`, `ticker`, `book`, `trades` (and `error`). One upstream per instrument, shared by every listener.
  app.get(`${P}/stream`, async (req, reply) => {
    const inst = await data.instrument(z.object({ instrument: InstrumentQuery }).parse(req.query).instrument);
    if (streams >= MAX_STREAMS) throw new UserError('too_many_streams', `at most ${MAX_STREAMS} live streams at once`, 429);
    streams += 1;
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const write = (chunk: string): void => { if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(chunk); };
    const off = data.subscribe(inst, (ev) => write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`));
    const beat = setInterval(() => write(': keep-alive\n\n'), 15_000);
    beat.unref();
    let done = false;
    const end = (): void => { if (done) return; done = true; streams -= 1; clearInterval(beat); off(); if (!reply.raw.writableEnded) reply.raw.end(); };
    req.raw.on('close', end); reply.raw.on('close', end); reply.raw.on('error', end);
  });

  app.get(`${P}/compare`, async (req) => {
    const q = z.object({ base: z.string().regex(/^[A-Za-z0-9]{1,15}$/).default('BTC'), locale: z.string().max(8).optional() }).parse(req.query);
    return localizeCompare(await data.compare(q.base), textLocale(q.locale));   // v8: `?locale=fr|en` (default en = the same strings as before)
  });

  app.get(`${P}/watch`, async (req) => {
    const q = z.object({ account: z.string().min(1).max(120), venue: z.string().max(40) }).parse(req.query);
    const v = reg.assertAccountAllowed(q.venue);                    // dYdX: 403 with the restriction text, before anything else
    if (!EVM_ADDRESS.test(q.account)) throw new UserError('bad_account', `an account on ${v.name} is a 20-byte hex address`, 400);
    return data.watch(v.id, q.account);
  });

  // ------------------------------------------------------------------ router (simulation) — docs/v4/ROUTER.md
  // Compares the execution conditions of ONE order intent across the venues. Nothing is placed, signed or sent; the answer is
  // an estimate (`source: 'estimate'`) and its ranking is information, never a selection.
  const router = (): NonNullable<Derivatives['router']> => { if (!d.router) throw new UserError('router_unavailable', 'the router is not configured on this instance', 503); return d.router; };
  app.get(`${P}/route/assets`, async () => router().assets());
  app.post(`${P}/route`, async (req) => {
    // v8: `?locale=fr|en` or the body's `locale` selects the language of the engine messages and contract terms; it is not part of the order intent
    const body = req.body, own = body !== null && typeof body === 'object' && !Array.isArray(body) && 'locale' in body;
    const { locale: bodyLocale, ...intent } = own ? (body as Record<string, unknown>) : { locale: undefined };
    return localizeRoute(await router().route(own ? intent : body), textLocale((req.query as { locale?: unknown } | undefined)?.locale ?? bodyLocale));
  });
  // ------------------------------------------------------------------ /router

  // ------------------------------------------------------------------ paper accounts

  app.get(`${P}/accounts`, async () => ({ accounts: await paper.list(), ts: data.now() }));
  app.post(`${P}/accounts`, async (req) => paper.create(CreateBodySchema.parse(req.body)));
  app.get(`${P}/accounts/:id`, async (req) => paper.get(accountId(req)));
  app.post(`${P}/accounts/:id/policy`, async (req) => paper.setPolicy(accountId(req), RiskPolicySchema.strict().parse(req.body)));
  app.post(`${P}/accounts/:id/orders/preview`, async (req) => paper.preview(accountId(req), OrderBodySchema.parse(req.body)));
  app.post(`${P}/accounts/:id/orders`, async (req) => {
    const id = accountId(req), key = idempotencyKey(req, true)!;
    return paper.order(id, OrderBodySchema.parse(req.body), key);
  });
  app.post(`${P}/accounts/:id/orders/:clientId/cancel`, async (req) => {
    const clientId = z.string().min(1).max(100).parse((req.params as { clientId: string }).clientId);
    return paper.cancel(accountId(req), clientId);
  });
  app.post(`${P}/accounts/:id/close`, async (req) => paper.close(accountId(req), CloseBodySchema.parse(req.body), idempotencyKey(req, false)));
  app.post(`${P}/accounts/:id/reset`, async (req) => paper.reset(accountId(req)));
}
