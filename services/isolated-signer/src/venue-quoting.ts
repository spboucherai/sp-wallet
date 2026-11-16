// QUOTING mandates (market making), signer side. Design and bounds: docs/V11-MARKET-MAKING.md.
//
// One passkey approval stores a quoting mandate (packages/derivatives/src/live/quoting.ts) that EXTENDS a MANUAL_LIVE venue
// authorization. After that, POST /venue/quoting/sign signs — with the trading key, WITHOUT a passkey — exactly four kinds of
// venue action, and every limit is enforced here from this signer's stored mandate, its own reading of the payload
// (`describe`, pinned asset table), its own prices (prices.ts) and its own read of the venue account (venue-read.ts):
//
//   cancel / cancelByCloid        always, while the authorization lives and the mandate has not ENDED (halt and wind-down included)
//   reduce-only batch             same + instrument of the mandate, every price inside the reduce band of the signer's mid,
//                                 size per order — no venue read, no counter: reducing must stay possible in every degraded state
//   scheduleCancel(time)          the venue's dead man's switch; same freedom as a cancel (it can only cancel). The deadline is stored.
//   scheduleCancel()              removing the switch: only when the signer itself reads NO open order and nothing can still land
//   quote batch                   every order post-only (Alo), limit, not reduce-only, ONE instrument: only while the mandate is
//                                 ACTIVE, the signer is not halted, the dead man's switch is armed past the batch's own venue
//                                 expiry, inside every rate counter, with every price in the band around the signer's mid, and
//                                 after the signer has read the venue account itself (fail closed)
//
// Nothing else is signed: no trigger order, no GTC/IOC opening, no leverage change, no modify, no TWAP, no transfer, no
// withdrawal, no agent approval, no vault or sub-account action, no builder field, no priority fee.
import { sign } from 'viem/accounts';
import {
  bucketAt, bucketFull, bucketTake, createHlTrading, D, DMS_COVER_MARGIN_MS, DMS_MAX_LAPSES_PER_DAY, DMS_MIN_AHEAD_MS, HL_KIND_L1, hex, hlPinnedAsset, hlPinnedAssets, jurisdictionAckOf, QUOTING_ACTION_MAX_TTL_MS,
  QUOTING_MANDATE_BOUNDS, quoteBandError, quotingSetCheck, signatureFromHex, typedDataDigest, validateVenueQuotingMandate, VENUE_PENDING_GRACE_MS, VENUE_READ_MAX_AGE_MS, venueMandatePhase, venueQuotingMandateHash,
  VenueQuotingMandateSchema, venueWindowError, withinBand,
  type ExposureOrder, type HlDescription, type HlL1SignPayload, type HlSignature, type OrderRequest, type SignRequest, type VenueAuthorization, type VenueMandatePhase, type VenueQuotingMandate,
} from '@spw/derivatives/live';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { StoredVenueAuthorization, StoredVenueQuotingMandate, VenuePendingOrder } from './store.ts';
import { VENUE_NONCE_SET, type VenueCtx } from './venue.ts';
import type { VenueAccountView, VenueOpenOrderView } from './venue-read.ts';

export interface VenueQuotingSignRequest { mandateId: string; sign: SignRequest }
export type VenueQuotingKind = 'quotes' | 'reduce' | 'cancel' | 'schedule_cancel';
export interface VenueQuotingSignResult { signature: HlSignature; signer: string; kind: VenueQuotingKind; /** the action hash (connectionId) that was signed */ hash: string; mandateId: string; phase: VenueMandatePhase; orders: number }
type Usage = StoredVenueQuotingMandate['usage'][string];

