# Trading — production readiness (V11)

An assessment per capability of branch `v11` (`fa48015`), written 2026-11-15 from the work notes, the module documents
and the code. V11 is not deployed. Two workstreams are not merged (`v11-mm-live`, `v11-ui`); their rows are placeholders.

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
| **Stream agents** (market making, cross-exchange, funding arbitrage — paper and research) | **Ready** | paper only: **no live mode exists** | — | — | — | their paper orders are not unified orders (5.5); the second venue of two families is edgeX or dYdX: data only, never tradable (5.4); fill model optimistic (5.6) |
| **Spot agents** (vault + spot mandate at the signer; existing capability, changed by V11) | **Ready** — changes: a stopped or paused agent's mandate is revoked; one mandate per vault; the kill switch refuses their buys at the database row | as in V10: **Owner steps** (a spot mandate per agent, passkey) | none in the API (the signer's mandate and `policy.json`) | — | the vault's balance is the exposure | **market loss inside a spot mandate is not bounded by the signer** (4.4); caps in base units at approval prices (4.5); backtests at default limits without latency or gas (5.2) |
| **Market making — paper** (stream family `market-making` of the agents runtime) | **Ready** | paper only | — | — | — | `spread_inventory` is not the `QuotePolicy` of the core; two fill models exist (5.15) |
| **Market making — live** (quoting mandate, engine, dead man's switch) | the **signer** code ships in the `v11` bundle and needs review before any signer deployment (A3 of `V11-DEPLOYMENT.md`); the API engine is **not wired** | **Not ready**: not integrated on `v11`; six venue behaviours never verified (4.10); ADR not updated (4.3); **the evidence is negative** (study and simulator) | `SPW_DERIV_MM_MAINNET` + `SPW_DERIV_LIVE_MAINNET` + `SPW_DERIV_MANDATE_MAINNET` | the ten-item go-live checklist of `docs/V11-MARKET-MAKING.md` §11, in its order | written acceptance of the negative evidence and of tier-0 maker fees paid; capital, instrument, sizes, floor, `deadManSeconds`, hours | adverse selection; the signer's mid is spot (4.9); unmetered cancels; nothing verified on a funded account |
| **Swaps and bridges** (existing; V11 stabilisation: B1–B6, route card, execution status, idempotent preparation) | **Ready** — server side tested on scripted chains with restart tests; **the web changes were never opened in a browser** (10.1) | as in V10 (passkey per operation; signer `policy.json`) | `SPW_BROADCAST` as currently set | a browser pass of Swap, Home, Activity, plans | third RPC endpoints (7.1); 0x / 1inch keys (7.3) | one degraded RPC endpoint still blocks a network; single price source; execution evidence on most networks is forks and simulation (7.4) |
| **Quote stream** (websocket, live cells) | **Ready** — polling and SSE remain as fallback | no lock; on at deployment | — | outbound `wss` to Coinbase from the API node | `stream_close_delay` in Caddy or not | **Safari / iOS never run** (8.1); load measured on a laptop only (8.7); in-process hub |
| **Private markets** (display and five-quantity valuation) | **Ready** | display only; nothing to enable | — | — | — | **the Anthropic entries expire at 2026-11-18T00:00Z**: from then, "definition under review" and no valuation until the table is re-reviewed (9.1); edgeX contracts have no published definition |
| **Markets explorer and comparator** | **Ready** | read-only | — | — | — | estimates of now; depth is a lower bound on two venues; hand-reviewed symbol map (1.8, 1.10) |
| **SDKs** (`@sp-wallet/trading-sdk`, `sp-wallet-python`) | n/a (client libraries; installed from the repository path) | usable against any deployed V11 API | — | — | whether to publish | stream types hand-written (6.5); CORS use from a browser untested (6.8) |
| **Risk engine, kill switch, read-only mode** | **Ready** | on at deployment (not a lock) | — | the six limits | limits; automatic-kill thresholds | API-side: not a defence against a compromised API (3.1); resting orders not counted (2.10) |

<!-- PENDING: market-making integration (branch v11-mm-live) — revise the two market-making rows: what is wired, what remains, and whether the prerequisites (a)–(c) of the checklist changed -->

<!-- PENDING: final interface pass (branch v11-ui) — revise the "never opened in a browser" statements of the swaps, risk-approval and agents rows -->

---

## 3. What must be true before each lock is turned on

| Lock | Before enabling |
|---|---|
| `SPW_TRADING_API_EXECUTION` | deployment stable; the six limits set **and** every live limit stored (automation never sees the seed); the review items of `docs/V11-SECURITY-REVIEW.md` read; the testnet stage done; a key with a live mandate exists or a live agent has a new mandate — otherwise there is nothing for the lock to open. Remember it gates agents too |
| `SPW_DERIV_LIVE_MAINNET` | as currently set. If it is off today: the Hyperliquid acknowledgement; an authorization; the decision of §1 |
| `SPW_DERIV_MANDATE_MAINNET` | as currently set. If it is to be turned on for a V11 agent or key: everything of the first row, plus acceptance of rows 3.2 and 3.12 |
| `SPW_DERIV_GMX_LIVE` | as currently set. For the V11 path: a fork run; GMX in the allow-lists; GMX limits set by API |
| `SPW_DERIV_MM_MAINNET` | last of all; the go-live checklist; a merged and reviewed integration |

---

## 4. Staged enablement path

No stage proposes sending a real order in order to test something. What can be tested is tested on paper and on the
venue's testnet with test funds; the first real order is a decision to trade at the smallest size, after that.

| Stage | Action | Locks | Exit criteria | Stop / back out |
|---|---|---|---|---|
| **0 — Authorize** | The owner gives A1–A3 of `V11-DEPLOYMENT.md` (deployment; the signer behaviour changes, each read). The final test run is recorded | — | written yes per line | — |
| **1 — Deploy, every new lock off** | `V11-DEPLOYMENT.md` §7. `SPW_TRADING_API_EXECUTION` and `SPW_DERIV_MM_MAINNET` unset; the others as currently set | new: off | every check of §8 there; the capability line identical to the one noted before | rollback procedure §9 there |
| **2 — Set the live limits** | Read `GET /api/v1/risk/limits/live` → `seed`; set the six missing limits (passkey), tight. This restores the owner's own manual trading as before V11, now under the risk engine | unchanged | the Risk banner is gone for the owner; a preview of a small manual order shows `risk: allow` — a preview signs and sends nothing | tightening is free; the kill switch |
| **3 — Paper, for N days** (N chosen by the owner — long enough to include at least one API restart and one venue or network outage) | An API key bound to a paper mandate; perp agents on paper from the templates; a stream agent on paper; the risk supervisor. Drills, all on paper: engage and release the kill switch; revoke a key; revoke a mandate; restart the API mid-session and read the orders afterwards; cut the network on the phone and watch the stream fall back | unchanged | no `projection_error`, no order left `UNKNOWN`, no dead-lettered job without a cause, `order_projection_queue` drains, the stream runs on the owner's phone (Safari), memory of the API process stable; paper results **read against the lab's verdicts**, not as a forecast | stop the agents; nothing is at risk |
| **4 — Testnet, by the owner, with test funds** | A Hyperliquid **testnet** account authorized with the passkey. Mainnet locks do not apply to testnet (`capabilities.ts`: "testnet works"); orders by a key or an agent through the order service need `SPW_TRADING_API_EXECUTION=on`, so during this stage mainnet stays closed by `SPW_DERIV_LIVE_MAINNET` / `SPW_DERIV_MANDATE_MAINNET` — if those are on today, that is a decision to take first. (Read in `orders/service.ts`: the execution lock tests `mode === 'live'` whatever the network. The V11 order service and trading mandates were never run on the testnet — only on the scripted venue — so the first thing this stage establishes is that the testnet path works at all.) Verify on the venue what was only ever seen on a fake: an accepted order, a partial fill, a cancel, a leverage confirmation, an ambiguous submission reconciled, a refusal by the signer outside the mandate, the kill switch, key and mandate revocation, an agent's wind-down. For market making, the six items of the go-live checklist (item 4) | `SPW_TRADING_API_EXECUTION=on` for the session; mainnet closed | each behaviour observed and written down; every difference from the scripted venue fixed and re-tested | turn the lock off: exits still pass |
| **5 — The smallest live mandate, one instrument** | Only after 4. One key (or the owner's own session through the API), one Hyperliquid account, BTC only, the venue's minimum order size, leverage 1×, the shortest validity, a floor and a daily-loss limit close to the capital, all live limits tight. Source addresses restricted, short key expiry | `SPW_TRADING_API_EXECUTION`, `SPW_DERIV_LIVE_MAINNET`, `SPW_DERIV_MANDATE_MAINNET` on | the order's history in `orders` matches the venue; usage counters move; the signer journal shows the signature under the mandate; webhooks delivered | revoke the mandate (no passkey), revoke the key, kill switch, signer halt — in that order of reach |
| **6 — Widen, one variable at a time** | a second instrument; a larger notional; a longer validity. Never two at once | unchanged | as 5 | as 5 |
| **7 — A live agent** | Only on the owner's explicit acceptance that no strategy shows an edge. A new trading mandate for one agent on the same account (one principal per account: the key's mandate must be revoked first), 1× leverage, the smallest capital | unchanged | the agent's orders are unified orders under its mandate; it closes only its own lot; `mandate_revoked` winds it down | pause (the mandate stays), stop, revoke |
| **8 — GMX through the V11 path** | after a fork run of the unified path; the owner adds `gmx` to the allow-lists and sets its limits; each order still needs the passkey | `SPW_DERIV_GMX_LIVE` | one increase and its decrease recorded as unified orders | the GMX halt; the lock (closing and cancelling still work) |
| **9 — Market making** | Last, and only through `docs/V11-MARKET-MAKING.md` §11: written acceptance of the negative evidence, integration merged and reviewed, the testnet verifications, leverage set by hand, one instrument and one level at the minimum size, a quoting mandate of at most 7 days with any directional mandate revoked first, three settings on, the first session watched, **stop if the realised markouts confirm the study** | + `SPW_DERIV_MM_MAINNET` | the checklist's own | kill switch (pulls quotes), revoke (no passkey), signer halt; before any signer rollback, revoke every quoting mandate |

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
