# Trading mandates

Module `packages/trading/src/mandate/trading-mandate.ts` of `@spw/trading`.

A trading mandate (`SPW-TRADING-MANDATE-v1`) is the single object that says what an agent or an API key may
do: on which accounts, venues and instruments, inside which limits, until when. The owner approves its
canonical hash once.

**A trading mandate is the API-side contract. It is not, by itself, enforced by the isolated signer.** The
signer enforces the two shapes it already stores:

- the spot vault mandate `SPW-MANDATE-v1` (`packages/core/src/mandate.ts`);
- the derivative mandate `SPW-VENUE-MANDATE-v1` (`packages/derivatives/src/live/mandate.ts`).

The compilers below derive those shapes from a trading mandate and report, field by field, what the signer
then enforces and what remains enforced by the API only. A field enforced by the API only is one a
compromised API could ignore. That report is data: it is meant to be shown to the owner at approval.

Status: schema, checks and compilers are the core. Since Phase F the API service stores mandates, has them
approved and checks every order of an agent or an API key against them (`services/api/src/mandates/`); the
section "In the API service" describes it. The isolated signer was not changed: a live mandate is approved
there through the derivative-mandate flow it already had.

## Schema

| Field | Meaning |
|---|---|
| `mandateId` | uuid |
| `principal` | `{ kind: 'agent' \| 'api_key', id }` |
| `accounts` | 1–8 accounts: a vault (`vaultIndex ≥ 1`, address, network) or a venue account (venue, network, account) |
| `venues`, `networks` | every venue and network the mandate covers |
| `instruments` | explicit ids `${venue}:${symbol}`. `${venue}:*` is accepted in a paper mandate only |
| `marketKinds` | `spot`, `perp` |
| `orderTypes` | `market`, `limit`, `stop`, `take_profit` |
| `maxCapitalUsd` | capital committed: the collateral or inventory at risk |
| `maxOrderNotionalUsd` | one order |
| `maxPositionNotionalUsd` | per instrument |
| `maxLeverage` | ≥ 1; exactly 1 for a spot-only mandate |
| `maxDailyLossUsd` | no new risk once today's loss reaches it |
| `floorEquityUsd` | maximum total loss, as a floor: no new risk while the equity is below it |
| `createdAt`, `notBefore`, `notAfter` | unix seconds; at most `TRADING_MANDATE_MAX_DAYS` (90) days |
| `frequency` | `{ perMinute, perHour, perDay }` |
| `maxSlippageBps`, `maxFeeUsd` | per order |
| `stopConditions` | declarative, one per kind: `loss_gte { usd }`, `drawdown_gte { bps }`, `consecutive_rejects_gte { count }`, `data_stale_gte { ms }`, `signer_unreachable_gte { ms }` |
| `mode` | `paper` or `live` |
| `strategySha256` | hash of the strategy code; required for an agent, null for an API key |
| `label` | display name |

Units: times of the mandate are unix seconds, as in the two signer shapes. Times of orders are unix
milliseconds; `checkOrder` takes its clock in milliseconds.

**Hash.** `tradingMandateHash` is SHA-256 of a domain-separated, length-prefixed serialization with every
list sorted. Reordering a list does not change the hash; changing any field does (tested field by field).

**Immutable.** There is no update function. A change is a new mandate with a new id and a new hash; the old
one is revoked. `revokeTradingMandate` builds the record
`{ mandateId, mandateHash, revokedAt, revokedBy, reason, supersededBy, detail }`: a revocation names exactly
one immutable object. Reasons: `owner_request`, `superseded`, `stop_condition`, `key_compromise`,
`authorization_ended`, `kill_switch`.

**Validity** (`validateTradingMandate(m, nowSec)`): no duplicates; every instrument on a venue of the
mandate and every venue with an instrument; accounts on its networks and venues; no wildcard in a live
mandate; order ≤ position ≤ capital × leverage; floor below the capital; `perMinute ≤ perHour ≤ perDay`;
`createdAt ≤ notBefore < notAfter`; creation time current; duration within the maximum; an agent names its
strategy.

