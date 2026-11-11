# LI.FI — execution dossier

Status in this phase: **price discovery only**. The adapter (`packages/swap/src/providers/lifi.ts`) asks for priced routes and
never asks LI.FI for transaction data. Quotes are `executability: opaque`. Everything below was read on 2026-11-10 from the
official documentation and from the live API; statements that come from a live answer rather than from the docs say so.

## 1. What LI.FI is

A routing aggregator: one API in front of bridges (Relay, Mayan, NEAR Intents, Chainflip, Polymer/CCTP, Layerswap, Symbiosis,
Across, Stargate…) and DEX aggregators (1inch, Kyberswap, Sushi, OKX, Jupiter…). On EVM chains and TRON every route is executed
through one contract, the **LiFiDiamond** (EIP-2535 proxy with one "facet" per bridge), which pulls the input, takes LI.FI's fee,
optionally swaps, then calls the bridge. LI.FI itself holds no liquidity and settles nothing: finality, speed and refunds are
those of the bridge the route names.

## 2. Networks and identifiers (verified live)

`GET https://li.quest/v1/chains` (EVM) and `GET /v1/chains?chainTypes=SVM,UTXO,MVM,TVM,STL`:

| Wallet network | LI.FI chain id | type | native token id | LiFiDiamond |
|---|---|---|---|---|
| ethereum | 1 | EVM | `0x0000000000000000000000000000000000000000` | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` |
| base | 8453 | EVM | zero address | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` |
| arbitrum | 42161 | EVM | zero address | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` |
| polygon | 137 | EVM | zero address | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` |
| optimism | 10 | EVM | zero address | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` |
| bsc | 56 | EVM | zero address | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` |
| avalanche | 43114 | EVM | zero address | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` |
| hyperevm | 999 | EVM | zero address | **`0x0a0758d937d1059c356D4714e57F5df0239bce1A`** (differs) |
| tron | 728126428 | TVM | `T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb` | `TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt` |
| solana | 1151111081099710 | SVM | `11111111111111111111111111111111` (wSOL is a different token) | none |
| bitcoin | 20000000000001 | UTXO | `bitcoin` | none |
| sui | 9270000000000000 | MVM | `0x0000…0002::sui::SUI` | none |

- The Sui id is **above 2^53** (not a "safe" integer). It is an exact double, so JSON round-trips it unchanged (tested), but it
  must never go through arithmetic or a 32-bit field.
- Not served: Litecoin, Dogecoin, Bitcoin Cash, XRPL, Aptos, Cosmos, NEAR, TON (not LI.FI chains; `chainTypes` rejects anything
  but EVM, SVM, UTXO, MVM, TVM, STL). **Stellar** is listed (id 1201081091099710, Soroban contract ids) but a live request for
  native XLM returned no route (`near`: "Quoting for this pair is not available", `layerswap`: "Route not found"; the USDC
  routes need a trustline). It is not declared; recording in `test/fixtures/lifi/no-route-stellar.json`.
- TRON is cross-chain only ("Quotes with Tron as the source chain are always cross-chain", Tron overview). Addresses are
  base58, case-sensitive; the hex `41…` form is refused.
- Solana: "we only support single step transactions per ecosystem" (Solana overview).

Official sources for the contracts:
- <https://docs.li.fi/introduction/lifi-architecture/smart-contract-addresses> (Diamond `0x1231…4EaE` "on most supported
  networks"; "on some networks the address is different").
- `diamondAddress` of each chain in <https://li.quest/v1/chains> — the values in the table above.
- Deployment files, one per network: <https://github.com/lifinance/contracts/tree/main/deployments> (`mainnet.json`,
  `base.json`, `arbitrum.json`, `polygon.json`, `optimism.json`, `bsc.json`, `avalanche.json`, `hyperevm.json`, `tron.json`),
  read 2026-11-10. They agree with the API for `LiFiDiamond` on all nine networks.

Other contracts a route names (from the same deployment files):

| Contract | Address | Role |
|---|---|---|
| FeeForwarder | `0xDe2b920506EE931a6A2ABDF566526220214FBbAE` (7 EVM chains), `0x960413AF34CF1e428E9A157Cd4aABab78134d865` (HyperEVM), `TNZ3fznhvEssLeovS9Uc7zCLgYjKdNjX9P` (TRON) | receives LI.FI's fee inside the Diamond call; it is the `approvalAddress` of the `feeCollection` included step |
| Permit2Proxy | `0x8eEd5E28216C0Bc6F817df40Ae6CA11C2294CC1c` (7 EVM chains), `0x5c006F9d4F33C13DE97FA7BD1c8745Ef0A5bfaCC` (HyperEVM) | optional gasless-approval path; not needed |
| Permit2 (Uniswap) | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | named by `/v1/chains` (`permit2`); not needed |

The per-bridge contracts (`includedSteps[].estimate.approvalAddress`, e.g. Relay depository `0xf70da97812CB96acDF810712Aa562db8dfA3dbEF`
on Base/Ethereum, Kyberswap router `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`) are approved **by the Diamond**, not by the
user. The adapter reports them in `steps[].contracts` for display. They are not pinned and were not checked against each
bridge's own documentation: that is work for the execution phase, per bridge that gets allowlisted.

## 3. API

Base `https://li.quest/v1` (pinned in the adapter). Docs: <https://docs.li.fi/api-reference/introduction>.

