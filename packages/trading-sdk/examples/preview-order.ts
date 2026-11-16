// Preview an order, with every outcome handled. Needs a key with `orders:prepare` (and `markets:read` for notionalUsdc).
//   SP_WALLET_API_KEY=spw_live_… node packages/trading-sdk/examples/preview-order.ts
// A preview places nothing. Placing (`createOrder`) additionally needs `orders:execute` AND a key bound to a trading
// mandate approved by the wallet's owner — otherwise the API answers 403 `mandate_required`.
import { ExecutionNotWired, MandateRequired, newIdempotencyKey, OutcomeUnknown, RateLimited, responseMeta, ScopeDenied, SPWallet, ValidationError } from '../src/index.ts';

const client = new SPWallet();
// One key per LOGICAL call. Persist it before sending if your process can crash: the same key resumes the same call.
const idempotencyKey = newIdempotencyKey();
console.log(`idempotency key of this call: ${idempotencyKey}`);

try {
  const preview = await client.previewOrder({ exchange: 'hyperliquid', symbol: 'BTC', side: 'buy', type: 'market', notionalUsdc: 100 }, { idempotencyKey });
  console.log('preview:', preview, responseMeta(preview));
} catch (e) {
  if (e instanceof OutcomeUnknown) {
    // NOT a failure: no trustworthy answer was received. Re-send the same call with the same key, or read the object.
    console.log(`outcome unknown — resume with idempotencyKey ${e.idempotencyKey}`);
  } else if (e instanceof ExecutionNotWired) console.log(`the server does not execute this operation yet (501 ${e.code}): nothing was done`);
  else if (e instanceof MandateRequired) console.log('this key is not bound to an owner-approved trading mandate: execution is refused');
  else if (e instanceof ScopeDenied) console.log(`the key lacks a scope: ${e.message}`);
  else if (e instanceof RateLimited) console.log(`rate limited; retry in ${e.retryAfterSeconds} s`);
  else if (e instanceof ValidationError) console.log(`refused request (${e.code}): ${e.message}`);
  else throw e;
}
