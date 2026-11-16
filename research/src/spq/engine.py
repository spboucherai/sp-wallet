"""Event-driven, long-only spot backtester.

Timeline for a window of bars a .. b-1 (bar i opens at ts[i]):

    close of bar i   : the strategy sees bars <= i (at most `lookback` of them) and returns target weights
    open of bar i+1  : the engine trades towards those weights at open[i+1], paying fee and slippage
    close of bar i+1 : the portfolio is marked to market -> equity[i+1]

The strategy is handed `df.iloc[i + 1 - lookback : i + 1]` and nothing else: the bar it is filled on does not exist
in its inputs. Order sizes are computed at execution time from the fill bar's open (as a live engine would size an
order from a fresh quote); the decision itself (the weights) only depends on closed bars.

Costs, on traded notional: a buy pays open*(1+slippage) per unit plus fee on the amount paid; a sell receives
open*(1-slippage) per unit minus fee on the amount received. Cash is USD (USDC) and earns nothing.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Callable

import numpy as np
import pandas as pd

from .data.core import DataError, interval_seconds, to_utc
from .strategy import Strategy, validate_weights

if int(pd.__version__.split(".")[0]) < 3:  # pragma: no cover - copy-on-write is the only mode from pandas 3
    # slices handed to a strategy must be copy-on-write so that it cannot write into the engine's data
    pd.options.mode.copy_on_write = True


@dataclass(frozen=True)
class BacktestConfig:
    interval: str
    fee_bps: float = 10.0
    slippage_bps: float = 10.0
    initial_cash: float = 1000.0
    min_order: float = 0.0            # USD; smaller orders are not sent
    rebalance_threshold: float = 0.0  # do not trade a symbol whose weight is within this distance of its target
    decision_every: int = 1           # ask the strategy every N bars (anchored on the UTC epoch)
    # v11 engine parity (spq.execution.SpotParity, research/params/engine-parity.json). None = as before.
    parity: object | None = None

    def __post_init__(self):
        interval_seconds(self.interval)
        if self.fee_bps < 0 or self.slippage_bps < 0 or self.slippage_bps >= 10_000:
            raise ValueError("fee_bps and slippage_bps must be >= 0 (slippage < 10000)")
        if self.initial_cash <= 0 or self.min_order < 0 or not 0 <= self.rebalance_threshold <= 1:
            raise ValueError("initial_cash > 0, min_order >= 0 and 0 <= rebalance_threshold <= 1 are required")
        if int(self.decision_every) != self.decision_every or self.decision_every < 1:
            raise ValueError("decision_every must be a positive integer")

    def to_dict(self) -> dict:
        d = asdict(self)
        if self.parity is None:
            d.pop("parity")
        return d


@dataclass
class BacktestResult:
    """equity/cash/exposure are indexed by bar-open time and valued at that bar's CLOSE."""

    symbols: list[str]
    config: BacktestConfig
    equity: pd.Series
    cash: pd.Series
    exposure: pd.Series      # invested fraction of equity at each close
    decisions: pd.DataFrame  # target weights, indexed by the decision bar
    trades: pd.DataFrame     # one row per fill
    open_positions: list[dict]
    stop: dict | None = None           # v11 engine parity: why and when the agent was stopped
    counters: dict | None = None       # v11 engine parity: orders held back by the engine's caps

    @property
    def returns(self) -> pd.Series:
        return self.equity.pct_change().iloc[1:]


TRADE_COLUMNS = ["ts", "decided_at", "symbol", "side", "units", "price", "notional", "fee", "slippage", "realised_pnl"]


def check_aligned(data: dict[str, pd.DataFrame]) -> pd.DatetimeIndex:
    if not data:
        raise DataError("no data")
    index = None
    for s, df in data.items():
        if index is None:
            index = df.index
        elif not df.index.equals(index):
            raise DataError(f"{s}: index differs from the other symbols (use spq.data.align first)")
    if not isinstance(index, pd.DatetimeIndex) or index.tz is None:
        raise DataError("data must be indexed by timezone-aware UTC bar-open times")
    if not index.is_monotonic_increasing or not index.is_unique:
        raise DataError("data index must be strictly increasing")
    return index


