# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/tests/test_v11_data.py
# Description      : V11 multi-venue data layer: loaders on RECORDED responses
#                    (no network), symbol map, common clock with masks, funding
#                    intervals per venue, book snapshots, quality and bias
#                    reports, manifest hashes.
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

"""V11 multi-venue data layer: loaders on RECORDED responses (no network), symbol map, common clock with masks,
funding intervals per venue, book snapshots, quality and bias reports, manifest hashes."""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from v11_helpers import AS_OF, FIX_END, FIX_START, edgex_get, fixture, replay, synthetic_store

from spq.data import books, multivenue as mv
from spq.data.core import DataError
from spq.data.hyperliquid import attach_funding, fetch_candles, fetch_funding, normalise_funding
from spq.data.venues import SYMBOL_MAP, VENUES, lab_symbol, split_symbol, venue, venue_id


# ------------------------------------------------------------------------------------------------ venue table

def test_symbol_convention_and_reviewed_map():
    assert split_symbol("BTC") == ("BTC", "hyperliquid")
    assert split_symbol("BTC@EDGEX") == ("BTC", "edgex") and split_symbol("ETH.SPOT") == ("ETH", "spot")
    assert lab_symbol("SOL", "edgex") == "SOL@EDGEX" and lab_symbol("SOL", "hyperliquid") == "SOL"
    assert lab_symbol("SOL", "spot") == "SOL.SPOT"
    assert venue_id("BTC", "edgex") == "30000001" and venue_id("ETH", "dydx") == "ETH-USD"
    assert venue_id("LINK", "hyperliquid") == "LINK"            # the primary venue's id is the ticker
    with pytest.raises(ValueError):
        venue_id("LINK", "edgex")                               # never guessed: not in the reviewed map
    with pytest.raises(ValueError):
        split_symbol("BTC@NOWHERE")
    assert set(SYMBOL_MAP) == {"BTC", "ETH", "SOL"}             # the live-pinned set, on every venue


def test_fee_table_states_source_date_and_real_funding_intervals():
    assert venue("hyperliquid").funding_interval_s == 3600 and venue("dydx").funding_interval_s == 3600
    assert venue("edgex").funding_interval_s == 14400
    assert venue("gmx").funding_model == "continuous-approximation" and "APPROXIMATION" in venue("gmx").notes
    for v in VENUES.values():
        assert v.source and v.checked.startswith("2026-") and v.taker_bps >= v.maker_bps >= 0
    assert (venue("hyperliquid").taker_bps, venue("hyperliquid").maker_bps) == (4.5, 1.5)
    assert (venue("edgex").taker_bps, venue("edgex").maker_bps) == (4.5, 4.0)


# -------------------------------------------------------------------------------------- loaders on recordings

def test_edgex_candles_follow_the_pagination_of_the_recorded_pages():
    get = edgex_get()
    raw = mv.fetch_edgex_candles("30000001", "1h", FIX_START, FIX_END, get=get)
    assert len(raw) == 48 and raw["ts"].is_monotonic_increasing                 # newest-first pages, sorted here
    assert np.diff(raw["ts"].to_numpy()).tolist() == [3_600_000] * 47
    kline_calls = [p for u, p in get.calls if "getKline" in u]
    assert len(kline_calls) == 2 and "offsetData" not in kline_calls[0]
    assert kline_calls[1]["offsetData"] == fixture("edgex_kline_page1")["data"]["nextPageOffsetData"]
    assert kline_calls[0]["klineType"] == "HOUR_1" and kline_calls[0]["size"] == 1000
    df, q = mv.normalise(raw, symbol="BTC", interval="1h", source="edgex", as_of=AS_OF)
    assert q.ok() and q.missing_bars == 0 and (df["high"] >= df["low"]).all()


def test_edgex_refuses_a_contract_whose_name_is_not_the_reviewed_one():
    page = fixture("edgex_kline_page1")
    for k in page["data"]["dataList"]:
        k["contractName"] = "DOGEUSDC"
    with pytest.raises(DataError, match="reviewed map"):
        mv.fetch_edgex_candles("30000001", "1h", FIX_START, FIX_END, get=replay({"getKline": page}))


def test_edgex_funding_is_settled_every_four_hours():
    f = mv.fetch_edgex_funding("30000001", FIX_START, FIX_END, get=edgex_get())
    assert len(f) == 12 and set(np.diff(f["time_ms"].to_numpy())) == {14_400_000}
    df, q = normalise_funding(f, symbol="BTC", source="edgex", as_of=AS_OF, interval_s=14400)
    assert q.ok() and q.missing == 0 and q.expected == 12
    # read on the hourly grid the same series looks 75 % empty: the venue's interval is part of the data
    _, hourly = normalise_funding(f, symbol="BTC", source="edgex", as_of=AS_OF)
    assert hourly.missing == 33 and not hourly.ok()


