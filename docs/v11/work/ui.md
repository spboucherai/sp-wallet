# V11 — interface pass ("Nouvelle interface V11")

Branch `v11-ui`, from the local `v11` at `035b966`; `v11` as it stood on 2026-11-16 (`58eb941`, live market making)
is merged into it. Dates: 2026-11-15/16. Design note: `docs/v11/UI-ARCHITECTURE.md`.
Everything below was run on this branch, on a local stack (`tests/e2e/ui-stack.sh`: real API, real isolated signer,
throwaway keystore and database, broadcast off). No production access, no real order, no real transaction: paper
accounts only; market data and swap quotes are read from the providers' public endpoints.

The V10 design is kept: components of `ui.tsx` only, no new library, no new colour token.

## 1. Navigation and shell

**Initial state.** Phone tab bar Home · Swap · Send · Activity · Settings. Markets, Private markets, Spot and Futures
were four entries of one switch that wrapped on a phone. Risk only from Settings and Monitor; Developer only from
Settings. Nothing on screen showed the kill switch. Desktop pages other than the terminal and Markets: one 672 px
column.

**Change.** `App.tsx`, new `nav.ts`, new `shell-more.tsx`, `Settings.tsx`, `Markets.tsx` (its own
Explorer / Compare control removed), `styles.css` (one inset).
- Five areas on the tab bar and in the sidebar: Home · Markets · Trade · Agents · Activity. Sub-views under the
  header: Markets = Explorer · Compare · Private markets; Trade = Spot · Futures. Trade reopens on the sub-view used
  last.
- Risk indicator in the phone header and in the sidebar, on every screen (kill switch, read-only, live limits not
  set, ok, unknown), from the new `GET /api/v1/dashboard/status`. A tap opens Risk.
- Header menu on a phone / bottom of the sidebar on a desktop: Receive, Send, Risk, Alerts, Settings, Security,
  Developer / API, System status, Research, Lock.
- New paths `/trade`, `/dashboard`, `/compare`, `/spot`, `/perps`, `/api`, `/system`; `/risk?mandate=<id>`. Every
  previous path still opens its screen.
- Desktop widths: Home 1024 px, Activity / Agents / Research / System status / Private markets / Risk / Developer /
  Alerts 896 px; forms stay 672 px.
- Skip link; `<main id="main">`.
- Home lost its four shortcut cards (the dashboard panels and the tab bar cover them).

**Tests.** `apps/web/test/v11-ui.test.ts` (navigation: 4 tests); `services/api/test/dashboard-summary.test.ts`
(status route: 3 tests); `tests/e2e/v11-shell.spec.ts`.

**Limitations.** Send is no longer one tap from every screen on a phone (Home hero or menu). The lock button moved
into the menu on a phone. The indicator shows "Limites" on every wallet whose live limits are not set, which is the
default state.

## 2. Dashboard

**Initial state.** Home showed the wallet only; capital, P&L, exposure and health were on Monitor.

**Change.** `screens/Dashboard.tsx` (lazy chunk, mounted by Home under the wallet), `dashboard.ts`,
`services/api/src/dashboard/summary.ts` (`GET /api/v1/dashboard/summary`). The route composes the risk service
(three books: paper, live, live testnet — exposure, accounts, positions, P&L), the agents table, monitor `pnl()`,
monitor connectors and the audit-chain status. Each section is `{ ok, data, asOf }` or `{ ok: false, error }`; one
failing source fails only its section (8 s timeout per section). Panels: accounts, positions, P&L, risk, agents,
system, price freshness. One block per book, each with its mode tag; no figure spans two modes. Position marks tick
through `LiveCell`.

**Tests.** `dashboard-summary.test.ts` (5), `apps/web/test/v11-dashboard.test.ts` (13), `tests/e2e/v11-dashboard.spec.ts`.

**Limitations (no existing service computes these; shown as unavailable with the reason, not invented).**
- Agents' P&L of the day: research mode has none; a mode without an equity snapshot has none. The figure is the
  monitor's equity difference, deposits and withdrawals included, summed per mode only. No realized / unrealized
  split for agents.
