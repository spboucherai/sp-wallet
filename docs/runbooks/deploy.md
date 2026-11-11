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
   pnpm build                      # dist/api.mjs, dist/signer.mjs, dist/research-runner.mjs, dist/web/
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
   | `SPW_DERIV_LIVE_MAINNET=on` | mainnet derivatives orders and collateral moves answer `mainnet_disabled` |
   | `RESEARCH_DATABASE_URL` | backtest candles are read with the API's own role instead of the read-only one |
   | `SPW_RESEARCH_RUNNER_SECRET` (≥ 32 chars) | the research runner routes answer 404; research jobs stay queued |

   (`SPW_DERIV_MANDATE_MAINNET=on` as well if perp agents trade on mainnet.) Then:
   ```bash
   pm2 restart sp-wallet            # (confirm) keeps the stored environment
   pm2 logs sp-wallet --lines 30 --nostream
   ```
5. **Read the start-up lines** (v8). The API prints, without any value:
   ```
   sp-wallet api listening on … broadcast=on
   [startup] capabilities: deriv_live_mainnet=on deriv_mandate_mainnet=on research_runner=on research_readonly_db=on broadcast=on workers=on strategy_sandbox_enforced=on web_app=on
   [startup] strategy sandbox: sandbox-exec (confined, self-test passed)
   ```
   An `=OFF(missing NAME)` there is the variable that was forgotten. `strategy sandbox: unavailable — …` means no signal
   and no backtest will run (agents hold) until it is fixed — usually the virtualenv of step 2.
6. **Check.** `https://wallet.spboucher.ai/api/v1/health/live`; in the app: Monitoring → *Système* (every loop has a
   recent heartbeat, including `agent-engine`, `perp-agent-engine`, `withdrawals`; *Bac à sable des stratégies: confiné*;
   the capabilities list), Security (signer reachable, key id unchanged).

**Rollback (API):** `git checkout <previous commit>`, `pnpm install --frozen-lockfile && pnpm build`, `pm2 restart
sp-wallet`. The schema changes are additive: the previous code runs on the newer schema. Restore the dump only if data
were damaged (`gunzip -c <file> | psql <new empty database>`, then point `DATABASE_URL` at it).

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
   as in step 1**, the policy version is the expected one, not halted. A different key id means the signer started on
   another keystore: stop, put `signer.mjs.bak-*` back, restart, and investigate before anything is signed.

**Rollback (signer):** put back `signer.mjs.bak-*` (and `state.json.bak-*` only if the new version rewrote the state in a
format the old one refuses), `pm2 restart sp-wallet-signer`.

## 3. Research node — only when `services/research-runner` or `research/` changed

`services/research-runner/README.md`. Its secret is the API's `SPW_RESEARCH_RUNNER_SECRET`.

## `scripts/preflight.sh`

Read-only; prints `ok` / `WARN` / `FAIL` lines, never a secret, exits 1 on a `FAIL`.

```bash
scripts/preflight.sh                       # build artefacts, required and optional environment, signer, disk, last backup
scripts/preflight.sh --db sp_wallet        # + migrate() twice on a scratch database made from `pg_dump --schema-only sp_wallet`
scripts/preflight.sh --env-from-pm2 sp-wallet   # read the variable NAMES the running PM2 process has (values are not printed)
```
