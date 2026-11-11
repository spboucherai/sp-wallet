# Polkadot (DOT) — on Polkadot Asset Hub

Native DOT send / receive. No other Asset Hub assets, no staking, no XCM.
Reviewed against Polkadot Asset Hub on 2026-11-11 (spec `statemint` 2005002, transaction version 15, node 1.25.1).

| | |
|---|---|
| Plugin | `packages/core/src/plugins/polkadot.ts` (SS58, SCALE subset, builder, strict decoder, reviewed pins) |
| Metadata reader | `services/api/src/chains/polkadot-metadata.ts` (metadata V14, generic SCALE decoding, storage keys) |
| API adapter | `services/api/src/chains/polkadot.ts` |
| Tests | `packages/core/test/polkadot.test.ts`, `services/isolated-signer/test/polkadot.test.ts`, `services/api/test/polkadot-adapter.test.ts` |
| Live proof (read-only) | `npx tsx scripts/smoke-polkadot.mts` |

## Where DOT lives: Asset Hub, not the relay chain

On **4 November 2025** the Asset Hub migration moved account balances, transfers, staking and governance from the Polkadot
relay chain to the system parachain **Polkadot Asset Hub**. Exchanges switched DOT deposits and withdrawals to Asset Hub in
the following days (KuCoin: relay-chain DOT "will no longer be supported"; MEXC "DOTASSETHUB"; bitbank: a relay-chain deposit
"may be lost"). Checked on chain on 2026-11-11: total issuance **1 711 648 440 DOT on Asset Hub, 245 998 DOT on the relay
chain**. This wallet therefore targets Asset Hub only (genesis `0x68d56f15…c3de2f`); the relay chain is refused by the plugin.

- Addresses did not change with the migration: the same SS58 address (prefix 0, starts with `1`) is the account on Asset Hub.
- Existential deposit on Asset Hub: **0.01 DOT** (`Balances.ExistentialDeposit` read from the runtime; it was 1 DOT on the
  relay chain). Block time 2 s; finality by GRANDPA through the relay chain (≈ 25 blocks / 50 s behind the best block).

## Keys and address — and what recovery in another wallet means

- The account is an **ed25519** account, key derived with SLIP-0010 at **`m/44'/354'/0'/0'/0'`**. ed25519 accounts are
  first-class on Polkadot (`MultiSignature::Ed25519`); recent real ed25519 transfers on Asset Hub are in the test fixtures.
- **Consequence**: this is *not* the address Polkadot.js, Talisman, Nova or SubWallet show for the same phrase — those derive
  an **sr25519** key from the BIP-39 *entropy* (substrate-bip39), a different key. Restoring the phrase there shows an empty
  account. The funds are recoverable (a) with this wallet's seed and the path above, and (b) in **Trust Wallet**, which uses
  exactly this derivation (`registry.json`: `m/44'/354'/0'/0'/0'`, curve ed25519; its published test address is reproduced
  in the tests), or with any tool that accepts a raw 32-byte ed25519 seed (the SLIP-0010 key at that path).
- Hardware wallets were not examined: assume a Ledger or Trezor shows another address for the same phrase.
- sr25519 was not chosen because it needs Schnorrkel/Ristretto signing code the wallet does not have anywhere else; nothing
  on chain distinguishes the two account types for a transfer.

## Transaction

Signed extrinsic, version 4:

```
compact(len) ‖ 0x84 ‖ MultiAddress::Id(account) ‖ MultiSignature::Ed25519(sig) ‖ extra ‖ call
call    = 0x0a 0x03 ‖ MultiAddress::Id(dest) ‖ Compact<u128>(value)          ; Balances.transfer_keep_alive
extra   = Era (mortal, 2 bytes) ‖ Compact(nonce) ‖ Compact(tip = 0) ‖ 0x00 (fee asset: none) ‖ 0x00 (metadata-hash mode: off)
payload = call ‖ extra ‖ spec_version ‖ transaction_version ‖ genesis ‖ era block hash ‖ 0x00 (no metadata hash)
signature = Ed25519(payload)      ; blake2b-256(payload) first when the payload exceeds 256 bytes (never the case: 121 bytes)
```

- **`transfer_keep_alive`**, not `transfer_allow_death`: the wallet's account always keeps the existential deposit and is
  never reaped (a reaped account loses its dust and its nonce). There is no "send all": the last 0.01 DOT stays.
