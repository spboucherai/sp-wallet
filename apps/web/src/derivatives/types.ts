/**
 * Shapes the Futures terminal codes against: the core models are the repository's own (type-only imports, erased at build), the
 * route answers follow the table "API contract (wave 2: read-only and paper)" of docs/v4/DERIVATIVES-ARCHITECTURE.md.
 */
import type { DecStr } from '../../../../packages/derivatives/src/decimal.ts';
import type { AccountState, Book, Candle, Fill, FundingPayment, Instrument, Order, OrderRequest, Position, PublicTrade, Ticker, VenueId } from '../../../../packages/derivatives/src/models.ts';
import type { AccountMode, RiskCode, RiskPolicy, RiskResult } from '../../../../packages/derivatives/src/risk.ts';
import type { Capabilities } from '../../../../packages/derivatives/src/venue.ts';

export type { AccountMode, AccountState, Book, Candle, Capabilities, DecStr, Fill, FundingPayment, Instrument, Order, OrderRequest, Position, PublicTrade, RiskCode, RiskPolicy, RiskResult, Ticker, VenueId };

export const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Interval = (typeof INTERVALS)[number];
export const INTERVAL_MS: Record<Interval, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };

export type VenueStatus = 'ok' | 'degraded' | 'down';
export interface VenueInfo { id: VenueId; name: string; network: string; capabilities: Capabilities; status: VenueStatus; lastOkAt: number | null; restriction: string | null;
  /** optional hint from the server; when absent the client derives it (see `paperAllowed`) */ paper?: boolean }

/** what GMX has instead of a book (packages/derivatives/src/venues/gmx/adapter.ts, `GmxLiquidity`); every field optional here: the panel shows what it gets */
export interface Liquidity {
  openInterestLongUsd?: DecStr; openInterestShortUsd?: DecStr; maxOpenInterestLongUsd?: DecStr; maxOpenInterestShortUsd?: DecStr;
  availableLiquidityLongUsd?: DecStr; availableLiquidityShortUsd?: DecStr; capacityLongUsd?: DecStr; capacityShortUsd?: DecStr;
  /** per hour, fraction; positive = the side RECEIVES, negative = the side PAYS */
  fundingRateLongPerHour?: DecStr; fundingRateShortPerHour?: DecStr; borrowingRateLongPerHour?: DecStr; borrowingRateShortPerHour?: DecStr; netRateLongPerHour?: DecStr; netRateShortPerHour?: DecStr;
  priceImpact?: { factorPositive?: DecStr; factorNegative?: DecStr; exponentPositive?: DecStr; exponentNegative?: DecStr; maxFactorPositive?: DecStr; maxFactorNegative?: DecStr };
  positionFeeFactor?: { balanceImproved?: DecStr; balanceNotImproved?: DecStr };
  oracleMin?: DecStr; oracleMax?: DecStr; ts?: number;
}
export interface Market { instrument: Instrument; ticker: Ticker; book: Book | null; liquidity: Liquidity | null; trades: PublicTrade[] }
export interface FundingHistory { history: { ts: number; rate: DecStr }[]; intervalSec: number }

export interface CompareRow { venue: VenueId; instrument: string; mark: DecStr; index: DecStr | null;
  /** per hour, normalised */ funding: DecStr | null; /** the venue's own funding interval */ fundingIntervalSec: number | null;
  spreadBps: DecStr | null; depthUsd1pct: DecStr | null; takerFeeBps: DecStr | null; maxLeverage: DecStr; collateral: string; settlement: string; notes: string[] }

export interface DerivAccount { id: string; venue: VenueId; network: string; kind: 'paper' | 'venue'; mode: AccountMode; label: string; policy: RiskPolicy;
  state: AccountState; positions: Position[]; openOrders: Order[] }
export interface RiskEvent { ts: number; kind: string; instrument: string | null; detail: string }
export interface EquityPoint { ts: number; equity: DecStr }
export interface AccountDetail extends DerivAccount { orders: Order[]; fills: Fill[]; funding: FundingPayment[]; riskEvents: RiskEvent[]; equityHistory: EquityPoint[] }

export interface EstimateValue { value: DecStr | null; source: 'estimate'; method: string }
export interface OrderEstimate { notional: DecStr; initialMargin: DecStr; fee: DecStr; avgFillPrice: DecStr | null; slippageBps: DecStr | null; liquidationPrice: EstimateValue | null; freeCollateralAfter: DecStr }
export interface Preview { risk: RiskResult; estimate: OrderEstimate | null }
/** body of preview / place: an OrderRequest without clientId, plus the leverage to use on this instrument */
export type OrderBody = Omit<OrderRequest, 'clientId'> & { leverage?: DecStr };
export interface Placed { order: Order; fills: Fill[] }
export interface Watch { state: AccountState; positions: Position[]; openOrders: Order[] }

export type StreamStatus = 'connected' | 'reconnecting' | 'stale';
export const instrumentId = (venue: string, symbol: string) => `${venue}:${symbol}`;
export const venueOf = (id: string) => id.slice(0, Math.max(0, id.indexOf(':'))) as VenueId;
