// Derivative mandates (MANDATE_LIVE), signer side. Docs: docs/v6/DERIVATIVE-MANDATE.md.
//
// One passkey approval stores a mandate (packages/derivatives/src/live/mandate.ts) that EXTENDS a MANUAL_LIVE venue
// authorization. After that, POST /venue/mandate/sign signs orders, cancels and leverage changes with the trading key WITHOUT
// a passkey — and every limit is enforced here, from this signer's own stored copy of the mandate, its own reading of the
// payload (`describe`, pinned asset table), its own prices (prices.ts) and its own read of the venue account (venue-read.ts).
// Nothing the API says about the order, the positions or the prices is used for a decision.
//
// Three kinds of action, three levels of freedom:
//   cancel                      always signed while the authorization lives and the mandate has not ENDED (also under the emergency halt)
//   reduce-only order           same, plus: allowed instrument, order notional, price band, client id never signed — no venue read,
//                               no counter: closing must stay possible when limits are hit, when halted, and during the wind-down
//   order that can add exposure only while the mandate is ACTIVE and the signer is not halted, inside every counter, and only
//   / leverage change           after the signer has read the venue account itself (fail closed)
import { sign } from 'viem/accounts';
import {
  createHlTrading, D, HL_KIND_L1, hex, hlPinnedAsset, hlPinnedAssets, jurisdictionAckOf, signatureFromHex, typedDataDigest, validateVenueMandate, VENUE_MANDATE_BOUNDS, VENUE_PENDING_GRACE_MS,
  VENUE_READ_MAX_AGE_MS, venueMandateHash, venueMandatePhase, VenueMandateSchema, venueOrderHash, venueOrderNotional, venueOrderPriceError, VenueOrderSchema, venueWindowError, worstCaseExposure,
  type ExposureOrder, type HlDescription, type HlL1SignPayload, type HlSignature, type SignRequest, type VenueAuthorization, type VenueMandate, type VenueMandatePhase, type VenueOrder,
} from '@spw/derivatives/live';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { StoredVenueAuthorization, StoredVenueMandate } from './store.ts';
import { VENUE_NONCE_SET, type VenueCtx } from './venue.ts';
import type { VenueAccountView } from './venue-read.ts';

export interface VenueMandateSignRequest { mandateId: string; sign: SignRequest; /** what the API says the order is: optional, and refused when it differs from the payload */ context?: { order?: unknown } }
export interface VenueMandateSignResult { signature: HlSignature; signer: string; kind: 'order' | 'cancel' | 'leverage'; hash: string; mandateId: string; phase: VenueMandatePhase }
type Usage = StoredVenueMandate['usage'][string];

const day = (nowSec: number) => new Date(nowSec * 1000).toISOString().slice(0, 10);
const hexKey = (priv: Uint8Array) => `0x${Buffer.from(priv).toString('hex')}` as `0x${string}`;
const canon = (x: string) => D.str(D.from(x));
const sec = (iso: string | undefined) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);
/** the highest price an order names (limit / worst price, or its trigger price): what venueOrderNotional multiplies the size by */
const topPrice = (o: Pick<VenueOrder, 'price' | 'triggerPrice'>) => D.str(o.triggerPrice === null ? D.from(o.price) : D.max(D.from(o.price), D.from(o.triggerPrice)));
/** tolerated difference between the venue's clock and the signer's when matching a resting order to a signed one */
const LANDED_SKEW_MS = 60_000;
const emptyUsage = (): Usage => ({ orders: 0, reduceOnly: 0, cancels: 0, leverage: 0, turnover: '0' });
const phaseOf = (sm: StoredVenueMandate, now: number) => venueMandatePhase(sm.mandate, sm.revoked ? sec(sm.revokedAt) : null, now);