**Phases** (`tradingMandatePhase`): `pending` before `notBefore`; `active`; `wind_down` for 24 h after the
expiry or the revocation (the signer's own wind-down constant), during which only strictly reducing orders
pass; then `ended`.

## `checkOrder(mandate, order, usage, nowMs)`

Returns `{ decision: 'allow' | 'deny', reasons, orderNotionalUsd }`. It collects every reason. The mandate
holds no state: `usage` is supplied by the caller — the revocation time, the account the order is sent
from, whether the risk engine found the order strictly reducing, a reference price, the position notional
and the capital in use after the order, equity, today's realised loss, total loss, drawdown, order counters,
consecutive rejects, data staleness and signer downtime. A malformed input denies with `INVALID_INPUT`.

Also exported as `checkTradingMandateOrder`, because `packages/derivatives` exports another `checkOrder`.

A strictly reducing order is exempt from what would stop an exit: capital, position, daily loss, floor,
frequency, order type, stop conditions, the start of the window and the wind-down. It stays bound to the
principal, the account, the venue, the network, the instrument, the mode, the per-order notional, slippage
and fee bounds, and to the end of the mandate.

Deny codes: `MANDATE_NOT_YET_VALID`, `MANDATE_ENDED`, `MANDATE_REVOKED`, `WIND_DOWN_REDUCING_ONLY`,
`PRINCIPAL_MISMATCH`, `MANDATE_ID_MISMATCH`, `MODE_MISMATCH`, `ACCOUNT_NOT_ALLOWED`, `VENUE_NOT_ALLOWED`,
`NETWORK_NOT_ALLOWED`, `INSTRUMENT_NOT_ALLOWED`, `MARKET_KIND_NOT_ALLOWED`, `ORDER_TYPE_NOT_ALLOWED`,
`NOTIONAL_UNKNOWN`, `ORDER_NOTIONAL_EXCEEDED`, `POSITION_NOTIONAL_EXCEEDED`, `CAPITAL_EXCEEDED`,
`LEVERAGE_EXCEEDED`, `LEVERAGE_UNKNOWN`, `DAILY_LOSS_REACHED`, `BELOW_FLOOR_EQUITY`, `RATE_PER_MINUTE`,
`RATE_PER_HOUR`, `RATE_PER_DAY`, `SLIPPAGE_ABOVE_MANDATE`, `FEE_ABOVE_MANDATE`, `ORDER_OUTLIVES_MANDATE`,
`STOP_LOSS_GTE`, `STOP_DRAWDOWN_GTE`, `STOP_CONSECUTIVE_REJECTS_GTE`, `STOP_DATA_STALE_GTE`,
`STOP_SIGNER_UNREACHABLE_GTE`, `INVALID_INPUT`.

## Compilation to the signer shapes

```ts
compileToVenueMandate(m, { authorization, ackSha256 })  → { shape, mandate: VenueMandate, enforcement, derived }
compileToSpotMandate(m, { keyId, provider, assets, instrumentAssets }) → { shape, mandate: Mandate, enforcement, derived }
compileTradingMandate(m, { hyperliquid?, kyberswap? })  → { venue: [...], spot: [...] }
```

- `enforcement` has one entry per field of the trading mandate — always all of them; a field left out of
  the table is a programming error that throws. Each entry is
  `{ field, enforcedBy: 'signer' | 'signer_partial' | 'api_only' | 'not_applicable', signerField, note }`.
- `derived` lists the values of the signer shape that were computed rather than copied.
- The result of `compileToVenueMandate` passes the existing `validateVenueMandate` against its
  authorization, and the result of `compileToSpotMandate` passes the existing `validateMandate` (tested).

**No field is silently dropped, narrowed or widened.** If a value cannot be expressed exactly, compilation
fails with a `TradingMandateError` that carries a code and the field:

| Code | When |
|---|---|
| `paper_mandate_has_no_signer_form` | a paper mandate is never sent to the signer |
| `no_signer_mandate_for_venue` | the venue has no signer-side mandate — today every venue except Hyperliquid (derivative) and KyberSwap (spot vault). GMX is the example: its orders need an approval per order |
| `venue_not_in_mandate`, `market_kind_not_expressible` | the mandate does not cover that venue or that market kind |
| `account_not_in_mandate`, `ambiguous_account` | a signer mandate covers exactly one account or vault |
| `binding_mismatch` | the venue authorization or the vault binding is missing or is for another account |
| `instrument_not_expressible` | an instrument id the signer does not accept, or whose assets are not known |
| `value_not_expressible` | non-integer leverage on Hyperliquid; a value outside the signer's bounds (more than 60 orders per hour, a price band outside 10–2000 bps, slippage outside 10–500 bps for a vault, a zero floor) |
| `duration_not_expressible` | a derivative mandate lasts at most 30 days |
| `exceeds_authorization` | a limit above the venue authorization's, or a mandate that would outlive it |
| `strategy_hash_required` | both signer shapes record a strategy hash; a mandate without one cannot be compiled |
| `missing_price` | no decimals or USD price for an asset of a spot instrument |

`compileTradingMandate` compiles a live mandate for every venue it names and fails if any of them has no
signer-side mandate or no binding. A live mandate with a venue the signer does not bound is therefore never
accepted as signer-enforced.

Derived values:

- derivative: `maxGrossExposure = maxCapitalUsd × maxLeverage`;
  `maxDailyTurnover = maxOrderNotionalUsd × frequency.perDay`; the same `maxLeverage` and
  `maxPositionNotional` for every instrument; `maxPriceDeviationBps = maxSlippageBps`;
- spot: `maxOrder[asset] = maxOrderNotionalUsd ÷ price`, in base units, rounded down;
  `maxDaily[asset] = maxOrder × frequency.perDay`; `assets` = the base and quote assets of the mandate's
  instruments on that venue. The base-unit caps are fixed at the approval prices and drift in USD terms as
  prices move.

## Enforced-by table

Generated by compiling the reference mandate of `packages/trading/src/docs.ts` to both shapes. The text of
each cell is the `note` the owner would see.

<!-- GENERATED:enforced-by -->
| Trading mandate field | Derivative mandate `SPW-VENUE-MANDATE-v1` (Hyperliquid) | Spot mandate `SPW-MANDATE-v1` (KyberSwap vault) |
|---|---|---|
| `v` | **n/a**. version of the trading mandate; the signer shape has its own | **n/a**. version of the trading mandate; the signer shape has its own |
| `mandateId` | **signer** — `mandateId`. the derivative mandate carries the same id: one id for the pair | **signer** — `mandateId`. the spot mandate carries the same id |
| `principal` | **signer (partly)** — `agentId`. recorded by the signer for the audit trail; the signer cannot verify who calls it — the API binds the principal to the mandate | **API only**. the spot mandate does not name the principal: the signer only knows the vault key; the API binds the principal to the mandate |
| `accounts` | **signer** — `account, agentAddress, authorizationId`. the signer signs for this one venue account only; the mandate's 1 other account(s) are outside this shape | **signer** — `vaultIndex, vault, network`. orders spend from and deliver to this vault only; the mandate's 1 other account(s) are outside this shape |
| `venues` | **signer** — `venue`. the shape is for hyperliquid only; kyberswap need their own signer mandate or stay API-enforced | **signer** — `provider`. swaps through kyberswap only; hyperliquid need their own signer mandate or stay API-enforced |
| `networks` | **signer** — `network`. the venue network of the authorization | **signer** — `network`. one network per spot mandate: the vault's |
| `instruments` | **signer** — `instruments[].instrument`. the signer refuses an order or a leverage change on any other instrument; a cancel is bounded by the instruments of the venue authorization, which may be wider | **signer (partly)** — `assets, maxOrder`. the signer enforces the SET of assets (both legs of every swap) and which can be sold; it does not know instruments, so any pair between mandated assets passes |
| `marketKinds` | **signer**. structural: this shape signs perpetual orders only | **signer**. structural: this shape signs spot swaps only |
| `orderTypes` | **API only**. the signer signs any order type the venue adapter can build; the allowed types are checked by the API | **signer (partly)**. structural: the signer signs an immediate swap with a minimum output — a market order with a slippage bound; resting or trigger orders do not exist here and are handled (or refused) by the API |
| `maxCapitalUsd` | **signer (partly)** — `maxGrossExposure`. enforced as worst-case gross exposure ≤ capital × leverage; the capital itself (collateral on the venue) is not capped by the signer | **API only**. the vault is bounded only by what the owner sends to it; the capital limit is checked by the API |
| `maxOrderNotionalUsd` | **signer** — `maxOrderNotional`. size × highest named price of one order, reduce-only orders included | **signer (partly)** — `maxOrder`. enforced per sold asset in base units fixed at approval prices: the USD value drifts with the market |
| `maxPositionNotionalUsd` | **signer** — `instruments[].maxPositionNotional`. worst case per instrument, from the signer's own read of the venue account and its own prices | **API only**. the signer has no position limit for a vault |
| `maxLeverage` | **signer** — `instruments[].maxLeverage`. the signer refuses an order that can add exposure while the venue's leverage setting is higher, and never sets a higher one | **n/a**. spot swaps carry no leverage |
| `maxDailyLossUsd` | **API only**. the signer has no daily-loss limit; it only knows the floor | **API only**. the signer has no loss limit for a vault |
| `floorEquityUsd` | **signer** — `floorEquity`. below the floor the signer signs reduce-only orders and cancels only (the venue's own account value) | **API only**. the signer has no loss limit for a vault |
| `createdAt` | **signer** — `createdAt`. must be current at approval | **signer** — `createdAt`. must be current at approval |
| `notBefore` | **signer (partly)** — `createdAt`. the signer has no start time: it signs from the approval on, and accepts an approval only while createdAt is within 10 minutes before and 2 minutes after its own clock; the start itself is checked by the API | **signer (partly)** — `createdAt`. the signer has no start time: it signs from the approval on, and accepts an approval only while createdAt is within 10 minutes before and 2 minutes after its own clock; the start itself is checked by the API |
| `notAfter` | **signer** — `expiresAt`. after it the signer signs only cancels and reduce-only orders for 24 h, then nothing | **signer** — `expiresAt`. the signer refuses any order after it |
| `frequency` | **signer (partly)** — `maxOrdersPerDay, maxOrdersPerHour`. per day and per hour are enforced by the signer (orders that can add exposure; the venue authorization's own daily count applies as well); per minute is enforced by the API only | **signer (partly)** — `maxOrdersPerDay, maxDaily`. orders per day and a daily volume per sold asset are enforced by the signer; per hour and per minute by the API only |
| `maxSlippageBps` | **signer (partly)** — `maxPriceDeviationBps`. the signer enforces a price band around its own mid on every price of an order — except a reduce-only trigger order, whose trigger may rest between one third and three times the mid, its worst price then being held within the band of the trigger; realised slippage is checked by the API | **signer** — `maxSlippageBps`. the guaranteed output must be worth at least (1 − this) of the input at the signer's own prices |
| `maxFeeUsd` | **API only**. the signer does not see venue fees | **API only**. the signer applies the fee ceiling of its own policy, not the mandate's |
| `stopConditions` | **API only**. declarative conditions are evaluated by the API; the signer only stops on the floor, the expiry, a revocation and its own halt | **API only**. declarative conditions are evaluated by the API; the signer only stops on the expiry, a revocation and its own halt |
| `mode` | **n/a**. the signer has no notion of paper or live: a mandate reaches it only when it is live (a paper mandate is never compiled); the venue network is the row `networks` | **n/a**. the signer has no notion of paper or live: a mandate reaches it only when it is live (a paper mandate is never compiled) |
| `strategySha256` | **signer (partly)** — `strategySha256`. recorded by the signer for the audit trail; the signer cannot verify what code runs | **signer (partly)** — `strategySha256`. recorded by the signer for the audit trail; the signer cannot verify what code runs |
| `label` | **API only**. a display name; not part of the signer shape | **signer (partly)** — `label`. part of the hash the passkey approved and recorded by the signer; a name has nothing to enforce |
<!-- /GENERATED:enforced-by -->

Reading the table: on the derivative shape the signer enforces the instruments, the order and position
limits, the leverage, the floor, the expiry and the account. It enforces the capital only as a gross
exposure bound, the frequency per day and per hour only, and the slippage only as a price band. The daily
loss limit, the allowed order types, the fee cap and every declarative stop condition are API-only. On the
spot shape the signer has no capital, position or loss limit at all.

### Where the signer enforces each row (verified against its source, 2026-11-15)

`S` = `services/isolated-signer/src`, `L` = `packages/derivatives/src/live`, `C` = `packages/core/src`.
"recorded" = stored and part of the approved hash, with nothing to enforce. "none" = no line of the signer
looks at it.

| Trading mandate field | Derivative mandate (Hyperliquid) | Spot mandate (KyberSwap vault) |
|---|---|---|
| `mandateId` | the stored mandate is looked up by it: `S/venue-mandate.ts:152-154`; approved once: `:75` | `S/signer.ts:154-155`; approved once: `:127` |
| `principal` | recorded (`agentId`, `L/mandate.ts:75`, `S/venue-mandate.ts:82`); no line checks who calls | none |
| `accounts` | the authorization's account is the wallet's own address and the trading key the signer's own (`S/venue.ts:67-69`); the mandate must name them (`L/mandate.ts:90`); no sub-account or vault (`S/venue-mandate.ts:175`); the signer's venue read is of that account (`:107`) | `C/mandate.ts:79`, `:82`; `S/signer.ts:163-164` |
| `venues` | `S/venue-mandate.ts:167` (and the schema: `venue` is the literal `hyperliquid`) | `C/mandate.ts:81` |
| `networks` | `S/venue-mandate.ts:167` | `C/mandate.ts:80` |
| `instruments` | orders: `S/venue-mandate.ts:209-210`; leverage: `:251-252`; cancels: the AUTHORIZATION's list, `:187` | the asset set, both legs: `C/mandate.ts:83`; sellable assets: `:87` |
| `marketKinds` | structural (the pinned asset table read by `describe`, `S/venue-mandate.ts:170-173`) | structural (`S/signer.ts:170`: a swap or nothing) |
| `orderTypes` | none | structural only |
| `maxCapitalUsd` | as gross exposure: `S/venue-mandate.ts:240` | none |
| `maxOrderNotionalUsd` | `S/venue-mandate.ts:211-212` (before the reduce-only branch: reduce-only orders included) | per sold asset, base units: `C/mandate.ts:88` |
| `maxPositionNotionalUsd` | `S/venue-mandate.ts:238-239` | none |
| `maxLeverage` | `S/venue-mandate.ts:237` (the venue's setting), `:254` (a change) | n/a |
| `maxDailyLossUsd` | none | none |
| `floorEquityUsd` | `S/venue-mandate.ts:232` | none |
| `createdAt` | at approval: `L/mandate.ts:109` (called from `S/venue-mandate.ts:68`) | at approval: `C/mandate.ts:66` |
| `notBefore` | none at signing; only the window on `createdAt` above | the same |
| `notAfter` | `S/venue-mandate.ts:163-164` (ended), `:224` and `:248` (wind-down) | `C/mandate.ts:78` |
| `frequency` | per day `S/venue-mandate.ts:226` (+ the authorization's count `:227`), per hour `:228`; per minute: none | orders per day `C/mandate.ts:90`, daily volume `:89`; per hour and per minute: none |
| `maxSlippageBps` | `S/venue-mandate.ts:219` (rule `L/canonical.ts:226-237`) | `C/mandate.ts:105-106`, called from `S/signer.ts:182` |
| `maxFeeUsd` | none | the signer's own policy ceiling, `C/mandate.ts:91` — not the mandate's value |
| `stopConditions` | none | none |
| `mode` | n/a | n/a |
| `strategySha256` | recorded (`L/mandate.ts:75`, `S/venue-mandate.ts:82`) | recorded (`C/mandate.ts:46`, `S/signer.ts:139`) |
| `label` | not in the shape | recorded (`C/mandate.ts:46`) |

Cells of the generated table corrected by this verification: `notBefore` (was "signer": the signer has no
start time — signer partly), `mode` (was "signer": the signer has no notion of paper or live — n/a, both
shapes), spot `label` (was "signer": recorded, nothing to enforce — signer partly), `instruments` (a cancel
is bounded by the authorization's instruments), `maxSlippageBps` (the reduce-only trigger exception),
`frequency` (the authorization's daily count applies too). `services/api/test/enforcement-pin.test.ts` asks
the real signer directly: every `signer` / `signer (partly)` row of the derivative shape has a refusal case,
and every `API only` row a case where the signer signs although the trading mandate forbids it.

## Subset helpers

`isSubsetOfVenueMandate(m, signerMandate)`, `isSubsetOfSpotMandate(m, signerMandate, binding)` and the
dispatching `isSubsetOf` answer: on every limit the signer enforces, does the trading mandate allow no more
than the signer does? They return `{ ok, violations: [{ field, message }] }`. Whatever compiles is a subset
of its own compilation (property-tested). For a spot mandate the comparison depends on current prices: if an
asset falls, the same USD limit is more base units than the signer's fixed cap, and the helper reports it.

## In the API service (Phase F)

Code: `services/api/src/mandates/service.ts`, routes in `services/api/src/orders/index.ts`
(`/api/v1/mandates`). Tables: `trading_mandates`, `trading_mandate_usage`.

### Who may do what

Only the owner's session creates, approves or revokes a mandate. The routes are outside `/api/v1/trading`:
an API key is refused on each of them with 403 `key_path_forbidden`, whatever its scopes. A key can do
nothing to a mandate, its own included. There is no route that changes a mandate: it is immutable, and a
change is a new mandate plus the revocation of the old one.

### Lifecycle

| State | Meaning |
|---|---|
| `created` | stored, validated, and for a live mandate already compiled. It has no effect |
| `pending_signer` | live: the approval was prepared at the signer and waits for the passkey |
| `active` | approved. Its phase is `pending`, `active`, `wind_down` or `ended`, from its dates |
| `revoked` | by the owner (`owner_request`) or by the supervisor (`stop_condition`). Final. Reductions pass for the wind-down period (24 h) |
| `failed` | the signer refused the approval. Create a new mandate |

Creation (`POST /api/v1/mandates`) takes the principal, the wallet's own account ids, the instruments, the
order types, the limits, a duration in days and the stop conditions. The server stamps `mandateId`,
`createdAt`, `notBefore` and `notAfter`, derives `venues` and `networks` from the accounts, and checks that the
principal exists (an API key that is not revoked, or an agent).

Refused at creation:

| Case | Answer |
|---|---|
| a venue restricted for the owner's jurisdiction (dYdX, edgeX), in any mode | 403 `venue_restricted` |
| a live mandate that names a venue with no signer-side mandate (GMX, anything else) | 422 `no_signer_mandate_for_venue` |
| a live spot mandate (KyberSwap vault) | 422 `spot_mandate_via_agent_vault`: it is approved through an agent vault, by the agents workstream |
| a live mandate that does not compile | 422 with the compiler's code and field (`value_not_expressible`, `exceeds_authorization`, `duration_not_expressible`, …) |
| a live mandate behind a closed server lock | 403 `mainnet_disabled` or `mandate_mainnet_disabled` |
| an invalid mandate | 400 `invalid_mandate` with the field |

API-only enforcement is not accepted for live autonomous trading. GMX stays one passkey per order, by the
owner.

### Approval

**Paper.** No signer and no passkey: `POST /mandates/:id/approve` activates it. The enforcement table says
"API only" for every field, because nothing is signed in paper mode.

**Live (Hyperliquid).** One ceremony, two passkey prompts:

1. `POST /mandates/:id/approve/prepare` compiles the mandate again against the venue authorization as it is
   now (`compileToVenueMandate`) and prepares the result at the Hyperliquid engine
   (`exec.ts` `prepareCompiledMandate`). The engine applies the checks it applies to any derivative mandate:
   the mandate is for this account and its authorization, `validateVenueMandate`, the pinned asset table, the
   acknowledgement that is displayed, no other mandate active on the account, the signer not halted.
2. The answer is the approval sheet: every field of the trading mandate, its **full hash**
   (`tradingMandateHash`), the compiled derivative mandate and its hash, the enforcement table (one row per
   field, verbatim from the compiler), the derived values, the jurisdiction acknowledgement, and two WebAuthn
   requests: `signer.options` and `binding.options`.
3. `POST /mandates/:id/approve { assertion, bindingAssertion, acknowledged: true }`:
   - `bindingAssertion` is verified first, by the API (`verifyOwnerAssertion`, single use). Its challenge is
     the hash of the intent `SPW-TRADING-MANDATE-APPROVAL-v1`
     `{ mandateId, tradingMandateHash, principal, mode, signer: { shape, mandateHash }, nonce, createdAt, expiresAt }`.
     The intent and the assertion are stored with the mandate (`trading_mandates.approval`) before the signer
     is asked;
   - `assertion` then goes through the engine's existing `approveMandate`: the signer verifies the passkey
     over the hash of the derivative mandate and stores it.
4. The API activates the trading mandate only if the mandate the signer approved has the same id and the same
   hash as the one compiled from it — the hash the stored intent names.

**What the passkey signs.** Two things. (1) At the signer: the hash of the compiled derivative mandate
(`SPW-VENUE-MANDATE-v1`), the object the signer stores and enforces. The fields marked "API only" are not in
that hash. (2) At the API: the intent above, which names the full trading mandate hash — every field, the
API-only ones included — and ties it to that derivative mandate.

**The row is verified at every use.** Each time a mandate is loaded to judge an order, to bind a key, or by
the supervisor (`MandateService.integrity`): the stored object must hash to the recorded hash; the columns
the service filters on (id, principal, mode, account mapping) must say what the hashed object says; and for a
live mandate the stored assertion must verify again — the signature of a passkey that is still enrolled, over
the stored intent, which must name this mandate's full hash and the signer mandate recorded. A row that fails
is unusable: orders answer 403 `mandate_integrity` (reductions included — the owner closes), the mandate
view shows `integrity: { ok: false, reason }`, and the supervisor revokes it, at the signer too. A paper
mandate has no passkey: only the hash and column checks apply.

**What this protects against, and what it does not.**

| Scenario | Protected? |
|---|---|
| A stolen owner session, a bug or an injection that can write the `trading_mandates` row but cannot produce a passkey assertion: raising the daily-loss limit, adding an order type, removing a stop condition, pointing the mandate at another key | yes — the altered row no longer matches the approved hash, and a recomputed hash is not the one the passkey signed |
| The same, rewriting the mandate AND its `hash` AND copying the `approval` of another mandate | yes — the intent names the mandate id and its hash |
| A restored or edited database in which a mandate was replaced by an older, wider one under the same id | yes when the hash differs; an older row with its own valid approval and the same id cannot exist (ids are single-use, mandates immutable) |
| A mandate created `active` directly in the database, never approved | yes for live (no approval); a paper mandate has no passkey and moves no funds |
| Someone who can also rewrite the `credentials` table (enrol his own passkey in the API's copy) | **no** — the API verifies against its own copy of the passkeys. The signer has its own pinned copy and still bounds what can be signed |
| A compromised API process | **no** — it skips the check. It remains bounded only by the signer-enforced subset of the mandate (the table above), exactly as before |
| Replay of the stored assertion for another purpose | the challenge is domain-separated and names the mandate; the signer never accepts it (another challenge) |

Side effect, by design: a mandate approved with a passkey that is later removed from the wallet stops being
usable (and is revoked by the supervisor). Approve it again with a current passkey.

**Still open for human review.** One prompt instead of two, and a record the API cannot forge, would need
the signer to carry the hash: add `tradingMandateSha256` to `SPW-VENUE-MANDATE-v1`, part of its hash, recorded
by the signer like `strategySha256`. It was not done here (no signer change in this phase); see
`V11-SECURITY-REVIEW.md`.

A live mandate must be approved within about ten minutes of its creation: the signer requires a current
creation time. After that, create it again.

**One principal per live venue account.** The signer holds one active mandate per authorization, and a
venue's position is not separable by principal. A live mandate for a venue account that already carries an
approved or pending trading mandate, or a perp agent's active derivative mandate, is refused at creation and
again at the approval: 409 `account_has_active_mandate`, with `data.holder` (`via`, `mandateId`, `principal`).
Nothing is stored. Revoke the holder first (its wind-down does not block a new mandate), or use another venue
account. On a paper account several principals may hold a mandate: the provenance ledger keeps their lots
apart.

**Whose position a key may reduce.** `checkOrder` binds a reduction to the mandate's account and instrument;
the order service adds provenance (`orders/provenance.ts`, described in `V11-RISK-MODEL.md`): a key or an
agent reduces only what its own fills opened — not what the owner opened by hand on the same account and
instrument, and not another principal's part.

### An API-key principal in the signer shape

Both signer shapes carry `strategySha256`. An API key has no strategy. For an API-key principal the field
carries the SHA-256 of the canonical principal descriptor

```
spw-principal-v1|api_key|<key id>
```

and `agentId` carries the key id. The signer records both fields for the audit trail and never interpreted
them. The Hyperliquid engine compares both with what the caller presents (`mandate_mismatch`).

### Binding a key

`api_keys.mandate_id` is verified when it is set (`verifyKeyBinding`): the mandate exists, is approved and
active, and was approved for this key. A key is created without a mandate, because its id does not exist
before; the owner then approves a mandate for it and binds it with a key update, which needs the passkey
(binding is a widening). At each order the mandate is loaded again: a mandate that is not approved, or was
approved for another principal, refuses with 403.

### Checking an order

`checkOrder` runs for every order of an agent or an API key, after the risk engine (which decides
`reducing`). The usage it needs is measured by the service:

| Input | Source |
|---|---|
| account | the mandate's account that matches the order's account |
| position after, reference price | the risk evaluation |
| capital in use after | margin used on the mandated accounts, plus the margin the order adds at its leverage |
| equity | the mandated accounts, as the risk context read them |
| realised loss today | stored fills of the mandated accounts |
| total loss | equity at approval minus equity now |
| drawdown | from the highest equity seen since approval |
| orders in the last minute, hour, day | the `orders` table, for this mandate, reduce-only and refused orders excluded |
| consecutive refusals | counted per mandate: a refused order adds one, an accepted one resets |
| data age | age of the ticker the order is priced on |
| signer unreachable for | measured by the supervisor |

A denial is HTTP 403 `mandate_denied` with every deny code, and the order is `REJECTED / MANDATE_DENIED`.

### Stop conditions and wind-down

The supervisor (the `orders` loop, every 5 s) evaluates the stop conditions of the active mandates:
`loss_gte`, `drawdown_gte`, `consecutive_rejects_gte`, `signer_unreachable_gte`. `data_stale_gte` is judged
per order. When one is met the mandate is revoked with the reason `stop_condition`:

- at the signer first, for a live mandate. If the signer cannot be reached the API still stops accepting
  orders under the mandate at once, records `signerRevoked: false`, and the supervisor asks the signer again
  until it has revoked its copy;
- the orders that rest under the mandate and could add risk are cancelled;
- strictly reducing orders pass for the wind-down period, then nothing.

Revocation by the owner (`POST /mandates/:id/revoke`) does the same.

## Agents

How the agents runtime uses this service (V11.2, `docs/v11/work/agents-bind.md`).

| Agent | Mode | Mandate | Created by | Approved | Enforced by |
|---|---|---|---|---|---|
| perp (bar engine) | paper | trading mandate, mode `paper` (`agents/paper-mandate.ts`) | the owner, or a key holding `agents:manage`, when paper starts — from the agent's own limits, inside the key's restrictions and per-order limit | no passkey (nothing is signed) | the API, on every order (`checkOrder`), with the usage counters of this service |
| perp (bar engine) | live | trading mandate, mode `live` (`agents/mandate-write.ts` `createLiveMandate`) → compiled into the signer's `SPW-VENUE-MANDATE-v1` | the owner: agent page (prepare) or the agent's mandate draft, then `/risk?mandate=<id>` | two passkey prompts (the signer's, the API's binding), on the agent page or in the Risk screen | the signer (compiled fields) and the API (every field) |
| spot (agent vault) | live | the signer's spot mandate `SPW-MANDATE-v1` — **not a trading mandate** | the owner, agent page | one passkey, judged by the signer | the signer (per-asset base-unit caps, the provider, the vault) |
| spot | paper | none | — | — | the agent's own limits; the kill switch |
| stream (market making, cross-exchange, funding arbitrage) | paper | none | — | — | the agent's own limits on its simulated book; the kill switch |
| risk management | — | none (it places no order) | — | letting it act on LIVE agents is the owner's `start live` | — |

**The asymmetry, stated.** A live spot agent does not hold a trading mandate: this service refuses one
(`spot_mandate_via_agent_vault`), because the signer enforces spot through the vault mandate it already has and a
second, API-only mandate would add nothing the signer checks. A spot agent's swaps are still unified orders (projected
from `agent_orders`), are stopped by the kill switch, and do not appear under "mandates" in the Risk screen. Usage
counters, stop conditions and the wind-down of this document therefore exist for perp agents and API keys only; a spot
agent's limits and loss limit are the engine's and the signer's (`docs/TRADING-AGENTS-AUDIT.md`, D3 and D13).

**Lifecycle of a live perp agent's mandate.**

1. `createLiveMandate` — from the agent's limits and the venue account's value (`deriveMandate`, unchanged): state
   `created`. One pending mandate per agent (a second creation supersedes the first).
2. Approval — agent page (`perp/live/prepare` → `perp/live/approve`) or Risk screen (`/api/v1/mandates/:id/approve…`).
   The signer receives the compiled derivative mandate under the SAME id as the trading mandate.
3. Start — the agent page's approval starts the agent; after an approval in the Risk screen the owner starts it
   (`POST /agents/:id/start { mode: 'live' }` → `activateLive`, which only reads the mandate service: active, live, for
   this agent, this venue account, this strategy version). A key cannot do that first start.
4. Use — every order is `submitCanonical` under the mandate: counters, `checkOrder`, provenance.
5. End — the agent's stop or a loss limit revokes at the signer, then here (`owner_request` / `stop_condition`); a
   revocation or a stop condition from this service revokes the signer's copy, and the agent winds down on its next pass
   (`mandate_revoked`). Pause keeps the mandate.

**What the compilation changes for an agent** (compared with the derivative mandate the agents derived themselves
before V11.2; the approval sheet shows the compiled values):

- leverage: the signer's gross bound is capital × leverage and the floor must be below the capital; the mandate takes
  the largest whole leverage for which gross ÷ leverage stays above the floor — 1× with the default limits (gross
  1.5 × capital, floor 0.9 × capital);
- daily turnover: order limit × orders per day;
- stop conditions: `loss_gte` at the agent's total-loss limit, `consecutive_rejects_gte` 25.

A live agent whose derivative mandate was approved before V11.2 has no trading mandate: it places nothing that adds
risk; its reduce-only orders still go through the seam it was approved on, until it is stopped and a new mandate is
approved.

A paper mandate lasts at most 90 days: a paper agent that runs longer is started again (the mandate is renewed then —
never by the agent).

## Open points

- **One account per signer mandate.** A trading mandate may name several accounts; the live path accepts
  exactly one Hyperliquid venue account.
- **GMX and any new venue** have no signer-side mandate. A live mandate that names them is refused.
- **Signer shapes have no start time, no per-minute rate, no daily-loss limit and no stop conditions.**
  These stay API-only until the signer shapes are extended.
- **The API-only fields are covered by a passkey assertion the API verifies, not by the signer** (see "What
  the passkey signs"): a compromised API is bound by the signer-enforced subset only.
- **Perp agents place live orders through the Hyperliquid engine directly** (`placeMandateOrder`), not through
  the order service: provenance is not applied to them (one principal per account makes it moot while the rule
  above holds).
- **Live spot mandates** are not created here.
- **Spot USD limits** are enforced in base units fixed at approval prices.
