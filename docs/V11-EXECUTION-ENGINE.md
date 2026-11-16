# V11 execution engine — deterministic core

Package `@spw/trading` (`packages/trading`). Pure code: no I/O, no clock except an injected `now`, no randomness.
This document covers the order model: the canonical order, the state machine, idempotency, ambiguity, the
mapping of the four V10 state vocabularies, and the command engine. The risk engine is in `V11-RISK-MODEL.md`,
mandates in `TRADING-MANDATES.md`.

The tables between `GENERATED` markers are rendered from the code by `packages/trading/src/docs.ts`.
`packages/trading/test/docs.test.ts` fails when a table differs from what the code renders;
`UPDATE_DOCS=1 pnpm vitest run packages/trading/test/docs.test.ts` rewrites them. Do not edit them by hand.

Status: sections 1 to 7 describe the core. Section 8 describes how the API service uses it since Phase F
(`services/api/src/orders/`): one order table for every principal, mode and venue. Nothing is wired into the
isolated signer: it signs what it signed before, under the rules it had before.

## 1. Canonical order (`orders/canonical.ts`)

One structured representation of what is asked, whatever produced it (command, agent, API key, screen) and
whatever venue executes it. Schema `CanonicalOrderSchema` (zod, strict):

| Field | Meaning |
|---|---|
| `venue`, `network` | venue id (`hyperliquid`, `gmx`, `kyberswap`, …) and the network of the account (`mainnet` / `testnet`, or a registry network) |
| `instrument` | `${venue}:${symbol}` |
| `marketKind` | `spot` or `perp` |
| `side`, `type` | `buy` / `sell`; `market`, `limit`, `stop`, `take_profit` |
| `size` or `notional` | exactly one: a quantity of the base asset, or a notional in the quote currency |
| `limitPrice`, `triggerPrice` | limit: required for `limit`, optional for `stop` / `take_profit` (stop-limit), absent for `market`; trigger: required for `stop` / `take_profit` |
| `reduceOnly`, `tif` | perp only for `reduceOnly`; `gtc`, `ioc`, `alo` |
| `maxSlippageBps`, `maxFeeUsd` | execution bounds of this order |
| `leverage`, `marginMode` | perp; `null` = the venue account's current setting |
| `clientOrderId` | derived from the idempotency key (section 4) |
| `mode` | `research`, `paper` or `live` |
| `principal`, `mandateId` | who asks (`owner`, `agent`, `api_key`); an agent or an API key always names a mandate, the owner never does |
| `createdAt`, `expiresAt` | unix milliseconds; at most 24 h apart |

Every price, size and amount is a canonical decimal string (`packages/derivatives/src/decimal.ts`). No
floating-point number carries money anywhere in the package (a test scans the sources).

**Serialization and hash.** Same encoding as `packages/core/src/intent.ts`: a domain tag
(`SPW-ORDER-INTENT-v1`), a zero byte, then `(name, value)` pairs in an order fixed by the code, each
length-prefixed (u16 name, u32 value). The encoder is the exported `canonicalEncode` of
`@spw/derivatives/live`, which is that encoding; `intent.ts` keeps its copy private, so it is not imported
from there. A test decodes a core intent and an order with one decoder. The hash is SHA-256 of the bytes.
A second form, `canonicalOrderJson`, is for people and logs: fixed key order, canonical decimals, explicit
nulls. The hash is never taken over the JSON.

`orderBodyHashHex` is the hash of the order's economic content: every field except `clientOrderId`,
`createdAt` and `expiresAt`. It is what the idempotency rule compares.

`toOrderRequest(order, { size, worstPrice })` gives the existing venue-level `OrderRequest` of
`packages/derivatives` for a perp order, once the caller has turned a notional into a size and
`maxSlippageBps` into a worst price on the tick.

## 2. State machine (`orders/state.ts`)

```
CREATED → VALIDATED → AWAITING_APPROVAL → APPROVED → SUBMITTING → SUBMITTED → PARTIALLY_FILLED → FILLED
                                                          └→ UNKNOWN
terminal: FILLED, CANCELLED, REJECTED, FAILED
```

`transition(order, event, now)` returns a new record and one history entry
`{ orderId, seq, from, to, event, at, reason, detail }`. It throws `IllegalTransitionError` when the table
has no entry for the state and the event, or when the event's content contradicts the record. It never
mutates its input. `version` on the record counts transitions and serves as an optimistic-concurrency token
for the store.

Rules:

1. Terminal states are final: they have no outgoing transition.
2. Nothing becomes `PARTIALLY_FILLED` or `FILLED` without a venue-originated event (`fill`,
   `reconciled_found`). The answer of a submission never fills an order.
3. `REJECTED` is a refusal with a cause in the rules (validation, risk, mandate, signer policy, the venue).
   `FAILED` is a technical failure after which it is proven that no order exists. `CANCELLED` is a
   withdrawal, an expiry or a cancellation. The cause is a closed reason code; `detail` is free text.
4. A mandate order goes `VALIDATED → APPROVED` (`approved { by: 'mandate' }`); an owner order must pass
   through `AWAITING_APPROVAL`.
5. A cancel request on an order that never left cancels it at once. On an order at the venue it only sets
   `cancelRequested`; the order is `CANCELLED` when the venue says so.

### Transition table

