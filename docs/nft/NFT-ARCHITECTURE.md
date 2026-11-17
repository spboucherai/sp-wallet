# SP Wallet — NFT architecture (delivery 1: read-only; transfers of delivery 2 are in `NFT-TRANSFERS.md`)

Delivery 1 of `NFT-BRIEF.md` §17: inventory, collection and item pages, secure metadata and media, activity where the sources
allow. **Nothing in it signs, prepares or broadcasts anything; the signer, intents and policy are untouched.** What is real
per chain is in `NFT-AUDIT.md` §3; what each source is and costs, in `NFT-SOURCES.md`.

```
browser ── /api/v1/nfts/* (owner session) ──▶ routes.ts ──▶ service.ts ──┬─▶ providers  solana.ts · evm.ts      (1 on-chain truth, 3 indexed)
   ▲  <img|video|iframe sandbox src=/api/v1/nfts/media/<id>>             ├─▶ resolver.ts ─▶ safe-fetch.ts       (2 creator metadata + media)
   └────────────────────────────── media proxy ◀──────────────────────── ├─▶ market.ts                          (4 market, optional)
                                                                         └─▶ store.ts (PostgreSQL: caches)      (5 computed: none yet)
```

## 1. The five data categories never mix

Every external value belongs to exactly one category and carries a `DataSourceStamp` {category, source, detail (host),
fetchedAt, blockRef, confidence, freshness, covers}:

| # | Category | Produced by | Shown as | Confidence values |
|---|---|---|---|---|
| 1 | `onchain` | providers, from RPC reads decoded by this server | « Confirmé on-chain » | `chain_verified` (≥ 2 endpoints agree) · `chain_single_source` |
| 2 | `creator_metadata` | resolver, from the URI the chain / contract gives | « Métadonnée du créateur » | `creator_declared` |
| 3 | `indexed` | DAS (compressed NFTs, holder hints), EVM indexer (discovery hints) | « Indexé par … » | `indexer_reported` |
| 4 | `market` | market source (Magic Eden, when on) | « Marché — mis à jour à … » | `market_reported` |
| 5 | `computed` | nothing in delivery 1 (no rarity, no valuation) | « Calculé par SP Wallet » | `computed` |

Consequences, all tested: an indexer's owner is a *hint* — the token account is then read on-chain, and when it cannot be,
the owner is shown as indexed, not as chain truth; an indexer's EVM list is re-read on-chain item by item; a marketplace's
"owner" is the `seller` of the market snapshot, a different field from the on-chain holder (an escrow); a collection *name*
is never copied from an item or from an index — only from the collection's own account / contract; a transfer is never
shown as a sale and no price is derived from one; a refresh of the metadata cannot change ownership, identity or collection.

## 2. Canonical model v1 — `packages/nft/src/model.ts`

- `key = family:chainId:assetId` (`nftKey`, `parseNftKey`), deterministic: `sol:solana:<address>`,
  `evm:<network>:<contract lower-case>/<token id decimal>`. Never a name, an image or a symbol. Two spellings of one token id
  (`1`, `0x1`) give one key; the same id in another contract or network gives another.
- Every chain integer is a decimal **string** (token id up to 2²⁵⁶−1, quantity, supply, slot, block, price in base units).
- `Known<T>` = `known(value)` | `none` (the chain says there is none) | `unknown(reason)` (could not be established) |
  `unsupported` (the standard has no such notion). Zero is a value.
- `NftAsset`: identity (standard, mint / contract / token id, program, extensions or Core plugins), `quantity` (units held by
  the wallet — `0` for an asset it only looked up), `supply`, `collection` {key, id, `verifiedOnChain: Known<boolean>`, name},
  `updateAuthority`, `creators` (with `verified`), `royaltyBps`, `ruleSet`, `metadata` (on-chain name / symbol apart from the
  creator's name, description, attributes — raw document kept beside the normalised fields — status, error code, source and
  resolved URI, content hash, mutability, `traitStatistics: {computed: false, reason}`), `media[]` (opaque proxy ids),
  `ownership` {state, owner, token account, frozen, delegate, pNFT record state, `heldByWallet`}, `market`, `capabilities`,
  `sources[]`, `origin` (`discovered` | `manual` | `lookup`).