def run_backtest(
    strategy: Strategy | Callable,
    data: dict[str, pd.DataFrame],
    config: BacktestConfig,
    *,
    start=None,
    end=None,
    params: dict | None = None,
    lookback: int | None = None,
) -> BacktestResult:
    """Simulate `strategy` on the bars with start <= ts < end.

    Bars before `start` are only used as history for the strategy's lookback (they are past data).
    `strategy` is a loaded Strategy, or (for benchmarks) a callable view -> weights | None where None means
    "leave the portfolio as it is".
    """
    index = check_aligned(data)
    symbols = list(data.keys())
    k = len(symbols)
    step = interval_seconds(config.interval)
    a = 0 if start is None else int(index.searchsorted(to_utc(start), side="left"))
    b = len(index) if end is None else int(index.searchsorted(to_utc(end), side="left"))
    if b - a < 2:
        raise DataError("the backtest window needs at least two bars")

    if isinstance(strategy, Strategy):
        if strategy.kind != "spot":
            raise DataError(f"strategy {strategy.name!r} is a {strategy.kind} strategy: the spot backtester cannot "
                            "run it (use spq.perp_engine.run_perp_backtest / python -m spq.perp_backtest)")
        lb = strategy.lookback if lookback is None else lookback

        def decide(view):
            return strategy(view, params)
    else:
        lb = lookback or 1

        def decide(view):
            w = strategy(view)
            return None if w is None else validate_weights(w, symbols)

    frames = [data[s] for s in symbols]
    opens = np.column_stack([df["open"].to_numpy(dtype="float64") for df in frames])
    closes = np.column_stack([df["close"].to_numpy(dtype="float64") for df in frames])
    if not (np.isfinite(opens[a:b]).all() and np.isfinite(closes[a:b]).all() and (opens[a:b] > 0).all()):
        raise DataError("non-finite or non-positive prices inside the backtest window")
    close_epoch = index.as_unit("s").asi8 + step
    due = (close_epoch % (step * int(config.decision_every))) == 0

    fee = config.fee_bps / 1e4
    slip = config.slippage_bps / 1e4
    thr = config.rebalance_threshold

    cash = float(config.initial_cash)
    units = np.zeros(k)
    cost = np.zeros(k)  # cost basis (USD paid, fees and slippage included) of the units held
    n = b - a
    equity = np.empty(n)
    cash_curve = np.empty(n)
    exposure = np.empty(n)
    trades: list[tuple] = []
    decision_ts: list = []
    decision_w: list = []
    pending = None
    pending_at = None
    par = config.parity
    stop = None
    counters = {"exposure_scaled": 0, "orders_capped": 0, "daily_usd_cap": 0, "daily_order_cap": 0}
    day_state = {"day": None, "usd": 0.0, "orders": 0}

    def parity_fill(i, w):
        """services/api/src/agents/engine.ts planOrder, LIVE: ONE order per engine pass (one pass per minute, so
        at most bar / loop period orders per bar), sells first (largest), then the largest buy; weights scaled to
        the exposure cap; each order capped in USD; USD and order count capped per UTC day. All the orders of a bar
        are filled at that bar's open (the spot engine has no intrabar path): later passes are NOT priced later."""
        nonlocal cash
        px, ts = opens[i], index[i]
        day = ts.strftime("%Y-%m-%d")
        if day_state["day"] != day:
            day_state.update(day=day, usd=0.0, orders=0)
        tw = np.array([w[s] for s in symbols], dtype="float64")
        cap = par.max_exposure_pct / 100.0
        if tw.sum() > cap:
            tw = tw * (cap / tw.sum())
            counters["exposure_scaled"] += 1
        for _ in range(max(1, int(step // par.loop_period_s)) * int(par.live_orders_per_pass)):
            value = units * px
            total = cash + value.sum()
            if not total > 0:
                return
            delta = tw * total - value
            cand = np.nonzero(np.abs(delta) >= max(par.min_trade_usd, total * par.min_trade_fraction))[0]
            if not len(cand):
                return
            if day_state["orders"] >= par.max_orders_per_day:
                counters["daily_order_cap"] += 1
                return
            room = par.max_daily_usd - day_state["usd"]
            if room < par.min_trade_usd:
                counters["daily_usd_cap"] += 1
                return
            sells = cand[delta[cand] < 0]
            m = int(sells[np.argmin(delta[sells])]) if len(sells) else int(cand[np.argmax(delta[cand])])
            usd = min(abs(delta[m]), par.max_order_usd, room)
            if usd < abs(delta[m]):
                counters["orders_capped"] += 1
            if delta[m] < 0:
                q = min(units[m], usd / px[m])
                if not q > 0:
                    return
                gross = q * px[m] * (1 - slip)
                f = gross * fee
                basis = cost[m] * (q / units[m])
                cash += gross - f
                units[m] -= q
                cost[m] -= basis
                if units[m] < 1e-12:
                    units[m], cost[m] = 0.0, 0.0
                trades.append((ts, pending_at, symbols[m], "sell", q, px[m] * (1 - slip), gross, f, q * px[m] * slip,
                               gross - f - basis))
                traded = q * px[m]
            else:
                spend = min(usd, cash)
                if spend < par.min_trade_usd:
                    return
                gross = spend / (1 + fee)
                q = gross / (px[m] * (1 + slip))
                cash -= spend
                units[m] += q
                cost[m] += spend
                trades.append((ts, pending_at, symbols[m], "buy", q, px[m] * (1 + slip), gross, gross * fee,
                               q * px[m] * slip, 0.0))
                traded = spend
            day_state["usd"] += traded
            day_state["orders"] += 1

    for j in range(n):
        i = a + j
        if pending is not None and par is not None:
            parity_fill(i, pending)
            pending = None                        # after a stop: the liquidation orders the caps allowed were sent
        if pending is not None:
            px = opens[i]
            value = units * px
            total = cash + value.sum()
            target = np.array([pending[s] for s in symbols]) * total
            delta = target - value
            w_gap = np.abs(delta) / total if total > 0 else np.zeros(k)
            act = (w_gap > 1e-12) & (w_gap >= thr)
            act |= (target == 0) & (units > 0)          # a full exit is never blocked by the threshold
            act &= np.abs(delta) >= config.min_order
            act &= np.abs(delta) > 0
            ts = index[i]
            for m in np.nonzero(act & (delta < 0))[0]:  # sells first: they fund the buys
                q = units[m] if target[m] == 0 else min(units[m], -delta[m] / px[m])
                gross = q * px[m] * (1 - slip)
                f = gross * fee
                basis = cost[m] * (q / units[m])
                cash += gross - f
                units[m] -= q
                cost[m] -= basis
                if target[m] == 0:
                    units[m], cost[m] = 0.0, 0.0
                trades.append((ts, pending_at, symbols[m], "sell", q, px[m] * (1 - slip), gross, f,
                               q * px[m] * slip, gross - f - basis))
            buys = np.nonzero(act & (delta > 0))[0]
            if len(buys):
                want = delta[buys] * (1 + slip) * (1 + fee)  # cash needed for each buy
                scale = min(1.0, cash / want.sum()) if want.sum() > 0 else 0.0
                for m, spend in zip(buys, want * scale):
                    if spend < config.min_order or spend <= 0:
                        continue
                    gross = spend / (1 + fee)
                    q = gross / (px[m] * (1 + slip))
                    cash -= spend
                    units[m] += q
                    cost[m] += spend
                    trades.append((ts, pending_at, symbols[m], "buy", q, px[m] * (1 + slip), gross, gross * fee,
                                   q * px[m] * slip, 0.0))
                cash = max(cash, 0.0)
            pending = None

        held = units * closes[i]
        eq = cash + held.sum()
        equity[j], cash_curve[j] = eq, cash
        exposure[j] = held.sum() / eq if eq > 0 else 0.0

        if par is not None and stop is None and eq < config.initial_cash * (1 - par.max_loss_pct / 100.0):
            stop = {"code": "loss_limit", "ts": index[i].isoformat(), "equity": float(eq),
                    "reason": f"loss limit reached ({par.max_loss_pct:g} % of the capital): sell to cash under the "
                              "same order caps, then stop"}
            pending, pending_at = {s: 0.0 for s in symbols}, index[i]
        if stop is None and due[i] and i + 1 >= lb:  # also on the last bar: recorded as the current signal, never filled
            lo = i + 1 - lb
            view = {s: df.iloc[lo:i + 1] for s, df in zip(symbols, frames)}
            w = decide(view)
            if w is not None:
                pending, pending_at = w, index[i]
                decision_ts.append(index[i])
                decision_w.append([w[s] for s in symbols])

    win = index[a:b]
    open_positions = [
        {"symbol": s, "units": float(units[m]), "cost": float(cost[m]), "value": float(units[m] * closes[b - 1, m])}
        for m, s in enumerate(symbols) if units[m] > 0
    ]
    return BacktestResult(
        symbols=symbols,
        config=config,
        equity=pd.Series(equity, index=win, name="equity"),
        cash=pd.Series(cash_curve, index=win, name="cash"),
        exposure=pd.Series(exposure, index=win, name="exposure"),
        decisions=pd.DataFrame(decision_w, index=pd.DatetimeIndex(decision_ts, name="ts"), columns=symbols),
        trades=pd.DataFrame(trades, columns=TRADE_COLUMNS),
        open_positions=open_positions,
        stop=stop, counters=counters if par is not None else None,
    )


# ---------------------------------------------------------------------------------------------------- benchmarks

def buy_and_hold(data, config: BacktestConfig, *, start=None, end=None, weights: dict | None = None) -> BacktestResult:
    """Buy once at the first possible fill (equal weights by default), with the same costs, then never trade."""
    symbols = list(data.keys())
    w = weights or {s: 1.0 / len(symbols) for s in symbols}
    state = {"done": False}

    def decide(_view):
        if state["done"]:
            return None
        state["done"] = True
        return w

    cfg = BacktestConfig(**{**config.to_dict(), "decision_every": 1, "rebalance_threshold": 0.0, "min_order": 0.0, "parity": None})
    return run_backtest(decide, data, cfg, start=start, end=end)


def equal_weight(data, config: BacktestConfig, *, start=None, end=None) -> BacktestResult:
    """Equal weights, rebalanced under the same costs, threshold and minimum order as the strategy."""
    symbols = list(data.keys())
    w = {s: 1.0 / len(symbols) for s in symbols}
    cfg = BacktestConfig(**{**config.to_dict(), "parity": None})   # a benchmark is not an agent
    return run_backtest(lambda _view: w, data, cfg, start=start, end=end)
