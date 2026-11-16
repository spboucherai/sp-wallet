# SP Wallet V11 — deployment plan

**This is a plan. It has not been executed, in whole or in part.** Production runs V10 (`a118e3e`). Nothing here was
tried on a production node; no production value was read. The procedure extends `docs/runbooks/deploy.md` (the current
text on `v11`, as rewritten by `v11-stab-signer`) with what V11 adds; where this page and the runbook differ, the
difference is something the runbook does not cover yet (`V11-REMAINING-LIMITATIONS.md` 11.4).

Release to deploy: branch `v11` once the two open workstreams are merged (`v11-mm-live`, `v11-ui`) and the final test run
is recorded in `V11-TEST-RESULTS.md`.

<!-- PENDING: release commit — the commit of `v11` that is deployed, after the merges of v11-mm-live and v11-ui, and the final full-suite result that authorises it -->

---

## 1. Authorizations required from the owner

Nothing below may be done on the owner's behalf without an explicit yes to that line.

| # | Decision | What it commits to | Source |
|---|---|---|---|
| A1 | **Deploy V11** (API + web + signer) | the behaviour changes of section 3; a schema migration; a new signer binary | this page |
| A2 | **Signer behaviour changes, Phase B** — each one: (1) under halt the signer signs a manual reduce-only Hyperliquid order, a GMX decrease and a GMX cancellation, with the passkey; (2) a reduce-only trigger order may carry prices outside `maxPriceDeviationBps` on its protective side; (3) `POST /venue/authorization` returns a stored `approveAgent` signature again without a passkey; (4) a second active spot mandate per vault is refused; (5) every priced signature requires Kraken to report `online`; (6) on-disk format: `journal.jsonl`, `journalRef`, `state.json.lock`, `control.sock`; (7) the CLI's `halt` / `unhalt` / `reset-passkeys` / `setup-token` reach the running daemon — `unhalt` takes effect at once, without a restart | a human reading of the diff of `services/isolated-signer/src/{venue,venue-gmx,venue-mandate,signer,server,store,control,main,prices}.ts` and `packages/derivatives/src/live/canonical.ts` | `docs/v11/work/stab-signer.md`, "For the reviewer before any deployment" |
| A3 | **Signer behaviour changes, quoting mandate** — the nine items: new mandate kind `SPW-VENUE-QUOTING-MANDATE-v1`; a seventh path that signs without a per-operation passkey (`POST /venue/quoting/sign`); multi-order actions and `scheduleCancel` signed by the trading key; quotes outside the authorization's `maxOrdersPerDay`; a directional mandate refused while a quoting mandate is active; a new outbound `orderStatus` read; new optional state fields; journal volume; status fields. **These ship in the signer bundle of `v11` whether or not market making is ever enabled** | a human reading of `venue-quoting.ts`, `venue-read.ts`, `live/quoting.ts`; or the decision to deploy a signer built without them | `docs/v11/work/mm-core.md` §2 |
| A4 | Enable `SPW_TRADING_API_EXECUTION` | live orders by API keys and by live agents under a mandate | `docs/V11-SECURITY-REVIEW.md`, "Items for human review" and their status table; `TRADING-PRODUCTION-READINESS.md` |
| A5 | Enable or keep `SPW_DERIV_LIVE_MAINNET`, `SPW_DERIV_MANDATE_MAINNET`, `SPW_DERIV_GMX_LIVE` | new mainnet risk on code never accepted by a venue on a funded account | `docs/V11-AUDIT.md` §10; runbook step 5 |
| A6 | Enable `SPW_DERIV_MM_MAINNET` — **live market making** | the ten-item go-live checklist of `docs/V11-MARKET-MAKING.md` §11, starting with the written acceptance that the only evidence is negative and that maker fees are paid, and including a testnet session with test funds | `docs/v11/work/mm-core.md` §5 |
| A7 | The six live limits (section 8) | what the owner's real orders may do after deployment | `docs/TRADING-RISK-ENGINE.md` |
| A8 | Optional: separate agents worker; `stream_close_delay` in Caddy; third RPC endpoints; 0x / 1inch keys | sections 6, 7 | — |

<!-- PENDING: market-making integration (branch v11-mm-live) — additional signer or API behaviour changes it introduces, to be added to A3 / A6 with their source note -->

---

## 2. Preconditions

