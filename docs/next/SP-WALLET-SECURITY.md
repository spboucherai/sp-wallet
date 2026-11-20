# SP Wallet NEXT — security

What NEXT changes in the security of the wallet, what it leaves as it was, and what the owner must decide.
Findings are in `SP-WALLET-AUDIT.md` (ids in brackets). The custody model is unchanged: `docs/adr/0001-custody.md`.

## 1. What does not change

- One key on the isolated signer; a device never holds a blockchain key.
- Every value-moving operation is approved by a passkey whose challenge is the SHA-256 of a canonical, domain-separated
  object; the signer verifies the passkey itself and rebuilds what it signs.
- Default-deny per-asset limits on the signer; replay markers and spend saved before a signature leaves.
- The seven passkey-less paths of ADR 0001 (bounded mandates, returns to the owner, cancels, first bridge mint).
- No key derivation, keystore, wrap-key or signing-path code was modified. No key is moved, exported or re-derived.

## 2. Signer changes — review list

**Nothing in this section is deployed.** The signer bundle changes; deploying it needs the owner's explicit approval.
Each item names its test (`services/isolated-signer/test/next-signer.test.ts` unless stated).

| # | Change | Why | Covered by |
|---|---|---|---|
| S1 | Source allowlist, auth-header freshness, body (≤ 1 MiB, ≤ 5 s), HMAC and nonce are checked **outside** the request queue; only an authenticated, fully-read request is queued. HTTP time-outs set (headers 5 s, request 10 s); at most 128 connections. | [C1] a stalled, unauthenticated request blocked every signature and the halt | stalled-body and oversize tests |
| S2 | `POST /halt` and the operator's `halt` are applied at once, never queued. | [C1] | halt-while-queue-blocked tests |
| S3 | **Release check:** an answer computed across the moment a halt was recorded is not sent (`halted`, journal `halt.withheld`). Returns of the owner's own funds are exempt, as before. | a signature in progress must not leave after the halt | halt-during-signature test |
| S4 | The daemon refuses to start on a non-loopback address with an empty source allowlist. Production already has the allowlist set (checked 2026-11-19). | [C2] fail-open configuration | unit + real CLI test |
| S5 | **Passkeys after the first are added and revoked with `SPW-CRED-v2`**: action, credential id, public key, server request id, validity ≤ 300 s, this signer's key id. Single use, expires, `add` refused under halt, `revoke` allowed under halt, the last passkey is never revoked, a passkey never approves its own addition or revocation. Journaled. | [P1] enrolment was permanent, unexpiring and replayable | add / revoke / replay / expiry / halt / self-approval tests |
| S6 | The legacy `SPW-ENROLL-v1` path only pins the **first** passkey (operator's setup token). | [P1] | signer.test.ts |
| S7 | Optional cool-down `newCredentialCooldownSec` in `policy.json` (absent = off): a passkey added by another passkey approves nothing on the signer until it ends. | [P1] a passkey added by deception could act, or revoke the others, at once | cool-down test |
| S8 | `status()` lists each passkey with dates and cool-down state, and `recoveryExportedAt` / `recoveryVerifiedAt`. No key material. | Security Center reads the signer, not the API table | status tests |
| S9 | Passkey-less vault returns are capped per vault and day (`maxVaultReturnsPerDay`, default 12). **New default behaviour.** | [C3] a compromised API could burn a vault's gas | cap tests |
| S10 | CLI `verify-recovery` (terminal only, no echo, answers only match / no match), `backup-state <file.tar>` (state, policy, journal — never the keystore or wrap key), and `export-recovery` now journals that it ran. | [K1] no way to check the paper phrase or copy the signer's state | TTY refusal, tar content tests |
| S11 | A body that is not a JSON object answers 422 (was 500); `unhandledRejection` prints the message only and exits. | hygiene | body tests |
| S12 | **Native gas limit on Arbitrum** may be between 21 000 and 120 000 instead of exactly 21 000 (`packages/core/src/build-evm.ts`, bundled in the signer). Unchanged on every other network; the fee stays bounded by the approved maximum and the policy ceiling. | [E1] the network refuses 21 000 (measured: 21 489) | `packages/core/test/core.test.ts` |

**File formats.** `policy.json`: two optional keys (S7, S9) the signer never writes. `state.json`: optional fields only
(`vaultReturns`, recovery dates, `lastUsedAt`, `addedBy`). `keystore.json`: untouched. An old state file loads unchanged
(fixture test).

**Rollback** (`docs/runbooks/deploy.md`, "Signer changes of NEXT"): remove the two policy keys if they were added (the old
binary refuses unknown keys); never restore an old `state.json` (it would bring revoked passkeys back); the old binary
ignores the new state fields.

**Deploy the API and the signer in the same window**: with only one of them updated, adding or revoking a passkey fails
with an error (nothing is added); everything else works.

**Known limits of these changes** (stated by their author, kept open):
- The release check is coarse: an answer that the halt would have allowed anyway (a reduce-only order, a revocation) is
  also withheld when its handler straddles the halt; the request must be made again.
- Without a cool-down, any passkey can revoke any other (never the last). The cool-down is the defence and is **off by
  default**: owner's decision below.
- When the signer is unreachable, sign-in falls back to the API's own passkey table (view-only session; nothing can be
  approved without the signer).
