# ADR 0001 — Custody model

Status: accepted by the owner on 2026-11-10 for small balances (owner instruction: real networks, 10–40 USDC, single user).
Amended on 2026-11-15 (V11 Phase B): the section "What the signer signs, and when it asks for the passkey" replaces two
statements of the original decision that had stopped being true ("every signature requires a fresh WebAuthn assertion",
"the signer can only express two transaction shapes per chain"). The decision itself — option (b) — is unchanged.

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

- keys exist only on the signer machine, which runs nothing else; the web/API runs on another machine;
- the signer pins the passkey public keys itself at setup and verifies every assertion independently of the API (origin and
  rpId from its own environment, user verification required);
- **the owner's wallet key (HD account 0) never signs a transaction without a fresh passkey assertion whose challenge is the
  hash of the canonical object being approved** — with one bounded exception, the first mint of a bridge the passkey already
  approved (row 6 of the table below);
- signer-side limits in `policy.json` on the signer machine: per-transfer and per-UTC-day amounts per asset, a fee ceiling per
  network, a maximum approval window, an optional destination allowlist; single-use proposals; since NFT delivery 2, an
  optional `nft` section (NFT transfers per day, ERC-1155 quantity cap, per-network standard switches, allow-list mode). The defaults compiled into
  the signer are about 50 USD per transfer and twice that per day (`packages/core/src/policy.ts`); the values in force are
  those of the file on the signer machine;
- an emergency halt that the API can set and that only an operator on the signer machine can lift;
- nothing the signer signs is taken from the API as an opaque payload: a transaction is rebuilt from the approved fields, or
  decoded and checked field by field; a venue action is read by the signer itself and must hash to what it read.

## What the signer signs, and when it asks for the passkey

The API authenticates to the signer as one process (HMAC over every request). The signer cannot tell the owner's session from
an agent or any other caller of the API: **everything it decides, it decides from the content of the request and from its own
stored state.** So the real custody statement is the list of what it will sign without a passkey, and what bounds each.

### With a passkey assertion over the canonical object (each operation)

