# NFT delivery 1 — work note (branch `nft-1`, from `v11` @ `e325d1b`, 2026-11-17)

Scope: `NFT-BRIEF.md` §17 delivery 1 — audit, read-only inventory, collection and item pages, secure metadata / media,
activity where sources allow. **Read-only: nothing signs, prepares or broadcasts; no key, no signer file, no intent or policy
file was touched; no production node was contacted.** Deliveries 2 (transfers), 3 (market) and 4 (other chains) are **not**
started; the definition of done of the brief (which includes signed transfers) is **not** met by this delivery alone.

## 1. Items

| # | Item | Initial state | Change | Source / API used | Tests | Observed | Limitation |
|---|---|---|---|---|---|---|---|
| 1 | Audit and matrix | no NFT code, table, route or text anywhere | `NFT-AUDIT.md`: findings, the 23-network matrix, the BTC inscription limitation | repository; live calls of §Sources | — | 1 network readable keyless (Solana), 8 lookup-only (EVM), 1 blocked (Bitcoin), 13 without adapter | the "tbc" standards of the 13 other families were not investigated |
| 2 | Sources dossier | — | `NFT-SOURCES.md`: per source host, endpoints, auth, quota, terms, date; the EVM log measurement; who receives the address | official pages (sub-agent, tagged doc / snippet / NE) + live keyless calls | fixtures are the live answers | public Solana RPC serves DAS and Core `getProgramAccounts` today; publicnode refuses both; no EVM endpoint allows wallet-wide logs over history; Hiro Ordinals is shut down; OpenSea needs a key (401) | Magic Eden's API terms page could not be read (403); OpenSea full-key limits unpublished; several items marked NE |
| 3 | Canonical model v1 | — | `packages/nft/src/model.ts` (+ `uri`, `netguard`, `sniff`, `metadata`, `solana`) | — | `packages/nft/test/nft-model.test.ts` (30) | keys deterministic, uint256 exact, four absence states, reasons per asset | `escrow` reason / state reserved, never produced yet |
| 4 | Solana provider | — | `services/api/src/nft/solana.ts`: token / Core / compressed sections, lookup, events, collection | wallet's Solana RPC endpoints; DAS on the endpoint that serves it | `nft-providers.test.ts` on recorded answers (reference Core asset, legacy in escrow, pNFT locked + delegated + rule set, Token-2022, compressed, burned, a 63-NFT public inventory, negatives, endpoint disagreement, refused sections) | 16 RPC calls for a 63-NFT inventory; ownership `chain_verified` when both endpoints agree | holder of a non-ATA token account falls back to the indexer's owner (labelled indexed); SPL history partial; cNFT not verified against its tree; Token-2022 group pointers not decoded; `from` of a Core transfer not established |
| 5 | EVM provider | — | `evm.ts`: ERC-165 with caution, ERC-721 / ERC-1155 reads on both endpoints, indexer hint, manual section, recent-window logs | wallet's EVM RPC endpoints; optional Blockscout-compatible instance | `nft-providers.test.ts` (BAYC #1, ENS without metadata, CryptoKitties pre-standard, CryptoPunks and USDT refused, ERC-1155 qty 1 / 3 / 0, a real `TransferSingle`, indexer as hint, indexer outage, disagreement) | all cases as on-chain | discovery blocked without an indexer; activity = last ~1 000 blocks; approvals not read; ERC-2981 not read; Blockscout adapter coded against the live answer of `eth.blockscout.com` only (other instances answered a bot challenge that day) |
| 6 | Resolver + media proxy | — | `resolver.ts`, `safe-fetch.ts` | creators' hosts through the pinned fetcher; IPFS / Arweave gateways | `nft-security.test.ts` (14: SSRF list, rebinding, redirects, size, time, headers), `nft-api.test.ts` (hostile metadata, sniffing, sandbox headers, budget) | reference metadata (1 023 bytes) and image (PNG 714 270 bytes, 1 redirect) fetched live through it | `http:` URIs refused (old collections using them show "blocked"); no range requests (≤ 25 MiB files only); 3D models not shown |
| 7 | Market read | — | `market.ts`: Magic Eden snapshot, **off by default**; marketplace links always | api-mainnet.magiceden.dev (keyless) | `nft-providers.test.ts` on recorded answers (unlisted reference item; a listed item: exact lamports, seller ≠ on-chain holder) | — | Solana only; no offers / last sale; terms partly unread → opt-in; OpenSea not integrated |
| 8 | Persistence | — | one block in `db.ts` (9 tables), `store.ts`, retention | PostgreSQL | `nft-api.test.ts` (idempotent migrate, an NFT that left, truncated section proves nothing, source failure keeps inventory, retention, cache cap) | — | no down-migration (repo convention): the tables are caches, `nft_manual` excepted |
| 9 | API | — | `routes.ts`, `service.ts`, `index.ts`; one line in `server.ts`, capability rows | — | `nft-api.test.ts` (35: auth, CSRF, validation, matrix, lookup of the reference item, proxy, activity, refresh cooldown, manual tracking, receive, error redaction) | — | no read equivalents under the trading API (not trivial: spec + OpenAPI + SDK) |
| 10 | Web | — | `apps/web/src/nft.ts`, `screens/Nft.tsx` (gallery grid / list, filters, search, sort, per-chain states, lookup, receive, collection, item page), 3 lazy routes, a row in Assets, `nf` texts FR / EN | the API above | `apps/web/test/nft.test.ts` (27), `tests/e2e/nft.spec.ts` (4, real browser) | first chunk 260.57 kB (v11 note: 260.61 kB); `Nft` chunk 43.75 kB | no dedicated Send screen (a disabled control with reasons); no price sort; the collection page has no banner / floor / volume (unavailable) |
| 11 | Docs | — | `NFT-AUDIT`, `NFT-SOURCES`, `NFT-ARCHITECTURE`, `NFT-ADDING-A-PROVIDER`, `NFT-RUNBOOK`, `nft.env.example`, threat-model rows 26–31, README section | — | — | — | — |

