# Private Markets & Synthetic Valuation — instrument inventory (research)

- Retrieved: **2026-11-15, 23:43–23:52 UTC** (all live calls below were made in that window).
- Scope: synthetic / perpetual instruments whose underlying is a **private (pre-IPO) company**, how each contract is defined, and whether a company valuation can be derived from its price.
- Raw responses are kept in `/tmp/private-markets-research/` (scratch, not versioned).
- Evidence labels used throughout:
  - **[LIVE]** = verified by a live API call made during this research.
  - **[DOCS]** = read in the operator's own documentation (URL given), not independently verifiable by API.
  - **[PRESS]** = reported by a news outlet or third-party research; lower confidence.
  - **[NOT VERIFIED]** = could not be confirmed; do not build on it.

> **Timing warning.** Anthropic's IPO is reported for pricing on 18 Nov and first trade on 19 Nov 2026 (press; the SEC filing states no date). Every Anthropic instrument below changes methodology, unit or oracle around that date, and Polymarket's `ANT-USD` rebases on 16 Nov. This inventory will be stale within days for Anthropic. Re-read the live `perpAnnotation`/`perpCategories` and the venue docs before shipping.

---

## 0. Headline findings

1. **Hyperliquid has 10 builder-deployed (HIP-3) perp dexes; only three list a live private-company perp today**: `xyz` (trade.xyz), `io` (EntropyIO) and `para` (Paragon). Five live pre-IPO markets in total: `xyz:ANT`, `xyz:OURA`, `io:ANTH`, `io:OAI`, `para:ANTH`.
2. **Ventuals (`vntl`) is shut down.** All 15 of its markets, including `vntl:SPACEX`, `vntl:OPENAI`, `vntl:ANTHROPIC`, return `isDelisted: true`. Felix (`flx`), Kinetiq (`km`, and all but one market of `mkts`), HyENA (`hyna`), dreamcash (`cash`) and ABCDEx (`abcd`) are also fully delisted.
3. **SpaceX is no longer private.** `xyz:SPCX` is annotated as a listed stock (Nasdaq: SPCX) and categorised `stocks`. Same for Cerebras (`CBRS`), Quantinuum (`QNT`), Unitree, CXMT, SHEIN, Jio (`JIO`), SK Hynix ADS (`SKHY`): all converted from pre-IPO to standard equity perps. They must not appear in a "private markets" module.
4. **Two incompatible price units coexist for the same company.**
   - `xyz:ANT`, `para:ANTH`: **USD per share** (≈ 101.9).
   - `io:ANTH`, `io:OAI`, Polymarket `ANT-USD` (until 16 Nov), Lighter `ANTHROPIC`/`OPENAI`: **USD billions of fully diluted valuation** (≈ 1 774).
   - Aster / Binance / Gate / Bitget `ANTHROPIC*`: **per share against a notional reference count of 1 billion shares** (≈ 1 343) — numerically "$B of valuation", but a different market that trades ~24 % below Entropy's.
5. **A valuation formula exists in the docs only for the valuation-unit contracts** (`price × 1e9`). trade.xyz and Paragon explicitly refuse to give a share count or implied market cap that may be relied upon → **no valuation may be derived from `xyz:ANT`, `xyz:OURA`, `para:ANTH` using venue docs.**
6. **Jurisdiction:** trade.xyz's Terms of Use name **Canada** as a restricted jurisdiction for its interface. Entropy restricts **Ontario** only. Paragon's list does not name Canada. See §5.

---

## 1. Hyperliquid — builder-deployed perp dexes

### 1.1 Request shapes (verified against docs and by calling them)

All are `POST https://api.hyperliquid.xyz/info`, `Content-Type: application/json`.

| Request body | Purpose | Status |
|---|---|---|
| `{"type":"perpDexs"}` | List of dexes. First element is `null` (the validator-operated main dex). | [LIVE] [DOCS] |
| `{"type":"meta","dex":"xyz"}` | `universe`, `marginTables`, `collateralToken` for one dex. `dex` defaults to `""` = main dex. | [LIVE] [DOCS] |
| `{"type":"metaAndAssetCtxs","dex":"xyz"}` | `[meta, assetCtxs[]]`; ctx has `funding`, `openInterest`, `prevDayPx`, `dayNtlVlm`, `premium`, `oraclePx`, `markPx`, `midPx`, `impactPxs`, `dayBaseVlm`. | [LIVE] [DOCS] |
| `{"type":"allPerpMetas"}` | Array of 11 metas (main + 10 dexes) in `perpDexs` order. | [LIVE] [DOCS] |
| `{"type":"perpCategories"}` | `[[coin, category], …]`; categories seen: `stocks`, `indices`, `commodities`, `crypto`, `preipo`, `fx`/`FX`, `rates`, `stock`. | [LIVE] [DOCS] |
| `{"type":"perpAnnotation","coin":"xyz:ANT"}` | `{category, description, displayName, keywords}` set by the deployer. **This is the on-chain contract description.** | [LIVE] [DOCS] |
| `{"type":"perpDexLimits","dex":"xyz"}` | `totalOiCap`, `oiSzCapPerPerp`, `maxTransferNtl`, `coinToOiCap`. Empty `dex` not allowed. | [LIVE] [DOCS] |
| `{"type":"perpDexStatus","dex":"xyz"}` | `{"totalNetDeposit": …}` | [LIVE] [DOCS] |
| `{"type":"l2Book","coin":"xyz:ANT"}`, `fundingHistory`, `candleSnapshot` | Work unchanged with the `dex:COIN` name. | [LIVE] |

Docs: <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals>

Gotchas observed:
- `perpAnnotation` returned `null` for some coins when called in a burst (46 of 223 calls), then the real object on retry for live coins. **Treat `null` as "unknown, retry", never as "no annotation".** For delisted `io:MOONSHOT`, `io:SBE`, `xyz:YMTC` it stayed `null` on retry, so their underlying is [NOT VERIFIED].
- `perpCategories` is the cheapest way to find private-company markets: filter `category == "preipo"`. It still lists delisted Ventuals coins, so always join with `isDelisted` from `meta`.
- Category strings are deployer-set and inconsistent (`fx` vs `FX`, `stock` vs `stocks`). Normalise.

### 1.2 All perp dexes [LIVE]

Index = position in the `perpDexs` array (needed for asset ids). Collateral token index resolved through `spotMeta` (0 = USDC, 235 = USDe, 268 = USDT0, 360 = USDH).

| Idx | Name | Full name | Deployer | Collateral | Assets | Live | Private-company markets |
|---|---|---|---|---|---|---|---|
| 0 | `""` | (main, validator-operated) | — | USDC (0) | 235 | — | none |
| 1 | `xyz` | XYZ | `0x88806a71d74ad0a510b350545c9ae490912f0888` | USDC (0) | 144 | 121 | **`xyz:ANT`, `xyz:OURA`** |
| 2 | `flx` | Felix Exchange | `0x2fab552502a6d45920d5741a2f3ebf4c35536352` | USDH (360) | 16 | 0 | none (all delisted) |
| 3 | `vntl` | Ventuals | `0x8888888192a4a0593c13532ba48449fc24c3beda` | USDH (360) | 15 | 0 | `vntl:SPACEX`, `vntl:OPENAI`, `vntl:ANTHROPIC` — **all delisted** |
| 4 | `hyna` | HyENA | `0x53e655101ea361537124ef814ad4e654b54d0637` | USDe (235) | 25 | 0 | none |
| 5 | `km` | Markets by Kinetiq | `0x71f0019cc7fa79e4f42587fb7b9a817d8d2429ec` | USDH (360) | 23 | 0 | none |
| 6 | `abcd` | ABCDEx | `0x372c7f69d0ecc14f73f89bd8a7dfb41bdf29857c` | USDC (0) | 1 | 0 | none |
| 7 | `cash` | dreamcash | `0xffa8198c62adb1e811629bd54c9b646d726deef7` | USDT0 (268) | 17 | 0 | none |
| 8 | `para` | Paragon | `0x8888888c43cbb7e1c4132542e46831bffd866ed3` | USDC (0) | 40 | 33 | **`para:ANTH`** |
| 9 | `mkts` | Markets By Kinetiq | `0x71f0019cc7fa79e4f42587fb7b9a817d8d2429ec` | USDC (0) | 24 | 1 (`mkts:BVIV`) | none |
| 10 | `io` | EntropyIO | `0x320c8988e3d1b5198f335802d7bfd2728a8fcac6` | USDC (0) | 24 | 16 | **`io:ANTH`, `io:OAI`** |

