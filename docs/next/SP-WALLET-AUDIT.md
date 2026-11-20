# SP Wallet NEXT — initial audit

Date: 2026-11-19. Code audited: backend `851e2fa` (production), SPWalletCore `381aabd`, macOS `95ade9c`, iOS `9d943ef`.

**Method.** Four read-only code audits (keys / signer / authentication; transactions / chains / synchronisation; web client;
macOS + iOS + Core) and one read-only inspection of the production nodes. Unless a line says otherwise, a finding was
established by reading the full code path; nothing was executed against production and no transaction was sent.
`[V]` = verified in code or on the node. `[S]` = suspected: the path was read but the trigger depends on behaviour that was
not reproduced. Items marked "checked on production" were read from the live configuration.

**Baseline.** Typecheck passes. Test suite: 4 865 of 4 869 pass; the 4 failures are time-outs in agent / laboratory tests
run while the audits loaded the machine (three of the four files are known to be load-sensitive) — to be re-run alone.
Public page: 50–110 ms, 939 bytes of HTML, strict CSP / HSTS / frame denial. First paint needs ≈ 230 kB gzip
(81 kB code + 113 kB French strings + CSS). Database 306 MB (1.49 M candles; 19 proposals; 24 deposits).

---

## 1. What the system is

| Part | Where | Role |
|---|---|---|
| API + web (`sp-wallet`) | M2M32c:8650, PM2, Postgres 17 | Fastify API, React PWA, workers (reconcile, deposits, alerts, agents) |
| Isolated signer | m6ma:8651, alone on its node | Holds the keys; verifies every passkey itself; enforces `policy.json` |
| Relay | M2M32c, root LaunchDaemon, 127.0.0.1:8652 | Byte relay API → signer (macOS local-network privacy) |
| Research runner | M5M36 | Strategy research jobs; no keys |
| Public entry | BHS64 (Caddy, WireGuard) | TLS, `wallet.spboucher.ai` |
| macOS app | `apple/SPWallet`, 1.0.0 notarised | Native SwiftUI client |
| iOS app | `apple/SPWallet-iOS`, build 3 on TestFlight | Native SwiftUI client, widgets |
| Shared Swift package | `apple/SPWalletCore` | API client, canonical objects, approval binding, address validation |

**Custody model (unchanged by NEXT).** One 32-byte entropy on the signer, AES-256-GCM under a wrap key on the same disk.
A device never holds a blockchain key: it views, prepares, and approves with a passkey whose challenge is the SHA-256 of the
canonical intent. The signer rebuilds every transaction from fields, verifies the passkey with its own origin / rpId, applies
default-deny per-asset limits, and records the single-use marker before a signature leaves. Authentication keys (passkeys,
session cookie) and signing keys (signer) are fully separate.

