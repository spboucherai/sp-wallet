# Jupiter (Solana) — provider dossier

Provider id `jupiter`, displayed as **“Jupiter (Metis)”**. Adapter: `packages/swap/src/providers/jupiter.ts`
(+ `jupiter-dexes.ts`) for price discovery. **Execution is enabled since 2026-11-10 (V5)** for one transaction shape only —
see **§10** (`packages/core/src/swap-sol.ts`, `services/api/src/swap-exec-sol.ts`). The quote adapter itself is unchanged
and still classifies its raw answer as `opaque`; the API marks the route executable and the verification happens when a
swap is prepared. §1–§9 below describe the provider as surveyed before execution; where §10 supersedes them it says so.

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

**Caveat (resolved in §10.2):** the V2 instructions (`route_v2`, `shared_accounts_route_v2`) are not in the IDL file
published on GitHub (it stops at `route` / `shared_accounts_route`, whose layout differs: route plan first,
`platform_fee_bps u8`), but they **are in the program's on-chain IDL**, which confirms the layout above.

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

## 10. Execution (V5, 2026-11-10)

Scope: swaps between **SOL and the SPL tokens of the wallet registry** on Solana, exact input, output to the wallet itself.
Proof: `npx tsx scripts/sim-jupiter.mts` (mainnet simulation only; nothing was ever sent). Statements marked
**(simulated)** come from that script's output on 2026-11-10; **(on-chain)** from account data read on
`api.mainnet-beta.solana.com` and `solana-rpc.publicnode.com`; **(docs)** from the cited page.

### 10.1 Sources read

