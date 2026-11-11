# SP Wallet V6 — derivative mandate (`MANDATE_LIVE`) on Hyperliquid, as built

The mode in which an approved automated strategy places perpetual orders **without a passkey per order**, inside limits that
the isolated signer stores and enforces by itself after **one** passkey approval. It ships **disabled** and testnet-first:
nothing exists until the owner approves a venue authorization (`MANUAL_LIVE`, docs/v4) and then a mandate; mainnet needs two
server settings. Manual mode is unchanged: on an account that holds a mandate, manual orders still need the passkey.

Code: canonical mandate and the exposure bound `packages/derivatives/src/live/mandate.ts`; signer
`services/isolated-signer/src/{venue-mandate,venue-read}.ts`; engine `services/api/src/derivatives/exec.ts` (methods at the
end of `LiveService`), `mandate.ts` (interface for the agent runtime), `live-texts.ts`; proof
`services/isolated-signer/test/venue-mandate.test.ts`, `services/api/test/derivatives-mandate.test.ts`,
`scripts/hl-mandate-testnet.mts`.

## 1. The mandate object (`SPW-VENUE-MANDATE-v1`)

```ts
VenueMandate { v: 1, mandateId, authorizationId,            // the MANUAL_LIVE authorization it extends
  keyId, venue: "hyperliquid", network, account, agentAddress,   // must equal the authorization's
  strategySha256, agentId,                                  // audit only: recorded, not verifiable by the signer
  instruments: [{ instrument, maxLeverage, maxPositionNotional }],   // ⊂ the authorization's; 1…8
  maxOrderNotional, maxGrossExposure,
  maxOrdersPerDay /* ≤ 500 */, maxOrdersPerHour /* ≤ 60 */, maxDailyTurnover,
  floorEquity,                                              // required, > 0
  maxPriceDeviationBps, createdAt, expiresAt /* unix s, ≤ 30 days, ≤ the authorization's expiry */, ackSha256 }
```

Hash: SHA-256 of the length-prefixed (name, value) pairs in the fixed order of `venueMandateBytes` (instruments sorted,
decimals canonical). The passkey assertion's challenge is that hash. The jurisdiction acknowledgement hash is committed again.

Approval (`POST /venue/mandate/approve`) is refused unless: the signer holds the authorization, unrevoked, unexpired,
`MANUAL_LIVE`; every limit is ≤ the authorization's (instruments, leverage, order, position, gross, orders per day, price
band); hard ceilings hold (30 days, 60 orders an hour, 500 a day, 8 instruments, leverage ≤ the pinned venue maximum);
order ≤ some position limit ≤ gross; order ≤ daily turnover; the acknowledgement hash is a known text; no other mandate is
active on that authorization; the id is new; the emergency halt is off; the passkey assertion verifies. Nothing is signed by
any key at approval and nothing is sent to the venue.

## 2. What the signer enforces by itself on `POST /venue/mandate/sign` (no passkey)

Everything is decided from the signer's stored mandate and authorization, its own `describe()` of the payload (pinned asset
table), its own prices (Coinbase + Kraken, `prices.ts`) and its own read of the venue account (`venue-read.ts`). The API's
description of the order (`context.order`) is optional and only has to agree with the payload (`mismatch` otherwise).

