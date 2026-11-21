/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/core/src/nft-intent.ts
 * Module           : core
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

// NFT delivery 2 — the canonical objects the owner's passkey approves for NFTs, and nothing else:
//
//   NftIntent        ONE transfer of ONE NFT (or of `quantity` units of one ERC-1155 id) from the wallet's own address.
//   UtxoLockIntent   a change of the signer's own lock list of Bitcoin-style outpoints (inscription safety).
//   NftAllowIntent   a change of the signer's own list of destinations allowed to receive NFTs (allow-list mode).
//
// They are NEW types with their OWN domain separators. The transfer intent of intent.ts (`SPW-INTENT-v1`) is not touched: not
// one field, not one byte of its canonical form, so every existing intent hashes exactly as before (pinned by
// packages/core/test/nft-intent.test.ts on fixed vectors). An NFT intent can never be read as a fund transfer or the other
// way round: the schemas are strict (unknown keys refused), the domains differ, and the signer has one route per type.
//
// There is no calldata, no instruction list and no "data" field here by design: the signer BUILDS the transaction from these
// semantic fields (nft-evm.ts, nft-sol.ts). What is not a field cannot be asked for.
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';

const U = z.string().regex(/^(0|[1-9]\d{0,77})$/);
const NETWORK = z.string().min(2).max(24).regex(/^[a-z0-9-]+$/);
const SOL_ADDR = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const TXID = z.string().regex(/^[0-9a-f]{64}$/);

/** Standards a transfer can be built for. Anything else (compressed NFTs, inscriptions, non-standard contracts) has no builder. */
export const NFT_TRANSFER_STANDARDS = ['erc721', 'erc1155', 'spl-token-2022', 'metaplex-token-metadata', 'metaplex-pnft', 'metaplex-core'] as const;
export type NftTransferStandard = (typeof NFT_TRANSFER_STANDARDS)[number];
/** The one call each standard is transferred with — shown on the review sheet; it is implied by `standard`, never chosen by the API. */
export const NFT_TRANSFER_METHOD: Record<NftTransferStandard, string> = {
  erc721: 'safeTransferFrom(address,address,uint256)',
  erc1155: 'safeTransferFrom(address,address,uint256,uint256,bytes) — data empty',
  'spl-token-2022': 'Token-2022 TransferChecked (amount 1, decimals 0)',
  'metaplex-token-metadata': 'Token Metadata Transfer (TransferArgs::V1, amount 1, no authorization data)',
  'metaplex-pnft': 'Token Metadata Transfer (TransferArgs::V1, amount 1, no authorization data) with token records',
  'metaplex-core': 'Core TransferV1 (no compression proof)',
};

export const NftIntentSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('nft-transfer'),
  proposalId: z.uuid(),
  keyId: z.string().min(8).max(80),
  network: NETWORK,
  chainRef: z.string().min(1).max(80),
  standard: z.enum(NFT_TRANSFER_STANDARDS),
  /** EVM: the token contract (EIP-55). Solana: the mint (SPL, Token Metadata) or the asset address (Core). */
  asset: z.string().min(32).max(44),
  /** EVM: the uint256 token id as a decimal string. Solana: absent (the mint / asset address IS the identity). */
  tokenId: U.optional(),
  /** units moved: exactly 1 for every standard except ERC-1155 (≥ 1, capped by the signer's policy) */
  quantity: U,
  /** the contract / program the transaction calls. EVM: equal to `asset`. Solana: the pinned program of the standard. */
  program: z.string().min(32).max(44),
  from: z.string().min(32).max(44),
  to: z.string().min(32).max(44),
  /** fee ceiling in base units of the network's native coin (gas × max fee per gas; signature fee + priority fee) */
  maxFee: U,
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  policyVersion: z.number().int().nonnegative(),
  /** version of the NFT section of the signer's policy (nft-policy.ts) */
  nftPolicyVersion: z.number().int().nonnegative(),
  evm: z.strictObject({ nonce: z.number().int().nonnegative(), gasLimit: U, maxFeePerGas: U, maxPriorityFeePerGas: U }).optional(),
  sol: z.strictObject({
    recentBlockhash: z.string().min(32).max(44), lastValidBlockHeight: z.number().int().positive(),
    computeUnitLimit: z.number().int().min(1).max(400_000), computeUnitPrice: U,
    /** SPL / Token Metadata: which token program owns the mint. Absent for Core. */
    tokenProgram: z.enum(['token', 'token2022']).optional(),
    /** Token-2022 plain transfer only: prepend the idempotent creation of the recipient's associated token account */
    createAta: z.boolean().optional(),
    /** pNFT only: the rule set account named by the metadata's programmable config (absent = the pNFT has none) */
    ruleSet: SOL_ADDR.optional(),
    /** Core only: the collection the asset belongs to (absent = the asset is in no collection) */
    collection: SOL_ADDR.optional(),
  }).optional(),
});
export type NftIntent = z.infer<typeof NftIntentSchema>;