Trimmed real `perpDexs` element (lists truncated):

```json
{"name":"io","fullName":"EntropyIO","deployer":"0x320c8988e3d1b5198f335802d7bfd2728a8fcac6",
 "oracleUpdater":"0x94757f8dcb4bf73b850195660e959d1105cfedd5","feeRecipient":null,
 "assetToStreamingOiCap":[["io:ANTH","275000000.0"],["io:OAI","12000000.0"]],
 "assetToFundingMultiplier":[["io:ANTH","0.125"],["io:OAI","0.125"]],
 "assetToFundingInterestRate":[],"assetToFundingClamp":[]}
```

### 1.3 Live private-company markets — snapshot [LIVE, 2026-11-15T23:43:51Z]

| Coin | Asset id | szDec | Max lev | Margin flags in `meta` | Mark | Oracle | Funding (1 h) | OI (contracts) | OI ≈ USD | 24 h volume USD | Funding mult. | OI cap USD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `xyz:ANT` | 110138 | 2 | 10 | none (cross allowed) | 101.94 | 101.90 | −0.0000002726 | 1 087 195.90 | 110.8 M | 8 182 982 | 0.005 | 150 M |
| `xyz:OURA` | 110123 | 1 | 5 | `onlyIsolated:true`, `marginMode:"noCross"` | 48.761 | 48.761 | 0.0000000625 | 12 243.0 | 0.60 M | 8 955 | 0.005 | 25 M |
| `io:ANTH` | 200001 | 3 | 15 | none (cross allowed) | 1774.0 | 1774.0 | 0.0000015625 | 113 696.796 | 201.7 M | 7 898 736 | 0.125 | 275 M |
| `io:OAI` | 200000 | 3 | 6 | none (cross allowed) | 1318.7 | 1316.5 | 0.0000128651 | 5 732.216 | 7.6 M | 421 147 | 0.125 | 12 M |
| `para:ANTH` | 180031 | 3 | 10 | `onlyIsolated:true`, `marginMode:"strictIsolated"` | 101.63 | 101.75 | 0.000000075 | 875.456 | 0.09 M | 7 655 | 0.006 | 25 M |

"OI ≈ USD" is my arithmetic (contracts × mark), not an API field.

Trimmed real `metaAndAssetCtxs` entries:

```json
{"szDecimals":2,"name":"xyz:ANT","maxLeverage":10,"marginTableId":10,"growthMode":"enabled",
 "lastFeeScaleChangeTime":"2026-10-26T13:55:12.038690737","deployerFeeScale":"1.0"}
{"funding":"-0.0000002726","openInterest":"1087195.9000000004","prevDayPx":"101.81",
 "dayNtlVlm":"8182982.2046000008","oraclePx":"101.9","markPx":"101.94","midPx":"101.945"}

{"szDecimals":3,"name":"io:ANTH","maxLeverage":15,"growthMode":"enabled"}
{"funding":"0.0000015625","openInterest":"113696.796","prevDayPx":"1773.5",
 "dayNtlVlm":"7898735.9616000028","oraclePx":"1774.0","markPx":"1774.0","midPx":"1775.35"}

{"szDecimals":3,"name":"para:ANTH","maxLeverage":10,"onlyIsolated":true,
 "marginMode":"strictIsolated","growthMode":"enabled"}
{"funding":"0.000000075","openInterest":"875.456","oraclePx":"101.75","markPx":"101.63"}
```

On-chain annotations (`perpAnnotation`) [LIVE]:

```json
// xyz:ANT
{"category":"preipo","description":"ANT references 1 share of Anthropic, PBC Class A common stock (expected Nasdaq: ANT), quoted in USD. ANT is a pre-IPO market: the referenced security has not yet listed, and upon listing the market is intended to convert to a standard perpetual. Anthropic develops the Claude family of AI models.","displayName":"ANT","keywords":["anthropic","claude"]}
// xyz:OURA
{"category":"preipo","description":"OURA references 1 share of Oura Inc. common stock (Nasdaq: OURA), quoted in USD. OURA is currently a pre-IPO market reflecting the anticipated share price; it is expected to convert to a standard XYZ perpetual upon the IPO. ...","displayName":"OURA","keywords":["consumer","health"]}
// para:ANTH
{"category":"preipo","description":"ANTH tracks the value of one share of Anthropic. ...","displayName":"ANT","keywords":["claude","anthropic"]}
// io:ANTH  — description is EMPTY on-chain
{"category":"preipo","description":"","displayName":"ANT","keywords":["anthropic"]}
// io:OAI   — description is EMPTY on-chain
{"category":"preipo","description":"","displayName":"OPENAI","keywords":["openai","oai"]}
```

Three display-name traps for the UI:
- `xyz:ANT`, `para:ANTH` and `io:ANTH` all carry `displayName: "ANT"`, with prices of ~102, ~102 and ~1 774. Never key anything on `displayName`.
- Paragon's docs call the market `ANT`; the on-chain coin is `para:ANTH`.
- `io:ANTH` and `io:OAI` have no on-chain description, so the unit (USD billions) is **only** knowable from Entropy's docs. A parser that infers units from the annotation text will find nothing.

### 1.4 Delisted private-company markets (history only) [LIVE]

| Coin | Asset id | State | Frozen mark | Frozen oracle | Last daily candle |
|---|---|---|---|---|---|
| `vntl:SPACEX` | 130000 | `isDelisted:true` | 2109.5 | 2417.0 | 2026-06-12 |
| `vntl:OPENAI` | 130001 | `isDelisted:true` | 1336.2 | 1341.8 | 2026-06-15 |
| `vntl:ANTHROPIC` | 130002 | `isDelisted:true` | 1619.3 | 1618.9 | 2026-06-15 |

Their annotation is still served: *"OPENAI tracks the total valuation of OpenAI, in billions. E.g. if 1 OPENAI = $500, then the implied total valuation of the company is $500B."* Frozen prices are five months old and must never be shown as a current valuation. Note the frozen `markPx` and `oraclePx` differ; Ventuals' sunset guide gives the settlement prices as the 24 h mark TWAPs, 1 341.80 (OPENAI) and 1 618.90 (ANTHROPIC), which match `oraclePx`, not `markPx` [DOCS <https://docs.ventuals.com/sunset-guide>].

Also delisted, underlying [NOT VERIFIED] (annotation `null`): `io:MOONSHOT`, `io:SBE`, `xyz:YMTC`.

### 1.5 Trading these through the standard exchange API

- **Asset id** [DOCS, computed from LIVE indices]: `100000 + perp_dex_index × 10000 + index_in_meta`. Docs: *"Builder-deployed perps expect `100000 + perp_dex_index * 10000 + index_in_meta`."* <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids>. `perp_dex_index` is the position in `perpDexs` (xyz = 1, para = 8, io = 10); `index_in_meta` counts delisted entries too. Indices shift only by appending, but recompute from live `perpDexs` + `meta` rather than hard-coding.
- **Coin name** is always `{dex}:{coin}`.
- **Collateral** [LIVE]: `xyz`, `io`, `para` all report `collateralToken: 0` = **USDC**. No USDH needed for any live private-company market. (USDH was the collateral of the now-dead `vntl`, `flx`, `km`.)
- **Moving collateral into a dex** [DOCS <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint>]: action `sendAsset` with `sourceDex` / `destinationDex` (`""` = main USDC perp dex, `"spot"` = spot) and `token` as `name:tokenId`. *"Only the collateral token can be transferred to or from a perp DEX."*
- **Account abstraction** [DOCS <https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes>]:
  - Standard/manual mode: *"separate perp and spot balances, separate DEX balances. Cross margin applies to each DEX separately."* → an explicit `sendAsset` per dex is required.
  - Unified account: *"USDC balance is the single source for validator-operated perps, XYZ perps, and spot trading against USDC as a quote asset."* The doc names XYZ; whether `io` and `para` are covered the same way is [NOT VERIFIED].
  - `userDexAbstraction` / `agentEnableDexAbstraction` are **deprecated**; replacement is `userSetAbstraction` with `abstraction ∈ {disabled, unifiedAccount, portfolioMargin}` (agent form: `agentSetAbstraction` with `"i" | "u" | "p"`).
  - For API users in unified/portfolio mode: *"Individual perp dex user states are not meaningful."* → read balances from the spot clearinghouse state.
  - Unified and portfolio-margin accounts are limited to 50k user actions per day.
