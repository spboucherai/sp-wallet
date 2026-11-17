# Deploying a release (API + web, then the signer)

This is the recipe as it is done by hand today, written down so that nothing is forgotten. It is documentation: nothing
here was run while writing it. Where things run is in `operations.md` ("Where things run"): the API node holds
`~/apps/sp-wallet` (PM2 `sp-wallet`, database `sp_wallet`), the signer node holds `~/apps/sp-wallet-signer` (the bundle
only) and `~/sp-wallet-signer-data` (keystore, `state.json`, `policy.json`). Commands marked *(confirm)* use the paths of
`operations.md`; check them on the node before the first use of this page.

**Before anything:** on the API node, from the checkout, `scripts/preflight.sh` (read-only; see the end of this page).

## 1. API node

1. **Code.** In `~/apps/sp-wallet` (a git clone of the deployed app): bring the release in (`git pull` of the release
   commit) and note the previous commit — it is the rollback point: `git rev-parse --short HEAD` before pulling.
2. **Build on the node** (not on a laptop: the bundle embeds the commit and must match the node's Node version):
   ```bash
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm build                      # dist/api.mjs, dist/signer.mjs, dist/research-runner.mjs, dist/agents.mjs (V11: the separate agents worker), dist/web/
   (cd research && uv sync --frozen)   # the laboratory's virtualenv: without it the strategy sandbox is "unavailable" and agents hold
   ```
3. **Backup before a migration.** The schema is applied by the API at start-up (`migrate()`, `create … if not exists` /
   `alter … add column if not exists`: additive, idempotent). Before a release that changes `services/api/src/db.ts`
   (`git diff <previous>..HEAD --stat -- services/api/src/db.ts`):
   ```bash
   DATABASE_URL=postgres:///sp_wallet scripts/backup.sh        # ~/backups/sp-wallet/sp-wallet-YYYYMMDD-HHMM.sql.gz, no key material
   ls -lt ~/backups/sp-wallet | head -2                        # the file exists, is recent and is not empty
   ```
   `scripts/preflight.sh --db sp_wallet` runs the new `migrate()` twice on a scratch copy of the schema first.
4. **Restart — with the environment.** PM2 keeps the environment of the process; a restart that re-reads the shell's
   (`--update-env`) or a `pm2 delete` + `pm2 start` loses whatever is not exported there. Three optional variables are
   easy to forget, and nothing fails loudly without them:

   | Variable | Without it |
   |---|---|
   | `SPW_DERIV_LIVE_MAINNET=on` | NEW mainnet derivatives risk answers `mainnet_disabled` (orders that open or add, leverage changes, authorizations, collateral moves). Since V11 cancels and reduce-only closes of what already exists still work without it |
   | `RESEARCH_DATABASE_URL` | backtest candles are read with the API's own role instead of the read-only one |
   | `SPW_RESEARCH_RUNNER_SECRET` (≥ 32 chars) | the research runner routes answer 404; research jobs stay queued |
   | `SPW_TRADING_API_EXECUTION=on` (V11, default off) | no NEW live risk is placed through the order service: an API key, a live agent and the owner through the trading API answer `execution_disabled`; cancels and strictly reducing orders pass; paper works. A live perp agent needs it as well as the mainnet locks (in BOTH processes when the agents worker is separate) |
   | `SPW_DERIV_MM_MAINNET=on` (V11, default off) | no quote is placed on mainnet: a market-making session answers `mm_mainnet_disabled`. Needs `SPW_DERIV_LIVE_MAINNET`, `SPW_DERIV_MANDATE_MAINNET` and `SPW_TRADING_API_EXECUTION` as well; cancels, reduce-only orders and the dead man's switch pass without any of them |
   | `SPW_DERIV_MM_TESTNET=on` (V11, default off) | no quote is placed on Hyperliquid TESTNET (`mm_testnet_disabled`): the owner's own first go-live step. Needs `SPW_TRADING_API_EXECUTION` as well |

   (`SPW_DERIV_MANDATE_MAINNET=on` as well if perp agents trade on mainnet; without it an agent already live can only
   reduce. `SPW_DERIV_GMX_LIVE` is OFF by default; without it no new GMX position is prepared, closing and cancelling
   still work.) Which of these settings belong in the environment is the owner's decision about what is open on mainnet —
   this runbook does not state it. The three V11 settings (`SPW_TRADING_API_EXECUTION`, `SPW_DERIV_MM_MAINNET`,
   `SPW_DERIV_MM_TESTNET`) are OFF by default and a first V11 deployment leaves them unset (`docs/V11-DEPLOYMENT.md` §4).
   `SPW_WORKERS` takes `on` (default), `off`, `api` (every worker but the agents runtime — only with a separate
   `sp-wallet-agents` process running `dist/agents.mjs` with `SPW_WORKERS=agents`) or `agents`; any other value starts no
   worker at all, without an error. **Before restarting, write down what the running process has**
   (`scripts/preflight.sh --env-from-pm2 sp-wallet` prints the variable names, never a value), and compare after. Then:
   ```bash
   pm2 restart sp-wallet            # (confirm) keeps the stored environment
   pm2 logs sp-wallet --lines 30 --nostream
   ```
5. **Read the start-up lines** (v8). The API prints, without any value, one `name=on` or `name=OFF(missing VARIABLE)` per
   capability:
   ```
   sp-wallet api listening on … broadcast=<on|off>
   [startup] capabilities: deriv_live_mainnet=<…> deriv_mandate_mainnet=<…> deriv_gmx_live=<…> trading_api_execution=<…> deriv_mm_mainnet=<…> deriv_mm_testnet=<…> research_runner=<…> research_readonly_db=<…> broadcast=<…> workers=<…> strategy_sandbox_enforced=<…> web_app=<…>
   [startup] strategy sandbox: sandbox-exec (confined, self-test passed)
   ```
   There is no universally "expected" line: the right one is **the same as before the restart** (step 4), unless this
   deployment was meant to change a setting. The first V11 start ADDS three entries to the line a V10 process printed
   (`trading_api_execution`, `deriv_mm_mainnet`, `deriv_mm_testnet`): all three must read `OFF(missing …)` unless the owner
   decided otherwise; every execution lock of the server is in this line. A capability that turned from `on` to `OFF(missing NAME)` is a variable that
   was lost by the restart; one that turned from `OFF` to `on` opened something nobody decided to open — treat both as a
   failed deployment. For the three derivative settings, `on` means that code path can place orders with real funds on
   mainnet: the project's own documents state that no order was ever accepted by a venue on a funded account from this
   code (`docs/V11-AUDIT.md`, section 10), so `on` is a decision to take knowingly, not a default to restore.
   A derivative setting that is `OFF` no longer strands anything (V11): positions can still be closed and orders cancelled.
   `strategy sandbox: unavailable — …` means no signal
   and no backtest will run (agents hold) until it is fixed — usually the virtualenv of step 2.
6. **Check.** `https://wallet.spboucher.ai/api/v1/health/live`; in the app: Monitoring → *Système* (every loop has a
   recent heartbeat, including `agent-engine`, `perp-agent-engine`, `withdrawals`; *Bac à sable des stratégies: confiné*;
   the capabilities list), Security (signer reachable, key id unchanged).

**Rollback (API):** `git checkout <previous commit>`, `pnpm install --frozen-lockfile && pnpm build`, `pm2 restart
sp-wallet`. The schema changes are additive: the previous code runs on the newer schema. Restore the dump only if data
were damaged (`gunzip -c <file> | psql <new empty database>`, then point `DATABASE_URL` at it).
**Rolling back from V11 to V10 has steps of its own** — rehearsed on a local database on 2026-11-17, see
`docs/V11-DEPLOYMENT.md` §9: release the kill switch and read-only mode first (or run `scripts/v11-rollback-triggers.sql`),
stop the V11-only agents, and revoke every quoting mandate before the signer goes back.

### V11 — what else a deployment must carry

- **The API-key pepper and the webhook signing secrets** are in `trading-api-secrets.json` (mode 600) under `SPW_DATA_DIR`,
  or `~/.config/sp-wallet` when that variable is not set — created at the first API key. It is **not** in the database dump
  (`scripts/backup.sh`), on purpose: a stolen dump cannot verify a key. **Add the file to the secrets backup**; losing or
  regenerating it invalidates every API key. `SPW_API_KEY_PEPPER` (≥ 32 characters), if set, replaces the file's pepper and
  must then survive every restart like the other variables.
- **The quote stream is a websocket** (`wss://…/api/v1/stream`, and `/api/v1/trading/stream` for keys). Caddy's
  `reverse_proxy` tunnels it without any directive and has no default stream timeout: nothing to change on the gateway. A
  Caddy reload (every `mlt` change) closes the open sockets; the clients reconnect by themselves, and the web app falls back
  to polling after three failed attempts. `stream_close_delay` would avoid the cut; it is not set and is a gateway change.
  The API node needs outbound `wss` to the venues' public feeds (Hyperliquid, edgeX, dYdX, Coinbase).
- **`dist/agents.mjs`** is built but not started by a default deployment (`SPW_WORKERS=on`: the agents runtime runs inside
  the API). The separate worker is optional: `docs/TRADING-AGENT-ENGINE.md` §4.
- **New retention loops** run with the workers and need nothing: API usage log (90 days), swap quotes (30 days), preview
  risk evaluations (30 days), market snapshots, the market-making tape (2 days), finished agent jobs (14 days).

### Market making (V11) — what a deployment adds

- **Both processes** that may run agent workers (`sp-wallet`, and `sp-wallet-agents` when it exists) need the SAME values of
  `SPW_DERIV_MM_MAINNET`, `SPW_DERIV_MM_TESTNET`, `SPW_DERIV_LIVE_MAINNET`, `SPW_DERIV_MANDATE_MAINNET` and
  `SPW_TRADING_API_EXECUTION`: the worker that holds an agent's lease applies them at every quote, the API applies them to the
  mandate's approval and to the start. `SPW_MM_MIN_PAPER_MINUTES` (default 30) is the paper session the go-live checklist asks for.
- The capability line at start-up says `deriv_mm_mainnet=…` and `deriv_mm_testnet=…` with the names of the missing settings.
- New tables (additive, created by `migrate()`): `mm_sessions`, `mm_fills`, `mm_tape`; new columns `trading_mandates.quoting`,
  `deriv_fills.seq`. Nothing is rewritten.
- **Restarting a worker with a live session running**: nothing is cancelled by the shutdown. The venue's dead man's switch
  cancels what rests within `deadManSeconds`; the next worker takes the agent's lease (30 s) and starts with cancel-all →
  reconcile → arm → quote. To restart with NOTHING resting: "Pull quotes now" on the agent first, then restart.
- **Rolling the API back** to a build without market making: stop every market-making agent first (its mandate is revoked at the
  signer), or the sessions simply end at the switch's deadline and the mandates stay approved at the signer until revoked.

## 2. Signer node — only when `services/isolated-signer` or `packages/core` changed

The signer is deployed as ONE file. It is copied separately, never built on the signer node, and its data directory is
never touched by a deployment.

1. On the signer node, **back up the two things a bad deployment could cost**:
   ```bash
   cp ~/apps/sp-wallet-signer/signer.mjs ~/apps/sp-wallet-signer/signer.mjs.bak-$(date +%Y%m%d-%H%M)     # (confirm)
   cp ~/sp-wallet-signer-data/state.json ~/sp-wallet-signer-data/state.json.bak-$(date +%Y%m%d-%H%M)     # (confirm)
   ```
   Never copy the keystore or `wrap.key` anywhere. Note the **key id** shown in the app (Security, or Monitoring →
   *Clé du signataire*) before going on.
2. Copy the bundle built on the API node: `scp dist/signer.mjs <signer-node>:apps/sp-wallet-signer/signer.mjs` *(confirm)*.
3. **`policy.json`: leave it**, unless the release changed the DEFAULT limits (new assets, new networks — the release
   notes say so, and `docs/TOKENS.md`). The signer writes its defaults only when the file does not exist; a token without
   a limit cannot be sent (default deny). Only in that case: `mv policy.json policy.json.v<N>` and re-apply by hand any
   limit that had been changed (see `operations.md`, "After a release that adds assets").
4. `pm2 restart sp-wallet-signer` *(confirm)*, then in the app: Security → the signer answers, **the key id is the same
   as in step 1**, the policy version is the one it was, the halt is as it was. A different key id means the signer started on
   another keystore: stop, put `signer.mjs.bak-*` back, restart, and investigate before anything is signed.

**First start of a V11 signer on an older data directory.** Nothing to do by hand. `policy.json` is read, never
rewritten. `state.json` is read in its old format; at the first save the journal it contained is moved, record for record,
to `journal.jsonl` next to it, and `state.json` keeps a reference to the last record (`journalRef`). Three new files appear
in the data directory: `journal.jsonl` (append-only; closed segments are named `journal-<first>-<last>.jsonl`),
`state.json.lock` (the daemon's pid: a second daemon, or a CLI command writing under it, is refused) and `control.sock`
(the operator's commands reach the running daemon through it). `signer.mjs status` shows `journalIntact: true` and the same
`journalLength` as before plus the records written since. The daemon refuses to start on a broken journal, as before.
Back up `journal*.jsonl` with `state.json` from now on (step 1): the state alone no longer holds the journal.

**Rollback (signer):** put back `signer.mjs.bak-*` and `pm2 restart sp-wallet-signer`. **Do not put `state.json.bak-*`
back** unless the state file itself is damaged: it would erase the replay markers, counters and revocations written
since — a revoked mandate would be in force again. The older binary starts on the V11 `state.json` as it is (every field
it knows is unchanged; it finds an empty journal and starts a new one inside the state file). Going forward again later is
supported: V11 moves what the older binary journaled to `journal-rollback-<time>.jsonl` and records that file's last hash
in the main journal. `state.json.lock` and `control.sock` are ignored by the older binary. A `state.json.lock` left by a daemon that was
killed needs no cleaning: V11 takes over a lock whose process no longer exists.

### Signer state added by V11 market making, and the rollback rule

The signer's state file gains two OPTIONAL fields: `venueQuotingMandates` (the approved quoting mandates with their counters,
token bucket and the deadline of the last `scheduleCancel` it signed) and the mark `q: 1` on ledger entries created by quotes. A
state written before loads unchanged. A signer binary from BEFORE this work keeps both fields on disk but does not know them: it
would approve a derivative mandate next to an active quoting mandate, and would no longer bound quotes at all (it has no quoting
route). Therefore:

**Before rolling the signer back: revoke every quoting mandate** (Risk → quoting mandate → revoke, or
`POST /api/v1/mandates/<id>/revoke`; revoking needs no passkey). Check `GET /status` of the signer:
`venueQuotingMandates[].phase` must be `wind_down` or `ended` for all of them. Rolling forward again needs nothing.

## 3. Research node — only when `services/research-runner` or `research/` changed

`services/research-runner/README.md`. Its secret is the API's `SPW_RESEARCH_RUNNER_SECRET`.

## `scripts/preflight.sh`

Read-only; prints `ok` / `WARN` / `FAIL` lines, never a secret, exits 1 on a `FAIL`.

```bash
scripts/preflight.sh                       # build artefacts (the four bundles and the web app), required and optional environment, the V11 execution locks
                                           # (a lock variable that is SET is a WARN to confirm), SPW_WORKERS, the API-key secrets file (mode 600), signer, disk, last backup
scripts/preflight.sh --db sp_wallet        # + migrate() twice on a scratch database made from `pg_dump --schema-only sp_wallet`
scripts/preflight.sh --env-from-pm2 sp-wallet   # read the variable NAMES the running PM2 process has (values are not printed)
```
