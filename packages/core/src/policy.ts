import { z } from 'zod';
import { baseUnits } from './amounts.ts';
import type { Intent } from './intent.ts';

const U = z.string().regex(/^(0|[1-9]\d{0,77})$/);
/** Signer-side policy. Limits are in base units, keyed by "<network>:<symbol>". Missing key = 0 = deny. */
export const PolicySchema = z.strictObject({
  version: z.number().int().nonnegative(),
  perTx: z.record(z.string(), U),
  daily: z.record(z.string(), U),
  maxFee: z.record(z.string(), U),
  maxApprovalTtlSec: z.number().int().min(30).max(900),
  /** when non-empty, only these destinations may receive funds ("<network>:<address>") */
  allowlist: z.array(z.string()),
});
export type Policy = z.infer<typeof PolicySchema>;

const usdc = (n: string) => [`${n}:USDC`, '50000000'] as const; // 50 USDC
/** Conservative defaults sized for a wallet holding a few tens of USDC. */
export const DEFAULT_POLICY: Policy = {
  version: 1,
  perTx: Object.fromEntries([
    ...['ethereum', 'base', 'arbitrum', 'polygon', 'solana'].map(usdc),
    ['ethereum:ETH', '20000000000000000'], ['base:ETH', '20000000000000000'], ['arbitrum:ETH', '20000000000000000'],
    ['polygon:POL', '50000000000000000000'], ['bitcoin:BTC', '50000'], ['solana:SOL', '250000000'],
  ]),
  daily: Object.fromEntries([
    ...['ethereum', 'base', 'arbitrum', 'polygon', 'solana'].map((n) => [`${n}:USDC`, '100000000']),
    ['ethereum:ETH', '40000000000000000'], ['base:ETH', '40000000000000000'], ['arbitrum:ETH', '40000000000000000'],
    ['polygon:POL', '100000000000000000000'], ['bitcoin:BTC', '100000'], ['solana:SOL', '500000000'],
  ]),
  maxFee: {
    ethereum: '5000000000000000', base: '300000000000000', arbitrum: '300000000000000',
    polygon: '500000000000000000', bitcoin: '5000', solana: '3000000',
  },
  maxApprovalTtlSec: 300,
  allowlist: [],
};

export type PolicyVerdict = { ok: true } | { ok: false; reason: string };

export function checkPolicy(policy: Policy, i: Intent, spentToday: bigint, nowSec: number, halted: boolean): PolicyVerdict {
  const deny = (reason: string): PolicyVerdict => ({ ok: false, reason });
  if (halted) return deny('emergency halt is active');
  if (i.policyVersion !== policy.version) return deny('policy version changed');
  if (i.expiresAt <= nowSec) return deny('approval window expired');
  if (i.createdAt > nowSec + 60) return deny('intent dated in the future');
  if (i.expiresAt - i.createdAt > policy.maxApprovalTtlSec) return deny('approval window too long');
  const key = `${i.network}:${i.symbol}`;
  const amount = baseUnits(i.amount);
  const perTx = baseUnits(policy.perTx[key] ?? '0'), daily = baseUnits(policy.daily[key] ?? '0');
  if (amount <= 0n) return deny('amount must be positive');
  if (amount > perTx) return deny(`amount above per-transaction limit for ${key}`);
  if (spentToday + amount > daily) return deny(`daily limit exceeded for ${key}`);
  if (baseUnits(i.maxFee) > baseUnits(policy.maxFee[i.network] ?? '0')) return deny('fee ceiling above policy');
  if (policy.allowlist.length > 0 && !policy.allowlist.includes(`${i.network}:${i.to}`)) return deny('destination not in signer allowlist');
  return { ok: true };
}