- **Margin mode**: `xyz:OURA` (`noCross`) and `para:ANTH` (`strictIsolated`, margin can be added but not removed) must be opened isolated. `xyz:ANT`, `io:ANTH`, `io:OAI` carry no isolation flag.
- **Fees**: HIP-3 deployers add a fee share on top of the protocol fee; all five markets show `growthMode: "enabled"` and `deployerFeeScale: "1.0"` (`xyz:ANT`). Exact effective rate not computed here.
- **Halting/settlement power**: HIP-3 docs — *"The deployer may settle an asset using the `haltTrading` action"*, which cancels orders and settles positions at the current mark. That is exactly what happened to Ventuals' markets.
- **No write call was made.** Order placement on these assets is described from docs only.

---

## 2. Contract definitions per deployer

### 2.1 trade.xyz (`xyz`) — `xyz:ANT`, `xyz:OURA` [DOCS]

Sources: <https://docs.trade.xyz/perpetuals/markets/pre-ipo-perpetuals>, <https://docs.trade.xyz/perpetuals/specifications-and-schedules/pre-ipo-specification-index>, <https://docs.trade.xyz/perpetuals/markets/pre-ipo-perpetuals/alternative-settlement-events>.

- **What the price is**: USD per **one share**. *"ANT references 1 share of Anthropic, PBC Class A common stock (Nasdaq: ANT), quoted in USD. ANT is currently a pre-IPO market reflecting the anticipated share price."* Same wording for OURA (Oura Inc. common stock).
- **Nature**: *"Cash-settled linear perpetual contract"*; *"Pre-IPO Perpetuals are not shares. They are not IPO allocations. They are not tokenized equity…"*
- **Oracle**: no external source before listing. *"The oracle price is derived from a 30-minute exponentially-weighted moving average which advances via the market's impact price difference."* It is the market's own order book, nothing from Forge/Hiive/Notice/Caplight.
- **Funding**: *"computed as 1% of the standard XYZ perpetual funding calculation. This is a funding multiplier of 0.005"* (matches live `assetToFundingMultiplier`).
- **Price bands**: "Discovery Bounds" around the reference anchor. ANT ±50 %, 3 range resets, oracle threshold 75 %. OURA ±50 %, 2 resets, 75 %.
- **Hours**: 24/7.
- **On IPO**: converts in place to a standard equity perp with external pricing and funding multiplier 0.5, *"typically the first regular session after listing"*. The docs warn that *"the transition from internal to external pricing may produce a step change in mark price"*.
- **If no IPO**: default is the **TWAP of the market from launch to settlement date**; a transaction price may be used for an acquisition/take-private; an adverse event may use another fair-value price.
- **Per-market parameters**:

| | ANT | OURA |
|---|---|---|
| Status | Live | Live |
| Initial price | $125 | $50 |
| Max leverage | 10x | 5x |
| Margin mode | Cross Margin | Normal Isolated |
| Anticipated listing date | 20 Nov 2026 | 2 Oct 2026 (**already passed**) |
| Grace period ends | 19 Jan 2027 | **1 Dec 2026** |

  Oura postponed its IPO on 29 Sep 2026 (see §4). `xyz:OURA` is therefore inside its grace period and can enter alternative settlement after 1 Dec 2026.

- **Valuation formula: NONE.** The docs forbid it: *"Any displayed reference share count or implied initial reference market cap is indicative only. It is not guaranteed. It is not a fair value reference."* and *"These figures should not be treated as indicative market capitalizations or fair value references for the underlying issuer."* The specification index gives no share count. → `valuation_formula: null` for both.

### 2.2 EntropyIO (`io`) — `io:ANTH`, `io:OAI` [DOCS]

Sources: <https://docs.entropy.io/market-types/pre-ipo-perpetuals>, <https://docs.entropy.io/asset-directory/pre-ipo-assets>, <https://docs.entropy.io/pre-ipo-perp-mechanics/oracle-price>, `/mark-price`, `/funding-rate`, `/extreme-mark-bounds`, `/no-ipo-resolution`.

- **What the price is**: company valuation in USD billions. *"pre-IPO perpetuals are quoted in market cap: a price of $1 represents $1B of the company's fully diluted valuation."*
- **Valuation formula (defined by docs)**: `implied fully diluted valuation (USD) = price × 1 000 000 000`.
  At the snapshot: `io:ANTH` oracle 1 774.0 → $1.774 T; `io:OAI` oracle 1 316.5 → $1.3165 T. These are derivative market prices, not company figures.
- **Oracle**: blend of an internal price (5-minute-half-life EMA of the book mid) and an external price. *"External sources may include other derivative instruments, private market marking sources, funding rounds, or secondary transactions… The scoring and aggregation procedure is internal."* No provider is named. Internal weight grows with executable depth within 200 bps of mid and is capped at 0.95; the external aggregate keeps at least 5 %. Delivered on-chain by RedStone. Published about every 3 s.
- **Mark**: `clip(I(t); L, U)` — the internal EMA only, no external input.
- **Bounds**: ANTH `L = 300`, `U = 4 200`; OAI `L = 200`, `U = 3 000`. They clip published mark/oracle only; the book is unrestricted.
- **Funding**: Hyperliquid formula × `m = 0.125` (matches live), paid hourly, notional converted at the oracle price.
- **Hours / collateral**: 24/7, USDC.
- **On IPO**: the market does **not** switch to a per-share quote. *"The oracle switches to Share price × Fully diluted share count ÷ 1,000,000,000 at the first official opening trade."* The share count is fixed once from the final prospectus (424(b)) or latest S-1/A and never updated. Three calendar days before an announced listing the oracle becomes a 1-hour EMA of the mark.
  - Entropy publishes an **estimated** transition multiplier for ANTH of **17.498334025** (17 498 334 025 shares ÷ 1 B), *"Number can change pending 424b filing."*
  - I could **not** find that share total as a printed figure in the S-1/A (Amendment No. 2) text → the count is [DOCS: Entropy], [NOT VERIFIED against the filing].
- **If no IPO**: scheduled end two years after contract announcement (ANTH: 18 Aug 2028; OAI: 2 Sep 2028), cash-settled to the **6-month trailing TWAP of the mark**; early-settlement notice → 30-day TWAP; M&A → the confirmed deal market cap, else 30-day TWAP.
- **Per-market**: ANTH 15x, OI cap 275 M, cross. OAI 6x, OI cap 12 M, cross. (Both match live.)
- Entropy notes its markets can be auto-deleveraged (ADL page exists; not read in detail).

### 2.3 Paragon (`para`) — `para:ANTH` [DOCS]

Sources: <https://docs.paragon.trade/markets/equities/pre-listing-pricing>, <https://docs.paragon.trade/resources/specifications>.

- **What the price is**: USD per share. *"Tracks the expected value of one share of Anthropic, PBC ahead of a potential public listing."* The docs do not name a share class.
- **Oracle**: internal, same family as trade.xyz — continuous-time EMA of the impact price, τ = 30 min, shortening to 3 min from 24 h before the first expected public trades.
- **Manual reference anchoring**: Paragon *"reserves the right to set the oracle price directly"* to a publicly established offering price, outside the current bounds, which *"can move the oracle price by a large amount in a single step"*. Material for anyone holding through 18 Nov.
- **Funding**: multiplier `0.006` (matches live), expected to become `0.6` once listed.
- **Bounds**: ±10 %, 15 re-anchors per direction, oracle threshold 90 %.
- **Spec row**: 10x, OI cap $25 M, isolated, launch reference $110.00, expected listing date TBD, listing buffer 60 days, 24/7 until listing.
- **If no IPO**: TWAP from launch to the determination cutoff, unless another method is announced.
- **Valuation formula: NONE.** *"Any displayed share count or implied market capitalization is contextual only. Neither figure is guaranteed."* → `null`.

