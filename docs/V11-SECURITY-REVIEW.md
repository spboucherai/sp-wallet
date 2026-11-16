# SP Wallet V11 — Security review notes

Sections are added by the work streams of V11 as they close a finding or decide not to. Each states what was checked in
the code, what was changed, and what remains.

## Spot mandate loss limit

Finding D3 of `docs/TRADING-AGENTS-AUDIT.md` (§8): the loss limit of a spot agent (`risk.maxLossPct`) is checked by the
engine only (`services/api/src/agents/engine.ts`, once per tick, on candle closes). The signer does not enforce it. The
derivative mandate has a signer-enforced floor (`floorEquity`, `services/isolated-signer/src/venue-mandate.ts`); the spot
mandate has none.

**Decision (V11 Phase B, branch `v11-stab-signer`): no signer-side loss floor was added for spot mandates. The engine-side
limit stays, and it now has an effect on the signer once it trips.** The reasons follow; none of them is "it is hard".

### What a signer-side floor needs, and what the signer has

A loss floor is a statement about the value of what the vault holds: `Σ balance(asset) × price(asset) ≥ floor`. The signer
must establish each of the three terms by itself, or the check is the API's word.

| Term | Does the signer read it independently today? | Evidence |
|---|---|---|
| Prices | Yes — Coinbase + Kraken, both must agree within 1 % (`services/isolated-signer/src/prices.ts`). Already used for the per-order value check of a spot mandate (`signer.ts`, `signDelegated`) | — |
| The floor | No. `Mandate` (`packages/core/src/mandate.ts`) has no such field; the capital the engine compares against is `agents.capital_usdc`, a number in the API's database that the passkey never signed | the mandate hash covers: vault, network, provider, assets, per-order and daily volumes, orders per day, slippage, dates, strategy hash, label |
| Vault balances | **No.** The signer makes outbound calls to three kinds of hosts only: the two exchanges (prices), Hyperliquid's public `/info` (the venue account, for derivative mandates) and THORNode operators (vault confirmation of a native swap) — `services/isolated-signer/src/main.ts`, comment above the `Signer` construction. It has no JSON-RPC client and no chain endpoint. Nothing it signs today depends on a chain read: nonces, gas and balances come from the API and are bounded by what the signer checks in the transaction itself | `grep -rn "fetch(" services/isolated-signer/src` finds three call sites (`prices.ts`, `venue-read.ts`, `vaults.ts`); `grep -rnE "eth_|rpc|jsonrpc"` finds nothing |

The venue floor works because the venue itself publishes the account value on an endpoint the signer pins and reads. For a
vault there is no such single reader: its balances are on a public chain.

### Why not add the chain read now

1. **It is a new trust assumption in the key-holding process.** The floor would be only as true as the balance the signer
   is told. One RPC endpoint that overstates the balance disables the floor silently; one that understates it stops the
   agent. A quorum of endpoints (as the API does: two must agree) turns this into "a majority of the configured providers is
   honest and reachable" — an assumption the signer does not make for anything else, about parties it does not otherwise
   talk to, and one more class of untrusted input (JSON-RPC answers) parsed by the process that holds the keys.
2. **It needs a new canonical mandate.** The floor must be a field the passkey signs (`SPW-MANDATE-v2`), with its bounds,
   its review-screen wording and a migration of stored mandates. Reading it from the API at signing time would be a check
   the API can switch off.
3. **A floor on one network's balances is not the vault's value.** A vault is the same address on every EVM network; funds
   the owner sent there elsewhere, or bridged, are part of what the owner has at risk and not of what a per-network read
   sees. The engine has the same limit; a signer-enforced control should not share it without saying so.
4. **A cheaper stand-in would be false.** The signer could keep a ledger of what it signed for the vault (amount in,
   guaranteed minimum out) and derive an "inventory". It does not know what the owner deposited, whether a signed order was
   ever broadcast or executed, nor what a fill really returned: the derived inventory is wrong in both directions, and a
   limit computed from it would either never trip or trip on nothing. It was not built.

