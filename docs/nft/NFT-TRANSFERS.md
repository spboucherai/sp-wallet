# SP Wallet — NFT transfers and Bitcoin inscription safety (delivery 2, as built — 2026-11-17)

Delivery 2 of `NFT-BRIEF.md` §17: receive and **secure transfer** of NFTs. This note is the design as it is in the code of
branch `nft-2`; where the code and this note disagree, the code wins and this note is wrong. What was proven, on what, is
in `work/nft-2.md`. **Nothing of this delivery was ever executed on a real network**: the proofs run on unit tests with the
real signer code, on local anvil forks and on a local Solana validator.

## 1. The flow

```
item page ──▶ POST /api/v1/nfts/transfer/prepare {key, to, quantity?}  (owner session, Idempotency-Key)
                │ 1. the asset is looked up again on EVERY endpoint (provider), then the deciding reads are made with the
                │    quorum rule (`rpcQuorum`: every admitted endpoint answers and agrees): standard, ownership, state
                │ 2. destination checks; nonce / blockhash; fees inside the signer's EXISTING fee ceiling
                │ 3. canonical NftIntent → the same builder + independent verifier the signer runs → NFT policy pre-check
                │ 4. simulation of the exact call / message (eth_call + estimateGas; simulateTransaction) → account changes
                ▼
        proposal row (kind 'nft', pending_approval)  +  review (on-chain identifiers)  +  passkey challenge = SHA-256(intent)
review sheet ─▶ passkey (WebAuthn, user verification) over that hash
              ─▶ POST /api/v1/nfts/transfer/:id/approve {assertion} ─▶ signer POST /nft/sign {intent, assertion}
                        signer: schema (strict) → key, chain, own address, not self, single use → NFT policy → BUILDS the
                        transaction from the intent → reads it back with an independent decoder → verifies the assertion
                        against the intent hash → persists replay marker + daily count + journal → signs
              ─▶ broadcast (SPW_BROADCAST=off → `not_broadcast`, terminal, never shown as sent)
              ─▶ worker reconcile: broadcast → confirming → finalized at the chain's finality (EVM `finalized` tag,
                 Solana `finalized`), reorg → `reorged`, re-broadcast rules — the EXISTING lifecycle of fund transfers
              ─▶ on confirming / finalized: event `transfer-out` with its finality, and the asset is read again on-chain
```

An NFT transfer is a row of the existing `proposals` table (`kind = 'nft'`, new column `nft` = the review): the same
idempotency keys, states, expiry loop, reconcile loop, finality thresholds and "one transfer in flight per network" rule as a
fund transfer. There is no parallel lifecycle. What differs is the intent type and the signer route. The ordinary routes
(`/transfers/proposals/:id/request-approval`, `/approve`) refuse an NFT proposal (409); the NFT approve route answers 404 for
an ordinary one.

## 2. The three new canonical objects (`packages/core/src/nft-intent.ts`)

New types, new domain separators; **`intent.ts` is not modified** (`git diff nft -- packages/core/src/intent.ts` is empty).
Every pre-existing intent kind hashes as before: ten fixed vectors are pinned in `packages/core/test/nft-intent.test.ts`
(EVM, Bitcoin, Solana and plugin transfers, swap, bridge with and without recipient, THORChain swap, venue deposit, GMX), the
default policy's hash too, and `scripts/rollback-nft-signer-rehearsal.mts` shows the previous signer code and this one signing
the **same bytes** for the same BTC intent.

| Object | Domain | Signer route | What the passkey freezes |
|---|---|---|---|
| `NftIntent` (`kind: 'nft-transfer'`, `v: 1`) | `SPW-NFT-INTENT-v1` | `POST /nft/sign` | below |
| `UtxoLockIntent` (`kind: 'utxo-locks'`) | `SPW-UTXO-LOCKS-v1` | `POST /utxo/locks` | key id, network, action (lock / unlock), reason, every outpoint in order, window, policy version |
| `NftAllowIntent` (`kind: 'nft-allow'`) | `SPW-NFT-ALLOW-v1` | `POST /nft/allow` | key id, network, action (add / remove), address, window, policy version |

