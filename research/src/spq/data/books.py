"""Order-book snapshots: a small recorder (read-only public endpoints) and the functions that read them back.

    uv run python -m spq data record-books --venues hyperliquid,edgex --symbols BTC,ETH,SOL --cadence 5 \
        --minutes 60 --out data

One request per (venue, symbol) every `cadence` seconds, top `levels` price levels per side. Endpoints (each
called live on 2026-11-15; shapes in the parsers below):

- Hyperliquid  POST https://api.hyperliquid.xyz/info  {"type": "l2Book", "coin": "BTC"}
               -> {"coin", "time" (ms), "levels": [[{"px", "sz", "n"}, ...bids], [...asks]]}
- edgeX        GET  https://edgex-prod-v2.edgex.exchange/api/v2/public/quote/getDepth?contractId=..&level=15
               -> {"code": "SUCCESS", "data": [{"asks": [{"price", "size"}], "bids": [...], "endVersion", ...}]}
               (docs/v11/research/edgex-api.md section 1.4; no venue timestamp in the body: `responseTime` is used)
- dYdX         GET  https://indexer.dydx.trade/v4/orderbooks/perpetualMarket/BTC-USD
               -> {"bids": [{"price", "size"}], "asks": [...]}  (no venue timestamp)

WHAT A SNAPSHOT IS NOT. It is the visible book at one instant, fetched over HTTP: no trade, no queue position, no
order-by-order update between two snapshots. Anything computed from it about fills is a MODEL. Requests of one
round are sent one after the other, so the snapshots of a round are tens to hundreds of milliseconds apart; each
row carries its own capture time.

Files: <out>/books/<venue>/<SYMBOL>.jsonl  one JSON object per snapshot:
       {"captured_ms", "venue_ms", "venue", "symbol", "bids": [[price, size], ...], "asks": [...]}  (best first)
       a failed request writes {"captured_ms", "venue", "symbol", "error": "..."}: gaps are recorded, never filled.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

from .core import DataError
from .venues import venue_id

USER_AGENT = "spq-research/0.1"
RECORD_VENUES = ("hyperliquid", "edgex", "dydx")


def _http(url: str, body: dict | None = None, timeout: float = 8.0):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if body is not None else "GET", headers={
        "Content-Type": "application/json", "Accept": "application/json", "User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_hyperliquid(raw, levels: int) -> dict:
    if not isinstance(raw, dict) or not isinstance(raw.get("levels"), list) or len(raw["levels"]) != 2:
        raise DataError(f"hyperliquid l2Book: unexpected answer {str(raw)[:160]}")
    bids, asks = raw["levels"]
    return {"venue_ms": int(raw["time"]),
            "bids": [[float(x["px"]), float(x["sz"])] for x in bids[:levels]],
            "asks": [[float(x["px"]), float(x["sz"])] for x in asks[:levels]]}


def parse_edgex(raw, levels: int) -> dict:
    if not isinstance(raw, dict) or raw.get("code") != "SUCCESS" or not raw.get("data"):
        raise DataError(f"edgex getDepth: unexpected answer {str(raw)[:160]}")
    d = raw["data"][0]
    return {"venue_ms": int(raw.get("responseTime") or 0),
            "bids": [[float(x["price"]), float(x["size"])] for x in d["bids"][:levels]],
            "asks": [[float(x["price"]), float(x["size"])] for x in d["asks"][:levels]]}


def parse_dydx(raw, levels: int) -> dict:
    if not isinstance(raw, dict) or "bids" not in raw or "asks" not in raw:
        raise DataError(f"dydx orderbook: unexpected answer {str(raw)[:160]}")
    return {"venue_ms": 0,
            "bids": [[float(x["price"]), float(x["size"])] for x in raw["bids"][:levels]],
            "asks": [[float(x["price"]), float(x["size"])] for x in raw["asks"][:levels]]}


def fetch_book(venue: str, underlying: str, *, levels: int = 20, http: Callable = _http) -> dict:
    """One snapshot, normalised: bids best (highest) first, asks best (lowest) first, floats."""
    vid = venue_id(underlying, venue)
    if venue == "hyperliquid":
        snap = parse_hyperliquid(http("https://api.hyperliquid.xyz/info", {"type": "l2Book", "coin": vid}), levels)
    elif venue == "edgex":
        snap = parse_edgex(http("https://edgex-prod-v2.edgex.exchange/api/v2/public/quote/getDepth"
                                f"?contractId={vid}&level=15"), levels)
    elif venue == "dydx":
        snap = parse_dydx(http(f"https://indexer.dydx.trade/v4/orderbooks/perpetualMarket/{vid}"), levels)
    else:
        raise DataError(f"no book endpoint for venue {venue!r} (recordable: {RECORD_VENUES})")
    snap["bids"].sort(key=lambda r: -r[0])
    snap["asks"].sort(key=lambda r: r[0])
    if not snap["bids"] or not snap["asks"] or snap["bids"][0][0] >= snap["asks"][0][0]:
        raise DataError(f"{venue} {underlying}: empty or crossed book")
    return snap


def book_path(root, venue: str, underlying: str) -> Path:
    return Path(root) / "books" / venue / f"{underlying}.jsonl"


def record(venues, symbols, *, out="data", cadence: float = 5.0, minutes: float = 60.0, levels: int = 20,
           http: Callable = _http, clock: Callable = time.time, sleep: Callable = time.sleep) -> dict:
    """Record snapshots until `minutes` have elapsed. Returns {venue/symbol: {"ok": n, "errors": n}}."""
    pairs = [(v, s) for v in venues for s in symbols]
    stats = {f"{v}/{s}": {"ok": 0, "errors": 0} for v, s in pairs}
    files = {}
    for v, s in pairs:
        p = book_path(out, v, s)
        p.parent.mkdir(parents=True, exist_ok=True)
        files[(v, s)] = p.open("a")
    start = clock()
    k = 0
    try:
        while clock() - start < minutes * 60.0:
            for v, s in pairs:
                row = {"captured_ms": int(clock() * 1000), "venue": v, "symbol": s}
                try:
                    row.update(fetch_book(v, s, levels=levels, http=http))
                    stats[f"{v}/{s}"]["ok"] += 1
                except (DataError, urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError) as e:
                    row["error"] = f"{type(e).__name__}: {e}"[:200]
                    stats[f"{v}/{s}"]["errors"] += 1
                files[(v, s)].write(json.dumps(row) + "\n")
                files[(v, s)].flush()
            k += 1
            wait = start + k * cadence - clock()
            if wait > 0:
                sleep(wait)
    finally:
        for fh in files.values():
            fh.close()
    return stats


# ---------------------------------------------------------------------------------------------------- reading

def load_books(root, venue: str, underlying: str) -> list[dict]:
    """Snapshots of one (venue, symbol), oldest first; error rows are dropped (they are counted by book_quality)."""
    p = book_path(root, venue, underlying)
    if not p.exists():
        raise DataError(f"no book file at {p}")
    rows = [json.loads(line) for line in p.read_text().splitlines() if line.strip()]
    rows = [r for r in rows if "error" not in r]
    rows.sort(key=lambda r: r["captured_ms"])
    return rows


def book_quality(root, venue: str, underlying: str, cadence_s: float) -> dict:
    p = book_path(root, venue, underlying)
    rows = [json.loads(line) for line in p.read_text().splitlines() if line.strip()] if p.exists() else []
    ok = [r for r in rows if "error" not in r]
    out = {"venue": venue, "symbol": underlying, "snapshots": len(ok), "errors": len(rows) - len(ok)}
    if len(ok) < 2:
        return out
    t = np.array(sorted(r["captured_ms"] for r in ok), dtype="float64")
    dt = np.diff(t) / 1000.0
    mids = np.array([(r["bids"][0][0] + r["asks"][0][0]) / 2.0 for r in ok])
    spread = np.array([(r["asks"][0][0] - r["bids"][0][0]) / ((r["asks"][0][0] + r["bids"][0][0]) / 2.0) * 1e4
                       for r in ok])
    out.update({
        "first": pd.Timestamp(t[0], unit="ms", tz="UTC").isoformat(), "last": pd.Timestamp(t[-1], unit="ms", tz="UTC").isoformat(),
        "minutes": float((t[-1] - t[0]) / 60000.0), "median_interval_s": float(np.median(dt)),
        "max_interval_s": float(dt.max()), "intervals_over_2x_cadence": int((dt > 2 * cadence_s).sum()),
        "unchanged_mid_fraction": float((np.diff(mids) == 0).mean()),
        "spread_bps_median": float(np.median(spread)), "spread_bps_p90": float(np.percentile(spread, 90)),
    })
    return out


def sweep_cost_bps(levels: list, notional: float, mid: float) -> float | None:
    """Cost in bps against the mid of a market order of `notional` USD walking `levels` ([[price, size], ...] best
    first). None when the visible depth is not enough."""
    left, paid, got = float(notional), 0.0, 0.0
    for px, sz in levels:
        take = min(left, px * sz)
        paid += take
        got += take / px
        left -= take
        if left <= 1e-9:
            break
    if left > 1e-9 or got <= 0:
        return None
    return abs(paid / got - mid) / mid * 1e4


def depth_profile(snapshots: list[dict], notionals=(100, 1000, 10_000, 100_000, 1_000_000)) -> dict:
    """Median and 90th percentile cost (bps against the mid, worse of buy and sell) of a market order of each size
    over the snapshots. A size the visible book could not fill in more than 10 % of the snapshots is None."""
    out = {"n_snapshots": len(snapshots), "notionals": [float(x) for x in notionals], "median_bps": [], "p90_bps": [],
           "unfillable_fraction": []}
    for q in notionals:
        costs, missing = [], 0
        for s in snapshots:
            mid = (s["bids"][0][0] + s["asks"][0][0]) / 2.0
            c = [sweep_cost_bps(s["asks"], q, mid), sweep_cost_bps(s["bids"], q, mid)]
            if None in c:
                missing += 1
            else:
                costs.append(max(c))
        frac = missing / len(snapshots) if snapshots else 1.0
        ok = bool(costs) and frac <= 0.10
        out["median_bps"].append(float(np.median(costs)) if ok else None)
        out["p90_bps"].append(float(np.percentile(costs, 90)) if ok else None)
        out["unfillable_fraction"].append(float(frac))
    return out


def profile_cost_bps(profile: dict, notional: float, which: str = "p90_bps") -> float | None:
    """Slippage read on a depth profile: log-linear interpolation between the measured sizes, the smallest size's
    cost below it, None beyond the largest size the book could fill."""
    xs = [x for x, y in zip(profile["notionals"], profile[which]) if y is not None]
    ys = [y for y in profile[which] if y is not None]
    if not xs or notional > xs[-1]:
        return None
    if notional <= xs[0]:
        return float(ys[0])
    return float(np.interp(np.log(notional), np.log(xs), ys))
