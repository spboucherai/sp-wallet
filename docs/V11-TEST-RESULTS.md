# SP Wallet V11 — test results

Sections 1–5: evidence compiled from the work notes (`docs/v11/work/*.md`), each written by the workstream that ran the
tests. Counts are **as reported in the note named in the last column**, on the branch and date of that note; no suite was
run to write those sections. **Section 6 is different: every line of it was run for this page**, on the merged tree, on
2026-11-16 and 2026-11-17 (`docs/v11/work/final-validation.md` has each command and its output).

Three statements frame everything below:

1. **No live order was ever sent.** No test, script or person of V11 sent an order, a cancel, a transfer or any signed
   action to a venue or a chain. No funded account, no testnet account and no real key was used by any workstream — the
   final validation included. Its fork runs sign and execute on private anvil chains on 127.0.0.1: a fork run is not a
   mainnet execution.
2. **The signer changes are proven on the real signer code against fake venues**: the real `Signer` class (in process or
   as a local process on a temporary directory, public test mnemonic), a scripted Hyperliquid, a scripted Arbitrum chain.
3. **What ran against real external systems is read-only public market data**, listed in section 3.

Evidence levels used in the tables:
**U** unit / pure · **I** integration on a real local server + PostgreSQL with scripted or recorded venues ·
**S** real signer code in the loop, fake venue · **R** recorded real venue answers replayed · **L** live read-only call to
a public endpoint · **B** real browser (Chromium) · **F** anvil fork (V10 evidence; **re-run on the V11 tree on 2026-11-17**,
section 6.4).

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

### 2.8 Market making (core, then the integration)

| Test file | Count | Level | Proves | Note |
|---|---:|---|---|---|
| `services/isolated-signer/test/venue-quoting.test.ts` | 49 | S | every refusal of the quoting mandate individually; exits under halt, revocation, expiry; property: after every accepted batch the worst case stays inside the mandate | `mm-core.md` §1.3 |
| `packages/derivatives/test/hyperliquid/mm-primitives.test.ts` | 36 | U + 22 vectors from the official Python SDK 0.24.0 | builders equal the SDK's action, hash and signature | §1.1 |
| `packages/trading/test/mm.test.ts`, `quoting-mandate.test.ts` | 40 + 3 | U, property tests | never a crossing pair, budget, inventory bound, attribution identity | §1.4, §1.5 |
| `services/api/test/mm-engine.test.ts` | 39 | S + R (36-minute recorded BTC tape, **modelled** fills) | start, quoting, each breaker, lost answers, crash and restart, signer down, out-of-mandate policies stopped by the signer, the locks (three at that date; four since the integration) | §1.6 |

Integration (`v11-mm-live`, note `mm-live.md`) — the rows above still hold; these were added or rewritten:

| Test file | Count | Level | Proves | Note |
|---|---:|---|---|---|
| `services/api/test/mm-live.test.ts` | 20 | S + R + I (real signer code in process, the venue double `mm-sim-venue.ts`, PostgreSQL, the agents runtime with two workers) | the quoting mandate in the SAME lifecycle as the trading mandates (25 out-of-bounds values each refused with its code; the sheet; one prompt is not enough; a lost approval answer → `pending_signer` → adopted; a section altered after approval → `mandate_integrity`; exclusivity both ways); a live session through the runtime: first signature is `scheduleCancel`, fills on both sides with the attribution identity, hard-limit unwind as unified orders, kill switch, a lock closed mid-session, unknown outcome of a batch, user-stream gap, signer down, restart with resting orders, a worker that stops, flatten with no worker, wind-down at expiry; every lock, the default, the exact-value rule | `mm-live.md` §1–§3 |
| `services/api/test/mm-units.test.ts` | 14 | U + R | markouts and attribution hand-checked; the fill tie-break; session hours; **a simulated hour** on the recorded tape played twice: 485 of 1 200 weight a minute, peak 878 | §2, §4 |
| `services/api/test/mm-engine.test.ts` | 39 | S + R | the engine on the live adapter, each of the eleven breakers, the four out-of-mandate policies stopped by the signer | §2 |
| `services/api/test/agent-stream.test.ts` (10 of 16 rewritten) | 16 | R | PAPER market making on recorded mainnet frames through the same engine | §2 |
| `apps/web/test/mm.test.ts` | 36 | U | checklist order and gating, the negative evidence shown as it is, every form field with its bound and no client-side clamping, refusal codes verbatim, PAPER labelled SIMULATED | §6 |
| `tests/e2e/mm.spec.ts` | 1 | B (dev stack, paper) | PAPER end to end in a browser; LIVE with every lock off up to where the server refuses (`mandate_required`; no approval sheet and no passkey prompt reachable) | §6; re-run in section 6 |

