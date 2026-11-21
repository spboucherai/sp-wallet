/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/nft/transfer.ts
 * Module           : nft
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

// NFT delivery 2 — preparation of ONE NFT transfer. docs/nft/NFT-TRANSFERS.md is the design note; this file is its API half.
//
//   prepare   re-verify on the chain (every endpoint must answer and agree: `rpcQuorum`) → build the canonical NftIntent →
//             run it through the SAME builder and verifier the signer runs → policy pre-check → simulate → proposal row
//             (kind 'nft', state pending_approval) with the review the owner reads and the passkey challenge = intent hash.
//
// The API is NOT a security authority here: everything it establishes (standard, ownership, state of the asset, destination,
// simulation) protects the owner from a transfer that fails or that he did not mean; what bounds a compromised API is the
// signer (nft.ts there). A refusal carries a stable code (`nft_transfer_<code>`), the on-chain identifiers, and never a URL.
import { encodeFunctionData, getAddress, hexToBigInt, hexToNumber, parseAbi } from 'viem';
import { associatedTokenAddress, buildNftEvmTx, buildNftSolMessage, checkNftPolicy, getNetwork, NFT_CORE_PROGRAM, NFT_SOL_SIGNATURE_FEE, NFT_TOKEN_METADATA_PROGRAM, NFT_TRANSFER_METHOD, nftIntentHash, NftIntentSchema, NftRefusal, nftSolWire,
  nftTokenRecordPda, nftMetadataPda, normalizeAddress, planNftSol, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, toHex, verifyNftEvmTx, verifyNftSolMessage, type NetworkDef, type NftIntent, type NftPolicy, type NftTransferStandard } from '@spw/core';
import { decodeCoreAsset, decodeCoreCollection, decodeTmMetadata, decodeTmTokenRecord, parseNftKey, parseTokenId, transferBlockReasons, transferWarnings, type NftAsset, type TransferBlockReason, type TransferWarning } from '@spw/nft';
import { base58 } from '@scure/base';
import { UserError } from '../config.ts';
import type { SignerStatus } from '../signer-client.ts';

export type QuorumFn = <T>(urls: string[], method: string, params: unknown[], same?: (a: T, b: T) => boolean) => Promise<T>;
export type AnyFn = <T>(urls: string[], method: string, params: unknown[]) => Promise<T>;
export interface TransferDeps { quorum: QuorumFn; any: AnyFn; lookup: (chain: string, ref: { address: string; tokenId?: string }, wallet: string | null) => Promise<NftAsset>; now: () => Date }

const erc165 = parseAbi(['function supportsInterface(bytes4 interfaceId) view returns (bool)']);
const erc721 = parseAbi(['function ownerOf(uint256 tokenId) view returns (address)']);
const erc1155 = parseAbi(['function balanceOf(address account, uint256 id) view returns (uint256)']);
const IF_721 = '0x80ac58cd', IF_1155 = '0xd9b67a26';
const b64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));
const b58 = (b: Uint8Array): string => base58.encode(b);

/** A refusal of a preparation: stable code, factual sentence, and the facts it rests on (`data`). */
export function blocked(code: string, message: string, data: Record<string, unknown> = {}, status = 422): UserError {
  return Object.assign(new UserError(`nft_transfer_${code}`, message, status), { data: { code, ...data } });
}

export interface TransferVerdict { transferable: boolean; blockedBy: TransferBlockReason[]; warnings: TransferWarning[]; standard: string; route: string | null }
/**
 * The per-asset verdict shown on the item page, from the stored facts and the signer's NFT policy. It replaces delivery 1's
 * constant `transfer_not_built`. The preparation re-reads the chain: this verdict is a display, not an authorisation.
 */
export function transferVerdict(a: NftAsset, policy: NftPolicy | null): TransferVerdict {
  const reasons = [...transferBlockReasons(a)];
  const std = a.standard as NftTransferStandard;
  const buildable = (Object.keys(NFT_TRANSFER_METHOD) as string[]).includes(a.standard);
  if (buildable && a.family === 'sol' && a.standard !== 'metaplex-core' && a.ownership.heldByWallet && a.ownerAddress && a.mintAddress && a.tokenProgram && a.ownership.tokenAccount.state === 'known'
    && a.ownership.tokenAccount.value !== associatedTokenAddress(a.ownerAddress, a.mintAddress, a.tokenProgram)) reasons.push('source_not_associated_account');
  if (buildable && a.ownership.heldByWallet && a.ownership.source.confidence !== 'chain_verified') reasons.push('ownership_single_source');
  if (buildable && policy && !(policy.enabled[a.chainId] ?? []).includes(std)) reasons.push('network_disabled_by_policy');
  return { transferable: reasons.length === 0, blockedBy: reasons, warnings: transferWarnings(a), standard: a.standard, route: buildable ? NFT_TRANSFER_METHOD[std] : null };
}

