# Trading — production readiness (V11)

An assessment per capability, written 2026-11-15 for branch `v11` (`fa48015`) from the work notes, the module documents
and the code, and **revised 2026-11-17 for branch `v11-final`** (every workstream merged, including `v11-mm-live` and
`v11-ui`) with the results of the final validation (`docs/v11/work/final-validation.md`). V11 is not deployed.

Two different questions are answered for each capability and must not be confused:

- **Deploy** — can the code go to production with its lock off (or without a lock, when it executes nothing)?
- **Enable** — can the lock be turned on, or the capability be used with real funds?

Statuses: **Ready** (deploy with locks off) · **Owner steps** (ready to enable once the listed owner steps are done) ·
**Not ready** (something other than an owner step is missing — said in the row).

The limit of every "Ready" on this page: **no order of this code was ever accepted by a venue on a funded account,
testnet or mainnet** (`docs/V11-AUDIT.md` §10; restated by every execution work note). "Ready to enable" therefore never
means "verified against the venue"; it means everything that can be established without a venue has been.

Details behind each row: `V11-REMAINING-LIMITATIONS.md` (numbers in parentheses), `V11-TEST-RESULTS.md`,
`TRADING-TEST-RESULTS.md`, `V11-DEPLOYMENT.md`.

---

## 1. Jurisdiction constraints (facts from `docs/v4/venues/jurisdiction.md`; not legal advice)

| Venue | Constraint | In the wallet |
|---|---|---|
| **edgeX** | Terms of Use exclude Canada ("BLOCKED PERSONS"), no exceptions, VPN circumvention prohibited; §12.1 covers perpetual contracts "using the Services" | **market data only.** No account, no trading, never simulated; no acknowledgement text exists, so the signer can never be handed an edgeX approval |
| **dYdX v4** | terms exclude Canada; the indexer answers account endpoints `GEOBLOCKED` from the owner's network | **market data only** |
| **Hyperliquid** | terms name "United States of America or Ontario, Canada" for the website interface; Québec is not named; no API terms or documented API geo-blocking found. Not on the AMF register of crypto trading platforms (checked 2026-11-10). §1.9 makes the user responsible for the lawfulness of leveraged trading where he lives. Not verified: the AMF warning list; whether the interface blocks a Québec IP | read and paper now; **live trading is the owner's decision**, recorded by an acknowledgement whose hash is part of the authorization (and of a quoting mandate) |
| **GMX v2** | Canada not named; U.S. persons and sanctioned territories excluded; "Applicable Laws" clause puts compliance on the user. Not on the AMF register | read; trading off until two server settings are on and the owner approves a venue policy with the acknowledgement |
| **Hyperliquid builder dexes** (trade.xyz, EntropyIO, Paragon — the pre-IPO contracts) | trade.xyz names Canada; EntropyIO restricts Ontario; Paragon's list does not name Canada; whether routing a Québec resident's order to them is lawful is not answered by the research | **display only**: every row `tradable: false` (`builder_dex_read_only`) |

The software works around no restriction (no VPN, no proxy, no alternative path to a blocked service).

---

## 2. Assessment per capability

