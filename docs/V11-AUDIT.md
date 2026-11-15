# SP Wallet V11 — Audit of V10

Audited commit: `a118e3e` (production, 2026-11-11), branch `v11`. Date: 2026-11-15.
Method: code reading with file:line references, plus read-only calls to public provider endpoints.
No order, transaction or production access was part of this audit.

The detailed findings live in three part files; this document is the consolidated view.

| Part | File |
|---|---|
| Derivatives, execution, signer authorization, risk | `docs/v11/audit-parts/derivatives-exec-signer.md` |
| Web ↔ API wiring, swaps and bridges, performance | `docs/v11/audit-parts/web-api-swaps.md` |
| Trading agents, strategies, backtests, market data | `docs/TRADING-AGENTS-AUDIT.md` |

## Baseline checks (run on this checkout, 2026-11-15)

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | ok |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | 123 files, 2 682 tests, all passed (57 s) |
| `node scripts/build.mjs` + `vite build` | exit 0; first chunk 257 kB |
| Playwright e2e | not run in this audit (needs `scripts/dev-stack.sh`; run in Phase I) |

A green suite proves the code does what its tests say. It does not prove any live path: the project's own
documents state that no derivative order was ever accepted on a funded account.

## 1. Really connected

- Wallet: 23 networks, native sends and token sends through the isolated signer (passkey over the canonical intent).
- Swaps with execution: KyberSwap (8 EVM networks), Jupiter (Solana), Circle CCTP V2 (7 EVM networks and Solana),
  THORChain (pinned BTC/LTC/ETH pairs). The signer decodes or rebuilds every transaction it signs.
- Derivative market data: Hyperliquid, dYdX and GMX adapters; all public endpoints answered on 2026-11-15.
- Hyperliquid trading path (build, signer-side reading of the payload, submit, cancel, TP/SL, reduce-only) and
  GMX v2 market increase/decrease on Arbitrum. Both are wired end to end and locked by environment variables.
- Agents: two engines started by the API process, ticking every 60 s without any browser tab, on real data
  (Coinbase/Bitstamp/Kraken for spot, Hyperliquid for perps). Strategies run as sandboxed Python processes.
- Backtester `spq`: 60/20/20 split with sealed test set, trial ledger, deflated Sharpe, look-ahead check,
  exact perp ledger with funding and liquidation.
- Alerts, Web Push, monitoring screen, research job runtime.

## 2. Simulated (and labelled as such)

- Paper accounts for derivatives and paper agents. Paper and live rows share tables (`agent_orders`,
  `agent_equity`, `research_log`); `perp_agent_signals` has no mode column. Views filter by agent, so the mix is
  latent rather than visible, but nothing structural prevents it.
- The derivatives router (`packages/derivatives/src/router.ts`) is a cost simulation, not an execution router.

## 3. Partially integrated

- Venue abstraction: the read side is a real interface (`VenueAdapter`). The trade side is not: the live engine
  is typed for Hyperliquid, and GMX is a second engine with its own table, states and signer file. A new
  tradable venue has no seam.
- dYdX: market data only (terms exclude Canada).
- LI.FI and Maya: quotes only. deBridge: off (licence).
- Funding-carry-neutral strategy: backtest only, since perp agents refuse spot legs.
- Six of eight library perp strategies can never go live: they need HYPE and only BTC/ETH/SOL are pinned.
- Research runner: deployed, no real job verified.

## 4. Working API surface

About 190 routes; every path the web app calls exists. Authentication is the owner's passkey session cookie
through one `onRequest` hook, with CSRF checks and a 240 requests/minute limit per IP.
There is no machine authentication except the research runner's shared secret.

## 5. Backend routes without a caller

`GET /assets`, `/security/devices`, `/transfers/:id/status`, `/swap/stats`, `DELETE /addressbook/:id`,
`GET /agents/:id/withdrawals`, `/derivatives/funding`. About a dozen more are called only by tests or scripts
(`/market-data/status`, `/market-data/candles`, `/plans/capabilities`, `/agents/:id/perp/risk`).

## 6. Frontend not connected

None found: no call to a missing route, no mock data in production paths (mocks load only in dev builds).
What is missing is whole sections: Private Markets and Developer/API do not exist; Risk and Compare exist only
as fragments inside Monitor, Security, Swap and Futures.

## 7. Security findings

