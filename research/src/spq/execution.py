# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/src/spq/execution.py
# Description      : Execution realism (V11): latency, size-dependent slippage,
#                    per-venue fees and accounts, and ENGINE PARITY.
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

"""Execution realism (V11): latency, size-dependent slippage, per-venue fees and accounts, and ENGINE PARITY.

Nothing here runs unless a backtest config carries an `ExecutionModel` (and a parity object): without them the
engines behave exactly as before V11 (fill at the next open, constant slippage, one pooled account) and the
version-1 / version-2 reports are unchanged. Definitions, sources and limits: docs/TRADING-BACKTESTING.md.

LATENCY ("adverse_bound"). A decision is taken on a bar's close; the live engine's loop passes once per minute, so
the order reaches the venue up to `latency_s` after the close, i.e. INSIDE the next bar. Bar data do not say where
the price was at open + delay. The model fills a buy at open + f x (high - open) and a sell at
open - f x (open - low), with f = min(1, sqrt(delay / bar length)): the square-root-of-time share of the bar's
adverse excursion, never beyond the bar's own extreme. It is a BOUND, always against the order — a real fill is
sometimes better. The k-th exposure-adding order of a decision is delayed by k more `order_spacing_s` (the live
engine sends one exposure-adding order per pass). `latency_s = 0` with `latency_model = "next_open"` is the old model.

SLIPPAGE ("sqrt_impact"). cost_bps = half_spread_bps + Y x sigma_bar x sqrt(Q / V_bar) x 1e4, with Q the order's
notional, sigma_bar the standard deviation of the last `impact_window_bars` bar returns and V_bar the mean USD
volume per bar over the same window, both ending at the bar BEFORE the fill. This is the square-root law of market
impact (Almgren, Thum, Hauptmann & Li 2005; Toth et al. 2011, Y of order one); "calibrated from bar volume" means
exactly this: the bar's own volume is the liquidity proxy, nothing is fitted to fills (the lab has none). A symbol
without volume data pays `max_impact_bps`. With `book_profiles` (spq.data.books.depth_profile of RECORDED order
books) the cost is read on the measured depth curve instead, never below the half spread.

ACCOUNTS. With `accounts = "per_venue"` every venue is its own cross-margin account with its own collateral
(`capital_split`, default equal shares): profit on one venue cannot margin a loss on another, there is no transfer.
"""
from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

PARITY_PATH = Path(__file__).resolve().parent / "params" / "engine-parity.json"


@dataclass(frozen=True)
class ExecutionModel:
    latency_s: float = 60.0
    latency_model: str = "adverse_bound"          # or "next_open"
    order_spacing_s: float = 60.0                 # delay added per earlier exposure-adding order of the same decision
    slippage_model: str = "sqrt_impact"           # or "constant" (config.slippage_bps)
    impact_coefficient: float = 1.0               # Y
    impact_window_bars: int = 24
    max_impact_bps: float = 100.0
    half_spread_bps: dict = field(default_factory=dict)   # per symbol; default: the venue table
    book_profiles: dict = field(default_factory=dict)     # per symbol: spq.data.books.depth_profile(...)
    book_quantile: str = "p90_bps"
    venue_fees: bool = True                       # fees per venue from spq.data.venues (taker or maker: config.liquidity)
    accounts: str = "per_venue"                   # or "pooled" (one account, as before V11)
    capital_split: dict = field(default_factory=dict)     # venue -> share of the initial cash (default: equal)
    calibration: str = ""                         # where half_spread_bps / book_profiles come from (for the report)

    def __post_init__(self):
        if self.latency_model not in ("adverse_bound", "next_open"):
            raise ValueError("latency_model must be 'adverse_bound' or 'next_open'")
        if self.slippage_model not in ("sqrt_impact", "constant"):
            raise ValueError("slippage_model must be 'sqrt_impact' or 'constant'")
        if self.accounts not in ("per_venue", "pooled"):
            raise ValueError("accounts must be 'per_venue' or 'pooled'")
        if self.latency_s < 0 or self.order_spacing_s < 0 or self.impact_coefficient < 0 or self.max_impact_bps < 0:
            raise ValueError("latency, spacing, impact coefficient and impact cap must be >= 0")
        if self.latency_model == "next_open" and self.latency_s != 0:
            raise ValueError("latency_model 'next_open' means latency_s = 0")
        if int(self.impact_window_bars) < 2:
            raise ValueError("impact_window_bars must be at least 2")
        if self.capital_split and (any(v <= 0 for v in self.capital_split.values())
                                   or abs(sum(self.capital_split.values()) - 1.0) > 1e-9):
            raise ValueError("capital_split must be positive shares summing to 1")

    def latency_fraction(self, delay_s: float, bar_s: float) -> float:
        if self.latency_model == "next_open" or delay_s <= 0:
            return 0.0
        return min(1.0, math.sqrt(delay_s / bar_s))

    def to_dict(self) -> dict:
        d = asdict(self)
        d["book_profiles"] = {s: {"n_snapshots": p.get("n_snapshots"), "notionals": p.get("notionals"),
                                  self.book_quantile: p.get(self.book_quantile)} for s, p in self.book_profiles.items()}
        return d


