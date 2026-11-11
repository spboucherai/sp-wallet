/**
 * In-browser stand-in for the routes of controlled LIVE trading (`/api/v1/derivatives/live/*`) — DEVELOPMENT BUILDS ONLY: it
 * is imported by `mock.ts` alone, which `main.tsx` loads behind `import.meta.env.DEV`. A production bundle has none of it.
 *
 * What is real here: the repository's own canonical objects and hashes (`packages/derivatives/src/live/canonical.ts`), the
 * jurisdiction acknowledgement text and its SHA-256, the pinned asset table, the venue-policy schema and bounds, the risk
 * engine (`checkOrder`) with the policy the backend derives from an authorization, and the order of the backend's checks and
 * its error codes (services/api/src/derivatives/exec.ts).
 * What is simulated: the VENUE is a `PaperAccount` filled against the mock's moving book (the same book for "testnet" and
 * "mainnet"); the SIGNER is a few checks in this file (challenge = hash, limits, price band around a "signer price"); the
 * PASSKEY is a patched `navigator.credentials.get` that answers after a short pause with an assertion carrying the challenge.
 * Nothing here signs anything, talks to a venue, or proves that the real backend behaves the same way.
 *
 * Test hooks: `window.__spwMock.live` — see `LiveHooks` at the bottom.
 */
import { hex, validateVenueAuthorization, venueAgentWireName, venueAuthorizationHash, venueLeverageHash, venueOrderHash, venueOrderNotional, VenuePolicySchema, VENUE_AUTH_MAX_DAYS, VENUE_POLICY_BOUNDS, withinBand,
  type VenueAuthorization, type VenueLeverage, type VenueOrder, type VenuePolicy } from '../../../../packages/derivatives/src/live/canonical.ts';
import { HL_PINNED_ASSETS, HL_PINNED_AT } from '../../../../packages/derivatives/src/live/hl-assets.ts';
import { createCollateralMock, type CollateralHooks } from './mockCollateral';
// >>> v7 perp live: the repository's own canonical mandate (schema, hash, validity, phase)
import { validateVenueMandate, VENUE_MANDATE_BOUNDS, VENUE_MANDATE_WIND_DOWN_S, venueMandateHash, venueMandatePhase, VenueMandateSchema, type VenueMandate } from '../../../../packages/derivatives/src/live/mandate.ts';
import { mockLiveReasons, mockLiveTexts, type MockLocale } from './mockLiveTexts';
// <<< v7 perp live
import { jurisdictionAck } from '../../../../packages/derivatives/src/live/jurisdiction.ts';
import { D } from '../../../../packages/derivatives/src/decimal.ts';
import { initialMargin } from '../../../../packages/derivatives/src/margin.ts';
import { PaperAccount } from '../../../../packages/derivatives/src/paper.ts';
import { checkOrder, type RiskResult } from '../../../../packages/derivatives/src/risk.ts';
import type { AccountState, Book, Instrument, Order, OrderRequest, Position, RiskPolicy, Ticker } from './types';

export interface SimLike { inst: Instrument; ticker: Ticker; book: Book | null; frozen: boolean }
export interface LiveMockEnv { sim: (id: string) => SimLike | null; fresh: (s: SimLike) => SimLike; priceProblem: (venue: string, tick: string, price: string) => string | null; worstPrice: (ref: string, side: 'buy' | 'sell', bps: number, tick: string, venue: string) => string }
type Net = 'testnet' | 'mainnet';
type State = 'proposed' | 'risk_checked' | 'authorized' | 'signed' | 'submitted' | 'unknown' | 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected';
interface LOrder { clientId: string; cloid: string; instrument: string; side: 'buy' | 'sell'; type: string; size: string; price: string | null; triggerPrice: string | null; reduceOnly: boolean; tif: string; state: State; final: boolean;
  venueOrderId: string | null; filled: string; avgFillPrice: string | null; reason: string | null; origin: 'owner' | 'close' | 'mandate'; hash: string | null; nonce: number | null; expiresAt: number | null; canonical: VenueOrder | null;
  createdAt: number; updatedAt: number; submittedAt: number | null; signed: boolean; /** an `unknown` answer is revealed by the "reconciliation" at this time */ revealAt: number | null; req: OrderRequest | null }
interface LAction { id: string; kind: 'leverage' | 'cancel'; state: string; request: Record<string, unknown>; hash: string | null; nonce: number; expiresAt: number; error: string | null; createdAt: number; updatedAt: number }
interface Ev { id: number; ts: number; kind: string; code: string | null; message: string; data: Record<string, unknown> }
interface LAcct { id: string; network: Net; label: string; account: string; agentAddress: string; mode: 'READ_ONLY' | 'MANUAL_LIVE'; policy: RiskPolicy; halt: string | null; divergence: string | null;
  pending: { authorization: VenueAuthorization; preparedAt: number } | null; auth: VenueAuthorization | null; authHash: string | null; authorizedAt: number | null; revokedAt: number | null; createdAt: number; updatedAt: number;
  venue: PaperAccount | null; foreign: Order[]; orders: LOrder[]; actions: LAction[]; events: Ev[]; equity: { ts: number; equity: string; collateral: string; marginUsed: string; unrealizedPnl: string; source: 'venue' }[];
  lastNonce: number; leverage: Record<string, { leverage: string; marginMode: 'cross' | 'isolated' }>; signedToday: number;
  // >>> v7 perp live: the derivative mandate of the account (the last one approved) and the simulated signer's counters of the day
  mandate?: { mandate: VenueMandate; hash: string; approvedAt: number; revokedAt: number | null } | null; pendingMandate?: { mandate: VenueMandate; hash: string; preparedAt: number } | null;
  mstats?: { orders: number; reduceOnly: number; cancels: number; leverage: number; turnover: string; stamps: number[] }
  // <<< v7 perp live
}
type Out = { status: number; json: any };
class Refuse extends Error { status: number; code: string; constructor(code: string, message: string, status: number) { super(message); this.code = code; this.status = status; } }

const WALLET = '0x5ad0c0ffee5ad0c0ffee5ad0c0ffee5ad0c0ffee', AGENT: Record<Net, string> = { testnet: '0x7e57a9e170000000000000000000000000a9e171', mainnet: '0x4ea1a9e170000000000000000000000000a9e170' };
const PATHS: Record<Net, string> = { mainnet: "m/44'/60'/9000'/0/0", testnet: "m/44'/60'/9000'/0/1" };
const MAINNET_OFF = mockLiveReasons.mainnet_disabled.en;
const READ_ONLY_POLICY: RiskPolicy = { mode: 'READ_ONLY', allowedInstruments: [], halt: null, maxDataAgeMs: 5_000, maxDeviationBps: '0', maxMarkIndexBps: '0', maxLeverage: '1', maxOrderNotional: '0',
  maxGrossExposure: '0', maxPositionNotional: '0', minFreeCollateral: '0', minLiquidationDistanceBps: '0', maxDailyLoss: '0', maxTotalLoss: '0', maxOrdersPerMinute: 0, maxOrdersPerDay: 0 };
const PRE = ['proposed', 'risk_checked'], AT_VENUE = ['submitted', 'unknown', 'open', 'partially_filled', 'filled'];
const IDEM = /^[A-Za-z0-9._:-]{8,100}$/;
const canon = (x: string) => D.str(D.from(x));
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unhex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
/** 128-bit client order id from the Idempotency-Key (the backend derives it with SHA-256; here a plain FNV mix — only its shape matters to the screens) */
function cloidOf(key: string): string { let out = ''; for (let k = 0; k < 4; k++) { let h = 2166136261 ^ (k * 0x9e3779b1); for (const ch of key) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } out += (h >>> 0).toString(16).padStart(8, '0'); } return `0x${out}`; }
/** services/api/src/derivatives/exec.ts `liveRiskPolicy` */
function liveRiskPolicy(vp: VenuePolicy, network: Net): RiskPolicy {
  const gross = D.from(vp.maxGrossExposure), times = (k: string) => D.str(D.mul(gross, D.from(k)));
  return { mode: 'MANUAL_LIVE', allowedInstruments: [...vp.allowedInstruments], halt: null, maxDataAgeMs: 5_000, maxDeviationBps: String(Math.min(vp.maxPriceDeviationBps, 300)), maxMarkIndexBps: network === 'testnet' ? '1000' : '100',
    maxLeverage: String(vp.maxLeverage), maxOrderNotional: canon(vp.maxOrderNotional), maxGrossExposure: canon(vp.maxGrossExposure), maxPositionNotional: canon(vp.maxPositionNotional),
    minFreeCollateral: '0', minLiquidationDistanceBps: '1000', maxDailyLoss: times('0.05'), maxTotalLoss: times('0.2'), maxOrdersPerMinute: 6, maxOrdersPerDay: vp.maxOrdersPerDay };
}

