# CCTP (Circle Cross-Chain Transfer Protocol) — execution dossier

Provider id `cctp` · adapter `packages/swap/src/providers/cctp.ts` · tests `packages/swap/test/cctp.test.ts` ·
live check `scripts/smoke-swap-cctp.mts`. Everything below was read from Circle's documentation and source on
**2026-11-10** and, where marked *checked*, confirmed on mainnet the same day. In this phase the adapter only quotes
(`executability: quote_only`). Nothing builds, signs or sends a transaction.

CCTP is not a swap: a Circle stablecoin is **burned** on the source chain, Circle's attestation service (Iris) signs the
burn message, and the same amount is **minted** on the destination chain by whoever submits that signed message. There
is no pool, no price and no slippage; the only deductions are Circle's fee and gas on both sides.

## 1. What is served

| Wallet network | CCTP domain | Fast Transfer as source | Standard attestation | Fast attestation | EURC | Forwarding Service destination |
|---|---|---|---|---|---|---|
| ethereum | 0 | yes | ~15–19 min (~65 blocks) | ~20 s (2 blocks) | yes | yes |
| avalanche | 1 | n/a | ~8 s | — | yes | yes |
| optimism | 2 | yes | ~15–19 min (~65 ETH blocks) | ~8 s | no | yes |
| arbitrum | 3 | yes | ~15–19 min (~65 ETH blocks) | ~8 s | no | yes |
| solana | 5 | yes | ~17 s (32 blocks) | ~0.4–0.6 s | no (EVM only) | yes |
| base | 6 | yes | ~15–19 min (~65 ETH blocks) | ~8 s | yes | yes |
| polygon | 7 | n/a | ~8 s | — | no | yes |
| hyperevm | 19 | n/a | ~5 s | — | no | yes |

