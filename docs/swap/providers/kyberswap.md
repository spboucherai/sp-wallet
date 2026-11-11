# KyberSwap Aggregator — provider dossier

Checked against the official documentation and the live API on **2026-11-10**. Adapter: `packages/swap/src/providers/kyberswap.ts`
(price discovery only, `executability: opaque`). Nothing below has been executed: no calldata was requested, no transaction built.

## Sources
- API specification (EVM swaps): https://docs.kyberswap.com/developer-guide/aggregator-api/aggregator-api-specification/evm-swaps
- Rate limits and authentication: https://docs.kyberswap.com/developer-guide/start-here/rate-limits-and-client-id
- Contract addresses: https://docs.kyberswap.com/developer-guide/aggregator-api/contracts
- Execution guide: https://docs.kyberswap.com/developer-guide/aggregator-api/how-to-guides/execute-a-swap-with-the-aggregator-api
- Fee schedule: https://docs.kyberswap.com/getting-started/fee-schedule
- Router ABI (verified): https://etherscan.io/address/0x6131B5fae19EA4f9D964eAc0408E4408b66337b5#code

## API

| | |
|---|---|
| Keyless base (used) | `https://aggregator-api.kyberswap.com` — header `x-client-id: <app or company name>` recommended; public limit **3 requests/s** |
| Keyed gateway (not used) | `https://api.kyberswap.com/swap/` — header `X-Api-Key` on every request; answers `401 missing api key` without one (checked 2026-11-10). The documentation recommends it for new integrations ("better performance and higher rate limits") and calls the keyless base "legacy … rate limited". Keys and higher limits: business@kyber.network. Client-id whitelisting is no longer offered. |
| Quote | `GET /{chain}/api/v1/routes?tokenIn&tokenOut&amountIn` → `data.routeSummary`, `data.routerAddress` |
| Encode (execution phase) | `POST /{chain}/api/v1/route/build` with the `routeSummary` **exactly as returned**, `sender`, `recipient`, `slippageTolerance`, `deadline` → `data.data` (calldata), `routerAddress`, `transactionValue`, `amountOut`, `gas` |
| Do not use | `GET /{chain}/api/v1/swap` (beta, whitelisted; "Calling this API without following through with the swap will lead to your client being banned") and the legacy `GET /{chain}/route/encode` |

Wallet networks served — each one is in the specification's chain list **and** returned a real route on 2026-11-10
(fixtures in `packages/swap/test/fixtures/kyberswap/`):

| wallet id | path segment | chain id | | wallet id | path segment | chain id |
|---|---|---|---|---|---|---|
| ethereum | `ethereum` | 1 | | optimism | `optimism` | 10 |
| base | `base` | 8453 | | bsc | `bsc` | 56 |
| arbitrum | `arbitrum` | 42161 | | avalanche | `avalanche` | 43114 |
| polygon | `polygon` | 137 | | hyperevm | `hyperevm` | 999 |

Conventions:
- **Native coin**: `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` as `tokenIn`/`tokenOut`; the answer echoes it in lower case. Hops show the wrapped
  coin (the router wraps/unwraps itself).
- **Amounts**: decimal strings in base units. USD figures (`amountInUsd`, `amountOutUsd`, `gasUsd`, `l1FeeUsd`) are float strings, estimates only.
- **Slippage**: not part of the quote. It is `slippageTolerance` in `/route/build`, in basis points, range `[0, 2000]` (fractions allowed,
  default **0** when omitted; `ignoreCappedSlippage` lifts the cap — never set it). The guaranteed minimum is "the estimated output adjusted
  by the selected max slippage". The adapter therefore reports `minAmountOut = floor(amountOut × (10000 − bps) / 10000)` and returns no quote
  above 2000 bps. **Not verified**: the provider's rounding of that product (the documentation gives no formula and `/route/build` was not
  called). Rounding down is the cautious reading; at execution the signer must read the real `minReturnAmount` from the calldata.
- **Gas**: `gas` (units, estimate) and `gasPrice` (wei) → adapter fee `network = gas × gasPrice` in the native coin, `estimated`, not included
  in the output. Route search is gas-aware by default (`gasInclude=true`) but `amountOut` is gross of gas. On rollups `l1FeeUsd` (USD only)
  is extra and is **not** in that fee item: it has no base-unit amount to put in a `FeeItem`; it stays in `raw`.
