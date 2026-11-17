# V11 — API Bricks (CoinAPI) as a second market-data source: work note

Branch `v11-apibricks` (from local `v11` at `9561d78`), 2026-11-17 07:50–08:40 UTC. Nothing pushed, nothing deployed,
production untouched, no node contacted. **Read-only market data**: no order, no transaction, no account call.

The owner supplied an API key "pour market data". It was read from a file outside the repository into the environment
of the commands that needed it, sent only as a header to the provider's official hosts, and is in no file of the
repository, no fixture, no commit message and no output pasted below (section 8).

Chapter: `docs/V11-MARKET-DATA-SOURCES.md`. Dossier: `docs/v11/research/apibricks.md`.

## 0. What the key is, in one paragraph

API BRICKS operates CoinAPI (crypto) and FinFeedAPI (stocks, FX, SEC, prediction markets). The key answers on **every
product tried** (eight REST hosts and the WebSocket). Usage is **metered per credit**; the Market Data host says what each
call cost (`x-ratelimit-request-cost: 1`) but **nothing says what is left**: the plan and the balance are visible only in
the provider's console, which this work could not see. Limits reported by the provider itself: 160 requests a minute,
4 concurrent. Published price on pay-as-you-go: 5.26 USD per 1 000 credits (first tier of a day), 25 USD of free credits
for a new account.

## 1. Establishing the API

- **Initial state.** Nothing about this provider in the repository.
- **Change.** `docs/v11/research/apibricks.md`: what was called (with trimmed real answers), what is only documented,
  what is unknown, the licence clauses, the sources.
- **Tests.** Six recorded answers kept as fixtures (rates, two OHLCV pages, three error bodies) and four metadata
  captures; the client, the parsers and the mapping are tested on them.
- **Observed.** Key accepted. One credit per call (a 77-asset rate list included). Full history (Gemini BTC/USD from
  2015-10-08). `x-tierlimit-*` headers the documentation does not mention; none of the documented remaining / quota
  headers. Error bodies `{ "error": … }` with 401 / 400 / 550. WebSocket: `exrate` messages at the cadence asked.
- **Limitations.** Plan, balance, cost of the non-Market-Data hosts, exhaustion behaviour: unknown. Two quality defects
  on one Gemini series (off-market prints in 4 of 24 hourly bars; a crossed, stale "current" book). Documentation read
  through excerpts.

## 2a. Second price source (portfolio and spot marks)

- **Initial state.** `server.ts` `markets()`: CoinGecko only; `priceAt` and `stale` since the stabilisation;
  `/portfolio` said `priceSource: 'coingecko'` as a constant; the risk service labelled its outside reference `coingecko`
  as a constant.
- **Change.**
  - `prices/cross.ts` — the rule (primary displayed; labelled failover; comparison without averaging; time-skew guard).
  - `apibricks/prices.ts` — one batched rate call for every mapped asset and CAD, cached, stale-on-error, retry pause,
    no retry while the budget is spent.
  - `apibricks/mapping.ts` + generated `apibricks/asset-map.ts` (`scripts/gen-apibricks-assets.mts`) — exact id +
    evidence (shared contract address, or reviewed native coin; never on a conflicting address) + price agreement at
    generation. 42 of 95 mapped (20 address, 20 reviewed, 2 aliases); 53 not, each with its reason.
  - `server.ts` — `markets()` = CoinGecko list crossed with the second list; `/portfolio` gains `source`, `fallback`,
    `sources`, `divergent`, `divergenceBps` per price, `priceSource` (`coingecko | apibricks | mixed`) and
    `priceSources`. The CoinGecko id table moved to `prices/coingecko-ids.ts`, unchanged.
  - `trading-api/read.ts` — each wallet row of the portfolio read: `priceSource`, `priceAt`, `priceDivergent`,
    `priceDivergenceBps` (the rows are an open object in the contract: the OpenAPI document and the SDKs are unchanged).
  - `risk/service.ts` — the outside reference carries the name of the source that gave it. `apibricks` has no entry in
    `maxPriceAgeMs.per`, so a fallback price is judged with the strict default age: it loosens nothing.
  - Web: Dashboard price-freshness panel, one row "Sources de prix" (`data-testid="db-price-sources"`); i18n block `ab*`.
