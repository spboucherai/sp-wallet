// Derivative mandates, signer side: approval (passkey), and every rule of /venue/mandate/sign — accepted just inside, refused
// just outside. No network: prices are injected, and the venue's info endpoint is a scripted fake behind the REAL reader
// (venue-read.ts), so its parsing is exercised too. Nothing is sent to any venue. The mnemonic is the public BIP-39 test vector.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createHlTrading, D, hlPinnedAssets, jurisdictionAck, recoverTypedDataSigner, VENUE_MANDATE_WIND_DOWN_S, venueAuthorizationHash, venueMandateHash, venueOrderHash, worstCaseExposure,
  type HlL1SignPayload, type OrderRequest, type SignRequest, type VenueAuthorization, type VenueMandate, type VenueOrder,
} from '@spw/derivatives/live';
import { buildUsdClassTransferTypedDataOnly, l1SignPayload } from '../../../packages/derivatives/src/venues/hyperliquid/signing.ts';
import type { Instrument } from '../../../packages/derivatives/src/models.ts';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../src/keys.ts';
import { Signer } from '../src/signer.ts';
import { Store } from '../src/store.ts';
import { hyperliquidReader, noVenueReader, VENUE_INFO_URL } from '../src/venue-read.ts';

const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const ACCOUNT = keys.addresses.evm.toLowerCase(), AGENT = keys.venueKey('hyperliquid', 'testnet').address;
const ACK = jurisdictionAck('hyperliquid', 'fr').sha256, SHA = 'ab'.repeat(32);
let n = 0;
const uuid = () => `8b2d2f1e-9a6a-4c2f-8d67-${String(++n).padStart(12, '0')}`;
const inst = (symbol: string, lot: string): Instrument => ({ venue: 'hyperliquid', symbol, id: `hyperliquid:${symbol}`, base: symbol, quote: 'USD', kind: 'perpetual', collateral: 'USDC', settlement: '',
  tickSize: '0.1', lotSize: lot, minOrderSize: null, minNotional: '10', maxLeverage: '40', marginModes: ['cross', 'isolated'], fundingIntervalSec: 3600, markPriceMethod: '', status: 'active' });
const BTC = inst('BTC', '0.00001'), ETH = inst('ETH', '0.0001'), SOL = inst('SOL', '0.01');
const TTL = 90_000;
const tradingOf = (ttl: number | null) => createHlTrading({ network: 'testnet', assets: hlPinnedAssets('testnet'), expiresAfterMs: ttl });
const trading = tradingOf(TTL);

/** the venue's info endpoint, scripted: what the signer's own reader receives */
interface FakeVenue {
  accountValue: string; positions: { coin: string; szi: string; mark: string; lev?: { type: 'cross' | 'isolated'; value: number } }[]; orders: Record<string, unknown>[];
  lev: Record<string, { type: 'cross' | 'isolated'; value: number }>; fail: string; ageMs: number; totalNtlPos: string | null; mutate: ((type: string, answer: any) => unknown) | null; calls: { url: string; type: string }[];
}
const openOrder = (o: { coin?: string; side?: 'B' | 'A'; px: string; sz: string; reduceOnly?: boolean; trigger?: string; cloid?: string; timestamp?: number }) => ({ coin: o.coin ?? 'BTC', side: o.side ?? 'B', limitPx: o.px, sz: o.sz, oid: 1,
  timestamp: o.timestamp ?? 1, origSz: o.sz, isTrigger: o.trigger !== undefined, triggerPx: o.trigger ?? '0.0', reduceOnly: o.reduceOnly ?? false, orderType: 'Limit', tif: 'Gtc', cloid: o.cloid ?? null });

async function setup() {
  const t = { now: Math.floor(Date.now() / 1000) };
  const dir = mkdtempSync(join(tmpdir(), 'spw-mandate-'));
  const paths = [join(dir, 'state.json'), join(dir, 'policy.json')] as const;
  const store = new Store(...paths);
  store.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
  const px: Record<string, number> & { fail?: never } = { BTC: 70_000, ETH: 2_000, SOL: 100 }, pxFail = { why: '' };
  const prices = { get: async (syms: string[]) => { if (pxFail.why) throw new Error(pxFail.why); return Object.fromEntries(syms.map((s) => [s, px[s]!])); } };
  const venue: FakeVenue = { accountValue: '1000', positions: [], orders: [], lev: { BTC: { type: 'cross', value: 3 }, ETH: { type: 'cross', value: 3 }, SOL: { type: 'cross', value: 3 } }, fail: '', ageMs: 0, totalNtlPos: null, mutate: null, calls: [] };
  const value = (p: { szi: string; mark: string }) => D.mul(D.abs(D.from(p.szi)), D.from(p.mark));
  const post = async (url: string, body: any): Promise<unknown> => {
    venue.calls.push({ url, type: body.type });
    if (venue.fail) throw new Error(venue.fail);
    if (body.user !== ACCOUNT) throw new Error('the signer asked about another account');
    let answer: unknown;
    if (body.type === 'clearinghouseState') {
      const assetPositions = venue.positions.map((p) => ({ type: 'oneWay', position: { coin: p.coin, szi: p.szi, entryPx: p.mark, positionValue: D.str(value(p)), unrealizedPnl: '0.0', liquidationPx: null, marginUsed: '0.0',
        leverage: p.lev ?? venue.lev[p.coin] ?? { type: 'cross', value: 20 }, cumFunding: { allTime: '0.0', sinceOpen: '0.0', sinceChange: '0.0' } } }));
      const total = venue.totalNtlPos ?? D.str(venue.positions.reduce((s, p) => D.add(s, value(p)), D.zero));
      const summary = { accountValue: venue.accountValue, totalNtlPos: total, totalRawUsd: '0.0', totalMarginUsed: '0.0' };
      answer = { marginSummary: summary, crossMarginSummary: summary, crossMaintenanceMarginUsed: '0.0', withdrawable: '0.0', assetPositions, time: t.now * 1000 - venue.ageMs };
    } else if (body.type === 'frontendOpenOrders') answer = venue.orders;
    else if (body.type === 'activeAssetData') answer = { user: body.user, coin: body.coin, leverage: venue.lev[body.coin] ?? { type: 'cross', value: 20 }, markPx: '0' };
    else throw new Error(`fake venue: no answer for ${body.type}`);
    return venue.mutate ? venue.mutate(body.type, answer) : answer;
  };
  const make = (s: Store) => new Signer(keys, s, { rpId: RP, origin: ORIGIN }, () => t.now, prices, hyperliquidReader(post));
  const signer = make(store);
  const pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 'tok' });
  return { signer, store, pk, t, px, pxFail, venue, restart: () => make(new Store(...paths)) };
}
type World = Awaited<ReturnType<typeof setup>>;

const authorization = (now: number, o: Partial<VenueAuthorization> = {}, policy: Partial<VenueAuthorization['policy']> = {}): VenueAuthorization => ({
  v: 1, authorizationId: uuid(), keyId: keys.keyId, venue: 'hyperliquid', network: 'testnet', account: ACCOUNT, agentAddress: AGENT, agentName: 'spw-live', mode: 'MANUAL_LIVE',
  policy: { allowedInstruments: ['hyperliquid:BTC', 'hyperliquid:ETH'], maxLeverage: 5, maxOrderNotional: '300', maxPositionNotional: '500', maxGrossExposure: '800', maxOrdersPerDay: 50, maxPriceDeviationBps: 300, ...policy },
  createdAt: now, expiresAt: now + 60 * 86400, approveNonce: now * 1000, ackSha256: ACK, ...o });
const mandate = (a: VenueAuthorization, now: number, o: Partial<VenueMandate> = {}): VenueMandate => ({
  v: 1, mandateId: uuid(), authorizationId: a.authorizationId, keyId: a.keyId, venue: 'hyperliquid', network: a.network, account: a.account, agentAddress: a.agentAddress, strategySha256: SHA, agentId: 'agent-7',
  instruments: [{ instrument: 'hyperliquid:BTC', maxLeverage: 3, maxPositionNotional: '400' }], maxOrderNotional: '200', maxGrossExposure: '600', maxOrdersPerDay: 10, maxOrdersPerHour: 6, maxDailyTurnover: '1500',
  floorEquity: '100', maxPriceDeviationBps: 300, createdAt: now, expiresAt: now + 20 * 86400, ackSha256: ACK, ...o });
