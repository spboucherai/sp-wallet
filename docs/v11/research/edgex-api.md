# edgeX Perps V2 API — implementer's dossier for `EdgeXAdapter`

Research date: **2026-11-15** (live calls made 2026-11-15 23:43–23:50 UTC, from a Canadian residential IP, plain `curl`, no API key).
Scope: read-only research. No account was created, no authenticated call was made, no order was sent.

Reading rule for this document:

- **[LIVE]** = I called it today and the sample is the real response (trimmed).
- **[DOC]** = read in the official GitBook / help center, not callable without an account.
- **[SDK]** = read in the official SDK source (commit pinned in section 9).
- **[BUNDLE]** = seen in the production web-app JavaScript; undocumented, may change without notice.
- **[INFERRED]** = my deduction; not stated by edgeX.

---

## 0. Executive summary

| Question | Answer | Evidence |
|---|---|---|
| REST base (mainnet) | `https://edgex-prod-v2.edgex.exchange`, paths `/api/v2/...` | [DOC] + [LIVE] |
| Asset (deposit/withdraw) base | `https://spot.edgex.exchange`, paths `/api/v1/private/unified-asset/...` | [DOC] + [SDK] |
| WebSocket base | `wss://edgex-quote-prod-v2.edgex.exchange`, paths `/api/v1/public/ws` and `/api/v1/private/ws` (still `v1`) | [DOC] + [LIVE] (public) |
| Old host/path | `https://pro.edgex.exchange/api/v1/public/meta/getMetaData` returns the SPA HTML (HTTP 200, `text/html`); `/api/v1/public/...` on the new host returns 404 | [LIVE] |
| Old GitBook `/api` page | 404. Current docs: `https://edgex-1.gitbook.io/edgeX-documentation/api-v2` (has `llms.txt`, every page available as `.md`) | [LIVE] |
| Request auth | HMAC-SHA256, headers `X-edgeX-Api-Key`, `X-edgeX-Passphrase`, `X-edgeX-Timestamp`, `X-edgeX-Signature` | [DOC] + [SDK] + [LIVE] (error shapes) |
| Order signature | EIP-712 typed data, primary type `LimitOrderParams`, domain `EdgeX`/`1`/chainId 3343/`0xeeb3fb05cca17745cbdf193a9b16537efb68fac8`, secp256k1 | [DOC] + [SDK]; domain values [LIVE] from metadata |
| Which key signs orders | A delegated **"SDK Signer"** key (plain Ethereum private key) created in the web app: API Management → Perps V2 → SDK Signer. Not the main wallet. | [DOC] |
| StarkEx / Pedersen | V1 only. V2 has "no StarkEx signing adapter" | [DOC] + [SDK] |
| Server-side order placement | Technically implementable (pure HMAC + EIP-712, no browser needed) **once** an account exists, API access is unlocked and an SDK Signer was created in the web UI. Not verified end to end (no account). | [DOC] + [SDK] |
| API access gate | The web app says API access requires staking EDGE; error code `USER_API_WHITELIST_ERROR` exists. Amount is rendered dynamically ("Stake {{amount}} EDGE"); a search-engine snapshot of `pro.edgex.exchange/edgex-api` says 1,000 EDGE — not verified by me. | [BUNDLE] |
| Testnet | Exists (`testnet.edgex.exchange`, Edge testnet chainId 33431) but **every testnet host is behind Cloudflare Access login**; the docs say non-production domains "are not part of the public documentation". Not usable. | [LIVE] |
| Canada | **Blocked by the Terms of Use** ("United States of America or Canada … Blocked Persons"). Québec is not named separately; it is covered by "Canada". | [DOC] |
| ANTHROPIC instrument | `ANTHROPICUSDC`, contractId `30000192`, USDC-margined linear perp, max 5x, last ≈ 1 343 USDC on 2026-11-15. edgeX publishes **no** contract definition for it that I could find. | [LIVE] + gap |

**Blocking point for the wallet:** the Terms of Use exclude persons located in Canada from the interface and from perpetual contracts, and prohibit VPN circumvention. Public market data was reachable from Canada today; that is a technical observation, not a permission. This needs a decision by the owner before any trading code is written.

---

## 1. Verified live today

All commands are plain `curl` with no headers. No bot protection was encountered on `edgex-prod-v2.edgex.exchange` (server header `TencentEdgeOne`); no User-Agent was required.

Response envelope, identical everywhere:

```json
{"code":"SUCCESS","data":…,"errorParam":null,"msg":null,"requestTime":"1794786229958","responseTime":"1794786229958","traceId":""}
```

All numbers are **strings** unless noted. All timestamps are Unix **milliseconds** as strings.

### 1.1 Server time

```bash
curl -s https://edgex-prod-v2.edgex.exchange/api/v2/public/meta/getServerTime
```
```json
{"code":"SUCCESS","data":{"timeMillis":"1794786229958"},"errorParam":null,"msg":null,"requestTime":"1794786229958","responseTime":"1794786229958","traceId":""}
```

### 1.2 Metadata

```bash
curl -s https://edgex-prod-v2.edgex.exchange/api/v2/public/meta/getMetaData   # 413 kB
```

`data` keys: `global` (object), `coinList` (196), `contractList` (195), `multiChain` (object), `campaign` (object).

`data.global` (complete, real):

```json
{
 "appEnv": "mainnet", "appName": "edgeX", "appOnlySignOn": "https://pro.edgex.exchange",
 "chainId": "0xd0f", "nativeChainId": "3343",
 "contractAddress": "0xeeb3fb05cca17745cbdf193a9b16537efb68fac8",
 "collateralCoinId": "1000", "transferCoinId": "1000",
 "transferTokenAddress": "0x98d2919b9A214E6Fa5384AC81E6864bA686Ad74c", "transferTokenDecimals": 6,
 "perpVaultAddress": "0x48fc02c5bD34Af7086a5C70D4C59d18d10A557b5",
 "spotVaultAddress": "0x87E11A60e6FdDE29d86ce446aE06dDBc19D78E53",
 "feeAccountId": "751487024678044377",
 "isolatedMarginSignPermission": "0x10",
 "isolatedMarginSigner": "0x64895bC7F897b523399D2b73db0e382020a62Ecb",
 "fundingValidityPeriod": 86400, "priceValidityPeriod": 86400, "maxFundingRate": 12000,
 "minTransferSize": "1", "transferLimitEnable": false,
 "chasePriceBoundRatio": "0.05", "boosterRatio": "1",
 "demoSelfClaimAmount": "10000", "demoSelfClaimEquityThreshold": "1000",
 "twapMaxRuntime": "86400", "twapMinRuntime": "300",
 "maintenanceReason": "",
 "fastWithdrawAccountId": "0", "fastWithdrawAccountL2Key": "0x0", "fastWithdrawMaxAmount": "0",
 "fastWithdrawRegistryAddress": "0x0000000000000000000000000000000000000000",
 "poolAccountId": "0", "poolAccountL2Key": "0x0"
}
```

`0xd0f` = 3343. Types seen: `transferTokenDecimals`, `fundingValidityPeriod`, `priceValidityPeriod`, `maxFundingRate` are JSON numbers; `transferLimitEnable` is a boolean; the rest are strings.

Contract object keys (exact):
`baseCoinId, contractId, contractName, defaultLeverage, defaultMakerFeeRate, defaultTakerFeeRate, displayDigitMerge, displayHotIcon, displayMaxLeverage, displayMinLeverage, displayNewIcon, enableBoosterCredit, enableDisplay, enableOpenPosition, enableTrade, fundingImpactMarginNotional, fundingInterestRate, fundingMaxRate, fundingMinRate, fundingQuoteImpactMarginNotional, fundingRateIntervalMin, isFx, isStock, liquidateFeeRate, matchServerName, maxMarketPositionSize, maxOrderBuyPriceRatio, maxOrderSize, maxPositionSize, minOrderSellPriceRatio, minOrderSize, openSizeReduceRatio, oraclePriceQuorum, oraclePriceSignedAssetIds, oraclePriceSigners, quoteCoinId, resolution, riskTierList, stepSize, syntheticAssetId, tickSize, tpslSpreadProtectionThreshold`

Coin object keys: `assetId, coinId, coinName, iconUrl, resolution, showStepSize, stepSize`.

There is **no** `starkExResolution` field in today's metadata, although the docs still mention it (section 7).

Values common to all 195 contracts today: `quoteCoinId "1000"` (USDC), `defaultMakerFeeRate "0.0004"`, `defaultTakerFeeRate "0.00045"`, `fundingRateIntervalMin "240"`, `fundingInterestRate "0.0003"`, `liquidateFeeRate "0.01"`, `enableTrade true`, `enableOpenPosition true`, `oraclePriceQuorum "1"`. All contract ids start with `300…`. 38 contracts have `enableDisplay false`.

The ANTHROPIC contract (complete, real):

