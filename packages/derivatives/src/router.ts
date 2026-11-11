/**
 * Universal derivatives router — SIMULATION ONLY (docs/v4/ROUTER.md). Pure: no network, no clock, no state, exact decimals (`D`).
 *
 * For one order intent on a base asset and one snapshot per venue instrument, it answers, per instrument:
 *   - may this order be placed there at all (eligibility, with the reasons when not);
 *   - what the fill would look like (order book: the book is walked level by level; GMX: oracle price, price impact from the
 *     contracts' formula with the market's current parameters, capped);
 *   - every cost, itemised, each with its inputs and where each input comes from;
 *   - margin, maintenance rule, estimated liquidation price (margin.ts);
 *   - the contract terms side by side, and the list of material differences.
 * Then a ranking by all-in cost. The ranking is INFORMATION: nothing is selected, nothing is sent, and two contracts are never
 * called the same (principle 6 of DERIVATIVES-ARCHITECTURE.md).
 *
 * Sources (principle 5). `venue`: read from the venue in the snapshot. `constant`: a documented fact pinned here with its date
 * and its page (fee schedule, deposit rule). `estimate`: computed here. Every COST is an estimate — a simulated fill is not a
 * fill; what is tagged `venue` or `constant` is its inputs.
 *
 * Rounding: products and sums are exact; divisions state their scale. Outputs are rounded half-even to USD_DP decimals (USD),
 * BPS_DP (basis points), PRICE_DP (prices). The non-integer power of the GMX impact formula is computed to 30 decimals (the
 * contracts use an 18-decimal fixed-point power; the difference is far below a cent on any size the pools accept).
 */
import { z } from 'zod';
import { D, type Dec, type DecStr } from './decimal.ts';
import { initialMargin, liquidationPriceIsolated } from './margin.ts';
import { DecStrSchema, SideSchema, type Book, type Instrument, type Side, type Ticker, type VenueId } from './models.ts';
import type { GmxLiquidity } from './venues/gmx/adapter.ts';

export const USD_DP = 6, BPS_DP = 4, PRICE_DP = 10, CALC_DP = 30;
const BPS = D.from(10000n), TWO = D.from(2n), HUNDRED = D.from(100n), HOUR = D.from(3600n);
const q = (x: Dec, dp: number): Dec => D.div(x, D.one, dp, 'half_even');
const usdS = (x: Dec): DecStr => D.str(q(x, USD_DP));
const bpsS = (x: Dec): DecStr => D.str(q(x, BPS_DP));
const pxS = (x: Dec): DecStr => D.str(q(x, PRICE_DP));

// ------------------------------------------------------------------------------------------------------------------ intent

const NonNeg = DecStrSchema.refine((x) => !x.startsWith('-'), 'must not be negative');
const Pos = NonNeg.refine((x) => /[1-9]/.test(x), 'must be positive');
export const MAX_HORIZON_HOURS = 8760;
export const OrderIntentSchema = z.strictObject({
  base: z.string().regex(/^[A-Za-z0-9]{1,15}$/),
  /** side of the EXPOSURE: `long` opens a long (a buy); with `reduceOnly` it reduces an existing long (a sell) */
  side: SideSchema,
  /** exactly one of the two: a quantity of the base asset, or a USD notional */
  sizeBase: Pos.optional(), notionalUsd: Pos.optional(),
  leverage: Pos,
  type: z.enum(['market', 'limit']),
  /** limit price; must be null for a market order */
  price: Pos.nullable().default(null),
  reduceOnly: z.boolean().default(false),
  /** expected holding period, for funding and borrowing; 0 = entry costs only */
  horizonHours: NonNeg.refine((x) => D.isValid(x) && D.lte(D.from(x), D.from(BigInt(MAX_HORIZON_HOURS))), `at most ${MAX_HORIZON_HOURS} hours`).default('24'),
}).refine((i) => (i.sizeBase === undefined) !== (i.notionalUsd === undefined), { message: 'give exactly one of sizeBase and notionalUsd', path: ['sizeBase'] })
  .refine((i) => (i.type === 'limit') === (i.price !== null), { message: 'a limit order needs a price; a market order takes none', path: ['price'] });
export type OrderIntent = z.infer<typeof OrderIntentSchema>;

// ------------------------------------------------------------------------------------------------------------------ facts

export type RouterSource = 'venue' | 'constant' | 'estimate';
export const ROUTER_FACTS_CHECKED = '2026-11-10';

/** documented facts the router needs and no adapter carries; each with its page. Checked on ROUTER_FACTS_CHECKED (docs/v4/venues/). */
export interface VenueRouterFacts {
  name: string; orderBook: boolean;
  /** base fee tier, fractions of notional; null when the venue has no maker/taker schedule (GMX: read from the market) */
  takerRate: DecStr | null; makerRate: DecStr | null; feeSource: string;
  /** maintenance margin as a fraction of notional; 'half_initial_at_max' = 1 / (2 · max leverage) */
  maintenance: 'half_initial_at_max' | 'gmx_min_collateral' | DecStr | null; maintenanceText: string;
  integerLeverage: boolean;
  terms: Record<'structure' | 'execution' | 'quote' | 'fundingRule' | 'otherCarry' | 'sizeUnit' | 'liquidation' | 'fees', string>;
  /** what moving collateral there takes (facts, not a quote) */
  collateral: { asset: string; route: string; fixedCostUsd: DecStr | null; needsArbitrumTransfer: boolean; needsArbitrumRequest: boolean; source: string };
}
export const ROUTER_FACTS: Record<VenueId, VenueRouterFacts> = {
  hyperliquid: {
    name: 'Hyperliquid', orderBook: true, takerRate: '0.00045', makerRate: '0.00015',
    feeSource: 'base tier of the perps fee schedule (taker 0.045 %, maker 0.015 %); 14-day volume tiers and staking discounts lower it — https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees',
    maintenance: 'half_initial_at_max', maintenanceText: 'half of the initial margin at the maximum leverage (1 / (2 × max leverage) of notional); tiered by position size — https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margining',
    integerLeverage: true,
    terms: {
      structure: 'on-chain central limit order book',
      execution: 'immediate match against the book',
      quote: 'USDT-denominated oracle, USDC collateral, no conversion (quanto: USDT PnL paid in USDC)',
      fundingRule: 'paid every hour, peer to peer, on size × oracle price × rate; the hourly rate is 1/8 of an 8 h rate; cap 0.5 % per hour',
      otherCarry: 'none',
      sizeUnit: 'base asset, lot 10^-szDecimals',
      liquidation: 'on the mark price, through the book, then the liquidator vault (maintenance margin not returned in a backstop); no separate fee',
      fees: 'taker / maker on notional, 14-day volume tiers',
    },
    collateral: { asset: 'USDC', route: 'native USDC sent from the account address on Arbitrum One to the venue bridge (legacy route; Circle CCTP is now the venue\'s preferred one). Minimum 5 USDC — a smaller deposit is lost. No deposit fee documented; a later withdrawal costs 1 USDC.',
      fixedCostUsd: '0', needsArbitrumTransfer: true, needsArbitrumRequest: false, source: 'docs/v4/venues/hyperliquid.md §8, §14 — https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/bridge2' },
  },
  dydx: {
    name: 'dYdX v4', orderBook: true, takerRate: '0.0005', makerRate: '0.0001',
    feeSource: 'base tier (taker 0.05 %, maker 0.01 %) — https://docs.dydx.xyz/concepts/trading/rewards',
    maintenance: null, maintenanceText: 'maintenance margin fraction per market (1.2 % for BTC and ETH), on the oracle price — https://docs.dydx.xyz/concepts/trading/margin',
    integerLeverage: false,
    terms: {
      structure: 'on-chain order book; short-term orders live in validator memory',
      execution: 'immediate match (block time about 1 s)',
      quote: 'USD oracle; PnL and funding in USDC',
      fundingRule: 'paid every hour on size × oracle price × rate; rate = premium / 8 + interest',
      otherCarry: 'none',
      sizeUnit: 'base asset, lot per market',
      liquidation: 'on the oracle price; penalty up to 1.5 % to the insurance fund',
      fees: 'taker / maker on notional, 30-day volume tiers',
    },
    collateral: { asset: 'USDC (Noble USDC over IBC)', route: 'not offered: the venue is restricted for the owner', fixedCostUsd: null, needsArbitrumTransfer: false, needsArbitrumRequest: false, source: 'docs/v4/venues/dydx.md' },
  },
  gmx: {
    name: 'GMX v2 (Arbitrum)', orderBook: false, takerRate: null, makerRate: null,
    feeSource: 'position fee factors of the market, read from the venue (GET /markets/config) — https://docs.gmx.io/docs/trading/fees/',
    maintenance: 'gmx_min_collateral', maintenanceText: 'remaining collateral (after PnL, fees and capped negative impact) must stay above max($1, minCollateralFactorForLiquidation × size) — https://docs.gmx.io/docs/trading/liquidations/',
    integerLeverage: false,
    terms: {
      structure: 'no order book: oracle-priced trades against a GM liquidity pool; one instrument per pool',
      execution: 'two transactions: a request, then a keeper executes at a later signed oracle price; the order can be cancelled or frozen instead',
      quote: 'PnL computed in USD, paid in the pool token of the side',
      fundingRule: 'accrues per second (quoted per hour), adaptive to the long/short imbalance; settled at each position change; positive funding must be claimed',
      otherCarry: 'borrowing fee, paid by the larger open-interest side only',
      sizeUnit: 'USD (30 decimals); the token size results from the execution price',
      liquidation: 'on the signed oracle min/max; liquidation fee 0.20–0.45 % of size; remaining collateral returned',
      fees: 'position fee on size: lower factor if the trade improves the long/short balance; price impact settled at close; execution fee in ETH; Arbitrum gas',
    },
    collateral: { asset: 'the pool\'s long or short token', route: 'no venue account: the collateral must be in the wallet on Arbitrum One (USDC or the pool token) and approved once to the GMX Router; getting it to Arbitrum from elsewhere depends on where the funds are',
      fixedCostUsd: null, needsArbitrumTransfer: false, needsArbitrumRequest: true, source: 'docs/v4/venues/gmx.md Part B §3–§4 — https://docs.gmx.io/docs/trading/overview/' },
  },
};