**Not run, by anyone: the testnet path (implemented, with its own lock), and anything on mainnet.** Not covered by a test:
a worker process killed with SIGKILL during a session (simulated by a worker that stops being called); alert delivery of
the six `agent.mm_*` kinds end to end; the approval, recovery, revocation and LIVE session view in a browser.

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

Browser runs reported by the workstreams (Chromium only, local stacks): `developer.spec.ts`, `risk.spec.ts`,
`agents-bind.spec.ts`, `mm.spec.ts`, `v11-quotes-live.mts`, Private Markets opened by hand against recorded fixtures
(`private-markets.md` §6), and the interface pass's matrix (`ui.md` §8: 52 tests of six `v11-*` specs, the existing specs
adapted). The whole matrix was run again on the merged tree: section 6.3. **Safari and iOS: never.**

---

## 4. What ran only on fakes, forks or paper

| Capability | Highest level reached |
|---|---|
| Hyperliquid live orders (manual, mandate, by key, by agent) | S — real signer code, scripted venue |
| GMX v2 orders | F in V10 (anvil fork, real bytecode: creation, simulated execution, keeper cancellation) — **not re-run in the final validation** (`fork-gmx.mts` was not in its list); V11 unified path on a scripted chain only |
| Quoting mandate, live adapter, runtime, dead man's switch | S + recorded tape, through the integrated runtime since `v11-mm-live`; `scheduleCancel` never sent to the venue; the testnet path never run |
| Trading-mandate approval (two passkey prompts) | S with a software passkey; not in a browser |
| Spot orders of the owner through the trading API | I with a stand-in port for the swap route |
| Attached SL/TP | paper only |
| Stream agents | paper on a simulated book; second venue scripted |
| Strategies | backtest and paper; out-of-sample verdict: no edge |
| CCTP, THORChain | scripted chains and operators; CCTP and the EVM swap path again on anvil forks on 2026-11-17 (section 6.4) |
| 0x, 1inch | documentation-derived fixtures |
| V10 → V11 migration | a fixture database of the old shape; **and, on 2026-11-17, a database created and used by the V10 build itself**, migrated by V11, used by V10 again, then by V11 again (section 6.6). `preflight.sh --db` on the real schema is part of the deployment plan, not yet run |
| Signer state migration | an old-format `state.json` written by the old store code; **and both versions' signer code and bundles on one directory, back and forth** (section 6.6) |

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

## 6. Final validation on the merged tree (branch `v11-final`, 2026-11-16 and 2026-11-17)

Every line below was run for this page, on the development laptop (18 cores, macOS 27, Node 26.13, local PostgreSQL), with
the laboratory virtualenv present (nothing skipped for its absence). Commands, timestamps and outputs:
`docs/v11/work/final-validation.md`. The tree is `9561d78` (the `v11` that holds every workstream) plus the fixes of the
validation itself; the last commit that changes code is `42f44d1`.

**What this section does not contain:** an order, a cancel or a transfer sent to a venue or a chain; a funded account,
mainnet or testnet; a production node. Fork runs are private anvil chains on 127.0.0.1.

### 6.1 Type check, full suite, other suites, generators

`pnpm typecheck`: exit 0 at every step.

`pnpm test` — **eighteen runs before the last three, each reported as it came out** (one is void: the laptop slept during it):

