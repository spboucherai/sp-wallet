/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/venues/edgex/index.ts
 * Module           : venues
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
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

export { createEdgeXAdapter, EDGEX_CAPABILITIES, EDGEX_ENDPOINTS, EDGEX_REASONS, EDGEX_TERMS_URL, type EdgeXAdapter, type EdgeXAdapterOptions } from './adapter.ts';
export { EdgeXStream, EDGEX_CHANNEL_RE, type EdgeXStreamEvent, type EdgeXStreamOptions, type EdgeXWebSocketCtor, type EdgeXWebSocketLike } from './stream.ts';
export { EDGEX_MARK_METHOD, EDGEX_SETTLEMENT, categoriesOf as edgexCategoriesOf, categoryOf as edgexCategoryOf, type EdgeXInstrument, type EdgeXInstrumentDetail, type EdgeXRiskTier } from './map.ts';
