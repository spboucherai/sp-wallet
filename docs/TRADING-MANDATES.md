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
| `instruments` | **signer** — `instruments[].instrument`. the signer refuses any other instrument | **signer (partly)** — `assets, maxOrder`. the signer enforces the SET of assets (both legs of every swap) and which can be sold; it does not know instruments, so any pair between mandated assets passes |
| `marketKinds` | **signer**. structural: this shape signs perpetual orders only | **signer**. structural: this shape signs spot swaps only |
| `orderTypes` | **API only**. the signer signs any order type the venue adapter can build; the allowed types are checked by the API | **signer (partly)**. structural: the signer signs an immediate swap with a minimum output — a market order with a slippage bound; resting or trigger orders do not exist here and are handled (or refused) by the API |
| `maxCapitalUsd` | **signer (partly)** — `maxGrossExposure`. enforced as worst-case gross exposure ≤ capital × leverage; the capital itself (collateral on the venue) is not capped by the signer | **API only**. the vault is bounded only by what the owner sends to it; the capital limit is checked by the API |
| `maxOrderNotionalUsd` | **signer** — `maxOrderNotional`. size × highest named price of one order, reduce-only orders included | **signer (partly)** — `maxOrder`. enforced per sold asset in base units fixed at approval prices: the USD value drifts with the market |
| `maxPositionNotionalUsd` | **signer** — `instruments[].maxPositionNotional`. worst case per instrument, from the signer's own read of the venue account and its own prices | **API only**. the signer has no position limit for a vault |
| `maxLeverage` | **signer** — `instruments[].maxLeverage`. the signer refuses an order that can add exposure while the venue's leverage setting is higher, and never sets a higher one | **n/a**. spot swaps carry no leverage |
| `maxDailyLossUsd` | **API only**. the signer has no daily-loss limit; it only knows the floor | **API only**. the signer has no loss limit for a vault |
| `floorEquityUsd` | **signer** — `floorEquity`. below the floor the signer signs reduce-only orders and cancels only (the venue's own account value) | **API only**. the signer has no loss limit for a vault |
| `createdAt` | **signer** — `createdAt`. must be current at approval | **signer** — `createdAt`. must be current at approval |
| `notBefore` | **signer** — `createdAt`. the mandate starts at its creation | **signer** — `createdAt`. the mandate starts at its creation |
| `notAfter` | **signer** — `expiresAt`. after it the signer signs only cancels and reduce-only orders for 24 h, then nothing | **signer** — `expiresAt`. the signer refuses any order after it |
| `frequency` | **signer (partly)** — `maxOrdersPerDay, maxOrdersPerHour`. per day and per hour are enforced by the signer (orders that can add exposure); per minute is enforced by the API only | **signer (partly)** — `maxOrdersPerDay, maxDaily`. orders per day and a daily volume per sold asset are enforced by the signer; per hour and per minute by the API only |
| `maxSlippageBps` | **signer (partly)** — `maxPriceDeviationBps`. the signer enforces a price band around its own mid on every price of an order; realised slippage is checked by the API | **signer** — `maxSlippageBps`. the guaranteed output must be worth at least (1 − this) of the input at the signer's own prices |
| `maxFeeUsd` | **API only**. the signer does not see venue fees | **API only**. the signer applies the fee ceiling of its own policy, not the mandate's |
| `stopConditions` | **API only**. declarative conditions are evaluated by the API; the signer only stops on the floor, the expiry, a revocation and its own halt | **API only**. declarative conditions are evaluated by the API; the signer only stops on the expiry, a revocation and its own halt |
| `mode` | **signer** — `network`. a live mandate; the venue network (mainnet / testnet) is the authorization's | **signer**. a live mandate |
| `strategySha256` | **signer (partly)** — `strategySha256`. recorded by the signer for the audit trail; the signer cannot verify what code runs | **signer (partly)** — `strategySha256`. recorded by the signer for the audit trail; the signer cannot verify what code runs |
| `label` | **API only**. a display name; not part of the signer shape | **signer** — `label`. part of the approved hash |
<!-- /GENERATED:enforced-by -->

Reading the table: on the derivative shape the signer enforces the instruments, the order and position
limits, the leverage, the floor, the expiry and the account. It enforces the capital only as a gross
exposure bound, the frequency per day and per hour only, and the slippage only as a price band. The daily
loss limit, the allowed order types, the fee cap and every declarative stop condition are API-only. On the
spot shape the signer has no capital, position or loss limit at all.

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

**Live (Hyperliquid).** One passkey ceremony:

1. `POST /mandates/:id/approve/prepare` compiles the mandate again against the venue authorization as it is
   now (`compileToVenueMandate`) and prepares the result at the Hyperliquid engine
   (`exec.ts` `prepareCompiledMandate`). The engine applies the checks it applies to any derivative mandate:
   the mandate is for this account and its authorization, `validateVenueMandate`, the pinned asset table, the
   acknowledgement that is displayed, no other mandate active on the account, the signer not halted.
2. The answer is the approval sheet: every field of the trading mandate, its hash, the compiled derivative
   mandate, the enforcement table (one row per field, verbatim from the compiler), the derived values, the
   jurisdiction acknowledgement and the WebAuthn request.
3. `POST /mandates/:id/approve { assertion, acknowledged: true }` goes through the engine's existing
   `approveMandate`: the signer verifies the passkey and stores the derivative mandate.
4. The API activates the trading mandate only if the mandate the signer approved has the same id and the same
   hash as the one compiled from it.

**What the passkey signs.** The challenge is the hash of the compiled derivative mandate
(`SPW-VENUE-MANDATE-v1`), the object the signer stores and enforces. The fields marked "API only" are not in
that hash. They are bound by the API's record (an immutable row, and the audit event `mandate.approved` with
the trading mandate's hash), not by the passkey. This is listed for review in `V11-SECURITY-REVIEW.md`.

A live mandate must be approved within about ten minutes of its creation: the signer requires a current
creation time. After that, create it again.

One derivative mandate per venue account: the signer holds one active mandate per authorization. An API-key
mandate and a perp agent's mandate cannot be active on the same venue account at the same time.

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

## Open points

- **One account per signer mandate.** A trading mandate may name several accounts; the live path accepts
  exactly one Hyperliquid venue account.
- **GMX and any new venue** have no signer-side mandate. A live mandate that names them is refused.
- **Signer shapes have no start time, no per-minute rate, no daily-loss limit and no stop conditions.**
  These stay API-only until the signer shapes are extended.
- **The API-only fields are not covered by the passkey signature** (see "What the passkey signs").
- **Live spot mandates** are not created here.
- **Spot USD limits** are enforced in base units fixed at approval prices.
