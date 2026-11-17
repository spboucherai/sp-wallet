# SP Wallet

Private, single-owner, self-hosted multi-chain wallet and trading workstation — `wallet.spboucher.ai`, hosted on MacLustr.

**Status (2026-11-17).** Production runs **V10** (`a118e3e`). **V11 is built, validated locally and not deployed**
(`docs/V11-DEPLOYMENT.md`). Nothing of V11 was ever executed on a funded derivative account, mainnet or testnet; every
live path is proven on the real signer code against scripted venues, on anvil forks, or on paper.

## What it is

- **Wallet.** 23 networks in the registry (eight EVM chains, Bitcoin and the UTXO family, Solana, Tron, XRPL, Stellar, TON, Sui, Aptos, NEAR,
  Cosmos, Cardano, Polkadot), native coins and registry tokens (`docs/TOKENS.md`). Transfers, swaps (KyberSwap, Jupiter,
  THORChain, native routes), bridges (CCTP), any-to-any plans. One owner, passkey only (WebAuthn, user verification
  required): no password, no signup, no recovery by e-mail.
- **Derivatives.** Hyperliquid and GMX v2 (read, paper, and live behind server locks that are off by default); edgeX and
  dYdX as **market data only** (their terms exclude Canada).
- **V11 adds:** a unified order service with one risk engine and one kill switch; trading mandates; a trading API
  (41 operations, API keys with scopes, TypeScript and Python SDKs); a websocket quote stream; a markets explorer and
  cost comparator; private-markets display; an agents runtime (bar, stream and supervisor agents; research, paper, live)
  bound to a strategy laboratory (`research/`); market making on paper, and live behind four locks and a quoting mandate;
  a new five-area interface (Home · Markets · Trade · Agents · Activity).
- **UI.** Phone-first PWA, French / English, dark / light.

> A software hot wallet on a home cluster, not an HSM. Read `docs/adr/0001-custody.md` and
> `docs/threat-model/threat-model.md` before raising any limit. No strategy of the laboratory shows an out-of-sample
> edge, and the market-making evidence is negative (`docs/V11-REMAINING-LIMITATIONS.md` §0).

## How anything is authorized

```
phone (passkey) ──HTTPS──▶ API (node A) ──HMAC, LAN──▶ isolated signer (node B, holds the keys)
```

The API drafts an operation and freezes it into a canonical **intent** whose SHA-256 is the challenge the passkey signs.
The signer — a separate process on a separate machine — verifies the assertion against the passkey public key it pinned
at setup, re-checks its own limits, expiry, replay cache and halt flag, **rebuilds the transaction from the intent** and
signs once. A stolen session, a compromised API node or a tampered database cannot produce a signature for a transfer.

Seven paths sign **without** a per-operation passkey, each under something the passkey approved earlier (a mandate, an
authorization, an approved burn) and inside bounds the signer enforces itself: they are listed, with what a compromised
API can do through each, in `docs/adr/0001-custody.md`. The risk engine, the kill switch and the server locks are
API-side: they bound an honest API, not a compromised one.

## NFTs (inventory, secure transfer, market READ — deliveries 1 to 3 of `docs/nft/NFT-BRIEF.md`)

Assets → **NFT**: gallery, collection and item pages, each value with its source (on-chain / creator metadata / indexed /
market) and its freshness. **Send** (delivery 2): one NFT transfer = one passkey approval over a canonical NFT intent; the
isolated signer builds the transaction itself (ERC-721 / ERC-1155 `safeTransferFrom`; Solana Token-2022, Token Metadata,
programmable NFT, Core) inside its NFT policy — no approval, no operator approval, no batch, no calldata from the API. An
asset that cannot be sent shows its exact reason. **No NFT can be approved, listed or bought from the wallet**; the market
controls are shown disabled with the reason. NFT transfers were proven on local forks and a local validator only —
**never executed on a real network** (`docs/nft/work/nft-2.md`). Media never load from a third party: they pass through a server-side proxy
(SSRF-safe fetch, content sniffing, sandboxed responses). NFTs add nothing to the portfolio total: their value is
"unavailable", not zero and not a floor price.

