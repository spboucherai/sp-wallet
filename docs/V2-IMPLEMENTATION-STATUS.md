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

- 2026-11-10 (night): HyperEVM enabled too. Its router is a reduced variant (no `swapGeneric`, no partial fill); the verifier refuses
  `swapGeneric` and the partial-fill flag there (`reduced: true`). Fork proof: `NATIVE_IN=0.5 npx tsx scripts/fork-swap-net.mts hyperevm`.

## Update 2026-11-11: cross-chain USDC execution through Circle CCTP (EVM ↔ EVM)

**Implemented, not deployed, never run on a real network.** Dossier: `docs/swap/providers/cctp.md` §2 (pins, upgradeability) and §12.

- Scope: USDC between Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche and HyperEVM, always from the wallet to its own
  address. No hooks, no destination caller, no swap leg, no Solana, no EURC.
- Intent: optional `bridge` section (provider, destination network and domain, Circle fee ceiling, finality threshold, pinned
  messenger and transmitter, exact approval). Intents without it hash exactly as before.
- Signer: builds the exact-amount approval and `depositForBurn` itself (no provider calldata exists on this path); policy as
  for a send. It records the approved bridge and later signs **one** `receiveMessage` whose message bytes are exactly that
  burn (route, token, amount, fee ceiling, wallet as burner and recipient, no hook, no destination caller), to the pinned
  transmitter, under the destination fee ceiling. An identical request returns the same bytes; any further signature needs
  the owner's passkey over the new parameters. New narrow route `POST /bridge/mint`. No limit was raised.
- Pins: both proxies (one bytecode hash for all networks), the implementation address **and** bytecode hash behind each,
  the minter; checked on both RPC sources before preparing and before minting. An upgrade by Circle stops transfers on that
  network until the new implementation is reviewed (`node scripts/cctp-pins.mts`). The proxy admins are addresses without
  code and there is no timelock: recorded as a trust statement in the dossier.
- API: `kind: 'bridge'` proposals, `bridge` column, routes `/api/v1/bridge/{execution,quote,proposals,proposals/:id/finish,
  proposals/:id/retry-mint[/options]}`, worker loop every 5 s, audit events `bridge.*`. Refuses to burn when the destination
  holds no gas for the mint. Resumable from the database and the signer's state file; the mint has no deadline.
- Web: USDC → USDC across networks in the Swap screen (speed, Circle fee, expected time, gas needed on the destination,
  progress, "finish"); bridges listed in Activity with the same progress and action. FR/EN.
- Tests: `packages/core/test/cctp.test.ts` (48), `services/isolated-signer/test/bridge.test.ts` (26),
  `services/api/test/bridge.test.ts` (16, scripted chain serving the real mainnet bytecode so the pinned hashes are exercised).
- Not changed: the KyberSwap path, signer limits, existing checks. The CCTP quote adapter still labels Solana and EURC routes
  quote-only.
- Fork proof (`npx tsx scripts/fork-cctp.mts <source> <destination>`, two anvil forks, fresh keys, 2026-11-11), every enabled
  network once as source and once as destination, all checks passing: base→arbitrum (49), arbitrum→ethereum (49),
  ethereum→optimism (49), optimism→polygon (49), polygon→avalanche (46), avalanche→hyperevm (46), hyperevm→base (45; fewer
  checks where Circle offers no Fast from the source). Measured gas: approval ≈ 55 500, burn ≈ 109 000–111 500, mint ≈ 171 300.
  Polygon needs `FORK_RPC_POLYGON=https://polygon.drpc.org` (the first registry endpoint refuses archive reads).
  **A real Circle attestation cannot exist for a fork-only burn**: on the destination fork two test attesters are enabled
  through the impersonated attester manager and a local stand-in signs the fork's own message. Circle's real service is
  exercised read-only (public messages fetched and their signatures checked against the on-chain attester set).
- Not verified: any transfer on a real network; the real "our burn → Iris message" pairing; re-attestation of an expired
  Fast message; the Standard fee switch; recompilation of Circle's contracts; the screens in a browser. Full list: dossier §12.8.
- Operational note: with the signer's current fee ceilings a mint on Ethereum is refused when 240 000 gas × (2 × base fee + tip)
  exceeds 0.005 ETH (base fee above roughly 10 gwei); the transfer is then not started (or waits, if already burned).

## Update 2026-11-10 (V5): swap execution on Solana through Jupiter (Metis)

- Scope: SOL ↔ registry SPL tokens (and token ↔ token) on Solana, exact input, output to the wallet itself. Dossier:
  `docs/swap/providers/jupiter.md` §10.
- Transaction: **Solana v1** (SIMD-0385), built by the API from `GET /swap/v2/build?transactionVersion=1`. **No address
  lookup tables**: the signer refuses legacy and v0 messages, so every account is visible to it.
- Signer (`packages/core/src/swap-sol.ts`, hand-written codec, no Solana SDK): one signer = fee payer = the wallet; fixed
  instruction grammar (own token-account creation, exact wrap, one Jupiter instruction, unwrap to the wallet); Jupiter
  instruction `shared_accounts_route_v2` only, with the twelve fixed accounts derived, exact `in_amount`, minimum
  `floor(quoted × (10 000 − bps) / 10 000)` ≥ the approved one, no platform or positive-slippage fee, wallet absent from
  the route accounts; fee + rent bound ≤ approved ceiling; intent commits to the SHA-256 of the message.