| Endpoint | Use | Returns transaction data |
|---|---|---|
| `POST /advanced/routes` | several priced routes (used by the adapter) | **no** |
| `POST /advanced/stepTransaction` | turns one step of a chosen route into a transaction ("fresh quotes are used") | yes |
| `GET /quote` | best single-transaction route in one call | yes (`transactionRequest`) |
| `GET /status` | tracking | — |
| `GET /chains`, `/tokens`, `/tools`, `/connections` | discovery | — |

Why `/advanced/routes` and not `/quote`: it gives every candidate (cheapest and fastest can differ by 18 minutes on the same
pair) in one round, and it does not build a transaction, which is exactly the boundary of this phase.

Request sent by the adapter (identical to the recorded requests in `test/fixtures/lifi/_requests.json`):

```json
{ "fromChainId": 8453, "toChainId": 1151111081099710,
  "fromTokenAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "toTokenAddress": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "fromAmount": "25000000", "fromAddress": "<sender on the source chain>", "toAddress": "<recipient on the destination chain>",
  "options": { "slippage": 0.005, "integrator": "sp-wallet", "allowSwitchChain": false } }
```

- **Sender / recipient on different chain families**: `fromAddress` is in the format of the source chain, `toAddress` in the
  format of the destination chain (EVM hex, Solana base58, Bitcoin address, TRON base58, Sui 32-byte hex). If `toAddress` is
  omitted LI.FI uses `fromAddress`, which is wrong across families: the adapter always sends both and rejects any route whose
  `fromAddress`/`toAddress` differ from the request.
- **Slippage**: a fraction (`0.005` = 0.5 %), applied per step by default (`slippageScope: step`; `route` makes it one budget
  for the whole route). The adapter sends `slippageBps / 10000` and rejects routes priced with another value.
- **Guaranteed minimum**: `toAmountMin` — "the guaranteed minimum value that the transfer will yield including slippage".
  Mapped to `minAmountOut` as is; `toAmount` is the estimate. On some routes the two are equal (seen live on USDC Base →
  USDC Solana with Polymer, Mayan Swift and LI.FI Intents: the bridge delivers a fixed amount).
- **`allowSwitchChain: false`**: routes that need a second signature on the destination chain (Allbridge, Glacis to Solana…)
  are filtered out by LI.FI (`unavailableRoutes.filteredOut`), so each route is one user transaction (one top-level step). A
  route with more than one top-level step or `containsSwitchChain: true` is dropped by the adapter.
- **`integrator`**: free-text tracking string (`LIFI_INTEGRATOR`, default `sp-wallet`). It is not a credential; registering it
  in LI.FI's Partner Portal is what links it to an account and to fee sharing. No `fee` is requested.
