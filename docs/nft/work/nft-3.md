# NFT delivery 3 — work note (branch `nft-3`, from `nft` @ `f60d1cb`, 2026-11-17)

Scope: `NFT-BRIEF.md` §17 delivery 3 — prices and marketplace, **READ layer only**, plus the leftovers of deliveries 1 – 2.
**No market write was built**: no order, approval or cancellation is prepared, signed or submitted anywhere; the signer,
the intents and the policy were not touched (one signer *test* was added). **No production node was contacted, nothing was
signed for or broadcast to a real network, no wallet key was used.** Two provider API keys supplied by the owner during
the work (OpenSea, Alchemy) were used for read-only calls; they are in no file of the repository (checked by value before
each commit). Delivery 4 (other chains) is not started; the brief's definition of done is not fully met (§9).

## 1. Items

| # | Item | Initial state (branch `nft`) | Change | Source used | Tests | Observed | Limitation |
|---|---|---|---|---|---|---|---|
| A1 | Market provider layer | one function `magicEdenMarket` filling one snapshot on the asset, off by default | `NftMarketProvider` beside `NftDataProvider` (`market/types.ts`); `market/service.ts` (one row per source, isolation, contradictions named, absent slots reported); `market/budget.ts` (per provider, per minute + per day, visible counters, pause on 429); cache `nft_market_cache` with a TTL per data kind and stale-on-error ≤ 24 h; model `packages/nft/src/market.ts` | — | `nft-market.test.ts` (33), `nft-market-api.test.ts` (9) | — | the legacy single snapshot `asset.market` is no longer filled by default (kept in the model) |
| A2 | OpenSea API v2 | reserved variable name, no adapter | `market/opensea.ts`: item, collection, stats, traits, best listing, best offer, offers, events — Solana and 7 EVM networks; absent and `needs_key` without the key | the provider's OpenAPI document; **then every endpoint verified live with the owner's key** | fixtures `market-opensea-live.json` (live-recorded, scrubbed), `market-opensea-doc.json` (a 429, documentation-derived) | §2, §3 | no "all listings of an item" endpoint, no cancellation events, no wash flag exist in this API; a Solana order's currency is named by symbol only — resolved through the collection's own pricing currencies, else `unknown` |
| A3 | Magic Eden | 3 endpoints, opt-in | `market/magiceden.ts`: + offers, activity, last sale, collection stats; stays **off by default** | each endpoint called live keyless | `market-magiceden-live.json` | terms page still 403 from the official site; activity `rawAmount` is mis-scaled; expired offers are returned | no trait frequency, no badge, no collection description from this source |
| A4 | Keyed EVM discovery | `NFT_EVM_INDEXER_URLS` (Blockscout) only; the largest functional gap | `evm-hints.ts`: `NFT_EVM_PROVIDER=alchemy` (`ALCHEMY_API_KEY`) or `opensea`; hints re-verified on-chain; per-network refusal reported as blocked by provider; spam flag passed through and hidden by default; provider history hints re-read from receipts | Alchemy's OpenAPI / OpenRPC files; **verified live with the owner's keys** | `evm-hints-live.json`; redaction tests | the owner's Alchemy key covers **Ethereum only** today (6 networks answer "not enabled for this app") | not verified with a real inventory of the wallet (its EVM address holds no NFT); Etherscan not built |
| A5 | Sale interpretation without a provider | "a transfer is never a sale" — and no sale at all on EVM | `market/seaport.ts`: Seaport `OrderFulfilled` of the transfer's own transaction, recognised contracts explicit and sourced; Solana: marketplace program NAMED from a sourced list of 6 | Seaport repositories; 5 mainnet receipts recorded keyless | `market-seaport-receipts.json` | the ERC-1155 figure equals what OpenSea reports for the same transaction | Seaport only; a payment token unknown to the registry gives no price; ≤ 12 receipts per activity read |
| B | Prices (§8) | none | five distinct fields; exact base units + currency {network, asset, decimals}; `source_decimal` conversions digit by digit; fiat `rates` from the wallet's price list with source and date; opt-in floor estimate (default off, labelled, excluded from totals); fees as the source gives them; wash flag passed through when one exists | — | model, service and route tests | — | no source of this delivery reports a wash-trade flag: it is always `unknown` |
| C | Traits / rarity (§6) | "not computed" | frequency only from a source's counts over its stated total (`/nfts/market/traits`); rank only with the provider's named method | OpenSea `traits` + `total_supply` | `traitFrequency`, route and web tests | reference item: Grader = PSA → 20,61 % de 344 673 | the completeness of the source's counts is the source's statement |
| D | API, contract, SDKs | "no read equivalents under the trading API" | owner routes `/nfts/market*`, `/nfts/valuation`; trading API: `listNfts`, `getNft`, `getNftActivity` (`wallet:read`), `getNftMarket`, `getNftMarketEvents` (`markets:read`); OpenAPI regenerated; methods and typed models in both SDKs | — | `trading-contract.test.ts` (+3), SDK unit + drift + integration tests | 46 operations | no `iter_nfts` in the Python SDK; no collection operation in the trading API |
| E | Web (§10) | a static "no market data" block; a bare collection page | lazy chunk `NftMarket.tsx`: market panel, Market screen (§10.6), collection market, trait frequency, sources, estimate; spam filter; FR / EN | — | `apps/web/test/nft.test.ts` (+9), `tests/e2e/nft-market.spec.ts` (4) | first chunk unchanged (§6) | the capability rows in the Monitor are server English sentences (as every capability row) |
| F | First market write | — | `NFT-MARKET-WRITES.md` — decision document, no code | Metaplex, Tensor, Magic Eden SDK, Seaport, OpenSea sources; live reads of the reference asset and a listed sibling | — | recommendation: Tensor `listCore` / `delistCore` | several NE items listed there |
| G | Leftovers | §7 | §7 | | | | |
| H | Docs | — | `NFT-SOURCES.md` §10, `NFT-ARCHITECTURE.md` §8, `NFT-AUDIT.md` §6, `NFT-RUNBOOK.md`, `nft.env.example`, threat-model rows 37 – 40, `V11-OVERVIEW.md`, the README's NFT note, `docs/sdk/*.md`, this note | — | — | — | — |

