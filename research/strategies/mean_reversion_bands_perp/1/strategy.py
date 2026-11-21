# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/strategies/mean_reversion_bands_perp/1/strategy.py
# Description      : Z-score bands with a regime filter: fade a stretched price
#                    only while the market is ranging.
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

"""Z-score bands with a regime filter: fade a stretched price only while the market is ranging."""

import numpy as np

META = {
    "name": "mean_reversion_bands_perp",
    "version": "1",
    "kind": "perp",
    "universe": ["*"],
    "min_symbols": 1,
    "max_symbols": 12,
    "interval": "1h",
    "lookback": 600,
    "max_leverage": 1.0,
    "max_gross_exposure": 1.0,
    "params": {"window": 48, "entry_z": 2.0, "exit_z": 0.5, "stop_z": 4.0, "regime_bars": 168,
               "max_efficiency": 0.2, "state_bars": 240, "gross": 1.0},
}


def _zscores(close, window):
    """z of each close against the mean and standard deviation of the `window` closes ending on it."""
    views = np.lib.stride_tricks.sliding_window_view(close, window)
    mean = views.mean(axis=1)
    std = views.std(axis=1, ddof=1)
    z = np.zeros(len(mean))
    ok = std > 0
    z[ok] = (close[window - 1:][ok] - mean[ok]) / std[ok]
    return z


def _efficiency(close, bars):
    """Kaufman efficiency ratio of each `bars`-bar window ending on a close: |net move| / sum of |bar moves|.
    Near 1 = a straight trend, near 0 = a range."""
    moves = np.abs(np.diff(close))
    path = np.lib.stride_tricks.sliding_window_view(moves, bars).sum(axis=1)
    net = np.abs(close[bars:] - close[:-bars])
    ratio = np.ones(len(path))
    ok = path > 0
    ratio[ok] = net[ok] / path[ok]
    return ratio


def _state(z, ranging, entry_z, exit_z, stop_z):
    """Replay the rule over the window (the function keeps no memory): +1 long, -1 short, 0 flat."""
    state, blocked = 0, False
    for value, calm in zip(z, ranging):
        if blocked and abs(value) < exit_z:
            blocked = False
        if state == 0:
            if calm and not blocked and entry_z < abs(value) < stop_z:
                state = -1 if value > 0 else 1
        elif abs(value) > stop_z:                       # the deviation kept growing: stop, wait for a return
            state, blocked = 0, True
        elif (state == 1 and value > -exit_z) or (state == -1 and value < exit_z):
            state = 0
    return state


def target_weights(data, params):
    window, regime_bars, state_bars = int(params["window"]), int(params["regime_bars"]), int(params["state_bars"])
    entry_z, exit_z, stop_z = float(params["entry_z"]), float(params["exit_z"]), float(params["stop_z"])
    max_efficiency, gross = float(params["max_efficiency"]), min(float(params["gross"]), 1.0)
    n = len(data)
    weights = {symbol: 0.0 for symbol in data}
    need = max(window, regime_bars + 1) + state_bars
    if n == 0 or window < 3 or regime_bars < 2 or state_bars < 1 or not exit_z < entry_z < stop_z or gross <= 0:
        return weights
    for symbol, df in data.items():
        close = df["close"].to_numpy()
        if len(close) < need or not (close > 0).all():
            continue
        z = _zscores(close, window)[-state_bars:]
        ranging = _efficiency(close, regime_bars)[-state_bars:] < max_efficiency
        weights[symbol] = _state(z, ranging, entry_z, exit_z, stop_z) * gross / n
    return weights