export interface NftReview {
  key: string; network: string; networkName: string; standard: string; method: string;
  /** contract (EVM) / mint or asset address (Solana) */ asset: string; tokenId: string | null; quantity: string; program: string; from: string; to: string;
  toKind: 'account' | 'contract' | 'new_account';
  fee: { estimate: string; max: string; symbol: string; decimals: number; /** Solana: lamports locked as rent in accounts this transfer creates (not a fee) */ rent: string | null };
  warnings: string[];
  simulation: { ok: true; detail: string; /** compute units / gas the simulation used */ used: string | null; /** delivery 3: `code` (+ `params`, `beforeCode`, `afterCode`) is what the interface translates; `what` / `before` / `after` stay as the English sentence (reviews stored by delivery 2 have only those) */
    changes: { what: string; before: string; after: string; code?: string; params?: Record<string, string>; beforeCode?: string; afterCode?: string }[] };
  verified: { standard: string; ownership: string; endpoints: number; at: string };
  /** every account of the main instruction (Solana), by role */ accounts: { role: string; address: string; derived: string }[];
  /** what the CREATOR declares — shown small, labelled unverified, never used to build anything */
  creatorMetadata: { name: string | null; collectionName: string | null; imageId: string | null };
}
export interface PreparedTransfer { intent: NftIntent; hash: string; review: NftReview; feeEstimate: bigint; maxFee: bigint; ttlSec: number }

function policyOf(st: SignerStatus): { nft: NftPolicy; signedToday: number; allowed: Set<string> } {
  const s = st as SignerStatus & { nft?: { policy: NftPolicy; signedToday: number; allow: { network: string; address: string }[] } };
  // a signer from before NFT delivery 2 reports no NFT section: nothing can be signed, so nothing is prepared
  if (!s.nft) throw blocked('signer_too_old', 'the signer does not support NFT transfers yet (its version predates them)', {}, 503);
  return { nft: s.nft.policy, signedToday: s.nft.signedToday, allowed: new Set(s.nft.allow.map((a) => `${a.network}:${a.address}`)) };
}
function precheck(st: SignerStatus, i: NftIntent, now: number): void {
  const p = policyOf(st);
  try { checkNftPolicy({ policy: st.policy, signedToday: p.signedToday, nowSec: now, halted: st.halted, allowed: p.allowed }, i); }
  catch (e) { if (e instanceof NftRefusal) throw blocked(e.code.replace(/^nft_/, 'policy_'), e.message, { policy: true }); throw e; }
}
const creator = (a: NftAsset): NftReview['creatorMetadata'] => ({ name: a.metadata.name ?? a.metadata.onchainName ?? null, collectionName: a.collection?.name ?? null, imageId: (a.media.find((m) => m.role === 'image') ?? a.media[0])?.id ?? null });

