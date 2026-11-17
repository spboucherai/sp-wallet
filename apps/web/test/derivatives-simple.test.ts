// The simple order form of a venue account (apps/web/src/derivatives/simple.ts) and the venue switch (apps/web/src/venues.ts):
// the rules behind every figure the form derives. No browser, no network.
import { describe, expect, it } from 'vitest';
import { D, usdToSize } from '../src/derivatives/dec';
import { drifted, liqEstimate, maxUsd, usdChips } from '../src/derivatives/simple';
import { SHOWN_HUB_VENUES } from '../src/markets';
import { hubVenueParam, instrumentShown, MULTI_VENUE, SHOWN_VENUES, venueShown } from '../src/venues';

describe('the venue switch', () => {
  it('Hyperliquid only: the other venues are not offered, and a single venue has no cross-venue view', () => {
    expect(SHOWN_VENUES).toEqual(['hyperliquid']);
    expect(venueShown('hyperliquid')).toBe(true);
    for (const v of ['dydx', 'edgex', 'gmx']) expect(venueShown(v)).toBe(false);
    expect(MULTI_VENUE).toBe(false);
    expect(SHOWN_HUB_VENUES).toEqual(['hyperliquid']);
  });
  it('an instrument follows its venue — a builder-dex market of Hyperliquid included', () => {
    expect(instrumentShown('hyperliquid:BTC')).toBe(true); expect(instrumentShown('hyperliquid:xyz:TSLA')).toBe(true);
    expect(instrumentShown('gmx:BTC/USD [BTC-USDC]')).toBe(false); expect(instrumentShown('dydx:BTC-USD')).toBe(false); expect(instrumentShown('BTC')).toBe(false);
  });
  it('a hub listing is asked for the single shown venue unless the owner chose one', () => {
    expect(hubVenueParam('')).toBe('hyperliquid'); expect(hubVenueParam('hyperliquid')).toBe('hyperliquid');
  });
});

describe('amount in USD → size', () => {
  it('amount ÷ mark, rounded DOWN to the lot: the order is never larger than what was typed', () => {
    const size = usdToSize(D.from('50'), D.from('96000'), D.from('0.00001'));
    expect(D.str(size)).toBe('0.00052');                                                       // 50 / 96000 = 0.000520833…
    expect(D.lte(D.mul(size, D.from('96000')), D.from('50'))).toBe(true);
    expect(D.str(usdToSize(D.from('0.5'), D.from('96000'), D.from('0.00001')))).toBe('0');       // less than one lot: nothing to send
  });
  it('the size is computed again only when the price moved more than 0.5 %', () => {
    expect(drifted(D.from('100'), D.from('100.4'))).toBe(false); expect(drifted(D.from('100'), D.from('99.6'))).toBe(false);
    expect(drifted(D.from('100'), D.from('100.6'))).toBe(true); expect(drifted(D.from('100'), D.from('99.4'))).toBe(true);
    expect(drifted(D.zero, D.from('1'))).toBe(true);
  });
});

describe('quick amounts', () => {
  it('« Max » = 99 % of the smaller of the per-order limit and free collateral × leverage', () => {
    expect(D.str(maxUsd({ orderLimit: '50', freeCollateral: '100', leverage: '2' })!)).toBe('49.5');
    expect(D.str(maxUsd({ orderLimit: '50', freeCollateral: '10', leverage: '2' })!)).toBe('19.8');
    expect(D.str(maxUsd({ orderLimit: '50', freeCollateral: null, leverage: null })!)).toBe('49.5');     // leverage not read yet: the limit alone
    expect(D.str(maxUsd({ orderLimit: null, freeCollateral: '33.337', leverage: '3' })!)).toBe('99.01');  // truncated to the cent, never rounded up
    expect(maxUsd({ orderLimit: null, freeCollateral: null, leverage: null })).toBe(null);
    expect(maxUsd({ orderLimit: '50', freeCollateral: '0', leverage: '2' })).toBe(null);
  });
  it('round figures between the venue minimum and Max, three at most, then Max', () => {
    expect(usdChips(D.from('49.5'), '10')).toEqual([{ usd: '10', max: false }, { usd: '25', max: false }, { usd: '49.5', max: true }]);
    expect(usdChips(D.from('990'), '10').map((c) => c.usd)).toEqual(['100', '250', '500', '990']);
    expect(usdChips(D.from('19.8'), '10').map((c) => c.usd)).toEqual(['10', '19.8']);
    expect(usdChips(D.from('8'), '10')).toEqual([]);                                             // below the venue minimum: nothing is proposed
    expect(usdChips(null, '10')).toEqual([]);
  });
});

