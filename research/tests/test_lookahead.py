# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/tests/test_lookahead.py
# Description      : The strategy must never see the bar it is filled on.
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

"""The strategy must never see the bar it is filled on."""
from __future__ import annotations

import numpy as np
import pandas as pd

from conftest import make_data
from spq.engine import BacktestConfig, run_backtest
from spq.metrics import sharpe_ratio
from spq.robustness import lookahead_check
from spq.strategy import from_function

FREE = BacktestConfig("1h", fee_bps=0, slippage_bps=0)


def meta(lookback=30, universe=("X",)):
    return {"name": "t", "version": "1", "universe": list(universe), "interval": "1h", "lookback": lookback,
            "params": {}}


def peek(d, p):
    """Long when the newest bar it can see closed above its open.

    If that newest bar were the fill bar (bought at its open), this would be a money machine."""
    last = d["X"].iloc[-1]
    return {"X": 1.0 if last["close"] > last["open"] else 0.0}


def test_inputs_end_at_the_decision_bar_and_fills_come_strictly_later():
    data = make_data(500, ("X",), seed=1)
    seen = []

    def spy(d, p):
        seen.append((d["X"].index[0], d["X"].index[-1], len(d["X"])))
        return peek(d, p)

    res = run_backtest(from_function(spy, meta(30)), data, FREE)
    idx = data["X"].index
    pos = {ts: i for i, ts in enumerate(idx)}
    assert len(seen) == len(res.decisions) == len(idx) - 29
    for (first, last, n), decided in zip(seen, res.decisions.index):
        assert last == decided and n == 30 and pos[last] - pos[first] == 29   # never more than `lookback` bars
    for _, t in res.trades.iterrows():
        assert pos[t["ts"]] == pos[t["decided_at"]] + 1                         # filled on the NEXT bar
        assert t["price"] == data["X"]["open"].loc[t["ts"]]                     # at its open


def test_a_strategy_that_tries_to_use_the_future_gains_nothing():
    """On a random walk with independent increments, knowing bar t says nothing about bar t+1.

    The same rule gets rich as soon as the data are leaked by one bar (each row carrying the values of the
    next bar), which shows that the test would detect an engine that hands the fill bar to the strategy."""
    n = 6000
    data = make_data(n, ("X",), seed=11, sigma=0.01)
    honest = run_backtest(from_function(peek, meta(5)), data, FREE)
    r = honest.returns.to_numpy()
    assert abs(sharpe_ratio(r)) < 0.05                    # per-bar Sharpe; its standard error is 1/sqrt(n) = 0.013
    many = [sharpe_ratio(run_backtest(from_function(peek, meta(5)), make_data(n, ("X",), seed=100 + k), FREE)
                         .returns.to_numpy()) for k in range(8)]
    assert abs(np.mean(many)) < 0.02                      # no systematic edge across independent samples

    df = data["X"]
    idx = df.index
    position = {ts: i for i, ts in enumerate(idx)}

    def leaky(view):  # what an engine with an off-by-one would do: the window ends on the fill bar
        end = position[view["X"].index[-1]]
        return peek({"X": df.iloc[max(0, end - 3): end + 2]}, {})

    leaked = run_backtest(leaky, data, FREE, lookback=5)
    assert sharpe_ratio(leaked.returns.to_numpy()) > 0.5
    assert leaked.equity.iloc[-1] > 1e6 * honest.equity.iloc[-1]


def test_shifted_data_gives_shifted_results():
    data = make_data(800, ("X", "Y"), seed=21)

    def trend(d, p):
        return {s: 0.5 if df["close"].iloc[-1] > df["close"].iloc[0] else 0.0 for s, df in d.items()}

    s = from_function(trend, meta(48, ("X", "Y")))
    cfg = BacktestConfig("1h", fee_bps=10, slippage_bps=10, rebalance_threshold=0.02)
    base = run_backtest(s, data, cfg)

    # 1. the same bars stamped 37 hours later: identical results, 37 hours later
    shift = pd.Timedelta(hours=37)
    later = {k: df.set_axis(df.index + shift) for k, df in data.items()}
    moved = run_backtest(s, later, cfg)
    assert moved.equity.index.equals(base.equity.index + shift)
    np.testing.assert_array_equal(moved.equity.to_numpy(), base.equity.to_numpy())
    assert list(moved.trades["ts"]) == list(base.trades["ts"] + shift)
    np.testing.assert_array_equal(moved.decisions.to_numpy(), base.decisions.to_numpy())

    # 2. values delayed by k bars (row t holds what row t-k held): every decision and fill happens k bars later
    k = 5
    delayed = {name: df.shift(k).iloc[k:] for name, df in data.items()}
    late = run_backtest(s, delayed, cfg)
    np.testing.assert_allclose(late.equity.to_numpy(), base.equity.to_numpy()[:-k], rtol=1e-12)
    assert list(late.trades["ts"]) == list((base.trades["ts"] + pd.Timedelta(hours=k))[base.trades["ts"] < base.equity.index[-k]])

    # 3. dropping old history that is beyond the lookback changes nothing
    idx = data["X"].index
    full = run_backtest(s, data, cfg, start=idx[300])
    cut = run_backtest(s, {name: df.iloc[200:] for name, df in data.items()}, cfg, start=idx[300])
    pd.testing.assert_series_equal(full.equity, cut.equity)


def test_changing_the_future_does_not_change_the_past():
    data = make_data(600, ("X",), seed=31)
    s = from_function(peek, meta(10))
    base = run_backtest(s, data, BacktestConfig("1h"))
    t = 400
    altered = {"X": data["X"].copy()}
    rng = np.random.default_rng(0)
    altered["X"].iloc[t + 1:, :4] *= rng.uniform(0.5, 1.5, size=(600 - t - 1, 1))
    other = run_backtest(s, altered, BacktestConfig("1h"))
    idx = data["X"].index
    np.testing.assert_array_equal(other.equity.iloc[:t + 1].to_numpy(), base.equity.iloc[:t + 1].to_numpy())
    pd.testing.assert_frame_equal(other.decisions.loc[:idx[t]], base.decisions.loc[:idx[t]])
    assert not np.array_equal(other.equity.iloc[t + 2:].to_numpy(), base.equity.iloc[t + 2:].to_numpy())


def test_lookahead_check_passes_on_the_engine_and_fails_on_a_leaky_one():
    data = make_data(900, ("X",), seed=41)
    s = from_function(peek, meta(10))
    ok = lookahead_check(s, data, BacktestConfig("1h"))
    assert ok["status"] == "pass", ok

    def leaky_runner(strategy, d, config, **kw):
        df = d["X"]
        position = {ts: i for i, ts in enumerate(df.index)}

        def decide(view):
            end = position[view["X"].index[-1]]
            return strategy({"X": df.iloc[max(0, end - 8): end + 2]})   # one bar too many when it exists

        return run_backtest(decide, d, config, start=kw.get("start"), end=kw.get("end"), lookback=10)

    bad = lookahead_check(s, data, BacktestConfig("1h"), runner=leaky_runner)
    assert bad["status"] == "fail" and "decisions" in bad["detail"]

    short = lookahead_check(s, make_data(8, ("X",)), BacktestConfig("1h"))
    assert short["status"] == "fail"
