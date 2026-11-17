# SP Wallet — NFT audit (delivery 1, 2026-11-17; transfer column and §4 updated by delivery 2, same day)

Audit of the repository as it is on branch `v11` (commit `e325d1b`) before any NFT code, required by `NFT-BRIEF.md` §3. The
code is the source of truth; where an older document says otherwise, the code wins and the difference is noted.

## 1. What was read

README, `docs/adr/0001-custody.md`, `docs/threat-model/threat-model.md`, `docs/security/acceptance.md`,
`docs/contributing/adding-a-chain-family.md`, `docs/V11-ARCHITECTURE.md`, `docs/v11/UI-ARCHITECTURE.md`;
`packages/core/src/{networks,families,tokens,address,build-sol,build-btc}.ts` and `plugins/**`;
`services/api/src/chains/**` (adapters, `rpc.ts`), `services/api/src/{server,auth,db,worker,config,capabilities,signer-client,main}.ts`;
`apps/web/src/{App,ui,hooks,api,i18n,nav}.ts(x)`, screens `Assets`, `Asset`, `Receive`, `Send`, `Activity`; the logo handling
(`icons.tsx`: bundled, sanitised SVG — no remote image is ever loaded by the app); the CSP in `server.ts`; test conventions
(`services/api/test/test-db.ts`, recorded fixtures, `tests/e2e`, `scripts/dev-stack.sh`).

## 2. Findings that shape the NFT work

