# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/src/spq/robustness.py
# Description      : Robustness analyses: parameter sensitivity, walk-forward,
#                    bootstrap, Monte Carlo, stress windows, look-ahead check.
# Module           : spq
# Repository       : https://git.spboucher.ai/sp-wallet
# Project Website  : https://wallet.spboucher.ai
# Created          : 2026-11-10
# Last Modified    : 2026-11-10
#
# =============================================================================
# AUTHOR & PROFESSIONAL AFFILIATION
# =============================================================================
#
# Author           : Simon-Pierre Boucher
# Position         : Professor of Finance
# Institution      : Université du Québec en Outaouais (UQO)
# Department       : Département des sciences administratives
# Organization     : SP Boucher
#
# Website          : https://spboucher.ai
# Git              : https://git.spboucher.ai
#
# =============================================================================
# OFFICIAL CONTACT DIRECTORY
# =============================================================================
#
# General          : info@spboucher.ai
# Professional     : contact@spboucher.ai
# Direct           : simon@spboucher.ai
# Research         : research@spboucher.ai
# Development      : dev@spboucher.ai
# Support          : support@spboucher.ai
# Security/Admin   : admin@spboucher.ai
# Notifications    : notifications@spboucher.ai
#
# Preferred Contact: support@spboucher.ai
#
# =============================================================================
# COPYRIGHT & INTELLECTUAL PROPERTY
# =============================================================================
#
# Copyright (c) 2026
# Simon-Pierre Boucher
#
# All rights reserved where applicable.
#
# This file is governed by the applicable project license,
# copyright notices, institutional agreements and relevant law.
#
# Unless expressly authorized by the applicable license or
# rights holder, copying, redistribution, sublicensing,
# publication and commercial exploitation are not permitted.
#
# Existing third-party rights and notices remain unaffected.
#
# =============================================================================
# CONFIDENTIALITY & SECURITY
# =============================================================================
#
# Classification   : Public
# Distribution     : Public repository; use is governed by the project license
# Security Contact : admin@spboucher.ai
#
# Access to this source does not independently grant permission
# to redistribute or disclose confidential materials.
#
# Do not embed credentials, private keys, access tokens,
# certificates or confidential personal information.
#
# =============================================================================
# LICENSE & MAINTENANCE
# =============================================================================
#
# License          : None specified (no license file in this repository)
# Maintainer       : Simon-Pierre Boucher
# Technical Contact: dev@spboucher.ai
#
# =============================================================================
# END OF SP BOUCHER SOURCE HEADER
# =============================================================================

