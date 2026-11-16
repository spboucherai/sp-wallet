// The order service (V11): ONE entry for every order of every principal — the owner, an API key, an agent —, paper or live,
// on any venue. It is NOT an execution engine: the paper engine (derivatives/paper.ts), the Hyperliquid engine (derivatives/exec.ts)
// and the GMX engine (derivatives/gmx-exec.ts) stay the executors. This service
//   - keeps the unified order (orders/store.ts; every change goes through `transition()` of @spw/trading),
//   - decides, in this order: who asks and with which mandate → the risk engine → the engine's own path,
//   - projects whatever the engines do to their own rows onto the unified order (orders/projection.ts), including orders placed
//     through the routes and screens that existed before (a database trigger queues every change of an engine row),
//   - resumes after a restart from the database alone, and resolves UNKNOWN orders by asking the venue.
//
// What it can not do: sign, or make the signer sign. An owner order ends AWAITING_APPROVAL and is approved with the passkey through
// the engine's existing route; an order of an API key or an agent goes to the signer through the engine's mandate path, where the
// signer applies the mandate it stores. No lock is bypassed: SPW_DERIV_LIVE_MAINNET, SPW_DERIV_MANDATE_MAINNET and
// SPW_DERIV_GMX_LIVE are applied by the engines as before, and SPW_TRADING_API_EXECUTION (default off) closes every NEW live
// risk asked through this service.
import { createHash } from 'node:crypto';
import { ZodError } from 'zod';
import { D, type Book, type DecStr, type Instrument, type OrderRequest, type Position, type Ticker } from '@spw/derivatives';
import {
  canonicalOrder, canonicalOrderHashHex, clientOrderIdFor, dedupe, IllegalTransitionError, isTerminal, orderBodyHashHex, toOrderRequest,
  type CanonicalOrder, type CanonicalOrderInput, type OrderEvent, type OrderRecord,
} from '@spw/trading';
import { UserError } from '../config.ts';
import { sql } from '../db.ts';
import type { Derivatives } from '../derivatives/index.ts';
import type { LiveService } from '../derivatives/exec.ts';
import type { GmxOrderBody, GmxService } from '../derivatives/gmx-exec.ts';
import { GMX_PINS, gmxMarket, gmxMarketByInstrument, gmxUsdFromRaw, scaleExact, unscale } from '@spw/derivatives/live';
import { boundPrice, MAX_SLIPPAGE_BPS, worstPrice, type OrderBody } from '../derivatives/paper.ts';
import type { MandateRow, MandateService } from '../mandates/service.ts';
import type { Evaluated, RiskService } from '../risk/service.ts';
import { advance, gmxSnapshot, hyperliquidSnapshot, paperSnapshot, reasonOfCode, type EngineSnapshot } from './projection.ts';
import { provenance, type Provenance } from './provenance.ts';
import { Attachments } from './attached.ts';
import type { SpotPort, SpotSession } from './spot.ts';
import { SpotOrders, type SpotDefaults } from './spot-orders.ts';
import { applyEvent, getByEngineRef, getByIdempotency, getOrder, history, insertOrder, mutate, mutateWith, patchOrder, type Engine, type OrderRow, type Origin } from './store.ts';

/** who asks. `restrictions` and `limits` are an API key's; `mandateId` is the mandate the key or the agent is bound to */
export interface Caller {
  principal: { kind: 'owner' | 'api_key' | 'agent'; id: string }; mandateId: string | null;
  limits?: { maxOrderNotionalUsd: number | null; maxDailyNotionalUsd: number | null };
  restrictions?: { networks: string[]; venues: string[]; instruments: string[] };
  /** the owner's own session, as the incoming request carried it (trading-api/routes.ts `callerOf`): what a spot order hands to the existing swap flow */
  session?: SpotSession;
}
export const OWNER_CALLER: Caller = { principal: { kind: 'owner', id: 'owner' }, mandateId: null };
/** an order as the trading API takes it (trading-api/spec.ts OrderRequestSchema); `instrument` is a full `venue:symbol` id */
export interface OrderInput {
  mode: 'paper' | 'live'; accountId?: string | undefined; instrument: string; side: 'buy' | 'sell'; type: 'limit' | 'market' | 'stop_market' | 'stop_limit' | 'take_profit_market' | 'take_profit_limit';
  size: string; price?: string | undefined; triggerPrice?: string | undefined; reduceOnly: boolean; tif: 'gtc' | 'ioc' | 'alo'; slippageBps?: number | undefined; leverage?: string | undefined; maxFeeUsd?: string | undefined;
}
export interface OrderDeps {
  now: () => number; derivatives: () => Derivatives; live: () => LiveService; risk: RiskService; mandates: MandateService;
  /** the GMX engine of this server (gmx-exec.ts); absent or null: live GMX orders answer `venue_not_wired` */
  gmx?: () => Promise<GmxService | null>;
  /** SPW_TRADING_API_EXECUTION=on (default off): without it every NEW live risk asked through this service answers 403 `execution_disabled` */
  executionEnabled: () => boolean;
  /** the existing swap proposal flow (orders/spot.ts); absent or null: an owner's spot order answers 501 */
  spot?: SpotPort | null;
  /** what the owner's command defaults say about spot orders (network, quote asset, slippage) */
  spotDefaults?: () => Promise<SpotDefaults>;
}
interface Target { mode: 'paper' | 'live'; venue: string; network: string; engine: Engine; accountId: string; account: string }
interface Market { instrument: Instrument; ticker: Ticker | null; book: Book | null }

export const DEFAULT_SLIPPAGE_BPS = 50;
/** fee cap of an order that names none: 10 bps of its notional (above the venues' base taker rates), rounded up */
export const DEFAULT_FEE_CAP_BPS = 10n;
const ORDER_TTL_MS = 120_000;
/** an order of this service left before its engine was called (a crash) is closed after this long: nothing was signed or sent */
export const ORPHAN_GRACE_MS = 30_000;
const AT_VENUE = ['SUBMITTING', 'SUBMITTED', 'PARTIALLY_FILLED', 'UNKNOWN'];
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const canon = (x: string): DecStr => D.str(D.from(x));
const dayStart = (now: number): number => Math.floor(now / 86_400_000) * 86_400_000;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a database row
/** an error answer that carries the order it is about (the error handler of server.ts sends `data`) */
const refusal = (code: string, message: string, status: number, data: Record<string, unknown>): UserError => Object.assign(new UserError(code, message, status), { data });

export class OrderService {
  readonly deps: OrderDeps;
  readonly now: () => number;
  /** venue requests made through an engine by this service (tests: a retried submission must not add one) */
  readonly engineCalls = { paper: 0, hyperliquidPropose: 0, hyperliquidMandate: 0, gmxPrepare: 0 };
  /** spot orders: the owner's swaps and the spot agents' swaps (orders/spot-orders.ts) */
  readonly spot: SpotOrders = new SpotOrders(this);
  /** stop-loss / take-profit attached to an order by a command (orders/attached.ts) */
  readonly attached: Attachments = new Attachments(this);
  constructor(deps: OrderDeps) { this.deps = deps; this.now = deps.now; }

  // ------------------------------------------------------------------ resolution
  private restricted(c: Caller, t: { venue: string; network: string; instrument: string }): void {
    const r = c.restrictions;
    if (!r) return;
    if (r.venues.length && !r.venues.includes(t.venue)) throw new UserError('restricted', `this key is not allowed on venue ${t.venue}`, 403);
    if (r.instruments.length && !r.instruments.includes(t.instrument)) throw new UserError('restricted', `this key is not allowed on ${t.instrument}`, 403);
    if (r.networks.length && !r.networks.includes(t.network)) throw new UserError('restricted', `this key is not allowed on network ${t.network}`, 403);
  }

  /** the account and the engine an order goes to. A restricted venue (jurisdiction) is refused for everybody, in any mode. */
  private async target(c: Caller, mode: 'paper' | 'live', instrument: string, accountId: string | undefined): Promise<Target> {
    const k = instrument.indexOf(':'), venue = k > 0 ? instrument.slice(0, k) : '';
    if (!venue) throw new UserError('bad_request', 'an instrument is named venue:symbol', 400);
    if (venue === 'spot' || venue === 'kyberswap' || venue === 'jupiter') {
      if (c.principal.kind !== 'owner') throw new UserError('spot_execution_requires_agent_vault', 'spot execution for an API key or an agent exists only through an agent vault under a spot mandate (Agents); it is not offered on this endpoint', 403);
      throw new UserError('spot_via_swap_screen', 'a spot order of the owner is a swap proposal approved with the passkey: prepare it in the Swap screen (not wired to this endpoint in this version)', 422);
    }
    const entry = this.deps.derivatives().registry.list().find((e) => e.id === venue);
    if (!entry) throw new UserError('unknown_venue', `unknown venue '${venue.slice(0, 40)}'`, 404);
    if (entry.restriction !== null) throw new UserError('venue_restricted', entry.restriction, 403);
    if (mode === 'paper') {
      const rows = await sql<{ id: string; network: string }[]>`select id, network from deriv_paper_accounts where venue = ${venue} order by created_at`;
      const a = accountId ? rows.find((x) => x.id === accountId) : rows.length === 1 ? rows[0] : undefined;
      if (!a) throw accountId ? new UserError('unknown_account', 'no paper account with this id on this venue', 404) : rows.length ? new UserError('account_required', `the wallet has ${rows.length} paper accounts on ${venue}: name one with accountId`, 409)
        : new UserError('no_account', `the wallet has no paper account on ${venue}`, 422);
      this.restricted(c, { venue, network: a.network, instrument });
      return { mode, venue, network: a.network, engine: 'paper', accountId: a.id, account: a.id };
    }
    if (venue === 'gmx') return this.gmxTarget(c, accountId);
    if (venue !== 'hyperliquid') throw new UserError('venue_not_wired', `live orders on ${entry.name} are prepared in the app (one passkey per order); they appear in GET /orders. This endpoint places live orders on Hyperliquid only.`, 422);
    const rows = await sql<{ id: string; network: string; account: string }[]>`select id, network, account from deriv_accounts where venue = ${venue} and authorization_id is not null order by created_at`;
    const a = accountId ? rows.find((x) => x.id === accountId) : rows.length === 1 ? rows[0] : undefined;
    if (!a) throw accountId ? new UserError('unknown_account', 'no authorized venue account with this id', 404) : rows.length ? new UserError('account_required', `the wallet has ${rows.length} venue accounts on ${venue}: name one with accountId`, 409)
      : new UserError('no_account', `the wallet has no authorized venue account on ${venue}`, 422);
    this.restricted(c, { venue, network: a.network, instrument });
    return { mode, venue, network: a.network, engine: 'hyperliquid', accountId: a.id, account: a.account.toLowerCase() };
  }