| Runs | Tree | Result |
|---|---|---|
| 1 | `9561d78` | 194 files, 4 494 tests — **all passed** (172 s) |
| 2 | `9561d78` | **1 failed**: `agent-bind` "the Momentum template is bound…" (30 s timeout) |
| 3 | `9561d78` | **2 failed**: the same; `lab-identity` "latency of one signal call" (blocked 300 s by a hung reference interpreter) |
| 4 | + library listing fix | 4 496 — **all passed** |
| 5 | | void (machine asleep) |
| 6, 7 | + capability line, preview pruning | 4 497 — **all passed**, twice |
| 8 | | **1 failed**: `research-runner` "cancel of a SILENT agent" (heartbeats counted against a 2.5 s timer) |
| 9 | + that test made deterministic | **1 failed**: `trading-api` "the usage log…" (`last_used_at` read before its un-awaited write) |
| 10, 11 | | **all passed** (run 11 in 343 s: the `lab-identity` hang again, absorbed by the retry) |
| 12, 14 | | **1 file failed** each: `research-runner/test/sandbox.test.ts` (its probe wrote no result) — while files of the checkout were being edited; not explained, not reproduced |
| 13, 15 | | **all passed** |
| 16, 17, 18 | | **all passed, three in a row** (82–83 s) |
| **final three** | `42f44d1` | 194 files, **4 502 tests — all passed, three runs in a row** (2026-11-17 09:08:06Z, 09:09:30Z, 09:10:56Z; 82 s, 85 s, 82 s; load average under 3 before the first) |

Every failure above was a test that depended on timing, on load or on the machine: **no assertion about the product failed
in the suite**. Each was traced, and the test bounded without weakening what it asserts (`final-validation.md`, defects 1, 2,
5, 6); two things were not explained (the reference-interpreter hang of `lab-identity`, the two `sandbox.test.ts`
failures) and are in the limitations register (12.2, 12.3). The product defects of the validation were found by measuring,
by reading, by the browser and by the soak — not by the suite (6.7).

| Other suite / generator | Result |
|---|---|
| `research/`: `python -m pytest tests` | **404 passed, 2 skipped** (the two live-network tests) — on `96208d9` and again on the final code |
| `python -m spq.lint` on every library strategy version (32) | 32 ok |
| `packages/trading-sdk`: `vitest run` | **6 files, 165 tests passed** — twice, the second time on the final code |
| `sdk/python`: `uv run pytest` | **415 passed**; `uv run ruff check`: all checks passed — twice, the second time on the final code |
| `gen-openapi.mts --check`, `gen-types.mts --check`, `gen_models.py --check`, `gen_sync.py --check` | all "up to date", exit 0 — on `9561d78` and again on the final code |
| `pnpm build` | exit 0; first chunk `index-*.js` **262.32 kB** (81.07 kB gzip) — the same on the final code |

### 6.2 Read-only live smokes (2026-11-17)

