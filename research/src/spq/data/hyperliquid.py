# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/src/spq/data/hyperliquid.py
# Description      : Hyperliquid perpetuals: candles and funding history from
#                    the PUBLIC info endpoint, into local Parquet files.
# Module           : spq
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

"""Hyperliquid perpetuals: candles and funding history from the PUBLIC info endpoint, into local Parquet files.

    uv run python -m spq.data.hyperliquid --symbols BTC,ETH,SOL,HYPE --interval 1h --out data

Read-only, keyless: three request types of `POST https://api.hyperliquid.xyz/info` and nothing else —
`candleSnapshot`, `fundingHistory` and `meta`. No account, no signature, no order.

What the venue serves (measured live on 2026-11-10, see docs/v4/quant-perps.md):

- `candleSnapshot {req: {coin, interval, startTime, endTime}}`: at most 5000 candles per answer and ONLY THE MOST
  RECENT 5000 of an interval exist at all (1h: about 208 days; 4h: about 833 days; 1d: everything). Rows
  `{t, T, o, h, l, c, v, n}`: `t` = bar-open time in ms, prices as decimal strings, `v` in base units. They are
  TRADE prices of the perpetual, not the venue's mark price and not its oracle. The bar in progress is included
  in the answer; it is dropped here (closed bars only).
- `fundingHistory {coin, startTime, endTime?}`: 500 rows per answer, oldest first, one row per hourly settlement
  since the listing (BTC: 2023-05-12). Rows `{coin, fundingRate, premium, time}`; `time` is the settlement instant
  in ms, a few tens of ms after the hour. `fundingRate` is the HOURLY rate that longs paid to shorts at that
  instant (negative: shorts paid longs).
- `meta`: `universe[i] = {name, szDecimals, maxLeverage, ...}`.

Historical mark and oracle prices are NOT served by this API: no `mark` or `index` column is produced.

Rate limit: the documentation gives 1200 weight per minute per IP; `candleSnapshot` costs 20 + 1 per 60 rows,
`fundingHistory` 20 + 1 per 20 rows, `meta` 20. `Budget` keeps this module under `weight_per_minute` (default 600)
and retries HTTP 429 / 5xx with a growing pause.

Files: <out>/hyperliquid/<SYM>_<interval>.parquet   candles, the layout of spq.data.load_candles (source
       "hyperliquid"); <out>/hyperliquid/funding/<SYM>.parquet   columns ts (settlement hour, UTC), time_ms (the
       venue's instant), rate, premium; <out>/hyperliquid/meta.json.

Funding alignment used everywhere in the lab: a settlement belongs to the bar that OPENS at its hour. The
`funding` column of bar i is the sum of the rates settled in (ts[i-1], ts[i]] (at 1h: the one settled at ts[i]).
A strategy deciding on the close of bar i therefore sees settlements up to ts[i] and not the one at ts[i] + 1h,
which the engine charges at the next open.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

from .core import COLUMNS, DataError, Quality, align, interval_seconds, normalise, to_utc

INFO_URL = "https://api.hyperliquid.xyz/info"
USER_AGENT = "spq-research/0.1"
SOURCE = "hyperliquid"
CANDLE_PAGE = 5000
FUNDING_PAGE = 500
FUNDING_INTERVAL_S = 3600
#: a settlement instant further than this from the hour is counted as off-grid (observed: 12-200 ms after)
FUNDING_TOLERANCE_MS = 60_000
ALLOWED_TYPES = ("candleSnapshot", "fundingHistory", "meta")
SPOT_SUFFIX = ".SPOT"


class Budget:
    """Sliding one-minute window of request weight."""

    def __init__(self, weight_per_minute: int = 600, sleep: Callable = time.sleep, clock: Callable = time.monotonic):
        self.limit, self.sleep, self.clock = weight_per_minute, sleep, clock
        self.spent: list[tuple[float, int]] = []

    def take(self, weight: int):
        while True:
            now = self.clock()
            self.spent = [(t, w) for t, w in self.spent if now - t < 60.0]
            if not self.spent or sum(w for _, w in self.spent) + weight <= self.limit:
                self.spent.append((now, weight))
                return
            self.sleep(max(0.05, 60.0 - (now - self.spent[0][0])))

    def add(self, weight: int):
        self.spent.append((self.clock(), weight))


def post_info(body: dict, *, retries: int = 6, timeout: float = 30.0):
    """One read-only request to the public info endpoint (only the three types this module needs)."""
    if body.get("type") not in ALLOWED_TYPES:
        raise DataError(f"request type {body.get('type')!r} is not one of {ALLOWED_TYPES}")
    payload = json.dumps(body).encode()
    for attempt in range(retries):
        try:
            req = urllib.request.Request(INFO_URL, data=payload, method="POST", headers={
                "Content-Type": "application/json", "Accept": "application/json", "User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or attempt == retries - 1:
                raise DataError(f"HTTP {e.code} from {INFO_URL} for {body.get('type')}") from e
            time.sleep(10.0 * (attempt + 1) if e.code == 429 else 1.5 * (attempt + 1))
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == retries - 1:
                raise DataError(f"network error for {INFO_URL}: {e}") from e
            time.sleep(1.5 * (attempt + 1))
    raise DataError(f"no answer from {INFO_URL}")


def _now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _ms(ts) -> int:
    return int(to_utc(ts).timestamp() * 1000)


def fetch_meta(*, post: Callable = post_info, budget: Budget | None = None) -> dict:
    """{symbol: {"max_leverage", "size_decimals", "delisted"}} of the validator-operated perp dex."""
    (budget or Budget()).take(20)
    out = post({"type": "meta"})
    if not isinstance(out, dict) or not isinstance(out.get("universe"), list):
        raise DataError(f"hyperliquid meta: unexpected answer {str(out)[:200]}")
    return {u["name"]: {"max_leverage": float(u["maxLeverage"]), "size_decimals": int(u["szDecimals"]),
                        "delisted": bool(u.get("isDelisted", False))} for u in out["universe"]}


def fetch_candles(symbol: str, interval: str, start=None, end=None, *, post: Callable = post_info,
                  budget: Budget | None = None, now_ms: int | None = None) -> pd.DataFrame:
    """Raw candles (ts in ms + OHLCV), paged forward from `start` (default: as far back as the venue goes).

    The bar in progress is NOT removed here (normalise() does it); duplicates across pages are.
    """
    step_ms = interval_seconds(interval) * 1000
    budget = budget or Budget()
    end_ms = _ms(end) if end is not None else (now_ms or _now_ms())
    cur = 0 if start is None else _ms(start) // step_ms * step_ms
    rows: dict[int, tuple] = {}
    while cur < end_ms:
        budget.take(20)
        chunk = post({"type": "candleSnapshot",
                      "req": {"coin": symbol, "interval": interval, "startTime": cur, "endTime": end_ms}})
        if not isinstance(chunk, list):
            raise DataError(f"hyperliquid {symbol}: unexpected candle answer {str(chunk)[:200]}")
        budget.add(len(chunk) // 60)
        if not chunk:
            break
        for c in chunk:
            rows[int(c["t"])] = (float(c["o"]), float(c["h"]), float(c["l"]), float(c["c"]), float(c["v"]))
        last = max(int(c["t"]) for c in chunk)
        if len(chunk) < CANDLE_PAGE or last + step_ms <= cur:
            break
        cur = last + step_ms
    ts = sorted(rows)
    return pd.DataFrame([rows[t] for t in ts], columns=COLUMNS).assign(ts=ts)[["ts", *COLUMNS]]


def fetch_funding(symbol: str, start=None, end=None, *, post: Callable = post_info, budget: Budget | None = None,
                  now_ms: int | None = None) -> pd.DataFrame:
    """Raw funding settlements: time_ms, rate, premium; paged forward (500 rows per answer), oldest first."""
    budget = budget or Budget()
    end_ms = _ms(end) if end is not None else (now_ms or _now_ms())
    cur = 0 if start is None else _ms(start)
    rows: dict[int, tuple] = {}
    while cur <= end_ms:
        budget.take(20)
        chunk = post({"type": "fundingHistory", "coin": symbol, "startTime": cur, "endTime": end_ms})
        if not isinstance(chunk, list):
            raise DataError(f"hyperliquid {symbol}: unexpected funding answer {str(chunk)[:200]}")
        budget.add(len(chunk) // 20)
        if not chunk:
            break
        for f in chunk:
            premium = f.get("premium")
            rows[int(f["time"])] = (float(f["fundingRate"]), float(premium) if premium is not None else float("nan"))
        last = max(int(f["time"]) for f in chunk)
        if len(chunk) < FUNDING_PAGE or last < cur:
            break
        cur = last + 1
    t = sorted(rows)
    return pd.DataFrame({"time_ms": t, "rate": [rows[x][0] for x in t], "premium": [rows[x][1] for x in t]})


# ------------------------------------------------------------------------------------------------------ funding

@dataclass
class FundingQuality:
    """Checks on one funding series (settlements indexed by their hour)."""

    symbol: str
    source: str
    n: int = 0
    start: str | None = None
    end: str | None = None
    expected: int = 0
    missing: int = 0
    max_gap: int = 0
    gaps: list = field(default_factory=list)      # [[first missing hour, last missing hour, n], ...] (first 50)
    duplicates_dropped: int = 0
    off_grid: int = 0                             # settlement instants further than the tolerance from the hour
    max_offset_ms: int = 0                        # largest distance between an instant and its hour
    non_finite: int = 0
    unsettled_dropped: int = 0                    # rows dated after `as_of`

    @property
    def missing_fraction(self) -> float:
        return self.missing / self.expected if self.expected else 0.0

    def ok(self, max_missing_fraction: float = 0.005, max_gap: int = 24) -> bool:
        return (self.n > 0 and self.off_grid == 0 and self.non_finite == 0
                and self.missing_fraction <= max_missing_fraction and self.max_gap <= max_gap)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["missing_fraction"] = self.missing_fraction
        return d


def normalise_funding(raw: pd.DataFrame, *, symbol: str, source: str = SOURCE, start=None, end=None, as_of=None,
                      on_duplicate: str = "raise", interval_s: int = FUNDING_INTERVAL_S,
                      ) -> tuple[pd.DataFrame, FundingQuality]:
    """Raw settlements (time_ms, rate[, premium]) -> frame indexed by settlement HOUR (UTC), oldest first.

    Each instant is attached to the nearest hour; an instant further than FUNDING_TOLERANCE_MS from it is
    counted off-grid and dropped (it cannot be attributed to a settlement). Two rows on the same hour raise,
    unless on_duplicate='drop_identical' and they carry the same rate. Missing hours are counted, never filled.
    start is inclusive, end exclusive, on the settlement hour; rows dated after `as_of` (default: now) are dropped.
    v11: `interval_s` is the venue's settlement interval (Hyperliquid and dYdX 3600, edgeX 14400): instants are
    attached to the nearest multiple of it and the missing count is on that grid. Default: hourly, as before.
    """
    q = FundingQuality(symbol=symbol, source=source)
    if "time_ms" not in raw.columns or "rate" not in raw.columns:
        raise DataError(f"{symbol}: funding needs the columns time_ms and rate")
    df = raw[["time_ms", "rate"] + (["premium"] if "premium" in raw.columns else [])].copy()
    if "premium" not in df.columns:
        df["premium"] = np.nan
    t = df["time_ms"].to_numpy(dtype="int64")
    hour_ms = int(interval_s) * 1000
    nearest = (t + hour_ms // 2) // hour_ms * hour_ms
    offset = np.abs(t - nearest)
    q.max_offset_ms = int(offset.max()) if len(offset) else 0
    bad = offset > FUNDING_TOLERANCE_MS
    q.off_grid = int(bad.sum())
    df = df.assign(ts=pd.to_datetime(nearest, unit="ms", utc=True).as_unit("ns"))[~bad]
    finite = np.isfinite(df["rate"].to_numpy(dtype="float64"))
    q.non_finite = int((~finite).sum())
    df = df[finite].sort_values("time_ms", kind="stable")
    dup = df["ts"].duplicated(keep=False)
    if dup.any():
        if on_duplicate != "drop_identical" or df[dup].groupby("ts")["rate"].nunique().max() > 1:
            raise DataError(f"{symbol}: {int(dup.sum())} funding rows share a settlement hour "
                            f"(first: {df.loc[dup, 'ts'].iloc[0]})")
        before = len(df)
        df = df[~df["ts"].duplicated(keep="first")]
        q.duplicates_dropped = before - len(df)
    df = df.set_index("ts")
    now = to_utc(as_of) if as_of is not None else pd.Timestamp(datetime.now(timezone.utc))
    settled = df.index <= now
    q.unsettled_dropped = int((~settled).sum())
    df = df[settled]
    if start is not None:
        df = df[df.index >= to_utc(start)]
    if end is not None:
        df = df[df.index < to_utc(end)]
    df = df.astype({"rate": "float64", "premium": "float64", "time_ms": "int64"})[["rate", "premium", "time_ms"]]
    q.n = len(df)
    if len(df):
        epoch = df.index.asi8 // 10**9
        q.start, q.end = df.index[0].isoformat(), df.index[-1].isoformat()
        q.expected = int((epoch[-1] - epoch[0]) // int(interval_s)) + 1
        jumps = np.diff(epoch) // int(interval_s) - 1
        where = np.nonzero(jumps > 0)[0]
        q.missing = int(jumps[where].sum())
        q.max_gap = int(jumps.max()) if len(jumps) else 0
        for i in where[:50]:
            q.gaps.append([(df.index[i] + pd.Timedelta(seconds=int(interval_s))).isoformat(),
                           (df.index[i + 1] - pd.Timedelta(seconds=int(interval_s))).isoformat(), int(jumps[i])])
    return df, q


def attach_funding(candles: pd.DataFrame, funding: pd.DataFrame, interval_s: int | None = None) -> pd.DataFrame:
    """Candles + `funding` and `premium` columns, aligned on settlement time.

    funding[i] = sum of the rates settled in (ts[i-1], ts[i]]; for the first bar, the rate settled at ts[0].
    NaN when no settlement of that window is in `funding` (the engine then charges nothing and counts it).
    premium[i] = the premium of the last settlement of the window. Nothing dated after ts[i] can enter row i.
    v11: with `interval_s` (the venue's settlement interval, e.g. 14400 for edgeX on 1h bars) a bar whose window
    contains NO SCHEDULED settlement gets 0.0 instead of NaN: nothing was due, so nothing is missing. NaN then
    still means "a settlement was due and the data do not have it". Without it: exactly as before.
    """
    out = candles.copy()
    idx = out.index
    if len(funding) == 0 or len(idx) == 0:
        return out.assign(funding=np.nan, premium=np.nan)
    f = funding[funding.index <= idx[-1]]
    pos = idx.searchsorted(f.index, side="left")          # first bar opening at or after the settlement
    keep = (pos < len(idx)) & ~(f.index < idx[0])         # settlements before the first bar belong to no window
    g =pd.DataFrame({"pos": pos[keep], "rate": f["rate"].to_numpy()[keep], "premium": f["premium"].to_numpy()[keep]})
    agg = g.groupby("pos").agg(rate=("rate", "sum"), premium=("premium", "last"))
    rate = np.full(len(idx), np.nan)
    prem = np.full(len(idx), np.nan)
    rate[agg.index.to_numpy()] = agg["rate"].to_numpy()
    prem[agg.index.to_numpy()] = agg["premium"].to_numpy()
    if interval_s:
        epoch = idx.as_unit("s").asi8
        prev = np.concatenate([[epoch[0] - 1], epoch[:-1]])            # window of bar i is (prev[i], epoch[i]]
        due = (epoch // int(interval_s)) > (prev // int(interval_s))   # a multiple of interval_s lies in it
        rate = np.where(~due & np.isnan(rate), 0.0, rate)
    return out.assign(funding=rate, premium=prem)


def check_funding_alignment(frames: dict[str, pd.DataFrame], funding: dict[str, pd.DataFrame],
                            intervals: dict[str, int] | None = None) -> dict:
    """Rebuild the `funding` column of every perpetual from the settlement series and compare.

    'pass' only if, for every symbol that has a settlement series, the column equals attach_funding() exactly
    (a column shifted by one bar — the classic look-ahead — fails), every settlement instant is within the
    tolerance of its hour, and no frame carries a funding value on a bar that has no settlement at or before it.
    """
    detail, ok = {}, True
    for sym, raw in funding.items():
        if sym not in frames:
            continue
        df = frames[sym]
        if "funding" not in df.columns:
            detail[sym] = "no funding column"
            ok = False
            continue
        want = attach_funding(df[COLUMNS], raw, (intervals or {}).get(sym))["funding"].to_numpy()
        have = df["funding"].to_numpy(dtype="float64")
        same = bool(np.array_equal(np.isnan(want), np.isnan(have))
                    and np.allclose(want[~np.isnan(want)], have[~np.isnan(want)], rtol=0, atol=1e-15))
        offs = int(np.abs(raw["time_ms"].to_numpy() - raw.index.as_unit("ms").asi8).max()) if "time_ms" in raw and len(raw) else 0
        covered = int(np.isfinite(have).sum())
        detail[sym] = {"column_matches_settlements": same, "max_offset_ms": offs, "bars": int(len(df)),
                       "bars_with_funding": covered, "bars_without_funding": int(len(df) - covered)}
        ok &= same and offs <= FUNDING_TOLERANCE_MS
    if not detail:
        return {"status": "fail", "detail": "no funding series supplied"}
    return {"status": "pass" if ok else "fail", "detail": detail}


# -------------------------------------------------------------------------------------------------------- files

def funding_path(root, symbol: str) -> Path:
    return Path(root) / SOURCE / "funding" / f"{symbol.upper()}.parquet"


def meta_path(root) -> Path:
    return Path(root) / SOURCE / "meta.json"


#: optional replacement for the file reader: callable(symbol, start, end) -> DataFrame[time_ms, rate, premium].
#: This is the hook for a database table if one exists later. No table is assumed here: the engine's PostgreSQL
#: schema has no funding table at the time of writing, and inventing one would be guessing.
FUNDING_LOADER: Callable | None = None


def load_funding(symbol: str, start=None, end=None, *, root=None, as_of=None,
                 loader: Callable | None = None) -> tuple[pd.DataFrame, FundingQuality]:
    """Funding settlements of one perpetual from the local store (or from `loader` / FUNDING_LOADER)."""
    loader = loader or FUNDING_LOADER
    if loader is not None:
        raw = loader(symbol, start, end)
    else:
        path = funding_path(root, symbol)
        if not path.exists():
            raise DataError(f"no funding file at {path}")
        raw = pd.read_parquet(path)
    return normalise_funding(raw, symbol=symbol.upper(), start=start, end=end, as_of=as_of)


def load_meta(root) -> dict:
    p = meta_path(root)
    return json.loads(p.read_text()) if p.exists() else {}


def load_perp_universe(symbols, interval: str, start=None, end=None, *, root, spot_source: str = "coinbase",
                       as_of=None, funding_loader: Callable | None = None):
    """Load perpetual candles + funding (and the candles of spot legs 'X.SPOT' from `spot_source`).

    Returns (data aligned on common timestamps, {symbol: Quality}, {symbol: FundingQuality},
    {symbol: settlement frame}). Perpetual frames carry `funding` and `premium`.
    """
    from . import load_candles

    data, quality, fq, raw = {}, {}, {}, {}
    for s in symbols:
        if s.endswith(SPOT_SUFFIX):
            data[s], quality[s] = load_candles(s[: -len(SPOT_SUFFIX)], interval, start, end, root=root,
                                               source=spot_source, as_of=as_of)
            quality[s].symbol = s
            continue
        data[s], quality[s] = load_candles(s, interval, start, end, root=root, source=SOURCE, as_of=as_of)
    data = align(data)
    for s in symbols:
        if s.endswith(SPOT_SUFFIX):
            continue
        raw[s], fq[s] = load_funding(s, None, end, root=root, as_of=as_of, loader=funding_loader)
        data[s] = attach_funding(data[s], raw[s])
        first = data[s].index[0] if len(data[s]) else None
        if first is not None:                       # quality of the part that the bars actually use
            _, fq[s] = normalise_funding(raw[s].reset_index(drop=True), symbol=s, start=first, end=end, as_of=as_of)
    return data, quality, fq, raw


def load_spot_reference(symbols, interval: str, index: pd.DatetimeIndex, *, root, source: str = "coinbase"):
    """Spot candles of the same assets on the perpetual bars (benchmark 'buy and hold spot').

    Returns ({symbol: frame}, {symbol: Quality}) restricted to the timestamps present for every symbol AND in
    `index`; ({}, {}) when a spot file is missing.
    """
    from . import load_candles

    data, quality = {}, {}
    try:
        for s in symbols:
            data[s], quality[s] = load_candles(s, interval, index[0], index[-1] + pd.Timedelta(seconds=1), root=root,
                                               source=source)
    except DataError:
        return {}, {}
    return data, quality


# ----------------------------------------------------------------------------------------------------- download

def _merge(path: Path, new: pd.DataFrame, key: str) -> pd.DataFrame:
    if path.exists():
        old = pd.read_parquet(path)
        both = pd.concat([old, new], ignore_index=True)
        new = both[~both[key].duplicated(keep="last")].sort_values(key).reset_index(drop=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    new.to_parquet(path, index=False)
    return new


def download(symbol: str, interval: str, start=None, end=None, *, out="data", funding_start=None,
             post: Callable = post_info, budget: Budget | None = None) -> dict:
    """Fetch candles and funding of one perpetual, keep closed bars, merge with the store. Returns a summary."""
    budget = budget or Budget()
    sym = symbol.upper() if symbol.upper() == symbol else symbol     # some listings are mixed case (kPEPE)
    raw = fetch_candles(sym, interval, start, end, post=post, budget=budget)
    if raw.empty:
        raise DataError(f"hyperliquid {sym}: no candle returned")
    candles, _ = normalise(raw, symbol=sym.upper(), interval=interval, source=SOURCE, start=start, end=end)
    cpath = Path(out) / SOURCE / f"{sym.upper()}_{interval}.parquet"
    merged = _merge(cpath, candles.reset_index(), "ts")
    _, cq = normalise(merged, symbol=sym.upper(), interval=interval, source=SOURCE)
    f_from = funding_start if funding_start is not None else (candles.index[0] if len(candles) else start)
    fraw = fetch_funding(sym, f_from, end, post=post, budget=budget)
    fmerged = _merge(funding_path(out, sym), fraw, "time_ms")
    _, fq = normalise_funding(fmerged, symbol=sym.upper())
    return {"symbol": sym.upper(), "candles_file": str(cpath), "funding_file": str(funding_path(out, sym)),
            "candles": cq.to_dict(), "funding": fq.to_dict(), "ok": cq.ok() and fq.ok()}


def measure_depth(symbol: str, intervals=("1h", "4h", "1d"), *, post: Callable = post_info,
                  budget: Budget | None = None) -> dict:
    """How far back the venue serves each series: first candle of each interval and first funding settlement."""
    budget = budget or Budget()
    now = _now_ms()
    out: dict = {"symbol": symbol, "measured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                 "candles": {}}
    for iv in intervals:
        budget.take(20 + CANDLE_PAGE // 60)
        chunk = post({"type": "candleSnapshot", "req": {"coin": symbol, "interval": iv, "startTime": 0,
                                                         "endTime": now}})
        if chunk:
            first = min(int(c["t"]) for c in chunk)
            out["candles"][iv] = {"rows_served": len(chunk),
                                  "first": pd.Timestamp(first, unit="ms", tz="UTC").isoformat(),
                                  "days": round((now - first) / 86_400_000, 1)}
    budget.take(20 + FUNDING_PAGE // 20)
    f = post({"type": "fundingHistory", "coin": symbol, "startTime": 0})
    if f:
        first = int(f[0]["time"])
        out["funding"] = {"first": pd.Timestamp(first, unit="ms", tz="UTC").isoformat(),
                          "days": round((now - first) / 86_400_000, 1), "rows_per_page": len(f)}
    return out


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m spq.data.hyperliquid", description=__doc__.split("\n")[0])
    p.add_argument("--symbols", required=True, help="comma-separated perpetuals, e.g. BTC,ETH,SOL,HYPE")
    p.add_argument("--interval", default="1h")
    p.add_argument("--start", default=None, help="UTC, inclusive (default: as far back as the venue serves)")
    p.add_argument("--end", default=None, help="UTC, exclusive (default: now)")
    p.add_argument("--funding-start", default=None,
                   help="UTC; default: the first candle (funding older than the candles is not downloaded)")
    p.add_argument("--out", default="data")
    p.add_argument("--weight-per-minute", type=int, default=600)
    p.add_argument("--depth", action="store_true", help="also measure how far back each series goes")
    a = p.parse_args(argv)
    budget = Budget(a.weight_per_minute)
    status = 0
    symbols = [s.strip() for s in a.symbols.split(",") if s.strip()]
    try:
        meta = fetch_meta(budget=budget)
        path = meta_path(a.out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                    "universe": meta}, indent=1) + "\n")
    except DataError as e:
        print(f"meta: {e}", file=sys.stderr)
        status = 1
    for sym in symbols:
        try:
            print(json.dumps(download(sym, a.interval, a.start, a.end, out=a.out, funding_start=a.funding_start,
                                      budget=budget)))
            if a.depth:
                print(json.dumps(measure_depth(sym, budget=budget)))
        except DataError as e:
            print(f"{sym}: {e}", file=sys.stderr)
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())