- USDC: all 56 ordered pairs among these eight networks, in both directions (*checked*: Iris answers every pair, and
  each chain's `TokenMessengerV2.remoteTokenMessengers(domain)` is the pinned messenger of the seven others).
- EURC: the six ordered pairs among ethereum, avalanche and base, through the separate "CCTP for non-USDC" product (§8).
- Only the registry's own USDC / EURC deployments qualify. The adapter resolves both assets through `resolveAsset()` and
  refuses anything else (bridged USDC.e, another mint, another symbol) without any HTTP call.
- Domains are Circle identifiers, not chain ids. Source: <https://developers.circle.com/cctp/concepts/supported-chains-and-domains>.
  Times: <https://developers.circle.com/cctp/concepts/finality-and-block-confirmations>. The adapter reports the upper
  bound of the documented range (19 min = 1140 s; Solana Fast rounded up to 1 s) as `estimatedSeconds`. That figure is
  the time for the attestation to become available; it excludes the inclusion of the burn and of the mint.
- "n/a" = Circle does not offer Fast from that source because Standard is already fast. Iris still returns a
  `finalityThreshold: 1000` entry with `minimumFee: 0` for those sources; the adapter emits Standard only.

Not served, and why:

| Network | Reason |
|---|---|
| bsc | Domain 17 exists but carries USYC only: "USDC: supported on all CCTP domains except BNB Smart Chain". |
| stellar, sui, aptos | CCTP chains, but the wallet registry has no USDC there. Stellar additionally needs `CctpForwarder` and has 7-decimal USDC. Adding them means registry work first. |
| tron, xrpl, cosmos, near, ton, UTXO chains | No CCTP deployment. (Noble, domain 4, is V1-only and is being retired.) |

### V2 only
What Circle now calls "CCTP" is CCTP V2. CCTP V1 ("Legacy") is being retired: deprecation "begins October 31, 2026 and
completes on December 1, 2026"; message limits tighten until no new burn can be initiated, pending redemptions stay
available (<https://developers.circle.com/cctp/migration-from-v1-to-v2>). The adapter therefore never quotes V1 and the
signer must **refuse** V1 targets. V1 is documented in §9 only so those calls can be recognised.

## 2. Contracts and programs (pinned)

CCTP V2, EVM — the same address on every chain (<https://developers.circle.com/cctp/references/contract-addresses>):

| Contract | Address | Role |
|---|---|---|
| TokenMessengerV2 | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` | entry point of the burn; **spender** of the USDC approval |
| MessageTransmitterV2 | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` | emits the message on the source, `receiveMessage` on the destination |
| TokenMinterV2 | `0xfd78EE919681417d192449715b2594ab58f5D002` | burns / mints; holds the per-message burn limit |
| MessageV2 (helper) | `0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78` | address ↔ bytes32 helpers, not needed |
| TokenMessengerWithFees | `0x71f54F818671cD0D7ea140Da213e5C8b5C92a408` | upfront-fee wrapper, **not used** (§5) |

CCTP V2, Solana (<https://developers.circle.com/cctp/references/solana-programs>): `MessageTransmitterV2`
`CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC`, `TokenMessengerMinterV2` `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`.

Source code: <https://github.com/circlefin/evm-cctp-contracts> (`src/v2/`), <https://github.com/circlefin/solana-cctp-contracts>
(`programs/v2/`). Audits (ChainSecurity, OtterSec) are linked from <https://developers.circle.com/cctp/references/technical-guide>.

*Checked on-chain* by the smoke script for all eight networks: code present at each address; `MessageTransmitterV2.localDomain()`
equals the pinned domain; `version()` = 1 and `TokenMessengerV2.messageBodyVersion()` = 1 (the V2 formats);
`localMessageTransmitter()` and `localMinter()` point at the pinned contracts; `TokenMinterV2.burnLimitsPerMessage(registry USDC)`
= 10 000 000 USDC (so the registry token is the burnable one and the documented limit holds); on Solana both programs
are executable, the `message_transmitter` state account reports `local_domain` 5 / `version` 1, and the `local_token`
account of the registry mint exists.

**Upgradeability — a trust statement, not a detail.** The EVM TokenMessengerV2 and MessageTransmitterV2 addresses are
proxies (2 175 bytes of code each) and the Solana programs are owned by the upgradeable BPF loader. Pinning the address
pins *where* the call goes, not the code behind it: Circle can change the implementation. The same party issues USDC
and can freeze it, so this adds no new trusted party, but the signer cannot claim more than "the pinned Circle
contract". A version check at API start (`localDomain`, `version`, `messageBodyVersion`, as in the smoke script) should
disable the provider if they ever change.

## 3. Circle API (Iris)

Host `https://iris-api.circle.com` (mainnet; sandbox `https://iris-api-sandbox.circle.com`), version prefix `/v2`.
**Keyless.** Rate limit: 40 requests per second; exceeding it blocks all requests for five minutes (HTTP 429). One quote
costs two requests (USDC) — fee schedule and Fast allowance — far below the wallet's own token bucket.

| Endpoint | Use | Shape (recorded in `test/fixtures/cctp/`) |
|---|---|---|
| `GET /v2/burn/USDC/fees/{src}/{dst}[?forward=true][&includeRecipientSetup=true]` | fee schedule of a route | `[{finalityThreshold: 1000\|2000, minimumFee: <bps, may be fractional>, forwardFee?: {low, med, high}}]`; 400 `{"error":"Invalid source/destination domain id"}` for an unserved pair |
| `GET /v2/fastBurn/USDC/allowance` | remaining global Fast allowance | `{allowance: <USDC, decimal>, lastUpdated}` |
| `GET /v2/messages/{srcDomain}?transactionHash=…` (or `nonce=`) | message + attestation of a burn | §6 |
| `POST /v2/reattest/{nonce}` | new attestation for an expired Fast message, or finality upgrade | — |
| `GET /v2/publicKeys` | attester keys per CCTP version | `{publicKeys:[{publicKey, cctpVersion}]}` (2 keys for V2 today) |
| `POST /v2/quote/cctpx/{tokenId}/{src}/{dst}` | signed fee quote, non-USDC assets | §8 |
| `GET /v2/cctpx/tokens`, `GET /v2/cctpx/allowances` | non-USDC token deployments / Fast allowances | §8 |

`/v2/fastBurn/USDC/fees` is deprecated; V1 used `/v1/attestations/{hash}` and `/v1/messages/{domain}/{txHash}`.
Reference: <https://developers.circle.com/cctp/references/technical-guide#api-hosts-and-endpoints>.

Terms: the endpoints are public and unauthenticated; the documentation states no usage restriction beyond the rate
limit. Circle's general constraints still apply to the asset itself — USDC can be frozen by the issuer, and
`TokenMessengerV2` has its own denylist (`notDenylistedCallers`; a `denylist_account` PDA on Solana) and pause switch.
No affiliate or integrator fee exists in the protocol ("CCTP has no built-in mechanism for adding a custom application
fee").

## 4. Fees

Source: <https://developers.circle.com/cctp/concepts/fees>. "For USDC, CCTP charges fees on Fast Transfers only.
Standard Transfers are free." The fee is "deducted from the transferred amount when USDC is minted on the destination".

Live schedule among the wallet's networks (2026-11-11, from the smoke script; "do not hardcode" — the adapter reads it
on every quote):

| Source | Fast fee to every wallet destination | Standard |
|---|---|---|
| ethereum, solana | 1 bps | 0 |
| base, optimism | 1.3 bps | 0 |
| arbitrum | 1.4 bps | 0 |
| avalanche, polygon, hyperevm | Fast not offered | 0 |

**Rounding** (not documented; measured). For real Fast burns from Arbitrum at 1.4 bps, Iris's `feeExecuted` is
`floor(amount × bps / 10 000)`:

| Source tx (Arbitrum) | amount | maxFee | feeExecuted | amount × 1.4 / 10⁴ |
|---|---|---|---|---|
| `0x2ff6976b…47aaac` (recorded as a fixture) | 100 584 300 | 14 363 | 14 081 | 14 081.80 |
| `0x93677e89…43adb7` | 9 966 740 | 1 396 | 1 395 | 1 395.34 |
| `0x7d737c74…b97f90` | 1 739 483 528 | 243 528 | 243 527 | 243 527.69 |

So the adapter reports `fee = floor(…)` as the protocol `FeeItem` (`includedInOutput: true`, asset = destination USDC),
`amountOut = amountIn − fee`, and plans `maxFee = ceil(…)`, hence `minAmountOut = amountIn − maxFee`. The contract
enforces `feeExecuted ≤ maxFee` at mint, so `minAmountOut` is a hard guarantee, not an estimate. A `maxFee` equal to
the rounded-up fee is what integrators submit in practice (second and third rows). If the fee rises between quote and
burn, `maxFee` is too small and the transfer is **attested as Standard instead** (slower, no fee, no loss); if it
falls, less is deducted. The request's `slippageBps` is deliberately not applied: there is no price to slip.

- Standard fee switch: some `TokenMessengerV2` deployments can enforce a minimum on-chain fee for Standard
  (`getMinFeeAmount`). None of the wallet's eight networks has it (the fee-switch build is on Sei only). The adapter
  already applies the `finalityThreshold: 2000` `minimumFee` with the same arithmetic if it ever becomes non-zero.
- Fast allowance: Fast burns draw on a global Circle allowance (53 M USDC at the time of the check). The adapter emits a
  Fast quote only when the allowance covers `amountIn`.
- Limits: 10 000 000 USDC per burn (on-chain `burnLimitsPerMessage`); `maxFee < amount` is required by the contract, so
  a one-base-unit Fast transfer does not exist.
- Gas, both sides, as `network` `FeeItem`s (`includedInOutput: false`, `estimated: true`), from one `eth_gasPrice`
  per EVM side against the registry's RPC endpoints (second endpoint on failure) times pinned gas units:

  | Step | Pinned units | Measured on mainnet 2026-11-10 |
  |---|---|---|
  | USDC `approve` | 60 000 | not sampled (standard ERC-20 approve) |
  | `depositForBurn` | 120 000 | 104 521 – 114 174 (Arbitrum, direct calls) |
  | `receiveMessage` (USDC) | 200 000 | 154 526 – 187 119 (Arbitrum) |
  | `crossChainTransfer` (non-USDC) | 380 000 | 242 200 – 369 453 (Ethereum, all tokens) |
  | `receiveMessage` (non-USDC) | 240 000 | 212 638 – 229 733 (Ethereum) |

  OP-stack L1 data fees (base, optimism) are not included; priority fees are not included.
- Solana, read live with `getMinimumBalanceForRentExemption` (rent is no longer the constant older documents quote):
  source = 2 signatures × 5 000 lamports + rent of the 428-byte `MessageSent` account (2 824 480 lamports, **refundable**
  after five days through `reclaim_event_account`); destination = 5 000 lamports + rent of the 9-byte `used_nonce`
  record (695 960 lamports, not refundable) + rent of a 165-byte token account (1 488 440 lamports) when the recipient
  has no USDC token account — the adapter checks that with `getTokenAccountsByOwner` in the same RPC batch and prices it
  in when the account is missing or the recipient is a placeholder. Sizes *checked* against real transactions
  (`5snQDybx…`: 2 signatures, account of 428 bytes; `mLPkABDq…`: +695 960 lamports).

## 5. Who submits the mint

Without a relayer the destination mint is a second transaction that **the wallet must submit and pay in the destination
chain's coin**. This is the practical constraint of CCTP for a wallet: a user bridging USDC to a chain where they hold
no gas cannot finish alone. The adapter models it as a `network` `FeeItem` on the destination chain and writes it into
the step (`"mint on base: …; the wallet submits the mint itself and needs ETH on base for it"`).

Alternatives Circle offers, **not used in this phase**:

- **Forwarding Service** (<https://developers.circle.com/cctp/concepts/forwarding-service>): the burn is made with
  `depositForBurnWithHook` and the fixed 32-byte hook `0x636374702d666f72776172640000000000000000000000000000000000000000`
  (`"cctp-forward"`, version 0, length 0); Circle then broadcasts the mint and takes a fee from the minted amount
  (gas + USD 0.05 service fee; `maxFee` must cover the Fast fee **and** the forwarding fee). The live fee is returned
  by the fee endpoint with `?forward=true` and kept in `raw.forwardingService` (USDC base units; from ethereum on
  2026-11-11: ~0.05–0.09 USDC to L2s/Solana, ~0.87 USDC to Ethereum). To Solana the recipient's token account must
  exist, or the hook must carry the ATA-creation extension and the fee must be asked with `includeRecipientSetup=true`.
  This is the natural second step for the wallet; its verification story is in §7.4.
- **Upfront fees** (`TokenMessengerWithFees`, signed quote, fee paid in the source coin so the full amount is minted):
  needs a Circle-signed blob the signer cannot rebuild. Not used.

## 6. Message and attestation

`GET /v2/messages/{srcDomain}?transactionHash={burnTx}` — 404 `{"error":"Message not found…"}` until Iris has seen
the burn (normal: keep polling), then

```json
{ "messages": [ { "status": "pending_confirmations" | "complete", "message": "0x…", "attestation": "0x…",
    "eventNonce": "0x…", "cctpVersion": 2, "decodedMessage": { … }, "delayReason": null,
    "destinationMintTxHash": "0x…" } ], "sourceTxHash": "0x…" }
```

A real answer is recorded in `test/fixtures/cctp/message-arbitrum-base-fast.json`. `decodedMessage` is a convenience
and must **not** be trusted: the signer parses `message` itself. Layout
(<https://developers.circle.com/cctp/references/technical-guide#message-format>), implemented and tested against that
fixture as `decodeCctpMessageV2()`:

| Header field | Offset | Bytes | | Body field (offset from 148) | Offset | Bytes |
|---|---|---|---|---|---|---|
| version (= 1) | 0 | 4 | | version (= 1) | 0 | 4 |
| sourceDomain | 4 | 4 | | burnToken | 4 | 32 |
| destinationDomain | 8 | 4 | | mintRecipient | 36 | 32 |
| nonce (assigned by Iris) | 12 | 32 | | amount | 68 | 32 |
| sender (source TokenMessenger) | 44 | 32 | | messageSender (who burned) | 100 | 32 |
| recipient (destination TokenMessenger) | 76 | 32 | | maxFee | 132 | 32 |
| destinationCaller | 108 | 32 | | feeExecuted | 164 | 32 |
| minFinalityThreshold | 140 | 4 | | expirationBlock | 196 | 32 |
| finalityThresholdExecuted | 144 | 4 | | hookData | 228 | rest |

The attestation is a concatenation of 65-byte ECDSA signatures (r, s, v) over `keccak256(message)`; the contract checks
them against its enabled attesters (signature threshold, ascending signer order). Verifying it off-chain against
`/v2/publicKeys` is optional (<https://developers.circle.com/cctp/references/attestation-verification>): a bad
attestation only makes the mint revert.

`expirationBlock`: 0 for Standard (*checked* on a real Standard message) — the attestation never expires. Fast messages
carry a block about 24 h ahead on the destination chain (on Arbitrum it is an Ethereum L1 block number); after it,
`POST /v2/reattest/{nonce}` yields a fresh attestation, "no deadline after which re-attestation becomes unavailable".

## 7. Execution path and what the signer can verify

### 7.1 EVM source — two transactions

1. **Approval**: `USDC.approve(spender, amount)` — selector `0x095ea7b3`, `to` = the registry USDC of the source
   network, `spender` = TokenMessengerV2 (it calls `transferFrom(sender → TokenMinter)` then burns), `amount` = exactly
   the burn amount. Never an unlimited allowance; `value` = 0. Nothing else needs an approval for USDC.
2. **Burn**: `to` = TokenMessengerV2, `value` = 0, calldata = selector `0x8e0250ee` + seven static words (228 bytes):

   `depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)`

   Selector *checked* against live mainnet transactions. Contract-side requirements (source `TokenMessengerV2.sol`):
   `amount > 0`, `mintRecipient ≠ 0`, `maxFee < amount`, a remote TokenMessenger registered for the domain, caller not
   denylisted, amount within the burn limit.

Every argument is derivable from the approved intent, so the signer can rebuild the calldata byte for byte:

| Field | The signer requires |
|---|---|
| `to` | the pinned TokenMessengerV2 (same constant on all seven EVM networks), on the intent's chain id |
| `amount` | = intent amount (and = the approval's amount) |
| `destinationDomain` | = `CCTP_CHAINS[intent.destinationNetwork].domain`, from its own pinned table, ≠ the source domain |
| `mintRecipient` | EVM destination: `0x000000000000000000000000 ‖ address` of **the wallet's own address** on the destination network. Solana destination: the 32 raw bytes of the **associated token account** of (wallet's Solana address, registry USDC mint) — derived by the signer with `associatedTokenAddress()`, never taken from the API |
| `burnToken` | = the registry USDC of the source network |
| `destinationCaller` | = `bytes32(0)` |
| `maxFee` | ≤ the fee ceiling shown to the user in the intent (0 for Standard); `< amount` |
| `minFinalityThreshold` | exactly 1000 (Fast) or 2000 (Standard), as approved |
| selector | `0x8e0250ee` only — `depositForBurnWithHook` (`0x779b432d`), the V1 selectors and the fee wrapper are refused |

**The Solana-recipient trap.** For a Solana destination `mintRecipient` is the *token account*, not the wallet
address. If the wallet address itself were encoded, `receive_message` could never succeed (the `user_token_account`
passed to the program "must match the mintRecipient" and must be a token account), and CCTP V2 has no way to redirect
a burn (`replaceDepositForBurn()`: "No V2 equivalent available"). The burned USDC would be unrecoverable. This is the
single most important check on the burn, and the reason the signer must derive the account itself.

**Why `destinationCaller` must be zero.** A non-zero value restricts `receiveMessage` to that one address ("Invalid
caller for message" otherwise). It exists for integrators that wrap the mint in their own contract. For a wallet it can
only hurt: a wrong value locks the mint behind an address the user may not control, and even the correct one removes
the safety net that *anyone* can finish the transfer. Zero keeps the mint permissionless, and harmless: whoever
submits it, USDC goes to `mintRecipient`.

**Why hooks must be absent.** `hookData` is opaque metadata that CCTP itself does not execute; it only matters to a
destination contract that reads it. With `mintRecipient` = the wallet's own account nothing reads it, so the only
safe value is none — which is exactly what `depositForBurn` produces (`hookData.length == 0`, checked at parse time
as "message length = 376 bytes"). The one hook with protocol-level meaning is the Forwarding Service's (§7.4).

### 7.2 Solana source — one transaction, two signatures

Program `TokenMessengerMinterV2`, Anchor instruction `deposit_for_burn`: data = discriminator `d73c3d2e723780b0`
(`sha256("global:deposit_for_burn")[0..8]`) + Borsh `amount u64 LE ‖ destination_domain u32 LE ‖ mint_recipient [32] ‖
destination_caller [32] ‖ max_fee u64 LE ‖ min_finality_threshold u32 LE` = 96 bytes. Accounts, in order (from
`deposit_for_burn.rs`; `#[event_cpi]` appends the last two):

| # | Account | Derivation | Signer / writable |
|---|---|---|---|
| 1 | owner | the wallet | signer |
| 2 | event_rent_payer | the wallet | signer, writable |
| 3 | sender_authority_pda | `["sender_authority"]` @ TokenMessengerMinterV2 | — |
| 4 | burn_token_account | the wallet's USDC associated token account | writable |
| 5 | denylist_account | `["denylist_account", owner]` @ TokenMessengerMinterV2 (must not exist) | — |
| 6 | message_transmitter | `["message_transmitter"]` @ MessageTransmitterV2 | writable |
| 7 | token_messenger | `["token_messenger"]` @ TokenMessengerMinterV2 | — |
| 8 | remote_token_messenger | `["remote_token_messenger", domain as decimal string]` @ TokenMessengerMinterV2 | — |
| 9 | token_minter | `["token_minter"]` @ TokenMessengerMinterV2 | — |
| 10 | local_token | `["local_token", mint]` @ TokenMessengerMinterV2 | writable |
| 11 | burn_token_mint | the registry USDC mint | writable |
| 12 | message_sent_event_data | a **fresh keypair** (any uninitialised non-PDA address) | signer, writable |
| 13 | message_transmitter_program | `CCTPV2Sm4…` | — |
| 14 | token_messenger_minter_program | `CCTPV2vPZ…` | — |
| 15 | token_program | SPL Token | — |
| 16 | system_program | — | — |
| 17 | event_authority | `["__event_authority"]` @ TokenMessengerMinterV2 | — |
| 18 | program | `CCTPV2vPZ…` | — |

The seed spelling of rows 3 and 8 is taken from the V2 source and from the receive-side table in Circle's docs; it has
**not** been exercised by a built transaction yet and must be confirmed by simulation in the next phase (only
`message_transmitter` and `local_token` were derived and read on mainnet by the smoke script).

Consequences for the signer: (a) no token approval — the owner signs the burn of its own token account; (b) a second,
ephemeral signature is needed for account 12. The signer should generate that keypair itself, sign, and discard it:
the account only stores the event, and its rent comes back to `event_rent_payer` through `reclaim_event_account`
(discriminator `5ec6b49f83ec0fae`) five days later — a follow-up transaction the wallet should offer; (c) the
argument checks are those of §7.1 (`mint_recipient` for an EVM destination is the 20-byte address left-padded to 32
bytes; `destination_caller` = `Pubkey::default()`); (d) any extra instruction other than compute-budget ones is refused.

### 7.3 The mint leg

EVM destination: `to` = MessageTransmitterV2, `value` = 0, `receiveMessage(bytes message, bytes attestation)`, selector
`0x57ecfd28` (*checked* on mainnet), standard ABI encoding of two dynamic byte strings. The bytes come from Iris, so
this is the one place where provider data enters a transaction. The signer parses `message` (§6) and requires:

| Check | Why |
|---|---|
| `version` = 1, body `version` = 1, length = 376 bytes (no hook) | the format it knows; no hook |
| `sourceDomain`, `destinationDomain` = the intent's networks; `to` is on the destination chain | right route |
| `sender` and `recipient` = the pinned TokenMessenger of each side (bytes32) | a burn message of CCTP, not an arbitrary message |
| `destinationCaller` = 0 | as burned |
| body `burnToken` = registry USDC of the source; `mintRecipient` = the wallet's own destination account; `amount` = the intent amount; `messageSender` = the wallet's source address | this is *our* burn |
| `feeExecuted ≤ maxFee ≤` approved ceiling; `finalityThresholdExecuted` ≥ what was approved, or the user is told it was attested Fast/Standard | the fee the user accepted |
| attestation length is a multiple of 65 | shape |

What the signature on this transaction can cost is only gas: `receiveMessage` moves no funds of the caller, and the
mint goes to the message's `mintRecipient` whatever the caller. A forged message cannot pass the on-chain attester
check. The signer therefore bounds gas (limit and fee cap from the intent) and applies the table above so that the
wallet only ever pays to finish its own transfer. The API pairs the mint with its burn through `transactionHash`; the
signer does not need that link, the message content is self-describing.

Solana destination: program `MessageTransmitterV2`, instruction `receive_message` (discriminator `26907fe11fe1ee19`),
data = Borsh `message: Vec<u8>` ‖ `attestation: Vec<u8>` (u32 LE length prefixes). Accounts (`receive_message.rs`):
payer (signer, writable), caller (signer), `authority_pda` `["message_transmitter_authority", receiver program]`,
`message_transmitter`, `used_nonce` `["used_nonce", message[12..44]]` (created here, rent paid by payer),
receiver = TokenMessengerMinterV2, system program, event authority, program; then the remaining accounts Circle lists:
`token_messenger`, `remote_token_messenger` `["remote_token_messenger", sourceDomain]`, `token_minter`, `local_token`,
`token_pair` `["token_pair", sourceDomain, source token bytes]`, **user_token_account** (must equal `mintRecipient`),
`custody` `["custody", mint]`, SPL Token program, the TokenMessengerMinter event authority and program id. The
recipient's token account must exist: the transaction is prefixed with an idempotent create-associated-token-account
instruction when it does not. Same message checks as above, with `mintRecipient` = the signer-derived token account.

### 7.4 Path to `executability: verified`

1. Intent: add a CCTP section (destination network, transfer speed, fee ceiling, the wallet's destination address as
   derived from the same key set) so the user approves the route, not calldata.
2. `packages/core`: `buildCctpApprove`, `buildCctpBurn` (EVM, Solana) and `buildCctpMint` that take only the intent
   (+ `message`/`attestation` for the mint) and the pinned tables; unit tests against the recorded mainnet calldata.
3. Signer: rebuild and compare, with the tables of §7.1–7.3; refuse V1, hooks, wrappers, non-zero `destinationCaller`,
   allowances above the amount.
4. API: tracking through `GET /v2/messages`, state machine burned → attested → minted, re-attestation, resumable from
   the burn transaction hash alone (the transfer must survive a lost session: the attestation is public).
5. Destination gas: refuse to start a transfer when the wallet cannot pay the mint, or use the Forwarding Service.
   Forwarding is verifiable to the same degree: the hook is a constant, `mintRecipient` is unchanged, and the mint
   needs no second signature; what changes is that `maxFee` then includes Circle's forwarding fee (a live number the
   signer can only bound against the approved ceiling) and that completion depends on Circle's relayer — with the
   permissionless self-mint still available as a fallback, since `destinationCaller` stays zero.
6. Simulation of each built transaction before it is proposed (Solana account lists in particular).

Until then the quotes say `quote_only`, with the reason attached.

## 8. EURC ("CCTP for non-USDC")

EURC does not go through TokenMessengerV2 (`/v2/burn/EURC/fees` does not exist). It uses a separate product built on
the same message transmitter and attestation service (<https://developers.circle.com/cctp/expanded-assets>), **EVM
only**. Iris lists EURC as enabled on Ethereum, Avalanche, Base (the registry's three EVM deployments, *checked*
against `GET /v2/cctpx/tokens`), plus World Chain and Arc.

| Item | Value |
|---|---|
| CrossChainTokenService | `0x431871229103b780868f8C6BB820cd16ECf942BC` (same on every chain) |
| EURC TokenManager — the **approval spender** | `0x8c27579e24f9f19d96724e19fc059dacd1469e10` |
| EURC token id | `0x6ca9e29fa53becc29becaf4a90b9ca7a995ad4d2234880da13ca38c657fb241c` |

Addresses: <https://developers.circle.com/cctp/expanded-assets/references/contract-addresses>; *checked*:
`resolveTokenManager(tokenId)` and `resolveTokenAddress(tokenId)` return the pinned manager and the registry EURC on
all three networks.

Fees (<https://developers.circle.com/cctp/expanded-assets/references/fees>): a transfer fee of USD 0.25 on Standard and
Fast, plus the Fast fee (1 bp from Ethereum, 1–1.3 bps from Base, none from Avalanche), **paid in the source chain's
coin at transfer time**, "so the recipient receives the full transferred amount". The exact figure comes from
`POST /v2/quote/cctpx/{tokenId}/{src}/{dst}` with `{amount, feeToken: 0x0, requests: [] | [{type:"PRE_FINALITY"}]}`,
which returns `{signedQuote, issuedAt, expiry:{mode:"TIMESTAMP", expiresAt}, feeTotalAmount, feeToken, items:[{type:
"PROTOCOL"|"PRE_FINALITY", amount, args, argsHash}], nonce}`; quotes are valid 120 s. The adapter maps each item to a
`protocol` `FeeItem` in the source coin (`includedInOutput: false`, not an estimate), sets `amountOut = minAmountOut =
amountIn` and `expiresAt` to the quote's own expiry, and rejects a quote whose items do not add up, name another token
or amount, or carry a fee type that was not requested. When Iris refuses the fast quote (allowance or FX pricing
unavailable — "there is no automatic fallback") only Standard is returned.

Execution: `EURC.approve(TokenManager, amount)`, then on the service (selector `0x780c5acf`, *checked* on mainnet)

`crossChainTransfer(bytes32 tokenId, uint256 amount, uint32 destinationDomain, bytes destinationAddress, bytes32 destinationCaller, uint32 minFinalityThreshold, (bytes signedQuote, address refundAddress) claim, bool autoExecuteHookData, bytes hookData)` with `msg.value = feeTotalAmount`;

`destinationAddress` is the raw 20-byte address (not padded). The mint is `MessageTransmitterV2.receiveMessage` on the
destination, as for USDC. The signer can check every argument except `signedQuote`, a Circle-signed blob it cannot
rebuild; it can bound what that blob costs (`msg.value` ≤ approved fee) and nothing more. That makes EURC `opaque` at
best, and the message body format of this product (`decodedCctpXMessageBody`) has not been analysed here. EURC is
quoted so the router can show the route; its execution is a separate piece of work.

## 9. CCTP V1 (legacy) — for recognition only

Retiring by 1 December 2026; never quoted, never to be signed. Addresses
(<https://developers.circle.com/cctp/v1/evm-smart-contracts>):

| Network | TokenMessenger | MessageTransmitter |
|---|---|---|
| ethereum | `0xBd3fa81B58Ba92a82136038B25aDec7066af3155` | `0x0a992d191DEeC32aFe36203Ad87D7d289a738F81` |
| avalanche | `0x6B25532e1060CE10cc3B0A99e5683b91BFDe6982` | `0x8186359aF5F57FbB40c6b14A588d2A59C0C29880` |
| optimism | `0x2B4069517957735bE00ceE0fadAE88a26365528f` | `0x4D41f22c5a0e5c74090899E5a8Fb597a8842b3e8` |
| arbitrum | `0x19330d10D9Cc8751218eaf51E8885D058642E08A` | `0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca` |
| base | `0x1682Ae6375C4E4A97e4B583BC394c861A46D8962` | `0xAD09780d193884d503182aD4588450C416D6F9D4` |
| polygon | `0x9daF8c91AEFAE50b9c0E69629D3F6Ca40cA3B3FE` | `0xF3be9355363857F3e001be68856A2f96b4C39Ba9` |
| solana | `CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3` (TokenMessengerMinter) | `CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd` |

HyperEVM has no V1. ABI: `depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address
burnToken)` (`0x6fd3504e`), `depositForBurnWithCaller(…, bytes32 destinationCaller)` (`0xf856ddb6`),
`replaceDepositForBurn(…)`, `receiveMessage(bytes, bytes)` (same selector as V2). No fee, no `maxFee`, no finality
choice (Standard only). Message: header of 116 bytes (version 0, source, destination, `uint64` sequential nonce at
offset 12, sender 20, recipient 52, destinationCaller 84), body version 0 with burnToken / mintRecipient / amount /
messageSender at 4 / 36 / 68 / 100. Attestations: `GET /v1/attestations/{keccak256(message)}`.

## 10. Failure and recovery

| Situation | What happens | Recovery |
|---|---|---|
| Approval confirmed, burn never sent | An exact-amount allowance to TokenMessengerV2 remains | Send the burn later, or `approve(spender, 0)` |
| Burn reverts (fee above `maxFee` on a fee-switch chain, denylist, pause, limit) | Nothing is burned | None needed |
| Fast fee rose above `maxFee`, or the Fast allowance is exhausted | The burn is attested at finality instead | Wait the Standard time; no fee is charged |
| Attestation not available (404 / `pending_confirmations`) | Normal until the source chain reaches the threshold; `delayReason` explains anomalies | Keep polling `GET /v2/messages` |
| Mint transaction fails for gas | Nothing is consumed; the nonce is unused | Resubmit — by the wallet or by anyone |
| "Nonce already used" | The mint already happened (someone relayed it) | Check the recipient balance |
| Fast attestation past `expirationBlock` | Mint reverts "Message expired and must be re-signed" | `POST /v2/reattest/{nonce}`, poll, mint; no deadline |
| Solana recipient token account missing | `receive_message` reverts | Create the account, resubmit |
| Wallet has no gas on the destination | The transfer waits, attested | Fund the destination account, or have anyone submit `message` + `attestation` |
| Destination contract paused / recipient frozen by Circle | Mint reverts | Outside the wallet's control |
| Wrong `mintRecipient` (e.g. a Solana wallet address instead of its token account) | The burn cannot be redirected in V2 | **None** — prevented only by the signer's check (§7.1) |
| Session lost between burn and mint | Nothing is lost: message and attestation are public | Recover from the burn transaction hash |

**Refundability.** `refundable: false`, and that is exact: there is no path by which burned USDC returns to the sender
on the source chain. It is equally exact that the funds are **not lost** when the mint is not submitted: they remain
mintable — only to `mintRecipient`, by anyone holding the public attestation — with no expiry for Standard and
unlimited re-attestation for Fast. The quote carries this sentence in `raw.ifMintNeverSubmitted`. `atomic: false`: at
least two transactions on two chains (three with the EVM approval).

## 11. What is verified, and what is not

Verified live (smoke script, 2026-11-11): the pinned addresses, domains, versions and wiring on all eight networks; the
10 M burn limit; the fee schedule of the 56 USDC routes; the EURC deployments and resolvers; ten quotes with latency
(117–334 ms per quote, one round of 2–4 parallel requests); selectors, gas ranges, Solana account sizes and the fee
rounding against real transactions; the message layout against a real attested message.

Not verified: no transaction was built, simulated or sent. In particular the Solana account lists and PDA seeds of
§7.2–7.3 come from source reading; the `approve` gas figure is an assumption; `estimatedSeconds` is Circle's documented
average, not a measurement; the behaviour "insufficient `maxFee` ⇒ attested as Standard" is Circle's statement; the
non-USDC message body has not been analysed; rounding was observed on one source chain (Arbitrum).