/**
 * Gas units assumed for the two Arbitrum transactions the router prices — MEASURED samples, not venue figures
 * (scripts/sim-deriv-router.mts prints fresh receipts; docs/v4/ROUTER.md records the measurement).
 */
export const ARBITRUM_GAS_UNITS = {
  /** GMX market-increase request sent to ExchangeRouter (Classic): 10 receipts of 2026-11-11, 833 133 – 1 740 858 gas, median 937 922 */
  gmxCreateOrder: '1000000',
  /** plain native-USDC transfer: 13 receipts of 2026-11-11 over three runs, 40 343 – 62 289 gas, median about 40 400 (the upper end is used) */
  erc20Transfer: '62000',
} as const;
/** half-widths used for "near tie" — conventions, stated as such (docs/v4/ROUTER.md, "Uncertainty") */
export const UNCERTAINTY = { priceImpactFraction: '1', executionFeeFraction: '0.5', gasFraction: '0.5', carryFractionWithoutHistory: '1' } as const;
/** a snapshot older than this (ms) is refused: the router does not estimate on stale data */
export const ROUTER_MAX_AGE_MS = { ticker: 15_000, book: 15_000, liquidity: 30_000 } as const;

// ------------------------------------------------------------------------------------------------------------------ snapshots

export interface RouterAccount { id: string; label: string; kind: 'paper' | 'venue'; mode: string; equity: DecStr; freeCollateral: DecStr }
export interface ChainCosts {
  /** Arbitrum gas price in ETH per unit of gas (wei / 1e18), and the ETH price used for the conversion, both from the snapshot */
  gasPriceEth: DecStr | null; ethUsd: DecStr | null; ethUsdSource: string;
  /** GMX: minimum execution fee the contracts require for a market increase at this gas price, in ETH (GasUtils formula on DataStore values), or null */
  gmxExecutionFeeEth: DecStr | null; gmxExecutionFeeNote: string;
  ts: number;
}
export interface VenueSnapshot {
  venue: VenueId;
  /** non-null: the venue is restricted for the owner — never a candidate */
  restriction: string | null;
  /** what this wallet can do on the venue today */
  wallet: { trading: 'paper' | 'live' | 'none'; note: string };
  instrument: Instrument; ticker: Ticker;
  /** order-book venues; `bookLevels` = levels per side the snapshot was cut at (to say "the snapshot ends") */
  book: Book | null;
  /** GMX */
  gmx: GmxLiquidity | null;
  /** last hours of the hourly funding rate (what longs pay), when the caller has them */
  fundingRange: { minPerHour: DecStr; maxPerHour: DecStr; hours: number } | null;
  chain: ChainCosts | null;
  account: RouterAccount | null;
  /** the caller could not read the book / liquidity of this instrument: the reason (the instrument is then not estimated) */
  unavailable?: string | null;
}

// ------------------------------------------------------------------------------------------------------------------ results

export interface Input { name: string; value: DecStr | string | null; source: RouterSource }
export type CostId = 'spread_slippage' | 'trading_fee' | 'price_impact' | 'execution_fee' | 'network_gas' | 'funding' | 'borrow' | 'collateral_transfer';
export interface CostComponent {
  id: CostId;
  /** positive = a cost, negative = an income; null = unknown (then it is NOT in the total, and the total says so) */
  usd: DecStr | null; bps: DecStr | null;
  source: 'estimate';
  inputs: Input[];
  basis: string;
  /** half-width used for ties, USD; and what could move it */
  uncertaintyUsd: DecStr; uncertainty: string;
  /** when it is paid */
  timing: 'at_fill' | 'over_horizon' | 'at_close' | 'before_trading';
}
export interface FillSimulation {
  method: 'order_book_walk' | 'gmx_oracle_impact';
  /** reference price the slippage is measured from: book mid, or oracle mid */
  referencePrice: DecStr; referenceSource: RouterSource;
  filledBase: DecStr; filledUsd: DecStr;
  avgPrice: DecStr | null; worstPrice: DecStr | null; slippageBps: DecStr | null;
  /** order book */
  levelsConsumed: number | null; depthConsumedPct: DecStr | null; snapshotLevels: number | null;
  /** part of the size the snapshot could not fill, and why */
  unfilledBase: DecStr; unfilledReason: 'none' | 'book_snapshot_ends' | 'limit_price' | 'not_marketable';
  /** part of a limit order that would rest on the book (not a fill) */
  restingBase: DecStr;
  /** GMX */
  gmx: null | {
    oracleMin: DecStr; oracleMax: DecStr; executionBasePrice: DecStr;
    impactUsd: DecStr; impactCappedUsd: DecStr; capPositiveUsd: DecStr; capNegativeUsd: DecStr; capped: boolean;
    balanceWasImproved: boolean; crossover: boolean; imbalanceBeforeUsd: DecStr; imbalanceAfterUsd: DecStr; openInterestBasis: 'tokens × oracle mid' | 'USD cost basis';
    /** 'none': the market has no virtual inventory; 'known': it was read and applied; 'unknown': it exists and could not be read */
    virtualInventory: 'none' | 'known' | 'unknown'; fromVirtualInventory: boolean;
    verification: string;
  };
  source: 'estimate'; notes: string[];
}
export interface MarginEstimate {
  notionalUsd: DecStr; leverage: DecStr; initialMarginUsd: DecStr;
  maintenanceFraction: DecStr | null; maintenanceRule: string; maintenanceSource: RouterSource;
  liquidationPrice: { value: DecStr | null; source: 'estimate'; method: string }; liquidationDistanceBps: DecStr | null;
}
export type ReasonKind = 'blocker' | 'setup' | 'note';
export interface Reason { code: string; kind: ReasonKind; message: string }
export type TermKey = 'structure' | 'execution' | 'collateral' | 'settlement' | 'quote' | 'markPrice' | 'fundingInterval' | 'fundingRule' | 'otherCarry' | 'maxLeverage' | 'marginModes'
  | 'tick' | 'lot' | 'sizeUnit' | 'minOrder' | 'maintenance' | 'liquidation' | 'fees';
export const TERM_KEYS: TermKey[] = ['structure', 'execution', 'collateral', 'settlement', 'quote', 'markPrice', 'fundingInterval', 'fundingRule', 'otherCarry', 'maxLeverage', 'marginModes',
  'tick', 'lot', 'sizeUnit', 'minOrder', 'maintenance', 'liquidation', 'fees'];
export type ContractTerms = Record<TermKey, { value: string; source: RouterSource }>;

export interface ExecutionEstimate {
  venue: VenueId; venueName: string; instrument: string; symbol: string;
  eligibility: {
    /** false: a blocker applies — the instrument is not ranked */
    eligible: boolean;
    /** true only when the wallet could place this order there today, in the mode stated (`paper` or `live`) */
    executableNow: boolean; executableAs: 'paper' | 'live' | null;
    reasons: Reason[];
  };
  order: null | { side: 'buy' | 'sell'; positionSide: Side; reduceOnly: boolean; type: 'market' | 'limit'; limitPrice: DecStr | null;
    sizeUnit: 'base' | 'usd'; sizeBase: DecStr; sizeUsd: DecStr; requested: string; rounding: string | null };
  fill: FillSimulation | null;
  costs: CostComponent[];
  margin: MarginEstimate | null;
  terms: ContractTerms;
  /** all-in cost of THIS order over the horizon: entry costs + carry. Unknown components are listed, not guessed. */
  allIn: null | { usd: DecStr; bps: DecStr; uncertaintyUsd: DecStr; included: CostId[]; unknown: CostId[]; horizonHours: DecStr; complete: boolean; note: string };
  /** closing the same size right away under the same snapshot — information, not part of the all-in cost */
  exit: null | { usd: DecStr; bps: DecStr; /** all-in + exit */ roundTripUsd: DecStr; roundTripBps: DecStr; parts: { id: CostId; usd: DecStr; basis: string }[]; note: string };
  data: { tickerAgeMs: number; depthAgeMs: number | null };
  source: 'estimate'; ts: number;
}
export interface RankingRow { rank: number; instrument: string; venue: VenueId; allInUsd: DecStr; allInBps: DecStr; uncertaintyUsd: DecStr; complete: boolean; executableNow: boolean;
  tiedWith: string[]; nearTieWith: string[];
  /** all-in + an immediate close under the same snapshot, and the place this instrument would take on that figure (null: no exit estimate) */
  roundTripUsd: DecStr | null; roundTripRank: number | null }
export interface Ranking {
  rows: RankingRow[];
  /** always null: the router never selects a venue */
  selected: null;
  basis: string; note: string;
  /** true when ordering by the round trip (entry + carry + immediate close) gives another order than the all-in cost */
  orderChangesWithExit: boolean;
  excluded: { instrument: string; venue: VenueId; reasons: string[] }[];
}
export interface Difference { field: TermKey; values: { instrument: string; venue: VenueId; value: string; source: RouterSource }[] }
export interface Differences {
  /** always false: two perpetuals on the same asset are never the same contract */
  interchangeable: false;
  statement: string; fields: Difference[]; never: string[];
}
export interface RouteResult { intent: OrderIntent; candidates: ExecutionEstimate[]; ranking: Ranking; differences: Differences; warnings: string[]; ts: number; source: 'estimate' }

// ------------------------------------------------------------------------------------------------------------------ exact power

