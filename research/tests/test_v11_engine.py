"""V11 backtester realism: latency bound, size-dependent slippage, fees and accounts per venue, funding at the
venue's interval, and ENGINE PARITY (the live engines' sizing and stop rules from one shared parameter file)."""
from __future__ import annotations

import math
import re
from dataclasses import replace
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from conftest import ROOT, make_data, make_series
from perp_helpers import bars, cfg, script, scripted_strategy
from v11_helpers import flat_bars

from spq.engine import BacktestConfig, run_backtest
from spq.execution import ExecutionModel, PerpParity, impact_inputs, load_parity, read_parity, sqrt_impact_bps
from spq.perp_engine import PerpConfig, run_perp_backtest

REPO = ROOT.parent
PLAIN = dict(slippage_model="constant", venue_fees=False, accounts="pooled")      # isolate one feature at a time


def lat(seconds=60.0, **kw):
    return ExecutionModel(latency_s=seconds, **{**PLAIN, **kw})


# ---------------------------------------------------------------------------------------------------- latency

def test_default_execution_model_has_a_positive_latency_and_the_old_model_is_still_available():
    assert ExecutionModel().latency_s > 0 and ExecutionModel().latency_model == "adverse_bound"
    assert ExecutionModel(latency_s=0.0, latency_model="next_open").latency_fraction(60, 3600) == 0.0
    with pytest.raises(ValueError):
        ExecutionModel(latency_s=60.0, latency_model="next_open")
    assert cfg().execution is None and cfg().parity is None                    # nothing changes unless asked


def test_latency_is_a_bound_against_the_order_inside_the_fill_bar():
    data = {"X": bars([100, 100, 100, 100], [100, 100, 100, 100], highs=[100, 110, 100, 100], lows=[100, 95, 100, 100])}
    f = math.sqrt(60 / 3600)
    buy = run_perp_backtest(script({"X": 1.0}), data, cfg(execution=lat()))
    t = buy.trades.iloc[0]
    assert float(t["size"]) == 10.0 and float(t["price"]) == 100.0             # the position is booked at the open
    assert float(t["latency"]) == pytest.approx(10.0 * f * 10.0, rel=1e-9)     # 10 units x f x (high - open)
    sell = run_perp_backtest(script({"X": -1.0}), data, cfg(execution=lat()))
    assert float(sell.trades.iloc[0]["latency"]) == pytest.approx(10.0 * f * 5.0, rel=1e-9)   # f x (open - low)
    for res in (buy, sell):
        assert res.ledger["reconciles"] and float(res.ledger["latency"]) == pytest.approx(float(res.trades["latency"].sum()))
    old = run_perp_backtest(script({"X": 1.0}), data, cfg())
    zero = run_perp_backtest(script({"X": 1.0}), data, cfg(execution=lat(0.0, latency_model="next_open")))
    assert zero.equity.equals(old.equity) and float(zero.trades["latency"].sum()) == 0
    assert buy.equity.iloc[-1] == pytest.approx(old.equity.iloc[-1] - 10.0 * f * 10.0)
    # five minutes instead of one: sqrt(5) times the bound; a delay beyond the bar is capped at the bar's extreme
    slow = run_perp_backtest(script({"X": 1.0}), data, cfg(execution=lat(300.0)))
    assert float(slow.trades.iloc[0]["latency"]) == pytest.approx(math.sqrt(5) * float(t["latency"]))
    late = run_perp_backtest(script({"X": 1.0}), data, cfg(execution=lat(7200.0)))
    assert float(late.trades.iloc[0]["latency"]) == pytest.approx(10.0 * 10.0) and late.counters["orders_latency_capped"] == 1


