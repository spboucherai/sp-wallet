# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/tests/perp_helpers.py
# Description      : Helpers shared by the perp tests (hand-written bars,
#                    scripted decisions, synthetic funding).
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

"""Helpers shared by the perp tests (hand-written bars, scripted decisions, synthetic funding)."""
from __future__ import annotations

from decimal import Decimal

import numpy as np
import pandas as pd

from conftest import make_data
from spq.perp_engine import PerpConfig

D = Decimal


def bars(opens, closes, highs=None, lows=None, funding=None, start="2024-01-01", freq="1h", **extra) -> pd.DataFrame:
    """Hand-written bars. High/low default to the open/close envelope; `funding[i]` is the rate settled at ts[i]."""
    o, c = np.asarray(opens, float), np.asarray(closes, float)
    h = np.maximum(o, c) if highs is None else np.asarray(highs, float)
    low = np.minimum(o, c) if lows is None else np.asarray(lows, float)
    idx = pd.date_range(start, periods=len(o), freq=freq, tz="UTC", name="ts")
    df = pd.DataFrame({"open": o, "high": h, "low": low, "close": c, "volume": np.ones(len(o))}, index=idx)
    if funding is not None:
        df["funding"] = np.asarray(funding, float)
    for k, v in extra.items():
        df[k] = np.asarray(v, float)
    return df


def script(*steps):
    """A decision function that returns the given weights one call after the other (None = leave as is)."""
    calls = iter(steps)

    def decide(_view):
        return next(calls, None)

    return decide


def scripted_strategy(*steps, universe=("X",), max_leverage=20.0):
    """A perp Strategy (weights validated against META) that plays the given weights one call after the other;
    once they are exhausted it keeps returning the last one."""
    from spq.strategy import from_function

    state = {"i": 0}

    def f(_data, _params):
        w = steps[min(state["i"], len(steps) - 1)]
        state["i"] += 1
        return w

    return from_function(f, perp_meta(universe, lookback=1, max_leverage=max_leverage))


def cfg(**kw) -> PerpConfig:
    """Round numbers for hand computation: fee 10 bps, slippage 10 bps, 10x, maintenance 5 %, no penalty."""
    base = dict(interval="1h", taker_fee_bps=10.0, slippage_bps=10.0, initial_cash=1000.0, min_order=0.0,
                leverage=10.0, maintenance_fraction=0.05, liquidation_penalty_bps=0.0)
    base.update(kw)
    return PerpConfig(**base)


def perp_meta(universe=("X",), lookback=10, max_leverage=3.0, max_gross=None, params=None, name="t"):
    return {"name": name, "version": "1", "kind": "perp", "universe": list(universe), "interval": "1h",
            "lookback": lookback, "max_leverage": max_leverage,
            "max_gross_exposure": max_gross if max_gross is not None else max_leverage * len(universe),
            "params": params or {}}


def perp_data(n, symbols=("BTC", "ETH"), seed=0, rate=1.25e-5, rate_sigma=2e-5, **kw) -> dict[str, pd.DataFrame]:
    """Random-walk candles with an autocorrelated funding column (settled at each bar's open)."""
    data = make_data(n, symbols, seed=seed, **kw)
    rng = np.random.default_rng(seed + 999)
    for i, s in enumerate(symbols):
        noise = rng.normal(0, rate_sigma, n)
        f = np.empty(n)
        f[0] = rate
        for t in range(1, n):
            f[t] = rate + 0.9 * (f[t - 1] - rate) + 0.3 * noise[t]
        data[s]["funding"] = np.round(f, 10)
        data[s]["premium"] = np.round(f * 8 - 1e-4, 10)
    return data


def settlements(df: pd.DataFrame) -> pd.DataFrame:
    """The settlement series that `df['funding']` was built from (index = settlement hour)."""
    f = df[["funding"]].rename(columns={"funding": "rate"}).dropna()
    f["premium"] = df["premium"] if "premium" in df.columns else np.nan
    f["time_ms"] = f.index.as_unit("ms").asi8 + 40
    return f
