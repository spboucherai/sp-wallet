/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/nav.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-16
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

// v11 interface (docs/v11/UI-ARCHITECTURE.md) — the FIVE areas of the navigation, the same on the phone's tab bar and in the
// desktop sidebar: [area, icon, i18n key of its label]. A module of its own because the shell (App.tsx, first chunk) and the
// lazily loaded part of the shell (shell-more.tsx) both read it, and neither may import the other's code.
import type { Key } from './i18n';

/** NEXT: the entries the app itself pushed carry this mark — « back » can then return where the owner came from, and falls back to a fixed place on a page opened directly */
export const IN_APP = { spw: 1 } as const;
export const backOr = (fallback: () => void): void => { if ((history.state as { spw?: number } | null)?.spw === 1) history.back(); else fallback(); };

export type Area = 'home' | 'markets' | 'trade' | 'agents' | 'activity';
export const AREAS: readonly (readonly [Area, string, Key])[] = [['home', 'home', 'home'], ['markets', 'chart', 'mkTab'], ['trade', 'swap', 'v11NavTrade'], ['agents', 'robot', 'agents'], ['activity', 'list', 'activity']];
