# SP Wallet V11 — test results

Evidence compiled from the work notes (`docs/v11/work/*.md`), each written by the workstream that ran the tests. Counts
are **as reported in the note named in the last column**, on the branch and date of that note; no suite was run to write
this page. The final run on the merged tree is a placeholder at the end, to be filled by the main session.

Three statements frame everything below:

1. **No live order was ever sent.** No test, script or person of V11 sent an order, a cancel, a transfer or any signed
   action to a venue or a chain. No funded account, no testnet account and no real key was used by any workstream.
2. **The signer changes are proven on the real signer code against fake venues**: the real `Signer` class (in process or
   as a local process on a temporary directory, public test mnemonic), a scripted Hyperliquid, a scripted Arbitrum chain.
3. **What ran against real external systems is read-only public market data**, listed in section 3.

Evidence levels used in the tables:
**U** unit / pure · **I** integration on a real local server + PostgreSQL with scripted or recorded venues ·
**S** real signer code in the loop, fake venue · **R** recorded real venue answers replayed · **L** live read-only call to
a public endpoint · **B** real browser (Chromium) · **F** anvil fork (V10 evidence, not re-run in V11).

---

## 1. Full-suite runs reported during V11 (`pnpm test`)

| When (branch) | Files | Tests | Result | Note |
|---|---:|---:|---|---|
| Audit baseline (`v11` at `fe705be`) | 123 | 2 682 | all passed (57 s) | `docs/V11-AUDIT.md` |
| `v11-stab-signer` | 124 | 2 727 | all passed | `stab-signer.md` |
| `v11-stab-swaps` | 127 | 2 763 | all passed | `stab-swaps.md` |
| `v11-trading-api` | 126 | 2 731 | 2 672 passed, 59 skipped (lab); the swap-quotes flaky test failed in 2 of 3 runs | `trading-api.md` |
| `v11-edgex` | 126 | 2 728 | 2 668 passed, 59 skipped, 1 failed (lab interpreter absent in the worktree) | `edgex.md` |
| `v11-sdks` | 133 | 2 882 | 2 822 passed, 59 skipped, 1 failed (same cause) | `sdks.md` |
| `v11-markets-compare` (merged with `v11`) | 155 | 3 782 | 3 721 passed, 59 skipped, 2 failed (SDK generated types behind the contract) | `markets-compare.md` |
| `v11-exec` | 147 | — | 3 521 passed, 59 skipped, 1 failed (flaky swap-quotes test) | `exec.md` |
| `v11-agents` | 150 | 3 669 | all passed (lab present) | `agents.md` |
| `v11-exec2` | 164 | — | 3 798 passed, 59 skipped, 3 failed (2 SDK contract, 1 flaky) | `exec2.md` |
| `v11-contract` Part 2 | 171 | 4 066 | 4 007 passed, 59 skipped, 0 failed | `contract-resync.md` |
| `v11-mm-core` | 169 | — | 4 041 passed, 59 skipped, 4 failed (3 SDK contract / lab, 1 flaky) | `mm-core.md` |
| `v11-agents-bind` | 173 | 4 017 | 4 012 passed, 5 failed (3 SDK contract, 1 flaky, 2 own — fixed and re-run in their files) | `agents-bind.md` |
| `v11-quotes` merged with `v11` | 185 | 4 344 | 4 342 passed, 2 failed (30 s timeouts under load; both pass alone) | `quotes.md` |
| **`v11-contract2` (the tip that became `v11`), six runs** | 185 (182 + 3 skipped) | 4 350 | three runs clean: **4 283 passed, 67 skipped**; three runs with one or two failures: swap-quotes log race (×2), key usage-log race (×1) — given bounded polls in `23c0a23` — and `agent-worker-process` timeout (×1, **not fixed**) | `contract-resync.md` Part 3 |

`pnpm typecheck`: exit 0 in every note. Skipped tests are the laboratory and sandbox suites, gated on `research/.venv`
existing in the checkout.