<!-- GENERATED:transition-table -->
| From | Event | To |
|---|---|---|
| `CREATED` | `validated` | `VALIDATED` |
| `CREATED` | `local_rejected` | `REJECTED` |
| `CREATED` | `local_failed` | `FAILED` |
| `CREATED` | `cancel_requested` | `CANCELLED` |
| `CREATED` | `expired` | `CANCELLED` |
| `VALIDATED` | `local_rejected` | `REJECTED` |
| `VALIDATED` | `local_failed` | `FAILED` |
| `VALIDATED` | `approval_requested` | `AWAITING_APPROVAL` |
| `VALIDATED` | `approved` | `APPROVED` |
| `VALIDATED` | `cancel_requested` | `CANCELLED` |
| `VALIDATED` | `expired` | `CANCELLED` |
| `AWAITING_APPROVAL` | `local_rejected` | `REJECTED` |
| `AWAITING_APPROVAL` | `local_failed` | `FAILED` |
| `AWAITING_APPROVAL` | `approved` | `APPROVED` |
| `AWAITING_APPROVAL` | `approval_expired` | `CANCELLED` |
| `AWAITING_APPROVAL` | `cancel_requested` | `CANCELLED` |
| `AWAITING_APPROVAL` | `expired` | `CANCELLED` |
| `APPROVED` | `local_rejected` | `REJECTED` |
| `APPROVED` | `local_failed` | `FAILED` |
| `APPROVED` | `submit_started` | `SUBMITTING` |
| `APPROVED` | `cancel_requested` | `CANCELLED` |
| `APPROVED` | `expired` | `CANCELLED` |
| `SUBMITTING` | `local_rejected` | `REJECTED` |
| `SUBMITTING` | `local_failed` | `FAILED` |
| `SUBMITTING` | `venue_accepted` | `SUBMITTED` |
| `SUBMITTING` | `venue_rejected` | `REJECTED` |
| `SUBMITTING` | `submit_ambiguous` | `UNKNOWN` |
| `SUBMITTING` | `reconciled_found` | `SUBMITTED`, `PARTIALLY_FILLED`, `FILLED`, `CANCELLED`, `REJECTED` |
| `SUBMITTING` | `reconciled_absent` | `UNKNOWN`, `FAILED` |
| `SUBMITTING` | `fill` | `PARTIALLY_FILLED`, `FILLED` |
| `SUBMITTING` | `cancel_requested` | `SUBMITTING` |
| `SUBMITTED` | `venue_rejected` | `REJECTED` |
| `SUBMITTED` | `venue_lost` | `UNKNOWN` |
| `SUBMITTED` | `reconciled_found` | `SUBMITTED`, `PARTIALLY_FILLED`, `FILLED`, `CANCELLED`, `REJECTED` |
| `SUBMITTED` | `reconciled_absent` | `UNKNOWN` |
| `SUBMITTED` | `fill` | `PARTIALLY_FILLED`, `FILLED` |
| `SUBMITTED` | `cancel_requested` | `SUBMITTED` |
| `SUBMITTED` | `cancelled` | `CANCELLED` |
| `SUBMITTED` | `expired` | `CANCELLED` |
| `PARTIALLY_FILLED` | `venue_lost` | `UNKNOWN` |
| `PARTIALLY_FILLED` | `reconciled_found` | `PARTIALLY_FILLED`, `FILLED`, `CANCELLED` |
| `PARTIALLY_FILLED` | `reconciled_absent` | `UNKNOWN` |
| `PARTIALLY_FILLED` | `fill` | `PARTIALLY_FILLED`, `FILLED` |
| `PARTIALLY_FILLED` | `cancel_requested` | `PARTIALLY_FILLED` |
| `PARTIALLY_FILLED` | `cancelled` | `CANCELLED` |
| `PARTIALLY_FILLED` | `expired` | `CANCELLED` |
| `FILLED` | — (terminal) | — |
| `CANCELLED` | — (terminal) | — |
| `REJECTED` | — (terminal) | — |
| `FAILED` | — (terminal) | — |
| `UNKNOWN` | `venue_accepted` | `SUBMITTED` |
| `UNKNOWN` | `venue_rejected` | `REJECTED` |
| `UNKNOWN` | `reconciled_found` | `SUBMITTED`, `PARTIALLY_FILLED`, `FILLED`, `CANCELLED`, `REJECTED` |
| `UNKNOWN` | `reconciled_absent` | `UNKNOWN`, `FAILED` |
| `UNKNOWN` | `fill` | `PARTIALLY_FILLED`, `FILLED` |
| `UNKNOWN` | `cancel_requested` | `UNKNOWN` |
| `UNKNOWN` | `cancelled` | `CANCELLED` |
| `UNKNOWN` | `operator_resolved` | `FAILED` |
<!-- /GENERATED:transition-table -->

Where the table lists several outcomes, the event's content decides:

- `fill`: `FILLED` when the cumulative size reaches the order's size, else `PARTIALLY_FILLED`. An order
  given as a notional has no size until the venue reports `filled`.
- `reconciled_found`: by `status` and cumulative `filledSize` — `resting` or `frozen` with nothing filled →
  `SUBMITTED`; with a part filled → `PARTIALLY_FILLED`; `filled` → `FILLED`; `cancelled` → `CANCELLED`
  (`REMAINDER_CANCELLED` when a part was filled); `rejected` → `REJECTED` (refused if a part was filled).
  The venue can never report less filled than already recorded.
- `reconciled_absent`: see section 3.
- `cancel_requested`: `CANCELLED` before submission; unchanged state with `cancelRequested = true` after.

### Reason codes

