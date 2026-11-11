# Derivatives API — controlled live trading (for the UI)

Backend: `services/api/src/derivatives/{exec,live,live-routes,live-venue}.ts`; shared canonical objects:
`packages/derivatives/src/live/` (`@spw/derivatives/live`); signer: `services/isolated-signer/src/venue.ts`. Source of truth for
exact shapes: `live-routes.ts`, `exec.ts` and `services/api/test/derivatives-live.test.ts`.

**It ships disabled.** A venue account is `READ_ONLY` until the owner approves a *venue authorization* with his passkey. Mainnet
additionally needs the server setting `SPW_DERIV_LIVE_MAINNET=on` (default off): with it off every mainnet proposal answers
`403 mainnet_disabled` and the testnet account works. `MANDATE_LIVE` does not exist (`GET /config` says so; the signer refuses it).

All routes are under `/api/v1/derivatives/live`, behind the owner session; writes need `x-spw-csrf: 1`. Decimals are strings,
times are unix milliseconds unless stated. A passkey approval is always: take `options` from the answer →
`navigator.credentials.get({ publicKey: options })` → post the resulting JSON as `assertion`. The API never judges an assertion:
it passes it to the signer.

## What the UI must display before each passkey prompt

| Prompt | Show exactly | The passkey signs |
|---|---|---|
| Enable live trading | `acknowledgement.text` (the jurisdiction summary, in full), the limits in `authorization.policy`, `agent.address`, the expiry, `agent.can` / `agent.cannot` | SHA-256 of the canonical authorization (`hash`), which contains `ackSha256` |
| Order / close | every field of `canonical`: instrument, side, type, size, price (limit or worst price), triggerPrice, reduceOnly, tif, clientId, nonce, expiresAt | SHA-256 of the canonical order (`hash`) |
| Leverage | `canonical`: instrument, leverage, marginMode (+ `current`) | SHA-256 of the canonical leverage change |

A market order appears in `canonical` as `type: "limit"`, `tif: "ioc"` at its worst acceptable price: that is what the venue
receives. Proposals expire 90 s after they are made (`expiresAt`); show a countdown. Reduce-only orders need the passkey too.
Cancel, cancel-all, halt, resume and revoke need **no** passkey.

## Objects

```ts
VenuePolicy   { allowedInstruments: string[]  // "hyperliquid:BTC" | ":ETH" | ":SOL" only (GET /config → pinnedAssets)
                maxLeverage: number           // integer 1…20 and ≤ the venue maximum of each instrument
                maxOrderNotional: DecStr; maxPositionNotional: DecStr; maxGrossExposure: DecStr   // order ≤ position ≤ gross
                maxOrdersPerDay: number       // 1…500
                maxPriceDeviationBps: number }// 10…2000: band around the SIGNER's own price for every order price
VenueAuthorization { v: 1, authorizationId, keyId, venue: "hyperliquid", network, account, agentAddress, agentName,
                mode: "MANUAL_LIVE", policy: VenuePolicy, createdAt, expiresAt /* unix SECONDS */, approveNonce, ackSha256 }
VenueOrder    { v: 1, authorizationId, venue, network, account, kind: "order", instrument, side: "buy"|"sell",
                type: "limit"|"stop_market"|"stop_limit"|"take_profit_market"|"take_profit_limit", size, price,
                triggerPrice: DecStr|null, reduceOnly, tif: "gtc"|"ioc"|"alo", clientId /* 0x + 32 hex */, nonce, expiresAt }
VenueLeverage { v: 1, authorizationId, venue, network, account, kind: "leverage", instrument, leverage, marginMode, nonce, expiresAt }
Ack           { venue, locale: "fr"|"en", text, sha256, version, source }
LiveOrder     { clientId /* = the Idempotency-Key */, cloid, instrument, side, type, size, price, triggerPrice, reduceOnly, tif,
                state: "proposed"|"risk_checked"|"authorized"|"signed"|"submitted"|"unknown"|"open"|"partially_filled"|"filled"|"cancelled"|"rejected",
                final: boolean, venueOrderId: string|null, filled: DecStr, avgFillPrice: DecStr|null, reason: string|null,
                origin: "owner"|"close", hash, nonce, expiresAt, canonical: VenueOrder|null, createdAt, updatedAt, submittedAt,
                source: "venue"|"local" }     // "venue": the state was read from the venue's own records
LiveAction    { id, kind: "leverage"|"cancel", state, request, hash, nonce, expiresAt, error, createdAt, updatedAt }
AccountSummary{ id, venue, network, kind: "venue", mode: "READ_ONLY"|"MANUAL_LIVE", label, account, agentAddress,
                policy: RiskPolicy, halt: string|null, divergence: string|null, halted: string|null /* effective reason */,
                mainnetEnabled, tradable,
                authorization: null | { id, hash, mode, agentName, policy: VenuePolicy, createdAt, expiresAt, ackSha256, active, expired, revokedAt, authorizedAt },
                pendingAuthorization: null | { authorizationId, preparedAt }, createdAt, updatedAt }
AccountDetail = AccountSummary & { venueState: { state: AccountState|null, positions: Position[], openOrders: Order[], error: string|null, ts, source: "venue" },
                orders: LiveOrder[] /* last 100 */, actions: LiveAction[] /* last 50 */, fills: (Fill & { source: "venue" })[],
                funding: { instrument, amount, rate, size, ts, source: "venue" }[], riskEvents: { id, ts, kind, code, message, data }[],
                equity: { ts, equity, collateral, marginUsed, unrealizedPnl, source: "venue" }[], ts }
Proposal      { order: LiveOrder, canonical: VenueOrder|null, hash: string|null, expiresAt: number|null, estimate: Estimate|null,
                idempotent: boolean, options: PublicKeyCredentialRequestOptionsJSON|null /* null = nothing (left) to approve */ }
Estimate      { notional, initialMargin, fee, feeNote, freeCollateralAfter, leverage, marginMode, price, mark,
                liquidationPrice: null, liquidationNote, source: "estimate" }
```

