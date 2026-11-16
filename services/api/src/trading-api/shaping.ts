// Shaping of answers at the boundary of the trading API — pure functions, applied by routes.ts to what the services return.
//
//   shapePreview        an order preview never tells a key more about the ACCOUNT than its scopes let it read: equity, free
//                       collateral, positions, and the account figures inside the risk checks, the refusal sentences and the
//                       estimate are answered only when the key also holds `wallet:read` or `positions:read`
//   sizeFromNotional    `notional` (quote currency) → a size in base units, rounded down to the lot: done by the SERVER
import { D, type DecStr } from '@spw/derivatives';
import { UserError } from '../config.ts';
import type { Principal } from './principal.ts';
import { ACCOUNT_RISK_CHECKS } from './spec.ts';

/** may this principal read figures of the wallet's accounts? (the scopes of GET /portfolio and GET /positions) */
export const mayReadAccount = (p: Principal): boolean => p.kind === 'owner' || p.scopes.includes('wallet:read') || p.scopes.includes('positions:read');
export const WITHHELD = 'withheld: this key holds neither wallet:read nor positions:read';
/** refusal codes of the venue engines whose sentence quotes a figure of the account (packages/derivatives RISK_CODES) */
export const ACCOUNT_ENGINE_CODES: readonly string[] = ['reduce_only_would_increase', 'reduce_only_would_flip', 'leverage_exceeded', 'gross_exposure_exceeded', 'position_notional_exceeded', 'insufficient_collateral',
  'liquidation_too_close', 'daily_loss_exceeded', 'total_loss_exceeded', 'order_rate_minute', 'order_rate_day', 'halted'];

interface PreviewLike {
  refusals: { stage: string; code: string; message: string }[];
  risk: { checks: { id: string; observed: string | null; detail: string }[]; derived: Record<string, unknown> };
  engine: { risk: unknown; estimate: unknown };
  account: Record<string, unknown>;
}
/** the preview as the order service computed it → what THIS principal may see of it. `account.withheld` says which of the two it is. */
export function shapePreview<T extends PreviewLike>(p: Principal, out: T): T {
  if (mayReadAccount(p)) return { ...out, account: { ...out.account, withheld: false } };
  const { equity: _e, freeCollateral: _f, ...account } = out.account;
  const { positionBefore: _b, positionAfter: _a, ...derived } = out.risk.derived;
  const hidden = (id: string): boolean => ACCOUNT_RISK_CHECKS.includes(id);
  const er = out.engine.risk as { ok?: boolean; code?: string; reason?: string } | null;
  const est = out.engine.estimate as Record<string, unknown> | null;
  const engineHidden = er !== null && typeof er === 'object' && er.ok === false && ACCOUNT_ENGINE_CODES.includes(String(er.code));
  return {
    ...out,
    refusals: out.refusals.map((r) => {
      // a risk refusal is `<check id>: <sentence>`; an engine refusal carries the engine's own code
      const check = r.stage === 'risk' ? r.message.slice(0, Math.max(0, r.message.indexOf(':'))) : '';
      if (r.stage === 'risk' && hidden(check)) return { ...r, message: `${check}: ${WITHHELD}` };
      if (r.stage === 'engine' && ACCOUNT_ENGINE_CODES.includes(r.code)) return { ...r, message: WITHHELD };
      return r;
    }),
    risk: { ...out.risk, derived, checks: out.risk.checks.map((c) => (hidden(c.id) ? { ...c, observed: null, detail: WITHHELD } : c)) },
    engine: { ...out.engine, risk: engineHidden ? { ...er, reason: WITHHELD } : out.engine.risk,
      estimate: est === null ? null : (({ freeCollateralAfter: _c, liquidationPrice: _l, rejectReason, ...rest }) => ({ ...rest, rejectReason: engineHidden ? WITHHELD : rejectReason }))(est) },
    account: { ...account, withheld: true },
  };
}

/** notional / reference price, rounded DOWN to the lot size — exact decimal arithmetic. 422 `below_min_size` under one lot. */
export function sizeFromNotional(notional: string, reference: DecStr, lotSize: DecStr): DecStr {
  const ref = D.from(reference);
  if (!D.isPos(ref)) throw new UserError('stale_data', 'the reference price of this instrument is not positive: the notional cannot be turned into a size', 503);
  const size = D.quantize(D.div(D.from(notional), ref, 18, 'down'), D.from(lotSize), 'down');
  if (!D.isPos(size)) throw new UserError('below_min_size', `a notional of ${notional} buys less than one lot (${lotSize}) at ${reference}`, 422);
  return D.str(size);
}