- [GET /build reference](https://developers.jup.ag/docs/api-reference/swap/build) (parameters `taker`, `slippageBps`,
  `transactionVersion`, `wrapAndUnwrapSol`, `platformFeeBps`/`feeAccount`, `payer`, `destinationTokenAccount`,
  `nativeDestinationAccount`, `maxAccounts`, `dexes`/`excludeDexes`, `tipAmount`, `computeUnitPricePercentile`),
  [Build](https://developers.jup.ag/docs/swap/build),
  [Common Instructions](https://developers.jup.ag/docs/swap/build/common-instructions),
  [Transaction Versions (v0 and v1)](https://developers.jup.ag/docs/swap/advanced/transaction-versions),
  [Compute Units](https://developers.jup.ag/docs/swap/advanced/compute-units),
  [Rate Limits](https://developers.jup.ag/docs/portal/rate-limits),
  [SDK & API License Agreement](https://developers.jup.ag/docs/legal/sdk-api-license-agreement).
  The V1 parameters `userPublicKey`, `asLegacyTransaction`, `useSharedAccounts`, `dynamicComputeUnitLimit`,
  `prioritizationFeeLamports` belong to `POST /swap/v1/swap[-instructions]` ("no longer actively maintained") and are not
  parameters of `/build`; passing `useSharedAccounts=true` to `/build` had no visible effect (measured).
- The aggregator program `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` **(on-chain)**: owned by
  `BPFLoaderUpgradeab1e11111111111111111111111`, ProgramData `4Ec7ZxZS6Sbdg5UGSLHbAnM7GQHp2eFd4KYWRexAipQT`, last deployed
  at **slot 462802085**, executable 2 892 224 bytes, SHA-256
  `53d53f447f594158a259cbdca1f5e613caf40bc14ce759ffd5953580dc2af8dd`, **upgrade authority
  `CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ`** (a system-owned account with no data; whether a multisig stands behind
  it was not established). Identical on both endpoints.
- Its **on-chain Anchor IDL** (account `C88XWfp26heEmDkmfSzeXP7Fd7GQJ2j9dDTUsyiZbUTa`, zlib JSON, 36 kB, IDL authority
  `9u9iZBWqGsp5hXBxkVZtBTuLSGNAG9gEQLgpuVw39ASg`). No source code of the program was found or read: everything about its
  behaviour below comes from the IDL and from simulation.

### 10.2 The instructions (on-chain IDL)

| Instruction | Discriminator | Arguments (little-endian) | Fixed accounts |
|---|---|---|---|
| `route_v2` | `bb64facc31c4af14` | `in_amount u64, quoted_out_amount u64, slippage_bps u16, platform_fee_bps u16, positive_slippage_bps u16, route_plan Vec<RoutePlanStepV2>` | `[0]` user_transfer_authority (signer), `[1]` user_source_token_account, `[2]` user_destination_token_account, `[3]` source_mint, `[4]` destination_mint, `[5]` source_token_program, `[6]` destination_token_program, `[7]` destination_token_account (optional), `[8]` event_authority, `[9]` program |
| `shared_accounts_route_v2` | `d19853937cfed8e9` | `id u8`, then the same | `[0]` program_authority, `[1]` user_transfer_authority (signer), `[2]` source_token_account, `[3]` program_source_token_account, `[4]` program_destination_token_account, `[5]` destination_token_account, `[6]` source_mint, `[7]` destination_mint, `[8]` source_token_program, `[9]` destination_token_program, `[10]` event_authority `D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf`, `[11]` program |

Also present and **never signed**: `route`, `route_with_token_ledger`, `shared_accounts_route`, `exact_out_route`,
`shared_accounts_exact_out_route`, `exact_out_route_v2`, `shared_accounts_exact_out_route_v2`, `route_with_attestation`,
`shared_accounts_route_with_attestation`, and the housekeeping instructions. `RoutePlanStepV2 = { swap: Swap (enum of
venues), bps u16, input_index u8, output_index u8 }`; the plan stays opaque to the signer. Derived and pinned by test on
every recorded answer: program authority = PDA `["authority", id]`; the program's own token accounts `[3]`, `[4]` = its
associated token accounts for the two mints.

**Minimum output (simulated).** With the real output `A` of a still pool: `quoted = A, 0 bps` succeeds; `quoted = A + 1,
0 bps` fails with 6001 `SlippageToleranceExceeded`; at 1 bp a quoted amount whose exact minimum is `A + 0.48` fails. The
program therefore enforces **ceil(quoted × (10 000 − bps) / 10 000)** at the destination account (the same figure as the
API's `otherAmountThreshold`). The signer uses **floor(…)**, a lower bound of it; the approved minimum shown to the owner
is that floor (one base unit under Jupiter's figure when the product is not whole).

### 10.3 Why only `shared_accounts_route_v2` is signed

In `route_v2` the venue programs of each leg are invoked **with the wallet's signature** and take their input straight from
whatever accounts the route lists. The program does **not** tie those legs to the declared source account: a genuine
`USDT → SOL` `route_v2`, re-declared as "USDC → SOL, source = the wallet's USDC account" by editing accounts `[1]` and
`[3]` only, **executes and debits 20 USDT** **(simulated)**. A signer that checks the declared accounts of a `route_v2`
would be approving something else. Beyond that, `route_v2` lends the wallet's signature to the venue programs of the route
(about 110 are listed by Jupiter, several without public source), with accounts chosen by the route builder. No offline
check makes that comparable to the EVM path, so **`route_v2` is refused whatever it declares**.

In `shared_accounts_route_v2` the declared source account is bound: the same re-declaration fails inside the aggregator
with the token program's "Account not associated with this Mint" **(simulated)**, i.e. the aggregator itself moves the
input out of the declared account, and the simulated debit is exactly `in_amount`. In the routes Jupiter builds this way
the legs name the **program authority** and the program's own token accounts, not the wallet. The signer additionally
requires that **neither the wallet nor its source/destination account appears among the route's accounts**, so that no
venue can be handed the wallet's signature (Jupiter does build some shared-accounts routes with the wallet inside a leg —
seen in routes that included Kipseli, Perena or Bonkswap legs — those are refused too).

**Consequence and deviation.** `/build` answers direct routes (the usual case for SOL ↔ USDC and other liquid pairs) with
`route_v2`, and has no documented parameter to ask for the other form. The API therefore **rewrites** a `route_v2`
instruction into `shared_accounts_route_v2` (`jupiterRouteToShared`: same route plan; discriminator and `id` byte; the
wallet and its token accounts inside the legs replaced by the program authority and the program's own token accounts,
including for intermediate mints) and keeps it only if the exact bytes simulate successfully. This is not a documented
Jupiter feature; it relies on the two instructions sharing their route format, which held for the routes met in the proof
runs (most recorded pairs were rewritten) and fails cleanly — simulation error, then another route is requested without the
venues already tried, at most three `/build` calls — for venues that need the wallet inside a leg. The signer does not care
who built the instruction: it checks the result.

### 10.4 Lookup tables: none

A v0 transaction refers to most accounts through address lookup tables whose content the signer cannot read offline; the
API would have to supply it, and a table can be created by anyone. Rather than reason about what may hide behind a table,
the wallet uses **Solana v1 transactions** ([SIMD-0385](https://solana.com/upgrades/larger-transaction-sizes), live on
mainnet: confirmed v1 Jupiter transactions were read back from both RPC endpoints): 4 096 bytes, at most 64 accounts,
**all inline**, compute budget in the message header. `/build?transactionVersion=1` returns instructions for it. The signer
**refuses any message whose first byte is not `0x81`** — legacy and v0 alike — so there is no table to trust. With every
account visible, the signer also refuses a transaction that references any *other* registry token account of the wallet.
Recorded messages: 20–61 accounts, 845–2 290 bytes. Routes that need more than 64 accounts cannot be expressed and are not
offered.

Wire format (hand-written in `swap-sol.ts`, cross-checked against `@solana/kit` 8.6 in tests): `0x81`, header (3 bytes),
config mask `u32` (must be `0x0f`: priority fee, compute-unit limit, loaded-accounts data limit; no heap request), blockhash,
instruction count, account count, accounts, config values (`u64` lamports, `u32`, `u32`), instruction headers, payloads;
the transaction is the message followed by the 64-byte signature. The node accepts the signer's signature and rejects it
with one bit flipped **(simulated with `sigVerify: true`)**.

### 10.5 What the signer guarantees before signing (`verifyJupiterSwap`)

From the message bytes alone, with the intent the owner approved by passkey (which commits to the SHA-256 of those bytes):

1. v1 message, exact length, no trailing bytes, unique accounts; **one required signature, the fee payer, = the wallet**;
   the blockhash is the approved one and not zero.
2. Compute budget: limit and priority fee equal the approved ones (`limit ≤ 400 000`, fee =
   `ceil(limit × price / 10⁶)`); **5 000 + priority fee + rent bound ≤ the approved fee ceiling**, itself ≤ the policy
   ceiling for Solana (0.003 SOL).
3. Instruction list, in this order and nothing else: `ATA.CreateIdempotent` for the wallet's own associated token account
   of the input or output mint (payer and owner = wallet) · when SOL is sold, `System.Transfer` wallet → its own wSOL
   account for **exactly the approved amount** then `Token.SyncNative` · **one** Jupiter instruction ·
   when SOL is sold or bought, `Token.CloseAccount` of the wallet's wSOL account **to the wallet**. No other program, no
   ComputeBudget instruction, no transfer, approve, setAuthority or close for anyone else.
4. Jupiter instruction: pinned program id; `shared_accounts_route_v2` only; the twelve fixed accounts are exactly the
   derived ones (program authority for `id`, wallet, wallet's source ATA, program's source and destination accounts,
   wallet's destination ATA, the two registry mints — wSOL for SOL —, their token programs, event authority, program);
   `in_amount` = approved amount; `floor(quoted_out × (10 000 − slippage_bps) / 10 000)` ≥ approved minimum;
   `platform_fee_bps = 0`; `positive_slippage_bps = 0`; route accounts contain neither the wallet nor its two accounts.
5. Both assets are registry assets on Solana and differ; `to = from`; policy limits as for a send (per operation, per day,
   fee ceiling, approval window, halt); one signature per proposal.

Anything else is refused: see the mutations in the proof script and in the unit tests. Several of them **would have
executed on-chain** (another destination account, a halved minimum, a doubled input, an extra transfer, approve or
third-party close) — the checks are what stops them.

### 10.6 Residual trust (what the signer cannot prove)

- **The aggregator program's own behaviour.** Its source was not read. That it takes exactly `in_amount` from the declared
  source and reverts unless the declared destination receives the minimum is established by its IDL, by mainnet
  simulation of the recorded pairs, and by the failing mutations above — not by reading code, unlike the KyberSwap router.
  In particular, that the aggregator never passes the wallet's signature to a venue when the wallet is absent from the
  route accounts follows from how its routes are built and from Solana's rule that a program can only pass on accounts
  it lists; it was not read in code.
- **Upgradeability.** The program can be replaced by its upgrade authority at any time; a replaced program could do
  anything the wallet's signature allows on the accounts named in the transaction. Mitigation: `JUPITER_PIN` (ProgramData
  address, last-deploy slot, upgrade authority, executable hash). The API refuses to prepare a swap unless the ProgramData
  header shows the pinned slot and authority **on both RPC endpoints**, and re-hashes the 2.9 MB executable on both at
  first use and every six hours. This is an API-side guard: the signer cannot see the chain. An upgrade landing between
  preparation and inclusion (seconds) is not covered. After any upgrade swaps stop until the new deployment is reviewed
  and the pin changed in code.
- **The route between source and destination**: venues, pools, intermediate mints are not checked (as with KyberSwap's
  executor data). The worst a hostile route can do, if the program behaves as observed, is deliver only the approved minimum.
- **Rent.** A new token account costs a deposit set by the protocol (measured 0.00148844 SOL for a 165-byte account on
  2026-11-10). The signer bounds it with constants (`RENT_TOKEN_ACCOUNT` 2 039 280 lamports; 2 498 640 for a Token-2022
  account of up to 231 bytes, both at the historical rent rate). The deposit stays in the wallet's own token account. If the protocol raised rent above
  these bounds, the API's simulation would refuse the swap; the signer's figure would no longer be a bound.
- **Token-2022 (PYUSD, USDG): handled, with an API-side guard.** Accounts are derived with the Token-2022 program and the
  instruction must name it. The mint's extensions are read on both endpoints before preparing: a non-zero **transfer fee**
  or a **transfer hook program** → refused. The signer cannot see the mint. PYUSD simulated in both directions; USDG not.
- **Other wallet accounts the signer cannot name**: token accounts of the wallet that are not the associated account of a
  registry mint are not recognised by address.
- The API and the RPC endpoints for everything that is not in the message: balances, simulation, confirmation.

### 10.7 API life cycle

`POST /api/v1/swap/proposals` with `network: "solana"` → `kind: 'swap'` proposal in the existing table and worker.
Prepare: genesis hash on both endpoints; program pin; wallet is a plain system account; Token-2022 guard; balance;
`/build` (v1, no fee, no tip, no referral; an answer carrying a platform fee, a tip, lookup tables, another amount or mint
is refused); arrangement/rewrite; the signer's own verification; **simulation of the exact bytes** (`sigVerify: false`,
own blockhash) which must succeed, spend exactly the amount, deliver ≥ the minimum, cost exactly the computed fee and at
most the rent bound, and show no other token account of the wallet (nor its lamports) losing value. Then passkey approval
over the intent hash, signature, and a **second simulation of the signed bytes with the signature checked** before
`sendTransaction` (existing relay to both endpoints, existing rebroadcast: always the same bytes, hence the same signature
— a retry can never become a second swap). A blockhash that is no longer valid before sending → failed without sending;
not included before `lastValidBlockHeight` → failed, nothing moved. Outcome = the wallet's real balance change from the
confirmed transaction's `pre/postBalances` and `pre/postTokenBalances` (`maxSupportedTransactionVersion: 1`). Audit:
`swap.prepared`, `swap.not_sent`, `swap.settled`, plus the usual `transfer.*`. One operation in flight per network, as for
sends.

Costs shown to the owner before approval: network fee (5 000 lamports + priority fee; Jupiter's suggested price, capped at
2 lamports per compute unit and lowered if the fee ceiling requires), the deposit of a new token account when one is
created, the approved ceiling.

### 10.8 Licence and rate limits in execution

- **§2.3 label:** every place a Jupiter route or swap is shown says **"Jupiter (Metis)"** (route cards, execute button,
  review sheet, API `swap.detail.label`).
- **Rate limit:** execution calls `/build` at most once every 2.1 s and at most three times per swap, in the same keyless
  bucket as quotes (0.5 request/s); a 429 is reported to the owner, not retried in a loop. `JUPITER_API_KEY` is used if set.
- **No integrator fee, no referral, no tip** are requested, and an answer or instruction carrying one is refused.
- The rewrite of §10.3 changes the instruction Jupiter returned. The licence text read does not address it, and this use
  was **not confirmed with Jupiter**.
- §3.2 f/g (no benchmarks, no mixing with other sources) still applies to anything derived from the API; the simulation
  figures in this file and the script output stay internal.

### 10.9 Verified / not verified

Verified (2026-11-10): on-chain IDL and program data on two endpoints; v1 transactions accepted by both endpoints
(simulation, and confirmed ones read back); swaps prepared by the real API code for public funded addresses, signed by the
real signer code with that address standing in for the wallet, the signed bytes simulated successfully with outputs ≥ the
verified minimum (USDC→SOL with and without an existing wSOL account, SOL→USDC twice, USDC→JUP creating the token account,
JUP→USDC, USDC→USDT, USDC→PYUSD, PYUSD→USDC, USDC→BONK); signature format with a fresh unfunded key (`sigVerify: true`);
the minimum-output rule; the refusals; the `route_v2` re-declaration.

**Not verified:** any transaction actually sent, landed or confirmed on Solana (so: real inclusion, priority-fee adequacy,
the worker's confirmation path against a live cluster, the outcome read from a real confirmed swap of this wallet);
`solana-test-validator` was not available on this machine and was not installed; the program's source; who controls the
upgrade authority; behaviour of the rewrite for venues not met in the proof runs; Token-2022 mints with an active fee or
hook (refused, not exercised on-chain); USDG; routes above 400 000 compute units (refused); the web screens in a browser;
Jupiter's position on the rewrite.
