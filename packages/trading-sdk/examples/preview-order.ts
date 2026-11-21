/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading-sdk/examples/preview-order.ts
 * Module           : trading-sdk
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

// Preview an order, with every outcome handled. Needs a key with `orders:prepare`, bound to a trading mandate (a key previews
// the order it could place).
//   SP_WALLET_API_KEY=spw_live_… node packages/trading-sdk/examples/preview-order.ts
// A preview creates, signs and sends nothing. What would refuse the order is in `refusals` — a preview that says "no" is a
// normal answer (HTTP 200), not an exception. Placing (`createOrder`, see paper-order.ts) additionally needs `orders:execute`
// AND a key bound to a trading mandate approved by the wallet's owner.
import { AmbiguousSymbol, MandateRequired, RateLimited, responseMeta, ScopeDenied, ServiceUnavailable, SPWallet, ValidationError } from '../src/index.ts';

const client = new SPWallet();

try {
  // `notional` is in the quote currency: the SERVER reads the price and computes the size, rounded down to the lot
  const preview = await client.previewOrder({ mode: 'paper', exchange: 'hyperliquid', symbol: 'BTC', side: 'buy', type: 'market', notional: '100' });
  console.log(`preview: would execute=${preview.wouldExecute}; rate limit ${responseMeta(preview)?.rateLimit.remaining}/${responseMeta(preview)?.rateLimit.limit}`);
  console.log(`order: ${preview.order.side} ${preview.resolved?.size ?? '?'} ${preview.order.instrument} (${preview.order.type}), hash ${preview.hash.slice(0, 16)}…`);
  console.log(`approval: ${preview.approval.by}; risk engine: ${preview.risk.decision} (${preview.risk.checks.length} checks, ${preview.risk.checks.filter((c) => !c.ok).length} failed)`);
  for (const r of preview.refusals) console.log(`refusal [${r.stage}] ${r.code}: ${r.message}`);
  // the account's figures are answered only to a key that may read them (wallet:read or positions:read)
  console.log(preview.account.withheld ? 'account figures: withheld (this key cannot read the account)' : `account: equity ${preview.account.equity ?? 'n/a'}, free collateral ${preview.account.freeCollateral ?? 'n/a'}`);
} catch (e) {
  if (e instanceof MandateRequired) console.log('this key is not bound to an owner-approved trading mandate: there is no order it could place, so nothing to preview');
  else if (e instanceof ScopeDenied) console.log(`the key lacks a scope: ${e.message}`);
  else if (e instanceof AmbiguousSymbol) console.log(`name the venue: ${e.candidates.join(', ')}`);
  else if (e instanceof RateLimited) console.log(`rate limited; retry in ${e.retryAfterSeconds} s`);
  else if (e instanceof ServiceUnavailable) console.log(`a venue or the signer cannot be read now (${e.code}): nothing was done`);
  else if (e instanceof ValidationError) console.log(`refused request (${e.code}): ${e.message}`);
  else throw e;
}
console.log('done');
