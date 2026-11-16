// Quote engine (V11) — the entry point used by server.ts. READ-ONLY public market data: this module never places, signs or
// cancels anything, and imports neither the signer client nor a venue's trading object.
//
//   const quotes = await installQuotes(app, deps)   early: websocket plugin + credential re-check hook
//   quotes.routes(app)                              late: /api/v1/stream, /api/v1/trading/stream (+ /ticket), /api/v1/stream/stats
//   quotes.ticketGate(req, path)                    server.ts onRequest: the single-use stream ticket
//   quoteHub()                                      the process-wide hub: `hub.validate(ch)` then `hub.subscribe(ch, listener)` —
//                                                   the API another module (the agents' stream engine) can adopt instead of
//                                                   opening its own venue streams
import type { FastifyInstance } from 'fastify';
import { derivatives, type Derivatives } from '../derivatives/index.ts';
import { QuoteEngine, type StreamLimits } from './engine.ts';
import { QuoteHub, type HubOptions, type Upstream } from './hub.ts';
import { hyperliquidUpstream, spotUpstream, venueUpstream, type SpotPrices } from './upstreams.ts';

export interface QuotesDeps {
  derivatives?: Derivatives | undefined; /** the wallet's price module (server.ts `markets`) */ prices?: SpotPrices | undefined;
  /** tests: scripted upstreams instead of the venues */ upstreams?: Upstream[]; hub?: Partial<Omit<HubOptions, 'upstreams'>>; limits?: Partial<StreamLimits>;
  sessionAlive?: (token: string | undefined) => Promise<boolean>; keyActive?: (id: string) => Promise<boolean>;
}

/** one upstream per venue of the derivatives registry, plus spot. Nothing is connected until a channel is subscribed. */
export function defaultUpstreams(d: Derivatives, prices?: SpotPrices): Upstream[] {
  const out: Upstream[] = [];
  for (const e of d.registry.list()) {
    if (e.id === 'hyperliquid') out.push(hyperliquidUpstream({ data: d.data, now: d.data.now, ...(e.adapter.builder ? { builderCoins: () => e.adapter.builder!.assetIds() } : {}) }));
    else out.push(venueUpstream({ venue: e.id, data: d.data }));
  }
  out.push(spotUpstream(prices ? { prices } : {}));
  return out;
}

let current: QuoteEngine | null = null;
export async function installQuotes(app: FastifyInstance, deps: QuotesDeps = {}): Promise<QuoteEngine> {
  const log = (ev: Record<string, unknown>): void => { try { if (ev.status === 'down') app.log.warn(ev); else app.log.info(ev); } catch { /* logging must not break the hub */ } };
  const hub = new QuoteHub({ upstreams: deps.upstreams ?? defaultUpstreams(deps.derivatives ?? derivatives(), deps.prices), log, ...deps.hub });
  const engine = new QuoteEngine({ hub, ...(deps.limits ? { limits: deps.limits } : {}), ...(deps.sessionAlive ? { sessionAlive: deps.sessionAlive } : {}), ...(deps.keyActive ? { keyActive: deps.keyActive } : {}) });
  await engine.install(app);
  current = engine;
  return engine;
}
/** the engine of the server built last in this process (tests, diagnostics) */
export const currentQuoteEngine = (): QuoteEngine | null => current;
/** the hub of this process (null before the server is built) */
export const quoteHub = (): QuoteHub | null => current?.hub ?? null;
/** compact figures for the monitor screen (null before the server is built) */
export const quoteSummary = (): ReturnType<QuoteEngine['summary']> | null => current?.summary() ?? null;

export { QuoteEngine, defaultLimits, STREAM_PATH, TRADING_STREAM_PATH, TICKET_PATH, STATS_PATH, type StreamLimits } from './engine.ts';
export { QuoteHub, QuoteError, type Upstream, type UpstreamSink, type FeedSpec, type Frame, type Subscription } from './hub.ts';
export { hyperliquidUpstream, venueUpstream, spotUpstream, type SpotPrices } from './upstreams.ts';
