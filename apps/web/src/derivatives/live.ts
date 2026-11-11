/**
 * Controlled LIVE trading — typed client of `/api/v1/derivatives/live` and the pure helpers of the live screens.
 * Binding reference: docs/v4/API-LIVE-NOTES.md (routes, objects, error codes); truth for shapes: services/api/src/derivatives/
 * {live-routes,exec}.ts. Nothing here signs anything: a passkey assertion is produced by the browser and passed on untouched.
 *
 * Rules this file keeps for the screens:
 *  - sizes and prices leave as the decimal strings the form produced (never through a JS number);
 *  - ONE Idempotency-Key per review (`newKey`), reused on a retry of the same review, never reused for another order;
 *  - what the passkey is asked to sign must be the order that was asked for (`canonicalProblem`), and must not be about to
 *    expire (`remainingMs`).
 */
import { ApiError, get, post } from '../api';
import { D, dec, onTick, parseInput, worstPrice } from './dec';
import type { AccountState, DecStr, Fill, Instrument, Order, OrderBody, OrderRequest, Position, RiskPolicy, RiskResult } from './types';

export type LiveNetwork = 'testnet' | 'mainnet';
// >>> v7 perp live: MANDATE_LIVE objects (docs/v4/API-LIVE-NOTES.md, section V6)
export type LiveLocale = 'fr' | 'en';
export interface MandateInstrument { instrument: string; maxLeverage: number; maxPositionNotional: DecStr }
export interface VenueMandate { v: 1; mandateId: string; authorizationId: string; keyId: string; venue: 'hyperliquid'; network: LiveNetwork; account: string; agentAddress: string; strategySha256: string; agentId: string;
  instruments: MandateInstrument[]; maxOrderNotional: DecStr; maxGrossExposure: DecStr; maxOrdersPerDay: number; maxOrdersPerHour: number; maxDailyTurnover: DecStr; floorEquity: DecStr; maxPriceDeviationBps: number;
  createdAt: number; /** unix SECONDS */ expiresAt: number; ackSha256: string }
export type MandatePhase = 'active' | 'wind_down' | 'ended';
export interface MandateSummary { id: string; hash: string; authorizationId: string; agentId: string; strategySha256: string; limits: VenueMandate; phase: MandatePhase; active: boolean; createdAt: number; expiresAt: number; expired: boolean;
  approvedAt: number | null; revokedAt: number | null; /** ms */ windDownUntil: number | null; ackSha256: string }
export interface SignerMandate { mandate: VenueMandate; hash: string; approvedAt: number | string | null; revoked: boolean; revokedAt: number | string | null; expired: boolean; phase: MandatePhase; /** unix SECONDS */ windDownUntil: number | null;
  today: { orders: number; reduceOnly: number; cancels: number; leverage: number; turnover: DecStr }; ordersLastHour: number; pendingOrders: number }
export interface MandateBody { instruments: MandateInstrument[]; maxOrderNotional: DecStr; maxGrossExposure: DecStr; maxDailyTurnover: DecStr; floorEquity: DecStr; maxOrdersPerDay: number; maxOrdersPerHour: number; maxPriceDeviationBps?: number;
  days: number; locale?: LiveLocale; strategySha256: string; agentId: string }
// <<< v7 perp live
export interface VenuePolicy { allowedInstruments: string[]; maxLeverage: number; maxOrderNotional: DecStr; maxPositionNotional: DecStr; maxGrossExposure: DecStr; maxOrdersPerDay: number; maxPriceDeviationBps: number }
export interface VenueAuthorization { v: 1; authorizationId: string; keyId: string; venue: 'hyperliquid'; network: LiveNetwork; account: string; agentAddress: string; agentName: string; mode: 'MANUAL_LIVE'; policy: VenuePolicy;
  createdAt: number; /** unix SECONDS */ expiresAt: number; approveNonce: number; ackSha256: string }