- **Price impact**: the API returns no impact field. The adapter derives it from the provider's own valuations,
  `(amountInUsd − amountOutUsd) / amountInUsd`, in bps (negative = better than the provider's reference); `null` when either is zero or the
  result is outside ±100 %. It is a display aid based on KyberSwap's prices, not an on-chain measure.
- **Validity**: no expiry field. "it is recommended to not cache routes from client side for more than 5-10 seconds" → `expiresAt = now + 10 s`.
  `routeSummary.timestamp` (unix seconds) is checked against the local clock (±120 s) to refuse replayed answers.
- **Duration**: none given → `estimatedSeconds: null`.
- **Errors**: HTTP 400 with `{code, message, details, requestId}`. Seen live: `4008` route not found (1 wei), `4011` token not found,
  `4009` amountIn above the maximum, `4000` bad request with `fieldViolations` (the specification lists `4001`), unknown chain → HTTP 404
  with another body shape. Documented too: `4010` no eligible pool, `4005`/`4007` fee above amount, `4221` (HTTP 422) WETH not configured.
  Adapter: 4008/4009/4010/4011 → no route (`[]`); everything else throws.
- **`origin`** (optional, the user's address, "to get access to exclusive pools and rates"): not sent during price discovery, to avoid
  disclosing the wallet. To be decided for execution — the firm route would then differ from the indicative one.
- **Fees we could add**: `feeAmount`, `chargeFeeBy` (`currency_in`/`currency_out`), `isInBps`, `feeReceiver`. Not used; the adapter rejects any
  answer whose `extraFee` is not empty.

## Contracts (official page: https://docs.kyberswap.com/developer-guide/aggregator-api/contracts)
"All KyberSwap Aggregator contracts have been deployed at the same address across all supported chains."

| Contract | Address | Role |
|---|---|---|
| MetaAggregationRouterV2 | `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` | transaction target **and** ERC-20 spender; listed for all eight wallet networks; returned as `routerAddress` by every recorded answer |
| KSAggregationRouterV3 | `0x6868d319c8c9a78f7d39dc3602c5c917315132d7` | listed for Ethereum, BSC and Base only; the API did not return it in any recorded answer. If `routerAddress` ever changes, the adapter refuses the answer (`schema`) until this dossier is updated |
| AggregationExecutorProxy | `0x8F10B468b06c6FD214B65F87778827F7D113f996` | executor called by the router (never approved by the user) |
| InputScalingHelperV2 | `0x2f577A41BeC1BE1152AeEA12e73b7391d15f655D` | optional calldata rescaling helper; not needed |

Explorers: [Ethereum](https://etherscan.io/address/0x6131B5fae19EA4f9D964eAc0408E4408b66337b5) ·
[Base](https://basescan.org/address/0x6131B5fae19EA4f9D964eAc0408E4408b66337b5) ·
[Arbitrum](https://arbiscan.io/address/0x6131B5fae19EA4f9D964eAc0408E4408b66337b5) ·
[Polygon](https://polygonscan.com/address/0x6131B5fae19EA4f9D964eAc0408E4408b66337b5) ·
[Optimism](https://optimistic.etherscan.io/address/0x6131B5fae19EA4f9D964eAc0408E4408b66337b5) ·
[BSC](https://bscscan.com/address/0x6131B5fae19EA4f9D964eAc0408E4408b66337b5) ·
[Avalanche](https://snowtrace.io/address/0x6131B5fae19EA4f9D964eAc0408E4408b66337b5) ·
[HyperEVM](https://hyperevmscan.io/address/0x6131B5fae19EA4f9D964eAc0408E4408b66337b5).
Only the Ethereum deployment's verified ABI was read for this dossier. **To do before execution**: confirm on each chain that the address
holds the same verified code (the API start-up check that already verifies tokens is the natural place).

## Transaction shape (same on every chain)
One EVM transaction, atomic: `to = routerAddress`, `data = build.data`, `value = build.transactionValue` (the input amount when the input is
the native coin, else 0). Gas: `build.gas` is an estimate; `enableGasEstimation: true` makes the API run `eth_estimateGas` and report likely
reverts. Deadline: `deadline` (unix seconds) in the build request, default 20 minutes — set it short and explicitly.

**Approval** (token input only): `approve(routerAddress, amountIn)` on the input token — exact amount, never unlimited. `permit` (EIP-2612
calldata with the router as spender) can replace it for tokens that support it. USDT on Ethereum requires resetting a non-zero allowance to 0 first.

Router entry points (verified ABI). All three carry the same `SwapDescriptionV2`:
```
swap(SwapExecutionParams{ callTarget, approveTarget, targetData, desc, clientData })          payable
swapGeneric(SwapExecutionParams{ … same … })                                                    payable
swapSimpleMode(caller, desc, executorData, clientData)                                          non-payable
SwapDescriptionV2{ srcToken, dstToken, srcReceivers[], srcAmounts[], feeReceivers[], feeAmounts[],
                   dstReceiver, amount, minReturnAmount, flags, permit }
```

**What an isolated signer can verify by itself** from the calldata, without trusting the API:
- `to` is the pinned router and the selector is one of the three above;
- `desc.srcToken` / `desc.dstToken` are the intent's assets (native = `0xEeee…`), `desc.amount` = the intent's input, `value` matches;
- `desc.dstReceiver` = the wallet's own address (this is where `recipient` is encoded);
- `desc.minReturnAmount` ≥ the minimum the user approved (this is where slippage is encoded);
- `desc.feeReceivers` / `feeAmounts` are empty; `desc.permit` is empty;
- the allowance granted equals `desc.amount` and the spender is the router.

**What it cannot verify**: `targetData` / `executorData` (the route itself), `callTarget`/`caller` (the executor, expected to be the
AggregationExecutorProxy above — pin it), `srcReceivers` (pools that receive the input directly) and `flags`. A hostile route can lose value
only down to `minReturnAmount`, which the router is documented to guarantee — hence class `opaque`, not `verified`. Not verified here: how the
router source enforces that minimum and the meaning of each `flags` bit; both must be read in the verified source before execution is enabled.

Calldata is single-use in practice ("one same calldata is not guaranteed to be able to execute on-chain multiple times", RFQ nonces):
request it once per transaction, right before signing, and never retry the same bytes.

## Status, tracking, refunds
No status API: a swap is one transaction; track its receipt on the chain. The router emits
`Swapped(sender, srcToken, dstToken, dstReceiver, spentAmount, returnAmount)` — the realised output can be read from it.
Refund: none needed; a failed swap reverts entirely and only gas is lost (`atomic: true`, `refundable: true`).

## Fees
"KyberSwap does not charge fees to users who trade on KyberSwap.com or call directly from KyberSwap Aggregator API" (fee schedule).
Two things to know: **positive slippage surplus** — on "certain trades", output above the quoted amount is kept by KyberSwap, the user being
"guaranteed at least the minimum received amount" — and a **dust collector**. So the realised output is expected between `minAmountOut`
and `amountOut`, not above. The adapter reports no protocol fee because the API reports none.

## Terms and constraints
- 3 requests/s without a key; the wallet's default runtime policy (2/s, burst 4) stays under it. A 429 becomes `rate_limited`.
- `x-client-id` should name the application. The adapter sends `KYBERSWAP_CLIENT_ID` or the neutral default `swap-router`:
  **set the real value at deployment** (a product decision, not made here).
- Do not cache routes beyond 5–10 s; fetch a new route before building.
- "Data provided as-is." The developer documentation has no terms-of-use page for the API. KyberSwap's site terms were **not** located or
  reviewed here — to be read before going to execution, including geographic restrictions.
- The keyless base is described as legacy. No sunset date is published; if it closes, the gateway needs an API key (`needsKey` would become true).

## Verified / not verified
Verified live: endpoint, the eight chains, native convention, error codes above, response schema (14 recorded exchanges), rates within
0.4 % of CoinGecko on nine pairs, latency 170–700 ms (median ≈ 300 ms) from Québec.
From documentation only: `/route/build` request and response, slippage semantics, deadline, permit, fee parameters, rate limit figure.
Not verified: rounding of the minimum, `flags` semantics, identical bytecode on the seven other chains, site terms of use.
