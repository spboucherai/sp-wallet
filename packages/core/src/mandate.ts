// Trading mandate: what an agent's vault may do without a passkey approval per order. Approved once by the owner (passkey over
// the canonical hash), stored and enforced by the isolated signer. Nothing outside the signer can widen it.
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import { baseUnits } from './amounts.ts';
import { getAsset, getNetwork } from './networks.ts';
import type { Intent } from './intent.ts';
import { KYBER_ENABLED } from './swap-evm.ts';

const U = z.string().regex(/^(0|[1-9]\d{0,77})$/);
export const MAX_MANDATE_DAYS = 90;
export const MandateSchema = z.strictObject({
  v: z.literal(1),
  mandateId: z.uuid(),
  /** the owner key this mandate belongs to */
  keyId: z.string().min(8).max(80),
  /** HD account index of the agent vault (the owner's own wallet is account 0 and can never be mandated) */
  vaultIndex: z.number().int().min(1).max(100_000),
  vault: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  network: z.string().min(2).max(24),
  provider: z.enum(['kyberswap']),
  /** registry asset ids ('native' or token address) the vault may hold and trade */
  assets: z.array(z.string().min(1).max(80)).min(2).max(12),
  /** per asset id: largest input of a single order and total input per UTC day, base units. A missing asset cannot be sold. */
  maxOrder: z.record(z.string(), U), maxDaily: z.record(z.string(), U),
  maxOrdersPerDay: z.number().int().min(1).max(500),
  createdAt: z.number().int().positive(), expiresAt: z.number().int().positive(),
  /** SHA-256 of the strategy code this mandate was approved for (audit trail; the engine refuses to run anything else) */
  strategySha256: z.string().regex(/^[0-9a-f]{64}$/),
  label: z.string().min(1).max(60),
});
export type Mandate = z.infer<typeof MandateSchema>;

const enc = new TextEncoder();
/** Deterministic, length-prefixed, domain-separated serialization (asset lists and maps in sorted order). */
export function mandateBytes(m: Mandate): Uint8Array {
  const x = MandateSchema.parse(m);
  const f: [string, string][] = [['v', '1'], ['mandateId', x.mandateId], ['keyId', x.keyId], ['vaultIndex', String(x.vaultIndex)], ['vault', x.vault], ['network', x.network], ['provider', x.provider],
    ['assets', [...x.assets].sort().join(',')], ...Object.keys(x.maxOrder).sort().map((k) => [`maxOrder.${k}`, x.maxOrder[k]!] as [string, string]),
    ...Object.keys(x.maxDaily).sort().map((k) => [`maxDaily.${k}`, x.maxDaily[k]!] as [string, string]), ['maxOrdersPerDay', String(x.maxOrdersPerDay)],
    ['createdAt', String(x.createdAt)], ['expiresAt', String(x.expiresAt)], ['strategySha256', x.strategySha256], ['label', x.label]];
  const parts: Uint8Array[] = [enc.encode('SPW-MANDATE-v1'), new Uint8Array([0])];
  for (const [k, v] of f) { const kb = enc.encode(k), vb = enc.encode(v), h = new Uint8Array(6); new DataView(h.buffer).setUint16(0, kb.length); new DataView(h.buffer).setUint32(2, vb.length); parts.push(h, kb, vb); }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export const mandateHash = (m: Mandate): Uint8Array => sha256(mandateBytes(m));
/** Key id carried by intents signed with a vault key, so an owner approval can never be replayed on a vault or vice versa. */
export const vaultKeyId = (ownerKeyId: string, index: number) => `${ownerKeyId}-v${index}`;

/** Structural validity of a mandate at approval time (the signer also checks the vault address against its own derivation). */
export function validateMandate(m: Mandate, nowSec: number): void {
  const n = getNetwork(m.network);
  if (n.family !== 'evm' || !KYBER_ENABLED[m.network]) throw new Error(`mandates are not available on ${n.name}`);
  const seen = new Set<string>();
  for (const a of m.assets) { const d = getAsset(m.network, a); const k = d.id.toLowerCase(); if (seen.has(k)) throw new Error('duplicate asset'); seen.add(k); if (d.id !== a) throw new Error('asset id is not in registry form'); }
  for (const map of [m.maxOrder, m.maxDaily]) for (const k of Object.keys(map)) if (!m.assets.includes(k)) throw new Error('limit set for an asset outside the mandate');
  for (const a of m.assets) { const o = m.maxOrder[a], d = m.maxDaily[a]; if ((o === undefined) !== (d === undefined)) throw new Error('order and daily limits must be set together'); if (o !== undefined && baseUnits(o) > baseUnits(d!)) throw new Error('order limit above the daily limit'); }
  if (!Object.keys(m.maxOrder).length) throw new Error('a mandate needs at least one sellable asset');
  if (m.expiresAt <= nowSec) throw new Error('mandate already expired');
  if (m.createdAt > nowSec + 120 || m.createdAt < nowSec - 600) throw new Error('mandate creation time is not current');
  if (m.expiresAt - m.createdAt > MAX_MANDATE_DAYS * 86400) throw new Error(`a mandate lasts at most ${MAX_MANDATE_DAYS} days`);
}

export interface MandateUsage { /** base units already sold today, per asset id */ sold: Record<string, string>; orders: number }
export type MandateVerdict = { ok: true } | { ok: false; reason: string };

/** Does this order fit the mandate? Pure: the signer supplies today's usage and the clock. */
export function checkMandateOrder(m: Mandate, i: Intent, usage: MandateUsage, nowSec: number, opts: { halted: boolean; revoked: boolean; maxFee: string | undefined }): MandateVerdict {
  const deny = (reason: string): MandateVerdict => ({ ok: false, reason });
  if (opts.halted) return deny('emergency halt is active');
  if (opts.revoked) return deny('mandate revoked');
  if (nowSec >= m.expiresAt) return deny('mandate expired');
  if (i.keyId !== vaultKeyId(m.keyId, m.vaultIndex)) return deny('intent is not for this vault key');
  if (i.network !== m.network) return deny('network outside the mandate');
  if (!i.swap || i.swap.provider !== m.provider) return deny('only swaps through the mandated provider can be delegated');
  if (i.from.toLowerCase() !== m.vault.toLowerCase() || i.to.toLowerCase() !== m.vault.toLowerCase()) return deny('an order must spend from and deliver to the vault itself');
  if (!m.assets.includes(i.asset) || !m.assets.includes(i.swap.toAsset)) return deny('asset outside the mandate');
  if (i.expiresAt <= nowSec) return deny('order expired');
  if (i.createdAt > nowSec + 60 || i.expiresAt - i.createdAt > 300) return deny('order validity window is not acceptable');
  const amount = baseUnits(i.amount), perOrder = m.maxOrder[i.asset], perDay = m.maxDaily[i.asset];
  if (perOrder === undefined || perDay === undefined) return deny('this asset cannot be sold under the mandate');
  if (amount <= 0n || amount > baseUnits(perOrder)) return deny('order above the per-order limit');
  if (BigInt(usage.sold[i.asset] ?? '0') + amount > baseUnits(perDay)) return deny('daily volume limit reached');
  if (usage.orders >= m.maxOrdersPerDay) return deny('daily order count reached');
  if (opts.maxFee === undefined || baseUnits(i.maxFee) > baseUnits(opts.maxFee)) return deny('fee ceiling above policy');
  return { ok: true };
}
