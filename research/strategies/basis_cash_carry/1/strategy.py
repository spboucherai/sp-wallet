# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/strategies/basis_cash_carry/1/strategy.py
# Description      : Cash-and-carry: spot long + perpetual short of the same
#                    asset while funding pays more than the round trip costs.
# Module           : research
# Repository       : https://git.spboucher.ai/sp-wallet
# Project Website  : https://wallet.spboucher.ai
# Created          : 2026-11-15
# Last Modified    : 2026-11-15
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

"""Cash-and-carry: spot long + perpetual short of the same asset while funding pays more than the round trip costs."""

import numpy as np

META = {
    "name": "basis_cash_carry",
    "version": "1",
    "kind": "perp",
    "universe": ["BTC", "ETH", "SOL", "BTC.SPOT", "ETH.SPOT", "SOL.SPOT"],
    "interval": "1h",
    "lookback": 720,
    "max_leverage": 1.0,
    "max_gross_exposure": 1.0,
    "params": {"window": 168, "enter_net_apr": 0.05, "exit_apr": 0.02, "round_trip_cost_bps": 60.0,
               "holding_days": 30.0, "max_adverse_basis_bps": 15.0, "state_bars": 336, "gross": 0.9},
}

SECONDS_PER_YEAR = 365.0 * 86400.0
SPOT = ".SPOT"


def _rolling_mean(values, window):
    total = np.cumsum(np.concatenate([[0.0], values]))
    return (total[window:] - total[:-window]) / window


def _carry_state(perp, spot, window, enter_net_apr, exit_apr, cost_apr, max_adverse_basis_bps, state_bars):
    """1 while the carry is on, 0 otherwise, replayed over the last `state_bars` bars of the window.

    Enter: mean funding of the last `window` bars, annualised, minus the round trip amortised over the planned
    holding time, is at least `enter_net_apr`, AND the perpetual is not unusually cheap against spot (a cheap
    perpetual sold now is bought back dearer when the basis closes). Exit: the annualised funding falls under
    `exit_apr` (the costs are sunk by then: only the remaining carry matters)."""
    if "funding" not in perp.columns or len(perp) < window + state_bars or len(perp) < 2:
        return 0
    rate = perp["funding"].to_numpy()
    if np.isnan(rate[-window - state_bars:]).mean() > 0.05:
        return 0
    rate = np.where(np.isnan(rate), 0.0, rate)
    bar_seconds = (perp.index[-1] - perp.index[-2]).total_seconds()
    if not bar_seconds > 0:
        return 0
    apr = _rolling_mean(rate, window)[-state_bars:] * SECONDS_PER_YEAR / bar_seconds
    basis = (perp["close"].to_numpy() / spot["close"].to_numpy() - 1.0) * 1e4
    usual = _rolling_mean(basis, window)[-state_bars:]
    now = basis[-state_bars:]
    state = 0
    for carry, gap in zip(apr, now - usual):
        if state == 0:
            if carry - cost_apr >= enter_net_apr and gap >= -max_adverse_basis_bps:
                state = 1
        elif carry < exit_apr:
            state = 0
    return state


def target_weights(data, params):
    window, state_bars = int(params["window"]), int(params["state_bars"])
    holding_days = float(params["holding_days"])
    gross = min(float(params["gross"]), 1.0)             # half in spot, half short: never more than the equity
    weights = {symbol: 0.0 for symbol in data}
    pairs = [s for s in data if not s.endswith(SPOT) and s + SPOT in data]
    if not pairs or window < 2 or state_bars < 1 or holding_days <= 0 or gross <= 0:
        return weights
    cost_apr = float(params["round_trip_cost_bps"]) / 1e4 * 365.0 / holding_days
    leg = gross / (2.0 * len(pairs))
    for symbol in pairs:
        on = _carry_state(data[symbol], data[symbol + SPOT], window, float(params["enter_net_apr"]),
                          float(params["exit_apr"]), cost_apr, float(params["max_adverse_basis_bps"]), state_bars)
        weights[symbol] = -on * leg                      # short the perpetual
        weights[symbol + SPOT] = on * leg                # hold the same notional of the asset
    return weights