const day = (nowSec: number) => new Date(nowSec * 1000).toISOString().slice(0, 10);
const hour = (nowSec: number) => new Date(nowSec * 1000).toISOString().slice(0, 13);
const hexKey = (priv: Uint8Array) => `0x${Buffer.from(priv).toString('hex')}` as `0x${string}`;
const canon = (x: string) => D.str(D.from(x));
const sec = (iso: string | undefined) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);
const emptyUsage = (): Usage => ({ quotes: 0, batches: 0, reduceOnly: 0, cancels: 0, heartbeats: 0, turnover: '0', lapses: 0 });
const phaseOf = (sm: StoredVenueQuotingMandate, now: number) => venueMandatePhase(sm.mandate, sm.revoked ? sec(sm.revokedAt) : null, now);
const inst = (coin: string) => `hyperliquid:${coin}`;
/** tolerated difference between the venue's clock and the signer's when matching a resting order to a signed one */
const LANDED_SKEW_MS = 60_000;

/**
 * A deadline this signer signed that has passed without being replaced or removed is PRESUMED to have fired on the venue
 * ("a trigger count will be incremented. The max number of triggers per day is 10"). Counted on the UTC day of the deadline.
 */
function settleSwitch(ctx: VenueCtx, sm: StoredVenueQuotingMandate, nowMs: number): void {
  if (!sm.dms || nowMs < sm.dms.deadline) return;
  const d = day(Math.floor(sm.dms.deadline / 1000)), u = (sm.usage[d] ??= emptyUsage());
  u.lapses += 1;
  ctx.store.log('venue.quoting.switch_lapsed', { mandateId: sm.mandate.mandateId, deadline: sm.dms.deadline, lapsesThatDay: u.lapses });
  sm.dms = null;
}

export function venueQuotingStatus(ctx: VenueCtx) {
  const now = ctx.now(), today = day(now);
  return Object.values(ctx.store.state.venueQuotingMandates ?? {}).map((sm) => {
    const ph = phaseOf(sm, now), rec = ctx.store.state.venues?.[sm.mandate.authorizationId], m = sm.mandate;
    const dead = !rec || rec.revoked || now >= rec.authorization.expiresAt;
    const armed = sm.dms !== null && sm.dms.deadline > now * 1000;
    return { mandate: m, hash: sm.hash, approvedAt: sm.approvedAt, revoked: sm.revoked, revokedAt: sm.revokedAt ?? null, expired: now >= m.expiresAt,
      phase: (dead ? 'ended' : ph.phase) as VenueMandatePhase, windDownUntil: ph.windDownUntil,
      today: sm.usage[today] ?? emptyUsage(), quotesThisHour: sm.hours[hour(now)] ?? 0,
      /** whole batches the bucket would let through right now */
      bucketActions: Math.floor(bucketAt(sm.bucket, now * 1000, m.rate.burstActions, m.rate.actionsPerMinute).units / 60_000),
      deadMan: { armed, deadline: armed ? sm.dms!.deadline : null },
      pendingQuotes: (rec?.pending ?? []).filter((p) => p.q === 1 && p.until > now * 1000).length };
  });
}

