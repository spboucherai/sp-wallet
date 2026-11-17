# NFT delivery 2 — work note (branch `nft-2`, from `nft` @ `7bf3e68`, 2026-11-17)

Scope: `NFT-BRIEF.md` §17 delivery 2 — receive and **secure transfer** of NFTs, and the Bitcoin inscription safety the audit
of delivery 1 asked for. Design as built: `docs/nft/NFT-TRANSFERS.md`. **No production node was contacted, no real key was
used, nothing was signed for or broadcast to a real network.** Every proof below ran on unit tests with the real signer
code, on local anvil forks of Ethereum, on a local Solana validator, or in a browser against those. A fork or a local
validator is not a mainnet execution. Delivery 3 (market) and delivery 4 (other chains) are **not** started; the brief's
definition of done is **not** fully met (see §8).

## 1. Items

| # | Item | Initial state (branch `nft`) | Change | Tests | Observed | Limitation |
|---|---|---|---|---|---|---|
| A | Design note | — | `docs/nft/NFT-TRANSFERS.md` (flow, the three canonical objects, frozen fields, who verifies what, policy, per-standard matrix, refusal codes, rollback, threats, residual risks) | — | kept in step with the code as it was built | — |
| B | EVM transfers | no NFT transfer; `capabilities.transferable: false` everywhere with `transfer_not_built` | `packages/core/src/nft-evm.ts`: `safeTransferFrom` ERC-721 (100 bytes) and ERC-1155 with empty data (196 bytes); independent verifier; API `prepareEvm` (ERC-165 + behaviour on both endpoints, ownership, destination kind, nonce, fees inside the existing ceiling, `eth_call` from the wallet, gas) | `nft-intent.test.ts`, signer `nft.test.ts`, `nft-transfer.test.ts` | both fork proofs pass end to end (§5) | no `transferFrom`, no approval, no batch; EVM approvals are still not read |
| C | Solana transfers | same | `packages/core/src/nft-sol.ts`: legacy message built by the signer — Token-2022 `TransferChecked` (+ idempotent ATA), Token Metadata `Transfer` (legacy and pNFT with token records + rule set), Core `TransferV1`; pinned programs; independent verifier; API `prepareSol` (accounts re-read on every endpoint and decoded, destination, budget from a first simulation, account changes from the simulation) | same files; cross-check with `@solana/kit` | the four standards execute on a local validator with the real mainnet programs (§5); fee + rent announced = lamports actually spent | **compressed NFTs not transferable** (`compressed_transfer_not_supported`, `NFT-TRANSFERS.md` §10); plain SPL tokens refused; a pNFT / legacy NFT in a non-associated token account refused; the Solana *preparation* path has no test in `pnpm test` (verdicts only) |
| D | Bitcoin inscription safety | largest-first coin selection, nothing knows inscriptions (threat row 31 open) | signer lock list + `utxo_locked` on `sign`; `services/api/src/nft/utxo.ts`: ord adapter (`NFT_ORDINALS_API_URL`), heuristic, coin-selection guard installed in `chains/btc.ts`; lock / unlock / review routes; screen | signer `nft.test.ts` (5 tests), `nft-transfer.test.ts` (4 tests), `nft-send.spec.ts` | an ordinary send cannot select (API) nor sign (signer) a locked output; with no flag the selection is identical; previous and new signer sign the same bytes for the same BTC intent (§4) | **no Ordinals transfer, no inscription listed**; the ord adapter is tested on the documented JSON only, never against a running `ord`; heuristic ≠ detection; per-output review instead of the per-send override of the specification; BCH not covered |
| E | Policy and signer | `PolicySchema` strict, no NFT notion; 7 passkey-less paths | optional `nft` policy section with merge-on-load; `services/isolated-signer/src/nft.ts` (3 passkey routes); state fields `nftDaily`, `nftAllow`, `utxoLocks`; journal `nft.sign.*`, `utxo.locks.*`, `nft.allow.*` | signer `nft.test.ts` (28), `nft-intent.test.ts` (32) | every listed refusal has its own test and code; regression pins hold; rollback rehearsal as documented (§4) | the signer verifies neither ownership nor standard (no chain read) — stated in the ADR and the design note |
| F | API | read-only NFT module | `nft/transfer.ts`, `transfer-routes.ts`, `arrivals.ts`, `utxo.ts`; NFT proposals on the existing lifecycle (`proposals.kind = 'nft'`, column `nft`), outcome hook in the reconcile loop, per-asset verdict on the item route, EVM arrival scan, allow-list routes | `nft-transfer.test.ts` (23) | `not_broadcast` honoured; confirmed only at finality; activity and inventory follow the proposal | arrival scan covers contracts the wallet already knows, from a cursor, in bounded steps (a gap after a long stop is recorded, not hidden); no read equivalents under the trading API |
| G | Web | Send disabled with "not built" | `screens/NftSend.tsx` (Send flow, protected outputs), item page (enabled Send or exact reasons), receive (warnings, lock list), FR / EN texts | `apps/web/test/nft.test.ts` (+5), `nft-send.spec.ts` (4) | first chunk unchanged (§6) | the passkey prompt itself is the system's: the on-chain summary is shown on the page while it is open, not inside it |
| H | Proofs | — | `scripts/fork-nft-erc721.mts`, `fork-nft-erc1155.mts`, `validator-nft-solana.mts`, `rollback-nft-signer-rehearsal.mts`, `tests/e2e/nft-send-server.mts` + spec | — | §4, §5 | §5 says what each one does not establish |
| I | Docs | — | `NFT-TRANSFERS.md`, threat-model rows 31 (revised) and 32–36, ADR 0001, `NFT-AUDIT.md` (transfer column, §4 status), README, `NFT-RUNBOOK.md`, `deploy.md`, `NFT-SOURCES.md` §9, `nft.env.example`, this note | — | — | — |

