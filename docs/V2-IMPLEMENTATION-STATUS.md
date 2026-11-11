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
| REST + streaming API | done, tested: `/api/v1/swap/{assets,providers,stats,quote,quote/stream}`; sender and recipient are always the wallet's own addresses taken from the signer; `/swap/execute` answers 423 | `services/api/src/swap.ts` |
| Database | `swap_quotes` (every provider answer: latency, output, error code) feeding `/swap/stats` (p50/p95/p99 per provider). Route/intent/execution tables: pending with execution | `services/api/src/db.ts` |
| Swap UI (O) | done for price discovery (FR/EN, phone-first): asset pickers with search, live streamed routes, three modes, route details (steps, fees, risk flags), execution visibly disabled. Verified in the Playwright run with no provider wired | `apps/web/src/screens/Swap.tsx` |

Measured: 3,000 concurrent route searches over three in-process providers complete in well under 8 s on the laptop (see test output). No real-provider latency has been measured yet.

## Phase 3 — Provider integrations (price discovery, real APIs, recorded fixtures)
| Provider | State | Notes |
|---|---|---|
| KyberSwap | live, 8 EVM networks | keyless "legacy" endpoint, 3 req/s; executable on Base (see below) |
| Jupiter (Metis) | live, Solana (incl. Token-2022 PYUSD/USDG) | keyless 5 req/10 s; licence: must be labelled "Metis"; quote sends the wallet's Solana address |
| LI.FI | live, 12 networks incl. Bitcoin, Sui, TRON | keyless quota 75 requests / 2 h: used only for direct cross-chain requests; a key is needed for normal use |
| Circle CCTP | live, USDC between 8 networks (+ EURC on 3) | quote only; strongest candidate for signer-verified bridging |
| THORChain | live, 12 networks | single public gateway, slow (2–5 s) and sometimes stale; quote only |
| Maya | live, 3 networks | quote only |
| deBridge | adapter present, **disabled** | its API licence forbids "aggregation purposes"; enable only after review (`SPW_SWAP_ENABLE=debridge`) |
| Odos | not integrated | service shut down 2026-07-30 (`docs/swap/providers/odos.md`) |
| 0x, 1inch, Rango, Socket | not started | need API keys |

## Phase 5 — Execution
**Implemented and deployed: KyberSwap same-chain swaps on Base.**
- The signer decodes the router calldata (ABI from the verified source) and enforces: pinned router, source and destination
  token from the registry, exact input amount, recipient = the wallet itself, minimum output ≥ the approved minimum, no fee
  receivers, no permit, exact-amount approval, exact value. The router (source read on Base) reverts unless the recipient's
  balance of the output token rises by at least that minimum, so the route bytes in between cannot redirect value.
- API: fresh on-chain-liquidity route, calldata built for the wallet's own address, router bytecode hash checked on both
  RPC sources, refusal if the wallet address carries code (EIP-7702 delegation), nonce agreement, node gas estimate as
  simulation, signer policy pre-check, one swap or transfer in flight per network. Token input: the exact approval is mined
  first, then the swap is simulated again and only then sent; if that simulation fails the swap is not sent.
- Evidence: `scripts/fork-swap-kyber.mts` (signer level) and `scripts/fork-swap-api.mts` (full stack) execute real routes on
  a local anvil fork of Base — ETH→USDC, USDC→ETH (with approval), USDC→LINK — and check balances, leftover allowance (0)
  and refusals (tampered calldata, other recipient, other token, lower guarantee, unpinned router, disabled network).
- **Not yet proven: a swap on the real network.** The first real one is the owner's, with a small amount.
- Other EVM networks: not enabled. The router bytecode differs per chain (and in size on HyperEVM); each needs its verified
  source read before its hash is pinned in `KYBER_ENABLED`.
- Not implemented: cross-chain execution (CCTP, LI.FI, THORChain), Solana swaps (Jupiter), refunds/recovery engine,
  multi-leg routes.

## Stop conditions in force (from the V2 brief)
The owner authorized on 2026-11-10: deploying V2, real-money execution including provider-built transactions, and installing a local fork tool. Still not done without asking: raising signer limits, moving real assets on the owner's behalf.

## Update 2026-11-10 (late evening): execution enabled on six more EVM networks

KyberSwap same-chain execution is now enabled on Ethereum, Arbitrum, Polygon, Optimism, BNB Chain and Avalanche, in addition to Base
(`KYBER_ENABLED` in `packages/core/src/swap-evm.ts`, one pinned runtime-bytecode hash per network).

- Evidence: verified sources on the seven explorers compared (same router logic as Base; Arbitrum, Polygon, Optimism and Avalanche
  byte-identical to Ethereum, BNB identical once comments are stripped); runtime bytecode of the six equals Ethereum's except three
  occurrences of the wrapped-native immutable; `scripts/fork-swap-net.mts <network>` executed native → stablecoin → native on a fork
  of each of the six. No real swap has been broadcast on any network yet.
- HyperEVM stays disabled: a different, cut-down router (solc 0.8.17, no partial fill, no `swapGeneric`) that needs its own review.
- Not recompiled from source; "verified" rests on the explorers. The router owner address was not checked per chain. The owner
  could abuse a standing allowance (`swapGeneric` + whitelist): approvals are exact-amount and consumed by the swap, never unlimited.
- New signer check: simple-mode calldata may not spend the native coin (the router skips its msg.value check in that mode).
- Signer fee ceilings are unchanged; on Polygon a complex route at a high gas price can exceed 0.5 POL and is then refused.
- Agent mandates remain Base-only (`MANDATE_NETWORKS`).
- Still not built: cross-chain execution, Solana (Jupiter) execution, native BTC/THORChain execution.
