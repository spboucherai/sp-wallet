# V11 — Exchange integrations

One chapter per perpetual venue: initial state, API used, what is implemented, tests run, observed results, limitations.
Every figure below was measured or read on the date given; nothing is extrapolated.

- [edgeX](#edgex) — written 2026-11-15 (branch `v11-edgex`)
- [Hyperliquid](#hyperliquid) — written 2026-11-15 (branch `v11-markets-compare`; trading facts from the V11 audit)
- [GMX](#gmx) — written 2026-11-15 (branch `v11-markets-compare`; trading facts from the V11 audit)
- [dYdX](#dydx) — written 2026-11-15 (branch `v11-markets-compare`)
- [Comparator](#comparator) — the venue cost comparison and the cross-venue discrepancy estimates

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

**Status: market data, paper trading and a live trading path that exists end to end and is locked by server variables. No order
was ever accepted on a funded account.** Written 2026-11-15 (branch `v11-markets-compare`). The trading facts below are those of
the V11 audit (`docs/v11/audit-parts/derivatives-exec-signer.md` §1, §3.1, §4.4–4.6); execution was not re-audited here. What this
work added is the read side used by the Markets explorer and the Comparator.

### 1. Initial state

- Adapter `packages/derivatives/src/venues/hyperliquid/` (read: `adapter.ts`, `mappers.ts`, `stream.ts`; trade: `trading.ts`,
  `signing.ts`), mainnet and testnet. Venue contract: `docs/v4/venues/hyperliquid.md`.
- In the API: instruments, tickers, book, trades, candles, funding, the public websocket (book, trades, ticker), the old
  comparison table and the router simulation; paper accounts; the live engine `services/api/src/derivatives/exec.ts`.
- Not there before this work: no listing across venues with a freshness stamp per row, no mapping from `kPEPE` to an underlying,
  no "can the wallet trade this" flag per instrument, no cost comparison from the real book.

### 2. API used (public, read-only)

| Call | Used for |
|---|---|
| `POST https://api.hyperliquid.xyz/info` `{"type":"meta"}`, `{"type":"metaAndAssetCtxs"}` | instruments (name, size decimals, maximum leverage, delisted flag) and every ticker in one answer (mark, oracle, mid, funding, open interest, 24 h notional volume, previous-day price) |
| `{"type":"l2Book","coin":…}` | order book: 20 levels a side at the finest price step |
| `{"type":"recentTrades"}`, `{"type":"candleSnapshot"}`, `{"type":"fundingHistory"}` | trades, bars, hourly funding applied (at most 500 rows from the start time) |
| `wss://api.hyperliquid.xyz/ws` | book, trades and ticker of an open instrument (Futures terminal) |
| `{"type":"clearinghouseState"}`, `{"type":"frontendOpenOrders"}`, … | account reads of the live engine (not used by the hub or the comparator) |

Trading uses `POST /exchange` (audit §1.1). The hub and the comparator never call it: the venue registry hands them a view of the
adapter without `trading` (`services/api/src/derivatives/venues.ts`), and the smoke run checks every outgoing request.

### 3. What is connected

| | State |
|---|---|
| Market data | real, mainnet (the hub) and testnet (the live engine's tests) |
| Paper trading | yes — the only venue with a paper account |
| Live trading | wired end to end: build, signer-side reading of the payload, submit, cancel, TP/SL, reduce-only, leverage, collateral deposit and withdrawal (audit §1.1). Manual mode needs a passkey per order; a derivative mandate allows passkey-less orders inside signer-enforced bounds |
| Tradable instruments | **BTC, ETH, SOL** only: the pinned asset table `packages/derivatives/src/live/hl-assets.ts` (checked against the venue's `meta` on 2026-11-15, identical). Every other instrument is shown with `tradableReason: hl_asset_not_pinned` |
| Builder dexes (HIP-3) | read through `adapter.builder` by the Private Markets work stream (`/api/v1/private-markets`), market data only. The hub lists the main dex (the adapter's `instruments()`); a symbol with a `dex:` prefix reaching it would be flagged `hl_builder_dex` and never mapped to an underlying |

Symbol normalisation: the base is the venue's own `name`. The main perp dex lists crypto assets under their ticker, so they map by
venue metadata. `kPEPE`, `kSHIB`, `kBONK`, `kFLOKI` are reviewed rows with multiplier 1 000; `kLUNC`, `kNEIRO`, `kDOGS` are not
reviewed and stay unmapped (`multiplier_unreviewed`).

Comparator inputs: instrument and ticker from `metaAndAssetCtxs`, the `l2Book` snapshot, fees = base tier of the router's reviewed
table (taker 0.045 %, maker 0.015 %, checked 2026-11-10), funding = the ticker's hourly rate, maintenance margin =
1 / (2 × maximum leverage).

### 4. Locks

| Lock | Effect |
|---|---|
| `SPW_DERIV_LIVE_MAINNET=on` | without it every mainnet trade, cancel and collateral move answers `mainnet_disabled` (testnet needs no variable) |
| `SPW_DERIV_MANDATE_MAINNET=on` | needed, with the first, for mandate (passkey-less) orders on mainnet |
| Signer | a stored venue authorization approved with the passkey; its own `halted` flag |
| Pinned assets | the signer and the API refuse an instrument outside the pinned table |

The audit lists two High findings that touch these locks (turning a lock off, or the emergency halt, also blocks cancels and
closes). They are for the execution work stream; nothing here changes them. The explorer reports the state of the server locks
next to the rows (`locks`), by name and state only.

### 5. Tests

- Existing (not changed): `packages/derivatives/test/hyperliquid/adapter.test.ts` (24), `stream.test.ts` (16), `trading.test.ts`
  (38), the signer's venue tests, `services/api/test/derivatives-api.test.ts` (21), `derivatives-live.test.ts` (22).
- This work: `packages/trading/test/symbols.test.ts` (the 235 recorded instruments; the `k` contracts; unit prices within 1 %),
  `services/api/test/markets-hub.test.ts` (rows, tradability, the BTC comparison hand-checked against the recorded book, a missing
  book, a venue that throws or hangs).

### 6. Observed (live, read-only, 2026-11-16 01:19 UTC, `scripts/smoke-markets-hub.mts`)

235 instruments (179 active, 56 halted), all with a price, tickers 1.0 s old when listed. 232 mapped as crypto, 3 unmapped
(`multiplier_unreviewed`). Tradable: `hyperliquid:BTC`, `hyperliquid:ETH`, `hyperliquid:SOL`; 176 `hl_asset_not_pinned`, 56
`instrument_halted`. BTC: mark 64 846, 24 h volume 4.58 G USD, open interest 2.37 G USD, funding 0.0000125 / h = 10.95 % a year.
BTC long 1 000 USD ×3 over 24 h: mid 64 843.5, spread 0.15 bps, entry slippage 0.008 USD (0.08 bps), exit slippage 0.109 USD,
fees 0.45 + 0.45 USD, funding 0.30 USD, collateral 333.30 USD, liquidation estimate 43 776.54, **total 1.32 USD = 13.17 bps**.
6 `POST /info` requests for the whole run; no other endpoint.

### 7. Limitations

1. The book snapshot is 20 levels a side: on BTC it ends about 3 bps from the mid. The comparator's depth at 10, 25 and 50 bps is
   therefore a **lower bound** on this venue, marked as such (`askComplete: false`, "+" on screen). The adapter does not request
   the aggregated book (`nSigFigs`); doing so belongs to the adapter's owner.
2. Fees are the base tier: volume tiers and staking discounts are not applied.
3. Maintenance margin is the first tier (1 / (2 × max leverage)); the venue's size tiers are not modelled.
4. A burst of requests can be answered 429 (audit §1.5); the data service then serves the last good value, marked stale.

### 8. Not verified on mainnet

No order, cancel, leverage change, deposit or withdrawal was ever accepted on a funded account (audit §1.4). Whether production
runs with the locks on was not read. Nothing in this work sends anything to the venue's trading endpoint.

---

## GMX

**Status: market data, and market increase / decrease orders on two pinned Arbitrum markets as wallet transactions, locked by
server variables. Nothing was ever sent to Arbitrum mainnet.** Written 2026-11-15 (branch `v11-markets-compare`). Trading facts:
audit §1, §3.2, §4.7.

### 1. Initial state

- Adapter `packages/derivatives/src/venues/gmx/` (read side, Arbitrum; Avalanche endpoints exist, unused by the API). Venue
  contract: `docs/v4/venues/gmx.md`. Order building and verification: `packages/derivatives/src/live/gmx.ts`; engine
  `services/api/src/derivatives/gmx-exec.ts`.
- GMX has no order book: the old comparison table showed "no book" and the router simulation carried the price-impact formula.
- Not there before this work: GMX rows in a cross-venue listing, a cost row comparable with the order-book venues.

### 2. API used (public, read-only)

| Call | Used for |
|---|---|
| `GET https://arbitrum.gmxapi.io/v1/markets`, `/markets/tickers`, `/markets/config`, `/markets/values`, `/tokens/info`, `/pairs` | markets (one instrument per pool), oracle range, open interest per side, capacity, funding and borrowing rates, price-impact and fee factors, virtual inventory |
| `GET https://arbitrum-api.gmxinfra.io/prices/tickers`, `/tokens` | the adapter's `oraclePrices()` (**not** called by the hub or the comparator — the smoke run contacted `arbitrum.gmxapi.io` only) |
| `GET …/prices/ohlcv`, `…/rates` | bars and funding history |
| GraphQL `gmx.squids.live` | public trade actions (trades panel) |

No websocket (the hub polls). The chain reads of the trading engine (`gmx-chain.ts`: `Reader`, `DataStore`, pinned bytecode) are
not used by the hub or the comparator.

### 3. What is connected

| | State |
|---|---|
| Market data | real, Arbitrum One |
| Paper trading | no (no order book for the paper engine) |
| Live trading | `MarketIncrease` and `MarketDecrease` only, as transactions of the wallet's own key, each approved with the passkey; no limit, stop or take-profit order; cancellation only 300 s after creation or when frozen (audit §1.1) |
| Tradable instruments | the two pinned markets of `GMX_MARKETS`: `gmx:BTC/USD [BTC-USDC]` and `gmx:ETH/USD [WETH-USDC]`. Every other pool is shown with `gmx_market_not_pinned` |
| Autonomous trading | none: `MANUAL_LIVE` only |

Symbol normalisation: GMX publishes no asset class. A base ticker maps only when it is in the list reviewed on 2026-11-15 (84
tickers: active on GMX, same ticker listed as crypto by Hyperliquid or edgeX, mark within 1 %). `kPEPE`, `kSHIB`, `kBONK`,
`kFLOKI` are reviewed rows with multiplier **1**: GMX spells the market `kPEPE` but prices and sizes it per 1 PEPE — the same name
as Hyperliquid's contract, a unit a thousand times smaller. `SPY`, `QQQ`, `NATGAS`, `SPCX` (edgeX lists those letters as an
equity or a commodity) stay unmapped (`no_category_metadata`), as do `GOLD`, `SILVER`, `WTIOIL`, `BRENTOIL`, `XAUT` and six
others (`ticker_not_reviewed`).

Comparator inputs (one row: the pinned pool, else the most traded pool; the others are listed as `alternatives`): the oracle
range stands in for the best bid and ask (a buy executes at the max, a sell at the min); slippage = distance of that price from
the oracle mid plus the pool's price impact when it is against the trade (`gmxPriceImpact` of the router, capped at the market's
maximum factors; a favourable impact is not credited); fees = the market's position fee factor (the higher, "balance not
improved", 0.06 %); carry = the side's **net** rate per hour (funding and borrowing together; the short side has its own rate);
maintenance = `minCollateralFactorForLiquidation`. Depth is null with the reason: there is no book.

### 4. Locks

| Lock | Effect |
|---|---|
| `SPW_DERIV_LIVE_MAINNET=on` **and** `SPW_DERIV_GMX_LIVE=on` | without both, every GMX prepare, approve and relay answers `gmx_disabled` / `mainnet_disabled`; reading works |
| Venue policy | approved once with the passkey; markets, leverage and daily order count are bounded by it |
| Pins | contract addresses and runtime bytecode hashes are checked on both registry RPC endpoints before every order |

The audit notes that GMX runs with placeholder loss limits and no kill switch (Medium), and that a cancel needs a passkey because
it is a wallet transaction. Not changed here.

### 5. Tests

- Existing (not changed): `packages/derivatives/test/gmx/adapter.test.ts` (26), `gmx-live.test.ts` (23), `router.test.ts` (16,
  the impact formula against the venue's own figures), `services/api/test/derivatives-gmx.test.ts` (20).
- This work: `packages/trading/test/cost-pool.test.ts` (pool execution hand-checked; the recorded BTC pool; capacity refusal;
  short-side carry), `symbols.test.ts` (the 124 recorded pools), `services/api/test/markets-hub.test.ts` (the GMX row of the BTC
  and ETH comparisons; a hanging GMX).

### 6. Observed (live, read-only, 2026-11-16 01:19 UTC)

124 pools, all active, all with a price, tickers 0.8 s old. 109 mapped as crypto, 15 unmapped (11 `ticker_not_reviewed`, 4
`no_category_metadata`). Tradable: the two pinned markets; 122 `gmx_market_not_pinned`. BTC long 1 000 USD ×3 over 24 h on
`gmx:BTC/USD [BTC-USDC]`: oracle mid 64 841.68, oracle spread 0, entry cost 0.393 USD (3.93 bps, price impact against the trade),
exit 0 (the impact would be in favour: not credited), fees 0.60 + 0.60 USD, net carry of the long side 0.0000220 / h = 19.31 % a
year → 0.53 USD, collateral 333.33 USD, liquidation estimate 43 462.07, **total 2.12 USD = 21.22 bps**. ETH on
`gmx:ETH/USD [WETH-USDC]`: longs were receiving (−21.06 % a year), total 0.97 USD = 9.74 bps. 9 `GET` requests for the run.

### 7. Limitations

1. The order executes later, at the oracle price of that moment, by a keeper: the figure is an estimate of now. The execution fee
   in ETH and the Arbitrum gas are **not** in the comparator's total (they are in the router simulation, `/derivatives/route`).
2. The price impact of the exit is computed on the pool as it is now, not as it will be after the entry; the impact pool's
   balance, which can cut a favourable impact, is not modelled (the comparator credits no favourable impact at all).
3. The collateral is the pool's token or USDC; the comparator treats it as USD.
4. The opening leg of the impact formula is not itself verified against the venue (the closing leg is, to six digits).

### 8. Not verified on mainnet

Creation, simulated execution and keeper cancellation were proven on an anvil fork with the real bytecode; shorts, the BTC market,
frozen orders, liquidation and ADL were not run; nothing was sent to Arbitrum mainnet (audit §1.4).

---

## dYdX

**Status: READ-ONLY market-data venue. No account read, no paper account, no trading code. Its terms exclude Canada.** Written
2026-11-15 (branch `v11-markets-compare`).

### 1. Initial state

- Adapter `packages/derivatives/src/venues/dydx/` (indexer REST and websocket). Venue contract: `docs/v4/venues/dydx.md`;
  jurisdiction: `docs/v4/venues/jurisdiction.md`.
- The registry serves dYdX with a restriction text: account reads answer 403 `venue_restricted` although the adapter implements
  them, and the adapter declares `orders: false`.
- Not there before this work: dYdX rows in a cross-venue listing with the reason they cannot be traded, a cost row.

### 2. API used (public, read-only)

| Call | Used for |
|---|---|
| `GET https://indexer.dydx.trade/v4/perpetualMarkets` | every market: ticker, status, tick and step size, initial margin fraction (maximum leverage), oracle price, next funding rate, open interest, 24 h volume and price change |
| `GET /v4/orderbooks/perpetualMarket/{ticker}` | order book (50 levels a side in the recording) |
| `GET /v4/trades/perpetualMarket/{ticker}`, `/v4/candles/perpetualMarkets/{ticker}`, `/v4/historicalFunding/{ticker}` | trades, bars, hourly funding applied |
| `wss://indexer.dydx.trade/v4/ws` | public book and trades of an open instrument |

The account endpoints (`/v4/addresses/…`, orders, fills, funding payments) are never called from the wallet's network; the tests
fail if one is.

### 3. What is connected

| | State |
|---|---|
| Market data | real, mainnet |
| Account, paper, trading | none, by decision: the terms of use exclude Canada (and the United States and the United Kingdom) and the indexer geoblocks account reads. Every row carries `tradable: false`, `tradableReason: dydx_jurisdiction`, and the restriction text |

Symbol normalisation: the base is the part of the ticker before `-USD`. dYdX publishes no asset class, and most of its markets are
halted with a stale oracle price (239 of 296 on 2026-11-15, many of them 20 % to 90 % away from the same ticker elsewhere). A base
maps only when it is in the list reviewed on 2026-11-15 (54 tickers: active on dYdX, same ticker crypto on Hyperliquid or edgeX,
mark within 1 %), plus `PEPE` and `BONK` (reviewed against the ×1 000 contracts of Hyperliquid and edgeX). 233 instruments stay
unmapped as `ticker_not_reviewed`, 6 as `bad_ticker` (names such as `MAD,RAYDIUM,<address>-USD`), 1 as `no_category_metadata`.
A halted instrument is never compared.

Comparator inputs: the real book, fees = base tier of the router's reviewed table (taker 0.05 %, maker 0.01 %, checked
2026-11-10), funding = the estimated next hourly rate of the ticker. The maintenance margin fraction is per market and is not
carried by the adapter: the liquidation estimate is **null with that reason**.

### 4. Locks

None are needed: there is no trading code to lock. The restriction is structural (`createRegistry` wraps the adapter in a
read-only view whose account methods refuse).

### 5. Tests

- Existing (not changed): `packages/derivatives/test/dydx/adapter.test.ts` (23), `stream.test.ts` (16),
  `services/api/test/derivatives-api.test.ts` (the 403 on account reads).
- This work: `symbols.test.ts` (the 296 recorded markets), `services/api/test/markets-hub.test.ts` (rows and reason code; the
  30 000 USD slippage walked over three levels of the recorded BTC book, hand-checked; a hanging dYdX; a scripted price gap
  flagged and marked not actionable from the wallet).

### 6. Observed (live, read-only, 2026-11-16 01:19 UTC)

296 markets (57 active, 239 halted), tickers 1.2 s old. 56 mapped as crypto, 240 unmapped. BTC long 1 000 USD ×3 over 24 h: mid
64 857.5, spread 2.00 bps, depth within 10 / 25 / 50 bps 0.30 / 2.53 / 3.65 M USD bid and 0.50 / 1.55 / 2.47 M USD ask (complete at
each distance), entry slippage 0.10 USD (1.00 bps), fees 0.50 + 0.50 USD, funding 0.0000118 / h = 10.33 % a year → 0.28 USD,
**total 1.48 USD = 14.84 bps**, liquidation null (maintenance fraction not carried). 6 `GET` requests for the run.

### 7. Limitations

1. No liquidation estimate (see above).
2. The funding figure is the venue's estimate of the next hourly rate, not a rate already applied.
3. The reviewed list is a snapshot: a market that dYdX reactivates stays unmapped until it is reviewed.

### 8. Not verified

Nothing beyond public reads: there is nothing to verify on the trading side, and none is planned while the terms exclude Canada.

---

## Comparator

**What it is: a table of what holding one position would cost on each venue, computed from real inputs read now. Estimates,
never a quote, never a recommendation.** Written 2026-11-15 (branch `v11-markets-compare`). Detail per item:
`docs/v11/work/markets-compare.md`.

### 1. Routes

| Route | Auth | Answer |
|---|---|---|
| `GET /api/v1/markets-hub` | owner session | the explorer: spot assets and the perps of the four venues, filters, sort, pagination |
| `GET /api/v1/markets-hub/underlyings`, `/underlyings/:symbol` | owner session | the underlyings the instruments map to; every venue's instruments for one of them |
| `GET /api/v1/markets-hub/compare?underlying=BTC&side=long&notional=1000&leverage=3&horizonHours=24` | owner session | one row per venue + cross-venue discrepancy estimates |
| `GET /api/v1/trading/markets/compare` | API key with `markets:read`, or the owner | the same computation, filtered by the key's venue and instrument restrictions |

### 2. Where the arithmetic lives

Pure code, `packages/trading/src/compare/`: `cost.ts` (`venueCost`, `compareVenues`, `crossVenueDiscrepancy`,
`findDiscrepancies`, `depthWithin`, `annualiseFunding`, the GMX pool helpers) and `symbols.ts` (`normaliseSymbols`,
`toUnderlyingUnits`, `priceOutliers`). The book walk, the margin and the liquidation price are the functions of
`packages/derivatives` (`walkBook`, `initialMargin`, `liquidationPriceAtLeverage`, `gmxPriceImpact`) — imported, not copied. The
API (`services/api/src/markets-hub/compare.ts`) only gathers inputs.

### 3. One row

For the notional N, the leverage L and the horizon H, per venue:

| Figure | How |
|---|---|
| mid, spread | best bid and ask of the real book (GMX: the oracle range) |
| depth within 10 / 25 / 50 bps | Σ price × size inside each distance, per side; flagged when the book that was read ends before it |
| size | N / mid, rounded down to the lot |
| entry and exit slippage | average price of walking the book for the whole size, against the mid (half the spread included); the exit on the **current** book |
| fees | taker (or maker) rate × notional, entry and exit; the schedule's source and date are in the answer |
| funding | the current rate, held constant over H (stated as an assumption); the venue's raw rate and interval are kept next to the per-hour and annualised figures |
| collateral | notional / L; null when L is above the venue's maximum, with that reason |
| liquidation | isolated-margin estimate at L with the venue's maintenance fraction; null when the fraction is unknown |
| total | entry slippage + exit slippage + entry fee + exit fee + funding; **null when one of the five is null**, naming it |

Every figure is `{ value, reason, basis }`: a number with how it was obtained, or null with why. A venue the wallet cannot trade
on has its row, flagged with the reason code.

### 4. Cross-venue discrepancy

For every ordered pair of venues (buy on one, sell on the other, same size on both lots): the gap between the two average
execution prices, net of the fees of four legs, the exit slippage on both and the net funding over the horizon —
`netEdgeEstimateBps`. Each result carries `assumptions[]` (six: simultaneous fills at the current books, convergence to one
price, constant funding, same contract, collateral already in place…) and `risks[]` (six: execution, convergence, funding,
liquidation, venue, model). `flagged` only says the estimate is above the threshold asked (default 0). `actionableFromWallet` is
false when a leg is on dYdX or edgeX.

Three guards keep a data problem from looking like an opportunity:

1. instruments are compared only through the reviewed symbol map, in units of the underlying (`toUnderlyingUnits`);
2. a row whose unit price is more than 3 % from the median of the venues is left out (`priceOutliers`), with a warning;
3. a stale row, or one without a price of its own, is in no pair.

Wording: no text of the API or of the two screens says that an estimate is an outcome. Tests grep the constants, whole answers
and the `mk` / `cp` i18n block for the forbidden words (`services/api/test/markets-hub.test.ts`, `apps/web/test/markets.test.ts`).

### 5. Observed (live, read-only, 2026-11-16 01:19 UTC)

BTC long 1 000 USD ×3 over 24 h — total estimated cost: edgeX 12.14 bps, Hyperliquid 13.17 bps, dYdX 14.84 bps, GMX 21.22 bps.
ETH: dYdX 7.46 bps (longs were receiving funding), GMX 9.74 bps (same), Hyperliquid 9.85 bps, edgeX 12.70 bps. Twelve ordered pairs
each; gross gaps between −3.1 and +4.9 bps among the first four; every net estimate negative (−14.5 to −20.2 bps for the first
four): **no pair flagged** — the costs of four legs exceed the gaps observed. The full output is in
`docs/v11/work/markets-compare.md`.

### 6. Relation to the older views

- `GET /derivatives/compare` (contract facts per base: spread, depth within 1 %, base fee, notes) is unchanged in shape; its
  hourly funding now comes from the same `annualiseFunding`. The web view shows the cost comparison above it.
- `POST /derivatives/route` (router simulation for one order intent: account policies, GMX execution fee and gas, uncertainty
  bands) is untouched and its tests pass. It answers "what would this order cost and which account policy accepts it"; the
  comparator answers "what does a position of this size cost on each venue". Both use `walkBook` and `gmxPriceImpact`.

### 7. Limitations

1. One snapshot. Books move; the exit is priced on the current book; funding changes every interval.
2. Depth is bounded by the book each adapter reads (Hyperliquid 20 levels, edgeX 50): beyond it the figures are lower bounds.
3. Base fee tiers only. No gas, no bridge, no collateral transfer cost (the discrepancy assumes collateral on both venues).
4. One instrument per venue (GMX: the pinned pool).
5. The symbol map is reviewed by hand against a recorded snapshot; new listings wait for a review.
