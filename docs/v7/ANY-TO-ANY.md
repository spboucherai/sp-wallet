# V7 — Any-to-any swaps: plans of executable legs

The owner picks a source asset on one network and a destination asset on another; the wallet finds a **plan** — a short
sequence of operations it can already execute and verify — and executes it one leg after the other, each leg approved with
the passkey when its turn comes.

**A plan is never a new trust path.** It adds no bridge, no router, no provider-built cross-chain transaction and no new
signer capability. Every leg is one of the four existing operations, prepared through the same API route the owner would use
by hand, with the same signer verification:

| Leg | Operation | What the signer verifies itself | Code |
|---|---|---|---|
| swap (EVM) | KyberSwap, same network, 8 networks | pinned router bytecode, decoded calldata: recipient = wallet, amount, minimum output | `packages/core/src/swap-evm.ts`, `services/api/src/swap-exec.ts` |
| swap (Solana) | Jupiter (Metis) | decoded v1 transaction: programs, accounts, amounts, minimum output | `packages/core/src/swap-sol.ts`, `services/api/src/swap-exec-sol.ts` |
| bridge | Circle CCTP V2, native USDC, 7 EVM networks — and, since v8, Solana ↔ each of them (§5) | builds burn and mint itself; wallet → wallet; the mint must match the approved burn | `packages/core/src/cctp.ts`, `services/api/src/bridge.ts`; Solana: `packages/core/src/cctp-sol.ts`, `cctp-sol-tx.ts`, `services/api/src/bridge-sol.ts` |
| xswap | THORChain native swap | builds memo and transaction itself; vault confirmed by its own THORNode operators | `packages/core/src/thorchain.ts`, `services/api/src/xswap.ts` |

New code: `packages/swap/src/plan.ts` (pure planner), `services/api/src/plan-state.ts` (pure saga state machine),
`services/api/src/plan-exec.ts` (routes + worker tick), `apps/web/src/plan.tsx` (UI). Nothing in the signer changed for V7.
(v8 added the Solana side of the CCTP leg to the signer — a leg, not a plan capability: §5.)

## 1. What is executable today

The **hub** is native USDC: the only asset a plan rests in between two legs. Plans have at most three legs, never visit a
network twice and never chain two legs of the same kind.

Shapes: `swap` · `bridge` · `xswap` · `swap → bridge` · `bridge → swap` · `swap → bridge → swap` · `xswap → swap` ·
`swap → xswap` · `xswap → bridge` · `bridge → xswap` · `xswap → bridge → swap` · `swap → bridge → xswap`.

Matrix by network family (source in rows, destination in columns):

| from \ to | EVM with CCTP¹ | BNB Chain | Bitcoin / Litecoin | Dogecoin | Solana | other networks² |
|---|---|---|---|---|---|---|
| **EVM with CCTP¹** | **yes** — up to swap → CCTP → swap | same network only | **yes** — (swap →) CCTP to Ethereum → THORChain³ | **yes**, same route³ | **yes** (v8, §5) — (swap →) CCTP to Solana (→ Jupiter) | no |
| **BNB Chain** | same network only (no CCTP there) | **yes** — one swap | no | no | no | no |
| **Bitcoin / Litecoin** | **yes** — THORChain to Ethereum (→ CCTP → swap)³ | no | **yes** — THORChain BTC ↔ LTC | **yes** — THORChain | **yes** (v8) — THORChain to USDC on Ethereum → CCTP to Solana (→ Jupiter)³ | no |
| **Dogecoin** | no — destination only⁴ | no | no | — | no | no |
| **Solana** | **yes** (v8, §5) — (Jupiter →) CCTP from Solana (→ swap) | no | **yes** (v8) — (Jupiter →) CCTP to Ethereum → THORChain³ | **yes** (v8), same route³ | **yes** — one Jupiter swap | no |
| **other networks²** | no | no | no | no | no | no |

¹ Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, HyperEVM: KyberSwap swaps and CCTP between any two of them.
² Tron, XRPL, Stellar, Aptos, Cosmos, Sui, NEAR, TON, Bitcoin Cash: send and receive only; no executable swap leg exists.
³ THORChain legs use the pinned assets only: BTC, LTC, ETH, and USDC / USDT / DAI / WBTC on Ethereum. A plan enters or leaves
THORChain through **USDC on Ethereum** (or directly through the pinned asset when it is the source or the destination).
Each THORChain leg has a minimum amount below which a refund could not pay its own fee; with the wallet's limits
(about 50 USD per transfer) and Bitcoin fees, small amounts may be refused at planning with `below_minimum`.
⁴ THORChain asks 750 000 koinu per byte for a Dogecoin inbound, far above the wallet's fee ceiling, which is not raised.

