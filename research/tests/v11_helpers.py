# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/tests/v11_helpers.py
# Description      : Helpers of the V11 tests: recorded API responses
#                    (tests/fixtures/v11) and a synthetic multi-venue store.
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

"""Helpers of the V11 tests: recorded API responses (tests/fixtures/v11) and a synthetic multi-venue store."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from conftest import make_series

FIX = Path(__file__).resolve().parent / "fixtures" / "v11"
#: the window of the recorded fixtures: 48 hourly bars
FIX_START, FIX_END = "2026-11-10T00:00:00Z", "2026-11-12T00:00:00Z"
AS_OF = "2026-11-16T00:00:00+00:00"


def fixture(name: str):
    return json.loads((FIX / f"{name}.json").read_text())


def replay(routes: dict):
    """A fake `get(url, params)` that answers from recorded responses. `routes`: substring of the URL -> a response,
    or a function(params) -> response. Every call is logged in `.calls`."""
    calls = []

    def get(url, params=None):
        calls.append((url, dict(params or {})))
        for key, val in routes.items():
            if key in url:
                return val(params or {}) if callable(val) else val
        raise AssertionError(f"unexpected request {url}")

    get.calls = calls
    return get


def edgex_get():
    def kline(params):
        return fixture("edgex_kline_page2" if params.get("offsetData") else "edgex_kline_page1")

    return replay({"getKline": kline, "getFundingRatePage": fixture("edgex_funding")})


def synthetic_store(root, n: int = 1500, symbols=("BTC", "ETH", "SOL"), venues=("hyperliquid", "edgex", "coinbase"),
                    start: str = "2026-01-01", seed: int = 3, premium_bps: float = 6.0) -> dict:
    """Write a deterministic store in the lab's layout: the same underlying path on every venue (a venue's price is
    the underlying times a small stationary premium), hourly funding on hyperliquid / dydx, 4-hourly on edgex, none
    on coinbase. Returns the manifest (hashes, range, capture time)."""
    from spq.data.multivenue import _capture, build_manifest

    root = Path(root)
    rng = np.random.default_rng(seed)
    for i, sym in enumerate(symbols):
        base = make_series(n, seed + 11 * i, start=start, sigma=0.008, drift=[0.0003, -0.0002, 0.0001][i % 3],
                           p0=[60000.0, 3000.0, 150.0][i % 3])
        for j, v in enumerate(venues):
            noise = np.zeros(n)
            shocks = rng.normal(0, 1.5e-4, n)
            for t in range(1, n):
                noise[t] = 0.8 * noise[t - 1] + shocks[t]
            f = 1.0 + (j * premium_bps / 1e4) + noise
            df = base[["open", "high", "low", "close"]].mul(f, axis=0).assign(volume=base["volume"] * 1000.0)
            df["high"] = df[["open", "high", "close"]].max(axis=1)
            df["low"] = df[["open", "low", "close"]].min(axis=1)
            path = root / v / f"{sym}_1h.parquet"
            path.parent.mkdir(parents=True, exist_ok=True)
            out = df.reset_index()
            out.to_parquet(path, index=False)
            _capture(root, v, path, out, "ts", "synthetic", AS_OF)
            if v == "coinbase":
                continue
            step = 4 if v == "edgex" else 1
            ts = df.index[::step]
            rate = (1.0e-5 + 2.0e-5 * np.sin(np.arange(len(ts)) / (40.0 / step) + i + 2 * j)) * step
            for a in range(300, len(ts), 700 // step):            # episodes of persistently high funding
                rate[a:a + 260 // step] += 6e-5 * step * (1 if v == "hyperliquid" else -0.3)
            fund = pd.DataFrame({"time_ms": ts.as_unit("ms").asi8 + 50, "rate": rate, "premium": rate * 4})
            fpath = root / v / "funding" / f"{sym}.parquet"
            fpath.parent.mkdir(parents=True, exist_ok=True)
            fund.to_parquet(fpath, index=False)
            _capture(root, v, fpath, fund, "time_ms", "synthetic", AS_OF)
    (root / "hyperliquid" / "meta.json").write_text(json.dumps({"universe": {
        s: {"max_leverage": 20.0, "size_decimals": 4, "delisted": False} for s in symbols}}))
    m = build_manifest(root)
    idx = pd.date_range(start, periods=n, freq="1h", tz="UTC")
    m["range"] = [idx[0].isoformat(), (idx[-1] + pd.Timedelta(hours=1)).isoformat()]
    m["captured_at"] = AS_OF
    return m


def flat_bars(n: int, price: float = 100.0, start: str = "2024-01-01", volume: float = 1e6, **cols) -> pd.DataFrame:
    idx = pd.date_range(start, periods=n, freq="1h", tz="UTC", name="ts")
    df = pd.DataFrame({"open": price, "high": price, "low": price, "close": price, "volume": volume}, index=idx)
    for k, v in cols.items():
        df[k] = np.asarray(v, float)
    return df
