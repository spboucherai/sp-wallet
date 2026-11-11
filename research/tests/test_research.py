"""Split enforcement and the robustness toolbox."""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from conftest import make_data
from spq.engine import BacktestConfig
from spq.research import (Experiment, Splits, TestSplitError, cartesian_grid, one_at_a_time_grid, read_ledger)
from spq.robustness import (_stationary_indices, bootstrap_sharpe_ci, drawdown_episodes, monte_carlo,
                            parameter_sensitivity, select_params, stress_windows, walk_forward)
from spq.strategy import from_function

CFG = BacktestConfig("1h", rebalance_threshold=0.05)


def trend(data, params):
    w = int(params["window"])
    return {s: (1.0 / len(data) if df["close"].iloc[-1] > df["close"].iloc[-w] else 0.0) for s, df in data.items()}


def make_strategy(name="trend", window=24):
    return from_function(trend, {"name": name, "version": "1", "universe": ["AAA", "BBB"], "interval": "1h",
                                 "lookback": 100, "params": {"window": window}})


@pytest.fixture
def exp(tmp_path):
    return Experiment(make_data(2000, seed=3), CFG, ledger=tmp_path / "ledger.jsonl")


def test_splits_are_chronological_and_disjoint():
    idx = pd.date_range("2024-01-01", periods=1000, freq="1h", tz="UTC")
    s = Splits.chronological(idx)
    assert s.train == (idx[0], idx[600]) and s.validation == (idx[600], idx[800])
    assert s.test == (idx[800], idx[-1] + pd.Timedelta(hours=1))
    assert s.window("development") == (idx[0], idx[800])
    rep = s.to_report()
    assert rep["train"] == [idx[0].isoformat(), idx[599].isoformat()]
    assert rep["validation"] == [idx[600].isoformat(), idx[799].isoformat()]
    assert rep["test"] == [idx[800].isoformat(), idx[999].isoformat()]
    assert Splits.chronological(idx, (0.5, 0.25, 0.25)).test[0] == idx[750]
    for bad in ((0.6, 0.2), (0.6, 0.2, 0.3), (0.8, 0.2, 0.0)):
        with pytest.raises(ValueError):
            Splits.chronological(idx, bad)


def test_selection_code_cannot_obtain_test_bars(exp):
    s = make_strategy()
    test_start = exp.splits.test[0]
    assert all(df.index.max() < test_start for df in exp.dev_data().values())
    with pytest.raises(TestSplitError, match="final_test"):
        exp.run(s, "test")
    with pytest.raises(TestSplitError):
        exp.split_returns(exp.trial(s), "test")
    with pytest.raises(TestSplitError, match="reaches into the test split"):
        exp.run_window(s, exp.splits.validation[0], test_start + pd.Timedelta(hours=1))
    for split in ("train", "validation", "development"):
        res = exp.run(s, split)
        assert res.equity.index.max() < test_start
    assert exp.trial(s).equity.index.max() < test_start
    with pytest.raises(ValueError, match="train_\\* or validation_\\*"):
        select_params([{"params": {}, "test_sharpe": 1.0}], metric="test_sharpe")


def test_test_split_is_evaluated_once_then_selection_is_closed(exp):
    s = make_strategy()
    exp.trial(s, {"window": 12})
    exp.trial(s, {"window": 48})
    final = exp.final_test(s, {"window": 12})
    assert final.equity.index[0] == exp.splits.test[0] and final.equity.index[-1] == exp.splits.last["test"]
    # the same evaluation can be read again, it is not a new look
    again = exp.final_test(s, {"window": 12})
    pd.testing.assert_series_equal(final.equity, again.equity)
    assert len(exp.test_evaluations) == 1
    # another parameter set, or another version under the same name, is refused
    with pytest.raises(TestSplitError, match="already evaluated"):
        exp.final_test(s, {"window": 48})
    with pytest.raises(TestSplitError, match="already evaluated"):
        exp.final_test(s)  # META params (window 24) differ from the sealed ones
    # and no more tuning for that strategy
    for call in (lambda: exp.trial(s, {"window": 36}), lambda: exp.run(s, "validation"),
                 lambda: exp.run_window(s, exp.splits.train[0], exp.splits.validation[0]),
                 lambda: parameter_sensitivity(exp, s, [{"window": 36}]),
                 lambda: walk_forward(exp, s, [{"window": 36}])):
        with pytest.raises(TestSplitError, match="selection is closed"):
            call()
    # another strategy is not affected; benchmarks have no parameters and stay available
    other = make_strategy("other")
    exp.trial(other)
    assert set(exp.benchmarks("test")) == {"buy_and_hold", "equal_weight", "buy_and_hold_AAA", "buy_and_hold_BBB"}


