# Maya Protocol (MAYAChain) — execution dossier

Status in this phase: **price discovery only** (`executability: quote_only`, `atomic: false`). Adapter:
`packages/swap/src/providers/maya.ts` (configuration) on the engine of `thorchain.ts`. MAYAChain is a fork of THORChain:
same quote endpoint shape, same 1e8 fixed point, same memo grammar, same vault model. **Read `thorchain.md` first**; this
file states what was verified for Maya on **2026-11-10 (2026-11-11 UTC)**, MAYANode `1.135.4`, and what differs.

## 1. Sources

| What | URL |
|---|---|
| Endpoints | https://docs.mayaprotocol.com/mayachain-dev-docs/concepts/connecting-to-mayachain |
| Swap quickstart | https://docs.mayaprotocol.com/mayachain-dev-docs/introduction/swapping-guide/quickstart-guide |
| Streaming swaps | https://docs.mayaprotocol.com/mayachain-dev-docs/introduction/swapping-guide/streaming-swaps |
| Sending transactions | https://docs.mayaprotocol.com/mayachain-dev-docs/concepts/sending-transactions |
| Memos | https://docs.mayaprotocol.com/mayachain-dev-docs/concepts/transaction-memos |
| Quote implementation | https://gitlab.com/mayachain/mayanode/-/blob/develop/x/mayachain/querier_quotes.go |
| Limit enforcement | https://gitlab.com/mayachain/mayanode/-/blob/develop/x/mayachain/swap_current.go |
| Short codes | https://gitlab.com/mayachain/mayanode/-/blob/develop/common/asset.go |
| EVM router source | https://gitlab.com/mayachain/ethereum/eth-router/-/blob/master/contracts/MAYAChain_Router.sol |

Endpoints: the docs list `https://mayanode.mayachain.info/mayachain` (pinned by the adapter), Midgard
`https://midgard.mayachain.info/v2`, Tendermint `https://tendermint.mayachain.info`. A second, independently hosted MAYANode
answers at `https://api-maya.liquify.com/mayachain` (same version, same routers; not in the docs). No key. No published rate
limit, only "Careful querying this too much - you could overload the public nodes". No terms-of-use page found in the docs.
Measured: 150–620 ms per quote, no failure in about 60 calls.

## 2. What is served

Chain → wallet network: `BTC` bitcoin, `ETH` ethereum, `ARB` arbitrum. (Maya's other chains — `DASH`, `ZEC`, `ADA`, `THOR`
(RUNE), `MAYA` (CACAO) — have no wallet network. Mimir still carries keys for chains it does not run pools for.)

`GET /mayachain/pools`: 25 pools, 18 `Available`. In the wallet registry by chain + contract: **BTC, ETH, Arbitrum ETH,
Ethereum USDC and USDT, Arbitrum USDC** (6 assets). `ARB.USDT` and `ARB.WBTC` are Available but not in the registry;
`ETH.PEPE`, `ARB.ARB`, `ARB.DAI` are `Staged` (refused: `pool(ETH.PEPE-…) is not available`).
No DOGE, LTC, BCH, SOL, XRP, TRX, ATOM: for those pairs the adapter says "unsupported" without any network call.

Halts: `GET /mayachain/inbound_addresses` has `halted` per chain only (no trading-pause flags). Same handling as THORChain:
read with each quote, 15 s cache, fail closed. Nothing was halted on the day.

## 3. The quote — differences from THORChain

`GET /mayachain/quote/swap?from_asset&to_asset&amount&destination&liquidity_tolerance_bps=<slippageBps>&streaming_interval=3&streaming_quantity=0`

1. **Errors are HTTP 200** with `{"error": "…"}` (THORNode: HTTP 400 `{code, message}`). Handled; e.g. `amount less than
   dust threshold`, `fail to add outbound tx … not enough asset to pay for fees` → no route.
2. **Streaming must be asked for.** Maya has no advanced swap queue: without `streaming_interval` a large swap is quoted as
   a single swap. Measured for 2 BTC → ETH: about 39 ETH single (`slippage_bps` ≈ 2800) against about 71.6 ETH streamed (29 bps). The
   adapter therefore always sends `streaming_interval=3&streaming_quantity=0` (the network picks the count, minimum 5 bps of
   slip per sub-swap). For small amounts `max_streaming_quantity` is 1 and the swap is single; the memo still ends in `/3/0`.
   The interval is a free choice (3 blocks ≈ 18 s between sub-swaps); the docs give no recommendation. Streaming is reported
   in `steps[0].via[2]` and `raw.streaming`; 2 BTC → ETH: 193 sub-swaps, 58 min of streaming, 68 min in total.