| Script | Observed |
|---|---|
| `smoke-private-markets.mts` (05:36Z) | exit 0 — 7 live instruments, 5 companies. Anthropic on Hyperliquid's builder dexes still reviewed and priced, 18 h before the entries expire (`io:ANTH` 1 678.2 = 1 678 G USD implied; `para:ANTH` 96.42; `xyz:ANT` 96.507); **`edgex:ANTHROPICUSDC` gone from edgeX's list** |
| `smoke-edgex.mts` (05:36Z) | **exit 1 as committed** ("ANTHROPICUSDC is not listed": the smoke's hard-coded sample contract was delisted by the venue); exit 0, all steps passed, with the sample as an argument (`MOONSHOTUSDC`): 155 markets, 2 pre-IPO |
| `smoke-markets-hub.mts` (05:37Z) | exit 0 — four venues; ETH totals 12.54 (Hyperliquid), 12.92 (edgeX), 14.27 (GMX), 28.02 bps (dYdX); no trading or account endpoint |
| `smoke-quotes.mts --seconds 60` (06:18Z) | exit 0 — five venues connected in 0.6 s; BTC quotes: Hyperliquid 590, Coinbase 234, edgeX 117, GMX 10, dYdX 2; 0 reconnect, 0 gap, 0 checksum mismatch; lag p50 295 ms, p95 408 ms |
| `check-hl-bridge.mts` (06:19Z; read-only: RPC reads and `POST /info`) | exit 0 — bytecode as pinned, not paused; 6 / 6 sampled deposits credited by the venue in 4–7 s |

### 6.3 Playwright (Chromium) — every spec of `tests/e2e/`, one at a time

| Spec | Stack | Result |
|---|---|---|
| `v11-shell`, `v11-dashboard`, `v11-trade`, `v11-activity`, `v11-leftovers` | one real local stack (`ui-stack.sh`: real API, real signer, virtual passkey, paper) | 6 + 7 + 8 + 4 + 2 passed |
| `v11-sections` | same | first run **24 passed, 1 failed** ("Markets with live quotes": the test counted a cell going live, and a logo loading, as a redraw of the list — test fixed); then **25 passed** |
| `wallet`, `developer`, `risk`, `agents-bind`, `mm` | a fresh `dev-stack.sh` each | 2, 1, 1, 1 (4.1 min), 1 passed — **and again on the final code** (09:14–09:22Z), after the fixes of the backtest job and of the market-making market data: the same |
| `futures`, `futures-live`, `futures-gmx`, `futures-collateral`, `futures-router`, `perp-agent-live` | in-browser mock | 18, 10, 16, 6, 8, 8 passed (66) |
| `alerts`, `research` | their own servers | 2, 2 passed |
| `v9-visual`, `v10-visual` | built bundle, recorded answers | 6, 5 passed — **no baseline regenerated** by this run |
| `qa-agent-fund`, `qa-real` (**first run in V11**) | real stack on **anvil forks** of Base and Arbitrum, broadcast off | first run **2 failed, 5 not run**; after two fixes **7 passed** |
| `qa-plan` (**first run in V11**) | same, fresh stack | first run **1 failed**; after the fixes **1 passed** |
| `rollback-rehearsal` (new) | both versions' bundles on one database (6.6) | every stage passed |
| `futures-live-real` | needs a **funded Hyperliquid testnet account** | **NOT RUN** |

What the QA specs found: (a) the forks were funded from a hard-coded USDC holder that held **0 USDC on Base** that day — an
unchecked transfer, a silent zero balance; not a V11 regression; funding now writes the balance in storage and checks it.
(b) Two specs still described V10: a transfer signed with broadcasting off is now `not_broadcast`, and a plan now **pauses**
on a leg that was not sent — both intended V11 changes that no browser run had met. The specs assert the new behaviour; to
walk the second leg of a plan, the test's stand-in for the network also restores the plan in the scratch database.
**Safari and iOS: never.**

### 6.4 Fork proof scripts of the swap / bridge stack (anvil, one at a time)

| Script | Result |
|---|---|
| `fork-swap-kyber.mts` | **FORK TEST OK** — pinned router bytecode; ETH → USDC 18.272398 received (approved minimum 18.182289); USDC → ETH; USDC → LINK through two pools; a higher minimum than the calldata guarantees is refused |
| `fork-swap-api.mts` | **FULL-STACK FORK TEST OK** — both directions finalized through the API, the signer over HMAC and the worker; leftover allowance 0 |
| `fork-swap-net.mts base` | **FORK TEST OK on Base** |
| `fork-swap-net.mts ethereum` | **FORK TEST OK on Ethereum** (block 26 433 317) |
| `fork-cctp.mts base arbitrum` | **FORK CCTP TEST OK** — reviewed bytecode on both forks; Circle's public messages verified against on-chain attesters; refusals; burn, mint (test attesters on the destination fork: the script's stated simulation), no double mint; Standard and Fast through the full stack |
| `fork-agent.mts` | exit 1 at first (the same funding holder), then **AGENT FORK TEST OK on Base** — paper, mandate refusals, two live orders at or above their minimum, signer refusals above the limit and after revocation, withdrawal, audit chain intact |