export interface LiveHooks {
  /** the server setting SPW_DERIV_LIVE_MAINNET */ mainnet: (on: boolean) => void;
  /** collateral the next venue account of a network starts with, and (when it exists and holds nothing) that account's collateral now; '0' = never deposited */ fund: (network: Net, usdc: string) => void;
  /** how the simulated passkey answers the NEXT prompt: 'cancel' = the owner dismisses it, 'bad' = an assertion over another challenge */ passkey: (next: 'ok' | 'cancel' | 'bad') => void;
  /** what the simulated venue does with the NEXT submitted order: 'unknown' = no usable answer, revealed by reconciliation a few seconds later; 'reject' = refused with the venue's words */ venue: (next: 'ok' | 'unknown' | 'reject') => void;
  /** distance in basis points between the signer's own price and the venue's mark (the signer refuses prices outside the authorized band around ITS price) */ signerOffsetBps: (bps: number) => void;
  /** the signer cannot be reached for the next approval */ signerDown: () => void;
  /** lifetime of the next proposals in milliseconds (the backend's is 90 000) */ ttl: (ms: number) => void;
  /** a difference between the venue and the wallet's records: 'position' clears with rebase, 'order' (a foreign resting order) clears when it is gone */ diverge: (network: Net, kind: 'position' | 'order') => void;
  /** the foreign order is gone from the venue */ settle: (network: Net) => void;
  /** the venue cannot be read (venueState.error) */ unreadable: (on: boolean) => void;
  accounts: () => { id: string; network: Net; mode: string; orders: number }[];
  /** deposits and withdrawals of collateral (mockCollateral.ts) */ collateral: CollateralHooks;
}

