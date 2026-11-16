# V11 Phase D — Private Markets & Synthetic Valuation: work note

Branch `v11-private-markets` (from `v11`). Read-only public market data only: no account, no order, no signed action.
Module documentation: `docs/V11-SYNTHETIC-MARKETS.md`.

## 1. Hyperliquid builder dexes, read side

- **Initial state.** The adapter read the validator-operated dex only ("builder-deployed HIP-3 dexes … out of scope").
- **Change.** `packages/derivatives/src/venues/hyperliquid/builder.ts`, exposed as `adapter.builder` (same HTTP client and weight
  budget; not a second adapter): `dexes()`, `categories()`, `markets(dex)`, `assetIds()`, `annotation(coin)`, `book`, `candles`.
  Instruments carry `dex`, the full coin (`xyz:ANT`), `isDelisted`, the margin restriction (`onlyIsolated` / `noCross` /
  `strictIsolated`), max leverage, `szDecimals`, collateral, OI cap, funding multiplier, and the asset id computed from live
  data (informational). `tradable: false` with reason code `builder_dex_read_only`, also in `capabilities.notes`. The main-dex
  methods, the asset table, the trading object and `live/hl-assets.ts` are untouched. The API registry passes `builder`
  through its read-only view (`services/api/src/derivatives/venues.ts`, four lines).
- **API used.** `POST /info`: `perpDexs`, `perpCategories`, `allPerpMetas`, `metaAndAssetCtxs {dex}`, `perpAnnotation {coin}`, `l2Book`, `candleSnapshot`.
- **Tests.** `packages/derivatives/test/hyperliquid/builder-dexes.test.ts` — 18 tests on answers recorded 2026-11-16 00:42–00:44 UTC
  (`fixtures/hyperliquid/builder-*.json`, recorder `record-builder-dexes.mts`): perpDexs, perpCategories, metaAndAssetCtxs for
  xyz / io / para / vntl, allPerpMetas, perpAnnotation, books and candles incl. a delisted `vntl` market.
- **Observed.** 10 builder dexes; pre-IPO coins `io:ANTH`, `io:OAI`, `para:ANTH`, `xyz:ANT`, `xyz:OURA` live and `vntl:*` delisted;
  asset ids 110138, 110123, 200001, 200000, 180031, 13000x — as in the dossier.
- **Limitation.** No transient `null` of `perpAnnotation` could be reproduced during the capture (70 calls in bursts): the
  null-then-value test replays the real `null` body recorded for `io:MOONSHOT` (null on every attempt) followed by the real
  recorded annotation of `xyz:ANT`. No websocket stream for builder coins.

## 2. Reviewed contract table

- **Initial state.** None.
- **Change.** `services/api/src/private-markets/contracts.ts`: 10 entries, `EXCLUDED_PUBLIC`, `VENUES_WITHOUT_ADAPTER`,
  `reviewState()` (validity date + fingerprint).
- **Tests.** `services/api/test/private-markets.test.ts`: fingerprint mismatch → under review; `validUntil` passed → no valuation;
  unknown instrument → not reviewed; public company excluded; table consistency.
- **Observed.** All 10 entries match the live fingerprints on 2026-11-16.
- **Limitation.** The Anthropic entries expire at 2026-11-18T00:00Z by design; the fingerprint of edgeX is weak (category, lot
  size, collateral) because edgeX publishes no description to hash.

## 3. Reference valuations

- **Change.** `references.ts`: the nine figures of the dossier's Appendix B with kind, date, source URL, confidence. No share count.
  "Last private valuation" = the most recent primary round or tender.
- **Limitation.** OpenAI's reference is the round reported on 2026-11-06 (1.25 T USD, medium confidence, pre/post-money not
  stated); Moonshot AI has none.

## 4. Valuation engine

- **Initial state.** `impliedValuation` gave a flagged estimate for a valuation unit without `formulaSource`, and no contract
  value for valuation-quoted contracts.