- **Duration**: `steps[0].estimate.executionDuration`, seconds (can be fractional; rounded up).
- **Validity**: LI.FI states none for a route. The adapter uses 30 s. Transactions built later carry their own limits (TRON:
  `raw_data.expiration`, about 10 minutes; Bitcoin: "send in a timely manner (~30 min)"; Solana: the blockhash).
- **Errors**: unknown token → HTTP 404 `{ "code": 1003 }` (treated as no route); invalid request → 400 `{ "code": 1011 }`;
  no route → 200 with `routes: []`.

### Fees, as reported in `estimate`

| Field | Meaning | FeeItem |
|---|---|---|
| `gasCosts[]` (`type: SEND`) | gas of the source transaction, in the source chain coin (`amount` = `estimate × price`; use `limit` when sending). TRON: bandwidth and energy, burned as TRX unless the account has staked resources (66 TRX ≈ 21 USD for a USDT transfer, live) | `network`, not in output, estimate |
| `feeCosts[]` "LIFI Fixed Fee" (`feeSplit.lifiFee`) | LI.FI's service fee, **0.25 % of the input** ("LI.FI charges a 0.25% service fee on each transaction"), taken from the input before the first leg | `provider`, inside the output |
| `feeCosts[]` `feeSplit.integratorFee` | integrator's own fee when `fee` is requested (not requested: always 0) | `affiliate` |
| `feeCosts[]` of a `cross` step (Relayer Gas/Service fee, NearIntents fees, Redeem Relayer Fee, Chainflip ingress/network/broker/egress, LayerSwap fee…) | bridge fees, possibly in several assets on several chains | `bridge`, inside the output |
| `feeCosts[]` of a `swap` step | DEX fees when the DEX reports them | `protocol` |

`included: true` means "already accounted for in the quoted amounts and must not be added again"; `false` means the user pays
it on top of `fromAmount`. Every fee seen live was `included: true`. A fee in an asset outside the wallet registry (e.g. Relay
fees in cirBTC on a LINK → cirBTC → JUP route) cannot be a `FeeItem`: when it is inside the output it is left in `raw`; when
it would have to be paid on top the route is dropped.

### Steps

`steps[0].includedSteps[]` in order, each `swap` (same chain), `cross` (bridge) or `protocol` (LI.FI fee collection, same
token in and out). Mapping: the fee step is folded into the next leg (its contract is reported, its amount is in `fees`);
each `swap`/`cross` becomes a `RouteStep` (`swap` / `bridge`) with the tool's display name in `via`. **When the asset between
two legs is not in the wallet registry, the two legs are merged into one `RouteStep`** whose `via` lists both venues in order
(`['Kyberswap', 'Relay']`): the wallet never names an asset it has not vetted, and the route is still described end to end.

## 4. Transaction shapes for the next phase

All of them are obtained with `POST /advanced/stepTransaction` (body = the chosen step, unchanged) or `GET /quote`.

**EVM** (seen live from `/quote`, Base → Solana):
`transactionRequest = { from, to, chainId, data, value, gasPrice, gasLimit }`
- `to` = the LiFiDiamond of the source chain (table above) — pin it; refuse anything else.
- `data` = a facet call, e.g. selector `0x17917a4e`, with a `BridgeData` struct (`transactionId`, `bridge`, `integrator`,
  `referrer`, `sendingAssetId`, `receiver`, `minAmount`, `destinationChainId`, `hasSourceSwaps`, `hasDestinationCall`) followed
  by bridge-specific data and, when there are source swaps, `SwapData[]` (`callTo`, `approveTo`, `sendingAssetId`,
  `receivingAssetId`, `fromAmount`, `callData`, `requiresDeposit`; `src/Libraries/LibSwap.sol`). ABI: <https://github.com/lifinance/contracts/blob/main/src/Interfaces/ILiFi.sol>.