## 2. The reference item — what it turned out to be

`CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j` is a **Metaplex Core asset** (not an SPL mint, not compressed), in the Core
collection `phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC` ("Phygitals"), owned on-chain by
`62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS` — not by this wallet. Real output of `npx tsx scripts/smoke-nft.mts`
(2026-11-17 09:20 UTC; the dev-stack wallet is the throwaway one of the e2e stack):

```
== asset solana CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j — 2026-11-17T09:20:40.664Z
  canonical key              sol:solana:CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j
  standard                   metaplex-core
  program                    CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d
  on-chain name              2016 Pokemon XY Special Box Prom
  on-chain symbol            none
  metadata URI               https://metadata.phygitals.com/CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j
  holder                     "62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS"
  token account              unsupported
  frozen                     false
  delegate                   none
  pNFT record state          unsupported
  supply                     "1"
  update authority           "6gn64NNTDS4sNDfAq6Qk6cdgPeCWjupPbUVLfNSHeY4S"
  metadata mutable           true
  creators                   unsupported
  royalty (bps)              none
  rule set                   unsupported
  collection                 phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC — verified on-chain: true — on-chain name: Phygitals
  extensions / plugins       core-collection:PermanentFreezeDelegate, core-collection:PermanentTransferDelegate, core-collection:PermanentBurnDelegate
  source [onchain]           solana-rpc · api.mainnet-beta.solana.com, solana-rpc.publicnode.com · chain_verified · slot 470481344
  transfer in this version   no — not_in_wallet, transfer_not_built
  --- creator metadata (declared by the creator, from metadata.phygitals.com) ---
  name                       2016 Pokemon XY Special Box Prom
  description                2016 Pokemon XY Special Box Promo Japanese Rayquaza Poncho Weari
  external link              none
  image                      https://gateway.irys.xyz/29YSZT2VooL3a8413PAq25rF48j1pa1Rbk9LfYvDA6YF
  animation                  none
  trait Grade                PSA 10.0
  trait Grader               PSA
  trait Cert Number          65475295
  trait Title                2016 Pokemon XY Special Box Promo Japanese Rayquaza Poncho Wearing Pikachu #230XYP PSA 10
  trait Language             Japanese
  trait Category             Pokemon
  trait Type                 Pokemon
  trait Name                 Pikachu
  trait Energy Type          Lightning
  rarity / frequency         not computed (no complete collection index: unknown denominator)
  image file                 image/png (sniffed), 714270 bytes, from cef6elc7kbbqgzz5xigd7wa52yusgh5gjta2dvpayllabthmdlia.mainnet-1.datasprite-cdn.com, 1 redirect(s)
  market                     no market source enabled (NFT_MARKET_MAGICEDEN) — price, offers, sales: unavailable
  value                      unavailable
  outside SP Wallet          Magic Eden: https://magiceden.io/item-details/CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j
  outside SP Wallet          OpenSea: https://opensea.io/item/solana/CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j
  --- activity (full) ---
  2026-11-10T16:40:35.000Z   transfer     ? → 62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS  ×1  3jtZVMPVXKWjQzXAu9Q6…  (no price: a transfer is not a sale)
  2026-11-10T16:38:56.000Z   transfer     ? → 8d56BJgENF7v9A6YJnMinXqrQb7KKLxMhe3WmUf1Pa4N  ×1  2BPek83JWw4EkJFnut4b…  (no price: a transfer is not a sale)
  2026-11-10T14:04:18.000Z   transfer     ? → 3DkgdTGnCWwbUi2GFkZmnXEnWri515xCLrW8YdHhLPpu  ×1  47qmU9ujGYmf5A6gf7bU…  (no price: a transfer is not a sale)
  2026-10-06T23:11:17.000Z   transfer     ? → H7NdPnwqwQkv2XdJaAWAEb3yH9Eg6YTkkwfX5Cz5Wyek  ×1  5Bpzzf5rR8Z2Lz4hdQmj…  (no price: a transfer is not a sale)
  2026-09-30T11:22:38.000Z   transfer     ? → 3DkgdTGnCWwbUi2GFkZmnXEnWri515xCLrW8YdHhLPpu  ×1  5v2QnhLodSfQwPf74Gmg…  (no price: a transfer is not a sale)
  2026-09-16T19:51:46.000Z   unknown      ? → ?  ×0  2g1jDfib8B1dQSJu22v5…  (no price: a transfer is not a sale)
  2026-05-02T23:26:57.000Z   transfer     ? → H7NdPnwqwQkv2XdJaAWAEb3yH9Eg6YTkkwfX5Cz5Wyek  ×1  2Ry7j9rR5GiRygCcYtwf…  (no price: a transfer is not a sale)
  2026-05-02T22:38:31.000Z   transfer     ? → 62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS  ×1  47L89DipDBgdEoBp41WM…  (no price: a transfer is not a sale)

== inventory of the local dev stack's wallet (database spw_dev_nft_e2e_8870)
  solana     8t7y2SJJuG9fNG64Lx91HjkKpFnpYL6hhktgHyuizXMk: 0 NFT(s) — token=ok(0)  core=ok(0)  compressed=ok(0)
  ethereum   0x11318fC805dBa1bE7097aB39B0Ec446a8c559807: 0 NFT(s) — indexer=blocked_by_provider[no_indexer_configured; unlocked by NFT_EVM_INDEXER_URLS]  manual=ok(0)
  base       0x11318fC805dBa1bE7097aB39B0Ec446a8c559807: 0 NFT(s) — indexer=blocked_by_provider[no_indexer_configured; unlocked by NFT_EVM_INDEXER_URLS]  manual=ok(0)
  arbitrum   0x11318fC805dBa1bE7097aB39B0Ec446a8c559807: 0 NFT(s) — indexer=blocked_by_provider[no_indexer_configured; unlocked by NFT_EVM_INDEXER_URLS]  manual=ok(0)
  polygon    0x11318fC805dBa1bE7097aB39B0Ec446a8c559807: 0 NFT(s) — indexer=blocked_by_provider[no_indexer_configured; unlocked by NFT_EVM_INDEXER_URLS]  manual=ok(0)
  optimism   0x11318fC805dBa1bE7097aB39B0Ec446a8c559807: 0 NFT(s) — indexer=blocked_by_provider[no_indexer_configured; unlocked by NFT_EVM_INDEXER_URLS]  manual=ok(0)
  bsc        0x11318fC805dBa1bE7097aB39B0Ec446a8c559807: 0 NFT(s) — indexer=blocked_by_provider[no_indexer_configured; unlocked by NFT_EVM_INDEXER_URLS]  manual=ok(0)
  avalanche  0x11318fC805dBa1bE7097aB39B0Ec446a8c559807: 0 NFT(s) — indexer=blocked_by_provider[no_indexer_configured; unlocked by NFT_EVM_INDEXER_URLS]  manual=ok(0)
  hyperevm   0x11318fC805dBa1bE7097aB39B0Ec446a8c559807: 0 NFT(s) — indexer=blocked_by_provider[no_indexer_configured; unlocked by NFT_EVM_INDEXER_URLS]  manual=ok(0)
  bitcoin    not read: Ordinals need an ord-aware indexer (none in this version); ordinary BTC sends are not inscription-aware
  other networks (litecoin, dogecoin, bitcoincash, stellar, xrpl, tron, aptos, cosmos, sui, near, ton, cardano, polkadot): no NFT adapter — not read
```

