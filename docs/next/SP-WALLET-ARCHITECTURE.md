# SP Wallet NEXT — architecture

What changes with NEXT, and why. The custody model, the signer's role and the approval binding are unchanged
(`docs/adr/0001-custody.md`); this document records the decisions taken on top of them.

```
 Web (React PWA)      macOS (SwiftUI)        iOS / iPadOS (SwiftUI)
        │                   │                        │
        │        SPWalletCore (API client, canonical objects, approval binding, outcome helper)
        │        SPWalletUI   (design tokens, shared components)
        └───────────────┬───┴────────────────────────┘
                        │  HTTPS, session cookie (passkey login), CSRF header, /api/v1 (additive only)
                 BHS64 gateway (TLS, WireGuard)
                        │
        ┌───────────────▼───────────────────────────────────────────────┐
        │ API (M2M32c)                                                   │
        │  auth · wallet · portfolio · transfers · events · prefs        │
        │  swap / bridge / plans · NFT · derivatives · agents · alerts   │
        │  workers: reconcile · deposits · snapshots · alerts · prune    │
        │  Postgres 17 (state, audit chain, wallet_events)               │
        └───────┬──────────────────────────────────┬────────────────────┘
                │ HMAC over LAN (root relay)        │ public RPC / indexers, ≥ 2 independent per network
        ┌───────▼──────────┐                        ▼
        │ Signer (m6ma)    │                  Blockchains (23 networks)
        │ keys · policy    │
        │ passkey check    │
        └──────────────────┘
```

## Decision 1 — Only the chain can say that nothing was sent

*Problem (audit T1–T5).* A signed transfer whose relay timed out was marked failed after its window, with the words
"nothing was sent", without looking at the chain. Negative verdicts (replaced, expired) came from one endpoint's silence.
A transaction that never confirmed blocked its network for ever.

*Decision.*
1. `relay_attempted_at` is written **before** the network call. From then on a time-out, a crash or an error answer proves
   nothing. A relay error is followed by a look-up; a transaction the network has moves to `broadcast`.
2. A signed row past its window is settled by the chain: tracked if present; `dropped` if every source says unknown and
   its validity cannot be proven over; `failed / not_broadcast_in_time` only when no relay ever started.
3. Tracking asks every endpoint. One endpoint that has the transaction places it; absence needs all of them to answer;
   `replaced` needs the nonce consumed according to all of them. The worker applies a negative verdict only after
   3 consecutive passes over at least 60 s.
4. `dropped` (EVM after 30 min unknown everywhere, Bitcoin-style after 6 h): frees the network, is not relayed again, stays
   watched. A later send cannot double-pay: on EVM it reuses the nonce; on Bitcoin-style networks the new transaction is
   forced to spend one coin of the dropped one. `replaced` stays re-checked for a day and is corrected if the transaction
   turns out to be in a block.
5. Swaps, bridges and native swaps keep their "simulate, then relay" gates only until a relay has started; afterwards the
   chain is asked first (the simulation of an already-mined swap reverts and used to fail the row).
6. The database enforces one transaction in flight per network (partial unique index), in addition to the route checks.

*States.* Stored: `draft, pending_approval, approved, signed, broadcast, confirming, finalized, rejected, expired, failed,
replaced, reorged, not_broadcast, dropped`. Clients read `lifecycle` (fourteen values, `packages/core/src/state.ts`):

| Brief | lifecycle | from |
|---|---|---|
| Draft | `draft` | draft |
| Awaiting confirmation | `awaiting_confirmation` | pending_approval (intent frozen, shown, passkey not yet given) |
| Awaiting signature | `awaiting_signature` | approved (signer call in flight) |
| Signed | `signed` | signed, no relay started |
| Broadcasting | `broadcasting` | signed, relay started |
| Pending | `pending` | broadcast |
| Confirmed | `confirming` (in a block, not final — `confirmations`) then `confirmed` (final only) | confirming, reorged · finalized |
| Failed | `failed` | failed |
| Replaced | `replaced` | replaced |
| Dropped | `dropped` | dropped |
| Expired | `expired` | expired (approval window) · failed with `expired_onchain` (validity window) |
| — | `rejected`, `not_sent` | rejected · not_broadcast |

*Compatibility.* Shipped native builds decode `state` with closed enums. `state` therefore keeps its old vocabulary
(`dropped` is reported there as `failed`, with `errorCode: dropped` and a sentence that says it is still watched); new
fields are additive: `lifecycle`, `finalized`, `watched`, `feePaid`, `feePaidDisplay`, `relayAttemptedAt`.

