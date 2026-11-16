// Quoting mandates (market making), signer side: approval (passkey), and every rule of /venue/quoting/sign — accepted just
// inside, refused just outside, each violation on its own. No network: prices are injected (and, for the freshness rules, the
// REAL price view runs on scripted exchange answers), the venue's info endpoint is a scripted fake behind the REAL reader
// (venue-read.ts). Nothing is sent to any venue. The mnemonic is the public BIP-39 test vector.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  bucketAt, bucketFull, bucketTake, createHlTrading, D, DMS_MAX_LAPSES_PER_DAY, hex, hlPinnedAssets, jurisdictionAck, QUOTING_MANDATE_BOUNDS, quoteBandError, quotingSetCheck, recoverTypedDataSigner, VENUE_MANDATE_WIND_DOWN_S,
  venueAuthorizationHash, venueMandateBytes, venueMandateHash, venueOrderHash, venueQuotingMandateBytes, venueQuotingMandateHash,
  type HlL1SignPayload, type OrderRequest, type SignRequest, type VenueAuthorization, type VenueMandate, type VenueOrder, type VenueQuotingMandate,
} from '@spw/derivatives/live';
import { buildUsdClassTransferTypedDataOnly, l1SignPayload } from '../../../packages/derivatives/src/venues/hyperliquid/signing.ts';
import type { Instrument } from '../../../packages/derivatives/src/models.ts';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../src/keys.ts';
import { exchangePrices, KRAKEN_STATUS_URL, type JsonGet, type PriceView } from '../src/prices.ts';
import { Signer } from '../src/signer.ts';
import { Store } from '../src/store.ts';
import { hyperliquidReader, VENUE_INFO_URL } from '../src/venue-read.ts';

const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const ACCOUNT = keys.addresses.evm.toLowerCase(), AGENT = keys.venueKey('hyperliquid', 'testnet').address;
const ACK = jurisdictionAck('hyperliquid', 'fr').sha256, SHA = 'ab'.repeat(32);
let n = 0;
const uuid = () => `8b2d2f1e-9a6a-4c2f-8d67-${String(++n).padStart(12, '0')}`;
const inst = (symbol: string, lot: string): Instrument => ({ venue: 'hyperliquid', symbol, id: `hyperliquid:${symbol}`, base: symbol, quote: 'USD', kind: 'perpetual', collateral: 'USDC', settlement: '',
  tickSize: '0.1', lotSize: lot, minOrderSize: null, minNotional: '10', maxLeverage: '40', marginModes: ['cross', 'isolated'], fundingIntervalSec: 3600, markPriceMethod: '', status: 'active' });
const BTC = inst('BTC', '0.00001'), ETH = inst('ETH', '0.0001'), SOL = inst('SOL', '0.01');
const TTL = 10_000;
const tradingOf = (ttl: number | null) => createHlTrading({ network: 'testnet', assets: hlPinnedAssets('testnet'), expiresAfterMs: ttl });
const trading = tradingOf(TTL);

interface FakeVenue {
  accountValue: string; positions: { coin: string; szi: string; mark: string; lev?: { type: 'cross' | 'isolated'; value: number } }[]; orders: Record<string, unknown>[];
  lev: Record<string, { type: 'cross' | 'isolated'; value: number }>; fail: string; ageMs: number; calls: { url: string; type: string }[];
}
const openOrder = (o: { coin?: string; side?: 'B' | 'A'; px: string; sz: string; reduceOnly?: boolean; cloid?: string | null; timestamp?: number }) => ({ coin: o.coin ?? 'BTC', side: o.side ?? 'B', limitPx: o.px, sz: o.sz, oid: 1,
  timestamp: o.timestamp ?? 1, origSz: o.sz, isTrigger: false, triggerPx: '0.0', reduceOnly: o.reduceOnly ?? false, orderType: 'Limit', tif: 'Alo', cloid: o.cloid ?? null });

