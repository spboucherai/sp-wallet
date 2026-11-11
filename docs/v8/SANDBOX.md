# V8 — every process that runs strategy code is confined by the OS

Before v8 an approved `strategy.py` (possibly written by the AI research agent) ran in a child process with a minimal
environment and a timeout, and nothing else: the laboratory's purity guard is a Python-level lint, not a boundary.
Since v8 **one module starts every laboratory process** — `services/api/src/agents/lab.ts` (`labExec`) — and every such
process is one Python interpreter inside a deny-default `sandbox-exec` profile (`labSandboxProfile` in
`packages/core/src/research-sandbox.ts`). Nothing in signing, limits, policy, mandates or order decisions changed.

| Entry point | Code | Data in | Out |
|---|---|---|---|
| spot signal | `agents/live.ts` `runSignal` | stdin (JSON) | stdout (JSON) |
| perp signal | `agents/perp-signal.ts` `runPerpSignal` | stdin | stdout |
| describe (listing, registration) | `agents/strategies.ts` `describe`, `perp-strategies.ts` `describePerp` | — | stdout |
| spot backtest | `agents/strategies.ts` `backtest` | **files exported by the API** (`exportCandles`) | report file in the scratch directory |
| perp backtest | `agents/perp-strategies.ts` `perpBacktest` | bundle file prepared by the API (unchanged) | report file |
| research evaluation | `research/lab.ts` `labRun` → `labExec` | the job's frozen data set (files) | report files |

## The profile

- **Network: none.** No rule at all — no loopback port, no Unix socket, no DNS, no listening.
- **Process: no `process-fork`.** `fork()`, `posix_spawn()` and `subprocess` fail with `EPERM`; `process-exec` is allowed
  for the interpreter only. So no helper program (`curl`, `sh`, `ps`) can be started and **nothing can outlive a call**:
  the `setsid` escape described in `docs/v7/RESEARCH-RUNTIME.md` needs a fork first and does not exist here. (SBPL has no
  rule for `setsid` itself and none for "fork after setsid"; denying fork is what works. The research *job* profile — a
  coding agent that needs a shell — still allows fork: its residual is unchanged and still documented there.)
- **Other processes are invisible**: `(deny process-info*)` + `(allow process-info* (target self))`, and
  `(deny sysctl-read (sysctl-name-prefix "kern.proc"))`. See "Finding" below.
- **Files, read-only:** `research/src`, `research/schema`, `research/.venv`, the interpreter's install prefix, **the one
  strategy directory of the call**, the caller's data. System: `/usr/lib`, `/System/Library`, the dyld cache, the timezone
  database. Measured on macOS 27 arm64 with the uv-managed CPython 3.12 and the full numerical stack: the interpreter
  runs with *none* of the system paths (everything comes from the dyld shared cache); they are kept as dyld's fallback.
  Not readable: the application checkout beyond those `research/` paths, the home directory, `~/.ssh`, `~/.config`,
  `~/.pm2`, `/usr/bin`, `/etc`, Homebrew (added only when the interpreter itself is a Homebrew build), `/tmp` at large,
  other strategies.
- **Files, read-write:** one scratch directory, fresh per call and removed afterwards (owned by the caller when it needs
  the report). `HOME` and `TMPDIR` point to it.
- **Environment:** built from nothing (`PATH`, `HOME`, `TMPDIR`, `PYTHONPATH`, `PYTHONDONTWRITEBYTECODE`,
  `JOBLIB_MULTIPROCESSING=0`, `MPLCONFIGDIR`, `LANG`, `UV_OFFLINE`). No secret, **no database URL**.
- **Interpreter:** `research/.venv/bin/python -P -s -B -m …` directly. `uv run` is not used any more: under a read-only
  tree it wants its cache and configuration under the home directory; the direct call needs neither.

## The spot backtest no longer opens the database

`spq.backtest` used to receive `DATABASE_URL` (`RESEARCH_DATABASE_URL` when set) and read the `candles` table itself.
Now the API exports the same rows to `<scratch>/data/<source>/<SYMBOL>_<interval>.csv` and passes `--data-dir`/`--source`.
`RESEARCH_DATABASE_URL`, when set, is still where the API reads them from (a read-only session). The laboratory code is unchanged:
pandas 3.1.1 parses decimal text to the exact float64 (200 000 random values written in shortest round-trip form, 0
mismatches; `float_precision="round_trip"` is deprecated there as redundant), i.e. the values of the `double precision` column. The cross-run trial ledger (`research/results/ledger.jsonl`) is written by the API only: the process works on a
copy, the lines it appended are merged, a rewritten history is not.

Proof of identical results: `services/api/test/lab-identity.test.ts` (database path vs file path, every report field but
the timestamp, and the ledger) and, on real data (`spw_v5_market`, ETH/LINK/AAVE, 17 509 hourly bars, 2026-11-11):
`ma_trend/2`, `ts_momentum/2`, `vol_target_trend/2` — three reports of ~160 kB each, byte-identical apart from
`generated_at`.

## Limits of one call

