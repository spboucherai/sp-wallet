# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/tests/test_dsr.py
# Description      : Deflated Sharpe Ratio against the worked example of Bailey
#                    & López de Prado (2014).
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

"""Deflated Sharpe Ratio against the worked example of Bailey & López de Prado (2014)."""
from __future__ import annotations

import math

import numpy as np
import pytest
from scipy import stats

from spq.dsr import (EULER_GAMMA, deflated_sharpe, deflated_sharpe_from_returns, expected_max_sharpe,
                     probabilistic_sharpe)


def test_worked_example_of_the_paper():
    """Section 'A numerical example' of the paper: the best of N = 100 independent trials has an annualised
    Sharpe ratio of 2.5 on T = 1250 daily returns (250 per year) with skewness -3 and kurtosis 10; the variance of
    the trials' annualised Sharpe ratios is 1/2. The paper obtains SR0 = 0.1132 (daily) and DSR = 0.9004."""
    sr = 2.5 / math.sqrt(250)
    var_trials = 0.5 / 250
    sr0 = expected_max_sharpe(100, var_trials)
    assert sr0 == pytest.approx(0.1132, abs=5e-5)
    assert sr0 * math.sqrt(250) == pytest.approx(1.7895, abs=1e-3)       # the same threshold, annualised
    dsr = deflated_sharpe(sr, 1250, -3.0, 10.0, 100, var_trials)
    assert dsr == pytest.approx(0.9004, abs=5e-4)
    # the paper's point: the same track record looks certain if the 100 trials are ignored
    assert probabilistic_sharpe(sr, 0.0, 1250, -3.0, 10.0) > 0.9999


def test_expected_maximum_by_hand():
    # N = 10, unit variance: (1 - g) * z(0.9) + g * z(1 - 1/(10 e))
    z1, z2 = stats.norm.ppf(0.9), stats.norm.ppf(1 - 1 / (10 * math.e))
    assert z1 == pytest.approx(1.2815516) and z2 == pytest.approx(1.7884, abs=1e-3)
    assert expected_max_sharpe(10, 1.0) == pytest.approx((1 - EULER_GAMMA) * z1 + EULER_GAMMA * z2)
    assert expected_max_sharpe(10, 1.0) == pytest.approx(1.574, abs=1e-3)
    assert expected_max_sharpe(10, 4.0) == pytest.approx(2 * expected_max_sharpe(10, 1.0))
    assert expected_max_sharpe(1, 1.0) == 0.0 and expected_max_sharpe(50, 0.0) == 0.0
    with pytest.raises(ValueError):
        expected_max_sharpe(0, 1.0)
    # the simulated maximum of N standard normal Sharpe ratios agrees with the approximation
    rng = np.random.default_rng(0)
    simulated = rng.standard_normal((20000, 100)).max(axis=1).mean()
    assert expected_max_sharpe(100, 1.0) == pytest.approx(simulated, abs=0.03)


def test_probabilistic_sharpe_by_hand():
    # normal returns (skew 0, kurtosis 3), SR 0.1 per period, 101 observations:
    # Phi(0.1 * sqrt(100) / sqrt(1 + 0.5 * 0.01)) = Phi(0.997509) = 0.84074
    assert probabilistic_sharpe(0.1, 0.0, 101) == pytest.approx(stats.norm.cdf(1 / math.sqrt(1.005)))
    assert probabilistic_sharpe(0.1, 0.0, 101) == pytest.approx(0.84074, abs=1e-4)
    assert probabilistic_sharpe(0.1, 0.1, 101) == pytest.approx(0.5)
    # negative skew and fat tails lower the confidence in a positive Sharpe ratio
    assert probabilistic_sharpe(0.1, 0.0, 101, skew=-2.0, kurtosis=12.0) < probabilistic_sharpe(0.1, 0.0, 101)
    assert math.isnan(probabilistic_sharpe(0.1, 0.0, 1))
    assert math.isnan(probabilistic_sharpe(2.0, 0.0, 100, skew=3.0, kurtosis=1.0))   # impossible moments


def test_more_trials_deflate_more():
    values = [deflated_sharpe(0.08, 2000, -0.5, 6.0, n, 0.001) for n in (1, 2, 10, 100, 1000)]
    assert values == sorted(values, reverse=True) and values[0] > 0.99 and values[-1] < 0.2
    assert deflated_sharpe(0.08, 2000, -0.5, 6.0, 1, 0.001) == probabilistic_sharpe(0.08, 0.0, 2000, -0.5, 6.0)


def test_from_returns_reports_its_inputs():
    rng = np.random.default_rng(1)
    r = rng.normal(0.001, 0.01, 3000)
    trials = list(rng.normal(0.0, 0.03, 40))
    out = deflated_sharpe_from_returns(r, trials + [None, float("nan")])
    sr = r.mean() / r.std(ddof=1)
    assert out["n_trials"] == 40 and out["n_obs"] == 3000
    assert out["sharpe_per_bar"] == pytest.approx(sr)
    assert out["var_trial_sharpes"] == pytest.approx(np.var(trials, ddof=1))
    assert out["kurtosis"] == pytest.approx(stats.kurtosis(r, fisher=False))
    assert out["expected_max_sharpe_per_bar"] == pytest.approx(expected_max_sharpe(40, np.var(trials, ddof=1)))
    assert out["deflated_sharpe"] == pytest.approx(
        probabilistic_sharpe(sr, out["expected_max_sharpe_per_bar"], 3000, out["skew"], out["kurtosis"]))
    assert out["deflated_sharpe"] < out["probabilistic_sharpe_vs_zero"]
    single = deflated_sharpe_from_returns(r, [0.05])
    assert single["n_trials"] == 1 and single["deflated_sharpe"] == pytest.approx(single["probabilistic_sharpe_vs_zero"])
    flat = deflated_sharpe_from_returns(np.zeros(100), trials)
    assert flat["deflated_sharpe"] is None