`AccountState`, `Position`, `Order`, `Fill`, `RiskPolicy`, `RiskResult`, `OrderRequest` are those of the paper API. `state.final`
is false while the worker still watches an order. `partially_filled` + `final: true` = the remainder was cancelled (IOC).

## Routes

| Route | Body | Answer |
|---|---|---|
| `GET /config` | — | `{ mainnetEnabled, venues: [{ venue, networks }], modes, mandateLive: { available: false, reason }, pinnedAssets: { pinnedAt, mainnet: [{ instrument, maxLeverage }], testnet: […] }, bounds: { maxLeverage, maxOrdersPerDay, minPriceBandBps, maxPriceBandBps, maxInstruments, maxAuthorizationDays, orderApprovalTtlMs }, ts }` |
| `GET /jurisdiction?venue=hyperliquid` | — | `{ venue, fr: Ack, en: Ack }` |
| `POST /venue-key` | `{ venue: "hyperliquid", network }` | `{ venue, network, address, path, account }` — the trading address the signer derived, and the wallet's own address |
| `GET /accounts` | — | `{ accounts: AccountSummary[], ts }` |
| `POST /accounts` | `{ venue: "hyperliquid", network: "testnet"\|"mainnet", label? }` | `AccountDetail` (`READ_ONLY`; one account per venue and network — a second call returns the same one) |
| `GET /accounts/:id` | — | `AccountDetail` |
| `GET /accounts/:id/collateral` | — | `{ account, network, equity, collateral, freeCollateral, marginUsed, withdrawable, asset: "USDC", error, ts, source: "venue", deposits: { supported, how }, withdrawals: { supported, how } }` (read-only; moving collateral: section "Collateral" below) |
| `POST /accounts/:id/authorization/prepare` | `{ policy: VenuePolicy, days: 1…90, locale: "fr"\|"en", agentName?: string }` | `{ authorization, hash, acknowledgement: Ack, agent: { address, name, wireName, validUntil, can: string[], cannot: string[], note }, whatIsSigned: { byMainKey, byPasskey }, venueState, options, ts }` |
| `POST /accounts/:id/authorization/approve` | `{ assertion, acknowledged: true }` | `AccountDetail` (`MANUAL_LIVE`) |
| `POST /accounts/:id/authorization/revoke` | `{ cancelOpenOrders?: boolean }` | `AccountDetail & { cancelled: CancelAll\|null, warning: string\|null, venueAgent: string }` |
| `POST /accounts/:id/policy` | a complete `RiskPolicy` (strict) | `AccountDetail` — may only tighten: anything above the authorization is `400 bad_policy` |
| `POST /accounts/:id/orders/preview` | `OrderBody` | `{ risk: RiskResult, estimate: Estimate, request: OrderRequest, venueState: { state, positions, source: "venue" }, ts }` — nothing stored |
| `POST /accounts/:id/orders` | header `Idempotency-Key`; `OrderBody` | `Proposal` (`order.state: "risk_checked"`) |
| `POST /accounts/:id/orders/:clientId/approve` | `{ assertion }` | `{ order: LiveOrder, idempotent }` |
| `POST /accounts/:id/orders/:clientId/cancel` | — | `{ order: LiveOrder, sent: boolean, venue?: { outcome: "accepted"\|"refused"\|"unknown", error } }` |
| `POST /accounts/:id/leverage` | `{ instrument, leverage: integer, marginMode?: "cross"\|"isolated" }` | `{ action: LiveAction, canonical: VenueLeverage, hash, current: { leverage, marginMode }\|null, expiresAt, options }` |
| `POST /accounts/:id/leverage/:actionId/approve` | `{ assertion }` | `{ action: LiveAction /* state "confirmed"\|"rejected"\|"unknown" */, idempotent, venue: { leverage: { leverage, marginMode }\|null, confirmed, source: "venue" }\|null }` |
| `POST /accounts/:id/halt` | `{ reason?: string }` | `AccountDetail & { note }` — stops new orders; cancels nothing, closes nothing |
| `POST /accounts/:id/resume` | — | `AccountDetail` — lifts an owner halt (not a divergence) |
| `POST /accounts/:id/cancel-all` | — | `CancelAll = { requested, accepted, failed: [{ venueOrderId, instrument, error }], remaining: Order[]\|null, source: "venue", ts }` |
| `POST /accounts/:id/close` | optional `Idempotency-Key`; `{ instrument, fraction: DecStr (0–1], slippageBps?: 1…500 (default 50) }` | `Proposal & { worstPrice, slippageBoundBps, position }` — then approve it like any order |
| `POST /accounts/:id/rebase` | — | `AccountDetail` — the owner accepts the venue's present positions as the reference (clears a position divergence) |
| `POST /accounts/:id/reconcile` | — | `{ reconciled, fills, funding, divergence, account: AccountDetail }` — one worker pass now |
| `GET /accounts/:id/stream` | — | Server-Sent Events (below) |

`OrderBody` is the paper one: `{ instrument, side, type, size, price?: DecStr|null, triggerPrice?: DecStr|null, reduceOnly?: boolean,
tif?: "gtc"|"ioc"|"alo", slippageBps?: 1…500 }`. A `market` order needs `price` (worst price) or `slippageBps`. `leverage` in the body
is a `400`: on a venue account it is a venue setting, changed with the leverage route. `clientId` in the body is a `400`.

