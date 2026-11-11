# Jupiter (Solana) — provider dossier

Provider id `jupiter`, displayed as **“Jupiter (Metis)”**. Adapter: `packages/swap/src/providers/jupiter.ts`
(+ `jupiter-dexes.ts`). Phase: **price discovery only** — `executability: opaque`. Nothing in the wallet builds, signs or
sends a Jupiter transaction.

Everything below was checked on **2026-11-10** against the official documentation (`https://developers.jup.ag/docs`, which
`https://dev.jup.ag` redirects to; every page has a `.md` twin) and against the live API. Statements marked **(measured)**
come from live answers, the rest from the cited page. Statements marked **(pinned by test)** are asserted on the recorded
fixtures in `packages/swap/test/jupiter.test.ts`.

## 1. Which API

| API | Base URL | Status (docs) | Used here |
|---|---|---|---|
| Swap API V2 — Router: `GET /build` | `https://api.jup.ag/swap/v2` | current; Metis on-chain routing only, **no Jupiter swap fee**, returns quote + raw instructions | **yes** |
| Swap API V2 — Meta-Aggregator: `GET /order` + `POST /execute` | same | current, recommended by Jupiter; Metis + JupiterZ RFQ + Dflow + OKX; Jupiter platform fee; transaction cannot be modified and is landed by Jupiter | no (see §9) |
| Swap API V1 (“Metis Swap API”): `GET /quote`, `POST /swap`, `POST /swap-instructions` | `https://api.jup.ag/swap/v1` | “no longer actively maintained and has been superseded by Swap V2”; still answers keyless (measured) | no |
| `lite-api.jup.ag` | — | being phased out: “replaced by keyless requests on `api.jup.ag`”, rate limit reduced progressively until retired; still answers (measured) | no |
| `quote-api.jup.ag/v6` | — | gone (connection refused, measured) | no |

