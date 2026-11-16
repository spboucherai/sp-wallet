# @sp-wallet/trading-sdk

Official TypeScript client of the SP Wallet Trading API. Zero runtime dependency (global `fetch`, WebCrypto): Node ≥ 20
and browsers, ESM + types. Full documentation: [`docs/sdk/typescript.md`](../../docs/sdk/typescript.md).

```bash
node packages/trading-sdk/scripts/build.mts          # → dist/ (index.js + *.d.ts); not published to npm
npm install /path/to/sp-wallet/packages/trading-sdk
```

```ts
import { SPWallet } from '@sp-wallet/trading-sdk';

const client = new SPWallet({ apiKey: process.env.SP_WALLET_API_KEY });   // or new SPWallet()

await client.getBalances();
await client.getPositions();
const order = { exchange: 'hyperliquid', symbol: 'BTC', side: 'buy', type: 'market', notionalUsdc: 100 } as const;   // paper by default
const preview = await client.previewOrder(order);
if (preview.wouldExecute) {
  const placed = await client.createOrder(order);
  await client.waitForOrder(placed.order.id);          // FILLED, CANCELLED, REJECTED or FAILED — UNKNOWN keeps waiting
}
```

- Types generated from `docs/openapi/trading-v1.json` (`scripts/gen-types.mts`, drift test); amounts stay decimal strings.
- Typed results for every implemented operation, the write side included (`OrderPreview`, `PlacedOrder`,
  `CancelledOrder`, `CommandResult`); an order's `status` is the contract's closed enum of twelve states.
- A `notional` is sized by the **server** (the SDK sends it and computes nothing); `iterateOrders` / `iterateActivity`
  follow the cursor pagination.
- Typed errors (`AuthenticationError`, `ScopeDenied`, `MandateRequired`, `MandateDenied` with the reasons, `RiskDenied`
  with the failed checks, `ExecutionDisabled`, `AmbiguousCommand` with the questions, `RateLimited`, …) with `code`,
  `status`, `requestId`, and `error.order` when the refusal is about an order the server created.
- Safe retries: reads on network errors / 429 / 502–504; mutating calls only because they carry an `Idempotency-Key`
  (same key, same bytes on every retry). A mutating call without a trustworthy answer throws `OutcomeUnknown` — not a
  failure — with the key to resume with.
- `waitForOrder`, webhook signature verification, the API key never in a log, an inspection or an error.

**Execution requires an owner-approved mandate bound to the key**; the API refuses it otherwise (`MandateRequired`),
and an order outside the mandate is `MandateDenied`. Paper orders are simulated by the wallet. Live orders also need
`SPW_TRADING_API_EXECUTION=on` on the server (`ExecutionDisabled` otherwise). All 41 operations of the contract are implemented, the strategy and agent operations included (agents are read ONE
mode per call). Managing agents needs no mandate on the key; an agent goes live only under its own owner-approved mandate.
Rotating a key unbinds its mandate (the mandate names the old key id): see "Key rotation" in the documentation.

```
src/        client.ts, errors.ts, util.ts (canonical JSON, decimals, order states), webhooks.ts, generated/openapi.ts
scripts/    gen-types.mts (types from the OpenAPI document), build.mts, test-stack.mts (the real API for the
            integration tests of both SDKs), gen-fixtures.mts (server-made vectors for the Python SDK's tests)
examples/   read-only.ts, preview-order.ts, paper-order.ts, stream-quotes.ts (executed by the integration tests), webhook-receiver.ts
test/       unit tests (mocked fetch) + integration.test.ts (the real API)
```

```bash
node_modules/.bin/vitest run packages/trading-sdk
```