  // ------------------------------------------------------------------ GMX (live, the owner only)
  // A GMX order is a wallet transaction of the MAIN key: one passkey per order, a venue policy the signer stores, no mandate.
  // This service never builds or signs it: it hands the order to the GMX engine (gmx-exec.ts prepareOrder / prepareClose /
  // prepareCancel), which applies its own locks (SPW_DERIV_GMX_LIVE, SPW_DERIV_LIVE_MAINNET, the authorization, the pins, the
  // signer's halt), its own risk checks and the unified risk gate, and stores an operation that waits for the passkey.
  private async gmxEngine(): Promise<GmxService> {
    const g = this.deps.gmx ? await this.deps.gmx().catch(() => null) : null;
    if (!g || typeof g.prepareOrder !== 'function') throw new UserError('venue_not_wired', 'this server has no GMX engine: live GMX orders are not available here', 422);
    return g;
  }
  private async gmxTarget(c: Caller, accountId: string | undefined): Promise<Target> {
    if (c.principal.kind !== 'owner') throw new UserError('gmx_requires_owner_passkey', 'the isolated signer has no mandate for GMX: every GMX order is a wallet transaction that the owner approves with the passkey. An API key or an agent cannot place, close or cancel one.', 403);
    if (accountId !== undefined) throw new UserError('unknown_account', 'the GMX account is the wallet\'s own address: send the order without accountId', 404);
    const g = await this.gmxEngine();
    let me: string | undefined;
    try { me = (await g.deps.signer.status()).addresses[GMX_PINS.network]; } catch { throw new UserError('venue_unavailable', 'the signer could not be reached: the wallet address is unknown', 503); }
    if (!me) throw new UserError('no_account', 'the signer has no key for Arbitrum', 422);
    return { mode: 'live', venue: 'gmx', network: GMX_PINS.network, engine: 'gmx', accountId: me, account: me.toLowerCase() };
  }
  /** the wallet's GMX positions as the chain reports them, for the command catalog (never throws: [] when unreadable) */
  async gmxPositions(): Promise<{ instrument: string; side: 'long' | 'short'; size: DecStr }[]> {
    try {
      const g = await this.gmxEngine(), me = (await g.deps.signer.status()).addresses[GMX_PINS.network];
      if (!me) return [];
      return (await g.deps.chain.positions(me)).flatMap((p) => { const pin = gmxMarket(p.market); return pin ? [{ instrument: pin.instrument, side: p.isLong ? 'long' as const : 'short' as const, size: unscale(p.sizeInTokens, pin.indexDecimals) }] : []; });
    } catch { return []; }
  }
  /**
   * The canonical order → the body the GMX engine takes. GMX knows a USD size, a collateral amount and a slippage bound, and
   * this wallet sends market orders only; nothing else is approximated:
   *  - increase: `sizeUsd` is the order's notional when it names one, else size × the venue mark, rounded DOWN to the cent;
   *    `collateral` = sizeUsd ÷ the order's leverage, rounded UP to the collateral token's decimals (the leverage GMX sees is
   *    then at most the one asked). The leverage is REQUIRED: GMX has no leverage setting, it is size ÷ collateral of this order;
   *  - decrease (reduce-only): the same share of the position's USD size as `size` is of its tokens, read on-chain (the whole
   *    position when the size is the position's or more).
   * The passkey signs what the engine builds from this body (shown on its approval sheet), never the figures of this request.
   */
  private async gmxBody(order: CanonicalOrder, t: Target, m: Market, res: { size: DecStr }): Promise<GmxOrderBody> {
    const pin = gmxMarketByInstrument(order.instrument);
    if (!pin) throw new UserError('unknown_instrument', `${order.instrument} is not in the wallet's pinned GMX market table`, 422);
    if (order.type !== 'market') throw new UserError('gmx_market_orders_only', `this wallet sends market orders to GMX; a ${order.type} order cannot be expressed there (GMX limit and trigger orders are not built by the signer)`, 422);
    if (order.maxSlippageBps < 1 || order.maxSlippageBps > 500) throw new UserError('bad_request', 'slippageBps is between 1 and 500 on GMX', 400);
    const col = pin.collateral[0]!, base = { market: pin.market, slippageBps: order.maxSlippageBps };
    if (!order.reduceOnly) {
      if (order.leverage === null) throw new UserError('gmx_leverage_required', 'a GMX increase names its leverage: the collateral sent with the order is its USD size ÷ the leverage (GMX has no leverage setting to fall back on)', 422);
      const mark = m.ticker?.mark ?? null;
      if (order.notional === null && mark === null) throw new UserError('venue_unavailable', 'GMX\'s price could not be read: the size cannot be expressed in USD', 503);
      const sizeUsd = D.quantize(order.notional !== null ? D.from(order.notional) : D.mul(D.from(res.size), D.from(mark!)), D.from('0.01'), 'down');
      if (!D.isPos(sizeUsd)) throw new UserError('below_min_size', 'the order is worth less than one cent', 422);
      const collateral = D.div(sizeUsd, D.from(order.leverage), col.decimals, 'up');
      return { ...base, side: order.side === 'buy' ? 'long' : 'short', action: 'increase', sizeUsd: D.str(sizeUsd), collateral: D.str(collateral) };
    }
    const isLong = order.side === 'sell', g = await this.gmxEngine();
    const pos = (await g.deps.chain.positions(t.accountId)).find((p) => p.market.toLowerCase() === pin.market.toLowerCase() && p.isLong === isLong && p.collateralToken.toLowerCase() === col.token.toLowerCase());
    if (!pos || pos.sizeInTokens <= 0n) throw new UserError('no_position', `the wallet holds no ${isLong ? 'long' : 'short'} position on ${pin.name} (read on-chain)`, 422);
    let want: bigint;
    try { want = scaleExact(res.size, pin.indexDecimals); } catch { throw new UserError('bad_request', `a size on ${pin.name} has at most ${pin.indexDecimals} decimals`, 400); }
    const usd = want >= pos.sizeInTokens ? pos.sizeInUsd : (pos.sizeInUsd * want) / pos.sizeInTokens;
    if (usd <= 0n) throw new UserError('below_min_size', 'the share of the position to close is worth nothing', 422);
    return { ...base, side: isLong ? 'long' : 'short', action: 'decrease', sizeUsd: gmxUsdFromRaw(usd) };
  }
  /**
   * Cancel of a GMX order. Before the passkey: the operation is withdrawn at once (nothing was signed). Once the order exists
   * on-chain, cancelling it is itself a wallet transaction: the engine prepares it (`prepareCancel`, possible only after GMX's
   * request expiration) and the answer carries what the owner must approve — the order stays as it is until that is mined.
   */
  private async gmxCancel(c: Caller, r: OrderRow) {
    if (c.principal.kind !== 'owner') throw new UserError('gmx_requires_owner_passkey', 'a GMX order is cancelled by the owner, with the passkey', 403);
    if (!r.engine_ref) {
      if (AT_VENUE.includes(r.state)) throw new UserError('bad_state', 'the order is being handed to its engine right now; ask again in a moment', 409);
      const a = await applyEvent(r.id, { type: 'cancel_requested', reason: 'CANCELLED_BY_REQUEST' }, this.now());
      return { order: this.view(a!.row), sent: false, changed: true, approval: null as Record<string, unknown> | null };
    }
    const g = await this.gmxEngine(), [op] = await sql<{ id: string; state: string }[]>`select id, state from deriv_gmx_ops where id = ${r.engine_ref}`;
    if (!op) throw new UserError('unknown_order', 'the GMX operation of this order no longer exists', 404);
    if (op.state === 'pending_approval') {
      await g.withdraw(op.id);
      await this.projectRef('gmx', op.id);
      return { order: this.view((await getOrder(r.id))!), sent: false, changed: true, approval: null as Record<string, unknown> | null };
    }
    const out = await g.prepareCancel(op.id);                          // 409 `bad_state` / `not_yet_cancellable` with the engine's reason
    return { order: this.view((await getOrder(r.id))!), sent: false, changed: false,
      approval: this.gmxApproval({ id: out.operation.id, kind: 'cancel', op_hash: out.operation.hash, expires_at: out.operation.expiresAt === null ? null : new Date(out.operation.expiresAt) }),
      note: 'cancelling a GMX order is a wallet transaction: it is prepared and waits for the passkey. The order is still pending on GMX until that transaction is approved and mined.' };
  }
  /** close or reduce of a GMX position (`live:gmx:<wallet>:<position key>`): a reduce-only market order on the share asked, through the same path as any order */
  private async gmxReduce(c: Caller, positionId: string, fraction: string, slippageBps: number | undefined, idemKey: string) {
    const parts = positionId.split(':'), key = parts.slice(3).join(':').toLowerCase();
    const t = await this.gmxTarget(c, undefined), g = await this.gmxEngine();
    if ((parts[2] ?? '').toLowerCase() !== t.account) throw new UserError('unknown_position', 'unknown position', 404);
    // the position is named by its key (as GET /positions lists it) or, shorter, by its instrument id when the wallet holds one position on it
    const all0 = await g.deps.chain.positions(t.accountId), byInst = all0.filter((p) => gmxMarket(p.market)?.instrument.toLowerCase() === key);
    if (byInst.length > 1) throw new UserError('ambiguous_position', 'the wallet holds a long and a short position on this GMX market: name the position by its key', 409);
    const pos = all0.find((p) => p.key.toLowerCase() === key) ?? byInst[0], pin = pos ? gmxMarket(pos.market) : null;
    if (!pos || !pin || pos.sizeInTokens <= 0n) throw new UserError('no_position', 'the wallet holds no such position on GMX (read on-chain)', 422);
    const m = await this.market(t, pin.instrument), whole = D.eq(D.from(fraction), D.one), all = D.from(unscale(pos.sizeInTokens, pin.indexDecimals));
    const size = whole ? all : D.div(D.mul(all, D.from(fraction)), D.one, pin.indexDecimals, 'down');
    if (!D.isPos(size)) throw new UserError('below_min_size', `${fraction} of the position is nothing`, 422);
    const seen = await getByIdempotency(c.principal, idemKey);
    const order = this.canonical(c, t, m, { mode: 'live', instrument: pin.instrument, side: pos.isLong ? 'sell' : 'buy', type: 'market', size: D.str(size), reduceOnly: true, tif: 'ioc', slippageBps: slippageBps ?? DEFAULT_SLIPPAGE_BPS },
      idemKey, seen ? seen.created_at.getTime() : this.now());
    return this.place(c, order, t, m, idemKey, { strictReduce: true });
  }
  private async gmxOpOf(orderId: string): Promise<string | null> { const [r] = await sql<{ id: string }[]>`select id from deriv_gmx_ops where idempotency_key = ${orderId}`; return r?.id ?? null; }
  private gmxApproval(op: { id: string; kind: string; op_hash: string | null; expires_at: Date | null }): Record<string, unknown> {
    return { by: 'owner_passkey', engine: 'gmx', operationId: op.id, operation: op.kind, hash: op.op_hash, expiresAt: op.expires_at?.getTime() ?? null,
      approve: { method: 'POST', path: `/api/v1/derivatives/gmx/operations/${op.id}/approve`, body: '{ assertion }', note: 'owner session only: the passkey assertion is over the intent hash of the wallet transaction; the isolated signer rebuilds the transaction and verifies it' },
      sheet: { method: 'GET', path: `/api/v1/derivatives/gmx/operations/${op.id}`, note: 'the operation as the GMX engine stored it (size in USD, collateral, acceptable price, execution fee)' } };
  }

