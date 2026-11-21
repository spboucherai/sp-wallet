/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/isolated-signer/src/vaults.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// The signer's own view of THORChain's vault set, used for native cross-chain swaps (packages/core/src/thorchain.ts).
// A THORChain swap pays an Asgard vault whose address only the network's nodes can name. The API proposes one; before signing,
// the signer asks several independently operated THORNodes ITSELF — its own compiled-in list, over TLS, nothing passing
// through the API — and signs only if every operator that answers confirms the vault (checkThorVault). A compromised API
// therefore cannot substitute its own address. Any doubt — too few answers, one dissenting, a halted chain — means no signature.
// Nothing is cached: every signature is checked against the operators' current state.
import { checkThorVault, fetchThorViews, THORNODE_OPERATORS, type ThorGet, type ThorVaultVerdict, type ThorVaultWant } from '@spw/core';

export interface VaultView { /** throws unless the vault is confirmed */ check(want: ThorVaultWant): Promise<ThorVaultVerdict> }

const TIMEOUT_MS = 7000, MAX_BYTES = 400_000;
const json: ThorGet = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'vault-check', 'x-client-id': 'vault-check' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const t = await r.text();
  if (t.length > MAX_BYTES) throw new Error('response too large');
  return JSON.parse(t);
};
/** Hosts this view contacts (documented in docs/swap/providers/thorchain.md; an egress allowlist must include them). */
export const vaultHosts = (): string[] => THORNODE_OPERATORS.map((o) => new URL(o.base).host);

export function thorVaults(get: ThorGet = json): VaultView {
  return { async check(want) { return checkThorVault(await fetchThorViews(get), want); } };
}
/** For tests and CLI paths: no view, so every cross-chain swap is refused. */
export const noVaults: VaultView = { check: async () => { throw new Error('no vault view configured'); } };
