# SP Wallet V11 — remaining limitations

The register of what is not done, partly done, not verified, or deliberately refused, on branch `v11` at `fa48015`
(2026-11-15). Compiled from every "not done / limitation / needs review" list of `docs/v11/work/*.md`, the audits
(`docs/V11-AUDIT.md`, `docs/v11/audit-parts/*.md`, `docs/TRADING-AGENTS-AUDIT.md`) and the module documents, and checked
against the code where two notes disagreed (section 14).

How to read a row: **What** · **Why** · **Impact** · **Closes it** · **Who** (O = owner decision, E = engineering,
X = external party) · **Blocks** (the lock that should not be enabled while the item is open; "—" = none).

Locks: **L-API** `SPW_TRADING_API_EXECUTION` · **L-LIVE** `SPW_DERIV_LIVE_MAINNET` · **L-MAND**
`SPW_DERIV_MANDATE_MAINNET` · **L-GMX** `SPW_DERIV_GMX_LIVE` · **L-MM** `SPW_DERIV_MM_MAINNET`.

Source abbreviations: `w/<name>` = `docs/v11/work/<name>.md`.

---

## 0. The three statements that outweigh the rest

1. **No live order was ever sent by this code to a venue on a funded account — testnet or mainnet.** Every live path is
   proven on the real signer code against scripted or fake venues (`docs/V11-AUDIT.md` §10; `w/exec2` item 11; `w/mm-core`
   §6; `w/agents-bind` "Not verified"). Blocks L-API, L-LIVE, L-MAND, L-GMX, L-MM as a matter of knowledge, not of code:
   the first real order will be the first test.
2. **No strategy shows an out-of-sample edge.** Seven V11 strategies on 180 days of real data: deflated Sharpe between
   0.000 and 0.099 (0.95 needed); four are stopped by the engine's own loss limits in at least one split; the two
   live-capable versions are not exceptions (`w/quant-lab`, summary and §3).
3. **The market-making evidence is negative.** The lab study: modelled PnL negative on every Hyperliquid book under both
   fill rules. The simulator of `v11-mm-core`: −1.83 bps of volume, adverse markouts at 1 s, 10 s and 60 s, at a maker
   fee of 1.5 bps **paid** (`docs/V11-MARKET-MAKING.md` §10; `w/mm-core` §5).

---

## 1. Venues and jurisdiction

| # | What | Why | Impact | Closes it | Who | Blocks |
|---|---|---|---|---|---|---|
| 1.1 | **edgeX: market data only.** No account, no trading, never simulated | its Terms of Use exclude Canada and prohibit VPN circumvention (`docs/v4/venues/jurisdiction.md`; `w/edgex` §2) | no edgeX leg in any strategy; cross-venue strategies are research only | a change of edgeX's terms; not something the software may lift | X | — |
| 1.2 | **dYdX: market data only** | v4 terms exclude Canada; the indexer answers account endpoints `GEOBLOCKED` | same | same | X | — |
| 1.3 | **Hyperliquid live trading is the owner's decision**: terms name Ontario, not Québec; neither Hyperliquid nor GMX is on the AMF register (checked 2026-11-10); the AMF warning list could not be searched; whether the interface blocks a Québec IP is not verified | `docs/v4/venues/jurisdiction.md` (general information, not legal advice) | legal exposure is not assessed by the software | the owner's own determination, recorded by the acknowledgement at authorization | O | L-LIVE, L-MAND, L-MM |
| 1.4 | **GMX v2**: Canada not named; compliance clause puts the question on the user; off until two settings and a passkey-approved venue policy | same document | same | same | O | L-GMX |
| 1.5 | **Builder-dex private markets are display only** (`tradable: false`, `builder_dex_read_only`); trade.xyz names Canada, EntropyIO restricts Ontario | `docs/V11-SYNTHETIC-MARKETS.md` §6 | no trading of pre-IPO contracts | a legal answer, then engineering | O, E | — |
| 1.6 | No trading seam for a new venue beyond Hyperliquid and GMX; one venue signs under a mandate | `docs/V11-AUDIT.md` §3; `docs/TRADING-MANDATES.md` "Open points" | no second live venue; no cross-venue live strategy | signer-side mandate shape per venue | E | — |
| 1.7 | edgeX: undocumented `contract-labels` endpoint for `pre_ipo` / `commodity`; unpublished rate limits (defaults are guesses); no public testnet; no venue timestamp on tickers and books; no official definition of the pre-IPO contracts | `w/edgex` §1; `docs/V11-EXCHANGE-INTEGRATIONS.md` edgeX §7 | categories can silently degrade to `equity` / none; no implied valuation on edgeX | venue documentation | X | — |
| 1.8 | Symbol map is a hand-reviewed snapshot (84 GMX and 54 dYdX tickers, 2026-11-15); 260 of 812 perps unmapped live; reviewed against prices, not index definitions | `w/markets-compare` §1 | new listings are never compared until reviewed | periodic review | E | — |
| 1.9 | `Instrument.category` not populated for Hyperliquid, dYdX, GMX | `w/edgex` §1 | category filter relies on the normalisation table | adapter work | E | — |
| 1.10 | Hyperliquid book snapshot is 20 levels (ends ≈ 3 bps from mid on BTC): comparator depth is a lower bound; base fee tiers only; first-tier maintenance margin; no liquidation estimate on dYdX; GMX execution fee and gas not in the comparator total; GMX opening-leg impact formula not verified against the venue | `docs/V11-EXCHANGE-INTEGRATIONS.md` §7 of each venue; `w/markets-compare` §3 | cost comparison is an estimate of now, not a quote | adapter work | E | — |

---

## 2. Execution and orders

