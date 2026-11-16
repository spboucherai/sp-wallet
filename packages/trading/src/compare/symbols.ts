/**
 * Symbol normalisation: from a venue's instrument to a common underlying, WITH the contract multiplier.
 *
 *   Hyperliquid `BTC`, dYdX `BTC-USD`, GMX `BTC/USD [BTC-USDC]`, edgeX `BTCUSDC`   →  BTC ×1
 *   Hyperliquid `kPEPE`, edgeX `1000PEPEUSDC`                                      →  PEPE ×1000
 *
 * Nothing here guesses. An instrument is mapped only by one of three rules, each of which is a fact somebody can check:
 *
 *   venue_metadata   the venue's own metadata says what the contract is. Hyperliquid's main perp dex lists crypto assets under
 *                    their ticker (other asset classes live on builder dexes, whose symbols carry a `dex:` prefix and are NOT
 *                    covered by this rule); edgeX publishes a category per contract.
 *   reviewed_ticker  GMX and dYdX publish no category. A base ticker of theirs is mapped only when it is in REVIEWED_TICKERS:
 *                    the list of tickers that, on the snapshot recorded on SYMBOLS_REVIEWED, were active there, named an
 *                    asset that Hyperliquid or edgeX lists as crypto under the same ticker, and were priced within 1 % of it.
 *   reviewed_override  an explicit row of REVIEWED_OVERRIDES — the only way a contract with a multiplier is ever mapped.
 *
 * Everything else stays unmapped, with the reason, and is never compared:
 *   - a multiplier-looking name that nobody reviewed (`kLUNC`, `1000RATS`);
 *   - a ticker that names two asset classes (`SPY` is an ETF contract on edgeX; GMX and dYdX also have a `SPY` and do not say
 *     what it tracks);
 *   - a GMX or dYdX ticker that is not in the reviewed list (new listings wait for a review);
 *   - a builder-dex symbol, a ticker that is not a plain ticker.
 *
 * Equal tickers can still name different assets on two venues that both map by metadata. `priceOutliers` is the runtime guard
 * for that: an instrument whose unit price is far from the median of its group is flagged and left out of any cross-venue
 * estimate — a gap that large is far more likely a mapping or a unit problem than a market fact.
 *
 * Pure: no I/O, no clock.
 */
import { D, type Book, type DecStr, type Instrument, type InstrumentCategory, type Ticker, type VenueId } from '@spw/derivatives';

export const SYMBOLS_REVIEWED = '2026-11-15';

export type UnmappedReason = 'bad_ticker' | 'builder_dex_unreviewed' | 'multiplier_unreviewed' | 'no_category_metadata' | 'ticker_not_reviewed' | 'ticker_in_two_asset_classes';
export type MappingRule = 'venue_metadata' | 'reviewed_ticker' | 'reviewed_override';
export interface InstrumentRef { venue: VenueId; symbol: string; id: string; base: string; category?: InstrumentCategory | undefined }
export interface SymbolMapping {
  instrument: string; venue: VenueId; symbol: string;
  /** common underlying ticker, or null when the instrument is not mapped */
  underlying: string | null;
  category: InstrumentCategory | null;
  /** units of the underlying in ONE unit of the contract's base (kPEPE: 1000). A power of ten. null when unmapped. */
  multiplier: DecStr | null;
  rule: MappingRule | null;
  unmapped: UnmappedReason | null;
  note: string;
}

/**
 * GMX and dYdX base tickers reviewed on SYMBOLS_REVIEWED against the recorded instrument lists and tickers of the four venues
 * (services/api/test/fixtures/markets-hub/, test `symbols.test.ts` re-checks every entry): active on the venue, same ticker
 * listed as crypto by Hyperliquid or edgeX, mark prices within 1 %.
 */
