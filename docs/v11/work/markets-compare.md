# V11 Phase E (read side) — Markets explorer and venue Comparator

Branch `v11-markets-compare`, from `v11` (5d6f325). Written 2026-11-15.
Scope: READ-ONLY public market data. No order, no account call, no signer call, no production access.
Method: every figure below was produced by code in this branch — unit tests on answers recorded from the four venues, and one
live read-only run whose output is pasted in full at the end.

Per item: initial state / change / API used / tests / observed result / limitation.

---

## 1. Symbol normalisation

**Initial state.** Instruments were matched across venues by `instrument.base` equality (old comparison table, router). That
merges nothing wrong only by luck: Hyperliquid's `kPEPE` and GMX's `kPEPE` share a name and differ by a factor of 1 000 in unit;
GMX and dYdX list `SPY`, `QQQ`, `NATGAS` without saying what they track; dYdX's halted markets carry stale prices.

**Change.** `packages/trading/src/compare/symbols.ts` (pure):

- `normaliseSymbols(instruments)` → one mapping per instrument: `{ underlying, category, multiplier, rule }` or
  `{ unmapped: reason }`. Three rules, each a checkable fact: `venue_metadata` (Hyperliquid main dex = crypto under the ticker;
  edgeX publishes a category per contract), `reviewed_ticker` (GMX and dYdX publish no category: an explicit list of 84 and 54
  tickers, reviewed 2026-11-15 on the recorded snapshot — active there, same ticker crypto on Hyperliquid or edgeX, mark within
  1 %), `reviewed_override` (the only way a multiplier contract maps: `kPEPE`/`kSHIB`/`kBONK`/`kFLOKI` ×1 000 on Hyperliquid,
  `1000PEPE` ×1 000 on edgeX, the GMX `k…` markets ×1, dYdX `PEPE`/`BONK` ×1).
- Unmapped, with a reason code, and never compared: `multiplier_unreviewed`, `no_category_metadata`, `ticker_not_reviewed`,
  `ticker_in_two_asset_classes`, `builder_dex_unreviewed`, `bad_ticker`.
- `toUnderlyingUnits(input, mapping)`: restates instrument, book and ticker per unit of the underlying (a power-of-ten
  multiplier only moves the decimal point; every USD figure is unchanged). `unitPrice`, `groupByUnderlying`.
- `priceOutliers(rows)`: runtime guard — an instrument more than 3 % from the median of its group is left out of any cross-venue
  estimate.

**API used.** None (pure). The recorded lists come from the adapters' `instruments()` and `tickers()`
(`scripts/record-markets-hub-fixtures.mts`, read-only).

**Tests.** `packages/trading/test/symbols.test.ts` (10): the four real lists (235 / 124 / 296 / 157 instruments); BTC and ETH in
four spellings; the `k` and `1000` contracts; every reviewed multiplier row and every reviewed ticker re-checked against the
recorded prices (within 1 %); same letters in two asset classes; a discrepancy between a ×1 000 and a ×1 contract computed only
after unit conversion; the outlier guard.

**Observed.** Live: 552 of 812 perps mapped (469 crypto, 71 equity, 8 commodity, 3 pre-IPO, 1 fx); 260 unmapped (244
`ticker_not_reviewed`, 6 `bad_ticker`, 5 `multiplier_unreviewed`, 5 `no_category_metadata`). 282 underlyings, 101 on several
venues, 35 on all four. PEPE unit prices on five instruments of four venues: 0.000003808 to 0.0000038106.

**Limitation.** The reviewed lists are a snapshot: a new GMX or dYdX listing stays unmapped until someone reviews it. Two venues
that both map by metadata (Hyperliquid, edgeX crypto) are trusted to mean the same asset by the same ticker; only the price guard
protects against an exception. The review was done against prices, not against each venue's index definition.

---

## 2. Markets hub API and the data service's per-venue budget

**Initial state.** `GET /api/v1/trading/markets` listed instruments (mark, funding, volume, a `stale` flag) for API keys; the web
app had no market list independent of holdings; the multi-source spot bars were never shown (audit, web-api-swaps §3.4, §5.2).
In `DerivData`, a venue that hung held every all-venue answer until its adapter's own timeout (10 to 20 s, edgeX work note).