Canonical form: the framing of `intent.ts` (domain, then length-prefixed `name`/`value` pairs in an order fixed by the code),
SHA-256. Schemas are strict: an unknown key is a `bad_request`. An absent optional field is absent from the bytes.

**Fields of `NftIntent` frozen by the passkey** — all of them:

| Field | EVM (ERC-721 / ERC-1155) | Solana |
|---|---|---|
| `proposalId`, `keyId`, `createdAt`, `expiresAt`, `policyVersion`, `nftPolicyVersion` | single use, key, window, both policy versions | same |
| `network`, `chainRef` | network id + decimal chain id | `solana` + genesis hash |
| `standard` | `erc721` \| `erc1155` | `spl-token-2022` \| `metaplex-token-metadata` \| `metaplex-pnft` \| `metaplex-core` |
| `asset` | token contract (EIP-55) | mint (SPL, Token Metadata) or asset address (Core) |
| `tokenId` | uint256, decimal string | absent (refused if present) |
| `quantity` | `1` (ERC-721); ≥ 1 (ERC-1155) | `1` |
| `program` | = `asset` (the contract called) | the pinned program of the standard |
| `from` | the wallet (the signer requires its own address) | same |
| `to` | destination (EIP-55) | destination owner |
| `maxFee` | wei: gas limit × max fee per gas must fit | lamports: signature fee + priority fee must fit |
| chain section | `evm { nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas }` | `sol { recentBlockhash, lastValidBlockHeight, computeUnitLimit, computeUnitPrice, tokenProgram?, createAta?, ruleSet?, collection? }` |

There is no `data`, `calldata`, `method`, `instructions`, `accounts`, `message` or helper field. What is not a field cannot be
asked for.

## 3. What the signer builds — and nothing else

### EVM (`packages/core/src/nft-evm.ts`) — the 8 EVM networks

| Standard | The only call | Bytes |
|---|---|---|
| ERC-721 | `safeTransferFrom(address from, address to, uint256 tokenId)` — selector `0x42842e0e` | 100 |
| ERC-1155 | `safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)` with `data = ""` — selector `0xf242432a` | 196 |

EIP-1559, `to` = the contract, `value` = 0, no access list, chain id from the registry, gas limit ≤ 500 000. **Not
expressible**: `transferFrom` (no receiver check — not offered; no case was found that justifies it), `approve`,
`setApprovalForAll`, `safeBatchTransferFrom`, the 4-argument `safeTransferFrom`, a non-empty `data`, any other selector, any
other calldata. The builder also refuses: a contract of the wallet's fungible registry (`nft_contract_is_fungible_token`),
the contract as destination, the wallet as destination, the zero address, a non-EIP-55 address.

### Solana (`packages/core/src/nft-sol.ts`)

A **legacy message** (no address lookup table), one signer = the wallet = fee payer, built entirely by the signer:

```
[0] ComputeBudget SetComputeUnitLimit(limit)      [1] ComputeBudget SetComputeUnitPrice(micro-lamports)      then:
spl-token-2022           [2] ATA CreateIdempotent(payer, dest ATA, dest, mint, System, Token-2022)   only if sol.createAta
                         [n] Token-2022 TransferChecked(source ATA, mint, dest ATA, owner)  amount 1, decimals 0
metaplex-token-metadata  [2] Token Metadata Transfer — discriminator 49, TransferArgs::V1 { amount: 1, authorization_data: None }
metaplex-pnft            [2] the same instruction with owner / destination token records and, if the pNFT has one, its rule set
metaplex-core            [2] Core TransferV1 — discriminator 14, compression_proof: None
```