- `value` = the input when it is the chain coin (plus any native bridge fee), else `0x0`.
- **Approval** (ERC-20 input): `approve(estimate.approvalAddress, fromAmount)` where `approvalAddress` is the Diamond. Exact
  amount, never unlimited. USDT on Ethereum needs the allowance reset to 0 first when one already exists.
- What an isolated signer can verify by itself: chain id, `to` = pinned Diamond, `value`, the allowance; inside `data`, the
  **generic** part of `BridgeData` — `sendingAssetId`, `minAmount` (= amount bridged), `destinationChainId`, and `receiver`
  when the destination is EVM. What it cannot: the receiver on a non-EVM destination (`receiver` is an EVM `address`, so the
  real recipient is encoded in the bridge-specific part, different for every facet), the **minimum output on the destination** (lives in
  the bridge's own payload or off-chain intent), and the swap calldata (`SwapData.callData` is opaque DEX-aggregator calldata;
  only `callTo` can be checked against an allowlist). This is why the quotes are `opaque`.

**TRON** (Tron overview): `transactionRequest.data` = `0x` + `raw_data_hex` of an unsigned `TriggerSmartContract`;
`customData.tronTransaction` = the TronWeb object (`txID`, `raw_data`, `raw_data_hex`); `to` = the Diamond
`TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt`; `value` = call value in SUN (hex); `gasLimit` = `fee_limit` in SUN, "a safety ceiling,
not the expected cost". The txID is the SHA-256 of `raw_data`, so the signer can recompute it from `data` alone. TRC-20 input:
a separate `approve(estimate.approvalAddress, amount)` transaction, confirmed first. Valid until `raw_data.expiration`.

**Solana** (Solana tx execution page): `transactionRequest` contains only `data`, "base64 encoded Solana transaction data"
(a serialized transaction; `svmTransactionVersion` says legacy or v0; `svmMaxSupportedTransactionVersion` and
`svmPriorityFeeLevel` are request parameters). No approval. The docs name no program id: the programs are those of the bridge
or of Jupiter. A signer would have to decompile the message and allowlist every program and every writable account —
nothing here is verifiable without that.

