# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/strategies/funding_carry_perp/1/strategy.py
# Description      : Funding carry, perp leg only: short a perpetual whose
#                    funding is persistently positive and large (directional).
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

"""Funding carry, perp leg only: short a perpetual whose funding is persistently positive and large (directional)."""

import numpy as np

META = {
    "name": "funding_carry_perp",
    "version": "1",
    "kind": "perp",
    "universe": ["BTC", "ETH", "SOL", "HYPE"],
    "interval": "1h",
    "lookback": 1100,
    "max_leverage": 2.0,
    "max_gross_exposure": 2.0,
    "params": {"window": 72, "z_window": 504, "min_rate_apr": 0.15, "persistence": 0.75, "z_full": 2.0,
               "gross": 1.0},
}

SECONDS_PER_YEAR = 365.0 * 86400.0


def carry_strength(df, window, z_window, min_rate_apr, persistence, z_full):
    """0..1: how strongly funding says 'longs are paying, persistently, more than usual'. 0 when it does not."""
    if "funding" not in df.columns or window < 2 or z_window < 2 * window or z_full <= 0:
        return 0.0
    rate = df["funding"].to_numpy()
    if len(rate) < z_window or len(df) < 2:
        return 0.0
    rate = rate[-z_window:]
    if np.isnan(rate).mean() > 0.1:                      # too many settlements missing to say anything
        return 0.0
    rate = np.where(np.isnan(rate), 0.0, rate)
    recent = rate[-window:]
    bar_seconds = (df.index[-1] - df.index[-2]).total_seconds()
    apr = recent.mean() * SECONDS_PER_YEAR / bar_seconds
    if apr < min_rate_apr or (recent > 0).mean() < persistence:
        return 0.0
    means = np.lib.stride_tricks.sliding_window_view(rate, window).mean(axis=1)
    spread = means.std(ddof=1)
    if not spread > 0:
        return 0.0
    z = (means[-1] - means.mean()) / spread
    return float(min(max(z / z_full, 0.0), 1.0))


def target_weights(data, params):
    window, z_window = int(params["window"]), int(params["z_window"])
    gross = float(params["gross"])
    n = len(data)
    weights = {}
    for symbol, df in data.items():
        strength = carry_strength(df, window, z_window, float(params["min_rate_apr"]), float(params["persistence"]),
                                  float(params["z_full"]))
        weights[symbol] = -strength * gross / n
    return weights
