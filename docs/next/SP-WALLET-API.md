# SP Wallet NEXT — the core wallet API contract

The contract of everything a wallet client (web, macOS, iOS) uses outside `/api/v1/trading`. It closes audit finding A1
("the core wallet API has no machine-readable contract").

| File | What it is |
|---|---|
| `services/api/src/wallet-api/spec.ts` | The source: schemas, the table of operations, the enumerations, the error catalogue. Pure (zod only). |
| `docs/openapi/wallet-v1.json` | The OpenAPI 3.1 document, generated. |
| `apps/web/src/generated/wallet-api.ts` | TypeScript types for the web app, generated from the document. |
| this file | The conventions, and tables generated from the same source between `GENERATED` markers. |

The tables below between `<!-- BEGIN GENERATED -->` markers are written by the generator: do not edit them by hand, a test
fails when they differ from what the code gives.

## 1. How the contract is produced and kept true

```
services/api/src/wallet-api/spec.ts ──► npx tsx scripts/gen-openapi.mts ──► docs/openapi/wallet-v1.json
                                                                        ├──► apps/web/src/generated/wallet-api.ts
                                                                        └──► the generated sections of this file
```

`npx tsx scripts/gen-openapi.mts --check` writes nothing and exits 1 when a committed file is stale.

The trading API registers its routes *from* its table, so its document cannot drift. The wallet routes were written before
their table and shipped native apps decode their answers, so the wallet table *describes* existing routes. Three tests
make that description binding (`services/api/test/wallet-contract.test.ts`, `wallet-api-unit.test.ts`):

1. **Answers are validated against the document.** The test boots the real server on its own database, with a real signer
   process and scripted chain reads and prices, calls every operation, and validates each answer against the response
   schema of the generated document — in *strict* mode: a member the code returns that the schema does not declare fails
   the test, as does a value of an enumeration that is not in its list. Error answers are validated against the error
   model and must carry a code the operation declares.
2. **No route is undocumented.** The test enumerates the routes Fastify registered under `/api/v1` and fails when one is
   neither an operation of the table nor under a prefix of the allow-list below (families documented elsewhere).
3. **Generated files are current**, and every error code thrown by the wallet's own route files is catalogued (the test
   scans the sources for `new UserError('code', …)`), as is every transfer warning a chain adapter can emit.

Request schemas are copies of the routes' own zod schemas (those live inside modules that open a database connection when
imported). A request member added to a route without its copy here is not caught by a test today: see section 9.

## 2. Conventions

- **Additive.** No member is removed, renamed or retyped. Objects are open: a client ignores members it does not know.
  New routes, new members, and new values only in enumerations declared *open*.
- **Amounts are strings** of integer base units, with a display string computed by exact arithmetic next to them
  (`amount` / `amountDisplay`, `feePaid` / `feePaidDisplay`). Fiat figures are decimal strings with two decimals. Market
  prices are display numbers and never take part in an amount.
- **Estimates are flagged.** `feeEstimate` is an estimate and `feePaid` a fact; a portfolio total has `complete`; a value
  history has `estimatedMarketChange.estimate: true`; analytics buckets say how many movements are `valued` and how many
  are not; fee totals say how many transactions are `unknown`. Nothing computed from estimates is called a realised return.
- **Tolerant enumerations.** Every enumeration is a named component. `x-spw-open: true` → new values may appear: decode
  with an "unknown" fallback. `x-spw-open: false` → frozen. `state` of a proposal is frozen on purpose (shipped native
  builds decode it with a closed enum); the life cycle is read in `lifecycle`, which is open.
- **Errors** are `{ "error": code, "message": English sentence, "data"?: detail }`. Clients translate the code.
  A `bad_request` produced by input validation carries `data.fields: [{ path, code, message }]` — what is expected, never
  the value that was sent.
- **Sessions.** The owner session is a `__Host-spw` HttpOnly cookie; a mutating call also carries `Origin` and
  `X-SPW-CSRF: 1`. An API key opens nothing outside `/api/v1/trading`.
- **Lost answers.** Once an approval left the device its outcome is unknown until the server answers. A client re-reads
  the proposal; it never shows "failed", re-enables Approve or offers Cancel on a lost answer.

### Enumerations

