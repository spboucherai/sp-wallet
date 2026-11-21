# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/tests/test_v11_tools.py
# Description      : V11 research tools that are not trading strategies: the
#                    risk supervisor (a pure policy that only PROPOSES), the
#                    volatility forecast evaluation, the market-making model
#                    study and the cross-exchange spread analysis.
# Module           : research
# Repository       : https://git.spboucher.ai/sp-wallet
# Project Website  : https://wallet.spboucher.ai
# Created          : 2026-11-15
# Last Modified    : 2026-11-15
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

"""V11 research tools that are not trading strategies: the risk supervisor (a pure policy that only PROPOSES),
the volatility forecast evaluation, the market-making model study and the cross-exchange spread analysis."""
from __future__ import annotations

import inspect
import json
import math

import numpy as np
import pandas as pd
import pytest

from conftest import make_series
from v11_helpers import synthetic_store

from spq import risk_supervisor as rs, studies, vol_forecast as vf
from spq.purity import check


# -------------------------------------------------------------------------------------------- risk supervisor

def pos(symbol, notional, **kw):
    return {"symbol": symbol, "notional": notional, **kw}


def test_supervisor_is_a_pure_policy_and_passes_the_strategy_purity_lint():
    assert check(inspect.getsource(rs)) == []                          # no import, clock, file or randomness at all
    positions = [pos("BTC", 600.0), pos("ETH", -300.0)]
    a = rs.propose(positions, [1000.0, 1010.0, 1005.0])
    assert a == rs.propose(positions, [1000.0, 1010.0, 1005.0]) and a["proposals"] == []     # nothing to do: says nothing
    assert a["state"]["regime"] == "normal" and a["state"]["gross_leverage"] == pytest.approx(900 / 1005)
    assert positions == [pos("BTC", 600.0), pos("ETH", -300.0)]        # inputs are not modified


def test_drawdown_deleverage_soft_then_hard():
    positions = [pos("BTC", 600.0), pos("ETH", -300.0)]
    soft = rs.propose(positions, [1000.0, 1100.0, 1040.0])             # 5.45 % under the peak
    assert soft["state"]["regime"] == "soft_drawdown" and soft["state"]["drawdown"] == pytest.approx(1 - 1040 / 1100)
    assert [(p["symbol"], p["to_notional"]) for p in soft["proposals"]] == [("BTC", 300.0), ("ETH", -150.0)]
    assert all(p["action"] == "reduce" and p["reasons"][0]["rule"] == "drawdown_soft" for p in soft["proposals"])
    hard = rs.propose(positions, [1000.0, 1100.0, 980.0])              # 10.9 % under the peak
    assert hard["state"]["regime"] == "hard_drawdown" and all(p["to_notional"] == 0 for p in hard["proposals"])
    assert hard["state"]["proposed_gross_notional"] == 0.0


def test_concentration_gross_leverage_liquidation_distance_and_funding_bleed():
    out = rs.propose([pos("BTC", 1400.0), pos("ETH", -700.0)], [1000.0])
    by = {p["symbol"]: p for p in out["proposals"]}
    assert by["BTC"]["to_notional"] == pytest.approx(1000.0)           # 1.5x gross cap, then 1.0x per position
    assert by["ETH"]["to_notional"] == pytest.approx(-500.0)
    assert {r["rule"] for r in by["BTC"]["reasons"]} == {"gross_leverage"} or "concentration" in {r["rule"] for r in by["BTC"]["reasons"]}
    assert out["state"]["proposed_gross_notional"] == pytest.approx(1500.0)
    near = rs.propose([pos("SOL", 400.0, mark=100.0, liquidation_price=94.0), pos("BTC", 400.0, mark=100.0, liquidation_price=60.0)], [1000.0])
    assert [(p["symbol"], p["to_notional"], p["reasons"][0]["rule"]) for p in near["proposals"]] == [("SOL", 200.0, "liquidation_distance")]
    # a long PAYS a positive rate; a short pays a negative one; receiving funding is never a reason to cut
    rate = 0.5 / 8760.0                                                # 50 % a year
    bleed = rs.propose([pos("A", 300.0, funding_rate_per_hour=rate), pos("B", -300.0, funding_rate_per_hour=rate),
                        pos("C", -300.0, funding_rate_per_hour=-rate)], [1000.0])
    assert {p["symbol"]: p["to_notional"] for p in bleed["proposals"]} == {"A": 150.0, "C": -150.0}
    assert all(p["reasons"][0]["rule"] == "funding_bleed" for p in bleed["proposals"])
    # the lowest allowed notional wins and every reason is kept
    both = rs.propose([pos("A", 800.0, mark=100.0, liquidation_price=95.0, funding_rate_per_hour=rate)], [1000.0, 940.0])
    p = both["proposals"][0]
    assert p["to_notional"] == pytest.approx(400.0) and {r["rule"] for r in p["reasons"]} == {"drawdown_soft"}


