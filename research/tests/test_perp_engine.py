"""Perp backtester: hand-computed examples. Every expected number is derived in the comments.

Round parameters (perp_helpers.cfg): taker fee 10 bps, slippage 10 bps, 10x, maintenance 5 %, no penalty."""
from __future__ import annotations

from decimal import Decimal
from fractions import Fraction

import numpy as np
import pandas as pd
import pytest

from perp_helpers import D, bars, cfg, perp_data, perp_meta, script, scripted_strategy
from spq.data.core import DataError
from spq.engine import BacktestConfig, run_backtest
from spq.margin import dstr, exact, liquidation_price_cross
from spq.perp_engine import PerpConfig, perp_hold, run_perp_backtest
from spq.perp_metrics import compute_perp_metrics
from spq.strategy import WeightsError, from_function


def check_ledger(res):
    """Rebuild the final equity from the logs alone, to the last digit."""
    led = res.ledger
    t, f = res.trades, res.funding
    with exact():                                        # sums that raise instead of rounding
        rebuilt = (led["initial"] + sum(t["realised_pnl"], D(0)) + sum(f["amount"], D(0)) - sum(t["fee"], D(0))
                   - sum(t["slippage"], D(0)) + led["unrealised_pnl"] + led["bad_debt_written_off"])
        assert rebuilt == led["final_equity"] and led["reconciles"] is True
        assert led["final_equity"] == led["collateral"] + led["unrealised_pnl"]
    assert float(led["final_equity"]) == pytest.approx(res.equity.iloc[-1], rel=1e-12, abs=1e-12)
    return led


def test_long_round_trip_by_hand():
    data = {"X": bars([100, 100, 110, 121], [100, 110, 121, 121])}
    res = run_perp_backtest(script({"X": 1.0}, None, {"X": 0.0}), data, cfg())
    # bar 1, open 100: equity 1000 -> notional 1000 -> buy 10. slippage 10*100*0.001 = 1;
    #   fill price 100.1; fee 10*100.1*0.001 = 1.001; collateral 1000 - 1 - 1.001 = 997.999
    # close 110: equity 997.999 + 10*(110-100) = 1097.999 ; close 121 (bar 2): 997.999 + 210 = 1207.999
    # bar 3, open 121: sell 10. realised 210; slippage 10*121*0.001 = 1.21; fill price 120.879; fee 1.20879
    #   collateral 997.999 + 210 - 1.21 - 1.20879 = 1205.58021
    assert res.equity.tolist() == pytest.approx([1000.0, 1097.999, 1207.999, 1205.58021], abs=1e-12)
    t = res.trades
    assert list(t["side"]) == ["buy", "sell"] and list(t["kind"]) == ["open", "close"]
    assert [dstr(x) for x in t["size"]] == ["10", "10"]
    assert [dstr(x) for x in t["price"]] == ["100", "121"] and [dstr(x) for x in t["fill_price"]] == ["100.1", "120.879"]
    assert [dstr(x) for x in t["fee"]] == ["1.001", "1.20879"] and [dstr(x) for x in t["slippage"]] == ["1", "1.21"]
    assert [dstr(x) for x in t["realised_pnl"]] == ["0", "210"]
    assert list(t["decided_at"]) == [data["X"].index[0], data["X"].index[2]] and list(t["ts"]) == list(data["X"].index[[1, 3]])
    led = check_ledger(res)
    assert dstr(led["final_equity"]) == "1205.58021" and dstr(led["fees"]) == "2.20979" and dstr(led["slippage"]) == "2.21"
    assert res.exposure.tolist() == pytest.approx([0, 1100 / 1097.999, 1210 / 1207.999, 0])
    assert res.open_positions == [] and not res.wiped_out and res.liquidations == []