3. **The limit is enforced before the outbound fee.** The quote computes `LIM = floor(expected_amount_out × (10000 − bps) /
   10000)` from the amount *net* of the outbound fee (`querier_quotes.go`), but execution compares the *gross* swap output
   with it (`swap_current.go`: `if !swapTarget.IsZero() && assetAmount.LT(swapTarget)`), and the outbound fee is deducted
   afterwards. So what the recipient is guaranteed is `LIM − outbound fee`, not `LIM`. The adapter reports
   **`minAmountOut = LIM − fees.outbound`** (both from the quote; the outbound fee is dynamic, so this floor is itself an
   estimate) and no route when that is not positive. On a 40 USD BTC → ETH quote: expected 0.01971008 ETH, limit
   0.01961152, real floor 0.01956260. A signer that wants an exact floor must write its own, higher `LIM` in the memo.
4. `expiry` = node wall clock + 15 min. `total_swap_seconds` is omitted when zero (Arbitrum → BTC): `estimatedSeconds: null`.
5. Short codes in memos: `b` = BTC.BTC, `e` = ETH.ETH, `a` = ARB.ETH; tokens as `ETH.USDC`, `ARB.USDC`.

Everything else (units, fee mapping, minimums, refusals, validation of memo recipient / asset / limit / router) is as in
`thorchain.md` §3.

## 4. Transaction shape

| Source | Shape | Memo carrier |
|---|---|---|
| BTC | vault output first, `OP_RETURN` with the memo, change back to the address of input 0. Maya's docs page lists the outputs as vault / memo / change, the quote `notes` say vault, change, then `OP_RETURN`: follow the quote `notes`. **"BTC Taproot is not supported. Funds sent to or from a Taproot address will be lost."** Segwit bech32 preferred. | `OP_RETURN`, 80 bytes |
| ETH, Arbitrum ETH | `router.depositWithExpiry(vault, 0x0000000000000000000000000000000000000000, amount, memo, expiry)` with `value = amount` (or, per the quote `notes`, a plain transfer with the memo hex-encoded in `data`) | string argument |
| ERC-20 (USDC, USDT) | `token.approve(router, amount)`, then `router.depositWithExpiry(vault, token, amount, memo, expiry)`; `expiry` = now + 60 min recommended. USDT on Ethereum needs its allowance reset to 0 before a new non-zero approval. | string argument |

Routers named by the network (`router` in `/mayachain/inbound_addresses`, identical on both hosts): Ethereum
`0xe3985E6b61b814F7Cdb188766562ba71b446B46d`, Arbitrum `0x700E97ef07219440487840Dc472E7120A7FF11F4`. Pinned by the adapter,
which rejects any other router (including THORChain's). Not yet checked against verified explorer source.

Dust thresholds on the day (1e8 units): BTC 10 000; ETH and ARB 0. An `=:e:0x…:1961152/3/0` memo is 58 bytes.

## 5. Refunds

Same rules as THORChain (`thorchain.md` §5): refund to the sender less the source-chain outbound fee; nothing back when the
amount is at or below dust, cannot pay the refund's outbound fee, is sent to a vault that is no longer active, or (BTC)
involves Taproot or a change output away from input 0. Streaming: "If the first attempt fails, the entire streaming swap is
refunded"; otherwise the swapped part is paid out and the rest of the input refunded (partial fill). `refundable: true` for
every quote returned (all are at or above `recommended_min_amount_in`).

## 6. What the isolated signer could and could not verify

Identical to `thorchain.md` §6, with two Maya specifics:

- the minimum-output check must use `LIM − outbound fee` (point 3 above), or the signer must set `LIM` itself;
- two independently hosted public nodes exist, so a two-source check of the vault is possible today — as **set membership**
  in `GET /mayachain/vaults/asgard`, not equality: the two hosts named different active vaults at the same moment
  (`0xa2b7…ed2c` and `0x7df8…4f04`; BTC `bc1qhrha…` and `bc1q0ys0…`). Two hosts are still not a trust-minimised proof.

The vault address remains unverifiable by the signer on its own; Maya's node set is also much smaller than THORChain's
(`DESIREDVALIDATORSET` 55, shallow pools), which weighs on the same risk.

## 7. Tracking

`GET /mayachain/tx/status/{hash}` (checked live), `GET /mayachain/tx/{hash}`,
`GET https://midgard.mayachain.info/v2/actions?txid={hash}`.
