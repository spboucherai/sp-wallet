# 1inch Classic Swap API v6.1 — provider dossier

Read in the official documentation on **2026-11-15**. Adapter: `packages/swap/src/providers/oneinch.ts`, provider id `oneinch`
(price comparison only, `executability: quote_only`, code `comparison_only`).

**Nothing below was checked against the live API.** 1inch requires an API key and none was available: the adapter is written
from the documented request and response, and its tests replay **documentation-derived fixtures**
(`packages/swap/test/fixtures/oneinch/`; every value in them is constructed to respect the documented schema — the method
reference's own example is a placeholder, 1INCH to 1INCH). The only live fact is the one recorded by the V11 audit: a call
without a key answers `401 Unauthorized`.

## Sources
- Quick start (base URL, version, headers, router address): https://business.1inch.com/portal/documentation/apis/swap/classic-swap/quick-start
- Method reference, quote: https://business.1inch.com/portal/documentation/apis/swap/classic-swap/methods/v6.1/chainId/quote/method/get
- Introduction: https://business.1inch.com/portal/documentation/apis/swap/classic-swap/introduction
- Supported chains: https://business.1inch.com/portal/documentation/overview/supported-chains

## API

| | |
|---|---|
| Base | `https://api.1inch.com/swap/v6.1/{chainId}` ("API version: v6.1 Recommended") |
| Key | **Required**: header `Authorization: Bearer <key>` (1inch Business portal) |
| Quote (used) | `GET /quote?src&dst&amount[&includeTokensInfo][&includeProtocols][&includeGas]…` |
| Swap (never called) | `GET /swap?src&dst&amount&from&slippage…` → `tx.{to,data,value}` for AggregationRouterV6 |
| Approvals (never called) | `GET /approve/transaction`, `GET /approve/allowance` |

Parameters the adapter sends: `src`, `dst`, `amount` (base units, decimal string) and
`includeTokensInfo=true&includeProtocols=true&includeGas=true`. `/quote` takes **no address and no tolerance**: nothing about the
wallet is sent. Not sent: `fee` (partner fee, 0–3 %), `protocols`, `excludedProtocols`, `excludePMMs`, `gasPrice`,
`complexityLevel`, `parts`, `mainRouteParts`, `gasLimit`, `connectorTokens`.

Wallet networks served, with the wallet registry's chain id (asserted by a test):

| wallet id | chain id | | wallet id | chain id |
|---|---|---|---|---|
| ethereum | 1 | | optimism | 10 |
| base | 8453 | | bsc | 56 |
| arbitrum | 42161 | | avalanche | 43114 |
| polygon | 137 | | hyperevm | 999 |

**The chain lists differ between 1inch's pages** (an older Classic Swap page lists 13 chains and omits HyperEVM; the current
supported-chains page includes it). HyperEVM is the one network above that is not on every list: if the API refuses chain 999
the provider simply reports an error for that network and the other routes are unaffected. 1inch also lists Solana (501),
zkSync, Gnosis, Cronos, Monad, Linea, Sonic, Unichain, Arc and Robinhood Chain: not served by this adapter (Solana is not a
Classic Swap EVM route; the others are not wallet networks).

Conventions:
- **Native coin**: `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` as `src` / `dst` (the form used in the reference's example).
- **Amounts**: `dstAmount` ("Expected amount of destination token", decimal string) → `amountOut`.
- **Minimum**: `/quote` has none. The tolerance exists only in `/swap` (`slippage`, in percent). The adapter reports
  `minAmountOut = floor(dstAmount × (10000 − bps) / 10000)` — the owner's own tolerance applied to the quoted amount, the same
  reading as for KyberSwap. **Not verified**: 1inch's rounding, and whether `/swap` would quote the same `dstAmount`.
- **Network fee**: `gas` is an estimate in gas **units**, with no gas price in the answer. A fee in the native coin cannot be
  stated without inventing a price, so **no network fee is reported** (the route card shows "not reported"); the units stay
  in `raw`.
- **Protocol fee**: none unless the caller sets `fee`; the adapter sets none and reports none.
- **Price impact / duration**: not in the answer → `null`.
- **Validity**: no expiry field. The adapter keeps a quote 15 s — the wallet's choice, not 1inch's.
- **Route**: `protocols[].hops[].protocols[].name` → the venues shown.
- **Pair check**: with `includeTokensInfo`, `srcToken.address` / `dstToken.address` must be the pair that was asked.
- **Errors**: the method reference lists 400, 403 and 500 **without publishing their bodies**. The adapter relies on one thing
  only: an HTTP 400 whose text contains "insufficient liquidity" is a no-route answer. Every other error is a provider
  failure; 429 → `rate_limited`.

## Why it is comparison only
`/swap` returns calldata for **AggregationRouterV6** (`0x111111125421ca6dc452d289314280a0f8842a65`, also the spender of the
approval). That router has several entry points — `swap(executor, desc, data)` with `desc.dstReceiver` and
`desc.minReturnAmount`, and the `unoswap*` / `clipperSwap*` families, which encode the receiver and the minimum differently.
For execution the isolated signer would need a decoder for each family it accepts (and a refusal of the others), the router
pinned by address and runtime bytecode hash on every network after reading the verified source, and fork proofs — the work
that was done for KyberSwap. None of that exists. The wallet never calls `/swap`, builds nothing and signs nothing from a
1inch answer; the UI labels the route "comparison only" and the API refuses its reference at preparation
(`quote_not_executable`).

## Status, tracking, refunds
Not applicable (no execution). For the record: a Classic Swap is one transaction that settles in full or reverts.

## Key, rate limits, terms
- The key lives in the API process environment (`ONEINCH_API_KEY`), on the node that serves the web app; it never reaches the
  signer. Without it the provider is listed as `needsKey` in `GET /api/v1/swap/providers` and is never asked.
- **Rate limit**: the documentation read states no figure (it says higher throughput needs a paid plan). The adapter's policy is
  a deliberately low 1 request/s, burst 2 (`packages/swap/src/enabled.ts`); raise it only after reading the plan's limit.
- **Terms of use were not reviewed** (aggregation / comparison clauses, geographic restrictions). Configuring the key is the
  owner's opt-in.
- Privacy: every quote request tells 1inch which pairs and amounts are being looked at, tied to the key's account. No address is sent.

## Verified / not verified
From documentation only (everything): base URL and version, header, parameters, QuoteResponse schema, router address.
Observed live: only that a keyless call answers 401.
Not verified: every value in a real answer; the error bodies; the native placeholder's accepted casing; HyperEVM support; the
relation between `/quote` and `/swap` amounts; rate limits; terms of use. **First thing to do with a key**: record real answers
with a recorder script like the other providers and replace the documentation-derived fixtures.