| Capability | Deploy | Enable | Lock | Prerequisites | Owner decisions | Residual risks |
|---|---|---|---|---|---|---|
| **Trading API — reads** (markets, compare, private markets, portfolio, positions, orders, agents; 41 operations in all) | **Ready** | **Owner steps**: create a key with the passkey, scopes and restrictions | none (scopes) | the pepper file in the secrets backup | which scopes; source-address list; expiry | a prepare-only key learns the equity and free collateral of the account it names (3.7); limiters are per process (6.1); webhook URL not checked against private ranges (6.3) |
| **Paper trading by key** | **Ready** | **Owner steps**: a paper trading mandate bound to the key | none (paper is never behind a lock) | — | the paper limits | paper fills are a model against the public book; several principals may share a paper account |
| **Live execution by key under a mandate** | **Ready** (lock off by default: 403 `execution_disabled`) | **Not ready to enable**: (a) the path was never run against a venue — a testnet session by the owner is the missing evidence (2.1); (b) the items "for human review" of `docs/V11-SECURITY-REVIEW.md` are unread (the API-only fields of a mandate, the seed rule, the provenance ledger, GMX equity, shared reads); (c) provenance has no tie-break for fills on one timestamp (2.9). After (a)–(c): **Owner steps** | `SPW_TRADING_API_EXECUTION` + `SPW_DERIV_LIVE_MAINNET` + `SPW_DERIV_MANDATE_MAINNET` | every live limit stored by the owner (keys never see the seed); a live trading mandate approved with two passkey prompts; one Hyperliquid account, BTC / ETH / SOL | accept that order type, per-minute rate, daily loss, fee cap and stop conditions are API-only (3.2) | a stolen key loses money inside the mandate down to the floor; a compromised API is bound by the signer-enforced subset only; a rotated key is unbound (6.4) |
| **Owner's manual live orders** (Futures screen; existing V10 capability, changed by V11) | **Ready** — with a behaviour change: new risk is refused until six limits are set | **Owner steps**: read the seed, set the six limits | as currently set (`SPW_DERIV_LIVE_MAINNET`) | `V11-DEPLOYMENT.md` §8 | the six limits; whether the minimum-over-accounts seed is what he wants (3.5) | manual mode has no signer-side position, exposure or loss limit (3.9); resting orders survive a revoked or expired authorization (2.13) |
| **Live GMX orders through the trading API** (owner only, passkey per order) | **Ready** | **Not ready to enable** beyond what V10 already allowed: unified path tested on a scripted chain only, command path untested, new equity definition unreviewed (2.2–2.4) | `SPW_DERIV_GMX_LIVE` (+ `SPW_DERIV_LIVE_MAINNET`) | a fork run of the unified path; `gmx` and its instruments added to the allow-lists by the owner | the GMX loss limits (no web control: API only) | keeper execution at a later oracle price; realised PnL under-counts (3.10) |
| **Perp agents — research and paper** (momentum, mean reversion, stat-arb templates; bar engine) | **Ready** | **Owner steps**: none beyond starting them (a key with `agents:manage` may too) | none | the laboratory virtualenv on the API node (`uv sync --frozen`) | — | a paper mandate lasts 90 days (3.13) |
| **Perp agents — live** | **Ready** (a pre-V11.2 live agent becomes reduce-only) | **Not ready**: (a) **no strategy shows an out-of-sample edge** (5.1) — this is evidence, not a missing step; (b) never run against a venue; (c) enabling it requires `SPW_TRADING_API_EXECUTION=on`, which also opens key execution (5.7); (d) the mandate compiler allows 1× leverage only with the default limits (3.12) | the three locks above | a new trading mandate per agent (two prompts); every live limit stored | to run a strategy with a deflated Sharpe ≤ 0.10 for money, knowingly | loss inside the mandate; the kill switch and the API-only fields do not bind a compromised API |
| **Stream agents** (cross-exchange, funding arbitrage — paper and research; market making has its own two rows below since `v11-mm-live`) | **Ready** | paper only: **no live mode exists** for these two families | — | — | — | their paper orders are not unified orders (5.5); the second venue of two families is edgeX or dYdX: data only, never tradable (5.4); fill model optimistic (5.6) |
| **Spot agents** (vault + spot mandate at the signer; existing capability, changed by V11) | **Ready** — changes: a stopped or paused agent's mandate is revoked; one mandate per vault; the kill switch refuses their buys at the database row | as in V10: **Owner steps** (a spot mandate per agent, passkey) | none in the API (the signer's mandate and `policy.json`) | — | the vault's balance is the exposure | **market loss inside a spot mandate is not bounded by the signer** (4.4); caps in base units at approval prices (4.5); backtests at default limits without latency or gas (5.2) |
| **Market making — paper** (family `market_making`; ONE engine for paper and live, `services/api/src/mm`) | **Ready** — with one day of evidence on the real feed (see the last cell) | paper only; no lock; the owner or a key with `agents:manage` starts it | — | — | — | *(revised 2026-11-17)* paper quotes are **not** orders any more (one session row, one row per fill; only the reduce-only unwinds are unified orders); the paper fill model sees the top of the book only and ignores queue position — figures are labelled SIMULATED; one instrument per session. **Until the final validation a paper session on the real feed stopped quoting after seven seconds** (its books came from a channel that speaks every 12 s; fixed in `42f44d1`, limitation 5b.12): the first 30 minutes of a paper session quoting on real data are the second soak of 2026-11-17 (`V11-TEST-RESULTS.md` §6.5) — @@MM_SOAK_SHORT@@ |
| **Market making — live** (quoting mandate, engine, dead man's switch) | **Ready to deploy with its four locks off** — *(revised 2026-11-17)* it is **integrated** (`v11-mm-live`): mandate lifecycle, runtime, locks, accounting, breakers, the in-app go-live checklist. The **signer** code it calls needs the human review of items 10–18 of `V11-DEPLOYMENT.md` §1 before any signer deployment, and the API changes of item 19 | **Not ready to enable**: (a) **nothing was ever run against the venue — the testnet step is implemented and was never run** (it is the owner's: six venue behaviours to verify, 4.10); (b) the reviews above are unread; (c) **the evidence is negative** (study and simulator) — this is evidence, not a missing step; (d) the approval, recovery, revocation and live session screens were never driven in a browser (they need a venue account and open locks); (e) **the session's market-data source was replaced on the last day** (5b.12): the live path on that source has the suite's tests and nothing else | mainnet: `SPW_DERIV_MM_MAINNET` + `SPW_DERIV_LIVE_MAINNET` + `SPW_DERIV_MANDATE_MAINNET` + `SPW_TRADING_API_EXECUTION` (**four**, the earlier text said three); testnet: `SPW_DERIV_MM_TESTNET` + `SPW_TRADING_API_EXECUTION` | the in-app checklist of `docs/V11-MARKET-MAKING.md` §13, in its order, refused by the server with `golive_incomplete` while a step is missing: a paper session ≥ 30 min, the negative evidence acknowledged, the jurisdiction acknowledgement, the testnet step, leverage set by hand, a quoting mandate ≤ 7 days with two passkey prompts and any directional mandate revoked first | written acceptance of the negative evidence and of tier-0 maker fees paid; capital, instrument, sizes, floor, `deadManSeconds`, hours; whether the signer may cache its leverage read | adverse selection; the signer's mid is spot (4.9); unmetered cancels; a rate budget measured on a venue double only (485 of 1 200 weight a minute, peak 878); **before a signer rollback every quoting mandate must be revoked** (demonstrated, `V11-DEPLOYMENT.md` §9.3); nothing verified on a funded account |
| **Swaps and bridges** (existing; V11 stabilisation: B1–B6, route card, execution status, idempotent preparation) | **Ready** — server side tested on scripted chains with restart tests. *(Revised 2026-11-17.)* The web changes have now been opened in a browser (Chromium): the Swap quote view on real provider quotes (`v11-sections.spec.ts`), and — on anvil forks, with a virtual passkey and broadcast off — the swap, bridge, plan and agent-funding flows of `qa-real`, `qa-plan`, `qa-agent-fund`; the fork proof scripts of V10 were re-run on this tree (`V11-TEST-RESULTS.md` §6). Not in a browser: `quote_moved` and the execution timeline of a real broadcast | as in V10 (passkey per operation; signer `policy.json`) | `SPW_BROADCAST` as currently set | — (the browser pass was made on 2026-11-17, Chromium only) | third RPC endpoints (7.1); 0x / 1inch keys (7.3) | one degraded RPC endpoint still blocks a network; single price source; execution evidence on most networks is forks and simulation (7.4) |
| **Quote stream** (websocket, live cells) | **Ready** — polling and SSE remain as fallback | no lock; on at deployment | — | outbound `wss` to Coinbase from the API node | `stream_close_delay` in Caddy or not | **Safari / iOS never run** (8.1); load measured on a laptop only (8.7); in-process hub |
| **Private markets** (display and five-quantity valuation) | **Ready** | display only; nothing to enable | — | — | — | **the Anthropic entries expire at 2026-11-18T00:00Z**: from then, "definition under review" and no valuation until the table is re-reviewed (9.1); edgeX contracts have no published definition |
| **Markets explorer and comparator** | **Ready** | read-only | — | — | — | estimates of now; depth is a lower bound on two venues; hand-reviewed symbol map (1.8, 1.10) |
| **SDKs** (`@sp-wallet/trading-sdk`, `sp-wallet-python`) | n/a (client libraries; installed from the repository path) | usable against any deployed V11 API | — | — | whether to publish | stream types hand-written (6.5); CORS use from a browser untested (6.8) |
| **Risk engine, kill switch, read-only mode** | **Ready** | on at deployment (not a lock) | — | the six limits | limits; automatic-kill thresholds | API-side: not a defence against a compromised API (3.1); resting orders not counted (2.10) |

