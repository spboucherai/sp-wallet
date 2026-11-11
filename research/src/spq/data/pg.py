"""Read-only access to the engine's PostgreSQL table

    candles(source, symbol, interval, ts, open, high, low, close, volume)   PK (source, symbol, interval, ts)

as specified in docs/v3/ARCHITECTURE.md ("Market data"). `ts` is the bar-open time in UTC. The session is opened
read-only: the research zone never writes market data.
"""
from __future__ import annotations

import os

import pandas as pd

from .core import COLUMNS, DataError, to_utc

TABLE = "candles"


def read_pg(database_url: str, symbol: str, interval: str, start=None, end=None, source: str | None = None):
    """Return (raw frame with ts + OHLCV, source used).

    `source` defaults to SPQ_CANDLE_SOURCE; if neither is set and the table holds exactly one source for this
    (symbol, interval), that one is used; with several sources the call fails and lists them (mixing sources
    silently would hide cross-source deviations).
    """
    import psycopg

    source = source or os.environ.get("SPQ_CANDLE_SOURCE")
    with psycopg.connect(database_url, options="-c default_transaction_read_only=on") as conn:
        with conn.cursor() as cur:
            if source is None:
                cur.execute(
                    f"SELECT DISTINCT source FROM {TABLE} WHERE symbol = %s AND interval = %s ORDER BY 1",
                    (symbol.upper(), interval),
                )
                sources = [r[0] for r in cur.fetchall()]
                if len(sources) != 1:
                    raise DataError(
                        f"{symbol} {interval}: {len(sources)} sources in {TABLE} ({sources}); pass source= "
                        "or set SPQ_CANDLE_SOURCE"
                    )
                source = sources[0]
            sql = f"SELECT ts, open, high, low, close, volume FROM {TABLE} WHERE source = %s AND symbol = %s AND interval = %s"
            args: list = [source, symbol.upper(), interval]
            if start is not None:
                sql += " AND ts >= %s"
                args.append(to_utc(start).to_pydatetime())
            if end is not None:
                sql += " AND ts < %s"
                args.append(to_utc(end).to_pydatetime())
            cur.execute(sql + " ORDER BY ts", args)
            rows = cur.fetchall()
    if not rows:
        raise DataError(f"{symbol} {interval}: no rows in {TABLE} for source {source!r} in the requested range")
    df = pd.DataFrame(rows, columns=["ts", *COLUMNS])
    for c in COLUMNS:  # NUMERIC columns arrive as Decimal
        df[c] = df[c].astype("float64")
    return df, source
