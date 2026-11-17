# API Bricks (CoinAPI / FinFeedAPI) — dossier for the wallet's second market-data source

Date: **2026-11-17**, 07:53–08:17 UTC, from a residential connection in Québec, with the owner's API key ("pour market
data"). Read-only: no order, no account call, no trading endpoint. The key appears nowhere in this document, in the
repository or in a recorded fixture.

Evidence classes used below:

- **[LIVE]** — called today with the owner's key; the request and a trimmed real answer are shown;
- **[DOC]** — the provider's own documentation, specification or legal page, read today; not called;
- **[UNKNOWN]** — neither; stated as such.

Method caveat for [DOC]: the pages were read through a fetch tool that returns excerpts; quotes are as returned, long
clauses could not be retrieved in full. Where two official pages disagree, both are given.

---

## 0. Executive summary

1. **The provider is what the owner described.** API BRICKS (`www.apibricks.io`) "builds and operates" two brands:
   **CoinAPI** (crypto market data: `www.coinapi.io`) and **FinFeedAPI** (stocks, FX, SEC filings, prediction markets:
   `www.finfeedapi.com`). Keys are created in one console (`console.apibricks.io`). [DOC]
2. **The key works, and it unlocks every product tried**: CoinAPI Market Data REST, Exchange Rates (realtime and
   historical), Indexes, the WebSocket, and FinFeedAPI FX, Stocks, SEC and Prediction Markets — eight REST hosts answered
   HTTP 200, the WebSocket streamed. [LIVE]
3. **The plan is metered, and the balance cannot be read through the API.** Every Market Data answer carries
   `x-ratelimit-request-cost: 1`; **no** `X-Credits-*`, `X-RateLimit-Remaining` or quota header came back on any of the 38
   calls. The provider's per-minute limits did: `x-tierlimit-rpm-limit: 160`, `x-tierlimit-concurrency-limit: 4` (two
   headers its documentation does not mention). Which plan the key is on, and what is left on it, is visible **only in
   the console** — this dossier does not know it. The published pay-as-you-go price is 5.26 USD per 1 000 REST credits a
   day (first tier), with "25.00 USD Free Credits" for a new account. [LIVE + DOC]
4. **Cost model verified**: one credit per call, including a rate list of 77 assets in one call and an OHLCV page.
   With `limit`, one credit per 100 rows returned. [LIVE + DOC]
