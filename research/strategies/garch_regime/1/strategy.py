# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/strategies/garch_regime/1/strategy.py
# Description      : Volatility-regime filter: daily trend position, switched
#                    off when a GARCH(1,1) forecast announces high volatility.
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

"""Volatility-regime filter: daily trend position, switched off when a GARCH(1,1) forecast announces high volatility."""

import numpy as np
from arch import arch_model

META = {
    "name": "garch_regime",
    "version": "1",
    "universe": ["ETH", "BTC", "LINK", "SOL"],
    "interval": "1h",
    "lookback": 4320,
    "params": {"trend_days": 30, "vol_ratio_max": 1.25, "min_days": 120},
}


def _daily_closes(df):
    """Last close of each COMPLETE UTC day (the current, unfinished day is dropped)."""
    index = df.index
    daily = df["close"].groupby(index.floor("D")).last()
    next_bar = index[-1] + (index[-1] - index[-2])
    if next_bar != next_bar.floor("D"):
        daily = daily.iloc[:-1]
    return daily.to_numpy()


def _calm_regime(returns_pct, vol_ratio_max):
    """True if the one-day-ahead GARCH(1,1) volatility is not above vol_ratio_max x the median fitted volatility."""
    model = arch_model(returns_pct, mean="Zero", vol="GARCH", p=1, q=1, rescale=False)
    fit = model.fit(disp="off", show_warning=False)
    if fit.convergence_flag != 0:
        return False
    forecast = float(np.sqrt(fit.forecast(horizon=1, reindex=False).variance.to_numpy()[-1, 0]))
    typical = float(np.median(np.asarray(fit.conditional_volatility)))
    if not (np.isfinite(forecast) and typical > 0):
        return False
    return forecast <= vol_ratio_max * typical


def target_weights(data, params):
    trend_days, min_days = int(params["trend_days"]), int(params["min_days"])
    vol_ratio_max = float(params["vol_ratio_max"])
    n = len(data)
    weights = {}
    for symbol, df in data.items():
        weights[symbol] = 0.0
        if len(df) < 3:
            continue
        daily = _daily_closes(df)
        if len(daily) < max(min_days, trend_days) + 1:
            continue
        if not daily[-1] > daily[-trend_days:].mean():
            continue
        returns_pct = 100.0 * np.diff(np.log(daily))
        if _calm_regime(returns_pct, vol_ratio_max):
            weights[symbol] = 1.0 / n
    return weights