// ── EVM ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function prepareEvm(d: TransferDeps, n: NetworkDef, a: NftAsset, st: SignerStatus, wallet: string, toRaw: string, quantity: bigint, proposalId: string): Promise<PreparedTransfer> {
  const q = <T>(m: string, p: unknown[]) => d.quorum<T>(n.rpc, m, p), any = <T>(m: string, p: unknown[]) => d.any<T>(n.rpc, m, p);
  const pol = policyOf(st);
  if (hexToNumber(await q<`0x${string}`>('eth_chainId', [])) !== Number(n.chainRef)) throw blocked('rpc_identity', 'the endpoints do not answer for this network', {}, 503);
  const k = parseNftKey(a.key), [c0, t0] = k.assetId.split('/');
  const contract = getAddress(c0!), tokenId = parseTokenId(t0!);
  let to: `0x${string}`;
  try { to = normalizeAddress(n.id, toRaw) as `0x${string}`; } catch (e) { throw blocked('bad_destination', `invalid ${n.name} address: ${(e as Error).message}`, {}, 400); }
  if (to === wallet) throw blocked('destination_is_wallet', 'the destination is this wallet\'s own address');
  if (to === contract) throw blocked('destination_is_contract_itself', 'the destination is the token contract itself: the token would be lost');
  // 1. the contract: it has code, it is not a fungible token of the registry, and its STANDARD is established on every endpoint
  if ((await q<string>('eth_getCode', [contract, 'latest'])) === '0x') throw blocked('not_a_contract', 'there is no contract at this address on this network', { contract });
  if (n.tokens.some((t) => t.id.toLowerCase() === contract.toLowerCase())) throw blocked('contract_is_fungible_token', 'this contract is a registered fungible token, not an NFT collection', { contract });
  const call = async (data: `0x${string}`): Promise<`0x${string}` | null> => { try { return await q<`0x${string}`>('eth_call', [{ to: contract, data }, 'latest']); } catch (e) { if ((e as { rpcCode?: number }).rpcCode !== undefined || /revert|execution/i.test((e as Error).message)) return null; throw e; } };
  const flag = async (id: string) => { const r = await call(encodeFunctionData({ abi: erc165, functionName: 'supportsInterface', args: [id as `0x${string}`] })); return !!r && r.length === 66 && hexToBigInt(r) === 1n; };
  const [is721, is1155] = [await flag(IF_721), await flag(IF_1155)];
  const standard: 'erc721' | 'erc1155' | null = is721 && !is1155 ? 'erc721' : is1155 && !is721 ? 'erc1155' : null;
  if (!standard) throw blocked('non_standard_contract', is721 && is1155 ? 'this contract declares both ERC-721 and ERC-1155: its transfers are not built' : 'this contract declares neither ERC-721 nor ERC-1155 (ERC-165): its transfers are not built', { contract });
  if (a.standard !== standard) throw blocked('standard_changed', `the inventory holds this asset as ${a.standard} but the chain says ${standard}: refresh it`, { contract });
  // 2. behaviour + ownership, re-read now on every endpoint
  let ownership: string;
  if (standard === 'erc721') {
    if (quantity !== 1n) throw blocked('bad_quantity', 'an ERC-721 token is sent as one unit');
    const r = await call(encodeFunctionData({ abi: erc721, functionName: 'ownerOf', args: [tokenId] }));
    if (!r || r.length !== 66) throw blocked('non_standard_contract', 'the contract declares ERC-721 but does not answer ownerOf for this token', { contract, tokenId: tokenId.toString() });
    const owner = getAddress(`0x${r.slice(26)}`);
    if (owner !== wallet) throw blocked('not_owned', 'this token is not held by this wallet any more (ownerOf names another address)', { owner });
    ownership = `ownerOf(${tokenId}) = this wallet`;
  } else {
    if (quantity < 1n) throw blocked('bad_quantity', 'the quantity must be at least 1');
    const r = await call(encodeFunctionData({ abi: erc1155, functionName: 'balanceOf', args: [wallet as `0x${string}`, tokenId] }));
    if (!r || r.length !== 66) throw blocked('non_standard_contract', 'the contract declares ERC-1155 but does not answer balanceOf', { contract });
    const bal = hexToBigInt(r);
    if (bal < quantity) throw blocked('insufficient_quantity', `this wallet holds ${bal} unit(s) of this token id, fewer than the ${quantity} asked`, { balance: bal.toString() });
    if (quantity > BigInt(pol.nft.maxErc1155Quantity)) throw blocked('policy_quantity_cap', `the signer's policy allows at most ${pol.nft.maxErc1155Quantity} unit(s) per ERC-1155 transfer`, { max: pol.nft.maxErc1155Quantity });
    ownership = `balanceOf(this wallet, ${tokenId}) = ${bal}`;
  }
  // 3. the destination: an account or a contract (which must implement the receiver interface — the simulation says)
  const toCode = await q<string>('eth_getCode', [to, 'latest']);
  const toKind: NftReview['toKind'] = toCode === '0x' ? 'account' : 'contract';
  const warnings: string[] = [...transferWarnings(a), ...(toKind === 'contract' ? ['contract_recipient'] : [])];
  // 4. nonce (every endpoint) and fees — as the ordinary EVM send does
  const nonce = hexToNumber(await q<`0x${string}`>('eth_getTransactionCount', [wallet, 'pending']));
  if (nonce !== hexToNumber(await any<`0x${string}`>('eth_getTransactionCount', [wallet, 'latest']))) throw new UserError('pending_tx', 'a previous transaction from this wallet is still pending on this network', 409);
  const block = await any<{ baseFeePerGas?: `0x${string}` }>('eth_getBlockByNumber', ['latest', false]);
  if (!block?.baseFeePerGas) throw new UserError('rpc_degraded', 'network did not report a base fee', 503);
  const baseFee = hexToBigInt(block.baseFeePerGas);
  let tip = 1_000_000n;
  try { tip = hexToBigInt(await any<`0x${string}`>('eth_maxPriorityFeePerGas', [])); } catch { /* keep floor */ }
  if (n.id === 'polygon' && tip < 30_000_000_000n) tip = 30_000_000_000n;
  // 5. simulate the exact call from the wallet: a revert (receiver interface missing, token locked by the collection, …) stops here, before any passkey prompt
  const draft: NftIntent = { v: 1, kind: 'nft-transfer', proposalId, keyId: st.keyId, network: n.id, chainRef: n.chainRef, standard, asset: contract, tokenId: tokenId.toString(), quantity: quantity.toString(), program: contract, from: wallet, to,
    maxFee: '0', createdAt: 1, expiresAt: 2, policyVersion: st.policy.version, nftPolicyVersion: pol.nft.version, evm: { nonce, gasLimit: '21000', maxFeePerGas: '0', maxPriorityFeePerGas: '0' } };
  const data = buildNftEvmTx(draft).data!;
  try { await any<`0x${string}`>('eth_call', [{ from: wallet, to: contract, data }, 'latest']); }
  catch (e) {
    if ((e as { rpcCode?: number }).rpcCode === undefined) throw e;
    const reason = (e as Error).message.replace(/^execution reverted:?\s*/i, '').slice(0, 200) || 'no reason given';
    throw blocked('simulation_reverted', toKind === 'contract' ? `the transfer would revert: ${reason} — the destination is a contract and does not accept this token (it must implement the receiver interface)` : `the transfer would revert: ${reason}`, { reason, toKind });
  }
  let est: bigint;
  try { est = hexToBigInt(await any<`0x${string}`>('eth_estimateGas', [{ from: wallet, to: contract, data }])); }
  catch (e) { throw blocked('simulation_reverted', `the transfer would revert: ${(e as Error).message.slice(0, 200)}`, { toKind }); }
  const gas = (est * 13n) / 10n + 10_000n;
  if (gas > 500_000n) throw blocked('gas_too_high', 'this collection\'s transfer needs more gas than this wallet allows for an NFT transfer (500 000)', { estimate: est.toString() });
  // the fee ceiling is the EXISTING policy ceiling of the network: the max fee per gas is lowered to fit it, never the ceiling raised
  const ceiling = BigInt(st.policy.maxFee[n.id] ?? '0');
  let maxFeePerGas = baseFee * 2n + tip;
  if (gas * maxFeePerGas > ceiling) maxFeePerGas = ceiling / gas;
  if (maxFeePerGas < baseFee + (tip < baseFee ? tip : 0n) || maxFeePerGas === 0n) throw blocked('fee_above_policy', `the network fee of this transfer (about ${gas * (baseFee + tip)} wei) is above the signer's fee ceiling for ${n.name} (${ceiling} wei)`, { needed: (gas * (baseFee + tip)).toString(), ceiling: ceiling.toString() });
  if (tip > maxFeePerGas) tip = maxFeePerGas;
  const maxFee = gas * maxFeePerGas, feeEstimate = gas * (baseFee + tip) < maxFee ? gas * (baseFee + tip) : maxFee;
  if (hexToBigInt(await any<`0x${string}`>('eth_getBalance', [wallet, 'latest'])) < maxFee) throw new UserError('insufficient_gas', `not enough ${n.native.symbol} on ${n.name} to pay the network fee`);
  const nowSec = Math.floor(d.now().getTime() / 1000), ttlSec = 180;
  const intent = NftIntentSchema.parse({ ...draft, maxFee: maxFee.toString(), createdAt: nowSec, expiresAt: nowSec + ttlSec, evm: { nonce, gasLimit: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: tip.toString() } });
  // the same builder and the same independent verifier the signer runs: an unsupported shape fails here, before approval
  try { verifyNftEvmTx(buildNftEvmTx(intent) as unknown as Record<string, unknown>, intent); } catch (e) { throw blocked(e instanceof NftRefusal ? e.code.replace(/^nft_/, '') : 'unsupported', (e as Error).message); }
  precheck(st, intent, nowSec);
  return { intent, hash: toHex(nftIntentHash(intent)), feeEstimate, maxFee, ttlSec,
    review: { key: a.key, network: n.id, networkName: n.name, standard, method: NFT_TRANSFER_METHOD[standard], asset: contract, tokenId: tokenId.toString(), quantity: quantity.toString(), program: contract, from: wallet, to, toKind,
      fee: { estimate: feeEstimate.toString(), max: maxFee.toString(), symbol: n.native.symbol, decimals: n.native.decimals, rent: null }, warnings,
      simulation: { ok: true, detail: 'eth_call from the wallet address succeeded', used: est.toString(), changes: [{ code: standard === 'erc721' ? 'evm_owner_of_token' : 'evm_units_sent', params: { tokenId: tokenId.toString() }, what: standard === 'erc721' ? `owner of token ${tokenId}` : `units of id ${tokenId} sent`, before: standard === 'erc721' ? wallet : '0', after: standard === 'erc721' ? to : quantity.toString() }] },
      verified: { standard: `ERC-165: ${standard === 'erc721' ? 'ERC-721' : 'ERC-1155'} declared, and ${standard === 'erc721' ? 'ownerOf' : 'balanceOf'} answers`, ownership, endpoints: n.rpc.length, at: d.now().toISOString() },
      accounts: [], creatorMetadata: creator(a) } };
}

