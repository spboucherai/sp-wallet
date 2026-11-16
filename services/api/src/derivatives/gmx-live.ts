// GMX v2 trading (v8) — wiring for the rest of the API service: the process-wide engine on the real signer client, the
// registry RPC endpoints and the read adapter's market data, and its tracking worker. Disabled by construction: nothing is
// prepared unless SPW_DERIV_LIVE_MAINNET=on AND SPW_DERIV_GMX_LIVE=on, and the owner approved a venue policy with a passkey.
import { listCreds, verifyOwnerAssertion } from '../auth.ts';
import { config } from '../config.ts';
import { signer } from '../signer-client.ts';
import { loop } from '../worker.ts';
import { realGmxChain } from './gmx-chain.ts';
import { GmxService, GMX_STEP_MS, type GmxDeps, type GmxMarketPort } from './gmx-exec.ts';
import { derivatives } from './index.ts';
import { mainnetLiveEnabled } from './live.ts';

/** venue-specific server setting, read at every use: anything but the exact value `on` keeps GMX trading closed (default off) */
export const gmxLiveEnabled = (): boolean => process.env.SPW_DERIV_GMX_LIVE === 'on';

const realMarket = (): GmxMarketPort => ({
  market: async (instrument) => { const m = await derivatives().data.market(instrument); return { instrument: m.instrument, ticker: m.ticker, liquidity: m.liquidity }; },
  apiPositions: async (account) => (await derivatives().data.watch('gmx', account)).positions,
});

/** tests pass a scripted chain, an in-process signer, fixture market data and a clock */
export function createGmx(o: Partial<GmxDeps> = {}): GmxService {
  const now = o.now ?? Date.now;
  return new GmxService({ chain: o.chain ?? realGmxChain(now), signer: o.signer ?? signer, market: o.market ?? realMarket(), now, rpId: o.rpId ?? config.rpId,
    credentials: o.credentials ?? (async () => (await listCreds()).map((c) => ({ id: c.id, transports: c.transports }))),
    settings: o.settings ?? (() => ({ liveMainnet: mainnetLiveEnabled(), gmxLive: gmxLiveEnabled() })),
    ...(o.verifyOwner ? { verifyOwner: o.verifyOwner } : o.signer ? {} : { verifyOwner: verifyOwnerAssertion }) });
}

let shared: GmxService | null = null;
export function gmx(): GmxService { return (shared ??= createGmx()); }

/** ONE tracking worker: operations in flight (approval mined → order sent → created → executed / cancelled / frozen). It never signs. */
export function startGmxWorker(g: GmxService = gmx()): void {
  let last = '';
  loop('deriv-gmx', async () => {
    const s = await g.step();
    const err = s.errors[0] ?? '';
    if (err && err !== last) console.log(`[derivatives] gmx: ${s.errors.length} error(s) (${err})`);
    last = err;
  }, GMX_STEP_MS);
}
