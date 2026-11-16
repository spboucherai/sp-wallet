# V11 Phase C — edgeX adapter: work note

Branch `v11-edgex` (from local `v11`), 2026-11-15 evening (Québec) / 2026-11-16 00:00–00:25 UTC. Nothing pushed, nothing
deployed, production untouched. No edgeX account, no private call, no key.

Binding scope decision: **edgeX is a READ-ONLY market-data venue.** Its Terms of Use name Canada as a blocked jurisdiction
(the owner is in Québec), exactly like dYdX. Trading is shown as UNAVAILABLE with that reason; it is never simulated.
Full chapter: `docs/V11-EXCHANGE-INTEGRATIONS.md`.

## 1. Adapter (`packages/derivatives/src/venues/edgex/`)

- **Initial state.** Three venues (`hyperliquid`, `dydx`, `gmx`); no edgeX code. `Instrument` had no category; `Ticker` had no
  last price, base volume or next funding time; no typed "unavailable" error.
- **Change.** `wire.ts` (zod shapes of the live answers), `map.ts` (normalisation, category rule), `stream.ts` (public
  websocket), `adapter.ts` (`createEdgeXAdapter`, implements the existing `VenueAdapter`), `index.ts`. `id: 'edgex'`.
  `instruments()` from `getMetaData` (+ optional category tabs); `tickers()` from websocket `ticker.all.1s` with a throttled
  REST fallback; `book()` (levels 15 | 200 only); `candles()` (≤ 1000 per page, `offsetData`); `fundingHistory()`
  (`getFundingRatePage`, settlements); `trades()` from the websocket `trades.{id}` snapshot or a typed
  `VenueUnavailable('edgex_trades_unavailable')`; `stream()` (subscribe, pong to the 10 s server ping, backoff reconnect,
  stale, gap, resubscribe, depth-version check). Account methods throw
  `VenueUnavailable('edgex_account_restricted_jurisdiction')`; `trading` is `undefined`; capabilities
  `marketData: true, account: false, orders: false`, notes with the reason codes. A 429 stops all edgeX requests (5 s,
  doubling to 120 s); one retry after a transport failure or 5xx.
  Models (`models.ts`, backward compatible): `VENUE_IDS` + `'edgex'`; optional `Instrument.category`
  (`crypto | equity | pre_ipo | commodity | fx`); optional `Ticker.last`, `Ticker.volumeBase24h`, `Ticker.nextFundingTs`;
  class `VenueUnavailable extends VenueError`. `router.ts`: `ROUTER_FACTS.edgex`.
- **Tests.** `packages/derivatives/test/edgex/adapter.test.ts` (27) and `stream.test.ts` (10), on fixtures recorded today
  from the live public endpoints by `test/fixtures/edgex/record.mjs` (ANTHROPICUSDC, BTCUSDC, AAPLUSDC, SPYUSDC, XAUUSDC,
  USDJPYUSDC, and the hidden JPYUSDC; a 20 s websocket session). Error paths: 429, HTML body, timeout, 5xx, malformed
  numbers, venue error codes.
- **Result.** 37 / 37 pass. Live smoke passes (section 4).
- **Limitation.** `Instrument.category` is not populated for the other venues (their adapters were left untouched). The
  `pre_ipo` and `commodity` categories depend on an undocumented endpoint (`contract-labels`); without it those contracts
  carry `equity` (pre-IPO names are flagged `isStock`) or no category (commodities). Trades need a websocket. Tickers and
  books carry the time of receipt. Rate limits are unpublished: the defaults are conservative guesses.

Found while testing against the live venue (not in the dossier), all handled and covered by a test:

1. Two live contracts have Chinese names (`哈基米USDC`, `牛来USDC`). The first live run failed on them: an ASCII-only name
   pattern rejected the whole metadata. Names are now letters and digits of any script, and each contract is validated
   alone — an unreadable listing is left out and reported (`diagnostics().skippedContracts`) instead of taking the venue down.
