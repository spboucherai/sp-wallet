# SP Wallet — NFT brief (owner's specification, 2026-11-17)

This file records the owner's specification for the NFT work, as given. It is the reference for every NFT workstream.
The OpenSea link is a functional reference and a validation case, not a design to copy pixel by pixel and not a page to scrape.

**Reference item to verify live:** https://opensea.io/item/solana/CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j
Mint given by the URL: `CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j`.

Never invent the name, collection, attributes, rarity, owner, price or history of this item. Load the data from the
available sources and show "unavailable" or "not verified" when they cannot be established.

## 1. Expected result

Make SP Wallet a multi-chain wallet that lets the owner:

1. discover the NFTs really held by the wallet's addresses;
2. browse a gallery, collections and a detailed item page;
3. see on-chain data separated from metadata and from market information;
4. understand provenance, owners, events, listings and offers when reliable data exist;
5. receive and send NFTs with a readable and exact confirmation;
6. buy, sell, create/cancel a listing or accept an offer ONLY when a market integration really exists and the transaction can be verified by the signer;
7. keep the custody model, passkeys, isolated signer, limits and human control already established.

The product must be honest about its scope. "All NFTs" cannot be promised: chains, standards, marketplaces, collections
and metadata schemas are many. Design extensible adapters and show exactly which chains, standards and functions are supported.

## 2. Functional reference (OpenSea item page)

When sources allow, the item experience offers:

- main media (image, animation, video, or HTML content in an isolated player);
- item name, number/token ID, collection and network;
- collection verification badge only if the provider certifies it, with the source named;
- current ownership and state (in the wallet, listed, in escrow, burned, transferred, unknown);
- asking price, best offer, currency, estimated fees and possible action;
- raw traits/attributes with their value; frequency/rank only if the collection and the sample are clearly defined;
- description and controlled external links;
- blockchain details: mint/contract address, token ID, standard, creator/update authority when available, metadata URI, verification state;
- activity/provenance: mint, transfer, sales, listings, offers, cancellations, owner changes when indexed;
- contextual actions: receive, send, copy address, open explorer, sell/buy/offer if the function is active.

Every market datum shows its timestamp, currency and provenance. A collection floor price is not a guaranteed estimate of this item's value.

## 3. First task: real audit of the repository

Before coding, inspect the repository and read the current documents: README and recent commits; docs/adr, docs/threat-model,
docs/security/acceptance.md; the documentation on adding a chain; packages/core (networks, families, intent, policy, builders,
plugins and tests, tokens and the registry generation); API services, RPC adapters, reconciliation workers, database schema;
the web application (navigation, screens, components, hooks, FR/EN localisation); the isolated signer, the API-signer transport,
limits and audit journal; unit, integration, security and e2e tests.

The code and effective migrations are the source of truth, not older documents. Do not replace a newer implementation by an older documented version.

Establish a real matrix: chain → address generation → balance reading → tokens → detectable NFTs → NFT display → NFT transfer →
market actions. Mark implemented, partial, absent, blocked by provider, or to confirm. Never deduce NFT support from the mere fact
that native transfers of the chain work.

After the audit, update the scope to the real architecture and start implementing without waiting for a new validation.
Do not touch keys or move real assets during development.

## 4. Priority scope

### Phase A — read-only NFT wallet

1. **Solana**: Metaplex Token Metadata, Metaplex Core, and compressed NFTs only with suitable indexer data; treat programmable NFTs (pNFT) explicitly and never as ordinary SPL transfers.
2. **EVM**: ERC-721 and ERC-1155 on the EVM networks really registered and used by the wallet. Use the events/reads needed to identify holding and quantity. Distinguish semi-fungible ERC-1155 tokens.
3. **Bitcoin**: show Ordinals inscriptions only if a reliable ord-aware indexer establishes the outpoint and the sat. Never confuse them with an ERC-721 and never move them with an ordinary BTC send.
4. Extend later through adapters to the other enabled chains (Cardano, Polkadot Asset Hub, Sui, Aptos, TON, XRPL…) after verifying each standard, indexer, address format, ownership model and signing method.

### Phase B — receive and secure transfer

NFT transfers are a new class of intent and policy, with a specialised builder per family. No generic "sign these bytes/calldata" mode.