  private async market(t: Target, instrument: string): Promise<Market> {
    const m = await this.deps.risk.market(t.mode, t.venue, t.network, instrument);
    if (!m.instrument) throw new UserError('unknown_instrument', `unknown instrument '${instrument.slice(0, 80)}'${m.error ? ` (${m.error})` : ''}`, m.error && /unavailable|network|rate/i.test(m.error) ? 503 : 404);
    return { instrument: m.instrument, ticker: m.ticker, book: m.book };
  }

  /** the request of the trading API → the canonical order (decimals canonical, the client order id derived from the idempotency key) */
  private canonical(c: Caller, t: Target, m: Market, i: OrderInput, idemKey: string, now: number): CanonicalOrder {
    if (i.type === 'market' && i.price !== undefined) throw new UserError('bad_request', 'a market order is bounded by slippageBps, not by a price: send a limit order to name a price', 400);
    // GMX: what cannot be expressed there is refused before anything else is judged (the same rules are applied again on the canonical order, gmxBody)
    if (t.engine === 'gmx' && i.type !== 'market') throw new UserError('gmx_market_orders_only', `this wallet sends market orders to GMX; a ${i.type} order cannot be expressed there (GMX limit and trigger orders are not built by the signer)`, 422);
    if (t.engine === 'gmx' && !i.reduceOnly && i.leverage === undefined) throw new UserError('gmx_leverage_required', 'a GMX increase names its leverage: the collateral sent with the order is its USD size ÷ the leverage (GMX has no leverage setting to fall back on)', 422);
    if (t.mode === 'live' && t.engine !== 'gmx' && i.leverage !== undefined) throw new UserError('bad_request', 'on a venue account the leverage of an instrument is a venue setting: change it in the app (passkey)', 400);
    const trigger = i.type !== 'market' && i.type !== 'limit', limited = i.type === 'limit' || i.type === 'stop_limit' || i.type === 'take_profit_limit';
    const ref = limited ? i.price : trigger ? i.triggerPrice : m.ticker?.mark;
    const notional = ref !== undefined ? D.mul(D.from(i.size), D.from(ref)) : null;
    try {
      return canonicalOrder({ v: 1, venue: t.venue, network: t.network, instrument: i.instrument, marketKind: 'perp', side: i.side, type: i.type === 'market' ? 'market' : i.type === 'limit' ? 'limit' : i.type.startsWith('stop') ? 'stop' : 'take_profit',
        size: i.size, notional: null, limitPrice: limited ? i.price ?? null : null, triggerPrice: trigger ? i.triggerPrice ?? null : null, reduceOnly: i.reduceOnly, tif: i.type === 'market' ? 'ioc' : i.tif, maxSlippageBps: i.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
        maxFeeUsd: i.maxFeeUsd ?? (notional === null ? '0' : D.str(D.div(D.mul(notional, D.from(DEFAULT_FEE_CAP_BPS)), D.from(10000n), 6, 'up'))), leverage: i.leverage ?? null, marginMode: null,
        clientOrderId: clientOrderIdFor(t.venue, c.principal, idemKey), mode: t.mode, principal: c.principal, mandateId: c.principal.kind === 'owner' ? null : c.mandateId, createdAt: now, expiresAt: now + ORDER_TTL_MS });
    } catch (e) {
      if (e instanceof ZodError) throw new UserError('invalid_order', `${e.issues[0]?.path.join('.') ?? ''} ${e.issues[0]?.message ?? 'invalid order'}`.trim(), 400);
      throw e instanceof UserError ? e : new UserError('invalid_order', msg(e), 400);
    }
  }

  /** what the canonical order leaves open: the size in base units and the worst price of an order without a limit price */
  private resolved(order: CanonicalOrder, m: Market): { size: DecStr; worstPrice: DecStr | null; notionalUsd: DecStr | null } {
    const inst = m.instrument, mark = m.ticker?.mark ?? null;
    const px = order.limitPrice ?? order.triggerPrice ?? mark;
    let size: DecStr;
    if (order.size !== null) size = order.size;
    else {
      if (px === null) throw new UserError('venue_unavailable', 'no price is available to turn the notional into a size', 503);
      size = D.str(D.quantize(D.div(D.from(order.notional!), D.from(px), 18, 'down'), D.from(inst.lotSize), 'down'));
      if (!D.isPos(D.from(size))) throw new UserError('below_min_size', `the notional buys less than one lot (${inst.lotSize})`, 422);
    }
    let worst: DecStr | null = null;
    if (order.limitPrice === null) {
      if (order.maxSlippageBps < 1 || order.maxSlippageBps > MAX_SLIPPAGE_BPS) throw new UserError('bad_request', `slippageBps is between 1 and ${MAX_SLIPPAGE_BPS}`, 400);
      if (order.triggerPrice !== null) worst = boundPrice(inst, order.triggerPrice, order.side, order.maxSlippageBps);
      // live GMX has no order book (a liquidity pool priced by an oracle): the bound is taken from the venue's mark; the engine derives the acceptable price it signs from the oracle itself
      else if (inst.venue === 'gmx' && order.mode === 'live' && !m.book) { if (!m.ticker) throw new UserError('venue_unavailable', 'GMX\'s price could not be read: no worst price can be derived', 503); worst = boundPrice(inst, m.ticker.mark, order.side, order.maxSlippageBps); }
      else { if (!m.book) throw new UserError('venue_unavailable', `the ${inst.venue} book of ${inst.symbol} could not be read: no worst price can be derived`, 503); worst = worstPrice(inst, m.book, order.side, order.maxSlippageBps); }
    }
    const value = order.limitPrice ?? worst ?? px;
    return { size, worstPrice: worst, notionalUsd: order.notional ?? (value === null ? null : D.str(D.mul(D.from(size), D.from(value)))) };
  }

  private keyLimits(c: Caller, notionalUsd: DecStr | null, usedToday: DecStr): { code: string; message: string } | null {
    const l = c.limits;
    if (!l) return null;
    if (notionalUsd === null) return l.maxOrderNotionalUsd !== null || l.maxDailyNotionalUsd !== null ? { code: 'key_limit_exceeded', message: 'the order cannot be valued, so the key\'s notional limits cannot be checked' } : null;
    if (l.maxOrderNotionalUsd !== null && D.gt(D.from(notionalUsd), D.from(String(l.maxOrderNotionalUsd)))) return { code: 'key_limit_exceeded', message: `order notional ${notionalUsd} USD is above this key's limit of ${l.maxOrderNotionalUsd} USD per order` };
    if (l.maxDailyNotionalUsd !== null && D.gt(D.add(D.from(usedToday), D.from(notionalUsd)), D.from(String(l.maxDailyNotionalUsd)))) return { code: 'key_limit_exceeded', message: `today's notional ${usedToday} USD plus this order is above this key's daily limit of ${l.maxDailyNotionalUsd} USD` };
    return null;
  }
  private async keyUsedToday(c: Caller, exceptId: string | null): Promise<DecStr> {
    const [u] = await sql<{ n: string }[]>`select coalesce(sum(notional_usd), 0)::text as n from orders where principal_kind = ${c.principal.kind} and principal_id = ${c.principal.id} and created_at >= ${new Date(dayStart(this.now()))}
      and not reduce_only and state not in ('REJECTED', 'FAILED') and id <> ${exceptId ?? ''}`;
    return D.str(D.from(u!.n));
  }