"""Robustness analyses: parameter sensitivity, walk-forward, bootstrap, Monte Carlo, stress windows, look-ahead check.

Everything that compares configurations takes an `Experiment` and therefore only sees train + validation data.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .data.core import bars_per_year, interval_seconds
from .engine import BacktestConfig, BacktestResult, run_backtest
from .metrics import _num, max_drawdown, sharpe_ratio
from .research import Experiment, TestSplitError, params_key
from .strategy import Strategy


# ------------------------------------------------------------------------------------- sensitivity / selection

def parameter_sensitivity(exp: Experiment, strategy: Strategy, grid: list[dict]) -> list[dict]:
    """Run every configuration of `grid` on the development range; report train and validation figures.

    A configuration that makes the strategy fail is reported with its error instead of stopping the analysis.
    """
    N = bars_per_year(exp.config.interval)
    rows = []
    for p in grid:
        row: dict = {"params": p}
        try:
            res = exp.trial(strategy, p)
        except TestSplitError:
            raise
        except Exception as e:  # noqa: BLE001 - a bad corner of the grid is a finding, not a crash
            row["error"] = f"{type(e).__name__}: {e}"
            rows.append(row)
            continue
        for split in ("train", "validation"):
            r = exp.split_returns(res, split)
            row[f"{split}_sharpe"] = _num(sharpe_ratio(r, N))
            row[f"{split}_return"] = _num(np.prod(1.0 + r) - 1.0)
        start, end = exp.splits.window("validation")
        t = res.trades
        row["validation_trades"] = int(((t["ts"] >= start) & (t["ts"] < end)).sum()) if len(t) else 0
        rows.append(row)
    return rows


def select_params(rows: list[dict], metric: str = "validation_sharpe") -> dict | None:
    """Best configuration of a sensitivity table according to a VALIDATION (or train) metric."""
    if not metric.startswith(("validation_", "train_")):
        raise ValueError("selection metrics are train_* or validation_* only")
    ok = [r for r in rows if r.get(metric) is not None]
    return max(ok, key=lambda r: r[metric])["params"] if ok else None


def walk_forward(exp: Experiment, strategy: Strategy, grid: list[dict], n_folds: int = 4) -> list[dict]:
    """Rolling walk-forward inside the development range.

    The range is cut into n_folds + 2 equal chunks. Fold f selects, among `grid`, the configuration with the best
    Sharpe ratio on chunks [f, f+2) (in-sample), then that configuration is backtested from cash on chunk f+2
    (out-of-sample, with earlier bars as lookback history only). In-sample figures are read from the
    development-range run of each configuration (one run per configuration, shared with the sensitivity table).
    """
    index = next(iter(exp.dev_data().values())).index
    c = len(index) // (n_folds + 2)
    if c < 10:
        return []
    N = bars_per_year(exp.config.interval)
    runs = []
    for p in grid:
        try:
            runs.append((p, exp.trial(strategy, p).returns))
        except TestSplitError:
            raise
        except Exception:  # noqa: BLE001 - already reported by parameter_sensitivity
            continue
    folds = []
    for f in range(n_folds):
        is_a, is_b, oos_b = index[f * c], index[(f + 2) * c], index[min((f + 3) * c, len(index) - 1)]
        best, best_sr = None, -math.inf
        for p, r in runs:
            sr = sharpe_ratio(r[(r.index >= is_a) & (r.index < is_b)].to_numpy(), N)
            if math.isfinite(sr) and sr > best_sr:
                best, best_sr = p, sr
        row = {"in_sample": [is_a.isoformat(), is_b.isoformat()], "out_of_sample": [is_b.isoformat(), oos_b.isoformat()],
               "params": best, "in_sample_sharpe": _num(best_sr) if best is not None else None}
        if best is not None:
            res = exp.run_window(strategy, is_b, oos_b, best)
            r = res.returns.to_numpy()
            row["out_of_sample_sharpe"] = _num(sharpe_ratio(r, N))
            row["out_of_sample_return"] = _num(res.equity.iloc[-1] / res.equity.iloc[0] - 1.0)
            row["out_of_sample_max_drawdown"] = _num(max_drawdown(res.equity.to_numpy()))
            row["out_of_sample_trades"] = int(len(res.trades))
        folds.append(row)
    return folds


# -------------------------------------------------------------------------------------------- resampling

def _stationary_indices(n: int, n_samples: int, mean_block: float, rng: np.random.Generator) -> np.ndarray:
    """Politis-Romano stationary bootstrap: blocks of geometric length (mean `mean_block`), wrapping around."""
    starts = rng.integers(0, n, size=(n_samples, n))
    new_block = rng.random((n_samples, n)) < 1.0 / mean_block
    new_block[:, 0] = True
    pos = np.arange(n)[None, :]
    last_start = np.maximum.accumulate(np.where(new_block, pos, 0), axis=1)
    origin = np.take_along_axis(starts, last_start, axis=1)
    return (origin + pos - last_start) % n


def default_block(n: int, interval: str) -> int:
    """Mean block length: one day of bars, at least n^(1/3), at most n/10."""
    per_day = max(1, 86400 // interval_seconds(interval))
    return int(max(1, min(max(per_day, round(n ** (1 / 3))), max(1, n // 10))))


def bootstrap_sharpe_ci(returns, interval: str, *, n_samples: int = 2000, mean_block: int | None = None,
                        level: float = 0.95, seed: int = 0) -> dict:
    """Stationary block bootstrap percentile confidence interval of the annualised Sharpe ratio."""
    r = np.asarray(returns, dtype="float64")
    n = len(r)
    if n < 20 or not r.std() > 0:
        return {"ci": [None, None], "level": level, "n_samples": 0, "mean_block": None}
    block = mean_block or default_block(n, interval)
    rng = np.random.default_rng(seed)
    sharpes = []
    chunk = max(1, min(n_samples, 4_000_000 // n))
    for lo in range(0, n_samples, chunk):
        x = r[_stationary_indices(n, min(chunk, n_samples - lo), block, rng)]
        sd = x.std(axis=1, ddof=1)
        with np.errstate(divide="ignore", invalid="ignore"):
            sharpes.append(np.where(sd > 0, x.mean(axis=1) / sd, np.nan))
    s = np.concatenate(sharpes) * math.sqrt(bars_per_year(interval))
    alpha = (1.0 - level) / 2.0
    lo_, hi_ = np.nanpercentile(s, [100 * alpha, 100 * (1 - alpha)])
    return {"ci": [_num(lo_), _num(hi_)], "level": level, "n_samples": int(n_samples), "mean_block": int(block),
            "method": "stationary bootstrap (Politis & Romano 1994), percentile interval"}


def monte_carlo(returns, lot_pnl, initial_equity: float, *, n_samples: int = 2000, seed: int = 0) -> dict:
    """Two resampling experiments on one backtest.

    bar_returns: bars drawn with replacement (i.i.d., which destroys serial dependence) and compounded: spread of
    the total return and of the maximum drawdown that the same set of bar returns can produce in another order.
    lots: closed-lot P&Ls drawn with replacement and summed, relative to the initial equity: how much the result
    depends on a few trades.
    """
    rng = np.random.default_rng(seed)
    r = np.asarray(returns, dtype="float64")
    out: dict = {"n_samples": int(n_samples), "bar_returns": None, "lots": None}
    if len(r) >= 20:
        tot, mdd = [], []
        chunk = max(1, min(n_samples, 4_000_000 // len(r)))
        for lo in range(0, n_samples, chunk):
            x = r[rng.integers(0, len(r), size=(min(chunk, n_samples - lo), len(r)))]
            eq = np.cumprod(1.0 + x, axis=1)
            tot.append(eq[:, -1] - 1.0)
            peak = np.maximum(np.maximum.accumulate(eq, axis=1), 1.0)
            mdd.append((1.0 - eq / peak).max(axis=1))
        tot, mdd = np.concatenate(tot), np.concatenate(mdd)
        out["bar_returns"] = {
            "total_return_p05": _num(np.percentile(tot, 5)), "total_return_p50": _num(np.percentile(tot, 50)),
            "total_return_p95": _num(np.percentile(tot, 95)), "probability_of_loss": _num((tot < 0).mean()),
            "max_drawdown_p50": _num(np.percentile(mdd, 50)), "max_drawdown_p95": _num(np.percentile(mdd, 95)),
        }
    pnl = np.asarray(lot_pnl, dtype="float64")
    if len(pnl) >= 5:
        s = pnl[rng.integers(0, len(pnl), size=(n_samples, len(pnl)))].sum(axis=1) / initial_equity
        out["lots"] = {
            "n_lots": int(len(pnl)), "pnl_fraction_p05": _num(np.percentile(s, 5)),
            "pnl_fraction_p50": _num(np.percentile(s, 50)), "pnl_fraction_p95": _num(np.percentile(s, 95)),
            "probability_of_loss": _num((s < 0).mean()),
        }
    return out


# ------------------------------------------------------------------------------------------------ stress

def drawdown_episodes(equity: pd.Series, top: int = 3) -> list[dict]:
    """Largest non-overlapping peak-to-trough declines.

    The maximum drawdown of the series is taken first; the search then continues separately in the bars before
    its peak and in the bars after its trough, and so on, until `top` windows are found.
    """
    eq = equity.to_numpy(dtype="float64")

    def deepest(a: int, b: int):
        if b - a < 2:
            return None
        seg = eq[a:b]
        dd = 1.0 - seg / np.maximum.accumulate(seg)
        t = int(np.argmax(dd))
        if not dd[t] > 0:
            return None
        return float(dd[t]), a + int(np.argmax(seg[:t + 1])), a + t, a, b

    candidates = [c for c in [deepest(0, len(eq))] if c]
    episodes = []
    while candidates and len(episodes) < top:
        candidates.sort()
        depth, p, t, a, b = candidates.pop()
        episodes.append({"peak": equity.index[p], "trough": equity.index[t], "depth": depth})
        candidates += [c for c in (deepest(a, p), deepest(t + 1, b)) if c]
    return episodes


def stress_windows(strategy_equity: pd.Series, benchmark_equity: pd.Series, top: int = 3) -> list[dict]:
    """Strategy behaviour during the benchmark's largest drawdowns (same split, same bars)."""
    out = []
    for e in drawdown_episodes(benchmark_equity, top):
        s = strategy_equity.loc[e["peak"]:e["trough"]]
        out.append({
            "window": [e["peak"].isoformat(), e["trough"].isoformat()],
            "benchmark_return": _num(-e["depth"]),
            "strategy_return": _num(s.iloc[-1] / s.iloc[0] - 1.0),
            "strategy_max_drawdown": _num(max_drawdown(s.to_numpy())),
        })
    return out


