"""Normalisation and quality checks shared by every data source.

Conventions (identical to the `candles` table of docs/v3/ARCHITECTURE.md):
- index `ts` = bar-OPEN time, timezone-aware UTC, strictly increasing (oldest first);
- columns open, high, low, close, volume as float64;
- only CLOSED bars: a bar is closed when ts + interval <= as_of.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

import numpy as np
import pandas as pd

COLUMNS = ["open", "high", "low", "close", "volume"]

_UNIT_SECONDS = {"m": 60, "h": 3600, "d": 86400, "w": 604800}


class DataError(ValueError):
    """Raised when a series cannot be trusted (duplicates, unsorted, malformed, forbidden gaps)."""


def interval_seconds(interval: str) -> int:
    """'1m' -> 60, '1h' -> 3600, '1d' -> 86400."""
    m = re.fullmatch(r"(\d+)([mhdw])", interval)
    if not m or int(m.group(1)) <= 0:
        raise DataError(f"unsupported interval {interval!r} (expected e.g. 1m, 5m, 1h, 4h, 1d)")
    return int(m.group(1)) * _UNIT_SECONDS[m.group(2)]


def bars_per_year(interval: str) -> float:
    """Annualisation factor for a 24/7 market: number of bars in a 365-day year."""
    return 365.0 * 86400.0 / interval_seconds(interval)


def to_utc(ts) -> pd.Timestamp:
    """Parse a timestamp; naive values are taken as UTC."""
    t = pd.Timestamp(ts)
    return t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")


@dataclass
class Quality:
    """Result of the checks on one (symbol, interval) series."""

    symbol: str
    interval: str
    source: str
    n_bars: int = 0
    start: str | None = None
    end: str | None = None
    expected_bars: int = 0
    missing_bars: int = 0
    max_gap_bars: int = 0
    gaps: list = field(default_factory=list)  # [[first_missing_ts, last_missing_ts, n_missing], ...] (first 50)
    duplicates_dropped: int = 0
    unclosed_dropped: int = 0
    off_grid: int = 0
    ohlc_violations: int = 0

    @property
    def missing_fraction(self) -> float:
        return self.missing_bars / self.expected_bars if self.expected_bars else 0.0

    def ok(self, max_missing_fraction: float = 0.005, max_gap_bars: int = 24) -> bool:
        """Hard yes/no: enough bars, on the grid, sane OHLC, few and short gaps."""
        return (
            self.n_bars > 0
            and self.off_grid == 0
            and self.ohlc_violations == 0
            and self.missing_fraction <= max_missing_fraction
            and self.max_gap_bars <= max_gap_bars
        )

    def to_dict(self) -> dict:
        d = asdict(self)
        d["missing_fraction"] = self.missing_fraction
        return d


def normalise(
    raw: pd.DataFrame,
    *,
    symbol: str,
    interval: str,
    source: str,
    start=None,
    end=None,
    as_of=None,
    on_duplicate: str = "raise",
    on_gap: str = "report",
) -> tuple[pd.DataFrame, Quality]:
    """Turn a raw frame (column or index `ts` + OHLCV) into the canonical form and check it.

    start is inclusive, end is exclusive (both on bar-open time). `as_of` (default: now) is the instant
    used to drop bars that are not closed yet. Duplicated timestamps raise unless
    on_duplicate='drop_identical' (rows that are exact copies are merged; conflicting copies always raise).
    Gaps are reported in the Quality object; on_gap='raise' turns any gap into an error.
    Missing bars are never filled.
    """
    step = interval_seconds(interval)
    df = raw.copy()
    if "ts" in df.columns:
        df = df.set_index("ts")
    missing = [c for c in COLUMNS if c not in df.columns]
    if missing:
        raise DataError(f"{symbol} {interval}: missing columns {missing}")
    idx = df.index
    if not isinstance(idx, pd.DatetimeIndex):
        if pd.api.types.is_numeric_dtype(idx):
            vals = np.asarray(idx, dtype="float64")
            unit = "ms" if len(vals) and np.nanmax(np.abs(vals)) > 1e11 else "s"
            idx = pd.to_datetime(vals, unit=unit, utc=True)
        else:
            idx = pd.to_datetime(idx, utc=True)
    idx = idx.tz_localize("UTC") if idx.tz is None else idx.tz_convert("UTC")
    df = df[COLUMNS].astype("float64")
    df.index = idx.as_unit("ns").rename("ts")

    q = Quality(symbol=symbol, interval=interval, source=source)

    df = df.sort_index(kind="stable")
    dup = df.index.duplicated(keep=False)
    if dup.any():
        if on_duplicate != "drop_identical":
            first = df.index[dup][0]
            raise DataError(f"{symbol} {interval}: {int(dup.sum())} rows share a timestamp (first: {first})")
        deduped = df[~df.index.duplicated(keep="first")]
        merged = df.reset_index().drop_duplicates()
        if len(merged) != len(deduped):
            raise DataError(f"{symbol} {interval}: conflicting rows for the same timestamp")
        q.duplicates_dropped = len(df) - len(deduped)
        df = deduped

    if start is not None:
        df = df[df.index >= to_utc(start)]
    if end is not None:
        df = df[df.index < to_utc(end)]

    now = to_utc(as_of) if as_of is not None else pd.Timestamp(datetime.now(timezone.utc))
    closed = df.index + pd.Timedelta(seconds=step) <= now
    q.unclosed_dropped = int((~closed).sum())
    df = df[closed]

    epoch = df.index.asi8 // 10**9
    q.off_grid = int(((epoch % step) != 0).sum() + ((df.index.asi8 % 10**9) != 0).sum())

    v = df.to_numpy()
    o, h, l, c, vol = (v[:, i] for i in range(5))
    bad = ~np.isfinite(v).all(axis=1)
    bad |= (np.minimum.reduce([o, h, l, c]) <= 0) | (vol < 0)
    bad |= (h < np.maximum(o, c)) | (l > np.minimum(o, c))
    q.ohlc_violations = int(bad.sum())

    q.n_bars = len(df)
    if len(df):
        q.start, q.end = df.index[0].isoformat(), df.index[-1].isoformat()
        q.expected_bars = int((epoch[-1] - epoch[0]) // step) + 1
        jumps = np.diff(epoch) // step - 1
        where = np.nonzero(jumps > 0)[0]
        q.missing_bars = int(jumps[where].sum())
        q.max_gap_bars = int(jumps.max()) if len(jumps) else 0
        for i in where[:50]:
            a = df.index[i] + pd.Timedelta(seconds=step)
            b = df.index[i + 1] - pd.Timedelta(seconds=step)
            q.gaps.append([a.isoformat(), b.isoformat(), int(jumps[i])])
        if q.missing_bars and on_gap == "raise":
            raise DataError(f"{symbol} {interval}: {q.missing_bars} missing bars (first gap {q.gaps[0]})")
    return df, q


def align(data: dict[str, pd.DataFrame]) -> dict[str, pd.DataFrame]:
    """Keep only the timestamps present for every symbol (no filling)."""
    if not data:
        return {}
    common = None
    for df in data.values():
        common = df.index if common is None else common.intersection(df.index)
    return {s: df.loc[common] for s, df in data.items()}