<!-- GENERATED:reason-codes -->
| Group | State it leads to | Codes |
|---|---|---|
| progress | (any non-terminal, or FILLED) | `ORDER_CREATED`, `VALIDATION_PASSED`, `APPROVAL_REQUESTED`, `APPROVED_BY_OWNER`, `APPROVED_BY_MANDATE`, `SUBMIT_STARTED`, `VENUE_ACCEPTED`, `VENUE_FILL`, `VENUE_FILLED`, `VENUE_RESTING`, `VENUE_FROZEN`, `CANCEL_REQUESTED`, `DUPLICATE_EVENT_IGNORED`, `OPERATION_COMPLETED`, `LEGACY_UNSPECIFIED` |
| refusal | `REJECTED` | `INVALID_ORDER`, `RISK_DENIED`, `MANDATE_DENIED`, `KILL_SWITCH_ACTIVE`, `READ_ONLY_MODE`, `INSTRUMENT_NOT_ALLOWED`, `VENUE_NOT_ALLOWED`, `IDEMPOTENCY_CONFLICT`, `BUILD_ERROR`, `SIGNER_REFUSED`, `SIGNER_REFUSED_OR_UNREACHABLE`, `VENUE_REJECTED`, `VENUE_REJECTED_AFTER_ACK` |
| technical failure | `FAILED` | `SIGNER_UNREACHABLE`, `SIGNER_INTERRUPTED`, `SIGNER_HASH_MISMATCH`, `NOT_SENT`, `NEVER_PLACED`, `TX_REVERTED`, `TX_REPLACED`, `NO_ORDER_EVENT`, `INTERNAL_ERROR`, `OPERATOR_RESOLVED` |
| withdrawal / expiry / cancellation | `CANCELLED` | `WITHDRAWN_BEFORE_APPROVAL`, `APPROVAL_EXPIRED`, `HALTED_BEFORE_APPROVAL`, `AUTHORIZATION_REVOKED`, `MANDATE_REVOKED`, `DATA_INCONSISTENT_BEFORE_APPROVAL`, `ORDER_EXPIRED`, `CANCELLED_BY_REQUEST`, `CANCELLED_AT_VENUE`, `EXPIRED_AT_VENUE`, `REMAINDER_CANCELLED` |
| outcome not known | `UNKNOWN` | `SUBMIT_TIMEOUT`, `SUBMIT_NETWORK_ERROR`, `SUBMIT_UNREADABLE_ANSWER`, `INTERRUPTED_AFTER_SIGNING`, `VENUE_LOST_ORDER`, `ABSENT_WITHIN_GRACE`, `ABSENT_UNVERIFIABLE`, `OUTCOME_EVENT_MISSING`, `RECEIPT_OVERDUE` |
<!-- /GENERATED:reason-codes -->

## 3. Ambiguous submissions

A submission whose outcome is not known is never a failure.

- `submit_ambiguous` (timeout, network error, unreadable answer, crash after signing, receipt overdue) moves
  `SUBMITTING → UNKNOWN`. The request may have left; the order may exist.
- `UNKNOWN` is left only by: a venue-originated event (`venue_accepted`, `venue_rejected`,
  `reconciled_found`, `fill`, `cancelled`); `reconciled_absent` under the conditions below; or
  `operator_resolved`, which a person issues and which can only lead to `FAILED`, never to a fill.
- No local event closes an unknown order: `local_failed`, `local_rejected` and `expired` are illegal there.

`reconciled_absent` leads to `FAILED` (`NEVER_PLACED`) only when all three hold:

1. the venue supports a lookup by client order id (`supportsClientIdLookup`);
2. the order was never acknowledged by the venue (`acknowledged = false`);
3. `now ≥ conclusiveAt`, the venue-specific instant after which the venue can no longer accept the signed
   request, plus a grace for the lag of its read side. `absenceConclusiveAt(policy, requestExpiresAt)`
   computes it from `VENUE_RECONCILE`.

Otherwise the order stays `UNKNOWN` and the history entry says why: `ABSENT_WITHIN_GRACE`,
`ABSENT_UNVERIFIABLE` (no lookup, or no venue-enforced expiry), or `VENUE_LOST_ORDER` (an acknowledged order
the venue no longer shows is never "never placed").

`VENUE_RECONCILE` today: Hyperliquid — lookup by cloid, grace 5 000 ms after the action's `expiresAfter`
(the value of `NEVER_PLACED_GRACE_MS` in `exec.ts`). The two venue properties this rests on are not
independently verified (`docs/v6/DERIVATIVE-MANDATE.md` section 7). GMX — no client id on-chain: absence is
settled by the chain (a reverted or replaced transaction is a `local_failed`), never by this rule.

## 4. Idempotency (`orders/idempotency.ts`)

- `deriveClientOrderId(principal, idempotencyKey)`: SHA-256 over the domain-separated, length-prefixed
  `(principal kind, principal id, key)`; 64 hex characters. One principal repeating a key gets the same id;
  two principals using the same key never collide.
- `formatClientOrderId(venue, id)`: the same identifier in the venue's form. A venue without a declared
  format is an error; an id is never invented.
- `dedupe(existing, incoming)`: same key and same body hash → `same` (return the existing order); same key
  and a different body → `conflict` (refuse with `IDEMPOTENCY_CONFLICT`; never execute, never merge); no
  record → `new`. The body is `orderBodyHashHex`, so a retry stamped with a later `createdAt` is the same
  order.