export interface VenueOrder { v: 1; authorizationId: string; venue: 'hyperliquid'; network: LiveNetwork; account: string; kind: 'order'; instrument: string; side: 'buy' | 'sell';
  type: 'limit' | 'stop_market' | 'stop_limit' | 'take_profit_market' | 'take_profit_limit'; size: DecStr; price: DecStr; triggerPrice: DecStr | null; reduceOnly: boolean; tif: 'gtc' | 'ioc' | 'alo'; clientId: string; nonce: number; expiresAt: number }
export interface VenueLeverage { v: 1; authorizationId: string; venue: 'hyperliquid'; network: LiveNetwork; account: string; kind: 'leverage'; instrument: string; leverage: number; marginMode: 'cross' | 'isolated'; nonce: number; expiresAt: number }
export interface Ack { venue: string; locale: 'fr' | 'en'; text: string; sha256: string; version: string; source: string }
export type LiveState = 'proposed' | 'risk_checked' | 'authorized' | 'signed' | 'submitted' | 'unknown' | 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected';
export interface LiveOrder { clientId: string; cloid: string | null; instrument: string; side: 'buy' | 'sell'; type: string; size: DecStr; price: DecStr | null; triggerPrice: DecStr | null; reduceOnly: boolean; tif: string;
  state: LiveState; final: boolean; venueOrderId: string | null; filled: DecStr; avgFillPrice: DecStr | null; reason: string | null; origin: 'owner' | 'close' | 'mandate'; hash: string | null; nonce: number | null; expiresAt: number | null;
  canonical: VenueOrder | null; createdAt: number; updatedAt: number; submittedAt: number | null; source: 'venue' | 'local' }
export interface LiveAction { id: string; kind: 'leverage' | 'cancel'; state: string; request: Record<string, unknown>; hash: string | null; nonce: number; expiresAt: number; error: string | null; createdAt: number; updatedAt: number }
export interface LiveAuthorization { id: string; hash: string | null; mode: string; agentName: string; policy: VenuePolicy; createdAt: number; expiresAt: number; ackSha256: string; active: boolean; expired: boolean; revokedAt: number | null; authorizedAt: number | null }
export interface LiveSummary { id: string; venue: 'hyperliquid'; network: LiveNetwork; kind: 'venue'; mode: 'READ_ONLY' | 'MANUAL_LIVE'; label: string; account: string; agentAddress: string; policy: RiskPolicy;
  halt: string | null; divergence: string | null; /** effective reason new orders are refused */ halted: string | null; mainnetEnabled: boolean; tradable: boolean;
  authorization: LiveAuthorization | null; pendingAuthorization: { authorizationId: string; preparedAt: number } | null; createdAt: number; updatedAt: number;
  /** v7 perp live (V6 server): every mode the account is in, and its derivative mandate */ modes?: string[]; mandate?: MandateSummary | null; pendingMandate?: { mandateId: string; preparedAt: number } | null }
export interface VenueState { state: AccountState | null; positions: Position[]; openOrders: Order[]; /** non-null = the venue could not be read: never show the account as empty */ error: string | null; ts: number; source: 'venue' }
export interface LiveRiskEvent { id: string; ts: number; kind: string; code: string | null; message: string; data: Record<string, unknown> }
export interface LiveFunding { instrument: string; amount: DecStr; rate: DecStr; size: DecStr; ts: number; source: 'venue' }
export interface LiveDetail extends LiveSummary { venueState: VenueState; orders: LiveOrder[]; actions: LiveAction[]; fills: (Fill & { source: 'venue' })[]; funding: LiveFunding[]; riskEvents: LiveRiskEvent[];
  equity: { ts: number; equity: DecStr; collateral: DecStr; marginUsed: DecStr; unrealizedPnl: DecStr; source: 'venue' }[]; ts: number }