2. The "commodities" tab of another product of the app (`AppTradFi`) lists the stocks JPM and KO. The first live run counted
   10 commodities. Now the documented flags win (`isStock`, `isFx`) and only the `PrepV2` tabs are read: 8 commodities.
3. Error envelopes come with HTTP 400 today (the dossier recorded HTTP 200): the envelope `code` is read whatever the status.
4. `ticker.all.1s` (documented, untested in the dossier) works and carries every contract each second; depth increments
   are contiguous by version and keep a 15-level book exact — both recorded as fixtures and checked live.

## 2. Jurisdiction

- **Initial state.** `live/jurisdiction.ts` held acknowledgement texts for Hyperliquid and GMX; `docs/v4/venues/jurisdiction.md`
  had rows for dYdX, Hyperliquid, GMX.
- **Change.** `EDGEX_BLOCKED_JURISDICTION` (reason code, the two clauses quoted verbatim, URL, dates, FR/EN notice) — outside
  `JURISDICTION_ACK` on purpose: there is nothing to acknowledge, so the signer can never be handed an edgeX approval.
  edgeX row and section in `docs/v4/venues/jurisdiction.md`. API: `EDGEX_RESTRICTION` (EN) / `EDGEX_RESTRICTION_FR`, both
  opening with the notice "Trading unavailable: edgeX's terms exclude Canada." Web: the notice wherever dYdX shows its
  equivalent (venue list, comparison row, order panel) plus a line in the contract facts; i18n keys in one contiguous block,
  prefix `ex*`.
- **Tests.** Adapter test (constant, clauses, notice); API test (restriction text EN and FR, 403 on `/watch` and
  `POST /accounts`, no request reaching the venue).
- **Result.** Pass.
- **Limitation.** General information, not legal advice. The French and English notices in the web bundle were not checked
  in a browser (see section 6).

## 3. API (`services/api/src/derivatives/`)

- **Initial state.** Registry of three venues; per-venue failure handling already existed in `routes.ts` (`perVenue`),
  `data.ts` (`compare`) and `route.ts` (`assets`).
- **Change.** `venues.ts`: `EDGEX_RESTRICTION`, `EDGEX_FACTS`, edgeX in `createDefaultRegistry` and `createRegistry`.
  `market-texts.ts`: French notes, restriction, settlement and mark-price sentences, router terms. `route.ts`: `WALLET.edgex`.
  `index.ts`: export. No route was added: edgeX goes through the existing ones with the same caches and bounds. The paper
  worker (`worker.ts`) needs no change: it only feeds paper accounts, and none can exist on edgeX.
- **Tests.** `services/api/test/derivatives-edgex.test.ts` (9): the real server and the real adapter over fixtures —
  `/venues`, `/instruments`, `/tickers`, `/market`, `/candles`, `/funding`, `/compare`, `/route/assets`, locale `fr`;
  refusals; isolation with edgeX **throwing**, **timing out** (its own request timeout ends the wait) and throwing a
  non-venue error, while Hyperliquid, GMX and dYdX still answer and edgeX is named in `errors` with its health at `down`.
- **Result.** 9 / 9 pass. The isolation already held; the tests now prove it for a fourth venue.
- **Limitation.** A venue that hangs delays all-venue answers by up to its timeout (edgeX: 10 s, twice with the retry) —
  pre-existing behaviour of the data service, not changed here. `/market` on edgeX without a websocket returns `trades: []`
  **with** `errors.trades` saying trades are unavailable.

## 4. Smoke script (`scripts/smoke-edgex.mts`) — real output

`npx tsx scripts/smoke-edgex.mts`, 2026-11-16 00:20 UTC, exit code 0. Read-only: public GETs and public websocket only.

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

("43 frames in all" counts the whole connection, which also carries `ticker.all.1s` and the trades channel held from the
earlier steps.)

## 5. Docs

- **Change.** `docs/V11-EXCHANGE-INTEGRATIONS.md` created: edgeX chapter (decision, initial state, API, implementation, tests,
  observed results, limitations, what trading would require and from whom) and marked placeholders for Hyperliquid, GMX and
  dYdX. `docs/v4/venues/jurisdiction.md`: edgeX row and section. `docs/v11/research/edgex-api.md` copied into the branch.
