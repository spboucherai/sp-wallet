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

### Items for human review before `SPW_TRADING_API_EXECUTION` is enabled

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
