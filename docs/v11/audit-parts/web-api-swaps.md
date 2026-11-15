# V11 Phase A audit — web ↔ API wiring, swap / bridge / cross-chain stack, performance & resilience

Scope: `apps/web`, `services/api`, `packages/swap`, the swap/bridge parts of `packages/core`. Checkout: branch `v11` =
commit `a118e3e` (production). Date: 2026-11-15. Read-only audit: no source file changed, no test or build run, no
transaction sent. Every statement below was read in the code at the cited `file:line`; the few that are inferences are
marked "(by reading, not reproduced)".

Abbreviations: **W** = called by the web app (where), **T** = called only by tests / scripts, **U** = no caller found
in `apps/web/src`, `services/api/test`, `tests/`, `scripts/`.

---

## 1. API route table

### 1.0 Cross-cutting rules (services/api/src/server.ts)

- One Fastify process, `bodyLimit` 64 kB, logger level `warn` (server.ts:100), global rate limit **240 requests / minute**
  (server.ts:102); auth routes and a few alert routes have a stricter `strict` limit (auth.ts:73-96, alerts/routes.ts:41).
- **Auth**: every `/api/*` path needs the owner session cookie except the `PUBLIC` set (server.ts:38):
  `/health/live`, `/auth/state`, `/auth/setup/{options,verify}`, `/auth/login/{options,verify}`, `/auth/logout`.
- **CSRF**: every non-GET needs `Origin == SPW_ORIGIN` and header `x-spw-csrf: 1` (server.ts:117-120). The web client
  adds it in `apps/web/src/api.ts:6`.
- **Runner exception**: `/api/v1/research/runner/*` is opened by the runner shared secret only, not by the owner session
  (server.ts:114, research/routes.ts:32).
- Errors: `UserError` → `{ error: <code>, message: <English sentence> }` (server.ts:124-131). Messages are English only.
- All paths below are prefixed with `/api/v1`. "Auth" column: `pub` = public, `own` = owner session, `run` = runner secret.

### 1.1 Core (server.ts, auth.ts, transfers.ts)

| Method | Path | Source | Auth | Purpose | Caller |
|---|---|---|---|---|---|
| GET | /health/live | server.ts:154 | pub | liveness | T (dev-stack.sh, runbook) |
| GET | /health/ready | server.ts:155 | own | db + signer + RPC health | T (api.test.ts) |
| GET | /networks | server.ts:162 | own | network registry + cached health | W hooks.ts:13 |
| GET | /assets | server.ts:165 | own | flat asset list | **U** |
| GET | /accounts | server.ts:171 | own | signer-derived addresses | W hooks.ts:14 |
| GET | /portfolio | server.ts:176 | own | balances, prices, pending proposals, halt flag | W hooks.ts:12 (20 s poll); also injected by monitor/routes.ts:26 |
| GET | /market/:symbol | server.ts:196 | own | CoinGecko price history (1/7/30/365 d) | W Asset.tsx:21 |
| GET | /activity | server.ts:209 | own | proposals + deposits merged | W Activity.tsx:17, Asset.tsx:22 |
| GET | /export/activity.csv | server.ts:226 | own | CSV export | W Settings.tsx:36 (plain link) |
| GET | /addressbook | server.ts:237 | own | list | W Send.tsx:19 |
| POST | /addressbook | server.ts:238 | own | save / relabel | W Send.tsx:167 |
| DELETE | /addressbook/:id | server.ts:247 | own | remove | **U** (no delete control in the UI) |
| GET / PUT | /settings | server.ts:256-257 | own | locale, currency, hideBalances, prices | W hooks.ts:17-18 |
| GET | /security/overview | server.ts:264 | own | signer state, devices, sessions, policy | W Security.tsx:14, AgentFund.tsx:84/229/269 |
| GET | /security/devices | server.ts:274 | own | passkey list | **U** (overview already carries it) |
| POST | /security/emergency-halt | server.ts:275 | own | one-way halt | W Security.tsx:45 |
| GET | /security/audit | server.ts:280 | own | audit chain tail | W Security.tsx:15 |
| GET | /auth/state | auth.ts:67 | pub | setup required / authenticated | W App.tsx:80 |
| POST | /auth/setup/options, /auth/setup/verify | auth.ts:73,78 | pub | first passkey | W Gate.tsx:21,23 |
| POST | /auth/login/options, /auth/login/verify | auth.ts:92,96 | pub | login | W Gate.tsx:16,18 |
| POST | /auth/logout | auth.ts:111 | pub | lock | W App.tsx:97 |
| POST | /security/devices/{options,verify,confirm} | auth.ts:121,125,137 | own | add a passkey | W Security.tsx:22-26 |
| POST | /security/sessions/revoke-all | auth.ts:147 | own | revoke sessions | W Security.tsx:80 |
| POST | /transfers/proposals | transfers.ts:117 | own | draft + simulate + policy pre-check | W Send.tsx:42, AgentFund.tsx:54 |
| GET | /transfers/proposals/:id | transfers.ts:152 | own | proposal view (also swap / bridge / xswap) | W Send.tsx:37, Swap.tsx:74, AgentFund.tsx:122 |
| GET | /transfers/:id/status | transfers.ts:153 | own | short status | **U** |
| POST | /transfers/proposals/:id/request-approval | transfers.ts:156 | own | freeze intent, issue challenge | W Send.tsx:49, AgentFund.tsx:57 |
| POST | /transfers/proposals/:id/approve | transfers.ts:200 | own | assertion → signer → relay (all kinds) | W Send.tsx:53, Swap.tsx:153, plan.tsx:190, AgentFund.tsx:59 |
| POST | /transfers/proposals/:id/reject | transfers.ts:223 | own | withdraw | W Send.tsx:62, Swap.tsx:158, AgentFund.tsx:138; injected by plan-exec.ts:286,338 |

### 1.2 Swap, bridge, cross-chain, plans

| Method | Path | Source | Auth | Purpose | Caller |
|---|---|---|---|---|---|
| GET | /swap/assets | swap.ts:88 | own | nodes of the liquidity graph | W Swap.tsx:62 |
| GET | /swap/providers | swap.ts:89 | own | provider runtime stats + capabilities | W Swap.tsx:63 |
| GET | /swap/stats | swap.ts:93 | own | 7-day p50/p95/p99 per provider | **U** |
| POST | /swap/quote | swap.ts:100 | own | one-shot route search | T (api.test.ts) |
| GET | /swap/quote/stream | swap.ts:107 | own | SSE route search | W Swap.tsx:125 |
| GET | /swap/execution | swap-exec.ts:116 | own | which networks execute, pins | T |
| POST | /swap/proposals | swap-exec.ts:119 | own | firm KyberSwap (EVM) or Jupiter (Solana) swap | W Swap.tsx:143; injected by plan-exec.ts:307 |
| GET | /bridge/execution | bridge.ts:139 | own | CCTP networks | W Swap.tsx:96, AgentFund.tsx:85 |
| GET | /bridge/quote | bridge.ts:142 | own | CCTP standard / fast options, destination gas | W Swap.tsx:100 |
| POST | /bridge/proposals | bridge.ts:159 | own | prepare burn | W Swap.tsx:141; injected by plan-exec.ts:308 |
| POST | /bridge/proposals/:id/finish | bridge.ts:241 | own | manual "advance now" | W bridge.tsx:70 |
| POST | /bridge/proposals/:id/retry-mint/options, /retry-mint | bridge.ts:248,262 | own | passkey re-approval of a failed mint | W bridge.tsx:67-68 |
| POST | /bridge/proposals/:id/reclaim/options, /reclaim | bridge-sol.ts:453,488 | own | reclaim Solana event-account rent | W bridge.tsx:98,100 |
| GET | /bridge/solana/token-account | bridge-sol.ts:506 | own | USDC token account state | T (bridge-sol.test.ts) |
| POST | /bridge/solana/token-account/options, /token-account | bridge-sol.ts:510,539 | own | create the USDC token account | W Swap.tsx:108,110 |
| GET | /xswap/execution | xswap.ts:158 | own | THORChain pins, operators | T |
| POST | /xswap/proposals | xswap.ts:161 | own | prepare a THORChain native swap | W Swap.tsx:142; injected by plan-exec.ts:309 |
| POST | /xswap/proposals/:id/refresh | xswap.ts:268 | own | manual "advance now" | W xswap.tsx:47 |
| GET | /plans/capabilities | plan-exec.ts:239 | own | what legs are executable | T (plan-exec.test.ts, fork-plan.mts) |
| POST | /plans/quote | plan-exec.ts:242 | own | priced candidate plans | W plan.tsx:61 |
| POST | /plans | plan-exec.ts:250 | own | start a plan (one open plan at a time) | W plan.tsx:138 |
| GET | /plans | plan-exec.ts:268 | own | list (open / recent) | W plan.tsx:62,285 |
| GET | /plans/:id | plan-exec.ts:273 | own | view + advance | W plan.tsx:177 |
| POST | /plans/:id/prepare | plan-exec.ts:276 | own | create the proposal of the ready leg | W plan.tsx:187 |
| POST | /plans/:id/{retry,stop,replan} | plan-exec.ts:323,331,343 | own | saga controls | W plan.tsx:191 |

