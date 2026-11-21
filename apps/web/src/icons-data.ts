/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/icons-data.ts
 * Module           : web
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

// The logo files themselves, as ONE lazily loaded chunk (hashed under /assets/, immutable): the whole set costs a single
// request, once, instead of one request per logo. That matters here: the API rate-limits every request of a client,
// static files included (240 per minute), and a list of 249 assets must never eat the budget of the wallet's own calls.
// SVGs are embedded as text (already sanitised, see scripts/svg-sanitize.mts), rasters as base64; both end up in
// `data:` URLs of <img> elements, which the wallet's CSP allows (img-src 'self' data:) and where nothing can execute.
const svg = import.meta.glob('./logos/**/*.svg', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
const raster = import.meta.glob('./logos/**/*.{webp,png}', { eager: true, query: '?inline', import: 'default' }) as Record<string, string>;

const cache = new Map<string, string>();
/** `asset/usdc.svg` → a data: URL, or null when the set has no such file. */
export function dataUrl(file: string): string | null {
  const hit = cache.get(file); if (hit) return hit;
  const key = `./logos/${file}`, s = svg[key], url = s !== undefined ? `data:image/svg+xml,${encodeURIComponent(s.trim())}` : raster[key] ?? null;
  if (url) cache.set(file, url);
  return url;
}