- Recipient, chain, contract/mint, token ID, quantity, standard, program/proxy called and fees are presented clearly before approval.
- The intent signed by the passkey freezes all critical data, includes expiry, nonce/replay protection, limits and canonical hash, per the current model.
- The API prepares and simulates; the isolated signer rebuilds/validates the transaction from the authorised fields only; it refuses unknown fields or a silent change.
- Only explicitly supported methods (safe ERC-721 transfer, ERC-1155 transfer, validated Solana NFT instructions). Verify programs/contracts and expected associated accounts.
- No unlimited operator approvals in "send" flows. Marketplace approvals are distinct operations, limited in scope and revocable, showing the contract, the token or collection, the amount/quantity, the market and the duration.
- Verify collections and transfer programs against on-chain sources and configurable trust lists; a marketplace badge does not replace an on-chain verification.
- Handle locked, escrowed, burned, bridged, frozen, soulbound, pNFT or non-transferable NFTs with an exact message instead of a send button that fails.
- After broadcast: pending, then confirmed only after the finality appropriate to the chain. Handle reorgs and errors like the existing fund transfers.

### Phase C — marketplace functions

A layer of market adapters separate from the wallet core. Reads may aggregate several providers; market WRITES are disabled by
default and enabled one by one after analysis of the order format and validation by the signer.

Targeted functions, each with its real state and failure cases: active listings and asking price; offers on the item and best
collection offers; purchase and offer acceptance; create/cancel listing; create/cancel offer; royalties/market fees shown separately
and per the transaction really signed; the NFT's state during escrow; detection of listings/offers created on other markets when the
provider exposes them, without claiming SP Wallet can cancel them.

Before integrating OpenSea or any provider: verify current documentation and terms, required keys, real Solana and EVM coverage,
quotas, event types, regional availability and redistribution rights. Server-side calls when secrets are needed; never expose a secret
to the browser or the web bundle. Provide a mode without provider (on-chain inventory and explorer links).

No market transaction may be simulated to make believe it works. If the market is not really integrated, show the function as
unavailable or open the official site in a new page, with a clear warning that the action happens outside SP Wallet.

## 5. Canonical data model

Versioned, chain-agnostic types, keeping each chain's own identifiers. Never use a symbol or a name alone as key. Indicative shape,
to adapt to the repository's TypeScript conventions:

```ts
interface NftAsset {
  key: string;                     // canonical identifier: family:chain:asset-id
  family: string;
  chainId: string;
  ownerAddress: string;
  assetId: string;                 // mint, contract+tokenId, inscription/outpoint…
  standard: string;
  tokenId?: string;                // string, never a JS number
  contractAddress?: string;
  mintAddress?: string;
  quantity: string;                // exact integer; useful for ERC-1155
  collection?: NftCollectionRef;
  metadata: NftMetadataRecord;
  media: NftMediaRecord[];
  ownership: NftOwnershipRecord;
  market?: NftMarketSnapshot;
  provenance?: NftEvent[];
  capabilities: NftCapabilities;
  sources: DataSourceStamp[];
  fetchedAt: string;
  blockRef?: { number?: string; hash?: string; slot?: string; commitment?: string };
}
```

Rules: identifiers, token IDs, slots, block numbers, prices and quantities as string/BigInt, never JS Number; price currency with
network and exact mint/contract, exact decimals; null, unknown, unsupported and zero are different states; raw metadata kept
separately from normalised fields; every external value has a source, a date, block/slot when relevant, a confidence level and a
freshness state; `key` computed deterministically, never merge two assets because they share a name, image or collection; ERC-1155
quantity may exceed one, and the same token ID may exist in another contract/network; on Solana the mint is not necessarily the
collection address — keep mint, update authority, collection mint and token account distinct; never store names, prices or traits
produced by an approximate fallback.

## 6. Precision and provenance of data

Interface `NftDataProvider` and isolated adapters. Separate at least:

1. on-chain truth: ownership, balance/quantity, token ID, events, account status, program/contract;
2. metadata declared by the creator: name, description, image, animation, attributes, external URL;
3. indexed/cached data: history and discovery;
4. market data: offers, listings, sales, floor price, volume;
5. data computed by SP Wallet: converted value, estimated rarity, median price.

Never present categories 2–5 as on-chain truths. In the detail, provenance is consultable: "Confirmed on-chain", "Creator metadata",
"Indexed by [source]", "Market — updated at …".

