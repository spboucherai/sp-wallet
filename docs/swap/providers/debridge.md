# deBridge (DLN) — execution dossier

Status in this phase: **price discovery only**. The adapter (`packages/swap/src/providers/debridge.ts`) reads the estimate of
`create-tx`; it never signs, relays or submits the transaction that comes with it. Quotes are `executability: opaque`.
Everything below was read on 2026-11-10 from the official documentation (<https://docs.debridge.com>; `docs.debridge.finance`
redirects there), from the live API and from the contracts' source; live observations are marked as such.

## 1. What DLN is

An intent ("order") protocol, not a liquidity-pool bridge. The user creates an **order** on the source chain: *give* an amount
of a token, locked in the `DlnSource` contract, in exchange for a fixed *take* amount of a token delivered to a recipient on
the destination chain. A solver ("taker") fulfils the order on the destination chain with its own funds (`DlnDestination`),
then a cross-chain message unlocks the locked input for the solver. Consequences:

- the output amount is **written in the order**: the recipient receives exactly `takeAmount` or nothing happens;
- nothing is delivered until a solver chooses to fill; an order nobody fills stays open until its creator cancels it;
- DLN is cross-chain only (same chain → error 25 `SAME_SOURCE_AND_DESTINATION_CHAINS`).

## 2. Networks and identifiers (verified live)

`GET https://dln.debridge.finance/v1.0/supported-chains-info`. deBridge uses its own "internal" ids for some chains:

| Wallet network | DLN chain id | native chain id | native token id | flat fee (docs; live value in `fixFee`) |
|---|---|---|---|---|
| ethereum | 1 | 1 | `0x0000000000000000000000000000000000000000` | 0.001 ETH |
| optimism | 10 | 10 | zero address | 0.001 ETH |
| bsc | 56 | 56 | zero address | 0.005 BNB |
| polygon | 137 | 137 | zero address | 0.5 POL (live) |
| base | 8453 | 8453 | zero address | 0.001 ETH (live) |
| arbitrum | 42161 | 42161 | zero address | 0.001 ETH (live) |
| avalanche | 43114 | 43114 | zero address | 0.05 AVAX |
| hyperevm | **100000022** | 999 | zero address | 0.05 HYPE (live; "0.05 WHYPE" in the docs) |
| solana | **7565164** | — | `11111111111111111111111111111111` | 0.015 SOL (live) |
| tron | **100000026** | 728126428 | `T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb` (the zero address is refused: "expecting TVM-compatible address representation") | 4 TRX (live) |

Not served among the wallet's networks: Bitcoin, Litecoin, Dogecoin, Bitcoin Cash, Stellar, XRPL, Aptos, Cosmos, Sui, NEAR, TON.
Flat-fee table: <https://docs.debridge.com/dln-details/overview/fees-supported-chains> ("flat fees can change": read
`DlnSource.globalFixedNativeFee()` or the answer's `fixFee`, never a constant).

### Contracts

Source: <https://docs.debridge.com/dln-details/overview/deployed-contracts> (read 2026-11-10); code:
<https://github.com/debridge-finance/dln-contracts> (`contracts/DLN/DlnSource.sol`, `contracts/libraries/DlnOrderLib.sol`).

| Chains | DlnSource | DlnDestination | DeBridgeRouter (pre-order swap + order) |
|---|---|---|---|
| Ethereum, Optimism, BNB Chain, Polygon, Base, Arbitrum, Avalanche, HyperEVM | `0xeF4fB24aD0916217251F553c0596F8Edc630EB66` | `0xE7351Fd770A37282b91D153Ee690B63579D6dd7f` | `0x663DC15D3C1aC63ff12E45Ab68FeA3F0a883C251` |
| TRON | `TX2Ut1reF59i2WPzsYVoMfA25EkUkavnd5` (= `0xE6f924E3C42350684aF70F798c3cA2533A4c5Bd0`, the form the API returns) | `TXCbCdoHjg28g36X5jnWTP88mRzx54RqXp` | `TRsqznGXF7mSYhRxU49L3HY13QW1v9yBZa` |
| Solana (programs) | `src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4` | `dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo` | — |