Transfers on every supported network, swaps (KyberSwap, Jupiter), bridges (Circle CCTP burn; any further mint signature;
reclaim of a Solana event account; opening the wallet's Solana USDC account), native cross-chain swaps (THORChain), deposits to
a venue, GMX orders (increase, decrease, cancellation), a Hyperliquid order or leverage change in manual mode, a withdrawal
from a venue to the wallet's own address, and every grant of standing authority: an agent mandate, a venue authorization, a
derivative mandate, a GMX venue policy, the enrolment of another passkey.

Since NFT delivery 2 (2026-11-17), three more operations, each with a passkey assertion over its own canonical object
(`packages/core/src/nft-intent.ts` — new types under their own domain separators; the transfer intent of `intent.ts` is
unchanged and every existing kind hashes as before): **one NFT transfer** (`POST /nft/sign`, intent `SPW-NFT-INTENT-v1`:
ERC-721 / ERC-1155 `safeTransferFrom`, Solana Token-2022 `TransferChecked`, Token Metadata `Transfer` — programmable NFTs
included — and Core `TransferV1`, built by the signer from the intent's fields and re-read by an independent decoder before
signing); **a change of the outpoint lock list** of a Bitcoin-style network (`POST /utxo/locks`, `SPW-UTXO-LOCKS-v1`; an
ordinary send that names a locked outpoint is refused); **a change of the NFT destination allow-list** (`POST /nft/allow`,
`SPW-NFT-ALLOW-v1`). **No passkey-less path was added: the list below still has exactly seven rows.** What the signer does
not verify for an NFT transfer — it makes no chain read — is that the wallet owns the token and that the contract is of the
named standard: `docs/nft/NFT-TRANSFERS.md` §4 says why that cannot move another asset or grant an approval.

### Without a per-operation passkey — exactly seven paths

| # | Signer route | Key that signs | Standing authority it rests on | What bounds it, enforced by the signer alone |
|---|---|---|---|---|
| 1 | `POST /mandate/sign` — a swap inside an agent vault | the vault's key (HD account ≥ 1, never the owner's) | a spot mandate approved with the passkey | not halted, not revoked, not expired; one active mandate per vault; the mandated provider, network and assets only; spends from and delivers to the vault itself; per-order and daily volume per asset; orders per day; validity ≤ 300 s; fee ceiling of the policy; calldata rebuilt and checked; guaranteed output worth at least `1 − maxSlippageBps` of the input at the signer's own Coinbase + Kraken prices; replay marker. **Not bounded: the market loss of what the vault holds** (see `docs/V11-SECURITY-REVIEW.md`, "Spot mandate loss limit") |
| 2 | `POST /mandate/return` — a transfer out of a vault | the vault's key | none needed beyond the mandate record | destination must be the owner's own address; plain transfer only; validity ≤ 300 s; fee ceiling; replay marker. No amount limit and no halt check: it can only bring the owner's funds back to the owner |
| 3 | `POST /vault/return` — same, for a vault with no mandate or on another EVM network | the vault's key | none | as row 2; EVM networks only. Worst case for both rows: gas spent from the vault, at most the fee ceiling per call |
| 4 | `POST /venue/sign` — a **cancel** on Hyperliquid | the venue trading key (a dedicated key that can only sign orders, cancels and leverage changes) | a venue authorization approved with the passkey, not revoked, not expired | the action is read by the signer (`describe`, pinned asset table); allowed instruments only; a venue expiry ≤ 120 s; nonce never reused. A cancel can only remove an order. Signed under the emergency halt |
| 5 | `POST /venue/mandate/sign` — an order, a cancel or a leverage change on Hyperliquid for an automated strategy | the venue trading key | a derivative mandate approved with the passkey, extending an authorization | cancel: as row 4. Reduce-only order: instrument, order notional, price rule, client id never signed twice — also under halt and during the 24 h wind-down. Order that can add exposure: mandate active and not halted; orders per day and per hour; daily turnover; **the signer's own read of the venue account** (fresh, consistent, valued at its own prices): account value ≥ the mandate's floor, leverage setting ≤ the mandate's, worst-case position and gross exposure within the mandate. Leverage change: ≤ the mandate's, ≤ 20 a day, never a margin-mode change on an open position. The trading key cannot withdraw, transfer or approve another key |
| 6 | `POST /bridge/mint` — the **first** `receiveMessage` of a bridge | the owner's wallet key | the burn of that bridge, approved with the passkey | only the message that matches the stored approved bridge; mints the wallet's own burned USDC to the wallet's own address; one signature per bridge (an identical request gets the same bytes again; any other needs the passkey); fee ceiling of the destination network; not halted |
| 7 | `POST /venue/quoting/sign` (V11 market making) — a batch of post-only quotes, a batch of reduce-only orders, a cancel batch, or the venue's `scheduleCancel` | the venue trading key | a QUOTING mandate (`SPW-VENUE-QUOTING-MANDATE-v1`) approved with the passkey, extending a venue authorization; it excludes a derivative mandate on the same authorization (row 5) and the other way round | **cancel**: as row 4 (instruments of the authorization), never counted. **`scheduleCancel` with a time**: now + 6 s ≤ time ≤ now + `deadManSeconds` (≤ 120 s), validity ≤ 30 s; **without a time** (removal): only when the signer's own read shows no open order and its ledger holds no order that can still land. **Reduce-only batch** (≤ 20): one instrument of the mandate, limit orders only, every order reduce-only with a client id that is not live, each price within `maxReduceDeviationBps` of the signer's own mid, each notional ≤ `maxQuoteNotional`; no counter. **Quote batch** (≤ 20): mandate active (not in its wind-down), not halted, validity ≤ 30 s; every order `Alo` + limit + client id, one instrument of the mandate; each price in [`minHalfSpreadBps`, `maxDistanceBps`] on its own side of the signer's own mid (two exchanges, fail closed) — never at or through it; notional per quote; resting count and notional per side, resting total, worst-case inventory and gross (≤ the authorization's too) from the signer's OWN read of the venue plus everything it signed that can still land; account value ≥ `floorEquity`; the venue's leverage setting ≤ `maxLeverage`; a persisted token bucket, quotes per hour and per day, daily turnover; a `scheduleCancel` signed before, whose deadline is ≥ the batch's own venue expiry + 2 s; fewer than 8 presumed triggers of that switch today. Anything else — a trigger order, a `Gtc`/`Ioc` opening, `updateLeverage`, `modify`, a transfer, a withdrawal, a builder or vault field, a batch mixing quotes and reductions or two instruments — is refused. Verified against `services/isolated-signer/src/venue-quoting.ts` at the integration (2026-11-16). Worst case for a compromised API: `docs/V11-SECURITY-REVIEW.md`, "Live market making" |

Three properties hold for all seven: the request content is checked against state the signer stored after a passkey approval;
counters and replay markers are saved before a signature is returned; revoking the standing authority needs no passkey and is
final.

Requests that sign nothing and need no passkey: `GET /status`, `POST /halt`, the four revocations (`/mandate/revoke`,
`/venue/revoke`, `/venue/mandate/revoke`, `/venue/gmx/revoke`), `/venue/key`, `/vault/address`, and — since V11 —
`POST /venue/authorization`, which returns again the answer of an authorization the signer already stored (the `approveAgent`
signature the passkey approved; no new signature is made, nothing is returned for a revoked or expired authorization).

### Under the emergency halt (V11)

The halt stops everything that moves funds or adds risk: transfers, swaps, bridges, deposits, withdrawals from a venue, GMX
increases, orders that can open or add, leverage changes, every new authorization or mandate. It never blocks a risk
reduction: a cancel, a **reduce-only** Hyperliquid order (the flag is read by the signer from the payload the trading key
would sign; the passkey is still required in manual mode), a GMX **decrease** or **cancellation** (established from the
transaction the signer built itself: no collateral leaves, no approval, `MarketDecrease` or `cancelOrder`; the passkey is
still required). Vault returns to the owner (rows 2 and 3) are not halted either. Lifting the halt is an operator action on
the signer machine (`signer unhalt`), applied by the running daemon through a socket in its own data directory; no HTTP
route lifts it.

### What is enforced by the API only

In Hyperliquid manual mode and on GMX the signer bounds one order at a time (instrument or market, order size, price,
orders per day). Position size, gross exposure, loss limits, liquidation distance and the order rate per minute are checked
by the API's risk engine against the venue's state; a compromised API is not bound by them. Since V11, loosening one of
those API-side limits, lifting an API-side halt and re-basing a divergence need a passkey assertion that the **API** verifies
against its own copy of the enrolled passkeys: this protects against a stolen session, not against a compromised API.
`strategySha256` and `agentId` of a mandate are also API-checked only: the signer cannot know which code asked.

## Key derivation

One BIP-39 24-word phrase (256-bit entropy from the OS CSPRNG, generated on the signer). EVM: BIP-44 `m/44'/60'/0'/0/0`.
Bitcoin: BIP-84 `m/84'/0'/0'/0/0` (native SegWit P2WPKH; Taproot not used). Solana: SLIP-0010 ed25519 `m/44'/501'/0'/0'`.
Agent vaults: `m/44'/60'/<index ≥ 1>'/0/0`. Venue trading keys: `m/44'/60'/9000'/0/<i>` (index 9000 is refused as a vault).
Verified against public test vectors in `services/isolated-signer/test`.

## Residual risk (accepted for small balances only)

- Root or physical access to the signer Mac yields the keys: the wrap key sits on the same disk (needed for unattended restart)
  and the cluster nodes run without FileVault so they can reboot alone. Encryption at rest here protects backups and casual
  disclosure, not a seized or rooted machine.
- The review screen is rendered by the web app. A compromised API/web could show one operation and submit the hash of another;
  the passkey prompt does not display transaction details. Loss is bounded by the signer limits.
- A compromised API can use the seven paths above at any time, up to the bounds of the table, for as long as the standing
  authorities live (spot mandate ≤ 90 days, venue authorization ≤ 90 days, derivative mandate ≤ 30 days, quoting mandate
  ≤ 7 days). Path 7 is the highest-frequency one: it is bounded per signature and by persisted rates, not by a per-order
  count of the authorization (`maxOrdersPerDay` does not count quotes).
- One Bitcoin address is reused for receive and change (privacy trade-off, simpler recovery).
- NFT transfers (delivery 2): the loss bound of a swapped intent is not a small amount but **one NFT per approval** (at most
  `nft.maxTransfersPerDay` a day), to any address unless `nft.allowlistOnly` is on; an NFT sent is irreversible. Ownership
  and standard are established by the API, not by the signer. Never executed on a real network.
- No independent audit or penetration test has been performed. No derivative order was ever accepted by a venue on a funded
  account from this code (`docs/V11-AUDIT.md`, section 10).

Move to option (a) or (d) before holding amounts you would not accept to lose.
