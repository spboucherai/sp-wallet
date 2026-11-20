import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import { formatUnits, getNetwork, NETWORKS, normalizeAddress, type NetworkDef, type NetworkId } from '@spw/core';
import { authRoutes, credentialSets, currentSessionId, deviceRoutes, isAuthed, listCreds } from './auth.ts';
import { describeUa } from './alerts/rules.ts'; // NEXT: the coarse device label of a session (browser · system)
import { adapterFor } from './chains/index.ts';
import { http, rpcEndpointHealth } from './chains/rpc.ts';
import { createGecko, priceStamp } from './gecko.ts';
import { COINGECKO } from './prices/coingecko-ids.ts';
import { crossCheck, crossSummary, type CrossFields } from './prices/cross.ts'; // v11: two price sources, one rule
import { ASSET_MAP, apiBricks, apiBricksStatus } from './apibricks/index.ts'; // v11: the optional keyed second source (null without APIBRICKS_API_KEY)
import { config, secureCookies, UserError } from './config.ts';
import { audit, auditList, getSetting, setSetting, sql } from './db.ts';
import { marketDataRoutes } from './market/routes.ts';
import { derivativesRoutes } from './derivatives/routes.ts';
import type { Derivatives } from './derivatives/index.ts';
import { liveRoutes } from './derivatives/live-routes.ts';
import { collateralRoutes } from './derivatives/collateral-routes.ts';
import { gmxRoutes } from './derivatives/gmx-routes.ts'; // v8 GMX v2 trading
import type { LiveService } from './derivatives/exec.ts';
import { addressFor, signer } from './signer-client.ts';
import { swapRoutes } from './swap.ts';
import { swapExecRoutes } from './swap-exec.ts';
import { bridgeRoutes } from './bridge.ts';
import { xswapRoutes } from './xswap.ts';
import { agentRoutes } from './agents/routes.ts';
import { strategyRoutes } from './agents/strategies.ts';
import { perpAgentRoutes } from './agents/perp-routes.ts'; // v6 perp agents
import { runtimeRoutes } from './agents/runtime-routes.ts'; // v11 agent panel: templates, mode-scoped reads, start/pause/stop, jobs, kill switch
import { transferRoutes, view, type ProposalRow } from './transfers.ts';
import { healthCache } from './worker.ts';
import { alertRoutes } from './alerts/routes.ts';     // v6-alerts
import { registerExecution } from './orders/index.ts'; // v11 execution
import { dashboardRoutes } from './dashboard/index.ts'; // v11 interface: read-only aggregates for the Dashboard and Activity screens
import { registerMm } from './mm/register.ts'; // v11 live market making: the owner's routes /api/v1/mm
import { monitorRoutes } from './monitor/routes.ts'; // v6-alerts
import { researchRoutes, RUNNER_PREFIX, runnerGate } from './research/routes.ts'; // v7 research runtime
import { perpRuntime } from './agents/perp-live.ts'; // v7 research runtime (perp data for research jobs)
import { planRoutes, type PlanDeps } from './plan-exec.ts'; // v7 any-to-any plans
import { marketsHub } from './markets-hub/index.ts'; // v11 markets hub: universal explorer and venue comparator (read-only)
import { privateMarketsRoutes } from './private-markets/routes.ts'; // v11 private markets (read-only)
import { apiKeyGate, OWNER, tradingApi } from './trading-api/index.ts'; // v11 trading API (machine authentication)
import { installQuotes, type QuotesDeps } from './quotes/index.ts'; // v11 quote engine: websocket fan-out of public market data (read-only)
import { nativeClientRoutes } from './native-clients.ts'; // native apps: the passkey association file (/.well-known), nothing under /api
import { registerNft, type NftOptions } from './nft/index.ts'; // NFT delivery 1: read-only inventory, item pages, media proxy (owner session only)

const PUBLIC = new Set(['/api/v1/health/live', '/api/v1/auth/state', '/api/v1/auth/setup/options', '/api/v1/auth/setup/verify', '/api/v1/auth/login/options', '/api/v1/auth/login/verify', '/api/v1/auth/logout']);
// v11 quote engine: the browser opens ONE websocket to its own origin. CSP3 lets 'self' match the ws/wss scheme of the page's origin,
// but Safari up to 15.3 did not (WebKit bug 201591, closed as a duplicate of 235873): the same-origin websocket origin is named explicitly.
const CSP = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${config.origin.replace(/^http/, 'ws')}; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;