Account lists follow the official Shank IDLs read on 2026-11-17 (`mpl-token-metadata/idls/token_metadata.json` 1.14.0,
"Transfer", 17 accounts; `mpl-core/idls/mpl_core.json`, "TransferV1", 7 accounts); an absent optional account is the
program's own id. Every address is one of three kinds, and the review shows which:

- **pinned** (constants of the signer bundle): Token Metadata `metaqbxx…x1s`, Token Auth Rules `auth9SigNp…Vmgg`, Core
  `CoREENxT…hX7d`, SPL Token, Token-2022, Associated Token, System, Sysvar Instructions, Compute Budget;
- **derived by the signer**: source and destination associated token accounts, metadata PDA, edition PDA, both token-record
  PDAs;
- **frozen intent fields shown to the owner**: `asset`, `to`, `sol.ruleSet` (pNFT), `sol.collection` (Core).

The recent blockhash is the only other chain-derived input (as for the ordinary Solana send). Compute budget: limit ≤ 400 000
(schema) and ≤ `nft.maxComputeUnits`; price ≤ 5 000 000 µlamports (hard) and ≤ `nft.maxComputeUnitPrice`.

### The independent verifiers

`verifyNftEvmTx` and `verifyNftSolMessage` do not call the builders: one cuts the calldata into 32-byte words, the other
decodes the message bytes with its own strict decoder (every byte consumed; legacy only; one signer; only pinned programs;
the exact instruction list, account order, data and writable set; no unused account). The signer runs them on **its own
output** before the passkey is looked at — a defect of a builder cannot become a signature — and the tests feed them every
forged shape (extra calldata bytes, `approve` / `setApprovalForAll` / `transferFrom`, non-empty data, added instruction,
smuggled SPL `Approve` / `SetAuthority` / Token Metadata `Delegate`, unknown program, reordered / extra / dropped accounts,
another budget, a second signer, a versioned message).

## 4. Who verifies what

| Check | Signer (authority) | API (before the passkey prompt) |
|---|---|---|
| intent shape, unknown fields | **yes** — strict schema | yes |
| key id, network known, chain id / genesis = registry | **yes** | yes (+ `eth_chainId` / `getGenesisHash` on every endpoint) |
| `from` = the wallet's own address | **yes** — derived from its key, never supplied | yes (address from the signer's status) |
| destination ≠ wallet, ≠ contract / program / asset / accounts of the transfer | **yes** | yes, + account kind (EOA / contract; system-owned on Solana) |
| the transaction is exactly the canonical call of the named asset, token id, quantity, destination, nonce / blockhash, fee caps | **yes** — it builds it, then re-reads it | yes (same code) |
| contract is not a registered fungible token | **yes** (its own registry) | yes |
| single use, expiry, approval window, policy versions | **yes** | pre-check |
| halt (an NFT transfer is not a risk reduction) | **yes** | yes |
| NFT policy: standard enabled on the network, ERC-1155 quantity cap, transfers per day, fee ceiling, compute budget, allow-list | **yes** | pre-check |
| passkey assertion over the intent hash (origin, rpId, user verification) | **yes** | — |
| **the wallet owns the token; the standard is what is claimed; the asset is not frozen / locked / listed / delegated** | **no — the signer makes no chain read** | **yes**: ERC-165 on every endpoint + `ownerOf` / `balanceOf ≥ quantity`; Solana accounts re-read on every endpoint and decoded |
| the call does not revert; the receiver accepts the token | no | simulation |

**Ownership and standard are API-established, and that is stated plainly.** Why it is acceptable: the signer's transaction is
the safe-transfer call of the *named* token from *its own* address and nothing else. With a wrong claim (not owned, another
standard, frozen), the transaction reverts or the program refuses it; with a true one it moves exactly what the intent names.
It cannot move a different asset, cannot move more units than the intent says, and cannot grant an approval or a delegation:
those are other selectors / other instructions, which the builder cannot produce and the verifier refuses. The cost of a lie
is a failed transaction's fee, inside the fee ceiling.

