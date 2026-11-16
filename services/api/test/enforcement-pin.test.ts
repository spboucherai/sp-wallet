// Pins the "enforced by" claims of docs/TRADING-MANDATES.md and docs/V11-RISK-MODEL.md against the isolated signer ITSELF.
//
// The API is taken out of the picture: a trading mandate is compiled by the real compiler, approved at the REAL signer class
// with a passkey, and then the signer is asked directly — as a compromised or careless API would, with no check of its own —
// to sign orders that break the trading mandate, one field at a time.
//   - a field the documents call `signer` or `signer (partly)` must be REFUSED by the signer, with its own code;
//   - a field the documents call `API only` must be SIGNED by the signer: that is what "API only" means, and what a compromised
//     API could do. If the signer ever starts enforcing one of them, this test says so and the documents must be corrected.
// The last test ties the cases to the compiler's enforcement table: no field of the trading mandate is left without a case.
// No network: the signer's prices and its venue reader are scripted. The mnemonic is the public BIP-39 test vector.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { D } from '@spw/derivatives';
import { createHlTrading, hlPinnedAssets, jurisdictionAck, venueAuthorizationHash, venueMandateHash, type OrderRequest, type SignRequest, type VenueAuthorization, type VenueMandate } from '@spw/derivatives/live';
import { compileToVenueMandate, TRADING_MANDATE_FIELDS, tradingMandateHashHex, validateTradingMandate, type TradingMandate } from '@spw/trading';
import type { Instrument } from '../../../packages/derivatives/src/models.ts';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';
import { hyperliquidReader } from '../../isolated-signer/src/venue-read.ts';

const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const ACCOUNT = keys.addresses.evm.toLowerCase(), AGENT = keys.venueKey('hyperliquid', 'testnet').address, ACK = jurisdictionAck('hyperliquid', 'fr').sha256;
const inst = (symbol: string, lot: string): Instrument => ({ venue: 'hyperliquid', symbol, id: `hyperliquid:${symbol}`, base: symbol, quote: 'USD', kind: 'perpetual', collateral: 'USDC', settlement: '',
  tickSize: '0.1', lotSize: lot, minOrderSize: null, minNotional: '10', maxLeverage: '40', marginModes: ['cross', 'isolated'], fundingIntervalSec: 3600, markPriceMethod: '', status: 'active' });
const BTC = inst('BTC', '0.00001'), ETH = inst('ETH', '0.0001');
const trading = createHlTrading({ network: 'testnet', assets: hlPinnedAssets('testnet'), expiresAfterMs: 90_000 });
let seq = 0;
const uuid = () => `9c3d2f1e-9a6a-4c2f-8d67-${String(++seq).padStart(12, '0')}`;