const PW = 50, ONE_W = 10n ** BigInt(PW);
const mulW = (a: bigint, b: bigint): bigint => (a * b) / ONE_W;
/** ln of a positive fixed-point number (scale 10^PW): range reduction by powers of two, then 2·atanh((x−1)/(x+1)) */
function lnW(x: bigint): bigint {
  if (x <= 0n) throw new RangeError('ln of a non-positive number');
  let k = 0n;
  while (x > (ONE_W * 3n) / 2n) { x /= 2n; k += 1n; }
  while (x < (ONE_W * 3n) / 4n) { x *= 2n; k -= 1n; }
  return atanh2((x - ONE_W) * ONE_W / (x + ONE_W)) + k * LN2();
}
function atanh2(z: bigint): bigint {
  const z2 = mulW(z, z);
  let term = z, sum = z;
  for (let n = 3n; n < 400n; n += 2n) { term = mulW(term, z2); const t = term / n; if (t === 0n) break; sum += t; }
  return 2n * sum;
}
let ln2: bigint | null = null;
const LN2 = (): bigint => (ln2 ??= atanh2(ONE_W / 3n));
function expW(y: bigint): bigint {
  const l2 = LN2();
  let k = y / l2; let r = y - k * l2;
  if (r > l2 / 2n) { r -= l2; k += 1n; } else if (r < -l2 / 2n) { r += l2; k -= 1n; }
  let term = ONE_W, sum = ONE_W;
  for (let n = 1n; n < 200n; n += 1n) { term = mulW(term, r) / n; if (term === 0n) break; sum += term; }
  return k >= 0n ? sum << k : sum >> -k;
}
/**
 * x^e for x > 0, rounded half-even to CALC_DP decimals. An integer exponent up to 8 is multiplied out exactly; otherwise
 * exp(e · ln x) on 50-digit fixed point (error far below the 30th decimal for the magnitudes used here: x ≤ 10^15, e ≤ 4).
 */
export function powDec(x: Dec, e: Dec): Dec {
  if (!D.isPos(x)) throw new RangeError('powDec needs a positive base');
  if (D.isNeg(e)) throw new RangeError('powDec needs a non-negative exponent');
  if (e.s === 0 && e.m <= 8n) { let r = D.one; for (let i = 0n; i < e.m; i += 1n) r = D.mul(r, x); return r; }
  // `D.div` normalises its result (trailing zeros stripped): bring the mantissa back to the working scale
  const toW = (v: Dec): bigint => { const r = D.div(v, D.one, PW, 'half_even'); return r.m * 10n ** BigInt(PW - r.s); };
  const fx = toW(x), fe = toW(e);
  return q({ m: expW(mulW(fe, lnW(fx))), s: PW }, CALC_DP);
}

// ------------------------------------------------------------------------------------------------------------------ GMX price impact

export interface GmxImpactInput {
  /** open interest per side as the contracts measure the balance (tokens × price when the market says so), USD */
  longOi: Dec; shortOi: Dec;
  /** USD moved on the side's open interest. For a DECREASE on a tokens-based market this is the position's tokens × the current price, not its cost basis. */
  sizeDeltaUsd: Dec; isLong: boolean; increase: boolean;
  factorPositive: Dec; factorNegative: Dec; exponentPositive: Dec; exponentNegative: Dec;
  /** virtual inventory of the index token in USD, contract sign (negative = traders net long); null/undefined = the market has none, or it is unknown */
  virtualInventoryUsd?: Dec | null;
}
export interface GmxImpact { impactUsd: Dec; balanceWasImproved: boolean; crossover: boolean; initialDiffUsd: Dec; nextDiffUsd: Dec;
  /** the figure comes from the virtual inventory (it was worse than the market's own) */ fromVirtualInventory: boolean; marketImpactUsd: Dec }
/** `Precision.applyExponentFactor` then `applyFactor`: a difference below 1 USD contributes nothing */
function applyImpactFactor(diffUsd: Dec, factor: Dec, exponent: Dec): Dec {
  if (D.lt(diffUsd, D.one)) return D.zero;
  return D.mul(powDec(diffUsd, exponent), factor);
}
/**
 * Position price impact of GMX v2, in USD (positive = in favour of the trader), before any cap.
 * Source: gmx-synthetics `PositionPricingUtils.getPriceImpactUsd` / `_getPriceImpactUsd` and `PricingUtils`
 * (https://github.com/gmx-io/gmx-synthetics/blob/updates/contracts/pricing/PositionPricingUtils.sol , PricingUtils.sol),
 * documented as "(initial USD difference)^exponent × factor − (next USD difference)^exponent × factor"
 * (https://docs.gmx.io/docs/trading/fees/). Same-side move: one factor (positive when the imbalance shrinks). Crossing the
 * balance point: the initial difference is credited at the positive factor, the next one charged at the negative factor.
 * The positive factor is never above the negative one (`getAdjustedPositionImpactFactor`).
 * Virtual inventory (`getNextOpenInterestForVirtualInventory`): when the market's own impact is NEGATIVE and the index token has
 * a virtual inventory, the impact is computed a second time on that inventory (one side only: long when it is negative, short
 * when positive; both sides shifted by the size for a decrease) and the WORSE of the two applies.
 * NOT modelled: the impact pool balance (it can only cut a positive impact).
 */
export function gmxPriceImpact(i: GmxImpactInput): GmxImpact {
  const own = impactOn(i, i.longOi, i.shortOi);
  const base = { ...own, fromVirtualInventory: false, marketImpactUsd: own.impactUsd };
  if (!D.isNeg(own.impactUsd) || i.virtualInventoryUsd === null || i.virtualInventoryUsd === undefined) return base;
  let vLong = D.isPos(i.virtualInventoryUsd) ? D.zero : D.neg(i.virtualInventoryUsd), vShort = D.isPos(i.virtualInventoryUsd) ? i.virtualInventoryUsd : D.zero;
  if (!i.increase) { vLong = D.add(vLong, i.sizeDeltaUsd); vShort = D.add(vShort, i.sizeDeltaUsd); }
  const virt = impactOn(i, vLong, vShort);
  // the market's own imbalance decides the fee tier (balanceWasImproved); only the amount comes from the virtual inventory
  return D.lt(virt.impactUsd, own.impactUsd) ? { ...base, impactUsd: virt.impactUsd, fromVirtualInventory: true } : base;
}
function impactOn(i: GmxImpactInput, longOi: Dec, shortOi: Dec): Omit<GmxImpact, 'fromVirtualInventory' | 'marketImpactUsd'> {
  const delta = i.increase ? i.sizeDeltaUsd : D.neg(i.sizeDeltaUsd);
  const zero = (x: Dec): Dec => (D.isNeg(x) ? D.zero : x);
  const nextLong = i.isLong ? zero(D.add(longOi, delta)) : longOi, nextShort = i.isLong ? shortOi : zero(D.add(shortOi, delta));
  const d0 = D.abs(D.sub(longOi, shortOi)), d1 = D.abs(D.sub(nextLong, nextShort));
  const sameSide = D.lte(longOi, shortOi) === D.lte(nextLong, nextShort);
  const improved = D.lt(d1, d0), fPos = D.min(i.factorPositive, i.factorNegative);
  if (sameSide) {
    const f = improved ? fPos : i.factorNegative, e = improved ? i.exponentPositive : i.exponentNegative;
    const diff = D.abs(D.sub(applyImpactFactor(d0, f, e), applyImpactFactor(d1, f, e)));
    return { impactUsd: improved ? diff : D.neg(diff), balanceWasImproved: improved, crossover: false, initialDiffUsd: d0, nextDiffUsd: d1 };
  }
  const pos = applyImpactFactor(d0, fPos, i.exponentPositive), neg = applyImpactFactor(d1, i.factorNegative, i.exponentNegative);
  return { impactUsd: D.sub(pos, neg), balanceWasImproved: improved, crossover: true, initialDiffUsd: d0, nextDiffUsd: d1 };
}
/**
 * Open interest per side as the market measures its balance, and the virtual inventory in the same unit.
 * `virtual`: 'none' = the market has no virtual inventory; 'known' = `virtualUsd` is its value; 'unknown' = it has one (or does
 * not say) and the value could not be read — a negative impact may then be WORSE than the formula says.
 */
export function gmxBalanceOi(l: GmxLiquidity): { long: Dec; short: Dec; basis: 'tokens × oracle mid' | 'USD cost basis'; virtual: 'none' | 'known' | 'unknown'; virtualUsd: Dec | null } {
  const tokens = l.useOpenInterestInTokensForBalance === true, v = l.virtualInventory;
  const mid = D.div(D.add(D.from(l.oracleMin), D.from(l.oracleMax)), TWO, CALC_DP, 'half_even');
  const raw = tokens ? v.tokens : v.usd;
  const virtual = v.applies === false ? 'none' as const : raw === null || v.applies === null ? 'unknown' as const : 'known' as const;
  const virtualUsd = virtual !== 'known' ? null : tokens ? D.mul(D.from(raw!), mid) : D.from(raw!);
  return tokens ? { long: D.mul(D.from(l.openInterestLongTokens), mid), short: D.mul(D.from(l.openInterestShortTokens), mid), basis: 'tokens × oracle mid', virtual, virtualUsd }
    : { long: D.from(l.openInterestLongUsd), short: D.from(l.openInterestShortUsd), basis: 'USD cost basis', virtual, virtualUsd };
}
export const GMX_IMPACT_VERIFICATION = 'formula reproduced to six digits against the venue\'s own closePriceImpactDeltaUsd of real open positions, virtual inventory included (recorded fixtures and live run of scripts/sim-deriv-router.mts); the venue publishes no figure for an order that is not placed, so the OPENING leg — the same function with the size added instead of removed — is not itself verified';

// ------------------------------------------------------------------------------------------------------------------ book walk