**What the final interface pass and the final validation changed in the "never opened in a browser" statements
(2026-11-17).** Opened in Chromium on real local stacks: the Risk screen (banner, limits form, kill switch engaged and
released with the passkey), the Agents panel (template → backtest → paper → request live → pause → stop), the Developer
screen, Trade (paper order with the engine's checks, unified blotter, command line), Activity, Markets / Compare / Private
markets, the Dashboard, market making on paper and its live checklist up to where the server refuses. **Still never opened
in any browser:** the live two-prompt approval of a trading mandate and of a quoting mandate; `PerpAgentLive` beyond the
request sheet; the resume / re-base passkey step; a live close or a live command — all need a venue account, which a local
stack does not have. **Safari and iOS: never, for anything.**

---

## 3. What must be true before each lock is turned on

| Lock | Before enabling |
|---|---|
| `SPW_TRADING_API_EXECUTION` | deployment stable; the six limits set **and** every live limit stored (automation never sees the seed); the review items of `docs/V11-SECURITY-REVIEW.md` read; the testnet stage done; a key with a live mandate exists or a live agent has a new mandate — otherwise there is nothing for the lock to open. Remember it gates agents too |
| `SPW_DERIV_LIVE_MAINNET` | as currently set. If it is off today: the Hyperliquid acknowledgement; an authorization; the decision of §1 |
| `SPW_DERIV_MANDATE_MAINNET` | as currently set. If it is to be turned on for a V11 agent or key: everything of the first row, plus acceptance of rows 3.2 and 3.12 |
| `SPW_DERIV_GMX_LIVE` | as currently set. For the V11 path: a fork run; GMX in the allow-lists; GMX limits set by API |
| `SPW_DERIV_MM_TESTNET` | the owner's testnet step of the market-making checklist; test funds only; with `SPW_TRADING_API_EXECUTION` — so mainnet must be closed by its own locks during the step |
| `SPW_DERIV_MM_MAINNET` | last of all; the in-app go-live checklist complete; the integration is merged — its review (items 10–19 of `V11-DEPLOYMENT.md` §1) is not done |

---

## 4. Staged enablement path

No stage proposes sending a real order in order to test something. What can be tested is tested on paper and on the
venue's testnet with test funds; the first real order is a decision to trade at the smallest size, after that.

| Stage | Action | Locks | Exit criteria | Stop / back out |
|---|---|---|---|---|
| **0 — Authorize** | The owner gives items 1–19 of `V11-DEPLOYMENT.md` §1 (deployment and rollback procedure; the seven and the nine signer behaviour changes, each read; the API changes of the market-making integration). The final test run is recorded (`V11-TEST-RESULTS.md` §6) | — | written yes per line | — |
| **1 — Deploy, every new lock off** | `V11-DEPLOYMENT.md` §7. `SPW_TRADING_API_EXECUTION`, `SPW_DERIV_MM_MAINNET` and `SPW_DERIV_MM_TESTNET` unset; the others as currently set | new: off | every check of §8 there; the capability line identical to the one noted before | rollback procedure §9 there |
| **2 — Set the live limits** | Read `GET /api/v1/risk/limits/live` → `seed`; set the six missing limits (passkey), tight. This restores the owner's own manual trading as before V11, now under the risk engine | unchanged | the Risk banner is gone for the owner; a preview of a small manual order shows `risk: allow` — a preview signs and sends nothing | tightening is free; the kill switch |
| **3 — Paper, for N days** (N chosen by the owner — long enough to include at least one API restart and one venue or network outage) | An API key bound to a paper mandate; perp agents on paper from the templates; a stream agent on paper; the risk supervisor. Drills, all on paper: engage and release the kill switch; revoke a key; revoke a mandate; restart the API mid-session and read the orders afterwards; cut the network on the phone and watch the stream fall back | unchanged | no `projection_error`, no order left `UNKNOWN`, no dead-lettered job without a cause, `order_projection_queue` drains, the stream runs on the owner's phone (Safari), memory of the API process stable; paper results **read against the lab's verdicts**, not as a forecast | stop the agents; nothing is at risk |
| **4 — Testnet, by the owner, with test funds** | A Hyperliquid **testnet** account authorized with the passkey. Mainnet locks do not apply to testnet (`capabilities.ts`: "testnet works"); orders by a key or an agent through the order service need `SPW_TRADING_API_EXECUTION=on`, so during this stage mainnet stays closed by `SPW_DERIV_LIVE_MAINNET` / `SPW_DERIV_MANDATE_MAINNET` — if those are on today, that is a decision to take first. (Read in `orders/service.ts`: the execution lock tests `mode === 'live'` whatever the network. The V11 order service and trading mandates were never run on the testnet — only on the scripted venue — so the first thing this stage establishes is that the testnet path works at all.) Verify on the venue what was only ever seen on a fake: an accepted order, a partial fill, a cancel, a leverage confirmation, an ambiguous submission reconciled, a refusal by the signer outside the mandate, the kill switch, key and mandate revocation, an agent's wind-down. For market making, the six items of the go-live checklist (item 4) | `SPW_TRADING_API_EXECUTION=on` for the session; mainnet closed | each behaviour observed and written down; every difference from the scripted venue fixed and re-tested | turn the lock off: exits still pass |
| **5 — The smallest live mandate, one instrument** | Only after 4. One key (or the owner's own session through the API), one Hyperliquid account, BTC only, the venue's minimum order size, leverage 1×, the shortest validity, a floor and a daily-loss limit close to the capital, all live limits tight. Source addresses restricted, short key expiry | `SPW_TRADING_API_EXECUTION`, `SPW_DERIV_LIVE_MAINNET`, `SPW_DERIV_MANDATE_MAINNET` on | the order's history in `orders` matches the venue; usage counters move; the signer journal shows the signature under the mandate; webhooks delivered | revoke the mandate (no passkey), revoke the key, kill switch, signer halt — in that order of reach |
| **6 — Widen, one variable at a time** | a second instrument; a larger notional; a longer validity. Never two at once | unchanged | as 5 | as 5 |
| **7 — A live agent** | Only on the owner's explicit acceptance that no strategy shows an edge. A new trading mandate for one agent on the same account (one principal per account: the key's mandate must be revoked first), 1× leverage, the smallest capital | unchanged | the agent's orders are unified orders under its mandate; it closes only its own lot; `mandate_revoked` winds it down | pause (the mandate stays), stop, revoke |
| **8 — GMX through the V11 path** | after a fork run of the unified path; the owner adds `gmx` to the allow-lists and sets its limits; each order still needs the passkey | `SPW_DERIV_GMX_LIVE` | one increase and its decrease recorded as unified orders | the GMX halt; the lock (closing and cancelling still work) |
| **9 — Market making** | Last, and only through `docs/V11-MARKET-MAKING.md` §11: written acceptance of the negative evidence, the integration (merged) reviewed, the testnet verifications, leverage set by hand, one instrument and one level at the minimum size, a quoting mandate of at most 7 days with any directional mandate revoked first, four settings on, the first session watched, **stop if the realised markouts confirm the study** | + `SPW_DERIV_MM_MAINNET` | the checklist's own | kill switch (pulls quotes), revoke (no passkey), signer halt; before any signer rollback, revoke every quoting mandate |

Stages 7, 8 and 9 are independent of each other and none is required. Stage 5 is not required either: deploying with
every new lock off (stages 1–3) already delivers the read API, paper trading, the agents in research and paper, the
markets screens, the stream and the risk engine over the owner's existing manual trading.

---

## 5. What does not change with any stage

- A compromised API process is bound only by what the signer enforces. The kill switch, the risk limits and the
  API-only fields of a mandate are that process's own checks.
- The signer halt can be set by the API and lifted only on the signer machine; under it, reductions are still signed
  with the passkey.
- Exits are never behind a lock.
- edgeX and dYdX are market data only; builder-dex private markets are display only.
- Nothing in the lab or in the market-making study supports an expectation of profit.
