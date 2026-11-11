# Cardano (ADA)

Native ADA send / receive on Cardano mainnet. No native assets (tokens, NFTs), no staking, no scripts, no metadata.
Reviewed against mainnet on 2026-11-11 (Conway era, protocol 11.0, epoch 667).

| | |
|---|---|
| Plugin | `packages/core/src/plugins/cardano.ts` (address, CBOR codec, builder, strict decoder) |
| Key derivation | `services/isolated-signer/src/bip32-ed25519.ts` (BIP32-Ed25519, Icarus master key) |
| API adapter | `services/api/src/chains/cardano.ts` (Koios + EMURGO Yoroi backend) |
| Tests | `packages/core/test/cardano.test.ts`, `services/isolated-signer/test/cardano.test.ts`, `services/api/test/cardano-adapter.test.ts` |
| Live proof (read-only) | `npx tsx scripts/smoke-cardano.mts` |

## Keys and address — and what recovery in another wallet means

- The wallet's address is a standard Shelley **base address** (`addr1q…`, CIP-19 type 0): payment key
  `m/1852'/1815'/0'/0/0` + stake key `m/1852'/1815'/0'/2/0` (CIP-1852), derived with **BIP32-Ed25519** from an **Icarus**
  master key (PBKDF2-HMAC-SHA512 of the BIP-39 *entropy*, 4096 rounds — not the BIP-39 seed, not SLIP-0010).
- This is the first receive address the software Shelley wallets (Eternl, Lace, Yoroi, Typhon, Trust Wallet) and Trezor with
  a 12/15/18-word phrase derive from the same phrase: **funds are recoverable by restoring the phrase in any of them**.
  Not the same address: **Ledger** devices (their own master-key scheme, CIP-3 "Ledger"), a **24-word phrase on a Trezor**
  (a documented variant, CIP-3), and Daedalus/Byron-era "legacy" wallets.
- One address only (account 0, index 0). Other wallets rotate addresses; ADA they received on later addresses of the same
  account is not seen by this wallet.
- The stake key never signs here (no delegation, no rewards withdrawal). Delegating the same account from another wallet
  does not disturb this wallet; rewards stay in the reward account until withdrawn with that other wallet.
- The wallet key id is unchanged by this addition (it is derived from the EVM, Bitcoin and Solana addresses only).

## Transaction

`[body, witness_set, true, null]`, Conway CDDL:

```
body        = { 0: #6.258([[txid, index], …]),      ; inputs, sorted, tagged set
                1: [[address(to), amount], [address(from), change]?],   ; array-form outputs, change omitted when 0
                2: fee, 3: ttl }
witness_set = { 0: #6.258([[payment public key, signature]]) }
id          = blake2b-256(body);  signature = Ed25519(id) with the extended key
```

- Value is conserved exactly by the ledger: inputs = outputs + fee. A wrong input value in the intent can only make the
  transaction invalid — it cannot overpay a fee.
- **Fee** = `minFeeA × size + minFeeB` (44 × bytes + 155 381 lovelace) on the size of the signed transaction — one byte more
  than the ledger itself counts (it leaves the validity flag out), i.e. minimum + 44 lovelace, the convention of the official
  serialization library. About 0.169 ADA for one input. The reference-script fee tier does not apply (no scripts).
- **Minimum ADA per output** = `(160 + serialized output size) × coinsPerUTxOByte` (4 310): 0.96975 ADA to a base address,
  0.84907 ADA to an enterprise address. Enforced for the payment and for the change. A payment that would leave change below
  the minimum is refused with the two amounts that work (a smaller amount, or exactly everything).
- **Validity**: `ttl` = now + 900 slots (seconds). The signer refuses a `ttl` in the past or more than 2 h after the intent.
- **Native assets are never spent**: a UTxO carrying tokens, a datum or a reference script is excluded from selection (both
  sources must agree on which UTxOs carry tokens). The ADA attached to such UTxOs stays with them; the Send screen says so.
- **Destinations**: mainnet addresses whose payment part is a key (types 0, 2, 6). Refused: payment-script addresses (ADA sent
  to a contract without its datum can be locked for ever), pointer addresses, reward addresses (`stake1…`), Byron addresses,
  test networks.
- No memo (CIP-20 message metadata is not implemented: exchanges do not use one for ADA).

## Data sources and agreement