# ---------------------------------------------------------------------------------------------- look-ahead

def lookahead_check(strategy: Strategy, data: dict[str, pd.DataFrame], config: BacktestConfig, *,
                    params: dict | None = None, start=None, end=None, cuts=(0.5, 0.8),
                    max_bars: int = 1500, runner=run_backtest) -> dict:
    """Truncation test: decisions and equity up to bar t must not change when every bar after t is removed.

    A base run is made on (at most) the last `max_bars` bars of [start, end). For each cut, the data are truncated
    after the cut bar and the run is repeated; the target weights decided up to the cut (the decision taken ON the
    cut bar included) and the equity up to the cut must be identical. This fails if the engine hands future bars
    to the strategy or if fills use information beyond the fill bar. It cannot see a strategy that obtains future
    data from outside its inputs (a file, the network): that is what the purity guard and the static check are for.
    `runner` is the backtest function (replaced by a deliberately leaky one in the tests of this check).
    """
    index = next(iter(data.values())).index
    a = 0 if start is None else int(index.searchsorted(pd.Timestamp(start), side="left"))
    b = len(index) if end is None else int(index.searchsorted(pd.Timestamp(end), side="left"))
    a = max(a, b - max_bars)
    if b - a < 10:
        return {"status": "fail", "detail": "window too short for the look-ahead check"}
    try:
        base = runner(strategy, data, config, start=index[a], end=None if b >= len(index) else index[b],
                      params=params)
        for c in cuts:
            cut = a + max(3, int((b - a) * c))
            trunc = {s: df.iloc[:cut + 1] for s, df in data.items()}
            part = runner(strategy, trunc, config, start=index[a], params=params)
            eq_full = base.equity.loc[part.equity.index].to_numpy()
            if not np.allclose(eq_full, part.equity.to_numpy(), rtol=1e-10, atol=1e-10):
                return {"status": "fail", "detail": f"equity before {index[cut]} changes when later bars are removed"}
            d_full = base.decisions.loc[base.decisions.index <= index[cut]]
            if not (d_full.index.equals(part.decisions.index)
                    and np.allclose(d_full.to_numpy(), part.decisions.to_numpy(), rtol=0, atol=1e-12)):
                return {"status": "fail",
                        "detail": f"decisions before {index[cut]} change when later bars are removed"}
    except Exception as e:  # noqa: BLE001
        return {"status": "fail", "detail": f"{type(e).__name__}: {e}"}
    return {"status": "pass", "detail": f"truncation test on {b - a} bars, cuts at {list(cuts)}, "
                                        f"{len(base.decisions)} decisions compared"}


__all__ = [
    "parameter_sensitivity", "select_params", "walk_forward", "bootstrap_sharpe_ci", "monte_carlo",
    "drawdown_episodes", "stress_windows", "lookahead_check", "default_block", "params_key", "BacktestResult",
]
