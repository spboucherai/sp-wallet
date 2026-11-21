# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/src/spq/studies.py
# Description      : V11 research studies that are NOT trading strategies of
#                    the `target_weights` contract.
# Module           : spq
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

"""V11 research studies that are NOT trading strategies of the `target_weights` contract.

    uv run python -m spq study book_depth            --root data --out results/<run>
    uv run python -m spq study market_making_as      --root data --out results/<run>
    uv run python -m spq study cross_exchange_spread --root data --out results/<run>
    uv run python -m spq study vol_forecast          --root data --out results/<run>

Each writes <out>/<name>.json (deterministic: same data, same bytes). Hypotheses, formulas and limits are in
research/studies/<name>/README.md. A study states what was measured; none of them is a profit claim.

market_making_as — Avellaneda & Stoikov (2008) quoting with inventory skew, replayed on RECORDED order-book
snapshots. In units of basis points from the mid and of inventory lots q:
    reservation price  r = mid - q * gamma * sigma^2 * tau                (skewed against the inventory)
    half spread        d = gamma * sigma^2 * tau / 2 + ln(1 + gamma / kappa) / gamma
    quotes             bid = r - d, ask = r + d, never inside the book (post-only: clamped to the best bid / ask)
sigma = standard deviation of mid changes in bps per snapshot interval (EWMA of PAST changes), tau = a fixed
horizon in intervals, kappa = decay of the fill intensity with distance, FITTED on the first half of the recording
with the same fill rule and applied to the second half. FILLS ARE MODELLED, NOT OBSERVED: the recording has no
trade and no queue. Two deterministic rules bracket the truth: `cross` (pessimistic: a bid fills only if the next
snapshot's best ASK is at or below it) and `touch` (optimistic: it fills if the next snapshot's best BID is at or
below it, i.e. the market's best bid fell to our price — as if we were first in the queue).

cross_exchange_spread — for one underlying on two venues: the price difference, what part of it is a permanent
level (quote currency, index composition: not capturable) and what part deviates and reverts, against the cost of
a round trip on both venues. The output is an ESTIMATED NET EDGE in bps under stated assumptions, never a profit.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
from .data import load_candles
from .data.books import RECORD_VENUES, book_quality, depth_profile, load_books
from .data.core import DataError
from .data.multivenue import load_venue_funding
from .data.venues import venue
from .vol_forecast import daily_realised_variance, daily_returns, evaluate

SYMBOLS = ("BTC", "ETH", "SOL")


def _num(x):
    return None if x is None or not math.isfinite(float(x)) else float(x)


# ------------------------------------------------------------------------------------------------- book depth

def book_depth_study(root, venues=RECORD_VENUES, symbols=SYMBOLS, cadence_s: float = 5.0) -> dict:
    out: dict = {"cadence_s": cadence_s, "books": {}}
    for v in venues:
        for s in symbols:
            try:
                snaps = load_books(root, v, s)
            except DataError:
                continue
            q = book_quality(root, v, s, cadence_s)
            prof = depth_profile(snaps)
            mids = np.array([(x["bids"][0][0] + x["asks"][0][0]) / 2 for x in snaps])
            half = np.array([(x["asks"][0][0] - x["bids"][0][0]) / 2 for x in snaps]) / mids * 1e4
            out["books"][f"{v}/{s}"] = {
                **q, "half_spread_bps_median": _num(np.median(half)), "half_spread_bps_mean": _num(half.mean()),
                "half_spread_bps_p90": _num(np.percentile(half, 90)),
                "assumed_half_spread_bps": venue(v).default_half_spread_bps, "depth_profile": prof}
    out["statement"] = ("visible depth at the recording cadence over the recording window only: one short sample, "
                        "one time of day, no hidden liquidity, no trade. The assumed half spread is the venue "
                        "table's default used by the square-root slippage model when no profile is supplied.")
    return out


def book_calibration(root, cadence_s: float = 5.0) -> dict:
    """What the backtester reads from the recorded books (research/src/spq/params/book_calibration.json, COMMITTED so that
    a run is reproducible without the raw snapshots): per lab symbol, the measured half spread and the depth
    profile (cost of a market order of 100 ... 1 000 000 USD against the mid, median and 90th percentile)."""
    from .data.venues import lab_symbol

    out: dict = {"cadence_s": cadence_s, "instruments": {}}
    first, last = [], []
    root = Path(root)
    for path in sorted((root / "books").glob("*/*.jsonl")):
        v, s = path.parent.name, path.stem
        snaps = load_books(root, v, s)
        if len(snaps) < 100:
            continue
        q = book_quality(root, v, s, cadence_s)
        mids = np.array([(x["bids"][0][0] + x["asks"][0][0]) / 2 for x in snaps])
        half = np.array([(x["asks"][0][0] - x["bids"][0][0]) / 2 for x in snaps]) / mids * 1e4
        first.append(q["first"])
        last.append(q["last"])
        out["instruments"][lab_symbol(s, v)] = {
            "venue": v, "snapshots": int(len(snaps)), "errors": int(q["errors"]), "minutes": _num(q["minutes"]),
            "first": q["first"], "last": q["last"],
            "half_spread_bps_median": _num(round(float(np.median(half)), 4)),
            "half_spread_bps_p90": _num(round(float(np.percentile(half, 90)), 4)),
            "depth_profile": {k: ([None if x is None else round(x, 4) for x in val] if isinstance(val, list) else val)
                              for k, val in depth_profile(snaps).items()}}
    out["recorded"] = [min(first), max(last)] if first else None
    out["statement"] = ("measured on ONE short recording of the visible book (see `recorded`): one time of day, no "
                        "hidden liquidity, no trade. The backtester uses, per symbol, max(venue default half spread, "
                        "measured 90th percentile) as the half spread and the 90th-percentile depth curve as the cost "
                        "of an order; an order larger than the visible depth falls back to the square-root formula.")
    return out


# ------------------------------------------------------------------------------------------- market making (AS)

def as_quotes(q: float, sigma: float, gamma: float, kappa: float, tau: float, skew: bool = True):
    """(bid distance, ask distance) from the mid, in bps, both >= 0 after the caller's clamp to the book.
    q = inventory in lots (positive = long). Pure."""
    shift = q * gamma * sigma * sigma * tau if skew else 0.0
    half = gamma * sigma * sigma * tau / 2.0 + math.log(1.0 + gamma / kappa) / gamma
    return half + shift, half - shift


def _series(snaps):
    bid = np.array([s["bids"][0][0] for s in snaps])
    ask = np.array([s["asks"][0][0] for s in snaps])
    return bid, ask, (bid + ask) / 2.0


def fit_kappa(bid, ask, mid, rule: str, distances=(0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0)) -> dict:
    """Fill frequency per snapshot interval of a passive quote resting `d` bps from the mid, under the fill rule,
    both sides pooled; log-linear fit  P(fill) ~ A exp(-kappa d)  on the distances with at least 3 fills."""
    n = len(mid) - 1
    freq = []
    for d in distances:
        my_bid, my_ask = mid[:-1] * (1 - d / 1e4), mid[:-1] * (1 + d / 1e4)
        ok_b, ok_a = my_bid <= bid[:-1], my_ask >= ask[:-1]           # post-only: not inside the book
        if rule == "cross":
            fb, fa = ask[1:] <= my_bid, bid[1:] >= my_ask
        else:
            fb, fa = bid[1:] <= my_bid, ask[1:] >= my_ask
        hits, tries = int((fb & ok_b).sum() + (fa & ok_a).sum()), int(ok_b.sum() + ok_a.sum())
        freq.append((d, hits, tries))
    pts = [(d, h / t) for d, h, t in freq if h >= 3 and t > 0]
    out = {"rule": rule, "intervals": int(n), "frequencies": [{"distance_bps": d, "fills": h, "quotes": t} for d, h, t in freq]}
    if len(pts) < 2:
        return {**out, "kappa": None, "A": None}
    x, y = np.array([p[0] for p in pts]), np.log(np.array([p[1] for p in pts]))
    slope, intercept = np.polyfit(x, y, 1)
    return {**out, "kappa": _num(-slope) if slope < 0 else None, "A": _num(math.exp(intercept))}


def simulate_mm(bid, ask, mid, *, rule: str, gamma: float, kappa: float, tau: float, maker_bps: float,
                order_usd: float = 1000.0, max_lots: int = 5, skew: bool = True, ewma: float = 0.97,
                warmup: int = 30) -> dict:
    """Replay the quoting policy on snapshots. Inventory in lots of `order_usd`; quotes are refreshed at every
    snapshot and live until the next one. Returns PnL and inventory statistics; everything about fills is a model."""
    n = len(mid)
    var = 0.0
    q, cash, inv_units, fees = 0, 0.0, 0.0, 0.0
    fills, captured, inv_path, markout = 0, [], [], {1: [], 6: [], 12: []}
    for t in range(1, n - 1):
        change = (mid[t] / mid[t - 1] - 1.0) * 1e4
        var = ewma * var + (1 - ewma) * change * change
        inv_path.append(q)
        if t < warmup:
            continue
        sigma = math.sqrt(var)
        d_bid, d_ask = as_quotes(q, sigma, gamma, kappa, tau, skew)
        my_bid = min(mid[t] * (1 - d_bid / 1e4), bid[t])              # post-only
        my_ask = max(mid[t] * (1 + d_ask / 1e4), ask[t])
        hit_bid = (ask[t + 1] <= my_bid) if rule == "cross" else (bid[t + 1] <= my_bid)
        hit_ask = (bid[t + 1] >= my_ask) if rule == "cross" else (ask[t + 1] >= my_ask)
        for side, hit, px in ((1, hit_bid and q < max_lots, my_bid), (-1, hit_ask and q > -max_lots, my_ask)):
            if not hit:
                continue
            units = order_usd / px
            cash -= side * units * px
            inv_units += side * units
            fees += order_usd * maker_bps / 1e4
            q += side
            fills += 1
            captured.append(side * (mid[t] - px) / mid[t] * 1e4)
            for h in markout:
                if t + h < n:
                    markout[h].append(side * (mid[t + h] - px) / px * 1e4)
    pnl = cash + inv_units * mid[-1] - fees
    inv = np.array(inv_path, dtype="float64")
    return {
        "rule": rule, "skew": skew, "fills": int(fills), "traded_usd": float(fills * order_usd),
        "pnl_usd": _num(pnl), "fees_usd": _num(fees), "pnl_before_fees_usd": _num(pnl + fees),
        "pnl_bps_of_traded": _num(pnl / (fills * order_usd) * 1e4) if fills else None,
        "spread_captured_bps_mean": _num(np.mean(captured)) if captured else None,
        "markout_bps_mean": {f"{h}_intervals": _num(np.mean(v)) if v else None for h, v in markout.items()},
        "final_inventory_lots": int(q), "inventory_abs_mean": _num(np.abs(inv).mean()) if len(inv) else 0.0,
        "inventory_abs_max": _num(np.abs(inv).max()) if len(inv) else 0.0,
        "inventory_std": _num(inv.std()) if len(inv) else 0.0,
    }


def market_making_study(root, venues=("hyperliquid", "edgex"), symbols=SYMBOLS, *, gamma: float = 0.1,
                        tau: float = 12.0, order_usd: float = 1000.0, cadence_s: float = 5.0) -> dict:
    """gamma and tau are fixed BEFORE looking at any result (risk aversion per lot, one-minute horizon at a 5 s
    cadence); kappa is fitted on the first half of each recording and the policy is replayed on the second half."""
    out: dict = {"parameters": {"gamma": gamma, "tau_intervals": tau, "order_usd": order_usd, "max_lots": 5,
                                "sigma": "EWMA(0.97) of squared mid changes in bps per interval, past only"},
                 "fills_are_modelled": True, "runs": {}}
    for v in venues:
        for s in symbols:
            try:
                snaps = load_books(root, v, s)
            except DataError:
                continue
            if len(snaps) < 200:
                continue
            bid, ask, mid = _series(snaps)
            half = len(mid) // 2
            q = book_quality(root, v, s, cadence_s)
            run = {"snapshots": len(snaps), "minutes": q.get("minutes"), "calibration_snapshots": half,
                   "evaluation_snapshots": len(mid) - half, "maker_fee_bps": venue(v).maker_bps,
                   "mid_change_bps_std": _num(np.std(np.diff(mid) / mid[:-1] * 1e4)), "by_rule": {}}
            for rule in ("cross", "touch"):
                fit = fit_kappa(bid[:half], ask[:half], mid[:half], rule)
                res = {"calibration": fit}
                if fit["kappa"] is not None:
                    kw = dict(rule=rule, gamma=gamma, kappa=fit["kappa"], tau=tau, maker_bps=venue(v).maker_bps,
                              order_usd=order_usd)
                    res["avellaneda_stoikov"] = simulate_mm(bid[half:], ask[half:], mid[half:], skew=True, **kw)
                    res["symmetric_baseline"] = simulate_mm(bid[half:], ask[half:], mid[half:], skew=False, **kw)
                else:
                    res["note"] = "too few modelled fills in the calibration half to fit kappa: no simulation"
                run["by_rule"][rule] = res
            out["runs"][f"{v}/{s}"] = run
    out["statement"] = (
        "MODEL STUDY on one short recording (minutes, see each run): far too short for any conclusion about "
        "profitability, one time of day, one volatility regime. No trade and no queue position was observed: a "
        "fill is a rule applied to two consecutive snapshots. `cross` under-counts fills (a quote can trade without "
        "the opposite best price reaching it between two snapshots) and `touch` over-counts them (it assumes the "
        "front of the queue). Fills at the snapshot cadence ignore everything that happens between snapshots. "
        "Maker fees are the venue table's base tier; no rebate. Nothing here can be executed by the wallet today: "
        "the agent path has no resting orders.")
    return out


# --------------------------------------------------------------------------------------- cross-exchange spread

def _half_life(x: np.ndarray) -> float | None:
    a, b = x[:-1] - x[:-1].mean(), x[1:] - x[1:].mean()
    den = float(a @ a)
    if not den > 0:
        return None
    phi = float(a @ b) / den
    return float(-math.log(2.0) / math.log(phi)) if 0 < phi < 1 else None


def round_trip_cost_bps(va: str, vb: str, latency_bps: float) -> dict:
    """Open and close one leg on each venue with market orders: 2 fills per venue."""
    a, b = venue(va), venue(vb)
    fees = 2 * (a.taker_bps + b.taker_bps)
    spread = 2 * (a.default_half_spread_bps + b.default_half_spread_bps)
    return {"taker_fees_bps": fees, "half_spreads_bps": spread, "latency_allowance_bps": 4 * latency_bps,
            "total_bps": fees + spread + 4 * latency_bps}


def cross_exchange_study(root, symbols=SYMBOLS, pairs=(("hyperliquid", "edgex"), ("hyperliquid", "dydx"),
                                                       ("edgex", "dydx"), ("hyperliquid", "gmx")),
                         interval: str = "1h", level_window: int = 168, latency_bps: float = 1.0) -> dict:
    out: dict = {"interval": interval, "level_window_bars": level_window, "bars": {}, "books": {},
                 "assumptions": [
                     "capital is ALREADY on both venues (no transfer during the trade; a transfer between venues takes "
                     "minutes to hours and costs gas and bridge fees that are not modelled)",
                     "the trade is a convergence trade: buy the cheap venue, sell the rich one, close both when the "
                     "deviation is gone; the PERMANENT part of the price difference (rolling median: quote currency, "
                     "index composition) is not capturable and is removed",
                     "costs: taker fee on 2 fills per venue, half spread on each fill (venue table defaults), and "
                     f"{latency_bps:g} bps per fill of latency allowance; funding differential over the holding time "
                     "is reported separately and is NOT netted (its sign depends on the direction held)",
                     "bar closes are the LAST TRADE of each venue inside the same hour, not simultaneous prices: a "
                     "deviation between two closes is partly asynchrony and is NOT executable; GMX candles are oracle "
                     "prices, not quotes. The book section uses near-simultaneous recorded quotes (bid on one venue, "
                     "ask on the other) and is the only executable-price evidence here — on one short recording"]}
    for s in symbols:
        for va, vb in pairs:
            try:
                a, _ = load_candles(s, interval, root=root, source=va)
                b, _ = load_candles(s, interval, root=root, source=vb)
            except DataError:
                continue
            idx = a.index.intersection(b.index)
            if len(idx) < 2 * level_window:
                continue
            spread = (b.loc[idx, "close"] / a.loc[idx, "close"] - 1.0) * 1e4
            level = spread.rolling(level_window).median().shift(1)        # past bars only
            dev = (spread - level).dropna()
            cost = round_trip_cost_bps(va, vb, latency_bps)
            edge = dev.abs() - cost["total_bps"]
            fd = None
            try:
                fa, _ = load_venue_funding(s, va, idx[0], None, root=root)
                fb, _ = load_venue_funding(s, vb, idx[0], None, root=root)
                ha = fa["rate"].mean() / (venue(va).funding_interval_s / 3600.0)
                hb = fb["rate"].mean() / (venue(vb).funding_interval_s / 3600.0)
                fd = {"mean_rate_per_hour_a": _num(ha), "mean_rate_per_hour_b": _num(hb),
                      "abs_differential_bps_per_day": _num(abs(ha - hb) * 24 * 1e4)}
            except DataError:
                pass
            hl = _half_life(dev.to_numpy())
            pos = edge[edge > 0]
            out["bars"][f"{s}: {vb} vs {va}"] = {
                "common_bars": int(len(idx)), "evaluated_bars": int(len(dev)),
                "level_bps_median": _num(spread.median()), "deviation_abs_bps_median": _num(dev.abs().median()),
                "deviation_abs_bps_p95": _num(dev.abs().quantile(0.95)), "deviation_abs_bps_max": _num(dev.abs().max()),
                "deviation_half_life_bars": _num(hl) if hl is not None else None,
                "round_trip_cost": cost,
                "bars_with_estimated_net_edge_above_zero": int(len(pos)),
                "share_of_bars_with_estimated_net_edge_above_zero": _num(len(pos) / len(dev)),
                "estimated_net_edge_bps_when_positive_median": _num(pos.median()) if len(pos) else None,
                "estimated_net_edge_bps_max": _num(edge.max()),
                "funding": fd,
            }
    for s in symbols:
        for va, vb in pairs:
            try:
                A, B = load_books(root, va, s), load_books(root, vb, s)
            except DataError:
                continue
            ta = np.array([x["captured_ms"] for x in A])
            rows = []
            for y in B:
                i = int(np.searchsorted(ta, y["captured_ms"]))
                cands = [j for j in (i - 1, i) if 0 <= j < len(A)]
                if not cands:
                    continue
                j = min(cands, key=lambda j: abs(int(ta[j]) - y["captured_ms"]))
                gap = abs(int(ta[j]) - y["captured_ms"])
                if gap > 2000:
                    continue
                x = A[j]
                rows.append((gap, (y["bids"][0][0] / x["asks"][0][0] - 1) * 1e4, (x["bids"][0][0] / y["asks"][0][0] - 1) * 1e4,
                             ((y["bids"][0][0] + y["asks"][0][0]) / (x["bids"][0][0] + x["asks"][0][0]) - 1) * 1e4))
            if len(rows) < 100:
                continue
            r = np.array(rows)
            mid_level = float(np.median(r[:, 3]))
            fees = venue(va).taker_bps + venue(vb).taker_bps                       # entry only: 1 fill per venue
            buy_a = r[:, 1] - mid_level - fees        # buy A at its ask, sell B at its bid, net of the permanent level
            buy_b = r[:, 2] + mid_level - fees
            best = np.maximum(buy_a, buy_b)
            out["books"][f"{s}: {vb} vs {va}"] = {
                "paired_snapshots": int(len(r)), "max_capture_gap_ms": int(r[:, 0].max()),
                "mid_level_bps_median": _num(mid_level),
                "executable_entry_edge_bps_after_taker_fees": {
                    "median": _num(np.median(best)), "p95": _num(np.percentile(best, 95)), "max": _num(best.max()),
                    "share_above_zero": _num((best > 0).mean()),
                    "share_above_exit_cost": _num((best > fees + venue(va).default_half_spread_bps + venue(vb).default_half_spread_bps).mean())},
                "statement": "entry edge = bid on the rich venue / ask on the cheap venue - 1, minus the median mid "
                             "difference (permanent level) and one taker fee per venue. A positive value still has to "
                             "pay the exit (another taker fee and spread per venue): see share_above_exit_cost"}
    return out


# ------------------------------------------------------------------------------------------------ vol forecast

def vol_forecast_study(root, symbols=SYMBOLS, source: str = "hyperliquid", interval: str = "1h") -> dict:
    out: dict = {"source": source, "interval": interval, "target": "next UTC day's realised variance (sum of squared "
                 "hourly log returns)", "symbols": {}}
    for s in symbols:
        try:
            df, _ = load_candles(s, interval, root=root, source=source)
        except DataError:
            continue
        rv, rets = daily_realised_variance(df["close"]), daily_returns(df["close"])
        res = evaluate(rv, rets)
        res["days_of_realised_variance"] = int(len(rv))
        res["annualised_volatility_mean"] = _num(math.sqrt(float(rv.mean()) * 365.0))
        out["symbols"][s] = res
    out["statement"] = ("one-day-ahead forecasts on an expanding window; about six months of data, so a few dozen "
                        "forecast days per split: differences between models are indicative only. QLIKE and MSE are "
                        "computed against realised variance from hourly returns, itself a noisy proxy.")
    return out


STUDIES = {"book_depth": book_depth_study, "book_calibration": book_calibration, "market_making_as": market_making_study,
           "cross_exchange_spread": cross_exchange_study, "vol_forecast": vol_forecast_study}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m spq study")
    p.add_argument("name", choices=sorted(STUDIES))
    p.add_argument("--root", default="data")
    p.add_argument("--out", required=True, help="directory: <out>/<name>.json is written")
    a = p.parse_args(argv)
    res = STUDIES[a.name](a.root)
    path = Path(a.out) / f"{a.name}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(res, indent=1, allow_nan=False) + "\n")
    print(json.dumps({"written": str(path)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