| Limit | How | Measured |
|---|---|---|
| wall clock | timer in the API → `SIGKILL` of the process group (signals 60 s, backtests 20–30 min) | killed at the timeout, process gone |
| CPU seconds | `ulimit -t` set by a `/bin/sh` wrapper **outside** the sandbox, inherited across `exec` (4 × the wall clock, min 60 s) | `ulimit -t 2` kills a busy Python loop with `SIGXCPU` after 2.0 s, also with BLAS threads (CPU time is summed over threads) |
| file size | `ulimit -f` (2 GiB per file) | a 4 MiB write under a 1 MiB limit stops at 1 MiB (`EFBIG`) |
| address space / data / RSS | **not available**: `ulimit -v`, `-d`, `-m` answer `Invalid argument` on macOS 27 arm64, and a Python process allocated 4 GiB under each | — |
| resident memory | a watchdog in the API reads the child's RSS every second (`ps -o rss=`) and kills above the ceiling (signals 2 GiB, others 4 GiB; `SPW_LAB_SIGNAL_MAX_RSS_MB`, `SPW_LAB_MAX_RSS_MB`) | a strategy allocating 32 MiB blocks is killed above a 400 MiB ceiling within seconds. It is a poll, not a quota: a fast allocator can overshoot for up to one second |
| output | signals: killed beyond 100 kB of stdout; others truncated at 2 MB | — |

Latency of one signal call (`ma_trend/3`, 1 000 bars × 2 symbols, 7 runs): sandboxed median **210 ms** (205–215);
the pre-v8 `uv run` median 199 ms (198–211). About +10 ms, 0.006 % of a one-hour bar. The self-test costs ~40 ms every
ten minutes.

## Fail closed

`labExec` refuses to run anything (`LabUnavailable`) when `sandbox-exec` does not exist, the interpreter is missing, or the
profile does not confine. "Does not confine" is decided by a **self-test**: a tiny interpreter run under the real profile
must be refused the home directory, a socket, a fork and a write outside; it runs at first use, every ten minutes, and
again after any sandbox error. Consequences: a signal call throws → the engine holds (`research_log` "Order not placed");
describe answers `bad_strategy`; a backtest ends with a note; a research evaluation is refused.

- Health: `GET /api/v1/monitor/health` → `lab: { mode: 'sandbox-exec' | 'off' | 'unavailable', ok, reason, checkedAt,
  lastFailure, calls, refused }` (Monitor screen), and the start-up line of the API.
- Alerts: `system.lab_sandbox_unavailable` (critical, once per episode), `system.lab_sandbox_back` (info),
  `system.lab_sandbox_off` (critical, once per day while set).
- **Escape hatch, development only:** `SPW_LAB_SANDBOX=off` (default: on). Same interpreter, environment and limits, no
  OS confinement; logged at first use, reported as `mode: 'off'`, alerted daily. Never set it on a machine holding funds.
  The older `SPW_RESEARCH_SANDBOX` is gone (it silently ran the evaluation unconfined when the sandbox was missing).

## Finding fixed on the way: a sandboxed job could read other processes' environment

The V7 profile had a blanket `(allow sysctl-read)`. `sysctl kern.procargs2.<pid>` returns the arguments **and the
environment** of any process of the same user — from inside the research job's sandbox that is the runner's environment
(the model API key, the runner secret) and, on the API node during an evaluation, the API's (`DATABASE_URL`, the signer
secret). Verified: with the V7 profile a sandboxed Python read a canary from another process's environment; `(deny
default)` also did not stop `proc_pidpath` / `proc_listallpids` of other processes. `ps -E` itself was already refused.
Both profiles now carry the two deny rules above (`services/research-runner/test/sandbox.test.ts` "v8: the environment of
a process outside the sandbox…").

## Tests

```bash
npx vitest run services/api/test/lab-sandbox.test.ts     # hostile strategy through the 5 entry points, limits, fail closed
npx vitest run services/api/test/lab-identity.test.ts    # 18 spot + 7 perp library strategies byte-identical; backtest ≡; latency
npx vitest run services/research-runner/test/sandbox.test.ts
```
The hostile strategy (`services/api/test/lab-hostile.ts`) runs in a laboratory copy whose lint is **disabled**, and reaches
files, sockets, fork and `sysctl` through `posix`, `_socket` and `ctypes` — entry points the runtime guard does not patch.
28 attempts at import and again inside `target_weights`, three positive controls through the same primitives; the same
strategy run once unconfined against local stand-ins leaks 14 of them, which shows the probes detect a leak.

## Not closed

- Memory is polled, not capped by the kernel. Existence of a path can still be inferred (`ENOENT` vs `EPERM`), and the
  names in `/` are listable.
- A strategy can still burn CPU up to the timeout and return garbage weights: the engine's and the signer's limits are
  what bound the consequences, as before.
- `sandbox-exec` is deprecated by Apple; on another platform nothing runs unless the development switch is set.
- The research **job** (the coding agent with a shell) keeps `process-fork`; its `setsid` residual is unchanged.
