# SP Wallet — NFT data sources (established 2026-11-17)

What each source really is **today**: read on the official page and/or measured with live, read-only, keyless calls from this
machine. Tags: **[live]** observed in a live call that day (the answers behind the tests are in
`services/api/test/fixtures/nft/`, re-recordable with `scripts/record-nft-fixtures.mts`) · **[doc]** read on the official page
(URL given) · **[snippet]** seen only as a search-index excerpt of the official page (the page refused a direct fetch) ·
**NE** not established. Nothing below comes from memory. Re-verify before relying on any line after this date.

## 1. Decision summary

| Need | Source used in delivery 1 | Key | State |
|---|---|---|---|
| Solana on-chain truth (ownership, state, identity, collection) | the wallet's own RPC endpoints: `api.mainnet-beta.solana.com`, `solana-rpc.publicnode.com` | none | integrated, tested |
| Solana Core discovery by owner | `getProgramAccounts` + memcmp — answered by `api.mainnet-beta.solana.com` only | none | integrated; **blocked by provider** when only publicnode answers (unlock: a third endpoint in `SPW_RPC_EXTRA`) |
| Solana compressed NFTs, holder hint | DAS methods on `api.mainnet-beta.solana.com` (probed at each call), or `NFT_SOLANA_DAS_URL` | none today / provider key in the URL | integrated as **indexed** data; `NFT_SOLANA_DAS=off` disables |
| EVM on-chain truth | the two RPC endpoints of each EVM network (`eth_call`, `eth_getCode`) | none | integrated, tested |
| EVM discovery | none keyless (measured, §4). Optional: a Blockscout-compatible instance per network, `NFT_EVM_INDEXER_URLS` | none (per-instance REST) | integrated as a **hint** re-verified on-chain; off by default |
| Bitcoin Ordinals | none usable without self-hosting | — | **not integrated**; warning shown |
| Market read | Magic Eden public Solana API, `NFT_MARKET_MAGICEDEN=on` | none | integrated, **off by default** (terms only partly readable, §6) |
| OpenSea | API v2 | `OPENSEA_API_KEY` (mandatory) | **not integrated**; variable name reserved |

