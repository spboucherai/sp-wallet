# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/src/spq/perp_engine.py
# Description      : Event-driven backtester for perpetual futures: one
#                    cross-margin account in USDC, long and short, leverage,
#                    funding, maintenance margin and liquidation.
# Module           : spq
# Repository       : https://git.spboucher.ai/sp-wallet
# Project Website  : https://wallet.spboucher.ai
# Created          : 2026-11-10
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

"""Event-driven backtester for perpetual futures: one cross-margin account in USDC, long and short, leverage,
funding, maintenance margin and liquidation. Model, formulas, sources and simplifications: docs/v4/quant-perps.md.

Timeline of bar i (it opens at ts[i]; the decision bar is i-1):

    open of bar i    1. FUNDING. Every settlement dated in (ts[i-1], ts[i]] is paid on the position held coming into
                        the bar: amount = -signed size x reference price x rate (a positive rate is paid by longs).
                        Reference price: the `index` column (last value known before the bar) when the data have
                        one, else open[i] of the perpetual.
                     2. GAP CHECK. If margin equity < maintenance margin at open[i], the account is liquidated at
                        the open.
                     3. FILL. The weights decided on the close of bar i-1 are traded at open[i]: taker fee on the
                        traded notional and slippage in bps, both charged to the collateral. Orders that reduce a
                        position are always executed; orders that add exposure must fit in the free collateral
                        (initial margin = notional / leverage for a perpetual, full payment for a spot leg) and are
                        otherwise CUT pro rata, or refused when the cut order is below the minimum order.
    inside bar i     4. LIQUIDATION. With every long at the bar's low and every short at its high (taken together:
                        the worst case), if margin equity <= maintenance margin, the whole account is liquidated at
                        the prices where the two are equal, pays the taker fee and a penalty on the notional, and
                        the fills are flagged `liquidation` in the trade log.
    close of bar i   5. Mark to market (the `mark` column when the data have one, else the close) -> equity[i].
                        Equity <= 0 marks the run WIPED OUT: positions are closed, the debt is written off
                        (reported, not hidden), equity stays at 0 and nothing trades any more.
                     6. DECISION. The strategy sees bars <= i (at most `lookback`), every column of them — funding
                        settled at or before ts[i] included — and returns target weights for the open of bar i+1.

Weights are fractions of account equity: +0.5 = long for half the equity, -2 = short for twice the equity.
The size is computed at the fill from the equity at that open, truncated to the venue's lot.

Money is exact. The ledger (collateral, realised PnL, funding, fees, slippage, penalties) is `decimal.Decimal`
arithmetic in a context that raises on any rounding; the only rounded quantities are the average entry price
(18 decimals, half-even) and the order sizes (truncated to the lot), as in packages/derivatives/src/margin.ts.
Floats are used for the strategy's inputs and for statistics only. The identity

    final equity = initial + sum(realised PnL) + sum(funding) - sum(fees) - sum(slippage)
                   + unrealised PnL of the positions still open + debt written off (0 unless wiped out)

holds to the last digit and is checked on every run (`PerpResult.ledger["reconciles"]`).
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field, replace
from decimal import Decimal
from fractions import Fraction
from typing import Callable

import numpy as np
import pandas as pd

from .data.books import profile_cost_bps
from .data.core import DataError, interval_seconds, to_utc
from .data.venues import split_symbol, venue
from .engine import check_aligned
from .execution import impact_inputs, sqrt_impact_bps
from .margin import (CALC_SCALE, ONE, ZERO, Position, apply_order_to_position, dec, div, exact, initial_margin,
                     liquidation_price_cross, quantize_down, signed_size)
from .strategy import Strategy, is_spot_leg, validate_perp_weights

if int(pd.__version__.split(".")[0]) < 3:  # pragma: no cover
    pd.options.mode.copy_on_write = True

#: Hyperliquid, base tier, checked 2026-11-10 (docs/v4/venues/contract-differences.md)
HL_TAKER_BPS = 4.5
HL_MAKER_BPS = 1.5
HL_MIN_ORDER = 10.0


@dataclass(frozen=True)
class PerpConfig:
    interval: str
    taker_fee_bps: float = HL_TAKER_BPS
    maker_fee_bps: float = HL_MAKER_BPS
    liquidity: str = "taker"               # which fee the fills pay; 'maker' is an optimistic what-if
    slippage_bps: float = 2.0              # on traded notional, against the order
    initial_cash: float = 1000.0           # USDC collateral
    min_order: float = HL_MIN_ORDER        # USD notional; smaller orders are not sent (a full exit always is)
    rebalance_threshold: float = 0.0       # weight distance under which a position is left alone
    decision_every: int = 1
    leverage: float | None = None          # account leverage setting; None = META['max_leverage'] (1 for spot METAs)
    venue_max_leverage: dict = field(default_factory=dict)   # per symbol, e.g. {"BTC": 40}
    default_venue_max_leverage: float = 10.0
    maintenance_fraction: float | None = None   # None = 1 / (2 x venue max leverage), Hyperliquid's rule
    liquidation_penalty_bps: float = 100.0      # of the liquidated notional, on top of the taker fee
    size_decimals: dict = field(default_factory=dict)        # per symbol lot = 10^-decimals
    default_size_decimals: int = 6
    spot_fee_bps: float = 10.0             # spot legs ('X.SPOT')
    spot_slippage_bps: float = 10.0
    # ---- v11 (docs/TRADING-BACKTESTING.md). None = the pre-v11 model, bit for bit.
    execution: object | None = None        # spq.execution.ExecutionModel: latency, slippage, venue fees and accounts
    parity: object | None = None           # spq.execution.PerpParity: the live engine's sizing and stop rules

    def __post_init__(self):
        interval_seconds(self.interval)
        costs = (self.taker_fee_bps, self.slippage_bps, self.liquidation_penalty_bps, self.spot_fee_bps,
                 self.spot_slippage_bps)
        if any(c < 0 for c in costs) or self.slippage_bps >= 10_000 or self.spot_slippage_bps >= 10_000:
            raise ValueError("fees, slippage and penalty must be >= 0 (slippage < 10000 bps)")
        if self.liquidity not in ("taker", "maker"):
            raise ValueError("liquidity must be 'taker' or 'maker'")
        if self.initial_cash <= 0 or self.min_order < 0 or not 0 <= self.rebalance_threshold:
            raise ValueError("initial_cash > 0, min_order >= 0 and rebalance_threshold >= 0 are required")
        if int(self.decision_every) != self.decision_every or self.decision_every < 1:
            raise ValueError("decision_every must be a positive integer")
        if self.leverage is not None and not self.leverage > 0:
            raise ValueError("leverage must be positive")
        if self.maintenance_fraction is not None and not 0 <= self.maintenance_fraction < 1:
            raise ValueError("maintenance_fraction must be in [0, 1)")
        if self.default_venue_max_leverage <= 0 or any(v <= 0 for v in self.venue_max_leverage.values()):
            raise ValueError("venue max leverage must be positive")

    @property
    def fee_bps(self) -> float:
        """The fee actually charged on perpetual fills (v1 report key)."""
        return self.taker_fee_bps if self.liquidity == "taker" else self.maker_fee_bps

    def venue_leverage(self, symbol: str) -> float:
        return float(self.venue_max_leverage.get(symbol, self.default_venue_max_leverage))

    def maintenance(self, symbol: str) -> float:
        if self.maintenance_fraction is not None:
            return float(self.maintenance_fraction)
        return 1.0 / (2.0 * self.venue_leverage(symbol))

    def to_dict(self) -> dict:
        d = asdict(replace(self, execution=None, parity=None))
        d["execution"] = self.execution.to_dict() if self.execution is not None else None
        d["parity"] = self.parity.to_dict() if self.parity is not None else None
        return d


TRADE_COLUMNS = ["ts", "decided_at", "symbol", "side", "size", "price", "fill_price", "notional", "fee", "slippage",
                 "realised_pnl", "kind", "liquidation", "penalty", "position_after", "cut", "latency", "account"]
FUNDING_COLUMNS = ["ts", "symbol", "rate", "size", "price", "amount"]
_FLATTEN = "flatten"


@dataclass
class PerpResult:
    """Series are indexed by bar-open time and valued at that bar's CLOSE. Money columns of `trades` and `funding`
    hold `Decimal` objects (exact); the series are floats (statistics)."""

    symbols: list[str]
    config: PerpConfig
    equity: pd.Series
    cash: pd.Series              # collateral: initial + realised + funding - fees - slippage (unrealised excluded)
    exposure: pd.Series          # gross exposure / equity (v1 name; the spot engine's "invested fraction")
    long_exposure: pd.Series     # long notional / equity
    short_exposure: pd.Series    # short notional / equity (positive number)
    margin_utilisation: pd.Series  # initial margin in use / margin equity
    worst_equity: pd.Series      # equity with every long at the bar's low and every short at its high
    weights: pd.DataFrame        # signed notional / equity per symbol at each close
    decisions: pd.DataFrame
    trades: pd.DataFrame
    funding: pd.DataFrame
    open_positions: list[dict]
    liquidations: list[dict]
    wiped_out: bool
    wiped_out_at: pd.Timestamp | None
    ledger: dict
    counters: dict
    # ---- v11 (None / empty unless the config carries an ExecutionModel or a parity object)
    stop: dict | None = None                       # engine parity: why and when the agent was stopped
    accounts: list | None = None                   # account (venue) names
    account_margin_equity: pd.DataFrame | None = None       # per account, at each close
    account_margin_utilisation: pd.DataFrame | None = None  # initial margin in use / margin equity, per account
    cost_curve: pd.DataFrame | None = None         # cumulative fees, slippage, latency, funding at each close

    @property
    def returns(self) -> pd.Series:
        r = self.equity.pct_change().iloc[1:]
        return r.replace([np.inf, -np.inf], np.nan).fillna(0.0) if self.wiped_out else r

    @property
    def net_exposure(self) -> pd.Series:
        return self.long_exposure - self.short_exposure


def _frac_to_dec(x: Fraction, mode: str) -> Decimal:
    return div(Decimal(x.numerator), Decimal(x.denominator), CALC_SCALE, mode)


def run_perp_backtest(
    strategy: Strategy | Callable,
    data: dict[str, pd.DataFrame],
    config: PerpConfig,
    *,
    start=None,
    end=None,
    params: dict | None = None,
    lookback: int | None = None,
) -> PerpResult:
    """Simulate `strategy` on the bars with start <= ts < end (same calling convention as engine.run_backtest).

    `data[symbol]` is an OHLCV frame; a perpetual's frame may also carry `funding` (sum of the rates settled in
    (ts[i-1], ts[i]], NaN when the venue has no record), `premium`, `index` and `mark`. A symbol ending in '.SPOT'
    is a spot leg: bought with collateral, long only, no funding, never liquidated, not counted as margin.
    `strategy` is a loaded Strategy or a callable view -> weights | None (None = leave the account as it is).

    V11 (config.execution / config.parity, see spq.execution; without them nothing below changes anything):
    latency and size-dependent slippage on every fill, fees per venue, ONE ACCOUNT PER VENUE (symbol 'BTC@EDGEX' is
    the edgeX account, 'BTC.SPOT' the spot account) each with its own collateral, margin check and liquidation, and
    the live engine's sizing and stop rules (weights scaled by the owner's default caps, minimum trade, loss
    limits: flatten at the next open, then no further decision).
    """
    if not isinstance(config, PerpConfig):
        raise TypeError("run_perp_backtest needs a PerpConfig")
    index = check_aligned(data)
    symbols = list(data.keys())
    k = len(symbols)
    spot = [is_spot_leg(s) for s in symbols]
    if all(spot):
        raise DataError("no perpetual among the symbols")
    step = interval_seconds(config.interval)
    ex, par = config.execution, config.parity
    a = 0 if start is None else int(index.searchsorted(to_utc(start), side="left"))
    b = len(index) if end is None else int(index.searchsorted(to_utc(end), side="left"))
    if b - a < 2:
        raise DataError("the backtest window needs at least two bars")

    if isinstance(strategy, Strategy):
        lb = strategy.lookback if lookback is None else lookback
        account_lev = config.leverage or (float(strategy.meta["max_leverage"]) if strategy.kind == "perp" else 1.0)

        def decide(view):
            return strategy(view, params)
    else:
        lb = lookback or 1
        account_lev = config.leverage or 1.0
        n_perp = k - sum(spot)

        def decide(view):
            w = strategy(view)
            return None if w is None else validate_perp_weights(w, symbols, account_lev, account_lev * n_perp + sum(spot))
    if par is not None:                                  # the engine's leverage setting, not the strategy's bound
        order_lev = float(par.max_leverage)
    else:
        order_lev = account_lev

    frames = [data[s] for s in symbols]
    cols = {c: np.column_stack([df[c].to_numpy(dtype="float64") for df in frames])
            for c in ("open", "high", "low", "close")}
    opens, highs, lows, closes = cols["open"], cols["high"], cols["low"], cols["close"]
    if not all(np.isfinite(x[a:b]).all() and (x[a:b] > 0).all() for x in cols.values()):
        raise DataError("non-finite or non-positive prices inside the backtest window")

    def optional(name):
        return np.column_stack([df[name].to_numpy(dtype="float64") if name in df.columns and not spot[m]
                                else np.full(len(index), np.nan) for m, df in enumerate(frames)])

    fund, idx_px, mark_px = optional("funding"), optional("index"), optional("mark")
    close_epoch = index.as_unit("s").asi8 + step
    due = (close_epoch % (step * int(config.decision_every))) == 0

    # ---- v11: venues, accounts, slippage inputs (all inert when config.execution is None)
    venue_of = [split_symbol(s)[1] if ex is not None else None for s in symbols]
    if ex is not None and ex.accounts == "per_venue":
        names = list(dict.fromkeys(venue_of))
        acct_of = [names.index(v) for v in venue_of]
    else:
        names, acct_of = ["main"], [0] * k
    A = len(names)
    sqrt_model = ex is not None and ex.slippage_model == "sqrt_impact"
    if sqrt_model:
        volumes = np.column_stack([df["volume"].to_numpy(dtype="float64") if "volume" in df.columns
                                   else np.full(len(index), np.nan) for df in frames])
        sig, usdv = impact_inputs(closes, volumes, int(ex.impact_window_bars))
        hs = [float(ex.half_spread_bps.get(s, venue(v).default_half_spread_bps)) for s, v in zip(symbols, venue_of)]

    with exact():
        bps = Decimal(10_000)
        if ex is not None and ex.venue_fees:
            which = "taker_bps" if config.liquidity == "taker" else "maker_bps"
            fee_rate = [dec(float(getattr(venue(v), which))) / bps for v in venue_of]
            taker_m = [dec(float(venue(v).taker_bps)) / bps for v in venue_of]
            min_order_m = [dec(float(venue(v).min_order_usd)) for v in venue_of]
        else:
            fee_rate = [dec(config.spot_fee_bps if sp else config.fee_bps) / bps for sp in spot]
            taker_m = [dec(config.taker_fee_bps) / bps] * k
            min_order_m = [dec(config.min_order)] * k
        slip = [dec(config.spot_slippage_bps if sp else config.slippage_bps) / bps for sp in spot]
        penalty_rate = dec(config.liquidation_penalty_bps) / bps
        lev = [ONE if sp else dec(min(order_lev, config.venue_leverage(s))) for s, sp in zip(symbols, spot)]
        mmf = [ZERO if sp else dec(config.maintenance(s)) for s, sp in zip(symbols, spot)]
        szdec = [int(config.size_decimals.get(s, config.default_size_decimals)) for s in symbols]
        thr = dec(config.rebalance_threshold)
        initial = dec(config.initial_cash)
        if par is not None:
            thr = dec(float(par.min_trade_pct)) / Decimal(100)
            min_order_m = [x * dec(float(par.min_notional_factor)) for x in min_order_m]
        shares = [float(ex.capital_split.get(nm, 1.0 / A)) if ex is not None else 1.0 for nm in names]
        if ex is not None and ex.capital_split and set(ex.capital_split) != set(names):
            raise DataError(f"capital_split names {sorted(ex.capital_split)} differ from the accounts {sorted(names)}")
        coll = [initial * dec(sh) for sh in shares[:-1]]
        coll.append(initial - sum(coll, ZERO))            # the shares sum to the initial cash exactly

    pos: list[Position | None] = [None] * k
    tot = {"realised": ZERO, "funding": ZERO, "fees": ZERO, "slippage": ZERO, "penalties": ZERO, "bad_debt": ZERO,
           "latency": ZERO}
    counters = {"orders_cut": 0, "orders_refused": 0, "orders_skipped": 0, "funding_missing": 0,
                "funding_payments": 0, "parity_scaled": 0, "parity_min_factor": 1.0, "orders_latency_capped": 0,
                "orders_daily_cap": 0}
    trades: list[tuple] = []
    fundings: list[tuple] = []
    liquidations: list[dict] = []
    n = b - a
    equity = np.zeros(n)
    cash_curve = np.zeros(n)
    long_x, short_x, util, worst = np.zeros(n), np.zeros(n), np.zeros(n), np.zeros(n)
    util_a, me_a = np.zeros((n, A)), np.zeros((n, A))
    cum = np.zeros((n, 4))                                 # fees, slippage, latency, funding (cumulative, USD)
    wts = np.zeros((n, k))
    decision_ts: list = []
    decision_w: list = []
    pending = None
    pending_at = None
    wiped_at = None
    stop = None
    cur_day, day_eq = None, float(config.initial_cash)
    day_orders = {"day": None, "n": 0}
    perp_idx = [m for m in range(k) if not spot[m]]
    spot_idx = [m for m in range(k) if spot[m]]
    perp_by = [[m for m in perp_idx if acct_of[m] == x] for x in range(A)]

    def prices(arr, i):
        return [dec(float(arr[i, m])) for m in range(k)]

    def upnl(m, px):
        p = pos[m]
        return p.size * (px - p.entry_price) if p.side == "long" else p.size * (p.entry_price - px)

    def total_equity(px):
        return sum(coll, ZERO) + sum((upnl(m, px[m]) for m in range(k) if pos[m] is not None), ZERO)

    def spot_cost(x):
        return sum((pos[m].size * pos[m].entry_price for m in spot_idx if pos[m] is not None and acct_of[m] == x), ZERO)

    def margin_equity(px, x):
        return coll[x] - spot_cost(x) + sum((upnl(m, px[m]) for m in perp_by[x] if pos[m] is not None), ZERO)

    def maintenance(px, x):
        return sum((pos[m].size * px[m] * mmf[m] for m in perp_by[x] if pos[m] is not None), ZERO)

    def margin_used(px, x):
        return sum((initial_margin(pos[m].size * px[m], lev[m]) for m in perp_by[x] if pos[m] is not None), ZERO)

    def slip_rate(m, i, ntl):
        """Slippage rate of an order of `ntl` USD on symbol m filled on bar i (v11: size-dependent)."""
        if not sqrt_model:
            return slip[m]
        cost = hs[m] + sqrt_impact_bps(float(ntl), sig[i, m], usdv[i, m], ex.impact_coefficient, ex.max_impact_bps)
        prof = ex.book_profiles.get(symbols[m])
        if prof:
            read = profile_cost_bps(prof, float(ntl), ex.book_quantile)
            if read is not None:
                cost = max(hs[m], read)
        return dec(round(cost, 4)) / bps

    def fill(m, side, size, price, ts, decided_at, *, liquidation=False, cut=False, costless=False, sr=None,
             lat=ZERO):
        ntl = size * price
        if costless:                       # closing the books of a wiped-out account
            fp, sl, fee, pen = price, ZERO, ZERO, ZERO
        elif liquidation:
            fp, sl, pen = price, ZERO, ntl * penalty_rate
            fee = ntl * taker_m[m] + pen
        else:
            sr = slip[m] if sr is None else sr
            fp = price * (ONE + sr) if side == "buy" else price * (ONE - sr)
            sl, pen = ntl * sr, ZERO
            fee = size * fp * fee_rate[m]
        eff = apply_order_to_position(pos[m], side, size, price)
        pos[m] = eff.position
        coll[acct_of[m]] += eff.realized_pnl - fee - sl - lat
        tot["realised"] += eff.realized_pnl
        tot["fees"] += fee
        tot["slippage"] += sl
        tot["penalties"] += pen
        tot["latency"] += lat
        trades.append((ts, decided_at, symbols[m], side, size, price, fp, ntl, fee, sl, eff.realized_pnl, eff.kind,
                       bool(liquidation), pen, signed_size(eff.position), bool(cut), lat, names[acct_of[m]]))

    def liquidate(px, ts, reason, x):
        before = margin_equity(px, x)
        closed = []
        for m in perp_by[x]:
            if pos[m] is not None:
                side = "sell" if pos[m].side == "long" else "buy"
                closed.append({"symbol": symbols[m], "side": pos[m].side, "size": str(pos[m].size),
                               "price": str(px[m])})
                fill(m, side, pos[m].size, px[m], ts, None, liquidation=True)
        after = margin_equity(px, x)
        if A > 1 and after < 0:              # the venue keeps the loss beyond the account: it cannot reach another venue
            tot["bad_debt"] += -after
            coll[x] += -after
        liquidations.append({"ts": ts, "reason": reason, "positions": closed, "account": names[x],
                             "margin_equity_before": float(before), "margin_equity_after": float(after),
                             "equity_after": float(total_equity(px))})

    def execute(w, i, ts):
        px = prices(opens, i)
        eq = total_equity(px)
        if not eq > 0:
            return
        if par is not None:
            w, factor, _binding = par.scale(w, float(eq), float(config.initial_cash))
            if factor < 1.0:
                counters["parity_scaled"] += 1
                counters["parity_min_factor"] = min(counters["parity_min_factor"], factor)
        orders = []
        for m, s in enumerate(symbols):
            target = quantize_down(Fraction(dec(float(w[s])) * eq) / Fraction(px[m]), szdec[m]) if w[s] != 0 else ZERO
            cur = signed_size(pos[m])
            delta = target - cur
            if delta == 0:
                continue
            ntl = abs(delta) * px[m]
            full_exit = target == 0
            flip = cur != 0 and target != 0 and (cur > 0) != (target > 0)
            if par is None:
                skip = not full_exit and (ntl < min_order_m[m] or (not flip and ntl < thr * eq))
            else:                            # perp-engine.ts planPerpOrders: one floor for every order but a full close
                floor = max(thr * eq, min_order_m[m])
                if flip and abs(target) * px[m] < floor:       # the closing half is always sent, the opening half is not
                    target, delta, full_exit, flip = ZERO, -cur, True, False
                    ntl = abs(delta) * px[m]
                skip = not full_exit and not flip and ntl < floor
            if skip:
                counters["orders_skipped"] += 1
                continue
            closing = min(abs(delta), abs(cur)) if cur != 0 and (cur > 0) != (delta > 0) else ZERO
            side = "buy" if delta > 0 else "sell"
            sr = slip_rate(m, i, ntl)
            unit_cost = px[m] * sr + (px[m] * (ONE + sr) if side == "buy" else px[m] * (ONE - sr)) * fee_rate[m]
            orders.append({"m": m, "side": side, "closing": closing, "opening": abs(delta) - closing,
                           "unit_cost": unit_cost, "cut": False, "sr": sr})
        if not orders:
            return

        def need(o, size):
            if size == 0:
                return ZERO
            m = o["m"]
            base = size * px[m] if spot[m] else initial_margin(size * px[m], lev[m])
            return base + size * o["unit_cost"]

        for x in range(A):
            mine = [o for o in orders if acct_of[o["m"]] == x]
            if not mine:
                continue
            # free collateral once every reducing part is executed (they release margin and are always allowed)
            closing_by = {o["m"]: o["closing"] for o in mine}
            free = margin_equity(px, x)
            for o in mine:
                free -= o["closing"] * o["unit_cost"]
                if spot[o["m"]]:
                    free += o["closing"] * px[o["m"]]          # a spot sale turns the holding back into collateral
            for m in perp_by[x]:
                if pos[m] is not None:
                    left = pos[m].size - closing_by.get(m, ZERO)
                    if left > 0:
                        free -= initial_margin(left * px[m], lev[m])
            total_need = sum((need(o, o["opening"]) for o in mine), ZERO)
            if total_need > 0 and total_need > free:
                scale = Fraction(max(free, ZERO)) / Fraction(total_need)
                for _ in range(6):
                    for o in mine:
                        if o["opening"] > 0:
                            cut_size = quantize_down(Fraction(o["opening"]) * scale, szdec[o["m"]])
                            o["cut_size"] = cut_size if cut_size * px[o["m"]] >= min_order_m[o["m"]] else ZERO
                    if sum((need(o, o.get("cut_size", ZERO)) for o in mine), ZERO) <= max(free, ZERO):
                        break
                    scale *= Fraction(999_999, 1_000_000)
                else:
                    for o in mine:
                        o["cut_size"] = ZERO
                for o in mine:
                    if o["opening"] > 0:
                        counters["orders_cut" if o["cut_size"] > 0 else "orders_refused"] += 1
                        o["opening"], o["cut"] = o["cut_size"], True
        n_open = 0
        day = ts.strftime("%Y-%m-%d")
        if day_orders["day"] != day:
            day_orders["day"], day_orders["n"] = day, 0
        for o in sorted(orders, key=lambda o: o["opening"] > 0):      # reducing orders first
            if par is not None and o["opening"] > 0 and day_orders["n"] >= par.max_orders_per_day:
                counters["orders_daily_cap"] += 1
                o["opening"] = ZERO
            size = o["closing"] + o["opening"]
            if size > 0:
                m, lat = o["m"], ZERO
                if ex is not None:
                    delay = ex.latency_s + (n_open * ex.order_spacing_s if o["opening"] > 0 else 0.0)
                    f = ex.latency_fraction(delay, step)
                    if delay > step:
                        counters["orders_latency_capped"] += 1
                    adverse = (highs[i, m] - opens[i, m]) if o["side"] == "buy" else (opens[i, m] - lows[i, m])
                    lat = size * dec(round(f * max(float(adverse), 0.0), 10))
                    if o["opening"] > 0:
                        n_open += 1
                day_orders["n"] += 1
                fill(m, o["side"], size, px[m], ts, pending_at, cut=o["cut"], sr=o["sr"], lat=lat)

    with exact():
        for j in range(n):
            i = a + j
            ts = index[i]
            if wiped_at is not None:
                continue                                   # equity stays 0, nothing trades
            has_perp = any(pos[m] is not None for m in perp_idx)
            liquidated = False

            # 1. funding on the position held coming into the bar
            if has_perp and j > 0:
                for m in perp_idx:
                    if pos[m] is None:
                        continue
                    rate = fund[i, m]
                    if not math.isfinite(rate):
                        counters["funding_missing"] += 1
                        continue
                    if rate == 0.0:
                        continue
                    ref = idx_px[i - 1, m] if math.isfinite(idx_px[i - 1, m]) else opens[i, m]
                    ref_d, rate_d, sz = dec(float(ref)), dec(float(rate)), signed_size(pos[m])
                    amount = -(sz * ref_d * rate_d)
                    coll[acct_of[m]] += amount
                    tot["funding"] += amount
                    counters["funding_payments"] += 1
                    fundings.append((ts, symbols[m], rate_d, sz, ref_d, amount))

            # 2. gap through the liquidation level between the last close and this open (per account)
            if has_perp:
                px_open = prices(opens, i)
                for x in range(A):
                    if any(pos[m] is not None for m in perp_by[x]) and margin_equity(px_open, x) < maintenance(px_open, x):
                        liquidate(px_open, ts, "gap at the open", x)
                        liquidated = True
                has_perp = any(pos[m] is not None for m in perp_idx)

            # 3. fill of the decision taken on the previous close (or of the engine's flatten after a stop)
            if pending is not None:
                execute({s: 0.0 for s in symbols} if pending is _FLATTEN else pending, i, ts)
                pending = None
                has_perp = any(pos[m] is not None for m in perp_idx)

            # 4. intrabar liquidation on the adverse extremes (per account)
            if has_perp:
                px_open = prices(opens, i)
                for x in range(A):
                    held = [m for m in perp_by[x] if pos[m] is not None]
                    if not held:
                        continue
                    adverse = list(px_open)
                    for m in held:
                        adverse[m] = dec(float(lows[i, m] if pos[m].side == "long" else highs[i, m]))
                    liq_px = None
                    if len(held) == 1:
                        m = held[0]
                        p = pos[m]
                        lp = liquidation_price_cross(p.side, p.size, p.entry_price, coll[x] - spot_cost(x), mmf[m])
                        if lp is not None and (adverse[m] <= lp if p.side == "long" else adverse[m] >= lp):
                            liq_px = list(px_open)
                            # the level is never better than the open (a touch at the open liquidates at the open)
                            liq_px[m] = min(lp, px_open[m]) if p.side == "long" else max(lp, px_open[m])
                    else:
                        g0 = margin_equity(px_open, x) - maintenance(px_open, x)
                        g1 = margin_equity(adverse, x) - maintenance(adverse, x)
                        if g1 <= 0:
                            lam = Fraction(g0) / Fraction(g0 - g1) if g0 > g1 else Fraction(0)
                            lam = min(max(lam, Fraction(0)), Fraction(1))
                            liq_px = list(px_open)
                            for m in held:
                                f = Fraction(px_open[m]) + lam * (Fraction(adverse[m]) - Fraction(px_open[m]))
                                liq_px[m] = _frac_to_dec(f, "up" if pos[m].side == "long" else "down")
                    if liq_px is not None:
                        liquidate(liq_px, ts, "intrabar: adverse extreme crossed the liquidation level", x)
                        liquidated = True

            # 5. mark to market at the close
            px_close = [dec(float(mark_px[i, m] if math.isfinite(mark_px[i, m]) else closes[i, m])) for m in range(k)]
            eq = total_equity(px_close)
            if not eq > 0:
                wiped_at = ts
                for m in range(k):
                    if pos[m] is not None:
                        fill(m, "sell" if pos[m].side == "long" else "buy", pos[m].size, px_close[m], ts, None,
                             liquidation=True, costless=True)
                tot["bad_debt"] += -sum(coll, ZERO)    # >= 0: what the accounts could not pay
                coll = [ZERO] * A
                pending = None
                continue
            eq_f = float(eq)
            equity[j], cash_curve[j] = eq_f, float(sum(coll, ZERO))
            cum[j] = (float(tot["fees"]), float(tot["slippage"]), float(tot["latency"]), float(tot["funding"]))
            lo_eq = eq_f
            for m in range(k):
                if pos[m] is None:
                    continue
                sz, mk = float(pos[m].size), float(px_close[m])
                ntl = sz * mk
                if pos[m].side == "long":
                    long_x[j] += ntl / eq_f
                    wts[j, m] = ntl / eq_f
                    lo_eq += sz * (lows[i, m] - mk)
                else:
                    short_x[j] += ntl / eq_f
                    wts[j, m] = -ntl / eq_f
                    lo_eq += sz * (mk - highs[i, m])
            worst[j] = max(min(lo_eq, eq_f), 0.0)
            if liquidated:
                worst[j] = min(worst[j], max(liquidations[-1]["equity_after"], 0.0))
            if any(pos[m] is not None for m in perp_idx):
                used = [margin_used(px_close, x) for x in range(A)]
                mes = [margin_equity(px_close, x) for x in range(A)]
                live = [x for x in range(A) if perp_by[x]]
                me = sum((mes[x] for x in live), ZERO)
                util[j] = float(Fraction(sum((used[x] for x in live), ZERO)) / Fraction(me)) if me > 0 else float("nan")
                for x in live:
                    me_a[j, x] = float(mes[x])
                    util_a[j, x] = float(Fraction(used[x]) / Fraction(mes[x])) if mes[x] > 0 else float("nan")
            elif A > 1:
                for x in range(A):
                    me_a[j, x] = float(margin_equity(px_close, x))

            # 5b. engine parity: the live engine's stop rules, watched at every close (the engine watches every minute)
            if par is not None and stop is None:
                day = (ts + pd.Timedelta(seconds=step)).strftime("%Y-%m-%d")
                if day != cur_day:
                    cur_day, day_eq = day, eq_f           # first observation of the UTC day
                cap = float(config.initial_cash)
                if liquidated:
                    stop = {"code": "liquidation", "reason": "the account was liquidated: the engine stops the agent"}
                elif cap - eq_f >= cap * par.max_total_loss_pct / 100.0:
                    stop = {"code": "total_loss", "reason": f"total loss limit reached ({par.max_total_loss_pct:g} % of the capital)"}
                elif day_eq - eq_f >= cap * par.max_daily_loss_pct / 100.0:
                    stop = {"code": "daily_loss", "reason": f"daily loss limit reached ({par.max_daily_loss_pct:g} % of the capital)"}
                if stop is not None:
                    stop.update({"ts": ts.isoformat(), "equity": eq_f})
                    pending, pending_at = (_FLATTEN if any(p is not None for p in pos) else None), ts

            # 6. decision on the closed bar (also on the last bar: recorded as the current signal, never filled)
            if stop is None and due[i] and i + 1 >= lb:
                lo = i + 1 - lb
                view = {s: df.iloc[lo:i + 1] for s, df in zip(symbols, frames)}
                w = decide(view)
                if w is not None:
                    pending, pending_at = w, ts
                    decision_ts.append(ts)
                    decision_w.append([w[s] for s in symbols])

        # ------------------------------------------------------------------------------------------ closing books
        last_px = [dec(float(mark_px[b - 1, m] if math.isfinite(mark_px[b - 1, m]) else closes[b - 1, m]))
                   for m in range(k)]
        unrealised = sum((upnl(m, last_px[m]) for m in range(k) if pos[m] is not None), ZERO)
        collateral = sum(coll, ZERO)
        final_equity = collateral + unrealised
        trade_df = pd.DataFrame(trades, columns=TRADE_COLUMNS)
        funding_df = pd.DataFrame(fundings, columns=FUNDING_COLUMNS)
        # second, independent path: the logs alone must rebuild the running balance
        from_logs = (initial + sum(trade_df["realised_pnl"], ZERO) + sum(funding_df["amount"], ZERO)
                     - sum(trade_df["fee"], ZERO) - sum(trade_df["slippage"], ZERO) - sum(trade_df["latency"], ZERO)
                     + unrealised + tot["bad_debt"])
        ledger = {
            "initial": initial, "realised_pnl": tot["realised"], "funding": tot["funding"], "fees": tot["fees"],
            "liquidation_penalties": tot["penalties"], "slippage": tot["slippage"], "unrealised_pnl": unrealised,
            "bad_debt_written_off": tot["bad_debt"], "collateral": collateral, "final_equity": final_equity,
            "from_logs": from_logs,
            "reconciles": bool(from_logs == final_equity and final_equity == initial + tot["realised"]
                               + tot["funding"] - tot["fees"] - tot["slippage"] - tot["latency"] + unrealised
                               + tot["bad_debt"]),
        }
        if ex is not None:
            ledger["latency"] = tot["latency"]
        open_positions = [
            {"symbol": s, "side": pos[m].side, "size": pos[m].size, "entry_price": pos[m].entry_price,
             "mark": last_px[m], "unrealised_pnl": upnl(m, last_px[m]),
             "units": float(signed_size(pos[m])), "cost": float(pos[m].size * pos[m].entry_price),
             "value": float(pos[m].size * pos[m].entry_price + upnl(m, last_px[m]))}
            for m, s in enumerate(symbols) if pos[m] is not None
        ]

    win = index[a:b]
    series = lambda x, name: pd.Series(x, index=win, name=name)  # noqa: E731
    return PerpResult(
        symbols=symbols, config=config,
        equity=series(equity, "equity"), cash=series(cash_curve, "cash"),
        exposure=series(long_x + short_x, "exposure"), long_exposure=series(long_x, "long_exposure"),
        short_exposure=series(short_x, "short_exposure"), margin_utilisation=series(util, "margin_utilisation"),
        worst_equity=series(worst, "worst_equity"),
        weights=pd.DataFrame(wts, index=win, columns=symbols),
        decisions=pd.DataFrame(decision_w, index=pd.DatetimeIndex(decision_ts, name="ts"), columns=symbols),
        trades=trade_df, funding=funding_df, open_positions=open_positions, liquidations=liquidations,
        wiped_out=wiped_at is not None, wiped_out_at=wiped_at, ledger=ledger, counters=counters,
        stop=stop, accounts=names,
        account_margin_equity=pd.DataFrame(me_a, index=win, columns=names),
        account_margin_utilisation=pd.DataFrame(util_a, index=win, columns=names),
        cost_curve=pd.DataFrame(cum, index=win, columns=["fees", "slippage", "latency", "funding"]),
    )


# ---------------------------------------------------------------------------------------------------- benchmarks

def perp_hold(data, config: PerpConfig, *, start=None, end=None, weights: dict | None = None) -> PerpResult:
    """Perpetual long 1x INCLUDING funding: equal weights summing to 1 opened once at the first possible fill,
    then held (no rebalancing): price PnL plus every funding payment, with the same fee and slippage."""
    symbols = [s for s in data if not is_spot_leg(s)]
    sub = {s: data[s] for s in symbols}
    w = weights or {s: 1.0 / len(symbols) for s in symbols}
    state = {"done": False}

    def decide(_view):
        if state["done"]:
            return None
        state["done"] = True
        return w

    # a benchmark is not an agent: same execution costs, none of the engine's caps or stop rules
    cfg = replace(config, decision_every=1, rebalance_threshold=0.0, min_order=0.0, leverage=1.0, parity=None)
    return run_perp_backtest(decide, sub, cfg, start=start, end=end)