### What bounds a spot mandate at the signer, without a loss floor

Unchanged, and enforced by the signer alone (`signer.ts` `signDelegated`, `packages/core/src/mandate.ts`):

- funds can leave the vault only to the owner's own address;
- every order is a swap between mandated assets, through the mandated router, delivering to the vault;
- the guaranteed output of every order must be worth at least `1 − maxSlippageBps` of the input at the signer's own
  prices: value cannot be handed to a counterparty through a bad price. The worst a caller can extract by churning is
  `maxSlippageBps × maxDaily` per asset and day, plus gas up to the fee ceiling per order, `maxOrdersPerDay` times;
- per-order and daily volume per asset, orders per day, expiry ≤ 90 days, the emergency halt.

New in this phase:

- **one active mandate per vault** (`approveMandate` refuses a second one: `conflict`): daily caps can no longer add up
  across mandates (D2);
- **a stopped agent has no mandate left** (D2): when the engine stops an agent — loss limit, strategy no longer the approved
  code, expiry — or the owner pauses or stops it, the mandate is revoked on the signer (`services/api/src/agents/live.ts`
  `revokeAgentMandate`); every engine pass revokes any mandate the signer still holds as active that no LIVE agent owns
  (`revokeStaleMandates`: a failed revocation, a lost approval answer). Before, the signer would have gone on signing for
  that vault for up to 90 days if asked.

### Residual risk, stated plainly

- **Market loss inside the mandate is not bounded by the signer.** An agent — or anything that controls the API — can
  hold or rotate the vault into mandated assets that fall. The engine's `maxLossPct` is checked once a minute on candle
  closes by the same API; a compromised API does not run it.
- The revocation on stop is done by the API. A compromised API that trips no limit revokes nothing. It protects against a
  buggy or restarted engine and a stolen session, not against a compromised API.
- The exposure is the vault's balance: the owner decides it by what he sends there. That, the 90-day expiry and the
  owner's own revocation (no passkey) are the outer bounds.

### If a signer-side floor is wanted later

The sound design, with its cost: `SPW-MANDATE-v2` with `floorValueUsd` (passkey-signed, shown on the approval screen); the
signer reads the vault's balances of the mandated assets from at least three independent RPC endpoints pinned in its own
bundle, requires agreement and a recent block, values them at its own prices, and refuses an order that is not a sale into
the cash leg while the value is below the floor (orders that reduce risk stay signable, as for derivative mandates). It adds
RPC providers to the signer's trust base and to its egress, and it must be reviewed as such — which is why it is a design
decision for the owner and not a fix slipped into a stabilisation phase.

## Execution through the trading API (Phase F)

Scope of the change: `services/api/src/{orders,risk,mandates}/`, the write handlers of
`services/api/src/trading-api/`, and three hooks in the venue engines (`derivatives/gate.ts`). **No file of
`services/isolated-signer` was changed.** The signer signs what it signed before, under the same rules.

### New attack surface

Before this phase no API key could make anything execute: the write operations answered 501. Now a key can,
with `SPW_TRADING_API_EXECUTION=on`:

- place live orders on Hyperliquid, without a passkey, when a trading mandate approved by the owner is bound
  to it;
- cancel its own orders;
- close or reduce positions on the accounts and instruments of its mandate;
- engage the global kill switch (`positions:manage`).

A key cannot, with any scope: reach a route outside `/api/v1/trading`; create, read, approve, alter or revoke
a mandate; change a limit; release the kill switch or read-only mode; approve an owner order; move
collateral; trade spot.

### What bounds a stolen key

**Without a mandate bound to it.** It can read what its scopes allow, cancel orders it placed itself (it has
placed none), and engage the kill switch if it holds `positions:manage`. Engaging stops new risk and nothing
else; the owner releases it with the passkey. It can execute nothing.

**With a paper mandate.** It trades the paper account, inside the mandate. No funds.

**With a live mandate.** It trades one Hyperliquid venue account. The bounds, from the strongest:

