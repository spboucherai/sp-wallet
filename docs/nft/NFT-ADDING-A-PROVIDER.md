# Adding an NFT provider, standard or chain (contract for implementers)

Read first: `NFT-BRIEF.md` §5–§7, `NFT-ARCHITECTURE.md`, `NFT-SOURCES.md` (how a source is documented), and one existing
adapter (`services/api/src/nft/solana.ts` or `evm.ts`) with its tests (`services/api/test/nft-providers.test.ts`).

## Which kind of thing are you adding?

| You add | Interface | Category of what it returns |
|---|---|---|
| a chain family / standard (ownership, state, identity) | `NftDataProvider` (`provider.ts`) | `onchain` — read from the chain by this server |
| an index (discovery, compressed assets, history) | a section of a provider's `inventory` / `events` | `indexed` — a hint; verify on-chain what can be |
| a market read source | `{ id, supports(asset), snapshot(asset) }` (`market.ts`) | `market` |
| a market **write** | does not exist: delivery 3, behind the signer | — |

Never make one adapter return two categories under one stamp.

## Steps

1. **Establish the source** and write it in `NFT-SOURCES.md` before any code: host, endpoints, authentication, quota, terms
   (quote and URL), what it covers, the date. Verify with a live, read-only call; say `NE` for what could not be established.
   Do not write an adapter against a response you have not seen.
2. **Record fixtures**: add a scenario to `scripts/record-nft-fixtures.mts` (public assets / addresses only, paced, verbatim
   answers with host, method, parameters and time). Tests replay them (`services/api/test/nft-helpers.ts`); an unrecorded
   call throws.
3. **Decode in `packages/nft`** when the chain needs it (pure functions, no I/O), with the layout's source URL in the file
   header and a test against real bytes.
4. **Implement the provider**:
   - identifiers: `nftKey(family, chainId, assetId)`; integers as decimal strings; `Known<T>` for everything that can be
     absent — `unknown(reason)` when a read failed, never a default;
   - `inventory` in independent sections; a refused method → `blocked_by_provider` with the variable that unlocks it; a
     failure → `error` with a stable code; report `truncated` when a cap was hit;
   - `lookup` for any identifier, with `wallet` only to say `heldByWallet`; validate identifiers before any call;
   - `events`: stable ids, `price: null` unless a payment is linked by a market source, `completeness` honest
     (`full` | `partial` | `recent_window` | `unavailable`) with a note code;
   - stamps: host only in `detail` — never a URL that may carry a key;
   - the JSON-RPC / HTTP transports are parameters (tests inject them).
5. **Register** it in `nft/index.ts` (`providers`), add its chains' branch in `service.ts capabilities()` (inventory state,
   reason code, standards, `unlockedBy`), add the reason / section / standard texts to the `nf` block of
   `apps/web/src/i18n.ts` (both languages — `apps/web/test/nft.test.ts` fails on a missing one), and a row in the README
   matrix and in `NFT-AUDIT.md` §3.
6. **Configuration**: variable names in `nft/config.ts` (`nftConfig`, `nftCapabilities` — names only, never a value), in
   `NFT-SOURCES.md` §7 and `nft.env.example`. A source that receives the wallet's address is **off by default** and listed in
   `NFT-SOURCES.md` §8.
7. **Tests** (brief §15): the standard's real cases from fixtures (held / not held / frozen / delegated / burned / without
   metadata / non-standard), endpoint down, endpoint refusing, endpoints disagreeing, indexer contradicting the chain, large
   identifiers; nothing invented when a source is silent.
8. **Smoke**: extend `scripts/smoke-nft.mts` if the chain is new; run it and paste the real output in the work note.

## Rules

- A chain is "supported" only when discovery, ownership, metadata and display all work; otherwise say which part is
  `partial` / `blocked_by_provider`. Never present an unread chain as an empty inventory.
- No badge "verified" from a name, an image, an ERC-165 answer or an indexer's flag alone.
- Creator-controlled URLs go through `resolver.ts` only. Never `fetch` one directly; never hand one to the browser.
- No secret in a log line, an error, a stamp or a response.
- A provider signs nothing and prepares nothing. Transfers are a different delivery, behind the signer.
