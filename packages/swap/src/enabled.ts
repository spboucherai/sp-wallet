// Which adapters actually run. The registry (providers/index.ts) lists every adapter that exists; this file applies the
// owner's terms-of-use decisions on top, so that an adapter being present in the code never means it is being used.
import { createProviders, type ProviderEnv } from './providers/index.ts';
import type { SwapProvider } from './types.ts';

/**
 * Off unless explicitly enabled:
 *  - debridge: its API licence (SDK & API License Agreement, 1 Oct 2025) says "The APIs shall not be used for aggregation
 *    purposes". A multi-provider router is arguably that. Enable only after the owner has reviewed it or obtained approval
 *    (SPW_SWAP_ENABLE=debridge).
 */
const OFF_BY_DEFAULT = new Set(['debridge']);
const POLICY: Record<string, SwapProvider['policy']> = {
  // keyless LI.FI allows 75 route requests per 2 hours per IP: spend them slowly; a key lifts this (LIFI_API_KEY)
  lifi: { ratePerSec: 0.01, burst: 6, timeoutMs: 3500, scarce: true },
  debridge: { timeoutMs: 4500 },
  // the only keyless THORNode gateway answers in 2–5 s and is sometimes stale: give it time rather than report a timeout
  thorchain: { timeoutMs: 6500, ratePerSec: 0.5, burst: 4 },
  // v11, keyed comparison sources: the documentation states no figure for the free tiers (they are shown in each provider's dashboard).
  // One request per second is a deliberately low default; raise it only after reading the plan's real limit.
  zerox: { ratePerSec: 1, burst: 2, timeoutMs: 3000 },
  oneinch: { ratePerSec: 1, burst: 2, timeoutMs: 3000 },
};
export function createEnabledProviders(env: ProviderEnv = {}): SwapProvider[] {
  const on = new Set((env.SPW_SWAP_ENABLE ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const off = new Set((env.SPW_SWAP_DISABLE ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  return createProviders(env).filter((p) => !off.has(p.id) && (!OFF_BY_DEFAULT.has(p.id) || on.has(p.id)))
    .map((p) => { const extra = p.id === 'lifi' && env.LIFI_API_KEY ? undefined : POLICY[p.id]; return extra ? Object.assign(p, { policy: { ...extra, ...p.policy } }) : p; });
}
