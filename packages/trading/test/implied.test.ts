import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { D } from '@spw/derivatives';
import { impliedValuation, VALUATION_CAVEATS, type ContractDescriptor, type PricePoint, type PrivateValuation } from '../src/index.ts';

const TS = Date.UTC(2026, 10, 15, 12, 0, 0);
const price = (p: string): PricePoint => ({ price: p, ts: TS, source: 'venue ticker' });
const contract = (over: Partial<ContractDescriptor> = {}): ContractDescriptor => ({ venue: 'venue-x', symbol: 'ACME-PERP', priceUnit: { kind: 'usd_per_share' }, formulaSource: 'https://example.com/docs/acme', dilutedShares: null, ...over });
const shares = { value: '2500000000', asOf: '2026-06-30', source: 'company filing, cap table summary' };
const lastRound: PrivateValuation = { value: '300000000000', kind: 'priced_round_post_money', date: '2026-03-01', source: 'press release' };

describe('implied valuation — what the price unit defines', () => {
  it('valuation in USD billions: valuation = price × 1e9', () => {
    const r = impliedValuation(contract({ priceUnit: { kind: 'valuation_usd_billions' } }), price('352.5'));
    expect(r.implied.impliedValuation).toMatchObject({ value: '352500000000' });
    expect(r.implied.impliedValuation!.formula).toMatch(/price × 1 000 000 000/);
    expect(r.implied.impliedValuation!.sources).toEqual([{ what: 'contract price', source: 'venue ticker', asOf: '2026-11-15T12:00:00.000Z' }, { what: 'price definition of the venue', source: 'https://example.com/docs/acme', asOf: 'as published' }]);
    expect(r.syntheticPrice).toEqual({ value: '352.5', unit: 'valuation_usd_billions', ts: TS, source: 'venue ticker' });
  });
  it('scaled valuation: valuation = price × divisor', () => {
    const r = impliedValuation(contract({ priceUnit: { kind: 'valuation_scaled', divisor: '1000000' } }), price('352500.25'));
    expect(r.implied.impliedValuation!.value).toBe('352500250000');
    expect(r.implied.impliedValuation!.formula).toContain('price × 1000000');
  });
  it('per share WITH a sourced diluted share count: valuation = price × shares, sources and dates attached', () => {
    const r = impliedValuation(contract({ dilutedShares: shares }), price('141.2'));
    expect(r.implied.impliedValuation!.value).toBe('353000000000');
    expect(r.implied.impliedValuation!.sources).toContainEqual({ what: 'fully diluted share count', source: 'company filing, cap table summary', asOf: '2026-06-30' });
    expect(r.caveats.some((c) => c.includes('2026-06-30'))).toBe(true);
  });
  it('per share WITHOUT a share count: no valuation, with the reason', () => {
    const r = impliedValuation(contract(), price('141.2'));
    expect(r.implied).toEqual({ impliedValuation: null, reason: expect.stringMatching(/no sourced fully diluted share count/) });
  });
  it('index points and unknown units: no valuation, with the reason', () => {
    expect(impliedValuation(contract({ priceUnit: { kind: 'index_points' } }), price('1042')).implied).toEqual({ impliedValuation: null, reason: expect.stringMatching(/index points/) });
    expect(impliedValuation(contract({ priceUnit: { kind: 'unknown' } }), price('1042')).implied).toEqual({ impliedValuation: null, reason: expect.stringMatching(/unknown/) });
    // a share count does not rescue a unit that is not per share
    expect(impliedValuation(contract({ priceUnit: { kind: 'index_points' }, dilutedShares: shares }), price('1042')).implied.impliedValuation).toBeNull();
    expect(impliedValuation(contract({ priceUnit: { kind: 'unknown' }, dilutedShares: shares }), price('1042')).implied.impliedValuation).toBeNull();
  });
  it('a valuation unit that no document of the venue backs is flagged as unsourced', () => {
    const r = impliedValuation(contract({ priceUnit: { kind: 'valuation_usd_billions' }, formulaSource: null }), price('352.5'));
    expect(r.implied.impliedValuation!.sources[1]!.source).toMatch(/NOT SOURCED/);
    expect(r.caveats.some((c) => /not backed by a document/.test(c))).toBe(true);
  });
});

describe('implied valuation — contract value, exposure and price are kept apart', () => {
  it('per share: one contract is worth its price; a position\'s exposure is size × that, negative for a short', () => {
    const long = impliedValuation(contract(), price('141.2'), { position: { side: 'long', size: '50' } });
    expect(long.contractMarketValue.value).toBe('141.2');
    expect(long.notionalExposure).toMatchObject({ value: '7060', reason: null });
    expect(impliedValuation(contract(), price('141.2'), { position: { side: 'short', size: '50' } }).notionalExposure!.value).toBe('-7060');
    expect(long.implied.impliedValuation).toBeNull();                               // an exposure is not a valuation
  });
  it('a valuation-quoted contract has no USD contract value unless the venue defines a multiplier', () => {
    const r = impliedValuation(contract({ priceUnit: { kind: 'valuation_usd_billions' } }), price('352.5'), { position: { side: 'long', size: '10' } });
    expect(r.contractMarketValue).toMatchObject({ value: null, reason: expect.stringMatching(/not the USD value of a contract/) });
    expect(r.notionalExposure).toMatchObject({ value: null }); expect(r.notionalExposure!.reason).toBeTruthy();
    expect(r.implied.impliedValuation!.value).toBe('352500000000');                 // …while the valuation is defined
  });
  it('no position, no exposure', () => { expect(impliedValuation(contract(), price('141.2')).notionalExposure).toBeNull(); });
  it('always carries the two standing caveats', () => { expect(impliedValuation(contract(), price('1')).caveats).toEqual(expect.arrayContaining([...VALUATION_CAVEATS])); });
});