<!-- BEGIN GENERATED: enums -->
| Enumeration | New values may appear | Known values |
|---|---|---|
| `ProposalState` | no (frozen) | `draft`, `pending_approval`, `approved`, `signed`, `broadcast`, `confirming`, `finalized`, `rejected`, `expired`, `failed`, `replaced`, `reorged`, `not_broadcast` |
| `Lifecycle` | **yes** — decode with a fallback | `draft`, `awaiting_confirmation`, `awaiting_signature`, `signed`, `broadcasting`, `pending`, `confirming`, `confirmed`, `failed`, `replaced`, `dropped`, `expired`, `rejected`, `not_sent` |
| `ProposalKind` | **yes** — decode with a fallback | `transfer`, `swap`, `bridge`, `xswap`, `gmx`, `nft` |
| `ActivityRowKind` | **yes** — decode with a fallback | `send`, `receive`, `swap`, `bridge`, `gmx` |
| `TransferWarning` | **yes** — decode with a fallback | `new_destination`, `address_poisoning_suspected`, `duplicate_recent`, `contract_destination`, `network_congested`, `creates_account`, `creates_token_account`, `near_creates_account`, `activates_account`, `deploys_wallet`, `destination_not_initialized`, `memo_numeric_id`, `dt_new_account`, `cd_token_outputs`, `l1_fee_unknown` |
| `ProposalErrorCode` | **yes** — decode with a fallback | `broadcast_disabled`, `approval_expired`, `expired_before_approval`, `interrupted_signing`, `not_broadcast_in_time`, `rejected_by_owner`, `signer_refused`, `signer_hash_mismatch`, `broadcast_attempt_failed`, `tx_failed`, `relay_unconfirmed`, `dropped`, `expired_onchain`, `replaced_onchain`, `swap_late`, `swap_approval_reverted`, `swap_would_revert`, `swap_would_revert_approved`, `bridge_late`, `bridge_approval_reverted`, `burn_would_revert`, `burn_would_revert_approved`, `xswap_late`, `xswap_vault_unconfirmed`, `xswap_approval_reverted`, `deposit_would_revert`, `deposit_would_revert_approved`, `sol_swap_unverified`, `sol_swap_expired`, `sol_swap_refused`, `sol_swap_would_fail`, `sol_swap_below_min`, `sol_swap_no_balances`, `sol_burn_mismatch`, `sol_burn_expired`, `sol_burn_refused`, `sol_burn_would_fail` |
| `DepositKind` | **yes** — decode with a fallback | `external`, `internal` |
| `DepositOrigin` | **yes** — decode with a fallback | `transfer`, `swap`, `bridge`, `xswap`, `gmx`, `nft`, `agent_withdrawal`, `venue_withdrawal` |
| `DepositDetection` | **yes** — decode with a fallback | `tx`, `internal_call`, `aggregate` |
| `FlowScope` | no (frozen) | `external`, `internal`, `ownAccounts` |
| `EventType` | **yes** — decode with a fallback | `transfer.state`, `transfer.relay`, `transfer.confirmations`, `deposit.seen`, `deposit.native_window`, `deposit.scan_gap`, `device.added`, `sessions.revoked`, `login.ok`, `owner.setup`, `addressbook.saved`, `addressbook.removed`, `settings.asset_pref`, `halt.on`, `security.contact_address_changed` |
| `AlertSeverity` | no (frozen) | `info`, `warning`, `critical` |
| `AlertGroup` | **yes** — decode with a fallback | `transfers`, `agents`, `derivatives`, `security`, `system` |
| `Currency` | no (frozen) | `USD`, `CAD` |
| `SearchMatch` | **yes** — decode with a fallback | `symbol`, `name`, `network`, `contract`, `label`, `address`, `note`, `txid`, `amount` |
<!-- END GENERATED: enums -->

## 3. Routes

