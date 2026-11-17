# SP Wallet V11 — deployment plan

**This is a plan. It has not been executed, in whole or in part.** Production runs V10 (`a118e3e`). Nothing here was
tried on a production node; no production value was read. The procedure extends `docs/runbooks/deploy.md`, which since
2026-11-17 covers the V11 locks, the secrets file, the websocket and the fourth bundle; `scripts/preflight.sh` checks them.
The rollback of section 9 was rehearsed on a throwaway local database and keystore — never on a node.

**Release to deploy.** Branch `v11-final` (from the local `v11` at `9561d78`, which holds every V11 workstream including
`v11-mm-live` and `v11-ui`), as validated in `docs/v11/work/final-validation.md` and `V11-TEST-RESULTS.md` §6. The last
commit of `v11-final` that changes code is **`@@CODE_COMMIT@@`**; the commits after it change documents only. The main
session merges `v11-final` into `v11`: the hash of `v11` after that merge is the one to deploy and will differ from the one
above (a merge commit) — the difference between `@@CODE_COMMIT@@` and the deployed commit, restricted to `services`,
`packages`, `apps`, `scripts`, `research` and `sdk`, must be empty. The result that authorises it: `pnpm typecheck` exit 0
and three consecutive full-suite runs with every test passing (194 files, @@TESTS@@ tests), recorded with every earlier run
that did not pass, in `V11-TEST-RESULTS.md` §6.

---

## 1. Authorizations required from the owner

Nothing below may be done on the owner's behalf without an explicit yes to that line. Each line is one decision; a yes to
one is not a yes to the next. "Read" means a human reading of the named diff or document, not a test result.

### 1.1 Deployment

1. **Deploy V11** (API + web + signer bundle) with every new lock off — the behaviour changes of section 3, a schema
   migration, a new signer binary. Source: this page.
2. **The rollback procedure of section 9**, including its two orders ("release the switches first", "revoke every quoting
   mandate first") — rehearsed locally on 2026-11-17, never on a production node.

### 1.2 Signer behaviour changes — stabilisation (seven; source `docs/v11/work/stab-signer.md`, "For the reviewer before any deployment")

Files to read: `services/isolated-signer/src/{venue,venue-gmx,venue-mandate,signer,server,store,control,main,prices}.ts`,
`packages/derivatives/src/live/canonical.ts`.

3. Under halt the signer signs a manual **reduce-only** Hyperliquid order, a GMX **decrease** and a GMX **cancellation**,
   each with the passkey.
4. A **reduce-only trigger order** may carry prices outside `maxPriceDeviationBps` on its protective side (manual and
   mandate paths).
5. `POST /venue/authorization` returns a stored `approveAgent` signature again **without a passkey**.
6. A second active spot mandate per vault is **refused** (stricter).
7. Every priced signature requires Kraken to report `online`; anything else refuses every mandate order and every venue
   order (stricter, with an availability cost).
8. On-disk format: `journal.jsonl`, `journalRef` in `state.json`, `state.json.lock`, `control.sock`.
9. The CLI's `halt` / `unhalt` / `reset-passkeys` / `setup-token` reach the running daemon: `unhalt` takes effect at once,
   without a restart.

### 1.3 Signer behaviour changes — quoting mandate (nine; source `docs/v11/work/mm-core.md` §2, re-read in `docs/V11-SECURITY-REVIEW.md` "Live market making")

**They ship in the signer bundle of this release whether or not market making is ever enabled, and since `v11-mm-live`
the API can reach them** (behind four locks and a passkey-approved mandate). Files: `services/isolated-signer/src/
{venue-quoting,venue-read}.ts`, `packages/derivatives/src/live/quoting.ts`; ADR 0001 row 7. The alternative to reading
them is to deploy a signer built without them, which this release does not provide.

10. A new mandate kind, `SPW-VENUE-QUOTING-MANDATE-v1`, approved by the same passkey ceremony (`POST /venue/quoting/approve`).
11. **A seventh path that signs without a per-operation passkey**: `POST /venue/quoting/sign` (trading key only).
12. Two new action kinds signed by the trading key on that path only: an order action with several orders (≤ 20, one
    instrument) and `scheduleCancel`.
13. Quotes do not count against the authorization's `maxOrdersPerDay` (they have the mandate's own persisted rates).
14. A directional mandate is refused (`conflict`) while a quoting mandate is active on the authorization.
15. A new outbound read of the signer: `orderStatus` on the pinned info hosts.
16. New optional state fields (`venueQuotingMandates`, `q: 1` on ledger entries) — and the rollback rule that follows
    (section 9, demonstrated).