interface Venue { accountValue: string; positions: { coin: string; szi: string; mark: string }[]; lev: Record<string, { type: 'cross' | 'isolated'; value: number }> }
async function world() {
  const t = { now: Math.floor(Date.now() / 1000) }, dir = mkdtempSync(join(tmpdir(), 'spw-pin-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
  const px: Record<string, number> = { BTC: 70_000, ETH: 2_000 };
  const venue: Venue = { accountValue: '1000', positions: [], lev: { BTC: { type: 'cross', value: 3 }, ETH: { type: 'cross', value: 3 } } };
  const value = (p: { szi: string; mark: string }) => D.mul(D.abs(D.from(p.szi)), D.from(p.mark));
  const post = async (_url: string, body: any): Promise<unknown> => {
    if (body.type === 'clearinghouseState') {
      const assetPositions = venue.positions.map((p) => ({ type: 'oneWay', position: { coin: p.coin, szi: p.szi, entryPx: p.mark, positionValue: D.str(value(p)), unrealizedPnl: '0.0', liquidationPx: null, marginUsed: '0.0',
        leverage: venue.lev[p.coin] ?? { type: 'cross', value: 20 }, cumFunding: { allTime: '0.0', sinceOpen: '0.0', sinceChange: '0.0' } } }));
      const summary = { accountValue: venue.accountValue, totalNtlPos: D.str(venue.positions.reduce((s, p) => D.add(s, value(p)), D.zero)), totalRawUsd: '0.0', totalMarginUsed: '0.0' };
      return { marginSummary: summary, crossMarginSummary: summary, crossMaintenanceMarginUsed: '0.0', withdrawable: '0.0', assetPositions, time: t.now * 1000 };
    }
    if (body.type === 'frontendOpenOrders') return [];
    if (body.type === 'activeAssetData') return { user: body.user, coin: body.coin, leverage: venue.lev[body.coin] ?? { type: 'cross', value: 20 }, markPx: '0' };
    throw new Error(`no answer for ${body.type}`);
  };
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => t.now, { get: async (syms: string[]) => Object.fromEntries(syms.map((s) => [s, px[s]!])) }, hyperliquidReader(post));
  const pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 'tok' });
  // the venue authorization the owner approved (wider than the mandate on purpose: the mandate must be what binds)
  const a: VenueAuthorization = { v: 1, authorizationId: uuid(), keyId: keys.keyId, venue: 'hyperliquid', network: 'testnet', account: ACCOUNT, agentAddress: AGENT, agentName: 'spw-live', mode: 'MANUAL_LIVE',
    policy: { allowedInstruments: [BTC.id, ETH.id], maxLeverage: 5, maxOrderNotional: '300', maxPositionNotional: '500', maxGrossExposure: '800', maxOrdersPerDay: 50, maxPriceDeviationBps: 300 },
    createdAt: t.now, expiresAt: t.now + 60 * 86400, approveNonce: t.now * 1000, ackSha256: ACK };
  await signer.venueAuthorize(a, pk.assert(venueAuthorizationHash(a)));
  // the TRADING mandate — the API-side contract — and what the real compiler makes of it for the signer
  const tm: TradingMandate = { v: 1, mandateId: uuid(), principal: { kind: 'api_key', id: 'spk_pin' }, accounts: [{ kind: 'venue_account', venue: 'hyperliquid', network: 'testnet', account: ACCOUNT }], venues: ['hyperliquid'], networks: ['testnet'],
    instruments: [BTC.id], marketKinds: ['perp'], orderTypes: ['limit'], maxCapitalUsd: '200', maxOrderNotionalUsd: '200', maxPositionNotionalUsd: '400', maxLeverage: '3', maxDailyLossUsd: '10', floorEquityUsd: '100',
    createdAt: t.now, notBefore: t.now, notAfter: t.now + 20 * 86400, frequency: { perMinute: 2, perHour: 6, perDay: 10 }, maxSlippageBps: 300, maxFeeUsd: '0.01',
    stopConditions: [{ kind: 'loss_gte', usd: '5' }, { kind: 'drawdown_gte', bps: 100 }, { kind: 'consecutive_rejects_gte', count: 1 }], mode: 'live', strategySha256: 'ab'.repeat(32), label: 'pin' };
  validateTradingMandate(tm, t.now);
  const c = compileToVenueMandate(tm, { authorization: a, ackSha256: ACK }), m: VenueMandate = c.mandate;
  await signer.venueMandateApprove(m, pk.assert(venueMandateHash(m)));
  const build = (o: Partial<OrderRequest> = {}, instrument: Instrument = BTC): { sign: SignRequest } => {
    const nonce = t.now * 1000 + ++seq;
    return { sign: trading.buildOrder({ instrument: instrument.id, side: 'buy', type: 'limit', size: '0.0002', price: '70000', triggerPrice: null, reduceOnly: false, tif: 'gtc', clientId: `pin-${nonce}`, ...o }, { instrument, nonce }).sign };
  };
  /** the "API" here checks nothing: whatever is built is handed to the signer */
  const ask = async (b: { sign: SignRequest }, mandateId = m.mandateId): Promise<string> => signer.venueMandateSign({ mandateId, sign: b.sign }).then(() => 'signed', (e: { code?: string }) => String(e.code ?? 'error'));
  return { t, px, venue, signer, a, tm, m, enforcement: c.enforcement, build, ask, order: (o: Partial<OrderRequest> = {}, i: Instrument = BTC) => ask(build(o, i)) };
}

