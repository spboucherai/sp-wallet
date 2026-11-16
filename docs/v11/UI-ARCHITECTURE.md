# SP Wallet V11 — information architecture of the interface

Scope: `apps/web/src/App.tsx` (shell), `nav.ts`, `shell-more.tsx`, and where each of the nine V11 sections lives.
The V10 design system is unchanged (`docs/v9/DESIGN.md`, `docs/v10/SHOWCASE.md`): same components of `ui.tsx`, same
spacing, same tone, no new library. This note says where things are and why; `docs/v11/work/ui.md` says what was
changed and how it was checked.

## 1. The problem

Before this pass the nine sections existed but did not form one product:

- the phone tab bar held Home · Swap · Send · Activity · Settings; Markets, Private markets and Futures were four
  entries of a switch that wrapped on a phone;
- Risk was reachable from Settings and Monitor only; Developer from Settings; Monitor and Research two taps deep;
- nothing on screen said whether the kill switch was engaged unless the owner opened Risk;
- on a desktop, every page except the terminal and Markets was one 672 px column.

## 2. Five areas

The same five entries, in the same order, on the phone's tab bar and in the desktop sidebar
(`nav.ts` `AREAS`; one list, so the two cannot drift).

| Area | Tab label (FR / EN) | Sub-views (row under the header) | Screens that light the area |
|---|---|---|---|
| Home | Accueil / Home | — | `/` (Dashboard), `/assets`, `/asset/…`, `/receive`, `/send` |
| Markets | Marchés / Markets | Explorer · Comparer · Marchés privés | `/markets`, `/markets?v=compare`, `/private-markets[/…]` |
| Trade | Négocier / Trade | Au comptant · Contrats à terme | `/swap`, `/futures[/…]`, `/plan/…` |
| Agents | Agents | — | `/agents`, `/agents/<id>`, `/research` |
| Activity | Activité / Activity | — | `/activity` |

An area is not a screen: it is the tab that stays lit. `areaOf(tab)` (App.tsx) is the only place that says which
screen belongs to which area.

Everything else is **not** an area and is opened from the header menu on a phone (☰, a `Sheet`) and from the bottom
of the sidebar on a desktop: Receive, Send, Risk, Alerts, Settings, Security, Developer / API, System status,
Research, Lock. Settings keeps the same list, so there are two ways in and no dead end.

Decisions:

- **Send left the tab bar.** It is an action of the wallet, not a section; it stays one tap from Home (hero buttons)
  and is in the menu. The centre "FAB" is gone: five equal entries.
- **Settings left the tab bar** for the header menu, with Security, Developer and System status.
- **Trade remembers its last sub-view** (`localStorage['spw-trade-view']`). Default: spot. The terminal is the largest
  chunk (279 kB) and is still fetched only when it is opened.
- **Compare is a sub-view of Markets**, not a screen: the segmented control that Markets drew itself was removed, the
  shell draws the row. Private markets is the third sub-view, with its own URL.
- **A tap on the lit tab** goes back to the area's first screen, or scrolls to the top when already there.

## 3. Risk is always visible

`RiskIndicator` (shell-more.tsx) is in the phone header and in the sidebar on every screen. It reads
`GET /api/v1/dashboard/status` every 20 s — two settings reads of the risk service, no venue, no exposure.

| State (worst first) | Word (FR / EN) | Icon | Meaning |
|---|---|---|---|
| `kill` | Arrêt / Halted | stop, danger fill | global kill switch on: no new risk |
| `readonly` | Lecture seule / Read-only | lock, warn | only cancels go through |
| `limits` | Limites / Limits | warning | live limits not set: live orders refused |
| `ok` | Risque / Risk | check | none of the above |
| `unknown` | Risque / Risk | clock | the switches could not be read |

Icon and word, never a colour alone; the accessible name is a full sentence. It never says "ok" by default: an
unreadable state is `unknown`. A tap opens Risk. `/risk?mandate=<id>` scrolls to that mandate and opens it.

