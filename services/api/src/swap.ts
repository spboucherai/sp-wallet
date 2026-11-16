// Universal Swap Router — API surface: price discovery (quotes, routes, the normalized route card). Execution lives in
// swap-exec.ts / swap-exec-sol.ts (same-network swaps), bridge.ts (CCTP) and xswap.ts (THORChain); what a route can be
// executed through is decided HERE from the pinned tables (`executable`, `executor`), never by a provider and never by the client.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CCTP_ENABLED, formatUnits, getAsset, getNetwork, KYBER_ENABLED, parseUnits, thorPairEnabled } from '@spw/core';
import {
  assetKey, buildRouteCard, createEnabledProviders, DEFAULT_POLICY, httpClient, LiquidityGraph, ProviderRuntime, QuoteAggregator, SwapRouter, type RouteCardFee,
  type AssetRef, type QuoteEvent, type Route, type RouteSearch, type SwapProvider, type SwapQuoteRequest, type Valuer,
} from '@spw/swap';
import { UserError } from './config.ts';
import { sql } from './db.ts';
import { addressFor, signer } from './signer-client.ts';
import { quoteFingerprint } from './prepare-common.ts';

export interface SwapDeps { providers?: SwapProvider[]; prices: () => Promise<Record<string, { usd: number }> | null>;
  /** tests: SSE heartbeat period and the cap on concurrent quote streams */ heartbeatMs?: number; maxStreams?: number }

/** v11: at most this many quote streams at once (one owner, a few tabs); each stream asks every compatible provider. */
export const MAX_QUOTE_STREAMS = 6;
/** v11: the browser's EventSource waits this long before reconnecting, and a comment line keeps proxies from closing a quiet stream. */
const SSE_RETRY_MS = 3000, SSE_HEARTBEAT_MS = 15_000;
let openStreams = 0;

/** v11 retention: `swap_quotes` holds one row per provider answer per search; /swap/stats reads seven days of it. */
export const SWAP_QUOTES_RETENTION_DAYS = Math.max(8, Number(process.env.SPW_SWAP_QUOTES_RETENTION_DAYS ?? 30) || 30);
export async function pruneSwapQuotes(days = SWAP_QUOTES_RETENTION_DAYS): Promise<number> {
  const r = await sql`delete from swap_quotes where at < now() - make_interval(days => ${Math.max(1, Math.floor(days))})`;
  return r.count;
}

/** USDC of a network CCTP serves (the seven EVM networks and Solana). */
const cctpUsdcRef = (a: AssetRef) => (a.network === 'solana' || (getNetwork(a.network).family === 'evm' && !!CCTP_ENABLED[a.network])) && getAsset(a.network, a.asset).symbol === 'USDC';
/**
 * Which executors the wallet has for a PAIR, from the pinned tables alone (v11, B6). The client used to infer "this is a
 * THORChain swap" from which routes happened to be in the stream; a provider that timed out changed the answer.
 */
export function pairExecutors(from: AssetRef, to: AssetRef): ('kyberswap' | 'jupiter' | 'cctp' | 'thorchain')[] {
  const out: ('kyberswap' | 'jupiter' | 'cctp' | 'thorchain')[] = [];
  if (from.network === to.network) { if (getNetwork(from.network).family === 'sol') out.push('jupiter'); else if (KYBER_ENABLED[from.network]) out.push('kyberswap'); }
  else { if (cctpUsdcRef(from) && cctpUsdcRef(to)) out.push('cctp'); if (thorPairEnabled(from, to)) out.push('thorchain'); }
  return out;
}

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