1. The isolated signer applies the derivative mandate it stores, from its own read of the venue account and
   its own prices: instruments, notional per order, position per instrument, gross exposure, leverage, orders
   per day and per hour, daily turnover, the floor on the account value, the price band, the expiry. A stolen
   key cannot change any of these and cannot exceed them, whatever the API does.
2. The trading key of the venue account signs orders, cancels and leverage changes only. It cannot withdraw.
   The worst outcome is a trading loss on that account down to the floor, plus what open positions lose before
   they are closed.
3. API-side: the key's own notional limits and restrictions, the full trading mandate (order types, daily
   loss, per-minute rate, stop conditions, fees), the owner's risk limits, the kill switch.
4. The key's expiry, its source-address list, its rate limit; revocation of the key or of the mandate by the
   owner's session, without a passkey.

A stolen key can make the account lose money inside the mandate. The mandate is the size of that risk, and
the owner chose it at the approval.

### Confused deputy

The order service acts for several principals with one set of engines and one signer secret. Points checked:

- **The principal comes from authentication**, never from the request: the body of an order has no principal
  field, and the canonical order is built server-side from `req.principal`.
- **The mandate id comes from the key row**, never from the request, and the mandate is loaded and matched
  to the principal at every order. A key bound to a mandate approved for another principal is refused.
- **Client order ids are derived from (principal, key)**: one principal cannot collide with, replay or
  overwrite another's order. A replay by another principal is `idempotency_conflict`.
- **Cancel** checks that the order's principal is the caller. **Close and reduce** are judged by the mandate
  check: account, venue, network and instrument must be the mandate's.
- **The approval of an owner order** is not reachable by a key: it is the existing route outside the trading
  prefix, and the signer verifies the passkey over the order hash.
- **The signer mandate records the principal** (`agentId`, `strategySha256`), and the Hyperliquid engine
  refuses a caller that presents another one. The signer itself cannot verify who calls.
- **One derivative mandate per venue account.** Two principals cannot share an account's mandate. The owner's
  own positions on that account are not distinguishable at the venue: a key may close a position the owner
  opened manually on the mandated account and instrument. A close only reduces.
- **`runCommand` is declared with the scope `orders:prepare`** and checks the scope of the operation the
  command resolves to in its handler. A mistake there would let a key with `orders:prepare` do more. The test
  "commands … the scope is the resolved operation's" covers each command type.

### A compromised API process

Unchanged from V10, and stated plainly: the API holds the single HMAC secret that authenticates it to the
signer. A compromised API process can call every signer endpoint that needs no passkey. For this phase that
means: it can place any order the stored derivative mandates allow, for any principal, whatever the trading
mandate's API-only fields, the owner's risk limits, the kill switch or read-only mode say — all of those are
enforced by the process that is compromised. It cannot exceed a derivative mandate, sign a manual order
without a passkey, withdraw collateral, or approve a mandate.

Phase F adds no signer endpoint and no signing power. It adds reasons for a derivative mandate to exist (an
API key can now have one), so more of them may be active.

### The review items after exec2 (2026-11-15): closed, changed or restated

Branch `v11-exec2`. **No file of `services/isolated-signer` was changed.** The list below takes the eleven items
of the list that follows it ("Items for human review …", kept as it was written), in its order, and says for
each what was done and what the evidence is. "Closed" means the concern no longer exists as stated; "changed"
means it was narrowed and a residual remains; "restated" means nothing changed and the statement was checked
again.