```json
{
 "baseCoinId": "1192", "contractId": "30000192", "contractName": "ANTHROPICUSDC",
 "defaultLeverage": "5", "displayMaxLeverage": "5", "displayMinLeverage": "1",
 "defaultMakerFeeRate": "0.0004", "defaultTakerFeeRate": "0.00045",
 "displayDigitMerge": "0.001,0.002,0.005,0.01",
 "enableDisplay": true, "enableOpenPosition": true, "enableTrade": true, "enableBoosterCredit": false,
 "fundingImpactMarginNotional": "10", "fundingQuoteImpactMarginNotional": "10",
 "fundingInterestRate": "0.0003", "fundingMaxRate": "0.02", "fundingMinRate": "-0.02",
 "fundingRateIntervalMin": "240",
 "isFx": false, "isStock": true,
 "liquidateFeeRate": "0.01", "matchServerName": "edgex-match-server",
 "maxMarketPositionSize": "2", "maxOrderSize": "4", "maxPositionSize": "10", "minOrderSize": "0.03",
 "maxOrderBuyPriceRatio": "0.2", "minOrderSellPriceRatio": "0.2",
 "openSizeReduceRatio": "0.99",
 "oraclePriceQuorum": "1", "oraclePriceSignedAssetIds": ["ANTHROPICUSD"],
 "oraclePriceSigners": ["0xb50cbeba205ddb685db2497eaea07f31a18a53ad"],
 "quoteCoinId": "1000", "resolution": "1000000000",
 "riskTierList": [
  {"tier": 1, "maxLeverage": "5", "maintenanceMarginRate": "0.1",   "positionValueUpperBound": "100000", "risk": "429496729", "upperBound": "429496729600000000000"},
  {"tier": 2, "maxLeverage": "4", "maintenanceMarginRate": "0.125", "positionValueUpperBound": "79228162514264337593543", "risk": "536870912", "upperBound": "340282366920938463463374607431768211455"}
 ],
 "stepSize": "0.01", "tickSize": "0.001",
 "syntheticAssetId": "0x414e5448524f504943555344430000",
 "tpslSpreadProtectionThreshold": "0.03"
}
```

Its coins:

```json
{"assetId": null, "coinId": "1192", "coinName": "ANTHROPIC", "iconUrl": "https://static.edgex.exchange/icons/coin/ANTHROPIC.png", "resolution": null, "showStepSize": "0.01", "stepSize": "0.01"}
{"assetId": "0x2ce625e94458d39dd0bf3b45a843544dd4a14b8169045a3a3d15aa564b936c5", "coinId": "1000", "coinName": "USDC", "iconUrl": "https://static.edgex.exchange/icons/coin/USDC.png", "resolution": "0xf4240", "showStepSize": "0.0001", "stepSize": "0.000001"}
```

Note the two encodings of `resolution`: contract = decimal string `"1000000000"` (1e9), USDC coin = hex string `"0xf4240"` (1e6). `riskTierList[].tier` is a JSON number.

`data.multiChain.chainList` (deposit/withdraw rails, all USDC, `coinId "1000"`, 6 decimals, `minDepositSize "10"`, `minWithdrawSize "2"`, `withdrawFeeRate "0"`, `withdrawMinFee "1"`, deposit and withdraw enabled):

| chain | chainId | USDC token | depositType | vaultAddress |
|---|---|---|---|---|
| Edge | 3343 | `0x98d2919b9A214E6Fa5384AC81E6864bA686Ad74c` | `NORMAL` | `0x4b1e12Fbee329d462eFCAe43E3fE52110C923717` |
| Ethereum | 1 | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | `CCTP` | (empty) |
| Arbitrum | 42161 | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | `CCTP` | (empty) |
| Base | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `CCTP` | (empty) |
| Optimism | 10 | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | `CCTP` | (empty) |
| Polygon | 137 | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | `CCTP` | (empty) |

Each chain entry also carries `cctpDomain`, `cctpTokenMessenger`, `cctpMessageTransmitter`, `cctpVaultRelayer`, `cctpResolvedMaxFee`, `txConfirm`, `rpcUrl`, `webTxUrl`.

### 1.3 Ticker (24 h)

```bash
curl -s "https://edgex-prod-v2.edgex.exchange/api/v2/public/quote/getTicker?contractId=30000192"
```
```json
{"code":"SUCCESS","data":[{"close":"1340.779","contractId":"30000192","contractName":"ANTHROPICUSDC","endTime":"1794785400000","fundingRate":"0.0002593","fundingTime":"1794772800000","high":"1349.814","highTime":"1794702021546","indexPrice":"1344.6465262719209870","lastPrice":"1340.779","low":"1324.091","lowTime":"1794706630547","markPrice":"1340.917946187133801426","nextFundingTime":"1794787200000","open":"1342.093","openInterest":"5.08","oraclePrice":"1340.917946187133801426","priceChange":"-1.314","priceChangePercent":"-0.000979","size":"164.98","startTime":"1794699000000","trades":"3168","value":"220647.56403"}], …}
```

- `size` = 24 h volume in base units (contracts); `value` = 24 h turnover in USDC; `openInterest` in base units; `priceChangePercent` is a fraction (−0.000979 = −0.0979 %).
- `markPrice` equals `oraclePrice` in every sample I took.
- `fundingRate` here is the current forecast; `fundingTime` = last settlement, `nextFundingTime` = next settlement.
- `contractId` is **required**: omitting it, or passing a comma list (`30000192,30000180`), returns `SUCCESS` with an empty `data` array. For all markets use the WebSocket channel `ticker.all.1s` (documented, not tested) or one call per contract.

### 1.4 Order book

```bash
curl -s "https://edgex-prod-v2.edgex.exchange/api/v2/public/quote/getDepth?contractId=30000192&level=15"
```
```json
{"code":"SUCCESS","data":[{"asks":[{"price":"1341.311","size":"0.75"},{"price":"1341.312","size":"0.75"}, …],"bids":[{"price":"1340.482","size":"0.72"},{"price":"1340.481","size":"0.75"}, …],"contractId":"30000192","contractName":"ANTHROPICUSDC","depthType":"SNAPSHOT","endVersion":"274738204","level":15,"startVersion":"274738154"}], …}
```

- `level` accepts only `15` or `200`. `level=50` → HTTP 200 body `{"code":"INVALID_DEPTH_LEVEL","msg":"depth level only support 15 and 200"}`.
- `level=200` returned 62 asks / 62 bids for ANTHROPIC (that is the whole book).
- Levels are objects `{price,size}`, not `[price,size]` tuples (the WebSocket doc shows tuples; the live feed sends objects, see 1.8). `level` is a JSON number.

### 1.5 Klines

```bash
curl -s "https://edgex-prod-v2.edgex.exchange/api/v2/public/quote/getKline?contractId=30000192&klineType=HOUR_1&priceType=LAST_PRICE&size=2"
```
```json
{"code":"SUCCESS","data":{"dataList":[{"close":"1343.563","contractId":"30000192","contractName":"ANTHROPICUSDC","high":"1343.996","klineId":"2061597509872545704","klineTime":"1794780000000","klineType":"HOUR_1","low":"1342.336","makerBuySize":"3.08","makerBuyValue":"4137.30989","open":"1342.376","priceType":"LAST_PRICE","size":"6.53","trades":"126","value":"8771.36636"}, …],"nextPageOffsetData":"0880818A889E3410ECDEA1EEB28091CE1C"}, …}
```

- Order: **newest first**. `klineTime` = candle open time.
- `klineType` enum [SDK]: `MINUTE_1, MINUTE_5, MINUTE_15, MINUTE_30, HOUR_1, HOUR_2, HOUR_4, HOUR_6, HOUR_8, HOUR_12, DAY_1, WEEK_1, MONTH_1`. Verified live: `MINUTE_1`, `HOUR_1`, `DAY_1`. An unknown value → `{"code":"GATEWAY_INVALID_REQUEST","msg":"invalid enum parameter"}`.
- `priceType` enum [SDK]: `LAST_PRICE, INDEX_PRICE, ORACLE_PRICE, ASK1_PRICE, BID1_PRICE, OPEN_INTEREST`. Verified live: `LAST_PRICE`, `ORACLE_PRICE`, `INDEX_PRICE` (the last two return `size`/`trades`/`value` = `"0"`).
- `size` max **1000**: `size=1001` → `{"code":"INVALID_GET_PAGE_SIZE","msg":"The page size must be less or equal than 1000. Current page size is '1001'."}`.
- Pagination: pass `nextPageOffsetData` back as `offsetData`; empty string = last page.
- Time window: `filterBeginKlineTimeInclusive` / `filterEndKlineTimeExclusive` (ms) verified live.
- `DAY_1` history for ANTHROPIC holds 19 candles; the oldest opens `1793059200000` = **2026-10-27 00:00 UTC**, so the market was listed around that date [INFERRED from data].