Laboratory (`research/`, `uv run pytest`): **406 collected, 404 passed, 2 skipped** (live-network tests) —
`quant-lab.md`. Python SDK: 391 passed (350 unit + 41 integration) at Part 2; unit tests also pass on Python 3.10 —
`contract-resync.md`. TypeScript SDK: 147 passed (125 unit + 22 integration) at Part 2; stream tests 14 (TypeScript) and
6 + 1 (Python) at Part 3.

---

## 2. Per module

### 2.1 Signer and stabilisation (Phase B)

| Test file | Count | Level | Proves | Note |
|---|---:|---|---|---|
| `services/isolated-signer/test/venue.test.ts` (extended) | — | S | under halt only a reduce-only order is signed, with the passkey; the trigger band; the stored authorization answered again without a new signature | `stab-signer.md` §1, §5, §7 |
| `…/venue-gmx.test.ts` (extended) | — | S | GMX decrease and cancel signed under halt (calldata decoded); an intent that calls itself a decrease but is not is refused | §1 |
| `…/mandate.test.ts` (extended) | — | S | a second mandate on a vault is refused; revocation is idempotent and needs no passkey | §3 |
| `…/store.test.ts` (new) | 16 | S | journal file, rotation, crash between the two writes, torn line, old-format state read and migrated, rollback to the pre-V11 binary and forward again, state lock, control socket | §6 |
| `…/prices.test.ts` (extended) | — | U | Kraken quote used only while `online` and fresh | §10 |
| `services/api/test/derivatives-live.test.ts`, `derivatives-mandate.test.ts`, `derivatives-gmx.test.ts`, `perp-agent-live.test.ts`, `agent-networks.test.ts` (extended) | — | I + S | locks off: cancel, cancel-all and reduce-only close still work; recover / adopt / revoke of an orphaned authorization; passkey to loosen limits and lift halts; GMX loss limits and kill switch; spot mandate revoked on stop | §2–§9 |
| Signer CLI by hand, temporary directory | — | manual | `init`, `halt` / `unhalt` with and without a daemon, second `serve` refused, lock released on SIGTERM | "Verification observed" |

Not covered: `main.ts` (CLI wiring) by an automated test; closed journal segments at start; the resume / re-base passkey
step in a browser.

### 2.2 Swaps, bridges, transfers

| Test file | Count | Level | Proves | Note |
|---|---:|---|---|---|
| `services/api/test/v11-stab.test.ts` | 29 | I | `not_broadcast` state and migration; idempotent preparation (fingerprint, mismatch, lost race); quote reference (`quote_moved`, mismatch); server codes; RPC ejection; price freshness; quote pruning | `stab-swaps.md` |
| `packages/swap/test/card.test.ts` | 7 | U | normalized route card, real values only | §7 |
| `packages/swap/test/keyed-comparison.test.ts` | 10 | U, **documentation-derived fixtures** | 0x and 1inch adapters parse what the documentation shows | §9 |
| `apps/web/test/v11-stab.test.ts` | 17 | U | hero = what is executed; codes translated in both languages | §1, §5 |
| `api.test.ts` (+5), `bridge.test.ts` (+4), `xswap.test.ts` (+4), `plan-exec.test.ts` (+3), `swap-sol.test.ts` (+2) | 18 | I (scripted chains, Circle, THORChain) | replay answers the same proposal with no provider call; **restart tests**: CCTP burn → restart → mint → restart → reconciled, one mint signature across three processes; THORChain outbound across a restart | §3, §8 |

Not covered: any browser run of the Swap, Home, Activity and plan screens; a KyberSwap HTTP-level test of the quote
reference; a Solana-source CCTP replay test; **any live call to 0x or 1inch**.

### 2.3 Venues, markets hub, comparator, private markets

