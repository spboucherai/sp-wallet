# SP Wallet — the first NFT market WRITE: decision document (2026-11-17)

**Nothing in this document is built.** Delivery 3 reads market data and builds no order, no approval and no cancellation.
The brief allows a market write only when three things exist for that market's order format: the transaction is **decoded**
into a deterministic summary, the **signer rebuilds and verifies** it from approved semantic fields, and it is **simulated**.
None of the three exists for any marketplace. Each needs a change of the isolated signer, hence the owner's decision and a
human security review. This document compares the candidates from official sources and specifies the recommended one so
that the decision can be taken.

Tags: **[src]** read in an official page or repository file on 2026-11-17 · **[live]** read from mainnet or a live API that
day · **[inferred]** a conclusion of this document from the two · **NE** not established.

## 1. What the signer can sign today, and what a market write would add

The signer has no "sign these bytes", no "sign this message", no EIP-712 typed-data facility. It holds purpose-built
builders: an approved canonical intent (strict schema, own domain separator, single use, expiry) is turned into a
transaction **by the signer**, then re-read by an independent verifier (`packages/core/src/nft-evm.ts`, `nft-sol.ts`).
A market write must fit that shape or it does not happen: semantic fields in, a transaction the signer builds itself out.

A candidate is therefore judged first on one question: **can the exact transaction be rebuilt by the signer from
{asset, price, currency, expiry, marketplace program} with no bytes supplied by a server?**

## 2. The reference item and its collection [live]

`CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j` is a Metaplex Core asset (182 bytes, no asset-level plugin: no
FreezeDelegate, no TransferDelegate — it is not listed through a delegate today). Its collection
`phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC` carries **PermanentFreezeDelegate (frozen = false),
PermanentTransferDelegate and PermanentBurnDelegate**, authority = the collection's update authority; no Royalties plugin.

- Magic Eden reports the item unlisted. OpenSea reports it not listed, no offer, and a sale of 14 500 USDC on
  2026-11-10 (`NFT-SOURCES.md` §10.1).
- OpenSea's listings of this collection are orders of protocols it names `tensor` (program
  `TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp`) and `os_tensor` (program `7Aru291A64wrTkUDaRv6HqxVBre6ivXWL94cUoCtQF9V`),
  priced in USDC. So this collection **does trade through the Tensor marketplace program** today. What `os_tensor` is
  (an OpenSea-operated deployment or fork) is **NE**.
- A listed item of the same collection on Magic Eden (`9c6YJf…MwHAL`) has, on-chain, owner
  `1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix` — the PDA of seeds `["m2","signer"]` under Magic Eden's M2 program — while
  Magic Eden names another address as seller: **a Magic Eden Core listing is custodial in a program PDA**, not
  delegate-and-freeze in place.

What Metaplex documents about Core listings [src: developers.metaplex.com/core, plugin pages]:
- the escrowless pattern exists — "Marketplace listings | Freeze Delegate + Transfer Delegate": the seller adds a Transfer
  Delegate with the marketplace as authority; "Authority is revoked so seller can't double-list"; "On Transfer, delegated
  Authorities of owner managed plugins are automatically revoked back to the `Owner Authority` type";
- permanent plugins **force-approve**: Permanent Transfer Delegate "can transfer even when frozen", and at collection level
  "Allows transferring of any Asset in the collection using the collection authority".

**Consequence for this collection [inferred]:** whatever the marketplace, the collection's authority can move, burn or
freeze the asset — listed or not, in the wallet or in an escrow. A collection-wide freeze would block a delist and a
purchase. This is a fact of the collection, shown today as a transfer warning (`core_collection_permanent_delegate`); a
listing screen must repeat it.

## 3. The candidates