def test_each_further_exposure_adding_order_of_a_decision_waits_one_more_engine_pass():
    one = bars([100, 100, 100], [100, 100, 100], highs=[100, 104, 100])
    data = {"A": one, "B": one.copy(), "C": one.copy()}
    res = run_perp_backtest(script({"A": 0.5, "B": 0.5, "C": 0.5}), data, cfg(execution=lat()))
    per_unit = [float(r["latency"]) / float(r["size"]) for _, r in res.trades.iterrows()]
    assert per_unit[1] / per_unit[0] == pytest.approx(math.sqrt(2)) and per_unit[2] / per_unit[0] == pytest.approx(math.sqrt(3))
    # a reducing order is not delayed by the orders before it
    close = run_perp_backtest(script({"A": 0.5, "B": 0.5, "C": 0.5}, {"A": 0.0, "B": 0.0, "C": 0.0}),
                              {s: bars([100] * 4, [100] * 4, highs=[100, 100, 100, 100], lows=[100, 100, 96, 100]) for s in "ABC"},
                              cfg(execution=lat()))
    exits = close.trades[close.trades["kind"] == "close"]
    assert len(exits) == 3 and len({float(x) for x in exits["latency"]}) == 1


# --------------------------------------------------------------------------------------------------- slippage

def test_square_root_impact_grows_with_order_size_and_uses_past_bars_only():
    df = make_series(200, seed=4, sigma=0.01)
    df["volume"] = 5_000.0                                                     # ~500 000 USD per bar
    closes, vols = df[["close"]].to_numpy(), df[["volume"]].to_numpy()
    sig, usd = impact_inputs(closes, vols, 24)
    assert math.isnan(sig[1, 0]) and math.isfinite(sig[30, 0]) and usd[30, 0] == pytest.approx((closes[6:30, 0] * 5000).mean())
    later = closes.copy()
    later[30:] *= 1.5                                                          # the fill bar and everything after
    sig2, usd2 = impact_inputs(later, vols * 3, 24)
    assert sig2[30, 0] == sig[30, 0] and usd2[30, 0] == pytest.approx(3 * usd[30, 0])
    small, big = sqrt_impact_bps(1_000, 0.01, 500_000, 1.0, 100), sqrt_impact_bps(100_000, 0.01, 500_000, 1.0, 100)
    assert small == pytest.approx(0.01 * math.sqrt(1_000 / 500_000) * 1e4) and big == pytest.approx(10 * small)
    assert sqrt_impact_bps(1e12, 0.01, 500_000, 1.0, 100) == 100.0            # capped
    assert sqrt_impact_bps(1_000, 0.01, 0.0, 1.0, 100) == 100.0 == sqrt_impact_bps(1_000, float("nan"), 5e5, 1.0, 100)

    ex = ExecutionModel(latency_s=0.0, latency_model="next_open", venue_fees=False, accounts="pooled",
                        half_spread_bps={"X": 1.0})

    def bps_paid(cash):
        r = run_perp_backtest(script(None, None, None, None, None, None, None, None, None, None, None, None, None,
                                     None, None, None, None, None, None, None, None, None, None, None, None, None,
                                     None, None, None, {"X": 0.5}), {"X": df},
                              cfg(execution=ex, initial_cash=cash, leverage=1.0))
        t = r.trades.iloc[0]
        assert r.ledger["reconciles"]
        return float(t["slippage"]) / float(t["notional"]) * 1e4, float(t["notional"])

    (s1, n1), (s2, n2) = bps_paid(1_000.0), bps_paid(1_000_000.0)
    expect = 1.0 + sqrt_impact_bps(n1, sig[30, 0], usd[30, 0], 1.0, 100.0)
    assert s1 == pytest.approx(expect, abs=1e-4) and s1 > 1.0                  # half spread + impact
    assert s2 > 10 * (s1 - 1.0) and s2 <= 101.0                                # 1000x the size: ~31.6x the impact


def test_recorded_depth_profile_replaces_the_formula_and_never_goes_under_the_half_spread():
    data = {"X": flat_bars(4)}
    prof = {"n_snapshots": 500, "notionals": [100.0, 1_000.0, 10_000.0], "p90_bps": [0.2, 2.0, 5.0], "median_bps": [0.1, 1.0, 3.0]}
    ex = ExecutionModel(latency_s=0.0, latency_model="next_open", venue_fees=False, accounts="pooled",
                        half_spread_bps={"X": 0.5}, book_profiles={"X": prof})
    r = run_perp_backtest(script({"X": 1.0}), data, cfg(execution=ex, leverage=1.0))
    assert float(r.trades.iloc[0]["slippage"]) / float(r.trades.iloc[0]["notional"]) * 1e4 == pytest.approx(2.0, abs=1e-3)
    tiny = run_perp_backtest(script({"X": 0.05}), data, cfg(execution=ex, leverage=1.0))
    assert float(tiny.trades.iloc[0]["slippage"]) / float(tiny.trades.iloc[0]["notional"]) * 1e4 == pytest.approx(0.5, abs=1e-3)
    assert ex.to_dict()["book_profiles"]["X"]["n_snapshots"] == 500