export function createLiveMock(env: LiveMockEnv) {
  const ACCTS = new Map<string, LAcct>(), listeners = new Map<string, Set<(event: string, data: unknown) => void>>();
  let MAINNET = false, PASSKEY: 'ok' | 'cancel' | 'bad' = 'ok', VENUE: 'ok' | 'unknown' | 'reject' = 'ok', OFFSET = 0, SIGNER_DOWN = false, TTL = 90_000, UNREADABLE = false, EV = 0, OID = 9_000_000;
  const FUND: Record<Net, string> = { testnet: '1000', mainnet: '1000' };
  const now = () => Date.now();
  const emit = (id: string, event: string, data: unknown) => { for (const l of [...(listeners.get(id) ?? [])]) l(event, data); };
  const options = (hashHex: string) => ({ challenge: b64u(unhex(hashHex)), timeout: 120_000, rpId: location.hostname, allowCredentials: [], userVerification: 'required' as const });
  // deposit / withdraw of collateral (mockCollateral.ts): the venue side is this mock's own venue account
  const COLLATERAL = createCollateralMock({ now, mainnet: () => MAINNET, keyId: 'spw-mock0000000000', options, refuse: (code, message, status) => new Refuse(code, message, status),
    balance: (m) => { const a = ACCTS.get(m.id); if (!a || UNREADABLE) return null; if (!a.venue) return { equity: '0', withdrawable: '0' }; const st = a.venue.accountState(now()); return { equity: st.equity, withdrawable: st.freeCollateral }; },
    move: (m, delta) => { const a = ACCTS.get(m.id); if (!a) return; if (!a.venue) { if (D.isPos(D.from(delta))) a.venue = newVenue(a, delta); } else a.venue.state.collateral = D.str(D.add(D.from(a.venue.state.collateral), D.from(delta))); snapshot(a); },
    refusal: (assertion, hashHex) => { let challenge = ''; try { challenge = JSON.parse(atob(String((assertion as any)?.response?.clientDataJSON).replace(/-/g, '+').replace(/_/g, '/'))).challenge; } catch { /* not an assertion */ }
      return challenge === b64u(unhex(hashHex)) ? null : new Refuse('signer_bad_approval', 'the passkey assertion does not approve this action (challenge mismatch)', 422); } });
  const newVenue = (a: { account: string }, collateral: string) => PaperAccount.create({ venue: 'hyperliquid', account: a.account, collateral, config: { takerFeeRate: '0.00045', makerFeeRate: '0.00015', liquidationFeeRate: '0', feeAsset: 'USDC', leverage: '20', leverageByInstrument: {}, maintenanceMarginFraction: '0.0125' } });
  const effectiveHalt = (a: LAcct) => a.halt ?? (a.divergence ? `the venue's state and the wallet's records differ (${a.divergence}): new orders are stopped until it clears` : null);
  const blocked = (a: LAcct, what: 'trade' | 'stop'): Refuse | null => {
    if (a.network === 'mainnet' && !MAINNET) return new Refuse('mainnet_disabled', MAINNET_OFF, 403);
    if (!a.auth) return new Refuse('mode_read_only', 'this venue account is read-only: live trading has not been authorized with the owner\'s passkey', 422);
    if (a.mode !== 'MANUAL_LIVE') return new Refuse('mode_read_only', 'the authorization of this venue account was revoked: it is read-only', 422);
    if (what === 'trade' && now() >= a.auth.expiresAt * 1000) return new Refuse('authorization_expired', 'the venue authorization has expired: approve a new one', 422);
    return null;
  };
  const riskEvent = (a: LAcct, kind: string, code: string | null, message: string, data: Record<string, unknown> = {}) => { const e = { id: ++EV, ts: now(), kind, code, message, data }; a.events.push(e); emit(a.id, 'risk', { ts: e.ts, kind, code, message, data }); };
  const nextNonce = (a: LAcct) => (a.lastNonce = Math.max(a.lastNonce + 1, now()));
  const venueState = (a: LAcct) => {
    const ts = now();
    if (UNREADABLE) return { state: null, positions: [] as Position[], openOrders: [] as Order[], error: 'hyperliquid: request timed out after 8000 ms', ts, source: 'venue' as const };
    const zero: AccountState = { venue: 'hyperliquid', account: a.account, equity: '0', collateral: '0', freeCollateral: '0', marginUsed: '0', maintenanceMargin: '0', withdrawable: '0', ts, source: 'venue' };
    if (!a.venue) return { state: zero, positions: [] as Position[], openOrders: [...a.foreign], error: null, ts, source: 'venue' as const };
    const st = a.venue.accountState(ts);
    return { state: { ...st, withdrawable: st.freeCollateral, source: 'venue' as const }, positions: a.venue.positions().map((p) => ({ ...p, source: 'venue' as const })), openOrders: [...a.venue.openOrders(), ...a.foreign], error: null, ts, source: 'venue' as const };
  };
  const orderView = (o: LOrder) => { const { signed: _s, revealAt: _r, req: _q, ...rest } = o; void _s; void _r; void _q;
    return { ...rest, source: (['open', 'partially_filled', 'filled'].includes(o.state) || (o.state === 'cancelled' && o.venueOrderId) ? 'venue' : 'local') as 'venue' | 'local' }; };
  const summary = (a: LAcct) => ({ id: a.id, venue: 'hyperliquid' as const, network: a.network, kind: 'venue' as const, mode: a.mode, label: a.label, account: a.account, agentAddress: a.agentAddress, policy: a.policy, halt: a.halt, divergence: a.divergence,
    halted: effectiveHalt(a), mainnetEnabled: MAINNET, tradable: blocked(a, 'trade') === null,
    authorization: a.auth ? { id: a.auth.authorizationId, hash: a.authHash, mode: a.auth.mode, agentName: a.auth.agentName, policy: a.auth.policy, createdAt: a.auth.createdAt * 1000, expiresAt: a.auth.expiresAt * 1000, ackSha256: a.auth.ackSha256,
      active: a.mode === 'MANUAL_LIVE' && now() < a.auth.expiresAt * 1000, expired: now() >= a.auth.expiresAt * 1000, revokedAt: a.revokedAt, authorizedAt: a.authorizedAt } : null,
    pendingAuthorization: a.pending ? { authorizationId: a.pending.authorization.authorizationId, preparedAt: a.pending.preparedAt } : null, createdAt: a.createdAt, updatedAt: a.updatedAt, ...mandateInfo(a) });
  // >>> v7 perp live: exec.ts `currentMandate` / `mandateInfo`
  function mandatePhase(a: LAcct) {
    const m = a.mandate; if (!m) return null;
    const nowS = Math.floor(now() / 1000), ph = venueMandatePhase(m.mandate, m.revokedAt === null ? null : Math.floor(m.revokedAt / 1000), nowS);
    const rootAlive = a.mode === 'MANUAL_LIVE' && a.auth?.authorizationId === m.mandate.authorizationId && nowS < (a.auth?.expiresAt ?? 0);
    return { phase: rootAlive ? ph.phase : 'ended' as const, windDownUntil: ph.windDownUntil === null ? null : ph.windDownUntil * 1000 };
  }
  function mandateInfo(a: LAcct) {
    const m = a.mandate, ph = mandatePhase(a);
    return { modes: (a.mode === 'MANUAL_LIVE' && ph?.phase === 'active' ? ['MANUAL_LIVE', 'MANDATE_LIVE'] : [a.mode]) as string[],
      mandate: m && ph ? { id: m.mandate.mandateId, hash: m.hash, authorizationId: m.mandate.authorizationId, agentId: m.mandate.agentId, strategySha256: m.mandate.strategySha256, limits: m.mandate, phase: ph.phase, active: ph.phase === 'active',
        createdAt: m.mandate.createdAt * 1000, expiresAt: m.mandate.expiresAt * 1000, expired: now() >= m.mandate.expiresAt * 1000, approvedAt: m.approvedAt, revokedAt: m.revokedAt, windDownUntil: ph.windDownUntil, ackSha256: m.mandate.ackSha256 } : null,
      pendingMandate: a.pendingMandate ? { mandateId: a.pendingMandate.mandate.mandateId, preparedAt: a.pendingMandate.preparedAt } : null };
  }
  // <<< v7 perp live
  const detail = (a: LAcct) => ({ ...summary(a), venueState: venueState(a), orders: [...a.orders].reverse().slice(0, 100).map(orderView), actions: [...a.actions].reverse().slice(0, 50),
    fills: a.venue ? [...a.venue.state.fills].reverse().slice(0, 100).map((f) => ({ ...f, source: 'venue' as const })) : [], funding: a.venue ? [...a.venue.state.funding].reverse().slice(0, 100).map((f) => ({ ...f, source: 'venue' as const })) : [],
    riskEvents: [...a.events].reverse().slice(0, 100), equity: a.equity, ts: now() });
  const setOrder = (a: LAcct, o: LOrder, patch: Partial<LOrder>) => { Object.assign(o, patch, { updatedAt: Math.max(now(), o.updatedAt + 1) }); a.updatedAt = now(); emit(a.id, 'order', orderView(o)); };
  const snapshot = (a: LAcct) => { if (!a.venue) return; const t = now(), minute = Math.floor(t / 60_000) * 60_000, st = a.venue.accountState(t), last = a.equity[a.equity.length - 1];
    const row = { ts: minute, equity: st.equity, collateral: st.collateral, marginUsed: st.marginUsed, unrealizedPnl: D.str(D.sub(D.from(st.equity), D.from(st.collateral))), source: 'venue' as const };
    if (last && last.ts === minute) a.equity[a.equity.length - 1] = row; else a.equity.push(row); };

  // ------------------------------------------------------------------ the "venue": what its own records say about one of our orders
  function reconcileOrder(a: LAcct, o: LOrder): void {
    if (!a.venue || o.final || !AT_VENUE.includes(o.state)) return;
    if (o.state === 'unknown' && o.revealAt !== null && now() < o.revealAt) return;
    const eo = a.venue.order(o.cloid);
    if (!eo) { if (o.expiresAt !== null && now() > o.expiresAt + 5000) setOrder(a, o, { state: 'rejected', final: true, reason: 'never placed: the venue has no order with this client id and the signature has expired' }); return; }
    const resting = a.venue.openOrders().some((x) => x.clientId === o.cloid), filled = canon(eo.filled), any = D.isPos(D.from(filled)), whole = D.gte(D.from(filled), D.from(o.size));
    let state: State, final = false, reason: string | null = null;
    if (eo.status === 'rejected') { state = 'rejected'; final = true; reason = `refused by the venue (${eo.rejectReason ?? 'rejected'})`; }
    else if (resting) state = any ? 'partially_filled' : 'open';
    else { state = whole ? 'filled' : any ? 'partially_filled' : 'cancelled'; final = true; reason = whole ? null : any ? `remainder not filled (venue: ${eo.rejectReason ?? 'canceled'})` : eo.rejectReason ?? 'canceled'; }
    if (o.state === state && o.final === final && o.filled === filled) return;
    setOrder(a, o, { state, final, reason, filled, avgFillPrice: eo.avgFillPrice, venueOrderId: o.venueOrderId ?? String(++OID), revealAt: null });
  }
  function step(): void {
    const t = now();
    for (const a of ACCTS.values()) {
      for (const o of a.orders) if (!o.final && PRE.includes(o.state) && (o.expiresAt === null || o.expiresAt < t)) setOrder(a, o, { state: 'cancelled', final: true, reason: 'expired before approval; nothing was signed' });
      for (const x of a.actions) if (x.state === 'risk_checked' && x.expiresAt < t) { x.state = 'cancelled'; x.error = 'expired before approval'; x.updatedAt = t; emit(a.id, 'action', x); }
      if (!a.venue || UNREADABLE) continue;
      const ids = new Set([...a.venue.state.positions.map((p) => p.instrument), ...a.venue.openOrders().map((o) => o.instrument)]);
      for (const id of ids) { const s = env.sim(id); if (!s || !s.book || s.frozen) continue; env.fresh(s); a.venue.onTicker(s.ticker, t); a.venue.onBook(s.book, t); }
      for (const o of a.orders) reconcileOrder(a, o);
      snapshot(a);
      if (Math.floor(t / 1000) % 3 === 0) { const v = venueState(a); emit(a.id, 'account', { state: v.state, positions: v.positions, openOrders: v.openOrders, divergence: a.divergence, halt: a.halt, mode: a.mode, ts: t, source: 'venue' }); }
    }
  }

  // ------------------------------------------------------------------ orders: the backend's order of checks
  function check(a: LAcct, body: any, clientId: string) {
    const s0 = env.sim(String(body.instrument));
    if (!s0 || s0.inst.venue !== 'hyperliquid' || !s0.book) throw new Refuse('unknown_instrument', `unknown instrument ${body.instrument}`, 404);
    if (UNREADABLE || s0.frozen) throw new Refuse('venue_unavailable', 'hyperliquid: request timed out after 8000 ms', 503);
    const s = env.fresh(s0), inst = s.inst, book = s.book!, v = venueState(a), t = now();
    if (body.leverage !== undefined) throw new Refuse('bad_request', 'on a venue account the leverage of an instrument is a venue setting: change it with the leverage route (passkey)', 400);
    if ('clientId' in body || typeof body.size !== 'string' || !D.isValid(body.size) || !D.isPos(D.from(body.size)) || !['buy', 'sell'].includes(body.side)) throw new Refuse('bad_request', 'invalid order body', 400);
    let price: string | null = body.price === null || body.price === undefined ? null : canon(String(body.price));
    if (price === null && body.type === 'market' && typeof body.slippageBps === 'number') { const best = body.side === 'buy' ? book.asks[0] : book.bids[0]; if (!best) throw new Refuse('no_liquidity', 'the book has no level on that side', 503); price = env.worstPrice(best[0], body.side, body.slippageBps, inst.tickSize, inst.venue); }
    const req: OrderRequest = { instrument: inst.id, side: body.side, type: body.type, size: canon(body.size), price, triggerPrice: body.triggerPrice ? canon(String(body.triggerPrice)) : null, reduceOnly: body.reduceOnly ?? false, tif: body.type === 'market' ? 'ioc' : body.tif ?? 'gtc', clientId };
    const lev = a.leverage[inst.id] ?? { leverage: String(Math.min(20, Number(inst.maxLeverage))), marginMode: 'cross' as const };
    let risk: RiskResult | null = null;
    for (const [name, p] of [['price', req.price], ['trigger price', req.triggerPrice]] as const) { const why = p === null ? null : env.priceProblem(inst.venue, inst.tickSize, p); if (why && !risk) risk = { ok: false, code: 'price_not_on_tick', reason: `${name}: ${why}` }; }
    const day = Math.floor(t / 86_400_000) * 86_400_000, counted = a.orders.filter((o) => !(o.final && !o.signed));
    const realized = a.venue ? D.str(D.add(D.sub(D.from(a.venue.state.realizedPnl), D.from(a.venue.state.feesPaid)), D.from(a.venue.state.fundingNet))) : '0';
    risk ??= checkOrder({ ...a.policy, halt: effectiveHalt(a) }, req, { instrument: inst, account: v.state!, positions: v.positions, openOrders: v.openOrders, book, ticker: s.ticker, now: t,
      usage: { realizedToday: realized, realizedTotal: realized, ordersLastMinute: counted.filter((o) => o.createdAt > t - 60_000).length, ordersToday: counted.filter((o) => o.createdAt >= day).length, clientIds: [] }, leverage: lev.leverage });
    const cap = a.auth?.policy.maxOrderNotional;
    if (risk.ok && cap && req.price !== null) { const n = venueOrderNotional({ size: req.size, price: req.price, triggerPrice: req.triggerPrice });
      if (D.gt(D.from(n), D.from(cap))) risk = { ok: false, code: 'order_notional_exceeded', reason: `order notional ${n} exceeds the ${cap} the signer will sign per order (reduce-only orders included: close in smaller parts)` }; }
    return { s, inst, book, state: v.state!, positions: v.positions, lev, req, risk, now: t };
  }
  function estimate(c: ReturnType<typeof check>) {
    const price = c.req.price === null ? D.from(c.s.ticker.mark) : D.from(c.req.price), notional = D.mul(D.from(c.req.size), price), margin = c.req.reduceOnly ? D.zero : initialMargin(notional, D.from(c.lev.leverage));
    return { notional: D.str(notional), initialMargin: D.str(margin), fee: D.str(D.mul(notional, D.from('0.00045'))), feeNote: 'upper bound at the base taker rate (0.045 %); the real fee comes from the venue\'s fills',
      freeCollateralAfter: D.str(D.sub(D.from(c.state.freeCollateral), margin)), leverage: c.lev.leverage, marginMode: c.lev.marginMode, price: c.req.price, mark: c.s.ticker.mark, liquidationPrice: null,
      liquidationNote: 'not estimated before the order: the venue reports the liquidation price of the position once it exists', source: 'estimate' as const };
  }
  const proposalAnswer = (o: LOrder, idempotent: boolean, est: ReturnType<typeof estimate> | null = null) => { const v = orderView(o), approvable = o.state === 'risk_checked' && (o.expiresAt ?? 0) > now();
    return { order: v, canonical: v.canonical, hash: v.hash, expiresAt: v.expiresAt, estimate: est, idempotent, options: approvable && o.hash ? options(o.hash) : null }; };
  function propose(a: LAcct, body: any, key: string, origin: 'owner' | 'close' = 'owner') {
    const prior = a.orders.find((o) => o.clientId === key);
    if (prior) return proposalAnswer(prior, true);
    const stop = blocked(a, 'trade'); if (stop) throw stop;
    const c = check(a, body, key), { req, now: t } = c;
    const o: LOrder = { clientId: key, cloid: cloidOf(key), instrument: req.instrument, side: req.side, type: req.type, size: req.size, price: req.price, triggerPrice: req.triggerPrice, reduceOnly: req.reduceOnly, tif: req.tif, state: 'proposed', final: false,
      venueOrderId: null, filled: '0', avgFillPrice: null, reason: null, origin, hash: null, nonce: null, expiresAt: null, canonical: null, createdAt: t, updatedAt: t, submittedAt: null, signed: false, revealAt: null, req };
    a.orders.push(o);
    if (!c.risk.ok) { setOrder(a, o, { state: 'rejected', final: true, reason: `${c.risk.code}: ${c.risk.reason}`.slice(0, 500) }); riskEvent(a, 'order_refused', c.risk.code, c.risk.reason, { clientId: key, instrument: req.instrument, side: req.side, type: req.type, size: req.size, price: req.price, reduceOnly: req.reduceOnly, origin });
      throw new Refuse(c.risk.code, c.risk.reason, 422); }
    if (req.price === null) { setOrder(a, o, { state: 'rejected', final: true, reason: 'a price is required' }); throw new Refuse('venue_rejected', 'a price is required (limit price, or worst acceptable price of a market order)', 422); }
    const nonce = nextNonce(a);
    const canonical: VenueOrder = { v: 1, authorizationId: a.auth!.authorizationId, venue: 'hyperliquid', network: a.network, account: a.account, kind: 'order', instrument: req.instrument, side: req.side, type: (req.type === 'market' ? 'limit' : req.type) as VenueOrder['type'],
      size: req.size, price: req.price, triggerPrice: req.triggerPrice, reduceOnly: req.reduceOnly, tif: req.tif, clientId: o.cloid, nonce, expiresAt: nonce + TTL };
    setOrder(a, o, { state: 'risk_checked', canonical, hash: hex(venueOrderHash(canonical)), nonce, expiresAt: canonical.expiresAt });
    return proposalAnswer(o, false, estimate(c));
  }
  /** the simulated SIGNER: its own copy of the limits, its own price, the passkey over the hash */
  function signerRefusal(a: LAcct, hashHex: string, assertion: any, o?: LOrder): Refuse | null {
    if (SIGNER_DOWN) { SIGNER_DOWN = false; return new Refuse('signer_unreachable', 'the signer is unreachable; nothing was signed', 503); }
    let challenge = ''; try { challenge = JSON.parse(atob(String(assertion?.response?.clientDataJSON).replace(/-/g, '+').replace(/_/g, '/'))).challenge; } catch { /* not an assertion */ }
    if (challenge !== b64u(unhex(hashHex))) return new Refuse('signer_bad_approval', 'the passkey assertion does not approve this action (challenge mismatch)', 422);
    const vp = a.auth!.policy;
    if (!o?.canonical) return null;
    if (!vp.allowedInstruments.includes(o.instrument)) return new Refuse('signer_policy', `${o.instrument} is not allowed by the venue authorization`, 422);
    const n = venueOrderNotional(o.canonical);
    if (D.gt(D.from(n), D.from(vp.maxOrderNotional))) return new Refuse('signer_policy', `order notional ${n} exceeds the authorized ${vp.maxOrderNotional}`, 422);
    if (a.signedToday >= vp.maxOrdersPerDay) return new Refuse('signer_policy', `${vp.maxOrdersPerDay} orders already signed today`, 422);
    const s = env.sim(o.instrument), mid = s ? D.str(D.div(D.mul(D.from(s.ticker.mark), D.from(BigInt(10000 + OFFSET))), D.from(10000n), 6, 'half_even')) : null;
    if (!mid) return new Refuse('signer_no_price', `no exchange price for ${o.instrument}`, 422);
    for (const p of [o.canonical.price, o.canonical.triggerPrice]) if (p !== null && !withinBand(p, mid, vp.maxPriceDeviationBps)) return new Refuse('signer_price', `price ${p} is more than ${vp.maxPriceDeviationBps} bps away from the signer's own price ${mid}`, 422);
    return null;
  }
  function approveOrder(a: LAcct, key: string, assertion: unknown) {
    const o = a.orders.find((x) => x.clientId === key);
    if (!o) throw new Refuse('unknown_order', 'unknown order', 404);
    if (o.state !== 'risk_checked') return { order: orderView(o), idempotent: true };
    const stop = blocked(a, 'trade'); if (stop) throw stop;
    const halt = effectiveHalt(a);
    if (halt && !o.reduceOnly) throw new Refuse('halted', `trading is halted: ${halt}`, 423);
    if ((o.expiresAt ?? 0) <= now() + 2000) { setOrder(a, o, { state: 'cancelled', final: true, reason: 'the approval window expired before the passkey approval; nothing was signed' }); throw new Refuse('proposal_expired', 'this proposal has expired; propose the order again', 410); }
    setOrder(a, o, { state: 'authorized' });
    const no = signerRefusal(a, o.hash!, assertion, o);
    if (no) { setOrder(a, o, { state: 'rejected', final: true, reason: `not signed: ${no.message}` }); riskEvent(a, 'order_refused', no.code, `the signer did not sign the order: ${no.message}`, { clientId: key }); throw no; }
    a.signedToday += 1;
    setOrder(a, o, { state: 'signed', signed: true });
    const how = VENUE; VENUE = 'ok';
    if (how === 'reject') { setOrder(a, o, { state: 'rejected', final: true, submittedAt: now(), reason: 'refused by the venue: Order has invalid price.' }); return { order: orderView(o), idempotent: false }; }
    const s = env.fresh(env.sim(o.instrument)!);
    a.venue!.submit({ ...o.req!, clientId: o.cloid }, s.book!, s.ticker, now());
    if (how === 'unknown') { setOrder(a, o, { state: 'unknown', submittedAt: now(), revealAt: now() + 4000, reason: 'no usable answer from the venue (request timed out); the order may or may not exist — it is being looked up by its client id' });
      riskEvent(a, 'order_unknown', 'unknown', `order ${key}: the venue gave no usable answer; outcome unknown until reconciled`, { clientId: key }); return { order: orderView(o), idempotent: false }; }
    setOrder(a, o, { state: 'submitted', submittedAt: now(), venueOrderId: String(++OID) });
    reconcileOrder(a, o); snapshot(a);
    return { order: orderView(o), idempotent: false };
  }
  function cancelOrder(a: LAcct, key: string) {
    const o = a.orders.find((x) => x.clientId === key);
    if (!o) throw new Refuse('unknown_order', 'unknown order', 404);
    if (o.final) return { order: orderView(o), sent: false };
    if (PRE.includes(o.state)) { setOrder(a, o, { state: 'cancelled', final: true, reason: 'withdrawn before approval; nothing was signed' }); return { order: orderView(o), sent: false }; }
    if (o.state === 'authorized' || o.state === 'signed') throw new Refuse('bad_state', 'the order is being signed or sent right now; ask again in a moment', 409);
    const stop = blocked(a, 'stop'); if (stop) throw stop;
    const r = a.venue!.cancel(o.cloid, now());
    a.actions.push({ id: crypto.randomUUID(), kind: 'cancel', state: 'submitted', request: { clientId: key, cloid: o.cloid, instrument: o.instrument }, hash: null, nonce: nextNonce(a), expiresAt: now() + TTL, error: null, createdAt: now(), updatedAt: now() });
    o.revealAt = null; reconcileOrder(a, o);
    return { order: orderView(o), sent: true, venue: r.order ? { outcome: 'accepted' as const, error: null } : { outcome: 'refused' as const, error: 'Order was never placed, already canceled, or filled.' } };
  }
  function cancelAll(a: LAcct) {
    const stop = blocked(a, 'stop'); if (stop) throw stop;
    if (UNREADABLE) throw new Refuse('venue_unavailable', 'hyperliquid: request timed out after 8000 ms', 503);
    const open = venueState(a).openOrders; let accepted = 0;
    for (const x of open) { if (a.foreign.some((f) => f.clientId === x.clientId)) { a.foreign = a.foreign.filter((f) => f.clientId !== x.clientId); accepted += 1; } else if (a.venue!.cancel(x.clientId, now()).order) accepted += 1; }
    for (const o of a.orders) { o.revealAt = null; reconcileOrder(a, o); }
    return { requested: open.length, accepted, failed: [], remaining: venueState(a).openOrders, source: 'venue' as const, ts: now() };
  }
  function close(a: LAcct, body: any, key: string) {
    const prior = a.orders.find((o) => o.clientId === key);
    if (prior) return { ...proposalAnswer(prior, true), worstPrice: prior.price, slippageBoundBps: null };
    const stop = blocked(a, 'trade'); if (stop) throw stop;
    const s0 = env.sim(String(body.instrument)), pos = venueState(a).positions.find((p) => p.instrument === body.instrument);
    if (!s0 || !s0.book) throw new Refuse('unknown_instrument', `unknown instrument ${body.instrument}`, 404);
    if (!pos) throw new Refuse('no_position', `the venue reports no open position on ${body.instrument}`, 422);
    const s = env.fresh(s0), fr = D.from(String(body.fraction)), size = D.eq(fr, D.one) ? D.from(pos.size) : D.quantize(D.mul(D.from(pos.size), fr), D.from(s.inst.lotSize), 'down');
    if (!D.isPos(size)) throw new Refuse('below_min_size', `${body.fraction} of the position is less than one lot (${s.inst.lotSize})`, 422);
    const side = pos.side === 'long' ? 'sell' as const : 'buy' as const, bound = typeof body.slippageBps === 'number' ? body.slippageBps : 50, best = side === 'buy' ? s.book!.asks[0] : s.book!.bids[0];
    if (!best) throw new Refuse('no_liquidity', 'the book has no level on that side', 503);
    const price = env.worstPrice(best[0], side, bound, s.inst.tickSize, s.inst.venue);
    return { ...propose(a, { instrument: s.inst.id, side, type: 'market', size: D.str(size), price, reduceOnly: true, tif: 'ioc' }, key, 'close'), worstPrice: price, slippageBoundBps: bound, position: pos };
  }

  // ------------------------------------------------------------------ authorization
  function prepare(a: LAcct, body: any) {
    if (a.network === 'mainnet' && !MAINNET) throw new Refuse('mainnet_disabled', MAINNET_OFF, 403);
    if (a.mode !== 'READ_ONLY') throw new Refuse('bad_state', 'an authorization is already active on this venue account: revoke it to change its limits', 409);
    const pol = VenuePolicySchema.safeParse(body.policy);
    if (!pol.success || !Number.isInteger(body.days) || body.days < 1 || body.days > VENUE_AUTH_MAX_DAYS || !['fr', 'en'].includes(body.locale)) throw new Refuse('bad_request', 'invalid authorization body', 400);
    for (const inst of pol.data.allowedInstruments) if (!HL_PINNED_ASSETS[a.network].some((x) => `hyperliquid:${x.symbol}` === inst)) throw new Refuse('bad_policy', `${inst} is not in the pinned ${a.network} asset table: it cannot be allowed`, 400);
    const nowMs = now(), nowS = Math.floor(nowMs / 1000), ack = jurisdictionAck('hyperliquid', body.locale);
    const authorization: VenueAuthorization = { v: 1, authorizationId: crypto.randomUUID(), keyId: 'mock-signer-key-0001', venue: 'hyperliquid', network: a.network, account: a.account, agentAddress: a.agentAddress, agentName: 'spw-live', mode: 'MANUAL_LIVE',
      policy: pol.data, createdAt: nowS, expiresAt: nowS + body.days * 86400, approveNonce: nowMs, ackSha256: ack.sha256 };
    try { validateVenueAuthorization(authorization, nowS); } catch (e) { throw new Refuse('bad_policy', e instanceof Error ? e.message : String(e), 400); }
    const hash = hex(venueAuthorizationHash(authorization));
    a.pending = { authorization, preparedAt: nowMs }; a.updatedAt = nowMs;
    return { authorization, hash, acknowledgement: ack,
      agent: { address: a.agentAddress, name: authorization.agentName, wireName: venueAgentWireName(authorization), validUntil: authorization.expiresAt * 1000, can: mockLiveTexts(body.locale).can, cannot: mockLiveTexts(body.locale).cannot, note: mockLiveTexts(body.locale).agentNote },
      whatIsSigned: { byMainKey: mockLiveTexts(body.locale).byMainKey, byPasskey: mockLiveTexts(body.locale).byPasskey }, locale: body.locale as MockLocale,   // v7: the body's locale selects the language of the server's sentences
      venueState: venueState(a), options: options(hash), ts: nowMs };
  }
  function approveAuthorization(a: LAcct, body: any) {
    if (a.network === 'mainnet' && !MAINNET) throw new Refuse('mainnet_disabled', MAINNET_OFF, 403);
    if (a.mode !== 'READ_ONLY') throw new Refuse('bad_state', 'an authorization is already active on this venue account', 409);
    if (body.acknowledged !== true) throw new Refuse('bad_request', 'the acknowledgement must be confirmed', 400);
    const p = a.pending; if (!p) throw new Refuse('bad_state', 'prepare the authorization first', 409);
    a.pending = null;
    const hash = hex(venueAuthorizationHash(p.authorization)), no = signerRefusal({ ...a, auth: p.authorization }, hash, body.assertion);
    if (no) throw no;
    // the venue's documented answer to any action of an account that never deposited (recorded on testnet, 2026-11-11)
    if (!a.venue) throw new Refuse('venue_rejected', `the venue did not register the trading key: hyperliquid: Must deposit before performing actions. User: ${a.account} — the authorization was revoked on the signer, nothing can trade. Fund the venue account first if the venue asks for a deposit, then prepare a new authorization.`, 422);
    Object.assign(a, { mode: 'MANUAL_LIVE', auth: p.authorization, authHash: hash, policy: liveRiskPolicy(p.authorization.policy, a.network), halt: null, divergence: null, authorizedAt: now(), revokedAt: null, updatedAt: now(), signedToday: 0 });
    emit(a.id, 'status', { mode: 'MANUAL_LIVE', ts: now() });
    return detail(a);
  }
  function revoke(a: LAcct, body: any) {
    let cancelled: ReturnType<typeof cancelAll> | null = null;
    if (body.cancelOpenOrders && a.mode === 'MANUAL_LIVE') { try { cancelled = cancelAll(a); } catch { cancelled = null; } }
    const had = !!a.auth;
    Object.assign(a, { mode: 'READ_ONLY', policy: { ...a.policy, mode: 'READ_ONLY' }, pending: null, revokedAt: had ? now() : a.revokedAt, updatedAt: now() });
    if (a.mandate && a.mandate.revokedAt === null) a.mandate.revokedAt = now();   // v7: revoking the authorization also revokes its mandate (no wind-down: the root is gone)
    a.pendingMandate = null;
    for (const o of a.orders) if (!o.final && PRE.includes(o.state)) setOrder(a, o, { state: 'cancelled', final: true, reason: 'withdrawn: the venue authorization was revoked before approval' });
    emit(a.id, 'status', { mode: 'READ_ONLY', ts: now() });
    const v = venueState(a);
    return { ...detail(a), cancelled, warning: v.openOrders.length ? (body.locale === 'fr'
      ? `${v.openOrders.length} ordre(s) restent sur la plateforme. Le portefeuille ne peut plus les annuler (une autorisation révoquée ne signe rien) : annulez-les dans l'interface de la plateforme, ou approuvez une nouvelle autorisation puis annulez-les.`
      : `${v.openOrders.length} order(s) still rest on the venue. The wallet can no longer cancel them (a revoked authorization signs nothing): cancel them in the venue's own interface, or approve a new authorization and cancel.`) : null,
      cancelError: null, locale: (body.locale === 'fr' ? 'fr' : 'en') as MockLocale, venueAgent: mockLiveTexts(body.locale === 'fr' ? 'fr' : 'en').venueAgent };
  }
  function proposeLeverage(a: LAcct, body: any) {
    const stop = blocked(a, 'trade'); if (stop) throw stop;
    const halt = effectiveHalt(a); if (halt) throw new Refuse('halted', `trading is halted: ${halt}`, 423);
    const s = env.sim(String(body.instrument)); if (!s) throw new Refuse('unknown_instrument', `unknown instrument ${body.instrument}`, 404);
    const vp = a.auth!.policy, mode = body.marginMode === 'isolated' ? 'isolated' as const : 'cross' as const;
    if (!Number.isInteger(body.leverage) || body.leverage < 1 || body.leverage > VENUE_POLICY_BOUNDS.maxLeverage) throw new Refuse('bad_request', 'invalid leverage', 400);
    if (!vp.allowedInstruments.includes(s.inst.id)) throw new Refuse('instrument_not_allowed', `${s.inst.id} is not allowed by the authorization`, 422);
    if (body.leverage > vp.maxLeverage || body.leverage > Number(a.policy.maxLeverage)) throw new Refuse('leverage_exceeded', `leverage ${body.leverage} is above the authorized maximum (${Math.min(vp.maxLeverage, Number(a.policy.maxLeverage))})`, 422);
    const nonce = nextNonce(a), canonical: VenueLeverage = { v: 1, authorizationId: a.auth!.authorizationId, venue: 'hyperliquid', network: a.network, account: a.account, kind: 'leverage', instrument: s.inst.id, leverage: body.leverage, marginMode: mode, nonce, expiresAt: nonce + TTL };
    const hash = hex(venueLeverageHash(canonical)), action: LAction = { id: crypto.randomUUID(), kind: 'leverage', state: 'risk_checked', request: canonical as unknown as Record<string, unknown>, hash, nonce, expiresAt: canonical.expiresAt, error: null, createdAt: now(), updatedAt: now() };
    a.actions.push(action);
    return { action, canonical, hash, current: a.leverage[s.inst.id] ?? { leverage: String(Math.min(20, Number(s.inst.maxLeverage))), marginMode: 'cross' }, expiresAt: canonical.expiresAt, options: options(hash) };
  }
  function approveLeverage(a: LAcct, actionId: string, assertion: unknown) {
    const x = a.actions.find((y) => y.id === actionId && y.kind === 'leverage');
    if (!x) throw new Refuse('unknown_action', 'unknown leverage change', 404);
    if (x.state !== 'risk_checked') return { action: x, idempotent: true, venue: null };
    const stop = blocked(a, 'trade'); if (stop) throw stop;
    if (effectiveHalt(a)) throw new Refuse('halted', `trading is halted: ${effectiveHalt(a)}`, 423);
    if (x.expiresAt <= now() + 2000) { x.state = 'cancelled'; x.error = 'expired before approval'; throw new Refuse('proposal_expired', 'this proposal has expired; propose it again', 410); }
    const no = signerRefusal(a, x.hash!, assertion);
    if (no) { x.state = 'rejected'; x.error = `not signed: ${no.message}`; x.updatedAt = now(); emit(a.id, 'action', x); throw no; }
    const c = x.request as unknown as VenueLeverage;
    a.leverage[c.instrument] = { leverage: String(c.leverage), marginMode: c.marginMode };
    if (a.venue) a.venue.state.config.leverageByInstrument[c.instrument] = String(c.leverage);
    x.state = 'confirmed'; x.updatedAt = now(); emit(a.id, 'action', x);
    return { action: x, idempotent: false, venue: { leverage: a.leverage[c.instrument], confirmed: true, source: 'venue' as const } };
  }

  // >>> v7 perp live ------------------------------------------------------------ MANDATE_LIVE (exec.ts, end of LiveService)
  /** SPW_DERIV_MANDATE_MAINNET: OFF, and this mock offers no way to turn it on (it is a server setting, not a switch) */
  const MANDATE_MAINNET: boolean = false;
  function config(locale: MockLocale) {
    const mandateMainnet = MAINNET && MANDATE_MAINNET, t = now();
    return { mainnetEnabled: MAINNET, locale, mainnet: { enabled: MAINNET, code: MAINNET ? null : 'mainnet_disabled', reason: MAINNET ? null : mockLiveReasons.mainnet_disabled[locale] },
      venues: [{ venue: 'hyperliquid', networks: ['testnet', 'mainnet'] }], modes: ['READ_ONLY', 'MANUAL_LIVE', 'MANDATE_LIVE'],
      mandateLive: { available: true, code: null, reason: null, mainnet: { enabled: mandateMainnet, code: mandateMainnet ? null : 'mandate_mainnet_disabled', reason: mandateMainnet ? null : mockLiveReasons.mandate_mainnet_disabled[locale] },
        bounds: { ...VENUE_MANDATE_BOUNDS, windDownSeconds: VENUE_MANDATE_WIND_DOWN_S, orderTtlMs: 30_000 } },
      reasons: mockLiveReasons,
      pinnedAssets: { pinnedAt: HL_PINNED_AT, mainnet: HL_PINNED_ASSETS.mainnet.map((x) => ({ instrument: `hyperliquid:${x.symbol}`, maxLeverage: x.maxLeverage })), testnet: HL_PINNED_ASSETS.testnet.map((x) => ({ instrument: `hyperliquid:${x.symbol}`, maxLeverage: x.maxLeverage })) },
      bounds: { ...VENUE_POLICY_BOUNDS, maxAuthorizationDays: VENUE_AUTH_MAX_DAYS, orderApprovalTtlMs: 90_000 }, ts: t };
  }
  function mandateLock(a: LAcct): Refuse | null {
    if (a.network !== 'mainnet') return null;
    if (!MAINNET) return new Refuse('mainnet_disabled', MAINNET_OFF, 403);
    if (!MANDATE_MAINNET) return new Refuse('mandate_mainnet_disabled', mockLiveReasons.mandate_mainnet_disabled.en, 403);
    return null;
  }
  function prepareMandate(a: LAcct, body: any) {
    const lock = mandateLock(a) ?? blocked(a, 'trade'); if (lock) throw lock;
    if (mandatePhase(a)?.phase === 'active') throw new Refuse('bad_state', 'a mandate is already active on this venue account: revoke it to change its limits', 409);
    const locale: MockLocale = body.locale === 'fr' ? 'fr' : 'en', auth = a.auth!, nowMs = now(), nowS = Math.floor(nowMs / 1000), ack = jurisdictionAck('hyperliquid', locale);
    if (!Number.isInteger(body.days) || body.days < 1 || body.days > VENUE_MANDATE_BOUNDS.maxDays) throw new Refuse('bad_request', 'invalid mandate body', 400);
    const parsed = VenueMandateSchema.safeParse({ v: 1, mandateId: crypto.randomUUID(), authorizationId: auth.authorizationId, keyId: auth.keyId, venue: 'hyperliquid', network: a.network, account: a.account, agentAddress: a.agentAddress,
      strategySha256: body.strategySha256, agentId: body.agentId, instruments: body.instruments, maxOrderNotional: body.maxOrderNotional, maxGrossExposure: body.maxGrossExposure, maxOrdersPerDay: body.maxOrdersPerDay, maxOrdersPerHour: body.maxOrdersPerHour,
      maxDailyTurnover: body.maxDailyTurnover, floorEquity: body.floorEquity, maxPriceDeviationBps: body.maxPriceDeviationBps ?? auth.policy.maxPriceDeviationBps, createdAt: nowS, expiresAt: nowS + body.days * 86400, ackSha256: ack.sha256 });
    if (!parsed.success) throw new Refuse('bad_request', 'invalid mandate body', 400);
    const mandate = parsed.data;
    try { validateVenueMandate(mandate, auth, nowS); } catch (e) { throw new Refuse('bad_policy', e instanceof Error ? e.message : String(e), 400); }
    for (const i of mandate.instruments) { const pin = HL_PINNED_ASSETS[a.network].find((x) => `hyperliquid:${x.symbol}` === i.instrument); if (!pin || i.maxLeverage > pin.maxLeverage) throw new Refuse('bad_policy', `${i.instrument}: not in the pinned ${a.network} asset table, or leverage above the venue maximum`, 400); }
    const hash = hex(venueMandateHash(mandate)), t = mockLiveTexts(locale);
    a.pendingMandate = { mandate, hash, preparedAt: nowMs };
    return { mandate, hash, acknowledgement: ack, locale, authorization: { id: auth.authorizationId, hash: a.authHash, expiresAt: auth.expiresAt * 1000, policy: auth.policy }, warning: t.mandateWarning,
      enforcedBySigner: t.enforcedBySigner, trustedBySigner: t.trustedBySigner, notEnforced: t.notEnforced, windDown: { seconds: VENUE_MANDATE_WIND_DOWN_S, text: t.windDown }, whatIsSigned: { byPasskey: t.mandateByPasskey },
      venueState: venueState(a), options: options(hash), ts: nowMs };
  }
  function approveMandate(a: LAcct, body: any) {
    const lock = mandateLock(a) ?? blocked(a, 'trade'); if (lock) throw lock;
    if (body.acknowledged !== true) throw new Refuse('bad_request', 'the acknowledgement must be confirmed', 400);
    const p = a.pendingMandate; if (!p) throw new Refuse('bad_state', 'prepare the mandate first', 409);
    a.pendingMandate = null;                                   // a refused approval consumes the preparation
    const no = signerRefusal(a, p.hash, body.assertion); if (no) throw no;
    a.mandate = { mandate: p.mandate, hash: p.hash, approvedAt: now(), revokedAt: null }; a.mstats = { orders: 0, reduceOnly: 0, cancels: 0, leverage: 0, turnover: '0', stamps: [] }; a.updatedAt = now();
    emit(a.id, 'status', { mode: a.mode, modes: ['MANUAL_LIVE', 'MANDATE_LIVE'], mandate: p.mandate.mandateId, ts: now() });
    return detail(a);
  }
  function revokeMandate(a: LAcct, body: any) {
    if (!a.mandate) throw new Refuse('bad_state', 'this venue account has no mandate', 409);
    if (a.mandate.revokedAt === null) { a.mandate.revokedAt = now(); riskEvent(a, 'mandate_revoked', null, 'the derivative mandate was revoked: no order that can add exposure is signed any more', { mandateId: a.mandate.mandate.mandateId }); }
    let cancelled: ReturnType<typeof cancelAll> | null = null, cancelError: { code: string; message: string } | null = null;
    if (body?.cancelOpenOrders) { try { cancelled = cancelAll(a); } catch (e) { cancelError = { code: e instanceof Refuse ? e.code : 'internal', message: e instanceof Error ? e.message : String(e) }; } }
    const locale: MockLocale = body?.locale === 'fr' ? 'fr' : 'en', v = venueState(a);
    emit(a.id, 'status', { mode: a.mode, modes: [a.mode], mandate: null, ts: now() });
    return { ...detail(a), cancelled, cancelError, locale, windDown: { until: mandatePhase(a)?.windDownUntil ?? null, text: mockLiveTexts(locale).windDown, openPositions: v.positions.length, openOrders: v.openOrders.length } };
  }
  function signerMandate(a: LAcct) {
    const m = a.mandate, ph = mandatePhase(a), st = a.mstats;
    if (!m || !ph || !st) return null;
    return { mandate: m.mandate, hash: m.hash, approvedAt: m.approvedAt, revoked: m.revokedAt !== null, revokedAt: m.revokedAt, expired: now() >= m.mandate.expiresAt * 1000, phase: ph.phase,
      windDownUntil: ph.windDownUntil === null ? null : Math.floor(ph.windDownUntil / 1000), today: { orders: st.orders, reduceOnly: st.reduceOnly, cancels: st.cancels, leverage: st.leverage, turnover: st.turnover },
      ordersLastHour: st.stamps.filter((x) => x > now() - 3_600_000).length, pendingOrders: 0 };
  }
  function mandateStatus(a: LAcct) { return { ...mandateInfo(a), signer: signerMandate(a), ts: now() }; }
  /**
   * ONE order of the agent runtime under the mandate (no passkey; there is no HTTP route to this). A market order as the venue
   * takes it: limit IOC at a worst price. The simulated signer applies the mandate's phase, order notional, position limit,
   * hourly count and floor; a refusal is thrown with the backend's `signer_<code>` and stored as a rejected order.
   */
  function placeMandate(a: LAcct, o: { instrument: string; side: 'buy' | 'sell'; size: string; reduceOnly: boolean; clientId: string; slippageBps?: number }) {
    const prior = a.orders.find((x) => x.clientId === o.clientId); if (prior) return orderView(prior);
    const lock = mandateLock(a) ?? blocked(a, 'trade'); if (lock) throw lock;
    const ph = mandatePhase(a), m = a.mandate?.mandate, st = a.mstats;
    if (!ph || !m || !st || ph.phase === 'ended') throw new Refuse('mandate_none', 'no derivative mandate is in force on this venue account: the owner approves one with his passkey', 422);
    const s = env.fresh(env.sim(o.instrument)!), best = o.side === 'buy' ? s.book!.asks[0]! : s.book!.bids[0]!, price = env.worstPrice(best[0], o.side, o.slippageBps ?? 30, s.inst.tickSize, s.inst.venue), t = now();
    const req: OrderRequest = { instrument: o.instrument, side: o.side, type: 'market', size: canon(o.size), price, triggerPrice: null, reduceOnly: o.reduceOnly, tif: 'ioc', clientId: o.clientId };
    const nonce = nextNonce(a), cloid = cloidOf(o.clientId);
    const canonical: VenueOrder = { v: 1, authorizationId: a.auth!.authorizationId, venue: 'hyperliquid', network: a.network, account: a.account, kind: 'order', instrument: o.instrument, side: o.side, type: 'limit', size: req.size, price, triggerPrice: null,
      reduceOnly: o.reduceOnly, tif: 'ioc', clientId: cloid, nonce, expiresAt: nonce + 30_000 };
    const row: LOrder = { clientId: o.clientId, cloid, instrument: o.instrument, side: o.side, type: 'market', size: req.size, price, triggerPrice: null, reduceOnly: o.reduceOnly, tif: 'ioc', state: 'authorized', final: false, venueOrderId: null, filled: '0',
      avgFillPrice: null, reason: null, origin: 'mandate', hash: hex(venueOrderHash(canonical)), nonce, expiresAt: canonical.expiresAt, canonical, createdAt: t, updatedAt: t, submittedAt: null, signed: false, revealAt: null, req };
    a.orders.push(row);
    const notional = venueOrderNotional(canonical), mi = m.instruments.find((i) => i.instrument === o.instrument), v = venueState(a), pos = v.positions.find((p) => p.instrument === o.instrument);
    const held = pos ? D.mul(D.from(pos.size), D.from(s.ticker.mark)) : D.zero, adds = !o.reduceOnly;
    const no = (code: string, message: string): never => { setOrder(a, row, { state: 'rejected', final: true, reason: `not signed: ${message}` }); riskEvent(a, 'order_refused', `signer_${code}`, `the signer did not sign the mandate order: ${message}`, { clientId: o.clientId, origin: 'mandate', agentId: m.agentId }); throw new Refuse(`signer_${code}`, message, 422); };
    if (!mi) return no('instrument', `${o.instrument} is not allowed by the mandate`);
    if (D.gt(D.from(notional), D.from(m.maxOrderNotional))) return no('order_notional', `order notional ${notional} exceeds the mandate's ${m.maxOrderNotional}`);
    if (adds && ph.phase !== 'active') return no(a.mandate!.revokedAt !== null ? 'revoked' : 'expired', 'the mandate is no longer active: only cancels and reduce-only orders are signed during the wind-down');
    if (adds && st.stamps.filter((x) => x > t - 3_600_000).length >= m.maxOrdersPerHour) return no('orders_hour', `${m.maxOrdersPerHour} orders already signed in the last hour`);
    if (adds && D.lt(D.from(v.state!.equity), D.from(m.floorEquity))) return no('floor_equity', `account value ${v.state!.equity} is below the mandate's floor ${m.floorEquity}`);
    if (adds && D.gt(D.add(held, D.from(notional)), D.from(mi.maxPositionNotional))) return no('position_exceeded', `worst-case ${o.instrument.slice(o.instrument.indexOf(':') + 1)} position ${D.str(D.quantize(D.add(held, D.from(notional)), D.from('0.01'), 'up'))} exceeds the mandate's ${mi.maxPositionNotional}`);
    if (adds) { st.orders += 1; st.turnover = D.str(D.add(D.from(st.turnover), D.from(notional))); st.stamps.push(t); } else st.reduceOnly += 1;
    setOrder(a, row, { state: 'signed', signed: true });
    a.venue!.submit({ ...req, clientId: cloid }, s.book!, s.ticker, t);
    setOrder(a, row, { state: 'submitted', submittedAt: t, venueOrderId: String(++OID) });
    reconcileOrder(a, row); snapshot(a);
    return orderView(row);
  }
  // <<< v7 perp live

  // ------------------------------------------------------------------ HTTP
  const P = '/derivatives/live';
  function handle(method: string, path: string, b: any, headers: Headers, q?: URLSearchParams): Out {
    const p = path.slice(P.length), t = now(), ok = (json: unknown): Out => ({ status: 200, json }), locale: MockLocale = q?.get('locale') === 'fr' ? 'fr' : 'en';
    if (p === '/config') return ok(config(locale));   // v7: the V6 shape, in the requested locale
    if (p === '/jurisdiction') return ok({ venue: 'hyperliquid', fr: jurisdictionAck('hyperliquid', 'fr'), en: jurisdictionAck('hyperliquid', 'en') });
    if (p === '/venue-key') { if (b.venue !== 'hyperliquid') throw new Refuse('unknown_venue', 'live trading exists on Hyperliquid only', 404); const n = b.network as Net; if (!AGENT[n]) throw new Refuse('bad_request', 'unknown network', 400); return ok({ venue: 'hyperliquid', network: n, address: AGENT[n], path: PATHS[n], account: WALLET }); }
    if (p === '/accounts' && method === 'GET') return ok({ accounts: [...ACCTS.values()].map(summary), ts: t });
    if (p === '/accounts' && method === 'POST') {
      const n = b.network as Net;
      if (b.venue !== 'hyperliquid' || !AGENT[n]) throw new Refuse('bad_request', 'invalid account body', 400);
      let a = [...ACCTS.values()].find((x) => x.network === n);
      if (!a) { a = { id: crypto.randomUUID(), network: n, label: String(b.label ?? 'Hyperliquid').trim().slice(0, 60) || 'Hyperliquid', account: WALLET, agentAddress: AGENT[n], mode: 'READ_ONLY', policy: READ_ONLY_POLICY, halt: null, divergence: null, pending: null, auth: null, authHash: null,
        authorizedAt: null, revokedAt: null, createdAt: t, updatedAt: t, venue: D.isPos(D.from(FUND[n])) ? newVenue({ account: WALLET }, FUND[n]) : null, foreign: [], orders: [], actions: [], events: [], equity: [], lastNonce: 0, leverage: {}, signedToday: 0 };
        ACCTS.set(a.id, a); snapshot(a); }
      return ok(detail(a));
    }
    const m = /^\/accounts\/([^/]+)(\/.*)?$/.exec(p), a = m ? ACCTS.get(decodeURIComponent(m[1]!)) : undefined;
    if (!m || !a) throw new Refuse('unknown_account', 'unknown venue account', 404);
    const rest = m[2] ?? '', key = headers.get('idempotency-key');
    const needKey = (): string => { if (!key || !IDEM.test(key)) throw new Refuse('idempotency', 'an Idempotency-Key header (8 to 100 characters: letters, digits, . _ : -) is required', 400); return key; };
    if (rest === '' && method === 'GET') return ok(detail(a));
    if (rest === '/collateral') { const v = venueState(a); return ok({ account: a.account, network: a.network, equity: v.state?.equity ?? null, collateral: v.state?.collateral ?? null, freeCollateral: v.state?.freeCollateral ?? null, marginUsed: v.state?.marginUsed ?? null,
      withdrawable: v.state?.withdrawable ?? null, asset: 'USDC', error: v.error, ts: v.ts, source: 'venue', locale,
      deposits: { supported: a.network === 'mainnet', how: mockLiveTexts(locale).depositsHow }, withdrawals: { supported: true, how: mockLiveTexts(locale).withdrawalsHow } }); }
    // deposit / withdraw: simulated by mockCollateral.ts (time stands in for the chain and the venue; see its header for what is real)
    if (rest.startsWith('/collateral/')) return ok(COLLATERAL.handle(method, rest.slice('/collateral'.length), b, a));
    // >>> v7 perp live: MANDATE_LIVE routes (no route places a mandate order)
    if (rest === '/mandate' && method === 'GET') return ok(mandateStatus(a));
    if (rest === '/mandate/prepare') return ok(prepareMandate(a, b));
    if (rest === '/mandate/approve') return ok(approveMandate(a, b));
    if (rest === '/mandate/revoke') return ok(revokeMandate(a, b));
    // <<< v7 perp live
    if (rest === '/authorization/prepare') return ok(prepare(a, b));
    if (rest === '/authorization/approve') return ok(approveAuthorization(a, b));
    if (rest === '/authorization/revoke') return ok(revoke(a, b));
    if (rest === '/orders/preview') { const stop = blocked(a, 'trade'); if (stop) throw stop; const c = check(a, b, 'preview'); return ok({ risk: c.risk, estimate: estimate(c), request: c.req, venueState: { state: c.state, positions: c.positions, source: 'venue' }, ts: c.now }); }
    if (rest === '/orders') return ok(propose(a, b, needKey()));
    const ap = /^\/orders\/([^/]+)\/(approve|cancel)$/.exec(rest);
    if (ap) return ok(ap[2] === 'approve' ? approveOrder(a, decodeURIComponent(ap[1]!), b.assertion) : cancelOrder(a, decodeURIComponent(ap[1]!)));
    if (rest === '/leverage') return ok(proposeLeverage(a, b));
    const lv = /^\/leverage\/([^/]+)\/approve$/.exec(rest);
    if (lv) return ok(approveLeverage(a, decodeURIComponent(lv[1]!), b.assertion));
    if (rest === '/halt') { const text = `halted by the owner${b.reason ? `: ${String(b.reason).slice(0, 200)}` : ''} (${new Date(t).toISOString()})`; a.halt = text; a.updatedAt = t; let n = 0;
      for (const o of a.orders) if (!o.final && PRE.includes(o.state) && !o.reduceOnly) { setOrder(a, o, { state: 'cancelled', final: true, reason: 'withdrawn: trading was halted before approval' }); n += 1; }
      riskEvent(a, 'halt', 'halted', text, { withdrawnProposals: n }); emit(a.id, 'status', { halt: text, ts: t });
      return ok({ ...detail(a), note: 'New orders are stopped. Resting orders are still on the venue (cancel-all is a separate action) and positions are still open (close is a separate action).' }); }
    if (rest === '/resume') { a.halt = null; a.updatedAt = t; riskEvent(a, 'resume', null, 'owner halt lifted'); emit(a.id, 'status', { halt: null, ts: t }); return ok(detail(a)); }
    if (rest === '/cancel-all') return ok(cancelAll(a));
    if (rest === '/close') return ok(close(a, b, key && IDEM.test(key) ? key : `close-${crypto.randomUUID()}`));
    if (rest === '/rebase') { a.divergence = a.foreign.length ? a.divergence : null; a.updatedAt = t; riskEvent(a, 'divergence_rebased', null, 'the owner accepted the venue\'s present positions as the reference'); emit(a.id, 'status', { divergence: a.divergence, ts: t }); return ok(detail(a)); }
    if (rest === '/reconcile') { for (const o of a.orders) { if (o.state === 'unknown') o.revealAt = null; reconcileOrder(a, o); }
      if (a.divergence && /^order /.test(a.divergence) && !a.foreign.length) { a.divergence = null; riskEvent(a, 'divergence_cleared', null, 'the venue\'s state and the wallet\'s records agree again'); }
      return ok({ reconciled: a.orders.filter((o) => !o.final).length, fills: 0, funding: 0, divergence: a.divergence, account: detail(a) }); }
    if (rest === '/policy') throw new Refuse('bad_policy', 'not simulated: the mock keeps the policy derived from the authorization', 400);
    throw new Refuse('not_found', 'unknown route', 404);
  }

  const hooks: LiveHooks = {
    mainnet: (on) => { MAINNET = on; },
    fund: (network, usdc) => { FUND[network] = usdc; const a = [...ACCTS.values()].find((x) => x.network === network); if (a && !a.venue && D.isPos(D.from(usdc))) { a.venue = newVenue(a, usdc); snapshot(a); } },
    passkey: (next) => { PASSKEY = next; }, venue: (next) => { VENUE = next; }, signerOffsetBps: (bps) => { OFFSET = Math.round(bps); }, signerDown: () => { SIGNER_DOWN = true; }, ttl: (ms) => { TTL = ms; },
    diverge: (network, kind) => { const a = [...ACCTS.values()].find((x) => x.network === network); if (!a) return;
      if (kind === 'order') { const s = env.sim('hyperliquid:BTC')!, px = env.worstPrice(s.ticker.mark, 'sell', 400, s.inst.tickSize, 'hyperliquid'), id = String(++OID);
        a.foreign.push({ instrument: 'hyperliquid:BTC', side: 'buy', type: 'limit', size: '0.001', price: px, triggerPrice: null, reduceOnly: false, tif: 'gtc', clientId: `0x${'f'.repeat(32)}`, venueOrderId: id, status: 'open', filled: '0', avgFillPrice: null, createdAt: now(), updatedAt: now(), rejectReason: null });
        a.divergence = `order ${id} on hyperliquid:BTC rests on the venue and was not placed by the wallet`; }
      else a.divergence = 'position hyperliquid:BTC: venue 0.002, wallet records 0';
      riskEvent(a, 'divergence', 'state_divergence', `the venue's state and the wallet's records differ: ${a.divergence}. New orders are stopped until it clears.`); emit(a.id, 'status', { divergence: a.divergence, ts: now() }); },
    settle: (network) => { const a = [...ACCTS.values()].find((x) => x.network === network); if (a) a.foreign = []; },
    unreadable: (on) => { UNREADABLE = on; },
    accounts: () => [...ACCTS.values()].map((a) => ({ id: a.id, network: a.network, mode: a.mode, orders: a.orders.length })),
    collateral: COLLATERAL.hooks,
  };

  /** the simulated passkey: answers after a pause, with an assertion that carries the challenge it was asked to sign */
  function installPasskey(): void {
    const c = navigator.credentials as CredentialsContainer | undefined;
    if (!c) return;
    const real = c.get.bind(c), bytes = (n: number) => new Uint8Array(n).buffer;
    const get = async (o?: CredentialRequestOptions): Promise<Credential | null> => {
      if (!o?.publicKey) return real(o);
      await new Promise((r) => setTimeout(r, 350));
      const how = PASSKEY; PASSKEY = 'ok';
      if (how === 'cancel') throw new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError');
      const ch = new Uint8Array(o.publicKey.challenge as ArrayBuffer), challenge = how === 'bad' ? b64u(new Uint8Array(32)) : b64u(ch);
      const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge, origin: location.origin, crossOrigin: false })).buffer;
      return { id: 'bW9jay1wYXNza2V5', rawId: bytes(12), type: 'public-key', authenticatorAttachment: 'platform', response: { authenticatorData: bytes(37), clientDataJSON, signature: bytes(70), userHandle: null }, getClientExtensionResults: () => ({}) } as unknown as Credential;
    };
    try { Object.defineProperty(c, 'get', { value: get, configurable: true, writable: true }); } catch { /* the real prompt stays */ }
  }

  // >>> v7 perp live: what the agent mock (mockPerpLive.ts) needs from the simulated live engine — the stand-in of services/api/src/derivatives/mandate.ts
  const agentSide = {
    accounts: () => [...ACCTS.values()], get: (id: string) => ACCTS.get(id), summary, detail, config, venueState, mandateInfo, mandateStatus, prepareMandate, approveMandate, revokeMandate, placeMandate, mandateLock, blocked: (a: LAcct) => blocked(a, 'trade'),
    mainnet: () => MAINNET,
    /** test scenarios: a funded account authorized without the screens (the canonical authorization is the real one) */
    force(network: Net, policy: VenuePolicy, days = 30): LAcct {
      if (network === 'mainnet') MAINNET = true;
      handle('POST', `${P}/accounts`, { venue: 'hyperliquid', network, label: network === 'testnet' ? 'Hyperliquid testnet' : 'Hyperliquid mainnet' }, new Headers());
      const a = [...ACCTS.values()].find((x) => x.network === network)!;
      if (!a.venue) { a.venue = newVenue(a, D.isPos(D.from(FUND[network])) ? FUND[network] : '1000'); snapshot(a); }
      if (a.mode !== 'MANUAL_LIVE') { const p = prepare(a, { policy, days, locale: 'fr' }); a.pending = null;
        Object.assign(a, { mode: 'MANUAL_LIVE', auth: p.authorization, authHash: p.hash, policy: liveRiskPolicy(p.authorization.policy, a.network), halt: null, divergence: null, authorizedAt: now(), revokedAt: null, updatedAt: now(), signedToday: 0 }); }
      return a;
    },
  };
  // <<< v7 perp live
  return {
    hooks, step, installPasskey, agentSide,
    isStream: (url: string) => /\/api\/v1\/derivatives\/live\/accounts\/[^/]+\/stream/.test(url),
    route(method: string, path: string, b: any, headers: Headers, q?: URLSearchParams): Out {
      try { return handle(method, path, b, headers, q); }
      catch (e) { if (e instanceof Refuse) return { status: e.status, json: { error: e.code, message: e.message } }; throw e; }
    },
    /** `status` and `account` first, then every event of the account, as the backend's stream does */
    subscribe(url: string, send: (event: string, data: unknown) => void): () => void {
      const id = decodeURIComponent(/\/accounts\/([^/]+)\/stream/.exec(url)?.[1] ?? ''), a = ACCTS.get(id);
      if (!a) return () => {};
      send('status', { mode: a.mode, modes: mandateInfo(a).modes, halt: a.halt, halted: effectiveHalt(a), divergence: a.divergence, ts: now() });
      send('account', { ...venueState(a), divergence: a.divergence, halt: a.halt, mode: a.mode });
      let set = listeners.get(id); if (!set) { set = new Set(); listeners.set(id, set); }
      set.add(send);
      return () => { set!.delete(send); };
    },
  };
}