<!-- GENERATED:client-id-formats -->
| Venue | Bits kept | Form |
|---|---|---|
| `hyperliquid` | 128 | cloid: 128-bit hex, 0x + 32 lower-case hex characters |
| `gmx` | 256 | no venue-side client id; the full identifier is stored with the operation |
| `dydx` | 32 | uint32 clientId: first 32 bits, decimal |
| `kyberswap` | 256 | no venue-side client id; stored with the wallet proposal |
| `jupiter` | 256 | no venue-side client id; stored with the wallet proposal |
| `paper` | 256 | full identifier |
<!-- /GENERATED:client-id-formats -->

The Hyperliquid form is exactly what `hlCloid` of the adapter passes through unchanged and what the
signer's `VenueOrderSchema.clientId` accepts (tested against both).

## 5. The four V10 vocabularies (`orders/vocabulary.ts`)

V10 has four state vocabularies. Each has a mapping function to the unified states:

| Vocabulary | Column | Source | Function |
|---|---|---|---|
| Hyperliquid live orders | `deriv_orders.state` | `services/api/src/derivatives/exec.ts`, type `LiveState` | `mapHyperliquidOrder(state, { final, rejectReason })` |
| GMX operations | `deriv_gmx_ops.state` | `gmx-exec.ts`, type `GmxOpState` | `mapGmxOp(state, kind)` |
| Collateral | `deriv_collateral.state` | `collateral.ts`, types `DepositState`, `WithdrawState` | `mapDeposit(state)`, `mapWithdraw(state, { error })` |
| Venue actions | `deriv_actions.state` | `exec.ts` (`act`, `approveLeverage`) | `mapVenueAction(state)` |

The state lists are copied from that code, since the API service is not a dependency of this package.
`test/vocabulary.test.ts` reads the four source files and fails if a vocabulary there gains or loses a
member, or if a `reject_reason` text the mapping relies on is no longer written.

Collateral movements and venue actions are not orders. They map to the same states with one convention:
`FILLED` means the effect is confirmed by the venue or the chain, with the reason `OPERATION_COMPLETED`.

Two deliberate differences from the gap table of the audit (`docs/v11/audit-parts/derivatives-exec-signer.md`
section 3.3): GMX `sent` maps to `SUBMITTING`, not `SUBMITTED`, because no order exists on-chain until the
receipt shows `OrderCreated`; and a Hyperliquid `partially_filled` row with `final = true` maps to
`CANCELLED` / `REMAINDER_CANCELLED`, since `PARTIALLY_FILLED` is not terminal here.

<!-- GENERATED:vocabularies -->
#### Hyperliquid live orders — `deriv_orders.state`, services/api/src/derivatives/exec.ts (LiveState)

| Legacy state | Unified state | Reason code | Note |
|---|---|---|---|
| `proposed` | `CREATED` | `ORDER_CREATED` |  |
| `risk_checked` | `AWAITING_APPROVAL` | `APPROVAL_REQUESTED` | Hyperliquid has one state for VALIDATED and AWAITING_APPROVAL: the row passed the risk engine and waits for the passkey |
| `authorized` | `APPROVED` | `LEGACY_UNSPECIFIED` | means "handed to the signer": the approval is verified by the signer, not before |
| `signed` | `SUBMITTING` | `SUBMIT_STARTED` |  |
| `submitted` | `SUBMITTED` | `VENUE_ACCEPTED` |  |
| `unknown` | `UNKNOWN` | `SUBMIT_UNREADABLE_ANSWER` | exec.ts does not tell a timeout from a network error or an unreadable answer |
| `open` | `SUBMITTED` | `VENUE_RESTING` |  |
| `partially_filled (final = false)` | `PARTIALLY_FILLED` | `VENUE_FILL` |  |
| `partially_filled (final = true)` | `CANCELLED` | `REMAINDER_CANCELLED` | filled in part; the remainder was cancelled |
| `filled` | `FILLED` | `VENUE_FILLED` |  |
| `cancelled` | `CANCELLED` | `CANCELLED_AT_VENUE` | no reason stored: cancelled at the venue |
| `rejected` | `REJECTED` | `LEGACY_UNSPECIFIED` |  |

Causes hidden in `reject_reason` (the texts `exec.ts` writes), told apart by `mapHyperliquidOrder`:

| Legacy state | Text matches | Unified state | Reason code |
|---|---|---|---|
| `rejected` | `^never placed:` | `FAILED` | `NEVER_PLACED` |
| `rejected` | `^interrupted while asking the signer` | `FAILED` | `SIGNER_INTERRUPTED` |
| `rejected` | `^not sent:` | `FAILED` | `NOT_SENT` |
| `rejected` | `^not signed:` | `REJECTED` | `SIGNER_REFUSED_OR_UNREACHABLE` |
| `rejected` | `^refused by the venue` | `REJECTED` | `VENUE_REJECTED` |
| `rejected` | `^(bad_policy|bad_order|bad_input|mode_read_only|halted|instrument_mismatch|instrument_not_allowed|instrument_halted|instrument_reduce_only|data_mismatch|stale_ticker|stale_book|price_required|trigger_required|bad_mark|price_deviation|mark_index_divergence|price_not_on_tick|size_not_on_lot|below_min_size|below_min_notional|reduce_only_would_increase|reduce_only_would_flip|leverage_exceeded|order_notional_exceeded|gross_exposure_exceeded|position_notional_exceeded|insufficient_collateral|liquidation_too_close|daily_loss_exceeded|total_loss_exceeded|order_rate_minute|order_rate_day|duplicate_client_id): ` | `REJECTED` | `RISK_DENIED` |
| `cancelled` | `^withdrawn before approval` | `CANCELLED` | `WITHDRAWN_BEFORE_APPROVAL` |
| `cancelled` | `^withdrawn: trading was halted` | `CANCELLED` | `HALTED_BEFORE_APPROVAL` |
| `cancelled` | `^withdrawn: the venue authorization was revoked` | `CANCELLED` | `AUTHORIZATION_REVOKED` |
| `cancelled` | `^(the approval window expired|expired before approval)` | `CANCELLED` | `APPROVAL_EXPIRED` |
| `cancelled` | `^withdrawn: ` | `CANCELLED` | `DATA_INCONSISTENT_BEFORE_APPROVAL` |