# ------------------------------------------------------------------------------------ venues: fees, accounts

def venues_cfg(**kw):
    ex = ExecutionModel(latency_s=0.0, latency_model="next_open", slippage_model="constant", **kw.pop("ex", {}))
    return cfg(execution=ex, slippage_bps=0.0, spot_slippage_bps=0.0, **kw)


def test_fees_come_from_the_venue_table_taker_or_maker():
    data = {"BTC": flat_bars(4), "BTC@EDGEX": flat_bars(4), "BTC.SPOT": flat_bars(4)}
    w = {"BTC": 0.3, "BTC@EDGEX": -0.3, "BTC.SPOT": 0.2}
    taker = run_perp_backtest(script(w), data, venues_cfg(leverage=5.0))
    rate = {r["symbol"]: float(r["fee"]) / float(r["notional"]) * 1e4 for _, r in taker.trades.iterrows()}
    assert rate == pytest.approx({"BTC": 4.5, "BTC@EDGEX": 4.5, "BTC.SPOT": 10.0})
    maker = run_perp_backtest(script(w), data, venues_cfg(leverage=5.0, liquidity="maker"))
    rate = {r["symbol"]: float(r["fee"]) / float(r["notional"]) * 1e4 for _, r in maker.trades.iterrows()}
    assert rate == pytest.approx({"BTC": 1.5, "BTC@EDGEX": 4.0, "BTC.SPOT": 10.0})
    assert list(taker.trades["account"]) == ["hyperliquid", "edgex", "spot"] and taker.ledger["reconciles"]


def test_one_account_per_venue_collateral_is_not_shared():
    data = {"BTC": flat_bars(4), "BTC@EDGEX": flat_bars(4)}
    # 0.9 of equity on Hyperliquid at 1x needs 900 of margin; that account holds 500 and edgeX's 500 cannot help
    res = run_perp_backtest(script({"BTC": 0.9, "BTC@EDGEX": -0.05}), data, venues_cfg(leverage=1.0))
    assert res.accounts == ["hyperliquid", "edgex"] and res.counters["orders_cut"] == 1
    held = {p["symbol"]: abs(p["units"]) * 100.0 for p in res.open_positions}
    assert held["BTC"] < 500.0 and held["BTC@EDGEX"] == pytest.approx(50.0)
    pooled = run_perp_backtest(script({"BTC": 0.9, "BTC@EDGEX": -0.05}), data,
                               venues_cfg(leverage=1.0, ex={"accounts": "pooled"}))
    assert pooled.counters["orders_cut"] == 0                                  # the pre-V11 pooling hid the constraint
    util = res.account_margin_utilisation.iloc[-1]
    assert util["hyperliquid"] > 0.99 and util["edgex"] == pytest.approx(50 / res.account_margin_equity["edgex"].iloc[-1])
    split = run_perp_backtest(script({"BTC": 0.9, "BTC@EDGEX": -0.05}), data,
                              venues_cfg(leverage=1.0, ex={"capital_split": {"hyperliquid": 0.95, "edgex": 0.05}}))
    assert split.counters["orders_cut"] == 1                                   # now edgeX is the short account
    assert {p["symbol"]: round(abs(p["units"]) * 100) for p in split.open_positions}["BTC"] == 900
    with pytest.raises(Exception):
        run_perp_backtest(script({"BTC": 0.1}), data, venues_cfg(ex={"capital_split": {"hyperliquid": 0.5, "dydx": 0.5}}))


