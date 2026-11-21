# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/tests/test_perp_lookahead.py
# Description      : Funding, premium, mark and index are inputs like prices: a
#                    strategy must never see a value from after its decision
#                    bar, and the engine must never charge a settlement the
#                    strategy could have read.
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

"""Funding, premium, mark and index are inputs like prices: a strategy must never see a value from after its
decision bar, and the engine must never charge a settlement the strategy could have read."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from perp_helpers import bars, cfg, perp_data, perp_meta, settlements
from spq.data.hyperliquid import attach_funding, check_funding_alignment
from spq.metrics import sharpe_ratio
from spq.perp_engine import PerpConfig, run_perp_backtest
from spq.perp_research import PerpExperiment
from spq.research import TestSplitError
from spq.robustness import lookahead_check
from spq.strategy import from_function

FREE = PerpConfig("1h", taker_fee_bps=0, slippage_bps=0, min_order=0)


def funding_sign(d, p):
    """Short when the newest funding rate it can see is positive, long when negative."""
    f = d["X"]["funding"].iloc[-1]
    return {"X": -1.0 if f > 0 else 1.0}


def one(n=600, seed=1, **kw):
    data = perp_data(n, ("X",), seed=seed, rate=0.0, rate_sigma=5e-4, **kw)
    data["X"]["mark"] = data["X"]["close"] * 1.0001
    data["X"]["index"] = data["X"]["close"] * 0.9999
    return data


def test_every_input_column_ends_at_the_decision_bar():
    data = one()
    seen = []

    def spy(d, p):
        df = d["X"]
        seen.append((df.index[-1], len(df), tuple(df.columns), df["funding"].iloc[-1], df["mark"].iloc[-1],
                     df["index"].iloc[-1], df["premium"].iloc[-1]))
        return {"X": 0.5}

    res = run_perp_backtest(from_function(spy, perp_meta(("X",), lookback=30)), data, FREE)
    full = data["X"]
    assert len(seen) == len(res.decisions) == len(full) - 29
    for (last, n, cols, f, mark, index, prem), decided in zip(seen, res.decisions.index):
        assert last == decided and n == 30
        assert {"funding", "premium", "mark", "index"} <= set(cols)
        row = full.loc[decided]                       # the newest values are those of the decision bar itself
        assert (f, mark, index, prem) == (row["funding"], row["mark"], row["index"], row["premium"])
    # the settlement charged at the fill bar is the NEXT row's rate: it was not in the inputs
    pos = {ts: i for i, ts in enumerate(full.index)}
    first = res.funding.iloc[0]
    assert pos[first["ts"]] == pos[res.trades.iloc[0]["ts"]] + 1
    assert float(first["rate"]) == full["funding"].iloc[pos[first["ts"]]]


def test_a_strategy_that_peeks_at_the_next_funding_rate_is_caught():
    """Honest inputs: the newest rate seen is the one settled at the decision bar's open. If the engine handed
    even one more row, the truncation check must fail. A position decided on bar i is filled at the open of bar
    i+1 AFTER that hour's settlement, so the first payment it is exposed to is the one of bar i+2: a rule that
    could read that row would be on the receiving side almost every hour."""
    data = one(900, seed=5)
    s = from_function(funding_sign, perp_meta(("X",), lookback=10))
    ok = lookahead_check(s, data, FREE, runner=run_perp_backtest)
    assert ok["status"] == "pass", ok

    def leaky_runner(strategy, d, config, ahead=1, **kw):
        df = d["X"]
        position = {ts: i for i, ts in enumerate(df.index)}

        def decide(view):
            end = position[view["X"].index[-1]]
            return strategy({"X": df.iloc[max(0, end - 8): end + 1 + ahead]})   # rows from the future when they exist

        return run_perp_backtest(decide, d, config, start=kw.get("start"), end=kw.get("end"), lookback=10)

    # a rule whose weight moves with the LEVEL of the newest rate: any extra row changes the decision at the cut
    level = from_function(lambda d, p: {"X": float(np.clip(-1000 * d["X"]["funding"].iloc[-1], -1, 1))},
                          perp_meta(("X",), lookback=10))
    assert lookahead_check(level, data, FREE, runner=run_perp_backtest)["status"] == "pass"
    bad = lookahead_check(level, data, FREE, runner=leaky_runner)               # one leaked row is enough to fail
    assert bad["status"] == "fail" and "decisions" in bad["detail"]

    honest = run_perp_backtest(s, data, FREE)
    leaked = leaky_runner(s, data, FREE, ahead=2)
    # funding is autocorrelated in this fixture, so even the honest rule collects some; the peeker collects more,
    # because it is on the receiving side of (nearly) every settlement it is charged
    paid_honest, paid_leaked = float(honest.ledger["funding"]), float(leaked.ledger["funding"])
    received = lambda r: float(np.mean([float(a) > 0 for a in r.funding["amount"]]))  # noqa: E731
    assert received(leaked) > 0.97 and received(leaked) > received(honest) + 0.05
    assert paid_leaked > paid_honest > 0


def test_peeking_at_independent_funding_earns_nothing_without_a_leak():
    """With i.i.d. funding the newest visible rate says nothing about the next settlement: no funding edge.
    The same rule with one leaked row receives every payment."""
    n = 4000
    data = perp_data(n, ("X",), seed=9, rate=0.0, rate_sigma=0.0, sigma=1e-9)
    rng = np.random.default_rng(3)
    data["X"]["funding"] = rng.normal(0, 1e-4, n)
    s = from_function(funding_sign, perp_meta(("X",), lookback=5))
    honest = run_perp_backtest(s, data, FREE)
    amounts = np.array([float(a) for a in honest.funding["amount"]])
    assert abs(amounts.mean()) / amounts.std() < 0.05                  # standard error 1/sqrt(4000) = 0.016
    df = data["X"]
    position = {ts: i for i, ts in enumerate(df.index)}

    def leaky(view):                                  # sees the settlement its new position will be charged
        end = position[view["X"].index[-1]]
        return funding_sign({"X": df.iloc[max(0, end - 3): end + 3]}, {})

    leaked = run_perp_backtest(leaky, data, FREE, lookback=5)
    amounts = np.array([float(a) for a in leaked.funding["amount"]])
    assert (amounts[:-2] > 0).mean() > 0.99 and float(leaked.ledger["funding"]) > 50 * abs(float(honest.ledger["funding"]))
    assert sharpe_ratio(leaked.returns.to_numpy()) > 0.5
    # one leaked row (the settlement of the fill bar itself) changes the decisions but earns nothing: that
    # settlement is charged to the PREVIOUS position, before the fill
    def one_row(view):
        end = position[view["X"].index[-1]]
        return funding_sign({"X": df.iloc[max(0, end - 3): end + 2]}, {})

    amounts = np.array([float(a) for a in run_perp_backtest(one_row, data, FREE, lookback=5).funding["amount"]])
    assert abs(amounts.mean()) / amounts.std() < 0.05


def test_changing_future_funding_mark_or_index_does_not_change_the_past():
    data = one(500, seed=13)

    def uses_everything(d, p):
        df = d["X"]
        basis = df["mark"].iloc[-1] / df["index"].iloc[-1] - 1.0
        return {"X": float(np.clip(-2000 * df["funding"].iloc[-5:].mean() + 50 * basis, -1, 1))}

    s = from_function(uses_everything, perp_meta(("X",), lookback=20))
    base = run_perp_backtest(s, data, FREE)
    t = 300
    idx = data["X"].index
    for col in ("funding", "mark", "index", "premium"):
        altered = {"X": data["X"].copy()}
        altered["X"].loc[idx[t + 1]:, col] = altered["X"].loc[idx[t + 1]:, col] * 1.37 + (1e-4 if col == "funding" else 0)
        other = run_perp_backtest(s, altered, FREE)
        np.testing.assert_array_equal(other.equity.iloc[:t + 1].to_numpy(), base.equity.iloc[:t + 1].to_numpy())
        pd.testing.assert_frame_equal(other.decisions.loc[:idx[t]], base.decisions.loc[:idx[t]])
    # ... and the check used in every report agrees
    assert lookahead_check(s, data, FREE, runner=run_perp_backtest)["status"] == "pass"


def test_funding_alignment_check_detects_a_column_shifted_by_one_bar():
    data = perp_data(300, ("BTC", "ETH"), seed=2)
    raw = {s: settlements(df) for s, df in data.items()}
    assert check_funding_alignment(data, raw)["status"] == "pass"
    # the classic mistake: row i carries the rate settled at the END of bar i (the next settlement)
    shifted = {s: df.assign(funding=df["funding"].shift(-1)) for s, df in data.items()}
    bad = check_funding_alignment(shifted, raw)
    assert bad["status"] == "fail" and bad["detail"]["BTC"]["column_matches_settlements"] is False
    assert check_funding_alignment({s: df.drop(columns=["funding"]) for s, df in data.items()}, raw)["status"] == "fail"
    assert check_funding_alignment(data, {})["status"] == "fail"
    # settlement instants far from the hour cannot be attributed to a bar
    late = {s: f.assign(time_ms=f["time_ms"] + 5 * 60_000) for s, f in raw.items()}
    assert check_funding_alignment(data, late)["status"] == "fail"


def test_attach_funding_never_puts_a_later_settlement_on_a_bar():
    candles = bars([100] * 6, [100] * 6, start="2024-01-01 00:00")
    hours = pd.date_range("2023-12-31 23:00", periods=9, freq="1h", tz="UTC")
    f = pd.DataFrame({"rate": np.arange(1, 10) * 1e-5, "premium": np.arange(1, 10) * 1e-4}, index=hours)
    out = attach_funding(candles, f)
    # the bar opening at 00:00 gets the settlement of 00:00 (the 2nd row), ... ; 23:00 belongs to no bar here,
    # and the settlements of 06:00 and 07:00 are after the last bar: dropped
    np.testing.assert_allclose(out["funding"].to_numpy(), np.arange(2, 8) * 1e-5)
    np.testing.assert_allclose(out["premium"].to_numpy(), np.arange(2, 8) * 1e-4)
    # 4-hour bars: the sum of the settlements in (previous open, open]
    four = bars([100] * 3, [100] * 3, start="2024-01-01 00:00", freq="4h")
    f = pd.DataFrame({"rate": 1e-5, "premium": 0.0}, index=pd.date_range("2024-01-01", periods=12, freq="1h", tz="UTC"))
    np.testing.assert_allclose(attach_funding(four, f)["funding"].to_numpy(), [1e-5, 4e-5, 4e-5])
    # a missing settlement is NaN, never filled
    gap = attach_funding(candles, pd.DataFrame({"rate": [1e-5, 3e-5], "premium": [0.0, 0.0]},
                                               index=pd.DatetimeIndex(["2024-01-01 00:00", "2024-01-01 02:00"], tz="UTC")))
    assert np.isnan(gap["funding"].to_numpy()).tolist() == [False, True, False, True, True, True]


def test_selection_code_only_sees_funding_from_before_the_test_split():
    data = perp_data(600, ("BTC", "ETH"), seed=4)
    exp = PerpExperiment(data, cfg())
    test_start = exp.splits.test[0]
    for df in exp.dev_data().values():
        assert df.index[-1] < test_start and "funding" in df.columns and df["funding"].index[-1] < test_start
    seen = []

    def spy(d, p):
        seen.append(d["BTC"].index[-1])
        return {"BTC": 0.2, "ETH": -0.2}

    s = from_function(spy, perp_meta(("BTC", "ETH"), lookback=10))
    exp.trial(s)
    exp.run(s, "validation")
    assert max(seen) < test_start
    with pytest.raises(TestSplitError):
        exp.run(s, "test")
    exp.final_test(s)
    assert max(seen) >= test_start
    with pytest.raises(TestSplitError):
        exp.trial(s)                                  # sealed: no tuning after the look
