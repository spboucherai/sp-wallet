/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/live/index.ts
 * Module           : live
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

// Controlled live trading — the part shared by the isolated signer and the API (entry point `@spw/derivatives/live`).
// LEAN ON PURPOSE: this entry point is bundled into the isolated signer. It re-exports only pure code — canonical objects and
// hashes, the pinned asset table, the acknowledgement text, and the Hyperliquid action builder / `describe` / signing helpers.
// It must never import an HTTP client, a websocket stream or a venue read adapter (scripts/check in test/live.test.ts).
export * from './canonical.ts';
export * from './hl-assets.ts';
export * from './jurisdiction.ts';
export * from './mandate.ts';
export * from './quoting.ts'; // V11: the quoting mandate (market making) — a separate shape; mandate.ts is unchanged
export * from './collateral.ts'; // funding the venue account: pinned bridge, canonical deposit section and withdrawal (v6)
export * from './gmx.ts'; // v8: GMX v2 orders as wallet transactions — pins, calldata builder, intent verification, venue policy
export { D, type DecStr } from '../decimal.ts';
export { VenueError, type OrderRequest } from '../models.ts';
export type { SignRequest } from '../venue.ts';
export { createHlTrading, hlCloid, HL_KIND_L1, HL_KIND_USER, type HlAsset, type HlDescription, type HlL1SignPayload, type HlTrading, type HlUserSignPayload } from '../venues/hyperliquid/trading.ts';
export { normalizeSignature, recoverTypedDataSigner, signatureFromHex, typedDataDigest, type HlNetwork, type HlSignature, type HlTypedData, type HlApproveAgentAction } from '../venues/hyperliquid/signing.ts';
