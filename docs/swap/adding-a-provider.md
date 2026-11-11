# Adding a swap provider (contract for implementers)

SP Wallet moves real funds. In this phase a provider adapter does **price discovery only**: it returns real quotes from the
provider's public API, strictly validated, and documents how execution would work. It never builds, signs or sends anything.

## Read first
- `packages/swap/src/types.ts` — `SwapProvider`, `SwapQuote`, `RouteStep`, `FeeItem`, `Executability`, `ProviderContext`.
- `packages/swap/src/aggregator.ts` (`checkQuote`: what gets a quote dropped), `risk.ts`, `router.ts`, `graph.ts`.
- `packages/swap/test/router.test.ts` — how providers are exercised.
- `packages/core/src/networks.ts` and `tokens.ts` — the wallet's verified registry. **Only assets in that registry may appear in a
  quote**; resolve with `resolveAsset()` and never invent decimals or addresses.

## Deliver
1. `packages/swap/src/providers/<id>.ts` exporting `create<Id>Provider(env): SwapProvider`:
   - `capabilities()`: the wallet network ids the provider really serves (checked against its current official docs/API, not
     assumed), `needsKey`/`configured`, link to the docs you used. API base URL and version are constants in the file (pinned).
   - `supportsPair()`: local, no network.
   - `quote()`: one HTTP round (use `ctx.http`, pass `ctx.signal`), response parsed with a **zod schema**; anything unexpected
     throws `ProviderError(id, 'schema', …)`. Map amounts with `BigInt` from strings — never through a JS number. Fill every
     `SwapQuote` field from the provider's answer: `amountOut`, `minAmountOut` (apply the requested slippage exactly as the
     provider defines it; if the provider returns its own guaranteed minimum use that), every fee it reports as a `FeeItem`
     with the right `includedInOutput`, `estimatedSeconds` (null when the provider gives none), `priceImpactBps` (null when
     unknown), `expiresAt` (the provider's validity, else a conservative 30 s), `steps` with the contracts/programs/vaults
     the provider names, `atomic`, `refundable`, and `raw` = the validated provider payload.
   - `executability`: `{ class: 'quote_only', reason }` unless you can show the signer could rebuild and verify every
     value-moving field itself (then say exactly how in the dossier); aggregator calldata is `'opaque'` at best.
   - "No route" is an empty array; provider failures throw. Never fabricate a route, a rate or a duration.
2. Register the factory in `packages/swap/src/providers/index.ts` (`createProviders`).
3. Tests in `packages/swap/test/<id>.test.ts`, with **real responses recorded from the live API** saved under
   `packages/swap/test/fixtures/<id>/` (several pairs, a no-route case, an error case): exact field mapping, decimals,
   slippage arithmetic, fee classification, schema rejection of malformed/hostile answers (wrong token address, float or
   negative amounts, missing fields, output for another recipient), timeout/abort handling.
4. `scripts/smoke-swap-<id>.mts`: live, read-only — prints real quotes for at least four realistic pairs/amounts (small, e.g.
   20–50 USD worth) with latency, and compares the quoted rate with a market reference (CoinGecko) to within a sane band.
   Include the output in your report.
5. `docs/swap/providers/<id>.md` — execution dossier for the next phase, from the provider's official documentation:
   transaction shape per chain, the exact contracts/programs/vaults involved **with their official source URLs**, token
   approvals needed, how the recipient and minimum output are encoded (and therefore what an isolated signer could verify
   by itself), status/tracking API, refund behaviour, fees, rate limits, key requirements, terms-of-use constraints.

## Rules
- Keyless public endpoints only. If the provider requires a key, implement the adapter against its documented schema, test it
  with documented examples, mark it `needsKey`, and say so — do not sign up for anything.
- No new runtime dependency unless unavoidable (zod is available). Pin exact versions.
- `pnpm install`, `pnpm typecheck`, `npx vitest run` must pass. Do not touch the signer, the API or the web app.
- Branch from local `main` (`git checkout -b v2-<id> main`), commit there, do not push, do not deploy.
- Report: networks/pairs actually served, measured latency, what is and is not verified, anything the contract does not fit.
