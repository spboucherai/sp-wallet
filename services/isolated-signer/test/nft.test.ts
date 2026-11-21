/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/isolated-signer/test/nft.test.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-17
 * Last Modified    : 2026-11-17
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// NFT delivery 2 — the REAL signer (Signer + Store on a temporary directory, real WebAuthn assertions from a software passkey,
// the public BIP-39 test mnemonic: no funds, no network). What it signs for an NFT, and every refusal, one by one:
// substituted network / contract / token id / quantity / destination, calldata or instructions smuggled in the request,
// another selector presented as a transfer, budgets and fees over their caps, expiry, replay, halt, the daily count across a
// restart, allow-list mode, a foreign source address, a passkey that approved other fields, a missing passkey; then the
// outpoint lock list (an ordinary BTC send cannot spend a locked outpoint; the list changes only with the passkey), the
// policy merge-on-load on a file in the production shape, and the on-disk compatibility of the state.
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58, hex } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import { decodeFunctionData, erc721Abi, parseAbi, parseTransaction, recoverTransactionAddress } from 'viem';
import { defaultNftPolicy, intentHash, NETWORKS, NFT_CORE_PROGRAM, NFT_TOKEN_METADATA_PROGRAM, nftAllowHash, nftIntentHash, TOKEN_2022_PROGRAM, utxoLockHash, verifyAuditChain, verifyNftSolMessage,
  type Intent, type NftAllowIntent, type NftIntent, type UtxoLockIntent } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../src/keys.ts';
import { authHeader, createSignerServer } from '../src/server.ts';
import { Signer, SignerError } from '../src/signer.ts';
import { Store } from '../src/store.ts';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RP = 'wallet.test', ORIGIN = 'https://wallet.test', keys = deriveKeys(TEST_MNEMONIC);
const FIXTURE = join(import.meta.dirname, 'fixtures');
const BAYC = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', DEST = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', OTHER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const MINT = 'CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j', SOL_DEST = '62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS', COLLECTION = 'phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC', RULESET = 'eBJLFYPxJmMGKuFwpDWkzxZeUrad92kZRC5BJLpzyT9';
const BH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';

async function setup(o: { dir?: string; policy?: Record<string, unknown>; t?: number } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'spw-signer-nft-')), nowRef = { t: o.t ?? 1_800_000_000 };
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  if (o.policy) store.policy = { ...store.policy, ...o.policy } as never;
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => nowRef.t);
  const pk = new TestPasskey(RP, ORIGIN);
  if (store.state.credentials.length === 0) { store.state.setupTokenHash = createHash('sha256').update('setup-token').digest('hex'); await signer.enroll({ credential: pk.credential(), setupToken: 'setup-token' }); }
  return { dir, store, signer, pk, nowRef };
}
let seq = 0;
const uuid = () => `6f1c1f0e-8f5f-4b1e-9c56-${String(++seq).padStart(12, '0')}`;
function erc721(now: number, over: Partial<NftIntent> = {}): NftIntent {
  return { v: 1, kind: 'nft-transfer', proposalId: uuid(), keyId: keys.keyId, network: 'ethereum', chainRef: '1', standard: 'erc721', asset: BAYC, tokenId: '8520', quantity: '1', program: BAYC, from: keys.addresses.evm, to: DEST,
    maxFee: '3000000000000000', createdAt: now, expiresAt: now + 120, policyVersion: 4, nftPolicyVersion: 1, evm: { nonce: 3, gasLimit: '150000', maxFeePerGas: '20000000000', maxPriorityFeePerGas: '1000000000' }, ...over };
}
const erc1155 = (now: number, over: Partial<NftIntent> = {}): NftIntent => erc721(now, { standard: 'erc1155', quantity: '3', tokenId: '115792089237316195423570985008687907853269984665640564039457584007913129639935', ...over });
function sol(now: number, standard: NftIntent['standard'], solOver: Partial<NonNullable<NftIntent['sol']>> = {}, over: Partial<NftIntent> = {}): NftIntent {
  const program = standard === 'metaplex-core' ? NFT_CORE_PROGRAM : standard === 'spl-token-2022' ? TOKEN_2022_PROGRAM : NFT_TOKEN_METADATA_PROGRAM;
  const extra = standard === 'metaplex-core' ? {} : standard === 'spl-token-2022' ? { tokenProgram: 'token2022' as const, createAta: true } : { tokenProgram: 'token' as const };
  return { v: 1, kind: 'nft-transfer', proposalId: uuid(), keyId: keys.keyId, network: 'solana', chainRef: NETWORKS.solana.chainRef, standard, asset: MINT, quantity: '1', program, from: keys.addresses.sol, to: SOL_DEST, maxFee: '500000',
    createdAt: now, expiresAt: now + 60, policyVersion: 4, nftPolicyVersion: 1, sol: { recentBlockhash: BH, lastValidBlockHeight: 300000000, computeUnitLimit: 200000, computeUnitPrice: '1000', ...extra, ...solOver }, ...over };
}
/** the code of the SignerError a call is refused with */
const refusal = async (p: Promise<unknown>): Promise<string> => { try { await p; } catch (e) { if (e instanceof SignerError) return e.code; throw e; } return 'SIGNED'; };
const erc1155Abi = parseAbi(['function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)']);
const journalTypes = (store: Store) => store.journalRecords().map((r) => r.type);
const lastJournal = (store: Store) => store.journalRecords().at(-1)!;