Stream events: `status` `{ mode?, halt?, divergence?, error?, ts }` (first event) · `account` `{ state, positions, openOrders,
divergence, halt, mode, ts, source: "venue" }` (first, then after every reconciliation, about every 10 s) · `order` `LiveOrder` ·
`action` `LiveAction` · `risk` `{ ts, kind, code, message, data }`. Keep-alive comment every 15 s; at most 8 streams.

## Behaviour to know

- **Idempotency.** The `Idempotency-Key` *is* the order's `clientId`; the venue's client order id is derived from it. Proposing
  again with the same key returns the stored order (`idempotent: true`, whatever the body says) — also when that proposal was
  refused. Approving twice sends once: the second call answers the current state with `idempotent: true`.
- **A risk refusal** is `422 { error: <risk code>, message }` and is stored as a `rejected` order + a `riskEvents` row. Extra
  codes: `order_notional_exceeded` also applies to reduce-only orders (the signer bounds every order: close in smaller parts).
- **A signer refusal** at approval is `422 { error: "signer_<code>", message }` (`signer_price`, `signer_no_price`,
  `signer_bad_approval`, `signer_unknown_credential`, `signer_policy`, `signer_mismatch`, `signer_expired`, `signer_revoked`,
  `signer_stale_nonce`, `signer_replay`…); the order becomes `rejected` (`reason: "not signed: …"`). A failed passkey prompt
  therefore consumes the proposal: propose again.
- **A venue refusal** is not an HTTP error: `approve` answers `200` with `order.state: "rejected"` and the venue's words in `reason`.
- **`unknown`** = the venue gave no usable answer. Show it as such ("being checked on the venue"); it resolves by itself to
  `open`/`filled`/… or, once the 90 s venue expiry of the signature has passed, to `rejected` with `reason: "never placed: …"`.
- **Halt and divergence.** `halted` is the effective reason new orders are refused (`422 halted` on proposals, `423 halted` on
  approvals and leverage): the owner's halt, or a divergence between the venue and the wallet's records (an order or a
  position the wallet did not create). Reduce-only orders that reduce the venue's real position still pass. A foreign order
  clears when it is gone; a position difference clears with `rebase`.
- **Revoke** is permanent for that authorization and, on the signer, immediate: afterwards the wallet cannot even cancel.
  Offer `cancelOpenOrders: true`, and show `warning` when orders remain on the venue.
- **Mainnet off:** `403 mainnet_disabled` on prepare/approve authorization, preview, orders, leverage, close, cancel, cancel-all.
- Other errors: `400 bad_request|idempotency|bad_policy`; `404 unknown_account|unknown_order|unknown_action|unknown_instrument|unknown_venue`;
  `409 bad_state|wrong_key`; `410 proposal_expired`; `422 mode_read_only|authorization_expired|venue_rejected|no_position|below_min_size|instrument_not_allowed|leverage_exceeded`;
  `423 halted`; `429 too_many_streams`; `503 asset_table_mismatch|venue_unavailable|venue_rate_limited|signer_unreachable`.
- `venueState.error` non-null = the venue could not be read: show the account as unreadable, never as empty.
- Collateral: `GET …/collateral` is read-only. Deposits and withdrawals have their own routes: next section.

## Collateral: deposit and withdraw (v6)

All under `/api/v1/derivatives/live/accounts/:id/collateral`. Code `services/api/src/derivatives/collateral.ts`,
`collateral-routes.ts`; facts and evidence `docs/v4/venues/hyperliquid.md` section 15. Amounts are decimal strings of USDC
(at most 6 decimals). Mainnet needs `SPW_DERIV_LIVE_MAINNET=on` (`403 mainnet_disabled` otherwise). An authorization is NOT
needed: deposit first (the venue refuses every action of an account that never deposited).

