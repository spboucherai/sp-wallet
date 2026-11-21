/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/trading-api/routes.ts
 * Module           : trading-api
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-17
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

// /api/v1/trading — registration of the operations of spec.ts. One handler per operation id; the table and the handlers are
// compared at start-up (a missing or an extra handler throws), so a route cannot exist without a declared scope and a schema.
//
// Read operations call read.ts. The order operations call the order service (orders/service.ts) — the single entry of every
// order, which runs the mandate, the risk engine and then the venue engine's own path; nothing here talks to a venue or to the
// signer. The strategy and agent operations are still registered with their scope, their validation schema and the idempotency
// middleware, and answer 501 `execution_not_wired` (the agents runtime wires them). A 501 is never stored as the answer of a key.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { UserError } from '../config.ts';
import { OWNER_CALLER, type Caller, type Execution, type OrderInput } from '../orders/index.ts';
import { runCommand } from './commands.ts';
import { IDEMPOTENCY_RE, replayHeaders, withIdempotency, withOrderKey } from './idempotency.ts';
import { buildOpenApi } from './openapi.ts';
import { requirePrincipal, type Principal } from './principal.ts';
import { REFERENCE_JS, referenceHtml, referenceMarkdown } from './reference.ts';
import { AmbiguousSymbol, type Reads } from './read.ts';
import type { NftReads } from './nft-read.ts';
import { shapePreview, shapeRefusal } from './shaping.ts';
import { ANY_SCOPE, NOT_FOUND, OPERATIONS, requiresMandate, TRADING_PREFIX, type OperationSpec } from './spec.ts';
import { agentTradingHandlers } from '../agents/trading-handlers.ts'; // v11 agents: the strategies and agents operations

