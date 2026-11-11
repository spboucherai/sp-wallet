# SP Wallet V2 — Universal Swap Router: implementation status

Updated 2026-11-10. This file records what exists, what is verified, and what is not. Nothing here is aspirational.

## Phase 1 — Repository analysis (done)
| Area | Reality |
|---|---|
| Frontend | Vite + React 19 + Tailwind 4 SPA (`apps/web`), served by the API. Not Next.js (deviation recorded in `docs/security/acceptance.md`). |
| Backend | One Fastify process (`services/api`): passkey auth, chain adapters, transfer lifecycle, worker. PostgreSQL 17. No Redis in use. |
| Signer | Separate process on a separate Mac (`services/isolated-signer`), software keys, HMAC channel through a root LaunchDaemon relay. Verifies a WebAuthn assertion whose challenge is the SHA-256 of the canonical intent, then **rebuilds the transaction itself**. |
| What the signer can express today | Exactly two shapes per network: native transfer, allowlisted token transfer. No contract calls, no approvals, no arbitrary payloads. **This is the wallet's main safety property and swaps must not silently remove it.** |
| Networks | 21 live for send/receive (8 EVM, Bitcoin, Litecoin, Dogecoin, Bitcoin Cash, Solana, TRON, XRPL, Stellar, Aptos, Cosmos Hub, Sui, NEAR, TON). Cardano and Polkadot not implemented. Monero out of scope for this architecture. |
| Tokens | 24 tokens / 64 deployments, generated from issuer docs + CoinGecko + on-chain checks (`packages/core/scripts/gen-tokens.mts`). |
| Tests | ~725 unit/integration tests (vitest), Playwright e2e on a phone viewport. No transaction has ever been broadcast on any network: every broadcast path is untested against a live chain. |
| Deployment | `mld` on MacLustr: API on M2M32c, signer on m6ma. Mainnet, real (small) funds, limits ≈ 50 USD per transfer. |
| Local tooling | No EVM fork tool (anvil/hardhat) installed; no testnet funds. |

## Phase 2 — Core infrastructure
| Module | State | Where |
|---|---|---|
| Universal asset registry (A) / network registry (B) | reuses the wallet's verified registry; assets are identified by network + contract, never by symbol | `packages/core`, `packages/swap/src/types.ts` |
| Provider abstraction | done, tested | `packages/swap/src/types.ts`, `runtime.ts` (deadline, circuit breaker, rate limit, p50/p95/p99) |
| Parallel quote aggregator (D) | done, tested (concurrent, streaming, per-provider isolation, structural validation of every answer) | `aggregator.ts` |
| Liquidity graph (E) | done, tested (capability edges select what to quote; only live quotes become routes) | `graph.ts` |
| Route optimizer (F), three modes, Pareto frontier | done, tested (direct + bounded two-leg routes through a hub on the source or destination network) | `router.ts` |
| Fee & slippage valuation (G), risk engine (H) | done, tested (net of fees not already in the output; "better than market" and peer outliers are high risk) | `risk.ts` |
| Database models, REST + streaming API | pending | — |
| Swap UI (O) | pending | — |

Measured: 3,000 concurrent route searches over three in-process providers complete in well under 8 s on the laptop (see test output). No real-provider latency has been measured yet.

## Phase 3 — Provider integrations
None merged yet. In progress: Odos, KyberSwap, Jupiter, LI.FI, deBridge, THORChain, Maya, Circle CCTP — price discovery only, each with an execution dossier (`docs/swap/providers/`). 0x, 1inch, Rango, Socket require API keys that are not available: not started.

## Phases 5–7 — Execution (not started; blocked on an owner decision)
Executing a swap means the signer must sign something other than a plain transfer. Three classes, by what the isolated signer can verify on its own:
1. **Verified** — the signer rebuilds the whole transaction from the approved intent (candidates: Circle CCTP burn to the wallet's own address on the destination chain; native swaps expressed as a transfer with a memo, e.g. THORChain, where the signer can check the memo's destination and minimum output but not that the vault address is genuine).
2. **Opaque** — aggregator-built calldata / Solana instructions (Odos, KyberSwap, Jupiter, LI.FI…). The signer can only pin the contract, cap the allowance and the amount; whether the output really comes back to the wallet rests on the API's simulation. A compromised API node could then steal up to the per-transfer limit per approval. This is a real weakening of today's guarantee.
3. **Quote only** — shown for price comparison, not executable.

Open decisions for the owner: whether class 2 is acceptable at all, and under which limits; installing a local fork tool for end-to-end execution tests; testnet funds.

## Stop conditions in force (from the V2 brief)
Not done without explicit authorization: deploying V2 to production, enabling swaps on mainnet, changing signer policy, moving real assets.