| | A. Tensor `listCore` (Solana) | B. Magic Eden instructions API (Solana) | C. Seaport listing through OpenSea (EVM) |
|---|---|---|---|
| What is signed | one Solana transaction, one marketplace instruction | a transaction **built by Magic Eden's server** (`tx`, `v0.tx`, possibly pre-signed `txSigned`) | EIP-712 typed data `OrderComponents` — or an on-chain `validate` transaction — **plus** a `setApprovalForAll` transaction |
| Rebuildable by the signer from semantic fields | **yes**: open source, published IDL, accounts and arguments known | **no**: opaque server bytes; no official M2 source or IDL was found | the order struct yes; but the signer has no typed-data facility, and OpenSea's POST marks `signature` required |
| Server that must be trusted or co-sign | none on-chain (`cosigner` is an optional account). An indexer only to *see* the listing | Magic Eden's API **and a key** (`Authorization: Bearer`; instruction endpoints answer 401 without it) | OpenSea's API and key to publish; the collection's `requiredZone` (SignedZone) co-signs fulfilment when set |
| Approval left standing | **none** | none on the asset (it is escrowed) | **collection-wide** operator approval of the conduit `0x1E0049783F008A0085193E00003D00cd54003c71` until revoked |
| Where the asset sits while listed | in the `list_state` PDA (`["list_state", asset]`): **escrowed** — `list.rs` transfers it with `TransferV1` to the list state | in the M2 PDA: escrowed [live] | in the owner's wallet |
| Exit | `delistCore` (owner signs; the PDA transfers the asset back, the list state is closed); `closeExpiredListingCore` is permissionless after expiry and returns the asset to the owner | `sell_cancel` (server-built again) | on-chain `cancel(OrderComponents[])` or `incrementCounter()`; off-chain cancel leaves a window "up to 5 minutes" for SignedZone orders |
| Fees | taker 2 % (`TAKER_FEE_BPS = 200`); the seller "receives the full listing amount"; royalties enforced from the Royalties plugin of the asset, else of the collection, else 0 — **0 for this collection** | NE | OpenSea fee 1 % in the consideration (recipient `0x0000a26b…a719`), plus the collection's `required` fees |
| Expiry | `expireInSec`, at most 365 days (`MAX_EXPIRY_SEC`); none given = 365 days | `expiry` (−1 by default) | `endTime` of the order |
| Code assurance | Apache-2.0 source `tensor-foundation/marketplace` 0.7.1, IDL published; a code-review competition is announced; **`verify.osec.io` reports `is_verified: false`; the program is upgradeable** | no source; not verified; upgradeable | Seaport 1.6: audited, canonical address on the 8 EVM networks, not upgradeable |
| Covers the owner's reference item | **yes** (the collection's live listings are Tensor-program orders) | yes | no (EVM only) |

