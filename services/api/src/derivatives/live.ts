/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/derivatives/live.ts
 * Module           : derivatives
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
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

// Controlled live trading — wiring for the rest of the API service: the process-wide execution engine on the real signer
// client and the real venue, and its reconciliation worker. Disabled by construction: an account trades only after the owner's
// passkey approved a venue authorization on the signer, and mainnet additionally needs SPW_DERIV_LIVE_MAINNET=on.
import { listCreds, verifyOwnerAssertion } from '../auth.ts';
import { config } from '../config.ts';
import { signer } from '../signer-client.ts';
import { loop } from '../worker.ts';
import { LiveService, LIVE_STEP_MS, type LiveDeps } from './exec.ts';
import { LiveVenues } from './live-venue.ts';

/** server setting, read at every use: anything but the exact value `on` keeps the mainnet exchange endpoint closed */
export const mainnetLiveEnabled = (): boolean => process.env.SPW_DERIV_LIVE_MAINNET === 'on';

/** second, separate server setting for AUTONOMOUS (mandate) trading on mainnet: it needs this AND SPW_DERIV_LIVE_MAINNET, both exactly `on` */
export const mandateMainnetEnabled = (): boolean => process.env.SPW_DERIV_MANDATE_MAINNET === 'on';

/** tests pass a fake venue (`fetch`), an in-process signer and a clock */
export function createLive(o: Partial<LiveDeps> & { fetch?: typeof fetch } = {}): LiveService {
  const now = o.now ?? Date.now, mainnetEnabled = o.mainnetEnabled ?? mainnetLiveEnabled;
  return new LiveService({
    venues: o.venues ?? new LiveVenues({ now, mainnetEnabled, ...(o.fetch ? { fetch: o.fetch } : {}) }),
    signer: o.signer ?? signer, now, rpId: o.rpId ?? config.rpId, mainnetEnabled,
    // derivative mandates: the real signer client offers them; a test that injects its own signer port says so explicitly
    ...(o.mandateSigner ? { mandateSigner: o.mandateSigner } : o.signer ? {} : { mandateSigner: signer }), mandateMainnetEnabled: o.mandateMainnetEnabled ?? mandateMainnetEnabled,
    credentials: o.credentials ?? (async () => (await listCreds()).map((c) => ({ id: c.id, transports: c.transports }))),
    ...(o.confirmDelayMs !== undefined ? { confirmDelayMs: o.confirmDelayMs } : {}),
    // V11: loosening an API-side limit or lifting a halt needs a passkey assertion; a test that injects its own signer port injects its own verifier
    ...(o.verifyOwner ? { verifyOwner: o.verifyOwner } : o.signer ? {} : { verifyOwner: verifyOwnerAssertion }),
  });
}

let shared: LiveService | null = null;
export function live(): LiveService { return (shared ??= createLive()); }

/** ONE reconciliation worker: orders in flight, fills, funding, positions, divergence. It never signs and never places anything. */
export function startLiveWorker(l: LiveService = live()): void {
  let lastError = '';
  loop('deriv-live', async () => {
    const s = await l.step();
    if (s.fills || s.funding || s.divergences) console.log(`[derivatives] live: ${s.accounts} account(s), ${s.reconciled} order(s) reconciled, ${s.fills} fill(s), ${s.funding} funding payment(s), ${s.divergences} divergence(s)`);
    const err = s.errors[0] ?? '';
    if (err && err !== lastError) console.log(`[derivatives] live: ${s.errors.length} error(s) (${err})`);
    lastError = err;
  }, LIVE_STEP_MS);
}