<!-- BEGIN GENERATED: routes -->
| Method | Path | Tag | Session | Since | Summary |
|---|---|---|---|---|---|
| GET | `/api/v1/health/live` | Meta | public | v1 | Liveness |
| GET | `/api/v1/health/ready` | Meta | owner | v1 | Readiness: database, signer, networks, data sources |
| GET | `/api/v1/auth/state` | Auth | public | v1 | Is the wallet set up, and is this client signed in |
| POST | `/api/v1/auth/setup/options` | Auth | public | v1 | One-time setup: passkey creation options |
| POST | `/api/v1/auth/setup/verify` | Auth | public | v1 | One-time setup: enrol the first passkey with the signer's setup token |
| POST | `/api/v1/auth/login/options` | Auth | public | v1 | Sign-in: assertion options † |
| POST | `/api/v1/auth/login/verify` | Auth | public | v1 | Sign-in: verify the assertion, open a session † |
| POST | `/api/v1/auth/logout` | Auth | public | v1 | End this session † |
| GET | `/api/v1/networks` | Wallet | owner | v1 | The networks of the wallet, with their verified assets and their health |
| GET | `/api/v1/assets` | Wallet | owner | v1 | The verified asset registry, flat |
| GET | `/api/v1/accounts` | Wallet | owner | v1 | The wallet's own address on every network |
| GET | `/api/v1/assets/prefs` | Wallet | owner | NEXT | Hidden and favourite assets |
| PUT | `/api/v1/assets/prefs/{network}/{asset}` | Wallet | owner | NEXT | Hide, show or favourite one asset |
| GET | `/api/v1/market/{symbol}` | Wallet | owner | v1 | Price history of one asset |
| GET | `/api/v1/portfolio` | Portfolio | owner | v1 | Balances with provenance, prices, the server-side summary and the operations in flight |
| GET | `/api/v1/portfolio/history` | Portfolio | owner | NEXT | Value of the wallet over time, with what entered and left |
| POST | `/api/v1/transfers/proposals` | Transfers | owner | v1 | Prepare a transfer: validation, fee estimate, policy pre-check, warnings |
| GET | `/api/v1/transfers/proposals/{id}` | Transfers | owner | v1 | One proposal |
| GET | `/api/v1/transfers/{id}/status` | Transfers | owner | v1 | The short status of one proposal |
| POST | `/api/v1/transfers/proposals/{id}/request-approval` | Transfers | owner | v1 | Freeze the exact transaction and get the passkey challenge |
| POST | `/api/v1/transfers/proposals/{id}/approve` | Transfers | owner | v1 | Approve with the passkey assertion over the intent hash; sign and relay |
| POST | `/api/v1/transfers/proposals/{id}/reject` | Transfers | owner | v1 | Reject a draft or a proposal awaiting approval |
| GET | `/api/v1/activity` | Activity | owner | v1 | Operations and receipts of the wallet, newest first |
| GET | `/api/v1/export/activity.csv` | Activity | owner | v1 | Every operation and receipt as CSV (text/csv) |
| GET | `/api/v1/addressbook` | AddressBook | owner | v1 | Contacts (legacy shape) |
| POST | `/api/v1/addressbook` | AddressBook | owner | v1 | Create a contact, or relabel the one that has this address |
| PATCH | `/api/v1/addressbook/{id}` | AddressBook | owner | NEXT | Edit a contact: label, note, favourite, address |
| DELETE | `/api/v1/addressbook/{id}` | AddressBook | owner | v1 | Delete a contact |
| GET | `/api/v1/contacts` | AddressBook | owner | NEXT | Contacts with note and favourite, favourites first |
| GET | `/api/v1/settings` | Settings | owner | v1 | Account settings shared by every device |
| PUT | `/api/v1/settings` | Settings | owner | v1 | Change settings (any subset) |
| GET | `/api/v1/security/overview` | Security | owner | v1 | Signer state, passkeys, sessions † |
| GET | `/api/v1/security/audit` | Security | owner | v1 | The audit hash chain, newest first |
| GET | `/api/v1/security/devices` | Security | owner | v1 | Passkeys known to the API † |
| POST | `/api/v1/security/devices/options` | Security | owner | v1 | Add a passkey, step 1: creation options † |
| POST | `/api/v1/security/devices/verify` | Security | owner | v1 | Add a passkey, step 2: verify the new passkey, get the challenge an EXISTING passkey must sign † |
| POST | `/api/v1/security/devices/confirm` | Security | owner | v1 | Add a passkey, step 3: the existing passkey's assertion; the signer enrols † |
| POST | `/api/v1/security/sessions/revoke-all` | Security | owner | v1 | Revoke every session, this one included † |
| POST | `/api/v1/security/emergency-halt` | Security | owner | v1 | Trigger the emergency halt of the signer |
| GET | `/api/v1/alerts` | Alerts | owner | v1 | In-app alerts, newest first |
| GET | `/api/v1/alerts/unread` | Alerts | owner | v1 | Unread counters |
| POST | `/api/v1/alerts/read` | Alerts | owner | v1 | Mark alerts read |
| GET | `/api/v1/alerts/stream` | Alerts | owner | v1 | Unread counters as Server-Sent Events (text/event-stream) |
| GET | `/api/v1/alerts/settings` | Alerts | owner | v1 | The owner's alert switches, quiet hours, thresholds, webhook |
| PUT | `/api/v1/alerts/settings` | Alerts | owner | v1 | Change alert settings (any subset) |
| POST | `/api/v1/alerts/webhook/secret` | Alerts | owner | v1 | Generate the webhook signing secret (shown once) |
| POST | `/api/v1/alerts/webhook/test` | Alerts | owner | v1 | Send a test call to the webhook |
| GET | `/api/v1/push/key` | Alerts | owner | v1 | VAPID public key for Web Push |
| GET | `/api/v1/push/subscriptions` | Alerts | owner | v1 | Devices subscribed to push |
| POST | `/api/v1/push/subscriptions` | Alerts | owner | v1 | Subscribe this device |
| PATCH | `/api/v1/push/subscriptions/{id}` | Alerts | owner | v1 | Rename a device, change its language |
| DELETE | `/api/v1/push/subscriptions/{id}` | Alerts | owner | v1 | Unsubscribe a device |
| POST | `/api/v1/push/test` | Alerts | owner | v1 | Send a test notification |
| GET | `/api/v1/events` | Events | owner | NEXT | Catch-up read of the wallet event log |
| GET | `/api/v1/events/stream` | Events | owner | NEXT | The wallet event log as Server-Sent Events (text/event-stream) |
| GET | `/api/v1/dashboard/status` | Dashboard | owner | v1 | Risk switches and live-limit completeness (header indicator) |
| GET | `/api/v1/dashboard/summary` | Dashboard | owner | v1 | Trading books, risk, agents, health, audit chain — each section fails on its own |
| GET | `/api/v1/dashboard/activity` | Dashboard | owner | v1 | One history of every operation: wallet, plans, orders, risk denials, audit |
| GET | `/api/v1/dashboard/activity.csv` | Dashboard | owner | v1 | The same history as CSV (text/csv) |
| GET | `/api/v1/analytics` | Analytics | owner | NEXT | What entered and left, fees paid, outcomes, counterparties — from the database only |
| GET | `/api/v1/search` | Search | owner | NEXT | Universal search: assets, contacts, transactions |

61 operations. † = being redesigned, described as the code is today (see the TODO list).
<!-- END GENERATED: routes -->

### Families documented elsewhere

Routes under these prefixes are deliberately outside this document.

<!-- BEGIN GENERATED: families -->
| Prefix | Documented in |
|---|---|
| `/api/v1/trading` | docs/openapi/trading-v1.json (SP Trading API) |
| `/api/v1/developer` | docs/TRADING-API-REFERENCE.md (API keys, webhooks) |
| `/api/v1/swap` | swap family |
| `/api/v1/bridge` | CCTP bridge family |
| `/api/v1/xswap` | native cross-chain swap family |
| `/api/v1/plans` | any-to-any plans |
| `/api/v1/nfts` | NFT family |
| `/api/v1/derivatives` | derivatives family |
| `/api/v1/agents` | agents family |
| `/api/v1/strategies` | agents family |
| `/api/v1/research` | research runtime |
| `/api/v1/monitor` | monitoring dashboard |
| `/api/v1/markets-hub` | markets hub |
| `/api/v1/private-markets` | private markets |
| `/api/v1/market-data` | market data engine (candles, data quality) |
| `/api/v1/utxo-locks` | UTXO locks (Bitcoin-style coins set aside; docs/adr) |
| `/api/v1/risk` | risk engine |
| `/api/v1/mandates` | trading mandates |
| `/api/v1/mm` | live market making |
| `/api/v1/stream` | quote engine websocket (docs/V11-QUOTE-ENGINE.md) |
<!-- END GENERATED: families -->

