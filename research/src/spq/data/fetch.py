"""Download public, keyless OHLCV into local Parquet files so the lab works without the ingester.

    uv run python -m spq.data.fetch --symbols ETH,BTC,LINK,SOL --interval 1h --start 2024-11-10 --out data

Sources (both verified live on 2026-11-10):
- coinbase: GET https://api.exchange.coinbase.com/products/{SYM}-USD/candles?granularity=&start=&end=
  rows [time, low, high, open, close, volume], newest first, at most 300 per request, full history.
- kraken:   GET https://api.kraken.com/0/public/OHLC?pair={SYM}USD&interval=<minutes>
  rows [time, open, high, low, close, vwap, volume, count], oldest first, ONLY the most recent 720 bars
  (no deep history): useful for a cross-source check of recent bars, not for a two-year backtest.

Both return the bar in progress; it is dropped here (closed bars only). Files are written to
<out>/<source>/<SYMBOL>_<interval>.parquet and merged with what is already there.
This module only reads public market data. It sends no credentials and places no orders.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from .core import COLUMNS, DataError, interval_seconds, normalise, to_utc

USER_AGENT = "spq-research/0.1"
COINBASE_URL = "https://api.exchange.coinbase.com/products/{product}/candles"
KRAKEN_URL = "https://api.kraken.com/0/public/OHLC"
COINBASE_GRANULARITIES = {60, 300, 900, 3600, 21600, 86400}
KRAKEN_INTERVALS = {1, 5, 15, 30, 60, 240, 1440, 10080}
KRAKEN_ALIASES = {"BTC": "XBT", "DOGE": "XDG"}


def _get_json(url: str, params: dict, retries: int = 5, timeout: float = 30.0):
    full = url + "?" + urllib.parse.urlencode(params)
    for attempt in range(retries):
        try:
            req = urllib.request.Request(full, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or attempt == retries - 1:
                raise DataError(f"HTTP {e.code} from {full}: {e.read()[:200]!r}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == retries - 1:
                raise DataError(f"network error for {full}: {e}") from e
        time.sleep(1.5 * (attempt + 1))
    raise DataError(f"no answer from {full}")


def fetch_coinbase(symbol: str, interval: str, start, end=None, pause: float = 0.12) -> pd.DataFrame:
    step = interval_seconds(interval)
    if step not in COINBASE_GRANULARITIES:
        raise DataError(f"coinbase does not serve interval {interval}")
    t0 = int(to_utc(start).timestamp()) // step * step
    t1 = int((to_utc(end) if end is not None else pd.Timestamp(datetime.now(timezone.utc))).timestamp())
    rows: list = []
    cur = t0
    while cur < t1:
        hi = min(cur + 299 * step, t1)  # both bounds are inclusive on the Coinbase side, 300 bars at most
        chunk = _get_json(
            COINBASE_URL.format(product=f"{symbol.upper()}-USD"),
            {"granularity": step,
             "start": datetime.fromtimestamp(cur, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
             "end": datetime.fromtimestamp(hi, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")},
        )
        if not isinstance(chunk, list):
            raise DataError(f"coinbase {symbol}: unexpected answer {str(chunk)[:200]}")
        rows.extend(chunk)
        cur = hi + step
        time.sleep(pause)
    df = pd.DataFrame(rows, columns=["ts", "low", "high", "open", "close", "volume"])
    df = df.drop_duplicates(subset="ts")
    return df[["ts", *COLUMNS]]


def fetch_kraken(symbol: str, interval: str, start=None, end=None) -> pd.DataFrame:
    step = interval_seconds(interval)
    if step % 60 or step // 60 not in KRAKEN_INTERVALS:
        raise DataError(f"kraken does not serve interval {interval}")
    pair = KRAKEN_ALIASES.get(symbol.upper(), symbol.upper()) + "USD"
    out = _get_json(KRAKEN_URL, {"pair": pair, "interval": step // 60})
    if out.get("error"):
        raise DataError(f"kraken {symbol}: {out['error']}")
    key = next(k for k in out["result"] if k != "last")
    df = pd.DataFrame(out["result"][key], columns=["ts", "open", "high", "low", "close", "vwap", "volume", "count"])
    return df[["ts", *COLUMNS]].astype("float64")


FETCHERS = {"coinbase": fetch_coinbase, "kraken": fetch_kraken}


def download(symbol: str, interval: str, start, end=None, *, source: str = "coinbase", out="data"):
    """Fetch, keep closed bars, merge with the existing file, write Parquet. Returns (path, Quality)."""
    if source not in FETCHERS:
        raise DataError(f"unknown source {source!r} (known: {sorted(FETCHERS)})")
    raw = FETCHERS[source](symbol, interval, start, end)
    new, _ = normalise(raw, symbol=symbol.upper(), interval=interval, source=source, start=start, end=end)
    path = Path(out) / source / f"{symbol.upper()}_{interval}.parquet"
    if path.exists():
        old = pd.read_parquet(path).set_index("ts")
        old.index = pd.to_datetime(old.index, utc=True)
        both = pd.concat([old[COLUMNS], new])
        new = both[~both.index.duplicated(keep="last")].sort_index()
    path.parent.mkdir(parents=True, exist_ok=True)
    new.reset_index().to_parquet(path, index=False)
    _, quality = normalise(new.reset_index(), symbol=symbol.upper(), interval=interval, source=source)
    return path, quality


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m spq.data.fetch", description=__doc__.split("\n")[0])
    p.add_argument("--symbols", required=True, help="comma-separated, e.g. ETH,BTC,LINK,SOL")
    p.add_argument("--interval", default="1h")
    p.add_argument("--start", required=True, help="UTC, inclusive (ignored by kraken: last 720 bars only)")
    p.add_argument("--end", default=None, help="UTC, exclusive (default: now)")
    p.add_argument("--source", default="coinbase", choices=sorted(FETCHERS))
    p.add_argument("--out", default="data")
    a = p.parse_args(argv)
    status = 0
    for sym in [s.strip().upper() for s in a.symbols.split(",") if s.strip()]:
        try:
            path, q = download(sym, a.interval, a.start, a.end, source=a.source, out=a.out)
            print(json.dumps({"symbol": sym, "file": str(path), "bars": q.n_bars, "start": q.start, "end": q.end,
                              "missing_bars": q.missing_bars, "max_gap_bars": q.max_gap_bars,
                              "ohlc_violations": q.ohlc_violations, "ok": q.ok()}))
        except DataError as e:
            print(f"{sym}: {e}", file=sys.stderr)
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())
