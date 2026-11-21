# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/strategies/zscore_reversion_perp/1/strategy.py
# Description      : Long/short z-score mean reversion with a stop: fade large
#                    deviations from the short-term mean.
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

"""Long/short z-score mean reversion with a stop: fade large deviations from the short-term mean."""

import numpy as np

META = {
    "name": "zscore_reversion_perp",
    "version": "1",
    "kind": "perp",
    "universe": ["BTC", "ETH", "SOL", "HYPE"],
    "interval": "1h",
    "lookback": 300,
    "max_leverage": 2.0,
    "max_gross_exposure": 2.0,
    "params": {"window": 48, "entry_z": 2.0, "exit_z": 0.5, "stop_z": 4.0, "gross": 1.0},
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


def _state(z, entry_z, exit_z, stop_z):
    """Replay the rule over the window (the function keeps no memory): +1 long, -1 short, 0 flat."""
    state, blocked = 0, False
    for value in z:
        if blocked and abs(value) < exit_z:
            blocked = False
        if state == 0:
            if not blocked and entry_z < abs(value) < stop_z:
                state = -1 if value > 0 else 1
        elif abs(value) > stop_z:                       # the deviation kept growing: stop, wait for a return
            state, blocked = 0, True
        elif (state == 1 and value > -exit_z) or (state == -1 and value < exit_z):
            state = 0
    return state


def target_weights(data, params):
    window = int(params["window"])
    entry_z, exit_z, stop_z = float(params["entry_z"]), float(params["exit_z"]), float(params["stop_z"])
    gross = float(params["gross"])
    n = len(data)
    weights = {}
    for symbol, df in data.items():
        close = df["close"].to_numpy()
        if window < 3 or len(close) < window + 1 or not exit_z < entry_z < stop_z:
            weights[symbol] = 0.0
            continue
        weights[symbol] = _state(_zscores(close, window), entry_z, exit_z, stop_z) * gross / n
    return weights