5. **Full history is served** (Gemini BTC/USD daily bars from 2015-10-08, the pair's first day). [LIVE]
6. **A ticker is not an identity at this provider**: its metadata names `OP` "Operand", `ARB` "ARbit", `GMX` "GoldMaxCoin";
   its contract addresses for WBTC, WETH, USDS, USDG and USDD are not the wallet registry's. 42 of the wallet's 95 priced
   symbols map with certainty; the rest keep one price source. [LIVE]
7. **Data-quality defects observed today on one exchange-specific series** (`GEMINI_SPOT_BTC_USD`): 4 of 24 hourly bars
   close 465–508 bps above Coinbase's bar of the same hour; the "current" quote and order book are crossed (bid above ask)
   and 75 minutes old. Exchange-specific OHLCV is therefore usable only behind the market module's cross-source gate —
   which is how it is integrated — and quotes / books are not used at all. [LIVE]
8. **Licence**: the Customer Agreement grants use "for your internal business purposes only"; showing the data to third
   parties "may be considered redistribution". A single-owner, self-hosted wallet that shows the data to its owner only
   fits the first; anything public would not. No clause about caching was found. [DOC]

What the key does **not** allow (or what is not established):

- reading the remaining balance, the plan or the usage by API — console only [LIVE: no header; DOC: a "Subscription
  Management API" is mentioned in the FAQ but its page no longer exists → UNKNOWN];
- redistribution of raw or normalised data to anyone else [DOC];
- nothing was tried, and nothing may be tried, on the provider's trading products ("EMS Trading API", "Exchange Link"):
  out of scope by decision, not by test;
- FIX, flat files / S3: not tried [UNKNOWN whether the key covers them].

---

## 1. Verified live today

All requests: `GET`, header `X-CoinAPI-Key: <key>` (never the query string), `Accept: application/json`.
38 REST calls with the owner's key (36 × 200, 1 × 400, 1 × 550), one 8-second WebSocket session, two calls **without** the
key to read the error shape. Section 9 has the full tally.

### 1.1 Authentication and error shapes

```
GET https://rest.coinapi.io/v1/exchangerate/BTC/USD            (no key)
HTTP 401 {"error": "You did not provided API Key or it is incorrectly formatted. You should do it in: query string
  parameter [apikey], in http header named [X-CoinAPI-Key], [X-APIBricks-Key], [X-APIKey], in http authorization header
  named [Authorization] or as part of URL /apikey-YOUR-API-KEY/"}

GET …/v1/exchangerate/BTC/USD                                  (a made-up key of the published shape)
HTTP 401 {"error": "Invalid API key format."}

GET …/v1/ohlcv/GEMINI_SPOT_NOPE_USD/latest?period_id=1DAY&limit=2
HTTP 400 {"error": "Bad request - symbol not found: GEMINI_SPOT_NOPE_USD. Use metadata_list_symbols to find valid symbols."}

GET …/v1/exchangerate/NOPEXYZQ/USD
HTTP 550 {"error": "You requested specific single item that we don't have at this moment."}
```

Error answers carry **no** `x-ratelimit-request-cost` header: the wallet counts one credit for them.
The key format published by the provider — the letters `abk`, an underscore, 32 hexadecimal characters and 8 of checksum;
"A value that starts with [that prefix] but has a wrong checksum is rejected" — matches the owner's key (44 characters,
that prefix). [DOC + LIVE]

Response headers of a successful Market Data call (all of them):

```
content-type: application/json; charset=utf-8
x-tierlimit-concurrency-limit: 4
x-tierlimit-concurrency-remaining: 4
x-tierlimit-rpm-limit: 160
x-tierlimit-rpm-remaining: 160
x-ratelimit-request-cost: 1
```

### 1.2 Exchange rates (the wallet's second price list)

```
GET https://rest.coinapi.io/v1/exchangerate/BTC/USD                                   cost 1
{"time": "2026-11-17T07:53:00.7000000Z", "asset_id_base": "BTC", "asset_id_quote": "USD", "rate": 64618.455790259}

GET https://rest.coinapi.io/v1/exchangerate/USD?invert=true&filter_asset_id=BTC;ETH;SOL;USDC;USDT;CAD;LINK;…   cost 1
{"asset_id_base": "USD", "rates": [
  {"time": "2026-11-17T07:55:03.4000000Z", "asset_id_quote": "AAVE", "rate": 113.309130637238},
  {"time": "2026-11-17T07:55:03.4000000Z", "asset_id_quote": "BTC",  "rate": 64641.2470293281},
  {"time": "2026-11-17T07:55:03.4000000Z", "asset_id_quote": "CAD",  "rate": 0.698663188363364}, … ]}
```

- With `invert=true` the rate is **USD for one unit of the asset**. A fiat asset (`CAD`) comes in the same answer: the
  CAD price is `usd / rate(CAD)`.
- **One credit whatever the number of assets** (13 and 77 assets: cost 1 each).
- Each rate has its own `time`; it was within seconds of the request on every row.
- What the number is [DOC]: "Spot rates as a twenty-four hour rolling VWAP across curated markets and pairs"; "(VWAP-24H)
  last 24 hour (rolling window over time) Volume Weighted Average Price" "across multiple data sources listed on our
  platform". The list of exchanges is not published [UNKNOWN]. **Observed**: the BTC rate was 3.7 bps from CoinGecko's
  price read 9 seconds earlier, the day after Coinbase's hourly closes had ranged from 64 094 to 65 257 — it behaves as a
  current aggregate, not as a 24-hour average price (the documentation's wording alone would suggest the latter). 42 assets compared with CoinGecko at one instant: all within 48 bps, median
  7.6 bps (`asset-map.ts`, column `checkBps`).

### 1.3 OHLCV (the additional confirming market source; the research loader)

```
GET …/v1/ohlcv/GEMINI_SPOT_BTC_USD/history?period_id=1HRS&time_start=2026-11-16T00:00:00&time_end=2026-11-17T00:00:00&limit=100   cost 1
[{"time_period_start": "2026-11-16T00:00:00.0000000Z", "time_period_end": "2026-11-16T01:00:00.0000000Z",
  "time_open": "2026-11-16T00:00:07.9310000Z", "time_close": "2026-11-16T00:59:58.6990000Z",
  "price_open": 65336.59, "price_high": 65381.25, "price_low": 64672.78, "price_close": 64889.49,
  "volume_traded": 7.868132579999993, "trades_count": 570}, … 24 bars, oldest first]

GET …/v1/ohlcv/GEMINI_SPOT_BTC_USD/latest?period_id=1DAY&limit=5      cost 1   newest first; the first row is the OPEN bar
GET …/v1/ohlcv/GEMINI_SPOT_BTC_USD/history?period_id=1DAY&time_start=2015-10-08T00:00:00&limit=3   cost 1
[{"time_period_start": "2015-10-08T00:00:00.0000000Z", … "price_open": 242.5, "price_high": 245, "price_low": 242.5, …}]
GET …/v1/ohlcv/periods      cost 1    1SEC … 1MIN, 5MIN … 1HRS … 1DAY … 5YRS  (43 periods)
```

- Bars are aligned on UTC (`1DAY` opens at 00:00:00Z); `time_period_start` is the bar-open time.
- `history` is oldest first, `latest` newest first; the bar in progress is included, unmarked.
- `time_start` / `time_end` without a zone suffix are read as UTC.
- Periods without a trade: the FAQ says "no OHLCV record will be generated"; a blog page says the opposite [DOC,
  contradictory]. The 24 hours read had no empty hour: **not settled by observation**. The wallet treats a missing bar as
  a gap, like Coinbase's.
- **Quality defect [LIVE]** — the same 24 hours of Coinbase's own BTC-USD candles (public, keyless) against the
  provider's Gemini series: 20 closes within 5 bps (median 2.3 bps); **4 closes 465–508 bps above** (07:00, 15:00, 16:00,
  17:00 UTC: Gemini 68 008 / 67 752 / 67 989 / 67 970 against 64 920 / 64 399 / 64 862 / 64 837), with highs to match.
  The daily bar of 2026-11-16 closes at 67 959.68 while the last hourly bar closes at 64 826.09. The cause is not known
  (off-market prints of the exchange, or a normalisation issue of the provider). Both recordings are test fixtures.

### 1.4 Metadata

```
GET …/v1/assets?filter_asset_id=<95 ids>                     cost 1   86 assets found
{"asset_id": "BTC", "name": "Bitcoin", "type_is_crypto": 1, "data_trade_start": "2011-09-13T…", "data_symbols_count": 20239,
 "price_usd": 64641.24…, "chain_addresses": [{"chain_id": "ARBITRUM", "network_id": "MAINNET", "address": "0x2f2a…5b0f"},
 {"chain_id": "ETHEREUM", "network_id": "MAINNET", "address": "0x2260…c599"}], "asset_type": "CRYPTO"}

GET …/v1/symbols?filter_exchange_id=GEMINI&filter_asset_id=USD     cost 1   82 spot USD pairs
{"symbol_id": "GEMINI_SPOT_BTC_USD", "exchange_id": "GEMINI", "symbol_type": "SPOT", "asset_id_base": "BTC",
 "asset_id_quote": "USD", "data_start": "2015-10-08", "data_trade_end": "2026-11-16T23:00:00.0000000Z",
 "volume_1day_usd": 3448614.89, "price": 64631.77, "symbol_id_exchange": "BTCUSD", "price_precision": 0.01, …}

GET …/v1/symbols?filter_exchange_id=BITFINEX&filter_asset_id=USD   cost 1   36 spot USD pairs (+ 36 others)
GET …/v1/symbols?filter_symbol_id=HYPERLIQUID_PERP_BTC_;…ETH_;…SOL_   cost 1
HYPERLIQUID_PERP_BTC_USDC / _ETH_USDC / _SOL_USDC   data_start 2024-09-27
GET …/v1/exchanges     cost 1   418 exchanges (BINANCE, COINBASE, KRAKEN, BITSTAMP, GEMINI, BITFINEX, HYPERLIQUID since
                                 2024-09-27, DYDX, EDGEX since 2026-11-10, …)
```

- `symbol_id` convention [DOC + LIVE]: `{exchange_id}_SPOT_{base}_{quote}`, `{exchange_id}_PERP_{base}_{quote}`,
  `_FTS_…_{YYMMDD}`, `_OPT_…`. `asset_id_base` is the provider's normalised id; `asset_id_base_exchange` the exchange's.
- **Asset identity** — observed names for ids the wallet also uses: `OP` "Operand" (no address), `ARB` "ARbit" (but its
  Arbitrum address **is** the registry's ARB), `GMX` "GoldMaxCoin" (address is the registry's GMX), `SKY` "Skycoin",
  `USDS` "StableUSD" (addresses are **not** the registry's), `CBETH` "ETH2 Coinbase Staked" with `type_is_crypto: 0`.
  Contract addresses are published for two chains only (Ethereum 37 assets, Arbitrum 21 among those asked).
- **Thin pairs**: of 35 certain market symbols, only 11 have an independent USD pair with at least 50 000 USD of daily
  volume on Gemini or Bitfinex (BNB on Gemini: 37 USD a day).

### 1.5 Quotes, order book, trades — read once, NOT used

```
GET …/v1/quotes/GEMINI_SPOT_BTC_USD/current       cost 1
{"symbol_id": "GEMINI_SPOT_BTC_USD", "time_exchange": "2026-11-17T06:39:51.2080000Z",
 "ask_price": 64286.02, "ask_size": 0.79370846, "bid_price": 71094.1, "bid_size": 0.01524122,
 "last_trade": {"time_exchange": "2026-11-17T07:54:56.4050000Z", "price": 64631.77, "size": 0.0394, "taker_side": "BUY"}}

GET …/v1/orderbooks/GEMINI_SPOT_BTC_USD/current?limit_levels=3     cost 1
{"asks": [{"price": 64286.02, …}, {"price": 64288.97, …}, …], "bids": [{"price": 71094.1, …}, {"price": 68423.08, …}, …]}

GET …/v1/trades/GEMINI_SPOT_BTC_USD/latest?limit=3      cost 1
[{"time_exchange": "2026-11-17T07:54:56.4050000Z", "time_coinapi": "2026-11-17T07:54:56.4211407Z",
  "uuid": "ff4409b9-…", "price": 64631.77, "size": 0.0394, "taker_side": "BUY"}, …]
```

The best bid (71 094.10) is **above** the best ask (64 286.02) and the quote is dated 06:39:51 at a 07:55 request: a
crossed, stale book. Trades were current. Consequence: the wallet takes no bid / ask from this provider.

### 1.6 The other products (one call each, to see what the key unlocks)

| Product | Request | Answer |
|---|---|---|
| Exchange Rates, realtime (CoinAPI) | `GET api-realtime.exrates.coinapi.io/v1/exchangerate/BTC/USD` | 200 `{"time": "2026-11-17T08:13:27.4000000Z", "asset_id_base": "BTC", "asset_id_quote": "USD", "rate": 64548.5122189393}` |
| Exchange Rates, historical | `GET api-historical.exrates.coinapi.io/v1/exchangerate/BTC/USD/history?period_id=1DAY&…&limit=2` | 200 `[{"time_period_start": "2026-11-10T00:00:00.0000000Z", "rate_open": 75265.49…, "rate_high": 75339.47…, "rate_low": 72667.76…, "rate_close": 73700.29…}, …]` |
| Indexes | `GET rest-api.indexes.coinapi.io/v1/indexes/IDX_REFRATE_VWAP_BTC/current` | 200 `{"timestamp": "2026-11-17T08:13:29.1", "value": 64548.5499762352}` |
| FX (FinFeedAPI) | `GET api-realtime.fx.finfeedapi.com/v1/exchangerate/EUR/USD` | 200 `{"time": "2026-11-17T08:13:29.7000000Z", "asset_id_base": "EUR", "asset_id_quote": "USD", "rate": 1.0999675}` |
| Stocks, historical (FinFeedAPI) | `GET api-historical.stock.finfeedapi.com/v1/ohlcv/exchange-symbol/IEXG/AAPL/history?period_id=1DAY&…&limit=2` | 200 `[{"time_period_start": "2026-11-10T00:00:00.0000000Z", "price_open": 352.51, "price_high": 353.785, "price_low": 346.47, "price_close": 348.97, …}]` |
| SEC filings (FinFeedAPI) | `GET api.sec.finfeedapi.com/v1/filings?limit=1` | 200, a list of filings (`cik`, `accession_number`, `form`, …) — `limit=1` returned 24 kB: the parameter was not honoured as expected |
| Prediction markets (FinFeedAPI) | `GET api.prediction-markets.finfeedapi.com/v1/exchanges` | 200 `[{"exchange_id": "KALSHI", …}, {"exchange_id": "POLYMARKET", …}, …]` |

None of these answers carried a cost header (only `x-tierlimit-*`): what they cost is **not known from the API**; each
is counted as one credit in the tally. The `X-CoinAPI-Key` header was accepted on the FinFeedAPI hosts too.
The wallet uses none of them.

### 1.7 WebSocket V1 (verified, NOT integrated)

```
wss://ws.coinapi.io/v1/        → {"type":"hello","apikey":"<key>","heartbeat":false,"subscribe_data_type":["exrate"],
                                   "subscribe_filter_asset_id":["BTC/USD","TON/USD"],"subscribe_update_limit_ms_exrate":2000}
← {"time":"2026-11-17T08:13:49.9000000Z","asset_id_base":"BTC","asset_id_quote":"USD","rate_type":"BASE_AND_QUOTE_TO_REF","rate":64544.3379942155,"type":"exrate"}
← {"time":"2026-11-17T08:13:49.8000000Z","asset_id_base":"TON","asset_id_quote":"USD","rate_type":"BASE_AND_QUOTE_TO_REF","rate":1.03149748045259,"type":"exrate"}
…  8 messages, 1 278 bytes in 8 seconds (one message per asset every 2 s, as asked)
```

- The plan **includes streaming** of exchange rates; the key travels in the first message (not in the URL).
- The update limit is honoured: about 160 bytes per message.
- Billing [DOC]: exchange rates and OHLCV are "Tier 2" WebSocket data, 0.0625 USD per MiB (first GiB) on pay-as-you-go.
  At one message a minute per asset that is ≈ 0.22 MiB a day per asset, about 0.014 USD — far below REST polling at the
  same cadence (1 440 credits). **Not confirmed**: no in-band counter exists and the console was not available to this
  work; that is why the hub polls REST (a deterministic, header-confirmed cost) and the WebSocket is left as the next step.

---

## 2. Documented, not called

- **Hosts** [DOC]: Market Data `https://rest.coinapi.io/` (GeoDNS) and regional `api-ncsa.` / `api-emea.` /
  `api-apac.coinapi.io`; WebSocket `wss://ws.coinapi.io/v1/` and the same regional names; a separate Exchange Rates
  WebSocket `wss://api-realtime.exrates.coinapi.io`. The wallet sends the key to `rest.coinapi.io` only.
- **Authentication** [DOC]: header `X-CoinAPI-Key` (also `X-APIBricks-Key`, `X-APIKey`, `Authorization`), query parameter
  `apikey`, URL path `/APIKEY-<key>/`, basic auth (`coinapi:<key>`), or a JWT (`Authorization: Bearer`, the token's `kid`
  names the key). The wallet uses the header and scrubs every one of these shapes from its messages.
- **Rate-limit headers** [DOC]: `X-RateLimit-Used`, `-Limit`, `-Remaining`, `-Request-Cost`, `-Reset`,
  `-Quota-Overage`, `-Quota-Allocated`, `-Quota-Remaining`, `X-ConcurrencyLimit-Limit`, `-Remaining`. "The
  X-RateLimit-Request-Cost header is always included"; "In certain scenarios, CoinAPI's responses do not include the
  X-RateLimit-Remaining and X-RateLimit-Reset headers." Today only the cost header came, and only on 200 answers of the
  Market Data host.
- **Quota window** [DOC]: "sliding/rollowing window - always last 24 hours from specific moment" (sic) for plan quotas;
  pay-as-you-go price tiers "reset daily" (hour not stated).
- **Exhaustion** [DOC, two answers]: "you will receive an HTTP 429 response status code"; and, in a tutorial, 403 = "Your
  API key is out of credits or plan quota." The client treats both as `quota` when the message says so, 429 otherwise as
  `rate_limited`. Not provoked.
- **Plans** [DOC, pricing page]: Pay As You Go (metered; "25.00 USD Free Credits"), Startup 79 USD / month (1 000 REST
  credits a day), Streamer 249 (10 000), Pro 599 (100 000), Enterprise. Pay-as-you-go REST price per 1 000 credits a day:
  5.26 USD (first 1 000), 2.63 (next 2 000), 1.73 (next 7 000), 0.83 (next 20 000), … 0.03 above 25 million.
  Documented plan limits "requests per second / per day": Startup 10 / 1 000, Streamer 100 / 10 000, Pro 100 / 100 000.
- **OHLCV parameters** [DOC]: `limit` default 100, maximum 100 000, "if the parameter is used then every 100 output
  items are counted as one request"; "The OHLCV Historical endpoint data can be delayed a few seconds";
  `include_empty_items=true` exists according to the FAQ (not in the published specification).
- **WebSocket** [DOC]: data types trade, quote, book, book5/20/50, ohlcv (1SEC–1MIN), exrate, asset, exchange, symbol;
  `heartbeat: true` gives a message "every time there is one second of silence" (type spelled `hearbeat`); `reconnect`
  messages announce a server restart; "all errors are permanent and you should expect that the underlying WebSocket
  connection will be closed"; an exhausted balance ends a session with "policy message: insufficient_usage_credits".
- **Historical depth** [DOC]: "typically to each exchange's inception"; coverage "varies by symbol and venue, not by plan
  gimmicks"; per-symbol `data_*_start` fields.

---

## 3. Licence and terms relevant to a personal, self-hosted wallet [DOC]

Source: `https://www.coinapi.io/legal` — "Customer Agreement" (effective 2025-08-18), "Acceptable Usage Policy",
and the informal pages `/usage-policy` and a blog post on commercial use.

- **Licence grant (Customer Agreement, s. 1.2)**: "we grant you a non-exclusive, non-transferable, revocable right to
  access and use the Services" … "for your internal business purposes only." … "No ownership, title, or proprietary
  rights are transferred to you."
- **Restrictions (s. 6)**: you will not "rent, lease, sub-license, loan, translate, merge, adapt, vary or modify any
  Services, without our express written consent."
- **Acceptable Usage Policy**: not legitimate use includes "Re-selling our Services or parts thereof to another party".
- **Usage policy page**: "internal use means CoinAPI data is used within your own organization or application";
  "Displaying CoinAPI market data to external users may be considered redistribution."; "Not permitted" includes
  "Redistributing raw or normalized market data".
- **Blog (contradicts the page above on display)**: "Displaying real-time and historical data in your UI is fully
  permitted with any paid plan."; "Reselling, rehosting, or redistributing raw data is strictly prohibited."
- **Third-party sources (s. 2.3)** "may be subject to restrictions of use and require additional license agreements".
- **Attribution**: "Attribution is not required, but you are welcome to include it." (FAQ)
- **Caching / storage**: no clause found. [UNKNOWN]

Reading for this wallet: one owner, self-hosted, the data shown to that owner behind a passkey — internal use. What
would cross the line: serving these prices or bars to anybody else, in particular through the wallet's own Trading API
to a third party's key, or publishing recorded data. The recorded fixtures of this repository are a few kilobytes of
bars and rates of one day kept as test evidence in a private repository; if the repository were ever made public they
would have to be removed or replaced by synthetic data. This is a reading by an engineer, not legal advice.

---

## 4. Conventions the integration relies on

| Topic | Convention | Evidence |
|---|---|---|
| Timestamps | ISO 8601 UTC with seven fractional digits (`2026-11-17T07:55:03.4000000Z`); parsed to milliseconds | LIVE |
| Numbers | JSON numbers (not strings); rates up to 29 significant digits in the text | LIVE |
| Bar time | `time_period_start` = bar-open time, UTC grid | LIVE |
| Asset id | upper-case ticker chosen by the provider; **not unique to one asset** | LIVE |
| Symbol id | `{EXCHANGE}_{SPOT|PERP|FTS|OPT}_{BASE}_{QUOTE}`… | DOC + LIVE |
| Inverted rates | `/v1/exchangerate/USD?invert=true` → USD per unit of each asset | LIVE |
| Cost | `x-ratelimit-request-cost` on 200 answers of `rest.coinapi.io`; absent on errors and on the other hosts | LIVE |

---

## 5. Unknown

- The plan of the owner's key, its balance, and whether a spend limit is set in the console.
- What a call to the non-Market-Data hosts costs.
- Whether WebSocket bytes are billed exactly as the pricing page says for this account.
- The exchanges and the window behind the exchange rate.
- The provider's behaviour at exhaustion on this account (429, 403, or continued service with overage).
- Why the Gemini BTC/USD series carries off-market prints and a crossed book.
- Whether caching is restricted.

---

## 6. Consequences for the integration (what was decided from the above)

1. **One host, one header.** `rest.coinapi.io`, `X-CoinAPI-Key`. No other product is used.
2. **A budget kept by the wallet**, because the provider does not report the balance: `APIBRICKS_DAILY_CREDITS`
   (default 100 a day ≈ 0.53 USD at the first pay-as-you-go tier), with smaller ceilings for bars and for the quote hub.
3. **Prices from the batched exchange-rate call** (one credit for every mapped asset and CAD), cached 30 minutes, 5
   minutes while CoinGecko is down or stale.
4. **Mapping by evidence, generated and reviewed** — exact id + (shared contract address or reviewed native coin) +
   price agreement at generation; 42 mapped, 53 left with one source and listed with the reason.
5. **Bars only from exchanges the wallet does not read itself** (Gemini, Bitfinex), behind the same validation and
   cross-source gate as Coinbase, Bitstamp and Kraken; ranked last; daily bars of the base set by default.
6. **No bid / ask, no book, no trade tape from this provider.**
7. **REST polling for the quote hub**; the WebSocket is verified and documented, not integrated.
8. **Never in the signer, never a trade authorisation.**

---

## 7. Sources (all read on 2026-11-17)

- https://www.apibricks.io — company, the two brands
- https://www.apibricks.io/products/coin-api — product list (Market Data, EMS Trading, Indexes, Flat Files, Exchange Rates, Exchange Link)
- https://www.coinapi.io/docs — documentation index; "$25 in free credits"; key creation at `console.apibricks.io`
- https://www.coinapi.io/products/market-data-api/docs/authentication — key format, authentication methods
- https://www.coinapi.io/products/market-data-api/docs — plan limits table
- https://www.coinapi.io/products/market-data-api/docs/rest-api/endpoints — hosts
- https://www.coinapi.io/products/market-data-api/docs/api-limits-and-billing-metrics — rate-limit headers, rolling window
- https://www.coinapi.io/products/market-data-api/docs/rest-api/ohlcv/ohlcv/symbol_id/history/get — OHLCV parameters
- https://www.coinapi.io/products/market-data-api/docs/websocket/general , /websocket/messages , /websocket/endpoints — WebSocket V1
- https://www.coinapi.io/products/market-data-api/pricing — plans, credit rule, pay-as-you-go tiers, WebSocket tiers
- https://www.coinapi.io/products/market-data-api/faq — headers always / sometimes present, history start, attribution
- https://www.coinapi.io/products/exchange-rates-api/docs/rest-api-realtime/endpoints — exchange-rates hosts
- https://www.coinapi.io/blog/api-rate-limits-credit-consumption-guide-coinapi-usage-billing — credits, `X-Credits-*`, 429 / 403
- https://www.coinapi.io/learn/academy/tutorials/coinapi-usage-free-credits-and-quota-explained — 403 on exhaustion
- https://www.coinapi.io/legal — Customer Agreement (effective 2025-08-18), Acceptable Usage Policy
- https://www.coinapi.io/usage-policy , https://www.coinapi.io/blog/coinapi-data-commercial-use-policy — display / redistribution
- https://www.finfeedapi.com/docs — FinFeedAPI products, FX host
- https://raw.githubusercontent.com/api-bricks/api-bricks-sdk/master/ — OpenAPI specifications (`coinapi/market-data-api-rest`, `coinapi/exchange-rates-api-rest-historical`, `coinapi/indexes-api-rest`, `finfeedapi/stock-api-rest`, `finfeedapi/sec-api-rest`, `finfeedapi/prediction-markets-api-rest`): hosts, symbol-id patterns, rate methodology sentence
- Coinbase Exchange public candles (`api.exchange.coinbase.com/products/BTC-USD/candles`) — the comparison of section 1.3

## 8. Reproducing

```bash
set -a; . <the secrets file>; set +a          # APIBRICKS_API_KEY — never printed
npx tsx scripts/smoke-apibricks.mts            # 3 credits; --all-products adds 7 calls on the other products
npx tsx scripts/gen-apibricks-assets.mts       # 4 credits: regenerates the mapping table and its fixtures; read the diff
```

## 9. Tally of live calls made for this work

| What | Calls | Credits |
|---|---|---|
| Market Data REST by hand (rates, OHLCV, metadata, quotes, book, trades, two error answers) | 17 | 17 (15 × cost header 1; 2 errors counted 1) |
| Other products, one call each (section 1.6) | 7 | 7 (no cost header: counted 1) |
| Mapping generator (`gen-apibricks-assets.mts`) | 4 | 4 |
| Smoke (`smoke-apibricks.mts --all-products`), run once | 10 | 10 (2 through the metered client; 8 probes counted 1) |
| **REST total with the owner's key** | **38** | **≈ 38** |
| WebSocket, one session of 8 s | 8 messages, 1 278 bytes | Tier 2 bytes (≈ 0.0001 USD at the published price) |
| Without the key (error shapes) | 2 | 0 |
| Keyless, other providers (CoinGecko × 2, Coinbase × 1) | 3 | — |
