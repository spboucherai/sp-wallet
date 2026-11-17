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
| Market read | Magic Eden public Solana API, `NFT_MARKET_MAGICEDEN=on` | none | integrated, **off by default** (terms not readable from the official site, §10.2) |
| OpenSea | API v2 | `OPENSEA_API_KEY` (mandatory) | **integrated in delivery 3, verified live with a key** (§10.1); absent without the key |
| EVM discovery, keyed | Alchemy NFT API v3 or OpenSea account listing, `NFT_EVM_PROVIDER` | yes | **integrated in delivery 3** as hints re-verified on-chain (§10.3) |

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
| added by delivery 3 | `OPENSEA_API_KEY`, `NFT_MARKET_OPENSEA`, `NFT_EVM_PROVIDER`, `ALCHEMY_API_KEY` / `NFT_EVM_PROVIDER_API_KEY` | see §10.6 |

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

## 9. Added by delivery 2 (2026-11-17)

### 9.1 `ord` server — Bitcoin inscription safety (optional, self-hosted)

| | |
|---|---|
| What | the reference Ordinals indexer and explorer, run by the operator next to a `bitcoind` (`ord server`, with its address index: `--index-addresses`; `--index-runes` for runes) |
| Variable | `NFT_ORDINALS_API_URL` (https, or a loopback address). Unset = no ord source: the heuristic of `NFT-TRANSFERS.md` §7 |
| Endpoint used | `GET <base>/outputs/<ADDRESS>?type=any` with `Accept: application/json` — documented at docs.ordinals.com/guides/api.html (read 2026-11-17: "Get UTXOs held by `<ADDRESS>`"; `type` = `any` \| `cardinal` \| `inscribed` \| `runic`) |
| Answer used | a JSON array of outputs; of each: `outpoint` (`<txid>:<vout>`), `value` (sat, integer), `inscriptions` (ids), `runes` (map), `indexed` (boolean), `spent` (boolean). Any other shape is `ord_bad_answer` |
| Auth / quota / terms | none: the operator's own server. No keyless public ord API exists (delivery 1 audit: Hiro shut down 2026-03-09; `ordinals.com` answers a bot challenge) |
| What it receives | the wallet's Bitcoin address |
| Tested on | the documented response shape (the examples of the documentation page, with an inscribed and a runic output in the same shape) — `services/api/test/nft-transfer.test.ts`. **Not tested against a running `ord` server**: none is available on this machine, and running one needs a synchronised `bitcoind` |
| Used for | excluding outputs from the coin selection of ordinary BTC sends. Not used to list or transfer inscriptions |

### 9.2 Program interfaces read for the transfer builders

| Source | Read | Used for |
|---|---|---|
| `metaplex-foundation/mpl-token-metadata` — `idls/token_metadata.json` (version 1.14.0, raw.githubusercontent.com, 2026-11-17) | instruction `Transfer`: discriminant 49, 17 accounts in order (token, tokenOwner, destination, destinationOwner, mint, metadata, edition?, ownerTokenRecord?, destinationTokenRecord?, authority (signer), payer (signer), systemProgram, sysvarInstructions, splTokenProgram, splAtaProgram, authorizationRulesProgram?, authorizationRules?); `TransferArgs::V1 { amount: u64, authorization_data: Option<…> }` | `packages/core/src/nft-sol.ts` |
| `metaplex-foundation/mpl-core` — `idls/mpl_core.json` (0.2.0, program binary 0.4.2) | instruction `TransferV1`: discriminant 14, 7 accounts (asset, collection?, payer (signer), authority? (signer), newOwner, systemProgram?, logWrapper?); `TransferV1Args { compressionProof: Option<…> }` | same |
| EIP-721, EIP-1155 (eips.ethereum.org) | `safeTransferFrom(address,address,uint256)` = `0x42842e0e`; `safeTransferFrom(address,address,uint256,uint256,bytes)` = `0xf242432a`; ERC-165 ids `0x80ac58cd`, `0xd9b67a26` | `packages/core/src/nft-evm.ts`, `services/api/src/nft/transfer.ts` |

Both Solana instructions were then executed by the real programs (cloned from mainnet) on a local validator, and simulated
on mainnet for the Core and pNFT cases while the builders were written (`work/nft-2.md`).

## 10. Added by delivery 3 (2026-11-17) — market data, the keyed EVM discovery provider, sale interpretation