- `maxConnections` and the vault-return cap default were not asked for; both are bounded choices, listed here to be seen.
- After `reset-passkeys`, reopening the API's setup is still the manual SQL step of the runbook.

## 3. API and client changes

| Area | Change |
|---|---|
| Transfers | A relay time-out is never a failure; negative verdicts need every source, repeated; `dropped`; one in flight per network enforced by the database; `duplicate_recent` warning. [T1–T7] |
| Balances | Two-source reads with provenance; a Solana token is never reported 0 without confirmation; a partial total says so. [B1–B3] |
| Passkeys and sessions | Add / revoke through the signer; the Security overview lists the **signer's** passkeys and any mismatch (critical alert); sessions have ids and can be revoked one by one; last logins; a passkey the signer does not list cannot sign in or approve an API-side action. [P1, P3, P4, SS] |
| Idle time-out | A session that has sent `X-SPW-Interaction` is kept alive only by real interactions, not by polling. Clients send it from NEXT on. |
| Contacts | Changing a contact's address needs the address the client believes is current and raises a security event. |
| Clients | After an approval left the device, no client shows "failed", re-enables Approve, resets the form or offers Cancel on a lost answer. Native reviews show every signed field. [W1, N1–N4] |
| Secrets | No secret-shaped string in production logs (checked). `/health/ready` returns endpoint hosts only, never full URLs. [H1s] |

## 4. Infrastructure — state and owner decisions

| Item | State | Decision |
|---|---|---|
| **Recovery phrase on paper** [I2] | Unknown: still listed as pending. After the signer is updated: `signer.mjs verify-recovery` on the node tells whether the paper matches, without showing anything. | **Owner — the most important item.** |
| Signer disk encryption [I1] | FileVault off on m6ma; wrap key on the same disk. | Owner: encryption needs a password at boot (no unattended restart after a power cut). |
| Signer node exposure [I3] | Listens on all interfaces, firewall off, Remote Management on; protected by the allowlist + HMAC. | Owner: firewall on, Remote Management off on m6ma (recommended). |
| Passkey cool-down [S7] | Off. | Owner: recommended 24 h once a second passkey exists. |
| Global daily ceiling [GL] | Per-asset limits only. | Owner: not built; say if wanted. |
| Database backup [I4, I5] | Script fixed (verified dumps, private files, optional off-node copy), restore test script added and run on a production dump; **not yet deployed**, no off-node destination configured. | Deploy with NEXT; destination proposed: M2U64. |
| Signer state copy [K1] | `backup-state` exists after the signer update; no schedule yet. | With the deployment. |
| Shared credentials across the cluster [C5] | One user, one sudo password, one key set on all nodes; HMAC secret in the API's PM2 environment. | Owner: a dedicated account for the signer node is the real fix; outside this upgrade unless asked. |

## 5. What is not done

- Restore of a signer from the phrase (`import-recovery`): designed, not implemented — it creates key material and needs
  its own review.
- Replacing a stuck transaction on purpose (speed-up, cancel, RBF bump): needs a new signing rule; not started.
- GMX orders keep their own relay path (lock off in production).
- TON and Polkadot fees are not bounded on the wire by the signer (documented, unchanged).