*Not covered.* GMX orders relay through their own path (`derivatives/gmx-exec.ts`); the GMX lock is off in production.
Replacing a stuck transaction on purpose (speed-up, cancel, RBF bump) needs a new signing rule: separate package, signer
review and owner approval.

Code: `services/api/src/worker.ts` (`reconcile`, `settleLateSigned`), `transfers.ts` (`broadcastNow`, `knownToNetwork`,
`duplicateWarning`, `droppedCoins`), `chains/{evm,sol,btc}.ts` (`track`, `broadcast`). Tests: `test/lifecycle.test.ts`.

## Decision 2 — One event log, three clients

*Problem (audit S1).* Every client polled every screen; a transfer made on the phone appeared elsewhere after the next poll.

*Decision.* `wallet_events` (append-only, increasing id) receives every change a client may need to hear about: transfer
transitions (`transfer.state`, `transfer.relay`, `transfer.confirmations`), deposits, device / session / address-book /
settings / halt changes (mirrored from the audit chain). `GET /api/v1/events?after=` is the catch-up, `GET
/api/v1/events/stream` the same as Server-Sent Events resumed with `Last-Event-ID`. An unresumable position is answered
`reset`. Events are facts that say "look": clients re-read the object named by `ref` through the normal read routes, so a
duplicate or late event is harmless and the server never pushes a state the chain did not give. Polling remains as the
fallback at a slow rate. Retention 30 days; the newest row is always kept.

The stream needs a session cookie like every other route; it carries no secret and no signing material.

Code: `services/api/src/events.ts`, `db.ts` (`walletEvent`, mirroring in `audit`). Tests: `test/events.test.ts`.

## Decision 3 — The server computes what the three clients used to compute separately

Portfolio total, completeness (`complete`, `missing`), 24 h change, allocation by asset and by network, value history
(snapshots, ranges 1D…ALL, net flows over the range) and balance provenance are produced once by the API. A partial total
says it is partial; a point recorded while a network was unreadable is never drawn as a low. *(Implemented on branch
`next-balances`; fields are listed in `SP-WALLET-API.md` once merged.)*

Owner arrangements live on the server so that devices agree: hidden / favourite assets (`asset_prefs`), contacts with note
and favourite, appearance (`theme` in settings). Changing a contact's address requires the address the client believes is
current and raises `security.contact_address_changed`. Code: `services/api/src/prefs.ts`.

## Decision 4 — Credentials and sessions have a life cycle the signer verifies

*(Implemented on branch `next-signer`; changes to the signer are deployed only after review and the owner's approval.)*
A passkey is added or revoked through a canonical, expiring, single-use object (`SPW-CRED-v2`) signed by an existing
passkey and verified by the signer; the signer's credential list is the source of truth shown in the Security Center;
sessions have public ids and can be revoked one by one. The signer's request queue no longer reads unauthenticated bodies,
and `halt` never waits.

## Decision 5 — One design system

`design/tokens.json` generates the web CSS and the Swift tokens; contrast is verified at generation
(`SP-WALLET-DESIGN-SYSTEM.md`). Native apps use SwiftUI components over the same values; no web view.

## Decision 6 — What an operation's outcome is, on every client

Once an approval has left a device, the outcome is unknown until the server says otherwise. No client shows "failed",
re-enables Approve, resets the form or offers Cancel on a lost answer: it re-reads the operation, and when it cannot, shows
"status unknown — do not send again". The server adds a `duplicate_recent` warning when the same payment was made or may
have been made in the last 24 hours. *(Web: branch `next-web-safety`; Swift: `next` branches of the three Apple
repositories.)*

## API rules

- `/api/v1` is additive: no field removed, renamed or retyped; new fields and routes only. New enum values never appear
  in a field a shipped client decodes with a closed enum.
- Amounts are strings of base units plus a display string computed with exact arithmetic; never a float.
- Every figure that is an estimate, partial or stale carries the flag that says so.
- Errors are `{ error: code, message, data? }`; codes are catalogued (`sv-texts.ts` for the outcome of a stored proposal,
  `services/api/src/wallet-api/spec.ts` for the HTTP errors of every route).
- The core wallet API has a machine-readable contract: `docs/openapi/wallet-v1.json`, generated from `wallet-api/spec.ts`
  and checked against the real server by `test/wallet-contract.test.ts` — see `SP-WALLET-API.md`.