export function venueMandateStatus(ctx: VenueCtx) {
  const now = ctx.now(), today = day(now);
  return Object.values(ctx.store.state.venueMandates ?? {}).map((sm) => {
    const ph = phaseOf(sm, now), rec = ctx.store.state.venues?.[sm.mandate.authorizationId];
    const dead = !rec || rec.revoked || now >= rec.authorization.expiresAt;
    return { mandate: sm.mandate, hash: sm.hash, approvedAt: sm.approvedAt, revoked: sm.revoked, revokedAt: sm.revokedAt ?? null, expired: now >= sm.mandate.expiresAt,
      /** what it signs right now: `ended` also when its authorization is revoked or expired */
      phase: (dead ? 'ended' : ph.phase) as VenueMandatePhase, windDownUntil: ph.windDownUntil,
      today: sm.usage[today] ?? emptyUsage(), ordersLastHour: sm.hour.filter((t) => t > now - 3600).length,
      pendingOrders: (rec?.pending ?? []).filter((p) => p.until > now * 1000).length };
  });
}

/** The owner approves a mandate: passkey assertion over its canonical hash. Limits are set here and nowhere else. */
export async function venueMandateApprove(ctx: VenueCtx, raw: unknown, assertion: AuthenticationResponseJSON | undefined): Promise<{ mandateId: string; hash: string; authorizationId: string }> {
  const st = ctx.store, now = ctx.now();
  const parsed = VenueMandateSchema.safeParse(raw);
  if (!parsed.success) throw ctx.fail('bad_request', 'malformed venue mandate');
  const m: VenueMandate = parsed.data, hash = venueMandateHash(m), id = m.mandateId;
  const deny = (code: string, msg: string): never => { st.log('venue.mandate.denied', { mandateId: id, authorizationId: m.authorizationId, code, msg: msg.slice(0, 300) }); st.save(); throw ctx.fail(code, msg); };
  if (st.state.halted) deny('halted', 'emergency halt is active');
  if (m.keyId !== ctx.keys.keyId) deny('wrong_key', 'mandate targets another key');
  const rec = st.state.venues?.[m.authorizationId];
  if (!rec) deny('no_authorization', 'a mandate extends a venue authorization this signer has stored: none with this id');
  const a = rec!.authorization;
  if (rec!.revoked) deny('revoked', 'the venue authorization was revoked');
  if (now >= a.expiresAt) deny('expired', 'the venue authorization has expired');
  try { validateVenueMandate(m, a, now); } catch (e) { deny('unsupported', (e as Error).message); }
  for (const i of m.instruments) {
    const pinned = hlPinnedAsset(a.network, i.instrument);
    if (!pinned) deny('unsupported', `${i.instrument} is not in the signer's pinned ${a.network} asset table`);
    if (i.maxLeverage > pinned!.maxLeverage) deny('unsupported', `leverage ${i.maxLeverage} is above the venue maximum of ${i.instrument} (${pinned!.maxLeverage})`);
  }
  if (!jurisdictionAckOf(m.venue, m.ackSha256)) deny('acknowledgement', 'the acknowledgement hash is not the hash of the jurisdiction summary this signer knows');
  if (st.state.venueMandates?.[id]) deny('replay', 'mandate already recorded');
  for (const other of Object.values(st.state.venueMandates ?? {})) {
    if (other.mandate.authorizationId === m.authorizationId && phaseOf(other, now).phase === 'active') deny('conflict', 'another mandate is active on this venue authorization: revoke it first');
  }
  if (!assertion) deny('bad_approval', 'the owner\'s passkey approval is required');
  try { await ctx.verify(assertion!, hash); } catch (e) { deny((e as { code?: string }).code ?? 'bad_approval', (e as Error).message); }
  (st.state.venueMandates ??= {})[id] = { mandate: m, hash: hex(hash), approvedAt: new Date(now * 1000).toISOString(), revoked: false, usage: {}, hour: [] };
  st.log('venue.mandate.approved', { mandateId: id, hash: hex(hash), authorizationId: m.authorizationId, network: m.network, account: m.account, agentAddress: m.agentAddress, strategySha256: m.strategySha256, agentId: m.agentId,
    instruments: m.instruments, maxOrderNotional: m.maxOrderNotional, maxGrossExposure: m.maxGrossExposure, maxOrdersPerDay: m.maxOrdersPerDay, maxOrdersPerHour: m.maxOrdersPerHour, maxDailyTurnover: m.maxDailyTurnover,
    floorEquity: m.floorEquity, maxPriceDeviationBps: m.maxPriceDeviationBps, expiresAt: m.expiresAt, ackSha256: m.ackSha256 });
  st.save();
  return { mandateId: id, hash: hex(hash), authorizationId: m.authorizationId };
}