export interface BookWalk { filled: Dec; cost: Dec; avg: Dec | null; worst: Dec | null; levels: number; sideTotal: Dec; remainder: Dec; stoppedBy: 'filled' | 'book_snapshot_ends' | 'limit_price' }
/** walks one side of the book for `size`, never beyond `limit`; exact */
export function walkBook(levels: readonly [DecStr, DecStr][], size: Dec, side: 'buy' | 'sell', limit: Dec | null): BookWalk {
  let left = size, cost = D.zero, worst: Dec | null = null, used = 0, total = D.zero, stopped: BookWalk['stoppedBy'] = 'book_snapshot_ends';
  for (const lv of levels) total = D.add(total, D.from(lv[1]));
  for (const [p, s] of levels) {
    if (!D.isPos(left)) break;
    const px = D.from(p), sz = D.from(s);
    if (limit !== null && (side === 'buy' ? D.gt(px, limit) : D.lt(px, limit))) { stopped = 'limit_price'; break; }
    if (!D.isPos(sz)) continue;
    const take = D.min(left, sz);
    cost = D.add(cost, D.mul(take, px)); left = D.sub(left, take); worst = px; used += 1;
  }
  const filled = D.sub(size, left);
  return { filled, cost, avg: D.isPos(filled) ? D.div(cost, filled, CALC_DP, 'half_even') : null, worst, levels: used, sideTotal: total, remainder: left, stoppedBy: D.isPos(left) ? stopped : 'filled' };
}

// ------------------------------------------------------------------------------------------------------------------ one venue

const perHour = (rate: DecStr, intervalSec: number): Dec => D.div(D.mul(D.from(rate), HOUR), D.from(BigInt(intervalSec)), CALC_DP, 'half_even');
const intervalText = (sec: number): string => (sec % 3600 === 0 ? `${sec / 3600} h` : `${sec} s`);
const bpsOf = (x: Dec, notional: Dec): Dec => (D.isPos(notional) ? D.div(D.mul(x, BPS), notional, CALC_DP, 'half_even') : D.zero);

function termsOf(s: VenueSnapshot): ContractTerms {
  const i = s.instrument, f = ROUTER_FACTS[s.venue];
  const v = (value: string): { value: string; source: RouterSource } => ({ value, source: 'venue' }), c = (value: string): { value: string; source: RouterSource } => ({ value, source: 'constant' });
  return {
    structure: c(f.terms.structure), execution: c(f.terms.execution), collateral: v(i.collateral), settlement: v(i.settlement), quote: c(f.terms.quote), markPrice: v(i.markPriceMethod),
    fundingInterval: v(s.venue === 'gmx' ? `continuous (per second), quoted per ${intervalText(i.fundingIntervalSec)}` : `every ${intervalText(i.fundingIntervalSec)}`),
    fundingRule: c(f.terms.fundingRule), otherCarry: c(f.terms.otherCarry),
    maxLeverage: v(s.venue === 'gmx' ? `${i.maxLeverage}× (contract bound; lower in practice and falling with open interest)` : `${i.maxLeverage}×`),
    marginModes: v(i.marginModes.join(', ')), tick: v(i.tickSize), lot: v(i.lotSize), sizeUnit: c(f.terms.sizeUnit),
    minOrder: v(i.minNotional !== null ? `${i.minNotional} USD notional` : i.minOrderSize !== null ? `${i.minOrderSize} ${i.base}` : 'none published'),
    maintenance: c(f.maintenanceText), liquidation: c(f.terms.liquidation), fees: c(f.terms.fees),
  };
}

interface Ctx { intent: OrderIntent; now: number; maxAge: { ticker: number; book: number; liquidity: number } }

function carryUncertainty(s: VenueSnapshot, notional: Dec, hours: Dec, amount: Dec): { usd: Dec; text: string } {
  if (s.fundingRange && s.fundingRange.hours > 0) {
    const half = D.div(D.sub(D.from(s.fundingRange.maxPerHour), D.from(s.fundingRange.minPerHour)), TWO, CALC_DP, 'up');
    return { usd: D.mul(D.mul(notional, hours), half), text: `rates change: half the range of the hourly rate over the last ${s.fundingRange.hours} h (${s.fundingRange.minPerHour} … ${s.fundingRange.maxPerHour}) applied to the whole horizon` };
  }
  return { usd: D.mul(D.abs(amount), D.from(UNCERTAINTY.carryFractionWithoutHistory)), text: 'rates change and no history was supplied: ±100 % of the amount (convention)' };
}