1. A1–A3 given. The final run of `V11-TEST-RESULTS.md` recorded.
2. On the API node, from the checkout: `scripts/preflight.sh --db sp_wallet --env-from-pm2 sp-wallet` with no `FAIL`
   (read-only; runs the new `migrate()` twice on a scratch copy of the schema; prints variable names, never values).
   The script does not know the V11 additions (it checks `dist/api.mjs`, `dist/signer.mjs`, `dist/web/index.html`, four
   required and three optional variables).
3. **Write down the current start-up line and the variable names of the running process** before anything
   (runbook step 4). They are the reference for "nothing changed that was not meant to".
4. Note the signer **key id** (Security screen) and whether a spot mandate, a venue authorization or a derivative
   mandate is active (`node signer.mjs status` on the signer node).
5. Know which agents are LIVE today: after deployment they only reduce until a new mandate exists (section 3).
6. If the deployment happens after 2026-11-18T00:00Z: the Anthropic rows of Private Markets show "definition under
   review" and no valuation — expected (`V11-REMAINING-LIMITATIONS.md` 9.1).

---

## 3. What changes at deployment, without any lock being touched

| Change | Effect on day one | Source |
|---|---|---|
| Unified risk engine on every live path | the owner's live orders that add risk are **refused until six limits are set** (section 8); cancels and reductions unaffected; paper unaffected | `work/exec.md` §10; `work/exec2.md` §9 |
| One-time seed of the live limits | at the first `ready`, `risk.limits.live.seed` is derived from the venue account policies (minimum over accounts); written once, never recomputed; audit event `risk.limits_seeded` | `docs/V11-RISK-MODEL.md` |
| Live perp agents | an agent whose mandate predates V11.2 only reduces; adding risk again needs a new trading mandate (two passkey prompts), **and** `SPW_TRADING_API_EXECUTION=on`; default leverage of a new agent mandate is 1× | `work/agents-bind.md` §1, §3 |
| Spot mandates | at the first engine pass, every active spot mandate on the signer that no LIVE agent owns is **revoked** (after a 120 s grace); pausing or stopping a spot agent revokes its mandate | `work/stab-signer.md` §3 |
| Exits | a lock that is off, the kill switch and the signer halt no longer block a cancel or a reduce-only close | `work/stab-signer.md` §1, §2 |
| Loosening API-side limits, lifting an API-side halt, re-basing a divergence | need the passkey | `work/stab-signer.md` §8, §9 |
| GMX | real loss limits (5 % daily, 20 % total of allowed gross exposure by default) and a kill switch | `work/stab-signer.md` §9 |
| Swap, bridge, native-swap preparation | a repeated `Idempotency-Key` answers the same proposal (was 409); `409 quote_moved` when the firm output is below the displayed minimum | `work/stab-swaps.md` §3, §4 |
| Activity and CSV | GMX rows are `gmx`; the CSV `direction` is the real kind, three columns added | `work/stab-swaps.md` §6 |
| Signer price source | one more Kraken request per 15 s of use; anything but `online` refuses every mandate and venue order | `work/stab-signer.md` §10 |
| New surfaces, all read-only or paper until a lock is on | trading API (41 operations), Developer screen, Markets, Compare, Private Markets, Risk, Agents panel, websocket stream | module documents |

---

## 4. Environment variables and locks

"As currently set" = the value the running process has; this plan does not assert it. `on` means exactly the string
`on` (`capabilities.ts` `isOn`). Defaults verified in `services/api/src/config.ts`, `capabilities.ts` and the files named.

### 4.1 Execution locks

| Variable | Code default | Initial value for the V11 deployment | Closes when off |
|---|---|---|---|
| `SPW_TRADING_API_EXECUTION` (new; `orders/index.ts`) | off | **off (leave unset)** | every NEW live risk asked through the order service — keys, agents and the owner's session through the trading API: 403 `execution_disabled`; cancels and strictly reducing orders pass; paper works |
| `SPW_DERIV_MM_MAINNET` (new; `mm/live-adapter.ts`) | off | **off (leave unset)** | live quoting on mainnet (third of three locks; the engine is not wired on `v11`) |
| `SPW_DERIV_LIVE_MAINNET` | off | as currently set | new mainnet derivatives risk, authorizations, collateral moves |
| `SPW_DERIV_MANDATE_MAINNET` | off | as currently set | mandate orders that add risk on mainnet |
| `SPW_DERIV_GMX_LIVE` | off | as currently set | new GMX positions |
| `SPW_BROADCAST` | on | as currently set (production relays) | relaying signed transactions (test mode) |

