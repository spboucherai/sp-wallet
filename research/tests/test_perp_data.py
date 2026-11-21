# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/tests/test_perp_data.py
# Description      : Hyperliquid data layer: paging, rate-limit budget, closed
#                    bars, funding normalisation, local store.
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

"""Hyperliquid data layer: paging, rate-limit budget, closed bars, funding normalisation, local store.

No network: the venue is replaced by `FakeVenue`, which answers the three request types the module may send with
the limits measured on the real endpoint (most recent 5000 candles only, 500 funding rows per answer)."""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from spq.data import DataError, load_candles
from spq.data import hyperliquid as hl

HOUR = 3_600_000
T0 = 1_700_000_000_000 // HOUR * HOUR


class FakeVenue:
    def __init__(self, n_candles=12_000, n_funding=1_300, now_bar=None, candle_cap=5000, drop=(), drop_funding=()):
        self.n_candles, self.n_funding, self.cap = n_candles, n_funding, candle_cap
        self.now = T0 + (now_bar if now_bar is not None else n_candles) * HOUR - 1     # inside the last bar
        self.drop, self.drop_funding = set(drop), set(drop_funding)
        self.calls: list[dict] = []

    def candle(self, i):
        o = 100.0 + i * 0.01
        return {"t": T0 + i * HOUR, "T": T0 + (i + 1) * HOUR - 1, "s": "BTC", "i": "1h", "o": f"{o:.2f}",
                "h": f"{o + 1:.2f}", "l": f"{o - 1:.2f}", "c": f"{o + 0.5:.2f}", "v": "3.5", "n": 10}

    def __call__(self, body):
        self.calls.append(body)
        if body["type"] == "meta":
            return {"universe": [{"name": "BTC", "szDecimals": 5, "maxLeverage": 40},
                                 {"name": "OLD", "szDecimals": 1, "maxLeverage": 3, "isDelisted": True}]}
        if body["type"] == "candleSnapshot":
            r = body["req"]
            last = min(self.n_candles - 1, (self.now - T0) // HOUR)
            first_served = max(0, last - self.cap + 1)                    # only the most recent `cap` candles exist
            lo = max(first_served, -(-(r["startTime"] - T0) // HOUR))
            hi = min(last, (r["endTime"] - T0) // HOUR)
            return [self.candle(i) for i in range(lo, hi + 1) if i not in self.drop][: self.cap]
        if body["type"] == "fundingHistory":
            rows = [{"coin": body["coin"], "fundingRate": f"{1.25e-5 + i * 1e-9:.10f}", "premium": f"{i * 1e-7:.8f}",
                     "time": T0 + i * HOUR + 12 + i % 150} for i in range(self.n_funding) if i not in self.drop_funding]
            rows = [x for x in rows if x["time"] >= body["startTime"] and x["time"] <= body.get("endTime", 1 << 62)]
            return rows[:500]
        raise AssertionError(body)


class Clock:
    def __init__(self):
        self.t, self.slept = 0.0, []

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s


def budget():
    c = Clock()
    return hl.Budget(600, sleep=c.sleep, clock=c), c


def test_only_the_three_public_read_only_request_types_can_be_sent():
    assert hl.ALLOWED_TYPES == ("candleSnapshot", "fundingHistory", "meta") and hl.INFO_URL.endswith("/info")
    for forbidden in ("clearinghouseState", "userFills", "order", "openOrders", None):
        with pytest.raises(DataError, match="not one of"):
            hl.post_info({"type": forbidden, "user": "0x0"})          # refused before any network access


def test_candles_are_paged_and_only_the_most_recent_5000_exist():
    venue = FakeVenue(n_candles=12_000)
    b, _ = budget()
    raw = hl.fetch_candles("BTC", "1h", post=venue, budget=b, now_ms=venue.now)
    assert len(raw) == 5000 and raw["ts"].is_monotonic_increasing and raw["ts"].is_unique
    assert raw["ts"].iloc[0] == T0 + 7000 * HOUR and raw["ts"].iloc[-1] == T0 + 11_999 * HOUR
    assert len([c for c in venue.calls if c["type"] == "candleSnapshot"]) == 1      # one answer holds everything the venue has
    # a smaller page size forces several pages: same rows, no duplicate, no hole
    small = FakeVenue(n_candles=2_300, candle_cap=5000)
    hl_page = hl.CANDLE_PAGE
    try:
        hl.CANDLE_PAGE = 500
        small.cap = 500
        small_all = FakeVenue(n_candles=2_300, candle_cap=10**6)

        def paged(body):                                   # serves 500 rows per answer from the full history
            return small_all(body)[:500]

        raw2 = hl.fetch_candles("BTC", "1h", start=pd.Timestamp(T0, unit="ms", tz="UTC"), post=paged, budget=budget()[0],
                                now_ms=small_all.now)
    finally:
        hl.CANDLE_PAGE = hl_page
    assert len(raw2) == 2300 and np.array_equal(np.diff(raw2["ts"]), np.full(2299, HOUR))


def test_download_keeps_closed_bars_merges_and_reports_quality(tmp_path):
    venue = FakeVenue(n_candles=300, n_funding=301)
    b, _ = budget()
    # as_of is "now" in download(): every fake bar is long closed; the bar in progress is tested below
    out = hl.download("BTC", "1h", out=tmp_path, post=venue, budget=b)
    assert out["ok"] and out["candles"]["n_bars"] == 300 and out["candles"]["missing_bars"] == 0
    assert out["funding"]["n"] == 301 and out["funding"]["max_offset_ms"] <= 161   # from the first candle on
    df, q = load_candles("BTC", "1h", root=tmp_path, source="hyperliquid")
    assert len(df) == 300 and q.ok() and df["open"].iloc[0] == 100.0 and str(df.index.tz) == "UTC"
    # a second download with newer bars merges without duplicates
    venue2 = FakeVenue(n_candles=320, n_funding=321)
    out = hl.download("BTC", "1h", out=tmp_path, post=venue2, budget=budget()[0])
    assert out["candles"]["n_bars"] == 320 and out["funding"]["n"] == 321
    f, fq = hl.load_funding("BTC", root=tmp_path)
    assert fq.ok() and fq.missing == 0 and len(f) == 321 and f.index[0] == pd.Timestamp(T0, unit="ms", tz="UTC")


def test_the_bar_in_progress_is_dropped_and_gaps_are_counted_never_filled():
    from spq.data.core import normalise

    venue = FakeVenue(n_candles=50, drop={10, 11, 30})
    raw = hl.fetch_candles("BTC", "1h", post=venue, budget=budget()[0], now_ms=venue.now)
    as_of = pd.Timestamp(venue.now, unit="ms", tz="UTC")              # inside bar 49
    df, q = normalise(raw, symbol="BTC", interval="1h", source="hyperliquid", as_of=as_of)
    assert q.unclosed_dropped == 1 and df.index[-1] == pd.Timestamp(T0 + 48 * HOUR, unit="ms", tz="UTC")
    assert q.missing_bars == 3 and q.max_gap_bars == 2 and len(q.gaps) == 2 and len(df) == 46
    assert not q.ok()                                                  # 3 of 49 missing is far above 0.5 %


def test_funding_is_paged_aligned_to_the_hour_and_checked():
    venue = FakeVenue(n_funding=1_300, drop_funding={700, 701, 702})
    raw = hl.fetch_funding("BTC", post=venue, budget=budget()[0], now_ms=T0 + 2000 * HOUR)
    assert len(raw) == 1297 and len([c for c in venue.calls if c["type"] == "fundingHistory"]) == 3
    f, q = hl.normalise_funding(raw, symbol="BTC", as_of=pd.Timestamp(T0 + 2000 * HOUR, unit="ms", tz="UTC"))
    # settlement instants are 12..161 ms after the hour: attached to the hour, the offset is reported
    assert (f.index.asi8 % (HOUR * 10**6) == 0).all() and q.max_offset_ms == 161 and q.off_grid == 0
    assert f["rate"].iloc[0] == 1.25e-5 and f["time_ms"].iloc[5] == T0 + 5 * HOUR + 17
    assert q.missing == 3 and q.max_gap == 3 and q.gaps[0][2] == 3 and q.expected == 1300 and len(f) == 1297
    assert q.ok(max_missing_fraction=0.005) and not q.ok(max_gap=2)
    # start is inclusive, end exclusive, on the settlement hour; nothing after as_of
    _, q2 = hl.normalise_funding(raw, symbol="BTC", start=pd.Timestamp(T0 + 10 * HOUR, unit="ms", tz="UTC"),
                                 end=pd.Timestamp(T0 + 20 * HOUR, unit="ms", tz="UTC"), as_of="2100-01-01")
    assert q2.n == 10
    _, q3 = hl.normalise_funding(raw, symbol="BTC", as_of=pd.Timestamp(T0 + 99 * HOUR + 5, unit="ms", tz="UTC"))
    assert q3.n == 100 and q3.unsettled_dropped == 1197


def test_funding_refuses_what_cannot_be_trusted():
    base = pd.DataFrame({"time_ms": [T0 + 10, T0 + HOUR + 10, T0 + 2 * HOUR + 10], "rate": [1e-5, 2e-5, 3e-5]})
    far = "2100-01-01"
    f, q = hl.normalise_funding(base, symbol="X", as_of=far)
    assert q.ok() and np.isnan(f["premium"]).all()
    # an instant 20 minutes after the hour cannot be attributed to a settlement
    off = base.assign(time_ms=[T0 + 10, T0 + HOUR + 20 * 60_000, T0 + 2 * HOUR + 10])
    f, q = hl.normalise_funding(off, symbol="X", as_of=far)
    assert q.off_grid == 1 and not q.ok() and len(f) == 2 and q.missing == 1
    # two rows on the same hour: conflicting -> error; identical -> merged on request
    dup = pd.concat([base, pd.DataFrame({"time_ms": [T0 + HOUR + 30], "rate": [9e-5]})])
    with pytest.raises(DataError, match="share a settlement hour"):
        hl.normalise_funding(dup, symbol="X", as_of=far)
    same = pd.concat([base, pd.DataFrame({"time_ms": [T0 + HOUR + 30], "rate": [2e-5]})])
    with pytest.raises(DataError):
        hl.normalise_funding(same, symbol="X", as_of=far)
    f, q = hl.normalise_funding(same, symbol="X", as_of=far, on_duplicate="drop_identical")
    assert q.duplicates_dropped == 1 and len(f) == 3
    bad = base.assign(rate=[1e-5, float("nan"), 3e-5])
    assert hl.normalise_funding(bad, symbol="X", as_of=far)[1].non_finite == 1
    with pytest.raises(DataError, match="time_ms and rate"):
        hl.normalise_funding(pd.DataFrame({"ts": [1]}), symbol="X")


def test_meta_budget_and_depth_measurement():
    venue = FakeVenue(n_candles=9000, n_funding=40)
    meta = hl.fetch_meta(post=venue, budget=budget()[0])
    assert meta["BTC"] == {"max_leverage": 40.0, "size_decimals": 5, "delisted": False} and meta["OLD"]["delisted"]
    with pytest.raises(DataError):
        hl.fetch_meta(post=lambda body: [], budget=budget()[0])
    # the budget never lets more than the limit through inside one minute
    b, clock = budget()
    for _ in range(30):
        b.take(20)                                         # 600 of weight: fits
    assert clock.slept == []
    b.take(20)
    assert clock.slept and clock.t >= 60.0 - 1e-9          # the 31st request waited for the window to slide
    b2, clock2 = budget()
    hl.fetch_funding("BTC", post=FakeVenue(n_funding=3000), budget=b2, now_ms=T0 + 4000 * HOUR)
    spent = sum(w for _, w in b2.spent) + 0
    assert clock2.t >= 0 and spent <= 600                  # 7 pages x (20 + 25) = 315 of weight
    depth = hl.measure_depth("BTC", intervals=("1h",), post=venue, budget=budget()[0])
    assert depth["candles"]["1h"]["rows_served"] == 5000 and depth["funding"]["first"].startswith(
        pd.Timestamp(T0, unit="ms", tz="UTC").isoformat()[:19])


def test_load_perp_universe_joins_candles_funding_and_spot_legs(tmp_path):
    for sym, n in (("BTC", 300), ("ETH", 290)):
        venue = FakeVenue(n_candles=n, n_funding=n + 1)
        hl.download(sym, "1h", out=tmp_path, post=venue, budget=budget()[0])
    # spot candles of BTC from "coinbase" (same layout as spq.data.fetch writes), with one bar missing
    spot = pd.read_parquet(tmp_path / "hyperliquid" / "BTC_1h.parquet").drop(index=[100])
    (tmp_path / "coinbase").mkdir()
    spot.to_parquet(tmp_path / "coinbase" / "BTC_1h.parquet", index=False)
    data, q, fq, raw = hl.load_perp_universe(["BTC", "ETH", "BTC.SPOT"], "1h", root=tmp_path)
    assert list(data) == ["BTC", "ETH", "BTC.SPOT"]
    idx = data["BTC"].index
    assert all(df.index.equals(idx) for df in data.values()) and len(idx) == 289      # common bars only
    assert {"funding", "premium"} <= set(data["BTC"].columns) and "funding" not in data["BTC.SPOT"].columns
    assert q["BTC.SPOT"].missing_bars == 1 and q["BTC.SPOT"].symbol == "BTC.SPOT" and fq["BTC"].ok() and set(fq) == {"BTC", "ETH"}
    # the funding of a bar is the settlement dated at its open hour
    i = 57
    assert data["BTC"]["funding"].iloc[i] == raw["BTC"]["rate"].loc[idx[i]]
    assert hl.check_funding_alignment(data, raw)["status"] == "pass"
    ref, ref_q = hl.load_spot_reference(["BTC"], "1h", idx, root=tmp_path)
    assert len(ref["BTC"]) <= 300 and ref_q["BTC"].missing_bars == 1
    assert hl.load_spot_reference(["BTC", "ETH"], "1h", idx, root=tmp_path) == ({}, {})   # no ETH spot file
    with pytest.raises(DataError, match="no funding file"):
        hl.load_funding("SOL", root=tmp_path)
    meta_file = hl.meta_path(tmp_path)
    meta_file.write_text(json.dumps({"universe": {"BTC": {"max_leverage": 40.0, "size_decimals": 5}}}))
    assert hl.load_meta(tmp_path)["universe"]["BTC"]["max_leverage"] == 40.0 and hl.load_meta(tmp_path / "none") == {}


def test_funding_loader_hook_replaces_the_file_reader():
    """The hook for a database table, should one exist later: any callable returning time_ms / rate / premium."""
    def from_elsewhere(symbol, start, end):
        return pd.DataFrame({"time_ms": [T0 + i * HOUR + 40 for i in range(5)], "rate": [1e-5] * 5,
                             "premium": [0.0] * 5})

    f, q = hl.load_funding("BTC", loader=from_elsewhere, as_of="2100-01-01")
    assert len(f) == 5 and q.ok()
    hl.FUNDING_LOADER = from_elsewhere
    try:
        assert len(hl.load_funding("ETH", as_of="2100-01-01")[0]) == 5
    finally:
        hl.FUNDING_LOADER = None


@pytest.mark.network
def test_live_hyperliquid_public_endpoint():
    """Opt-in (SPQ_NETWORK_TESTS=1): three read-only requests to the public info endpoint."""
    b = hl.Budget(300)
    meta = hl.fetch_meta(budget=b)
    assert meta["BTC"]["max_leverage"] >= 1 and meta["BTC"]["size_decimals"] >= 0
    end = pd.Timestamp.now(tz="UTC").floor("h")
    start = end - pd.Timedelta(hours=30)
    raw = hl.fetch_candles("BTC", "1h", start, end, budget=b)
    from spq.data.core import normalise

    df, q = normalise(raw, symbol="BTC", interval="1h", source="hyperliquid", start=start, end=end)
    assert 28 <= len(df) <= 30 and q.ohlc_violations == 0 and q.off_grid == 0
    f, fq = hl.normalise_funding(hl.fetch_funding("BTC", start, end, budget=b), symbol="BTC")
    assert 28 <= len(f) <= 31 and fq.off_grid == 0 and fq.max_offset_ms < 60_000 and f["rate"].abs().max() < 0.005