17. Journal volume: one record per signed action, several per second at the compiled maximum.
18. `GET /status` gains `venueQuotingMandates[]`.

### 1.4 API behaviour changes of the market-making integration (eleven; source `docs/V11-SECURITY-REVIEW.md` "Live market making → API behaviour changes"; `docs/v11/work/mm-live.md` "What a human must review")

19. To read as one item: the quoting section of a trading mandate and its approval / revocation at the signer; the two
    exclusivity codes; the `live` mode of the `market_making` family; **paper market making no longer goes through the
    order gateway** (its quotes are not orders); the stream pass ticking `LIVE` / `STOPPING` agents; `stopAgent` revoking
    the mandate; the 60 s pacing of the live engine's reconcile during a session; the supervisor's once-a-minute equity
    read; the fill ordering of position provenance; the routes `/api/v1/mm/*` and `POST /api/v1/mandates/recover-quoting`;
    a session counting only its own fills. Also `withinBand`, `MmRuntime.emergency` and the 30 s reuse of a risk decision.

### 1.5 The six live limits — to SET after deployment (source `docs/TRADING-RISK-ENGINE.md`, `docs/V11-RISK-MODEL.md`; section 8)

Until they are set the owner's real orders that add risk are refused. Setting an absent limit is a loosening: passkey.

20. `maxDailyNotional`
21. `maxNetExposure`
22. `maxAssetExposure`
23. `maxVenueExposure`
24. `maxVenueCollateralShareBps`
25. `maxDrawdownBps`

Before setting them: read the seed (`GET /api/v1/risk/limits/live` → `seed`) — it carries the minimum over the venue
accounts' policies, which may not be what is wanted (`V11-REMAINING-LIMITATIONS.md` 3.5). GMX is not seeded at all: add
`gmx` to the allow-lists only if GMX is used.

### 1.6 Locks — each one is its own decision; every one is OFF by default and only the exact value `on` opens it

26. `SPW_TRADING_API_EXECUTION` — live orders by API keys, by live agents under a mandate and by the owner through the
    trading API. Before: `TRADING-PRODUCTION-READINESS.md` §3; the items "for human review" of
    `docs/V11-SECURITY-REVIEW.md`. It gates live agents and market making too.
27. `SPW_DERIV_LIVE_MAINNET` — keep or change what production has today (not read by this work).
28. `SPW_DERIV_MANDATE_MAINNET` — idem.
29. `SPW_DERIV_GMX_LIVE` — idem.
30. `SPW_DERIV_MM_TESTNET` — market making on the Hyperliquid **testnet** (with 26).
31. `SPW_DERIV_MM_MAINNET` — live market making on mainnet (with 26, 27, 28). Last of all.

Each is in the start-up capability line since this release (`trading_api_execution` was added by the final validation,
`deriv_mm_mainnet` and `deriv_mm_testnet` by the market-making integration).

### 1.7 Market-making go-live (only if 30 or 31 is ever wanted; `docs/V11-MARKET-MAKING.md` §11 and §13; `mm-live.md` "Owner decisions")

32. **Acknowledgement of the negative evidence**: the lab study and the simulation both show a negative modelled PnL
    with adverse markouts, at a maker fee of 1.5 bps paid. The in-app checklist records the hash of the text ticked.
33. **Jurisdiction acknowledgement** for Hyperliquid (terms name Ontario, not Québec; not legal advice) — recorded again
    in the mandate's hash.
34. **The testnet step, run by the owner himself, with test funds**: the six verifications of §11 item 4 (`scheduleCancel`
    replacement and firing, an `Alo` rejection, `expiresAfter` rejection, `frontendOpenOrders` lag, duplicate cloid,
    `userRateLimit` movement). **It is implemented and was never run by anyone.**
