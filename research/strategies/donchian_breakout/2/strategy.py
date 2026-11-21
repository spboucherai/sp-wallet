# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/strategies/donchian_breakout/2/strategy.py
# Description      : Donchian channel breakout: enter on a new N-bar high,
#                    leave on a new M-bar low.
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

"""Donchian channel breakout: enter on a new N-bar high, leave on a new M-bar low."""

import numpy as np

META = {
    "name": "donchian_breakout",
    "version": "2",
    "universe": ["ETH", "LINK", "AAVE"],
    "interval": "1h",
    "lookback": 2200,
    "params": {"entry": 480, "exit": 240},
}


def _is_long(df, entry, exit_):
    """Replay the channel over the window: long if the most recent event is an upside breakout."""
    close = df["close"]
    upper = df["high"].rolling(entry).max().shift(1)   # highest high of the previous `entry` bars
    lower = df["low"].rolling(exit_).min().shift(1)    # lowest low of the previous `exit_` bars
    up = np.nonzero((close > upper).to_numpy())[0]
    down = np.nonzero((close < lower).to_numpy())[0]
    if len(up) == 0:
        return False
    return len(down) == 0 or up[-1] > down[-1]


def target_weights(data, params):
    entry, exit_ = int(params["entry"]), int(params["exit"])
    n = len(data)
    weights = {}
    for symbol, df in data.items():
        if len(df) <= max(entry, exit_) or entry < 1 or exit_ < 1:
            weights[symbol] = 0.0
            continue
        weights[symbol] = 1.0 / n if _is_long(df, entry, exit_) else 0.0
    return weights