## 2. Providers — terms, status

| Provider | Used for | Status | Terms (read where) |
|---|---|---|---|
| OpenSea API v2 | market read; optional EVM discovery | **verified live with a key** (every endpoint used) | Developer Terms of Use, 2023-04-26 (official page): attribution + link back; no redistribution to third parties; no commercial use; deletion within 24 h on request |
| Magic Eden | market read, Solana | verified live keyless; **off by default** | API terms **not readable from the official site** (403 challenge); an unofficial archive copy exists — not relied on |
| Alchemy NFT API v3 | EVM discovery hints, history hints | **verified live with a key** — Ethereum only on this key | Terms of 2025-06-27, read in part: internal use, no resale; nothing found on caching / attribution |
| Seaport events | sale interpretation | verified on 5 mainnet receipts, keyless | public chain data |
| Etherscan v2, Tensor API, Helius, Solscan, a public `ord` | — | not integrated (`NFT-SOURCES.md` §10.5) | — |

## 3. Which key unlocks what

| Variable | Unlocks | Sends | Today |
|---|---|---|---|
| `OPENSEA_API_KEY` | market panel on Solana + Ethereum, Base, Arbitrum, Polygon, Optimism, Avalanche, HyperEVM: asking price, best offer, last sale, market events, collection floor / volume / owners / fees, the "verified by OpenSea" badge, trait frequency, rarity rank; collection logo, banner, description | contract + token id / mint of each item opened | key supplied; **to be set at deployment by the main session** |
| `NFT_MARKET_OPENSEA=off` | keeps the key, turns the market read off | — | — |
| `NFT_MARKET_MAGICEDEN=on` | Magic Eden's own listings, offers, activity, floor (Solana) | the mint | off; the owner reads the API terms page first |
| `NFT_EVM_PROVIDER=alchemy` + `ALCHEMY_API_KEY` | EVM auto-discovery (the networks enabled for the key), the indexer's spam signal, EVM activity beyond the last ~1 000 blocks for the wallet's own items | **the wallet's EVM address** | key supplied; Ethereum only until the other networks are enabled in the Alchemy dashboard; not HyperEVM |
| `NFT_EVM_PROVIDER=opensea` (+ `OPENSEA_API_KEY`) | EVM auto-discovery on 7 networks incl. HyperEVM (not BNB) | **the wallet's EVM address** | alternative to Alchemy |
| none | Solana inventory; lookup of any item; a Seaport sale price read from the transaction; marketplace links (outside SP Wallet) | — | default |