- `capabilities`: `viewable`; `transferable: false` (a literal in v1) with `transferBlockedBy[]` — the real reasons of *this*
  asset, most specific first: `not_in_wallet`, `burned`, `ownership_unknown`, `frozen`, `pnft_locked`, `pnft_listed`,
  `pnft_rule_set`, `delegated`, `soulbound`, `compressed_requires_indexer`, `ordinals_requires_ord_aware_send`,
  `unsupported_standard`, and always last `transfer_not_built`; `marketActions: false`.
- `NftEvent`: stable id `<assetKey>|<tx>|<index>`, type (mint, transfer, transfer-in / -out, burn, unknown; sale / list / offer
  types exist in the model and are never produced without a market source that links a payment), `interpretation` {by, note},
  from / to, quantity, `price: null` unless proven, finality, source.

## 3. Providers — `services/api/src/nft/provider.ts`

`NftDataProvider` {`chains()`, `inventory(chain, owner, {manual, max})`, `lookup(chain, ref, wallet)`, `events(asset, cursor)`,
`collection(chain, id)`}. A provider fills the on-chain part of an asset and only *points* at the creator's metadata
(`metadata.sourceUri`, status `not_loaded`); it never reads the database and never sees the session. Its JSON-RPC transport
is injected (`RpcFn`), which is how the tests replay recorded answers.

- **`solana.ts`** — inventory in three independent sections: `token` (`getTokenAccountsByOwner` on both token programs →
  0-decimal, amount-1 accounts → mint + Metadata PDA + Edition PDA in batches of 33 mints, pNFT token records), `core`
  (`getProgramAccounts` with memcmp key + owner → decoded assets, their collections in one batch), `compressed` (DAS
  `searchAssets`). Lookup of any address: Core asset / collection / closed asset; token account → its mint; mint → NFT or
  `fungible_token`; no account → DAS (`getAsset`) or `not_found`. The holder of a mint: `getTokenLargestAccounts`, else the
  indexer's owner as a hint verified by reading that owner's associated token account, else unknown. Events: Core
  instructions on the asset (mint / transfer / burn decoded from the discriminator and account order; anything else kept as
  `unknown`), or the pre / post token balances of the transactions of the mint and of the current token account (`partial`,
  and said so). A whole public inventory of 63 NFTs costs 16 RPC calls.
- **`evm.ts`** — `eth_getCode`, ERC-165 (`0x80ac58cd`, `0xd9b67a26`), `ownerOf` / `tokenURI` or `balanceOf` / `uri` /
  `totalSupply(id)`, `name()` / `symbol()`, each on every endpoint; disagreement fails closed (`provider_disagreement`). A
  contract that declares ERC-721 is one only if `ownerOf` answers; one that answers without declaring is `evm-nonstandard`.
  Inventory: `indexer` section (hint list re-verified on-chain, or `blocked_by_provider`) and `manual` section. Events:
  `Transfer` / `TransferSingle` / `TransferBatch` logs of the token over the most recent window the endpoints accept.
- A chain with no provider answers `unsupported` — `inventory: 'unsupported'`, `nft_unsupported_chain`.

## 4. Resolver and media proxy — `resolver.ts`, `safe-fetch.ts`, `packages/nft/src/{uri,netguard,sniff,metadata}.ts`

1. **URI** (`resolveUri`): `https://` as written; `ipfs://<cid>/…` and `ipfs://ipfs/<cid>/…` → every configured gateway in
   order; `ar://<id>/…` → the Arweave gateway(s); `data:application/json` decoded inline (on-chain metadata), `data:image/*`
   for media. Refused with a code: `http:` and every other scheme, credentials, a port other than 443, dot segments,
   over-long URIs. ERC-1155 `{id}` → 64 lower-case hex digits, no `0x` (EIP-1155). The source URI is stored as written; the
   URI actually read is stored beside it.
