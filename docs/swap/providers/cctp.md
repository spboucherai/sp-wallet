# CCTP (Circle Cross-Chain Transfer Protocol) — execution dossier

Provider id `cctp` · adapter `packages/swap/src/providers/cctp.ts` · tests `packages/swap/test/cctp.test.ts` ·
live check `scripts/smoke-swap-cctp.mts`. Everything below was read from Circle's documentation and source on
**2026-11-10** and, where marked *checked*, confirmed on mainnet the same day. The quote adapter itself only quotes.

**Execution status (2026-11-11): USDC between the seven EVM networks is executable by the wallet itself** — burn,
attestation, mint, always to the wallet's own address — see **§12**. **Since v8 (same day) USDC between Solana and each of
those networks is executable too, in both directions — see §13.** EURC remains quote-only. No real transfer has been
broadcast yet; the proof is on local forks (§12.7) and, for Solana, by mainnet simulation (§13.9).

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

**Upgradeability — a trust statement, not a detail** (read 2026-11-11 from the verified sources and from both registry
RPC endpoints of each network with `scripts/cctp-pins.mts`; full hashes in `packages/core/src/cctp.ts`).

- `TokenMessengerV2` and `MessageTransmitterV2` are **`AdminUpgradableProxy`** contracts (Circle's fork of OpenZeppelin's
  transparent proxy, solc 0.7.6, EIP-1967 slots; `admin()` and `implementation()` are public views). The 2 175-byte proxy
  runtime code is **identical on all seven networks** (SHA-256 `501b4a60e24ea82032b7442d75995dee3bdbfc17b25caffc3c955eadc8c2a418`).
  `upgradeTo`, `upgradeToAndCall` and `changeAdmin` are callable **only by the address in the EIP-1967 admin slot, with no
  timelock or delay in the proxy**. On every network that admin is an address **without code** (an externally owned
  account from the chain's point of view — whether it is a hardware/MPC key or a plain key cannot be seen on-chain), and
  it is a different address per network and per contract.
- `TokenMinterV2` is **not a proxy** (implementation slot empty; 9 295 bytes, identical on all seven networks, SHA-256
  `ddc1bfebb8465377e23aea86ef3135551130ae35426b759e69c1644735074be6`). Its owner can change the token controller / burn limits.
- Implementations (explorer-verified sources, solc 0.7.6, 100 000 optimizer runs):

| Network | TokenMessengerV2 implementation | SHA-256 (start) | MessageTransmitterV2 implementation | SHA-256 (start) |
|---|---|---|---|---|
| ethereum | `0x555e272506c06e7e559d57418563742afe363ec8` | `81ca2a58e7649564…` | `0xa30c41865729c248067704d4db9f38385cbe1186` | `b7b2a422acb8daa7…` |
| base | `0x555e272506c06e7e559d57418563742afe363ec8` | `81ca2a58e7649564…` | `0x7db629f6acc20be49a0a7565c21cc178e9ac21e3` | `5814f08b2cfc7399…` |
| arbitrum | `0x555e272506c06e7e559d57418563742afe363ec8` | `81ca2a58e7649564…` | `0x7b93db2bc72faf642cec0adcac4f91718831a1f4` | `bad293319d77ab3e…` |
| optimism | `0x555e272506c06e7e559d57418563742afe363ec8` | `81ca2a58e7649564…` | `0x1f33335414afb7305367452d00a0d024b0184ea8` | `1c4986994c9f845d…` |
| polygon | `0x555e272506c06e7e559d57418563742afe363ec8` | `81ca2a58e7649564…` | `0xd40518c1a3139e8f1f73f83e5de74e05c88f5ad3` | `540cd1aece247c99…` |
| avalanche | `0x555e272506c06e7e559d57418563742afe363ec8` | `81ca2a58e7649564…` | `0x8689f0a21fe82b30e8f7684902788f65d891dae6` | `6c541f8c79e43368…` |
| hyperevm | `0x1ccafdffbc1b7b5c499c97322f961b7d929a41b4` | `cff375318c7d5eda…` | `0x17eaec8bb0d05e8da2e96ad69121fee6dd62d313` | `e9423da6e41a7a11…` |

  The messenger implementation is the same contract at the same address on six networks; **HyperEVM runs a newer build**
  with the Standard-fee switch (`minFee`, `getMinFeeAmount`; `minFee()` = 0 on 2026-11-11). The explorer sources of that
  build are byte-identical to `circlefin/evm-cctp-contracts` master (`a92a2b4e`, 2026-06-18); the six-network build is the
  same code without the min-fee feature (no `minFee`, no `getMinFeeAmount`, older `initialize`) and nothing else differs.
  The transmitter implementation has the same 26 source files on all seven networks; the bytecode differs only by the
  immutable `localDomain`.
- Who can change what (addresses on 2026-11-11; none of the proxy admins carries code):

| Network | Messenger proxy admin | Transmitter proxy admin | Messenger owner | Transmitter owner | Attester manager |
|---|---|---|---|---|---|
| ethereum | `0xa820a620f638114f3eb45df87382383322ddbc49` | `0xb7569e9eb64eaed5c4166e510b4f6ff54ef42258` | `0x2329BAF15f86023e5B0f5592e230D02a51116CD5` | `0xB43aA882f497c0Ecb395A5a54f8fa29d12289F65` | `0xc16b03F84563C1467017C9F7216F8ad6098dc95a` |
| base | `0x88acf681fb9a1dfce5ac83391991895c54cf24cc` | `0x19b4b317e6ea4643f1507c372630483092d0abff` | `0x24253f1CA7540CfCb3DdDa890d3b94434786E379` | `0x9c563B7B08C5506C4aae279E1f66658D5f9fD7B8` | `0xDf265e0329F6A08a772B48191b33bDC624499b84` |
| arbitrum | `0xe825a926c4196878c898ba8b78bc3396570909be` | `0x15fb0197b0b8ae18a5f283ba8b002d4c6abb127f` | `0xe2e39E7D80fD21Fa39eB04BdaD36D0B2C65b818F` | `0x5054056a0d4F3106B7a8Ad33dD3FD2E8c3d1524d` | `0x49420615d90a11cE317eb1eEfBB5C6e2Bf366195` |
| optimism | `0x14085cbf8634a9d279378eb3bf40240e80647681` | `0x1cc76b72d180f8768a5e3d2ff8b1dfb593c1ecd3` | `0xdf31F6B761d5D47D8Cea36EE33cd11c7b071096A` | `0xb9dC4d38138FD53D645DaEa92D1c2294BBD5Ba50` | `0x4D6C6325998FCE054B4C4420428b86B28BD8db74` |
| polygon | `0xaf904ead44750e2e970f205e9d1e0c6ca8caa643` | `0xcb37aa4d4be3abdadc9f7a677ba806b7ff4aea15` | `0x97E89576ef93A3072DC73aB05a16951760124bb6` | `0xD7b229FDcdF9dEA893236F23509754FB5C6A0457` | `0x190f7ef6F3502710392439b9C11A6D5B118df46e` |
| avalanche | `0xe4a786348cf3df7ef5dc9b28f658e22c816f723f` | `0xdd4bfb4b809e68c0973d7eb6d160d680183c8b5c` | `0x548f6CE934755c9b135FBE3FfD2F8D7fa330e5FB` | `0x81Be209E803e5bBE90a17aC13d65510Bf60800Ed` | `0x9d4C65ACa5bF3a0A7012d8CeFEA6fcF9FB6d63B8` |
| hyperevm | `0xec6c5c1b27e66701e7b79747caa2322127e0d4f2` | `0xe11c4e6efee7205325a2219771c474527210c5ab` | `0x419d9cf7341f571C2F4Be894d73B065f103f3719` | `0x3D1b1E2D06B3F3FB7637bC73b69b6b0B0dFa79C1` | `0x7925e7E92Cfb0b74EF9EBBdBC9E45c3622cf4834` |

- Attesters: 2 enabled on every network, the same two keys everywhere (`0x725b06F73ff761eF5390e39315e2BfbF60d33F96`,
  `0x52Ed4cBff8DcE6A19748043F3240ec03c834bCeF`), signature threshold 2. The attester manager of a network can enable or
  disable attesters and change the threshold: **whoever controls it can mint on that network**. This is the trust
  assumption of CCTP itself, not of the wallet.

**What the wallet pins, and the trade-off.** The API refuses to prepare a transfer, and refuses to send the mint, unless on
*both* RPC sources of the network: the two proxies hash to the pinned proxy code, each EIP-1967 implementation slot holds
the pinned implementation address, each implementation hashes to its pinned value, the minter hashes to its pinned value,
and the wallet address carries no code. Consequence: **the day Circle upgrades a contract, CCTP transfers stop on that
network until someone reads the new implementation and updates `CCTP_ENABLED`** (run `node scripts/cctp-pins.mts` to see
the new values). A transfer already burned waits in "ready" with the reason shown; it is not lost — the mint is
permissionless (`destinationCaller` = 0) and can be submitted from any other tool with the public message and attestation —
and it resumes by itself once the pins are updated. What the pin does **not** give: the signer has no chain access, so
the check lives in the API (as for the KyberSwap router); and Circle could upgrade between the check and the inclusion of
the transaction (seconds). The same party issues and can freeze USDC, so this adds no new trusted party.

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

The seed spelling of rows 3 and 8 is taken from the V2 source and from the receive-side table in Circle's docs.
*(v8, 2026-11-11: confirmed — every derived address equals the account of real mainnet transactions, and the signer-built
burn succeeds in mainnet simulation; see §13.)*

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
*(v8: two corrections, see §13 — the deployed program also takes the fee recipient's token account, between `token_pair`
and the user token account; and the wallet creates its token account in a separate, passkey-approved transaction BEFORE
the burn instead of prefixing the mint.)*

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

## 11. What is verified, and what is not (quote adapter)

Verified live (smoke script, 2026-11-11): the pinned addresses, domains, versions and wiring on all eight networks; the
10 M burn limit; the fee schedule of the 56 USDC routes; the EURC deployments and resolvers; ten quotes with latency
(117–334 ms per quote, one round of 2–4 parallel requests); selectors, gas ranges, Solana account sizes and the fee
rounding against real transactions; the message layout against a real attested message.

Not verified: *(superseded for Solana by §13: account lists and seeds are now checked against real transactions and by
simulation)* the Solana account lists and PDA seeds of §7.2–7.3 come from source reading (no Solana transaction was
built); `estimatedSeconds` is Circle's documented average, not a measurement; the behaviour "insufficient `maxFee` ⇒
attested as Standard" is Circle's statement; the non-USDC message body has not been analysed; rounding was observed on
one source chain (Arbitrum). For the EVM execution path see §12.8.

## 12. Execution: USDC between EVM networks (implemented 2026-11-11)

Scope: USDC only; Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, HyperEVM (`CCTP_ENABLED`, 42 ordered pairs);
sender and recipient are always the wallet's own EVM address (the same on every EVM network). No hooks, no destination
caller, no swap leg, no EURC, no Forwarding Service. (Solana as one end: §13 — nothing in this section changed for it.)

Code: `packages/core/src/cctp.ts` (pins, intent verification, both transaction builders, message parser),
`services/isolated-signer/src/signer.ts` (`sign` bridge branch, `signBridgeMint`), `services/api/src/bridge.ts` (routes,
guards, state machine), `apps/web/src/bridge.tsx` + `screens/Swap.tsx` + `screens/Activity.tsx`.

### 12.1 Intent
The intent gains an optional `bridge` section (hashed with fixed field order; intents without it hash exactly as before):
`provider: 'cctp'`, `toNetwork`, `toDomain`, `maxFee` (Circle's fee ceiling in USDC base units; 0 for Standard),
`minFinalityThreshold` (1000 or 2000), `messenger`, `transmitter` (must equal the pinned constants), `approveGas`.
`asset`/`amount` are the USDC burned on `network`; `to` must equal `from`. The owner's passkey signs the SHA-256 of all
of it: **one approval commits to the whole transfer, both legs**.

### 12.2 First leg (source)
The signer builds, from the intent and its own tables only — there is no provider calldata at all:
`USDC.approve(TokenMessengerV2, amount)` (exact amount, omitted when the allowance already covers it) and
`depositForBurn(amount, domain(toNetwork), bytes32(own address), registry USDC, 0, maxFee, minFinalityThreshold)`.
Refused: recipient ≠ own address, any token other than the registry USDC of the source, unpinned messenger/transmitter,
a domain that is not the destination network's, a network outside `CCTP_ENABLED`, `maxFee` ≥ amount or > 1 % of it,
a threshold other than 1000/2000, Fast from a source where Circle does not offer it, a `swap` section alongside.
Policy applies as for a send: per-transfer and daily USDC limits of the **source** network, native fee ceiling of the
source, approval window, halt, allowlist (if the owner uses one, `"<source>:<own address>"` must be in it — a bridge has
no other destination). The amount counts toward the day's spend on the source.

### 12.3 Second leg (destination) and how it is authorised
`MessageTransmitterV2.receiveMessage(message, attestation)`, sent from the wallet's own address. It moves no value out of
the wallet (the caller pays gas only; the mint goes to the message's `mintRecipient` whoever calls).

**Decision: the burn approval covers the mint; no second passkey prompt in the normal case.** When it signs the burn, the
signer stores the approved bridge (`state.bridges[proposalId]` = route, wallet, amount, fee ceiling, finality, burn tx
hash) durably, before the signature leaves. Later, `POST /bridge/mint` signs a mint only if:

1. the proposal id is a stored, passkey-approved bridge of this wallet (not expired by time: it must remain mintable);
2. the message parses as a 376-byte CCTP V2 burn message (no hook) and **every field equals the approved burn**: version 1
   (header and body), source domain, destination domain, sender and recipient = the pinned TokenMessenger,
   `destinationCaller` = 0, burn token = registry USDC of the source, `mintRecipient` = the wallet, `messageSender` = the
   wallet, amount, `maxFee`, `minFinalityThreshold`; and `feeExecuted ≤ maxFee`, `finalityThresholdExecuted ≥` the approved
   threshold, non-zero nonce; the attestation is 1–8 signatures of 65 bytes;
3. the target is the pinned MessageTransmitterV2 on the destination chain id, value 0, gas 100 000–450 000, and
   `gas × maxFeePerGas ≤` the policy's native fee ceiling of the destination network;
4. no mint was signed for this bridge yet, and this message (keccak256) has not served another bridge.

Why this is safe without a second approval. The worst a compromised API can obtain is **one** signature per approved
bridge on a transaction that either mints the wallet's own burned USDC to the wallet's own address or reverts; its cost is
bounded by the destination fee ceiling. It cannot change recipient, amount, token or route (2), cannot aim the signature at
another contract or chain (3), cannot farm signatures (4), and a forged or foreign message cannot pass the contract's
attester check anyway. The signer cannot verify the attestation itself (no chain access, attesters can rotate): a bad
attestation only wastes that one bounded fee. A stolen approval therefore buys strictly less than what the owner approved.
A second passkey prompt would add nothing to the safety of the funds and would make "finish days later from another
device" depend on the owner being present for a step that only *delivers* his money.

Exactly once, and resumable:
- an **identical** request (same message, attestation, nonce, gas) returns the **same signed bytes** again — the API
  stores the gas parameters before asking, so a crash between the signer's answer and the database write repeats the same
  request and does not consume a second signature;
- **any other** request for a bridge that already has a mint signature is refused, unless it carries a passkey assertion
  over SHA-256(`SPW-BRIDGE-MINT-v1`, proposal id, message hash, nonce, gas limit, fee cap, tip) — the "approve a new mint"
  action, for a mint transaction that reverted or was replaced (at most 6 signatures per bridge);
- the bridge record has no expiry; it is pruned 90 days after a mint signature;
- while the signer is halted it signs no mint (anyone can still submit the public message from another tool).

Binding to the burn: the record holds the burn transaction hash (audit trail) and the mint signature is bound to the
message hash. The signer cannot check that a message came from *that* transaction (the message does not contain it, and
the signer has no chain access); two identical transfers (same route and amount) are interchangeable at this level, which
is harmless: each record signs one mint, each message serves one record, and every message mints only to the wallet.

### 12.4 API life cycle (`kind: 'bridge'` in `proposals`, column `bridge` for the second leg)
prepare (`POST /api/v1/bridge/proposals`) → passkey approval (existing `/transfers/proposals/:id/approve`) → sign →
exact approval mined → burn simulated again (`eth_call`) → broadcast → receipt (`confirming`/`finalized` = the burn) →
phase `attesting` (poll `GET /v2/messages/{domain}?transactionHash=`, 4–15 s at first, slower later, at most every 5 min,
**never abandoned**; flagged `attestation_late` after 3× the documented time + 30 min) → `ready` → mint signed and sent
(`mint_sent`) → receipt with the network's confirmation count → `done` (amount read from the USDC `Transfer` event).
Worker loop every 5 s; `POST /api/v1/bridge/proposals/:id/finish` runs the next step immediately and is safe at any time.

Guards at prepare: both networks' pins (§2), wallet address without code on both, one operation in flight on the source,
nonce agreement on the source, USDC balance, source gas, signer policy pre-check, **destination gas** (below), Circle's
fee from Iris (+ on-chain `getMinFeeAmount` for Standard where the messenger has it), Fast allowance ≥ amount.
At mint time: `usedNonces(nonce)` on both RPC sources (already minted ⇒ success, nothing signed), pins of the destination
again, Fast expiry (`expirationBlock` passed ⇒ `POST /v2/reattest/{nonce}` and back to `attesting`), no other operation in
flight on the destination and nonce agreement, `eth_estimateGas` as simulation, fee ceiling, native balance.
The Iris answer is untrusted: the API keeps only a message that passes the same `verifyCctpMint` as the signer; anything
else is ignored with the reason shown (`message_mismatch`).

"Nonce already used": the contract mints a message once. If someone else submitted the mint (it is permissionless), the
API sees `usedNonces = 1` before signing, or sees its own transaction revert and then `usedNonces = 1`; both end as `done`
with `mintedBy: other` and, when found in the last 2 000 blocks, the third party's transaction hash. The amount recorded in
that case is the one computed from the attested message (amount − feeExecuted), not read from a receipt.

### 12.5 Destination gas
The mint is paid in the destination network's coin. **The wallet refuses to burn when the destination cannot pay**: at
prepare, native balance on the destination must cover 240 000 gas × (2 × base fee + tip) there, and that amount must fit
under the signer's fee ceiling for that network; otherwise `destination_gas` ("Nothing was burned: add ETH on … first").
The Swap screen shows the need and the balance before the button and disables it. If the gas disappears between burn and
mint, the transfer waits in `ready` with the same message and finishes when gas is back. Nothing is ever topped up
automatically.

### 12.6 Cost and time of a real transfer
- Circle's fee: **Standard 0**; **Fast** per the live schedule (2026-11-11: 1 bps from Ethereum, 1.3 bps from Base and
  Optimism, 1.4 bps from Arbitrum; not offered from Avalanche, Polygon, HyperEVM). The approved ceiling is the fee rounded
  up; what is taken is shown after the mint. 10 USDC Fast from Base: at most 0.0013 USDC.
- Gas, measured on forks with the real contracts: approval ≈ 55 000, `depositForBurn` ≈ 109 000 (source coin),
  `receiveMessage` ≈ 171 000 (destination coin). OP-stack L1 data fees come on top (Base, Optimism). In money this is
  cents on the L2s, Polygon, Avalanche and HyperEVM, and can be a few dollars when Ethereum is the source or the
  destination at ordinary gas prices — the review sheet shows the ceiling in the source coin, the quote card the estimate
  for the destination.
- Time until the attestation exists, per Circle's documentation: Standard ≈ 15–19 min from Ethereum, Base, Arbitrum,
  Optimism (hard finality on Ethereum, ~65 blocks); ≈ 8 s from Avalanche and Polygon; ≈ 5 s from HyperEVM. Fast ≈ 20 s from
  Ethereum, ≈ 8 s from Base, Arbitrum, Optimism. Add the inclusion of the burn before, and after it the wallet's polling
  delay (seconds at first; up to a minute or more late in a 19-minute wait) and the inclusion of the mint.
- Limits: the signer's per-transfer and daily USDC caps of the source network (50 / 100 USDC by default); Circle's own
  10 M USDC per burn.

### 12.7 Proof on forks (`npx tsx scripts/fork-cctp.mts <source> <destination>`)
Two anvil forks, fresh random keys, nothing sent to a real network. Real bytecode throughout. Run on 2026-11-11 for
base→arbitrum, arbitrum→ethereum, ethereum→optimism, optimism→polygon, polygon→avalanche, avalanche→hyperevm,
hyperevm→base (every enabled network once as source and once as destination; results in `docs/V2-IMPLEMENTATION-STATUS.md`).
- Part 0, **the only exercise of Circle's real attestation service, read-only**: recent public messages are fetched
  from `iris-api.circle.com` and their signatures verified (count = on-chain threshold, recovered signers enabled on-chain,
  ascending order). Also covered offline by a unit test on a recorded real message.
- Part 1, signer level: refusals on the first leg (other recipient, other amount, amount over the limit, other token,
  unpinned messenger/transmitter, wrong domain); real approval + burn (balance −amount, total supply −amount, allowance 0);
  refusals on the second leg (mintRecipient ≠ wallet, other destination domain, other amount, other token, destination
  caller, unapproved fee, unknown bridge); on-chain refusal of non-attester and single signatures; mint (+amount);
  second request refused, identical request replayed, a passkey-approved second mint transaction reverts on-chain; Fast
  fee split (wallet / Circle's fee recipient) and on-chain refusal of a fee above `maxFee`.
- Part 2, full stack (API routes, worker steps, signer over HTTP, passkey): destination without gas refused; Standard by
  the worker alone; Fast with Circle's live fee; attestation withheld then "finish"; mint relayed by a third party.
- **What is simulated, and only on the destination fork**: Circle cannot attest a burn that exists only on a fork, so two
  test attester keys are enabled by impersonating the transmitter's attester manager, and a local stand-in signs the
  fork's own `MessageSent` bytes (nonce, executed finality, executed fee filled in as Circle does). The contract's
  signature checks run unmodified against those keys. Signer fee ceilings are multiplied by 20 **inside the fork script
  only** (anvil reports a 1 gwei tip); production limits are unchanged.

### 12.8 Not verified (execution)
- **No real transfer has been made.** In particular the real pairing "our burn → Iris returns a complete message whose
  bytes pass `verifyCctpMint`" has never run end to end; the message format is checked against real messages of other
  senders only.
- Iris behaviours taken from the documentation, not observed: `pending_confirmations` → `complete`, `delayReason`,
  Fast → Standard degradation when `maxFee` is too low, `POST /v2/reattest` (the expiry path is implemented and has no
  fork or unit test of the re-attested message), rate-limit handling (the API polls far below 40 req/s).
- The Standard fee switch (`getMinFeeAmount` > 0) has never been seen non-zero; the code path is untested on-chain.
- Contracts were not recompiled from source: "verified" rests on the explorers' verification and on a file-by-file
  comparison with Circle's repository. Proxy sources were read on Ethereum only (the proxy *bytecode* is identical
  everywhere). Constructor arguments on HyperEVM come back empty from the explorer API.
- Who holds the proxy-admin, owner and attester-manager keys is unknown beyond "an address without code".
- The USDC contract itself (also an upgradeable proxy, with blacklist and pause) is outside these pins, as for sends.
- Real gas prices: the destination-gas estimate uses 240 000 gas × (2 × base fee + tip); on OP-stack networks the L1 data
  fee of the mint is not included in the check (the transaction carries ~600 bytes of calldata).
- The web screens were type-checked and built, not exercised in a browser (no Playwright run for this feature).
- Polling stops only at `done`: a burn whose proposal later turns `failed`/`replaced` (deep reorg of the source after the
  burn was seen) is no longer advanced automatically.

## 13. Execution: USDC between Solana and the EVM networks (implemented 2026-11-11, v8)

Scope: USDC only, between Solana (domain 5) and each of the seven EVM networks of §12, **in both directions**, always from
the wallet's own address to the wallet's own address (on Solana: to its own USDC token account). No hooks, no destination
caller, no Forwarding Service. Solana ↔ Solana does not exist (one domain). **No real transfer has been broadcast**: the
proof is mainnet *simulation* for the Solana transactions and a local fork for the EVM ones (§13.9), plus unit tests on
real recorded transactions.

Code: `packages/core/src/cctp-sol.ts` (pins, program-derived addresses, the three instruction encoders, a multi-signer v1
message compiler), `packages/core/src/cctp-sol-tx.ts` (the four transactions the signer builds), `packages/core/src/cctp.ts`
(`cctpEnd`, `cctpSender32`, `cctpRecipient32`; `verifyCctpBridge` and `verifyCctpMint` extended), `services/isolated-signer/src/signer.ts`
(`sign` Solana-bridge branch, `bridgeMintSol`, `signBridgeReclaim`, `signSolTokenAccount`), `services/api/src/bridge-sol.ts`
(guards, preparation, simulation, mint, reclaim, token account), `apps/web/src/bridge.tsx` + `screens/Swap.tsx` (strings `sc*`).

### 13.1 Sources read (2026-11-11)

- Circle's documentation: [CCTP Solana programs and interfaces](https://developers.circle.com/cctp/references/solana-programs)
  (program ids, `depositForBurn` parameters, "MessageSent event storage" and the five-day window, remaining accounts of
  `receiveMessage`, mint recipient notes), [finality and block confirmations](https://developers.circle.com/cctp/concepts/finality-and-block-confirmations)
  (Solana: Fast 2–3 blocks ≈ 0.4–0.6 s, Standard 32 blocks ≈ 17 s), [fees](https://developers.circle.com/cctp/concepts/fees),
  [technical guide](https://developers.circle.com/cctp/references/technical-guide) (message format: `sender` = "address of
  MessageTransmitterV2 caller on source domain", `messageSender` = "address of caller of depositForBurn" — which account
  that is on Solana is **not** stated there).
- Circle's source: `github.com/circlefin/solana-cctp-contracts`, commit `ec16e95d28ee47f7832df4203ae07b5981d146fc`
  (2026-06-18), `programs/v2/`: `deposit_for_burn.rs`, `send_message.rs`, `reclaim_event_account.rs`, `receive_message.rs`,
  `handle_receive_finalized_message.rs`, `message.rs`, `burn_message.rs`, the two `state.rs`, `events.rs`.
- The programs' **on-chain Anchor IDLs** (accounts `DcdWSsAT3RvYGjQzeBHdSJPVmdePNuFGXPn55UUXM9Xd` and
  `2kCVppn7yBVracH1T3rBPNTxXSds884gEWUvmyKWzjBu`, IDL authority `J97Xq8AxXXYW297VkkPVDsYaxGZn6Wdtv2DUQfg2kees`, version 0.2.0):
  same discriminators, account lists and argument types as the source.
- On-chain, on both registry RPC endpoints: the two programs' ProgramData (§13.2), the `token_messenger` state, the seven
  `remote_token_messenger` accounts, the USDC mint, rent figures.
- **Real mainnet transactions**, fetched read-only and decoded instruction by instruction, with the attested messages
  Iris returns for them (`GET /v2/messages/5?transactionHash=<base58 signature>` — the same endpoint as for EVM sources):
  8 Solana → EVM burns from 7 wallets, 8 EVM → Solana mints, 2 reclaims. Recorded in
  `packages/core/test/fixtures/cctp-sol/real-transactions.json`; `packages/core/test/cctp-sol.test.ts` asserts everything
  below on them, and that the wallet's encoders reproduce those instructions **byte for byte** (data and account lists).

One correction to Circle's page: its table of remaining accounts for `receiveMessage` lists ten accounts. The deployed
program takes **eleven** — `fee_recipient_token_account` sits between `token_pair` and the user token account (source,
on-chain IDL and all eight real mints agree). §7.3 above predates this.

### 13.2 The programs, their pins and who can upgrade them

| Program | Id | ProgramData | Last deployed (slot) | Executable | SHA-256 | Upgrade authority |
|---|---|---|---|---|---|---|
| MessageTransmitterV2 | `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC` | `2w2zCf9f5iyr7qcuWQH4DFNNahBZHgYkL4UVU3p5T1iS` | 343 321 624 | 493 512 bytes | `abbe67181ec4edcad11f4a0773d8bf658b2e599d6f1365ebfee1ab0f85fe9bb4` | `9SxKDZRge2ianVfwP1MxzwREMHCn28gdGbrvhTNRGWRq` |
| TokenMessengerMinterV2 | `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe` | `9ZEnLvCp3weopBnSaoSSjn7hoVk6zMXMpfH3LjNzBFFF` | 343 322 709 | 716 232 bytes | `ccdac46adb68c570556bd15f7caddc52dd16fb96e0bbc8f5a46129555adbeeb2` | `HaxwvTGZFT7K8yvQKaUNZxyD593jr4gXCppu4uqQhyXK` |

Identical on `api.mainnet-beta.solana.com` and `solana-rpc.publicnode.com`. **Both programs are upgradeable.** Each upgrade
authority is a system-owned address with no data (holding 0.5 SOL): a key from the chain's point of view — whether a
hardware module or a multi-party scheme stands behind it cannot be seen, and there is no on-chain timelock. Whoever holds it
can replace the program, and a replaced program could do anything the wallet's signature allows on the accounts named in
the transaction. Circle is also the issuer of USDC and can freeze it, so this adds no new trusted party; it is said
because it is the trust statement of this leg.

As for Jupiter (`JUPITER_PIN`), `CCTP_SOL_PINS` holds ProgramData address, last-deploy slot, upgrade authority and
executable hash. `cctpSolGuards` (API) refuses to prepare a burn, send a mint, reclaim a deposit or create the token account
unless, **on both endpoints**: the program accounts point at the pinned ProgramData, its header shows the pinned slot and
authority, and (at first use, then every six hours) the whole executable hashes to the pinned value. It also requires the
cluster's genesis hash, **USDC to be a classic SPL Token mint** with 6 decimals (owner = the Token program; a Token-2022 mint
is refused, in the registry accessor `cctpSolUsdc` as well), the `token_messenger.fee_recipient` to be the pinned
`4BPnUzFDibVcWQ5zzixGodRUHwqDxHYpUPdPYus3Bn56` (the mint instruction names its token account), the wallet to be a plain
system account, and no `denylist_account` PDA for it. As on the EVM side the pin lives in the API (the signer has no chain
access) and an upgrade landing between the check and inclusion is not covered. After an upgrade the leg stops, with the
reason shown, until the new deployment is reviewed; USDC already burned stays mintable by anyone with the public message.

**Not done:** the deployed bytes were not rebuilt from the source. Layouts and behaviour are established by the source,
the on-chain IDL, real transactions and simulation — not by reproducing the build.

### 13.3 Solana as source: the burn, and the previous engineer's first obstacle (the second signer)

`deposit_for_burn` stores the message in a new account (`message_sent_event_data`) that the program creates with the
System program; the new account must sign. So the transaction has **two signers**: the wallet (owner of the token account,
fee payer, rent payer) and that account.

Design, and why:

- **The signer generates the keypair itself**, inside the signing step, after the passkey was verified
  (`ed25519.utils.randomSecretKey()`); it signs this one transaction and the secret is overwritten. Neither the API nor
  the owner ever sees or chooses it: a request carrying *any* helper data is refused ("a bridge takes no helper data").
- **Nothing but the public key is kept**: it is recorded with the bridge (`state.bridges[id].sol.eventAccount`), returned
  to the API, and written to the signer's journal. This is sound because the program never asks for that key again:
  `ReclaimEventAccountContext` has one signer, `payee`, constrained to `message_sent_event_data.rent_payer` — the wallet.
  (Read in the source and the IDL; both real reclaims recorded carry a single signature.) So no derivation path, no stored
  secret, nothing to back up. A deterministic derivation would only matter if the event key were needed twice; it is not.
- A key that signed a transaction which never landed is simply lost with it; the next attempt is a new proposal with a
  new key. Once the account exists it is owned by the MessageTransmitter program: its key has no power over it.
- What a compromised API can do with this: nothing more than before. It cannot supply the account, the instruction, the
  recipient or the amount; it can only present the intent the owner approved.

The signer **builds the whole transaction** from the approved intent (`buildCctpSolBurnMessage`): a Solana v1 message (all
accounts inline, no lookup table, compute budget in the header — as in the Jupiter path), **one instruction**,
`deposit_for_burn`, with its 18 accounts derived from the pinned program ids and the seeds of Circle's source:

| # | Account | Value |
|---|---|---|
| 1, 2 | owner, event_rent_payer | the wallet (signer) |
| 3 | sender_authority_pda | `["sender_authority"]` @ TokenMessengerMinterV2 |
| 4 | burn_token_account | the wallet's **own associated USDC account** (`ATA(wallet, USDC, Token program)`) |
| 5 | denylist_account | `["denylist_account", wallet]` |
| 6 | message_transmitter | `["message_transmitter"]` @ MessageTransmitterV2 |
| 7–10 | token_messenger, remote_token_messenger, token_minter, local_token | `["token_messenger"]`, `["remote_token_messenger", "<domain>"]`, `["token_minter"]`, `["local_token", mint]` |
| 11 | burn_token_mint | the registry USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| 12 | message_sent_event_data | the one-time account (signer) |
| 13–18 | the two programs, Token, System, `["__event_authority"]`, the program | constants |

Arguments: `amount`, `destination_domain` (from the signer's table), `mint_recipient` = the wallet's **own EVM address**
left-padded (the intent names it in `bridge.recipient`; the signer requires it to be its own address on that network),
`destination_caller` = 32 zero bytes (anyone may submit the mint — the same reasoning as §7.1), `max_fee`,
`min_finality_threshold` (1000 or 2000; Fast is offered from Solana). Compute budget: limit 30 000–150 000 units (real burns
used 42–53 k), price ≤ 2 lamports per unit. What the handler does with it (source): checks the amount, the denylist, the
recipient, `max_fee < amount` and the program's Standard minimum fee (`token_messenger.min_fee`, 0 today — the API reads it);
burns `amount` from the token account under the authority of `owner` (Anchor requires that account to hold the burn mint
and to be owned by `owner`); and CPIs `send_message`, which creates the event account (payer = `event_rent_payer`).

Intent: `network: "solana"`, a `sol` section, and the `bridge` section with `messenger`/`transmitter` = the two pinned
**program ids**, `approveGas: "0"`, and the new optional field **`bridge.recipient`** (hashed only when present, so EVM ↔ EVM
intents hash exactly as before). Refused: any other mint, recipient, destination, program, a destination caller (none can
be expressed), an amount above the per-transfer or daily USDC limit *of Solana* (50 / 100 USDC by default), a fee ceiling
above the policy.

### 13.4 The `messageSender` finding (the previous engineer's fourth obstacle)

The EVM mint check requires the message to have been *burned by this wallet*. For a Solana-sourced message:

- **Source**: `BurnMessage::format_message(.., &ctx.accounts.owner.key(), ..)` in `deposit_for_burn.rs` — `messageSender` is
  the `owner` signer. And `Message::format_message(.., sender = &ctx.accounts.sender_program.key(), ..)` in `send_message.rs`
  — the header's `sender` is the TokenMessengerMinterV2 **program id**.
- **Evidence**: eight real attested messages (signatures and messages in the fixture), from seven wallets, toward Base,
  Avalanche, Ethereum and two other domains. In all eight `messageSender` = account 1 of the instruction (the owner's
  public key); it is never the token account (account 4). In three of them the fee and rent payer is a *different* account
  (`Cc5M6mec…`, a relayer paying for `BvgYWSbx…`, `4CE8sZg1…`, `6bSCaAo6…`): `messageSender` is still the owner, not the
  payer. `sender` = `a65fc81d…e93893` = the program id in all eight; `burnToken` = the USDC mint; toward the wallet's EVM
  networks `recipient` = the EVM TokenMessengerV2 left-padded.
- **Our own burn**: the message read from the simulated event account of the signer-built burn carries the stand-in
  wallet's public key as `messageSender` (§13.9 [a]).
- **The other side agrees**: on the Base fork `TokenMessengerV2.remoteTokenMessengers(5)` is that program id, and a
  message whose `sender` is another Solana program reverts with "Remote TokenMessenger unsupported".

Rule encoded (`cctpSender32`): for a Solana source, `messageSender` = the 32 bytes of **the wallet's Solana public key**;
`sender` = the 32 bytes of the TokenMessengerMinterV2 program id; `burnToken` = the 32 bytes of the USDC mint. It is
established with certainty; the leg ships.

The on-chain message equals the attested one with four fields zeroed (nonce, executed finality, executed fee, expiration),
checked on the eight event accounts — so what Circle attests is what the program stored, and the signer's verifier can be
run on the message *before* it is attested: the API does exactly that when it prepares a burn (below).

### 13.5 The event-account deposit and its reclaim (second obstacle)

- **Size and cost, measured**: 428 bytes (8 + 32 + 8 + 4 + 376), rent **2 824 480 lamports = 0.00282448 SOL**
  (`getMinimumBalanceForRentExemption(428)` on 2026-11-11; the same figure in seven of the eight real burns — the eighth
  account had been pre-funded by its sender).
- It leaves the wallet in the burn transaction. The signer counts it **inside the approved fee ceiling**
  (`2 signatures + priority fee + CCTP_SOL_EVENT_RENT ≤ intent.maxFee ≤ policy ceiling for Solana, 0.003 SOL`), so the
  owner approves, and the policy bounds, everything the transaction takes from the wallet's SOL. The priority fee is
  lowered when needed to fit. `CCTP_SOL_EVENT_RENT` is the measured figure: the signer cannot see the rent rate; the API
  reads it live and refuses ("rent_changed") if it is higher.
- **Shown before approval** as a refundable deposit, with the date it becomes reclaimable (an estimate until the burn is
  mined, then exact from the event account's own `created_at`).
- **When**: `reclaim_event_account` requires `now ≥ created_at + 432 000 s` (five days), an attested message with the same
  source fields, and Circle's signatures on it. The reason is in the source: V2 nonces are assigned off-chain, so the
  account must stay readable until Circle's service has certainly processed it.
- **"Récupérer le dépôt"** appears in the transfer's details when the five days have passed. It needs the **passkey every
  time** (a decision: unlike the mint, nothing is waiting on it, and the owner is present since he pressed the button):
  the challenge is SHA-256 of (`SPW-BRIDGE-RECLAIM-v1`, bridge id, event account, message hash, blockhash, validity,
  compute limit and price). The signer signs a reclaim only for **the account recorded with that bridge**, with the
  bridge's own attested message (same verifier), payee = the wallet, fee ≤ the policy ceiling, not before five days after
  the approval by its own clock, at most 12 times. The request has no field to name another account.
- The API simulates before asking, simulates the signed bytes with the signature checked before sending, tracks the
  transaction and marks the deposit reclaimed; a reclaim not included in time can simply be asked again. The record of a
  burn whose deposit was never reclaimed is not pruned from the signer.
- A real reclaim costs 5 000 lamports + priority fee and about 145 000 compute units; 0.00281948 SOL comes back.

### 13.6 Solana as destination (third obstacle: the recipient is a token account, which must exist)

**The recipient.** Circle: "the `mintRecipient` should be a hex encoded USDC token account address. The token account must
exist at the time `receiveMessage` is called on Solana or else this instruction will revert." Source: the handler requires
`recipient_token_account.key() == mint_recipient` and deserialises it as a token account of the local mint. Real
transactions: in the eight recorded mints `mintRecipient` is account 16 of the instruction, a token account whose *owner*
is another address, credited with `amount − feeExecuted`. So for a burn toward Solana the signer encodes
`mintRecipient` = **the 32 bytes of `ATA(the wallet's Solana address, USDC, Token program)`**, derived from its own key
(`cctpRecipient32`), never the wallet address; the intent names the Solana address in `bridge.recipient` and the signer
requires it to be its own. Otherwise the EVM burn is the existing one, unchanged.

**The account must exist, before the burn.** At preparation the API reads the account on both endpoints (existence, owner
= Token program, mint = USDC, owner field = the wallet, not frozen). If it does not exist the burn is **refused**
("token_account_missing: … Nothing was burned") and the Swap screen offers to create it: one `CreateIdempotent`
instruction of the Associated Token Account program for the wallet's own USDC account, paid by the wallet — a passkey
approval over a canonical request (`SolTokenAccountSchema`, hash domain `SPW-SOL-TOKEN-ACCOUNT-v1`), which the signer
accepts only for its own address, the registry USDC mint and the derived account, with fee + deposit (bound 2 039 280
lamports; 1 488 440 measured) under the policy ceiling. The deposit stays in the wallet's own token account.

**SOL before the burn.** The mint is paid in SOL: 5 000 lamports + priority fee + **695 960 lamports for the used-nonce
record** (9 bytes; paid by the payer, not refundable). The preparation requires that much SOL beyond the rent-exempt
minimum of the wallet account, as the EVM path requires destination gas; otherwise "destination_gas … Nothing was burned".

**The mint** (`buildCctpSolMintMessage`): one instruction, `receive_message`, 20 accounts all derived by the signer —
payer and caller = the wallet; `["message_transmitter_authority", TokenMessengerMinterV2]`; the transmitter state;
`["used_nonce", nonce]`; the receiver program; then for the token messenger: its state, `["remote_token_messenger",
"<source domain>"]`, the minter, `["local_token", mint]`, `["token_pair", "<source domain>", source token bytes]`, the fee
recipient's associated account (pinned owner), **the wallet's own token account**, `["custody", mint]`, the Token
program. The wallet appears nowhere among the accounts handed on to the receiver (the program forwards signer flags of
remaining accounts). Compute limit 150 000–400 000 (real mints used 183–207 k).

Before building, the message is checked by **the same verifier as for EVM mints** (`verifyCctpMint`), in its
Solana-destination variant: version 1 / 1, 376 bytes (no hook), source domain and USDC of the EVM network, destination
domain 5, `sender` = the pinned EVM TokenMessengerV2, `recipient` = the Solana token-messenger program, `destinationCaller`
= 0, `mintRecipient` = the wallet's own token account, `messageSender` = the wallet's EVM address, amount, fee ceiling and
finality as approved, `feeExecuted ≤ maxFee` and `< amount`, all amounts within 64 bits. The only value-bearing effects of
the transaction are then: USDC from Circle's custody account to the wallet's own token account (and Circle's fee to its
own), and the wallet's SOL for the fee and the used-nonce record — bounded by the policy ceiling.

**Authorisation: the existing bridge-record rule.** The burn approval covers exactly one mint signature; an identical
request returns the same bytes; any other needs a passkey assertion (`SPW-BRIDGE-MINT-SOL-v1` …); at most six; one message
serves one bridge. One practical difference from EVM: a Solana transaction lives about a minute. If the mint is not
included in time the transfer shows "the receiving transaction was not included in time" and **"approve a new mint"**
(passkey) — the USDC keeps waiting.

**Double mint.** The program creates the used-nonce record with `init`: a second `receive_message` for the same nonce
fails at the System program ("already in use"). The API checks that record on both endpoints before signing and when its
own transaction fails: if it exists the transfer is done ("minted by someone else" when it was not the wallet's
transaction), and nothing is signed. A Fast message's `expirationBlock` is a Solana slot there; past it the API asks Circle
for a re-attestation, as on EVM.

### 13.7 What the API does (bridge routes unchanged in shape)

`GET /bridge/quote` and `POST /bridge/proposals` accept `solana` on either side; the quote adds a `solana` object (source:
the deposit and the fee; destination: the token account, whether it exists, the rents) and `destinationGas` is in SOL for a
Solana destination. New routes: `POST /bridge/proposals/:id/reclaim/options` and `/reclaim`; `GET` and
`POST /bridge/solana/token-account[/options]`.

Preparing a burn on Solana (`prepareSolBurn`): guards on both networks; USDC in the wallet's own token account; destination
gas on the EVM network; Circle's fee from Iris (and the program's minimum for Standard); live rent; then **a simulation of
the exact transaction the signer will build** — with a throwaway public key standing for the event account — which must
succeed, debit exactly the amount, cost exactly fee + deposit, touch no other token account of the wallet, create the
event account with the wallet as rent payer, and store **exactly the message the intent implies; that message, completed
as Circle completes it, must pass the mint verifier.** A burn whose message our own mint check would refuse is never
offered. After the passkey the API checks that the signed bytes are, byte for byte, the burn of the approved intent with
the signer's event account, simulates them with both signatures checked, and relays them.

Standard from Solana is attested in about 17 s, Fast in under a second (Circle's figures); the review sheet shows the
speed, Circle's fee ceiling, the deposit and its date, the fee ceiling in SOL. Plans (`docs/v7/ANY-TO-ANY.md`) use the same
route: `planCaps().cctp` now lists Solana, so the planner offers e.g. SOL → [Jupiter] → USDC → [CCTP] → USDC on Base →
[KyberSwap] → cbBTC, each leg with its own passkey. In a plan the deposit appears among the network fees of the CCTP leg
(the quote adapter lists it there) and is counted, with the usual margin, in the SOL the plan requires.

### 13.8 Costs of a real transfer (2026-11-11 figures)

| | Solana → EVM | EVM → Solana |
|---|---|---|
| Circle's fee | Standard 0; Fast 1 bps | Standard 0; Fast per the source network (§4) |
| Source network fee | 0.00001 SOL (two signatures) + priority fee (bounded so the total stays ≤ 0.003 SOL) | as §12.6 (approval + burn) |
| Refundable | **0.00282448 SOL** event-account deposit, back after five days less ≈ 0.000005 SOL | — |
| Destination | gas of `receiveMessage` on the EVM network (§12.6) | 0.000005 SOL + priority fee + **0.00069596 SOL** used-nonce record (not refundable) |
| Once | — | 0.00148844 SOL deposit to open the USDC token account, if the wallet has none |
| Attestation | ≈ 17 s Standard, < 1 s Fast | as the source network (§1) |

### 13.9 Proof (`npx tsx scripts/sim-solana-cctp.mts`, needs anvil)

Nothing is sent to a real network; the keys are fresh random keys and a software passkey. Solana transactions are
simulated on the public mainnet endpoints; EVM transactions run on a local fork of Base where two **test attesters** are
enabled through the impersonated attester manager (the technique of §12.7 — a burn that exists only in a simulation or on
a fork cannot be attested by Circle). Where a transaction must come *from* a funded account, a **public address** stands
in as the wallet (as in `scripts/sim-jupiter.mts`): the signer signs with its own fresh key, so the bytes are simulated
with `sigVerify: false`; the signature format itself is proven separately with `sigVerify: true` ([s]).

What each part establishes:

- **[0]** pins and state on both endpoints.
- **[a]** the burn, prepared by the real API code and signed by the real signer path: success on mainnet, exact debit, event
  account created with the measured rent and the wallet as rent payer, and the stored message read back from the
  simulation = the message the intent implies. Standard and Fast.
- **[c]** those very message bytes, completed as Circle does and signed by the test attesters, are accepted by the signer's
  verifier and **minted by the real EVM contracts on the fork** to the wallet's EVM address (Fast: fee to Circle's
  recipient); a message "sent" by another Solana program is refused on-chain.
- **[s]** the two-signature v1 transaction is accepted by a mainnet node with signature verification on, and rejected with
  either signature altered.
- **[d]** the signer-built EVM burn toward Solana runs on the real TokenMessengerV2 (fork) and emits a message naming the
  Solana token-messenger program as recipient and the wallet's token account as mint recipient; the Solana-side verifier
  accepts it; the signer-built `receive_message` for it runs on mainnet up to the attestation check.
- **[b]** with **Circle's real attestations**: a real EVM → Solana message that nobody had minted yet — the signer-built
  `receive_message` **succeeds** in simulation (token account credited `amount − fee`, payer debited fee + 695 960
  lamports, used-nonce record created); and a real message already minted fails at "already in use" on exactly the
  used-nonce address our code derives. For these, the public sender and recipient of the message stand in as the wallet.
  (Whether an unminted message exists at run time depends on the day; the script says so when it finds none.)
- **[r]** `reclaim_event_account` as our code builds it: success for a real event account older than five days (its rent
  payer receives the deposit less the fee, the account is closed), "EventAccountWindowNotExpired" for a young one. These
  two use the core builder directly: the signer, by design, only reclaims accounts it generated itself.
- **[e]** the signer's refusals.

Unit tests: `packages/core/test/cctp-sol.test.ts` (real fixtures; builders; verifier), `services/isolated-signer/test/bridge-sol.test.ts`
(what the signer builds and refuses), `services/api/test/bridge-sol.test.ts` (routes, worker steps and signer boundary
against a scripted cluster that decodes the transactions and checks every signature).

Output of the run of 2026-11-11 (exit 0):

```
fresh wallet for this run: EVM 0x47485dd99753da35eBaCB52070544d152de4A514, Solana HPrrWRA1pWLmSKz338UPe2xYyY8uMBrPtUaxdDeL6A7Q (random, never funded); Base fork at block 56168728

[0] the two Circle programs, as pinned, and the state the code relies on (read-only)
  ok   MessageTransmitterV2 CCTP…PbeC on api.mainnet-beta.solana.com: ProgramData 2w2z…T1iS, last deployed at slot 343321624, upgrade authority 9SxKDZRge2ianVfwP1MxzwREMHCn28gdGbrvhTNRGWRq, executable 493512 bytes sha256 abbe67181ec4edca…
  ok   MessageTransmitterV2 CCTP…PbeC on solana-rpc.publicnode.com: ProgramData 2w2z…T1iS, last deployed at slot 343321624, upgrade authority 9SxKDZRge2ianVfwP1MxzwREMHCn28gdGbrvhTNRGWRq, executable 493512 bytes sha256 abbe67181ec4edca…
  ok   TokenMessengerMinterV2 CCTP…UMQe on api.mainnet-beta.solana.com: ProgramData 9ZEn…BFFF, last deployed at slot 343322709, upgrade authority HaxwvTGZFT7K8yvQKaUNZxyD593jr4gXCppu4uqQhyXK, executable 716232 bytes sha256 ccdac46adb68c570…
  ok   TokenMessengerMinterV2 CCTP…UMQe on solana-rpc.publicnode.com: ProgramData 9ZEn…BFFF, last deployed at slot 343322709, upgrade authority HaxwvTGZFT7K8yvQKaUNZxyD593jr4gXCppu4uqQhyXK, executable 716232 bytes sha256 ccdac46adb68c570…
  --   upgrade authority 9SxKDZRge2ianVfwP1MxzwREMHCn28gdGbrvhTNRGWRq: owner 11111111111111111111111111111111, 0 bytes of data — a system-owned address (a key, not a visible multisig); it can replace the program at any time
  --   upgrade authority HaxwvTGZFT7K8yvQKaUNZxyD593jr4gXCppu4uqQhyXK: owner 11111111111111111111111111111111, 0 bytes of data — a system-owned address (a key, not a visible multisig); it can replace the program at any time
  ok   token_messenger state: fee recipient 4BPnUzFDibVcWQ5zzixGodRUHwqDxHYpUPdPYus3Bn56 (pinned), Standard minimum fee 0 / 10⁷, message body version 1
  ok   remote_token_messenger PDA of each of the 7 EVM domains holds the pinned EVM TokenMessengerV2 (the "recipient" of a Solana-sourced message)
  ok   Base: TokenMessengerV2.remoteTokenMessengers(5) = 0xa65fc81d0fefa886… = the Solana TokenMessengerMinterV2 program id (the "sender" a Solana-sourced message must carry)
  ok   USDC EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: a classic SPL Token mint (owner Toke…Q5DA), 6 decimals; freeze authority 7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar
  ok   rent measured now: event account (428 bytes) 0.00282448 SOL — refundable; used-nonce record (9 bytes) 0.00069596 SOL; token account (165 bytes) 0.00148844 SOL; minimum of a wallet account 0.00065024 SOL

[a] Solana → EVM: the burn, prepared by the API code and signed by the signer, for a public address standing in as the wallet
  --   stand-in wallet GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE: 25383.177564153 SOL, 935252.209889 USDC in its associated token account DeqZejBFrRwWraY4g4besYmibTY1QcV1Fcg6VfoEvn4T
  --   [fork only] Base fork: two TEST attesters enabled through the impersonated attester manager 0xdf265e0329f6a08a772b48191b33bdc624499b84 (threshold stays 2); the fresh wallet got 1 ETH and 100 USDC there
  standard: 25 USDC → Base; Circle fee ceiling 0 USDC; network fee 0.000010337 SOL (2 signatures + priority, limit 67204 CU, 41763 used); refundable deposit 0.00282448 SOL; approved ceiling 0.002834817 SOL (policy: 0.003)
  ok   API preparation: both program pins, USDC mint, fee recipient, wallet account, balances, destination gas on Base, and a simulation of the exact transaction (with a throwaway key as event account) — all passed
  ok   signed after the passkey: one instruction (deposit_for_burn, 18 accounts, 16 keys, 816 bytes), two signers — the wallet and the event account 3aGobuR9QmxeegPmTKdBeYMvSkbpmFitJE3UHGuGxHQC generated by the signer for this burn (not the API's throwaway key)
  ok   simulation on mainnet: SUCCESS (41763 CU); the wallet's USDC token account is debited exactly 25 USDC
  ok   event account created: 428 bytes, owner CCTP…PbeC, rent 0.00282448 SOL, recorded rent payer = the wallet (so the wallet alone can reclaim it)
  ok   the wallet pays 0.002834817 SOL = fee 0.000010337 + deposit 0.00282448; nothing else moves
  ok   the 376-byte message stored by the program is, byte for byte, the one the approved intent implies
       sourceDomain 5 → destinationDomain 6; sender CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe (TokenMessengerMinterV2); recipient 0x28b5a0e9c621a5badaa536219b3a228c8168cf5d (EVM TokenMessengerV2)
       burnToken EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v; amount 25000000; mintRecipient 0x47485dd99753da35ebacb52070544d152de4a514 (the wallet's EVM address); messageSender GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE (the wallet's Solana public key); maxFee 0; minFinality 2000; destinationCaller 0
  ok   messageSender = the wallet public key, mintRecipient = the wallet's own EVM address, sender = Circle's Solana token messenger
  fast: 20 USDC → Base; Circle fee ceiling 0.002 USDC; network fee 0.000010337 SOL (2 signatures + priority, limit 67204 CU, 41763 used); refundable deposit 0.00282448 SOL; approved ceiling 0.002834817 SOL (policy: 0.003)
  ok   API preparation: both program pins, USDC mint, fee recipient, wallet account, balances, destination gas on Base, and a simulation of the exact transaction (with a throwaway key as event account) — all passed
  ok   signed after the passkey: one instruction (deposit_for_burn, 18 accounts, 16 keys, 816 bytes), two signers — the wallet and the event account 99z9bttjzbm8BYtq3LmvGdddb288tt7bSeBdFL5mgZN2 generated by the signer for this burn (not the API's throwaway key)
  ok   simulation on mainnet: SUCCESS (41763 CU); the wallet's USDC token account is debited exactly 20 USDC
  ok   event account created: 428 bytes, owner CCTP…PbeC, rent 0.00282448 SOL, recorded rent payer = the wallet (so the wallet alone can reclaim it)
  ok   the wallet pays 0.002834817 SOL = fee 0.000010337 + deposit 0.00282448; nothing else moves
  ok   the 376-byte message stored by the program is, byte for byte, the one the approved intent implies
       sourceDomain 5 → destinationDomain 6; sender CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe (TokenMessengerMinterV2); recipient 0x28b5a0e9c621a5badaa536219b3a228c8168cf5d (EVM TokenMessengerV2)
       burnToken EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v; amount 20000000; mintRecipient 0x47485dd99753da35ebacb52070544d152de4a514 (the wallet's EVM address); messageSender GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE (the wallet's Solana public key); maxFee 2000; minFinality 1000; destinationCaller 0
  ok   messageSender = the wallet public key, mintRecipient = the wallet's own EVM address, sender = Circle's Solana token messenger

[c] the EVM mint of those Solana-sourced messages on the Base fork (real contracts; attestation by the TEST attesters)
  ok   standard: the signer accepts the message its own burn produces (verifier: source domain 5, Solana token messenger, USDC mint, wallet key as sender, own EVM address as recipient) and signs the one receiveMessage, no second passkey
  ok   standard: receiveMessage mined on the fork (gas 154579): the wallet's EVM address received 25 USDC
  ok   standard: the nonce is marked used on Base
  ok   a second mint request for the same bridge (new nonce) -> refused: a mint was already signed for this bridge; another signature needs the owner's passkey
  ok   on-chain: the same message "sent" by another Solana program, attested by the test attesters -> refused: eth_call: execution reverted: Remote TokenMessenger unsupported
  ok   fast: the signer accepts the message its own burn produces (verifier: source domain 5, Solana token messenger, USDC mint, wallet key as sender, own EVM address as recipient) and signs the one receiveMessage, no second passkey
  ok   fast: receiveMessage mined on the fork (gas 169214): the wallet's EVM address received 19.998001 USDC, Circle's fee recipient 0.001999 USDC (ceiling 0.002)
  ok   fast: the nonce is marked used on Base

[s] signature format of the two-signer transaction: the fresh key's own (unfunded) address, simulated with signature verification ON
       816-byte v1 transaction = message + 2 signatures (wallet, event account)
  ok   both genuine signatures pass verification; the node then answers "AccountNotFound" (the fee payer has never been funded)
  ok   one bit flipped in the wallet's signature: "SignatureFailure"
  ok   one bit flipped in the event account's signature: "SignatureFailure"

[d] EVM → Solana: the burn toward the wallet's Solana token account, mined on the Base fork; the mint simulated on mainnet
  ok   preparation: the wallet's USDC token account on Solana DeqZejBFrRwWraY4g4besYmibTY1QcV1Fcg6VfoEvn4T exists on both RPC endpoints; receiving needs 0.00070226 SOL (fee + 0.00069596 for the used-nonce record), the wallet has 25382.179872674 available
  ok   an address without a USDC token account (HPrr…6A7Q): reported missing (AqVZ4ruJfzvDoxUozPGjeGkiShKKXRsp8NXsRay8wb5C); the API refuses to prepare a burn toward it ("token_account_missing") and offers to create it first (deposit 0.00148844 SOL)
  ok   signer-built depositForBurn: destination domain 5, mintRecipient = DeqZejBFrRwWraY4g4besYmibTY1QcV1Fcg6VfoEvn4T = the wallet's associated USDC token account (not the wallet address GJRs…7npE), destination caller 0
  ok   approval and burn mined on the fork (gas 55437 + 109235): 20 USDC burned — the real TokenMessengerV2 accepts Solana (domain 5) and this recipient
  ok   the message emitted by the real contract: domain 6 → 5, recipient = CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe (the Solana token messenger program), mintRecipient = the wallet's token account, messageSender = the wallet's EVM address, 20 USDC, no destination caller, 376 bytes
  ok   the Solana-side verifier accepts it and the signer builds receive_message (20 accounts, 1244 bytes, no lookup table): payer = caller = the wallet, credited account = its own token account
  ok   simulated on mainnet, it is refused exactly where expected — at the attestation, which only Circle can sign for a real burn (the test attesters' is not): {"InstructionError":[0,{"Custom":6027}]} — Program log: AnchorError thrown in message-transmitter-v2/src/state.rs:113. Error Code: InvalidAttesterSignature. Error Number: 6027. Error Message: Invalid attester signature. | Program CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbe
  --   what ran before that check, on mainnet: the nine accounts of the instruction were validated, the used-nonce record was allocated, the message version matched. The eleven accounts handed on to the token messenger are exercised with a real attestation in [b]

[b] REAL attested EVM → Solana messages (Circle Iris): the signer-built receive_message simulated on mainnet
  in flight: burn 0x65edb84e5cca3894b032c86491243f8bd58d57e6c47ea1e0b5344d1a28bec74c on Ethereum (10 USDC, fee 0, finality 2000) → token account HJjRRTz7eN78G71fRwDBBVyYC1GAMT5z4hQDspW3FQNx of RevS7rhyy3XSXTyRXBj8Hd35wmzMwFJHGZDsA6d1k64
  ok   NOT yet minted: the simulation SUCCEEDS (182533 CU) with Circle's real attestation — the token account is credited 10 USDC (amount − fee), the payer spends 0.00070096 SOL (fee + used-nonce record), the record is created
  already minted: burn 0xceba0cde9466784dfadfb34cb25d0b9f4c17d0d9d82f41772aaf07fd0ffdd1cf on Polygon PoS (6.967864 USDC, fee 0, finality 2000) → token account Bd12E7ad6DsLgeQtMWHAbkbU9YWTaB6e4X13RZJiYc9Z of 8K9KXAFv35omU2SwLQEBq6nPQx92TKKkdD4U5c7P5g7L
  ok   already minted: the simulation fails where the program records the nonce — "Allocate: account Address { address: HHU6bHdYj6PTKJ7ars8H96DtsBLypWHDAzqk4mKayMpa, base: None } already in use" ({"InstructionError":[0,{"Custom":0}]}); that address is the used-nonce record our code derives
  ok   the identical request returns the same bytes (no new signature)
  ok   a second mint for the same bridge without the passkey -> refused: a mint was already signed for this bridge; another signature needs the owner's passkey
  ok   with a passkey assertion over the exact new parameters a second mint transaction is signed (for a mint that expired or failed)
  ok   the same real message with the OWNER address as mint recipient instead of the token account -> refused: message mints to another address

[r] reclaim_event_account as our code builds it, simulated for REAL event accounts (public data; the payee is their rent payer)
  ok   an event account 1 h old (CmJX…twHN): refused by the program — {"InstructionError":[0,{"Custom":6033}]} — Program log: AnchorError thrown in message-transmitter-v2/src/instructions/reclaim_event_account.rs:69. Error Code: EventAccountWindowNotExpired. Error Number: 6033. Error Message: Event account window not expired. | Program CCTPV
  ok   an event account 5.0 days old (97T4GSWrMksGkKGc6kg9bscY3eE2pzfW1FQM1sELScx2, burn Q4uy…y26t): SUCCESS (145229 CU) — the account is closed and its rent payer receives 0.00281948 SOL (the 0.00282448 deposit less the 0.000005 fee), signed by the payee alone

[e] what the signer refuses (each request carries a valid passkey approval of exactly what is asked, unless said)
 burn on Solana:
  ok   another mint recipient (someone else's EVM address) -> refused: the recipient is not this wallet's own address on the destination network
  ok   a Solana token account as mint recipient of a burn toward an EVM network -> refused: not an EVM address
  ok   another amount than the one the owner approved -> refused: approval verification failed: Unexpected authentication response challenge "uuDInql1cAlD60448TFMrhgL4jz4rlHYTcRIfruk8T0"
  ok   an amount above the per-transfer limit -> refused: amount above per-transaction limit for solana:USDC
  ok   another mint (USDT) -> refused: only the registry USDC can be bridged
  ok   another destination domain than the destination network's -> refused: destination domain does not match the destination network
  ok   another payer / owner (a burn "from" another address) -> refused: source address is not controlled by this signer
  ok   an unpinned program as token messenger -> refused: messenger is not the pinned TokenMessengerMinterV2 program
  ok   an unpinned program as message transmitter -> refused: transmitter is not the pinned MessageTransmitterV2 program
  ok   extra instructions handed over as helper data (a transaction message from the API) -> refused: a bridge takes no helper data: the signer builds the transaction itself
  ok   an event account that the signer did not generate (handed over by the API) -> refused: a bridge takes no helper data: the signer builds the transaction itself
  ok   a fee ceiling above the policy -> refused: fee ceiling above policy
  ok   a replay of an approved burn -> refused: proposal already signed
  ok   nothing was recorded by any of these
 mint on an EVM network of a Solana-sourced message:
  ok   mint recipient = another EVM address -> refused: message mints to another address
  ok   messageSender = the wallet's token account instead of its public key -> refused: message was not burned by this wallet
  ok   messageSender = another Solana wallet -> refused: message was not burned by this wallet
  ok   another amount -> refused: message carries another amount
  ok   another mint -> refused: message burns another token
  ok   another source domain -> refused: message comes from another source domain
  ok   a destination caller -> refused: message restricts the destination caller
  ok   a sender that is not Circle's Solana token messenger -> refused: message is not between the pinned TokenMessengers
  ok   a mint for a bridge that was never approved -> refused: no approved bridge with this id
 reclaim of the event-account deposit, and the wallet's token account:
  ok   a reclaim before five days -> refused: the deposit cannot be reclaimed before five days
  ok   a reclaim without the passkey -> refused: reclaiming the deposit needs the owner's passkey
  ok   a reclaim naming another event account (the request has no such field; the approval is bound to the recorded one) -> refused: approval verification failed: Unexpected authentication response challenge "uRjsvm5TsFSQ_OS-dCwbRua47XlKf0ehG0jz0q9d7z8"
  ok   with the passkey, five days later: one reclaim_event_account for the event account recorded with the burn, payee = the wallet, signed by the wallet alone
  ok   a token account for someone else -> refused: the token account is not for this wallet
  ok   a token account of another mint -> refused: only the registry USDC token account can be opened here
  ok   a token account without the passkey -> refused: opening the token account needs the owner's passkey
  ok   the wallet's own token account, with the passkey: one CreateIdempotent, simulated on mainnet: success (4338 CU, fee 0.000005 SOL; the account of this stand-in already exists, so nothing is created)
  ok   for a public address without a USDC token account (9SxK…GWRq): simulation SUCCESS (17917 CU) — the account DA9bDwLiktZ2ABdRWaGmXQu1s6JECbJJEZarCSbqwUXn is created, owned by the Token program, with a deposit of 0.00148844 SOL paid by its owner (fee 0.000005 SOL)
  ok   the same for the fresh key's own address, signature checked by the node: accepted, then "AccountNotFound" (never funded)

recorded packages/core/test/fixtures/cctp-sol/simulated.json

SOLANA CCTP PROOF OK — nothing was sent to a real network; Solana transactions were simulated on mainnet, EVM transactions ran on a local fork
```

### 13.10 Verified / not verified (Solana ↔ EVM)

Verified: the pins on two endpoints; the on-chain IDLs; account layouts, seeds and message fields against real
transactions (byte-for-byte reproduction of real instructions); `messageSender`, `sender`, `burnToken`, `recipient` on
eight real attested messages; the recipient-is-a-token-account rule on eight real mints; the signer-built burn simulated
on mainnet; its message minted by the real EVM contracts on a fork; the signer-built `receive_message` simulated on
mainnet with a real attestation; the reclaim simulated on mainnet; the token-account creation simulated on mainnet; the
two-signature v1 wire format accepted by a mainnet node; the EVM burn toward Solana on a fork.

**Not verified:**

- **No transaction was sent**, on Solana or elsewhere. Real inclusion, priority-fee adequacy, the worker's confirmation
  path against a live cluster, and the amount read back from a real confirmed mint are untested outside the scripted
  cluster of the API tests. `solana-test-validator` is not installed on this machine.
- **The pairing "our own burn → Circle attests it → our mint"** has never run with Circle's real attestation service: in
  [c] the attestation of our burn's message is made by test keys on a fork. What is established is each half separately:
  real attested messages of other wallets have exactly the fields our verifier expects, and our burn stores exactly the
  message our verifier expects.
- A real reclaim **through the signer** (its own event account, five days later): only the builder was simulated on
  mainnet, for other people's accounts; the signer path is covered by unit tests.
- The deployed programs were not rebuilt from source; who controls the two upgrade authorities and the IDL authority is
  unknown.
- Iris behaviours for Solana taken from documentation, not observed for our own messages: timing, Fast → Standard
  degradation, re-attestation of an expired Fast message whose expiration is a Solana slot.
- The Standard minimum fee of the Solana program (`min_fee` > 0) was never seen non-zero.
- Solana's rent rate: the signer's figures are bounds only while the rate stays at or below the 2026-11-11 rate; a rise
  stops the leg at the API's check rather than at the signer.
- The plan executor with a Solana CCTP leg was exercised at the planner and route level (unit and API tests), not by a
  full fork-plus-simulation plan run; the web screens were type-checked and built, not exercised in a browser.
- USDC on Solana has a freeze authority (Circle): a frozen token account is refused at preparation; a freeze between burn
  and mint would leave the USDC mintable only once Circle unfreezes — outside the wallet's control, as on EVM.
