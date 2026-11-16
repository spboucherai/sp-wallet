# V11 — market-making core: work notes, and what the integration step needs

Branch `v11-mm-core`, from local `v11` (`dbd62f2`). Design: `docs/V11-MARKET-MAKING.md`. Nothing in this branch is wired
into the running service: no route of the API, no agent family, no screen uses it; the signer gains three routes that
nothing calls yet. **No order was sent anywhere. No real key, no funded account, no testnet or mainnet exchange call.**
The only network activity was read-only: the public documentation, the public `info` endpoint (three requests on the zero
address, to confirm shapes) and the public WebSocket (market data of BTC, to record a tape).

## Verification observed (2026-11-15 / 16, this worktree)

| Check | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| new tests | 167: signer `venue-quoting.test.ts` 49 · derivatives `mm-primitives.test.ts` 36 · trading `mm.test.ts` 40 + `quoting-mandate.test.ts` 3 · API `mm-engine.test.ts` 39 |
| pre-existing signer + derivatives suites | green. Two existing files were touched, see "existing tests touched" below |
| full `pnpm test` (once, 2026-11-15 22:5x local) | 169 files: 163 passed, 2 skipped, 4 failed — 4 041 tests passed, 59 skipped, 4 failed. The 4: `packages/trading-sdk/test/generated.test.ts` (2) and `integration.test.ts` (file) — another workstream's; `api.test.ts › swap: quotes are for the wallet's own addresses` — known flaky under load, **passes alone**; `perp-agent.test.ts › the laboratory itself refuses the wrong contract` — the lab virtualenv did not exist in the worktree during that run; with `research/.venv` created (`uv sync --frozen`, not committed) the file **passes alone, 29 / 29** |
| `node scripts/build.mjs` | builds. Signer bundle 2 858 940 → 2 903 963 bytes (**+45 023, +1.6 %**), baseline rebuilt from `v11` with the same options |

**Existing tests touched** (both in `packages/derivatives/test/`, both expected consequences, nothing else was edited):
`live.test.ts` lists every file reachable from the entry point bundled into the signer — `live/quoting.ts` (pure) was added
to that list; no other existing test changed. In particular `hyperliquid/trading.test.ts` still passes unchanged: a
`scheduleCancel` is still described as `other` by default.

## 1. Items

### 1.1 Hyperliquid trading primitives (`packages/derivatives/src/venues/hyperliquid/`)

- **Initial state.** One order per action, one cancel per action, `scheduleCancel` not built and read as `other`; rounding
  helpers that refuse rather than round; no parser for a batch answer, for `orderStatus`, for `userRateLimit`.
- **Change.** `buildOrders` (1–40, duplicate client ids refused), `buildCancels` (all by oid or all by cloid),
  `buildScheduleCancel` (time or removal); `describe` reads batches (it already did) and, **only with
  `describeScheduleCancel: true`**, names a `scheduleCancel`; `submit` accepts it and treats it as an exit. `quoting-round.ts`:
  a bid only down, an ask only up, a size only down, dropped under 10 USD. `reconcile.ts`: batch answers per order (or one
  error for the payload, or *unknown*), order status by client id, address rate limit. `mappers.ts`: the status
  `scheduledCancel` (the one cancel status that does not end in "Canceled") was an unknown status → now a cancellation.
- **Tests.** 22 vectors produced by the official Python SDK 0.24.0 (`sdk-vectors-mm.json`, generator next to it, throwaway
  random key written in the fixture): our builder's action equals the SDK's key for key, same action hash, same signature.
  Refusal of smuggled fields (`builder`, priority `grouping`, `f`, extra keys, key order). Rounding properties (2 000 +
  1 000 + 1 000 runs). Parsers on the documented strings and on three recorded public answers.
- **Observed.** 36 / 36.
- **Limitation.** `modify` / `batchModify`, the fast-cancel flag `f` and priority fees are not built (decision in the
  design, §4). Maximum batch length is not documented by the venue; 40 is this code's own ceiling, 20 the signer's.

### 1.2 Quoting mandate, canonical form (`packages/derivatives/src/live/quoting.ts`)

- **Initial state.** One derivative mandate shape, `SPW-VENUE-MANDATE-v1`.
- **Change.** A second, separate shape `SPW-VENUE-QUOTING-MANDATE-v1`: schema with compiled ceilings, canonical bytes, hash,
  validation against the authorization, the quote band, the order-set bound (`quotingSetCheck`, built on the existing
  `worstCaseExposure`), an integer token bucket. `mandate.ts` and `canonical.ts` are not modified.
- **Tests.** In the signer suite: bytes of a fixed v1 mandate pinned to the hash computed on `v11` before this work
  (`58a24d2c…`, 791 bytes); band exact at its edges; properties of the band and of the set bound (3 000 runs each).
- **Limitation.** Bounds are in USD at the signer's price of the moment of signing: a position can grow in value afterwards.

### 1.3 Signer (`services/isolated-signer/src/venue-quoting.ts`, + `venue-read.ts`, `store.ts`, `signer.ts`, `server.ts`)

- **Initial state.** `/venue/mandate/sign`: one order per signature, any order type, ≤ 60 an hour.
- **Change.** `/venue/quoting/{approve,sign,revoke}`. See "Signer behaviour changes" below — that list is the review.
- **Tests.** 49, real signer code, fake venue behind the real reader, and for the price rules the real price view on
  scripted exchange answers. Every refusal of the brief individually: wrong instrument, non-Alo opening, size, resting
  count (per side, total), resting notional, worst-case inventory (also when it only breaches with what already rests or is
  pending), bid ≥ mid, ask ≤ mid, too far, too tight, stale price, single source, disagreeing sources, venue read failed /
  stale / malformed / inconsistent, floor, leverage setting, bucket empty and **not refilled by a restart**, hour / day /
  turnover, no switch / switch too close / too soon / too far / exhausted, expired / revoked / halted, a batch with one bad
  order, unknown action types (9), smuggled fields, replayed nonce, hash mismatch (20 single-field changes), mandate for
  another account, compiled bounds (22 over-the-ceiling values, one exactly at every ceiling). Exits under halt, revocation,
  expiry, unreadable venue. Property (60 runs × up to 30 adversarial steps, real signer): after every accepted batch the
  worst case over the truth — everything resting or still sendable — is inside the mandate; more than 40 accepted and more than 40 refused
  batches over the whole run of the property, so it is not vacuous.
- **Observed.** 49 / 49. One real defect of the first version was found by the simulator, not by these tests, and fixed:
  see the ledger, rule (2), in the design §4.
- **Limitation.** The signer cannot know that a `scheduleCancel` it signed was sent. Cancels and reduce-only orders are not
  metered. The signer's mid is spot.

### 1.4 `compileToQuotingMandate` (`packages/trading/src/mandate/quoting-mandate.ts`)

- **Change.** Trading mandate + `QuotingTerms` → quoting mandate, with an enforcement entry for every field and every term.
- **Tests.** 3: the result validates against the authorization; the report is complete and consistent with
  `compileToVenueMandate`; every value that cannot be expressed (about thirty cases) fails with a code and the field.
- **Limitation.** A trading mandate's `frequency` (≤ 500 a day) cannot express a quoting rate: reported API-only, quote
  rates come from the terms. Raising `TRADING_MANDATE_BOUNDS.maxOrdersPerDay` instead is a decision for the owners of
  `trading-mandate.ts` (another workstream).

### 1.5 Quoting core (`packages/trading/src/mm/`, entry point `@spw/trading/mm`)

- **Change.** `QuotePolicy` interface; Avellaneda–Stoikov with the study's formulas; EWMA volatility; `planQuotes`;
  `cycleBudget`; `stepBreakers` (11 breakers + kill switch); markouts at 1 s / 10 s / 60 s; PnL attribution.
- **Tests.** 40. Properties: the policy never emits a crossing pair (2 000); the planner never crosses, never exceeds the
  budget, never acts on an order of unknown state (4 000); the inventory bound holds under any fill sequence (4 000); the
  plan is stable (2 000); the budget (2 000); the attribution equals the mark-to-market exactly (1 500).
- **Observed.** 40 / 40, and the package's own purity test passes on the new files (no clock, no randomness, no `toFixed`
  / `D.toNumber`): the first version used floats for basis points and was rewritten to exact decimals because of it.
- **Limitation.** The paper rule `spread_inventory` is NOT ported or copied (it lives in
  `services/api/src/agent-runtime/families.ts`, another workstream): the interface is here, the runtime rule is to
  implement it. Two numbers are floating-point by nature (the volatility estimate and `ln`), each rounded once to 6
  decimals of a basis point. One quote per side per level; the planner does not replace-in-place.

### 1.6 Engine (`services/api/src/mm/`)

- **Change.** `ports.ts`, `engine.ts` (imports nothing from agents/, agent-runtime/, orders/, risk/, quotes/; not
  registered in `main.ts`), `live-adapter.ts` (separate, not wired; lock `SPW_DERIV_MM_MAINNET`), `sim-venue.ts`.
- **Tests.** 39, deterministic, on the recorded tape, with the real signer code in the loop and the live adapter as the
  `OrderPort`: start-up order, 5 minutes of normal quoting with per-tick invariants, shutdown, skew, soft and hard limits,
  each breaker, venue unreachable (the switch fires at the fake venue), answer lost after / before the venue took a batch,
  unreadable answer, crash and restart with resting orders, signer down, four deliberately out-of-mandate policies stopped
  by the signer, signer's mid ≠ venue's, kill switch with flatten, mandate expiry mid-session, venue rate limit, signer
  bucket, the three locks, the adapter's outcomes, the whole 36-minute session.
- **Observed.** 39 / 39. Simulated session: design §10.
- **Limitation.** Paper mode: `sim-venue.ts` is a fill model of its own (queue + trade-through), close to but not the
  runtime's `mmFills`; the integration decides which one stays. The simulator does not model latency, the IP limit, partial
  book depth or funding. The engine handles one instrument; "day" PnL is the session's PnL (the integration supplies a
  real UTC-day figure). IP weight: design §7 — the REST reconcile is too expensive for production.

## 2. Signer behaviour changes — for human review

1. **A new mandate kind** approved through the same passkey ceremony (`ctx.verify(assertion, hash)`): domain tag
   `SPW-VENUE-QUOTING-MANDATE-v1`, route `POST /venue/quoting/approve`, stored under `venueQuotingMandates`. Refused
   under halt, without a live `MANUAL_LIVE` authorization of this signer, beyond the authorization or the compiled bounds.
2. **A seventh path that signs without a per-operation passkey**: `POST /venue/quoting/sign`, trading key only. ADR 0001
   says "exactly six paths" — it must gain this row when the branch is merged (not edited here: not this workstream's file):

   | 7 | `POST /venue/quoting/sign` — a batch of post-only quotes, a batch of reduce-only orders, a cancel batch, or the venue's `scheduleCancel` | the venue trading key | a quoting mandate approved with the passkey, extending an authorization | cancel and `scheduleCancel(time)`: as row 4 (+ time ∈ [now + 6 s, now + deadManSeconds]). Reduce-only batch: one instrument of the mandate, limit orders only, each within the reduce band of the signer's own mid and under the size per order. Quote batch: mandate active, not halted, every order `Alo` + limit + client id, one instrument, each price in [min, max] bps on its own side of the signer's mid (never at or through it), size per quote, resting count and notional per side, total, worst-case inventory and gross from the signer's own venue read, floor, leverage setting, persisted token bucket + per-hour + per-day + turnover, an armed `scheduleCancel` that outlives the batch, ≤ 8 presumed triggers a day. Validity ≤ 30 s. Worst case for a compromised API: design §3 T1 |

3. **New action kinds signed by the trading key**: an `order` action with **more than one order** (≤ 20, one instrument,
   homogeneous), and **`scheduleCancel`** (with a time; without one only when the signer itself reads no open order and
   its ledger is empty). Neither is signed by `/venue/sign` or `/venue/mandate/sign`: both still answer `unsupported`
   with the same message (pinned).
4. **Quotes do not count against the authorization's `maxOrdersPerDay`.**
5. **One line added to `venueMandateApprove`** (directional): refused with `conflict` while a quoting mandate is active
   on the authorization. No other change to the directional or manual paths; two defensive `d.kind === 'schedule_cancel'`
   clauses were added to their existing "not an order, a cancel or a leverage change" refusals (unreachable today, since
   they do not ask `describe` to name a `scheduleCancel`).
6. **A new outbound request of the signer**: `orderStatus` on the pinned info hosts (same hosts, same `POST /info`).
   `VenueReader.order` is optional; without it nothing changes.
7. **New state in the signer store**, all optional fields:
   - `venueQuotingMandates?: Record<mandateId, { mandate, hash, approvedAt, revoked, revokedAt?, usage{day}, hours{hour}, bucket, dms }>`;
   - `VenuePendingOrder.q?: 1` on ledger entries created by quotes.
   **On-disk compatibility.** A state written before this work loads unchanged (the fields are absent). **Rollback
   rule.** A pre-V11-MM binary keeps both fields on disk untouched but does not know them: it would approve a
   directional mandate next to an active quoting mandate, and would count ledger entries marked `q` like any other (safe,
   over-counting). Therefore: **revoke every quoting mandate before rolling the signer back** (`/venue/quoting/revoke`
   needs no passkey). Rolling forward again needs nothing.
8. **Journal**: `venue.quoting.{approved,denied,revoked,sign.ok,sign.denied,switch_lapsed}`; every signed action and every
   refusal with its code. Volume: one record per signed action — a quoting session writes several per second at the
   compiled maximum (rotation exists since V11, B-05).
9. **Status**: `GET /status` gains `venueQuotingMandates[]` (phase, today's usage, `bucketActions`, `deadMan`, `pendingQuotes`).

Refusal codes of `/venue/quoting/sign`: `not_found, no_authorization, revoked, expired, wind_down, halted, bad_request,
wrong_venue, rejected, unsupported, policy, expired_action, stale_nonce, replay, batch, mixed_batch, instrument, order_type,
client_id, not_post_only, no_price, price, order_notional, quote_crosses_mid, quote_too_tight, quote_too_far, quote_notional,
resting_count, resting_total, resting_notional, inventory_exceeded, gross_exceeded, orders_day, orders_hour, turnover, rate,
no_switch, switch_exhausted, switch_too_soon, switch_too_far, switch_needed, venue_unreachable, venue_stale,
venue_inconsistent, unpriced_position, floor_equity, leverage_setting`.

## 3. Ports (`services/api/src/mm/ports.ts`)

```ts
MarketDataPort { snapshot(instrument): { status: 'connected'|'reconnecting'|'stale'|'idle'; book: BookTop | null } }
OrderPort {
  submitQuotes(instrument, quotes: { clientId, side, price, size }[]): Promise<BatchOutcome>
  submitReduces(instrument, orders): Promise<BatchOutcome>
  cancel(instrument, clientIds): Promise<CancelOutcome>
  scheduleCancel(timeMs | null): Promise<SwitchOutcome>
  openOrders(instrument): Promise<VenueOpenOrder[]>      account(instrument): Promise<{ position, accountValue, ts }>
  fills(instrument, sinceMs): Promise<VenueFill[]>       lookup(instrument, clientId): Promise<'open'|'filled'|'cancelled'|'rejected'|'not_found'>
  addressRequestsRemaining(): Promise<number>            readonly actionTtlMs: number
}
BatchOutcome = { kind: 'done', results: OrderResult[] }                              // per order: resting | filled | rejected
             | { kind: 'refused', stage: 'lock'|'signer'|'venue', code, message }    // CERTAIN that nothing exists
             | { kind: 'unknown', message }                                          // first-class: reconcile, never resend