def test_trials_are_counted_once_and_written_to_the_ledger(exp):
    s = make_strategy()
    rows = parameter_sensitivity(exp, s, [{"window": 12}, {"window": 24}, {"window": 48}, {"window": 24}])
    assert len(rows) == 4 and len(exp.trials) == 3                 # the repeated configuration is not a new trial
    assert all({"train_sharpe", "validation_sharpe", "validation_return", "validation_trades"} <= set(r) for r in rows)
    assert len(exp.trial_sharpes("validation")) == 3
    best = select_params(rows)
    assert best == max(rows, key=lambda r: r["validation_sharpe"])["params"]
    exp.final_test(s, best)
    ledger = read_ledger(exp.ledger_path)
    assert [r["kind"] for r in ledger] == ["trial", "trial", "trial", "test"]
    assert ledger[0]["params"] == {"window": 12} and ledger[0]["validation_bars"] > 0
    assert json.loads(exp.ledger_path.read_text().splitlines()[-1])["params"] == best
    # a failing configuration is reported, not fatal
    exp2 = Experiment(make_data(600, seed=1), CFG)
    rows = parameter_sensitivity(exp2, make_strategy(), [{"window": 24}, {"window": 5000}])
    assert "error" in rows[1] and "IndexError" in rows[1]["error"] and "validation_sharpe" in rows[0]


def test_grids():
    assert one_at_a_time_grid({"fast": 24, "slow": 168, "z": 2.0, "flag": True, "pairs": [["A", "B"]]}) == [
        {"fast": 24, "slow": 168, "z": 2.0, "flag": True, "pairs": [["A", "B"]]},
        {"fast": 12, "slow": 168, "z": 2.0, "flag": True, "pairs": [["A", "B"]]},
        {"fast": 48, "slow": 168, "z": 2.0, "flag": True, "pairs": [["A", "B"]]},
        {"fast": 24, "slow": 84, "z": 2.0, "flag": True, "pairs": [["A", "B"]]},
        {"fast": 24, "slow": 336, "z": 2.0, "flag": True, "pairs": [["A", "B"]]},
        {"fast": 24, "slow": 168, "z": 1.0, "flag": True, "pairs": [["A", "B"]]},
        {"fast": 24, "slow": 168, "z": 4.0, "flag": True, "pairs": [["A", "B"]]},
    ]
    grid = cartesian_grid({"fast": 24, "slow": 168}, {"fast": [12, 24], "slow": [168, 336]})
    assert len(grid) == 4 and grid[0] == {"fast": 24, "slow": 168}
    with pytest.raises(ValueError, match="not in META"):
        cartesian_grid({"fast": 24}, {"nope": [1]})


def test_walk_forward_folds_are_ordered_and_inside_development(exp):
    s = make_strategy()
    grid = [{"window": 12}, {"window": 24}, {"window": 48}]
    folds = walk_forward(exp, s, grid, n_folds=4)
    assert len(folds) == 4
    test_start = exp.splits.test[0]
    for f in folds:
        is_a, is_b = map(pd.Timestamp, f["in_sample"])
        oos_a, oos_b = map(pd.Timestamp, f["out_of_sample"])
        assert is_a < is_b == oos_a < oos_b <= test_start
        assert f["params"] in grid and "out_of_sample_sharpe" in f and "out_of_sample_return" in f
    assert [f["out_of_sample"][0] for f in folds] == sorted(f["out_of_sample"][0] for f in folds)
    assert len(exp.trials) == 3   # walk-forward reuses the three development runs