| Network | Discovery (what the wallet holds) | Item page (lookup / tracked) | Activity | Send | Market |
|---|---|---|---|---|---|
| Solana | Token Metadata, pNFT, Token-2022: on-chain · Metaplex Core: on-chain (needs an endpoint serving `getProgramAccounts`) · compressed: DAS index | yes (any mint / Core asset; compressed through DAS) | Core: on-chain; SPL: partial; compressed: no | **yes**: Token-2022 (accounted-for extensions only), Token Metadata, pNFT (unlocked, undelegated), Core (not frozen). **No**: compressed, plain SPL | read-only, optional (`NFT_MARKET_MAGICEDEN`) |
| Ethereum, Base, Arbitrum, Polygon, Optimism, BNB Chain, Avalanche, HyperEVM | **blocked without an indexer** (`NFT_EVM_INDEXER_URLS`); add by contract + token id, verified on-chain | yes (ERC-721, ERC-1155 with exact quantity); arrivals detected on known contracts after finality | recent blocks only | **yes**: ERC-721, ERC-1155 (quantity). **No**: non-standard contracts | link to the marketplace only |
| Bitcoin | no (inscriptions are not listed). Ordinary BTC sends keep away from outputs locked with the passkey (refused by the signer), reported by an ord server (`NFT_ORDINALS_API_URL`), or — without one — flagged by a heuristic (≤ 10 000 sat; not a detection) | no | no | **no** (no Ordinals transfer) | no |
| Litecoin, Dogecoin, Bitcoin Cash, Stellar, XRP Ledger, TRON, Aptos, Cosmos Hub, Sui, NEAR, TON, Cardano, Polkadot | not supported (no adapter) | no | no | no | no |

**Market data (delivery 3) is read-only.** With a key or a setting, each market source answers on its own row — asking
price, best offer, last sale, collection floor, each in its own currency with source and age; without one, every market
field reads "unavailable" with its reason and the variable that would turn it on (`OPENSEA_API_KEY`,
`NFT_MARKET_MAGICEDEN`). EVM auto-discovery needs `NFT_EVM_PROVIDER` (Alchemy or OpenSea; hints re-verified on-chain).
**No market write exists**: buy, sell, list, offer, accept and cancel are disabled with the reason; the decision document
for a first one is `docs/nft/NFT-MARKET-WRITES.md`. Five NFT read operations are in the trading API and both SDKs.

Details: `docs/nft/NFT-AUDIT.md` (matrix and audit), `NFT-TRANSFERS.md` (transfers: intents, what the signer verifies,
policy keys, per-standard matrix, threats, rollback), `NFT-SOURCES.md` (sources, quotas, terms, variables),
`NFT-ARCHITECTURE.md`, `NFT-ADDING-A-PROVIDER.md`, `NFT-RUNBOOK.md`, `nft.env.example`. Smoke: `npx tsx scripts/smoke-nft.mts`.

## Layout

| Path | Role |
|---|---|
| `packages/core` | network / asset registry, exact amounts, canonical intents and hashes, transaction builders, policy, audit hash chain |
| `packages/swap`, `packages/derivatives` | swap and bridge providers; venue adapters (Hyperliquid, GMX, edgeX, dYdX), live canonical forms, paper engine |
| `packages/trading` | canonical order, order state machine, risk checks, mandates, command grammar, market-making rules (pure) |
| `packages/nft` | NFT canonical model, URI resolver, address guard (SSRF), content sniffing, Solana NFT decoders — pure, read-only |
| `packages/trading-sdk`, `sdk/python` | client SDKs of the trading API (not deployed) |
| `services/isolated-signer` | keystore, key derivation, passkey verification, policy and mandate enforcement, signing; CLI |
| `services/api` | Fastify API: auth, chains, transfers, swaps, derivatives, order service, risk, mandates, trading API, quote hub, agents runtime, market making, monitoring; serves the web app |
| `services/research-runner` | sandboxed runner of research jobs |
| `research/` | the strategy laboratory (Python, `uv`): backtester, strategies, studies, committed results |
| `apps/web` | Vite + React + Tailwind PWA |
| `tests/` | software passkey helper, Playwright e2e |
| `scripts/` | build, dev stack, preflight, backup, fork proofs, read-only smokes, rollback rehearsal |