35. The session's parameters: capital and floor, the instrument (BTC to start), quote size, one level, inventory limits,
    the band, the rates, `deadManSeconds`, hours and maximum duration, the loss limit, the policy per breaker,
    `flattenOnStop`; leverage set by hand at or below the mandate's.
36. A paper session of at least 30 minutes on the chosen instrument (`SPW_MM_MIN_PAPER_MINUTES`), then the quoting
    mandate (two passkey prompts, ≤ 7 days), any directional mandate revoked first.
37. After review: whether the signer may cache its leverage read (a signer change, not made), and whether 30 minutes of
    paper is the right minimum.

### 1.8 Optional, and external

38. `ZEROX_API_KEY`, `ONEINCH_API_KEY` — **optional**. Quote-only comparison sources; without a key they are never asked.
    No live call was ever made with either, their fixtures are documentation-derived and their terms of use were not
    read (`V11-REMAINING-LIMITATIONS.md` 7.3).
39. Third RPC endpoints (`SPW_RPC_EXTRA`); `stream_close_delay` in Caddy; a separate agents worker
    (`SPW_WORKERS=api` + `sp-wallet-agents`) — optional, none needed for the deployment.
40. **edgeX trading: not offered, and not a decision the software can take.** edgeX's Terms of Use exclude Canada and
    prohibit VPN circumvention: the venue is market data only, has no account, no order path and no acknowledgement text
    in the wallet. The same holds for dYdX. Nothing here is to be authorized; the line is on the list so that it is not
    asked again.
41. **Re-review of the Anthropic rows of the private-markets contract table** after the company's listing: the entries
    `io:ANTH`, `para:ANTH`, `xyz:ANT`, `edgex:ANTHROPICUSDC` expire at 2026-11-18T00:00Z; from then on they show
    "definition under review" and no valuation until someone re-reads the operators' documentation and updates
    `services/api/src/private-markets/contracts.ts` (9.1). edgeX already took its contract off its list on 2026-11-17.

---

## 2. Preconditions

1. Items 1–19 of section 1 given (deployment, rollback procedure, the signer and API behaviour changes read). The final
   run is recorded in `V11-TEST-RESULTS.md` §6.
2. On the API node, from the checkout: `scripts/preflight.sh --db sp_wallet --env-from-pm2 sp-wallet` with no `FAIL`
   (read-only; runs the new `migrate()` twice on a scratch copy of the schema; prints variable names, never values).
   Since 2026-11-17 it also checks the four bundles, reports every V11 lock variable that is SET as a WARN to confirm,
   checks `SPW_WORKERS` and the mode of the API-key secrets file. It was run on the development laptop only.
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
| `SPW_DERIV_MM_MAINNET` (new; `mm/live-adapter.ts` `mmOpeningLock`) | off | **off (leave unset)** | live quoting on mainnet: `mm_mainnet_disabled`. Needs `SPW_DERIV_LIVE_MAINNET`, `SPW_DERIV_MANDATE_MAINNET` and `SPW_TRADING_API_EXECUTION` as well (four settings), and a quoting mandate approved with the passkey. The engine IS wired since `v11-mm-live`; cancels, reductions and the dead man's switch pass without any lock |
| `SPW_DERIV_MM_TESTNET` (new; same rule) | off | **off (leave unset)** | quoting on the Hyperliquid testnet: `mm_testnet_disabled`. Needs `SPW_TRADING_API_EXECUTION` as well. The owner's own first go-live step; never run |
| `SPW_DERIV_LIVE_MAINNET` | off | as currently set | new mainnet derivatives risk, authorizations, collateral moves |
| `SPW_DERIV_MANDATE_MAINNET` | off | as currently set | mandate orders that add risk on mainnet |
| `SPW_DERIV_GMX_LIVE` | off | as currently set | new GMX positions |
| `SPW_BROADCAST` | on | as currently set (production relays) | relaying signed transactions (test mode) |