A pair without a plan is answered with a reason, never with a faked route: `network_without_execution` (which network),
`no_executable_path` — and `solana_evm_bridge` only where the Solana CCTP leg is not among the capabilities (it is, since
v8: `GET /api/v1/plans/capabilities` lists `solana` under `cctp`). The three-leg limit still applies: BNB Chain ↔ Solana has
no path (no CCTP on BNB Chain), and Dogecoin stays a destination only.

Quotes from providers the wallet cannot execute (LI.FI, deBridge when enabled, Maya) stay on the Swap screen, each labelled
**"Comparaison seulement / Comparison only"** — also, and explicitly, when one of them guarantees more than the best plan.

## 2. The plan model and its guarantees — stated honestly

**Planning** (`POST /api/v1/plans/quote`, signs nothing, stores nothing). Every candidate shape is priced with **real quotes
for every leg**, from the provider that will execute the leg, with the wallet's own addresses at both ends:

- amounts chain: leg *k+1* is quoted twice — on what leg *k* is **expected** to deliver and on the **minimum** it guarantees.
  The plan shows both ends: **"attendu"** (every leg at its quote) and **"garanti au pire"** (every leg at its minimum);
- every cost is itemised per leg: provider or protocol fee, CCTP fee (Standard: 0 today; Fast: Circle's live schedule),
  network fee on each network in that network's coin, the destination gas the wallet must already hold for the CCTP mint,
  THORChain's liquidity and outbound fees (already deducted from its output);
- time per leg (the provider's estimate; a rough constant for a same-network swap, shown as an estimate);
- constraints, each one blocking the start when unmet: the source balance; **the per-transfer and daily limits of each
  leg's own asset** (a three-leg plan consumes limits on up to three assets — e.g. `arbitrum:LINK`, `arbitrum:USDC`,
  `base:USDC`); provider minimums; **the coin of every network involved**, with exactly how much is missing where.
  The wallet cannot send itself a network's coin from another network: the UI says so and links to Receive;
- ranking: startable plans first, then the highest **guaranteed worst case**, then the highest expected result, then time.

**What is guaranteed, and what is not.**

| Guaranteed | Not guaranteed |
|---|---|
| Each leg, **at the moment it is approved**: its recipient is the wallet's own address, its amount and its minimum output are fixed in the approved intent and enforced by the signer and by the contract. | The **end-to-end** minimum. "Garanti au pire" is computed from the quotes of the moment; prices can move between two legs, and a later leg is quoted again when its turn comes. |
| Nothing is approved without the passkey: one approval per leg; the plan itself cannot sign, approve or broadcast. | That a later leg will be possible at all (its limits, gas, liquidity and provider are checked again when it is prepared). |
| Between two legs the funds are an **ordinary balance at the wallet's own address** (USDC on the hub network). Abandoning a plan locks nothing. | A total duration: a CCTP attestation or a THORChain outbound can be late; the plan waits. |
| The owner's **overall floor**, if set: before every leg the final result is estimated again from what is really held, with fresh quotes; below the floor, nothing is prepared and the plan pauses. | That the floor is met by the final leg's *execution*: the floor compares an estimate; the last leg's own approved minimum is the hard bound. |

**Execution** (saga, `services/api/src/plan-exec.ts`). A `plans` row holds the legs with their state, the amounts planned
and the amounts that really happened, the current step and where the funds are.

1. `POST /api/v1/plans` stores the plan after pricing and checking it again. Nothing is prepared: leg 1 is `ready`.
   One plan is open at a time.
2. `POST /api/v1/plans/:id/prepare` (the leg must be `ready`): reads the balance, sizes the leg on **what the plan holds —
   the amount actually received from the previous leg, never the estimate, never more than the wallet has**; estimates the
   final result through the remaining legs and checks the floor; then calls the ordinary route for that leg
   (`/swap/proposals`, `/bridge/proposals`, `/xswap/proposals`) inside the same session. That route applies all of its own
   checks (pinned bytecode, simulation, limits, one operation in flight per network, minimum output) and returns the
   proposal and the passkey challenge.
3. The owner approves with `POST /transfers/proposals/:id/approve`, exactly as for a single operation.
4. The worker (`plans` loop) only **reads** the proposal: a swap is settled when it is mined deep enough *and* the amount
   received was read from the chain; a CCTP transfer when the destination minted; a THORChain swap when the wallet's own
   data sources saw the outbound. Then the next leg becomes `ready` and the alert `plan.step_ready` is raised.
5. The plan state is plain JSON in the database: it resumes after a restart, days later, exactly where it was.

**Recovery.**

- An approval window that ran out: the leg is simply `ready` again.
- A leg refused at preparation (limit, missing gas, router no longer the reviewed one, simulation failing…), refused at the
  last gate before broadcast (the approved swap would no longer deliver its minimum), declined by the owner, failed on chain, or refunded by THORChain: the plan is **paused**, with the reason
  and where the funds are. Options: **réessayer** (the same leg, re-quoted), **re-planifier depuis l'actif actuel** (a new
  route from the asset held to the same destination; settled legs are kept), **arrêter ici** (final; the funds stay where
  they are). "Not now" answers (another operation in flight on that network, provider or RPC unavailable) do not pause.