| # | Item | Status | What was done, and the evidence |
|---|---|---|---|
| 1 | The API-only fields of a live mandate are not covered by the passkey | **Changed** — residual below | The approval of a live mandate now takes a second passkey assertion, verified by the API, over an intent that names the FULL `tradingMandateHash` and the derivative mandate's hash (`SPW-TRADING-MANDATE-APPROVAL-v1`). Intent and assertion are stored (`trading_mandates.approval`) and verified again whenever the row is loaded for enforcement, for a key binding and by the supervisor (`MandateService.integrity`); a row that fails is unusable (403 `mandate_integrity`) and revoked, at the signer too. Tests: `execution-exec2-live.test.ts` "the sheet shows it; without the second assertion …" and "an approved mandate whose row is altered …" (an API-only field; the hash rewritten; the intent rewritten; the intent and its hash rewritten; the approval removed; another principal; the passkey removed; restored → usable; supervisor revocation reaching the signer); `execution-exec2-paper.test.ts` "a paper mandate whose stored row was altered is unusable". What it does and does not protect against: `TRADING-MANDATES.md`, "What the passkey signs" |
| 2 | The `strategySha256` convention for API keys | **Restated**, checked in the signer source | The signer stores and journals the field and never reads it for a decision: it is one of the hashed fields (`packages/derivatives/src/live/mandate.ts:75`), logged at approval (`services/isolated-signer/src/venue-mandate.ts:82`), and appears on no line of `venueMandateSign`. Only the Hyperliquid engine compares it with what the caller presents. With one principal per live account now refused at creation (item 8), a key's mandate and an agent's cannot coexist on an account. Pinned by `enforcement-pin.test.ts` ("the principal and the strategy hash are recorded, not verified") |
| 3 | Default-deny of live limits changes existing behaviour | **Changed** | The owner's own orders are judged on a one-time seed of the limits he had already approved before V11 (venue account policies and the venue authorization); six limits with no earlier equivalent stay absent and are named by the API and the Risk screen. API keys and agents stay deny-by-default. `V11-RISK-MODEL.md`, "Limits and defaults"; tests `execution-exec2-live.test.ts` "seedFromV10 (pure) …" and "a wallet that comes from V10 …". **For review:** the rule "minimum over the accounts", the fact that a policy set by a session before V11 Phase B (when loosening needed no passkey) is carried over as approved, and that GMX is not seeded |
| 4 | The kill switch is API-side | **Restated**, extended | Still API-side; release still verified by the API. New enforcement points: spot orders of the owner through the trading API, and spot agents' orders (a database trigger on `agent_orders`) — see the spot section of `V11-EXECUTION-ENGINE.md`. The automatic kill now has a test (`execution-exec2-live.test.ts` "the automatic kill (superviseAuto) …") |
| 5 | Exits pass `SPW_TRADING_API_EXECUTION=off` | **Restated**, narrowed | Unchanged by design. What an exit of a key can touch is narrower: only its own lot (item 8). GMX: a decrease and a cancellation pass under the kill switch and with `SPW_DERIV_GMX_LIVE` off, each with its own passkey (`execution-gmx.test.ts`, test 5) |
| 6 | Reads at evaluation time (rate budget) | **Changed** | The venue reads of a live book, the signer's status and the leverage setting are shared for 2 s between evaluations and dropped at once on any engine row change. `V11-RISK-MODEL.md`, "Venue reads are shared between evaluations"; test "rate budget: a preview and a creation share ONE read of the venue account …" (counts the venue's requests with the sharing on and off). **For review:** up to 2 s of staleness for changes made at the venue outside this wallet |
| 7 | Projection by database trigger | **Restated**, extended | Two more tables are projected the same way (swap proposals, spot agents' orders), and one trigger now REFUSES an insert (a spot agent's buy under the kill switch). `order_events` is still append-only by trigger |
| 8 | Two principals, one venue account | **Changed** | (a) A second principal on a live venue account is refused at creation and at approval with 409 `account_has_active_mandate` and the holder — a trading mandate or a perp agent's derivative mandate. (b) Position provenance: a key or an agent can close or reduce only what its own fills opened, never what the owner opened by hand nor another principal's part (`orders/provenance.ts`). Tests: `execution-exec2-paper.test.ts` "the ledger (pure) …", "a key cannot close, reduce or sell into what the owner opened by hand …", "a position the key opened and the OWNER then closed by hand …"; `execution-exec2-live.test.ts` "one principal per live venue account …". **For review:** the ledger's rules (an unattributed fill is the owner's; a shortfall is taken from keys first) and the fact that it is API-side — the signer signs any reduce-only order inside the mandate |
| 9 | A preview shows whether funds suffice | **Restated** | Unchanged: `orders:prepare` still reveals the equity and free collateral of the account an order names. Not changed here because the answer shape belongs to the contract workstream; the options are to require `wallet:read` for those two fields or to drop them for a key |
| 10 | Reuse of a decision by the engines' gate | **Closed** | The reuse key is now the whole engine request (type, price, trigger price, time in force, network and leverage setting were added to account, instrument, side, size, reduce-only); a decision without an engine request (a preview) is never reused. Test "the engines' gate reuses the decision … only for the very same engine request" (nine variants, each evaluated again; under a limit the altered order breaks, it is denied; a decision older than 60 s is not reused) |
| 11 | Not verified against the real venue | **Restated** | Still true. Every test of this branch runs against scripted venues, fixtures, the paper engine and the real signer class in process |