**Every execution lock is in the start-up capability line** (`capabilities.ts`, twelve entries): `deriv_live_mainnet`,
`deriv_mandate_mainnet`, `deriv_gmx_live`, `trading_api_execution` (added 2026-11-17, `d88f1da`, with its test in
`hardening-e.test.ts`), `deriv_mm_mainnet`, `deriv_mm_testnet` (added by `v11-mm-live`), then `research_runner`,
`research_readonly_db`, `broadcast`, `workers`, `strategy_sandbox_enforced`, `web_app`. The same list is on Monitoring →
Système; the six locks are also on the Risk screen (`GET /api/v1/risk/state` → `locks`). With several processes
(`sp-wallet` and an optional `sp-wallet-agents`) the lock values must be the SAME in both: the worker that holds an agent's
lease applies them at every order and every quote.

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
| `SPW_RPC_EXTRA` | unset | unset (owner's choice, item 39) | JSON map of additional https RPC endpoints per network |
| `SPW_SWAP_QUOTES_RETENTION_DAYS` | 30 (never under 8) | default | pruning of `swap_quotes` |
| `ZEROX_API_KEY`, `ONEINCH_API_KEY` | unset | unset | quote-only comparison sources; without a key they are never asked. No live call was ever made with either |
| `SPW_LAB_RESULTS_RUN` | `2026-11-15-v11` | default | which committed lab run the Agents panel shows |
| `SPW_RISK_PREVIEW_RETENTION_DAYS` | 30 (never under 1) | default | pruning of PREVIEW risk evaluations (added 2026-11-17); decisions of real order requests are never pruned |
| `SPW_MM_MIN_PAPER_MINUTES` | 30 | default | the paper session the market-making go-live checklist asks for |
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

Checked by `scripts/preflight.sh` since 2026-11-17: the mode of the secrets file (when `SPW_DATA_DIR` is readable from
the shell), a reminder for the signer journal and for the gateway.

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
| market making (additive): tables `mm_sessions`, `mm_fills`, `mm_tape`; columns `trading_mandates.quoting`, `deriv_fills.seq` | nothing is rewritten |

**Observed on 2026-11-17** (rehearsal, a database created and used by V10 `a118e3e`, then started with this release): 42
tables and one trigger before, 65 tables and eight triggers after; the API started without an error line; both V10 agents,
the paper account, its position and the address book were read back unchanged. **Orders that exist before the first V11
start are not copied into the unified `orders` table** (only writes made once the triggers exist are projected): the
Activity timeline and `GET /trading/orders` start at the deployment; the older history stays in the screens that read the
engines' own tables (terminal, agents, the old Activity export). The rehearsal database held a dozen rows — the duration
of the migration on the production database is not known from it; `scripts/preflight.sh --db sp_wallet` measures it on a
copy of the real schema (no rows).

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
the new signer: the signer's existing routes are unchanged apart from the stricter refusals of items 6 and 7 of section 1
(`work/stab-signer.md`: "every pre-existing signer test passes unchanged on the new store"), but that pairing was **not
tested as such** — keep the interval short and sign nothing during it. The runbook's title orders the two nodes the
other way ("API + web, then the signer") and does not state a reason; both orders leave a mixed interval.

### 7.1 Optional: separate agents worker (item 39) — not part of the initial deployment

`docs/TRADING-AGENT-ENGINE.md` §4: after the API has started once on V11 (it migrates), set `SPW_WORKERS=api` on the API
and add a PM2 process `sp-wallet-agents` (`node dist/agents.mjs`, the same environment plus `SPW_WORKERS=agents`,
`kill_timeout` 15 000). The worker exits 2 on a wrong `SPW_WORKERS` and 3 on an unmigrated database. Its health is the
leases' heartbeat (`GET /api/v1/agents/runtime/status`), not the monitor. Live agents would need
`SPW_TRADING_API_EXECUTION=on` in both processes. Rollback: stop the worker, `SPW_WORKERS=on`, restart the API.

### 7.2 Caddy and the websocket

Caddy's `reverse_proxy` tunnels websockets without any directive and has no default stream timeout
(`docs/V11-QUOTE-ENGINE.md` §11): **no change is required** on the gateway for `wss://wallet.spboucher.ai/api/v1/stream`.
Known behaviour: a Caddy config reload closes every websocket unless `stream_close_delay` is set; clients reconnect by
themselves. Setting it is a production change of the gateway, not made and not required (item 39). The API host needs
outbound `wss` to `api.hyperliquid.xyz`, `edgex-quote-prod-v2.edgex.exchange`, `indexer.dydx.trade` (already used) and
`ws-feed.exchange.coinbase.com` (new).

---

## 8. Post-deployment checks

| Check | Expected |
|---|---|
| `https://wallet.spboucher.ai/api/v1/health/live` | answers |
| Start-up line 1 | `sp-wallet api listening on … broadcast=<as before> workers=<as before> agent-workers=in-process (…)` |
| Start-up line 2 — capability summary | the nine entries a V10 process printed, **each as before the restart** (`deriv_live_mainnet`, `deriv_mandate_mainnet`, `deriv_gmx_live`, `research_runner`, `research_readonly_db`, `broadcast`, `workers`, `strategy_sandbox_enforced`, `web_app`), **plus three new ones that must read OFF**: `trading_api_execution=OFF(missing SPW_TRADING_API_EXECUTION)`, `deriv_mm_mainnet=OFF(missing …+SPW_DERIV_MM_MAINNET+SPW_TRADING_API_EXECUTION)`, `deriv_mm_testnet=OFF(missing SPW_DERIV_MM_TESTNET+SPW_TRADING_API_EXECUTION)`. `on` → `OFF(missing …)` = a variable lost; `OFF` → `on` = something opened that nobody decided: both are a failed deployment (runbook step 5). Observed locally: the line of this release with no variable set is quoted in `docs/v11/work/final-validation.md` §5 |
| Start-up line 3 | `strategy sandbox: sandbox-exec (confined, self-test passed)` |
| Monitoring → Système | every loop has a recent heartbeat, including `agent-engine`, `perp-agent-engine`, `agent-stream-engine`, `agent-supervisor`, `agent-jobs`, `withdrawals`; the health answer has a `quotes` block |
| Quote stream | `GET /api/v1/stream/stats` (owner session): connections, subscriptions, frames sent, upstream status per venue; open Markets on the phone: live cells tick, or the fallback line « Flux en direct indisponible — les prix sont relus périodiquement » (Safari / iOS was never run) |
| Risk screen | the banner « ordres réels refusés tant que ces limites ne sont pas définies » lists exactly: `maxDailyNotional`, `maxNetExposure`, `maxAssetExposure`, `maxVenueExposure`, `maxVenueCollateralShareBps`, `maxDrawdownBps` (plus `gmx` in the allow-lists if GMX is used). `GET /api/v1/risk/limits/live` → `seed` shows what was carried over and from where: **read it** before setting anything. The six locks are shown with their state: `trading_api_execution`, `deriv_mm_mainnet`, `deriv_mm_testnet` off |
| Developer screen → status | "live execution through the API is disabled (SPW_TRADING_API_EXECUTION…)" |
| Agents | `GET /api/v1/agents/runtime/status`: workers in-process, leases renewing. A previously LIVE perp agent: still LIVE, **reduce-only** until a new mandate; its journal says why |
| Signer | Security: reachable, key id unchanged; `signer.mjs status`: `journalIntact: true`, `venueQuotingMandates: []`. The V11 daemon writes nothing until something changes its state: `journal.jsonl` appears at the first signature, halt or approval, not at the start (observed) |
| Kill switch and read-only mode | both off (`/api/v1/risk/state`) |
| Pepper | after the first API key is created: `trading-api-secrets.json` exists, mode 0600 — back it up (section 5) |

The owner then sets the six limits (passkey: setting an absent limit is a loosening). Until then his real orders that
add risk are refused; nothing else is.

### 8.1 The interface after the final pass — what to look at on the phone

The navigation changed (`docs/v11/work/ui.md`); every former path still opens its screen. Chromium only was run: **these
are the first Safari / iOS checks of the new shell.**

| Look at | Expected |
|---|---|
| Tab bar | five areas: Accueil · Marchés · Négocier · Agents · Activité. Send, Receive, Risk, Alerts, Settings, Security, Developer / API, System status, Research and Lock are in the header menu |
| Header, every screen | the risk indicator: « Limites » on a wallet whose live limits are not set (the state right after deployment), the kill-switch and read-only states in words; a tap opens Risk |
| Home | the wallet, then the Dashboard panels (accounts, positions, P&L, risk, agents, system, price freshness): one block per book with its mode tag — live, live testnet, paper — and **no figure that adds two modes**; a panel whose source does not answer says so and the others stay |
| Marchés | Explorer · Compare · Private markets under the header; live cells tick; the Anthropic rows per section 2 item 6 |
| Négocier → Futures | the picker lists the hub's perpetuals; a market the wallet cannot trade live says why; a confirmation sheet shows the risk engine's checks for that exact order; the unified blotter has two lists (Réel, Simulation), never added; an `UNKNOWN` order reads « En vérification auprès de la plateforme » |
| Activité | one timeline (wallet, orders, risk refusals, audit events); it starts at the deployment for orders (section 6); paper items carry their tag; the audit-chain status at the top |
| No horizontal scroll | at the phone's width on every screen (the specs checked 320, 360, 390 and 430 px in Chromium) |
| Console | no error; a locked session closes the quote socket without a 401 |

---

## 9. Rollback

**Rehearsed on 2026-11-17** on a throwaway local database and keystore, with the real bundles of both versions (V10 =
`a118e3e` built in a second worktree): V10 fresh → V11 on the same database and signer directory → V10 again → V11 again,
twice (kill switch released, then left engaged). Commands, counts and outputs: `docs/v11/work/final-validation.md` §5 and
§8. What follows is what was **observed**; what was not rehearsed is said at the end. A local rehearsal is not a
production rollback: no PM2, no mld, a database of a few dozen rows.

### 9.1 API — the procedure

1. **In V11, before going back** (Risk screen, passkey): **release the kill switch and read-only mode**; stop every
   V11-only agent (stream agents: market making, cross-exchange, funding arbitrage; the risk supervisor) and every
   market-making session (its quoting mandate is revoked at the signer by the stop); note which live agents hold a V11
   trading mandate.
2. Runbook: `git checkout <previous commit>`, `pnpm install --frozen-lockfile && pnpm build`, `pm2 restart sp-wallet`.
3. If step 1 could not be done because V11 no longer starts:
   `psql -v ON_ERROR_STOP=1 -d sp_wallet -f scripts/v11-rollback-triggers.sql` — it drops the one trigger that would
   otherwise refuse the spot agents' buys under V10 (tested in the rehearsal: the refused row is accepted after it, the
   switch stays recorded and V11 applies it again at its next start).
