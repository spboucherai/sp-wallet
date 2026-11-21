# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/strategies/statarb_basket_perp/1/strategy.py
# Description      : PCA residual mean reversion over a basket of liquid
#                    perpetuals (Avellaneda & Lee 2010), factor-neutral.
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

"""PCA residual mean reversion over a basket of liquid perpetuals (Avellaneda & Lee 2010), factor-neutral."""

import numpy as np

META = {
    "name": "statarb_basket_perp",
    "version": "1",
    "kind": "perp",
    "universe": ["BTC", "ETH", "SOL", "LINK", "AAVE", "HYPE"],
    "interval": "1h",
    "lookback": 800,
    "max_leverage": 1.0,
    "max_gross_exposure": 1.0,
    "params": {"window": 336, "n_factors": 2, "entry_s": 1.5, "exit_s": 0.5, "stop_s": 4.0, "max_half_life": 72,
               "state_bars": 96, "gross": 1.0},
}


def _residual_paths(returns, n_factors):
    """Fit on ONE window of bar returns (rows = bars, columns = assets), all of it at or before the decision bar.

    Returns (betas, paths): the loading of each asset on the first `n_factors` principal components of the
    correlation matrix, and the cumulative residual of each asset inside the window (what is left of its return
    once the factors are removed), or (None, None) when the window is degenerate."""
    sigma = returns.std(axis=0, ddof=1)
    if not (sigma > 0).all():
        return None, None
    standard = (returns - returns.mean(axis=0)) / sigma
    corr = (standard.T @ standard) / (len(standard) - 1)
    values, vectors = np.linalg.eigh(corr)
    order = np.argsort(values)[::-1][:n_factors]
    portfolios = vectors[:, order] / sigma[:, None]              # eigenportfolios: loading / volatility
    factors = returns @ portfolios                               # factor returns, bars x factors
    design = np.column_stack([np.ones(len(factors)), factors])
    coef = np.linalg.lstsq(design, returns, rcond=None)[0]       # rows: intercept, then one beta per factor
    residual = returns - design @ coef
    return coef[1:].T, np.cumsum(residual, axis=0)


def _s_scores(path, max_half_life):
    """Ornstein-Uhlenbeck reading of one cumulative residual: X[t+1] = a + b X[t] + noise. Returns the s-score
    (X - equilibrium) / equilibrium standard deviation along the path, or None when the residual does not revert
    fast enough (b outside (0, 1), or a half-life above `max_half_life` bars)."""
    x, y = path[:-1], path[1:]
    xc = x - x.mean()
    sxx = float(xc @ xc)
    if not sxx > 0:
        return None
    b = float(xc @ (y - y.mean())) / sxx
    if not 0.0 < b < 1.0:
        return None
    if -np.log(2.0) / np.log(b) > max_half_life:
        return None
    a = y.mean() - b * x.mean()
    noise = y - a - b * x
    var_eq = noise.var(ddof=2) / (1.0 - b * b)
    if not var_eq > 0:
        return None
    return (path - a / (1.0 - b)) / np.sqrt(var_eq)


def _state(scores, entry_s, exit_s, stop_s):
    """Replay the band rule along the s-score path of the current fit: -1 short the residual, +1 long, 0 flat."""
    state, blocked = 0, False
    for value in scores:
        if blocked and abs(value) < exit_s:
            blocked = False
        if state == 0:
            if not blocked and entry_s < abs(value) < stop_s:
                state = -1 if value > 0 else 1
        elif abs(value) > stop_s:
            state, blocked = 0, True
        elif (state == 1 and value > -exit_s) or (state == -1 and value < exit_s):
            state = 0
    return state


def target_weights(data, params):
    window, n_factors, state_bars = int(params["window"]), int(params["n_factors"]), int(params["state_bars"])
    entry_s, exit_s, stop_s = float(params["entry_s"]), float(params["exit_s"]), float(params["stop_s"])
    max_half_life, gross = float(params["max_half_life"]), min(float(params["gross"]), 1.0)
    symbols = list(data)
    n = len(symbols)
    weights = {symbol: 0.0 for symbol in symbols}
    if (n < 3 or n_factors < 1 or n_factors >= n or window < 10 * n or state_bars < 1 or state_bars >= window
            or not exit_s < entry_s < stop_s or gross <= 0):
        return weights
    closes = []
    for symbol in symbols:
        close = data[symbol]["close"].to_numpy()
        if len(close) < window + 1 or not (close > 0).all():
            return weights
        closes.append(np.log(close[-window - 1:]))
    returns = np.diff(np.column_stack(closes), axis=0)           # the window ENDS at the decision bar
    betas, paths = _residual_paths(returns, n_factors)
    if betas is None:
        return weights
    raw = np.zeros(n)
    for j in range(n):
        scores = _s_scores(paths[:, j], max_half_life)
        if scores is not None:
            raw[j] = _state(scores[-state_bars:], entry_s, exit_s, stop_s)
    active = int((raw != 0).sum())
    if active == 0:
        return weights
    # hedge: remove the exposure to the factors, so that what is traded is the residual and not the market
    hedge = np.linalg.lstsq(betas.T @ betas, betas.T @ raw, rcond=None)[0]
    neutral = raw - betas @ hedge
    total = np.abs(neutral).sum()
    if not total > 0:
        return weights
    scale = gross * min(1.0, 2.0 * active / n) / total
    for symbol, value in zip(symbols, neutral):
        weights[symbol] = float(value * scale)
    return weights