**Passkey-less signing paths** (exactly the seven of ADR 0001; no eighth found): first bridge mint (owner key, bounded to the
approved bridge and the wallet's own address), mandate orders, vault returns (pay only the owner), venue cancels, venue
mandate orders, venue quoting, plus revocations (reduce authority only).

---

## 2. Feature inventory and platform matrix (core wallet)

P = present and traced to a working route; ~ = partial; — = absent.

| Feature | Web | macOS | iOS | Server |
|---|---|---|---|---|
| Total value | P (client sum) | P | P | no server total |
| Value change | ~ 24 h % only | — | ~ 24 h % | not based on past holdings |
| Allocation by asset | P | P | P | client-derived |
| Allocation by network | — | P | ~ | client-derived |
| Portfolio history 1D…ALL | — | ~ local observations | — | **no route, no snapshots** |
| Recent transactions on dashboard | — (pending only) | P | P | `/activity` |
| Network fees | — | — | — | — |
| Alerts on dashboard | ~ bell | P | ~ bell | `/alerts` |
| Quick send / receive | P | P | P | |
| Asset search | P (no contract) | P | ~ | |
| Hide token / favourites / custom token | — | — | — | **no route** |
| Contract display | P | P | P | |
| Suspicious-token marking | — | — | — | pinned registry only |
| Send: address validation | ~ server; client EVM only | P | P | P all 23 networks |
| Send: summary before passkey | P | ~ fields omitted | ~ chain sections omitted | intent returned |
| Send: warnings | ~ no abnormal fee | P | ~ 2 codes mapped | 5 codes |
| Send: lost-answer handling | ~ (W1) | ~ (N2) | ✗ (N1) | |
| Receive: QR / copy / share | P / P / ~ | P / P / — | P / P / P | |
| Activity: pagination | P cursor | — one fetch of 500 | — one fetch of 200 | cursor on `/dashboard/activity` |
| Activity: hash copy / confirmations / effective fee | — / — / — | ~ / P / — | P / P / — | **effective fee never recorded** |
| Replaced / dropped | ~ no dropped | ~ | ~ | no dropped state, no action |
| Address book | ~ chips + save after send | P no edit | P no edit | CRUD, no update route |
| Notifications | P Web Push (67 kinds) | ~ only while frontmost | ~ local, foreground poll | **no APNs** |
| Passkeys: list / add / revoke | P / P / — | P / P / — | P / P / — | **no revoke anywhere** |
| Sessions: list / revoke one / revoke all | P / — / P | P / — / P | P / — / P | no per-session id |
| Last logins | ~ raw audit rows | ~ | ~ | audit only |
| Backup / recovery status | ~ static text | — | — | nothing recorded |
| Analytics (flows, fees paid) | — | — | — | — |
| CSV export | P (two routes) | P | ~ | P |
| Universal search | — | — | — | — |
| Real-time wallet sync | polling 4–60 s | polling 30–120 s | polling 8–45 s | **no wallet event stream** |
| Theme / language | manual, not synced | system; French only | system; fr + en | settings route |

Extended areas (swap, bridge, plans, NFT, futures, agents, research, alerts, developer API, monitoring) exist on all three
clients and were inventoried, not re-audited; NEXT does not remove any of them.

---

## 3. Findings — transactions and data (priority: funds first)

| ID | Sev. | Finding | Evidence |
|---|---|---|---|
| T1 | **Critical** | **A relay time-out becomes a terminal failure with no chain check.** A `signed` row is only re-relayed, never tracked, and after its window + 10 min is marked `failed` with the text "nothing was sent" — although a node may have accepted the first relay. `nonce too low` (the answer once it is mined) counts as a relay error. The owner re-sends; the destination is paid twice. | `worker.ts:31-36`; `chains/evm.ts:115-120`; `sol.ts:93-98` `[V]` path, `[S]` trigger |
| T2 | High | EVM `replaced` verdict from single-source, non-atomic reads: a lagging endpoint with a null receipt + a consumed nonce marks a mined transaction `replaced` (terminal, no alert). | `evm.ts:123-128` `[V]`/`[S]` |
| T3 | High | Solana `failed … no funds moved` from one endpoint's null status. Also `confirming → broadcast` is illegal, so that pass throws forever. | `sol.ts:100-107`; `state.ts:13` `[V]` |
| T4 | High (liveness) | No dropped / abandon path: a UTXO or EVM row can stay `broadcast` for ever and block every send on that network. No speed-up, cancel, RBF bump (RBF is signalled but never used). Recovery = manual SQL. | `btc.ts:222-225`; `evm.ts:128` `[V]` |
| T5 | Medium | `reorged` has no exit to `replaced`. | `state.ts:14` `[V]` |
| T6 | Low | The one-in-flight rule is check-then-act (two approvals in the same instant both pass; outcome is a nonce conflict, not a double payment). | `transfers.ts:192,234` `[V]` |
| T7 | Medium | No duplicate-intent warning (same destination and amount as a recent transfer that failed or is unresolved). | `transfers.ts:125-135` `[V]` |
| T8 | Medium | The fee actually paid, block and per-transition times are never stored: no effective fee, no fee history, no honest CSV. | `transfers.ts:44-46` `[V]` |
| B1 | Medium–High | Solana SPL false zero: an endpoint answering an empty or truncated token list yields a real-looking 0. | `sol.ts:49-50` `[V]`/`[S]` |
| B2 | Medium | Balances come from the first endpoint that answers, with no cross-check and no provenance (`asOf` is the HTTP time). | `server.ts:241-266` `[V]` |
| B3 | Medium | The dashboard total silently omits unavailable networks and unpriced assets; no "partial" marker. | `Home.tsx:46-47` `[V]` |
| H1 | High (functional) | **Incoming native coins are never detected on any EVM network** (only registry-token `Transfer` logs are scanned): no history row, no alert for received ETH / BNB / POL / AVAX / HYPE. | `evm.ts:135-160` `[V]` |
| H2 | Medium | EVM deposit scan jumps forward after downtime (> 20 000 blocks): logs in the gap are lost. | `evm.ts:139` `[V]` |
| H3 | Low–Med. | Solana deposit scan is lossy under bursts (15 signatures / account, cursor moves past unprocessed ones). | `sol.ts:116-141` `[V]` |
| H5 | Medium | No internal / external classification: the output of the wallet's own swap or bridge is recorded as a separate "receive" and fires `deposit.received`. | `worker.ts:68-71` `[V]` |
| E1 | High if confirmed | Arbitrum native sends use a fixed 21 000 gas limit; Arbitrum needs the L1 data component — probably refused at relay. OP-stack L1 fee not in the estimate. | `build-evm.ts:27` `[S]` — needs a fork test |
| E2 | Medium | EIP-1559 tip from one source with a 0.001 gwei fallback floor and no bump available. Solana priority fee sampled on the wallet's own account (mostly the floor). | `evm.ts:83-89`; `sol.ts:63-70` `[V]` |
| S1 | Medium | No event stream for wallet state: every client polls. The alert SSE has no event id and no replay. | `alerts/routes.ts:70-93` `[V]` |
| A1 | Medium | The core wallet API has no machine-readable contract (OpenAPI exists for `/api/v1/trading` only); web types are hand-written with `any`; no error-code catalogue. | `[V]` |

The eleven plugin families (TRON, XRP, Stellar, Cosmos, Sui, Aptos, NEAR, TON, Cardano, Polkadot, BCH) already require every
source to agree and the validity window to be closed before a negative verdict: T1–T3 concern EVM, Bitcoin-style and Solana.

**Untested today:** the life cycle beyond `signed` for plain transfers (tests run with broadcast and workers off); worker
reconcile windows; EVM / Solana `track`; UTXO `track`; deposit scans; balance partial failures. No fork harness in the
test suite (fork scripts exist under `scripts/` and are run by hand).

## 4. Findings — keys, signer, authentication

No critical flaw was found in the signing core, and no path by which key material reaches an API response, a log, the
journal or an error message.

| ID | Sev. | Finding | Evidence / production check |
|---|---|---|---|
| P1 | **High** | **Passkey enrolment is permanent, cannot be revoked individually, and can be invisible.** The enrol challenge has no expiry, request id or single-use marker; the OS prompt shows nothing; no route removes one credential; the Security screen lists the API's table, not the signer's, so a credential pinned only on the signer is never shown; enrolment is not blocked by the halt. One deceived tap pins a full approver for ever. | `signer.ts:112-127`; `auth.ts:156,164`; `server.ts:341` `[V]` |
| C1 | Medium | Head-of-line blocking before authentication: the body is read inside the signer's single queue, before the HMAC check, with no time-outs. A stalled request blocks every signature **and the operator's halt**. Any local process on the API node can do it through the relay. | `signer/server.ts:47-54,101` `[V]` by reading |
| K1 | Medium | Recovery is one paper phrase; there is no `import` / restore command, no off-node copy of the signer's state and journal, and nothing records whether the phrase was ever exported. | `signer/main.ts:66-73` `[V]` |
| C2 | Medium (code) | The signer's source allowlist fails open when unset. **Production: set to the API node's address** — not exposed today. | `signer/main.ts:92`; checked on production |
| P2 | Medium (code) | Per-IP controls collapse if the trusted proxy is misconfigured. **Production: `SPW_TRUST_PROXY` includes the gateway** — not exposed today. | `config.ts:12`; checked on production |
| C5 | Medium | Isolation rests on operations: one macOS user, one SSH key set and one sudo password across the cluster; the HMAC secret is in the API's PM2 environment on a node that runs other apps. | cluster notes `[V]` for the facts, impact as analysed |
| SS | Low–Med. | Sessions: no per-session revoke (rows have no id), no rotation, not bound to anything; the idle timer is kept alive by polling. | `auth.ts:33-60` `[V]` |
| C3 | Low | Vault returns are unlimited in number (a compromised API can burn a vault's gas). | `signer.ts:229-265` `[V]` |
| H1s | Low | `/health/ready` returns full RPC URLs (a keyed URL in `SPW_RPC_EXTRA` would be shown). | `chains/rpc.ts:60` `[V]` |
| GL | Low | Limits are per asset only: no global daily ceiling on the signer. | `policy.ts` `[V]` |
| — | Low | No `unhandledRejection` handler on the signer; recovery export is not journaled; TON / Polkadot fee not enforced on the wire; API and signer credential stores can diverge on a failed insert. | `[V]` |

**Solid — must not be weakened:** canonical, domain-separated intent hashing; the signer never signs opaque payloads;
passkey verified by the signer itself; replay markers and spend saved (journal fsynced) before a signature leaves;
default-deny policy bound into every intent; halt one-way from the network; key separation (owner / vault / venue);
returns and withdrawals only to the wallet's own addresses; HMAC over method, path, time, nonce and body; `__Host-`
HttpOnly SameSite=Strict cookie, hashed session tokens, Origin + header CSRF, strict CSP, no API caching in the service
worker, nothing sensitive in browser storage.

## 5. Findings — production infrastructure (inspected on the nodes)

| ID | Sev. | Finding |
|---|---|---|
| I1 | High | **Signer disk is not encrypted** (FileVault off on m6ma, a cluster-wide choice for unattended restart) and the wrap key is on the same disk: physical access to the disk = the keys. |
| I2 | High (durability) | **The recovery phrase may never have been written down** (still listed as pending). With I1/K1, a dead disk on m6ma would then lose the funds. Only the owner can do this. |
| I3 | Medium | Signer listens on all interfaces, macOS firewall off, Remote Management (ARD) listening on the signer node; protection = in-app allowlist + HMAC only. |
| I4 | Medium | Database backup stays on the API node only; files are world-readable (0644) inside a 0700 directory; no restore has ever been tested. |
| I5 | Low | A 0-byte dump appears next to the good one on 5 nights of 9 (PM2 fires the cron restart at 03:19:59 and replaces that run). **Fixed on `next`** (`92f8d04`). |
| I6 | Low | API listens on all interfaces (needed for the gateway's WireGuard address, but also reachable from the LAN). No PM2 log rotation (logs are small). |
| — | OK | No secret-shaped string in API or signer logs (API keys, cookies, HMAC secret, key material: zero matches). Secret files are 0600. Signer key id unchanged. |

## 6. Findings — web client

| ID | Sev. | Finding |
|---|---|---|
| W1 | High | After a lost approve answer whose re-read also fails, **Cancel swallows its error and resets the form** while the transfer may be signed and relayed (`Send.tsx:56-63`). |
| W2 | Medium | No request time-out anywhere (`api.ts`): a hung request spins for ever. |
| W3 | Medium | Infinite skeletons instead of error states on Assets, Asset, Receive, Security; no error boundary; a failed lazy chunk after a redeploy blanks the app. |
| W4 | Medium | Stale balances shown as current: Home ignores the refresh error and `asOf`. |
| W5 | Low | Dust displays as "0"; asset activity filtered from the latest 200 global rows (can be wrongly empty); confirmations fetched but never shown; copy failure unhandled; send availability inconsistent between screens; language not restored from the account; version hard-coded. |
| W6 | Design | No spacing / radius / type-scale tokens (literal pixels throughout); every size in px (browser font preference ignored); dark theme manual only, not synced; `Sheet` has no focus trap; eight core screens are one 672 px column on desktop; `gcTime: 0` restarts every navigation from a skeleton; all strings of every screen load before first paint. |

Solid: full summary before the passkey (challenge = intent hash), string-only amount arithmetic that never rounds up,
no service-worker cache, per-screen code splitting, skeletons shaped like content, reduced-motion and forced-colours rules.

## 7. Findings — macOS, iOS, Core

| ID | Sev. | Finding |
|---|---|---|
| N1 | High (iOS) | A possibly-successful approval is shown as "refused": the proposal is re-read only on transport errors; a 502/504 or a decoding error after the assertion left re-enables Approve (`SendFlow.swift:76-79`; same in swap and NFT flows). |
| N2 | Med.–High (both) | Reject ignores its own failure and resets the flow (`try?`), allowing a second distinct transfer after a lost answer. |
| N3 | Medium (iOS) | The draft is compared with the form on network and asset only — not amount or destination (macOS checks both). |
| N4 | Medium (both) | The review does not show every signed field (iOS: no `evm` / `btc` / `sol` / `x` sections; macOS: several fields omitted, long values truncated). |
| N5 | Medium (iOS) | Background refresh cannot read the session while the device is locked and then stops rescheduling. |
| N6 | Medium (iOS) | Privacy cover sits under sheets (Send / Receive may show in the app switcher) `[S]`; widget shows stale totals with a time-only stamp; holdings, shares and activity are written to the widget whatever the amounts switch. |
| N7 | Medium (macOS) | The lock is incomplete: Settings window not covered, menu commands active, no lock on sleep, offline browse skips authentication when biometrics are unavailable. "Erase" does not clear the in-memory value history. Notifications only while frontmost. |
| N8 | Design | **Three design languages.** iOS matches the web palette and radii; macOS shares no token with either (system colours, indigo gradient, donuts, letter discs instead of logos). iOS: ≈ 360 fixed-size fonts, no Dynamic Type; two haptic call sites. macOS: French only, single window, no global search. |
| N9 | Debt | Duplication between the apps (two app models, send state machines, intent reviews, formatters, locks, caches ×3, provenance types ×2); Core: 429 of 588 public structs without a public initialiser, two SSE parsers and no common loader, untyped market candles, two `SourceError`, quoting mandate not portable. |
| N10 | Gap | No APNs anywhere (no entitlement, no backend route). Activity not paginated natively. No device verification yet of passkeys on iOS, Face ID, camera, widgets, notifications. |

---

## 8. Architecture recommendations

1. **Transfer life cycle v2** — negative verdicts need chain proof from every source, repeated; a `dropped` state that
   frees the network slot while the worker keeps watching; `replaced` re-checkable; on-chain expiry distinguished from
   failure; fee paid and per-transition events recorded; one client vocabulary (`lifecycle`) for the three platforms.
   Existing native builds have closed state enums, so new stored states are projected onto the old ones in `state` and
   exposed in an additive field.
2. **Wallet event log** — one append-only `wallet_events` table (transfer transitions, deposits, credential and session
   changes) with monotonic ids; an SSE route with `Last-Event-ID` replay; polling stays as the fallback. All three clients
   consume it.
3. **Balances with provenance and server-side portfolio** — two-source reads, `complete` / `missing` on the total, periodic
   value snapshots (history 1D…ALL, true change net of flows), allocation by asset and network computed once on the server.
4. **Credential and session life cycle** — a versioned, expiring, single-use credential object (`add` / `revoke`) verified by
   the signer; the signer's list as source of truth; per-session revoke; login history; a real Security Center.
5. **One contract** — OpenAPI for the core wallet API generated from the route schemas, an error-code catalogue, typed
   TypeScript and Swift models checked against it.
6. **One design system** — tokens defined once (colour, type scale, spacing, radius, elevation, motion), generated to CSS
   variables and to a shared Swift package used by both apps; native components per platform, same values.
7. **Operations** — off-node encrypted backups (database; signer state and journal without keys), a tested restore,
   signer queue hardening, start-up refusals for unsafe configurations.

## 9. Prioritised plan

| # | Work | Phase | Touches the signer? |
|---|---|---|---|
| 1 | T1–T7 life cycle v2, tests for every reconcile window | 2 | no |
| 2 | W1, W2, N1, N2, N3 lost-answer correctness on the three clients | 2 | no |
| 3 | B1–B3 balance provenance; H1, H2, H3, H5 deposits | 2 | no |
| 4 | C1 signer queue; start-up refusals (C2, P2); H1s; `unhandledRejection` | 2 | **yes — review + approval** |
| 5 | P1 credential life cycle (add / revoke, signer as source of truth), per-session revoke | 2–3 | **yes — review + approval** |
| 6 | I4 off-node backups, restore test; K1 signer state copy, `import` command | 2 | partly |
| 7 | Wallet event log + SSE; OpenAPI for the core API; error catalogue | 3 | no |
| 8 | Portfolio snapshots, history, allocation, flows, fees paid | 3–5 | no |
| 9 | Design system tokens → web + Swift package | 4 | no |
| 10 | Dashboard, assets (hide / favourites / contract search / unverified marking), address book, activity detail, Security Center, analytics, search — three platforms | 5 | no |
| 11 | Replacement of a stuck transaction (EVM same-nonce speed-up / cancel, Bitcoin RBF bump) | 5 | **yes — new signing rule, review + approval** |
| 12 | Native excellence: locks, privacy, Dynamic Type, haptics, multi-window, search, notifications | 6 | no |
| 13 | E1 / E2 fee and gas robustness, verified on forks | 7 | no |
| 14 | Staging rehearsal, load and fault tests, deployment with rollback | 7–8 | deployment needs approval |

**Decisions that belong to the owner** (nothing is done about them without an explicit answer): writing down the recovery
phrase (I2); disk encryption on the signer node versus unattended restart (I1); firewall and Remote Management on the signer
node (I3); deploying any change to the signer (items 4, 5, 11); APNs (needs an Apple push key and a backend sender);
a global daily ceiling on the signer (GL); custom tokens (they bypass the verified registry — recommended: not offered,
unverified tokens are shown as such and cannot be sent).