describe('NFT transfer — what is signed', () => {
  it('ERC-721: signs exactly safeTransferFrom(wallet, to, tokenId) to the contract, from the wallet\'s key, and journals it without secrets', async () => {
    const { signer, pk, store, nowRef } = await setup();
    const i = erc721(nowRef.t), r = await signer.nftSign(i, pk.assert(nftIntentHash(i)));
    const tx = parseTransaction(r.raw as `0x${string}`);
    expect(await recoverTransactionAddress({ serializedTransaction: r.raw as never })).toBe(keys.addresses.evm);
    expect(tx).toMatchObject({ type: 'eip1559', chainId: 1, nonce: 3, gas: 150000n, maxFeePerGas: 20000000000n, maxPriorityFeePerGas: 1000000000n });
    expect(tx.to!.toLowerCase()).toBe(BAYC.toLowerCase()); expect(tx.value ?? 0n).toBe(0n); expect(tx.accessList ?? []).toEqual([]);
    const d = decodeFunctionData({ abi: erc721Abi, data: tx.data! });
    expect(d.functionName).toBe('safeTransferFrom'); expect(d.args).toEqual([keys.addresses.evm, DEST, 8520n]);
    expect(r.hash).toBe(Buffer.from(nftIntentHash(i)).toString('hex'));
    const rec = lastJournal(store);
    expect(rec.type).toBe('nft.sign.ok');
    expect(rec.data).toEqual({ proposalId: i.proposalId, hash: r.hash, network: 'ethereum', standard: 'erc721', asset: BAYC, tokenId: '8520', quantity: '1', program: BAYC, to: DEST, txid: r.txid });
    const text = JSON.stringify(store.journalRecords());
    expect(text).not.toContain(Buffer.from(keys.evmPriv).toString('hex')); expect(text).not.toContain('clientDataJSON'); expect(text).not.toContain('signature'); expect(text).not.toContain(r.raw);
    expect(verifyAuditChain(store.journalRecords())).toBeNull();
    expect(signer.status().nft.signedToday).toBe(1);
    expect(signer.status().spentToday).toEqual({}); // an NFT transfer is not counted against any fund limit, and no fund limit counts it
  });
  it('ERC-1155: signs safeTransferFrom(wallet, to, id, quantity, "") with an exact uint256 id', async () => {
    const { signer, pk, nowRef } = await setup();
    const i = erc1155(nowRef.t, { network: 'base', chainRef: '8453', maxFee: '300000000000000', evm: { nonce: 0, gasLimit: '120000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000' } });
    const r = await signer.nftSign(i, pk.assert(nftIntentHash(i))), tx = parseTransaction(r.raw as `0x${string}`);
    expect(tx.chainId).toBe(8453);
    const d = decodeFunctionData({ abi: erc1155Abi, data: tx.data! });
    expect(d.args).toEqual([keys.addresses.evm, DEST, (1n << 256n) - 1n, 3n, '0x']);
    expect((tx.data!.length - 2) / 2).toBe(196);
  });
  it('Solana (Core, pNFT with rule set, legacy Token Metadata, Token-2022): one signature of the wallet over the canonical message', async () => {
    const { signer, pk, nowRef, store } = await setup();
    for (const i of [sol(nowRef.t, 'metaplex-core', { collection: COLLECTION }), sol(nowRef.t, 'metaplex-pnft', { ruleSet: RULESET }), sol(nowRef.t, 'metaplex-token-metadata'), sol(nowRef.t, 'spl-token-2022')]) {
      const r = await signer.nftSign(i, pk.assert(nftIntentHash(i))), wire = Buffer.from(r.raw, 'base64');
      expect(wire[0]).toBe(1);
      const sig = wire.subarray(1, 65), msg = new Uint8Array(wire.subarray(65));
      expect(base58.encode(sig)).toBe(r.txid);
      expect(ed25519.verify(sig, msg, base58.decode(keys.addresses.sol))).toBe(true);
      verifyNftSolMessage(msg, i); // the signed bytes ARE the canonical transfer of the intent
      expect(lastJournal(store).data).toMatchObject({ standard: i.standard, asset: MINT, to: SOL_DEST, program: i.program, ...(i.sol!.ruleSet ? { ruleSet: RULESET } : {}), ...(i.sol!.collection ? { collection: COLLECTION } : {}) });
    }
    expect(signer.status().nft.signedToday).toBe(4);
  });
});