- **`route_v2` is excluded**: venue programs act with the wallet's signature and the declared source account binds nothing
  (a USDT route re-declared as USDC executes in simulation). The API rewrites direct routes into the shared-accounts form
  and keeps them only if they simulate; otherwise it asks for another route (≤ 3 calls) or refuses
  (`route_not_verifiable`).
- Program pin (`JUPITER_PIN`): ProgramData last-deploy slot 462802085, upgrade authority, executable SHA-256; checked on
  both RPC endpoints before preparing. The program is upgradeable and its source was not read: residual trust, stated in
  the dossier.
- API (`services/api/src/swap-exec-sol.ts`): `kind: 'swap'` proposals on `solana` in the existing table/worker; simulation
  of the exact bytes before approval and of the signed bytes before sending; expiry without sending = failed, nothing
  moved; outcome from the confirmed transaction's balance tables; audit `swap.prepared` / `swap.not_sent` / `swap.settled`.
  `chains/sol.ts` now reads transactions with `maxSupportedTransactionVersion: 1`.
- Web: Solana routes executable in the Swap screen, labelled "Jupiter (Metis)"; review sheet with route, network fee,
  priority fee, token-account deposit, simulated output. FR/EN.
- Tests: `packages/core/test/swap-sol.test.ts`, `services/isolated-signer/test/swap-sol.test.ts`,
  `services/api/test/swap-sol.test.ts`, on ten recorded mainnet answers (`packages/core/test/fixtures/jupiter-exec/`).
- Proof without funds: `npx tsx scripts/sim-jupiter.mts` (mainnet `simulateTransaction` only).
- Not changed: EVM paths, signer limits, existing checks. `intent.ts`: provider enum gains `jupiter`, a Jupiter swap is only
  valid on a Solana network. No new dependency; `dist/signer.mjs` 2 573 229 → 2 586 739 bytes (+13 510, +0.5 %).
- Not verified: anything sent to a real network; see the dossier §10.9.

## Update 2026-11-11 (V6): native cross-chain swaps executed through THORChain

- Enabled: BTC and LTC (native SegWit) ↔ ETH / USDC / USDT / DAI / WBTC on Ethereum, BTC ↔ LTC, and DOGE as a destination.
  Not enabled, with reasons (dossier `docs/swap/providers/thorchain.md` §11): DOGE as source (fee ceiling), BCH, Base /
  Avalanche / BSC (other router builds, sources not read), Cosmos / XRP / TRON / Solana, streaming swaps, Maya Protocol
  (two public operators only: `maya.md` §8).
- The vault address cannot be verified offline. Design (dossier §10): the intent commits to the vault **public key**, the
  address and the memo; the signer derives the address from the key, rebuilds the memo (destination = the wallet's own
  address, limit ≥ approved minimum, no affiliate / refund override / streaming) and the transaction (UTXO: vault, change,
  `OP_RETURN`; Ethereum: pinned router `depositWithExpiry`, exact approval), then **asks five pinned THORNode operators
  itself** and signs only if at least three answer and every one that answers lists the key as an active vault on a chain
  that is not halted, at the same churn height and about the same block height. What remains trusted: simultaneous
  compromise or collusion of all operators that answered, TLS, THORChain itself. The API is out of the trust path.
- `packages/core/src/thorchain.ts` (tables, memo builder and strict parser, 1e8 conversions, vault key → address,
  `checkThorVault`, builders), `intent.ts` (`xswap` section, hashed), `services/isolated-signer/src/vaults.ts` + a branch in
  `signer.ts`, `services/api/src/xswap.ts` + `xswap-state.ts` (`POST /api/v1/xswap/proposals`, approval through the usual
  `/transfers/proposals/:id/approve`, relay gate, tracking worker), proposals column `xswap`, kind `xswap`,
  `apps/web/src/xswap.tsx` (review sheet with the vault address and the residual trust stated, progress
  sent → observed → outbound → received / refunded).
- UTXO adapter: `prepare` accepts `thor: { extraBytes, minRate }` (memo bytes, THORChain's fee rate within the wallet's
  cap, change always returned). Existing builders refuse an `xswap` intent. No limit raised, no check weakened.
- Tests: `packages/core/test/thorchain.test.ts`, `services/isolated-signer/test/xswap.test.ts`,
  `services/api/test/xswap.test.ts` (database `spw_test_xswap`). Proof without funds: `npx tsx scripts/sim-thorchain.mts`
  (live read-only operator checks, a signed and decoded Bitcoin transaction that is not broadcast, router deposits on an
  anvil fork).
- Signer: new outbound hosts `gateway.liquify.com`, `api-thorchain.rorcual.xyz`, `thorchain.ibs.team`,
  `thornode.thorwallet.org`, `lcd-thorchain.keplr.app`. No new dependency; `dist/signer.mjs` 2 618 075 → 2 643 913 bytes
  (+25 838, +1.0 %).
- Not verified: anything sent to a real network — no real swap, outbound or refund; see the dossier §12.