export function swapRoutes(app: FastifyInstance, deps: SwapDeps): ProviderRuntime[] {
  const providers = deps.providers ?? createEnabledProviders(process.env);
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
    const first = r.path[0]!, last = r.path[r.path.length - 1]!;
    // USDC -> USDC between two EVM networks through CCTP: the signer builds both transactions itself (services/api/src/bridge.ts)
    const usdcOf = cctpUsdcRef; // v8: Solana too (services/api/src/bridge-sol.ts)
    const cctp = r.legs.length === 1 && r.providers[0] === 'cctp' && first.network !== last.network && usdcOf(first) && usdcOf(last);
    const cctpSpeed = cctp ? ((r.legs[0]!.raw as { transfer?: string } | undefined)?.transfer === 'fast' ? 'fast' : 'standard') : null;
    // Jupiter on Solana: the signer decodes the v1 transaction itself (services/api/src/swap-exec-sol.ts); whether a given route can be put in the verifiable form is decided when the swap is prepared
    const jupiter = r.legs.length === 1 && r.providers[0] === 'jupiter' && first.network === last.network && getNetwork(first.network).family === 'sol';
    // THORChain native swap on a pinned pair: memo and transaction built by the signer, vault confirmed by its own THORNode operators (services/api/src/xswap.ts)
    const thor = r.legs.length === 1 && r.providers[0] === 'thorchain' && thorPairEnabled(first, last);
    const executable = cctp || jupiter || thor || (r.legs.length === 1 && r.providers[0] === 'kyberswap' && !!KYBER_ENABLED[first.network] && first.network === last.network);
    // on a reviewed router the signer decodes and enforces recipient and minimum output itself: not an opaque transaction
    const flags = executable ? r.risk.flags.filter((f) => f.code !== 'opaque_transaction' && !((cctp || thor) && f.code === 'not_executable')) : r.risk.flags;
    const level = flags.some((f) => f.level === 'high') ? 'high' : flags.some((f) => f.level === 'medium') ? 'medium' : 'low';
    const risk = executable ? { level, score: Math.max(0, r.risk.score - 12), flags } : r.risk;
    // v11: the server states who executes (never inferred by the client), and every route carries the same normalized card
    const executor = !executable ? null : thor ? 'thorchain' as const : cctp ? 'cctp' as const : jupiter ? 'jupiter' as const : 'kyberswap' as const;
    const slippageBps = r.legs[0]!.request.slippageBps;
    const fingerprint = quoteFingerprint({ provider: r.providers.join('+'), fromKey: assetKey(first), toKey: assetKey(last), amountIn: r.amountIn.toString(), slippageBps, amountOut: r.amountOut.toString(), minAmountOut: r.minAmountOut.toString() });
    const c = buildRouteCard(r, valuer, { executable, executor, fingerprint, reasonCode: r.executability.class === 'verified' ? null : r.executability.code ?? r.executability.class });
    const feeItems = (items: RouteCardFee[]) => items.map((i) => { const d = getAsset(i.asset.network, i.asset.asset); return { kind: i.kind, network: i.asset.network, symbol: d.symbol, amount: i.amount, display: formatUnits(i.amount, d.decimals), estimated: i.estimated, includedInOutput: i.includedInOutput, usd: i.usd }; });
    const inDef = getAsset(first.network, first.asset);
    const card = { ...c, riskLevel: risk.level, riskFlags: risk.flags.map((f) => f.code), quoteId: r.id, fromSymbol: inDef.symbol, toSymbol: out.symbol,
      amountInDisplay: formatUnits(c.amountIn, inDef.decimals), estimatedOutDisplay: formatUnits(c.estimatedOut, out.decimals), minimumOutDisplay: formatUnits(c.minimumOut, out.decimals),
      networkFee: c.networkFee ? { ...c.networkFee, items: feeItems(c.networkFee.items) } : null, protocolFee: c.protocolFee ? { ...c.protocolFee, items: feeItems(c.protocolFee.items) } : null };
    return {
      card, executor, fingerprint, quotedAt: c.quotedAt, amountIn: r.amountIn,
      id: r.id, providers: r.providers, path: r.path.map(viewAsset), tags: r.tags, pareto: r.pareto,
      // the wallet can execute this route itself today (signer-verified calldata on a reviewed router)
      executable, exec: executable ? (thor ? { via: 'thorchain' as const } : cctp ? { via: 'cctp' as const, speed: cctpSpeed } : jupiter ? { via: 'jupiter' as const } : { via: 'kyberswap' as const }) : null,
      amountOut: r.amountOut, minAmountOut: r.minAmountOut, amountOutDisplay: formatUnits(r.amountOut, out.decimals), minAmountOutDisplay: formatUnits(r.minAmountOut, out.decimals),
      estimatedSeconds: r.estimatedSeconds, expiresAt: r.expiresAt, executability: thor ? { class: 'verified' as const, code: 'thor_verified', reason: 'memo and transaction are built by the signer; the vault address is confirmed by at least three independent THORNode operators asked by the signer itself' } : executable ? { class: 'verified' as const } : r.executability, valuation: r.valuation, risk,
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
  const summary = (s: RouteSearch, req: SwapQuoteRequest) => ({ best: s.best, reachable: s.reachable, ms: s.ms, executors: pairExecutors(req.from, req.to), routes: s.routes.map(viewRoute),
    providers: s.events.flatMap((e) => (e.type === 'provider' ? [{ provider: e.provider, status: e.status, code: e.code ?? null, ms: e.ms }] : [])) });

  app.get('/api/v1/swap/assets', async () => ({ assets: [...graph.nodes.values()].map((n) => ({ key: n.key, network: n.network, networkName: n.networkName, asset: n.asset, symbol: n.symbol, name: n.name, decimals: n.decimals, native: n.native })) }));
  app.get('/api/v1/swap/providers', async () => ({
    executionEnabled: true,
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
    return JSON.parse(JSON.stringify(summary(s, r), big)); // amounts leave the API as decimal strings, never as JS numbers
  });

  // Server-sent events: routes are pushed as each provider answers, then one "done" event with the final ranking.
  app.get('/api/v1/swap/quote/stream', async (req, reply) => {
    // v11: a cap on concurrent streams (each one asks every compatible provider), checked before anything is asked
    if (openStreams >= (deps.maxStreams ?? MAX_QUOTE_STREAMS)) throw new UserError('too_many_streams', 'too many quote searches are running at once; close one or wait a moment', 429);
    openStreams += 1; let released = false; const release = () => { if (!released) { released = true; openStreams -= 1; } };
    let beat: ReturnType<typeof setInterval> | null = null;
    try {
      const r = await request(Query.parse(req.query)); await refresh();
      const ac = new AbortController(); req.raw.on('close', () => { ac.abort(); release(); if (beat) clearInterval(beat); });
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      // v11: `retry:` tells EventSource how long to wait before reconnecting; a comment line every 15 s keeps a slow search alive through proxies
      beat = setInterval(() => { if (!reply.raw.writableEnded) reply.raw.write(': keep-alive\n\n'); }, deps.heartbeatMs ?? SSE_HEARTBEAT_MS); beat.unref();
      // (the `retry:` field travels inside the first event, after its name: clients that read the first line of a block still see `event: start`)
      const send = (event: string, data: unknown, field = '') => { if (!reply.raw.writableEnded) reply.raw.write(`event: ${event}\n${field}data: ${JSON.stringify(data, big)}\n\n`); };
      send('start', { from: viewAsset(r.from), to: viewAsset(r.to), amountIn: r.amountIn, slippageBps: r.slippageBps, reachable: graph.reachable(r.from, r.to), executors: pairExecutors(r.from, r.to) }, `retry: ${SSE_RETRY_MS}\n`);
      try {
        const s = await router.search(r, { signal: ac.signal,
          onRoute: (route) => send('route', viewRoute(route)),
          onEvent: (e) => { if (e.type === 'provider') send('provider', { provider: e.provider, status: e.status, code: e.code ?? null, ms: e.ms }); } });
        record(randomUUID(), r, s.events);
        send('done', summary(s, r));
      } catch (e) { send('error', { code: (e as { code?: string }).code ?? 'internal', message: (e as Error).message.slice(0, 200) }); }
      reply.raw.end();
    } finally { if (beat) clearInterval(beat); release(); }
  });

  return runtimes; // v11: plan pricing uses these same runtimes (one token bucket and one circuit breaker per provider)
}