/** The owner approves a quoting mandate: passkey assertion over its canonical hash — the same ceremony as the directional mandate. */
export async function venueQuotingApprove(ctx: VenueCtx, raw: unknown, assertion: AuthenticationResponseJSON | undefined): Promise<{ mandateId: string; hash: string; authorizationId: string }> {
  const st = ctx.store, now = ctx.now();
  const parsed = VenueQuotingMandateSchema.safeParse(raw);
  if (!parsed.success) throw ctx.fail('bad_request', `malformed quoting mandate (${parsed.error.issues[0]?.path.join('.') ?? 'shape'})`);
  const m: VenueQuotingMandate = parsed.data, hash = venueQuotingMandateHash(m), id = m.mandateId;
  const deny = (code: string, msg: string): never => { st.log('venue.quoting.denied', { mandateId: id, authorizationId: m.authorizationId, code, msg: msg.slice(0, 300) }); st.save(); throw ctx.fail(code, msg); };
  if (st.state.halted) deny('halted', 'emergency halt is active');
  if (m.keyId !== ctx.keys.keyId) deny('wrong_key', 'mandate targets another key');
  const rec = st.state.venues?.[m.authorizationId];
  if (!rec) deny('no_authorization', 'a quoting mandate extends a venue authorization this signer has stored: none with this id');
  const a = rec!.authorization;
  if (rec!.revoked) deny('revoked', 'the venue authorization was revoked');
  if (now >= a.expiresAt) deny('expired', 'the venue authorization has expired');
  try { validateVenueQuotingMandate(m, a, now); } catch (e) { deny('unsupported', (e as Error).message); }
  for (const i of m.instruments) {
    const pinned = hlPinnedAsset(a.network, i.instrument);
    if (!pinned) deny('unsupported', `${i.instrument} is not in the signer's pinned ${a.network} asset table`);
    if (i.maxLeverage > pinned!.maxLeverage) deny('unsupported', `leverage ${i.maxLeverage} is above the venue maximum of ${i.instrument} (${pinned!.maxLeverage})`);
  }
  if (!jurisdictionAckOf(m.venue, m.ackSha256)) deny('acknowledgement', 'the acknowledgement hash is not the hash of the jurisdiction summary this signer knows');
  if (st.state.venueQuotingMandates?.[id] || st.state.venueMandates?.[id]) deny('replay', 'mandate already recorded');
  // exclusive use of the venue account: one mandate per authorization, of either kind
  for (const other of Object.values(st.state.venueQuotingMandates ?? {})) {
    if (other.mandate.authorizationId === m.authorizationId && phaseOf(other, now).phase === 'active') deny('conflict', 'another quoting mandate is active on this venue authorization: revoke it first');
  }
  for (const other of Object.values(st.state.venueMandates ?? {})) {
    if (other.mandate.authorizationId === m.authorizationId && venueMandatePhase(other.mandate, other.revoked ? sec(other.revokedAt) : null, now).phase === 'active') deny('conflict', 'a directional mandate is active on this venue authorization: revoke it first');
  }
  if (!assertion) deny('bad_approval', 'the owner\'s passkey approval is required');
  try { await ctx.verify(assertion!, hash); } catch (e) { deny((e as { code?: string }).code ?? 'bad_approval', (e as Error).message); }
  (st.state.venueQuotingMandates ??= {})[id] = { mandate: m, hash: hex(hash), approvedAt: new Date(now * 1000).toISOString(), revoked: false, usage: {}, hours: {}, bucket: bucketFull(m.rate.burstActions, now * 1000), dms: null };
  st.log('venue.quoting.approved', { mandateId: id, hash: hex(hash), authorizationId: m.authorizationId, network: m.network, account: m.account, agentAddress: m.agentAddress, strategySha256: m.strategySha256, agentId: m.agentId,
    instruments: m.instruments, maxRestingTotal: m.maxRestingTotal, maxGrossExposure: m.maxGrossExposure, minHalfSpreadBps: m.minHalfSpreadBps, maxDistanceBps: m.maxDistanceBps, maxReduceDeviationBps: m.maxReduceDeviationBps,
    floorEquity: m.floorEquity, rate: m.rate, deadManSeconds: m.deadManSeconds, expiresAt: m.expiresAt, ackSha256: m.ackSha256 });
  st.save();
  return { mandateId: id, hash: hex(hash), authorizationId: m.authorizationId };
}

/** Stopping never needs a passkey. A revoked quoting mandate never signs a quote again; cancels, reduce-only orders and the switch stay signable during the wind-down. */
export function venueQuotingRevoke(ctx: VenueCtx, mandateId: string): { revoked: true; revokedAt: string; windDownUntil: number } {
  const sm = ctx.store.state.venueQuotingMandates?.[mandateId];
  if (!sm) throw ctx.fail('not_found', 'unknown quoting mandate');
  if (!sm.revoked) {
    sm.revoked = true; sm.revokedAt = new Date(ctx.now() * 1000).toISOString();
    ctx.store.log('venue.quoting.revoked', { mandateId, authorizationId: sm.mandate.authorizationId });
    ctx.store.save();
  }
  return { revoked: true, revokedAt: sm.revokedAt!, windDownUntil: venueMandatePhase(sm.mandate, sec(sm.revokedAt), sec(sm.revokedAt)!).windDownUntil! };
}