### 1.3 Agents, strategies, research

| Method | Path | Source | Auth | Caller |
|---|---|---|---|---|
| GET | /agents/networks | agents/routes.ts:122 | own | W Agents.tsx:48,177 |
| GET / POST | /agents | agents/routes.ts:139,141 | own | W Agents.tsx:45,66, Home.tsx:35, PerpAgent.tsx:49, Research.tsx:124, AgentFund.tsx:355, LiveAgentNote.tsx:14 |
| GET | /agents/:id | agents/routes.ts:174 | own | W Agents.tsx:174 |
| POST | /agents/:id/mode | agents/routes.ts:195 | own | W Agents.tsx:239,325, PerpAgent.tsx:266, Research.tsx:188 |
| POST | /agents/:id/strategies/:sid/approve | agents/routes.ts:208 | own | W Agents.tsx:291, PerpAgent.tsx:222, Research.tsx:186 |
| POST | /agents/:id/mandate/{prepare,approve} | agents/routes.ts:226,245 | own | W Agents.tsx:186,191 |
| POST | /agents/:id/revoke | agents/routes.ts:256 | own | W Agents.tsx:331 |
| GET | /agents/:id/elsewhere | agents/routes.ts:265 | own | W AgentFund.tsx:267 |
| POST | /agents/:id/withdraw | agents/routes.ts:282 | own | W withdrawTrack.tsx:40 |
| GET | /agents/:id/withdrawals | agents/routes.ts:287 | own | **U** (only the per-id route is polled) |
| GET | /agents/:id/withdrawals/:wid | agents/routes.ts:291 | own | W withdrawTrack.tsx:33 |
| GET | /agents/perp/venues | agents/perp-routes.ts:177 | own | W PerpAgent.tsx:36 |
| POST | /agents/:id/perp/risk | agents/perp-routes.ts:189 | own | T (perp-agent tests, sim-perp-agent.mts) — no UI to edit perp risk after creation |
| POST | /agents/:id/perp/flatten | agents/perp-routes.ts:202 | own | W PerpAgent.tsx:181 |
| GET | /agents/:id/perp/live | agents/perp-routes.ts:214 | own | W PerpAgentLive.tsx:110 |
| POST | /agents/:id/perp/live/{prepare,approve,pause,resume,stop} | agents/perp-routes.ts:218-222 | own | W PerpAgentLive.tsx:185,198,303,423 |
| GET | /strategies | agents/strategies.ts:152 | own | W Agents.tsx:179, PerpAgent.tsx:103 |
| POST | /agents/:id/strategies | agents/strategies.ts:159 | own | W Agents.tsx:301, PerpAgent.tsx:229, Research.tsx:194 |
| GET | /research/status | research/routes.ts:73 | own | W Research.tsx:226,244 |
| POST / GET | /research/jobs | research/routes.ts:78,103 | own | W Research.tsx:63,225,243 |
| GET | /research/jobs/:id | research/routes.ts:112 | own | W Research.tsx:123 |
| POST | /research/jobs/:id/cancel | research/routes.ts:127 | own | W Research.tsx:148 |
| GET | /research/jobs/:id/log, /log/stream (SSE) | research/routes.ts:141,148 | own | W Research.tsx:94,97 |
| POST | /research/runner/claim, /runner/jobs/:id/log, /runner/jobs/:id/result | research/routes.ts:184,199,209 | run | services/research-runner (not the web app) |

### 1.4 Market data and derivatives

| Method | Path | Source | Auth | Caller |
|---|---|---|---|---|
| GET | /market-data/status | market/routes.ts:16 | own | T (market-store.test.ts, market-backfill.mts) — **not shown in the UI** |
| GET | /market-data/candles | market/routes.ts:33 | own | T — **not used by the UI** (the Asset chart uses CoinGecko `/market/:symbol`) |
| GET | /derivatives/venues, /instruments, /tickers, /market, /candles, /compare, /watch | derivatives/routes.ts:48-108 | own | W derivatives/api.ts:50-71 (Futures.tsx, Market.tsx, store.ts, Candles.tsx, Compare.tsx, Accounts.tsx) |
| GET | /derivatives/funding | derivatives/routes.ts:81 | own | **U** — `dapi.funding` exists (derivatives/api.ts:56) but nothing calls it |
| GET | /derivatives/stream (SSE) | derivatives/routes.ts:88 | own | W derivatives/store.ts:84 |
| GET / POST | /derivatives/route/assets, /derivatives/route | derivatives/routes.ts:119-120 | own | W derivatives/routerApi.ts:19,22 |
| GET / POST | /derivatives/accounts, /accounts/:id | derivatives/routes.ts:130-132 | own | W derivatives/api.ts:60-63 |
| POST | /derivatives/accounts/:id/{policy,orders/preview,orders,orders/:clientId/cancel,close,reset} | derivatives/routes.ts:133-144 | own | W derivatives/api.ts:64-70 |
| GET | /derivatives/live/config | live-routes.ts:35 | own | W live.ts (`lapi.config`) |
| GET | /derivatives/live/jurisdiction | live-routes.ts:36 | own | **U** in the web app (the text arrives inside `authorization/prepare`) |
| POST | /derivatives/live/venue-key | live-routes.ts:40 | own | T (derivatives-live.test.ts, hl-*-testnet.mts) |
| GET / POST | /derivatives/live/accounts, /accounts/:id, /accounts/:id/collateral | live-routes.ts:42-45 | own | W live.ts:92-96 |
| POST | /derivatives/live/accounts/:id/authorization/{prepare,approve,revoke} | live-routes.ts:48-50 | own | W live.ts:97-99 |
| POST | /derivatives/live/accounts/:id/policy | live-routes.ts:51 | own | T — no client function in live.ts |
| GET / POST | /derivatives/live/accounts/:id/mandate, /mandate/{prepare,approve,revoke} | live-routes.ts:55-58 | own | T — the web reaches mandates only through `/agents/:id/perp/live/*` |
| POST | /derivatives/live/accounts/:id/{orders/preview,orders,orders/:clientId/approve,orders/:clientId/cancel,leverage,leverage/:actionId/approve,halt,resume,cancel-all,close,rebase,reconcile} | live-routes.ts:61-77 | own | W live.ts:100-113 |
| GET | /derivatives/live/accounts/:id/stream (SSE) | live-routes.ts:80 | own | W liveStore.ts:47 |
| GET | /derivatives/live/accounts/:id/collateral/status, /operations/:opId | collateral-routes.ts:18-19 | own | W collateral.ts:42-43 |
| POST | …/collateral/{deposit/prepare,deposit/:opId/approve,withdraw/prepare,withdraw/:opId/approve,operations/:opId/cancel} | collateral-routes.ts:21-27 | own | W collateral.ts:44-48 |
| GET | /derivatives/gmx/status | gmx-routes.ts:23 | own | W gmx.ts:55 |
| GET | /derivatives/gmx/jurisdiction | gmx-routes.ts:24 | own | T (derivatives-gmx.test.ts) |
| POST | /derivatives/gmx/authorization/{prepare,approve,revoke} | gmx-routes.ts:26-28 | own | W gmx.ts:56-58 |
| POST | /derivatives/gmx/orders/preview, /orders, /positions/close, /orders/:opId/cancel | gmx-routes.ts:30-33 | own | W gmx.ts:59-62 |
| POST / GET | /derivatives/gmx/operations/:opId/approve, /withdraw, /operations/:opId | gmx-routes.ts:34-36 | own | W gmx.ts:63-65 |

### 1.5 Alerts, push, monitor

| Method | Path | Source | Auth | Caller |
|---|---|---|---|---|
| GET | /alerts, /alerts/unread | alerts/routes.ts:50,58 | own | W Alerts.tsx:55,57, alerts.ts:16 |
| POST | /alerts/read | alerts/routes.ts:59 | own | W Alerts.tsx:60 |
| GET | /alerts/stream (SSE) | alerts/routes.ts:70 | own | W alerts.ts:19 (every screen, from the shell) |
| GET / PUT | /alerts/settings | alerts/routes.ts:100-101 | own | W Alerts.tsx:110,112 |
| POST | /alerts/webhook/secret, /webhook/test | alerts/routes.ts:116,121 | own | W Alerts.tsx:223,228 |
| GET | /push/key | alerts/routes.ts:131 | own | W alerts.ts:70 |
| GET / POST / PATCH / DELETE | /push/subscriptions[/:id] | alerts/routes.ts:132-151 | own | W alerts.ts:75-101, Alerts.tsx:178,209 |
| POST | /push/test | alerts/routes.ts:158 | own | W Alerts.tsx:186 |
| GET | /monitor/capital, /pnl, /exposure, /health | monitor/routes.ts:45-51 | own | W Monitor.tsx:53-56 |