Also listed there, not touched by the user: `DlnExternalCallAdapter` `0x61eF2e01E603aEB5Cd96F9eC9AE76cc6A68f6cF9` /
`ExternalCallExecutor` `0xAE0361b1C3454b297129e01046057F1D294c7974` (Ethereum, BNB, Polygon, Arbitrum, Avalanche, Base,
Optimism), `0xE93356b0b87c71A7F4957DCEBEd05BefA8cB624a` / `0x05bD82Dbb7c5C2Cf571112bD1ad4e7c02E10eBEA` (HyperEVM), and
`TE8ZZHE8QEbjQLZCZv1PFKqiz2rCd7oPBV` / `TJuJ19AsSBahPvg2j5AS3v37TtnmuMmeDL` (TRON).

The adapter pins these addresses and rejects an answer whose `tx.to` is neither the `DlnSource` nor the `DeBridgeRouter` of
the source chain. The TRON hex form was derived from the base58 address (base58check payload without the `0x41` prefix) and
matches what the API returned live.

## 3. API

Base `https://dln.debridge.finance/v1.0` (pinned). OpenAPI: <https://dln.debridge.finance/v1.0-json>. Guide:
<https://docs.debridge.com/dln-details/integration-guidelines/order-creation/creating-order/creating-order>.

One endpoint both estimates and creates: `GET /dln/order/create-tx`. Without the three address parameters it returns "only
the quote" (no `tx.data`, no `orderId`, no gas estimate — recording `estimate-without-addresses.json`); with them it also
returns the transaction. The adapter sends the addresses because the source gas estimate (`estimatedTransactionFee`) and the
order id only exist then, and because it lets the answer be checked against the request. **Asking creates nothing**: an order
exists only once the transaction is signed and mined.

Request sent by the adapter:

| Parameter | Value |
|---|---|
| `srcChainId`, `srcChainTokenIn`, `srcChainTokenInAmount` | DLN chain id, token id, exact input in base units |
| `dstChainId`, `dstChainTokenOut` | DLN chain id, token id |
| `dstChainTokenOutAmount` | `auto` — market order: "the API will suggest the best possible outcome … keeping the order profitable for solvers" |
| `prependOperatingExpenses` | `false` — the order takes exactly the requested input; the solver's costs come out of the output |
| `dstChainTokenOutRecipient` | the wallet's address **on the destination chain**, in that chain's format (EVM hex, Solana base58, TRON base58) |
| `senderAddress`, `srcChainOrderAuthorityAddress` | the wallet's address **on the source chain** |
| `dstChainOrderAuthorityAddress` | the wallet's address on the destination chain: the only account that can cancel the order. "Must be controlled by the user", otherwise the funds "may become inaccessible" |

Not sent: `affiliateFeePercent`/`affiliateFeeRecipient` (no affiliate fee), `referralCode`, `srcAllowedCancelBeneficiary`
(see §6), `dlnHook`/`externalCall`, `enableEstimate`.

**There is no slippage parameter.** The requested `slippageBps` is not used: when the input or output is not a reserve asset
the API itself reserves a margin (`recommendedSlippage`, in percent; `PreSwapEstimatedSlippage` / `AfterSwapEstimatedSlippage`
in `costsDetails`) and lowers the take amount accordingly. `dstChainTokenOut.amount` (= `recommendedAmount` for a market
order) is the order's take amount → `amountOut` **and** `minAmountOut`. `maxTheoreticalAmount` (no margin) is not used.
The adapter rejects an answer where `amount ≠ recommendedAmount` or where the input was changed
(`mutatedWithOperatingExpense`).

### Fees

Example, 25 USDC Base → USDC Solana (recorded): output 24.242915 USDC.

| Component | Where it shows | Paid how | FeeItem |
|---|---|---|---|
| Flat fee | `fixFee` (= `tx.value` on EVM when the input is a token) — 0.001 ETH | source chain coin, **on top** of the input | `protocol`, not in output |
| Source gas | `estimatedTransactionFee.total` (wei / lamports / sun). Solana: includes the rent of the order accounts (`giveOrderState`, `giveOrderWallet`, `nonceMaster` ≈ 0.02 SOL) and the priority fee | on top | `network`, estimate |
| Protocol fee | `costsDetails[type=DlnProtocolFee]`, **4 bps** of the input (in the reserve asset on the source chain) | deducted | `protocol`, inside the output |
| Taker margin | `costsDetails[type=TakerMargin]`, about 4 bps (seen 4–17 bps) — the solver's margin | deducted | `provider`, inside the output |
| Operating expenses | `costsDetails[type=EstimatedOperatingExpenses]` — the solver's gas for fulfil + unlock + claim, in the reserve asset of the destination chain: 0.43 USDC (HyperEVM), 0.74 (Solana), 0.78 (Arbitrum), 2.0 (Ethereum), **6.0 USDT (TRON)**, live | deducted | `bridge`, inside the output, estimate |
| Pre-order swap / destination swap | `PreSwap`, `AfterSwap` legs and their `…EstimatedSlippage` reserves (30 bps each, live) | already in the take amount | not fees; `via` says `pre-order swap` / `destination swap` |

