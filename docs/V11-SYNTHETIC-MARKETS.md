# V11 — Private Markets & Synthetic Valuation

Synthetic contracts (perpetuals) whose underlying is a **private company**, shown venue by venue with what can — and
cannot — be derived from their price. **Display only: none of these instruments is tradable from the wallet.** The module
reads public market data; it has no account, builds no order and asks the signer for nothing.

Research dossier (source of every contract fact): `docs/v11/research/private-markets.md`, `docs/v11/research/edgex-api.md` §2.1.
Work note with the live smoke output: `docs/v11/work/private-markets.md`.

## 1. What is where

| Part | File |
|---|---|
| Hyperliquid builder dexes, read side (`adapter.builder`) | `packages/derivatives/src/venues/hyperliquid/builder.ts` |
| Valuation engine (pure) | `packages/trading/src/valuation/implied.ts` |
| Reviewed contract table + review state | `services/api/src/private-markets/contracts.ts` |
| Reference (private) valuations | `services/api/src/private-markets/references.ts` |
| Service: discovery, rows, valuation, caches, failure isolation | `services/api/src/private-markets/service.ts` |
| Routes (owner) | `services/api/src/private-markets/routes.ts` |
| Trading-API equivalents (`markets:read`) | `services/api/src/trading-api/{spec,routes,read}.ts` (three operations) |
| Screen and its model | `apps/web/src/screens/PrivateMarkets.tsx`, `apps/web/src/privateMarkets.ts` |
| Live read-only smoke | `scripts/smoke-private-markets.mts` |

## 2. Data sources

Only venues the wallet has an adapter for:

- **Hyperliquid, builder-deployed (HIP-3) dexes** — `POST https://api.hyperliquid.xyz/info` with `perpDexs`,
  `perpCategories`, `allPerpMetas`, `metaAndAssetCtxs` + `dex`, `perpAnnotation` + `coin`, `l2Book`, `candleSnapshot`
  (full `dex:COIN` name). Discovery = coins categorised `preipo` by the deployers, joined with `isDelisted`.
  - `perpAnnotation` answers `null` under load: it is retried (3 times, with a pause) and a final `null` means
    **unknown**, never "no annotation".
  - Category strings are deployer-set (`fx`/`FX`, `stock`/`stocks`): normalised.
  - The asset id (`100000 + dex index × 10000 + index in meta`) is computed from live `perpDexs` + `meta` and exposed as
    **informational**. Nothing uses it: the trading object, the pinned live asset table (`live/hl-assets.ts`) and the
    signer know the validator-operated dex only. Reason code: `builder_dex_read_only`.
- **edgeX** — instruments with `category: 'pre_ipo'` and their tickers, book and candles through the existing derivatives
  data service. edgeX is already market-data only in the wallet (its terms exclude Canada).

**Venues without adapter — not served, listed only:** Aster, Lighter, Polymarket Perps (and the centralised exchanges of
the dossier). The API names them in `venuesWithoutAdapter`; no figure of theirs is shown, and none is used to check or
fill another venue's data.

## 3. The reviewed contract table

A price says nothing about what it is a price **of**. `contracts.ts` is the only place where the wallet states it: one
entry per `venue:symbol`, written by a person from the operator's own documentation — underlying company, contract nature,
price unit, valuation formula id (or `null` + reason), formula source (URL, quoted sentence, date read), settlement and
IPO-conversion terms as stated by the deployer (or "not published"), oracle, margin/liquidation conditions, `reviewedAt`,
`validUntil`, and a **fingerprint** of the live metadata the review was made against (category, `szDecimals` or lot size,
collateral, sha256 of the on-chain annotation text).

