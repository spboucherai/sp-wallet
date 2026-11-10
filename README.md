# SP Wallet

Private, single-owner, self-hosted multi-chain wallet — `wallet.spboucher.ai`, hosted on MacLustr.

- **Networks (mainnet):** Ethereum, Base, Arbitrum One, Polygon PoS, Bitcoin, Solana
- **Assets:** native coin of each network + native USDC (Circle) on the five networks that have it
- **Access:** one owner, passkey only (WebAuthn, user verification required). No password, no signup, no recovery by e-mail.
- **UI:** phone-first PWA, French/English, dark/light.

> Sized for a small balance (tens of USDC). It is a software hot wallet on a home cluster, not an HSM. Read
> `docs/adr/0001-custody.md` and `docs/threat-model/threat-model.md` before raising the limits.

## How a transfer is authorized

```
phone (passkey) ──HTTPS──▶ API (node A) ──HMAC, LAN──▶ isolated signer (node B, holds the keys)
```

1. The API drafts a transfer, checks balances on-chain, simulates it and pre-checks the signer limits.
2. `request-approval` freezes every chain parameter (nonce / UTXOs / blockhash, fees) into an **intent**, serialized
   deterministically and hashed (`SPW-INTENT-v1`, SHA-256).
3. The passkey signs a WebAuthn assertion whose **challenge is that hash**.
4. The signer — a separate process on a separate machine — verifies the assertion against the passkey public key it pinned at
   setup, re-checks its own limits / expiry / replay cache / halt flag, **rebuilds the transaction from the intent** (only native
   transfers and allowlisted USDC transfers can be expressed) and signs once.
5. The API relays the signed bytes and tracks them to finality. A returned hash is never shown as success.

A stolen session, a compromised API node or a tampered database cannot produce a signature: none of them holds the passkey, and
any changed field changes the hash. What they *can* do is listed in the threat model (mainly: show a misleading review screen).

## Layout

| Path | Role |
|---|---|
| `packages/core` | network/asset registry, exact amounts, address validation, canonical intent + hash, transaction builders (EVM, BTC, Solana), policy, audit hash chain, state machine |
| `services/isolated-signer` | keystore (scrypt + AES-256-GCM), key derivation, passkey verification, policy enforcement, signing; CLI |
| `services/api` | Fastify API: passkey auth, sessions, chain adapters with dual-RPC checks, transfer lifecycle, reconciliation worker, audit log; serves the web app |
| `apps/web` | Vite + React + Tailwind PWA |
| `tests/` | software passkey helper, Playwright e2e |
| `docs/` | custody ADR, threat model, runbooks |

Deviations from the original specification are listed in `docs/security/acceptance.md`.

## Commands

```bash
pnpm install
pnpm typecheck
pnpm test            # 38 unit/integration/security tests (needs local Postgres db "spw_test")
pnpm build           # dist/api.mjs, dist/signer.mjs, dist/web/
scripts/dev-stack.sh # local stack on http://localhost:8650, throwaway keys, broadcast OFF
pnpm e2e             # Playwright, phone viewport, virtual passkey (run dev-stack.sh first)
scripts/dev-stop.sh
```

## Signer CLI (on the signer machine)

```bash
node signer.mjs status           # key id, addresses, limits, journal integrity (no secrets)
node signer.mjs export-recovery  # interactive terminal only: prints the 24 words once, for paper backup
node signer.mjs halt | unhalt    # emergency stop / resume (then: pm2 restart sp-wallet-signer)
node signer.mjs reset-passkeys && node signer.mjs setup-token   # lost passkey: re-run owner setup
```

Limits live in `~/sp-wallet-signer-data/policy.json` on the signer machine (bump `version` when editing, then restart).
