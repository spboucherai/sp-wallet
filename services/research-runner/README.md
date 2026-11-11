# SP Wallet research runner

A small standalone service for a **research node** — a machine that is neither the wallet API's nor the signer's. It
pulls research jobs from the wallet API, runs an AI coding agent on each inside an OS sandbox, enforces the owner's
budgets from outside, and pushes back a log and one result. Design and threat model: `docs/v7/RESEARCH-RUNTIME.md`.

It holds: its own shared secret, the API's URL, a laboratory checkout, and a model credential. It never holds a wallet
secret, a database URL or the signer's address, and refuses to start if `DATABASE_URL`, `RESEARCH_DATABASE_URL`,
`SPW_SIGNER_*`, `SPW_ORIGIN` or `SPW_RP_ID` are in its environment.

## Install on a research node (macOS)

```bash
# 1. a SPARSE checkout: the laboratory only — the application code is not on this machine
git clone --filter=blob:none --no-checkout gitsrv:srv/git/sp-wallet.git ~/sp-wallet-lab && cd ~/sp-wallet-lab
git sparse-checkout set research && git checkout main
cd research && uv sync --frozen                      # the laboratory's Python environment (read-only for jobs)

# 2. the runner bundle (built from the same commit on a build machine: node scripts/build.mjs → dist/research-runner.mjs)
mkdir -p ~/sp-wallet-research && cp research-runner.mjs ~/sp-wallet-research/

# 3. the coding agent
npm install -g @anthropic-ai/claude-code             # /opt/homebrew/bin/claude
```

Environment (PM2 / launchd; a file readable by the service user only):

| Variable | Meaning |
|---|---|
| `SPW_RUNNER_API_URL` | the wallet API, e.g. `https://wallet.example` |
| `SPW_RUNNER_SECRET` | the same value as the API's `SPW_RESEARCH_RUNNER_SECRET` (≥ 32 characters, used for nothing else) |
| `SPW_RUNNER_LAB_DIR` | `~/sp-wallet-lab/research` |
| `ANTHROPIC_API_KEY` | a **dedicated** model key for research (or `CLAUDE_CODE_OAUTH_TOKEN`). Read once, removed from the environment, given to the per-job gateway. Jobs never see it. |
| `SPW_RUNNER_HOME` | default `~/sp-wallet-research` (`jobs/`, `state/`); must not be inside a checkout |
| `SPW_RUNNER_ID`, `SPW_RUNNER_MODEL`, `SPW_RUNNER_CLAUDE_BIN`, `SPW_RUNNER_POLL_MS` | optional |
| `SPW_RUNNER_LAB_PIN` | `commit` (default: `git archive` of the job's pinned commit; `git fetch` it first) or `worktree` (development) |
| `SPW_RUNNER_SANDBOX` | `off` only on a platform without `sandbox-exec`; every result then says `sandbox: none` |

Run: `node ~/sp-wallet-research/research-runner.mjs`. A draft manifest for the cluster's deployment tool is in
`deploy/research-runner.manifest.draft.json` (to be adapted to the tool's schema; it has no secret in it).

After a laboratory update: `git -C ~/sp-wallet-lab pull && (cd ~/sp-wallet-lab/research && uv sync --frozen)`. A job
pinned to a commit whose `uv.lock` differs from the environment is refused, not run.

## What a job looks like on disk

```
~/sp-wallet-research/jobs/<id>/ro/   lab/ (src, schema, strategies as examples)  data/  JOB.json  CLAUDE.md   read-only
~/sp-wallet-research/jobs/<id>/rw/   work/ (cwd)  work/submission/  ledger/trials.jsonl  tmp/  home/          read-write
~/sp-wallet-research/state/<id>/     ledger.jsonl (append-only copy)  profile.sb                              runner only
```
The job directory is removed when the job ends (`SPW_RUNNER_KEEP_JOBS=1` keeps it); `state/` stays.

## Tests

`npx vitest run services/research-runner` — the state machine with the fake agent (`test/fixtures/fake-agent.mjs`),
the sandbox denials (macOS), the gateway against a fake model API. No model call, no network.