- Contracts/mints and balances are re-verified on reliable RPCs before a transfer.
- Solana: verify mint owner/program, token account, amount, decimals, authorities, frozen state, delegate, metadata PDA and collection verification when applicable.
- ERC-721/1155: read interface support with caution, use the registry/indexer for discovery; interfaces alone do not prove legitimacy.
- Compare two endpoints where the existing system does; detect a divergent RPC answer or a lagging indexer.
- Deduplicate events by a stable identifier (chain, tx, logIndex or signature/instruction); handle reorgs/finality.
- Cache with a TTL per data type. Ownership has a short cache or is re-verified at action time. Images/metadata may be cached longer with manual invalidation.
- A "Refresh metadata" button, limited and rate-limited; a refresh cannot change the on-chain truth.
- Show the last refresh date and a "possibly stale data" state.

### Metadata and URIs

Support common forms without presuming they are safe: HTTPS, ipfs://, Arweave, on-chain URI, Metaplex JSON, EVM metadata,
inscription references. Normalise through a deterministic, logged, testable resolver.

- Refuse unauthorised schemes, private/local addresses, dangerous redirects, URLs with embedded credentials, huge responses and misleading MIME types.
- Server-side SSRF protection: block private IPs, link-local, localhost, cloud metadata ranges; validate DNS before and after resolution; limit redirects; timeout.
- Size/depth limits for JSON and media; content-type and file signature verified.
- Keep source URI and normalised URI; never silently modify the provenance link.
- IPFS gateways from a configurable list; replaceable; an error if no resolver works.
- Metadata may be mutable: show mutability/update authority when determinable.
- The media proxy serves public data only; not an open proxy.

### Traits, statistics, rarity

- Show all raw attributes normalised, even duplicated or malformed ones; also keep the raw datum.
- Do not normalise a value to the point of losing case/format/unit. Handle numbers, strings, nulls, numeric traits min/max and `display_type`.
- Frequency only on the verified collection and the exact number of indexed items; show the denominator and date ("3.2 % of 8 421 indexed items").
- Never invent a rarity rank without the complete collection and an announced method; name the method and provider.
- If traits are unreliable (compressed, partially indexed, mutable metadata), show "not computed" and why.
- Never claim a collection is verified because its name/artwork matches a known one.

## 7. Media and link security

NFTs can point to active SVG/HTML, animations, scripts, giant files, shocking or phishing content.

- Image/audio/video with standard players and MIME allow-lists; no audio/video autoplay.
- Active HTML/SVG in a minimal sandbox iframe: no same origin, no scripts, no top navigation, no clipboard or permissions. Strict CSP; isolated proxy if needed.
- Never inject name or description as HTML without a tested sanitizer; better: plain text and filtered links.
- Show the domain of external links; neutralise `javascript:`, unneeded `data:` and arbitrary schemes.
- Loading an image must not send cookies or session data; media proxy with SSRF control and quotas.
- Clearly indicate content blocked for security rather than attempting a rendering that bypasses protections.

## 8. Prices, sales, fiat estimate

- Keep each quote in its native currency and exact mint/contract.
- Always show the asking price and unit; fiat conversion is secondary information with source and timestamp.
- Differentiate listed price, best offer, last sale price, collection floor, realised sale price and aggregate estimate.
- No valuation from a floor price if the item has few comparables. The NFT total of the portfolio may be "value unavailable"; do not count zero as if worthless, nor the floor as a certain value.
- Flag wash/self trades if the source reports them; do not filter silently.
- Royalties/network/market fees in the confirmation screen when known; distinguish exact fees from estimates.
- If market APIs do not answer, the item page and ownership still work.

## 9. History and activity

Event model with at least: type, asset key, source, block/slot, transaction hash/signature, log/instruction index, UTC date,
counterparty when resolved, quantity, currency/value only if proven, finality state.

Types: mint, transfer-in, transfer-out, sale, list, delist, offer, cancel-offer, accept-offer, burn, escrow, unknown. The same
event may have more than one marketplace interpretation: keep the raw trace and mark the interpretation as such.

- Transfers shown distinct from sales. Never infer a sale from a mere transfer.
- No historical price unless a matching payment was linked with confidence.
- Pagination and date/type filters; progressive loading without blocking the page.

## 10. Interface

Respect the existing components and design system. Phone-first, bilingual FR/EN, light/dark theme.

Screens: (1) Assets → NFT: gallery and list view; network/collection/status filters; search; sort by name, recent, price only
if data are reliable; result count; skeleton/error/empty/loading. (2) Collection: image/banner, description, verification, network,
contract/mint, items held, floor/volume separated, traits, navigation to items. (3) NFT detail: media, full identity, traits,
wallet/market status, chain, activity, sources, available buttons. (4) Send NFT: exact network/asset, recipient, ERC-1155 quantity,
fee preview and address verification; passkey screen summarising the transfer again. (5) Receive: the address of the right chain,
QR, compatibility warning, copy button, no claim that the NFT arrived before confirmation. (6) Market: listings/offers with
market/source indicator; unavailable actions are disabled and explained.

