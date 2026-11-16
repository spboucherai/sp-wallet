// Agent performance — ONE module, pure, with the laboratory's definitions (research/src/spq/metrics.py, perp_metrics.py) so
// that paper, live and backtest figures can be read side by side. It never mixes modes: it receives the series of ONE mode
// (store.ts loads them with `mode = …` in every query) and returns the figures of that mode.
//
//   returns        r_i = E_i / E_{i-1} − 1 on consecutive equity points
//   volatility     std(r, ddof = 1) · √(periods per year)                       periods per year from the median spacing
//   Sharpe         mean(r) / std(r, ddof = 1) · √(periods per year)             risk-free rate 0, as the laboratory
//   Sortino        mean(r) / √(mean(min(r, 0)²)) · √(periods per year)
//   max drawdown   max over time of 1 − E_t / max(E_s, s ≤ t)                    a positive fraction
//   win rate       closed trades with pnl > 0 / closed trades                    profit factor = Σ gains / |Σ losses|
//   turnover       Σ |notional traded| / mean equity
//   net PnL        last equity − first equity (fees, funding and slippage are already inside the equity; they are reported
//                  next to it, never subtracted a second time)
//
// A figure that cannot be computed is null WITH the reason. Small samples are flagged, not hidden.
export interface EquityPoint { ts: number; equity: number }
/** one execution: `notionalUsd` ≥ 0, `feeUsd` ≥ 0, `slippageUsd` = cost against the reference price (≥ 0 is a cost), `closedPnlUsd` set when the fill closed (part of) a position */
export interface TradeRow { ts: number; notionalUsd: number; feeUsd: number | null; slippageUsd: number | null; closedPnlUsd: number | null }
export interface FundingRow { ts: number; amountUsd: number }
export interface PerfInput { equity: EquityPoint[]; trades: TradeRow[]; funding: FundingRow[]; /** why a component is not available for this agent kind */ notes?: Partial<Record<'fees' | 'slippage' | 'funding' | 'trades', string>> }
export interface Num { value: number | null; reason: string | null }
export interface Performance {
  points: number; from: number | null; to: number | null; periodsPerYear: number | null;
  equityCurve: EquityPoint[]; returns: number[];
  totalReturn: Num; volatility: Num; sharpe: Num; sortino: Num; maxDrawdown: Num; winRate: Num; profitFactor: Num; turnover: Num;
  feesUsd: Num; fundingUsd: Num; slippageUsd: Num; netPnlUsd: Num; closedTrades: number; orders: number;
  warnings: { code: string; message: string }[];
}

export const MIN_POINTS_FOR_RATIOS = 30;
export const MIN_TRADES_FOR_RATES = 20;
const YEAR_MS = 365 * 86_400_000;
const num = (value: number): Num => ({ value: Number.isFinite(value) ? value : null, reason: Number.isFinite(value) ? null : 'not a finite number' });
const none = (reason: string): Num => ({ value: null, reason });
const mean = (x: number[]): number => x.reduce((s, v) => s + v, 0) / x.length;
const median = (x: number[]): number => { const s = [...x].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
export const stdev = (x: number[]): number => { if (x.length < 2) return NaN; const m = mean(x); return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1)); };

export function maxDrawdown(equity: number[]): number {
  let peak = -Infinity, dd = 0;
  for (const e of equity) { if (e > peak) peak = e; if (peak > 0) dd = Math.max(dd, 1 - e / peak); }
  return dd;
}