4. Going forward again needs nothing: V11 re-creates its triggers at start-up and catches up.

### 9.2 API — what was observed

| Question | Observed |
|---|---|
| Does V10 boot on a database migrated and written by V11? | **Yes.** It starts without an error line; `health/live`, `health/ready`, portfolio, activity, agents (list and detail), derivative accounts, address book, security overview, settings answer 200. The new tables and columns are ignored. Its capability line has its nine entries |
| A derivative paper order and a reduce-only close under V10 | **Work** (order filled; close of half the position filled, `reduceOnly: true`) |
| A transfer proposal under V10 | The route answers as before V11 (`400 insufficient_funds` on the empty rehearsal wallet, the same answer as in V10 before and in V11) — a funded transfer was not rehearsed |
| The signer under the V10 API | reachable, **same key id**, halt state unchanged |
| The four queue triggers | every derivative order written by V10 adds **two rows** to `order_projection_queue` (insert + update), every agent order one; V10 never drains it. Harmless and useful: see "forward again" |
| **`agent_orders_gate` with the V11 kill switch left engaged** | **a spot agent's BUY row is refused by the database under V10**: `ERROR: kill_switch_active: the kill switch is on: a spot agent buys no risk…` (function `spw_agent_order_gate`). Its SELL row passes. V10 has no screen and no route to release the switch → step 1, or step 3 |
| **The kill switch itself under V10** | **not applied to anything else**: with the switch engaged, a derivative paper buy **fills** under V10. A rollback silently removes the kill switch, read-only mode, the unified risk limits and every lock that V10 does not know (`SPW_TRADING_API_EXECUTION`, the two market-making ones). The signer halt is the stop that still exists |
| `order_events` append-only, `research_log` defaults | V10 never writes `order_events` (an update by hand is refused, as designed); V10's own insert into `research_log` passes the defaults trigger (the mode is filled from the agent) |
| **Forward again to V11** | **clean**: the queue is drained within seconds of the start (3 → 0, then 10 → 0), the orders made under V10 become unified orders, **none duplicated** (13 orders, 13 distinct engine references), no error line; a kill switch left engaged is engaged again and refuses (`423`, `kill_switch`); `migrate()` re-creates a dropped trigger |
| Orders made under V10 while the queue triggers were dropped (`-v queue=1`) | never projected afterwards — which is why the script keeps the queue triggers by default |
| API keys | *not exercised in the rehearsal (by reading):* the trading-API routes do not exist in V10; the keys work again after — provided `trading-api-secrets.json` was kept |