- **Tests.** Mapping (4), prices (4), cross-check (5) in `apibricks.test.ts`.
- **Observed.** BTC / ETH / SOL / USDC: 3.7 / 1.8 / 5.0 / 1.1 bps between the two sources, dates 9.5 s apart.
- **Limitations.** Comparable only when the dates are within 10 minutes (about a third of the time at the default
  30-minute refresh). Two aggregates of the same exchanges. A fallback price has no daily change or sparkline of its own.
  53 symbols unchanged. No end-to-end test of `/portfolio` with a key (the route's logic is `crossCheck`, tested; the
  wiring is typechecked and exercised without a key by the existing API tests).

## 2b. Additional confirming source of the market module

- **Initial state.** Three sources (`coinbase`, `bitstamp`, `kraken`), a fixed tuple of ids; a bar is usable when a
  second source confirms it within 50 bps.
- **Change.**
  - `market/types.ts` — `SOURCE_IDS` gains `apibricks` (`BASE_SOURCE_IDS` = the three); `MarketSource` gains optional
    `intervals` and `ready()`.
  - `market/quality.ts` — `DEFAULT_PRIORITY` is the three exchanges; `addConfirmingSource` appends a source **last**.
  - `market/sources.ts` — `registerMarketSource`; `defaultSources()` appends registered sources; the independence rule
    is stated there.
  - `market/pipeline.ts` — a pass skips an interval a source does not serve and a source that is not ready.
  - `apibricks/market-source.ts`, `apibricks/venues.ts` — the source and the independence rule; 11 pairs (10 Gemini,
    1 Bitfinex) selected from the provider's symbol metadata.
  - `apibricks/index.ts` — built and registered only with the key.
- **Tests.** 7 in `apibricks.test.ts`, one of them on **real bars of the same 24 hours** from Coinbase (read directly)
  and from the provider's Gemini series.
- **Observed.** 20 of 24 hourly closes within 5 bps (median 2.3); 4 closes 465–508 bps off, on the provider's side. The
  gate answers `ok` on a window of good bars and `disagreement` on a window ending on a bad one; with a third exchange
  agreeing, the bad bar is recorded and does not block (existing rule).
- **Limitations.** Daily bars of 8 symbols by default (credits). The series sometimes fails to confirm a good bar. Not
  run against a database: the store and the worker were not exercised with this source (they are source-agnostic; the
  adapter, the validation and the gate are what was tested).

## 2c. Quote hub upstream