/** every ledger of the account: this authorization's, and any other record of the same network and account (one revoked a moment ago) */
const ledgersOf = (ctx: VenueCtx, rec: StoredVenueAuthorization): StoredVenueAuthorization[] =>
  Object.values(ctx.store.state.venues ?? {}).filter((r) => r === rec || (r.authorization.network === rec.authorization.network && r.authorization.account === rec.authorization.account));

/** the signer's own read of the account; any doubt is a refusal */
async function ownAccount(ctx: VenueCtx, deny: (code: string, msg: string) => never, a: VenueAuthorization, nowMs: number): Promise<VenueAccountView> {
  let view: VenueAccountView;
  try { view = await ctx.venueInfo.account(a.network, a.account); }
  catch (e) { return deny('venue_unreachable', `the signer could not read the venue account itself (${(e as Error).message.slice(0, 100)}): no quote is signed`); }
  if (Math.abs(nowMs - view.time) > VENUE_READ_MAX_AGE_MS) deny('venue_stale', `the venue's account state is dated ${Math.round((nowMs - view.time) / 1000)} s from the signer's clock`);
  return view;
}

/**
 * Sign ONE venue action under a quoting mandate, without a passkey. Counters, the bucket, the ledger, the switch's deadline
 * and the nonce are durable before the signature is returned.
 */
