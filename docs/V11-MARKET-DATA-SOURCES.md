# SP Wallet V11 — market-data sources

Which outside source gives which number, and what the wallet does when two of them disagree. This document was added
with the second, keyed source (API Bricks); the sources that existed before are listed in section 1 so that the whole
picture is in one place. Dossier of the new provider: `docs/v11/research/apibricks.md`. Work note:
`docs/v11/work/apibricks.md`.

**Nothing here authorises a trade.** Market data values the portfolio, draws charts, feeds strategies and gives the risk
engine references. The signer's own price check is separate and untouched (section 7).

---

## 1. The sources

| Use | Source | Key | Module |
|---|---|---|---|
| Portfolio prices, daily change, market cap, sparkline, price chart | **CoinGecko** free tier (`/coins/markets`, `/coins/{id}/market_chart`) — **primary** | none | `services/api/src/gecko.ts`, `server.ts` `markets()` |
| Portfolio prices — **second source**: cross-check and labelled failover | **API Bricks** (CoinAPI `/v1/exchangerate`) | `APIBRICKS_API_KEY` | `services/api/src/apibricks/prices.ts`, `prices/cross.ts` |
| Spot bars (5m / 1h / 1d) for strategies and the spot markets | **Coinbase, Bitstamp, Kraken** public REST | none | `services/api/src/market/sources.ts` |
| Spot bars — **additional confirming source** | **API Bricks** (CoinAPI `/v1/ohlcv`, Gemini or Bitfinex series only) | `APIBRICKS_API_KEY` | `services/api/src/apibricks/market-source.ts` |
| Live spot quotes | **Coinbase** websocket where it lists the symbol; else the price list above, polled | none | `services/api/src/quotes/upstreams.ts` |
| Live spot quotes — symbols Coinbase does not stream | **API Bricks**, REST polling, metered | `APIBRICKS_API_KEY` | same file (`SecondSpotSource`), `apibricks/index.ts` |
| Perpetual marks, books, funding | the venues themselves (Hyperliquid, edgeX, dYdX, GMX) | none | `packages/derivatives`, `quotes/upstreams.ts` |
| Signer's price check of a delegated order | **Coinbase and Kraken** tickers, read by the signer itself | none | `services/isolated-signer/src/prices.ts` — **not changed** |
| Research history | venues' public endpoints, Coinbase; optionally **API Bricks** | optional | `research/src/spq/data/` (`apibricks.py`) |

API Bricks is **optional**. Without `APIBRICKS_API_KEY`: no module of it is built, nothing is asked of it, the
capability `market_data_apibricks` reads `needsKey — APIBRICKS_API_KEY is not set`, the monitor shows "Key missing", and
every price, bar and quote is exactly what it was — with one addition: each price now says `source: "coingecko"`.

---

## 2. API Bricks (market data)

### 2.1 Initial state

- CoinGecko's free tier was the **only** price source of the portfolio, of swap valuation, of the risk flags and of plan
  estimates (`docs/V11-AUDIT.md` §8, `docs/V11-REMAINING-LIMITATIONS.md` 7.2). It refuses under load (429); the
  stabilisation added `priceAt` and `stale` so that an old price is at least said to be old. Nothing could tell a wrong
  price from a right one, and nothing replaced it when it was down.
- A bar of the market module is trusted only when a second exchange confirms it; a symbol listed on two of the three
  exchanges has no margin when one is down.
- Spot symbols Coinbase does not stream were polled from the same CoinGecko list (a few minutes between two prices).

### 2.2 The API used

One host, one header, three endpoints (all verified live on 2026-11-17, samples in the dossier):

| Endpoint | Used for | Cost |
|---|---|---|
| `GET https://rest.coinapi.io/v1/exchangerate/USD?invert=true&filter_asset_id=…;CAD` | every mapped price and the CAD rate, in one call | 1 credit |
| `GET https://rest.coinapi.io/v1/ohlcv/{symbol_id}/history?period_id=&time_start=&time_end=&limit=100` | one page of bars of one exchange-specific series | 1 credit per 100 bars |
| `GET …/v1/assets`, `…/v1/symbols` | **build time only** (`scripts/gen-apibricks-assets.mts`) | 1 credit each |

