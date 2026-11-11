# THORChain — execution dossier

**Status (v6, 2026-11-11): executed by the wallet for the pairs of §11** — BTC and LTC ↔ ETH / USDC / USDT / DAI / WBTC on
Ethereum, and BTC ↔ LTC, → DOGE. Every other pair stays price discovery only. Read §10 first: it states the vault-address
problem, the defence, and exactly what remains trusted. Sections 1–8 are the dossier of the quote-only phase.

Status in the quote-only phase: **price discovery only** (`executability: quote_only`, `atomic: false`). Adapter:
`packages/swap/src/providers/thorchain.ts`. Everything below was read from the live network and from the official sources on
**2026-11-10 (America/Toronto; 2026-11-11 UTC)**, THORNode `3.21.3`. Where something could not be verified it says so.

## 1. Sources

| What | URL |
|---|---|
| Endpoints (official list) | https://dev.thorchain.org/concepts/connecting-to-thorchain.html |
| Swap quote guide | https://dev.thorchain.org/swap-guide/quickstart-guide.html |
| Memo grammar | https://dev.thorchain.org/concepts/memos.html |
| How to send the inbound transaction, per chain | https://dev.thorchain.org/concepts/sending-transactions.html |
| Asset notation | https://dev.thorchain.org/concepts/asset-notation.html |
| Quote implementation (limit, expiry, minimum, memo) | https://gitlab.com/thorchain/thornode/-/blob/develop/x/thorchain/querier_quotes.go |
| Limit enforcement at execution | https://gitlab.com/thorchain/thornode/-/blob/develop/x/thorchain/swap_current.go |
| Memo serialisation / parsing | https://gitlab.com/thorchain/thornode/-/blob/develop/x/thorchain/memo/memo_swap.go |
| EVM router source | https://gitlab.com/thorchain/thornode/-/blob/develop/chain/ethereum/contracts/THORChain_Router.sol |

**Endpoint actually usable without a key: one.** The docs list `gateway.liquify.com/chain/thorchain_api` (Liquify) and
`thornode.thorchain.network`. On the day of the check `thornode.thorchain.network`, `midgard.thorchain.network` and the former
Nine Realms hosts (`thornode.ninerealms.com`, `midgard.ninerealms.com`) **did not resolve** (no A record, checked against
1.1.1.1 and 8.8.8.8); `api.thorchain.org` answers `401 API key required`; `thornode.thorswap.net` sits behind a browser
challenge. The adapter therefore pins `https://gateway.liquify.com/chain/thorchain_api/thorchain`. Consequence for the next
phase: a "several independent THORNodes must agree" check **cannot be built from keyless public endpoints today** (§6).

The Liquify gateway load-balances over nodes that are not always in the same state. Observed during this work: latencies from
0.15 s to 20 s, timeouts, and one node answering `refusing quote on node with stale state` for minutes while the others
advanced; block heights seen in the `grpc-metadata-x-cosmos-block-height` header differed by up to 15 blocks between two
consecutive calls. Rate limit: **50 000 requests / day / IP** (docs, and `x-ratelimit-limit-day: 50000` in the answers); the
docs ask for an `x-client-id` header (the adapter sends `sp-wallet`) and for exponential backoff on 429/503. No key, no sign-up.
No terms-of-use document for the gateway is referenced by the THORChain docs; none was reviewed.

## 2. What is served

Chain → wallet network: `BTC` bitcoin, `ETH` ethereum, `LTC` litecoin, `DOGE` dogecoin, `BCH` bitcoincash, `AVAX` avalanche,
`BSC` bsc, `BASE` base, `GAIA` cosmos, `XRP` xrpl, `TRON` tron, `SOL` solana. (`ZEC` and the native `THOR.*` assets have no
wallet network.)

`GET /thorchain/pools` returned 44 pools, 36 `Available`. A pool is served only if it is `Available` **and** its asset is in
the wallet registry, matched by chain + contract address (never by ticker). That leaves 21 assets:

