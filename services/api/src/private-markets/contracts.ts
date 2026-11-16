// Private Markets — the REVIEWED CONTRACT TABLE.
//
// A synthetic contract on a private company says nothing by itself about what its price is a price OF. This table is the
// only place where the wallet states it: one entry per `venue:symbol`, written by a person from the operator's own
// documentation, with the URL, the sentence quoted and the date it was read. Nothing here is inferred from a price level, a
// display name or the press. Source of every entry: docs/v11/research/private-markets.md (Appendix A, §2) and
// docs/v11/research/edgex-api.md §2.1, both read 2026-11-15; live fingerprints captured 2026-11-16 00:42 UTC.
//
// Rules enforced by `reviewState` (review.ts → service.ts):
//   · an instrument discovered live but ABSENT from this table   → listed, "contract definition not reviewed", no valuation
//   · an entry past `validUntil`                                   → "definition under review", no valuation
//   · an entry whose live metadata no longer matches `fingerprint` → "definition under review", no valuation
//   · `valuationFormula: null`                                     → no valuation, with `noFormulaReason`
//
// How to review or extend: docs/V11-SYNTHETIC-MARKETS.md, "Reviewing a contract".

export type UnitKind = 'usd_per_share' | 'valuation_usd_billions' | 'unknown';
export interface Quote { url: string; quote: string; readAt: string }
export interface ReviewedContract {
  /** `venue:symbol` — `hyperliquid:xyz:ANT`, `edgex:ANTHROPICUSDC` */
  id: string; venue: 'hyperliquid' | 'edgex';
  /** who operates the market, as shown to the owner */
  platform: string; operator: string;
  company: string;                                    // slug of COMPANIES
  status: 'live' | 'delisted';
  /** exact nature of the contract, in the operator's words where it gives them */
  nature: string;
  unit: { kind: UnitKind; label: string };
  quoteCurrency: string;
  /** `price_x_1e9`: implied fully diluted valuation (USD) = price × 1 000 000 000. null = the operator defines no valuation formula. */
  valuationFormula: 'price_x_1e9' | null;
  /** where the operator defines the unit that makes the formula valid; null when it defines none */
  formulaSource: Quote | null;
  /** why no valuation is derived (required when `valuationFormula` is null) */
  noFormulaReason: string | null;
  /** a convention reported by third parties and NOT confirmed by the operator: displayed as such, never applied */
  unconfirmedConvention: { text: string; url: string } | null;
  /** contract size: USD of notional per contract for 1.00 of price, as the venue's own data defines it */
  multiplier: { value: string; source: string } | null;
  settlement: string; ipoConversion: string; oracle: string; liquidation: string;
  sources: string[];
  reviewedAt: string;
  /** ISO instant after which the entry must be read again (known unit / oracle changes); null for a settled, delisted contract */
  validUntil: string | null; validUntilReason: string | null;
  /** live metadata the review was made against */
  fingerprint: { category: 'preipo' | 'pre_ipo'; szDecimals?: number; annotationSha256?: string; lotSize?: string; collateral: string };
}

export interface Company { slug: string; name: string; note: string | null }
export const COMPANIES: Record<string, Company> = {
  anthropic: { slug: 'anthropic', name: 'Anthropic, PBC', note: 'IPO reported for pricing on 18 Nov 2026 and first trade on 19 Nov 2026 (press; the SEC filing states no date). Every Anthropic contract changes methodology, unit or oracle around that date.' },
  openai: { slug: 'openai', name: 'OpenAI', note: null },
  oura: { slug: 'oura', name: 'Oura Inc.', note: 'IPO postponed on 29 Sep 2026.' },
  polymarket: { slug: 'polymarket', name: 'Polymarket', note: null },
  moonshot: { slug: 'moonshot', name: 'Moonshot AI', note: 'Reference valuation not researched.' },
};

