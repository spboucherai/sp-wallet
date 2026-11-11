// Derivatives module (wave 2: read-only and paper) — public surface for the rest of the API service.
// No live trading here: no signing, no signer call, no request to a venue's trading endpoint.
import { DerivData } from './data.ts';
import { PaperService } from './paper.ts';
import { createDefaultRegistry, type VenueRegistry } from './venues.ts';

export interface Derivatives { registry: VenueRegistry; data: DerivData; paper: PaperService }

/** the three parts wired together; tests pass a registry of fixture-backed adapters and a clock */
export function createDerivatives(o: { registry?: VenueRegistry; now?: () => number } = {}): Derivatives {
  const now = o.now ?? Date.now, registry = o.registry ?? createDefaultRegistry({ now });
  const data = new DerivData(registry, { now });
  return { registry, data, paper: new PaperService(data, now) };
}

let shared: Derivatives | null = null;
/** the process-wide instance on the real adapters (routes and worker share its caches and its rate-limit budget) */
export function derivatives(): Derivatives { return (shared ??= createDerivatives()); }

export { DerivData, DATA_BOUNDS } from './data.ts';
export { PaperService, defaultPolicy } from './paper.ts';
export { createDefaultRegistry, createRegistry, VenueRegistry, DYDX_RESTRICTION } from './venues.ts';