export const REVIEWED_TICKERS: Record<'gmx' | 'dydx', readonly string[]> = {
  gmx: ['0G', 'AAVE', 'ADA', 'AERO', 'AIXBT', 'ALGO', 'ANIME', 'APE', 'APT', 'AR', 'ARB', 'ASTER', 'ATOM', 'AVAX', 'AVNT', 'BCH', 'BERA', 'BNB', 'BTC', 'CAKE', 'CC', 'CRV', 'DASH', 'DOGE', 'DOT', 'DYDX', 'EIGEN', 'ENA', 'ETH',
    'FARTCOIN', 'FET', 'FIL', 'GMX', 'HBAR', 'HYPE', 'ICP', 'INJ', 'JTO', 'JUP', 'KAS', 'LDO', 'LINEA', 'LINK', 'LIT', 'LTC', 'MEGA', 'MET', 'MNT', 'MON', 'MOODENG', 'MORPHO', 'NEAR', 'ONDO', 'OP', 'ORDI', 'PENDLE', 'PENGU', 'POL',
    'PUMP', 'RENDER', 'S', 'SEI', 'SKY', 'SOL', 'STX', 'SUI', 'SYRUP', 'TAO', 'TIA', 'TRUMP', 'TRX', 'UNI', 'VIRTUAL', 'VVV', 'WIF', 'WLD', 'WLFI', 'XLM', 'XMR', 'XPL', 'XRP', 'ZEC', 'ZORA', 'ZRO'],
  dydx: ['AAVE', 'ADA', 'ALGO', 'APT', 'ARB', 'ASTER', 'ATOM', 'AVAX', 'BCH', 'BNB', 'BTC', 'COMP', 'CRV', 'DOGE', 'DOT', 'DYDX', 'EIGEN', 'ETC', 'ETH', 'FIL', 'HBAR', 'HYPE', 'ICP', 'IMX', 'INJ', 'JTO', 'JUP', 'LDO', 'LINK', 'LTC',
    'MON', 'NEAR', 'OP', 'PAXG', 'PENDLE', 'PENGU', 'POL', 'PUMP', 'PYTH', 'RENDER', 'RUNE', 'SEI', 'SOL', 'STRK', 'SUI', 'TAO', 'TIA', 'TRX', 'UNI', 'WLD', 'XLM', 'XMR', 'XRP', 'ZEC'],
};

export interface Override { underlying: string; category: InstrumentCategory; multiplier: DecStr; note: string }
const K = (underlying: string, venue: string): Override => ({ underlying, category: 'crypto', multiplier: '1000', note: `${venue} quotes and sizes this contract per 1 000 ${underlying}` });
const GMX_K = (underlying: string): Override => ({ underlying, category: 'crypto', multiplier: '1', note: `GMX names the market k${underlying} (a display unit) but its oracle price and its sizes are per 1 ${underlying}` });
const PLAIN = (underlying: string): Override => ({ underlying, category: 'crypto', multiplier: '1', note: `dYdX quotes this contract per 1 ${underlying}; Hyperliquid and edgeX list the same asset per 1 000` });
/**
 * Key: `${venue}:${base}` (the adapter's `base`). Reviewed on SYMBOLS_REVIEWED: for each underlying below, the unit prices
 * (mark / multiplier) of every active instrument agreed within 1 % on the recorded tickers (test `symbols.test.ts`).
 */
export const REVIEWED_OVERRIDES: Readonly<Record<string, Override>> = {
  'hyperliquid:kPEPE': K('PEPE', 'Hyperliquid'), 'hyperliquid:kSHIB': K('SHIB', 'Hyperliquid'), 'hyperliquid:kBONK': K('BONK', 'Hyperliquid'), 'hyperliquid:kFLOKI': K('FLOKI', 'Hyperliquid'),
  'edgex:1000PEPE': K('PEPE', 'edgeX'),
  'gmx:kPEPE': GMX_K('PEPE'), 'gmx:kSHIB': GMX_K('SHIB'), 'gmx:kBONK': GMX_K('BONK'), 'gmx:kFLOKI': GMX_K('FLOKI'),
  'dydx:PEPE': PLAIN('PEPE'), 'dydx:BONK': PLAIN('BONK'),
};

const PLAIN_TICKER = /^[A-Z0-9]{1,15}$/;
/** names that announce a multiplier: `kPEPE`, `1000PEPE`, `1MBABYDOGE`, `1000000MOG` */
const MULTIPLIER_NAME = /^(k[A-Z0-9]+|1000[A-Z0-9]+|1M[A-Z0-9]+)$/;
export const looksLikeMultiplier = (base: string): boolean => MULTIPLIER_NAME.test(base);