const HL_LINEAR = { value: '1', source: 'Hyperliquid: linear contract of one unit — notional = size × price (position value = szi × mark; dayNtlVlm ÷ dayBaseVlm = price, checked on the live contexts of 2026-11-16)' };
const EDGEX_LINEAR = { value: '1', source: 'edgeX metadata: USDC-margined linear contract — value = price × size (ticker value ÷ size = price, docs/v11/research/edgex-api.md §2.1)' };
const HL_LIQ = 'Hyperliquid margining of the builder dex: liquidation when account or isolated-position equity falls below the maintenance margin (half of the initial margin at maximum leverage); the deployer may halt the market and settle every position at the mark price (HIP-3 haltTrading).';
const TRADE_XYZ = 'https://docs.trade.xyz/perpetuals/markets/pre-ipo-perpetuals', ENTROPY = 'https://docs.entropy.io/market-types/pre-ipo-perpetuals', PARAGON = 'https://docs.paragon.trade/markets/equities/pre-listing-pricing';
const VENTUALS = 'https://docs.ventuals.com/perp-specifications/private-companies';
const EDGEX_TERMS = 'https://edgex-1.gitbook.io/edgeX-documentation/about/terms-of-use';
const EDGEX_NO_SPEC = 'unit not published by the venue: edgeX publishes no contract specification for its pre-IPO perpetuals (no statement of what one contract represents, of the index constituents, or of what happens at an IPO) — searched in its documentation, help center and app on 2026-11-15';
const EDGEX_CONVENTION = { text: 'Unconfirmed convention: press coverage of the centralised-exchange pre-IPO perpetuals that edgeX\'s index tracks says they assume about one billion shares, so that price × 1e9 would approximate a valuation. edgeX itself states nothing; the wallet does not apply it.', url: 'https://cryptobriefing.com/anthropic-pre-ipo-perps-1-8t-valuation/' };
const ANTHROPIC_IPO = '2026-11-18T00:00:00Z', ANTHROPIC_WHY = 'Anthropic\'s IPO is reported for pricing on 18 Nov 2026 and first trade on 19 Nov 2026: oracle, methodology or unit change around it — read the operator\'s documentation and the live annotation again';

const edgex = (symbol: string, company: string, lotSize: string, extra: Partial<ReviewedContract> = {}): ReviewedContract => ({
  id: `edgex:${symbol}`, venue: 'edgex', platform: 'edgeX', operator: 'edgeX', company, status: 'live',
  nature: 'USDC-margined linear perpetual, cash-settled, pure synthetic: no claim on any share (venue metadata; edgeX publishes no specification for it)',
  unit: { kind: 'unknown', label: 'unit not published by the venue' }, quoteCurrency: 'USDC',
  valuationFormula: null, formulaSource: null, noFormulaReason: EDGEX_NO_SPEC, unconfirmedConvention: EDGEX_CONVENTION, multiplier: EDGEX_LINEAR,
  settlement: 'not published by the venue (generic rule: PnL and funding settle in USDC in the venue account; no expiry)',
  ipoConversion: 'not published by the venue',
  oracle: 'not published per instrument: a single oracle signer for stock-type contracts (venue metadata); the general price pages name Binance, OKX, Bybit and Coinbase (index) and Stork or a "Multi-CEX Oracle", without saying which applies',
  liquidation: 'Per-contract risk tiers of the venue metadata (maintenance margin by position value); liquidation fee 1 %; funding every 4 h, capped at ±2 % per interval.',
  sources: ['https://edgex-1.gitbook.io/edgeX-documentation', EDGEX_TERMS], reviewedAt: '2026-11-15',
  validUntil: '2026-12-15T00:00:00Z', validUntilReason: 'periodic review (30 days)',
  fingerprint: { category: 'pre_ipo', lotSize, collateral: 'USDC' }, ...extra,
});

