/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading/src/index.ts
 * Module           : trading
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

// @spw/trading — deterministic core of the V11 trading layer. Pure code: no I/O, no clock except an injected `now`, no randomness.
// Docs: docs/V11-EXECUTION-ENGINE.md, docs/V11-RISK-MODEL.md, docs/TRADING-MANDATES.md.
export * from './dec.ts';
export * from './orders/canonical.ts';
export * from './orders/state.ts';
export * from './orders/idempotency.ts';
export * from './orders/vocabulary.ts';
export * from './risk/engine.ts';
// `checkOrder` of the mandate is also exported as `checkTradingMandateOrder`: the derivatives package already exports a `checkOrder` (risk.ts)
export * from './mandate/trading-mandate.ts';
export { checkOrder as checkTradingMandateOrder } from './mandate/trading-mandate.ts';
export * from './mandate/quoting-mandate.ts'; // V11 market making: trading mandate → quoting mandate, with its enforced-by table
// the market-making core itself is the entry point `@spw/trading/mm` (src/mm/index.ts)
export * from './commands/parse.ts';
export * from './compare/cost.ts';
export * from './compare/symbols.ts';
export * from './valuation/implied.ts';
export * from './docs.ts';