const unmapped = (i: InstrumentRef, reason: UnmappedReason, note: string): SymbolMapping =>
  ({ instrument: i.id, venue: i.venue, symbol: i.symbol, underlying: null, category: null, multiplier: null, rule: null, unmapped: reason, note });
const mapped = (i: InstrumentRef, underlying: string, category: InstrumentCategory, multiplier: DecStr, rule: MappingRule, note: string): SymbolMapping =>
  ({ instrument: i.id, venue: i.venue, symbol: i.symbol, underlying, category, multiplier, rule, unmapped: null, note });

/**
 * One mapping per instrument, in the order given. The whole snapshot is needed: whether a ticker names two asset classes is
 * decided from what the venues that DO publish a category say in the same snapshot.
 */
export function normaliseSymbols(instruments: readonly InstrumentRef[]): SymbolMapping[] {
  // tickers that venue metadata calls crypto (Hyperliquid main dex, edgeX `crypto`), and those it gives another class (edgeX)
  const crypto = new Set<string>(), other = new Map<string, InstrumentCategory>();
  for (const i of instruments) {
    if (!PLAIN_TICKER.test(i.base) || looksLikeMultiplier(i.base)) continue;
    if (i.venue === 'hyperliquid' && !i.symbol.includes(':')) crypto.add(i.base);
    else if (i.venue === 'edgex' && i.category === 'crypto') crypto.add(i.base);
    else if (i.venue === 'edgex' && i.category !== undefined) other.set(i.base, i.category);
  }
  return instruments.map((i): SymbolMapping => {
    const o = REVIEWED_OVERRIDES[`${i.venue}:${i.base}`];
    if (o) {
      if (i.category !== undefined && i.category !== o.category) return unmapped(i, 'ticker_in_two_asset_classes', `reviewed as ${o.category}, but the venue now says ${i.category}`);
      return mapped(i, o.underlying, o.category, o.multiplier, 'reviewed_override', o.note);
    }
    if (i.venue === 'hyperliquid' && i.symbol.includes(':')) return unmapped(i, 'builder_dex_unreviewed', 'a Hyperliquid builder-dex market: its asset class is not stated by the main dex metadata and it has not been reviewed');
    if (looksLikeMultiplier(i.base)) return unmapped(i, 'multiplier_unreviewed', `the name announces a multiplier (${i.base}); no reviewed row says which asset and how many units`);
    if (!PLAIN_TICKER.test(i.base)) return unmapped(i, 'bad_ticker', 'the base is not a plain ticker');
    if (i.venue === 'hyperliquid') return mapped(i, i.base, 'crypto', '1', 'venue_metadata', 'Hyperliquid main perp dex: crypto assets under their ticker');
    if (i.venue === 'edgex') {
      if (i.category === undefined) return unmapped(i, 'no_category_metadata', 'edgeX published no category for this contract');
      if (i.category !== 'crypto' && crypto.has(i.base)) return unmapped(i, 'ticker_in_two_asset_classes', `edgeX lists ${i.base} as ${i.category}; the same ticker is a crypto asset elsewhere`);
      return mapped(i, i.base, i.category, '1', 'venue_metadata', `edgeX metadata: category ${i.category}`);
    }
    // GMX, dYdX: no category in their metadata
    if (REVIEWED_TICKERS[i.venue].includes(i.base)) return mapped(i, i.base, 'crypto', '1', 'reviewed_ticker', `reviewed on ${SYMBOLS_REVIEWED}: same asset and same price as the crypto asset ${i.base} on Hyperliquid or edgeX`);
    const cls = other.get(i.base);
    if (cls !== undefined) return unmapped(i, 'no_category_metadata', `edgeX lists ${i.base} as ${cls}; this venue does not state what its ${i.base} contract tracks`);
    return unmapped(i, 'ticker_not_reviewed', `not in the list reviewed on ${SYMBOLS_REVIEWED}`);
  });
}