Not established for this item, and shown as such: any price, offer, sale, rarity, rank, the previous owner of each transfer
(Core's `TransferV1` names the authority and the new owner only), the nature of the 2026-09-16 transaction, and whether the
holder `62Q9…` is a custodian. The collection's permanent transfer and burn delegates are a fact of the chain: the
collection's authority can move or burn this asset.

## 3. Blocked by which key / setting

| Blocked | Unlocked by | Cost of unlocking |
|---|---|---|
| Solana compressed NFTs and Core discovery, **if** the public endpoint stops serving DAS / `getProgramAccounts` (it does today) | `NFT_SOLANA_DAS_URL` (a DAS provider's URL with its key) · `SPW_RPC_EXTRA` (an endpoint serving `getProgramAccounts`) | the provider learns the wallet's Solana address |
| EVM automatic discovery (8 networks) | `NFT_EVM_INDEXER_URLS` (Blockscout-compatible; only `eth.blockscout.com` was seen answering reliably that day) — or, not built: `NFT_EVM_PROVIDER_API_KEY` (Alchemy NFT API v3), `OPENSEA_API_KEY` | the indexer learns the wallet's EVM address |
| EVM history beyond ~1 000 blocks | an archive / indexed source — not built | — |
| Market data | `NFT_MARKET_MAGICEDEN=on` (Solana, keyless; read its API terms first) · `OPENSEA_API_KEY` — not built | the marketplace learns which mints are looked at |
| Bitcoin Ordinals | `NFT_ORDINALS_API_URL` → a self-hosted `ord` server — **adapter not built** | running `bitcoind` + `ord --index-sats` |
| The 13 other families | an adapter each (delivery 4) | — |

## 4. Commands and results

| Command | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `npx vitest run packages/nft services/api/test/nft-*.test.ts apps/web/test/nft.test.ts` | 5 files, 136 tests passed (model 30, providers 30, security 14, API 35, web 27) |
| `node scripts/build.mjs && (cd apps/web && node_modules/.bin/vite build)` | exit 0 — first chunk `index-*.js` 260.57 kB (80.55 kB gzip); `Nft-*.js` 43.75 kB (11.91 kB gzip) |
| `npx tsx tests/e2e/nft-server.mts --port 8870` + `pnpm e2e nft.spec.ts` | 4 passed (gallery states + receive; reference mint looked up live with real fields; hostile metadata in a real browser; desktop EN dark) |
| `npx tsx scripts/smoke-nft.mts --db spw_dev_nft_e2e_8870` | output above |
| `npx tsx scripts/nft-measure-evm-logs.mts` | table of `NFT-SOURCES.md` §4.1 |
| `pnpm test` (once, at the end) | 199 files, 4 630 tests passed, exit 0 (211 s) — before the last edit (a Bitcoin notice on the ordinary Receive screen), after which only `apps/web/test/nft.test.ts`, the typecheck and the web build were re-run |

## 5. Files touched outside the new modules

`services/api/src/server.ts` (import, option type, one registration line) · `services/api/src/db.ts` (one additive block) ·
`services/api/src/capabilities.ts` (import + one spread) · `services/api/package.json`, `package.json` (typecheck script),
`pnpm-lock.yaml` (the new workspace package) · `services/api/test/hardening-e.test.ts` (the expected capability list gains
the two NFT rows) · `apps/web/src/App.tsx` (lazy screens, 3 routes, area) · `apps/web/src/screens/Assets.tsx` (one row) · `apps/web/src/screens/Receive.tsx` (the inscription warning on the Bitcoin address) ·
`apps/web/src/i18n.ts` (one `nf` block) · `README.md`, `docs/threat-model/threat-model.md`.
Not touched: `services/isolated-signer/**`, `packages/core/**`, `services/api/src/{orders,risk,mandates,agents,mm,quotes,trading-api}/**`.

## 6. What delivery 2 (transfers) needs from this model

1. **Per-standard evaluation of `transferBlockedBy`**: remove `transfer_not_built` standard by standard as a builder exists
   (ERC-721 `safeTransferFrom`, ERC-1155 `safeTransferFrom` with quantity, Token Metadata `Transfer` for legacy and pNFT with
   its token record + rule set, Core `TransferV1`, Token-2022 with transfer-hook / non-transferable checks); keep the
   factual reasons as hard blocks or as routes to the right builder.
2. **Authoritative re-read before the intent** with `rpcQuorum` (not the display reads): owner / token account / amount /
   frozen / delegate / token record / program; refuse on any disagreement. For compressed NFTs: `getAssetProof` checked
   against the on-chain tree root — or no transfer.
3. **Intent + signer**: new versioned intent types in `packages/core/src/intent.ts`, a signer validator that rebuilds the
   transaction from {chain, family, wallet address, contract / program, mint / token id, quantity, destination, expiry,
   nonce}; policy limits for NFTs (count per day, allow-listed programs); no operator approval in a send.
4. **Review screen from on-chain identifiers** (key, contract / mint, token id, quantity, program) — the creator's name and
   image are decoration, shown as such.
5. **Bitcoin**: an `ord` source, inscription-carrying UTXOs excluded from ordinary coin selection in the API **and refused
   by the signer**, the test "an ordinary BTC send cannot spend an inscription" (`NFT-AUDIT.md` §4).
6. **Receive / detection**: arrival detection for EVM needs an indexer or per-contract log scanning from a known block;
   today it is a manual add after confirmation.
7. Finality and reorg handling for NFT transfers like the existing proposals (`nft_events.finality` already models
   `pending` / `confirmed` / `finalized` / `reorged`).

Delivery 3 (market) needs: a market adapter per marketplace filling `NftMarketSnapshot` and producing `sale` / `list` / `offer`
events with a linked payment; order decoding and signer validation before any write; a source able to say that an on-chain
holder is that marketplace's escrow (the `escrow` state / reason).