def test_a_liquidation_on_one_venue_does_not_reach_the_other_and_the_ledger_still_reconciles():
    crash = bars([100, 100, 60, 60], [100, 100, 60, 60])                      # a 40 % gap at the open of bar 2
    data = {"BTC": crash, "BTC@EDGEX": flat_bars(4)}
    res = run_perp_backtest(script({"BTC": 2.0, "BTC@EDGEX": -0.2}), data, venues_cfg(leverage=10.0))
    assert len(res.liquidations) == 1 and res.liquidations[0]["account"] == "hyperliquid"
    assert [p["symbol"] for p in res.open_positions] == ["BTC@EDGEX"]          # the other venue's position is intact
    # 2 000 long through a 40 % gap loses 800 on a 500 account: the venue eats the rest, edgeX keeps its 500
    assert float(res.ledger["bad_debt_written_off"]) > 250 and res.ledger["reconciles"] and not res.wiped_out
    assert res.equity.iloc[-1] == pytest.approx(500.0, abs=2.0)
    assert res.account_margin_equity["hyperliquid"].iloc[-1] == pytest.approx(0.0, abs=1e-9)


def test_funding_is_charged_at_each_venue_s_own_settlement_bars():
    n = 13
    hourly = np.full(n, 1e-4)
    four = np.where(np.arange(n) % 4 == 0, 4e-4, 0.0)                          # edgeX: one settlement every 4 bars
    data = {"BTC": flat_bars(n, funding=hourly), "BTC@EDGEX": flat_bars(n, funding=four)}
    res = run_perp_backtest(script({"BTC": 0.4, "BTC@EDGEX": -0.4}), data, venues_cfg(leverage=5.0))
    f = res.funding
    assert len(f[f["symbol"] == "BTC"]) == 11 and len(f[f["symbol"] == "BTC@EDGEX"]) == 3   # bars 2..12; bars 4, 8, 12
    assert float(f[f["symbol"] == "BTC"]["amount"].sum()) == pytest.approx(-400 * 1e-4 * 11)
    assert float(f[f["symbol"] == "BTC@EDGEX"]["amount"].sum()) == pytest.approx(+400 * 4e-4 * 3)
    assert res.counters["funding_missing"] == 0 and res.ledger["reconciles"]


# ---------------------------------------------------------------------------------------------- engine parity

def test_parity_file_is_the_engine_every_value_is_on_the_line_it_names():
    raw = read_parity()
    if not (REPO / "services" / "api" / "src" / "agents").is_dir():
        pytest.skip("the TypeScript engine is not in this checkout")
    for section in ("perp", "spot"):
        for name, p in raw[section].items():
            path, line = p["source"].rsplit(":", 1)
            text = (REPO / path).read_text().splitlines()[int(line) - 1]
            assert p["expect"] in text, f"{section}.{name}: {p['source']} no longer reads {p['expect']!r}: {text.strip()[:120]}"
            number = re.search(r"-?\d+(?:_\d+)*(?:\.\d+)?", p["expect"].replace("perp-", ""))
            got = float(number.group(0).replace("_", "")) / (1000.0 if p["expect"].endswith("_000") else 1.0)
            assert got == float(p["value"]), f"{section}.{name}: value {p['value']} is not the {got} of {p['source']}"


def test_scale_is_the_engine_s_one_factor_for_all_weights():
    par, _, _ = load_parity()
    assert isinstance(par, PerpParity) and (par.max_leverage, par.max_gross_exposure_x, par.max_position_x) == (2, 1.5, 1)
    h = 1 - 0.02 - 30 / 1e4
    w, f, why = par.scale({"A": 1.5, "B": -1.5}, 1000.0, 1000.0)
    assert why == "gross" and f == pytest.approx(1.5 * 1000 * h / 3000, abs=1e-12) and w["B"] == pytest.approx(-1.5 * f)
    assert par.scale({"A": 0.5, "B": -0.2}, 1000.0, 1000.0) == ({"A": 0.5, "B": -0.2}, 1.0, "none")
    _, f, why = par.scale({"A": 1.2}, 1000.0, 1000.0)
    assert why == "position" and f == pytest.approx(1000 * h / 1200, abs=1e-12)
    _, f, why = par.scale({"A": 0.95, "B": 0.95}, 500.0, 1000.0)                # leverage binds on a shrunken equity
    assert why == "leverage" and f == pytest.approx(2 * 500 * 0.9 / (1.9 * 500), abs=1e-12)
    assert par.scale({"A": 1.0}, 0.0, 1000.0) == ({"A": 0.0}, 0.0, "no_equity")
    assert par.scale({"A": 0.0}, 1000.0, 1000.0)[1:] == (1.0, "none")