Also unchanged from the earlier reading: the live-limit seed is written once (`risk.limits.live.seed`) and not recomputed
by a later re-deployment; `perp_agent_signals` written by V10 during a rollback is copied forward at the next V11 start.
Restore the database dump only if data were damaged (runbook).

**V11-only agents under V10 code** — see `docs/v11/work/final-validation.md` §8 for what was observed on a copy of the
soak's database (a paper market-making agent and a bar perp agent created by V11, then V10 started on it):
@@V11_ONLY_AGENTS@@

**Not rehearsed:** a live agent holding a V11 trading mandate when V10 starts (it needs a venue account; by reading, V10
would drive it through its direct mandate path — the signer's derivative mandate is the same shape and stays in force —
without the API-only fields: revoke those mandates in V11 first); a GMX operation or a swap in flight across the
rollback; a database of production size; the same procedure under PM2 / mld.

### 9.3 Signer

Runbook: put back `signer.mjs.bak-*`, `pm2 restart sp-wallet-signer`. Two rules, both now demonstrated
(`scripts/rollback-signer-rehearsal.mts <checkout of a118e3e>`: exit 0, every observation as written here):

1. **Do not restore `state.json.bak-*`** unless the state file itself is damaged: it would erase the replay markers,
   counters and revocations written since. Observed instead, with no restore: the V10 binary starts on the V11
   `state.json` (same key id, the halt recorded by V11 is seen, replay markers and spending counters intact); it sees an
   **empty** journal — it does not read `journal.jsonl` — and starts a new one inside `state.json`, keeping the
   `journalRef` it does not know. Going forward, V11 finds its journal intact and moves what V10 journaled to
   `journal-rollback-<time>.jsonl` at its first save. During the rollback the operator's `signer.mjs status` therefore
   shows a short journal: that is the old binary's view, not a loss. A V11 daemon that was stopped leaves `control.sock`
   in the directory (its lock file is removed): the old binary ignores it.