const enc = new TextEncoder();
/** Deterministic, length-prefixed, domain-separated serialization (the same framing as intent.ts, under another domain). */
function frame(domain: string, fields: [string, string][]): Uint8Array {
  const parts: Uint8Array[] = [enc.encode(domain), new Uint8Array([0])];
  for (const [k, v] of fields) {
    const kb = enc.encode(k), vb = enc.encode(v);
    const head = new Uint8Array(6);
    new DataView(head.buffer).setUint16(0, kb.length);
    new DataView(head.buffer).setUint32(2, vb.length);
    parts.push(head, kb, vb);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const NFT_INTENT_DOMAIN = 'SPW-NFT-INTENT-v1';
/** Field order is fixed by this code, never by JSON key order. An absent optional field is absent from the bytes. */
export function nftCanonicalBytes(intent: NftIntent): Uint8Array {
  const i = NftIntentSchema.parse(intent);
  if (!!i.evm === !!i.sol) throw new Error('an NFT intent carries exactly one chain section');
  const f: [string, string][] = [
    ['v', String(i.v)], ['kind', i.kind], ['proposalId', i.proposalId], ['keyId', i.keyId], ['network', i.network], ['chainRef', i.chainRef],
    ['standard', i.standard], ['asset', i.asset], ['quantity', i.quantity], ['program', i.program], ['from', i.from], ['to', i.to], ['maxFee', i.maxFee],
    ['createdAt', String(i.createdAt)], ['expiresAt', String(i.expiresAt)], ['policyVersion', String(i.policyVersion)], ['nftPolicyVersion', String(i.nftPolicyVersion)],
  ];
  if (i.tokenId !== undefined) f.push(['tokenId', i.tokenId]);
  if (i.evm) f.push(['evm.nonce', String(i.evm.nonce)], ['evm.gasLimit', i.evm.gasLimit], ['evm.maxFeePerGas', i.evm.maxFeePerGas], ['evm.maxPriorityFeePerGas', i.evm.maxPriorityFeePerGas]);
  if (i.sol) {
    f.push(['sol.recentBlockhash', i.sol.recentBlockhash], ['sol.lastValidBlockHeight', String(i.sol.lastValidBlockHeight)], ['sol.computeUnitLimit', String(i.sol.computeUnitLimit)], ['sol.computeUnitPrice', i.sol.computeUnitPrice]);
    if (i.sol.tokenProgram !== undefined) f.push(['sol.tokenProgram', i.sol.tokenProgram]);
    if (i.sol.createAta !== undefined) f.push(['sol.createAta', i.sol.createAta ? '1' : '0']);
    if (i.sol.ruleSet !== undefined) f.push(['sol.ruleSet', i.sol.ruleSet]);
    if (i.sol.collection !== undefined) f.push(['sol.collection', i.sol.collection]);
  }
  return frame(NFT_INTENT_DOMAIN, f);
}
export const nftIntentHash = (intent: NftIntent): Uint8Array => sha256(nftCanonicalBytes(intent));

// ── UTXO lock list (Bitcoin inscription safety) ─────────────────────────────────────────────────────────────────────────
/** Why an outpoint is locked. `ord`: an ord server reported an inscription or a rune on it; `heuristic`: flagged by size only. */
export const UTXO_LOCK_REASONS = ['owner', 'ord', 'heuristic'] as const;
export const UtxoLockIntentSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('utxo-locks'),
  requestId: z.uuid(),
  keyId: z.string().min(8).max(80),
  network: NETWORK,
  action: z.enum(['lock', 'unlock']),
  reason: z.enum(UTXO_LOCK_REASONS),
  outpoints: z.array(z.strictObject({ txid: TXID, vout: z.number().int().min(0).max(0xffffffff) })).min(1).max(100),
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  policyVersion: z.number().int().nonnegative(),
});
export type UtxoLockIntent = z.infer<typeof UtxoLockIntentSchema>;
export const UTXO_LOCK_DOMAIN = 'SPW-UTXO-LOCKS-v1';
export const outpointKey = (o: { txid: string; vout: number }): string => `${o.txid}:${o.vout}`;
export function utxoLockBytes(intent: UtxoLockIntent): Uint8Array {
  const i = UtxoLockIntentSchema.parse(intent);
  if (new Set(i.outpoints.map(outpointKey)).size !== i.outpoints.length) throw new Error('duplicate outpoint');
  const f: [string, string][] = [['v', String(i.v)], ['kind', i.kind], ['requestId', i.requestId], ['keyId', i.keyId], ['network', i.network], ['action', i.action], ['reason', i.reason],
    ['outpoints.count', String(i.outpoints.length)]];
  i.outpoints.forEach((o, k) => f.push([`outpoints.${k}.txid`, o.txid], [`outpoints.${k}.vout`, String(o.vout)]));
  f.push(['createdAt', String(i.createdAt)], ['expiresAt', String(i.expiresAt)], ['policyVersion', String(i.policyVersion)]);
  return frame(UTXO_LOCK_DOMAIN, f);
}
export const utxoLockHash = (intent: UtxoLockIntent): Uint8Array => sha256(utxoLockBytes(intent));