export interface LiveEstimate { notional: DecStr; initialMargin: DecStr; fee: DecStr; feeNote: string; freeCollateralAfter: DecStr; leverage: DecStr; marginMode: 'cross' | 'isolated'; price: DecStr | null; mark: DecStr; liquidationPrice: null; liquidationNote: string; source: 'estimate' }
/** WebAuthn request as the server made it (`PublicKeyCredentialRequestOptionsJSON`): passed to the browser untouched */
export type PasskeyOptions = Parameters<typeof import('@simplewebauthn/browser').startAuthentication>[0]['optionsJSON'];
export interface Proposal { order: LiveOrder; canonical: VenueOrder | null; hash: string | null; expiresAt: number | null; estimate: LiveEstimate | null; idempotent: boolean; /** null = nothing (left) to approve */ options: PasskeyOptions | null;
  worstPrice?: DecStr | null; slippageBoundBps?: number | null; position?: Position }
export interface LivePreview { risk: RiskResult; estimate: LiveEstimate; request: OrderRequest; venueState: { state: AccountState; positions: Position[]; source: 'venue' }; ts: number }
export interface LiveConfig { mainnetEnabled: boolean; venues: { venue: string; networks: LiveNetwork[] }[]; modes: string[];
  // >>> v7 perp live: the V6 shape of GET /config (locale, reasons in both languages, the two mainnet locks)
  locale?: LiveLocale; mainnet?: { enabled: boolean; code: string | null; reason: string | null }; reasons?: Record<string, { fr: string; en: string }>;
  mandateLive: { available: boolean; code?: string | null; reason: string | null; mainnet?: { enabled: boolean; code: string | null; reason: string | null };
    bounds?: { maxDays: number; maxOrdersPerHour: number; maxLeverageChangesPerDay: number; maxInstruments: number; windDownSeconds: number; orderTtlMs: number } };
  // <<< v7 perp live
  pinnedAssets: { pinnedAt: string; mainnet: { instrument: string; maxLeverage: number }[]; testnet: { instrument: string; maxLeverage: number }[] };
  bounds: { maxLeverage: number; maxOrdersPerDay: number; minPriceBandBps: number; maxPriceBandBps: number; maxInstruments: number; maxAuthorizationDays: number; orderApprovalTtlMs: number }; ts: number }
export interface Collateral { account: string; network: LiveNetwork; equity: DecStr | null; collateral: DecStr | null; freeCollateral: DecStr | null; marginUsed: DecStr | null; withdrawable: DecStr | null; asset: string; error: string | null; ts: number; source: 'venue';
  deposits: { supported: boolean; how: string }; withdrawals: { supported: boolean; how: string }; locale?: LiveLocale }
export interface Prepared { authorization: VenueAuthorization; hash: string; acknowledgement: Ack; agent: { address: string; name: string; wireName: string; validUntil: number; can: string[]; cannot: string[]; note: string };
  whatIsSigned: { byMainKey: string; byPasskey: string }; venueState: VenueState; options: PasskeyOptions; ts: number }
// >>> v7 perp live
export interface MandatePrepared { mandate: VenueMandate; hash: string; acknowledgement: Ack; locale: LiveLocale; authorization: { id: string; hash: string | null; expiresAt: number; policy: VenuePolicy }; warning: string;
  enforcedBySigner: string[]; trustedBySigner: string[]; notEnforced: string[]; windDown: { seconds: number; text: string }; whatIsSigned: { byPasskey: string }; venueState: VenueState; options: PasskeyOptions; ts: number }
// <<< v7 perp live
export interface CancelAll { requested: number; accepted: number; failed: { venueOrderId: string | null; instrument: string; error: string }[]; remaining: Order[] | null; source: 'venue'; ts: number }
export interface Revoked extends LiveDetail { cancelled: CancelAll | null; warning: string | null; venueAgent: string; cancelError?: { code: string; message: string } | null; locale?: LiveLocale }
export interface LeverageProposal { action: LiveAction; canonical: VenueLeverage; hash: string; current: { leverage: DecStr; marginMode: 'cross' | 'isolated' } | null; expiresAt: number; options: PasskeyOptions }
export interface LeverageResult { action: LiveAction; idempotent: boolean; venue: { leverage: { leverage: DecStr; marginMode: string } | null; confirmed: boolean; source: 'venue' } | null }
/** the order body of a venue account: no `leverage` (a venue setting, changed with its own passkey-approved route), no `clientId` */
export type LiveOrderBody = Omit<OrderBody, 'leverage'>;