### 1.6 Summary

- No web call targets a route that does not exist: every path found in `apps/web/src` (list above) is registered.
- Routes with no caller at all: `GET /assets`, `GET /security/devices`, `GET /transfers/:id/status`, `GET /swap/stats`,
  `DELETE /addressbook/:id`, `GET /agents/:id/withdrawals`, `GET /derivatives/funding`.
- Routes reachable only from tests / scripts (candidates for V11 screens rather than removal): `/market-data/status`,
  `/market-data/candles`, `/swap/quote`, `/swap/execution`, `/xswap/execution`, `/plans/capabilities`,
  `/bridge/solana/token-account` (GET), `/health/ready`, `/derivatives/live/{jurisdiction,venue-key}`,
  `/derivatives/live/accounts/:id/{policy,mandate*}`, `/derivatives/gmx/jurisdiction`, `/agents/:id/perp/risk`.

---

## 2. Dead ends, unreachable screens, mocks

### 2.1 Client code calling missing routes

None found. `apps/web/src/api.ts` is a 19-line generic `api()/get()/post()` wrapper (no typed client); paths are string
literals at the call sites, so a renamed route would only fail at run time. V11 should add a typed route map or at least
a test that checks every literal against the registered routes.

### 2.2 Client functions with no caller

- `dapi.funding` (apps/web/src/derivatives/api.ts:56) — no caller; the funding history endpoint is not shown anywhere.
- No client function exists for `POST /derivatives/live/accounts/:id/policy` or the account-level mandate routes.

### 2.3 Screens and reachability

All 21 screen files are mounted in `App.tsx:152-169`. None is orphaned, but several are reachable through one path only:

| Screen | Phone | Desktop |
|---|---|---|
| Monitor (`/monitor`) | Settings list only (Settings.tsx:19) | sidebar bottom (App.tsx:133) |
| Research (`/research`) | Agents screen only (Agents.tsx:159) | same |
| Agents (`/agents`) | Home action row + shortcut (Home.tsx:84,109), Settings | sidebar |
| Futures (`/futures`) | Home shortcut (Home.tsx:110) and the Spot / Futures switch on Swap (App.tsx:150) | same — not in the sidebar list |
| Receive, Security | Home, header icon | sidebar |
| Plan (`/plan/:id`) | from PlanCards on Swap, from an alert | same |

The phone tab bar has five entries only: Home, Swap, Send (FAB), Activity, Settings (App.tsx:125). The desktop sidebar
lists the eight `TABS` (App.tsx:51) plus Alerts, Monitor, Lock.

### 2.4 UI controls with no backend, or backend with no control

- Address book: entries can be saved (Send.tsx:167) but never removed or renamed from the UI; `DELETE /addressbook/:id`
  exists.
- Swap "mode" selector (`best_price` / `fastest` / `balanced`, Swap.tsx:300) only reorders the cards. The executed
  route is always the first executable one (Swap.tsx:170) and the server re-quotes its own provider at preparation
  (swap-exec.ts:86); the route id shown is never sent to the server (Swap.tsx:141-143).
- Perp agent risk limits cannot be edited after creation from the UI (`POST /agents/:id/perp/risk` has no caller).
- `GET /swap/stats` (provider latency percentiles) and `/market-data/status` (bar quality per symbol) are computed and
  stored but never displayed.

### 2.5 Mocks, fixtures, sample data in production paths

- `apps/web/src/derivatives/mock*.ts` (mock.ts 692 lines, mockLive.ts 600, mockGmx.ts 359, mockPerpLive.ts 280,
  mockCollateral.ts 167, mockLiveTexts.ts 135, mockRouter.ts) are loaded only behind `import.meta.env.DEV`
  (main.tsx:10-16, `?mock=1`). In a production build that condition is the constant `false`, so the block is removed.
  Not verified on a built bundle in this audit (no build was run); `apps/web/test/perf-v10.test.ts` is the place that
  guards bundle content.
- `mockLiveTexts.ts` is a hand-maintained verbatim copy of `services/api/src/derivatives/live-texts.ts`
  (mockLiveTexts.ts:2-3): two files to keep in sync.
- Search for `TODO|FIXME|XXX|HACK` in `apps/web/src`, `services/api/src`, `packages/swap/src`, `packages/core/src`
  (non-test): no hit. No hard-coded sample balances, prices or positions were found in production code paths.
- Constants that look like data but are pinned estimates: `swapSeconds()` (plan-exec.ts:46: 180 s Ethereum, 20 s
  Solana, 45 s others) and the CCTP gas table (packages/swap/src/providers/cctp.ts:74-80). They are shown as estimates.
- Stale documentation: `README.md:5-7,43` still describes 6 networks and "38 tests"; `services/api/src/swap.ts:1`
  says "there is deliberately no execution endpoint yet" while `swap.ts:90` returns `executionEnabled: true`.

---

## 3. Navigation, i18n, design system

### 3.1 Navigation today

Routing is hand-written in `App.tsx` (no router library): `routeOf()` parses `location` (App.tsx:57-72), `pathOf()`
builds the URL (App.tsx:56), `nav()` pushes history (App.tsx:83). A `Route` is `{ tab, network?, asset?, view? }`.

| URL | `tab` | Component | Chunk |
|---|---|---|---|
| `/` | home | `screens/Home` | first chunk |
| `/assets` | assets | `screens/Assets` | first chunk |
| `/asset/<network>/<asset>` | asset | `screens/Asset` | first chunk |
| `/swap` (`?bridgeFrom=&bridgeTo=&amount=`) | swap | `screens/Swap` (+ `plan.tsx` PlanCards, `bridge.tsx`, `xswap.tsx`) | lazy |
| `/futures[/<venue:symbol>][?v=compare\|accounts\|router]` | futures | `screens/Futures` + `derivatives/*` | lazy, never preloaded |
| `/agents`, `/agents/<uuid>` | agents / agent | `screens/Agents` (`Agents`, `Agent`), `PerpAgent`, `PerpAgentLive`, `AgentFund`, `AgentPaper` | lazy |
| `/research[?job=<id>]` | research | `screens/Research` | lazy |
| `/plan/<uuid>` | plan | `plan.tsx` `PlanScreen` | lazy |
| `/receive[?n=]`, `/send[?n=&a=]` | receive / send | `screens/Receive`, `screens/Send` | lazy |
| `/activity` | activity | `screens/Activity` | lazy |
| `/alerts[?v=settings]` | alerts | `screens/Alerts` | lazy |
| `/monitor` | monitor | `screens/Monitor` | lazy |
| `/security`, `/settings` | security / settings | `screens/Security`, `screens/Settings` | lazy |
| (unauthenticated) | — | `screens/Gate` | first chunk |

Adding a V11 screen means: a `screens/X.tsx` export, an entry in `screens` + a `lazy()` line (App.tsx:19-37), the `Tab`
union (App.tsx:52), `pathOf` / `routeOf`, a render line in `<main>` (App.tsx:152-169), and a nav entry (`TABS` for the
sidebar, `MOBILE` for the tab bar — the tab bar is full at five entries).

### 3.2 i18n FR / EN

- One file, `apps/web/src/i18n.ts` (2 142 lines, about 1 830 keys). Every entry is `key: ['français', 'English']` inside
  the object literal `D` (i18n.ts:3). `Key = keyof typeof D` (i18n.ts:2109) so a missing key is a type error.
- Build: the Vite plugin `spw-i18n-split` (vite.config.ts:25-45, `apps/web/scripts/i18n-split.mts`) takes the literal out
  of the app chunk and emits `virtual:spw-i18n-fr` / `-en`; `i18n-load.ts` loads one language before first render. The
  literal must stay plain data (no computed values).
- Use: `const t = useT(); t('key', { var: value })` — `{var}` placeholders, every occurrence replaced (i18n.ts:2124-2131).
  Unknown key at run time → readable fallback, never a crash.
- Locale is stored in `localStorage['spw-locale']` (App.tsx:76, default `fr`) and also in server settings.
- **Prefix conventions** (each is one contiguous block; additions go inside the block):

