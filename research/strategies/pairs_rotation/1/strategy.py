# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/strategies/pairs_rotation/1/strategy.py
# Description      : Pairs / cointegration spread, long-only: inside each pair,
#                    rotate into the leg that is cheap relative to the other.
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

"""Pairs / cointegration spread, long-only: inside each pair, rotate into the leg that is cheap relative to the other."""

import numpy as np

META = {
    "name": "pairs_rotation",
    "version": "1",
    "universe": ["ETH", "BTC", "LINK", "SOL"],
    "interval": "1h",
    "lookback": 1500,
    "params": {"pairs": [["ETH", "BTC"], ["SOL", "LINK"]], "window": 720, "entry_z": 1.0, "df_t_max": -3.34},
}


def _spread_state(log_a, log_b):
    """OLS of log A on log B over the window; z-score of the last residual and Dickey-Fuller t of the residuals."""
    x = log_b - log_b.mean()
    y = log_a - log_a.mean()
    sxx = float(x @ x)
    if not sxx > 0:
        return 0.0, 0.0
    resid = y - (float(x @ y) / sxx) * x
    sd = resid.std(ddof=2)
    if not sd > 0:
        return 0.0, 0.0
    lag, diff = resid[:-1], np.diff(resid)
    denom = float(lag @ lag)
    rho = float(lag @ diff) / denom
    err = diff - rho * lag
    se = np.sqrt(float(err @ err) / (len(diff) - 1) / denom)
    return resid[-1] / sd, (rho / se if se > 0 else 0.0)


def target_weights(data, params):
    window, entry_z, df_t_max = int(params["window"]), float(params["entry_z"]), float(params["df_t_max"])
    pairs = [(a, b) for a, b in params["pairs"] if a in data and b in data]
    weights = {symbol: 0.0 for symbol in data}
    if not pairs or window < 30:
        return weights
    budget = 1.0 / len(pairs)
    for a, b in pairs:
        ca, cb = data[a]["close"].to_numpy(), data[b]["close"].to_numpy()
        if len(ca) < window or len(cb) < window:
            continue
        z, df_t = _spread_state(np.log(ca[-window:]), np.log(cb[-window:]))
        if df_t < df_t_max and z < -entry_z:      # A cheap relative to B, and the spread looks stationary
            weights[a] += budget
        elif df_t < df_t_max and z > entry_z:     # B cheap relative to A
            weights[b] += budget
        else:                                     # no evidence either way: hold both legs
            weights[a] += budget / 2.0
            weights[b] += budget / 2.0
    return weights
