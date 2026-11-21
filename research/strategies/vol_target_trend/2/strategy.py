# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/strategies/vol_target_trend/2/strategy.py
# Description      : Volatility-targeted trend: trend-following position,
#                    scaled down when realised volatility is high.
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

"""Volatility-targeted trend: trend-following position, scaled down when realised volatility is high."""

import numpy as np

META = {
    "name": "vol_target_trend",
    "version": "2",
    "universe": ["ETH", "LINK", "AAVE"],
    "interval": "1h",
    "lookback": 1000,
    "params": {"fast": 72, "slow": 480, "vol_window": 168, "target_vol": 0.4},
}

SECONDS_PER_YEAR = 365.0 * 86400.0


def target_weights(data, params):
    fast, slow = int(params["fast"]), int(params["slow"])
    vol_window, target_vol = int(params["vol_window"]), float(params["target_vol"])
    n = len(data)
    weights = {}
    for symbol, df in data.items():
        close = df["close"].to_numpy()
        if len(close) < max(fast, slow, vol_window + 1) or fast >= slow or vol_window < 2:
            weights[symbol] = 0.0
            continue
        if not close[-fast:].mean() > close[-slow:].mean():
            weights[symbol] = 0.0
            continue
        bar_seconds = (df.index[-1] - df.index[-2]).total_seconds()
        log_returns = np.diff(np.log(close[-(vol_window + 1):]))
        realised = log_returns.std(ddof=1) * np.sqrt(SECONDS_PER_YEAR / bar_seconds)
        scale = min(1.0, target_vol / realised) if realised > 0 else 0.0
        weights[symbol] = scale / n
    return weights