Production: PM2 environment of `sp-wallet` on the API node + the `mld` manifest. Never the signer node, never the web bundle.

## 4. The reference item `CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j` now

With **no variable** (the default, and the state of the Playwright stack): identity, ownership, metadata and activity as
in delivery 1; market panel: "OpenSea — Marché indisponible : clé manquante (`OPENSEA_API_KEY`)", "Magic Eden — Marché
indisponible : source désactivée (`NFT_MARKET_MAGICEDEN`)", no figure anywhere, "Valeur de cet objet : non disponible";
trait frequency "non calculées"; the seven market actions disabled with the reason; the two marketplace links in a
separate group with "SP Wallet n'a ni WalletConnect ni export de clé".

With the keys — real output of `scripts/smoke-nft-market.mts` (§5): not listed, no offer, **last sale 14 500 USDC on
2026-11-10** (OpenSea), collection `phygitals` **verified by OpenSea**, floor 0.36 USDC (OpenSea) and 0.004 SOL (Magic
Eden) — two statistics of two marketplaces, shown side by side —, no rarity rank, Grader = PSA on 20.61 % of 344 673
items. Magic Eden reports no activity for the item. Still not established: whether the holder is a custodian; the nature
of the 2026-09-16 transaction; any valuation.

## 5. Smoke — real output

`npx tsx scripts/smoke-nft-market.mts` with no variable:

```
== market sources for sol:solana:CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j — 2026-11-17T12:26:18.467Z
-- OpenSea: NEEDS KEY — unlocked by OPENSEA_API_KEY
  would give                 asking price, best offer, last sale, market events, collection floor / volume / owners, the marketplace's verification badge, trait counts and rarity rank — Solana and 7 EVM networks
  market fields              unavailable (the source is not asked; nothing is shown in its place)
-- Magic Eden: OFF — unlocked by NFT_MARKET_MAGICEDEN
  would give                 Magic Eden's own listings, offers, activity and collection floor — Solana (keyless; read its API terms first)
  market fields              unavailable (the source is not asked; nothing is shown in its place)
  value of this item         unavailable — no source gives one, and none is derived from a floor or a single quote
  market actions             none: buy, sell, list, offer, accept and cancel are not built (docs/nft/NFT-MARKET-WRITES.md)

== EVM discovery provider (NFT_EVM_PROVIDER) — absent: NFT_EVM_PROVIDER is not set
```

With `OPENSEA_API_KEY`, `NFT_MARKET_MAGICEDEN=on`, `NFT_EVM_PROVIDER=alchemy`, `ALCHEMY_API_KEY` and `--evm-address
0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` (a public address, read-only subject; the output was checked for the key
values before being kept):