| Test file | Count | Level | Proves | Note |
|---|---:|---|---|---|
| `packages/derivatives/test/edgex/adapter.test.ts`, `stream.test.ts` | 27 + 10 | R (recorded 2026-11-15/16) | edgeX adapter and websocket; error paths (429, HTML body, timeout, 5xx) | `edgex.md` |
| `services/api/test/derivatives-edgex.test.ts` | 9 | I + R | routes; jurisdiction refusals (403, no request reaches the venue); isolation when edgeX throws or hangs | `edgex.md` §3 |
| `packages/trading/test/symbols.test.ts`, `cost-pool.test.ts` | 10 + 8 | U + R | symbol normalisation on the four real lists; pool execution hand-checked | `markets-compare.md` |
| `services/api/test/markets-hub.test.ts` | 23 | I + R | per-venue budget (cold hang → 503, warm hang → stale last-good); explorer; comparator with two hand-checked totals | §2, §3 |
| `apps/web/test/markets.test.ts` | 22 | U | helpers, reason codes equal to the server's, read-only sheet has no order control | §4 |
| `packages/derivatives/test/hyperliquid/builder-dexes.test.ts` | 18 | R (2026-11-16 00:42–00:44 UTC) | builder dexes read side | `private-markets.md` |
| `services/api/test/private-markets.test.ts` | 26 | I + R | review states (fingerprint mismatch, `validUntil` passed, unknown, excluded); routes | §2, §5 |
| `apps/web/test/private-markets.test.ts` | 23 | U on live-recorded answers | components, i18n | §6 |
| `packages/trading/test/implied.test.ts` (in a package of 641 tests at that date) | — | U | unsourced valuation unit → no valuation | §4 |

### 2.4 Trading core, execution, risk, mandates

| Test file | Count | Level | Proves | Note |
|---|---:|---|---|---|
| `packages/trading/test/{canonical,state,idempotency,vocabulary,risk,mandate,commands,cost,docs}.test.ts` | part of 641 | U, property tests | canonical order, the transition table, idempotency, the legacy vocabularies, the risk checks, mandate `checkOrder` and compilers, the command grammar | `private-markets.md` §4 (count); `docs/V11-EXECUTION-ENGINE.md` |
| `services/api/test/execution-unit.test.ts` | 9 | U | projection of every engine state (11 Hyperliquid, 12 GMX, 7 paper) | `exec.md` |
| `…/execution-paper.test.ts` | 17 | I, paper engine, real key over HTTP | store refuses illegal transitions; paper end to end; idempotency; 22 limit cases each denying with its check; kill switch; read-only; mandate refusals field by field; 23 owner routes closed to a key; restart | `exec.md` |
| `…/execution-live.test.ts` | 12 | I + S (scripted Hyperliquid) | `SPW_TRADING_API_EXECUTION` off by default; a key's order signed under the mandate; each lock refuses with its code; ambiguous submission → UNKNOWN → reconciled or `NEVER_PLACED`; restart; a replay sends nothing | `exec.md` |
| `…/enforcement-pin.test.ts` | 7 | S, **no API check in front of the signer** | which mandate fields the signer alone refuses, and which it signs although the trading mandate forbids them | `exec2.md` §1 |
| `…/execution-exec2-paper.test.ts`, `execution-exec2-live.test.ts` | 11 + 11 | I + S | full-hash binding and seven row alterations; provenance; one principal per account; preview vs creation; gate reuse; 288 command × scope cases; `instrument_status`, `signer_status`, `venue_connection`, `drawdown` denials; automatic kill; stop conditions; restart in `PARTIALLY_FILLED`; seed of the live limits; rate budget | `exec2.md` |
| `…/execution-spot.test.ts`, `execution-attached.test.ts`, `execution-gmx.test.ts` | 8 + 4 + 6 | I (stand-in swap port; paper; scripted Arbitrum chain) | owner spot orders as unified orders; attached SL/TP on paper; live GMX orders of the owner, keys refused | `exec2.md` §5–7 |
| `tests/e2e/risk.spec.ts` | 1 | B (dev stack, virtual authenticator, paper) | banner, limits form, kill switch engaged → order refused → close still works → release needs the passkey | `exec2.md` §10 |

### 2.5 Trading API and SDKs