def test_short_round_trip_by_hand():
    data = {"X": bars([100, 100, 90, 80], [100, 90, 80, 80])}
    res = run_perp_backtest(script({"X": -1.0}, None, {"X": 0.0}), data, cfg())
    # sell 10 @ 100: slippage 1; fill price 99.9; fee 0.999; collateral 998.001
    # close 90: 998.001 + 10*(100-90) = 1098.001 ; close 80: 1198.001
    # buy 10 @ 80: realised 200; slippage 0.8; fill price 80.08; fee 0.8008 -> 998.001 + 200 - 0.8 - 0.8008 = 1196.4002
    assert res.equity.tolist() == pytest.approx([1000.0, 1098.001, 1198.001, 1196.4002], abs=1e-12)
    assert list(res.trades["side"]) == ["sell", "buy"]
    assert [dstr(x) for x in res.trades["position_after"]] == ["-10", "0"]
    assert res.short_exposure.iloc[1] == pytest.approx(900 / 1098.001) and res.long_exposure.sum() == 0
    assert res.weights["X"].iloc[1] == pytest.approx(-900 / 1098.001)
    assert dstr(check_ledger(res)["final_equity"]) == "1196.4002"


def test_flip_from_long_to_short_by_hand():
    data = {"X": bars([100, 100, 110, 110], [100, 110, 110, 99])}
    res = run_perp_backtest(script({"X": 1.0}, {"X": -1.0}), data, cfg())
    # long 10 @ 100 as above: collateral 997.999. Bar 2, open 110: equity 997.999 + 100 = 1097.999
    #   target -1097.999 / 110 = -9.98180909... -> -9.981809 (truncated to the 1e-6 lot); order: sell 19.981809
    #   realised 10*(110-100) = 100; slippage 19.981809*110*0.001 = 2.19799899; fill price 109.89;
    #   fee 19.981809*109.89*0.001 = 2.19580099101; collateral 997.999 + 100 - 2.19799899 - 2.19580099101
    flip = res.trades.iloc[1]
    assert (flip["side"], flip["kind"], dstr(flip["size"]), dstr(flip["position_after"])) == \
        ("sell", "flip", "19.981809", "-9.981809")
    assert dstr(flip["realised_pnl"]) == "100" and dstr(flip["slippage"]) == "2.19799899"
    assert dstr(flip["fee"]) == "2.19580099101"
    collateral = D("997.999") + 100 - D("2.19799899") - D("2.19580099101")
    assert res.ledger["collateral"] == collateral == D("1093.60520001899")
    # bar 3 closes at 99: the short 9.981809 @ 110 gains 9.981809 * 11 = 109.799899
    assert res.ledger["unrealised_pnl"] == D("109.799899")
    assert res.equity.iloc[-1] == pytest.approx(float(collateral + D("109.799899")), abs=1e-12)
    assert res.open_positions[0]["side"] == "short" and dstr(res.open_positions[0]["entry_price"]) == "110"
    check_ledger(res)


def test_funding_sign_for_a_long_and_for_a_short():
    """Numbers of packages/derivatives/test/paper.test.ts: long 2, price 110, rate 0.0005 -> -0.11 (the long
    pays); rate -0.0002 -> +0.044 (the long receives); short 2, price 100, rate 0.0005 -> +0.1."""
    free = cfg(taker_fee_bps=0, slippage_bps=0, initial_cash=10_000)
    # the rate in row i is settled at the open of bar i, on the position held coming into it
    long_ = {"X": bars([100, 100, 110, 110, 110], [100, 110, 110, 110, 110], funding=[0.01, 0.02, 0.0005, -0.0002, 0.0])}
    res = run_perp_backtest(script({"X": 0.02}), long_, free)           # 0.02 * 10 000 / 100 = 2 units
    f = res.funding
    # nothing at bar 0 (no position) nor at bar 1 (the position is opened AFTER that settlement)
    assert list(f["ts"]) == list(long_["X"].index[[2, 3]])
    assert [dstr(x) for x in f["amount"]] == ["-0.11", "0.044"] and [dstr(x) for x in f["size"]] == ["2", "2"]
    assert [dstr(x) for x in f["price"]] == ["110", "110"]
    assert dstr(res.ledger["funding"]) == "-0.066" and dstr(res.ledger["collateral"]) == "9999.934"
    assert res.equity.tolist() == pytest.approx([10000, 10020, 10019.89, 10019.934, 10019.934])
    check_ledger(res)

    short = {"X": bars([100, 100, 100, 100], [100, 100, 100, 100], funding=[0.0, 0.0, 0.0005, -0.0005])}
    res = run_perp_backtest(script({"X": -0.02}), short, free)
    assert [dstr(x) for x in res.funding["amount"]] == ["0.1", "-0.1"]  # receives a positive rate, pays a negative one
    assert [dstr(x) for x in res.funding["size"]] == ["-2", "-2"]
    assert compute_perp_metrics(res)["funding_pnl"] == 0.0 and res.counters["funding_payments"] == 2