| Live situation | What the API says | Valuation |
|---|---|---|
| in the table, within `validUntil`, fingerprint matches | `review.state: 'reviewed'` | per the entry |
| categorised pre-IPO by the venue, **absent** from the table | `not_reviewed` — "contract definition not reviewed" | none |
| past `validUntil` | `under_review` | none |
| fingerprint mismatch (annotation text, decimals/lot, category, collateral) or annotation unreadable | `under_review`, with each reason | none |
| the company is public today (`EXCLUDED_PUBLIC`: SpaceX/SPCX, CBRS, QNT, JIO, SKHY) | left out, reported in `excluded` with the reason | — |
| delisted (`isDelisted`) | only under `?delisted=true`, `status: 'delisted'`, prices marked frozen | none |

Market data is always the venue's live data; only the *meaning* is gated.

Entries on 2026-11-15: `hyperliquid:xyz:ANT`, `xyz:OURA`, `para:ANTH` (USD per share → no formula), `io:ANTH`, `io:OAI`
(USD billions of fully diluted valuation → `price_x_1e9`, Entropy documentation), `vntl:ANTHROPIC`, `vntl:OPENAI`
(delisted, historical), `edgex:ANTHROPICUSDC`, `POLYMARKETUSDC`, `MOONSHOTUSDC` (unit not published → no formula).

### Reviewing or extending an entry

1. Read the operator's documentation for the instrument. Copy the sentence that defines the unit, with its URL and today's date.
   No documented unit → `unit.kind: 'unknown'`, `valuationFormula: null`, `noFormulaReason`. Never infer a unit from a price level,
   a display name (`xyz:ANT`, `para:ANTH` and `io:ANTH` all display "ANT") or the press.
2. `valuationFormula: 'price_x_1e9'` only when the operator states that the price is the valuation in USD billions.
3. Record the fingerprint from live data: run `npx tsx scripts/smoke-private-markets.mts` (it prints `szDecimals`, lot,
   collateral) and hash the annotation description (`sha256`; the empty description of `io:*` has the hash of the empty string).