Authentication: header `X-CoinAPI-Key`. The key is never put in a URL. The provider's other products (FX, stocks, SEC,
prediction markets, indexes, order routing) are not used; its quotes and order books are not used (a crossed, stale
book was observed — dossier §1.5); its WebSocket is verified and not integrated (dossier §1.7).

### 2.3 What is integrated

**(a) Second price source — `prices/cross.ts` holds the whole rule.**

- Every price carries `source`, `fallback`, `sources[]` (what **each** source said, with its own `priceAt` and `stale`),
  `divergent` and `divergenceBps`.
- The displayed price is the **primary** one (CoinGecko) whenever it has a price that is not stale.
- When the primary has no price for a symbol, or a stale one (its free tier refused, or the whole list failed), and the
  second source has a price that is not stale, **the second source's price is displayed and labelled**:
  `source: "apibricks"`, `fallback: true`. While that is the case the second list is refreshed every 5 minutes instead
  of every 30.
- When both have a fresh price and their dates are at most 10 minutes apart, they are compared: `divergenceBps`, and
  `divergent: true` above `APIBRICKS_DIVERGENCE_BPS` (default 100). **Nothing is averaged**: the displayed price stays the
  primary's, the other one is shown beside it. Prices further apart in time are not compared (`divergenceBps: null`).
- A symbol the provider does not map with certainty has one source, as before.
- Mapping (`apibricks/mapping.ts`, generated table `apibricks/asset-map.ts`): a wallet symbol maps onto a provider asset
  only with an **exact id**, **evidence** (the provider's contract address equals the registry's on Ethereum or Arbitrum,
  or the symbol is a reviewed native coin; never when the addresses differ) and a **price agreement** within 150 bps at
  generation time. 42 of 95 symbols map (20 by address, 20 reviewed native coins, 2 aliases the wallet already prices
  identically); the 53 others are listed in the table with the reason (`conflict`, `no_evidence`, `no_exact_id`…).
- Where it shows: `GET /api/v1/portfolio` (`prices[sym].source` … and the summary `priceSource`
  `coingecko | apibricks | mixed`, `priceSources {primary, second, fallback[], divergent[], compared, maxDivergenceBps}`);
  the Trading API `GET /api/v1/trading/portfolio` (each wallet balance row: `priceSource`, `priceAt`, `priceDivergent`,
  `priceDivergenceBps`); the Dashboard's price-freshness panel ("Sources de prix": one or two sources, "n prix en
  secours", "n écarts entre sources" or "n prix recoupés, écart max. x pb").

**(b) Additional confirming source of the market module — `apibricks/market-source.ts`.**

- A `MarketSource` like the three exchanges: its bars go through the same `validateBars`, `normalise`, `candles` table
  (`source = 'apibricks'`) and `evaluate` / `assertFresh` gate.
- **Independence rule** (`apibricks/venues.ts`): the provider is an aggregator; its bars of `COINBASE_SPOT_BTC_USD` are
  Coinbase's own trades. Only exchange-specific series of exchanges the wallet does **not** read are used — Gemini,
  then Bitfinex — one per symbol, chosen from the provider's symbol metadata (exact `…_SPOT_<asset>_USD` id of a
  certainly-mapped asset, traded in the last two days, ≥ 50 000 USD a day, last price within the mapping's price check).
  `isIndependent()` refuses any id of Coinbase, Bitstamp or Kraken (and their sub-venues) again at run time. 11 symbols
  have such a series (`MARKET_PAIRS`); the 24 other certain market symbols have none (not listed there, or too thin).
- **Ranked last**: the bar a series uses is always an exchange's when an exchange has it; this source confirms it, or
  fills a slot nobody else has. Alone it is one source — the gate needs two: it can never make a series usable by itself.
- **Bounded**: by default daily bars (`APIBRICKS_MARKET_INTERVALS=1d`) of the base set that has a pair (AVAX, BTC, DOGE,
  ETH, LINK, LTC, SOL, XRP), the last 300 bars, at most 25 credits a day: 3 credits per symbol once, then one per symbol
  and per day. Hourly bars cost 24 credits per symbol and per day — a deliberate setting.