"Variable fee and Taker margin are taken out of the input token amount"; "Both fees are fully refunded if the order is
cancelled" (fee structure page). On 30 USD the all-in cost measured live was 2.5 USD (Base → HyperEVM) to 14.7 USD
(TRON → Ethereum): the flat fee and the operating expenses do not scale with the amount, so DLN is expensive for small
orders and competitive for large ones. `usdPriceImpact` (percent of the input's USD value lost, all fees included, negative
= loss) is mapped to `priceImpactBps` with the sign reversed.

A cost charged in an asset outside the wallet registry (taker margin and operating expenses in USDC on BNB Chain, for
instance) cannot be a `FeeItem`; it is inside the output anyway and stays in `raw`.

Other fields: `order.approximateFulfillmentDelay` (seconds, 1–15 live) → `estimatedSeconds`; `orderId` (deterministic, the
same on both chains) → quote id. **Validity**: no hard expiry ("no explicit time-to-live"), but "sign and submit within 30
seconds" for a success likelihood above 99.9 % → `expiresAt` = now + 30 s.

Errors (HTTP 400, `{ errorCode, errorId, errorMessage }`): `ERROR_LOW_GIVE_AMOUNT` (12, amount cannot cover the solver's
costs), `IMPOSSIBLE_ROUTE`, `UNSUPPORTED_TOKEN_IN/OUT` → no route. Everything else (`NOT_A_TOKEN` 152,
`INVALID_QUERY_PARAMETERS` 2, `SAME_SOURCE_AND_DESTINATION_CHAINS` 25, 5xx) → provider error.

## 4. Transaction shapes for the next phase

Source: <https://docs.debridge.com/dln-details/integration-guidelines/order-creation/submitting-the-transaction>.

### EVM, input is a reserve asset (USDC, USDT, ETH…): direct order — **fully decodable**

`tx = { to: DlnSource, data, value }`, `value` = flat fee (+ the input when it is the chain coin; checked by the adapter).
`data` is `createSaltedOrder` (selector `0xb9303701`, confirmed by decoding the recorded answers):

```solidity
function createSaltedOrder(OrderCreation _orderCreation, uint64 _salt, bytes _affiliateFee, uint32 _referralCode,
                           bytes _permitEnvelope, bytes _metadata) external payable returns (bytes32);
struct OrderCreation {
  address giveTokenAddress; uint256 giveAmount;      // what the user locks
  bytes takeTokenAddress;   uint256 takeAmount; uint256 takeChainId;   // what the recipient gets, and where
  bytes receiverDst;                  // recipient: 20 bytes (EVM, TRON without 0x41) or 32 bytes (Solana public key)
  address givePatchAuthoritySrc;      // source authority (may increase the give amount)
  bytes orderAuthorityAddressDst;     // destination authority (may cancel)
  bytes allowedTakerDst;              // the only solver allowed to fill
  bytes externalCall;                 // hook executed on fulfilment — must be empty
  bytes allowedCancelBeneficiarySrc;  // fixed refund recipient, or empty
}
```

Decoded from the recording `base-usdc-sol-usdc.json`: `giveTokenAddress` = USDC Base, `giveAmount` = 25000000,
`takeTokenAddress` = the 32 bytes of the Solana USDC mint, `takeAmount` = 24242915 (= the quoted output), `takeChainId` =
7565164, `receiverDst` = `orderAuthorityAddressDst` = the 32 bytes of the requested recipient, `givePatchAuthoritySrc` = the
sender, `externalCall` = `0x`, `_affiliateFee` = `0x`, `_referralCode` = 0, `_permitEnvelope` = `0x`,
`allowedCancelBeneficiarySrc` = `0x`, `_salt` = `order.salt`. Same result on Arbitrum → TRON, Base → HyperEVM and TRON →
Ethereum.

