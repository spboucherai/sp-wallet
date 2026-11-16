# V11 — Exchange integrations

One chapter per perpetual venue: initial state, API used, what is implemented, tests run, observed results, limitations.
Every figure below was measured or read on the date given; nothing is extrapolated.

- [edgeX](#edgex) — written 2026-11-15 (branch `v11-edgex`)
- [Hyperliquid](#hyperliquid) — placeholder, to be filled by its own work stream
- [GMX](#gmx) — placeholder, to be filled by its own work stream
- [dYdX](#dydx) — placeholder, to be filled by its own work stream

---

## edgeX

**Status: READ-ONLY market-data venue. Trading and account access are UNAVAILABLE, by decision, because of jurisdiction.**

### 1. Decision and its reason

edgeX's Terms of Use (<https://edgex-1.gitbook.io/edgeX-documentation/about/terms-of-use>, help-center copy last updated
2026-10-04, read 2026-11-15) name Canada as a blocked jurisdiction:

> "THE edgeX INTERFACE (AS DEFINED BELOW) IS NOT AVAILABLE TO PERSONS OR ENTITIES WHO RESIDE IN, ARE LOCATED IN, ARE
> INCORPORATED IN, OR HAVE A REGISTERED OFFICE IN THE UNITED STATES OF AMERICA OR CANADA (COLLECTIVELY, "BLOCKED PERSONS"). …
> WE DO NOT MAKE EXCEPTIONS … USE OF A VIRTUAL PRIVATE NETWORK ("VPN") TO CIRCUMVENT THE RESTRICTIONS SET FORTH HEREIN IS
> PROHIBITED."

> "12.1 … no Blocked Person may enter into Perpetual Contracts using the Services."

The wallet's owner is in Québec. The project already has a rule for this case, written for dYdX: *market data only, never
work around* (`docs/v4/venues/jurisdiction.md`). edgeX is integrated under the same rule:

- no edgeX account is created or read; no private endpoint is called; no request is signed;
- no order-building, order-signing or order-submission code exists for edgeX anywhere in the repository;
- trading appears in the product as **unavailable, with the reason**, in French and in English — never simulated (no paper
  account either), never a disabled-looking success;
- nothing works around the restriction (no VPN, no proxy, no alternative path).

This is general information about what the venue's terms say, not legal advice.

### 2. Initial state (before this work)

- Three venues: `hyperliquid`, `dydx`, `gmx` (`VENUE_IDS`, `packages/derivatives/src/models.ts`). No edgeX code, no edgeX
  mention outside the research dossier `docs/v11/research/edgex-api.md`.
- A read-only venue pattern existed (dYdX): adapter + registry entry with a `restriction` text + FR translation + web texts.
- `Instrument` had no notion of what the underlying is; `Ticker` had no last price, no base volume, no next funding time.

### 3. API used

Only public endpoints **verified live on 2026-11-15**, plain GET, no header, no key (dossier §1). The field tables of the
official docs do not match the live answers; the adapter follows the live shapes, recorded as fixtures.

| Purpose | Host and path | Notes |
|---|---|---|
| Instruments | `GET https://edgex-prod-v2.edgex.exchange/api/v2/public/meta/getMetaData` | 413 kB; 195 contracts, 157 displayed. Contract id ↔ name is resolved from here at run time, never hard-coded |
| Category tabs | `GET …/api/v2/public/contract-labels` | **undocumented** (seen in the web app, live). Optional: the adapter works without it. Only the `PrepV2` tabs are read |
| Ticker | `GET …/api/v2/public/quote/getTicker?contractId=` | one contract per call (no id, or a list, answers an empty array). REST fallback only |
| Order book | `GET …/api/v2/public/quote/getDepth?contractId=&level=15\|200` | no other level exists |
| Candles | `GET …/api/v2/public/quote/getKline?contractId=&klineType=&priceType=LAST_PRICE&size=&offsetData=` | newest first, ≤ 1000 per page |
| Funding | `GET …/api/v2/public/funding/getFundingRatePage?contractId=&size=100&filterSettlementFundingRate=true&offsetData=` | settlements only, newest first |
| Stream | `wss://edgex-quote-prod-v2.edgex.exchange/api/v1/public/ws` | channels `ticker.{id}`, `ticker.all.1s`, `depth.{id}.15\|200`, `trades.{id}` |

Not used: every `/private/` path, the asset host `spot.edgex.exchange`, the private websocket, and everything listed under
"Unknown / contradictory" in the dossier (§7). `getFundingRatePage`'s time filters are documented but were not verified live:
the adapter pages and filters client-side instead.

Two things were verified by this work beyond the dossier (2026-11-15/16 UTC):

- `ticker.all.1s` works: one snapshot, then one frame per second, each carrying **every** contract (195) with best bid/ask.
- Depth increments are contiguous (`startVersion` of a frame = `endVersion` of the previous one) and a 15-level local book
  stays exactly 15 × 15 and uncrossed when they are applied (`size "0"` deletes a price); same on `depth.{id}.200`.

Also observed and handled: error envelopes now come with HTTP 400 (the dossier saw HTTP 200 for the same body); two listings
have Chinese contract names (`哈基米USDC`, `牛来USDC`; their coin names are ASCII); the "commodities" tab of another product
of the app (`AppTradFi`) lists the stocks JPM and KO.

### 4. What is implemented

`packages/derivatives/src/venues/edgex/` — `createEdgeXAdapter()` returns an `EdgeXAdapter`, an implementation of the existing
`VenueAdapter` interface (no parallel interface):

| Method | Source | Behaviour |
|---|---|---|
| `instruments()` | `getMetaData` (+ tabs) | displayed contracts; tick, lot, minimum size, maximum leverage (highest tier), funding interval, collateral, status; `category`; extra `edgex` object: contract id, maker/taker/liquidation fee rates, risk tiers, max order/position size, funding cap, `isStock`, `isFx`. Cached 5 min. Each contract is validated alone: an unreadable listing is left out and reported in `diagnostics().skippedContracts` |
| `tickers()` | websocket `ticker.all.1s`, REST fallback | last, mark, index, mid (from best bid/ask when present), funding forecast, next funding time, open interest, 24 h volume (base) and turnover (USDC), 24 h change. The websocket subscription is opened on first use and closed after 60 s without a call. Fallback: one `getTicker` per displayed contract, 4 at a time, at most one sweep per 15 s |
| `book(symbol, depth)` | `getDepth` | level 15 when `depth ≤ 15`, else 200; best first; a crossed book is `bad_answer` |
| `candles()` | `getKline` | 1m/5m/15m/1h/4h/1d; pages joined through `offsetData`; never more than 1000 per page, 5 pages |
| `fundingHistory()` | `getFundingRatePage` | settlements, with the premium index |
| `trades()` | websocket `trades.{id}` | **no REST endpoint exists**: a short-lived subscription returns the channel's snapshot of recent trades, then the stream cache serves the next calls (kept 60 s). No websocket, no answer in 6 s, or a refused channel → `VenueUnavailable('edgex_trades_unavailable')`, never an empty success |
| `stream()` | public websocket | subscribe after the server's `connected`; server `ping` every 10 s answered by `pong` with the same `time`; reconnection with exponential backoff and jitter (1 s … 30 s); `stale` after 25 s of silence, reconnection 10 s later; resubscription; `gap` events after a reconnection and on a hole in the depth versions (the channel is subscribed again — a local book is never patched across a hole); trades de-duplicated by `ticketId` |
| `account`, `positions`, `openOrders`, `orderHistory`, `fills`, `funding` | — | throw `VenueUnavailable('edgex_account_restricted_jurisdiction')` before any request |
| `trading` | — | `undefined` |
| `capabilities` | — | `marketData: true`, `account: false`, `orders: false`, no order type; the notes carry the reason codes |

Numbers: every figure is a string on the wire and is validated as a plain decimal, then put in canonical form
(`decimal.ts` rules). A malformed figure fails validation; it never becomes `NaN`. Timestamps: trades, candles and funding
rows carry the venue's time; tickers and books carry the time of receipt (edgeX stamps neither).

Rate limits are unpublished: one retry after a transport failure or a 5xx, none after a 429; a 429 stops every edgeX request
for 5 s, doubling up to 120 s. All cadences are options of `createEdgeXAdapter`.

Models (`packages/derivatives/src/models.ts`), all backward compatible:

- `VENUE_IDS` gains `'edgex'`;
- `Instrument.category?: 'crypto' | 'equity' | 'pre_ipo' | 'commodity' | 'fx'` — optional. Set by edgeX only; the other
  adapters were left untouched (their files belong to other work streams, and "crypto" is not trivially true of all their
  listings);
- `Ticker.last?`, `Ticker.volumeBase24h?`, `Ticker.nextFundingTs?` — optional;
- `VenueUnavailable` (a `VenueError` with a stable `reason`).

Category rule: the documented flags always win (`isStock` → `equity`, or `pre_ipo` when the pre-IPO tab lists the contract;
`isFx` → `fx`); for the rest, `commodity` when the commodities tab lists it, `crypto` otherwise. Without the tabs endpoint,
contracts that are neither stock nor fx carry **no** category, because the metadata alone cannot tell gold from a token.

Jurisdiction: `EDGEX_BLOCKED_JURISDICTION` in `packages/derivatives/src/live/jurisdiction.ts` (clauses, URL, date, FR/EN
notice). It is deliberately **not** part of `JURISDICTION_ACK`: there is no acknowledgement the owner could approve.
`docs/v4/venues/jurisdiction.md` has the edgeX row.

API (`services/api/src/derivatives/`): edgeX is the fourth entry of the registry (`venues.ts`: `EDGEX_RESTRICTION`,
`EDGEX_FACTS`), so it is served by the existing routes — `/venues`, `/instruments`, `/tickers`, `/market`, `/candles`,
`/funding`, `/stream`, `/compare`, `/route/assets` — with the same caches and freshness bounds as the others. `/watch` and
`POST /accounts` answer 403 `venue_restricted` with the notice. French texts in `market-texts.ts`; router facts in
`packages/derivatives/src/router.ts` (shown for information, never ranked). The paper worker never touches edgeX (no paper
account can exist on it).

Web (`apps/web`): venue name and colour, comparison table and "what differs" card, contract facts (category, and a "Trading —
unavailable: edgeX's terms exclude Canada" line), order panel notice, venue list. New i18n keys in one contiguous block,
prefix `ex*`. Logo: no official edgeX mark was found in a licensed registry, so the venue is a declared generic fallback
(initials) in `apps/web/src/logos/icons.json`.

### 5. Tests run

| File | Tests | What |
|---|---|---|
| `packages/derivatives/test/edgex/adapter.test.ts` | 27 | recorded REST answers: instruments (ANTHROPICUSDC, BTC, AAPL, SPY, XAU, USDJPY, a hidden contract), categories with and without the tabs, tickers by REST and by websocket, book levels, candle and funding paging, trades by websocket, account refusals, and the error paths: 429 and its backoff, HTML body, timeout and 5xx with one retry, malformed numbers, venue error codes |
| `packages/derivatives/test/edgex/stream.test.ts` | 10 | the recorded 20 s websocket session replayed frame for frame; depth gap, crossed book, reconnection and backoff, staleness, malformed frames, reference counting, channel names from live ids |
| `services/api/test/derivatives-edgex.test.ts` | 9 | the real server with the real adapter over fixtures: every read route, FR texts, 403 on accounts, and **isolation** — edgeX throwing, edgeX timing out, edgeX throwing a non-venue error, while the three other venues still answer |

Fixtures: `packages/derivatives/test/fixtures/edgex/` — real answers captured 2026-11-15/16 UTC by `record.mjs` (in the same
directory); lists were shortened to the contracts under test, which each fixture states in its `trimmed` field.

### 6. Observed results (live, read-only)

`npx tsx scripts/smoke-edgex.mts`, 2026-11-16 00:20 UTC (2026-11-15 19:20 in Québec), from a Canadian residential IP, exit code 0:

```
edgeX smoke (read-only)  2026-11-16T00:20:38.670Z
capabilities: marketData true, account false, orders false, trading object absent

== instruments (getMetaData + category tabs)
  markets listed             157
    crypto                   74
    equity                   71
    commodity                8
    pre_ipo                  3
    fx                       1
  category source            contract-labels
  pre_ipo                    MOONSHOTUSDC, POLYMARKETUSDC, ANTHROPICUSDC
  status                     active 157
  funding interval (s)       14400
  ANTHROPICUSDC              contractId 30000192, category pre_ipo, tick 0.001, lot 0.01, min 0.03, max leverage 5×
    fees / tiers             maker 0.0004, taker 0.00045; tier 1: 5× mm 0.1; tier 2: 4× mm 0.125

== tickers (websocket ticker.all.1s, REST fallback)
  tickers                    157 in 909 ms, source websocket
  last / mark / index        1340.856 / 1340.973913807151556166 / 1344.4632884092954845
  mid                        1341.0265
  funding (forecast)         0.00033669  next settlement 2026-11-16T04:00:00.000Z
  open interest (base)       5.04
  24 h volume                164.12 base, 219486.62512 USDC
  24 h change                -0.4595 %
  received at                2026-11-16T00:20:40.256Z

== book ANTHROPICUSDC (getDepth level 15 and 200)
  level 15                   bid 1340.612 × 0.66  |  ask 1341.441 × 0.75  (15 bids, 15 asks)
  level 200                  bid 1340.612 × 0.66  |  ask 1341.441 × 0.75  (62 bids, 62 asks)
  spread                     0.829

== candles ANTHROPICUSDC
  1m                         2026-11-16T00:17 c=1341.043 v=0.12  2026-11-16T00:18 c=1341.328 v=0.11  2026-11-16T00:19 c=1341.411 v=0.09
  1h                         2026-11-15T21:00 c=1342.376 v=6.44  2026-11-15T22:00 c=1343.563 v=6.53  2026-11-15T23:00 c=1343.833 v=6.55
  1d                         2026-11-13T00:00 c=1345.873 v=156.33  2026-11-14T00:00 c=1344.897 v=157.51  2026-11-15T00:00 c=1343.833 v=163.57
  1m × 1500 (2 pages)        1500 candles, 2026-11-14T23:20:00.000Z → 2026-11-16T00:19:00.000Z, contiguous true

== funding history ANTHROPICUSDC (getFundingRatePage, settlements)
  settlements in 48 h        12
    2026-11-15T12:00:00.000Z rate 0.00013871  premium -0.00027635
    2026-11-15T16:00:00.000Z rate 0.00041593  premium -0.0004936
    2026-11-15T20:00:00.000Z rate 0.00027631  premium -0.00035107
    2026-11-16T00:00:00.000Z rate 0.00000332  premium -0.00055912
  spacing (h)                4

== trades ANTHROPICUSDC (websocket snapshot: no REST endpoint exists)
  recent trades              5
    2026-11-16T00:20:42.547Z buy 0.04 @ 1340.852
    2026-11-16T00:20:12.559Z sell 0.04 @ 1340.856
    2026-11-16T00:19:45.550Z buy 0.05 @ 1341.411
    2026-11-16T00:19:15.549Z sell 0.04 @ 1341.321
    2026-11-16T00:18:48.547Z buy 0.05 @ 1341.328

== websocket ticker.{contractId} for ANTHROPICUSDC: a frame within 15 s
  first frame after          189 ms (status: connected)
  mark                       1340.973913807151556166
  in 12 s more               19 ticker frames; 43 frames in all, 2 pong(s) sent, 0 invalid, 0 depth resync(s), 1 connection(s)

== websocket depth: versions contiguous, book never crossed (10 s, levels 15 and 200)
  BTCUSDC depth.15           21 books, 0 gap(s), 0 invalid, 0 crossed, up to 15 bid levels emitted
  BTCUSDC depth.200          24 books, 0 gap(s), 0 invalid, 0 crossed, up to 20 bid levels emitted

== account and trading: refused before any request
  account                    VenueUnavailable(edgex_account_restricted_jurisdiction)
  positions                  VenueUnavailable(edgex_account_restricted_jurisdiction)
  openOrders                 VenueUnavailable(edgex_account_restricted_jurisdiction)
  requests sent for these    0
  note                       Trading unavailable [edgex_trading_restricted_jurisdiction]: edgeX's Terms of Use exclude persons located in the United States of America or Canada ("…

REST calls 10, rate-limit backoff none, websocket connections 1

all steps passed
```

An earlier run the same evening (00:16 UTC) counted 10 commodities and 69 equities: the tabs of another product of the app
(`AppTradFi`) list the stocks JPM and KO as commodities. The category rule was then tightened (flags win, `PrepV2` tabs
only); the output above is from the final code.

Reading of these results: the public REST and websocket endpoints answered from Canada. That is a technical observation,
**not** a permission. ANTHROPICUSDC is a very thin market (open interest 5.04 contracts, about 6 800 USDC).

### 7. Limitations

1. **No trading, no account** — jurisdiction (section 1). Not a technical limitation and not something the software may lift.
2. **No official definition of the pre-IPO contracts.** edgeX publishes no specification for `ANTHROPICUSDC`,
   `POLYMARKETUSDC`, `MOONSHOTUSDC`: not the unit of one contract, not the index sources, not what happens at an IPO or a
   delisting. The wallet states none, shows no "implied valuation", and says in the contract facts that the contract confers
   no claim on any share. `pre_ipo` itself comes from an undocumented endpoint (the app's tab).
3. **Unpublished rate limits.** No 429 was met (about 60 calls in a few minutes during research, 10 per smoke run). The
   defaults are a guess on the slow side; the REST ticker fallback (157 calls per sweep) is the heaviest thing the adapter can
   do and is used only when the websocket gives nothing.
4. **No public testnet.** Every testnet host is behind a Cloudflare Access login. All tests run on recorded mainnet answers;
   the smoke script is the only live check, and it is read-only.
5. **Trades depend on the websocket.** Where no websocket can be opened, `trades()` is unavailable (typed error) and
   `/market` reports it in `errors.trades`.
6. **No venue timestamp on tickers and books**: their `ts` is the time of receipt.
7. **Mark = oracle** in every answer read; edgeX does not say which index sources apply per instrument. Stock-type contracts
   have a single oracle signer.
8. **A venue that hangs delays all-venue answers** (`/instruments`, `/tickers` without `venue=`) by up to its request
   timeout (10 s, twice with the retry) — existing behaviour of the data service for every venue (the others use 15 s); the
   other venues' data is still returned and edgeX is named in `errors`.
9. **Logo**: generic fallback (initials).
10. **Mock mode of the web app** (`?mock=1`) lists no edgeX instrument; the end-to-end (Playwright) suite was not run for
    this work.
11. `Instrument.category` is not populated for Hyperliquid, dYdX or GMX.

### 8. What it would take for trading ever to be enabled — and by whom

None of this can be done by the software, and none of it is prepared in code.

| Requirement | Who |
|---|---|
| The owner is not a "Blocked Person": not resident or located in Canada or the United States (or edgeX changes its terms). This is the gate; nothing below matters until it is met | the owner — a fact about him, not a setting |
| A decision recorded in the project that the venue may be traded, replacing the present one | the owner |
| An edgeX account, created in the web app (no programmatic onboarding is documented) | the owner |
| API access: the web app says it requires staking EDGE (the amount is not published; a search snapshot said 1 000 EDGE — unverified) | the owner |
| An "SDK Signer" key created in the web app (API Management → Perps V2 → SDK Signer): API key, secret, passphrase and a delegated signing key, shown once | the owner, then the isolated signer would have to hold it |
| A resolved `l2Signature` format: the Go SDK sends `0x` + 130 hex, the Python SDK 130 hex without prefix, the docs say 128 characters. It can only be settled by a real order, and there is no public testnet | edgeX (documentation or testnet access), or a funded mainnet test |
| Proof of what the SDK Signer can do: the docs say it signs "orders, withdrawals, and transfers", the SDK limits it to orders and margin mode; server enforcement is unknown, so a leaked signer must be assumed able to drain the account | edgeX |
| Published rate limits; a contract specification for the pre-IPO perpetuals | edgeX |
| Then: a third execution engine (signer file, mandate and risk integration, order life cycle, reconciliation), as the audit describes for any new tradable venue (`docs/v11/audit-parts/derivatives-exec-signer.md` §2.4) | engineering, after all of the above |

---

## Hyperliquid

> **Placeholder — to be filled by the Hyperliquid work stream.**
> Expected sections: 1. Initial state · 2. API used · 3. What is implemented · 4. Tests run · 5. Observed results · 6. Limitations.

---

## GMX

> **Placeholder — to be filled by the GMX work stream.**
> Expected sections: 1. Initial state · 2. API used · 3. What is implemented · 4. Tests run · 5. Observed results · 6. Limitations.

---

## dYdX

> **Placeholder — to be filled by the dYdX work stream.**
> Expected sections: 1. Initial state · 2. API used · 3. What is implemented · 4. Tests run · 5. Observed results · 6. Limitations.
