# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/tests/test_metrics.py
# Description      : Metrics against small examples computed by hand.
# Module           : research
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

"""Metrics against small examples computed by hand."""
from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from conftest import frame
from spq.engine import TRADE_COLUMNS, BacktestConfig, BacktestResult, buy_and_hold, equal_weight
from spq.metrics import compute_metrics, max_drawdown, return_distribution, sharpe_ratio, sortino_ratio


def result(equity, interval="1d", trades=(), open_positions=(), exposure=None):
    idx = pd.date_range("2024-01-01", periods=len(equity), freq={"1d": "1D", "1h": "1h"}[interval], tz="UTC")
    eq = pd.Series(equity, index=idx, dtype="float64")
    exp = pd.Series(exposure if exposure is not None else np.zeros(len(eq)), index=idx)
    return BacktestResult(symbols=["X"], config=BacktestConfig(interval), equity=eq, cash=eq * 0, exposure=exp,
                          decisions=pd.DataFrame(), trades=pd.DataFrame(list(trades), columns=TRADE_COLUMNS),
                          open_positions=list(open_positions))


def test_return_metrics_by_hand():
    # equity 100 -> 110 -> 99 -> 108.9 : returns +10 %, -10 %, +10 %
    m = compute_metrics(result([100.0, 110.0, 99.0, 108.9], "1d", exposure=[0, 1, 1, 0.5]))
    mean = 0.1 / 3
    std = math.sqrt(((0.1 - mean) ** 2 * 2 + (-0.1 - mean) ** 2) / 2)      # ddof = 1 -> 0.11547
    downside = math.sqrt((0.1 ** 2) / 3)                                      # only the -10 % bar -> 0.057735
    assert m["total_return"] == pytest.approx(0.089)
    assert m["cagr"] == pytest.approx(1.089 ** (365 / 3) - 1)
    assert m["volatility"] == pytest.approx(std * math.sqrt(365))
    assert std == pytest.approx(0.1154700538)
    assert m["sharpe"] == pytest.approx(mean / std * math.sqrt(365))
    assert m["sharpe"] == pytest.approx(0.2886751346 * math.sqrt(365))
    assert m["sortino"] == pytest.approx(mean / downside * math.sqrt(365))
    assert m["max_drawdown"] == pytest.approx(0.1)                          # 110 -> 99
    assert m["calmar"] == pytest.approx(m["cagr"] / 0.1)
    assert m["exposure"] == pytest.approx(0.625)
    assert m["trades"] == 0 and m["win_rate"] is None and m["profit_factor"] is None
    assert m["fees_paid"] == 0 and m["turnover"] == 0
    assert m["returns"]["n"] == 3 and m["returns"]["positive_fraction"] == pytest.approx(2 / 3)
    assert m["returns"]["min"] == pytest.approx(-0.1) and m["returns"]["max"] == pytest.approx(0.1)


@pytest.mark.parametrize("interval,bars", [("1h", 8760), ("1d", 365)])
def test_annualisation_follows_the_interval(interval, bars):
    eq = [100.0, 101.0, 100.5, 102.0, 101.0]
    r = np.diff(eq) / np.array(eq[:-1])
    m = compute_metrics(result(eq, interval))
    assert m["sharpe"] == pytest.approx(r.mean() / r.std(ddof=1) * math.sqrt(bars))
    assert m["volatility"] == pytest.approx(r.std(ddof=1) * math.sqrt(bars))
    assert m["cagr"] == pytest.approx((eq[-1] / eq[0]) ** (bars / 4) - 1)