- A CCTP leg whose mint is late or reverted is handled by the existing bridge flow ("finish", passkey for a new mint): the
  USDC stays mintable to the wallet with no deadline, and the plan waits.
- A plan cannot be stopped while a leg is in flight; an unused approval request is withdrawn first.

## 3. Costs

Per leg, as shown on the plan card: swap — network fee (plus the token approval transaction for a token input), no
wallet fee, KyberSwap/Jupiter take no fee from this integration; CCTP — Circle's fee (0 for Standard today, a fraction of a
basis point to a few for Fast), network fee for the burn on the source and for the mint on the destination, **paid by the
wallet in the destination's coin**; THORChain — liquidity fee and outbound fee, both deducted from the output, plus the
source transaction fee. A plan costs one passkey approval per leg and, compared with a single-transaction bridge
aggregator, more network fees and more time; in exchange every transaction is one the signer rebuilt or decoded itself.

## 4. Alerts

`plan.step_ready` (a step waits for the passkey), `plan.paused` (with the reason; funds stay in the wallet), `plan.done` —
catalogued in `packages/core/src/alert-catalog.ts`, derived from the audit chain by `services/api/src/alerts/rules.ts`.
Tapping one opens `/plan/<id>`.

## 5. Solana ↔ EVM: executable since v8 (2026-11-11)

V7 shipped without this leg and listed why (the list is kept below, with what became of each point). V8 adds it:
**USDC between Solana and each of the seven EVM networks, in both directions, through Circle CCTP V2** (Solana = domain 5),
with the guarantees of the EVM leg — the signer builds every transaction itself from the approved intent, wallet to
wallet, one passkey for the burn and exactly one mint. The dossier, the evidence and the strict "not verified" list are in
`docs/swap/providers/cctp.md` §13; the proof script is `scripts/sim-solana-cctp.mts` (mainnet simulation + a local fork).

