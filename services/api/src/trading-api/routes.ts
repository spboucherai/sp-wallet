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
import { IDEMPOTENCY_RE, replayHeaders, withIdempotency } from './idempotency.ts';
import { buildOpenApi } from './openapi.ts';
import { requirePrincipal, type Principal } from './principal.ts';
import { AmbiguousSymbol, type Reads } from './read.ts';
import { ANY_SCOPE, isExecutionScope, OPERATIONS, TRADING_PREFIX, type OperationSpec } from './spec.ts';

interface Input { params: any; query: any; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any -- validated by the operation's zod schemas
type Handler = (p: Principal, i: Input, req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/**
 * 403 unless the key is bound to a trading mandate. The owner session is not a key: it never passes through here.
 * An operation that can only REMOVE risk (`noMandate`: a cancel of the key's own order, the kill switch) needs no mandate, and
 * a command is judged on the operation it resolves to (commands.ts). Whether the bound mandate is approved, active and covers
 * the order is decided by the order service, order by order.
 */
export function requireMandate(p: Principal, op: Pick<OperationSpec, 'scope' | 'noMandate'>): void {
  if (p.kind === 'api_key' && op.scope !== ANY_SCOPE && isExecutionScope(op.scope) && !op.noMandate && !p.mandateId)
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

export function tradingRoutes(app: FastifyInstance, reads: Reads, ex: Execution): void {
  let doc: unknown = null;
  /** `venue:symbol` after the read side resolved a bare symbol (409 `ambiguous_symbol`) and applied the key's restrictions */
  const orderInput = async (p: Principal, b: Input['body']): Promise<OrderInput> => {
    // a spot order names its instrument itself (`spot:ETH`, `spot:ETH-USDC`): what it means is settled by the order service, not by the market-data listing
    const r = /^spot:[A-Za-z0-9.]{1,15}(-[A-Za-z0-9.]{1,15})?$/.test(String(b.instrument)) ? { id: String(b.instrument) } : await reads.resolve(p, b.instrument);
    return { mode: b.mode, accountId: b.accountId, instrument: r.id, side: b.side, type: b.type, size: b.size, price: b.price, triggerPrice: b.triggerPrice, reduceOnly: b.reduceOnly, tif: b.tif, slippageBps: b.slippageBps, leverage: b.leverage, maxFeeUsd: b.maxFeeUsd };
  };
  /** the idempotency key of the ORDER: the body's clientOrderId when given, else the Idempotency-Key header */
  const orderKey = (req: FastifyRequest, b?: { clientOrderId?: string }): string => b?.clientOrderId ?? replayHeaders(req).key;
  const previewKey = (req: FastifyRequest, b: { clientOrderId?: string }): string => { const h = req.headers['idempotency-key']; return b.clientOrderId ?? (typeof h === 'string' && IDEMPOTENCY_RE.test(h) ? h : `preview-${randomUUID()}`); };
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
    listPositions: (p, i) => reads.positions(p, i.query),
    // orders: the unified table (every principal, mode and venue), plus the spot agents' swaps, which have their own table
    // ONE source: the unified table. The owner's swaps and the spot agents' swaps are projected into it like the venue engines' rows
    // (orders/spot.ts); `agent:<id>` — the id the read side gave an agent's swap — still names the same order.
    listOrders: async (p, i) => ({ orders: await ex.orders.list(callerOf(p), i.query), ts: reads.now() }),
    getOrder: async (p, i) => {
      const o = await ex.orders.get(callerOf(p), i.params.id);
      if (!o) throw new UserError('unknown_order', 'unknown order', 404);
      return o;
    },
    previewOrder: async (p, i, req) => ex.orders.preview(callerOf(p, req), await orderInput(p, i.body), previewKey(req, i.body)),
    placeOrder: (p, i, req, reply) => withIdempotency(req, reply, async () => ex.orders.submit(callerOf(p, req), await orderInput(p, i.body), orderKey(req, i.body))),
    cancelOrder: (p, i, req, reply) => withIdempotency(req, reply, () => ex.orders.cancel(callerOf(p, req), i.params.id)),
    closePosition: (p, i, req, reply) => withIdempotency(req, reply, () => ex.orders.reducePosition(callerOf(p), i.params.id, '1', i.body.slippageBps, orderKey(req))),
    reducePosition: (p, i, req, reply) => withIdempotency(req, reply, () => ex.orders.reducePosition(callerOf(p), i.params.id, i.body.fraction, i.body.slippageBps, orderKey(req))),
    runCommand: (p, i, req, reply) => withIdempotency(req, reply, () => runCommand(ex, reads, p, callerOf(p, req), i.body, orderKey(req))),
    engageKillSwitch: async (p, i) => { const s = await ex.risk.engageKillSwitch(p.kind === 'owner' ? { kind: 'owner', id: 'owner' } : { kind: 'api_key', id: p.id }, i.body.reason); return { killSwitch: s.killSwitch, readOnly: s.readOnly }; },
    listStrategies: (p, i) => reads.strategies(p, i.query),
    listAgents: (p) => reads.agents(p),
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
}
