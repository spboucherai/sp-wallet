// Derivatives module (wave 2: read-only and paper) — public surface for the rest of the API service.
// No live trading here: no signing, no signer call, no request to a venue's trading endpoint. Controlled live trading is a
// separate part with its own venue objects: exec.ts, live.ts, live-venue.ts, live-routes.ts.
import { DerivData } from './data.ts';
import { PaperService } from './paper.ts';
import { createDefaultRegistry, type VenueRegistry } from './venues.ts';
// --- router (simulation) ---
import type { ChainCostsReader } from './chain-costs.ts';
import { RouteService, type LivePort } from './route.ts';
// --- /router ---

export interface Derivatives { registry: VenueRegistry; data: DerivData; paper: PaperService; /** venue comparison in simulation (route.ts); absent on hand-built instances */ router?: RouteService }

/** the parts wired together; tests pass a registry of fixture-backed adapters and a clock (and, for the router, a chain reader and a live port) */
export function createDerivatives(o: { registry?: VenueRegistry; now?: () => number; chain?: ChainCostsReader; live?: LivePort | null; gmx?: import('./route.ts').GmxPort | null } = {}): Derivatives {
  const now = o.now ?? Date.now, registry = o.registry ?? createDefaultRegistry({ now });
  const data = new DerivData(registry, { now }), paper = new PaperService(data, now);
  return { registry, data, paper, router: new RouteService({ data, paper, ...(o.chain ? { chain: o.chain } : {}), live: o.live ?? null, gmx: o.gmx ?? null }) };
}

let shared: Derivatives | null = null;
/**
 * the process-wide instance on the real adapters (routes and worker share its caches and its rate-limit budget).
 * The router asks the live service only for its account list and its `preview`; it is imported on first use so that this
 * module does not load the signer client.
 */
export function derivatives(): Derivatives {
  const live: LivePort = {
    list: async () => (await import('./live.ts')).live().list(),
    preview: async (id, body) => (await import('./live.ts')).live().preview(id, body),
  };
  // v8: the router asks the GMX engine whether the wallet can create GMX orders now (imported on first use, like the live service)
  const gmx = { tradability: async () => (await import('./gmx-live.ts')).gmx().tradability() };
  return (shared ??= createDerivatives({ live, gmx }));
}

export { DerivData, DATA_BOUNDS } from './data.ts';
export { PaperService, defaultPolicy } from './paper.ts';
export { RouteService, type LivePort, type RouteAnswer } from './route.ts';
export { createChainCostsReader, type ChainCostsReader } from './chain-costs.ts';
export { createDefaultRegistry, createRegistry, VenueRegistry, DYDX_RESTRICTION } from './venues.ts';