- "Unrealized today" and "since inception" are one figure in the risk service; the screen shows one.
- Exposure covers the derivatives books. Spot wallet exposure is not in the risk service.

## 3. Trade

**Initial state.** The Futures terminal had its own picker (venue instruments, no mention of what is tradable), an
account blotter in the engine's own states, a preview from the engine only, no command line. The unified orders
were visible only through the API.

**Change.** `screens/Futures.tsx` (shell), new `screens/TradeUnified.tsx`, `trade.ts`,
`derivatives/orderChecks.tsx`; one line each in `derivatives/OrderPanel.tsx` and `derivatives/LiveApproval.tsx`
(a slot — their logic is untouched); `derivatives/Market.tsx` (picker rows); `Markets.tsx` exports its read-only
sheet.
- **Picker fed by the markets hub** (`/markets-hub`, all perpetuals): a market the wallet cannot trade live is
  labelled with the reason ("Réel indisponible · simulation seulement / lecture seule"); one that not even a paper
  account can trade opens the read-only market sheet; an eye button opens that sheet for any labelled row. If the hub
  does not answer, the picker says so and lists the venues' instruments as before.
- **Chart, book, trades**: unchanged — the terminal's store already reads the quote engine (`derivatives/store.ts`).
- **Checks before confirmation**: the confirmation sheet of the paper panel, and the approval sheet of a venue
  account before the passkey prompt, show the answer of `POST /trading/orders/preview` for that exact order: risk
  engine decision, mandate (not applicable to the owner's session, said so), who approves, every refusal with its
  stage and code, and all the checks (31 on a paper order) with observed value and limit. One request per sheet: a
  preview is recorded by the engine, so it is never polled.
- **Unified blotter** ("Tous les comptes"): positions, open orders, history from `/trading/positions` and
  `/trading/orders`, in two lists (Réel, Simulation), never added. The twelve states in words; `UNKNOWN` reads
  "En vérification auprès de la plateforme", in the information tone, with a sentence saying it is neither done nor
  failed. Cancel, close (two taps), attached stop / take-profit, and an order's transitions on demand.
- **Command line** (`POST /trading/commands`): dry run first; a parse error, an unresolvable command and a refusal
  are worded from their codes; an ambiguous command shows its questions — an answer goes into the line (`ON <venue>`,
  `x<leverage>`, `FOR <quote>`) or into the owner's command defaults (`PUT /developer/command-defaults`); the run
  reuses one idempotency key and is refused if the line changed since its preview.

**Tests.** `v11-ui.test.ts` (Trade: 10 tests — the state list equals the API's, the check ids equal the engine's,
the parse and unresolvable codes equal the grammar's); `tests/e2e/v11-trade.spec.ts` (paper order through the UI,
command line).

**Limitations.**
- Live paths (venue account approval sheet with the checks, a live close or a live command) were not exercised in a
  browser: the local stack has no venue account. They are typed and share the code of the paper paths.
- The terminal shows two blotters: the selected account's (engine detail: liquidation estimate, funding, partial
  close) and the unified one. They were not merged, to leave the panels' logic alone.
- The engine's `detail` sentence of a failing check is English; it is shown under a "technical detail (English)"
  label.
- The picker reads up to 1 500 hub rows when it opens (three requests at most).
- Spot limit orders do not exist in the wallet; Trade → Spot is the swap screen.

## 4. Activity

**Initial state.** Transfers, swaps, bridges and deposits; two filters; no orders, agents, mandates, risk decisions
or key events; the CSV wrote the wallet rows only.

