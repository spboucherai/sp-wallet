"""Cross-venue funding arbitrage: long the perpetual where funding is lower, short it where funding is higher."""

import numpy as np

META = {
    "name": "funding_arb_cross_venue",
    "version": "1",
    "kind": "perp",
    "universe": ["BTC", "BTC@EDGEX", "ETH", "ETH@EDGEX", "SOL", "SOL@EDGEX"],
    "interval": "1h",
    "lookback": 720,
    "max_leverage": 1.0,
    "max_gross_exposure": 1.0,
    "params": {"window": 168, "enter_net_apr": 0.04, "exit_apr": 0.01, "round_trip_cost_bps": 40.0,
               "holding_days": 30.0, "max_adverse_spread_bps": 10.0, "state_bars": 336, "gross": 0.9},
}

SECONDS_PER_YEAR = 365.0 * 86400.0
SEP = "@"


def _rolling_mean(values, window):
    total = np.cumsum(np.concatenate([[0.0], values]))
    return (total[window:] - total[:-window]) / window


def _funding_per_bar(df):
    """Funding paid by a long per bar, as the data carry it: the sum of the rates settled in the bar (a venue that
    settles every 4 hours has three zero bars out of four). None when the column is missing or too incomplete."""
    if "funding" not in df.columns:
        return None
    rate = df["funding"].to_numpy()
    if np.isnan(rate).mean() > 0.05:
        return None
    return np.where(np.isnan(rate), 0.0, rate)


def _pair_state(first, second, window, enter_net_apr, exit_apr, cost_apr, max_adverse_spread_bps, state_bars):
    """+1 = long `first` / short `second` (funding is lower on `first`), -1 = the reverse, 0 = flat; replayed over the
    last `state_bars` bars of the window (the function keeps no memory).

    diff = annualised mean funding of `second` minus `first` over the last `window` bars: what the pair
    long-first / short-second collects per unit of leg notional. Enter when |diff| minus the amortised round trip
    of BOTH legs reaches `enter_net_apr` and the leg to be sold is not unusually cheap against the leg to be bought;
    leave when the collected difference falls under `exit_apr` (which includes a change of sign)."""
    f1, f2 = _funding_per_bar(first), _funding_per_bar(second)
    if f1 is None or f2 is None or len(first) < window + state_bars or len(first) < 2:
        return 0
    bar_seconds = (first.index[-1] - first.index[-2]).total_seconds()
    if not bar_seconds > 0:
        return 0
    per_year = SECONDS_PER_YEAR / bar_seconds
    diff = (_rolling_mean(f2, window) - _rolling_mean(f1, window))[-state_bars:] * per_year
    spread = (second["close"].to_numpy() / first["close"].to_numpy() - 1.0) * 1e4       # second over first, bps
    gap = spread[-state_bars:] - _rolling_mean(spread, window)[-state_bars:]
    state = 0
    for carry, rich in zip(diff, gap):
        if state == 0:
            if carry - cost_apr >= enter_net_apr and rich >= -max_adverse_spread_bps:
                state = 1                                # short `second` (it pays more), long `first`
            elif -carry - cost_apr >= enter_net_apr and -rich >= -max_adverse_spread_bps:
                state = -1
        elif state * carry < exit_apr:
            state = 0
    return state


def target_weights(data, params):
    window, state_bars = int(params["window"]), int(params["state_bars"])
    holding_days = float(params["holding_days"])
    gross = min(float(params["gross"]), 1.0)
    weights = {symbol: 0.0 for symbol in data}
    pairs = []
    for symbol in data:
        base, sep, _venue = symbol.partition(SEP)
        if sep and base in data:
            pairs.append((base, symbol))
    if not pairs or window < 2 or state_bars < 1 or holding_days <= 0 or gross <= 0:
        return weights
    cost_apr = float(params["round_trip_cost_bps"]) / 1e4 * 365.0 / holding_days
    leg = gross / (2.0 * len(pairs))
    for first, second in pairs:
        state = _pair_state(data[first], data[second], window, float(params["enter_net_apr"]),
                            float(params["exit_apr"]), cost_apr, float(params["max_adverse_spread_bps"]), state_bars)
        weights[first] += state * leg
        weights[second] -= state * leg
    return weights