  /**
   * Whose position is it? A key or an agent may reduce only the part of a position that its OWN fills opened (orders/provenance.ts):
   * never what the owner opened by hand, never another principal's. Applies to every order of a non-owner that points against the
   * position the account holds: a reduce-only order (close, reduce, stop-loss, take-profit) is bounded by the principal's own lot
   * minus what it already asked to reduce; an order that is not reduce-only may not eat into somebody else's part either.
   * The owner is not bound: the account is his.
   */
  private async provenanceRefusal(c: Caller, order: CanonicalOrder, t: Target, size: DecStr, position: DecStr, exceptId: string | null, ocoExcept: string | null = null): Promise<{ code: string; message: string; data: { provenance: Provenance } } | null> {
    if (c.principal.kind === 'owner' || order.marketKind !== 'perp') return null;
    const pos = D.from(position);
    if (D.isZero(pos) || D.isPos(pos) !== (order.side === 'sell')) return null;         // no position, or the order adds to it: nothing of anybody is reduced
    await this.drain();                                                                 // fills of orders placed through the older routes are attributed too
    const p = await provenance(c.principal, t.accountId, order.instrument, position, exceptId, ocoExcept);
    if (D.lte(D.from(size), D.from(p.reducible))) return null;
    if (!order.reduceOnly && !D.isPos(D.from(p.foreign))) return null;                  // the whole position is this principal's own: it may also turn it around, inside its mandate
    return { code: 'position_not_attributable', data: { provenance: p },
      message: `this ${c.principal.kind === 'api_key' ? 'key' : 'agent'} may reduce only what its own fills opened on this account: ${p.own} of the ${D.str(D.abs(pos))} ${order.instrument} there is attributable to it${D.isPos(D.from(p.pending)) ? ` (${p.pending} already in its open reduce-only orders)` : ''}; the order asks for ${size}. The rest was opened by the owner or by another principal and is not this one's to close.` };
  }

  // ------------------------------------------------------------------ views
  private legacyId(r: OrderRow): string { return r.origin === 'legacy' && r.engine_ref ? (r.engine === 'gmx' ? `gmx:${r.engine_ref}` : r.engine === 'spot' ? r.engine_ref : `deriv:${r.engine_ref}`) : r.id; }
  view(r: OrderRow) {
    const rec = r.record, d = r.detail as Record<string, string | null | boolean | undefined>;
    return {
      id: this.legacyId(r), orderId: r.id, mode: r.mode as 'paper' | 'live', venue: r.venue, network: r.network, accountId: r.account_id, clientId: (d.clientId as string | undefined) ?? r.id, clientOrderId: r.canonical?.clientOrderId ?? null,
      venueOrderId: rec.venueOrderId, instrument: r.instrument as string | null, side: r.side as string | null, type: r.type, size: rec.size, price: (d.price as string | null | undefined) ?? null, triggerPrice: (d.triggerPrice as string | null | undefined) ?? null,
      reduceOnly: r.reduce_only, tif: (d.tif as string | undefined) ?? 'gtc',
      /** the unified state (CREATED … UNKNOWN); `engineStatus` is the venue engine's own word for it */
      status: r.state as string, final: isTerminal(r.state) as boolean | null, reasonCode: r.reason, reason: rec.detail, rejectCode: r.reject_code, engineStatus: (d.engineState as string | undefined) ?? null,
      filled: rec.filledSize, avgFillPrice: rec.avgFillPrice, acknowledged: rec.acknowledged, cancelRequested: rec.cancelRequested,
      origin: r.origin, principal: { kind: r.principal_kind, id: r.principal_id }, mandateId: r.mandate_id, engine: r.engine, engineRef: r.engine_ref, hash: r.order_hash, notionalUsd: r.notional_usd === null ? null : D.str(D.from(r.notional_usd)),
      projectionError: r.projection_error, version: r.version, createdAt: r.created_at.getTime(), updatedAt: r.updated_at.getTime(),
      /** spot: the steps of the swap as the wallet recorded them (exec-status.ts), and what the swap gives and takes */
      ...(r.engine === 'spot' ? { execution: (d as { execution?: unknown }).execution ?? null, spot: { provider: d.provider ?? null, fromSymbol: d.fromSymbol ?? null, toSymbol: d.toSymbol ?? null, amountIn: d.amountIn ?? null, expectedOut: d.expectedOut ?? null, proposalId: d.proposalId ?? null, agentId: d.agentId ?? null } } : {}),
    };
  }
  private visible(c: Caller, r: OrderRow): boolean {
    const x = c.restrictions;
    if (!x) return true;
    // a spot order is restricted by venue (`spot`) and by network, as the read side always did; any other order by venue and instrument
    if (r.venue === 'spot') return (x.venues.length === 0 || x.venues.includes('spot')) && (x.networks.length === 0 || x.networks.includes(r.network));
    return (x.venues.length === 0 || x.venues.includes(r.venue)) && (x.instruments.length === 0 || x.instruments.includes(r.instrument));
  }
  private async find(id: string): Promise<OrderRow | null> {
    if (id.startsWith('deriv:')) return (await getByEngineRef('paper', id.slice(6))) ?? getByEngineRef('hyperliquid', id.slice(6));
    if (id.startsWith('gmx:')) return getByEngineRef('gmx', id.slice(4));
    if (id.startsWith('agent:') || id.startsWith('swap:')) return getByEngineRef('spot', id);      // a spot agent's swap, an owner's swap
    return id.length <= 128 ? getOrder(id) : null;
  }

  async list(c: Caller, q: { mode?: 'paper' | 'live' | undefined; venue?: string | undefined; open?: 'true' | 'false' | undefined; limit: number; mine?: boolean }) {
    await this.drain();
    const rows = await sql<OrderRow[]>`select * from orders where true ${q.mode ? sql`and mode = ${q.mode}` : sql``} ${q.venue ? sql`and venue = ${q.venue}` : sql``}
      ${q.open === 'true' ? sql`and state not in ('FILLED', 'CANCELLED', 'REJECTED', 'FAILED')` : q.open === 'false' ? sql`and state in ('FILLED', 'CANCELLED', 'REJECTED', 'FAILED')` : sql``}
      ${q.mine ? sql`and principal_kind = ${c.principal.kind} and principal_id = ${c.principal.id}` : sql``} order by created_at desc limit ${q.limit}`;
    return rows.filter((r) => this.visible(c, r)).map((r) => this.view(r));
  }
  async get(c: Caller, id: string) {
    await this.drain();
    const r = await this.find(id);
    if (!r) return null;
    if (!this.visible(c, r)) throw new UserError('restricted', 'this key is not allowed on this order', 403);
    let fills: unknown[] = [];
    if ((r.engine === 'paper' || r.engine === 'hyperliquid') && r.engine_ref) {
      const k = r.engine_ref.indexOf(':'), account = r.engine_ref.slice(0, k), client = r.engine_ref.slice(k + 1);
      const [e] = await sql<{ cloid: string | null }[]>`select cloid from deriv_orders where account_id = ${account} and client_id = ${client}`;
      fills = (await sql`select * from deriv_fills where account_id = ${account} and client_id = any(${[client, ...(e?.cloid ? [e.cloid] : [])]}) order by ts`).map((f) => ({ id: f.fill_id, instrument: f.instrument, side: f.side, price: f.price, size: f.size,
        fee: f.fee, feeAsset: f.fee_asset, closedPnl: f.closed_pnl, liquidation: f.liquidation, ts: (f.ts as Date).getTime() }));
    }
    return { order: { ...this.view(r), canonical: r.canonical }, fills, history: await history(r.id) };
  }