/** estimate for one instrument. Never throws on market conditions: what cannot be estimated is a reason. */
export function estimateVenue(s: VenueSnapshot, c: Ctx): ExecutionEstimate {
  const { intent, now } = c, inst = s.instrument, facts = ROUTER_FACTS[s.venue];
  const reasons: Reason[] = [], add = (code: string, kind: ReasonKind, message: string): void => { reasons.push({ code, kind, message }); };
  const tickerAge = now - s.ticker.ts, depthTs = s.book?.ts ?? s.gmx?.ts ?? null, depthAge = depthTs === null ? null : now - depthTs;
  const base: ExecutionEstimate = {
    venue: s.venue, venueName: facts.name, instrument: inst.id, symbol: inst.symbol,
    eligibility: { eligible: false, executableNow: false, executableAs: null, reasons }, order: null, fill: null, costs: [], margin: null, terms: termsOf(s), allIn: null, exit: null,
    data: { tickerAgeMs: tickerAge, depthAgeMs: depthAge }, source: 'estimate', ts: now,
  };
  const done = (): ExecutionEstimate => {
    const blocked = reasons.some((r) => r.kind === 'blocker'), setup = reasons.some((r) => r.kind === 'setup');
    base.eligibility.eligible = !blocked;
    base.eligibility.executableNow = !blocked && !setup && s.wallet.trading !== 'none';
    base.eligibility.executableAs = base.eligibility.executableNow ? (s.wallet.trading as 'paper' | 'live') : null;
    return base;
  };

  // ---- venue-level refusals: nothing is estimated behind them except, for a restricted venue, the public figures
  if (s.restriction !== null) add('venue_restricted', 'blocker', s.restriction);
  if (inst.status === 'halted') { add('instrument_halted', 'blocker', `${inst.id} is halted on the venue`); return done(); }
  if (inst.status === 'reduce_only' && !intent.reduceOnly) add('instrument_reduce_only', 'blocker', `${inst.id} only accepts orders that reduce a position`);
  if (!Number.isFinite(tickerAge) || Math.abs(tickerAge) > c.maxAge.ticker) { add('stale_data', 'blocker', `the ticker is ${Math.round(tickerAge / 1000)} s old (limit ${c.maxAge.ticker / 1000} s): no estimate on stale data`); return done(); }
  if (s.unavailable) { add('data_unavailable', 'blocker', `the ${facts.orderBook ? 'order book' : 'liquidity figures'} of ${inst.id} could not be read: ${s.unavailable}`); return done(); }
  const depthLimit = s.venue === 'gmx' ? c.maxAge.liquidity : c.maxAge.book;
  if (facts.orderBook ? s.book === null : s.gmx === null) { add('no_depth_data', 'blocker', facts.orderBook ? 'no order book snapshot: nothing to walk' : 'no liquidity snapshot: no parameters to price from'); return done(); }
  if (depthAge === null || Math.abs(depthAge) > depthLimit) { add('stale_data', 'blocker', `the ${facts.orderBook ? 'book' : 'liquidity'} snapshot is ${Math.round((depthAge ?? 0) / 1000)} s old (limit ${depthLimit / 1000} s): no estimate on stale data`); return done(); }

  const lev = D.from(intent.leverage), hours = D.from(intent.horizonHours), long = intent.side === 'long';
  const buy = long !== intent.reduceOnly, side: 'buy' | 'sell' = buy ? 'buy' : 'sell';
  const limit = intent.price === null ? null : D.from(intent.price);
  if (D.gt(lev, D.from(inst.maxLeverage)) && !intent.reduceOnly) add('leverage_above_venue_max', 'blocker', `leverage ${intent.leverage}× is above the venue maximum ${inst.maxLeverage}× for ${inst.id}`);
  if (facts.integerLeverage && !intent.reduceOnly && (!D.isMultiple(lev, D.one) || D.lt(lev, D.one))) add('leverage_not_integer', 'blocker', `leverage on ${facts.name} is an integer of at least 1`);
  if (s.wallet.trading === 'none') add('wallet_cannot_trade_here', 'setup', s.wallet.note);
  else add(s.wallet.trading === 'paper' ? 'paper_only' : 'live_available', 'note', s.wallet.note);

  const costs: CostComponent[] = [];
  const cost = (id: CostId, usd: Dec | null, notional: Dec, x: Omit<CostComponent, 'id' | 'usd' | 'bps' | 'source' | 'uncertaintyUsd'> & { unc: Dec }): void => {
    const { unc, ...rest } = x;
    costs.push({ id, usd: usd === null ? null : usdS(usd), bps: usd === null ? null : bpsS(bpsOf(usd, notional)), source: 'estimate', uncertaintyUsd: usdS(unc), ...rest });
  };
  let notional: Dec, sizeBase: Dec, entry: Dec | null = null, feeRateClose: Dec = D.zero, gmxMaint: Dec | null = null, openFee = D.zero;
  const exitParts: { id: CostId; usd: Dec; basis: string }[] = [];

  if (facts.orderBook) {
    // ================================================================ order book
    const book = s.book!, bb = book.bids[0], ba = book.asks[0];
    if (!bb || !ba) { add('empty_book', 'blocker', 'one side of the book is empty: no mid price, nothing to walk'); return done(); }
    const bid = D.from(bb[0]), ask = D.from(ba[0]), mid = D.div(D.add(bid, ask), TWO, CALC_DP, 'half_even'), lot = D.from(inst.lotSize);
    const want = intent.sizeBase !== undefined ? D.from(intent.sizeBase) : D.div(D.from(intent.notionalUsd!), mid, CALC_DP, 'down');
    sizeBase = D.quantize(want, lot, 'down');
    const rounding = D.eq(sizeBase, want) ? null : `rounded down to this venue's lot ${inst.lotSize} ${inst.base}`;
    notional = D.mul(sizeBase, mid);
    base.order = { side, positionSide: intent.side, reduceOnly: intent.reduceOnly, type: intent.type, limitPrice: intent.price, sizeUnit: 'base', sizeBase: D.str(sizeBase), sizeUsd: usdS(notional),
      requested: intent.sizeBase !== undefined ? `${intent.sizeBase} ${inst.base}` : `${intent.notionalUsd} USD at the book mid ${pxS(mid)}`, rounding };
    if (!D.isPos(sizeBase)) { add('size_rounds_to_zero', 'blocker', `the size is below one lot (${inst.lotSize} ${inst.base}) on ${facts.name}`); return done(); }
    if (inst.minOrderSize !== null && D.lt(sizeBase, D.from(inst.minOrderSize))) add('below_min_size', 'blocker', `size ${D.str(sizeBase)} ${inst.base} is below the venue minimum ${inst.minOrderSize}`);
    if (inst.minNotional !== null && D.lt(notional, D.from(inst.minNotional))) add('below_min_notional', 'blocker', `notional ${usdS(notional)} USD is below the venue minimum ${inst.minNotional} USD`);
    if (limit !== null && !D.isMultiple(limit, D.from(inst.tickSize))) add('price_not_on_tick', 'blocker', `the limit price ${intent.price} is not a multiple of the finest tick ${inst.tickSize}`);

    const levels = buy ? book.asks : book.bids, w = walkBook(levels, sizeBase, side, limit);
    const marketable = D.isPos(w.filled);
    const resting = intent.type === 'limit' ? w.remainder : D.zero;
    const unfilled = intent.type === 'market' ? w.remainder : D.zero;
    const notes: string[] = [];
    let unfilledReason: FillSimulation['unfilledReason'] = 'none';
    if (intent.type === 'market' && D.isPos(w.remainder)) {
      unfilledReason = 'book_snapshot_ends';
      add('book_snapshot_ends', 'blocker', `the book snapshot ends after ${levels.length} levels (${D.str(w.sideTotal)} ${inst.base}); ${D.str(w.remainder)} ${inst.base} of the order cannot be priced from it. The venue may hold more depth beyond the snapshot — it is not extrapolated.`);
      notes.push('book snapshot ends: the remainder is NOT priced');
    }
    if (intent.type === 'limit' && D.isPos(resting)) {
      unfilledReason = marketable ? 'limit_price' : 'not_marketable';
      const why = w.stoppedBy === 'book_snapshot_ends' ? 'the book snapshot ends before the limit price' : 'the next level is beyond the limit price';
      notes.push(`${D.str(resting)} ${inst.base} would REST on the book at ${intent.price} (${why}): it is not a fill. Its costs below assume it fills later at the limit price with the maker fee — not guaranteed.`);
      add('limit_rests', 'note', `${D.str(resting)} ${inst.base} of the limit order would rest on the book: a resting order may never fill`);
    }
    // the whole order valued: immediate fills at their prices, the resting part at the limit price
    const valued = D.add(w.cost, D.mul(resting, limit ?? D.zero)), sized = D.add(w.filled, resting);
    entry = D.isPos(sized) ? D.div(valued, sized, CALC_DP, 'half_even') : null;
    const slip = entry === null ? D.zero : D.mul(sized, buy ? D.sub(entry, mid) : D.sub(mid, entry));
    const half = D.div(D.sub(ask, bid), TWO, CALC_DP, 'half_even');
    base.fill = {
      method: 'order_book_walk', referencePrice: pxS(mid), referenceSource: 'venue', filledBase: D.str(w.filled), filledUsd: usdS(w.cost),
      avgPrice: w.avg === null ? null : pxS(w.avg), worstPrice: w.worst === null ? null : pxS(w.worst),
      slippageBps: w.avg === null ? null : bpsS(D.div(D.mul(buy ? D.sub(w.avg, mid) : D.sub(mid, w.avg), BPS), mid, CALC_DP, 'half_even')),
      levelsConsumed: w.levels, depthConsumedPct: D.isPos(w.sideTotal) ? D.str(q(D.div(D.mul(w.filled, HUNDRED), w.sideTotal, CALC_DP, 'half_even'), 4)) : null, snapshotLevels: levels.length,
      unfilledBase: D.str(unfilled), unfilledReason, restingBase: D.str(resting), gmx: null, source: 'estimate', notes,
    };
    cost('spread_slippage', slip, notional, {
      inputs: [{ name: 'best bid', value: bb[0], source: 'venue' }, { name: 'best ask', value: ba[0], source: 'venue' }, { name: 'book levels walked', value: String(w.levels), source: 'venue' },
        { name: 'average price', value: entry === null ? null : pxS(entry), source: 'estimate' }],
      basis: `size × (average price − book mid), walking the ${buy ? 'asks' : 'bids'} of the snapshot level by level${D.isPos(resting) ? '; the resting part is valued at the limit price' : ''}`,
      unc: D.mul(sized, half), uncertainty: 'the book moves between snapshot and order: half the bid-ask spread × size', timing: 'at_fill',
    });
    const taker = facts.takerRate === null ? null : D.from(facts.takerRate), maker = facts.makerRate === null ? null : D.from(facts.makerRate);
    const fee = taker === null || maker === null ? null : D.add(D.mul(w.cost, taker), D.mul(D.mul(resting, limit ?? D.zero), maker));
    openFee = fee ?? D.zero; feeRateClose = taker ?? D.zero;
    cost('trading_fee', fee, notional, {
      inputs: [{ name: 'taker rate', value: facts.takerRate, source: 'constant' }, { name: 'maker rate', value: facts.makerRate, source: 'constant' }, { name: 'taker notional', value: usdS(w.cost), source: 'estimate' }],
      basis: `taker rate × immediately filled notional${D.isPos(resting) ? ' + maker rate × resting notional' : ''}; ${facts.feeSource}`,
      unc: D.zero, uncertainty: 'the account\'s real tier may be lower than the base tier; the venue\'s fills are the truth', timing: 'at_fill',
    });
    // carry
    if (!intent.reduceOnly) {
      const oracle = D.from(s.ticker.index ?? s.ticker.mark);
      if (s.ticker.funding === null) cost('funding', null, notional, { inputs: [], basis: 'the venue publishes no funding rate for this instrument', unc: D.zero, uncertainty: 'unknown', timing: 'over_horizon' });
      else {
        const rate = perHour(s.ticker.funding, inst.fundingIntervalSec), fn = D.mul(sizeBase, oracle);
        const amount = D.mul(D.mul(fn, rate), long ? hours : D.neg(hours)), u = carryUncertainty(s, fn, hours, amount);
        cost('funding', amount, notional, {
          inputs: [{ name: 'rate per hour (what longs pay)', value: D.str(rate), source: 'venue' }, { name: 'venue interval', value: intervalText(inst.fundingIntervalSec), source: 'venue' },
            { name: s.ticker.index === null ? 'mark price' : 'oracle price', value: s.ticker.index ?? s.ticker.mark, source: 'venue' }, { name: 'horizon (h)', value: intent.horizonHours, source: 'estimate' }],
          basis: `size × oracle price × CURRENT hourly rate × ${intent.horizonHours} h, ${long ? 'paid by' : 'received by'} the ${intent.side} when the rate is positive. THE RATE CHANGES every ${intervalText(inst.fundingIntervalSec)}: this is today's rate held constant, not a forecast.`,
          unc: u.usd, uncertainty: u.text, timing: 'over_horizon',
        });
      }
    }
    // exit, for information: the opposite side of the same snapshot
    const back = walkBook(buy ? book.bids : book.asks, sizeBase, buy ? 'sell' : 'buy', null);
    if (!D.isPos(back.remainder) && back.avg !== null && taker !== null) {
      exitParts.push({ id: 'spread_slippage', usd: D.mul(sizeBase, buy ? D.sub(mid, back.avg) : D.sub(back.avg, mid)), basis: `walking the ${buy ? 'bids' : 'asks'} of the same snapshot` });
      exitParts.push({ id: 'trading_fee', usd: D.mul(back.cost, taker), basis: 'taker rate × notional' });
    }
  } else {
    // ================================================================ GMX: oracle price + price impact
    const l = s.gmx!, oMin = D.from(l.oracleMin), oMax = D.from(l.oracleMax), mid = D.div(D.add(oMin, oMax), TWO, CALC_DP, 'half_even');
    if (!D.isPos(oMin) || D.lt(oMax, oMin)) { add('bad_oracle', 'blocker', 'the oracle price range of the snapshot is not usable'); return done(); }
    // longs open at max and close at min; shorts the reverse
    const execBase = buy ? oMax : oMin, px = limit ?? execBase;
    const sizeUsd = intent.notionalUsd !== undefined ? D.from(intent.notionalUsd) : D.mul(D.from(intent.sizeBase!), px);
    notional = sizeUsd; entry = px;
    sizeBase = D.quantize(D.div(sizeUsd, px, CALC_DP, 'down'), D.from(inst.lotSize), 'down');
    base.order = { side, positionSide: intent.side, reduceOnly: intent.reduceOnly, type: intent.type, limitPrice: intent.price, sizeUnit: 'usd', sizeBase: D.str(sizeBase), sizeUsd: usdS(sizeUsd),
      requested: intent.notionalUsd !== undefined ? `${intent.notionalUsd} USD` : `${intent.sizeBase} ${inst.base} at ${pxS(px)}`, rounding: 'GMX orders are sized in USD; the token size results from the execution price' };
    if (inst.minNotional !== null && D.lt(sizeUsd, D.from(inst.minNotional))) add('below_min_notional', 'blocker', `size ${usdS(sizeUsd)} USD is below the venue minimum position ${inst.minNotional} USD`);
    const sideOi = D.from(long ? l.openInterestLongUsd : l.openInterestShortUsd), maxOi = D.from(long ? l.maxOpenInterestLongUsd : l.maxOpenInterestShortUsd), capacity = D.from(long ? l.capacityLongUsd : l.capacityShortUsd);
    if (!intent.reduceOnly) {
      if (D.gt(sizeUsd, capacity)) add('above_capacity', 'blocker', `size ${usdS(sizeUsd)} USD is above the capacity still open on the ${intent.side} side, ${usdS(capacity)} USD (limited by ${long ? l.capacityLimitedBy.long : l.capacityLimitedBy.short})`);
      if (D.gt(D.add(sideOi, sizeUsd), maxOi)) add('above_open_interest_cap', 'blocker', `${intent.side} open interest ${usdS(sideOi)} USD + ${usdS(sizeUsd)} USD would pass the market cap ${usdS(maxOi)} USD`);
      // the minimum collateral factor rises with the side's open interest: leverage ≤ 1 / max(minCollateralFactor, OI after × factor per USD)
      const perUsd = D.from(long ? l.minCollateralFactorPerUsdOfOpenInterest.long : l.minCollateralFactorPerUsdOfOpenInterest.short);
      const minFactor = D.max(D.from(l.minCollateralFactor), D.mul(D.add(sideOi, sizeUsd), perUsd));
      if (D.isPos(minFactor) && D.gt(D.mul(lev, minFactor), D.one) && !reasons.some((r) => r.code === 'leverage_above_venue_max')) add('leverage_above_venue_max', 'blocker', `leverage ${intent.leverage}× is above 1 / ${D.str(q(minFactor, 8))} = ${D.str(D.div(D.one, minFactor, 2, 'down'))}× allowed by the market's minimum collateral factor at this open interest`);
      add('gmx_interface_leverage', 'note', 'the bound above is the contracts\'; the venue\'s own interface allows less (not verified), and fees and price impact reduce the collateral that counts');
    } else add('position_unknown', 'note', 'reduce-only: the router does not know the position being reduced on GMX (no venue account); costs are for a decrease of this size');
    if (intent.type === 'limit') add('limit_waits_for_oracle', 'note', `a GMX limit order waits until the oracle price reaches ${intent.price}; a keeper then executes it, or it is frozen if it cannot be executed`);
    add('two_step_execution', 'note', 'two-step execution: the price is the signed oracle price at keeper execution, after the request — not the snapshot\'s');

    const oi = gmxBalanceOi(l), pi = l.priceImpact;
    const imp = gmxPriceImpact({ longOi: oi.long, shortOi: oi.short, sizeDeltaUsd: sizeUsd, isLong: long, increase: !intent.reduceOnly, virtualInventoryUsd: oi.virtualUsd,
      factorPositive: D.from(pi.factorPositive), factorNegative: D.from(pi.factorNegative), exponentPositive: D.from(pi.exponentPositive), exponentNegative: D.from(pi.exponentNegative) });
    const capPos = D.mul(sizeUsd, D.from(pi.maxFactorPositive)), capNeg = D.mul(sizeUsd, D.from(pi.maxFactorNegative));
    const capped = D.isPos(imp.impactUsd) ? D.min(imp.impactUsd, capPos) : D.max(imp.impactUsd, D.neg(capNeg));
    const isCapped = !D.eq(capped, imp.impactUsd);
    const spread = D.mul(sizeBase, buy ? D.sub(px, mid) : D.sub(mid, px));
    base.fill = {
      method: 'gmx_oracle_impact', referencePrice: pxS(mid), referenceSource: 'venue', filledBase: D.str(sizeBase), filledUsd: usdS(sizeUsd), avgPrice: pxS(px), worstPrice: pxS(px),
      slippageBps: bpsS(D.div(D.mul(buy ? D.sub(px, mid) : D.sub(mid, px), BPS), mid, CALC_DP, 'half_even')),
      levelsConsumed: null, depthConsumedPct: D.isPos(capacity) ? D.str(q(D.div(D.mul(sizeUsd, HUNDRED), capacity, CALC_DP, 'half_even'), 4)) : null, snapshotLevels: null,
      unfilledBase: '0', unfilledReason: 'none', restingBase: '0',
      gmx: { oracleMin: l.oracleMin, oracleMax: l.oracleMax, executionBasePrice: pxS(execBase), impactUsd: usdS(imp.impactUsd), impactCappedUsd: usdS(capped), capPositiveUsd: usdS(capPos), capNegativeUsd: usdS(capNeg), capped: isCapped,
        balanceWasImproved: imp.balanceWasImproved, crossover: imp.crossover, imbalanceBeforeUsd: usdS(imp.initialDiffUsd), imbalanceAfterUsd: usdS(imp.nextDiffUsd), openInterestBasis: oi.basis,
        virtualInventory: oi.virtual, fromVirtualInventory: imp.fromVirtualInventory, verification: GMX_IMPACT_VERIFICATION },
      source: 'estimate',
      notes: [`no order book: ${buy === long ? 'opens' : 'closes'} at the oracle ${buy ? 'max' : 'min'} price; "depth consumed" is the share of the venue's remaining ${intent.side} capacity`,
        'price impact is not in the entry price: it is recorded when the position opens and settled when it is decreased, netted with the impact of that decrease, within the caps'],
    };
    cost('spread_slippage', spread, notional, {
      inputs: [{ name: 'oracle min', value: l.oracleMin, source: 'venue' }, { name: 'oracle max', value: l.oracleMax, source: 'venue' }],
      basis: `size × (execution base price − oracle mid): the order executes at the oracle ${buy ? 'max' : 'min'}${limit ? ', here valued at the limit price' : ''}${D.eq(oMin, oMax) ? '. The venue\'s oracle range has min = max for this index in this snapshot: no spread to count' : ''}`,
      unc: D.mul(sizeBase, D.sub(oMax, oMin)), uncertainty: 'the oracle price at keeper execution is not the snapshot\'s: one oracle spread × size (the market move in between is not a cost of the venue and is not counted)', timing: 'at_fill',
    });
    cost('price_impact', D.neg(capped), notional, {
      inputs: [{ name: 'imbalance before (USD)', value: usdS(imp.initialDiffUsd), source: 'venue' }, { name: 'imbalance after (USD)', value: usdS(imp.nextDiffUsd), source: 'estimate' },
        { name: 'factor +', value: pi.factorPositive, source: 'venue' }, { name: 'factor −', value: pi.factorNegative, source: 'venue' }, { name: 'exponent', value: imp.balanceWasImproved ? pi.exponentPositive : pi.exponentNegative, source: 'venue' },
        { name: 'cap against the trade (USD)', value: usdS(capNeg), source: 'venue' }, { name: 'cap in favour (USD)', value: usdS(capPos), source: 'venue' }],
      basis: `GMX v2 formula on the long/short imbalance (${oi.basis}): imbalance^exponent × factor before − after${imp.crossover ? ', split at the balance point' : ''}; ${isCapped ? 'CAPPED at the market\'s maximum factor × size' : 'inside the caps'}. `
        + `${oi.virtual === 'none' ? 'This market has no virtual inventory.' : oi.virtual === 'known' ? (imp.fromVirtualInventory ? 'The figure comes from the index token\'s VIRTUAL INVENTORY, worse than the market\'s own.' : 'The index token\'s virtual inventory was applied; the market\'s own imbalance gives the figure.') : 'VIRTUAL INVENTORY UNKNOWN: a negative impact can be worse than this figure, up to the cap.'} `
        + `A ${D.isNeg(capped) ? 'negative impact is a cost' : 'positive impact is a credit'} RECORDED at the open and SETTLED at the close, netted with the impact of the close: ${D.isNeg(capped) ? 'part of it may come back' : 'it is not money received at entry, and under an unchanged imbalance the close takes it back (see the exit figure)'}. ${GMX_IMPACT_VERIFICATION}. The impact pool balance is not modelled.`,
      unc: oi.virtual === 'unknown' && !D.isPos(capped) ? D.max(D.sub(capNeg, D.abs(capped)), D.abs(capped)) : D.mul(D.abs(capped), D.from(UNCERTAINTY.priceImpactFraction)),
      uncertainty: `settled only at the close and netted with the close impact on the imbalance of that moment: ±${D.str(D.mul(D.from(UNCERTAINTY.priceImpactFraction), HUNDRED))} % of the figure (convention)${oi.virtual === 'unknown' ? ', widened to the cap because the virtual inventory is unknown' : ''}; the hard bound is the cap, ${usdS(capNeg)} USD against the trade`,
      timing: 'at_close',
    });
    const feeFactor = D.from(imp.balanceWasImproved ? l.positionFeeFactor.balanceImproved : l.positionFeeFactor.balanceNotImproved);
    openFee = D.mul(sizeUsd, feeFactor); feeRateClose = D.from(l.positionFeeFactor.balanceNotImproved); gmxMaint = D.from(l.minCollateralFactorForLiquidation);
    cost('trading_fee', openFee, notional, {
      inputs: [{ name: 'position fee factor', value: D.str(feeFactor), source: 'venue' }, { name: 'balance improved by the trade', value: String(imp.balanceWasImproved), source: 'estimate' }],
      basis: `position fee = size × ${imp.balanceWasImproved ? 'the lower factor (the trade reduces the long/short imbalance)' : 'the higher factor (the trade does not reduce the imbalance)'}; ${facts.feeSource}`,
      unc: D.zero, uncertainty: 'which factor applies is decided on the open interest at execution', timing: 'at_fill',
    });
    const ch = s.chain, ethUsd = ch?.ethUsd ? D.from(ch.ethUsd) : null;
    const exec = ch?.gmxExecutionFeeEth && ethUsd ? D.mul(D.from(ch.gmxExecutionFeeEth), ethUsd) : null;
    cost('execution_fee', exec, notional, {
      inputs: [{ name: 'execution fee (ETH)', value: ch?.gmxExecutionFeeEth ?? null, source: 'estimate' }, { name: 'ETH price', value: ch?.ethUsd ?? null, source: 'venue' }],
      basis: exec === null ? `unknown: ${ch?.gmxExecutionFeeNote ?? 'no chain snapshot was supplied'}` : `keeper execution fee in ETH × ETH price (${ch!.ethUsdSource}); ${ch!.gmxExecutionFeeNote}`,
      unc: exec === null ? D.zero : D.mul(exec, D.from(UNCERTAINTY.executionFeeFraction)), uncertainty: 'this is the amount to send with the request; the keeper keeps only the gas it used and the rest is refunded, so the real cost is lower', timing: 'at_fill',
    });
    const gas = ch?.gasPriceEth && ethUsd ? D.mul(D.mul(D.from(ARBITRUM_GAS_UNITS.gmxCreateOrder), D.from(ch.gasPriceEth)), ethUsd) : null;
    cost('network_gas', gas, notional, {
      inputs: [{ name: 'gas units (measured sample)', value: ARBITRUM_GAS_UNITS.gmxCreateOrder, source: 'constant' }, { name: 'Arbitrum gas price (ETH)', value: ch?.gasPriceEth ?? null, source: 'venue' }, { name: 'ETH price', value: ch?.ethUsd ?? null, source: 'venue' }],
      basis: gas === null ? 'unknown: no gas price in the snapshot' : 'gas of the request transaction (ExchangeRouter.multicall) = assumed gas units × Arbitrum gas price × ETH price',
      unc: gas === null ? D.zero : D.mul(gas, D.from(UNCERTAINTY.gasFraction)), uncertainty: 'gas used and gas price vary: ±50 % (convention)', timing: 'at_fill',
    });
    if (!intent.reduceOnly) {
      // venue sign: positive = the side RECEIVES
      const fr = D.from(long ? l.fundingRateLongPerHour : l.fundingRateShortPerHour), funding = D.neg(D.mul(D.mul(sizeUsd, fr), hours)), fu = carryUncertainty(s, sizeUsd, hours, funding);
      cost('funding', funding, notional, {
        inputs: [{ name: `funding rate per hour, ${intent.side} side (venue sign: positive = receives)`, value: D.str(fr), source: 'venue' }, { name: 'horizon (h)', value: intent.horizonHours, source: 'estimate' }],
        basis: `size × CURRENT hourly rate of the ${intent.side} side × ${intent.horizonHours} h. Funding accrues PER SECOND and is adaptive: THE RATE CHANGES continuously, and this order itself moves the imbalance that drives it. Today's rate held constant, not a forecast.`,
        unc: fu.usd, uncertainty: fu.text, timing: 'over_horizon',
      });
      const br = D.from(long ? l.borrowingRateLongPerHour : l.borrowingRateShortPerHour), borrow = D.mul(D.mul(sizeUsd, D.abs(br)), hours);
      cost('borrow', borrow, notional, {
        inputs: [{ name: `borrowing rate per hour, ${intent.side} side`, value: D.str(br), source: 'venue' }, { name: 'horizon (h)', value: intent.horizonHours, source: 'estimate' }],
        basis: `size × CURRENT hourly borrowing rate of the ${intent.side} side × ${intent.horizonHours} h; only the larger open-interest side pays, so the rate can switch on or off as the imbalance moves`,
        unc: D.isZero(borrow) ? D.mul(D.mul(sizeUsd, D.abs(D.from(long ? l.borrowingRateShortPerHour : l.borrowingRateLongPerHour))), hours) : borrow,
        uncertainty: D.isZero(borrow) ? 'zero today because this side is the smaller one; if the sides switch, the other side\'s current rate would apply' : 'the rate follows pool utilisation: ±100 % (convention)', timing: 'over_horizon',
      });
      // exit, for information: decrease of the same size on the open interest AFTER this order, netted with the pending impact
      const nl = long ? D.add(oi.long, sizeUsd) : oi.long, ns = long ? oi.short : D.add(oi.short, sizeUsd);
      // traders net longer → the virtual inventory (negative = net long) falls by the size; net shorter → it rises
      const nv = oi.virtualUsd === null ? null : long ? D.sub(oi.virtualUsd, sizeUsd) : D.add(oi.virtualUsd, sizeUsd);
      const out = gmxPriceImpact({ longOi: nl, shortOi: ns, sizeDeltaUsd: sizeUsd, isLong: long, increase: false, virtualInventoryUsd: nv,
        factorPositive: D.from(pi.factorPositive), factorNegative: D.from(pi.factorNegative), exponentPositive: D.from(pi.exponentPositive), exponentNegative: D.from(pi.exponentNegative) });
      const net = D.add(imp.impactUsd, out.impactUsd), netCapped = D.isPos(net) ? D.min(net, capPos) : D.max(net, D.neg(capNeg));
      exitParts.push({ id: 'price_impact', usd: D.sub(D.neg(netCapped), D.neg(capped)), basis: 'impact of the decrease on the open interest after this order, netted with the opening impact and capped; shown as the change against the opening impact already counted' });
      exitParts.push({ id: 'spread_slippage', usd: spread, basis: 'the close executes at the other end of the oracle range' });
      exitParts.push({ id: 'trading_fee', usd: D.mul(sizeUsd, D.from(out.balanceWasImproved ? l.positionFeeFactor.balanceImproved : l.positionFeeFactor.balanceNotImproved)), basis: 'position fee of the decrease' });
      if (exec !== null) exitParts.push({ id: 'execution_fee', usd: exec, basis: 'a second keeper execution' });
      if (gas !== null) exitParts.push({ id: 'network_gas', usd: gas, basis: 'a second request transaction' });
    }
  }

  // ---- margin (opening orders)
  let im = D.zero;
  const entryPx = entry;
  if (!intent.reduceOnly && entryPx !== null && D.isPos(sizeBase)) {
    const positionNotional = D.mul(sizeBase, entryPx);
    im = initialMargin(positionNotional, lev);
    const mmf = facts.maintenance === 'half_initial_at_max' ? D.div(D.one, D.mul(TWO, D.from(inst.maxLeverage)), 18, 'up') : facts.maintenance === 'gmx_min_collateral' ? gmxMaint : facts.maintenance === null ? null : D.from(facts.maintenance);
    let liq: MarginEstimate['liquidationPrice'] = { value: null, source: 'estimate', method: 'no maintenance fraction is known for this instrument: no liquidation estimate' }, dist: DecStr | null = null;
    if (mmf !== null) {
      // GMX takes the opening fee out of the collateral and counts the closing fee against it; an order-book venue is estimated without fees
      const gmx = s.venue === 'gmx', margin = gmx ? D.sub(im, openFee) : im;
      if (D.isPos(margin)) {
        const r = liquidationPriceIsolated({ side: intent.side, size: sizeBase, entryPrice: entryPx, margin, maintenanceFraction: mmf, ...(gmx ? { feeRate: feeRateClose } : {}) });
        const tail = gmx ? 'margin = initial margin − opening fee; funding, borrowing, price impact and the liquidation fee are ignored; liquidation is on the oracle min/max, not the mid'
          : 'position funded with exactly its initial margin (isolated); on cross margin the whole account backs it and the price is further away; size tiers of the maintenance margin ignored';
        liq = { value: r.value === null ? null : pxS(r.value), source: 'estimate', method: `${r.method}; ${tail}` };
        if (r.value !== null) dist = bpsS(D.div(D.mul(D.abs(D.sub(entryPx, r.value)), BPS), entryPx, CALC_DP, 'half_even'));
      } else liq = { value: null, source: 'estimate', method: 'the opening fee is larger than the initial margin at this leverage: the position could not be opened' };
    }
    base.margin = { notionalUsd: usdS(positionNotional), leverage: intent.leverage, initialMarginUsd: usdS(im), maintenanceFraction: mmf === null ? null : D.str(q(mmf, 10)), maintenanceRule: facts.maintenanceText,
      maintenanceSource: facts.maintenance === 'gmx_min_collateral' ? 'venue' : 'constant', liquidationPrice: liq, liquidationDistanceBps: dist };
  }

  // ---- collateral: is it there?
  const need = D.add(im, openFee), cf = facts.collateral, ch = s.chain;
  const transferGas = cf.needsArbitrumTransfer && ch?.gasPriceEth && ch.ethUsd ? D.mul(D.mul(D.from(ARBITRUM_GAS_UNITS.erc20Transfer), D.from(ch.gasPriceEth)), D.from(ch.ethUsd)) : null;
  const facts3: Input[] = [{ name: 'route', value: cf.route, source: 'constant' }, { name: 'source', value: cf.source, source: 'constant' }];
  if (intent.reduceOnly) { /* reducing needs no new collateral */ }
  else if (s.restriction !== null) cost('collateral_transfer', null, notional, { inputs: facts3, basis: 'not applicable: the venue is not available to the owner', unc: D.zero, uncertainty: 'unknown', timing: 'before_trading' });
  else if (s.account && D.gte(D.from(s.account.freeCollateral), need)) {
    cost('collateral_transfer', D.zero, notional, { inputs: [{ name: `free collateral of « ${s.account.label} » (${s.account.kind})`, value: s.account.freeCollateral, source: s.account.kind === 'venue' ? 'venue' : 'estimate' }],
      basis: s.account.kind === 'paper' ? 'the paper account holds enough SIMULATED collateral: nothing to move (a real account would have to be funded first)' : 'the venue account holds enough free collateral: nothing to move',
      unc: D.zero, uncertainty: 'none', timing: 'before_trading' });
  } else {
    if (s.account) add('insufficient_collateral_there', 'setup', `« ${s.account.label} » has ${s.account.freeCollateral} USD of free collateral; this order needs about ${usdS(need)} USD (initial margin + fee)`);
    else add('no_collateral_account', 'setup', s.venue === 'gmx' ? 'GMX has no venue account: the collateral must already be in the wallet on Arbitrum One, and this wallet does not hold a GMX position account' : `no account with collateral on ${facts.name} is known to the wallet: it would have to be funded first`);
    const known = cf.fixedCostUsd !== null && (!cf.needsArbitrumTransfer || transferGas !== null);
    const amount = known ? D.add(D.from(cf.fixedCostUsd!), transferGas ?? D.zero) : null;
    cost('collateral_transfer', amount, notional, {
      inputs: [...facts3, ...(cf.needsArbitrumTransfer ? [{ name: 'gas units of a USDC transfer (measured sample)', value: ARBITRUM_GAS_UNITS.erc20Transfer, source: 'constant' as const }, { name: 'Arbitrum gas price (ETH)', value: ch?.gasPriceEth ?? null, source: 'venue' as const }] : [])],
      basis: amount === null ? `unknown: ${cf.needsArbitrumTransfer ? 'no gas price in the snapshot' : 'it depends on where the funds are today'}. ${cf.route}` : `gas of one USDC transfer on Arbitrum One, assuming the USDC is already there. ${cf.route}`,
      unc: amount === null ? D.zero : D.mul(amount, D.from(UNCERTAINTY.gasFraction)), uncertainty: 'bringing funds to Arbitrum from another network is NOT included (unknown)', timing: 'before_trading',
    });
  }

  base.costs = costs;
  // ---- all-in: what is known is summed, what is not is named
  if (base.fill) {
    let total = D.zero, unc = D.zero; const included: CostId[] = [], unknown: CostId[] = [];
    for (const k of costs) { if (k.usd === null) { unknown.push(k.id); continue; } total = D.add(total, D.from(k.usd)); unc = D.add(unc, D.from(k.uncertaintyUsd)); included.push(k.id); }
    const priced = !D.isPos(D.from(base.fill.unfilledBase));
    base.allIn = { usd: usdS(total), bps: bpsS(bpsOf(total, notional)), uncertaintyUsd: usdS(unc), included, unknown, horizonHours: intent.horizonHours, complete: priced && unknown.length === 0,
      note: `${priced ? '' : 'PARTIAL — the book snapshot ends: only the priced part is in this figure. '}entry costs + carry over ${intent.horizonHours} h at today's rates, in USD and in basis points of the order's notional; closing costs are not included${unknown.length ? `; NOT included because unknown: ${unknown.join(', ')}` : ''}` };
    if (exitParts.length) {
      const x = exitParts.reduce((a, p) => D.add(a, p.usd), D.zero);
      const rt = D.add(total, x);
      base.exit = { usd: usdS(x), bps: bpsS(bpsOf(x, notional)), roundTripUsd: usdS(rt), roundTripBps: bpsS(bpsOf(rt, notional)), parts: exitParts.map((p) => ({ id: p.id, usd: usdS(p.usd), basis: p.basis })),
        note: 'closing the same size immediately under the SAME snapshot — information only: at the real close the book, the oracle price, the imbalance and the rates will be different' };
    }
  }
  return done();
}