- gas assets: BTC, ETH, LTC, DOGE, BCH, AVAX, BNB (BSC), ETH (Base), ATOM, XRP, TRX, SOL;
- Ethereum: USDC `0xA0b8…eB48`, USDT `0xdAC1…1ec7`, DAI `0x6B17…1d0F`, WBTC `0x2260…C599`, AAVE `0x7Fc6…DaE9`;
- Avalanche: USDC `0xB97E…8a6E`, USDT `0x9702…A8c7`; Base: USDC `0x8335…2913`; TRON: USDT `TR7N…Lj6t`.

Not served although the wallet has the token: `ETH.LINK` (pool is `Staged`, the node answers `pool(ETH.LINK-…) is not
available`), every Solana SPL token (only `SOL.SOL` has a pool), BSC stablecoins (the Available BSC pools are Binance-peg
USDC/USDT, which the wallet registry does not list), Arbitrum/Optimism/Polygon (no THORChain chain client).

The list is pinned in the adapter and re-checked by `scripts/smoke-swap-thorchain.mts`, which fails when a pinned pool is no
longer `Available` and warns when a new registry asset becomes available.

**Halts.** `GET /thorchain/inbound_addresses` gives, per chain, `halted` (chain halt: `HALT<CHAIN>CHAIN`, solvency halts),
`chain_trading_paused` (`HALT<CHAIN>TRADING`) and `global_trading_paused` (`HALTTRADING`); THORNode derives them from mimir.
The adapter reads that endpoint together with every quote (flags cached 15 s) and returns no route when the source or the
destination chain is halted or paused; if the flags cannot be read it fails closed. This is not theoretical: during the smoke
runs `HALTBTCTRADING`, `HALTSIGNINGBTC` and `HALTXRPTRADING` were set and cleared within minutes, and XRP stayed halted.
`GET /thorchain/mimir` is printed by the smoke script for the record.

## 3. The quote, and how each `SwapQuote` field is filled

`GET /thorchain/quote/swap?from_asset=BTC.BTC&to_asset=ETH.ETH&amount=55000&destination=<recipient>&liquidity_tolerance_bps=<slippageBps>`

No affiliate, no refund-address override, no streaming parameter (see below).

- **Units.** Every amount is an integer in 1e-8 units, whatever the asset. In: `floor(base / 10^(d−8))` for d ≥ 8,
  `base × 10^(8−d)` for d < 8. Out: the reverse, floored. An 18-decimal input loses what is below 1e-8 of a coin (at most
  9 999 999 999 wei): the protocol does not credit it. Pure `BigInt`; property-tested.
