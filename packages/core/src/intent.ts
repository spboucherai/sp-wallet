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
