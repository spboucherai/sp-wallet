"""Research discipline for perpetual strategies: the Experiment of spq.research with the perp backtester.

Nothing is relaxed: selection code only sees train + validation bars — and, because funding, premium, mark and
index are columns of the same frames, only the funding settled before the test split —, the test split is
reachable once through `final_test()`, every configuration is a counted trial.

Benchmarks (no parameter, so they may be computed on any split):
- `perp_long_1x`: the perpetuals bought once at 1x, equal weights, and held — price PnL AND funding, same costs;
- `buy_and_hold`: the same assets bought once on the SPOT market and held (spot candles, the spot engine and its
  costs); when no spot data are supplied this key holds the perpetual's own price without funding and the report
  says so;
- `perp_long_1x_<SYM>` per perpetual when there are several.

Stress windows specific to perps: `funding_stress` picks, inside one split, the windows where funding was the most
positive and the most negative on average (the regimes that hurt a long and a short respectively).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .engine import BacktestConfig, buy_and_hold
from .metrics import _num, max_drawdown
from .perp_engine import PerpConfig, PerpResult, perp_hold, run_perp_backtest
from .research import Experiment
from .strategy import is_spot_leg


class PerpExperiment(Experiment):
    _runner = staticmethod(run_perp_backtest)

    def __init__(self, data, config: PerpConfig, *, fractions=(0.6, 0.2, 0.2), ledger=None,
                 spot_data: dict[str, pd.DataFrame] | None = None):
        if not isinstance(config, PerpConfig):
            raise TypeError("PerpExperiment needs a PerpConfig")
        super().__init__(data, config, fractions=fractions, ledger=ledger)
        self.spot_data = dict(spot_data or {})
        self.perps = [s for s in self.symbols if not is_spot_leg(s)]

    def benchmarks(self, split: str) -> dict:
        start, end = self.splits.window(split)
        data = self.lookahead_data() if split == "test" else self.dev_data()
        perp = {s: data[s] for s in self.perps}
        out = {"perp_long_1x": perp_hold(perp, self.config, start=start, end=end)}
        if len(self.perps) > 1:
            for s in self.perps:
                out[f"perp_long_1x_{s}"] = perp_hold({s: perp[s]}, self.config, start=start, end=end)
        spot = {s: self.spot_data[s] for s in self.perps if s in self.spot_data}
        if len(spot) == len(self.perps):
            common = None
            for df in spot.values():
                common = df.index if common is None else common.intersection(df.index)
            spot = {s: df.loc[common] for s, df in spot.items()}
            cfg = BacktestConfig(self.config.interval, fee_bps=self.config.spot_fee_bps,
                                 slippage_bps=self.config.spot_slippage_bps, initial_cash=self.config.initial_cash)
            out["buy_and_hold"] = buy_and_hold(spot, cfg, start=start, end=end)
            self.buy_and_hold_is_spot = True
        else:
            no_funding = {s: df.drop(columns=[c for c in ("funding", "premium", "index", "mark") if c in df.columns])
                          for s, df in perp.items()}
            out["buy_and_hold"] = perp_hold(no_funding, self.config, start=start, end=end)
            self.buy_and_hold_is_spot = False
        return out


def funding_regimes(data: dict[str, pd.DataFrame], start, end, *, window_bars: int, top: int = 2) -> list[dict]:
    """Non-overlapping windows of `window_bars` bars inside [start, end) with the highest and the lowest mean
    funding rate (average over the perpetuals that have a `funding` column, per bar)."""
    cols = [df["funding"] for s, df in data.items() if not is_spot_leg(s) and "funding" in df.columns]
    if not cols:
        return []
    f = pd.concat(cols, axis=1).mean(axis=1, skipna=True)
    f = f[(f.index >= start) & (f.index < end)]
    if len(f) < 2 * window_bars or f.notna().sum() < window_bars:
        return []
    roll = f.rolling(window_bars, min_periods=max(2, window_bars // 2)).mean().to_numpy()
    out = []
    for label, sign in (("highest funding", 1.0), ("lowest funding", -1.0)):
        score = np.where(np.isfinite(roll), sign * roll, -np.inf)
        score[: window_bars - 1] = -np.inf
        for _ in range(top):
            e = int(np.argmax(score))
            if not np.isfinite(score[e]):
                break
            out.append({"regime": label, "start": f.index[e - window_bars + 1], "end": f.index[e],
                        "mean_rate": float(roll[e])})
            score[max(0, e - window_bars + 1): e + window_bars] = -np.inf
    return out


def funding_stress(result: PerpResult, benchmark: PerpResult, data, start, end, *, window_bars: int,
                   bars_per_year: float, top: int = 2) -> list[dict]:
    """Strategy and benchmark during the most extreme funding regimes of the split (same bars)."""
    out = []
    for w in funding_regimes(data, start, end, window_bars=window_bars, top=top):
        s = result.equity.loc[w["start"]:w["end"]]
        bq = benchmark.equity.loc[w["start"]:w["end"]]
        if len(s) < 2 or not s.iloc[0] > 0:
            continue
        f = result.funding
        paid = f[(f["ts"] >= w["start"]) & (f["ts"] <= w["end"])]["amount"]
        out.append({
            "regime": w["regime"], "window": [w["start"].isoformat(), w["end"].isoformat()],
            "mean_funding_rate_per_bar": _num(w["mean_rate"]),
            "mean_funding_rate_annualised": _num(w["mean_rate"] * bars_per_year),
            "strategy_return": _num(s.iloc[-1] / s.iloc[0] - 1.0),
            "strategy_max_drawdown": _num(max_drawdown(s.to_numpy())),
            "strategy_funding_pnl": _num(float(sum(paid)) if len(paid) else 0.0),
            "benchmark_return": _num(bq.iloc[-1] / bq.iloc[0] - 1.0) if len(bq) > 1 and bq.iloc[0] > 0 else None,
        })
    return out