/** field of the trading mandate → the cases below that exercise it */
const refusedBySigner = new Map<string, string[]>(), signedDespite = new Map<string, string[]>();
const note = (map: Map<string, string[]>, field: string, what: string): void => { map.set(field, [...(map.get(field) ?? []), what]); };

describe('what the isolated signer refuses by itself, whatever the API lets through (documents: `signer`, `signer (partly)`)', () => {
  it('instruments, order notional, price band, network, the mandate id — and a control order inside every limit is signed', async () => {
    const w = await world();
    expect(await w.order()).toBe('signed');
    expect(await w.order({}, ETH)).toBe('instrument'); note(refusedBySigner, 'instruments', 'an order on an instrument of the authorization that the mandate does not list');
    expect(await w.order({ size: '0.003' })).toBe('order_notional'); note(refusedBySigner, 'maxOrderNotionalUsd', '0.003 BTC at 70 000 = 210 > 200');
    expect(await w.order({ size: '0.003', side: 'sell', reduceOnly: true })).toBe('order_notional');                    // reduce-only orders included, as the table says
    expect(await w.order({ price: '72200' })).toBe('price'); note(refusedBySigner, 'maxSlippageBps', 'a limit price 3.14 % from the signer\'s own mid (band 300 bps)');
    const mainnet = createHlTrading({ network: 'mainnet', assets: hlPinnedAssets('mainnet'), expiresAfterMs: 90_000, allowMainnetExchange: true } as never);
    const other = mainnet.buildOrder({ instrument: BTC.id, side: 'buy', type: 'limit', size: '0.0002', price: '70000', triggerPrice: null, reduceOnly: false, tif: 'gtc', clientId: 'pin-mainnet' }, { instrument: BTC, nonce: w.t.now * 1000 + ++seq });
    expect(await w.ask({ sign: other.sign })).toBe('wrong_venue'); note(refusedBySigner, 'networks', 'a payload built for mainnet under a testnet mandate'); note(refusedBySigner, 'venues', 'the same check: venue and network of the sign request');
    expect(await w.ask(w.build(), uuid())).toBe('not_found'); note(refusedBySigner, 'mandateId', 'an id the signer never approved');
    note(refusedBySigner, 'accounts', 'the trading key signs for the one account that approved it; the signer reads THAT account (the scripted venue refuses any other user)');
    note(refusedBySigner, 'marketKinds', 'structural: the pinned asset table of this shape holds perpetuals only');
  });

  it('position, gross exposure, leverage setting, the floor: from the signer\'s OWN read of the venue account', async () => {
    const w = await world();
    w.venue.positions = [{ coin: 'BTC', szi: '0.005', mark: '70000' }];                                                  // 350 held; + 140 = 490 > 400
    expect(await w.order({ size: '0.002' })).toBe('position_exceeded'); note(refusedBySigner, 'maxPositionNotionalUsd', 'venue position 350 + order 140 > 400');
    w.venue.positions = [{ coin: 'ETH', szi: '0.25', mark: '2000' }];                                                    // 500 held elsewhere; + 140 = 640 > 200 × 3
    expect(await w.order({ size: '0.002' })).toBe('gross_exceeded'); note(refusedBySigner, 'maxCapitalUsd', 'worst-case gross 640 > capital 200 × leverage 3 (the capital itself is not capped: signer partly)');
    w.venue.positions = [];
    w.venue.lev.BTC = { type: 'cross', value: 4 };
    expect(await w.order()).toBe('leverage_setting'); note(refusedBySigner, 'maxLeverage', 'the venue\'s setting is 4×, the mandate allows 3×');
    const lev = (leverage: number) => w.ask({ sign: trading.buildUpdateLeverage({ instrument: BTC, leverage, marginMode: 'cross', nonce: w.t.now * 1000 + ++seq }).sign });
    expect(await lev(4)).toBe('leverage_exceeded');
    expect(await lev(3)).toBe('signed');
    w.venue.lev.BTC = { type: 'cross', value: 3 };
    w.venue.accountValue = '99.99';
    expect(await w.order()).toBe('floor_equity'); note(refusedBySigner, 'floorEquityUsd', 'the venue reports 99.99, the floor is 100');
    w.venue.positions = [{ coin: 'BTC', szi: '0.001', mark: '70000' }];
    expect(await w.order({ side: 'sell', size: '0.001', reduceOnly: true })).toBe('signed');                             // the way out stays open below the floor
  });

  it('orders per hour and per day, the daily turnover, the expiry and a revocation', async () => {
    const w = await world();
    for (let k = 0; k < 6; k++) expect(await w.order(), `order ${k + 1} of the hour`).toBe('signed');
    expect(await w.order()).toBe('orders_hour');
    w.t.now += 3601;
    for (let k = 0; k < 4; k++) expect(await w.order(), `order ${k + 7} of the day`).toBe('signed');
    w.t.now += 3601;
    // (the test may straddle midnight UTC: then the daily counter restarted and the hourly rule is what answers)
    expect(['orders_day', 'signed']).toContain(await w.order()); note(refusedBySigner, 'frequency', '6 orders an hour, 10 a day (per minute: see the API-only cases)');
    const w2 = await world();
    w2.t.now = w2.tm.notAfter + 1;
    expect(await w2.order()).toBe('wind_down'); note(refusedBySigner, 'notAfter', 'after the expiry only cancels and reduce-only orders, then nothing');
    w2.t.now = w2.tm.notAfter + 86_400 + 1;
    expect(await w2.order({ side: 'sell', reduceOnly: true })).toBe('expired');
    const w3 = await world();
    w3.signer.venueMandateRevoke(w3.m.mandateId);
    expect(await w3.order()).toBe('wind_down');
  });

  it('createdAt must be current at the approval; the principal and the strategy hash are recorded, not verified', async () => {
    const w = await world();
    const stale: VenueMandate = { ...w.m, mandateId: uuid(), createdAt: w.t.now - 601 };
    w.signer.venueMandateRevoke(w.m.mandateId);
    await expect(w.signer.venueMandateApprove(stale, new TestPasskey(RP, ORIGIN).assert(venueMandateHash(stale)))).rejects.toMatchObject({ code: 'unsupported' });
    note(refusedBySigner, 'createdAt', 'an approval whose creation time is 601 s old is refused');
    note(refusedBySigner, 'notBefore', 'the signer has no start time: the only bound is the window on createdAt above (signer partly)');
    const st = w.signer.status().venueMandates.find((x) => x.mandate.mandateId === w.m.mandateId)!;
    expect([st.mandate.agentId, st.mandate.strategySha256]).toEqual(['spk_pin', 'ab'.repeat(32)]);
    note(refusedBySigner, 'principal', 'recorded in the signer\'s copy (agentId); the signer signs for any caller of the API — see the API-only case'); note(refusedBySigner, 'strategySha256', 'recorded, part of the approved hash');
  });
});