const NETS = Object.values(NETWORKS) as NetworkDef[];
/** What a proposal is in the activity feed: a native cross-chain swap is shown with the swaps; a GMX order transaction is its own kind. */
export const activityKind = (k: ProposalRow['kind'] | null | undefined): 'send' | 'swap' | 'bridge' | 'gmx' => (k === 'swap' || k === 'xswap' ? 'swap' : k === 'bridge' ? 'bridge' : k === 'gmx' ? 'gmx' : 'send');
/** The kind written in the CSV: the stored kind, with `send` for a plain transfer. */
export const csvKind = (k: ProposalRow['kind'] | null | undefined): string => (!k || k === 'transfer' ? 'send' : k);
/** What a swap or a cross-chain transfer delivered, when the chain said it (never the expected amount). */
export function csvOutcome(p: ProposalRow): { toNetwork: string; toSymbol: string; received: string } {
  if (p.kind === 'xswap' && p.xswap) return { toNetwork: p.xswap.toNetwork, toSymbol: p.xswap.toSymbol, received: p.xswap.received ? formatUnits(BigInt(p.xswap.received), p.xswap.toDecimals) : '' };
  if (p.kind === 'bridge' && p.bridge) return { toNetwork: p.bridge.toNetwork, toSymbol: p.symbol, received: p.bridge.phase === 'done' && p.out_amount ? formatUnits(BigInt(p.out_amount), p.decimals) : '' };
  if (p.kind === 'swap' && p.swap) return { toNetwork: p.network, toSymbol: p.swap.toSymbol, received: p.out_amount ? formatUnits(BigInt(p.out_amount), p.swap.toDecimals) : '' };
  return { toNetwork: '', toSymbol: '', received: '' };
}
const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ttlMs) return c.v as T;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}

/** v11: `priceAt` = when the source last updated THIS price (CoinGecko's own `last_updated`, else the time it was fetched); `stale` = served past its refresh window or older than PRICE_STALE_MS */
interface Market { priceAt: string | null; stale: boolean; usd: number; cad: number; change24h: number | null; change7d: number | null; marketCap: number | null; volume24h: number | null; high24h: number | null; low24h: number | null; ath: number | null; rank: number | null; spark: number[] }
// CoinGecko GET with stale-on-error and a short retry after a failure: gecko.ts (v10)
const gecko = createGecko((url, init) => http(url, init));
type GeckoRow = { id: string; last_updated?: string; current_price: number; price_change_percentage_24h_in_currency?: number; price_change_percentage_7d_in_currency?: number; market_cap?: number; total_volume?: number; high_24h?: number; low_24h?: number; ath?: number; market_cap_rank?: number; sparkline_in_7d?: { price: number[] } };
const thin = (a: number[], max: number) => (a.length <= max ? a : Array.from({ length: max }, (_, k) => a[Math.round((k * (a.length - 1)) / (max - 1))]!));
/** the primary source alone (CoinGecko), as before V11's second source */
async function geckoMarkets(): Promise<Record<string, Market> | null> {
  const ids = [...new Set(Object.values(COINGECKO))].join(',');
  const q = (cur: string) => gecko<GeckoRow[]>(`markets:${cur}`, PRICE_TTL_MS, `/coins/markets?vs_currency=${cur}&ids=${ids}&per_page=250&sparkline=${cur === 'usd'}&price_change_percentage=24h,7d`);
  const [usd, cad] = await Promise.all([q('usd'), q('cad')]);
  if (!usd || !cad) return null;
  // freshness (v11): the answer may be a stale-on-error value; each price also carries the source's own update time
  const mu = gecko.meta('markets:usd', PRICE_TTL_MS), mc = gecko.meta('markets:cad', PRICE_TTL_MS), now = Date.now();
  const fetched = mu.fetchedAt !== null && mc.fetchedAt !== null ? Math.min(mu.fetchedAt, mc.fetchedAt) : null, servedStale = mu.stale || mc.stale;
  const stamp = (u: GeckoRow, c: GeckoRow) => priceStamp([u.last_updated, c.last_updated], fetched, servedStale, now, PRICE_STALE_MS);
  const out: Record<string, Market> = {};
  for (const [sym, id] of Object.entries(COINGECKO)) {
    const u = usd.find((r) => r.id === id), c = cad.find((r) => r.id === id);
    if (!u || !c) continue;
    out[sym] = { ...stamp(u, c), usd: u.current_price, cad: c.current_price, change24h: u.price_change_percentage_24h_in_currency ?? null, change7d: u.price_change_percentage_7d_in_currency ?? null,
      marketCap: u.market_cap ?? null, volume24h: u.total_volume ?? null, high24h: u.high_24h ?? null, low24h: u.low_24h ?? null, ath: u.ath ?? null, rank: u.market_cap_rank ?? null,
      spark: thin(u.sparkline_in_7d?.price ?? [], 42) };
  }
  return out;
}
/**
 * v11: every price names its `source`. With APIBRICKS_API_KEY the second source is read too (cached, metered): the displayed
 * price stays CoinGecko's unless it is missing or stale — then the second one is shown, labelled (`fallback`) — and two fresh
 * prices of similar dates are compared (`divergent`), never averaged (prices/cross.ts). Without the key: CoinGecko, as before.
 */
