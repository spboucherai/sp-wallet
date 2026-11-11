# V8 — agent-vault withdrawals are tracked; where else success was reported too early

## Agent vault → owner (`POST /api/v1/agents/:id/withdraw`)

Before: the route signed, broadcast and answered `{ ok: true, txid }`; the receipt was never read, and with broadcasting
off the answer was still `ok: true`. Now (`services/api/src/agents/withdrawals.ts`, table `agent_withdrawals`):

```
requested ─► signed ─► broadcast ─► confirmed   receipt status 1 AND the payment to the owner's address seen in it
    │           │           └─────► failed      reverted, or the vault's nonce was used by another transaction
    │           └─────────────────► not_sent    broadcasting off on this server, or not relayed within 10 minutes
    └─────────────────────────────► failed      the signer refused, or the process died while signing (2 minutes)
```

- **One id per requested withdrawal.** The row is inserted in state `requested` before the signer is called and its id is
  the intent's `proposalId` (the signer's replay rule is per proposal id). A partial unique index allows one open
  withdrawal per (agent, network, asset); the optional body field `idempotencyKey` (the web app sends one per sheet and
  asset) is unique per agent. A double tap, two concurrent requests or a retry return the same row with
  `duplicate: true`; the signer is called once (test: `signs === 1`).
- **Answer:** `{ id, ok, state, network, asset, symbol, amount, txid, explorer, error, arrived, createdAt, updatedAt,
  confirmedAt, duplicate? }`. `ok` is true only for `broadcast` and `confirmed`; `explorer` is null until broadcast;
  `arrived` is true only for `confirmed` with the payment verified (token: the `Transfer(vault → owner, amount)` log of
  the receipt; native coin: the transaction's `to` and `value`). A mined transaction in which the payment is not found is
  `confirmed` with `arrived: false` and an explanation — never shown green.
- **Worker:** `loop('withdrawals', advanceWithdrawals, 8 s)` — reads receipts, re-relays an already signed transaction
  every 45 s, never signs. A node that does not answer concludes nothing.
- **Read:** `GET /agents/:id/withdrawals` (last 20, plus `broadcast`), `GET /agents/:id/withdrawals/:wid`.
- **Audit:** `agent.withdraw` (signed, as before) then `agent.withdraw_confirmed | _failed | _not_sent`.
- **UI** (`apps/web/src/screens/withdrawTrack.tsx`; `AgentFund.tsx` withdraw sheet and "fonds sur d'autres réseaux"):
  the sentence follows the state, polled every 3 s until final — "signé — envoi en cours. Pas encore diffusé",
  "diffusé — en attente d'inclusion. Pas encore confirmé", "confirmé : arrivé dans votre portefeuille principal" (the only
  green one), "échoué", "signé, mais non envoyé". The button is disabled while one is in flight.
- The signer, the intent and its verification are unchanged. A withdrawal still open after a long time stays `broadcast`
  (it may still be mined); it is not yet covered by the `transfer.stuck` alert (that rule reads `proposals`).

Tests: `services/api/test/agent-withdraw.test.ts` (6), `apps/web/test/hardening-b.test.ts` (3).

## The same review of the other flows

Method: grep of `config.broadcast`, `.broadcast(` and of what the routes answer after a signature. The collateral and plan
modules were read for their state names, not audited line by line.

| Place | What it reports | Verdict |
|---|---|---|
| `agents/live.ts` `advanceOrder` (agent orders) | `signed → broadcast → filled` on the receipt and the router's `Swapped` event; broadcasting off → `failed: … nothing was sent` | fine |
| `derivatives/collateral.ts` venue withdrawal | `signed → submitted` on the venue's `ok`, final only when the venue's ledger / the wallet's chain shows it | fine as read |
| `plan-exec.ts` | never signs or broadcasts; a leg follows its proposal's state | fine as read |
| `bridge.ts` mint (`:252`, `:400`) | `broadcast(...).catch(() => {})` swallows a relay error; the phase still advances only on the mint's receipt | state is right; the swallowed error is not logged. Left (shared file) |
| **`transfers.ts:216` `broadcastNow` with broadcasting off** | moves the proposal to state **`broadcast`** with `error: 'broadcast disabled (test mode)'`. `swap-exec.ts:164`, `swap-exec-sol.ts:290`, `bridge.ts:264`, `xswap.ts:290` go through it; the row then stays `broadcast` for ever (the worker skips it) and the web app recognises the case by a regex on the error text (`TEST_NOT_SENT`) | **wrong state name — not fixed.** It only happens on a server started with `SPW_BROADCAST=off` (tests, QA), never in production. A fix is a new terminal state in the shared proposal state machine (`@spw/core`, the `transfer.stuck` alert, several screens) while other engineers are editing those files. Proposed: a terminal `not_sent`, as here |
| `derivatives/collateral.ts:501` venue deposit | maps the proposal's `broadcast` to the deposit's `sent` — so with broadcasting off a deposit reads `sent` | consequence of the row above; same fix |
| transfer / swap / bridge approve routes | answer the proposal row itself (`signed` or `broadcast`), which the UI follows to `finalized` | fine |
