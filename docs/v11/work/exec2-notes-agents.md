# exec2 — notes for the agents workstream

Written by the execution workstream (branch `v11-exec2`). Nothing under `services/api/src/agents/` was edited. Each
point below is something that now touches the agents runtime from outside, or a gap that only the agents runtime can
close.

## 1. A database trigger can refuse an insert into `agent_orders`

`services/api/src/db.ts`, function `spw_agent_order_gate`, trigger `agent_orders_gate` (BEFORE INSERT, each row). It
reads `settings['risk.switches']` (the global kill switch and read-only mode of `services/api/src/risk/service.ts`):

| Switch | Effect on an insert into `agent_orders` |
|---|---|
| read-only mode on | every insert raises `read_only_mode: …` |
| kill switch on | an order that BUYS risk raises `kill_switch_active: …`; a sale into the agent's cash leg passes |
| neither | nothing |

"Buys risk" is decided on the row: `new.from_symbol = agents.cash` (the agent spends its cash leg; `USDC` when the
column is null). It applies to PAPER and LIVE rows alike, because both engines insert the row first:

- paper: `agents/engine.ts` `tickAgent`, inside `sql.begin` — the transaction fails, so `agent_paper` is not changed
  either;
- live: `agents/live.ts` `placeLive` inserts the `prepared` row before `signer.mandateSign` — the signer is never asked.

What the runtime does with the error today (read, not changed): `agents/live.ts` `enginePass` catches it, sets a
five-minute back-off for that agent and writes a `research_log` row `Order not placed` with the message. So under the
kill switch a spot agent that wants to buy logs one line every five minutes and places nothing; `last_bar` is not
advanced for a paper agent (the insert precedes it), so the same bar is tried again after the back-off.

Requests:

- treat the two codes as a state, not an error: a message such as "kill switch on: no purchase" once, instead of
  "Order not placed" at every back-off;
- any NEW code path that records a spot agent's order must insert into `agent_orders` before it changes
  `agent_paper` or asks the signer — otherwise it is not stopped by the kill switch.

Test: `services/api/test/execution-spot.test.ts`, "a spot agent's swaps, paper and live, are unified orders …".

## 2. `signerGuards.beforeMandateSign` also stops live SALES under the kill switch

`services/api/src/orders/index.ts` `installGates` sets `signerGuards.beforeMandateSign` (declared in
`signer-client.ts`): with the kill switch or read-only mode on, `/mandate/sign` is not called at all. The guard takes
no argument, so it cannot tell a purchase from a sale: a LIVE spot agent can therefore not sell into its cash leg
under the kill switch, although that sale adds no risk (the trigger of point 1 lets the row through; the guard then
refuses the signature, and `placeLive` marks the order `failed`, "refused by the signer: …" — a wrong label: the signer
was never asked).

This contradicts "the kill switch never blocks a reduction" for live spot agents. It was not changed here
(`signer-client.ts` and `agents/live.ts` are not this workstream's files). Proposed change, for whoever owns them:
pass the intent to the guard (`beforeMandateSign(intent)`), and let the execution workstream's hook allow it when
`intent.swap.toAsset` is the agent's cash leg; then the engine's loss-limit liquidation ("positions were sold to cash")
keeps working under the kill switch.

## 3. Spot agents' swaps are unified orders now — read them from one place

Trigger `agent_orders_projection` (AFTER INSERT OR UPDATE) queues every change; `services/api/src/orders/spot.ts`
(`agentSwapSource`, `mapAgentOrder`) maps the row and the order service projects it. An agent's swap is the unified
order with `engine = 'spot'`, `engine_ref = 'agent:<agent_orders.id>'`, principal `agent:<agent id>`, `origin = legacy`.
`GET /api/v1/trading/orders` no longer merges the read side's agent rows; `GET /orders/agent:<id>` still answers, with
the unified shape.

State mapping (`mapAgentOrder`): `prepared` → APPROVED (by mandate), `signed` → SUBMITTING, `broadcast` → SUBMITTED,
`filled` → FILLED; `failed` is told apart by its `reason` TEXT (`refused by the signer` → REJECTED / SIGNER_REFUSED,
`never signed` → FAILED / SIGNER_INTERRUPTED, `reverted` → FAILED / TX_REVERTED, anything else before the broadcast →
FAILED / NOT_SENT). A failure after `broadcast` is recorded REJECTED / VENUE_REJECTED_AFTER_ACK with the text.

Request: a machine-readable `reason_code` column on `agent_orders` (as `proposals.error_code`), so that this mapping
stops reading English sentences. If the wording of a `reason` changes, `mapAgentOrder` and its test must follow.

## 4. STOP ALL AGENTS: no exported function stops a spot agent

`services/api/src/orders/agent-control.ts` (`AgentControlPort`, used by the command `STOP ALL AGENTS`):

- perp agents: `perpMode(agent, 'STOPPED')` of `agents/perp-routes.ts` — the function the owner's route calls;
- spot agents: the state change is inline in the handler of `POST /api/v1/agents/:id/mode` (`agents/routes.ts`).
  Nothing exported does it, and this port does not write the `agents` table itself. A LIVE spot agent gets
  `revokeAgentMandate` (exported by `agents/live.ts`): the signer signs nothing more for its vault, but its state stays
  `LIVE` and its engine keeps ticking. Every spot agent is therefore reported in `notStopped`, with the reason — never
  as stopped. When no agent at all could be stopped the command answers 501.

Request: export from `agents/routes.ts` (or a small `agents/control.ts`) one function with the handler's exact
behaviour,

```ts
export async function setAgentMode(agentId: string, mode: 'PAPER' | 'PAUSED' | 'STOPPED' | 'RESEARCH', by: string): Promise<AgentView>
```

and have the route call it. `agentControl()` then calls it for spot agents and the command stops everything.
A revoked-but-LIVE spot agent is also worth a look in `enginePass`: with its mandate gone at the signer it fails every
order until someone sets its state.

## 5. Live perp agents do not pass the provenance bound

`services/api/src/orders/provenance.ts` bounds what a key or an agent may REDUCE to the part of a position its own
fills opened, and refuses an order that would eat into somebody else's part. That check lives in the order service
(`OrderService.place`). A live perp agent places its orders through `LiveService.placeMandateOrder` directly
(`agents/perp-exec-live.ts`), not through the order service: its orders are projected into the unified table (and so
count as that agent's lot), but they are not judged by the provenance bound. With one principal per live venue
account (`account_has_active_mandate`) the only other lot on its account is the owner's own manual trading there —
which the agent's flatten-on-stop can close.

Request: route the perp agent's orders through `app.execution.orders.submitCanonical` (principal `agent:<id>`, its
trading mandate), or tell this workstream that the agent must be allowed to flatten the whole account, so that the
exception is written down instead of implicit.

## 6. Attached stop-loss / take-profit use `submitCanonical` with an `oco` option

`services/api/src/orders/attached.ts`. If the agents runtime starts placing protective orders through the order
service, it can attach them the same way (`orders.attached.attach(parentId, caller, accountId, idemKey, templates)`);
the supervisor (`orders.attached.supervise()`, run by the `orders` loop) places them once the parent filled and cancels
the sibling when one executes.