- **`amountOut`** = `expected_amount_out`: already net of the liquidity fee and of the outbound fee.
- **`minAmountOut`** = the memo limit. With `liquidity_tolerance_bps` THORNode writes
  `LIM = floor(expected_amount_out × (10000 − bps) / 10000)` into the memo (`querier_quotes.go`). At execution the swap is
  refunded when `swap output − outbound fee < LIM` (`swap_current.go`: "deduct L1 outbound fee to ensure user receives
  their limit amount after fees"). So `LIM` is what the recipient is guaranteed, in 1e8 units, if the swap executes. The
  adapter recomputes it and rejects the quote if the memo carries anything else. Tolerance must be an integer in 1..9999 bps
  (`liquidity_tolerance_bps=0` means "no limit", so zero tolerance yields no route). The older `tolerance_bps` parameter
  ignores fees and makes small swaps fail (`emit asset … less than price limit`); it is not used.
- **`fees`** (`fees.asset` is always the output asset; `total = affiliate + outbound + liquidity`, checked):
  `liquidity` → `protocol` (slip fee kept by the pools), `outbound` → `network` (gas of the vault's outbound transaction on
  the destination chain, dynamic). Both `includedInOutput: true`, `estimated: true`. `affiliate` must be `0`. The sender's
  own source-chain network fee is **not** in the quote (only `recommended_gas_rate` / `gas_rate_units`).
- **`priceImpactBps`** = `fees.slippage_bps`. **`estimatedSeconds`** = `total_swap_seconds` (inbound confirmations +
  max(outbound delay, streaming time)); `null` when absent. `inbound_confirmation_seconds`, `outbound_delay_seconds` are in `raw`.
- **`expiresAt`** = `expiry` (block time + 15 min; observed 12–15 min ahead of the wall clock).
- **Streaming.** THORChain runs the advanced swap queue: without any streaming parameter the network decides. When it
  splits the swap the memo ends in `LIM/0/N` ("rapid streaming", N sub-swaps) and the quote is priced for that. The adapter
  reports it in `steps[0].via[2]` and `raw.streaming` (`quoted`, `interval`, `quantity`, `maxQuantity`, `seconds`). Observed:
  0.00055 BTC → single swap; 20 BTC → ETH → 368–370 sub-swaps, ~12 min of streaming, 20 min outbound delay.
  A streaming swap can be **partially filled**: sub-swaps that miss `LIM/N` are skipped and the unswapped input is refunded
  (memos.html, Maya's streaming page says the same for the fork). `minAmountOut` is the floor for a full fill.
- **Minimums.** `dust_threshold` (source chain): an inbound at or below it is ignored. `recommended_min_amount_in`:
  `max(outbound fee + dust of source, same for destination) × multiplier` — below it a refund could not pay its own outbound
  fee. THORNode still answers a quote below that minimum (recorded: 3000 sats, minimum 6117); the adapter returns no route.
- **`steps`**: one `native_swap`; `contracts` = the inbound vault (`role: vault`) and, for an EVM source, the router.

Refusals turned into "no route": `amount less than dust threshold`, `amount less than min swap amount (recommended_min_amount_in: N)`,
`pool(X) is not available`, halts/pauses, `not enough asset to pay for fees`. `refusing quote on node with stale state` is
retried once (it normally lands on another node) and then reported as `unavailable`. Anything else throws.

## 4. Transaction shape per source chain

A swap is one transfer of the source asset to the **current Asgard vault** (`inbound_address`) carrying the memo
`=:ASSET:DEST:LIM[/INTERVAL/QUANTITY]`. There is no approval step except for ERC-20 tokens.

| Source | Shape (sending-transactions.html, quote `notes`) | Memo carrier |
|---|---|---|
| BTC, LTC, DOGE, BCH | output 0 → vault, output 1 → change **back to the address of input 0**, output 2 → `OP_RETURN`. At most 10 outputs; no exotic scripts; LTC MWEB unsupported. Refunds go to the address of input 0, which must stay under the wallet's control. | `OP_RETURN`, **80 bytes**. Longer memos: first 79 bytes + `^`, the rest hex-encoded in extra dust outputs — avoid. |
| ETH, AVAX, BNB, Base ETH (gas asset) | `router.depositWithExpiry(vault, 0x0000000000000000000000000000000000000000, amount, memo, expiry)` with `value = amount`. (The quote `notes` also allow a plain transfer to the vault with the memo hex-encoded in `data`.) | string argument / calldata |
| ERC-20 | `token.approve(router, amount)` then `router.depositWithExpiry(vault, token, amount, memo, expiry)`. `expiry` = unix seconds; the docs recommend now + 60 min; a transaction mined later reverts in the router. | string argument |
| ATOM | `MsgSend` to the vault, fee in the base asset | transaction `memo` |
| XRP | `Payment` to the vault. Only `MemoData` of a single memo is read. | `Memos[0].MemoData` |
| TRX / TRC-20 USDT, SOL | transfer to the vault with a memo. **Not described on the docs pages consulted**; the quote `notes` field is empty for SOL. To be read from the chain clients' source before any implementation. | TRON `data` / Solana memo instruction (unverified) |

Routers named by the network on 2026-11-10 (`router` in `/thorchain/inbound_addresses`, and in all six active vaults of
`/thorchain/vaults/asgard`): Ethereum `0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146`, Avalanche and Base
`0x00dc6100103BC402d490aEE3F9a5560cBd91f1d4`, BSC `0xb30ec53f98ff5947ede720d32ac2da7e52a5f56b`. The docs give the router's
source but **no address list**; these addresses come from the network's own state through a single gateway. The adapter pins
them and rejects a quote naming any other router. Before the signer trusts them they must be checked against the verified
source on each block explorer (not done here).

**Memo length.** `=:e:0x…40 hex…:1950047` is 54 bytes; a streaming suffix adds about 6. Fine for `OP_RETURN`. With an
ERC-20 target the full notation (`ETH.USDC-0XA0B8…EB48`, 51 bytes) does not fit in 80 bytes next to an EVM address, which is
why THORNode writes `=:ETH.USDC:…`. That abbreviation is resolved by the node by fuzzy match on chain + ticker. If the
signer builds the memo itself it should prefer the contract-suffix form (`ETH.USDC-6EB48`, accepted by the parser and by the
adapter's check) so the target is bound to the contract and not to a ticker.

**What the wallet cannot build today** (`packages/core`, not touched): the UTXO plugins have no `OP_RETURN` output and no
control over output order; `Intent.memo` is capped at 120 chars; TRON and BCH reject a memo; the XRPL plugin maps `memo` to a
destination tag only, not to `Memos`; there is no EVM contract-call intent for `depositWithExpiry`.

## 5. Refunds, and when funds are NOT refunded

A failed swap (limit not met, pool or trading halted, unparseable memo, unknown asset) is refunded by the network in an
outbound transaction **to the sender address** (UTXO: address of input 0; a `DEST/REFUND` memo could redirect it — the adapter
rejects such memos), **less the outbound fee of the source chain**. Hence `refundable: true` on every quote the adapter
returns, which are all at or above `recommended_min_amount_in`.

Not refunded (official docs and `querier_quotes.go` comments):

- amount **at or below the dust threshold**: the inbound is not observed at all (BTC 1000, LTC/AVAX 100 000, DOGE and XRP
  100 000 000, in 1e8 units, on the day);
- amount that cannot pay the refund's outbound fee: "the refund will fail, and the user will lose the entire input amount";
- **memo longer than 250 bytes**: ignored;
- funds sent to a **vault that is no longer active** (cached address, delayed transaction);
- UTXO: wrong output order, more than 10 outputs, unsupported address or script types, change sent away from input 0;
- EVM: transaction mined after `expiry` reverts (nothing leaves the wallet, gas is spent); "Do not send to or from contract
  addresses" (quote notes) — a refund to a contract sender may be unusable;
- XRP sent from a shared/exchange address without a destination tag in the memo.

Not confirmed from the pages consulted: what happens to an ERC-20 transferred directly to the vault without the router, and
to an inbound that arrives while its chain is halted. Treat both as loss/indefinite delay until verified.

## 6. What the isolated signer could verify, and what it could not

Could verify by itself, from data it already holds:

- **Recipient**: the memo's `DEST` field equals the wallet's own address on the destination chain (the signer derives it).
- **Target asset**: the memo's `ASSET` field is a spelling of the registry asset (pinned notation table).
- **Minimum output**: the memo's `LIM`, converted from 1e8 units, is at least the minimum the user approved.
- **Nothing else rides along**: handler is `=`, exactly four fields, no `/REFUND`, no affiliate, no aggregator fields.
- **Amount** sent, and for EVM: the router is a constant compiled into the signer, the selector is `depositWithExpiry`, the
  `asset` argument is the registry contract, `amount` and `value` match, `expiry` is within a short window, the allowance is exact.

Could **not** verify: that `inbound_address` is a genuine vault. It is the address of a threshold key held by the current
node set; it changes at every churn (`CHURNINTERVAL` = 43 200 blocks, about three days), several vaults are active at once
(six on the day; consecutive quotes named three different BTC vaults), and it is only published by the network's API. The
EVM router does not help: `depositWithExpiry` forwards to whatever `vault` it is given. A node, a gateway or anyone on the
path who substitutes that single field takes the whole input, and no memo check can detect it.

Mitigations used by integrators and recommended by the docs ("never cache", "confirm the latest vault", "confirm the network
is not halted"), in increasing strength:

1. take the vault from a fresh quote, send immediately, refuse after `expiry`;
2. require the address to be in `GET /thorchain/vaults/asgard` with `status: ActiveVault`, and re-derive the address from
   the vault `pub_key` locally (binds address to key; the key itself is still API data);
3. churn checks: `vaults_migrating` in `GET /thorchain/network`, `HALTCHURNING`, never a `RetiringVault`;
4. ask several **independently operated** THORNodes and require agreement (as set membership, since nodes may name different
   active vaults) — today only one keyless public host answers, so this needs a self-hosted node or keyed providers;
5. verify the vault set with a Tendermint light client against THORChain's validator set (the only trust-minimised option;
   substantial work).

Until at least 2–4 exist in a form the signer can check without trusting the API service, `quote_only` is the honest class.

## 7. Tracking

- `GET /thorchain/tx/status/{inbound tx hash}` — stages `inbound_observed`, `inbound_confirmation_counted`,
  `inbound_finalised`, `swap_status` (with streaming progress), `outbound_delay`, `outbound_signed` (endpoint checked live).
- `GET /thorchain/tx/{hash}` for the observed transaction and its outbound hashes; Midgard
  `GET https://gateway.liquify.com/chain/thorchain_midgard/v2/actions?txid={hash}` for the final swap or refund action
  (Midgard reported `inSync: false` and took 11 s at one point during the checks).

## 8. Measured (2026-11-11 01:05–01:45 UTC)

Fixtures were recorded with `packages/swap/test/fixtures/record.mjs`. Through the adapter (`scripts/smoke-swap-thorchain.mts`,
quote + halt flags per call): 7 quotes, **2.1 s min, 3.4 s median, 5.2 s max**, after up to four `stale state` refusals on
some pairs; one pair (SOL → USDC on Avalanche) could not be quoted in eight attempts in that run and had been quoted in an
earlier one (3.1 s). During that window the chain's block time ran about three minutes behind the wall clock, which is when
nodes refuse quotes. Earlier the same evening single calls took 0.15–0.7 s, with outliers at 12–20 s. Against CoinGecko the
40 USD quotes came out 0.8–2.4 % below the reference (the outbound fee alone is about 0.75 USD on BTC and 0.25 USD on
Ethereum); 20 BTC → ETH streamed came out 0.8–1.3 % below.

The router's default provider deadline is 2.5 s: with this gateway THORChain will often be reported as `timeout`. Either give
this provider a longer deadline or run a THORNode.

---

# Execution (v6, 2026-11-11)

Sections 1–8 above describe the quote-only phase and are kept as written, except where §9 corrects them. Code:
`packages/core/src/thorchain.ts` (tables, memo, vault check, builders), `services/isolated-signer/src/vaults.ts` (the signer's
own operators), `services/api/src/xswap.ts` + `xswap-state.ts` (preparation, relay, tracking), `apps/web/src/xswap.tsx`.
Proof: `npx tsx scripts/sim-thorchain.mts` (nothing is broadcast).

## 9. Sources read for execution, and a correction to §1

| What | URL (read 2026-11-11) |
|---|---|
| Public endpoints | https://dev.thorchain.org/concepts/connecting-to-thorchain.html |
| Memo grammar, limits (250 bytes; 80 in `OP_RETURN`), refunds | https://dev.thorchain.org/concepts/memos.html |
| Inbound transaction rules per chain | https://dev.thorchain.org/concepts/sending-transactions.html |
| Inbound addresses, halts, "never cache", phishing warning | https://dev.thorchain.org/concepts/querying-thorchain.html |
| Vault statuses, churn, migration, how the inbound vault is chosen | https://dev.thorchain.org/bifrost/vault-behaviors.html |
| Operators listed for THORChain | https://raw.githubusercontent.com/cosmos/chain-registry/master/thorchain/chain.json |
| Router v4.1 verified source (Ethereum) | https://etherscan.io/address/0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146#code |

**Correction to §1 ("one usable endpoint").** That was true of the hosts tried on 2026-11-10. On 2026-11-11 five keyless
public THORNode APIs answered `inbound_addresses`, `vaults/asgard`, `lastblock`, `pools`, `quote/swap` and `tx/status`:

| id | base | where it is published |
|---|---|---|
| `liquify` | `https://gateway.liquify.com/chain/thorchain_api` | THORChain developer docs; Cosmos chain registry |
| `rorcual` | `https://api-thorchain.rorcual.xyz` | Cosmos chain registry |
| `ibs` | `https://thorchain.ibs.team/api` | Cosmos chain registry |
| `thorwallet` | `https://thornode.thorwallet.org` | THORWallet's public node (found by probing; not in the docs) |
| `keplr` | `https://lcd-thorchain.keplr.app` | Keplr's public node (found by probing; not in the docs) |

Still unusable: `thornode.thorchain.network`, `*.ninerealms.com` (no DNS), `thornode.thorswap.net` (browser challenge),
`api.thorchain.org` (key). The official page itself says of public endpoints: *"you can be phished and could send money to
the WRONG vault"* and suggests comparing nodes or running a full node — which is what §10 does.
Observed behaviour: the five return identical vault sets; heights within ~25 blocks of each other; latency 0.1–6 s; a
quote is often refused by two or three of them at a time (`refusing quote on node with stale state`, or a timeout) while
the vault endpoints keep answering.

## 10. The vault-address problem and the defence

**The problem.** A swap is a payment to the current Asgard vault with a memo. The memo is fully checkable. The vault is
not: it is the address of a threshold key held by the node set, there are several at once (six on the day), the network
picks one per request, they all change at each churn, and only the network's nodes can say which keys are vaults. The
Ethereum router does not help: `depositWithExpiry(vault, …)` forwards to whatever `vault` it is given. Whoever substitutes
that one field takes the whole input.

**What the signer proves alone, offline** (`verifyXswap`, `buildXswapBtcTx`, `buildXswapEvmTxs`):

- the memo is `=:ASSET:DEST:LIMIT`, rebuilt by the signer and required to equal the committed one: `ASSET` is the pinned
  spelling of a registry asset, `DEST` is the wallet's own address on the destination network (derived from its keys),
  `LIMIT` is a plain decimal integer in 1e8 units worth at least the approved minimum (`fromThorAmount(limit) ≥ minOut`);
  scientific notation, streaming fields, a `/REFUND` override and affiliate fields cannot be produced and are refused by
  the parser. A refund therefore returns to the sender, which is the wallet (UTXO: address of input 0; EVM: `msg.sender`);
- the transaction: UTXO = all inputs the wallet's own, output 0 the vault, output 1 change to the wallet (always present),
  output 2 `OP_RETURN` with one push of the memo (≤ 80 bytes), nothing else, fee ≤ the approved maximum;
  Ethereum = one call to the pinned router `depositWithExpiry(vault, asset | 0x0, amount, memo, expiry)` with
  `value = amount` for ETH, preceded for a token by `approve(router, amount)` for the exact amount;
- the vault **address is the address of the committed vault public key** (bech32 `thorpub…` → secp256k1 key → P2WPKH /
  P2PKH / keccak address, computed locally). An API that keeps a genuine key and swaps the address is refused offline.

**What cannot be proven offline, and the check that replaces a proof** (`checkThorVault`): that the key is a current
Asgard vault. Before signing, **the signer itself** asks the five operators above — its own list, compiled into
`dist/signer.mjs`, over TLS, nothing passing through the API — for `inbound_addresses`, `vaults/asgard` and `lastblock`,
and signs only if:

- at least **3** distinct operators answered (two may be down), and
- **every** operator that answered: lists the key as `ActiveVault` serving the source chain, with the same churn height
  (`status_since`); reports the source chain neither `halted` nor trading-paused; names the pinned router (EVM); reports a
  dust threshold below the amount; and is within 50 THORChain blocks (5 min) of the others.

One dissenting answer refuses the signature (an honest operator that disagrees is the very signal). Nothing is cached.
A refusal happens before the passkey is looked at and records nothing as spent. The API runs the same function for its
own view when it prepares the swap and again just before it relays the signed transaction.

Why 3 of 5 with zero dissent: unanimity means an attacker gains nothing from one, two, three or four lying operators as
long as one honest operator answers; the floor of 3 means silencing operators (which an attacker on the network path, or
a simple outage, can do) is not enough either — at least three must actively vouch for the forged key. Requiring all five
would make the swap unavailable whenever one public node is down, which was the case in most runs.

**Exactly what remains trusted**

1. That the operators which answered (≥ 3 of the 5 pinned) are not all compromised or colluding **at the same time**, and
   are in fact independent. Independence is assumed from their publishers, not proven: two of them could sit behind the
   same infrastructure. `thorwallet` and `keplr` are public nodes of wallets, not endpoints documented by THORChain.
2. TLS and the WebPKI for those five host names, from the signer's machine.
3. THORChain itself: that the vault's key holders (two-thirds honest, bonded) process the memo, pay the outbound and
   refund as documented. This is inherent to using THORChain and no client check can remove it.
4. The pinned tables in `thorchain.ts` (asset spellings, router address and bytecode hash, operator list).

No longer trusted: the wallet API (it can only make a swap fail), any single THORNode operator, the quote endpoint.

**Second lines (corroboration, not proof)** — each is fakeable by someone who parks capital, and is stated as such:

- API, at preparation: the wallet's own chain data sources must show the vault address holding ≥ 100 × the amount in the
  source asset (BTC/LTC balance from the wallet's indexers; ETH balance on both RPCs; for a token,
  `router.vaultAllowance(vault, token)` on both RPCs). Real vaults held ~70 BTC / 110–230 ETH / 150–500 k USDC each.
- API: recent `TransferOut` events of the router with that vault as sender are counted (informational only).
- API: the router bytecode must hash to the pinned value on both RPCs; the wallet address must carry no code.
- API: every operator's quote must contain, **byte for byte**, the memo this wallet builds for that quote's numbers; the
  pool behind the memo spelling must be the pinned one, `Available`, and the only pool with that chain and ticker.

**Exposure.** One swap is bounded by the signer's per-transfer limit of the source asset (about 50 USD) and its daily
limit (about 100 USD); the limits are those of a send and were not changed. This bounds the loss; it is not the defence.

Midgard is not part of the check: the only public Midgard that answered (Liquify) does not proxy
`thorchain/inbound_addresses` and reported `inSync: false`.

## 11. What is enabled, what is not, and why

| Direction | Enabled |
|---|---|
| BTC (native SegWit) → ETH, USDC, USDT, DAI, WBTC on Ethereum; → LTC; → DOGE | yes |
| LTC (native SegWit) → the same Ethereum assets; → BTC; → DOGE | yes |
| ETH, USDC, USDT, DAI, WBTC on Ethereum → BTC, LTC, DOGE | yes |
| DOGE as source | **no** — THORChain's recommended inbound rate (750 000 koinu/byte) is far above the wallet's Dogecoin fee ceiling, which is not raised |
| BCH (either side) | **no** — Bitcoin Cash is a separate plugin builder with no memo output; CashAddr spelling in memos not verified |
| Base, Avalanche, BSC (either side) | **no** — they run other router builds (7 521 and 4 782 bytes of runtime code against 5 141 on Ethereum) whose sources were not read; outbound tracking relies on the router's `TransferOut` event |
| Cosmos, XRP, TRON, Solana | **no** — inbound transaction shapes not verified (§4) and no outbound verification written |
| Same-network swaps through THORChain | **no** (KyberSwap does those) |
| Streaming swaps | **off** — no streaming field is ever written; an amount THORChain would split (`max_streaming_quantity > 1`) is refused |
| Maya Protocol | **no** — see `maya.md` §8 (two operators only) |

Rules applied to every swap:

- **Minimums.** Refused at or below the source chain's dust threshold (signer and API) and below
  `recommended_min_amount_in` (API, highest value of the quoting operators): below it a refund cannot pay its own fee and
  the input is lost. The outbound fee is shown and is already deducted from the expected output and from the minimum.
- **Price.** Quotes from at least two operators, within 1 % of each other; the lowest is kept.
- **Fee rate.** UTXO: the higher of the wallet's own estimate and THORChain's `gas_rate`, never above the wallet's own
  rate cap nor the signer's fee ceiling (otherwise refused). Ethereum: `max(2 × base fee + tip, gas_rate gwei)`.
- **Validity.** Passkey window 120 s. `expiry` = creation + 15 min: on Ethereum the router reverts after it (gas only is
  lost); a UTXO transaction is never relayed, nor relayed again, in the last 3 minutes before it. Just before relaying,
  the API re-runs the vault check and refuses if the vault is no longer active or its churn height changed.
- **No replacement.** The signer signs one transaction per proposal, ever; there is no fee bump.
- **One at a time** per source network, until the outcome (received or refunded) is known.
- **Tracking.** `tx/status` from the operators (two identical answers needed) says where to look. A swap is `received`
  only when the wallet's own chain data sources show the named outbound transaction confirmed, paying the wallet the
  expected asset, with THORChain's memo `OUT:<inbound txid>` (UTXO: transaction bytes hashed locally; Ethereum: the
  pinned router's `TransferOut` event on every RPC). `REFUND:<inbound txid>` gives `refunded`, never `received`.
  Overdue steps raise a hold (`not_observed`, `outbound_late`, `outbound_not_seen`, `outbound_mismatch`, `vault_churned`)
  and tracking continues; it never gives up and never guesses. All state is in the proposal row: it resumes after a restart.
- **Audit.** `xswap.prepared`, `transfer.*`, `xswap.observed`, `xswap.outbound`, `xswap.received` / `xswap.refunded`,
  `xswap.hold` (API chain); `xswap.vault_confirmed` (operators, height, churn height) and `sign.ok` / `sign.denied` (signer journal).

Signer outbound hosts added (an egress allowlist on the signer machine must include them): `gateway.liquify.com`,
`api-thorchain.rorcual.xyz`, `thorchain.ibs.team`, `thornode.thorwallet.org`, `lcd-thorchain.keplr.app`. Three GETs per
operator per signature, 7 s timeout, 400 kB cap, redirects refused.

## 12. Verified / not verified

Verified (2026-11-11, `scripts/sim-thorchain.mts` and tests):

- vault addresses derived locally equal the addresses the five operators publish (BTC, LTC, DOGE, ETH);
- the unanimity rule on live answers, and on the same answers with one lying, stale, halting or retiring operator;
- for 7 pairs, each operator's quote memo equals the wallet's memo byte for byte;
- a Bitcoin transaction signed by the real signer (fresh key, made-up coin), decoded with bitcoinjs-lib: three outputs in
  order, `OP_RETURN` bytes, fee at THORChain's rate — not broadcast;
- on an anvil fork of Ethereum, the signer's calls mined against the real router: `Deposit(vault, 0x0 | USDC, amount, memo)`,
  vault ETH balance / `vaultAllowance` up by exactly the amount, exact approval consumed, `THORChain_Router: expired` after expiry;
- router v4.1 source read in full; bytecode hash identical on both registry RPCs.

**Not verified**

- Any transaction on a real network: no swap, outbound or refund has been executed by this wallet. THORChain cannot be forked.
- That THORChain observes a UTXO inbound whose `OP_RETURN` is output 2 with change as output 1 exactly as built here
  (it is the documented shape; not exercised).
- What happens to an inbound confirmed after its vault retired: the docs only say funds may go "to an unreachable
  address"; Bifrost watching retiring vaults is believed, not read in the source.
- The outbound verification code against a real THORChain outbound (written from the router source and the documented
  `OUT:`/`REFUND:` memos; tested on scripted data only). Whether a UTXO outbound always carries the memo in a single-push
  `OP_RETURN` was not checked on-chain; if it does not, the swap stays on hold `outbound_mismatch` (never a false success).
- USDT, DAI and WBTC as sources on a fork (ETH and USDC were); Litecoin source signing end to end (same builder as Bitcoin, unit-tested only).
- That `refund` on Ethereum returns to `msg.sender` (stated by the docs as "the originator's address"; not read in Bifrost).
- Independence of the five operators; the terms of use of the THORWallet and Keplr public nodes.
- `tx/status` field shapes for a streaming or multi-outbound swap (not produced by this wallet).

## 13. Residual risks, plainly

1. All answering operators compromised at once (or one actor behind ≥ 3 of them): loss of one swap amount, per-transfer limit.
2. A churn between signature and confirmation of a UTXO inbound: bounded by the 15-minute window, THORChain's fee rate
   and the no-late-relay rule, not eliminated (a transaction can stay unconfirmed longer than expected and cannot be recalled).
3. THORChain insolvency, halt after the deposit, or a bug: funds can be delayed or lost; nothing here can prevent it.
4. A token memo `ETH.USDC` designates the deepest pool with that ticker: if a deeper impostor pool were ever listed the
   output would be that token, to the wallet's own address. The API refuses as soon as a second pool with the ticker exists.
5. Public nodes are flaky: a swap will often fail to prepare or sign ("only 2 operators answered", "fewer than two
   quotes") and must simply be retried. Failing closed is intended.
