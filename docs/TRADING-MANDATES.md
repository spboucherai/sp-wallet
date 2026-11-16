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

Status: schema, checks and compilers exist and are tested. Nothing is wired to the API or the signer yet.

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

## Open points

- **API keys cannot be compiled.** Both signer shapes require a strategy hash, and an API key has none. A
  signer-side shape for API keys is needed, or a defined placeholder.
- **GMX and any new venue** have no signer-side mandate. Until one exists, a live mandate that names them
  does not compile, and their orders need a passkey approval each.
- **One account per signer mandate.** A trading mandate may name several accounts; each signer shape covers
  one. A mandate spanning a vault and a venue account compiles to two signer mandates with the same id.
- **Signer shapes have no start time, no per-minute rate, no daily-loss limit and no stop conditions.**
  These stay API-only until the signer shapes are extended.
- **Spot USD limits** are enforced in base units fixed at approval prices.