## 5. Policy (`packages/core/src/nft-policy.ts`) — key `nft` of the signer's `policy.json`

| Key | Default | Meaning |
|---|---|---|
| `nft.version` | `1` | frozen by every NFT intent as `nftPolicyVersion` |
| `nft.enabled` | the 8 EVM networks → `["erc721","erc1155"]`; `solana` → `["spl-token-2022","metaplex-token-metadata","metaplex-pnft","metaplex-core"]` | per-network switch, per standard; a network that is absent is disabled |
| `nft.maxTransfersPerDay` | `5` | NFT transfers signed per UTC day, all networks together (persisted counter) |
| `nft.maxErc1155Quantity` | `"10"` | units of one ERC-1155 id per transfer |
| `nft.allowlistOnly` | `false` | `true`: only to destinations approved with the passkey (`POST /nft/allow`) |
| `nft.maxComputeUnits` / `nft.maxComputeUnitPrice` | `400000` / `"2000000"` | Solana compute budget ceilings |
| fee ceiling | the existing `maxFee[network]` — unchanged | gas × max fee per gas; signature + priority fee |

**Merge-on-load.** `policy.json` is never rewritten. A file written before this delivery has no `nft` key: the defaults
above apply in memory; a key the file sets wins, one by one; an unknown key refuses to load. The main `version` (4) and every
existing limit and fee ceiling are untouched; the file a new installation writes is byte-identical to before (no `nft` key).
The existing general `allowlist` also applies to NFT destinations when it is non-empty. NFT transfers are counted against no
fund limit and no fund limit counts them.

## 6. The per-standard matrix, as built

| Standard / kind | Transfer | How / why not |
|---|---|---|
| ERC-721 (8 EVM networks) | **supported** | `safeTransferFrom(address,address,uint256)` |
| ERC-1155 (8 EVM networks) | **supported** | `safeTransferFrom(…, bytes "")`, quantity ≥ 1, ≤ held, ≤ policy cap |
| EVM contract declaring neither or both standards, pre-standard contracts (`evm-nonstandard`) | refused | `unsupported_standard` / `non_standard_contract`: the standard is verified, never the selector alone |
| ERC-20 / registered fungible token presented as an NFT | refused | lookup finds no NFT behaviour; builder: `nft_contract_is_fungible_token` |
| Solana Token-2022 NFT | **supported** | `TransferChecked` (+ idempotent ATA creation) — only when every extension is one of: `metadataPointer`, `tokenMetadata`, `groupPointer`, `groupMemberPointer`, `tokenGroup`, `tokenGroupMember`, `mintCloseAuthority`, `immutableOwner` |
| Token-2022 with `nonTransferable` | refused | `soulbound` |
| Token-2022 with `transferHook`, `permanentDelegate`, `transferFeeConfig`, `confidentialTransferMint`, `defaultAccountState`, `pausableConfig`, any other / unknown extension | refused | `token2022_extension_unsupported` |
| Metaplex Token Metadata NFT (legacy, editions) | **supported** | Token Metadata `Transfer` |
| Programmable NFT (pNFT) | **supported**, never as an SPL transfer | Token Metadata `Transfer` with token records + rule set; refused when the token record is `locked` (`pnft_locked`), `listed` (`pnft_listed`) or carries a delegate (`delegated`) |
| Metaplex Core asset | **supported** | `TransferV1`; refused when frozen (asset or collection freeze plugin: `frozen`) or with a transfer delegate set (`delegated`); collection-level permanent delegates are shown as a warning |
| Plain SPL token without metadata (`spl-token`) | refused | `unsupported_standard` |
| Compressed NFT (Bubblegum) | **refused** | `compressed_transfer_not_supported` — see §10 |
| Bitcoin inscription | **refused — no Ordinals transfer** | `ordinals_transfer_not_supported`; ordinary sends are kept away from them (§7) |
| NFT in a token account that is not the wallet's associated account | refused | `source_not_associated_account` (the signer derives the source itself) |
| Frozen token account, delegated token account, burned, in escrow / not owned, ownership unknown or confirmed by one endpoint only | refused | `frozen`, `delegated`, `burned`, `escrow` / `not_in_wallet`, `ownership_unknown`, `ownership_single_source` |
| Standard disabled on the network by the signer's policy | refused | `network_disabled_by_policy` |
| The 13 other families | not supported | no adapter |

