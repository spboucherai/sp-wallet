# SP Wallet NEXT — changelog

Base: backend `851e2fa`, SPWalletCore `381aabd`, macOS `95ade9c` (1.0.0), iOS `9d943ef` (build 3).
State: local branches `next` in the four repositories. **Nothing is pushed or deployed.**
Audit ids in brackets refer to `SP-WALLET-AUDIT.md`.

## Funds safety

- **A relay time-out is never a failure.** Once a relay has started, only the chain can say that nothing was sent; a signed
  transfer past its window is tracked if the network has it, `dropped` if every source says unknown, failed only when no
  relay ever started. [T1]
- **Negative verdicts need every source, repeated** (replaced, expired): 3 passes over at least 60 s; EVM, Solana and
  Bitcoin-style tracking ask every endpoint. [T2, T3]
- **`dropped`**: a transfer the network no longer knows frees its network, stays watched, and a later send conflicts with it
  (same nonce; Bitcoin-style: one of its coins is always spent). `replaced` is re-checked for a day. [T4, T5]
- **One transfer in flight per network** enforced by the database. [T6]
- **`duplicate_recent`** warning before approving the same payment again within 24 h. [T7]
- **Clients never guess an outcome**: after an approval left the device, no "failed", no re-enabled Approve, no reset, no
  Cancel — the state is re-read, else "status unknown — do not send again" (web: 20 flows; macOS and iOS: send, swap, bridge,
  plan legs, NFT). Agent funding on the web no longer creates a second payment on a lost answer. [W1, N1, N2]
- **Native reviews show every signed field**, generated from the canonical object; iOS drafts are checked against the form
  on amount and destination too. [N3, N4]
- **ETH sends on Arbitrum work**: estimated, bounded gas limit instead of a fixed 21 000 the network refuses (signer rule
  change S12). OP-stack data fee in the estimate. [E1]

## Honest data

- Balances read from two sources with provenance; a Solana token is never 0 without confirmation; a slow source no longer
  holds the screen (previous read served, marked stale). [B1, B2]
- Server-computed total with `complete` / `missing`; 24 h change; allocation by asset and network. [B3]
- Value history (snapshots every 10 min, ranges 1D–ALL), net flows, an estimated price effect that is never called a return.
- Incoming native coins detected on EVM networks; scans no longer skip a backlog; own swap / bridge outputs are internal,
  not "received". [H1, H2, H3, H5]
- Fee actually paid recorded; life cycle with fourteen values (`confirmed` = final only); per-transition events. [T8]
- Litecoin balance no longer "unavailable" when one of its two sources is down.

## Security

- Signer: authentication and body outside the queue; halt never waits and withholds a signature in progress; refuses to
  start exposed without an allowlist. [C1, C2]
- Passkeys added and revoked with an expiring, single-use request verified by the signer (`SPW-CRED-v2`); the last one can
  never be revoked; optional cool-down. The Security Center shows the signer's list and any mismatch. [P1, P3, P4]
- Sessions with ids, revoke one, last sign-ins; idle time-out no longer kept alive by polling (clients mark interactions). [SS]
- Vault-return cap; recovery status, `verify-recovery`, `backup-state`. [C3, K1]
- Contacts: a change of address is guarded and is a security event. Control characters in a request are a 400.
- `/health/ready` returns endpoint hosts only. [H1s]

## Synchronisation

- Wallet event log and stream (`/api/v1/events`, `/events/stream`): resume after a lost connection, `reset`, retention;
  consumed by the three clients; polling is a slow fallback. [S1]
- Settings (language, currency, appearance), hidden / favourite assets, contacts live in the account and follow on every device.

## API

- OpenAPI contract for the core wallet API (66 operations) with contract tests on a real server; error-code catalogue;
  validation errors name the field. `GET /api/v1/openapi.json`. [A1]
- New: portfolio summary and history, analytics, search, asset preferences, contacts, events, security (revoke passkey,
  revoke session, logins), activity filters by network and asset, contact labels.
- Alerts: transfer dropped / replaced / expired / recovered; passkey revoked; credential mismatch.
- Everything additive: a shipped client keeps working.

## Design

- One token source generating web CSS and Swift (`design/tokens.json`), contrast checked at generation; `SPWalletUI` shared
  Swift components.
- **Web**: design system 2.0, server-driven dashboard (balance card, value chart with gaps and flow marks, allocation,
  tiles), assets with favourites / hidden, activity detail with life-cycle timeline, contacts, Security Center, ⌘K search,
  two-pane desktop layouts, system / light / dark from the account, text scales to 200 %.
- **macOS**: shared tokens and components, real logos, English added, server dashboard, contacts section, Security Center,
  lock over every window and on sleep, multiple windows, ⌘K, full menus, background notifications.
- **iOS**: see `SP-WALLET-PLATFORM-PARITY.md` (completed in this release; details there).

## Operations

- Backup job: verified dumps, private files, one run at a time, optional off-node copy; `scripts/restore-test.sh`. [I4, I5]
- `scripts/rehearse-next.mts`: pre-production rehearsal on a restored copy, read-only on real chains.
- Deposit scan five networks at a time (88 s → 16 s per pass on the rehearsal).

## Not in this release

APNs push; intentional replacement of a stuck transaction (speed-up, cancel, RBF bump); signer restore from the phrase;
custom tokens (registry only, by decision); GMX relay path unchanged (lock off); disk encryption and firewall on the
signer node (owner decisions).
