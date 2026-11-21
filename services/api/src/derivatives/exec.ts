/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/derivatives/exec.ts
 * Module           : derivatives
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-17
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

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
import { createHash, randomUUID } from 'node:crypto';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { z } from 'zod';
import { toB64u } from '@spw/core';
import {
  checkOrder, D, hlFormatPrice, initialMargin, OrderRequestSchema, RiskPolicySchema, VenueError,
  type AccountState, type Book, type DecStr, type Fill, type Instrument, type Order, type OrderRequest, type Position, type RiskPolicy, type RiskResult, type RiskUsage, type Ticker,
} from '@spw/derivatives';
import {
  hex, hlCloid, hlPinnedAsset, HL_PINNED_AT, HL_PINNED_ASSETS, jurisdictionAck, validateVenueAuthorization, venueAgentWireName, venueAuthorizationHash, venueLeverageHash, venueOrderHash, venueOrderNotional, venueOrderPriceError,
  VenuePolicySchema, VENUE_AUTH_MAX_DAYS, VENUE_POLICY_BOUNDS,
  validateVenueMandate, VENUE_MANDATE_BOUNDS, VENUE_MANDATE_MAX_DAYS, VENUE_MANDATE_WIND_DOWN_S, venueMandateHash, venueMandatePhase, VenueMandateSchema,
  type HlNetwork, type JurisdictionAck, type SignRequest, type VenueAuthorization, type VenueLeverage, type VenueMandate, type VenueMandatePhase, type VenueOrder, type VenuePolicy,
} from '@spw/derivatives/live';
import { UserError } from '../config.ts';
import { audit, getSetting, sql } from '../db.ts';
import type { NewRiskBlock, PreTradeGate, PreTradeRequest } from './gate.ts';
import { LIVE_REASONS, liveReason, liveTexts, revokeWarning, type LiveLocale } from './live-texts.ts';
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

/** an answer of /venue/authorize, as it is returned — the first time, or again by /venue/authorization */
export interface VenueAuthorizeAnswer { authorizationId: string; hash: string; agentAddress: string; approve: { action: unknown; signature: { r: string; s: string; v: number }; nonce: number } }
export interface LiveSignerPort {
  status(fresh?: boolean): Promise<{ keyId: string; halted: boolean; addresses: Record<string, string>;
    /** the venue authorizations and derivative mandates the signer holds (V11: read to find one whose answer was lost) */
    venues?: { authorization: { authorizationId: string; venue: string; network: string }; hash: string; revoked: boolean; expired: boolean }[];
    venueMandates?: { mandate: { mandateId: string; authorizationId: string }; hash: string; phase: 'active' | 'wind_down' | 'ended' }[] }>;
  /** V11: the stored answer of an active authorization, again; absent on a signer port that cannot give it (the orphan is then revoked) */
  venueAuthorization?(authorizationId: string): Promise<VenueAuthorizeAnswer>;
  venueKey(venue: string, network: string): Promise<{ venue: string; network: string; address: string; path: string; account: string }>;
  venueAuthorize(authorization: unknown, assertion: unknown): Promise<{ authorizationId: string; hash: string; agentAddress: string; approve: { action: unknown; signature: { r: string; s: string; v: number }; nonce: number } }>;
  venueSign(p: { authorizationId: string; sign: unknown; context?: unknown; assertion?: unknown }): Promise<{ signature: { r: string; s: string; v: number }; signer: string; kind: string; hash: string }>;
  venueRevoke(authorizationId: string): Promise<{ revoked: true; revokedAt: string }>;
}
/** the signer's derivative-mandate endpoints (services/isolated-signer/src/venue-mandate.ts) */
export interface MandateSignerPort {
  venueMandateApprove(mandate: unknown, assertion: unknown): Promise<{ mandateId: string; hash: string; authorizationId: string }>;
  venueMandateSign(p: { mandateId: string; sign: unknown; context?: unknown }): Promise<{ signature: { r: string; s: string; v: number }; signer: string; kind: string; hash: string; mandateId: string; phase: string }>;
  venueMandateRevoke(mandateId: string): Promise<{ revoked: true; revokedAt: string; windDownUntil: number }>;
}
export interface LiveDeps {
  venues: LiveVenues; signer: LiveSignerPort; now: () => number; rpId: string;
  /** MANDATE_LIVE: absent = mandates are unavailable (every mandate route answers 503 mandate_unavailable) */
  mandateSigner?: MandateSignerPort;
  /** server setting SPW_DERIV_MANDATE_MAINNET=on (default off): autonomous trading on mainnet needs it AND mainnetEnabled */
  mandateMainnetEnabled?: () => boolean;
  /** server setting SPW_DERIV_LIVE_MAINNET=on (default off) */
  mainnetEnabled: () => boolean;
  /** enrolled passkeys, for the WebAuthn request options */
  credentials: () => Promise<{ id: string; transports: unknown }[]>;
  /** pause between two reads of the venue when waiting for it to show an approval (tests: 0) */
  confirmDelayMs?: number;
  /**
   * V11 (B-08): verifies a WebAuthn assertion of an enrolled passkey over `challenge` (user verification required); throws when
   * it does not verify. Loosening an API-side limit and lifting an API-side halt need it. Absent = those changes are refused.
   */
  verifyOwner?: (assertion: unknown, challenge: Uint8Array) => Promise<void>;
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
export const RevokeBodySchema = z.strictObject({ cancelOpenOrders: z.boolean().default(false), locale: z.enum(['fr', 'en']).default('en') });
/** the limits of a derivative mandate, as the owner chooses them (everything else of the canonical mandate comes from the account and its authorization) */
export const MandateBodySchema = z.strictObject({
  ...VenueMandateSchema.pick({ instruments: true, maxOrderNotional: true, maxGrossExposure: true, maxOrdersPerDay: true, maxOrdersPerHour: true, maxDailyTurnover: true, floorEquity: true, strategySha256: true, agentId: true }).shape,
  /** default: the band of the authorization */
  maxPriceDeviationBps: VenueMandateSchema.shape.maxPriceDeviationBps.optional(), days: z.number().int().min(1).max(VENUE_MANDATE_MAX_DAYS), locale: z.enum(['fr', 'en']).default('en'),
});
export const ApproveMandateSchema = z.strictObject({ assertion: z.record(z.string(), z.unknown()), acknowledged: z.literal(true) });
/** who places a mandate order: the strategy version and the agent the mandate was approved for, and the order's idempotency key */
export const MandateOrderCtxSchema = z.strictObject({ strategySha256: z.string().regex(/^[0-9a-f]{64}$/), agentId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/), clientId: z.string().regex(/^[A-Za-z0-9._:-]{8,100}$/) });
export type MandateOrderCtx = z.infer<typeof MandateOrderCtxSchema>;
/** venue expiry of an order signed under a mandate: short, because the signer counts a signed order as exposure until it has expired */
export const MANDATE_ACTION_TTL_MS = 30_000;
interface MandateRow { id: string; account_id: string; authorization_id: string; state: 'prepared' | 'consumed' | 'failed' | 'active' | 'revoked'; mandate: VenueMandate; hash: string;
  ack: Pick<JurisdictionAck, 'locale' | 'sha256' | 'version'>; prepared_at: Date; approved_at: Date | null; revoked_at: Date | null }

const canon = (x: string): DecStr => D.str(D.from(x));
const canonN = (x: string | null): DecStr | null => (x === null ? null : canon(x));
const dayStart = (now: number): number => Math.floor(now / 86_400_000) * 86_400_000;
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const MAINNET_OFF = LIVE_REASONS.mainnet_disabled.en;

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

// ---------------------------------------------------------------------------------------------------------------------------
// V11 (B-08) — API-side limits and halts are the only loss limits of a manual account and the outer limits of a mandate. A
// session cookie alone could loosen them or lift a halt. Tightening stays free; LOOSENING a limit, lifting the owner's halt and
// re-basing a divergence now need a passkey assertion whose challenge is the hash of the canonical intent below.

export const RISK_INTENT_TTL_MS = 300_000;
export interface RiskIntent {
  v: 1; kind: 'policy' | 'resume' | 'rebase'; accountId: string; venue: string; network: string; account: string; authorizationId: string;
  /** `policy`: the whole policy that will be in force; null for the two others */ policy: RiskPolicy | null;
  /** `policy`: the fields that become looser, as shown for approval */ loosened: string[];
  /** `resume`: the halt being lifted; `rebase`: the divergence being accepted */ subject: string | null;
  nonce: string; createdAt: number; expiresAt: number;
}
const stableJson = (v: unknown): string => (v === null || typeof v !== 'object' ? JSON.stringify(v ?? null) : Array.isArray(v) ? `[${v.map(stableJson).join(',')}]`
  : `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`);
/** SHA-256 of a domain tag and the object with its keys in sorted order: the passkey's challenge */
export const canonicalIntentHash = (domain: string, i: unknown): Uint8Array => new Uint8Array(createHash('sha256').update(`${domain}\n${stableJson(i)}`).digest());
export const riskIntentHash = (i: RiskIntent): Uint8Array => canonicalIntentHash('SPW-RISK-INTENT-v1', i);

const UP_IS_LOOSER = ['maxDataAgeMs', 'maxDeviationBps', 'maxMarkIndexBps', 'maxLeverage', 'maxOrderNotional', 'maxGrossExposure', 'maxPositionNotional', 'maxDailyLoss', 'maxTotalLoss', 'maxOrdersPerMinute', 'maxOrdersPerDay'] as const;
const DOWN_IS_LOOSER = ['minFreeCollateral', 'minLiquidationDistanceBps'] as const;
/** which fields of `next` allow more than `cur` does. A field this function does not know and that changed counts as loosened (fail closed). Pure. */
export function loosenedFields(cur: RiskPolicy, next: RiskPolicy): string[] {
  const out: string[] = [], num = (x: unknown) => D.from(String(x));
  if (next.allowedInstruments.some((i) => !cur.allowedInstruments.includes(i))) out.push('allowedInstruments');
  for (const k of UP_IS_LOOSER) if (D.gt(num(next[k]), num(cur[k]))) out.push(k);
  for (const k of DOWN_IS_LOOSER) if (D.lt(num(next[k]), num(cur[k]))) out.push(k);
  if (cur.halt !== null && next.halt === null) out.push('halt');
  if (cur.mode !== next.mode) out.push('mode');
  const known = new Set<string>(['mode', 'allowedInstruments', 'halt', ...UP_IS_LOOSER, ...DOWN_IS_LOOSER]);
  for (const k of new Set([...Object.keys(cur), ...Object.keys(next)])) if (!known.has(k) && stableJson((cur as Record<string, unknown>)[k]) !== stableJson((next as Record<string, unknown>)[k])) out.push(k);
  return out;
}
interface RiskStash { intent: RiskIntent; hash: string }
const riskKey = (id: string, kind: RiskIntent['kind']) => `deriv.live.risk.${kind}.${id}`;
/** the authorization handed to the signer whose answer has not been seen yet (V11, B-04) */
const submittedKey = (id: string) => `deriv.live.submitted.${id}`;