UX and accessibility: on a phone the media adapts without hiding the identifier and main actions; the full technical identifier is
copyable; all texts go through the existing translation mechanism; keyboard navigation, screen-reader labels, contrast, visible error
states; explicit states (fetching, synchronising, no NFT, RPC offline, indexer lagging, metadata missing, media blocked, NFT not
transferable, market unavailable); no "Verified" badge without proof ("known contract" / "not verified" distinct); action menus
separate the wallet's internal actions from links to an external service.

## 11. API and indexing

Endpoints following the service's current conventions, for example: `GET /api/nfts?chain=&collection=&cursor=`, `GET /api/nfts/:key`,
`GET /api/nfts/:key/activity?cursor=`, `GET /api/nft-collections/:key` and `/items`, `POST /api/nfts/refresh-metadata` with limits,
`POST /api/nfts/transfer/prepare`, separate market endpoints if really available. Indicative, not a licence for a parallel API that
bypasses auth or the repository's conventions.

- Every private route authenticated with the existing passkey/session system.
- zod validation of all parameters; limits on pagination, size, duration, frequency.
- Never accept an arbitrary `ownerAddress` from the client as the only proof; the server derives the address from the session/configured wallet.
- API keys and secrets stay in server config, never in the web response, logs or errors.
- Provider errors have a stable code, a source and redacted details.
- Reversible migrations if the repository uses a database; idempotent, reorg-safe indexing.
- No full historical indexing with public RPCs: indexer/provider for discovery, then on-chain verification of the user's assets before an action.
- Watch quotas; RPC batching, backoff, cache, circuit breaker.

## 12. Market actions and transaction interpretation

No arbitrary calldata/instruction builder. For each market: document programs/contracts, versions, official addresses and the
validation mechanism; decode the message/transaction into a deterministic human summary; sign only a list of supported
methods/arguments; refuse delegate approvals, extra instructions, opaque destinations or unrecognised instructions; verify the NFT is
held by the wallet or that the announced escrow state is the expected one; simulate with the configured RPC and impose
fee/slippage/price limits; include every visible Solana instruction (compute budget, ATA, escrow, marketplace, royalties, payment)
in the approval screen; verify the transfer/exchange after finality before marking the action successful.

On Solana, include account-ownership changes and each market's escrow behaviour: a listing may move the NFT to an escrow account;
the interface must show that state so that it is not mistaken for a theft or a burn. Never generalise that behaviour to all markets.

## 13. Signer and custody model

Existing security is an invariant. Understand and document the flow API → canonical intent → passkey → isolated signer → broadcast.

- New versioned intent types, backward compatible with current intents.
- A signer-side validator that rebuilds NFT transactions from the approved semantic fields, not from bytes supplied by the API.
- The signer itself verifies chain, family, wallet address, contract/program, token ID, quantity, destination, expiry, nonce, limit, halt state and replay.
- Every new capability goes into the signer policy with a conservative initial limit, capped amount/quantity and a documented policy version.
- Sales/purchases cap amounts, currencies, fees, royalties and slippage. Any limit increase needs a separate, explicit configuration; no bypass through a marketplace.
- The front end and the API are not security authorities.
- An audit trail without secrets, private key, seed, raw WebAuthn assertion or unnecessary personal data.
- With falsified metadata, the confirmation shows the real on-chain identifiers and does not rely on the NFT's name/image.
- If a transaction cannot be decoded safely, refuse to sign rather than show an incomplete summary.

## 14. Data and privacy

Private NFT inventory; do not index other people's wallets or create a public list by default. RPCs/indexers receive the necessary
public address: limit and document those requests. Do not associate real name, e-mail or passkey with an external explorer. Never
send the wallet address to a marketplace for a mere preview without stating the consequence. Log and retention controls: no secrets;
never log a signature payload.

## 15. Tests and acceptance criteria

A build is not enough if the flow still shows demonstration data. Test without real assets, with simulators/forks or deterministic fixtures.