```
== market sources for sol:solana:CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j — 2026-11-17T12:26:19.058Z
-- OpenSea: ON — adapter verified live; sends contract_and_token_id; budget 30/min, 5000/day
  page (outside SP Wallet)   https://opensea.io/assets/solana/CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j/CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j
  listed                     no
  asking price               none (the source says there is none)
  best offer                 none (the source says there is none)
  last sale                  14500 USDC [solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v, 14500000000 base units] · 2026-11-10T16:38:56.000Z · H7NdPnwqwQkv2XdJaAWAEb3yH9Eg6YTkkwfX5Cz5Wyek → 8d56BJgENF7v9A6YJnMinXqrQb7KKLxMhe3WmUf1Pa4N · tx 2BPek83JWw4EkJFnut4bMfLEh9f3GxdoCWaYQ8eezrvvKD3FLnVoVwfgx5QLb4KhVAX4i6ucyidnugD8HXx […]
  collection (marketplace)   phygitals — Phygitals
  verification               verified — statement of OpenSea (its value: verified)
  rarity                     none (the source says there is none)
  flags                      suspicious: false · disabled: false
  market events (page 1)     18: 17 transfer, 1 sale — more pages
    sale                     2026-11-10T16:38:56.000Z · 14500 USDC [solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v, 14500000000 base units] · H7NdPnwqwQkv2XdJaAWAEb3yH9Eg6YTkkwfX5Cz5Wyek → 8d56BJgENF7v9A6YJnMinXqrQb7KKLxMhe3WmUf1Pa4N · wash trade: unknown (the source has no wash-trade flag)
  collection floor           0.36 USDC [solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v, 360000 base units, from the source's decimal]  — a statistic of the collection, NOT the value of this item
  volume all                 1410.316647 ETH (as reported: unit named by symbol only) · 89246 sales
  volume 1d                  3.723956 ETH (as reported: unit named by symbol only) · 68 sales
  volume 7d                  23.734389 ETH (as reported: unit named by symbol only) · 865 sales
  volume 30d                 120.974368 ETH (as reported: unit named by symbol only) · 4500 sales
  items / owners / listed    344673 / 31789 / unknown (not reported by this source)
  fees (as the source gives) 1 % → 0x0000a26b00c1f0df003000390027140000faa719 (required)
  trait frequency            Grader=PSA: 20.61 % of 344673 items (71052) · Language=Japanese: 9.98 % of 344673 items (34408) · Name=Pikachu: 0.87 % of 344673 items (3014)
  requests used              8/30 this minute, 8/5000 today; refused locally 0; upstream 429: 0
-- Magic Eden: ON — adapter verified live; sends mint_only; budget 40/min, 5000/day
  page (outside SP Wallet)   https://magiceden.io/item-details/CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j
  listed                     no
  asking price               none (the source says there is none)
  best offer                 none (the source says there is none)
  last sale                  none (the source says there is none)
  collection (marketplace)   phygitals___ — Phygitals
  verification               not reported
  rarity                     unknown (not reported by this source)
  flags                      suspicious: unknown · disabled: unknown
  market events (page 1)     0: none
  collection floor           0.004 SOL [solana:native, 4000000 base units]  — a statistic of the collection, NOT the value of this item
  volume 7d                  1.422237 SOL [solana:native, 1422237000 base units]
  items / owners / listed    unknown (not reported by this source) / unknown (not reported by this source) / 437
  fees (as the source gives) not reported
  trait frequency            not computed (unknown (no_stated_item_total))
  requests used              6/40 this minute, 6/5000 today; refused locally 0; upstream 429: 0
  value of this item         unavailable — no source gives one, and none is derived from a floor or a single quote
  market actions             none: buy, sell, list, offer, accept and cancel are not built (docs/nft/NFT-MARKET-WRITES.md)

== EVM discovery provider (NFT_EVM_PROVIDER) — Alchemy
  ethereum                   200 hint(s) (more exist) from eth-mainnet.g.alchemy.com; flagged as spam by Alchemy: 195 — hints only: each would be re-verified on-chain before it is shown as held
  base                       BLOCKED BY PROVIDER — network not enabled for this key (provider_not_configured (network_not_enabled:base_mainnet)); enable it in the provider's dashboard
  arbitrum                   BLOCKED BY PROVIDER — network not enabled for this key (provider_not_configured (network_not_enabled:arb_mainnet)); enable it in the provider's dashboard
  polygon                    BLOCKED BY PROVIDER — network not enabled for this key (provider_not_configured (network_not_enabled:matic_mainnet)); enable it in the provider's dashboard
  optimism                   BLOCKED BY PROVIDER — network not enabled for this key (provider_not_configured (network_not_enabled:opt_mainnet)); enable it in the provider's dashboard
  bsc                        BLOCKED BY PROVIDER — network not enabled for this key (provider_not_configured (network_not_enabled:bnb_mainnet)); enable it in the provider's dashboard
  avalanche                  BLOCKED BY PROVIDER — network not enabled for this key (provider_not_configured (network_not_enabled:avax_mainnet)); enable it in the provider's dashboard
  hyperevm                   not covered by Alchemy (chain_not_covered)
```

