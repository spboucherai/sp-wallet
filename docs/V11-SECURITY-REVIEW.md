# SP Wallet V11 — Security review notes

Sections are added by the work streams of V11 as they close a finding or decide not to. Each states what was checked in
the code, what was changed, and what remains.

## Spot mandate loss limit

Finding D3 of `docs/TRADING-AGENTS-AUDIT.md` (§8): the loss limit of a spot agent (`risk.maxLossPct`) is checked by the
engine only (`services/api/src/agents/engine.ts`, once per tick, on candle closes). The signer does not enforce it. The
derivative mandate has a signer-enforced floor (`floorEquity`, `services/isolated-signer/src/venue-mandate.ts`); the spot
mandate has none.

**Decision (V11 Phase B, branch `v11-stab-signer`): no signer-side loss floor was added for spot mandates. The engine-side
limit stays, and it now has an effect on the signer once it trips.** The reasons follow; none of them is "it is hard".

### What a signer-side floor needs, and what the signer has

A loss floor is a statement about the value of what the vault holds: `Σ balance(asset) × price(asset) ≥ floor`. The signer
must establish each of the three terms by itself, or the check is the API's word.

| Term | Does the signer read it independently today? | Evidence |
|---|---|---|
| Prices | Yes — Coinbase + Kraken, both must agree within 1 % (`services/isolated-signer/src/prices.ts`). Already used for the per-order value check of a spot mandate (`signer.ts`, `signDelegated`) | — |
| The floor | No. `Mandate` (`packages/core/src/mandate.ts`) has no such field; the capital the engine compares against is `agents.capital_usdc`, a number in the API's database that the passkey never signed | the mandate hash covers: vault, network, provider, assets, per-order and daily volumes, orders per day, slippage, dates, strategy hash, label |
| Vault balances | **No.** The signer makes outbound calls to three kinds of hosts only: the two exchanges (prices), Hyperliquid's public `/info` (the venue account, for derivative mandates) and THORNode operators (vault confirmation of a native swap) — `services/isolated-signer/src/main.ts`, comment above the `Signer` construction. It has no JSON-RPC client and no chain endpoint. Nothing it signs today depends on a chain read: nonces, gas and balances come from the API and are bounded by what the signer checks in the transaction itself | `grep -rn "fetch(" services/isolated-signer/src` finds three call sites (`prices.ts`, `venue-read.ts`, `vaults.ts`); `grep -rnE "eth_|rpc|jsonrpc"` finds nothing |

The venue floor works because the venue itself publishes the account value on an endpoint the signer pins and reads. For a
vault there is no such single reader: its balances are on a public chain.

### Why not add the chain read now

1. **It is a new trust assumption in the key-holding process.** The floor would be only as true as the balance the signer
   is told. One RPC endpoint that overstates the balance disables the floor silently; one that understates it stops the
   agent. A quorum of endpoints (as the API does: two must agree) turns this into "a majority of the configured providers is
   honest and reachable" — an assumption the signer does not make for anything else, about parties it does not otherwise
   talk to, and one more class of untrusted input (JSON-RPC answers) parsed by the process that holds the keys.
2. **It needs a new canonical mandate.** The floor must be a field the passkey signs (`SPW-MANDATE-v2`), with its bounds,
   its review-screen wording and a migration of stored mandates. Reading it from the API at signing time would be a check
   the API can switch off.
3. **A floor on one network's balances is not the vault's value.** A vault is the same address on every EVM network; funds
   the owner sent there elsewhere, or bridged, are part of what the owner has at risk and not of what a per-network read
   sees. The engine has the same limit; a signer-enforced control should not share it without saying so.
4. **A cheaper stand-in would be false.** The signer could keep a ledger of what it signed for the vault (amount in,
   guaranteed minimum out) and derive an "inventory". It does not know what the owner deposited, whether a signed order was
   ever broadcast or executed, nor what a fill really returned: the derived inventory is wrong in both directions, and a
   limit computed from it would either never trip or trip on nothing. It was not built.

### What bounds a spot mandate at the signer, without a loss floor

Unchanged, and enforced by the signer alone (`signer.ts` `signDelegated`, `packages/core/src/mandate.ts`):

- funds can leave the vault only to the owner's own address;
- every order is a swap between mandated assets, through the mandated router, delivering to the vault;
- the guaranteed output of every order must be worth at least `1 − maxSlippageBps` of the input at the signer's own
  prices: value cannot be handed to a counterparty through a bad price. The worst a caller can extract by churning is
  `maxSlippageBps × maxDaily` per asset and day, plus gas up to the fee ceiling per order, `maxOrdersPerDay` times;
- per-order and daily volume per asset, orders per day, expiry ≤ 90 days, the emergency halt.

New in this phase:

- **one active mandate per vault** (`approveMandate` refuses a second one: `conflict`): daily caps can no longer add up
  across mandates (D2);
- **a stopped agent has no mandate left** (D2): when the engine stops an agent — loss limit, strategy no longer the approved
  code, expiry — or the owner pauses or stops it, the mandate is revoked on the signer (`services/api/src/agents/live.ts`
  `revokeAgentMandate`); every engine pass revokes any mandate the signer still holds as active that no LIVE agent owns
  (`revokeStaleMandates`: a failed revocation, a lost approval answer). Before, the signer would have gone on signing for
  that vault for up to 90 days if asked.

### Residual risk, stated plainly

- **Market loss inside the mandate is not bounded by the signer.** An agent — or anything that controls the API — can
  hold or rotate the vault into mandated assets that fall. The engine's `maxLossPct` is checked once a minute on candle
  closes by the same API; a compromised API does not run it.
- The revocation on stop is done by the API. A compromised API that trips no limit revokes nothing. It protects against a
  buggy or restarted engine and a stolen session, not against a compromised API.
- The exposure is the vault's balance: the owner decides it by what he sends there. That, the 90-day expiry and the
  owner's own revocation (no passkey) are the outer bounds.

### If a signer-side floor is wanted later

The sound design, with its cost: `SPW-MANDATE-v2` with `floorValueUsd` (passkey-signed, shown on the approval screen); the
signer reads the vault's balances of the mandated assets from at least three independent RPC endpoints pinned in its own
bundle, requires agreement and a recent block, values them at its own prices, and refuses an order that is not a sale into
the cash leg while the value is below the floor (orders that reduce risk stay signable, as for derivative mandates). It adds
RPC providers to the signer's trust base and to its egress, and it must be reviewed as such — which is why it is a design
decision for the owner and not a fix slipped into a stabilisation phase.
