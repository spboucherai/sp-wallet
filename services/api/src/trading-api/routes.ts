// /api/v1/trading — registration of the operations of spec.ts. One handler per operation id; the table and the handlers are
// compared at start-up (a missing or an extra handler throws), so a route cannot exist without a declared scope and a schema.
//
// Read operations call read.ts. Write operations are registered with their scope, their validation schema and the
// idempotency middleware, and answer 501 `execution_not_wired`: the next wave replaces `notWired` by a real handler and
// nothing else. A 501 is an error answer — never a success, and never stored as the answer of an Idempotency-Key.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { UserError } from '../config.ts';
import { withIdempotency } from './idempotency.ts';
import { buildOpenApi } from './openapi.ts';
import { requirePrincipal, type Principal } from './principal.ts';
import { AmbiguousSymbol, type Reads } from './read.ts';
import { ANY_SCOPE, isExecutionScope, OPERATIONS, TRADING_PREFIX, type OperationSpec } from './spec.ts';
import { agentTradingHandlers } from '../agents/trading-handlers.ts'; // v11 agents: the strategies and agents operations

interface Input { params: any; query: any; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any -- validated by the operation's zod schemas
type Handler = (p: Principal, i: Input, req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** 403 unless the key is bound to a trading mandate. The owner session is not a key: it never passes through here. */
export function requireMandate(p: Principal, op: Pick<OperationSpec, 'scope'>): void {
  if (p.kind === 'api_key' && op.scope !== ANY_SCOPE && isExecutionScope(op.scope) && !p.mandateId)
    throw new UserError('mandate_required', `the scope ${op.scope} is inert on this key: no trading mandate is bound to it`, 403);
}
const notWired = (op: OperationSpec): Handler => async (_p, _i, req, reply) =>
  withIdempotency(req, reply, async () => { throw new UserError('execution_not_wired', `${op.method} ${TRADING_PREFIX}${op.path} is declared but not connected to execution yet; nothing was done`, 501); });

export function tradingRoutes(app: FastifyInstance, reads: Reads): void {
  let doc: unknown = null;
  const handlers: Record<string, Handler> = {
    getOpenApi: async () => (doc ??= buildOpenApi()),
    listMarkets: (p, i) => reads.markets(p, i.query),
    getMarket: (p, i) => reads.market(p, i.params.symbol),
    getOrderbook: (p, i) => reads.orderbook(p, i.params.symbol, i.query.depth),
    getCandles: (p, i) => reads.candles(p, i.params.symbol, i.query.interval, i.query.limit),
    getPortfolio: (p) => reads.portfolio(p),
    getBalances: (p, i) => reads.balances(p, i.query),
    getActivity: (p, i) => reads.activity(p, i.query),
    listPositions: (p, i) => reads.positions(p, i.query),
    listOrders: (p, i) => reads.orders(p, i.query),
    getOrder: (p, i) => reads.order(p, i.params.id),
    listStrategies: (p, i) => reads.strategies(p, i.query),
    ...agentTradingHandlers(),   // v11 agents: createStrategy … stopAgent, listAgents and the per-agent, mode-scoped reads
    getRisk: (p) => reads.risk(p),
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