## 6. Commands and results

| Command | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `node scripts/gen-openapi.mts --check` · `node packages/trading-sdk/scripts/gen-types.mts --check` · `uv run python scripts/gen_models.py --check` · `gen_sync.py --check` | all "up to date" |
| `npx vitest run services/api/test/nft-market.test.ts services/api/test/nft-market-api.test.ts services/api/test/nft-prepare-sol.test.ts` | 3 new files: 34 + 9 + 6 = 49 tests passed |
| `npx vitest run services/api/test/trading-contract.test.ts` | 25 passed (3 new: the five NFT operations validated against the document, scopes, restrictions, the withheld rate, no write) |
| `npx vitest run apps/web/test/nft.test.ts` | 40 passed (was 32; −1 replaced, +9 market) |
| `npx vitest run services/isolated-signer/test/nft.test.ts` | 29 passed (+1: Litecoin, Dogecoin, Bitcoin Cash) |
| `pnpm test` (full, at the end, no key in the environment) | **206 files, 4 830 tests passed, 0 failed** (129 s) — branch `nft` was at 203 files / 4 763. A first full run had 1 failure (`apps/web/test/developer.test.ts` expected 41 operations): fixed, then this run |
| TypeScript SDK (`packages/trading-sdk/test/*`, inside `pnpm test`) | passed, incl. `integration.test.ts` against the real API + signer stack (the NFT reads; the reference item read live or reported as a client timeout) |
| Python SDK: `cd sdk/python && uv run pytest` | **429 passed** (unit, drift, integration on the same stack) |
| `node scripts/build.mjs` | exit 0 — `dist/signer.mjs` 2 952 127 bytes (**unchanged** from delivery 2: no signer source changed); `dist/api.mjs` 8 925 712 (was 8 818 328) |
| `(cd apps/web && node_modules/.bin/vite build)` | first chunk `index-*.js` **260.60 kB** (80.56 kB gzip) — unchanged; `Nft-*.js` 48.24 kB (was 45.52); `NftSend-*.js` 19.04 kB (was 18.80); new lazy chunk `NftMarket-*.js` 25.83 kB (6.56 kB gzip) |
| Playwright `nft.spec.ts` (default stack, port 8870) | 4 passed — before any change of this delivery too (delivery 2 had not re-run it) |
| Playwright `nft-market.spec.ts` (default stack: no provider) | 3 passed, 1 skipped (the scripted block) |
| Playwright `nft-market.spec.ts` (`--market scripted`, port 8872) | 1 passed, 3 skipped |
| Playwright `nft-send.spec.ts` (fork stack, port 8880) | 4 passed |
| `npx tsx scripts/smoke-nft-market.mts` | §5 |
| `npx tsx scripts/record-nft-prepare-fixtures.mts` | 3 cases recorded on mainnet (Core, programmable NFT, legacy); Token-2022: none found |
| lab `pytest` (`research/`) | not run: nothing under `research/` was touched |

