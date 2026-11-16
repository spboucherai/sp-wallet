"""Multi-venue research data: perpetual candles and funding history of the SAME underlying on several venues.

    uv run python -m spq data pull --venues hyperliquid,edgex,dydx,gmx,coinbase --symbols BTC,ETH,SOL \
        --interval 1h --days 180 --out data
    uv run python -m spq data quality  --root data --interval 1h --out results/<run>/data-quality
    uv run python -m spq data manifest --root data --out data-manifests/<name>.json

Read-only public endpoints, no key, no account, no order. Every endpoint below was called live on 2026-11-15
(shapes in the parsers; edgeX: docs/v11/research/edgex-api.md sections 1.5 and 1.6):

- hyperliquid  spq.data.hyperliquid (candleSnapshot, fundingHistory, meta) — unchanged
- edgex        GET https://edgex-prod-v2.edgex.exchange/api/v2/public/quote/getKline
                   ?contractId=&klineType=HOUR_1&priceType=LAST_PRICE&size=<=1000
                   &filterBeginKlineTimeInclusive=&filterEndKlineTimeExclusive=&offsetData=
               GET .../api/v2/public/funding/getFundingRatePage
                   ?contractId=&size=100&filterSettlementFundingRate=true&filterBeginTimeInclusive=
                   &filterEndTimeExclusive=&offsetData=            (one settlement every 4 h)
- dydx         GET https://indexer.dydx.trade/v4/candles/perpetualMarkets/<TICKER>?resolution=1HOUR&limit=&toISO=
               GET https://indexer.dydx.trade/v4/historicalFunding/<TICKER>?limit=&effectiveBeforeOrAt=   (hourly)
- gmx          GET https://arbitrum-api.gmxinfra.io/prices/candles?tokenSymbol=&period=1h&limit=<=10000
               rows [ts_s, open, high, low, close]: ORACLE prices, NO volume, and NO funding history endpoint
               (borrow and funding fees accrue per second from pool state; see spq.data.venues "gmx")
- coinbase     spq.data.fetch (spot candles, for spot legs and the spot benchmark)

Files, the layout of spq.data.load_candles: <out>/<venue>/<SYM>_<interval>.parquet and
<out>/<venue>/funding/<SYM>.parquet (time_ms, rate, premium); <out>/<venue>/captures.json records, per file, when
it was captured, from which endpoint, its rows, range and content hash. Raw data are never committed; the manifest
(hashes, ranges, row counts) is.

What is NOT comparable across venues and is NOT converted: the quote currency (USD, USDC, a USDT-heavy index), the
price a candle is made of (trades on the order-book venues, oracle prices on GMX) and the instant of the last trade
inside a bar. Alignment is on bar-open time; a bar missing on one venue is missing (mask), never filled.
"""
from __future__ import annotations

import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

from . import load_candles
from .core import COLUMNS, DataError, Quality, align, interval_seconds, normalise, to_utc
from .hyperliquid import FundingQuality, attach_funding, normalise_funding
from .venues import EDGEX_NAMES, PRIMARY_VENUE, SPOT_VENUE, SYMBOL_MAP, split_symbol, venue, venue_id

USER_AGENT = "spq-research/0.1"
EDGEX_BASE = "https://edgex-prod-v2.edgex.exchange"
DYDX_BASE = "https://indexer.dydx.trade"
GMX_BASE = "https://arbitrum-api.gmxinfra.io"
EDGEX_KLINE = {"1m": "MINUTE_1", "5m": "MINUTE_5", "15m": "MINUTE_15", "30m": "MINUTE_30", "1h": "HOUR_1",
               "4h": "HOUR_4", "1d": "DAY_1"}
DYDX_RESOLUTION = {"1m": "1MIN", "5m": "5MINS", "15m": "15MINS", "30m": "30MINS", "1h": "1HOUR", "4h": "4HOURS",
                   "1d": "1DAY"}
GMX_PERIOD = {"1m", "5m", "15m", "1h", "4h", "1d"}
SPOT_SOURCE = "coinbase"
PERP_VENUES = ("hyperliquid", "edgex", "dydx", "gmx")


