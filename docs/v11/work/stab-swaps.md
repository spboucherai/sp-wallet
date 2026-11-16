# V11 — work note: stabilisation (Phase B) and swaps (part of Phase G)

Branch `v11-stab-swaps`, from local `v11` (`fe705be`). Date: 2026-11-15. Source of the items: `docs/V11-AUDIT.md` and
`docs/v11/audit-parts/web-api-swaps.md`.

Nothing here was pushed, deployed, or run against a production node. No transaction was sent: every test runs against
scripted chains, scripted providers and per-run databases. The web changes were **not exercised in a browser** (no
Playwright run, see "Not done").

## Checks observed on this branch

| Command | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm test` | **127 files, 2 763 tests, all passed** (68 s) — baseline was 123 files, 2 682 tests |
| `node scripts/build.mjs && (cd apps/web && node_modules/.bin/vite build)` | exit 0; first chunk `index-*.js` **258.41 kB** (79.46 kB gzip) — was 257 kB |

One thing about the test run, stated plainly: in a fresh worktree `research/.venv` does not exist, and without it
`services/api/test/perp-agent.test.ts` has one failing test (the strategy laboratory cannot start) and two test files
are skipped (`lab-sandbox.test.ts` is one of them). First run, without it: 2 failed — that test and the collateral assertion
described under B2, corrected since — 2 702 passed, 59 skipped.
The run above was made with `research/.venv` linked to the main checkout's; the link was removed afterwards. Nothing in
this branch touches `services/api/src/agents/**` or `research/`.

Tests added: `services/api/test/v11-stab.test.ts` (29), `packages/swap/test/keyed-comparison.test.ts` (10),
`packages/swap/test/card.test.ts` (7), `apps/web/test/v11-stab.test.ts` (17), and new cases in `api.test.ts` (+5),
`bridge.test.ts` (+4), `xswap.test.ts` (+4), `plan-exec.test.ts` (+3), `swap-sol.test.ts` (+2).

---

## 1. B1 — « Vous recevez » shows what is executed

- **Initial state.** `chosen = sorted[0]` fed the hero: on a CCTP pair it showed LI.FI's quote or the other CCTP speed; on
  any pair it showed a comparison-only quote when one ranked first, while the button executed something else.
- **Change.** `apps/web/src/swapLogic.ts` `heroOf()`: the hero is the selected CCTP option on a CCTP pair, the executable
  route otherwise, and **nothing** when no route is executable here. The best quote, when it is not the executed one, is
  named underneath as a comparison (`svHeroBestOther`), with the provider that executes written next to the minimum.
- **Files.** `apps/web/src/swapLogic.ts` (new), `apps/web/src/screens/Swap.tsx`.
- **Tests.** `apps/web/test/v11-stab.test.ts` "B1 / B6" (CCTP pair with a better LI.FI quote and the other speed; same-network
  pair with comparison quotes first; nothing executable; option unavailable or not answered yet).
- **Observed.** Unit tests pass. **Limitation:** not seen in a browser; the v9 / v10 visual baselines of the Swap screen
  will differ and were not regenerated.

## 2. B2 — "signed, not broadcast" is its own state

- **Initial state.** With `SPW_BROADCAST=off`, `broadcastNow` moved the proposal to `broadcast` with the English text
  `broadcast disabled (test mode)`; the row never left that state, every later operation on the network answered
  `pending_tx`, and the UI recognised the case with a regular expression on that sentence.
- **Change.** New terminal proposal state **`not_broadcast`** (`packages/core/src/state.ts`: `signed → not_broadcast`, no way
  out), written with error code `broadcast_disabled`. It is not one of the in-flight states, is not in `/portfolio.pending`,
  has no explorer link, no `broadcast_at`, and does not make its destination a "known" address. A plan leg in that state is a
  failed attempt (the plan pauses with the reason) instead of staying in flight for ever. The schema migration turns rows left
  in `broadcast` with the old text into `not_broadcast`. UI: `testNotSent()` reads the state (or the code); the regular
  expressions in `ui.tsx` and `AgentFund.tsx` are gone.
- **Files.** `packages/core/src/state.ts`, `services/api/src/transfers.ts`, `db.ts`, `plan-state.ts`, `apps/web/src/ui.tsx`,
  `i18n.ts` (`stateKey`), `screens/AgentFund.tsx`, `xswap.tsx`, `screens/Swap.tsx`.
- **Tests.** `v11-stab.test.ts` (API) "B2" (state machine, migration, plan leg); `api.test.ts` "a transfer signed with broadcast
  off does NOT hold the network; a transfer really in flight still does"; web "B2".
- **Observed.** A second transfer on Base is prepared right after a not-broadcast one; a row forced to `broadcast` still blocks.
- **Limitations / for the derivatives owner.** `services/api/src/derivatives/**` was not edited. A venue collateral deposit
  signed with broadcast off now has `proposalState: 'not_broadcast'` (one assertion of
  `services/api/test/derivatives-collateral.test.ts` was changed accordingly — a test file of that area, one line), but the
  collateral operation itself still says `sent`, and `collateral.ts`'s list of dead proposal states does not contain
  `not_broadcast`: that operation waits for ever, as before. `gmx-exec.ts` moves its own proposals to `broadcast` and is
  unchanged. Agent-vault withdrawals already had their own `not_sent`.

## 3. B4 / B5 — idempotent preparation; a plan resumes

- **Initial state.** `POST /swap/proposals`, `/bridge/proposals`, `/xswap/proposals` did the whole preparation, then answered
  `409 conflict` on a repeated `Idempotency-Key`. A plan that stopped between "proposal created" and "plan saved" reused the
  same key for ever and stayed on `conflict`.
- **Change.** `services/api/src/prepare-common.ts`: the parsed body is fingerprinted (`proposals.request_hash`). The same key
  with the same body answers `{ proposal, options, replayed: true }` **before** any provider or chain is asked — `options` is
  the passkey challenge again (always the fingerprint of the stored intent) while the proposal can still be approved, `null`
  afterwards. The same key with another body, or for another kind, answers `409 idempotency_mismatch`. A concurrent request
  that loses the insert answers the winner's proposal. `POST /transfers/proposals` keeps answering the existing draft and now
  also refuses another body under the same key. The web client keeps one key per attempt until it is answered.
  B5 follows: `/plans/:id/prepare` gets a 200 with the existing proposal and attaches it; if that proposal expired meanwhile,
  the plan records the attempt as expired and prepares a fresh one under a new key.
- **Files.** `prepare-common.ts` (new), `swap-exec.ts`, `swap-exec-sol.ts`, `bridge.ts`, `bridge-sol.ts`, `xswap.ts`,
  `transfers.ts`, `db.ts` (column `request_hash`), `apps/web/src/screens/Swap.tsx`.
- **Tests.** `v11-stab.test.ts` "B4" (fingerprints, existing row, mismatch, lost race); `swap-sol.test.ts`, `bridge.test.ts`,
  `xswap.test.ts` "B4" (same proposal and challenge, no provider call — Jupiter builds, Circle calls and THORNode operators
  counted — mismatch, the replayed challenge approves, replay after approval); `api.test.ts` (transfers);
  `plan-exec.test.ts` "B5" ×2 (the plan row is rewound to before the attach, as a crash leaves it).
- **Observed.** All pass. **Limitation:** rows written before v11 have no fingerprint: for them only the kind is compared.
  The Solana-source CCTP path (`bridge-sol.ts`) shares the code but has no dedicated replay test.

## 4. B6 — the route shown is the route prepared

- **Initial state.** Prepare sent pair, amount and tolerance only; the server re-quoted silently. The UI decided "this is a
  THORChain swap" from which routes were in the stream.
- **Change.** Every route carries `executor` (stated by the server from the pinned tables) and a `fingerprint` of what it
  promises (provider, pair, amount in, tolerance, amounts out). The `start` event and the quote summary carry `executors` for
  the **pair** (`pairExecutors`). Prepare bodies accept an optional `quote: { id, provider, fingerprint, amountOut,
  minAmountOut, quotedAt }`; `/bridge/quote` gives one per option. The server prepares its firm route as before, then:
  `422 quote_not_executable` when the reference names a provider that does not execute; `400 quote_mismatch` when it is not for
  this pair / amount / tolerance; **`409 quote_moved`** when the firm expected output is below the minimum that was displayed,
  with `data.quoted`, `data.fresh` (amounts, displays, its own fingerprint), `data.deviationBps`. Otherwise the proposal stores
  the quoted and the firm figures (`proposals.quote_ref`, shown on the review sheet). The error handler now sends `data` when a
  `UserError` carries one. The UI posts through the executor of the displayed route (`prepareOf`), shows the fresh figures on
  `quote_moved` and relaunches the quotes; when the pair has an executor that gave no quote it says so instead of posting to
  the wrong route.
- **Nothing here is trusted for safety**: the signer verifies every value-moving field as before. The reference protects the
  owner from a silent change, and it is optional (API clients and plan legs send none; a plan re-quotes each leg and has its
  own floor).
- **Files.** `prepare-common.ts`, `swap.ts`, `swap-exec.ts`, `swap-exec-sol.ts`, `bridge.ts`, `bridge-sol.ts`, `xswap.ts`,
  `server.ts` (error `data`), `db.ts` (`quote_ref`), `transfers.ts` (view `quote`), `apps/web/src/swapLogic.ts`, `Swap.tsx`.
- **Tests.** `v11-stab.test.ts` "B6" (recorded within tolerance, refused beyond with the fresh figures, wrong provider / pair /
  amount / tolerance / edited amounts, pair executors); `swap-sol.test.ts`, `bridge.test.ts` (Circle's fee raised between quote
  and prepare), `xswap.test.ts` "B6"; web "B1 / B6".
- **Limitation.** No KyberSwap HTTP-level test of the reference (the EVM swap path has no scripted-chain suite; the check is the
  same function). A loss is rounded away from zero in `deviationBps`.

## 5. B3 — server sentences become codes + parameters

- **Initial state.** English sentences from the server printed raw in the French UI.
- **Change.** `services/api/src/sv-texts.ts` is the catalogue (code → English template). Stored next to the sentence:
  `proposals.error_code` / `error_params` (view: `errorCode`, `errorParams`); `holdCode` / `holdParams` on CCTP and THORChain
  holds; `params` and `reason` on a plan pause; `errorCode` / `errorParams` on a plan attempt; `params` on risk flags; `code` on
  an executability reason. The English `error` / `holdDetail` / `message` / `detail` / `reason` stay for API clients.
  Client: `apps/web/src/sv.ts` and ONE contiguous `sv` block in `i18n.ts` (after the `dz` block). A code without a text shows
  the server's sentence as sent — never both.
- **Places converted** (audit table): `prop.error` in the swap, CCTP and THORChain sheets, Activity, and the transfer tracking
  of Send; `holdDetail` of CCTP and THORChain; plan `pause.message`, last attempt, skipped plan; risk flag details;
  `executability.reason`; the leg error of AgentFund.
- **Files.** `sv-texts.ts` (new), `transfers.ts`, `worker.ts`, `swap-exec.ts`, `swap-exec-sol.ts`, `bridge.ts`, `bridge-sol.ts`,
  `xswap.ts`, `xswap-state.ts`, `plan-state.ts`, `plan-exec.ts`, `packages/swap/src/{types,risk}.ts` and the seven adapters,
  `apps/web/src/{sv.ts,i18n.ts,bridge.tsx,xswap.tsx,plan.tsx}`, `screens/{Swap,Activity,Send,AgentFund}.tsx`.
- **Tests.** API `v11-stab.test.ts` "B3"; `bridge.test.ts`, `xswap.test.ts`, `plan-exec.test.ts` "B3"; web "B3": every server
  code has `sv_<code>` in French and English with exactly the server's parameters, no orphan key, the block is contiguous,
  the screens no longer print the raw fields.
- **Not converted (outside the list given, left as they are):** AgentFund withdrawal errors, PerpAgent / PerpAgentLive /
  Research reasons, Monitor details, `errText` appending the English detail when it contains a digit, HTTP error messages of
  the routes (translated by `e_<code>` where a key exists), `bridge.delayReason` (Circle's own word, shown as data). A free
  technical message (an RPC error, a signer refusal) is a parameter inside a translated sentence, not translated itself.

## 6. Low — Activity kind and CSV

- **Change.** `/activity`: a GMX order transaction has `kind: 'gmx'` (was `send`), every row has `rawKind`. CSV: `direction` is
  the real kind (`send | swap | bridge | xswap | gmx | receive`) and three columns are appended — `to_network`, `to_symbol`,
  `received` (filled only when the chain said what was delivered).
- **Files.** `server.ts`, `apps/web/src/screens/Activity.tsx`. **Tests.** API `v11-stab.test.ts` "B7", `api.test.ts`.
- **Limitation.** A consumer that expected `send` for swaps and bridges in the CSV sees the new values.

## 7. Normalized route card (Phase G)

- **Change.** `RouteCard` in `packages/swap/src/types.ts` (the existing file; no parallel type), built by
  `packages/swap/src/card.ts` from the legs the adapters returned: amount sent, estimated and minimum received, network fee
  (native items + USD), protocol fee (USD + bps), tolerance, effective slippage against the reference price, ETA, risk flag
  codes, `steps[]` (kind, network, provider, description code), `quotedAt` / `expiresAt`, `executable`, `executor`,
  `reasonCode`, `fingerprint`. `SwapQuote` gained `quotedAt` (set by each adapter) and the executability a `code`.
  **Rule applied: real values only** — no fee item means `null`, not zero; one unpriced item makes the USD total `null`; the
  basis points of a protocol fee are exact when charged in the asset sent, from the price reference otherwise, else `null`.
  The API adds display strings (`card` on each route of `/swap/quote` and of the stream). The Swap screen shows the same lines
  for every route, with « non communiqué par le fournisseur » where a value is null, and the quote's age.
- **Files.** `packages/swap/src/{types,card,index,router}.ts`, adapters, `services/api/src/swap.ts`, `Swap.tsx`.
- **Tests.** `packages/swap/test/card.test.ts`; `api.test.ts` "every route carries the normalized card".
- **Limitation.** "Effective slippage" is the estimated output valued against the amount sent at the single price reference
  (CoinGecko); without a price for both sides it is null.

## 8. Unified execution status; restart tests

- **Change.** `services/api/src/exec-status.ts`: `execution: { kind, state, steps[], updatedAt }`, each step with `state`
  (`pending | awaiting_approval | signing | broadcast | confirming | confirmed | failed | refunded | unknown`), `txid`,
  `explorer`, `startedAt`, `endedAt`, `code`. Steps: approval (when needed) + send / swap / burn → attestation → mint /
  deposit → observation → outbound / GMX order. Built only from the stored row, so it reads the same after a restart.
  Additive on `GET /transfers/proposals/:id`, `GET /transfers/:id/status`, `/activity`, every answer that returns a proposal,
  and each leg of `GET /plans/:id` (`legs[].execution`). UI: `apps/web/src/execution.tsx` draws it with the existing
  `Timeline` on the swap sheet, in the plan leg in flight and in Activity (CCTP and THORChain keep their richer progress).
- **Restart tests** (`vi.resetModules()`: new module instances and a new database pool, nothing carried in memory; chain,
  Circle and THORChain scripted):
  - `bridge.test.ts` — burn mined → **restart** → attestation verified, mint signed and relayed → **restart** with the mint
    unconfirmed → reconciled as done; one mint signature across three processes; identical status before and after.
  - `xswap.test.ts` — outbound named by THORChain → **restart** → operators silent (nothing moves) → outbound seen unconfirmed
    → confirmed → `received`; a later worker tick does nothing.
- **Limitations.** Timestamps the wallet does not record (the approval's) are null. An approval that was relayed before its
  proposal ended for another reason is `unknown`, not `failed`. A proposal in `not_broadcast` reads `failed` with code
  `broadcast_disabled` (the state list given has no closer word).

## 9. 0x and 1inch — quote-only comparison sources

- **API read on 2026-11-15** (URLs in `docs/swap/providers/0x.md` and `1inch.md`): 0x `GET https://api.0x.org/swap/allowance-holder/price`
  with `0x-api-key` and `0x-version: v2`; 1inch `GET https://api.1inch.com/swap/v6.1/{chainId}/quote` with
  `Authorization: Bearer`.
- **Change.** `packages/swap/src/providers/zerox.ts` and `oneinch.ts`, ids `zerox` / `oneinch`, env `ZEROX_API_KEY` /
  `ONEINCH_API_KEY`. Without a key: `needsKey: true, configured: false`, skipped by the aggregator (`not_configured`), listed
  under `needsKey` in `GET /swap/providers` and in the Swap screen, never asked. With a key: one indicative call per search, no
  address sent, `executability: quote_only` (code `comparison_only`); the API refuses their reference at preparation.
- **Tests.** `packages/swap/test/keyed-comparison.test.ts` on **documentation-derived fixtures** (each file says which values
  are the documentation's and which are constructed).
- **Not verified, not done.** No key: **no live call was made**; whether 0x's `buyAmount` is net of its fee, 1inch's error
  bodies and HyperEVM support are unverified. The terms of use of both were not read. No recorder or smoke script. No logo
  (a letter disc, per the design rule). The rate limits (1 request/s) are a guess on the low side, not a documented figure.

## 10. Resilience

| | Initial state | Change | Tests |
|---|---|---|---|
| (a) `rpcQuorum` | every endpoint must answer and agree; one degraded endpoint blocks the network | **The rule is kept** — the code documents it as a safety property for signatures. Added endpoint health: three connection-level failures eject an endpoint for 60 s (doubling to 10 min), then it is asked on probation; ejection never leaves fewer than two endpoints; any disagreement between endpoints that answered fails closed. `SPW_RPC_EXTRA` (`rpc-extra.ts`) lets the operator add endpoints. | API `v11-stab.test.ts` "resilience (a)" |
| (b) Home without the signer | `/portfolio` failed | the last addresses the signer gave are kept (memory + `settings.signerAddresses`); `/portfolio` and `/accounts` answer with `signer.reachable: false`, `halted: null`; Home shows a banner and disables Send, Receive says the address was not confirmed just now | `api.test.ts` |
| (c) price freshness | `asOf` = time of the answer | each price has `priceAt` (CoinGecko's own `last_updated`, else the fetch time) and `stale`; `/portfolio` has `pricesAsOf`, `pricesStale`, `priceSource`; indicator on Home, Assets, Asset | API "resilience (c)", web |
| (d) quote SSE | no heartbeat, no `retry:`, no cap | `retry: 3000` in the first event, `: keep-alive` every 15 s, at most 6 concurrent streams (`429 too_many_streams`), error event with its code | `api.test.ts` |
| (e) `swap_quotes` | never pruned | `pruneSwapQuotes()` (30 days, `SPW_SWAP_QUOTES_RETENTION_DAYS`, never under 8), worker loop every 6 h | API "resilience (e)" |
| (f) plan pricing | own runtimes, looser limits | plans use the swap router's runtimes (same token bucket and breaker), with a longer per-call timeout and one more retry on the local rate limit | existing plan suites |

- **Limitation of (a), stated plainly:** all 24 networks have exactly two endpoints, so **by default nothing changes** — one
  degraded endpoint still refuses signing on that network. The network survives one bad endpoint only once a third is
  configured with `SPW_RPC_EXTRA`. No endpoint was added to the registry in this pass.
- **Single price source.** No price source was added. CoinGecko's free tier remains the only source for the portfolio, swap
  valuation, the market-reference risk flags and plan estimates. `stale` says when it is old; it does not replace it.
- Stream cap, endpoint health and the address memory are in-process state: correct for one API process.

## Not done

- **No browser run.** Playwright e2e and the v9 / v10 visual baselines were not run or regenerated; the Swap screen (hero,
  route cards), Home (freshness, banner), Activity and the plan screen changed.
- Docs listed as "read first" beyond the two audit files (`V2-IMPLEMENTATION-STATUS`, `v7/ANY-TO-ANY`) were not re-read in
  full; `v9/DESIGN.md` was read for its principles and logo rule only.
- The stale `README.md` and the audit's other hygiene points (B8 UI side, B9, SSE security headers) are untouched.