### 2.4 Ventuals (`vntl`) — defunct [DOCS]

Source: <https://docs.ventuals.com/perp-specifications/private-companies>, <https://docs.ventuals.com/sunset-guide>.

- Unit: *"The price of the perp contract is the company valuation divided by 1 billion."* → formula `price × 1e9`, historical only.
- Oracle: `1/3 × Notice price + 2/3 × EMA_2h(mark)`. Notice (<https://notice.co>) was the only named secondary-market data source among all deployers; it *"incorporates offchain valuation data, such as: secondary transactions, secondary bids and offers, official fundraising announcements, mutual fund marks, 409A valuations."*
- Shut down 15 Jun 2026; pre-IPO markets settled at 24 h mark TWAPs.

### 2.5 Felix (`flx`), Kinetiq (`km`, `mkts`)

Neither ever shows a private-company market in the current universe; every `flx` and `km` asset is delisted and `mkts` has one live market (`mkts:BVIV`, a volatility index). Nothing to integrate. [LIVE]

### 2.6 Cross-venue sanity check (not a formula)

Using Entropy's own published estimated multiplier, `io:ANTH` 1 774.0 ÷ 17.498334025 = **101.38 per share**, against `xyz:ANT` 101.90 and `para:ANTH` 101.75. The three Hyperliquid markets agree within about 0.5 %. This confirms the unit reading; it does not license applying Entropy's share count to `xyz:ANT`, whose reference is Class A only and whose docs disclaim any share count.

---

## 3. Other venues

Self-custody / on-chain venues first, then centralised exchanges for reference.

| Venue | Type | Public API | Instruments list endpoint | Private-company instruments found | Unit | Evidence |
|---|---|---|---|---|---|---|
| **Polymarket Perps** | Pure synthetic perp, margined in pUSD | Yes, `https://api.perpetuals.polymarket.com` | `GET /v1/info/instruments`, `GET /v1/info/tickers` | `ANT-USD` (id 97, `category:"pre_ipo"`, 10x, cross+isolated). Index 1 775.7, mark 1 776.5, OI 191.2. It is the only `pre_ipo` instrument out of 90. | USD billions until **16 Nov 2026 ~10:00 ET**, then USD per share via a "stock split" | [LIVE] + [DOCS] |
| **Lighter** | Pure synthetic perp | Yes, `https://mainnet.zklighter.elliot.ai` | `GET /api/v1/orderBooks`, `GET /api/v1/orderBookDetails?market_id=` | `ANTHROPIC` (193, last 1 773, 5x), `OPENAI` (192, last 1 366.3, 5x), `OURA` (4096, last 48.703, 5x); `SPACEX` (173) inactive | Unit **not found in Lighter docs**; the 1 773 level matches the USD-billions convention, the 48.7 level matches per-share. FalconX states Lighter's convention is "inferred from its price level". | [LIVE]; unit [NOT VERIFIED] |
| **Aster** | Pure synthetic perp | Yes, `https://fapi.asterdex.com` (Binance-style) | `GET /fapi/v1/exchangeInfo`, `/fapi/v1/premiumIndex`, `/fapi/v1/openInterest` | `ANTHROPICUSDT` 1 343.1, `ANTHROPICUSD1` 1 344.2, `OPENAIUSDT` 1 260.0, `OPENAIUSD1` 1 260.8, `POLYMARKETUSD1` 23.77, `OURAUSD1` 48.80, `MOONSHOTUSD1` 59.65. All `status: TRADING`, `underlyingSubType` contains `pre-launch`. | Per share against a "Reference Fully Diluted Share Count" of **1 billion** (OpenAI, Anthropic, Polymarket rows) | [LIVE] + [DOCS] |
| **edgeX** | Pure synthetic perp | — | `GET https://pro.edgex.exchange/api/v1/public/meta/getMetaData` returned an HTML page (HTTP 200, 9 KB), not JSON, from this network | none could be read | — | [NOT VERIFIED] — left to the colleague's edgeX research |
| **dYdX v4** | — | `GET https://indexer.dydx.trade/v4/perpetualMarkets` | — | none (`XAI-USD` is the Xai crypto token, in `FINAL_SETTLEMENT`) | — | [LIVE] |
| **GMX v2 (Arbitrum)** | — | `GET https://arbitrum-api.gmxinfra.io/tokens` | — | none (`SPCX` only, a listed stock) | — | [LIVE] |
| **Ostium** | — | `GET https://metadata-backend.ostium.io/PricePublish/latest-prices` | — | none (`SPCX/USD` only) | — | [LIVE] |
| Binance (CEX) | Synthetic perp | `GET https://fapi.binance.com/fapi/v1/exchangeInfo` | — | `ANTHROPICUSDT` 1 343.7, `OPENAIUSDT` 1 259.5, `OURAUSDT` 48.69; `underlyingType: PREMARKET`, `underlyingSubType: ["Pre-IPO","TradFi"]` | Per share on an estimated 1 billion shares | [LIVE]; unit [PRESS/search snippet of Binance page] |
| OKX (CEX) | Synthetic perp | `GET https://www.okx.com/api/v5/public/instruments?instType=SWAP` | — | `ANTHROPIC-USDT-SWAP` 102.6, `OPENAI-USDT-SWAP` 127.36, `OURA-USDT-SWAP` 48.699 | Per share (reference count rebased; reported 10 B for OpenAI) | [LIVE]; unit [PRESS] |
| Gate (CEX) | Synthetic perp | `GET https://api.gateio.ws/api/v4/futures/usdt/contracts` | — | `ANTHROPIC_USDT` 1 357.33, `OPENAI_USDT` 1 259.87, `OURA_USDT` 50.9, `POLYMARKET_USDT` 23.01, `KALSHI_USDT` 32.954, `ANDURIL_USDT` 95.22, `NEURALINK_USDT` 432.06 | not documented here | [LIVE]; unit [NOT VERIFIED] |
| Bitget (CEX) | Synthetic perp | `GET https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES` | — | `ANTHROPICUSDT` 1 346.66, `OPENAIUSDT`, `OURAUSDT`, `POLYMARKETUSDT` 24.04 | not documented here | [LIVE]; unit [NOT VERIFIED] |
| Bybit (CEX) | Synthetic perp | `GET https://api.bybit.com/v5/market/instruments-info?category=linear` | — | none in the first 1 000 linear instruments (only `SPCXUSDT`); Bybit's announcement describes `ANTHROPICUSDT`/`OPENAIUSDT` — pagination not followed | "≈ 1/1 000 000 000 of estimated market cap" pre-rebase | listing [NOT VERIFIED]; unit [DOCS: Bybit announcement] |

Notes:

- **Aster contract** [DOCS <https://docs.asterdex.com/trading/perpetuals/pre-ipo-perpetuals>]: *"ANTH is a pre-IPO market reflecting the market-implied expected price per share of Anthropic"*, *"Reference Fully Diluted Share Count: 1 billion"*. Aster reserves the right to *"Modify or replace the reference share count used for valuation"* and to settle or delist at its discretion. The docs define the reference count but do not print a valuation formula; `price × 1e9` is arithmetic on a notional count, so I mark it as *derivable with a caveat*, not as an operator-stated valuation. The Oura row carries no reference share count that I could read → `null`.
- **The same company is priced ~24 % apart across unit-equivalent venues.** Anthropic at the snapshot: Entropy/Polymarket/Lighter ≈ 1 774–1 776; Aster/Binance/Gate/Bitget ≈ 1 343–1 357. Both families read as "USD billions". They are different contracts with different settlement rules at the IPO (fully diluted count fixed from the prospectus on Entropy; a 1-billion notional count to be rebased on the Binance family). **Never average or cross-fill between venues.**
- **Polymarket `ANT-USD`** [DOCS <https://docs.polymarket.com/perps/learn-about-trading/markets/pre-ipo-anthropic>]: *"$1 of price equals $1B in fully diluted value (e.g. 1,650 = $1.65T)"*. Its index **is** Entropy's `io:ANTH` oracle until the split; afterwards Pyth `ANT/USD` (ID 3618). After 16 Nov the formula `price × 1e9` no longer applies to this symbol even though the symbol does not change.
- **Polymarket prediction markets** on valuations/IPO dates are binary outcome contracts, **not perps**; out of scope.
- **Hypercall** announced Anthropic options settling on Hyperliquid perp oracles [PRESS]; not checked.
- **Coinbase** is reported to list CFTC-regulated Anthropic/OpenAI/SpaceX pre-IPO perps [PRESS]; not checked.

### Tokenised SPV claims (not perps)

| Product | Chain | What you hold | Unit | Public data | Evidence |
|---|---|---|---|---|---|
| **PreStocks** | Solana (SPL, traded on Jupiter/Meteora) | Token described as backed 1:1 by a beneficial interest in an SPV holding the shares | Launch newsletter: *"Each PreStocks token is priced in terms of valuation. E.g. $100 means a $100B implied valuation."* | CoinGecko category `prestocks-ecosystem` (`anthropic-prestocks-2`: price 987.94, market cap $7.15 M, 7 680.6 circulating) | listing [LIVE via CoinGecko]; structure [PRESS + operator newsletter] |
| **Jarsy** | Base | 1:1 token per share held in Delaware LLC SPVs | per share | not checked | [PRESS] |
| **Republic** (rSPAX and similar) | Solana | Structured contingent debt note, not an equity transfer | — | not checked | [PRESS]; SpaceX is now public, so out of scope |

Flags for the module:
- The PreStocks Anthropic token traded at 987.94 while `io:ANTH` was 1 774 — a 44 % gap under the same nominal "USD billions" convention. With $7 M of market cap and a 14 % move in 24 h, it is not a usable valuation signal.
- Anthropic and OpenAI have publicly stated that transfers of their shares to SPVs are void under their transfer restrictions (reported 13 May 2026) [PRESS: <https://coinmarketcap.com/academy/article/anthropic-openai-tokenized-share-warning>]. PreStocks is reported not to have published the attestation reports it promised. Label these as **issuer-disputed tokenised claims**, distinct from perps.

---

## 4. Last known private valuation — reference data

Only companies with a live self-custody-reachable instrument (Anthropic, OpenAI, Oura, Polymarket). Gate-only names (Kalshi, Anduril, Neuralink) and Moonshot AI were **not researched**; do not display a reference valuation for them.

| Company | Figure | Kind | Date | Source | Confidence |
|---|---|---|---|---|---|
| Anthropic | $965 B post-money ($65 B Series H) | primary round | 2026-05-28 | <https://www.anthropic.com/news/series-h> | High (company release; also CNBC, Bloomberg) |
| Anthropic | IPO range $70.00–$78.00 per share, 825 000 000 Class A shares offered (801 351 354 primary + 23 648 646 secondary), option 123 750 000, Nasdaq "ANT" | IPO price range (not a valuation, not final) | 2026-11-10 | S-1/A No. 2: <https://www.sec.gov/Archives/edgar/data/2130357/000162828026072484/anthropicpbc-sx1ax2.htm> | High — range, share counts and ticker read directly in the filing |
| Anthropic | "up to $1.405 trillion on a fully diluted basis" at the top of the range | press estimate | 2026-11-10 | <https://www.cnbc.com/2026/11/10/anthropic-sets-price-range-of-70-to-78-in-upcoming-ipo.html> | Medium (CNBC computation, not a company statement) |
| OpenAI | $852 B post-money ($122 B committed) | primary round | 2026-03-31 | <https://openai.com/index/accelerating-the-next-phase-ai> | High (company release) |
| OpenAI | $852 B, ~$7 B employee buyback at an unchanged valuation | tender / buyback | 2026-08 | <https://www.techtimes.com/articles/323952/20260811/openai-completes-7b-employee-buyback-holds-852b-value-investor-cash-not-earnings.htm> (citing Bloomberg) | Medium (sourced to unnamed people) |
| OpenAI | $1.25 T, $11 B first close of a round of up to $20 B | primary round, **partly closed, company declined to comment, pre/post-money not stated** | 2026-11-06 | <https://www.bloomberg.com/news/articles/2026-11-06/openai-completes-11-billion-portion-of-funding-at-1-25-trillion-value> ; <https://www.reuters.com/business/openai-secures-11-billion-funding-125-trillion-valuation-bloomberg-news-reports-2026-11-06> | Medium |
| Oura | $11 B ($900 M Series E) | primary round | 2025-10 | <https://allium.so/blog/oura-ipo-valuation-from-11b-to-a-postponed-deal> (secondary write-up; original release not fetched) | Medium |
| Oura | $15.62 B fully diluted at the $40–$44 range, 50 M shares | IPO price range, **offering postponed 2026-09-29** | 2026-09-21 | <https://qz.com/oura-smart-ring-ipo-nasdaq-valuation-092126> (citing Reuters); postponement <https://www.cnbc.com/2026/09/29/smart-ring-maker-oura-postpones-ipo-due-to-market-uncertainty.html> | Medium |
| Polymarket | $21 B post-money ($1 B round led by 1789 Capital) | primary round (reported, sources "familiar with the matter") | 2026-08-31 | <https://www.bloomberg.com/news/articles/2026-08-31/polymarket-funding-round-led-by-1789-values-firm-at-21-billion> | Medium |

**Fully diluted share counts**

- **Anthropic**: the S-1/A exists and I read in it: 825 000 000 shares to new investors = "approximately 6.3 %" and existing stockholders 11 910 321 243 shares = "approximately 91.0 %" of Class A + Class N **outstanding** after the offering. That is a basic outstanding count, not fully diluted. The only fully diluted total I have is Entropy's published estimate of 17 498 334 025, which I could not match to a printed figure in the filing. CNBC's $1.405 T at $78 implies about 18.0 B. **These disagree; publish no single fully diluted count until the 424(b) is filed.**
- **OpenAI**: no credible public share count. Forge/NPM per-share indications exist [PRESS] but no official denominator.
- **Oura**: an S-1 was filed (3 Sep 2026, per press) so a count exists in the filing; not extracted here.
- **Polymarket**: none public.

The gap that the module must display honestly: Anthropic's last *primary round* is $965 B; its IPO range implies roughly $0.9–1.0 T on basic shares and up to ~$1.4 T diluted [PRESS]; `io:ANTH` prices it at $1.77 T. None of these is "the" valuation.

---

## 5. Jurisdiction notes (Canada / Québec)

| Operator | Clause | Canada / Québec | Source |
|---|---|---|---|
| **trade.xyz** (XYZ Ltd), Terms of Use, last updated 6 Sep 2026, §2.2 | *"'Restricted Persons' include: (a) persons or entities who reside in, are located in, are incorporated in, have a registered office or principal place of business in, or are otherwise subject to the laws of the United States of America, **Canada**, the United Kingdom, or certain other jurisdictions we may designate…"* §2.3: *"You must not use a VPN, proxy, Tor, or similar to circumvent geo-blocks or our eligibility rules."* | **Canada restricted in full, so Québec is restricted.** | <https://trade.xyz/terms> |
| **EntropyIO** | *"Services are not available to residents, citizens, or entities established in or operating from any of the following restricted jurisdictions: … United States (US) … **Ontario** … Cuba (CU) … Russia (RU) … Iran (IR), North Korea (KP)"* | Only **Ontario** is named. Québec is not listed. | <https://docs.entropy.io/legal-and-disclaimers/restricted-jurisdictions> |
| **Paragon** (Inactionable Inc.), Terms of Use dated 29 Jan 2026 | Not offered to persons in *"the United States or any Restricted Territory"*; the list is *"Antigua and Barbuda, Algeria, Bangladesh, Bolivia, Belarus, Burundi, Burma (Myanmar), Cote D'Ivoire…, Crimea, Donetsk or Luhansk, Cuba, Democratic Republic of Congo, Ecuador, Iran, Iraq, Liberia, Libya, Magnitsky, Mali, Morocco, Nepal, North Korea, Somalia, Sudan, Syria, Venezuela, Yemen, Zimbabwe or any other country to which the United States, the United Kingdom or the European Union embargoes goods…"* | Canada **not listed**. A general clause still requires that access not violate local law. | <https://docs.paragon.trade/legal/terms_of_use> |
| **Ventuals** | Not checked (operator defunct). | — | — |
| **Hyperliquid** interface terms | Page is a JavaScript app; text could not be extracted. | [NOT VERIFIED] | <https://app.hyperliquid.xyz/terms> |
| **Aster, Lighter, Polymarket Perps** | Not checked. | [NOT VERIFIED] | — |

Reading these correctly:
- The trade.xyz clause governs **its interface** (`app.trade.xyz`). The `xyz` markets themselves live on HyperCore and are reachable through Hyperliquid's API; trade.xyz's general disclaimer says it *"provides a non-custodial interface and does not hold user assets or control HyperCore."* Whether routing a Québec user's order to `xyz:ANT` from a third-party wallet is permitted is a **legal question this research does not answer**. The absence of Québec from Entropy's and Paragon's lists is likewise not a statement that the product is lawful to offer in Québec; derivatives distribution there falls under the AMF.
- What can be said factually: one of the three live deployers names Canada, one names Ontario only, one names neither.

---

## 6. Rules the module should enforce (derived from the above)

1. Discover markets from `perpCategories` (`preipo`) joined with `meta.universe[].isDelisted`; never from a hard-coded list. Three of the eight `preipo` coins are dead.
2. Store the price unit per `(venue, dex, symbol)` from a reviewed table, not from on-chain text: `io:ANTH`/`io:OAI` have empty descriptions.
3. Show an implied valuation only where `valuation_formula` is non-null, and label it "market-implied, derivative price" with the venue name.
4. Re-validate on a schedule: a `preipo` coin changing category to `stocks` (as SPCX, CBRS, QNT, JIO did) means it is no longer a private-company instrument and the unit/oracle rules changed.
5. Expect a discontinuity at each listing: trade.xyz and Paragon warn of a step change in mark; Paragon may re-anchor the oracle by hand; Polymarket rebases price and size.
6. Never mix venues in one series and never backfill from Ventuals' frozen prices.
7. Keep "last primary round" as a separate, dated, sourced field. It is not comparable to a perp-implied figure.

---

## Appendix A — verified instruments (machine-readable)

`verification`: `live` = instrument and price read by API call; `docs` = contract terms read in operator docs. `valuation_formula` is non-null only where the operator's documentation defines the unit that makes it valid.

```json
[
  {
    "venue": "Hyperliquid", "dex": "xyz", "symbol": "xyz:ANT", "asset_id": 110138,
    "underlying_company": "Anthropic, PBC", "status": "live",
    "contract_nature": "cash-settled linear perpetual, pure synthetic, no ownership",
    "price_unit": "USD per 1 share of Class A common stock",
    "valuation_formula": null,
    "formula_source_url": "https://docs.trade.xyz/perpetuals/markets/pre-ipo-perpetuals",
    "formula_note": "Operator states any reference share count or implied market cap is indicative only and not a fair value reference; no share count published.",
    "settlement": "Converts in place to a standard equity perp after listing (anticipated 2026-11-20, grace to 2027-01-19); otherwise TWAP from launch to settlement date, or transaction/fair-value price for M&A or adverse events.",
    "oracle_source": "Internal: 30-minute EWMA advanced by the market's own impact price. No external private-market data.",
    "collateral": "USDC", "max_leverage": 10, "margin": "cross allowed",
    "snapshot": {"mark": "101.94", "oracle": "101.9", "funding_1h": "-0.0000002726", "open_interest": "1087195.9", "day_ntl_vlm_usd": "8182982.20"},
    "verification": ["live", "docs"], "retrieved_at": "2026-11-15T23:43:51Z"
  },
  {
    "venue": "Hyperliquid", "dex": "xyz", "symbol": "xyz:OURA", "asset_id": 110123,
    "underlying_company": "Oura Inc.", "status": "live",
    "contract_nature": "cash-settled linear perpetual, pure synthetic, no ownership",
    "price_unit": "USD per 1 share of common stock",
    "valuation_formula": null,
    "formula_source_url": "https://docs.trade.xyz/perpetuals/specifications-and-schedules/pre-ipo-specification-index",
    "formula_note": "No share count published; IPO postponed 2026-09-29.",
    "settlement": "Converts to standard equity perp on IPO; anticipated listing date 2026-10-02 has passed, grace period ends 2026-12-01, after which alternative settlement (default: TWAP since launch) may apply.",
    "oracle_source": "Internal: 30-minute EWMA advanced by the market's own impact price.",
    "collateral": "USDC", "max_leverage": 5, "margin": "isolated only (noCross)",
    "snapshot": {"mark": "48.761", "oracle": "48.761", "funding_1h": "0.0000000625", "open_interest": "12243.0", "day_ntl_vlm_usd": "8955.28"},
    "verification": ["live", "docs"], "retrieved_at": "2026-11-15T23:43:51Z"
  },
  {
    "venue": "Hyperliquid", "dex": "io", "symbol": "io:ANTH", "asset_id": 200001,
    "underlying_company": "Anthropic PBC", "status": "live",
    "contract_nature": "cash-settled perpetual, pure synthetic, no ownership",
    "price_unit": "USD billions of fully diluted company valuation (1.00 = $1B)",
    "valuation_formula": "implied_fully_diluted_valuation_usd = price * 1000000000",
    "formula_source_url": "https://docs.entropy.io/market-types/pre-ipo-perpetuals",
    "formula_note": "After listing the oracle becomes share_price * fixed_fully_diluted_share_count / 1e9; estimated multiplier 17.498334025 published by Entropy, pending 424(b), not verified against the filing.",
    "settlement": "Stays a market-cap perp after IPO. If unlisted at 2028-08-18: 6-month trailing TWAP of mark. Early-settlement notice: 30-day TWAP. M&A: confirmed deal market cap, else 30-day TWAP.",
    "oracle_source": "Blend of internal 5-min-half-life EMA of book mid (weight up to 0.95 by executable depth) and an undisclosed aggregate of private-market sources (derivatives, private marks, funding rounds, secondary transactions), delivered by RedStone; clipped to [300, 4200].",
    "collateral": "USDC", "max_leverage": 15, "margin": "cross allowed",
    "snapshot": {"mark": "1774.0", "oracle": "1774.0", "funding_1h": "0.0000015625", "open_interest": "113696.796", "day_ntl_vlm_usd": "7898735.96"},
    "verification": ["live", "docs"], "retrieved_at": "2026-11-15T23:43:51Z"
  },
  {
    "venue": "Hyperliquid", "dex": "io", "symbol": "io:OAI", "asset_id": 200000,
    "underlying_company": "OpenAI Group PBC", "status": "live",
    "contract_nature": "cash-settled perpetual, pure synthetic, no ownership",
    "price_unit": "USD billions of fully diluted company valuation (1.00 = $1B)",
    "valuation_formula": "implied_fully_diluted_valuation_usd = price * 1000000000",
    "formula_source_url": "https://docs.entropy.io/market-types/pre-ipo-perpetuals",
    "formula_note": "Thin market: about $0.42M 24h volume and $7.6M open interest at snapshot.",
    "settlement": "If unlisted at 2028-09-02: 6-month trailing TWAP of mark. Early-settlement notice: 30-day TWAP. M&A: confirmed deal market cap, else 30-day TWAP.",
    "oracle_source": "Same Entropy blend as io:ANTH; clipped to [200, 3000].",
    "collateral": "USDC", "max_leverage": 6, "margin": "cross allowed",
    "snapshot": {"mark": "1318.7", "oracle": "1316.5", "funding_1h": "0.0000128651", "open_interest": "5732.216", "day_ntl_vlm_usd": "421147.19"},
    "verification": ["live", "docs"], "retrieved_at": "2026-11-15T23:43:51Z"
  },
  {
    "venue": "Hyperliquid", "dex": "para", "symbol": "para:ANTH", "asset_id": 180031,
    "underlying_company": "Anthropic, PBC", "status": "live",
    "contract_nature": "cash-settled perpetual, pure synthetic, no ownership",
    "price_unit": "USD per 1 share (share class not specified by operator)",
    "valuation_formula": null,
    "formula_source_url": "https://docs.paragon.trade/markets/equities/pre-listing-pricing",
    "formula_note": "Operator states any displayed share count or implied market cap is contextual only and not guaranteed. Very thin: about $7.7k 24h volume.",
    "settlement": "Transitions to Listed methodology after a qualifying listing; operator may manually anchor the oracle to the offering price; otherwise TWAP from launch to determination cutoff. Listing buffer 60 days.",
    "oracle_source": "Internal: continuous-time EMA of impact price, tau 30 min (3 min in the listing window).",
    "collateral": "USDC", "max_leverage": 10, "margin": "strict isolated",
    "snapshot": {"mark": "101.63", "oracle": "101.75", "funding_1h": "0.000000075", "open_interest": "875.456", "day_ntl_vlm_usd": "7654.77"},
    "verification": ["live", "docs"], "retrieved_at": "2026-11-15T23:43:51Z"
  },
  {
    "venue": "Hyperliquid", "dex": "vntl", "symbol": "vntl:ANTHROPIC", "asset_id": 130002,
    "underlying_company": "Anthropic", "status": "delisted",
    "contract_nature": "cash-settled perpetual, pure synthetic (settled 2026-06-15)",
    "price_unit": "USD billions of company valuation",
    "valuation_formula": "historical only: valuation_usd = price * 1000000000",
    "formula_source_url": "https://docs.ventuals.com/perp-specifications/private-companies",
    "settlement": "Settled at 24h mark TWAP 1618.90 on 2026-06-15.",
    "oracle_source": "Was 1/3 Notice price + 2/3 2h EMA of mark.",
    "verification": ["live", "docs"], "retrieved_at": "2026-11-15T23:43:51Z"
  },
  {
    "venue": "Hyperliquid", "dex": "vntl", "symbol": "vntl:OPENAI", "asset_id": 130001,
    "underlying_company": "OpenAI", "status": "delisted",
    "contract_nature": "cash-settled perpetual, pure synthetic (settled 2026-06-15)",
    "price_unit": "USD billions of company valuation",
    "valuation_formula": "historical only: valuation_usd = price * 1000000000",
    "formula_source_url": "https://docs.ventuals.com/perp-specifications/private-companies",
    "settlement": "Settled at 24h mark TWAP 1341.80 on 2026-06-15.",
    "oracle_source": "Was 1/3 Notice price + 2/3 2h EMA of mark.",
    "verification": ["live", "docs"], "retrieved_at": "2026-11-15T23:43:51Z"
  },
  {
    "venue": "Hyperliquid", "dex": "vntl", "symbol": "vntl:SPACEX", "asset_id": 130000,
    "underlying_company": "SpaceX (now public, Nasdaq: SPCX)", "status": "delisted",
    "contract_nature": "cash-settled perpetual, pure synthetic",
    "price_unit": "USD billions of company valuation",
    "valuation_formula": "historical only: valuation_usd = price * 1000000000",
    "formula_source_url": "https://docs.ventuals.com/perp-specifications/private-companies",
    "settlement": "Delisted; last daily candle 2026-06-12; settlement price not documented in the sunset guide.",
    "oracle_source": "Was 1/3 Notice price + 2/3 2h EMA of mark.",
    "verification": ["live", "docs"], "retrieved_at": "2026-11-15T23:43:51Z"
  },
  {
    "venue": "Polymarket Perps", "dex": null, "symbol": "ANT-USD", "instrument_id": 97,
    "underlying_company": "Anthropic, PBC", "status": "live",
    "contract_nature": "cash-settled perpetual, pure synthetic, margined in pUSD",
    "price_unit": "USD billions of fully diluted valuation until 2026-11-16 ~10:00 ET; USD per Class A share afterwards",
    "valuation_formula": "valid only before the 2026-11-16 rebase: implied_fully_diluted_valuation_usd = price * 1000000000",
    "formula_source_url": "https://docs.polymarket.com/perps/learn-about-trading/markets/pre-ipo-anthropic",
    "settlement": "Rebased by stock split (ratio = fully diluted share count / 1e9) to a per-share equity perp; no-IPO resolution date 2028-08-18 per Entropy rules.",
    "oracle_source": "Index = Entropy oracle for io:ANTH until the split; Pyth ANT/USD (ID 3618) afterwards.",
    "collateral": "pUSD", "max_leverage": 10,
    "snapshot": {"mark": "1776.5", "index": "1775.7", "funding_1h": "0.00000625", "open_interest": "191.21631"},
    "verification": ["live", "docs"], "retrieved_at": "2026-11-15T23:51:31Z"
  },
  {
    "venue": "Lighter", "dex": null, "symbol": "ANTHROPIC", "market_id": 193,
    "underlying_company": "Anthropic", "status": "live",
    "contract_nature": "perpetual, pure synthetic",
    "price_unit": "NOT VERIFIED in operator docs (price level 1773 is consistent with USD billions)",
    "valuation_formula": null, "formula_source_url": null,
    "settlement": "not verified", "oracle_source": "not verified",
    "snapshot": {"last_trade_price": 1773, "open_interest": 1239.77203, "daily_quote_volume_usd": 1093199.01},
    "verification": ["live"], "retrieved_at": "2026-11-15T23:49:30Z"
  },
  {
    "venue": "Lighter", "dex": null, "symbol": "OPENAI", "market_id": 192,
    "underlying_company": "OpenAI", "status": "live",
    "contract_nature": "perpetual, pure synthetic",
    "price_unit": "NOT VERIFIED in operator docs (price level 1366.3 is consistent with USD billions)",
    "valuation_formula": null, "formula_source_url": null,
    "settlement": "not verified", "oracle_source": "not verified",
    "snapshot": {"last_trade_price": 1366.3, "open_interest": 860.1645, "daily_quote_volume_usd": 365149.27},
    "verification": ["live"], "retrieved_at": "2026-11-15T23:49:30Z"
  },
  {
    "venue": "Lighter", "dex": null, "symbol": "OURA", "market_id": 4096,
    "underlying_company": "Oura", "status": "live",
    "contract_nature": "perpetual, pure synthetic",
    "price_unit": "NOT VERIFIED in operator docs (price level 48.703 is consistent with USD per share)",
    "valuation_formula": null, "formula_source_url": null,
    "settlement": "not verified", "oracle_source": "not verified",
    "snapshot": {"last_trade_price": 48.703, "open_interest": 1820.867, "daily_quote_volume_usd": 98253.56},
    "verification": ["live"], "retrieved_at": "2026-11-15T23:49:30Z"
  },
  {
    "venue": "Aster", "dex": null, "symbol": "ANTHROPICUSDT", "also": ["ANTHROPICUSD1"],
    "underlying_company": "Anthropic PBC", "status": "live",
    "contract_nature": "perpetual, pure synthetic",
    "price_unit": "USD per share against a reference fully diluted share count of 1 billion",
    "valuation_formula": "caveated: implied_valuation_usd = price * 1000000000 (reference count is notional and may be replaced at Aster's discretion; not an operator-printed formula)",
    "formula_source_url": "https://docs.asterdex.com/trading/perpetuals/pre-ipo-perpetuals",
    "settlement": "If no listing occurs, may be settled or terminated at Aster's discretion based on available valuation references.",
    "oracle_source": "not read in detail",
    "snapshot": {"mark": "1343.10697337", "index": "1343.10547170", "last_funding_rate": "0.00005000", "open_interest": "545.36"},
    "verification": ["live", "docs"], "retrieved_at": "2026-11-15T23:49:17Z"
  },
  {
    "venue": "Aster", "dex": null, "symbol": "OPENAIUSDT", "also": ["OPENAIUSD1"],
    "underlying_company": "OpenAI", "status": "live",
    "contract_nature": "perpetual, pure synthetic",
    "price_unit": "USD per share against a reference fully diluted share count of 1 billion",
    "valuation_formula": "caveated: implied_valuation_usd = price * 1000000000 (reference count is notional and may be replaced at Aster's discretion; not an operator-printed formula)",
    "formula_source_url": "https://docs.asterdex.com/trading/perpetuals/pre-ipo-perpetuals",
    "settlement": "At Aster's discretion if no listing occurs.",
    "oracle_source": "not read in detail",
    "snapshot": {"mark": "1259.96736369", "index": "1259.96596154", "open_interest": "38.4600"},
    "verification": ["live", "docs"], "retrieved_at": "2026-11-15T23:49:20Z"
  },
  {
    "venue": "Aster", "dex": null, "symbol": "POLYMARKETUSD1",
    "underlying_company": "Polymarket", "status": "live",
    "contract_nature": "perpetual; docs say it tracks 'the implied price of Polymarket ... based on tokenized pre-IPO exposure associated with Polymarket'",
    "price_unit": "USD per share against a reference fully diluted share count of 1 billion",
    "valuation_formula": "caveated: implied_valuation_usd = price * 1000000000 (reference count is notional; not an operator-printed formula)",
    "formula_source_url": "https://docs.asterdex.com/trading/perpetuals/pre-ipo-perpetuals",
    "settlement": "At Aster's discretion if no listing occurs.",
    "oracle_source": "not read in detail",
    "snapshot": {"mark": "23.76694874", "index": "23.64602626", "last_funding_rate": "-0.00192120", "open_interest": "1146.80"},
    "verification": ["live", "docs"], "retrieved_at": "2026-11-15T23:49:22Z"
  },
  {
    "venue": "Aster", "dex": null, "symbol": "OURAUSD1",
    "underlying_company": "Oura Inc.", "status": "live",
    "contract_nature": "perpetual, pure synthetic",
    "price_unit": "docs: 'tracks the price of Oura Inc.'; reference share count not read",
    "valuation_formula": null, "formula_source_url": "https://docs.asterdex.com/trading/perpetuals/pre-ipo-perpetuals",
    "settlement": "At Aster's discretion if no listing occurs.", "oracle_source": "not read in detail",
    "snapshot": {"mark": "48.79850000", "index": "48.72945173", "open_interest": "31078.57"},
    "verification": ["live", "docs"], "retrieved_at": "2026-11-15T23:49:23Z"
  },
  {
    "venue": "Aster", "dex": null, "symbol": "MOONSHOTUSD1",
    "underlying_company": "Beijing Moonshot AI Technology Co., Ltd.", "status": "live",
    "contract_nature": "perpetual, pure synthetic",
    "price_unit": "not read", "valuation_formula": null,
    "formula_source_url": "https://docs.asterdex.com/trading/perpetuals/pre-ipo-perpetuals",
    "settlement": "not read", "oracle_source": "not read",
    "snapshot": {"mark": "59.64700000", "index": "59.98483908"},
    "verification": ["live"], "retrieved_at": "2026-11-15T23:52:00Z"
  }
]
```

Centralised-exchange instruments (Binance, OKX, Gate, Bitget) are listed in §3 for context and deliberately left out of this block: a self-custody wallet cannot reach them and their units were not verified in operator docs.

## Appendix B — last known private valuations (machine-readable)

`valuation_usd` is `null` where the source gives a price range rather than a valuation.

```json
[
  {
    "company": "Anthropic", "valuation_usd": 965000000000,
    "kind": "primary round", "detail": "Series H, $65B raised, post-money",
    "date": "2026-05-28", "source_url": "https://www.anthropic.com/news/series-h", "confidence": "high"
  },
  {
    "company": "Anthropic", "valuation_usd": null,
    "kind": "IPO price range (not final, not a valuation)",
    "detail": "$70.00-$78.00 per share; 825,000,000 Class A shares offered; Nasdaq ANT; S-1/A Amendment No. 2",
    "date": "2026-11-10",
    "source_url": "https://www.sec.gov/Archives/edgar/data/2130357/000162828026072484/anthropicpbc-sx1ax2.htm",
    "confidence": "high"
  },
  {
    "company": "Anthropic", "valuation_usd": 1405000000000,
    "kind": "press estimate", "detail": "CNBC: 'up to $1.405 trillion on a fully diluted basis' at the top of the range",
    "date": "2026-11-10",
    "source_url": "https://www.cnbc.com/2026/11/10/anthropic-sets-price-range-of-70-to-78-in-upcoming-ipo.html",
    "confidence": "medium"
  },
  {
    "company": "OpenAI", "valuation_usd": 852000000000,
    "kind": "primary round", "detail": "$122B committed capital, post-money",
    "date": "2026-03-31", "source_url": "https://openai.com/index/accelerating-the-next-phase-ai", "confidence": "high"
  },
  {
    "company": "OpenAI", "valuation_usd": 852000000000,
    "kind": "tender", "detail": "about $7B employee buyback funded by the company, valuation unchanged",
    "date": "2026-08-11",
    "source_url": "https://www.techtimes.com/articles/323952/20260811/openai-completes-7b-employee-buyback-holds-852b-value-investor-cash-not-earnings.htm",
    "confidence": "medium"
  },
  {
    "company": "OpenAI", "valuation_usd": 1250000000000,
    "kind": "primary round",
    "detail": "$11B first close of a round of up to $20B; reported by unnamed sources; company declined to comment; pre- or post-money not stated",
    "date": "2026-11-06",
    "source_url": "https://www.bloomberg.com/news/articles/2026-11-06/openai-completes-11-billion-portion-of-funding-at-1-25-trillion-value",
    "confidence": "medium"
  },
  {
    "company": "Oura", "valuation_usd": 11000000000,
    "kind": "primary round", "detail": "$900M Series E",
    "date": "2025-10",
    "source_url": "https://allium.so/blog/oura-ipo-valuation-from-11b-to-a-postponed-deal",
    "confidence": "medium"
  },
  {
    "company": "Oura", "valuation_usd": 15620000000,
    "kind": "IPO price range (offering postponed 2026-09-29)",
    "detail": "fully diluted at $40-$44, 50M shares, per Reuters via Quartz",
    "date": "2026-09-21",
    "source_url": "https://qz.com/oura-smart-ring-ipo-nasdaq-valuation-092126",
    "confidence": "medium"
  },
  {
    "company": "Polymarket", "valuation_usd": 21000000000,
    "kind": "primary round", "detail": "$1B round led by 1789 Capital, post-money, reported by people familiar with the matter",
    "date": "2026-08-31",
    "source_url": "https://www.bloomberg.com/news/articles/2026-08-31/polymarket-funding-round-led-by-1789-values-firm-at-21-billion",
    "confidence": "medium"
  }
]
```

---

## Appendix C — what was not verified

- **edgeX**: metadata endpoint returned HTML; no instrument list obtained.
- **Lighter**: price units, oracle and settlement rules for `ANTHROPIC` / `OPENAI` / `OURA` not found in operator docs.
- **Anthropic fully diluted share count**: Entropy's 17 498 334 025 not matched to a printed total in the S-1/A.
- **Hyperliquid unified account** coverage of `io` and `para` (docs name XYZ only).
- **Hyperliquid interface terms** and the terms of Aster, Lighter, Polymarket Perps, Ventuals: not read.
- **`io:MOONSHOT`, `io:SBE`, `xyz:YMTC`** (delisted): underlying not confirmed, annotation `null`.
- **Bybit** pre-IPO listings: not found in the first page of instruments; pagination not followed.
- **Jarsy, Republic, Coinbase, Hypercall**: press only, no API call.
- **Reference valuations** for Kalshi, Anduril, Neuralink, Moonshot AI: not researched.
- **No order, transfer or any signed action was sent** to any venue; trading mechanics are from documentation.
- Secondary-market data providers (Forge, Hiive, Caplight, Nasdaq Private Market) are **not named by any live deployer** as an oracle input. Only the defunct Ventuals named one (Notice).