  // ------------------------------------------------------------------ preview
  /** every check an order would meet, on the market as it is now. Nothing is created, signed or sent. */
  async preview(c: Caller, input: OrderInput, idemKey: string) {
    if (SpotOrders.is(input.instrument)) return this.spot.preview(c, await this.spot.specOfInput(c, input, idemKey, this.now()));
    const now = this.now(), t = await this.target(c, input.mode, input.instrument, input.accountId), m = await this.market(t, input.instrument);
    const order = this.canonical(c, t, m, input, idemKey, now);
    const refusals: { stage: 'key' | 'lock' | 'mandate' | 'provenance' | 'risk' | 'engine'; code: string; message: string; reasons?: string[] }[] = [];
    let res: ReturnType<OrderService['resolved']> | null = null;
    try { res = this.resolved(order, m); } catch (e) { refusals.push({ stage: 'engine', code: e instanceof UserError ? e.code : 'internal', message: msg(e) }); }
    const ev = await this.deps.risk.evaluateOrder(order, { accountId: t.accountId, preview: true, ...(m.ticker ? { known: { ticker: m.ticker, book: m.book, account: null, positions: null, leverage: null }, instrument: m.instrument } : {}) });
    if (t.mode === 'live' && !this.deps.executionEnabled() && !ev.reducing) refusals.push({ stage: 'lock', code: 'execution_disabled', message: 'SPW_TRADING_API_EXECUTION is not "on": no new live risk is placed through the trading API (cancels and strictly reducing orders still pass)' });
    const kl = input.reduceOnly ? null : this.keyLimits(c, res?.notionalUsd ?? null, await this.keyUsedToday(c, null));
    if (kl) refusals.push({ stage: 'key', ...kl });
    if (res) { const pr = await this.provenanceRefusal(c, order, t, res.size, ev.derived.positionBefore, null); if (pr) refusals.push({ stage: 'provenance', code: pr.code, message: pr.message }); }
    let mandate: { id: string; decision: 'allow' | 'deny'; reasons: string[]; phase: string } | null = null;
    if (c.principal.kind !== 'owner') {
      try {
        const row = await this.deps.mandates.forPrincipal(c.principal as { kind: 'agent' | 'api_key'; id: string }, c.mandateId), d = await this.deps.mandates.check(row, order, t.accountId, ev, null);
        mandate = { id: row.id, decision: d.decision, reasons: d.reasons, phase: String(this.deps.mandates.phase(row)) };
        if (d.decision === 'deny') refusals.push({ stage: 'mandate', code: 'mandate_denied', message: `the order is outside the mandate: ${d.reasons.join(', ')}`, reasons: d.reasons });
      } catch (e) { if (!(e instanceof UserError)) throw e; refusals.push({ stage: 'mandate', code: e.code, message: e.message }); }
    }
    if (ev.decision === 'deny') refusals.push({ stage: 'risk', code: ev.code ?? 'risk_denied', message: ev.reason ?? 'denied by the risk engine' });
    // the engine's own verdict and estimate (its account policy, the venue's rules, fees and slippage against the real book, liquidation price, the server locks)
    let estimate: unknown = null, engineRisk: unknown = null;
    if (res) {
      if (t.engine === 'gmx') {
        // the GMX engine's own estimate and verdicts, under the codes its `prepareOrder` would refuse with
        try {
          const g = await this.gmxEngine(), p = await g.preview(await this.gmxBody(order, t, m, res)), exit = order.reduceOnly;
          estimate = p.estimate; engineRisk = p.risk;
          const LOCK: Record<string, [string, boolean]> = { gmx_setting_off: ['gmx_disabled', true], mainnet_setting_off: ['mainnet_disabled', true], signer_halted: ['halted', true], not_authorized: ['not_authorized', false], authorization_expired: ['not_authorized', false],
            authorization_revoked: ['not_authorized', false], contracts_changed: ['contract_changed', false] };
          for (const b of p.blockers) { const l = LOCK[b]; if (l && !(exit && l[1]) && !refusals.some((r) => r.code === l[0])) refusals.push({ stage: 'lock', code: l[0], message: `GMX: ${b}${l[1] ? ' (new positions only: closing and cancelling stay possible)' : ''}` }); }
          if (!p.risk.ok && !refusals.some((r) => r.code === 'not_authorized')) refusals.push({ stage: 'engine', code: `risk_${p.risk.code}`, message: p.risk.reason });
          if (p.signerWould) refusals.push({ stage: 'engine', code: 'venue_policy', message: p.signerWould });
        } catch (e) { if (!(e instanceof UserError)) throw e; refusals.push({ stage: e.code.endsWith('_disabled') ? 'lock' : 'engine', code: e.code, message: e.message }); }
      } else try {
        const p = t.engine === 'paper' ? await this.deps.derivatives().paper.preview(t.accountId, this.body(order, res)) : await this.deps.live().preview(t.accountId, this.body(order, res));
        estimate = p.estimate; engineRisk = p.risk;
        if (!p.risk.ok && !refusals.some((r) => r.stage === 'risk')) refusals.push({ stage: 'engine', code: p.risk.code, message: p.risk.reason });
      } catch (e) { if (!(e instanceof UserError)) throw e; refusals.push({ stage: e.code.endsWith('_disabled') ? 'lock' : 'engine', code: e.code, message: e.message }); }
      if (t.engine === 'hyperliquid' && c.principal.kind !== 'owner' && !order.reduceOnly) {
        const st = await this.deps.live().mandateAccountState(t.accountId).catch(() => null);
        if (st?.blocked && !refusals.some((r) => r.code === st.blocked!.code)) refusals.push({ stage: 'lock', code: st.blocked.code, message: st.blocked.message });
      }
    }
    return {
      order, hash: canonicalOrderHashHex(order), resolved: res, wouldExecute: refusals.length === 0, refusals,
      approval: c.principal.kind === 'owner' ? { required: t.mode === 'live', by: t.mode === 'live' ? 'owner_passkey' as const : 'none' as const, note: t.mode === 'live' ? 'the order waits AWAITING_APPROVAL until the owner approves it with the passkey in the app' : 'paper: nothing is signed' }
        : { required: false, by: 'mandate' as const, note: t.mode === 'live' ? 'no per-order approval: the isolated signer applies the derivative mandate it stores' : 'paper: nothing is signed' },
      risk: { decision: ev.decision, reducing: ev.reducing, checks: ev.checks, derived: ev.derived, decisionId: ev.decisionId }, mandate, engine: { name: t.engine, risk: engineRisk, estimate },
      account: { id: t.accountId, venue: t.venue, network: t.network, equity: ev.accounts.find((a) => a.accountId === t.accountId)?.equity ?? null, freeCollateral: ev.accounts.find((a) => a.accountId === t.accountId)?.freeCollateral ?? null },
      ts: now,
    };
  }

  private body(order: CanonicalOrder, res: { size: DecStr; worstPrice: DecStr | null }): OrderBody {
    const req = toOrderRequest(order, res);
    return { instrument: req.instrument, side: req.side, type: req.type, size: req.size, price: req.price, triggerPrice: req.triggerPrice, reduceOnly: req.reduceOnly, tif: req.tif, ...(order.leverage !== null && order.mode === 'paper' ? { leverage: order.leverage } : {}) };
  }

  // ------------------------------------------------------------------ placing
  /** an order of the trading API (size, optional price). Idempotent on (principal, idemKey). */
  async submit(c: Caller, input: OrderInput, idemKey: string, o: { origin?: Origin; strictReduce?: boolean } = {}) {
    if (SpotOrders.is(input.instrument)) { const was = await getByIdempotency(c.principal, idemKey); return this.spot.submit(c, await this.spot.specOfInput(c, input, idemKey, was ? was.created_at.getTime() : this.now()), idemKey, o.origin); }
    const now = this.now(), t = await this.target(c, input.mode, input.instrument, input.accountId);
    const seen = await getByIdempotency(c.principal, idemKey);
    const m = await this.market(t, input.instrument), order = this.canonical(c, t, m, input, idemKey, seen ? seen.created_at.getTime() : now);
    return this.place(c, order, t, m, idemKey, o);
  }

  /** a canonical order (the command engine, an agent): the account is the wallet's account on the order's venue */
  async submitCanonical(c: Caller, input: CanonicalOrderInput, idemKey: string, o: { origin?: Origin; accountId?: string; strictReduce?: boolean; oco?: { group: string; sibling: string } } = {}) {
    let order: CanonicalOrder;
    try { order = canonicalOrder(input); } catch (e) { throw new UserError('invalid_order', e instanceof ZodError ? `${e.issues[0]?.path.join('.') ?? ''} ${e.issues[0]?.message ?? ''}`.trim() : msg(e), 400); }
    if (order.principal.kind !== c.principal.kind || order.principal.id !== c.principal.id || (c.principal.kind !== 'owner' && order.mandateId !== c.mandateId)) throw new UserError('invalid_order', 'the order names another principal or another mandate than the caller\'s', 400);
    if (order.mode === 'research') throw new UserError('invalid_order', 'a research order is never placed', 400);
    if (order.marketKind === 'spot') return this.spot.submit(c, this.spot.specOfCanonical(c, order), idemKey, o.origin);      // the owner: the swap proposal flow; anybody else: the precise refusal
    const t = await this.target(c, order.mode, order.instrument, o.accountId);
    if (t.network !== order.network) throw new UserError('invalid_order', `the order is for ${order.network}; the account is on ${t.network}`, 400);
    return this.place(c, order, t, await this.market(t, order.instrument), idemKey, o);
  }