## 4. Routes

No router library, as before: `routeOf()` / `pathOf()` in App.tsx. Every path of V10 and of the V11 work so far still
opens its screen. New:

| Path | Opens |
|---|---|
| `/trade` | the last trade sub-view (`/swap` or `/futures`) |
| `/dashboard` | `/` |
| `/compare` | `/markets?v=compare` |
| `/spot`, `/perps` | `/swap`, `/futures` |
| `/api`, `/system` | `/developer`, `/monitor` |
| `/risk?mandate=<id>` | Risk, on that mandate |

An alias replaces the address (`history.replaceState`): it does not add a history entry.

## 5. Where the nine sections are

| Section | Where | What this pass did |
|---|---|---|
| Dashboard | Home (`screens/Home.tsx` + `screens/Dashboard.tsx`) | consolidated panels under the wallet; `GET /dashboard/summary` |
| Markets | `/markets` | sub-view row; rows open Trade or the read-only sheet |
| Compare | `/markets?v=compare` | sub-view of Markets |
| Private markets | `/private-markets` | sub-view of Markets; standard reasons translated |
| Trade | `/swap`, `/futures` | terminal shell: hub-fed picker, checks before confirmation, unified orders, command line |
| Swap | `/swap` | sub-view of Trade; unchanged otherwise |
| Agents | `/agents` | an area of its own; wider on a desktop |
| Risk | `/risk` + the indicator | always-visible state; mandate deep link |
| Activity | `/activity` | one timeline of every operation; `GET /dashboard/activity` |
| Developer / API | `/developer` | header menu / sidebar |

## 6. Layout

- **Phone** (reference 390 × 844; checked from 320 to 430): header = brand · risk indicator · alerts · menu, one row.
  Under 360 px the brand keeps its mark and drops its name. The sub-view row never wraps (it scrolls sideways if a
  translation is long; at 320 px the three Markets labels fit at 13 px).
- **Desktop** (≥ 1024 px): 256 px sidebar. Page width by kind of page (`width` in App.tsx):
  forms (send, receive, swap, settings, security) stay a 672 px column; Home is 1024 px (the wallet in two columns,
  the dashboard panels in a two-column grid); Activity, Agents, Research, System status, Private markets, Risk,
  Developer and Alerts are 896 px; Markets and the terminal use the whole width, as before.
- A "skip to content" link is the first focusable element; `<main>` is its target.

## 7. Chunks

The first chunk holds what the first screen needs, as in V10 (`perf-v10.test.ts` pins Home, Assets, Asset, Gate).
What this pass added to the shell that the first paint does not need — the risk indicator, the desktop sidebar, the
header menu — is one chunk, `shell-more` (4.2 kB), requested when the shell mounts. The dashboard panels are a chunk
(`Dashboard`, 15 kB) requested when Home has drawn the wallet; the unified trade components are a chunk (`TradeUnified`,
31 kB) requested when the terminal mounts. No screen is preloaded that was not preloaded before
(the idle queue is unchanged: Markets, Futures, Risk, Developer, Monitor, Research, Private markets are fetched when
opened). `nav.ts` exists so that App.tsx and shell-more.tsx share the area list without importing each other: a value
import of App from a lazy chunk moves the whole shell out of the first chunk.

## 8. Rules for the next screen

1. A new screen belongs to one of the five areas (add it to `areaOf`) or to the menu (`MORE` in shell-more.tsx).
   Do not add a sixth tab.
2. A sub-view is a row entry of its area (`SUB` in App.tsx) with its own URL.
3. Live and paper are never added together; a row says its mode with the mode tag.
4. A server sentence is never printed as if it were the interface's: a code and a text, or a marked quotation.
5. Texts go in one prefixed block of `i18n.ts`; `apps/web/test/v11-ui.test.ts` checks the `v11` block and that every
   literal key passed to `t(…)` exists.