| Obstacle listed in V7 | Answer in V8 |
|---|---|
| `deposit_for_burn` needs a second signer: a fresh keypair for the event account | The **signer generates it itself**, at signing time, uses it for that one signature and drops the secret; only the public key is recorded with the bridge. Sound because the program never needs that key again: `reclaim_event_account` is signed by the **rent payer** (the wallet) alone — read in Circle's source and IDL, seen on real reclaims. The API cannot supply the account: any helper data on a bridge is refused. |
| Its rent can only be reclaimed after five days | Measured: **0.00282448 SOL** (428 bytes). Counted inside the approved fee ceiling (and the policy's 0.003 SOL ceiling), shown before approval as a **refundable deposit with its date**; "Récupérer le dépôt" appears after five days — passkey each time, only for the account recorded with that burn, simulated before and after signing. |
| New signer-side builders and verifiers for two Anchor instructions; pin the two programs | `cctp-sol.ts` / `cctp-sol-tx.ts`: `deposit_for_burn` (18 accounts), `receive_message` (20 — one more than Circle's page lists), `reclaim_event_account`, all accounts derived from pinned ids and seeds; the encoders reproduce real mainnet instructions **byte for byte**. Both programs pinned like Jupiter's (ProgramData, slot, authority, executable hash, two RPC endpoints). They are upgradeable by a key: said in the dossier. |
| With Solana as destination, `mintRecipient` is the wallet's USDC token account, which must exist | The signer derives the associated token account from its own key and puts **that** in the burn (never the wallet address). The API **refuses to burn** toward an account that does not exist and offers to create it first (one small passkey-approved transaction, deposit 0.00148844 SOL shown); it also requires the SOL the mint will cost. |
| `messageSender` of a Solana-sourced message is not stated in Circle's docs | Established: it is the **wallet's Solana public key** — the `owner` signer of the instruction, not the token account and not the fee payer. Source line, eight real attested messages from seven wallets (three paid by a third party), and the message our own simulated burn stores. The header `sender` is the token-messenger **program id**, which is what the EVM contracts have registered for domain 5. |
| The proof must be a mainnet simulation | Done, both directions, plus the EVM halves on a fork: the signer-built burn succeeds on mainnet and stores exactly the expected message; that message is minted by the real EVM contracts on a fork; the signer-built `receive_message` succeeds on mainnet **with a real Circle attestation**; the reclaim and the token-account creation succeed on mainnet. Nothing was sent. |

What changes for plans: `planCaps().cctp` lists Solana, so the planner enumerates e.g.
`SOL → [Jupiter] → USDC → [CCTP] → USDC on Base → [KyberSwap] → cbBTC`, `USDC (Arbitrum) → [CCTP] → USDC (Solana) → [Jupiter] → JUP`,
or `BTC → [THORChain] → USDC (Ethereum) → [CCTP] → USDC (Solana) → [Jupiter] → SOL`. Each leg is prepared through
`/bridge/proposals` like any other CCTP leg, so everything of §2 applies. Specific to this leg:

- from Solana, Standard is attested in about 17 s and Fast in under a second (Circle's figures) — far faster than from
  Ethereum or the L2s;
- a plan whose CCTP leg starts on Solana needs SOL for the fee **and the refundable deposit**: the plan card lists the
  deposit among that leg's network fees (as the quote adapter reports it) and counts it, with the usual margin, in the SOL
  required before starting. Reclaiming it later is done from the transfer's own details, not from the plan;
- a plan whose CCTP leg ends on Solana needs the wallet's USDC token account to exist: if it does not, preparing that leg
  pauses the plan with `token_account_missing` (nothing burned); create the account from the Swap screen, then "réessayer".

Not verified for plans: a full plan run with a Solana CCTP leg (the leg itself is proven; the planner and the plan routes
are covered by tests).

## 6. Proof

- `packages/swap/test/plan.test.ts` — enumeration, amounts chaining, limits per leg, missing gas, minimums, ranking,
  comparison-only quotes. `services/api/test/plan-state.test.ts` — the saga state machine.
  `services/api/test/plan-exec.test.ts` — the saga through the real routes, worker steps and signer boundary against scripted
  chains (a real CCTP leg walked to its mint; floor; refusal; expiry; re-preparation; re-plan; stop).
- `scripts/fork-plan.mts` (`npx tsx scripts/fork-plan.mts`, needs anvil) — two local forks, the API as its own process,
  real KyberSwap quotes and calldata, real CCTP contracts with test attesters on the destination fork only, a passkey per
  leg. Its output is reproduced in §7.
- `tests/e2e/qa-plan.spec.ts` — the UI against the real local stack with a virtual passkey; screenshots in
  `docs/v7/screens/plan-*.png`.

## 7. Fork proof output

Run of 2026-11-11 (`npx tsx scripts/fork-plan.mts`, exit 0). Leg 3's refusal: KyberSwap routes this size through
proprietary market-maker venues whose price cannot be moved by trading on a fork, so a pure price move (the router's
"Return amount is not enough") could not be produced on demand. The divergence between the live quote and the fork's market
is produced by removing, on the fork, the cbBTC inventory of the venues the approved calldata draws from. The gate
exercised is the one that catches a price move: the approved swap is simulated against the chain right before it is sent
(a token-input swap needs its exact-amount approval mined first, so this gate comes after the passkey).

```
forks: Arbitrum One at block 523218917, Base at block 55963135; throwaway wallet 0xCCbd351b8267d1BF2CF06292f786c968ED3C37aC
[fork only] Base fork: two TEST attesters enabled through the impersonated attester manager 0xdf265e0329f6a08a772b48191b33bdc624499b84 (threshold stays 2); Circle's real attesters cannot sign a fork-only burn
API process 11026 on http://localhost:8571 (workers stepped every 1.5 s), signer over HTTP, virtual passkey enrolled; wallet: 0.05 ETH on each fork, 6 LINK on Arbitrum

[A] planning
  executable legs: swap on solana, base, ethereum, arbitrum, polygon, optimism, bsc, avalanche, hyperevm; CCTP (USDC) between ethereum, avalanche, optimism, arbitrum, base, polygon, hyperevm; THORChain BTC@bitcoin, LTC@litecoin, DOGE@dogecoin (destination only), ETH@ethereum, USDC@ethereum, USDT@ethereum, DAI@ethereum, WBTC@ethereum
  ok   SOL (Solana) → USDC (Base): no plan, reason "solana_evm_bridge" — said, not faked
  ok   TRX (Tron) → USDC (Base): no plan, reason "network_without_execution" (tron)
  ok   6 LINK → cbBTC: 2 plan(s) priced, none startable; issues: limit_per_transfer step 1 6 LINK > 5 on Arbitrum One; limit_per_transfer step 2 61.672813 USDC > 50 on Arbitrum One; limit_per_transfer step 3 61.672813 USDC > 50 on Base
  ok   starting it is refused at planning (422 plan_not_startable): "this plan cannot start: step 1: 6 LINK on Arbitrum One is above the per-transfer limit of 5 LINK; step 2: 61.672276 USDC on Arbitrum One is above the per-transfer limit of 50 USDC; step 3: 61.672276 USDC on Base is above the per-t"
  ok   nothing was stored, nothing was prepared
  ok   no ETH on Base: every plan is refused before anything is signed — "gas_missing": about 0.000407840976 ETH needed on Base, 0 available

[B] a full plan: 3 LINK (Arbitrum) → cbBTC (Base)
  candidate: KyberSwap → Circle CCTP standard → KyberSwap — expected 0.0004179 cbBTC, worst case 0.00041373, ~1230 s, fees outside outputs ≈ 0.8277 USD, 3 approvals
  candidate: KyberSwap → Circle CCTP fast → KyberSwap — expected 0.00041784 cbBTC, worst case 0.00041367, ~98 s, fees outside outputs ≈ 0.8294 USD, 3 approvals
  ok   ranked by guaranteed worst case; chosen: KyberSwap: LINK (Arbitrum One) → USDC (Arbitrum One)  |  Circle CCTP standard: USDC (Arbitrum One) → USDC (Base)  |  KyberSwap: USDC (Base) → cbBTC (Base)
    KyberSwap: LINK (Arbitrum One) → USDC (Arbitrum One): in 3 (worst 3) → out 30.83834 (worst 30.684148); network 0.00001547592192 ETH@arbitrum
    Circle CCTP standard: USDC (Arbitrum One) → USDC (Base): in 30.83834 (worst 30.684148) → out 30.83834 (worst 30.684148); protocol 0 USDC@base (in output), network 0.00018315000018 ETH@arbitrum, network 0.000201 ETH@base
    KyberSwap: USDC (Base) → cbBTC (Base): in 30.83834 (worst 30.684148) → out 0.0004179 (worst 0.00041373); network 0.000002100486 ETH@base
    required before starting: 0.0003972518442 ETH on Arbitrum One (have 0.05); 0.000406200972 ETH on Base (have 0.05); limits: step 1 3/5 LINK, step 2 30.83834/50 USDC, step 3 30.83834/50 USDC
  ok   plan stored; first leg ready; no proposal exists yet (a leg is only prepared when its turn comes)
  ok   a second plan while one is open is refused (409 plan_open)
 leg 1 — swap on Arbitrum, passkey #1
  ok   settled: planned 30.83834 USDC (worst 30.684148), ACTUAL 30.831412 USDC = the wallet's balance on the fork (30.831412); the plan now holds USDC on Arbitrum
  ok   leg 2 is ready but NOT prepared: nothing moves without the owner
  ok   alert "plan.step_ready" raised through the alerts layer (subject: this plan)
 restart between legs
  ok   API process killed (pid 11026) and started again (pid 11834): the plan is where it was — step 2 ready, holding 30.831412 USDC
 leg 2 — CCTP Arbitrum → Base, passkey #2, attestation held back
  ok   the burn is sized on what leg 1 ACTUALLY delivered (30.831412 USDC), not on the estimate (30.83834)
  ok   attestation not available: burned on Arbitrum, not minted on Base; the plan WAITS (step 2 in flight, bridge "attesting", 1 poll(s) answered "not found")
  ok   attestation arrived: minted on Base; planned 30.83834, ACTUAL 30.831412 USDC; the plan resumes at step 3 (ready)
 leg 3 — the market moves away from the quote after the owner approved (passkey #3): the swap is NOT sent
  ok   prepared on the 30.831412 USDC actually received; approved minimum 0.00041579 cbBTC (expected 0.00041788); approved with the passkey
  ok   [fork only] before the approval was given, the calldata of the proposal was traced on the fork and the cbBTC inventory of every venue it can draw from was removed (0xb94b22332abf5f89877a14cc88f2abc48c34b3df, 0xbee3211ab312a8d065c4fef0247448e17a8da000, 0x8f10b468b06c6fd214b65f87778827f7d113f996): the fork's market can no longer deliver what the live quote promises
  ok   leg 3 REFUSED at the last gate — the approved swap is simulated against the chain right before it is sent, and it would not deliver: proposal "failed", plan PAUSED ("leg_failed") — "the swap would revert now (execution reverted: Call failed); it was not sent. The exact-amount approval stays in place for the next attempt"; the 30.831412 USDC are untouched on Base (only the exact-amount token approval was mined: allowance 30.831412 USDC, usable by this wallet's next attempt only)
  ok   while paused nothing can be prepared (409 bad_state)
 re-plan from the asset held (USDC on Base), passkey #4
  ok   re-planned from 30.831412 USDC on Base: the two settled legs are kept, a fresh last leg is quoted (expected 0.00041782 cbBTC, worst 0.00041573)
  ok   plan DONE: received 0.00041771 cbBTC on Base = the fork balance; this leg's approved minimum was 0.00041572
  planned vs actual, per leg:
    1. KyberSwap: LINK (Arbitrum One) → USDC (Arbitrum One): planned in 3 → out 30.83834 (worst 30.684148); ACTUAL in 3 → out 30.831412
    2. Circle CCTP standard: USDC (Arbitrum One) → USDC (Base): planned in 30.83834 → out 30.83834 (worst 30.684148); ACTUAL in 30.831412 → out 30.831412
    3. KyberSwap: USDC (Base) → cbBTC (Base): planned in 30.831412 → out 0.00041782 (worst 0.00041573); ACTUAL in 30.831412 → out 0.00041771
    whole plan at the start: expected 0.0004179 cbBTC, worst case 0.00041373; received 0.00041771
  ok   4 passkey approvals: one per leg, plus one for each attempt of the last leg that did not go through; the signer signed nothing else for the wallet except the one CCTP mint tied to the approved burn
  ok   no allowance left behind on the routers

[C] an overall floor: 15 USDC (Arbitrum) → cbBTC (Base), "bridge then swap", two approvals
  ok   a floor above the expected result is refused at the start
  plan: Circle CCTP standard: USDC (Arbitrum One) → USDC (Base)  |  KyberSwap: USDC (Base) → cbBTC (Base); expected 0.00020325 cbBTC, worst 0.00020223; floor chosen by the owner: 0.00019715 cbBTC (97 % of expected)
  ok   leg 1 settled: 15 USDC on Base; estimate before it: expected 0.00020325 cbBTC
  ok   before leg 2 the floor is checked: estimated 0.00018293 cbBTC < floor 0.00019715 → plan PAUSED ("floor"), nothing prepared, no passkey asked
  ok   "stop here": plan stopped; the 13.5 USDC stay on Base as an ordinary balance of the wallet's own address
  ok   a stopped plan prepares nothing

[audit]
  ok   audit chain intact; plan events: plan.created, plan.done, plan.paused, plan.replanned, plan.step_prepared, plan.step_ready, plan.step_sent, plan.step_settled, plan.stopped
  activity: swap 3 LINK finalized; bridge 30.831412 USDC finalized/done; swap 30.831412 USDC failed; swap 30.831412 USDC finalized; bridge 15 USDC finalized/done
  ok   the three plan alert kinds were raised by the alerts layer
  alerts raised: plan.done ×1, plan.paused ×2, plan.step_ready ×3
  per-transfer limits in force (untouched defaults): 5 LINK, 50 USDC

FORK PLAN TEST OK — nothing was sent to a real network; data read from outside is public (KyberSwap quotes and calldata, Circle fee schedule, prices)
```
