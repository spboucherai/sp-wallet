// Universal Swap Router — API surface (V2). Price discovery only: there is deliberately no execution endpoint yet.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatUnits, getAsset, getNetwork, parseUnits } from '@spw/core';
import {
  assetKey, createProviders, DEFAULT_POLICY, httpClient, LiquidityGraph, ProviderRuntime, QuoteAggregator, SwapRouter,
  type AssetRef, type QuoteEvent, type Route, type RouteSearch, type SwapProvider, type SwapQuoteRequest, type Valuer,
} from '@spw/swap';
import { UserError } from './config.ts';
import { sql } from './db.ts';
import { addressFor, signer } from './signer-client.ts';

export interface SwapDeps { providers?: SwapProvider[]; prices: () => Promise<Record<string, { usd: number }> | null> }

const Query = z.object({
  from: z.string().min(3).max(140), to: z.string().min(3).max(140),
  amount: z.string().min(1).max(60),
  slippageBps: z.coerce.number().int().min(1).max(500).default(50),
});
const refOf = (s: string): AssetRef => {
  const k = s.indexOf(':');
  if (k < 1) throw new UserError('bad_asset', 'asset must be "<network>:<asset>"');
  const ref = { network: s.slice(0, k), asset: s.slice(k + 1) };
  try { getAsset(ref.network, ref.asset); } catch { throw new UserError('unsupported_asset', 'asset is not in the wallet registry'); }
  return ref;
};
const big = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