def test_dydx_and_gmx_loaders_on_recorded_responses():
    get = replay({"candles/perpetualMarkets": fixture("dydx_candles"), "historicalFunding": fixture("dydx_funding"),
                  "prices/candles": fixture("gmx_candles")})
    c = mv.fetch_dydx_candles("BTC-USD", "1h", FIX_START, FIX_END, get=get)
    f = mv.fetch_dydx_funding("BTC-USD", FIX_START, FIX_END, get=get)
    assert len(c) == 48 and (c["volume"] >= 0).all()
    assert 47 <= len(f) <= 49 and set(np.round(np.diff(f["time_ms"].to_numpy()) / 3.6e6)) == {1.0}
    _, q = normalise_funding(f, symbol="BTC", source="dydx", as_of=AS_OF, interval_s=3600)
    assert q.off_grid == 0
    g = mv.fetch_gmx_candles("BTC", "1h", FIX_START, FIX_END, get=get)
    assert len(g) == 48 and (g["volume"] == 0).all()             # oracle candles: no volume is served
    with pytest.raises(DataError):
        mv.fetch_gmx_candles("BTC", "2h", FIX_START, FIX_END, get=get)


def _store_from_recordings(tmp_path):
    """A two-venue store (Hyperliquid + edgeX, BTC, 48 bars) built from the recorded responses only."""
    def post(body):
        return fixture("hl_candles") if body["type"] == "candleSnapshot" else fixture("hl_funding")

    end_ms = int(pd.Timestamp(FIX_END).timestamp() * 1000)
    raw = fetch_candles("BTC", "1h", FIX_START, FIX_END, post=post, now_ms=end_ms)
    candles, _ = mv.normalise(raw, symbol="BTC", interval="1h", source="hyperliquid", end=FIX_END, as_of=AS_OF)
    path = tmp_path / "hyperliquid" / "BTC_1h.parquet"
    path.parent.mkdir(parents=True)
    candles.reset_index().to_parquet(path, index=False)
    (tmp_path / "hyperliquid" / "funding").mkdir()
    fetch_funding("BTC", FIX_START, FIX_END, post=post, now_ms=end_ms).to_parquet(
        tmp_path / "hyperliquid" / "funding" / "BTC.parquet", index=False)
    summary = mv.pull("edgex", "BTC", "1h", FIX_START, FIX_END, out=tmp_path, get=edgex_get(), now=AS_OF)
    return summary


def test_pull_writes_files_capture_times_and_content_hashes(tmp_path):
    summary = _store_from_recordings(tmp_path)
    assert summary["candles"]["rows"] == 48 and summary["funding"]["rows"] == 12
    cap = json.loads((tmp_path / "edgex" / "captures.json").read_text())
    rec = cap["edgex/BTC_1h.parquet"]
    assert rec["captured_at"] == AS_OF and rec["endpoint"].endswith("getKline") and len(rec["content_sha256"]) == 64
    assert rec["first"].startswith("2026-11-10T00:00") and rec["last"].startswith("2026-11-11T23:00")
    again = mv.pull("edgex", "BTC", "1h", FIX_START, FIX_END, out=tmp_path, get=edgex_get(), now=AS_OF)
    assert again["candles"]["content_sha256"] == rec["content_sha256"]         # idempotent, same hash
    m = mv.build_manifest(tmp_path)
    assert m["n_files"] == 2 and len(m["snapshot_sha256"]) == 64 and mv.build_manifest(tmp_path) == m
    df = pd.read_parquet(tmp_path / "edgex" / "BTC_1h.parquet")
    assert mv.content_sha256(df) == rec["content_sha256"]
    df.loc[3, "close"] *= 1.0001
    assert mv.content_sha256(df) != rec["content_sha256"]                       # one changed value changes the hash