describe('NFT transfer — every refusal, individually (nothing is signed, the refusal is journaled with its code)', () => {
  it('wrong chain id, unknown network, a network of another family, another key', async () => {
    const { signer, pk, nowRef, store } = await setup(), t = nowRef.t;
    const go = (i: NftIntent) => refusal(signer.nftSign(i, pk.assert(nftIntentHash(i))));
    expect(await go(erc721(t, { chainRef: '8453' }))).toBe('wrong_chain');
    expect(await go(erc721(t, { network: 'nowhere' }))).toBe('wrong_chain');
    expect(await go(erc721(t, { network: 'bitcoin', chainRef: NETWORKS.bitcoin.chainRef, from: keys.addresses.btc }))).toBe('nft_unsupported_family');
    expect(await go(erc721(t, { network: 'tron', chainRef: NETWORKS.tron.chainRef }))).toBe('nft_unsupported_family');
    expect(await go(erc721(t, { keyId: 'spw-0000000000000000' }))).toBe('wrong_key');
    expect(await go(sol(t, 'metaplex-core', {}, { chainRef: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' }))).toBe('wrong_chain'); // devnet genesis
    expect(journalTypes(store).filter((x) => x === 'nft.sign.denied')).toHaveLength(6);
    expect(lastJournal(store).data).toMatchObject({ code: 'wrong_chain' });
    expect(signer.status().nft.signedToday).toBe(0);
  });
  it('from ≠ the signer\'s own address; destination = the wallet itself', async () => {
    const { signer, pk, nowRef } = await setup(), t = nowRef.t;
    const go = (i: NftIntent) => refusal(signer.nftSign(i, pk.assert(nftIntentHash(i))));
    expect(await go(erc721(t, { from: OTHER }))).toBe('wrong_source');
    expect(await go(erc721(t, { from: keys.vault(1).address }))).toBe('wrong_source'); // not even an agent vault of the same seed
    expect(await go(sol(t, 'metaplex-core', {}, { from: SOL_DEST, to: keys.addresses.sol }))).toBe('wrong_source');
    expect(await go(erc721(t, { to: keys.addresses.evm }))).toBe('self_send');
    expect(await go(sol(t, 'metaplex-core', {}, { to: keys.addresses.sol }))).toBe('self_send');
  });
  it('INTENT HASH MISMATCH — the passkey approved other fields: contract / mint, token id, quantity, destination, network, nonce, fee caps, rule set, collection, budget', async () => {
    const { signer, pk, nowRef, store } = await setup(), t = nowRef.t;
    const approved = erc721(t), sig = () => pk.assert(nftIntentHash(approved));
    const swaps: Partial<NftIntent>[] = [{ asset: OTHER, program: OTHER }, { tokenId: '8521' }, { to: OTHER }, { network: 'base', chainRef: '8453', maxFee: '300000000000000', evm: { ...approved.evm!, maxFeePerGas: '2000000000' } },
      { evm: { ...approved.evm!, nonce: 4 } }, { evm: { ...approved.evm!, gasLimit: '149999' } }, { evm: { ...approved.evm!, maxPriorityFeePerGas: '999999999' } }, { maxFee: '3000000000000001' }, { expiresAt: approved.expiresAt + 1 }, { standard: 'erc1155' }];
    for (const s of swaps) expect(await refusal(signer.nftSign({ ...approved, ...s }, sig())), JSON.stringify(s)).toBe('bad_approval');
    const a1155 = erc1155(t);
    expect(await refusal(signer.nftSign({ ...a1155, quantity: '4' }, pk.assert(nftIntentHash(a1155))))).toBe('bad_approval');
    const p = sol(t, 'metaplex-pnft', { ruleSet: RULESET }), c = sol(t, 'metaplex-core', { collection: COLLECTION });
    for (const s of [{ asset: COLLECTION }, { to: COLLECTION }, { sol: { ...p.sol!, ruleSet: COLLECTION } }, { sol: { ...p.sol!, ruleSet: undefined } }, { sol: { ...p.sol!, tokenProgram: 'token2022' as const } }, { sol: { ...p.sol!, computeUnitLimit: 200001 } }, { sol: { ...p.sol!, computeUnitPrice: '1001' } }, { sol: { ...p.sol!, recentBlockhash: MINT } }])
      expect(await refusal(signer.nftSign({ ...p, ...s }, pk.assert(nftIntentHash(p)))), JSON.stringify(s)).toBe('bad_approval');
    expect(await refusal(signer.nftSign({ ...c, sol: { ...c.sol!, collection: RULESET } }, pk.assert(nftIntentHash(c))))).toBe('bad_approval');
    expect(await refusal(signer.nftSign({ ...c, sol: { ...c.sol!, collection: undefined } }, pk.assert(nftIntentHash(c))))).toBe('bad_approval');
    // an assertion over the hash of an ORDINARY intent with the same proposal id is not an approval of the NFT transfer, and the other way round
    const fund: Intent = { v: 1, proposalId: approved.proposalId, keyId: keys.keyId, network: 'ethereum', chainRef: '1', asset: 'native', symbol: 'ETH', decimals: 18, amount: '1', from: keys.addresses.evm, to: DEST, maxFee: '3000000000000000',
      createdAt: t, expiresAt: t + 120, policyVersion: 4, evm: { nonce: 3, gasLimit: '21000', maxFeePerGas: '20000000000', maxPriorityFeePerGas: '1000000000' } };
    expect(await refusal(signer.nftSign(approved, pk.assert(intentHash(fund))))).toBe('bad_approval');
    await expect(signer.sign(fund, pk.assert(nftIntentHash(approved)))).rejects.toMatchObject({ code: 'bad_approval' });
    // nothing was consumed by the refusals: the genuine approval still signs
    expect(signer.status().nft.signedToday).toBe(0);
    expect((await signer.nftSign(approved, sig())).txid).toMatch(/^0x[0-9a-f]{64}$/);
    expect(journalTypes(store).filter((x) => x === 'nft.sign.denied').length).toBe(swaps.length + 1 + 8 + 2 + 1);
  });
  it('quantity: zero, an ERC-721 quantity other than 1, an ERC-1155 quantity over the policy cap, a Solana quantity other than 1', async () => {
    const { signer, pk, nowRef } = await setup(), t = nowRef.t;
    const go = (i: NftIntent) => refusal(signer.nftSign(i, pk.assert(nftIntentHash(i))));
    expect(await go(erc721(t, { quantity: '0' }))).toBe('nft_bad_quantity');
    expect(await go(erc721(t, { quantity: '2' }))).toBe('nft_bad_quantity');
    expect(await go(erc1155(t, { quantity: '0' }))).toBe('nft_bad_quantity');
    expect(await go(erc1155(t, { quantity: '11' }))).toBe('nft_quantity_cap');
    expect(await go(erc1155(t, { quantity: (1n << 200n).toString() }))).toBe('nft_quantity_cap');
    expect(await go(sol(t, 'metaplex-core', {}, { quantity: '2' }))).toBe('nft_bad_quantity');
    expect(await go(erc1155(t, { quantity: '10' }))).toBe('SIGNED');
  });
  it('smuggled bytes and other methods: extra calldata, a non-empty data, approve / setApprovalForAll / transferFrom, instruction lists, helper data — the request has no place for them', async () => {
    const { signer, pk, nowRef, store } = await setup(), t = nowRef.t, i = erc721(t), s = sol(t, 'metaplex-core');
    const forged: Record<string, unknown>[] = [
      { ...i, data: '0x00' }, { ...i, calldata: '0x095ea7b3' + '00'.repeat(64) }, { ...i, evm: { ...i.evm, data: '0x42842e0e' + '00'.repeat(97) } }, { ...erc1155(t), data: '0x01' }, { ...erc1155(t), evm: { ...i.evm, data: '0x01' } },
      { ...i, method: 'approve' }, { ...i, method: 'setApprovalForAll', operator: OTHER }, { ...i, method: 'transferFrom' }, { ...i, standard: 'erc721-approve' }, { ...i, standard: 'erc20' }, { ...i, approve: OTHER }, { ...i, operator: OTHER, approved: true },
      { ...s, instructions: [{ program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: '04' }] }, { ...s, sol: { ...s.sol, extraInstructions: [] } }, { ...s, sol: { ...s.sol, accounts: [SOL_DEST] } }, { ...s, sol: { ...s.sol, delegate: SOL_DEST } },
      { ...s, message: 'AQAB' }, { ...s, swapMessage: 'AQAB' }, { ...i, aux: { swapData: '0x' } }, { ...i, swap: { provider: 'kyberswap' } }, { ...i, kind: 'transfer' }, { ...i, v: 2 },
    ];
    for (const f of forged) expect(await refusal(signer.nftSign(f, pk.assert(nftIntentHash(i)))), JSON.stringify(f).slice(0, 120)).toBe('bad_request');
    expect(journalTypes(store).filter((x) => x.startsWith('nft.'))).toEqual([]); // a malformed request is not even an intent
    // the ordinary route does not take an NFT intent, and the NFT route does not take an ordinary one
    await expect(signer.sign(i as never, pk.assert(nftIntentHash(i)))).rejects.toMatchObject({ code: 'bad_request' });
    const fund: Intent = { v: 1, proposalId: uuid(), keyId: keys.keyId, network: 'ethereum', chainRef: '1', asset: 'native', symbol: 'ETH', decimals: 18, amount: '1', from: keys.addresses.evm, to: DEST, maxFee: '3000000000000000',
      createdAt: t, expiresAt: t + 120, policyVersion: 4, evm: { nonce: 3, gasLimit: '21000', maxFeePerGas: '20000000000', maxPriorityFeePerGas: '1000000000' } };
    expect(await refusal(signer.nftSign(fund, pk.assert(intentHash(fund))))).toBe('bad_request');
    // the ordinary route cannot be used to call an NFT contract either: its asset must be of the fungible registry
    await expect(signer.sign({ ...fund, asset: BAYC, symbol: 'BAYC', decimals: 0 }, pk.assert(intentHash({ ...fund, asset: BAYC, symbol: 'BAYC', decimals: 0 })))).rejects.toMatchObject({ code: 'policy' });
  });
  it('builder refusals reach the caller with their code: a registered fungible token as "NFT", the contract as destination, a program or the asset as Solana destination, a section of another standard, an unknown program', async () => {
    const { signer, pk, nowRef } = await setup(), t = nowRef.t;
    const go = (i: NftIntent) => refusal(signer.nftSign(i, pk.assert(nftIntentHash(i))));
    const usdc = NETWORKS.ethereum.tokens.find((x) => x.symbol === 'USDC')!.id;
    expect(await go(erc721(t, { asset: usdc, program: usdc }))).toBe('nft_contract_is_fungible_token');
    expect(await go(erc721(t, { to: BAYC }))).toBe('nft_destination_is_contract_itself');
    expect(await go(erc721(t, { program: OTHER }))).toBe('nft_program_mismatch');
    expect(await go(erc721(t, { asset: BAYC.toLowerCase(), program: BAYC.toLowerCase() }))).toBe('nft_bad_contract');
    expect(await go(erc721(t, { to: '0x0000000000000000000000000000000000000000' }))).toBe('nft_bad_destination');
    expect(await go(erc721(t, { standard: 'metaplex-core' }))).toBe('nft_network_disabled'); // the policy has no such standard on an EVM network
    expect(await go(sol(t, 'metaplex-core', {}, { to: NFT_CORE_PROGRAM }))).toBe('nft_bad_destination');
    expect(await go(sol(t, 'metaplex-core', {}, { to: MINT }))).toBe('nft_bad_destination');
    expect(await go(sol(t, 'metaplex-core', {}, { program: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' }))).toBe('nft_program_mismatch');
    expect(await go(sol(t, 'metaplex-pnft', {}, { program: NFT_CORE_PROGRAM }))).toBe('nft_program_mismatch');
    expect(await go(sol(t, 'metaplex-core', { ruleSet: RULESET }))).toBe('nft_section_mismatch');
    expect(await go(sol(t, 'metaplex-token-metadata', { createAta: true }))).toBe('nft_section_mismatch');
    expect(await go(sol(t, 'metaplex-core', {}, { tokenId: '1' }))).toBe('nft_bad_token_id');
  });
  it('fee over the policy ceiling or over the intent\'s own cap; gas over the cap; compute budget over the cap', async () => {
    const { signer, pk, nowRef } = await setup(), t = nowRef.t;
    const go = (i: NftIntent) => refusal(signer.nftSign(i, pk.assert(nftIntentHash(i))));
    expect(await go(erc721(t, { maxFee: '5000000000000001' }))).toBe('nft_fee_cap'); // policy.maxFee.ethereum = 5000000000000000
    expect(await go(erc721(t, { maxFee: '2999999999999999' }))).toBe('nft_fee_exceeds_max'); // gas × maxFeePerGas = 3000000000000000
    expect(await go(erc721(t, { evm: { nonce: 3, gasLimit: '500001', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1' } }))).toBe('nft_gas_cap');
    expect(await go(erc721(t, { network: 'base', chainRef: '8453' }))).toBe('nft_fee_cap'); // 0.003 ETH is above Base's ceiling
    expect(await go(sol(t, 'metaplex-core', {}, { maxFee: '3000001' }))).toBe('nft_fee_cap');
    expect(await go(sol(t, 'metaplex-core', { computeUnitPrice: '2000001' }, { maxFee: '3000000' }))).toBe('nft_compute_cap');
    expect(await go(sol(t, 'metaplex-core', { computeUnitLimit: 400000, computeUnitPrice: '2000000' }, { maxFee: '804999' }))).toBe('nft_fee_exceeds_max');
    const tight = await setup({ policy: { nft: { maxComputeUnits: 100000 } } });
    const j = sol(tight.nowRef.t, 'metaplex-core');
    expect(await refusal(tight.signer.nftSign(j, tight.pk.assert(nftIntentHash(j))))).toBe('nft_compute_cap');
    expect(await refusal(tight.signer.nftSign(sol(tight.nowRef.t, 'metaplex-core', { computeUnitLimit: 400001 }), tight.pk.assert(nftIntentHash(j))))).toBe('bad_request');
  });
  it('expired intent, an intent from the future, an approval window longer than the policy allows, another policy version', async () => {
    const { signer, pk, nowRef } = await setup(), t = nowRef.t;
    const go = (i: NftIntent) => refusal(signer.nftSign(i, pk.assert(nftIntentHash(i))));
    expect(await go(erc721(t, { createdAt: t - 200, expiresAt: t - 1 }))).toBe('nft_expired');
    expect(await go(erc721(t, { createdAt: t - 120, expiresAt: t }))).toBe('nft_expired');
    expect(await go(erc721(t, { createdAt: t + 61, expiresAt: t + 120 }))).toBe('nft_window');
    expect(await go(erc721(t, { expiresAt: t + 301 }))).toBe('nft_window');
    expect(await go(erc721(t, { policyVersion: 3 }))).toBe('nft_policy_version');
    expect(await go(erc721(t, { nftPolicyVersion: 2 }))).toBe('nft_policy_version');
    const i = erc721(t), a = pk.assert(nftIntentHash(i));
    nowRef.t = t + 121; // approved in time, presented after the window
    expect(await refusal(signer.nftSign(i, a))).toBe('nft_expired');
  });
  it('replay: the same intent a second time, with the same assertion or with a fresh one', async () => {
    const { signer, pk, nowRef, dir } = await setup(), i = erc721(nowRef.t), a = pk.assert(nftIntentHash(i));
    expect((await signer.nftSign(i, a)).txid).toBeTruthy();
    expect(await refusal(signer.nftSign(i, a))).toBe('replay');
    expect(await refusal(signer.nftSign(i, pk.assert(nftIntentHash(i))))).toBe('replay');
    // the marker is on disk: a restarted signer refuses it too
    const again = new Signer(keys, new Store(join(dir, 'state.json'), join(dir, 'policy.json')), { rpId: RP, origin: ORIGIN }, () => nowRef.t);
    expect(await refusal(again.nftSign(i, pk.assert(nftIntentHash(i))))).toBe('replay');
    // a proposal id already used by an ORDINARY transfer cannot be reused for an NFT transfer
    const fund: Intent = { v: 1, proposalId: uuid(), keyId: keys.keyId, network: 'base', chainRef: '8453', asset: NETWORKS.base.tokens[0]!.id, symbol: 'USDC', decimals: 6, amount: '1000000', from: keys.addresses.evm, to: DEST, maxFee: '100000000000000',
      createdAt: nowRef.t, expiresAt: nowRef.t + 120, policyVersion: 4, evm: { nonce: 0, gasLimit: '90000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000' } };
    await signer.sign(fund, pk.assert(intentHash(fund)));
    const reuse = erc721(nowRef.t, { proposalId: fund.proposalId });
    expect(await refusal(signer.nftSign(reuse, pk.assert(nftIntentHash(reuse))))).toBe('replay');
  });
  it('halted signer: an NFT transfer is not a risk reduction — refused on EVM and on Solana', async () => {
    const { signer, pk, nowRef } = await setup(), t = nowRef.t;
    signer.halt();
    const i = erc721(t), s = sol(t, 'metaplex-core');
    expect(await refusal(signer.nftSign(i, pk.assert(nftIntentHash(i))))).toBe('nft_halted');
    expect(await refusal(signer.nftSign(s, pk.assert(nftIntentHash(s))))).toBe('nft_halted');
    expect(signer.status().nft.signedToday).toBe(0);
  });
  it('daily count: the sixth transfer of the UTC day is refused, a restart does not reset it, the next day does', async () => {
    const { signer, pk, nowRef, dir } = await setup();
    for (let k = 0; k < 5; k++) { const i = k % 2 ? sol(nowRef.t, 'metaplex-core') : erc721(nowRef.t, { evm: { nonce: k, gasLimit: '150000', maxFeePerGas: '20000000000', maxPriorityFeePerGas: '1000000000' } }); await signer.nftSign(i, pk.assert(nftIntentHash(i))); }
    const sixth = erc721(nowRef.t);
    expect(await refusal(signer.nftSign(sixth, pk.assert(nftIntentHash(sixth))))).toBe('nft_daily_count');
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).nftDaily).toEqual({ [new Date(nowRef.t * 1000).toISOString().slice(0, 10)]: 5 });
    const restarted = new Signer(keys, new Store(join(dir, 'state.json'), join(dir, 'policy.json')), { rpId: RP, origin: ORIGIN }, () => nowRef.t);
    expect(restarted.status().nft.signedToday).toBe(5);
    const seventh = sol(nowRef.t, 'metaplex-core');
    expect(await refusal(restarted.nftSign(seventh, pk.assert(nftIntentHash(seventh))))).toBe('nft_daily_count');
    nowRef.t += 86400;
    const next = erc721(nowRef.t);
    expect((await restarted.nftSign(next, pk.assert(nftIntentHash(next)))).txid).toBeTruthy();
  });
  it('per-network switch: a standard the policy does not enable on that network is refused', async () => {
    const { signer, pk, nowRef } = await setup({ policy: { nft: { enabled: { ethereum: ['erc1155'], solana: ['metaplex-core'] } } } }), t = nowRef.t;
    const go = (i: NftIntent) => refusal(signer.nftSign(i, pk.assert(nftIntentHash(i))));
    expect(await go(erc721(t))).toBe('nft_network_disabled');
    expect(await go(erc1155(t))).toBe('SIGNED');
    expect(await go(erc1155(t, { network: 'base', chainRef: '8453', maxFee: '300000000000000', evm: { nonce: 0, gasLimit: '120000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1' } }))).toBe('nft_network_disabled');
    expect(await go(sol(t, 'metaplex-pnft'))).toBe('nft_network_disabled');
    expect(await go(sol(t, 'metaplex-core'))).toBe('SIGNED');
  });
  it('passkey: none, an unknown credential, another origin, no user verification', async () => {
    const { signer, pk, nowRef } = await setup(), i = erc721(nowRef.t);
    expect(await refusal(signer.nftSign(i))).toBe('bad_approval');
    expect(await refusal(signer.nftSign(i, new TestPasskey(RP, ORIGIN).assert(nftIntentHash(i))))).toBe('unknown_credential');
    expect(await refusal(signer.nftSign(i, pk.assert(nftIntentHash(i), { origin: 'https://evil.test' })))).toBe('bad_approval');
    expect(await refusal(signer.nftSign(i, pk.assert(nftIntentHash(i), { uv: false })))).toBe('bad_approval');
    expect(await refusal(signer.nftSign(i, pk.assert(nftIntentHash(i))))).toBe('SIGNED');
  });
});

describe('allow-list mode — NFT transfers only to destinations the owner approved with the passkey', () => {
  const allow = (t: number, over: Partial<NftAllowIntent> = {}): NftAllowIntent => ({ v: 1, kind: 'nft-allow', requestId: uuid(), keyId: keys.keyId, network: 'ethereum', action: 'add', address: DEST, createdAt: t, expiresAt: t + 120, policyVersion: 4, ...over });
  it('a destination that is not on the list is refused; once approved with the passkey it is accepted, on that network only; removal closes it again', async () => {
    const { signer, pk, nowRef, store } = await setup({ policy: { nft: { allowlistOnly: true } } }), t = nowRef.t;
    const go = (i: NftIntent) => refusal(signer.nftSign(i, pk.assert(nftIntentHash(i))));
    expect(await go(erc721(t))).toBe('nft_not_allowlisted');
    const a = allow(t);
    expect(await signer.nftAllow(a, pk.assert(nftAllowHash(a)))).toMatchObject({ network: 'ethereum', address: DEST, action: 'add', entries: 1 });
    expect(signer.status().nft.allow).toEqual([{ network: 'ethereum', address: DEST, approvedAt: t }]);
    expect(lastJournal(store)).toMatchObject({ type: 'nft.allow.ok', data: { network: 'ethereum', address: DEST, action: 'add' } });
    expect(await go(erc721(t))).toBe('SIGNED');
    expect(await go(erc721(t, { to: OTHER }))).toBe('nft_not_allowlisted');
    expect(await go(erc1155(t, { network: 'base', chainRef: '8453', maxFee: '300000000000000', evm: { nonce: 0, gasLimit: '120000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1' } }))).toBe('nft_not_allowlisted'); // same address, another network
    expect(await go(sol(t, 'metaplex-core'))).toBe('nft_not_allowlisted');
    const r = allow(t, { action: 'remove' });
    await signer.nftAllow(r, pk.assert(nftAllowHash(r)));
    expect(await go(erc721(t))).toBe('nft_not_allowlisted');
  });
  it('the list changes only with the passkey over the exact request: no assertion, another request\'s assertion, replay, expiry, a foreign key, the wallet itself, a malformed address, a halt', async () => {
    const { signer, pk, nowRef, store } = await setup(), t = nowRef.t, a = allow(t);
    expect(await refusal(signer.nftAllow(a))).toBe('bad_approval');
    expect(await refusal(signer.nftAllow(a, pk.assert(nftAllowHash(allow(t, { address: OTHER })))))).toBe('bad_approval');
    expect(await refusal(signer.nftAllow({ ...a, address: OTHER }, pk.assert(nftAllowHash(a))))).toBe('bad_approval');
    expect(await refusal(signer.nftAllow({ ...a, action: 'remove' }, pk.assert(nftAllowHash(a))))).toBe('bad_approval');
    expect(store.state.nftAllow ?? {}).toEqual({});
    await signer.nftAllow(a, pk.assert(nftAllowHash(a)));
    expect(await refusal(signer.nftAllow(a, pk.assert(nftAllowHash(a))))).toBe('replay');
    const go = (x: NftAllowIntent) => refusal(signer.nftAllow(x, pk.assert(nftAllowHash(x))));
    expect(await go(allow(t, { createdAt: t - 300, expiresAt: t - 1 }))).toBe('policy');
    expect(await go(allow(t, { expiresAt: t + 301 }))).toBe('policy');
    expect(await go(allow(t, { policyVersion: 3 }))).toBe('policy');
    expect(await go(allow(t, { keyId: 'spw-0000000000000000' }))).toBe('wrong_key');
    expect(await go(allow(t, { address: keys.addresses.evm }))).toBe('self_send');
    expect(await go(allow(t, { address: DEST.toLowerCase() }))).toBe('bad_request');
    expect(await go(allow(t, { network: 'bitcoin', address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' }))).toBe('wrong_chain');
    expect(await refusal(signer.nftAllow({ ...a, requestId: uuid(), everything: true }, pk.assert(nftAllowHash(a))))).toBe('bad_request');
    signer.halt();
    expect(await go(allow(t, { address: OTHER }))).toBe('policy');
    expect(await go(allow(t, { action: 'remove' }))).toBe('SIGNED'); // removing only restricts: allowed under halt
    expect(store.state.nftAllow).toEqual({});
  });
});

// ── Bitcoin: the outpoint lock list ─────────────────────────────────────────────────────────────────────────────────────
const INSCRIPTION = { txid: 'ab'.repeat(32), vout: 0 }, COIN = { txid: 'cd'.repeat(32), vout: 1 };
function btc(t: number, inputs: { txid: string; vout: number; value: string }[], over: Partial<Intent> = {}): Intent {
  const total = inputs.reduce((s, x) => s + BigInt(x.value), 0n), fee = 1000n, amount = 20000n;
  return { v: 1, proposalId: uuid(), keyId: keys.keyId, network: 'bitcoin', chainRef: NETWORKS.bitcoin.chainRef, asset: 'native', symbol: 'BTC', decimals: 8, amount: amount.toString(), from: keys.addresses.btc, to: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
    maxFee: '5000', createdAt: t, expiresAt: t + 120, policyVersion: 4, btc: { inputs, change: (total - amount - fee).toString(), fee: fee.toString() }, ...over };
}
const lock = (t: number, over: Partial<UtxoLockIntent> = {}): UtxoLockIntent => ({ v: 1, kind: 'utxo-locks', requestId: uuid(), keyId: keys.keyId, network: 'bitcoin', action: 'lock', reason: 'owner', outpoints: [INSCRIPTION], createdAt: t, expiresAt: t + 120, policyVersion: 4, ...over });

describe('Bitcoin inscription safety — the signer\'s outpoint lock list', () => {
  it('REGRESSION: with no lock, a BTC send is signed byte for byte as before (pinned transaction)', async () => {
    const { signer, pk, nowRef } = await setup(), i = btc(nowRef.t, [{ ...COIN, value: '50000' }, { ...INSCRIPTION, value: '546' }], { proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0000000b7c01' });
    const r = await signer.sign(i, pk.assert(intentHash(i)));
    // deterministic (RFC 6979): the transaction below was produced by the signer of branch `nft` (before this delivery) for the same intent
    expect(r.txid).toMatchInlineSnapshot(`"4e8f6359e2ff07e6317f52617b64161db6efeadde0c7ca014f74258b0f0144de"`);
    expect(createHash('sha256').update(r.raw).digest('hex')).toMatchInlineSnapshot(`"ffadc066af7bc6b930ccb1a4360137fb606903b4593657d3deee7d92b304b0f9"`);
    const tx = Transaction.fromRaw(hex.decode(r.raw));
    expect(tx.inputsLength).toBe(2); expect(tx.getOutput(0).amount).toBe(20000n);
  });
  it('AN ORDINARY BTC SEND CANNOT SPEND A LOCKED OUTPOINT: refused whether it is the only input, one among several, or selected for a "send max"', async () => {
    const { signer, pk, nowRef, store } = await setup(), t = nowRef.t, l = lock(t);
    expect(await signer.utxoLocks(l, pk.assert(utxoLockHash(l)))).toMatchObject({ network: 'bitcoin', action: 'lock', changed: 1, locked: 1 });
    expect(signer.status().utxoLocks).toEqual({ bitcoin: [{ outpoint: `${INSCRIPTION.txid}:0`, reason: 'owner', at: t }] });
    const go = (i: Intent) => refusal(signer.sign(i, pk.assert(intentHash(i))));
    expect(await go(btc(t, [{ ...INSCRIPTION, value: '30000' }]))).toBe('utxo_locked');
    expect(await go(btc(t, [{ ...COIN, value: '50000' }, { ...INSCRIPTION, value: '546' }]))).toBe('utxo_locked');
    expect(await go(btc(t, [{ ...INSCRIPTION, value: '546' }, { ...COIN, value: '50000' }]))).toBe('utxo_locked');
    expect(lastJournal(store)).toMatchObject({ type: 'sign.denied', data: { code: 'utxo_locked' } });
    expect(signer.status().spentToday).toEqual({}); // nothing was counted
    // the same transaction id, another output index, is another outpoint: not locked
    expect(await go(btc(t, [{ txid: INSCRIPTION.txid, vout: 1, value: '50000' }]))).toBe('SIGNED');
    // a lock on Bitcoin does not lock the same outpoint on Litecoin
    const ltc: Intent = { v: 1, proposalId: uuid(), keyId: keys.keyId, createdAt: t, expiresAt: t + 120, policyVersion: 4, network: 'litecoin', chainRef: NETWORKS.litecoin.chainRef, asset: 'native', symbol: 'LTC', decimals: 8, amount: '2000000',
      from: keys.addresses.litecoin!, to: 'ltc1qg42tkwuuxefutzxezdkdel39gfstuap288mfea', maxFee: '100000', btc: { inputs: [{ ...INSCRIPTION, value: '5000000' }], change: '2990000', fee: '10000' } };
    expect(await go(ltc)).toBe('SIGNED');
  });
  it('the lock list covers the three Bitcoin-style networks (Bitcoin, Litecoin, Dogecoin) — and, as stated, NOT Bitcoin Cash', async () => {
    // delivery 3: delivery 2's note said Litecoin and Dogecoin are covered; this is the test of it. Bitcoin Cash is another family
    // (its coins travel in the plugin section, and its NFTs are CashTokens, not inscriptions): a lock there is refused, not silently ignored
    const { signer, pk, nowRef } = await setup(), t = nowRef.t, go = (i: Intent) => refusal(signer.sign(i, pk.assert(intentHash(i))));
    const other = deriveKeys('legal winner thank year wave sausage worth useful legal winner thank yellow').addresses;
    for (const [network, symbol] of [['litecoin', 'LTC'], ['dogecoin', 'DOGE']] as const) {
      const l = lock(t, { network });
      expect(await signer.utxoLocks(l, pk.assert(utxoLockHash(l))), network).toMatchObject({ network, action: 'lock', changed: 1, locked: 1 });
      const send: Intent = { v: 1, proposalId: uuid(), keyId: keys.keyId, createdAt: t, expiresAt: t + 120, policyVersion: 4, network, chainRef: NETWORKS[network].chainRef, asset: 'native', symbol, decimals: 8, amount: '2000000',
        from: keys.addresses[network]!, to: other[network]!, maxFee: '100000', btc: { inputs: [{ ...INSCRIPTION, value: '5000000' }], change: '2990000', fee: '10000' } };
      expect(await go(send), network).toBe('utxo_locked');
    }
    expect(Object.keys(signer.status().utxoLocks).sort()).toEqual(['dogecoin', 'litecoin']);
    const bch = lock(t, { network: 'bitcoincash' });
    expect(await refusal(signer.utxoLocks(bch, pk.assert(utxoLockHash(bch))))).toBe('wrong_chain');
  });
  it('the lock survives a restart, and a cross-chain swap from Bitcoin (THORChain) is refused on a locked input before anything else is looked at', async () => {
    const { signer, pk, nowRef, dir } = await setup(), t = nowRef.t, l = lock(t, { outpoints: [INSCRIPTION, COIN], reason: 'ord' });
    await signer.utxoLocks(l, pk.assert(utxoLockHash(l)));
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).utxoLocks.bitcoin).toEqual({ [`${INSCRIPTION.txid}:0`]: { reason: 'ord', at: t }, [`${COIN.txid}:1`]: { reason: 'ord', at: t } });
    const again = new Signer(keys, new Store(join(dir, 'state.json'), join(dir, 'policy.json')), { rpId: RP, origin: ORIGIN }, () => nowRef.t);
    const i = btc(t, [{ ...COIN, value: '50000' }]);
    expect(await refusal(again.sign(i, pk.assert(intentHash(i))))).toBe('utxo_locked');
    const x = btc(t, [{ ...INSCRIPTION, value: '50000' }], { to: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      xswap: { provider: 'thorchain', toNetwork: 'ethereum', toAsset: 'native', minOut: '1', limit: '1', memo: '=:ETH.ETH:0x9858EfFD232B4033E47d90003D41EC34EcaEda94:1', vault: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', vaultPubKey: 'thorpub1addwnpepq' + 'a'.repeat(40), router: '', expiry: t + 600, approveGas: '0' } });
    expect(await refusal(again.sign(x, pk.assert(intentHash(x))))).toBe('utxo_locked');
  });
  it('LOCK-LIST CHANGE WITHOUT PASSKEY is refused — locking and unlocking alike; so are another request\'s assertion, a replay, an expired or foreign request', async () => {
    const { signer, pk, nowRef, store } = await setup(), t = nowRef.t, l = lock(t);
    expect(await refusal(signer.utxoLocks(l))).toBe('bad_approval');
    expect(await refusal(signer.utxoLocks(l, new TestPasskey(RP, ORIGIN).assert(utxoLockHash(l))))).toBe('unknown_credential');
    expect(store.state.utxoLocks ?? {}).toEqual({});
    await signer.utxoLocks(l, pk.assert(utxoLockHash(l)));
    const u = lock(t, { action: 'unlock' });
    expect(await refusal(signer.utxoLocks(u))).toBe('bad_approval');
    // the assertion that approved the LOCK does not approve the UNLOCK of the same outpoint, nor another outpoint, nor more outpoints
    expect(await refusal(signer.utxoLocks(u, pk.assert(utxoLockHash(l))))).toBe('bad_approval');
    expect(await refusal(signer.utxoLocks({ ...u, outpoints: [COIN] }, pk.assert(utxoLockHash(u))))).toBe('bad_approval');
    expect(await refusal(signer.utxoLocks({ ...u, outpoints: [INSCRIPTION, COIN] }, pk.assert(utxoLockHash(u))))).toBe('bad_approval');
    expect(await refusal(signer.utxoLocks({ ...u, network: 'litecoin' }, pk.assert(utxoLockHash(u))))).toBe('bad_approval');
    expect(await refusal(signer.utxoLocks(l, pk.assert(utxoLockHash(l))))).toBe('replay');
    const go = (x: UtxoLockIntent) => refusal(signer.utxoLocks(x, pk.assert(utxoLockHash(x))));
    expect(await go(lock(t, { action: 'unlock', createdAt: t - 300, expiresAt: t - 1 }))).toBe('policy');
    expect(await go(lock(t, { action: 'unlock', expiresAt: t + 301 }))).toBe('policy');
    expect(await go(lock(t, { action: 'unlock', policyVersion: 3 }))).toBe('policy');
    expect(await go(lock(t, { action: 'unlock', keyId: 'spw-0000000000000000' }))).toBe('wrong_key');
    expect(await go(lock(t, { network: 'ethereum' }))).toBe('wrong_chain');
    expect(await go(lock(t, { network: 'bitcoincash' }))).toBe('wrong_chain');
    expect(await refusal(signer.utxoLocks({ ...u, requestId: uuid(), unlockAll: true }, pk.assert(utxoLockHash(u))))).toBe('bad_request');
    expect(await refusal(signer.utxoLocks({ ...u, requestId: uuid(), outpoints: [] }, pk.assert(utxoLockHash(u))))).toBe('bad_request');
    expect(Object.keys(store.state.utxoLocks!.bitcoin!)).toEqual([`${INSCRIPTION.txid}:0`]); // still locked after all of the above
    // no HTTP route unlocks without the request + assertion pair either
    const spend = btc(t, [{ ...INSCRIPTION, value: '30000' }]);
    expect(await refusal(signer.sign(spend, pk.assert(intentHash(spend))))).toBe('utxo_locked');
    // the genuine unlock, approved with the passkey, opens it again
    expect(await signer.utxoLocks(u, pk.assert(utxoLockHash(u)))).toMatchObject({ action: 'unlock', changed: 1, locked: 0 });
    const after = btc(t, [{ ...INSCRIPTION, value: '30000' }]);
    expect(await refusal(signer.sign(after, pk.assert(intentHash(after))))).toBe('SIGNED');
    expect(journalTypes(store).filter((x) => x === 'utxo.locks.ok')).toHaveLength(2);
  });
  it('under the emergency halt a lock is still accepted (it only restricts) and an unlock is refused', async () => {
    const { signer, pk, nowRef } = await setup(), t = nowRef.t;
    signer.halt();
    const l = lock(t), u = lock(t, { action: 'unlock' });
    expect(await refusal(signer.utxoLocks(l, pk.assert(utxoLockHash(l))))).toBe('SIGNED');
    expect(await refusal(signer.utxoLocks(u, pk.assert(utxoLockHash(u))))).toBe('policy');
    expect(signer.status().utxoLocks.bitcoin).toHaveLength(1);
  });
});

describe('HTTP surface — the three NFT routes are the only way in, behind the same HMAC as every other route', () => {
  it('POST /nft/sign signs from {intent, assertion} only: helper data in the body changes nothing, a missing MAC is refused', async () => {
    const { signer, pk, nowRef } = await setup(), secret = 's'.repeat(40);
    const server = createSignerServer(signer, secret); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const post = async (path: string, body: unknown, auth = true) => { const b = JSON.stringify(body); const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { 'x-spw-auth': authHeader(secret, 'POST', path, b) } : {}) }, body: b }); return { status: r.status, json: await r.json() as Record<string, unknown> }; };
    try {
      const i = erc721(nowRef.t), a = pk.assert(nftIntentHash(i));
      expect((await post('/nft/sign', { intent: i, assertion: a }, false)).status).toBe(401);
      const ok = await post('/nft/sign', { intent: i, assertion: a, aux: { swapData: '0x095ea7b3', calldata: '0xdeadbeef' }, raw: '0x02', message: 'AQAB' });
      expect(ok.status).toBe(200);
      const d = decodeFunctionData({ abi: erc721Abi, data: parseTransaction(ok.json.raw as `0x${string}`).data! });
      expect(d.functionName).toBe('safeTransferFrom'); expect(d.args).toEqual([keys.addresses.evm, DEST, 8520n]);
      const j = erc721(nowRef.t);
      expect(await post('/nft/sign', { intent: { ...j, data: '0x00' }, assertion: pk.assert(nftIntentHash(j)) })).toMatchObject({ status: 422, json: { error: 'bad_request' } });
      expect(await post('/nft/sign', { intent: j })).toMatchObject({ status: 422, json: { error: 'bad_approval' } });
      const l = lock(nowRef.t);
      expect(await post('/utxo/locks', { request: l })).toMatchObject({ status: 422, json: { error: 'bad_approval' } });
      expect(await post('/utxo/locks', { request: l, assertion: pk.assert(utxoLockHash(l)) })).toMatchObject({ status: 200, json: { locked: 1 } });
      for (const path of ['/utxo/unlock', '/utxo/locks/clear', '/nft/sign-bytes', '/nft/approve', '/sign-bytes']) expect((await post(path, {})).status, path).toBe(404);
    } finally { server.close(); }
  });
});

describe('policy.json and state.json — merge-on-load, nothing rewritten, compatibility', () => {
  it('a policy.json in the production shape (no NFT key): NFT defaults apply, the file is not rewritten, every existing limit and fee ceiling is what the file says', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spw-signer-nft-policy-'));
    copyFileSync(join(FIXTURE, 'policy-pre-v11.json'), join(dir, 'policy.json')); copyFileSync(join(FIXTURE, 'state-pre-v11.json'), join(dir, 'state.json'));
    const before = readFileSync(join(dir, 'policy.json')), file = JSON.parse(before.toString());
    const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json')), signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => 1_800_000_000);
    const st = signer.status();
    expect(st.nft.policy).toEqual(defaultNftPolicy());
    expect(st.policy).toEqual(file); expect(st.policy.version).toBe(4); expect(st.policy.maxFee).toEqual(file.maxFee); expect(st.policy.perTx).toEqual(file.perTx); expect(st.policy.daily).toEqual(file.daily);
    expect(st.utxoLocks).toEqual({}); expect(st.nft.allow).toEqual([]); expect(st.nft.signedToday).toBe(0);
    store.log('test.save', {}); store.save();
    expect(readFileSync(join(dir, 'policy.json')).equals(before)).toBe(true); // byte for byte
  });
  it('NFT keys present in the file win one by one; the missing ones take their default; an unknown key refuses to load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spw-signer-nft-policy-')), file = JSON.parse(readFileSync(join(FIXTURE, 'policy-pre-v11.json'), 'utf8'));
    const write = (nft: unknown) => { const p = join(mkdtempSync(join(dir, 'p-')), 'policy.json'); writeFileSync(p, JSON.stringify({ ...file, nft })); return p; };
    const load = (nft: unknown) => { const p = write(nft); const s = new Store(join(p, '..', 'state.json'), p); return new Signer(keys, s, { rpId: RP, origin: ORIGIN }).status().nft.policy; };
    expect(load({ maxTransfersPerDay: 1 })).toEqual({ ...defaultNftPolicy(), maxTransfersPerDay: 1 });
    expect(load({ allowlistOnly: true, enabled: { base: ['erc721'] } })).toEqual({ ...defaultNftPolicy(), allowlistOnly: true, enabled: { base: ['erc721'] } });
    expect(load({})).toEqual(defaultNftPolicy());
    expect(() => load({ maxTransfersPerDay: 1, signAnything: true })).toThrow();
    expect(() => load({ enabled: { base: ['approve'] } })).toThrow();
  });
  it('a new installation writes the same policy.json as before (no NFT key): a binary from before this delivery can read it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spw-signer-nft-policy-'));
    new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
    const written = JSON.parse(readFileSync(join(dir, 'policy.json'), 'utf8'));
    expect(Object.keys(written).sort()).toEqual(['allowlist', 'daily', 'maxApprovalTtlSec', 'maxFee', 'perTx', 'version']);
  });
  it('state.json: the three new fields are optional and additive — a state from before loads unchanged, a state written now keeps every older field as it was', async () => {
    const { signer, pk, nowRef, dir, store } = await setup(), t = nowRef.t;
    const i = erc721(t), l = lock(t);
    await signer.nftSign(i, pk.assert(nftIntentHash(i))); await signer.utxoLocks(l, pk.assert(utxoLockHash(l)));
    const disk = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    expect(disk.v).toBe(1);
    expect(Object.keys(disk).sort()).toEqual(['credentials', 'halted', 'journal', 'journalRef', 'nftDaily', 'setupTokenHash', 'spent', 'used', 'utxoLocks', 'v']);
    expect(disk.used[i.proposalId]).toBe(i.expiresAt); expect(disk.used[l.requestId]).toBe(l.expiresAt); // the same replay map as every other intent
    expect(disk.journal).toEqual([]);
    // what a reader that knows only the older fields takes from this file is intact
    const older = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
    expect(older.state.credentials).toEqual(store.state.credentials); expect(older.state.halted).toBe(false); expect(older.journalBrokenAt).toBeNull();
    // and the fixture from before V11 has none of the new fields, loads, and reports empty lists
    const p = mkdtempSync(join(tmpdir(), 'spw-signer-nft-old-'));
    copyFileSync(join(FIXTURE, 'policy-pre-v11.json'), join(p, 'policy.json')); copyFileSync(join(FIXTURE, 'state-pre-v11.json'), join(p, 'state.json'));
    const old = new Store(join(p, 'state.json'), join(p, 'policy.json'));
    expect(old.state.nftDaily).toBeUndefined(); expect(old.state.utxoLocks).toBeUndefined(); expect(old.state.nftAllow).toBeUndefined(); expect(old.journalBrokenAt).toBeNull();
  });
});