def test_funding_missing_is_counted_and_charged_as_zero_and_index_is_the_reference_price():
    free = cfg(taker_fee_bps=0, slippage_bps=0, initial_cash=10_000)
    data = {"X": bars([100, 100, 110, 110], [100, 110, 110, 110], funding=[0, 0, np.nan, 0.001])}
    res = run_perp_backtest(script({"X": 0.02}), data, free)
    assert res.counters["funding_missing"] == 1 and [dstr(x) for x in res.funding["amount"]] == ["-0.22"]
    # with an index column the notional is size x index known BEFORE the bar (its previous value): 2 * 108 * 0.001
    data = {"X": bars([100, 100, 110, 110], [100, 110, 110, 110], funding=[0, 0, 0, 0.001], index=[99, 109, 108, 111])}
    res = run_perp_backtest(script({"X": 0.02}), data, free)
    assert [dstr(x) for x in res.funding["amount"]] == ["-0.216"] and dstr(res.funding["price"].iloc[0]) == "108"


def test_weights_beyond_the_leverage_caps_are_refused():
    data = {"X": bars([100] * 6, [100] * 6), "Y": bars([50] * 6, [50] * 6)}
    meta = perp_meta(("X", "Y"), lookback=1, max_leverage=2.0, max_gross=3.0)
    for bad in ({"X": 2.5}, {"X": -2.5}, {"X": 2.0, "Y": -1.5}, {"X": float("nan")}, {"Z": 0.1}, [1, 2]):
        with pytest.raises(WeightsError):
            run_perp_backtest(from_function(lambda d, p, bad=bad: bad, meta), data, cfg())
    ok = run_perp_backtest(from_function(lambda d, p: {"X": 2.0, "Y": -1.0}, meta), data,
                           cfg(leverage=None, taker_fee_bps=0, slippage_bps=0))
    # leverage defaults to META['max_leverage'] = 2: initial margin 2000/2 + 1000/2 = 1500 > 1000 of equity ->
    # both orders are cut by the same factor 1000/1500 (rule: cut pro rata to the free collateral)
    assert [dstr(x) for x in ok.trades["size"]] == ["13.333333", "13.333333"] and ok.trades["cut"].all()
    assert ok.counters["orders_cut"] == 2 and ok.exposure.iloc[1] == pytest.approx(2.0, abs=1e-6)
    assert ok.margin_utilisation.iloc[1] == pytest.approx(1.0, abs=1e-6)


def test_initial_margin_check_cuts_or_refuses_orders_that_exceed_leverage():
    """paper.test.ts rejects 11 @ 100 at 10x with 100 of collateral (needs 110 + 1.1 of fee). Stated rule here:
    the order is CUT to what the free collateral allows, and refused only if what is left is below the minimum."""
    data = {"X": bars([100] * 5, [100] * 5)}
    c = cfg(initial_cash=100, slippage_bps=0)
    res = run_perp_backtest(scripted_strategy({"X": 11.0}), data, c)
    # per unit: margin 100/10 = 10 + fee 0.1 = 10.1 ; 100 / 10.1 = 9.90099009... -> 9.90099 units
    t = res.trades.iloc[0]
    assert dstr(t["size"]) == "9.90099" and bool(t["cut"]) and len(res.trades) == 1
    # the strategy asks for 11x again at each of the 3 later bars: nothing more fits, those orders are refused
    assert res.counters["orders_cut"] == 1 and res.counters["orders_refused"] == 3
    assert D("9.90099") * 100 / 10 + t["fee"] <= 100                      # it fits: 99.0099 + 0.990099
    # 9 @ 100 needs 90 + 0.9: accepted in full (same case as the TypeScript test)
    res = run_perp_backtest(script({"X": 9.0}), data, c)
    assert dstr(res.trades.iloc[0]["size"]) == "9" and not res.trades.iloc[0]["cut"]
    assert dstr(res.ledger["collateral"]) == "99.1"
    # with a 200 USD minimum order the cut of an order that only fits for 50 USD is refused
    res = run_perp_backtest(script({"X": 9.0}, {"X": 10.0}), data, cfg(initial_cash=100, slippage_bps=0, min_order=0))
    assert len(res.trades) == 2                                           # 9, then +0.89... (cut)
    res = run_perp_backtest(script({"X": 9.0}, {"X": 10.0}), data, cfg(initial_cash=100, slippage_bps=0, min_order=95))
    assert len(res.trades) == 1 and res.counters["orders_refused"] + res.counters["orders_skipped"] == 1
    # reducing is always allowed, even with no free collateral left
    res = run_perp_backtest(script({"X": 9.0}, {"X": 4.0}), data, c)
    # (target 4 x equity 99.1 / 100 = 3.964 units)
    assert list(res.trades["kind"]) == ["open", "reduce"] and dstr(res.trades.iloc[1]["position_after"]) == "3.964"


