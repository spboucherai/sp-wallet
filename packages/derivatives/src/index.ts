/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/index.ts
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

export * from './decimal.ts';
export * from './models.ts';
export * from './venue.ts';
export * from './margin.ts';
export * from './risk.ts';
export * from './paper.ts';
export * from './router.ts';
// venues: dYdX v4 and GMX v2 (read side)
export { canonDec, fixed, jsonNumberToDecStr, parseJsonExact, toRaw, JsonNumber } from './venues/http.ts';
export * from './venues/dydx/index.ts';
export * from './venues/gmx/index.ts';
export * from './venues/hyperliquid/index.ts';
export * from './venues/edgex/index.ts';   // v11: edgeX, market data only
export { EDGEX_BLOCKED_JURISDICTION, type VenueJurisdictionBlock } from './live/jurisdiction.ts';
