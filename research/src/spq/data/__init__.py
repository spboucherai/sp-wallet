"""OHLCV access: PostgreSQL `candles` table (production) or local Parquet/CSV files (tests, offline research).

    df, quality = load_candles("ETH", "1h", start="2025-01-01", end="2026-01-01", root="data")          # files
    df, quality = load_candles("ETH", "1h", database_url=os.environ["DATABASE_URL"], source="coinbase")  # PostgreSQL

Every loader returns closed bars only, UTC, oldest first, de-duplicated and checked for gaps (see core.normalise).
"""
from __future__ import annotations

import os
from pathlib import Path

import pandas as pd

from .core import COLUMNS, DataError, Quality, align, bars_per_year, interval_seconds, normalise, to_utc

__all__ = [
    "COLUMNS", "DataError", "Quality", "align", "bars_per_year", "interval_seconds", "normalise", "to_utc",
    "load_candles", "load_universe", "read_file", "file_path", "cross_source_deviation",
]


def file_path(root, source: str, symbol: str, interval: str) -> Path:
    """Local layout: <root>/<source>/<SYMBOL>_<interval>.parquet (or .csv)."""
    base = Path(root) / source / f"{symbol.upper()}_{interval}"
    for ext in (".parquet", ".csv"):
        if base.with_suffix(ext).exists():
            return base.with_suffix(ext)
    return base.with_suffix(".parquet")


def read_file(path) -> pd.DataFrame:
    """Read a raw Parquet or CSV candle file (column `ts` + OHLCV). No checks: use load_candles for that."""
    path = Path(path)
    if not path.exists():
        raise DataError(f"no candle file at {path}")
    if path.suffix == ".parquet":
        df = pd.read_parquet(path)
        return df.reset_index() if "ts" not in df.columns else df
    if path.suffix == ".csv":
        return pd.read_csv(path)
    raise DataError(f"unsupported file type {path.suffix!r} (use .parquet or .csv)")


def load_candles(
    symbol: str,
    interval: str,
    start=None,
    end=None,
    *,
    source: str | None = None,
    root=None,
    path=None,
    database_url: str | None = None,
    as_of=None,
    on_duplicate: str = "raise",
    on_gap: str = "report",
) -> tuple[pd.DataFrame, Quality]:
    """Load one series. Exactly one origin is used, in this order: `path`, `root` (files), `database_url`.

    If none is given, the environment decides: SPQ_DATA_DIR (files) first, then DATABASE_URL (PostgreSQL).
    start is inclusive and end exclusive, on bar-open time (UTC).
    """
    if path is None and root is None and database_url is None:
        root = os.environ.get("SPQ_DATA_DIR")
        if root is None:
            database_url = os.environ.get("DATABASE_URL")
        if root is None and database_url is None:
            raise DataError("no data origin: pass root=/path=/database_url= or set SPQ_DATA_DIR or DATABASE_URL")
    if path is not None or root is not None:
        src = source or os.environ.get("SPQ_CANDLE_SOURCE", "coinbase")
        raw = read_file(path if path is not None else file_path(root, src, symbol, interval))
    else:
        from .pg import read_pg

        raw, src = read_pg(database_url, symbol, interval, start, end, source)
    return normalise(raw, symbol=symbol.upper(), interval=interval, source=src, start=start, end=end, as_of=as_of,
                     on_duplicate=on_duplicate, on_gap=on_gap)


def cross_source_deviation(root, symbol: str, interval: str, a: str = "coinbase", b: str = "kraken") -> dict | None:
    """Relative difference of the closes of two sources on their common bars (None if a file is missing)."""
    try:
        da, _ = load_candles(symbol, interval, root=root, source=a)
        db, _ = load_candles(symbol, interval, root=root, source=b)
    except DataError:
        return None
    common = da.index.intersection(db.index)
    if len(common) == 0:
        return None
    diff = (da.loc[common, "close"] / db.loc[common, "close"] - 1.0).abs()
    return {"bars": int(len(common)), "median_abs_rel_diff": float(diff.median()),
            "max_abs_rel_diff": float(diff.max())}


def load_universe(symbols, interval: str, start=None, end=None, **kwargs):
    """Load several symbols. Returns (data aligned on common timestamps, {symbol: Quality})."""
    data, quality = {}, {}
    for s in symbols:
        data[s], quality[s] = load_candles(s, interval, start, end, **kwargs)
    return align(data), quality
