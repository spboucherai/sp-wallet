# CCTP (Circle Cross-Chain Transfer Protocol) — execution dossier

Provider id `cctp` · adapter `packages/swap/src/providers/cctp.ts` · tests `packages/swap/test/cctp.test.ts` ·
live check `scripts/smoke-swap-cctp.mts`. Everything below was read from Circle's documentation and source on
**2026-11-10** and, where marked *checked*, confirmed on mainnet the same day. The quote adapter itself only quotes.

**Execution status (2026-11-11): USDC between the seven EVM networks is executable by the wallet itself** — burn,
attestation, mint, always to the wallet's own address — see **§12**. Solana legs and EURC remain quote-only. No real
transfer has been broadcast yet; the proof is on local forks (§12.7).

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

## 11. What is verified, and what is not (quote adapter)

Verified live (smoke script, 2026-11-11): the pinned addresses, domains, versions and wiring on all eight networks; the
10 M burn limit; the fee schedule of the 56 USDC routes; the EURC deployments and resolvers; ten quotes with latency
(117–334 ms per quote, one round of 2–4 parallel requests); selectors, gas ranges, Solana account sizes and the fee
rounding against real transactions; the message layout against a real attested message.

Not verified: the Solana account lists and PDA seeds of §7.2–7.3 come from source reading (no Solana transaction was
built); `estimatedSeconds` is Circle's documented average, not a measurement; the behaviour "insufficient `maxFee` ⇒
attested as Standard" is Circle's statement; the non-USDC message body has not been analysed; rounding was observed on
one source chain (Arbitrum). For the EVM execution path see §12.8.

## 12. Execution: USDC between EVM networks (implemented 2026-11-11)

Scope: USDC only; Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, HyperEVM (`CCTP_ENABLED`, 42 ordered pairs);
sender and recipient are always the wallet's own EVM address (the same on every EVM network). No hooks, no destination
caller, no swap leg, no Solana, no EURC, no Forwarding Service.

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