| Test file | Count | Level | Proves | Note |
|---|---:|---|---|---|
| `services/api/test/trading-api-unit.test.ts`, `trading-api.test.ts` | 11 + 28 (29 later) | I, real signer process | every route outside `/api/v1/trading/` (> 190) answers 403 to a key holding every scope; scopes; rate limit; throttle; replay; revocation; usage log without secrets; OpenAPI = generated | `trading-api.md` |
| `services/api/test/trading-contract.test.ts` | 21 at Part 2 | I | real answers validate against the declared schemas; agents on paper; refusal shaping over HTTP; rotation and re-binding | `contract-resync.md` |
| `packages/trading-sdk/test/*` | 147 at Part 2 (+14 stream at Part 3) | U + I (shared real stack) | every operation sends exactly the documented request; error mapping; retries; `OutcomeUnknown`; the key never leaks; stream client | `sdks.md`, `contract-resync.md` |
| `sdk/python/tests/*` | 391 at Part 2 (+7 stream at Part 3) | U + I | the same matrix for sync and async; no `float` in a parsed answer; model drift walk | idem |
| `apps/web/test/developer.test.ts` | 10 | U | Developer screen model | `trading-api.md` |
| `tests/e2e/developer.spec.ts` | 1 | B (dev stack) | key created with a virtual passkey, secret shown once, calls without a cookie, refusals, revocation | `trading-api.md` |
| curl transcript against the real local server | 17 steps | manual | the same, by hand | `trading-api.md` |

### 2.6 Agents runtime and laboratory

| Test file | Count | Level | Proves | Note |
|---|---:|---|---|---|
| `services/api/test/agent-runtime-unit.test.ts` | 47 | U | model, modes named in every shared read, performance math (hand-computed), templates, supervisor, module boundaries, nothing can release the kill switch | `agents.md`, `agents-bind.md` |
| `…/agent-migration.test.ts` | 13 | I | migration of a pre-V11 database (twice), mode backfill, stored signals | `agents.md` |
| `…/agent-workers.test.ts` | 24 | I | leases, job queue (retries then dead-letter), scheduler isolation, order gateway incl. UNKNOWN never re-sent, kill-switch port, STOP ALL AGENTS | idem |
| `…/agent-worker-process.test.ts` | 2 | I, **real processes from `dist/`** | wrong `SPW_WORKERS` → exit 2; unmigrated database → exit 3; two workers tick each agent once; SIGKILL mid-tick → reaped and re-run | `agents-bind.md` §5 |
| `…/agent-stream.test.ts` | 16 | R (recorded Hyperliquid mainnet frames; second venue **scripted**) | stream engine: gaps, quotes, maker fill, freshness, reconnect, kill switch | `agents.md` §6 |
| `…/agent-trading-api.test.ts` | 12 | I, real key | create, backtest job, start paper, mode-scoped reads, LIVE refused, what a key can never do | `agents.md` §8 |
| `…/agent-bind.test.ts` | 8 | I + real laboratory + R (2 400 recorded hourly bars) | template → backtest → report v3 → paper mandate → signal → three unified orders → one kill switch | `agents-bind.md` (transcript) |
| `…/perp-agent.test.ts`, `perp-agent-live.test.ts` | 29 + 20 | I + S (fake venue) | paper through the order service; live through `submitCanonical` under a trading mandate; kill switch; divergence; server lock | `agents-bind.md` |
| `…/lab-verdicts.test.ts`, `lab-identity.test.ts` | 11 + — | I + lab | verdicts read from committed results; sandboxed output identical | `agents-bind.md` §4 |
| `apps/web/test/agents-v11.test.ts` | 21 | U | panel model | idem |
| `tests/e2e/agents-bind.spec.ts` | 1 | B + L (public Hyperliquid data) | the whole path in a browser, 4.1 min | `agents-bind.md` §6 |
| `research/tests/` (26 files) | 404 passed, 2 skipped | U + R | backtester realism, engine parity, data layer on recorded responses, strategies (purity, look-ahead), report v3 byte-identical | `quant-lab.md` |

### 2.7 Quote engine