// ------------------------------------------------------------------------------------------------------------------ ranking, differences

export const RANKING_NOTE = 'Information only. The router selects nothing and sends nothing: it orders eligible instruments by estimated all-in cost, lowest first. "Lowest estimated cost" is not "best": the contracts differ (collateral, price used for liquidation, funding rule, execution model) and every figure is an estimate that moves with the market.';

export function rankCandidates(c: ExecutionEstimate[]): Ranking {
  const ok = c.filter((e) => e.eligibility.eligible && e.allIn !== null);
  const sorted = [...ok].sort((a, b) => D.cmp(D.from(a.allIn!.usd), D.from(b.allIn!.usd)) || a.instrument.localeCompare(b.instrument));
  const rows: RankingRow[] = [];
  sorted.forEach((e, k) => {
    const mine = D.from(e.allIn!.usd), prev = rows[k - 1];
    const tied = sorted.filter((o) => o !== e && D.eq(D.from(o.allIn!.usd), mine)).map((o) => o.instrument);
    // within the sum of the two uncertainties: the order of the two is not established by these estimates
    const near = sorted.filter((o) => o !== e && !D.eq(D.from(o.allIn!.usd), mine) && D.lte(D.abs(D.sub(D.from(o.allIn!.usd), mine)), D.add(D.from(o.allIn!.uncertaintyUsd), D.from(e.allIn!.uncertaintyUsd)))).map((o) => o.instrument);
    rows.push({ rank: prev && D.eq(D.from(prev.allInUsd), mine) ? prev.rank : k + 1, instrument: e.instrument, venue: e.venue, allInUsd: e.allIn!.usd, allInBps: e.allIn!.bps, uncertaintyUsd: e.allIn!.uncertaintyUsd,
      complete: e.allIn!.complete, executableNow: e.eligibility.executableNow, tiedWith: tied, nearTieWith: near, roundTripUsd: e.exit?.roundTripUsd ?? null, roundTripRank: null });
  });
  const byTrip = rows.filter((r) => r.roundTripUsd !== null).sort((a, b) => D.cmp(D.from(a.roundTripUsd!), D.from(b.roundTripUsd!)) || a.instrument.localeCompare(b.instrument));
  byTrip.forEach((r, k) => { r.roundTripRank = k + 1; });
  const entryOrder = rows.filter((r) => r.roundTripUsd !== null).map((r) => r.instrument);
  const orderChangesWithExit = byTrip.some((r, k) => r.instrument !== entryOrder[k] && !D.eq(D.from(r.roundTripUsd!), D.from(byTrip.find((x) => x.instrument === entryOrder[k])!.roundTripUsd!)));
  return { rows, selected: null, orderChangesWithExit, basis: 'all-in cost over the horizon (entry costs + carry at today\'s rates), USD, lowest first; equal figures share a rank; "near tie" = the difference is within the sum of the two uncertainties', note: RANKING_NOTE,
    excluded: c.filter((e) => !ok.includes(e)).map((e) => ({ instrument: e.instrument, venue: e.venue, reasons: e.eligibility.reasons.filter((r) => r.kind === 'blocker').map((r) => r.code) })) };
}

