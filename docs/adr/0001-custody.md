# ADR 0001 — Custody model

Status: accepted by the owner on 2026-11-10 for small balances (owner instruction: real networks, 10–40 USDC, single user).

## Options considered

| Option | secp256k1 ECDSA | Ed25519 | Approval binding | Recovery | Cost | Real boundary |
|---|---|---|---|---|---|---|
| (a) Hardware wallet / HSM as signer | yes | yes (most) | on-device screen (best) | vendor seed | $80–$250+, manual USB step per send | strong; keys never in RAM of a general computer |
| (b) **Isolated Mac process with encrypted software key** | yes (noble/viem) | yes (noble) | passkey assertion over intent hash | BIP-39 phrase | none | process + machine separation only; root on the signer Mac = keys |
| (c) Threshold / MPC | library-dependent | library-dependent | protocol-specific | complex | high complexity | good if done right; no hand-built MPC allowed |
| (d) Owner-managed hardware wallet, app watch-only | n/a | n/a | on device | vendor | low | strongest, but the app could not send |

Apple Secure Enclave was ruled out as a key store: it only generates and uses NIST P-256 keys, not secp256k1 or Ed25519, so it
cannot hold a blockchain key. It is used indirectly: the owner's passkey (P-256, Enclave-backed on Apple devices) is the approval
factor.

## Decision

Option (b), with these compensating controls:

- keys exist only on the signer machine (`m6ma`), which runs nothing else; the web/API runs on another machine;
- every signature requires a fresh WebAuthn assertion (user verification) whose challenge is the hash of the exact transfer;
  the signer pins the passkey public key itself at setup and verifies it independently of the API;
- signer-side limits: 50 USDC per transfer, 100 USDC per UTC day (similar small caps for native coins), fee ceilings,
  5-minute maximum approval window, single-use proposals, emergency halt that only the signer CLI can lift;
- the signer can only express two transaction shapes per chain (native transfer, allowlisted USDC transfer); there is no
  message-signing or arbitrary-transaction endpoint.

## Key derivation

One BIP-39 24-word phrase (256-bit entropy from the OS CSPRNG, generated on the signer). EVM: BIP-44 `m/44'/60'/0'/0/0`.
Bitcoin: BIP-84 `m/84'/0'/0'/0/0` (native SegWit P2WPKH; Taproot not used). Solana: SLIP-0010 ed25519 `m/44'/501'/0'/0'`.
Verified against public test vectors in `services/isolated-signer/test`.

## Residual risk (accepted for small balances only)

- Root or physical access to the signer Mac yields the keys: the wrap key sits on the same disk (needed for unattended restart)
  and the cluster nodes run without FileVault so they can reboot alone. Encryption at rest here protects backups and casual
  disclosure, not a seized or rooted machine.
- The review screen is rendered by the web app. A compromised API/web could show one transfer and submit the hash of another;
  the passkey prompt does not display transaction details. Loss is bounded by the signer limits.
- One Bitcoin address is reused for receive and change (privacy trade-off, simpler recovery).
- No independent audit or penetration test has been performed.

Move to option (a) or (d) before holding amounts you would not accept to lose.