/** underlying → its mapped instruments (unmapped ones are not in any group) */
export function groupByUnderlying(mappings: readonly SymbolMapping[]): Map<string, SymbolMapping[]> {
  const out = new Map<string, SymbolMapping[]>();
  for (const m of mappings) if (m.underlying !== null) { const g = out.get(m.underlying); if (g) g.push(m); else out.set(m.underlying, [m]); }
  return out;
}

const pow10 = (m: DecStr): number => { if (!/^10*$/.test(m)) throw new RangeError(`the multiplier ${m} is not a power of ten`); return m.length - 1; };
/** exact: a power-of-ten multiplier only moves the decimal point */
const down = (x: DecStr, k: number): DecStr => (k === 0 ? x : D.str(D.mul(D.from(x), D.from(`0.${'0'.repeat(k - 1)}1`))));
const up = (x: DecStr, k: number): DecStr => (k === 0 ? x : D.str(D.mul(D.from(x), D.from(`1${'0'.repeat(k)}`))));

/** price of ONE unit of the underlying, from a price of the contract's base unit */
export const unitPrice = (price: DecStr, multiplier: DecStr): DecStr => down(price, pow10(multiplier));

/**
 * The instrument, its book and its ticker restated in units of the underlying: prices ÷ multiplier, sizes × multiplier (so
 * price × size — every USD figure — is unchanged). `base` becomes the underlying. With a multiplier of 1 only `base` changes.
 */
export function toUnderlyingUnits<T extends { instrument: Instrument; book: Book | null; ticker: Ticker | null }>(input: T, m: Pick<SymbolMapping, 'underlying' | 'multiplier'>): T {
  if (m.underlying === null || m.multiplier === null) throw new RangeError('the instrument is not mapped to an underlying');
  const k = pow10(m.multiplier), i = input.instrument;
  const instrument: Instrument = { ...i, base: m.underlying, tickSize: down(i.tickSize, k), lotSize: up(i.lotSize, k), minOrderSize: i.minOrderSize === null ? null : up(i.minOrderSize, k) };
  if (k === 0) return { ...input, instrument };
  const lv = (l: readonly [DecStr, DecStr][]): [DecStr, DecStr][] => l.map(([p, s]) => [down(p, k), up(s, k)]);
  const t = input.ticker, nd = (x: DecStr | null): DecStr | null => (x === null ? null : down(x, k)), nu = (x: DecStr | null): DecStr | null => (x === null ? null : up(x, k));
  return {
    ...input, instrument,
    book: input.book === null ? null : { ...input.book, bids: lv(input.book.bids), asks: lv(input.book.asks) },
    ticker: t === null ? null : { ...t, mark: down(t.mark, k), index: nd(t.index), mid: nd(t.mid), openInterest: nu(t.openInterest), ...(t.last === undefined ? {} : { last: down(t.last, k) }),
      ...(t.volumeBase24h === undefined ? {} : { volumeBase24h: up(t.volumeBase24h, k) }) },
  };
}

export const PRICE_GUARD_BPS = '300';
/**
 * Instruments whose unit price is more than `maxDeviationBps` away from the median of the group. With two instruments the
 * median is their average: a pair that far apart is flagged as a whole (nothing says which one is wrong).
 */
export function priceOutliers(rows: readonly { instrument: string; unitPrice: DecStr }[], maxDeviationBps: DecStr = PRICE_GUARD_BPS): Set<string> {
  const out = new Set<string>();
  const px = rows.map((r) => ({ id: r.instrument, p: D.from(r.unitPrice) })).filter((r) => D.isPos(r.p)).sort((a, b) => D.cmp(a.p, b.p));
  if (px.length < 2) return out;
  const h = px.length >> 1, median = px.length % 2 ? px[h]!.p : D.div(D.add(px[h - 1]!.p, px[h]!.p), D.from(2n), 30, 'half_even');
  const bound = D.mul(median, D.from(maxDeviationBps)), tenK = D.from(10000n);
  for (const r of px) if (D.gt(D.mul(D.abs(D.sub(r.p, median)), tenK), bound)) out.add(r.id);
  return out;
}
