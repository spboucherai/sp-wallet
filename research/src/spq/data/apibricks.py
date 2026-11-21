# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/src/spq/data/apibricks.py
# Description      : Historical OHLCV from API Bricks (CoinAPI Market Data
#                    REST) — an OPTIONAL, KEYED and METERED research source.
# Module           : spq
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

"""Historical OHLCV from API Bricks (CoinAPI Market Data REST) — an OPTIONAL, KEYED and METERED research source.

    uv run python -m spq.data.apibricks --symbol-id HYPERLIQUID_PERP_BTC_USDC --interval 1h \
        --start 2024-10-01 --end 2026-11-01 --out data --max-credits 200 [--dry-run]

Why it exists: the venues' own public endpoints only reach a few months back at 1h (Hyperliquid: the last 5 000 bars),
which is the 180-day window recorded as a limitation in docs/TRADING-BACKTESTING.md. The provider keeps exchange-specific
series since each exchange's first day (`data_start` of `/v1/symbols`: HYPERLIQUID_PERP_BTC_USDC since 2024-09-27,
GEMINI_SPOT_BTC_USD since 2015-10-08 — read live on 2026-11-17).

Facts (docs/v11/research/apibricks.md, verified live on 2026-11-17):
- GET https://rest.coinapi.io/v1/ohlcv/{symbol_id}/history?period_id=&time_start=&time_end=&limit=   header X-CoinAPI-Key
  rows {time_period_start, price_open, price_high, price_low, price_close, volume_traded, …}, oldest first; a period
  without a trade is omitted; the bar in progress is included and dropped here (closed bars only).
- COST: one credit per 100 rows returned. Two years of 1h bars of ONE series = 17 520 rows = 176 credits. Nothing here
  spends without a ceiling: `max_credits` is checked BEFORE the first call from the number of bars requested, and the
  pull stops if the rows received would pass it. `--dry-run` prints the estimate and calls nothing.
- The key is read from the environment (APIBRICKS_API_KEY), sent only as a header to rest.coinapi.io, and never written
  to a file, a manifest, a message or a log. The capture manifest records the endpoint WITHOUT any credential.

Files: <out>/apibricks/<symbol_id>_<interval>.parquet and <out>/apibricks/captures.json (capture time, endpoint, rows,
first / last, content hash) — the same manifest format as the other venues (`spq data manifest` picks it up).
A series pulled here is NOT silently spliced into a venue's own history: `overlap_check` measures how far the two are
apart where both exist; whether an extension is acceptable is a decision recorded in the study, not a default.
This module only reads market data. It places no order and reads no account.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import pandas as pd

from .core import COLUMNS, DataError, interval_seconds, normalise, to_utc
from .multivenue import _capture, _write

HOST = "rest.coinapi.io"
BASE = f"https://{HOST}"
KEY_ENV = "APIBRICKS_API_KEY"
KEY_HEADER = "X-CoinAPI-Key"
PERIOD = {"1m": "1MIN", "5m": "5MIN", "15m": "15MIN", "30m": "30MIN", "1h": "1HRS", "4h": "4HRS", "1d": "1DAY"}
PAGE_ROWS = 1000  # ten credits a page
_SYMBOL_ID = re.compile(r"^[A-Z0-9]+_(SPOT|PERP)_[A-Z0-9]+_[A-Z0-9]+$")
_KEY_SHAPES = (re.compile("ab" + "k_[0-9a-f]{8,}", re.I), re.compile(r"(apikey=)[^&\s\"']+", re.I))


def scrub(text: str, key: str | None = None) -> str:
    """`text` without the key (the value when known, and anything shaped like one)."""
    if key:
        text = text.replace(key, "[redacted]")
    text = _KEY_SHAPES[0].sub("[redacted]", text)
    return _KEY_SHAPES[1].sub(r"\1[redacted]", text)


def estimate_credits(interval: str, start, end) -> int:
    """Credits a full pull of [start, end) can cost at most: one per 100 bars, rounded up per page."""
    bars = max(0, math.ceil((to_utc(end) - to_utc(start)).total_seconds() / interval_seconds(interval)))
    pages = max(1, math.ceil(bars / PAGE_ROWS))
    return math.ceil(bars / 100) + pages  # a page that ends on a partial hundred is rounded up


def apibricks_get(url: str, params: dict | None = None, *, key: str | None = None, timeout: float = 30.0):
    """GET with the key as a header. No retry: a metered call is not repeated blindly. Errors never carry the key."""
    key = key if key is not None else os.environ.get(KEY_ENV, "")
    if not key:
        raise DataError(f"{KEY_ENV} is not set: the API Bricks loader is off (nothing was called)")
    if not url.startswith(BASE + "/v1/"):
        raise DataError("apibricks: refused URL (the key is only sent to the provider's REST host)")
    full = url + ("?" + urllib.parse.urlencode(params) if params else "")
    try:
        req = urllib.request.Request(full, headers={KEY_HEADER: key, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = scrub(e.read()[:200].decode("utf-8", "replace"), key)
        raise DataError(f"apibricks: HTTP {e.code} from {scrub(full, key)}: {body}") from None
    except (urllib.error.URLError, TimeoutError) as e:
        raise DataError(f"apibricks: network error for {scrub(full, key)}: {scrub(str(e), key)}") from None


def _iso(ts: pd.Timestamp) -> str:
    return ts.strftime("%Y-%m-%dT%H:%M:%S")


def fetch_apibricks_candles(symbol_id: str, interval: str, start, end, *, get: Callable = apibricks_get,
                            max_credits: int = 50, as_of=None) -> tuple[pd.DataFrame, int]:
    """Closed bars of one exchange-specific series with bar-open time in [start, end). Returns (frame, credits spent).
    Raises before any call when the request cannot fit in `max_credits`."""
    if not _SYMBOL_ID.fullmatch(symbol_id):
        raise DataError(f"apibricks: {symbol_id!r} is not an exchange-specific spot or perpetual symbol id")
    if interval not in PERIOD:
        raise DataError(f"apibricks: interval {interval} is not served")
    step = interval_seconds(interval)
    t0, t1 = to_utc(start), to_utc(end)
    now = to_utc(as_of) if as_of is not None else pd.Timestamp(datetime.now(timezone.utc))
    need = estimate_credits(interval, t0, t1)
    if need > max_credits:
        raise DataError(f"apibricks: {symbol_id} {interval} {t0.date()}..{t1.date()} can cost {need} credits, "
                        f"above the ceiling of {max_credits}: nothing was called")
    rows: dict[int, tuple] = {}
    spent, cur = 0, t0
    while cur < t1:
        if spent + 1 > max_credits:
            raise DataError(f"apibricks: ceiling of {max_credits} credits reached after {len(rows)} bars")
        chunk = get(f"{BASE}/v1/ohlcv/{symbol_id}/history",
                    {"period_id": PERIOD[interval], "time_start": _iso(cur), "time_end": _iso(t1), "limit": PAGE_ROWS})
        if not isinstance(chunk, list):
            raise DataError(f"apibricks {symbol_id}: unexpected answer {scrub(str(chunk))[:160]}")
        spent += max(1, math.ceil(len(chunk) / 100))
        last = None
        for r in chunk:
            try:
                ts = pd.Timestamp(r["time_period_start"])
                bar = tuple(float(r[k]) for k in ("price_open", "price_high", "price_low", "price_close", "volume_traded"))
            except (KeyError, TypeError, ValueError) as e:
                raise DataError(f"apibricks {symbol_id}: malformed bar ({e})") from None
            last = ts
            if t0 <= ts < t1 and ts + pd.Timedelta(seconds=step) <= now:  # closed bars only
                rows[int(ts.timestamp() * 1000)] = bar
        if len(chunk) < PAGE_ROWS or last is None:
            break
        cur = last + pd.Timedelta(seconds=step)
    ts = sorted(rows)
    df = pd.DataFrame([rows[t] for t in ts], columns=COLUMNS).assign(ts=ts)[["ts", *COLUMNS]]
    return df, spent


def pull_apibricks(symbol_id: str, interval: str, start, end, *, out="data", get: Callable = apibricks_get,
                   max_credits: int = 50, now: str | None = None) -> dict:
    """Fetch, merge into <out>/apibricks/<symbol_id>_<interval>.parquet and record the capture."""
    now = now or datetime.now(timezone.utc).isoformat()
    df, spent = fetch_apibricks_candles(symbol_id, interval, start, end, get=get, max_credits=max_credits, as_of=now)
    path = Path(out) / "apibricks" / f"{symbol_id}_{interval}.parquet"
    merged = _write(path, df.assign(ts=pd.to_datetime(df["ts"], unit="ms", utc=True)), "ts")
    rec = _capture(out, "apibricks", path, merged, "ts",
                   f"GET {BASE}/v1/ohlcv/{symbol_id}/history?period_id={PERIOD[interval]} (key in a header, not recorded)", now)
    return {**rec, "file": str(path), "credits": spent, "fetched": int(len(df))}


def load_apibricks(symbol_id: str, interval: str, *, root="data", as_of=None) -> pd.DataFrame:
    """The stored series, normalised like every other source (UTC index, closed bars, float columns)."""
    path = Path(root) / "apibricks" / f"{symbol_id}_{interval}.parquet"
    if not path.exists():
        raise DataError(f"no API Bricks capture at {path}")
    df, _ = normalise(pd.read_parquet(path), symbol=symbol_id, interval=interval, source="apibricks", as_of=as_of)
    return df


def overlap_check(native: pd.DataFrame, other: pd.DataFrame) -> dict:
    """How far two series of the same instrument are apart where both have a bar: closes, in basis points.
    An extension source is only as good as this figure on the overlap."""
    both = native[["close"]].rename(columns={"close": "close_native"}).join(
        other[["close"]].rename(columns={"close": "close_other"}), how="inner")
    if both.empty:
        return {"bars": 0, "median_bps": None, "p99_bps": None, "max_bps": None}
    bps = ((both["close_native"] - both["close_other"]).abs() / ((both["close_native"] + both["close_other"]) / 2) * 1e4)
    return {"bars": int(len(both)), "median_bps": float(bps.median()), "p99_bps": float(bps.quantile(0.99)),
            "max_bps": float(bps.max())}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--symbol-id", required=True, help="exchange-specific id, e.g. HYPERLIQUID_PERP_BTC_USDC")
    ap.add_argument("--interval", default="1h")
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--out", default="data")
    ap.add_argument("--max-credits", type=int, default=50)
    ap.add_argument("--dry-run", action="store_true", help="print the cost estimate and call nothing")
    a = ap.parse_args(argv)
    need = estimate_credits(a.interval, a.start, a.end)
    if a.dry_run:
        print(json.dumps({"symbol_id": a.symbol_id, "interval": a.interval, "credits_at_most": need,
                          "ceiling": a.max_credits, "would_run": need <= a.max_credits}))
        return 0
    try:
        print(json.dumps(pull_apibricks(a.symbol_id, a.interval, a.start, a.end, out=a.out, max_credits=a.max_credits)))
    except DataError as e:
        print(scrub(str(e)), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