Sources: Tensor — `github.com/tensor-foundation/marketplace` (`program/src/lib.rs` `declare_id!`, `program/idl.json`
instructions `listCore`, `delistCore`, `buyCore`, `buyCoreSpl`, `closeExpiredListingCore`, `takeBidCore`;
`instructions/mpl_core/list.rs`), `tensor-foundation/toolbox` `common.rs` (fees), dev.tensor.trade (fee structure). Magic
Eden — docs.magiceden.io/reference/solana-api-keys ("Endpoints that generate instructions are currently guarded by an API
key"), the official SDK `github.com/magiceden/magiceden-sdk` (endpoints, parameters, response shape); its per-endpoint
pages answered 403. Seaport — `ProjectOpenSea/seaport-js` and `opensea-js` constants, `seaport-types`
`ConsiderationInterface.sol` ("anyone can validate a signed order, but only the offerer can validate an order without
supplying a signature"), docs.opensea.io (`post_listing`, `listings/fulfillment_data`, fees). OpenSea on Solana —
support.opensea.io article 16779826 and the API reference: "A Solana listing … settles through an onchain program rather
than a signed order"; the API answers server-composed `steps`.

**Not candidates:** *buying* (any market) and *accepting an offer* — both pay or deliver against a counterparty's order
whose state the wallet must read and verify; they come after a first listing integration, not before. *OpenSea's Solana
write API* — server-composed steps, the same objection as B.

## 4. Recommendation: A — list and delist a Core asset on the Tensor marketplace program

Only A can be rebuilt by the signer without trusting bytes from a server, leaves no standing approval, has an exit that
needs no third party (even a permissionless one after expiry), and covers the owner's reference collection. B fails the
first criterion and cannot be made to pass it. C is the cleanest protocol but needs two new signer capabilities at once
(typed data or `validate`, and an operator approval) and does not concern the reference item; it is the natural **second**
integration.

The scope proposed is deliberately the smallest that is useful and reversible: **list** and **delist** of a Metaplex Core
asset, priced in SOL or USDC, on mainnet. No bid, no purchase, no acceptance, no other standard.

### 4.1 Order format — the two instructions [src: IDL 0.7.1]

`listCore` (Anchor discriminator `ad4ca77d76470199`, to be re-computed and pinned from the IDL at build time):

| # | Account | Signer / writable | Source in the signer |
|---|---|---|---|
| 1 | asset | writable | intent |
| 2 | collection (optional) | — | intent (and it must be the asset's collection — checked by the API on-chain, and by the program) |
| 3 | listState | writable | **derived**: PDA `["list_state", asset]` under the Tensor program |
| 4 | owner | signer | the wallet's own address |
| 5 | mplCoreProgram | — | pinned `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` |
| 6 | marketplaceProgram | — | pinned `TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp` |
| 7 | systemProgram | — | pinned |
| 8 | payer | signer, writable | the wallet's own address |
| 9 | cosigner (optional) | — | **always absent** |

Arguments: `amount: u64` (intent price, base units) · `expireInSec: Option<u64>` (**always Some**, from the intent) ·
`currency: Option<Pubkey>` (None = SOL; Some(mint) only from the currency allow-list) · `privateTaker: Option<Pubkey>`
(**always None**) · `makerBroker: Option<Pubkey>` (**always None**).

`delistCore`: asset, collection, owner (signer), listState (derived), the three programs, rent destination = the wallet.
No argument that carries value.

The transaction, as for NFT transfers: a legacy message, the wallet as only signer, compute-budget instructions with the
policy's ceilings, **exactly one** marketplace instruction, nothing else.

### 4.2 What would be signed

A **transaction**, never a message or typed data. The passkey approves the hash of a new canonical intent; the signer
builds the message from it.

### 4.3 Approvals

**None.** No delegate, no plugin, no operator approval is created: the asset is transferred into the list state. There
is nothing to revoke — and conversely nothing keeps the asset in the wallet: see 4.7.

### 4.4 What the signer would decode and rebuild

New files beside `nft-sol.ts`: a builder `buildNftListSolMessage(intent)` and an independent verifier
`verifyNftListSolMessage(message, intent)` that re-reads the compiled message and checks: one signer (the wallet); the
instruction list is exactly [compute limit, compute price, marketplace instruction]; program id = the pinned one; the
discriminator; the 8 or 9 account keys in order with the expected signer / writable flags; `listState` equals the PDA it
derives itself; the arguments decode back to the intent's price, expiry and currency with `privateTaker`, `makerBroker`
and `cosigner` absent. Anything else — an extra instruction, another account, a non-absent optional — is a refusal.

As today, **the signer does not read the chain**: that the asset is held, in that collection, not frozen, is established
by the API on two endpoints and by the simulation (4.6). What the signer bounds is what a compromised API could obtain
(4.9).

### 4.5 New intent kinds and policy limits

Two new intents with their own domain separators — never a reuse of the transfer intent:

- `nft-market-list` v1: proposalId, keyId, network, chainRef, market = `tensor-core`, program, asset, collection | null,
  from, price (base units), currency (`native` | mint), expiresInSec, maxFee, createdAt, expiresAt, policyVersion,
  nftPolicyVersion, sol {recentBlockhash, lastValidBlockHeight, computeUnitLimit, computeUnitPrice};
- `nft-market-delist` v1: the same without price, currency and expiresInSec.

New optional `nft.market` policy section (strict; absent = **every market write refused**, which is also the default):

| Key | Meaning | Conservative initial value |
|---|---|---|
| `enabled` | master switch | `false` |
| `markets` | allow-list of {market, program} | `[]`, then `tensor-core` only |
| `currencies` | allow-list of `native` and mints | `native`, USDC `EPjFWdd5…Dt1v` |
| `minPrice` per currency | **price floor**: a listing below it is refused (the main protection against a mis-typed or maliciously low price) | set by the owner per currency; no default — a listing is refused until it exists |
| `maxPrice` per currency | price ceiling (a sanity bound) | set by the owner |
| `minListSeconds` / `maxListSeconds` | expiry bounds | 1 hour / 30 days |
| `maxListingsPerDay`, `maxOpenListings` | counters of their own, apart from `maxTransfersPerDay` | 2 / 5 |
| `maxTakerFeeBps`, `maxRoyaltyBps` | recorded for the day purchases exist; for a listing the seller pays neither — the review still shows the program's 2 % taker fee and the collection's royalty | 250 / 1000 |
| `allowDelistUnderHalt` | a delist only brings the asset back | `true` |

Halt blocks `list`; `delist` passes under halt (it removes exposure), like cancels do for derivatives.

### 4.6 Simulation

`simulateTransaction` of the exact message on the wallet's endpoints, with the asset account and the list-state account
watched. Accepted only if, after it: the asset's owner **is the list-state PDA** the signer derived; the asset carries no
new plugin authority; the list-state account exists, is owned by the Tensor program, and decodes (layout from the IDL) to
this owner, this asset, this amount, this currency, this expiry, no private taker, no broker; the wallet's lamports
changed by the fee and the rent of the list state only. For a delist: the owner is the wallet again and the list state is
closed. Any other outcome is `simulation_unexpected` and nothing is proposed.

### 4.7 Ownership state shown during a listing

The chain will name **the list-state PDA as owner**: without care the wallet would show the asset as "left the wallet".
Required: a new ownership state `listed_in_escrow` (the model's reserved `escrow` state and block reason) established
**on-chain** — the asset's owner equals `PDA(["list_state", asset])` under the pinned program and that account's `owner`
field is this wallet — never from a marketplace's API; the item stays in the inventory under "En vente — en séquestre
chez le programme Tensor", with the list-state address, the price, the expiry and the two exits (delist; after expiry,
anyone's `closeExpiredListingCore`). Send is blocked with `escrow`. The inventory's "an asset no longer returned has left"
rule needs this exception, with its test.

### 4.8 Failure modes

| Failure | What happens | Mitigation |
|---|---|---|
| The program is **upgradeable** and not verified against its source | its behaviour can change after the integration was reviewed; the asset sits in its PDA | pin a hash of the program data account in the API (not the signer: it cannot read the chain) and refuse to prepare when it changes; small `maxOpenListings`; state it on the screen |
| A listing is bought | the asset is gone and the proceeds arrive: correct, but must be told apart from a theft | detect the list-state closure with the payment in the same transaction; show as a sale only then |
| The listing expires | the asset stays in the PDA until someone closes it | show "expirée — à récupérer", offer the delist |
| The collection authority moves, burns or freezes the asset | permanent delegates force-approve: a listing does not protect against it; a collection freeze would block the delist | warning on the review; not preventable |
| The indexers never show the listing | nobody buys | the listing is real on-chain regardless; the wallet reads the list state itself |
| Price typed in the wrong unit or currency | a sale far below value, irreversible | the signer's `minPrice`; the review shows the price in base units and decimals with the currency's mint; a confirmation of the figure |
| Rent | the list state costs rent, returned at delist | shown as rent, not as a fee |
| Layout or discriminator changes with a program upgrade | the builder's instruction fails or — worse — means something else | pinned program-data hash; the verifier decodes arguments back; simulation checks the resulting state |

### 4.9 What a compromised API could and could not do

*Could* (within the policy): obtain a passkey approval for a listing of **another** asset of the wallet or at **another
price** than the owner believes, if the web bundle is compromised too — the review is rendered by the web app (the
residual risk already recorded for transfers). The damage is bounded by `minPrice` (it cannot list at a give-away price),
`maxListingsPerDay`, `maxOpenListings`, the currency allow-list, and by the fact that a listing can be delisted.
It could also refuse to prepare a delist — the owner then delists with any other tool that can sign for the wallet, or
waits for the expiry, after which anyone can return the asset.

*Could not*: change the program, add an instruction, name a private taker (which would reserve the sale for an
accomplice), name a broker or a cosigner, redirect the proceeds (the program pays the list state's owner), set a currency
outside the allow-list, list below the floor, list for longer than the bound, or turn a listing into a transfer or an
approval — the signer builds none of those.

### 4.10 Tests required

1. Core: canonical bytes and hashes of the two intents on fixed vectors; the existing 10 intent vectors and the transfer
   vectors unchanged.
2. Builder ↔ verifier on every refusal: wrong program, wrong discriminator, extra instruction, extra account, a present
   `privateTaker` / `makerBroker` / `cosigner`, a wrong list-state PDA, price or expiry outside the policy, currency not
   allowed, halt, replay, expiry of the intent, policy version mismatch; cross-check of the instruction bytes against the
   official SDK (`@tensor-foundation/marketplace`) used as a test-only dependency.
3. Local validator with the **real Tensor and Core programs cloned from mainnet** (as `scripts/validator-nft-solana.mts`
   does): list → the asset is in the PDA, the list state decodes to the intent; delist → back; list → buy from a second
   key → proceeds = the full amount; expiry → permissionless close; a frozen collection → the refusal. Fee and rent
   announced = lamports spent.
4. A mainnet `simulateTransaction` of the list message with the real holder as `from` (no signature), recorded.
5. API: the on-chain `listed_in_escrow` state, the inventory exception, the sale detection, the program-data hash guard.
6. Web and Playwright: review screen from on-chain identifiers; price confirmation; the listed state; the delist.
7. Rollback rehearsal: a state written with market counters is read by the previous signer; the previous signer refuses
   the new intents; the policy file rule (`nft.market` key) as for `nft` in delivery 2.

### 4.11 Effort

About 8–10 working days for one engineer plus the review: intents, builder, verifier, policy and their tests (3) ·
API preparation, on-chain state, simulation, proposal lifecycle (2) · validator proof with the cloned programs (1–2) ·
web review, listed state, delist, texts (2) · documents, threat-model rows, rollback rehearsal (1). The human security
review of the signer change is not in that figure.

## 5. Decisions the owner must take

1. **Is a first market write wanted at all**, and is it A (list and delist a Core asset on the Tensor marketplace
   program)? If the reference collection is not the priority, C (Seaport on EVM) is the alternative — a larger signer
   change.
2. **Accept an upgradeable, source-unverified program as custodian of a listed asset?** The Tensor marketplace program
   holds the asset while it is listed, its on-chain binary is not verified against the published source
   (`verify.osec.io`: not verified), and its upgrade authority can change it. The mitigation proposed (a pinned hash of the
   program data, refused when it changes) detects a change; it does not prevent one while an asset is listed.
3. **Accept the collection's permanent delegates** as a risk that no listing design removes — or restrict listings to
   collections without them.
4. **The policy values**: the price floor and ceiling per currency (there is no default: nothing can be listed until the
   owner sets a floor), the currencies (SOL, USDC), the expiry bounds, the daily and open-listing counts.
5. **Who reviews the signer change**, and whether an external review is required before any mainnet listing. The NFT
   transfer code of delivery 2 has not had an independent review either.
6. **Delist under halt**: allowed (recommended) or not.
7. **Visibility**: a listing made directly on the program is on-chain; whether Tensor's and OpenSea's sites display it
   without their own API is NE and can only be observed with a first real listing — accept that the first one is a test.
8. **`os_tensor`**: OpenSea's own orders for this collection use another program (`7Aru291A…tQF9V`) whose nature is NE.
   Decide whether it must be investigated before choosing, or whether the open-source Tensor program is the only target.
9. **The first real listing** will be the first execution on a real network of any market write — and, with the first NFT
   transfer, of any NFT signature. Decide the asset and the price used for it.