| # | What | Why | Impact | Closes it | Who | Blocks |
|---|---|---|---|---|---|---|
| 2.1 | Behaviour against the real Hyperliquid testnet or mainnet not verified: fills, partial fills, `userRole`, leverage confirmation, divergence, "never placed" rest on a fake exchange | forbidden by every brief; audit B-03 | unknown defects at first contact | a testnet session by the owner with test funds | O | L-API, L-LIVE, L-MAND |
| 2.2 | GMX: creation, simulated execution and keeper cancellation proven on an anvil fork only; shorts, the BTC market, frozen orders, liquidation, ADL never run; nothing sent to Arbitrum mainnet; the V11 unified path is tested on a scripted chain, no fork run | `docs/V11-EXCHANGE-INTEGRATIONS.md` GMX §8; `w/exec2` §6 | same | fork run of the unified path, then the owner's first order | E, O | L-GMX |
| 2.3 | GMX through the trading API: owner only; market orders only; one operation awaiting approval at a time; a long and a short on one market cannot be closed through the path; command path on GMX wired and **not tested**; key refusal tested at service level, not over HTTP | `w/exec2` §6; `w/contract-resync` Part 3 list #2 | narrow GMX surface | tests, then design | E | L-GMX |
| 2.4 | New GMX equity definition in the risk book (USDC on Arbitrum + margin + PnL) — "for review" | before it, a first GMX increase could not pass the engine | changes leverage and collateral-share figures of a book containing GMX | owner / reviewer reading | O | L-GMX |
| 2.5 | GMX has no client order id at the venue: an unknown operation is settled by the engine's own refresh; absence is never conclusive; a failure after an unknown outcome is recorded `REJECTED / VENUE_REJECTED` | `w/exec` §2, §3 | a GMX order can stay UNKNOWN | — (venue property) | X | — |
| 2.6 | Attached SL/TP: tested on paper only; cancelled, not re-sized, when the position shrinks; a stop that gaps past its slippage bound is not re-placed; an owner's live protective order not approved in time expires | `w/exec2` §7; `docs/V11-EXECUTION-ENGINE.md` §8.9 | a protected position can lose its protection | live-path test, re-size logic | E | L-API |
| 2.7 | Owner spot orders: no successful proposal went through the real in-process port (happy path uses a stand-in port); the owner's unified limits are **not evaluated** for a spot order; a REST BUY by base size is not expressible | `w/exec2` §5 | spot via the trading API is less proven than via the Swap screen; spot is outside the risk engine except the kill switch | test with the real port; limits for spot | E | — |
| 2.8 | `OrderInput` has no `notional`: the boundary converts; a named notional order is replay-stable only while its idempotency row exists (pruned after a day) | `w/contract-resync` Part 2 §5, Part 3 list #1 | a late replay is sized again at another price | `notional` in the order service | E | — |
| 2.9 | Position provenance: API-side bookkeeping; a fill of no known order is the owner's; a shortfall is taken from keys first; **no tie-break for fills on one timestamp** (non-deterministic replay) | `w/exec2` §3; `w/contract-resync` Part 2 §5 | a key can be told nothing of a position is its own | tie-break by fill id or sequence | E | L-API |
| 2.10 | Resting orders are not counted in exposure; a second account on a venue is judged per account for per-venue limits | `w/exec` §6; `docs/TRADING-RISK-ENGINE.md` | exposure understated while orders rest | engine change | E | — |
| 2.11 | The mapping of a spot agent's order reads English `reason` texts (no `agent_orders.reason_code`) | `w/exec2-notes-agents` §3; `w/agents-bind` item 7 (not added) | a reworded reason changes the projected state | the column | E | — |
| 2.12 | `partially_filled` both live and terminal in the Hyperliquid engine vocabulary (audit B-19) — hidden by the unified states, still present in `engineStatus` | not in any V11 scope | a consumer of `engineStatus` can misread | — | E | — |
| 2.13 | After revocation or expiry of a Hyperliquid authorization, resting orders stay at the venue and nothing can cancel them; no pre-expiry cancel-all (audit B-15) | not in scope (`w/stab-signer`, "Not in this branch") | operational trap at expiry | cancel-all before expiry + alert | E | L-LIVE |
| 2.14 | `recover` of an orphaned authorization or mandate is an explicit owner action with **no button** (route only) | `w/stab-signer` §5 | a lost answer needs a manual API call | UI | E | — |
| 2.15 | A venue collateral deposit signed with broadcast off: the collateral operation still says `sent` and waits forever (`not_broadcast` not in `collateral.ts`'s dead states); `gmx-exec.ts` moves its own proposals to `broadcast` unchanged | `w/stab-swaps` §2 | test mode only (`SPW_BROADCAST=off`) | two-line fix in the derivatives area | E | — |
| 2.16 | Collateral withdrawals stay behind L-LIVE (not treated as an exit); a venue withdrawal is not an exit under the signer halt | `w/stab-signer` §1, §2 (as specified) | with L-LIVE off, collateral cannot be withdrawn from the venue | owner decision on the rule | O | — |

---

## 3. Risk and mandates

| # | What | Why | Impact | Closes it | Who | Blocks |
|---|---|---|---|---|---|---|
| 3.1 | **The risk engine, the kill switch, read-only mode and every lock are API-side.** A compromised API ignores them; a kill-switch release is verified by the API, not the signer | design (`docs/V11-SECURITY-REVIEW.md` items 4, "A compromised API process") | what remains is the signer-enforced subset | none planned; the signer halt is the backstop | O (accept) | — |
| 3.2 | **API-only fields of a trading mandate** — order types, per-minute rate, daily-loss limit, fee cap, stop conditions, start time — are not enforced by the signer (pinned by `enforcement-pin.test.ts`: "signed although the trading mandate forbids it") | signer shapes have no such fields | a compromised API is bound only by the compiled derivative mandate | `tradingMandateSha256` in the signer mandate (proposal, **not implemented**), or new signer fields | E, O | L-API (review) |
| 3.3 | The full-hash binding is verified by the API against its own `credentials` table: no defence against a compromised API or a writer of that table; two passkey prompts; a mandate approved with a passkey later removed becomes unusable and is revoked | `w/exec2` §2 | — | 3.2 | E | — |
| 3.4 | **Six live limits are not seeded** and deny until set: `maxDailyNotional`, `maxNetExposure`, `maxAssetExposure`, `maxVenueExposure`, `maxVenueCollateralShareBps`, `maxDrawdownBps`; GMX is not seeded at all | nothing before V11 expresses them (`docs/V11-RISK-MODEL.md`) | after deployment the owner's real orders that add risk are refused until he sets them; keys and agents until he stores every limit | the owner, in Risk → Limits → Live | O | L-API, L-MAND (functionally) |
| 3.5 | The seed takes the **minimum over venue accounts** (tighter than each alone) and carries over a policy that a session could loosen without a passkey before V11 Phase B — "for review" | `w/exec2` §9 | seeded values may not be what the owner intends | owner reads `GET /api/v1/risk/limits/live` → `seed` | O | — |
| 3.6 | Venue reads shared for 2 s between evaluations (`SPW_RISK_CONTEXT_TTL_MS`): a change made at the venue outside the wallet is seen up to 2 s late — "for review" | rate budget | stale context for 2 s | accept or set 0 | O | — |
| 3.7 | A preview (`orders:prepare`) reveals the equity and free collateral of the account it names; a preview needs a mandate on the key although `orders:prepare` is not an execution scope | restated, not changed (`docs/V11-SECURITY-REVIEW.md` item 9; `w/contract-resync` list #5). Refusal shaping (`shapeRefusal`) withholds account figures from keys without `wallet:read` / `positions:read` on refusals of `POST /orders` | information disclosure to a prepare-only key | contract decision | O, E | — |
| 3.8 | Live mandates: Hyperliquid only, exactly one venue account; live spot mandates are not created by the mandate service (`spot_mandate_via_agent_vault`) | `docs/TRADING-MANDATES.md` "Open points" | — | signer shapes | E | — |
| 3.9 | **Manual mode and GMX: position, exposure and loss limits do not exist at the signer** (audit B-09); `maxPositionNotional` / `maxGrossExposure` of an authorization look signer-enforced and are not | not in any V11 scope | compromised API + approved prompts is bounded per order, per day and by the price band only | signer change | E, O | L-LIVE, L-GMX (accept) |
| 3.10 | GMX realised PnL excludes keeper liquidations, funding / borrowing settled into collateral, activity from another interface; `maxGrossExposure` (3×) and `maxPositionNotional` (2×) of the GMX policy are constants; **no web control** for the GMX halt or limits | `w/stab-signer` §9 | GMX loss limits can under-count | UI + accounting | E | L-GMX |
| 3.11 | The price-band sanity ratio (3) is a constant; the API's mark and the signer's mid differ, so an order at the edge can pass the API and be refused by the signer after the passkey prompt | `w/stab-signer` §7 | a rare refused protective order | — | E | — |
| 3.12 | A trading mandate's gross bound is compiled as capital × leverage with the floor below capital: an agent with gross 1.5× and floor 0.9× is expressible only at **1× leverage** (was 2×); daily turnover at the signer = order limit × orders per day (looser than before) | `w/agents-bind` §3 and "For the execution-gaps workstream" 3, 4 | live agents run at 1×; turnover bound looser | a gross-bound field in the mandate | E | L-MAND (review) |
| 3.13 | A paper mandate lasts 90 days; no renewal without a restart; a key's **daily** notional limit is not expressible in a mandate and does not bound its agents' paper orders | `w/agents-bind` §1, "Not done" | a long-running paper agent stops | renewal by owner / key | E | — |
| 3.14 | The total-loss case of the automatic kill is tested with an inserted losing fill row, not a traded loss | `w/exec2` §8 | weaker evidence | — | E | — |
| 3.15 | Missing limits and a failed mandate integrity are shown as current conditions, not stored alerts | `w/exec2` §10 | no push notification | alert rules | E | — |

---

## 4. Signer

Every row marked **review** is a change to what the key-holding process accepts; each has refusal tests, none was read
by a human reviewer (`w/stab-signer` "For the reviewer before any deployment"; `w/mm-core` §2).

| # | What | Why | Impact | Closes it | Who | Blocks |
|---|---|---|---|---|---|---|
| 4.1 | **Review**: seven behaviour changes of Phase B (halt signs reduce-only / GMX decrease / GMX cancel with passkey; trigger band; `POST /venue/authorization`; one mandate per vault; Kraken `online`; on-disk format; CLI through the control socket — `unhalt` effective at once) | `w/stab-signer` | — | human reading of the diff | O | signer deployment |
| 4.2 | **Review**: nine behaviour changes of the quoting mandate (new mandate kind; a seventh passkey-less path; multi-order and `scheduleCancel` actions; quotes outside the authorization's `maxOrdersPerDay`; exclusivity with the directional mandate; `orderStatus` outbound read; new state fields; journal volume; status fields) | `w/mm-core` §2 | the code ships in the signer bundle even with L-MM off and no API caller | human reading; or build the signer without it | O | signer deployment, L-MM |
| 4.3 | **`docs/adr/0001-custody.md` says "exactly six paths"**; the code has seven. Threat-model rows 4 and 19, `docs/v6/DERIVATIVE-MANDATE.md`, `docs/TRADING-MANDATES.md` and the runbook do not describe the quoting shape | "not this workstream's file" (`w/mm-core` §2.2, §4.11) | the custody statement is incomplete | edit the ADR and the four documents | E | L-MM |
| 4.4 | **Spot mandate loss floor (D3): deliberately not implemented.** Market loss inside a spot mandate is not bounded by the signer; revocation on stop is done by the API | the signer reads no chain; a floor needs RPC trust and `SPW-MANDATE-v2` (`docs/V11-SECURITY-REVIEW.md`) | a compromised API can rotate a vault into falling mandated assets | the v2 design described there | O, E | — |
| 4.5 | Spot mandate caps are in base units fixed at approval prices (D13) — justified, not fixed | the signer has no spot price | caps drift with prices for ≤ 90 days | signer price source | E | — |
| 4.6 | HMAC nonce replay cache is in memory (B-16); vault-return endpoints sign without passkey, halt check or amount limit (B-17, destination fixed to the owner) | not in scope | bounded (gas only) | — | E | — |
| 4.7 | Closed journal segments are not re-verified at start; the static fixture's passkey key is not in the repository ("approvals still verify" tested on a file written by the test); **`main.ts` (CLI wiring) has no automated test** — exercised by hand | `w/stab-signer` §6 | — | tests | E | — |
| 4.8 | Kraken's ticker has no per-quote time: `online` proves the exchange trades, not that a pair's book moved; when Kraken reports anything else, **every** mandate and venue order is refused | `w/stab-signer` §10 | availability cost | — | O (accept) | — |
| 4.9 | Quoting: the signer cannot know a signed `scheduleCancel` was sent; cancels and reduce-only orders are not metered (a compromised API can burn the rate limit and grow the journal); the signer's mid is **spot** while the venue trades a perpetual; bounds are in USD at signing time | `w/mm-core` §1.3; `docs/V11-MARKET-MAKING.md` §9 | skewed fills; unbounded cancel volume | — | O (accept) | L-MM |
| 4.10 | Never verified against the venue: `scheduleCancel` replacement and firing, the trigger count, duplicate cloid behaviour, `frontendOpenOrders` lag, `expiresAfter` rejection, real queue position; `modify` / `batchModify`, fast cancels, priority fees not built; maximum batch length undocumented by the venue | `w/mm-core` §6 | the dead man's switch is unproven on the venue | testnet with test funds (go-live checklist item 4) | O | L-MM |
| 4.11 | **Rollback rule**: a pre-quoting signer binary would approve a directional mandate next to an active quoting mandate — revoke every quoting mandate before rolling the signer back | `w/mm-core` §2.7 | — | procedure (in `V11-DEPLOYMENT.md`) | O | — |
| 4.12 | Lifting the signer halt still needs the signer machine | by design | — | — | — | — |
| 4.13 | `docs/security/acceptance.md` still says "mainnet only" (B-12) | outside the listed documents | stale | edit | E | — |

---

## 5. Agents and strategies

| # | What | Why | Impact | Closes it | Who | Blocks |
|---|---|---|---|---|---|---|
| 5.1 | **No strategy shows an out-of-sample edge** (statement 2). One 180-day window, a five-week test split, parameters not tuned; the pipeline was executed several times on the test data during development (disclosed; nothing was selected) | `w/quant-lab` §3 | a live agent has no evidence of profit | more history, new research | O | L-MAND (decision) |
| 5.2 | Latency model is a bound, not a measured distribution (largest cost line of five runs); spot engine has engine parity but no latency / impact / gas model, at **default** limits rather than the agent's own; loss limits checked at bar closes in the lab, every minute live; no order-level simulation; GMX not backtested as a perpetual; trades not recorded; one 67-minute book recording | `w/quant-lab` §1, §6; `docs/TRADING-BACKTESTING.md` §9; audit D6 "partly for spot" | backtest ≠ live, in stated directions | lab work (`--parity-json`, recordings) | E | — |
| 5.3 | Hyperliquid serves its last 5 000 hourly candles: the snapshot's start falls out of reach around 2026-12-13; raw data are not in git (manifest only) | `w/quant-lab` §2 | results not reproducible from the venue after that date | keep `research/data` | O | — |
| 5.4 | **Live only on Hyperliquid, BTC / ETH / SOL**, bar agents (momentum, mean reversion; stat-arb needs LINK, AAVE, HYPE pinned — not recommended). No live mode for market making, cross-exchange, funding arbitrage, basis carry; no paired-leg execution | one venue signs under a mandate; perp agents refuse spot legs | five of seven families are research / paper only | venue seam, multi-account mandates | E | — |
| 5.5 | **Stream agents' paper orders are not unified orders** (own simulated book, seam ledger); spot agents reach `orders` by projection, with the seam ledger kept beside `agent_orders` | venues the order service refuses in any mode; no account a mandate could name (`w/agents-bind` "Not done") | two record systems for agent orders | an `engine: 'sim'` in the order service | E | — |
| 5.6 | Stream tests: the second venue of cross-exchange and funding tests is **scripted** (no recorded edgeX / dYdX book of the same instant); dYdX and GMX polling not exercised with a stream agent; the fill model ignores queue position and intra-interval adverse selection | `w/agents` §6 | paper results of stream agents are optimistic | recordings | E | — |
| 5.7 | `SPW_TRADING_API_EXECUTION` also gates a **live agent's** new risk (the order service applies it to every caller); needed in both processes when the worker is separate | `w/agents-bind` §1 and item 2 (scoping by origin proposed, not done) | L-API cannot be kept off while a live agent adds risk | scope the lock by origin | E, O | L-MAND ⇒ needs L-API |
| 5.8 | A LIVE agent whose mandate predates V11.2 is **reduce-only** until a new trading mandate is approved; a strategy version approved before D4 keeps its approval | `w/agents-bind` §3; `w/stab-signer` §4 | an existing live agent stops adding risk at deployment | new mandate by the owner | O | — |
| 5.9 | Risk supervisor: its "reduce" is a proposal; `spq.risk_supervisor.propose` is not its policy (kept in TypeScript); it pauses agents and engages the kill switch only | `w/agents` §7; `w/agents-bind` §4 | — | lab entry point | E | — |
| 5.10 | A tick cannot be interrupted: past its deadline it runs on, holding its lease; the stream loop runs every second with no stream agent; `agent-worker-process` horizons are shortened by SQL in the test, and the test timed out once in six full-suite runs (not fixed) | `w/agents` §4; `w/agents-bind` §5; `w/contract-resync` Part 3 | — | — | E | — |
| 5.11 | Migration of an engaged agents-side kill-switch flag: covered by reading the SQL, not by a test on a pre-V11.2 database | `w/agents-bind` §2 | only matters for a database that ran V11.1 — production never did | — | E | — |
| 5.12 | Performance figures: spot network fees, perp slippage and stream per-trade results not computed; backfill keeps LIVE for journal lines written after an agent left LIVE; family of a pre-V11 agent inferred from its strategy name; a spot agent's limits cannot be edited after creation | `w/agents` §1–3 | — | — | E | — |
| 5.13 | D15 (thin symbols hold an agent) and D13 — justified, not fixed; D10 cross-run ledger (`research/results/ledger.jsonl`) untouched; `rj_*` strategy directories left in the main checkout | `docs/TRADING-AGENTS-AUDIT.md` §10; `w/quant-lab` §4 | — | — | E | — |
| 5.14 | Research runner: deployed, no real job verified (`docs/V11-AUDIT.md` §3, §10) — not addressed in V11 | not in scope | unknown | a real job | O | — |
| 5.15 | Market making: `spread_inventory` (paper rule) not ported to `QuotePolicy`; `sim-venue.ts` is a second fill model next to the runtime's `mmFills`; one instrument; no latency, IP limit, partial depth or funding in the simulator; REST reconcile too expensive for production (IP weight) | `w/mm-core` §1.5, §1.6 | integration work | `v11-mm-live` | E | L-MM |

<!-- PENDING: market-making integration (branch v11-mm-live) — which rows of 4.2, 4.3, 4.9, 4.10, 5.15 it closed, and the limitations it adds -->

---

## 6. Trading API and SDKs

| # | What | Why | Impact | Closes it | Who | Blocks |
|---|---|---|---|---|---|---|
| 6.1 | Rate limiters, the failed-auth throttle, stream connection limits, the swap stream cap, RPC endpoint health and the signer-address memory are **in memory, per process** | `w/trading-api` §2; `w/quotes` §3; `w/stab-swaps` §10 | wrong with two API processes | one API process (current design) | — | — |
| 6.2 | `X-SPW-Timestamp` is optional and unsigned; the audit actor of pre-V11 routes is still the literal `owner` | `w/trading-api` §2 | — | — | E | — |
| 6.3 | Webhooks: creating an endpoint needs the session only (no passkey); **the URL host is not checked against private ranges** (SSRF surface for a session thief) | `w/trading-api` §6 | a stolen session can point the server at an internal host | host check | E | — |
| 6.4 | Key rotation unbinds a trading key (the mandate names the old id) — kept on purpose; the answer says how to re-bind | `w/contract-resync` Part 2 §4 | a rotated key cannot trade until re-bound | — | O (accept) | — |
| 6.5 | Contract mismatches still open: agent answers and `agent.updated` are loose objects; `halted` / `restricted` on a perp agent's paper start are declared, not provoked; `StartRequest.agentId`; `halted: null` on balances declared, not provoked; **the stream has no machine-readable contract**: the SDK message types are hand-written; what compares them with the server is one TypeScript test that parses sample messages with the server's zod schema (`packages/trading-sdk/test/stream.test.ts`) and, for Python, the server-generated book vectors only | `w/contract-resync` Part 3 list | — | — | E | — |
| 6.6 | A stream connection writes no row in the key's usage log (counted in stats and logged) | `w/quotes` §3 | usage log understates stream use | — | E | — |
| 6.7 | Read side: spot `mark` is the last 1 h close; no spot order book; GMX positions read from the chain on each call | `w/trading-api` §4 | — | — | E | — |
| 6.8 | SDKs: neither package is published (installed from the repository path); no mypy / pyright for Python; Python refuses an answer whose enum value the document lacks (strict by design); TypeScript in a browser depends on the API's CORS policy, **not tested**; in Node the stream header needs Node ≥ 22 or `ws`; the browser WebSocket API gives no status for a refused handshake; documents' code snippets are not executed (examples are); the ticket flow is two snippets, not an executed example | `w/sdks` "Limitations"; `w/contract-resync` Part 3 §1; `w/quotes` §7 | — | publish; CORS test | O, E | — |
| 6.9 | The Developer screen has no form to edit an existing key (routes exist) | `w/trading-api` §7 | — | UI | E | — |
| 6.10 | `compareMarkets` not exercised with a real key in its own test (generic key path covered) | `w/markets-compare` §5 | — | — | E | — |
| 6.11 | Under full-suite load the contract and SDK integration files are slow (timeouts raised to 240–300 s, cause not removed) | `w/contract-resync` Part 3 §4 | — | — | E | — |

---

## 7. Swaps and bridges

| # | What | Why | Impact | Closes it | Who | Blocks |
|---|---|---|---|---|---|---|
| 7.1 | **`rpcQuorum` unchanged by default**: all 24 networks have exactly two endpoints, so one degraded endpoint still refuses signing on that network; ejection helps only with a third endpoint (`SPW_RPC_EXTRA`); none was added | safety property kept (`w/stab-swaps` §10) | availability | the owner configures third endpoints | O | — |
| 7.2 | **Price sources: two for 42 symbols, still one for 53, and only with a key.** CoinGecko's free tier stays the primary price of the portfolio, swap valuation, risk flags and plan estimates. With `APIBRICKS_API_KEY` (optional; unset in production today) API Bricks is a second source for the 42 symbols that map onto it with certainty: every price names its `source`, a missing or stale CoinGecko price is replaced by the second one and labelled `fallback`, two fresh prices of similar dates are compared and flagged `divergent` (never averaged). **What is still true**: without the key nothing changed; the 53 other symbols (every wrapped, staked or bridged representation) have one source; the two sources are two aggregates of largely the same exchanges, not independent raw data; with the default budget (100 credits a day) the second list is up to 30 minutes old and comparable with CoinGecko about a third of the time; the provider reports no remaining balance, so the wallet's counter is its own; no swap or plan test covers the fallback case | `docs/V11-MARKET-DATA-SOURCES.md` §2, `w/apibricks` | a valuation outage is covered for 42 symbols when the key is set; for the others every route is still `no_market_reference` | the owner sets the key and a budget after reading the balance in the provider's console; a paid tier for a fresher second list; a mapping for more symbols needs evidence the provider does not publish | O, E | — |
| 7.3 | **0x and 1inch: no live call was ever made** (no key); fixtures are documentation-derived; whether 0x's `buyAmount` is net of fee, 1inch's error bodies and HyperEVM support unverified; **terms of use not read**; rate limits guessed | `w/stab-swaps` §9 | quote-only comparison sources of unknown accuracy | keys + a recorded smoke; read the terms | O, E | — |
| 7.4 | Execution evidence unchanged from V10: Jupiter proven by mainnet simulation only; CCTP and KyberSwap on most networks by forks only; one real KyberSwap swap and two real sends on Ethereum (`docs/V11-AUDIT.md` §10) | not in V11 scope | — | real small swaps by the owner | O | — |
| 7.5 | LI.FI and Maya: quotes only; deBridge off (licence) | unchanged | — | — | — | — |
| 7.6 | No KyberSwap HTTP-level test of the quote reference (no scripted-chain suite for the EVM swap path); Solana-source CCTP has no dedicated replay test; rows written before V11 have no request fingerprint (kind compared only) | `w/stab-swaps` §3, §4 | — | tests | E | — |
| 7.7 | Not converted to codes: AgentFund withdrawal errors, PerpAgent / PerpAgentLive / Research reasons, Monitor details, HTTP error messages without a key, `bridge.delayReason` | outside the list given | English sentences in the French UI in those places | conversion | E | — |
| 7.8 | CSV: a consumer expecting `send` for swaps and bridges sees the real kind and three more columns | intended (`w/stab-swaps` §6) | breaking for an external script | — | O (know) | — |
| 7.9 | Execution status: timestamps the wallet does not record are null; a relayed approval of a proposal that ended otherwise is `unknown`; `not_broadcast` reads `failed / broadcast_disabled`; "effective slippage" needs a CoinGecko price for both sides | `w/stab-swaps` §7, §8 | — | — | E | — |
| 7.10 | Audit hygiene untouched: B8 (stream errors lose their code, UI side), B9 (dead cache key, constant `executionEnabled`, three slippage bounds, `/portfolio` fallback, stale README), SSE answers bypass the security-header hook | `w/stab-swaps` "Not done" | low | — | E | — |

---

## 8. Quote engine

| # | What | Why | Impact | Closes it | Who | Blocks |
|---|---|---|---|---|---|---|
| 8.1 | **Safari / iOS never run** (Chromium only); the CSP names the websocket origin for the old Safari behaviour | `w/quotes` §0 | the phone-first PWA's main browser is unverified for the stream | a run on the owner's phone after deployment (fallback to polling exists) | O | — |
| 8.2 | One process: no cross-process fan-out; with a separate agents worker each process has its own hub and venue connections (Hyperliquid allows 10 per address) | in-process design | — | — | — | — |
| 8.3 | Candles streamed by Hyperliquid only; edgeX / dYdX bid-ask only while a book is open in the hub; dYdX quotes sparse (5 / min on BTC); Hyperliquid `l2Book` every 5–12 s; GMX one quote per ≈ 6 s; spot streamed from Coinbase only — the other symbols are polled (CoinGecko list; or API Bricks every 5 minutes for at most 30 polls a day when its key is set, `down: quota` after that; its WebSocket is verified but not integrated), CAD is a conversion; `venueTs` null where the venue gives none | `docs/V11-QUOTE-ENGINE.md` §13 | "live" differs by venue; labelled | — | X | — |
| 8.4 | Fallback detected by failure (three attempts, ≈ 4 s), not announced by the server | `w/quotes` §4 | — | — | E | — |
| 8.5 | Home and the asset page overlay not exercised in the browser run (the throw-away stack has no signer); component rendering tested through the store (no DOM in the web tests) | `w/quotes` §5, §6 | — | UI pass | E | — |
| 8.6 | Caddy closes websockets on a config reload unless `stream_close_delay` is set (not set; a production change) | `docs/V11-QUOTE-ENGINE.md` §11 | every client reconnects at each `mlt` / Caddy reload | owner decision | O | — |
| 8.7 | Load test ran on the development laptop with clients on the same host; no soak | `w/quotes` §B | production capacity unmeasured | soak on the API node | E | — |

---

## 9. Private markets

| # | What | Why | Impact | Closes it | Who | Blocks |
|---|---|---|---|---|---|---|
| 9.1 | **The Anthropic entries of the reviewed contract table expire at 2026-11-18T00:00Z** (`io:ANTH`, `para:ANTH`, `xyz:ANT`, `edgex:ANTHROPICUSDC` — `services/api/src/private-markets/contracts.ts`, `ANTHROPIC_IPO`). From that instant they show "definition under review" and **no valuation** | the IPO is reported for pricing on 18 Nov and first trade on 19 Nov 2026: oracle, methodology or unit may change | a deployment after 18 Nov shows Anthropic without valuation — by design | re-read the operators' documentation and the live annotation, update the table | E | — |
| 9.2 | `xyz:OURA` expires 2026-12-01 (end of grace period); other entries 2026-12-15 (30-day review) | same mechanism | same | periodic review | E | — |
| 9.3 | No fully diluted share count → no valuation from per-share contracts; edgeX → none (weak fingerprint, no published definition); OpenAI reference is a medium-confidence report (2026-11-06); Moonshot AI has none; references are a dated copy (2026-11-15) | `w/private-markets` §2–4 | valuation only where `formulaSource` exists | sourced figures | X, E | — |
| 9.4 | Aster, Lighter, Polymarket Perps and centralised exchanges not read (no adapter); Polymarket `ANT-USD` rebases on 16 Nov 2026 | `docs/V11-SYNTHETIC-MARKETS.md` §7 | incomplete inventory | adapters | E | — |
| 9.5 | Contract terms, reasons and company notes are the operators' English sentences; on a phone the trade-area tabs wrap in French | `w/private-markets` §6 | — | UI pass | E | — |
| 9.6 | No transient `null` of `perpAnnotation` could be reproduced live (the retry test replays recorded bodies) | `w/private-markets` §1 | — | — | — | — |

---

## 10. Web / interface

| # | What | Source |
|---|---|---|
| 10.1 | **Never exercised in a browser**: the Swap screen changes (hero, route cards, `quote_moved`), Home banner and freshness, Activity, the plan screen, the execution timeline (`w/stab-swaps` "Not done"); the edgeX notices and texts — "the least verified part" (`w/edgex` §6); the resume / re-base passkey step of the live order panel (`w/stab-signer` §8); the mandate form and the live two-prompt approval on the Risk screen (`w/exec2` §10); `PerpAgentLive.tsx` two-prompt flow beyond the request sheet (`w/agents-bind` §6) | work notes |
| 10.2 | Exercised in a browser (Chromium, local stacks): Developer (`developer.spec.ts`), Risk — banner, limits form, kill switch (`risk.spec.ts`), Agents panel template → backtest → paper → request live → pause → stop (`agents-bind.spec.ts`), Markets / terminal / Compare / Private Markets live cells (`v11-quotes-live.mts`), Private Markets against fixtures | work notes |
| 10.3 | **v9 / v10 visual baselines not regenerated**: Swap, Futures (a third then fourth entry in the trade switch), Markets, Compare have no baseline; the full Playwright suite was not run on the merged `v11` by any workstream | `w/stab-swaps`, `w/markets-compare` §4 |
| 10.4 | `/risk?mandate=<id>` is not read by `Risk.tsx` (verified in code: no `location.search`); an agent's strategy hash is typed by hand in the mandate form; unused `rk` keys remain | `w/agents-bind` item 1; `w/exec2` §10 |
| 10.5 | No web form for the live account policy, the GMX halt and limits, key editing, `recover` | `w/stab-signer` §5, §8, §9; `w/trading-api` §7 |
| 10.6 | Dev mocks do not serve `/markets-hub` and list no edgeX instrument; no watchlist; journal and signals shown through one timeline | `w/markets-compare` §4; `w/edgex` §6; `w/agents-bind` §6 |
| 10.7 | First JS chunk grew from 257 kB (audit) to 262.35 kB on the merged tree (`w/quotes` §8) | work notes |

<!-- PENDING: final interface pass (branch v11-ui) — which rows of 10.1–10.6 it closed, the browser runs it made, and the regenerated baselines -->

---

## 11. Performance and operations

| # | What | Why | Impact | Closes it | Who |
|---|---|---|---|---|---|
| 11.1 | **V11 is not deployed**; the deployment of `sp-wallet-agents` is documented, not done; no PM2 / mld deployment was verified | by instruction | — | `V11-DEPLOYMENT.md` | O |
| 11.2 | **Production values of the locks were never read** (audit B-03; the runbook no longer gives an "expected" line) | the audit had no production access | unknown whether mainnet locks are on today | `scripts/preflight.sh --env-from-pm2 sp-wallet` (names only) + the start-up line | O |
| 11.3 | The start-up capability line does not list `SPW_TRADING_API_EXECUTION` or `SPW_DERIV_MM_MAINNET` (`capabilities.ts` has nine entries); the first is shown on the Risk screen and in `/developer/status` only | not added | a lost or unintended value of these two is not visible in the log | add two capabilities | E |
| 11.4 | The deploy runbook does not mention the new locks, the pepper file, the websocket, `dist/agents.mjs`; `scripts/preflight.sh` does not check them | not extended | covered by `V11-DEPLOYMENT.md`, not by the runbook | edit the runbook and the script | E |
| 11.5 | No metrics endpoint; logs mostly free text (structured for the stream); no request id (audit §8) | not in scope | — | — | E |
| 11.6 | The signer journal grows by one record per signed action; a quoting session writes several per second at the compiled maximum (rotation at 8 MB exists) | `w/mm-core` §2.8 | disk on the signer node | monitoring | E |
| 11.7 | `order_events` is append-only by trigger: a restore or manual repair of that table needs the trigger dropped first; four queue triggers add one insert per engine write | `docs/V11-SECURITY-REVIEW.md` item 7 | operations | runbook | E |
| 11.8 | The markets hub's 2.5 s budget is close to a cold first read of dYdX or Hyperliquid (≈ 1.2 s each on the laptop): the first request can list a venue in `errors`; a hanging venue delays the older all-venue routes by its adapter timeout | `w/markets-compare` §2; `w/edgex` §3 | first-load glitches | — | E |
| 11.9 | With a separate agents worker, the `orders` supervisor loop runs in the API process only: the API must be up for an UNKNOWN order to be settled | `docs/TRADING-AGENT-ENGINE.md` | — | — | — |
| 11.10 | No soak test of the merged tree; no load test of the order path | — | unknown under sustained load | soak | E |

<!-- PENDING: final full-suite totals, e2e matrix, soak (see V11-TEST-RESULTS.md) — add here any limitation the final run reveals -->

---

## 12. Tests

| # | What | Source |
|---|---|---|
| 12.1 | Known flaky tests: `api.test.ts › swap: quotes are for the wallet's own addresses` and two usage-log reads (fire-and-forget inserts read at once) — given bounded polls in `23c0a23`; "three runs do not prove they cannot" recur. `agent-worker-process.test.ts` timed out once in six full runs under load — **not fixed** | `w/contract-resync` Part 3 |
| 12.2 | Laboratory-dependent suites are skipped in a checkout without `research/.venv` (3 files, 67 tests in the last runs; 59 earlier); one `perp-agent` test fails without the lab interpreter | every work note |
| 12.3 | The TypeScript suites were not run by the lab workstream; the lab's parity test failed on `v11` after the agents merges until `3d763db` updated the pinned line numbers — it will fail again whenever a pinned default moves (`engine-parity.json` matches `path:line`) | `w/quant-lab` §5.7, §6; `w/agents-bind` verification; `git log` |
| 12.4 | Tests that read source text or SQL (mode filter scan, "nothing can release the kill switch") can be escaped by a query built outside a `sql` template | `w/agents` §2 |
| 12.5 | Declared-not-provoked answers: see 6.5; `execution_disabled` in the contract test | `w/contract-resync` |
| 12.6 | What no test of any kind covers is listed line by line in `TRADING-TEST-RESULTS.md` | — |

---

## 13. Deferred audit findings (V10 audit, not in any V11 scope)

B-03 production values (11.2) · B-09 signer-side limits in manual mode and on GMX (3.9) · B-15 resting orders after
revocation (2.13) · B-16, B-17 (4.6) · B-19 (2.12) · B8 UI side, B9, SSE headers (7.10) · single price source (7.2 — a second,
optional, keyed source now exists for 42 symbols; not enabled in production) ·
no metrics (11.5) · research runtime unverified (5.14). Source: `w/stab-signer` "Not in this branch"; `w/stab-swaps`
"Not done".

---

## 14. Where the work notes disagree, and which is current

| Topic | Earlier note | Later note | Code on `v11` |
|---|---|---|---|
| STOP ALL AGENTS and spot agents | `w/exec2` §7, `docs/V11-EXECUTION-ENGINE.md` §8.9: spot agents cannot be stopped | `w/agents-bind` item 8: every trading agent through `agents/control.ts` | `services/api/src/agents/control.ts` exists — **later note is current** |
| A live spot agent's sale under the kill switch | `w/exec2` §5, `w/exec2-notes-agents` §2: refused | `w/agents-bind` §2: signed (`reducesRisk`) | `signer-client.ts` `beforeMandateSign(o?: { reducesRisk })` — **later note is current** |
| Release of the agents' kill switch | `w/agents` "Not done": owner session only | `w/agents-bind` §2: one switch, passkey only | route removed — **later** |
| Trading API write side | `w/trading-api`, `w/sdks`: 12 writes answer 501; `mandate_id` unchecked; key limits recorded, not enforced | `w/exec`, `w/exec2`, `w/contract-resync` Part 2: 41 operations implemented; binding verified | `orders/service.ts` `keyLimits`; `mandates.verifyKeyBinding` — **later**. `docs/TRADING-API-SECURITY.md` §5 still carries the earlier text |
| Owner spot, live GMX, attached SL/TP through the API | `w/exec` §8: not done | `w/exec2` §5–7: done | **later** |
| Lab strategies and live-capable versions | `docs/TRADING-AGENTS-AUDIT.md` D1 and `docs/TRADING-AGENT-ENGINE.md` §11: not merged, only `pairs_coint_perp` live-capable | `w/agents-bind` §4: templates bound to `momentum_xs_perp/2`, `mean_reversion_bands_perp/2` | **later** (the two documents' passages are stale) |
| SDK stream exports | `w/quotes` §7, `docs/V11-QUOTE-ENGINE.md` §13: not exported | `w/contract-resync` Part 3 §1: exported | **later** |
| OpenAPI mismatches | `w/sdks` list of 12; `w/contract-resync` Part 1 and 2 lists | Part 3 list (10 items) "replaces" them | Part 3 is current |
| `/risk` route | `w/agents` §9: not a route yet | `w/exec` §9: Risk screen | exists; the `?mandate=` parameter is still not read (10.4) |
| Stream message types vs the server | `w/quotes` §2, §7: "SDK drift tests" | `w/contract-resync` Part 3 list #9: "no test compares them with the server's" | a sample-based test exists in TypeScript (`stream.test.ts`, `ServerMessageSchema.safeParse` on the SDK's samples); Python checks the book vectors only — **both notes are partly right**; there is no generated contract (6.5) |
| Lab parity test | `w/agents-bind`: fails on `v11` | commit `3d763db` "Lab engine parity: line references follow the engine files" | fixed in git; not re-run here |

**Not resolved from the code:** none of the above. Two things could not be settled by reading alone and are stated as
uncertain where they matter: whether production runs with the mainnet locks on (11.2), and how V10 code behaves on a
database that holds V11-only rows after a rollback (`V11-DEPLOYMENT.md`, "Rollback").
