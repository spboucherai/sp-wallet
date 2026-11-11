// sp-execution-engine: controlled LIVE trading on a venue account (Hyperliquid perpetuals). Ships disabled: a venue account is
// READ_ONLY until the owner approves a venue authorization with his passkey, which only the isolated signer judges.
//
// Order: validate → live ticker/book + the account's real state from the venue → risk engine → proposal persisted
// (`proposed` → `risk_checked`) → WebAuthn options whose challenge is the order hash → on approval `authorized` → signer
// (`signed`) → venue (`submitted`) → reconciliation against the venue's own order status and fills →
// `open | partially_filled | filled | cancelled | rejected`. A timeout or an unreadable answer is `unknown`: it is resolved only
// by asking the venue for the client order id, never by assumption.
//
// What this file can NOT do: it holds no key. It cannot make the signer sign anything but an order, a cancel or a leverage
// change that the signer has read itself, inside the limits of the authorization the owner approved.
import { randomUUID } from 'node:crypto';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { z } from 'zod';
import { toB64u } from '@spw/core';
import {
  checkOrder, D, hlFormatPrice, initialMargin, RiskPolicySchema, VenueError,
  type AccountState, type Book, type DecStr, type Fill, type Instrument, type Order, type OrderRequest, type Position, type RiskPolicy, type RiskResult, type RiskUsage, type Ticker,
} from '@spw/derivatives';
import {
  hex, hlCloid, hlPinnedAsset, HL_PINNED_AT, HL_PINNED_ASSETS, jurisdictionAck, validateVenueAuthorization, venueAgentWireName, venueAuthorizationHash, venueLeverageHash, venueOrderHash, venueOrderNotional,
  VenuePolicySchema, VENUE_AUTH_MAX_DAYS, VENUE_POLICY_BOUNDS,
  type HlNetwork, type JurisdictionAck, type SignRequest, type VenueAuthorization, type VenueLeverage, type VenueOrder, type VenuePolicy,
} from '@spw/derivatives/live';
import { UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import { LIVE_ACTION_TTL_MS, type LiveVenue, type LiveVenues } from './live-venue.ts';
import { CloseBodySchema, DEFAULT_SLIPPAGE_BPS, OrderBodySchema, worstPrice, type OrderBody } from './paper.ts';

export const LIVE_STEP_MS = 10_000;
/** funding payments are read this often (they happen once an hour) */
const FUNDING_EVERY_MS = 300_000;
/** after the venue expiry of a signed action, how long before "the venue has no such order" is taken as final */
export const NEVER_PLACED_GRACE_MS = 5_000;
/** an order left `authorized` this long means the process died while asking the signer: nothing was sent */
const AUTHORIZED_STUCK_MS = 60_000;
const TAKER_FEE_RATE = '0.00045';
const PRE_SUBMIT = ['proposed', 'risk_checked'], IN_FLIGHT = ['authorized', 'signed'], AT_VENUE = ['submitted', 'unknown', 'open', 'partially_filled', 'filled'];
export type LiveState = 'proposed' | 'risk_checked' | 'authorized' | 'signed' | 'submitted' | 'unknown' | 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected';

export interface LiveSignerPort {
  status(fresh?: boolean): Promise<{ keyId: string; halted: boolean; addresses: Record<string, string> }>;
  venueKey(venue: string, network: string): Promise<{ venue: string; network: string; address: string; path: string; account: string }>;
  venueAuthorize(authorization: unknown, assertion: unknown): Promise<{ authorizationId: string; hash: string; agentAddress: string; approve: { action: unknown; signature: { r: string; s: string; v: number }; nonce: number } }>;
  venueSign(p: { authorizationId: string; sign: unknown; context?: unknown; assertion?: unknown }): Promise<{ signature: { r: string; s: string; v: number }; signer: string; kind: string; hash: string }>;
  venueRevoke(authorizationId: string): Promise<{ revoked: true; revokedAt: string }>;
}
export interface LiveDeps {
  venues: LiveVenues; signer: LiveSignerPort; now: () => number; rpId: string;
  /** server setting SPW_DERIV_LIVE_MAINNET=on (default off) */
  mainnetEnabled: () => boolean;
  /** enrolled passkeys, for the WebAuthn request options */
  credentials: () => Promise<{ id: string; transports: unknown }[]>;
  /** pause between two reads of the venue when waiting for it to show an approval (tests: 0) */
  confirmDelayMs?: number;
}

interface Meta { baseline: Record<string, DecStr>; baselineTs: number; fillsCursor: number; fundingCursor: number; fundingReadAt: number; lastEquityMinute: number; pendingDivergence: string | null }
interface Pending { authorization: VenueAuthorization; ack: Pick<JurisdictionAck, 'locale' | 'sha256' | 'version'>; preparedAt: number }
interface AccountRow {
  id: string; venue: 'hyperliquid'; network: HlNetwork; account: string; agent_address: string; agent_name: string; label: string; mode: 'READ_ONLY' | 'MANUAL_LIVE';
  policy: RiskPolicy; pending: Pending | null; authorization_id: string | null; authorization_hash: string | null; venue_authorization: VenueAuthorization | null;
  halt: string | null; divergence: string | null; meta: Partial<Meta>; last_nonce: string; authorized_at: Date | null; revoked_at: Date | null; created_at: Date; updated_at: Date;
}
type Row = Record<string, any>;

export const AuthorizationBodySchema = z.strictObject({
  policy: VenuePolicySchema, days: z.number().int().min(1).max(VENUE_AUTH_MAX_DAYS), locale: z.enum(['fr', 'en']),
  agentName: z.string().regex(/^[A-Za-z0-9_-]{1,16}$/).default('spw-live'),
});
export const ApproveAuthorizationSchema = z.strictObject({ assertion: z.record(z.string(), z.unknown()), acknowledged: z.literal(true) });
export const AssertionBodySchema = z.strictObject({ assertion: z.record(z.string(), z.unknown()) });
export const CreateLiveAccountSchema = z.strictObject({ venue: z.literal('hyperliquid'), network: z.enum(['mainnet', 'testnet']), label: z.string().trim().min(1).max(60).default('Hyperliquid') });
export const LeverageBodySchema = z.strictObject({ instrument: z.string().min(3).max(120), leverage: z.number().int().min(1).max(VENUE_POLICY_BOUNDS.maxLeverage), marginMode: z.enum(['cross', 'isolated']).default('cross') });
export const HaltBodySchema = z.strictObject({ reason: z.string().trim().max(200).default('') });
export const RevokeBodySchema = z.strictObject({ cancelOpenOrders: z.boolean().default(false) });

const canon = (x: string): DecStr => D.str(D.from(x));
const canonN = (x: string | null): DecStr | null => (x === null ? null : canon(x));
const dayStart = (now: number): number => Math.floor(now / 86_400_000) * 86_400_000;
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const MAINNET_OFF = 'live trading on Hyperliquid MAINNET is disabled on this server (SPW_DERIV_LIVE_MAINNET is not "on"): nothing was built, signed or sent. The testnet account works.';

/** API-side risk policy derived from the authorization the owner approved; every field can be tightened later, none widened past it */
export function liveRiskPolicy(vp: VenuePolicy, network: HlNetwork): RiskPolicy {
  const gross = D.from(vp.maxGrossExposure), times = (k: string): DecStr => D.str(D.mul(gross, D.from(k)));
  return {
    mode: 'MANUAL_LIVE', allowedInstruments: [...vp.allowedInstruments], halt: null, maxDataAgeMs: 5_000,
    maxDeviationBps: String(Math.min(vp.maxPriceDeviationBps, 300)),
    // testnet books are thin and its mark wanders far from the oracle (2 % seen on 2026-11-11): a mainnet bound would refuse everything there
    maxMarkIndexBps: network === 'testnet' ? '1000' : '100',
    maxLeverage: String(vp.maxLeverage), maxOrderNotional: canon(vp.maxOrderNotional), maxGrossExposure: canon(vp.maxGrossExposure), maxPositionNotional: canon(vp.maxPositionNotional),
    minFreeCollateral: '0', minLiquidationDistanceBps: '1000', maxDailyLoss: times('0.05'), maxTotalLoss: times('0.2'), maxOrdersPerMinute: 6, maxOrdersPerDay: vp.maxOrdersPerDay,
  };
}
const READ_ONLY_POLICY: RiskPolicy = { mode: 'READ_ONLY', allowedInstruments: [], halt: null, maxDataAgeMs: 5_000, maxDeviationBps: '0', maxMarkIndexBps: '0', maxLeverage: '1', maxOrderNotional: '0',
  maxGrossExposure: '0', maxPositionNotional: '0', minFreeCollateral: '0', minLiquidationDistanceBps: '0', maxDailyLoss: '0', maxTotalLoss: '0', maxOrdersPerMinute: 0, maxOrdersPerDay: 0 };

export type LiveEvent = { event: 'account' | 'order' | 'action' | 'risk' | 'status'; data: unknown };
export interface StepSummary { accounts: number; reconciled: number; fills: number; funding: number; divergences: number; errors: string[] }

export class LiveService {
  readonly deps: LiveDeps;
  readonly now: () => number;
  private readonly listeners = new Map<string, Set<(ev: LiveEvent) => void>>();
  constructor(deps: LiveDeps) { this.deps = deps; this.now = deps.now; }

  // ------------------------------------------------------------------ stream (same shape as the market hub: event + data)

  subscribe(id: string, fn: (ev: LiveEvent) => void): () => void {
    let set = this.listeners.get(id);
    if (!set) { set = new Set(); this.listeners.set(id, set); }
    set.add(fn);
    return () => { set!.delete(fn); if (set!.size === 0) this.listeners.delete(id); };
  }
  private emit(id: string, ev: LiveEvent): void { for (const l of [...(this.listeners.get(id) ?? [])]) { try { l(ev); } catch { /* a listener must not break the others */ } } }

  // ------------------------------------------------------------------ storage helpers

  private async account(id: string): Promise<AccountRow> {
    const [row] = await sql<AccountRow[]>`select * from deriv_accounts where id = ${id}`;
    if (!row) throw new UserError('unknown_account', 'unknown venue account', 404);
    return row;
  }
  private meta(a: AccountRow): Meta {
    return { baseline: { ...(a.meta.baseline ?? {}) }, baselineTs: a.meta.baselineTs ?? 0, fillsCursor: a.meta.fillsCursor ?? 0, fundingCursor: a.meta.fundingCursor ?? 0, fundingReadAt: a.meta.fundingReadAt ?? 0,
      lastEquityMinute: a.meta.lastEquityMinute ?? 0, pendingDivergence: a.meta.pendingDivergence ?? null };
  }
  private async riskEvent(id: string, kind: string, code: string | null, message: string, data: Record<string, unknown> = {}, dedupe: string | null = null): Promise<void> {
    const ts = this.now();
    const ins = await sql`insert into deriv_risk_events (account_id, ts, kind, code, message, data, dedupe) values (${id}, ${new Date(ts)}, ${kind}, ${code}, ${message.slice(0, 500)}, ${sql.json(data as never)}, ${dedupe})
      on conflict (account_id, dedupe) do nothing returning id`;
    if (ins.length) this.emit(id, { event: 'risk', data: { ts, kind, code, message, data } });
  }
  private audit(type: string, data: Record<string, unknown>, actor = 'owner'): Promise<void> {
    return audit(type, actor, data).catch((e: Error) => console.error(`[derivatives] audit ${type} failed: ${e.message}`));
  }
  private async nextNonce(id: string): Promise<number> {
    const [r] = await sql<{ last_nonce: string }[]>`update deriv_accounts set last_nonce = greatest(last_nonce + 1, ${this.now()}::bigint) where id = ${id} returning last_nonce`;
    return Number(r!.last_nonce);
  }
  private async options(hash: Uint8Array) {
    const creds = await this.deps.credentials();
    const options = await generateAuthenticationOptions({ rpID: this.deps.rpId, userVerification: 'required', challenge: new Uint8Array(hash), timeout: 120_000,
      allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as never })) });
    if (options.challenge !== toB64u(hash)) throw new Error('challenge binding mismatch');
    return options;
  }

  /** why this account cannot send anything to the venue right now; null = it can */
  private blocked(a: AccountRow, what: 'trade' | 'stop'): UserError | null {
    if (a.network === 'mainnet' && !this.deps.mainnetEnabled()) return new UserError('mainnet_disabled', MAINNET_OFF, 403);
    if (!a.authorization_id || !a.venue_authorization) return new UserError('mode_read_only', 'this venue account is read-only: live trading has not been authorized with the owner\'s passkey', 422);
    if (a.mode !== 'MANUAL_LIVE') return new UserError('mode_read_only', 'the authorization of this venue account was revoked: it is read-only', 422);
    if (what === 'trade' && this.now() >= a.venue_authorization.expiresAt * 1000) return new UserError('authorization_expired', 'the venue authorization has expired: approve a new one', 422);
    return null;
  }
  private effectiveHalt(a: AccountRow): string | null {
    return a.halt ?? (a.divergence ? `the venue's state and the wallet's records differ (${a.divergence}): new orders are stopped until it clears` : null);
  }

  // ------------------------------------------------------------------ views

  private orderView(r: Row) {
    return {
      clientId: r.client_id as string, cloid: r.cloid as string | null, instrument: r.instrument as string, side: r.side as 'buy' | 'sell', type: r.type as string, size: canon(r.size), price: canonN(r.price),
      triggerPrice: canonN(r.trigger_price), reduceOnly: r.reduce_only as boolean, tif: r.tif as string, state: r.state as LiveState, final: r.final as boolean, venueOrderId: r.venue_order_id as string | null,
      filled: canon(r.filled), avgFillPrice: canonN(r.avg_fill_price), reason: r.reject_reason as string | null, origin: r.origin as string, hash: r.order_hash as string | null,
      nonce: r.nonce === null ? null : Number(r.nonce), expiresAt: r.expires_at ? (r.expires_at as Date).getTime() : null, canonical: r.request as VenueOrder | null,
      createdAt: (r.created_at as Date).getTime(), updatedAt: (r.updated_at as Date).getTime(), submittedAt: r.submitted_at ? (r.submitted_at as Date).getTime() : null,
      /** where the state comes from: the venue's own records, or the wallet alone (nothing reached the venue, or not yet confirmed) */
      source: (['open', 'partially_filled', 'filled'].includes(r.state) || (r.state === 'cancelled' && r.venue_order_id) ? 'venue' : 'local') as 'venue' | 'local',
    };
  }
  private actionView(r: Row) {
    return { id: r.id as string, kind: r.kind as string, state: r.state as string, request: r.request as Record<string, unknown>, hash: r.action_hash as string | null, nonce: Number(r.nonce),
      expiresAt: (r.expires_at as Date).getTime(), error: r.error as string | null, createdAt: (r.created_at as Date).getTime(), updatedAt: (r.updated_at as Date).getTime() };
  }
  private summary(a: AccountRow) {
    const auth = a.venue_authorization, now = this.now();
    return {
      id: a.id, venue: a.venue, network: a.network, kind: 'venue' as const, mode: a.mode, label: a.label, account: a.account, agentAddress: a.agent_address,
      policy: a.policy, halt: a.halt, divergence: a.divergence, halted: this.effectiveHalt(a),
      mainnetEnabled: this.deps.mainnetEnabled(), tradable: this.blocked(a, 'trade') === null,
      authorization: auth && a.authorization_id ? { id: a.authorization_id, hash: a.authorization_hash, mode: auth.mode, agentName: auth.agentName, policy: auth.policy, createdAt: auth.createdAt * 1000, expiresAt: auth.expiresAt * 1000,
        ackSha256: auth.ackSha256, active: a.mode === 'MANUAL_LIVE' && now < auth.expiresAt * 1000, expired: now >= auth.expiresAt * 1000, revokedAt: a.revoked_at?.getTime() ?? null, authorizedAt: a.authorized_at?.getTime() ?? null } : null,
      pendingAuthorization: a.pending ? { authorizationId: a.pending.authorization.authorizationId, preparedAt: a.pending.preparedAt } : null,
      createdAt: a.created_at.getTime(), updatedAt: a.updated_at.getTime(),
    };
  }
  /** the account as the venue reports it right now; an unreadable venue is said, never papered over */
  private async venueState(a: AccountRow): Promise<{ state: AccountState | null; positions: Position[]; openOrders: Order[]; error: string | null; ts: number; source: 'venue' }> {
    const v = this.deps.venues.get(a.network).adapter;
    try {
      const [state, positions, openOrders] = await Promise.all([v.account(a.account), v.positions(a.account), v.openOrders(a.account)]);
      return { state, positions, openOrders, error: null, ts: this.now(), source: 'venue' };
    } catch (e) { return { state: null, positions: [], openOrders: [], error: msg(e), ts: this.now(), source: 'venue' }; }
  }

  config() {
    return {
      mainnetEnabled: this.deps.mainnetEnabled(), venues: [{ venue: 'hyperliquid' as const, networks: ['testnet', 'mainnet'] as const }], modes: ['READ_ONLY', 'MANUAL_LIVE'] as const,
      mandateLive: { available: false, reason: 'MANDATE_LIVE (agents trading derivatives) is not part of this delivery; the signer refuses it' },
      pinnedAssets: { pinnedAt: HL_PINNED_AT, mainnet: HL_PINNED_ASSETS.mainnet.map((x) => ({ instrument: `hyperliquid:${x.symbol}`, maxLeverage: x.maxLeverage })), testnet: HL_PINNED_ASSETS.testnet.map((x) => ({ instrument: `hyperliquid:${x.symbol}`, maxLeverage: x.maxLeverage })) },
      bounds: { ...VENUE_POLICY_BOUNDS, maxAuthorizationDays: VENUE_AUTH_MAX_DAYS, orderApprovalTtlMs: LIVE_ACTION_TTL_MS }, ts: this.now(),
    };
  }

  async list() { return (await sql<AccountRow[]>`select * from deriv_accounts order by created_at`).map((a) => this.summary(a)); }

  async get(id: string) {
    const a = await this.account(id);
    const [venue, orders, actions, fills, funding, events, equity] = await Promise.all([
      this.venueState(a),
      sql`select * from deriv_orders where account_id = ${id} order by created_at desc limit 100`,
      sql`select * from deriv_actions where account_id = ${id} order by created_at desc limit 50`,
      sql`select * from deriv_fills where account_id = ${id} order by ts desc, fill_id desc limit 100`,
      sql`select * from deriv_funding where account_id = ${id} order by ts desc limit 100`,
      sql`select * from deriv_risk_events where account_id = ${id} order by ts desc, id desc limit 100`,
      sql`select * from (select * from deriv_equity where account_id = ${id} order by ts desc limit 1500) e order by ts`,
    ]);
    return {
      ...this.summary(a), venueState: venue,
      orders: orders.map((r) => this.orderView(r)), actions: actions.map((r) => this.actionView(r)),
      fills: fills.map((f): Fill & { source: 'venue' } => ({ instrument: f.instrument, orderId: f.order_id, clientId: f.client_id, side: f.side, price: canon(f.price), size: canon(f.size), fee: canon(f.fee), feeAsset: f.fee_asset,
        closedPnl: canonN(f.closed_pnl), ts: f.ts.getTime(), id: f.fill_id, liquidation: f.liquidation, source: 'venue' })),
      funding: funding.map((f) => ({ instrument: f.instrument as string, amount: canon(f.amount), rate: canon(f.rate), size: canon(f.size), ts: f.ts.getTime() as number, source: 'venue' as const })),
      riskEvents: events.map((e) => ({ id: Number(e.id), ts: e.ts.getTime() as number, kind: e.kind as string, code: e.code as string | null, message: e.message as string, data: e.data as Record<string, unknown> })),
      equity: equity.map((e) => ({ ts: e.ts.getTime() as number, equity: canon(e.equity), collateral: canon(e.collateral), marginUsed: canon(e.margin_used), unrealizedPnl: canon(e.unrealized_pnl), source: 'venue' as const })),
      ts: this.now(),
    };
  }

  /** read-only: what can be withdrawn / what backs the positions, and where the funding instructions are. Nothing is moved from here. */
  async collateral(id: string) {
    const a = await this.account(id), v = await this.venueState(a);
    return {
      account: a.account, network: a.network, equity: v.state?.equity ?? null, collateral: v.state?.collateral ?? null, freeCollateral: v.state?.freeCollateral ?? null, marginUsed: v.state?.marginUsed ?? null,
      withdrawable: v.state?.withdrawable ?? null, asset: 'USDC', error: v.error, ts: v.ts, source: 'venue' as const,
      deposits: { supported: false, how: 'docs/v4/venues/hyperliquid.md, section 14: native USDC on Arbitrum sent by the account itself to the venue bridge (minimum 5 USDC), done by the owner outside this engine' },
      withdrawals: { supported: false, how: 'not built: needs the user-signed withdraw3 action and an allowlisted destination in the signer policy (same section)' },
    };
  }

  // ------------------------------------------------------------------ venue key, account, authorization

  async venueKey(venue: string, network: string) {
    if (venue !== 'hyperliquid') throw new UserError('unknown_venue', 'live trading exists on Hyperliquid only', 404);
    this.deps.venues.get(network);
    return this.deps.signer.venueKey(venue, network);
  }

  /** a venue account is the owner's own address on the venue; it starts READ_ONLY and trades nothing */
  async createAccount(body: z.infer<typeof CreateLiveAccountSchema>) {
    const key = await this.venueKey(body.venue, body.network), id = randomUUID(), now = new Date(this.now());
    const ins = await sql`insert into deriv_accounts (id, venue, network, account, agent_address, label, mode, policy, created_at, updated_at)
      values (${id}, ${body.venue}, ${body.network}, ${key.account.toLowerCase()}, ${key.address.toLowerCase()}, ${body.label}, 'READ_ONLY', ${sql.json(READ_ONLY_POLICY as never)}, ${now}, ${now})
      on conflict (venue, network, account) do nothing returning id`;
    const [row] = await sql<AccountRow[]>`select * from deriv_accounts where venue = ${body.venue} and network = ${body.network} and account = ${key.account.toLowerCase()}`;
    if (ins.length) await this.audit('deriv.live.account_created', { account: row!.id, venue: body.venue, network: body.network, address: row!.account, agentAddress: row!.agent_address });
    return this.get(row!.id);
  }

  /** step 1 of enabling live trading: the canonical authorization, the acknowledgement text to DISPLAY, and the WebAuthn request */
  async prepareAuthorization(id: string, body: z.infer<typeof AuthorizationBodySchema>) {
    const a = await this.account(id);
    if (a.network === 'mainnet' && !this.deps.mainnetEnabled()) throw new UserError('mainnet_disabled', MAINNET_OFF, 403);
    if (a.mode !== 'READ_ONLY') throw new UserError('bad_state', 'an authorization is already active on this venue account: revoke it to change its limits', 409);
    const st = await this.deps.signer.status(true);
    if (st.halted) throw new UserError('halted', 'emergency halt is active', 423);
    const key = await this.deps.signer.venueKey(a.venue, a.network);
    if (key.address.toLowerCase() !== a.agent_address || key.account.toLowerCase() !== a.account) throw new UserError('wrong_key', 'this venue account belongs to another signer key', 409);
    const venue = this.deps.venues.get(a.network);
    await venue.assertPinned();
    for (const inst of body.policy.allowedInstruments) if (!hlPinnedAsset(a.network, inst)) throw new UserError('bad_policy', `${inst} is not in the pinned ${a.network} asset table: it cannot be allowed`, 400);
    const nowMs = this.now(), nowS = Math.floor(nowMs / 1000), ack = jurisdictionAck('hyperliquid', body.locale);
    const authorization: VenueAuthorization = { v: 1, authorizationId: randomUUID(), keyId: st.keyId, venue: 'hyperliquid', network: a.network, account: a.account, agentAddress: a.agent_address, agentName: body.agentName,
      mode: 'MANUAL_LIVE', policy: body.policy, createdAt: nowS, expiresAt: nowS + body.days * 86400, approveNonce: nowMs, ackSha256: ack.sha256 };
    try { validateVenueAuthorization(authorization, nowS); } catch (e) { throw new UserError('bad_policy', msg(e), 400); }
    const hash = venueAuthorizationHash(authorization);
    const pending: Pending = { authorization, ack: { locale: ack.locale, sha256: ack.sha256, version: ack.version }, preparedAt: nowMs };
    await sql`update deriv_accounts set pending = ${sql.json(pending as never)}, updated_at = ${new Date(nowMs)} where id = ${id}`;
    const v = await this.venueState(a);
    return {
      authorization, hash: hex(hash), acknowledgement: ack,
      agent: { address: a.agent_address, name: body.agentName, wireName: venueAgentWireName(authorization), validUntil: authorization.expiresAt * 1000,
        can: ['place orders', 'cancel orders', 'change leverage'], cannot: ['withdraw', 'transfer to another address'],
        note: 'On the venue an API wallet could also move collateral between the account\'s own balances; the signer refuses to sign anything but orders, cancels and leverage changes.' },
      whatIsSigned: { byMainKey: 'one approveAgent action naming the trading key above (the only venue message the wallet key signs)', byPasskey: 'the SHA-256 of this authorization, which includes the hash of the acknowledgement text' },
      venueState: v, options: await this.options(hash), ts: nowMs,
    };
  }

  /** step 2: the signer judges the passkey, stores the limits and signs the venue approval; the venue must then show the API wallet */
  async approveAuthorization(id: string, body: z.infer<typeof ApproveAuthorizationSchema>) {
    const a = await this.account(id);
    if (a.network === 'mainnet' && !this.deps.mainnetEnabled()) throw new UserError('mainnet_disabled', MAINNET_OFF, 403);
    if (a.mode !== 'READ_ONLY') throw new UserError('bad_state', 'an authorization is already active on this venue account', 409);
    const p = a.pending;
    if (!p) throw new UserError('bad_state', 'prepare the authorization first', 409);
    const auth = p.authorization, venue = this.deps.venues.get(a.network);
    await sql`update deriv_accounts set pending = null where id = ${id}`;                      // an authorization is approved once
    const r = await this.deps.signer.venueAuthorize(auth, body.assertion);                    // refusal → UserError signer_*, nothing changed
    // The signer verified the owner's passkey over an authorization that contains the hash of the text that was displayed: that
    // is the owner's confirmation. It is recorded now, whatever the venue answers next.
    await this.audit('deriv.live.acknowledged', { account: id, venue: a.venue, network: a.network, authorizationId: auth.authorizationId, authorizationHash: r.hash, ackSha256: p.ack.sha256, locale: p.ack.locale, version: p.ack.version,
      statement: 'the owner confirmed with his passkey having read the jurisdiction summary; enabling live derivative trading on this venue is his own decision' });
    const undo = async (why: string): Promise<never> => {
      await this.deps.signer.venueRevoke(auth.authorizationId).catch(() => {});
      await this.audit('deriv.live.authorization_failed', { account: id, authorizationId: auth.authorizationId, reason: why.slice(0, 300) });
      throw new UserError('venue_rejected', `the venue did not register the trading key: ${why.slice(0, 240)} — the authorization was revoked on the signer, nothing can trade. Fund the venue account first if the venue asks for a deposit, then prepare a new authorization.`, 422);
    };
    let answer: string | null = null;
    try { await venue.trading().submit(r.approve.action, r.approve.signature, r.approve.nonce); }
    catch (e) {
      if (!(e instanceof VenueError) || e.code === 'rejected' || e.code === 'unsupported') await undo(msg(e));
      answer = msg(e);                                                                          // unknown outcome: only the venue's own state decides
    }
    let confirmed = false;
    for (let k = 0; k < 5 && !confirmed; k++) {
      const role = await venue.userRole(a.agent_address).catch(() => null);
      confirmed = role !== null && role.role === 'agent' && role.user === a.account;
      if (!confirmed && k < 4) await new Promise((res) => setTimeout(res, this.deps.confirmDelayMs ?? 500));
    }
    if (!confirmed) await undo(answer ?? 'the venue accepted the request but does not list the trading key as an API wallet of the account');
    const positions = await venue.adapter.positions(a.account).catch(() => [] as Position[]);
    const now = this.now(), meta: Meta = { ...this.meta(a), baseline: Object.fromEntries(positions.map((x) => [x.instrument, x.side === 'long' ? x.size : `-${x.size}`])), baselineTs: now, fillsCursor: now, fundingCursor: now, pendingDivergence: null };
    await sql`update deriv_accounts set mode = 'MANUAL_LIVE', authorization_id = ${auth.authorizationId}, authorization_hash = ${r.hash}, venue_authorization = ${sql.json(auth as never)}, agent_name = ${auth.agentName},
      policy = ${sql.json(liveRiskPolicy(auth.policy, a.network) as never)}, halt = null, divergence = null, meta = ${sql.json(meta as never)}, authorized_at = ${new Date(now)}, revoked_at = null, updated_at = ${new Date(now)} where id = ${id}`;
    await this.audit('deriv.live.authorized', { account: id, venue: a.venue, network: a.network, authorizationId: auth.authorizationId, hash: r.hash, agentAddress: a.agent_address, mode: auth.mode, policy: auth.policy, expiresAt: auth.expiresAt, ackSha256: auth.ackSha256 });
    this.emit(id, { event: 'status', data: { mode: 'MANUAL_LIVE', ts: now } });
    return this.get(id);
  }

  /** stopping never needs a passkey. The signer forgets nothing: a revoked authorization signs nothing, not even a cancel. */
  async revoke(id: string, body: z.infer<typeof RevokeBodySchema>) {
    const a = await this.account(id);
    let cancelled: Awaited<ReturnType<LiveService['cancelAll']>> | null = null;
    if (body.cancelOpenOrders && a.mode === 'MANUAL_LIVE') cancelled = await this.cancelAll(id).catch(() => null);
    if (a.authorization_id) await this.deps.signer.venueRevoke(a.authorization_id);
    const now = new Date(this.now());
    await sql`update deriv_accounts set mode = 'READ_ONLY', policy = ${sql.json({ ...a.policy, mode: 'READ_ONLY' } as never)}, pending = null, revoked_at = ${a.authorization_id ? now : a.revoked_at}, updated_at = ${now} where id = ${id}`;
    await sql`update deriv_orders set state = 'cancelled', status = 'cancelled', final = true, reject_reason = 'withdrawn: the venue authorization was revoked before approval', updated_at = ${now}
      where account_id = ${id} and state = any(${PRE_SUBMIT})`;
    await this.audit('deriv.live.revoked', { account: id, authorizationId: a.authorization_id });
    const v = await this.venueState(a);
    this.emit(id, { event: 'status', data: { mode: 'READ_ONLY', ts: now.getTime() } });
    return { ...(await this.get(id)), cancelled,
      warning: v.openOrders.length ? `${v.openOrders.length} order(s) still rest on the venue. The wallet can no longer cancel them (a revoked authorization signs nothing): cancel them in the venue's own interface, or approve a new authorization and cancel.` : null,
      venueAgent: 'The trading key stays registered at the venue until its expiry, but it exists only in the signer, which now refuses to use it.' };
  }

  /** the API-side risk policy can be tightened freely; it can never exceed what the passkey-approved authorization allows */
  async setPolicy(id: string, policy: RiskPolicy) {
    const a = await this.account(id), auth = a.venue_authorization;
    if (a.mode !== 'MANUAL_LIVE' || !auth) throw new UserError('mode_read_only', 'a read-only venue account has no trading policy: authorize it first', 422);
    const vp = auth.policy, bad = (why: string): never => { throw new UserError('bad_policy', `${why}: a wider limit needs a new authorization, approved with the passkey`, 400); };
    if (policy.mode !== 'MANUAL_LIVE') bad('the mode of a venue account is set by its authorization');
    if (policy.halt !== null) bad('a halt is set with the halt route');
    if (policy.allowedInstruments.some((i) => !vp.allowedInstruments.includes(i))) bad('an instrument outside the authorization');
    if (D.gt(D.from(policy.maxLeverage), D.from(BigInt(vp.maxLeverage)))) bad('leverage above the authorization');
    if (D.gt(D.from(policy.maxOrderNotional), D.from(vp.maxOrderNotional))) bad('order notional above the authorization');
    if (D.gt(D.from(policy.maxPositionNotional), D.from(vp.maxPositionNotional))) bad('position notional above the authorization');
    if (D.gt(D.from(policy.maxGrossExposure), D.from(vp.maxGrossExposure))) bad('gross exposure above the authorization');
    if (policy.maxOrdersPerDay > vp.maxOrdersPerDay) bad('orders per day above the authorization');
    await sql`update deriv_accounts set policy = ${sql.json(policy as never)}, updated_at = ${new Date(this.now())} where id = ${id}`;
    await this.audit('deriv.live.policy_replaced', { account: id, maxLeverage: policy.maxLeverage, maxOrderNotional: policy.maxOrderNotional, maxGrossExposure: policy.maxGrossExposure });
    return this.get(id);
  }

  // ------------------------------------------------------------------ orders: preview, propose, approve, cancel

  private async usage(id: string, now: number): Promise<RiskUsage> {
    const day = new Date(dayStart(now));
    const [f] = await sql<{ today: string; total: string }[]>`select coalesce(sum(coalesce(closed_pnl, 0) - fee) filter (where ts >= ${day}), 0)::text as today, coalesce(sum(coalesce(closed_pnl, 0) - fee), 0)::text as total from deriv_fills where account_id = ${id}`;
    const [g] = await sql<{ today: string; total: string }[]>`select coalesce(sum(amount) filter (where ts >= ${day}), 0)::text as today, coalesce(sum(amount), 0)::text as total from deriv_funding where account_id = ${id}`;
    // proposals the risk engine or the signer refused never reached the venue: they do not use up the order allowance
    const [c] = await sql<{ minute: number; today: number }[]>`select count(*) filter (where created_at > ${new Date(now - 60_000)})::int as minute, count(*) filter (where created_at >= ${day})::int as today
      from deriv_orders where account_id = ${id} and not (final and signature is null)`;
    return { realizedToday: D.str(D.add(D.from(f!.today), D.from(g!.today))), realizedTotal: D.str(D.add(D.from(f!.total), D.from(g!.total))), ordersLastMinute: c!.minute, ordersToday: c!.today, clientIds: [] };
  }

  /** the order as the engines take it + the venue's own price rule (5 significant figures) */
  private request(body: OrderBody, inst: Instrument, book: Book, clientId: string): { req: OrderRequest; refusal: RiskResult | null } {
    if (body.leverage !== undefined) throw new UserError('bad_request', 'on a venue account the leverage of an instrument is a venue setting: change it with the leverage route (passkey)', 400);
    let price = body.price === null ? null : canon(body.price);
    if (price === null && body.type === 'market' && body.slippageBps !== undefined) price = worstPrice(inst, book, body.side, body.slippageBps);
    const req: OrderRequest = { instrument: inst.id, side: body.side, type: body.type, size: canon(body.size), price, triggerPrice: body.triggerPrice === null ? null : canon(body.triggerPrice),
      reduceOnly: body.reduceOnly, tif: body.type === 'market' ? 'ioc' : body.tif, clientId };
    const sz = inst.lotSize.includes('.') ? inst.lotSize.length - inst.lotSize.indexOf('.') - 1 : 0;
    for (const [name, p] of [['price', req.price], ['trigger price', req.triggerPrice]] as const) {
      const r = p === null ? null : hlFormatPrice(p, sz);
      if (r && !r.ok) return { req, refusal: { ok: false, code: 'price_not_on_tick', reason: `${name}: ${r.reason}` } };
    }
    return { req, refusal: null };
  }

  /** live market + the account's REAL state from the venue, then the risk engine with the account's policy */
  private async check(a: AccountRow, venue: LiveVenue, body: OrderBody, clientId: string) {
    const inst = await venue.instrument(body.instrument);
    const read = async <T>(fn: () => Promise<T>): Promise<T> => { try { return await fn(); } catch (e) { if (e instanceof VenueError) throw new UserError('venue_unavailable', msg(e), 503); throw e; } };
    const [m, state, positions, openOrders, lev] = await Promise.all([venue.market(inst), read(() => venue.adapter.account(a.account)), read(() => venue.adapter.positions(a.account)),
      read(() => venue.adapter.openOrders(a.account)), venue.leverageOf(a.account, inst.symbol)]);
    const now = this.now(), { req, refusal } = this.request(body, inst, m.book, clientId);
    const policy: RiskPolicy = { ...RiskPolicySchema.parse(a.policy), halt: this.effectiveHalt(a) };
    let risk: RiskResult = refusal ?? checkOrder(policy, req, { instrument: inst, account: state, positions, openOrders, book: m.book, ticker: m.ticker, now, usage: await this.usage(a.id, now), leverage: lev.leverage });
    // the signer bounds EVERY order by its notional, reduce-only included (it cannot see positions): said here rather than at the passkey prompt
    const cap = a.venue_authorization?.policy.maxOrderNotional;
    if (risk.ok && cap && req.price !== null && D.gt(D.from(venueOrderNotional({ size: req.size, price: req.price, triggerPrice: req.triggerPrice })), D.from(cap))) {
      risk = { ok: false, code: 'order_notional_exceeded', reason: `order notional ${venueOrderNotional({ size: req.size, price: req.price, triggerPrice: req.triggerPrice })} exceeds the ${cap} the signer will sign per order (reduce-only orders included: close in smaller parts)` };
    }
    return { inst, m, state, positions, openOrders, lev, req, risk, now };
  }

  private estimate(c: Awaited<ReturnType<LiveService['check']>>) {
    const { req, m, lev, state } = c, price = req.price === null ? D.from(m.ticker.mark) : D.from(req.price), notional = D.mul(D.from(req.size), price);
    const margin = req.reduceOnly ? D.zero : initialMargin(notional, D.from(lev.leverage));
    return { notional: D.str(notional), initialMargin: D.str(margin), fee: D.str(D.mul(notional, D.from(TAKER_FEE_RATE))), feeNote: 'upper bound at the base taker rate (0.045 %); the real fee comes from the venue\'s fills',
      freeCollateralAfter: D.str(D.sub(D.from(state.freeCollateral), margin)), leverage: lev.leverage, marginMode: lev.marginMode, price: req.price, mark: m.ticker.mark,
      liquidationPrice: null, liquidationNote: 'not estimated before the order: the venue reports the liquidation price of the position once it exists', source: 'estimate' as const };
  }

  async preview(id: string, body: OrderBody) {
    const a = await this.account(id), stop = this.blocked(a, 'trade');
    if (stop) throw stop;
    const venue = this.deps.venues.get(a.network);
    await venue.assertPinned();
    const c = await this.check(a, venue, body, 'preview');
    return { risk: c.risk, estimate: this.estimate(c), request: c.req, venueState: { state: c.state, positions: c.positions, source: 'venue' as const }, ts: c.now };
  }

  /**
   * Proposal. `key` is the Idempotency-Key = the order's client id; the venue's client order id (cloid) is derived from it, so a
   * retry — of this call, of the approval, or of the submission — can never place a second order.
   */
  async propose(id: string, body: OrderBody, key: string, origin: 'owner' | 'close' = 'owner') {
    const a = await this.account(id);
    const [prior] = await sql`select * from deriv_orders where account_id = ${id} and client_id = ${key}`;
    if (prior) return this.proposalAnswer(prior, true);
    const stop = this.blocked(a, 'trade');
    if (stop) throw stop;
    const venue = this.deps.venues.get(a.network);
    await venue.assertPinned();
    const c = await this.check(a, venue, body, key), { req, inst, now } = c, at = new Date(now);
    const ins = await sql`insert into deriv_orders (account_id, client_id, cloid, instrument, side, type, size, price, trigger_price, reduce_only, tif, status, state, origin, created_at, updated_at)
      values (${id}, ${key}, ${hlCloid(key)}, ${req.instrument}, ${req.side}, ${req.type}, ${req.size}, ${req.price}, ${req.triggerPrice}, ${req.reduceOnly}, ${req.tif}, 'pending', 'proposed', ${origin}, ${at}, ${at})
      on conflict (account_id, client_id) do nothing returning client_id`;
    if (!ins.length) { const [again] = await sql`select * from deriv_orders where account_id = ${id} and client_id = ${key}`; return this.proposalAnswer(again!, true); }
    if (!c.risk.ok) {
      await sql`update deriv_orders set state = 'rejected', status = 'rejected', final = true, reject_reason = ${`${c.risk.code}: ${c.risk.reason}`.slice(0, 500)}, updated_at = ${at} where account_id = ${id} and client_id = ${key}`;
      await this.riskEvent(id, 'order_refused', c.risk.code, c.risk.reason, { clientId: key, instrument: req.instrument, side: req.side, type: req.type, size: req.size, price: req.price, reduceOnly: req.reduceOnly, origin });
      throw new UserError(c.risk.code, c.risk.reason, 422);
    }
    const trading = venue.trading(), nonce = await this.nextNonce(id);
    let built: ReturnType<typeof trading.buildOrder>, canonical: VenueOrder;
    try {
      built = trading.buildOrder(req, { instrument: inst, nonce });
      const norm = trading.normalizeRequest(req, inst);
      canonical = { v: 1, authorizationId: a.authorization_id!, venue: 'hyperliquid', network: a.network, account: a.account, kind: 'order', instrument: norm.instrument, side: norm.side, type: norm.type as VenueOrder['type'],
        size: norm.size, price: norm.price!, triggerPrice: norm.triggerPrice, reduceOnly: norm.reduceOnly, tif: norm.tif, clientId: norm.clientId, nonce, expiresAt: nonce + LIVE_ACTION_TTL_MS };
    } catch (e) {
      await sql`update deriv_orders set state = 'rejected', status = 'rejected', final = true, reject_reason = ${msg(e)}, updated_at = ${at} where account_id = ${id} and client_id = ${key}`;
      throw new UserError('venue_rejected', msg(e), 422);
    }
    const hash = venueOrderHash(canonical);
    const [row] = await sql`update deriv_orders set state = 'risk_checked', request = ${sql.json(canonical as never)}, order_hash = ${hex(hash)}, nonce = ${nonce}, expires_at = ${new Date(canonical.expiresAt)},
      action = ${built.action as never}::json, sign_request = ${built.sign as never}::json, updated_at = ${at} where account_id = ${id} and client_id = ${key} returning *`;
    await this.audit(origin === 'close' ? 'deriv.live.close_proposed' : 'deriv.live.order_proposed', { account: id, clientId: key, hash: hex(hash), instrument: canonical.instrument, side: canonical.side, type: canonical.type, size: canonical.size,
      price: canonical.price, triggerPrice: canonical.triggerPrice, reduceOnly: canonical.reduceOnly, tif: canonical.tif, nonce });
    this.emit(id, { event: 'order', data: this.orderView(row!) });
    return this.proposalAnswer(row!, false, this.estimate(c));
  }

  private async proposalAnswer(r: Row, idempotent: boolean, estimate: ReturnType<LiveService['estimate']> | null = null) {
    const order = this.orderView(r), approvable = r.state === 'risk_checked' && r.expires_at.getTime() > this.now();
    return { order, canonical: order.canonical, hash: order.hash, expiresAt: order.expiresAt, estimate, idempotent,
      /** the WebAuthn request whose challenge is the order hash; null when there is nothing (left) to approve */
      options: approvable ? await this.options(Buffer.from(r.order_hash as string, 'hex')) : null };
  }

  private async setOrder(id: string, key: string, patch: { state: LiveState; final?: boolean; reason?: string | null; venueOrderId?: string | null; filled?: DecStr; avg?: DecStr | null; signature?: unknown; answer?: unknown; submitted?: boolean }): Promise<Row> {
    const status = ['open', 'partially_filled', 'filled', 'cancelled', 'rejected'].includes(patch.state) ? patch.state : 'pending', at = new Date(this.now());
    const [row] = await sql`update deriv_orders set state = ${patch.state}, status = ${status}, final = ${patch.final ?? false},
      reject_reason = ${patch.reason === undefined ? sql`reject_reason` : patch.reason}, venue_order_id = ${patch.venueOrderId === undefined ? sql`venue_order_id` : patch.venueOrderId},
      filled = ${patch.filled === undefined ? sql`filled` : patch.filled}, avg_fill_price = ${patch.avg === undefined ? sql`avg_fill_price` : patch.avg},
      signature = ${patch.signature === undefined ? sql`signature` : sql.json(patch.signature as never)}, venue_answer = ${patch.answer === undefined ? sql`venue_answer` : sql.json((patch.answer ?? null) as never)},
      submitted_at = ${patch.submitted ? at : sql`submitted_at`}, updated_at = ${at} where account_id = ${id} and client_id = ${key} returning *`;
    this.emit(id, { event: 'order', data: this.orderView(row!) });
    return row!;
  }

  /** the owner approved the order with his passkey: signer → venue → reconciliation. Only ONE call ever takes the order past `risk_checked`. */
  async approveOrder(id: string, key: string, assertion: Record<string, unknown>) {
    const a = await this.account(id);
    const [row] = await sql`select * from deriv_orders where account_id = ${id} and client_id = ${key} and state is not null`;
    if (!row) throw new UserError('unknown_order', 'unknown order', 404);
    if (row.state !== 'risk_checked') return { order: this.orderView(row), idempotent: true };      // already approved, sent, refused or withdrawn: nothing is sent again
    const stop = this.blocked(a, 'trade');
    if (stop) throw stop;
    const halt = this.effectiveHalt(a);
    if (halt && !row.reduce_only) throw new UserError('halted', `trading is halted: ${halt}`, 423);
    if (row.expires_at.getTime() <= this.now() + 2_000) {
      await this.setOrder(id, key, { state: 'cancelled', final: true, reason: 'the approval window expired before the passkey approval; nothing was signed' });
      throw new UserError('proposal_expired', 'this proposal has expired; propose the order again', 410);
    }
    const venue = this.deps.venues.get(a.network);
    await venue.assertPinned();
    const taken = await sql`update deriv_orders set state = 'authorized', updated_at = ${new Date(this.now())} where account_id = ${id} and client_id = ${key} and state = 'risk_checked' returning client_id`;
    if (!taken.length) { const [cur] = await sql`select * from deriv_orders where account_id = ${id} and client_id = ${key}`; return { order: this.orderView(cur!), idempotent: true }; }

    let signed: Awaited<ReturnType<LiveSignerPort['venueSign']>>;
    try { signed = await this.deps.signer.venueSign({ authorizationId: a.authorization_id!, sign: row.sign_request, context: { order: row.request }, assertion }); }
    catch (e) {
      // refused, or unreachable: either way no signature came back, so nothing can have been sent
      await this.setOrder(id, key, { state: 'rejected', final: true, reason: `not signed: ${msg(e)}` });
      await this.riskEvent(id, 'order_refused', e instanceof UserError ? e.code : 'signer', `the signer did not sign the order: ${msg(e)}`, { clientId: key });
      throw e;
    }
    await this.setOrder(id, key, { state: 'signed', signature: signed.signature });
    await this.submit(a, venue, row, signed.signature);
    const final = await this.reconcileOrder(a, venue, key).catch(() => null);
    const [cur] = await sql`select * from deriv_orders where account_id = ${id} and client_id = ${key}`;
    return { order: this.orderView(final ?? cur!), idempotent: false };
  }

  /** send a signed order. A refusal is final; a timeout or an unreadable answer is `unknown` — never "probably fine", never "probably failed". */
  private async submit(a: AccountRow, venue: LiveVenue, row: Row, signature: unknown): Promise<void> {
    const key = row.client_id as string;
    try {
      const r = await venue.trading().submit(row.action, signature, Number(row.nonce));
      await this.setOrder(a.id, key, { state: 'submitted', venueOrderId: r.venueOrderIds[0] ?? null, answer: r.raw, submitted: true });
      await this.audit('deriv.live.order_submitted', { account: a.id, clientId: key, hash: row.order_hash, venueOrderId: r.venueOrderIds[0] ?? null });
    } catch (e) {
      const ve = e instanceof VenueError ? e : null, detail = (ve?.detail ?? {}) as { raw?: unknown; local?: boolean };
      // not sent at all: the adapter refused before any request (mainnet lock, or its local rate budget)
      const notSent = ve !== null && (ve.code === 'unsupported' || (ve.code === 'rate_limited' && detail.local === true));
      if (ve !== null && (ve.code === 'rejected' || notSent)) {
        await this.setOrder(a.id, key, { state: 'rejected', final: true, reason: `${notSent ? 'not sent' : 'refused by the venue'}: ${msg(e)}`, answer: detail.raw ?? null, submitted: !notSent });
        await this.audit('deriv.live.order_rejected', { account: a.id, clientId: key, hash: row.order_hash, reason: msg(e) });
      } else {
        await this.setOrder(a.id, key, { state: 'unknown', reason: `no usable answer from the venue (${msg(e)}); the order may or may not exist — it is being looked up by its client id`, submitted: true });
        await this.riskEvent(a.id, 'order_unknown', 'unknown', `order ${key}: the venue gave no usable answer; outcome unknown until reconciled`, { clientId: key, error: msg(e) });
      }
    }
  }

  /**
   * One order against the venue's own records: its status by client order id, and the fills that carry that id. The only
   * place where an order becomes open / filled / cancelled, and the only way out of `unknown`.
   */
  private async reconcileOrder(a: AccountRow, venue: LiveVenue, key: string, fills?: Fill[]): Promise<Row | null> {
    const [row] = await sql`select * from deriv_orders where account_id = ${a.id} and client_id = ${key}`;
    if (!row || row.final || !row.state || PRE_SUBMIT.includes(row.state) || row.state === 'authorized') return row ?? null;
    const now = this.now(), cloid = row.cloid as string;
    const seen = await venue.orderStatus(a.account, cloid);
    if (!fills) { fills = await venue.adapter.fills(a.account, { start: (row.created_at as Date).getTime() - 60_000 }); await this.storeFills(a.id, fills); }
    const [stored] = await sql<{ size: string; cost: string }[]>`select coalesce(sum(size), 0)::text as size, coalesce(sum(size * price), 0)::text as cost from deriv_fills where account_id = ${a.id} and client_id = ${cloid}`;
    // two venue sources for the filled size: the order's own remaining size (origSz − sz) and the fills that carry its client id.
    // The fills may be published a moment after the status, so the larger of the two is the filled size and the fills give the price.
    const fromFills = D.from(stored!.size), size = D.from(canon(row.size));
    const avg = D.isPos(fromFills) ? D.str(D.div(D.from(stored!.cost), fromFills, 12, 'half_even')) : null;

    if (seen === null) {
      if (row.state === 'signed' || row.state === 'unknown') {
        // the signature dies at its venue expiry: after that the venue can no longer accept it, so "no such order" is final
        if (now > (row.expires_at as Date).getTime() + NEVER_PLACED_GRACE_MS) {
          const done = await this.setOrder(a.id, key, { state: 'rejected', final: true, reason: 'never placed: the venue has no order with this client id and the signature has expired' });
          await this.audit('deriv.live.order_never_placed', { account: a.id, clientId: key, hash: row.order_hash }, 'reconciler');
          return done;
        }
        return row.state === 'signed' ? this.setOrder(a.id, key, { state: 'unknown', reason: 'interrupted between signing and sending; being looked up on the venue by its client id' }) : row;
      }
      // the venue acknowledged this order and now denies knowing it: that is a divergence, not a state
      await this.riskEvent(a.id, 'divergence', 'order_missing', `order ${key} was acknowledged by the venue but the venue no longer knows its client id`, { clientId: key, cloid }, `order_missing:${key}`);
      return this.setOrder(a.id, key, { state: 'unknown', reason: 'the venue no longer knows this order' });
    }
    const filled = D.max(fromFills, D.from(seen.filled));
    // a finished order stays under watch until its fills add up to the filled size (or a minute has passed): the average price needs them
    const settled = D.gte(fromFills, filled) || now - ((row.submitted_at as Date | null) ?? (row.created_at as Date)).getTime() > 60_000;
    let state: LiveState, final = false, reason: string | null = null;
    if (seen.status === 'open' || seen.status === 'partially_filled' || seen.status === 'triggered' || seen.status === 'pending') state = D.isPos(filled) ? 'partially_filled' : 'open';
    else if (seen.status === 'filled' || seen.status === 'cancelled') {
      const whole = D.gte(filled, size);
      state = whole ? 'filled' : D.isPos(filled) ? 'partially_filled' : 'cancelled';
      final = settled;
      reason = whole ? null : D.isPos(filled) ? `remainder not filled (venue: ${seen.rejectReason ?? (seen.status === 'cancelled' ? 'canceled' : 'filled')})` : seen.rejectReason;
    } else { state = 'rejected'; final = true; reason = `refused by the venue (${seen.rejectReason ?? 'rejected'})`; }
    const filledStr = D.str(filled);
    if (row.state === state && row.final === final && canon(row.filled) === filledStr && (row.venue_order_id ?? null) === seen.venueOrderId && canonN(row.avg_fill_price) === avg) return row;
    const done = await this.setOrder(a.id, key, { state, final, reason, venueOrderId: seen.venueOrderId, filled: filledStr, avg });
    if (final || row.state !== state) await this.audit(`deriv.live.order_${state}`, { account: a.id, clientId: key, hash: row.order_hash, venueOrderId: seen.venueOrderId, filled: filledStr, avgFillPrice: avg, final }, 'reconciler');
    return done;
  }

  private async storeFills(id: string, fills: Fill[]): Promise<number> {
    let n = 0;
    for (const f of fills) {
      const ins = await sql`insert into deriv_fills (account_id, fill_id, instrument, order_id, client_id, side, price, size, fee, fee_asset, closed_pnl, liquidation, ts)
        values (${id}, ${f.id}, ${f.instrument}, ${f.orderId}, ${f.clientId}, ${f.side}, ${f.price}, ${f.size}, ${f.fee}, ${f.feeAsset}, ${f.closedPnl}, ${f.liquidation}, ${new Date(f.ts)})
        on conflict (account_id, fill_id) do nothing returning fill_id`;
      n += ins.length;
    }
    return n;
  }

  /** one signed venue action that is not an order (cancel, leverage): recorded, signed, sent */
  private async act(a: AccountRow, venue: LiveVenue, kind: 'cancel' | 'leverage', request: Record<string, unknown>, built: { action: unknown; sign: SignRequest }, nonce: number, o: { id?: string; context?: unknown; assertion?: unknown; hash?: string } = {}): Promise<{ row: Row; outcome: 'accepted' | 'refused' | 'unknown'; error: string | null }> {
    const id = o.id ?? randomUUID(), at = new Date(this.now());
    if (!o.id) await sql`insert into deriv_actions (id, account_id, kind, state, request, action_hash, nonce, expires_at, action, sign_request, created_at, updated_at)
      values (${id}, ${a.id}, ${kind}, 'authorized', ${sql.json(request as never)}, ${o.hash ?? null}, ${nonce}, ${new Date(nonce + LIVE_ACTION_TTL_MS)}, ${built.action as never}::json, ${built.sign as never}::json, ${at}, ${at})`;
    const set = async (state: string, error: string | null, extra: { signature?: unknown; answer?: unknown } = {}): Promise<Row> => {
      const [r] = await sql`update deriv_actions set state = ${state}, error = ${error}, signature = ${extra.signature === undefined ? sql`signature` : sql.json(extra.signature as never)},
        venue_answer = ${extra.answer === undefined ? sql`venue_answer` : sql.json((extra.answer ?? null) as never)}, updated_at = ${new Date(this.now())} where id = ${id} returning *`;
      this.emit(a.id, { event: 'action', data: this.actionView(r!) });
      return r!;
    };
    let signed: Awaited<ReturnType<LiveSignerPort['venueSign']>>;
    try { signed = await this.deps.signer.venueSign({ authorizationId: a.authorization_id!, sign: built.sign, ...(o.context ? { context: o.context } : {}), ...(o.assertion ? { assertion: o.assertion } : {}) }); }
    catch (e) { await set('rejected', `not signed: ${msg(e)}`); throw e; }
    await set('signed', null, { signature: signed.signature });
    try {
      const r = await venue.trading().submit(built.action, signed.signature, nonce);
      return { row: await set('submitted', null, { answer: r.raw }), outcome: 'accepted', error: null };
    } catch (e) {
      const refused = e instanceof VenueError && (e.code === 'rejected' || e.code === 'unsupported');
      return { row: await set(refused ? 'rejected' : 'unknown', msg(e)), outcome: refused ? 'refused' : 'unknown', error: msg(e) };
    }
  }

  /** withdraw an order. Before approval it is only a local row; after, the venue is asked (no passkey: stopping never needs one). */
  async cancelOrder(id: string, key: string) {
    const a = await this.account(id);
    const [row] = await sql`select * from deriv_orders where account_id = ${id} and client_id = ${key} and state is not null`;
    if (!row) throw new UserError('unknown_order', 'unknown order', 404);
    if (row.final) return { order: this.orderView(row), sent: false };
    if (PRE_SUBMIT.includes(row.state)) {
      const taken = await sql`update deriv_orders set state = 'cancelled', status = 'cancelled', final = true, reject_reason = 'withdrawn before approval; nothing was signed', updated_at = ${new Date(this.now())}
        where account_id = ${id} and client_id = ${key} and state = any(${PRE_SUBMIT}) returning *`;
      if (taken.length) { await this.audit('deriv.live.order_withdrawn', { account: id, clientId: key }); this.emit(id, { event: 'order', data: this.orderView(taken[0]!) }); return { order: this.orderView(taken[0]!), sent: false }; }
    }
    if (IN_FLIGHT.includes(row.state)) throw new UserError('bad_state', 'the order is being signed or sent right now; ask again in a moment', 409);
    const stop = this.blocked(a, 'stop');
    if (stop) throw stop;
    const venue = this.deps.venues.get(a.network), inst = await venue.instrument(row.instrument), nonce = await this.nextNonce(id);
    const built = venue.trading().buildCancel({ instrument: inst, clientId: row.cloid, nonce });
    const r = await this.act(a, venue, 'cancel', { clientId: key, cloid: row.cloid, instrument: row.instrument }, built, nonce);
    await this.audit('deriv.live.cancel_sent', { account: id, clientId: key, outcome: r.outcome, error: r.error });
    const after = await this.reconcileOrder(a, venue, key).catch(() => null);
    const [cur] = await sql`select * from deriv_orders where account_id = ${id} and client_id = ${key}`;
    return { order: this.orderView(after ?? cur!), sent: true, venue: { outcome: r.outcome, error: r.error } };
  }

  // ------------------------------------------------------------------ leverage (passkey)

  async proposeLeverage(id: string, body: z.infer<typeof LeverageBodySchema>) {
    const a = await this.account(id), stop = this.blocked(a, 'trade');
    if (stop) throw stop;
    const halt = this.effectiveHalt(a);
    if (halt) throw new UserError('halted', `trading is halted: ${halt}`, 423);
    const venue = this.deps.venues.get(a.network);
    await venue.assertPinned();
    const inst = await venue.instrument(body.instrument), vp = a.venue_authorization!.policy;
    if (!vp.allowedInstruments.includes(inst.id)) throw new UserError('instrument_not_allowed', `${inst.id} is not allowed by the authorization`, 422);
    if (body.leverage > vp.maxLeverage || D.gt(D.from(BigInt(body.leverage)), D.from(a.policy.maxLeverage))) throw new UserError('leverage_exceeded', `leverage ${body.leverage} is above the authorized maximum (${Math.min(vp.maxLeverage, Number(a.policy.maxLeverage))})`, 422);
    if (!inst.marginModes.includes(body.marginMode)) throw new UserError('venue_rejected', `${inst.id} does not offer ${body.marginMode} margin`, 422);
    const nonce = await this.nextNonce(id);
    let built: { action: unknown; sign: SignRequest };
    try { built = venue.trading().buildUpdateLeverage({ instrument: inst, leverage: body.leverage, marginMode: body.marginMode, nonce }); } catch (e) { throw new UserError('venue_rejected', msg(e), 422); }
    const canonical: VenueLeverage = { v: 1, authorizationId: a.authorization_id!, venue: 'hyperliquid', network: a.network, account: a.account, kind: 'leverage', instrument: inst.id, leverage: body.leverage, marginMode: body.marginMode,
      nonce, expiresAt: nonce + LIVE_ACTION_TTL_MS };
    const hash = venueLeverageHash(canonical), actionId = randomUUID(), at = new Date(this.now());
    const [row] = await sql`insert into deriv_actions (id, account_id, kind, state, request, action_hash, nonce, expires_at, action, sign_request, created_at, updated_at)
      values (${actionId}, ${id}, 'leverage', 'risk_checked', ${sql.json(canonical as never)}, ${hex(hash)}, ${nonce}, ${new Date(canonical.expiresAt)}, ${built.action as never}::json, ${built.sign as never}::json, ${at}, ${at}) returning *`;
    const current = await venue.leverageOf(a.account, inst.symbol).catch(() => null);
    await this.audit('deriv.live.leverage_proposed', { account: id, action: actionId, hash: hex(hash), instrument: inst.id, leverage: body.leverage, marginMode: body.marginMode });
    return { action: this.actionView(row!), canonical, hash: hex(hash), current, expiresAt: canonical.expiresAt, options: await this.options(hash) };
  }

  async approveLeverage(id: string, actionId: string, assertion: Record<string, unknown>) {
    const a = await this.account(id);
    const [row] = await sql`select * from deriv_actions where id = ${actionId} and account_id = ${id} and kind = 'leverage'`;
    if (!row) throw new UserError('unknown_action', 'unknown leverage change', 404);
    if (row.state !== 'risk_checked') return { action: this.actionView(row), idempotent: true, venue: null };
    const stop = this.blocked(a, 'trade');
    if (stop) throw stop;
    if (this.effectiveHalt(a)) throw new UserError('halted', `trading is halted: ${this.effectiveHalt(a)}`, 423);
    if (row.expires_at.getTime() <= this.now() + 2_000) { await sql`update deriv_actions set state = 'cancelled', error = 'expired before approval', updated_at = ${new Date(this.now())} where id = ${actionId}`; throw new UserError('proposal_expired', 'this proposal has expired; propose it again', 410); }
    const taken = await sql`update deriv_actions set state = 'authorized', updated_at = ${new Date(this.now())} where id = ${actionId} and state = 'risk_checked' returning id`;
    if (!taken.length) { const [cur] = await sql`select * from deriv_actions where id = ${actionId}`; return { action: this.actionView(cur!), idempotent: true, venue: null }; }
    const venue = this.deps.venues.get(a.network), c = row.request as VenueLeverage;
    const r = await this.act(a, venue, 'leverage', c, { action: row.action, sign: row.sign_request }, Number(row.nonce), { id: actionId, context: { leverage: c }, assertion });
    // the venue's own setting decides, whatever the HTTP answer was
    const now = await venue.leverageOf(a.account, c.instrument.slice(c.instrument.indexOf(':') + 1)).catch(() => null);
    const confirmed = now !== null && now.leverage === String(c.leverage) && now.marginMode === c.marginMode;
    const state = confirmed ? 'confirmed' : r.outcome === 'refused' ? 'rejected' : 'unknown';
    const [cur] = await sql`update deriv_actions set state = ${state}, updated_at = ${new Date(this.now())} where id = ${actionId} returning *`;
    await this.audit('deriv.live.leverage', { account: id, action: actionId, instrument: c.instrument, leverage: c.leverage, marginMode: c.marginMode, state, error: r.error });
    this.emit(id, { event: 'action', data: this.actionView(cur!) });
    return { action: this.actionView(cur!), idempotent: false, venue: { leverage: now, confirmed, source: 'venue' as const } };
  }

  // ------------------------------------------------------------------ kill switch: halt, cancel-all, close — three separate actions

  /** stops NEW orders on this account (reduce-only orders that reduce still pass). No passkey. It cancels nothing and closes nothing. */
  async halt(id: string, body: z.infer<typeof HaltBodySchema>) {
    const a = await this.account(id), now = this.now();
    const text = `halted by the owner${body.reason ? `: ${body.reason}` : ''} (${new Date(now).toISOString()})`;
    await sql`update deriv_accounts set halt = ${text}, updated_at = ${new Date(now)} where id = ${id}`;
    const withdrawn = await sql`update deriv_orders set state = 'cancelled', status = 'cancelled', final = true, reject_reason = 'withdrawn: trading was halted before approval', updated_at = ${new Date(now)}
      where account_id = ${id} and state = any(${PRE_SUBMIT}) and not reduce_only returning client_id`;
    await this.riskEvent(id, 'halt', 'halted', text, { withdrawnProposals: withdrawn.length });
    await this.audit('deriv.live.halt', { account: id, reason: body.reason, withdrawnProposals: withdrawn.length });
    this.emit(id, { event: 'status', data: { halt: text, ts: now } });
    void a;
    return { ...(await this.get(id)), note: 'New orders are stopped. Resting orders are still on the venue (cancel-all is a separate action) and positions are still open (close is a separate action).' };
  }

  /** lifts an owner halt. A divergence is not lifted here: it clears when the venue and the records agree again, or when the owner re-bases them. */
  async resume(id: string) {
    await this.account(id);
    await sql`update deriv_accounts set halt = null, updated_at = ${new Date(this.now())} where id = ${id}`;
    await this.riskEvent(id, 'resume', null, 'owner halt lifted');
    await this.audit('deriv.live.resume', { account: id });
    return this.get(id);
  }

  /** cancels every order resting on the venue account (the venue's own list, not the wallet's). No passkey. It closes no position. */
  async cancelAll(id: string) {
    const a = await this.account(id), stop = this.blocked(a, 'stop');
    if (stop) throw stop;
    const venue = this.deps.venues.get(a.network);
    const open = await venue.adapter.openOrders(a.account).catch((e: unknown) => { throw new UserError('venue_unavailable', msg(e), 503); });
    const failed: { venueOrderId: string | null; instrument: string; error: string }[] = [];
    let cancelled = 0;
    for (const o of open) {
      try {
        if (!o.venueOrderId) throw new Error('no venue order id');
        const inst = await venue.instrument(o.instrument), nonce = await this.nextNonce(id);
        const built = venue.trading().buildCancel({ instrument: inst, venueOrderId: o.venueOrderId, nonce });
        const r = await this.act(a, venue, 'cancel', { venueOrderId: o.venueOrderId, instrument: o.instrument, cancelAll: true }, built, nonce);
        if (r.outcome === 'accepted') cancelled += 1; else failed.push({ venueOrderId: o.venueOrderId, instrument: o.instrument, error: r.error ?? r.outcome });
      } catch (e) { failed.push({ venueOrderId: o.venueOrderId, instrument: o.instrument, error: msg(e) }); }
    }
    // the venue's list decides what is left
    const remaining = await venue.adapter.openOrders(a.account).catch(() => null);
    const live = await sql`select client_id from deriv_orders where account_id = ${id} and state = any(${AT_VENUE}) and not final`;
    for (const r of live) await this.reconcileOrder(a, venue, r.client_id).catch(() => null);
    await this.audit('deriv.live.cancel_all', { account: id, requested: open.length, accepted: cancelled, failed: failed.length, remaining: remaining?.length ?? null });
    return { requested: open.length, accepted: cancelled, failed, remaining, source: 'venue' as const, ts: this.now() };
  }

  /** proposes a reduce-only market order on a fraction of the venue's position, bounded by a stated slippage. Needs the passkey like any order. */
  async close(id: string, body: z.infer<typeof CloseBodySchema>, key: string = `close-${randomUUID()}`) {
    const a = await this.account(id);
    const [prior] = await sql`select * from deriv_orders where account_id = ${id} and client_id = ${key}`;
    if (prior) return { ...(await this.proposalAnswer(prior, true)), worstPrice: canonN(prior.price), slippageBoundBps: null };
    const stop = this.blocked(a, 'trade');
    if (stop) throw stop;
    const venue = this.deps.venues.get(a.network), inst = await venue.instrument(body.instrument);
    const positions = await venue.adapter.positions(a.account).catch((e: unknown) => { throw new UserError('venue_unavailable', msg(e), 503); });
    const pos = positions.find((p) => p.instrument === inst.id);
    if (!pos) throw new UserError('no_position', `the venue reports no open position on ${inst.id}`, 422);
    const whole = D.eq(D.from(body.fraction), D.one);
    const size = whole ? D.from(pos.size) : D.quantize(D.mul(D.from(pos.size), D.from(body.fraction)), D.from(inst.lotSize), 'down');
    if (!D.isPos(size)) throw new UserError('below_min_size', `${body.fraction} of the position is less than one lot (${inst.lotSize})`, 422);
    const side = pos.side === 'long' ? 'sell' as const : 'buy' as const, bound = body.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    const { book } = await venue.market(inst), price = worstPrice(inst, book, side, bound);
    const r = await this.propose(id, OrderBodySchema.parse({ instrument: inst.id, side, type: 'market', size: D.str(size), price, reduceOnly: true, tif: 'ioc' }), key, 'close');
    return { ...r, worstPrice: price, slippageBoundBps: bound, position: { ...pos, source: 'venue' as const } };
  }

  /** the owner accepts the venue's present positions as the reference (after trading from another interface, a liquidation…) */
  async rebase(id: string) {
    const a = await this.account(id), venue = this.deps.venues.get(a.network);
    const positions = await venue.adapter.positions(a.account).catch((e: unknown) => { throw new UserError('venue_unavailable', msg(e), 503); });
    const now = this.now(), meta: Meta = { ...this.meta(a), baseline: Object.fromEntries(positions.map((x) => [x.instrument, x.side === 'long' ? x.size : `-${x.size}`])), baselineTs: now, pendingDivergence: null };
    await sql`update deriv_accounts set meta = ${sql.json(meta as never)}, divergence = null, updated_at = ${new Date(now)} where id = ${id}`;
    await this.riskEvent(id, 'divergence_rebased', null, 'the owner accepted the venue\'s present positions as the reference', { baseline: meta.baseline });
    await this.audit('deriv.live.rebased', { account: id, baseline: meta.baseline });
    return this.get(id);
  }

  // ------------------------------------------------------------------ reconciliation worker

  /** every venue account that was ever authorized or still has an order in flight */
  async active(): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`select a.id from deriv_accounts a where a.authorization_id is not null and (a.mode <> 'READ_ONLY' or exists (select 1 from deriv_orders o where o.account_id = a.id and o.state is not null and not o.final)) order by a.created_at`;
    return rows.map((r) => r.id);
  }

  /**
   * One reconciliation pass on one account, entirely from the database and the venue (nothing kept in memory between passes):
   * stale proposals, orders in flight, fills, funding, positions, divergence, equity.
   */
  async reconcile(id: string): Promise<{ reconciled: number; fills: number; funding: number; divergence: string | null }> {
    const a = await this.account(id), venue = this.deps.venues.get(a.network), now = this.now(), meta = this.meta(a);
    // 1 — local timeouts: nothing here touched the venue
    await sql`update deriv_orders set state = 'cancelled', status = 'cancelled', final = true, reject_reason = 'expired before approval; nothing was signed', updated_at = ${new Date(now)}
      where account_id = ${id} and state = any(${PRE_SUBMIT}) and (expires_at is null or expires_at < ${new Date(now)})`;
    await sql`update deriv_orders set state = 'rejected', status = 'rejected', final = true, reject_reason = 'interrupted while asking the signer; no signature was received, nothing was sent', updated_at = ${new Date(now)}
      where account_id = ${id} and state = 'authorized' and updated_at < ${new Date(now - AUTHORIZED_STUCK_MS)}`;
    await sql`update deriv_actions set state = 'cancelled', error = 'expired before approval', updated_at = ${new Date(now)} where account_id = ${id} and state = 'risk_checked' and expires_at < ${new Date(now)}`;

    // 2 — the venue's own state
    const [state, positions, openOrders, fills] = await Promise.all([venue.adapter.account(a.account), venue.adapter.positions(a.account), venue.adapter.openOrders(a.account),
      venue.adapter.fills(a.account, { start: Math.max(0, meta.fillsCursor - 60_000) })]);
    const newFills = await this.storeFills(id, fills);
    if (fills.length) meta.fillsCursor = Math.max(meta.fillsCursor, ...fills.map((f) => f.ts));
    let newFunding = 0;
    if (now - meta.fundingReadAt >= FUNDING_EVERY_MS) {
      const pays = await venue.adapter.funding(a.account, { start: Math.max(0, meta.fundingCursor - 3_600_000) }).catch(() => null);
      if (pays) {
        for (const p of pays) {
          const ins = await sql`insert into deriv_funding (account_id, instrument, ts, amount, rate, size) values (${id}, ${p.instrument}, ${new Date(p.ts)}, ${p.amount}, ${p.rate}, ${p.size}) on conflict (account_id, instrument, ts) do nothing returning ts`;
          newFunding += ins.length;
        }
        if (pays.length) meta.fundingCursor = Math.max(meta.fundingCursor, ...pays.map((p) => p.ts));
        meta.fundingReadAt = now;
      }
    }

    // 3 — every order that is somewhere between the signer and a final state
    const live = await sql`select client_id from deriv_orders where account_id = ${id} and state is not null and not final and state <> all(${[...PRE_SUBMIT, 'authorized']})`;
    for (const r of live) await this.reconcileOrder(a, venue, r.client_id, fills).catch((e: unknown) => console.error(`[derivatives] live reconcile ${id}/${r.client_id}: ${msg(e)}`));

    // 4 — divergence between the venue and what the wallet's own orders explain
    const ours = new Set((await sql<{ cloid: string }[]>`select cloid from deriv_orders where account_id = ${id} and cloid is not null`).map((r) => r.cloid));
    const sums = await sql<{ instrument: string; net: string }[]>`select instrument, sum(case when side = 'buy' then size else -size end)::text as net from deriv_fills
      where account_id = ${id} and ts >= ${new Date(meta.baselineTs)} and client_id = any(${[...ours]}) group by instrument`;
    const expected = new Map<string, ReturnType<typeof D.from>>();
    for (const [k, v] of Object.entries(meta.baseline)) expected.set(k, D.from(v));
    for (const s of sums) expected.set(s.instrument, D.add(expected.get(s.instrument) ?? D.zero, D.from(s.net)));
    const actual = new Map(positions.map((p) => [p.instrument, D.from(p.side === 'long' ? p.size : `-${p.size}`)]));
    const problems: string[] = [];
    for (const k of new Set([...expected.keys(), ...actual.keys()])) {
      const e = expected.get(k) ?? D.zero, v = actual.get(k) ?? D.zero;
      if (!D.eq(e, v)) problems.push(`position ${k}: venue ${D.str(v)}, wallet records ${D.str(e)}`);
    }
    for (const o of openOrders) if (!ours.has(o.clientId)) problems.push(`order ${o.venueOrderId} on ${o.instrument} rests on the venue and was not placed by the wallet`);
    const found = problems.length ? problems.slice(0, 4).join('; ') : null;
    // a difference must be seen on two passes in a row: the venue's position can move a moment before its fills are published
    let divergence = a.divergence;
    if (a.mode === 'MANUAL_LIVE') {
      if (found && (meta.pendingDivergence === found || a.divergence !== null)) {
        if (a.divergence !== found) {
          divergence = found;
          await this.riskEvent(id, 'divergence', 'state_divergence', `the venue's state and the wallet's records differ: ${found}. New orders are stopped until it clears.`, { problems }, `divergence:${found}`);
          await this.audit('deriv.live.divergence', { account: id, problems }, 'reconciler');
        }
      } else if (!found && a.divergence !== null) {
        divergence = null;
        await this.riskEvent(id, 'divergence_cleared', null, 'the venue\'s state and the wallet\'s records agree again');
        await this.audit('deriv.live.divergence_cleared', { account: id }, 'reconciler');
      }
      meta.pendingDivergence = found;
    }

    // 5 — equity, one row per minute, straight from the venue
    const minute = Math.floor(now / 60_000) * 60_000;
    if (minute !== meta.lastEquityMinute) {
      const unrealized = D.str(D.sub(D.from(state.equity), D.from(state.collateral)));
      await sql`insert into deriv_equity (account_id, ts, equity, collateral, margin_used, unrealized_pnl) values (${id}, ${new Date(minute)}, ${state.equity}, ${state.collateral}, ${state.marginUsed}, ${unrealized})
        on conflict (account_id, ts) do update set equity = excluded.equity, collateral = excluded.collateral, margin_used = excluded.margin_used, unrealized_pnl = excluded.unrealized_pnl`;
      meta.lastEquityMinute = minute;
    }
    await sql`update deriv_accounts set meta = ${sql.json(meta as never)}, divergence = ${divergence}, updated_at = ${new Date(now)} where id = ${id}`;
    this.emit(id, { event: 'account', data: { state, positions, openOrders, divergence, halt: a.halt, mode: a.mode, ts: now, source: 'venue' } });
    return { reconciled: live.length, fills: newFills, funding: newFunding, divergence };
  }

  async step(): Promise<StepSummary> {
    const s: StepSummary = { accounts: 0, reconciled: 0, fills: 0, funding: 0, divergences: 0, errors: [] };
    for (const id of await this.active()) {
      s.accounts += 1;
      try { const r = await this.reconcile(id); s.reconciled += r.reconciled; s.fills += r.fills; s.funding += r.funding; if (r.divergence) s.divergences += 1; }
      catch (e) { s.errors.push(`account ${id}: ${msg(e)}`); this.emit(id, { event: 'status', data: { error: msg(e), ts: this.now() } }); }
    }
    return s;
  }
}