## 4. What NEXT added to the core API

| Route or member | What |
|---|---|
| `GET /api/v1/analytics?range=1M\|3M\|1Y\|ALL[&currency=]` | Inflows and outflows per asset and per network (count, base units, display), split external / internal / ownAccounts with the same rule as the portfolio flows; network fees paid per network with the number of transactions whose fee is unknown; counts by life-cycle outcome; biggest counterparties with their contact label. Database only. |
| `GET /api/v1/search?q=[&limit=]` | Assets (symbol, name, network, contract), contacts (label, address, note), transactions (transaction id prefix, address, exact amount). Capped groups with `truncated`. |
| `GET /api/v1/activity?network=&asset=` | Optional filter evaluated in SQL before the limit. |
| `GET /api/v1/dashboard/activity?network=&asset=` (and `.csv`) | The same filter, passed to the wallet source. |
| `contactLabel` on every row of `GET /api/v1/activity` | Address-book label of the counterparty, or null. |
| `data.fields` on `400 bad_request` | Which members were refused, and why. |
| CSV exports | Columns appended at the end of the row: `lifecycle`, `fee_paid_base_units`, `fee_paid`, `fee_symbol`, `deposit_kind`, `deposit_origin`, `contact_label` (`/export/activity.csv`); `lifecycle`, `fee_paid`, `fee_symbol`, `deposit_kind`, `deposit_origin`, `contact_label` (`/dashboard/activity.csv`). |
| Alert kinds | `transfer.dropped`, `transfer.replaced`, `transfer.expired`, `transfer.recovered` (section 7). |

**Analytics classification.** A deposit is `external` unless the scan classified it `internal`; an internal deposit whose
origin is `agent_withdrawal` or `venue_withdrawal` is `ownAccounts`. An outgoing operation counts once it is final: a plain
transfer to another address is `external`, or `ownAccounts` when it pays one of the owner's agent vaults or funds a venue
account; swaps, bridges, native swaps, GMX order transactions and self-transfers are `internal` (nothing left the wallet).
NFT transfers move no fungible amount and are counted in the outcomes only. This is the rule of
`services/api/src/portfolio.ts` (`recordFlows`), which also records the price used for the fiat figures: the price the API
had when it saw the movement, within 30 minutes of it. A movement without such a price is counted in `unvalued` and is in
no fiat sum. Internal movements are never valued.

**Fees.** `fees.byNetwork[].paid` sums `fee_paid` — the fee the network charged, recorded by the tracker — in the
network's native coin. `known` is the number of on-chain transactions it covers; `unknown` counts the on-chain transactions
whose fee was never recorded (every row older than NEXT), which are *not* in the sum. The fee of a separate token-approval
transaction is not recorded. Fees have no fiat value: no price is recorded with a fee.

## 5. Errors

Every error is `{ error, message, data? }`. Codes common to every operation: `unauthenticated` (401, session routes),
`csrf` (403, mutating routes), `bad_request` (400), `rate_limited` (429), `internal` (500).

