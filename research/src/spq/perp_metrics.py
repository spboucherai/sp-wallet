"""Metrics of one perpetual-futures backtest window: every key of spq.metrics (same definitions) plus

- realised_pnl, funding_pnl      USD; funding_pnl < 0 means the account paid funding on balance
- fees_paid                      USD, trading fees + liquidation penalties; liquidation_penalties is the penalty part
- slippage_paid                  USD
- exposure                       mean gross exposure / equity (the v1 key: for a long-only spot run this was the
                                 invested fraction)
- long_exposure, short_exposure  mean long notional / equity and mean short notional / equity (both positive)
- gross_leverage_mean / _max     (long + short notional) / equity at bar closes
- net_leverage_mean / _max / _min  (long - short notional) / equity; _max and _min are the extremes reached
- time_in_market                 share of bars that end with at least one position
- avg_holding_bars / _hours      mean length of an uninterrupted run of bars with a position of the same sign in
                                 one symbol (a flip ends a run; a run still open at the end counts as it stands)
- liquidations                   account liquidations (each closes every perpetual position)
- wiped_out                      true when equity reached zero: the run stopped there
- margin_utilisation_mean / _max initial margin in use / margin equity, over the bars with a perpetual position
- worst_intrabar_drawdown        max over bars of 1 - (equity with every long at the bar's low and every short at
                                 its high) / (highest closing equity before that bar). It is >= max_drawdown, which
                                 only looks at closes. Positive fraction.
- orders_cut, orders_refused     orders reduced or dropped by the initial-margin check
- funding_payments, funding_missing  settlements charged, and settlements the data did not have while a position
                                 was open (charged as zero)

win_rate and profit_factor are on closing fills: realised PnL of the closed part minus the fee and slippage of
that fill (entry costs are not allocated to lots), plus the unrealised PnL of each position still open.
"""
from __future__ import annotations

import math

import numpy as np

from .data.core import bars_per_year, interval_seconds
from .metrics import _num, max_drawdown, return_distribution, sharpe_ratio, sortino_ratio
from .perp_engine import PerpResult

PERP_KEYS = [
    "realised_pnl", "funding_pnl", "liquidation_penalties", "long_exposure", "short_exposure",
    "gross_leverage_mean", "gross_leverage_max", "net_leverage_mean", "net_leverage_max", "net_leverage_min",
    "time_in_market", "avg_holding_bars", "avg_holding_hours", "liquidations", "wiped_out",
    "margin_utilisation_mean", "margin_utilisation_max", "worst_intrabar_drawdown", "orders_cut", "orders_refused",
    "funding_payments", "funding_missing",
]


def perp_lot_pnls(result: PerpResult) -> np.ndarray:
    """Net PnL of every closing fill, plus the unrealised PnL of each position still open at the end."""
    t = result.trades
    closing = t[t["kind"].isin(["reduce", "close", "flip"])]
    pnl = np.array([float(r - f - s) for r, f, s in zip(closing["realised_pnl"], closing["fee"], closing["slippage"])],
                   dtype="float64")
    still_open = np.array([float(p["unrealised_pnl"]) for p in result.open_positions], dtype="float64")
    return np.concatenate([pnl, still_open])


def holding_runs(weights: np.ndarray) -> list[int]:
    """Lengths (bars) of the runs of consecutive bars with the same non-zero sign, per column."""
    runs = []
    sign = np.sign(weights)
    for m in range(sign.shape[1]):
        col = sign[:, m]
        length, cur = 0, 0.0
        for v in col:
            if v != 0 and v == cur:
                length += 1
            else:
                if cur != 0:
                    runs.append(length)
                cur, length = v, (1 if v != 0 else 0)
        if cur != 0:
            runs.append(length)
    return runs


def worst_intrabar_drawdown(result: PerpResult) -> float:
    eq = result.equity.to_numpy(dtype="float64")
    worst = result.worst_equity.to_numpy(dtype="float64")
    if len(eq) == 0:
        return 0.0
    peak_before = np.maximum.accumulate(np.concatenate([[float(result.config.initial_cash)], eq[:-1]]))
    with np.errstate(divide="ignore", invalid="ignore"):
        dd = 1.0 - np.minimum(worst, eq) / peak_before
    return float(np.nanmax(dd))


def compute_perp_metrics(result: PerpResult) -> dict:
    eq = result.equity.to_numpy(dtype="float64")
    r = result.returns.to_numpy(dtype="float64")
    n = len(r)
    N = bars_per_year(result.config.interval)
    growth = eq[-1] / eq[0] if eq[0] > 0 else 0.0
    with np.errstate(over="ignore"):
        cagr = growth ** (N / n) - 1.0 if n > 0 and growth > 0 else (-1.0 if result.wiped_out else float("nan"))
    mdd = max_drawdown(eq) if eq[0] > 0 else 1.0
    t = result.trades
    notional = float(sum(t["notional"])) if len(t) else 0.0
    mean_eq = float(eq.mean())
    turnover = notional / mean_eq if mean_eq > 0 else float("nan")
    pnl = perp_lot_pnls(result)
    gains, losses = float(pnl[pnl > 0].sum()), float(-pnl[pnl < 0].sum())
    gross = result.exposure.to_numpy()
    net = result.net_exposure.to_numpy()
    w = result.weights.to_numpy()
    in_market = np.abs(w).sum(axis=1) > 0
    runs = holding_runs(w)
    util = result.margin_utilisation.to_numpy()
    util = util[(util > 0) & np.isfinite(util)]
    led = result.ledger
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
        "fees_paid": _num(float(led["fees"])),
        "slippage_paid": _num(float(led["slippage"])),
        "exposure": _num(gross.mean()),
        "bars": int(len(eq)),
        "final_equity": _num(eq[-1]),
        "returns": return_distribution(r),
        # ------------------------------------------------------------------------------------------- perps
        "realised_pnl": _num(float(led["realised_pnl"])),
        "funding_pnl": _num(float(led["funding"])),
        "liquidation_penalties": _num(float(led["liquidation_penalties"])),
        "long_exposure": _num(result.long_exposure.mean()),
        "short_exposure": _num(result.short_exposure.mean()),
        "gross_leverage_mean": _num(gross.mean()),
        "gross_leverage_max": _num(gross.max()),
        "net_leverage_mean": _num(net.mean()),
        "net_leverage_max": _num(net.max()),
        "net_leverage_min": _num(net.min()),
        "time_in_market": _num(in_market.mean()),
        "avg_holding_bars": _num(np.mean(runs)) if runs else None,
        "avg_holding_hours": _num(np.mean(runs) * interval_seconds(result.config.interval) / 3600.0) if runs else None,
        "liquidations": int(len(result.liquidations)),
        "wiped_out": bool(result.wiped_out),
        "margin_utilisation_mean": _num(util.mean()) if len(util) else 0.0,
        "margin_utilisation_max": _num(util.max()) if len(util) else 0.0,
        "worst_intrabar_drawdown": _num(worst_intrabar_drawdown(result)),
        "orders_cut": int(result.counters["orders_cut"]),
        "orders_refused": int(result.counters["orders_refused"]),
        "funding_payments": int(result.counters["funding_payments"]),
        "funding_missing": int(result.counters["funding_missing"]),
    }


def ledger_report(result: PerpResult) -> dict:
    """The exact ledger as decimal strings (JSON has no exact decimal type)."""
    from .margin import dstr

    return {k: (dstr(v) if not isinstance(v, bool) else v) for k, v in result.ledger.items()}