def test_venue_maximum_leverage_caps_the_account_leverage():
    data = {"X": bars([100] * 4, [100] * 4)}
    meta = perp_meta(("X",), lookback=1, max_leverage=5.0)
    c = PerpConfig("1h", taker_fee_bps=0, slippage_bps=0, min_order=0, venue_max_leverage={"X": 2.0})
    res = run_perp_backtest(from_function(lambda d, p: {"X": 5.0}, meta), data, c)
    assert res.exposure.iloc[1] == pytest.approx(2.0, abs=1e-6) and res.counters["orders_cut"] == 1
    assert c.maintenance("X") == 0.25 and c.maintenance("OTHER") == 0.05   # half of the initial margin at max leverage


def test_liquidation_of_a_long_at_the_expected_price():
    """Same account as packages/derivatives/test/paper.test.ts: long 9 @ 100 at 10x with 100 of collateral,
    fee 0.1 % -> collateral 99.1, maintenance 5 %. The TypeScript estimate of the liquidation price is
    (9*100 - 99.1) / (9 * 0.95) = 93.672514619883040936 (rounded up at 18 decimals)."""
    lp = D("93.672514619883040936")
    assert liquidation_price_cross("long", D(9), D(100), D("99.1"), D("0.05")) == lp
    data = {"X": bars([100, 100, 100, 94, 95], [100, 100, 94, 95, 95], lows=[100, 100, 94, 93, 95])}
    res = run_perp_backtest(script({"X": 9.0}), data, cfg(initial_cash=100, slippage_bps=0))
    # bar 2 falls to 94: equity 99.1 + 9*(94-100) = 45.1 >= maintenance 9*94*0.05 = 42.3 -> alive (as in the TS test)
    assert res.equity.iloc[2] == pytest.approx(45.1) and res.worst_equity.iloc[2] == pytest.approx(45.1)
    # bar 3: open 94, low 93 crosses the level -> closed AT the level, taker fee 0.1 % of 9 * level
    liq = res.trades.iloc[1]
    assert bool(liq["liquidation"]) and liq["side"] == "sell" and liq["price"] == lp and liq["ts"] == data["X"].index[3]
    realised = 9 * (lp - 100)
    fee = 9 * lp * D("0.001")
    assert liq["realised_pnl"] == realised == D("-56.947368421052631576") and liq["fee"] == fee
    assert res.ledger["collateral"] == D("99.1") + realised - fee
    assert res.equity.iloc[3] == pytest.approx(float(D("99.1") + realised - fee)) == pytest.approx(41.3095789, abs=1e-6)
    assert len(res.liquidations) == 1 and res.liquidations[0]["reason"].startswith("intrabar")
    assert not res.wiped_out and res.open_positions == []
    # at the level, equity before the fee equals the maintenance margin (up to the 1e-18 rounding of the level)
    assert abs((D("99.1") + realised) - 9 * lp * D("0.05")) < D("1e-15")
    m = compute_perp_metrics(res)
    assert m["liquidations"] == 1 and m["wiped_out"] is False and m["worst_intrabar_drawdown"] > m["max_drawdown"] - 1e-12
    check_ledger(res)

    # a low that stops just above the level does not liquidate
    safe = {"X": bars([100, 100, 100, 94, 95], [100, 100, 94, 95, 95], lows=[100, 100, 94, 93.68, 95])}
    assert run_perp_backtest(script({"X": 9.0}), safe, cfg(initial_cash=100, slippage_bps=0)).liquidations == []


