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