  private async place(c: Caller, order: CanonicalOrder, t: Target, m: Market, idemKey: string, o: { origin?: Origin; strictReduce?: boolean; /** orders/attached.ts: this order's one-cancels-the-other group, and its sibling's */ oco?: { group: string; sibling: string } }) {
    const bodyHash = orderBodyHashHex(order), id = order.clientOrderId, owner = c.principal.kind === 'owner';
    // 1 — idempotency: the same key and the same body is the same order; the same key and another body is refused
    const existing = (await getByIdempotency(c.principal, idemKey)) ?? (await getOrder(id));
    if (existing) return this.replay(existing, bodyHash, c);
    if (!owner && !c.mandateId) throw new UserError('mandate_required', 'this principal has no trading mandate: nothing it asks can execute', 403);
    // 2 — what is refused before an order exists
    const res = this.resolved(order, m);
    const first = await this.deps.risk.evaluateOrder(order, { accountId: t.accountId, preview: true, ...(m.ticker ? { known: { ticker: m.ticker, book: m.book, account: null, positions: null, leverage: null }, instrument: m.instrument } : {}) });
    if (o.strictReduce && !first.reducing) throw new UserError('not_reducing', 'this order would not strictly reduce an existing position: nothing was placed', 422);
    if (t.mode === 'live' && !this.deps.executionEnabled() && !first.reducing) throw new UserError('execution_disabled', 'live execution through the trading API is disabled on this server (SPW_TRADING_API_EXECUTION is not "on"); nothing was created. Cancels and strictly reducing orders still pass.', 403);
    if (!first.reducing) { const kl = this.keyLimits(c, res.notionalUsd, await this.keyUsedToday(c, null)); if (kl) throw new UserError(kl.code, kl.message, 403); }
    const pr = await this.provenanceRefusal(c, order, t, res.size, first.derived.positionBefore, null, o.oco?.sibling ?? (o.strictReduce ? '*' : null));
    if (pr) throw refusal(pr.code, pr.message, 403, pr.data);
    // 3 — the order exists from here: every outcome is a state of it
    const req = toOrderRequest(order, res);
    const row = await insertOrder({ id, principal: c.principal, idempotencyKey: idemKey, bodyHash, mode: t.mode, venue: t.venue, network: t.network, instrument: order.instrument, marketKind: order.marketKind, side: order.side, type: req.type, reduceOnly: order.reduceOnly,
      accountId: t.accountId, mandateId: order.mandateId, canonical: order, orderHash: canonicalOrderHashHex(order),
      // a GMX order is sized in USD and its execution is an on-chain event without a token quantity the engine stores: like the GMX operations adopted from the older routes, the unified order is unsized (the token size asked is in `canonical` and `detail.gmx`)
      size: t.engine === 'gmx' ? null : res.size, engine: t.engine, engineRef: null, notionalUsd: res.notionalUsd, origin: o.origin ?? 'trading_api',
      detail: { clientId: id, price: req.price, triggerPrice: req.triggerPrice, tif: req.tif, maxSlippageBps: order.maxSlippageBps, strictReduce: o.strictReduce === true, ...(o.oco ? { ocoGroup: o.oco.group } : {}) }, createdAt: order.createdAt });
    if (!row) { const again = (await getByIdempotency(c.principal, idemKey)) ?? (await getOrder(id)); if (again) return this.replay(again, bodyHash, c); throw new UserError('idempotency_conflict', 'this client order id is in use', 409); }
    const reject = async (ev: Extract<OrderEvent, { type: 'local_rejected' | 'local_failed' }>, code: string): Promise<OrderRow> => (await applyEvent(id, ev, this.now(), { rejectCode: code }))!.row;
    // 4 — the risk engine, on the stored order (the decision is linked to it)
    const ev = await this.deps.risk.evaluateOrder(order, { accountId: t.accountId, orderId: id, engineReq: req, ...(m.ticker ? { known: { ticker: m.ticker, book: m.book, account: null, positions: null, leverage: null }, instrument: m.instrument } : {}) });
    // 5 — the mandate (an agent or an API key acts under one, exactly)
    let mandate: MandateRow | null = null;
    if (!owner) {
      let reasons: string[] = [], code = 'mandate_denied', text = '';
      try {
        mandate = await this.deps.mandates.forPrincipal(c.principal as { kind: 'agent' | 'api_key'; id: string }, c.mandateId);
        const d = await this.deps.mandates.check(mandate, order, t.accountId, ev, id);
        if (d.decision === 'deny') { reasons = d.reasons; text = `the order is outside the mandate: ${d.reasons.join(', ')}`; }
      } catch (e) { if (!(e instanceof UserError)) throw e; code = e.code; text = e.message; reasons = [e.code.toUpperCase()]; }
      if (text) {
        const r = await reject({ type: 'local_rejected', reason: 'MANDATE_DENIED', detail: text.slice(0, 500) }, code);
        if (mandate) await this.deps.mandates.recordOutcome(mandate.id, { accepted: false, notionalUsd: null });
        throw refusal(code, text, 403, { reasons, order: this.view(r) });
      }
    }
    if (ev.decision === 'deny') {
      const code = ev.code ?? 'risk_denied', r = await reject({ type: 'local_rejected', reason: code === 'kill_switch_active' ? 'KILL_SWITCH_ACTIVE' : code === 'read_only_mode' ? 'READ_ONLY_MODE' : 'RISK_DENIED', detail: (ev.reason ?? 'denied').slice(0, 500) }, code);
      if (mandate) await this.deps.mandates.recordOutcome(mandate.id, { accepted: false, notionalUsd: null });
      throw refusal(code, ev.reason ?? 'denied by the risk engine', code === 'risk_denied' ? 422 : 423, { failed: ev.failed, checks: ev.checks.filter((x) => !x.ok), decisionId: ev.decisionId, order: this.view(r) });
    }
    // a live order runs under the VENUE's leverage setting: an order that names another one is not the order that would execute
    if (t.mode === 'live' && t.engine !== 'gmx' && order.leverage !== null && !ev.reducing && (ev.leverage === null || !D.eq(D.from(order.leverage), D.from(ev.leverage)))) {
      const text = `the order names leverage ${order.leverage}; the venue's setting for ${order.instrument} is ${ev.leverage ?? 'unknown'}: change the setting in the app (passkey) or send the order without a leverage`;
      const r = await reject({ type: 'local_rejected', reason: 'INVALID_ORDER', detail: text }, 'leverage_mismatch');
      throw refusal('leverage_mismatch', text, 422, { order: this.view(r) });
    }
    if (o.strictReduce && !ev.reducing) { const r = await reject({ type: 'local_rejected', reason: 'INVALID_ORDER', detail: 'the order would not strictly reduce an existing position' }, 'not_reducing'); throw refusal('not_reducing', 'this order would not strictly reduce an existing position', 422, { order: this.view(r) }); }
    await applyEvent(id, { type: 'validated' }, this.now());
    // 6 — the engine's own path
    // (a GMX order is linked to its engine row by the operation id, known once the engine stored it)
    let ref = `${t.accountId}:${id}`;
    const kind: 'deriv' | 'gmx' = t.engine === 'gmx' ? 'gmx' : 'deriv', body = this.body(order, res);
    let failure: UserError | null = null;
    try {
      if (t.engine === 'gmx') {
        // the order id is the engine's idempotency key: a retry answers the same operation, and the gate excludes this order from its own usage
        const g = await this.gmxEngine(), gb = await this.gmxBody(order, t, m, res);
        await patchOrder(id, this.now(), { detail: { gmx: { action: gb.action, side: gb.side, market: gb.market, sizeUsd: gb.sizeUsd ?? null, collateral: gb.collateral ?? null, leverage: order.leverage, slippageBps: gb.slippageBps } } });
        this.engineCalls.gmxPrepare += 1;
        const out = await g.prepareOrder(gb, id);
        ref = out.operation.id;
        await patchOrder(id, this.now(), { engineRef: ref });
      } else if (t.engine === 'paper') {
        await mutate(id, this.now(), () => ({ events: owner ? [{ type: 'approval_requested', detail: 'paper: no passkey is required' }, { type: 'approved', by: 'owner', detail: 'paper: nothing is signed' }, { type: 'submit_started' }]
          : [{ type: 'approved', by: 'mandate' }, { type: 'submit_started' }], patch: { engineRef: ref } }));
        this.engineCalls.paper += 1;
        await this.deps.derivatives().paper.order(t.accountId, body, id);
      } else if (owner) {
        await patchOrder(id, this.now(), { engineRef: ref });
        this.engineCalls.hyperliquidPropose += 1;
        await this.deps.live().propose(t.accountId, body, id, order.reduceOnly && o.strictReduce ? 'close' : 'owner');
      } else {
        await mutate(id, this.now(), () => ({ events: [{ type: 'approved', by: 'mandate' }, { type: 'submit_started' }], patch: { engineRef: ref } }));
        this.engineCalls.hyperliquidMandate += 1;
        await this.deps.live().placeMandateOrder(t.accountId, req as OrderRequest, { strategySha256: mandate!.mandate.strategySha256!, agentId: c.principal.id, clientId: id });
      }
    } catch (e) {
      if (kind === 'gmx') ref = (await this.gmxOpOf(id)) ?? ref;        // the engine may have stored the operation before it failed
      const stored = await this.engineRow(kind, ref);
      if (!stored) {
        // the engine stored nothing: nothing was signed and nothing left. A refusal is a refusal; anything else is a failure with that proof.
        if (e instanceof UserError && e.status < 500) { const r = reasonOfCode(kind === 'gmx' && e.code.startsWith('risk_') ? 'risk_denied' : e.code); await reject({ type: 'local_rejected', reason: r.reason, detail: e.message.slice(0, 500) }, e.code); failure = e; }
        else { await reject({ type: 'local_failed', reason: 'INTERNAL_ERROR', detail: `the engine did not store the order (${msg(e)}); nothing was signed or sent`.slice(0, 500) }, e instanceof UserError ? e.code : 'internal'); failure = e instanceof UserError ? e : new UserError('internal', 'the order could not be handed to the engine; nothing was signed or sent', 500); }
      } else if (e instanceof UserError) failure = e;
      else console.error(`[orders] ${id}: ${msg(e)}`);                 // the engine row tells the truth from here (it may be unknown): projected below
    }
    await this.projectRef(kind, ref);
    const final = (await getOrder(id))!;
    if (mandate) await this.deps.mandates.recordOutcome(mandate.id, { accepted: final.state !== 'REJECTED' && final.state !== 'FAILED', notionalUsd: res.notionalUsd });
    if (failure && (final.state === 'REJECTED' || final.state === 'FAILED')) throw refusal(failure.code, failure.message, failure.status, { order: this.view(final) });
    return this.answer(final, false);
  }

  private async replay(existing: OrderRow, bodyHash: string, c: Caller) {
    if (existing.principal_kind !== c.principal.kind || existing.principal_id !== c.principal.id) throw new UserError('idempotency_conflict', 'this client order id belongs to another principal', 409);
    const d = dedupe(existing.body_hash ? { clientOrderId: existing.id, bodyHash: existing.body_hash } : null, { bodyHash });
    if (d.kind === 'conflict') throw new UserError('idempotency_conflict', 'this Idempotency-Key was used with a different order', 409);
    if (existing.engine_ref) await this.projectRef(existing.engine === 'gmx' ? 'gmx' : 'deriv', existing.engine_ref);
    return this.answer((await getOrder(existing.id))!, true);
  }