| Test file | Count | Level | Proves | Note |
|---|---:|---|---|---|
| `services/api/test/quotes-hub.test.ts` | 27 | U + R (recorded frames of Hyperliquid, edgeX, dYdX, Coinbase) | reference counting, conflation, snapshot / delta / gap with checksum, venue status | `quotes.md` |
| `…/quotes-outbox.test.ts` | 5 | U | backpressure on a controlled socket | idem |
| `…/quotes-stream.test.ts` | 14 | I (real server, real `ws` clients, scripted upstreams) | authentication before the upgrade, Origin, tickets, limits, slow consumer, logout and key revocation close sockets, shutdown | idem |
| `apps/web/test/quotes.test.ts` | 13 | U | one socket per tab, reconnect, fallback, batching, freshness | idem |
| SDK stream tests | 8 + 5 (TypeScript), 9 + 5 (Python) in `quotes.md`; reported as 14 (TypeScript) and "6 passed" + 1 lazy-import test (Python) after `v11-contract2` | U + I + L | header and ticket connections, refusals, live Hyperliquid quotes | `quotes.md` §7; `contract-resync.md` Part 3 |

### 2.8 Market making (core only — not integrated on `v11`)

| Test file | Count | Level | Proves | Note |
|---|---:|---|---|---|
| `services/isolated-signer/test/venue-quoting.test.ts` | 49 | S | every refusal of the quoting mandate individually; exits under halt, revocation, expiry; property: after every accepted batch the worst case stays inside the mandate | `mm-core.md` §1.3 |
| `packages/derivatives/test/hyperliquid/mm-primitives.test.ts` | 36 | U + 22 vectors from the official Python SDK 0.24.0 | builders equal the SDK's action, hash and signature | §1.1 |
| `packages/trading/test/mm.test.ts`, `quoting-mandate.test.ts` | 40 + 3 | U, property tests | never a crossing pair, budget, inventory bound, attribution identity | §1.4, §1.5 |
| `services/api/test/mm-engine.test.ts` | 39 | S + R (36-minute recorded BTC tape, **modelled** fills) | start, quoting, each breaker, lost answers, crash and restart, signer down, out-of-mandate policies stopped by the signer, the three locks | §1.6 |

<!-- PENDING: market-making integration (branch v11-mm-live) — its tests (files, counts), what ran on paper and on recorded tapes, and the explicit statement of what was not run on testnet or mainnet -->

---

## 3. What ran against real external systems (read-only)

| Run | Date (UTC) | Observed | Note |
|---|---|---|---|
| `scripts/smoke-edgex.mts` | 2026-11-16 00:20 | 157 markets (74 crypto, 71 equity, 8 commodity, 3 pre-IPO, 1 fx); exit 0 | `edgex.md` §4 |
| `scripts/smoke-private-markets.mts` | 2026-11-16 01:06 | Hyperliquid 5 instruments, edgeX 3; 8 live instruments, 5 companies; the 10 table entries match the live fingerprints | `private-markets.md` §8 |
| `scripts/smoke-markets-hub.mts` | 2026-11-16 01:19 | 907 rows built in 1.7 s (95 spot, 812 perps); four venues `ok`; BTC totals 12.14 (edgeX), 13.17 (Hyperliquid), 14.84 (dYdX), 21.22 bps (GMX); the script fails on any trading or account endpoint | `markets-compare.md` |
| `scripts/smoke-quotes.mts --seconds 60` | 2026-11-16 03:55 | five venues connected in < 1 s; BTC quotes in 60 s: Hyperliquid 590, Coinbase 303, edgeX 145, GMX 10, dYdX 5; 0 reconnect, 0 gap, 0 checksum mismatch | `quotes.md` §A |
| `scripts/smoke-quotes.mts --load 50x100 --seconds 60` (laptop, clients on the same host) | 2026-11-16 03:56 | 5 000 subscriptions on 156 hub channels and 226 upstream feeds; 574 866 frames (≈ 10 400 / s); API CPU 10.3 % of one core; RSS 188 → 212 MB; 0 conflated, 0 dropped; latency p50 357 ms, p95 560 ms | `quotes.md` §B |
| `tests/e2e/v11-quotes-live.mts` (Chromium, built app, real venues) | 2026-11-16 03:57 | Markets 50 rows / 150 live cells; Hyperliquid upstream cut → its 35 rows « reconnecting », the 15 others live; terminal from the shared socket, 0 SSE request; Compare 3 live prices; Private Markets 8 live prices; websocket refused → polled fallback | `quotes.md` §C |
| Lab data pull and book recording | captured 2026-11-16 00:38; books 00:32–01:39 | 180 days of 1 h candles, no missing bar; 16 order-book recordings at 5 s | `quant-lab.md` §2 |
| Market-making tape | 2026-11-16 03:06–03:42 | 36 minutes of the public BTC feed; three `info` requests on the zero address | `mm-core.md` |
| Kraken public API (`SystemStatus`, `Depth` ×2) | 2026-11-15 | answer shapes for the freshness check | `stab-signer.md` |
| SDK integration and stream tests; `agent-worker-process`; `agents-bind.spec.ts` | 2026-11-15/16 | public market data read by the local stack (paper fills against the public book) | `sdks.md`, `agents-bind.md` |