def test_trade_metrics_by_hand():
    t0 = pd.Timestamp("2024-01-02", tz="UTC")
    trades = [
        (t0, t0, "X", "buy", 1.0, 50.0, 50.0, 0.05, 0.05, 0.0),
        (t0, t0, "X", "sell", 0.5, 120.0, 60.0, 0.06, 0.06, 9.8),
        (t0, t0, "X", "sell", 0.2, 100.0, 20.0, 0.02, 0.02, -5.0),
    ]
    m = compute_metrics(result([100.0, 104.0, 108.0], "1d", trades,
                               open_positions=[{"symbol": "X", "units": 0.3, "cost": 28.0, "value": 30.0}]))
    # closed lots: +9.8, -5.0, and the open position marked at the last close: +2.0
    assert m["trades"] == 3 and m["closed_lots"] == 3
    assert m["win_rate"] == pytest.approx(2 / 3)
    assert m["profit_factor"] == pytest.approx(11.8 / 5.0)
    assert m["fees_paid"] == pytest.approx(0.13) and m["slippage_paid"] == pytest.approx(0.13)
    assert m["turnover"] == pytest.approx(130.0 / 104.0)                    # traded notional / mean equity
    assert m["turnover_annual"] == pytest.approx(130.0 / 104.0 * 365 / 2)


def test_undefined_ratios_are_null_not_infinite():
    flat = compute_metrics(result([100.0, 100.0, 100.0, 100.0]))
    assert flat["sharpe"] is None and flat["sortino"] is None and flat["calmar"] is None
    assert flat["max_drawdown"] == 0 and flat["total_return"] == 0 and flat["volatility"] == 0
    up = compute_metrics(result([100.0, 101.0, 103.0]))
    assert up["sortino"] is None and up["calmar"] is None and up["max_drawdown"] == 0
    assert math.isnan(sharpe_ratio([0.01])) and math.isnan(sortino_ratio([0.01, 0.02]))


def test_max_drawdown_and_distribution():
    assert max_drawdown([100, 120, 90, 130, 65, 70]) == pytest.approx(0.5)   # 130 -> 65
    assert max_drawdown([1, 2, 3]) == 0
    d = return_distribution(np.array([-0.02, 0.0, 0.01, 0.03]))
    assert d["mean"] == pytest.approx(0.005) and d["median"] == pytest.approx(0.005) and d["n"] == 4
    assert d["std"] == pytest.approx(np.std([-0.02, 0.0, 0.01, 0.03], ddof=1))


def test_buy_and_hold_benchmark_by_hand():
    # one asset, fee 10 bps, slippage 20 bps, bought at the open of the second bar
    data = {"X": frame([100, 100, 110, 121], [100, 110, 121, 133.1])}
    cfg = BacktestConfig("1h", fee_bps=10, slippage_bps=20, initial_cash=1000)
    res = buy_and_hold(data, cfg)
    units = 1000 / 1.001 / (100 * 1.002)
    np.testing.assert_allclose(res.equity.to_numpy(), [1000, units * 110, units * 121, units * 133.1])
    assert len(res.trades) == 1 and res.trades["ts"].iloc[0] == data["X"].index[1]
    m = compute_metrics(res)
    assert m["total_return"] == pytest.approx(units * 133.1 / 1000 - 1)
    assert m["fees_paid"] == pytest.approx(1000 / 1.001 * 0.001)
    assert m["slippage_paid"] == pytest.approx(units * 100 * 0.002)
    assert m["win_rate"] == 1.0 and m["profit_factor"] is None and m["trades"] == 1
    assert m["exposure"] == pytest.approx(0.75)


def test_equal_weight_benchmark_rebalances_and_buy_and_hold_does_not():
    a = frame([100, 100, 100, 150, 150, 150], [100, 100, 150, 150, 150, 150])
    b = frame([100, 100, 100, 100, 100, 100], [100, 100, 100, 100, 100, 100])
    cfg = BacktestConfig("1h", fee_bps=0, slippage_bps=0, initial_cash=1000)
    bh = buy_and_hold({"A": a, "B": b}, cfg)
    assert len(bh.trades) == 2                                # bought once, 50/50
    assert bh.equity.iloc[-1] == pytest.approx(1250.0)
    ew = equal_weight({"A": a, "B": b}, cfg)
    assert len(ew.trades) > 2                                 # sells A after its rise to restore 50/50
    assert (ew.trades["side"] == "sell").any()