type PricedMarket = Market & CrossFields;
const blankMarket = (s: { usd: number; cad: number | null; priceAt: string }): Market | null => (s.cad === null ? null
  : { priceAt: s.priceAt, stale: false, usd: s.usd, cad: s.cad, change24h: null, change7d: null, marketCap: null, volume24h: null, high24h: null, low24h: null, ath: null, rank: null, spark: [] });
async function markets(): Promise<Record<string, PricedMarket> | null> {
  if (!(await getSetting('prices', true))) return null;
  const primary = await geckoMarkets(), ab = apiBricks();
  if (!ab) return crossCheck(primary, null, { thresholdBps: 0 }, () => null);
  // the primary is down, or serves an old price for a symbol the second source has: ask the second one for a fresher read
  const failover = !primary || Object.entries(primary).some(([sym, m]) => m.stale && Object.hasOwn(ASSET_MAP, sym));
  const second = await ab.prices.read(failover ? { maxAgeMs: ab.cfg.failoverTtlMs } : {}).catch(() => null);
  return crossCheck(primary, second?.prices ?? null, { thresholdBps: ab.cfg.divergenceBps }, (_sym, s2) => blankMarket(s2));
}
async function prices(): Promise<Record<string, PricedMarket> | null> { return markets(); }
/** Refresh window of the price list, and the age past which a price is flagged even when the list itself is fresh. */
const PRICE_TTL_MS = 4 * 60_000, PRICE_STALE_MS = 15 * 60_000;

// v11 resilience: the wallet's addresses as last given by the signer. Home, Assets and Receive are built from them when the signer
// node is unreachable (balances come from the API's own chain reads); nothing can be signed meanwhile and the answer says so.
let knownAddresses: { keyId: string; addresses: Record<string, string>; at: string } | null = null;
async function rememberAddresses(st: { keyId: string; addresses: Record<string, string> }): Promise<void> {
  if (knownAddresses && knownAddresses.keyId === st.keyId && JSON.stringify(knownAddresses.addresses) === JSON.stringify(st.addresses)) { knownAddresses.at = new Date().toISOString(); return; }
  knownAddresses = { keyId: st.keyId, addresses: st.addresses, at: new Date().toISOString() };
  await setSetting('signerAddresses', knownAddresses).catch(() => {});
}
/** The signer's status, or — when it cannot be reached — the last addresses it gave (memory, then the settings table). */
async function walletAddresses(): Promise<{ st: Awaited<ReturnType<typeof signer.status>> | null; keyId: string; addresses: Record<string, string>; addressesAsOf: string }> {
  try { const st = await signer.status(); await rememberAddresses(st); return { st, keyId: st.keyId, addresses: st.addresses, addressesAsOf: knownAddresses!.at }; }
  catch (e) {
    if ((e as UserError).code !== 'signer_unreachable') throw e;
    knownAddresses ??= await getSetting<typeof knownAddresses>('signerAddresses', null);
    if (!knownAddresses) throw e; // never seen: there is nothing honest to show
    return { st: null, keyId: knownAddresses.keyId, addresses: knownAddresses.addresses, addressesAsOf: knownAddresses.at };
  }
}