**Change.**

- `services/api/src/derivatives/data.ts`: per-venue budget (`VENUE_BUDGET_MS` 4 000, per-instance and per-call override). Past
  it the request stops waiting: last good value marked stale with its real time (inside its bound, or whatever its age when the
  caller passes `lastGood`), else `503 venue_timeout`. The upstream call is not cancelled and fills the cache when it lands;
  requests arriving meanwhile share it and wait only for what is left of the budget. A strict caller (`within`) never gets an
  older value. `budgetStats` for diagnostics.
- `services/api/src/markets-hub/`:
  - `listing.ts` — the unified listing of the trading API, **moved** here; `trading-api/read.ts` calls it with the key's
    restrictions (one listing in the service).
  - `hub.ts` — `MarketsHub`: one snapshot over spot (the wallet's registry: 95 assets, priced from the consolidated 1 h bars of
    the market module — close, 24 h change, volume of the providing exchanges) and the perps of the four venues. Each venue is
    read on its own inside `HUB_BUDGET_MS` (2 500) with `lastGood`. Snapshot TTL 2 s, spot part 60 s, in-flight de-duplication.
    Per row: price, 24 h change and volume, funding (raw rate + interval, per hour, annualised), open interest (base and USD),
    maximum leverage, `sourceTs`, `ageMs`, `stale` per the venue's cadence (Hyperliquid and dYdX 15 s, edgeX and GMX 30 s, spot
    two bars), `tradable` + `tradableReason`, `paper`.
  - `routes.ts`, `schema.ts` — `GET /api/v1/markets-hub` (filters `kind`, `venue`, `category`, `q`, `tradable`; `sort`
    volume / openInterest / funding / change / symbol; `dir`; `limit` ≤ 500, `offset`), `/underlyings`, `/underlyings/:symbol`.
- `server.ts`: one registration.

Reason codes of `tradableReason`: `dydx_jurisdiction`, `edgex_jurisdiction`, `hl_builder_dex`, `hl_asset_not_pinned`,
`gmx_market_not_pinned`, `instrument_halted`, `instrument_reduce_only`, `spot_no_swap_route`, `spot_cash_leg`. `tradable` means
the live path exists in the code for that instrument; the server locks are reported apart (`locks`, names and states only).

**API used.** The adapters' `instruments()` and `tickers()` through `DerivData` (public endpoints, see the venue chapters of
`docs/V11-EXCHANGE-INTEGRATIONS.md`); the market module's `activeMarketConfig`, `listQuality`, `getSeries` (database).

**Tests.** `services/api/test/markets-hub.test.ts` — data service budget (4): cold hang → 503 at the budget, second request
immediate, one upstream call, cache filled when the venue finally answers; warm hang → stale value with its real time, bound
respected, `lastGood`, strict caller refused; own budget; the old all-venue comparison no longer held. Explorer (8): the listing
on the recorded answers, spot rows, filters and reason codes, the four sorts in both directions with nulls last, pagination,
de-duplication (7 concurrent reads → 1 build, 1 upstream call per venue), staleness and isolation with a throwing then a hanging
venue, cold start with both, `underlyings/:symbol`. Routes through the real server (3), including the trading API listing.

**Observed.** Live, cold caches: 907 rows built in 1.7 s; four venues `ok`, tickers 0.8 to 1.2 s old (edgeX 1 ms); 0 stale perp
row. Six concurrent reads → 1 build.

**Limitation.** The 2.5 s hub budget is close to a cold first read of dYdX or Hyperliquid (about 1.2 s each here): on a slow
network the first request can list a venue in `errors` and the next one has it. Spot prices need the wallet's database: the live
run lists the 95 spot assets without prices. Spot volume is the volume of the exchanges that provided the bars, not a market
total. `disabledAssets` of the chain adapters is not consulted for spot rows.

---

## 3. Comparator API

