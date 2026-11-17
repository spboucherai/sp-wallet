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