**Change.** `screens/Activity.tsx`, `activity.ts`, `services/api/src/dashboard/activity.ts`
(`GET /api/v1/dashboard/activity`, `GET /api/v1/dashboard/activity.csv`). One timeline from five sources: wallet
activity and plans (the existing routes, called in process with the caller's session), unified orders, risk denials,
and the audit chain (agent, mandate, risk, key, security events). Filters, applied by the server: kind, mode, venue
or network, principal, period. Cursor pagination. Each item carries a code and parameters, never a sentence. Paper
items carry a tag and can be filtered; the screen shows no total. Audit-chain status at the top. An order expands to
its transitions. CSV with the new kinds and a `mode` column.

**Tests.** `dashboard-activity.test.ts` (7), `v11-activity.test.ts` (13), `tests/e2e/v11-activity.spec.ts`.

**Limitations.**
- Each source is read for its 500 newest rows (plans: 50): the timeline goes back that far per source. The screen
  says so at the end of the list.
- Agent actions come from the audit chain; per-agent journal lines and signals are not in the timeline (no
  cross-agent read exists).
- A GMX order can appear twice: as its wallet transaction and as the unified order.
- The audit verdict is the monitor's cached full verification (10 minutes).
- The link from a plan item to its plan is a page load.
- The old `/export/activity.csv` is unchanged and still linked from Settings.

## 5. Audit leftovers in the web

| Point | Still true? | Change | Limitation |
|---|---|---|---|
| B3 remainder: server sentences printed raw | yes (AgentFund, PerpAgent, PerpAgentLive, Research, Monitor, agentPanel, `errText`) | `srvText()` (new `srvText.ts`): a code with a text wins; a sentence the server is known to write is translated (`reasonTexts.ts`); anything else is shown on a French screen as a marked quotation "Message du serveur (en anglais) : « … »". `errText` wraps the server detail the same way. English screens unchanged | translation is by known wording, not by code: no server file of the agents area was changed (another workstream's). Free-form venue texts stay English, marked |
| Private Markets server texts | yes | not-tradable codes translated (`v11LoPmNT_*`); English source sentences tagged "cité en anglais" with `lang="en"` | the venue's contract terms stay in English, as citations |
| Unused `rk*` keys | yes | 7 removed: `rkCollateral`, `rkMissingTitle`, `rkMissingBody`, `rkLimitsJson`, `rkHash`, `rkSheetPasskey`, `rkNewJson` | — |
| GMX rows as "send" | partly: the CSV was already fixed; the Asset page and Home's pending list were not | one label by kind in `Asset.tsx`; Home's pending row says "Ordre GMX" | — |
| Dev mocks | yes (503 outside `/derivatives`) | new `derivatives/mockV11.ts`: `/markets-hub` from the mock's perpetuals; shaped empty answers for the other V11 reads; `/dashboard/*` sections as `not_simulated`; the quote socket closes cleanly | `/markets-hub/compare` and unified orders are not simulated |
| `/risk?mandate=<id>` | yes | `Risk.tsx`: 12 insertions, 6 deletions — scroll, focus, ring, folds open; unknown id → notice; the approval sheet is never opened by the link | — |

Tests: `apps/web/test/v11-leftovers.test.ts` (15), `tests/e2e/v11-leftovers.spec.ts` (2). Expectations changed for
the new `errText` wording: `qa-polish.test.ts` (2), `hardening-d.test.ts` (2), `perf-v10.test.ts` (1).

## 6. Quality bar

- **Accessibility.** Every state is icon + word. The risk indicator's accessible name is a sentence. Tab bar and
  sidebar are `<nav>` with a label; the lit entry has `aria-current`. Sub-view rows are tab lists. Skip link. The
  command line's result is an `aria-live` region. English server text carries `lang="en"`. No new colour pair: the
  indicator uses the pairs of `Notice` and `Btn` already measured in `docs/v9/DESIGN.md`. No new animation; the
  live-cell flash and the sheet already honour `prefers-reduced-motion`.
- **Bilingual completeness.** `v11-ui.test.ts`: the `v11` block (contiguous, two non-empty languages, same
  placeholders, every key used, every used key present) and, for the whole app, every literal key passed to `t(…)`
  exists. The sub-blocks have their own tests (`v11-dashboard`, `v11-activity`, `v11-leftovers`).
- **Re-renders.** The Markets list, the unified blotter and the dashboard contain no quote hook: figures tick
  inside `LiveCell` (checked by `v11-ui.test.ts`). In the browser, `v11-sections.spec.ts` (desktop, French) records
  every DOM mutation under the Markets list during 8 s of real ticks.
- **States.** Every new panel has loading, empty and error / unavailable states.
- **Amounts.** New inputs are command text (the grammar's own number rule) and question answers (integers); amounts
  are displayed through `fmt` / `usd` / `trimAmt`.

## 7. Files outside the owned set

`apps/web/src/screens/Risk.tsx` (mandate deep link, one localized change), `screens/Markets.tsx` (control removed,
sheet exported), `screens/PrivateMarkets.tsx`, `privateMarkets.ts`, `screens/AgentFund.tsx`, `PerpAgent.tsx`,
`PerpAgentLive.tsx` (1 line), `Research.tsx`, `agentPanel.tsx` (4 one-line edits and an import, none in the
market-making parts), `screens/Asset.tsx` (1 line), `reasonTexts.ts`, `sv.ts`, `derivatives/OrderPanel.tsx` and
`LiveApproval.tsx` (one slot line each), `derivatives/Market.tsx` (picker), `derivatives/mock.ts` (7 lines),
`services/api/src/server.ts` (2 lines: the import and the registration), `styles.css` (1 value), `quotes.ts` (the socket
stops when the session ends: 7 lines), `screens/Developer.tsx` (1 line: the server's status sentence is marked),
`apps/web/test/{qa-polish,hardening-d,perf-v10}.test.ts`, and the existing e2e specs adapted to the navigation
(`wallet`, `developer`, `alerts`, `futures`, `futures-live`, `futures-gmx`, `v9-visual`, `v10-visual`).
Nothing under `services/api/src/{mm,agents,mandates,trading-api}`, `packages/trading-sdk`, `sdk/python`; no `mm*` key.

## 8. Browser validation

Stack: `tests/e2e/ui-stack.sh ui 8840` — builds, copies `dist/` to `/tmp/spw-ui-ui/dist`, starts the real signer and
the real API from the copy (the signer is real: setup, unlock, the kill-switch release and the API key creation are
signed by a Chromium virtual authenticator and verified by the production code). Matrix: phone 390 × 844 and desktop
1280 × 900, French and English, light theme; the Dashboard also in dark on the phone. All v11 specs share one stack:
the first test does the owner setup, the others unlock with the same throwaway passkey (`tests/e2e/v11-helpers.ts`).
The API limits a client to 240 requests a minute, static files included; the specs wait for room, which is why the
52 tests take 27 minutes.

### New specs (final run, on the merged tree: 52 passed, 0 failed, 26.9 min)

The same 52 passed on the tree before the merge. The first shared-stack run had 11 failures, all in the specs and none
in the screens: assertions that assumed one paper account on the stack (5 dashboard, 2 trade), and a count read before
the agent templates had loaded (4).

| Spec | Section | Cells | Result |
|---|---|---|---|
| `v11-shell.spec.ts` | five areas, sub-views, risk indicator, menu, old paths | 4 | 4 / 4 pass |
| `v11-shell.spec.ts` | no horizontal overflow at 320 / 360 / 430 px on 12 screens, header on one row | phone FR, phone EN | 2 / 2 pass |
| `v11-dashboard.spec.ts` | paper position under its own mode and not under live; risk, system, freshness | 4 + phone FR dark | 5 / 5 pass |
| `v11-dashboard.spec.ts` | 320 px; kill switch engaged shown, released with the passkey | 2 | 2 / 2 pass |
| `v11-sections.spec.ts` | Markets explorer + Compare | 4 | 4 / 4 pass |
| `v11-sections.spec.ts` | Markets with live quotes: 8 s of real ticks change only their cells | desktop FR | pass |
| `v11-sections.spec.ts` | Private markets (display only, no order form) | 4 | 4 / 4 pass |
| `v11-sections.spec.ts` | Swap quote view (real providers) | 4 | 4 / 4 pass |
| `v11-sections.spec.ts` | Agents: list and templates | 4 | 4 / 4 pass |
| `v11-sections.spec.ts` | Risk: kill switch engaged, shown by the indicator on another screen, released with the passkey | 4 | 4 / 4 pass |
| `v11-sections.spec.ts` | Developer: API key created with the passkey, secret shown once | 4 | 4 / 4 pass |
| `v11-trade.spec.ts` | paper order through the UI: hub picker → read-only sheet → preview → confirmation with the 31 checks → place → filled → unified blotter (paper list only) → transitions → close | 4 | 4 / 4 pass |
| `v11-trade.spec.ts` | command line: parse error, questions, dry run, run on paper, SHOW, CLOSE | 4 | 4 / 4 pass |
| `v11-activity.spec.ts` | order row labelled paper, filters, empty state, transitions, audit tag, CSV link | 4 | 4 / 4 pass |
| `v11-leftovers.spec.ts` | `/risk?mandate=<id>` on a real stack; `?mock=1` walk with no console error | 2 | 2 / 2 pass |

### Existing specs

| Spec | How it was run | Result |
|---|---|---|
| `wallet.spec.ts` | fresh stack | pass (2) — adapted: navigation; Activity of a new wallet is no longer empty |
| `developer.spec.ts` | fresh stack | pass — adapted: navigation; two assertions that still said "non branchée" for an execution wired since the execution work |
| `risk.spec.ts` | fresh stack | pass |
| `agents-bind.spec.ts` | fresh stack | pass (4.1 min) |
| `mm.spec.ts` (arrived with the merge of `v11`) | fresh stack | pass (35 s) — it navigates by URL |
| `futures.spec.ts`, `futures-collateral`, `futures-gmx`, `futures-live`, `futures-router`, `perp-agent-live` (development mock) | own vite dev server | 66 / 66 pass on the merged tree (7.4 min). Before the fixes below: 63 — the two `compare view` tests, and `futures-collateral` phone once (passed alone) |
| `alerts.spec.ts` | own server | pass (2) |
| `research.spec.ts` | own server | pass (2) alone. Run next to another Playwright run it fails on a 5 s expectation (twice observed): load-sensitive, not a regression |
| `v9-visual.spec.ts`, `v10-visual.spec.ts` | built bundle, recorded answers | pass (11) with the regenerated baselines |
| `qa-real`, `qa-plan`, `qa-agent-fund` | need `QA_REAL=1` and a stack on anvil forks of Base and Arbitrum | **not run** in this pass (time); they navigate by URL, not through the tab bar |
| `futures-live-real.spec.ts` | needs `LIVE_REAL=1` and the Hyperliquid testnet | **not run** (testnet account) |

What the new navigation broke in existing specs, and the fix: navigation by tab-bar label (`wallet`, `developer`,
`alerts`, `futures*`, `v9-visual`, `v10-visual`) → `navTo()` of `v11-helpers.ts`; the tab-bar label lists → the five
areas. Not caused by the navigation but found on the way: `futures.spec.ts` "compare view" asserted that no text
matches `/best|recommand/` while the comparator's own notice says "ni une cotation ni une recommandation" (the
assertion was failing on `v11` before this pass) — narrowed to affirmative wordings; and its `ETH` selector matched
two controls once the mock served the hub's underlyings.

Found by the browser runs and fixed: the live-quote socket reconnected once after a lock and logged a 401 in the
console (`quotes.ts` `sessionEnded()`, dispatched by the shell); the skip link measured 1 × 1 px for the 44 px probe.

### Visual baselines

28 of the 29 baselines of `v9-visual` and `v10-visual` were regenerated: every picture but the lock screen contains
the header and the tab bar. Before / after, phone light French, one per section: `docs/v11/screens/before/` and
`docs/v11/screens/after/` (WebP, 1.5 MB in all; taken by `tests/e2e/v11-shots.mts` on a stack built from the branch
point `035b966` and on this branch, each with one paper account and one open paper position).

## 9. Chunk sizes

`node scripts/build.mjs && (cd apps/web && node_modules/.bin/vite build)`: exit 0.
"Before" is the branch point `035b966` built with the same command; "after" is this branch after the merge of `v11`
(which adds `mmPanel` and the `mm` texts).

| Chunk | Before | After | Note |
|---|---|---|---|
| `index` (first chunk) | 262.35 kB | 262.32 kB (81.1 kB gzip) | not regressed |
| `shell-more` | — | 4.18 kB | risk indicator, sidebar, menu; requested when the shell mounts |
| `nav` | — | 0.16 kB | |
| `Dashboard` | — | 15.08 kB | requested when Home has drawn the wallet |
| `Activity` | 6.13 kB | 23.78 kB | the timeline |
| `Futures` | 274.32 kB | 278.66 kB | picker rows, slot, shell wiring |
| `TradeUnified` | — | 30.70 kB | unified blotter, checks, command line; requested when the terminal mounts |
| `Markets` | 14.51 kB | 14.31 kB | |
| `PrivateMarkets` | 26.38 kB | 27.28 kB | |
| `Risk` | 39.40 kB | 40.55 kB | includes the quoting section of `v11` |
| `Developer` | 32.30 kB | 32.35 kB | |
| `Monitor` | 21.22 kB | 21.41 kB | |
| `Agents` | 157.25 kB | 158.10 kB | |
| `reasonTexts` | 25.19 kB | 6.48 kB + `alert-catalog` 23.70 kB | split by the bundler; the known-sentence table grew by 28 entries |
| i18n table, French | 284.90 kB | 319.51 kB | one language is loaded; the `v11` block of this pass and the `mm` block of `v11` |
| i18n table, English | 247.32 kB | 277.89 kB | |
| `Swap`, `Agents`, `Send`, `Receive`, `Alerts`, `Security`, `plan` | | unchanged within 0.1 kB | |

`apps/web/scripts/chunk-report.mts` prints the modules of a chunk (it is how the first chunk was brought back from
266.7 kB: the shell's additions weighed 4.3 kB; a value import of `App` from a lazy chunk had also to be avoided).

## 10. Verification

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | ok |
| `pnpm typecheck` | exit 0 (after the merge of `v11`) |
| web unit tests (`npx vitest run apps/web/test`) | 21 files, 388 tests, all pass |
| `pnpm test`, once, quiet machine, merged tree | 194 files, 4 494 tests: 4 492 pass. The 2 failures — `agent-bind.test.ts` "Momentum template…" (30 s timeout) and `research-runner/test/runner.test.ts` "cancel of a SILENT agent" — pass when their files are run alone (25 / 25). Neither file is touched by this pass |
| `pnpm test`, first run, next to a Playwright run | 3 failures, all in the known load-sensitive list (`trading-contract`, `trading-sdk integration`, `lab-identity` latency); 47 / 47 alone |
| new tests of this pass | API: `dashboard-summary` 8, `dashboard-activity` 7. Web: `v11-ui` 18, `v11-dashboard` 13, `v11-activity` 13, `v11-leftovers` 15 |
| `node scripts/build.mjs && vite build` | exit 0 |

`research/.venv` was created for the laboratory tests (`uv sync --frozen`); it is not committed.

## 11. Not done

- QA specs on anvil forks and the Hyperliquid-testnet spec were not run (see §8).
- Live paths of Trade were not exercised in a browser (no venue account on the local stack).
- The two blotters of the terminal were not merged.
- Agent journal lines and signals are not in Activity; a GMX order can appear twice there.
- Server sentences of the agents area are translated by known wording, not by code (the server files belong to
  another workstream).
- The dashboard has no chart of P&L over time (no series route exists; Monitor's figures are today / 7 d / 30 d).
- Spot limit orders: not in the wallet.
- The desktop was checked at 1280 × 900 by the specs; wider layouts were not reviewed picture by picture.
- Contrast was not re-measured with a tool: no colour pair is new.
