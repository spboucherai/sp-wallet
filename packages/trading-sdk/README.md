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
await client.previewOrder({ exchange: 'hyperliquid', symbol: 'BTC', side: 'buy', type: 'market', notionalUsdc: 100 });
```

- Types generated from `docs/openapi/trading-v1.json` (`scripts/gen-types.mts`, drift test); amounts stay decimal strings.
- Typed errors (`AuthenticationError`, `ScopeDenied`, `MandateRequired`, `RateLimited`, `ExecutionNotWired`, …) with
  `code`, `status`, `requestId`.
- Safe retries: reads on network errors / 429 / 502–504; mutating calls only because they carry an `Idempotency-Key`
  (same key, same bytes on every retry). A mutating call without a trustworthy answer throws `OutcomeUnknown` — not a
  failure — with the key to resume with.
- `waitForOrder`, webhook signature verification, the API key never in a log, an inspection or an error.

**Execution requires an owner-approved mandate bound to the key**; the API refuses it otherwise (`MandateRequired`).
In this version of the API the write operations answer `501 execution_not_wired`: the SDK throws `ExecutionNotWired`
and never reports a success that did not happen.

```
src/        client.ts, errors.ts, util.ts (canonical JSON, decimals, order states), webhooks.ts, generated/openapi.ts
scripts/    gen-types.mts (types from the OpenAPI document), build.mts, test-stack.mts (the real API for the
            integration tests of both SDKs), gen-fixtures.mts (server-made vectors for the Python SDK's tests)
examples/   read-only.ts, preview-order.ts, webhook-receiver.ts
test/       unit tests (mocked fetch) + integration.test.ts (the real API)
```

```bash
node_modules/.bin/vitest run packages/trading-sdk
```