| Prefix | Area | Lines |
|---|---|---|
| (none) | nav, gate, home, receive, send, states, activity, security, settings | 4-172 |
| `s_<state>` | proposal state words (`stateKey`, i18n.ts:2142) | — |
| `e_<code>` | API error codes (`errText`, i18n.ts:2133) | — |
| `w_<code>` | transfer warnings | — |
| `sw`, `sw_`, `swFlag_`, `swFee_`, `swKind_`, `swExec_`, `swRisk_` | swap | — |
| `br` | CCTP bridge | 1218 |
| `sc`, `scE_` | Solana ↔ EVM CCTP | 1946-1982 |
| `xs`, `xsHold_` | THORChain | 1378 |
| `pn` | any-to-any plans | 1668-1743 |
| `pa` | perp agents | 228-337 |
| `pl`, `plR_` | perp agent live | 1475-1667 |
| `rj` | research jobs | 338-408 |
| `fx` | futures terminal | 409-581 |
| `rx` | futures router | 582-688 |
| `fl`, `flE_` | live venue trading | 689-1045 |
| `hlc` | venue collateral | 1046-1158 |
| `rk_<code>` | risk-engine verdicts | 1159 |
| `gx` | GMX | 1778-1945 |
| `al`, `mo` | alerts, system status | 1409-1474 |
| `qa` | QA pass of 2026-11-11 | 1273-1377 |
| `hd` | v8 hardening | 1983-2030 |
| `cd`, `dt` | Cardano, Polkadot | 1756-1777 |
| `ds` | v9 design system | 1744-1755 |
| `dz` | v10 design pass | 2031-2107 |

  V11 should take new prefixes (for example `db` Dashboard, `mk` Markets, `cp` Compare, `pm` Private Markets, `rs` Risk,
  `dv` Developer) and keep the one-block rule.
- Alert sentences are not in `i18n.ts`: they are rendered from `packages/core/src/alert-catalog.ts` (FR + EN) so that
  the service worker can use them too. `apps/web/src/reasonTexts.ts` translates a fixed list of server "reason" strings.

### 3.3 Design-system primitives (`apps/web/src/ui.tsx`, 255 lines)

| Export | Line | Use |
|---|---|---|
| `Icon` | 23 | inline SVG by name |
| `Card`, `H`, `Section` | 27, 30, 216 | surface, heading with right slot, titled block |
| `Btn` (`primary` / `soft` / `ghost` / `danger`, `busy`, `full`) | 34 | buttons |
| `Field`, `inputCls` | 39, 42 | labelled input |
| `Notice` (`info` / `warn` / `danger` / `ok`) | 44 | inline message |
| `StatePill` | 56 | proposal state |
| `Tag` (tone + icon) | 201 | state as icon + word |
| `Stat`, `StatGrid` (2 / 3 / 4 columns) | 205, 208 | figure tiles |
| `Fact` | 212 | receipt row (`dl`), value never cut |
| `Timeline` (`done` / `current` / `next` / `failed`) | 225 | steps of a plan, bridge, collateral move |
| `ProgressRing` | 233 | n / total |
| `Fold` | 240 | secondary detail |
| `Sheet` (`sub`, `footer`, `busy`, `wide`, `dismissable`) | 158 | every bottom sheet / dialog |
| `Seg`, `Chips` | 127, 78 | segmented control, filter chips |
| `PageTitle` | 115 | large title that collapses into the header |
| `EmptyState`, `ErrorState` | 121, 244 | empty, error / offline with retry |
| `Skeleton`, `SkeletonRows`, `SkeletonCard`, `SkeletonStats` | 106-253 | loading shapes |
| `AnimatedNumber`, `Change`, `Money` | 138, 85, 91 | figures, % change, hideable amount |
| `Coin`, `NetDot`, `AssetIcon`, `NetworkIcon`, `ProviderIcon`, `VenueIcon` | 74, 76, 5 | logos |
| `Addr`, `short`, `CopyBtn` | 61-67 | addresses |
| `trimAmt`, `exactAmt`, `numFmt`, `fiat`, `usdCapital`, `when` | 95-103 | formatting (fr-CA / en-CA) |
| `usePullToRefresh`, `haptic` | 182, 8 | phone gestures |
| `testNotSent` | 105 | test-mode detection (see bug B2) |

Charts (`apps/web/src/chart.tsx`, 94 lines, hand-written SVG, no chart library):
`Spark` (line 5, list-row trend), `AllocationBar` (line 20, segmented share bar + legend, max five parts + other),
`PriceChart` (line 45, single series, area wash, crosshair, `onHover`). The futures terminal has its own canvas candle
chart, `derivatives/Candles.tsx` (168 lines, intervals, overlays). There is no multi-series, bar, or comparison chart.

Design rules are in `docs/v9/DESIGN.md` and `docs/v10/SHOWCASE.md`; visual baselines in
`tests/e2e/v9-visual.spec.ts-snapshots` and `v10-visual.spec.ts-snapshots`.

### 3.4 The ten V11 target sections against what exists

| Target | Exists today as | What it lacks |
|---|---|---|
| **Dashboard** | `Home.tsx` (total, allocation bar, actions, four shortcuts, pending transfers) and `Monitor.tsx` (capital, P&L, exposure, health) | one page joining the two; price freshness stamp; P&L over time (Monitor has today / 7 d / 30 d numbers, no series chart); `/monitor/*` is not reachable from the phone tab bar |
| **Markets** | `Assets.tsx` (held and registry assets with price, 24 h change, sparkline) and `Asset.tsx` (CoinGecko chart, stats) | a market list independent of holdings; watchlist; perp markets are only inside Futures; `/market-data/candles` and `/market-data/status` (own multi-source bars with quality flags) are unused by the UI |
| **Trade** | Spot / Futures switch (App.tsx:150): `Swap.tsx` and `Futures.tsx` (paper terminal, Hyperliquid live, GMX v2) | a single entry in navigation; spot limit orders (none); a unified order ticket |
| **Compare** | swap route cards (Swap.tsx:175-224), `derivatives/Compare.tsx` (perp venues per base asset), `derivatives/Router.tsx` (cost ranking, simulation) | a dedicated screen; side-by-side table with the per-route fields of §4.4; spot-venue comparison beyond the swap providers |
| **Private Markets** | nothing (no code, no route, no i18n key) | everything |
| **Swap** | `Swap.tsx` + `bridge.tsx` + `xswap.tsx` + `plan.tsx` | see §4 and bugs B1, B3, B6 |
| **Agents** | `Agents.tsx`, `PerpAgent.tsx`, `PerpAgentLive.tsx`, `AgentFund.tsx`, `Research.tsx` | Research is reachable only from Agents; perp risk edit has no UI |
| **Risk** | spread over `Monitor.tsx` (exposure real / simulated), `Security.tsx` (signer limits, spent today), per-account risk policy sheets in Futures, swap risk flags | a dedicated screen; no aggregate route (limits + exposure + open cross-chain operations + provider health in one answer) |
| **Activity** | `Activity.tsx` (`/activity`: proposals + deposits) and CSV export | filters; swaps show no received amount in the CSV (server.ts:231 writes every proposal as `send`); GMX order transactions appear as `send` (bug B7); agent, venue and plan events are not in the feed (they are in `/security/audit` and `/alerts`) |
| **Developer / API** | nothing user-facing. Related: alerts webhook (Alerts.tsx:223-228), `/security/audit`, the research-runner secret | API keys / tokens (auth is a passkey session cookie only), a route reference, a request log. Any token-based access changes the threat model (`docs/threat-model/threat-model.md`) and must be read-only by construction |

---

## 4. Swap / bridge / cross-chain stack

### 4.1 Architecture

- `packages/swap`: adapters (`providers/*.ts`), `ProviderRuntime` (deadline, token bucket, circuit breaker, latency
  percentiles — runtime.ts:17-66), `QuoteAggregator` (parallel, streaming, structural validation `checkQuote` —
  aggregator.ts:9-25), `LiquidityGraph` (registry nodes, capability edges, USDC / USDT / native hubs — graph.ts),
  `SwapRouter` (direct quotes + two-leg hub routes, three modes, Pareto — router.ts), `risk.ts` (valuation, flags),
  `plan.ts` (multi-leg plan enumeration and pricing).
- `enabled.ts`: deBridge is off unless `SPW_SWAP_ENABLE=debridge` (licence forbids "aggregation purposes",
  enabled.ts:6-11); `SPW_SWAP_DISABLE` removes any provider; LI.FI keyless is rate-limited to 0.01 req/s, burst 6,
  marked `scarce` (direct cross-chain requests only, enabled.ts:14).
- Execution is never "send the provider's transaction". Each executable path is a proposal (`proposals` table) whose
  intent is hashed, approved with the passkey, and **rebuilt or decoded by the isolated signer** from `packages/core`.
- What makes a route executable is decided by the API from pinned tables, not by the provider (swap.ts:44-55).

### 4.2 Per provider

All eight public endpoints answered HTTP 200 on 2026-11-15 from the audit machine (one read-only GET each; LI.FI:
one `GET /v1/chains`).