## 2. The per-standard transfer matrix, as built

`NFT-TRANSFERS.md` §6 is the reference. Supported: ERC-721, ERC-1155 (8 EVM networks); Solana Token-2022 NFT (accounted-for
extensions only), Token Metadata NFT, programmable NFT (unlocked, undelegated), Core asset (not frozen, no transfer delegate).
Refused with a factual reason: non-standard / dual-standard EVM contracts, fungible tokens, Token-2022 with
`nonTransferable` (`soulbound`) or any other extension (`token2022_extension_unsupported`), locked / listed / delegated
pNFTs, frozen or delegated accounts and assets, plain SPL tokens, compressed NFTs, Bitcoin inscriptions, assets not held or
whose ownership one endpoint alone reports, standards the signer's policy disables.

## 3. SIGNER BEHAVIOUR CHANGES — for human review

Files: `services/isolated-signer/src/{nft.ts (new), signer.ts, server.ts, store.ts}`, `packages/core/src/{nft-intent.ts,
nft-evm.ts, nft-sol.ts, nft-policy.ts (new), policy.ts, index.ts}`. `intent.ts`, `build-evm.ts`, `build-sol.ts`,
`build-btc.ts`, every plugin and every venue file are unchanged.

1. **`POST /sign` (existing route) — one added refusal.** After the replay check and before everything else: if the intent
   carries a `btc` section and one of its inputs is on the lock list of its network, refuse with `utxo_locked` (journaled as
   `sign.denied`). With an empty list nothing changes: same bytes as the previous signer for the same intent (rehearsal Part A;
   pinned txid `4e8f6359…44de`). Applies to ordinary sends and THORChain swaps on Bitcoin, Litecoin, Dogecoin.
2. **`POST /nft/sign` (new) — passkey required.** Parses a strict `NftIntent`; checks key id, network, chain id, family
   (EVM / Solana only), `from` = own address, `to` ≠ own, single use; `checkNftPolicy` (halt, both policy versions, expiry,
   window, standard enabled on the network, quantity, ERC-1155 cap, daily count, fee ceiling, compute budget, allow-lists);
   builds the transaction (`buildNftEvmTx` / `buildNftSolMessage`), re-reads it (`verifyNftEvmTx` / `verifyNftSolMessage`);
   verifies the WebAuthn assertion against `nftIntentHash`; persists `used[proposalId]` and `nftDaily[day] += 1`; signs
   with the wallet's EVM key or Solana key; journals `nft.sign.ok` (ids, hash, asset, token id, quantity, program,
   destination, txid — no secret, no assertion, no raw transaction). The key itself is used in `signer.ts` only (two closures
   handed to `nft.ts`; the source-scan test of `venue-collateral.test.ts` still lists the same four files).
3. **`POST /utxo/locks` (new) — passkey required for lock AND unlock.** Strict `UtxoLockIntent`; Bitcoin-style networks
   only; lock allowed under halt, unlock refused under halt; at most 2 000 outpoints per network; journals `utxo.locks.ok`.