**This is the route to `executability: verified`**: for a direct order the isolated signer needs nothing from the API but the
numbers. It can build `createSaltedOrder` itself from the intent (token, amount, take token, take amount, destination chain
id, recipient, its own two authorities, empty hook, empty affiliate fee), choose the salt, read the flat fee from
`DlnSource.globalFixedNativeFee()`, and never touch API calldata. What it takes from the API and cannot check alone:
`takeAmount` (a price — the risk engine's job) and `allowedTakerDst`. Two points to settle first: (1) live answers set
`allowedTakerDst` to one address (`0x555ce236c0220695b68341bc48c68d52210cc35b` on EVM/TRON destinations, a 32-byte key on
Solana) — only that solver can fill, consistent with the licence ("trades can be fulfilled only by a solver that is verified
and designated by deBridge"); an order built without it may not be picked up by the API's solver set, to be tested with a
small real order; (2) `_metadata` (returned as `order.metadata`) is analytics data whose absence must be confirmed harmless.

**Approval** (token input): "give approval to the smart contract address specified in the `tx.to` field" for at least
`estimation.srcChainTokenIn.amount` — i.e. `approve(DlnSource, giveAmount)`, exact, not unlimited. The docs suggest an
unlimited allowance or a 30 % buffer only for `prependOperatingExpenses=true`, which the wallet does not use. A permit
envelope (`srcChainTokenInSenderPermit`) is an alternative; not needed.

### EVM, input is not a reserve asset: order through DeBridgeRouter — **opaque**

`tx.to` = `DeBridgeRouter` (`0x663D…C251`), selector `0x4d8160ba` (live): the router pulls the input, swaps it through a DEX
aggregator into the reserve asset (`estimation.srcChainTokenOut`, minimum = `amount`, up to `maxRefundAmount` of surplus
returned), then creates the order. The swap calldata inside is aggregator calldata: the signer can pin the target, the
value and the allowance (spender = the router) and could decode the trailing order, but not the swap. Stays `opaque`. An
alternative for the wallet: swap to USDC with a verified same-chain provider first, then place a direct order.

### Solana

`tx` contains only `data`: a **hex-encoded `VersionedTransaction`**. Before signing: deserialize, set the compute-unit price
and limit (`compiledInstructions[1]` / `[0]` in the docs' example — positions are an assumption of that example), **replace
`recentBlockhash` with a fresh one**, sign, send. No approval. Flat fee 0.015 SOL and account rents are paid by the
transaction itself. Program: `src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4`. A signer would have to decompile the message
and check the program ids and the `create_order` arguments; the instruction layout was not checked here. `opaque`.

### TRON

Not described in the docs' submission page. Live: `tx = { to, data, value }` with `to` = `DlnSource` in **0x form**, `data`
= the same `createSaltedOrder` calldata (decoded successfully: `giveTokenAddress` = USDT in 20-byte form), `value` = 4000000
sun. The wallet has to wrap it into a `TriggerSmartContract` (owner = sender, contract = `TX2Ut1…vnd5`, call value = `value`,
data, fee limit ≥ the estimate: `estimatedTransactionFee.total` was 35.75 TRX for 275000 energy at 130 sun). TRC-20 input
needs a prior `approve(DlnSource, amount)`. With a native TRX input (live, 100 TRX → USDC Base): `to` = TRON's
`DeBridgeRouter` in 0x form (`0xaE7e6618e64591Ad642Ad63680FdD1AcCEfE05fB`), `value` = 104000000 sun (input + flat fee), a
pre-order swap into USDT, 79 TRX of estimated energy.

## 5. Status tracking

- `GET https://dln.debridge.finance/v1.0/dln/tx/{hash}/order-ids` — order ids created by a source transaction.
- `GET https://dln.debridge.finance/v1.0/dln/order/{id}/status` and `/dln/order/{id}` — status / full order.
- Order tracking API (separate host and rate limit): `GET https://dln-api.debridge.finance/api/Orders/{orderId}`,
  `GET …/api/Orders/creationTxHash/{hash}`, `GET …/api/Transaction/{hash}/orderIds`, `POST …/api/Orders/filteredList`.
  The destination transaction is in `fulfilledDstEventMetadata.transactionHash`.

| State | Meaning |
|---|---|
| `Created` | placed, waiting to be filled |
| `Fulfilled` | the solver delivered: "the full requested amount has reached the `dstChainTokenOutRecipient`" — **done for the user** |
| `SentUnlock` | the solver started unlocking the input on the source chain |
| `ClaimedUnlock` | the solver received the input; final state of a successful order |
| `OrderCancelled` | the destination authority cancelled on the destination chain |
| `SentOrderCancel` | the cancellation message is travelling to the source chain |
| `ClaimedOrderCancel` | the input was returned on the source chain; final state of a cancelled order |

`Fulfilled`, `SentUnlock` and `ClaimedUnlock` all mean the recipient has been paid.

## 6. Cancellation and refund

Source: <https://docs.debridge.com/dln-details/integration-guidelines/order-creation/cancelling-order>.

- An order that is not filled is not refunded by itself. "The only way to cancel is on the destination chain": a separate
  transaction **sent by `dstChainOrderAuthorityAddress`** — which is why that address must be the wallet's own.
- `GET /v1.0/dln/order/{id}/cancel-tx` returns `{ chainId, to, data, value, from, cancelBeneficiary }`.
- It costs money on the destination chain: `value` "is always positive" (deBridge messaging fee in the destination chain
  coin plus a prepayment of the source-chain claim gas), plus gas. **The wallet therefore needs the destination chain's coin
  to recover an unfilled order** — on a first transfer to a chain where it holds nothing, it cannot cancel until funded.
- The input comes back on the source chain "in full including affiliate and protocol fees"; the flat fee too ("Both fees are
  fully refunded if the order is cancelled"). Gas spent is not.
- Refund recipient: `allowedCancelBeneficiarySrc` when it was fixed at creation, otherwise chosen at cancellation (the API's
  default is `srcChainOrderAuthorityAddress`). The adapter leaves it unset, as the recorded orders show (`0x`); the
  execution phase should **set `srcAllowedCancelBeneficiary` = the sender**, so the refund address is fixed in the order and
  not at the discretion of whoever builds the cancel transaction.
- Time for the refund to land: not stated in the docs.
- "Automatic cancellations" exist for affiliates (<https://docs.debridge.com/dln-details/affiliates/auto-cancellations>);
  not read in detail.

Hence `refundable: true`, `atomic: false`.

## 7. Limits, key, terms

- **Rate limits** (<https://docs.debridge.com/home/resources/status-limits>): 50 requests per minute without a key, 300 with
  one, per endpoint and per API (`dln.debridge.finance` and `dln-api.debridge.finance` are counted apart); HTTP 429 above.
- **Key**: "open to everyone with a limited RPS and doesn't require authentication"; "commercial integrations are expected
  to authenticate with a dedicated API key", requested through a form. The docs page read does not name the header; no key
  support is implemented.
- **Licence** — deBridge SDK & API License Agreement, DXTECH INC., last updated 1 October 2025
  (<https://docs.debridge.com/dln-details/overview/legal>). Clauses that bear directly on this integration, **to be reviewed
  by the owner before anything beyond private testing**:
  - "The APIs shall not be used for aggregation purposes." A router that puts DLN quotes next to other providers' is
    arguably that.
  - the client may not "charge, directly or indirectly, any fees" for access without written approval;
  - no selling, sharing or sublicensing of API content; no scraping or competitive benchmarking;
  - KYC/AML obligations are the client's; deBridge may ask for specific addresses to be blocked;
  - "as is", liability capped at USD 200 or three months of fees; Panama law.
  Terms of service named by the OpenAPI document: <https://app.debridge.finance/assets/files/DLN-TermsOfService.pdf> (not read).

## 8. Verified / not verified

Verified live on 2026-11-10: chain ids; request/response shape on eleven pairs across EVM, Solana, TRON and HyperEVM
(fixtures); `tx.to` and `tx.value` rules on EVM and TRON, token and native inputs; full ABI decoding of `createSaltedOrder` in four
recorded answers against the contract source; the three error answers; rates before itemised deductions within 0.6 % of
CoinGecko on seven pairs of about 30 USD (smoke script).

Not verified: any execution or cancellation; that an order without `allowedTakerDst`/`_metadata` gets filled; the Solana
instruction layout; the TRON transaction wrapping; the order status API answers (documented only); the refund delay; the
API-key header.

The adapter's two checks on the calldata — target contract pinned, recipient bytes present — are necessary conditions, not a
verification of the order (the recipient's bytes also appear as the destination authority). They catch a wrong answer; they
do not make the transaction safe to sign.
