# SP Wallet NEXT — test report

What was run, on what, with what result — and what was not. A test with scripted chains or a fork is not proof on a real
network; each line says which kind it is.

## 1. Summary

| Layer | What ran | Result | Date |
|---|---|---|---|
| Backend + web unit / integration (vitest) | whole repository, release candidate `30467db` | **5 280 / 5 280** in 157 s | 2026-11-20 |
| Same, baseline before NEXT (`851e2fa`) | whole repository | 4 865 / 4 869 (4 time-outs under load) | 2026-11-19 |
| Web end-to-end (Playwright, real browser, local throwaway stack) | `next-web`, `next-web-safety`, `next-approve-outcome` | **15 / 15** | 2026-11-20 |
| Contract tests | 66 documented operations called on a real server, responses validated against the OpenAPI document | pass (part of the suite) | 2026-11-20 |
| Pre-production rehearsal | NEXT server on a restored copy of production, real chains read-only, stub signer | all steps ok; 4 findings fixed (§4) | 2026-11-19 / 20 |
| Compatibility | new API in front of a signer build byte-identical to the one then in production | 23 / 23 checks | 2026-11-20 |
| Swift shared package | `swift test` | 468 / 468 (9 live tests skipped: no stack configured) | 2026-11-19 |
| macOS app | unit tests; scripted self-test on a throwaway stack running the NEXT backend with a local fork | 61 / 61; 25 / 25 | 2026-11-20 |
| macOS release build 2.0.0 (2) | `verify-release.sh` (signature, hardened runtime, sandbox, no web engine, production endpoint, no secret) | all checks pass | 2026-11-20 |
| iOS app | unit tests; fixture UI tests on iPhone and iPad simulators; live UI tests on a throwaway stack with a local fork | 368 / 368; iPhone 40 run, 0 failures; iPad 37 of 40 green, 2 harness failures left; live 5 / 5 | 2026-11-20 |
| iOS release build 2.0.0 (4) | `check-release.sh` on the exported IPA (no test passkey, no fixture, no web view, production origin, distribution signature) | all checks pass; uploaded to TestFlight | 2026-11-20 |
| macOS notarisation | Apple notary service, app and disk image | Accepted, stapled, Gatekeeper: Notarized Developer ID | 2026-11-20 |

## 2. Critical scenarios (brief §15)

R = run and observed · S = run with scripted chains / signer or a local fork · C = compiled and unit-tested, not exercised
end to end · O = needs the owner (real passkey, real device, real funds).

| # | Scenario | Web | macOS | iOS | Notes |
|---|---|---|---|---|---|
| 1 | Create a wallet (first passkey, setup token) | S | S | S | throwaway signer |
| 2 | Import a wallet | — | — | — | not a feature: one key, on the signer |
| 3 | Restore | — | — | — | signer restore from the phrase is designed, not built; database restore tested (`restore-test.sh` on a production dump) |
| 4 | Sign in with a passkey | S · O | O (confirmed on 1.0) | O | production sign-in after the release was seen in the audit log (owner) |
| 5 | Add a device (second passkey) | S | C · O | C · O | new protocol `SPW-CRED-v2`: 27 signer tests, 12 API tests with a real signer instance |
| 6 | Read balances | R (production copy, real chains) | S | S | two-source reads; rehearsal: 251 rows, complete |
| 7 | Receive | S (deposit scans on scripted chains; native EVM detection found a real deposit on Polygon read-only) | S | S | first real native receive: O |
| 8 | Prepare a send | R for Litecoin (prepared on the real chain, no signature) · S others | S | S | |
| 9–10 | Confirm, sign | S | S (self-test) | S | no real signature has gone through the new signer yet: O |
| 11 | Relay | S (fork) | S (fork) | S (fork) | |
| 12 | Chain confirmation | S | S (to `finalized` on a fork) | S | life cycle: 31 tests incl. lost answers, lagging endpoints, dropped, replaced, re-checks |
| 13 | Sync between devices | S (scripted event stream changes a row without reload) | C | C | two real devices at once: O |
| 14 | Revoke a device | S (session on the real route; passkey revoke with a fixture second passkey) | C | C | O |
| 15 | Recovery after a failure | S: API restart windows (signed ↔ relayed), RPC down, slow source, endpoint disagreement, stalled signer request, halt during a signature | — | — | |

