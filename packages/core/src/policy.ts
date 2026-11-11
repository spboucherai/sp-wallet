import { z } from 'zod';
import { baseUnits, parseUnits } from './amounts.ts';
import { NETWORKS } from './networks.ts';
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

/**
 * Per-transfer caps in whole units, sized to roughly 50 USD at the prices of 2026-11-10 (the daily cap is twice that).
 * A symbol missing here cannot be sent at all (default deny). Edit policy.json on the signer machine to change a limit.
 */
export const CAPS: Record<string, string> = {
  USDC: '50', USDT: '50', PYUSD: '50', DAI: '50', USDS: '50', USDe: '50', FDUSD: '50', RLUSD: '50', USDG: '50', EURC: '45',
  ETH: '0.025', WETH: '0.025', BTC: '0.0007', WBTC: '0.0007', SOL: '0.6', BNB: '0.075', AVAX: '6', HYPE: '0.7', POL: '550', LTC: '1', XLM: '350', XRP: '47', TRX: '150', DOGE: '700', BCH: '0.2',
  LINK: '5', UNI: '7.5', AAVE: '0.4', LDO: '150', PAXG: '0.0125', ONDO: '135', RENDER: '30', JUP: '200', RAY: '30',
  BONK: '18000000', PEPE: '9000000', SHIB: '11000000',
};
const STABLE_FEE: Record<string, string> = {
  ethereum: '5000000000000000', base: '300000000000000', arbitrum: '300000000000000', optimism: '300000000000000',
  polygon: '500000000000000000', bsc: '1000000000000000', avalanche: '20000000000000000', hyperevm: '20000000000000000',
  bitcoin: '5000', litecoin: '100000', dogecoin: '100000000', bitcoincash: '50000', solana: '3000000', stellar: '1000000', xrpl: '100000',
  tron: '40000000', // 40 TRX: a USDT transfer to a first-time holder burns ≈13.5 TRX of energy at 100 sun, plus margin
};
function buildDefaultPolicy(): Policy {
  const perTx: Record<string, string> = {}, daily: Record<string, string> = {};
  for (const n of Object.values(NETWORKS)) for (const a of [n.native, ...n.tokens]) {
    const cap = CAPS[a.symbol];
    if (!cap) continue;
    const v = parseUnits(cap, a.decimals);
    perTx[`${n.id}:${a.symbol}`] = v.toString();
    daily[`${n.id}:${a.symbol}`] = (v * 2n).toString();
  }
  return { version: 2, perTx, daily, maxFee: STABLE_FEE, maxApprovalTtlSec: 300, allowlist: [] };
}
/** Conservative defaults sized for a wallet holding a few tens of dollars per asset. */
export const DEFAULT_POLICY: Policy = buildDefaultPolicy();

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