| Action | Signed when |
|---|---|
| cancel | authorization alive, mandate not `ended`, instrument in the authorization. Also under the emergency halt and during the wind-down. |
| reduce-only order | same + instrument in the mandate, notional ≤ `maxOrderNotional`, every price and trigger within the band of the signer's own price, client id never signed, one order per action, venue expiry ≤ 120 s, nonce rules. **No venue read, no counter**: closing stays possible when limits are used up, when halted, when the venue cannot be read, below the floor, and during the wind-down. |
| order that can add exposure | all of the above + mandate `active`, emergency halt off, orders today < `maxOrdersPerDay` (mandate **and** authorization — manual and mandate orders share the authorization's daily count), orders in the last hour < `maxOrdersPerHour`, turnover today + notional ≤ `maxDailyTurnover`, **the signer's own venue read succeeds and is fresh and consistent**, account value ≥ `floorEquity`, the venue's leverage setting of the instrument ≤ the mandate's, worst-case position ≤ `maxPositionNotional`, worst-case gross ≤ `maxGrossExposure`. |
| leverage change | mandate `active`, halt off, instrument in the mandate, leverage ≤ the mandate's, ≤ 20 a day, venue read succeeds, and — if a position is open on the instrument — the margin mode does not change. |

Counters, the client id, the nonce and the exposure ledger are written to disk before the signature is returned. Every
refusal is journaled (`venue.mandate.sign.denied`) with a stable code:

`not_found, no_authorization, revoked, expired, wind_down, halted, bad_request, wrong_venue, rejected, unsupported, policy,
expired_action, stale_nonce, replay, mismatch, instrument, order_notional, price, no_price, orders_day, orders_hour, turnover,
venue_unreachable, venue_stale, venue_inconsistent, unpriced_position, floor_equity, leverage_setting, position_exceeded,
gross_exceeded, leverage_exceeded, leverage_rate, margin_mode` (the API relays them as `signer_<code>`).

## 3. The exposure bound — design (b), and why

The brief offered (a) pure conservative counters reset only by a passkey, or (b) the signer reading positions from the
venue's public info endpoint. **(b) is implemented.** (a) is sound but unusable: a counter that only grows makes every closed
position consume the limit for ever, so a strategy stops after a few trades and the owner is asked for a passkey to "rebase"
— which defeats the mandate and trains the owner to approve resets. (b) adds one trust: the venue's info endpoint, for the
size of positions, resting orders and the account value. The venue already holds the funds and executes the orders: a venue
that lies about positions can do worse without the wallet. The API is still not trusted for anything.

**The bound.** Before signing an order that can add exposure, the signer computes, per instrument,

    long  = max(position, 0) × P  +  Σ over buys  of  size × max(order price, P)
    short = max(−position, 0) × P +  Σ over sells of  size × max(order price, P)
    worst(instrument) = max(long, short)          gross = Σ over instruments of worst

where `position` is the signed size the signer read from the venue, `P` the signer's own price, and the orders are: (1) every
non-reduce-only order resting on the venue (the venue's list — whoever placed it), (2) every non-reduce-only order this
signer signed for the account, manual or mandate, until its venue expiry + 10 s (the *ledger*), (3) the candidate. It signs
only if `worst(candidate's instrument) ≤ maxPositionNotional` and `gross ≤ maxGrossExposure`.

**Why it is an upper bound.** Take any subset of those orders that fills. If the position ends long, its size is at most
the present long size plus the buys that filled, i.e. ≤ long/P; symmetrically for short. Reduce-only orders are left out
because the venue never lets one increase a position or open the opposite side. An order can only be accepted by the venue
before its `expiresAfter` (≤ 120 s, the engine uses 30 s for mandate orders; the venue enforces it and it is part of the
signed hash), so after expiry + grace an order is either visible in the venue's state (position or resting order) or dead.
The order list is read before the account state, so an order that fills between the two reads is counted twice, not zero
times. Opposite-side non-reduce-only orders never reduce the bound (long 280 with a pending sell of 280 still counts 280
long, and 280 short).

**Deliberate over-counting.** A market order that fills is counted in the position and stays in the ledger until its expiry
+ grace (≤ 40 s with the engine's 30 s): two market orders in quick succession are throttled. A resting order is counted
once: a ledger entry is dropped when the venue lists a resting order with the same client order id **taken by the venue after
the signer signed it** (a client id is signed once in three days, so an older order carrying the same id is not mistaken for it).

**What the bound does not cover.** It holds *when the order is signed, at the signer's price of that moment*: a position can
grow in value afterwards with the market. Exposure opened outside the wallet through channels that are neither positions nor
resting orders in `frontendOpenOrders` (e.g. a TWAP started in the venue's interface) is not seen until it becomes a position.
Positions on instruments the signer cannot price (outside the pinned table) stop every exposure-adding order
(`unpriced_position`) rather than being valued at the venue's price.

**Fail closed.** The read is refused, and nothing that can add exposure is signed, when: the request fails, times out, is
redirected, is larger than 400 kB, or does not have exactly the expected shape (`venue_unreachable`); the venue's own
timestamp is more than 30 s from the signer's clock (`venue_stale`); two positions on one coin, Σ position values ≠ the
venue's own `totalNtlPos` (0.1 % + 0.01), or the venue's valuation of a position differs from the signer's price by more than
the mandate's band (`venue_inconsistent`).

**Loss limit.** `accountValue` (the venue's mark-to-market account value, same read) below `floorEquity` → only cancels and
reduce-only orders. It is a floor, not a guarantee: the value can gap below it between two orders, and it is the venue's number.

**Leverage.** Hyperliquid keeps a leverage *setting* per asset. The signer refuses an exposure-adding order while the
venue's setting for the instrument is above the mandate's (read from the position, or `activeAssetData`), and signs
`updateLeverage` only at or below it. A new account is at 20× cross: the engine lowers it first (`setMandateLeverage`).

New outbound host of the signer: `api.hyperliquid.xyz` and `api.hyperliquid-testnet.xyz`, `POST /info` only
(`clearinghouseState`, `frontendOpenOrders`, `activeAssetData`). The signer never calls `/exchange`.

## 4. Stopping and the wind-down

| Event | New exposure | Leverage change | Reduce-only orders | Cancels |
|---|---|---|---|---|
| limit reached, floor breached, venue unreadable | no | — | yes | yes |
| signer emergency halt | no | no | yes | yes |
| owner halt / divergence (API) | no (API) | no (API) | yes | yes |
| mandate revoked or expired, first 24 h | no | no | **yes** | **yes** |
| after the 24 h wind-down | no | no | no (mandate) | yes, through the authorization (`/venue/sign`, no passkey) |
| authorization revoked or expired | no | no | no | no |

Decision and reasons. Revoking a mandate must stop risk-taking at once, but it does not close positions; leaving positions
that nothing can close automatically is the more dangerous state. So revocation and expiry stop **new** exposure
immediately and for good, and for a bounded 24 h (`VENUE_MANDATE_WIND_DOWN_S`) the signer still signs cancels and
reduce-only orders, which can only shrink exposure — at prices inside the band of the signer's own price. The worst a
compromised API can do with the wind-down is close the owner's positions up to the band away from the market. The
authorization stays the hard stop: revoking **it** ends everything at once, as before, and the owner can always close
manually with his passkey while it lives. A mandate cannot outlive its authorization; for a full wind-down after expiry,
choose a mandate expiry at least 24 h before the authorization's. A revoked mandate is never re-activated.

## 5. Engine (API)

`deriv_mandates` holds the canonical mandate; the account keeps `mode: "MANUAL_LIVE"` and gains `modes` (`["MANUAL_LIVE",
"MANDATE_LIVE"]` while a mandate is active) and `mandate`. Routes and shapes: docs/v4/API-LIVE-NOTES.md ("MANDATE_LIVE").
There is **no HTTP route that places a mandate order**: only code inside the API process can (`mandate.ts`).

A mandate order goes through the manual pipeline: pinned-table check → live ticker/book + the venue's real account state →
`checkOrder` with the account's API-side policy tightened by the mandate (never wider than either) → stored order
(`origin: "mandate"`, `mandate_id`, `agent`) → signer (`/venue/mandate/sign`) → venue → reconciliation by client order id.
`unknown` is resolved only by the venue; after the signature's venue expiry (30 s) + 5 s, "no such order" is final. Owner
halt and divergence stop mandate orders that can add exposure (reduce-only orders that reduce still pass). Mainnet needs
`SPW_DERIV_LIVE_MAINNET=on` **and** `SPW_DERIV_MANDATE_MAINNET=on` (both default off, both read at every use): without the
second, `403 mandate_mainnet_disabled` on prepare, approve, place and leverage.

### Interface for the agent runtime — `services/api/src/derivatives/mandate.ts`

```ts
placeMandateOrder(accountId, req: OrderRequest, ctx: { strategySha256, agentId, clientId }): Promise<{ order: LiveOrder, idempotent: boolean, estimate: Estimate | null }>
cancelMandateOrder(accountId, clientId): Promise<{ order: LiveOrder, sent: boolean, venue?: { outcome, error } }>
mandateOrder(accountId, clientId): Promise<LiveOrder | null>            // reconciled now
setMandateLeverage(accountId, { instrument, leverage, marginMode }, { strategySha256, agentId }): Promise<{ action: LiveAction, venue: { leverage, confirmed, source: "venue" } }>
mandateAccountState(accountId): Promise<{ accountId, venue, network, account, mode, modes, mandate, canOpen, canReduce, blocked: { code, message } | null,
  halted, divergence, state: AccountState | null, positions: Position[], openOrders: Order[], error: string | null, ts, source: "venue" }>
mandatePositions(accountId): Promise<Position[]>                         // throws venue_unavailable when unreadable
```

- `req.price` is required (limit price, or the worst acceptable price of a `market` order); `req.clientId` is ignored —
  the idempotency key is `ctx.clientId` (8–100 chars `[A-Za-z0-9._:-]`). Same key = same order, never a second one.
- `ctx.strategySha256` / `ctx.agentId` must be the mandate's (`mandate_mismatch`).
- A venue refusal is `order.state === "rejected"` (not an exception). A risk or signer refusal throws `UserError` (`code`,
  `status`) and is stored as a `rejected` order + a risk event: `mandate_none`, `mandate_mismatch`, `mandate_wind_down`,
  `mandate_floor_equity`, `halted`, the risk engine's codes, `signer_<code>`, `mainnet_disabled`,
  `mandate_mainnet_disabled`, `mode_read_only`, `authorization_expired`, `asset_table_mismatch`, `venue_unavailable`.
- Orders signed in quick succession: see "deliberate over-counting" (wait ≈ 40 s after a market order before using the
  whole position limit).

## 6. Proof

- Signer rules, each just inside / just outside, adversarial sequences, the venue-read path with a fake behind the real
  reader: `services/isolated-signer/test/venue-mandate.test.ts`.
- Engine and state machine with the scripted exchange fake, kill switch, wind-down, both mainnet locks, the fixes:
  `services/api/test/derivatives-mandate.test.ts`.
- Testnet, unfunded, 2026-11-11 06:04 UTC (`npx tsx scripts/hl-mandate-testnet.mts --record`, recorded in
  `packages/derivatives/test/fixtures/hyperliquid/testnet-mandate-proof.json`, replayed by
  `test/hyperliquid/mandate-proof.test.ts`): the signer read the testnet account itself (`accountValue "0.0"`, timestamp
  371 ms from its clock); under the mandate and without a passkey it signed `updateLeverage`, a reduce-only `order` and
  `cancelByCloid`, each answered `{"status":"err","response":"User or API Wallet 0xc174…0682 does not exist."}` — the venue
  recovered our trading key, so its hash (30 s expiry included) equals ours; the order that could add exposure was refused
  by the signer (`floor_equity`). 5 requests to the testnet exchange endpoint, none to mainnet.

## 7. Not verified

- Anything on a funded account: a mandate order resting, filling, the position bound against real fills, the leverage read
  (`activeAssetData`) of an account with history, `setMandateLeverage` confirmed by the venue. The funded path of the script
  is written and has never run.
- That the venue rejects an action after `expiresAfter` (documented; the bound relies on it) and how long its info
  endpoint may lag behind an accepted order (the grace is 10 s).
- That `marginSummary.totalNtlPos` equals Σ `positionValue` on every account type (true on the recorded mainnet fixture;
  accounts under "unified account" / portfolio margin, sub-accounts, vaults and HIP-3 dexes are not handled).
- That the venue's `timestamp` of a resting order is its acceptance time on the venue's clock (used to match a resting
  order to a signed one, with 60 s of tolerance).
- Rate limits of the info endpoint from the signer's IP under real use (two to three requests per exposure-adding order).
- Mainnet: nothing was ever sent to it.