Browser runs (Chromium only, local stacks): `developer.spec.ts`, `risk.spec.ts`, `agents-bind.spec.ts`,
`v11-quotes-live.mts`, and Private Markets opened by hand at 390 × 844 (French) and 1280 × 900 (English) against
recorded fixtures (`private-markets.md` §6). **Safari and iOS: never.**

---

## 4. What ran only on fakes, forks or paper

| Capability | Highest level reached |
|---|---|
| Hyperliquid live orders (manual, mandate, by key, by agent) | S — real signer code, scripted venue |
| GMX v2 orders | F in V10 (anvil fork, real bytecode: creation, simulated execution, keeper cancellation); V11 unified path on a scripted chain only |
| Quoting mandate, live adapter, dead man's switch | S + recorded tape; `scheduleCancel` never sent to the venue |
| Trading-mandate approval (two passkey prompts) | S with a software passkey; not in a browser |
| Spot orders of the owner through the trading API | I with a stand-in port for the swap route |
| Attached SL/TP | paper only |
| Stream agents | paper on a simulated book; second venue scripted |
| Strategies | backtest and paper; out-of-sample verdict: no edge |
| CCTP, THORChain | scripted chains and operators (V10: forks and mainnet simulation) |
| 0x, 1inch | documentation-derived fixtures |
| V10 → V11 migration | a fixture database of the old shape; `preflight.sh --db` on the real schema is part of the deployment plan, not yet run |
| Signer state migration | an old-format `state.json` written by the old store code |

## 5. Never exercised on mainnet, on testnet, or with a funded account

- Any order, cancel, leverage change, `scheduleCancel`, deposit or withdrawal on Hyperliquid — mainnet **or testnet**.
- Any GMX transaction on Arbitrum mainnet.
- A trading mandate, a quoting mandate or a V11 derivative mandate approved on the production signer with the owner's
  real passkey.
- An API key executing anything live.
- A live agent under the V11 unified path.
- The V11 signer binary on the production data directory; the V11 API on the production database; the websocket
  through Caddy; the separate agents worker under PM2.
- Any swap, bridge or transfer signed by V11 code on a real network.

---

## 6. Final run on the merged tree

<!-- PENDING: final full-suite totals, e2e matrix, soak -->

To record here: the commit; `pnpm typecheck`; `pnpm test` (files, tests, passed, skipped, failed, with the lab
virtualenv present — and each failure named); `uv run pytest` in `research/` and `sdk/python/`; the Playwright matrix
(every spec of `tests/e2e/`, including the v9 / v10 visual suites and whether their baselines were regenerated); the
generators' `--check`; the build and first-chunk size; a soak of the API with the stream and the agents runtime (duration,
memory, reconnects); and `scripts/preflight.sh --db` if run against a copy of the production schema.

<!-- PENDING: final interface pass (branch v11-ui) — browser runs and visual baselines it produced -->