export function computePerformance(input: PerfInput): Performance {
  const eq = [...input.equity].filter((p) => Number.isFinite(p.equity) && Number.isFinite(p.ts)).sort((a, b) => a.ts - b.ts);
  const warnings: Performance['warnings'] = [];
  const returns: number[] = [];
  for (let i = 1; i < eq.length; i++) { const prev = eq[i - 1]!.equity; if (prev > 0) returns.push(eq[i]!.equity / prev - 1); }
  const gaps = eq.slice(1).map((p, i) => p.ts - eq[i]!.ts).filter((g) => g > 0);
  const periodsPerYear = gaps.length ? YEAR_MS / median(gaps) : null;
  const sd = stdev(returns), m = returns.length ? mean(returns) : NaN, root = periodsPerYear === null ? NaN : Math.sqrt(periodsPerYear);
  const downside = returns.length ? Math.sqrt(mean(returns.map((r) => Math.min(r, 0) ** 2))) : NaN;
  const few = returns.length < 2 ? 'fewer than two returns' : null;

  if (eq.length < MIN_POINTS_FOR_RATIOS) warnings.push({ code: 'small_sample', message: `${eq.length} equity point(s): volatility, Sharpe and Sortino on fewer than ${MIN_POINTS_FOR_RATIOS} points say almost nothing` });
  // irregular sampling: the annualisation assumes evenly spaced points
  if (gaps.length >= 3 && Math.max(...gaps) > 3 * median(gaps)) warnings.push({ code: 'irregular_sampling', message: 'the equity points are not evenly spaced (the agent was stopped, paused or held): annualised figures assume they are' });

  const closed = input.trades.filter((t) => t.closedPnlUsd !== null).map((t) => t.closedPnlUsd!);
  const gains = closed.filter((p) => p > 0).reduce((s, p) => s + p, 0), losses = closed.filter((p) => p < 0).reduce((s, p) => s + p, 0);
  if (closed.length > 0 && closed.length < MIN_TRADES_FOR_RATES) warnings.push({ code: 'few_trades', message: `${closed.length} closed trade(s): win rate and profit factor on fewer than ${MIN_TRADES_FOR_RATES} trades are anecdotal` });
  const noTrades = input.notes?.trades ?? 'no closed trade';
  const traded = input.trades.reduce((s, t) => s + Math.abs(t.notionalUsd), 0);
  const fees = input.trades.filter((t) => t.feeUsd !== null), slips = input.trades.filter((t) => t.slippageUsd !== null);

  return {
    points: eq.length, from: eq[0]?.ts ?? null, to: eq.at(-1)?.ts ?? null, periodsPerYear, equityCurve: eq, returns,
    totalReturn: eq.length >= 2 && eq[0]!.equity > 0 ? num(eq.at(-1)!.equity / eq[0]!.equity - 1) : none('fewer than two equity points'),
    volatility: few ? none(few) : num(sd * root),
    sharpe: few ? none(few) : sd > 0 ? num((m / sd) * root) : none('the returns do not vary'),
    sortino: few ? none(few) : downside > 0 ? num((m / downside) * root) : none('no negative return'),
    maxDrawdown: eq.length ? num(maxDrawdown(eq.map((p) => p.equity))) : none('no equity point'),
    winRate: closed.length ? num(closed.filter((p) => p > 0).length / closed.length) : none(noTrades),
    profitFactor: !closed.length ? none(noTrades) : losses < 0 ? num(gains / -losses) : none('no losing trade'),
    turnover: eq.length && mean(eq.map((p) => p.equity)) > 0 ? num(traded / mean(eq.map((p) => p.equity))) : none('no equity point'),
    feesUsd: input.notes?.fees ? none(input.notes.fees) : fees.length || !input.trades.length ? num(fees.reduce((s, t) => s + t.feeUsd!, 0)) : none('the executions carry no fee'),
    fundingUsd: input.notes?.funding ? none(input.notes.funding) : num(input.funding.reduce((s, f) => s + f.amountUsd, 0)),
    slippageUsd: input.notes?.slippage ? none(input.notes.slippage) : slips.length || !input.trades.length ? num(slips.reduce((s, t) => s + t.slippageUsd!, 0)) : none('the executions carry no reference price'),
    netPnlUsd: eq.length >= 2 ? num(eq.at(-1)!.equity - eq[0]!.equity) : none('fewer than two equity points'),
    closedTrades: closed.length, orders: input.trades.length, warnings,
  };
}

/** Average-cost realised PnL of a long-only spot book: each sell closes at (price − average cost) × units. Pure; used for spot agents,
 *  whose orders are swaps between the cash leg and an asset. */
export interface SpotFill { ts: number; symbol: string; side: 'buy' | 'sell'; units: number; usd: number; expectedUsd: number | null }
export function spotTrades(fills: SpotFill[]): TradeRow[] {
  const book = new Map<string, { units: number; cost: number }>();
  return [...fills].sort((a, b) => a.ts - b.ts).map((f) => {
    const b = book.get(f.symbol) ?? { units: 0, cost: 0 };
    let closed: number | null = null;
    if (f.side === 'buy') { b.units += f.units; b.cost += f.usd; }
    else {
      const sold = Math.min(f.units, b.units), avg = b.units > 0 ? b.cost / b.units : 0;
      closed = sold > 0 ? (f.usd / f.units - avg) * sold : null;       // units sold without a recorded purchase (deposited by the owner) have no cost basis
      b.units -= sold; b.cost -= avg * sold;
    }
    book.set(f.symbol, b);
    // slippage: what the quote promised against what was received (buy: USD paid is fixed, fewer units arrive — valued at the fill price)
    return { ts: f.ts, notionalUsd: f.usd, feeUsd: null, slippageUsd: f.expectedUsd === null ? null : f.expectedUsd - f.usd, closedPnlUsd: closed };
  });
}
