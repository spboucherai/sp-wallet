import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import { baseUnits } from './amounts.ts';
import { getNetwork } from './networks.ts';

const U = z.string().regex(/^(0|[1-9]\d{0,77})$/);
export const IntentSchema = z.strictObject({
  v: z.literal(1),
  proposalId: z.uuid(),
  keyId: z.string().min(8).max(80),
  network: z.string().min(2).max(24).regex(/^[a-z0-9-]+$/),
  chainRef: z.string().min(1).max(80),
  asset: z.string().min(1).max(80),
  symbol: z.string().min(1).max(16),
  decimals: z.number().int().min(0).max(36),
  amount: U,
  from: z.string().min(20).max(100),
  /** shortest valid destination: a 2-character NEAR account name. Every builder validates the address format of its own chain. */
  to: z.string().min(2).max(100),
  maxFee: U,
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  policyVersion: z.number().int().nonnegative(),
  /** destination memo / tag, when the network has one */
  memo: z.string().max(120).optional(),
  /** chain parameters for plugin families: flat string map, serialized in key order */
  x: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.]{0,39}$/), z.string().max(20000)).optional(),
  /**
   * Present when the intent is a swap instead of a transfer. `asset`/`amount` are the input, `to` must equal `from`
   * (the output is delivered to the wallet itself). `dataHash` commits to the exact provider calldata the signer will verify.
   */
  swap: z.strictObject({
    provider: z.enum(['kyberswap', 'jupiter']), toAsset: z.string().min(1).max(80), minOut: U, router: z.string().min(20).max(100),
    dataHash: z.string().regex(/^[0-9a-f]{64}$/), approveGas: U,
  }).optional(),
  /**
   * Present when the intent is a cross-chain USDC transfer (Circle CCTP) from the wallet to itself. `asset`/`amount` are the
   * USDC burned on `network`, `to` must equal `from` (the wallet's own address, the same on every EVM network). The signer
   * builds the burn calldata itself from these fields; `maxFee` here is the CCTP fee ceiling in USDC base units (0 = Standard).
   */
  bridge: z.strictObject({
    provider: z.enum(['cctp']), toNetwork: z.string().min(2).max(24).regex(/^[a-z0-9-]+$/), toDomain: z.number().int().min(0).max(0xffffffff),
    maxFee: U, minFinalityThreshold: z.number().int().min(1).max(0xffffffff), messenger: z.string().min(20).max(100), transmitter: z.string().min(20).max(100), approveGas: U,
  }).optional(),
  /**
   * Present when the intent funds the owner's account on a derivatives venue (v6): a plain token transfer from the wallet's own
   * address to the venue's bridge contract. The signer checks every field against a table pinned in its bundle
   * (@spw/derivatives/live, `checkVenueDepositIntent`): venue network → chain, native USDC only, `to` = the pinned bridge,
   * amount ≥ `minAmount` = its own floor above the venue minimum. An ordinary transfer to a venue bridge is refused.
   */
  venueDeposit: z.strictObject({
    venue: z.enum(['hyperliquid']), venueNetwork: z.enum(['mainnet', 'testnet']), route: z.string().regex(/^[a-z0-9-]{3,32}$/), bridge: z.string().min(20).max(100), minAmount: U,
  }).optional(),
  /**
   * Present when the intent is a native cross-chain swap through THORChain, from the wallet to itself (packages/core/src/thorchain.ts).
   * `asset`/`amount` are the input; `to` is the Asgard vault that receives it and must equal `vault`, which must be the address of
   * `vaultPubKey`. The signer rebuilds `memo` itself (destination = the wallet's own address on `toNetwork`, `limit` in 1e8 units
   * worth at least `minOut` base units of `toAsset`) and refuses any difference. `router` is '' for a UTXO source.
   */
  xswap: z.strictObject({
    provider: z.enum(['thorchain']), toNetwork: z.string().min(2).max(24).regex(/^[a-z0-9-]+$/), toAsset: z.string().min(1).max(80), minOut: U, limit: U,
    memo: z.string().min(5).max(250), vault: z.string().min(20).max(100), vaultPubKey: z.string().min(20).max(120), router: z.string().max(100), expiry: z.number().int().positive(), approveGas: U,
  }).optional(),
  evm: z.strictObject({
    nonce: z.number().int().nonnegative(), gasLimit: U, maxFeePerGas: U, maxPriorityFeePerGas: U,
  }).optional(),
  btc: z.strictObject({
    inputs: z.array(z.strictObject({ txid: z.string().regex(/^[0-9a-f]{64}$/), vout: z.number().int().nonnegative(), value: U })).min(1).max(50),
    change: U, fee: U,
  }).optional(),
  sol: z.strictObject({
    recentBlockhash: z.string().min(32).max(44), lastValidBlockHeight: z.number().int().positive(),
    createAta: z.boolean(), computeUnitLimit: z.number().int().min(1).max(400_000), computeUnitPrice: U,
  }).optional(),
});
export type Intent = z.infer<typeof IntentSchema>;

const DOMAIN = 'SPW-INTENT-v1';
const enc = new TextEncoder();