// ── Solana ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
interface RawAcct { owner: string; lamports: number; data: [string, string] }
const sameValue = (a: { value: unknown }, b: { value: unknown }) => JSON.stringify(a.value) === JSON.stringify(b.value);
/** SPL token account (the first 165 bytes are the same in Token and Token-2022). */
function decodeTokenAccount(b: Uint8Array): { mint: string; owner: string; amount: bigint; delegate: string | null; state: number } {
  if (b.length < 165) throw new Error('short token account');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { mint: b58(b.subarray(0, 32)), owner: b58(b.subarray(32, 64)), amount: v.getBigUint64(64, true), delegate: v.getUint32(72, true) === 1 && v.getBigUint64(121, true) > 0n ? b58(b.subarray(76, 108)) : null, state: b[108]! };
}

async function prepareSol(d: TransferDeps, n: NetworkDef, a: NftAsset, st: SignerStatus, wallet: string, toRaw: string, quantity: bigint, proposalId: string): Promise<PreparedTransfer> {
  const any = <T>(m: string, p: unknown[]) => d.any<T>(n.rpc, m, p), pol = policyOf(st);
  if ((await d.quorum<string>(n.rpc, 'getGenesisHash', [])) !== n.chainRef) throw blocked('rpc_identity', 'cluster identity mismatch', {}, 503);
  if (quantity !== 1n) throw blocked('bad_quantity', 'a Solana NFT is sent as one unit');
  let to: string;
  try { to = normalizeAddress(n.id, toRaw); } catch (e) { throw blocked('bad_destination', `invalid Solana address: ${(e as Error).message}`, {}, 400); }
  if (to === wallet) throw blocked('destination_is_wallet', 'the destination is this wallet\'s own address');
  const std = a.standard as NftTransferStandard, asset = a.mintAddress ?? a.assetId;
  const core = std === 'metaplex-core', pnft = std === 'metaplex-pnft', tm = pnft || std === 'metaplex-token-metadata';
  const tokenProgram = core ? null : a.tokenProgram === TOKEN_2022_PROGRAM ? 'token2022' as const : a.tokenProgram === TOKEN_PROGRAM ? 'token' as const : null;
  if (!core && !tokenProgram) throw blocked('unsupported_standard', 'the mint is not owned by a token program this wallet knows');
  if (std === 'spl-token-2022' && tokenProgram !== 'token2022') throw blocked('unsupported_standard', 'not a Token-2022 mint');
  const tp = tokenProgram === 'token2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
  const src = core ? null : associatedTokenAddress(wallet, asset, tp), dst = core ? null : associatedTokenAddress(to, asset, tp);
  const collectionId = core ? a.collection?.id ?? null : null, ruleSet = pnft && a.ruleSet.state === 'known' ? a.ruleSet.value : null;

  // 1. the decisive accounts, re-read now on EVERY endpoint (finalized); every endpoint must return the same bytes
  const addrs = core ? [asset, ...(collectionId ? [collectionId] : [])] : [asset, src!, nftMetadataPda(asset), ...(pnft ? [nftTokenRecordPda(asset, src!)] : [])];
  const r = await d.quorum<{ value: (RawAcct | null)[] }>(n.rpc, 'getMultipleAccounts', [addrs, { encoding: 'base64', commitment: 'finalized' }], sameValue);
  const raw = (k: number) => { const v = r.value[k]; return v ? { owner: v.owner, data: b64(v.data[0]) } : null; };
  let ownership: string;
  if (core) {
    const acct = raw(0);
    if (!acct || acct.owner !== NFT_CORE_PROGRAM) throw blocked('not_owned', 'this asset no longer exists as a Core asset (burned or closed)');
    const ca = decodeCoreAsset(acct.data);
    if (ca.owner !== wallet) throw blocked('not_owned', 'this asset is not held by this wallet any more', { owner: ca.owner });
    const inColl = ca.updateAuthority.type === 'Collection' ? ca.updateAuthority.address : null;
    if (inColl !== collectionId) throw blocked('state_changed', 'the asset\'s collection changed since it was read: refresh it');
    let plugins = [...ca.plugins.plugins], complete = ca.plugins.complete;
    if (collectionId) { const cAcct = raw(1); if (!cAcct || cAcct.owner !== NFT_CORE_PROGRAM) throw blocked('state_changed', 'the collection account could not be read'); const cc = decodeCoreCollection(cAcct.data); plugins = [...plugins, ...cc.plugins.plugins]; complete &&= cc.plugins.complete; }
    if (!complete) throw blocked('ownership_unknown', 'the plugins of this asset could not be fully decoded: its frozen state is not established');
    if (plugins.some((p) => (p.type === 'FreezeDelegate' || p.type === 'PermanentFreezeDelegate') && p.frozen === true)) throw blocked('frozen', 'this asset is frozen (freeze plugin): it cannot be transferred until its freeze authority thaws it');
    if (ca.plugins.plugins.some((p) => p.type === 'TransferDelegate' && p.authority.type === 'Address')) throw blocked('delegated', 'a transfer delegate is set on this asset (it may be listed on a marketplace): revoke it before sending');
    ownership = 'Core asset account: owner = this wallet, not frozen';
  } else {
    const mint = raw(0), tok = raw(1), md = raw(2);
    if (!mint || mint.owner !== tp) throw blocked('state_changed', 'the mint is not owned by the expected token program');
    if (!tok || tok.owner !== tp) throw blocked('source_not_associated_account', 'this wallet\'s associated token account does not hold this NFT (it may sit in another token account, or have left the wallet)');
    const t = decodeTokenAccount(tok.data);
    if (t.mint !== asset || t.owner !== wallet) throw blocked('not_owned', 'the token account is not this wallet\'s account for this mint');
    if (t.amount !== 1n) throw blocked('not_owned', 'this wallet\'s token account no longer holds the NFT', { amount: t.amount.toString() });
    if (tm) {
      if (!md || md.owner !== NFT_TOKEN_METADATA_PROGRAM) throw blocked('state_changed', 'the metadata account could not be read');
      const m = decodeTmMetadata(md.data), isP = m.tokenStandard === 'ProgrammableNonFungible' || m.tokenStandard === 'ProgrammableNonFungibleEdition';
      // a programmable NFT is NEVER moved as an ordinary NFT, and the other way round
      if (isP !== pnft) throw blocked('standard_changed', 'the token standard on-chain differs from the inventory: refresh it');
      if (pnft) {
        if ((m.programmableConfig?.ruleSet ?? null) !== ruleSet) throw blocked('state_changed', 'the rule set of this programmable NFT changed since it was read: refresh it');
        const rec = raw(3);
        if (!rec || rec.owner !== NFT_TOKEN_METADATA_PROGRAM) throw blocked('ownership_unknown', 'the token record of this programmable NFT could not be read');
        const tr = decodeTmTokenRecord(rec.data);
        if (tr.state === 'locked') throw blocked('pnft_locked', 'this programmable NFT is LOCKED (token record state "locked" — typically staked or locked by a delegate): it cannot be transferred until unlocked', { delegate: tr.delegate, role: tr.delegateRole });
        if (tr.state === 'listed') throw blocked('pnft_listed', 'this programmable NFT is LISTED (token record state "listed" — a marketplace sale delegate holds it): cancel the listing before sending', { delegate: tr.delegate, role: tr.delegateRole });
        if (tr.delegate) throw blocked('delegated', `a delegate (${tr.delegateRole ?? 'unknown role'}) is set on this programmable NFT: revoke it before sending`, { delegate: tr.delegate, role: tr.delegateRole });
        ownership = 'token account: owner = this wallet, amount 1; token record: unlocked, no delegate';
      } else {
        if (t.state === 2) throw blocked('frozen', 'this NFT\'s token account is frozen: it cannot be transferred until its freeze authority thaws it');
        if (t.delegate) throw blocked('delegated', 'a delegate is approved on this NFT\'s token account (it may be listed on a marketplace): revoke it before sending', { delegate: t.delegate });
        ownership = 'token account: owner = this wallet, amount 1, not frozen, no delegate';
      }
    } else {
      if (t.state === 2) throw blocked('frozen', 'this NFT\'s token account is frozen: it cannot be transferred until its freeze authority thaws it');
      if (t.delegate) throw blocked('delegated', 'a delegate is approved on this NFT\'s token account: revoke it before sending', { delegate: t.delegate });
      ownership = 'token account: owner = this wallet, amount 1, not frozen, no delegate';
    }
  }
  // 2. the destination: a wallet (system-owned account) or an address with no account yet — never a program or a token account
  const dest = (await any<{ value: { owner: string } | null }>('getAccountInfo', [to, { encoding: 'base64', commitment: 'confirmed' }])).value;
  if (dest && dest.owner !== SYSTEM_PROGRAM) throw blocked('bad_destination', 'the destination is not a regular wallet address (it is a program-owned or token account)');
  const dstExists = dst ? !!(await any<{ value: unknown | null }>('getAccountInfo', [dst, { encoding: 'base64', commitment: 'confirmed' }])).value : true;
  const warnings: string[] = [...transferWarnings(a), ...(!dstExists ? ['creates_token_account'] : [])];

  // 3. blockhash and budget (as the ordinary Solana send), bounded by the policy; the limit comes from a first simulation
  let price = 5_000n;
  try { const fees = await any<{ prioritizationFee: number }[]>('getRecentPrioritizationFees', [[wallet]]); const s = fees.map((f) => f.prioritizationFee).sort((x, y) => x - y); price = BigInt(Math.min(2_000_000, Math.max(5_000, s[Math.floor(s.length * 0.75)] ?? 0))); } catch { /* default */ }
  if (price > BigInt(pol.nft.maxComputeUnitPrice)) price = BigInt(pol.nft.maxComputeUnitPrice);
  const bh = await any<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const nowSec = Math.floor(d.now().getTime() / 1000), ttlSec = 50, ceiling = BigInt(st.policy.maxFee[n.id] ?? '0');
  const make = (limit: number): NftIntent => { const fee = NFT_SOL_SIGNATURE_FEE + (BigInt(limit) * price + 999_999n) / 1_000_000n;
    return NftIntentSchema.parse({ v: 1, kind: 'nft-transfer', proposalId, keyId: st.keyId, network: n.id, chainRef: n.chainRef, standard: std, asset, quantity: '1', program: core ? NFT_CORE_PROGRAM : tm ? NFT_TOKEN_METADATA_PROGRAM : tp, from: wallet, to,
      maxFee: fee.toString(), createdAt: nowSec, expiresAt: nowSec + ttlSec, policyVersion: st.policy.version, nftPolicyVersion: pol.nft.version,
      sol: { recentBlockhash: bh.value.blockhash, lastValidBlockHeight: bh.value.lastValidBlockHeight, computeUnitLimit: limit, computeUnitPrice: price.toString(), ...(tokenProgram ? { tokenProgram } : {}), ...(std === 'spl-token-2022' ? { createAta: !dstExists } : {}),
        ...(ruleSet ? { ruleSet } : {}), ...(collectionId ? { collection: collectionId } : {}) } }); };
  const watch = core ? [asset, wallet] : [src!, dst!, wallet];
  const simulate = async (i: NftIntent) => {
    let msg: Uint8Array;
    try { msg = buildNftSolMessage(i); verifyNftSolMessage(msg, i); } catch (e) { throw blocked(e instanceof NftRefusal ? e.code.replace(/^nft_/, '') : 'unsupported', (e as Error).message); }
    const wire = Buffer.from(nftSolWire(new Uint8Array(64), msg)).toString('base64');
    const s = await any<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number; accounts?: ({ owner: string; lamports: number; data: [string, string] } | null)[] | null } }>('simulateTransaction', [wire, { encoding: 'base64', sigVerify: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watch } }]);
    if (s.value.err) { const tail = (s.value.logs ?? []).filter((l) => /log:|failed|Error/i.test(l)).slice(-3).join(' | ').slice(0, 300);
      throw blocked('simulation_failed', `the transfer would fail on-chain: ${JSON.stringify(s.value.err).slice(0, 120)}${tail ? ` — ${tail}` : ''}`, { err: JSON.stringify(s.value.err).slice(0, 200) }); }
    return s.value;
  };
  const cap = pol.nft.maxComputeUnits;
  const first = await simulate(make(cap));
  const limit = Math.min(cap, Math.ceil((first.unitsConsumed ?? cap) * 1.3) + 10_000);
  const intent = make(limit), fee = BigInt(intent.maxFee);
  if (fee > ceiling) throw blocked('fee_above_policy', `the network fee of this transfer (${fee} lamports) is above the signer's fee ceiling for Solana (${ceiling})`, { needed: fee.toString(), ceiling: ceiling.toString() });
  const sim = await simulate(intent); // the exact bytes the signer will build
  // 4. what the simulation says changes: the NFT leaves the wallet for the destination; no delegate is left on either side
  const before = await any<{ value: (RawAcct | null)[] }>('getMultipleAccounts', [watch, { encoding: 'base64', commitment: 'confirmed' }]);
  const post = sim.accounts ?? [], changes: NftReview['simulation']['changes'] = [];
  const lam = (k: number, v: { value: (RawAcct | null)[] } | typeof post) => BigInt((Array.isArray(v) ? v[k] : v.value[k])?.lamports ?? 0);
  if (core) {
    const after = post[0] ? decodeCoreAsset(b64(post[0].data[0])) : null;
    if (!after || after.owner !== to) throw blocked('simulation_unexpected', 'the simulation did not end with the destination as owner of the asset');
    if (after.plugins.plugins.some((p) => p.type === 'TransferDelegate' && p.authority.type === 'Address')) throw blocked('simulation_unexpected', 'the simulation left a transfer delegate on the asset');
    changes.push({ code: 'sol_core_owner', what: 'owner of the asset', before: wallet, after: after.owner });
  } else {
    const s1 = post[0] ? decodeTokenAccount(b64(post[0].data[0])) : null, d1 = post[1] ? decodeTokenAccount(b64(post[1].data[0])) : null;
    if (!d1 || d1.owner !== to || d1.mint !== asset || d1.amount !== 1n) throw blocked('simulation_unexpected', 'the simulation did not end with the NFT in the destination\'s token account');
    if (s1 && s1.amount !== 0n) throw blocked('simulation_unexpected', 'the simulation did not empty the wallet\'s token account');
    if (d1.delegate || s1?.delegate) throw blocked('simulation_unexpected', 'the simulation left a delegate on a token account');
    changes.push({ code: 'sol_wallet_token_units', what: 'units in the wallet\'s token account', before: '1', after: s1 ? '0' : '0 (account closed)', ...(s1 ? {} : { afterCode: 'account_closed' }) },
      { code: 'sol_destination_token_units', params: { owner: to }, what: `units in the destination's token account (owner ${to})`, before: dstExists ? '0' : 'no account', after: '1', ...(dstExists ? {} : { beforeCode: 'no_account' }) });
  }
  const wi = watch.length - 1, lamBefore = lam(wi, before), lamAfter = lam(wi, post);
  // the fee payer's balance after a simulation has the fee deducted (measured on Agave 4.4.1, scripts/validator-nft-solana.mts: what the
  // wallet really spent equals this figure): what leaves beyond the fee is the rent locked in the accounts the transfer creates
  const out = lamBefore > lamAfter ? lamBefore - lamAfter : 0n, rent = out > fee ? out - fee : 0n;
  changes.push({ code: 'sol_wallet_lamports', what: 'SOL of the wallet (lamports), fee and rent of created accounts', before: lamBefore.toString(), after: lamAfter.toString() });
  precheck(st, intent, nowSec);
  const plan = planNftSol(intent);
  return { intent, hash: toHex(nftIntentHash(intent)), feeEstimate: fee, maxFee: fee, ttlSec,
    review: { key: a.key, network: n.id, networkName: n.name, standard: std, method: NFT_TRANSFER_METHOD[std], asset, tokenId: null, quantity: '1', program: intent.program, from: wallet, to, toKind: dest ? 'account' : 'new_account',
      fee: { estimate: fee.toString(), max: fee.toString(), symbol: n.native.symbol, decimals: n.native.decimals, rent: rent.toString() }, warnings,
      simulation: { ok: true, detail: 'simulateTransaction of the exact message succeeded', used: String(sim.unitsConsumed ?? ''), changes },
      verified: { standard: `${std}: accounts owned by ${intent.program === tp ? 'the token program' : intent.program === NFT_CORE_PROGRAM ? 'the Core program' : 'the token program, metadata by Token Metadata'}`, ownership, endpoints: n.rpc.length, at: d.now().toISOString() },
      accounts: plan.accounts, creatorMetadata: creator(a) } };
}

