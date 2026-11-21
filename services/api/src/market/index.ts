/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/market/index.ts
 * Module           : market
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
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

// Market data engine: public surface for the rest of the API service (the trading engine uses getSeries and assertFresh).
export { SYMBOLS, INTERVALS, INTERVAL_MS, MarketDataError, SourceError, expectedLastTs, type Candle, type SeriesBar, type Interval, type MarketSymbol, type SourceId } from './types.ts';
export { getSeries, assertFresh, checkQuality, type Series } from './series.ts';
export { DEFAULT_QUALITY, DEFAULT_PRIORITY, type QualityOpts, type QualityReport } from './quality.ts';
export { startMarketWorker } from './worker.ts';
export { marketDataRoutes } from './routes.ts';
export { activeMarketConfig, configuredSymbols, registrySymbols } from './symbols.ts';