- When its budget is spent the source reports `ready() === false`; the pass skips it without an error line.

**(c) Quote hub — `quotes/upstreams.ts` (`SecondSpotSource`).**

- For a spot symbol with no Coinbase stream that maps with certainty, the hub polls the provider (the same batched rate
  call) every `APIBRICKS_QUOTE_POLL_MS` (5 minutes), **only while a channel on that symbol is open**, within
  `APIBRICKS_QUOTE_DAILY_CREDITS` (30). Same normalised `quote` message; `source: "apibricks-rest"`; `last` only — no bid,
  no ask, nothing invented; stale after 15 minutes.
- Which path a symbol takes is decided when its channel opens: if the budget has no room, the price list is polled as
  before (`coingecko-rest`).
- **Budget spent while a channel is open → `down`, reason `quota`**: an error on the channel, the state in
  `/api/v1/stream/stats` (`hub.venues[spot].upstream.second` and `metered.apibricks`), and the `spot` venue status when
  that source alone feeds it. A failure of this source touches neither the Coinbase stream nor the polled symbols.

**(d) Research loader — `research/src/spq/data/apibricks.py`.**

- `fetch_apibricks_candles` / `pull_apibricks` for one exchange-specific series, with a capture manifest of the same
  format as the other venues (endpoint without any credential, rows, first / last, content hash) and `overlap_check`
  (how far the series is from a venue's own bars where both exist).
- A ceiling in credits is checked **before** the first call. **No pull was made**: extending the lab's 180-day window to
  the two years the provider has for Hyperliquid (since 2024-09-27) costs about 194 credits per series — 1 750 credits
  for the nine perpetual series of the V11 study, more than the published free allowance. See section 5.

**Budget and secret** — `apibricks/budget.ts`, `client.ts`, `redact.ts`.

- A hard daily ceiling counted by the wallet (the provider reports no balance): `reserve` before each call, the
  provider's own `x-ratelimit-request-cost` settles the count, a call that never left is refunded. The count is kept in
  the settings table: a restart does not start the ceiling again. Past the ceiling the client throws `quota` **without
  calling**.
- The key is read by `config.ts` only, sent as a header to `rest.coinapi.io` only (the host is a constant; a path that
  could carry the key or leave the host is refused), and scrubbed from every message — the exact value, anything of the
  published shape, and every place the provider lets a key travel (query string, URL path, four headers, basic auth).

**What it is not used for.** No order, no transaction, no mandate. The risk engine's reference from the wallet price list
now carries the name of the source that really gave it: `coingecko`, or `apibricks` when the list fell back. The risk
limits have a maximum age for `coingecko` (15 minutes) and none for `apibricks`, which is therefore judged with the
strict default (10–15 s): **a fallback price does not count as a fresh reference** unless the owner adds an entry to the
limits. The provider is not added as a further reference.

### 2.4 Tests

`services/api/test/apibricks.test.ts` — 37 tests, no network, no database, on real answers recorded on 2026-11-17
(`test/fixtures/apibricks/`: bodies only):

| Area | What is checked |
|---|---|
| Secret | the key is scrubbed from a URL, a path, four header shapes, basic auth, any case; an upstream error echoing the key in a URL or a header is scrubbed before it is thrown or kept; sent as a header to the one host; refused paths |
| Budget | hard ceiling; refusal counted; UTC-day reset; per-consumer ceiling; settle and refund; survives a restart; `quota` thrown without calling |
| Client | recorded rate; time parsing; recorded 401 / 400 / 550 typed; 429 and 403 by message; cost of a failed call |
| Mapping | the committed table equals the rules applied to the recorded metadata; certain cases (address, reviewed, alias); ambiguous cases (other contract, other asset under the ticker, casing, no evidence); each rule alone |
| Prices | one batched call; own dates; cache, fresher read, shared request, staleness; failure and retry pause; budget exhaustion |
| Cross-check | one source unchanged; both reported, primary displayed; divergence threshold and time skew; failover labelled; stale second never replaces; primary absent entirely |
| Market source | independence rule on ids and on the table; committed pairs equal the selection on recorded metadata; recorded page through `validateBars`; open bar dropped; refused ranges; quota; **real Coinbase and Gemini bars of the same hours through the gate**; confirms / never alone / ignored without the key |
| Wiring | absent and `needsKey`; three exchanges only; capability line names the variable and never a value; shared budget; `down: quota` in the status |
| Quote hub | scripted source: normalised quote, source named, reference-counted polling; `down` + `quota` on venue, channel and statistics, and recovery; isolation; unchanged without it |

`research/tests/test_apibricks_data.py` — 4 tests on the same recorded page (closed bars, ceiling before any call,
manifest without credential, no key → nothing called).

### 2.5 Observed results (2026-11-17)

- Smoke (`scripts/smoke-apibricks.mts --all-products`, run once): the eight products answered; BTC / ETH / SOL / USDC
  from both sources **3.7 / 1.8 / 5.0 / 1.1 bps** apart, dates 9.5 s apart; three closed daily Gemini bars, none rejected.
- Mapping generation: 42 symbols within 48 bps of CoinGecko at one instant (median 7.6 bps).
- One real day of hourly BTC bars, Coinbase read directly against the provider's Gemini series: **20 of 24 closes within
  5 bps; 4 closes 465–508 bps off** (the provider's series, not Coinbase's). The gate confirms the first and answers
  `disagreement` on the others when no other exchange confirms — this is a test on the recorded bars.
- The provider's "current" Gemini quote was crossed and 75 minutes old.

### 2.6 Limitations

1. **The balance is invisible to the wallet.** The provider returns no remaining-credit header on this key; the wallet's
   counter is its own estimate (it restarts at 00:00 UTC; the provider documents a rolling 24-hour window for plan
   quotas). A spend limit, if wanted, must be set in the provider's console.
2. **The defaults are frugal, and that limits what the source brings.** 100 credits a day: the second price list is
   30 minutes old at worst, so a comparison with CoinGecko is possible only when the two dates are within 10 minutes —
   about a third of the time; daily bars only; a quote every 5 minutes for at most 30 polls a day.
3. **Not independent as raw data.** The provider's rate and CoinGecko's price are two aggregations of largely the same
   exchanges. Agreement between them shows that neither computation is broken, not that the market price is right.
4. **53 symbols keep one source** (every wrapped, staked or bridged representation among them, by rule).
5. **The exchange-specific series is imperfect** (section 2.5): it sometimes fails to confirm a good bar. It cannot
   confirm a bad one unless the exchange's bar is wrong the same way.
6. **A fallback price has no daily change, market cap or sparkline of its own**: those fields keep the primary's last
   values when it had any (they are older than the price), or are null.
7. **Swap valuation and plan estimates** read the same list and therefore benefit from the failover, but no route check
   was changed and none of their tests was extended to the fallback case.
8. **WebSocket not integrated**: verified live, probably cheaper than polling, billing unconfirmed.
9. **Licence**: internal use only (dossier §3). The Trading API must not serve these prices to a third party's key.
10. **No research pull** (cost).

### 2.7 Production conditions

Set by the main session with the owner's authorisation — nothing was deployed by this work.

- `APIBRICKS_API_KEY` in the PM2 environment of `sp-wallet` on the API node and in the `env` block of the mld manifest
  (`docs/V11-DEPLOYMENT.md` §4.3–4.4, `docs/runbooks/deploy.md`). It must be in the restart line when PM2 re-reads the
  shell, and in the secrets backup. It does **not** go to the signer node, nor to the research node unless a pull is
  decided.
- Before enabling: read the balance and the plan in the provider's console; decide `APIBRICKS_DAILY_CREDITS`.
- After the restart: the start-up line reads `market_data_apibricks=on`; the monitor shows "n / 100 crédits utilisés
  aujourd'hui"; `GET /api/v1/stream/stats` → `metered.apibricks.budget`; the Dashboard reads "CoinGecko + API Bricks".
- To switch it off: remove the variable and restart. Stored `apibricks` bars stay in the `candles` table and are simply
  not read (the priority is back to the three exchanges).

---

## 3. Settings

| Variable | Default | Meaning |
|---|---|---|
| `APIBRICKS_API_KEY` | unset | the key; unset = provider absent (`needsKey`) |
| `APIBRICKS_DAILY_CREDITS` | 100 | hard ceiling of REST credits per UTC day, all uses; 0 = never call |
| `APIBRICKS_MARKET_DAILY_CREDITS` | 25 | of which, at most, for bars |
| `APIBRICKS_QUOTE_DAILY_CREDITS` | 30 | of which, at most, for the quote hub |
| `APIBRICKS_PRICE_TTL_MS` | 1 800 000 | refresh window of the second price list |
| `APIBRICKS_FAILOVER_TTL_MS` | 300 000 | the same while the primary is down or stale |
| `APIBRICKS_DIVERGENCE_BPS` | 100 | beyond this two prices are `divergent` |
| `APIBRICKS_QUOTE_POLL_MS` | 300 000 (never under 60 000) | polling period of the hub's metered source |
| `APIBRICKS_MARKET_INTERVALS` | `1d` | among `1d,1h,5m`; `off` = no bars from this source |
| `APIBRICKS_MARKET_SYMBOLS` | the base set | symbols for bars (only those with an independent series are served) |
| `APIBRICKS_MARKET_HISTORY_BARS` | 300 (never under 100) | how far back bars are fetched |

Where the defaults come from: the plan observed is metered per credit with no visible balance; the published
pay-as-you-go price of the first 1 000 credits of a day is 5.26 USD, so 100 credits a day is about 0.53 USD a day, and a
25 USD allowance lasts about 47 days at the ceiling. Typical use is below it: 48 price reads a day when the wallet is
watched continuously, 8 bar reads, the hub only while a channel is open.

---

## 4. The independence rule, stated once

A source confirms another only if the two do not come from the same place.

- Bars: Coinbase, Bitstamp and Kraken are read directly. An aggregator's bars of one of those three are not a second
  source. The provider is used through Gemini and Bitfinex series only; `isIndependent()` enforces it on every id.
- Prices: CoinGecko and the provider's rate are two aggregates. They are compared, never averaged, and their agreement
  is described as what it is (section 2.6, item 3).
- Risk: a reference counts only if it is independent of the venue the order goes to; the wallet price list is, whichever
  of the two sources gave it. The provider's exchange-specific series of a venue (it has Hyperliquid's and dYdX's) would
  **not** be independent of that venue and is not used as a reference.

## 5. What a paid tier would allow

Figures from the provider's pricing page (dossier §2), not from a test:

- **Startup (79 USD a month, 1 000 credits a day)**: the second price list every 2 minutes (720 credits), so that almost
  every price is compared; hourly bars for 10 symbols (240 credits); a one-off research pull of nine two-year hourly
  series in two days.
- **Streamer (249 USD a month)** or the WebSocket on pay-as-you-go: streamed exchange rates for the symbols Coinbase does
  not list, once the billing of the stream is confirmed in the console.
- The research extension alone, on pay-as-you-go: about 1 750 credits once ≈ 7.2 USD at the published tiers.

## 6. Files

```
services/api/src/apibricks/   redact.ts  budget.ts  client.ts  mapping.ts  venues.ts  asset-map.ts (generated)
                              prices.ts  market-source.ts  index.ts
services/api/src/prices/      cross.ts  coingecko-ids.ts (the table moved out of server.ts, unchanged)
scripts/                      gen-apibricks-assets.mts  smoke-apibricks.mts
research/src/spq/data/        apibricks.py
```

## 7. The signer is not concerned

`services/isolated-signer/src/prices.ts` reads Coinbase and Kraken tickers by itself and refuses a delegated order when
they disagree. **This provider was deliberately not added there**: the signer's check exists to be independent of the
API node and of anything the API node trusts; a keyed third party would add a secret to the signer node, a dependency on
one company's account status (an unpaid balance would stop signing), and an aggregate that already contains Coinbase and
Kraken. No file of the signer was modified.