4. Set `validUntil` to the next date at which the operator says something changes (listing, grace period, rebase); otherwise 30 days.
5. Add the company to `COMPANIES` and, if researched, its figures to `references.ts`. Run
   `npx vitest run services/api/test/private-markets.test.ts` (the table's consistency rules are tested).

## 4. Five quantities, never one

Every instrument answers five separately labelled fields, each with its source and timestamp:

| # | Field | Meaning |
|---|---|---|
| 1 | `valuation.syntheticPrice` | the mark price, in the contract's own unit (frozen for a delisted market) |
| 2 | `valuation.contractMarketValue` | USD value of ONE contract = price × the venue's contract multiplier (both venues: linear, multiplier 1, from live metadata) |
| 3 | `valuation.notionalExposure` | USD exposure of a position (`?size=&side=`), signed; always `hypothetical: true` |
| 4 | `valuation.impliedValuation` | the company valuation the price implies — value + formula + formula source + date, or `null` + `reason` + `reasonCode` |
| 5 | `valuation.lastPrivateValuation` | reference data: value, kind (primary round / tender / …), date, source URL, confidence |

`valuation.premiumDiscount.premiumBps` compares 4 with 5 and exists only when both do. `valuation.caveats` carries: the
two standing caveats, **thin market** (open interest < 1 M USD or 24 h volume < 100 k USD, with the figures), **cross-venue**
(the other contracts on the same company, each with its own price and unit), **unit mismatch**, frozen price, stale data,
an unconfirmed convention, the company note.

### When the formula is refused

| `reasonCode` | Case |
|---|---|
| `per_share_no_share_count` | quoted per share; no fully diluted share count is publishable (the dossier found none: Entropy's 17 498 334 025 estimate does not match the S-1/A, CNBC implies ≈ 18.0 B) |
| `unit_not_published` | edgeX publishes no contract specification. The press convention "× 1e9" is shown as an **unconfirmed convention** with its source and is never applied |
| `not_reviewed` / `under_review` | see §3 |
| `delisted_frozen` | a frozen price is not a current price |
| `no_price` | the venue could not be read |

Engine rules (`@spw/trading`, `impliedValuation`): a valuation-unit contract whose `formulaSource` is `null` yields
`implied: null` with a reason (it used to be a flagged estimate); the optional `multiplier` of the descriptor gives contract
value and exposure for valuation-quoted contracts when the venue defines the contract size, else they stay `null` with a reason.

### Never merged

Contracts on the same company are different instruments (Anthropic on 2026-11-16: ≈ 1 771 in USD billions on Entropy,
≈ 101.7 and ≈ 101.4 per share on trade.xyz and Paragon, ≈ 1 339 in an unpublished unit on edgeX). The company view lists them
side by side; `merged` is always `null`. A spread (`divergence`) is computed only between reviewed contracts quoted in the
**same** unit. A venue that fails never borrows another venue's price.

## 5. API

| Route | Answer |
|---|---|
| `GET /api/v1/private-markets[?delisted=true][&size=&side=]` | `markets[]` (platform, symbol, exact contract nature, price, quote currency, volume, open interest, funding, contract size, multiplier, settlement, reference underlying, liquidation conditions, valuation), `companies[]`, `excluded[]`, `venues[]`, `venuesWithoutAdapter`, `notice`, `cache` |
| `GET /api/v1/private-markets/:id` | the row + top of book (5 levels) + candles + all references of the company + the other venues' contracts |
| `GET /api/v1/private-markets/companies/:slug` | every contract on the company, `delisted` apart, `merged: null` |
| `GET /api/v1/trading/private-markets…` | the same three, for API keys with `markets:read` (narrowed by the key's venue/instrument restrictions) — `docs/TRADING-API-OPENAPI.md` |

Each market datum is `{ value, source, ts, stale }`. **Failure isolation:** a venue that cannot be read gives rows (from the
reviewed table) with `error` and no price; the other venue answers; the call is a 200. **Caches** (`cache` in the answer):
Hyperliquid discovery 60 s (served stale up to 15 min), builder-dex tickers 20 s (stale up to 120 s), annotations 10 min,
book 5 s, candles 60 s, edgeX through the derivatives data service (tickers 3 s / 15 s). A datum older than 60 s
(Hyperliquid) or 15 s (edgeX) is flagged `stale`.

## 6. Jurisdiction (facts, not advice)

- trade.xyz Terms of Use §2.2 name **Canada** among the restricted jurisdictions of its interface.
- EntropyIO restricts **Ontario**; Québec is not listed. Paragon's list does not name Canada.
- edgeX's Terms of Use exclude Canada.
- The `xyz`/`io`/`para` markets live on HyperCore and are reachable through Hyperliquid's API; whether routing a Québec
  resident's order to them is lawful is a legal question the research does not answer (derivatives distribution in Québec
  falls under the AMF). The wallet therefore displays and does not trade; each row carries `tradable: false` and its reasons.

## 7. Limitations

- **IPO-week staleness.** Anthropic's IPO is reported for pricing on 18 Nov and first trade on 19 Nov 2026. trade.xyz converts
  `xyz:ANT` to a standard equity perp (step change in mark possible), Paragon may re-anchor its oracle by hand, Entropy
  switches its oracle to share price × a fixed share count ÷ 1e9. Every Anthropic entry has `validUntil = 2026-11-18T00:00Z`:
  from that instant they show "definition under review" and **no valuation** until someone re-reads the documentation and the
  live annotation and updates the table. `xyz:OURA` expires on 2026-12-01 (end of its grace period).
- Aster, Lighter, Polymarket Perps and the centralised exchanges are not read (no adapter). Polymarket's `ANT-USD` rebases
  from USD billions to USD per share on 16 Nov 2026.
- No fully diluted share count → no valuation from any per-share contract.
- Reference valuations are a dated copy of the dossier (2026-11-15); Moonshot AI has none.
- The contract terms and the detailed reasons are the operators' English sentences; the screen translates its own labels
  and the standard reasons (French / English), not the quoted documentation.
- No live stream for builder-dex coins: the screen polls every 20 s.
- The implied valuation uses the **mark** price. Entropy's oracle (which blends undisclosed external sources) is shown next to it.
