/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/derivatives/gmx-live.ts
 * Module           : derivatives
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-15
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

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