## 7. Leftovers of deliveries 1 – 2

| Leftover | Verified still true? | Outcome |
|---|---|---|
| `tests/e2e/nft.spec.ts` not re-run after delivery 2 | yes — and it passed as it was (4 / 4) before any change | updated to the market panel and re-run: 4 / 4 |
| `tests/e2e/nft-send.spec.ts` | — | re-run after the changes of this delivery: 4 / 4 |
| `prepareSol` only exercised by the validator proof | yes | `scripts/record-nft-prepare-fixtures.mts` records a real preparation on mainnet (real NFT, its real holder as "the wallet", `simulateTransaction` with `sigVerify: false`); `nft-prepare-sol.test.ts` replays it: Metaplex Core (the reference asset) `CMhGwG…` — 7801 CU, fee 5101 + rent 0 lamports, 5 accounts; programmable NFT `13Udye…` — 95801 CU, fee 5673 + rent 1097400 lamports, 13 accounts; legacy Token Metadata `mpv2J6…` — 52271 CU, fee 5390 + rent 1488440 lamports, 9 accounts. **Not recorded: Token-2022** (no mainnet NFT of that kind, held unlocked by an ordinary wallet in its associated token account, was found when recording — the validator proof remains its only execution). Core: 7 801 compute units and fee 5 101 lamports — the validator proof's figures |
| simulation "changes" are English strings | yes | `code` (+ `params`, `beforeCode`, `afterCode`) added beside the sentence; FR / EN texts `nfTChg_*`; a review stored by delivery 2 still shows its sentence |
| the UTXO lock list does not cover Bitcoin Cash; Litecoin / Dogecoin covered "as the report says" | Litecoin and Dogecoin: **true, now tested at the signer** (a lock on each refuses the send). Bitcoin Cash: true, not covered | **not extended**, and why: (1) it is a signer change (the BCH coins travel in the plugin section, not in `btc.inputs`) and the lock intent refuses the family — owner decision + review; (2) the risk the list addresses does not exist there in that form: Bitcoin Cash NFTs are CashTokens, carried in a token prefix of the output, and the CashTokens specification includes that prefix in the signing serialization of every spend of such an output — this wallet's BCH signature does not, so a send that selected a token-bearing output would be **rejected by the network, not burn the token** (inferred from the specification and the code; never observed on a real token output); (3) the two BCH indexers' answers are not read for token data, so such an output is not recognised either. The wallet's BCH address is of the non-token-aware type: a compliant sender refuses to send tokens to it. Recommendation unchanged: do not receive CashTokens here |
| the ord adapter never ran against a real `ord` | yes | **still so**: `ordinals.com` answered a Cloudflare challenge (403) to every JSON request, the signet / testnet hosts do not resolve, no terms or robots policy found. Nothing was bypassed |
| the collection page has no banner / floor / volume | yes | filled from the market sources when one is on (banner and logo through the media proxy; verification with its source); "unavailable" with the reason otherwise |
| EVM activity limited to ~1 000 blocks | yes | with `NFT_EVM_PROVIDER=alchemy`: the provider names the transactions, each re-read from the chain (items of the wallet only); otherwise the bound is stated on the screen (as before) |
| no read equivalents under the trading API | yes | done (item D) |
| EVM discovery blocked without an indexer | yes | keyed providers (item A4) |