Sources: [Swap overview](https://developers.jup.ag/docs/swap), [Build](https://developers.jup.ag/docs/swap/build),
[GET /build reference](https://developers.jup.ag/docs/api-reference/swap/build),
[Metis → Router migration](https://developers.jup.ag/docs/swap/migration/metis-to-build),
[V1 quote reference](https://developers.jup.ag/docs/api-reference/swap/v1/quote),
[Developer Platform migration](https://developers.jup.ag/docs/portal/migration).

**Keys.** None required: “a request with no `x-api-key` header is treated as keyless”. The adapter sends `x-api-key` only
if `JUPITER_API_KEY` is set (a free key raises the limit to 1 request/s; paid tiers 10/50/150). The wallet did not sign up
for anything.

**Rate limits** ([Rate Limits](https://developers.jup.ag/docs/portal/rate-limits)). Keyless: 0.5 request/s; documented as
30 per 60-second sliding window, **measured as 5 requests per ~10-second sliding window** (the 6th answers
`429 {"code":429,"message":"[API Gateway] Too many requests"}`; no lock-out afterwards). All main endpoints share one
bucket (`/build`, V1 `/quote`, `/program-id-to-label`, Price, Tokens…). `/swap/v2/order` and `/execute` showed a separate
20-request bucket (measured header). Headers on 200 and 429: `x-ratelimit-remaining`, `x-ratelimit-current`,
`x-ratelimit-reset` (Unix seconds when one slot frees). The runtime must therefore run this provider at
`JUPITER_KEYLESS_POLICY` (`ratePerSec: 0.5, burst: 4`), **not** the default 2 requests/s.

**Latency (measured, from Québec, keyless, 2026-11-10):** 40–140 ms per `/build` call, median ≈ 60–80 ms, answers of
14–68 kB (the instructions and lookup tables dominate).

## 2. The quote call

```
GET https://api.jup.ag/swap/v2/build?inputMint=<mint>&outputMint=<mint>&amount=<base units>&taker=<wallet>&slippageBps=<0..10000>
```

- `/build` is **ExactIn only** (no `swapMode`); `taker` is **required** and must be a valid public key (no balance needed).
- Native SOL is the **wrapped-SOL mint** `So11111111111111111111111111111111111111112`; `wrapAndUnwrapSol` defaults to
  `true`, so the answer contains the wrap (input) or unwrap (output) instructions.
- Parameters the adapter does **not** send (defaults apply): `mode=fast`, `dexes`/`excludeDexes`, `maxAccounts` (64),
  `platformFeeBps`+`feeAccount`, `payer`, `destinationTokenAccount`/`nativeDestinationAccount`, `blockhashSlotsToExpiry`
  (150), `tipAmount`, `computeUnitPricePercentile`, `forJitoBundle`, `transactionVersion` (`0`), `slippageBps=rtse`.
- `restrictIntermediateTokens` and `onlyDirectRoutes` exist **only on V1 `/quote`**; `/build` has no equivalent (it
  chooses intermediate tokens dynamically). The closest levers are `maxAccounts` and `dexes`.

Answer fields and how the adapter maps them:

| Field | Meaning | Mapping |
|---|---|---|
| `inputMint`, `outputMint`, `inAmount`, `swapMode`, `slippageBps` | echo of the request | must equal the request, else `schema` error |
| `outAmount` (string, base units) | expected output | `amountOut` (BigInt from the string) |
| `otherAmountThreshold` | “minimum output amount after slippage” = `outAmount − floor(outAmount × slippageBps / 10 000)` (measured on every sample) | `minAmountOut`, taken as given but only if within `[floor(out × (10 000 − bps) / 10 000), out]` |
| `priceImpactPct` | decimal **ratio** string (`"0.001"` = 0.1 %) | `priceImpactBps = ratio × 10 000` (2 decimals) |
| `routePlan[]` | legs: `swapInfo{ammKey,label,inputMint,outputMint,inAmount,outAmount}`, `bps` (share of the amount entering that leg's input mint; canonical in V2), `percent` (legacy) | one `RouteStep`; `via` = labels; `contracts` = aggregator program (`router`), DEX programs of the labels (`program`), pool accounts `ammKey` (`vault`) |
| `computeBudgetInstructions` | one `SetComputeUnitPrice` (micro-lamports/CU); **no** compute-unit limit | network-fee ceiling (see §6) |
| `setupInstructions`, `swapInstruction`, `cleanupInstruction`, `otherInstructions`, `tipInstruction`, `addressesByLookupTableAddress` | the transaction material (§3) | validated structurally, kept in `raw` |
| `blockhashWithMetadata{blockhash[32], lastValidBlockHeight, fetchedAt}` | recent blockhash, valid ~150 slots | `expiresAt = min(now, fetchedAt) + 30 s` |
| `transactionVersion` | `0` | must be `0` |

- **Platform fees.** `/build` has no `platformFee` field unless an integrator fee is requested (`platformFeeBps` +
  `feeAccount`, taken inside the swap instruction). The adapter requests none and **rejects** an answer carrying one.
  On V1 `/quote` the field is `platformFee: {amount, feeBps} | null`; on `/order` it is `feeBps`, `feeMint`, `platformFee`.
- **Validity.** Jupiter states none for the price. The only hard limit is the blockhash (`lastValidBlockHeight`,
  ≈ 150 slots ≈ 60 s); the adapter uses the contract's conservative 30 s.
- **Duration.** None given → `estimatedSeconds: null` (a Solana transaction confirms in seconds, but that is not the
  provider's figure).
- **No route** = `HTTP 400 {"error":"No routes found"}` (dust amounts, unknown mints) or
  `{"error":"Insufficient liquidity"}` (size) → empty array. Other 400s are failures: `Invalid amount`, `Invalid taker`,
  `inputMint cannot be same as outputMint`, a Zod error object for out-of-range parameters, and — observed once during the
  smoke run — `{"error":"500: {\"error\":\"Oracle price out of date. Pair temporarily unavailable\"}"}` (transient, the
  retry seconds later succeeded).

The route may pass through mints that are **not** in the wallet registry (USD1, cbBTC, mSOL… seen live) and may split
across parallel legs. Because the whole route is one atomic instruction and the intermediates never stay in the wallet,
the quote exposes a single `swap` step from the requested input to the requested output; the legs stay in `raw.routePlan`.
The adapter checks that the legs leaving the input mint sum to `inAmount` and the legs reaching the output mint sum to
`outAmount`.

What the adapter refuses locally (empty array, no HTTP call): `recipient ≠ sender` (a `/build` swap pays the taker's own
token account), a sender that is not a Solana address, non-positive or > u64 amounts, slippage that is not an integer in
0..10 000, any asset outside the registry.

## 3. Transaction shape (what execution would have to sign)

`/build` returns **instructions, not a transaction**. The integrator assembles, in this order
([Common Instructions](https://developers.jup.ag/docs/swap/build/common-instructions)): compute-budget instructions
(plus a `SetComputeUnitLimit` it must add itself after simulation) → `setupInstructions` → `swapInstruction` →
`cleanupInstruction` → `otherInstructions` → `tipInstruction`; fee payer = taker; lifetime = the returned blockhash.

- **Versioned transaction, v0, with address lookup tables.** `addressesByLookupTableAddress` maps each ALT address to
  its full address list, so no RPC fetch is needed to compile — but it also means **the ALT content comes from Jupiter**:
  a verifier must either fetch the tables from its own RPC or treat the listed addresses as untrusted input and check the
  resolved accounts. Recorded answers used 1 to 5 tables and 24 to 81 accounts in the swap instruction (pinned by test).
  `transactionVersion=1` requests a Solana v1 transaction (SIMD-0385: 4 096 bytes, ≤ 64 inline accounts, no ALT, compute
  budget on the message config, `@solana/kit` ≥ 8) — [Transaction Versions](https://developers.jup.ag/docs/swap/advanced/transaction-versions).
  Legacy transactions are not offered by V2 (`asLegacyTransaction` was V1).
- **Wrap / unwrap.** SOL input: `ATA.CreateIdempotent` (taker's wSOL account) + `System.Transfer` of exactly `inAmount`
  lamports into it + `Token.SyncNative`; cleanup `Token.CloseAccount` (wSOL account → taker). SOL output: cleanup
  `Token.CloseAccount` of the wSOL account back to the taker (pinned by test).
- **Token-account creation.** `ATA.CreateIdempotent` (instruction tag 1), payer and owner = taker, for the destination
  mint — under the **Token-2022** program for PYUSD/USDG — and, on some multi-hop routes, **also for intermediate mints**
  (a taker USDC and USDT account were created on a recorded SOL → PYUSD route). Each new account costs ≈ 0.00204 SOL of
  rent paid by the taker and is left open (rent recoverable by closing it). Jupiter does not report this cost.
- **Compute budget.** Only the price is given (50th percentile of recent fees by default); the limit must come from the
  integrator's own `simulateTransaction` (docs: 1.2 × consumed, max 1 400 000) and the price should be clamped —
  [Compute Units](https://developers.jup.ag/docs/swap/advanced/compute-units).

### Legacy / alternative endpoints (documented, not used)

- V1 `POST /swap/v1/swap` `{quoteResponse, userPublicKey, wrapAndUnwrapSol, useSharedAccounts, feeAccount,
  prioritizationFeeLamports, asLegacyTransaction, destinationTokenAccount, nativeDestinationAccount,
  dynamicComputeUnitLimit, dynamicSlippage, …}` → `{swapTransaction (base64, unsigned), lastValidBlockHeight,
  prioritizationFeeLamports}`. V1 `POST /swap/v1/swap-instructions` (same body) → `computeBudgetInstructions,
  setupInstructions, swapInstruction, cleanupInstruction, otherInstructions, addressLookupTableAddresses` (addresses only:
  the tables must be fetched by RPC). V2 `/build` = V1 `/quote` + `/swap-instructions` in one call, with V2 instructions.
- V2 `GET /swap/v2/order` (with `taker`) → `{transaction (base64, unsigned, v0 or v1), requestId, router, outAmount,
  feeBps, feeMint, lastValidBlockHeight | expireAt, errorCode…}`; then `POST /swap/v2/execute {signedTransaction,
  requestId}` → `{status: "Success"|"Failed", signature, code, totalInputAmount, inputAmountResult, outputAmountResult,
  totalOutputAmount}` — [Order & Execute](https://developers.jup.ag/docs/swap/order-and-execute).

## 4. Programs involved

| Program | Address | Role | Source |
|---|---|---|---|
| Jupiter v6 swap aggregator | `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` | the swap instruction of every recorded answer | named in the Jupiter docs ([JupiterZ RFQ v2](https://developers.jup.ag/docs/swap/routing/rfq/v2/streaming)); IDL in [jup-ag/jupiter-cpi-swap-example](https://github.com/jup-ag/jupiter-cpi-swap-example/blob/main/cpi-swap-program/idls/jupiter_aggregator.json) (same address); audits: [Offside Labs 2024 and 2025](https://developers.jup.ag/docs/resources/audits) |
| System | `11111111111111111111111111111111` | SOL transfer into the wSOL account | Solana |
| SPL Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | SyncNative, CloseAccount, classic mints | Solana |
| Token-2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | PYUSD, USDG | Solana |
| Associated Token Account | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | CreateIdempotent | Solana |
| Compute Budget | `ComputeBudget111111111111111111111111111111` | priority-fee price | Solana |

**AMM programs.** The route plan names venues by `label`; the program behind each label comes from Jupiter's own
`GET /swap/v2/program-id-to-label` ([reference](https://developers.jup.ag/docs/api-reference/swap/program-id-to-label)):
110 programs / 105 labels on 2026-11-10, snapshot in `jupiter-dexes.ts` and in the fixture `program-id-to-label.json`
(a test checks they agree and that, for every recorded leg, a program of its label really is among the swap instruction's
accounts). Venues seen in recorded and smoke routes, with their program ids from that endpoint:

| Label | Program | Label | Program |
|---|---|---|---|
| Whirlpool (Orca) | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | Raydium CLMM | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` |
| Raydium CP | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | Raydium | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` |
| Meteora DLMM | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | Meteora | `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB` |
| Manifest | `MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms` | PancakeSwap | `HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq` |
| GoonFi V2 | `goonuddtQRrWqqn5nFyczVKaie28f3kDkHWkHtURSLE` | BisonFi | `BiSoNHVpsVZW2F7rx2eQ59yQwKxzU5NvBcmKshCSUypi` |
| ZeroFi | `ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY` | Kipseli | `3TK9D8aoBFYjYZtKCjciPrVrRStsnvo7KmpcJqDavpaU` |
| Byreal | `REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2` | Scorch | `ojh19ojaKduoJZuaJADhcVGp4xt1TcdAvZmpVsCorch` |
| Deriverse | `DRVSpZ2YUYYKgZP8XtLhAGtT1zYSCKzeHfb4DgRnrgqD` | JupLend AMM | `jupZ4m2GqUCJ5iueMfzQf8khFfH31d4XAQt3RzCT9Vd` |
| Saber | `SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ` | DefiTuna | `fUSioN9YKKSa3CUC2YUc4tPkHJ5Y6XW1yz8y6F7qWz9` |
| 1DEX | `DEXYosS6oEGvk8uCDayvwEZz4qEyDJRf9nFgYCaqPMTm` | Perena | `NUMERUNsFCP3kuNmWZuXtm1AaQCPj9uw6Guv2Ekoi5P` |
| Token Swap | `SwaPpA9LAaLfeLi3a68M4DjnLqgtticKg6CnyNwgAC8` | Orca V1 | `DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1` |

The source for every one of these addresses is Jupiter's endpoint, not each DEX's own documentation: an execution phase
that allowlists AMM programs should confirm each against its publisher. The set is open-ended (Jupiter lists new venues
continuously; many of the busiest ones — GoonFi, BisonFi, ZeroFi, Kipseli, Scorch — are proprietary market-maker programs
with no public source), so an allowlist of AMMs will either reject many best routes (restrict with `dexes=`) or be
permanently behind.

## 5. What an isolated signer could verify by itself

Recipient and minimum output are **not** free-form: they sit at fixed places in the swap instruction. Observed on every
recorded answer and pinned by test (`structure of the recorded instructions`):

- `swapInstruction.programId` = the aggregator; Anchor discriminator `bb64facc31c4af14` (`route_v2`) or
  `d19853937cfed8e9` (`shared_accounts_route_v2`, preceded by a 1-byte authority id).
- Data, little-endian, after the discriminator (and id): `in_amount u64`, `quoted_out_amount u64`, `slippage_bps u16`,
  `platform_fee_bps u16` (0), a third `u16` (0, positive-slippage fee), then the route-plan vector (`u32` length = number
  of legs; per leg a venue enum, `bps u16`, input index, output index). So the instruction carries the **quoted output and
  the slippage**, and the program enforces `quoted_out × (1 − slippage)` (error 6001 `SlippageToleranceExceeded` in the
  IDL); `otherAmountThreshold` itself is not in the data.
- Accounts: `route_v2` → `[0]` taker (only signer), `[1]` taker's source token account, `[2]` taker's destination token
  account, `[3]` input mint, `[4]` output mint; `shared_accounts_route_v2` → `[1]` taker, `[2]` source, `[5]` destination,
  `[6]` input mint, `[7]` output mint. Source and destination are the taker's **associated token accounts** (derived with
  the mint's own token program), which the signer can recompute.
- Setup/cleanup contain only: `ATA.CreateIdempotent` for the taker's own accounts, `System.Transfer` taker → taker's wSOL
  account for exactly `inAmount`, `Token.SyncNative`, `Token.CloseAccount` wSOL → taker.

**Caveat:** the V2 instructions (`route_v2`, `shared_accounts_route_v2`) are **not in the public IDL files** (the
published IDL stops at `route` / `shared_accounts_route`, whose layout differs: route plan first, `platform_fee_bps u8`).
The V2 layout above is inferred from the discriminators (they match `sha256("global:<name>")`) and from nine recorded
answers. Before any execution, fetch the program's on-chain IDL and confirm it.

So a signer could **rebuild** the compute-budget, ATA, wrap and unwrap instructions itself, and **check** in the swap
instruction: program id, discriminator, input amount, quoted output, slippage, zero platform fee, taker as sole signer,
source/destination = its own ATAs, mints. It **cannot** rebuild or meaningfully check the remaining 20–75 accounts and the
venue-specific route data (pools, vaults, oracles, proprietary AMMs): a hostile answer could still route through a
malicious program placed among them. That is why the class is `opaque`, not `verified`.

**Post-conditions verifiable by simulation** (own RPC, `simulateTransaction` with `replaceRecentBlockhash`, requesting the
post-state of the taker's accounts): (1) no error; (2) the taker's input balance decreases by exactly `inAmount` (plus
fees and rent when the input is SOL); (3) the destination token account — or lamports, for SOL — increases by at least
`minAmountOut`; (4) no other token account owned by the taker loses balance, and none gets a new delegate or owner;
(5) lamport decrease ≤ fee + rent for the accounts created; (6) every writable signer-owned account is one of the expected
ATAs; (7) compute units consumed, to set the limit. Simulation is advisory (state can change before landing); the
on-chain slippage check is what binds. A Token-2022 mint with a non-zero transfer fee
would make (3) differ from the quote: the mint's fee configuration has to be read on-chain by the wallet (not checked in
this phase).

**Token-2022 (PYUSD, USDG).** The Swap docs make no statement about Token-2022 on `/build` (their only mention, “Supports
SPL and Token2022 tokens”, concerns referral fees on `/order`). That Jupiter routes both mints is established by live
answers (measured, both directions, against SOL, USDC and each other): the routes go through Manifest, Whirlpool and
others, the swap instruction references the Token-2022 program, and the destination account is created under it (pinned
by test). No Token-2022 swap was executed.

Approvals: none. Solana has no allowance step; the taker signs the transaction that moves its own tokens.

## 6. Fees

- **Jupiter:** none on `/build`. (On `/order`: 0 bps pegged pairs/Jupiter tokens, 2 bps SOL↔stable, 5 bps LST↔stable,
  10 bps otherwise, 50 bps for tokens < 24 h old, shown as `feeBps`/`feeMint`.)
- **Integrator fee:** optional `platformFeeBps` + `feeAccount` on `/build` (any token account of the integrator); not used.
- **AMM / LP fees:** inside the quoted `outAmount`; V2 route plans no longer itemise them.
- **Network:** 5 000 lamports per signature + priority fee (`price × compute-unit limit`). The quote reports **one
  `network` FeeItem, estimated, a ceiling**: `5 000 + ceil(price × 1 400 000 / 10⁶)` lamports — typically 6 000–18 000
  lamports (< 0.002 USD). Real cost is lower once the limit is simulated. **Not included:** rent for token accounts the
  swap creates (≈ 0.00204 SOL each, sometimes for intermediate mints, see §3) — the largest real cost for a first swap.
- `/submit` landing (optional): a Jupiter tip of at least 0.001 SOL per transaction.

## 7. Sending, status and tracking

- `/build` transactions are sent through the wallet's **own RPC** (`sendTransaction`) and tracked with
  `getSignatureStatuses` / blockhash expiry (`lastValidBlockHeight`); Jupiter offers **no** status endpoint for them
  (“`/build` transactions cannot use `/execute`”).
- Optional landing service: `POST https://tx.jup.ag` (JSON-RPC `sendTransaction`, base64) — **requires an API key** and a
  tip ≥ 1 000 000 lamports to one of 16 tip accounts (`tipAmount` on `/build` adds the instruction); send-only, no
  confirmation queries — [Transaction Submission](https://developers.jup.ag/docs/transaction/submit).
- `/order` path: `POST /execute` lands, polls and returns the final status with the executed amounts (codes: 0 success,
  −1 unknown `requestId`, −1000 failed to land, −1005 expired, −2003 RFQ quote expired…).
- Every response carries `x-api-gateway-request-id` (the id to quote to support). API status: <https://status.jup.ag>.
  Breaking changes are announced on Discord / Telegram `jup_dev`.

**Refunds.** Not applicable: a swap is one atomic transaction. If the minimum is not met or any leg fails, the whole
transaction reverts and only the network fee is spent (`atomic: true`, `refundable: true`). An unsent or expired
transaction moves nothing.

## 8. Terms of use (SDK & API License Agreement)

<https://developers.jup.ag/docs/legal/sdk-api-license-agreement> — points that constrain this wallet:

- **§2.3 labelling:** the specific API used must be shown prominently to end users; anything other than Ultra must be
  labelled **“Metis”**. The provider name is “Jupiter (Metis)”; the UI must keep it.
- **§3.2 f:** no access “for competitive analysis” and no dissemination of “performance information (including uptime,
  response time and/or benchmarks)”. The latency figures above and the provider statistics of the runtime must stay
  internal.
- **§3.2 g:** no combining API content “with content obtained through scraping or any other means outside the API”. A
  multi-provider comparison screen and the CoinGecko check in the smoke script sit close to this clause — **to be
  confirmed with Jupiter (info@jup.ag, §2.4) before a public release.**
- **§3.2 d/e:** no resale of API content; no usage beyond “reasonable request volume” — keep to the rate limit.
- **§5.2 / §12:** no availability guarantee; Jupiter may change or stop the API without notice.
- **§2.5 / §7.3:** the licensee is responsible for sanctions and KYC/AML compliance towards its users.

## 9. Not fitted / open points

- **`/order` (Meta-Aggregator) is deliberately not used:** its transaction cannot be modified, it is co-signed and landed
  by Jupiter or a market maker, and without `taker` it returns `slippageBps: 0` with `otherAmountThreshold = outAmount`
  (no guaranteed minimum). It often quotes slightly better (RFQ) but charges the platform fee.
- The quote needs the wallet's real address (`taker`), so it is sent to Jupiter with every price check.
- A third-party recipient is possible on `/build` (`destinationTokenAccount` / `nativeDestinationAccount`) but would need
  ATA derivation in the adapter; refused for now.
- The contract's one-step-per-hop model does not fit split routes through unregistered mints; one step is reported.
- Fixtures are re-recorded with `npx tsx scripts/record-swap-jupiter-fixtures.mts` (the 429 and the stale-oracle answers
  were captured separately); live check: `npx tsx scripts/smoke-swap-jupiter.mts`.