def test_stationary_bootstrap_blocks_and_interval():
    rng = np.random.default_rng(0)
    idx = _stationary_indices(500, 200, 20, rng)
    assert idx.shape == (200, 500) and idx.min() >= 0 and idx.max() < 500
    consecutive = (np.diff(idx, axis=1) % 500 == 1).mean()
    assert consecutive == pytest.approx(1 - 1 / 20, abs=0.01)         # a new block starts with probability 1/20

    r = np.random.default_rng(1).normal(0.0005, 0.01, 4000)
    out = bootstrap_sharpe_ci(r, "1h", n_samples=1000, seed=7)
    lo, hi = out["ci"]
    point = r.mean() / r.std(ddof=1) * np.sqrt(8760)
    assert lo < point < hi and out["mean_block"] == 24 and out["n_samples"] == 1000
    half_width = 1.96 * np.sqrt(8760 / 4000)                           # asymptotic standard error of a Sharpe ratio
    assert hi - lo == pytest.approx(2 * half_width, rel=0.15)
    assert bootstrap_sharpe_ci(r, "1h", n_samples=1000, seed=7)["ci"] == [lo, hi]   # reproducible
    assert bootstrap_sharpe_ci(np.zeros(100), "1h")["ci"] == [None, None]
    assert bootstrap_sharpe_ci(r[:5], "1h")["ci"] == [None, None]


def test_monte_carlo_summaries():
    r = np.random.default_rng(2).normal(0.0002, 0.01, 1500)
    lots = np.array([5.0, -2.0, 3.0, -1.0, 4.0, -6.0, 2.0])
    mc = monte_carlo(r, lots, 1000.0, n_samples=1000, seed=3)
    b, t = mc["bar_returns"], mc["lots"]
    assert b["total_return_p05"] < b["total_return_p50"] < b["total_return_p95"]
    assert 0 <= b["probability_of_loss"] <= 1 and 0 < b["max_drawdown_p50"] <= b["max_drawdown_p95"] < 1
    assert b["total_return_p50"] == pytest.approx(np.exp(np.log1p(r).sum()) - 1, abs=0.15)
    assert t["n_lots"] == 7 and t["pnl_fraction_p05"] < t["pnl_fraction_p50"] < t["pnl_fraction_p95"]
    assert t["pnl_fraction_p50"] == pytest.approx(lots.sum() / 1000, abs=0.004)
    assert monte_carlo(r[:5], lots[:2], 1000.0) == {"n_samples": 2000, "bar_returns": None, "lots": None}


def test_stress_windows_are_the_benchmark_drawdowns():
    idx = pd.date_range("2024-01-01", periods=9, freq="1h", tz="UTC")
    bench = pd.Series([100, 120, 90, 96, 130, 65, 70, 140, 133], index=idx, dtype=float)
    eps = drawdown_episodes(bench, top=3)
    assert [(e["peak"], e["trough"]) for e in eps] == [(idx[4], idx[5]), (idx[1], idx[2]), (idx[7], idx[8])]
    assert [e["depth"] for e in eps] == pytest.approx([0.5, 0.25, 0.05])
    strat = pd.Series([100, 100, 100, 100, 110, 99, 99, 99, 99], index=idx, dtype=float)
    out = stress_windows(strat, bench, top=2)
    assert out[0] == {"window": [idx[4].isoformat(), idx[5].isoformat()], "benchmark_return": pytest.approx(-0.5),
                      "strategy_return": pytest.approx(-0.1), "strategy_max_drawdown": pytest.approx(0.1)}
    assert out[1]["strategy_return"] == 0 and out[1]["benchmark_return"] == pytest.approx(-0.25)