async function setup(o: { prices?: (now: () => number) => PriceView } = {}) {
  const t = { now: Math.floor(Date.parse('2026-11-16T10:00:00Z') / 1000) };
  const dir = mkdtempSync(join(tmpdir(), 'spw-quoting-'));
  const paths = [join(dir, 'state.json'), join(dir, 'policy.json')] as const;
  const store = new Store(...paths);
  store.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
  const px: Record<string, number> = { BTC: 70_000, ETH: 2_000, SOL: 100 }, pxFail = { why: '' };
  const prices: PriceView = o.prices ? o.prices(() => t.now * 1000) : { get: async (syms: string[]) => { if (pxFail.why) throw new Error(pxFail.why); return Object.fromEntries(syms.map((s) => [s, px[s]!])); } };
  const venue: FakeVenue = { accountValue: '1000', positions: [], orders: [], lev: { BTC: { type: 'cross', value: 3 }, ETH: { type: 'cross', value: 3 }, SOL: { type: 'cross', value: 3 } }, fail: '', ageMs: 0, calls: [] };
  const value = (p: { szi: string; mark: string }) => D.mul(D.abs(D.from(p.szi)), D.from(p.mark));
  const post = async (url: string, body: any): Promise<unknown> => {
    venue.calls.push({ url, type: body.type });
    if (venue.fail) throw new Error(venue.fail);
    if (body.user !== ACCOUNT) throw new Error('the signer asked about another account');
    if (body.type === 'clearinghouseState') {
      const assetPositions = venue.positions.map((p) => ({ type: 'oneWay', position: { coin: p.coin, szi: p.szi, entryPx: p.mark, positionValue: D.str(value(p)), unrealizedPnl: '0.0', liquidationPx: null, marginUsed: '0.0',
        leverage: p.lev ?? venue.lev[p.coin] ?? { type: 'cross', value: 20 }, cumFunding: { allTime: '0.0', sinceOpen: '0.0', sinceChange: '0.0' } } }));
      const summary = { accountValue: venue.accountValue, totalNtlPos: D.str(venue.positions.reduce((s, p) => D.add(s, value(p)), D.zero)), totalRawUsd: '0.0', totalMarginUsed: '0.0' };
      return { marginSummary: summary, crossMarginSummary: summary, crossMaintenanceMarginUsed: '0.0', withdrawable: '0.0', assetPositions, time: t.now * 1000 - venue.ageMs };
    }
    if (body.type === 'frontendOpenOrders') return venue.orders;
    if (body.type === 'activeAssetData') return { user: body.user, coin: body.coin, leverage: venue.lev[body.coin] ?? { type: 'cross', value: 20 }, markPx: '0' };
    throw new Error(`fake venue: no answer for ${body.type}`);
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
const btc = (o: Partial<VenueQuotingMandate['instruments'][number]> = {}) => ({ instrument: 'hyperliquid:BTC', maxLeverage: 3, maxQuoteNotional: '150', maxRestingPerSide: 2, maxRestingNotionalPerSide: '290', maxInventoryNotional: '400', ...o });
const RATE = { burstActions: 5, actionsPerMinute: 10, ordersPerHour: 100, ordersPerDay: 500, dailyTurnover: '20000' };
const mandate = (a: VenueAuthorization, now: number, o: Partial<VenueQuotingMandate> = {}): VenueQuotingMandate => ({
  v: 1, mandateId: uuid(), authorizationId: a.authorizationId, keyId: a.keyId, venue: 'hyperliquid', network: a.network, account: a.account, agentAddress: a.agentAddress, strategySha256: SHA, agentId: 'mm-1',
  instruments: [btc()], maxRestingTotal: 4, maxGrossExposure: '600', minHalfSpreadBps: 2, maxDistanceBps: 100, maxReduceDeviationBps: 50, floorEquity: '100', rate: RATE, deadManSeconds: 60,
  createdAt: now, expiresAt: now + 5 * 86400, ackSha256: ACK, ...o });
const directional = (a: VenueAuthorization, now: number): VenueMandate => ({ v: 1, mandateId: uuid(), authorizationId: a.authorizationId, keyId: a.keyId, venue: 'hyperliquid', network: a.network, account: a.account, agentAddress: a.agentAddress,
  strategySha256: SHA, agentId: 'agent-7', instruments: [{ instrument: 'hyperliquid:BTC', maxLeverage: 3, maxPositionNotional: '400' }], maxOrderNotional: '200', maxGrossExposure: '600', maxOrdersPerDay: 10, maxOrdersPerHour: 6,
  maxDailyTurnover: '1500', floorEquity: '100', maxPriceDeviationBps: 300, createdAt: now, expiresAt: now + 20 * 86400, ackSha256: ACK });
const code = async (p: Promise<unknown> | (() => unknown)) => { const e = await Promise.resolve().then(() => (typeof p === 'function' ? p() : p)).then(() => null, (x) => x); return e ? `${e.code}: ${e.message}` : 'ok'; };
const journal = (w: World, type: string) => w.store.state.journal.filter((j) => j.type === type);

async function authorized(w: World, o: Partial<VenueAuthorization> = {}, policy: Partial<VenueAuthorization['policy']> = {}) {
  const a = authorization(w.t.now, o, policy);
  await w.signer.venueAuthorize(a, w.pk.assert(venueAuthorizationHash(a)));
  return a;
}
async function mandated(w: World, o: Partial<VenueQuotingMandate> = {}, policy: Partial<VenueAuthorization['policy']> = {}) {
  const a = await authorized(w, {}, policy), m = mandate(a, w.t.now, o);
  await w.signer.venueQuotingApprove(m, w.pk.assert(venueQuotingMandateHash(m)));
  return { a, m };
}
let seq = 0;
const nonceOf = (w: World) => w.t.now * 1000 + ++seq;
type Q = Partial<OrderRequest>;
const req = (o: Q, k: number, instrument = BTC): OrderRequest => ({ instrument: instrument.id, side: 'buy', type: 'limit', size: '0.002', price: '69900', triggerPrice: null, reduceOnly: false, tif: 'alo', clientId: `q-${seq}-${k}`, ...o });
/** a batch as the engine builds it */
function batch(w: World, orders: Q[], x: { instrument?: Instrument; nonce?: number; t?: ReturnType<typeof tradingOf> } = {}) {
  const nonce = x.nonce ?? nonceOf(w), instrument = x.instrument ?? BTC, t = x.t ?? trading;
  const items = orders.map((o, k) => ({ req: req(o, k, instrument), instrument }));
  const built = t.buildOrders(items, { nonce });
  return { sign: built.sign, nonce, cloids: (built.action.orders).map((q) => q.c!), action: built.action };
}
const send = (w: World, m: VenueQuotingMandate, b: { sign: SignRequest }) => w.signer.venueQuotingSign({ mandateId: m.mandateId, sign: b.sign });
const quote = (w: World, m: VenueQuotingMandate, orders: Q[] = [{}], x: Parameters<typeof batch>[2] = {}) => code(send(w, m, batch(w, orders, x)));
const BID: Q = { side: 'buy', price: '69900' }, ASK: Q = { side: 'sell', price: '70100' };
const reduce = (o: Q = {}): Q => ({ side: 'sell', reduceOnly: true, tif: 'ioc', price: '69800', ...o });
const arm = (w: World, m: VenueQuotingMandate, aheadS = 30, t = trading) => code(send(w, m, t.buildScheduleCancel({ time: (w.t.now + aheadS) * 1000, nonce: nonceOf(w) })));
const disarm = (w: World, m: VenueQuotingMandate) => code(send(w, m, trading.buildScheduleCancel({ time: null, nonce: nonceOf(w) })));
const cancel = (w: World, m: VenueQuotingMandate, instrument = BTC) => code(send(w, m, trading.buildCancels([{ instrument, clientId: 'anything' }, { instrument, clientId: 'other' }], { nonce: nonceOf(w) })));
const st = (w: World, m: VenueQuotingMandate) => w.signer.status().venueQuotingMandates.find((x) => x.mandate.mandateId === m.mandateId)!;
/** an armed mandate, ready to quote */
async function ready(w: World, o: Partial<VenueQuotingMandate> = {}, policy: Partial<VenueAuthorization['policy']> = {}) { const r = await mandated(w, o, policy); expect(await arm(w, r.m)).toBe('ok'); return r; }
/** past the venue expiry and the grace of everything signed so far */
const expirePending = async (w: World, m: VenueQuotingMandate) => { w.t.now += 21; expect(await arm(w, m)).toBe('ok'); };
const l1 = (w: World, action: unknown, o: { vault?: string | null; ttl?: number | null; nonce?: number } = {}): { sign: SignRequest } => {
  const nonce = o.nonce ?? nonceOf(w), expiresAfter = o.ttl === null ? null : nonce + (o.ttl ?? TTL), vaultAddress = o.vault ?? null;
  return { sign: { venue: 'hyperliquid', network: 'testnet', kind: 'hl_l1', payload: { scheme: 'l1', action, nonce, vaultAddress, expiresAfter, typedData: l1SignPayload(action as never, { network: 'testnet', nonce, vaultAddress, expiresAfter }).typedData } } };
};

describe('the directional mandate SPW-VENUE-MANDATE-v1 is unchanged (regression pins)', () => {
  const fixed: VenueMandate = { v: 1, mandateId: '8b2d2f1e-9a6a-4c2f-8d67-000000000001', authorizationId: '8b2d2f1e-9a6a-4c2f-8d67-000000000002', keyId: 'spw-0123456789abcdef', venue: 'hyperliquid', network: 'testnet',
    account: `0x${'11'.repeat(20)}`, agentAddress: `0x${'22'.repeat(20)}`, strategySha256: 'ab'.repeat(32), agentId: 'agent-7',
    instruments: [{ instrument: 'hyperliquid:ETH', maxLeverage: 2, maxPositionNotional: '300.50' }, { instrument: 'hyperliquid:BTC', maxLeverage: 3, maxPositionNotional: '400' }],
    maxOrderNotional: '200', maxGrossExposure: '600', maxOrdersPerDay: 10, maxOrdersPerHour: 6, maxDailyTurnover: '1500', floorEquity: '100', maxPriceDeviationBps: 300, createdAt: 1794000000, expiresAt: 1794000000 + 20 * 86400, ackSha256: 'cd'.repeat(32) };
  it('same canonical bytes and hash as on branch v11 before this work (computed there: 791 bytes, 58a24d2c…)', () => {
    expect(venueMandateBytes(fixed).length).toBe(791);
    expect(hex(venueMandateHash(fixed))).toBe('58a24d2c0cffffcb4f535846606cee427785d46cc4c5ca3da77a26ff88632a12');
    expect(new TextDecoder().decode(venueMandateBytes(fixed).subarray(0, 20))).toBe('SPW-VENUE-MANDATE-v1');
    expect(new TextDecoder().decode(venueQuotingMandateBytes(mandate(authorization(1794000000), 1794000000)).subarray(0, 28))).toBe('SPW-VENUE-QUOTING-MANDATE-v1');
  });
  it('a directional mandate still signs one order, refuses a batch, and refuses a scheduleCancel with the same code and message as before', async () => {
    const w = await setup(), a = await authorized(w), d = directional(a, w.t.now);
    await w.signer.venueMandateApprove(d, w.pk.assert(venueMandateHash(d)));
    const t90 = tradingOf(90_000), nonce = nonceOf(w);
    const one = t90.buildOrder(req({ tif: 'gtc', price: '70000' }, 0), { instrument: BTC, nonce });
    expect((await w.signer.venueMandateSign({ mandateId: d.mandateId, sign: one.sign })).kind).toBe('order');
    expect(await code(w.signer.venueMandateSign({ mandateId: d.mandateId, sign: t90.buildOrders([{ req: req({}, 1), instrument: BTC }, { req: req({}, 2), instrument: BTC }], { nonce: nonceOf(w) }).sign })))
      .toBe('unsupported: exactly one order per signature');
    expect(await code(w.signer.venueMandateSign({ mandateId: d.mandateId, sign: t90.buildScheduleCancel({ time: (w.t.now + 30) * 1000, nonce: nonceOf(w) }).sign })))
      .toBe('unsupported: this payload is not an order, a cancel or a leverage change (scheduleCancel): a mandate signs nothing else');
    // manual mode: same
    expect(await code(w.signer.venueSign({ authorizationId: a.authorizationId, sign: t90.buildScheduleCancel({ time: (w.t.now + 30) * 1000, nonce: nonceOf(w) }).sign })))
      .toBe('unsupported: this payload is not an order, a cancel or a leverage change (scheduleCancel): the trading key signs nothing else');
    // and a directional mandate cannot be used through the quoting route, nor the reverse
    expect(await code(w.signer.venueQuotingSign({ mandateId: d.mandateId, sign: one.sign }))).toMatch(/^not_found/);
  });
});

describe('quoting mandate approval — one passkey assertion over the canonical mandate, the same ceremony', () => {
  it('stores the mandate; nothing is signed by any key; the status shows it active, unarmed, bucket full', async () => {
    const w = await setup(), a = await authorized(w), m = mandate(a, w.t.now);
    const r = await w.signer.venueQuotingApprove(m, w.pk.assert(venueQuotingMandateHash(m)));
    expect(r).toEqual({ mandateId: m.mandateId, hash: hex(venueQuotingMandateHash(m)), authorizationId: a.authorizationId });
    expect(st(w, m)).toMatchObject({ phase: 'active', revoked: false, expired: false, hash: r.hash, today: { quotes: 0, batches: 0, turnover: '0', lapses: 0 }, bucketActions: 5, deadMan: { armed: false, deadline: null }, pendingQuotes: 0 });
    expect(journal(w, 'venue.quoting.approved')[0]!.data).toMatchObject({ mandateId: m.mandateId, strategySha256: SHA, agentId: 'mm-1', minHalfSpreadBps: 2, maxDistanceBps: 100, deadManSeconds: 60, rate: RATE });
    expect(w.venue.calls).toHaveLength(0);
    expect(w.restart().status().venueQuotingMandates).toHaveLength(1);
  });

  it('mandate hash mismatch: refused without the passkey, with another passkey, and when ANY field changed after the approval', async () => {
    const w = await setup(), a = await authorized(w), m = mandate(a, w.t.now);
    expect(await code(w.signer.venueQuotingApprove(m, undefined))).toMatch(/^bad_approval/);
    expect(await code(w.signer.venueQuotingApprove(m, new TestPasskey(RP, ORIGIN).assert(venueQuotingMandateHash(m))))).toMatch(/^unknown_credential/);
    const wider: Partial<VenueQuotingMandate>[] = [{ maxGrossExposure: '601' }, { floorEquity: '99' }, { minHalfSpreadBps: 1 }, { maxDistanceBps: 101 }, { maxReduceDeviationBps: 51 }, { maxRestingTotal: 5 }, { deadManSeconds: 61 },
      { rate: { ...RATE, burstActions: 6 } }, { rate: { ...RATE, actionsPerMinute: 11 } }, { rate: { ...RATE, ordersPerHour: 101 } }, { rate: { ...RATE, ordersPerDay: 501 } }, { rate: { ...RATE, dailyTurnover: '20001' } },
      { strategySha256: 'cd'.repeat(32) }, { agentId: 'mm-2' }, { expiresAt: m.expiresAt + 1 },
      { instruments: [btc({ maxQuoteNotional: '151' })] }, { instruments: [btc({ maxRestingPerSide: 3 })] }, { instruments: [btc({ maxRestingNotionalPerSide: '291' })] }, { instruments: [btc({ maxInventoryNotional: '401' })] }, { instruments: [btc({ maxLeverage: 4 })] }];
    for (const x of wider) expect(await code(w.signer.venueQuotingApprove({ ...m, ...x }, w.pk.assert(venueQuotingMandateHash(m)))), JSON.stringify(x)).toMatch(/^bad_approval/);
    // the passkey approved a DIRECTIONAL mandate hash: it does not approve a quoting mandate (separate domain tag)
    expect(await code(w.signer.venueQuotingApprove(m, w.pk.assert(venueMandateHash(directional(a, w.t.now)))))).toMatch(/^bad_approval/);
    expect(w.signer.status().venueQuotingMandates).toHaveLength(0);
  });

  it('compiled bounds: the owner cannot approve beyond them, whatever the authorization allows', async () => {
    const w = await setup(), a = await authorized(w, {}, { maxOrderNotional: '100000', maxPositionNotional: '100000', maxGrossExposure: '100000', maxPriceDeviationBps: 2000, maxLeverage: 10, allowedInstruments: ['hyperliquid:BTC', 'hyperliquid:ETH', 'hyperliquid:SOL'] });
    const hashOf = (m: VenueQuotingMandate) => { try { return venueQuotingMandateHash(m); } catch { return new Uint8Array(32); } };
    const tryIt = (o: Partial<VenueQuotingMandate>) => { const m = mandate(a, w.t.now, o); return code(() => w.signer.venueQuotingApprove(m, w.pk.assert(hashOf(m)))); };
    const B = QUOTING_MANDATE_BOUNDS, big = btc({ maxQuoteNotional: B.maxQuoteNotional, maxRestingPerSide: B.maxRestingPerSide, maxRestingNotionalPerSide: B.maxRestingNotionalPerSide, maxInventoryNotional: B.maxInventoryNotional, maxLeverage: B.maxLeverage });
    const max: Partial<VenueQuotingMandate> = { instruments: [big], maxRestingTotal: B.maxRestingTotal, maxGrossExposure: B.maxGrossExposure, minHalfSpreadBps: B.minHalfSpreadBpsFloor, maxDistanceBps: B.maxDistanceBpsCeiling, maxReduceDeviationBps: B.maxReduceDeviationBps,
      rate: { burstActions: B.maxBurstActions, actionsPerMinute: B.maxActionsPerMinute, ordersPerHour: B.maxOrdersPerHour, ordersPerDay: B.maxOrdersPerDay, dailyTurnover: B.maxDailyTurnover }, deadManSeconds: B.maxDeadManSeconds, expiresAt: w.t.now + B.maxDays * 86400 };
    expect(await tryIt(max)).toBe('ok');                                                             // exactly at every ceiling
    for (const x of w.signer.status().venueQuotingMandates) w.signer.venueQuotingRevoke(x.mandate.mandateId);
    const over: [string, Partial<VenueQuotingMandate>][] = [
      ['quote notional', { instruments: [{ ...big, maxQuoteNotional: '2000.01' }] }], ['resting per side', { instruments: [{ ...big, maxRestingPerSide: 6 }] }], ['resting notional', { instruments: [{ ...big, maxRestingNotionalPerSide: '10000.01' }] }],
      ['inventory', { instruments: [{ ...big, maxInventoryNotional: '20000.01' }] }], ['leverage', { instruments: [{ ...big, maxLeverage: 11 }] }], ['resting total', { maxRestingTotal: 21 }], ['gross', { maxGrossExposure: '50000.01' }],
      ['min half spread 0', { minHalfSpreadBps: 0 }], ['max distance', { maxDistanceBps: 501 }], ['reduce band low', { maxReduceDeviationBps: 9 }], ['reduce band high', { maxReduceDeviationBps: 301 }],
      ['burst', { rate: { ...RATE, burstActions: 21 } }], ['per minute', { rate: { ...RATE, actionsPerMinute: 61 } }], ['per hour', { rate: { ...RATE, ordersPerHour: 3601, ordersPerDay: 20000 } }], ['per day', { rate: { ...RATE, ordersPerDay: 20001 } }],
      ['turnover', { rate: { ...RATE, dailyTurnover: '2000000.01' } }], ['zero rate', { rate: { ...RATE, actionsPerMinute: 0 } }], ['dead man low', { deadManSeconds: 9 }], ['dead man high', { deadManSeconds: 121 }], ['floor', { floorEquity: '0' }],
      ['four instruments', { instruments: [btc(), btc({ instrument: 'hyperliquid:ETH' }), btc({ instrument: 'hyperliquid:SOL' }), btc({ instrument: 'hyperliquid:DOGE' })] }], ['no instrument', { instruments: [] }],
    ];
    for (const [what, x] of over) expect(await tryIt(x), what).toMatch(/^bad_request/);
    expect(await tryIt({ expiresAt: w.t.now + 7 * 86400 + 1 })).toMatch(/^unsupported: a quoting mandate lasts at most 7 days/);
    expect(await code(w.signer.venueQuotingApprove({ ...mandate(a, w.t.now), extra: 1 }, w.pk.assert(new Uint8Array(32))))).toMatch(/^bad_request/);
  });

  it('a quoting mandate can only be narrower than its authorization; pinned instruments only; a mandate for another account is refused', async () => {
    const w = await setup(), a = await authorized(w);
    const tryIt = (o: Partial<VenueQuotingMandate>) => { const m = mandate(a, w.t.now, o); return code(() => w.signer.venueQuotingApprove(m, w.pk.assert(venueQuotingMandateHash(m)))); };
    expect(await tryIt({ instruments: [btc({ instrument: 'hyperliquid:SOL' })] })).toMatch(/^unsupported: hyperliquid:SOL is not allowed by the authorization/);
    expect(await tryIt({ instruments: [btc({ instrument: 'hyperliquid:DOGE' })] })).toMatch(/^unsupported: hyperliquid:DOGE is not allowed/);
    expect(await tryIt({ instruments: [btc({ maxLeverage: 6 })] })).toMatch(/leverage 6 is above the authorization's 5/);
    expect(await tryIt({ instruments: [btc({ maxQuoteNotional: '300.01', maxRestingNotionalPerSide: '400' })] })).toMatch(/quote limit above the authorization's order limit 300/);
    expect(await tryIt({ instruments: [btc({ maxInventoryNotional: '500.01' })] })).toMatch(/inventory limit above the authorization's position limit 500/);
    expect(await tryIt({ instruments: [btc({ maxQuoteNotional: '291' })] })).toMatch(/quote limit above the resting notional limit/);
    expect(await tryIt({ instruments: [btc({ maxInventoryNotional: '140', maxQuoteNotional: '150' })] })).toMatch(/quote limit above the inventory limit/);
    expect(await tryIt({ maxGrossExposure: '399' })).toMatch(/inventory limit above the mandate's gross exposure limit/);
    expect(await tryIt({ maxGrossExposure: '800.01' })).toMatch(/gross exposure limit above the authorization's 800/);
    expect(await tryIt({ minHalfSpreadBps: 100 })).toMatch(/minimum distance from the mid must be below the maximum/);
    expect(await tryIt({ maxDistanceBps: 301 })).toMatch(/quote band wider than the authorization's 300/);
    expect(await tryIt({ maxReduceDeviationBps: 300, maxDistanceBps: 100 })).toBe('ok');
    for (const x of w.signer.status().venueQuotingMandates) w.signer.venueQuotingRevoke(x.mandate.mandateId);
    expect(await tryIt({ rate: { ...RATE, ordersPerHour: 501 } })).toMatch(/orders per hour above orders per day/);
    expect(await tryIt({ createdAt: w.t.now - 601 })).toMatch(/not current/);
    expect(await tryIt({ ackSha256: 'ab'.repeat(32) })).toMatch(/^acknowledgement/);
    expect(await tryIt({ keyId: 'spw-0000000000000000' })).toMatch(/^wrong_key/);
    expect(await tryIt({ account: `0x${'11'.repeat(20)}` })).toMatch(/does not name the venue, network, account and trading key/);   // a mandate for another account
    expect(await tryIt({ agentAddress: `0x${'22'.repeat(20)}` })).toMatch(/does not name/);
    expect(await tryIt({ network: 'mainnet' })).toMatch(/does not name/);
    expect(await tryIt({ authorizationId: uuid() })).toMatch(/^no_authorization/);
    expect(await tryIt({ expiresAt: a.expiresAt + 1, createdAt: a.expiresAt - 86400 })).toMatch(/not current|outlive/);
  });

  it('exclusive use of the venue account: one mandate per authorization, of either kind, both ways; never under the halt; an id is recorded once', async () => {
    const w = await setup(), a = await authorized(w);
    const q1 = mandate(a, w.t.now), d1 = directional(a, w.t.now);
    const approveQ = (m: VenueQuotingMandate) => code(() => w.signer.venueQuotingApprove(m, w.pk.assert(venueQuotingMandateHash(m))));
    const approveD = (m: VenueMandate) => code(() => w.signer.venueMandateApprove(m, w.pk.assert(venueMandateHash(m))));
    expect(await approveQ(q1)).toBe('ok');
    expect(await approveQ(q1)).toMatch(/^replay/);
    expect(await approveQ(mandate(a, w.t.now))).toMatch(/^conflict: another quoting mandate is active/);
    expect(await approveD(d1)).toMatch(/^conflict: a quoting mandate is active on this venue authorization/);
    w.signer.venueQuotingRevoke(q1.mandateId);
    expect(await approveD(d1)).toBe('ok');                                                           // once the quoting mandate is revoked
    expect(await approveQ(mandate(a, w.t.now))).toMatch(/^conflict: a directional mandate is active/);
    w.signer.venueMandateRevoke(d1.mandateId);
    const q2 = mandate(a, w.t.now);
    expect(await approveQ(q2)).toBe('ok');
    // the revoked quoting mandate is in its wind-down: it signs no quote, the new one does
    expect(await arm(w, q1)).toBe('ok'); expect(await quote(w, q1)).toMatch(/^wind_down/);
    expect(await arm(w, q2)).toBe('ok'); expect(await quote(w, q2)).toBe('ok');
    const w2 = await setup(), a2 = await authorized(w2);
    w2.signer.halt();
    const mh = mandate(a2, w2.t.now);
    expect(await code(() => w2.signer.venueQuotingApprove(mh, w2.pk.assert(venueQuotingMandateHash(mh))))).toMatch(/^halted/);
  });
});

describe('/venue/quoting/sign — a well-formed quote set', () => {
  it('signs a two-sided post-only batch with the trading key after reading the venue account itself; everything is counted before the signature leaves', async () => {
    const w = await setup(), { m } = await ready(w);
    const b = batch(w, [BID, ASK]);
    const r = await send(w, m, b);
    expect(r).toMatchObject({ kind: 'quotes', signer: AGENT, mandateId: m.mandateId, phase: 'active', orders: 2 });
    expect(await recoverTypedDataSigner((b.sign.payload as HlL1SignPayload).typedData, r.signature)).toBe(AGENT);
    expect(`0x${r.hash}`).toBe((b.sign.payload as HlL1SignPayload).typedData.message.connectionId);
    expect(st(w, m)).toMatchObject({ today: { quotes: 2, batches: 1, turnover: '280.2' }, quotesThisHour: 2, bucketActions: 4, pendingQuotes: 2, deadMan: { armed: true } });
    const ok = journal(w, 'venue.quoting.sign.ok').at(-1)!.data as any;
    expect(ok).toMatchObject({ kind: 'quotes', instrument: 'hyperliquid:BTC', mid: '70000', accountValue: '1000', leverageSetting: 3, restingBuy: 1, restingSell: 1, restingTotal: 2, restingNotionalBuy: '140', restingNotionalSell: '140.2', worstInventory: '140.2', worstGross: '140.2' });
    expect(ok.orders).toEqual([{ side: 'buy', size: '0.002', price: '69900', clientId: b.cloids[0] }, { side: 'sell', size: '0.002', price: '70100', clientId: b.cloids[1] }]);
    // the signer asked the venue's INFO endpoint only, on the pinned testnet host
    expect(new Set(w.venue.calls.map((c) => c.url))).toEqual(new Set([VENUE_INFO_URL.testnet]));
    expect(w.venue.calls.map((c) => c.type)).toEqual(['frontendOpenOrders', 'clearinghouseState', 'activeAssetData']);
    // the authorization's own daily order count (manual + directional, ≤ 500) is NOT consumed by quotes
    expect(w.signer.status().venues[0]).toMatchObject({ lastNonce: b.nonce, today: { orders: 0 } });
    expect(w.restart().status().venueQuotingMandates[0]).toMatchObject({ today: { quotes: 2, turnover: '280.2' }, pendingQuotes: 2, bucketActions: 4, deadMan: { armed: true } });
  });

  it('wrong instrument: outside the mandate (even when the authorization allows it), outside the pinned table, two instruments in one batch', async () => {
    const w = await setup(), { m } = await ready(w);
    expect(await quote(w, m, [{ size: '0.05', price: '1998' }], { instrument: ETH })).toMatch(/^instrument: hyperliquid:ETH is not allowed by the mandate/);
    expect(await quote(w, m, [reduce({ size: '0.05', price: '1998' })], { instrument: ETH })).toMatch(/^instrument/);
    expect(await quote(w, m, [{ size: '1', price: '99.9' }], { instrument: SOL })).toMatch(/^instrument/);
    const doge = createHlTrading({ network: 'testnet', assets: [...hlPinnedAssets('testnet'), { symbol: 'DOGE', asset: 173, szDecimals: 0, maxLeverage: 10, isolatedOnly: false, delisted: false }], expiresAfterMs: TTL });
    expect(await quote(w, m, [{ size: '100', price: '0.2' }], { instrument: { ...BTC, symbol: 'DOGE', id: 'hyperliquid:DOGE', lotSize: '1' }, t: doge })).toMatch(/^rejected: payload refused/);
    const mixed = trading.buildOrders([{ req: req(BID, 0), instrument: BTC }, { req: req({ size: '0.05', price: '1998' }, 1, ETH), instrument: ETH }], { nonce: nonceOf(w) });
    expect(await code(send(w, m, mixed))).toMatch(/^mixed_batch: a batch is for ONE instrument/);
    expect(w.venue.calls).toHaveLength(0);
  });

  it('non-Alo opening: a GTC or IOC order that can add exposure is never signed; nor a trigger order, even reduce-only', async () => {
    const w = await setup(), { m } = await ready(w);
    expect(await quote(w, m, [{ tif: 'gtc' }])).toMatch(/^not_post_only/);
    expect(await quote(w, m, [{ tif: 'ioc' }])).toMatch(/^not_post_only/);
    expect(await quote(w, m, [{ type: 'market', tif: 'ioc', price: '70300' }])).toMatch(/^not_post_only/);
    expect(await quote(w, m, [BID, { ...ASK, tif: 'gtc' }])).toMatch(/^not_post_only/);                          // one bad order refuses the batch
    expect(await quote(w, m, [{ type: 'stop_market', tif: 'gtc', side: 'sell', price: '69000', triggerPrice: '69500' }])).toMatch(/^order_type/);
    expect(await quote(w, m, [{ type: 'take_profit_limit', tif: 'gtc', side: 'sell', reduceOnly: true, price: '70500', triggerPrice: '70400' }])).toMatch(/^order_type/);
    expect(await quote(w, m, [BID, reduce()])).toMatch(/^mixed_batch: a batch is either all quotes or all reduce-only orders/);
    expect(st(w, m).today.quotes).toBe(0);
  });

  it('size over the cap: one quote above maxQuoteNotional (valued at the higher of its price and the mid)', async () => {
    const w = await setup(), { m } = await ready(w);                                                  // 150 per quote
    expect(await quote(w, m, [{ ...BID, size: '0.00214' }])).toBe('ok');                               // 0.00214 × 70000 = 149.8 (the bid is valued at the mid)
    expect(await quote(w, m, [{ ...BID, size: '0.00215' }])).toMatch(/^quote_notional: a quote of 150.5 is above the mandate's 150 per quote/);
    expect(await quote(w, m, [{ ...ASK, size: '0.00213' }])).toBe('ok');                               // 0.00213 × 70100 = 149.313
    expect(await quote(w, m, [{ ...ASK, size: '0.00214' }])).toMatch(/^quote_notional/);              // 150.014
    expect(await quote(w, m, [reduce({ size: '0.00215' })])).toMatch(/^order_notional/);             // reduce-only orders are sized too
  });

  it('too many resting orders: per side (venue list + ledger + batch) and in total', async () => {
    const w = await setup(), { m } = await ready(w, { instruments: [btc({ maxRestingNotionalPerSide: '1000', maxInventoryNotional: '500' })], maxRestingTotal: 3 });
    const small = { size: '0.0002' };
    expect(await quote(w, m, [{ ...BID, ...small }, { ...BID, ...small, price: '69800' }])).toBe('ok');   // 2 bids
    expect(await quote(w, m, [{ ...BID, ...small, price: '69700' }])).toMatch(/^resting_count: 3 buy orders would rest on hyperliquid:BTC, above the mandate's 2 per side/);
    expect(await quote(w, m, [{ ...ASK, ...small }])).toBe('ok');                                      // total 3
    expect(await quote(w, m, [{ ...ASK, ...small, price: '70200' }])).toMatch(/^resting_total: 4 orders would rest in total, above the mandate's 3/);
    // what rests on the venue counts whoever placed it; reduce-only resting orders do not
    const w2 = await setup(), { m: m2 } = await ready(w2);
    w2.venue.orders = [openOrder({ px: '69000', sz: '0.0002' }), openOrder({ px: '68900', sz: '0.0002' }), openOrder({ side: 'A', px: '71000', sz: '0.0002', reduceOnly: true })];
    expect(await quote(w2, m2, [{ ...BID, ...small }])).toMatch(/^resting_count: 3 buy orders/);
    expect(await quote(w2, m2, [{ ...ASK, ...small }, { ...ASK, ...small, price: '70200' }])).toBe('ok');
  });

  it('resting notional over the cap, per side', async () => {
    const w = await setup(), { m } = await ready(w, { instruments: [btc({ maxRestingNotionalPerSide: '280' })] });
    expect(await quote(w, m, [BID, { ...BID, price: '69800' }])).toBe('ok');                           // 140 + 140 = 280
    const w2 = await setup(), { m: m2 } = await ready(w2, { instruments: [btc({ maxRestingNotionalPerSide: '279.99' })] });
    expect(await quote(w2, m2, [BID, { ...BID, price: '69800' }])).toMatch(/^resting_notional: 280 would rest on the buy side of hyperliquid:BTC, above the mandate's 279.99/);
    expect(await quote(w2, m2, [BID])).toBe('ok');
    expect(await quote(w2, m2, [{ ...BID, price: '69800' }])).toMatch(/^resting_notional/);          // it only breaches summed with the one just signed
    expect(await quote(w2, m2, [ASK])).toBe('ok');                                                     // the other side has its own allowance
  });

  it('worst-case inventory: position + every same-side order + the batch — including when it only breaches summed with what already rests', async () => {
    const w = await setup(), { m } = await ready(w, { instruments: [btc({ maxInventoryNotional: '300', maxRestingNotionalPerSide: '290' })] });
    w.venue.positions = [{ coin: 'BTC', szi: '0.002', mark: '70000' }];                                // long 140
    expect(await quote(w, m, [BID])).toBe('ok');                                                       // 140 + 140 = 280 ≤ 300
    expect(await quote(w, m, [{ ...BID, price: '69800', size: '0.0003' }])).toMatch(/^inventory_exceeded: worst-case hyperliquid:BTC inventory 301 /);   // 280 + 21: only with the pending bid
    expect(await quote(w, m, [{ ...BID, price: '69800', size: '0.00028' }])).toBe('ok');              // 280 + 19.6 = 299.6
    // the short side is its own worst case: the long position gives it no credit, and does not burden it
    expect(await quote(w, m, [ASK, { ...ASK, price: '70200' }])).toBe('ok');                           // 140.2 + 140.4
    // the same with the first bid RESTING on the venue instead of pending
    const w2 = await setup(), { m: m2 } = await ready(w2, { instruments: [btc({ maxInventoryNotional: '300' })] });
    w2.venue.positions = [{ coin: 'BTC', szi: '0.002', mark: '70000' }];
    w2.venue.orders = [openOrder({ px: '69900', sz: '0.002' })];
    expect(await quote(w2, m2, [{ ...BID, price: '69800', size: '0.0003' }])).toMatch(/^inventory_exceeded/);
    // a short position: bids are free of it, asks are bounded
    const w3 = await setup(), { m: m3 } = await ready(w3, { instruments: [btc({ maxInventoryNotional: '300' })] });
    w3.venue.positions = [{ coin: 'BTC', szi: '-0.003', mark: '70000' }];                              // short 210
    expect(await quote(w3, m3, [ASK])).toMatch(/^inventory_exceeded: worst-case hyperliquid:BTC inventory 350.2/);
    expect(await quote(w3, m3, [BID, { ...BID, price: '69800' }])).toBe('ok');
  });

  it('worst-case gross over every instrument, positions outside the mandate included; a position the signer cannot price stops every quote', async () => {
    const w = await setup(), { m } = await ready(w);                                                   // gross 600
    w.venue.positions = [{ coin: 'ETH', szi: '0.24', mark: '2000' }];                                  // 480, the owner's own
    expect(await quote(w, m, [BID])).toMatch(/^gross_exceeded: worst-case gross exposure 620 is above 600/);
    expect(await quote(w, m, [{ ...BID, size: '0.0017' }])).toBe('ok');                                // 480 + 119
    w.venue.positions = [{ coin: 'DOGE', szi: '100', mark: '0.2' }];
    expect(await quote(w, m, [ASK])).toMatch(/^unpriced_position/);
    expect(await quote(w, m, [reduce()])).toBe('ok');
  });

  it('quote sanity band against the signer\'s own mid: bid ≥ mid, ask ≤ mid, too tight, too far — each just inside and just outside', async () => {
    const w = await setup(), { m } = await ready(w, { rate: { ...RATE, burstActions: 20, actionsPerMinute: 60 }, instruments: [btc({ maxRestingPerSide: 5, maxRestingNotionalPerSide: '2000', maxInventoryNotional: '400' })], maxRestingTotal: 20 });
    const s = { size: '0.0002' };                                                                      // mid 70000; 2 bps = 14; 100 bps = 700
    expect(await quote(w, m, [{ ...s, side: 'buy', price: '70000' }])).toMatch(/^quote_crosses_mid: bid 70000 is at or above the signer's own BTC price 70000/);
    expect(await quote(w, m, [{ ...s, side: 'buy', price: '70050' }])).toMatch(/^quote_crosses_mid/);
    expect(await quote(w, m, [{ ...s, side: 'sell', price: '70000' }])).toMatch(/^quote_crosses_mid: ask 70000 is at or below/);
    expect(await quote(w, m, [{ ...s, side: 'sell', price: '69950' }])).toMatch(/^quote_crosses_mid/);
    expect(await quote(w, m, [{ ...s, side: 'buy', price: '69987' }])).toMatch(/^quote_too_tight: bid 69987 is closer than 2 bps to the signer's own BTC price 70000/);
    expect(await quote(w, m, [{ ...s, side: 'buy', price: '69986' }])).toBe('ok');                     // exactly 2 bps
    expect(await quote(w, m, [{ ...s, side: 'sell', price: '70013' }])).toMatch(/^quote_too_tight: ask 70013/);
    expect(await quote(w, m, [{ ...s, side: 'sell', price: '70014' }])).toBe('ok');
    expect(await quote(w, m, [{ ...s, side: 'buy', price: '69299' }])).toMatch(/^quote_too_far: bid 69299 is more than 100 bps below/);
    expect(await quote(w, m, [{ ...s, side: 'buy', price: '69300' }])).toBe('ok');
    expect(await quote(w, m, [{ ...s, side: 'sell', price: '70701' }])).toMatch(/^quote_too_far: ask 70701 is more than 100 bps above/);
    expect(await quote(w, m, [{ ...s, side: 'sell', price: '70700' }])).toBe('ok');
    // a batch with ONE bad order is refused whole, and nothing of it is counted
    const before = st(w, m).today;
    expect(await quote(w, m, [{ ...s, ...BID }, { ...s, ...ASK }, { ...s, side: 'sell', price: '69990' }])).toMatch(/^quote_crosses_mid/);
    expect(st(w, m).today).toEqual(before);
    // the market moved: yesterday's good bid is now through the signer's mid
    w.px.BTC = 69_800;
    expect(await quote(w, m, [{ ...s, ...BID }])).toMatch(/^quote_crosses_mid/);
    // reduce-only orders have their own band (50 bps), on both sides of the mid: they may cross
    w.px.BTC = 70_000;
    expect(await quote(w, m, [reduce({ price: '69650' })])).toBe('ok');
    expect(await quote(w, m, [reduce({ price: '69649' })])).toMatch(/^price: price 69649 is more than 50 bps away/);
    expect(await quote(w, m, [reduce({ side: 'buy', price: '70350' })])).toBe('ok');
    expect(await quote(w, m, [reduce({ side: 'buy', price: '70351' })])).toMatch(/^price/);
  });

  it('no price, no priced signature (injected failure) — cancels and the switch do not need a price', async () => {
    const w = await setup(), { m } = await ready(w);
    w.pxFail.why = 'price sources disagree on BTC';
    expect(await quote(w, m, [BID])).toMatch(/^no_price: .*price sources disagree/);
    expect(await quote(w, m, [reduce()])).toMatch(/^no_price/);
    expect(await cancel(w, m)).toBe('ok');
    expect(await arm(w, m)).toBe('ok');
  });
});

describe('the signer\'s own prices, real price view on scripted exchange answers: stale, single source, disagreeing — all fail closed', () => {
  const CB = 'https://api.exchange.coinbase.com/products/BTC-USD/ticker', KR = 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD';
  const world = async () => {
    const src = { coinbase: { bid: '69990', ask: '70010', ageMs: 1000 } as { bid: string; ask: string; ageMs: number } | null, kraken: { bid: '69990', ask: '70010' } as { bid: string; ask: string } | null, krakenStatus: 'online', statusAgeMs: 0 };
    const w = await setup({ prices: (now) => exchangePrices(now, (async (url: string) => {
      if (url === CB) { if (!src.coinbase) throw new Error('HTTP 503'); return { bid: src.coinbase.bid, ask: src.coinbase.ask, time: new Date(now() - src.coinbase.ageMs).toISOString() }; }
      if (url === KR) { if (!src.kraken) throw new Error('HTTP 503'); return { error: [], result: { XXBTZUSD: { a: [src.kraken.ask], b: [src.kraken.bid] } } }; }
      if (url === KRAKEN_STATUS_URL) return { error: [], result: { status: src.krakenStatus, timestamp: new Date(now() - src.statusAgeMs).toISOString() } };
      throw new Error(`unexpected ${url}`);
    }) as JsonGet) });
    const { m } = await ready(w);
    return { w, m, src, next: () => { w.t.now += 16; } };                                            // past the 15 s cache of the price view
  };
  it('two fresh agreeing sources: signed at the mean of the two mids', async () => {
    const { w, m } = await world();
    expect(await quote(w, m, [BID])).toBe('ok');
    expect((journal(w, 'venue.quoting.sign.ok').at(-1)!.data as any).mid).toBe('70000');
  });
  it('stale price: Coinbase\'s own timestamp is more than 3 minutes old', async () => {
    const { w, m, src } = await world();
    src.coinbase!.ageMs = 181_000;
    expect(await quote(w, m, [BID])).toMatch(/^no_price: .*stale quote/);
    expect(await quote(w, m, [reduce()])).toMatch(/^no_price/);
  });
  it('stale price: Kraken does not say it is online, or says so with an old timestamp', async () => {
    const a = await world(); a.src.krakenStatus = 'cancel_only';
    expect(await quote(a.w, a.m, [BID])).toMatch(/^no_price: .*Kraken is not trading normally/);
    const b = await world(); b.src.statusAgeMs = 181_000;
    expect(await quote(b.w, b.m, [BID])).toMatch(/^no_price: .*stale quote/);
  });
  it('single source: one exchange down → no price (never the other one alone)', async () => {
    const a = await world(); a.src.kraken = null;
    expect(await quote(a.w, a.m, [BID])).toMatch(/^no_price/);
    const b = await world(); b.src.coinbase = null;
    expect(await quote(b.w, b.m, [BID])).toMatch(/^no_price/);
  });
  it('disagreeing sources: more than 1 % apart', async () => {
    const { w, m, src } = await world();
    src.kraken = { bid: '70800', ask: '70820' };
    expect(await quote(w, m, [BID])).toMatch(/^no_price: .*price sources disagree on BTC/);
    src.kraken = { bid: '70600', ask: '70620' };                                                       // 0.87 %: accepted, mid 70305 — the old bid is still below it
    expect(await quote(w, m, [BID])).toBe('ok');
  });
  it('a price that was good becomes unavailable: the next quote is refused once the short cache has passed', async () => {
    const { w, m, src, next } = await world();
    expect(await quote(w, m, [BID])).toBe('ok');
    src.coinbase = null; next();
    expect(await arm(w, m)).toBe('ok');
    expect(await quote(w, m, [ASK])).toMatch(/^no_price/);
  });
});

describe('the signer\'s own read of the venue: fail closed; floor; leverage', () => {
  it('venue read failed or stale → no quote; cancels, reduce-only orders and the switch still pass', async () => {
    const w = await setup(), { m } = await ready(w);
    for (const why of ['fetch failed', 'HTTP 502', 'The operation was aborted due to timeout']) { w.venue.fail = why; expect(await quote(w, m, [BID])).toMatch(/^venue_unreachable: the signer could not read the venue account itself/); }
    expect(await quote(w, m, [reduce()])).toBe('ok');
    expect(await cancel(w, m)).toBe('ok');
    expect(await arm(w, m)).toBe('ok');
    w.venue.fail = ''; w.venue.ageMs = 31_000;
    expect(await quote(w, m, [BID])).toMatch(/^venue_stale: the venue's account state is dated 31 s/);
    w.venue.ageMs = 30_000;
    expect(await quote(w, m, [BID])).toBe('ok');
    // an answer that does not have exactly the expected shape is a failed read
    w.venue.ageMs = 0; w.venue.orders = [{ coin: 'BTC', side: 'X' }];
    expect(await quote(w, m, [ASK])).toMatch(/^venue_unreachable: .*unexpected venue answer/);
    // a position the venue values far from the signer's own price is not believed
    w.venue.orders = []; w.venue.positions = [{ coin: 'BTC', szi: '0.001', mark: '73000' }];
    expect(await quote(w, m, [ASK])).toMatch(/^venue_inconsistent/);
    expect(st(w, m).today).toMatchObject({ quotes: 1, reduceOnly: 1, cancels: 2 });                  // refusals count nothing
  });

  it('below the floor equity: no quote; reductions and cancels pass', async () => {
    const w = await setup(), { m } = await ready(w);
    w.venue.accountValue = '100';
    expect(await quote(w, m, [BID])).toBe('ok');
    w.venue.accountValue = '99.99';
    expect(await quote(w, m, [ASK])).toMatch(/^floor_equity: the venue reports an account value of 99.99, below the mandate's floor of 100/);
    expect(await quote(w, m, [reduce()])).toBe('ok');
    expect(await cancel(w, m)).toBe('ok');
  });

  it('leverage setting above the mandate: no quote — and the quoting mandate never signs a leverage change', async () => {
    const w = await setup(), { m } = await ready(w);
    w.venue.lev.BTC = { type: 'cross', value: 20 };
    expect(await quote(w, m, [BID])).toMatch(/^leverage_setting: BTC is set to 20× on the venue, above the mandate's 3×/);
    expect(await code(send(w, m, trading.buildUpdateLeverage({ instrument: BTC, leverage: 3, marginMode: 'cross', nonce: nonceOf(w) })))).toMatch(/^unsupported: this payload is not a batch of orders, a cancel or a scheduleCancel/);
    w.venue.lev.BTC = { type: 'cross', value: 3 };
    w.venue.positions = [{ coin: 'BTC', szi: '0.001', mark: '70000', lev: { type: 'cross', value: 5 } }];   // with a position, the position's own setting
    expect(await quote(w, m, [BID])).toMatch(/^leverage_setting: BTC is set to 5×/);
  });
});

describe('rates: a persisted token bucket, quotes per hour and per day, daily turnover', () => {
  it('rate bucket empty: refused; refilled by time only — NOT by a restart of the signer', async () => {
    const w = await setup(), { m } = await ready(w, { rate: { ...RATE, burstActions: 3, actionsPerMinute: 6 }, instruments: [btc({ maxRestingPerSide: 5, maxRestingNotionalPerSide: '2000' })], maxRestingTotal: 20 });
    const s = { ...BID, size: '0.0002' };
    for (let k = 0; k < 3; k++) expect(await quote(w, m, [{ ...s, price: String(69900 - k) }])).toBe('ok');
    expect(await quote(w, m, [{ ...s, price: '69800' }])).toMatch(/^rate: the mandate's rate of 6 quote batches per minute \(burst 3\) is used/);
    // a restart: the bucket is in the state file
    const again = w.restart();
    expect(again.status().venueQuotingMandates[0]!.bucketActions).toBe(0);
    expect(await code(again.venueQuotingSign({ mandateId: m.mandateId, sign: batch(w, [{ ...s, price: '69800' }]).sign }))).toMatch(/^rate/);
    w.t.now += 9;                                                                                      // 6 a minute = one every 10 s
    expect(await code(again.venueQuotingSign({ mandateId: m.mandateId, sign: batch(w, [{ ...s, price: '69800' }]).sign }))).toMatch(/^rate/);
    w.t.now += 1;
    expect(await code(again.venueQuotingSign({ mandateId: m.mandateId, sign: batch(w, [{ ...s, price: '69800' }]).sign }))).toBe('ok');
    expect(await code(again.venueQuotingSign({ mandateId: m.mandateId, sign: batch(w, [{ ...s, price: '69799' }]).sign }))).toMatch(/^rate/);
    // cancels, reductions and heartbeats are never metered
    for (let k = 0; k < 8; k++) expect(await code(again.venueQuotingSign({ mandateId: m.mandateId, sign: trading.buildCancels([{ instrument: BTC, clientId: `c${k}` }], { nonce: nonceOf(w) }).sign }))).toBe('ok');
    expect(await code(again.venueQuotingSign({ mandateId: m.mandateId, sign: batch(w, [reduce()]).sign }))).toBe('ok');
  });
  it('the bucket (pure): exact refill, capped at the burst, a clock going backwards refills nothing', () => {
    let b = bucketFull(2, 1000);
    b = bucketTake(b, 1000, 2, 6)!; b = bucketTake(b, 1000, 2, 6)!;
    expect(bucketTake(b, 1000, 2, 6)).toBeNull();
    expect(bucketTake(b, 10_999, 2, 6)).toBeNull();
    expect(bucketTake(b, 500, 2, 6)).toBeNull();                                                      // the clock went back
    b = bucketTake(b, 11_000, 2, 6)!;
    expect(bucketAt(b, 11_000 + 3_600_000, 2, 6).units).toBe(2 * 60_000);                             // never above the burst
  });
  it('quotes per hour and per day (orders, not batches); daily turnover', async () => {
    const big = { instruments: [btc({ maxRestingPerSide: 5, maxRestingNotionalPerSide: '2000' })], maxRestingTotal: 20 };
    const w = await setup(), { m } = await ready(w, { ...big, rate: { ...RATE, burstActions: 20, actionsPerMinute: 60, ordersPerHour: 3, ordersPerDay: 5 } });
    const s = (k: number): Q => ({ side: 'buy', size: '0.0002', price: String(69900 - k) });
    expect(await quote(w, m, [s(0), s(1)])).toBe('ok');
    expect(await quote(w, m, [s(2), s(3)])).toMatch(/^orders_hour: the mandate's 3 quotes per hour are used/);
    expect(await quote(w, m, [s(2)])).toBe('ok');
    w.t.now += 3600; expect(await arm(w, m)).toBe('ok');                                               // the next UTC hour (the switch lapsed meanwhile and is re-armed)
    expect(await quote(w, m, [s(4), s(5)])).toBe('ok');                                                // 5 today
    w.t.now += 3600; expect(await arm(w, m)).toBe('ok');
    expect(await quote(w, m, [s(6)])).toMatch(/^orders_day: the mandate's 5 quotes per day are used/);
    const w2 = await setup(), { m: m2 } = await ready(w2, { ...big, rate: { ...RATE, dailyTurnover: '280' } });
    expect(await quote(w2, m2, [BID])).toBe('ok'); await expirePending(w2, m2);
    expect(await quote(w2, m2, [reduce()])).toBe('ok');                                                // reducing costs no turnover allowance
    expect(await quote(w2, m2, [BID])).toBe('ok'); await expirePending(w2, m2);                        // 280
    expect(await quote(w2, m2, [{ ...BID, size: '0.0002' }])).toMatch(/^turnover: daily turnover would reach 294, above the mandate's 280/);
  });
});

describe('the dead man\'s switch', () => {
  it('no switch in force → no quote; armed too close to the batch\'s own expiry → no quote; renewed → signed', async () => {
    const w = await setup(), { m } = await mandated(w);
    expect(await quote(w, m, [BID])).toMatch(/^no_switch: no dead man's switch is in force/);
    expect(await quote(w, m, [reduce()])).toBe('ok');                                                  // reductions and cancels do not need it
    expect(await cancel(w, m)).toBe('ok');
    expect(await arm(w, m, 11)).toBe('ok');                                                            // fires 11 s from now; a batch lives 10 s (+ 2 s margin)
    expect(await quote(w, m, [BID])).toMatch(/^no_switch: the dead man's switch fires at \d+, before this batch could no longer be accepted/);
    expect(await arm(w, m, 13)).toBe('ok');
    expect(await quote(w, m, [BID])).toBe('ok');
    expect(st(w, m).deadMan).toEqual({ armed: true, deadline: (w.t.now + 13) * 1000 });
    w.t.now += 2;                                                                                      // the same deadline is now too close for a new batch
    expect(await quote(w, m, [ASK])).toMatch(/^no_switch/);
  });
  it('bounds of a scheduleCancel: at least 6 s ahead, at most deadManSeconds, short-lived signature; it is stored before the signature leaves', async () => {
    const w = await setup(), { m } = await mandated(w);                                                // deadManSeconds 60
    expect(await arm(w, m, 5)).toMatch(/^switch_too_soon/);
    expect(await arm(w, m, 6)).toBe('ok');
    expect(await arm(w, m, 61)).toMatch(/^switch_too_far: the scheduled cancel is more than the mandate's 60 s ahead/);
    expect(await arm(w, m, 60)).toBe('ok');
    expect(await arm(w, m, 30, tradingOf(30_001))).toMatch(/^policy: validity window longer than 30 s/);
    expect(await arm(w, m, 30, tradingOf(null))).toMatch(/^policy: the action carries no venue expiry/);
    expect(st(w, m)).toMatchObject({ deadMan: { armed: true, deadline: (w.t.now + 60) * 1000 }, today: { heartbeats: 2 } });
    expect(w.restart().status().venueQuotingMandates[0]!.deadMan).toEqual({ armed: true, deadline: (w.t.now + 60) * 1000 });
    expect(journal(w, 'venue.quoting.sign.ok').at(-1)!.data).toMatchObject({ kind: 'schedule_cancel', time: (w.t.now + 60) * 1000, armed: true });
  });
  it('removing the switch: only when the signer itself reads no open order and nothing it signed can still land', async () => {
    const w = await setup(), { m } = await ready(w);
    expect(await quote(w, m, [BID])).toBe('ok');
    expect(await disarm(w, m)).toMatch(/^switch_needed: an order signed a moment ago can still reach the venue/);
    w.t.now += 21;
    w.venue.orders = [openOrder({ px: '69900', sz: '0.002' })];
    expect(await disarm(w, m)).toMatch(/^switch_needed: the account has 1 open order/);
    w.venue.orders = [openOrder({ side: 'A', px: '71000', sz: '0.002', reduceOnly: true })];          // even a reduce-only one: the switch covers every order
    expect(await disarm(w, m)).toMatch(/^switch_needed/);
    w.venue.orders = []; w.venue.fail = 'HTTP 502';
    expect(await disarm(w, m)).toMatch(/^venue_unreachable/);
    w.venue.fail = '';
    expect(await arm(w, m)).toBe('ok');
    expect(await disarm(w, m)).toBe('ok');
    expect(st(w, m).deadMan).toEqual({ armed: false, deadline: null });
    expect(await quote(w, m, [BID])).toMatch(/^no_switch/);
    expect(st(w, m).today.lapses).toBe(0);                                                             // a clean disarm costs no trigger of the venue's ten a day
  });
  it('trigger budget: a deadline that passes is a presumed trigger; after 8 in a UTC day no quote until midnight; reductions still pass', async () => {
    const w = await setup(), { m } = await mandated(w);
    for (let k = 0; k < DMS_MAX_LAPSES_PER_DAY; k++) {
      expect(await arm(w, m, 20)).toBe('ok');
      expect(await quote(w, m, [{ ...BID, size: '0.0002' }]), `session ${k}`).toBe('ok');
      w.t.now += 31;                                                                                   // the engine died: the venue fired the switch
    }
    expect(await arm(w, m, 20)).toBe('ok');
    expect(st(w, m).today.lapses).toBe(8);
    expect(await quote(w, m, [BID])).toMatch(/^switch_exhausted: the dead man's switch is presumed to have fired 8 times today/);
    expect(await quote(w, m, [reduce()])).toBe('ok');
    expect(journal(w, 'venue.quoting.switch_lapsed')).toHaveLength(8);
    w.t.now = Math.floor(Date.parse('2026-11-17T00:00:05Z') / 1000);
    expect(await arm(w, m, 20)).toBe('ok');
    expect(await quote(w, m, [BID])).toBe('ok');                                                       // a new UTC day
  });
});

describe('halt, revocation, expiry: no quote; cancels, reduce-only orders and the switch pass during the wind-down', () => {
  const exits = async (w: World, m: VenueQuotingMandate) => {
    expect(await quote(w, m, [reduce()])).toBe('ok');
    expect(await quote(w, m, [reduce({ tif: 'gtc', price: '70100' }), reduce({ tif: 'alo', price: '70200' })])).toBe('ok');
    expect(await cancel(w, m)).toBe('ok');
    expect(await arm(w, m)).toBe('ok');
  };
  it('emergency halt of the signer (the kill switch at the signer)', async () => {
    const w = await setup(), { m } = await ready(w);
    w.signer.halt();
    expect(await quote(w, m, [BID, ASK])).toMatch(/^halted: emergency halt is active: only cancels, reduce-only orders and the dead man's switch are signed/);
    await exits(w, m);
    w.venue.fail = 'HTTP 502'; w.pxFail.why = '';
    expect(await cancel(w, m)).toBe('ok');                                                             // and with the venue unreadable
  });
  it('revoked mandate: no quote for ever; exits for 24 h; then nothing', async () => {
    const w = await setup(), { m } = await ready(w);
    const r = w.signer.venueQuotingRevoke(m.mandateId);
    expect(r.windDownUntil).toBe(w.t.now + VENUE_MANDATE_WIND_DOWN_S);
    expect(st(w, m)).toMatchObject({ phase: 'wind_down', revoked: true });
    expect(await quote(w, m, [BID])).toMatch(/^wind_down: the mandate was revoked/);
    await exits(w, m);
    w.t.now += VENUE_MANDATE_WIND_DOWN_S - 1; await exits(w, m);
    w.t.now += 1;
    expect(await quote(w, m, [reduce()])).toMatch(/^revoked: the mandate was revoked and its wind-down period is over/);
    expect(await cancel(w, m)).toMatch(/^revoked/);
    expect(await code(() => w.signer.venueQuotingRevoke(uuid()))).toMatch(/^not_found/);
  });
  it('expired mandate (mid-session): the same wind-down', async () => {
    const w2 = await setup(), a = await authorized(w2), m2 = mandate(a, w2.t.now, { expiresAt: w2.t.now + 3600 });
    await w2.signer.venueQuotingApprove(m2, w2.pk.assert(venueQuotingMandateHash(m2)));
    w2.t.now += 3590; expect(await arm(w2, m2)).toBe('ok');
    expect(await quote(w2, m2, [BID])).toBe('ok');
    w2.t.now += 10;
    expect(await arm(w2, m2)).toBe('ok');
    expect(await quote(w2, m2, [ASK])).toMatch(/^wind_down: the mandate has expired/);
    expect(st(w2, m2)).toMatchObject({ phase: 'wind_down', expired: true });
    await exits(w2, m2);
    w2.t.now += VENUE_MANDATE_WIND_DOWN_S;
    expect(await cancel(w2, m2)).toMatch(/^expired/);
  }, 20_000);
  it('the authorization is the root: revoked or expired, nothing at all is signed', async () => {
    const w = await setup(), { a, m } = await ready(w);
    w.signer.venueRevoke(a.authorizationId);
    expect(await quote(w, m, [reduce()])).toMatch(/^revoked: the venue authorization of this mandate was revoked/);
    expect(await cancel(w, m)).toMatch(/^revoked/);
    expect(await arm(w, m)).toMatch(/^revoked/);
    expect(st(w, m).phase).toBe('ended');
  });
});

describe('what a quoting mandate never signs', () => {
  it('unknown action types, user-signed actions, vaults, other networks, other mandates', async () => {
    const w = await setup(), { m } = await ready(w);
    for (const action of [{ type: 'modify', oid: 1, order: { a: 3, b: true, p: '69900', s: '0.002', r: false, t: { limit: { tif: 'Alo' } } } }, { type: 'batchModify', modifies: [] }, { type: 'twapOrder', twap: { a: 3, b: true, s: '1', r: false, m: 5, t: false } },
      { type: 'updateIsolatedMargin', asset: 3, isBuy: true, ntli: 1 }, { type: 'vaultTransfer', vaultAddress: `0x${'44'.repeat(20)}`, isDeposit: true, usd: 1 }, { type: 'reserveRequestWeight', weight: 100 }, { type: 'noop' },
      { type: 'agentSendAsset', destination: ACCOUNT, sourceDex: '', destinationDex: 'spot', token: 'USDC', amount: '1' }, { type: 'usdClassTransfer', amount: '1', toPerp: false }])
      expect(await code(send(w, m, l1(w, action))), action.type).toMatch(/^unsupported: this payload is not a batch of orders, a cancel or a scheduleCancel \(/);
    expect(await code(send(w, m, trading.buildApproveAgent({ agentAddress: `0x${'66'.repeat(20)}`, agentName: 'evil', nonce: nonceOf(w) })))).toMatch(/^unsupported/);
    const xfer = buildUsdClassTransferTypedDataOnly({ network: 'testnet', amount: '10', toPerp: false, nonce: nonceOf(w) });
    expect(await code(send(w, m, { sign: { venue: 'hyperliquid', network: 'testnet', kind: 'hl_user', payload: { scheme: 'user', action: xfer.action, typedData: xfer.typedData } } }))).toMatch(/^unsupported/);
    const good = batch(w, [BID]);
    expect(await code(send(w, m, l1(w, good.action, { vault: `0x${'33'.repeat(20)}` })))).toMatch(/^unsupported: sub-accounts and vaults/);
    expect(await code(send(w, m, { sign: { ...good.sign, network: 'mainnet' } }))).toMatch(/^wrong_venue/);
    expect(await code(w.signer.venueQuotingSign({ mandateId: uuid(), sign: good.sign }))).toMatch(/^not_found/);
    expect(await code(w.signer.venueQuotingSign({ mandateId: m.mandateId } as never))).toMatch(/^bad_request/);
    expect(st(w, m).today.quotes).toBe(0);
    for (const j of journal(w, 'venue.quoting.sign.denied')) expect(['unsupported', 'wrong_venue', 'bad_request']).toContain((j.data as { code: string }).code);   // every refusal is journaled with its code
  });
  it('an action smuggling extra fields: builder fee, priority fee, fast flag, extra order field, wrong key order, typed data of another action', async () => {
    const w = await setup(), { m } = await ready(w);
    const good = batch(w, [BID, ASK]), a = good.action as any;
    expect(await code(send(w, m, l1(w, { ...a, builder: { b: `0x${'11'.repeat(20)}`, f: 10 } })))).toMatch(/^rejected: payload refused/);
    expect(await code(send(w, m, l1(w, { ...a, grouping: { p: 12345 } })))).toMatch(/^rejected/);
    expect(await code(send(w, m, l1(w, { ...a, grouping: 'normalTpsl' })))).toMatch(/^rejected/);
    expect(await code(send(w, m, l1(w, { ...a, orders: [{ ...a.orders[0], x: 1 }] })))).toMatch(/^rejected/);
    expect(await code(send(w, m, l1(w, { type: 'order', grouping: 'na', orders: a.orders })))).toMatch(/^rejected: .*canonical order/);
    expect(await code(send(w, m, l1(w, { ...a, orders: [{ ...a.orders[0], p: '69900.0' }] })))).toMatch(/^rejected/);                     // not the wire form that is hashed
    expect(await code(send(w, m, l1(w, { type: 'cancel', cancels: [{ a: 3, o: 1 }], f: true })))).toMatch(/^rejected/);
    expect(await code(send(w, m, l1(w, { type: 'scheduleCancel', time: (w.t.now + 30) * 1000, also: 'x' })))).toMatch(/^rejected/);
    const { c: _c, ...noCloid } = a.orders[0];
    expect(await code(send(w, m, l1(w, { ...a, orders: [noCloid] })))).toMatch(/^client_id: every order carries a client order id/);
    // the typed data of a harmless cancel under an order action: the hash is what is signed, so it must be the action's own
    const other = trading.buildCancels([{ instrument: BTC, clientId: 'x' }], { nonce: good.nonce });
    expect(await code(send(w, m, { sign: { ...good.sign, payload: { ...(good.sign.payload as object), typedData: (other.sign.payload as HlL1SignPayload).typedData } } }))).toMatch(/^rejected: .*typed data does not match/);
    expect(await code(send(w, m, good))).toBe('ok');                                                   // the untouched batch is fine
    expect(st(w, m).today).toMatchObject({ quotes: 2, batches: 1 });
  });
  it('batch size: 1 to 20 orders', async () => {
    const w = await setup(), { m } = await ready(w);
    const many = (k: number) => Array.from({ length: k }, (_, i): Q => ({ side: 'buy', size: '0.00015', price: String(69900 - i) }));
    expect(await quote(w, m, many(21))).toMatch(/^batch: a batch holds 1 to 20 orders/);
    expect(await quote(w, m, many(20))).toMatch(/^resting_count/);                                    // it is read, and then bounded like any other
  });
});

describe('replay: nonces, expiries and client ids', () => {
  it('a replayed nonce, a stale or future nonce, a long or missing expiry', async () => {
    const w = await setup(), { m } = await ready(w);
    const b = batch(w, [BID]);
    expect(await code(send(w, m, b))).toBe('ok');
    expect(await code(send(w, m, b))).toMatch(/^stale_nonce: nonce already used/);
    expect(await quote(w, m, [ASK], { nonce: b.nonce })).toMatch(/^stale_nonce/);                     // another action on the same nonce
    expect(await quote(w, m, [ASK], { nonce: (w.t.now - 121) * 1000 })).toMatch(/^(stale_nonce|expired_action)/);
    expect(await quote(w, m, [ASK], { nonce: (w.t.now + 61) * 1000 })).toMatch(/^policy: nonce is dated in the future/);
    expect(await quote(w, m, [ASK], { t: tradingOf(30_001) })).toMatch(/^policy: validity window longer than 30 s/);
    expect(await quote(w, m, [ASK], { t: tradingOf(null) })).toMatch(/^policy: the action carries no venue expiry/);
    expect(await arm(w, m, 45)).toBe('ok');
    expect(await quote(w, m, [ASK], { t: tradingOf(30_000) })).toBe('ok');                             // 30 s is the ceiling for a quote batch
    expect(await quote(w, m, [reduce()], { t: tradingOf(120_000) })).toBe('ok');                       // exits keep the general 120 s
  });
  it('a client id is not signed twice while its order can still land or rests — so no second order can pass for a pending quote', async () => {
    const w = await setup(), { m } = await ready(w);
    const b = batch(w, [BID]), id = b.cloids[0]!;
    expect(await code(send(w, m, b))).toBe('ok');
    expect(await quote(w, m, [{ ...ASK, clientId: id }])).toMatch(/^replay: an order with this client id was signed and can still reach the venue/);
    expect(await quote(w, m, [reduce({ clientId: id })])).toMatch(/^replay/);                         // not even a reduce-only order (it would be mistaken for the quote)
    const two = batch(w, [BID, ASK]).action as any;
    expect(await code(send(w, m, l1(w, { ...two, orders: [two.orders[0], { ...two.orders[1], c: two.orders[0].c }] })))).toMatch(/^replay: two orders of the batch carry the same client id/);
    await expirePending(w, m);
    w.venue.orders = [openOrder({ px: '69900', sz: '0.002', cloid: id, timestamp: w.t.now * 1000 })];
    expect(await quote(w, m, [{ ...ASK, clientId: id }])).toMatch(/^replay: an open order on the venue already carries one of these client ids/);
    w.venue.orders = [];
    expect(await quote(w, m, [{ ...ASK, clientId: id }])).toBe('ok');                                  // gone from the venue and past its expiry: harmless
  });
  it('the ledger: a signed quote counts until the venue lists it (then once, through the venue) or its expiry + grace; only an exact match is "it"', async () => {
    const w = await setup(), { m } = await ready(w, { instruments: [btc({ maxRestingPerSide: 2 })] });
    const b1 = batch(w, [BID]);
    expect(await code(send(w, m, b1))).toBe('ok');
    expect(await quote(w, m, [{ ...BID, price: '69800' }])).toBe('ok');
    expect(st(w, m).pendingQuotes).toBe(2);
    expect(await quote(w, m, [{ ...BID, price: '69700', size: '0.0002' }])).toMatch(/^resting_count: 3 buy/);
    // an impostor: a reduce-only order, or one at another price, carrying the first quote's client id — the quote stays in the ledger
    w.venue.orders = [openOrder({ px: '69900', sz: '0.002', cloid: b1.cloids[0], timestamp: w.t.now * 1000, reduceOnly: true }), openOrder({ side: 'A', px: '69900', sz: '0.002', cloid: b1.cloids[0], timestamp: w.t.now * 1000 })];
    expect(await quote(w, m, [{ ...ASK, size: '0.0002' }])).toBe('ok');
    expect(st(w, m).pendingQuotes).toBe(3);
    // the real one lands: it leaves the ledger and is counted through the venue's list
    w.venue.orders = [openOrder({ px: '69900', sz: '0.002', cloid: b1.cloids[0], timestamp: w.t.now * 1000 + 300 })];
    expect(await quote(w, m, [{ ...BID, price: '69700', size: '0.0002' }])).toMatch(/^resting_count: 3 buy/);   // venue 1 + ledger 1 + batch 1
    expect(st(w, m).pendingQuotes).toBe(2);
    // it is cancelled on the venue: it does not come back into the count (the same signed action cannot land twice)
    w.venue.orders = [];
    expect(await quote(w, m, [{ ...BID, price: '69700', size: '0.0002' }])).toBe('ok');
    // the others expire
    await expirePending(w, m);
    expect(st(w, m).pendingQuotes).toBe(0);
    // a manual order approved with the passkey a moment ago is in the same ledger and counts
    const a = w.signer.status().venues[0]!.authorization as VenueAuthorization, t90 = tradingOf(90_000), nonce = nonceOf(w);
    const r = req({ tif: 'gtc', price: '69950', size: '0.002' }, 0), built = t90.buildOrder(r, { instrument: BTC, nonce }), norm = t90.normalizeRequest(r, BTC);
    const c: VenueOrder = { v: 1, authorizationId: a.authorizationId, venue: 'hyperliquid', network: 'testnet', account: ACCOUNT, kind: 'order', instrument: norm.instrument, side: norm.side, type: 'limit', size: norm.size, price: norm.price!, triggerPrice: null,
      reduceOnly: false, tif: norm.tif, clientId: norm.clientId, nonce, expiresAt: nonce + 90_000 };
    await w.signer.venueSign({ authorizationId: a.authorizationId, sign: built.sign, context: { order: c }, assertion: w.pk.assert(venueOrderHash(c)) });
    expect(await quote(w, m, [BID, { ...BID, price: '69800' }])).toMatch(/^resting_count: 3 buy/);
    expect(await quote(w, m, [BID])).toBe('ok');
  });
});

describe('the bounds as pure functions', () => {
  it('quoteBandError is exact at the edges (cross-multiplied, no rounding)', () => {
    expect(quoteBandError('buy', '69986', '70000', 2, 100)).toBeNull();
    expect(quoteBandError('buy', '69986.00000001', '70000', 2, 100)?.code).toBe('too_tight');
    expect(quoteBandError('buy', '69300', '70000', 2, 100)).toBeNull();
    expect(quoteBandError('buy', '69299.99999999', '70000', 2, 100)?.code).toBe('too_far');
    expect(quoteBandError('sell', '70014', '70000', 2, 100)).toBeNull();
    expect(quoteBandError('sell', '70013.99999999', '70000', 2, 100)?.code).toBe('too_tight');
    expect(quoteBandError('sell', '70000', '70000', 2, 100)?.code).toBe('crosses_mid');
    expect(quoteBandError('buy', '70000', '70000', 2, 100)?.code).toBe('crosses_mid');
    expect(quoteBandError('buy', '1', '0', 2, 100)).not.toBeNull();
  });
  it('property: an accepted bid is strictly below the mid and an accepted ask strictly above — a signed pair can never cross at one mid', () => {
    const px = fc.integer({ min: 1, max: 10_000_000 }).map((x) => D.str(D.div(D.from(BigInt(x)), D.from(100n), 2, 'down')));
    fc.assert(fc.property(px, px, px, fc.integer({ min: 1, max: 499 }), fc.integer({ min: 2, max: 500 }), (bid, ask, mid, lo, hi) => {
      fc.pre(lo < hi);
      const b = quoteBandError('buy', bid, mid, lo, hi) === null, a = quoteBandError('sell', ask, mid, lo, hi) === null;
      if (b) expect(D.lt(D.from(bid), D.from(mid))).toBe(true);
      if (a) expect(D.gt(D.from(ask), D.from(mid))).toBe(true);
      if (a && b) expect(D.lt(D.from(bid), D.from(ask))).toBe(true);
    }), { numRuns: 3000 });
  });
  it('property (pure): whatever the positions and the resting set, a batch that quotingSetCheck accepts leaves counts, notional, inventory and gross inside the mandate', () => {
    const m = mandate(authorization(1794000000), 1794000000, { instruments: [btc(), btc({ instrument: 'hyperliquid:ETH' })] });
    const P = { 'hyperliquid:BTC': '70000', 'hyperliquid:ETH': '2000' };
    const side = fc.constantFrom<'buy' | 'sell'>('buy', 'sell');
    const ord = (i: 'BTC' | 'ETH') => fc.record({ side, size: fc.integer({ min: 1, max: 400 }).map((x) => D.str(D.div(D.from(BigInt(x)), D.from(i === 'BTC' ? 100000n : 1000n), 5, 'down'))), price: fc.integer({ min: 9000, max: 11000 }).map((x) => D.str(D.div(D.mul(D.from(BigInt(x)), D.from(P[`hyperliquid:${i}`])), D.from(10000n), 2, 'down'))) });
    const pos = fc.integer({ min: -600, max: 600 }).map((x) => D.str(D.div(D.from(BigInt(x)), D.from(100000n), 5, 'down')));
    fc.assert(fc.property(pos, pos, fc.array(ord('BTC'), { maxLength: 6 }), fc.array(ord('ETH'), { maxLength: 4 }), fc.array(ord('BTC'), { minLength: 1, maxLength: 4 }), (pb, pe, rb, re, batchOrders) => {
      const positions = [{ instrument: 'hyperliquid:BTC', size: pb }, { instrument: 'hyperliquid:ETH', size: D.str(D.mul(D.from(pe), D.from(10n))) }];
      const resting = [...rb.map((o) => ({ ...o, instrument: 'hyperliquid:BTC', reduceOnly: false })), ...re.map((o) => ({ ...o, instrument: 'hyperliquid:ETH', reduceOnly: false }))];
      const r = quotingSetCheck(m, 'hyperliquid:BTC', positions, resting, batchOrders, P);
      if (!r.ok) return;
      // independent recomputation, in floats
      const all = [...rb, ...batchOrders], v = (o: { size: string; price: string }) => Number(o.size) * Math.max(Number(o.price), 70000), eps = 1e-6;
      for (const s of ['buy', 'sell'] as const) {
        if (!batchOrders.some((o) => o.side === s)) continue;
        expect(all.filter((o) => o.side === s).length).toBeLessThanOrEqual(2);
        expect(all.filter((o) => o.side === s).reduce((x, o) => x + v(o), 0)).toBeLessThanOrEqual(290 + eps);
      }
      expect(all.length + re.length).toBeLessThanOrEqual(4);
      const long = Math.max(Number(pb), 0) * 70000 + all.filter((o) => o.side === 'buy').reduce((x, o) => x + v(o), 0), short = Math.max(-Number(pb), 0) * 70000 + all.filter((o) => o.side === 'sell').reduce((x, o) => x + v(o), 0);
      expect(Math.max(long, short)).toBeLessThanOrEqual(400 + eps);
      for (const o of batchOrders) expect(v(o)).toBeLessThanOrEqual(150 + eps);
      const e = Number(pe) * 10, ev = (o: { size: string; price: string }) => Number(o.size) * Math.max(Number(o.price), 2000);
      const el = Math.max(e, 0) * 2000 + re.filter((o) => o.side === 'buy').reduce((x, o) => x + ev(o), 0), es = Math.max(-e, 0) * 2000 + re.filter((o) => o.side === 'sell').reduce((x, o) => x + ev(o), 0);
      expect(Math.max(long, short) + Math.max(el, es)).toBeLessThanOrEqual(600 + eps);
    }), { numRuns: 3000 });
  });
});

describe('property: NO sequence of signer-accepted actions takes the account beyond the mandate — real signer, random venue states', () => {
  // The adversary is the API: it asks for any batch, at any time, sends or withholds what was signed, and the market fills
  // whatever rests. The truth the test keeps: every order the signer signed is either dead (past its venue expiry and never
  // sent), resting on the venue, or filled into the position. After EVERY accepted batch, the worst case over that truth —
  // every resting or still-sendable order of one side filling — must be inside the mandate, at the signer's price.
  type Step =
    | { k: 'quote'; orders: { side: 'buy' | 'sell'; bps: number; lots: number }[] }
    | { k: 'land'; pick: number } | { k: 'fill'; pick: number; part: number } | { k: 'cancel'; pick: number } | { k: 'time'; s: number } | { k: 'reduce'; lots: number } | { k: 'price'; bps: number };
  const step: fc.Arbitrary<Step> = fc.oneof(
    { weight: 6, arbitrary: fc.record({ k: fc.constant('quote' as const), orders: fc.array(fc.record({ side: fc.constantFrom<'buy' | 'sell'>('buy', 'sell'), bps: fc.integer({ min: -5, max: 130 }), lots: fc.integer({ min: 15, max: 240 }) }), { minLength: 1, maxLength: 4 }) }) },
    { weight: 3, arbitrary: fc.record({ k: fc.constant('land' as const), pick: fc.nat(20) }) },
    { weight: 3, arbitrary: fc.record({ k: fc.constant('fill' as const), pick: fc.nat(20), part: fc.integer({ min: 1, max: 4 }) }) },
    { weight: 1, arbitrary: fc.record({ k: fc.constant('cancel' as const), pick: fc.nat(20) }) },
    { weight: 2, arbitrary: fc.record({ k: fc.constant('time' as const), s: fc.integer({ min: 1, max: 25 }) }) },
    { weight: 1, arbitrary: fc.record({ k: fc.constant('reduce' as const), lots: fc.integer({ min: 15, max: 200 }) }) },
    { weight: 1, arbitrary: fc.record({ k: fc.constant('price' as const), bps: fc.integer({ min: -40, max: 40 }) }) },
  );
  it('worst-case inventory, resting counts and resting notional never exceed the mandate', async () => {
    let accepted = 0, refused = 0;
    await fc.assert(fc.asyncProperty(fc.array(step, { minLength: 8, maxLength: 30 }), async (steps) => {
      const w = await setup(), { m } = await mandated(w, { rate: { burstActions: 20, actionsPerMinute: 60, ordersPerHour: 3600, ordersPerDay: 20000, dailyTurnover: '2000000' } });
      const mi = m.instruments[0]!;
      interface Live { cloid: string; side: 'buy' | 'sell'; size: number; price: number; sendableUntil: number; resting: boolean }
      let live: Live[] = [], pos = 0;                                                                  // pos in lots of 0.00001
      const sync = () => {
        w.venue.orders = live.filter((o) => o.resting).map((o) => openOrder({ side: o.side === 'buy' ? 'B' : 'A', px: String(o.price), sz: (o.size / 1e5).toFixed(5), cloid: o.cloid, timestamp: w.t.now * 1000 }));
        w.venue.positions = pos === 0 ? [] : [{ coin: 'BTC', szi: (pos / 1e5).toFixed(5), mark: String(w.px.BTC) }];
      };
      for (const s of steps) {
        live = live.filter((o) => o.resting || o.sendableUntil > w.t.now * 1000);                      // an unsent order past its venue expiry is dead
        if (s.k === 'time') { w.t.now += s.s; continue; }
        if (s.k === 'price') { w.px.BTC = Math.round(w.px.BTC! * (1 + s.bps / 1e4)); sync(); continue; }
        if (s.k === 'land') { const c = live.filter((o) => !o.resting); if (c.length) c[s.pick % c.length]!.resting = true; sync(); continue; }
        if (s.k === 'cancel') { const c = live.filter((o) => o.resting); if (c.length) live = live.filter((o) => o !== c[s.pick % c.length]); sync(); continue; }
        if (s.k === 'fill') {                                                                          // the market takes a resting order, wholly or partly
          const c = live.filter((o) => o.resting);
          if (c.length) { const o = c[s.pick % c.length]!, q = Math.max(1, Math.floor(o.size / s.part)); pos += o.side === 'buy' ? q : -q; o.size -= q; if (o.size <= 0) live = live.filter((x) => x !== o); }
          sync(); continue;
        }
        if (s.k === 'reduce') { if (pos !== 0) { const q = Math.min(Math.abs(pos), s.lots); expect(await quote(w, m, [{ side: pos > 0 ? 'sell' : 'buy', reduceOnly: true, tif: 'ioc', size: (q / 1e5).toFixed(5), price: String(w.px.BTC) }])).toBe('ok'); pos += pos > 0 ? -q : q; sync(); } continue; }
        // a batch of quotes, wherever the adversary wants them
        sync();
        expect(await arm(w, m, 40)).toBe('ok');
        const mid = w.px.BTC!, orders: Q[] = s.orders.map((o) => ({ side: o.side, size: (o.lots / 1e5).toFixed(5), price: String(Math.round(o.side === 'buy' ? mid * (1 - o.bps / 1e4) : mid * (1 + o.bps / 1e4))) }));
        const b = batch(w, orders), res = await code(send(w, m, b));
        if (res !== 'ok') { refused += 1; expect(res).toMatch(/^(quote_crosses_mid|quote_too_tight|quote_too_far|quote_notional|resting_count|resting_total|resting_notional|inventory_exceeded|gross_exceeded|rate|venue_inconsistent)/); continue; }
        accepted += 1;
        s.orders.forEach((o, i) => live.push({ cloid: b.cloids[i]!, side: o.side, size: o.lots, price: Number(orders[i]!.price), sendableUntil: b.nonce + TTL, resting: false }));
        // ---- the invariant, recomputed independently from the truth ----
        const val = (o: Live) => (o.size / 1e5) * Math.max(o.price, mid), eps = 1e-6;
        for (const side of ['buy', 'sell'] as const) {
          const set = live.filter((o) => o.side === side);
          if (s.orders.some((o) => o.side === side)) {
            expect(set.length, `${side} count`).toBeLessThanOrEqual(mi.maxRestingPerSide);
            expect(set.reduce((x, o) => x + val(o), 0), `${side} notional`).toBeLessThanOrEqual(Number(mi.maxRestingNotionalPerSide) + eps);
          }
          const worst = Math.max(side === 'buy' ? pos : -pos, 0) / 1e5 * mid + set.reduce((x, o) => x + val(o), 0);
          expect(worst, `${side} worst-case inventory`).toBeLessThanOrEqual(Number(mi.maxInventoryNotional) + eps);
          for (const o of set.filter((x) => b.cloids.includes(x.cloid))) { expect(val(o)).toBeLessThanOrEqual(Number(mi.maxQuoteNotional) + eps); expect(side === 'buy' ? o.price < mid : o.price > mid).toBe(true); }
        }
        expect(live.length).toBeLessThanOrEqual(m.maxRestingTotal);
      }
    }), { numRuns: 60 });
    expect(accepted).toBeGreaterThan(40);                                                             // the property is not vacuous
    expect(refused).toBeGreaterThan(40);
  }, 120_000);
});