The start-up capability line reports the last four and not the first two (`capabilities.ts` has no entry for them). The
state of `SPW_TRADING_API_EXECUTION` is visible on the Risk screen (`GET /api/v1/risk/state` → `locks`) and in
`GET /api/v1/developer/status`.

### 4.2 Existing variables the restart must carry

Required (the API does not start without them): `SPW_ORIGIN`, `SPW_RP_ID`, `DATABASE_URL`, `SPW_SIGNER_SECRET`.
Set at deploy time: `SPW_SIGNER_URL` (the relay, `127.0.0.1:8652` per `operations.md`), `PORT`, `HOST`,
`SPW_TRUST_PROXY`, `SPW_WEB_DIR`.
Named by the runbook as easy to lose and silent when lost: `SPW_DERIV_LIVE_MAINNET`, `RESEARCH_DATABASE_URL`,
`SPW_RESEARCH_RUNNER_SECRET` (≥ 32 characters), and `SPW_DERIV_MANDATE_MAINNET`, `SPW_DERIV_GMX_LIVE` where used.
Others that exist in the code and may be set: `SPW_DATA_DIR`, `SPW_RESEARCH_*`, `SPW_LAB_SANDBOX` (never `off` in
production), `SPW_VAPID_SUBJECT`, `SPW_PUSH_ALLOW_HOSTS`, `SPW_RPC_OVERRIDE`, `SPW_MARKET_*`, `SPW_SWAP_ENABLE` /
`SPW_SWAP_DISABLE`.

### 4.3 New optional variables (none is needed for the initial deployment)