/** Stopping never needs a passkey. A revoked mandate adds no exposure ever again; it still signs cancels and reduce-only orders during the wind-down. */
export function venueMandateRevoke(ctx: VenueCtx, mandateId: string): { revoked: true; revokedAt: string; windDownUntil: number } {
  const sm = ctx.store.state.venueMandates?.[mandateId];
  if (!sm) throw ctx.fail('not_found', 'unknown venue mandate');
  if (!sm.revoked) {
    sm.revoked = true; sm.revokedAt = new Date(ctx.now() * 1000).toISOString();
    ctx.store.log('venue.mandate.revoked', { mandateId, authorizationId: sm.mandate.authorizationId });
    ctx.store.save();
  }
  return { revoked: true, revokedAt: sm.revokedAt!, windDownUntil: venueMandatePhase(sm.mandate, sec(sm.revokedAt), sec(sm.revokedAt)!).windDownUntil! };
}

/**
 * The signer's own view of the account, and the worst-case exposure if `candidate` and everything else that can still add
 * exposure were to fill. Any doubt is a refusal (`deny` throws).
 */
async function ownExposure(ctx: VenueCtx, deny: (code: string, msg: string) => never, a: VenueAuthorization, m: VenueMandate, rec: StoredVenueAuthorization, nowMs: number, candidate: VenueOrder | null) {
  let view: VenueAccountView;
  try { view = await ctx.venueInfo.account(a.network, a.account); }
  catch (e) { return deny('venue_unreachable', `the signer could not read the venue account itself (${(e as Error).message.slice(0, 100)}): nothing that can add exposure is signed`); }
  if (Math.abs(nowMs - view.time) > VENUE_READ_MAX_AGE_MS) deny('venue_stale', `the venue's account state is dated ${Math.round((nowMs - view.time) / 1000)} s from the signer's clock`);
  const coins = new Set<string>();
  for (const p of view.positions) { if (coins.has(p.coin)) deny('venue_inconsistent', `the venue lists two positions on ${p.coin}`); coins.add(p.coin); }
  const open = view.positions.filter((p) => !D.isZero(D.from(p.szi)));
  const sum = open.reduce((n, p) => D.add(n, D.from(p.positionValue)), D.zero), total = D.from(view.totalNtlPos);
  // |Σ position values − the venue's own total| ≤ 0.1 % + 0.01
  if (D.gt(D.mul(D.abs(D.sub(sum, total)), D.from('1000')), D.add(D.max(sum, total), D.from('10')))) deny('venue_inconsistent', `the venue's positions (${D.str(sum)}) do not add up to its own total (${D.str(total)})`);
  const inst = (coin: string) => `hyperliquid:${coin}`;
  for (const p of open) if (!hlPinnedAsset(a.network, inst(p.coin))) deny('unpriced_position', `the account holds a position on ${p.coin}, which this signer cannot price itself: nothing that can add exposure is signed`);
  // A signed order that the venue now lists as resting is counted through the venue's list (its remaining size; what filled is in
  // the position) and no longer through the ledger. "The same order" = the same client order id AND taken by the venue after
  // this signer signed it: a client id is signed once (replay rule), so an older order that carries the same id is not it.
  const landed = (p: { clientId: string; signedAt?: number }) => p.signedAt !== undefined && view.openOrders.some((o) => o.cloid === p.clientId && o.timestamp >= p.signedAt! - LANDED_SKEW_MS);
  const orders: ExposureOrder[] = [
    ...view.openOrders.filter((o) => !o.reduceOnly && !D.isZero(D.from(o.size))).map((o) => ({ instrument: inst(o.coin), side: o.side, size: o.size, price: o.price, reduceOnly: false })),
    // every order this signer signed for the account that can still reach the venue — under this authorization or one revoked a moment ago
    ...Object.values(ctx.store.state.venues ?? {}).filter((r) => r === rec || (r.authorization.network === a.network && r.authorization.account === a.account)).flatMap((r) => r.pending ?? []).filter((p) => p.until > nowMs && !landed(p)).map((p) => ({ instrument: p.instrument, side: p.side, size: p.size, price: p.price, reduceOnly: false })),
    ...(candidate ? [{ instrument: candidate.instrument, side: candidate.side, size: candidate.size, price: topPrice(candidate), reduceOnly: false }] : []),
  ];
  const symbols = [...new Set([...open.map((p) => inst(p.coin)), ...orders.map((o) => o.instrument)])].filter((i) => hlPinnedAsset(a.network, i)).map((i) => i.slice(i.indexOf(':') + 1));
  const prices: Record<string, string> = {};
  try {
    const got = symbols.length ? await ctx.prices.get(symbols) : {};
    for (const s of symbols) { const px = got[s]; if (!(typeof px === 'number' && px > 0 && Number.isFinite(px))) throw new Error(`no price for ${s}`); prices[inst(s)] = canon(px.toFixed(8)); }
  } catch (e) { return deny('no_price', `the signer could not establish its own market prices (${(e as Error).message.slice(0, 80)})`); }
  // the venue's own valuation of each position must agree with the signer's price: a venue (or a read) that is far off is not believed
  for (const p of open) {
    const mine = D.mul(D.abs(D.from(p.szi)), D.from(prices[inst(p.coin)]!));
    if (D.gt(D.mul(D.abs(D.sub(D.from(p.positionValue), mine)), D.from(10000n)), D.mul(D.from(BigInt(m.maxPriceDeviationBps)), mine)))
      deny('venue_inconsistent', `the venue values the ${p.coin} position at ${p.positionValue}; at the signer's own price it is ${D.str(mine)} (more than ${m.maxPriceDeviationBps} bps apart)`);
  }
  let exposure: ReturnType<typeof worstCaseExposure>;
  try { exposure = worstCaseExposure(open.map((p) => ({ instrument: inst(p.coin), size: p.szi })), orders, prices); }
  catch (e) { return deny('venue_inconsistent', (e as Error).message); }
  return { view, open, exposure, prices };
}