describe('what the signer SIGNS although the trading mandate forbids it (documents: `API only`) — a compromised API is bound by none of these', () => {
  it('an order type the mandate does not allow, a third order in one minute, a loss beyond the daily limit and the stop conditions, any fee, any caller', async () => {
    const w = await world();
    // orderTypes = [limit]: a stop order that would OPEN is signed (inside the band)
    expect(await w.order({ type: 'stop_market', side: 'buy', price: '70700', triggerPrice: '70500' })).toBe('signed'); note(signedDespite, 'orderTypes', 'a stop order under a limit-only mandate');
    // frequency.perMinute = 2: the third order of the same minute is signed
    expect([await w.order(), await w.order()]).toEqual(['signed', 'signed']); note(signedDespite, 'frequency', 'a third order in the same minute (perMinute = 2)');
    // maxDailyLossUsd = 10 and stopConditions loss_gte 5 / drawdown_gte 1 %: the account lost 400 of 1 000 today and is still above the floor
    w.venue.accountValue = '600';
    expect(await w.order()).toBe('signed'); note(signedDespite, 'maxDailyLossUsd', 'account value down 400 in the day, daily limit 10'); note(signedDespite, 'stopConditions', 'loss_gte 5 and drawdown_gte 100 bps are both met');
    // maxFeeUsd = 0.01: the signer never sees a fee
    note(signedDespite, 'maxFeeUsd', 'no fee appears in anything the signer reads; every order above was signed with a fee cap of 0.01 USD');
    // the principal: nothing in a sign request says who asks
    note(signedDespite, 'principal', 'every order above was signed without any statement of who asked');
    // the label is not in the signer shape at all
    expect(Object.keys(w.m)).not.toContain('label'); note(signedDespite, 'label', 'absent from SPW-VENUE-MANDATE-v1');
  });

  it('nuances the tables state: a cancel on an instrument outside the mandate, and a reduce-only trigger far from the market', async () => {
    const w = await world();
    expect(await w.ask({ sign: trading.buildCancel({ instrument: ETH, clientId: 'x', nonce: w.t.now * 1000 + ++seq }).sign })).toBe('signed');   // bounded by the authorization's instruments
    w.venue.positions = [{ coin: 'BTC', szi: '0.001', mark: '70000' }];
    expect(await w.order({ type: 'stop_market', side: 'sell', reduceOnly: true, size: '0.001', price: '59000', triggerPrice: '60000' })).toBe('signed');   // 14 % below the mid: allowed for a protective, reduce-only trigger
    expect(await w.order({ type: 'stop_market', side: 'sell', reduceOnly: false, size: '0.001', price: '59000', triggerPrice: '60000' })).toBe('price');
  });
});