| Provider | Quote | Execution | Networks (execution) | Signer verification | Recovery |
|---|---|---|---|---|---|
| **KyberSwap** (keyless, `x-client-id`) | yes — 8 EVM networks (kyberswap.ts:20) | **yes**, same-chain | ethereum, base, arbitrum, polygon, optimism, bsc, avalanche, hyperevm (`KYBER_ENABLED`, swap-evm.ts:28-39) | Router `0x6131…37b5` pinned (swap-evm.ts:19). Signer decodes the calldata with the router ABI and requires: canonical re-encoding, `srcToken` / `dstToken` = intent assets, `dstReceiver` = wallet, exact `amount`, `minReturnAmount ≥` approved minimum, no fee receivers, no permit, no partial fill on the reduced HyperEVM router, exact-amount approval (swap-evm.ts:50-92). Calldata is bound by `dataHash` in the intent. The **API** (not the signer) checks the router bytecode SHA-256 on every RPC and refuses if the wallet address carries code (swap-exec.ts:38-45) | approval mined first, swap re-simulated before relay (swap-exec.ts:160-178); worker `reconcile` re-broadcasts and tracks (worker.ts:26-48); received amount read from the `Swapped` event (swap-exec.ts:181-196) |
| **Jupiter** (Metis, keyless `/swap/v2/build`, optional `JUPITER_API_KEY`) | yes — Solana | **yes**, same-chain | solana | Program `JUP6…TaV4` pinned with ProgramData slot, upgrade authority and executable SHA-256 (`JUPITER_PIN`, swap-sol.ts:45-52). The signer decodes the v1 message itself (`verifyJupiterSwap`, swap-sol.ts:191; `route_v2` / `shared_accounts_route_v2` discriminators) and enforces in / out mints, amounts, minimum output, accounts. API re-checks the ProgramData header on every endpoint (swap-exec-sol.ts:68) | swap-exec-sol.ts:286-318 (advance, outcome from balance change); blockhash expiry bounds the window |
| **LI.FI** (keyless: 75 route requests / 2 h; `LIFI_API_KEY` lifts the cap) | yes — 12 networks incl. bitcoin, sui, tron, solana (lifi.ts:26-39) | **no** | — | none. Executability `opaque` (lifi.ts:178): Diamond calldata cannot be recomputed by the signer | — |
| **CCTP V2, EVM** (Circle Iris API, keyless) | yes — USDC on 8 networks, EURC quote on 3 (cctp.ts:60-69) | **yes** | ethereum, avalanche, optimism, arbitrum, base, polygon, hyperevm (`CCTP_ENABLED`, core cctp.ts:57-66) | TokenMessenger `0x28b5…cf5d`, MessageTransmitter `0x81D4…4B64`, minter pinned with proxy and implementation bytecode hashes (core cctp.ts:27-66); the API checks them on every RPC (bridge.ts:58). The signer builds the burn itself from the intent (`buildCctpBurnTxs`), and signs exactly one `receiveMessage` per bridge without a passkey after `verifyCctpMint` matched the attested message to the approved burn (signer.ts:247-290); further mint signatures need the passkey, max 6 | phases `burn → attesting → ready → mint_sent → done` or `mint_failed` stored in `proposals.bridge` (bridge.ts:36-51); gas parameters stored **before** the signer is asked so a crash repeats the identical request (bridge.ts:44); worker `bridges` loop every 5 s (worker.ts:101); holds with codes (`attestation_late`, `destination_gas`, `destination_busy`, `mint_would_fail`, `fee_above_policy`, `message_mismatch`, `attestation_expired`); manual `finish` and passkey `retry-mint` |
| **CCTP V2, Solana** (domain 5) | yes | **yes**, Solana ↔ the seven EVM networks | solana | Programs `CCTPV2Sm4…` / `CCTPV2vPZ…` pinned (`CCTP_SOL_PINS`, cctp-sol.ts:29-47); every transaction built by the signer from the intent or the stored bridge record (signer.ts:13, 296-353) | same phase machine; plus event-account rent reclaim after 5 days (bridge-sol.ts:426-450, passkey) and USDC token-account creation (bridge-sol.ts:510-552) |
| **THORChain** | yes — keyless Liquify gateway (thorchain.ts:300) | **yes**, pinned pairs only | sources: bitcoin, litecoin, ethereum (ETH, USDC, USDT, DAI, WBTC); destinations: those + dogecoin (core thorchain.ts:54-64) | The signer rebuilds memo `=:ASSET:DEST:LIMIT` and the transaction (`verifyXswap`, core thorchain.ts:283), and **asks five compiled-in THORNode operators itself**; it signs only if ≥ 3 answer and all confirm the vault, within 50 blocks of each other (core thorchain.ts:99-109, signer vaults.ts:23, signer.ts:392-400). EVM router `0xD37B…7146` pinned by bytecode hash (thorchain.ts:83-86). API adds: two-operator quote agreement within 1 %, pool guard, vault holds ≥ 100× the amount (xswap.ts:28-30) | phases `sending → sent → observed → outbound → received / refunded` (xswap-state.ts:6-70, pure reducer); worker `xswaps` loop every 10 s; a vault payment is never re-broadcast late in its window (worker.ts:39); refund detected and reported; manual `refresh` |
| **Maya** | yes — 3 networks (maya.ts) | **no** | — | none (`quote_only`) | — |
| **deBridge (DLN)** | adapter present, **off by default** (enabled.ts:11) | **no** | — | none (`opaque`, debridge.ts:156) | — |

Not present at all: Uniswap direct, 0x, 1inch, Odos (API shut down 2026-07-30, providers/index.ts:2), Rango, Socket,
Across, Stargate, Wormhole.

### 4.3 Multi-leg plans (any-to-any) — resumability

- `plan-state.ts` is a pure state machine (`planCreate`, `planAttach`, `planAdvance`, `planPause`, `planRetry`,
  `planReplan`, `planStop`); `plan-exec.ts` gathers observations and stores the document in `plans` (plan-exec.ts:65-71).
- A plan never signs. Each leg is an ordinary proposal created through the same HTTP route the owner would use
  (`app.inject`, plan-exec.ts:229-233), only when the previous leg has settled, sized on the amount **actually
  received** (`legAmount`, plan-state.ts:76-79), re-quoted then, approved with its own passkey assertion.
- "Settled" needs the on-chain received amount: `out_amount` for a swap, `bridge.phase === 'done'`, or
  `xswap.phase === 'received'` (plan-state.ts:45-59).
- Recovery: worker `plans` loop every 6 s (worker.ts:103) and every `GET /plans/:id` advance the plan from stored state,
  so a restart resumes where it was. A failed / rejected / refunded leg pauses the plan with a code; an expired approval
  window makes the leg ready again. Controls: retry (optionally with a new floor), replan from the asset held, stop.
- Limits: max 3 legs (plan-exec.ts:239), **one open plan at a time** (plan-exec.ts:254-255), per-plan lock is an
  in-process `Map` (plan-exec.ts:73-78 — single API process assumed), owner floor checked before each leg
  (plan-exec.ts:299-302).
- Gaps: see B5 (idempotency replay) and B2 (test mode leaves a leg in flight for ever).

### 4.4 Route comparison today against the V11 per-route fields

`viewRoute` (swap.ts:39-63) is the route object; `routeCard` (Swap.tsx:175-224) renders it.

| Target field | Today |
|---|---|
| amount sent | present: the request amount; `valuation.inUsd` shown under the input (Swap.tsx:253). Not repeated per card |
| estimated received | present: `amountOutDisplay`, and `minAmountOutDisplay` (Swap.tsx:205-206) |
| network fee | partial: `fees[]` items of kind `network` with `estimated`, `includedInOutput`, `usd` (swap.ts:61). KyberSwap gas and CCTP gas are estimates; Jupiter does not report token-account rent (jupiter.ts:171). The card headline shows only the **sum** `valuation.extraFeesUsd` (Swap.tsx:209); per-kind lines are visible on the executable card or after expanding |
| protocol fee | partial: fee kinds `protocol` / `provider` / `bridge` / `affiliate` exist (types.ts:44); shown in the same list, not as its own column. Fees already inside the output are flagged, not quantified separately in the headline |
| slippage | partial: the tolerance is a page-level setting (30 / 50 / 100 bps, Swap.tsx:262); per route only `priceImpactBps` is shown when every leg reports it (swap.ts:59, Swap.tsx:210). The effective tolerance per route is not displayed |
| ETA | present when the provider gives one (`estimatedSeconds`, null otherwise — never invented, Swap.tsx:208) |
| risks | present: `risk.level`, `risk.score`, `flags[]` with codes (`cross_chain`, `no_refund_path`, `better_than_market`, `outlier_vs_peers`, `price_impact`, `opaque_transaction`, `not_executable`, …  risk.ts:22-44); `atomic`, `refundable`, `executability.class` |
| steps | present: `steps[]` with kind, provider, from, to, venues, contracts (swap.ts:60); contracts are returned but **not rendered** |
| per-step status | **absent** on routes (a route is a quote). Present only after execution, in three different shapes: `proposal.swap` (approval state + received), `proposal.bridge` (`stage`, hold), `proposal.xswap` (`stage`), and for plans `legs[].state` + `attempts[]`, rendered with `Timeline` (plan.tsx:226) |
| executable here | present: `executable`, `exec.via` |

Missing for a real comparison screen: a normalized fee breakdown (network / protocol / included) per route, the
effective minimum per route as a percentage, a stable sort / column view, quote age (`expiresAt` is sent but not
shown), and one status model shared by swap, bridge, xswap and plan legs.

### 4.5 Adding 0x and 1inch

