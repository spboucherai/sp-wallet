# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/strategies/ma_trend_perp/1/strategy.py
# Description      : Long/short moving-average trend with volatility targeting:
#                    side from two means, size from realised volatility.
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

"""Long/short moving-average trend with volatility targeting: side from two means, size from realised volatility."""

import numpy as np

META = {
    "name": "ma_trend_perp",
    "version": "1",
    "kind": "perp",
    "universe": ["BTC", "ETH", "SOL", "HYPE"],
    "interval": "1h",
    "lookback": 400,
    "max_leverage": 2.0,
    "max_gross_exposure": 4.0,
    "params": {"fast": 24, "slow": 120, "vol_window": 168, "target_vol": 0.6, "max_weight": 0.5},
}

SECONDS_PER_YEAR = 365.0 * 86400.0


def target_weights(data, params):
    fast, slow, vol_window = int(params["fast"]), int(params["slow"]), int(params["vol_window"])
    target_vol, max_weight = float(params["target_vol"]), min(float(params["max_weight"]), 1.0)
    n = len(data)
    weights = {}
    for symbol, df in data.items():
        close = df["close"].to_numpy()
        if len(close) < max(slow, vol_window + 1) or fast >= slow or fast < 1 or vol_window < 2:
            weights[symbol] = 0.0
            continue
        side = float(np.sign(close[-fast:].mean() - close[-slow:].mean()))
        bar_seconds = (df.index[-1] - df.index[-2]).total_seconds()
        log_returns = np.diff(np.log(close[-(vol_window + 1):]))
        realised = log_returns.std(ddof=1) * np.sqrt(SECONDS_PER_YEAR / bar_seconds)
        if not realised > 0:
            weights[symbol] = 0.0
            continue
        weights[symbol] = side * min(max_weight, target_vol / n / realised)
    return weights