Degraded mode with **no variable set**: Solana inventory (token + Core + compressed while the public endpoint serves DAS),
lookup of any Solana / EVM asset, manual tracking of EVM NFTs verified on-chain, creator metadata and media through the proxy,
Solana activity; no market data (links to the marketplaces' own pages instead).

## 2. Solana

### 2.1 RPC endpoints of the registry

| Method | `api.mainnet-beta.solana.com` | `solana-rpc.publicnode.com` |
|---|---|---|
| `getMultipleAccounts`, `getAccountInfo`, `getTokenAccountsByOwner`, `getSignaturesForAddress`, `getTransaction` | yes [live] | yes [live] |
| `getProgramAccounts` (Core program, memcmp key + owner) | **yes** [live] | **no** — `-32602 Indexed requests require a personal token` [live] |
| `getTokenLargestAccounts` | `429 Too many requests for a specific RPC call` at the time of recording [live] | no — same "personal token" answer [live] |
| DAS `getAsset`, `getAssetsByOwner`, `searchAssets` | **yes** [live] | no — `-32601 Method not found` [live] |
| DAS `getAssetProof` (non-compressed asset) | `RecordNotFound: Asset Proof Not Found` [live] | no |

- Rate limits observed on `api.mainnet-beta.solana.com` response headers [live]: `x-ratelimit-tier: free`,
  `x-ratelimit-method-limit: 150`, `x-ratelimit-rps-limit: 250`, `x-ratelimit-conn-limit: 40`.
- The official RPC method list (https://solana.com/docs/rpc/http) does **not** list the DAS methods [doc]: that the public
  endpoint answers them today is an observation, not a documented guarantee — hence the probe at each call and the
  `blocked_by_provider` state when it stops. "Public RPC endpoints are shared infrastructure and are not intended for
  production applications" [snippet, https://solana.com/docs/rpc].
- DAS providers per Metaplex (https://metaplex.com/docs/rpc-providers [doc]): Extrnode, Helius, Hello Moon, QuickNode, Shyft,
  Triton. Helius: `https://mainnet.helius-rpc.com/?api-key=…`, free plan 1 M credits / month, 10 RPC req/s, 2 DAS req/s
  (https://www.helius.dev/pricing [doc]). Triton: token in the URL or `x-token`, billed (https://docs.triton.one [doc]).
  → `NFT_SOLANA_DAS_URL` takes the full URL (the key, if any, is part of it; only its host is ever shown).

### 2.2 Account layouts (decoders in `packages/nft/src/solana.ts`)

Read in the programs' own source on GitHub `main` [doc], then checked against real mainnet accounts [live]:

- mpl-core `programs/mpl-core/src/state/{asset,collection,mod,update_authority}.rs`, `plugins/{mod,plugin_header,plugin_registry}.rs`,
  `instruction.rs` — https://github.com/metaplex-foundation/mpl-core . `AssetV1`: key(1) · owner(32) · update_authority(enum
  None | Address | Collection) · name · uri · seq(Option<u64>); `CollectionV1`: key · update_authority · name · uri ·
  num_minted(u32) · current_size(u32); plugin header (key 3, registry offset u64) right after; registry records
  {plugin_type, authority, offset}; `PluginType` order Royalties, FreezeDelegate, BurnDelegate, TransferDelegate,
  UpdateDelegate, PermanentFreezeDelegate, Attributes, PermanentTransferDelegate, PermanentBurnDelegate, …; instruction
  discriminators CreateV1 = 0, BurnV1 = 12, TransferV1 = 14, CreateV2 = 20 with their account order.
- mpl-token-metadata `programs/token-metadata/program/src/state/*.rs`, `pda.rs` —
  https://github.com/metaplex-foundation/mpl-token-metadata . `Metadata` (key 4), `MasterEditionV2` (6), `Edition` (1),
  `TokenRecord` (11; `TokenState` Unlocked | Locked | Listed); PDA seeds `["metadata", program, mint]`,
  `[…, "edition"]`, `[…, "token_record", token_account]`. The inner layouts of `Creator` {address, verified, share},
  `Collection` {verified, key} and `Uses` were not on the pages read; they are confirmed by decoding the recorded accounts
  (creators, verified flags and collections match what the DAS index reports for the same mints).

### 2.3 The reference item `CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j`

Established from the chain on 2026-11-17 (both endpoints agreeing, slot ≈ 470 470 907; fixture `sol-core-reference`):

- It is a **Metaplex Core asset** (account owned by `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`, 182 bytes, key 1): not an
  SPL mint, no token account, no Token Metadata account, not compressed.
- Owner: `62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS` (a system-owned wallet). Not held by SP Wallet.
- On-chain name `2016 Pokemon XY Special Box Prom`; URI `https://metadata.phygitals.com/CMhG…659j`; no plugin on the asset.
- Collection: `phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC` (Core collection, on-chain name `Phygitals`, update authority
  `6gn64NNTDS4sNDfAq6Qk6cdgPeCWjupPbUVLfNSHeY4S`); membership is written by the Core program (update authority = the
  collection). The collection carries **PermanentFreezeDelegate (not frozen), PermanentTransferDelegate and
  PermanentBurnDelegate** with authority = the collection's update authority: that authority can move or burn any item.
- Metadata is mutable (no ImmutableMetadata plugin); royalties: no plugin.
- Declared metadata document (fetched through the wallet's fetcher, 1 023 bytes, `application/json`): name as on-chain;
  description `2016 Pokemon XY Special Box Promo Japanese Rayquaza Poncho Weari`; 9 attributes — Grade `PSA 10.0`, Grader
  `PSA`, Cert Number `65475295`, Title `2016 Pokemon XY Special Box Promo Japanese Rayquaza Poncho Wearing Pikachu #230XYP
  PSA 10`, Language `Japanese`, Category `Pokemon`, Type `Pokemon`, Name `Pikachu`, Energy Type `Lightning`; image
  `https://gateway.irys.xyz/29YSZT2VooL3a8413PAq25rF48j1pa1Rbk9LfYvDA6YF` (PNG, 714 270 bytes, after one redirect); no
  external link; `seller_fee_basis_points` 0.
- History (8 transactions referencing the asset, newest 2026-11-10 16:40:35 UTC, oldest read 2026-05-02): 7 Core `TransferV1`
  and one transaction not interpreted. No price is derived from any of them.
- Magic Eden (keyless) reports it `unlisted`, collection symbol `phygitals___`, collection floor 4 000 000 lamports at the
  time of recording — market data, shown only when that source is turned on. Its token answer lists 6 of the 9 attributes:
  an index is not the creator's document.
- OpenSea: `GET https://api.opensea.io/api/v2/chain/solana/contract/<mint>/nfts/<mint>` → **401** `Missing an API Key, which
  is required for this request.` [live]. The endpoint that would be used with a key is `GET
  /api/v2/chain/{chain}/contract/{address}/nfts/{identifier}`; which values to pass as address / identifier for Solana is
  **NE** from the docs. The OpenSea page itself was not fetched.

Other real cases recorded the same day (fixtures): a legacy Token Metadata NFT listed on a marketplace (the unit sits in an
escrow's token account), a programmable NFT (locked, delegate, rule set), a Token-2022 NFT (metadata + metadataPointer +
groupMemberPointer extensions), a compressed NFT, a burned compressed NFT, and the full inventory of a public address
(40 token NFTs incl. frozen + delegated ones, 14 Core assets, 9 compressed).

## 3. Compressed NFTs

Exist for this server only through a DAS index. Shown with category **indexed**; collection verification "not verified (the
index does not say)" when the index gives no flag; no on-chain verification against the merkle tree in delivery 1 (a
`getAssetProof` + tree-root check is what delivery 2 needs before any transfer of one).

## 4. EVM (8 networks)

### 4.1 Measurement: can public endpoints discover what an address holds?

`scripts/nft-measure-evm-logs.mts`, 2026-11-17 — `eth_getLogs` for `Transfer(address,address,uint256)` with the recipient as
topic 2, **without** a contract address ("wallet-shaped") and with one:

| Network | Endpoint | wallet-shaped (no contract address) | with a contract address |
|---|---|---|---|
| Ethereum | ethereum-rpc.publicnode.com | refused: "Please specify an address in your request" | ≤ 1 000 recent blocks; older: "Archive requests require a personal token" |
| Ethereum | eth.drpc.org | 100 blocks; 1 000 → "ranges over 10000 blocks are not supported on free plan" | 100 blocks |
| Base | mainnet.base.org | "request limit reached" | same |
| Base | base-rpc.publicnode.com | refused (address required) | ≤ 50 000 blocks |
| Arbitrum | arb1.arbitrum.io | ≤ 30 000 recent blocks | ≤ 500 000 |
| Arbitrum | arbitrum-one-rpc.publicnode.com | "Archive requests require a personal token" | same |
| Polygon | polygon-bor-rpc.publicnode.com | refused (address required) | ≤ 10 000 |
| Polygon | polygon.drpc.org | 100 blocks | 100 blocks |
| Optimism | mainnet.optimism.io | ≤ 10 000 recent blocks | ≤ 10 000 |
| Optimism | optimism-rpc.publicnode.com | refused (address required) | ≤ 1 000 recent |
| BNB Chain | bsc-dataseed.bnbchain.org | "limit exceeded" | same |
| BNB Chain | bsc-rpc.publicnode.com | refused (address required) | ≤ 50 000 |
| Avalanche | api.avax.network | "maximum of 100 blocks" | same |
| Avalanche | avalanche-c-chain-rpc.publicnode.com | refused (address required) | ≤ 50 000 |
| HyperEVM | rpc.hyperliquid.xyz | 100 blocks; then "rate limited" | same |
| HyperEVM | hyperliquid.drpc.org | 100 blocks | 100 blocks |

**Decision.** A wallet's NFTs may have arrived at any block since its first activity; no network offers a keyless wallet-wide
log scan over history (best case: the last 10 000–30 000 blocks on one endpoint of two networks). Incremental log scanning is
therefore **not** used for discovery: it would present a few hours of history as an inventory. Without an indexer, EVM
discovery is `blocked_by_provider`, and the owner adds an NFT by contract + token id, verified on-chain (`ownerOf` /
`balanceOf` on both endpoints). The per-token activity uses the same endpoints *with* the contract address over the last
1 000 (else 100) blocks and says "recent window only".

### 4.2 Indexers

| Provider | State today | Key | Free tier / coverage |
|---|---|---|---|
| Blockscout per-instance REST `GET {instance}/api/v2/addresses/{address}/nft?type=ERC-721,ERC-1155` | operating; "Per instance endpoints will be deprecated soon" [doc, docs.blockscout.com/api-reference/get-list-of-nft-owned-by-address] | none (`security: []`) | 300 req/min per IP [doc]; `eth.blockscout.com` answered [live] (items[].id, .token.address_hash, .token_type, .value, next_page_params); `optimism.blockscout.com` answered once then `301`; `base.`, `arbitrum.`, `polygon.blockscout.com` answered a Cloudflare challenge (403) [live]. BNB, Avalanche, HyperEVM instances: NE |
| Alchemy NFT API v3 `getNFTsForOwner` | operating [doc] | key in the path | free 30 M CU / month; Ethereum, Polygon, Arbitrum, Optimism, Base "and more"; BNB / Avalanche / HyperEVM: NE |
| Moralis `GET /api/v2.2/{address}/nft` | operating [doc] | `X-API-Key` | "doesn't have a self-serve free plan" [snippet]; no HyperEVM |
| Etherscan API v2 `tokennfttx` / `token1155tx` | operating [doc] | `apikey` | free: 3 calls/s, 100 000/day, Ethereum / Arbitrum / Polygon only; Base, OP, BNB, Avalanche need a paid plan; HyperEVM free until 2026-11-30; `addresstokennftbalance` is paid-only |
| OpenSea `GET /api/v2/chain/{chain}/account/{address}/nfts` | operating [doc] | `x-api-key` mandatory | chains incl. ethereum, base, arbitrum, polygon, optimism, avalanche, hyperevm, solana; **not** BNB |
| SimpleHash | shut down 2025-03-27 (third-party report) | — | — |
| Reservoir NFT API | sunset 2025-10-15 (third-party report); docs redirect to relay.link [doc] | — | — |

Integrated in delivery 1: the **Blockscout-compatible** adapter only (`NFT_EVM_INDEXER_URLS`, a JSON map network → instance
base URL), because it is the one whose real answer could be observed without a key. It is **off by default**: turning it on
sends the wallet's EVM address to that host. Every item it lists is re-read on-chain; what the chain does not confirm as held
is dropped and counted (`not_confirmed_on_chain:N`). The adapters for Alchemy / OpenSea account endpoints are **not built**
(no answer could be observed without a key): `NFT_EVM_PROVIDER_API_KEY` and `OPENSEA_API_KEY` are reserved names.

## 5. Bitcoin Ordinals

- `ord` server JSON API [doc, https://docs.ordinals.com/guides/api.html]: `/address/<ADDRESS>`, `/outputs/<ADDRESS>`,
  `/output/<OUTPOINT>`, `/inscription/<ID>`, `/sat/<SAT>` (needs `--index-sats`) with `Accept: application/json`. No official
  public instance is documented as an API; `https://ordinals.com/inscription/…` with that header answered a Cloudflare
  challenge (403) [live]. Self-hosting (`bitcoind` + `ord --index-sats`) is the documented route.
- Hiro Ordinals API: shut down — "Deprecation date: March 9th, 2026" [doc, hiro.so/blog]; `api.hiro.so/ordinals/v1/…` →
  403 `Missing Authentication Token` [live].
- Xverse API (key or pay-per-request), UniSat Open API (free key: 5 calls/s, ~1 000–2 000/day), Ordiscan (key, 1 000
  requests/month free): keys required [doc / snippet]. Magic Eden's Bitcoin API: being shut down [snippet].

**Decision.** No adapter in delivery 1 (no keyless source, and no live answer of an `ord` server to build against). The
inventory state is `blocked_by_provider`; `NFT_ORDINALS_API_URL` is the reserved name for the self-hosted `ord` server that
delivery 2 needs anyway to protect inscriptions in BTC sends (`NFT-AUDIT.md` §4).

## 6. Market read data

| Source | Keyless | Limits | Solana | Terms (what could be read) |
|---|---|---|---|---|
| Magic Eden `api-mainnet.magiceden.dev/v2` — `/tokens/{mint}`, `/tokens/{mint}/listings`, `/collections/{symbol}/stats` | yes [live] — "This public API is free to use, and the default limit is 120 QPM or 2 QPS" [doc, docs.magiceden.io/reference/solana-api-keys]; `x-ratelimit-limit: 180` observed [live] | 120 QPM documented | yes (Core included: the reference item is answered) | "kindly request that you attribute Magic Eden on your website or within your app … linking to the Magic Eden marketplace from the NFTs that you showcase" [snippet]. The API terms page (magiceden.io/legal-policies/api-terms) refused a fetch: caching / redistribution clauses **NE**. "For now, the Solana API remains operational" [snippet, help.magiceden.io] |
| OpenSea API v2 | no — "All requests require an API key passed via the `x-api-key` header" [doc]; an instant key exists (`POST /api/v2/auth/keys`, expires after 7 days, 600 reads/h) | not published for full keys | "a selected group of established Solana collections"; Core, pNFT, legacy, compressed supported [doc, support.opensea.io] | developer terms (2023-04-26): attribution and link required; no redistribution of the API or sale of API Data; no commercialisation [doc] |

**Decision.** One read source, **configured, not default**: Magic Eden for Solana, behind `NFT_MARKET_MAGICEDEN=on`, because
its use is documented as free and keyless but its full API terms could not be read. When on: only the mint (and the
marketplace's collection symbol) is sent, never the wallet's address; values are kept 5 minutes; the item page shows
"Marché — mis à jour à …", the attribution line and a link to the marketplace. When off (default): no market data, and the
item page links to the marketplace's own page with the "outside SP Wallet" warning. The owner should read the API terms
before turning it on.

## 7. Configuration variables (names only)

| Variable | Effect | Without it |
|---|---|---|
| `NFT_ENABLED=off` | turns the NFT routes off (`nft_disabled`) | on |
| `NFT_SOLANA_DAS_URL` | DAS endpoint (URL may contain the provider's key) for compressed NFTs and holder hints | the wallet's Solana RPC endpoints are probed |
| `NFT_SOLANA_DAS=off` | never ask a DAS index | probing as above |
| `SPW_RPC_EXTRA` (existing) | a third Solana endpoint that serves `getProgramAccounts` keeps Core discovery working if the public one stops | two public endpoints |
| `NFT_EVM_INDEXER_URLS` | `{"ethereum":"https://eth.blockscout.com", …}` — indexer hint for EVM discovery | EVM discovery `blocked_by_provider`; manual add |
| `NFT_MARKET_MAGICEDEN=on` | Magic Eden market read for Solana | no market data |
| `NFT_IPFS_GATEWAYS`, `NFT_ARWEAVE_GATEWAYS` | comma-separated `https://…/` bases, tried in order | `ipfs.io`, `dweb.link`; `arweave.net` |
| `NFT_CACHE_DIR`, `NFT_CACHE_MAX_BYTES`, `NFT_MEDIA_MAX_BYTES` | media cache location (default: `SPW_DATA_DIR` or the OS temp dir), its cap (1 GiB) and the per-file cap (25 MiB) | defaults |
| `NFT_FETCH_DAILY_REQUESTS`, `NFT_FETCH_DAILY_BYTES` | daily budget of requests to creator-controlled hosts (5 000 / 2 GiB) | defaults |
| `NFT_INVENTORY_MAX` | cap of items read per section and chain (500) | default |
| reserved, not read by any code yet | `OPENSEA_API_KEY`, `NFT_EVM_PROVIDER_API_KEY`, `NFT_ORDINALS_API_URL` | — |

The server reports which of these are in force — names only — in its capability line at start-up and in
`GET /api/v1/nfts/capabilities` (`providers[]`, `chains[].unlockedBy`).

## 8. Who receives the wallet's address

| Request | Carries | Goes to | When |
|---|---|---|---|
| `getTokenAccountsByOwner`, `getProgramAccounts` (memcmp owner) | the wallet's Solana address | the Solana RPC hosts of the registry (they already receive it for balances) | each synchronisation |
| DAS `searchAssets(ownerAddress)` | the wallet's Solana address | the same RPC host, or the host of `NFT_SOLANA_DAS_URL` | each synchronisation |
| `eth_call balanceOf(wallet, id)` | the wallet's EVM address | the EVM RPC hosts of the registry | tracked ERC-1155 only |
| `GET …/api/v2/addresses/<wallet>/nft` | the wallet's EVM address | the indexer host(s) of `NFT_EVM_INDEXER_URLS` | only when configured |
| metadata and media fetches | **nothing about the wallet** (no cookie, no referrer; the server's IP) | creators' hosts and the IPFS / Arweave gateways | when an asset is loaded / a file first shown |
| Magic Eden | the mint, the marketplace's collection symbol | api-mainnet.magiceden.dev | only when turned on |

A creator's server learns that *this server* fetched a document — and, by which document, that some user of it holds or
looked at that NFT. Looking up an asset the wallet does not hold produces the same requests. The browser itself never
contacts a third party for NFT data.
