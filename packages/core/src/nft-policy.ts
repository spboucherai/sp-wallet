// NFT delivery 2 — the NFT section of the signer's policy (`policy.json` → key `nft`), its defaults and its checks.
//
// The file on the signer machine is NEVER rewritten by a release (docs/runbooks/deploy.md). A policy.json written before this
// version has no `nft` key: `effectiveNftPolicy` fills every missing key with the defaults below IN MEMORY, at load, and leaves
// every value the file does set exactly as it is. Existing limits and fee ceilings are untouched; the fee ceiling of an NFT
// transfer is the existing `maxFee[network]`. The NFT section has its own version: an NFT intent freezes both versions.
import { z } from 'zod';
import { baseUnits } from './amounts.ts';
import { NETWORKS } from './networks.ts';
import { NFT_TRANSFER_STANDARDS, NftRefusal, type NftIntent, type NftTransferStandard } from './nft-intent.ts';

const U = z.string().regex(/^(0|[1-9]\d{0,77})$/);
/** As it may appear in policy.json: every key optional (a missing key takes the code default), unknown keys refused. */
export const NftPolicyFileSchema = z.strictObject({
  version: z.number().int().nonnegative().optional(),
  /** network id → standards whose transfer the signer will sign there. A network that is absent is disabled. */
  enabled: z.record(z.string().regex(/^[a-z0-9-]{2,24}$/), z.array(z.enum(NFT_TRANSFER_STANDARDS))).optional(),
  /** NFT transfers signed per UTC day, all networks together */
  maxTransfersPerDay: z.number().int().min(0).max(1000).optional(),
  /** units of one ERC-1155 id in one transfer */
  maxErc1155Quantity: U.optional(),
  /** true: NFT transfers only to destinations the owner approved with the passkey (the signer's own list, `POST /nft/allow`) */
  allowlistOnly: z.boolean().optional(),
  /** Solana: ceilings of the compute budget of an NFT transfer */
  maxComputeUnits: z.number().int().min(1).max(400_000).optional(),
  maxComputeUnitPrice: U.optional(),
});
export type NftPolicyFile = z.infer<typeof NftPolicyFileSchema>;
export type NftPolicy = Required<NftPolicyFile>;

export const NFT_POLICY_VERSION = 1;
/**
 * Conservative defaults. A standard is ON by default only where its builder is verified by the proofs of
 * docs/nft/work/nft-2.md; every other (network, standard) pair is refused until the operator adds it to policy.json.
 */
export function defaultNftPolicy(): NftPolicy {
  const enabled: Record<string, NftTransferStandard[]> = {};
  for (const n of Object.values(NETWORKS)) if (n.family === 'evm') enabled[n.id] = ['erc721', 'erc1155'];
  enabled.solana = ['spl-token-2022', 'metaplex-token-metadata', 'metaplex-pnft', 'metaplex-core'];
  return { version: NFT_POLICY_VERSION, enabled, maxTransfersPerDay: 5, maxErc1155Quantity: '10', allowlistOnly: false, maxComputeUnits: 400_000, maxComputeUnitPrice: '2000000' };
}
/** Merge-on-load: the file's values win key by key; a missing key takes the default; nothing is written back. */
export function effectiveNftPolicy(file: NftPolicyFile | undefined): NftPolicy {
  const d = defaultNftPolicy(), f = file ?? {};
  return { version: f.version ?? d.version, enabled: f.enabled ?? d.enabled, maxTransfersPerDay: f.maxTransfersPerDay ?? d.maxTransfersPerDay, maxErc1155Quantity: f.maxErc1155Quantity ?? d.maxErc1155Quantity,
    allowlistOnly: f.allowlistOnly ?? d.allowlistOnly, maxComputeUnits: f.maxComputeUnits ?? d.maxComputeUnits, maxComputeUnitPrice: f.maxComputeUnitPrice ?? d.maxComputeUnitPrice };
}

export interface NftPolicyContext {
  /** main policy: version, approval window, fee ceilings, the general destination allowlist */
  policy: { version: number; maxFee: Record<string, string>; maxApprovalTtlSec: number; allowlist: string[]; nft?: NftPolicyFile };
  /** NFT transfers already signed this UTC day (the signer's persisted counter) */
  signedToday: number;
  nowSec: number;
  halted: boolean;
  /** "<network>:<address>" entries the owner approved with the passkey (the signer's persisted list) */
  allowed: ReadonlySet<string>;
}
/**
 * The policy checks of an NFT transfer. Throws an NftRefusal with a stable code; returns nothing when the intent may be signed.
 * An NFT transfer is never a risk reduction: the emergency halt refuses it.
 */
export function checkNftPolicy(c: NftPolicyContext, i: NftIntent): void {
  const deny = (code: string, msg: string): never => { throw new NftRefusal(code, msg); };
  const nft = effectiveNftPolicy(c.policy.nft);
  if (c.halted) deny('nft_halted', 'emergency halt is active');
  if (i.policyVersion !== c.policy.version) deny('nft_policy_version', 'policy version changed');
  if (i.nftPolicyVersion !== nft.version) deny('nft_policy_version', 'NFT policy version changed');
  if (i.expiresAt <= c.nowSec) deny('nft_expired', 'approval window expired');
  if (i.createdAt > c.nowSec + 60) deny('nft_window', 'intent dated in the future');
  if (i.expiresAt - i.createdAt > c.policy.maxApprovalTtlSec) deny('nft_window', 'approval window too long');
  if (!(nft.enabled[i.network] ?? []).includes(i.standard)) deny('nft_network_disabled', `${i.standard} transfers are not enabled on ${i.network} by the signer's policy`);
  const q = baseUnits(i.quantity);
  if (q < 1n) deny('nft_bad_quantity', 'quantity must be at least 1');
  if (i.standard !== 'erc1155' && q !== 1n) deny('nft_bad_quantity', 'this standard moves exactly one unit');
  if (i.standard === 'erc1155' && q > baseUnits(nft.maxErc1155Quantity)) deny('nft_quantity_cap', `quantity above the ERC-1155 limit of the policy (${nft.maxErc1155Quantity})`);
  if (c.signedToday >= nft.maxTransfersPerDay) deny('nft_daily_count', `daily NFT transfer count reached (${nft.maxTransfersPerDay})`);
  const ceiling = c.policy.maxFee[i.network];
  if (ceiling === undefined || baseUnits(i.maxFee) > baseUnits(ceiling)) deny('nft_fee_cap', 'fee ceiling above policy');
  if (i.sol) {
    if (i.sol.computeUnitLimit > nft.maxComputeUnits) deny('nft_compute_cap', 'compute-unit limit above policy');
    if (baseUnits(i.sol.computeUnitPrice) > baseUnits(nft.maxComputeUnitPrice)) deny('nft_compute_cap', 'compute-unit price above policy');
  }
  const dest = `${i.network}:${i.to}`;
  if (c.policy.allowlist.length > 0 && !c.policy.allowlist.includes(dest)) deny('nft_not_allowlisted', 'destination not in signer allowlist');
  if (nft.allowlistOnly && !c.allowed.has(dest)) deny('nft_not_allowlisted', 'allow-list mode: this destination was not approved by the owner for NFT transfers');
}