## 7. Bitcoin inscription safety (no Ordinals transfer)

The audit of delivery 1 found that ordinary BTC sends could spend an inscription. Three layers now stand in the way:

1. **The signer's lock list** (`state.utxoLocks`, changed only by `POST /utxo/locks` with the passkey — lock *and* unlock).
   `POST /sign` refuses (`utxo_locked`) any intent whose `btc.inputs` names a locked outpoint — ordinary sends and THORChain
   swaps alike, on Bitcoin, Litecoin and Dogecoin (per-network lists). The intent already carried its exact input outpoints.
   With an empty list `sign` is byte-for-byte what it was. Locking works under the emergency halt; unlocking does not.
2. **An ord server** when `NFT_ORDINALS_API_URL` is set (a self-hosted `ord`; `GET /outputs/<address>?type=any`,
   `Accept: application/json`, per docs.ordinals.com/guides/api.html read 2026-11-17 — fields `outpoint`, `value`,
   `inscriptions`, `runes`, `indexed`, `spent`). An output with an inscription or a rune, not indexed, or not listed by ord is
   excluded from coin selection (API), and offered for a signer lock. Server set but unreachable → Bitcoin sends are refused.
3. **Without an ord server, a heuristic — labelled as such, not a detection**: outputs ≤ 10 000 sat, and outputs created by a
   transaction whose bytes contain an inscription envelope (`OP_FALSE OP_IF "ord"`), are flagged "possibly an inscription" and
   excluded from automatic selection until the owner declares the output an ordinary coin (`POST /utxo-locks/review`, per
   output, no passkey — it lifts only a heuristic flag) or locks it. **Deviation from the specification**: the override is per
   output, persisted, not per send. An inscription on a larger output whose creating transaction carries no envelope is not seen.

The coin selection asks one guard (`utxoGuards.excluded`, `services/api/src/chains/btc.ts`) for every Bitcoin-style
preparation; an absent or empty guard leaves the selection identical (tested on the same coins, same change, same fee).
**Behaviour change to know**: on Bitcoin, without an ord server, small outputs (≤ 10 000 sat) are no longer spent
automatically — a send that needs them answers `insufficient_unlocked_funds` until they are reviewed.

Limits, stated: the lock list is not enforced for Bitcoin Cash (another family; its inputs travel in another field); the API
guard and the signer list are two lists — an ord-flagged output is signer-protected only once the owner locked it.

## 8. Refusal codes (stable)

Signer (`SignerError.code`, seen by the API as `signer_<code>`): `bad_request`, `wrong_key`, `wrong_chain`,
`nft_unsupported_family`, `wrong_source`, `self_send`, `replay`, `bad_approval`, `unknown_credential`, `utxo_locked`,
`policy` (list intents); from the policy: `nft_halted`, `nft_policy_version`, `nft_expired`, `nft_window`,
`nft_network_disabled`, `nft_bad_quantity`, `nft_quantity_cap`, `nft_daily_count`, `nft_fee_cap`, `nft_compute_cap`,
`nft_not_allowlisted`; from the builders / verifiers: `nft_wrong_chain`, `nft_section_mismatch`,
`nft_standard_network_mismatch`, `nft_bad_contract`, `nft_bad_source`, `nft_bad_destination`, `nft_bad_asset`,
`nft_bad_rule_set`, `nft_bad_collection`, `nft_program_mismatch`, `nft_contract_is_fungible_token`,
`nft_destination_is_contract_itself`, `nft_self_send`, `nft_bad_token_id`, `nft_gas_cap`, `nft_fee_exceeds_max`,
`nft_bad_nonce`, `nft_bad_blockhash`, `nft_tx_unknown_field`, `nft_tx_type`, `nft_tx_value`, `nft_contract_substituted`,
`nft_calldata`, `nft_calldata_length`, `nft_selector`, `nft_token_id_substituted`, `nft_destination_substituted`,
`nft_quantity_substituted`, `nft_data_not_empty`, `nft_message_malformed`, `nft_message_versioned`, `nft_extra_signer`,
`nft_unknown_program`, `nft_instruction_count`, `nft_instruction_program`, `nft_instruction_accounts`,
`nft_instruction_data`, `nft_extra_account`, `nft_account_flags`.

