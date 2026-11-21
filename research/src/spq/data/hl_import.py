# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/src/spq/data/hl_import.py
# Description      : Write a local Hyperliquid store from a JSON file, WITHOUT
#                    any network access.
# Module           : spq
# Repository       : https://git.spboucher.ai/sp-wallet
# Project Website  : https://wallet.spboucher.ai
# Created          : 2026-11-11
# Last Modified    : 2026-11-11
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

"""Write a local Hyperliquid store from a JSON file, WITHOUT any network access.

    uv run python -m spq.data.hl_import --input bundle.json --out data

The API service pre-fetches the venue's candles and funding settlements itself (its read-only, rate-budgeted adapter)
and hands them over as one file; this module turns the file into exactly the layout `python -m spq.data.hyperliquid`
writes, with the same checks (`normalise`: closed bars only, grid, duplicates; settlements keyed by their instant).
The laboratory process that backtests a strategy for the API therefore never needs the network.

Input (decimal strings or numbers; times in milliseconds):

    {"interval": "1h", "as_of_ms": 1794300000000,
     "meta": {"BTC": {"max_leverage": 40, "size_decimals": 5}},
     "candles": {"BTC": [[ts_ms, open, high, low, close, volume], ...]},
     "funding": {"BTC": [[time_ms, rate, premium or null], ...]},
     "spot": {"source": "coinbase", "candles": {"BTC": [[ts_ms, o, h, l, c, v], ...]}}}      # optional

`as_of_ms` is the instant the data were read: bars not closed at that instant are dropped. `spot` (optional) is
written as `<out>/<source>/<SYM>_<interval>.parquet` for the buy-and-hold benchmark.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

from .core import COLUMNS, DataError, normalise
from .hyperliquid import SOURCE, funding_path, meta_path, normalise_funding


def _symbol(s) -> str:
    if not isinstance(s, str) or not (1 <= len(s) <= 12) or not s.isascii() or not s.isalnum() or s != s.upper():
        raise DataError(f"bad symbol {s!r}")
    return s


def _candles(rows, symbol: str, interval: str, source: str, as_of) -> pd.DataFrame:
    if not isinstance(rows, list) or not rows or not all(isinstance(r, list) and len(r) == 6 for r in rows):
        raise DataError(f"{symbol}: candles must be a non-empty array of [ts_ms, open, high, low, close, volume]")
    raw = pd.DataFrame({"ts": pd.to_datetime([int(r[0]) for r in rows], unit="ms", utc=True),
                        **{c: [float(r[i + 1]) for r in rows] for i, c in enumerate(COLUMNS)}})
    df, q = normalise(raw, symbol=symbol, interval=interval, source=source, as_of=as_of)
    if q.off_grid or q.ohlc_violations:
        raise DataError(f"{symbol}: {q.off_grid} timestamps off the grid, {q.ohlc_violations} impossible rows")
    return df.reset_index()


def import_bundle(bundle: dict, out) -> dict:
    """Write the store; return a summary {symbol: {"bars", "funding"}}. Raises DataError on anything unexpected."""
    if not isinstance(bundle, dict) or not isinstance(bundle.get("candles"), dict) or not isinstance(bundle.get("funding"), dict):
        raise DataError('the bundle needs "candles" and "funding" objects')
    interval = bundle.get("interval")
    if not isinstance(interval, str):
        raise DataError('the bundle needs an "interval"')
    as_of = pd.Timestamp(int(bundle["as_of_ms"]), unit="ms", tz="UTC") if bundle.get("as_of_ms") is not None else None
    symbols = [_symbol(s) for s in bundle["candles"]]
    if sorted(symbols) != sorted(bundle["funding"]):
        raise DataError("candles and funding must cover the same symbols")
    out = Path(out)
    summary: dict = {}
    for sym in symbols:
        candles = _candles(bundle["candles"][sym], sym, interval, SOURCE, as_of)
        frows = bundle["funding"][sym]
        if not isinstance(frows, list) or not frows or not all(isinstance(r, list) and len(r) in (2, 3) for r in frows):
            raise DataError(f"{sym}: funding must be a non-empty array of [time_ms, rate, premium]")
        funding = pd.DataFrame({"time_ms": [int(r[0]) for r in frows], "rate": [float(r[1]) for r in frows],
                                "premium": [float(r[2]) if len(r) > 2 and r[2] is not None else float("nan") for r in frows]})
        funding = funding.sort_values("time_ms").reset_index(drop=True)
        normalise_funding(funding, symbol=sym, as_of=as_of)          # raises on two rows for one settlement hour
        cpath = out / SOURCE / f"{sym}_{interval}.parquet"
        cpath.parent.mkdir(parents=True, exist_ok=True)
        candles.to_parquet(cpath, index=False)
        fpath = funding_path(out, sym)
        fpath.parent.mkdir(parents=True, exist_ok=True)
        funding.to_parquet(fpath, index=False)
        summary[sym] = {"bars": int(len(candles)), "funding": int(len(funding))}
    meta = bundle.get("meta") or {}
    universe = {}
    for sym, m in meta.items():
        universe[_symbol(sym)] = {"max_leverage": float(m["max_leverage"]), "size_decimals": int(m["size_decimals"]),
                                  "delisted": False}
    mp = meta_path(out)
    mp.parent.mkdir(parents=True, exist_ok=True)
    mp.write_text(json.dumps({"fetched_at": as_of.isoformat() if as_of is not None else None, "universe": universe},
                             indent=1) + "\n")
    spot = bundle.get("spot")
    if spot:
        source = spot.get("source")
        if source not in ("coinbase", "bitstamp", "kraken") or not isinstance(spot.get("candles"), dict):
            raise DataError('"spot" needs a known "source" and a "candles" object')
        for sym, rows in spot["candles"].items():
            df = _candles(rows, _symbol(sym), interval, source, as_of)
            path = out / source / f"{sym}_{interval}.parquet"
            path.parent.mkdir(parents=True, exist_ok=True)
            df.to_parquet(path, index=False)
            summary.setdefault(sym, {})["spot_bars"] = int(len(df))
    return summary


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m spq.data.hl_import", description=__doc__.split("\n")[0])
    p.add_argument("--input", required=True, help="JSON bundle written by the API service")
    p.add_argument("--out", required=True, help="root of the local store to write")
    a = p.parse_args(argv)
    try:
        with open(a.input, encoding="utf-8") as f:
            bundle = json.load(f)
        print(json.dumps(import_bundle(bundle, a.out)))
    except (DataError, OSError, ValueError, KeyError, TypeError) as e:
        print(f"spq.data.hl_import: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