RiskPort    { evaluate({ instrument, kind: 'quotes'|'reduce', orders, position }): Promise<{ allow, code, message }>; killSwitch(): Promise<boolean> }
MandatePort { current(): Promise<{ mandateId, phase, expiresAt, deadManSeconds, bucketActions, quotesLeftHour, quotesLeftDay } | null> }
ClockPort   { now(): number }        JournalPort { record({ ts, type, ... }): void }
```

Client ids are the venue's own (`0x` + 32 hex): 16 hex of session id + a 16-hex counter. `MmEngine`: `start()`, `stop()`,
`resume()`, `tick()`, `status()`. `createLiveMmAdapter({ network, account, mandateId, signer, venue, locks, now })` needs
exactly: `signer.venueQuotingSign({ mandateId, sign })` → `POST /venue/quoting/sign`; `venue.exchange(body, batchLength)`
and `venue.info(body)` → the existing `HlHttp`; `locks` → `envMmLocks(process.env)`.

## 4. Integration checklist

1. **Signer client** (`services/api/src/signer-client.ts`): `venueQuotingApprove`, `venueQuotingSign`, `venueQuotingRevoke`,
   and the `venueQuotingMandates` list in the status type. `recover` (V11 B-04) must adopt or revoke quoting mandates the
   API has no record of, like directional ones.
2. **Mandate storage and routes**: a table and prepare / approve / revoke routes for quoting mandates next to
   `deriv_mandates`; the jurisdiction acknowledgement shown again; `403 mm_mainnet_disabled`.
3. **Runtime**: family `market_making` gains a live mode in `FAMILY_MODES`; the stream engine owns the cadence and calls
   `MmEngine.tick()`; leases so that ONE worker runs a session; agent stop / pause / loss limit → `engine.stop()` and
   `venueQuotingRevoke`. The runtime rule `spread_inventory` implements `QuotePolicy` (one rule for paper and live).
4. **Quote hub as `MarketDataPort`**: top of book with the venue's timestamp and the stream status. Add the venue's
   `orderUpdates` and `userFills` WebSocket streams and make them the engine's primary reconcile (design §7); keep the REST
   reconcile as an audit every 30–60 s.
5. **Risk** (`RiskPort`): the unified risk engine's `evaluate` for a batch of quotes (worst case, like the signer's) and
   the kill-switch read. The engine treats an unreadable kill switch as a pulled one.
6. **Unified orders projection — recommendation: quotes are NOT rows.** A session places and cancels hundreds of quotes an
   hour (simulated: 495 quotes and 486 cancels in 35 minutes, one instrument, one level); as rows they would drown every
   other order and every screen. Recommended: **one row per session** (aggregate: quotes placed, cancelled, resting now,
   refusals by code), **one row per fill** (a real execution: price, size, fee, markouts), and **one row per reduce-only
   order** (it is a directional order). Every quote stays in the engine's journal and in the signer's journal, by client id.
7. **Risk screen**: the quoting-mandate form (terms + limits), with the enforced-by table of `compileToQuotingMandate`
   shown before the passkey prompt, as for the directional mandate.
8. **Monitoring / alerts**: breaker trips, halts, `signer_*` refusals, switch lapses (`today.lapses`, alert at 4 of 8),
   address requests remaining, IP weight, markouts, PnL attribution, heartbeat age.
9. **Capability summary line**: "market making: live on Hyperliquid, off unless three settings are on and a quoting
   mandate is approved".
10. **Runbook**: start, stop, what each halt means, the rollback rule of §2.7, what to do after a switch trigger.
11. **Docs to amend at merge**: ADR 0001 (row 7 above), the threat model rows 4 and 19, `docs/v6/DERIVATIVE-MANDATE.md`
    (exclusivity), `docs/TRADING-MANDATES.md` (the quoting shape), the deploy runbook (`SPW_DERIV_MM_MAINNET`).
12. **Testnet, with test funds, before anything else** — the six verifications of the design's go-live checklist, item 4.

## 5. Open questions for the owner

- **Capital** on the venue account, and the floor.
- **Instruments**: BTC only to start? (ETH and SOL are possible; nothing else is in the pinned table and none was added.)
- **Inventory limits**: soft / hard in the engine, `maxInventoryNotional` in the mandate.
- **Quote size and levels** (≥ 10 USD per quote; one level per side recommended to start).
- **Session hours**; `deadManSeconds` (30–60 s); the stop policy (`hold` or `flatten`) per breaker.
- **Acceptance, in writing, that the evidence is negative**: the lab study (modelled PnL negative on every Hyperliquid
  book, both fill rules) and this branch's simulation (−1.83 bps of volume, adverse markouts at 1 s, 10 s and 60 s), at a
  maker fee of 1.5 bps paid.
- **Jurisdiction**: the acknowledgement recorded for Hyperliquid in `docs/v4/venues/jurisdiction.md` applies unchanged and
  is committed again in the quoting mandate's hash; the decision to trade live remains the owner's.
- Whether `reserveRequestWeight` (buying rate limit, 0.0005 USDC per request) is ever wanted: it spends funds; not built.

## 6. Not built, and why

- `modify` / `batchModify`, fast cancels, priority fees: design §4.
- A leverage change under the quoting mandate: the brief excludes it; the owner sets leverage with the passkey.
- Multi-instrument batches and mixed batches: refused by design (a batch the signer classifies in one sentence).
- The port of `spread_inventory`: it would have been a fork of another workstream's rule.
- Anything on a funded account, testnet included: forbidden by the brief. Consequently NOT verified against the venue:
  that a new `scheduleCancel` replaces the previous one; that the trigger count increments with nothing resting; duplicate
  cloid behaviour; the lag of `frontendOpenOrders` after acceptance; `expiresAfter` rejection; real queue position.