def impact_inputs(closes: np.ndarray, volumes: np.ndarray, window: int) -> tuple[np.ndarray, np.ndarray]:
    """(sigma, usd_volume) per bar and symbol, each computed on the `window` bars ENDING AT THE PREVIOUS BAR (so the
    fill of bar i only uses bars < i). sigma is NaN until two returns exist; usd_volume is NaN without history."""
    n, k = closes.shape
    sigma = np.full((n, k), np.nan)
    vol = np.full((n, k), np.nan)
    with np.errstate(divide="ignore", invalid="ignore"):
        r = np.diff(np.log(closes), axis=0)                      # r[t] = return of bar t+1
    usd = closes * volumes
    for i in range(1, n):
        lo = max(0, i - window)
        vol[i] = usd[lo:i].mean(axis=0)
        rr = r[max(0, i - 1 - window):i - 1]
        if len(rr) >= 2:
            sigma[i] = rr.std(axis=0, ddof=1)
    return sigma, vol


def sqrt_impact_bps(notional: float, sigma: float, usd_volume: float, coefficient: float, cap_bps: float) -> float:
    """Y x sigma x sqrt(Q / V) in bps, capped; the cap when sigma or volume is unknown or zero."""
    if not (math.isfinite(sigma) and math.isfinite(usd_volume)) or usd_volume <= 0 or sigma < 0:
        return float(cap_bps)
    return float(min(cap_bps, coefficient * sigma * math.sqrt(max(notional, 0.0) / usd_volume) * 1e4))


# ------------------------------------------------------------------------------------------------ engine parity

@dataclass(frozen=True)
class PerpParity:
    """Defaults of the live perp engine (research/src/spq/params/engine-parity.json, section "perp")."""

    max_leverage: float
    max_gross_exposure_x: float
    max_position_x: float
    max_daily_loss_pct: float
    max_total_loss_pct: float
    slippage_bps: float
    min_trade_pct: float
    leverage_headroom: float
    cap_headroom: float
    min_notional_factor: float
    loop_period_s: float
    live_cooldown_s: float
    max_orders_per_minute: int
    max_orders_per_day: int

    def scale(self, weights: dict, equity: float, capital: float) -> tuple[dict, float, str]:
        """services/api/src/agents/perp-engine.ts scalePerpWeights: ONE factor <= 1 for all weights together."""
        if not equity > 0:
            return {s: 0.0 for s in weights}, 0.0, "no_equity"
        gross = math.fsum(abs(w) for w in weights.values())
        largest = max((abs(w) for w in weights.values()), default=0.0)
        if gross == 0:
            return dict(weights), 1.0, "none"
        h = 1.0 - self.cap_headroom - self.slippage_bps / 1e4
        caps = [(self.max_leverage * equity * self.leverage_headroom, gross * equity, "leverage"),
                (self.max_gross_exposure_x * capital * h, gross * equity, "gross"),
                (self.max_position_x * capital * h, largest * equity, "position")]
        factor, binding = 1.0, "none"
        for cap, wanted, name in caps:
            if wanted <= cap:
                continue
            f = math.floor(cap / wanted * 1e12) / 1e12            # the engine divides at 12 decimals, rounding down
            if f < factor:
                factor, binding = f, name
        return {s: w * factor for s, w in weights.items()}, factor, binding

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class SpotParity:
    """Defaults of the live spot (vault) engine (section "spot")."""

    max_exposure_pct: float
    max_loss_pct: float
    max_order_usd: float
    max_daily_usd: float
    max_orders_per_day: int
    slippage_bps: float
    min_trade_usd: float
    min_trade_fraction: float
    live_orders_per_pass: int
    loop_period_s: float

    def to_dict(self) -> dict:
        return asdict(self)


CALIBRATION_PATH = PARITY_PATH.parent / "book_calibration.json"


def calibrated_execution(symbols, path=None, **kwargs) -> ExecutionModel:
    """The default ExecutionModel with, for every symbol that was recorded, the measured half spread (never under
    the venue table's default) and the recorded depth profile. Without the calibration file: the plain default."""
    from .data.venues import split_symbol, venue

    path = Path(path or CALIBRATION_PATH)
    if not path.exists():
        return ExecutionModel(**kwargs)
    cal = json.loads(path.read_text())
    half, profiles = {}, {}
    for s in symbols:
        c = cal["instruments"].get(s)
        if c is None:
            continue
        half[s] = max(float(venue(split_symbol(s)[1]).default_half_spread_bps), float(c["half_spread_bps_p90"]))
        profiles[s] = c["depth_profile"]
    rec = cal.get("recorded") or ["?", "?"]
    return ExecutionModel(half_spread_bps=half, book_profiles=profiles,
                          calibration=f"research/src/spq/params/{path.name}: order books recorded {rec[0]} to {rec[1]}, "
                                      f"{len(profiles)} of {len(list(symbols))} symbols", **kwargs)


def read_parity(path=None) -> dict:
    return json.loads(Path(path or PARITY_PATH).read_text())


def load_parity(path=None) -> tuple[PerpParity, SpotParity, dict]:
    """(perp rules, spot rules, the raw file with provenance) from the ONE shared parameter file."""
    raw = read_parity(path)
    perp = PerpParity(**{k: v["value"] for k, v in raw["perp"].items()})
    spot = SpotParity(**{k: v["value"] for k, v in raw["spot"].items()})
    return perp, spot, raw


def parity_report(raw: dict, section: str) -> dict:
    """What a report prints: every value with its file:line and its rule."""
    return {"file": "research/src/spq/params/engine-parity.json", "checked_against_commit": raw["checked_against_commit"],
            "checked": raw["checked"],
            "parameters": {k: {"value": v["value"], "source": v["source"], "rule": v["rule"]}
                           for k, v in raw[section].items()}}
