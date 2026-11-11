"""Every strategy of the library returns valid weights on synthetic data."""
from __future__ import annotations

import json
import subprocess
import sys

import numpy as np
import pandas as pd
import pytest

from conftest import LIBRARY, ROOT, make_data
from spq.engine import BacktestConfig, run_backtest
from spq.strategy import load_strategy, sha256_file, validate_weights

EXPECTED = {"ts_momentum", "ma_trend", "mean_reversion", "donchian_breakout", "vol_target_trend", "xs_momentum",
            "pairs_rotation", "garch_regime"}
IDS = [f"{d.parent.name}/{d.name}" for d in LIBRARY]


def synthetic(strategy, n, seed):
    """Random walks with different drifts so that trends, breakouts and rank changes all occur."""
    drifts = [0.0004, -0.0003, 0.0001, 0.0]
    out = {}
    for i, sym in enumerate(strategy.universe):
        out.update(make_data(n, (sym,), seed=seed + 31 * i, drift=drifts[i % 4], sigma=0.012, p0=50.0 * (i + 1)))
    return out


def test_the_library_is_complete():
    assert {d.parent.name for d in LIBRARY} == EXPECTED
    for d in LIBRARY:
        readme = (d / "README.md").read_text()
        assert "**Hypothesis.**" in readme and "**What would refute it.**" in readme, d


@pytest.mark.parametrize("directory", LIBRARY, ids=IDS)
def test_library_strategy_contract(directory):
    s = load_strategy(directory)                      # strict: passes the static purity check
    assert s.static_problems == [] and s.sha256 == sha256_file(directory / "strategy.py")
    assert s.name == directory.parent.name and s.meta["version"] == directory.name
    assert s.meta["interval"] == "1h" and s.universe == ["ETH", "BTC", "LINK", "SOL"]

    full = synthetic(s, s.lookback + 400, seed=5)
    stride = 97 if s.name != "garch_regime" else 199
    seen_invested = False
    for end in range(s.lookback, s.lookback + 400, stride):
        view = {sym: df.iloc[end - s.lookback:end] for sym, df in full.items()}
        before = {sym: df.copy() for sym, df in view.items()}
        raw = s.raw(view)
        w = validate_weights(raw, s.universe)         # dict, finite, each in [0, 1], known symbols, sum <= 1
        assert set(w) == set(s.universe) and all(0.0 <= x <= 1.0 for x in w.values())
        assert sum(w.values()) <= 1.0 + 1e-9
        assert s.raw(view) == raw                     # pure: same inputs, same output
        for sym in view:
            pd.testing.assert_frame_equal(view[sym], before[sym])   # inputs are not modified
        seen_invested |= sum(w.values()) > 0
    assert seen_invested, "the strategy never invested on trending synthetic data"

    # degenerate inputs: too little history, a constant price, a subset of the universe
    tiny = {sym: df.iloc[:3] for sym, df in full.items()}
    assert sum(validate_weights(s.raw(tiny), s.universe).values()) <= 1.0
    flat = {sym: df.assign(open=10.0, high=10.0, low=10.0, close=10.0).iloc[:s.lookback] for sym, df in full.items()}
    assert sum(validate_weights(s.raw(flat), s.universe).values()) <= 1.0
    two = {sym: full[sym].iloc[:s.lookback] for sym in ("ETH", "BTC")}
    assert sum(validate_weights(s.raw(two), ["ETH", "BTC"]).values()) <= 1.0 + 1e-9


@pytest.mark.parametrize("directory", LIBRARY, ids=IDS)
def test_library_strategy_runs_in_the_backtester_and_the_signal_runner(directory, tmp_path):
    s = load_strategy(directory)
    every = 24 if s.name == "garch_regime" else 1
    n = s.lookback + (24 * 12 if every == 24 else 300)
    data = synthetic(s, n, seed=9)
    res = run_backtest(s, data, BacktestConfig("1h", rebalance_threshold=0.05, decision_every=every))
    assert len(res.decisions) > 0 and np.isfinite(res.equity.to_numpy()).all() and (res.equity > 0).all()
    assert (res.cash >= -1e-9).all() and res.exposure.between(0, 1 + 1e-9).all()
    assert (res.decisions.sum(axis=1) <= 1 + 1e-9).all() and (res.decisions.to_numpy() >= 0).all()

    # the engine's entry point gives the same answer as the last decision of the backtest
    payload = {"candles": {sym: [[ts.strftime("%Y-%m-%dT%H:%M:%SZ"), *map(float, row)] for ts, row in
                                 zip(df.index[-s.lookback:], df.to_numpy()[-s.lookback:])] for sym, df in data.items()}}
    f = tmp_path / "in.json"
    f.write_text(json.dumps(payload))
    p = subprocess.run([sys.executable, "-m", "spq.signal", "--strategy", str(directory), "--sha256", s.sha256,
                        "--input", str(f)], capture_output=True, text=True, cwd=ROOT, timeout=300)
    assert p.returncode == 0, p.stderr
    out = json.loads(p.stdout)
    assert out["strategy_sha256"] == s.sha256 and out["as_of"] == data["ETH"].index[-1].strftime("%Y-%m-%dT%H:%M:%SZ")
    last = res.decisions.iloc[-1]
    if res.decisions.index[-1] == data["ETH"].index[-1]:
        assert out["weights"] == pytest.approx(last.to_dict(), abs=1e-12)
