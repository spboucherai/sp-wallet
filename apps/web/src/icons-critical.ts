/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/icons-critical.ts
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

// v10 performance pass — the few logos the FIRST screen always shows (the held majors, « Populaires », the badges of the
// most used networks), bundled with the app itself (≈ 17 kB of sanitised SVG text) so that Home paints them at once and
// the 320 kB set (icons-data.ts) is not requested until the first paint is done. Same files, same sanitiser, same
// `data:` URLs as the full set: this module only decides WHEN they arrive. A file listed here that is missing fails the
// build (static import) and the unit test (apps/web/test/icons.test.ts).
import btc from './logos/asset/btc.svg?raw';
import eth from './logos/asset/eth.svg?raw';
import sol from './logos/asset/sol.svg?raw';
import usdc from './logos/asset/usdc.svg?raw';
import usdt from './logos/asset/usdt.svg?raw';
import arbitrum from './logos/network/arbitrum.svg?raw';
import base from './logos/network/base.svg?raw';
import optimism from './logos/network/optimism.svg?raw';

const RAW: Record<string, string> = { 'asset/btc.svg': btc, 'asset/eth.svg': eth, 'asset/sol.svg': sol, 'asset/usdc.svg': usdc, 'asset/usdt.svg': usdt, 'network/arbitrum.svg': arbitrum, 'network/base.svg': base, 'network/optimism.svg': optimism };
export const CRITICAL_FILES: readonly string[] = Object.keys(RAW);
const cache = new Map<string, string>();
/** `asset/usdc.svg` → a data: URL when the file is one of the critical few, else null (the full set answers later) */
export function criticalUrl(file: string): string | null {
  const hit = cache.get(file); if (hit) return hit;
  const s = RAW[file]; if (s === undefined) return null;
  const url = `data:image/svg+xml,${encodeURIComponent(s.trim())}`;
  cache.set(file, url);
  return url;
}