API (`nft_transfer_<code>`, 422 unless said): the block reasons of §6, and `bad_destination` (400),
`destination_is_wallet`, `destination_is_contract_itself`, `not_a_contract`, `contract_is_fungible_token`,
`non_standard_contract`, `standard_changed`, `state_changed`, `not_owned`, `insufficient_quantity`, `bad_quantity`,
`simulation_reverted`, `simulation_failed`, `simulation_unexpected`, `gas_too_high`, `fee_above_policy`,
`policy_<signer policy code>`, `rpc_identity` (503), `rpc_disagreement` (503), `signer_too_old` (503); plus the existing
`pending_tx` (409), `halted` (423), `insufficient_gas`, `idempotency_mismatch` (409), `expired` (410). Bitcoin:
`insufficient_unlocked_funds`, `ord_unavailable` (503), `ord_bad_answer` (502).

## 9. On-disk compatibility and rollback

- `state.json` gains three **optional** fields: `nftDaily` (count per UTC day, kept 3 days), `nftAllow`, `utxoLocks`. A state
  written before loads unchanged. NFT intents and list requests use the existing `used` replay map.
- `policy.json` is not rewritten (§5).
- **Rolling the signer back to the previous binary** (rehearsed: `scripts/rollback-nft-signer-rehearsal.mts`): it opens the
  state and keeps the three fields on disk; it has no NFT route (an NFT intent is `bad_request` on `/sign`); **it does not
  know the lock list and signs a send that spends a locked outpoint**; it refuses to start on a `policy.json` that carries an
  `nft` key. Therefore, before rolling back: (1) **remove the `nft` key from `policy.json`** if the operator added one;
  (2) **do not send BTC while inscription-bearing outputs sit on the address** (the API guard still excludes ord-flagged and
  heuristically flagged outputs if the API is not rolled back, but nothing is signer-enforced). Rolling forward again needs
  nothing: locks, allow-list and the day's count are in force again.

## 10. What was not built, and what is missing

- **Compressed NFTs**: a transfer needs `getAssetProof` verified against the on-chain merkle tree (Bubblegum `Transfer` with
  root, data hash, creator hash, nonce, index and the proof path). Not built: this wallet has no decoder of the
  `ConcurrentMerkleTree` account (header, change log, canopy) against which to check the indexer's root and proof, nor the
  leaf-schema hashing to tie the proof to *this* asset; the Bubblegum, Account Compression and Noop programs are not pinned.
  Signing an indexer-supplied proof unverified would be signing opaque data. Reason shown: `compressed_transfer_not_supported`.
- **Ordinals transfer**: not in this delivery by decision. Inscriptions are neither listed nor transferable.
- `transferFrom`, approvals, operator approvals, batch transfers, burn, any market action: not offered.
- Solana API-level unit tests of the *preparation* path replay only the per-asset verdicts; the full Solana preparation is
  exercised by the local-validator proof, not by `pnpm test`.

## 11. Threat analysis