def test_liquidation_of_a_short_at_the_expected_price_with_a_penalty():
    # short 9 @ 100, collateral 99.1: level (900 + 99.1) / (9 * 1.05) = 105.724867724867724867 (rounded DOWN)
    lp = liquidation_price_cross("short", D(9), D(100), D("99.1"), D("0.05"))
    assert dstr(lp) == "105.724867724867724867"
    assert abs(Fraction(lp) - Fraction(9991, 10) / Fraction(945, 100)) < Fraction(1, 10**18)
    data = {"X": bars([100, 100, 100, 104], [100, 100, 104, 104], highs=[100, 100, 104, 107])}
    res = run_perp_backtest(script({"X": -9.0}), data, cfg(initial_cash=100, slippage_bps=0, liquidation_penalty_bps=90))
    liq = res.trades.iloc[1]
    assert bool(liq["liquidation"]) and liq["side"] == "buy" and liq["price"] == lp
    assert liq["realised_pnl"] == 9 * (100 - lp)
    # stated penalty: 90 bps of the liquidated notional on top of the 10 bps taker fee = 1 % in total
    assert liq["penalty"] == 9 * lp * D("0.009") and liq["fee"] == 9 * lp * D("0.01")
    assert res.ledger["liquidation_penalties"] == liq["penalty"]
    check_ledger(res)


def test_gap_through_the_level_liquidates_at_the_open():
    """paper.test.ts, second liquidation case: short 9 @ 100 (collateral 99.1), mark 107, liquidation fee 1 %:
    closed PnL -63, fee 9*107*0.01 = 9.63, collateral 99.1 - 63 - 9.63 = 26.47."""
    data = {"X": bars([100, 100, 107, 107], [100, 100, 107, 107])}
    res = run_perp_backtest(script({"X": -9.0}), data, cfg(initial_cash=100, slippage_bps=0, liquidation_penalty_bps=90))
    liq = res.trades.iloc[1]
    assert (dstr(liq["price"]), dstr(liq["realised_pnl"]), dstr(liq["fee"]), bool(liq["liquidation"])) == \
        ("107", "-63", "9.63", True)
    assert dstr(res.ledger["collateral"]) == "26.47" and res.liquidations[0]["reason"] == "gap at the open"
    # long side, first TS case: mark 93 -> closed PnL -63; here the taker fee 9*93*0.001 = 0.837 is also charged
    data = {"X": bars([100, 100, 93, 93], [100, 100, 93, 93])}
    res = run_perp_backtest(script({"X": 9.0}), data, cfg(initial_cash=100, slippage_bps=0))
    assert dstr(res.trades.iloc[1]["realised_pnl"]) == "-63" and dstr(res.ledger["collateral"]) == "35.263"


def test_wipe_out_stops_the_run_at_zero_and_reports_the_debt():
    data = {"X": bars([100, 100, 85, 90, 120, 130], [100, 100, 90, 120, 130, 140])}
    res = run_perp_backtest(script({"X": 9.0}, {"X": 5.0}, {"X": 5.0}, {"X": 5.0}), data,
                            cfg(initial_cash=100, slippage_bps=0, liquidation_penalty_bps=100))
    # gap to 85: realised 9*(85-100) = -135; fee 9*85*(0.001+0.01) = 8.415 -> collateral 99.1 - 135 - 8.415 = -44.315
    assert res.wiped_out and res.wiped_out_at == data["X"].index[2]
    assert res.equity.tolist() == pytest.approx([100, 99.1, 0, 0, 0, 0])
    assert dstr(res.ledger["bad_debt_written_off"]) == "44.315" and res.ledger["final_equity"] == 0
    assert len(res.trades) == 2 and (res.trades["ts"] <= data["X"].index[2]).all()     # nothing trades afterwards
    assert len(res.decisions) == 2                                                       # and nothing is decided
    check_ledger(res)
    m = compute_perp_metrics(res)
    assert m["wiped_out"] is True and m["total_return"] == -1.0 and m["max_drawdown"] == 1.0
    assert m["worst_intrabar_drawdown"] == 1.0 and m["liquidations"] == 1 and m["cagr"] == -1.0
    assert np.isfinite(res.returns.to_numpy()).all()