def parity_cfg(**kw):
    par, _, _ = load_parity()
    ex = ExecutionModel(latency_s=0.0, latency_model="next_open", slippage_model="constant", venue_fees=False)
    return PerpConfig(interval="1h", taker_fee_bps=0.0, slippage_bps=0.0, initial_cash=1000.0, min_order=10.0,
                      venue_max_leverage={"BTC": 40, "ETH": 25}, size_decimals={"BTC": 5, "ETH": 4},
                      execution=ex, parity=replace(par, **kw))


def test_backtest_sizes_like_the_engine_caps_leverage_setting_and_minimum_trade():
    data = {"BTC": flat_bars(8), "ETH": flat_bars(8)}
    res = run_perp_backtest(scripted_strategy({"BTC": 1.5, "ETH": -1.5}, universe=("BTC", "ETH"), max_leverage=2.0),
                            data, parity_cfg())
    h = 1 - 0.02 - 30 / 1e4
    gross = sum(abs(p["units"]) * 100 for p in res.open_positions)
    assert gross == pytest.approx(1.5 * 1000 * h, abs=0.5) and res.counters["parity_scaled"] >= 1
    assert res.counters["parity_min_factor"] == pytest.approx(1.5 * h / 3, abs=1e-9)
    # the order's leverage setting is the owner's (2x), whatever the strategy's bound: margin in use = notional / 2
    assert res.margin_utilisation.iloc[-1] == pytest.approx(gross / 2 / 1000, rel=1e-3)
    # minimum trade: 2 % of equity (20 USD) and the venue minimum x 1.05; a full exit is never blocked
    steps = [{"BTC": 0.5}, {"BTC": 0.51}, {"BTC": 0.53}, {"BTC": 0.005}, {"BTC": 0.0}]
    one = dict(universe=("BTC",), max_leverage=2.0)
    res = run_perp_backtest(scripted_strategy(*steps, **one), {"BTC": flat_bars(7)}, parity_cfg())
    sizes = [float(x) for x in res.trades["notional"]]
    assert sizes == pytest.approx([500.0, 30.0, 525.0, 5.0], abs=0.2)          # +1 % skipped; 0.53 traded; small rest; exit
    tiny = run_perp_backtest(scripted_strategy({"BTC": 0.015}, **one), {"BTC": flat_bars(4)}, parity_cfg())
    assert len(tiny.trades) == 0 and tiny.counters["orders_skipped"] >= 1      # 15 USD < 20 USD: never opened
    # flip whose opening half is under the floor: the engine sends the close only
    flip = run_perp_backtest(scripted_strategy({"BTC": 0.5}, {"BTC": -0.01}, **one), {"BTC": flat_bars(4)}, parity_cfg())
    assert list(flip.trades["kind"]) == ["open", "close"] and flip.open_positions == []


def test_total_loss_limit_flattens_at_the_next_open_and_stops_the_agent():
    px = [100, 100, 100, 88, 88, 88, 88, 88]
    data = {"BTC": bars(px, px[1:] + [88])}
    res = run_perp_backtest(scripted_strategy({"BTC": 1.0}, universe=("BTC",), max_leverage=2.0), data, parity_cfg())
    assert res.stop["code"] == "total_loss" and res.stop["ts"] == data["BTC"].index[2].isoformat()
    assert res.trades.iloc[-1]["kind"] == "close" and res.trades.iloc[-1]["ts"] == data["BTC"].index[3]
    assert res.open_positions == [] and res.decisions.index.max() < data["BTC"].index[2]   # no decision after the stop
    assert len(set(res.equity.iloc[3:].round(9))) == 1 and res.ledger["reconciles"]
    # without parity the same strategy keeps trading
    free = run_perp_backtest(scripted_strategy({"BTC": 1.0}, universe=("BTC",), max_leverage=2.0), data,
                             replace(parity_cfg(), parity=None))
    assert free.stop is None and len(free.open_positions) == 1