export async function buildServer(opts: { swapProviders?: import('@spw/swap').SwapProvider[]; derivatives?: Derivatives; live?: LiveService; collateral?: import('./derivatives/collateral.ts').CollateralService; gmx?: import('./derivatives/gmx-exec.ts').GmxService; plan?: Partial<PlanDeps>; /** v11 quote engine: scripted upstreams and limits (tests) */ quotes?: QuotesDeps; /** NFT: scripted sources (tests) */ nft?: NftOptions } = {}): Promise<FastifyInstance> {
  const swapProviders = opts.swapProviders;
  const app = Fastify({ logger: { level: 'warn', redact: ['req.headers.cookie', 'req.headers.authorization'] }, bodyLimit: 64 * 1024, trustProxy: config.trustProxy });
  await app.register(cookie);
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });
  const quotes = await installQuotes(app, { derivatives: opts.derivatives, prices: markets, second: apiBricks()?.second, metered: () => ({ apibricks: apiBricksStatus() }), ...opts.quotes }); // v11 quote engine: the websocket plugin, before the routes

  app.addHook('onRequest', async (req, reply) => {
    reply.header('content-security-policy', CSP).header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer')
      .header('x-frame-options', 'DENY').header('x-robots-tag', 'noindex, nofollow, noarchive')
      .header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=(self), publickey-credentials-create=(self)')
      .header('cross-origin-opener-policy', 'same-origin').header('cross-origin-resource-policy', 'same-origin');
    if (secureCookies) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/api/')) return;
    reply.header('cache-control', 'no-store');
    // >>> v7 research runtime: the runner's endpoints carry their own shared secret — no owner session, no cookie, no CSRF header;
    // that secret opens these paths and no other, and the owner session does not open them
    // >>> v11 trading API: `Authorization: Bearer spw_live_…` is an API key — accepted under /api/v1/trading/ only, never with a
    // cookie, and exempt from the CSRF check below because it carries no ambient credential (trading-api/principal.ts)
    if (quotes.ticketGate(req, path)) return; // v11 quote engine: a single-use stream ticket is the credential of that one upgrade request
    if (await apiKeyGate(req, reply, path)) return;
    // <<< v11 trading API
    if (path.startsWith(RUNNER_PREFIX)) { runnerGate(req); return; }
    // <<< v7 research runtime
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // CSRF: strict same-origin + custom header (cannot be set cross-site without CORS, which is never enabled)
      if (req.headers.origin !== config.origin || req.headers['x-spw-csrf'] !== '1') throw new UserError('csrf', 'cross-site request refused', 403);
    }
    if (PUBLIC.has(path)) return;
    if (!(await isAuthed(req))) throw new UserError('unauthenticated', 'authentication required', 401);
    req.principal = OWNER; // v11: the owner session is a principal like the others (scope guard, audit actor)
  });

  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number };
    // `data` (v11): machine-readable detail of a refusal — e.g. the fresh quote of `quote_moved` (prepare-common.ts)
    if (e instanceof UserError) return reply.status(e.status).send({ error: e.code, message: e.message, ...((e as { data?: unknown }).data !== undefined ? { data: (e as { data?: unknown }).data } : {}) });
    if (e instanceof ZodError) return reply.status(400).send({ error: 'bad_request', message: 'invalid request' });
    if (e.statusCode === 429) return reply.status(429).send({ error: 'rate_limited', message: 'too many requests' });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: 'bad_request', message: 'invalid request' });
    req.log.error({ msg: e.message, path: req.url.split('?')[0] });
    return reply.status(500).send({ error: 'internal', message: 'internal error' });
  });

  authRoutes(app);
  deviceRoutes(app);
  transferRoutes(app);
  const swapRuntimes = swapRoutes(app, { providers: swapProviders, prices: markets });
  swapExecRoutes(app);
  bridgeRoutes(app);
  xswapRoutes(app);
  planRoutes(app, { prices: markets, runtimes: swapRuntimes, ...opts.plan }); // v7 any-to-any plans: a saga over the routes above; signs nothing itself
  agentRoutes(app, { prices: markets });
  strategyRoutes(app);
  runtimeRoutes(app); // v11 agent panel (registered before the :id routes of the same family is not needed: static segments win)
  perpAgentRoutes(app, opts.derivatives, opts.live); // v6 perp agents on paper accounts; v7: LIVE on a venue account under a signer-enforced mandate
  marketDataRoutes(app);
  derivativesRoutes(app, opts.derivatives);
  privateMarketsRoutes(app, opts.derivatives); // v11: synthetic contracts on private companies — market data and sourced valuations, display only
  liveRoutes(app, opts.live); // controlled live trading: nothing trades until the owner authorizes a venue account with his passkey
  collateralRoutes(app, opts.collateral); // deposit to / withdraw from a venue account: passkey per operation, pinned bridge, own address only
  gmxRoutes(app, opts.gmx); // v8: GMX v2 orders as wallet transactions; off unless SPW_DERIV_GMX_LIVE=on and the owner approved a venue policy
  await alertRoutes(app); // v6-alerts: in-app alerts, push subscriptions, webhook — all behind the owner session
  monitorRoutes(app);     // v6-alerts: read-only monitoring dashboard
  await researchRoutes(app, { perp: () => perpRuntime().lab }); // v7 research runtime: jobs for the owner, a narrow endpoint pair for the runner
  marketsHub(app, { derivatives: opts.derivatives }); // v11: /api/v1/markets-hub — explorer over spot and the four venues' perps, venue comparator; read-only public market data
  const execution = registerExecution(app, { derivatives: opts.derivatives, live: opts.live, gmx: opts.gmx, prices: markets }); // v11 execution: unified orders, independent risk engine, trading mandates (owner routes /api/v1/risk, /api/v1/mandates)
  registerMm(app, execution); // v11 live market making (owner only): sessions, fills, performance, pull / flatten, the go-live checklist
  await tradingApi(app, { derivatives: opts.derivatives, live: opts.live, gmx: opts.gmx, prices: markets, execution }); // v11: /api/v1/trading (scoped API keys or the owner) and /api/v1/developer (owner only)
  dashboardRoutes(app, { execution }); // v11 interface: /api/v1/dashboard — read-only aggregates composed from the services above (owner session only)
  registerNft(app, { ...opts.nft, prices: opts.nft?.prices ?? markets }); // NFT: /api/v1/nfts — inventory, transfers (delivery 2), market READ (delivery 3; no market write). `prices`: fiat rates of market amounts, with their source and date
  quotes.routes(app); // v11 quote engine: /api/v1/stream (owner session + Origin), /api/v1/trading/stream (API key or ticket, markets:read), /api/v1/stream/stats

  nativeClientRoutes(app); // /.well-known/apple-app-site-association (404 unless SPW_APPLE_APP_IDS names an app)

  app.get('/api/v1/health/live', async () => ({ ok: true }));
  app.get('/api/v1/health/ready', async () => {
    const db = await sql`select 1`.then(() => true, () => false);
    const s = await signer.status().then((x) => ({ ok: true, halted: x.halted }), () => ({ ok: false, halted: null }));
    return { db, signer: s, networks: [...healthCache.values()], rpcEndpoints: rpcEndpointHealth() };
  });

  const liveTokens = (n: NetworkDef) => { const off = new Set(adapterFor(n.id).disabledAssets?.() ?? []); return n.tokens.filter((t) => !off.has(t.id)); };
  app.get('/api/v1/networks', async () => NETS.map((n) => ({
    id: n.id, name: n.name, family: n.family, chainRef: n.chainRef, native: n.native, tokens: liveTokens(n), memo: n.memo ?? null, activation: n.activation ?? null, explorerAddr: n.explorerAddr, minConf: n.minConf,
    health: healthCache.get(n.id) ?? null })));
  app.get('/api/v1/assets', async (req) => {
    const q = z.object({ network: z.string().optional() }).parse(req.query);
    return NETS.filter((n) => !q.network || n.id === q.network).flatMap((n) => [n.native, ...liveTokens(n)].map((a) => ({ network: n.id, ...a })));
  });

  // One vault, one signer-derived address per chain family. Addresses come from the signer, never from the client.
  app.get('/api/v1/accounts', async () => {
    const w = await walletAddresses();
    return { keyId: w.keyId, signerReachable: !!w.st, addressesAsOf: w.addressesAsOf, accounts: NETS.filter((n) => w.addresses[n.id]).map((n) => ({ network: n.id, name: n.name, family: n.family, address: w.addresses[n.id]!, explorer: n.explorerAddr + w.addresses[n.id] })) };
  });

  app.get('/api/v1/portfolio', async () => {
    const w = await walletAddresses(), st = w.st;
    const px = await prices();
    const rows = await Promise.all(NETS.filter((n) => w.addresses[n.id]).map(async (n) => {
      const address = w.addresses[n.id]!;
      try {
        const b = await cached(`bal:${n.id}`, 12_000, () => adapterFor(n.id).balances(address));
        return [n.native, ...liveTokens(n)].map((a) => (b[a.id] === undefined
          ? { network: n.id, networkName: n.name, asset: a.id, symbol: a.symbol, name: a.name, decimals: a.decimals, amount: null, display: null, error: 'unavailable' as string | null }
          : { network: n.id, networkName: n.name, asset: a.id, symbol: a.symbol, name: a.name, decimals: a.decimals,
              amount: b[a.id]!.toString(), display: formatUnits(b[a.id]!, a.decimals), error: null as string | null }));
      } catch {
        return [n.native, ...liveTokens(n)].map((a) => ({ network: n.id, networkName: n.name, asset: a.id, symbol: a.symbol, name: a.name, decimals: a.decimals, amount: null, display: null, error: 'unavailable' }));
      }
    }));
    const pending = await sql<ProposalRow[]>`select * from proposals where state in ('pending_approval','approved','signed','broadcast','confirming','reorged') order by created_at desc`;
    // v11: `asOf` is the time of this answer; the prices have their own dates (`prices[sym].priceAt`, `pricesAsOf` = the oldest one)
    const stamps = px ? Object.values(px).map((m) => m.priceAt).filter((x): x is string => !!x).sort() : [];
    // v11: `priceSource` = where the displayed prices come from (`mixed` when some fell back to the second source); `priceSources` says which
    const cs = crossSummary(px, apiBricks() !== null), all = px ? Object.keys(px).length : 0;
    return { asOf: new Date().toISOString(), prices: px, priceSource: !px ? null : cs.fallback.length === 0 ? 'coingecko' : cs.fallback.length === all ? 'apibricks' : 'mixed', priceSources: px ? cs : null, pricesAsOf: stamps[0] ?? null, pricesStale: px ? Object.values(px).some((m) => m.stale) : false,
      balances: rows.flat(), pending: pending.map(view), halted: st ? st.halted : null,
      // the signer could not be reached: balances are the API's own reads of the last known addresses; nothing can be signed meanwhile
      signer: { reachable: !!st, addressesAsOf: w.addressesAsOf } };
  });

  // price history for one asset (chart). `symbol` must be in the pinned map; nothing about the wallet is sent upstream.
  app.get('/api/v1/market/:symbol', async (req) => {
    const symbol = (req.params as { symbol: string }).symbol;
    const q = z.object({ days: z.enum(['1', '7', '30', '365']).default('7'), currency: z.enum(['usd', 'cad']).default('cad') }).parse(req.query);
    const id = COINGECKO[symbol];
    if (!id || !(await getSetting('prices', true))) return { symbol, points: [], market: null };
    const ttl = q.days === '1' ? 5 * 60_000 : q.days === '7' ? 20 * 60_000 : 60 * 60_000;
    const j = await gecko<{ prices: [number, number][] }>(`chart:${id}:${q.currency}:${q.days}`, ttl, `/coins/${id}/market_chart?vs_currency=${q.currency}&days=${q.days}`);
    const pts = j?.prices ?? [];
    const step = Math.max(1, Math.ceil(pts.length / 240));
    const points = pts.filter((_, k) => k % step === 0 || k === pts.length - 1).map(([t, p]) => ({ t, p }));
    return { symbol, currency: q.currency, days: q.days, points, market: (await markets())?.[symbol] ?? null };
  });

  app.get('/api/v1/activity', async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const out = await sql<ProposalRow[]>`select * from proposals where state <> 'draft' order by created_at desc limit ${q.limit}`;
    const dep = await sql<{ network: string; txid: string; idx: number; asset: string; amount: string; from_addr: string; block: string; block_time: Date | null; seen_at: Date; finalized: string | null }[]>`
      select d.*, c.finalized from deposits d left join scan_cursor c on c.network = d.network order by coalesce(d.block_time, d.seen_at) desc limit ${q.limit}`;
    const items = [
      // `kind` is what the row IS (v11): a GMX order transaction is `gmx`, not a send to the GMX router; `rawKind` keeps the stored kind (xswap vs swap)
      ...out.map((p) => ({ ...view(p), kind: activityKind(p.kind), rawKind: p.kind ?? 'transfer', at: p.created_at })),
      ...dep.map((d) => {
        const n = getNetwork(d.network), a = d.asset === 'native' ? n.native : n.tokens.find((t) => t.id === d.asset)!;
        return { kind: 'receive' as const, at: d.block_time ?? d.seen_at, id: `${d.network}:${d.txid}:${d.idx}`, network: d.network, networkName: n.name, asset: d.asset, symbol: a.symbol,
          decimals: a.decimals, amount: d.amount, amountDisplay: formatUnits(BigInt(d.amount), a.decimals), from: d.from_addr, txid: d.txid, explorer: n.explorerTx + d.txid,
          state: Number(d.block) <= Number(d.finalized ?? 0) ? 'finalized' : 'confirming' };
      }),
    ].sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime()).slice(0, q.limit);
    return { items };
  });

  app.get('/api/v1/export/activity.csv', async (_req, reply) => {
    const out = await sql<ProposalRow[]>`select * from proposals where state <> 'draft' order by created_at`;
    const dep = await sql`select * from deposits order by seen_at`;
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
    // v11: `direction` is the real kind of the row (send | swap | bridge | xswap | gmx | receive) and three columns say what a swap or a
    // cross-chain transfer delivered; they are appended, so the positions of the earlier columns do not change
    const lines = ['time_utc,direction,network,symbol,amount_base_units,amount,counterparty,state,txid,fee_estimate_base_units,to_network,to_symbol,received'];
    for (const p of out) { const o = csvOutcome(p);
      lines.push([p.created_at.toISOString(), csvKind(p.kind), p.network, p.symbol, p.amount, formatUnits(BigInt(p.amount), p.decimals), p.to_addr, p.state, p.txid, p.fee_estimate, o.toNetwork, o.toSymbol, o.received].map(esc).join(',')); }
    for (const d of dep) { const n = getNetwork(d.network), a = d.asset === 'native' ? n.native : n.tokens.find((t) => t.id === d.asset)!;
      lines.push([(d.block_time ?? d.seen_at).toISOString(), 'receive', d.network, a.symbol, d.amount, formatUnits(BigInt(d.amount), a.decimals), d.from_addr, 'confirmed', d.txid, '', '', '', ''].map(esc).join(',')); }
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="sp-wallet-activity.csv"').send(lines.join('\n') + '\n');
  });

  app.get('/api/v1/addressbook', async () => sql`select id, network, address, label, created_at from address_book order by label`);
  app.post('/api/v1/addressbook', async (req) => {
    const b = z.strictObject({ network: z.string().max(20), address: z.string().max(110), label: z.string().min(1).max(40) }).parse(req.body);
    let address: string;
    try { address = normalizeAddress(getNetwork(b.network).id, b.address); } catch (e) { throw new UserError('bad_address', (e as Error).message); }
    const [r] = await sql`insert into address_book (id, network, address, label) values (${crypto.randomUUID()}, ${b.network}, ${address}, ${b.label})
      on conflict (network, address) do update set label = excluded.label returning id, network, address, label`;
    await audit('addressbook.saved', 'owner', { network: b.network, address, label: b.label });
    return r;
  });
  app.delete('/api/v1/addressbook/:id', async (req) => {
    const id = z.uuid().parse((req.params as { id: string }).id);
    const [r] = await sql`delete from address_book where id = ${id} returning network, address`;
    if (r) await audit('addressbook.removed', 'owner', { network: r.network, address: r.address });
    return { ok: true };
  });

  const Settings = z.strictObject({ locale: z.enum(['fr', 'en']), currency: z.enum(['USD', 'CAD']), hideBalances: z.boolean(), prices: z.boolean() });
  const readSettings = async () => ({ locale: await getSetting('locale', 'fr'), currency: await getSetting('currency', 'CAD'), hideBalances: await getSetting('hideBalances', false), prices: await getSetting('prices', true) });
  app.get('/api/v1/settings', readSettings);
  app.put('/api/v1/settings', async (req) => {
    const b = Settings.partial().parse(req.body);
    for (const [k, v] of Object.entries(b)) await setSetting(k, v);
    return readSettings();
  });

  // NEXT — additive: every field that existed keeps its name, type and meaning (the native apps 1.0 decode this answer).
  //   signer.recoveryExportedAt / recoveryVerifiedAt / credentialCooldownSec   what the signer says about its recovery phrase and its cool-down
  //   devices[].credentialId, .revocable, .inCooldown                          the full id (what the revoke routes take); can it be revoked now
  //   sessions[].id, .current, .device, .credential                            the session's PUBLIC id (never derived from its token); is it this one
  //   signerCredentials                                                        the SIGNER's list — the source of truth for who can approve (null: unreachable)
  //   mismatch                                                                 ids known to one side only (null: unreachable); currentSessionId
  app.get('/api/v1/security/overview', async (req) => {
    const st = await signer.status(true).catch(() => null);
    const { creds, mismatch } = await credentialSets(st);
    const pinned = (id: string) => st?.credentials.find((x) => x.id === id);
    const devices = creds.map((c) => ({ id: c.id.slice(0, 12), label: c.label, deviceType: c.device_type, backedUp: c.backed_up, createdAt: c.created_at, lastUsedAt: c.last_used_at,
      enrolledOnSigner: !!pinned(c.id), credentialId: c.id, inCooldown: !!pinned(c.id)?.inCooldown,
      // on the signer: as long as it is not the last one there; a row the signer does not list approves nothing and can always go
      revocable: !!st && (!pinned(c.id) || st.credentials.length > 1) }));
    const current = await currentSessionId(req);
    const sessions = (await sql<{ sid: string; created_at: Date; last_seen: Date; ua: string; ip: string; credential_id: string | null }[]>`
      select sid, created_at, last_seen, ua, ip, credential_id from sessions where not revoked and expires_at > now() order by last_seen desc limit 20`)
      .map((x) => ({ created_at: x.created_at, last_seen: x.last_seen, ua: x.ua, ip: x.ip, id: x.sid, current: x.sid === current, device: describeUa(x.ua), credential: x.credential_id?.slice(0, 12) ?? null }));
    return {
      signer: st ? { reachable: true, keyId: st.keyId, halted: st.halted, journalLength: st.journalLength, journalHead: st.journalHead, policy: st.policy, spentToday: st.spentToday,
        recoveryExportedAt: st.recoveryExportedAt ?? null, recoveryVerifiedAt: st.recoveryVerifiedAt ?? null, credentialCooldownSec: st.credentialCooldownSec ?? 0 } : { reachable: false },
      devices, sessions, origin: config.origin, broadcast: config.broadcast,
      signerCredentials: st ? st.credentials.map((c) => { const row = creds.find((x) => x.id === c.id);
        return { id: c.id, createdAt: c.createdAt ?? c.addedAt, lastUsedAt: c.lastUsedAt ?? null, inCooldown: !!c.inCooldown, cooldownUntil: c.cooldownUntil ?? null,
          known: !!row, label: row?.label ?? null, revocable: st.credentials.length > 1 }; }) : null,
      mismatch, currentSessionId: current,
    };
  });
  app.get('/api/v1/security/devices', async () => (await listCreds()).map((c) => ({ id: c.id.slice(0, 12), label: c.label, createdAt: c.created_at, lastUsedAt: c.last_used_at })));
  app.post('/api/v1/security/emergency-halt', async (req) => {
    await signer.halt(); // one-way from the app: re-enabling requires the CLI on the signer machine
    await audit('halt.on', 'owner', { ip: req.ip });
    return { ok: true, halted: true };
  });
  app.get('/api/v1/security/audit', async (req) => auditList(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query).limit));
  // NEXT — the last sign-ins, from the audit chain (`login.ok`): time, passkey, address, a coarse device label, and whether that
  // device had ever opened a session before. Fields a record written before NEXT does not carry are null.
  app.get('/api/v1/security/logins', async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(20) }).parse(req.query);
    const rows = await sql<{ seq: number; ts: Date; data: Record<string, unknown> }[]>`select seq::int as seq, ts, data from audit_events where type = 'login.ok' order by seq desc limit ${q.limit}`;
    const labels = new Map((await listCreds()).map((c) => [c.id.slice(0, 12), c.label]));
    const text = (v: unknown) => (typeof v === 'string' ? v : null);
    return { logins: rows.map((r) => ({ seq: r.seq, at: r.ts, credential: text(r.data.credential), label: text(r.data.label) ?? labels.get(String(r.data.credential)) ?? null,
      ip: text(r.data.ip), device: text(r.data.device), newDevice: typeof r.data.newDevice === 'boolean' ? r.data.newDevice : null, session: text(r.data.session) })) };
  });

  if (config.webDir && existsSync(join(config.webDir, 'index.html'))) {
    // wildcard serving: files are resolved per request, so a rebuilt bundle is served without restarting the API
    await app.register(fastifyStatic, { root: config.webDir, cacheControl: false,
      setHeaders: (res, path) => { res.header('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'); } });
    app.setNotFoundHandler((req, reply) => {
      // never answer a missing script/style with the HTML shell (that is what produced a blank page)
      if (req.url.startsWith('/api/') || req.url.startsWith('/assets/') || /\.[a-z0-9]{2,5}(\?|$)/i.test(req.url) || req.method !== 'GET') return reply.status(404).send({ error: 'not_found', message: 'not found' });
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    });
  }
  return app;
}
export type { NetworkId };
