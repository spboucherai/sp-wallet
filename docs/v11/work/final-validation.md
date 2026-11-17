# V11 — final validation (Phase I) and delivery documents (Phase J): work notes

Branch `v11-final`, from the local branch `v11` at `9561d78`. Dates: 2026-11-16 and 2026-11-17 (UTC times below). Machine: the
development laptop (18 cores, 48 GB, macOS 27, Node 26.13, pnpm 11.1.2, PostgreSQL local, anvil / forge from Homebrew).

**Nothing here touched a production node. Nothing was deployed. No order, cancel, transfer or signed action was sent to a venue
or a chain; no real key and no funded account (mainnet or testnet) was used.** Network activity: read-only public market data
and public RPC reads; anvil forks are private chains on 127.0.0.1. A fork run is not a mainnet execution. Nothing in this project
has ever been executed on a funded derivative account.

The work was interrupted once (an API billing error of the session, 2026-11-16 ≈ 07:20 UTC → 2026-11-17 05:25 UTC); the laptop
slept in between. What was observed before the interruption is in section 1, as it was observed.

## 0. Set-up

| Command | Result |
|---|---|
| `git checkout -b v11-final v11` | at `9561d78` |
| `pnpm install --frozen-lockfile` | done in 4.3 s; one warning (a `bin` link of `micro-key-producer` under `services/isolated-signer`, harmless) |
| `cd research && ~/.local/bin/uv sync --frozen` | virtualenv created (`research/.venv`, never committed) |

## 1. Full suite (`pnpm test`), type check

`pnpm typecheck` — 2026-11-16T06:54:03Z — exit 0 (4 s).

| Run | Tree | Start (UTC) | Files | Tests | Result | Duration |
|---|---|---|---:|---:|---|---|
| 1 | `9561d78` | 2026-11-16 06:54:07 | 194 | 4 494 | **all passed** | 172 s |
| 2 | `9561d78` | 06:57:07 | 194 | 4 494 | **1 failed**: `agent-bind.test.ts` "the Momentum template is bound…" — `Test timed out in 30000ms` | 141 s |
| 3 | `9561d78` | 06:59:30 | 194 | 4 494 | **2 failed**: the same test (30 s timeout), and `lab-identity.test.ts` "latency of one signal call…" (reported after 303.8 s; its timeout is 120 s) | 421 s |
| 4 | `9561d78` + the library fix (`e58b55b`) | 07:14:53 | 194 | 4 496 | **all passed** | 144 s |
| 5 | same | 07:17:18 | — | — | **void**: the session was interrupted and the laptop slept during the run (test durations of 79 580 s); 39 timeouts, none meaningful. Not counted |

Nothing else ran on the machine during runs 1–4 (load average 2–4 before each).

### Defect 1 — the library listing was sequential (fixed, `e58b55b`)

