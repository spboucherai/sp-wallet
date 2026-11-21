# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/tests/conftest.py
# Module           : research
# Repository       : https://git.spboucher.ai/sp-wallet
# Project Website  : https://wallet.spboucher.ai
# Created          : 2026-11-10
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

from __future__ import annotations

import textwrap
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
# v7: directories named rj_<job> are strategies installed by research jobs on a deployed node: not the library
_ALL = sorted(p.parent for p in (ROOT / "strategies").glob("*/*/strategy.py") if not p.parent.parent.name.startswith("rj_"))
# Perpetual-futures strategies (contract v2, directories named <name>_perp) have their own tests
# (test_perp_library.py); LIBRARY stays the spot library that the version-1 tests were written for.
# V11 strategies (generic perp universes, spot legs with venue accounts, cross-venue legs) have their own tests
# (test_v11_strategies.py); the V4 perp library and the spot library keep the tests they were written for.
V11_NAMES = {"momentum_xs_perp", "mean_reversion_bands_perp", "statarb_basket_perp", "basis_cash_carry"}
V11_LIBRARY = [d for d in _ALL if d.parent.name in V11_NAMES] + sorted(
    p.parent for p in (ROOT / "strategies_xvenue").glob("*/*/strategy.py"))
PERP_LIBRARY = [d for d in _ALL if d.parent.name.endswith("_perp") and d.parent.name not in V11_NAMES]
LIBRARY = [d for d in _ALL if d not in PERP_LIBRARY and d.parent.name not in V11_NAMES]


def pytest_collection_modifyitems(config, items):
    import os

    if os.environ.get("SPQ_NETWORK_TESTS") == "1":
        return
    skip = pytest.mark.skip(reason="live network test: set SPQ_NETWORK_TESTS=1")
    for item in items:
        if "network" in item.keywords:
            item.add_marker(skip)


def make_series(n: int, seed: int = 0, start: str = "2024-01-01", freq: str = "1h", sigma: float = 0.01,
                drift: float = 0.0, p0: float = 100.0) -> pd.DataFrame:
    """Geometric random walk OHLCV with i.i.d. returns; open[t] == close[t-1]."""
    rng = np.random.default_rng(seed)
    r = rng.normal(drift, sigma, n)
    close = p0 * np.exp(np.cumsum(r))
    open_ = np.concatenate([[p0], close[:-1]])
    wick = np.abs(rng.normal(0, sigma / 2, (2, n)))
    high = np.maximum(open_, close) * (1 + wick[0])
    low = np.minimum(open_, close) * (1 - wick[1])
    idx = pd.date_range(start, periods=n, freq=freq, tz="UTC", name="ts")
    return pd.DataFrame({"open": open_, "high": high, "low": low, "close": close,
                         "volume": rng.uniform(1, 10, n)}, index=idx)


def make_data(n: int, symbols=("AAA", "BBB"), seed: int = 0, **kw) -> dict[str, pd.DataFrame]:
    return {s: make_series(n, seed + 17 * i, **kw) for i, s in enumerate(symbols)}


def frame(opens, closes, start="2024-01-01", freq="1h") -> pd.DataFrame:
    """Hand-written bars (high/low derived)."""
    o, c = np.asarray(opens, float), np.asarray(closes, float)
    idx = pd.date_range(start, periods=len(o), freq=freq, tz="UTC", name="ts")
    return pd.DataFrame({"open": o, "high": np.maximum(o, c), "low": np.minimum(o, c), "close": c,
                         "volume": np.ones(len(o))}, index=idx)


def write_strategy(directory: Path, body: str, meta: dict | None = None, raw: str | None = None) -> Path:
    """Create <directory>/strategy.py. `body` is the body of target_weights(data, params)."""
    directory.mkdir(parents=True, exist_ok=True)
    if raw is None:
        meta = meta or {"name": "t", "version": "1", "universe": ["AAA", "BBB"], "interval": "1h", "lookback": 10,
                        "params": {}}
        raw = f"META = {meta!r}\n\n\ndef target_weights(data, params):\n" + textwrap.indent(textwrap.dedent(body), "    ")
    (directory / "strategy.py").write_text(raw)
    return directory


@pytest.fixture
def strategy_dir(tmp_path):
    def make(body: str = "return {s: 0.5 for s in data}\n", **kw) -> Path:
        return write_strategy(tmp_path / f"s{len(list(tmp_path.iterdir()))}", body, **kw)
    return make