| Variable | Default | Recommended initially | Meaning |
|---|---|---|---|
| `SPW_WORKERS` | `on` | **`on` (unchanged)** | new values `api` (every worker except the agents runtime) and `agents` (the separate worker only); `off` = HTTP only |
| `SPW_API_KEY_PEPPER` | unset | unset | ≥ 32 characters: replaces the pepper of the secrets file |
| `SPW_API_USAGE_RETENTION_DAYS` | 90 | default | usage-log retention |
| `SPW_RISK_CONTEXT_TTL_MS` | 2000 | default | sharing of venue reads between risk evaluations (0 = none, ≤ 30 000) |
| `SPW_STREAM_MAX_CONN_OWNER` / `_KEY` / `SPW_STREAM_MAX_CONN` / `SPW_STREAM_MAX_SUBS` | 12 / 4 / 200 / 300 | default | websocket limits |
| `SPW_RPC_EXTRA` | unset | unset (owner's choice, A8) | JSON map of additional https RPC endpoints per network |
| `SPW_SWAP_QUOTES_RETENTION_DAYS` | 30 (never under 8) | default | pruning of `swap_quotes` |
| `ZEROX_API_KEY`, `ONEINCH_API_KEY` | unset | unset | quote-only comparison sources; without a key they are never asked. No live call was ever made with either |
| `SPW_LAB_RESULTS_RUN` | `2026-11-15-v11` | default | which committed lab run the Agents panel shows |
| `SPW_LAB_EXTRA_STRATEGIES` | unset | unset | extra strategy names in the library manifest |
| `SPW_AGENT_BAR_MS` / `SPW_AGENT_JOBS_MS` / `SPW_AGENT_SUPERVISOR_MS` | 60 000 / 5 000 / 60 000 | default | cadence of the separate agents worker only |

### 4.4 The restart line

PM2 keeps the environment of the process. Because every new lock starts **off** and every new variable is optional, the
initial deployment needs no new variable: `pm2 restart sp-wallet` (no `--update-env`, no `pm2 delete`) carries the
stored environment as it is — which is the runbook's rule. If a variable must be added later (a lock, `SPW_RPC_EXTRA`),
`--update-env` re-reads the shell: **every** variable of 4.2 must then be exported in that shell, or it is lost. Compare
the variable names before and after (`scripts/preflight.sh --env-from-pm2 sp-wallet`).
`docs/TRADING-AGENT-ENGINE.md` places the environment in the mld manifest of the app
(`M1M32:~/dispatch/apps/sp-wallet.json`); if the app is restarted through `mld`, the same rule applies to the manifest's
`env` block.

---

## 5. Secrets and files to back up from now on

| What | Where | Why | In the nightly database backup? |
|---|---|---|---|
| **API-key pepper and webhook signing secrets** — `trading-api-secrets.json` (0600, directory 0700) | `SPW_DATA_DIR` or `~/.config/sp-wallet` on the API node; created at first use | losing or regenerating it invalidates every API key; the file refuses to load if malformed | **no** (by design: a stolen dump cannot verify a key) — add it to the secrets backup |
| Signer `journal.jsonl` and closed segments `journal-<first>-<last>.jsonl`, `journal-rollback-<time>.jsonl` | `~/sp-wallet-signer-data` on the signer node | since V11 `state.json` holds only a reference to the journal; the daemon refuses to start on a broken journal | n/a — back up with `state.json` |
| `state.json` | same | replay markers, counters, revocations, mandates | n/a |
| `state.json.lock`, `control.sock` | same | runtime only: **not** to back up or restore; a stale lock is taken over by V11 | — |
| Never copied anywhere | keystore, `wrap.key` | runbook | — |

New packages in the build: `packages/trading` (`@spw/trading`, a dependency of the API), `packages/trading-sdk`
(not deployed: a client library), `sdk/python` (idem). New direct dependencies of the API: `@fastify/websocket` 11.3.7,
`ws` 8.22.2 (`pnpm install --frozen-lockfile` brings them). New bundle: `dist/agents.mjs` (fourth output of
`scripts/build.mjs`).

---

## 6. Database migration

Applied by the API at start-up (`migrate()`), idempotent. `git diff a118e3e v11 -- services/api/src/db.ts` removes no
line. Tables, columns and triggers: `V11-ARCHITECTURE.md` §6.

Not purely structural — these run once on existing rows:

| Statement | Effect on a production database |
|---|---|
| `update proposals … set state = 'not_broadcast' where state = 'broadcast' and error like 'broadcast disabled%'` | none if production never ran with `SPW_BROADCAST=off` |
| `update agents set family = …`; `insert into agent_config_versions …` (version 1) | every existing agent gets a family (inferred from its strategy name) and configuration version 1 |
| `update strategy_versions set approved_by = 'owner' …` | existing approvals are recorded as the owner's |
| `update research_log set mode = spw_agent_mode_at(…)`; `insert into agent_signals … from perp_agent_signals … on conflict do nothing` | journal lines and perp signals get a mode from the audit chain; `perp_agent_signals` is kept and no longer written |
| `alter table agent_order_intents alter column … drop not null`; constraint `agent_order_intents_one_truth` | on a table created by the same migration |
| migration of `settings['agents.kill_switch']` | nothing in production (the key existed only on V11.1 development databases) |
| triggers on **existing** tables: `deriv_orders`, `deriv_gmx_ops`, `proposals`, `agent_orders` (queue + gate), `research_log` (defaults) | one more insert per engine write; a spot agent's insert can now be **refused** by `agent_orders_gate` |

Backup first (runbook step 3): `DATABASE_URL=postgres:///sp_wallet scripts/backup.sh`, then check the file is recent
and not empty.

---

## 7. Order of operations

1. **Preflight and notes** (section 2).
2. **Backups**: database (`scripts/backup.sh`); on the signer node `signer.mjs.bak-<date>` and `state.json.bak-<date>`
   (runbook, signer step 1); the previous commit of `~/apps/sp-wallet` (`git rev-parse --short HEAD`).
3. **API node — code and build** (runbook steps 1–2), on the node:
   `pnpm install --frozen-lockfile && pnpm typecheck && pnpm build && (cd research && uv sync --frozen)`.
   Check the four bundles exist (`dist/api.mjs`, `dist/signer.mjs`, `dist/research-runner.mjs`, `dist/agents.mjs`) and
   `dist/web/`.
4. **Signer node** (`services/isolated-signer` and `packages/core` both changed):
   copy `dist/signer.mjs`; **leave `policy.json` exactly where it is — do not move, delete or regenerate it.** V11
   changes no default limit and no policy version (`work/stab-signer.md`: "Policy limit values, defaults and the policy
   version are unchanged; `policy.json` is never rewritten by the new code"). The project's operating rule is that the
   policy file is never deleted at a deployment: when a release does add limit keys, they are merged into the existing
   file by hand (`operations.md`, second option) so that limits changed by the owner are not lost.
   `pm2 restart sp-wallet-signer`.
   Check: `node signer.mjs status` → `journalIntact: true`, `journalLength` = before + the records since; the three new
   files exist (`journal.jsonl`, `state.json.lock`, `control.sock`); in the app, **same key id**, same policy version,
   halt as it was. A different key id: stop, restore `signer.mjs.bak-*`, restart, investigate.
5. **API restart**: `pm2 restart sp-wallet`; `pm2 logs sp-wallet --lines 30 --nostream`.
6. **Post-deployment checks** (section 8).
7. **Research node** only if the runner is to use the V11 lab: `services/research-runner/README.md`.

The signer goes before the API restart so that the new API never talks to the old signer (the V11 API calls
`POST /venue/authorization`, which the old signer lacks). During the minutes between steps 4 and 5 the old API talks to
the new signer: the signer's existing routes are unchanged apart from the stricter refusals of A2 (4) and (5)
(`work/stab-signer.md`: "every pre-existing signer test passes unchanged on the new store"), but that pairing was **not
tested as such** — keep the interval short and sign nothing during it. The runbook's title orders the two nodes the
other way ("API + web, then the signer") and does not state a reason; both orders leave a mixed interval.

### 7.1 Optional: separate agents worker (A8) — not part of the initial deployment

`docs/TRADING-AGENT-ENGINE.md` §4: after the API has started once on V11 (it migrates), set `SPW_WORKERS=api` on the API
and add a PM2 process `sp-wallet-agents` (`node dist/agents.mjs`, the same environment plus `SPW_WORKERS=agents`,
`kill_timeout` 15 000). The worker exits 2 on a wrong `SPW_WORKERS` and 3 on an unmigrated database. Its health is the
leases' heartbeat (`GET /api/v1/agents/runtime/status`), not the monitor. Live agents would need
`SPW_TRADING_API_EXECUTION=on` in both processes. Rollback: stop the worker, `SPW_WORKERS=on`, restart the API.

### 7.2 Caddy and the websocket

Caddy's `reverse_proxy` tunnels websockets without any directive and has no default stream timeout
(`docs/V11-QUOTE-ENGINE.md` §11): **no change is required** on the gateway for `wss://wallet.spboucher.ai/api/v1/stream`.
Known behaviour: a Caddy config reload closes every websocket unless `stream_close_delay` is set; clients reconnect by
themselves. Setting it is a production change of the gateway, not made and not required (A8). The API host needs
outbound `wss` to `api.hyperliquid.xyz`, `edgex-quote-prod-v2.edgex.exchange`, `indexer.dydx.trade` (already used) and
`ws-feed.exchange.coinbase.com` (new).

---

## 8. Post-deployment checks

| Check | Expected |
|---|---|
| `https://wallet.spboucher.ai/api/v1/health/live` | answers |
| Start-up line 1 | `sp-wallet api listening on … broadcast=<as before> workers=<as before> agent-workers=in-process (…)` |
| Start-up line 2 — capability summary | **the same as before the restart**: `deriv_live_mainnet`, `deriv_mandate_mainnet`, `deriv_gmx_live`, `research_runner`, `research_readonly_db`, `broadcast`, `workers`, `strategy_sandbox_enforced`, `web_app`. `on` → `OFF(missing …)` = a variable lost; `OFF` → `on` = something opened that nobody decided: both are a failed deployment (runbook step 5) |
| Start-up line 3 | `strategy sandbox: sandbox-exec (confined, self-test passed)` |
| Monitoring → Système | every loop has a recent heartbeat, including `agent-engine`, `perp-agent-engine`, `agent-stream-engine`, `agent-supervisor`, `agent-jobs`, `withdrawals`; the health answer has a `quotes` block |
| Quote stream | `GET /api/v1/stream/stats` (owner session): connections, subscriptions, frames sent, upstream status per venue; open Markets on the phone: live cells tick, or the fallback line « Flux en direct indisponible — les prix sont relus périodiquement » (Safari / iOS was never run) |
| Risk screen | the banner « ordres réels refusés tant que ces limites ne sont pas définies » lists exactly: `maxDailyNotional`, `maxNetExposure`, `maxAssetExposure`, `maxVenueExposure`, `maxVenueCollateralShareBps`, `maxDrawdownBps` (plus `gmx` in the allow-lists if GMX is used). `GET /api/v1/risk/limits/live` → `seed` shows what was carried over and from where: **read it** before setting anything. The four locks are shown with their state: `trading_api_execution` off |
| Developer screen → status | "live execution through the API is disabled (SPW_TRADING_API_EXECUTION…)" |
| Agents | `GET /api/v1/agents/runtime/status`: workers in-process, leases renewing. A previously LIVE perp agent: still LIVE, **reduce-only** until a new mandate; its journal says why |
| Signer | Security: reachable, key id unchanged; `signer.mjs status`: `journalIntact: true`, `venueQuotingMandates: []` |
| Kill switch and read-only mode | both off (`/api/v1/risk/state`) |
| Pepper | after the first API key is created: `trading-api-secrets.json` exists, mode 0600 — back it up (section 5) |

The owner then sets the six limits (passkey: setting an absent limit is a loosening). Until then his real orders that
add risk are refused; nothing else is.

<!-- PENDING: final interface pass (branch v11-ui) — post-deployment visual checks of the screens it changed -->

---

## 9. Rollback

### API

Runbook: `git checkout <previous commit>`, `pnpm install --frozen-lockfile && pnpm build`, `pm2 restart sp-wallet`.
The runbook's statement "the previous code runs on the newer schema" holds for tables and columns (all additive, new
columns nullable or defaulted). It was **not tested** for V10 code on a V11 database; reasoning from `db.ts` and the
work notes, these points need attention — the first three are certain, the last two uncertain:

| Left behind by V11 | Consequence under V10 code | Before rolling back |
|---|---|---|
| The four queue triggers | every write to `deriv_orders`, `deriv_gmx_ops`, `proposals`, `agent_orders` keeps inserting into `order_projection_queue`, which V10 never drains: it grows | acceptable for a short rollback; otherwise `drop trigger` the four (they are re-created by the next V11 start) |
| **`agent_orders_gate`** | still reads `settings['risk.switches']`: if the V11 kill switch or read-only mode is **engaged**, a spot agent's insert raises under V10, which has no screen to release it | **release the kill switch and read-only mode (passkey, Risk screen) before rolling back**, or drop the trigger |
| The kill switch itself | V10 does not know `risk.switches`: for everything but spot agents the switch silently stops applying | know it; use the signer halt if a stop is needed |
| V11-only agents (`engine = 'stream'` or `'supervisor'`, template-created) | *uncertain*: V10's engines select agents by their own columns and may try to tick rows they do not understand | stop these agents in V11 before rolling back |
| Live agents approved under a V11 trading mandate (`perp.live.unified`) | *uncertain*: V10 would drive them through its direct mandate path; the signer's derivative mandate is the same shape and stays in force | revoke their mandates in V11 first, or accept that V10 trades them without the API-only fields |

Also: the live-limit seed is written once (`risk.limits.live.seed`) and is not recomputed by a later re-deployment;
`perp_agent_signals` written by V10 during a rollback is copied forward at the next V11 start (`on conflict do
nothing`). API keys stop working under V10 (no such routes) and work again after — provided the pepper file was kept.
Restore the database dump only if data were damaged (runbook).

### Signer

Runbook: put back `signer.mjs.bak-*`, `pm2 restart sp-wallet-signer`. Two rules:

1. **Do not restore `state.json.bak-*`** unless the state file itself is damaged: it would erase the replay markers,
   counters and revocations written since — a revoked mandate would be in force again. The older binary starts on the
   V11 `state.json` (it finds an empty journal and starts a new one inside the state file); going forward again is
   supported (`journal-rollback-<time>.jsonl`, tested: "a rollback to the pre-V11 binary and forward again").
2. **Revoke every quoting mandate before rolling the signer back** (`POST /venue/quoting/revoke`, no passkey). A
   pre-quoting binary does not know the field: it would approve a directional mandate next to an active quoting mandate
   (`docs/v11/work/mm-core.md` §2.7). With market making never enabled there is none to revoke — check
   `venueQuotingMandates` in the status anyway.

Rolling back the signer alone while the V11 API stays: the API's `recover` and stale-mandate revocation call routes the
old signer has (`/mandate/revoke`) or lacks (`/venue/authorization`); the second answers an error and nothing is signed.
Not tested as a combination.

---

## 10. After the deployment: enabling anything

Nothing in this plan turns a lock on. The staged path, with what must be true before each step, is in
`TRADING-PRODUCTION-READINESS.md`.