2. **Revoke every quoting mandate before rolling the signer back** (Risk → quoting mandate → revoke, or
   `POST /api/v1/mandates/<id>/revoke`; no passkey; check `venueQuotingMandates[].phase` is `wind_down` or `ended` in
   `signer.mjs status`). **Why, as observed on a scripted venue with a software passkey:** with a quoting mandate active
   on an authorization, the V11 signer answers a directional mandate on the same authorization
   `conflict: a quoting mandate is active on this venue authorization: revoke it first`. The V10 signer code, started on
   that same state, **approves the same request**: it does not list the quoting mandate in its status, has no route to
   sign under it **and no route to revoke it**, and keeps it on disk untouched. Back on V11, a quoting mandate and a
   directional mandate are then both active on one authorization — two sets of limits on one account, each computed as
   if the other did not exist, which V11 never allows itself to create. With market making never enabled there is no
   quoting mandate (`venueQuotingMandates: []`) and the rule costs one look.

Rolling back the signer alone while the V11 API stays: the API's `recover` and stale-mandate revocation call routes the
old signer has (`/mandate/revoke`) or lacks (`/venue/authorization`, `/venue/quoting/*`); the second kind answers an
error and nothing is signed. **Not rehearsed as a combination.**

---

## 10. After the deployment: enabling anything

Nothing in this plan turns a lock on. The staged path, with what must be true before each step, is in
`TRADING-PRODUCTION-READINESS.md`.