export function swapRoutes(app: FastifyInstance, deps: SwapDeps): void {
  const providers = deps.providers ?? createProviders(process.env);
  const runtimes = providers.map((p) => new ProviderRuntime(p, { ...DEFAULT_POLICY, ...p.policy }, httpClient(p.id)));
  const agg = new QuoteAggregator(runtimes), graph = new LiquidityGraph(providers);
  // prices are refreshed outside the hot path; the valuer itself is synchronous
  let priceMap: Record<string, { usd: number }> = {};
  const refresh = async () => { const p = await deps.prices().catch(() => null); if (p) priceMap = p; };
  const valuer: Valuer = (a, amount) => { try { const d = getAsset(a.network, a.asset), p = priceMap[d.symbol]?.usd; return p === undefined ? null : Number(formatUnits(amount, d.decimals)) * p; } catch { return null; } };
  const router = new SwapRouter(agg, graph, valuer);

  const viewAsset = (a: AssetRef) => { const d = getAsset(a.network, a.asset), n = getNetwork(a.network); return { key: assetKey(a), network: a.network, networkName: n.name, asset: a.asset, symbol: d.symbol, name: d.name, decimals: d.decimals }; };
  const viewRoute = (r: Route) => {
    const out = getAsset(r.path[r.path.length - 1]!.network, r.path[r.path.length - 1]!.asset);
    return {
      id: r.id, providers: r.providers, path: r.path.map(viewAsset), tags: r.tags, pareto: r.pareto,
      amountOut: r.amountOut, minAmountOut: r.minAmountOut, amountOutDisplay: formatUnits(r.amountOut, out.decimals), minAmountOutDisplay: formatUnits(r.minAmountOut, out.decimals),
      estimatedSeconds: r.estimatedSeconds, expiresAt: r.expiresAt, executability: r.executability, valuation: r.valuation, risk: r.risk,
      atomic: r.legs.length === 1 && r.legs[0]!.atomic, refundable: r.legs.some((l) => l.refundable === false) ? false : r.legs.some((l) => l.refundable === null) ? null : true,
      priceImpactBps: r.legs.every((l) => l.priceImpactBps !== null) ? r.legs.reduce((s, l) => s + l.priceImpactBps!, 0) : null,
      steps: r.legs.flatMap((l) => l.steps.map((s) => ({ kind: s.kind, provider: s.provider, from: viewAsset(s.from), to: viewAsset(s.to), via: s.via, contracts: s.contracts }))),
      fees: r.legs.flatMap((l) => l.fees.map((f) => { const d = getAsset(f.asset.network, f.asset.asset); return { kind: f.kind, symbol: d.symbol, network: f.asset.network, amount: f.amount, display: formatUnits(f.amount, d.decimals), includedInOutput: f.includedInOutput, estimated: f.estimated, usd: valuer(f.asset, f.amount) }; })),
    };
  };
  async function request(q: z.infer<typeof Query>): Promise<SwapQuoteRequest> {
    const from = refOf(q.from), to = refOf(q.to);
    if (assetKey(from) === assetKey(to)) throw new UserError('same_asset', 'choose two different assets');
    let amountIn: bigint;
    try { amountIn = parseUnits(q.amount, getAsset(from.network, from.asset).decimals); } catch (e) { throw new UserError('bad_amount', (e as Error).message); }
    if (amountIn <= 0n) throw new UserError('bad_amount', 'amount must be greater than zero');
    const st = await signer.status();
    // both ends are always the wallet's own addresses, taken from the signer — never from the client
    return { from, to, amountIn, sender: addressFor(st, from.network), recipient: addressFor(st, to.network), slippageBps: q.slippageBps };
  }
  type Row = { search_id: string; provider: string; from_key: string; to_key: string; amount_in: string; amount_out: string | null; min_out: string | null; ms: number; ok: boolean; code: string | null };
  const record = (searchId: string, req: SwapQuoteRequest, events: QuoteEvent[]) => {
    const rows: Row[] = events.flatMap((e): Row[] => e.type === 'quote' ? [{ search_id: searchId, provider: e.quote.provider, from_key: assetKey(e.quote.request.from), to_key: assetKey(e.quote.request.to), amount_in: e.quote.request.amountIn.toString(), amount_out: e.quote.amountOut.toString(), min_out: e.quote.minAmountOut.toString(), ms: e.ms, ok: true, code: null }]
      : e.type === 'provider' && e.status !== 'skipped' ? [{ search_id: searchId, provider: e.provider, from_key: assetKey(req.from), to_key: assetKey(req.to), amount_in: req.amountIn.toString(), amount_out: null, min_out: null, ms: e.ms, ok: e.status === 'no_route', code: e.status === 'no_route' ? 'no_route' : e.code ?? 'error' }] : []);
    if (rows.length) void sql`insert into swap_quotes ${sql(rows as never)}`.catch(() => {});
  };
  const summary = (s: RouteSearch) => ({ best: s.best, reachable: s.reachable, ms: s.ms, routes: s.routes.map(viewRoute),
    providers: s.events.flatMap((e) => (e.type === 'provider' ? [{ provider: e.provider, status: e.status, code: e.code ?? null, ms: e.ms }] : [])) });

  app.get('/api/v1/swap/assets', async () => ({ assets: [...graph.nodes.values()].map((n) => ({ key: n.key, network: n.network, networkName: n.networkName, asset: n.asset, symbol: n.symbol, name: n.name, decimals: n.decimals, native: n.native })) }));
  app.get('/api/v1/swap/providers', async () => ({
    executionEnabled: false,
    providers: runtimes.map((r) => ({ ...r.stats(), name: r.provider.name, capabilities: r.provider.capabilities() })),
  }));
  app.get('/api/v1/swap/stats', async () => {
    const rows = await sql`select provider, count(*)::int as calls, count(*) filter (where ok)::int as ok, count(*) filter (where amount_out is not null)::int as quotes,
      percentile_cont(0.5) within group (order by ms)::int as p50, percentile_cont(0.95) within group (order by ms)::int as p95, percentile_cont(0.99) within group (order by ms)::int as p99
      from swap_quotes where at > now() - interval '7 days' group by provider order by provider`;
    return { window: '7d', providers: rows };
  });

  app.post('/api/v1/swap/quote', async (req) => {
    const r = await request(Query.parse(req.body)); await refresh();
    const s = await router.search(r); record(randomUUID(), r, s.events);
    return JSON.parse(JSON.stringify(summary(s), big)); // amounts leave the API as decimal strings, never as JS numbers
  });

  // Server-sent events: routes are pushed as each provider answers, then one "done" event with the final ranking.
  app.get('/api/v1/swap/quote/stream', async (req, reply) => {
    const r = await request(Query.parse(req.query)); await refresh();
    const ac = new AbortController(); req.raw.on('close', () => ac.abort());
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (event: string, data: unknown) => { if (!reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data, big)}\n\n`); };
    send('start', { from: viewAsset(r.from), to: viewAsset(r.to), amountIn: r.amountIn, slippageBps: r.slippageBps, reachable: graph.reachable(r.from, r.to) });
    try {
      const s = await router.search(r, { signal: ac.signal,
        onRoute: (route) => send('route', viewRoute(route)),
        onEvent: (e) => { if (e.type === 'provider') send('provider', { provider: e.provider, status: e.status, code: e.code ?? null, ms: e.ms }); } });
      record(randomUUID(), r, s.events);
      send('done', summary(s));
    } catch (e) { send('error', { message: (e as Error).message.slice(0, 200) }); }
    reply.raw.end();
  });

  // Execution is not implemented: say so explicitly rather than leaving an ambiguous 404.
  app.post('/api/v1/swap/execute', async () => { throw new UserError('swap_disabled', 'swap execution is not enabled: this version compares routes only', 423); });
}
