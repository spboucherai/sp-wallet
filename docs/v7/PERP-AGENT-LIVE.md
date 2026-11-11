# SP Wallet V7 — a perp agent LIVE on a venue account, as built

An approved perpetual-futures strategy trades a real Hyperliquid account autonomously, inside limits the isolated signer
enforces by itself (the derivative mandate of `docs/v6/DERIVATIVE-MANDATE.md`). It ships **off**: an agent is created in
simulation; it goes LIVE only after the owner authorised a venue account and approved a mandate with **one** passkey. Testnet
first. Mainnet autonomous trading needs two server settings, `SPW_DERIV_LIVE_MAINNET=on` and `SPW_DERIV_MANDATE_MAINNET=on`
(the second is off; this delivery never reads or sets either — the live module reads them at every use).

Code: executor `services/api/src/agents/perp-exec-live.ts`; life cycle `perp-live-cycle.ts`; engine `perp-engine.ts` (hooks);
runtime `perp-live.ts`; routes `perp-routes.ts` (end of file). Proof: `services/api/test/perp-agent-live.test.ts` (17 tests),
`scripts/sim-perp-agent-live.mts` (outputs: `docs/v7/sim-perp-agent-live.{fake,testnet}.txt`), screens `docs/v7/screens/`.
Nothing in the signer, in `derivatives/exec.ts` or in `derivatives/mandate.ts` was changed.

## 1. States

```
PAPER ──checklist──▶ LIVE ──pause──▶ PAUSED ──resume──▶ LIVE
LIVE | PAUSED ──(stop condition)──▶ STOPPING ──(flat, or nothing can be signed)──▶ STOPPED ──(mode PAPER)──▶ simulation
```

`agents.mode = 'LIVE'` with `state ∈ LIVE | PAUSED | STOPPING | STOPPED`; `agents.live_account_id` (unique where not null: one
agent per venue account) while the agent is on the account; `agents.perp.live` = `{ accountId, network, mandateId,
strategySha256, since, capital, exit }`. A paper agent is unchanged (`mode PAPER`, `state PAPER_TRADING`).

**Checklist (`GET /agents/:id/perp/live`)** — computed by the server, nothing is chosen freely:
1. *strategy*: an approved contract-2 version; its code hash is pinned in the mandate.
2. *account*: a venue account with an ACTIVE manual authorization (the owner creates and authorises it in Futures → Comptes),
   not used by another agent, flat (no position, no resting order), every instrument of the agent in the pinned table and in
   the authorization, and an authorization that still lasts ≥ 48 h. On mainnet, also `SPW_DERIV_LIVE_MAINNET`.