export const NEVER = [
  'A long on one venue and a short on another are not "flat": the contracts follow different prices (Hyperliquid: a mark blending its book with a USDT-denominated oracle; GMX: a signed oracle min/max; dYdX: a USD oracle).',
  'A size valid on one venue is not valid on another: each has its own lot, and GMX orders are in USD.',
  'A book price and an oracle price are not the same kind of price: on GMX the cost is fee + price impact + execution fee + borrowing, on a book it is spread, depth and fee.',
  'An accepted order is not a fill: a GMX order is a request a keeper may execute later, cancel or freeze.',
  'A leverage figure does not carry across venues: the maintenance rule, the price used for liquidation and the penalty all differ.',
];
export function contractDifferences(base: string, c: ExecutionEstimate[]): Differences {
  const fields: Difference[] = [];
  for (const k of TERM_KEYS) {
    const values = c.map((e) => ({ instrument: e.instrument, venue: e.venue, value: e.terms[k].value, source: e.terms[k].source }));
    if (new Set(values.map((v) => v.value)).size > 1) fields.push({ field: k, values });
  }
  const n = c.length;
  return { interchangeable: false, fields, never: NEVER,
    statement: n === 0 ? `No instrument on ${base} was found.` : n === 1 ? `One instrument on ${base}: there is nothing to compare it with, and it is not the same contract as a ${base} perpetual anywhere else.`
      : `${n} different contracts on ${base}. None of them is the same contract as another — not even two pools of one venue: ${fields.length} of ${TERM_KEYS.length} terms differ between them, and a position on one cannot be closed, netted or margined on another.` };
}

