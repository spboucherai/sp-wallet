# V11 Phase B — stabilisation: signer, derivatives execution, mandates

Branch `v11-stab-signer`, from `v11` (`fe705be`). Source of truth: `docs/v11/audit-parts/derivatives-exec-signer.md`
(findings B-xx) and `docs/TRADING-AGENTS-AUDIT.md` §5, §8 (D2, D3, D4). Date: 2026-11-15.

Nothing here touched a production node, a funded account, a real order or a real transaction. The only network calls
made were three read-only requests to Kraken's public API (`SystemStatus`, `Depth` for two pairs) to read the shape of
its answers for item 10. Policy limit values, defaults and the policy version are unchanged; `policy.json` is never
rewritten by the new code.

Files not touched, as agreed: `apps/web/src/screens/Swap.tsx`, `services/api/src/{swap*,bridge*,xswap*,plan*,transfers,worker}.ts`,
`services/api/src/server.ts`, `services/api/src/db.ts` (no schema change: the new state lives in the existing `settings`
table and in existing JSON columns).

## Verification observed

| Check | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm test` (whole suite, after the last code change) | exit 0 — **124 files, 2 727 tests, all passed**, 61 s (baseline of the audit: 123 files, 2 682 tests) |
| `node scripts/build.mjs` | exit 0 — `dist/signer.mjs`, `dist/api.mjs`, `dist/research-runner.mjs`; the bundled `signer.mjs` was run by hand like the source (below) |
| Signer CLI, by hand, in a temporary directory | `init`; `halt` / `unhalt` with no daemon ("written to the state file"); `serve`; `halt` with the daemon ("applied by the running daemon: in force now"); `status` (`halted: true`, `journalIntact: true`); a second `serve` refused (exit 1, "in use by process …"); `unhalt`; `setup-token`; the lock file is gone after SIGTERM |

Earlier full runs on this branch, for the record: one with a failure of my own test (it depended on the state a
laboratory-only test leaves behind — fixed), and one where `lab-identity.test.ts` ("the sandboxed output is byte-identical…")
failed after 310 s while several suites and a build were running on the machine; that file passes alone (4 tests, 45 s) and
passed in the two full runs that followed. It runs sandboxed Python and touches none of the code changed here.

The worktree had no `research/.venv`; without it 59 tests are skipped and one (`perp-agent.test.ts`, "the laboratory itself
refuses the wrong contract") fails for lack of the Python environment (it passes once the environment is present; this
was not re-run on an untouched `v11` checkout). For the final run the main
checkout's virtualenv was symlinked into the worktree (never committed) so that the totals are comparable with the audit
baseline (123 files, 2 682 tests).

---

## 1. The emergency halt must never block a risk reduction (B-01)

**Initial state.** `signer/venue.ts` refused every manual Hyperliquid order under halt, reduce-only included;
`core/policy.ts` `checkPolicyNoSpend` refused GMX decreases and cancellations; the API refused them before that
(`gmx-exec.ts` `gate`). Only cancels and mandate reduce-only orders survived the halt.

**Change.**
- `/venue/sign`: under halt an order is signed only when the payload the trading key would sign is reduce-only — the flag
  is taken from the signer's own reading (`describe`), not from the API's description. Passkey, instrument, notional,
  daily count, client id, nonce and price rule apply unchanged. Leverage changes and orders that can open or add stay
  refused.
- `Signer.sign`, GMX: for a decrease or a cancellation the halt is no longer judged on the intent's word by the policy
  check; it is judged after `gmxPrepare` built the transaction, on `reducesOnly` (no collateral amount, no token
  approval, `MarketDecrease` parameters or a bare `cancelOrder`). `checkPolicyNoSpend` itself is unchanged and still
  applies everything else (policy version, window, fee ceiling, allowlist, amount = 0). The passkey is still required.
- API: `gate(needAuth, exit)` lets `prepareClose`, `prepareCancel`, a decrease and their approval through under the
  signer's halt; the API's own pre-check of the policy uses the same rule.
- Everything else stays blocked under halt: transfers, swaps, bridges, deposits, venue withdrawals, GMX increases, new
  authorizations and mandates (tests assert each). Vault returns to the owner were never halted (B-17, unchanged).
- The derivative-mandate path already behaved this way; it now shares the price rule of item 7 and is otherwise unchanged.

**Files.** `services/isolated-signer/src/{venue,venue-gmx,signer}.ts`, `services/api/src/derivatives/gmx-exec.ts`.

**Tests.** `venue.test.ts` "under the emergency halt a reduce-only order is still signed, with the passkey; whatever opens
or adds, and leverage, is refused" (also: no passkey, over the notional, far price, other instrument, a payload the API
calls reduce-only that is not, revoked authorization); `venue-gmx.test.ts` "enforces the daily count … the halt …"
(decrease and cancel signed under halt — calldata decoded: `sendWnt` + `createOrder` type 4, no `sendTokens` — bad passkey,
an intent that calls itself a decrease but sends collateral / is a `MarketIncrease` / carries an approval, an increase,
a cancellation with an order field, a market outside the policy, a plain transfer, a revoked authorization);
`derivatives-gmx.test.ts` "with both settings off AND the emergency halt on: a pending order is cancelled and a position
closed, with the passkey; an increase is refused at every step".

**Result.** Pass. **Limitation.** A venue withdrawal is not an exit under halt (as specified). Lifting the halt still
needs the signer machine.

## 2. API environment locks must not block exits (B-02)

**Initial state.** `exec.ts` `blocked()` answered `mainnet_disabled` for cancels too; the Hyperliquid adapter refused
every mainnet submission without `allowMainnetExchange`; `mandateLock` stopped mandate reduce-only orders; GMX `gate()` and
`advanceSend` stopped closes, cancels and an already signed close.

**Change.**
- `blocked(a, 'trade' | 'reduce' | 'stop')`: the mainnet lock applies to `trade` only. A reduce-only proposal, its
  approval and `close()` use `reduce`; cancels use `stop`. "Reduce-only" is not taken on trust: the risk engine refuses a
  reduce-only order that would open, increase or flip (`risk.ts` 5b), and the venue enforces the flag.
- `createHlTrading` gets `allowMainnetExits`: with the endpoint closed, `submit` still sends a cancel, or an order action
  whose orders are **all** reduce-only — read from the action itself. Leverage changes, agent approvals and any action
  with one non-reduce-only order are not sent.
- Mandate orders: a reduce-only order passes both mainnet locks; an order that can add, and a leverage change, do not.
  `mandateAccountState.canReduce` reflects it.
- GMX: `gate(..., exit)` skips the two settings for a decrease, a close, a cancellation and their approval;
  `advanceSend` only stops an **increase** when a setting was switched off after signing.
- Perp agent: its executor refused every order while the account was `blocked`, so an agent taken out of LIVE by a
  server lock stopped and left its position open ("1 position(s) REMAIN OPEN"). A reduce-only order now goes when the
  account can reduce: the agent closes its positions on the way out.
- `capabilities.ts`: the three summaries say what each lock closes and what still works.

**Files.** `services/api/src/derivatives/{exec,gmx-exec,live-venue}.ts`, `services/api/src/capabilities.ts`,
`services/api/src/agents/perp-exec-live.ts`, `packages/derivatives/src/venues/hyperliquid/trading.ts`.

**Tests.** `derivatives-live.test.ts` "with SPW_DERIV_LIVE_MAINNET off after positions exist: cancel, cancel-all and a
reduce-only close still work; a new order, a leverage change and a new authorization do not" (also: reduce-only on the
wrong side, reduce-only larger than the position, the adapter's own lock on a non-reduce order, a mixed batch, a
leverage change); the existing "mainnet with the server setting off" test, updated (a read-only account answers
`mode_read_only` for close / cancel-all, no longer `mainnet_disabled`); `derivatives-mandate.test.ts` "with either mainnet
setting off, a reduce-only mandate order and a cancel still reach the venue; an order that can add, and a leverage change,
do not" (three combinations of the two settings); `derivatives-gmx.test.ts` (item 1's test covers both settings off);
`perp-agent-live.test.ts` "owner halt, divergence, a manual order, the server lock: each takes the agent out of LIVE with its
own reason" (updated: with `SPW_DERIV_MANDATE_MAINNET` switched off the agent now closes its position with a reduce-only
order instead of leaving it open).

**Result.** Pass. **Limitation.** Collateral withdrawals stay behind `SPW_DERIV_LIVE_MAINNET` (`collateral.ts`, not in this
item). The fake venue of the tests stands in for the venue's own enforcement of reduce-only.

## 3. Spot mandates (D2, D3)

**Initial state.** The engine's `stop()` and the expiry branch only updated the `agents` row; `POST …/mode` PAUSED /
STOPPED left the mandate active; the signer accepted several active mandates on one vault. `POST /mandate/revoke` on the
signer already existed and already needed no passkey (the audit's request for a new endpoint was already met:
`signer/server.ts`, route `POST /mandate/revoke`) — what was missing was anyone calling it.

**Change.**
- Signer: `approveMandate` refuses a second mandate while one is unrevoked and unexpired on the same vault index
  (`conflict`). **Chosen: refuse, not supersede** — replacing limits must be a visible act (revoke, then approve), and it
  is the rule derivative mandates already follow. Per vault index, because a vault is the same key on every EVM network.
- API: `revokeAgentMandate` (engine stop on loss limit / strategy mismatch, expiry, owner's PAUSED / STOPPED / RESEARCH)
  revokes at the signer and never throws; `revokeStaleMandates`, at the start of every engine pass, takes the signer's
  own list and revokes every active mandate that no LIVE agent owns (a revocation that failed, an approval whose answer
  was lost — after a 120 s grace for an approval still being written). The approve route ends the agent's previous
  mandate before asking for the new one.
- **D3 — signer-enforced loss floor: not implemented, deliberately.** The signer reads no chain: it cannot establish a
  vault's balances without new trust assumptions (RPC providers in the key-holding process) and a new canonical mandate.
  The reasoning, what bounds a spot mandate today, the residual risk and the sound design for later are in
  `docs/V11-SECURITY-REVIEW.md`, "Spot mandate loss limit". The engine-side limit stays; with D2 fixed, tripping it now
  ends the mandate on the signer.

**Files.** `services/isolated-signer/src/signer.ts`, `services/api/src/agents/{engine,live,routes}.ts`,
`docs/V11-SECURITY-REVIEW.md`.

**Tests.** `mandate.test.ts` "a second mandate on the same vault is refused while the first is in force — also on another
network; never after revocation or expiry", "revoking is idempotent, needs no passkey, and an unknown id is an error";
`agent-networks.test.ts` (real signer over HTTP) "paused or stopped by the owner: revoked on the signer at once…", "the
signer refuses a second mandate on the vault; the approve route ends the previous one first…", "stopped by the ENGINE (loss
limit, strategy no longer the approved one, expiry): revoked on the signer by the engine itself" (also the signer
unreachable, then the next pass), "a mandate no agent holds … is revoked after the grace; a LIVE agent's mandate and a
just-approved one are left alone".

**Result.** Pass. **Limitation.** The revocation is done by the API: a compromised API that trips no limit revokes
nothing. Market loss inside a spot mandate is not bounded by the signer (D3 stands, documented).

## 4. A spot strategy is not approved on a failed look-ahead check (D4)

**Initial state.** `agents/routes.ts` approved any spot version that had a report.

**Change.** The approval requires `report.checks.lookahead === 'pass'` (a missing check is a refusal: `bad_report`, 409).
Perp versions keep their own, stricter rule.

**Files.** `services/api/src/agents/routes.ts`. **Tests.** `agent-networks.test.ts` "refuses a report whose look-ahead
check failed or is missing; approves one that passed".

**Result.** Pass. **Limitation.** `data_quality` stays advisory for spot (the finding's title mentions it; the task asked
for the look-ahead check). A strategy version approved before this change keeps its approval.

## 5. Orphaned venue authorization (B-04)

**Initial state.** A lost answer of `/venue/authorize` left the signer with an active authorization the API did not
know; the signer refused any other for up to 90 days; nothing could revoke it. Same shape for a derivative mandate.

**Change.**
- Signer: `POST /venue/authorization` returns again the stored answer of an authorization that is neither revoked nor
  expired (id, hash, agent address, the `approveAgent` action and signature made when the passkey approved it). No key
  signs, nothing is recorded.
- API: what is handed to the signer is kept (`settings`, key `deriv.live.submitted.<account>`) until the answer is seen;
  an unreachable signer answers `authorization_unknown` instead of pretending nothing happened;
  `prepareAuthorization` answers `authorization_orphaned` when the signer already holds an active one.
  `POST …/accounts/:id/authorization/recover`: an authorization that is exactly the one handed over (same id, same
  canonical hash) is adopted and the normal sequence resumes (venue approval, confirmation, MANUAL_LIVE); any other is
  revoked on the signer; nothing is adopted on mainnet while the mainnet lock is closed (it is revoked instead). The same
  call adopts or revokes a derivative mandate whose approval answer was lost.

**Files.** `services/isolated-signer/src/{venue,signer,server}.ts`, `services/api/src/derivatives/{exec,live-routes}.ts`,
`services/api/src/signer-client.ts`.

**Tests.** `venue.test.ts` "the stored answer of an authorization can be asked again: same bytes, no new signature, nothing
for a revoked, expired or unknown one"; `derivatives-live.test.ts` "the authorization the signer stored is adopted…", "an
authorization the API has no record of is revoked on the signer…", "a stored copy that does not match what the signer
holds is never adopted…", "a refusal of the signer leaves nothing to recover; adopting on mainnet respects the mainnet
lock"; `derivatives-mandate.test.ts` "is adopted when it is the very mandate that was submitted…; an unknown one is revoked
on the signer".

**Result.** Pass. **Limitation.** `recover` is an explicit owner action, not automatic. There is no button for it in the
web app yet (route only). GMX was already immune (its `revoke` walks the signer's list).

## 6. Signer state safety (B-05, B-06)

**Initial state.** CLI `halt` / `unhalt` / `reset-passkeys` / `setup-token` rewrote `state.json` under the running
daemon, whose next save undid them. The journal lived inside `state.json`, was never trimmed and was rewritten whole on
every logged request.

**Change.**
- `state.json.lock`: the daemon owns the state for its life; a second daemon or a writer under it is refused; a lock left
  by a dead process is taken over.
- `control.sock` (Unix socket in the signer's 0700 data directory, mode 0600): the four CLI commands are sent to the
  running daemon, which applies them in the same serial queue as signing requests. Without a daemon the CLI takes the lock
  and writes the file. Not reachable over the signer's HTTP surface: no route un-halts, resets passkeys or issues a setup
  token. The setup token never leaves the CLI (the daemon receives its hash).
- Journal: `journal.jsonl`, append-only, fsynced before `state.json` is replaced; `state.json` holds `journalRef` (last
  sequence number and hash) and an empty `journal`; rotation at 8 MB to `journal-<first>-<last>.jsonl`; a bounded window
  (1 000 records) in memory. The hash chain is the same one, unbroken across segments. A crash between the two writes
  leaves the journal ahead: it is taken as the head; a torn last line is cut; any other damage is a broken journal and
  the daemon refuses to start, as before.
- Compatibility: a pre-V11 `state.json` is read as it is (nothing is written on open); the first save moves its journal to
  the file; `policy.json` is read and never rewritten. A rollback to the older binary works on the V11 file; going
  forward again keeps what it journaled in `journal-rollback-<time>.jsonl`, whose last hash the main chain records.

**Files.** `services/isolated-signer/src/{store,control,main,server,signer}.ts`,
`services/isolated-signer/test/fixtures/{state,policy}-pre-v11.json` (written by the **old** store code, `git show
v11:services/isolated-signer/src/store.ts`, driven by the signer: an enrolment, a transfer, a denial, a mandate approved
then revoked, a venue authorization, a halt).

**Tests.** `store.test.ts` (new, 16 tests): journal file — "records go to an append-only file; state.json keeps only a
reference…", "nothing is written to the journal file before save()…", "keeps a bounded window in memory…", "rotation…",
"a crash between the journal append and the state write…", "a line cut by a crash while appending is dropped…; any other
damage is a broken journal"; old format — "is read as it is…", "the first save moves the whole journal to the file…", "a
crash in the middle of that first save is harmless…", "the signer built on it behaves as the old one did…", "an old-format
file with a live passkey: approvals still verify, counters and replay markers still bind…", "records appended to the state
by the old binary … are taken into the file…", "a rollback to the pre-V11 binary and forward again…"; lock and socket — "one
owner at a time…", "BEFORE V11 a CLI halt under a running daemon was undone by the daemon's next save — the scenario, and
why it can no longer happen", "the control socket takes the four commands and nothing else…".

**Result.** Pass; every pre-existing signer test passes unchanged on the new store. **Limitation.** Closed segments are
not re-verified at start (the current file and its link to the state are). The static fixture's passkey private key is not
in the repository, so "approvals still verify" is tested on an old-format file written in the test, not on the fixture.
`main.ts` itself (the CLI wiring) has no automated test: it was exercised by hand (table above).

## 7. TP / SL trigger band (B-07)

**Initial state.** Limit price and trigger price both had to be within `maxPriceDeviationBps` of the signer's mid, so a
stop 5 % away could not be placed under a prudent band; the API did not warn, the refusal came after the passkey prompt.

**Change.** One function, `venueOrderPriceError` (`packages/derivatives/src/live/canonical.ts`), used by `/venue/sign`,
`/venue/mandate/sign` and the API's pre-check. Rule:
- every order: limit / worst price and trigger within the band of the mid — the previous rule, still accepted first;
- in addition, **only for a reduce-only trigger order**: the trigger may rest on its protective side (a sell stop below
  the mid, a sell take-profit above; mirrored for buys) anywhere inside a sanity band of ÷3 … ×3 around the mid, and its
  limit / worst price must be within `maxPriceDeviationBps` of the **trigger**. A trigger on the side where it would fire
  at once gets no latitude.
- the API applies the same function against the venue's mark before storing the proposal (`price_deviation`); the signer
  applies it against its own Coinbase + Kraken mid.

**Files.** `packages/derivatives/src/live/canonical.ts`, `services/isolated-signer/src/{venue,venue-mandate}.ts`,
`services/api/src/derivatives/exec.ts`.

**Tests.** `venue.test.ts` "a reduce-only stop-loss or take-profit may rest away from the market; nothing else gains any
latitude" (4 accepted shapes; the same without reduce-only; fires-at-once on both sides and both types; outside and just
inside the sanity band; worst price far from the trigger; plain reduce-only limit; notional still counts the trigger; a
moved signer mid); `venue-mandate.test.ts` "price band against the signer's own price…" (extended); `venue.test.ts` "price
sanity…" (one expectation changed: the refusal is now about the worst price vs its trigger);
`derivatives-live.test.ts` "a reduce-only stop-loss far below the mark is proposed and signed; an entry trigger far away,
or a 'protective' order that would fire at once, is refused at the proposal".

**Result.** Pass. **Limitation.** The API's mark and the signer's mid are different numbers: an order at the very edge can
pass the API and be refused by the signer. The sanity ratio (3) is a constant, not an owner setting.

## 8. Loosening API-side limits or lifting an API-side halt needs the passkey (B-08)

**Initial state.** A session could set any of the API-only limits (`maxDailyLoss`, `maxTotalLoss`,
`minLiquidationDistanceBps`, `minFreeCollateral`, `maxDataAgeMs`, `maxMarkIndexBps`, `maxDeviationBps`,
`maxOrdersPerMinute`) and lift an owner halt; mandate orders inherit that policy.

**Change.** `loosenedFields(cur, next)` says which fields allow more (an unknown changed field counts). `setPolicy` applies
a tightening and refuses a loosening with `passkey_required`. `prepareRisk` stores one canonical intent
(`SPW-RISK-INTENT-v1`: kind, account, authorization id, the whole new policy or the halt / divergence being lifted, nonce,
5-minute expiry) and returns the WebAuthn request over its hash; `approvePolicy`, `resume` and `rebase` take the stored
intent once, check that it still describes the account, and verify the assertion. Re-basing a divergence is included: it
lifts the divergence halt. Halting, cancelling and tightening stay free. The assertion is verified by the **API**
(`auth.ts` `verifyOwnerAssertion`, against its `credentials` table): this is a check against a stolen session. It is not
the signer's judgement and nothing is signed on its strength — said in the ADR and the threat model.
Web: the resume and re-base buttons run the passkey step (`LiveOrderPanel.tsx`, `live.ts`); the mock answers "nothing to
approve".

**Files.** `services/api/src/derivatives/{exec,live-routes,live}.ts`, `services/api/src/auth.ts`,
`apps/web/src/derivatives/{live.ts,LiveOrderPanel.tsx,mockLive.ts}`.

**Tests.** `derivatives-live.test.ts` "loosenedFields: which changes allow more", "a session alone cannot raise the loss
limits; with the passkey over the prepared policy it can — once, and only that policy" (no assertion, another passkey, an
assertion over another hash or another policy, no user verification, replay, expiry, above the authorization), "halting is
free; lifting the halt needs the passkey over the intent that names that very halt" (a halt replaced meanwhile, re-base, a
server without a verifier), "over HTTP: /policy refuses a loosening, /policy/prepare + /policy/approve and /resume/prepare +
/resume carry the passkey"; `derivatives-mandate.test.ts` "the mandate order is checked against the account policy; raising
its loss limits needs the passkey".

**Result.** Pass. **Limitation.** Not a defence against a compromised API. There is no web form for the live account
policy (there was none before); the web change covers resume and re-base only and was not exercised in a browser here
(typecheck and the web unit tests pass).

## 9. GMX: real loss limits and the kill switch (B-10)

**Initial state.** `maxDailyLoss` / `maxTotalLoss` = 1e9, realised usage `'0'`, `halt: null`.

**Change.** `settings` key `deriv.gmx.risk`, bound to the authorization: daily and total loss limits (default 5 % and 20 %
of the allowed gross exposure — the fractions of a Hyperliquid account), and an owner halt. Realised PnL = base PnL minus
position fee of this wallet's executed orders, from the keeper's events already stored; unrealised PnL of **every** open
position is now valued (an increase is refused when a position cannot be priced). Both stop increases only. Tightening and
halting are free; raising a limit and lifting the halt need the passkey (`SPW-GMX-RISK-INTENT-v1`, same mechanism as
item 8). A new authorization starts from the defaults without a halt. Status exposes `risk` and the blocker `gmx_halted`.
Routes: `POST /derivatives/gmx/{halt, resume/prepare, resume, limits, limits/prepare, limits/approve}`.

**Files.** `services/api/src/derivatives/{gmx-exec,gmx-routes,gmx-live}.ts`, `apps/web/src/derivatives/gmx.ts` (type).

**Tests.** `derivatives-gmx.test.ts` "the limits are derived from the authorization…, counted on the wallet's executed
orders, and stop an increase — never a close", "tightening is free, raising a limit needs the passkey over the canonical
intent — once", "kill switch: halting is free and stops increases only; lifting it needs the passkey", "routes: /halt,
/limits (+ prepare / approve), /resume (+ prepare)".

**Result.** Pass. **Limitation.** A liquidation by GMX's keepers, funding and borrowing settled into collateral, and
anything done from another interface are not in the realised figure. `maxGrossExposure` (3×) and `maxPositionNotional`
(2×) of the GMX risk policy are still constants the owner does not choose. No web control for the halt or the limits yet.

## 10. Smaller items

| Item | Initial state | Change | Test |
|---|---|---|---|
| `Capabilities` (B-14) | `GMX_CAPABILITIES.orders: false`, `orderTypes: []` | `orders: true`, `orderTypes: ['market']`; the notes say the adapter is the read side | `gmx/adapter.test.ts`, `derivatives-api.test.ts` (updated) |
| Router `WALLET.gmx.trading = 'none'` (B-14) | — | **Not changed: the audit is partly wrong here.** `WALLET` is the fallback; when the GMX engine is tradable the route answers the engine's own verdict (`route.ts:113`, `gw?.wallet ?? WALLET[v.id]`; existing test "says the wallet can open a pinned GMX market when the engine is tradable") | — |
| Stale `MANDATE_LIVE` refusal (B-13) | "is not part of this delivery" | says that an authorization is always `MANUAL_LIVE` and that autonomous trading is a derivative mandate | `live.test.ts`, `venue.test.ts` (updated) |
| Kraken freshness (B-18) | no check; USDC priced from Kraken alone | a Kraken quote is used only while `SystemStatus` says `online` in an answer dated within 180 s of the signer's clock; only a positive answer is remembered (15 s) | `prices.test.ts` "a Kraken quote is used only while Kraken itself says it is online…" |
| `signer/server.ts` header comment (B-12) | "status, enroll, sign, halt" | describes the real surface and points to the ADR | — |
| Dead code | — | `DelegatedSigner` removed (no reference anywhere: `grep -rn DelegatedSigner packages services apps scripts tests`). **Kept, because they are used:** `createHlNonceSource` and `loadTrading` (`scripts/hl-testnet.mts`, `trading.test.ts`), `gmxAuthorizationHashHex` (`gmx-live.test.ts`), `GMX_PINS.simulationRouter` (`scripts/fork-gmx.mts`; also data of the reviewed pin table). `VenueTrading`, `orderHistory()`, the account streams and `deriv_orders.status` are interfaces or columns in use, not dead code to delete in a stabilisation | typecheck |

**Limitation of the Kraken check.** Kraken's ticker has no per-quote time; the status answer shows the exchange is
trading and that the answer is fresh, not that one pair's book moved. The two-source agreement (and the peg test for the
cash legs) remains the check on the price itself. One more request to Kraken per 15 s of use.

## 11. Documents

- `docs/adr/0001-custody.md`: the two false statements are replaced by "What the signer signs, and when it asks for the
  passkey": the six passkey-less paths with what bounds each, the requests that sign nothing, the halt, what only the API
  enforces.
- `docs/threat-model/threat-model.md`: rows 1, 4, 6, 19 rewritten; rows 20–22 added.
- `docs/runbooks/deploy.md`: the start-up line is no longer given as an "expected" line with production values — the rule
  is "the same as before the restart, unless the deployment meant to change it"; what each derivative setting closes since
  V11; first start of a V11 signer on an older data directory; rollback (do **not** restore an old `state.json`).
- `docs/runbooks/operations.md`: the halt commands no longer chain a restart; what the halt stops and what it never stops.
- `docs/V11-SECURITY-REVIEW.md` (new): "Spot mandate loss limit".

Not updated (outside the listed documents): `docs/security/acceptance.md` still says "mainnet only" (B-12).

## Not in this branch

B-03 (production values), B-09 (signer-side position / exposure limits in manual mode and on GMX), B-11 (order state
machine), B-15 (cancel-before-expiry), B-16, B-17, B-19: not in the scope given for this branch.

## For the reviewer before any deployment

Changes to what the signer accepts — each is the minimum for its item and has refusal tests, but each deserves a human
reading of the diff:

1. Under halt the signer now signs: a manual **reduce-only** Hyperliquid order (with passkey), a GMX **decrease** and a GMX
   **cancellation** (with passkey). `venue.ts`, `signer.ts`, `venue-gmx.ts`.
2. A **reduce-only trigger order** may carry prices outside `maxPriceDeviationBps` of the mid (manual and mandate paths),
   under the rule of item 7. `canonical.ts`.
3. New route `POST /venue/authorization` returns a stored `approveAgent` signature again, without a passkey.
4. `approveMandate` now refuses a second active mandate per vault (stricter).
5. The price source asks Kraken one more question; when Kraken reports anything but `online`, every mandate order and
   every venue order is refused (stricter, with an availability cost).
6. On-disk format: `journal.jsonl`, `journalRef`, `state.json.lock`, `control.sock`; the rollback note of the runbook.
7. The CLI's `halt` / `unhalt` / `reset-passkeys` / `setup-token` talk to the running daemon. `unhalt` is now effective
   without a restart — which is the point, and also means an operator command takes effect at once.