  private async answer(r: OrderRow, idempotent: boolean) {
    let approval: Record<string, unknown> | null = null;
    if (r.state === 'AWAITING_APPROVAL' && r.engine === 'hyperliquid' && r.engine_ref) {
      const k = r.engine_ref.indexOf(':'), account = r.engine_ref.slice(0, k), client = r.engine_ref.slice(k + 1);
      const [e] = await sql<{ order_hash: string | null; expires_at: Date | null }[]>`select order_hash, expires_at from deriv_orders where account_id = ${account} and client_id = ${client}`;
      approval = { by: 'owner_passkey', engine: 'hyperliquid', accountId: account, clientId: client, hash: e?.order_hash ?? null, expiresAt: e?.expires_at?.getTime() ?? null,
        approve: { method: 'POST', path: `/api/v1/derivatives/live/accounts/${account}/orders/${client}/approve`, body: '{ assertion }', note: 'owner session only: the passkey assertion is over the order hash; the isolated signer verifies it' } };
    }
    if (r.state === 'AWAITING_APPROVAL' && r.engine === 'gmx' && r.engine_ref) {
      const [e] = /^[0-9a-f-]{36}$/.test(r.engine_ref) ? await sql<{ id: string; kind: string; op_hash: string | null; expires_at: Date | null }[]>`select id, kind, op_hash, expires_at from deriv_gmx_ops where id = ${r.engine_ref}` : [];
      if (e) approval = this.gmxApproval(e);
    }
    return { order: this.view(r), idempotent, approval };
  }

  // ------------------------------------------------------------------ cancel, close, reduce
  /** withdraws or cancels. A cancel only removes what could still execute: no mandate is required, the kill switch and read-only mode never stop it. */
  async cancel(c: Caller, id: string) {
    const r = await this.find(id);
    if (!r) throw new UserError('unknown_order', 'unknown order', 404);
    if (c.principal.kind !== 'owner' && (r.principal_kind !== c.principal.kind || r.principal_id !== c.principal.id)) throw new UserError('not_your_order', 'a key cancels its own orders only', 403);
    await this.deps.risk.evaluateCancel({ venue: r.venue, clientOrderId: r.id, orderId: r.id, principal: c.principal, mode: r.mode, instrument: r.instrument });
    if (isTerminal(r.state)) return { order: this.view(r), sent: false, changed: false };
    if (r.engine === 'spot') return { ...(await this.spot.cancel(c, r)), venue: null };
    const ref = r.engine_ref, k = ref ? ref.indexOf(':') : -1, account = ref ? ref.slice(0, k) : '', client = ref ? ref.slice(k + 1) : '';
    const stored = ref && r.engine !== 'gmx' ? await this.engineRow('deriv', ref) : null;
    if (r.engine === 'gmx') return this.gmxCancel(c, r);
    if (!stored) {
      // never reached an engine: withdrawn here, at once
      if (AT_VENUE.includes(r.state)) throw new UserError('bad_state', 'the order is being handed to its engine right now; ask again in a moment', 409);
      const a = await applyEvent(r.id, { type: 'cancel_requested', reason: 'CANCELLED_BY_REQUEST' }, this.now());
      return { order: this.view(a!.row), sent: false, changed: true };
    }
    if (AT_VENUE.includes(r.state) && !r.record.cancelRequested) await applyEvent(r.id, { type: 'cancel_requested' }, this.now());
    let venue: unknown = null;
    if (r.engine === 'paper') await this.deps.derivatives().paper.cancel(account, client);
    else { const out = await this.deps.live().cancelOrder(account, client); venue = (out as { venue?: unknown }).venue ?? null; }
    await this.projectRef('deriv', ref!);
    return { order: this.view((await getOrder(r.id))!), sent: r.engine !== 'paper', changed: true, venue };
  }

  /** cancels every open order of a mandate that could still add risk (wind-down). Returns how many cancels were asked. */
  async cancelResting(mandateId: string): Promise<number> {
    const rows = await sql<OrderRow[]>`select * from orders where mandate_id = ${mandateId} and not reduce_only and state not in ('FILLED', 'CANCELLED', 'REJECTED', 'FAILED')`;
    let n = 0;
    for (const r of rows) { try { await this.cancel(OWNER_CALLER, r.id); n += 1; } catch (e) { console.error(`[orders] wind-down cancel of ${r.id}: ${msg(e)}`); } }
    return n;
  }

  /** `<mode>:<venue>:<accountId>:<instrument>` (GET /positions) → the position as its account reports it now */
  private async position(c: Caller, positionId: string): Promise<{ t: Target; position: Position }> {
    const parts = positionId.split(':'), mode = parts[0], venue = parts[1] ?? '', accountId = parts[2] ?? '', instrument = parts.slice(3).join(':');
    if ((mode !== 'paper' && mode !== 'live') || !venue || !/^[0-9a-f-]{36}$/.test(accountId) || !instrument) throw new UserError(venue === 'gmx' ? 'close_in_app' : 'unknown_position', venue === 'gmx' ? 'a GMX position is closed by a wallet transaction approved with the passkey: close it in the app' : 'unknown position', venue === 'gmx' ? 422 : 404);
    const t = await this.target(c, mode, instrument, accountId);
    const positions = t.engine === 'paper' ? (await this.deps.derivatives().paper.list()).find((a) => a.id === t.accountId)?.positions ?? [] : (await this.deps.live().mandateAccountState(t.accountId)).positions;
    const position = positions.find((p) => p.instrument === instrument);
    if (!position) throw new UserError('no_position', `no open position on ${instrument} on this account`, 422);
    return { t, position };
  }
  /** a strictly reduce-only market order on a share of a position. For a key: the position must be on an account and an instrument of its mandate (the mandate check says so). */
  async reducePosition(c: Caller, positionId: string, fraction: string, slippageBps: number | undefined, idemKey: string) {
    if (!D.isValid(fraction) || !D.isPos(D.from(fraction)) || D.gt(D.from(fraction), D.one)) throw new UserError('bad_request', 'the fraction is above 0 and at most 1', 400);
    if (positionId.startsWith('live:gmx:')) return this.gmxReduce(c, positionId, fraction, slippageBps, idemKey);
    const { t, position } = await this.position(c, positionId), m = await this.market(t, position.instrument);
    // the owner closes the position; a key or an agent closes ITS part of it: what its own fills opened, minus what it already asked to reduce
    const seen = await getByIdempotency(c.principal, idemKey);
    let basis = D.from(position.size);
    if (c.principal.kind !== 'owner' && !seen) {
      await this.drain();
      // (an explicit close supersedes the principal's own protective orders — the attached stop-loss / take-profit: they are not counted against it, and the supervisor cancels them once what they protected is gone)
      const p = await provenance(c.principal, t.accountId, position.instrument, position.side === 'long' ? position.size : D.str(D.neg(D.from(position.size))), null, '*');
      if (!D.isPos(D.from(p.reducible))) throw refusal('position_not_attributable', `nothing of the ${position.size} ${position.instrument} on this account is this ${c.principal.kind === 'api_key' ? 'key' : 'agent'}'s to close: it was opened by the owner or by another principal${D.isPos(D.from(p.pending)) ? `, or is already in its open reduce-only orders (${p.pending})` : ''}`, 403, { provenance: p });
      basis = D.from(p.reducible);
    }
    const whole = D.eq(D.from(fraction), D.one), size = whole ? basis : D.quantize(D.mul(basis, D.from(fraction)), D.from(m.instrument.lotSize), 'down');
    if (!D.isPos(size)) throw new UserError('below_min_size', `${fraction} of the position is less than one lot (${m.instrument.lotSize})`, 422);
    const order = this.canonical(c, t, m, { mode: t.mode, accountId: t.accountId, instrument: position.instrument, side: position.side === 'long' ? 'sell' : 'buy', type: 'market', size: D.str(size), reduceOnly: true, tif: 'ioc', slippageBps: slippageBps ?? DEFAULT_SLIPPAGE_BPS },
      idemKey, seen ? seen.created_at.getTime() : this.now());
    const out = await this.place(c, order, t, m, idemKey, { strictReduce: true });
    // protective orders attached to what was just reduced are re-judged at once, not at the supervisor's next pass
    await this.attached.supervise().catch((e: unknown) => console.error(`[orders] attached orders: ${msg(e)}`));
    return out;
  }

  // ------------------------------------------------------------------ projection of the engines
  private async engineRow(kind: 'deriv' | 'gmx', ref: string): Promise<Row | null> {
    if (kind === 'gmx') { const [r] = /^[0-9a-f-]{36}$/.test(ref) ? await sql`select * from deriv_gmx_ops where id = ${ref}` : []; return r ?? null; }
    const k = ref.indexOf(':'), account = ref.slice(0, k), client = ref.slice(k + 1);
    if (!/^[0-9a-f-]{36}$/.test(account)) return null;
    const [r] = await sql`select o.*, coalesce(pa.venue, la.venue) as venue, coalesce(pa.network, la.network) as network, (pa.id is not null) as is_paper, (la.id is not null) as is_live
      from deriv_orders o left join deriv_paper_accounts pa on pa.id = o.account_id left join deriv_accounts la on la.id = o.account_id where o.account_id = ${account} and o.client_id = ${client}`;
    return r && (r.is_paper || r.is_live) ? r : null;
  }