| What | Koios (`api.koios.rest`) | Yoroi backend (`api.yoroiwallet.com`) | Rule |
|---|---|---|---|
| Identity | `/genesis` magic 764824073 + pinned tx/block | pinned tx/block (`/v2/txs/get`) | both, + tips within 3 blocks |
| UTxO set | `/address_utxos` | `/txs/utxoForAddresses` | identical ids, values, "carries tokens" |
| Protocol parameters | `/epoch_params` | — | must equal the reviewed pin (`REVIEWED_PARAMS`) |
| Dry run | `/ogmios` `evaluateTransaction` | — | a ledger rejection refuses; endpoint down = skipped |
| Broadcast | `/submittx` | `/v2/txs/signed` | both; one success is enough |
| Status | `/tx_status` | `/tx/status` | shallower depth wins; expiry needs both |
| Deposits | `/address_txs` + `/tx_info` | `/v2/txs/get` (each output re-checked) | finalized (15 blocks) only |

Protocol parameters have a single keyless live source, so they are **pinned**: if governance changes the fee coefficients,
the per-byte minimum or the maximum transaction size, `prepare` answers `protocol_changed` and sending stops until
`REVIEWED_PARAMS` is reviewed. (A too-low fee is only ever rejected by the chain; a too-high one is bounded by the ceiling.)

Koios' public tier has a daily request allowance: the tip is cached 20 s, deposits are scanned at most every 5 minutes, and
balances are read from Yoroi first. Confirmation: 15 blocks (≈ 5 minutes); Cardano has no instant finality, a transaction
seen in a block and then gone is reported `reorged` and followed until it reappears or its validity window closes.

## Verified (2026-11-11)

- CIP-3 Icarus master-key vectors (with and without passphrase).
- Addresses published by mainstream wallets for their test phrases: Trust Wallet (`shoot island … above` →
  `addr1qyr8jj…84ray2`), Trezor firmware fixture (`all all … all`, account 4 → `addr1q8v42w…sx9990`), CIP-19 type-00 vector.
- Key for key against `@emurgo/cardano-serialization-lib-nodejs` 17.0.0: extended private keys, public keys and signatures
  for hardened and soft steps, on fixed and random entropy/paths; the library's own `make_vkey_witness` on the library's own
  derived key gives byte-identical witnesses to the signer's.
- Transaction: body byte-identical to the one the library builds from the same fields (fixed cases + property test);
  the signed transaction round-trips through the library unchanged; id, minimum fee and minimum ADA equal the library's.
- Real mainnet transactions decoded with the plugin's decoder: id (recomputed from the body bytes), fee, ttl, inputs, outputs
  (incl. multi-asset and Byron outputs) identical to the Koios indexer; their real signatures verify against the recomputed id.
- Live: `evaluateTransaction` on a node (Ogmios through Koios) accepts the prepared transaction of a funded public address
  and the one signed end to end with a throwaway key (ledger decoder + input resolution).

## Not verified

- **No transaction was ever broadcast**: acceptance by the mempool/ledger of a transaction signed by the real owner of the
  inputs (witness check, fee check by the node) is inferred from the library equivalences and the evaluate call, not observed.
  First real send: start with a small amount.
- Recovery in another wallet was verified by address equality with published vectors and the official library, not by
  actually restoring a phrase in Eternl/Lace/Yoroi.
- `evaluateTransaction` validates decoding and input resolution; it does not run the full phase-1 checks (signatures, fee).
- Behaviour under a real chain rollback (states `reorged` → back) is exercised with scripted sources only.
- Yoroi's `utxoForAddresses` does not report datums; a datum-carrying UTxO without tokens is excluded on Koios' word alone.
- Koios daily allowance under sustained use (the figures above are design choices, not measured limits).

## Sources (read 2026-11-11)

- CIP-3 Icarus: https://github.com/cardano-foundation/CIPs/blob/master/CIP-0003/Icarus.md
- CIP-1852: https://github.com/cardano-foundation/CIPs/blob/master/CIP-1852/README.md
- CIP-19 (addresses, test vectors): https://github.com/cardano-foundation/CIPs/blob/master/CIP-0019/README.md
- Conway CDDL: https://github.com/IntersectMBO/cardano-ledger/blob/master/eras/conway/impl/cddl/data/conway.cddl
  (`set<a0> = #6.258([* a0]) / [* a0]`; "Both of the Alonzo and Babbage style TxOut formats are equally valid")
- Trezor fixture: https://github.com/trezor/trezor-firmware/blob/main/common/tests/fixtures/cardano/get_base_address.json
- Trust Wallet vectors: https://github.com/trustwallet/wallet-core/blob/master/android/app/src/androidTest/java/com/trustwallet/core/app/blockchains/CoinAddressDerivationTests.kt
- Koios API: https://api.koios.rest/ · Yoroi backend: https://github.com/Emurgo/yoroi-graphql-migration-backend
- Live protocol parameters: Koios `/epoch_params` (epoch 667) and Ogmios `queryLedgerState/protocolParameters`.
