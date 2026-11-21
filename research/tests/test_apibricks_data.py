# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/tests/test_apibricks_data.py
# Description      : API Bricks research loader (spq.data.apibricks) on a
#                    RECORDED answer of the provider
#                    (tests/fixtures/apibricks/, recorded 2026-11-17 — market
#                    data only, no header, no key).
# Module           : research
# Repository       : https://git.spboucher.ai/sp-wallet
# Project Website  : https://wallet.spboucher.ai
# Created          : 2026-11-17
# Last Modified    : 2026-11-17
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

"""API Bricks research loader (spq.data.apibricks) on a RECORDED answer of the provider (tests/fixtures/apibricks/,
recorded 2026-11-17 — market data only, no header, no key). No network: a scripted `get`."""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pytest

from spq.data import apibricks as ab
from spq.data.core import DataError

FIX = json.loads((Path(__file__).parent / "fixtures" / "apibricks" / "ohlcv-gemini-btc-1h.json").read_text())
START, END, AS_OF = "2026-11-16T00:00:00Z", "2026-11-17T00:00:00Z", "2026-11-17T08:00:00Z"
FAKE_KEY = "ab" + "k_" + "0123456789abcdef" * 2 + "cafef00d"   # the published shape, assembled: not a key


def scripted(pages):
    calls = []

    def get(url, params=None):
        calls.append((url, dict(params or {})))
        return pages[min(len(calls) - 1, len(pages) - 1)]

    get.calls = calls
    return get


def test_recorded_page_becomes_closed_bars_on_the_grid_and_costs_one_credit():
    get = scripted([FIX["body"]])
    df, spent = ab.fetch_apibricks_candles("GEMINI_SPOT_BTC_USD", "1h", START, END, get=get, as_of=AS_OF)
    assert len(df) == 24 and spent == 1 and len(get.calls) == 1
    url, params = get.calls[0]
    assert url == "https://rest.coinapi.io/v1/ohlcv/GEMINI_SPOT_BTC_USD/history"
    assert params == {"period_id": "1HRS", "time_start": "2026-11-16T00:00:00", "time_end": "2026-11-17T00:00:00", "limit": 1000}
    assert df["ts"].iloc[0] == int(pd.Timestamp(START).timestamp() * 1000) and df["ts"].diff().dropna().eq(3_600_000).all()
    first = FIX["body"][0]
    assert df.iloc[0][["open", "high", "low", "close", "volume"]].tolist() == [
        first["price_open"], first["price_high"], first["price_low"], first["price_close"], first["volume_traded"]]
    # the bar in progress is not a bar: with a clock inside the last hour, that hour is dropped
    df2, _ = ab.fetch_apibricks_candles("GEMINI_SPOT_BTC_USD", "1h", START, END, get=scripted([FIX["body"]]), as_of="2026-11-16T23:30:00Z")
    assert len(df2) == 23


def test_ceiling_is_checked_before_any_call():
    get = scripted([FIX["body"]])
    assert ab.estimate_credits("1h", "2024-11-01", "2026-11-01") == 176 + 18          # two years of 1h bars of ONE series
    with pytest.raises(DataError, match="can cost 194 credits, above the ceiling of 50: nothing was called"):
        ab.fetch_apibricks_candles("HYPERLIQUID_PERP_BTC_USDC", "1h", "2024-11-01", "2026-11-01", get=get)
    assert get.calls == []
    with pytest.raises(DataError, match="not an exchange-specific"):
        ab.fetch_apibricks_candles("BTC", "1h", START, END, get=get)
    with pytest.raises(DataError, match="not served"):
        ab.fetch_apibricks_candles("GEMINI_SPOT_BTC_USD", "2h", START, END, get=get)
    with pytest.raises(DataError, match="unexpected answer"):
        ab.fetch_apibricks_candles("GEMINI_SPOT_BTC_USD", "1h", START, END, get=scripted([{"error": "x"}]))
    with pytest.raises(DataError, match="malformed bar"):
        ab.fetch_apibricks_candles("GEMINI_SPOT_BTC_USD", "1h", START, END, get=scripted([[{"time_period_start": START}]]))


def test_pull_writes_the_file_and_a_capture_without_any_credential(tmp_path, monkeypatch):
    monkeypatch.setenv(ab.KEY_ENV, FAKE_KEY)
    rec = ab.pull_apibricks("GEMINI_SPOT_BTC_USD", "1h", START, END, out=tmp_path, get=scripted([FIX["body"]]), now=AS_OF)
    assert rec["rows"] == 24 and rec["credits"] == 1 and rec["first"].startswith("2026-11-16T00:00:00")
    book = json.loads((tmp_path / "apibricks" / "captures.json").read_text())
    assert list(book) == ["apibricks/GEMINI_SPOT_BTC_USD_1h.parquet"]
    everything = json.dumps(book) + json.dumps(rec)
    assert FAKE_KEY not in everything and FAKE_KEY[4:] not in everything and "key in a header, not recorded" in everything
    df = ab.load_apibricks("GEMINI_SPOT_BTC_USD", "1h", root=tmp_path, as_of=AS_OF)
    assert len(df) == 24 and str(df.index.tz) == "UTC"
    # same bars again: merged, not duplicated
    assert ab.pull_apibricks("GEMINI_SPOT_BTC_USD", "1h", START, END, out=tmp_path, get=scripted([FIX["body"]]), now=AS_OF)["rows"] == 24
    same = ab.overlap_check(df, df)
    assert same == {"bars": 24, "median_bps": 0.0, "p99_bps": 0.0, "max_bps": 0.0}
    assert ab.overlap_check(df, df.assign(close=df["close"] * 1.001))["max_bps"] == pytest.approx(9.995, abs=0.01)
    assert ab.overlap_check(df, df.iloc[:0])["bars"] == 0


def test_without_the_key_nothing_is_called_and_an_error_never_carries_it(monkeypatch):
    monkeypatch.delenv(ab.KEY_ENV, raising=False)
    with pytest.raises(DataError, match="APIBRICKS_API_KEY is not set"):
        ab.apibricks_get("https://rest.coinapi.io/v1/exchanges")
    with pytest.raises(DataError, match="refused URL"):
        ab.apibricks_get("https://example.org/v1/exchanges", key=FAKE_KEY)
    assert ab.scrub(f"GET /v1/x?apikey={FAKE_KEY}&a=1 failed for {FAKE_KEY}", FAKE_KEY) == "GET /v1/x?apikey=[redacted]&a=1 failed for [redacted]"
    assert FAKE_KEY[4:] not in ab.scrub(f"seen {FAKE_KEY.upper()}")
    assert ab.main(["--symbol-id", "HYPERLIQUID_PERP_BTC_USDC", "--start", "2024-11-01", "--end", "2026-11-01", "--dry-run"]) == 0