- **Change.** (a) valuation unit + `formulaSource: null` → `implied: null` with a reason; (b) optional `multiplier` on the
  descriptor → contract market value and notional exposure. `packages/trading/test/implied.test.ts` updated (641 tests in the package).
- **Observed.** `io:*` → price × 1e9 with source; per-share → null; edgeX → null; contract value and exposure given everywhere a price exists.

## 5. API

- **Change.** `GET /api/v1/private-markets`, `/:id`, `/companies/:slug` (owner) and the same under `/api/v1/trading/…`
  (`markets:read`; `spec.ts`, `routes.ts`, `read.ts`; OpenAPI regenerated). Per-venue failure isolation, explicit cache ages.
- **Tests.** 26 tests in `services/api/test/private-markets.test.ts` (real server, real adapters over the recorded answers),
  one in `trading-api.test.ts` (key scopes and venue restriction).
- **Limitation.** `services/api` now depends on `@spw/trading` (package.json + 3 lines of lockfile).

## 6. Web

- **Change.** `apps/web/src/screens/PrivateMarkets.tsx` (lazy chunk, 25.7 kB), model `apps/web/src/privateMarkets.ts`, third tab
  "Marchés privés" of the trade area (`/private-markets`, `/private-markets/<id>`, `?v=delisted`), `pm*` i18n block (FR/EN).
- **Tests.** 23 tests in `apps/web/test/private-markets.test.ts`: components rendered to markup over API answers recorded live
  (`apps/web/test/fixtures/private-markets/`), helpers, i18n block.
- **Observed.** The built app was opened in Chromium (390 × 844 French, 1280 × 900 English) with the API answered from the
  recorded fixtures: list, delisted filter, three details; no page error, no horizontal overflow, row → detail navigation works.
  First chunk 257.71 kB → 258.38 kB (+0.67 kB: the route).
- **Limitation.** Contract terms, detailed reasons and company notes are the server's English sentences. On a phone the three
  trade-area tabs wrap on two lines in French.

## 7. Differences between the dossier (2026-11-15 23:43 UTC) and live (2026-11-16 01:06 UTC)

- No structural difference: same dexes, same five live pre-IPO coins, same delisted Ventuals coins, same annotations
  (hashes match), same margin flags, leverage, decimals, OI caps and funding multipliers.