| Severity | Finding |
|---|---|
| High | The emergency halt also blocks manual closes, GMX decreases and cancels, and withdrawals. |
| High | Turning `SPW_DERIV_LIVE_MAINNET` or `SPW_DERIV_GMX_LIVE` off also blocks cancels and closes. |
| High | A spot mandate stays valid on the signer after the engine stops the agent; several mandates can be active on one vault. |
| High | The spot loss limit (`maxLossPct`) is enforced by the engine only, not by the signer. |
| Medium | A session can loosen API-side loss limits or lift an API halt without a passkey; these limits also govern mandate orders. |
| Medium | GMX runs with placeholder loss limits (1e9) and no kill switch. |
| Medium | A lost answer from `/venue/authorize` orphans an authorization and locks the account for up to 90 days. |
| Medium | Signer CLI commands write `state.json` under a running daemon without a lock; the daemon's next save undoes them. |
| Medium | The signer journal is unbounded and `state.json` is rewritten in full on each logged request. |
| Medium | A spot strategy can be approved with a failed look-ahead check. |
| Doc | The custody ADR and threat model say every signature needs a passkey. Six signer paths sign without one (mandate orders, vault returns, cancels, first CCTP mint). The documents must describe the real model. |
| Design | One shared HMAC secret authenticates the whole API to the signer. The signer cannot tell the owner from an agent or a future API key; only a signer-enforced mandate bounds a non-owner caller. |

## 8. Performance and resilience

- `rpcQuorum` needs every RPC to answer: one degraded endpoint blocks execution on that network.
- An unreachable signer fails the Home screen entirely.
- CoinGecko's free tier is the only price source for the portfolio; `asOf` is the response time, not the price time.
- No WebSocket to the browser; five SSE streams, of which the swap quote stream has no heartbeat or concurrency cap.
- WebSocket to venues exists for Hyperliquid only. Spot data is REST polling; no order-book history.
- No metrics endpoint; logs are mostly free text. `swap_quotes` is never pruned.

## 9. Incompatibilities between modules

- Four order-state vocabularies (Hyperliquid, GMX, collateral, `deriv_actions`), no transition guard, no history table.
- Three post-execution status shapes for swap, bridge and native swap, plus plan legs.
- `Capabilities` reports `orders: false` for GMX while GMX orders exist.
- The backtest does not apply the engine's sizing rules (exposure cap, per-order and per-day caps), so the
  report shown at approval does not describe what the agent will do.
- Swap, bridge and native-swap proposals answer 409 on a repeated idempotency key; transfers return the proposal.

## 10. Announced but not verified

- No order was ever accepted on a funded Hyperliquid or GMX account. The runbook's expected start-up line shows
  mainnet locks on; the audit did not read production values.
- Jupiter execution is proven by mainnet simulation only; CCTP and KyberSwap on most networks by forks only.
  One real KyberSwap swap and two real sends are recorded on Ethereum.
- Research runtime: no real job has run.
- No library strategy shows an edge (deflated Sharpe ≤ 0.16 spot, ≤ 0.06 perp).

## Functional bugs to fix in Phase B

| Id | Severity | Bug |
|---|---|---|
| B1 | High | On a CCTP pair, "Vous recevez" shows the top comparison quote, not the selected option. |
| B2 | High | With broadcast off, a transfer stays in state `broadcast` and blocks the network with `pending_tx`. |
| B3 | Medium | English server sentences are printed raw in the French UI in about 15 places. |
| B4 | Medium | 409 instead of the existing proposal on a repeated idempotency key (swap, bridge, native swap). |
| B5 | Medium | Because of B4, a crash between proposal creation and plan save leaves a plan stuck. |
| B6 | Medium | The route shown is not the route prepared (server re-quotes); THORChain execution is inferred from stream content. |
| — | Low | GMX orders appear as "send" in Activity; the CSV writes every row as `send`. |

## What V11 must build, in consequence

1. One order state machine with a transition guard and a history table, wrapping the Hyperliquid and GMX engines.
2. A venue seam for trading, so that edgeX and later venues do not become a third and fourth engine.
3. An independent risk engine with a global kill switch that blocks new risk and never blocks a reduction.
4. Machine authentication (scoped API keys) whose execution rights are bounded by signer-enforced mandates.
5. Mode separation (research, paper, live) in the data model.
6. The missing sections of the interface: Markets, Compare, Private Markets, Risk, Developer/API.