- **Symptom.** `agent-bind.test.ts`, first test, 30 s timeout in runs 2 and 3 (and in the interface workstream's run, `ui.md` §10).
  The test calls `GET /api/v1/agents/templates` once and asserts no duration.
- **Cause.** `perpLibrary()` (`services/api/src/agents/perp-strategies.ts`) started one sandboxed laboratory process
  (`spq.describe`) per library version, one after the other. Measured alone on a quiet machine: **19.3 s for the 14 perp
  versions** (the spot versions are tried and refused too). `installedPerp` caches the answer for 60 s, so in the product the
  first `GET /agents/templates` of every minute waited that long; in a loaded test run it passed 30 s.
- **Fix.** The versions are described four at a time (`mapLimit`, order of the answer unchanged, each version still caught on
  its own). Measured after: **5.9 s**. The test keeps its assertions and gets an explicit 180 s bound (it asserts no latency).
- **Tests.** `agent-runtime-unit.test.ts` "mapLimit (the library listing)" (2: order, bound, failure; the listing uses it).
  `agent-bind.test.ts` alone: 8 / 8.

### Defect 2 — `lab-identity` latency test blocked for 300 s once (test made bounded; cause NOT found)

- **Symptom.** Run 3 only: the test ended after 303.8 s. Its reference measurement starts the unconfined interpreter with
  `spawnSync` (kill at 300 s): one of the seven reference calls did not return until it was killed, and a synchronous spawn
  blocks the test's own timer.
- **Investigation.** 197 runs of the same command (`.venv/bin/python -m spq.signal …`, same environment), 30 at a time for 90 s:
  none hung, slowest 15.8 s. A watchdog sampling any laboratory process older than 45 s ran during run 4: nothing to sample.
  The laboratory source takes no file lock. **Not reproduced; cause unknown.** It was the unconfined reference call, which the
  product never makes (the product's call is the sandboxed one, with its own 60 s kill).
- **Change.** The reference figure is printed, never asserted: a reference call now has 20 s and is left out of the median if
  it is killed (the message says how many were). The assertion (median of the seven sandboxed calls under 5 s) is unchanged,
  and the test now also asserts that all seven sandboxed calls were made.

A second occurrence, 2026-11-17 05:30Z: the file run alone, minutes after the laptop woke from sleep — "every library strategy…"
failed after 341.8 s (one reference call killed at 300 s, so its output could not be compared). Six further runs of the file alone
(with the watchdog): all passed, 34–107 s, nothing hung. Change (`96208d9`): a reference call killed at its timeout is started
once more; a call that answered is never repeated; the comparison (byte-identical output) is unchanged.

### Defect 3 — `SPW_TRADING_API_EXECUTION` was not in the start-up capability line (fixed, `d88f1da`)

`capabilities.ts` had the two market-making entries (which name the variable as "missing") and no entry of its own for the
trading-API execution lock. Added `trading_api_execution` (after `deriv_gmx_live`), its Monitor label in both languages, and the
neutral tone on Monitor for the locks that are off by default (`trading_api_execution`, `deriv_mm_*` — the item (5) of
`mm-live.md` §6). Test: `hardening-e.test.ts` (the line, the exact-value rule, every lock variable named).

### Defect 4 — preview risk evaluations were never pruned (fixed, `d88f1da`)

`risk_decisions` stores every evaluation, previews included, and nothing deleted any. `RiskService.prunePreviews` removes
PREVIEW rows older than `SPW_RISK_PREVIEW_RETENTION_DAYS` (default 30); the decision of a real order request is never deleted.
Loop `risk-previews-prune`, every 6 h, with the workers. Test: `execution-paper.test.ts` "retention: PREVIEW evaluations…".

## 2. Other suites and generators (2026-11-17, tree `96208d9`)

| Command | Start (UTC) | Result |
|---|---|---|
| `node scripts/gen-openapi.mts --check` | 05:38:31 | exit 0 — both files "up to date" |
| `node packages/trading-sdk/scripts/gen-types.mts --check` | 05:38 | exit 0 — "src/generated/openapi.ts is up to date" |
| `uv run python scripts/gen_models.py --check` (`sdk/python`) | 05:38 | exit 0 — "src/sp_wallet/models.py is up to date" |
| `uv run python scripts/gen_sync.py --check` (`sdk/python`) | 05:38 | exit 0 — "src/sp_wallet/_client.py is up to date" |
| `packages/trading-sdk/scripts/gen-fixtures.mts` | — | has no `--check`; `packages/trading-sdk/test/generated.test.ts` recomputes the vectors (in the suite below) |
| `scripts/gen-market-listings.mts` | — | **not run**: it has no `--check`, it rewrites `packages/core/src/market-listings.ts` from three exchanges' live listings (a reviewed snapshot, not a derived file) |
| `uv run ruff check` (`sdk/python`) | 05:38 | "All checks passed!" |
| `uv run pytest` (`sdk/python`) | 05:38:37 | **415 passed** in 42 s (unit + integration: the suite starts its own local stack; live Hyperliquid quotes read by the stream tests) |
| `npx vitest run packages/trading-sdk` | 05:40:30 | **6 files, 165 tests passed**, 42 s |
| `research/.venv/bin/python -m pytest tests` (`research/`) | 05:41:13 | **404 passed, 2 skipped** (the two live-network tests), 69 s |
| `python -m spq.lint --strategy <dir>` over every library version (not `rj_*`) | 05:45:26 | **32 ok, 0 failed** (the static purity lint; the lab documents no `python -m spq` lint of the whole library, so each version was linted) |

## 3. Full suite after the fixes — three consecutive runs

Tree `d88f1da` (fixes 1–4), 2026-11-17, nothing else running:

| Run | Start (UTC) | Files | Tests | Result | Duration |
|---|---|---:|---:|---|---|
| 6 | 05:47:26 | 194 | 4 497 | **all passed** | 83 s |
| 7 | 05:48:51 | 194 | 4 497 | **all passed** | 83 s |
| 8 | 05:50:15 | 194 | 4 497 | **1 failed**: `services/research-runner/test/runner.test.ts` "cancel of a SILENT agent…" — `expected 2 to be greater than 2` | 83 s |

### Defect 5 — "cancel of a SILENT agent" counted heartbeats against a wall-clock timer (test made deterministic)

The test armed the owner's cancel with a 2.5 s timer and then asserted that more than two empty log pushes (heartbeats) had been
made before it. When the fake agent's start took most of the 2.5 s (the third of three back-to-back full runs, load average 15),
two had been made. The product behaviour was right (the job was cancelled, 0.46 s after the cancel was wanted). The cancel is now
wanted once the agent's line has been pushed and three heartbeats have followed it; the three assertions are kept and two were
added (the line was pushed first; the cancel came from a heartbeat's answer). File alone, three times: 17 / 17.

Tree `ae604c2` (fix 5), three more consecutive runs:

| Run | Start (UTC) | Files | Tests | Result | Duration |
|---|---|---:|---:|---|---|
| 9 | 05:53:16 | 194 | 4 497 | **1 failed**: `trading-api.test.ts` "the usage log holds route patterns…" — `last_used_at` read as null | 82 s |
| 10 | 05:54:39 | 194 | 4 497 | **all passed** | 81 s |
| 11 | 05:56:02 | 194 | 4 497 | **all passed** — in 343 s: a reference interpreter of `lab-identity` hung again and was killed at 300 s; the retry of fix 2 let the comparison finish | 343 s |

### Defect 6 — `last_used_at` read at once (test given a bounded poll)

`keys.ts` refreshes `api_keys.last_used_at` without awaiting the write (`void sql…`), like the usage rows; the test read the
column immediately. Same remedy as the two usage-log reads fixed in `23c0a23`: a bounded poll that returns as soon as the
column is set. The product is unchanged.

### Runs 12–18 (with a watchdog that samples any laboratory process older than 45 s)

| Run | Start (UTC) | Result |
|---|---|---|
| 12 | 06:02:11 | **1 file failed**: `services/research-runner/test/sandbox.test.ts` — its `beforeAll` found no `probe.json` (ENOENT); 12 tests of the file skipped, 4 485 passed |
| 13 | 06:03:36 | all passed (4 497) |
| 14 | 06:04:57 | the same failure as run 12 |
| 15 | 06:06:20 | all passed |
| 16, 17, 18 | 06:08:28, 06:09:52, 06:11:17 | **all passed, three in a row** (194 files, 4 497 tests; 82 s, 83 s, 82 s) — tree `ae604c2` + the diagnostic below |

**Not explained.** The `sandbox.test.ts` failure appeared in two of four runs made while documents and a test file of this
checkout were being edited by this session, never in the eleven runs before nor in the three after; the file alone passed three
times. The test now says why the probe wrote nothing (outcome, reason and the captured log) instead of `ENOENT`. The
`lab-identity` hang (defect 2) was not caught by the watchdog in runs 12–18 either.

**Honest reading of the eighteen runs:** the suite's assertions about the product all pass; on this laptop about one full run
in three still met a load- or timing-dependent event before fixes 1, 2, 5 and 6, each of which is now bounded. No product defect
was found by the suite itself (defects 1, 3, 4 and 7 were found by reading and measuring).

### Defect 7 — finished agent jobs were never pruned (fixed)

`agent-runtime/queue.ts` exports `pruneJobs` (finished jobs older than 14 days); nothing called it. The jobs pass now calls it
once an hour per worker. Test: `agent-workers.test.ts` "retention: the jobs pass removes FINISHED jobs older than 14 days…".

## 4. Read-only live smokes (2026-11-17)

| Script | Start (UTC) | Observed |
|---|---|---|
| `tsx scripts/smoke-private-markets.mts` | 05:36:32 | exit 0. Hyperliquid 5 instruments, **edgeX 2** (it was 3 on 2026-11-16): **7 live instruments, 5 companies**. The three Anthropic contracts of Hyperliquid's builder dexes (`io:ANTH` 1 678.2 = implied 1 678.2 G USD; `para:ANTH` 96.42; `xyz:ANT` 96.507) are still `reviewed … valid until 2026-11-18T00:00:00Z` — 18 h 23 min before the entries expire. **`edgex:ANTHROPICUSDC` is no longer in the live inventory**: edgeX took the contract off its list (below). OpenAI `io:OAI` 1 311.5; Oura; Polymarket and Moonshot on edgeX; five public-company markets excluded; two delisted Ventuals markets |
| `tsx scripts/smoke-edgex.mts` (sample `ANTHROPICUSDC`, as committed) | 05:36:43 | **exit 1, 2 steps FAILED: "ANTHROPICUSDC is not listed", "no ticker for ANTHROPICUSDC"**. 155 markets (74 crypto, 70 equity, 8 commodity, **2 pre-IPO: MOONSHOTUSDC, POLYMARKETUSDC**, 1 fx). The contract's book, candles and websocket ticker still answer (last trade 01:29:45Z, volume 0 since 02:00Z): the venue delisted it. A venue change, not a regression: the smoke hard-coded its sample contract |
| the same with the sample as an argument (default `MOONSHOTUSDC`, `96208d9`) | 05:37:43 | exit 0, "all steps passed"; 10 REST calls, no rate-limit backoff, account and trading refused before any request (0 request sent) |
| `tsx scripts/smoke-markets-hub.mts` | 05:37:19 | exit 0, "OK"; four venues; ETH comparison totals 12.54 bps (Hyperliquid), 12.92 (edgeX), 14.27 (GMX), 28.02 (dYdX); 12 discrepancy pairs, 0 flagged; "trading / account endpoints: none" |

A script started with `node` instead of `tsx` fails at once on a TypeScript parameter property (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`,
`services/api/src/derivatives/data.ts`): the smokes that import the API need `tsx`, as their headers say.

## 5. Rollback rehearsal (2026-11-17 06:13–06:17 UTC) — observed, on a throwaway local database and keystore

Tools: `scripts/rollback-rehearsal-stack.sh` (one version's bundles on a signer directory and a database that survive),
`tests/e2e/rollback-rehearsal.spec.ts` (one driver for the four stages; the owner's session in Chromium with a virtual passkey),
`scripts/rollback-signer-rehearsal.mts` (both versions' signer code on one directory), `scripts/v11-rollback-triggers.sql`.
V10 = a second worktree at `a118e3e` (`/tmp/spw-v10`), built with its own `pnpm build`. Database `spw_rollback`.

| Stage | What was done | Observed |
|---|---|---|
| (i) V10, fresh | owner setup; paper account, market buy 0.001 BTC; address-book entry; a spot agent (vault from the signer) and a perp agent; the row the paper engine writes for a spot agent's order (by SQL); a transfer draft | 42 tables, one trigger (`audit_no_update`). Draft refused `insufficient_funds` (the throwaway wallet is empty — the route works). A resting limit far from the mark was refused by V10's own price band (not part of the fixture) |
| (ii) V11 on that database | start; unlock with the same passkey; paper order through `POST /trading/orders` and through the terminal's route; kill switch engaged → a buy refused `kill_switch_active` → released with the passkey in the Risk screen | migrated to 65 tables, 8 triggers, no error line in the log. Both V10 agents listed. `orders` 3, `order_events` 14, `risk_decisions` 4, queue 0. **Orders made before the first V11 start are not in the unified `orders` table** (count 0 at entry): only writes made after the triggers exist are projected |
| (iii) V10 on the SAME database, kill switch released | health, portfolio, activity, agents (list and both detail routes), paper buy, transfer draft, signer status | **boots; every route 200; a paper order fills; the signer answers with the same key id.** The capability line has its nine V10 entries. `order_projection_queue` grows by two rows per derivative order and one per agent order (3 rows) and is not drained. V10's insert into `research_log` passes the V11 defaults trigger |
| (iv) V11 again | start; unlock; orders | queue 3 → 0 within seconds; `orders` 3 → 5: **the orders made under V10 became unified orders, none duplicated** (count = distinct engine reference); no error line |
| (iii-b) V10 with the V11 kill switch LEFT ENGAGED | the same checks + the spot agent's order row | **V10 does not apply the switch: a derivative paper buy FILLS.** A spot agent's BUY row is **refused by the database**: `ERROR: kill_switch_active … (spw_agent_order_gate)`; its SELL row passes. `order_events` refuses an update (`append-only`) |
| `scripts/v11-rollback-triggers.sql` under V10 | default mode | `agent_orders_gate` dropped, seven triggers left, "kill switch still recorded on: t"; the same BUY row is then accepted |
| (iv-b) V11 again | start | `migrate()` re-created the gate (8 triggers); the kill switch is still engaged and refuses (`423`, `kill_switch`); queue 10 → 0; `orders` 13 = 13 distinct; no error line |

Signer, in the same stack: the V11 daemon on the V10 directory writes nothing until something changes its state (the files were
byte-identical after stage (ii); a release of the API-side kill switch does not touch the signer). After `signer.mjs halt` /
`unhalt` through the V11 control socket: `journal.jsonl` (4 records), `state.json` with a reference, `state.json.lock`,
`control.sock`. A stopped V11 daemon leaves `control.sock` behind (the lock is removed). V10's binary then starts on it, same
key id, `journalLength: 2` after its own `halt` / `unhalt` (it sees an empty journal and starts one inside `state.json`, keeping
the reference it does not know). V11 again: `journalIntact: true`, `journal-rollback-20261117061635.jsonl` written at its
first save.

`scripts/rollback-signer-rehearsal.mts /tmp/spw-v10` — exit 0, "every observation is as documented":
Part A (the committed V10-format fixture, V11 → V10 → V11): journal moved to the file (7 → 8 records), `policy.json` untouched,
same key id, V10 sees the halt and an empty journal, replay markers and spending counters kept, one side file at the return.
Part B (**why every quoting mandate must be revoked first**): with a quoting mandate active, V11 answers a directional mandate
on the same authorization `conflict: a quoting mandate is active on this venue authorization: revoke it first`; the V10 signer
code on the same state **approves the same request** (it does not report the quoting mandate, has no route to sign under it or
to revoke it, and keeps it on disk); back on V11, a quoting mandate and a directional mandate are both active on one
authorization — a state V11 never creates. Revocation by V11 needs no passkey and puts the mandate in `wind_down`.

Not rehearsed: a V11-only agent (stream engine, supervisor) or a live agent under a V11 trading mandate running when V10 starts —
see section 8 (after the soak, on a copy of its database); a production-size database; PM2.

More read-only smokes (2026-11-17):

| Script | Start (UTC) | Observed |
|---|---|---|
| `tsx scripts/smoke-quotes.mts --seconds 60` | 06:18:09 | exit 0. Five venues connected within 0.6 s (Coinbase 0.2 s, Hyperliquid 0.3, GMX 0.4, dYdX 0.6, edgeX 0.6). BTC quotes in 60 s: Hyperliquid 590, Coinbase 234, edgeX 117, GMX 10, dYdX 2; Hyperliquid book 1 snapshot + 5 deltas, 0 sequence break, 0 checksum mismatch; 1 159 messages sent, 0 conflated, 0 trades dropped, 0 book resync; lag venue timestamp → socket write p50 295 ms, p95 408 ms; upstream reconnects 0, gaps 0; "trading / account endpoints: none" |
| `tsx scripts/check-hl-bridge.mts` (read first: JSON-RPC reads on Arbitrum and `POST /info` only, no key, no signature) | 06:19:15 | exit 0, "0 check(s) failed": bytecode on both RPC endpoints = the pinned hash, not a proxy, `paused() = false`, USDC = the registry's; 6 / 6 sampled deposits ≥ 5 USDC credited by the venue to the sending address within 4–7 s; 2 / 6 sampled withdrawals matched on the destination's own ledger (the four others were asked by another account) |

`scripts/preflight.sh` by hand (laptop, 06:33): with `SPW_TRADING_API_EXECUTION` and `SPW_DERIV_MM_MAINNET` set → two WARN "is SET…
confirm it was decided" and a third "set without the three other settings it needs"; `SPW_WORKERS=agnets` → FAIL "a value the API
does not know"; the secrets file → "present, mode 600" / "does not exist yet"; `dist/agents.mjs present`.

## 6. Playwright (Chromium), 2026-11-17 06:18–07:18 UTC — every spec, one at a time

Build first: `pnpm build` exit 0 (06:13), first chunk `index-*.js` **262.32 kB** (81.07 kB gzip).

| Spec | Stack | Result |
|---|---|---|
| `v11-shell` | `tests/e2e/ui-stack.sh fin 8840` (real API, real signer, virtual passkey, paper; one stack for the six `v11-*` specs) | 6 passed (5.3 min) |
| `v11-dashboard` | same | 7 passed (3.0 min) |
| `v11-sections` | same | **first run: 24 passed, 1 failed** — "Markets with live quotes: a tick changes its own cell — the list around it is not redrawn". After the test fix below: **25 passed** (12.0 min) |
| `v11-trade` | same | 8 passed (4.2 min) |
| `v11-activity` | same | 4 passed (2.0 min) |
| `v11-leftovers` | same | 2 passed |
| `wallet` | fresh `scripts/dev-stack.sh` (8650) | 2 passed (1.5 min) |
| `developer` | fresh dev stack | 1 passed |
| `risk` | fresh dev stack | 1 passed |
| `agents-bind` | fresh dev stack | 1 passed (4.1 min; public Hyperliquid history, paper) |
| `mm` | fresh dev stack with `SPW_MM_MIN_PAPER_MINUTES=1` | 1 passed (1.3 min) |
| `futures` | its own Vite dev server, in-browser mock | 18 passed |
| `futures-live` | same | 10 passed |
| `futures-gmx` | same | 16 passed |
| `futures-collateral` | same | 6 passed |
| `futures-router` | same | 8 passed |
| `perp-agent-live` | same | 8 passed |
| `alerts` | `tests/e2e/alerts-server.mts` | 2 passed |
| `research` | `tests/e2e/research-server.mts` (real runner, fake agent under the OS sandbox) | 2 passed |
| `v9-visual` | built bundle, recorded answers | 6 passed — **no baseline regenerated** (`git status` clean after the run) |
| `v10-visual` | same | 5 passed — idem |
| `rollback-rehearsal` (new) | `scripts/rollback-rehearsal-stack.sh`, both versions | 6 stage runs, each passed (section 5) |
| `futures-live-real` | needs `LIVE_REAL=1` and a **funded Hyperliquid testnet account** | **NOT RUN** — no funded account, testnet included, may be used |

The `v11-*` total is 52 tests, as in the interface pass.

### Defect 8 — `v11-sections` "Markets with live quotes" counted a cell GOING live as a redraw (test fixed, `f9563d3`)

On a freshly started stack the test failed 4 runs of 6. The recorded mutations were, in order of frequency: the funding cell and
the freshness cell of a row (BTC, HYPE on Hyperliquid) replacing their static content by the live element — `LiveCell` and
`QuoteDot` render their static children until the first quote (or the first funding value) of that market arrives, then swap,
once; and a logo plate finishing to load. Neither is the list being redrawn by a tick. The product is as designed and was not
changed. The test now counts a cell going live on its own and **fails if the same cell swaps twice** (that would be a redraw),
ignores a logo plate, and still fails on any other mutation outside a live cell (a row, another column, the table). Four runs of
the test alone, then the whole spec: 25 / 25.

### The QA specs on anvil forks (never run in V11 before) — 2026-11-17 07:18–07:35 UTC

Stack: `tsx tests/e2e/qa-real-server.mts --port <p> --db <db> --fork base,arbitrum` — the real API and the real signer class,
a throwaway seed in memory, **private anvil forks of Base and Arbitrum on 127.0.0.1**, broadcasting forced off and every relay
of a signed transaction refused before it leaves the process. One stack at a time, `pkill -f anvil; sleep 3` between them.

| Run | Spec | Result |
|---|---|---|
| 1 (07:19) | `qa-agent-fund` + `qa-real` (one stack, port 8690) | **2 failed, 5 did not run** — "Votre portefeuille principal détient 250 USDC sur Base" not found; `USDC · Base` not among the held assets |
| 1 (07:20) | `qa-plan` (fresh stack, port 8760) | **1 failed** — the plan card is not executable |
| 2 (07:24), after defect 9 | `qa-agent-fund` + `qa-real` | 4 passed (all of `qa-real`), **1 failed, 2 did not run** — `qa-agent-fund`: "no signed transfer to settle" |
| 2 (07:26) | `qa-plan` | **1 failed** — after the approval the plan is `paused`, the spec expected `wait` |
| 3 (07:30), after defect 10 | `qa-agent-fund` + `qa-real` | **7 passed** (3.1 min) |
| 5 (07:35) | `qa-plan` | **1 passed** (1.1 min) — after two more adaptations of the spec (runs 3 and 4 failed on the plan's pause code, then on the resume) |

### Defect 9 — the forks were funded from a USDC holder that no longer holds any (environment; funding made independent of any holder)

`qa-real-server.mts`, `fork-swap-kyber.mts` and `fork-swap-api.mts` took the test wallet's USDC from one hard-coded address
(`0xF977…aceC`) by an impersonated transfer whose result was never checked. Read on Base mainnet on 2026-11-17: that address
holds **0 USDC**. The transfer reverted silently and every funded flow ran on a balance of zero. **Not a V11 regression** (the
same code on `a118e3e` would fail the same way today). The balance is now written in the token's storage and read back through
`balanceOf` (`dealTokenRpc` in `scripts/lib/fork-helpers.mts`, the technique `dealToken` already used), with an explicit
failure if it did not land; `USDC_WHALE=<holder>` keeps the old way, now checked.

### Defect 10 — two QA specs still described the V10 behaviour of a transfer signed while broadcasting is off (specs adapted)

V11 (stabilisation B2) made such a transfer end in the state `not_broadcast` — it was `broadcast` with an error sentence — and
made a plan PAUSE on a leg that was not sent (`leg_failed`, reason `broadcast_disabled`, « Signée, mais NON envoyée », with
retry / re-plan / stop) instead of waiting for ever. Both changes are intended and tested server-side (`v11-stab.test.ts`,
`plan-exec.test.ts`); the two specs had not been run since.
- `qa-agent-fund.spec.ts`, `qa-plan.spec.ts`: the test's stand-in for the network looks for `not_broadcast` (or `broadcast`).
- `qa-plan.spec.ts`: after each approval it now ASSERTS the pause (code, sentence, the three buttons). To walk the second leg
  all the same, its stand-in — scratch database and fork only — puts the plan back where a broadcasting server would have left
  it. So the browser evidence for the second leg of a plan is: reached through a test stand-in, on a fork, never broadcast.
- The spec's documentation pictures (`docs/v7/screens/plan-*.png`) are rewritten by every run; they were restored, not committed.

## 7. Fork proof scripts of the swap / bridge stack (2026-11-17 07:35–07:42 UTC)

**Private anvil forks on 127.0.0.1, fresh throwaway keys, nothing sent to a real network: a fork run is not a mainnet
execution.** One script at a time, `pkill -f anvil; sleep 3` before and after each. Real KyberSwap routes and calldata for the
day's chain state, the real Signer with a software passkey, the real bytecode on the fork.

| Script | Exit | Observed (excerpts) |
|---|---|---|
| `tsx scripts/fork-swap-kyber.mts` | 0 (13 s) | "router bytecode matches the pinned hash"; ETH → USDC: spent 0.01 ETH, received 18.272398 USDC (quoted 18.273659, approved minimum 18.182289), leftover allowance 0; USDC → ETH: received 0.01367927 ETH (minimum 0.01361110); USDC → LINK through two pools: received 1.08863 LINK (minimum 1.07778); "refused (higher minimum than the calldata guarantees)"; **FORK TEST OK** |
| `tsx scripts/fork-swap-api.mts` (full stack: API, signer over HMAC, worker) | 0 (55 s) | ETH → USDC: finalized, minimum 18.189108, received per router event 18.271547 USDC, simulated before approval; USDC → ETH: finalized, approval confirmed, received 0.013675098814060654 ETH; leftover allowance 0; **FULL-STACK FORK TEST OK** |
| `tsx scripts/fork-swap-net.mts base` | 0 (22 s) | ETH → USDC received 18.280334 (minimum 18.097839); USDC → ETH received 0.004999241 (minimum 0.004949335); **FORK TEST OK on Base** |
| `tsx scripts/fork-swap-net.mts ethereum` | 0 (12 s) | fork at block 26 433 317; ETH → USDC received 18.287971 (minimum 18.105088); USDC → ETH received 0.004998130 (minimum 0.004948149); **FORK TEST OK on Ethereum** |
| `tsx scripts/fork-cctp.mts base arbitrum` | 0 (107 s) | the forks carry the reviewed bytecode (TokenMessengerV2, MessageTransmitterV2, TokenMinterV2 on both sides); 3 of 3 public Circle messages carry exactly 2 signatures by attesters enabled on-chain; signer refusals, burn on the Base fork, mint on the Arbitrum fork with TEST attesters (the script's stated simulation), no double mint; full stack Standard and Fast; **FORK CCTP TEST OK (Base → Arbitrum One)** |
| `tsx scripts/fork-agent.mts` | **1** at the first run: "no known holder of USDC on Base could fund the vault" (defect 9, the same environment drift); **0** (52 s) after the storage fallback | paper pass 3 orders; mandate refused before the gas reserve (`409 insufficient_gas`), refused with a passkey signature over something else (`422 signer_bad_approval`); LIVE ETH → USDC received 6.515990 (minimum 6.450921); LIVE USDC → LINK received 1.27103 (minimum 1.25921); signer refuses an order above the per-order limit and an order after revocation; withdraw 54.840423 USDC to the owner; audit chain intact; **AGENT FORK TEST OK on Base** |

Conclusion: the V10 execution paths these scripts prove (signer checks on genuine calldata, minimum received, exact-amount
approvals, CCTP burn / mint, the spot agent's mandate) behave on the V11 tree as their own assertions require. No comparison
run against `a118e3e` was needed: nothing failed for a reason other than the funding holder.
Not run (not in the list): `fork-gmx`, `fork-hl-deposit`, `fork-mandate`, `fork-plan`.