/** Flatten to an ordered list of (name, value) pairs. Order is fixed by this code, never by JSON key order. */
function fields(i: Intent): [string, string][] {
  const f: [string, string][] = [
    ['v', String(i.v)], ['proposalId', i.proposalId], ['keyId', i.keyId], ['network', i.network],
    ['chainRef', i.chainRef], ['asset', i.asset], ['symbol', i.symbol], ['decimals', String(i.decimals)],
    ['amount', i.amount], ['from', i.from], ['to', i.to], ['maxFee', i.maxFee],
    ['createdAt', String(i.createdAt)], ['expiresAt', String(i.expiresAt)], ['policyVersion', String(i.policyVersion)],
  ];
  if (i.evm) f.push(['evm.nonce', String(i.evm.nonce)], ['evm.gasLimit', i.evm.gasLimit],
    ['evm.maxFeePerGas', i.evm.maxFeePerGas], ['evm.maxPriorityFeePerGas', i.evm.maxPriorityFeePerGas]);
  if (i.btc) {
    f.push(['btc.inputs.count', String(i.btc.inputs.length)]);
    i.btc.inputs.forEach((x, k) => f.push([`btc.inputs.${k}.txid`, x.txid], [`btc.inputs.${k}.vout`, String(x.vout)], [`btc.inputs.${k}.value`, x.value]));
    f.push(['btc.change', i.btc.change], ['btc.fee', i.btc.fee]);
  }
  if (i.sol) f.push(['sol.recentBlockhash', i.sol.recentBlockhash], ['sol.lastValidBlockHeight', String(i.sol.lastValidBlockHeight)],
    ['sol.createAta', i.sol.createAta ? '1' : '0'], ['sol.computeUnitLimit', String(i.sol.computeUnitLimit)],
    ['sol.computeUnitPrice', i.sol.computeUnitPrice]);
  if (i.swap) f.push(['swap.provider', i.swap.provider], ['swap.toAsset', i.swap.toAsset], ['swap.minOut', i.swap.minOut], ['swap.router', i.swap.router], ['swap.dataHash', i.swap.dataHash], ['swap.approveGas', i.swap.approveGas]);
  if (i.bridge) f.push(['bridge.provider', i.bridge.provider], ['bridge.toNetwork', i.bridge.toNetwork], ['bridge.toDomain', String(i.bridge.toDomain)], ['bridge.maxFee', i.bridge.maxFee],
    ['bridge.minFinalityThreshold', String(i.bridge.minFinalityThreshold)], ['bridge.messenger', i.bridge.messenger], ['bridge.transmitter', i.bridge.transmitter], ['bridge.approveGas', i.bridge.approveGas]);
  if (i.xswap) f.push(['xswap.provider', i.xswap.provider], ['xswap.toNetwork', i.xswap.toNetwork], ['xswap.toAsset', i.xswap.toAsset], ['xswap.minOut', i.xswap.minOut], ['xswap.limit', i.xswap.limit],
    ['xswap.memo', i.xswap.memo], ['xswap.vault', i.xswap.vault], ['xswap.vaultPubKey', i.xswap.vaultPubKey], ['xswap.router', i.xswap.router], ['xswap.expiry', String(i.xswap.expiry)], ['xswap.approveGas', i.xswap.approveGas]);
  if (i.venueDeposit) f.push(['venueDeposit.venue', i.venueDeposit.venue], ['venueDeposit.venueNetwork', i.venueDeposit.venueNetwork], ['venueDeposit.route', i.venueDeposit.route],
    ['venueDeposit.bridge', i.venueDeposit.bridge], ['venueDeposit.minAmount', i.venueDeposit.minAmount]);
  if (i.memo !== undefined) f.push(['memo', i.memo]);
  if (i.x) for (const k of Object.keys(i.x).sort()) f.push([`x.${k}`, i.x[k]!]);
  return f;
}

/** Deterministic, length-prefixed, domain-separated serialization. */
export function canonicalBytes(intent: Intent): Uint8Array {
  const i = IntentSchema.parse(intent);
  const fam = getNetwork(i.network).family; // throws on unknown network
  const plugin = fam !== 'evm' && fam !== 'btc' && fam !== 'sol';
  if ((fam === 'evm') !== !!i.evm || (fam === 'btc') !== !!i.btc || (fam === 'sol') !== !!i.sol || plugin !== !!i.x)
    throw new Error('intent chain section does not match network');
  if (i.swap && (i.swap.provider === 'jupiter' ? fam !== 'sol' : fam !== 'evm')) throw new Error('swaps are only defined for EVM networks (KyberSwap) and Solana (Jupiter)');
  if (i.bridge && (fam !== 'evm' || i.swap)) throw new Error('bridges are only defined for EVM networks and exclude a swap');
  if (i.xswap && ((fam !== 'evm' && fam !== 'btc') || i.swap || i.bridge)) throw new Error('cross-chain swaps are only defined for EVM and Bitcoin-style sources and exclude a swap or a bridge');
  if (i.venueDeposit && (fam !== 'evm' || i.swap || i.bridge || i.xswap || i.memo !== undefined)) throw new Error('a venue deposit is a plain EVM transfer: no swap, no bridge, no cross-chain swap, no memo');
  baseUnits(i.amount);
  const parts: Uint8Array[] = [enc.encode(DOMAIN), new Uint8Array([0])];
  for (const [k, v] of fields(i)) {
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

export function intentHash(intent: Intent): Uint8Array {
  return sha256(canonicalBytes(intent));
}

export const toB64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
export const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