def test_cross_margin_liquidation_with_two_positions_happens_where_equity_meets_maintenance():
    data = {"X": bars([100, 100, 100], [100, 100, 97], lows=[100, 100, 90]),
            "Y": bars([50, 50, 50], [50, 50, 51], highs=[50, 50, 56])}
    res = run_perp_backtest(script({"X": 5.0, "Y": -4.0}), data, cfg(initial_cash=100, taker_fee_bps=0, slippage_bps=0))
    # long 5 X @ 100, short 8 Y @ 50, collateral 100. Along the path open -> (X low 90, Y high 56), a fraction u:
    #   equity(u) = 100 - 5*10u - 8*6u = 100 - 98u ; maintenance(u) = 0.05*(5*(100-10u) + 8*(50+6u)) = 45 - 0.1u
    #   equal at u = 55 / 97.9 -> X = 100 - 10u = 94.38202247..., Y = 50 + 6u = 53.37078651...
    u = Fraction(55) / Fraction(979, 10)
    x, y = res.trades.iloc[2]["price"], res.trades.iloc[3]["price"]
    assert res.trades["liquidation"].tolist() == [False, False, True, True] and len(res.liquidations) == 1
    assert abs(Fraction(x) - (100 - 10 * u)) < Fraction(1, 10**17) and abs(Fraction(y) - (50 + 6 * u)) < Fraction(1, 10**17)
    equity = 100 + 5 * (x - 100) + 8 * (50 - y)
    assert abs(equity - D("0.05") * (5 * x + 8 * y)) < D("1e-15")
    check_ledger(res)


def test_ledger_reconciles_exactly_on_random_runs_including_liquidations():
    rng = np.random.default_rng(7)
    saw_liquidation = saw_wipe = False
    for seed in range(6):
        data = perp_data(700, ("BTC", "ETH"), seed=seed, sigma=0.02, rate=5e-5, rate_sigma=3e-4)
        lev = [2.0, 6.0, 12.0][seed % 3]
        meta = perp_meta(("BTC", "ETH"), lookback=5, max_leverage=lev, max_gross=2 * lev)
        w = rng.uniform(-lev, lev, size=(700, 2))

        def random_weights(d, p, w=w, t0=data["BTC"].index[0]):
            i = int((d["BTC"].index[-1] - t0) / pd.Timedelta(hours=1))
            return {"BTC": float(w[i, 0]), "ETH": float(w[i, 1])}

        c = PerpConfig("1h", decision_every=3, venue_max_leverage={"BTC": 40, "ETH": 25}, leverage=lev,
                       size_decimals={"BTC": 5, "ETH": 4},
                       # the last runs use a penalty larger than the maintenance margin: a liquidation wipes out
                       liquidation_penalty_bps=100 if seed < 4 else 400)
        res = run_perp_backtest(from_function(random_weights, meta), data, c)
        led = check_ledger(res)
        assert len(res.trades) > 50 and len(res.funding) > 100
        assert (res.equity >= 0).all() and (res.worst_equity >= 0).all()
        assert res.wiped_out == (res.equity.iloc[-1] == 0) and (led["bad_debt_written_off"] > 0) == res.wiped_out
        saw_liquidation |= len(res.liquidations) > 0
        saw_wipe |= res.wiped_out
        # every money value of the logs is an exact Decimal, never a float
        assert all(isinstance(x, Decimal) for x in res.trades["fee"]) and all(isinstance(x, Decimal) for x in res.funding["amount"])
    assert saw_liquidation and saw_wipe, "the random runs must exercise liquidation and wipe-out"


