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

## NFT transfers (delivery 2)

**Policy keys** — on the SIGNER machine, `policy.json`, optional key `nft` (absent = the defaults; `policy.json` is never
rewritten by a release; an unknown key refuses to start):

```json
"nft": { "enabled": { "ethereum": ["erc721", "erc1155"], "solana": ["metaplex-core"] }, "maxTransfersPerDay": 5,
         "maxErc1155Quantity": "10", "allowlistOnly": false, "maxComputeUnits": 400000, "maxComputeUnitPrice": "2000000" }
```

Defaults: the two EVM standards on the 8 EVM networks, the four Solana standards on Solana, 5 transfers per UTC day, 10
units per ERC-1155 transfer, allow-list off. The fee ceiling is the existing `maxFee[network]`. Restart the signer after an
edit; the app shows the values in force (`GET /api/v1/nfts/transfer/verdict`, signer status → `nft.policy`). To switch NFT
transfers off entirely: `"nft": { "maxTransfersPerDay": 0 }`, or `"enabled": {}`.

**Allow-list mode** (`"allowlistOnly": true`): an NFT can only go to a destination the owner approved with the passkey
(`POST /api/v1/nfts/allow/prepare` → passkey → `/approve`); the list lives in the signer's state and is shown by
`GET /api/v1/nfts/allow`. Recommended as soon as the wallet holds an NFT of value: it turns "any address" into "an address
approved earlier".

**A refusal**: the item page and the Send form show the code-specific sentence; every code is listed in
`NFT-TRANSFERS.md` §8. `signer_bad_approval` on approve = the stored intent is not what the passkey signed (tampering, or a
stale page): start again. `signer_nft_daily_count`: wait for the next UTC day or raise the key. `nft_transfer_rpc_disagreement`
/ `ownership_single_source`: an endpoint is down or behind — nothing is prepared on one answer; add a third endpoint
(`SPW_RPC_EXTRA`) or wait.

**Incident — an NFT was sent to the wrong address.** It is irreversible: no key of this wallet can bring it back, and no
one can cancel a confirmed transfer. What to do: (1) `POST /api/v1/security/halt` (or the signer CLI `halt`) if a compromise
is suspected — it stops every further transfer; (2) read the signer journal (`nft.sign.ok`: proposal id, intent hash,
asset, destination, txid) and the audit log (`nft.transfer.prepared`) to establish what was approved and when; (3) compare
the intent hash of the journal with the proposal's `intent_hash` in the database — a difference means the API or its database
was tampered with; (4) if the destination is a known party, ask them; nothing else exists. Afterwards consider
`allowlistOnly`.

**Bitcoin protected outputs.** Screen: Assets → NFT → Receive → Bitcoin → « Sorties Bitcoin protégées ». Lock / unlock an
output: passkey each time; the SIGNER then refuses any send that spends it (`utxo_locked`). With `NFT_ORDINALS_API_URL` (a
self-hosted `ord` with its address index): outputs it reports with an inscription or a rune — or does not know — are never
selected; if it is unreachable, Bitcoin sends answer `ord_unavailable` (unset the variable to fall back to the heuristic).
Without it: outputs ≤ 10 000 sat are kept aside by a heuristic until declared ordinary coins on that screen. A send that
answers `insufficient_unlocked_funds` needs one of the protected outputs: review or unlock it deliberately. Locks on outputs
that no longer exist are listed as stale and can be removed. **No inscription can be transferred by this wallet.**

## Known limits of this delivery

No approval or market action. NFT transfers: `NFT-TRANSFERS.md` §6 and §10 (no compressed NFT, no Ordinals transfer, no
batch); never executed on a real network. BTC sends are inscription-safe only for outputs that are locked, reported by an
ord server, or small (heuristic) (`NFT-AUDIT.md` §4). EVM: no automatic discovery without an indexer (arrivals are detected
on contracts the wallet already knows); activity limited to the
most recent ~1 000 blocks. Solana SPL history is partial (mint + current token account). Compressed NFTs are indexed data,
not verified against their tree. Token-2022 group / member pointers are listed, not decoded into a collection. No rarity, no
valuation. 3D models are not displayed. The 13 other chain families have no adapter.

## Market sources and keyed providers (delivery 3)

**Where the keys live.** `OPENSEA_API_KEY` and `ALCHEMY_API_KEY` belong in the PM2 environment of `sp-wallet` on the **API
node** and in the `env` block of its `mld` manifest — never on the signer node, never in the web bundle, never in a commit
or a log. The API reports variable NAMES only (`GET /api/v1/nfts/market/providers`, the capability list, the monitor).
Alchemy's key travels in the URL path: no Alchemy URL is ever logged, stored or reported by the NFT module
(`evm-hints.ts`); do not add such a URL to `SPW_RPC_EXTRA` without the same care in `chains/rpc.ts`.

| I want | Set | It sends |
|---|---|---|
| market data (Solana + 7 EVM networks) | `OPENSEA_API_KEY` | the contract + token id / mint of each item opened |
| Magic Eden's own orders (Solana) | `NFT_MARKET_MAGICEDEN=on` — read its API terms page in a browser first | the mint of each Solana item opened |
| EVM auto-discovery | `NFT_EVM_PROVIDER=alchemy` + `ALCHEMY_API_KEY` (enable each network in the Alchemy dashboard), or `NFT_EVM_PROVIDER=opensea` | **the wallet's EVM address** |
| OpenSea key set but no market read | `NFT_MARKET_OPENSEA=off` | nothing |

**Is it working?** `npx tsx scripts/smoke-nft-market.mts` (with the variables in the environment) prints what each source
answers for the reference item, the request counters, and — with `--evm-address <a public address>` — what the EVM
provider answers per network. Assets → NFT → "Sources de marché" shows the same states.

**Quotas.** The wallet allows itself 30 requests / minute and 5 000 / day towards OpenSea (observed header: 120), 40 /
minute towards Magic Eden (documented: 120). A refused request is not sent: the panel shows the last answer marked
"possiblement périmée" (for at most 24 h), then "erreur de la source (budget_exhausted)". The day's count survives a
restart (`nft_budget`, source `market:<provider>`). An item costs 5 OpenSea requests, a collection 3; answers are kept
2 – 10 minutes.

**A source is down or rate-limits.** Nothing to do: the other sources, the item page and the ownership are unaffected; the
source's row says `provider_unavailable` / `provider_rate_limited`. A 429 pauses that provider for a minute.

**A network says "network not enabled for this key".** Enable it in the provider's dashboard; the next synchronisation
uses it. No restart, no change of SP Wallet.

**Empty the market cache** (a provider asks for deletion; a wrong figure is shown): `delete from nft_market_cache;` and,
to forget the marketplaces' collection names, `delete from nft_market_slug;`. Both are caches.

**Key renewal / compromise.** Replace the variable and restart the API; revoke the old key at the provider. An OpenSea
"instant" key expires after 7 days. A leaked Alchemy key exposes the app's quota and the list of addresses it was asked
about — rotate it in the dashboard.

**Do not hand a trading-API key with `markets:read` to a third party while OpenSea is on**: its developer terms forbid
providing API data to third parties (`NFT-SOURCES.md` §10.1).

**The opt-in estimate** (`POST /api/v1/nfts/valuation {enabled}`; audit event `nft.floor_estimate`) is a display setting:
it changes no total.
