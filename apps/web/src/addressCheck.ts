/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/addressCheck.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
 * Last Modified    : 2026-11-19
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

/**
 * NEXT — instant feedback on a destination address, with the SAME rule the server applies (`normalizeAddress` of
 * packages/core/src/address.ts: EIP-55 checksum, bech32 / base58 checks, each network family's own format).
 *
 * That module brings the chain libraries with it (hashes, curves, address codecs of 23 networks), so it is NEVER part of the
 * first chunk nor of the Send screen's own chunk: it is fetched on its own the first time an address is typed, and until it
 * is there — or if it cannot be fetched — the field simply says nothing and the server's verdict at the review is the only
 * one, as before. This check never replaces the server's: it only tells the owner sooner.
 */
export type AddressVerdict = { ok: true; normalized: string } | { ok: false; reason: string };
type Core = typeof import('../../../packages/core/src/address');
let core: Promise<Core | null> | null = null;
const load = (): Promise<Core | null> => (core ??= import('../../../packages/core/src/address').then((m) => m, () => { core = null; return null; }));
/** start fetching the checker (when the Send screen opens) */
export const warmAddressCheck = (): void => { void load(); };
/** null: the checker is not available (not loaded, or an unknown network) — say nothing */
export async function checkAddress(network: string, address: string): Promise<AddressVerdict | null> {
  const m = await load(); if (!m) return null;
  try { return { ok: true, normalized: m.normalizeAddress(network, address) }; }
  catch (e) { const reason = String((e as Error)?.message ?? ''); return /unknown network|unsupported network/i.test(reason) ? null : { ok: false, reason }; }
}