Multi-contract variant, verified:

```bash
curl -s "https://edgex-prod-v2.edgex.exchange/api/v2/public/quote/getMultiContractKline?contractIdList=30000192&klineType=MINUTE_1&priceType=LAST_PRICE&size=1"
```
```json
{"code":"SUCCESS","data":[{"contractId":"30000192","klineList":[{"close":"1341.813", … same kline object … }]}], …}
```

### 1.6 Funding

```bash
curl -s "https://edgex-prod-v2.edgex.exchange/api/v2/public/funding/getLatestFundingRate?contractId=30000192"
```
```json
{"code":"SUCCESS","data":[{"avgPremiumIndex":"-0.00023184","contractId":"30000192","forecastFundingRate":"0.0002593","fundingIndex":"1340.917946187133801426","fundingRate":"0.00027631","fundingRateIntervalMin":"240","fundingTime":"1794772800000","fundingTimestamp":"1794786240000","impactAskPrice":"1341.312","impactBidPrice":"1340.482","impactMarginNotional":"50","indexPrice":"1344.6450623904809870","interestRate":"0.0003","isSettlement":false,"markPrice":"1340.917946187133801426","oraclePrice":"1340.917946187133801426","predictedFundingRate":"0.00005000","premiumIndex":"-0.00061969","premiumIndexTimestamp":"1794786240000","previousFundingRate":"0.00041593","previousFundingTimestamp":"1794772740000"}], …}
```

- `contractId` required here too (no parameter → empty array).
- `fundingRate` = rate applied at the last settlement (`fundingTime`); `forecastFundingRate` = running estimate for the next settlement (matches `fundingRate` in the ticker); `isSettlement` is a boolean.

History:

```bash
curl -s "https://edgex-prod-v2.edgex.exchange/api/v2/public/funding/getFundingRatePage?contractId=30000192&size=3&filterSettlementFundingRate=true"
```

Real result, reduced to `(fundingTime, fundingRate, isSettlement)`: `(1794772800000, 0.00027631, true)`, `(1794758400000, 0.00041593, true)`, `(1794744000000, 0.00013871, true)`, then `nextPageOffsetData "0880BCD0F89D34"`.

- Settlements are **4 h apart** (14 400 000 ms), consistent with `fundingRateIntervalMin "240"`. The help pages that say "every hour" or "every 8 hours" are stale (section 7).
- Without `filterSettlementFundingRate=true` the page returns one record **per minute** (the running calculation), same object shape, `forecastFundingRate ""`.
- The docs say `size ≤ 100`; live, `size=101` and `size=1000` both returned that many rows. Do not rely on either bound; use ≤ 100.
- Other filters [DOC]: `filterBeginTimeInclusive`, `filterEndTimeExclusive`, `offsetData`.

### 1.7 Market status (price band, open/closed)

```bash
curl -s "https://edgex-prod-v2.edgex.exchange/api/v2/public/quote/getMarketStatus?contractId=30000192"
```
```json
{"code":"SUCCESS","data":{"contractId":30000192,"force":false,"limitHighPrice":"1615.6722522035325532","limitLowPrice":"1077.1148348023550354","markPrice":"1346.3935435029437943","status":true}, …}
```

Same call for AAPL (`30000012`) on this Sunday evening: `"limitHighPrice":"374.1621102693","limitLowPrice":"338.5276235769","markPrice":"356.3448669231","status":false`.

- `contractId` here is a JSON **number**, `status` and `force` booleans.
- `status:false` for AAPL while US markets are closed, `true` for ANTHROPIC at the same moment: ANTHROPIC is treated as open on a weekend [INFERRED].
- Band = mark × (1 ± 1/maxLeverage): ±20 % for ANTHROPIC (5x), ±5 % for AAPL (20x). This matches the "Stock Perpetual" rule quoted in section 5 [INFERRED from numbers].

### 1.8 Public WebSocket

URL: `wss://edgex-quote-prod-v2.edgex.exchange/api/v1/public/ws` — connected with Node 26 native `WebSocket`, no headers.

Observed sequence (real frames, trimmed):

```
<< {"sid":"72818e16-e877-4e5b-9712-cf740dd6bf2a","type":"connected"}
>> {"type":"subscribe","channel":"ticker.30000192"}
<< {"type":"subscribed","channel":"ticker.30000192","request":"{\"type\":\"subscribe\",\"channel\":\"ticker.30000192\"}"}
<< {"type":"quote-event","channel":"ticker.30000192","content":{"channel":"ticker.30000192","data":[{…}],"dataType":"Snapshot"}}
<< {"type":"quote-event","channel":"ticker.30000192","content":{"channel":"ticker.30000192","data":[{…}],"dataType":"changed"}}
<< {"type":"ping","time":"1794786313784"}
>> {"type":"pong","time":"1794786313784"}
<< {"type":"error","request":"{\"type\":\"subscribe\",\"channel\":\"bogus.channel\"}","content":{"code":"GATEWAY_INVALID_CHANNEL","msg":"invalid channel : bogus.channel"}}
```

- `content.dataType` is `"Snapshot"` for the first frame and lowercase **`"changed"`** afterwards (the docs write `Changed`). Compare case-insensitively.
- Server `ping` every **10 s** (observed at +5.5 s, +15.5 s, +25.5 s, +35.5 s). Reply `{"type":"pong","time":<same>}`. The official SDKs additionally send a client `ping` every 30 s [SDK].
- In 45 s on one quiet market: 63 ticker updates, 49 depth updates, 2 trades, 2 kline updates.

Channels verified live, with the **real** payload shapes (they differ from the field tables in the docs, which describe `price/open24h/volume24h/…`; trust these):

| Channel | Element of `content.data` (real) |
|---|---|
| `ticker.{contractId}` | Same object as REST `getTicker`, plus `bestAskPrice`, `bestBidPrice`, `marketOpen` (boolean) in the snapshot |
| `depth.{contractId}.15` (also `.200` per docs) | `{"asks":[{"price","size"}],"bids":[…],"contractId","contractName","depthType":"SNAPSHOT","endVersion","level":15,"startVersion"}`. Incremental frames carry levels with `"size":"0"` to delete a price. |
| `trades.{contractId}` | `{"contractId":"30000192","contractName":"ANTHROPICUSDC","isBestMatch":true,"isBuyerMaker":false,"makerOrderId":"816992913375363286","price":"1340.223","size":"0.07","takerOrderId":"816992913375364310","ticketId":"be4482e2-c595-4a44-bf35-d0209718f986","time":"1794786289545","value":"93.81561"}` |
| `kline.{priceType}.{contractId}.{klineType}` e.g. `kline.LAST_PRICE.30000192.MINUTE_1` | Same object as REST kline |
| `fundingRate.{contractId}` | Same object as REST funding, except the boolean is named `settlement` instead of `isSettlement`, and there is no `forecastFundingRate` |

Taker side of a trade: `isBuyerMaker:false` ⇒ the taker bought. There is no `side` field.

**Recent trades have no public REST endpoint** in the docs or SDKs (`/api/v2/public/quote/getTrades` and `/getTrade` → 404). The `trades.{contractId}` snapshot is the only source I found: it delivers the most recent trades on subscribe.

Documented but not tested by me: `metadata`, `ticker.all.1s`, `fundingRate.all`, `unsubscribe`.

### 1.9 Error shapes on private endpoints (no credentials)

```bash
curl -s "https://edgex-prod-v2.edgex.exchange/api/v2/private/account/getAccountAsset?accountId=1"
# HTTP 400 {"code":"GATEWAY_HEADER_REQUIRED","msg":"header required : 'X-edgeX-Api-Key'", …}
# with dummy headers → HTTP 401 {"code":"INVALID_API_KEY","errorParam":{"apiKey":"x"},"msg":"invalid apiKey : x", …}
```

This confirms the header name `X-edgeX-Api-Key` on the production gateway.

### 1.10 Undocumented public endpoints seen in the web bundle and callable today [BUNDLE + LIVE]

Not in the GitBook or the SDKs. Useful, but unsupported.