describe('estimated liquidation price (Hyperliquid: maintenance margin = half the initial margin at max leverage)', () => {
  const base = { instrument: 'hyperliquid:BTC', size: '1', mark: '100', leverage: '10', venueMaxLeverage: 40, equity: '10', positions: [] as { instrument: string }[] };
  const price = (e: ReturnType<typeof liqEstimate>) => (e.ok && e.price ? Number(D.str(e.price)) : null);
  it('isolated: the venue’s published formula — liq = entry − side × (margin − maintenance) ÷ size ÷ (1 − l × side), l = 1 ÷ (2 × max leverage)', () => {
    const l = 1 / 80, long = 100 - (10 - 100 * l) / (1 - l), short = 100 + (10 - 100 * l) / (1 + l);
    expect(price(liqEstimate({ ...base, side: 'buy', marginMode: 'isolated' }))).toBeCloseTo(long, 9);     // 91.139…
    expect(price(liqEstimate({ ...base, side: 'sell', marginMode: 'isolated' }))).toBeCloseTo(short, 9);   // 108.641…
    expect(long).toBeCloseTo(91.1392405, 6); expect(short).toBeCloseTo(108.6419753, 6);
  });
  it('cross, alone on the account: the equity is the margin; a long the balance covers entirely has no liquidation price', () => {
    const l = 1 / 80;
    expect(price(liqEstimate({ ...base, side: 'buy', marginMode: 'cross' }))).toBeCloseTo(100 - (10 - 100 * l) / (1 - l), 9);
    const covered = liqEstimate({ ...base, side: 'buy', marginMode: 'cross', equity: '150' });
    expect(covered).toEqual({ ok: true, price: null, basis: 'cross' });
    expect(price(liqEstimate({ ...base, side: 'sell', marginMode: 'cross', equity: '150' }))).toBeCloseTo((100 + 150) / (1 + l), 9);
  });
  it('gives no figure when it would mislead: a position already on the asset, other positions in cross, a missing input', () => {
    expect(liqEstimate({ ...base, side: 'buy', marginMode: 'isolated', positions: [{ instrument: 'hyperliquid:BTC' }] })).toEqual({ ok: false, why: 'has_position' });
    expect(liqEstimate({ ...base, side: 'buy', marginMode: 'cross', positions: [{ instrument: 'hyperliquid:ETH' }] })).toEqual({ ok: false, why: 'other_positions' });
    expect(liqEstimate({ ...base, side: 'buy', marginMode: 'isolated', positions: [{ instrument: 'hyperliquid:ETH' }] }).ok).toBe(true);   // isolated: its own margin only
    expect(liqEstimate({ ...base, side: 'buy', marginMode: 'cross', equity: null })).toEqual({ ok: false, why: 'unknown' });
    expect(liqEstimate({ ...base, side: 'buy', marginMode: 'cross', venueMaxLeverage: null })).toEqual({ ok: false, why: 'unknown' });
    expect(liqEstimate({ ...base, side: 'buy', marginMode: 'cross', positions: null })).toEqual({ ok: false, why: 'unknown' });
    expect(liqEstimate({ ...base, side: 'buy', marginMode: 'cross', size: '0' })).toEqual({ ok: false, why: 'unknown' });
  });
});