const code = async (p: Promise<unknown> | (() => unknown)) => { const e = await Promise.resolve().then(() => (typeof p === 'function' ? p() : p)).then(() => null, (x) => x); return e ? `${e.code}: ${e.message}` : 'ok'; };
const journal = (w: World, type: string) => w.store.state.journal.filter((j) => j.type === type);

async function authorized(w: World, o: Partial<VenueAuthorization> = {}, policy: Partial<VenueAuthorization['policy']> = {}) {
  const a = authorization(w.t.now, o, policy);
  await w.signer.venueAuthorize(a, w.pk.assert(venueAuthorizationHash(a)));
  return a;
}
/** an authorization and an approved mandate on it */
async function mandated(w: World, o: Partial<VenueMandate> = {}, policy: Partial<VenueAuthorization['policy']> = {}) {
  const a = await authorized(w, {}, policy), m = mandate(a, w.t.now, o);
  await w.signer.venueMandateApprove(m, w.pk.assert(venueMandateHash(m)));
  return { a, m };
}
let nonceSeq = 0;
/** an order as the engine builds it: the venue action and the sign request. No passkey anywhere. */
function order(w: World, o: Partial<OrderRequest> = {}, x: { instrument?: Instrument; nonce?: number; t?: ReturnType<typeof tradingOf> } = {}) {
  const instrument = x.instrument ?? BTC, nonce = x.nonce ?? w.t.now * 1000 + ++nonceSeq, t = x.t ?? trading;
  const req: OrderRequest = { instrument: instrument.id, side: 'buy', type: 'limit', size: '0.002', price: '70000', triggerPrice: null, reduceOnly: false, tif: 'gtc', clientId: `k-${nonce}`, ...o };
  const built = t.buildOrder(req, { instrument, nonce }), norm = t.normalizeRequest(req, instrument);
  const canonical = (a: VenueAuthorization): VenueOrder => ({ v: 1, authorizationId: a.authorizationId, venue: 'hyperliquid', network: a.network, account: a.account, kind: 'order', instrument: norm.instrument, side: norm.side,
    type: norm.type as VenueOrder['type'], size: norm.size, price: norm.price!, triggerPrice: norm.triggerPrice, reduceOnly: norm.reduceOnly, tif: norm.tif, clientId: norm.clientId, nonce, expiresAt: nonce + TTL });
  return { sign: built.sign, nonce, canonical };
}
const send = (w: World, m: VenueMandate, b: { sign: SignRequest }, context?: { order?: unknown }) => w.signer.venueMandateSign({ mandateId: m.mandateId, sign: b.sign, ...(context ? { context } : {}) });
const buy = (w: World, m: VenueMandate, o: Partial<OrderRequest> = {}, x: Parameters<typeof order>[2] = {}) => code(send(w, m, order(w, o, x)));
const st = (w: World, m: VenueMandate) => w.signer.status().venueMandates.find((x) => x.mandate.mandateId === m.mandateId)!;
/** past the venue expiry and the grace of everything signed so far: those orders can no longer be accepted by the venue */
const expirePending = (w: World) => { w.t.now += 101; };

describe('worst-case exposure (pure)', () => {
  const P = { 'hyperliquid:BTC': '70000', 'hyperliquid:ETH': '2000' };
  const o = (side: 'buy' | 'sell', size: string, price = '70000', reduceOnly = false, instrument = 'hyperliquid:BTC') => ({ instrument, side, size, price, reduceOnly });
  it('position at the price given + every order that can add, per side; the larger side is the bound; reduce-only orders never count', () => {
    expect(worstCaseExposure([], [], P)).toEqual({ perInstrument: {}, gross: '0' });
    expect(worstCaseExposure([{ instrument: 'hyperliquid:BTC', size: '0.01' }], [], P)).toEqual({ perInstrument: { 'hyperliquid:BTC': '700' }, gross: '700' });
    expect(worstCaseExposure([{ instrument: 'hyperliquid:BTC', size: '-0.01' }], [], P).gross).toBe('700');
    // long 0.01 + buys 0.003 → 910; sells 0.02 → short side 1400: whatever fills, |position| ≤ 1400
    expect(worstCaseExposure([{ instrument: 'hyperliquid:BTC', size: '0.01' }], [o('buy', '0.003'), o('sell', '0.02')], P).perInstrument['hyperliquid:BTC']).toBe('1400');
    // an opposite-side order never REDUCES the bound unless the venue guarantees it (reduce-only), and then it is simply not counted
    expect(worstCaseExposure([{ instrument: 'hyperliquid:BTC', size: '0.01' }], [o('sell', '0.01')], P).gross).toBe('700');
    expect(worstCaseExposure([{ instrument: 'hyperliquid:BTC', size: '0.01' }], [o('sell', '0.01', '70000', true), o('buy', '5', '70000', true)], P).gross).toBe('700');
    // an order is valued at the higher of its own price and the instrument's price
    expect(worstCaseExposure([], [o('buy', '0.01', '60000')], P).gross).toBe('700');
    expect(worstCaseExposure([], [o('sell', '0.01', '71000')], P).gross).toBe('710');
    expect(worstCaseExposure([{ instrument: 'hyperliquid:ETH', size: '0.5' }], [o('buy', '0.001')], P)).toEqual({ perInstrument: { 'hyperliquid:ETH': '1000', 'hyperliquid:BTC': '70' }, gross: '1070' });
  });
  it('refuses to value what it cannot: a position without a price, two positions on one instrument', () => {
    expect(() => worstCaseExposure([{ instrument: 'hyperliquid:DOGE', size: '10' }], [], P)).toThrow(/no price/);
    expect(() => worstCaseExposure([{ instrument: 'hyperliquid:BTC', size: '1' }, { instrument: 'hyperliquid:BTC', size: '1' }], [], P)).toThrow(/two positions/);
    expect(worstCaseExposure([{ instrument: 'hyperliquid:DOGE', size: '0' }], [o('buy', '100', '0.2', false, 'hyperliquid:DOGE')], P).gross).toBe('20');   // an order names its own price
  });
});