#### GMX operations — `deriv_gmx_ops.state`, services/api/src/derivatives/gmx-exec.ts (GmxOpState)

| Legacy state | Unified state | Reason code | Note |
|---|---|---|---|
| `pending_approval` | `AWAITING_APPROVAL` | `APPROVAL_REQUESTED` | GMX stores nothing before validation: there is no CREATED or VALIDATED row |
| `signed` | `APPROVED` | `LEGACY_UNSPECIFIED` | set BEFORE the signer is called: it means "handed to the signer" |
| `sent` | `SUBMITTING` | `SUBMIT_STARTED` | the transaction was relayed; no order exists on-chain until its receipt shows OrderCreated |
| `created` | `SUBMITTED` | `VENUE_ACCEPTED` | the order exists on-chain (its key is the venue order id) and waits for a keeper |
| `executed` | `FILLED` | `VENUE_FILLED` |  |
| `cancelled` | `CANCELLED` | `CANCELLED_AT_VENUE` | OrderCancelled event: a keeper or the owner's cancel transaction cancelled it |
| `frozen` | `SUBMITTED` | `VENUE_FROZEN` | GMX froze the order: it rests and can be cancelled |
| `done (cancel operation)` | `FILLED` | `OPERATION_COMPLETED` | a mined cancel transaction: the operation is complete; the ORDER it targets is cancelled |
| `failed` | `FAILED` | `LEGACY_UNSPECIFIED` | signer refusal, hash mismatch, reverted or replaced transaction, or no OrderCreated event: the text column tells which |
| `expired` | `CANCELLED` | `APPROVAL_EXPIRED` |  |
| `withdrawn` | `CANCELLED` | `WITHDRAWN_BEFORE_APPROVAL` |  |
| `unknown` | `UNKNOWN` | `OUTCOME_EVENT_MISSING` | no receipt after the overdue delay, or the order left the chain without an OrderExecuted / OrderCancelled event found |

#### Collateral deposits — `deriv_collateral.state (kind = deposit)`, services/api/src/derivatives/collateral.ts (DepositState)

| Legacy state | Unified state | Reason code | Note |
|---|---|---|---|
| `pending_approval` | `AWAITING_APPROVAL` | `APPROVAL_REQUESTED` |  |
| `signed` | `APPROVED` | `LEGACY_UNSPECIFIED` | set before the signer is called: "handed to the signer" |
| `sent` | `SUBMITTING` | `SUBMIT_STARTED` | the wallet transaction was relayed |
| `awaiting_credit` | `SUBMITTED` | `VENUE_ACCEPTED` | the transfer is confirmed on-chain; the venue has not credited it yet |
| `credited` | `FILLED` | `OPERATION_COMPLETED` | the venue's ledger shows the credit |
| `failed` | `FAILED` | `LEGACY_UNSPECIFIED` |  |
| `expired` | `CANCELLED` | `APPROVAL_EXPIRED` |  |
| `cancelled` | `CANCELLED` | `WITHDRAWN_BEFORE_APPROVAL` |  |

#### Collateral withdrawals — `deriv_collateral.state (kind = withdraw)`, services/api/src/derivatives/collateral.ts (WithdrawState)

| Legacy state | Unified state | Reason code | Note |
|---|---|---|---|
| `pending_approval` | `AWAITING_APPROVAL` | `APPROVAL_REQUESTED` |  |
| `approved` | `APPROVED` | `LEGACY_UNSPECIFIED` | "handed to the signer" |
| `signed` | `SUBMITTING` | `SUBMIT_STARTED` |  |
| `submitted` | `SUBMITTED` | `VENUE_ACCEPTED` |  |
| `unknown` | `UNKNOWN` | `SUBMIT_UNREADABLE_ANSWER` |  |
| `completed` | `FILLED` | `OPERATION_COMPLETED` | the venue's ledger and the wallet show the withdrawal |
| `rejected` | `REJECTED` | `VENUE_REJECTED` |  |
| `failed` | `FAILED` | `LEGACY_UNSPECIFIED` |  |
| `expired` | `CANCELLED` | `APPROVAL_EXPIRED` |  |
| `cancelled` | `CANCELLED` | `WITHDRAWN_BEFORE_APPROVAL` |  |
| `rejected (error: "… without any trace …")` | `FAILED` | `NEVER_PLACED` | given up after 30 minutes without a trace in the venue's ledger or on the wallet |

#### Venue actions (cancel, leverage) — `deriv_actions.state`, services/api/src/derivatives/exec.ts (act, approveLeverage)