const L = '/derivatives/live';
const A = (id: string) => `${L}/accounts/${encodeURIComponent(id)}`;
const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
const normDetail = <T extends LiveDetail>(j: any): T => ({ ...j, venueState: { ...(j.venueState ?? {}), state: j.venueState?.state ?? null, positions: arr(j.venueState?.positions), openOrders: arr(j.venueState?.openOrders), error: j.venueState ? j.venueState.error ?? null : 'no venue state in the answer' },
  orders: arr(j.orders), actions: arr(j.actions), fills: arr(j.fills), funding: arr(j.funding), equity: arr(j.equity),
  riskEvents: arr<any>(j.riskEvents).map((e) => ({ id: String(e.id ?? `${e.ts}${e.kind}`), ts: Number(e.ts) || 0, kind: String(e.kind ?? 'event'), code: typeof e.code === 'string' ? e.code : null, message: String(e.message ?? ''), data: e.data ?? {} })) });

export const lapi = {
  /** `locale` selects the language of the server-authored sentences (codes never change) */
  config: (locale?: LiveLocale) => get<LiveConfig>(`${L}/config${locale ? `?locale=${locale}` : ''}`),
  accounts: async (): Promise<LiveSummary[]> => arr((await get(`${L}/accounts`)).accounts),
  /** one account per venue and network: a second call answers the same account */
  create: async (network: LiveNetwork, label: string): Promise<LiveDetail> => normDetail(await post(`${L}/accounts`, { venue: 'hyperliquid', network, label })),
  account: async (id: string): Promise<LiveDetail> => normDetail(await get(A(id))),
  collateral: (id: string, locale?: LiveLocale) => get<Collateral>(`${A(id)}/collateral${locale ? `?locale=${locale}` : ''}`),
  prepare: (id: string, body: { policy: VenuePolicy; days: number; locale: 'fr' | 'en' }) => post<Prepared>(`${A(id)}/authorization/prepare`, body),
  approveAuthorization: async (id: string, assertion: unknown): Promise<LiveDetail> => normDetail(await post(`${A(id)}/authorization/approve`, { assertion, acknowledged: true })),
  revoke: async (id: string, cancelOpenOrders: boolean, locale?: LiveLocale): Promise<Revoked> => normDetail<Revoked>(await post(`${A(id)}/authorization/revoke`, { cancelOpenOrders, ...(locale ? { locale } : {}) })),
  preview: (id: string, body: LiveOrderBody) => post<LivePreview>(`${A(id)}/orders/preview`, body),
  propose: (id: string, body: LiveOrderBody, key: string) => post<Proposal>(`${A(id)}/orders`, body, { 'idempotency-key': key }),
  approveOrder: (id: string, clientId: string, assertion: unknown) => post<{ order: LiveOrder; idempotent: boolean }>(`${A(id)}/orders/${encodeURIComponent(clientId)}/approve`, { assertion }),
  /** no passkey. Before approval it only withdraws the proposal (`sent: false`); after, the venue is asked */
  cancel: (id: string, clientId: string) => post<{ order: LiveOrder; sent: boolean; venue?: { outcome: 'accepted' | 'refused' | 'unknown'; error: string | null } }>(`${A(id)}/orders/${encodeURIComponent(clientId)}/cancel`),
  leverage: (id: string, body: { instrument: string; leverage: number; marginMode: 'cross' | 'isolated' }) => post<LeverageProposal>(`${A(id)}/leverage`, body),
  approveLeverage: (id: string, actionId: string, assertion: unknown) => post<LeverageResult>(`${A(id)}/leverage/${encodeURIComponent(actionId)}/approve`, { assertion }),
  halt: async (id: string, reason = ''): Promise<LiveDetail & { note: string }> => normDetail(await post(`${A(id)}/halt`, { reason })),
  resume: async (id: string): Promise<LiveDetail> => normDetail(await post(`${A(id)}/resume`)),
  cancelAll: (id: string) => post<CancelAll>(`${A(id)}/cancel-all`),
  /** a reduce-only market order on a fraction of the VENUE's position: a proposal, approved like any order */
  close: (id: string, instrument: string, fraction: DecStr, key: string) => post<Proposal>(`${A(id)}/close`, { instrument, fraction }, { 'idempotency-key': key }),
  rebase: async (id: string): Promise<LiveDetail> => normDetail(await post(`${A(id)}/rebase`)),
  reconcile: async (id: string): Promise<{ reconciled: number; fills: number; funding: number; divergence: string | null; account: LiveDetail }> => { const j = await post(`${A(id)}/reconcile`); return { ...j, account: normDetail(j.account) }; },
  streamUrl: (id: string): string => `/api/v1${A(id)}/stream`,
};