def test_supervisor_only_reduces_never_guesses_and_ignores_noise():
    for positions in ([pos("A", 2000.0)], [pos("A", -2000.0)], [pos("A", 10.0), pos("B", -5000.0)]):
        for p in rs.propose(positions, [1000.0, 900.0])["proposals"]:
            assert abs(p["to_notional"]) <= abs(p["from_notional"]) and p["to_notional"] * p["from_notional"] >= 0
    tiny = rs.propose([pos("A", 1000.4)], [1000.0])                    # 0.4 USD over the cap: below min_reduction_usd
    assert tiny["proposals"] == []
    for bad in ([pos("A", float("nan"))], [pos("A", 1.0), pos("A", 2.0)], [{"notional": 1.0}]):
        with pytest.raises(ValueError):
            rs.propose(bad, [1000.0])
    with pytest.raises(ValueError):
        rs.propose([], [])
    with pytest.raises(ValueError):
        rs.propose([], [1000.0], {"max_laverage": 2})
    wiped = rs.propose([pos("A", 100.0)], [1000.0, 0.0])
    assert wiped["proposals"][0]["to_notional"] == 0 and wiped["state"]["gross_leverage"] is None
    custom = rs.propose([pos("A", 900.0)], [1000.0], {"max_position_share": 0.5})
    assert custom["proposals"][0]["to_notional"] == 500.0 and custom["limits"]["drawdown_hard"] == 0.10


# --------------------------------------------------------------------------------------------------- forecasts

def test_losses_and_baselines():
    assert vf.qlike([2.0, 3.0], [2.0, 3.0]) == 0.0 and vf.mse([2.0, 3.0], [1.0, 5.0]) == 2.5
    assert vf.qlike([4.0], [2.0]) == pytest.approx(2 - math.log(2) - 1)           # under-prediction
    assert vf.qlike([4.0], [2.0]) > vf.qlike([4.0], [8.0])                         # ... costs more than over-prediction
    assert vf.ewma_forecast([1.0, 1.0, 1.0]) == pytest.approx(1.0)
    assert vf.ewma_forecast([0.0, 0.0, 10.0]) > vf.ewma_forecast([10.0, 0.0, 0.0])
    assert vf.har_forecast([1.0] * 20) is None                                    # too short: no forecast, not a guess


def test_realised_variance_and_har_on_a_process_it_can_learn():
    rng = np.random.default_rng(0)
    days = 200
    logv = np.zeros(days)
    for t in range(1, days):
        logv[t] = 0.9 * logv[t - 1] + rng.normal(0, 0.25)
    sig = 0.02 * np.exp(logv / 2)
    r = np.concatenate([rng.normal(0, s / math.sqrt(24), 24) for s in sig])
    idx = pd.date_range("2026-01-01", periods=len(r), freq="1h", tz="UTC")
    close = pd.Series(100 * np.exp(np.cumsum(r)), index=idx)
    rv = vf.daily_realised_variance(close)
    assert len(rv) in (days, days - 1) and rv.iloc[5] == pytest.approx(float((np.log(close).diff()[idx[120]:idx[143]] ** 2).sum()))
    res = vf.evaluate(rv, vf.daily_returns(close), min_train=60)
    assert res["forecast_days"] == len(rv) - 60 and set(res["splits"]) == {"train", "validation", "test", "all"}
    q = {m: res["splits"]["all"][m]["qlike"] for m in vf.MODELS}
    assert q["har"] < q["random_walk"]                                             # persistent volatility is learnable
    assert res["splits"]["all"]["har"]["mincer_zarnowitz_r2"] > 0.2
    # no look-ahead: the forecast of a day does not move when later days change
    f = vf.forecasts(rv, vf.daily_returns(close), min_train=60)
    rv2 = rv.copy()
    rv2.iloc[150:] *= 7.0
    f2 = vf.forecasts(rv2, vf.daily_returns(close), min_train=60)
    assert f.loc[f.index[:89], ["random_walk", "ewma", "har"]].equals(f2.loc[f2.index[:89], ["random_walk", "ewma", "har"]])
    assert not f["har"].iloc[100:].equals(f2["har"].iloc[100:])
    assert (f["har"] > 0).all()                                                    # the linear model is floored