- A transfer below 0.01 DOT to an account that does not exist would fail on chain (fee lost): refused beforehand. A transfer
  that creates the destination account carries a notice.
- **Mortal era**: 256 blocks (≈ 8.5 min) from a *finalized* block. Never immortal: the signer refuses periods above 256.
- **Fee**: not a field of the transaction — the chain computes it (≈ 0.0009 DOT). The tip is always 0. The quote comes from
  `payment_queryInfo` on both nodes for the exact bytes; `maxFee` = 2 × quote, capped at 0.05 DOT. The signer cannot bound the
  fee inside the bytes; it bounds it by fixing the call and the zero tip.
- **Dry run**: `system_dryRun` is refused by public nodes ("unsafe"); the runtime API `DryRunApi.dry_run_call` is public and
  executes the exact call as the wallet's account at the reference block, on both nodes.

## Runtime upgrades

A runtime upgrade can renumber pallets and calls and change the list of transaction extensions, i.e. the bytes of a valid
transaction. Nothing is trusted across upgrades:

1. **Signer**: refuses any `transaction_version` other than the reviewed one (`POLKADOT_REVIEWED.transactionVersion`, 15).
   Substrate bumps that number whenever the signed format or a call index changes.
2. **API**, before every transfer: `state_getRuntimeVersion` on both nodes (spec name, spec version ≥ reviewed, transaction
   version). On a spec version it has not checked yet, it downloads the metadata from both nodes (must be byte-identical) and
   verifies **by name**: extrinsic version; the 13 transaction extensions in order with the type of every explicit and
   implicit field; pallet `Balances` = 10; call `transfer_keep_alive` = 3 with `dest: MultiAddress, value: Compact<u128>`;
   `MultiAddress::Id` = 0; `MultiSignature::Ed25519` = 0; `System.Account` layout and hasher; `Balances.Transfer` event;
   `ExistentialDeposit`; SS58 prefix; `OriginCaller::system(RawOrigin::Signed)`. Any difference → `runtime_changed`:
   sending (and the deposit scan) pauses; balances remain readable.
3. The plugin's builder decodes its own output back with a strict decoder before releasing a signature.

The indices are constants of the reviewed plugin *and* are looked up by name at run time: both must agree.

### Procedure when sends pause with `runtime_changed`