Not closed (unchanged): compressed NFTs not verified against their tree and not transferable; SPL history partial; `from`
of a Core transfer unknown from the chain (OpenSea's events give both parties — as a market statement); EVM approvals
not read; ERC-2981 not read; Token-2022 group pointers not decoded; `http:` URIs refused; no Ordinals listing.

## 8. Files touched outside the NFT modules

`services/api/src/server.ts` (one line: the price list handed to the NFT module) · `services/api/src/db.ts` (one additive
block: `nft_market_cache`, `nft_market_slug`) · `services/api/src/trading-api/{spec.ts, routes.ts, index.ts, openapi.ts}`
(five operations, their schemas and errors, the `Nfts` tag) + new `trading-api/nft-read.ts` · generated:
`docs/openapi/trading-v1.json`, `docs/TRADING-API-OPENAPI.md`, `packages/trading-sdk/src/generated/openapi.ts`,
`sdk/python/src/sp_wallet/{models.py, _client.py}` · `packages/trading-sdk/src/client.ts`,
`sdk/python/src/sp_wallet/_async_client.py`, `sdk/python/scripts/gen_models.py` · tests: `trading-contract.test.ts`,
`packages/trading-sdk/test/{client,generated,integration}.test.ts`, `sdk/python/tests/{test_client,test_models_drift,test_integration}.py`,
`services/isolated-signer/test/nft.test.ts` (one test; **no signer source file changed**) · `apps/web/src/i18n.ts` (inside
the `nf` block) · docs: `README.md` (the NFT note only), `docs/V11-OVERVIEW.md`, `docs/threat-model/threat-model.md`,
`docs/sdk/{typescript,python}.md`.
Not touched: `services/isolated-signer/src/**`, `packages/core/**`, `services/api/src/{orders,risk,mandates,agents,mm,quotes}/**`,
`research/`.

A finding outside the scope: `docs/V11-MARKET-DATA-SOURCES.md` §2.6-9 says the trading API must not serve API Bricks
prices to a third party's key. **No such rule was found in the trading API**: `GET /portfolio` answers `priceSource:
'apibricks'` values to a key when the second source is the fallback. The NFT operations apply the rule themselves (a rate
from that source is `withheld` for a key — tested); `getPortfolio` was left as it is and is reported here.

## 9. Limitations, and what is not done

- **No market write.** Every market action is a disabled control. The first real listing would be the first.
- OpenSea: verified live on one Solana Core collection, one ERC-721 and one ERC-1155 collection — not on Base, Arbitrum,
  Polygon, Optimism, Avalanche or HyperEVM items (same code path, not observed). Its key's real quota is whatever the
  header says that day (120); the wallet's own budget is below it.
- Alchemy: live on Ethereum only (the key's other networks are not enabled); the inventory path with a real wallet
  inventory is tested on recorded answers, not live (the wallet's EVM address holds nothing).
- The market answers are a marketplace's statements: a false figure from one source is displayed as that source's.
- Trait counts: the source's; nothing verifies they are complete.
- The Seaport interpretation reads at most 12 receipts per activity request and knows Seaport only.
- The Python SDK has no `iter_nfts`. The trading API has no collection-market operation.
- The Solana preparation tests cover Metaplex Core (the reference asset), programmable NFT, legacy Token Metadata; a standard without a recorded case is covered by the validator proof only.
- The capability sentences shown in the Monitor are English (as all capability rows).
- No independent review of delivery 2's signer code has happened; delivery 3 adds none to review.

## 10. What comes next

**The market-write decision** — `NFT-MARKET-WRITES.md` §5: (1) whether a first write is wanted, and whether it is Tensor
`listCore` / `delistCore`; (2) accepting an upgradeable, source-unverified program as custodian of a listed asset; (3) the
collection's permanent delegates; (4) the policy values — above all the price floor per currency; (5) who reviews the
signer change; (6) delist under halt; (7) that the first listing is a visibility test; (8) whether `os_tensor` must be
investigated first; (9) the asset and price of the first real listing.

**Delivery 4 (other chains)** needs, per chain: discovery, ownership on two endpoints, metadata, the transfer builder and
verifier in the signer, then — only then — a row in the matrix. The market layer is ready for it: a provider declares its
chains (OpenSea covers none of the 13 other families), `MarketRef` carries chain identifiers only, and the collection slug
mechanism is per provider. Bitcoin Ordinals still need a real `ord` server to verify the adapter against.