def http_get(url: str, params: dict | None = None, *, retries: int = 5, timeout: float = 30.0):
    full = url + ("?" + urllib.parse.urlencode(params) if params else "")
    for attempt in range(retries):
        try:
            req = urllib.request.Request(full, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or attempt == retries - 1:
                raise DataError(f"HTTP {e.code} from {full}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == retries - 1:
                raise DataError(f"network error for {full}: {e}") from e
        time.sleep(1.5 * (attempt + 1))
    raise DataError(f"no answer from {full}")


def _ms(ts) -> int:
    return int(to_utc(ts).timestamp() * 1000)


def _candle_frame(rows: dict[int, tuple]) -> pd.DataFrame:
    ts = sorted(rows)
    return pd.DataFrame([rows[t] for t in ts], columns=COLUMNS).assign(ts=ts)[["ts", *COLUMNS]]


# ------------------------------------------------------------------------------------------------------- edgeX

def _edgex(path: str, params: dict, get: Callable):
    out = get(EDGEX_BASE + path, params)
    if not isinstance(out, dict) or out.get("code") != "SUCCESS":
        raise DataError(f"edgex {path}: {str(out)[:200]}")
    return out["data"]


def fetch_edgex_candles(contract_id: str, interval: str, start, end, *, get: Callable = http_get,
                        max_pages: int = 200) -> pd.DataFrame:
    """Raw candles (ts ms + OHLCV, volume in base units), newest-first pages of 1000 walked with offsetData."""
    if interval not in EDGEX_KLINE:
        raise DataError(f"edgex does not serve interval {interval}")
    rows: dict[int, tuple] = {}
    params = {"contractId": contract_id, "klineType": EDGEX_KLINE[interval], "priceType": "LAST_PRICE", "size": 1000,
              "filterBeginKlineTimeInclusive": _ms(start), "filterEndKlineTimeExclusive": _ms(end)}
    for _ in range(max_pages):
        data = _edgex("/api/v2/public/quote/getKline", params, get)
        for k in data.get("dataList") or []:
            if EDGEX_NAMES.get(contract_id) not in (None, k.get("contractName")):
                raise DataError(f"edgex contract {contract_id} is {k.get('contractName')!r}, the reviewed map says "
                                f"{EDGEX_NAMES[contract_id]!r}")
            rows[int(k["klineTime"])] = (float(k["open"]), float(k["high"]), float(k["low"]), float(k["close"]),
                                         float(k["size"]))
        nxt = data.get("nextPageOffsetData") or ""
        if not nxt or not data.get("dataList"):
            break
        params = {**params, "offsetData": nxt}
    return _candle_frame(rows)


def fetch_edgex_funding(contract_id: str, start, end, *, get: Callable = http_get, max_pages: int = 400) -> pd.DataFrame:
    """Settled funding rates only (one row every 4 h): time_ms, rate (per settlement interval), premium."""
    rows: dict[int, tuple] = {}
    params = {"contractId": contract_id, "size": 100, "filterSettlementFundingRate": "true",
              "filterBeginTimeInclusive": _ms(start), "filterEndTimeExclusive": _ms(end)}
    for _ in range(max_pages):
        data = _edgex("/api/v2/public/funding/getFundingRatePage", params, get)
        for f in data.get("dataList") or []:
            if f.get("isSettlement") is not True:
                continue
            prem = f.get("avgPremiumIndex")
            rows[int(f["fundingTime"])] = (float(f["fundingRate"]), float(prem) if prem not in (None, "") else np.nan)
        nxt = data.get("nextPageOffsetData") or ""
        if not nxt or not data.get("dataList"):
            break
        params = {**params, "offsetData": nxt}
    t = sorted(rows)
    return pd.DataFrame({"time_ms": t, "rate": [rows[x][0] for x in t], "premium": [rows[x][1] for x in t]})


# -------------------------------------------------------------------------------------------------------- dYdX

def fetch_dydx_candles(ticker: str, interval: str, start, end, *, get: Callable = http_get,
                       max_pages: int = 200) -> pd.DataFrame:
    """Raw candles, newest first, walked backwards with toISO. Volume = baseTokenVolume."""
    if interval not in DYDX_RESOLUTION:
        raise DataError(f"dydx does not serve interval {interval}")
    rows: dict[int, tuple] = {}
    start_ms, cur = _ms(start), to_utc(end)
    for _ in range(max_pages):
        out = get(f"{DYDX_BASE}/v4/candles/perpetualMarkets/{ticker}",
                  {"resolution": DYDX_RESOLUTION[interval], "limit": 1000,
                   "toISO": cur.strftime("%Y-%m-%dT%H:%M:%S.000Z")})
        chunk = out.get("candles") if isinstance(out, dict) else None
        if not isinstance(chunk, list):
            raise DataError(f"dydx {ticker}: unexpected candle answer {str(out)[:200]}")
        if not chunk:
            break
        for c in chunk:
            rows[_ms(c["startedAt"])] = (float(c["open"]), float(c["high"]), float(c["low"]), float(c["close"]),
                                         float(c["baseTokenVolume"]))
        oldest = min(_ms(c["startedAt"]) for c in chunk)
        if oldest <= start_ms or len(chunk) < 2 or to_utc(pd.Timestamp(oldest, unit="ms")) >= cur:
            break
        cur = to_utc(pd.Timestamp(oldest, unit="ms"))
    rows = {t: r for t, r in rows.items() if start_ms <= t < _ms(end)}
    return _candle_frame(rows)


def fetch_dydx_funding(ticker: str, start, end, *, get: Callable = http_get, max_pages: int = 400) -> pd.DataFrame:
    """Hourly funding ticks: time_ms (effectiveAt), rate (per hour), premium NaN (not served)."""
    rows: dict[int, float] = {}
    start_ms, cur = _ms(start), to_utc(end)
    for _ in range(max_pages):
        out = get(f"{DYDX_BASE}/v4/historicalFunding/{ticker}",
                  {"limit": 1000, "effectiveBeforeOrAt": cur.strftime("%Y-%m-%dT%H:%M:%S.000Z")})
        chunk = out.get("historicalFunding") if isinstance(out, dict) else None
        if not isinstance(chunk, list):
            raise DataError(f"dydx {ticker}: unexpected funding answer {str(out)[:200]}")
        if not chunk:
            break
        for f in chunk:
            rows[_ms(f["effectiveAt"])] = float(f["rate"])
        oldest = min(_ms(f["effectiveAt"]) for f in chunk)
        if oldest <= start_ms or len(chunk) < 2 or oldest >= _ms(cur):
            break
        cur = to_utc(pd.Timestamp(oldest - 1, unit="ms"))
    t = sorted(x for x in rows if start_ms <= x < _ms(end) + 60_000)
    return pd.DataFrame({"time_ms": t, "rate": [rows[x] for x in t], "premium": np.nan})


# --------------------------------------------------------------------------------------------------------- GMX

def fetch_gmx_candles(token: str, interval: str, start, end, *, get: Callable = http_get) -> pd.DataFrame:
    """Oracle-price candles of GMX v2 (Arbitrum): no volume is served, the volume column is 0."""
    if interval not in GMX_PERIOD:
        raise DataError(f"gmx does not serve interval {interval}")
    out = get(f"{GMX_BASE}/prices/candles", {"tokenSymbol": token, "period": interval, "limit": 10000})
    chunk = out.get("candles") if isinstance(out, dict) else None
    if not isinstance(chunk, list):
        raise DataError(f"gmx {token}: unexpected candle answer {str(out)[:200]}")
    rows = {int(c[0]) * 1000: (float(c[1]), float(c[2]), float(c[3]), float(c[4]), 0.0) for c in chunk
            if _ms(start) <= int(c[0]) * 1000 < _ms(end)}
    return _candle_frame(rows)


# ------------------------------------------------------------------------------------------------ store + pull

def content_sha256(df: pd.DataFrame) -> str:
    """Hash of a frame's VALUES (column names, then each column's little-endian bytes): independent of the Parquet
    writer, of compression and of the index."""
    h = hashlib.sha256()
    for c in df.columns:
        h.update(str(c).encode() + b"\0")
        if isinstance(df[c].dtype, pd.DatetimeTZDtype) or df[c].dtype.kind == "M":
            v = pd.DatetimeIndex(df[c]).as_unit("ms").asi8
        else:
            v = df[c].to_numpy()
        h.update(np.ascontiguousarray(v.astype("<f8" if v.dtype.kind == "f" else "<i8")).tobytes())
    return h.hexdigest()


def _write(path: Path, new: pd.DataFrame, key: str) -> pd.DataFrame:
    if path.exists():
        both = pd.concat([pd.read_parquet(path), new], ignore_index=True)
        new = both[~both[key].duplicated(keep="last")].sort_values(key).reset_index(drop=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    new.to_parquet(path, index=False)
    return new


def _capture(root, source: str, path: Path, df: pd.DataFrame, key: str, endpoint: str, now: str) -> dict:
    cap = Path(root) / source / "captures.json"
    book = json.loads(cap.read_text()) if cap.exists() else {}
    t = df[key]
    first, last = (t.iloc[0], t.iloc[-1]) if len(df) else (None, None)
    def iso(x):
        if x is None:
            return None
        t = pd.Timestamp(x, unit="ms") if isinstance(x, (int, np.integer, float)) else pd.Timestamp(x)
        return (t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")).isoformat()

    rec = {"captured_at": now, "endpoint": endpoint, "rows": int(len(df)), "first": iso(first), "last": iso(last),
           "content_sha256": content_sha256(df)}
    book[str(path.relative_to(Path(root)))] = rec
    cap.write_text(json.dumps(book, indent=1, sort_keys=True) + "\n")
    return rec


def pull(venue_name: str, underlying: str, interval: str, start, end, *, out="data", get: Callable = http_get,
         now: str | None = None) -> dict:
    """Fetch candles (+ funding where the venue serves it) of one underlying on one venue into the local store."""
    now = now or datetime.now(timezone.utc).isoformat(timespec="seconds")
    v = venue_name.lower()
    root = Path(out)
    summary: dict = {"venue": v, "symbol": underlying}
    if v == "hyperliquid":
        from . import hyperliquid as hl

        res = hl.download(underlying, interval, start, end, out=out)
        if not hl.meta_path(out).exists():          # lot sizes and maximum leverage of the venue (one request)
            hl.meta_path(out).write_text(json.dumps({"fetched_at": now, "universe": hl.fetch_meta()}, indent=1) + "\n")
        for kind, key, ep in (("candles_file", "ts", "POST /info candleSnapshot"),
                              ("funding_file", "time_ms", "POST /info fundingHistory")):
            p = Path(res[kind])
            summary[kind.split("_")[0]] = _capture(root, v, p, pd.read_parquet(p), key, ep, now)
        return summary
    if v == SPOT_SOURCE:
        from . import fetch

        fetch.download(underlying, interval, start, end, source=SPOT_SOURCE, out=out)
        p = root / v / f"{underlying}_{interval}.parquet"
        summary["candles"] = _capture(root, v, p, pd.read_parquet(p), "ts", "GET /products/{SYM}-USD/candles", now)
        return summary
    vid = venue_id(underlying, v)
    funding = None
    if v == "edgex":
        raw = fetch_edgex_candles(vid, interval, start, end, get=get)
        funding, eps = fetch_edgex_funding(vid, start, end, get=get), ("GET /api/v2/public/quote/getKline",
                                                                       "GET /api/v2/public/funding/getFundingRatePage")
    elif v == "dydx":
        raw = fetch_dydx_candles(vid, interval, start, end, get=get)
        funding, eps = fetch_dydx_funding(vid, start, end, get=get), ("GET /v4/candles/perpetualMarkets/{ticker}",
                                                                      "GET /v4/historicalFunding/{ticker}")
    elif v == "gmx":
        raw, eps = fetch_gmx_candles(vid, interval, start, end, get=get), ("GET /prices/candles", None)
    else:
        raise DataError(f"no loader for venue {venue_name!r}")
    if raw.empty:
        raise DataError(f"{v} {underlying}: no candle returned")
    candles, _ = normalise(raw, symbol=underlying, interval=interval, source=v, start=start, end=end)
    cpath = root / v / f"{underlying}_{interval}.parquet"
    summary["candles"] = _capture(root, v, cpath, _write(cpath, candles.reset_index(), "ts"), "ts", eps[0], now)
    if funding is not None:
        fpath = root / v / "funding" / f"{underlying}.parquet"
        summary["funding"] = _capture(root, v, fpath, _write(fpath, funding, "time_ms"), "time_ms", eps[1], now)
    return summary


# ----------------------------------------------------------------------------------------------------- loading

def load_venue_funding(underlying: str, venue_name: str, start=None, end=None, *, root, as_of=None):
    path = Path(root) / venue_name / "funding" / f"{underlying}.parquet"
    if not path.exists():
        raise DataError(f"no funding file at {path}")
    return normalise_funding(pd.read_parquet(path), symbol=underlying, source=venue_name, start=start, end=end,
                             as_of=as_of, interval_s=venue(venue_name).funding_interval_s)


def load_multivenue(symbols, interval: str, start=None, end=None, *, root, as_of=None, spot_source: str = SPOT_SOURCE):
    """Load lab symbols ('BTC', 'BTC@EDGEX', 'BTC.SPOT') on a COMMON clock.

    Returns (data, quality, funding_quality, funding_raw, clock):
    - data[symbol]: frame on the timestamps present for EVERY symbol (no filling); perpetuals carry `funding`
      (sum of the rates settled in (ts[i-1], ts[i]], 0.0 where the venue schedules no settlement in that window,
      NaN where one was due and is missing) and `premium`;
    - clock: {"index": union grid, "masks": {symbol: bool array, True = bar present}, "common": bars kept}.
    """
    raw_c, quality, fq, fraw, sources = {}, {}, {}, {}, {}
    for s in symbols:
        base, v = split_symbol(s)
        sources[s] = spot_source if v == SPOT_VENUE else v
        raw_c[s], quality[s] = load_candles(base, interval, start, end, root=root, source=sources[s], as_of=as_of)
        quality[s].symbol = s
    step = interval_seconds(interval)
    lo = min(df.index[0] for df in raw_c.values())
    hi = max(df.index[-1] for df in raw_c.values())
    grid = pd.date_range(lo, hi, freq=pd.Timedelta(seconds=step), name="ts")
    masks = {s: grid.isin(df.index) for s, df in raw_c.items()}
    data = align(raw_c)
    for s in symbols:
        base, v = split_symbol(s)
        if v == SPOT_VENUE:
            continue
        if venue(v).funding_model != "settlement":
            raise DataError(f"{s}: {v} has no funding settlement series (see spq.data.venues); it cannot be backtested "
                            "as a perpetual here")
        fraw[s], _ = load_venue_funding(base, v, None, end, root=root, as_of=as_of)
        iv = venue(v).funding_interval_s
        data[s] = attach_funding(data[s], fraw[s], iv)
        if len(data[s]):
            _, fq[s] = normalise_funding(fraw[s].reset_index(drop=True), symbol=s, source=v, start=data[s].index[0],
                                         end=end, as_of=as_of, interval_s=iv)
    common = next(iter(data.values())).index if data else pd.DatetimeIndex([])
    return data, quality, fq, fraw, {"index": grid, "masks": masks, "common": common, "sources": sources}


def funding_intervals(symbols) -> dict[str, int]:
    return {s: venue(split_symbol(s)[1]).funding_interval_s for s in symbols if split_symbol(s)[1] != SPOT_VENUE}


# ------------------------------------------------------------------------------------------- quality and bias

def series_bias(df: pd.DataFrame, q: Quality, interval: str, *, outage_bars: int = 3) -> dict:
    """Missing-bar ratio, stale-price ratio and outage gaps of one series (already normalised).

    stale = a bar whose close equals the previous close AND whose volume is 0 (or, on a source without volume, whose
    open = high = low = close): the price did not trade. outage = a hole of at least `outage_bars` bars.
    """
    c, v = df["close"].to_numpy(), df["volume"].to_numpy()
    flat = (df["open"].to_numpy() == df["high"].to_numpy()) & (df["high"].to_numpy() == df["low"].to_numpy()) \
        & (df["low"].to_numpy() == c)
    no_volume = bool(len(v)) and not (v > 0).any()
    same = np.concatenate([[False], c[1:] == c[:-1]])
    stale = (same & flat) if no_volume else (same & (v == 0))
    return {
        "bars": int(q.n_bars), "first_bar": q.start, "last_bar": q.end, "expected_bars": int(q.expected_bars),
        "missing_bars": int(q.missing_bars), "missing_bar_ratio": float(q.missing_fraction),
        "longest_gap_bars": int(q.max_gap_bars),
        "outage_gaps": [g for g in q.gaps if g[2] >= outage_bars][:20],
        "stale_bars": int(stale.sum()), "stale_price_ratio": float(stale.mean()) if len(stale) else 0.0,
        "zero_volume_ratio": None if no_volume else float((v == 0).mean()) if len(v) else 0.0,
        "volume_served": not no_volume,
    }


def data_bias(symbols, data: dict, quality: dict, clock: dict, interval: str, *, requested_start=None,
              universe_note: str = "") -> dict:
    """The data-bias section of a version-3 report (see docs/TRADING-BACKTESTING.md)."""
    grid, common = clock["index"], clock["common"]
    per = {}
    for s in symbols:
        base, v = split_symbol(s)
        b = series_bias(data[s], quality[s], interval)
        b["venue"] = clock["sources"][s]
        b["present_on_union_grid"] = float(clock["masks"][s].mean()) if len(grid) else 0.0
        per[s] = b
    first_bars = {s: per[s]["first_bar"] for s in symbols}
    latest_first = max(first_bars.values()) if first_bars else None
    truncating = sorted(s for s, f in first_bars.items() if f == latest_first)
    req = to_utc(requested_start).isoformat() if requested_start is not None else None
    return {
        "survivorship": {
            "universe_fixed_ex_post": True,
            "statement": universe_note or (
                "the universe was chosen on the run date among instruments that are listed and liquid today; an "
                "instrument that was delisted or lost its liquidity during the window cannot be in it. Results are "
                "conditional on having picked survivors."),
        },
        "listing_date_truncation": {
            "requested_start": req, "common_start": common[0].isoformat() if len(common) else None,
            "first_bar_per_symbol": first_bars, "symbols_setting_the_start": truncating,
            "statement": "the common window starts at the latest first bar among the symbols (a venue's history "
                         "depth or a listing date); earlier bars of the other symbols are not used",
        },
        "common_clock": {"union_bars": int(len(grid)), "common_bars": int(len(common)),
                         "dropped_fraction": float(1.0 - len(common) / len(grid)) if len(grid) else 0.0,
                         "statement": "bars missing on any symbol are dropped for all (no filling); the mask of "
                                      "each symbol on the union grid is summarised in per_symbol"},
        "per_symbol": per,
    }


def quality_report(root, interval: str, symbols=None, venues=None) -> dict:
    """Data-quality report of the local store: per (venue, symbol) series quality, funding quality, and the
    cross-venue close deviation on common bars."""
    symbols = list(symbols or SYMBOL_MAP)
    venues = list(venues or [*PERP_VENUES, SPOT_SOURCE])
    out: dict = {"interval": interval, "series": {}, "funding": {}, "cross_venue": {}}
    frames: dict[tuple, pd.DataFrame] = {}
    for v in venues:
        for s in symbols:
            try:
                df, q = load_candles(s, interval, root=root, source=v)
            except DataError:
                continue
            frames[(v, s)] = df
            out["series"][f"{v}/{s}"] = {**series_bias(df, q, interval), "ohlc_violations": q.ohlc_violations,
                                         "off_grid": q.off_grid, "ok": q.ok()}
            if v in VENUE_FUNDING:
                try:
                    f, fq = load_venue_funding(s, v, df.index[0], None, root=root)
                except DataError:
                    continue
                d = fq.to_dict()
                d["gaps"] = d["gaps"][:10]
                d.update({"interval_s": venue(v).funding_interval_s, "ok": fq.ok(),
                          "mean_rate_per_hour": float(f["rate"].mean() / (venue(v).funding_interval_s / 3600.0)) if len(f) else None,
                          "mean_rate_annualised": float(f["rate"].mean() * 365.0 * 86400.0 / venue(v).funding_interval_s) if len(f) else None})
                out["funding"][f"{v}/{s}"] = d
    for s in symbols:
        ref = frames.get((PRIMARY_VENUE, s))
        if ref is None:
            continue
        for v in venues:
            if v == PRIMARY_VENUE or (v, s) not in frames:
                continue
            common = ref.index.intersection(frames[(v, s)].index)
            if not len(common):
                continue
            d = (frames[(v, s)].loc[common, "close"] / ref.loc[common, "close"] - 1.0) * 1e4
            out["cross_venue"][f"{s}: {v} vs {PRIMARY_VENUE}"] = {
                "common_bars": int(len(common)), "mean_bps": float(d.mean()), "median_abs_bps": float(d.abs().median()),
                "p99_abs_bps": float(d.abs().quantile(0.99)), "max_abs_bps": float(d.abs().max())}
    return out


VENUE_FUNDING = ("hyperliquid", "edgex", "dydx")


def quality_markdown(rep: dict) -> str:
    out = [f"# Data-quality report ({rep['interval']} bars)", "",
           "| Series | Bars | First bar | Last bar | Missing | Longest gap | Outage gaps | Stale bars | Zero volume | OK |",
           "|---|---:|---|---|---:|---:|---:|---:|---:|---|"]
    for k, s in rep["series"].items():
        zv = "n/a (no volume served)" if s["zero_volume_ratio"] is None else f"{100 * s['zero_volume_ratio']:.2f} %"
        out.append(f"| {k} | {s['bars']} | {(s['first_bar'] or '')[:16]} | {(s['last_bar'] or '')[:16]} | "
                   f"{s['missing_bars']} ({100 * s['missing_bar_ratio']:.3f} %) | {s['longest_gap_bars']} | "
                   f"{len(s['outage_gaps'])} | {s['stale_bars']} ({100 * s['stale_price_ratio']:.2f} %) | {zv} | "
                   f"{'yes' if s['ok'] else 'NO'} |")
    out += ["", "| Funding series | Settlements | Interval | Missing | Longest gap | Off grid | Mean rate / h | Annualised | OK |",
            "|---|---:|---:|---:|---:|---:|---:|---:|---|"]
    for k, f in rep["funding"].items():
        out.append(f"| {k} | {f['n']} | {f['interval_s'] // 3600} h | {f['missing']} | {f['max_gap']} | {f['off_grid']} | "
                   f"{f['mean_rate_per_hour']:.3e} | {100 * f['mean_rate_annualised']:.2f} % | {'yes' if f['ok'] else 'NO'} |")
    out += ["", "| Close vs Hyperliquid (same bar-open time) | Common bars | Mean (bps) | Median abs (bps) | p99 abs (bps) | Max abs (bps) |",
            "|---|---:|---:|---:|---:|---:|"]
    for k, c in rep["cross_venue"].items():
        out.append(f"| {k} | {c['common_bars']} | {c['mean_bps']:+.2f} | {c['median_abs_bps']:.2f} | "
                   f"{c['p99_abs_bps']:.2f} | {c['max_abs_bps']:.2f} |")
    out += ["", "Missing bars are never filled. Stale = close unchanged with zero volume (or a flat bar on a source "
            "without volume). Closes are compared at the same bar-open time: the last trade inside the bar is not "
            "simultaneous across venues, quote currencies differ (USD, USDC, USDT-heavy index) and GMX candles are "
            "oracle prices, so a difference here is not an executable spread.", ""]
    return "\n".join(out)


def build_manifest(root) -> dict:
    """Hashes, ranges and row counts of every captured file of the store (the raw files stay out of git)."""
    root = Path(root)
    files = {}
    for cap in sorted(root.glob("*/captures.json")):
        for rel, rec in json.loads(cap.read_text()).items():
            p = root / rel
            if not p.exists():
                continue
            df = pd.read_parquet(p)
            files[rel] = {**rec, "rows": int(len(df)), "content_sha256": content_sha256(df)}
    h = hashlib.sha256()
    for rel in sorted(files):
        h.update(rel.encode() + b"\0" + files[rel]["content_sha256"].encode())
    books = {}
    for p in sorted((root / "books").glob("*/*.jsonl")):          # order-book recordings: hash of the file's bytes
        lines = [ln for ln in p.read_text().splitlines() if ln.strip()]
        ms = [json.loads(ln)["captured_ms"] for ln in (lines[0], lines[-1])] if lines else [None, None]
        iso = [None if x is None else pd.Timestamp(x, unit="ms", tz="UTC").isoformat() for x in ms]
        books[str(p.relative_to(root))] = {"rows": len(lines), "first": iso[0], "last": iso[1],
                                           "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
    return {"files": files, "snapshot_sha256": h.hexdigest(), "n_files": len(files), "books": books}


def snapshot_hash(data: dict[str, pd.DataFrame]) -> str:
    """Hash of the frames a run actually used (after alignment): the `data_snapshot_sha256` of a report."""
    h = hashlib.sha256()
    for s in sorted(data):
        h.update(s.encode() + b"\0" + content_sha256(data[s].reset_index()).encode())
    return h.hexdigest()