def test_daily_loss_limit_and_liquidation_also_stop_the_agent():
    px = [100, 100, 96, 96, 96, 96]
    data = {"BTC": bars(px, px[1:] + [96])}
    res = run_perp_backtest(scripted_strategy({"BTC": 1.0}, universe=("BTC",), max_leverage=2.0), data, parity_cfg())
    assert res.stop["code"] == "daily_loss" and res.open_positions == []       # 3.9 % in the day >= 3 % of the capital
    hard = [100, 100, 40, 40, 40, 40]
    liq = run_perp_backtest(scripted_strategy({"BTC": 1.9}, universe=("BTC",), max_leverage=2.0),
                            {"BTC": bars(hard, hard[1:] + [40])}, parity_cfg(max_position_x=5.0, max_gross_exposure_x=5.0))
    assert liq.stop["code"] == "liquidation" and len(liq.liquidations) == 1 and liq.ledger["reconciles"]


# ----------------------------------------------------------------------------------------------- spot parity

def test_spot_backtest_applies_the_vault_engine_s_caps():
    _, spot, _ = load_parity()
    data = make_data(24 * 8, ("AAA", "BBB"), seed=2, sigma=0.002)
    config = BacktestConfig(interval="1h", fee_bps=10, slippage_bps=10, initial_cash=1000.0, parity=spot)
    res = run_backtest(lambda _v: {"AAA": 0.7, "BBB": 0.3}, data, config)
    t = res.trades
    assert len(t) and (t["notional"] <= spot.max_order_usd + 1e-6).all()       # 25 USD per order
    per_day = t.assign(day=t["ts"].dt.strftime("%Y-%m-%d")).groupby("day")
    assert (per_day["notional"].sum() <= spot.max_daily_usd + 1e-6).all()      # 100 USD per UTC day
    assert (per_day.size() <= spot.max_orders_per_day).all()
    assert per_day.size().iloc[0] == 4                                         # one order per pass until the day's cap
    assert res.exposure.max() <= spot.max_exposure_pct / 100 + 0.01            # weights scaled to the 50 % cap
    assert res.exposure.iloc[-1] == pytest.approx(0.5, abs=0.03)               # reached after five days of caps
    assert res.counters["exposure_scaled"] > 0 and res.counters["daily_usd_cap"] > 0
    free = run_backtest(lambda _v: {"AAA": 0.7, "BBB": 0.3}, data, replace(config, parity=None))
    assert free.exposure.iloc[1] > 0.95 and free.counters is None              # the pre-V11 backtest: all in, at once


def test_spot_loss_limit_sells_under_the_same_caps_then_stops():
    _, spot, _ = load_parity()
    px = np.concatenate([np.full(24 * 6, 100.0), np.full(24 * 3, 85.0)])
    idx = pd.date_range("2024-01-01", periods=len(px), freq="1h", tz="UTC", name="ts")
    df = pd.DataFrame({"open": px, "high": px, "low": px, "close": px, "volume": 1.0}, index=idx)
    res = run_backtest(lambda _v: {"AAA": 1.0}, {"AAA": df},
                       BacktestConfig(interval="1h", fee_bps=0, slippage_bps=0, initial_cash=1000.0, parity=spot))
    assert res.stop["code"] == "loss_limit" and res.equity.loc[pd.Timestamp(res.stop["ts"])] < 950.0
    after = res.trades[res.trades["ts"] > pd.Timestamp(res.stop["ts"])]
    assert len(after) and (after["side"] == "sell").all() and after["notional"].sum() <= spot.max_daily_usd + 1e-6
    assert res.decisions.index.max() <= pd.Timestamp(res.stop["ts"])           # no decision after the stop
    assert res.open_positions                                                  # the caps left part of the position
