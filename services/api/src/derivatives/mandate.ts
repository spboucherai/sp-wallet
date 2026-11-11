// MANDATE_LIVE — the narrow, server-side interface for an automated strategy runtime (the perp-agent engine). Nothing here is
// reachable over HTTP: the owner's session cannot place a passkey-less order, only code running inside the API process can.
//
// What a caller can rely on (docs/v6/DERIVATIVE-MANDATE.md):
//  - it holds no key and cannot widen anything: every order is checked by the API's risk engine against the venue's real state,
//    then by the isolated signer against the mandate the owner approved with his passkey (positions and exposure included);
//  - `placeMandateOrder` is idempotent on `ctx.clientId` and returns the order as RECONCILED with the venue; a state of
//    `unknown` means the venue gave no usable answer — it resolves only by reconciliation (call `mandateOrder` later);
//  - a refusal is a thrown `UserError` with a stable `code`; the order is then stored `rejected` with the reason;
//  - stopping never needs anything: `cancelMandateOrder` works while the venue authorization lives, and reduce-only orders pass
//    while halted, when limits are used up, and for 24 h after the mandate is revoked or expires (wind-down).
import type { OrderRequest, Position } from '@spw/derivatives';
import { UserError } from '../config.ts';
import type { LiveService, MandateOrderCtx } from './exec.ts';
import { live } from './live.ts';

export type { MandateOrderCtx } from './exec.ts';
export type MandateOrderResult = Awaited<ReturnType<LiveService['placeMandateOrder']>>;
export type MandateAccountState = Awaited<ReturnType<LiveService['mandateAccountState']>>;
export type MandateLiveOrder = MandateOrderResult['order'];

/**
 * Place ONE order under the account's derivative mandate — no passkey.
 *
 * `req`: a complete OrderRequest. `price` is required (limit price; for `market`, the worst acceptable price). `req.clientId`
 * is ignored: the idempotency key is `ctx.clientId` (8–100 chars of [A-Za-z0-9._:-], unique per account).
 * `ctx.strategySha256` and `ctx.agentId` must be those the mandate was approved for (else `mandate_mismatch`).
 *
 * Returns `{ order, idempotent, estimate }`; `order.state` ∈ open | partially_filled | filled | cancelled | rejected | unknown
 * (+ submitted/signed transiently), `order.final`, `order.filled`, `order.avgFillPrice`, `order.reason`, `order.source`.
 * A venue refusal is NOT an exception: it is `order.state === 'rejected'` with the venue's words in `order.reason`.
 *
 * Throws UserError (`code`, `status`):
 *   400 bad_request · 403 mainnet_disabled | mandate_mainnet_disabled · 404 unknown_account | unknown_instrument ·
 *   409 idempotency (the key belongs to a manual order) · 422 mode_read_only | authorization_expired | mandate_none |
 *   mandate_mismatch | mandate_wind_down | mandate_floor_equity | halted | <risk engine code> | signer_<code>
 *   (signer_position_exceeded, signer_gross_exceeded, signer_orders_day, signer_orders_hour, signer_turnover, signer_price,
 *   signer_no_price, signer_floor_equity, signer_leverage_setting, signer_venue_unreachable, signer_venue_stale,
 *   signer_venue_inconsistent, signer_unpriced_position, signer_halted, signer_wind_down, signer_revoked, signer_expired, …) ·
 *   503 asset_table_mismatch | venue_unavailable | signer_unreachable | mandate_unavailable.
 */
export function placeMandateOrder(accountId: string, req: OrderRequest, ctx: MandateOrderCtx, svc: LiveService = live()): Promise<MandateOrderResult> {
  return svc.placeMandateOrder(accountId, req, ctx);
}

/** Withdraw a mandate order from the venue (no passkey). Returns the order as the venue reports it afterwards. */
export async function cancelMandateOrder(accountId: string, clientId: string, svc: LiveService = live()) {
  return svc.cancelOrder(accountId, clientId);
}

/**
 * Set the leverage (and margin mode) of one instrument under the mandate — no passkey; at most the mandate's leverage for that
 * instrument. Needed once before the first order when the venue's setting is above it (a new account is at 20× cross): the
 * signer refuses any order that can add exposure while the setting is higher (`signer_leverage_setting`).
 */
export function setMandateLeverage(accountId: string, body: { instrument: string; leverage: number; marginMode: 'cross' | 'isolated' }, ctx: Pick<MandateOrderCtx, 'strategySha256' | 'agentId'>, svc: LiveService = live()) {
  return svc.setMandateLeverage(accountId, body, ctx);
}

/** The stored order of an idempotency key, reconciled with the venue now; null when no such order exists. */
export async function mandateOrder(accountId: string, clientId: string, svc: LiveService = live()): Promise<MandateLiveOrder | null> {
  try { return (await svc.placeMandateOrderReplay(accountId, clientId))?.order ?? null; }
  catch (e) { if (e instanceof UserError && e.code === 'unknown_order') return null; throw e; }
}

/**
 * The venue's own account state, positions and open orders (source: 'venue'; `error` non-null = the venue could not be read —
 * treat the account as unreadable, never as empty), the mandate in force, and whether an order may be placed right now.
 */
export function mandateAccountState(accountId: string, svc: LiveService = live()): Promise<MandateAccountState> {
  return svc.mandateAccountState(accountId);
}

/** The venue's positions of the account. Throws `venue_unavailable` (503) when the venue cannot be read. */
export async function mandatePositions(accountId: string, svc: LiveService = live()): Promise<Position[]> {
  const s = await svc.mandateAccountState(accountId);
  if (s.error !== null) throw new UserError('venue_unavailable', s.error, 503);
  return s.positions;
}