- **Initial state.** `spotUpstream`: Coinbase websocket, else the price list polled every 60 s (`coingecko-rest`).
- **Change.** `quotes/upstreams.ts` — an injected `SecondSpotSource` (own map, timer, counters); `quotes/index.ts`,
  `quotes/engine.ts` — it is passed in, and `/api/v1/stream/stats` gains `metered` (also in the monitor's summary);
  `monitor/routes.ts` — `marketData.apibricks`; Monitor screen — one row with the day's counter or "Clé absente";
  `capabilities.ts` — `market_data_apibricks`.
- **Tests.** 4 with a scripted source: normalised quote and source name, one feed for two subscribers and none when
  nobody listens, `down` + `quota` on the venue, the channel and the statistics and the return to `connected`,
  isolation from the two other paths, unchanged without it.
- **Observed.** REST polling only. The WebSocket was probed for 8 seconds: it works on this key (8 `exrate` messages,
  1 278 bytes, at the 2-second limit asked).
- **Limitations.** 30 polls a day by default: a channel on such a symbol goes `down: quota` after 2.5 hours of
  continuous subscription. `last` only. The WebSocket would probably cost far less for the same cadence; it is not
  integrated because its billing could not be confirmed.

## 2d. Research data

- **Initial state.** Public keyless loaders; 180 days of history (the venues' own limits).
- **Change.** `research/src/spq/data/apibricks.py` — loader, capture manifest, cost estimate, ceiling before any call,
  `overlap_check`, `--dry-run`.
- **Tests.** `research/tests/test_apibricks_data.py` (4) on the recorded page.
- **Observed.** The provider has `HYPERLIQUID_PERP_{BTC,ETH,SOL}_USDC` since 2024-09-27 (one metadata call).
- **Limitation.** **No pull**: ≈ 194 credits per two-year hourly series, 1 750 for the study's nine series. Cost on
  pay-as-you-go ≈ 7.2 USD once; on the Startup plan two days of quota. Not wired into `spq data pull`.

## 3. Configuration and secrets

- **Change.** `config.ts` — `config.apibricks` (the key and ten settings); `apibricks/redact.ts`; `client.ts` (host
  constant, header only, refused paths); `docs/runbooks/deploy.md`, `docs/V11-DEPLOYMENT.md` §4.3, §4.4, §5.
- **Tests.** Redaction (3): every place a key can travel; an upstream error echoing the key in a URL or a header is
  scrubbed before it is thrown or kept in the statistics; the capability line and the status never hold a value.
- **Limitation.** The defaults are derived from the published prices, not from the account's real plan.

## 4. Smoke — `scripts/smoke-apibricks.mts --all-products`, run once

```
API Bricks smoke — 2026-11-17T08:16:40.532Z — host rest.coinapi.io, key in header X-CoinAPI-Key (not shown)

1. Products
   available   Market Data REST (CoinAPI) (cost 1)
   available   Exchange Rates, realtime (CoinAPI)
   available   Exchange Rates, historical (CoinAPI)
   available   Indexes (CoinAPI)
   available   Currencies / FX (FinFeedAPI)
   available   Stocks, historical (FinFeedAPI)
   available   SEC filings (FinFeedAPI)
   available   Prediction markets (FinFeedAPI)

2. Prices (primary CoinGecko, second API Bricks) — nothing is averaged
   BTC   coingecko 64557              at 2026-11-17T08:16:40.000Z | apibricks 64533.2937850358   at 2026-11-17T08:16:49.500Z | divergence 3.7 bps | displayed: coingecko — mapping reviewed
   ETH   coingecko 1828.98            at 2026-11-17T08:16:40.000Z | apibricks 1829.3030017695    at 2026-11-17T08:16:49.500Z | divergence 1.8 bps | displayed: coingecko — mapping reviewed
   SOL   coingecko 72.66              at 2026-11-17T08:16:40.000Z | apibricks 72.6235511158944   at 2026-11-17T08:16:49.500Z | divergence 5 bps | displayed: coingecko — mapping reviewed
   USDC  coingecko 0.999667           at 2026-11-17T08:16:40.000Z | apibricks 0.999772561242129  at 2026-11-17T08:16:49.500Z | divergence 1.1 bps | displayed: coingecko — mapping address

3. Market source (an exchange the wallet does not read itself)
   GEMINI_SPOT_BTC_USD 1d: 3 closed bars, 0 rejected by validation
   2026-11-14  open 68283.48  high 69297.04  low 63299  close 67617.14  volume 384.9628
   2026-11-15  open 64126.31  high 68446.845  low 61998  close 68211.635  volume 233.7650
   2026-11-16  open 65336.59  high 68200.05  low 63842  close 67959.68  volume 207.7040

4. Quota
   this run: 10 calls, 10 credits (2 through the metered client, as the provider's x-ratelimit-request-cost says; 8 product probes counted 1 each)
   local budget of this run: 2 / 6 used, 4 remaining
   provider: per-minute limit 160, concurrency 4; remaining credits are NOT reported in any response header on this plan — only the provider's console shows the balance

OK
```

Reading of section 3 of that output: the three daily bars pass the per-bar validation, and they also show the defect of
§2b — each closes about 3 000 USD above the next day's open. The cross-source gate, not the per-bar validation, is what
catches it.

## 5. Live calls and credits

| What | Calls | Credits |
|---|---|---|
| Market Data REST by hand | 17 | 17 |
| Other products, one call each | 7 | 7 (no cost header: counted 1 each) |
| Mapping generator | 4 | 4 |
| Smoke, once | 10 | 10 |
| **Total with the owner's key** | **38 REST calls** | **≈ 38 credits** (≈ 0.20 USD at the published first-tier price) |
| WebSocket | 1 session, 8 s, 1 278 bytes | negligible |

Answers were cached in a private scratch directory under `/tmp` and reused (the generator's `--cache`); nothing was
fetched twice.

## 6. Verification

- `pnpm typecheck`: exit 0.
- `services/api/test/apibricks.test.ts`: 37 passed. `research/tests/test_apibricks_data.py`: 4 passed.
- Neighbouring pure suites while working: `market-engine`, `quotes-hub`, `gecko`, all of `apps/web/test` — passed.
- Build: `node scripts/build.mjs` and `vite build` — first chunk **262.32 kB** (81.07 kB gzip): unchanged class.
- Full `pnpm test`, once, without the key in the environment (131 s): 195 files, 4 531 tests — **4 530 passed, 1 failed**:
  `hardening-e.test.ts` pins the start of the capability line, and the new capability had been inserted in the middle of
  the list. Fix: `market_data_apibricks` is now the LAST capability (the pinned prefix is unchanged; that test file was
  not edited). The full suite was **not** run a second time (another workstream is timing-sensitive on this machine):
  after the fix only `hardening-e.test.ts` and `apibricks.test.ts` were rerun — 42 passed — and `pnpm typecheck` exit 0.
  The lab tests ran inside that full run (`research/.venv` synced in the worktree, not committed).
- Search of the tree, of the branch history and of the scratch directory for the key and for its hexadecimal part:
  0 everywhere (section 8).

## 7. Files touched outside the new modules

```
services/api/src/server.ts             markets() crossed with the second source; /portfolio fields; stream wiring; id table moved out
services/api/src/config.ts             config.apibricks
services/api/src/capabilities.ts       market_data_apibricks
services/api/src/market/types.ts       SOURCE_IDS + 'apibricks'; MarketSource.intervals / ready
services/api/src/market/quality.ts     DEFAULT_PRIORITY = the three exchanges; addConfirmingSource
services/api/src/market/sources.ts     registerMarketSource; defaultSources appends
services/api/src/market/pipeline.ts    skip an unserved interval / a source that is not ready
services/api/src/quotes/upstreams.ts   SecondSpotSource in spotUpstream
services/api/src/quotes/index.ts       passes it; `metered`
services/api/src/quotes/engine.ts      `metered` in the statistics and the summary
services/api/src/monitor/routes.ts     marketData.apibricks
services/api/src/risk/service.ts       the reference's real source name
services/api/src/orders/index.ts       type of the price list (source)
services/api/src/trading-api/read.ts   priceSource / priceAt / priceDivergent on wallet rows
services/api/test/market-engine.test.ts   one import alias (the three exchanges' type)
apps/web/src/hooks.ts  i18n.ts  screens/Dashboard.tsx  screens/Monitor.tsx
docs/V11-REMAINING-LIMITATIONS.md (7.2, 8.3, §13)  V11-DEPLOYMENT.md (§4.3, §4.4, §5)  runbooks/deploy.md
docs/V11-QUOTE-ENGINE.md (§2)  TRADING-BACKTESTING.md (history)
```

Not touched: `services/isolated-signer/**`, `packages/**`, the OpenAPI document, the SDKs, any migration.

## 8. The key

- Read with `set -a; . <file>; set +a` inside wrapper scripts kept in the scratch directory; never printed, never passed
  on a command line, never written.
- Sent to: `rest.coinapi.io`, `api-realtime.exrates.coinapi.io`, `api-historical.exrates.coinapi.io`,
  `rest-api.indexes.coinapi.io`, `ws.coinapi.io`, `api-realtime.fx.finfeedapi.com`,
  `api-historical.stock.finfeedapi.com`, `api.sec.finfeedapi.com`, `api.prediction-markets.finfeedapi.com` — all named by
  the provider's documentation or published specifications. To no other host.
- The key's prefix appears nowhere in the repository: the code assembles it (`redact.ts` `KEY_PREFIX`), the tests build a
  made-up key from it, the documents spell it out in words. `git grep` for the prefix returns nothing.
- Fixtures: response bodies only (rates, bars, asset and symbol metadata trimmed to the fields read, three error
  bodies) — no header, no URL with a credential.

## 9. Not done

- No end-to-end run of the API with the key (no stack was started: ports reserved by another workstream).
- No browser run of the Dashboard row or of the Monitor row (typechecked and built; rendered logic is in the server
  answer, which is tested).
- WebSocket upstream; research pull; mapping of more symbols; a per-source maximum age for `apibricks` in the risk limits
  (an owner decision).
- The plan and the balance of the account: to be read by the owner in the provider's console before enabling.
