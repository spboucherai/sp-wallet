# V7 — research runtime: autonomous research jobs and their isolation

Extends `docs/v3/ARCHITECTURE.md` (trust zones) — it implements the **Research** zone: "can read market data, write
strategy code, backtest, write reports; cannot reach the signer, hold keys, place orders, change a mandate". Nothing in
trading, signing, policy or limits code changed.

An owner writes a mission in plain language ("Développe une stratégie statistique BTC/ETH, teste-la sur données
historiques et prépare une simulation avec un capital virtuel de 1 000 USDC"). An AI coding agent (Claude Code, headless)
works on it on a research node, inside an OS sandbox, and hands in a strategy with its notes. The wallet's server then
re-does everything itself — hash, purity check, backtest on data the agent never had — and leaves a `draft` version for
the owner to approve. Approval → paper trading → mandate are the existing, unchanged steps.

```
owner (web)          wallet API (services/api/src/research)              research node (services/research-runner)
  mission, budgets ─► research_jobs: queued
                      freeze data set: full/ (server only)  dev/ ─┐
                                                                   │  POST …/runner/claim   (runner secret)
                                                                   └► job + DEVELOPMENT data only
                                                                      job dir ro/ (lab @commit, data, brief)  rw/ (work)
                                                                      sandbox-exec ─ agent ─ model gateway ─► model API
                      research_job_log ◄── POST …/runner/jobs/:id/log (job token) ── log lines, budgets enforced outside
                      evaluating      ◄── POST …/runner/jobs/:id/result ─────────── archive + runner's trial ledger
                      static check → install rj_<job>/1 → describe → replication + HOLDOUT backtest (sandboxed, offline)
  claims | measured ◄ strategy_versions: draft + SERVER report, research_log, alert
  approve ──────────► existing flow: approved → paper trading → (mandate, passkey)
```

## Threat model

The agent is an LLM driving a shell. Assume it can be wrong, be steered by text it reads, or write hostile code.
What it produces is **untrusted**: a `strategy.py`, text files, numbers. What must hold whatever it does:

| It must not… | Because |
|---|---|
| reach the signer, the wallet API's owner routes, the main database, any key or secret, the application checkout | the OS sandbox (below); the research node has none of them; the runner holds one secret that opens three routes |
| raise its own limits | budgets live in the job row, are enforced by the runner from outside the agent's process tree |
| tune on the test split | the test split is never sent to the research node |
| hide trials | the ledger is copied out of its reach as it grows; the server counts every line |
| have its numbers believed | the server re-computes everything; the agent's numbers are shown as claims, next to the server's |
| have its code run with privileges before approval | static check first, then only sandboxed laboratory processes, offline, from files |
| get a strategy traded without the owner | a version needs the server's report to be approved; approval, paper, mandate are separate owner actions |

Prompt injection through data: a job has **no web access** (no web tool can be listed in a job; the model gateway refuses
server-side web/code tools; the sandbox has no network). Market data are numeric CSV/Parquet files. The owner's mission
is quoted as data in the brief. And nothing depends on the agent behaving: every control above is outside it.

## Isolation: what the OS enforces, and what is convention

The agent (and every process it starts) runs under `/usr/bin/sandbox-exec` with the profile built by
`packages/core/src/research-sandbox.ts` (`(deny default)`), in its own process group, with an environment the runner
builds from nothing. Verified on macOS 27.0 (Darwin 27.0.0, arm64) by `services/research-runner/test/sandbox.test.ts`:
a real job whose agent attempts each access from node, python and system binaries.

**Enforced by the kernel sandbox (each one attempted and denied in the test):**

| Attempt from inside the job | Result |
|---|---|
| list `~`, `~/.ssh`, `~/.config`, `~/Library/Keychains`; read the application checkout (`package.json`, `services/api/src`) | `EPERM` |
| read / stat a secret elsewhere on the machine; read it through a symlink created in the job; hard-link it into the job | `EPERM` |
| write outside the job directory; write the laboratory code or the data (`ro/`) | `EPERM` |
| read or write the runner's state (its ledger copy, the sandbox profile) | `EPERM` |
| TCP to the wallet API's port, the signer's port, 8650, 8651, 5432, any other loopback port, IPv6 loopback | `EPERM`, nothing reached the listeners |
| TCP to the internet (1.1.1.1:443, an IP on :80), to the LAN; UDP; DNS; listening | `EPERM` / `ENOTFOUND` |
| Unix sockets (a local service, PostgreSQL's `/tmp/.s.PGSQL.5432`) | `EPERM` |
| keychain (`security list-keychains`, `find-generic-password`) | fails (no Mach service lookup) |
| signal a process outside the sandbox | `EPERM` |
| `curl https://…`, `ssh host` started from inside | get nowhere |
| **allowed, and must work:** read `ro/`, write `rw/`, connect to the job's model gateway port | ok |

The profile allows: reading system libraries/binaries, Homebrew's programs (not its `etc/` or `var/`), the laboratory's
virtualenv and interpreter, the agent CLI's install directory, `<job>/ro`; reading and writing `<job>/rw`; outbound TCP
to **one loopback port**; fork/exec; signals inside the sandbox. No Mach lookup, no other device than null/zero/random.

**The only network door** is the job's model gateway (`services/research-runner/src/gateway.ts`), a process of the
runner. SBPL cannot filter by host name — only `localhost:<port>` — so the policy "the model API and nothing else" is
the gateway's: it serves `POST /v1/messages` and `/v1/messages/count_tokens` only, to the job's placeholder key only,
to one fixed https upstream; it **replaces the credentials** (the real model key stays in the runner: the agent's
environment contains no secret at all); it refuses server-side web-search / web-fetch / code-execution tools and remote
MCP servers; it counts tokens and stops serving when the budget is spent. The candle "source" is not a network
destination at all: data are files exported by the API (no database role on the research node, not even the read-only one).

**Enforced by the runner, outside the agent (not by the kernel):**
- wall time, trial count, disk, model tokens → `SIGKILL` of the process group, outcome `over_budget`, nothing submitted;
- the trial ledger copy (append-only, in the runner's state directory) and tampering detection;
- the submission is read with `O_NOFOLLOW`, regular files with one link only, expected names and sizes only;
- the job directory is created outside any application checkout and deleted afterwards.

**Convention or residual — not enforced:**
- A process that leaves the agent's process group (`setsid`) survives the kill. It stays inside the sandbox (inherited,
  irrevocable), loses its network when the gateway closes and its files when the directory is removed; it can still burn
  CPU until the node is cleaned. Disk is polled (every ~2 s), not a quota: a fast writer can overshoot briefly.
- No CPU/memory limit. A path that does not exist answers `ENOENT`, one that exists `EPERM`: existence can be inferred.
- The agent can run its own backtest code instead of `spq.job` and so **not record trials**. Then the count is a lower
  bound. This cannot buy it a better holdout result (it has no holdout data); it can only make the deflated Sharpe ratio
  less harsh than it should be. The runner's ledger, the tamper flag and the trial budget make the honest path the easy one.
- The model itself knows market history up to its training cut-off; a holdout period earlier than that is not unseen by
  the model in the strict sense. Recent bars are.
- `sandbox-exec` is deprecated by Apple (still what macOS ships and what this was tested on). On a platform without it the
  runner refuses to start unless `SPW_RUNNER_SANDBOX=off`; a job run that way says `sandbox: none` in its result and the
  UI shows a warning.
- The coding agent's own permission system (`--permission-mode dontAsk`, tool list) is convenience, not a boundary.
- **After approval**, a job strategy runs like any library strategy: in the engine's signal process, which has a minimal
  environment and a timeout but **no OS sandbox** (`services/api/src/agents/live.ts`, unchanged here — trading code).
  The laboratory's purity guard is "a guard against mistakes, not a security sandbox". The owner should read the code
  shown on the job before approving; wrapping the signal process in the same profile is the natural next step.

## The job

`POST /api/v1/research/jobs` `{ agentId?, kind: spot|perp, mission, universe, interval, capitalUsd, budgets, tools }`.
For an agent, kind / universe / interval are the agent's. States: `queued → preparing → running → evaluating →
submitted | failed | cancelled | over_budget` (`packages/core/src/research-job.ts`, `RESEARCH_TRANSITIONS`).

Budgets (owner, per job; defaults): `wallSeconds` 3600, `maxTrials` 200, `maxDiskMb` 512, `maxModelTokens` 5 000 000
(counted by the gateway), `maxModelUsd` 10 (as reported by the CLI at the end of a run, and passed to it as
`--max-budget-usd`: the token budget is the outside enforcement, the dollar figure is the CLI's own).

**Data and the holdout.** At creation the API freezes a data set under `<SPW_DATA_DIR>/research-jobs/<id>/`: `full/`
(spot: the `candles` table, one source; perp: the venue's candles and funding through the existing store) and `dev/`,
cut where the laboratory's own test split starts (`python -m spq.job split`, last 20 % of the bars). The runner receives
`dev/` only. The server's report is computed on `full/`, and is refused unless its test split starts at or after the cut.

**Trials.** `spq.research.Experiment` appends every trial and every test evaluation to `$SPQ_JOB_LEDGER` whatever ledger
the caller passed. The runner copies each line to its own file as it appears. `spq.job evaluate` seals the inner test
split across processes (a second evaluation with another `strategy.py` hash exits 7). The server passes the runner's
copy as `--job-ledger`: trials = this run's + **every line** of the job's; variance of trial Sharpe ratios = the larger
of (server's own) and (own + job's) — numbers written by the job can only make the correction harsher
(`spq.dsr.deflate_for_job`).

## The coding agent

`services/research-runner/src/job.ts` `agentArgv`. Claude Code 2.1.x, headless:

```
claude -p "<kick-off>" --bare --output-format stream-json --verbose --append-system-prompt-file <job>/ro/CLAUDE.md
  --tools Read,Write,Edit,Glob,Grep,Bash --allowedTools <same> --disallowedTools WebFetch,WebSearch
  --permission-mode dontAsk --permission-prompts none --strict-mcp-config --disable-slash-commands
  --no-session-persistence --max-budget-usd <n> [--model <m>]
```
`--bare`: no hooks, plugins, memory, CLAUDE.md discovery, and no keychain/OAuth read — its only credential is
`ANTHROPIC_API_KEY`, here the job's placeholder, with `ANTHROPIC_BASE_URL` = the gateway. In bare mode the CLI exposes
Bash, Edit and Read (observed); the other names in the list have no effect. The standing instructions are
`services/research-runner/src/brief.ts` (role, rules of evidence, the laboratory's commands, what to hand in, what it
may not do). The agent command is pluggable (`SPW_RUNNER_AGENT=command`): tests use `test/fixtures/fake-agent.mjs`.

## The endpoint pair

`/api/v1/research/runner/*` accepts `Authorization: Bearer $SPW_RESEARCH_RUNNER_SECRET` (≥ 32 chars; unset = the routes
answer 404) and nothing else; `server.ts` sends these paths to `runnerGate()` instead of the owner-session check, and the
secret opens no other path. `claim` → the oldest queued job with ready data, plus a per-job token (stored hashed);
`jobs/:id/log` and `jobs/:id/result` need that token, answer 403 for any other job, and the token dies with the result.

## Reading a submission (web: an agent's page → *Recherche autonome*, or `/research`)

- **Ce que l'agent affirme — NON VÉRIFIÉ**: README (hypothesis, mechanism, what would refute it), notes, the code and
  its SHA-256, the summary it wrote. Statements.
- **Ce que le serveur a mesuré — MESURÉ**: the test split the agent never had (return vs buy and hold, Sharpe with its
  bootstrap interval, drawdown), per-split returns, *Essais comptés* (job + server), *Sharpe déflaté* (below 0.95: no
  skill established), the report's own checks, whether the server ran it sandboxed.
- **Déclaré / reproduit**: the agent's numbers next to the server's re-run of the same evaluation on the agent's own
  data. The laboratory is deterministic: an honest row is identical; a red row is a number the agent changed.
- A report never says a strategy is profitable. *Approuver* pins the code hash for the agent; it moves no funds.

## Deployment (not done here)

API node: set `SPW_RESEARCH_RUNNER_SECRET` (new, random, ≥ 32 chars — not the signer secret), optionally
`SPW_RESEARCH_LAB_COMMIT`; `research/.venv` must exist (`uv sync --frozen`) for the sandboxed evaluation;
`research/strategies/rj_*` is git-ignored and restored from the database at start-up if missing.
Research node: `services/research-runner/README.md` and `deploy/research-runner.manifest.draft.json`.

## Proof

```bash
npx vitest run services/research-runner services/api/test/research.test.ts   # sandbox denials, state machine, gateway, API
cd research && uv run --frozen pytest -q tests/test_job.py
npx tsx scripts/sim-research-job.mts                # fake agent: honest job, lying agent, timeout, impure code, probe table
npx tsx scripts/sim-research-job.mts --claude-mock  # the REAL Claude Code CLI in the sandbox, scripted mock model
RESEARCH_SHOTS=1 npx playwright test -c tests/e2e/playwright.config.ts research.spec.ts   # docs/v7/screens/research-*.png
```