Tags as in the head of this file, plus **[live-key]**: observed with a key the owner supplied (the key is in no file of
the repository; recorded answers are scrubbed). Fixtures say their own provenance in a `provenance` field.

### 10.0 Decision summary

| Need | Source | Key | Verified | State |
|---|---|---|---|---|
| Market read — Solana and 7 EVM networks | **OpenSea API v2** | `OPENSEA_API_KEY` (mandatory) | **live with a key**: every endpoint the adapter uses, on the reference Core item, an ERC-721 and an ERC-1155 | integrated; absent and reported `needs_key` without the key; `NFT_MARKET_OPENSEA=off` turns it off |
| Market read — Solana, Magic Eden's own orders | **Magic Eden** public API | none | live, keyless | integrated, **off by default** (`NFT_MARKET_MAGICEDEN=on`): its API terms could not be read from the official site (§10.2) |
| EVM discovery (which NFTs the wallet's address holds) | **Alchemy NFT API v3** (`NFT_EVM_PROVIDER=alchemy`, `ALCHEMY_API_KEY`) or **OpenSea** account listing (`NFT_EVM_PROVIDER=opensea`) | yes | live with keys | integrated as **hints**, each item re-verified on-chain on the wallet's two endpoints; never on by default (the provider receives the wallet's EVM address) |
| A sale price without any provider (EVM) | the transaction's own **Seaport `OrderFulfilled`** event | none | 5 mainnet receipts | integrated, labelled "interpreted from the transaction by SP Wallet" |
| Solana marketplace involvement | a sourced list of 6 **program ids** | none | each read in its official repository and seen on-chain | integrated as a NAME only — never a price |
| Etherscan API v2, Tensor API, Helius, Solscan, Reservoir, Alchemy `getNFTSales`, Alchemy floor price | — | — | availability only | **not integrated** (§10.5) |
| Market WRITES (buy, sell, list, offer, accept, cancel) | — | — | — | **not built** — `NFT-MARKET-WRITES.md` |

### 10.1 OpenSea API v2

- **Reference.** The provider's own OpenAPI document, `https://api.opensea.io/api/v2/openapi.json` (OpenAPI 3.1.0, "OpenSea
  API" 2.0.0, 392 schemas) [live, keyless]; the documentation pages (`docs.opensea.io/llms.txt`; any page + `.md`). The
  document has **no response example** for the endpoints used (one exists for traits): the adapter was written against the
  schemas, then **verified live with a key**.
- **Key.** "All requests require an API key" [doc]; header `x-api-key` [doc]. Obtained at opensea.io → Settings → Developer
  (verified e-mail, a form, at most 3 keys), or `POST /api/v2/auth/keys` — an "instant" key that expires after 7 days,
  `rate_limits {read: "600/h", write: "30/h", fulfillment: "5/m"}` [doc; **not called**]. Observed without a key
  [live]: 200 for Get NFT / collection / stats of an *Ethereum* item, **401** `Missing an API Key, which is required for
  this request.` for the reference *Solana* item and for listings, offers, events, traits, account NFTs. The adapter never
  runs without a key.
- **Limits observed with the owner's key** [live-key]: `x-ratelimit-limit: 120`, `x-ratelimit-remaining`,
  `x-ratelimit-reset` on every answer; `Retry-After` on 429 [doc]. Numeric limits of a full key are not published ("read
  the headers"). The wallet allows itself **30 requests / minute and 5 000 / day** towards OpenSea (visible counters); an
  item read costs 5 requests (item, collection, best listing, best offer, last sale), a collection 3 (collection, stats,
  traits). Cache: item, listings, offers 2 min; events 5 min; collection 10 min.
- **Endpoints used, all verified live with the key** on the reference Core item, on BAYC #1 and #4339 (ERC-721) and on
  `0x33fd…7af1` #501 (ERC-1155):

  | Endpoint | Used for | Observed |
  |---|---|---|
  | `GET /chain/{chain}/contract/{address}/nfts/{identifier}` | the marketplace's collection slug, flags (`is_suspicious`, `is_disabled`, `is_nsfw`), `rarity {strategy_id, strategy_version, rank}` | **Solana: `address` and `identifier` are both the mint / asset address** — not stated by the documentation (one documented example suggests it); confirmed live on the reference item (`token_standard: metaplex_core`). `identifier = 0` answers 404 |
  | `GET /collections/{slug}` | name, description, image, banner, `safelist_status`, `fees[{fee %, recipient, required}]`, `total_supply`, `rarity.max_rank`, `pricing_currencies` (symbol → address + decimals) | reference collection `phygitals`: `safelist_status: verified`, 344 673 items, one required fee of 1 %, listing currency USDC `EPjFWdd5…Dt1v` |
  | `GET /collections/{slug}/stats` | floor and volume (decimals in whole units, named by SYMBOL), sales, owners | floor `0.36` `USDC`; **volume in `ETH` for this Solana collection** — a symbol with no network: shown as reported, attached to no currency |
  | `GET /traits/{slug}` | per-value counts | 2.3 MB for this collection; no item total in it — the denominator is the collection's `total_supply` of the same source |
  | `GET /listings/collection/{slug}/nfts/{id}/best` | asking price | 404 `No listings found …` = none. EVM: Seaport parameters (the payment token is read from the consideration). **Solana: `svm_order` + `protocol` (`tensor`, `os_tensor`), price named by symbol only** — tied to an exact mint only when it matches the collection's own `pricing_currencies`, else `unknown (currency_symbol_only)` |
  | `GET /offers/collection/{slug}/nfts/{id}/best`, `…/nfts/{id}` | best offer, offers list (`next` cursor) | BAYC #1: 8.03 WETH by contract address |
  | `GET /events/chain/{chain}/contract/{address}/nfts/{id}` (`event_type`, `after`, `before`, `limit`, `next`) | sales (`payment {quantity, token_address, decimals, symbol}`), listings and offers (`event_type: order` + `order_type`), transfers | reference item: **one sale, 14 500 USDC, 2026-11-10 16:38:56 UTC**, and 17 transfers with both parties on the first page; history back to 2026-04 on the next page |
  | `GET /chain/{chain}/account/{address}/nfts` | EVM discovery hints (§10.3) | 200 with the key |

  There is **no "all listings of one item" endpoint** (only `/best`), **no cancellation in the REST events** (Stream API
  only [doc]) and **no wash-trade flag anywhere** (zero occurrence in the document): `delist` / `cancel-offer` are never
  produced by this adapter and `washTrade` is `unknown`, never `false`.
- **Coverage.** `chain` values used: `ethereum`, `base`, `arbitrum`, `polygon`, `optimism`, `avalanche`, `hyperevm`,
  `solana` (the document's enum has 26 values; `/api/v2/chains` answered 28). **Not BNB Smart Chain** (404 [live-key]).
  Solana: "a selected group of established Solana collections" [doc, support.opensea.io]; Metaplex Core is served [live-key].
  Which read endpoints OpenSea guarantees for Solana: **NE** (not stated).
- **Verification badge.** `safelist_status`: `not_requested`, `requested`, `approved`, `verified`, `disabled_top_trending`
  (the SDK's own comments; no enum in the document). Only `verified` is shown, as "Collection vérifiée par OpenSea" —
  the marketplace's statement, never an on-chain verification.
- **Rarity.** `strategy_id: openrarity` [live]; rank shown as "2664 sur 9996 · méthode openrarity 1.0, selon OpenSea".
  The reference item has `rarity: null`: no rank is shown.
- **Terms** — `https://opensea.io/developer-terms`, "Developer Terms of Use", **Last Updated: April 26, 2023** [doc]:
  - attribution: "You agree to provide appropriate attribution to OpenSea on your site or in your product or services, for
    example by linking to the OpenSea website from the NFTs that you display, where appropriate" → the panel shows "Market
    data: OpenSea" and the link to the item's page;
  - commercial use: "You may not commercialize the API, or any data … without our express written permission. Your use …
    will be considered 'commercial' if you earn money as part of a product or service that you are selling, re-selling, or
    otherwise monetizing";
  - redistribution: "You may not rent, sell, lease, lend, convey, redistribute, or otherwise provide any third party with
    use of or access to any aspect of the API or API Data" → the owner's own screens are not a third party; **an API key
    of the trading API given to someone else would be**: `markets:read` answers OpenSea data — do not hand such a key to a
    third party while this source is on;
  - storage: "If API Data is deleted, suspended, withheld, modified, disabled, delisted … you will make all reasonable
    efforts to delete or modify such API Data in your possession as soon as possible, and in any case within 24 hours after
    a written request" → the market cache is dropped after 24 h and can be emptied (`NFT-RUNBOOK.md`);
  - limits: "not to … exceed, circumvent … any limits (e.g., rate limits) … including by sharing access to the API,
    aggregating accounts, or creating multiple API keys";
  - no caching-duration clause; whether the keyless answers are intended: NE.
- **What OpenSea learns**: the contract + token id (or mint) of each item the owner OPENS, the collection slug, the
  server's IP and the key. Never the wallet's address — unless `NFT_EVM_PROVIDER=opensea` (§10.3).

### 10.2 Magic Eden (Solana) — opt-in

- **Terms.** `magiceden.io/legal-policies/api-terms`, `docs.magiceden.io` and `help.magiceden.io` still answer a bot
  challenge (403, `cf-mitigated: challenge`) to this machine [live]: **the API terms were not read from the official
  site.** A third-party archive (tostracker.app, capture of 2026-07-10) shows an "API Terms of Service — Last Updated:
  March 2025" whose clauses would allow this use with constraints (2.2: not to "create copies of any data … except as
  necessary to enable an intended usage scenario", nor "Redistribute or resell"; 5.3: not to "keep cached copies longer
  than permitted by the cache header"; 6.1: "display any attribution(s) required by Magic Eden as described in the
  documentation"; 2.5: the APIs may change or stop "AT ANY TIME"). It is an unofficial copy: **nothing is enabled on it**.
  What the documentation says [snippet]: "we make this API available free of charge and kindly request that you attribute
  Magic Eden … please consider linking to the Magic Eden marketplace from the NFTs that you showcase"; "This public API is
  free to use, and the default limit is 120 QPM or 2 QPS". Status: "For now, the Solana API remains operational"
  [snippet, help article 13885533]; its Bitcoin / Runes APIs were discontinued on 2026-03-27.
  → **Decision unchanged: OFF by default.** The owner, who can read the terms page in a browser, turns it on with
  `NFT_MARKET_MAGICEDEN=on`; the panel then shows "Market data: Magic Eden" and the link back. The wallet allows itself 40
  requests / minute (observed header `x-ratelimit-limit: 180`).
- **Endpoints, each called live keyless** (fixture `market-magiceden-live.json`): `/tokens/{mint}` ·
  `/tokens/{mint}/listings` · `/tokens/{mint}/offers_received` · `/tokens/{mint}/activities` ·
  `/collections/{symbol}/stats` (`floorPrice`, `listedCount`, `avgPrice24hr`, `volume7d` — no `volumeAll`). Their
  documented parameter tables: NE (documentation blocked).
- **Observed and handled:** in `activities`, `priceInfo.solPrice.rawAmount` is **not lamports** (price × 10¹⁸ while
  `decimals` says 9): an activity's amount is taken from `price` (decimal SOL), marked `source_decimal`; in `listings`
  the base-unit field is right and must agree with `price`, else the price is `unknown`. `offers_received` returns
  **expired offers**: filtered on `expiry`. `volume7d` and `avgPrice24hr` can be non-integer numbers of lamports: kept
  only when whole. `/collections/{symbol}` answers 429 with `x-ratelimit-limit: -1` and `holder_stats` 400: not usable
  keyless — no collection description, no badge (`isBadged` exists only in the bulk list; its meaning is NE).
  `collections/{symbol}/attributes` counts LISTED items with no collection total: **no trait frequency from this source**.
- The reference item on Magic Eden [live]: unlisted, no offer, **no activity**; collection floor 0.004 SOL. OpenSea
  reports a USDC sale of the same item (§10.1): two marketplaces, two statements, shown side by side.

### 10.3 Keyed EVM discovery — hints only

Every hint (contract + token id) is re-read on-chain on the wallet's two endpoints before it is shown as held; what the
chain does not confirm is dropped and counted (`not_confirmed_on_chain:N`). A provider can hide an NFT; it cannot invent
one. **Each receives the wallet's EVM address**: never on by default.

**Alchemy NFT API v3** (`NFT_EVM_PROVIDER=alchemy`, key `ALCHEMY_API_KEY` — or `NFT_EVM_PROVIDER_API_KEY`):
- reference: `github.com/alchemyplatform/docs` `src/openapi/nft/nft.yaml` and `src/openrpc/alchemy/transfers/transfers.yaml` [doc];
- `GET https://{network}.g.alchemy.com/nft/v3/{apiKey}/getNFTsForOwner?owner=&withMetadata=false&pageSize=100&pageKey=`
  — **the key is a URL path segment**. With `withMetadata=false` the items are flat: `{contractAddress, tokenId, balance,
  isSpam, spamClassifications}` [live-key]. Networks of the spec's enum used: `eth-mainnet`, `base-mainnet`,
  `arb-mainnet`, `polygon-mainnet`, `opt-mainnet`, `bnb-mainnet`, `avax-mainnet`; **HyperEVM is not in the NFT API**;
- **the owner's key today [live-key, 2026-11-17]: Ethereum answers; Base, Arbitrum, Polygon, Optimism, BNB and Avalanche
  answer 403 `<NETWORK> is not enabled for this app`** → shown per network as *blocked by provider: network not enabled
  for this key* (never "no NFT"); enabling the network in the Alchemy dashboard is enough — no change of SP Wallet;
- spam: `isSpam` is passed through as "signalé comme indésirable par Alchemy"; such items are hidden by default behind a
  filter of the gallery and are never deleted. (The `SPAM` *filter parameter* is "available exclusively on paid tiers"
  [doc]; the flag itself is answered on this key.) On a public address with 27 612 NFTs, 195 of the first 200 were flagged;
- history: `alchemy_getAssetTransfers` (JSON-RPC, `category: [erc721, erc1155]`, `contractAddresses`, `toAddress` /
  `fromAddress`) names the transactions in which a contract's tokens moved to or from the wallet; each is then read from
  the chain (its receipt, on the wallet's own endpoints) — this extends an item's EVM activity beyond the ~1 000-block
  window, for items of the wallet only;
- `getNFTSales`: **404 `This API endpoint has been deprecated.`** [live-key]. `getFloorPrice` answers a float and a
  symbol relayed from OpenSea and LooksRare (the LooksRare figure seen was dated 2025-01): not used — OpenSea is asked
  first-hand. `getNFTMetadata`, `getContractMetadata`, `getOwnersForNFT` answer [live-key] and are **not used**: the wallet
  reads ownership on-chain and the creator's metadata itself;
- free plan [doc]: 30 M compute units / month, 300 CU/s; `getNFTsForOwner` 480 CU (≈ 62 500 calls / month);
- terms — `legal.alchemy.com`, "Last updated June 27, 2025" [doc, read in part]: "the right to Use the Services solely for
  your internal business purposes"; no resale / mirroring; no circumvention of limits. Clauses on caching or attribution
  of API data: none found in the part read (NE for the rest);
- **the same key is NOT wired as an RPC endpoint.** It could serve as a third endpoint of `rpcQuorum` (`SPW_RPC_EXTRA`);
  that is a separate owner decision, because an RPC URL is logged and reported in more places than this adapter's (a
  key-in-URL would need the same scrubbing in `chains/rpc.ts`, the monitor and every RPC error path).

**OpenSea account listing** (`NFT_EVM_PROVIDER=opensea`, the same `OPENSEA_API_KEY`): `GET
/chain/{chain}/account/{address}/nfts` [live-key] on ethereum, base, arbitrum, polygon, optimism, avalanche, hyperevm
(not BNB). The developer terms do not restrict reading an account's NFTs (the clauses quoted in §10.1 are the relevant
ones). No spam flag in that answer. It is a separate opt-in from the market read: setting the key alone sends no address.

### 10.4 Sale interpretation from a transaction (keyless)

- **Seaport.** Addresses from `github.com/ProjectOpenSea/seaport` `docs/Deployments.md` ("Canonical addresses"): 1.6
  `0x0000000000000068F116a894984e2DB1123eB395` — listed for the 8 EVM networks of the registry ("checked onchain on
  November 9 and 10, 2026") —, 1.5 `0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC`, 1.4
  `0x00000000000001ad428e4906aE43D8F9852d0dD6`, 1.1 `0x00000000006c3852cbEf3e08E8dF289169EdE581` (no per-chain list in
  the document: recognised where code was observed at the address on 2026-11-17 — 7 networks, none on HyperEVM). Event
  and structs from `ProjectOpenSea/seaport-types` (`ConsiderationEventsAndErrors.sol`, `ConsiderationStructs.sol`,
  `ConsiderationEnums.sol`); topic `0x9d9af8e3…cdcb6f31`, confirmed on 245 live logs.
- Rule (`market/seaport.ts`): a price is linked to a transfer only when the receipt of the same transaction holds an
  `OrderFulfilled` of a recognised contract naming the token on one side and a payment in ONE currency on the other, and
  the token's own transfer log has the same parties. Checked on 5 recorded mainnet receipts (a listing filled in ETH, an
  accepted WETH offer, matched orders — two events for one sale, counted once —, a bulk purchase, an ERC-1155); the
  ERC-1155 figure equals what OpenSea reports for the same transaction. Not interpreted: any other marketplace
  (Blur, LooksRare, X2Y2…), criteria items, payments in several currencies, a payment token the registry does not know.
- **Solana program ids** (name only — no layout is decoded, no price): M2 `M2mx93ek…aF7K`, MMM `mmm3XBJg…owMc`, M3
  `M3mxk5W2…BfS1` (github.com/me-foundation), Tensor Swap `TSWAPaqy…mHbN` (tensor-hq/tensorswap-sdk), Tensor Marketplace
  `TCMPhJdw…ZsDp` (tensor-foundation/marketplace), Metaplex Auction House `hausS13j…BBmk`
  (metaplex-foundation/metaplex-program-library); each executable on mainnet [live]. OpenSea's `os_tensor`
  (`7Aru291A…tQF9V`) is **not** in the list: no official source names it.

### 10.5 Looked at, not integrated

| Source | Finding (2026-11-17) |
|---|---|
| Etherscan API v2 `tokennfttx` / `token1155tx` | key mandatory (keyless: `Missing/Invalid API Key`); free tier 3 calls/s, 100 000/day on Ethereum, Arbitrum, Polygon only (HyperEVM free until 2026-11-30); Base, Optimism, BNB, Avalanche paid; `addresstokennftinventory` is PRO; terms (1 Oct 2026): "Powered by Etherscan.io APIs" attribution, exempt "for purely private use". Not built: one keyed EVM adapter was asked for, and Alchemy's covers more networks on its free plan |
| Tensor API | key by application ("This API is in Alpha!"); keyless → 403. Its on-chain program is the subject of `NFT-MARKET-WRITES.md` |
| Helius enhanced transactions | key; "deprecated and no longer receiving new parser types" |
| Solscan | 401 without a token |
| Reservoir, SimpleHash | shut down (as recorded in §4.2) |
| A public `ord` instance | the documentation names ordinals.com (mainnet) but every JSON request answered a Cloudflare challenge (403); signet / testnet hosts do not resolve; no terms or robots policy found. **The ord adapter is still unverified against a real `ord`** |

### 10.6 Variables added (names only)

| Variable | Effect | Without it |
|---|---|---|
| `OPENSEA_API_KEY` | OpenSea market read (and the key of `NFT_EVM_PROVIDER=opensea`) | the source is absent: `needs_key` |
| `NFT_MARKET_OPENSEA=off` | turns the OpenSea market read off although the key is set | on when the key is set |
| `NFT_EVM_PROVIDER` | `alchemy` or `opensea`: keyed EVM discovery hints — **sends the wallet's EVM address to it** | no keyed discovery |
| `ALCHEMY_API_KEY` (or `NFT_EVM_PROVIDER_API_KEY`) | the key of `NFT_EVM_PROVIDER=alchemy` | the provider is absent |

Where the keys live in production: the PM2 environment of `sp-wallet` on the **API node** and the `env` block of the
`mld` manifest. **Never on the signer node, never in the web bundle, never in a commit.** The API reads them in
`nft/config.ts` only and reports variable NAMES.

### 10.7 Who receives what — additions to §8

| Request | Carries | Goes to | When |
|---|---|---|---|
| OpenSea item / collection / events | contract + token id or mint; the collection slug | api.opensea.io | the owner opens an item or a collection, with the key set |
| OpenSea account NFTs | **the wallet's EVM address** | api.opensea.io | each synchronisation, only with `NFT_EVM_PROVIDER=opensea` |
| Alchemy `getNFTsForOwner`, `alchemy_getAssetTransfers` | **the wallet's EVM address** (and a contract) | `<network>.g.alchemy.com` | each synchronisation / an item's activity, only with `NFT_EVM_PROVIDER=alchemy` |
| Magic Eden | the mint, the collection symbol | api-mainnet.magiceden.dev | the owner opens a Solana item, only when turned on |
| collection logo / banner | nothing about the wallet | the marketplace's image host, through the media proxy | first display |
| `GET /api/v1/trading/nfts/market` (a key with `markets:read`) | the same item identifiers as above | the market sources | on the key's request — the key learns nothing about the wallet |
