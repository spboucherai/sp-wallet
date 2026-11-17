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