def test_common_clock_masks_and_funding_per_venue_interval(tmp_path):
    _store_from_recordings(tmp_path)
    data, quality, fq, fraw, clock = mv.load_multivenue(["BTC", "BTC@EDGEX"], "1h", root=tmp_path, as_of=AS_OF)
    assert list(data) == ["BTC", "BTC@EDGEX"] and data["BTC"].index.equals(data["BTC@EDGEX"].index)
    assert len(clock["common"]) == 48 and clock["masks"]["BTC"].all() and clock["sources"]["BTC@EDGEX"] == "edgex"
    hl, ex = data["BTC"]["funding"].to_numpy(), data["BTC@EDGEX"]["funding"].to_numpy()
    assert np.isfinite(hl).all() and (hl != 0).sum() >= 40                     # one settlement per hourly bar
    hours = data["BTC"].index.hour
    assert (ex[hours % 4 != 0] == 0.0).all()                                   # nothing is DUE between settlements
    assert (ex[hours % 4 == 0] != 0.0).all() and np.isfinite(ex).all()
    assert mv.funding_intervals(["BTC", "BTC@EDGEX", "BTC.SPOT"]) == {"BTC": 3600, "BTC@EDGEX": 14400}
    assert fq["BTC@EDGEX"].ok() and fq["BTC"].ok()
    # the snapshot hash identifies exactly the frames a run uses
    assert mv.snapshot_hash(data) == mv.snapshot_hash(dict(reversed(list(data.items()))))
    other = {**data, "BTC": data["BTC"].assign(close=data["BTC"]["close"] * 1.0001)}
    assert mv.snapshot_hash(other) != mv.snapshot_hash(data)


def test_a_bar_missing_on_one_venue_is_masked_and_dropped_for_all_never_filled(tmp_path):
    _store_from_recordings(tmp_path)
    p = tmp_path / "edgex" / "BTC_1h.parquet"
    df = pd.read_parquet(p)
    df.drop(index=[10, 11, 12, 30]).to_parquet(p, index=False)                 # an outage of 3 bars and a single hole
    data, quality, _, _, clock = mv.load_multivenue(["BTC", "BTC@EDGEX"], "1h", root=tmp_path, as_of=AS_OF)
    assert len(clock["index"]) == 48 and len(clock["common"]) == 44
    assert clock["masks"]["BTC"].all() and (~clock["masks"]["BTC@EDGEX"]).sum() == 4
    assert len(data["BTC"]) == 44 and not data["BTC@EDGEX"][["open", "high", "low", "close", "volume"]].isna().any().any()
    bias = mv.data_bias(["BTC", "BTC@EDGEX"], data, quality, clock, "1h", requested_start=FIX_START)
    ex = bias["per_symbol"]["BTC@EDGEX"]
    assert ex["missing_bars"] == 4 and ex["longest_gap_bars"] == 3 and len(ex["outage_gaps"]) == 1
    assert abs(ex["missing_bar_ratio"] - 4 / 48) < 1e-12 and bias["common_clock"]["dropped_fraction"] == pytest.approx(4 / 48)
    assert bias["survivorship"]["universe_fixed_ex_post"] is True
    assert bias["listing_date_truncation"]["first_bar_per_symbol"]["BTC"].startswith("2026-11-10T00:00")
    # funding of a 4 h venue on bars with a hole: the settlement of a removed bar moves to the next bar's window
    assert np.isfinite(data["BTC@EDGEX"]["funding"]).all()


def test_attach_funding_scheduled_zero_versus_missing():
    idx = pd.date_range("2026-01-01", periods=12, freq="1h", tz="UTC", name="ts")
    candles = pd.DataFrame({c: 1.0 for c in ("open", "high", "low", "close", "volume")}, index=idx)
    f = pd.DataFrame({"rate": [1e-4, 2e-4], "premium": [0.0, 0.0]}, index=idx[[0, 8]])     # the 04:00 one is missing
    legacy = attach_funding(candles, f)["funding"].to_numpy()
    assert np.isnan(legacy).sum() == 10                                        # before V11: every other bar is "missing"
    out = attach_funding(candles, f, 14400)["funding"].to_numpy()
    assert out[0] == 1e-4 and out[8] == 2e-4 and np.isnan(out[4])              # due and absent: still missing
    assert (out[[1, 2, 3, 5, 6, 7, 9, 10, 11]] == 0.0).all()                   # not due: zero, not missing


def test_stale_prices_and_quality_report(tmp_path):
    m = synthetic_store(tmp_path, n=400)
    p = tmp_path / "edgex" / "SOL_1h.parquet"
    df = pd.read_parquet(p)
    for i in (50, 51, 52):                                                     # three bars without a trade
        df.loc[i, ["open", "high", "low", "close"]] = df.loc[49, "close"]
        df.loc[i, "volume"] = 0.0
    df.to_parquet(p, index=False)
    rep = mv.quality_report(tmp_path, "1h")
    s = rep["series"]["edgex/SOL"]
    assert s["stale_bars"] == 3 and s["stale_price_ratio"] == pytest.approx(3 / 400) and s["zero_volume_ratio"] > 0
    assert rep["series"]["hyperliquid/BTC"]["stale_bars"] == 0 and rep["funding"]["edgex/BTC"]["interval_s"] == 14400
    assert rep["funding"]["hyperliquid/BTC"]["ok"] and "BTC: edgex vs hyperliquid" in rep["cross_venue"]
    md = mv.quality_markdown(rep)
    assert "| edgex/SOL |" in md and "never filled" in md and m["n_files"] == 15


