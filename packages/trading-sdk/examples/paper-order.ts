// A PAPER order from preview to close. Nothing is signed and nothing reaches a venue: the wallet's paper engine fills the
// order against the venue's real public order book.
//   SP_WALLET_API_KEY=spw_live_… [SP_WALLET_BASE_URL=http://localhost:8650] [SP_WALLET_ACCOUNT_ID=<paper account>] node packages/trading-sdk/examples/paper-order.ts
// The key needs orders:prepare, orders:execute, orders:read, positions:read, positions:manage AND a paper trading mandate
// approved by the wallet's owner and bound to the key (Developer screen). Without the mandate: MandateRequired.
import { ExecutionDisabled, MandateDenied, MandateRequired, newIdempotencyKey, OutcomeUnknown, responseMeta, RiskDenied, SPWallet, ValidationError, WaitTimeout } from '../src/index.ts';

const client = new SPWallet();
const accountId = process.env.SP_WALLET_ACCOUNT_ID || undefined; // needed only when the wallet has several paper accounts on the venue
const order = { mode: 'paper', exchange: 'hyperliquid', symbol: 'BTC', side: 'buy', type: 'market', notional: '100', accountId } as const;

try {
  // 1 — what would happen, without creating anything
  const preview = await client.previewOrder(order);
  console.log(`preview: would execute=${preview.wouldExecute}, size=${preview.resolved?.size ?? 'n/a'} BTC for a notional of 100, refusals=${JSON.stringify(preview.refusals.map((r) => `${r.stage}:${r.code}`))}`);
  if (!preview.wouldExecute) throw new Error('the preview says the order would be refused: nothing was placed');

  // 2 — place it. One Idempotency-Key per LOGICAL order: persist it before sending if your process can crash.
  const idempotencyKey = newIdempotencyKey();
  const placed = await client.createOrder(order, { idempotencyKey });
  console.log(`placed: order ${placed.order.id.slice(0, 14)}… status=${placed.order.status} final=${placed.order.final}`);
  // the same call again is the SAME order: nothing is sent twice
  const again = await client.createOrder(order, { idempotencyKey });
  console.log(`replay: same order=${again.order.id === placed.order.id}, answered from the idempotency store=${responseMeta(again)?.idempotentReplay}`);

  // 3 — wait until it is final. UNKNOWN is not final and not a failure: the wait goes on.
  const done = await client.waitForOrder(placed.order.id, { waitTimeoutMs: 30_000 });
  console.log(`final: status=${done.order.status} filled=${done.order.filled} avg=${done.order.avgFillPrice} fills=${done.fills.length}`);

  // 4 — the position, then out of it (a close is strictly reduce-only)
  const position = (await client.getPositions({ mode: 'paper' })).positions.find((p) => p.instrument === 'hyperliquid:BTC');
  if (!position) throw new Error('no paper position on hyperliquid:BTC after the fill');
  console.log(`position: ${position.side} ${position.size} BTC, entry ${position.entryPrice}`);
  const closed = await client.closePosition(position.id);
  console.log(`closed: status=${closed.order.status} reduceOnly=${closed.order.reduceOnly}`);
  console.log('done');
} catch (e) {
  if (e instanceof OutcomeUnknown) console.log(`outcome unknown — NOT a failure: send the same call again with idempotencyKey ${e.idempotencyKey}, or read the order`);
  else if (e instanceof WaitTimeout) console.log('the order is not final yet — it has not failed: keep reading it');
  else if (e instanceof MandateRequired) console.log('this key is not bound to an owner-approved trading mandate: nothing can execute');
  else if (e instanceof MandateDenied) console.log(`outside the mandate: ${e.reasons.join(', ')} (order ${e.order?.id ?? 'not created'} is ${e.order?.status ?? 'n/a'})`);
  else if (e instanceof RiskDenied) console.log(`refused by the risk engine${e.killSwitch ? ' (kill switch)' : ''}: ${e.failed.join(', ')}`);
  else if (e instanceof ExecutionDisabled) console.log('live execution through the API is closed on this server; paper is not affected');
  else if (e instanceof ValidationError) console.log(`refused (${e.code}): ${e.message}`);
  else throw e;
}