# ------------------------------------------------------------------------------------------- market making

def synthetic_books(n=1500, seed=1, half_spread_bps=1.0):
    rng = np.random.default_rng(seed)
    mid = 100.0 * np.exp(np.cumsum(rng.normal(0, 1.5e-4, n)))
    h = mid * half_spread_bps / 1e4
    return mid - h, mid + h, mid


def test_as_quotes_skew_against_the_inventory_and_widen_with_risk():
    flat = studies.as_quotes(0, 2.0, 0.1, 0.6, 12.0)
    assert flat[0] == flat[1] > 0
    long_ = studies.as_quotes(3, 2.0, 0.1, 0.6, 12.0)
    assert long_[0] > flat[0] > long_[1]            # long inventory: the bid moves away, the ask comes closer
    short = studies.as_quotes(-3, 2.0, 0.1, 0.6, 12.0)
    assert (short[0], short[1]) == pytest.approx((long_[1], long_[0]))
    assert studies.as_quotes(0, 4.0, 0.1, 0.6, 12.0)[0] > flat[0]                 # more volatility: wider
    assert studies.as_quotes(3, 2.0, 0.1, 0.6, 12.0, skew=False) == flat          # the baseline ignores inventory


def test_mm_simulation_is_deterministic_and_the_skew_holds_less_inventory():
    bid, ask, mid = synthetic_books()
    fit = studies.fit_kappa(bid[:700], ask[:700], mid[:700], "touch")
    assert fit["kappa"] > 0 and fit["intervals"] == 699
    freq = [x["fills"] / x["quotes"] for x in fit["frequencies"] if x["quotes"]]
    assert freq[0] >= freq[-1]                                                    # further from the mid: fewer fills
    kw = dict(rule="touch", gamma=0.1, kappa=fit["kappa"], tau=12.0, maker_bps=1.5)
    a = studies.simulate_mm(bid[700:], ask[700:], mid[700:], skew=True, **kw)
    assert a == studies.simulate_mm(bid[700:], ask[700:], mid[700:], skew=True, **kw)
    b = studies.simulate_mm(bid[700:], ask[700:], mid[700:], skew=False, **kw)
    assert a["fills"] > 0 and a["inventory_abs_mean"] <= b["inventory_abs_mean"] and a["inventory_abs_max"] <= 5
    assert a["fees_usd"] == pytest.approx(a["fills"] * 1000.0 * 1.5 / 1e4)
    assert a["pnl_usd"] == pytest.approx(a["pnl_before_fees_usd"] - a["fees_usd"])
    cross = studies.simulate_mm(bid[700:], ask[700:], mid[700:], skew=True, **{**kw, "rule": "cross"})
    assert cross["fills"] <= a["fills"]                                           # the pessimistic rule fills less


def test_studies_on_a_store_state_their_assumptions(tmp_path):
    synthetic_store(tmp_path, n=900, venues=("hyperliquid", "edgex", "dydx", "coinbase"))
    cost = studies.round_trip_cost_bps("hyperliquid", "edgex", 1.0)
    assert cost["taker_fees_bps"] == 2 * (4.5 + 4.5) and cost["total_bps"] == cost["taker_fees_bps"] + cost["half_spreads_bps"] + 4.0
    out = studies.cross_exchange_study(tmp_path, pairs=(("hyperliquid", "edgex"), ("hyperliquid", "dydx")))
    row = out["bars"]["BTC: edgex vs hyperliquid"]
    assert row["level_bps_median"] == pytest.approx(6.0, abs=1.5)                 # the store's permanent premium
    assert row["deviation_abs_bps_median"] < 5 and 0 <= row["share_of_bars_with_estimated_net_edge_above_zero"] < 0.05
    text = json.dumps(out)
    assert "estimated_net_edge" in text and "profit" not in text.lower().replace("never a profit", "")
    assert any("ALREADY on both venues" in a for a in out["assumptions"]) and out["books"] == {}
    v = studies.vol_forecast_study(tmp_path, symbols=("BTC",))
    assert v["symbols"]["BTC"]["days_of_realised_variance"] in (37, 38) and "indicative" in v["statement"]
    m = studies.market_making_study(tmp_path)
    assert m["runs"] == {} and m["fills_are_modelled"] is True and "MODEL STUDY" in m["statement"]