describe('implied valuation — premium or discount to the last private valuation', () => {
  it('premium in basis points, with the kind and date of the reference', () => {
    const r = impliedValuation(contract({ priceUnit: { kind: 'valuation_usd_billions' } }), price('352.5'), { lastPrivate: lastRound });
    expect(r.versusPrivate).toMatchObject({ premiumBps: '1750', reason: null, reference: lastRound });      // 352.5 / 300 − 1 = 17.5 %
    expect(r.versusPrivate!.caveat).toMatch(/priced round post money dated 2026-03-01; the contract price is dated 2026-11-15/);
  });
  it('a discount is negative', () => {
    expect(impliedValuation(contract({ priceUnit: { kind: 'valuation_usd_billions' } }), price('270'), { lastPrivate: lastRound }).versusPrivate!.premiumBps).toBe('-1000');
  });
  it('no implied valuation → no premium, with the same reason', () => {
    const r = impliedValuation(contract(), price('141.2'), { lastPrivate: lastRound });
    expect(r.versusPrivate).toMatchObject({ premiumBps: null, reason: expect.stringMatching(/share count/) });
  });
  it('no reference → no comparison', () => { expect(impliedValuation(contract(), price('141.2')).versusPrivate).toBeNull(); });
});

describe('implied valuation — inputs', () => {
  it('refuses malformed descriptors, prices and references', () => {
    expect(() => impliedValuation(contract({ priceUnit: { kind: 'usd_per_token' } as never }), price('1'))).toThrow();
    expect(() => impliedValuation(contract({ priceUnit: { kind: 'valuation_scaled', divisor: '0' } }), price('1'))).toThrow();
    expect(() => impliedValuation(contract({ formulaSource: 'not a url' }), price('1'))).toThrow();
    expect(() => impliedValuation(contract({ dilutedShares: { value: '1000', asOf: 'last year', source: 'x' } }), price('1'))).toThrow();
    expect(() => impliedValuation(contract({ dilutedShares: { value: '1000', asOf: '2026-01-01', source: '' } }), price('1'))).toThrow();
    expect(() => impliedValuation(contract(), price('0'))).toThrow();
    expect(() => impliedValuation(contract(), { price: 141.2 as unknown as string, ts: TS, source: 'x' })).toThrow();
    expect(() => impliedValuation(contract(), price('1'), { lastPrivate: { ...lastRound, kind: 'rumour' as never } })).toThrow();
    expect(() => impliedValuation(contract(), price('1'), { position: { side: 'long', size: '-1' } })).toThrow();
  });
  it('property: exact decimal arithmetic — price × shares, no float rounding', () => {
    const dec = fc.tuple(fc.bigInt({ min: 1n, max: 10n ** 12n }), fc.integer({ min: 0, max: 8 })).map(([m, s]) => D.str({ m, s }));
    fc.assert(fc.property(dec, fc.bigInt({ min: 1n, max: 10n ** 13n }), (p, n) => {
      const r = impliedValuation(contract({ dilutedShares: { ...shares, value: n.toString() } }), price(p));
      expect(r.implied.impliedValuation!.value).toBe(D.str(D.mul(D.from(p), D.from(n))));
      const b = impliedValuation(contract({ priceUnit: { kind: 'valuation_usd_billions' } }), price(p));
      expect(b.implied.impliedValuation!.value).toBe(D.str(D.mul(D.from(p), D.from(10n ** 9n))));
      // a valuation equal to the reference is a premium of exactly zero
      const same = impliedValuation(contract({ priceUnit: { kind: 'valuation_usd_billions' } }), price(p), { lastPrivate: { ...lastRound, value: b.implied.impliedValuation!.value } });
      expect(same.versusPrivate!.premiumBps).toBe('0');
    }), { numRuns: 300 });
  });
  it('property: only the three defining units ever give a valuation', () => {
    const unit = fc.constantFrom<ContractDescriptor['priceUnit']>({ kind: 'usd_per_share' }, { kind: 'valuation_usd_billions' }, { kind: 'valuation_scaled', divisor: '1000' }, { kind: 'index_points' }, { kind: 'unknown' });
    fc.assert(fc.property(unit, fc.boolean(), fc.boolean(), (u, withShares, withDoc) => {
      const r = impliedValuation(contract({ priceUnit: u, dilutedShares: withShares ? shares : null, formulaSource: withDoc ? 'https://example.com/d' : null }), price('12.5'));
      const defined = u.kind === 'valuation_usd_billions' || u.kind === 'valuation_scaled' || (u.kind === 'usd_per_share' && withShares);
      expect(r.implied.impliedValuation !== null).toBe(defined);
      if (!defined) expect(r.implied.reason).toBeTruthy(); else { expect(r.implied.impliedValuation!.formula).toBeTruthy(); expect(r.implied.impliedValuation!.sources.length).toBeGreaterThanOrEqual(2); }
    }), { numRuns: 100 });
  });
});
