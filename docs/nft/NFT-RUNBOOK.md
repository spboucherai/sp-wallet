# NFT runbook (delivery 1: read-only)

Nothing here can move an asset: the NFT module only reads. Every table it owns is a cache, except `nft_manual` (the owner's
list of tracked NFTs).

## Is it working?

- Start-up log line `capabilities: … nft_inventory=on nft_solana_das=on nft_evm_discovery=OFF(missing NFT_EVM_INDEXER_URLS) nft_ordinals=OFF(off) nft_market_read=OFF(missing NFT_MARKET_MAGICEDEN)` — names only.
- `GET /api/v1/nfts/capabilities` (owner session): per network `inventory` (`supported` | `partial` | `blocked_by_provider` |
  `unsupported`), `sections[]` with `status`, `code`, `unlockedBy`, `syncedAt`; `providers[]`; today's `budget`.
- Monitoring screen: loops `nft-sync` (every 10 min, only chains whose last sync is older than 5 min) and `nft-prune` (6 h).
- Live check without the app: `npx tsx scripts/smoke-nft.mts` (reference item, read-only).

## Limits and quotas

| What | Default | Variable |
|---|---|---|
| items read per section and chain | 500 (reported as `truncated` beyond) | `NFT_INVENTORY_MAX` |
| creator metadata resolved per synchronisation | 60 (the rest loads when opened) | — |
| outbound requests to creators' hosts | 90 / minute; 5 000 / day; 2 GiB / day | `NFT_FETCH_DAILY_REQUESTS`, `NFT_FETCH_DAILY_BYTES` |
| metadata document | 256 kB, depth 12, 20 000 nodes | — |
| media file | 25 MiB | `NFT_MEDIA_MAX_BYTES` |
| media cache | 1 GiB, LRU; idle files 30 days | `NFT_CACHE_MAX_BYTES`, `NFT_CACHE_DIR` |
| route limits (per minute) | lookup 20, manual 20, refresh-metadata 10 (+ 1 / minute per NFT), sync 6, media 240 | — |
| Solana public RPC | free tier: 150 per method, 250 rps (headers observed 2026-11-17) | add an endpoint with `SPW_RPC_EXTRA` |
| Magic Eden (when on) | 120 QPM documented | — |

## A section says `blocked_by_provider`

- Solana `core`: the endpoint that answered refuses `getProgramAccounts`. Add an endpoint that serves it to
  `SPW_RPC_EXTRA` (`{"solana":["https://…"]}`), restart. Core assets can meanwhile be opened / tracked by address.
- Solana `compressed`: no endpoint answers DAS. Set `NFT_SOLANA_DAS_URL` to a DAS provider's URL (its key is part of the
  URL; only the host is ever shown). Compressed NFTs already stored stay visible, marked stale.
- EVM `indexer`: expected without `NFT_EVM_INDEXER_URLS`. Setting it sends the wallet's EVM address to that host — decide
  knowingly. Tracked NFTs (manual list) keep working without it.

## Indexer or RPC outage

A failed section is stored as `error` with its code; the inventory already stored is **kept** and its stamps turn
« possiblement périmé » after 15 minutes; nothing is marked as having left the wallet on a failed or truncated read. The next
loop retries. No action needed unless it lasts: then check `GET /api/v1/health/ready` (`rpcEndpoints`) and the endpoint
itself.

## Rebuild the inventory (reindex)

All caches can be dropped; the next synchronisation rebuilds them from the chains:

```sql
truncate nft_assets, nft_sync, nft_collections, nft_metadata, nft_media, nft_events, nft_event_scan, nft_budget;
-- keep nft_manual: it is the owner's list, not a cache
```
then remove the files of `NFT_CACHE_DIR` and press "synchronise" in the gallery (or `POST /api/v1/nfts/sync`).
Only one NFT: "Actualiser" on its page re-reads its creator metadata (once a minute); opening the page re-reads its ownership.

## Provider key renewal / change

Change the variable, restart the API. No key is stored in the database, a log or a response; stamps keep hosts only.
Rotating a DAS key: nothing else to do. Removing `NFT_EVM_INDEXER_URLS`: the `indexer` section returns to
`blocked_by_provider`; NFTs it had discovered stay until they are seen to leave by a later successful sync — track the ones
to keep (manual list) or reindex.

## Security incident

- A creator's URL behaves badly (huge, slow, hostile): it is already refused / capped per request; to stop all outbound
  fetches set `NFT_FETCH_DAILY_REQUESTS=1` and restart (assets stay listed, media show as unavailable).
- Suspicion on the media cache: delete `NFT_CACHE_DIR` and `truncate nft_media` — files are re-fetched and re-sniffed.
- To turn the whole feature off: `NFT_ENABLED=off` and restart (routes answer `nft_disabled`; the rest of the wallet is
  unaffected; no migration to undo).
- The NFT module holds no key and no signing path: an NFT-side compromise cannot move an asset. Review
  `docs/threat-model/threat-model.md` rows 26–31.

## Known limits of this delivery

No NFT transfer, approval or market action. No Ordinals, and **BTC sends are not inscription-aware — do not receive
inscriptions on this wallet** (`NFT-AUDIT.md` §4). EVM: no automatic discovery without an indexer; activity limited to the
most recent ~1 000 blocks. Solana SPL history is partial (mint + current token account). Compressed NFTs are indexed data,
not verified against their tree. Token-2022 group / member pointers are listed, not decoded into a collection. No rarity, no
valuation. 3D models are not displayed. The 13 other chain families have no adapter.