// ── NFT destination allow-list ──────────────────────────────────────────────────────────────────────────────────────────
export const NftAllowIntentSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('nft-allow'),
  requestId: z.uuid(),
  keyId: z.string().min(8).max(80),
  network: NETWORK,
  action: z.enum(['add', 'remove']),
  /** the destination, in the normalized form of its network */
  address: z.string().min(32).max(44),
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  policyVersion: z.number().int().nonnegative(),
});
export type NftAllowIntent = z.infer<typeof NftAllowIntentSchema>;
export const NFT_ALLOW_DOMAIN = 'SPW-NFT-ALLOW-v1';
export function nftAllowBytes(intent: NftAllowIntent): Uint8Array {
  const i = NftAllowIntentSchema.parse(intent);
  return frame(NFT_ALLOW_DOMAIN, [['v', String(i.v)], ['kind', i.kind], ['requestId', i.requestId], ['keyId', i.keyId], ['network', i.network], ['action', i.action], ['address', i.address],
    ['createdAt', String(i.createdAt)], ['expiresAt', String(i.expiresAt)], ['policyVersion', String(i.policyVersion)]]);
}
export const nftAllowHash = (intent: NftAllowIntent): Uint8Array => sha256(nftAllowBytes(intent));

/** A refusal of an NFT builder or of the NFT policy, with a STABLE code (docs/nft/NFT-TRANSFERS.md §8 lists them all). */
export class NftRefusal extends Error { constructor(public code: string, msg: string) { super(msg); } }