export const ROUTER_WARNINGS = [
  'Simulation only: nothing was sent to any venue, and no order can be placed from this result.',
  'Funding and borrowing rates change (hourly on order-book venues, every second on GMX): the carry shown is today\'s rate held constant over the horizon, not a forecast.',
  'Every cost is an estimate on a snapshot: the book, the oracle price and the pools move before any real order would execute.',
];

/**
 * The whole comparison. `snapshots`: one per instrument on the intent's base (several per venue on GMX: one per pool).
 * A restricted venue is estimated from its public data and shown, never ranked.
 */
export function routeOrder(intentIn: z.input<typeof OrderIntentSchema>, snapshots: readonly VenueSnapshot[], o: { now: number; maxAgeMs?: Partial<typeof ROUTER_MAX_AGE_MS> }): RouteResult {
  const intent = OrderIntentSchema.parse(intentIn), want = intent.base.toUpperCase();
  const maxAge = { ...ROUTER_MAX_AGE_MS, ...(o.maxAgeMs ?? {}) };
  const mine = snapshots.filter((s) => s.instrument.base.toUpperCase() === want);
  const candidates = mine.map((s) => estimateVenue(s, { intent, now: o.now, maxAge }));
  const warnings = [...ROUTER_WARNINGS];
  if (mine.length === 0) warnings.push(`No venue lists a perpetual on ${want}.`);
  const ranking = rankCandidates(candidates);
  if (ranking.orderChangesWithExit) warnings.push('The order changes when an immediate close is added to the all-in cost (see the round-trip column): the ranking is on entry costs and carry only.');
  const partial = candidates.filter((e) => e.allIn && e.allIn.unknown.length > 0);
  if (partial.length) warnings.push(`Some costs are unknown and are NOT in the totals (${[...new Set(partial.flatMap((e) => e.allIn!.unknown))].join(', ')}): the totals of those instruments are lower bounds.`);
  if (candidates.some((e) => e.eligibility.reasons.some((r) => r.code === 'venue_restricted'))) warnings.push('A venue restricted for the owner is shown for information and is never ranked.');
  return { intent, candidates, ranking, differences: contractDifferences(want, candidates), warnings, ts: o.now, source: 'estimate' };
}

/** the order a paper or venue account would be asked to check for this estimate (size on the venue's lot; market orders bounded by `slippageBps`) */
export function orderBodyFor(e: ExecutionEstimate, slippageBps = 50): null | { instrument: string; side: 'buy' | 'sell'; type: 'market' | 'limit'; size: DecStr; price: DecStr | null; reduceOnly: boolean; leverage?: DecStr; slippageBps?: number } {
  if (!e.order || e.order.sizeUnit !== 'base' || !D.isPos(D.from(e.order.sizeBase))) return null;
  return { instrument: e.instrument, side: e.order.side, type: e.order.type, size: e.order.sizeBase, price: e.order.limitPrice, reduceOnly: e.order.reduceOnly,
    ...(e.margin ? { leverage: e.margin.leverage } : {}), ...(e.order.type === 'market' ? { slippageBps } : {}) };
}