4. **`POST /nft/allow` (new) — passkey required for add AND remove.** Adding refused under halt; never the wallet itself.
5. **`GET /status` — two added fields**: `nft` (effective NFT policy, today's count, allow-list) and `utxoLocks`.
6. **Policy load**: `PolicySchema` accepts an optional `nft` object (strict inside). No file is written; the default file of
   a new installation is byte-identical to before. `effectiveNftPolicy` fills missing keys in memory.
7. **State**: three optional fields (`nftDaily` pruned after 3 days, `nftAllow`, `utxoLocks` never pruned).
8. **No passkey-less path added**; the seven of the ADR are unchanged. No "sign these bytes" route. Halt blocks NFT transfers.
9. **Not changed**: fund limits, fee ceilings, `DEFAULT_POLICY` (hash pinned), the canonical bytes of every existing intent
   kind (10 vectors pinned), the HMAC transport.

## 4. Regression and rollback — observed

`npx tsx scripts/rollback-nft-signer-rehearsal.mts <checkout of branch nft @ 7bf3e68>`:

```
previous release: <checkout of branch nft @ 7bf3e68>
  as documented  same key id from both versions: "spw-12b9580a419e1e2d"
Part A — an ordinary BTC send with an empty lock list: both versions sign the same bytes
  as documented  raw transaction of this version = raw transaction of the previous version: true
  as documented  txid: "4e8f6359e2ff07e6317f52617b64161db6efeadde0c7ca014f74258b0f0144de"
      txid 4e8f6359e2ff07e6317f52617b64161db6efeadde0c7ca014f74258b0f0144de   sha256(raw) ffadc066af7bc6b930ccb1a4360137fb606903b4593657d3deee7d92b304b0f9   (pinned in services/isolated-signer/test/nft.test.ts)
  as documented  policy.json written by a new installation is byte-identical in both versions: "d6312bb11301e8611fc235ac78e140d2bf57b1b25e291aa557ff8463cc73a6a0"
Part B — state written by this version, opened by the previous one, then by this one again
  as documented  this version refuses to spend the locked outpoint: "utxo_locked"
  as documented  state written by this version — new optional fields: ["nftAllow","nftDaily","utxoLocks"]
  as documented  the previous code opens the state and the policy written by this version: true
  as documented  previous code: credentials, halt and replay markers are the ones this version saved: [1,false,3]
  as documented  previous code: an NFT intent is not something it signs (no route, and `sign` refuses it): "bad_request"
  as documented  previous code: it DOES sign a send that spends the outpoint this version locked (it does not know the list): "SIGNED"
  as documented  the new fields are still on disk after the previous code saved: [{"bitcoin":{"abababababababababababababababababababababababababababababababab:0":{"reason":"owner","at":1800000000}}},{"ethereum:0x70997970C51812dc3A010C7d01b50e0d17dc79C8":{"at" […]
  as documented  forward again: journal intact: null
  as documented  forward again: the lock, the allowed destination and the day's count are in force again: [{"bitcoin":[{"outpoint":"abababababababababababababababababababababababababababababababab:0","reason":"owner","at":1800000000}]},1,1]
  as documented  forward again: the locked outpoint is refused again: "utxo_locked"
  as documented  forward again: the journal head moved on from the one this version left: true
Part C — policy.json across the rollback
  as documented  the file this version writes has no NFT key: false
  as documented  the previous code reads it: "opened"
  as documented  this version reads a file to which the operator added `nft`: 2
  as documented  the previous code REFUSES TO START on a policy.json that carries an `nft` key (remove the key before rolling back): true
every observation is as documented
```

## 5. Proofs — what was run, real output, what each establishes

### 5.1 `scripts/fork-nft-erc721.mts` — anvil fork of Ethereum mainnet (BAYC, holders read at run time)

```
fork: BAYC #1 moved from its current holder 0x46EFbAedc92067E6d60E84ED6395099723252496 to the test wallet 0x39C697804DBAaB27a34198b9e9b6e9b71f8D02B8
fork: BAYC #2 moved from its current holder 0xc5c7b46843014B1591e9aF24de797156cde67f08 to the test wallet 0x39C697804DBAaB27a34198b9e9b6e9b71f8D02B8
verdict of evm:ethereum:0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d/1: transferable=true route="safeTransferFrom(address,address,uint256)" blockedBy=[]
review: erc721 · safeTransferFrom(address,address,uint256) · contract 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D · token id 1 · quantity 1 · to 0xEd651a516F00b95dc18444efd077b9E8136cbC5e (account) · network Ethereum · fee ≤ 242872176943854 wei
        verified: ERC-165: ERC-721 declared, and ownerOf answers; ownerOf(1) = this wallet (on 2 endpoints); simulation: eth_call from the wallet address succeeded, gas 137247
        creator metadata (unverified): name=null
signed transaction: to 0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d value 0 safeTransferFrom(0x39C697804DBAaB27a34198b9e9b6e9b71f8D02B8, 0xEd651a516F00b95dc18444efd077b9E8136cbC5e, 1) — 100 bytes of calldata
SENT: finalized, tx 0xd5a9a65f659b32197fc5f9d59f2e1ae43561f04fb13828922f0a5922e8269a9e; ownerOf(1) on the fork = 0xEd651a516F00b95dc18444efd077b9E8136cbC5e (the destination)
inventory after finality: inWallet=false state=not_in_wallet blockedBy=[not_in_wallet]; activity: transfer-out/finalized
refused — token no longer held: 422 nft_transfer_not_in_wallet — this NFT cannot be sent: not_in_wallet
refused — token of another holder: 422 nft_transfer_not_in_wallet
refused — contract recipient without onERC721Received (WETH): 422 nft_transfer_simulation_reverted — the transfer would revert: no reason given — the destination is a contract and does not accept this token (it must implement the receiver interface)
refused — an address that carries code on mainnet (0x70997970C51812dc3A010C7d01b50e0d17dc79C8): 422 nft_transfer_simulation_reverted (toKind=contract)
refused — destination 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D: 422 nft_transfer_destination_is_contract_itself
refused — destination 0x39C697804DBAaB27a34198b9e9b6e9b71f8D02B8: 422 nft_transfer_destination_is_wallet
refused — destination 0x0000000000000000000000000000000000000000: 400 nft_transfer_bad_destination
refused — ERC-20 (USDC) presented as an NFT: 404 nft_not_found
refused — intent tampered after the review (token id 2 → 4): 422 signer_bad_approval — approval verification failed: Unexpected authentication response challenge "NjY4GDD8cCXgT4jUfVlsgAgrx1Ssf_guBZeJbgNBlkQ", expected "6vflhtLU8EQ8AUo27xyDTleLhzu44Wovdyj2OOlly […]
refused — intent tampered after the review (destination → another address): 422 signer_bad_approval — approval verification failed: Unexpected authentication response challenge "3GYO6g04DsGGV6sN1sug9TZzbEsLmpHknkj85cHXMAc", expected "Xj2Tjb4T3xx_1c39WEQbqN7VId […]
idempotency: same key → same proposal; same key + another request → 409; the ordinary approval route refuses an NFT proposal (409)
refused — signer halted: 423 halted
refused — approval of an already prepared transfer under halt: 422 signer_nft_halted
signer journal: nft.sign.ok, nft.sign.denied(bad_approval), nft.sign.denied(bad_approval), nft.sign.denied(nft_halted)
NFT ERC-721 FORK PROOF OK (Ethereum fork; nothing was sent to a real network)
```

Establishes: the 100-byte `safeTransferFrom` the signer builds is accepted by the real contract and moves exactly the named
token; the API refuses, before any passkey prompt, a token no longer held, a contract recipient without the receiver hook, an
address that carries code, the contract / wallet / zero address, an ERC-20; the signer refuses an intent changed after the
review; idempotency; halt. **Does not establish**: anything on mainnet (fees, inclusion, reorgs); other collections' code.

### 5.2 `scripts/fork-nft-erc1155.mts` — anvil fork of Ethereum mainnet (OpenSea Shared Storefront, subject found from recent logs)

```
subject found on the fork: token id 48631710385344171559950823287695335513389218959905640756536059734575577825281, current holder 0x62e3a8216Abdbd2e4a84Be700905F4BA02FD8A4E holds 1 unit(s)
fork: 1 unit handed to the test wallet 0xCcb59721dba1a82daD7A84b5CEf12642d2eB0aC3
item: standard erc1155, quantity held 1, transferable=true, warnings=[semi_fungible]
refused — quantity 2 when 1 is held: 422 nft_transfer_insufficient_quantity — this wallet holds 1 unit(s) of this token id, fewer than the 2 asked
refused — contract recipient without onERC1155Received (WETH): 422 nft_transfer_simulation_reverted — the transfer would revert: no reason given — the destination is a contract and does not accept this token (it must implement the receiver interface)
refused — intent tampered after the review (quantity 1 → 5): 422 signer_bad_approval
refused — intent tampered after the review (token id → another id): 422 signer_bad_approval
broadcast disabled: state not_broadcast, error code broadcast_disabled, explorer link null; balance of the wallet still 1
review: erc1155 · safeTransferFrom(address,address,uint256,uint256,bytes) — data empty · contract 0x495f947276749Ce646f68AC8c248420045cb7b5e · token id 48631710385344171559950823287695335513389218959905640756536059734575577825281 · quantity 1 · to 0xe86836709E […]
        verified: ERC-165: ERC-1155 declared, and balanceOf answers; balanceOf(this wallet, 48631710385344171559950823287695335513389218959905640756536059734575577825281) = 1; simulation gas 57162
signed transaction: to 0x495f947276749ce646f68ac8c248420045cb7b5e value 0 safeTransferFrom(0xCcb59721dba1a82daD7A84b5CEf12642d2eB0aC3, 0xe86836709EDeF15980A305043119d7a1d6C3734A, 48631710385344171559950823287695335513389218959905640756536059734575577825281, 1, […]
SENT: finalized, tx 0x9461c306de5dd97e3feaf00bda87ac97e599774b938387b80b20ad0d80e7163a; balanceOf(wallet) = 0, balanceOf(destination) = 1
inventory after finality: quantity 0, inWallet=false, blockedBy=[not_in_wallet]
isApprovedForAll(wallet, destination) = false: the transfer granted no approval
signer journal: nft.sign.denied(bad_approval), nft.sign.denied(bad_approval), nft.sign.ok, nft.sign.ok
NFT ERC-1155 FORK PROOF OK (Ethereum fork; nothing was sent to a real network)
```

Establishes: the 196-byte call with empty data moves the named quantity; `not_broadcast` with broadcasting off (signed, not
relayed, nothing moves, no explorer link); quantity above the balance and tampered quantity / token id refused; no operator
approval exists afterwards. **Does not establish**: quantities above 1 on a real collection (the subject held 1 unit;
quantities > 1 are covered by the unit tests); anything on mainnet.

### 5.3 `scripts/validator-nft-solana.mts` — local `solana-test-validator` 4.4.1 with the real programs cloned from mainnet

`solana-test-validator` was not installed on this machine; the Agave 4.4.1 release archive was unpacked in a scratch
directory (`/tmp`, not installed) and passed through `SOLANA_TEST_VALIDATOR`.

```
test wallet (throw-away key): 2j6VreoK5494awVZdjgBo2caJEoKvRMdjXxSXXHjQh9F
Core: CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j (mainnet owner 62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS) in collection phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC — copied with owner = test wallet
Core (frozen variant): asset 4afxJMv4i6nRWvfdvyUVAu6kGgdTbA4E3tQxDKajP2ur in a copy of the collection 8SZsT9DAqThTVcAJsQGa42NkywcwLhE62hcGWyWzGFbi whose PermanentFreezeDelegate is frozen
pNFT: mint 13UdyeAQQk4sHLtJQUHgDLt13HkZBYC2QWSHGAALDnWo, rule set eBJLFYPxJmMGKuFwpDWkzxZeUrad92kZRC5BJLpzyT9 — token account re-created at FPWQYbN7ZotLDLQjjX8qWJVAnWBMDYzqWhP8eeKtCtjz (owner = test wallet, token record unlocked)
pNFT: mint 13WkThbjPM5PVaLdryYPLVQt4NURzAFzJNu6k6maJbMd, rule set eBJLFYPxJmMGKuFwpDWkzxZeUrad92kZRC5BJLpzyT9 — token account re-created at 7BrMhSLcFJpSs6w1TdRFRSzw58BZSLVnCp1widdGhB6C (owner = test wallet, token record LOCKED)
legacy: mint J2U6QmgcuFAEdgF8XaK9t1PKidJ7QVYeSCdmYGybUzYo — token account re-created at G8XKssQJF3mEHdCVkNvz2WEJ5tKjBnLHduA4acCzSP6F (owner = test wallet)
Token-2022: mint 1RwLsj9guunjNRQV8fDq1a8S3keE2XgMFmHRUaS2mHM — token account re-created at 7fe2RAfHnCUggkQaKpnX4CQPpijpk2DR8b6eeYw4ZGjs (owner = test wallet)
local validator 4.4.1 up, genesis 9n2rv1TLA6JcxjT11sCh2KyUVUpqGeaY1YYJSvAiCr94; programs cloned from mainnet and executable: Token Metadata, Token Auth Rules, Core
METAPLEX CORE — TransferV1 of the reference asset
  review: metaplex-core · Core TransferV1 (no compression proof) · asset CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j · program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d · quantity 1 · to HWikn1arQJrVW5oi7SndSmM2KoWSqKFVEWKRvSCQvYX5 (new_account) · fee 5101 […]
  verified: Core asset account: owner = this wallet, not frozen; simulation: 7801 compute units; changes: owner of the asset: 2j6VreoK5494awVZdjgBo2caJEoKvRMdjXxSXXHjQh9F → HWikn1arQJrVW5oi7SndSmM2KoWSqKFVEWKRvSCQvYX5 | SOL of the wallet (lamports), fee and re […]
  accounts of the instruction: asset=CMhGwG…(intent), collection=phygZD…(intent), payer and authority=2j6Vre…(derived), new owner=HWikn1…(intent), program=CoREEN…(pinned)
  SENT: finalized, signature 4zuwNQtKGbyaiv2oGy5yzjRUgF4cB6d1mRhdUdKTvK3mYddtH8WxY8Fp2eHRcxHHkYxmxnzXv3okYsUWGsDSifKh
  on the local chain after finality: asset owner = HWikn1arQJrVW5oi7SndSmM2KoWSqKFVEWKRvSCQvYX5; SOL spent by the wallet 5101 lamports (review said fee 5101 + rent 0 = 5101)
  inventory after finality: inWallet=false, blockedBy=[not_in_wallet]
PROGRAMMABLE NFT — Token Metadata Transfer with token records and rule set
  review: metaplex-pnft · Token Metadata Transfer (TransferArgs::V1, amount 1, no authorization data) with token records · asset 13UdyeAQQk4sHLtJQUHgDLt13HkZBYC2QWSHGAALDnWo · program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s · quantity 1 · to FsbaX2b19z26bu […]
  verified: token account: owner = this wallet, amount 1; token record: unlocked, no delegate; simulation: 101801 compute units; changes: units in the wallet's token account: 1 → 0 | units in the destination's token account (owner FsbaX2b19z26buzYJqtJ9uGY5mTJr […]
  accounts of the instruction: source token account=FPWQYb…(derived), destination token account=3wF6gz…(derived), destination owner=FsbaX2…(intent), mint=13Udye…(intent), metadata=ARxzZY…(derived), edition=F6heAj…(derived), owner token record=DnkPiU…(derived), […]
  SENT: finalized, signature 3d2gBXE2zdaBp3p1KgBSRrqbR4g8ZhxsgMvYHezbqz64zBvE13h2mktRjxKcJLfgWRTJNCPH3iPiGp7gW6JWqbt5
  on the local chain after finality: destination token account owner = FsbaX2b19z26buzYJqtJ9uGY5mTJrKG75R18CEAy8Qpr, amount 1, no delegate; wallet's token account amount 0; destination token record: unlocked, delegate none; SOL spent by the wallet 2044994 lamp […]
  inventory after finality: inWallet=false, blockedBy=[not_in_wallet]
LEGACY TOKEN METADATA NFT — Token Metadata Transfer
  review: metaplex-token-metadata · Token Metadata Transfer (TransferArgs::V1, amount 1, no authorization data) · asset J2U6QmgcuFAEdgF8XaK9t1PKidJ7QVYeSCdmYGybUzYo · program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s · quantity 1 · to 8KqdDz4P7cNf1kKBspphBGC […]
  verified: token account: owner = this wallet, amount 1, not frozen, no delegate; simulation: 52273 compute units; changes: units in the wallet's token account: 1 → 0 | units in the destination's token account (owner 8KqdDz4P7cNf1kKBspphBGCwVMiarH9TwiXFdpMEYs […]
  accounts of the instruction: source token account=G8XKss…(derived), destination token account=HKjuch…(derived), destination owner=8KqdDz…(intent), mint=J2U6Qm…(intent), metadata=3SiprG…(derived), edition=JrviKD…(derived), authority and payer=2j6Vre…(derived) […]
  SENT: finalized, signature 3m2d2BxHL1PtvVtDwQgKrEMdv6jP6W9r2aa64Piupg9w137tFfKo7C1pFNpk2oZxXq6qopimKVXWxwMpdPfC1peL
  on the local chain after finality: destination token account owner = 8KqdDz4P7cNf1kKBspphBGCwVMiarH9TwiXFdpMEYshR, amount 1, no delegate; wallet's token account amount 0; SOL spent by the wallet 2044672 lamports (review said fee 5392 + rent 2039280 = 2044672 […]
  inventory after finality: inWallet=false, blockedBy=[not_in_wallet]
TOKEN-2022 NFT — CreateIdempotent + TransferChecked
  review: spl-token-2022 · Token-2022 TransferChecked (amount 1, decimals 0) · asset 1RwLsj9guunjNRQV8fDq1a8S3keE2XgMFmHRUaS2mHM · program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb · quantity 1 · to FFbyd8NGp2Xqp6LtuVR6uG1Xq21nKb8d46rYE9N8quvE (new_account)  […]
  verified: token account: owner = this wallet, amount 1, not frozen, no delegate; simulation: 21676 compute units; changes: units in the wallet's token account: 1 → 0 | units in the destination's token account (owner FFbyd8NGp2Xqp6LtuVR6uG1Xq21nKb8d46rYE9N8qu […]
  accounts of the instruction: source token account=7fe2RA…(derived), mint=1RwLsj…(intent), destination token account=2LaPfF…(derived), owner=2j6Vre…(derived), destination owner=FFbyd8…(intent), program=Tokenz…(pinned)
  SENT: finalized, signature 3FLLZpYbnMBe6wgQ2NVEv1tzfQid28FPpRANJKUTLLSjhXpviHEc1oYf3bAtHutFsnZcKN9K238DL7hika4HjACR
  on the local chain after finality: destination token account owner = FFbyd8NGp2Xqp6LtuVR6uG1Xq21nKb8d46rYE9N8quvE, amount 1, no delegate; wallet's token account amount 0; SOL spent by the wallet 2079272 lamports (review said fee 5192 + rent 2074080 = 2079272 […]
  inventory after finality: inWallet=false, blockedBy=[not_in_wallet]
REFUSALS
  locked pNFT 13WkThbjPM5PVaLdryYPLVQt4NURzAFzJNu6k6maJbMd: item page says blockedBy=[pnft_locked]; prepare → 422 nft_transfer_pnft_locked — this NFT cannot be sent: pnft_locked
    what the Token Metadata program itself answers to the same transfer (simulation, bypassing the API): {"InstructionError":[2,{"Custom":155}]} — Program log: Token is locked
  frozen Core asset 4afxJMv4i6nRWvfdvyUVAu6kGgdTbA4E3tQxDKajP2ur: item page says blockedBy=[frozen]; prepare → 422 nft_transfer_frozen — this NFT cannot be sent: frozen
    what the Core program itself answers to the same transfer: {"InstructionError":[2,{"Custom":9}]} — Program log: Error: Custom program error: 0x9
  asset that already left the wallet: 422 nft_transfer_not_in_wallet
signer journal: nft.sign.ok(metaplex-core), nft.sign.ok(metaplex-pnft), nft.sign.ok(metaplex-token-metadata), nft.sign.ok(spl-token-2022)
NFT SOLANA LOCAL-VALIDATOR PROOF OK (local validator with mainnet programs and copied accounts; nothing was sent to a real network)
```

Establishes: for Core, pNFT (with its rule set evaluated by the real Token Auth Rules program), legacy Token Metadata and
Token-2022, the instruction list the signer builds is executed by the real program code, ends with the destination as owner,
leaves no delegate, and costs exactly the fee + rent the review announced; the API's `pnft_locked` and `frozen` verdicts
match what the programs themselves answer. **Does not establish**: mainnet execution; that the wallet could own those
particular assets (their accounts were copied with the owner rewritten — no mainnet key allows that); behaviour of other
rule sets or of Token-2022 mints with other extensions (refused by design); the cluster identity check (the registry's
genesis hash was replaced by the local validator's for that process).

While the builders were written, the Core and pNFT messages were also simulated on mainnet (`simulateTransaction`,
`sigVerify: false`, the real holder standing in as `from`): both returned no error (Core 7 801 compute units, pNFT 156 396).
Those two ad-hoc runs are not a committed script.

### 5.4 `tests/e2e/nft-send.spec.ts` — real browser, real API + signer process, anvil fork, scripted Esplora

```
$ playwright test -c tests/e2e/playwright.config.ts nft-send.spec.ts
Running 4 tests using 1 worker
  ✓  1 tests/e2e/nft-send.spec.ts:24:3 › NFT send · phone · fr › ERC-721 on the fork: item page → form → review (on-chain identifiers) → passkey → pending → confirmed at finality → inventory (25.0s)
  ✓  2 tests/e2e/nft-send.spec.ts:105:3 › NFT send · phone · fr › a token of another holder is not sendable: the exact reason replaces the button; the API refuses a forged request for it (4.3s)
  ✓  3 tests/e2e/nft-send.spec.ts:118:3 › NFT send · phone · fr › Bitcoin: protected outputs — heuristic said as such, lock and unlock with the passkey, an ordinary BTC send cannot select a protected output (36.7s)
  ✓  4 tests/e2e/nft-send.spec.ts:171:3 › NFT send · desktop · en · dark › the form in English on a desktop: identifiers in full, the creator label, no overflow (2.2s)
  4 passed (1.1m)
exit 0
```

Screenshots: `test-results/shots/nft-send-*.png`, `nft-utxo-*.png` (not committed).

## 6. Commands and results

| Command | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `npx vitest run packages/core/test/nft-intent.test.ts services/isolated-signer/test/nft.test.ts services/api/test/nft-transfer.test.ts` | 3 files, 83 tests passed (core 32, signer 28, API 23) |
| `pnpm test` (full) | 203 files, 4 763 tests passed, 0 failed (178 s) — branch nft was at 200 files / 4 675 |
| `node scripts/build.mjs` | exit 0 — `dist/signer.mjs` 2 952 127 bytes (the `dist/signer.mjs` found in the checkout of branch `nft`: 2 906 858 → **+45 269 bytes, +1.6 %**); `dist/api.mjs` 8 818 328 (8 717 205 there) |
| `(cd apps/web && node_modules/.bin/vite build)` | exit 0 — first chunk `index-*.js` **260.60 kB** (80.56 kB gzip; branch `nft`: 260.57 kB); `Nft-*.js` 45.52 kB (was 43.75); new lazy chunk `NftSend-*.js` 18.80 kB (5.63 kB gzip) |
| fork / validator / rollback scripts, Playwright | §4, §5 |
| lab `pytest` | not run: nothing under research/ was touched |

## 7. Files touched outside the NFT modules

`packages/core/src/policy.ts` (one optional schema key + import) · `packages/core/src/index.ts` (4 exports) ·
`services/isolated-signer/src/signer.ts` (import, status fields, `nftCtx` + 3 methods, the lock check in `sign`) ·
`server.ts` (3 routes) · `store.ts` (3 optional state fields, one prune line) · `services/api/src/chains/btc.ts`
(`utxoGuards`, the guard call in coin selection, `utxos` / `rawTx`, the `insufficient_unlocked_funds` refusal) ·
`chains/rpc.ts` (two optional adapter methods) · `transfers.ts` (kind `'nft'`, column `nft` in the row and view, `load` /
`destinationWarnings` exported, `proposalHooks`, two refusals of NFT proposals on the ordinary routes) · `worker.ts` (the
hook call in `reconcile`) · `signer-client.ts` (3 calls, 2 status fields) · `db.ts` (one additive block: `proposals.nft`,
`nft_arrival_scan`, `utxo_reviews`) · tests updated to the new truth: `packages/nft/test/nft-model.test.ts`,
`services/api/test/{nft-api,nft-providers,hardening-e}.test.ts`, `apps/web/test/nft.test.ts`, `tests/e2e/nft.spec.ts` ·
`scripts/smoke-nft.mts` (one line) · docs listed in item I.
Not touched: `packages/core/src/{intent,build-evm,build-sol,build-btc}.ts`, the plugins, every `venue*.ts`,
`services/api/src/{orders,risk,mandates,agents,mm,quotes,trading-api}/**`, `research/`.

## 8. Limitations, and what is not done

- **Never executed on a real network.** The first real NFT transfer will be the first.
- Compressed NFTs: not transferable. Ordinals: not listed, not transferable. `tests/e2e/nft.spec.ts` (delivery 1's browser
  spec) had three expectations updated to the new texts and was **not re-run** in this delivery.
- The ord adapter was never run against an `ord` server.
- The Solana preparation path (`prepareSol`) is exercised by the validator proof only, not by `pnpm test`.
- A behaviour change for existing users: on Bitcoin without an ord server, outputs ≤ 10 000 sat are no longer spent
  automatically (review them on the protected-outputs screen).
- The review is rendered by the web app (ADR residual risk): a compromised API / web could obtain a passkey approval for
  another NFT of the wallet. Bound: one NFT per approval, `maxTransfersPerDay`; allow-list mode narrows destinations.
- `transferFrom` for non-receiver-safe cases was not justified and is not offered.
- No independent review of the new signer code.

## 9. What delivery 3 (market) needs

1. A market adapter per marketplace filling `NftMarketSnapshot` and producing `sale` / `list` / `offer` events with a linked
   payment (model already there); a source able to say an on-chain holder is that marketplace's escrow (`escrow` state).
2. For any write: the order / instruction format decoded into a deterministic summary, a signer-side validator per method
   (as `verifyNftEvmTx` / `verifyNftSolMessage` do for transfers), pinned marketplace programs / contracts, price, fee,
   royalty and slippage caps in the `nft` policy section, and its own intent type — never a reuse of the transfer intent.
3. Approvals are distinct operations (brief §4): scoped, revocable, shown with contract, token or collection, market and
   duration. Nothing of that exists; the transfer path cannot produce one.
4. Reading existing approvals / delegates on EVM (not read today) before any listing flow.
5. The allow-list and the daily count of this delivery are per transfer; market actions need their own counters.