  /** an engine row placed through a route that existed before this service: it becomes a unified order the first time it is seen */
  private async adopt(kind: 'deriv' | 'gmx', ref: string, e: Row): Promise<OrderRow | null> {
    const id = `adopt-${createHash('sha256').update(`${kind}|${ref}`).digest('hex').slice(0, 40)}`;
    if (kind === 'gmx') {
      // an operation this service asked for (its idempotency key is the order's id) is LINKED to its order, never adopted as a second one
      const mine = typeof e.idempotency_key === 'string' && e.idempotency_key.length <= 128 ? await getOrder(e.idempotency_key) : null;
      if (mine && mine.engine === 'gmx' && (mine.engine_ref === null || mine.engine_ref === ref)) { if (mine.engine_ref === null) await patchOrder(mine.id, this.now(), { engineRef: ref }); return getByEngineRef('gmx', ref); }
      const usd = (() => { try { return D.str(D.div(D.from(String(e.size_usd ?? '0')), D.from(10n ** 30n), 2, 'down')); } catch { return null; } })();
      await insertOrder({ id, principal: { kind: 'owner', id: 'owner' }, idempotencyKey: null, bodyHash: null, mode: 'live', venue: 'gmx', network: 'arbitrum', instrument: `gmx:${String(e.market ?? 'unknown')}`, marketKind: 'perp',
        side: (e.kind === 'increase') === (e.is_long === true) ? 'buy' : 'sell', type: 'market', reduceOnly: e.kind === 'decrease', accountId: String(e.account ?? ''), mandateId: null, canonical: null, orderHash: null, size: null, engine: 'gmx', engineRef: ref,
        notionalUsd: usd, origin: 'legacy', detail: { clientId: ref, kind: e.kind, market: e.market, isLong: e.is_long, sizeUsd: usd, tif: 'ioc' }, createdAt: (e.created_at as Date).getTime() });
      return getByEngineRef('gmx', ref);
    }
    const paper = e.is_paper === true, engine: Engine = paper ? 'paper' : 'hyperliquid', agent = (e.agent ?? null) as { agentId?: string } | null;
    const size = canon(String(e.size)), price = e.price === null ? null : canon(String(e.price));
    await insertOrder({ id, principal: e.origin === 'mandate' ? { kind: 'agent', id: (agent?.agentId ?? 'agent').slice(0, 80) } : { kind: 'owner', id: 'owner' }, idempotencyKey: null, bodyHash: null, mode: paper ? 'paper' : 'live', venue: e.venue, network: e.network,
      instrument: e.instrument, marketKind: 'perp', side: e.side, type: e.type, reduceOnly: e.reduce_only === true, accountId: e.account_id, mandateId: e.mandate_id ?? null, canonical: null, orderHash: (e.order_hash as string | null) ?? null, size: D.isPos(D.from(size)) ? size : null,
      engine, engineRef: ref, notionalUsd: price === null ? null : D.str(D.mul(D.from(size), D.from(price))), origin: 'legacy',
      detail: { clientId: e.client_id, price, triggerPrice: e.trigger_price === null ? null : canon(String(e.trigger_price)), tif: e.tif, engineOrigin: e.origin }, createdAt: (e.created_at as Date).getTime() });
    const row = await getByEngineRef(engine, ref);
    // the decision the gate made for this engine order is linked to the unified order now that it exists
    if (row) { const cid = /^[A-Za-z0-9._:-]{8,128}$/.test(String(e.client_id)) ? String(e.client_id) : `legacy-${createHash('sha256').update(String(e.client_id)).digest('hex').slice(0, 32)}`;
      await sql`update risk_decisions set order_id = ${row.id} where client_order_id = ${cid} and order_id is null and not preview`; }
    return row;
  }

  /** one engine row → the events of its unified order. Idempotent: an engine row already projected (same signature) does nothing. */
  async projectRef(kind: 'deriv' | 'gmx', ref: string): Promise<OrderRow | null> {
    const e = await this.engineRow(kind, ref);
    if (!e || (kind === 'gmx' && e.kind === 'cancel')) return null;
    const snap: EngineSnapshot = kind === 'gmx' ? gmxSnapshot(e) : e.is_paper ? paperSnapshot(e) : hyperliquidSnapshot(e);
    const engine: Engine = kind === 'gmx' ? 'gmx' : e.is_paper ? 'paper' : 'hyperliquid';
    const row = (await getByEngineRef(engine, ref)) ?? (await this.adopt(kind, ref, e));
    if (!row) return null;
    if (row.engine_sig === snap.sig && row.projection_error === null) return row;
    const now = this.now();
    const out = await mutateWith(row.id, now, (_locked, record: OrderRecord) => {
      const a = advance(record, snap, now);
      return { steps: a.steps, order: a.order, patch: { engineSig: snap.sig, projectionError: a.error, ...(snap.requestExpiresAt !== null ? { requestExpiresAt: snap.requestExpiresAt } : {}),
        nextReconcileAt: a.order.state === 'UNKNOWN' ? now + 5_000 : null, detail: { engineState: String(e.state ?? e.status), engineReason: (e.reject_reason ?? e.error ?? null) as string | null } } };
    });
    if (out?.row.projection_error) console.error(`[orders] projection of ${engine} ${ref}: ${out.row.projection_error}`);
    return out?.row ?? row;
  }

  /** drains the queue the database triggers fill: every engine row that changed since the last pass is projected */
  async drain(): Promise<number> {
    const rows = await sql<{ engine: string; ref: string; last: string }[]>`select engine, ref, max(id)::text as last from order_projection_queue group by engine, ref order by max(id) limit 500`;
    let n = 0;
    for (const q of rows) {
      try { if (q.engine === 'swap' || q.engine === 'agent_swap') await this.spot.project(q.engine, q.ref); else await this.projectRef(q.engine === 'gmx' ? 'gmx' : 'deriv', q.ref); n += 1; }
      catch (e) { if (e instanceof IllegalTransitionError) console.error(`[orders] projection ${q.engine} ${q.ref}: ${e.message}`); else { console.error(`[orders] projection ${q.engine} ${q.ref} failed: ${msg(e)}`); continue; } }
      await sql`delete from order_projection_queue where engine = ${q.engine} and ref = ${q.ref} and id <= ${q.last}`;
    }
    return n;
  }

  // ------------------------------------------------------------------ reconciler (restart-safe: the database is its only memory)
  /**
   * One pass: (1) the engines' changes, (2) UNKNOWN orders — the venue is asked for the client order id through the engine's own
   * reconciliation, and the answer is projected (FAILED only once the venue's absence is conclusive), (3) orders of this service
   * that never reached their engine (a crash between two steps) and (4) orders whose validity ended before they left.
   */
  async reconcile(): Promise<{ projected: number; unknown: number; resolved: number; orphans: number; expired: number }> {
    const now = this.now(), out = { projected: await this.drain(), unknown: 0, resolved: 0, orphans: 0, expired: 0 };
    // stop-loss / take-profit attached to an order: placed once the parent filled, one cancels the other (orders/attached.ts)
    await this.attached.supervise().catch((e: unknown) => console.error(`[orders] attached orders: ${msg(e)}`));
    const unknown = await sql<OrderRow[]>`select * from orders where state = 'UNKNOWN' and engine_ref is not null and (next_reconcile_at is null or next_reconcile_at <= ${new Date(now)}) order by updated_at limit 100`;
    const accounts = new Set<string>();
    for (const r of unknown) {
      out.unknown += 1;
      try {
        if (r.engine === 'hyperliquid') { const account = r.engine_ref!.slice(0, r.engine_ref!.indexOf(':')); if (!accounts.has(account)) { accounts.add(account); await this.deps.live().reconcile(account); } }
        const after = await this.projectRef(r.engine === 'gmx' ? 'gmx' : 'deriv', r.engine_ref!);
        // the engine row did not change (same signature) but time passed: the absence may have become conclusive
        const cur = after && after.state === 'UNKNOWN' ? await this.reproject(after) : after;
        if (cur && cur.state !== 'UNKNOWN') out.resolved += 1; else await patchOrder(r.id, now, { nextReconcileAt: now + 5_000 });
      } catch (e) { console.error(`[orders] reconcile ${r.id}: ${msg(e)}`); await patchOrder(r.id, now, { nextReconcileAt: now + 15_000 }).catch(() => {}); }
    }
    // an order this service created and whose engine holds nothing after the grace: the engine stores an order BEFORE it asks the signer, so nothing was signed or sent
    // (a spot order past its proposal lives on the proposal row: it is projected, never judged here)
    const stuck = await sql<OrderRow[]>`select * from orders where origin <> 'legacy' and not (engine = 'spot' and engine_ref is not null) and state in ('CREATED', 'VALIDATED', 'APPROVED', 'SUBMITTING') and updated_at < ${new Date(now - ORPHAN_GRACE_MS)} limit 100`;
    for (const r of stuck) {
      if (r.engine_ref && await this.engineRow(r.engine === 'gmx' ? 'gmx' : 'deriv', r.engine_ref)) { await this.projectRef(r.engine === 'gmx' ? 'gmx' : 'deriv', r.engine_ref); continue; }
      await applyEvent(r.id, { type: 'local_failed', reason: 'INTERNAL_ERROR', detail: 'interrupted before the engine stored the order; nothing was signed or sent' }, now, { rejectCode: 'interrupted' }).catch((e: unknown) => console.error(`[orders] orphan ${r.id}: ${msg(e)}`));
      out.orphans += 1;
    }
    const late = await sql<OrderRow[]>`select * from orders where origin <> 'legacy' and state = 'AWAITING_APPROVAL' and engine_ref is null and (canonical->>'expiresAt')::bigint < ${now} limit 100`;
    for (const r of late) { await applyEvent(r.id, { type: 'approval_expired' }, now).catch(() => {}); out.expired += 1; }
    return out;
  }
  /** projects again an order whose engine row has not changed (the clock has) */
  private async reproject(r: OrderRow): Promise<OrderRow | null> {
    await patchOrder(r.id, this.now(), { engineSig: null });
    return this.projectRef(r.engine === 'gmx' ? 'gmx' : 'deriv', r.engine_ref!);
  }
}