def test_gmx_cannot_be_loaded_as_a_perpetual_it_has_no_settlement_series(tmp_path):
    synthetic_store(tmp_path, n=200, symbols=("BTC",), venues=("hyperliquid", "gmx"))
    with pytest.raises(DataError, match="no funding settlement series"):
        mv.load_multivenue(["BTC", "BTC@GMX"], "1h", root=tmp_path, as_of=AS_OF)


# ------------------------------------------------------------------------------------------------------ books

def test_book_parsers_on_recorded_snapshots():
    hl = books.parse_hyperliquid(fixture("hl_l2book"), 5)
    ex = books.parse_edgex(fixture("edgex_depth"), 5)
    dy = books.parse_dydx(fixture("dydx_orderbook"), 5)
    for snap in (hl, ex, dy):
        assert len(snap["bids"]) == 5 and len(snap["asks"]) == 5
        assert snap["bids"][0][0] < snap["asks"][0][0]                          # not crossed
        assert all(isinstance(x, float) for row in snap["bids"] + snap["asks"] for x in row)
    assert hl["venue_ms"] > 1.7e12 and ex["venue_ms"] > 1.7e12 and dy["venue_ms"] == 0
    with pytest.raises(DataError):
        books.parse_edgex({"code": "INVALID_DEPTH_LEVEL", "data": None}, 5)


def test_recorder_writes_snapshots_and_records_failures_without_filling(tmp_path):
    t = {"now": 1_000.0}
    n = {"calls": 0}

    def http(url, body=None, timeout=8.0):
        n["calls"] += 1
        if "edgex" in url and n["calls"] % 4 == 0:
            raise TimeoutError("timed out")
        return fixture("hl_l2book") if body else fixture("edgex_depth")

    def sleep(dt):
        t["now"] += dt

    stats = books.record(["hyperliquid", "edgex"], ["BTC"], out=tmp_path, cadence=5.0, minutes=1.0, http=http,
                         clock=lambda: t["now"], sleep=sleep)
    assert stats["hyperliquid/BTC"] == {"ok": 12, "errors": 0}
    assert stats["edgex/BTC"]["ok"] + stats["edgex/BTC"]["errors"] == 12 and stats["edgex/BTC"]["errors"] >= 1
    snaps = books.load_books(tmp_path, "edgex", "BTC")
    assert len(snaps) == stats["edgex/BTC"]["ok"] and all("error" not in s for s in snaps)
    q = books.book_quality(tmp_path, "edgex", "BTC", 5.0)
    assert q["errors"] == stats["edgex/BTC"]["errors"] and q["max_interval_s"] >= 10.0
    assert q["median_interval_s"] in (5.0, 10.0) and q["snapshots"] == len(snaps)


def test_sweep_cost_and_depth_profile():
    asks, bids = [[100.1, 10.0], [100.2, 10.0], [100.5, 100.0]], [[99.9, 10.0], [99.8, 10.0], [99.5, 100.0]]
    mid = 100.0
    assert books.sweep_cost_bps(asks, 500.0, mid) == pytest.approx(10.0)       # inside the first level: 10 bps
    two = books.sweep_cost_bps(asks, 2000.0, mid)                              # 1001 at 100.1 then 999 at 100.2
    assert 10.0 < two < 20.0
    assert books.sweep_cost_bps(asks, 1e9, mid) is None                        # deeper than the visible book
    prof = books.depth_profile([{"bids": bids, "asks": asks}] * 5, notionals=(100, 2000, 1e9))
    assert prof["median_bps"][0] == pytest.approx(10.0) and prof["median_bps"][2] is None
    assert prof["unfillable_fraction"] == [0.0, 0.0, 1.0]
    assert books.profile_cost_bps(prof, 50) == pytest.approx(10.0)             # below the smallest size
    assert prof["p90_bps"][0] < books.profile_cost_bps(prof, 1000) < prof["p90_bps"][1]
    assert books.profile_cost_bps(prof, 5000) is None                          # beyond what the book could fill