| Subject | What the code does today | Consequence for NFTs |
|---|---|---|
| **NFT support** | None. No table, route, type, screen or text mentions an NFT, an inscription or a collectible. Solana balances read `getTokenAccountsByOwner` but keep only allow-listed mints; EVM reads only allow-listed ERC-20 contracts. | Everything is new. Nothing may be inferred from "native transfers work". |
| **Wallet addresses** | The signer derives one address per network and reports them in `GET /status` (`signer-client.ts`); `server.ts` keeps the last answer in memory and in `settings.signerAddresses` for when the signer is unreachable. No route takes an owner address from the client. | The NFT module reads the same source (`nft/index.ts → signerAddresses()`); no NFT route accepts an owner address (tested). |
| **Chain reads** | `rpcAny` (first endpoint that answers) for display, `rpcQuorum` (all must agree) for what feeds a signature. Two public keyless endpoints per network (`networks.ts`), a third possible through `SPW_RPC_EXTRA`. | Delivery 1 is display only: each NFT read is asked of every endpoint and marked `chain_verified` when they agree, `chain_single_source` otherwise. Delivery 2 must use the quorum rule before a transfer. |
| **Deposit detection** | `worker.ts scanDeposits` → per-adapter `deposits()` with a cursor in `scan_cursor`; allow-listed assets only. | Not reusable for NFTs (unknown mints / contracts). NFT inventory is its own synchronisation with its own tables. |
| **Auth** | One owner, passkey session cookie (`__Host-spw`, SameSite=Strict), CSRF header + Origin on non-GET, global hook in `server.ts`; API keys only under `/api/v1/trading/`. | NFT routes live under `/api/v1/nfts` → owner session only, API keys refused (tested). |
| **CSP** | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws…; object-src 'none'; frame-ancestors 'none'` + `X-Frame-Options: DENY` on every response. | NFT media can be shown **without changing the app's CSP**: images, video and audio come from this origin's proxy (`'self'`); the sandboxed HTML frame is same-origin for `frame-src` (falls back to `default-src 'self'`). Only the proxied HTML *document* overrides `frame-ancestors` / `X-Frame-Options` for itself. |
| **Database** | One idempotent `SCHEMA` string of `create table if not exists` / `alter table … add column if not exists`, run at start (`migrate()`). No down-migrations anywhere. | The NFT tables are one additive block. "Reversible" here means: they are caches, and `drop table nft_*` loses nothing that cannot be read again (the manual list excepted — 1 row per tracked NFT). |
| **Workers** | `loop(name, fn, everyMs)` in `worker.ts`, started from `main.ts` when `SPW_WORKERS` allows; heartbeat in `loopStats`. | Two loops, `nft-sync` and `nft-prune`, started by the NFT module itself through the same `loop`. |
| **Interface** | V11: five areas (Accueil · Marchés · Négocier · Agents · Activité); Home is the Dashboard; Assets is reached from Home; first chunk ≈ 262 kB, one lazy chunk per screen; texts in `i18n.ts` (two languages side by side, split per language at build). | NFT screens are one lazy chunk in the **Home** area, opened from a row at the top of Assets. Prefix `nf` was free in `i18n.ts`. |
| **Bitcoin sends** | `chains/btc.ts utxoAdapter.prepare`: confirmed UTXOs sorted by value, largest first, taken until the amount + fee is covered; change to the wallet's own address. The signer rebuilds the transaction from those inputs. **Nothing knows about ordinals.** | See §4 — a safety limitation recorded here and on the Receive screen. |

## 3. The real matrix — 23 networks

Legend: **yes** implemented and tested · **partial** · **no** absent · **blocked** blocked by provider · *tbc* to confirm.
"NFT detectable" is what the wallet's own endpoints (no key) can establish **today** (measured 2026-11-17, `NFT-SOURCES.md`).
The first three columns describe the wallet before this delivery; the last four, after it.

| Network (family) | Address | Balance | Tokens (allow-list) | NFTs detectable — source | NFT display | NFT transfer | Market actions |
|---|---|---|---|---|---|---|---|
| Solana (sol) | yes | yes | yes (26) | **yes** — token accounts (Token + Token-2022) → Token Metadata / pNFT: on-chain; Metaplex Core: `getProgramAccounts` on `api.mainnet-beta.solana.com` (refused by `solana-rpc.publicnode.com` → **blocked** if only that endpoint answers); compressed: DAS on `api.mainnet-beta.solana.com` (indexed; **blocked** without a DAS endpoint) | **yes** | **yes** (delivery 2) — Token-2022 with accounted-for extensions, Token Metadata, programmable NFT, Core; **no** for compressed NFTs (`compressed_transfer_not_supported`) and plain SPL tokens | no |
| Ethereum (evm) | yes | yes | yes (43) | **blocked** — no keyless discovery (wallet-wide `eth_getLogs` refused); direct lookup and manual add **yes** (ERC-721, ERC-1155, on-chain) ; with `NFT_EVM_INDEXER_URLS`: indexer hint + on-chain verification | **yes** (looked-up / tracked) | **yes** (delivery 2) — ERC-721 and ERC-1155 `safeTransferFrom`; no approval, no batch, no non-standard contract | no |
| Base (evm) | yes | yes | yes (35) | **blocked** — same | **yes** | **yes** (delivery 2) — same | no |
| Arbitrum One (evm) | yes | yes | yes (32) | **blocked** — same (one endpoint accepts ≤ 30 000-block wallet-wide log queries on recent blocks only: not an inventory) | **yes** | **yes** (delivery 2) — same | no |
| Polygon PoS (evm) | yes | yes | yes (18) | **blocked** — same | **yes** | **yes** (delivery 2) — same | no |
| Optimism (evm) | yes | yes | yes (23) | **blocked** — same (≤ 10 000 recent blocks on one endpoint) | **yes** | **yes** (delivery 2) — same | no |
| BNB Smart Chain (evm) | yes | yes | yes (27) | **blocked** — same | **yes** | **yes** (delivery 2) — same | no |
| Avalanche C-Chain (evm) | yes | yes | yes (16) | **blocked** — same | **yes** | **yes** (delivery 2) — same | no |
| HyperEVM (evm) | yes | yes | yes (6) | **blocked** — same | **yes** | **yes** (delivery 2) — same | no |
| Bitcoin (btc) | yes | yes | — | **blocked** — Ordinals need an ord-aware indexer; no keyless one exists (Hiro shut down 2026-03-09; `ordinals.com` answers a bot challenge); no adapter in this version | no | **no** (no Ordinals transfer: `ordinals_transfer_not_supported`) — since delivery 2 ordinary sends keep away from locked / ord-reported / heuristically flagged outputs (§4) | no |
| Litecoin (btc) | yes | yes | — | no adapter (LTC ordinals exist: *tbc*, not planned) | no | no | no |
| Dogecoin (btc) | yes | yes | — | no adapter (doginals: *tbc*, not planned) | no | no | no |
| Bitcoin Cash (bch) | yes | yes | — | no adapter (CashTokens NFTs: *tbc*) | no | no | no |
| Stellar | yes | yes | — | no adapter (no NFT standard read) | no | no | no |
| XRP Ledger | yes | yes | — | no adapter (XLS-20 `NFTokenPage`: *tbc*, candidate for a later delivery) | no | no | no |
| TRON | yes | yes | yes (2) | no adapter (TRC-721: *tbc*) | no | no | no |
| Aptos | yes | yes | — | no adapter (Digital Asset standard: *tbc*, brief §17.4) | no | no | no |
| Cosmos Hub | yes | yes | — | no adapter (no NFT module on the Hub) | no | no | no |
| Sui | yes | yes | — | no adapter (objects: *tbc*, brief §17.4) | no | no | no |
| NEAR | yes | yes | — | no adapter (NEP-171: *tbc*) | no | no | no |
| TON | yes | yes | — | no adapter (TEP-62: *tbc*, brief §17.4) | no | no | no |
| Cardano | yes | yes | — (ADA only) | no adapter (native assets / CIP-25, CIP-68: *tbc*, brief §17.4) | no | no | no |
| Polkadot Asset Hub | yes | yes | — (DOT only) | no adapter (`nfts` pallet: *tbc*) | no | no | no |

A network "without adapter" answers `unsupported` — in the API (`inventory: 'unsupported'`, `nft_unsupported_chain` on a
lookup) and on the screen ("Non pris en charge") — never an empty inventory.

Standards really covered by this delivery (read): Solana **Metaplex Token Metadata** (NonFungible, editions),
**programmable NFT** (token record: unlocked / locked / listed, rule set, delegate), **Token-2022** mints (extensions listed,
metadata extension read; group / member pointers are listed but not decoded into a collection), **Metaplex Core** (asset,
collection, plugin registry: freeze / transfer / burn delegates, royalties, attributes, immutability), **compressed NFTs** (as
the DAS index reports them — not verified against the merkle tree); EVM **ERC-721**, **ERC-1155** (exact quantities), and
contracts that answer `ownerOf` without declaring ERC-721 (`evm-nonstandard`, display only).

## 4. Safety limitation found: Bitcoin sends are not inscription-aware

`services/api/src/chains/btc.ts` selects the wallet's confirmed UTXOs largest-first until the amount and fee are covered; the
signer checks that every input belongs to the wallet and that change returns to it — it has no notion of which satoshi carries
an inscription. An inscription sent to the wallet's Bitcoin address sits in an ordinary (typically 330–10 000 sat) UTXO: a later
ordinary send that needs that UTXO — a "send max", or any send once the larger UTXOs are used — spends it, and the inscribed
satoshi goes to the recipient or to the miners as fee. Nothing warns the owner today.

- **Recommendation (in force with this delivery):** do not receive inscriptions on this wallet's Bitcoin address. The NFT
  Receive screen says so on the Bitcoin address; the capability list says so (`nft_ordinals`).
- **Not changed here:** coin selection and the signer's BTC rules — they are signing matters (delivery 2).
- **Delivery 2 needs:** an ord-aware source (a self-hosted `ord` server: `GET /outputs/<address>` / `/output/<outpoint>` with
  `Accept: application/json`, docs.ordinals.com/guides/api.html); UTXOs that carry inscriptions (or whose status the source
  cannot establish) excluded from ordinary coin selection **in the API and refused by the signer**; a test that an ordinary BTC
  send cannot spend an inscription (brief §15); a dedicated inscription-transfer intent. Until an ord source is configured
  the fail-safe choice for delivery 2 is a signer-side minimum input value for ordinary sends (inscription UTXOs are small),
  stated as a heuristic, not a guarantee.

### Status after delivery 2 (2026-11-17)

Done (`NFT-TRANSFERS.md` §7): (a) an adapter for a self-hosted `ord` server (`NFT_ORDINALS_API_URL`, the documented
`GET /outputs/<address>?type=any`), whose report excludes inscription- and rune-bearing outputs — and outputs it does not know —
from coin selection; (b) a lock list of outpoints owned by the owner, held by the **signer**, changed only with the passkey,
and enforced by the signer on every Bitcoin-style send and THORChain swap (`utxo_locked`); (c) without an ord server, a
heuristic — labelled as such — that keeps outputs of at most 10 000 sat (and outputs of a transaction with an inscription
envelope) out of automatic selection until the owner reviews or locks them; (d) the test the brief demands, at both levels
(`services/api/test/nft-transfer.test.ts`, `services/isolated-signer/test/nft.test.ts`). **Not done**: no inscription is
listed, and no Ordinals transfer exists — Bitcoin NFTs stay "not supported". The "signer-side minimum input value" suggested
above was not built: the signer enforces the explicit lock list instead (a value floor would have blocked ordinary small
coins with no way for the owner to say otherwise). The recommendation stands in a weaker form: avoid receiving inscriptions
here; if one is received, lock its output.

## 5. Scope adjusted to the real architecture

- New pure package `packages/nft` (`@spw/nft`): model v1, URI resolver, address guard, sniffing, metadata normalisation,
  Solana decoders — no I/O, used by the API and the tests. `packages/core` is untouched (it is the signer's dependency).
- Server module `services/api/src/nft/` behind **one** registration line in `server.ts`; tables in **one** block of `db.ts`;
  capability rows through one spread in `capabilities.ts`.
- Web: `apps/web/src/nft.ts` + `screens/Nft.tsx` (one lazy chunk), three routes in `App.tsx`, one row in `Assets.tsx`, one
  `nf` block in `i18n.ts`.
- Untouched, as required: `services/isolated-signer/**`, `packages/core/src/{intent,policy}.ts`,
  `services/api/src/{orders,risk,mandates,agents,mm,quotes,trading-api}/**`.
- Not built in delivery 1 (stated on the screens and in the API): NFT transfer, approvals, any market write; an Ordinals
  adapter; adapters for the 13 other families; rarity / frequency; fiat valuation of NFTs; read equivalents under the trading
  API (`/api/v1/trading`, scope `wallet:read`) — not trivial (spec, OpenAPI and SDK regeneration), left for a later pass.