describe('mandate approval (one passkey assertion over the canonical mandate)', () => {
  it('stores the mandate; nothing is signed by any key; the status shows it active', async () => {
    const w = await setup(), a = await authorized(w), m = mandate(a, w.t.now);
    const r = await w.signer.venueMandateApprove(m, w.pk.assert(venueMandateHash(m)));
    expect(r).toEqual({ mandateId: m.mandateId, hash: Buffer.from(venueMandateHash(m)).toString('hex'), authorizationId: a.authorizationId });
    expect(st(w, m)).toMatchObject({ phase: 'active', revoked: false, expired: false, hash: r.hash, today: { orders: 0, reduceOnly: 0, turnover: '0' }, ordersLastHour: 0, pendingOrders: 0 });
    expect(journal(w, 'venue.mandate.approved')[0]!.data).toMatchObject({ mandateId: m.mandateId, authorizationId: a.authorizationId, strategySha256: SHA, agentId: 'agent-7', floorEquity: '100', ackSha256: ACK });
    expect(w.venue.calls).toHaveLength(0);
    expect(w.restart().status().venueMandates).toHaveLength(1);                                   // durable
  });

  it('refuses without the passkey, with another passkey, and when anything changed after the approval', async () => {
    const w = await setup(), a = await authorized(w), m = mandate(a, w.t.now);
    expect(await code(w.signer.venueMandateApprove(m, undefined))).toMatch(/^bad_approval/);
    expect(await code(w.signer.venueMandateApprove(m, new TestPasskey(RP, ORIGIN).assert(venueMandateHash(m))))).toMatch(/^unknown_credential/);
    for (const wider of [{ maxGrossExposure: '601' }, { floorEquity: '99' }, { maxDailyTurnover: '1501' }, { maxOrdersPerHour: 7 }, { strategySha256: 'cd'.repeat(32) }, { agentId: 'agent-8' }, { expiresAt: m.expiresAt + 1 },
      { instruments: [{ instrument: 'hyperliquid:BTC', maxLeverage: 3, maxPositionNotional: '401' }] }, { instruments: [{ instrument: 'hyperliquid:BTC', maxLeverage: 4, maxPositionNotional: '400' }] }])
      expect(await code(w.signer.venueMandateApprove({ ...m, ...wider }, w.pk.assert(venueMandateHash(m))))).toMatch(/^bad_approval/);
    expect(w.signer.status().venueMandates).toHaveLength(0);
    expect(journal(w, 'venue.mandate.denied').length).toBe(11);
  });

  it('a mandate can only be narrower than its authorization, and below the hard ceilings', async () => {
    const w = await setup(), a = await authorized(w);
    const hashOf = (m: VenueMandate) => { try { return venueMandateHash(m); } catch { return new Uint8Array(32); } };      // (a mandate outside the schema has no hash)
    const tryIt = (o: Partial<VenueMandate>) => { const m = mandate(a, w.t.now, o); return code(() => w.signer.venueMandateApprove(m, w.pk.assert(hashOf(m)))); };
    const i = (o: Partial<VenueMandate['instruments'][number]>) => ({ instruments: [{ instrument: 'hyperliquid:BTC', maxLeverage: 3, maxPositionNotional: '400', ...o }] });
    expect(await tryIt(i({ instrument: 'hyperliquid:SOL' }))).toMatch(/^unsupported: hyperliquid:SOL is not allowed by the authorization/);
    expect(await tryIt(i({ maxLeverage: 6 }))).toMatch(/leverage 6 is above the authorization's 5/);
    expect(await tryIt(i({ maxLeverage: 5 }))).toBe('ok');                                           // just inside (then revoked, for the next ones)
    for (const x of w.signer.status().venueMandates) w.signer.venueMandateRevoke(x.mandate.mandateId);
    expect(await tryIt(i({ maxPositionNotional: '500.01' }))).toMatch(/position limit above the authorization's 500/);
    expect(await tryIt({ maxOrderNotional: '300.01', ...i({ maxPositionNotional: '500' }) })).toMatch(/order limit above the authorization's 300/);
    expect(await tryIt({ maxGrossExposure: '800.01' })).toMatch(/gross exposure limit above the authorization's 800/);
    expect(await tryIt({ maxOrdersPerDay: 51 })).toMatch(/orders per day above the authorization's 50/);
    expect(await tryIt({ maxPriceDeviationBps: 301 })).toMatch(/price band wider than the authorization's 300/);
    expect(await tryIt({ maxOrderNotional: '260', ...i({ maxPositionNotional: '250' }) })).toMatch(/order limit above every position limit/);
    expect(await tryIt({ maxGrossExposure: '399' })).toMatch(/position limit above the mandate's gross exposure limit/);
    expect(await tryIt({ maxOrdersPerHour: 11 })).toMatch(/orders per hour above orders per day/);
    expect(await tryIt({ maxOrdersPerHour: 61, maxOrdersPerDay: 50 })).toMatch(/^bad_request/);     // hard ceiling: 60 an hour
    expect(await tryIt({ floorEquity: '0' })).toMatch(/^bad_request/);                              // a loss limit is not optional
    expect(await tryIt({ expiresAt: w.t.now + 30 * 86400 + 1 })).toMatch(/at most 30 days/);
    expect(await tryIt({ expiresAt: w.t.now + 30 * 86400 })).toBe('ok');                            // just inside
    for (const x of w.signer.status().venueMandates) w.signer.venueMandateRevoke(x.mandate.mandateId);
    expect(await tryIt({ createdAt: w.t.now - 601 })).toMatch(/not current/);
    expect(await tryIt({ ackSha256: 'ab'.repeat(32) })).toMatch(/^acknowledgement/);
    expect(await tryIt({ keyId: 'spw-0000000000000000' })).toMatch(/^wrong_key/);
    expect(await tryIt({ agentAddress: `0x${'22'.repeat(20)}` })).toMatch(/does not name the venue, network, account and trading key/);
    expect(await tryIt({ account: `0x${'11'.repeat(20)}` })).toMatch(/does not name/);
    expect(await tryIt({ network: 'mainnet' })).toMatch(/does not name/);
    expect(await code(w.signer.venueMandateApprove({ ...mandate(a, w.t.now), extra: 1 }, w.pk.assert(new Uint8Array(32))))).toMatch(/^bad_request/);
  });

  it('needs a live MANUAL_LIVE authorization of this signer; one active mandate per authorization; an id is never recorded twice; not under the emergency halt', async () => {
    const w = await setup(), a = await authorized(w);
    const approve = (m: VenueMandate) => code(() => w.signer.venueMandateApprove(m, w.pk.assert(venueMandateHash(m))));
    expect(await approve(mandate({ ...a, authorizationId: uuid() }, w.t.now))).toMatch(/^no_authorization/);
    // a mandate that would outlive its authorization
    const short = await (async () => { w.signer.venueRevoke(a.authorizationId); return authorized(w, { expiresAt: w.t.now + 5 * 86400 }); })();
    expect(await approve(mandate(short, w.t.now))).toMatch(/would outlive its authorization/);
    const m = mandate(short, w.t.now, { expiresAt: w.t.now + 5 * 86400 });
    expect(await approve(m)).toBe('ok');
    expect(await approve(m)).toMatch(/^replay/);
    expect(await approve(mandate(short, w.t.now, { expiresAt: w.t.now + 86400 }))).toMatch(/^conflict/);
    w.signer.venueMandateRevoke(m.mandateId);
    const m2 = mandate(short, w.t.now, { expiresAt: w.t.now + 86400 });
    expect(await approve(m2)).toBe('ok');                                                           // after a revocation a new one can be approved
    w.signer.venueMandateRevoke(m2.mandateId);
    expect(await approve(mandate(a, w.t.now))).toMatch(/^revoked: the venue authorization was revoked/);
    w.t.now += 5 * 86400;
    expect(await approve(mandate(short, w.t.now, { expiresAt: w.t.now + 60 }))).toMatch(/^expired/);
    const w2 = await setup(), a2 = await authorized(w2);
    w2.signer.halt();
    const mh = mandate(a2, w2.t.now);
    expect(await code(() => w2.signer.venueMandateApprove(mh, w2.pk.assert(venueMandateHash(mh))))).toMatch(/^halted/);
  });
});

describe('/venue/mandate/sign — an order without a passkey', () => {
  it('signs with the trading key after reading the venue account itself, and counts the order before the signature leaves', async () => {
    const w = await setup(), { a, m } = await mandated(w);
    const o = order(w);
    const r = await send(w, m, o);
    expect(r).toMatchObject({ kind: 'order', signer: AGENT, mandateId: m.mandateId, phase: 'active', hash: Buffer.from(venueOrderHash(o.canonical(a))).toString('hex') });
    expect(await recoverTypedDataSigner((o.sign.payload as HlL1SignPayload).typedData, r.signature)).toBe(AGENT);
    expect(st(w, m)).toMatchObject({ today: { orders: 1, reduceOnly: 0, turnover: '140' }, ordersLastHour: 1, pendingOrders: 1 });
    expect(w.signer.status().venues[0]).toMatchObject({ lastNonce: o.nonce, today: { orders: 1 } });      // the authorization's own daily count moves too
    expect(journal(w, 'venue.mandate.sign.ok')[0]!.data).toMatchObject({ kind: 'order', instrument: 'hyperliquid:BTC', side: 'buy', size: '0.002', price: '70000', notional: '140', mid: '70000', accountValue: '1000',
      worstPosition: '140', worstGross: '140', leverageSetting: 3, phase: 'active' });
    // the signer asked the venue's INFO endpoint only, on the pinned testnet host, about its own account
    expect(new Set(w.venue.calls.map((c) => c.url))).toEqual(new Set([VENUE_INFO_URL.testnet]));
    expect(w.venue.calls.map((c) => c.type)).toEqual(['frontendOpenOrders', 'clearinghouseState', 'activeAssetData']);
    // counters survive a restart
    expect(w.restart().status().venueMandates[0]).toMatchObject({ today: { orders: 1, turnover: '140' }, pendingOrders: 1 });
    // a market order is an IOC limit at its worst price; a trigger order is bounded by its trigger price too
    expect(await buy(w, m, { type: 'market', tif: 'ioc', price: '70300', size: '0.001' })).toBe('ok');
  });

  it('the Signer class without a venue reader (CLI, tests) signs nothing that can add exposure', async () => {
    const w = await setup(), { m } = await mandated(w);
    const bare = new Signer(keys, w.store, { rpId: RP, origin: ORIGIN }, () => w.t.now, { get: async (s) => Object.fromEntries(s.map((k) => [k, w.px[k]!])) });
    expect(await code(bare.venueMandateSign({ mandateId: m.mandateId, sign: order(w).sign }))).toMatch(/^venue_unreachable: .*no venue reader configured/);
    expect(await code(noVenueReader.leverage('testnet', ACCOUNT, 'BTC'))).toMatch(/no venue reader/);
  });

  it('order notional: accepted at the limit, refused one lot above — reduce-only orders included', async () => {
    const w = await setup(), { m } = await mandated(w, { maxOrderNotional: '140' });
    expect(await buy(w, m, { size: '0.002' })).toBe('ok');                                           // 0.002 × 70000 = 140
    expect(await buy(w, m, { size: '0.00201' })).toMatch(/^order_notional: order notional 140.7 is above the mandate's 140/);
    expect(await buy(w, m, { side: 'sell', reduceOnly: true, size: '0.00201' })).toMatch(/^order_notional/);
    // a stop is bounded by the higher of its limit and its trigger price
    expect(await buy(w, m, { type: 'stop_limit', side: 'sell', reduceOnly: true, size: '0.002', price: '69000', triggerPrice: '70000' })).toBe('ok');
    expect(await buy(w, m, { type: 'stop_limit', side: 'sell', reduceOnly: true, size: '0.002', price: '69000', triggerPrice: '70100' })).toMatch(/^order_notional/);
  });

  it('price band against the signer\'s own price: every price and trigger, reduce-only included; no price, no signature', async () => {
    const w = await setup(), { m } = await mandated(w);                                              // 300 bps around 70000: 67900 … 72100
    expect(await buy(w, m, { price: '67900', size: '0.001' })).toBe('ok');
    expect(await buy(w, m, { price: '67899', size: '0.001' })).toMatch(/^price: price 67899 is more than 300 bps away from the signer's own BTC price 70000/);
    expect(await buy(w, m, { side: 'sell', price: '72100', size: '0.001' })).toBe('ok');
    expect(await buy(w, m, { side: 'sell', price: '72101', size: '0.001' })).toMatch(/^price/);
    expect(await buy(w, m, { side: 'sell', reduceOnly: true, type: 'market', tif: 'ioc', price: '67899', size: '0.001' })).toMatch(/^price/);   // a give-away close is refused too
    // V11 (B-07): a trigger order that is NOT reduce-only stays inside the band, trigger included
    expect(await buy(w, m, { type: 'stop_market', side: 'sell', size: '0.001', price: '68000', triggerPrice: '67899' })).toMatch(/^price: trigger price 67899 is more than 300 bps away/);
    // a reduce-only stop-loss / take-profit may rest away from the market — its worst price near its own trigger — and nothing more
    expect(await buy(w, m, { type: 'stop_market', side: 'sell', reduceOnly: true, size: '0.001', price: '59000', triggerPrice: '60000' })).toBe('ok');
    expect(await buy(w, m, { type: 'take_profit_market', side: 'sell', reduceOnly: true, size: '0.001', price: '88000', triggerPrice: '90000' })).toBe('ok');
    expect(await buy(w, m, { type: 'stop_market', side: 'sell', reduceOnly: true, size: '0.001', price: '50000', triggerPrice: '60000' })).toMatch(/^price: price 50000 is more than 300 bps away from its own trigger price 60000/);
    expect(await buy(w, m, { type: 'stop_market', side: 'sell', reduceOnly: true, size: '0.001', price: '79000', triggerPrice: '80000' })).toMatch(/^price: trigger price 80000 would fire at once/);
    expect(await buy(w, m, { type: 'take_profit_market', side: 'sell', reduceOnly: true, size: '0.001', price: '59000', triggerPrice: '60000' })).toMatch(/would fire at once/);
    expect(await buy(w, m, { type: 'stop_market', side: 'sell', reduceOnly: true, size: '0.001', price: '22800', triggerPrice: '23000' })).toMatch(/outside the sanity band/);
    w.px.BTC = 75_000;                                                                               // the market moved: the same order is now outside
    expect(await buy(w, m, { price: '70000', size: '0.001' })).toMatch(/^price/);
    w.pxFail.why = 'price sources disagree on BTC';
    expect(await buy(w, m, { size: '0.001' })).toMatch(/^no_price: .*price sources disagree/);
    expect(await buy(w, m, { side: 'sell', reduceOnly: true, size: '0.001' })).toMatch(/^no_price/);
  });

  it('instrument outside the mandate (even if the authorization allows it), and outside the pinned table', async () => {
    const w = await setup(), { m } = await mandated(w);
    expect(await buy(w, m, { size: '0.05', price: '2000' }, { instrument: ETH })).toMatch(/^instrument: hyperliquid:ETH is not allowed by the mandate/);
    expect(await buy(w, m, { size: '0.05', price: '2000', side: 'sell', reduceOnly: true }, { instrument: ETH })).toMatch(/^instrument/);   // not even to close the owner's own position
    expect(await buy(w, m, { size: '1', price: '100' }, { instrument: SOL })).toMatch(/^instrument/);
    const doge = createHlTrading({ network: 'testnet', assets: [...hlPinnedAssets('testnet'), { symbol: 'DOGE', asset: 173, szDecimals: 0, maxLeverage: 10, isolatedOnly: false, delisted: false }], expiresAfterMs: TTL });
    expect(await buy(w, m, { size: '100', price: '0.2' }, { instrument: { ...BTC, symbol: 'DOGE', id: 'hyperliquid:DOGE', lotSize: '1' }, t: doge })).toMatch(/^rejected: payload refused/);
    expect(w.venue.calls).toHaveLength(0);
  });
});

describe('the exposure bound, under adversarial sequences', () => {
  it('many small orders: the worst case is counted as if every one filled — accepted at the limit, refused one cent below it', async () => {
    const w = await setup(), { m } = await mandated(w, { instruments: [{ instrument: 'hyperliquid:BTC', maxLeverage: 3, maxPositionNotional: '420' }] });
    expect(await buy(w, m)).toBe('ok'); expect(await buy(w, m)).toBe('ok');
    expect(await buy(w, m)).toBe('ok');                                                              // 3 × 140 = 420 ≤ 420
    expect(await buy(w, m, { size: '0.00001' })).toMatch(/^position_exceeded: worst-case BTC position 420.7 .* above the mandate's 420/);
    const w2 = await setup(), { m: m2 } = await mandated(w2, { instruments: [{ instrument: 'hyperliquid:BTC', maxLeverage: 3, maxPositionNotional: '419.99' }] });
    expect(await buy(w2, m2)).toBe('ok'); expect(await buy(w2, m2)).toBe('ok');
    expect(await buy(w2, m2)).toMatch(/^position_exceeded/);
    expect(st(w2, m2)).toMatchObject({ today: { orders: 2, turnover: '280' }, pendingOrders: 2 });   // a refusal counts nothing
  });

  it('orders left to expire free the bound only after their venue expiry (+ grace); filled ones stay counted through the venue\'s position', async () => {
    const w = await setup(), { m } = await mandated(w);                                              // position limit 400
    expect(await buy(w, m)).toBe('ok'); expect(await buy(w, m)).toBe('ok');
    expect(await buy(w, m)).toMatch(/^position_exceeded/);                                           // 420 > 400 although the venue shows nothing yet
    w.t.now += 99;                                                                                   // still inside expiry (90 s) + grace (10 s)
    expect(await buy(w, m)).toMatch(/^position_exceeded/);
    w.t.now += 2;
    expect(st(w, m).pendingOrders).toBe(0);
    expect(await buy(w, m)).toBe('ok');                                                              // they can no longer reach the venue, and the venue shows no position
    // the other outcome: they filled. The venue's own position replaces the ledger entries.
    expirePending(w);
    w.venue.positions = [{ coin: 'BTC', szi: '0.004', mark: '70000' }];                              // 280
    expect(await buy(w, m, { size: '0.00172' })).toMatch(/^position_exceeded: worst-case BTC position 400.4/);
    expect(await buy(w, m, { size: '0.00171' })).toBe('ok');                                         // 280 + 119.7 = 399.7
    // … valued at the SIGNER's price, not the venue's: the market rises 2 %, the same position is now worth 285.6
    expirePending(w); w.px.BTC = 71_400;
    expect(await buy(w, m, { size: '0.00161', price: '71400' })).toMatch(/^position_exceeded/);     // 285.6 + 114.954
    expect(await buy(w, m, { size: '0.0016', price: '71400' })).toBe('ok');                          // 285.6 + 114.24 = 399.84
  });

  it('alternating sides: an opposite order never lowers the bound; each side is its own worst case', async () => {
    const w = await setup(), { m } = await mandated(w, { maxOrdersPerHour: 10 });
    expect(await buy(w, m, { side: 'buy' })).toBe('ok'); expect(await buy(w, m, { side: 'sell' })).toBe('ok');
    expect(await buy(w, m, { side: 'buy' })).toBe('ok'); expect(await buy(w, m, { side: 'sell' })).toBe('ok');     // long side 280, short side 280
    expect(await buy(w, m, { side: 'buy' })).toMatch(/^position_exceeded/);                         // long side would be 420
    expect(await buy(w, m, { side: 'sell' })).toMatch(/^position_exceeded/);
    // long 0.004 on the venue and a pending non-reduce-only sell of the same size: the sell does not make room for a buy
    expirePending(w);
    w.venue.positions = [{ coin: 'BTC', szi: '0.004', mark: '70000' }];
    expect(await buy(w, m, { side: 'sell', size: '0.0028' })).toBe('ok');                            // short side: 196
    expect(await buy(w, m, { side: 'buy', size: '0.00172' })).toMatch(/^position_exceeded/);        // long side: 280 + 120.4
    // flipping with non-reduce-only orders is counted in full on the short side, with no credit for the long position: 196 + 199.5, then + 7
    expect(await buy(w, m, { side: 'sell', size: '0.00285' })).toBe('ok');
    expect(await buy(w, m, { side: 'sell', size: '0.0001' })).toMatch(/^position_exceeded: worst-case BTC position 402.5/);
  });

  it('reduce-only: never counted, never needs the venue — and saying "reduce-only" about a payload that is not is refused', async () => {
    const w = await setup(), { a, m } = await mandated(w);
    w.venue.positions = [{ coin: 'BTC', szi: '0.0055', mark: '70000' }];                             // 385: almost at the limit
    expect(await buy(w, m, { size: '0.00022' })).toMatch(/^position_exceeded/);
    const before = w.venue.calls.length;
    w.venue.fail = 'ECONNREFUSED';
    for (let k = 0; k < 12; k++) expect(await buy(w, m, { side: 'sell', reduceOnly: true, type: 'market', tif: 'ioc', price: '69800' })).toBe('ok');   // more than every counter allows
    expect(w.venue.calls.length).toBe(before);
    expect(st(w, m)).toMatchObject({ today: { orders: 0, reduceOnly: 12, turnover: '0' }, ordersLastHour: 0, pendingOrders: 0 });
    w.venue.fail = '';
    // a reduce-only BUY while long cannot add either (the venue refuses it): still not counted
    expect(await buy(w, m, { side: 'buy', reduceOnly: true })).toBe('ok');
    // the API describes a plain sell as reduce-only, or a larger order as a small one: the payload is what counts
    const plain = order(w, { side: 'sell', size: '0.0028' });
    expect(await code(send(w, m, plain, { order: { ...plain.canonical(a), reduceOnly: true } }))).toMatch(/^mismatch: .*\(reduce-only\)/);
    expect(await code(send(w, m, plain, { order: { ...plain.canonical(a), size: '0.0001' } }))).toMatch(/^mismatch: .*\(size\)/);
    expect(await code(send(w, m, plain, { order: { ...plain.canonical(a), instrument: 'hyperliquid:ETH' } }))).toMatch(/^mismatch: .*\(instrument\)/);
    expect(await code(send(w, m, plain, { order: { nonsense: true } }))).toMatch(/^bad_request/);
    expect(await code(send(w, m, plain, { order: plain.canonical(a) }))).toBe('ok');                 // a truthful description changes nothing
    // and without any description the non-reduce-only sell is counted on the short side like any order
    expect(await buy(w, m, { side: 'sell', size: '0.0028' })).toBe('ok');                            // short side: 196 + 196 = 392
    expect(await buy(w, m, { side: 'sell', size: '0.0002' })).toMatch(/^position_exceeded: worst-case BTC position 406/);
  });

  it('what rests on the venue counts (also when the wallet did not place it); reduce-only resting orders do not; a manual order just signed counts', async () => {
    const w = await setup(), { a, m } = await mandated(w);
    w.venue.orders = [openOrder({ px: '69000', sz: '0.004' }), openOrder({ side: 'A', px: '71000', sz: '0.002', reduceOnly: true }), openOrder({ coin: 'ETH', px: '2000', sz: '0.01' })];
    expect(await buy(w, m, { size: '0.00172' })).toMatch(/^position_exceeded: worst-case BTC position 400.4/);     // resting buy valued at the signer's 70000, not its 69000
    expect(await buy(w, m, { size: '0.00171' })).toBe('ok');
    // a resting stop is valued at its trigger price when that is higher
    w.venue.orders = [openOrder({ px: '69000', sz: '0.004', trigger: '72000' })]; expirePending(w);
    expect(await buy(w, m, { size: '0.00161' })).toMatch(/^position_exceeded: worst-case BTC position 400.7/);     // 0.004 × 72000 = 288, + 112.7
    expect(await buy(w, m, { size: '0.0016' })).toBe('ok');                                          // 288 + 112 = 400
    // an order the owner approved with his passkey a moment ago is not on the venue yet: the ledger has it
    w.venue.orders = []; expirePending(w);
    const manual = order(w, { size: '0.004' }), c = manual.canonical(a);
    await w.signer.venueSign({ authorizationId: a.authorizationId, sign: manual.sign, context: { order: c }, assertion: w.pk.assert(venueOrderHash(c)) });
    expect(st(w, m).pendingOrders).toBe(1);
    expect(await buy(w, m, { size: '0.00172' })).toMatch(/^position_exceeded/);
    expect(await buy(w, m, { size: '0.00171' })).toBe('ok');
  });

  it('a signed order that the venue lists as resting is counted once (through the venue) — but an OLDER order with the same client id is not mistaken for it', async () => {
    const w = await setup(), { a, m } = await mandated(w);
    const o1 = order(w), cloid = o1.canonical(a).clientId;
    expect(await code(send(w, m, o1))).toBe('ok');                                                   // 140, in the ledger
    expect(await buy(w, m)).toBe('ok');                                                              // 280
    expect(await buy(w, m, { size: '0.00001' })).toBe('ok');                                         // 280.7
    expect(await buy(w, m)).toMatch(/^position_exceeded/);                                           // 420.7
    // the venue now lists the first one as resting, half filled: remaining 0.001 + position 0.001 instead of the ledger's 0.002
    w.venue.orders = [openOrder({ px: '70000', sz: '0.001', cloid, timestamp: w.t.now * 1000 + 400 })];
    w.venue.positions = [{ coin: 'BTC', szi: '0.001', mark: '70000' }];
    expect(await buy(w, m, { size: '0.0017' })).toBe('ok');                                          // 70 + 70 + 140.7 + 119 = 399.7 (it would be 469.7 counted twice)
    // replay attempt: a resting order from long ago happens to carry the client id of an order signed now — the new one stays in the ledger
    const w2 = await setup(), { a: a2, m: m2 } = await mandated(w2);
    const n1 = order(w2, { size: '0.0028' }), old = n1.canonical(a2).clientId;
    w2.venue.orders = [openOrder({ px: '70000', sz: '0.00001', cloid: old, timestamp: (w2.t.now - 4 * 86400) * 1000, reduceOnly: true })];
    expect(await code(send(w2, m2, n1))).toBe('ok');                                                 // 196
    expect(st(w2, m2).pendingOrders).toBe(1);
    expect(await buy(w2, m2, { size: '0.0028' })).toBe('ok');                                        // 392
    expect(await buy(w2, m2, { size: '0.0002' })).toMatch(/^position_exceeded: worst-case BTC position 406/);   // the first is still counted in full
  });

  it('gross exposure over every instrument of the account, including positions the mandate does not trade', async () => {
    const two = { instruments: [{ instrument: 'hyperliquid:BTC', maxLeverage: 3, maxPositionNotional: '400' }, { instrument: 'hyperliquid:ETH', maxLeverage: 3, maxPositionNotional: '400' }], maxGrossExposure: '600' };
    const w = await setup(), { m } = await mandated(w, two);
    w.venue.positions = [{ coin: 'BTC', szi: '-0.005', mark: '70000' }, { coin: 'ETH', szi: '0.075', mark: '2000' }];   // 350 + 150 = 500
    expect(await buy(w, m, { size: '0.0501', price: '2000' }, { instrument: ETH })).toMatch(/^gross_exceeded: worst-case gross exposure 600.2 is above the mandate's 600/);
    expect(await buy(w, m, { size: '0.05', price: '2000' }, { instrument: ETH })).toBe('ok');        // 350 + 250 = 600
  });

  it('gross: a position on an instrument the mandate does not trade still fills the gross limit', async () => {
    const w = await setup(), { m } = await mandated(w);
    w.venue.positions = [{ coin: 'ETH', szi: '0.25', mark: '2000' }];                                // 500, the owner's own
    expect(await buy(w, m, { size: '0.00143' })).toMatch(/^gross_exceeded: worst-case gross exposure 600.1/);
    expect(await buy(w, m, { size: '0.00142' })).toBe('ok');                                         // 500 + 99.4
  });

  it('a position the signer cannot price itself stops every order that can add exposure', async () => {
    const w = await setup(), { m } = await mandated(w);
    w.venue.positions = [{ coin: 'DOGE', szi: '100', mark: '0.2' }];
    expect(await buy(w, m)).toMatch(/^unpriced_position: the account holds a position on DOGE/);
    expect(await buy(w, m, { side: 'sell', reduceOnly: true })).toBe('ok');
  });

  it('replay and nonce games buy nothing: a client id, a nonce and an expiry are single-use and short', async () => {
    const w = await setup(), { m } = await mandated(w);
    const o = order(w);
    expect(await code(send(w, m, o))).toBe('ok');
    expect(await code(send(w, m, o))).toMatch(/^stale_nonce: nonce already used/);
    expect(await buy(w, m, { clientId: `k-${o.nonce}` })).toMatch(/^replay: an order with this client id was already signed/);
    expect(await buy(w, m, {}, { nonce: (w.t.now - 121) * 1000 })).toMatch(/^(stale_nonce|expired_action)/);
    expect(await buy(w, m, {}, { nonce: (w.t.now + 61) * 1000 })).toMatch(/^policy: nonce is dated in the future/);
    expect(await buy(w, m, {}, { t: tradingOf(120_000) })).toBe('ok');                               // venue expiry at most 120 s after the nonce
    expect(await buy(w, m, {}, { t: tradingOf(120_001) })).toMatch(/^policy: validity window longer than 120 s/);
    expect(await buy(w, m, {}, { t: tradingOf(null) })).toMatch(/^policy: the action carries no venue expiry/);
    expect(st(w, m).today.orders).toBe(2);
  });

  it('only one order per action; nothing but orders, cancels and leverage changes; no vault; the right network', async () => {
    const w = await setup(), { m } = await mandated(w);
    const nonce = w.t.now * 1000 + 777, one = (trading.buildOrder({ instrument: BTC.id, side: 'buy', type: 'limit', size: '0.001', price: '70000', triggerPrice: null, reduceOnly: false, tif: 'gtc', clientId: 'two-a' }, { instrument: BTC, nonce }).action as any);
    const two = { ...one, orders: [one.orders[0], { ...one.orders[0], c: `0x${'12'.repeat(16)}` }] };
    const l1 = (action: unknown, vaultAddress: string | null = null): SignRequest => ({ venue: 'hyperliquid', network: 'testnet', kind: 'hl_l1',
      payload: { scheme: 'l1', action, nonce, vaultAddress, expiresAfter: nonce + TTL, typedData: l1SignPayload(action as never, { network: 'testnet', nonce, vaultAddress, expiresAfter: nonce + TTL }).typedData } });
    expect(await code(send(w, m, { sign: l1(two) }))).toMatch(/^unsupported: exactly one order per signature/);
    expect(await code(send(w, m, { sign: l1(one, `0x${'33'.repeat(20)}`) }))).toMatch(/^unsupported: sub-accounts and vaults/);
    expect(await code(send(w, m, { sign: trading.buildApproveAgent({ agentAddress: `0x${'66'.repeat(20)}`, agentName: 'evil', nonce }).sign }))).toMatch(/^unsupported: this payload is not an order, a cancel or a leverage change/);
    const xfer = buildUsdClassTransferTypedDataOnly({ network: 'testnet', amount: '10', toPerp: false, nonce });
    expect(await code(send(w, m, { sign: { venue: 'hyperliquid', network: 'testnet', kind: 'hl_user', payload: { scheme: 'user', action: xfer.action, typedData: xfer.typedData } } }))).toMatch(/^unsupported/);
    expect(await code(send(w, m, { sign: l1({ type: 'vaultTransfer', vaultAddress: `0x${'44'.repeat(20)}`, isDeposit: true, usd: 1 }) }))).toMatch(/^(unsupported|rejected)/);
    expect(await code(send(w, m, { sign: { ...order(w).sign, network: 'mainnet' } }))).toMatch(/^wrong_venue/);
    expect(await code(w.signer.venueMandateSign({ mandateId: uuid(), sign: order(w).sign }))).toMatch(/^not_found/);
    expect(await code(w.signer.venueMandateSign({ mandateId: m.mandateId } as never))).toMatch(/^bad_request/);
    expect(st(w, m).today.orders).toBe(0);
    expect(journal(w, 'venue.mandate.sign.denied').length).toBe(7);                                  // every refusal of a known mandate is logged with its code
    for (const j of journal(w, 'venue.mandate.sign.denied')) expect(['unsupported', 'rejected', 'wrong_venue', 'bad_request']).toContain((j.data as { code: string }).code);
  });
});

describe('counters: orders per day and per hour, daily turnover', () => {
  it('orders per hour (rolling) and per day (UTC): accepted up to the limit, refused after; reduce-only orders and cancels are never counted', async () => {
    const w = await setup(), { m } = await mandated(w, { maxOrdersPerHour: 3, maxOrdersPerDay: 5, maxDailyTurnover: '100000' });
    w.t.now = Math.floor(Date.parse('2026-11-12T00:00:10Z') / 1000);                                 // the start of a UTC day, so that the day does not turn inside the test
    const m2 = mandate((w.signer.status().venues[0]!.authorization as VenueAuthorization), w.t.now, { maxOrdersPerHour: 3, maxOrdersPerDay: 5, maxDailyTurnover: '100000' });
    w.signer.venueMandateRevoke(m.mandateId);
    await w.signer.venueMandateApprove(m2, w.pk.assert(venueMandateHash(m2)));
    const small = { size: '0.0002' };
    for (let k = 0; k < 3; k++) expect(await buy(w, m2, small)).toBe('ok');
    expect(await buy(w, m2, small)).toMatch(/^orders_hour: the mandate's 3 orders per hour are used/);
    expect(await buy(w, m2, { ...small, side: 'sell', reduceOnly: true })).toBe('ok');
    w.t.now += 3599;
    expect(await buy(w, m2, small)).toMatch(/^orders_hour/);
    w.t.now += 1;                                                                                    // the first one is now an hour old
    expect(await buy(w, m2, small)).toBe('ok');
    w.t.now += 3600;
    expect(await buy(w, m2, small)).toBe('ok');                                                      // 5 today
    w.t.now += 3600;
    expect(await buy(w, m2, small)).toMatch(/^orders_day: the mandate's 5 orders per day are used/);
    expect(await code(send(w, m2, { sign: trading.buildCancel({ instrument: BTC, clientId: 'anything', nonce: w.t.now * 1000 + 5 }).sign }))).toBe('ok');
    expect(st(w, m2)).toMatchObject({ today: { orders: 5, reduceOnly: 1, cancels: 1 } });
    w.t.now = Math.floor(Date.parse('2026-11-13T00:00:10Z') / 1000);                                 // next UTC day
    expect(await buy(w, m2, small)).toBe('ok');
  });

  it('the authorization\'s own daily count also bounds the mandate (manual and mandate orders share it)', async () => {
    const w = await setup(), { a, m } = await mandated(w, { maxOrdersPerDay: 3, maxOrdersPerHour: 3 }, { maxOrdersPerDay: 3 });
    const manual = order(w, { size: '0.0002' }), c = manual.canonical(a);
    await w.signer.venueSign({ authorizationId: a.authorizationId, sign: manual.sign, context: { order: c }, assertion: w.pk.assert(venueOrderHash(c)) });
    expect(await buy(w, m, { size: '0.0002' })).toBe('ok'); expect(await buy(w, m, { size: '0.0002' })).toBe('ok');
    expect(await buy(w, m, { size: '0.0002' })).toMatch(/^orders_day: the authorization's 3 orders per day are used/);
  });

  it('daily turnover: the sum of the notionals of the orders that can add exposure', async () => {
    const w = await setup(), { m } = await mandated(w, { maxDailyTurnover: '280' });
    expect(await buy(w, m)).toBe('ok');
    expirePending(w);
    expect(await buy(w, m, { side: 'sell', reduceOnly: true })).toBe('ok');                          // closing costs no turnover allowance
    expect(await buy(w, m)).toBe('ok');                                                              // 280 = 280
    expirePending(w);
    expect(await buy(w, m, { size: '0.00001' })).toMatch(/^turnover: daily turnover would reach 280.7, above the mandate's 280/);
  });
});

describe('loss limit and leverage, from the signer\'s own venue read', () => {
  it('account value below the floor: only reduce-only orders and cancels', async () => {
    const w = await setup(), { m } = await mandated(w);                                              // floor 100
    w.venue.accountValue = '100';
    expect(await buy(w, m)).toBe('ok');
    w.venue.accountValue = '99.99';
    expect(await buy(w, m)).toMatch(/^floor_equity: the venue reports an account value of 99.99, below the mandate's floor of 100/);
    w.venue.accountValue = '-5';
    expect(await buy(w, m)).toMatch(/^floor_equity/);
    expect(await buy(w, m, { side: 'sell', reduceOnly: true })).toBe('ok');
    expect(await code(send(w, m, { sign: trading.buildCancel({ instrument: BTC, clientId: 'x', nonce: w.t.now * 1000 + 9 }).sign }))).toBe('ok');
  });

  it('no order that can add exposure while the venue\'s leverage setting is above the mandate; the mandate can lower it, never raise it past its limit', async () => {
    const w = await setup(), { m } = await mandated(w);                                              // BTC ≤ 3×
    w.venue.lev.BTC = { type: 'cross', value: 20 };                                                  // the venue's default on a new account
    expect(await buy(w, m)).toMatch(/^leverage_setting: BTC is set to 20× on the venue, above the mandate's 3×/);
    const lev = (leverage: number, marginMode: 'cross' | 'isolated' = 'cross', instrument = BTC) => code(send(w, m, { sign: trading.buildUpdateLeverage({ instrument, leverage, marginMode, nonce: w.t.now * 1000 + ++nonceSeq }).sign }));
    expect(await lev(4)).toMatch(/^leverage_exceeded: leverage 4 is above the mandate's 3×/);
    expect(await lev(3)).toBe('ok');                                                                 // no passkey
    w.venue.lev.BTC = { type: 'cross', value: 3 };
    expect(await buy(w, m)).toBe('ok');
    expect(await lev(2, 'cross', ETH)).toMatch(/^instrument/);
    // with an open position the leverage setting is the position's own, and the margin mode cannot change
    w.venue.positions = [{ coin: 'BTC', szi: '0.001', mark: '70000', lev: { type: 'cross', value: 5 } }];
    expect(await buy(w, m, { size: '0.001' })).toMatch(/^leverage_setting: BTC is set to 5×/);
    expect(await lev(2, 'isolated')).toMatch(/^margin_mode: BTC has an open position in cross margin/);
    expect(await lev(2, 'cross')).toBe('ok');
    w.venue.positions = [];
    expect(await lev(2, 'isolated')).toBe('ok');                                                     // no position: the mode may change
    w.venue.fail = 'timeout';
    expect(await lev(2)).toMatch(/^venue_unreachable/);                                              // a leverage change needs the read too
    w.venue.fail = '';
    w.signer.halt();
    expect(await lev(2)).toMatch(/^halted/);
    expect(st(w, m).today.leverage).toBe(3);
  });

  it('at most 20 leverage changes a day', async () => {
    const w = await setup(), { m } = await mandated(w);
    w.t.now = Math.floor(Date.parse('2026-11-12T00:00:10Z') / 1000);
    const m2 = mandate((w.signer.status().venues[0]!.authorization as VenueAuthorization), w.t.now);
    w.signer.venueMandateRevoke(m.mandateId);
    await w.signer.venueMandateApprove(m2, w.pk.assert(venueMandateHash(m2)));
    const lev = () => code(send(w, m2, { sign: trading.buildUpdateLeverage({ instrument: BTC, leverage: 2, marginMode: 'cross', nonce: w.t.now * 1000 + ++nonceSeq }).sign }));
    for (let k = 0; k < 20; k++) expect(await lev()).toBe('ok');
    expect(await lev()).toMatch(/^leverage_rate/);
  });
});

describe('the signer\'s own read of the venue: fail closed', () => {
  it('unreachable, HTTP error, timeout → nothing that can add exposure is signed; reduce-only and cancels still are', async () => {
    const w = await setup(), { m } = await mandated(w);
    for (const why of ['fetch failed', 'HTTP 502', 'The operation was aborted due to timeout', 'response too large']) {
      w.venue.fail = why;
      expect(await buy(w, m)).toMatch(/^venue_unreachable: the signer could not read the venue account itself/);
    }
    expect(await buy(w, m, { side: 'sell', reduceOnly: true })).toBe('ok');
    expect(await code(send(w, m, { sign: trading.buildCancel({ instrument: BTC, clientId: 'x', nonce: w.t.now * 1000 + 3 }).sign }))).toBe('ok');
    w.venue.fail = '';
    // the leverage read alone failing is enough
    w.venue.mutate = (type, answer) => { if (type === 'activeAssetData') throw new Error('HTTP 429'); return answer; };
    expect(await buy(w, m)).toMatch(/^venue_unreachable: the signer could not read the leverage setting/);
    expect(st(w, m).today.orders).toBe(0);
  });

  it('stale: the venue\'s own timestamp must be within 30 s of the signer\'s clock, either way', async () => {
    const w = await setup(), { m } = await mandated(w);
    w.venue.ageMs = 30_000;
    expect(await buy(w, m)).toBe('ok');
    w.venue.ageMs = 30_001;
    expect(await buy(w, m)).toMatch(/^venue_stale: the venue's account state is dated 30 s from the signer's clock/);
    w.venue.ageMs = -30_001;
    expect(await buy(w, m)).toMatch(/^venue_stale/);
  });

  it('inconsistent or malformed answers are not believed', async () => {
    const w = await setup(), { m } = await mandated(w);
    w.venue.positions = [{ coin: 'BTC', szi: '0.001', mark: '70000' }];
    w.venue.totalNtlPos = '70.07';                                                                   // within 0.1 % + 0.01
    expect(await buy(w, m)).toBe('ok');
    w.venue.totalNtlPos = '700';                                                                     // the venue's total says ten times its positions
    expect(await buy(w, m)).toMatch(/^venue_inconsistent: the venue's positions \(70\) do not add up to its own total \(700\)/);
    w.venue.totalNtlPos = null;
    w.venue.positions = [{ coin: 'BTC', szi: '0.001', mark: '70000' }, { coin: 'BTC', szi: '0.002', mark: '70000' }];
    expect(await buy(w, m)).toMatch(/^venue_inconsistent: the venue lists two positions on BTC/);
    // the venue values the position 3 % away from the signer's price (band 300 bps): just inside, then just outside
    w.venue.positions = [{ coin: 'BTC', szi: '0.001', mark: '72100' }];
    expect(await buy(w, m)).toBe('ok');
    w.venue.positions = [{ coin: 'BTC', szi: '0.001', mark: '72101' }];
    expect(await buy(w, m)).toMatch(/^venue_inconsistent: the venue values the BTC position at 72.101; at the signer's own price it is 70/);
    w.venue.positions = [];
    const shapes: [string, (answer: any) => unknown][] = [
      ['clearinghouseState', () => '<html>upstream error</html>'], ['clearinghouseState', (x) => ({ ...x, time: 'now' })], ['clearinghouseState', (x) => ({ ...x, marginSummary: { ...x.marginSummary, accountValue: 1000 } })],
      ['clearinghouseState', (x) => ({ ...x, marginSummary: { ...x.marginSummary, accountValue: '1e3' } })], ['clearinghouseState', (x) => ({ ...x, assetPositions: [{ type: 'oneWay', position: { coin: 'BTC', szi: 'NaN', positionValue: '0', leverage: { type: 'cross', value: 3 } } }] })],
      ['clearinghouseState', (x) => ({ ...x, assetPositions: null })], ['frontendOpenOrders', () => ({ orders: [] })], ['frontendOpenOrders', () => [{ coin: 'BTC', side: 'X', limitPx: '1', sz: '1', reduceOnly: false, isTrigger: false }]],
      ['frontendOpenOrders', () => [{ coin: 'BTC', side: 'B', limitPx: '-1', sz: '1', reduceOnly: false, isTrigger: false }]], ['frontendOpenOrders', () => [{ coin: 'BTC', side: 'B', limitPx: '1', sz: '1', reduceOnly: 'no', isTrigger: false }]],
      ['activeAssetData', (x) => ({ ...x, leverage: { type: 'cross', value: 2.5 } })], ['activeAssetData', (x) => ({ ...x, coin: 'ETH' })], ['activeAssetData', (x) => ({ ...x, leverage: null })],
    ];
    for (const [type, f] of shapes) {
      w.venue.mutate = (t, answer) => (t === type ? f(answer) : answer);
      expect(await buy(w, m), `${type}: ${String(f)}`).toMatch(/^venue_unreachable: .*unexpected venue answer/);
    }
    w.venue.mutate = null;
    expect(st(w, m).today.orders).toBe(2);
  });

  it('the reader reads the recorded venue answers exactly, asks only the info endpoint of the pinned host, and never for another address', async () => {
    const fx = (name: string) => JSON.parse(readFileSync(new URL(`../../../packages/derivatives/test/fixtures/hyperliquid/mainnet-${name}.json`, import.meta.url), 'utf8')).body;
    const asked: { url: string; body: any }[] = [];
    const reader = hyperliquidReader(async (url, body: any) => { asked.push({ url, body }); return body.type === 'clearinghouseState' ? fx('clearinghouseState') : body.type === 'frontendOpenOrders' ? fx('frontendOpenOrders') : { leverage: { type: 'isolated', value: 7 }, coin: 'BTC' }; });
    const user = `0x${'ab'.repeat(20)}`, v = await reader.account('mainnet', user);
    expect(v).toMatchObject({ time: 1794366349403, accountValue: '6515.769962', totalNtlPos: '51217.3' });
    expect(v.positions[0]).toEqual({ coin: 'BTC', szi: '-0.3', positionValue: '22114.8', leverage: { type: 'cross', value: 40 } });
    expect(v.positions).toHaveLength(3); expect(v.openOrders).toHaveLength(7);
    expect(v.openOrders[0]).toEqual({ coin: 'AVAX', side: 'buy', size: '0.0', price: '9.4532', reduceOnly: true, cloid: null, timestamp: 1794365388140 });
    expect(await reader.leverage('mainnet', user, 'BTC')).toEqual({ type: 'isolated', value: 7 });
    expect(new Set(asked.map((a) => a.url))).toEqual(new Set(['https://api.hyperliquid.xyz/info']));
    expect(asked.map((a) => a.body)).toEqual([{ type: 'frontendOpenOrders', user }, { type: 'clearinghouseState', user }, { type: 'activeAssetData', user, coin: 'BTC' }]);
    expect(Object.values(VENUE_INFO_URL).every((u) => u.endsWith('/info'))).toBe(true);
    await expect(reader.account('mainnet', '0xNOPE')).rejects.toThrow(/account address/);
    await expect(reader.account('devnet' as never, user)).rejects.toThrow(/network/);
    await expect(reader.leverage('mainnet', user, 'BTC USD')).rejects.toThrow(/coin/);
  });
});

describe('stopping: emergency halt, revocation, expiry, wind-down', () => {
  const cancel = (w: World, m: VenueMandate) => code(send(w, m, { sign: trading.buildCancel({ instrument: BTC, clientId: 'c', nonce: w.t.now * 1000 + ++nonceSeq }).sign }));
  const close = (w: World, m: VenueMandate) => buy(w, m, { side: 'sell', reduceOnly: true, type: 'market', tif: 'ioc', price: '69800' });
  const lev = (w: World, m: VenueMandate) => code(send(w, m, { sign: trading.buildUpdateLeverage({ instrument: BTC, leverage: 2, marginMode: 'cross', nonce: w.t.now * 1000 + ++nonceSeq }).sign }));

  it('emergency halt: everything is blocked except cancels and reduce-only orders', async () => {
    const w = await setup(), { m } = await mandated(w);
    w.signer.halt();
    expect(await buy(w, m)).toMatch(/^halted: emergency halt is active: only cancels and reduce-only orders are signed/);
    expect(await lev(w, m)).toMatch(/^halted/);
    expect(await close(w, m)).toBe('ok');
    expect(await cancel(w, m)).toBe('ok');
    expect(w.venue.calls).toHaveLength(0);
  });

  it('revoked mandate: no new exposure from that instant; cancels and reduce-only orders for 24 h (wind-down); then nothing', async () => {
    const w = await setup(), { m } = await mandated(w);
    expect(await buy(w, m)).toBe('ok');
    const r = w.signer.venueMandateRevoke(m.mandateId);
    expect(r).toMatchObject({ revoked: true, windDownUntil: w.t.now + VENUE_MANDATE_WIND_DOWN_S });
    expect(w.signer.venueMandateRevoke(m.mandateId).revokedAt).toBe(r.revokedAt);                    // idempotent; never re-activated
    expect(st(w, m)).toMatchObject({ phase: 'wind_down', revoked: true });
    expect(await buy(w, m)).toMatch(/^wind_down: the mandate was revoked: only cancels and reduce-only orders are signed/);
    expect(await lev(w, m)).toMatch(/^wind_down/);
    expect(await close(w, m)).toBe('ok');
    expect(await cancel(w, m)).toBe('ok');
    expect(await code(w.restart().venueMandateSign({ mandateId: m.mandateId, sign: order(w).sign }))).toMatch(/^wind_down/);   // a restart changes nothing
    w.t.now += VENUE_MANDATE_WIND_DOWN_S - 1;
    expect(await close(w, m)).toBe('ok');                                                            // last second of the wind-down
    w.t.now += 1;
    expect(st(w, m).phase).toBe('ended');
    expect(await close(w, m)).toMatch(/^revoked: the mandate was revoked and its wind-down period is over/);
    expect(await cancel(w, m)).toMatch(/^revoked/);
    expect(await buy(w, m)).toMatch(/^revoked/);
    // the owner can still cancel through the authorization itself (manual path, no passkey for a cancel)
    const a = w.signer.status().venues[0]!.authorization as VenueAuthorization;
    expect(await code(w.signer.venueSign({ authorizationId: a.authorizationId, sign: trading.buildCancel({ instrument: BTC, clientId: 'c', nonce: w.t.now * 1000 + ++nonceSeq }).sign }))).toBe('ok');
  });

  it('expired mandate: the same wind-down, counted from the expiry', async () => {
    const w = await setup(), { m } = await mandated(w, { expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    w.t.now = m.expiresAt - 1;
    expect(await buy(w, m)).toBe('ok');                                                              // last second
    w.t.now = m.expiresAt;
    expect(st(w, m)).toMatchObject({ phase: 'wind_down', expired: true });
    expect(await buy(w, m)).toMatch(/^wind_down: the mandate has expired/);
    expect(await close(w, m)).toBe('ok');
    w.t.now = m.expiresAt + VENUE_MANDATE_WIND_DOWN_S;
    expect(await close(w, m)).toMatch(/^expired: the mandate expired and its wind-down period is over/);
  });

  it('the authorization is the root: revoked or expired, the mandate signs nothing at all — no wind-down, not even a cancel', async () => {
    const w = await setup(), { a, m } = await mandated(w);
    w.signer.venueRevoke(a.authorizationId);
    expect(st(w, m).phase).toBe('ended');
    for (const p of [buy(w, m), close(w, m), cancel(w, m), lev(w, m)]) expect(await p).toMatch(/^revoked: the venue authorization of this mandate was revoked: nothing is signed/);
    const w2 = await setup(), a2 = await authorized(w2, { expiresAt: Math.floor(Date.now() / 1000) + 2 * 86400 }), m2 = mandate(a2, w2.t.now, { expiresAt: a2.expiresAt });
    await w2.signer.venueMandateApprove(m2, w2.pk.assert(venueMandateHash(m2)));
    w2.t.now = a2.expiresAt;
    for (const p of [buy(w2, m2), close(w2, m2), cancel(w2, m2)]) expect(await p).toMatch(/^expired: the venue authorization of this mandate has expired/);
    expect(w2.venue.calls).toHaveLength(0);
  });

  it('manual mode is untouched by a mandate: an order through /venue/sign still needs the passkey', async () => {
    const w = await setup(), { a } = await mandated(w);
    const o = order(w), c = o.canonical(a);
    expect(await code(w.signer.venueSign({ authorizationId: a.authorizationId, sign: o.sign, context: { order: c } }))).toMatch(/^bad_approval: MANUAL_LIVE: every order needs the owner's passkey approval/);
    expect(await code(w.signer.venueSign({ authorizationId: a.authorizationId, sign: o.sign, context: { order: c }, assertion: w.pk.assert(venueOrderHash(c)) }))).toBe('ok');
  });
});
