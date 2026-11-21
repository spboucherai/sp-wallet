# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/strategies/xs_momentum/3/strategy.py
# Description      : Cross-sectional momentum: hold the assets of the universe
#                    with the highest past return.
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

"""Cross-sectional momentum: hold the assets of the universe with the highest past return.

Universe-generic (version 3): the symbols are whatever the agent trades; same rule and parameters as version 1.
"""

META = {
    "name": "xs_momentum",
    "version": "3",
    "universe": ["*"],
    "min_symbols": 3,
    "interval": "1h",
    "lookback": 1500,
    "params": {"window": 720, "top_k": 2},
}


def target_weights(data, params):
    window, top_k = int(params["window"]), int(params["top_k"])
    past = []
    for symbol, df in data.items():
        close = df["close"].to_numpy()
        if len(close) > window:
            past.append((-(close[-1] / close[-1 - window] - 1.0), symbol))
    weights = {symbol: 0.0 for symbol in data}
    if top_k < 1 or len(data) < 3 or len(past) < 2:   # a ranking needs at least 3 symbols: cash otherwise
        return weights
    winners = sorted(past)[:min(top_k, len(past))]   # best return first, ties broken by symbol
    for _, symbol in winners:
        weights[symbol] = 1.0 / len(winners)
    return weights