| Call | Result |
|---|---|
| `GET /api/v2/public/contract-labels` | Category tabs. The label `"multiLanguageKey":"tabs.pre-ipo","name":"Pre-IPO V2"` lists exactly `MOONSHOTUSDC, POLYMARKETUSDC, ANTHROPICUSDC`. Other keys: `tabs.stocks`, `tabs.etf`, `tabs.commodities`, `tabs.forex`, `tabs.prelaunch`, `tabs.newlist`, `tabs.hot`, `tabs.defi`, `tabs.layer1`, `tabs.layer2`, `tabs.meme`, `tabs.ai`. Each label object: `{contracts:[{contractId,contractName,rewardRate,sort}],multiLanguageKey,name,productCategory,rewardRate,sort}`; each label appears once per `productCategory` (`PrepV2`, `Arc`, `AppTradFi`). |
| `GET /api/v2/public/vip/config/list` | Fee tiers: level 0 maker `0.00040` / taker `0.00045`, level 1 `0.00038`/`0.00043`, 2 `0.00035`/`0.00040`, 3 `0.00030`/`0.00035`, 4 `0.00025`/`0.00030`, 5 `0.00020`/`0.00025`, 6 `0.00015`/`0.00020`. |
| `GET /api/v2/public/cmc/getContracts` | CoinMarketCap-style array with JSON **numbers**. ANTHROPIC row: `"ticker_id":"ANTHROPIC-USDC","base_currency":"ANTHROPIC","quote_currency":"USDC","product_type":"Perpetual","contract_type":"Vanilla","funding_interval_minutes":240,"open_interest":5.08,"open_interest_usd":6821.74404,"index_price":1345.9375978957828` |
| `GET /api/v2/public/quote/getTicketSummary?period=LAST_DAY_1` | Exchange totals: `{"tickerSummary":{"openInterest":"270116939.6…","period":"LAST_DAY_1","trades":"1085721","value":"790863631.0218900"}}` |
| `GET /api/v2/public/index/getIndexPriceConfig` | `SUCCESS`, `data: []` — the index composition is **not** published through it. |

---

## 2. Instruments

### 2.1 ANTHROPICUSDC — facts and gaps

Facts [LIVE]:

- Name `ANTHROPICUSDC`, `contractId 30000192`, base coin `ANTHROPIC` (`coinId 1192`), display name in the app "Anthropic PBC" [BUNDLE].
- Quote and collateral: **USDC** (`coinId 1000`). Linear: `value = price × size` (ticker `value`/`size` ratio confirms).
- Tick `0.001`, step `0.01`, min order `0.03`, max order `4`, max position `10`, max market-order position `2` (all in contracts).
- Leverage 1–5x; tier 1 up to 100 000 USDC position value at 10 % maintenance margin, tier 2 at 12.5 % / 4x.
- Fees: default maker 0.04 %, taker 0.045 %; liquidation fee 1 %.
- Funding every 4 h, clamp ±2 % per interval, interest component `0.0003`.
- Limit-price band ±20 % (`maxOrderBuyPriceRatio`/`minOrderSellPriceRatio` `0.2`).
- Flag `isStock: true`; listed under the app's "Pre-IPO" tab.
- Oracle: one signer `0xb50cbeba205ddb685db2497eaea07f31a18a53ad`, signed asset id `ANTHROPICUSD`, quorum 1. Crypto majors such as BTC have five signers; every stock-type contract has this single signer.
- 2026-11-15 23:47 UTC: last `1343.171`, index `1345.998`, oracle = mark `1342.781`; open interest `5.08` contracts (≈ 6 800 USDC); 24 h turnover ≈ 220 000 USDC. This is a **very thin** market.

Gaps — what edgeX does **not** publish (searched: GitBook, all 58 help-center articles, the web-app strings, web search):

- No contract specification for the Pre-IPO perps: no statement of what one contract represents, of the index constituents, of what happens at IPO, or of any settlement/conversion rule.
- The only applicable text is the generic "Stock Perpetual Contracts" page (quoted in 5.2), which does not mention pre-IPO names.
- The general price page says the index is a weighted average of "Binance, OKX, Bybit, and Coinbase" and the oracle comes from "Stork"; the V2 page says a native "Multi-CEX Oracle" (Binance, OKX, Bybit, Gate, MEXC). Neither says which applies to ANTHROPIC.

Cross-check [LIVE + INFERRED]: at the same minute Binance's public endpoint `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=ANTHROPICUSDT` returned `markPrice 1342.916`, `indexPrice 1342.916`. edgeX's index (`1345.9`) tracks the same number, so edgeX quotes in the **same unit as the CEX pre-IPO perps**. Press coverage of those CEX contracts (Binance, Bitget) says they assume about one billion shares, so price × 1e9 ≈ implied valuation (1 343 ⇒ ≈ 1.34 trillion USD). That convention is the other venues' and third-party reporting; **edgeX itself states nothing**. Do not display "implied valuation" in the wallet as an edgeX fact.

A perpetual here is a synthetic cash-settled contract in USDC. No source says it confers any claim on Anthropic shares.

### 2.2 Other non-crypto families in today's metadata

Quote currency is USDC for every one. Contract name = `<BASE>USDC`.

**Pre-IPO tab** (per `contract-labels`): `ANTHROPICUSDC` (30000192, 5x), `POLYMARKETUSDC` (30000180, 10x, last 23.81), `MOONSHOTUSDC` (30000179, 10x, "Moonshot AI", last 59.82).

**Other private-company style names flagged `isStock` but filed under the Stocks tab** [INFERRED from app display names]: `UNITREEUSDC` (Unitree), `CXMTUSDC` (CXMT), `ZHIPUUSDC` (Zhipu AI), `MINIMAXUSDC` (MiniMax), `CBRSUSDC` (Cerebras), `SPCXUSDC` ("SpaceX", 20x, last 139.81). Whether each is still private today was not checked.

**Equities (`isStock: true`, 99 contracts incl. the above and ETFs)**, ids 30000010–30000192:
`AAPL AMZN MSTR NVDA AMD GOOGL TSLA AVGO COIN CRCL HOOD META MSFT PLTR CRWV INTC LITE SNDK MU RKLB ORCL TSM SKHYNIX MRVL SAMSUNG SKHY TENCENT XIAOMI POPMART SOFI PENG SHAZ QCOM GS PYPL CRM V BRKB WMT JPM KO GIGADEV RDDT MEITUAN KUAISHOU AAOI NBIS OUST NET NAVER LGEL HANMI SAMSUNGEM WDC ZHONGJI VST SHOP ARM DELL MRNA DJT PDD IONQ MRK MARA BYD TEAM PATH CYPH APLD` (each + `USDC`). Mostly 10x; AAPL and NVDA 20x.

**ETFs / index trackers (also `isStock: true`)**: `SPY QQQ EWY EWJ DRAM SOXL SOXS KORU XLE TZA TBT TMF BITO XLV SNXX SKDD SKUU KODEX200 GDX LYTE`. There is no cash index contract; indices are reached through ETFs (SPY, QQQ 20x).

**Commodities (`isStock: false`, `isFx: false`; five oracle signers like crypto)**: `XAUUSDC` (30000005, 50x), `XAGUSDC`, `COPPERUSDC`, `CLUSDC`, `BZUSDC`, `NATGASUSDC`, `XPDUSDC`, `XPTUSDC`.

**FX (`isFx: true`)**: `USDJPYUSDC` (30000174, 50x, displayed), `JPYUSDC` (30000161) and `EURUSDC` (30000162) both `enableDisplay: false`.

**Crypto**: 93 − 8 commodities = 85 contracts, `BTCUSDC` = 30000001 (100x, tick 0.1, step 0.001).

The contract ids in the SDK READMEs (`10000001` BTCUSDT, …) are V1/USDT ids and do not exist in today's metadata. Always resolve ids from `getMetaData`.

---

## 3. Authentication of private requests [DOC + SDK]

Not exercised (no account). The docs and both SDKs agree on this part.

Headers on every `/api/v2/private/...` and `/api/v1/private/unified-asset/...` request:

| Header | Value |
|---|---|
| `X-edgeX-Api-Key` | API key |
| `X-edgeX-Passphrase` | API passphrase |
| `X-edgeX-Timestamp` | Unix ms as a decimal string |
| `X-edgeX-Signature` | lowercase hex HMAC-SHA256 |

```
message   = timestamp + METHOD + requestPath + bodyString
key       = base64( utf8(apiSecret) )          // the base64 TEXT is used as the HMAC key bytes
signature = hex( HMAC_SHA256(key, message) )
```

- `METHOD` uppercase. `requestPath` = path only, e.g. `/api/v2/private/account/getAccountAsset` (no host, no query).
- `bodyString` for **GET**: query parameters sorted by key, joined `k=v&k=v`, values not URL-encoded. The Go SDK drops empty values; the Python SDK does not filter.
- `bodyString` for **POST**: recursive serialisation of the JSON body (`getValue`):
  - `null` → `""`; string → as is; boolean → `true`/`false`; number → decimal string
  - array → elements joined with `&` (empty array → `""`)
  - object → keys sorted, `key=value` joined with `&`; nested objects are serialised the same way inline
- Timestamp must be within ±60 s of server time [DOC].
- Source: Python `edgex_sdk/internal/auth.py` lines 1–40 and 91–110; Go `sdk/client.go` `buildHMACSignature` (line 384), `getValue` (line 393), `buildSortedQueryString` (line 365).