| Legacy state | Unified state | Reason code | Note |
|---|---|---|---|
| `risk_checked` | `AWAITING_APPROVAL` | `APPROVAL_REQUESTED` | a leverage change waiting for the passkey |
| `authorized` | `APPROVED` | `LEGACY_UNSPECIFIED` | "handed to the signer"; a cancel starts here (no approval: stopping never needs one) |
| `signed` | `SUBMITTING` | `SUBMIT_STARTED` |  |
| `submitted` | `SUBMITTED` | `VENUE_ACCEPTED` |  |
| `confirmed` | `FILLED` | `OPERATION_COMPLETED` | the venue's own setting shows the change |
| `rejected` | `REJECTED` | `LEGACY_UNSPECIFIED` | a signer refusal ("not signed: …") or a venue refusal |
| `unknown` | `UNKNOWN` | `SUBMIT_UNREADABLE_ANSWER` |  |
| `cancelled` | `CANCELLED` | `APPROVAL_EXPIRED` |  |
<!-- /GENERATED:vocabularies -->

## 6. Command engine (`commands/parse.ts`)

A hand-written tokenizer and parser. No model takes part. Grammar:

```
BUY <asset> <amount> <quote> [ON <venue>]              spend <amount> of <quote> to buy <asset> (spot)
SELL <asset> <amount|pct%> [FOR <quote>] [ON <venue>]  sell a quantity, or a share of the balance (spot)
LONG|SHORT <asset>-PERP <notional> [x<lev>] [LIMIT <px>] [SL <px>] [TP <px>] [ON <venue>]
CLOSE <asset>-PERP [pct%] [ON <venue>]
CANCEL ORDER <id>          CANCEL ALL [ON <venue>]
SHOW POSITIONS|BALANCES|ORDERS|RISK
STOP ALL AGENTS            KILL
```

`BUY … <amount> <quote>` reads as "for this amount of the quote". `FOR <quote>` on `SELL` and `ON <venue>`
on `BUY` / `SELL` are additions to the brief's grammar. Options of `LONG` / `SHORT` come in any order, each
at most once. Numbers are plain decimals: no sign, no exponent, no separator, no leading zero. Input is one
line of printable text, at most 300 characters. Anything else is a parse error with a code and the index of
the token.

<!-- GENERATED:command-keywords -->
| Keyword | Accepted spellings (case-insensitive, accents ignored) |
|---|---|
| `BUY` | `BUY`, `ACHETER`, `ACHETE` |
| `SELL` | `SELL`, `VENDRE`, `VENDS` |
| `LONG` | `LONG` |
| `SHORT` | `SHORT` |
| `CLOSE` | `CLOSE`, `FERMER`, `FERME`, `CLOTURER` |
| `CANCEL` | `CANCEL`, `ANNULER`, `ANNULE` |
| `ORDER` | `ORDER`, `ORDRE` |
| `ALL` | `ALL`, `TOUT`, `TOUS`, `TOUTES` |
| `ON` | `ON`, `SUR` |
| `FOR` | `FOR`, `CONTRE`, `POUR` |
| `SHOW` | `SHOW`, `AFFICHER`, `AFFICHE`, `VOIR`, `MONTRER`, `MONTRE` |
| `POSITIONS` | `POSITIONS` |
| `BALANCES` | `BALANCES`, `SOLDES` |
| `ORDERS` | `ORDERS`, `ORDRES` |
| `RISK` | `RISK`, `RISQUE`, `RISQUES` |
| `STOP` | `STOP`, `ARRETER`, `ARRETE`, `STOPPER` |
| `AGENTS` | `AGENTS` |
| `THE` | `THE`, `LES` |
| `KILL` | `KILL`, `URGENCE` |
| `LIMIT` | `LIMIT`, `LIMITE` |
| `SL` | `SL` |
| `TP` | `TP` |
<!-- /GENERATED:command-keywords -->

`parse(text)` gives a typed AST; `format(ast)` prints it in canonical English, and `parse(format(ast))`
gives back the AST (property-tested).

`resolve(ast, defaults, catalog, request)` gives one of:

- `{ kind: 'order', order, hash, attached }` — a canonical order; `attached` holds the reduce-only stop-loss
  and take-profit orders of a `LONG` / `SHORT`, to be placed once the entry is filled;
- `{ kind: 'query' }` or `{ kind: 'control' }` — `SHOW …`, cancels, `STOP ALL AGENTS`, `KILL` (kill switch on);
- `{ kind: 'ambiguous', questions: [{ field, options, message }] }`;
- `{ kind: 'unresolvable', code, message }` — nothing in the catalog matches, no position to close, a
  missing balance or reference price, prices on the wrong side.

**Nothing is guessed.** The venue, the network, the fee cap, the slippage bound, the leverage, the margin
mode and the order's validity come from the command or from the owner's explicit `ResolutionDefaults`
(default spot network and venue per network, default perp venue and its network, max fee bps, max slippage
bps, …). When neither says, the result is a question — also when only one venue lists the asset. Several
instruments matching a symbol is a question with the candidates. Spot versus perp is never inferred: the
grammar separates them (`BUY` / `SELL` are spot, `-PERP` is a perp).

A percentage sell needs the balance from the caller's `catalog`; a close needs the position; a fee cap on a
size needs a USD reference price. `request` carries the clock, the principal, the mandate, the mode and the
idempotency key. Same command, same defaults, same catalog, same request → the same canonical hash (tested,
including the French and English spellings of one command).

## 7. Cost comparison and implied valuation