<!-- BEGIN GENERATED: errors -->
| Code | Status | Meaning | What the client does |
|---|---|---|---|
| `bad_address` | 400 | the destination is not a valid address of this network, or is the wallet itself | correct the address |
| `bad_amount` | 400 | the amount is not a positive decimal within the asset's precision | correct the amount |
| `bad_destination` | 400 | the destination cannot receive this asset (account type, missing trust line…) | check the destination |
| `bad_memo` | 400 | the memo / destination tag is not accepted on this network | correct or remove it |
| `bad_request` | 400 | the request is not valid; `data.fields` lists the refused members when it comes from input validation | fix the request; do not retry unchanged |
| `bad_source` | 400 | the wallet's own account cannot send this asset in its present state | see the message |
| `bad_state` | 409 | the proposal is not in a state that allows this | re-read the proposal and show its real state |
| `below_rent` | 400 | the transfer would leave an account below its rent-exempt minimum | change the amount |
| `below_reserve` | 400 | the transfer would leave the account below the network reserve | change the amount |
| `challenge_expired` | 401 | the challenge expired or was already used | ask for new options and try again |
| `conflict` | 409 | the object changed concurrently | reload it, then decide again |
| `contract_destination` | 400 | the destination is a contract that cannot receive this transfer | check the destination |
| `csrf` | 403 | a mutating request without the same-origin proof (`Origin` + `X-SPW-CSRF: 1`) | send both headers; never retry from another origin |
| `duplicate_contact` | 409 | another contact already has this address | edit that contact |
| `expired` | 400, 410 | the approval window, or the pending passkey, expired | start again |
| `fee_ceiling` | 422 | the fee needed exceeds the signer's ceiling | retry later |
| `fee_too_high` | 400, 503 | the network fee is above the wallet's ceiling right now, or could not be established | retry later |
| `halted` | 423 | the emergency halt is active | nothing can be signed until the halt is lifted on the signer |
| `hash_mismatch` | 500 | the signer answered another intent hash; the transfer was marked failed | report it; nothing was sent |
| `idempotency` | 400 | the `Idempotency-Key` header is missing or malformed (16–64 letters, digits, dashes) | send one key per intended transfer |
| `idempotency_mismatch` | 409 | this Idempotency-Key was already used for a different request | use a new key |
| `insufficient_funds` | 400 | the balance does not cover the amount and the fee | lower the amount |
| `insufficient_gas` | 400 | not enough of the network's native coin to pay the fee | fund the native coin |
| `insufficient_unlocked_funds` | 400 | part of the balance is locked | lower the amount |
| `internal` | 500 | server error | retry later; a transfer approval is NOT retried blindly — re-read the proposal first |
| `invalid_cursor` | 400 | the cursor is not one a previous page returned | restart from the first page |
| `login_failed` | 401 | authentication failed (unknown passkey or bad assertion) | try again; repeated failures raise an alert |
| `memo_required` | 400 | the destination requires a memo / tag | add it |
| `not_found` | 404 | the object does not exist | reload the list |
| `owner_only` | 403 | the route is for the owner's session, not an API key | use the session |
| `pending_tx` | 400, 409 | another transfer or swap on this network is not confirmed yet | wait for it; a dropped one no longer blocks |
| `policy` | 422 | the signer's policy refuses it (limit per transfer, per day, asset not allowed, halt) | see the message; limits are changed on the signer only |
| `protocol_changed` | 503 | the network's protocol changed since this wallet was reviewed; sending is suspended | update the wallet |
| `rate_limited` | 429 | too many requests from this address | wait a minute |
| `registration_failed` | 401 | the passkey registration could not be verified | try again |
| `rpc_degraded` | 503 | not enough data sources answered for this network; nothing was prepared | retry later |
| `rpc_disagreement` | 503 | the data sources disagree; nothing was prepared | retry later |
| `runtime_changed` | 503 | the network's runtime changed since this wallet was reviewed; sending is suspended | update the wallet |
| `setup_closed` | 403 | the one-time setup was already completed | sign in instead |
| `setup_token` | 403 | the setup token is missing | ask for the token printed by the signer |
| `signer_unreachable` | 503 | the signer cannot be reached; nothing was signed | reads still work; retry sending later |
| `simulation_failed` | 400 | the exact transaction could not be built or would fail now | see the message; nothing was signed |
| `stale_contact` | 409 | the contact changed since it was read | reload it before changing its address |
| `too_many_coins` | 400 | too many small coins are needed for this amount | send a smaller amount first |
| `too_many_streams` | 429 | too many event streams are open | close one, or fall back to polling |
| `too_many_subscriptions` | 422 | too many push devices | remove one |
| `unauthenticated` | 401 | no valid session | sign in with the passkey, then repeat the request |
| `unsupported_account` | 400 | the account type is not supported | see the message |
| `unsupported_asset` | 400, 404 | the asset is not in the verified registry of this network | pick an asset of GET /assets |
| `unsupported_funds` | 400 | the balance is of a kind this wallet does not spend | see the message |
| `unsupported_network` | 503 | the signer has no key for this network | do not offer this network |
<!-- END GENERATED: errors -->

### Codes per operation

*open* = a chain adapter or the signer can answer a code of its own; a signer refusal is `signer_<its code>` (422).

<!-- BEGIN GENERATED: errors-per-route -->
| Operation | Codes beyond the common ones |
|---|---|
| POST `/api/v1/auth/setup/options` | `setup_closed` (403) |
| POST `/api/v1/auth/setup/verify` | `challenge_expired` (401), `registration_failed` (401), `setup_closed` (403), `setup_token` (403), `signer_unreachable` (503), *open* |
| POST `/api/v1/auth/login/verify` | `challenge_expired` (401), `login_failed` (401) |
| GET `/api/v1/accounts` | `signer_unreachable` (503) |
| PUT `/api/v1/assets/prefs/{network}/{asset}` | `unsupported_asset` (404) |
| GET `/api/v1/portfolio` | `signer_unreachable` (503) |
| POST `/api/v1/transfers/proposals` | `idempotency` (400), `unsupported_asset` (400), `bad_address` (400), `bad_amount` (400), `bad_memo` (400), `idempotency_mismatch` (409), `conflict` (409), `policy` (422), `signer_unreachable` (503), `bad_destination` (400), `bad_source` (400), `memo_required` (400), `contract_destination` (400), `insufficient_funds` (400), `insufficient_gas` (400), `insufficient_unlocked_funds` (400), `below_rent` (400), `below_reserve` (400), `too_many_coins` (400), `unsupported_account` (400), `unsupported_funds` (400), `fee_too_high` (400), `simulation_failed` (400), `pending_tx` (400), `pending_tx` (409), `fee_ceiling` (422), `fee_too_high` (503), `rpc_degraded` (503), `rpc_disagreement` (503), `protocol_changed` (503), `runtime_changed` (503), `unsupported_network` (503), *open* |
| GET `/api/v1/transfers/proposals/{id}` | `not_found` (404) |
| GET `/api/v1/transfers/{id}/status` | `not_found` (404) |
| POST `/api/v1/transfers/proposals/{id}/request-approval` | `not_found` (404), `bad_state` (409), `pending_tx` (409), `conflict` (409), `policy` (422), `halted` (423), `signer_unreachable` (503), `bad_destination` (400), `bad_source` (400), `memo_required` (400), `contract_destination` (400), `insufficient_funds` (400), `insufficient_gas` (400), `insufficient_unlocked_funds` (400), `below_rent` (400), `below_reserve` (400), `too_many_coins` (400), `unsupported_account` (400), `unsupported_funds` (400), `fee_too_high` (400), `simulation_failed` (400), `pending_tx` (400), `fee_ceiling` (422), `fee_too_high` (503), `rpc_degraded` (503), `rpc_disagreement` (503), `protocol_changed` (503), `runtime_changed` (503), `unsupported_network` (503), *open* |
| POST `/api/v1/transfers/proposals/{id}/approve` | `not_found` (404), `bad_state` (409), `pending_tx` (409), `conflict` (409), `expired` (410), `hash_mismatch` (500), `signer_unreachable` (503), *open* |
| POST `/api/v1/transfers/proposals/{id}/reject` | `not_found` (404), `bad_state` (409), `conflict` (409) |
| POST `/api/v1/addressbook` | `bad_address` (400) |
| PATCH `/api/v1/addressbook/{id}` | `bad_address` (400), `not_found` (404), `stale_contact` (409), `duplicate_contact` (409) |
| POST `/api/v1/security/devices/verify` | `challenge_expired` (401), `registration_failed` (401) |
| POST `/api/v1/security/devices/confirm` | `expired` (400), `signer_unreachable` (503), *open* |
| POST `/api/v1/security/emergency-halt` | `signer_unreachable` (503), *open* |
| GET `/api/v1/alerts/stream` | `too_many_streams` (429) |
| POST `/api/v1/push/subscriptions` | `too_many_subscriptions` (422) |
| PATCH `/api/v1/push/subscriptions/{id}` | `not_found` (404) |
| POST `/api/v1/push/test` | `not_found` (404) |
| GET `/api/v1/events/stream` | `too_many_streams` (429) |
| GET `/api/v1/dashboard/status` | `owner_only` (403) |
| GET `/api/v1/dashboard/summary` | `owner_only` (403) |
| GET `/api/v1/dashboard/activity` | `invalid_cursor` (400), `owner_only` (403) |
| GET `/api/v1/dashboard/activity.csv` | `owner_only` (403) |
<!-- END GENERATED: errors-per-route -->