## 3. Per platform

**Backend.** New test files: `lifecycle` (31), `events` (7), `prefs` (6), `next-chain-reads` (46), `next-portfolio` (23),
`next-serving` (8), `next-security` (12), `next-signer` (27), `credential` (2), `wallet-contract` (16+),
`wallet-api-unit` (15), `wallet-next-api` (21), `alerts-lifecycle` (11). A mutation check on the reconcile worker
(old behaviour restored) makes 4 life-cycle tests fail, as intended.

**Web.** 30 unit-test files; 15 browser specs. Screenshots: 51 in `docs/next/screens/web/` (fixture-fed where the file
name says so). Not run: Safari, iOS Safari, a funded wallet, a real passkey. The automated redesign pass was interrupted
before its own final review; the merge was re-verified here (typecheck, unit tests, production build, the 15 specs).

**macOS.** 45 screenshots in the app repository (42 fixture-fed, 3 from the real throwaway stack; about 18 inspected).
The XCUITest suite compiles but did not run (macOS asks for UI automation to be allowed at the keyboard). Compiled only:
passkey add / revoke, contact writes, second window, lock over sheets and on real sleep, notification delivery, VoiceOver.

**iOS.** 368 unit tests (183 before). Fixture UI tests: iPhone 40 run with 0 failures; iPad 33 of 40 green in the full run,
4 more green after fixes, 2 still failing in the test harness itself (a long-press context menu, opening the sidebar at the
largest text size); the last source change was followed by unit tests and partial iPad runs only. Live on a throwaway stack
(NEXT backend, local fork): sign-in, receive, invalid address, the ten extended sections, and a full send up to the tracker.
50 screenshots in the app repository (iPhone and iPad, light and dark, FR and EN, largest text size), all fixture-fed
except the two live send captures. Seen in the Simulator: the lock over an open sheet (the sheet survives), the privacy
cover in the app switcher above a sheet. Compiled or logic-tested only: camera scanner, confirmed / dropped / failed
tracker states, passkey add and revoke beyond the refusal, widgets inside WidgetKit, haptics. A release leak that predates
NEXT was found and fixed: the software test passkey and the fixtures were linked into Release builds (the old check missed
it); both are now linked in Debug only and the release check proves it.

## 4. Faults simulated, and what the rehearsal found

Simulated in tests: every endpoint down; one endpoint down; a lagging endpoint; endpoints disagreeing; truncated Solana
token list; a source refusing historical state; a relay answer lost (time-out, 5xx, unreadable body); an API restart between
signing and relaying; a stalled unauthenticated request to the signer; a halt recorded while a signature is computed; an
event stream resumed after a gap, a reset, duplicate ids; two approvals on one network at the same instant.

Found by the rehearsal on real data and fixed before release: portfolio cold read 19 s (now served from a warm cache,
stale said); deposit scan 88 s per pass (now 16 s); one unreadable network emptied the value chart; Litecoin balance
unavailable with one source down. Found after release (owner: "22/23 networks"): the dead Litecoin source — replaced.

## 5. Performance (measured)

| Measure | Before | After |
|---|---|---|
| Public page, time to first byte | 50–110 ms | 95 ms (one sample after release) |
| First paint, code (gzip) | 81 kB | 80 kB |
| `GET /portfolio`, cold, 23 networks | not measured before NEXT | 1.5–2.6 s typical; 19 s seen once before the serving fix; warm 4–6 ms |
| Deposit scan pass | not measured before NEXT (sequential) | 16 s |
| Migration on production data | — | 1.2 s, then 5–40 ms |
| Full test suite | 21 min (baseline, under load) | 2.6 min |

Not measured: load with several clients (single-owner wallet: three devices is the realistic maximum), memory and CPU of
the native apps, SwiftUI frame times.

## 6. Not verified

- A real signature through the new signer; a real ETH send on Arbitrum; a real native receive on an EVM network.
- Passkeys with Touch ID / Face ID on the new builds; widgets, notifications, camera, lock on real sleep.
- Two real devices synchronising live.
- The English text of the macOS app, proof-read on screen.
- Testnets: none were used (the dev stacks use a local fork of mainnet state with fake funds, or scripted chains).