Both need an API key (confirmed from their documentation and by a live keyless call on 2026-11-15):

- **0x Swap API v2** — "Every 0x API call requires an API key": headers `0x-api-key` and `0x-version: v2`; indicative
  `GET /swap/allowance-holder/price`, firm `GET /swap/allowance-holder/quote` (also `/swap/permit2/*`). Keyless call
  → `401 "No API key found in request"`. The quote returns `transaction.{to,data,value,gas}`, `allowanceTarget`,
  `minBuyAmount`, `fees.zeroExFee`, `issues`. Approvals go to **AllowanceHolder** (example
  `0x0000000000001ff3684f28c67538d4d072c22734`) or Permit2, never to the Settler contract.
  Source: https://docs.0x.org/evm/0x-swap-api/guides/swap-tokens-with-0x-swap-api.md
- **1inch Classic Swap v6.1** — base `https://api.1inch.com/swap/v6.1/{chainId}`, `Authorization: Bearer <key>` from the
  1inch Business portal; `/quote`, `/swap`, `/approve/transaction`, `/approve/allowance`. Keyless call → `401
  Unauthorized`. Router / spender: AggregationRouterV6 `0x111111125421ca6dc452d289314280a0f8842a65`.
  Source: https://business.1inch.com/portal/documentation/apis/swap/classic-swap/quick-start

**As quote sources** (comparison only) — small, fits the existing contract (`docs/swap/adding-a-provider.md`):
1. `packages/swap/src/providers/zeroex.ts` and `oneinch.ts`: `needsKey: true`, `configured: !!env.ZEROEX_API_KEY` /
   `ONEINCH_API_KEY`; the aggregator already skips and reports an unconfigured keyed provider (aggregator.ts:44).
   Executability `opaque`; same-chain EVM only; `supportsPair` limited to registry assets.
2. Register in `providers/index.ts`; add `POLICY` entries in `enabled.ts` for the free-tier rate limits (to be read
   from each dashboard at sign-up — not verified here); recorded fixtures + tests; `scripts/smoke-swap-<id>.mts`;
   dossier `docs/swap/providers/<id>.md`; `ProviderIcon` logos; display names.
3. Terms of use must be read first for the same reason deBridge is off (aggregation / comparison clauses) — not
   reviewed in this audit.
4. The keys live in the API process environment (the same node that serves the web app). They never reach the signer.

**For execution** — a new signer capability each, comparable to the KyberSwap work:
1. New intent section / provider value (`IntentSchema`, packages/core/src/intent.ts:7) and a `verify<X>Swap` in
   `packages/core` that decodes the calldata and proves recipient, tokens, exact input and minimum output.
   - 1inch: decode AggregationRouterV6 `swap(executor, desc, data)` (`desc.dstReceiver`, `desc.minReturnAmount`) and
     the `unoswap*` / `clipperSwap*` families, which encode the receiver and minimum differently. Each function family
     needs its own decoder; refuse the others.
   - 0x: `transaction.to` is a Settler (or AllowanceHolder `exec` wrapping a Settler call); the Settler is redeployed
     over time (0x publishes a registry — to confirm in their docs), so a single pinned address + bytecode hash, the
     model used for KyberSwap, does not hold as is. The pin would have to be AllowanceHolder + a per-chain set of
     reviewed Settler code hashes, and the decoder must handle Settler's action list (`execute(slippage, actions, …)`,
     where `slippage` carries recipient, buy token and minimum amount).
2. New pins: contract address and runtime bytecode SHA-256 **per network**, each after reading the verified source
   (the rule stated at swap-evm.ts:22-27), plus exact-amount approval to the right spender (1inch router; 0x
   AllowanceHolder — not the transaction target).
3. API preparation path (guards on every RPC, fresh firm quote, simulation, nonce agreement), fork proofs
   (`scripts/fork-swap-<id>.mts`), signer tests for every refusal, policy unchanged.
4. Signer release and re-deployment on the signer node (pins are compiled into the signer bundle).

Recommendation for V11: quote sources only, behind keys, labelled "comparison only"; execution stays KyberSwap /
Jupiter / CCTP / THORChain until a pin review is done.

---

## 5. Performance and resilience

### 5.1 What exists