const ventuals = (coin: string, company: string, settled: string, annotationSha256: string): ReviewedContract => ({
  id: `hyperliquid:${coin}`, venue: 'hyperliquid', platform: 'Hyperliquid · Ventuals (dex vntl) — shut down', operator: 'Ventuals', company, status: 'delisted',
  nature: 'cash-settled perpetual, pure synthetic — DELISTED: Ventuals shut down on 15 Jun 2026 and its markets were settled',
  unit: { kind: 'valuation_usd_billions', label: 'USD billions of company valuation (historical)' }, quoteCurrency: 'USD',
  valuationFormula: null, formulaSource: { url: VENTUALS, quote: 'The price of the perp contract is the company valuation divided by 1 billion.', readAt: '2026-11-15' },
  noFormulaReason: 'delisted market: the price is frozen at its last value of June 2026 and is not a current price — no valuation is derived from it',
  unconfirmedConvention: null, multiplier: HL_LINEAR, settlement: settled, ipoConversion: 'not applicable (settled)',
  oracle: 'Was 1/3 Notice price + 2/3 two-hour EMA of the mark (Ventuals documentation).', liquidation: 'not applicable (no open position can exist)',
  sources: [VENTUALS, 'https://docs.ventuals.com/sunset-guide'], reviewedAt: '2026-11-15', validUntil: null, validUntilReason: null,
  fingerprint: { category: 'preipo', szDecimals: 3, annotationSha256, collateral: 'USDH' },
});