describe('the cases above cover the compiler\'s enforcement table, field by field', () => {
  it('every field the compiler marks signer / signer (partly) has a refusal case; every API-only field has a "signed anyway" case', async () => {
    const w = await world();
    expect(w.enforcement.map((e) => e.field)).toEqual(TRADING_MANDATE_FIELDS);
    expect(tradingMandateHashHex(w.tm)).toMatch(/^[0-9a-f]{64}$/);
    const by = Object.fromEntries(w.enforcement.map((e) => [e.field, e.enforcedBy]));
    expect(by).toEqual({ v: 'not_applicable', mandateId: 'signer', principal: 'signer_partial', accounts: 'signer', venues: 'signer', networks: 'signer', instruments: 'signer', marketKinds: 'signer', orderTypes: 'api_only',
      maxCapitalUsd: 'signer_partial', maxOrderNotionalUsd: 'signer', maxPositionNotionalUsd: 'signer', maxLeverage: 'signer', maxDailyLossUsd: 'api_only', floorEquityUsd: 'signer', createdAt: 'signer', notBefore: 'signer_partial',
      notAfter: 'signer', frequency: 'signer_partial', maxSlippageBps: 'signer_partial', maxFeeUsd: 'api_only', stopConditions: 'api_only', mode: 'not_applicable', strategySha256: 'signer_partial', label: 'api_only' });
    for (const e of w.enforcement) {
      if (e.enforcedBy === 'signer' || e.enforcedBy === 'signer_partial') expect(refusedBySigner.get(e.field)?.length ?? 0, `${e.field} is documented as enforced by the signer: a case must show it`).toBeGreaterThan(0);
      if (e.enforcedBy === 'api_only') expect(signedDespite.get(e.field)?.length ?? 0, `${e.field} is documented as API only: a case must show the signer signing despite it`).toBeGreaterThan(0);
    }
    // the two partly-enforced fields that have an API-only half show both halves
    for (const f of ['frequency', 'principal']) expect([refusedBySigner.has(f), signedDespite.has(f)]).toEqual([true, true]);
  });
});