| Threat | What happens |
|---|---|
| **Metadata spoofing** — an NFT named like a blue-chip, with its artwork | The review sheet, the passkey summary and the tracking screen are built from the server's review of the intent: network, standard, contract / mint, token id, quantity, program, destination, fees — in full. The creator's name and image are small, below, labelled « métadonnée du créateur, non vérifiée », and are never an input of anything. The hash on screen is the passkey challenge. |
| **Token id / contract / destination / network / quantity substituted between preview and signature** | All are intent fields: any change changes the hash, the assertion no longer verifies (`bad_approval`) — tested for each field individually in the signer and end to end on the forks (database tampering after the review). |
| **Added instructions, hidden approvals** | The request has no place for bytes. The signer builds the instruction list / calldata; its verifier refuses any other list, selector, program or account. `approve`, `setApprovalForAll`, SPL `Approve`, `SetAuthority`, Token Metadata `Delegate` cannot be produced. The ERC-1155 `data` is always empty. |
| **Replay** | proposal id single use (shared replay map with fund intents, persisted before signing); EVM nonce; Solana blockhash lifetime. |
| **Expiry** | window ≤ `maxApprovalTtlSec` (300 s), checked at signing time; the API prepares 180 s (EVM) / 50 s (Solana). |
| **Halt** | refuses every NFT transfer, every allow-list addition, every unlock; locks and removals stay possible. |
| **Fee abuse** | gas limit ≤ 500 000 and gas × max fee ≤ intent cap ≤ existing policy ceiling; Solana fee ≤ intent cap ≤ ceiling, compute budget bounded twice. Rent of created Solana accounts (≈ 0.002 SOL per token account) is **not** a fee and is not capped by the signer: it is shown, and bounded by what the fixed instruction list can create (one associated token account, one token record). |
| **A compromised API holding the HMAC secret** | Without a passkey: nothing — the three NFT routes all require a fresh assertion; **no passkey-less path was added**. Waiting for a real approval and swapping the intent before the prompt (the residual risk of the ADR) is bounded here by: one NFT (or ≤ `maxErc1155Quantity` units) per approval, ≤ `maxTransfersPerDay` approvals a day, only safe-transfer of a named token, never an approval. It cannot make the signer sign: another selector, calldata, an instruction list, an unlock, an allow-list addition. It can lie about ownership (the transaction then fails), refuse service, or show a false review — see residual risks. |
| **Lock list tampering** | unlock requires the passkey over the exact outpoints; an API cannot unlock, nor lock at will. |
| **RPC lying about ownership / state** | every deciding read on every endpoint; disagreement or a single answer → nothing prepared. Both endpoints colluding → a transaction that fails, or the transfer the owner approved. |
| **Receiver that cannot handle the token** | safe transfers only; contract recipients are flagged and the call is simulated from the wallet: a revert is shown instead of a passkey prompt. |
| **Addresses that carry code** | found while proving: well-known test addresses carry code on mainnet today (EIP-7702 delegations) — they are treated as contracts and the simulation decides. |

### Residual risks

- **The review screen is rendered by the web app** (ADR residual risk, unchanged): a compromised API / web can show one NFT
  and have the passkey sign the hash of another transfer of an NFT the wallet holds. Loss is bounded by the NFT policy —
  which for a valuable NFT is *not* a small bound: **one wrongly approved NFT transfer is one NFT, irreversibly.** Allow-list
  mode (`nft.allowlistOnly`) reduces it to destinations the owner approved earlier.
- Ownership, standard and asset state are API-established (§4).
- pNFT rule sets are evaluated by the on-chain program at execution; the simulation is the only preview.
- Collection-level permanent delegates (Core) and mutable metadata are facts shown, not prevented.
- The heuristic of §7 is not a detection; without an ord server an inscription on a large output is invisible.
- Solana rent of created accounts is not signer-capped (bounded by construction, shown in the review).
- Never executed on a real network; no independent review of the new signer code.
