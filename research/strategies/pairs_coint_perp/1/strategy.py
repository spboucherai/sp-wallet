# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/strategies/pairs_coint_perp/1/strategy.py
# Description      : BTC-ETH cointegration spread, market-neutral: long one leg
#                    and short the other when the spread is stretched.
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

"""BTC-ETH cointegration spread, market-neutral: long one leg and short the other when the spread is stretched."""

import numpy as np

META = {
    "name": "pairs_coint_perp",
    "version": "1",
    "kind": "perp",
    "universe": ["BTC", "ETH"],
    "interval": "1h",
    "lookback": 800,
    "max_leverage": 2.0,
    "max_gross_exposure": 2.0,
    "params": {"window": 336, "state_bars": 96, "entry_z": 2.0, "exit_z": 0.5, "stop_z": 4.0, "df_t_max": -3.04,
               "gross": 1.0},
}


def _spread(log_y, log_x):
    """OLS of log Y on log X over the window: (hedge ratio, z-score of the last residual, Dickey-Fuller t)."""
    x = log_x - log_x.mean()
    y = log_y - log_y.mean()
    sxx = float(x @ x)
    if not sxx > 0:
        return 0.0, 0.0, 0.0
    beta = float(x @ y) / sxx
    resid = y - beta * x
    sd = resid.std(ddof=2)
    if not sd > 0:
        return beta, 0.0, 0.0
    lag, diff = resid[:-1], np.diff(resid)
    denom = float(lag @ lag)
    rho = float(lag @ diff) / denom
    err = diff - rho * lag
    se = np.sqrt(float(err @ err) / (len(diff) - 1) / denom)
    return beta, resid[-1] / sd, (rho / se if se > 0 else 0.0)


def target_weights(data, params):
    window, state_bars = int(params["window"]), int(params["state_bars"])
    entry_z, exit_z, stop_z = float(params["entry_z"]), float(params["exit_z"]), float(params["stop_z"])
    df_t_max, gross = float(params["df_t_max"]), float(params["gross"])
    weights = {symbol: 0.0 for symbol in data}
    if "BTC" not in data or "ETH" not in data or window < 30 or state_bars < 1 or not exit_z < entry_z < stop_z:
        return weights
    log_x = np.log(data["BTC"]["close"].to_numpy())
    log_y = np.log(data["ETH"]["close"].to_numpy())
    n = len(log_x)
    if n < window + 1:
        return weights
    # Replay the rule over the last `state_bars` bars. At each bar the hedge ratio is re-estimated on the window
    # ENDING at that bar, so no estimate ever uses a later price.
    state, blocked, beta = 0, False, 0.0
    for end in range(max(window, n - state_bars + 1), n + 1):
        beta, z, df_t = _spread(log_y[end - window:end], log_x[end - window:end])
        if blocked and abs(z) < exit_z:
            blocked = False
        if state == 0:
            if not blocked and df_t < df_t_max and beta > 0 and entry_z < abs(z) < stop_z:
                state = -1 if z > 0 else 1              # spread rich: short it; spread cheap: long it
        elif abs(z) > stop_z or beta <= 0:
            state, blocked = 0, True
        elif (state == 1 and z > -exit_z) or (state == -1 and z < exit_z):
            state = 0
    if state == 0 or not beta > 0:
        return weights
    # long the spread = long ETH, short beta units of BTC per unit of ETH (in notional, as the fit is log-log)
    weights["ETH"] = state * gross / (1.0 + beta)
    weights["BTC"] = -state * gross * beta / (1.0 + beta)
    return weights