/** The exact sentence of each block reason (English; the interface has its own FR / EN texts keyed by the same codes). */
export const BLOCK_TEXT: Partial<Record<TransferBlockReason, string>> = {
  not_in_wallet: 'this NFT is not held by this wallet (the chain names another holder)',
  burned: 'this NFT was burned: it no longer exists',
  ownership_unknown: 'the holder or the state of this NFT could not be established on-chain: nothing is prepared',
  ownership_single_source: 'the endpoints did not agree on the ownership of this NFT (or only one answered): nothing is prepared',
  escrow: 'this NFT is held by another account (an escrow or a delegate), not by this wallet',
  frozen: 'this NFT is FROZEN: it cannot be transferred until its freeze authority thaws it',
  pnft_locked: 'this programmable NFT is LOCKED (token record state "locked" — typically staked, or locked by a delegate): it cannot be transferred until it is unlocked',
  pnft_listed: 'this programmable NFT is LISTED (token record state "listed" — a marketplace sale delegate holds it): cancel the listing before sending',
  delegated: 'a delegate is set on this NFT (it may be listed on a marketplace): revoke it before sending',
  soulbound: 'this token is NON-TRANSFERABLE (Token-2022 NonTransferable extension): it can never be sent',
  token2022_extension_unsupported: 'this Token-2022 mint carries an extension this wallet does not account for (transfer hook, permanent delegate, transfer fee, confidential transfer, default account state, …): its transfer is not built',
  compressed_transfer_not_supported: 'compressed NFT: its transfer needs a merkle proof verified against the on-chain tree, which this wallet does not do — not transferable here',
  ordinals_transfer_not_supported: 'Bitcoin inscription: this wallet builds no inscription transfer — not transferable here',
  unsupported_standard: 'this standard has no transfer builder in this wallet (non-standard contract, or a plain token without NFT metadata)',
  source_not_associated_account: 'this NFT sits in a token account that is not this wallet\'s associated token account: its transfer is not built',
  network_disabled_by_policy: 'the signer\'s policy does not enable transfers of this standard on this network',
};

/**
 * Re-verify, build, simulate. `a` is the asset as just looked up on every endpoint (the caller does it); `st` the signer's
 * status read now. Throws a `blocked` refusal (422) with the factual reason, or returns what the owner will approve.
 */
export async function prepareNftTransfer(d: TransferDeps, a: NftAsset, st: SignerStatus, wallet: string, to: string, quantity: bigint, proposalId: string): Promise<PreparedTransfer> {
  const n = getNetwork(a.chainId), pol = policyOf(st);
  if (st.halted) throw new UserError('halted', 'emergency halt is active', 423);
  const v = transferVerdict(a, pol.nft);
  if (!v.transferable) throw blocked(v.blockedBy[0]!, BLOCK_TEXT[v.blockedBy[0]!] ?? `this NFT cannot be sent (${v.blockedBy[0]})`, { blockedBy: v.blockedBy, standard: a.standard });
  if (n.family === 'evm') return prepareEvm(d, n, a, st, wallet, to, quantity, proposalId);
  if (n.family === 'sol') return prepareSol(d, n, a, st, wallet, to, quantity, proposalId);
  throw blocked('unsupported_standard', 'NFT transfers are built for EVM networks and Solana only');
}