### Outcome of a proposal (`errorCode`)

Not HTTP errors: why a stored proposal ended or is held. Source: `services/api/src/sv-texts.ts`.

<!-- BEGIN GENERATED: outcomes -->
| `errorCode` | English sentence (`error`) |
|---|---|
| `broadcast_disabled` | signed but NOT broadcast: broadcasting is disabled on this server (SPW_BROADCAST=off); nothing was sent to the network |
| `approval_expired` | approval window expired |
| `expired_before_approval` | expired before approval |
| `interrupted_signing` | interrupted during signing; nothing was broadcast |
| `not_broadcast_in_time` | could not be broadcast in time; nothing was sent |
| `rejected_by_owner` | rejected by owner |
| `signer_refused` | the signer refused: {detail} |
| `signer_hash_mismatch` | signer hash mismatch |
| `broadcast_attempt_failed` | broadcast attempt failed: {detail} |
| `tx_failed` | the transaction failed on-chain: {detail} |
| `relay_unconfirmed` | handed to the network without an acknowledgement and not found on-chain; it stays watched and is recorded if it appears. A new transfer on this network replaces it |
| `dropped` | no longer known to the network and not confirmed; it stays watched and is recorded if it appears. A new transfer on this network replaces it |
| `expired_onchain` | its validity window closed before the network included it; nothing moved |
| `replaced_onchain` | another transaction used the same nonce or the same coins; this one can no longer be included |
| `swap_late` | the swap could not be sent in time; nothing was swapped |
| `swap_approval_reverted` | the token approval reverted; nothing was swapped |
| `swap_would_revert` | the swap would revert now ({detail}); it was not sent |
| `swap_would_revert_approved` | the swap would revert now ({detail}); it was not sent. The exact-amount approval stays in place for the next attempt |
| `bridge_late` | the transfer could not be sent in time; nothing was burned |
| `bridge_approval_reverted` | the token approval reverted; nothing was burned |
| `burn_would_revert` | the burn would revert now ({detail}); it was not sent |
| `burn_would_revert_approved` | the burn would revert now ({detail}); it was not sent. The exact-amount approval stays in place for the next attempt |
| `xswap_late` | the swap could not be sent in time; nothing was sent to the vault |
| `xswap_vault_unconfirmed` | the vault is no longer confirmed ({detail}); nothing was sent to it |
| `xswap_approval_reverted` | the token approval reverted; nothing was sent to the vault |
| `deposit_would_revert` | the deposit would revert now ({detail}); it was not sent |
| `deposit_would_revert_approved` | the deposit would revert now ({detail}); it was not sent. The exact-amount approval of the router stays in place; only this wallet can use it |
| `sol_swap_unverified` | the stored swap no longer verifies; it was not sent |
| `sol_swap_expired` | the swap expired before it could be sent (blockhash too old); nothing was swapped |
| `sol_swap_refused` | the node refused the signed swap ({detail}); it was not sent |
| `sol_swap_would_fail` | the swap would fail now ({detail}); it was not sent |
| `sol_swap_below_min` | the swap no longer delivers the approved minimum in simulation; it was not sent |
| `sol_swap_no_balances` | the node did not report the simulated balances; the swap was not sent |
| `sol_burn_mismatch` | the signer returned a transaction that is not the approved burn; it was not sent |
| `sol_burn_expired` | the transfer expired before it could be sent (blockhash too old); nothing was burned |
| `sol_burn_refused` | the node refused the signed burn ({detail}); it was not sent |
| `sol_burn_would_fail` | {detail}; it was not sent |
<!-- END GENERATED: outcomes -->

### Warnings of a transfer review (`warnings`)

