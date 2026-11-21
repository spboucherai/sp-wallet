/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/i18n-load.ts
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

// v10 performance pass: the texts of ONE language, as a chunk of their own (see i18n.ts and the `spw-i18n-split` plugin in
// vite.config.ts). Loaded before the first render (main.tsx) and before a change of language takes effect (App.tsx).
import { hasLocaleTable, setLocaleTable, type Locale } from './i18n';

const loaders: Record<Locale, () => Promise<{ default: Record<string, string> }>> = { fr: () => import('virtual:spw-i18n-fr'), en: () => import('virtual:spw-i18n-en') };
export async function loadLocale(l: Locale): Promise<void> {
  if (hasLocaleTable(l)) return;
  setLocaleTable(l, (await loaders[l]()).default);
}