export type LiveEvent = { event: 'account' | 'order' | 'action' | 'risk' | 'status'; data: unknown };
export interface StepSummary { accounts: number; reconciled: number; fills: number; funding: number; divergences: number; errors: string[] }

export class LiveService {
  readonly deps: LiveDeps;
  readonly now: () => number;
  private readonly listeners = new Map<string, Set<(ev: LiveEvent) => void>>();
  /** proposals being built right now, by account and idempotency key: a concurrent duplicate waits for the first instead of answering half-built */
  private readonly building = new Map<string, Promise<unknown>>();
  /** V11: the unified risk gate (derivatives/gate.ts), set by the server; null = this engine alone judges (tests that build it bare) */
  preTrade: PreTradeGate | null = null;
  /** V11: the global kill switch / read-only mode, asked again when a proposal made earlier is approved */
  newRiskBlock: NewRiskBlock | null = null;
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

  /**
   * Why this account cannot send this to the venue right now; null = it can.
   *  - `trade`: anything that can open or add risk (an order that is not reduce-only, a leverage change, a mandate approval);
   *  - `reduce`: a reduce-only order on an EXISTING position (the risk engine checks that it really reduces, the venue enforces the flag);
   *  - `stop`: a cancel.
   * V11 (B-02): the mainnet server lock closes NEW risk only. Switching SPW_DERIV_LIVE_MAINNET off — or forgetting it at a
   * restart — must not leave positions and resting orders that the wallet can no longer close or cancel.
   */
  private blocked(a: AccountRow, what: 'trade' | 'reduce' | 'stop'): UserError | null {
    if (what === 'trade' && a.network === 'mainnet' && !this.deps.mainnetEnabled()) return new UserError('mainnet_disabled', MAINNET_OFF, 403);
    if (!a.authorization_id || !a.venue_authorization) return new UserError('mode_read_only', 'this venue account is read-only: live trading has not been authorized with the owner\'s passkey', 422);
    if (a.mode !== 'MANUAL_LIVE') return new UserError('mode_read_only', 'the authorization of this venue account was revoked: it is read-only', 422);
    if (what !== 'stop' && this.now() >= a.venue_authorization.expiresAt * 1000) return new UserError('authorization_expired', 'the venue authorization has expired: approve a new one', 422);
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

  config(locale: LiveLocale = 'en') {
    const mainnet = this.deps.mainnetEnabled(), mandates = this.deps.mandateSigner !== undefined, mandateMainnet = mainnet && (this.deps.mandateMainnetEnabled?.() ?? false);
    const mandateCode = !mandates ? 'mandate_unavailable' as const : null;
    return {
      mainnetEnabled: mainnet, locale,
      /** why mainnet is closed, as a code and as a sentence in the requested locale; null when it is open */
      mainnet: { enabled: mainnet, code: mainnet ? null : 'mainnet_disabled' as const, reason: mainnet ? null : liveReason('mainnet_disabled', locale) },
      venues: [{ venue: 'hyperliquid' as const, networks: ['testnet', 'mainnet'] as const }], modes: (mandates ? ['READ_ONLY', 'MANUAL_LIVE', 'MANDATE_LIVE'] : ['READ_ONLY', 'MANUAL_LIVE']) as string[],
      mandateLive: { available: mandates, code: mandateCode, reason: mandateCode ? liveReason(mandateCode, locale) : null,
        mainnet: { enabled: mandateMainnet, code: mandateMainnet ? null : 'mandate_mainnet_disabled' as const, reason: mandateMainnet ? null : liveReason('mandate_mainnet_disabled', locale) },
        bounds: { ...VENUE_MANDATE_BOUNDS, windDownSeconds: VENUE_MANDATE_WIND_DOWN_S, orderTtlMs: MANDATE_ACTION_TTL_MS } },
      /** every reason code above, in both languages */
      reasons: LIVE_REASONS,
      pinnedAssets: { pinnedAt: HL_PINNED_AT, mainnet: HL_PINNED_ASSETS.mainnet.map((x) => ({ instrument: `hyperliquid:${x.symbol}`, maxLeverage: x.maxLeverage })), testnet: HL_PINNED_ASSETS.testnet.map((x) => ({ instrument: `hyperliquid:${x.symbol}`, maxLeverage: x.maxLeverage })) },
      bounds: { ...VENUE_POLICY_BOUNDS, maxAuthorizationDays: VENUE_AUTH_MAX_DAYS, orderApprovalTtlMs: LIVE_ACTION_TTL_MS }, ts: this.now(),
    };
  }

  async list() {
    const rows = await sql<AccountRow[]>`select * from deriv_accounts order by created_at`, out = [];
    for (const a of rows) out.push({ ...this.summary(a), ...(await this.mandateInfo(a)) });
    return out;
  }

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
      ...this.summary(a), ...(await this.mandateInfo(a)), venueState: venue,
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
  async collateral(id: string, locale: LiveLocale = 'en') {
    const a = await this.account(id), v = await this.venueState(a), t = liveTexts(locale);
    return {
      account: a.account, network: a.network, equity: v.state?.equity ?? null, collateral: v.state?.collateral ?? null, freeCollateral: v.state?.freeCollateral ?? null, marginUsed: v.state?.marginUsed ?? null,
      withdrawable: v.state?.withdrawable ?? null, asset: 'USDC', error: v.error, ts: v.ts, source: 'venue' as const,
      locale, deposits: { supported: a.network === 'mainnet', how: t.depositsHow }, withdrawals: { supported: true, how: t.withdrawalsHow },
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
    // a mainnet venue account is not even created while the server keeps mainnet closed (an account that already exists stays, read-only)
    if (body.network === 'mainnet' && !this.deps.mainnetEnabled()) throw new UserError('mainnet_disabled', MAINNET_OFF, 403);
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
    // V11 (B-04): the account is READ_ONLY here, so an authorization the signer holds as active for it is one whose answer was lost
    if ((st.venues ?? []).some((v) => v.authorization.venue === a.venue && v.authorization.network === a.network && !v.revoked && !v.expired))
      throw new UserError('authorization_orphaned', 'the signer already holds an active authorization for this venue account that this wallet has no record of (its answer was lost). Use "recover" on this venue account first: it adopts that authorization or revokes it.', 409);
    const key = await this.deps.signer.venueKey(a.venue, a.network);
    if (key.address.toLowerCase() !== a.agent_address || key.account.toLowerCase() !== a.account) throw new UserError('wrong_key', 'this venue account belongs to another signer key', 409);
    const venue = this.deps.venues.get(a.network);
    await venue.assertPinned(body.policy.allowedInstruments);
    for (const inst of body.policy.allowedInstruments) if (!hlPinnedAsset(a.network, inst)) throw new UserError('bad_policy', `${inst} is not in the pinned ${a.network} asset table: it cannot be allowed`, 400);
    const nowMs = this.now(), nowS = Math.floor(nowMs / 1000), ack = jurisdictionAck('hyperliquid', body.locale);
    const authorization: VenueAuthorization = { v: 1, authorizationId: randomUUID(), keyId: st.keyId, venue: 'hyperliquid', network: a.network, account: a.account, agentAddress: a.agent_address, agentName: body.agentName,
      mode: 'MANUAL_LIVE', policy: body.policy, createdAt: nowS, expiresAt: nowS + body.days * 86400, approveNonce: nowMs, ackSha256: ack.sha256 };
    try { validateVenueAuthorization(authorization, nowS); } catch (e) { throw new UserError('bad_policy', msg(e), 400); }
    const hash = venueAuthorizationHash(authorization);
    const pending: Pending = { authorization, ack: { locale: ack.locale, sha256: ack.sha256, version: ack.version }, preparedAt: nowMs };
    await sql`update deriv_accounts set pending = ${sql.json(pending as never)}, updated_at = ${new Date(nowMs)} where id = ${id}`;
    const v = await this.venueState(a), t = liveTexts(body.locale);
    return {
      authorization, hash: hex(hash), acknowledgement: ack, locale: body.locale,
      agent: { address: a.agent_address, name: body.agentName, wireName: venueAgentWireName(authorization), validUntil: authorization.expiresAt * 1000, can: t.can, cannot: t.cannot, note: t.agentNote },
      whatIsSigned: { byMainKey: t.byMainKey, byPasskey: t.byPasskey },
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
    const auth = p.authorization;
    await sql`update deriv_accounts set pending = null where id = ${id}`;                      // an authorization is approved once
    // V11 (B-04): what is handed to the signer is kept until its answer is seen. If the answer is lost — timeout, crash, relay
    // drop — the signer may hold an authorization this API does not know, and would refuse any other for up to 90 days:
    // `recover` (below) asks the signer for it again and adopts it, or revokes it.
    await sql`insert into settings (key, value) values (${submittedKey(id)}, ${sql.json(p as never)}) on conflict (key) do update set value = excluded.value`;
    let r: VenueAuthorizeAnswer;
    try { r = await this.deps.signer.venueAuthorize(auth, body.assertion); }
    catch (e) {
      // a refusal changed nothing on the signer; "unreachable" or an internal error leaves the outcome unknown
      const unknown = e instanceof UserError && (e.code === 'signer_unreachable' || e.code === 'signer_internal');
      if (!unknown) await sql`delete from settings where key = ${submittedKey(id)}`;
      else await this.audit('deriv.live.authorization_unknown', { account: id, authorizationId: auth.authorizationId, reason: msg(e) });
      throw unknown ? new UserError('authorization_unknown', `the signer gave no usable answer (${msg(e)}): it may or may not have stored the authorization. Use "recover" on this venue account: it asks the signer, then adopts the authorization or revokes it.`, 503) : e;
    }
    return this.finishAuthorization(a, p, r);
  }

  /** the signer stored the authorization and signed the venue approval (`r`): the venue must now show the API wallet */
  private async finishAuthorization(a: AccountRow, p: Pending, r: VenueAuthorizeAnswer) {
    const id = a.id, auth = p.authorization, venue = this.deps.venues.get(a.network);
    // The signer verified the owner's passkey over an authorization that contains the hash of the text that was displayed: that
    // is the owner's confirmation. It is recorded now, whatever the venue answers next.
    await this.audit('deriv.live.acknowledged', { account: id, venue: a.venue, network: a.network, authorizationId: auth.authorizationId, authorizationHash: r.hash, ackSha256: p.ack.sha256, locale: p.ack.locale, version: p.ack.version,
      statement: 'the owner confirmed with his passkey having read the jurisdiction summary; enabling live derivative trading on this venue is his own decision' });
    const undo = async (why: string): Promise<never> => {
      await this.deps.signer.venueRevoke(auth.authorizationId).catch(() => {});
      await sql`delete from settings where key = ${submittedKey(id)}`;
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
    await sql`delete from settings where key = ${submittedKey(id)}`;
    await this.audit('deriv.live.authorized', { account: id, venue: a.venue, network: a.network, authorizationId: auth.authorizationId, hash: r.hash, agentAddress: a.agent_address, mode: auth.mode, policy: auth.policy, expiresAt: auth.expiresAt, ackSha256: auth.ackSha256 });
    this.emit(id, { event: 'status', data: { mode: 'MANUAL_LIVE', ts: now } });
    return this.get(id);
  }

  /**
   * V11 (B-04) — reconciliation with the signer after a lost answer. Reads the signer's own list and, for this venue account:
   *  - an active authorization that is exactly the one this API handed over (same id, same canonical hash): ADOPTED — the
   *    signer returns the answer it stored (no new signature, no passkey: the owner's passkey approved these bytes), and the
   *    normal sequence resumes (venue approval, confirmation, account goes MANUAL_LIVE);
   *  - any other active authorization the API has no record of: REVOKED on the signer (stopping never needs a passkey). The
   *    account is then free for a new authorization;
   *  - a derivative mandate the signer holds as active while the API recorded its approval as failed or unanswered: adopted
   *    when it is the very mandate that was submitted, revoked otherwise.
   * Nothing here can create or widen an authority: it only takes what the passkey already approved, or removes.
   */
  async recover(id: string) {
    const a = await this.account(id), actions: { what: 'authorization' | 'mandate'; id: string; outcome: 'adopted' | 'revoked'; detail: string }[] = [];
    const st = await this.deps.signer.status(true);
    const sub = await getSetting<Pending | null>(submittedKey(id), null);
    if (a.mode === 'READ_ONLY') {
      for (const v of (st.venues ?? []).filter((x) => x.authorization.venue === a.venue && x.authorization.network === a.network && !x.revoked && !x.expired)) {
        const vid = v.authorization.authorizationId;
        const mine = sub !== null && sub.authorization.authorizationId === vid && hex(venueAuthorizationHash(sub.authorization)) === v.hash && this.deps.signer.venueAuthorization !== undefined
          && !(a.network === 'mainnet' && !this.deps.mainnetEnabled());   // adopting turns live trading on: the mainnet lock applies, as for any approval
        if (!mine) {
          await this.deps.signer.venueRevoke(vid);
          await this.audit('deriv.live.authorization_orphan_revoked', { account: id, authorizationId: vid, hash: v.hash, known: sub?.authorization.authorizationId === vid });
          actions.push({ what: 'authorization', id: vid, outcome: 'revoked', detail: 'the signer held an authorization this wallet has no usable record of: it was revoked on the signer; a new one can be prepared' });
          continue;
        }
        const r = await this.deps.signer.venueAuthorization!(vid);
        if (r.hash !== v.hash || r.authorizationId !== vid || r.agentAddress.toLowerCase() !== a.agent_address) throw new UserError('hash_mismatch', 'the signer returned another authorization than the one asked for', 500);
        await this.audit('deriv.live.authorization_recovered', { account: id, authorizationId: vid, hash: v.hash });
        await this.finishAuthorization(a, sub!, r);                                              // throws venue_rejected (and revokes) when the venue refuses the trading key
        actions.push({ what: 'authorization', id: vid, outcome: 'adopted', detail: 'the signer held the authorization approved with the passkey; its stored answer was used and live trading is on' });
      }
      await sql`delete from settings where key = ${submittedKey(id)}`;
    } else if (a.authorization_id) {
      const known = await sql<MandateRow[]>`select * from deriv_mandates where account_id = ${id}`;
      for (const sm of (st.venueMandates ?? []).filter((x) => x.mandate.authorizationId === a.authorization_id && x.phase === 'active')) {
        const row = known.find((k) => k.id === sm.mandate.mandateId);
        if (row && (row.state === 'active' || row.state === 'revoked')) continue;               // nothing lost
        const other = known.some((k) => k.state === 'active');
        if (row && row.hash === sm.hash && (row.state === 'consumed' || row.state === 'failed') && !other && this.deps.mandateSigner && this.mandateLock(a) === null) {
          const now = new Date(this.now());
          await sql`update deriv_mandates set state = 'active', approved_at = ${now}, updated_at = ${now} where id = ${row.id}`;
          await this.audit('deriv.live.mandate_recovered', { account: id, mandateId: row.id, hash: row.hash });
          actions.push({ what: 'mandate', id: row.id, outcome: 'adopted', detail: 'the signer held the mandate approved with the passkey: it is in force' });
        } else {
          await this.mandateSigner().venueMandateRevoke(sm.mandate.mandateId);
          if (row) await sql`update deriv_mandates set state = 'revoked', revoked_at = ${new Date(this.now())}, updated_at = ${new Date(this.now())} where id = ${row.id}`;
          await this.audit('deriv.live.mandate_orphan_revoked', { account: id, mandateId: sm.mandate.mandateId });
          actions.push({ what: 'mandate', id: sm.mandate.mandateId, outcome: 'revoked', detail: 'the signer held a mandate this wallet has no usable record of: it was revoked on the signer' });
        }
      }
    }
    return { ...(await this.get(id)), recovered: actions };
  }

  /** stopping never needs a passkey. The signer forgets nothing: a revoked authorization signs nothing, not even a cancel. */
  async revoke(id: string, body: { cancelOpenOrders: boolean; locale?: LiveLocale }) {
    const a = await this.account(id);
    let cancelled: Awaited<ReturnType<LiveService['cancelAll']>> | null = null, cancelError: { code: string; message: string } | null = null;
    if (body.cancelOpenOrders && a.mode === 'MANUAL_LIVE') {
      try { cancelled = await this.cancelAll(id); }
      catch (e) { cancelError = { code: e instanceof UserError ? e.code : 'internal', message: msg(e) }; }          // said to the owner; the revocation goes on
    }
    if (a.authorization_id) await this.deps.signer.venueRevoke(a.authorization_id);
    const now = new Date(this.now());
    // a mandate dies with its authorization: no wind-down (the signer signs nothing for a revoked authorization)
    const ended = await sql<{ id: string }[]>`update deriv_mandates set state = 'revoked', revoked_at = ${now}, updated_at = ${now} where account_id = ${id} and state = 'active' returning id`;
    for (const m of ended) await this.deps.mandateSigner?.venueMandateRevoke(m.id).catch(() => {});
    await sql`delete from deriv_mandates where account_id = ${id} and state = 'prepared'`;
    await sql`update deriv_accounts set mode = 'READ_ONLY', policy = ${sql.json({ ...a.policy, mode: 'READ_ONLY' } as never)}, pending = null, revoked_at = ${a.authorization_id ? now : a.revoked_at}, updated_at = ${now} where id = ${id}`;
    await sql`update deriv_orders set state = 'cancelled', status = 'cancelled', final = true, reject_reason = 'withdrawn: the venue authorization was revoked before approval', updated_at = ${now}
      where account_id = ${id} and state = any(${PRE_SUBMIT})`;
    await this.audit('deriv.live.revoked', { account: id, authorizationId: a.authorization_id });
    const v = await this.venueState(a);
    this.emit(id, { event: 'status', data: { mode: 'READ_ONLY', ts: now.getTime() } });
    return { ...(await this.get(id)), cancelled,
      /** why cancel-all could not run (`cancelled` is then null); null when it ran or was not asked for */
      cancelError,
      warning: v.openOrders.length ? revokeWarning(v.openOrders.length, body.locale ?? 'en') : null,   // v8: in the body's `locale` (default en = the same sentence as before)
      venueAgent: liveTexts(body.locale ?? 'en').venueAgent, locale: body.locale ?? 'en' };
  }

  /** what every API-side policy must respect, whoever asks: it can never exceed what the passkey-approved authorization allows */
  private checkPolicyBounds(a: AccountRow, policy: RiskPolicy): void {
    const auth = a.venue_authorization;
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
  }
  private async writePolicy(a: AccountRow, policy: RiskPolicy, loosened: string[], passkey: boolean) {
    await sql`update deriv_accounts set policy = ${sql.json(policy as never)}, updated_at = ${new Date(this.now())} where id = ${a.id}`;
    await this.audit('deriv.live.policy_replaced', { account: a.id, maxLeverage: policy.maxLeverage, maxOrderNotional: policy.maxOrderNotional, maxGrossExposure: policy.maxGrossExposure, maxDailyLoss: policy.maxDailyLoss, maxTotalLoss: policy.maxTotalLoss,
      minLiquidationDistanceBps: policy.minLiquidationDistanceBps, minFreeCollateral: policy.minFreeCollateral, loosened, passkey });
    return this.get(a.id);
  }

  /**
   * The API-side risk policy. TIGHTENING is free (no passkey). A change that loosens any field (V11, B-08) is refused here
   * with `passkey_required`: it goes through prepareRisk('policy') → approveRisk, where the owner's passkey signs the whole new policy.
   */
  async setPolicy(id: string, policy: RiskPolicy) {
    const a = await this.account(id);
    this.checkPolicyBounds(a, policy);
    const loosened = loosenedFields(RiskPolicySchema.parse(a.policy), policy);
    if (loosened.length) throw new UserError('passkey_required', `this change loosens ${loosened.join(', ')}: it needs the owner's passkey (prepare it, then approve). Tightening needs none.`, 403);
    return this.writePolicy(a, policy, [], false);
  }

  /**
   * Step 1 of a change that needs the passkey: the canonical intent, stored once, and the WebAuthn request over its hash.
   * `policy`: nothing loosened → `{ needed: false }` (use setPolicy). `resume`: no owner halt → `{ needed: false }`.
   */
  async prepareRisk(id: string, kind: RiskIntent['kind'], policy: RiskPolicy | null = null) {
    const a = await this.account(id);
    if (a.mode !== 'MANUAL_LIVE' || !a.authorization_id) throw new UserError('mode_read_only', 'a read-only venue account has nothing to change: authorize it first', 422);
    let loosened: string[] = [], subject: string | null = null;
    if (kind === 'policy') {
      if (!policy) throw new UserError('bad_request', 'the new policy is required', 400);
      this.checkPolicyBounds(a, policy);
      loosened = loosenedFields(RiskPolicySchema.parse(a.policy), policy);
      if (!loosened.length) return { needed: false as const, kind, loosened, intent: null, hash: null, options: null, expiresAt: null };
    } else if (kind === 'resume') {
      if (a.halt === null) return { needed: false as const, kind, loosened, intent: null, hash: null, options: null, expiresAt: null };
      subject = a.halt;
    } else subject = a.divergence;                                                           // null when no divergence is flagged yet: the re-base still moves the reference
    if (!this.deps.verifyOwner) throw new UserError('passkey_unavailable', 'this server cannot verify a passkey approval for a risk change: the change is refused', 503);
    const now = this.now();
    const intent: RiskIntent = { v: 1, kind, accountId: a.id, venue: a.venue, network: a.network, account: a.account, authorizationId: a.authorization_id, policy: kind === 'policy' ? policy : null, loosened, subject,
      nonce: randomUUID(), createdAt: now, expiresAt: now + RISK_INTENT_TTL_MS };
    const hash = riskIntentHash(intent), stash: RiskStash = { intent, hash: hex(hash) };
    await sql`insert into settings (key, value) values (${riskKey(id, kind)}, ${sql.json(stash as never)}) on conflict (key) do update set value = excluded.value`;
    await this.audit('deriv.live.risk_change_prepared', { account: id, kind, hash: stash.hash, loosened });
    return { needed: true as const, kind, loosened, intent, hash: stash.hash, options: await this.options(hash), expiresAt: intent.expiresAt };
  }

  /** Step 2: the prepared intent, taken ONCE, must still describe the account; the assertion must verify over its hash. Returns the intent to apply. */
  private async takeRisk(a: AccountRow, kind: RiskIntent['kind'], assertion: unknown): Promise<RiskIntent> {
    const verify = this.deps.verifyOwner;
    if (!verify) throw new UserError('passkey_unavailable', 'this server cannot verify a passkey approval for a risk change: the change is refused', 503);
    if (assertion === undefined || assertion === null) throw new UserError('passkey_required', 'this change needs the owner\'s passkey: prepare it first, then approve', 403);
    const stash = await getSetting<RiskStash | null>(riskKey(a.id, kind), null);
    if (!stash) throw new UserError('bad_state', 'prepare this change first', 409);
    const i = stash.intent;
    if (hex(riskIntentHash(i)) !== stash.hash || i.kind !== kind || i.accountId !== a.id) throw new UserError('bad_state', 'the prepared change is not for this account', 409);
    if (this.now() >= i.expiresAt) { await sql`delete from settings where key = ${riskKey(a.id, kind)}`; throw new UserError('proposal_expired', 'the approval window of this change has expired: prepare it again', 410); }
    if (a.mode !== 'MANUAL_LIVE' || a.authorization_id !== i.authorizationId) throw new UserError('bad_state', 'the venue authorization changed since this change was prepared', 409);
    if (kind === 'resume' && a.halt !== i.subject) throw new UserError('bad_state', 'the halt changed since its lifting was prepared: prepare it again', 409);
    if (kind === 'rebase' && a.divergence !== i.subject) throw new UserError('bad_state', 'the divergence changed since the re-base was prepared: prepare it again', 409);
    try { await verify(assertion, Buffer.from(stash.hash, 'hex')); }
    catch (e) {
      await this.audit('deriv.live.risk_change_refused', { account: a.id, kind, hash: stash.hash, reason: msg(e) });
      throw new UserError('bad_approval', `the passkey approval of this change did not verify (${msg(e)}); nothing changed`, 403);
    }
    // single use: only the caller that removes the stored intent applies it
    const taken = await sql`delete from settings where key = ${riskKey(a.id, kind)} and value->>'hash' = ${stash.hash} returning key`;
    if (!taken.length) throw new UserError('bad_state', 'this change was already applied or replaced', 409);
    return i;
  }

  /** a loosened policy, approved with the passkey: exactly the policy that was prepared is written */
  async approvePolicy(id: string, assertion: unknown) {
    const a = await this.account(id), i = await this.takeRisk(a, 'policy', assertion);
    this.checkPolicyBounds(a, i.policy!);
    return this.writePolicy(a, i.policy!, i.loosened, true);
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
  private async check(a: AccountRow, venue: LiveVenue, body: OrderBody, clientId: string, over: RiskPolicy | null = null, /** price band of the signer's rule; default: the authorization's */ bandBps?: number,
    who: Pick<PreTradeRequest, 'origin' | 'agentId' | 'mandateId' | 'preview'> = { origin: 'owner' }) {
    const inst = await venue.instrument(body.instrument);
    const read = async <T>(fn: () => Promise<T>): Promise<T> => { try { return await fn(); } catch (e) { if (e instanceof VenueError) throw new UserError('venue_unavailable', msg(e), 503); throw e; } };
    const [m, state, positions, openOrders, lev] = await Promise.all([venue.market(inst), read(() => venue.adapter.account(a.account)), read(() => venue.adapter.positions(a.account)),
      read(() => venue.adapter.openOrders(a.account)), venue.leverageOf(a.account, inst.symbol)]);
    const now = this.now(), { req, refusal } = this.request(body, inst, m.book, clientId);
    const policy: RiskPolicy = { ...RiskPolicySchema.parse(over ?? a.policy), halt: this.effectiveHalt(a) };
    let risk: RiskResult = refusal ?? checkOrder(policy, req, { instrument: inst, account: state, positions, openOrders, book: m.book, ticker: m.ticker, now, usage: await this.usage(a.id, now), leverage: lev.leverage });
    // the signer bounds EVERY order by its notional, reduce-only included (it cannot see positions): said here rather than at the passkey prompt
    const cap = a.venue_authorization?.policy.maxOrderNotional;
    if (risk.ok && cap && req.price !== null && D.gt(D.from(venueOrderNotional({ size: req.size, price: req.price, triggerPrice: req.triggerPrice })), D.from(cap))) {
      risk = { ok: false, code: 'order_notional_exceeded', reason: `order notional ${venueOrderNotional({ size: req.size, price: req.price, triggerPrice: req.triggerPrice })} exceeds the ${cap} the signer will sign per order (reduce-only orders included: close in smaller parts)` };
    }
    // V11 (B-07): the signer's price rule (venueOrderPriceError — the same function), applied here against the venue's mark so
    // that what the signer will refuse is refused BEFORE the passkey prompt. The signer applies it again with its own
    // Coinbase + Kraken mid: an order at the very edge of the band can still be refused there.
    const band = bandBps ?? a.venue_authorization?.policy.maxPriceDeviationBps;
    if (risk.ok && band !== undefined && req.price !== null) {
      const type = (req.type === 'market' ? 'limit' : req.type) as VenueOrder['type'];
      const off = venueOrderPriceError({ side: req.side, type, price: req.price, triggerPrice: req.triggerPrice, reduceOnly: req.reduceOnly }, canon(m.ticker.mark), band);
      if (off) risk = { ok: false, code: 'price_deviation', reason: `${off.reason} the mark ${canon(m.ticker.mark)} (the signer applies this rule with its own price and would refuse the order)` };
    }
    // V11: the unified risk engine (every venue and account of the book, the owner's limits, the kill switch) — after this engine's own checks, before anything is stored for approval or signed
    if (risk.ok && this.preTrade) {
      const g = await this.preTrade({ mode: 'live', venue: a.venue, network: a.network, accountId: a.id, req, instrument: inst, ...who, known: { ticker: m.ticker, book: m.book, account: state, positions, leverage: lev.leverage } });
      if (!g.ok) risk = { ok: false, code: g.code as never, reason: g.reason };
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
    const a = await this.account(id), stop = this.blocked(a, body.reduceOnly ? 'reduce' : 'trade');
    if (stop) throw stop;
    const venue = this.deps.venues.get(a.network);
    await venue.assertPinned([body.instrument]);
    const c = await this.check(a, venue, body, 'preview', null, undefined, { origin: 'owner', preview: true });
    return { risk: c.risk, estimate: this.estimate(c), request: c.req, venueState: { state: c.state, positions: c.positions, source: 'venue' as const }, ts: c.now };
  }

  /**
   * Proposal. `key` is the Idempotency-Key = the order's client id; the venue's client order id (cloid) is derived from it, so a
   * retry — of this call, of the approval, or of the submission — can never place a second order.
   */
  async propose(id: string, body: OrderBody, key: string, origin: 'owner' | 'close' = 'owner') {
    // a duplicate that arrives while the first call is still building waits for it, then answers the built proposal
    const k = `${id}|${key}`, running = this.building.get(k);
    if (running) {
      await running.catch(() => {});
      // (when the first call failed before storing anything — a lock, an unreadable venue — this one simply runs)
      const [built] = await sql`select client_id from deriv_orders where account_id = ${id} and client_id = ${key}`;
      if (built) return this.proposalAnswer(await this.settledRow(id, key), true);
    }
    const p = this.proposeOnce(id, body, key, origin);
    this.building.set(k, p);
    try { return await p; } finally { if (this.building.get(k) === p) this.building.delete(k); }
  }

  /** the stored order of an idempotency key, once it is no longer half-built (`proposed` is the state of a proposal being built — by this process or another) */
  private async settledRow(id: string, key: string): Promise<Row> {
    for (let k = 0; ; k++) {
      const [row] = await sql`select * from deriv_orders where account_id = ${id} and client_id = ${key}`;
      if (!row) throw new UserError('unknown_order', 'unknown order', 404);
      if (row.state !== 'proposed' || k >= 40 || this.now() - (row.created_at as Date).getTime() > 30_000) return row;
      await new Promise((res) => setTimeout(res, 50));
    }
  }

  private async proposeOnce(id: string, body: OrderBody, key: string, origin: 'owner' | 'close') {
    const a = await this.account(id);
    const [prior] = await sql`select * from deriv_orders where account_id = ${id} and client_id = ${key}`;
    if (prior) return this.proposalAnswer(await this.settledRow(id, key), true);
    const stop = this.blocked(a, body.reduceOnly ? 'reduce' : 'trade');
    if (stop) throw stop;
    const venue = this.deps.venues.get(a.network);
    await venue.assertPinned([body.instrument]);
    const c = await this.check(a, venue, body, key, null, undefined, { origin }), { req, inst, now } = c, at = new Date(now);
    const ins = await sql`insert into deriv_orders (account_id, client_id, cloid, instrument, side, type, size, price, trigger_price, reduce_only, tif, status, state, origin, created_at, updated_at)
      values (${id}, ${key}, ${hlCloid(key)}, ${req.instrument}, ${req.side}, ${req.type}, ${req.size}, ${req.price}, ${req.triggerPrice}, ${req.reduceOnly}, ${req.tif}, 'pending', 'proposed', ${origin}, ${at}, ${at})
      on conflict (account_id, client_id) do nothing returning client_id`;
    if (!ins.length) return this.proposalAnswer(await this.settledRow(id, key), true);
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
    const hash = venueOrderHash(canonical), estimate = this.estimate(c);
    const [row] = await sql`update deriv_orders set state = 'risk_checked', request = ${sql.json(canonical as never)}, order_hash = ${hex(hash)}, nonce = ${nonce}, expires_at = ${new Date(canonical.expiresAt)},
      action = ${built.action as never}::json, sign_request = ${built.sign as never}::json, estimate = ${sql.json(estimate as never)}, updated_at = ${at} where account_id = ${id} and client_id = ${key} returning *`;
    await this.audit(origin === 'close' ? 'deriv.live.close_proposed' : 'deriv.live.order_proposed', { account: id, clientId: key, hash: hex(hash), instrument: canonical.instrument, side: canonical.side, type: canonical.type, size: canonical.size,
      price: canonical.price, triggerPrice: canonical.triggerPrice, reduceOnly: canonical.reduceOnly, tif: canonical.tif, nonce });
    this.emit(id, { event: 'order', data: this.orderView(row!) });
    return this.proposalAnswer(row!, false);
  }

  /** `estimate` is the one computed when the proposal was made (stored with it), also on an idempotent replay; null for a proposal that was refused */
  private async proposalAnswer(r: Row, idempotent: boolean, estimate: ReturnType<LiveService['estimate']> | null = (r.estimate as ReturnType<LiveService['estimate']> | null) ?? null) {
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
    const stop = this.blocked(a, row.reduce_only ? 'reduce' : 'trade');
    if (stop) throw stop;
    const halt = this.effectiveHalt(a);
    if (halt && !row.reduce_only) {
      // the proposal ends here: it must not stay approvable until its window closes
      await this.setOrder(id, key, { state: 'cancelled', final: true, reason: `withdrawn: trading was halted before the approval (${halt}); nothing was signed`.slice(0, 500) });
      throw new UserError('halted', `trading is halted: ${halt}`, 423);
    }
    // V11: the global kill switch (new risk) or read-only mode (everything but a cancel), engaged after the proposal was made
    const blk = this.newRiskBlock ? await this.newRiskBlock() : null;
    if (blk && (!row.reduce_only || blk.code === 'read_only_mode')) {
      await this.setOrder(id, key, { state: 'cancelled', final: true, reason: `withdrawn: trading was halted before the approval (${blk.code}); nothing was signed` });
      throw new UserError(blk.code, blk.reason, 423);
    }
    if (row.expires_at.getTime() <= this.now() + 2_000) {
      await this.setOrder(id, key, { state: 'cancelled', final: true, reason: 'the approval window expired before the passkey approval; nothing was signed' });
      throw new UserError('proposal_expired', 'this proposal has expired; propose the order again', 410);
    }
    const venue = this.deps.venues.get(a.network);
    try { await venue.assertPinned([row.instrument]); }
    catch (e) {
      if (e instanceof UserError && e.code === 'asset_table_mismatch') await this.setOrder(id, key, { state: 'cancelled', final: true, reason: `withdrawn: ${msg(e)}`.slice(0, 500) });
      throw e;
    }
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
      // the venue expiry sent with the action must be the one that was signed (manual: 90 s, mandate: 30 s after the nonce)
      const r = await venue.trading((row.expires_at as Date).getTime() - Number(row.nonce)).submit(row.action, signature, Number(row.nonce));
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
  private async act(a: AccountRow, venue: LiveVenue, kind: 'cancel' | 'leverage', request: Record<string, unknown>, built: { action: unknown; sign: SignRequest }, nonce: number, o: { id?: string; context?: unknown; assertion?: unknown; hash?: string; /** sign under this derivative mandate (no passkey) instead of the authorization */ mandateId?: string } = {}): Promise<{ row: Row; outcome: 'accepted' | 'refused' | 'unknown'; error: string | null }> {
    const id = o.id ?? randomUUID(), at = new Date(this.now());
    if (!o.id) await sql`insert into deriv_actions (id, account_id, kind, state, request, action_hash, nonce, expires_at, action, sign_request, created_at, updated_at)
      values (${id}, ${a.id}, ${kind}, 'authorized', ${sql.json(request as never)}, ${o.hash ?? null}, ${nonce}, ${new Date(nonce + LIVE_ACTION_TTL_MS)}, ${built.action as never}::json, ${built.sign as never}::json, ${at}, ${at})`;
    const set = async (state: string, error: string | null, extra: { signature?: unknown; answer?: unknown } = {}): Promise<Row> => {
      const [r] = await sql`update deriv_actions set state = ${state}, error = ${error}, signature = ${extra.signature === undefined ? sql`signature` : sql.json(extra.signature as never)},
        venue_answer = ${extra.answer === undefined ? sql`venue_answer` : sql.json((extra.answer ?? null) as never)}, updated_at = ${new Date(this.now())} where id = ${id} returning *`;
      this.emit(a.id, { event: 'action', data: this.actionView(r!) });
      return r!;
    };
    let signed: { signature: { r: string; s: string; v: number } };
    try {
      signed = o.mandateId ? await this.mandateSigner().venueMandateSign({ mandateId: o.mandateId, sign: built.sign })
        : await this.deps.signer.venueSign({ authorizationId: a.authorization_id!, sign: built.sign, ...(o.context ? { context: o.context } : {}), ...(o.assertion ? { assertion: o.assertion } : {}) });
    } catch (e) { await set('rejected', `not signed: ${msg(e)}`); throw e; }
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
    await venue.assertPinned([body.instrument]);
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
    this.emit(id, { event: 'status', data: { halt: text, halted: text, ts: now } });
    void a;
    return { ...(await this.get(id)), note: 'New orders are stopped. Resting orders are still on the venue (cancel-all is a separate action) and positions are still open (close is a separate action).' };
  }

  /** lifts an owner halt. A divergence is not lifted here: it clears when the venue and the records agree again, or when the owner re-bases them. */
  async resume(id: string, assertion?: unknown) {
    const a = await this.account(id);
    if (a.halt === null) return this.get(id);                                                // nothing to lift: no passkey asked for nothing
    // V11 (B-08): halting is free, lifting the halt needs the owner's passkey over the prepared intent (prepareRisk('resume'))
    await this.takeRisk(a, 'resume', assertion);
    await sql`update deriv_accounts set halt = null, updated_at = ${new Date(this.now())} where id = ${id}`;
    await this.riskEvent(id, 'resume', null, 'owner halt lifted');
    await this.audit('deriv.live.resume', { account: id });
    this.emit(id, { event: 'status', data: { halt: null, halted: this.effectiveHalt({ ...a, halt: null }), ts: this.now() } });
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
    const stop = this.blocked(a, 'reduce');
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
  async rebase(id: string, assertion?: unknown) {
    const a = await this.account(id), venue = this.deps.venues.get(a.network);
    // V11 (B-08): accepting the venue's positions lifts the divergence halt — it needs the owner's passkey like lifting his own halt
    await this.takeRisk(a, 'rebase', assertion);
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

  /**
   * V11 market making: while a quoting session runs on a venue account, its engine reconciles that account from the venue's
   * user streams (services/api/src/mm/user-stream.ts). This background loop then reads the account at most every `everyMs`
   * instead of every pass — its reads (account, positions, open orders, fills) cost IP weight the session needs. Orders placed
   * through this engine are reconciled when they are placed, as before; null removes the pacing.
   */
  setStepPacing(accountId: string, everyMs: number | null): void { if (everyMs === null) this.pacing.delete(accountId); else this.pacing.set(accountId, { everyMs, last: this.pacing.get(accountId)?.last ?? -Infinity }); }
  private readonly pacing = new Map<string, { everyMs: number; last: number }>();
  async step(): Promise<StepSummary> {
    const s: StepSummary = { accounts: 0, reconciled: 0, fills: 0, funding: 0, divergences: 0, errors: [] };
    for (const id of await this.active()) {
      const pace = this.pacing.get(id);
      if (pace) { if (this.now() - pace.last < pace.everyMs) continue; pace.last = this.now(); }
      s.accounts += 1;
      try { const r = await this.reconcile(id); s.reconciled += r.reconciled; s.fills += r.fills; s.funding += r.funding; if (r.divergence) s.divergences += 1; }
      catch (e) { s.errors.push(`account ${id}: ${msg(e)}`); this.emit(id, { event: 'status', data: { error: msg(e), ts: this.now() } }); }
    }
    return s;
  }

  // ------------------------------------------------------------------ MANDATE_LIVE: a derivative mandate on top of the authorization
  //
  // The account keeps `mode: 'MANUAL_LIVE'` (manual orders still need the passkey, exactly as before); an active mandate adds
  // `MANDATE_LIVE` to `modes`. A mandate order goes through the same pipeline as a manual one — live data, the venue's real
  // state, the risk engine, a stored order, the signer, the venue, reconciliation by client order id — with one difference: the
  // signer is asked through /venue/mandate/sign, which needs no passkey and enforces the mandate's limits itself.

  private mandateSigner(): MandateSignerPort {
    const s = this.deps.mandateSigner;
    if (!s) throw new UserError('mandate_unavailable', liveReason('mandate_unavailable'), 503);
    return s;
  }
  /** the two mainnet locks of autonomous trading; null = open */
  private mandateLock(a: AccountRow): UserError | null {
    if (a.network !== 'mainnet') return null;
    if (!this.deps.mainnetEnabled()) return new UserError('mainnet_disabled', MAINNET_OFF, 403);
    if (!(this.deps.mandateMainnetEnabled?.() ?? false)) return new UserError('mandate_mainnet_disabled', liveReason('mandate_mainnet_disabled'), 403);
    return null;
  }
  /** the mandate that governs the account now (the last one approved), with its phase as the signer will see it */
  private async currentMandate(a: AccountRow): Promise<{ row: MandateRow; phase: VenueMandatePhase; windDownUntil: number | null } | null> {
    const [row] = await sql<MandateRow[]>`select * from deriv_mandates where account_id = ${a.id} and state in ('active', 'revoked') order by approved_at desc limit 1`;
    if (!row) return null;
    const now = Math.floor(this.now() / 1000), ph = venueMandatePhase(row.mandate, row.revoked_at ? Math.floor(row.revoked_at.getTime() / 1000) : null, now);
    // the authorization is the root: when it is gone the mandate signs nothing, whatever its own dates say
    const rootAlive = a.mode === 'MANUAL_LIVE' && a.authorization_id === row.authorization_id && !!a.venue_authorization && now < a.venue_authorization.expiresAt;
    return { row, phase: rootAlive ? ph.phase : 'ended', windDownUntil: ph.windDownUntil === null ? null : ph.windDownUntil * 1000 };
  }
  private async mandateInfo(a: AccountRow) {
    const cur = await this.currentMandate(a), [prep] = await sql<MandateRow[]>`select * from deriv_mandates where account_id = ${a.id} and state = 'prepared' order by prepared_at desc limit 1`;
    const m = cur?.row.mandate;
    return {
      /** every mode the account is in: MANDATE_LIVE is added to MANUAL_LIVE while a mandate is active (manual orders still need the passkey) */
      modes: (a.mode === 'MANUAL_LIVE' && cur?.phase === 'active' ? ['MANUAL_LIVE', 'MANDATE_LIVE'] : [a.mode]) as string[],
      mandate: cur && m ? { id: m.mandateId, hash: cur.row.hash, authorizationId: m.authorizationId, agentId: m.agentId, strategySha256: m.strategySha256, limits: m,
        phase: cur.phase, active: cur.phase === 'active', createdAt: m.createdAt * 1000, expiresAt: m.expiresAt * 1000, expired: this.now() >= m.expiresAt * 1000, approvedAt: cur.row.approved_at?.getTime() ?? null,
        revokedAt: cur.row.revoked_at?.getTime() ?? null, windDownUntil: cur.windDownUntil, ackSha256: m.ackSha256 } : null,
      pendingMandate: prep ? { mandateId: prep.mandate.mandateId, preparedAt: prep.prepared_at.getTime() } : null,
    };
  }

  /** step 1: the canonical mandate, the acknowledgement text to DISPLAY again, what the signer will enforce, and the WebAuthn request */
  async prepareMandate(id: string, body: z.infer<typeof MandateBodySchema>) {
    const a = await this.account(id);
    this.mandateSigner();
    const lock = this.mandateLock(a) ?? this.blocked(a, 'trade');
    if (lock) throw lock;
    const auth = a.venue_authorization!;
    const st = await this.deps.signer.status(true);
    if (st.halted) throw new UserError('halted', 'emergency halt is active', 423);
    if ((await this.currentMandate(a))?.phase === 'active') throw new UserError('bad_state', 'a mandate is already active on this venue account: revoke it to change its limits', 409);
    await this.deps.venues.get(a.network).assertPinned();
    const nowMs = this.now(), nowS = Math.floor(nowMs / 1000), ack = jurisdictionAck('hyperliquid', body.locale);
    const mandate: VenueMandate = { v: 1, mandateId: randomUUID(), authorizationId: a.authorization_id!, keyId: auth.keyId, venue: 'hyperliquid', network: a.network, account: a.account, agentAddress: a.agent_address,
      strategySha256: body.strategySha256, agentId: body.agentId, instruments: body.instruments, maxOrderNotional: body.maxOrderNotional, maxGrossExposure: body.maxGrossExposure, maxOrdersPerDay: body.maxOrdersPerDay,
      maxOrdersPerHour: body.maxOrdersPerHour, maxDailyTurnover: body.maxDailyTurnover, floorEquity: body.floorEquity, maxPriceDeviationBps: body.maxPriceDeviationBps ?? auth.policy.maxPriceDeviationBps,
      createdAt: nowS, expiresAt: nowS + body.days * 86400, ackSha256: ack.sha256 };
    return this.storePrepared(a, mandate, body.locale);
  }

  /** the tail of both preparations: validation against the authorization and the pinned table, the stored `prepared` row, what is shown, the WebAuthn request */
  private async storePrepared(a: AccountRow, mandate: VenueMandate, locale: LiveLocale) {
    const id = a.id, auth = a.venue_authorization!, nowMs = this.now(), nowS = Math.floor(nowMs / 1000), ack = jurisdictionAck('hyperliquid', locale), body = { locale };
    if (mandate.ackSha256 !== ack.sha256) throw new UserError('bad_policy', 'the mandate does not carry the acknowledgement that is displayed', 400);
    try { validateVenueMandate(mandate, auth, nowS); } catch (e) { throw new UserError('bad_policy', msg(e), 400); }
    for (const i of mandate.instruments) { const pin = hlPinnedAsset(a.network, i.instrument); if (!pin || i.maxLeverage > pin.maxLeverage) throw new UserError('bad_policy', `${i.instrument}: not in the pinned ${a.network} asset table, or leverage above the venue maximum`, 400); }
    const hash = venueMandateHash(mandate), at = new Date(nowMs);
    await sql`delete from deriv_mandates where account_id = ${id} and state = 'prepared'`;
    await sql`insert into deriv_mandates (id, account_id, authorization_id, state, mandate, hash, ack, prepared_at, created_at, updated_at)
      values (${mandate.mandateId}, ${id}, ${mandate.authorizationId}, 'prepared', ${sql.json(mandate as never)}, ${hex(hash)}, ${sql.json({ locale: ack.locale, sha256: ack.sha256, version: ack.version } as never)}, ${at}, ${at}, ${at})`;
    const v = await this.venueState(a), t = liveTexts(body.locale);
    return {
      mandate, hash: hex(hash), acknowledgement: ack, locale: body.locale,
      authorization: { id: a.authorization_id!, hash: a.authorization_hash, expiresAt: auth.expiresAt * 1000, policy: auth.policy },
      warning: t.mandateWarning, enforcedBySigner: t.enforcedBySigner, trustedBySigner: t.trustedBySigner, notEnforced: t.notEnforced,
      windDown: { seconds: VENUE_MANDATE_WIND_DOWN_S, text: t.windDown }, whatIsSigned: { byPasskey: t.mandateByPasskey },
      venueState: v, options: await this.options(hash), ts: nowMs,
    };
  }

  /**
   * V11 trading mandates: what a trading mandate needs to be compiled for this venue account (`compileToVenueMandate` of
   * @spw/trading) — the authorization the owner approved and the acknowledgement that will be displayed. Reads only.
   */
  async mandateBinding(id: string, locale: LiveLocale = 'en') {
    const a = await this.account(id);
    this.mandateSigner();
    const lock = this.mandateLock(a) ?? this.blocked(a, 'trade');
    if (lock) throw lock;
    return { accountId: a.id, venue: a.venue, network: a.network, account: a.account, authorization: a.venue_authorization!, authorizationId: a.authorization_id!, ack: jurisdictionAck('hyperliquid', locale) };
  }

  /**
   * V11 trading mandates: step 1 of the SAME approval flow for a derivative mandate that was compiled from a trading mandate
   * (same id, same creation time). Nothing is taken on trust from the caller: the mandate must be for this account and its
   * authorization, pass `validateVenueMandate` and the pinned asset table, exactly like one built by `prepareMandate`.
   */
  async prepareCompiledMandate(id: string, mandate: VenueMandate, locale: LiveLocale = 'en') {
    const a = await this.account(id);
    this.mandateSigner();
    const lock = this.mandateLock(a) ?? this.blocked(a, 'trade');
    if (lock) throw lock;
    const st = await this.deps.signer.status(true);
    if (st.halted) throw new UserError('halted', 'emergency halt is active', 423);
    if ((await this.currentMandate(a))?.phase === 'active') throw new UserError('bad_state', 'a mandate is already active on this venue account: revoke it to change its limits', 409);
    await this.deps.venues.get(a.network).assertPinned();
    const m = VenueMandateSchema.parse(mandate), auth = a.venue_authorization!;
    if (m.authorizationId !== a.authorization_id || m.keyId !== auth.keyId || m.network !== a.network || m.account !== a.account || m.agentAddress !== a.agent_address) throw new UserError('bad_policy', 'the compiled mandate is not for this venue account and its authorization', 400);
    return this.storePrepared(a, m, locale);
  }

  /** step 2: the signer judges the passkey and stores the mandate. No key signs anything here, and nothing is sent to the venue. */
  async approveMandate(id: string, body: z.infer<typeof ApproveMandateSchema>) {
    const a = await this.account(id), ms = this.mandateSigner();
    const lock = this.mandateLock(a) ?? this.blocked(a, 'trade');
    if (lock) throw lock;
    const [taken] = await sql<MandateRow[]>`update deriv_mandates set state = 'consumed', updated_at = ${new Date(this.now())} where account_id = ${id} and state = 'prepared' returning *`;   // a mandate is approved once
    if (!taken) throw new UserError('bad_state', 'prepare the mandate first', 409);
    const m = taken.mandate;
    let r: Awaited<ReturnType<MandateSignerPort['venueMandateApprove']>>;
    try { r = await ms.venueMandateApprove(m, body.assertion); }
    catch (e) {
      await sql`update deriv_mandates set state = 'failed', updated_at = ${new Date(this.now())} where id = ${m.mandateId}`;
      await this.audit('deriv.live.mandate_refused', { account: id, mandateId: m.mandateId, reason: msg(e) });
      throw e;
    }
    const now = new Date(this.now());
    await sql`update deriv_mandates set state = 'active', approved_at = ${now}, updated_at = ${now} where id = ${m.mandateId}`;
    await this.audit('deriv.live.mandate_acknowledged', { account: id, mandateId: m.mandateId, mandateHash: r.hash, ackSha256: taken.ack.sha256, locale: taken.ack.locale, version: taken.ack.version,
      statement: 'the owner confirmed again with his passkey having read the jurisdiction summary; letting an automated strategy trade derivatives on this venue inside the mandate is his own decision' });
    await this.audit('deriv.live.mandate_approved', { account: id, venue: a.venue, network: a.network, mandateId: m.mandateId, hash: r.hash, authorizationId: m.authorizationId, strategySha256: m.strategySha256, agentId: m.agentId,
      instruments: m.instruments, maxOrderNotional: m.maxOrderNotional, maxGrossExposure: m.maxGrossExposure, maxOrdersPerDay: m.maxOrdersPerDay, maxOrdersPerHour: m.maxOrdersPerHour, maxDailyTurnover: m.maxDailyTurnover,
      floorEquity: m.floorEquity, maxPriceDeviationBps: m.maxPriceDeviationBps, expiresAt: m.expiresAt });
    this.emit(id, { event: 'status', data: { mode: a.mode, modes: ['MANUAL_LIVE', 'MANDATE_LIVE'], mandate: m.mandateId, ts: now.getTime() } });
    return this.get(id);
  }

  /**
   * Stops the mandate — no passkey. On the signer first (no new exposure from that instant), then, if asked, cancel-all. Positions
   * are NOT closed: during the wind-down the engine may still close them with reduce-only orders, and the owner can close with his passkey.
   */
  async revokeMandate(id: string, body: { cancelOpenOrders: boolean; locale?: LiveLocale }) {
    const a = await this.account(id), ms = this.mandateSigner(), cur = await this.currentMandate(a);
    if (!cur) throw new UserError('bad_state', 'this venue account has no mandate', 409);
    const now = new Date(this.now());
    let windDownUntil = cur.windDownUntil;
    if (cur.row.state === 'active') {
      const r = await ms.venueMandateRevoke(cur.row.id);
      windDownUntil = r.windDownUntil * 1000;
      await sql`update deriv_mandates set state = 'revoked', revoked_at = ${now}, updated_at = ${now} where id = ${cur.row.id} and state = 'active'`;
      await this.audit('deriv.live.mandate_revoked', { account: id, mandateId: cur.row.id, windDownUntil });
      await this.riskEvent(id, 'mandate_revoked', null, 'the derivative mandate was revoked: no order that can add exposure is signed any more', { mandateId: cur.row.id, windDownUntil });
    }
    let cancelled: Awaited<ReturnType<LiveService['cancelAll']>> | null = null, cancelError: { code: string; message: string } | null = null;
    if (body.cancelOpenOrders) {
      try { cancelled = await this.cancelAll(id); }
      catch (e) { cancelError = { code: e instanceof UserError ? e.code : 'internal', message: msg(e) }; }
    }
    const v = await this.venueState(a);
    this.emit(id, { event: 'status', data: { mode: a.mode, modes: [a.mode], mandate: null, ts: now.getTime() } });
    return { ...(await this.get(id)), cancelled, cancelError, locale: body.locale ?? 'en',
      windDown: { until: windDownUntil, text: liveTexts(body.locale ?? 'en').windDown, openPositions: v.positions.length, openOrders: v.openOrders.length } };
  }

  /** the mandate as the API holds it, and the signer's own record of it (counters of the day, phase) */
  async mandateStatus(id: string) {
    const a = await this.account(id), info = await this.mandateInfo(a);
    const st = info.mandate ? await this.deps.signer.status(true).catch(() => null) as { venueMandates?: { mandate: { mandateId: string } }[] } | null : null;
    return { ...info, signer: st?.venueMandates?.find((x) => x.mandate.mandateId === info.mandate!.id) ?? null, ts: this.now() };
  }

  /** the API-side risk policy of a mandate order: the account's policy, tightened by the mandate — never wider than either */
  private mandatePolicy(a: AccountRow, m: VenueMandate, instrument: string): RiskPolicy {
    const p = RiskPolicySchema.parse(a.policy), min = (x: DecStr, y: DecStr): DecStr => D.str(D.min(D.from(x), D.from(y))), mi = m.instruments.find((i) => i.instrument === instrument);
    return { ...p, allowedInstruments: p.allowedInstruments.filter((i) => m.instruments.some((x) => x.instrument === i)), maxOrderNotional: min(p.maxOrderNotional, m.maxOrderNotional),
      maxPositionNotional: mi ? min(p.maxPositionNotional, mi.maxPositionNotional) : p.maxPositionNotional, maxGrossExposure: min(p.maxGrossExposure, m.maxGrossExposure),
      maxDeviationBps: min(p.maxDeviationBps, String(m.maxPriceDeviationBps)), maxOrdersPerDay: Math.min(p.maxOrdersPerDay, m.maxOrdersPerDay) };
  }

  /**
   * ONE order placed by an approved automated strategy, without a passkey. Server-side only: there is no HTTP route to it.
   * `ctx.clientId` is the idempotency key (the venue's client order id is derived from it): calling again with the same key
   * never places a second order, it returns the first one as the venue reports it now. Returns the reconciled order.
   * Refusals are UserErrors with a stable code: the risk engine's codes, `signer_<code>` for the signer's, and mandate_none,
   * mandate_mismatch, mandate_wind_down, mandate_floor_equity, mandate_mainnet_disabled, mainnet_disabled, halted, …
   */
  async placeMandateOrder(id: string, req: OrderRequest, ctx: MandateOrderCtx) {
    const c = MandateOrderCtxSchema.parse(ctx), k = `${id}|${c.clientId}`, running = this.building.get(k);
    if (running) { await running.catch(() => {}); const again = await this.placeMandateOrderReplay(id, c.clientId); if (again) return again; }
    const p = this.placeMandateOnce(id, req, c);
    this.building.set(k, p);
    try { return await p; } finally { if (this.building.get(k) === p) this.building.delete(k); }
  }

  async placeMandateOrderReplay(id: string, key: string) {
    const [row] = await sql`select * from deriv_orders where account_id = ${id} and client_id = ${key}`;
    if (!row) return null;
    if (row.origin !== 'mandate') throw new UserError('idempotency', 'this client id belongs to an order that was not placed under the mandate', 409);
    const a = await this.account(id);
    const now = row.final ? row : (await this.reconcileOrder(a, this.deps.venues.get(a.network), key).catch(() => null)) ?? row;
    return { order: this.orderView(now), idempotent: true, estimate: (row.estimate ?? null) as ReturnType<LiveService['estimate']> | null };
  }

  private async placeMandateOnce(id: string, req: OrderRequest, c: MandateOrderCtx) {
    const key = c.clientId, prior = await this.placeMandateOrderReplay(id, key);
    if (prior) return prior;
    const a = await this.account(id), ms = this.mandateSigner();
    const parsed = OrderRequestSchema.safeParse({ ...req, clientId: key });      // the idempotency key is ctx.clientId; req.clientId is ignored
    // V11 (B-02): the two mainnet locks stop orders that can add exposure; a reduce-only order — the agent's way out — passes them
    const lock = parsed.success && parsed.data.reduceOnly ? this.blocked(a, 'reduce') : this.mandateLock(a) ?? this.blocked(a, 'trade');
    if (lock) throw lock;
    const cur = await this.currentMandate(a);
    if (!cur || cur.phase === 'ended') throw new UserError('mandate_none', 'no derivative mandate is in force on this venue account: the owner approves one with his passkey', 422);
    const m = cur.row.mandate;
    if (c.strategySha256 !== m.strategySha256 || c.agentId !== m.agentId) throw new UserError('mandate_mismatch', 'the mandate was approved for another strategy version or another agent', 422);
    if (!parsed.success || parsed.data.price === null) throw new UserError('bad_request', 'a mandate order is a complete order request and names its price (limit price, or worst acceptable price for a market order)', 400);
    const r0 = parsed.data;
    if (cur.phase === 'wind_down' && !r0.reduceOnly) throw new UserError('mandate_wind_down', `the mandate ${cur.row.state === 'revoked' ? 'was revoked' : 'has expired'}: only cancels and reduce-only orders are placed until the wind-down ends`, 422);
    const venue = this.deps.venues.get(a.network);
    await venue.assertPinned([r0.instrument]);
    const body = OrderBodySchema.parse({ instrument: r0.instrument, side: r0.side, type: r0.type, size: r0.size, price: r0.price, triggerPrice: r0.triggerPrice, reduceOnly: r0.reduceOnly, tif: r0.tif });
    const chk = await this.check(a, venue, body, key, this.mandatePolicy(a, m, r0.instrument), m.maxPriceDeviationBps, { origin: 'mandate', agentId: c.agentId, mandateId: m.mandateId }), { req: order, inst, now } = chk, at = new Date(now);
    let refusal: { code: string; reason: string } | null = chk.risk.ok ? null : { code: chk.risk.code, reason: chk.risk.reason };
    const notional = order.price === null ? null : venueOrderNotional({ size: order.size, price: order.price, triggerPrice: order.triggerPrice });
    // what the signer will refuse is said here first, from the venue state the API just read
    if (!refusal && !m.instruments.some((i) => i.instrument === order.instrument)) refusal = { code: 'instrument_not_allowed', reason: `${order.instrument} is not allowed by the mandate` };
    if (!refusal && notional !== null && D.gt(D.from(notional), D.from(m.maxOrderNotional))) refusal = { code: 'order_notional_exceeded', reason: `order notional ${notional} exceeds the mandate's ${m.maxOrderNotional} per order (reduce-only orders included: close in smaller parts)` };
    if (!refusal && !order.reduceOnly && D.lt(D.from(chk.state.equity), D.from(m.floorEquity))) refusal = { code: 'mandate_floor_equity', reason: `account value ${chk.state.equity} is below the mandate's floor ${m.floorEquity}: only cancels and reduce-only orders` };
    const agent = { mandateId: m.mandateId, agentId: c.agentId, strategySha256: c.strategySha256 };
    const ins = await sql`insert into deriv_orders (account_id, client_id, cloid, instrument, side, type, size, price, trigger_price, reduce_only, tif, status, state, origin, mandate_id, agent, created_at, updated_at)
      values (${id}, ${key}, ${hlCloid(key)}, ${order.instrument}, ${order.side}, ${order.type}, ${order.size}, ${order.price}, ${order.triggerPrice}, ${order.reduceOnly}, ${order.tif}, 'pending', 'proposed', 'mandate', ${m.mandateId}, ${sql.json(agent as never)}, ${at}, ${at})
      on conflict (account_id, client_id) do nothing returning client_id`;
    if (!ins.length) { const again = await this.placeMandateOrderReplay(id, key); if (again) return again; throw new UserError('idempotency', 'this client id is in use', 409); }
    const refuse = async (code: string, reason: string, status = 422): Promise<never> => {
      await this.setOrder(id, key, { state: 'rejected', final: true, reason: `${code}: ${reason}`.slice(0, 500) });
      await this.riskEvent(id, 'order_refused', code, reason, { clientId: key, instrument: order.instrument, side: order.side, type: order.type, size: order.size, price: order.price, reduceOnly: order.reduceOnly, origin: 'mandate', ...agent });
      throw new UserError(code, reason, status);
    };
    if (refusal) await refuse(refusal.code, refusal.reason);
    const trading = venue.trading(MANDATE_ACTION_TTL_MS), nonce = await this.nextNonce(id);
    let built: ReturnType<typeof trading.buildOrder>, canonical: VenueOrder;
    try {
      built = trading.buildOrder(order, { instrument: inst, nonce });
      const norm = trading.normalizeRequest(order, inst);
      canonical = { v: 1, authorizationId: a.authorization_id!, venue: 'hyperliquid', network: a.network, account: a.account, kind: 'order', instrument: norm.instrument, side: norm.side, type: norm.type as VenueOrder['type'],
        size: norm.size, price: norm.price!, triggerPrice: norm.triggerPrice, reduceOnly: norm.reduceOnly, tif: norm.tif, clientId: norm.clientId, nonce, expiresAt: nonce + MANDATE_ACTION_TTL_MS };
    } catch (e) { return refuse('venue_rejected', msg(e)); }
    const hash = venueOrderHash(canonical), estimate = this.estimate(chk);
    // no approval step: the mandate is the authorization. `authorized` = handed to the signer, which decides.
    const [row] = await sql`update deriv_orders set state = 'authorized', request = ${sql.json(canonical as never)}, order_hash = ${hex(hash)}, nonce = ${nonce}, expires_at = ${new Date(canonical.expiresAt)},
      action = ${built.action as never}::json, sign_request = ${built.sign as never}::json, estimate = ${sql.json(estimate as never)}, updated_at = ${at} where account_id = ${id} and client_id = ${key} and state = 'proposed' returning *`;
    // withdrawn meanwhile by a halt or a revocation (they end every proposal that is not yet with the signer): nothing is signed
    if (!row) { const [cur] = await sql`select * from deriv_orders where account_id = ${id} and client_id = ${key}`; return { order: this.orderView(cur!), idempotent: false, estimate: null }; }
    await this.audit('deriv.live.mandate_order', { account: id, clientId: key, hash: hex(hash), instrument: canonical.instrument, side: canonical.side, type: canonical.type, size: canonical.size, price: canonical.price,
      triggerPrice: canonical.triggerPrice, reduceOnly: canonical.reduceOnly, tif: canonical.tif, nonce, ...agent }, `agent:${c.agentId}`);
    this.emit(id, { event: 'order', data: this.orderView(row!) });
    let signed: Awaited<ReturnType<MandateSignerPort['venueMandateSign']>>;
    try { signed = await ms.venueMandateSign({ mandateId: m.mandateId, sign: built.sign, context: { order: canonical } }); }
    catch (e) {
      // refused, or unreachable: either way no signature came back, so nothing can have been sent
      await this.setOrder(id, key, { state: 'rejected', final: true, reason: `not signed: ${msg(e)}` });
      await this.riskEvent(id, 'order_refused', e instanceof UserError ? e.code : 'signer', `the signer did not sign the mandate order: ${msg(e)}`, { clientId: key, origin: 'mandate', ...agent });
      throw e;
    }
    await this.setOrder(id, key, { state: 'signed', signature: signed.signature });
    await this.submit(a, venue, row!, signed.signature);
    const final = await this.reconcileOrder(a, venue, key).catch(() => null);
    const [now2] = await sql`select * from deriv_orders where account_id = ${id} and client_id = ${key}`;
    return { order: this.orderView(final ?? now2!), idempotent: false, estimate: estimate as ReturnType<LiveService['estimate']> | null };
  }

  /**
   * The leverage setting of one instrument, changed under the mandate — no passkey. The signer signs it only at or below the
   * mandate's leverage for that instrument, and never when it would change the margin mode of an open position. The venue's
   * own setting decides the outcome (`venue.confirmed`).
   */
  async setMandateLeverage(id: string, body: z.infer<typeof LeverageBodySchema>, ctx: Pick<MandateOrderCtx, 'strategySha256' | 'agentId'>) {
    const a = await this.account(id);
    const lock = this.mandateLock(a) ?? this.blocked(a, 'trade');
    if (lock) throw lock;
    const cur = await this.currentMandate(a);
    if (!cur || cur.phase !== 'active') throw new UserError(cur?.phase === 'wind_down' ? 'mandate_wind_down' : 'mandate_none', 'no derivative mandate is active on this venue account', 422);
    const m = cur.row.mandate, mi = m.instruments.find((i) => i.instrument === body.instrument);
    if (ctx.strategySha256 !== m.strategySha256 || ctx.agentId !== m.agentId) throw new UserError('mandate_mismatch', 'the mandate was approved for another strategy version or another agent', 422);
    const halt = this.effectiveHalt(a);
    if (halt) throw new UserError('halted', `trading is halted: ${halt}`, 423);
    if (!mi) throw new UserError('instrument_not_allowed', `${body.instrument} is not allowed by the mandate`, 422);
    if (body.leverage > mi.maxLeverage) throw new UserError('leverage_exceeded', `leverage ${body.leverage} is above the mandate's ${mi.maxLeverage} for ${body.instrument}`, 422);
    const venue = this.deps.venues.get(a.network);
    await venue.assertPinned([body.instrument]);
    const inst = await venue.instrument(body.instrument);
    if (!inst.marginModes.includes(body.marginMode)) throw new UserError('venue_rejected', `${inst.id} does not offer ${body.marginMode} margin`, 422);
    const nonce = await this.nextNonce(id);
    let built: { action: unknown; sign: SignRequest };
    try { built = venue.trading().buildUpdateLeverage({ instrument: inst, leverage: body.leverage, marginMode: body.marginMode, nonce }); } catch (e) { throw new UserError('venue_rejected', msg(e), 422); }
    const request = { instrument: inst.id, leverage: body.leverage, marginMode: body.marginMode, mandateId: m.mandateId, agentId: ctx.agentId, strategySha256: ctx.strategySha256 };
    const r = await this.act(a, venue, 'leverage', request, built, nonce, { mandateId: m.mandateId });
    const now = await venue.leverageOf(a.account, inst.symbol).catch(() => null);
    const confirmed = now !== null && now.leverage === String(body.leverage) && now.marginMode === body.marginMode;
    const state = confirmed ? 'confirmed' : r.outcome === 'refused' ? 'rejected' : 'unknown';
    const [row] = await sql`update deriv_actions set state = ${state}, updated_at = ${new Date(this.now())} where id = ${r.row.id} returning *`;
    await this.audit('deriv.live.mandate_leverage', { account: id, action: r.row.id, ...request, state, error: r.error }, `agent:${ctx.agentId}`);
    this.emit(id, { event: 'action', data: this.actionView(row!) });
    return { action: this.actionView(row!), venue: { leverage: now, confirmed, source: 'venue' as const } };
  }

  /** what an automated strategy needs to decide: the venue's own account state, positions and open orders, and whether it may trade */
  async mandateAccountState(id: string) {
    const a = await this.account(id), info = await this.mandateInfo(a), v = await this.venueState(a), halted = this.effectiveHalt(a), lock = this.mandateLock(a) ?? this.blocked(a, 'trade'), exitLock = this.blocked(a, 'reduce');
    const phase = info.mandate?.phase ?? null;
    return { accountId: a.id, venue: a.venue, network: a.network, account: a.account, mode: a.mode, modes: info.modes, mandate: info.mandate,
      /** may an order that ADDS exposure be placed right now? (reduce-only orders also pass while halted and during the wind-down) */
      canOpen: lock === null && phase === 'active' && halted === null && v.error === null, canReduce: exitLock === null && (phase === 'active' || phase === 'wind_down'),
      blocked: lock ? { code: lock.code, message: lock.message } : null, halted, divergence: a.divergence,
      state: v.state, positions: v.positions, openOrders: v.openOrders, error: v.error, ts: v.ts, source: 'venue' as const };
  }
}