/**
 * Sign ONE venue action under a mandate, without a passkey. Every check uses the signer's stored mandate and authorization;
 * counters, the client id, the nonce and the exposure ledger are durable before the signature is returned.
 */
export async function venueMandateSign(ctx: VenueCtx, req: VenueMandateSignRequest): Promise<VenueMandateSignResult> {
  const st = ctx.store, now = ctx.now(), nowMs = now * 1000;
  const id = String(req?.mandateId ?? '');
  const sm = st.state.venueMandates?.[id];
  if (!sm) throw ctx.fail('not_found', 'unknown venue mandate');
  const m = sm.mandate;
  const deny = (code: string, msg: string): never => { st.log('venue.mandate.sign.denied', { mandateId: id, code, msg: msg.slice(0, 300) }); st.save(); throw ctx.fail(code, msg); };
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

  // 1. what does the payload do? (the signer's own reading, pinned table) — same rules as /venue/sign
  const trading = createHlTrading({ network: a.network, assets: hlPinnedAssets(a.network) });
  let d: HlDescription;
  try { d = trading.describe(s); } catch (e) { return deny('rejected', `payload refused: ${(e as Error).message}`); }
  if (d.kind === 'approve_agent' || d.kind === 'other' || s.kind !== HL_KIND_L1) deny('unsupported', `this payload is not an order, a cancel or a leverage change (${String(d.detail.type ?? d.detail.primaryType ?? s.kind).slice(0, 60)}): a mandate signs nothing else`);
  const p = d.detail as { nonce: number; vaultAddress: string | null; expiresAfter: number | null; connectionId: string };
  if (p.vaultAddress !== null) deny('unsupported', 'sub-accounts and vaults are not traded');
  if (p.expiresAfter === null) deny('policy', 'the action carries no venue expiry: a signature that never expires is not released');
  const win = venueWindowError({ nonce: p.nonce, expiresAt: p.expiresAfter! }, nowMs);
  if (win) deny(/expired/.test(win) ? 'expired_action' : /stale/.test(win) ? 'stale_nonce' : 'policy', win);
  if (rec.nonces.includes(p.nonce)) deny('stale_nonce', 'nonce already used with this trading key');
  if (rec.nonces.length >= VENUE_NONCE_SET && p.nonce <= rec.nonces[0]!) deny('stale_nonce', 'nonce is below the lowest of the last nonces signed with this trading key');

  const today = day(now), usage = { ...(sm.usage[today] ?? emptyUsage()) }, authUsage = { ...(rec.usage[today] ?? { orders: 0, cancels: 0, leverage: 0 }) };
  let hash: string, summary: Record<string, unknown>, pending: NonNullable<StoredVenueAuthorization['pending']>[number] | null = null, hourMark = false, clientId: string | null = null;

  if (d.kind === 'cancel') {
    const cancels = d.detail.cancels as { instrument: string }[];
    for (const c of cancels) if (!a.policy.allowedInstruments.includes(c.instrument)) deny('instrument', `${c.instrument} is not allowed by the authorization`);
    usage.cancels += cancels.length; authUsage.cancels += cancels.length; hash = p.connectionId.slice(2);
    summary = { cancels: cancels.length, instruments: [...new Set(cancels.map((c) => c.instrument))] };
  } else if (d.kind === 'order') {
    if (!d.orders || d.orders.length !== 1) deny('unsupported', 'exactly one order per signature');
    const o = d.orders![0]!;
    // the order is taken from the PAYLOAD; what the API says about it only has to agree
    const cp = VenueOrderSchema.safeParse({ v: 1, authorizationId: a.authorizationId, venue: a.venue, network: a.network, account: a.account, kind: 'order', instrument: o.instrument, side: o.side, type: o.type, size: o.size, price: o.price,
      triggerPrice: o.triggerPrice, reduceOnly: o.reduceOnly, tif: o.tif, clientId: o.clientId, nonce: p.nonce, expiresAt: p.expiresAfter });
    if (!cp.success) deny('rejected', `the payload is not an order this signer signs (${cp.error.issues[0]?.path.join('.') ?? 'shape'})`);
    const c = cp.data!;
    if (req.context?.order !== undefined) {
      const said = VenueOrderSchema.safeParse(req.context.order);
      if (!said.success) deny('bad_request', 'malformed order description');
      const x = said.data!, same: [string, boolean][] = [
        ['authorization', x.authorizationId === c.authorizationId && x.venue === c.venue && x.network === c.network && x.account === c.account], ['nonce', x.nonce === c.nonce], ['expiry', x.expiresAt === c.expiresAt],
        ['instrument', x.instrument === c.instrument], ['side', x.side === c.side], ['type', x.type === c.type], ['size', canon(x.size) === canon(c.size)], ['price', canon(x.price) === canon(c.price)],
        ['trigger price', (x.triggerPrice === null ? null : canon(x.triggerPrice)) === (c.triggerPrice === null ? null : canon(c.triggerPrice))], ['reduce-only', x.reduceOnly === c.reduceOnly], ['time in force', x.tif === c.tif], ['client id', x.clientId === c.clientId],
      ];
      const diff = same.find(([, ok]) => !ok);
      if (diff) deny('mismatch', `the order described by the API and the payload to sign differ (${diff[0]})`);
    }
    const mi = m.instruments.find((i) => i.instrument === c.instrument);
    if (!mi) deny('instrument', `${c.instrument} is not allowed by the mandate`);
    const notional = venueOrderNotional(c);
    if (D.gt(D.from(notional), D.from(m.maxOrderNotional))) deny('order_notional', `order notional ${notional} is above the mandate's ${canon(m.maxOrderNotional)} per order`);
    if (rec.clientIds[c.clientId] !== undefined) deny('replay', 'an order with this client id was already signed');
    const symbol = c.instrument.slice(c.instrument.indexOf(':') + 1);
    let mid: string;
    try { const px = (await ctx.prices.get([symbol]))[symbol]; if (!(typeof px === 'number' && px > 0 && Number.isFinite(px))) throw new Error('no price'); mid = canon(px.toFixed(8)); }
    catch (e) { return deny('no_price', `the signer could not establish its own market price for ${symbol} (${(e as Error).message.slice(0, 80)}); order refused`); }
    // V11 (B-07): the same rule as /venue/sign — only a reduce-only trigger order may rest away from the market
    const off = venueOrderPriceError(c, mid, m.maxPriceDeviationBps);
    if (off) deny('price', `${off.reason} the signer's own ${symbol} price ${mid}`);
    let exposure: Record<string, unknown> = {};
    if (c.reduceOnly) usage.reduceOnly += 1;      // the venue never lets a reduce-only order add to a position or open the opposite one
    else {
      if (ph.phase !== 'active') deny('wind_down', `the mandate ${sm.revoked ? 'was revoked' : 'has expired'}: only cancels and reduce-only orders are signed until the wind-down ends`);
      if (st.state.halted) deny('halted', 'emergency halt is active: only cancels and reduce-only orders are signed');
      if (usage.orders >= m.maxOrdersPerDay) deny('orders_day', `the mandate's ${m.maxOrdersPerDay} orders per day are used`);
      if (authUsage.orders >= a.policy.maxOrdersPerDay) deny('orders_day', `the authorization's ${a.policy.maxOrdersPerDay} orders per day are used`);
      if (sm.hour.filter((t) => t > now - 3600).length >= m.maxOrdersPerHour) deny('orders_hour', `the mandate's ${m.maxOrdersPerHour} orders per hour are used`);
      const turnover = D.add(D.from(usage.turnover), D.from(notional));
      if (D.gt(turnover, D.from(m.maxDailyTurnover))) deny('turnover', `daily turnover would reach ${D.str(turnover)}, above the mandate's ${canon(m.maxDailyTurnover)}`);
      const own = await ownExposure(ctx, deny, a, m, rec, nowMs, c);
      if (D.lt(D.from(own.view.accountValue), D.from(m.floorEquity))) deny('floor_equity', `the venue reports an account value of ${own.view.accountValue}, below the mandate's floor of ${canon(m.floorEquity)}: only cancels and reduce-only orders are signed`);
      const held = own.open.find((x) => x.coin === symbol);
      let setting: { type: string; value: number };
      try { setting = held ? held.leverage : await ctx.venueInfo.leverage(a.network, a.account, symbol); }
      catch (e) { return deny('venue_unreachable', `the signer could not read the leverage setting of ${symbol} itself (${(e as Error).message.slice(0, 100)})`); }
      if (setting.value > mi!.maxLeverage) deny('leverage_setting', `${symbol} is set to ${setting.value}× on the venue, above the mandate's ${mi!.maxLeverage}×: lower it first`);
      const worst = own.exposure.perInstrument[c.instrument] ?? '0';
      if (D.gt(D.from(worst), D.from(mi!.maxPositionNotional))) deny('position_exceeded', `worst-case ${symbol} position ${worst} (venue position + resting and recently signed orders + this order, at the signer's price) is above the mandate's ${canon(mi!.maxPositionNotional)}`);
      if (D.gt(D.from(own.exposure.gross), D.from(m.maxGrossExposure))) deny('gross_exceeded', `worst-case gross exposure ${own.exposure.gross} is above the mandate's ${canon(m.maxGrossExposure)}`);
      usage.orders += 1; authUsage.orders += 1; usage.turnover = D.str(turnover); hourMark = true;
      pending = { clientId: c.clientId, instrument: c.instrument, side: c.side, size: canon(c.size), price: topPrice(c), until: c.expiresAt + VENUE_PENDING_GRACE_MS, signedAt: nowMs };
      exposure = { accountValue: own.view.accountValue, worstPosition: worst, worstGross: own.exposure.gross, leverageSetting: setting.value };
    }
    clientId = c.clientId; hash = hex(venueOrderHash(c));
    summary = { instrument: c.instrument, side: c.side, type: c.type, size: canon(c.size), price: canon(c.price), triggerPrice: c.triggerPrice, reduceOnly: c.reduceOnly, tif: c.tif, clientId: c.clientId, notional, mid, ...exposure };
  } else {
    if (ph.phase !== 'active') deny('wind_down', 'the mandate has ended: only cancels and reduce-only orders are signed until the wind-down ends');
    if (st.state.halted) deny('halted', 'emergency halt is active: only cancels and reduce-only orders are signed');
    const x = d.detail as { instrument: string; leverage: string; marginMode: string };
    const mi = m.instruments.find((i) => i.instrument === x.instrument);
    if (!mi) deny('instrument', `${x.instrument} is not allowed by the mandate`);
    const value = Number(x.leverage);
    if (!Number.isInteger(value) || value < 1 || value > mi!.maxLeverage) deny('leverage_exceeded', `leverage ${x.leverage} is above the mandate's ${mi!.maxLeverage}× for ${x.instrument}`);
    if (usage.leverage >= VENUE_MANDATE_BOUNDS.maxLeverageChangesPerDay) deny('leverage_rate', `at most ${VENUE_MANDATE_BOUNDS.maxLeverageChangesPerDay} leverage changes per day under a mandate`);
    // a margin-mode change moves the margin of an open position: never without the owner
    const own = await ownExposure(ctx, deny, a, m, rec, nowMs, null), symbol = x.instrument.slice(x.instrument.indexOf(':') + 1), held = own.open.find((q) => q.coin === symbol);
    if (held && held.leverage.type !== x.marginMode) deny('margin_mode', `${symbol} has an open position in ${held.leverage.type} margin: a mandate does not change the margin mode of an open position`);
    usage.leverage += 1; authUsage.leverage += 1; hash = p.connectionId.slice(2);
    summary = { instrument: x.instrument, leverage: value, marginMode: x.marginMode };
  }

  // counters, replay marker, exposure ledger and nonce are durable BEFORE the signature leaves
  if (clientId !== null) rec.clientIds[clientId] = Math.floor(now / 86400);
  if (pending) (rec.pending ??= []).push(pending);
  if (hourMark) sm.hour = [...sm.hour.filter((t) => t > now - 3600), now];
  sm.usage[today] = usage; rec.usage[today] = authUsage;
  rec.nonces = [...rec.nonces, p.nonce].sort((x, y) => x - y).slice(-VENUE_NONCE_SET);
  st.prune(now);
  const agent = ctx.keys.venueKey(a.venue, a.network);
  const signature = signatureFromHex(await sign({ hash: typedDataDigest((s.payload as HlL1SignPayload).typedData), privateKey: hexKey(agent.priv), to: 'hex' }));
  st.log('venue.mandate.sign.ok', { mandateId: id, authorizationId: a.authorizationId, phase: ph.phase, kind: d.kind, nonce: p.nonce, expiresAfter: p.expiresAfter, connectionId: p.connectionId, hash, ...summary });
  st.save();
  return { signature, signer: agent.address, kind: d.kind as VenueMandateSignResult['kind'], hash, mandateId: id, phase: ph.phase };
}