| Topic | State | Where |
|---|---|---|
| WebSocket | none in the web app or the API routes. Venue streams (Hyperliquid, dYdX) are server-side, in `packages/derivatives/src/venues/*/stream.ts` | — |
| SSE | five streams: swap quotes, alerts unread, derivatives market, live account, research log | swap.ts:107, alerts/routes.ts:70, derivatives/routes.ts:88, live-routes.ts:80, research/routes.ts:148 |
| Heartbeats | `: keep-alive` every 15 s on alerts, derivatives, live streams; research stream polls the DB every 1 s. **None on the swap quote stream** (it lives ≤ 4.5 s) | alerts/routes.ts:85, derivatives/routes.ts:96, live-routes.ts:92 |
| Reconnect | browser `EventSource` auto-reconnect; `retry: 5000` (alerts), `retry: 3000` (research); alerts and research streams end after 10 min so the session is re-checked | alerts/routes.ts:15,77 |
| Fallback polling | market store: snapshot every 5 s when the stream is silent, connection state `connected / reconnecting / stale / error` shown (store.ts:52-95); unread count polled every 60 s (alerts.ts:16); live account falls back to polling (liveStore.ts:47) | — |
| Stream caps | alerts 8, research 6, derivatives 24 concurrent streams. **No cap on swap quote streams** | alerts/routes.ts:15, research/routes.ts:33, derivatives/routes.ts:15 |
| Caches (server) | CoinGecko: TTL + stale-on-error + in-flight dedup + 15 s failure memory (gecko.ts); balances 12 s per network (server.ts:182); signer status 5 s (signer-client.ts:38); monitor answers 10–30 s (monitor/routes.ts:45-51); RPC health refreshed every 45 s by the worker | — |
| Request dedup | CoinGecko only (gecko.ts `inflight`). The `cached()` helpers in server.ts:43-49 and monitor/routes.ts:13-19 do not share an in-flight promise: concurrent misses each run the loader | — |
| Client cache | TanStack Query: `retry: 1`, `staleTime: 5000`, `gcTime: 0`, refetch on focus (main.tsx:9); 47 `refetchInterval` call sites | — |
| Rate limiting | global 240 / min per IP; strict limits on auth and webhook / push tests; per-provider token buckets and circuit breakers (4 failures → open 30 s) | server.ts:102, runtime.ts:4 |
| Provider failover | quotes: providers run in parallel with own deadlines, a failure becomes a `provider` event, the others still answer (aggregator.ts:36-56). RPC: `rpcAny` first-that-answers for display reads; `rpcQuorum` (all endpoints must answer and agree) for anything that feeds a signature (rpc.ts:20-33) | — |
| Portfolio isolation | one failing network yields `error: 'unavailable'` rows; the others are returned (server.ts:180-189) | — |
| Worker loops | eight loops with a heartbeat record each (runs, last ok, last error, failures), shown on Monitor and used by the "worker failing" alert | worker.ts:84-106, loop-stats.ts |
| Alerting | dispatcher tails the audit chain, risk events, research log; in-app + Web Push + signed webhook; quiet hours | services/api/src/alerts/* |
| Health | `/health/live` public, `/health/ready` and `/monitor/health` authenticated (connectors, loops, backup age, audit-chain integrity, disk, lab sandbox, capabilities) | monitor/routes.ts:51, monitor/health.ts |
| Front-end weight | first chunk 257 kB after v10, a chunk per screen, one language at a time, idle preload | App.tsx:16-47 |

### 5.2 Gaps

1. **Execution is blocked by one RPC of a pair.** `rpcQuorum` requires every endpoint to answer (rpc.ts:28); a single
   degraded public RPC makes every send / swap / bridge on that network answer `rpc_degraded` 503. Reads survive. This
   is a deliberate safety choice, but there is no third endpoint and no 2-of-3 mode.
2. **The signer is a single point for most screens.** `/portfolio`, `/accounts`, `/swap/quote*`, `/plans/quote` call
   `signer.status()` (5 s cache, 15 s timeout, signer-client.ts:24,38). If the signer node is unreachable Home fails
   as a whole — no last-known addresses are kept.
3. **No freshness stamp on prices.** `/portfolio.asOf` is the time of the HTTP answer (server.ts:192), not the time
   CoinGecko answered; with stale-on-error the prices can be older than the TTL with nothing saying so. Home, Assets
   and Asset show no "as of" for prices. Only Monitor and the futures terminal show data age.
4. **Single price source.** All fiat valuation (portfolio, swap valuation and the `better_than_market` /
   `below_market` risk flags, plan estimates) comes from CoinGecko's free tier (server.ts:61-78). When it is down the
   swap risk engine marks every route `no_market_reference` (risk.ts:36).
5. **Structured logging is partial.** Fastify logs at `warn` with redaction (server.ts:100); 35 `console.log/warn`
   calls elsewhere in `services/api/src` are free text (`[worker] …`). No request id, no per-request latency log.
6. **No metrics endpoint.** No Prometheus / OpenTelemetry. Latency percentiles exist only for swap providers
   (in memory, runtime.ts; in SQL, `/swap/stats`, which nothing displays).
7. **`swap_quotes` grows without bound.** One row per provider answer per search, i.e. per pause in typing
   (swap.ts:79-83); no pruning job exists (db.ts:47-51, worker.ts).
8. **Quote stream cost.** Each stream triggers every compatible provider plus up to four hub searches (router.ts:53);
   there is no per-pair result cache, no cap on concurrent streams, and the stream has no `retry:` field — the UI
   closes it on error and shows a generic message (Swap.tsx:131).
9. **Two independent provider runtimes.** `planRoutes` builds its own `ProviderRuntime` set with a looser policy
   (plan-exec.ts:82-83: 3 req/s, burst 12), so the token buckets and circuit breakers of `swap.ts` do not protect the
   keyless quotas from plan pricing.
10. **In-process state.** Plan locks, caches, stream counters and loop heartbeats live in process memory: correct for
    one API process, wrong for two.
11. **Global rate limit and the terminal.** 240 requests / minute covers everything the one owner does; the futures
    terminal, 47 polling queries and several open tabs share it. `tests/e2e/v10-reqcount.mts` exists to measure this;
    the figure was not re-measured here.
12. **SSE answers bypass the header hook.** `reply.hijack()` + `raw.writeHead` (swap.ts:110-111 and the four others)
    does not send the CSP / `nosniff` / HSTS headers set in `onRequest` (server.ts:105-109). Low impact (JSON events,
    same origin), but inconsistent.
13. **The service worker caches nothing** (sw.ts:2-3, by design): offline, the app shows `ErrorState` only.

---

## 6. Bugs, inconsistencies, security observations (severity-ranked)

Severity: **High** = the owner can be shown a wrong amount or a wrong state for real funds; **Medium** = wrong or
blocked behaviour without a wrong signature; **Low** = cosmetic, hygiene.

No finding lets the API or the UI obtain a signature the signer would otherwise refuse: every executable path is
re-verified in `packages/core` by the signer process. The findings below are about what the owner **sees**.

### B1 — High — On a CCTP pair, "Vous recevez" shows the top comparison quote, not the CCTP amount (confirmed)

- `chosen = sorted[0]` (Swap.tsx:161) is the best route of the stream whatever its provider. The "You receive" hero
  and its "minimum" line render `chosen.amountOutDisplay` / `chosen.minAmountOutDisplay` (Swap.tsx:257-258).
- When `isBridge` is true (USDC → USDC between two CCTP networks, Swap.tsx:97), the action executed is
  `POST /bridge/proposals` with the selected speed (Swap.tsx:141), whose real result is the option's
  `minReceiveDisplay` shown lower in the CCTP card (Swap.tsx:283). The hero therefore shows a figure from another
  provider (LI.FI, or the CCTP fast quote while "standard" is selected) that will not be executed.
- Same family, non-bridge pairs: when the best-ranked route is comparison-only and an executable route exists, the
  hero still shows the comparison route's output while the button executes `ex` (Swap.tsx:170, 232-233). A warning
  line (`swExecNotBest`) is shown, but the headline number is not the executed one.
- The review sheet is correct (it shows the proposal's own figures), so the signed amount is right; the pre-review
  headline is not.
- Fix direction: hero = selected CCTP option when `isBridge`, else the executable route; show the comparison best as a
  secondary line.

### B2 — High — Test mode records an unsent transaction as `broadcast` (confirmed)

- `broadcastNow` with `SPW_BROADCAST=off` moves the proposal to state **`broadcast`**, sets `broadcast_at`, and stores
  the English string `broadcast disabled (test mode)` in `error` (transfers.ts:233).
- The worker then skips it for ever (`if (!config.broadcast …) continue`, worker.ts:37): the row never leaves
  `broadcast`.
- Consequences, all read in code:
  1. Every later send / swap / bridge on the same network is refused with `pending_tx`, because the in-flight check
     counts `broadcast` rows (transfers.ts:164, 207; swap-exec.ts:135). One test transfer blocks the network until the
     row is edited in the database.
  2. The UI detects the case by a regular expression on that English sentence (`testNotSent`, ui.tsx:105;
     `TEST_NOT_SENT`, AgentFund.tsx:272). Changing or translating the server text silently breaks the detection and
     the row would then display as really broadcast.
  3. The row is listed in `/portfolio.pending` (server.ts:191), in `/activity`, exported as `send` in the CSV
     (server.ts:231), and its destination becomes a "known" address for the new-destination warning
     (transfers.ts:105-106).
  4. A plan leg in test mode stays `in_flight` for ever (plan-state.ts:57-58).
- Agent-vault withdrawals already do this properly with a dedicated `not_sent` state (agents/withdrawals.ts:124).
- Production runs with broadcast on, so this is a development / QA / fork-test defect — but it is the default of
  `scripts/dev-stack.sh` (line 16) and of every e2e run.
- Fix direction: a terminal `not_sent` state (or a `sent: false` column) in the proposal state machine, excluded from
  the in-flight checks; UI keyed on the state, not on the text.

### B3 — Medium — Server-authored English sentences are shown raw in the French UI (confirmed)

`UserError` messages and stored `error` / `holdDetail` / `pause.message` strings are English only. The UI translates
by code where a key exists (`errText`, i18n.ts:2133-2140) but prints the server sentence in these places:

| Where | What is printed |
|---|---|
| Swap.tsx:352, 374; xswap.tsx:91 | `prop.error` of a failed / expired proposal |
| Activity.tsx:58 | `i.error` |
| bridge.tsx:81 | `b.holdDetail` (for example "add ETH on Base: … is needed to receive the USDC") |
| bridge.tsx:80 | `b.delayReason` (Circle's reason) |
| xswap.tsx:59 | `x.holdDetail` |
| plan.tsx:254 | `p.pause.message` |
| plan.tsx:226 | `a.error` of the last attempt |
| plan.tsx:79 | `skipped[0].message` |
| Swap.tsx:191 | risk flag `detail` ("output worth 96.2 % of input", "more than 5 % above the median of other providers") |
| Swap.tsx:222 | `executability.reason` (long English sentences from each adapter, e.g. kyberswap.ts:108, lifi.ts:178) |
| AgentFund.tsx:167, 260 | leg / withdrawal errors |
| PerpAgent.tsx:160-162, 250; PerpAgentLive.tsx:134, 339; Research.tsx:137, 165 | agent hold / stop / refusal reasons |
| Monitor.tsx:102-140 | connector `detail`, loop `lastError`, capability `why` (capabilities.ts) |
| i18n.ts:2139 | `errText` appends the English server detail whenever it contains a digit |

The derivatives area already solved this (`?locale=` and server-side FR / EN tables: `derivatives/live-texts.ts`,
`market-texts.ts`; `reasonTexts.ts` on the client). The swap / bridge / plan / transfer area has not.
Fix direction: codes + parameters from the server, sentences from `i18n.ts` (the pattern of `alert-catalog.ts`).

### B4 — Medium — A duplicate idempotency key answers 409 instead of the original proposal (confirmed)

`POST /transfers/proposals` returns the existing proposal for a repeated key (transfers.ts:120-121). The swap, bridge
and xswap routes do the whole preparation first, then `insert … on conflict do nothing` and answer
`409 conflict "duplicate request"` (swap-exec.ts:148-149, swap-exec-sol.ts:267-268, bridge.ts:225-226,
bridge-sol.ts:263-264, xswap.ts:258-259). A client retry after a lost response cannot recover the challenge, and the
provider is called again for nothing. The web client uses a fresh UUID per click (Swap.tsx:141-143), so a network
retry is not idempotent at all.

### B5 — Medium — A plan can stay stuck on `conflict` after a crash between "proposal created" and "plan saved" (by reading, not reproduced)

`/plans/:id/prepare` derives the leg's idempotency key from `(plan, replans, current, attempts.length)`
(plan-exec.ts:306), injects the proposal route, and only then stores `planAttach` (plan-exec.ts:318). If the process
stops between the two, the proposal exists but the plan does not know it: the next `prepare` reuses the same key, gets
409 `conflict` (B4), which is in `TRANSIENT` (plan-state.ts:152) and is therefore re-thrown instead of pausing — every
retry fails the same way because `attempts.length` never changes. The orphan proposal expires by itself; funds are not
at risk. The way out today is "replan" (increments `replans`). Fixing B4 (return the existing proposal) fixes this.

### B6 — Medium — The route the owner looks at is not the route that is prepared

The stream's routes are indicative; `prepare` sends only network, assets, amount and slippage (Swap.tsx:141-143) and
the server asks a fresh KyberSwap / Jupiter route with RFQ and limit-order sources excluded (swap-exec.ts:86). The
review sheet shows the firm figures, so nothing wrong is signed, but there is no comparison between the quoted and the
firm output and no notice when they differ materially. The detection of a THORChain execution is also derived from
the stream content rather than from the pair (Swap.tsx:140): if the stream has not finished or THORChain timed out,
the button posts to `/swap/proposals`, which answers `swap_not_enabled`.

### B7 — Low — GMX order transactions appear as "send" in Activity and the CSV

`/activity` maps kinds `swap` / `xswap` → `swap`, `bridge` → `bridge`, everything else → `send` (server.ts:215); a
`gmx` proposal (derivatives/gmx-exec.ts:441-442, `to_addr` = the GMX ExchangeRouter) is therefore listed as a send to
that contract. The CSV writes every proposal as `send` with the input amount only, including swaps and bridges
(server.ts:231).

### B8 — Low — Stream errors lose their code

`/swap/quote/stream` validates before hijacking (swap.ts:108); a `bad_amount`, `same_asset` or 401 answer is a JSON
error that `EventSource` reports as a bare `error` event, so the UI shows the generic "swError" state (Swap.tsx:131,
303-305). After the hijack, exceptions are sent as an SSE event named `error` with a message
(swap.ts:119) that the client treats identically.

### B9 — Low — Hygiene

- `cache.delete('prices')` (server.ts:260) deletes a key that is never written (prices moved to `gecko.ts`).
- `/swap/providers` returns `executionEnabled: true` as a constant (swap.ts:90).
- `Seg` slippage choices are 30 / 50 / 100 bps in the UI while the quote route accepts up to 500 (swap.ts:19) and the
  proposal routes up to 300 (swap-exec.ts:114): three different bounds.
- `/portfolio` on a failed network falls back to `n.tokens` instead of `liveTokens(n)` (server.ts:188 vs 183): an asset
  disabled by its identity check reappears as "unavailable".
- README and the header comment of `swap.ts` are stale (§2.5).
- `mockLiveTexts.ts` duplicates server texts by hand (§2.5).

### Security observations (no defect found, worth stating for V11)

- The API key model for 0x / 1inch / LI.FI puts third-party keys in the API process environment; the quote requests
  carry the wallet's addresses (`sender` / `recipient`, swap.ts:74). Each added keyed provider is one more party that
  can link the owner's addresses to an account.
- Router bytecode pins are checked by the **API**, not by the signer (the signer has no RPC except the THORNode
  operators and a price source). A compromised API cannot change the calldata rules, but it is the only component
  that would notice a router upgrade. This is the existing, documented trust split (`docs/threat-model`).
- A "Developer / API" section with tokens would be the first non-passkey credential in the system. Keep it read-only
  and outside every route that creates a proposal.

---

## 7. Test organisation and conventions

### 7.1 Vitest

- One root config, `vitest.config.ts`: includes `packages/*/test/**/*.test.ts`, `services/*/test/**/*.test.ts`,
  `apps/*/test/**/*.test.ts`; `testTimeout` 30 s, `hookTimeout` 180 s; `globalSetup: services/api/test/global-db.ts`.
  There are no separate vitest projects: one run, selected by path (`npx vitest run services/api/test/bridge.test.ts`).
- Commands (package.json): `pnpm typecheck` (seven `tsc -p` in sequence), `pnpm test` (`vitest run`), `pnpm build`,
  `pnpm e2e`. Node ≥ 24, pnpm 11.1.2.
- Tests sit next to their package in `test/`, never in `src/`.

### 7.2 Per-run test databases (`services/api/test/test-db.ts`)

- `global-db.ts` creates one run id (`SPW_TEST_RUN`) and drops every database of the run at the end.
- A database test file calls `createTestDb('<label>')` **before importing anything from `src/`** (the API reads
  `DATABASE_URL` at module load), then sets `process.env.DATABASE_URL` and imports dynamically. Name:
  `spw_t_<start base36>_<4 hex of repo path><4 random hex>_<label>`; label is `[a-z0-9_]{1,30}` and must be unique per
  file.
- Admin connection: `SPW_TEST_ADMIN_URL` or `postgres:///postgres` (local PostgreSQL 17). Leftovers:
  `scripts/clean-test-dbs.sh`. `services/api/test/test-db.test.ts` tests the helper itself.
