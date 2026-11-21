# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/tests/test_library.py
# Description      : Every strategy of the library returns valid weights on
#                    synthetic data.
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
# universe-generic versions (META['universe'] == ['*']): one per rule that makes sense for any set of symbols
GENERIC = {"ts_momentum", "ma_trend", "donchian_breakout", "vol_target_trend", "mean_reversion", "xs_momentum"}
GENERIC_SYMBOLS = ["ETH", "UNI", "LINK", "POL"]   # what an agent could pick; nothing in a generic strategy names them


def symbols_of(strategy):
    return GENERIC_SYMBOLS if strategy.generic else strategy.universe


def synthetic(strategy, n, seed):
    """Random walks with different drifts so that trends, breakouts and rank changes all occur."""
    drifts = [0.0004, -0.0003, 0.0001, 0.0]
    out = {}
    for i, sym in enumerate(symbols_of(strategy)):
        out.update(make_data(n, (sym,), seed=seed + 31 * i, drift=drifts[i % 4], sigma=0.012, p0=50.0 * (i + 1)))
    return out


def test_the_library_is_complete():
    assert {d.parent.name for d in LIBRARY} == EXPECTED
    assert {d.parent.name for d in LIBRARY if d.name == "3"} == GENERIC
    for d in LIBRARY:
        readme = (d / "README.md").read_text()
        assert "**Hypothesis.**" in readme and "**What would refute it.**" in readme, d


@pytest.mark.parametrize("directory", LIBRARY, ids=IDS)
def test_library_strategy_contract(directory):
    s = load_strategy(directory)                      # strict: passes the static purity check
    assert s.static_problems == [] and s.sha256 == sha256_file(directory / "strategy.py")
    assert s.name == directory.parent.name and s.meta["version"] == directory.name
    assert s.meta["interval"] == "1h" and s.universe in (["ETH", "BTC", "LINK", "SOL"], ["ETH", "LINK", "AAVE"], ["*"])
    assert s.generic == (directory.name == "3")
    universe = symbols_of(s)

    full = synthetic(s, s.lookback + 400, seed=5)
    stride = 97 if s.name != "garch_regime" else 199
    seen_invested = False
    for end in range(s.lookback, s.lookback + 400, stride):
        view = {sym: df.iloc[end - s.lookback:end] for sym, df in full.items()}
        before = {sym: df.copy() for sym, df in view.items()}
        raw = s.raw(view)
        w = validate_weights(raw, universe)         # dict, finite, each in [0, 1], known symbols, sum <= 1
        assert set(w) == set(universe) and all(0.0 <= x <= 1.0 for x in w.values())
        assert sum(w.values()) <= 1.0 + 1e-9
        assert s.raw(view) == raw                     # pure: same inputs, same output
        for sym in view:
            pd.testing.assert_frame_equal(view[sym], before[sym])   # inputs are not modified
        seen_invested |= sum(w.values()) > 0
    assert seen_invested, "the strategy never invested on trending synthetic data"

    # degenerate inputs: too little history, a constant price, a subset of the universe
    tiny = {sym: df.iloc[:3] for sym, df in full.items()}
    assert sum(validate_weights(s.raw(tiny), universe).values()) <= 1.0
    flat = {sym: df.assign(open=10.0, high=10.0, low=10.0, close=10.0).iloc[:s.lookback] for sym, df in full.items()}
    assert sum(validate_weights(s.raw(flat), universe).values()) <= 1.0
    two = {sym: full[sym].iloc[:s.lookback] for sym in universe[:2]}
    assert sum(validate_weights(s.raw(two), universe[:2]).values()) <= 1.0 + 1e-9


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