- **Limitation.** The placeholders are empty headings; another work stream fills them.

## 6. Web (`apps/web`)

- **Initial state.** Venue names, colours, comparison order and texts were written for three venues; `fxVenueWhat_*`,
  `fxDiff_*`, `fxNoPaper_*` keyed by venue id.
- **Change.** `bits.tsx` (name, colour), `Compare.tsx` (order, notice on the row, `exDiff_*`, four columns when four venues),
  `Accounts.tsx` (`exVenueWhat`), `OrderPanel.tsx` (`exNoPaper`), `screens/Futures.tsx` (category and "Trading: unavailable"
  in the contract facts, pre-IPO caveat), `i18n.ts` (block `ex*`), `mock.ts` / `mockRouter.ts` (types only).
  Logo: `icons.json` declares edgeX as a generic fallback (no official mark found in a licensed registry; the ticker-keyed
  `EDGE` logo of Web3Icons could not be tied to edgeX); `gen-icons.mts`, `fetch-icons.mts`, `icons.gen.ts`, `SOURCES.md`,
  and `test/icons.test.ts` (a declared venue fallback is accepted, as for assets).
- **Tests.** `apps/web/test` (10 files) pass, including the icon check and the i18n checks; `tsc -p apps/web` and
  `vite build` pass.
- **Result.** Builds; typed.
- **Limitation.** **Not looked at in a browser, and the Playwright end-to-end suite was not run.** The mock mode (`?mock=1`,
  which the e2e suite uses) lists no edgeX instrument, so the new texts are only reachable against the real API. This is the
  least verified part of the work.

## 7. Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| edgeX tests (3 files) | 46 / 46 |
| `pnpm test` (full, run twice) | 126 files: 123 passed, 2 skipped, 1 failed; 2 728 tests: 2 668 passed, 59 skipped, 1 failed. The one failure, `services/api/test/perp-agent.test.ts` › "the laboratory itself refuses the wrong contract", is reproduced when the file runs alone, so it is not a flake. It runs the Python laboratory, whose environment (`research/.venv`, git-ignored) exists in the main checkout and not in this fresh worktree — the likely cause; it was not re-run on the untouched base to prove it. No file of this work is involved |
| `node scripts/build.mjs` | exit 0 |
| `vite build` (apps/web) | exit 0 |
| `npx tsx scripts/smoke-edgex.mts` | exit 0 (section 4) |

## 8. Files that enumerate venues, changed here (for the merge with the parallel branches)

- `packages/derivatives/src/models.ts` — `VENUE_IDS`
- `packages/derivatives/src/index.ts` — venue export
- `packages/derivatives/src/router.ts` — `ROUTER_FACTS`
- `packages/derivatives/src/live/jurisdiction.ts` — appended block (no change to `AckVenue` / `JURISDICTION_ACK`)
- `services/api/src/derivatives/venues.ts` — facts, restriction, `createDefaultRegistry`, `createRegistry`
- `services/api/src/derivatives/market-texts.ts` — `TERMS_FR`, notes, restriction
- `services/api/src/derivatives/route.ts` — `WALLET`
- `services/api/src/derivatives/index.ts` — export
- `apps/web/src/derivatives/bits.tsx` — `VENUE_NAME`, `VENUE_DOT`
- `apps/web/src/derivatives/Compare.tsx` — `ORDER`
- `apps/web/src/derivatives/mockRouter.ts` — `WALLET`, `ORDER`
- `apps/web/src/derivatives/mock.ts` — a type cast
- `apps/web/scripts/gen-icons.mts` — `VENUE_IDS`; `apps/web/scripts/fetch-icons.mts` — `VENUES`; `apps/web/src/logos/icons.json`

Not touched: the signer, `services/api/src/derivatives/exec*.ts`, `gmx-*.ts`, swaps, `services/api/src/trading-api/`,
`packages/trading`, `live/canonical.ts`, `live/mandate.ts`, `live/collateral.ts`, the perp agent, and the other venues'
adapters.