They prove that the stabilisation did not degrade the V10 execution paths these scripts exercise. **A fork is not
mainnet**; `fork-gmx`, `fork-hl-deposit`, `fork-mandate`, `fork-plan` were not run.

### 6.5 Soak (30 minutes, paper, local)

Driver `scripts/soak-v11.py` on the SDK tests' stack (real API and signer bundles, an own database, workers in the API
process, paper only): a bar perp agent from the Momentum template on `momentum_xs_perp/2` (backtest through the job queue,
then paper), a market-making agent on BTC in paper, one websocket client of the quote stream (Python SDK), and every 30 s
through the Python SDK a limit order placed and cancelled, every fourth round a market order. Sampled once a minute. Two
runs, because the first one found a defect.

| | Run 1 (07:50Z, before the market-data fix) | Run 2 (08:33Z, tree `42f44d1`) |
|---|---|---|
| RSS of the API process, first → last (range) | 274.3 → 276.5 MB (261.3 – 303.6) | 259.7 → 287.2 MB (257.3 – 304.9) — **no monotonic growth**; 30 minutes cannot exclude a slow leak |
| CPU of the API process | ≈ 4.5 % of one core | ≈ 3.9 % |
| Open file descriptors | 132 – 142 | 125 – 144 |
| Database connections | 4 – 6 | 4 – 5 |
| `GET /health/live` latency, worst p95 / worst call (a proxy: the API exposes no event-loop lag) | 9.1 ms / 15.6 ms | 3.5 ms / 15.2 ms |
| Quote stream, client | 18 983 quotes, 0 error, 0 close | 19 897 quotes, 0 error, 0 close |
| Quote stream, server | 19 232 messages, 0 conflated, 0 dropped; lag p50 291 / p95 390 ms; **1 upstream reconnect** | 20 147 messages, 0 conflated, 0 dropped; lag p50 328 / p95 450 ms; 0 reconnect |
| SDK order loop | 60 placed, 59 cancelled, 14 market, **0 error** | 59 placed, 59 cancelled, 14 market, **0 error** |
| Runtime loops | 0 failure | 0 failure |
| API log | 45 lines; 3 error lines, all at start-up (`signer-client … ECONNREFUSED`: the stack starts the API before its signer listens) | 49 lines; the same 3 |
| **Market-making paper session** | **1 quote batch in 30 minutes**: pulled after 7 s by `data_stale` + `venue_disconnected`, for good | **130 quote batches, 221 quotes, 60 simulated fills**, no breaker; PnL −0.60 USD on 2 937.54 USD = **−2.06 bps of volume**; markouts −0.82 / −0.87 / −0.88 bps at 1 / 10 / 60 s |

Rows written in 30 minutes (both runs, the same unless noted): `orders` 76, `order_events` 422, `risk_decisions` 211
(76 of them previews), `market_snapshots` 179, `mm_tape` 1 632 / 1 689, `mm_fills` 0 / 60, `api_key_usage` +191,
`api_idempotency` +132, `agent_signals` 296 / 28, `agent_jobs` +30, `research_log` +70, `audit_events` +138;
`order_projection_queue` 0 at the end (never above 2). Which of them are pruned: `V11-REMAINING-LIMITATIONS.md` 11.11.
`candles` grew from 0.14 M to 1.36 M rows: the market engine's one-time backfill of a fresh database, not a soak effect.

**The defect it found** (run 1): a market-making session on the real feed stopped quoting after seven seconds — its books
came from the venue's order-book channel, measured that day at one book every 12.3 s on BTC, against a 5 s freshness
bound and a 15 s cool-down. Fixed (`42f44d1`: the sessions read the best-bid / offer channel). Run 2 is the first session
of this project that quoted on the real feed for more than a few seconds; its simulated result is a loss with adverse
markouts, like the study and the simulator. Before that, preparing the driver had found two more (6.7, defects 11, 12).
**Limits of this soak:** 30 minutes, a laptop, one client, paper, no restart, no live venue account.

### 6.6 Rollback rehearsal (V10 `a118e3e` ↔ V11, one database and one signer directory)

Observed, on a throwaway local database and keystore (`V11-DEPLOYMENT.md` §9 has the procedure that follows from it):