## Commands and checks

```bash
pnpm install --frozen-lockfile
(cd research && uv sync --frozen)      # the laboratory's virtualenv: without it the lab suites are skipped
pnpm typecheck
pnpm test                              # 194 files, ~4 500 tests; needs local PostgreSQL (databases are created per file)
pnpm build                             # dist/api.mjs, signer.mjs, research-runner.mjs, agents.mjs, dist/web/
(cd research && uv run pytest)         # the laboratory
(cd sdk/python && uv run ruff check && uv run pytest)
npx vitest run packages/trading-sdk
node scripts/gen-openapi.mts --check   # + gen-types.mts --check, gen_models.py --check, gen_sync.py --check

scripts/dev-stack.sh                   # local stack on http://localhost:8650: throwaway keys, broadcast OFF, paper
pnpm e2e <spec>                        # Playwright (Chromium, virtual passkey); each spec's header says which stack it needs
scripts/dev-stop.sh

npx tsx scripts/smoke-*.mts            # read-only checks against public endpoints
node scripts/fork-*.mts                # execution proofs on local anvil forks (one at a time)
scripts/preflight.sh                   # on the API node, before a deployment (read-only)
```

What was run for V11, with every result including the failures: `docs/v11/work/final-validation.md`.

## Signer CLI (on the signer machine)

```bash
node signer.mjs status           # key id, addresses, limits, journal integrity, mandates (no secrets)
node signer.mjs export-recovery  # interactive terminal only: prints the 24 words once, for paper backup
node signer.mjs halt | unhalt    # emergency stop / resume — since V11 applied by the running daemon at once
node signer.mjs reset-passkeys && node signer.mjs setup-token   # lost passkey: re-run owner setup
```

Limits live in `~/sp-wallet-signer-data/policy.json` on the signer machine. A deployment never deletes that file.

## Map of the documents

| To know | Read |
|---|---|
| What V11 is, as built | `docs/V11-ARCHITECTURE.md` |
| What is not done, not verified, or refused | `docs/V11-REMAINING-LIMITATIONS.md` |
| How to deploy, what the owner must authorize, how to roll back | `docs/V11-DEPLOYMENT.md`, `docs/runbooks/deploy.md`, `docs/runbooks/operations.md` |
| What was tested and how far | `docs/V11-TEST-RESULTS.md`, `docs/TRADING-TEST-RESULTS.md`, `docs/v11/work/final-validation.md` |
| What can be enabled, and in which order | `docs/TRADING-PRODUCTION-READINESS.md` |
| Custody, threats, security review | `docs/adr/0001-custody.md`, `docs/threat-model/threat-model.md`, `docs/V11-SECURITY-REVIEW.md`, `docs/security/acceptance.md` |
| Orders, risk, mandates | `docs/V11-EXECUTION-ENGINE.md`, `docs/V11-RISK-MODEL.md`, `docs/TRADING-RISK-ENGINE.md`, `docs/TRADING-MANDATES.md` |
| Trading API and SDKs | `docs/TRADING-API-ARCHITECTURE.md`, `docs/TRADING-API-SECURITY.md`, `docs/TRADING-API-OPENAPI.md`, `docs/sdk/` |
| Venues, markets, quotes, private markets | `docs/V11-EXCHANGE-INTEGRATIONS.md`, `docs/V11-QUOTE-ENGINE.md`, `docs/V11-SYNTHETIC-MARKETS.md`, `docs/v4/venues/` |
| Agents, laboratory, market making | `docs/TRADING-AGENT-ENGINE.md`, `docs/TRADING-BACKTESTING.md`, `docs/V11-MARKET-MAKING.md`, `research/README.md` |
| Interface | `docs/v11/UI-ARCHITECTURE.md`, `docs/v9/DESIGN.md` |
| The audit V11 started from | `docs/V11-AUDIT.md`, `docs/TRADING-AGENTS-AUDIT.md` |
| Each workstream's own note | `docs/v11/work/*.md`; earlier versions: `docs/v2` … `docs/v10`, `docs/V2-IMPLEMENTATION-STATUS.md` |
