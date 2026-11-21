# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/strategies/mean_reversion/3/strategy.py
# Description      : Mean reversion: buy an asset in proportion to how far it
#                    trades below its recent average (z-score).
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

"""Mean reversion: buy an asset in proportion to how far it trades below its recent average (z-score).

Universe-generic (version 3): the symbols are whatever the agent trades; same rule and parameters as version 1.
"""

import numpy as np

META = {
    "name": "mean_reversion",
    "version": "3",
    "universe": ["*"],
    "interval": "1h",
    "lookback": 200,
    "params": {"window": 48, "z_full": 2.0},
}


def target_weights(data, params):
    window, z_full = int(params["window"]), float(params["z_full"])
    n = len(data)
    weights = {}
    for symbol, df in data.items():
        close = df["close"].to_numpy()
        if len(close) < window or window < 2 or z_full <= 0:
            weights[symbol] = 0.0
            continue
        recent = close[-window:]
        std = recent.std(ddof=1)
        if not std > 0:
            weights[symbol] = 0.0
            continue
        z = (close[-1] - recent.mean()) / std
        weights[symbol] = float(np.clip(-z / z_full, 0.0, 1.0)) / n
    return weights
