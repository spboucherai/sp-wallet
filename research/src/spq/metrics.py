"""Performance metrics of one backtest window.

Definitions (r_t = equity_t / equity_{t-1} - 1 on bar closes, N = bars per 365-day year for a 24/7 market):

- total_return   equity_end / equity_start - 1
- cagr           (equity_end / equity_start) ** (N / n_returns) - 1
- volatility     std(r, ddof=1) * sqrt(N)
- sharpe         mean(r) / std(r, ddof=1) * sqrt(N), risk-free rate 0 (idle USDC earns nothing here)
- sortino        mean(r) / sqrt(mean(min(r, 0)^2)) * sqrt(N)   (downside deviation around 0, over all bars)
- max_drawdown   max over time of 1 - equity / running maximum, a POSITIVE fraction (0.35 = -35 %)
- calmar         cagr / max_drawdown
- turnover       traded notional (buys + sells) / average equity, over the window (not annualised);
                 turnover_annual is the same per year
- trades         number of fills
- win_rate, profit_factor   computed on closed lots: each sell realises a P&L against the average cost of the
                 position (fees and slippage included on both sides); positions still open at the end are counted
                 once, marked at the last close without exit costs. win_rate = share of lots with P&L > 0,
                 profit_factor = sum of gains / sum of losses. Both are null when undefined (no lot / no loss).
- fees_paid, slippage_paid  USD
- exposure       average invested fraction of equity

Undefined ratios (zero variance, no drawdown, ...) are reported as null, never as infinity.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd
from scipy import stats

from .data.core import bars_per_year
from .engine import BacktestResult


def _num(x):
    """JSON-safe float: None for NaN/inf."""
    if x is None:
        return None
    x = float(x)
    return x if math.isfinite(x) else None


def max_drawdown(equity: np.ndarray) -> float:
    equity = np.asarray(equity, dtype="float64")
    if len(equity) == 0:
        return 0.0
    peak = np.maximum.accumulate(equity)
    return float(np.max(1.0 - equity / peak))


def sharpe_ratio(returns: np.ndarray, periods_per_year: float = 1.0) -> float:
    """mean/std(ddof=1) * sqrt(periods_per_year); NaN when undefined."""
    r = np.asarray(returns, dtype="float64")
    if len(r) < 2:
        return float("nan")
    sd = r.std(ddof=1)
    return float(r.mean() / sd * math.sqrt(periods_per_year)) if sd > 0 else float("nan")


def sortino_ratio(returns: np.ndarray, periods_per_year: float = 1.0) -> float:
    r = np.asarray(returns, dtype="float64")
    if len(r) < 2:
        return float("nan")
    dd = math.sqrt(float(np.mean(np.minimum(r, 0.0) ** 2)))
    return float(r.mean() / dd * math.sqrt(periods_per_year)) if dd > 0 else float("nan")


def return_distribution(returns: np.ndarray) -> dict:
    r = np.asarray(returns, dtype="float64")
    if len(r) < 2:
        return {"n": int(len(r))}
    constant = r.std() == 0
    pct = np.percentile(r, [1, 5, 50, 95, 99])
    return {
        "n": int(len(r)),
        "mean": _num(r.mean()),
        "std": _num(r.std(ddof=1)),
        "skew": _num(0.0 if constant else stats.skew(r)),
        "excess_kurtosis": _num(0.0 if constant else stats.kurtosis(r)),
        "min": _num(r.min()),
        "p01": _num(pct[0]), "p05": _num(pct[1]), "median": _num(pct[2]), "p95": _num(pct[3]), "p99": _num(pct[4]),
        "max": _num(r.max()),
        "positive_fraction": _num((r > 0).mean()),
    }


def lot_pnls(result: BacktestResult) -> np.ndarray:
    """Realised P&L of every sell, plus the unrealised P&L of each position still open at the end."""
    t = result.trades
    pnl = t.loc[t["side"] == "sell", "realised_pnl"].to_numpy(dtype="float64")
    still_open = np.array([p["value"] - p["cost"] for p in result.open_positions], dtype="float64")
    return np.concatenate([pnl, still_open])


def compute_metrics(result: BacktestResult) -> dict:
    eq = result.equity.to_numpy(dtype="float64")
    r = eq[1:] / eq[:-1] - 1.0
    n = len(r)
    N = bars_per_year(result.config.interval)
    growth = eq[-1] / eq[0]
    with np.errstate(over="ignore"):  # a huge annualised figure on a very short window becomes null
        cagr = growth ** (N / n) - 1.0 if n > 0 and growth > 0 else float("nan")
    mdd = max_drawdown(eq)
    t = result.trades
    notional = float(t["notional"].sum())
    turnover = notional / float(eq.mean())
    pnl = lot_pnls(result)
    gains, losses = float(pnl[pnl > 0].sum()), float(-pnl[pnl < 0].sum())
    return {
        "total_return": _num(growth - 1.0),
        "cagr": _num(cagr),
        "volatility": _num(r.std(ddof=1) * math.sqrt(N)) if n > 1 else None,
        "sharpe": _num(sharpe_ratio(r, N)),
        "sortino": _num(sortino_ratio(r, N)),
        "max_drawdown": _num(mdd),
        "calmar": _num(cagr / mdd) if mdd > 0 else None,
        "turnover": _num(turnover),
        "turnover_annual": _num(turnover * N / n) if n > 0 else None,
        "trades": int(len(t)),
        "closed_lots": int(len(pnl)),
        "win_rate": _num((pnl > 0).mean()) if len(pnl) else None,
        "profit_factor": _num(gains / losses) if losses > 0 else None,
        "fees_paid": _num(t["fee"].sum()),
        "slippage_paid": _num(t["slippage"].sum()),
        "exposure": _num(result.exposure.mean()),
        "bars": int(len(eq)),
        "final_equity": _num(eq[-1]),
        "returns": return_distribution(r),
    }


def window(result: BacktestResult) -> list[str]:
    return [result.equity.index[0].isoformat(), result.equity.index[-1].isoformat()]


def equity_points(equity: pd.Series) -> list:
    return [[ts.isoformat(), round(float(v), 6)] for ts, v in equity.items()]