**Bitcoin** (Bitcoin tx example): `transactionRequest = { to, data, value }` — `to` is a **vault / depositor address of the
bridge**, `value` the amount in satoshis, `data` a **memo** that "specifies the bridge-specific tx data to execute and
internal LI.FI details for the tracking" and must be carried byte for byte in an OP_RETURN output. Fixed output order:
1. amount to the depositor address, 2. OP_RETURN memo, 3. refund output to the sender (mandatory for Chainflip, whose "stuck
transactions cannot be refunded manually"), 4. integrator fee outputs if any. Only the inputs may be chosen by the wallet. The
signer can verify outputs, amounts and the change/refund address; it cannot verify that the memo names the right recipient
without a per-bridge memo parser (THORChain-style `=:ETH.USDC:0x…` is parseable; Relay's and Chainflip's are opaque).
The vault address rotates and is not pinnable.

**Sui**: the Sui page of the docs is a stub ("same-chain swaps on Sui and bridging between Sui and major EVM chains and
Solana"); the transaction format is not documented there. Not verified. To be read from a live `stepTransaction` answer in
the execution phase (expected: a serialized programmable transaction block).

## 5. Status, completion and refunds

`GET /v1/status?txHash=<source tx hash | destination tx hash | transactionId>&fromChain=<id>&toChain=<id>&bridge=<tool>`
(<https://docs.li.fi/api-reference/check-the-status-of-a-cross-chain-transfer>). `fromChain` is required in practice for TRON
("Tron hashes can't be told apart from Bitcoin hashes by format"). Same-chain swaps: `fromChain = toChain`.

| status | substatus | meaning |
|---|---|---|
| `NOT_FOUND` | — | not indexed or not mined yet. "A persistent 404 or NOT_FOUND isn't terminal evidence of failure" and does not authorize sending again |
| `PENDING` | `WAIT_SOURCE_CONFIRMATIONS`, `WAIT_DESTINATION_TRANSACTION`, `BRIDGE_NOT_AVAILABLE`, `CHAIN_NOT_AVAILABLE`, `REFUND_IN_PROGRESS`, `UNKNOWN_ERROR` | in progress |
| `DONE` | `COMPLETED` | delivered |
| `DONE` | `PARTIAL` | "Only partial transfer completed (common for across, hop, stargate, amarok)". The docs say no more; in practice this is a route whose destination swap did not run, leaving the recipient with the bridged token instead of the requested one — to be confirmed per bridge |
| `DONE` | `REFUNDED` | the bridge returned the funds |
| `FAILED` | `NOT_PROCESSABLE_REFUND_NEEDED`, `OUT_OF_GAS`, `SLIPPAGE_EXCEEDED`, `INSUFFICIENT_ALLOWANCE`, `INSUFFICIENT_BALANCE`, `EXPIRED`, `UNKNOWN_ERROR`, `REFUNDED` | failed |
| `INVALID` | — | the hash does not belong to the tool given |

Polling recommended by the docs: every 10 s for the first minute, then 30 s, then 60 s, with a cap.

**Refunds are those of the bridge, not of LI.FI.** A source transaction that reverts moves nothing. After the source
transaction is mined, what happens to a transfer that cannot complete depends on the bridge (automatic refund on the source
chain, refund to a refund address given at deposit, or delivery of the intermediate token). The route does not say which,
so cross-chain quotes carry `refundable: null`; same-chain swaps are one atomic transaction (`atomic: true`). Two cases
matter for the wallet: if `PARTIAL` leaves the bridged token with the recipient, that token may be one that is **not in the registry** (the wallet would hold it without
showing it) — the execution phase should either restrict routes to intermediates in the registry or pass
`allowDestinationCall: false`; and `NOT_PROCESSABLE_REFUND_NEEDED` needs a manual claim with the bridge.

## 6. Limits, key, terms

- **Rate limits** (<https://docs.li.fi/api-reference/rate-limits>, confirmed by the `ratelimit-*` headers): without a key,
  `/quote` and `/advanced/routes` **75 requests per two hours** each (per IP), `/advanced/stepTransaction` 50 per two hours,
  other endpoints 100 per minute. With a key (`x-lifi-api-key` header, from the Partner Portal): 100 requests per minute by
  default. One quote costs one request, so the keyless limit is a demonstration budget, not a production one: **a key is
  needed before this provider is enabled for users** (the adapter sends `LIFI_API_KEY` when set; `needsKey` stays false
  because the endpoint answers without one). The runtime's local limit should be set well under 75 per two hours meanwhile.
- **Key**: server-side only ("Don't expose the key in client-side code").
- **Terms** (<https://li.fi/legal/terms-and-conditions/>, last updated 4 September 2025): cover the website, the SDK/widget and
  the smart contracts; they do not mention the API or its limits. The user warrants not being sanctioned, not being in a
  comprehensively sanctioned jurisdiction, and **not being a United States citizen, resident or person in the United States**.
  An integrator that offers the integration to others must tell its users that it is independent of LI.FI. LI.FI may ask an
  integrator to stop. To be reviewed by the owner before any execution is offered.

## 7. Verified / not verified

Verified live on 2026-11-10: chain ids and Diamond addresses (API and GitHub deployment files agree); request and response
shape on 11 pairs across EVM, Solana, Bitcoin, TRON, Sui, HyperEVM (fixtures); rate-limit headers; 404 and no-route answers;
quoted rates within 1 % of CoinGecko on eight pairs of about 30 USD (smoke script); the EVM `transactionRequest` shape (one
`/quote` call, nothing signed).

Not verified: any execution; the Sui, Solana and Bitcoin transaction payloads (documentation only, Sui not documented); the
per-bridge contracts and their refund rules; the decoding of `BridgeData` against real calldata; behaviour of
`stepTransaction` when the fresh quote is worse than the route; the meaning of `PARTIAL` per bridge.