- V11 migrates a database created and used by the V10 build (42 → 65 tables, 1 → 8 triggers) and reads its rows back;
  orders older than the first V11 start are not in the unified `orders` table.
- **V10 boots on the database V11 wrote**: health, portfolio, activity, agents, a paper order, a reduce-only close, a
  transfer draft and the signer status all answer as before V11.
- With the V11 kill switch left engaged: **V10 does not apply it** (a paper buy fills), and **the database refuses a spot
  agent's buy** (`kill_switch_active`, trigger `agent_orders_gate`) — which V10 cannot release.
  `scripts/v11-rollback-triggers.sql` (new, tested there) drops that one trigger.
- Forward again: the projection queue left by V10 drains in seconds, the orders made under V10 become unified orders,
  **none duplicated**, no error; a dropped trigger is re-created; a switch left engaged is engaged again.
- Signer: the V10 binary starts on the V11 state (same key id, counters and replay markers intact, an empty journal of
  its own); V11 takes it back and keeps V10's records in a side file. **With a quoting mandate active, the V10 signer code
  approves a directional mandate that V11 refuses with `conflict`, and can neither see nor revoke the quoting mandate**
  (`scripts/rollback-signer-rehearsal.mts`, exit 0).
- **V11-only agents under V10** (on a copy of the soak's database): one stream-agent row makes V10's `GET /api/v1/agents`
  answer **500** (`unknown network: hyperliquid`) — the whole Agents list, whatever the agent's state; V10's engines do
  not tick such rows. `scripts/v11-rollback-triggers.sql -v park_agents=1` makes the list work again (200), and
  `-v unpark_agents=1` undoes it before V11 is started again. Both tested.

### 6.7 Defects found by the final validation

| # | Defect | Found by | State |
|---|---|---|---|
| 1 | The agents' library listing started one laboratory process per version, one after the other: 19 s for `GET /agents/templates` once a minute | timing a failing test | **fixed** `e58b55b` (5.9 s) |
| 3 | `SPW_TRADING_API_EXECUTION` absent from the start-up capability line | reading | **fixed** `d88f1da` |
| 4 | Preview risk evaluations never pruned | reading, then the soak | **fixed** `d88f1da` |
| 7 | Finished agent jobs never pruned (`pruneJobs` had no caller) | reading | **fixed** `7df3ed1` |
| 11 | **A backtest job asked right after a creation was dead-lettered and destroyed the result of the run in flight** (the SDK's own create → backtest flow) | the soak driver | **fixed** `b08b417` |
| 12 | A dead-lettered job answered `status: "dead"`, outside the contract; the Python SDK refused the answer | the soak driver | **fixed** `b08b417` |
| 9 | Fork funding from a holder that holds nothing (test tooling; environment) | the QA specs | **fixed** `467a6c3`, `2a0bd15` |
| 2, 5, 6, 8, 10 | Tests: a blocking reference call; a timer race; an un-awaited write read at once; a browser test counting a cell going live as a redraw; two QA specs describing V10 | the runs | tests **fixed** (`96208d9`, `ae604c2`, `7df3ed1`, `f9563d3`, `467a6c3`) |
| — | The smoke of edgeX hard-coded a contract the venue delisted | the smoke | **fixed** `96208d9` |
| 13 | **A market-making session on the real feed stopped quoting after seven seconds, for good** (paper observed; live by the same code): its market data came from a channel that speaks every 12 s | the soak | **fixed** `42f44d1`; second soak: 130 quote batches in 30 minutes |
| 14 | Under V10 code, one V11-only agent row breaks the Agents list (500); a V11 kill switch left engaged makes the database refuse the spot agents' buys | the rollback rehearsal | procedure and `scripts/v11-rollback-triggers.sql` (`c9fa7c4`, `42f44d1`) |
Not fixed: the cause of the `lab-identity` reference hang and of the two `sandbox.test.ts` failures (not reproduced);
the backtest job's 150 s deadline (5.16); everything in `V11-REMAINING-LIMITATIONS.md`.