export async function venueQuotingSign(ctx: VenueCtx, req: VenueQuotingSignRequest): Promise<VenueQuotingSignResult> {
  const st = ctx.store, now = ctx.now(), nowMs = now * 1000;
  const id = String(req?.mandateId ?? '');
  const sm = st.state.venueQuotingMandates?.[id];
  if (!sm) throw ctx.fail('not_found', 'unknown quoting mandate');
  const m = sm.mandate;
  settleSwitch(ctx, sm, nowMs);
  const deny = (code: string, msg: string): never => { st.log('venue.quoting.sign.denied', { mandateId: id, code, msg: msg.slice(0, 300) }); st.save(); throw ctx.fail(code, msg); };
  const rec = st.state.venues?.[m.authorizationId];
  if (!rec) return deny('no_authorization', 'the venue authorization of this mandate is unknown');
  const a = rec.authorization;
  // the authorization is the root: revoked or expired, nothing at all is signed (no wind-down)
  if (rec.revoked) deny('revoked', 'the venue authorization of this mandate was revoked: nothing is signed');
  if (now >= a.expiresAt) deny('expired', 'the venue authorization of this mandate has expired');
  const ph = phaseOf(sm, now);
  if (ph.phase === 'ended') deny(sm.revoked && sec(sm.revokedAt)! <= m.expiresAt ? 'revoked' : 'expired', `the mandate ${sm.revoked ? 'was revoked' : 'expired'} and its wind-down period is over`);
  const s = req.sign;
  if (!s || typeof s !== 'object') deny('bad_request', 'missing sign request');
  if (s.venue !== a.venue || s.network !== a.network) deny('wrong_venue', 'the sign request is for another venue or network than the mandate');

  // 1. what does the payload do? (the signer's own reading, pinned table)
  const trading = createHlTrading({ network: a.network, assets: hlPinnedAssets(a.network), describeScheduleCancel: true });
  let d: HlDescription;
  try { d = trading.describe(s); } catch (e) { return deny('rejected', `payload refused: ${(e as Error).message}`); }
  if ((d.kind !== 'order' && d.kind !== 'cancel' && d.kind !== 'schedule_cancel') || s.kind !== HL_KIND_L1)
    deny('unsupported', `this payload is not a batch of orders, a cancel or a scheduleCancel (${String(d.detail.type ?? d.detail.primaryType ?? d.kind).slice(0, 60)}): a quoting mandate signs nothing else`);
  const p = d.detail as { nonce: number; vaultAddress: string | null; expiresAfter: number | null; connectionId: string };
  if (p.vaultAddress !== null) deny('unsupported', 'sub-accounts and vaults are not traded');
  if (p.expiresAfter === null) deny('policy', 'the action carries no venue expiry: a signature that never expires is not released');
  const win = venueWindowError({ nonce: p.nonce, expiresAt: p.expiresAfter! }, nowMs);
  if (win) deny(/expired/.test(win) ? 'expired_action' : /stale/.test(win) ? 'stale_nonce' : 'policy', win);
  if (rec.nonces.includes(p.nonce)) deny('stale_nonce', 'nonce already used with this trading key');
  if (rec.nonces.length >= VENUE_NONCE_SET && p.nonce <= rec.nonces[0]!) deny('stale_nonce', 'nonce is below the lowest of the last nonces signed with this trading key');
  const shortLived = () => { if (p.expiresAfter! - p.nonce > QUOTING_ACTION_MAX_TTL_MS) deny('policy', `validity window longer than ${QUOTING_ACTION_MAX_TTL_MS / 1000} s`); };

  const today = day(now), usage: Usage = { ...(sm.usage[today] ?? emptyUsage()) };
  const ledgers = ledgersOf(ctx, rec), live = (x: VenuePendingOrder) => x.until > nowMs;
  let kind: VenueQuotingKind, summary: Record<string, unknown>, orders = 0;
  const pending: VenuePendingOrder[] = [];
  let bucket = sm.bucket, hourAdd = 0, dms = sm.dms;

  if (d.kind === 'cancel') {
    const cancels = d.detail.cancels as { instrument: string }[];
    for (const c of cancels) if (!a.policy.allowedInstruments.includes(c.instrument)) deny('instrument', `${c.instrument} is not allowed by the authorization`);
    usage.cancels += cancels.length; kind = 'cancel'; orders = cancels.length;
    summary = { cancels: cancels.length, instruments: [...new Set(cancels.map((c) => c.instrument))] };
  } else if (d.kind === 'schedule_cancel') {
    const time = (d.detail as { time: number | null }).time;
    shortLived();
    if (time === null) {
      // removing the switch is only harmless when nothing rests and nothing can still land
      const view = await ownAccount(ctx, deny, a, nowMs);
      if (view.openOrders.length > 0) deny('switch_needed', `the account has ${view.openOrders.length} open order(s): the dead man's switch is not removed`);
      if (ledgers.some((r) => (r.pending ?? []).some(live))) deny('switch_needed', 'an order signed a moment ago can still reach the venue: the dead man\'s switch is not removed');
      dms = null;
    } else {
      if (time < nowMs + DMS_MIN_AHEAD_MS) deny('switch_too_soon', `the scheduled cancel must be at least ${DMS_MIN_AHEAD_MS / 1000} s ahead (the venue's own minimum is 5 s)`);
      if (time > nowMs + m.deadManSeconds * 1000) deny('switch_too_far', `the scheduled cancel is more than the mandate's ${m.deadManSeconds} s ahead`);
      dms = { deadline: time, signedAt: nowMs };
    }
    usage.heartbeats += 1; kind = 'schedule_cancel';
    summary = { time, armed: time !== null };
  } else {
    const list: OrderRequest[] = d.orders ?? [];
    if (list.length < 1 || list.length > QUOTING_MANDATE_BOUNDS.maxBatch) deny('batch', `a batch holds 1 to ${QUOTING_MANDATE_BOUNDS.maxBatch} orders`);
    const instrument = list[0]!.instrument;
    if (list.some((o) => o.instrument !== instrument)) deny('mixed_batch', 'a batch is for ONE instrument');
    const mi = m.instruments.find((i) => i.instrument === instrument);
    if (!mi) deny('instrument', `${instrument} is not allowed by the mandate`);
    if (list.some((o) => o.type !== 'limit' || o.triggerPrice !== null || o.price === null)) deny('order_type', 'only limit orders are signed under a quoting mandate (no trigger order)');
    const ids = list.map((o) => o.clientId);
    if (ids.some((c) => !/^0x[0-9a-f]{32}$/.test(c))) deny('client_id', 'every order carries a client order id');
    if (new Set(ids).size !== ids.length) deny('replay', 'two orders of the batch carry the same client id');
    // a client id that a pending signed order carries is never signed again (a second order must not pass for the first)
    if (ledgers.some((r) => (r.pending ?? []).some((x) => live(x) && ids.includes(x.clientId)))) deny('replay', 'an order with this client id was signed and can still reach the venue');
    const reducing = list.every((o) => o.reduceOnly), opening = list.every((o) => !o.reduceOnly);
    if (!reducing && !opening) deny('mixed_batch', 'a batch is either all quotes or all reduce-only orders');
    if (opening && list.some((o) => o.tif !== 'alo')) deny('not_post_only', 'an order that can open or add is signed only as a post-only (Alo) limit order');

    const symbol = instrument.slice(instrument.indexOf(':') + 1);
    let mid: string;
    try { const px = (await ctx.prices.get([symbol]))[symbol]; if (!(typeof px === 'number' && px > 0 && Number.isFinite(px))) throw new Error('no price'); mid = canon(px.toFixed(8)); }
    catch (e) { return deny('no_price', `the signer could not establish its own market price for ${symbol} (${(e as Error).message.slice(0, 80)}); nothing priced is signed`); }
    const notionalOf = (o: OrderRequest) => D.mul(D.from(o.size), D.max(D.from(o.price!), D.from(mid)));
    orders = list.length;

    if (reducing) {
      for (const o of list) {
        if (!withinBand(o.price!, mid, m.maxReduceDeviationBps)) deny('price', `price ${canon(o.price!)} is more than ${m.maxReduceDeviationBps} bps away from the signer's own ${symbol} price ${mid}`);
        if (D.gt(notionalOf(o), D.from(mi!.maxQuoteNotional))) deny('order_notional', `order notional ${D.str(notionalOf(o))} is above the mandate's ${canon(mi!.maxQuoteNotional)} per order`);
      }
      usage.reduceOnly += list.length; kind = 'reduce';
      summary = { instrument, orders: list.map((o) => ({ side: o.side, size: canon(o.size), price: canon(o.price!), tif: o.tif, clientId: o.clientId })), mid };
    } else {
      // ---- a batch of quotes: everything below must hold, in this order ----
      if (ph.phase !== 'active') deny('wind_down', `the mandate ${sm.revoked ? 'was revoked' : 'has expired'}: only cancels, reduce-only orders and the dead man's switch are signed until the wind-down ends`);
      if (st.state.halted) deny('halted', 'emergency halt is active: only cancels, reduce-only orders and the dead man\'s switch are signed');
      shortLived();
      if ((usage.lapses ?? 0) >= DMS_MAX_LAPSES_PER_DAY) deny('switch_exhausted', `the dead man's switch is presumed to have fired ${usage.lapses} times today (the venue allows 10 a day): no quote until 00:00 UTC`);
      if (!dms) deny('no_switch', 'no dead man\'s switch is in force: a scheduleCancel must be signed (and sent) before any quote');
      if (dms!.deadline < p.expiresAfter! + DMS_COVER_MARGIN_MS) deny('no_switch', `the dead man's switch fires at ${dms!.deadline}, before this batch could no longer be accepted (${p.expiresAfter} + ${DMS_COVER_MARGIN_MS} ms): renew it first`);
      // rates — all persisted; a refusal consumes nothing
      if (usage.quotes + list.length > m.rate.ordersPerDay) deny('orders_day', `the mandate's ${m.rate.ordersPerDay} quotes per day are used`);
      const thisHour = sm.hours[hour(now)] ?? 0;
      if (thisHour + list.length > m.rate.ordersPerHour) deny('orders_hour', `the mandate's ${m.rate.ordersPerHour} quotes per hour are used`);
      const turnover = list.reduce((n, o) => D.add(n, notionalOf(o)), D.from(usage.turnover));
      if (D.gt(turnover, D.from(m.rate.dailyTurnover))) deny('turnover', `daily turnover would reach ${D.str(turnover)}, above the mandate's ${canon(m.rate.dailyTurnover)}`);
      const taken = bucketTake(sm.bucket, nowMs, m.rate.burstActions, m.rate.actionsPerMinute);
      if (taken === null) deny('rate', `the mandate's rate of ${m.rate.actionsPerMinute} quote batches per minute (burst ${m.rate.burstActions}) is used: wait`);
      // the band around the signer's own mid: never at or through it, never closer than the minimum, never further than the maximum
      for (const o of list) {
        const off = quoteBandError(o.side, o.price!, mid, m.minHalfSpreadBps, m.maxDistanceBps);
        if (off) deny(off.code === 'too_far' ? 'quote_too_far' : off.code === 'too_tight' ? 'quote_too_tight' : 'quote_crosses_mid', `${off.reason} the signer's own ${symbol} price ${mid}`);
      }
      // the signer's own view of the account
      const view = await ownAccount(ctx, deny, a, nowMs);
      const coins = new Set<string>();
      for (const x of view.positions) { if (coins.has(x.coin)) deny('venue_inconsistent', `the venue lists two positions on ${x.coin}`); coins.add(x.coin); }
      const open = view.positions.filter((x) => !D.isZero(D.from(x.szi)));
      const sum = open.reduce((n, x) => D.add(n, D.from(x.positionValue)), D.zero), total = D.from(view.totalNtlPos);
      if (D.gt(D.mul(D.abs(D.sub(sum, total)), D.from('1000')), D.add(D.max(sum, total), D.from('10')))) deny('venue_inconsistent', `the venue's positions (${D.str(sum)}) do not add up to its own total (${D.str(total)})`);
      for (const x of open) if (!hlPinnedAsset(a.network, inst(x.coin))) deny('unpriced_position', `the account holds a position on ${x.coin}, which this signer cannot price itself: no quote is signed`);
      if (view.openOrders.some((o) => o.cloid !== null && ids.includes(o.cloid))) deny('replay', 'an open order on the venue already carries one of these client ids');
      if (D.lt(D.from(view.accountValue), D.from(m.floorEquity))) deny('floor_equity', `the venue reports an account value of ${view.accountValue}, below the mandate's floor of ${canon(m.floorEquity)}: only cancels and reduce-only orders are signed`);
      const held = open.find((x) => x.coin === symbol);
      let setting: { type: string; value: number };
      try { setting = held ? held.leverage : await ctx.venueInfo.leverage(a.network, a.account, symbol); }
      catch (e) { return deny('venue_unreachable', `the signer could not read the leverage setting of ${symbol} itself (${(e as Error).message.slice(0, 100)})`); }
      if (setting.value > mi!.maxLeverage) deny('leverage_setting', `${symbol} is set to ${setting.value}× on the venue, above the mandate's ${mi!.maxLeverage}×: lower it first (a quoting mandate does not change leverage)`);
      // ledger: a quote of ours that the venue now lists is counted through the venue's list from now on, and leaves the ledger
      // for good (the same signed action cannot land twice). The match is strict — client id, coin, side, price, not reduce-only,
      // taken by the venue after the signature — so that no other order can pass for a pending quote.
      const isIt = (x: VenuePendingOrder, o: VenueOpenOrderView) => o.cloid === x.clientId && inst(o.coin) === x.instrument && o.side === x.side && !o.reduceOnly && canon(o.price) === canon(x.price) && x.signedAt !== undefined && o.timestamp >= x.signedAt - LANDED_SKEW_MS;
      const landedLoose = (x: VenuePendingOrder) => x.signedAt !== undefined && view.openOrders.some((o) => o.cloid === x.clientId && o.timestamp >= x.signedAt! - LANDED_SKEW_MS);
      for (const r of ledgers) if (r.pending) r.pending = r.pending.filter((x) => !(x.q === 1 && view.openOrders.some((o) => isIt(x, o))));
      const resting: ExposureOrder[] = [
        ...view.openOrders.filter((o) => !o.reduceOnly && !D.isZero(D.from(o.size))).map((o) => ({ instrument: inst(o.coin), side: o.side, size: o.size, price: o.price, reduceOnly: false })),
        // quotes still in the ledger are counted in full; manual / directional entries keep the rule of venue-mandate.ts
        ...ledgers.flatMap((r) => r.pending ?? []).filter((x) => live(x) && (x.q === 1 || !landedLoose(x))).map((x) => ({ instrument: x.instrument, side: x.side, size: x.size, price: x.price, reduceOnly: false })),
      ];
      const symbols = [...new Set([...open.map((x) => inst(x.coin)), ...resting.map((o) => o.instrument), instrument])].filter((i) => hlPinnedAsset(a.network, i)).map((i) => i.slice(i.indexOf(':') + 1));
      const prices: Record<string, string> = {};
      try {
        const got = await ctx.prices.get(symbols);
        for (const sy of symbols) { const px = got[sy]; if (!(typeof px === 'number' && px > 0 && Number.isFinite(px))) throw new Error(`no price for ${sy}`); prices[inst(sy)] = canon(px.toFixed(8)); }
      } catch (e) { return deny('no_price', `the signer could not establish its own market prices (${(e as Error).message.slice(0, 80)})`); }
      for (const x of open) {
        const mine = D.mul(D.abs(D.from(x.szi)), D.from(prices[inst(x.coin)]!));
        if (D.gt(D.mul(D.abs(D.sub(D.from(x.positionValue), mine)), D.from(10000n)), D.mul(D.from(BigInt(a.policy.maxPriceDeviationBps)), mine)))
          deny('venue_inconsistent', `the venue values the ${x.coin} position at ${x.positionValue}; at the signer's own price it is ${D.str(mine)} (more than ${a.policy.maxPriceDeviationBps} bps apart)`);
      }
      const check = quotingSetCheck(m, instrument, open.map((x) => ({ instrument: inst(x.coin), size: x.szi })), resting, list.map((o) => ({ side: o.side, size: o.size, price: o.price! })), prices, a.policy.maxGrossExposure);
      if (!check.ok) deny(check.code, check.message);
      const stats = (check as Extract<typeof check, { ok: true }>).stats;
      for (const o of list) pending.push({ clientId: o.clientId, instrument, side: o.side, size: canon(o.size), price: canon(o.price!), until: p.expiresAfter! + VENUE_PENDING_GRACE_MS, signedAt: nowMs, q: 1 });
      usage.quotes += list.length; usage.batches += 1; usage.turnover = D.str(turnover); hourAdd = list.length; bucket = taken!; kind = 'quotes';
      summary = { instrument, orders: list.map((o) => ({ side: o.side, size: canon(o.size), price: canon(o.price!), clientId: o.clientId })), mid, accountValue: view.accountValue, leverageSetting: setting.value,
        restingBuy: stats.count.buy, restingSell: stats.count.sell, restingTotal: stats.total, restingNotionalBuy: stats.notional.buy, restingNotionalSell: stats.notional.sell, worstInventory: stats.worstInventory, worstGross: stats.worstGross, switchDeadline: dms!.deadline };
    }
  }

  // counters, bucket, ledger, switch deadline and nonce are durable BEFORE the signature leaves
  if (pending.length) (rec.pending ??= []).push(...pending);
  if (hourAdd) sm.hours[hour(now)] = (sm.hours[hour(now)] ?? 0) + hourAdd;
  sm.usage[today] = usage; sm.bucket = bucket; sm.dms = dms;
  rec.nonces = [...rec.nonces, p.nonce].sort((x, y) => x - y).slice(-VENUE_NONCE_SET);
  st.prune(now);
  const agent = ctx.keys.venueKey(a.venue, a.network);
  const signature = signatureFromHex(await sign({ hash: typedDataDigest((s.payload as HlL1SignPayload).typedData), privateKey: hexKey(agent.priv), to: 'hex' }));
  st.log('venue.quoting.sign.ok', { mandateId: id, authorizationId: a.authorizationId, phase: ph.phase, kind, nonce: p.nonce, expiresAfter: p.expiresAfter, connectionId: p.connectionId, ...summary });
  st.save();
  return { signature, signer: agent.address, kind, hash: p.connectionId.slice(2), mandateId: id, phase: ph.phase, orders };
}