| Route | Body | Answer |
|---|---|---|
| `GET /status` | — | `{ account, accountId, venue, network, mainnetEnabled, venueBalance, route, withdrawal, wallet, walletError, deposit: { available, reason, bridgeFrom[] }, withdraw: { available, reason }, operations: Operation[], ts }` |
| `POST /deposit/prepare` | `{ amount }` | `{ operation, intent, route: { network, networkName, bridge, minimum, venueMinimum, expectedSeconds }, fee: { estimate, max, symbol }, liveness, venueBalance, options }` — `options.challenge` = SHA-256 of the canonical intent |
| `POST /deposit/:opId/approve` | `{ assertion }` | `{ operation }` (signed and broadcast: `state: "sent"`) |
| `POST /withdraw/prepare` | `{ amount }` | `{ operation, withdrawal, hash, whatIsSigned: { byMainKey, byPasskey, action }, receive, venueBalance, options }` — `options.challenge` = SHA-256 of the canonical withdrawal |
| `POST /withdraw/:opId/approve` | `{ assertion }` | `{ operation }` (`submitted`, `rejected` with the venue's words, or `unknown`) |
| `GET /operations/:opId` | — | `{ operation }` — re-reads the venue's ledger and the wallet's chain records now |
| `POST /operations/:opId/cancel` | — | `{ operation }` — before the passkey only (`409 bad_state` afterwards) |

- `venueBalance`: `{ abstraction, equity, withdrawable, spotUsdc, total, error, ts }`. `abstraction` is the venue's account
  mode (`default` for an account that never changed it: collateral in the perp margin; `unifiedAccount` / `portfolioMargin`:
  collateral reported in the spot state — `total` follows the mode).
- `route` (null on testnet: no deposit route): `{ id: "arbitrum-bridge2", network: "arbitrum", networkName, bridge, bridgeExplorer,
  asset: "USDC", token, venueMinimum: "5", minimum: "6", expectedSeconds: 60, credits: "sender", venueFee: "0", legacy: true, pinnedAt, codeSha256 }`.
- `withdrawal`: `{ fee: "1", expectedSeconds: 240, destination (= account), payoutNetworkName, arrivalTracked, available }`.
- `wallet` (null on testnet): `{ address, network, networkName, usdc, gas, gasSymbol, limits: { perTransfer, perDay, spentToday, maxNow }, elsewhere: [{ network, name, usdc }] }`.
  `elsewhere` is filled when the wallet lacks the minimum on the deposit network: native USDC on the other CCTP networks.
  Nothing is bridged automatically; link to `/swap?bridgeFrom=<network>&bridgeTo=arbitrum[&amount=…]` (the Swap screen pre-fills from it).
- `deposit.reason`: `no_route | mainnet_disabled | halted | usdc_elsewhere | no_usdc | no_gas | limit_reached | wallet_unreadable`;
  `withdraw.reason`: `mainnet_disabled | halted | venue_unreadable`.
- `liveness` (deposit prepare): `{ ok, checkedAt, checked, credited, detail, samples: [{ tx, usdc, credited }] }` — the most
  recent transfers of at least 5 USDC into the bridge (last 10 minutes, else last hour), each looked up in the venue's ledger
  of its sender. `ok: false` → `503 route_not_proven`, nothing prepared. A positive result is reused for 5 minutes.
- `Operation`: `{ id, kind: "deposit" | "withdraw", state, final, venueNetwork, amount, asset, fee, expectedReceive, chainNetwork,
  chainNetworkName, bridge, txid, explorer, hash, proposalId, proposalState, confirmations, createdAt, expiresAt, sentAt, venueAt,
  doneAt, checkedAt, expectedSeconds, overdue, check: string[], balanceBefore, balanceAfter, ledger, arrival, venueAnswer, error,
  attempts, arrivalTracked }`.
  - Deposit states: `pending_approval → signed → sent → awaiting_credit → credited`; ends also `failed` (signer refusal, or
    the transaction reverted / was replaced: nothing reached the venue), `expired`, `cancelled`. **`credited` is the only
    success**: it is set when the venue's ledger (`userNonFundingLedgerUpdates`) holds a `deposit` entry whose `hash` is our
    Arbitrum transaction hash. `awaiting_credit` = confirmed on-chain, not yet in the venue's ledger: show "waiting for the
    venue to credit". After 10 minutes `overdue: true` and `check` lists what to look at
    (`tx_success, tx_to_bridge, amount_min, venue_ledger, venue_status`); polling goes on, the state stays `awaiting_credit`.
  - Withdrawal states: `pending_approval → approved → signed → submitted → completed`; `unknown` (no readable answer: the same
    signed bytes are sent again, at most 3 times; it resolves to `submitted`/`completed` when the ledger or the wallet shows
    the withdrawal, or to `rejected` after 30 minutes without any trace); `rejected` (the venue refused: its words in `error`),
    `failed` (not signed), `expired`, `cancelled`. **`completed` is the only success**: on mainnet it needs the arrival
    (`arrival: { txid, amount, seenAt }`: USDC from the bridge to the wallet, recorded by the wallet's own deposit scan);
    on testnet (`arrivalTracked: false`) it is set when the venue's ledger shows the withdrawal. After 15 minutes
    `overdue: true`, `check`: `venue_ledger, bridge_paused, wallet_scan, venue_status`.
- Errors: `422 below_minimum | no_route | insufficient_usdc | policy | below_fee | insufficient_collateral | simulation_failed |
  signer_<code>` (`signer_venue_deposit`, `signer_wrong_destination`, `signer_bad_approval`, …); `403 mainnet_disabled`;
  `409 deposit_in_progress | withdrawal_in_progress | pending_tx | bad_state | wrong_account | conflict`; `410 expired`;
  `423 halted`; `503 contract_changed | bridge_paused | route_not_proven | account_has_code | rpc_degraded | venue_unavailable`;
  `404 unknown_account | unknown_operation`.
- A deposit also exists as an ordinary wallet proposal (`GET /api/v1/transfers/proposals/:proposalId`, note
  `Hyperliquid mainnet deposit`, warning `venue_deposit`); the wallet's worker broadcasts and tracks it like any transfer.
- The browser mock (`?mock=1`) simulates these routes (`apps/web/src/derivatives/mockCollateral.ts`: time stands in for the chain and
  the venue; hooks `window.__spwMock.live.collateral.{wallet, creditAfter, payoutAfter, age}`); browser spec `tests/e2e/futures-collateral.spec.ts`.

## V6 — `MANDATE_LIVE`, locale, and the fixes that came with it (2026-11-11)

This section supersedes, where they differ, the sentences above that say `MANDATE_LIVE` does not exist. Design and proof:
`docs/v6/DERIVATIVE-MANDATE.md`. Everything above about manual orders is unchanged.

### Changed answers (existing routes)

| Route | Change |
|---|---|
| `GET /config` | accepts `?locale=fr\|en` (default `en`). New fields: `locale`, `mainnet: { enabled, code: "mainnet_disabled"\|null, reason: string\|null }`, `reasons: { <code>: { fr, en } }` (codes: `mainnet_disabled`, `mandate_mainnet_disabled`, `mandate_unavailable`), `modes` now `["READ_ONLY","MANUAL_LIVE","MANDATE_LIVE"]`, `mandateLive: { available: true, code: null, reason: null, mainnet: { enabled, code: "mandate_mainnet_disabled"\|null, reason }, bounds: { maxDays: 30, maxOrdersPerHour: 60, maxLeverageChangesPerDay: 20, maxInstruments: 8, windDownSeconds: 86400, orderTtlMs: 30000 } }`. `mainnetEnabled` stays. |
| `POST /accounts` | `network: "mainnet"` while mainnet is off → `403 mainnet_disabled` (message = `reasons.mainnet_disabled.en`). It used to create a READ_ONLY account. An existing mainnet account stays. |
| `GET /accounts`, `GET /accounts/:id` (and every answer that is an `AccountDetail`) | new fields `modes: string[]` (`["READ_ONLY"]`, `["MANUAL_LIVE"]` or `["MANUAL_LIVE","MANDATE_LIVE"]`), `mandate: MandateSummary\|null`, `pendingMandate: { mandateId, preparedAt }\|null`. `mode` is unchanged and stays `MANUAL_LIVE` under a mandate. |
| `GET /accounts/:id/collateral` | accepts `?locale=`; adds `locale`; `deposits.how` / `withdrawals.how` in that language. |
| `POST /accounts/:id/authorization/prepare` | the body's `locale` now also selects the language of `agent.can[]`, `agent.cannot[]`, `agent.note`, `whatIsSigned.byMainKey`, `whatIsSigned.byPasskey`; adds `locale`. |
| `POST /accounts/:id/authorization/revoke` | body accepts `locale` (default `en`); adds `cancelError: { code, message }\|null` — why cancel-all could not run (`cancelled` is then `null`); `venueAgent` in that language; adds `locale`. `warning` is English only. Also revokes the account's mandate (no wind-down). |
| `POST /accounts/:id/orders` (and `/close`) | a concurrent duplicate with the same `Idempotency-Key` now waits for the first call and returns the built proposal (`options` non-null, `idempotent: true`). `estimate` is returned on every idempotent replay (it was `null`); `null` only for a proposal that was refused. |
| `POST /accounts/:id/orders/:clientId/approve` | when it answers `423 halted` (halt or divergence, non-reduce-only order) or `503 asset_table_mismatch`, the proposal is now ended: `state: "cancelled"`, `final: true`, `reason: "withdrawn: …"` (it used to stay `risk_checked`). |
| `GET /accounts/:id/stream` | first `status` event: `{ mode, modes, halt, halted, divergence, ts }` where `halt` is the OWNER's halt text or `null` (as in `account` events and later `status` events — it used to carry the effective reason) and `halted` is the effective reason. The `status` events of halt and resume are `{ halt, halted, ts }` (resume now emits one). Mandate approval / revocation emit `status { mode, modes, mandate: <id>\|null, ts }`. |

**Locale shape.** Every server-authored sentence stays a plain string in the same field as before, in the language asked
for; the answer carries `locale: "fr"|"en"` next to it; machine-readable codes (`error`, `code`, states) never change with
the locale. Selection: `?locale=` on `GET` routes, the body's `locale` on `POST …/prepare` and `…/revoke`. Default `en` =
the exact strings these routes returned before. Error `message`s of refusals are English; for the mainnet refusals use
`config.reasons[<error code>][locale]`.

### `MANDATE_LIVE` routes (owner session, CSRF header on writes)

| Route | Body | Answer |
|---|---|---|
| `GET /accounts/:id/mandate` | — | `{ modes, mandate: MandateSummary\|null, pendingMandate, signer: SignerMandate\|null, ts }` |
| `POST /accounts/:id/mandate/prepare` | `MandateBody` | `{ mandate: VenueMandate, hash, acknowledgement: Ack, locale, authorization: { id, hash, expiresAt, policy: VenuePolicy }, warning: string, enforcedBySigner: string[], trustedBySigner: string[], notEnforced: string[], windDown: { seconds: 86400, text }, whatIsSigned: { byPasskey }, venueState, options, ts }` |
| `POST /accounts/:id/mandate/approve` | `{ assertion, acknowledged: true }` | `AccountDetail` (`modes` includes `MANDATE_LIVE`) |
| `POST /accounts/:id/mandate/revoke` | `{ cancelOpenOrders?: boolean, locale?: "fr"\|"en" }` — no passkey | `AccountDetail & { cancelled: CancelAll\|null, cancelError: { code, message }\|null, locale, windDown: { until /* ms */, text, openPositions, openOrders } }` |

There is **no route that places a mandate order**; orders come from the server-side agent runtime only and appear in
`orders` with `origin: "mandate"` (and in the `order` stream events).

```ts
MandateBody   { instruments: [{ instrument, maxLeverage /* 1…20 */, maxPositionNotional: DecStr }]  // 1…8, ⊂ the authorization's
                maxOrderNotional, maxGrossExposure, maxDailyTurnover, floorEquity: DecStr  // all > 0
                maxOrdersPerDay /* 1…500 */, maxOrdersPerHour /* 1…60 */, maxPriceDeviationBps? /* default: the authorization's */,
                days /* 1…30 */, locale?: "fr"|"en", strategySha256 /* 64 hex */, agentId /* [A-Za-z0-9._:-]{1,64} */ }
VenueMandate  { v: 1, mandateId, authorizationId, keyId, venue, network, account, agentAddress, strategySha256, agentId, instruments,
                maxOrderNotional, maxGrossExposure, maxOrdersPerDay, maxOrdersPerHour, maxDailyTurnover, floorEquity, maxPriceDeviationBps,
                createdAt, expiresAt /* unix SECONDS */, ackSha256 }
MandateSummary{ id, hash, authorizationId, agentId, strategySha256, limits: VenueMandate, phase: "active"|"wind_down"|"ended", active: boolean,
                createdAt, expiresAt, expired, approvedAt, revokedAt, windDownUntil /* ms */ | null, ackSha256 }
SignerMandate { mandate, hash, approvedAt, revoked, revokedAt, expired, phase, windDownUntil /* unix s */ | null,
                today: { orders, reduceOnly, cancels, leverage, turnover: DecStr }, ordersLastHour, pendingOrders }
```

Before the passkey prompt of a mandate, show: `warning`, every field of `mandate` (the limits, the strategy hash, the agent,
the expiry), `acknowledgement.text` in full, `enforcedBySigner`, `trustedBySigner`, `notEnforced`, `windDown.text`. The
passkey signs `hash` (SHA-256 of the canonical mandate, which contains `ackSha256`).

Errors: `403 mainnet_disabled | mandate_mainnet_disabled`; `400 bad_policy` (wider than the authorization, or outside the
bounds); `409 bad_state` (a mandate is already active / nothing prepared / no mandate to revoke); `422 mode_read_only |
authorization_expired | signer_<code>`; `423 halted` (signer emergency halt at prepare); `503 mandate_unavailable |
asset_table_mismatch`. A refused approval consumes the preparation: prepare again.

## V7 — a perp agent LIVE on a venue account (2026-11-11)

Design and proof: `docs/v7/PERP-AGENT-LIVE.md`. Routes under `/api/v1/agents` (owner session, CSRF header on writes). There
is still no route that places an order: the engine pass does, through `derivatives/mandate.ts`.

| Route | Body | Answer |
|---|---|---|
| `GET /agents/:id/perp/live?account=<uuid>&locale=fr\|en&days=N` | — | `Readiness` |
| `POST /agents/:id/perp/live/prepare` | `{ accountId, days?: 1…30, locale }` (strict) | the mandate-prepare answer above + `proposal` |
| `POST /agents/:id/perp/live/approve` | `{ accountId, assertion, acknowledged: true }` | agent detail (`state: "LIVE"`, `mode: "LIVE"`) |
| `POST /agents/:id/perp/live/pause` · `/resume` | `{}` — no passkey | agent detail (`PAUSED` / `LIVE`) |
| `POST /agents/:id/perp/live/stop` | `{ locale? }` — no passkey | agent detail (`STOPPING` or `STOPPED`) + `result` + `windDown: { until, text, openPositions, openOrders }` |

```ts
Readiness { agentId, locale, config /* GET /config?locale= */, accountId: string|null /* the selected venue account */,
  accounts: [{ id, network, label, account, mode, modes, tradable, authorization: { active, expiresAt }|null, mandate: { id, phase, agentId }|null,
               usedBy: { agentId, name }|null, equity: DecStr|null, error: string|null /* both for the selected account only */ }],
  steps: { strategy: { ok, versionId, sha256, name, version, reason },
           account:  { ok, code, reason, network, authorization: { active, expiresAt, maxMandateDays }|null, instrumentsMissing: string[] },
           funded:   { ok, code, reason, equity: DecStr|null, minEquity: DecStr, basis: { instruments: [{ instrument, minOrder }], ordersPerPosition, grossX, floor } },
           mandate:  { ok, phase, mandateId, lock: { code, reason /* server text, in the locale */ }|null } },
  next: "strategy"|"account"|"fund"|"mandate"|"live"|"locked",
  proposal: null | { capital: DecStr, days, maxDays, body: MandateBody, derived: [{ field, value, from }], notes: string[] }, ts }
```
`steps.account.code`: `no_account | mainnet_disabled | read_only | authorization_expired | used_by_other_agent |
instruments_not_pinned | instruments_not_allowed | authorization_too_short | mandate_exists | account_not_flat`.
`steps.funded.code`: `no_account | venue_unreadable | unfunded | below_minimum`. `steps.mandate.lock.code`:
`mandate_unavailable | mainnet_disabled | mandate_mainnet_disabled`. Errors: `409 not_ready` (the message names the step),
`409 bad_state`, `409 used_by_other_agent`, and those of the mandate routes (`403 mandate_mainnet_disabled`, `422 signer_<code>` …).

Agent detail (`GET /agents/:id`, perp) — changed and new fields: `mode: "PAPER"|"LIVE"`, `simulation` (false when the mode is
LIVE), `state` also `LIVE | PAUSED | STOPPING`, `execution: { kind: "paper"|"live", network?, note }`,
`live: { available, reason, active, accountId, network, mandateId, strategySha256, since, capital, paused, exit: { ts, code,
reason }|null, account: AccountDetail|null, signer: SignerMandate|null, holds: [{ ts, bar, symbol, code, reason }] }`.
`live.exit.code`: `owner_stop | mandate_revoked | mandate_expired | mandate_ended | authorization_ended | mainnet_disabled |
mandate_mainnet_disabled | halted | divergence | manual_order | liquidation | strategy_changed | loss_limit | engine_stop |
signer_revoked | signer_expired | signer_wind_down | signer_no_authorization | signer_not_found | signer_halted`.
Signal rows: an item of `orders.list` may be `status: "deferred"` (`code: live_cooldown | live_unknown_pending`).
While the agent is on a venue account: `POST /agents/:id/perp/risk`, `/perp/flatten` and `mode: "PAPER"` answer `409 bad_state`;
`POST /agents/:id/mode` with `PAUSED` / `STOPPED` is the live pause / stop. `GET /agents/perp/venues` → `live.available: true`.

## GMX v2 trading (v8) — `services/api/src/derivatives/gmx-*.ts`

Facts, pins, guarantees and evidence: `docs/v4/venues/gmx.md` Part C. All routes are under `/api/v1/derivatives/gmx`, behind
the owner session. Decimals are strings; USD amounts are plain decimals (not 30-decimal integers); token amounts are whole
units. **GMX has no venue account: the account is the wallet's own Arbitrum address**, an order is a wallet transaction
(proposal `kind: "gmx"`), executed later by a GMX keeper. Three locks, all needed: server settings `SPW_DERIV_LIVE_MAINNET=on`
**and** `SPW_DERIV_GMX_LIVE=on` (default off), and a venue policy approved with the passkey (stored and enforced by the signer).
Reading (`GET /status`) works with everything off.

| Route | Body | Answer |
|---|---|---|
| `GET /status?locale=fr\|en` | — | `GmxStatus` |
| `GET /jurisdiction` | — | `{ venue: "gmx", fr: Ack, en: Ack }` (`Ack = { venue, locale, text, sha256, version, source }`) |
| `POST /authorization/prepare` | `{ allowedMarkets: string[] /* market addresses */, maxLeverage: int 1–20, maxOrderSizeUsd: DecStr, maxOrdersPerDay: int 1–100, maxPriceDeviationBps: int 10–1000, days: int 1–90, locale: "fr"\|"en" }` | `{ authorization: GmxAuthorization, hash, ack: Ack, options /* WebAuthn request, challenge = hash */, maxExecutionFeeEth }` |
| `POST /authorization/approve` | `{ authorization, assertion }` | `GmxStatus` |
| `POST /authorization/revoke` | `{}` — no passkey | `GmxStatus` |
| `POST /orders/preview` | `GmxOrderBody` | `GmxPreview` — nothing stored, nothing signed |
| `POST /orders` (header `Idempotency-Key`) | `GmxOrderBody` | `GmxPrepared` — a stored proposal waiting for the passkey |
| `POST /positions/close` (header `Idempotency-Key`) | `{ market, side: "long"\|"short", fraction?: DecStr (0–1], default "1", slippageBps?: int }` | `GmxPrepared` (a `decrease` of `fraction × size`) |
| `POST /orders/:opId/cancel` | `{}` | `GmxPrepared` (a `cancel` operation for the pending order of `:opId`; `409 not_yet_cancellable` before the delay) |
| `POST /operations/:opId/approve` | `{ assertion }` | `{ operation: GmxOperation }` |
| `POST /operations/:opId/withdraw` | `{}` — before the passkey only | `{ operation }` |
| `GET /operations/:opId` | — | `{ operation }` (refreshed from the chain) |

```ts
GmxOrderBody { market: string /* GM market address */, side: "long"|"short", action: "increase"|"decrease",
  collateral?: DecStr /* USDC sent, increase only */, leverage?: DecStr /* increase: size = collateral × leverage */,
  sizeUsd?: DecStr /* instead of leverage (increase), or the size to close (decrease) */, slippageBps?: int 1–500 /* default 50 */ }

GmxStatus { venue: "gmx", network: "arbitrum", chainId: 42161,
  settings: { liveMainnet: boolean, gmxLive: boolean },
  tradable: boolean, blockers: BlockerCode[], blockerText: Record<BlockerCode, string> /* in the locale */,
  pins: { id, reviewedAt, ok: boolean|null /* null = could not be checked */, checkedAt: number|null, problems: string[],
          contracts: [{ name, address, explorer }] },
  account: { address, explorer } | null,
  wallet: { usdc: DecStr, eth: DecStr, weth: DecStr, limits: { perTransfer, perDay, spentToday, maxNow: DecStr /* USDC */ }, feeCeilingEth: DecStr } | null,
  walletError: string|null,
  authorization: null | { id, state: "active"|"expired"|"revoked"|"stale" /* stale = given for another contract set */,
          policy: { allowedMarkets: string[], maxLeverage, maxOrderSizeUsd, maxOrdersPerDay, maxPriceDeviationBps, maxExecutionFeeWei },
          createdAt, expiresAt /* unix s */, today: { increases, reduces } },
  markets: [{ market, name, instrument, base: "BTC"|"ETH", indexDecimals, collateral: [{ token, symbol, decimals }], allowed: boolean,
              mark: DecStr|null, oracleMin: DecStr|null, oracleMax: DecStr|null }],
  positions: GmxPosition[], positionsSource: "chain", positionsError: string|null,
  pendingOrders: GmxPendingOrder[],           // orders of the wallet stored on-chain now (Reader.getAccountOrders)
  operations: GmxOperation[],                 // the engine's own records, newest first (20)
  facts: { requestExpirationSec: 300, executionGas: string|null, twoStep: true }, ts }
BlockerCode = "gmx_setting_off" | "mainnet_setting_off" | "not_authorized" | "authorization_expired" | "authorization_revoked"
            | "contracts_changed" | "signer_halted" | "chain_unreadable" | "wallet_unreadable"

GmxPosition { key, market, marketName, instrument, side: "long"|"short", collateralToken, collateralSymbol,
  sizeUsd: DecStr, sizeTokens: DecStr, collateral: DecStr, entryPrice: DecStr, markPrice: DecStr|null,
  pnlUsd: DecStr|null /* estimate at the mark, before fees */, leverage: DecStr|null, liquidationPrice: DecStr|null /* estimate */,
  increasedAt: number /* unix s */, source: "chain", venueApi: { agrees: boolean|null, detail: string|null } /* cross-check with GMX's API */ }
GmxPendingOrder { key, market, marketName, orderType: string, side: "long"|"short", sizeUsd, collateral, acceptablePrice,
  executionFeeEth, updatedAt /* unix s */, cancellableAt /* unix s */, frozen: boolean, opId: string|null /* null = not created by this wallet's engine */ }

GmxOperation { id, kind: "increase"|"decrease"|"cancel", state: OpState, final: boolean,
  market: string|null, marketName: string|null, side: "long"|"short"|null, collateral: DecStr|null, collateralSymbol: string|null,
  sizeUsd: DecStr|null, acceptablePrice: DecStr|null, slippageBps: number|null, leverage: DecStr|null,
  executionFeeEth: DecStr, maxFeeEth: DecStr /* gas ceiling + execution fee */, needsApproval: boolean,
  orderKey: string|null, targetOpId: string|null /* cancel: the operation whose order it cancels */,
  hash: string|null /* intent hash = what the passkey signs */, proposalId, txid: string|null, explorer: string|null, approvalTxid: string|null,
  createdAt, expiresAt: number|null, sentAt: number|null, orderCreatedAt: number|null, doneAt: number|null, checkedAt: number|null /* unix ms */,
  cancellableAt: number|null /* unix ms: when the owner may cancel a still-pending market order */, overdue: boolean /* created, no keeper after 10 min */,
  estimate: GmxEstimate|null,
  outcome: null | { event: "OrderExecuted"|"OrderCancelled"|"OrderFrozen", txid, explorer,
      executionPrice: DecStr|null, sizeUsd: DecStr|null, positionFeeUsd: DecStr|null, priceImpactUsd: DecStr|null, pnlUsd: DecStr|null,
      collateralOut: DecStr|null /* tokens that came back to the wallet in that transaction */, executionFeeRefundEth: DecStr|null,
      reason: string|null, reasonCode: string|null, cancelledBy: "keeper"|"owner"|null,
      collateralReturned: boolean|null /* cancelled increase: the wallet's balance moved back by the collateral */ },
  error: string|null }
OpState = "pending_approval" | "signed" | "sent" | "created" /* on-chain, waiting for a GMX keeper */ | "executed" | "cancelled"
        | "frozen" | "done" /* cancel operation mined */ | "failed" | "expired" | "withdrawn" | "unknown" /* sent, not found */

GmxEstimate { source: "estimate", referencePrice: DecStr, oracleMin, oracleMax, acceptablePrice: DecStr, slippageBps,
  sizeUsd, sizeTokens, collateral: DecStr|null, leverage: DecStr|null,
  positionFee: { usd, bps, balanceImproved: boolean },
  priceImpact: { usd: DecStr /* negative = cost */, uncertaintyUsd: DecStr, settledAt: "close", capped: boolean, note },
  executionFee: { eth, usd: DecStr|null, sentWei: string, note /* the unused part is refunded */ },
  gas: { maxEth, expectedEth, usd: DecStr|null }, approval: boolean,
  funding: { perHour: DecStr /* fraction of size; positive = the position PAYS */, usdPerDay: DecStr },
  borrow: { perHour: DecStr, usdPerDay: DecStr },
  liquidationPrice: DecStr|null, liquidationNote: string, totalAtEntryUsd: DecStr|null /* position fee + gas + execution fee sent */, notes: string[], ts }
GmxPreview { order: { market, marketName, side, action, collateral, sizeUsd, acceptablePrice, slippageBps, leverage },
  estimate: GmxEstimate, risk: { ok: true } | { ok: false, code, reason }, blockers: BlockerCode[], signerWould: string|null /* a refusal the signer would give, known in advance */ }
GmxPrepared { operation: GmxOperation, intent /* the canonical intent, section `gmx` */, estimate: GmxEstimate|null,
  fields: [{ label: string /* machine key */, value: string }] /* exactly what the passkey signs, for the confirm sheet */,
  fixed: [{ label, value }] /* what the signer fixes itself: receiver, cancellationReceiver, callback, uiFeeReceiver, swapPath, referralCode, minOutputAmount */,
  options /* WebAuthn request; challenge = intent hash */ }
```

`fields[].label` keys: `action, market, side, orderType, collateral, sizeUsd, leverage, acceptablePrice, executionFee, maxFee,
network, exchangeRouter, router, orderVault, orderKey, expiresAt`. `fixed[].label` keys: `receiver, cancellationReceiver,
callbackContract, uiFeeReceiver, swapPath, referralCode, minOutputAmount, shouldUnwrapNativeToken`.

Errors (HTTP, `error` code): `403 gmx_disabled` / `mainnet_disabled` (a server setting is off — nothing was built), `409
not_authorized`, `503 contract_changed` ("GMX a publié de nouveaux contrats : nouvelle revue nécessaire"), `422 risk_<code>`
(the risk engine), `422 venue_policy` (the venue policy the signer enforces: leverage, order size, execution fee, price band — checked here with GMX's oracle price before asking), `422 policy` (wallet limits), `422 signer_<code>` (the signer's refusal, verbatim), `422 simulation_failed`,
`409 pending_tx` (another transaction of the wallet on Arbitrum is not confirmed), `409 not_yet_cancellable`, `409 bad_state`,
`410 expired`, `503 chain_unreadable`. A `created` operation is NOT an executed order: the screen says "en attente d'exécution
par le réseau GMX" until the chain shows `OrderExecuted`, `OrderCancelled` or `OrderFrozen` for the order key.