def test_spot_leg_is_paid_in_full_is_not_margin_and_hedges_the_short():
    px = [100, 100, 120, 150, 150]
    data = {"X": bars(px, px[1:] + [150], funding=[0, 0, 0.001, 0.001, 0.001]), "X.SPOT": bars(px, px[1:] + [150])}
    c = cfg(taker_fee_bps=0, slippage_bps=0, spot_fee_bps=0, spot_slippage_bps=0, leverage=1.0)
    res = run_perp_backtest(script({"X": -0.4, "X.SPOT": 0.4}), data, c)
    # 4 units long on spot (400 USDC paid), 4 units short on the perpetual: the price move cancels out and the
    # short collects funding at the opens 120, 150, 150: 4*120*0.001 + 4*150*0.001 + 4*150*0.001 = 1.68
    assert [dstr(x) for x in res.funding["amount"]] == ["0.48", "0.6", "0.6"]
    assert res.equity.tolist() == pytest.approx([1000, 1000, 1000.48, 1001.08, 1001.68])
    assert res.long_exposure.iloc[1] == pytest.approx(0.48) and res.short_exposure.iloc[1] == pytest.approx(0.48)
    assert (res.net_exposure.abs() < 1e-12).all()
    # margin equity = 1000 - 400 (spot is not collateral) - 200 (short's loss at 150) + funding; never liquidated
    assert res.liquidations == [] and res.margin_utilisation.iloc[3] == pytest.approx(600 / (1000 - 400 - 200 + 1.08), rel=1e-9)
    check_ledger(res)
    # a spot leg cannot be shorted nor levered, and a universe of spot legs only is refused
    with pytest.raises(WeightsError):
        run_perp_backtest(script({"X.SPOT": -0.1}), data, c)
    with pytest.raises(WeightsError):
        run_perp_backtest(script({"X.SPOT": 1.5}), data, c)
    with pytest.raises(DataError):
        run_perp_backtest(script({"X.SPOT": 0.5}), {"X.SPOT": data["X.SPOT"]}, c)


def test_rebalance_threshold_minimum_order_and_full_exit():
    px = [100, 100, 101, 102, 103, 104]
    data = {"X": bars(px, px[1:] + [104])}
    c = cfg(taker_fee_bps=0, slippage_bps=0, rebalance_threshold=0.05)
    res = run_perp_backtest(script({"X": 1.0}, {"X": 1.02}, {"X": 1.0}, {"X": 0.0}), data, c)
    assert list(res.trades["kind"]) == ["open", "close"] and res.counters["orders_skipped"] == 1
    res = run_perp_backtest(script({"X": 0.001}, {"X": 0.0}), data, cfg(min_order=10.0))       # 1 USD < 10 USD
    assert len(res.trades) == 0
    res = run_perp_backtest(script({"X": 0.02}, {"X": 0.0}), data, cfg(min_order=15.0))        # 20 USD in, exit allowed
    assert list(res.trades["kind"]) == ["open", "close"]


def test_benchmark_perp_long_1x_includes_funding_and_spot_engine_refuses_a_perp_strategy():
    data = perp_data(400, ("BTC", "ETH"), seed=3, rate=1e-4, rate_sigma=0)
    c = PerpConfig("1h", taker_fee_bps=0, slippage_bps=0)
    held = perp_hold(data, c)
    no_funding = perp_hold({s: df.drop(columns=["funding", "premium"]) for s, df in data.items()}, c)
    assert len(held.trades) == 2 and held.exposure.iloc[5] == pytest.approx(1.0, abs=0.05)
    paid = float(held.ledger["funding"])
    assert paid < 0 and held.equity.iloc[-1] == pytest.approx(no_funding.equity.iloc[-1] + paid, rel=1e-9)
    assert held.counters["funding_payments"] == 2 * 398 and no_funding.counters["funding_payments"] == 0
    check_ledger(held)
    strategy = from_function(lambda d, p: {"BTC": -0.5}, perp_meta(("BTC", "ETH"), lookback=5))
    with pytest.raises(DataError, match="perp strategy"):
        run_backtest(strategy, data, BacktestConfig("1h"))


def test_config_validation_and_engine_guards():
    for bad in (dict(taker_fee_bps=-1), dict(slippage_bps=10_000), dict(liquidity="x"), dict(initial_cash=0),
                dict(decision_every=0), dict(leverage=0), dict(maintenance_fraction=1.0), dict(venue_max_leverage={"X": 0})):
        with pytest.raises(ValueError):
            PerpConfig("1h", **bad)
    assert PerpConfig("1h").fee_bps == 4.5 and PerpConfig("1h", liquidity="maker").fee_bps == 1.5
    data = {"X": bars([100, 100], [100, 100])}
    with pytest.raises(TypeError):
        run_perp_backtest(script(), data, BacktestConfig("1h"))
    with pytest.raises(DataError):
        run_perp_backtest(script(), {"X": data["X"].iloc[:1]}, cfg())
    with pytest.raises(DataError):
        run_perp_backtest(script(), {"X": bars([100, -1], [100, 100])}, cfg())