- Two checkouts or two runs on the same machine do not share anything — the reason a baseline run can be in progress
  in this checkout while other work goes on.

### 7.3 Provider and chain fixtures

- Swap providers: real responses recorded from the live API under `packages/swap/test/fixtures/<id>/`, replayed
  through the injected `HttpClient`; recorders in `scripts/record-swap-*-fixtures.mts`.
- `buildServer({ swapProviders, derivatives, live, collateral, gmx, plan })` (server.ts:98) is the injection point: API
  tests pass in-process fake providers / venues (`services/api/test/hl-fake.ts`, `derivatives-helpers.ts`,
  `alerts-helpers.ts`, `perp-live-world.ts`). `PlanDeps.quoteLeg` / `balance` script quotes and balances
  (plan-exec.ts:30-35).
- Pure state machines are tested without I/O (`plan-state.test.ts`, `xswap` reducers), which is the pattern to follow
  for any new saga.

### 7.4 Playwright e2e (`tests/e2e`)

- `scripts/dev-stack.sh`: needs `pnpm build` first (it runs `dist/signer.mjs` and `dist/api.mjs`); throwaway signer
  keystore in `/tmp/spw-dev`, database `spw_dev` (its public schema is **dropped**), `http://localhost:8650`,
  `SPW_BROADCAST=off` by default. Parallel stacks: `SPW_DEV_PORT`, `SPW_DEV_DB`, `SPW_DEV_DIR`; then
  `SPW_E2E_BASE=http://localhost:<port>` for the run. `scripts/dev-stop.sh` stops it.
- `tests/e2e/playwright.config.ts`: one worker, 90 s timeout, Pixel 7 viewport, base URL from `SPW_E2E_BASE`.
- Virtual passkey helper: `tests/helpers/passkey.ts`.
- Three kinds of specs: against the real local stack (`wallet.spec.ts`, `qa-real.spec.ts`, `qa-plan.spec.ts`,
  `qa-agent-fund.spec.ts`, `futures-live-real.spec.ts`), with small purpose-built servers (`alerts-server.mts`,
  `research-server.mts`, `live-real-server.mts`, `qa-real-server.mts`), and against the in-browser derivatives mock
  (`?mock=1`: `futures*.spec.ts`, `perp-agent-live.spec.ts`).
- Visual baselines: `v9-visual.spec.ts`, `v10-visual.spec.ts` with committed snapshots; screenshot generators
  `v10-shots-*.mts`; `v10-reqcount.mts` (request count), `v9-perf.mts`.
- Because of B2, a real-stack e2e that sends on a network leaves that network blocked for the rest of the run; specs
  work around it by using a fresh stack.

### 7.5 Fork, simulation and smoke scripts (`scripts/`, run by hand, never in `pnpm test`)

- `fork-*.mts` (anvil fork): `fork-swap-kyber`, `fork-swap-api`, `fork-swap-net`, `fork-cctp`, `fork-plan`,
  `fork-agent`, `fork-mandate`, `fork-gmx`, `fork-hl-deposit`. They use `SPW_RPC_OVERRIDE` / `SPW_IRIS_OVERRIDE`
  (loud warning at start-up, bridge.ts:28-29; `services/api/src/rpc-override.ts`).
- `sim-*.mts` (mainnet simulation, nothing sent): `sim-jupiter`, `sim-solana-cctp`, `sim-thorchain`,
  `sim-deriv-router`, `sim-perp-agent*`, `sim-research-job`.
- `smoke-*.mts` (live, read-only): one per chain family and per swap provider.
- `hl-*-testnet.mts`: Hyperliquid testnet.
- `scripts/preflight.sh`, `scripts/backup.sh`, `scripts/signer-relay.mjs`: operations.

### 7.6 Conventions a new V11 module must follow

1. Pure logic (state machine, pricing, ranking, validation) in `packages/*` or a `*-state.ts` file, with a no-I/O test.
2. Any external HTTP through an injected client; tests replay recorded real responses; a `smoke-*.mts` script for the
   live check; a dossier under `docs/`.
3. Database tests use `createTestDb('<unique_label>')` before importing `src/`; never a fixed database name.
4. New API routes: zod `strictObject` bodies, `UserError(code, message, status)`, an `Idempotency-Key` on anything that
   creates a proposal, and registration in `buildServer` with an injectable dependency for tests.
5. New UI: primitives of `ui.tsx`, keys in one prefixed block of `i18n.ts` (both languages, plain data), a lazy chunk in
   `App.tsx`, a Playwright spec, and — if the screen is shown in the v10 visual baseline — an updated snapshot.
6. Anything that changes what the signer accepts: verifier in `packages/core`, signer tests for each refusal, a fork
   script as proof, pins with a `reviewed` note.
7. `pnpm typecheck` and `pnpm test` green before merge; the 30 s per-test and 180 s per-hook limits are the ceiling.