- Prices moved slightly (`io:ANTH` 1774.0 → 1770.7; `xyz:ANT` 101.94 → 101.72; `para:ANTH` 101.63 → 101.41; `io:OAI` 1318.7 → 1313.0).
- **edgeX was readable** (the dossier's Appendix C says its metadata endpoint returned HTML): three `pre_ipo` contracts,
  `ANTHROPICUSDC` ≈ 1339, `POLYMARKETUSDC` ≈ 23.84, `MOONSHOTUSDC` ≈ 59.86.
- `xyz:CBRS`, `xyz:QNT`, `xyz:JIO`, `xyz:SKHY`, `xyz:SPCX` are categorised `stocks` live, as the dossier says.

## 8. Smoke — real output

`npx tsx scripts/smoke-private-markets.mts --json apps/web/test/fixtures/private-markets`, run 2026-11-16 01:06 UTC:

```
private markets smoke (read-only)  2026-11-16T01:06:03.549Z   hypothetical position: long 10

== venues
    hyperliquid              ok, 5 instrument(s), read 2026-11-16T01:06:03.950Z
    edgex                    ok, 3 instrument(s), read 2026-11-16T01:06:05.060Z

== live inventory: 8 instrument(s), 5 companies

  edgex:ANTHROPICUSDC   [live]   edgeX
    company                  Anthropic, PBC
    review                   reviewed (reviewed 2026-11-15, valid until 2026-11-18T00:00:00Z)
    nature                   USDC-margined linear perpetual, cash-settled, pure synthetic: no claim on any share (venue metadata; edgeX publishes no specification for it)
    unit                     unknown — unit not published by the venue; quote USDC; collateral USDC
    metadata                 max leverage 5x, margin cross / isolated, lot 0.01, szDecimals —, asset id — (informational), OI cap —, funding multiplier —
    price (mark)             1338.923121435860836647   oracle/index 1342.3357153475105841   read 2026-11-16T01:06:05.055Z
    funding                  0.00038228 per 14400 s
    open interest            5.04 contracts ≈ $6,748.17 (wallet arithmetic)
    24 h volume              $219,306.82  (164 contracts)
    1 synthetic price        1338.923121435860836647  [unit not published by the venue]
    2 contract value         $1,338.92 per contract
    3 notional exposure      $13,389.23 for a hypothetical long of 10
    4 implied valuation      null (unit_not_published) — unit not published by the venue: edgeX publishes no contract specification for its pre-IPO perpetuals (no statement of what one contract represents, of the index constituents, or of what happens at an IPO) — searched in its documentation, help center and app on 2026-11-15
    5 last private val.      $965,000,000,000  primary_round, 2026-05-28, confidence high  [https://www.anthropic.com/news/series-h]
    premium / discount       null — no implied valuation: unit not published by the venue: edgeX publishes no contract specification for its pre-IPO perpetuals (no statement of what one contract represents, of the index constituents, or of what happens at an IPO) — searched in its documentation, help center and app on 2026-11-15
    caveats                  synthetic, arithmetic, unconfirmed_convention, company_note, thin_market, cross_venue, unit_mismatch
      thin_market            Thin market: open interest ≈ $6.7k, 24 h volume ≈ $219.3k. A small order moves this price.
      cross_venue            Other contracts on Anthropic, PBC, each a different contract on its own venue: hyperliquid:io:ANTH 1770.7 (USD billions of fully diluted company valuation (1.00 = $1B)); hyperliquid:para:ANTH 101.41 (USD per 1 share (share class not specified by the operator)); hyperliquid:xyz:ANT 101.72 (USD per 1 share of Class A common stock). Prices are never averaged across venues and never used to fill another venue's gap.
    tradable                 false (venue_restricted)

  hyperliquid:io:ANTH   [live]   Hyperliquid · EntropyIO (dex io)
    company                  Anthropic, PBC
    review                   reviewed (reviewed 2026-11-15, valid until 2026-11-18T00:00:00Z)
    nature                   cash-settled perpetual quoted in market cap, pure synthetic, no ownership
    unit                     valuation_usd_billions — USD billions of fully diluted company valuation (1.00 = $1B); quote USD; collateral USDC
    metadata                 max leverage 15x, margin cross_allowed, lot 0.001, szDecimals 3, asset id 200001 (informational), OI cap $275,000,000, funding multiplier 0.125
    price (mark)             1770.7   oracle/index 1770.9   read 2026-11-16T01:06:04.590Z
    funding                  -0.0000115768 per 3600 s
    open interest            113667.386 contracts ≈ $201,270,840.39 (wallet arithmetic)
    24 h volume              $8,241,854.93  (4660.858 contracts)
    1 synthetic price        1770.7  [USD billions of fully diluted company valuation (1.00 = $1B)]
    2 contract value         $1,770.7 per contract
    3 notional exposure      $17,707 for a hypothetical long of 10
    4 implied valuation      $1,770,700,000,000  = implied fully diluted valuation (USD) = price × 1 000 000 000  [https://docs.entropy.io/market-types/pre-ipo-perpetuals, read 2026-11-15]
    5 last private val.      $965,000,000,000  primary_round, 2026-05-28, confidence high  [https://www.anthropic.com/news/series-h]
    premium / discount       8349.2228 bps (83.49 %)
    caveats                  synthetic, arithmetic, company_note, reference_kind, cross_venue, unit_mismatch
      cross_venue            Other contracts on Anthropic, PBC, each a different contract on its own venue: hyperliquid:para:ANTH 101.41 (USD per 1 share (share class not specified by the operator)); hyperliquid:xyz:ANT 101.72 (USD per 1 share of Class A common stock); edgex:ANTHROPICUSDC 1338.923121435860836647 (unit not published by the venue). Prices are never averaged across venues and never used to fill another venue's gap.
    tradable                 false (builder_dex_read_only)

  hyperliquid:para:ANTH   [live]   Hyperliquid · Paragon (dex para)
    company                  Anthropic, PBC
    review                   reviewed (reviewed 2026-11-15, valid until 2026-11-18T00:00:00Z)
    nature                   cash-settled perpetual, pure synthetic, no ownership
    unit                     usd_per_share — USD per 1 share (share class not specified by the operator); quote USD; collateral USDC
    metadata                 max leverage 10x, margin strict_isolated, lot 0.001, szDecimals 3, asset id 180031 (informational), OI cap $25,000,000, funding multiplier 0.006
    price (mark)             101.41   oracle/index 101.75   read 2026-11-16T01:06:04.594Z
    funding                  0.0000019997 per 3600 s
    open interest            875.456 contracts ≈ $88,779.99 (wallet arithmetic)
    24 h volume              $7,654.77  (75.956 contracts)
    1 synthetic price        101.41  [USD per 1 share (share class not specified by the operator)]
    2 contract value         $101.41 per contract
    3 notional exposure      $1,014.1 for a hypothetical long of 10
    4 implied valuation      null (per_share_no_share_count) — quoted per share, and the operator gives no share count to rely on: "Any displayed share count or implied market capitalization is contextual only. Neither figure is guaranteed."
    5 last private val.      $965,000,000,000  primary_round, 2026-05-28, confidence high  [https://www.anthropic.com/news/series-h]
    premium / discount       null — no implied valuation: quoted per share, and the operator gives no share count to rely on: "Any displayed share count or implied market capitalization is contextual only. Neither figure is guaranteed."
    caveats                  synthetic, arithmetic, company_note, thin_market, cross_venue, unit_mismatch
      thin_market            Thin market: open interest ≈ $88.8k, 24 h volume ≈ $7.7k. A small order moves this price.
      cross_venue            Other contracts on Anthropic, PBC, each a different contract on its own venue: hyperliquid:io:ANTH 1770.7 (USD billions of fully diluted company valuation (1.00 = $1B)); hyperliquid:xyz:ANT 101.72 (USD per 1 share of Class A common stock); edgex:ANTHROPICUSDC 1338.923121435860836647 (unit not published by the venue). Spread within this unit: 30.57 bps. Prices are never averaged across venues and never used to fill another venue's gap.
    tradable                 false (builder_dex_read_only)

  hyperliquid:xyz:ANT   [live]   Hyperliquid · trade.xyz (dex xyz)
    company                  Anthropic, PBC
    review                   reviewed (reviewed 2026-11-15, valid until 2026-11-18T00:00:00Z)
    nature                   cash-settled linear perpetual, pure synthetic, no ownership ("Pre-IPO Perpetuals are not shares. They are not IPO allocations. They are not tokenized equity")
    unit                     usd_per_share — USD per 1 share of Class A common stock; quote USD; collateral USDC
    metadata                 max leverage 10x, margin cross_allowed, lot 0.01, szDecimals 2, asset id 110138 (informational), OI cap $150,000,000, funding multiplier 0.005
    price (mark)             101.72   oracle/index 101.89   read 2026-11-16T01:06:04.624Z
    funding                  -0.0000009725 per 3600 s
    open interest            1089179.6800000002 contracts ≈ $110,791,357.05 (wallet arithmetic)
    24 h volume              $8,965,028.74  (88206.73 contracts)
    1 synthetic price        101.72  [USD per 1 share of Class A common stock]
    2 contract value         $101.72 per contract
    3 notional exposure      $1,017.2 for a hypothetical long of 10
    4 implied valuation      null (per_share_no_share_count) — quoted per share, and the operator publishes no share count: "Any displayed reference share count or implied initial reference market cap is indicative only. It is not guaranteed. It is not a fair value reference." No fully diluted share count is publishable before the 424(b) is filed.
    5 last private val.      $965,000,000,000  primary_round, 2026-05-28, confidence high  [https://www.anthropic.com/news/series-h]
    premium / discount       null — no implied valuation: quoted per share, and the operator publishes no share count: "Any displayed reference share count or implied initial reference market cap is indicative only. It is not guaranteed. It is not a fair value reference." No fully diluted share count is publishable before the 424(b) is filed.
    caveats                  synthetic, arithmetic, company_note, cross_venue, unit_mismatch
      cross_venue            Other contracts on Anthropic, PBC, each a different contract on its own venue: hyperliquid:io:ANTH 1770.7 (USD billions of fully diluted company valuation (1.00 = $1B)); hyperliquid:para:ANTH 101.41 (USD per 1 share (share class not specified by the operator)); edgex:ANTHROPICUSDC 1338.923121435860836647 (unit not published by the venue). Spread within this unit: 30.57 bps. Prices are never averaged across venues and never used to fill another venue's gap.
    tradable                 false (builder_dex_read_only)

  hyperliquid:io:OAI   [live]   Hyperliquid · EntropyIO (dex io)
    company                  OpenAI
    review                   reviewed (reviewed 2026-11-15, valid until 2026-12-15T00:00:00Z)
    nature                   cash-settled perpetual quoted in market cap, pure synthetic, no ownership
    unit                     valuation_usd_billions — USD billions of fully diluted company valuation (1.00 = $1B); quote USD; collateral USDC
    metadata                 max leverage 6x, margin cross_allowed, lot 0.001, szDecimals 3, asset id 200000 (informational), OI cap $12,000,000, funding multiplier 0.125
    price (mark)             1313   oracle/index 1310.9   read 2026-11-16T01:06:04.590Z
    funding                  0.0000149425 per 3600 s
    open interest            5733.586 contracts ≈ $7,528,198.42 (wallet arithmetic)
    24 h volume              $388,704.42  (294.315 contracts)
    1 synthetic price        1313  [USD billions of fully diluted company valuation (1.00 = $1B)]
    2 contract value         $1,313 per contract
    3 notional exposure      $13,130 for a hypothetical long of 10
    4 implied valuation      $1,313,000,000,000  = implied fully diluted valuation (USD) = price × 1 000 000 000  [https://docs.entropy.io/market-types/pre-ipo-perpetuals, read 2026-11-15]
    5 last private val.      $1,250,000,000,000  primary_round, 2026-11-06, confidence medium  [https://www.bloomberg.com/news/articles/2026-11-06/openai-completes-11-billion-portion-of-funding-at-1-25-trillion-value]
    premium / discount       504 bps (5.04 %)
    caveats                  synthetic, arithmetic, reference_kind
    tradable                 false (builder_dex_read_only)

  hyperliquid:xyz:OURA   [live]   Hyperliquid · trade.xyz (dex xyz)
    company                  Oura Inc.
    review                   reviewed (reviewed 2026-11-15, valid until 2026-12-01T00:00:00Z)
    nature                   cash-settled linear perpetual, pure synthetic, no ownership
    unit                     usd_per_share — USD per 1 share of common stock; quote USD; collateral USDC
    metadata                 max leverage 5x, margin no_cross, lot 0.1, szDecimals 1, asset id 110123 (informational), OI cap $25,000,000, funding multiplier 0.005
    price (mark)             48.76   oracle/index 48.76   read 2026-11-16T01:06:04.624Z
    funding                  0.0000017705 per 3600 s
    open interest            12243 contracts ≈ $596,968.68 (wallet arithmetic)
    24 h volume              $8,259.65  (169.7 contracts)
    1 synthetic price        48.76  [USD per 1 share of common stock]
    2 contract value         $48.76 per contract
    3 notional exposure      $487.6 for a hypothetical long of 10
    4 implied valuation      null (per_share_no_share_count) — quoted per share, and the operator publishes no share count; the IPO was postponed on 29 Sep 2026
    5 last private val.      $11,000,000,000  primary_round, 2025-10, confidence medium  [https://allium.so/blog/oura-ipo-valuation-from-11b-to-a-postponed-deal]
    premium / discount       null — no implied valuation: quoted per share, and the operator publishes no share count; the IPO was postponed on 29 Sep 2026
    caveats                  synthetic, arithmetic, company_note, thin_market
      thin_market            Thin market: open interest ≈ $597.0k, 24 h volume ≈ $8.3k. A small order moves this price.
    tradable                 false (builder_dex_read_only)

  edgex:POLYMARKETUSDC   [live]   edgeX
    company                  Polymarket
    review                   reviewed (reviewed 2026-11-15, valid until 2026-12-15T00:00:00Z)
    nature                   USDC-margined linear perpetual, cash-settled, pure synthetic: no claim on any share (venue metadata; edgeX publishes no specification for it)
    unit                     unknown — unit not published by the venue; quote USDC; collateral USDC
    metadata                 max leverage 10x, margin cross / isolated, lot 0.01, szDecimals —, asset id — (informational), OI cap —, funding multiplier —
    price (mark)             23.843732316662992181   oracle/index 23.843732316662992181   read 2026-11-16T01:06:05.055Z
    funding                  0.00020971 per 14400 s
    open interest            253.72 contracts ≈ $6,049.63 (wallet arithmetic)
    24 h volume              $229,126.93  (9614.76 contracts)
    1 synthetic price        23.843732316662992181  [unit not published by the venue]
    2 contract value         $23.84 per contract
    3 notional exposure      $238.44 for a hypothetical long of 10
    4 implied valuation      null (unit_not_published) — unit not published by the venue: edgeX publishes no contract specification for its pre-IPO perpetuals (no statement of what one contract represents, of the index constituents, or of what happens at an IPO) — searched in its documentation, help center and app on 2026-11-15
    5 last private val.      $21,000,000,000  primary_round, 2026-08-31, confidence medium  [https://www.bloomberg.com/news/articles/2026-08-31/polymarket-funding-round-led-by-1789-values-firm-at-21-billion]
    premium / discount       null — no implied valuation: unit not published by the venue: edgeX publishes no contract specification for its pre-IPO perpetuals (no statement of what one contract represents, of the index constituents, or of what happens at an IPO) — searched in its documentation, help center and app on 2026-11-15
    caveats                  synthetic, arithmetic, unconfirmed_convention, thin_market
      thin_market            Thin market: open interest ≈ $6.0k, 24 h volume ≈ $229.1k. A small order moves this price.
    tradable                 false (venue_restricted)

  edgex:MOONSHOTUSDC   [live]   edgeX
    company                  Moonshot AI
    review                   reviewed (reviewed 2026-11-15, valid until 2026-12-15T00:00:00Z)
    nature                   USDC-margined linear perpetual, cash-settled, pure synthetic: no claim on any share (venue metadata; edgeX publishes no specification for it)
    unit                     unknown — unit not published by the venue; quote USDC; collateral USDC
    metadata                 max leverage 10x, margin cross / isolated, lot 0.01, szDecimals —, asset id — (informational), OI cap —, funding multiplier —
    price (mark)             59.855183208740709264   oracle/index 60.0883100551354641   read 2026-11-16T01:06:05.055Z
    funding                  -0.00017781 per 14400 s
    open interest            118.17 contracts ≈ $7,073.09 (wallet arithmetic)
    24 h volume              $304,512.27  (5122.6 contracts)
    1 synthetic price        59.855183208740709264  [unit not published by the venue]
    2 contract value         $59.86 per contract
    3 notional exposure      $598.55 for a hypothetical long of 10
    4 implied valuation      null (unit_not_published) — unit not published by the venue: edgeX publishes no contract specification for its pre-IPO perpetuals (no statement of what one contract represents, of the index constituents, or of what happens at an IPO) — searched in its documentation, help center and app on 2026-11-15
    5 last private val.      none — no private valuation of Moonshot AI was researched (docs/v11/research/private-markets.md §4)
    premium / discount       null — no implied valuation: unit not published by the venue: edgeX publishes no contract specification for its pre-IPO perpetuals (no statement of what one contract represents, of the index constituents, or of what happens at an IPO) — searched in its documentation, help center and app on 2026-11-15
    caveats                  synthetic, arithmetic, unconfirmed_convention, company_note, thin_market
      thin_market            Thin market: open interest ≈ $7.1k, 24 h volume ≈ $304.5k. A small order moves this price.
    tradable                 false (venue_restricted)

== companies (each venue separately; nothing is averaged)
    Anthropic, PBC           edgex:ANTHROPICUSDC, hyperliquid:io:ANTH, hyperliquid:para:ANTH, hyperliquid:xyz:ANT
      last private val.      $965,000,000,000 (primary_round, 2026-05-28)
      divergence             usd_per_share: hyperliquid:para:ANTH 101.41 | hyperliquid:xyz:ANT 101.72 → spread 30.57 bps
    OpenAI                   hyperliquid:io:OAI
      last private val.      $1,250,000,000,000 (primary_round, 2026-11-06)
    Oura Inc.                hyperliquid:xyz:OURA
      last private val.      $11,000,000,000 (primary_round, 2025-10)
    Polymarket               edgex:POLYMARKETUSDC
      last private val.      $21,000,000,000 (primary_round, 2026-08-31)
    Moonshot AI              edgex:MOONSHOTUSDC
      last private val.      none researched

== excluded (public companies)
    hyperliquid:xyz:SPCX     SpaceX — live category 'stocks' — SpaceX is a listed company (Nasdaq: SPCX): the deployer annotates this market as a listed stock and categorises it `stocks`. Not a private market.
    hyperliquid:xyz:CBRS     Cerebras — live category 'stocks' — The deployer converted this market from pre-IPO to a standard equity perpetual on the listed security (category `stocks`, read live 2026-11-16; research dossier §0.3). Not a private market.
    hyperliquid:xyz:QNT      Quantinuum — live category 'stocks' — The deployer converted this market from pre-IPO to a standard equity perpetual on the listed security (category `stocks`, read live 2026-11-16; research dossier §0.3). Not a private market.
    hyperliquid:xyz:JIO      Jio Platforms — live category 'stocks' — The deployer converted this market from pre-IPO to a standard equity perpetual on the listed security (category `stocks`, read live 2026-11-16; research dossier §0.3). Not a private market.
    hyperliquid:xyz:SKHY     SK hynix — live category 'stocks' — References SK hynix ADS, a listed security: standard equity perpetual (category `stocks`, read live 2026-11-16; research dossier §0.3). Not a private market.

== delisted filter: 2 instrument(s)

  hyperliquid:vntl:ANTHROPIC   [delisted]   Hyperliquid · Ventuals (dex vntl) — shut down
    company                  Anthropic, PBC
    review                   reviewed (reviewed 2026-11-15, valid until —)
    nature                   cash-settled perpetual, pure synthetic — DELISTED: Ventuals shut down on 15 Jun 2026 and its markets were settled
    unit                     valuation_usd_billions — USD billions of company valuation (historical); quote USD; collateral USDH
    metadata                 max leverage 3x, margin strict_isolated, lot 0.001, szDecimals 3, asset id 130002 (informational), OI cap $10,000,000, funding multiplier 0
    price (mark)             1619.3  FROZEN   oracle/index 1618.9   read 2026-11-16T01:06:05.256Z
    funding                  0 per 3600 s
    open interest            0 contracts ≈ $0 (wallet arithmetic)
    24 h volume              $0  (0 contracts)
    1 synthetic price        1619.3  [USD billions of company valuation (historical)]
    2 contract value         null — delisted market: the frozen price is not the value of a contract that can be held
    3 notional exposure      null — delisted market: the frozen price is not the value of a contract that can be held
    4 implied valuation      null (delisted_frozen) — delisted market: the price is frozen at its last value of June 2026 and is not a current price — no valuation is derived from it
    5 last private val.      $965,000,000,000  primary_round, 2026-05-28, confidence high  [https://www.anthropic.com/news/series-h]
    premium / discount       null — delisted market: the price is frozen at its last value of June 2026 and is not a current price — no valuation is derived from it
    caveats                  synthetic, arithmetic, frozen
    tradable                 false (builder_dex_read_only)

  hyperliquid:vntl:OPENAI   [delisted]   Hyperliquid · Ventuals (dex vntl) — shut down
    company                  OpenAI
    review                   reviewed (reviewed 2026-11-15, valid until —)
    nature                   cash-settled perpetual, pure synthetic — DELISTED: Ventuals shut down on 15 Jun 2026 and its markets were settled
    unit                     valuation_usd_billions — USD billions of company valuation (historical); quote USD; collateral USDH
    metadata                 max leverage 3x, margin strict_isolated, lot 0.001, szDecimals 3, asset id 130001 (informational), OI cap $5,000,000, funding multiplier 0
    price (mark)             1336.2  FROZEN   oracle/index 1341.8   read 2026-11-16T01:06:05.256Z
    funding                  0 per 3600 s
    open interest            0 contracts ≈ $0 (wallet arithmetic)
    24 h volume              $0  (0 contracts)
    1 synthetic price        1336.2  [USD billions of company valuation (historical)]
    2 contract value         null — delisted market: the frozen price is not the value of a contract that can be held
    3 notional exposure      null — delisted market: the frozen price is not the value of a contract that can be held
    4 implied valuation      null (delisted_frozen) — delisted market: the price is frozen at its last value of June 2026 and is not a current price — no valuation is derived from it
    5 last private val.      $1,250,000,000,000  primary_round, 2026-11-06, confidence medium  [https://www.bloomberg.com/news/articles/2026-11-06/openai-completes-11-billion-portion-of-funding-at-1-25-trillion-value]
    premium / discount       null — delisted market: the price is frozen at its last value of June 2026 and is not a current price — no valuation is derived from it
    caveats                  synthetic, arithmetic, frozen
    tradable                 false (builder_dex_read_only)
    excluded hyperliquid:vntl:SPACEX SpaceX is a listed company today (Nasdaq: SPCX); this Ventuals market is delisted and its last candle dates from June 2026. Not a private market.

== detail hyperliquid:io:ANTH
    book top                 bid 1769.7 × 0.634 / ask 1770 × 0.243
    candles                  72 × 1h, last close 1769.6 at 2026-11-16T01:00:00.000Z
    references               primary_round 2026-05-28 965000000000 | ipo_range 2026-11-10 (range) | press_estimate 2026-11-10 1405000000000
    same company             edgex:ANTHROPICUSDC 1338.923121435860836647 [unknown] | hyperliquid:para:ANTH 101.41 [usd_per_share] | hyperliquid:xyz:ANT 101.72 [usd_per_share]

== detail edgex:ANTHROPICUSDC
    book top                 bid 1339.062 × 0.75 / ask 1339.89 × 0.75
    candles                  72 × 1h
    unconfirmed convention   Unconfirmed convention: press coverage of the centralised-exchange pre-IPO perpetuals that edgeX's index tracks says they assume about one billion shares, so that price × 1e9 would approximate a valuation. edgeX itself states nothing; the wallet does not apply it.

JSON answers written to apps/web/test/fixtures/private-markets

== outgoing requests (all public reads)
    GET edgex-prod-v2.edgex.exchange/api/v2/public/contract-labels 1
    GET edgex-prod-v2.edgex.exchange/api/v2/public/meta/getMetaData 1
    GET edgex-prod-v2.edgex.exchange/api/v2/public/quote/getDepth 1
    GET edgex-prod-v2.edgex.exchange/api/v2/public/quote/getKline 1
    POST api.hyperliquid.xyz/info allPerpMetas 1
    POST api.hyperliquid.xyz/info candleSnapshot 3
    POST api.hyperliquid.xyz/info l2Book 3
    POST api.hyperliquid.xyz/info metaAndAssetCtxs 4
    POST api.hyperliquid.xyz/info perpAnnotation 7
    POST api.hyperliquid.xyz/info perpCategories 1
    POST api.hyperliquid.xyz/info perpDexs 1

venues without adapter (documented only): Aster, Lighter, Polymarket Perps
```