`runCommand` (listed under "Confused deputy" above): **closed.** The scope and mandate check of a command is now
one function (`CommandGrant.authorize`) that every executor needs a grant from; the operation table and the
executor table are exhaustive over the command kinds at compile time. Test: `execution-exec2-paper.test.ts`
"every command kind against every scope …" (12 lines × dry-run and not × 12 scopes: only the scope of the
resolved operation opens a command, and nothing of the wallet is touched before the guard).

**The signer-enforcement tables were written from second-hand descriptions in Phase F.** They were checked
against the signer's source here and corrected (`V11-RISK-MODEL.md`, "Enforcement points"; `TRADING-MANDATES.md`,
"Where the signer enforces each row"), and `enforcement-pin.test.ts` now asks the real signer directly, with no
API check in front of it.

#### New items for human review (introduced by exec2)

1. **Proposal, not implemented (needs a signer change): `tradingMandateSha256` in `SPW-VENUE-MANDATE-v1`.**
   Add the field to the schema and to `venueMandateBytes` (so that it is part of the hash the passkey signs at
   the signer), log it in `venue.mandate.approved`, expose it in `status().venueMandates`. The signer would not
   enforce the API-only fields, but: one passkey prompt would commit to everything; the commitment would be
   held by the signer, out of reach of a compromised API or of someone who can rewrite the API's `credentials`
   table; and the API could compare its row with the signer's record instead of with its own. It changes the
   canonical bytes of a mandate: a version bump (`SPW-VENUE-MANDATE-v2`) or an optional trailing field, to be
   decided with the migration of stored mandates. Until then the API-side binding of item 1 is what exists.
2. **The full-hash binding is verified by the API against its own passkey table.** It defeats alteration of the
   mandate row by anything that cannot produce a passkey assertion. It does not defeat a compromised API
   process, nor someone who can also write the `credentials` table. A mandate approved with a passkey that is
   later removed becomes unusable and is revoked.
3. **Provenance is bookkeeping.** It depends on the fills the wallet stored. A fill not yet published makes a
   key wait; a fill never attributed counts as the owner's. Perp agents place live orders through the
   Hyperliquid engine directly and are not bound by it (they hold the account alone, by item 8).
4. **GMX equity in the risk book** is now the wallet's USDC on Arbitrum plus position margin and PnL (it was
   position margin only, which made every first GMX increase fail the leverage, concentration and drawdown
   checks). It changes the leverage and collateral-share figures of a book that contains GMX.
5. **Live GMX orders are reachable through the trading API by the owner's session** (one passkey each, the
   engine's locks unchanged). Keys and agents are refused.
6. **The seed of the live limits** (item 3 above).
7. **Shared venue reads** (item 6 above).

### Items for human review before `SPW_TRADING_API_EXECUTION` is enabled

(The list as written at the end of Phase F. Its status after exec2 is the table above.)