<!-- BEGIN GENERATED: warnings -->
| Warning | Meaning | Acknowledge before approving | Emitted |
|---|---|---|---|
| `new_destination` | the wallet never sent to this address and it is not in the address book | yes | yes |
| `address_poisoning_suspected` | the address differs from a known one but starts and ends with the same characters: the classic look-alike of an address-poisoning attack | yes | yes |
| `duplicate_recent` | the same asset, amount and destination was sent, or may have been sent, in the last 24 hours | yes | yes |
| `contract_destination` | the destination is a contract (EVM) or a program-owned account (Solana), not a plain wallet: it may not be able to use what it receives | no | yes |
| `network_congested` | the network is congested: the fee is capped, so the transfer may expire without being included (nothing moves in that case) | no | yes |
| `creates_account` | the destination account does not exist yet on this network: the transfer creates it and part of the amount stays locked as its reserve | no | yes |
| `creates_token_account` | Solana: the destination has no account for this token; the transfer creates it and the sender pays its rent | no | yes |
| `near_creates_account` | NEAR: the destination account does not exist yet; the transfer creates it, which adds a fee paid by the sender | no | yes |
| `activates_account` | the address was never used on this network: activating it is charged to the sender on top of the amount (TRON) | no | yes |
| `deploys_wallet` | TON: the first outgoing transfer also deploys the wallet contract (slightly higher fee, cannot be simulated beforehand) | no | yes |
| `destination_not_initialized` | TON: no contract is deployed at the destination (a new wallet, or a wrong address); the funds are credited there and cannot bounce back | no | yes |
| `memo_numeric_id` | Stellar: the memo is digits only and is sent as a numeric id (MEMO_ID), the format exchanges expect | no | yes |
| `dt_new_account` | Polkadot Asset Hub: the destination account does not exist yet; this transfer creates it and it must always keep the existential deposit | no | yes |
| `cd_token_outputs` | Cardano: some outputs of this wallet carry native tokens or script data; they are never spent and their ADA stays locked with them | no | yes |
| `l1_fee_unknown` | OP-stack networks: the L1 data fee could not be read; the fee ESTIMATE covers the L2 part only and the chain charges the data fee on top (it is not a field the signer can bound) | no | yes |
<!-- END GENERATED: warnings -->

A client shows a code it does not know as a generic caution. On this branch the web app has no `w_duplicate_recent` and no
`w_l1_fee_unknown` string yet (the web safety work owns them): a test lists the gap.

## 6. Life cycle of a transfer

`lifecycle` is the vocabulary of the three clients; `finalized` tells "in a block" from "final"; `watched` marks a dropped
or replaced transfer the worker still re-checks. `state` keeps the earlier vocabulary (a dropped transfer reads `failed`
there, with `errorCode: dropped`).

<!-- BEGIN GENERATED: lifecycle -->
| `lifecycle` | Meaning |
|---|---|
| `draft` | prepared, nothing frozen; expires by itself |
| `awaiting_confirmation` | the exact transaction is frozen and shown; the passkey has not been given |
| `awaiting_signature` | the passkey was given; the signer call is in flight |
| `signed` | signed; no relay to the network has started |
| `broadcasting` | signed and a relay has started: from here only the chain can say that nothing was sent |
| `pending` | handed to the network, not in a block yet |
| `confirming` | in a block, not final (see `confirmations`); a reorganisation can still undo it |
| `confirmed` | FINAL. The only value a client may treat as done |
| `failed` | ended without effect, or reverted on-chain (`errorCode` says which) |
| `replaced` | another transaction used the same nonce or coins. Still re-checked for a day (`watched`): it becomes confirming / confirmed if it turns out to be in a block |
| `dropped` | no source knows it and nothing proves it dead. NOT a failure: it stays watched and is recorded if it appears; a new send on the network replaces it |
| `expired` | the approval window passed before the passkey, or the validity window of the signed transaction closed on-chain (`errorCode: expired_onchain`); nothing moved |
| `rejected` | rejected by the owner before signing |
| `not_sent` | signed and deliberately not relayed (broadcasting is disabled on this server) |
<!-- END GENERATED: lifecycle -->

## 7. Events and alerts

`GET /api/v1/events?after=` and `GET /api/v1/events/stream` deliver the wallet event log. An event says "look": the client
re-reads the object named by `ref`. `reset` means the position cannot be resumed.

<!-- BEGIN GENERATED: events -->
| `type` | What happened |
|---|---|
| `transfer.state` | a proposal changed state — `data`: `{ from, to, lifecycle, network, kind, txid, confirmations, errorCode }`; `ref` = proposal id |
| `transfer.relay` | a relay of the signed transaction to the network started (its outcome is not known yet) — `data`: `{ network, lifecycle: "broadcasting", txid }` |
| `transfer.confirmations` | the confirmation count of a tracked transaction changed — `data`: `{ network, confirmations, txid }` |
| `deposit.seen` | an incoming payment was recorded — `data`: `{ network, txid, asset, amount, kind, origin?, proposal?, detection? }` |
| `deposit.native_window` | EVM native-coin scan: a balance difference was located to a block window, not to a transaction |
| `deposit.scan_gap` | a transaction of the deposit scan is no longer served by any source |
| `device.added` | a passkey was added — `data`: `{ credential, label }` |
| `sessions.revoked` | every session was revoked |
| `login.ok` | a sign-in succeeded — `data`: `{ credential, ip }` |
| `owner.setup` | the first passkey was enrolled (one-time setup) |
| `addressbook.saved` | a contact was created or changed — `data`: `{ network, address, label }` |
| `addressbook.removed` | a contact was deleted |
| `settings.asset_pref` | an asset was hidden / shown / made favourite — `data`: `{ network, asset, hidden, favorite }` |
| `halt.on` | the emergency halt of the signer was triggered |
| `security.contact_address_changed` | a contact now points to another address — `data`: `{ id, network, label, from, to }` |
<!-- END GENERATED: events -->

