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
from dataclasses import asdict, dataclass, field
from decimal import Decimal
from fractions import Fraction
from typing import Callable

import numpy as np
import pandas as pd

from .data.core import DataError, interval_seconds, to_utc
from .engine import check_aligned
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
        return asdict(self)


TRADE_COLUMNS = ["ts", "decided_at", "symbol", "side", "size", "price", "fill_price", "notional", "fee", "slippage",
                 "realised_pnl", "kind", "liquidation", "penalty", "position_after", "cut"]
FUNDING_COLUMNS = ["ts", "symbol", "rate", "size", "price", "amount"]


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

    with exact():
        bps = Decimal(10_000)
        fee_rate = [dec(config.spot_fee_bps if sp else config.fee_bps) / bps for sp in spot]
        slip = [dec(config.spot_slippage_bps if sp else config.slippage_bps) / bps for sp in spot]
        taker = dec(config.taker_fee_bps) / bps
        penalty_rate = dec(config.liquidation_penalty_bps) / bps
        lev = [ONE if sp else dec(min(account_lev, config.venue_leverage(s))) for s, sp in zip(symbols, spot)]
        mmf = [ZERO if sp else dec(config.maintenance(s)) for s, sp in zip(symbols, spot)]
        szdec = [int(config.size_decimals.get(s, config.default_size_decimals)) for s in symbols]
        min_order = dec(config.min_order)
        thr = dec(config.rebalance_threshold)
        initial = dec(config.initial_cash)

    collateral = initial
    pos: list[Position | None] = [None] * k
    tot = {"realised": ZERO, "funding": ZERO, "fees": ZERO, "slippage": ZERO, "penalties": ZERO, "bad_debt": ZERO}
    counters = {"orders_cut": 0, "orders_refused": 0, "orders_skipped": 0, "funding_missing": 0,
                "funding_payments": 0}
    trades: list[tuple] = []
    fundings: list[tuple] = []
    liquidations: list[dict] = []
    n = b - a
    equity = np.zeros(n)
    cash_curve = np.zeros(n)
    long_x, short_x, util, worst = np.zeros(n), np.zeros(n), np.zeros(n), np.zeros(n)
    wts = np.zeros((n, k))
    decision_ts: list = []
    decision_w: list = []
    pending = None
    pending_at = None
    wiped_at = None
    perp_idx = [m for m in range(k) if not spot[m]]
    spot_idx = [m for m in range(k) if spot[m]]

    def prices(arr, i):
        return [dec(float(arr[i, m])) for m in range(k)]

    def upnl(m, px):
        p = pos[m]
        return p.size * (px - p.entry_price) if p.side == "long" else p.size * (p.entry_price - px)

    def total_equity(px):
        return collateral + sum((upnl(m, px[m]) for m in range(k) if pos[m] is not None), ZERO)

    def spot_cost():
        return sum((pos[m].size * pos[m].entry_price for m in spot_idx if pos[m] is not None), ZERO)

    def margin_equity(px):
        return collateral - spot_cost() + sum((upnl(m, px[m]) for m in perp_idx if pos[m] is not None), ZERO)

    def maintenance(px):
        return sum((pos[m].size * px[m] * mmf[m] for m in perp_idx if pos[m] is not None), ZERO)

    def margin_used(px):
        return sum((initial_margin(pos[m].size * px[m], lev[m]) for m in perp_idx if pos[m] is not None), ZERO)

    def fill(m, side, size, price, ts, decided_at, *, liquidation=False, cut=False, costless=False):
        nonlocal collateral
        ntl = size * price
        if costless:                       # closing the books of a wiped-out account
            fp, sl, fee, pen = price, ZERO, ZERO, ZERO
        elif liquidation:
            fp, sl, pen = price, ZERO, ntl * penalty_rate
            fee = ntl * taker + pen
        else:
            fp = price * (ONE + slip[m]) if side == "buy" else price * (ONE - slip[m])
            sl, pen = ntl * slip[m], ZERO
            fee = size * fp * fee_rate[m]
        eff = apply_order_to_position(pos[m], side, size, price)
        pos[m] = eff.position
        collateral += eff.realized_pnl - fee - sl
        tot["realised"] += eff.realized_pnl
        tot["fees"] += fee
        tot["slippage"] += sl
        tot["penalties"] += pen
        trades.append((ts, decided_at, symbols[m], side, size, price, fp, ntl, fee, sl, eff.realized_pnl, eff.kind,
                       bool(liquidation), pen, signed_size(eff.position), bool(cut)))

    def liquidate(px, ts, reason):
        before = margin_equity(px)
        closed = []
        for m in perp_idx:
            if pos[m] is not None:
                side = "sell" if pos[m].side == "long" else "buy"
                closed.append({"symbol": symbols[m], "side": pos[m].side, "size": str(pos[m].size),
                               "price": str(px[m])})
                fill(m, side, pos[m].size, px[m], ts, None, liquidation=True)
        liquidations.append({"ts": ts, "reason": reason, "positions": closed,
                             "margin_equity_before": float(before), "margin_equity_after": float(margin_equity(px)),
                             "equity_after": float(total_equity(px))})

    def execute(w, i, ts):
        px = prices(opens, i)
        eq = total_equity(px)
        if not eq > 0:
            return
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
            if not full_exit and (ntl < min_order or (not flip and ntl < thr * eq)):
                counters["orders_skipped"] += 1
                continue
            closing = min(abs(delta), abs(cur)) if cur != 0 and (cur > 0) != (delta > 0) else ZERO
            side = "buy" if delta > 0 else "sell"
            unit_cost = px[m] * slip[m] + (px[m] * (ONE + slip[m]) if side == "buy" else px[m] * (ONE - slip[m])) * fee_rate[m]
            orders.append({"m": m, "side": side, "closing": closing, "opening": abs(delta) - closing,
                           "unit_cost": unit_cost, "cut": False})
        if not orders:
            return
        # free collateral once every reducing part is executed (they release margin and are always allowed)
        closing_by = {o["m"]: o["closing"] for o in orders}
        free = margin_equity(px)
        for o in orders:
            free -= o["closing"] * o["unit_cost"]
            if spot[o["m"]]:
                free += o["closing"] * px[o["m"]]          # a spot sale turns the holding back into collateral
        for m in perp_idx:
            if pos[m] is not None:
                left = pos[m].size - closing_by.get(m, ZERO)
                if left > 0:
                    free -= initial_margin(left * px[m], lev[m])

        def need(o, size):
            if size == 0:
                return ZERO
            m = o["m"]
            base = size * px[m] if spot[m] else initial_margin(size * px[m], lev[m])
            return base + size * o["unit_cost"]

        total_need = sum((need(o, o["opening"]) for o in orders), ZERO)
        if total_need > 0 and total_need > free:
            scale = Fraction(max(free, ZERO)) / Fraction(total_need)
            for _ in range(6):
                for o in orders:
                    if o["opening"] > 0:
                        cut_size = quantize_down(Fraction(o["opening"]) * scale, szdec[o["m"]])
                        o["cut_size"] = cut_size if cut_size * px[o["m"]] >= min_order else ZERO
                if sum((need(o, o.get("cut_size", ZERO)) for o in orders), ZERO) <= max(free, ZERO):
                    break
                scale *= Fraction(999_999, 1_000_000)
            else:
                for o in orders:
                    o["cut_size"] = ZERO
            for o in orders:
                if o["opening"] > 0:
                    counters["orders_cut" if o["cut_size"] > 0 else "orders_refused"] += 1
                    o["opening"], o["cut"] = o["cut_size"], True
        for o in sorted(orders, key=lambda o: o["opening"] > 0):      # reducing orders first
            size = o["closing"] + o["opening"]
            if size > 0:
                fill(o["m"], o["side"], size, px[o["m"]], ts, pending_at, cut=o["cut"])

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
                    collateral += amount
                    tot["funding"] += amount
                    counters["funding_payments"] += 1
                    fundings.append((ts, symbols[m], rate_d, sz, ref_d, amount))

            # 2. gap through the liquidation level between the last close and this open
            if has_perp:
                px_open = prices(opens, i)
                if margin_equity(px_open) < maintenance(px_open):
                    liquidate(px_open, ts, "gap at the open")
                    liquidated, has_perp = True, False

            # 3. fill of the decision taken on the previous close
            if pending is not None:
                execute(pending, i, ts)
                pending = None
                has_perp = any(pos[m] is not None for m in perp_idx)

            # 4. intrabar liquidation on the adverse extremes
            if has_perp:
                px_open = prices(opens, i)
                held = [m for m in perp_idx if pos[m] is not None]
                adverse = list(px_open)
                for m in held:
                    adverse[m] = dec(float(lows[i, m] if pos[m].side == "long" else highs[i, m]))
                liq_px = None
                if len(held) == 1:
                    m = held[0]
                    p = pos[m]
                    lp = liquidation_price_cross(p.side, p.size, p.entry_price, collateral - spot_cost(), mmf[m])
                    if lp is not None and (adverse[m] <= lp if p.side == "long" else adverse[m] >= lp):
                        liq_px = list(px_open)
                        # the level is never better than the open (a touch at the open liquidates at the open)
                        liq_px[m] = min(lp, px_open[m]) if p.side == "long" else max(lp, px_open[m])
                else:
                    g0 = margin_equity(px_open) - maintenance(px_open)
                    g1 = margin_equity(adverse) - maintenance(adverse)
                    if g1 <= 0:
                        lam = Fraction(g0) / Fraction(g0 - g1) if g0 > g1 else Fraction(0)
                        lam = min(max(lam, Fraction(0)), Fraction(1))
                        liq_px = list(px_open)
                        for m in held:
                            f = Fraction(px_open[m]) + lam * (Fraction(adverse[m]) - Fraction(px_open[m]))
                            liq_px[m] = _frac_to_dec(f, "up" if pos[m].side == "long" else "down")
                if liq_px is not None:
                    liquidate(liq_px, ts, "intrabar: adverse extreme crossed the liquidation level")
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
                tot["bad_debt"] = -collateral          # >= 0: what the account could not pay
                collateral = ZERO
                pending = None
                continue
            eq_f = float(eq)
            equity[j], cash_curve[j] = eq_f, float(collateral)
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
                me = margin_equity(px_close)
                util[j] = float(Fraction(margin_used(px_close)) / Fraction(me)) if me > 0 else float("nan")

            # 6. decision on the closed bar (also on the last bar: recorded as the current signal, never filled)
            if due[i] and i + 1 >= lb:
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
        final_equity = collateral + unrealised
        trade_df = pd.DataFrame(trades, columns=TRADE_COLUMNS)
        funding_df = pd.DataFrame(fundings, columns=FUNDING_COLUMNS)
        # second, independent path: the logs alone must rebuild the running balance
        from_logs = (initial + sum(trade_df["realised_pnl"], ZERO) + sum(funding_df["amount"], ZERO)
                     - sum(trade_df["fee"], ZERO) - sum(trade_df["slippage"], ZERO) + unrealised + tot["bad_debt"])
        ledger = {
            "initial": initial, "realised_pnl": tot["realised"], "funding": tot["funding"], "fees": tot["fees"],
            "liquidation_penalties": tot["penalties"], "slippage": tot["slippage"], "unrealised_pnl": unrealised,
            "bad_debt_written_off": tot["bad_debt"], "collateral": collateral, "final_equity": final_equity,
            "from_logs": from_logs,
            "reconciles": bool(from_logs == final_equity and final_equity == initial + tot["realised"]
                               + tot["funding"] - tot["fees"] - tot["slippage"] + unrealised + tot["bad_debt"]),
        }
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

    cfg = PerpConfig(**{**config.to_dict(), "decision_every": 1, "rebalance_threshold": 0.0, "min_order": 0.0,
                        "leverage": 1.0})
    return run_perp_backtest(decide, sub, cfg, start=start, end=end)