1. **The API-only fields of a live mandate are not covered by the passkey.** The passkey signs the hash of
   the compiled derivative mandate. Order types, the daily-loss limit, the per-minute rate, the fee cap, the
   stop conditions and the label are bound only by the API's immutable row and its audit event. A session
   thief cannot alter an approved mandate, but nothing cryptographic ties these fields to the approval.
   *Proposal, not implemented (it needs a signer change):* add `tradingMandateSha256` to
   `SPW-VENUE-MANDATE-v1`, part of its hash, recorded by the signer for the audit trail like `strategySha256`.
   The signer would still not enforce those fields.
2. **The `strategySha256` convention for API keys.** The field now carries a principal descriptor hash for a
   key. Confirm that nothing downstream reads it as a code hash (the perp-agent engine compares it with its
   own strategy hash; a key's mandate and an agent's mandate cannot be confused because `agentId` differs and
   one account holds one mandate).
3. **Default-deny of live limits changes existing behaviour.** After deployment, manual live orders and live
   perp agents open no new risk until the owner sets the live limits. Reductions and cancels are not
   affected. Decide whether to set the limits before or right after the deployment.
4. **The kill switch is API-side.** It does not replace the signer's halt. A release needs the passkey, but
   it is verified by the API (`verifyOwnerAssertion`), as in Phase B.
5. **Exits pass `SPW_TRADING_API_EXECUTION=off`.** A cancel and a strictly reducing order are not stopped by
   the switch, by design (a lock must not strand a position). With the switch never turned on, no key has a
   live position or order of its own to act on; the owner's exits go through the passkey as before.
6. **Reads at evaluation time.** One live order makes the API read every authorized venue account of the
   book, twice (once before the order exists, once on the stored order). Check the venue's rate budget with
   several accounts or a busy key.
7. **Projection by database trigger.** The triggers on `deriv_orders` and `deriv_gmx_ops` add one insert per
   engine write. `order_events` refuses updates and deletes: a restore or a manual repair of that table needs
   the trigger dropped first.
8. **Two principals, one venue account.** A live API-key mandate takes the account's single mandate slot. A
   perp agent cannot be live on the same account at the same time.
9. **A preview shows whether funds suffice.** `POST /orders/preview` (scope `orders:prepare`) returns the
   equity and free collateral of the account the order names and the engine's estimate. A key that may
   prepare orders therefore learns those two figures without `wallet:read`.
10. **Reuse of a decision by the engines' gate.** An order the order service has just evaluated is not
    evaluated again by the engine's gate: the gate finds the decision by client order id, within 60 s, and only
    when it is for the same mode, venue, account, instrument, side, size and reduce-only flag
    (`risk_decisions.fingerprint`). An order given as a notional is evaluated twice.
11. **Not verified here:** behaviour against the real Hyperliquid testnet or mainnet. Every live test runs
   against the scripted venue of the test suite and the real signer class in process.

## Live market making

Integration of the quoting mandate (`docs/V11-MARKET-MAKING.md`, `docs/v11/work/mm-live.md`), 2026-11-16. Nothing in this
section was ever run against a real venue: every proof is on the venue double of the test suite with the real signer class
in process, on a recorded public tape. No real key, no funded account, mainnet or testnet.

### Signer behaviour changes (for human review)

The signer source was NOT modified by the integration; the nine changes below are the foundations' (branch `v11-mm-core`),
re-read here against `services/isolated-signer/src/venue-quoting.ts`, and now REACHABLE from the running service:

1. A new mandate kind, `SPW-VENUE-QUOTING-MANDATE-v1`, approved by the same passkey ceremony (`POST /venue/quoting/approve`);
   refused under the halt, without a live `MANUAL_LIVE` authorization, beyond the authorization or the compiled bounds.
2. A seventh path that signs without a per-operation passkey (`POST /venue/quoting/sign`, trading key): ADR 0001 row 7.
3. Two new action kinds signed by the trading key, on that path only: an `order` action with more than one order (≤ 20, one
   instrument, homogeneous) and `scheduleCancel`. `/venue/sign` and `/venue/mandate/sign` still answer `unsupported`.