**Initial state.** `GET /derivatives/compare` gave contract facts per base (spread, depth within 1 %, base fee, notes) — no
slippage for a size, no total. `POST /derivatives/route` simulated one order intent with account policies. `@spw/trading` had
`venueCost`, `compareVenues`, `crossVenueDiscrepancy` (pure, not called by anything).

**Change.**

- `packages/trading/src/compare/cost.ts`: a venue **without a book** (`PoolExecution`: oracle range + price impact; GMX helpers
  `gmxPoolExecution`, `gmxFeeSchedule`, `gmxFunding` built on the router's `gmxPriceImpact`), a short-side carry of its own
  (`fundingShort`), `depthWithin` (several distances, with a "complete" flag per side), `annualiseFunding`, `executionModel` on
  the row.
- `services/api/src/markets-hub/compare.ts` — `CompareService`: one row per venue from the REAL instrument, book (GMX: pool
  figures), ticker, fee schedule (with source and date) and funding; cross-venue estimates from `findDiscrepancies`; TTL 1.5 s
  and de-duplication of identical requests.
- `GET /api/v1/markets-hub/compare?underlying=&side=&notional=&leverage=&horizonHours=[&liquidity=&minNetEdgeBps=]`.
- `DerivData.compare` (old table) takes its hourly funding from the same `annualiseFunding`.

The row, the discrepancy and the guards are described in `docs/V11-EXCHANGE-INTEGRATIONS.md`, chapter Comparator.

**API used.** Per venue: `instruments()`, `tickers()`, `book(symbol)` or `liquidity()` (GMX), all through `DerivData` with the
hub's budget.

**Tests.** `packages/trading/test/cost-pool.test.ts` (8) — pool execution hand-checked (entry 50 USD = 20 of oracle half-range
+ 30 of impact on 100 000), favourable impact not credited, impact not estimable → null with the reason, short-side carry,
`depthWithin`, the recorded GMX BTC pool, `annualiseFunding`. `services/api/test/markets-hub.test.ts`, comparator (8):

- BTC long 1 000 ×3 24 h on the recorded books — Hyperliquid **hand-checked**: mid 64 711.5, size 0.01545, entry slippage
  0.007725 USD (0.0773 bps), fees 0.449907 a leg, funding 0.299938, total **1.215202 USD = 12.1545 bps**, collateral 333.264225;
- dYdX BTC 30 000 USD walked over three recorded levels, **hand-checked**: 0.1544 @ 64 738 + 0.3088 @ 64 761 + 0.0002 @ 64 772
  = 30 006.6984 against 29 994.9552 at the mid → **11.7432 USD**;
- ETH, short side (sign of funding, GMX short net rate); a missing book → null with the reason and a null total naming the
  missing components; leverage above a venue's maximum; a hanging venue; 12 discrepancy pairs each with six assumptions and six
  risks, none flagged on the recorded books; a scripted 1 % gap flagged and not actionable (dYdX leg); a scripted 6 % gap
  treated as a data problem; the wording test.

**Observed.** See the pasted run: BTC totals 12.14 (edgeX), 13.17 (Hyperliquid), 14.84 (dYdX), 21.22 bps (GMX); no pair flagged.

**Limitation.** One snapshot; exit priced on the current book; base fee tiers; Hyperliquid's and edgeX's book snapshots end
before 10 bps on BTC (depth = lower bound, flagged); no liquidation estimate on dYdX (maintenance fraction not carried by the
adapter); GMX execution fee and gas not counted; one instrument per venue.

---

## 4. Web

**Initial state.** `Assets.tsx` (held and registry assets), perps only inside Futures, `derivatives/Compare.tsx` (facts table),
`chart.tsx` with single-series charts only; phone tab bar full at five entries.

**Change.**

- `apps/web/src/screens/Markets.tsx` — explorer: tabs perps / spot, search, venue and category chips, tradable filter, sortable
  table (desktop) / cards (phone) through the existing `DataTable`, a freshness mark with the age per row, source status strip,
  pagination, non-tradable badge with the reason sentence. A tap: spot → the Asset screen; a tradable perp → the Futures
  terminal; any other market → a **read-only sheet** (stats, price / funding chart, book, underlying and restriction) with no
  order control.
- `apps/web/src/derivatives/Compare.tsx` — `CostCompare` above the facts table: underlying picker (the comparable underlyings,
  plus a select for the rest), side, size, leverage and period typed through `amount.ts` (`compareParams` →
  `parseAmountInput`; an unreadable field shows the wallet's own sentence and keeps the last readable result on screen), the
  cost table with the itemised total, the comparison chart (funding / price gap to the median / price), the discrepancy list
  with assumptions and risks next to each estimate.
- `apps/web/src/chart-multi.tsx` + `chart-geom.ts` — `MultiSeriesChart`: hand-written SVG like `PriceChart`, several series on
  one axis, fixed series slots `--s1…--s4`, crosshair snapping to the nearest time, legend with values in text. In a module of
  its own so the first chunk does not carry it (`chart.tsx` is loaded with Home).
- `apps/web/src/markets.ts` — typed client and pure helpers.
- Navigation (least intrusive wiring): the Spot / Futures switch of the trade area becomes Spot / Futures / **Markets** (phone
  and desktop; the phone tab bar is untouched and keeps "Swap" lit); the desktop sidebar gets a direct "Markets" entry.
  Compare is the second tab of Markets (`/markets?v=compare&u=BTC`) and stays in Futures → Compare. Lazy chunk, not preloaded.
- `i18n.ts`: one contiguous `mk` / `cp` block (FR + EN). `App.tsx`: lazy route, path, trade switch, sidebar entry.

**API used.** `GET /markets-hub`, `/underlyings`, `/compare`; existing `GET /derivatives/market`, `/candles`, `/funding`,
`/instruments`, `/compare`.

**Tests.** `apps/web/test/markets.test.ts` (22, the repository's component-test style: pure helpers and source conventions):
query string, sort toggling, freshness, row target, reason codes equal to the server's, the form through the amount rule (FR /
EN spellings, ambiguous and out-of-range refused), itemised cost, coded sentences, chart geometry (axes, zero line, crosshair,
gap to median, annualised funding), no chart library, the i18n block (contiguous, both languages, same placeholders, every key
used and present), forbidden wording in the block and in the API texts, the read-only sheet has no order control.

**Observed.** `vite build`: first chunk **258.47 kB** (79.39 kB gzip); `Markets` 13.0 kB, `Compare` 33.5 kB (shared by Futures
and Markets). `pnpm typecheck` exit 0.

**Limitation.** Not run in a browser in this work: no Playwright spec and no visual baseline for the two screens (Phase I). The
third entry in the trade switch changes the existing Swap and Futures screenshots: their v9 / v10 visual baselines must be
regenerated. No watchlist. The dev-mode mocks (`derivatives/mock*.ts`) do not serve `/markets-hub`.

---

## 5. Trading API

**Change.** `compareMarkets` — `GET /api/v1/trading/markets/compare`, scope `markets:read`, same query schema
(`markets-hub/schema.ts`, pure) and same computation; a key sees only the venues and instruments it is allowed on (403
`restricted` when none). `spec.ts` entry, handler in `routes.ts`, `read.ts`. `docs/openapi/trading-v1.json` and
`docs/TRADING-API-OPENAPI.md` regenerated (`node scripts/gen-openapi.mts`): 27 operations, 15 implemented.

**Tests.** `markets-hub.test.ts` (route, spec entry, answer parsed by the declared schema, `/markets/:symbol` not shadowed);
`trading-api.test.ts` and `trading-api-unit.test.ts` pass (operation counts updated; the committed OpenAPI is what the script
writes); `apps/web/test/developer.test.ts` counts 27.

**Limitation.** Not exercised with a real key in this branch's own test (the key path — scope guard, rate limit, usage log — is
generic and covered by `trading-api.test.ts` for every declared operation).

---

## 6. Tests and verification

| Command | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm test` (with `SPW_RESEARCH_PYTHON`) | 143 files: 141 passed, 2 skipped; 3 481 tests: 3 422 passed, 59 skipped (laboratory / sandbox tests that skip themselves on this machine, as before this work), 0 failed; 20 s |
| `node scripts/build.mjs && vite build` | exit 0; first chunk 258.47 kB |
| `npx tsx scripts/smoke-markets-hub.mts` | OK (output below) |

After merging the current `v11` (private markets, SDKs, signer stabilisation) into this branch — conflicts in six shared files, all of the "both sides added a line" kind (`App.tsx`, `i18n.ts`, `server.ts`, `trading-api/read.ts`, two operation counts in tests); the trade switch now has four entries (Spot, Futures, Markets, Private markets) and scrolls sideways when it does not fit:

| Command | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm test` | 155 files, 3 782 tests: 3 721 passed, 59 skipped, **2 failed** — both in `packages/trading-sdk/test/generated.test.ts` (the SDK's generated types and its hard-coded count of 26 operations). They already fail on `v11` itself: its OpenAPI document has 29 operations since the private-markets merge and the SDK was generated at 26. Not touched here (the SDK is another work stream); the fix is `node packages/trading-sdk/scripts/gen-types.mts` plus the count in that test (30 with `compareMarkets`) |
| `node scripts/gen-openapi.mts --check` | up to date (30 operations, 18 implemented) |
| `vite build` | first chunk 260.29 kB with both new trade-area screens wired (258.47 kB on this branch alone) |

New test files: `packages/trading/test/symbols.test.ts` (10), `cost-pool.test.ts` (8), `services/api/test/markets-hub.test.ts`
(23), `apps/web/test/markets.test.ts` (22). Fixtures: `services/api/test/fixtures/markets-hub/{hyperliquid,gmx,dydx,edgex}.json`
— the adapters' normalised answers recorded read-only on 2026-11-15 (every instrument and ticker, BTC and ETH books, GMX pool
figures, 24 h of funding).

---

## 7. Docs

`docs/V11-EXCHANGE-INTEGRATIONS.md`: the Hyperliquid, GMX and dYdX chapters (trading facts from the audit, not re-audited) and a
Comparator chapter. This note.

---

## Live read-only smoke — real output

`npx tsx scripts/smoke-markets-hub.mts`, 2026-11-16 01:19 UTC. The script records every outgoing request by host and fails on a
trading or account endpoint.

```
markets-hub smoke (read-only)  2026-11-16T01:19:37.969Z   hub budget in the API: 2500 ms (this run: 8000 ms, cold caches)

== explorer: one listing over the four venues
  built in                       1692 ms; rows 907 (spot 95, perps 812); tradable from the wallet 90; stale 95
    spot                         stale, 95 rows, tickers age 0 ms
    hyperliquid                  ok, 235 rows, tickers age 1049 ms
    gmx                          ok, 124 rows, tickers age 826 ms
    dydx                         ok, 296 rows, tickers age 1176 ms
    edgex                        ok, 157 rows, tickers age 1 ms
  hyperliquid by category        crypto 232, unmapped:multiplier_unreviewed 3
  hyperliquid status / stale     active 179, halted 56; stale 0; with price 235
  gmx by category                crypto 109, unmapped:ticker_not_reviewed 11, unmapped:no_category_metadata 4
  gmx status / stale             active 124; stale 0; with price 124
  dydx by category               unmapped:ticker_not_reviewed 233, crypto 56, unmapped:bad_ticker 6, unmapped:no_category_metadata 1
  dydx status / stale            halted 239, active 57; stale 0; with price 296
  edgex by category              crypto 72, equity 71, commodity 8, pre_ipo 3, unmapped:multiplier_unreviewed 2, fx 1
  edgex status / stale           active 157; stale 0; with price 157
  perps by category              crypto 469, (not mapped) 260, equity 71, commodity 8, pre_ipo 3, fx 1
  not tradable, by reason        dydx_jurisdiction 296, hl_asset_not_pinned 176, edgex_jurisdiction 157, gmx_market_not_pinned 122, instrument_halted 56
  tradable perps                 hyperliquid:BTC, hyperliquid:ETH, hyperliquid:SOL, gmx:BTC/USD [BTC-USDC], gmx:ETH/USD [WETH-USDC]
  mapping rules                  venue_metadata 382, unmapped:ticker_not_reviewed 244, reviewed_ticker 158, reviewed_override 12, unmapped:bad_ticker 6, unmapped:multiplier_unreviewed 5, unmapped:no_category_metadata 5
  top 8 perps by 24 h volume:
    hyperliquid:BTC                    64,846  24h 3.17 %  vol 4,583,035,367 USD  OI 2,370,498,181 USD  funding 0.0000125/3600s = 10.95 %/y  age 1049 ms  tradable
    hyperliquid:ETH                   1,810.4  24h 4.53 %  vol 1,196,683,070 USD  OI 1,059,175,098 USD  funding 0.0000012322/3600s = 1.08 %/y  age 1049 ms  tradable
    hyperliquid:HYPE                    66.53  24h 4.72 %  vol 584,747,569 USD  OI 1,277,939,411 USD  funding -0.0000172913/3600s = -15.15 %/y  age 1049 ms  hl_asset_not_pinned
    hyperliquid:SOL                     71.44  24h 3.30 %  vol 351,386,980 USD  OI 328,868,536 USD  funding -0.0000064305/3600s = -5.63 %/y  age 1049 ms  tradable
    edgex:BTCUSDC                 64,820.3164  24h 1.65 %  vol 312,458,474 USD  OI 160,182,151 USD  funding 0.00005/14400s = 10.95 %/y  age 8 ms  edgex_jurisdiction
    hyperliquid:ZEC                    890.59  24h 3.92 %  vol 277,224,382 USD  OI 348,518,450 USD  funding 0.0000065594/3600s = 5.75 %/y  age 1049 ms  hl_asset_not_pinned
    edgex:ETHUSDC                  1,810.3171  24h 3.15 %  vol 238,577,832 USD  OI 51,531,456 USD  funding 0.00005/14400s = 10.95 %/y  age 8 ms  edgex_jurisdiction
    hyperliquid:XRP                    0.9595  24h 4.52 %  vol 88,940,013 USD  OI 71,746,101 USD  funding -0.0000130245/3600s = -11.41 %/y  age 1049 ms  hl_asset_not_pinned
  underlyings                    282; on several venues 101; on all four 35
  PEPE (multiplier check)        hyperliquid:kPEPE ×1000 → 0.000003808 | edgex:1000PEPEUSDC ×1000 → 0.000003809256350892475 | gmx:kPEPE/USD [WETH-USDC] ×1 → 0.0000038105865 | gmx:kPEPE/USD [PEPE-USDC] ×1 → 0.0000038105865 | dydx:PEPE-USD ×1 → 0.0000038090538675

== compare BTC long 1000 USD ×3 over 24 h
  computed in                    276 ms
  hyperliquid — hyperliquid:BTC  age 1078 ms
      mid 64,843.5  mark 64,846  spread 0.1542 bps  depth 10bps bid 6,360,687+ / ask 5,748,377+; 25bps bid 6,360,687+ / ask 5,748,377+; 50bps bid 6,360,687+ / ask 5,748,377+
      size 0.01542  entry slippage 0.00771 USD (0.0771 bps)  exit slippage 0.10949 USD
      fees taker 0.00045 maker 0.00015 (as of 2026-11-10): entry 0.449949 + exit 0.449949 USD
      funding 0.0000125 per 3600 s = 10.95 %/y → expected 0.299966 USD over the horizon (current rate held constant)
      max leverage 40×  collateral 333.3 USD  liquidation 43,776.54 (3,249 bps away)
      TOTAL 1.317064 USD = 13.1721 bps
  gmx — gmx:BTC/USD [BTC-USDC]  age 1379 ms
      mid 64,841.68  mark 64,839.62  spread 0 bps  depth null (this venue has no order book: trades execute against a liquidity pool at the oracle price)
      size 0.015422  entry slippage 0.392754 USD (3.9275 bps)  exit slippage 0 USD
      fees taker 0.0006 maker 0.0004 (as of 2026-11-16): entry 0.6 + exit 0.6 USD
      funding 0.0000220486619679284322191412 per 3600 s = 19.31 %/y → expected 0.529168 USD over the horizon (current rate held constant)
      max leverage 200×  collateral 333.33 USD  liquidation 43,462.07 (3,300 bps away)
      TOTAL 2.121922 USD = 21.2192 bps
  dydx — dydx:BTC-USD  [not tradable from the wallet: dydx_jurisdiction]  age 1337 ms
      mid 64,857.5  mark 64,818.33  spread 2.0044 bps  depth 10bps bid 297,166 / ask 501,159; 25bps bid 2,532,295 / ask 1,550,722; 50bps bid 3,647,371 / ask 2,474,072
      size 0.0154  entry slippage 0.1001 USD (1.0022 bps)  exit slippage 0.1001 USD
      fees taker 0.0005 maker 0.0001 (as of 2026-11-10): entry 0.499403 + exit 0.499403 USD
      funding 0.00001179605263157895 per 3600 s = 10.33 %/y → expected 0.282767 USD over the horizon (current rate held constant)
      max leverage 50×  collateral 332.94 USD  liquidation null (the maintenance margin fraction was not supplied) (null (the maintenance margin fraction was not supplied) bps away)
      TOTAL 1.481773 USD = 14.8355 bps
  edgex — edgex:BTCUSDC  [not tradable from the wallet: edgex_jurisdiction]  age 37 ms
      mid 64,818.55  mark 64,820.32  spread 0.1388 bps  depth 10bps bid 10,831,454+ / ask 10,951,327+; 25bps bid 10,831,454+ / ask 10,951,327+; 50bps bid 10,831,454+ / ask 10,951,327+
      size 0.015  entry slippage 0.00675 USD (0.0694 bps)  exit slippage 0.00675 USD
      fees taker 0.00045 maker 0.0004 (as of 2026-11-16): entry 0.437525 + exit 0.437525 USD
      funding 0.00005 per 14400 s = 10.95 %/y → expected 0.291683 USD over the horizon (current rate held constant)
      max leverage 100×  collateral 324.09 USD  liquidation 43,429.82 (3,300 bps away)
      TOTAL 1.180233 USD = 12.1388 bps
  discrepancy estimates          12 ordered pairs; with an estimate 12; flagged (net estimate > 0 bps) 0
    long edgex / short dydx: gross gap 4.9368 bps, netEdgeEstimateBps -15.3085  [a leg is not tradable from the wallet]
    long edgex / short hyperliquid: gross gap 2.686 bps, netEdgeEstimateBps -15.4627  [a leg is not tradable from the wallet]
    long edgex / short gmx: gross gap 3.4983 bps, netEdgeEstimateBps -19.1999  [a leg is not tradable from the wallet]
    long hyperliquid / short dydx: gross gap 1.0795 bps, netEdgeEstimateBps -20.1882  [a leg is not tradable from the wallet]
    each with 6 assumptions and 6 risks, e.g. « both legs are closed at the same time, at ONE common price: the two venues' prices are assumed to converge by the end of the horizon » / « execution risk: one leg can fill and the other not, or at a worse price; the books move between the two orders »

== compare ETH long 1000 USD ×3 over 24 h
  computed in                    226 ms
  hyperliquid — hyperliquid:ETH  age 1356 ms
      mid 1,810.35  mark 1,810.4  spread 0.5524 bps  depth 10bps bid 5,313,805 / ask 4,770,008; 25bps bid 5,734,093+ / ask 5,354,786+; 50bps bid 5,734,093+ / ask 5,354,786+
      size 0.5523  entry slippage 0.027615 USD (0.2762 bps)  exit slippage 0.027615 USD
      fees taker 0.00045 maker 0.00015 (as of 2026-11-10): entry 0.449935 + exit 0.449935 USD
      funding 0.0000012322 per 3600 s = 1.08 %/y → expected 0.029569 USD over the horizon (current rate held constant)
      max leverage 25×  collateral 333.29 USD  liquidation 1,231.56 (3,197 bps away)
      TOTAL 0.984669 USD = 9.8481 bps
  gmx — gmx:ETH/USD [WETH-USDC]  age 1657 ms
      mid 1,810.53  mark 1,810.51  spread 0 bps  depth null (this venue has no order book: trades execute against a liquidity pool at the oracle price)
      size 0.552325  entry slippage 0 USD (0 bps)  exit slippage 0.351384 USD
      fees taker 0.0006 maker 0.0004 (as of 2026-11-16): entry 0.6 + exit 0.6 USD
      funding -0.0000240371870473223447234076 per 3600 s = -21.06 %/y → expected -0.576892 USD over the horizon (current rate held constant)
      max leverage 200×  collateral 333.33 USD  liquidation 1,213.09 (3,300 bps away)
      TOTAL 0.974492 USD = 9.7449 bps
  dydx — dydx:ETH-USD  [not tradable from the wallet: dydx_jurisdiction]  age 1615 ms
      mid 1,809.95  mark 1,810.86  spread 3.8675 bps  depth 10bps bid 91,407 / ask 869,434; 25bps bid 2,289,306 / ask 3,093,671; 50bps bid 3,886,172 / ask 3,961,339
      size 0.552  entry slippage 0.1932 USD (1.9338 bps)  exit slippage 0.1932 USD
      fees taker 0.0005 maker 0.0001 (as of 2026-11-10): entry 0.499546 + exit 0.499546 USD
      funding -0.00002669078947368421 per 3600 s = -23.38 %/y → expected -0.639998 USD over the horizon (current rate held constant)
      max leverage 50×  collateral 333.03 USD  liquidation null (the maintenance margin fraction was not supplied) (null (the maintenance margin fraction was not supplied) bps away)
      TOTAL 0.745494 USD = 7.4617 bps
  edgex — edgex:ETHUSDC  [not tradable from the wallet: edgex_jurisdiction]  age 315 ms
      mid 1,809.89  mark 1,810.32  spread 0.3315 bps  depth 10bps bid 14,409,947 / ask 10,478,093; 25bps bid 15,580,941 / ask 12,313,122; 50bps bid 17,959,613 / ask 14,139,515
      size 0.55  entry slippage 0.0374 USD (0.3757 bps)  exit slippage 0.0325 USD
      fees taker 0.00045 maker 0.0004 (as of 2026-11-16): entry 0.447948 + exit 0.447948 USD
      funding 0.00005 per 14400 s = 10.95 %/y → expected 0.298632 USD over the horizon (current rate held constant)
      max leverage 100×  collateral 331.81 USD  liquidation 1,212.7 (3,300 bps away)
      TOTAL 1.264428 USD = 12.7022 bps
  discrepancy estimates          12 ordered pairs; with an estimate 12; flagged (net estimate > 0 bps) 0
    long dydx / short edgex: gross gap -2.5912 bps, netEdgeEstimateBps -14.4924  [a leg is not tradable from the wallet]
    long dydx / short hyperliquid: gross gap 0 bps, netEdgeEstimateBps -14.5076  [a leg is not tradable from the wallet]
    long hyperliquid / short edgex: gross gap -3.1435 bps, netEdgeEstimateBps -19.089  [a leg is not tradable from the wallet]
    long edgex / short hyperliquid: gross gap 1.8895 bps, netEdgeEstimateBps -19.4189  [a leg is not tradable from the wallet]
    each with 6 assumptions and 6 risks, e.g. « both legs are closed at the same time, at ONE common price: the two venues' prices are assumed to converge by the end of the horizon » / « execution risk: one leg can fill and the other not, or at a worse price; the books move between the two orders »

== request de-duplication and cache
  6 concurrent reads             1 listing build, 1 comparison computed

== outgoing requests (host, count)
  GET arbitrum.gmxapi.io         9
  GET edgex-prod-v2.edgex.exchange 5
  GET indexer.dydx.trade         6
  POST api.hyperliquid.xyz       6
  trading / account endpoints    none

OK
```
