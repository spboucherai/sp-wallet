# Threat model (STRIDE-style summary)

Scope: one owner, balances of tens of USD. Owner of every control: Simon-Pierre Boucher. Severity is for the stated scope.

| # | Threat | Sev. | Abuse scenario | Prevention | Detection | Containment | Test | Residual |
|---|---|---|---|---|---|---|---|---|
| 1 | Stolen session cookie | High | attacker replays cookie, tries to send | cookie is `__Host-`, HttpOnly, Secure, SameSite=Strict, 30 min idle / 12 h max; a session cannot sign — passkey assertion required per transfer | audit log `transfer.*`, sessions list | revoke all sessions | api.test "a session alone cannot move funds" | attacker can read balances/history |
| 2 | XSS / malicious extension | High | script alters review screen or swaps address | CSP `script-src 'self'`, no inline script, no third-party scripts, React escaping | — | signer limits, halt | CSP header test | misleading display → loss ≤ daily limit |
| 3 | Dependency compromise | High | malicious package in API or web bundle | exact pinned versions + lockfile, small dependency set, bundles built once | — | signer limits; signer has its own bundle | — | signer bundle itself could be poisoned (noble/scure/viem/simplewebauthn) |
| 4 | Compromised API node | High | attacker has shell on node A | no keys on node A; signer verifies passkey + policy itself; HMAC only authenticates the channel | signer journal, audit chain | halt via signer CLI | signer.test, api.test "tampered stored intent" | can halt the service, show false data, wait for a real approval and swap intent before the prompt (bounded by limits) |
| 5 | Compromised signer node | Critical | root on node B | dedicated machine, no other apps, LAN-only port restricted to the API node IP, HMAC | signer journal hash chain | move funds to a fresh wallet | — | **total loss of wallet** (software keys) |
| 6 | Replayed approval | High | resend an old assertion/proposal | challenge = intent hash; proposal id single-use and persisted before signing; expiry ≤ 5 min; HMAC nonce cache | `sign.denied` in journal | — | signer.test replay | none known |
| 7 | Address poisoning / fraudulent QR | Med | look-alike address in history | first/last characters highlighted, new-destination warning + mandatory checkbox, look-alike detection, address book | — | limits | api.test warnings | owner inattention |
| 8 | Attacker-controlled or faulty RPC | Med | wrong nonce/balance/UTXO, fake deposit | two independent endpoints per chain must agree for anything that feeds a signature; chain id / genesis hash and USDC `symbol`/`decimals` verified on-chain; fail closed | network health screen | — | live smoke test | both providers colluding; display-only reads use one endpoint |
| 9 | Chain reorg | Low | confirmed tx disappears | states `confirming` → `finalized` only at chain finality (EVM `finalized` tag, BTC 6 conf, Solana `finalized`); `reorged` state + rebroadcast | activity screen | — | — | deep reorgs beyond finality |
| 10 | Token impersonation | High | fake "USDC" | assets resolved by pinned contract/mint address only, per network; signer refuses anything else | — | — | core.test, signer.test | none known |
| 11 | BTC UTXO/change redirection | High | change sent to attacker | signer rebuilds tx: all inputs from own address, change only to own address, inputs = outputs + fee, fee ceiling; BIP-143 commits to input values | — | — | core.test Bitcoin builder | none known |
| 12 | Solana instruction substitution | High | extra instruction drains account | signer builds the legacy message itself from a fixed instruction set; no lookup tables, no versioned tx, no opaque payload | — | — | core.test cross-check with @solana/kit decoder | none known |
| 13 | DNS takeover / proxy compromise | High | phishing origin | passkeys are origin-bound (rpId `wallet.spboucher.ai`); signer checks origin + rpId in every assertion; HSTS | — | — | signer.test wrong origin | TLS terminates on the OVH gateway: it sees traffic in clear |
| 14 | Physical theft of signer Mac | High | disk read | keystore encrypted, but wrap key on same disk, no FileVault | — | sweep funds with recovery phrase | — | **keys recoverable by thief** |
| 15 | Seed loss / disk failure | High | signer SSD dies | 24-word paper backup via `export-recovery` | — | restore on new node | keystore round-trip test | **until the phrase is written down, a disk failure loses the funds** |
| 16 | Lost phone / passkey | Med | cannot approve | iCloud-synced passkey; optional second passkey; `reset-passkeys` on signer CLI | — | — | signer.test enrollment | whoever has shell on the signer can re-enroll |
| 17 | Coercion | — | forced transfer | limits cap the loss | — | — | — | not mitigated |
| 18 | Ransomware / backup corruption | Med | DB destroyed | DB holds no keys; nightly dump; wallet state is on-chain | audit chain verification | redeploy, re-run setup | audit immutability test | history/labels since last dump |
| 19 | Insider/operator or AI agent misuse | Med | automation signs | no code path signs without a passkey assertion; `export-recovery` refuses non-interactive terminals | signer journal | halt | signer.test | an agent with shell on the signer node is equivalent to #5 |

Not done (required by the original specification before larger balances): independent penetration test, third-party review of
the custody boundary, signing-library provenance review, SBOM/SAST in CI, Bitcoin Core node (public Esplora indexers are used).