4. Quotes do not count against the authorization's `maxOrdersPerDay`; they are bounded by the mandate's own persisted rates.
5. `venueMandateApprove` (directional) is refused with `conflict` while a quoting mandate is active on the authorization.
6. A new outbound request of the signer: `orderStatus` on the pinned info hosts.
7. New optional state: `venueQuotingMandates`, and `q: 1` on ledger entries created by quotes. **Rollback rule: revoke every
   quoting mandate before rolling the signer back** (`docs/runbooks/deploy.md`).
8. Journal records `venue.quoting.*`: one per signed action — several per second at the compiled maximum.
9. `GET /status` gains `venueQuotingMandates[]`.

### API behaviour changes (for human review)

1. `trading_mandates` rows may carry a quoting section; `MandateApprovalIntent` gains `quotingSectionHash`; the integrity
   check covers the section; a quoting mandate is approved and revoked at the signer's quoting endpoints.
2. Exclusivity is refused API-side with `quoting_excludes_directional` / `directional_excludes_quoting`, checked BEFORE the
   compilation (a directional creation on an account under a quoting mandate now answers that code first).
3. Family `market_making` has a `live` mode (`FAMILY_MODES`), for one pinned instrument on Hyperliquid (`liveVerdict`).
4. PAPER market making no longer goes through the order gateway: it runs the quoting engine on a simulated venue account
   (`mm/paper-venue.ts`); its quotes are not `agent_order_intents` rows any more, and its prices are on the venue's own grid
   (Hyperliquid: 5 significant figures — the previous paper path quoted prices the real venue would have refused).
5. The stream pass also ticks market-making agents in `LIVE` and `STOPPING`, and paused or stopped ones while a session of
   theirs is still open (so that its shutdown completes).
6. `stopAgent` of a live market-making agent revokes its quoting mandate and leaves the agent `STOPPING` until the session
   has cancelled and removed the switch; a repeated stop of a stream agent in `STOPPING` is a no-op.
7. `LiveService.setStepPacing`: the live engine's background reconcile of a venue account is paced to 60 s while a quoting
   session runs on it (its reads cost the IP weight the session needs). Fills and funding of that account are stored up to
   60 s later during a session; orders placed through the live engine are reconciled when placed, as before.
8. `MandateService.supervise` reads the equity of a quoting mandate's account once a minute instead of at every pass.
9. `orders/provenance.ts`: fills are replayed by (time, stored sequence, fill id); a fill carrying a quoting session's
   client-id prefix is the agent's. `deriv_fills` gains the column `seq`.