2. **Fetch** (`safeFetch`), per hop: URL checks → host resolved **once** → every address must be public unicast
   (`classifyAddress`: loopback, RFC 1918, link-local, CGNAT, cloud metadata `169.254.169.254` / `100.100.100.200` /
   `fd00:ec2::254`, multicast, reserved, documentation; IPv6 forms embedding IPv4 — mapped, compatible, NAT64, 6to4, Teredo)
   → connection **pinned** to the validated address (`https.request` with `lookup` returning it, `agent: false`, TLS for the
   host name, the socket's remote address re-checked) → no cookie / authorization / referrer, `accept-encoding: identity`,
   byte cap enforced while reading, one deadline for the whole chain. Redirects are followed by hand, at most 3, each
   target through the same steps.
3. **Metadata**: ≤ 256 kB, depth ≤ 12 checked before parsing, ≤ 20 000 nodes; normalised (`name`, `description`,
   `external_url` kept only if http(s), `image`, `animation_url`, `properties.files`, every entry of `attributes` — duplicates
   and malformed ones included, raw kept); text cleaned of control and bidi-override characters, never interpreted as HTML.
   Cached 24 h (15 min for a failure) in `nft_metadata`; "refresh metadata" bypasses the cache at most once a minute per NFT.
4. **Media**: each media URI is registered under an **opaque id** (`m` + 40 hex of a SHA-256). The browser asks
   `GET /api/v1/nfts/media/<id>` — never a third party. The proxy serves only registered ids (an asset of the inventory or
   one the owner looked up): there is no URL parameter, it is not an open proxy. On first request the file is fetched
   (≤ 25 MiB), **sniffed** (`decideMedia`: PNG, JPEG, GIF, WebP, AVIF, SVG, MP4, WebM, MP3, WAV, Ogg, M4A, HTML, GLB; anything
   else `unsupported_type`; a file announced as image / video / audio whose bytes are another kind → `mime_mismatch`), stored
   in the cache directory, and served with the sniffed type and headers that make it inert: `X-Content-Type-Options: nosniff`,
   `Content-Disposition: inline; filename="nft-….ext"`, `Cross-Origin-Resource-Policy: same-origin`, a restrictive
   `Permissions-Policy`, and its own CSP:
   - image / video / audio (SVG included): `sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'`
   - HTML: `sandbox; default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`
   - HTML with `?run=1` (the owner's explicit action): the same with `sandbox allow-scripts` and
     `script-src 'unsafe-inline' 'unsafe-eval' data: blob:; worker-src blob:`.
   A proxied document therefore has an opaque origin even when opened directly: no cookie, no storage, no access to the
   wallet's origin, no network, no top navigation, no form, no popup.
5. **Budgets**: 90 outbound requests per minute (memory) and a daily budget of requests and bytes (`nft_budget`); a media
   cache capped in bytes (LRU eviction) and in idle time.

### The app's own CSP: unchanged

No directive of the application's CSP was changed. `img-src 'self' data:` already covers proxied images; video and audio fall
under `default-src 'self'`; the sandboxed frame's source is this origin (`frame-src` falls back to `default-src 'self'`). The
two headers that would forbid the frame — `frame-ancestors 'none'` and `X-Frame-Options: DENY`, sent on every response — are
replaced **on the proxied HTML document only** by `frame-ancestors 'self'` and `SAMEORIGIN`; the wallet's own pages still
cannot be framed (asserted in the Playwright spec).

### Rendering (`apps/web/src/screens/Nft.tsx`)

Name, description, traits: text nodes. Links: http(s) only, host shown, `rel="noreferrer noopener nofollow"`. Images (SVG
included): `<img>`. Video / audio: `<video controls preload="metadata">`, `<audio controls preload="none">`, no autoplay.
HTML: locked placeholder → "Afficher sans scripts" (`<iframe sandbox="">`) or "Exécuter ce contenu"
(`<iframe sandbox="allow-scripts" src="…?run=1">`), `allow=""`, no `allow-same-origin` ever. Blocked content is a labelled
placeholder with the reason. 3D models: not displayed.

## 5. Service, persistence, API

- `service.ts`: synchronisation per chain (sections saved in `nft_sync`; an asset no longer returned by a **complete,
  successful** section has left the wallet; a truncated or failed section proves nothing), creator metadata resolved within a
  per-sync budget (60) and kept across syncs, ownership re-read on-chain when an item is opened and its last verification is
  older than 60 s, market snapshot kept 5 min, freshness recomputed at read time (on-chain / indexed data older than 15 min
  → « donnée possiblement périmée »).
- Tables (one block of `db.ts`): `nft_assets`, `nft_sync`, `nft_collections`, `nft_metadata`, `nft_media`, `nft_events`,
  `nft_event_scan`, `nft_manual`, `nft_budget`. All caches except `nft_manual`. Retention (`pruneNft`, loop `nft-prune`
  every 6 h): lookups 7 days, NFTs that left 30 days, their events with them, expired metadata + 30 days, media idle 30 days
  or beyond the size cap, budgets 14 days.
- Routes, owner session only, zod-validated, no owner address accepted anywhere:
  `GET /api/v1/nfts` (chain, collection, status, q, sort, cursor, limit ≤ 100) · `GET /nfts/item?key=` ·
  `GET /nfts/activity?key=&cursor=&type=&more=1` · `GET /nfts/collections` · `GET /nfts/collection?key=` ·
  `GET /nfts/capabilities` · `GET /nfts/receive` · `POST /nfts/lookup` · `POST /nfts/sync` ·
  `POST /nfts/refresh-metadata` · `POST|DELETE /nfts/manual` · `GET /nfts/media/:id[?run=1|info=1]`.
  Errors: `nft_<code>` with `data: {source, code, detail}` — never a URL, a key or a body.
- The portfolio total is untouched: NFTs contribute no amount; the list answers `valuation: {state: 'unavailable'}` and the
  screens say « valeur non disponible ».

## 6. What delivery 2 (transfers) plugs into — DONE, see `NFT-TRANSFERS.md`

*(Kept as written before delivery 2. What changed in the model: `capabilities.transferable` is a boolean — true when no
fact blocks —, `transfer_not_built` is no longer produced, `capabilities.transferWarnings` exists, and the item route
answers a `transfer` verdict that also reflects the signer's NFT policy. Capabilities are recomputed from the stored facts
each time an asset is read.)*

- `capabilities.transferBlockedBy` is the list delivery 2 refines: each reason other than `transfer_not_built` is a fact
  that must **still** block (or route to a specialised builder: pNFT through Token Metadata + rule set, Core through
  `TransferV1`, compressed through a proof); `transfer_not_built` disappears per standard as its builder lands.
- Before an intent: re-read with the quorum rule (`rpcQuorum`), not the display reads; the model's `ownership`, `tokenProgram`,
  `ruleSet`, `extensions` (`nonTransferable`, `transferHook`, `permanentDelegate`, Core `PermanentTransferDelegate`…) are
  the fields the builders need — they are already decoded on-chain.
- The review screen must be built from on-chain identifiers (`key`, mint / contract / token id, quantity), not from
  `metadata.name` or the image (brief §13) — the model keeps them apart for that reason.
- New intent types and signer validators live in `packages/core/src/intent.ts` / `services/isolated-signer` — not touched here.
- Bitcoin: the Ordinals-safe coin selection of `NFT-AUDIT.md` §4, with the `ord` adapter.

## 7. What delivery 3 (market) plugs into

`NftMarketSnapshot` (listed, asking price, seller, best offer, last sale, collection floor — each `Known`, each in base units
of an exact currency) and the event types `sale`, `list`, `delist`, `offer`, `cancel-offer`, `accept-offer`, `escrow` already
exist. A market adapter implements `{supports(asset), snapshot(asset)}` (`market.ts`); writes are a different interface that
does not exist yet, by design. The `escrow` transfer-block reason and ownership state are reserved for a source that can say
an on-chain holder *is* a marketplace escrow.