Self-generated vectors (computed by running the official Python SDK's `auth.py` functions locally; **not** published by edgeX):

```
secret "test-secret", timestamp "1794786000000"
GET  /api/v2/private/account/getAccountAsset, body "accountId=724625476626153743"
     → 95527beab077fbcfbc47b9452041ad26b50d197249badfa9789955798c685f84
POST /api/v2/private/order/cancelOrderById, JSON {"accountId":"724625476626153743","orderIdList":["564827797948727434"]}
     body string "accountId=724625476626153743&orderIdList=564827797948727434"
     → e3ae18616aed0dddf9105bfef9536f01e93f4de7fcc42300022693e8ca5ee180
getValue({"reduceOnly":false,"openTp":null,"price":"1300.000","list":["a","b"],"obj":{"z":1,"a":true}})
     → "list=a&b&obj=a=true&z=1&openTp=&price=1300.000&reduceOnly=false"
```

The body string must be derived from exactly the JSON that is sent: a key present with `null` contributes `key=`, an absent key contributes nothing.

Private WebSocket [DOC + SDK]: `wss://edgex-quote-prod-v2.edgex.exchange/api/v1/private/ws?accountId=<id>&timestamp=<ms>` with the same four headers; string to sign = `timestamp + "GET" + "/api/v1/private/ws" + "accountId=<id>&timestamp=<ms>"`. The SDKs also pass the four headers as a WebSocket subprotocol: base64 of the JSON header object, `=` padding stripped (for clients that cannot set headers). No subscribe message; the server sends `connected`, then `{"type":"trade-event","content":{"event":"Snapshot",…}}`, then events `ORDER_UPDATE`, `DEPOSIT_UPDATE`, `WITHDRAW_UPDATE`, `TRANSFER_IN_UPDATE`, `TRANSFER_OUT_UPDATE`, `FUNDING_SETTLEMENT`. `content.data` groups: `account, collateral, collateralTransaction, position, positionTransaction, deposit, withdraw, transferIn, transferOut, order, orderFillTransaction`.

---

## 4. Private endpoints [DOC + SDK] — not callable without an account

Base `https://edgex-prod-v2.edgex.exchange`. Every call takes `accountId`. Lists in GET queries are comma-joined. Paginated responses: `data.dataList` + `data.nextPageOffsetData`.

### 4.1 Account, collateral, positions, PnL, liquidation price

| Need | Endpoint | Notes |
|---|---|---|
| Balance, equity, margin, positions, liquidation price in one call | `GET /api/v2/private/account/getAccountAsset?accountId=` | `data`: `account`, `collateralList`, `positionList`, `version`, `positionAssetList`, `collateralAssetModelList`, `oraclePriceList` |
| Account record | `GET …/account/getAccountById` | `id, userId, ethAddress, l2Key, clientAccountId, defaultTradeSetting, contractIdToTradeSetting, maxLeverageLimit, createOrderPerMinuteLimit, createOrderDelayMillis, status, isLiquidating` |
| Sub-accounts | `GET …/account/getAccountPage` | |
| Collateral by coin | `GET …/account/getCollateralByCoinId?coinIdList=` | |
| Position by contract | `GET …/account/getPositionByContractId?contractIdList=` | |
| Closed position history (realised PnL per position "term") | `GET …/account/getPositionTermPage` | |
| Position transactions | `GET …/account/getPositionTransactionPage` | `filterTypeList` enum: `BUY_POSITION, SELL_POSITION, SETTLE_FUNDING_FEE` |
| Collateral ledger | `GET …/account/getCollateralTransactionPage` | `filterTypeList` enum: `DEPOSIT, WITHDRAW, TRANSFER_IN, TRANSFER_OUT, POSITION_BUY, POSITION_SELL, POSITION_FUNDING, FILL_FEE_INCOME` |
| Equity snapshots | `GET …/account/getAccountAssetSnapshotPage` | |
| ADL indicator | `GET …/account/getAccountDeleverageLight` | |
| Orders attached to a position | `GET …/account/getPositionOrders` | |
| Set leverage | `POST …/account/updateLeverageSetting` `{accountId, contractId, leverage}` | HMAC only; `contractId "0"` = account default |
| Cross / isolated | `POST …/account/setMarginMode` | HMAC **and** EIP-712 by the trading signer, primary type `SetMarginPreferenceParams` `{accountId uint64, assetId uint64, marginMode uint8, nonce uint256, signer address}`; `marginMode` `0` cross, `1` isolated |

Field names to read [DOC]:

- `collateralAssetModelList[]`: `coinId, totalEquity, totalPositionValueAbs, initialMarginRequirement, riskValue, pendingWithdrawAmount, pendingTransferOutAmount, orderFrozenAmount, availableAmount`
- `positionAssetList[]`: `contractId, positionValue, maxLeverage, initialMarginRequirement, riskRate, riskValue, avgEntryPrice, liquidatePrice, bankruptPrice, worstClosePrice, unrealizePnl, termRealizePnl, totalRealizePnl` (spelling `unrealizePnl` / `liquidatePrice` is the API's)
- `positionList[]`: `contractId, openSize` (signed), `openValue, openFee, fundingFee, longTermStat, shortTermStat, …`
- `collateralList[]`: `coinId, amount, cumDepositAmount, cumWithdrawAmount, cumFillFeeAmount, cumFundingFeeAmount, …`

Funding payments: `getPositionTransactionPage` with `filterTypeList=SETTLE_FUNDING_FEE` (the docs' own signing example uses this filter), or the collateral ledger with `POSITION_FUNDING`, or the private WebSocket event `FUNDING_SETTLEMENT`.

### 4.2 Orders

| Action | Endpoint |
|---|---|
| Create | `POST /api/v2/private/order/createOrder` |
| Cancel by id | `POST …/order/cancelOrderById` `{accountId, orderIdList:[…]}` |
| Cancel by client id | `POST …/order/cancelOrderByClientOrderId` `{accountId, clientOrderIdList:[…]}` |
| Cancel all | `POST …/order/cancelAllOrder` `{accountId, filterCoinIdList, filterContractIdList, filterOrderTypeList, filterOrderStatusList, filterIsPositionTpsl}` |
| Max size | `POST …/order/getMaxCreateOrderSize` `{accountId, contractId, price}` → `maxBuySize, maxSellSize, ask1Price, bid1Price` |
| Open orders | `GET …/order/getActiveOrderPage` (`size` ≤ 200) |
| Order history | `GET …/order/getHistoryOrderPage` |
| Fills | `GET …/order/getHistoryOrderFillTransactionPage` |
| By id / client id | `GET …/order/getOrderById?orderIdList=`, `GET …/order/getOrderByClientOrderId?clientOrderIdList=` |

Cancels need HMAC only (no L2 signature). Response: `data.cancelResultMap {orderId: "SUCCESS"}`.

Query filters: `size, offsetData, filterCoinIdList, filterContractIdList, filterTypeList, filterStatusList, filterIsLiquidateList, filterIsDeleverageList, filterIsPositionTpslList, filterStartCreatedTimeInclusive, filterEndCreatedTimeExclusive` (+ `filterOrderIdList` for history and fills).

Enums [DOC + SDK]:

- `type`: `LIMIT, MARKET, STOP_LIMIT, STOP_MARKET, TAKE_PROFIT_LIMIT, TAKE_PROFIT_MARKET`
- `side`: `BUY, SELL`
- `timeInForce`: `GOOD_TIL_CANCEL, IMMEDIATE_OR_CANCEL, FILL_OR_KILL, POST_ONLY` (market types must use `IMMEDIATE_OR_CANCEL`)
- `triggerPriceType`: `LAST_PRICE, INDEX_PRICE, ORACLE_PRICE` (the docs also list `ASK1_PRICE, BID1_PRICE`; the Python SDK enum has only the first three)
- order `status`: `PENDING, OPEN, FILLED, CANCELING, CANCELED, UNTRIGGERED`
- `reduceOnly`: boolean field on any order

`createOrder` body (exact field names; from Python `edgex_sdk/order/client.py` lines 157–185, Go `sdk/order/client.go` lines 296–313):

```json
{
  "accountId": "…", "contractId": "30000192",
  "price": "1300.000", "size": "0.03",
  "type": "LIMIT", "side": "BUY", "timeInForce": "GOOD_TIL_CANCEL",
  "clientOrderId": "…", "expireTime": "<ms>",
  "reduceOnly": false,
  "triggerPrice": "", "triggerPriceType": "",
  "l2Nonce": "…", "l2Value": "39.00000", "l2Size": "0.03", "l2LimitFee": "1",
  "l2ExpireTime": "<ms>", "l2Signature": "<hex>",
  "sourceKey": "", "isPositionTpsl": false, "openTpslParentOrderId": "",
  "isSetOpenTp": false, "openTp": null, "isSetOpenSl": false, "openSl": null,
  "extraType": "", "extraDataJson": ""
}
```

Response: `{"code":"SUCCESS","data":{"orderId":"564814927928230158"}}`.

Attached TP/SL on entry: `isSetOpenTp`/`openTp`, `isSetOpenSl`/`openSl`, each sub-object `{side, price, size, clientOrderId, triggerPrice, triggerPriceType, expireTime, l2Nonce, l2Value, l2Size, l2LimitFee, l2ExpireTime, l2Signature}` — each needs its own L2 signature. Position-level TP/SL: `isPositionTpsl: true`. The SDKs do not build these signatures for you; the layout of a child order's `parentOrderHash`/`subOrderIndex` is **not documented** (section 7).

Idempotency: `clientOrderId` is described as "Client-defined ID for idempotency checks", and `l2Nonce` is derived from it, so one `clientOrderId` ⇒ one nonce ⇒ one signature. Server behaviour on a duplicate was not tested.

The web bundle also references `createTwapOrders` and `createSegmentOrders` [BUNDLE]; neither is documented.

### 4.3 Deposits, withdrawals, transfers (outside trading scope; for custody design)

- Unified asset API on `https://spot.edgex.exchange`: `POST /api/v1/private/unified-asset/getDepositData`, `getFeeByAssetFlow`, `getEIP712Data`, `submitAssetFlow`, `GET …/queryAssetFlows`.
- Deposit: `getDepositData` returns `{chainId, to, data, value}` — a transaction for the user's wallet to send. `attempt.source = "chain-<chainId>"`, `destination = "spot"` or `"perpv2"`.
- Withdraw: server returns EIP-712 data, primary type `AssetFlowAttempt`, domain name `edgeX Asset Flow`, signed with the **wallet** key, submitted as `userSignature` with `0x` prefix.
- Internal transfer: `POST /api/v2/private/transfer/createTransferOut`, signed with the **wallet** key in both SDKs (Python `transfer/client.py` line 162, Go `sdk/transfer/client.go` line 249).

---

## 5. Order signature

### 5.1 Scheme [DOC + SDK]

EIP-712 over secp256k1, standard Ethereum 65-byte signature with `v` = 27/28.

```
domain = { name: "EdgeX", version: "1",
           chainId: metadata.global.nativeChainId (fallback chainId)      → 3343 today,
           verifyingContract: metadata.global.contractAddress              → 0xeeb3fb05cca17745cbdf193a9b16537efb68fac8 today }

EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
OrderBase(uint256 nonce,address signer,uint64 accountId,uint256 expirationTimestamp)
LimitOrderParams(OrderBase base,int256 amountSynthetic,int256 amountCollateral,uint256 amountFee,
                 uint64 assetIdSynthetic,uint64 assetIdCollateral,bool isBuyingSynthetic,
                 bytes32 parentOrderHash,uint256 subOrderIndex)
primaryType = "LimitOrderParams"     // used for every order type, market and conditional included
```

Message construction, as implemented identically in both SDKs:

| Field | Value |
|---|---|
| `base.nonce` | `int(sha256(clientOrderId).hex[0:8], 16)` — first 32 bits |
| `base.signer` | address of the trading (SDK Signer) key |
| `base.accountId` | account id |
| `base.expirationTimestamp` | `floor(expireTime_ms / 1000)` (seconds), **not** `l2ExpireTime` |
| `amountSynthetic` | `int(size × contract.resolution)` |
| `amountCollateral` | `int(l2Price × size × quoteCoin.resolution)` |
| `amountFee` | `int(l2LimitFee × quoteCoin.resolution)` |
| `assetIdSynthetic` | `contract.contractId` |
| `assetIdCollateral` | `quoteCoin.coinId` (`"1000"`) |
| `isBuyingSynthetic` | `side == "BUY"` |
| `parentOrderHash` | 32 zero bytes |
| `subOrderIndex` | `0` |

Derived body fields:

- `l2Value = l2Price × size`; `l2Size = size`.
- `l2LimitFee = ceil(l2Value × max(defaultTakerFeeRate, defaultMakerFeeRate))` — rounded **up to a whole USDC** by both SDKs (`.Ceil()` / `ROUND_CEILING` on the decimal). A 39 USDC order signs a 1 USDC maximum fee. This is a cap, not the fee charged.
- Times: default `l2ExpireTime = now + 30 d`, `expireTime = l2ExpireTime − 8 d`; if the caller sets `expireTime`, `l2ExpireTime = expireTime + 8 d`. Docs: `l2ExpireTime` "must be >= `expireTime` + 8 days".
- Market, stop-market and take-profit-market orders: body `price = "0"`, but the signature uses a worst-case `l2Price`: BUY → `ceil(oraclePrice × 10 / tickSize) × tickSize`; SELL → `tickSize`. `oraclePrice` comes from `getTicker`. (Python `client.py` `_get_market_order_price`; Go `sdk/client.go` lines 794–859.)
- Resolution parsing: hex if the string starts with `0x`, otherwise decimal, used as is (not as an exponent).

Source lines:

- Python: `edgex_sdk/order/client.py` lines 67–191 (typed data at 125–149), `edgex_sdk/internal/eip712.py` (types and `sign_typed_data`), `edgex_sdk/internal/async_client.py` `calc_nonce`.
- Go: `sdk/order/client.go` lines 156–313 (typed data at 235–284), `sdk/internal/eip712.go` lines 84–108, `sdk/internal/utils.go` lines 20–27.

### 5.2 Which key, and what it can do

[DOC, Authentication page]: the SDK Signer dialog gives "**Private Key (Signer Key)** - Used to generate EIP-712 signatures for L2 actions such as orders, withdrawals, and transfers".

[SDK, README]: "`trading private key`: EIP-712 signing for order placement and `setMarginMode`; `wallet private key`: unified-asset withdrawal / transfer signing."

[DOC, L2 Signature page]: server verifies that the "recovered address matches the registered trading address for the account".

[BUNDLE]: "Each address can create a maximum of 6 SDK Signer"; "Binding your SDK Signer, which has trading permissions, to a third-party platform may pose security risks."

Reading: the SDK Signer is a delegated trading key, generated by the web app, registered against the account, and distinct from the wallet key. In the SDK code it signs only orders and margin mode; withdrawals and transfers are signed by the wallet key. Whether the **server** refuses a withdrawal or transfer signed by an SDK Signer is not stated anywhere I found, and the Authentication page's wording says the opposite. Treat a leaked SDK Signer as able to trade the account to zero, and treat "cannot withdraw" as unproven.

The main wallet does not sign individual orders in this flow. How the web app registers a signer is not documented; the bundle shows `POST /v1/private/account/updateAccountSigners` on the spot host [BUNDLE], payload unknown.

### 5.3 Official test vectors

**None with expected outputs.** The SDK tests only check round-trips:

- Go `sdk/internal/eip712_test.go`: signs a `TransferParams` struct with key `0x59c6995e998f97a5a0044966f0945380f7d7f4fbcbe8f85f8f19853f51e7f7b4`, asserts length 132, `v ∈ {27,28}`, and that the recovered address equals the key's address.
- Python `tests/test_eip712_signing.py`: signs a toy `Message{value:1}` with key `0123…cdef` on domain chainId `33431`, asserts length and hex only.

Self-generated vector, produced by executing the official Python SDK's `eip712.py` on today's real metadata (reproduce with `/tmp/edgex-research/scripts/vector.py`). It proves an implementation matches the **SDK**; it does not prove the exchange accepts it.

```
private key   0x59c6995e998f97a5a0044966f0945380f7d7f4fbcbe8f85f8f19853f51e7f7b4   (public test key from the Go SDK test)
signer        0x3c525baCDE632d065e92324b2bCe7dEAAFF2deff
accountId     724625476626153743          (example id from the docs)
clientOrderId "sp-wallet-test-0001"   →   l2Nonce 1390357366
order         BUY 0.03 ANTHROPICUSDC @ 1300.000, expireTime 1796000000000, l2ExpireTime 1796691200000
l2Value "39.00000", l2LimitFee "1"

domain  { name "EdgeX", version "1", chainId 3343, verifyingContract 0xeeb3fb05cca17745cbdf193a9b16537efb68fac8 }
message { base { nonce 1390357366, signer 0x3c525b…deff, accountId 724625476626153743, expirationTimestamp 1796000000 },
          amountSynthetic 30000000, amountCollateral 39000000, amountFee 1000000,
          assetIdSynthetic 30000192, assetIdCollateral 1000, isBuyingSynthetic true,
          parentOrderHash 0x00…00, subOrderIndex 0 }

domainSeparator 0x79de539348476909462cecff9279ca69c43987ba60e1590baced93d936a211d6
structHash      0xcd7842b60dd3263fd26b213252c621e68fea40fe04b5c065476fa883f71c076b
digest          0xf15beb425a7c319ed5217dfdca92c5c5dcf010d4e04ee768a27e2756eb4c046e
signature (r‖s‖v, no 0x)
  ca4a39a5629f4dc774b7159ee2f05e825aac82808ebf04f777054506e68e74bb4a8171891c022fe25418f87573b85c87cbd6bb0f256d64e95640bb51623ae9431c
```

---

## 6. Onboarding, rate limits, testnet, jurisdiction

### 6.1 Onboarding [DOC + LIVE metadata + BUNDLE]

- Settlement chain: **Edge mainnet, chainId 3343**; the V2 architecture page says it runs on "the Arbitrum technology stack as a transitional framework". Collateral: **USDC**, 6 decimals, `0x98d2919b9A214E6Fa5384AC81E6864bA686Ad74c` on Edge.
- Deposits: USDC from Ethereum, Arbitrum, Base, Optimism, Polygon through Circle CCTP, or directly on Edge. Minimum deposit **10 USDC**, minimum withdrawal 2 USDC, minimum withdrawal fee 1 USDC [LIVE metadata].
- Account creation and login happen in the web app (wallet signature or email/MPC via Privy). The bundle shows `GET /v2/public/account/getAccountIdForRegister`, `POST /v2/public/user/onboardSite`, `POST /v1/private/account/registerAccount`; none is documented and I did not call them. **There is no documented programmatic onboarding.**
- API credentials: web app → profile → **API Management → Perps V2 → SDK Signer → Detail**. One dialog yields API Key, API Secret, API Passphrase and the signer private key. "All credentials are shown only once." Optional IP allow-list ("Restrict to Trusted IPs Only (Recommended)").
- API access gate [BUNDLE]: "Stake {{amount}} EDGE to unlock API access, then create and manage your API keys"; "If your staked amount falls below the minimum requirement, your API whitelist access will be revoked"; error `USER_API_WHITELIST_ERROR` = "Your account does not have permission to access the API." The amount is not in the bundle; a search snapshot of `https://pro.edgex.exchange/edgex-api` reads "Stake 1,000 EDGE Tokens to Get API Whitelist". Unverified by me.
- The older help pages still describe USDT and "edgeX V1"; V1 assets are USDT, V2 assets are USDC (help article "How Do I Migrate to Perps V2", updated 2026-11-08).

### 6.2 Rate limits

- [DOC] Only qualitative: "Public API: Higher rate limits / Private API: Rate limits based on API key tier / WebSocket: Connection and subscription limits apply. Exceeding rate limits will result in HTTP 429 responses." **No numbers are published.**
- [DOC] The account record exposes `createOrderPerMinuteLimit` and `createOrderDelayMillis`; the app has the error `CREATE_ORDER_RATE_LIMIT_EXCEED` ("…Current create order per minute limit is {{createOrderPerMinuteLimit}} per minute"). Read the per-account limit from `getAccountById`.
- [LIVE] No rate-limit headers on public responses. About 60 public calls in a few minutes produced no 429.

### 6.3 Testnet / sandbox

- [LIVE] `https://testnet.edgex.exchange`, `https://edgex-testnet-internal-v2.edgex.exchange` and `https://cloudgw-testnet.edgex.exchange` all redirect to a **Cloudflare Access login** (`edgex-new.cloudflareaccess.com`). `wss://edgex-quote-testnet-v2.edgex.exchange` and `wss://quote-testnet.edgex.exchange` refuse the WebSocket handshake.
- [DOC] "Internal, non-production, and test-only domains are not part of the public documentation."
- [SDK] Tests default to `https://testnet.edgex.exchange`, Edge testnet chainId `33431`, test USDC `0x5a4f218dcb4e257a4586159e9ee925b0fa1df610`; the Go SDK supports custom headers "e.g., Cloudflare Access authentication" — so the testnet is for people who hold an access token.
- [BUNDLE] The app has a "Faucet" menu and strings for an old Sepolia faucet campaign ("please visit our Discord to get whitelisted"). No public faucet URL was found.
- [BUNDLE + LIVE metadata] The mainnet app has **"Perps Demo Trading — Simulate Perpetual Trading"** with claimable demo funds (`demoSelfClaimAmount "10000"`, re-claim below `demoSelfClaimEquityThreshold "1000"`). I found no API host, flag or header for the demo mode; whether it is reachable through the API is unknown.

Conclusion: **no public sandbox**. End-to-end signature acceptance can only be proven on mainnet with real funds, or by obtaining testnet access from edgeX.

### 6.4 Jurisdiction — Terms of Use

Source: `https://edgex-1.gitbook.io/edgeX-documentation/about/terms-of-use` (identical text in the help center article "Terms of Use", last updated 2026-10-04).

> "THE edgeX INTERFACE (AS DEFINED BELOW) IS NOT AVAILABLE TO PERSONS OR ENTITIES WHO RESIDE IN, ARE LOCATED IN, ARE INCORPORATED IN, OR HAVE A REGISTERED OFFICE IN THE UNITED STATES OF AMERICA OR CANADA (COLLECTIVELY, "BLOCKED PERSONS"). … WE DO NOT MAKE EXCEPTIONS; THEREFORE, IF YOU ARE A BLOCKED PERSON, THEN DO NOT ATTEMPT TO USE THE edgeX INTERFACE … USE OF A VIRTUAL PRIVATE NETWORK ("VPN") TO CIRCUMVENT THE RESTRICTIONS SET FORTH HEREIN IS PROHIBITED."

> "…you are not a Blocked Person, and are not accessing the Interface from within the United States or Canada (collectively, "Blocked Countries"); provided, however, that … all existing users of the Interface as of April 7, 2023 (the "Wind-Down Date") that reside in … Canada will be permitted to access the Interface until seven (7) days after the Wind-Down Date, and thereafter any associated accounts will be permanently blocked from placing orders other than market orders that reduce your positions;"

> "12.1 … As a result of restrictions under the Commodity Exchange Act and the regulations promulgated thereunder by the U.S. Commodity Futures Trading Commission ("CFTC"), no Blocked Person may enter into Perpetual Contracts using the Services."

Prohibited conduct includes: "use the Services from a jurisdiction (including an IP address in a jurisdiction) that we have, in our sole discretion, determined is a jurisdiction where the use of the Site, the Interface or the Services is prohibited, including any Blocked Countries or any Restricted Territory".

- Canada as a whole is a Blocked Country. Québec is not named; no province is carved out.
- Section 12.1 extends the ban from the "Interface" to perpetual contracts "using the Services", so calling the API directly instead of the web app does not obviously escape it. That is my reading of the text, not legal advice.
- Governing law: California; mandatory individual arbitration (sections 15–16).
- The app has a geo-block message ("Your address/wallet is not eligible due to repeated attempts to access from a restricted jurisdiction") [BUNDLE]. So addresses can be flagged.
- [LIVE] Public REST and WebSocket market data answered from a Canadian IP today. Private endpoints were not tested.

---

## 7. Unknown / contradictory

| # | Topic | What conflicts or is missing | Working assumption |
|---|---|---|---|
| 1 | `l2Signature` format | Go SDK returns `0x` + 130 hex (`eip712.go` line 107). Python SDK strips `0x` for orders (`sign_typed_data(..., include_0x=False)`) and its test asserts no prefix. Order API doc says "L2 signature (128 characters)" with a 128-hex V1-style example; `setMarginMode` doc says "`0x`-prefixed 132-character hex string". | Unresolved without a live order. Both SDKs are official, so the server probably accepts both; start with the Python form (130 hex, no prefix) for orders and fall back to `0x`. |
| 2 | Nonce | L2 Signature doc: `sha256(clientOrderId) mod 2^63`. Both SDKs and the Order API table: "First 32 bits of sha256(`clientOrderId`)". | Use the SDK form (first 8 hex chars). |
| 3 | Resolution | Docs describe `starkExResolution` and a "10^N" exponent rule; live metadata has no such field and gives literal values (`1000000000`, `0xf4240`). Doc example uses 10^10 for both. | Use live metadata literally, as the SDKs do. |
| 4 | Fee rounding | Doc example `l2LimitFee "0.048697"` (unrounded); both SDKs ceil to a whole quote unit. | Follow the SDKs. |
| 5 | Fee rate in doc | Doc example assumes 0.05 % taker; live default taker is 0.045 %; help article lists 0.038 %/0.018 % for non-VIP; `vip/config/list` says 0.045 %/0.040 %. | Live metadata and `vip/config/list`. |
| 6 | Transfer typed data | L2 Signature doc: `TransferParams{base, amount, assetIdCollateral, receiverAccountId, receiverPublicKey}` signed by the signer key. Both SDKs: `TransferParams{from,to,assetId,amount,nonce,deadline,signer}` signed by the **wallet** key. | SDKs. Out of trading scope. |
| 7 | Signer permissions | Docs say the Signer Key signs "orders, withdrawals, and transfers"; SDK README limits it to orders and `setMarginMode`. Server enforcement unknown. | Assume the worst (section 5.2). |
| 8 | Funding interval | Help/GitBook "Funding Fees": "exchanged every hour"; funding API doc: "settlement occurs every 8 hours"; live: 240 min on all 195 contracts, settlements 4 h apart. | 4 h, read `fundingRateIntervalMin` per contract. |
| 9 | Funding page size | Doc: ≤ 100. Live: 1000 accepted. | ≤ 100. |
| 10 | WebSocket payloads | Doc field tables (`price`, `open24h`, `[price,size]` tuples, `tradeId`, `side`, `Changed`) do not match the live frames. | Section 1.8. |
| 11 | Docs URL in SDKs | READMEs point to `https://docs.edgex.exchange`, which does not resolve (DNS). `edgex-typescript-sdk` is referenced in the Python repo but the GitHub repo returns 404. | GitBook. **No official TypeScript SDK exists**; port from Python/Go. |
| 12 | Doc minimal-call examples | Quote page shows `getTickerSummary` (404 live; the working name is `getTicketSummary`); funding page shows `getFundingRatePageByContractId?page=1&limit=20` while the reference section and SDKs use `getFundingRatePage` with `size`/`offsetData`. | Names verified live in section 1. |
| 13 | Recent trades over REST | No endpoint. | WebSocket `trades.{contractId}` snapshot. |
| 14 | Pre-IPO contract terms | Nothing published: unit, index sources, IPO conversion, delisting. | Section 2.1; ask edgeX support before listing the market in the wallet. |
| 15 | Index / oracle provider | "Stork" and "Binance, OKX, Bybit, Coinbase" (older page, still live) versus native "Multi-CEX Oracle … Binance, OKX, Bybit, Gate, MEXC" (V2 page). Stock-type contracts have a single oracle signer. | Unknown per instrument. |
| 16 | Child-order signatures | `parentOrderHash` / `subOrderIndex` exist in the type but are always zero in the SDKs; how attached TP/SL (`openTp`/`openSl`) must be signed is not documented. | Not implementable from sources; place TP/SL as separate conditional orders. |
| 17 | Conditional orders on stock-type markets | "Stock Perpetual" rules reject market orders while the underlying market is closed. ANTHROPIC reported `status:true` on a Sunday; whether market orders are always accepted for Pre-IPO names is not stated. | Use limit orders inside `limitLowPrice`/`limitHighPrice`. |
| 18 | API stake amount, rate-limit numbers, demo-mode API, testnet access | Not published. | Ask edgeX. |
| 19 | Min deposit | Help page says "10 USDT" (V1 text); live V2 metadata says 10 USDC. | 10 USDC. |
| 20 | GET signature and empty params | Go drops empty query values from the string to sign; Python keeps them. | Never send empty query parameters. |

Quoted "Stock Perpetual Contracts" rules (GitBook and help center, updated 2026-10-29), the only text that covers `isStock` markets:

> "Market Orders Rejected: The system will reject all Market Orders. Limit Orders Only: Only Limit Orders are supported, and the limit price must fall within the designated price range. … Formula: Long price upper limit is Last Closing Index Price × (1 + 1 / Max Leverage of the pair); Short price lower limit is Last Closing Index Price × (1 - 1 / Max Leverage of the pair). … During market closure, the Mark Price is also restricted within the price range. Clamping Mechanism: The price change is limited to 0.5% every 3 seconds."

---

## 8. What an `EdgeXAdapter` can rely on

Safe to build now (verified live, no account):

- Metadata, ticker, depth (15/200), klines, funding (latest + history), market status over REST; ticker, depth, trades, klines, funding over the public WebSocket, with the shapes in section 1.
- Symbol → `contractId` resolution from `getMetaData` by `contractName`; tick/step/min/max and risk tiers from the same object.

Buildable from sources but unproven until a funded mainnet account exists:

- HMAC request signing (section 3) — deterministic, vectors provided.
- Order typed data and signature (section 5) — matches the SDK byte for byte; exchange acceptance unverified, signature prefix ambiguous (item 1).
- Account, position, order, fill and funding readers (section 4) — field names from docs only.

Not buildable from public sources:

- Programmatic onboarding and SDK Signer creation (web UI only).
- A testnet integration test.
- Attached TP/SL child signatures.
- Any authoritative description of what `ANTHROPICUSDC` settles against.

Decision needed before trading code: the Canada clause (section 6.4).

---

## 9. Sources (all accessed 2026-11-15)

Official documentation (GitBook; every page also fetched as `.md`):

- Index: https://edgex-1.gitbook.io/edgeX-documentation/llms.txt
- API V2 overview ("Last Updated: 2026-06-11"): https://edgex-1.gitbook.io/edgeX-documentation/api-v2
- Authentication: https://edgex-1.gitbook.io/edgeX-documentation/api-v2/authentication
- L2 Signature: https://edgex-1.gitbook.io/edgeX-documentation/api-v2/sign
- Metadata / Quote / Funding: `…/api-v2/public-api/metadata-api`, `…/quote-api`, `…/funding-api`
- Account / Order / Asset / Transfer: `…/api-v2/private-api/account-api`, `…/order-api`, `…/asset-api`, `…/transfer-api`
- WebSocket: `…/api-v2/websocket-api`, `…/websocket-api/public-websocket`, `…/websocket-api/private-websocket`
- Stock perps: https://edgex-1.gitbook.io/edgeX-documentation/trading/stock-perpetual
- Forex perps: `…/trading/forex-perpetual-contracts`
- Prices, funding, fees, order types: `…/trading/last-price-index-price-and-oracle-price`, `…/trading/funding-fees`, `…/trading/trading-fees`, `…/trading/order-types`
- V2 architecture, self-custody, oracle: `…/edgex-v2`, `…/edgex-v2/v2-technical-architecture`, `…/edgex-v2/self-custody`, `…/edgex-v2/decentralized-oracle-pricing`
- Terms of Use: https://edgex-1.gitbook.io/edgeX-documentation/about/terms-of-use
- Dead: https://edgex-1.gitbook.io/edgeX-documentation/api (404), https://docs.edgex.exchange (does not resolve)

Help center (Zendesk, 58 articles listed through its public API):

- https://edgexhelp.zendesk.com/hc/en-001 — Terms of Use (art. 14555369411599, updated 2026-10-04), Stock Perpetual (14933736732943, 2026-10-29), How Do I Migrate to Perps V2 (16027554129551, 2026-11-08), Maintenance Margin & Liquidation Logic (14567269938703), Funding Fees (14555724026511), Perpetuals Trading Fee Structure (14567011680143), and a mirror of the API docs (16565803708303 and siblings, 2026-09)

Official SDKs (GitHub org `edgex-Tech`; repos: `edgex-python-sdk`, `edgex-golang-sdk`, `audit-reports`, `DefiLlama-Adapters`, `dimension-adapters`, `go-ethereum`, `sofa-jraft`):

- https://github.com/edgex-Tech/edgex-python-sdk — `main` @ `487274d97cd1b77e05a759dbdf75e191582adefc` (2026-09-10, "Bump version to 2.0.1"); PyPI `edgex-python-sdk` 2.0.1 (`<= 0.3.0` = V1, `>= 2.0.0` = V2)
- https://github.com/edgex-Tech/edgex-golang-sdk — `main` @ `a25b92ed45b44df330b2ab4533ff360c322642e3` (2026-09-02); `CHANGELOG.md` "[2.0.0] - 2026-03-10 … V2 API only"
- Both repos keep a deprecated `v1` branch (StarkEx signing).

Live hosts called:

- `https://edgex-prod-v2.edgex.exchange` (REST), `wss://edgex-quote-prod-v2.edgex.exchange/api/v1/public/ws` (WebSocket)
- `https://pro.edgex.exchange` (web app HTML; inline config lists `V2_API_BASEURL`, `WS_HOST_V2`, `TESTNET_LINK`; build time `2026.11.13 12:35:16`) and its bundles on `https://s3.edgex.exchange/static/js/…`
- Testnet hosts (all Cloudflare Access): `testnet.edgex.exchange`, `edgex-testnet-internal-v2.edgex.exchange`, `cloudgw-testnet.edgex.exchange`
- Cross-check only: `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=ANTHROPICUSDT`

Third-party context for the pre-IPO quoting convention (not edgeX; used only in 2.1):

- https://cryptobriefing.com/anthropic-pre-ipo-perps-1-8t-valuation/
- https://www.forbes.com.au/?p=211907
- https://www.bitget.com/de/support/articles/12560603884829

Not verified: the fmz.com page mentioned in the brief was not consulted; its claims (Perps V2, HMAC key/secret/passphrase, EIP-712 by an "SDK signer" key replacing V1 StarkEx keys) are each confirmed above from official sources.

Scratch material: `/tmp/edgex-research/` (`meta.json`, `r_*.json`, `u_*.json`, `docs/*.md`, `zd/`, `js/`, `sdk/`, `scripts/ws.mjs`, `scripts/vector.py`).