10. New owner routes `/api/v1/mm/*` and `POST /api/v1/mandates/recover-quoting`; two capability ids; six alert kinds.
11. The engine counts only the fills of ITS session (`lastFillsAt` starts at the session's start): the account's earlier
    history — the venue's `userFills` snapshot, `userFillsByTime` from 0 — is no longer attributed to a new session.

### What a compromised API can do under an active quoting mandate, and what bounds it

It holds the HMAC secret; it can ask for the four action kinds at will, and nothing else (no transfer, withdrawal, leverage
change, agent approval, builder or vault field — refused by the strict action reading of the signer).

| It can | Bounded by (signer check) |
|---|---|
| place quotes it knows will be picked off | every quote is `Alo`, on its own side of the signer's own mid, at least `minHalfSpreadBps` away, at most `maxDistanceBps`; `maxQuoteNotional` each; resting count and notional per side |
| build inventory through fills | worst-case inventory per instrument and gross, from the signer's own venue read plus everything it signed that can still land; `floorEquity`; the leverage setting |
| unwind badly | a reduce-only order is within `maxReduceDeviationBps` of the signer's mid and ≤ `maxQuoteNotional`; it cannot flip a position (the venue enforces reduce-only) |
| repeat | token bucket, quotes per hour and per day, daily turnover — persisted; a restart refills nothing; the mandate ends after ≤ 7 days |
| not send the `scheduleCancel` it obtained | nothing — see below; it gains nothing beyond the above (its own quotes are the ones left uncovered) |
| burn the address rate limit and grow the journal with cancels and reductions | nothing: stopping is never metered (as with the directional mandate) |

Loss per round trip ≈ (staleness of the signer's mid + the reduce band) × inventory, repeated inside the rates until the
account value reaches the floor, where openings stop. The floor, the inventory and the rates are the owner's choices in the
mandate; the compiled ceilings (20 000 USD of inventory, 2 000 000 USD of daily turnover) are a backstop, far above the
wallet's stated scope. What does NOT bound it: every API-only row of the enforced-by table (circuit breakers, session
hours, the session loss limit, the engine's soft and hard limits, the quote size below the signer's ceiling, the policy).

### Residual risks of the dead man's switch

1. The signer knows it SIGNED a `scheduleCancel`, not that the venue TOOK it; no info request exposes the scheduled time.
   The rule binds the honest engine that crashes — the realistic failure — not a malicious API.
2. Up to `deadManSeconds` (≤ 120 s; the tests use 30 s) of unmanaged quotes at their last prices after a crash; the loss is
   bounded by the resting notional per side and the move in that time. A worker's lease lasts 30 s: with
   `deadManSeconds` ≤ 30 the venue cancels before another worker can take the agent.
3. If the venue itself halts, the switch does not fire until it resumes.
4. The venue allows 10 triggers a UTC day; the signer stops opening at 8 presumed lapses. A crash loop spends them: after 8,
   no quote until 00:00 UTC (alert `agent.mm_dead_man_switch` at every lapse).
5. With the signer down NOTHING can be signed — not even a cancel. The switch is then the only thing that cancels; it must
   already be armed, which the signer's own rule guarantees for every quote it signed.
6. Clock skew between the engine, the signer and the venue is covered only by the 2 s and 6 s margins.

### Not verified on a real venue

All of these are assumptions taken from the venue's documentation and must be observed on TESTNET by the owner before any
mainnet session (the go-live checklist's testnet step, `docs/V11-MARKET-MAKING.md`):

- **`scheduleCancel` replacement semantics**: that a new time REPLACES the previous one (not stated by the documentation). If
  the earliest time won, the switch would fire early: a nuisance and a trigger, not a loss.
- **Trigger counting**: that the count increments when the switch fires with nothing resting, and resets at 00:00 UTC.
- **Duplicate-cloid behaviour**: whether the venue refuses a client order id that was used before (the signer refuses a
  client id that is live in its ledger or open on the venue; the engine never reuses one).
- **Info lag**: how long after an accepted order `frontendOpenOrders` lists it, and how the `orderUpdates` stream orders
  itself relative to the HTTP answer (the reconcile lists an order from the answer and never lets a final state be left).
- **`expiresAfter` rejection**: that an action past its `expiresAfter` is refused (the signer's ledger relies on it + 10 s),
  and that it costs 5× the address rate limit.
- The `orderUpdates` message shape on a trading account (parsed from the documented `WsOrder[]`; only the public `userFills`
  snapshot frame could be recorded without an account that trades), queue position, latency, the real cost in IP weight.

### Items for human review before `SPW_DERIV_MM_MAINNET` is enabled

1. The nine signer changes and the eleven API changes above.
2. `withinBand` (runtime): it rewrites a rule's quote prices to stay inside the mandate's band. It can only move a quote away
   from the mid or back inside the maximum, and the signer still judges every quote — but it IS a place where the engine
   changes what the rule asked.
3. The owner's "pull" / "flatten" when no worker runs the session (`MmRuntime.emergency`): a short session in the API process
   under the agent's lease. It never quotes (the instruction is set before the first cycle); review that claim in the code.
4. The risk engine's decision reuse for quotes (30 s per side, size and inventory lot) and the choice of `preview: true`.
5. The budget's estimate of the signer's requests (peak of the simulated hour: 878 of 1 200 per minute, held under the
   engine's own ceiling of 900 by the 300-weight reserve) — and whether the signer should cache its leverage read.
6. Paper evidence comes from a fill model (trade-through on top of book) that under-counts fills and ignores queue position.