3. *funded*: the venue's own account value ≥ `max(50, 5 × N × (min order × 1.05) ÷ grossX)` USDC — every instrument must be
   able to hold five minimum orders when the gross limit (the tighter of the agent's gross limit and 0.9 × leverage) is split
   equally. BTC alone at 1.5× gross: 50 USDC.
4. *mandate*: derived from the agent's risk settings on the account value `C` (the *reference capital*), then clamped to the
   authorization (said in `proposal.notes`): per instrument `maxLeverage = min(agent, authorization, venue)`,
   `maxPositionNotional = maxPositionX·C`; `maxOrderNotional` = one position; `maxGrossExposure = maxGrossExposureX·C`;
   `maxOrdersPerDay = min(500, authorization, max(12, 2·N·bars/day))`; `maxOrdersPerHour = max(4, 2·N)`;
   `maxDailyTurnover = 4 × gross`; `floorEquity = C·(1 − maxTotalLossPct)`; price band = the authorization's; duration ≤ 30
   days and ending ≥ 24 h before the authorization expires (so the wind-down is possible after expiry).
   `POST …/perp/live/prepare { accountId, days?, locale }` → the review sheet (server texts: warning, acknowledgement,
   `enforcedBySigner`, `trustedBySigner`, `notEnforced`, wind-down) + WebAuthn request; `POST …/approve { accountId, assertion,
   acknowledged: true }` → the signer judges the passkey → LIVE. Going live sends nothing to the venue.
   Mainnet without `SPW_DERIV_MANDATE_MAINNET=on`: `next: "locked"`, `steps.mandate.lock = { code, reason }` (the server's
   sentence in the locale), prepare answers `403 mandate_mainnet_disabled`.

## 2. `LivePerpExecutor` — what the engine can rely on

| Requirement | How |
|---|---|
| venue truth | `account()` / `positions()` = `mandateAccountState` (the venue's account value and positions, `source: 'venue'`); equity is the venue's own number; an unreadable venue throws — the pass is retried, the account is never treated as empty |
| leverage | before an order that can add exposure, the venue's setting (`activeAssetData`) is read; when it differs from `min(agent, mandate)` it is set through `setMandateLeverage` — once, and again only if it changed on the venue; not confirmed → `leverage_not_set`, no order |
| orders | as in paper: IOC at a worst price, reduce first, a flip = reduce-only close then open; client id = `ag-<agent>-<sha8>-<bar>-<symbol>-<r|o>` = the live module's idempotency key |
| `placed` | only when the venue's records confirm (filled / partly filled / cancelled remainder). `unknown`, signed-not-acknowledged → `deferred` + nothing more on that instrument; the bar stays open until the venue resolves it |
| partial fill | reported as such; the next bar plans `target − venue position` |
| signer over-count (≈ 40 s) | after any order reached the signer, an exposure-adding order is `deferred` for 45 s (account-wide for exposure-adding orders, per instrument after a close): at most one exposure-adding order per pass. A flip therefore closes on one pass and opens on the next (≈ 1 min later), planned again from the venue's real position |
| hold codes | any signer/risk/venue refusal that is not an exit code (`signer_position_exceeded`, `signer_gross_exceeded`, `signer_orders_hour`, `signer_turnover`, `signer_price`, `venue_rejected`, …) → `refused`: the bar completes, logged once; the refused order is stored under its key, so it cannot be retried in a loop |
| exit codes | `signer_revoked, signer_expired, signer_wind_down, signer_no_authorization, signer_not_found, signer_halted, mandate_mainnet_disabled, mainnet_disabled, mandate_none, mandate_wind_down, mandate_mismatch, mode_read_only, authorization_expired, halted` → the agent leaves LIVE |
| floor | no exposure is added once the account value is below `floor + 25 % × (capital − floor)` (`floor_guard`); the engine's own loss limits (total against the reference capital, daily against the first pass of the UTC day) take the agent out |
| per-order bound | the mandate bounds closes too: an order above 99 % of `maxOrderNotional` is cut and reported partly done |
| restart | one decision per bar (`perp_agent_signals`, written before any order); on every pass the agent's non-final orders are looked up on the venue by client order id; a stored key answers its own order |

Engine changes (`perp-engine.ts`), all behind the optional `PerpLiveHooks` argument: reference capital, the venue's equity,
`riskOnly` (pause), `onBreach` (loss limit → life cycle), `PlaceResult.deferred` (the bar stays open), `unconfirmed()`.
Without hooks the function is the paper engine of V6, and it never runs an agent whose mode is LIVE.

**Market data.** Decisions come from the gate's closed bars of the venue's public (mainnet) data, as in paper; sizes and worst
prices come from the book and mark of the account's own network. On testnet this means: real-market signals, testnet
execution. The signer's price band applies to the testnet price against its own (real-market) price.

## 3. Leaving LIVE

Checked before every pass, from the server's own state: mandate not active / not this one, authorization gone, server lock,
approved version ≠ pinned hash, owner halt, divergence (venue vs records, by the reconciliation worker), a liquidation fill,
an order of the owner on the account that reached the signer (`manual_order`). Then, from the pass itself: a loss limit, an
exit refusal of the signer, an engine stop.

`beginExit`: revoke the mandate on the signer (no passkey; with cancel-all) → `STOPPING` → each pass closes the positions on
the mandate's instruments with reduce-only IOC orders (retry at most every 5 min after a refusal) → `STOPPED` when flat. When
nothing can be signed any more (wind-down over, authorization revoked, server lock), the agent stops and the stop reason names
the positions that REMAIN OPEN and how to close them (Futures terminal with the passkey, or the venue's interface).

Owner actions, none needs a passkey: `POST …/perp/live/stop` (as above), `pause` (no signal, no order; positions kept; loss
limits and stop conditions still watched; the mandate stays active), `resume`. Manual close stays possible in the Futures
terminal with a passkey; a manual order while the agent is LIVE takes the agent out of LIVE (it closes everything on the
mandate's instruments with reduce-only orders — the owner's manual position included — and stops).

## 4. Running it (owner)

Testnet: (1) create the agent, register and approve a strategy version; (2) Futures → Comptes: create the testnet account,
fund its address with mock USDC on the Hyperliquid testnet, approve the authorization (passkey) with limits at least as wide
as the agent's and its instruments; (3) agent page → "Passer en réel" → review sheet → checkbox → one passkey; (4) the engine
pass (every minute) trades; the page shows the venue's positions, orders, fills, funding, equity and the signer's counters;
(5) "Arrêter" → wind-down → STOPPED. Mainnet: the same on a mainnet account, after setting `SPW_DERIV_MANDATE_MAINNET=on` on
the API server (an operator action, not a UI switch) and restarting nothing (the setting is read at every use).

## 5. Not verified

- Anything on a funded real account (testnet or mainnet): the unfunded testnet run stops at the venue's refusal of the
  authorization. A live order filling, the leverage read and change, partial IOC fills, the timing of the venue's info endpoint
  after a fill and the 45 s wait against the real signer ledger were exercised only against the scripted fake.
- Several instruments at once (the fake has one book: BTC): the account-wide wait between exposure-adding orders, gross
  exposure across instruments and `signer_gross_exceeded` are covered by code path only.
- The real data gate and the Python signal with a LIVE agent (scripted in the tests and the simulation; they are the paper
  ones and have their own proofs).
- The engine and the reconciliation worker running concurrently in one process over hours; rate limits under real use.
- Mainnet: nothing was ever sent to it.