- **Model and provider**: stable unique identifier, no collision between chains/contracts; large token IDs/amounts exact; IPFS/Arweave/HTTPS URI normalisation; missing metadata, malformed JSON, duplicated traits, unknown fields, malicious animation; provider unavailable, quota, stale cache, contradictory data; no confusion between on-chain owner and marketplace/escrow owner.
- **Chain**: Solana legacy Metaplex, Core, compressed if an indexer is present, Token-2022/pNFT per support, frozen/delegated/burned, collection and mint validation; EVM ERC-721, ERC-1155 quantity 1 and >1, transfer in/out, NFT without metadata, mutated URI, non-standard contract, reorg; Ordinals inventory/transfer only ord-aware, and a test that an ordinary BTC send cannot spend an inscription by accident; chains without NFT adapter show "not supported", no invented inventory.
- **Security**: SSRF localhost/private/cloud metadata, DNS rebinding, redirect chain, HTTP schemes, oversized payload; XSS in name, description, URL, SVG/HTML; ID/tokenId substituted between preview and signature; changed destination, changed network, unknown program, added instruction, abusive quantity/fee, replay, expiry; unlimited approval attempts, unrecognised calldata, fake badge and fake price; the signer refuses all of them.
- **UI**: narrow phone, desktop, light/dark, FR/EN, loading/error/empty/offline; full details readable and copyable; keyboard focus and screen reader; the reference OpenSea item loaded from the providers, or a clean failure without invented values.

Run the repository's applicable commands (typecheck, test, build, e2e). Add only the targeted tests needed. Never broadcast a real transaction during tests.

## 16. Documentation and operations

Update: README with a current matrix per chain and NFT function; NFT architecture document and threat model; guide for adding a
family/standard/provider; example environment variables without any real key; known limits (market sources, coverage, estimation,
incomplete standards); runbook (quotas, indexer outage, provider renewal, reindex, security incident). If provider keys are needed,
add only documented variable names, a degraded mode without key and a server-side configuration check. Never a key in a commit, log or the client.

## 17. Recommended deliveries

1. **Inventory and detailed page**: audit; Solana and EVM read adapters per what really exists; gallery and detail; secure metadata/media; activity if sources allow; docs matrices and tests; no fictitious market action.
2. **Receive/send**: NFT intent per family; readable review screen; full signer-side control; limits/policy, audit, simulation, finality; attack and UI tests.
3. **Prices and marketplace**: abstract market provider; listings/offers/history with sources and timestamps; buy/sell/offer only when decode + signer + simulation are all implemented; one market/standard at a time.
4. **Chain extensions**: one adapter per standard, never claiming a network is supported before discovery, metadata, ownership and transfer security; suggested priorities after Solana/EVM: Cardano native assets, Sui/Aptos NFT objects, TON collectibles, then the rest per real demand.

## 18. Conduct rules

Check branch, git state and the owner's modified files first; do not overwrite unrelated changes. Read local instructions. Audit,
then implement; do not stop after a long proposal. Keep changes grouped and typed; no big refactor without need. Simple abstractions
compatible with the existing architecture. Do not invent an API, a provider answer, a contract address, a key or NFT data. All
external data are untrusted; every transaction is unsafe until independently validated by the signer. When a capability is blocked by
an API key or an unavailable service, deliver the mode without provider, write the precise blocker and continue with the other
components. No marketplace trading enabled in production by default. No mainnet transaction tests. Do not change the existing fund
limits to ease tests. After each phase, run the targeted checks then the repository's; fix introduced errors. End with a factual
summary: files/functions really added, standards and networks covered, commands run and results, functions still blocked,
configuration variables to provide. Never say "complete" if a phase is missing.

## 19. Technical references to verify at implementation time

- Reference item: https://opensea.io/item/solana/CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j
- OpenSea API overview: https://docs.opensea.io/reference/api-overview
- OpenSea metadata endpoint: https://docs.opensea.io/reference/get_nft_metadata
- OpenSea collection stats: https://docs.opensea.io/reference/get_collection_stats
- OpenSea item page / provenance: https://support.opensea.io/en/articles/8866946-review-your-item-page
- OpenSea Solana support/standards: https://support.opensea.io/en/articles/16779826-which-solana-collections-are-on-opensea
- ERC-721: https://eips.ethereum.org/EIPS/eip-721
- ERC-1155: https://eips.ethereum.org/EIPS/eip-1155
- Ordinals inscriptions: https://docs.ordinals.com/inscriptions.html

## Definition of done

Done only when the screens show real data with source and freshness state, the reference Solana mint is handled without invented
data, the authorised NFT transfers go through the isolated signer and its security tests, unsupported states are honest, the
documentation matches the code, and the repository's checks pass. Market functions whose integration cannot be validated stay
disabled with a clear explanation.