- `compare/cost.ts` — `venueCost`, `compareVenues`: one row per venue with spread, depth at N bps, slippage
  by walking the book, fees, expected funding, collateral, liquidation price and distance, maximum leverage,
  and `totalCostUsd` = entry and exit slippage + entry and exit fee + funding. A component whose inputs are
  missing is `null` with its reason, and the total is then `null` and lists what is missing.
  `crossVenueDiscrepancy` returns `netEdgeEstimateBps` with `assumptions[]` and `risks[]`.
- `valuation/implied.ts` — `impliedValuation`: keeps the synthetic price, the contract's market value, a
  position's notional exposure and the implied company valuation apart. A valuation is given only when the
  price unit defines it (valuation units directly; per-share only with a sourced diluted share count).

## 8. Integration in the API service (Phase F)

Code: `services/api/src/orders/{store,projection,service,index}.ts`. Tests:
`services/api/test/execution-{unit,paper,live}.test.ts`. Work note: `docs/v11/work/exec.md`.

### 8.1 What was decided

There is **no second engine**. The paper engine (`derivatives/paper.ts`), the Hyperliquid engine
(`derivatives/exec.ts`) and the GMX engine (`derivatives/gmx-exec.ts`) stay the executors, with their own rows
and vocabularies. Above them there is one **order service**:

- every order — owner, API key, agent; paper or live; any venue — is one row of `orders`;
- that row is changed only by `transition()` (`store.ts` is the only writer; an event the table does not allow
  throws `IllegalTransitionError` and nothing is written);
- every applied event appends one row to `order_events`, which a database trigger makes append-only;
- the engines' rows are linked by `orders.engine` and `orders.engine_ref`.

### 8.2 Tables

| Table | Content |
|---|---|
| `orders` | `id` (the client order id), the principal, the idempotency key and body hash, mode, venue, network, instrument, side, type, the canonical order and its hash (null for an adopted row), `record` (the `OrderRecord` of the core), `state` / `reason` / `version` copied from it, `reject_code` (the precise machine code of a refusal, e.g. `mainnet_disabled`), `engine`, `engine_ref`, `engine_sig`, `request_expires_at`, `notional_usd`, `origin` (`trading_api`, `command`, `agent`, `legacy`), `projection_error`, `next_reconcile_at` |
| `order_events` | `(order_id, seq)`, `from_state`, `to_state`, `event`, the event body, `reason`, `detail`, `at`. Updates and deletes raise `order_events is append-only` |
| `order_projection_queue` | `(engine, ref)` of every engine row that was inserted or updated, written by triggers on `deriv_orders` and `deriv_gmx_ops` |
| `risk_decisions` | every evaluation of the risk engine, linked to the order (`V11-RISK-MODEL.md`) |

Unique indexes: `(principal_kind, principal_id, idempotency_key)` and `(engine, engine_ref)`.

### 8.3 Placing an order (`OrderService.submit`, `submitCanonical`)

1. The account and the engine are resolved. A venue restricted for the owner's jurisdiction (dYdX, edgeX) is
   refused for everybody, in any mode (`venue_restricted`). Live orders are placed on Hyperliquid only.
2. The canonical order is built; its `clientOrderId` is `clientOrderIdFor(venue, principal, key)`. For
   Hyperliquid it is the venue's cloid (`0x` + 32 hex), which the adapter passes through unchanged: the unified
   order id, the engine's client id and the venue's client order id are the same string.
3. Idempotency: an order already stored for `(principal, key)` is returned as it is now when its body hash is
   the same, and refused with `idempotency_conflict` otherwise. No engine is called.
4. Refused before an order exists: `mandate_required`, `execution_disabled` (section 8.7), a key's notional
   limits (`key_limit_exceeded`) and restrictions (`restricted`), `not_reducing` for a close.
5. The order is stored `CREATED`. From here every outcome is a state of it.
6. The risk engine evaluates it; the decision is stored and linked.
7. A principal that is not the owner: the mandate is checked (`TRADING-MANDATES.md`). A denial is
   `REJECTED / MANDATE_DENIED`, HTTP 403 with every deny code.
8. A risk denial is `REJECTED` with `RISK_DENIED`, `KILL_SWITCH_ACTIVE` or `READ_ONLY_MODE`.
9. `validated`, then the engine's own path:

| Who, where | Events applied by the service | Engine call | Then |
|---|---|---|---|
| owner, paper | `approval_requested`, `approved{owner}`, `submit_started` | `paper.order` | projected from the paper row |
| key or agent, paper | `approved{mandate}`, `submit_started` | `paper.order` | projected |
| owner, live | none | `live.propose` | projected: `AWAITING_APPROVAL`. The owner approves with the passkey through the existing route `POST /derivatives/live/accounts/:id/orders/:clientId/approve`; the answer names it |
| key or agent, live | `approved{mandate}`, `submit_started` | `live.placeMandateOrder` | the signer applies the derivative mandate it stores; projected |

10. When the engine throws: if it stored a row, the row is projected (it says the truth, `unknown` included).
    If it stored nothing, nothing was signed and nothing left — the engines insert their row before they ask
    the signer — so a refusal becomes `REJECTED` with the engine's code in `reject_code`, and anything else
    `FAILED / INTERNAL_ERROR`.

The answer carries the order in its real state. A refusal after step 5 answers 4xx with the order in
`data.order`.

### 8.4 Projection of the engines (`projection.ts`)

A unified order is never written from an engine state. `advance(record, snapshot, now)` computes the events
that lead from the record as it is to the state the engine row maps to (section 5), and applies each with
`transition()`. A step the table refuses is not forced: the record stays where it is and `projection_error`
says why.