export const REVIEWED_CONTRACTS: readonly ReviewedContract[] = [
  {
    id: 'hyperliquid:xyz:ANT', venue: 'hyperliquid', platform: 'Hyperliquid · trade.xyz (dex xyz)', operator: 'trade.xyz (XYZ Ltd)', company: 'anthropic', status: 'live',
    nature: 'cash-settled linear perpetual, pure synthetic, no ownership ("Pre-IPO Perpetuals are not shares. They are not IPO allocations. They are not tokenized equity")',
    unit: { kind: 'usd_per_share', label: 'USD per 1 share of Class A common stock' }, quoteCurrency: 'USD',
    valuationFormula: null,
    formulaSource: { url: TRADE_XYZ, quote: 'ANT references 1 share of Anthropic, PBC Class A common stock (Nasdaq: ANT), quoted in USD. ANT is currently a pre-IPO market reflecting the anticipated share price.', readAt: '2026-11-15' },
    noFormulaReason: 'quoted per share, and the operator publishes no share count: "Any displayed reference share count or implied initial reference market cap is indicative only. It is not guaranteed. It is not a fair value reference." No fully diluted share count is publishable before the 424(b) is filed.',
    unconfirmedConvention: null, multiplier: HL_LINEAR,
    settlement: 'If no IPO: TWAP of the market from launch to the settlement date; a transaction price may be used for an acquisition or take-private, another fair-value price for an adverse event. Anticipated listing date 20 Nov 2026, grace period to 19 Jan 2027.',
    ipoConversion: 'Converts in place to a standard equity perpetual with external pricing (funding multiplier 0.5), typically the first regular session after listing; "the transition from internal to external pricing may produce a step change in mark price".',
    oracle: 'Internal only: "a 30-minute exponentially-weighted moving average which advances via the market\'s impact price difference". No external private-market data. Discovery bounds ±50 %.',
    liquidation: `${HL_LIQ} Cross margin allowed; maximum leverage 10x.`,
    sources: [TRADE_XYZ, 'https://docs.trade.xyz/perpetuals/specifications-and-schedules/pre-ipo-specification-index', 'https://docs.trade.xyz/perpetuals/markets/pre-ipo-perpetuals/alternative-settlement-events'],
    reviewedAt: '2026-11-15', validUntil: ANTHROPIC_IPO, validUntilReason: ANTHROPIC_WHY,
    fingerprint: { category: 'preipo', szDecimals: 2, annotationSha256: '7016b4e060015b7b4bd5f9995d9a362e145b09d6d894b6fd08ecd1d9238846dd', collateral: 'USDC' },
  },
  {
    id: 'hyperliquid:xyz:OURA', venue: 'hyperliquid', platform: 'Hyperliquid · trade.xyz (dex xyz)', operator: 'trade.xyz (XYZ Ltd)', company: 'oura', status: 'live',
    nature: 'cash-settled linear perpetual, pure synthetic, no ownership',
    unit: { kind: 'usd_per_share', label: 'USD per 1 share of common stock' }, quoteCurrency: 'USD',
    valuationFormula: null,
    formulaSource: { url: 'https://docs.trade.xyz/perpetuals/specifications-and-schedules/pre-ipo-specification-index', quote: 'OURA references 1 share of Oura Inc. common stock (Nasdaq: OURA), quoted in USD.', readAt: '2026-11-15' },
    noFormulaReason: 'quoted per share, and the operator publishes no share count; the IPO was postponed on 29 Sep 2026',
    unconfirmedConvention: null, multiplier: HL_LINEAR,
    settlement: 'The anticipated listing date (2 Oct 2026) has passed; the grace period ends on 1 Dec 2026, after which alternative settlement may apply (default: TWAP of the market since launch).',
    ipoConversion: 'Converts to a standard XYZ equity perpetual upon the IPO.',
    oracle: 'Internal only: 30-minute EWMA advanced by the market\'s own impact price. Discovery bounds ±50 %.',
    liquidation: `${HL_LIQ} Isolated margin only (noCross); maximum leverage 5x.`,
    sources: [TRADE_XYZ, 'https://docs.trade.xyz/perpetuals/specifications-and-schedules/pre-ipo-specification-index'],
    reviewedAt: '2026-11-15', validUntil: '2026-12-01T00:00:00Z', validUntilReason: 'the grace period of the market ends on 1 Dec 2026: alternative settlement may apply afterwards',
    fingerprint: { category: 'preipo', szDecimals: 1, annotationSha256: 'ad60c5e0e4a4a90ba6bfee2d677f4194328f01878d68796d2d3f7b650e09154f', collateral: 'USDC' },
  },
  {
    id: 'hyperliquid:io:ANTH', venue: 'hyperliquid', platform: 'Hyperliquid · EntropyIO (dex io)', operator: 'EntropyIO', company: 'anthropic', status: 'live',
    nature: 'cash-settled perpetual quoted in market cap, pure synthetic, no ownership',
    unit: { kind: 'valuation_usd_billions', label: 'USD billions of fully diluted company valuation (1.00 = $1B)' }, quoteCurrency: 'USD',
    valuationFormula: 'price_x_1e9',
    formulaSource: { url: ENTROPY, quote: 'pre-IPO perpetuals are quoted in market cap: a price of $1 represents $1B of the company\'s fully diluted valuation.', readAt: '2026-11-15' },
    noFormulaReason: null, unconfirmedConvention: null, multiplier: HL_LINEAR,
    settlement: 'If unlisted at 18 Aug 2028: cash-settled to the 6-month trailing TWAP of the mark. Early-settlement notice: 30-day TWAP. M&A: the confirmed deal market cap, else 30-day TWAP.',
    ipoConversion: 'Stays a market-cap perpetual: "The oracle switches to Share price × Fully diluted share count ÷ 1,000,000,000 at the first official opening trade." The share count is fixed once from the final prospectus; Entropy\'s estimated multiplier (17.498334025) is pending the 424(b) and is not verified against the filing. Three days before an announced listing the oracle becomes a 1-hour EMA of the mark.',
    oracle: 'Blend of an internal price (5-minute-half-life EMA of the book mid, weight up to 0.95 by executable depth) and an undisclosed aggregate of external sources ("other derivative instruments, private market marking sources, funding rounds, or secondary transactions"), delivered by RedStone; clipped to [300, 4200]. The mark is the internal EMA only.',
    liquidation: `${HL_LIQ} Cross margin allowed; maximum leverage 15x; auto-deleveraging exists.`,
    sources: [ENTROPY, 'https://docs.entropy.io/asset-directory/pre-ipo-assets', 'https://docs.entropy.io/pre-ipo-perp-mechanics/oracle-price', 'https://docs.entropy.io/pre-ipo-perp-mechanics/no-ipo-resolution'],
    reviewedAt: '2026-11-15', validUntil: ANTHROPIC_IPO, validUntilReason: ANTHROPIC_WHY,
    // the on-chain description is EMPTY (sha256 of the empty string): the unit is knowable from Entropy's documentation only
    fingerprint: { category: 'preipo', szDecimals: 3, annotationSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', collateral: 'USDC' },
  },
  {
    id: 'hyperliquid:io:OAI', venue: 'hyperliquid', platform: 'Hyperliquid · EntropyIO (dex io)', operator: 'EntropyIO', company: 'openai', status: 'live',
    nature: 'cash-settled perpetual quoted in market cap, pure synthetic, no ownership',
    unit: { kind: 'valuation_usd_billions', label: 'USD billions of fully diluted company valuation (1.00 = $1B)' }, quoteCurrency: 'USD',
    valuationFormula: 'price_x_1e9',
    formulaSource: { url: ENTROPY, quote: 'pre-IPO perpetuals are quoted in market cap: a price of $1 represents $1B of the company\'s fully diluted valuation.', readAt: '2026-11-15' },
    noFormulaReason: null, unconfirmedConvention: null, multiplier: HL_LINEAR,
    settlement: 'If unlisted at 2 Sep 2028: cash-settled to the 6-month trailing TWAP of the mark. Early-settlement notice: 30-day TWAP. M&A: the confirmed deal market cap, else 30-day TWAP.',
    ipoConversion: 'Stays a market-cap perpetual; at the first official opening trade the oracle switches to share price × fully diluted share count ÷ 1e9 (count fixed once from the final prospectus).',
    oracle: 'Same Entropy blend as io:ANTH (internal EMA of the book mid + undisclosed external aggregate, delivered by RedStone); clipped to [200, 3000].',
    liquidation: `${HL_LIQ} Cross margin allowed; maximum leverage 6x; auto-deleveraging exists.`,
    sources: [ENTROPY, 'https://docs.entropy.io/asset-directory/pre-ipo-assets', 'https://docs.entropy.io/pre-ipo-perp-mechanics/no-ipo-resolution'],
    reviewedAt: '2026-11-15', validUntil: '2026-12-15T00:00:00Z', validUntilReason: 'periodic review (30 days)',
    fingerprint: { category: 'preipo', szDecimals: 3, annotationSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', collateral: 'USDC' },
  },
  {
    id: 'hyperliquid:para:ANTH', venue: 'hyperliquid', platform: 'Hyperliquid · Paragon (dex para)', operator: 'Paragon (Inactionable Inc.)', company: 'anthropic', status: 'live',
    nature: 'cash-settled perpetual, pure synthetic, no ownership',
    unit: { kind: 'usd_per_share', label: 'USD per 1 share (share class not specified by the operator)' }, quoteCurrency: 'USD',
    valuationFormula: null,
    formulaSource: { url: PARAGON, quote: 'Tracks the expected value of one share of Anthropic, PBC ahead of a potential public listing.', readAt: '2026-11-15' },
    noFormulaReason: 'quoted per share, and the operator gives no share count to rely on: "Any displayed share count or implied market capitalization is contextual only. Neither figure is guaranteed."',
    unconfirmedConvention: null, multiplier: HL_LINEAR,
    settlement: 'If no IPO: TWAP from launch to the determination cutoff, unless another method is announced. Listing buffer 60 days.',
    ipoConversion: 'Transitions to the Listed methodology after a qualifying listing; the operator "reserves the right to set the oracle price directly" to the offering price, which "can move the oracle price by a large amount in a single step".',
    oracle: 'Internal: continuous-time EMA of the impact price, τ = 30 min (3 min from 24 h before the first expected public trades). Bounds ±10 %.',
    liquidation: `${HL_LIQ} Strict isolated margin (margin can be added, not removed); maximum leverage 10x.`,
    sources: [PARAGON, 'https://docs.paragon.trade/resources/specifications'],
    reviewedAt: '2026-11-15', validUntil: ANTHROPIC_IPO, validUntilReason: ANTHROPIC_WHY,
    fingerprint: { category: 'preipo', szDecimals: 3, annotationSha256: '8c1923ca24c5ac28ae1d4427eb5bf0e7caa2559e73403e758a0e1f16e4990768', collateral: 'USDC' },
  },
  ventuals('vntl:ANTHROPIC', 'anthropic', 'Settled at the 24 h mark TWAP 1618.90 on 15 Jun 2026 (Ventuals sunset guide).', '6bae37abc5c559a206de9cfc5d3a1e28c4b4a3f7873019c555b54d97b0b02689'),
  ventuals('vntl:OPENAI', 'openai', 'Settled at the 24 h mark TWAP 1341.80 on 15 Jun 2026 (Ventuals sunset guide).', 'fa4c63513f6661bf90ed59b79a49d0289683531ca0a6dd8b3e0b939fd093ff5d'),
  edgex('ANTHROPICUSDC', 'anthropic', '0.01', { validUntil: ANTHROPIC_IPO, validUntilReason: ANTHROPIC_WHY }),
  edgex('POLYMARKETUSDC', 'polymarket', '0.01'),
  edgex('MOONSHOTUSDC', 'moonshot', '0.01'),
];

/**
 * Companies that are PUBLIC today: their contracts are not private markets. A live instrument listed here is left out of the
 * module and reported in `excluded` with the reason. (Dossier §0.3: the deployers converted these from pre-IPO to standard
 * equity perpetuals; `xyz:SPCX` is annotated "Nasdaq: SPCX" and categorised `stocks` — verified live 2026-11-16.)
 */
export const EXCLUDED_PUBLIC: Record<string, { company: string; reason: string }> = {
  'hyperliquid:xyz:SPCX': { company: 'SpaceX', reason: 'SpaceX is a listed company (Nasdaq: SPCX): the deployer annotates this market as a listed stock and categorises it `stocks`. Not a private market.' },
  'hyperliquid:vntl:SPACEX': { company: 'SpaceX', reason: 'SpaceX is a listed company today (Nasdaq: SPCX); this Ventuals market is delisted and its last candle dates from June 2026. Not a private market.' },
  'hyperliquid:xyz:CBRS': { company: 'Cerebras', reason: 'The deployer converted this market from pre-IPO to a standard equity perpetual on the listed security (category `stocks`, read live 2026-11-16; research dossier §0.3). Not a private market.' },
  'hyperliquid:xyz:QNT': { company: 'Quantinuum', reason: 'The deployer converted this market from pre-IPO to a standard equity perpetual on the listed security (category `stocks`, read live 2026-11-16; research dossier §0.3). Not a private market.' },
  'hyperliquid:xyz:JIO': { company: 'Jio Platforms', reason: 'The deployer converted this market from pre-IPO to a standard equity perpetual on the listed security (category `stocks`, read live 2026-11-16; research dossier §0.3). Not a private market.' },
  'hyperliquid:xyz:SKHY': { company: 'SK hynix', reason: 'References SK hynix ADS, a listed security: standard equity perpetual (category `stocks`, read live 2026-11-16; research dossier §0.3). Not a private market.' },
};

/** venues that list private-company perpetuals but for which the wallet has NO adapter: documented, never served live */
export const VENUES_WITHOUT_ADAPTER = [
  { venue: 'Aster', note: 'ANTHROPICUSDT, OPENAIUSDT, POLYMARKETUSD1, OURAUSD1, MOONSHOTUSD1 — per share against a notional reference count of 1 billion shares' },
  { venue: 'Lighter', note: 'ANTHROPIC, OPENAI, OURA — unit not found in the operator\'s documentation' },
  { venue: 'Polymarket Perps', note: 'ANT-USD — USD billions until its rebase of 16 Nov 2026 (~10:00 ET), USD per share afterwards' },
] as const;

const BY_ID = new Map(REVIEWED_CONTRACTS.map((c) => [c.id, c]));
export const reviewedContract = (id: string): ReviewedContract | null => BY_ID.get(id) ?? null;

// ------------------------------------------------------------------------------------------------------------------ review state
/** contract size per venue, from the venue's own data — applies to every instrument of the venue, reviewed or not */
export const VENUE_MULTIPLIER: Record<'hyperliquid' | 'edgex', { value: string; source: string }> = { hyperliquid: HL_LINEAR, edgex: EDGEX_LINEAR };

/** what the venue says about the instrument NOW; `undefined` = the venue does not publish that field for this instrument */
export interface LiveFingerprint {
  /** normalised live category: `preipo` (Hyperliquid) / `pre_ipo` (edgeX), or whatever the venue says now; null = not categorised */
  category: string | null;
  szDecimals?: number; lotSize?: string; collateral: string;
  /** sha256 of the on-chain description; null = the venue answered `null` for the annotation (unknown) */
  annotationSha256?: string | null;
}
export type ReviewStateCode = 'reviewed' | 'under_review' | 'not_reviewed';
export interface ReviewState { state: ReviewStateCode; reasons: string[]; reviewedAt: string | null; validUntil: string | null }

export const NOT_REVIEWED = 'contract definition not reviewed — no valuation: the instrument is categorised pre-IPO by the venue but is absent from the reviewed contract table, so the wallet does not state what its price is a price of';

/**
 * `reviewed` only when the entry exists, is within its validity and its fingerprint matches the live metadata.
 * Everything else gives NO valuation.
 */
export function reviewState(c: ReviewedContract | null, live: LiveFingerprint, now: number): ReviewState {
  if (!c) return { state: 'not_reviewed', reasons: [NOT_REVIEWED], reviewedAt: null, validUntil: null };
  const reasons: string[] = [], f = c.fingerprint;
  if (c.validUntil !== null && now >= Date.parse(c.validUntil)) reasons.push(`the review of ${c.reviewedAt} was valid until ${c.validUntil}: ${c.validUntilReason ?? 'to be read again'}`);
  if (live.category !== f.category) reasons.push(`the venue no longer categorises this market as pre-IPO (reviewed: ${f.category}; now: ${live.category ?? 'no category'})`);
  if (f.szDecimals !== undefined && live.szDecimals !== f.szDecimals) reasons.push(`size decimals changed (reviewed: ${f.szDecimals}; now: ${live.szDecimals ?? 'not published'}): the contract may have been rebased`);
  if (f.lotSize !== undefined && live.lotSize !== f.lotSize) reasons.push(`lot size changed (reviewed: ${f.lotSize}; now: ${live.lotSize ?? 'not published'}): the contract may have been rebased`);
  if (live.collateral !== f.collateral) reasons.push(`collateral changed (reviewed: ${f.collateral}; now: ${live.collateral})`);
  if (f.annotationSha256 !== undefined) {
    if (live.annotationSha256 === null || live.annotationSha256 === undefined) reasons.push('the on-chain annotation could not be read (the venue answered null): the reviewed definition cannot be confirmed');
    else if (live.annotationSha256 !== f.annotationSha256) reasons.push('the on-chain description of the market changed since the review');
  }
  return { state: reasons.length ? 'under_review' : 'reviewed', reasons, reviewedAt: c.reviewedAt, validUntil: c.validUntil };
}