Every audit type matching `deposit.*`, `device.*`, `session(s).*`, `addressbook.*`, `settings.*`, `halt.*`, `security.*`
is mirrored into the log, so types not listed here can appear.

**Alerts for the life-cycle outcomes.** Before NEXT only `finalized` and `failed` raised an alert. Added
(`packages/core/src/alert-catalog.ts`, `services/api/src/alerts/rules.ts`), all ON by default, with a lock-screen wording
that names the network and the kind of operation only:

| Kind | Severity | Raised when | Says |
|---|---|---|---|
| `transfer.dropped` | warning | a proposal moves to `dropped` | not included, still watched, a new send on the network replaces it |
| `transfer.replaced` | warning | a proposal moves to `replaced` | another transaction used its nonce or coins; still re-checked |
| `transfer.expired` | warning | a plain transfer fails with `expired_onchain` | its validity window closed on-chain; nothing moved |
| `transfer.recovered` | critical | a dropped or replaced proposal moves to `confirming` or `finalized` | the transfer believed dead went through: do not send it again |

A recovery is critical so that quiet hours and the hourly cap never hold it back: it is the one message that prevents a
second payment made by other means. The alert kind `transfer.expired` is about the on-chain validity window; the *audit*
type `transfer.expired` (approval window passed before the passkey, nothing was signed) raises no alert.

## 8. TODO — routes owned by the credential / session work (branch `next-signer`)

These operations are in the document as the code is today, marked `x-spw-changing`. When that branch merges: update their
schemas in `spec.ts`, add the new routes (the route-enumeration test will fail until they are documented), regenerate.

<!-- BEGIN GENERATED: todo -->
| Operation | What is changing |
|---|---|
| POST `/api/v1/auth/login/options` (`loginOptions`) | sessions get public ids and per-session revoke; login history |
| POST `/api/v1/auth/login/verify` (`loginVerify`) | sessions get public ids and per-session revoke; login history |
| POST `/api/v1/auth/logout` (`logout`) | sessions get public ids and per-session revoke; login history |
| GET `/api/v1/security/overview` (`securityOverview`) | credential life cycle v2 (signed, expiring, single-use add / revoke objects verified by the signer); sessions get public ids and per-session revoke; login history |
| GET `/api/v1/security/devices` (`listDevices`) | credential life cycle v2 (signed, expiring, single-use add / revoke objects verified by the signer) |
| POST `/api/v1/security/devices/options` (`deviceOptions`) | credential life cycle v2 (signed, expiring, single-use add / revoke objects verified by the signer) |
| POST `/api/v1/security/devices/verify` (`deviceVerify`) | credential life cycle v2 (signed, expiring, single-use add / revoke objects verified by the signer) |
| POST `/api/v1/security/devices/confirm` (`deviceConfirm`) | credential life cycle v2 (signed, expiring, single-use add / revoke objects verified by the signer) |
| POST `/api/v1/security/sessions/revoke-all` (`revokeAllSessions`) | sessions get public ids and per-session revoke; login history |
<!-- END GENERATED: todo -->

Expected additions, not yet in the code and therefore not in the document: revoke one passkey; the signer's credential list
as the source of truth of `security/overview`; per-session ids and revoke-one; a login history route.

## 9. Not covered yet

- **Request schemas are copies.** The contract test binds answers, routes and error codes; it does not prove that a
  request schema of `spec.ts` equals the route's own. The fix is to export each route's zod schema from a pure module and
  use the same object on both sides (or to register the routes from the table, as the trading API does).
- **Free-form sections.** `swap`, `bridge`, `xswap`, `nft` and `quote` of a proposal, the `data` of the dashboard sections,
  the signer's `policy`, `rpcEndpoints` and the payload of an event are declared as open objects: they belong to families
  documented elsewhere and are not validated member by member here.
- **Shapes no test produces.** A network `health` object (the health worker is off in tests; the schema is the TypeScript
  interface), a price with a second source (`APIBRICKS_API_KEY` unset), balance rows of an unreachable network.
- **Swift models.** The Swift package is not generated from, nor checked against, this document yet.
- **The web app does not import the generated types yet** (`get<GetPortfolioResponse>('/portfolio')` is the intended use);
  wiring them is part of the web work.
- **The document is not served by the server.** It is a repository artefact (`docs/openapi/wallet-v1.json`).

Found while writing the contract, and left as they are (answers are additive only):

- `PUT /api/v1/settings` writes no audit event, so no `settings.*` event reaches the other devices when the language, the
  currency or the theme changes (only `settings.asset_pref` exists). Architecture decision 2 expects one.
- A text parameter containing a NUL character reaches PostgreSQL on the older routes and answers 500. The parameters added
  by NEXT (`q`, `network`, `asset`) refuse control characters at validation.
- Two operations answer two shapes: `GET /market/{symbol}` (no `currency` / `days` for an unknown symbol) and
  `security/overview.signer` (only `reachable: false` when the signer is down). `GET /transfers/{id}/status` has no
  `lifecycle`. `GET /events` omits `more` when `reset`.
- Naming is mixed in three places and cannot change: `created_at` next to `updatedAt` on a contact, `created_at` /
  `last_seen` on a session row, `depositKind` on a receipt next to `kind`.
- In `GET /activity` a receipt's `state` is `confirming` / `finalized`, while the CSV says `confirmed` in the `state` column
  for every receipt (kept; the appended `lifecycle` column tells the two apart).