interface Input { params: any; query: any; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any -- validated by the operation's zod schemas
type Handler = (p: Principal, i: Input, req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/**
 * 403 unless the key is bound to a trading mandate. The owner session is not a key: it never passes through here.
 * An operation that can only REMOVE risk (`noMandate`: a cancel of the key's own order, the kill switch) needs no mandate, and
 * a command is judged on the operation it resolves to (commands.ts). Whether the bound mandate is approved, active and covers
 * the order is decided by the order service, order by order.
 */
export function requireMandate(p: Principal, op: Pick<OperationSpec, 'scope' | 'noMandate'>): void {
  if (p.kind === 'api_key' && requiresMandate(op) && !p.mandateId)
    throw new UserError('mandate_required', `the scope ${op.scope} is inert on this key: no trading mandate is bound to it`, 403);
}
const notWired = (op: OperationSpec): Handler => async (_p, _i, req, reply) =>
  withIdempotency(req, reply, async () => { throw new UserError('execution_not_wired', `${op.method} ${TRADING_PREFIX}${op.path} is declared but not connected to execution yet; nothing was done`, 501); });

/** the principal of the request as the order service takes it: a key's limits and restrictions travel with it */
const header = (req: FastifyRequest, name: string): string => { const v = req.headers[name]; return typeof v === 'string' ? v : ''; };
/**
 * `req` (the owner only): his session as this request carried it — cookie, origin, CSRF header. An owner's spot order hands it,
 * unchanged, to the existing swap proposal route of this server (orders/spot.ts): the order is then prepared by that flow, under
 * that flow's own checks. A key has no session and never gets one.
 */
export const callerOf = (p: Principal, req?: FastifyRequest): Caller => (p.kind === 'owner' ? (req ? { ...OWNER_CALLER, session: { cookie: header(req, 'cookie'), origin: header(req, 'origin'), csrf: header(req, 'x-spw-csrf') } } : OWNER_CALLER)
  : { principal: { kind: 'api_key', id: p.id }, mandateId: p.mandateId, limits: p.limits, restrictions: { networks: p.restrictions.networks, venues: p.restrictions.venues, instruments: p.restrictions.instruments } });

export function tradingRoutes(app: FastifyInstance, reads: Reads, ex: Execution, nfts: NftReads): void {
  let doc: unknown = null;
  /** `venue:symbol` after the read side resolved a bare symbol (409 `ambiguous_symbol`) and applied the key's restrictions */
  const orderInput = async (p: Principal, b: Input['body']): Promise<OrderInput> => {
    // a spot order names its instrument itself (`spot:ETH`, `spot:ETH-USDC`): what it means is settled by the order service, not by the market-data listing
    if (SPOT_INSTRUMENT.test(String(b.instrument))) return { mode: b.mode, accountId: b.accountId, instrument: String(b.instrument), side: b.side, type: b.type, size: b.size ?? b.notional, price: b.price, triggerPrice: b.triggerPrice,
      reduceOnly: b.reduceOnly, tif: b.tif, slippageBps: b.slippageBps, leverage: b.leverage, maxFeeUsd: b.maxFeeUsd };
    const r = await reads.resolve(p, b.instrument);
    // `notional` is turned into a size HERE, by the server, from the price the order itself names or the venue's mark read now
    const size: string = b.size ?? await reads.sizeForNotional(r, b);
    return { mode: b.mode, accountId: b.accountId, instrument: r.id, side: b.side, type: b.type, size, price: b.price, triggerPrice: b.triggerPrice, reduceOnly: b.reduceOnly, tif: b.tif, slippageBps: b.slippageBps, leverage: b.leverage, maxFeeUsd: b.maxFeeUsd };
  };
  /** the idempotency key of the ORDER: the body's clientOrderId when given, else the Idempotency-Key header */
  const orderKey = (req: FastifyRequest, b?: { clientOrderId?: string }): string => b?.clientOrderId ?? replayHeaders(req).key;
  const previewKey = (req: FastifyRequest, b: { clientOrderId?: string }): string => { const h = req.headers['idempotency-key']; return b.clientOrderId ?? (typeof h === 'string' && IDEMPOTENCY_RE.test(h) ? h : `preview-${randomUUID()}`); };
  const SPOT_INSTRUMENT = /^spot:[A-Za-z0-9.]{1,15}(-[A-Za-z0-9.]{1,15})?$/;
  /**
   * A spot BUY names the amount of the QUOTE asset to spend (`notional`): a swap is exact-input. The order service's input carries a
   * base size only, so the order is resolved the way the command grammar resolves `BUY <base> <amount> [<quote>]` — the same
   * defaults, the same canonical order, the same swap flow (commands.ts) — and answered in the shapes of this operation.
   */
  const spotBuy = (b: Input['body']): boolean => SPOT_INSTRUMENT.test(String(b.instrument)) && b.side === 'buy' && b.notional !== undefined && b.type === 'market';
  const spotBuyText = (b: Input['body']): string => { const [base, quote] = String(b.instrument).slice(5).split('-'); return `BUY ${base} ${b.notional}${quote ? ` ${quote}` : ''}`; };
  /** a refusal about an order tells a key no more about the account than its scopes let it read (shaping.ts); the stored answer of the Idempotency-Key is the shaped one */
  const shaped = <T>(p: Principal, fn: () => Promise<T>) => async (): Promise<T> => { try { return await fn(); } catch (e) { throw shapeRefusal(p, e); } };
  const handlers: Record<string, Handler> = {
    getOpenApi: async () => (doc ??= buildOpenApi()),
    listMarkets: (p, i) => reads.markets(p, i.query),
    compareMarkets: (p, i) => reads.compare(p, i.query),
    getMarket: (p, i) => reads.market(p, i.params.symbol),
    getOrderbook: (p, i) => reads.orderbook(p, i.params.symbol, i.query.depth),
    getCandles: (p, i) => reads.candles(p, i.params.symbol, i.query.interval, i.query.limit),
    listPrivateMarkets: (p, i) => reads.privateMarkets(p, i.query),                       // v11 private markets (read-only)
    getPrivateMarketCompany: (p, i) => reads.privateMarketCompany(p, i.params.slug, i.query),
    getPrivateMarket: (p, i) => reads.privateMarket(p, i.params.id, i.query),
    getPortfolio: (p) => reads.portfolio(p),
    getBalances: (p, i) => reads.balances(p, i.query),
    getActivity: (p, i) => reads.activity(p, i.query),
    // NFT (delivery 3): five reads — the owner's inventory (wallet:read) and market data of any item (markets:read). No write.
    listNfts: (p, i) => nfts.listNfts(p, i.query),
    getNft: (p, i) => nfts.getNft(p, i.query.key),
    getNftActivity: (p, i) => nfts.getNftActivity(p, i.query),
    getNftMarket: (p, i) => nfts.getNftMarket(p, i.query),
    getNftMarketEvents: (p, i) => nfts.getNftMarketEvents(p, i.query),
    listPositions: (p, i) => reads.positions(p, i.query),
    // orders: ONE source, the unified table — every principal, mode and venue; the owner's swaps and the spot agents' swaps are projected
    // into it (orders/spot.ts) and `agent:<id>` still names the same order. Listed with keyset pagination by the read layer.
    listOrders: (p, i) => reads.orders(p, i.query),
    getOrder: async (p, i) => {
      const o = await ex.orders.get(callerOf(p), i.params.id);
      if (!o) throw new UserError('unknown_order', 'unknown order', 404);
      return o;
    },
    previewOrder: async (p, i, req) => {
      // A key previews the order it could PLACE, and that order names the mandate it would be checked against: without one there is
      // no such order (the order service would answer 400 `invalid_order` about a `mandateId` the caller never sent). Say what is missing.
      // (a spot order is refused to every key by the order service, with its own precise code: that answer is left to it)
      if (p.kind === 'api_key' && !p.mandateId && !SPOT_INSTRUMENT.test(String(i.body.instrument))) throw new UserError('mandate_required', 'no trading mandate is bound to this key: there is no order it could place, so nothing to preview', 403);
      if (spotBuy(i.body)) return shapePreview(p, (await runCommand(ex, reads, p, callerOf(p, req), { text: spotBuyText(i.body), mode: i.body.mode, dryRun: true }, previewKey(req, i.body))).preview as never);
      return shapePreview(p, await ex.orders.preview(callerOf(p, req), await orderInput(p, i.body), previewKey(req, i.body)));
    },
    placeOrder: (p, i, req, reply) => {
      const place = shaped(p, async () => {
        if (!spotBuy(i.body)) return ex.orders.submit(callerOf(p, req), await orderInput(p, i.body), orderKey(req, i.body));
        const r = await runCommand(ex, reads, p, callerOf(p, req), { text: spotBuyText(i.body), mode: i.body.mode, dryRun: false }, orderKey(req, i.body));
        return { order: r.order, idempotent: r.idempotent, approval: r.approval ?? null };
      });
      // an order sized by a notional and named by its own clientOrderId is replayed from the stored answer, before any price is read again
      const named = i.body.notional !== undefined && i.body.clientOrderId !== undefined;
      return withIdempotency(req, reply, named ? () => withOrderKey(req, reply, i.body.clientOrderId, place) : place);
    },
    cancelOrder: (p, i, req, reply) => withIdempotency(req, reply, () => ex.orders.cancel(callerOf(p, req), i.params.id)),
    closePosition: (p, i, req, reply) => withIdempotency(req, reply, shaped(p, () => ex.orders.reducePosition(callerOf(p), i.params.id, '1', i.body.slippageBps, orderKey(req)))),
    reducePosition: (p, i, req, reply) => withIdempotency(req, reply, shaped(p, () => ex.orders.reducePosition(callerOf(p), i.params.id, i.body.fraction, i.body.slippageBps, orderKey(req)))),
    runCommand: (p, i, req, reply) => withIdempotency(req, reply, shaped(p, () => runCommand(ex, reads, p, callerOf(p, req), i.body, orderKey(req)))),
    engageKillSwitch: async (p, i) => { const s = await ex.risk.engageKillSwitch(p.kind === 'owner' ? { kind: 'owner', id: 'owner' } : { kind: 'api_key', id: p.id }, i.body.reason); return { killSwitch: s.killSwitch, readOnly: s.readOnly }; },
    listStrategies: (p, i) => reads.strategies(p, i.query),
    ...agentTradingHandlers(),   // v11 agents: createStrategy … stopAgent, listAgents and the per-agent, mode-scoped reads
    getRisk: async (p) => ({ ...(await reads.risk(p)), engine: { ...(await ex.risk.switches()), note: 'the global kill switch blocks every new risk (cancels and strictly reducing orders pass); read-only mode lets only cancels pass. Releasing either needs the owner\'s passkey.' } }),
  };
  for (const op of OPERATIONS) if (!op.implemented) { if (handlers[op.id]) throw new Error(`trading-api: ${op.id} is declared not implemented but has a handler`); handlers[op.id] = notWired(op); }
  const declared = new Set(OPERATIONS.map((o) => o.id));
  for (const id of Object.keys(handlers)) if (!declared.has(id)) throw new Error(`trading-api: handler ${id} has no operation in spec.ts`);

  for (const op of OPERATIONS) {
    const h = handlers[op.id];
    if (!h) throw new Error(`trading-api: operation ${op.id} has no handler`);
    app.route({
      method: op.method, url: TRADING_PREFIX + op.path,
      // per key: the limiter of principal.ts (RateLimit-* headers); the per-address limiter of server.ts stays for the owner session
      config: { scope: op.scope, rateLimit: { allowList: (req: FastifyRequest) => req.principal?.kind === 'api_key' } },
      handler: async (req, reply) => {
        const p = requirePrincipal(req);
        requireMandate(p, op);
        const input: Input = { params: op.params ? op.params.parse(req.params) : {}, query: op.query ? op.query.parse(req.query) : {}, body: op.body ? op.body.parse(req.body) : undefined };
        try { return await h(p, input, req, reply); }
        catch (e) {
          if (e instanceof AmbiguousSymbol) return reply.status(409).send({ error: e.code, message: e.message, candidates: e.candidates });
          throw e;
        }
      },
    });
  }
  // The reference a person reads, rendered from the same table (reference.ts): GET …/docs (HTML), …/docs.md (Markdown) and
  // …/docs.js (the page's script — a same-origin FILE because the CSP of server.ts is `script-src 'self'`: nothing inline runs).
  // Not operations of the contract (they are not in the OpenAPI document, the SDKs or the operation count); like every path
  // under the prefix they need a principal — any valid key, or the owner session of the browser — and count against a key's
  // rate limit. Rendered once per process: the content depends on the code only.
  const pages: Record<string, { type: string; render: () => string; body?: string }> = {
    '/docs': { type: 'text/html; charset=utf-8', render: referenceHtml },
    '/docs.md': { type: 'text/markdown; charset=utf-8', render: referenceMarkdown },
    '/docs.js': { type: 'text/javascript; charset=utf-8', render: () => REFERENCE_JS },
  };
  for (const [path, page] of Object.entries(pages)) app.route({
    method: 'GET', url: TRADING_PREFIX + path,
    config: { scope: ANY_SCOPE, rateLimit: { allowList: (req: FastifyRequest) => req.principal?.kind === 'api_key' } },
    handler: async (req, reply) => { requirePrincipal(req); return reply.type(page.type).send((page.body ??= page.render())); },
  });

  // Anything else under the prefix — an unknown path, or a known path with another method — answers the API's own error model,
  // whether or not the server also serves the web app (whose not-found handler exists only when a web directory is configured).
  // Authentication still comes first (401), and the answer is counted against the key's rate limit like any other.
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], url: `${TRADING_PREFIX}/*`,
    config: { scope: ANY_SCOPE, rateLimit: { allowList: (req: FastifyRequest) => req.principal?.kind === 'api_key' } },
    handler: async (req, reply) => { requirePrincipal(req); return reply.status(NOT_FOUND.status).send({ error: NOT_FOUND.code, message: NOT_FOUND.message }); },
  });
}