// ------------------------------------------------------------------------------------------------ pure helpers (unit-tested)

/** which money an account moves: decides the band, the labels and every confirmation */
export type Tone = 'paper' | 'testnet' | 'mainnet';
/** anything that is not known to be the testnet is treated as real money */
export const toneOf = (a: { kind: 'paper' | 'venue'; network: string }): Tone => (a.kind === 'paper' ? 'paper' : a.network === 'testnet' ? 'testnet' : 'mainnet');

/** one Idempotency-Key per review: 8–100 characters of [A-Za-z0-9._:-] */
export const newKey = (prefix = 'ui'): string => `${prefix}-${crypto.randomUUID()}`;

/** time left before the server refuses the approval; the server stops 2 s before `expiresAt`, the screen stops 3 s before */
export const APPROVAL_MARGIN_MS = 3000;
export function remainingMs(expiresAt: number | null, now: number, skewMs = 0): number {
  return expiresAt === null ? 0 : Math.max(0, expiresAt - (now - skewMs) - APPROVAL_MARGIN_MS);
}
/** « 1:27 », « 0:05 » */
export function clock(ms: number): string { const s = Math.ceil(Math.max(0, ms) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

const same = (a: DecStr | null | undefined, b: DecStr | null | undefined): boolean => { const x = dec(a), y = dec(b); return x && y ? D.eq(x, y) : (a ?? null) === (b ?? null); };
/**
 * Is the canonical order (what the passkey signs) the order that was asked for? Returns the first field that differs, or null.
 * A market order comes back as a limit IOC at its worst price: that is expected. The server answers a re-used Idempotency-Key
 * with the STORED order "whatever the body says" — this check is what keeps a stale answer from being approved by mistake.
 */
export function canonicalProblem(body: LiveOrderBody, c: VenueOrder | null): string | null {
  if (!c) return 'canonical';
  if (c.instrument !== body.instrument) return 'instrument';
  if (c.side !== body.side) return 'side';
  if (!same(c.size, body.size)) return 'size';
  if (c.reduceOnly !== (body.reduceOnly ?? false)) return 'reduceOnly';
  const market = body.type === 'market';
  if (c.type !== (market ? 'limit' : body.type)) return 'type';
  if (c.tif !== (market ? 'ioc' : body.tif ?? 'gtc')) return 'tif';
  if (!same(c.triggerPrice, body.triggerPrice ?? null)) return 'triggerPrice';
  if (body.price !== null && body.price !== undefined && !same(c.price, body.price)) return 'price';
  if (!dec(c.price) || !D.isPos(D.from(c.price))) return 'price';
  return null;
}
/** the same for a close: reduce-only, IOC, the side that reduces the position, at most the position's size */
export function closeProblem(pos: { instrument: string; side: 'long' | 'short'; size: DecStr }, c: VenueOrder | null): string | null {
  if (!c) return 'canonical';
  if (c.instrument !== pos.instrument) return 'instrument';
  if (c.side !== (pos.side === 'long' ? 'sell' : 'buy')) return 'side';
  if (!c.reduceOnly) return 'reduceOnly';
  if (c.type !== 'limit' || c.tif !== 'ioc' || c.triggerPrice !== null) return 'type';
  const s = dec(c.size), p = dec(pos.size);
  if (!s || !p || !D.isPos(s) || D.gt(s, p)) return 'size';
  return null;
}

export interface PolicyForm { instruments: string[]; maxLeverage: string; maxOrderNotional: string; maxPositionNotional: string; maxGrossExposure: string; maxOrdersPerDay: string; bandBps: string; days: string }
/**
 * Conservative starting values, all editable: one market, leverage 2, small notionals, few orders, one week. The price band is
 * the one field that differs by network: the signer compares every order price with its own USD spot price, and the testnet
 * mark wanders more than 1 % away from it (docs/v4/venues/hyperliquid.md, section 13).
 */
export function defaultPolicyForm(network: LiveNetwork, pinned: { instrument: string }[]): PolicyForm {
  const btc = pinned.find((p) => p.instrument === 'hyperliquid:BTC') ?? pinned[0];
  return { instruments: btc ? [btc.instrument] : [], maxLeverage: '2', maxOrderNotional: '50', maxPositionNotional: '100', maxGrossExposure: '150', maxOrdersPerDay: '20', bandBps: network === 'testnet' ? '1000' : '200', days: '7' };
}
export type PolicyProblem = 'instruments' | 'tooManyInstruments' | 'leverage' | 'leverageVenue' | 'order' | 'position' | 'gross' | 'orderAbovePosition' | 'positionAboveGross' | 'ordersPerDay' | 'band' | 'days';
const int = (s: string): number | null => (/^\d{1,6}$/.test(s.trim()) ? Number(s.trim()) : null);
const pos = (s: string): DecStr | null => { const v = parseInput(s); return v && D.isPos(D.from(v)) ? v : null; };
/** the form as the `VenuePolicy` the server takes, or the first reason it cannot be one (the server checks again) */
export function policyFromForm(f: PolicyForm, bounds: LiveConfig['bounds'], pinned: { instrument: string; maxLeverage: number }[]): { ok: true; policy: VenuePolicy; days: number } | { ok: false; problem: PolicyProblem } {
  const no = (problem: PolicyProblem) => ({ ok: false as const, problem });
  const allowed = f.instruments.filter((i) => pinned.some((p) => p.instrument === i));
  if (!allowed.length) return no('instruments');
  if (allowed.length > bounds.maxInstruments) return no('tooManyInstruments');
  const lev = int(f.maxLeverage);
  if (lev === null || lev < 1 || lev > bounds.maxLeverage) return no('leverage');
  if (allowed.some((i) => lev > (pinned.find((p) => p.instrument === i)?.maxLeverage ?? 0))) return no('leverageVenue');
  const order = pos(f.maxOrderNotional), position = pos(f.maxPositionNotional), gross = pos(f.maxGrossExposure);
  if (!order) return no('order');
  if (!position) return no('position');
  if (!gross) return no('gross');
  if (D.gt(D.from(order), D.from(position))) return no('orderAbovePosition');
  if (D.gt(D.from(position), D.from(gross))) return no('positionAboveGross');
  const perDay = int(f.maxOrdersPerDay);
  if (perDay === null || perDay < 1 || perDay > bounds.maxOrdersPerDay) return no('ordersPerDay');
  const band = int(f.bandBps);
  if (band === null || band < bounds.minPriceBandBps || band > bounds.maxPriceBandBps) return no('band');
  const days = int(f.days);
  if (days === null || days < 1 || days > bounds.maxAuthorizationDays) return no('days');
  return { ok: true, policy: { allowedInstruments: allowed, maxLeverage: lev, maxOrderNotional: order, maxPositionNotional: position, maxGrossExposure: gross, maxOrdersPerDay: perDay, maxPriceDeviationBps: band }, days };
}
/** does the authorization the server prepared carry exactly the limits that were asked for? */
export function samePolicy(a: VenuePolicy, b: VenuePolicy): boolean {
  return [...a.allowedInstruments].sort().join() === [...b.allowedInstruments].sort().join() && a.maxLeverage === b.maxLeverage && same(a.maxOrderNotional, b.maxOrderNotional) && same(a.maxPositionNotional, b.maxPositionNotional)
    && same(a.maxGrossExposure, b.maxGrossExposure) && a.maxOrdersPerDay === b.maxOrdersPerDay && a.maxPriceDeviationBps === b.maxPriceDeviationBps;
}
/** SHA-256 of the acknowledgement text exactly as displayed, hex — compared with the hash the authorization commits to */
export async function sha256Hex(text: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The venue's own words inside the API's `venue_rejected` message
 * ("the venue did not register the trading key: <words> — the authorization was revoked on the signer…").
 */
export function venueWords(message: string): string {
  const m = /^the venue did not register the trading key:\s*([\s\S]*?)\s+—\s+the authorization was revoked/.exec(message);
  return (m ? m[1]! : message).trim();
}
/** an unfunded account: the venue's documented answer to any action of an address that never deposited */
export const isUnfunded = (message: string): boolean => /must deposit before performing actions/i.test(message);

export interface LiveErr { /** i18n key suffix: `flE_<key>` */ key: string; code: string; status: number; /** the server's own sentence, shown under ours */ detail: string; /** the proposal is gone: prepare again */ consumed: boolean; /** the same request may be sent again as is */ retry: boolean }
const KNOWN = new Set(['mainnet_disabled', 'mode_read_only', 'authorization_expired', 'venue_rejected', 'no_position', 'below_min_size', 'instrument_not_allowed', 'leverage_exceeded', 'halted', 'proposal_expired', 'bad_state', 'wrong_key',
  'bad_request', 'idempotency', 'bad_policy', 'unknown_account', 'unknown_order', 'unknown_action', 'unknown_instrument', 'unknown_venue', 'too_many_streams', 'asset_table_mismatch', 'venue_unavailable', 'venue_rate_limited',
  'signer_unreachable', 'signer_price', 'signer_no_price', 'signer_bad_approval', 'signer_unknown_credential', 'signer_policy', 'signer_mismatch', 'signer_expired', 'signer_revoked', 'signer_stale_nonce', 'signer_replay',
  'signer_acknowledgement', 'signer_unsupported', 'signer_wrong_key', 'signer_wrong_agent', 'signer_conflict', 'signer_halted', 'offline', 'stale_data', 'no_liquidity', 'csrf', 'unauthenticated']);
/**
 * Every failure of a live route as: which sentence to show, the server's words, and what the screen may offer next.
 * `halted` is two different moments: 422 on a proposal (nothing was prepared), 423 on an approval (the proposal is void).
 * A signer refusal or an expired proposal consumes the proposal. Only a lost connection (status 0) or a read failure of the
 * venue/signer transport leaves the same request safe to send again.
 */
export function liveError(e: unknown, stage: 'propose' | 'approve' | 'other' = 'other'): LiveErr {
  const x = e as { status?: number; code?: string; message?: string; name?: string };
  if (x?.name === 'NotAllowedError' || x?.name === 'AbortError') return { key: 'passkey_cancelled', code: 'passkey_cancelled', status: 0, detail: '', consumed: stage === 'approve', retry: false };
  if (!(e instanceof ApiError)) return { key: 'passkey_failed', code: String(x?.name ?? 'error'), status: 0, detail: String(x?.message ?? ''), consumed: stage === 'approve', retry: false };
  const code = e.code, detail = e.message && e.message !== 'error' && e.message !== code ? e.message : '';
  const key = code === 'halted' && e.status === 423 ? 'halted_423' : KNOWN.has(code) ? code : code.startsWith('signer_') ? 'signer_other' : 'other';
  const transport = e.status === 0 || code === 'venue_unavailable' || code === 'venue_rate_limited' || code === 'stale_data';
  // At approval the screen treats EVERY answered failure as the end of that proposal (the server marks the order `rejected`
  // whenever no signature came back, and an expired one `cancelled`): the only thing sent again as is, is an approval whose
  // answer was lost on the way (no answer, or an unexplained 5xx) — the server sends an order once however many times it is
  // approved, and answers the second call with the order's present state.
  // At proposal a 422 is stored under the Idempotency-Key as a refused order: the next review needs a new key.
  const lost = e.status === 0 || (e.status >= 500 && !['signer_unreachable', 'asset_table_mismatch', 'venue_unavailable', 'venue_rate_limited'].includes(code));
  const consumed = stage === 'approve' ? !lost : stage === 'propose' ? e.status === 422 : false;
  return { key, code, status: e.status, detail, consumed, retry: stage === 'approve' ? lost : transport };
}

/** `unknown`, `submitted`, `signed`, `authorized`: the venue has not confirmed anything yet — never shown as done, never re-sent */
export const inFlight = (s: LiveState): boolean => s === 'authorized' || s === 'signed' || s === 'submitted' || s === 'unknown';
export const stateTone = (o: Pick<LiveOrder, 'state' | 'final'>): 'ok' | 'warn' | 'danger' | 'info' =>
  o.state === 'filled' || o.state === 'open' ? 'ok' : o.state === 'rejected' ? 'danger' : o.state === 'partially_filled' || o.state === 'cancelled' || inFlight(o.state) ? 'warn' : 'info';

// ------------------------------------------------------------------------------------------------ the order form → the body of the live routes
/** market-like orders: bounded by the server at this distance from the book; a triggered order carries a worst price this far from its trigger */
export const LIVE_SLIPPAGE_BPS = 50;
type Kind = 'market' | 'limit' | 'stop' | 'tp';
/** i18n keys of the form's own problems (shared with the paper panel) */
export type BuildProblem = 'fxErrInstrument' | 'fxErrPrice' | 'fxErrTrigger' | 'fxErrSize' | 'fxErrSizeSmall';
const TYPE: Record<Kind, LiveOrderBody['type']> = { market: 'market', limit: 'limit', stop: 'stop_market', tp: 'take_profit_market' };
export interface LiveForm { side: 'buy' | 'sell'; kind: Kind; size: string; price: string; trigger: string; reduceOnly: boolean; postOnly: boolean }
/** the form as the body of the live routes; every amount is a canonical decimal string put on the venue's grid */
export function buildLive(f: LiveForm, inst: Pick<Instrument, 'id' | 'venue' | 'tickSize' | 'lotSize'>): { body: LiveOrderBody | null; problem: BuildProblem | null } {
  const none = (problem: BuildProblem | null) => ({ body: null, problem });
  const tick = dec(inst.tickSize), lot = dec(inst.lotSize);
  if (!tick || !lot || !D.isPos(tick) || !D.isPos(lot)) return none('fxErrInstrument');
  let price: string | null = null, trigger: string | null = null;
  if (f.kind === 'limit') { const p = parseInput(f.price); if (!p) return none(f.price.trim() ? 'fxErrPrice' : null); const q = onTick(D.from(p), tick, inst.venue); if (!D.isPos(q)) return none('fxErrPrice'); price = D.str(q); }
  else if (f.kind !== 'market') { const p = parseInput(f.trigger); if (!p) return none(f.trigger.trim() ? 'fxErrTrigger' : null); const q = onTick(D.from(p), tick, inst.venue); if (!D.isPos(q)) return none('fxErrTrigger');
    trigger = D.str(q); price = D.str(worstPrice(q, f.side, LIVE_SLIPPAGE_BPS, tick, inst.venue)); }
  const raw = parseInput(f.size);
  if (!raw) return none(f.size.trim() ? 'fxErrSize' : null);
  const size = D.quantize(D.from(raw), lot, 'down');
  if (!D.isPos(size)) return none('fxErrSizeSmall');
  return { body: { instrument: inst.id, side: f.side, type: TYPE[f.kind], size: D.str(size), price, triggerPrice: trigger, reduceOnly: f.reduceOnly, tif: f.kind === 'market' ? 'ioc' : f.kind === 'limit' && f.postOnly ? 'alo' : 'gtc',
    ...(f.kind === 'market' ? { slippageBps: LIVE_SLIPPAGE_BPS } : {}) }, problem: null };
}