| Engine | Row | Mapping | Notes |
|---|---|---|---|
| Hyperliquid | `deriv_orders` with `state` set | `mapHyperliquidOrder`, plus the refusals of the risk gate written as `kill_switch_active: …`, `read_only_mode: …`, `risk_denied: …` | a row the engine has not settled (`final` false) is not terminal here either, except a whole fill, which cannot change |
| paper | `deriv_orders` with `state` null | `mapPaperOrder` (in `projection.ts`: the paper engine is the venue of a paper order) | `pending`, `triggered`, `open` → `SUBMITTED`; a cancelled order with fills → `REMAINDER_CANCELLED` |
| GMX | `deriv_gmx_ops`, kinds `increase` and `decrease` | `mapGmxOp`; a `failed` operation is classified from its text by `gmxFailure` (`TX_REVERTED`, `TX_REPLACED`, `NO_ORDER_EVENT`, `SIGNER_HASH_MISMATCH`, a signer refusal), otherwise `INTERNAL_ERROR` with the text | a `cancel` operation acts on another order and is not an order |

Rules that follow from the state machine:

- `PARTIALLY_FILLED` and `FILLED` are reached only through `reconciled_found`, built from what the engine read
  at the venue. The answer of a submission never fills a unified order.
- An engine "never placed" becomes `FAILED / NEVER_PLACED` only through `reconciled_absent` with
  `VENUE_RECONCILE` and the expiry of the signed request. Inside the grace window the order stays `UNKNOWN /
  ABSENT_WITHIN_GRACE`.
- Past `SUBMITTING` no local event may close an order. A GMX operation that fails after its outcome was
  unknown is recorded as `REJECTED / VENUE_REJECTED` (what the chain said), not `FAILED`.
- A terminal record never moves.

**Why it cannot drift.** The projector is fed by database triggers on the engine tables, not by calls placed
in the engines' code: any write to an engine row, by any code path — the trading API, the routes that existed
before, a perp agent, a reconciliation worker — queues the row. The queue is drained after every call of the
order service, before every read of the order list, and by the supervisor loop. A row placed through a route
that existed before is adopted the first time it is seen (`origin = legacy`, id `adopt-…`; the API shows it
under its former id `deriv:<account>:<clientId>` or `gmx:<id>`). Tests assert that no engine row is without
its unified order and that no `projection_error` is left.

Not projected: the spot agents' swaps (`agent_orders`). `GET /orders` still lists them beside the unified
orders; they are owned by the agents workstream.

### 8.5 Reconciler and restart (`OrderService.reconcile`)

One pass, run every 5 s by the `orders` loop when workers are on. It keeps nothing in memory.

1. Drains the projection queue.
2. `UNKNOWN` orders that are due: for Hyperliquid the engine's own reconciliation of the account is run (it
   asks the venue for the client order id), and the row is projected again. The order becomes `SUBMITTED`,
   `PARTIALLY_FILLED`, `FILLED`, `CANCELLED` or `REJECTED` from what the venue says, or `FAILED / NEVER_PLACED`
   once the absence is conclusive. Otherwise the next lookup is scheduled. A submission is never sent again.
3. Orders of the service left in `CREATED`, `VALIDATED`, `APPROVED` or `SUBMITTING` for more than 30 s: if the
   engine holds a row, it is projected; if it holds none, the order is `FAILED / INTERNAL_ERROR` ("interrupted
   before the engine stored the order; nothing was signed or sent").
4. `AWAITING_APPROVAL`, `SUBMITTED` and `PARTIALLY_FILLED` orders follow their engine row, which the engine's
   own worker keeps current (expiry of the approval window, fills, cancellations).

### 8.6 Cancel, close, reduce

- `cancel`: a key cancels its own orders only. An order that never reached an engine is withdrawn at once. At
  the venue, `cancel_requested` is recorded first (so that the final reason is `CANCELLED_BY_REQUEST`), the
  engine's cancel is called, and the order is `CANCELLED` when the venue says so. A GMX order is cancelled in
  the app (a wallet transaction with a passkey).
- `reducePosition` (close = fraction 1): a reduce-only market order sized from the position the account
  reports. It is refused with `not_reducing` unless the risk engine itself finds it strictly reducing.

### 8.7 Locks

| Lock | Default | Closes |
|---|---|---|
| `SPW_TRADING_API_EXECUTION` | off | every new live risk asked through the order service: 403 `execution_disabled`, nothing is created. Cancels and strictly reducing orders pass; paper is not concerned |
| `SPW_DERIV_LIVE_MAINNET` | off | unchanged: new mainnet risk on Hyperliquid (`mainnet_disabled`) |
| `SPW_DERIV_MANDATE_MAINNET` | off | unchanged: orders under a mandate on mainnet (`mandate_mainnet_disabled`) |
| `SPW_DERIV_GMX_LIVE` | off | unchanged: GMX increases (`gmx_disabled`) |

The three existing locks are applied by the engines, as before. The order service adds no path around them:
a lock that is off rejects the order with its code, and the preview lists it under `refusals` with the stage
`lock`.

### 8.8 What is not done

- Spot orders through the order service. For the owner the answer is 422 `spot_via_swap_screen`; for an API
  key or an agent 403 `spot_execution_requires_agent_vault`.
- Live orders on GMX through the order service (422 `venue_not_wired`). GMX orders placed in the app are
  projected into the unified table.
- The stop-loss and take-profit orders a command attaches (`SL`, `TP`) are returned, not placed.
- The spot agents' swaps are not unified orders.