1. `npx tsx scripts/smoke-polkadot.mts` — the step "runtime pins" prints the first difference.
2. Read the runtime release notes (https://github.com/polkadot-fellows/runtimes/releases) for the extension / call change.
3. `node scripts/record-cardano-polkadot-fixtures.mts` (new metadata + real transfers), update `POLKADOT_EXTENSIONS` /
   `POLKADOT_REVIEWED` and the encoder in `packages/core/src/plugins/polkadot.ts` if the layout changed.
4. `npx vitest run packages/core/test/polkadot.test.ts services/api/test/polkadot-adapter.test.ts services/isolated-signer/test/polkadot.test.ts`
   (signing payload and extrinsic against `@polkadot/types` with the new metadata, real transfers decoded).
5. `npx tsx scripts/smoke-polkadot.mts`: the nodes must answer `Invalid::Payment` (signature accepted) for the throwaway key.
6. Release signer and API together.

## Data sources and agreement

Two archive nodes over HTTPS JSON-RPC: Parity (`polkadot-asset-hub-rpc.polkadot.io`) and OnFinality
(`statemint.api.onfinality.io/public`); LuckyFriday (`rpc-asset-hub-polkadot.luckyfriday.io`) was verified as a spare.
Agreement of both is required for: genesis hash, runtime version, metadata, the finalized reference block (lowest finalized
head, same hash on both), the account (nonce, balances) and the destination account at that block, `system_accountNextIndex`
(a pending transaction refuses a new one), the fee quote, the dry run.

A Substrate node has no transaction index:

- **Tracking**: the account nonce at the finalized head tells whether an extrinsic with that nonce was included; bisection
  over past state finds the block (≈ 9 state reads); the block's extrinsics identify it by hash and its `System.Events` give
  `ExtrinsicSuccess` / `ExtrinsicFailed` (with the dispatch error). Finalized = final. Expired = the era ended on the
  finalized chain of *both* nodes and the nonce is unused. If the account no longer exists (cannot happen through this
  wallet's own keep-alive transfers), every block of the era is read instead.
- **Deposits**: the account's raw state is compared between the last scanned block and the finalized head; only when it
  differs are the changing blocks located (bisection) and their events decoded with the metadata (`Balances.Transfer` to the
  account, `Balances.Minted` for XCM arrivals). No change = 5 requests per pass. The first pass starts at the current head.

## Verified (2026-11-11)

- Address: Trust Wallet's published vector for this derivation; SS58 against `@polkadot/util-crypto` (property test).
- Signing payload byte-identical to `@polkadot/types` 17.0.2 (`ExtrinsicPayload`, real metadata); the signed extrinsic
  round-trips through it unchanged, same hash; signature verified by `@polkadot/util-crypto` and noble.
- **By the nodes themselves, without submitting** (`TaggedTransactionQueue.validate_transaction`, both operators):
  an extrinsic signed with a throwaway key → `Invalid::Payment` (signature and encoding accepted; the account has no funds);
  same with one signature bit flipped → `BadProof`; same signed over the relay chain's genesis → `BadProof`; the stand-in
  extrinsic with a placeholder signature → `BadProof`.
- `payment_queryInfo` (identical on both nodes) and `DryRunApi.dry_run_call` = Ok for a funded public account.
- Real transfers of recent blocks (ed25519, sr25519; keep-alive and allow-death) decoded identically to `@polkadot/types`
  and re-encoded byte for byte; a real finalized transfer tracked; a real incoming transfer found by the deposit scan; the
  events of real blocks decoded identically to `@polkadot/types`, including a real failed transfer (`Token.Frozen`).
- The metadata reader against `@polkadot/types` on the full 640 kB document (pallets, calls, extensions, type count).

## Not verified

- **No extrinsic was ever broadcast**: inclusion and finalization of a transfer of this wallet are not observed; `broadcast`
  and the `confirming` state are exercised with scripted nodes only. First real send: start with a small amount.
- Recovery in Trust Wallet was verified by address equality with its published vector, not by restoring a phrase in the app.
- The fee actually charged versus the quote (the fee multiplier can move between quote and inclusion; margin ×2).
- `Balances.Minted` as the event of XCM arrivals was not exercised on a real XCM deposit.
- Deposits made while the runtime is unreviewed appear only after the review (the cursor waits); the balance is always live.
- Behaviour of the two public endpoints under rate limiting.

## Sources (read 2026-11-11)

- Polkadot Wiki, "What is Asset Hub and How Do I Use It?": https://wiki.polkadot.com/learn/how-to/what-is-asset-hub/
  (balances migrated on 4 November 2025; staking and governance no longer on the relay chain)
- Polkadot Forum, "Asset Hub Migration – Balances FAQ": https://forum.polkadot.network/t/asset-hub-migration-balances-faq/14561
  ("After the migration, the exchanges would withdraw the DOT tokens from the Asset Hub"; addresses stay the same)
- Exchange notices: KuCoin https://www.kucoin.com/news/en-kucoin-has-completed-the-polkadot-dot-network-migration-to-asset-hub-polkadot-251108 ·
  MEXC https://www.mexc.com/announcements/article/17827791531582 · bitbank https://support.bitbank.cc/hc/en-us/articles/52020807851929 ·
  Fireblocks https://support.fireblocks.io/hc/en-us/articles/20840913004060-Polkadot-Migration-to-Asset-Hub
- Chain itself: `state_getRuntimeVersion`, `state_getMetadata`, `Balances.TotalIssuance` on both chains (see the smoke script).
- Trust Wallet derivation: https://github.com/trustwallet/wallet-core/blob/master/registry.json (polkadot) and its
  `CoinAddressDerivationTests.kt`.
- Formats: frame-metadata V14 https://github.com/paritytech/frame-metadata/blob/main/frame-metadata/src/v14.rs ·
  scale-info https://github.com/paritytech/scale-info · SS58 https://github.com/paritytech/ss58-registry ·
  XXH64 https://github.com/Cyan4973/xxHash/blob/dev/doc/xxhash_spec.md. The extrinsic layout was established from the live
  metadata and real extrinsics and proven against `@polkadot/types`, not from a prose specification.
