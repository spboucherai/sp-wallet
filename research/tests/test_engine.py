"""Fill timing and cost accounting of the backtester, on hand-written bars."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from conftest import frame, make_data
from spq.data import DataError
from spq.engine import BacktestConfig, run_backtest
from spq.strategy import WeightsError, from_function

META = {"name": "t", "version": "1", "universe": ["X"], "interval": "1h", "lookback": 1, "params": {}}


def strat(func, lookback=1, universe=("X",)):
    return from_function(func, {**META, "lookback": lookback, "universe": list(universe)})


def test_fill_at_next_open_with_costs_by_hand():
    #            bar:   0     1     2     3     4
    data = {"X": frame([100, 102, 104, 108, 110], [101, 103, 107, 109, 111])}
    idx = data["X"].index
    # long after seeing the close of bar 0, flat after seeing the close of bar 2
    s = strat(lambda d, p: {"X": 1.0 if len(d["X"]) < 3 else 0.0}, lookback=5)
    s.meta["lookback"] = 1
    seen = []

    def f(d, p):
        seen.append(d["X"].index[-1])
        return {"X": 1.0 if d["X"].index[-1] < idx[2] else 0.0}

    cfg = BacktestConfig("1h", fee_bps=10, slippage_bps=20, initial_cash=1000)
    res = run_backtest(strat(f), data, cfg)
    fee, slip = 0.001, 0.002

    # decision on bar 0 -> buy at the OPEN of bar 1 (102), not at the close of bar 0 (101)
    gross_buy = 1000 / (1 + fee)
    units = gross_buy / (102 * (1 + slip))
    # decision on bar 2 -> sell at the OPEN of bar 3 (108)
    gross_sell = units * 108 * (1 - slip)
    cash_end = gross_sell * (1 - fee)
    np.testing.assert_allclose(res.equity.to_numpy(), [1000, units * 103, units * 107, cash_end, cash_end])
    np.testing.assert_allclose(res.exposure.to_numpy(), [0, 1, 1, 0, 0], atol=1e-12)

    t = res.trades
    assert list(t["side"]) == ["buy", "sell"]
    assert list(t["ts"]) == [idx[1], idx[3]] and list(t["decided_at"]) == [idx[0], idx[2]]
    assert t["price"].tolist() == pytest.approx([102 * 1.002, 108 * 0.998])
    assert t["notional"].tolist() == pytest.approx([gross_buy, gross_sell])
    assert t["fee"].tolist() == pytest.approx([gross_buy * fee, gross_sell * fee])
    assert t["slippage"].tolist() == pytest.approx([units * 102 * slip, units * 108 * slip])
    assert t["realised_pnl"].iloc[1] == pytest.approx(cash_end - 1000)   # whole round trip, all costs included
    # money is conserved: final cash = initial + price moves - fees - slippage
    assert cash_end == pytest.approx(1000 + units * (108 - 102) - t["fee"].sum() - t["slippage"].sum())
    assert res.open_positions == [] and seen == list(idx)


def test_zero_cost_fill_is_exactly_the_open():
    data = {"X": frame([100, 50, 50], [100, 50, 80])}
    res = run_backtest(strat(lambda d, p: {"X": 1.0}), data, BacktestConfig("1h", fee_bps=0, slippage_bps=0))
    assert res.trades["price"].iloc[0] == 50 and res.equity.tolist() == pytest.approx([1000, 1000, 1600])


def test_sells_fund_buys_and_cash_never_negative():
    a = frame([100, 100, 100, 100], [100, 100, 100, 100])
    data = {"A": a, "B": a.copy()}
    idx = a.index

    def rotate(d, p):
        return {"A": 1.0, "B": 0.0} if d["A"].index[-1] < idx[1] else {"A": 0.0, "B": 1.0}

    res = run_backtest(strat(rotate, universe=("A", "B")), data, BacktestConfig("1h", fee_bps=10, slippage_bps=10))
    t = res.trades
    assert list(zip(t["ts"], t["symbol"], t["side"])) == [(idx[1], "A", "buy"), (idx[2], "A", "sell"),
                                                         (idx[2], "B", "buy")]
    assert (res.cash >= 0).all() and res.cash.iloc[-1] == pytest.approx(0, abs=1e-9)
    cost = 0.998 * 0.998  # (1 - fee)(1 - slippage) approximately, three legs
    assert res.equity.iloc[-1] == pytest.approx(1000 / (1.001 * 1.001) * (0.999 * 0.999) / (1.001 * 1.001))
    assert res.equity.iloc[-1] < 1000 * cost


def test_rebalance_threshold_and_min_order():
    data = make_data(400, ("A", "B"), seed=3)
    half = strat(lambda d, p: {"A": 0.5, "B": 0.5}, universe=("A", "B"))
    always = run_backtest(half, data, BacktestConfig("1h", rebalance_threshold=0.0))
    banded = run_backtest(half, data, BacktestConfig("1h", rebalance_threshold=0.05))
    assert len(always.trades) > 300            # rebalances every bar
    assert 2 <= len(banded.trades) < 30        # initial purchase, then only when a weight drifts by 5 points
    assert (banded.trades["notional"] / 1000 > 0.03).all()
    sized = run_backtest(half, data, BacktestConfig("1h", rebalance_threshold=0.0, min_order=20.0))
    assert len(sized.trades) < len(always.trades) and (sized.trades["notional"] >= 20.0 / 1.002).all()
    blocked = run_backtest(half, data, BacktestConfig("1h", min_order=10_000.0))
    assert len(blocked.trades) == 0 and (blocked.equity == 1000).all()


def test_full_exit_is_not_blocked_by_the_threshold():
    data = {"X": frame([100] * 6, [100] * 6)}
    idx = data["X"].index
    f = lambda d, p: {"X": 0.04 if d["X"].index[-1] < idx[2] else 0.0}  # noqa: E731
    res = run_backtest(strat(f), data, BacktestConfig("1h", rebalance_threshold=0.03))
    assert list(res.trades["side"]) == ["buy", "sell"] and res.open_positions == []


def test_history_before_start_is_lookback_only():
    data = make_data(300, ("X",), seed=5)
    idx = data["X"].index
    lengths = []

    def f(d, p):
        lengths.append((d["X"].index[0], d["X"].index[-1], len(d["X"])))
        return {"X": 1.0}

    res = run_backtest(strat(f, lookback=50), data, BacktestConfig("1h"), start=idx[200], end=idx[260])
    assert res.equity.index[0] == idx[200] and res.equity.index[-1] == idx[259] and res.equity.iloc[0] == 1000
    assert lengths[0] == (idx[151], idx[200], 50)             # 50 closed bars ending at the decision bar
    assert all(n == 50 for _, _, n in lengths)
    assert res.trades["ts"].iloc[0] == idx[201]
    # without history the engine waits until `lookback` bars exist
    lengths.clear()
    res = run_backtest(strat(f, lookback=50), data, BacktestConfig("1h"), end=idx[100])
    assert lengths[0] == (idx[0], idx[49], 50) and res.trades["ts"].iloc[0] == idx[50]
    assert (res.equity.iloc[:50] == 1000).all()


def test_decision_every_is_anchored_on_utc():
    data = make_data(24 * 6, ("X",), seed=6, start="2024-01-01T05:00")
    calls = []

    def f(d, p):
        calls.append(d["X"].index[-1])
        return {"X": 1.0}

    res = run_backtest(strat(f), data, BacktestConfig("1h", decision_every=24))
    assert all(ts.hour == 23 for ts in calls) and len(calls) == 6   # bars closing at 00:00 UTC
    assert res.trades["ts"].iloc[0].hour == 0


def test_strategy_cannot_corrupt_engine_data():
    data = make_data(200, ("X",), seed=7)
    before = data["X"].copy()

    def vandal(d, p):
        d["X"].loc[:, "close"] = 0.0
        d["X"].iloc[:, 0] = -1.0
        return {"X": 1.0}

    a = run_backtest(strat(vandal, lookback=20), data, BacktestConfig("1h"))
    b = run_backtest(strat(lambda d, p: {"X": 1.0}, lookback=20), data, BacktestConfig("1h"))
    pd.testing.assert_frame_equal(data["X"], before)
    pd.testing.assert_series_equal(a.equity, b.equity)


def test_invalid_weights_and_bad_data_stop_the_run():
    data = make_data(50, ("X",), seed=8)
    for bad in ({"X": 1.2}, {"X": -0.1}, {"X": float("nan")}, {"Y": 0.5}, [1.0], {"X": "1"}):
        with pytest.raises(WeightsError):
            run_backtest(strat(lambda d, p, bad=bad: bad), data, BacktestConfig("1h"))
    two = make_data(50, ("A", "B"), seed=8)
    with pytest.raises(WeightsError, match="sum"):
        run_backtest(strat(lambda d, p: {"A": 0.6, "B": 0.6}, universe=("A", "B")), two, BacktestConfig("1h"))
    two["B"] = two["B"].iloc[1:]
    with pytest.raises(DataError, match="index differs"):
        run_backtest(strat(lambda d, p: {"A": 0.5, "B": 0.5}, universe=("A", "B")), two, BacktestConfig("1h"))
    with pytest.raises(ValueError):
        BacktestConfig("1h", fee_bps=-1)


def test_missing_symbol_means_zero_weight_and_partial_allocation_keeps_cash():
    data = make_data(50, ("A", "B"), seed=9)
    res = run_backtest(strat(lambda d, p: {"A": 0.3}, universe=("A", "B")), data,
                       BacktestConfig("1h", fee_bps=0, slippage_bps=0))
    assert set(res.trades["symbol"]) == {"A"}
    assert res.exposure.iloc[1:].between(0.25, 0.35).all() and res.cash.iloc[-1] > 600
