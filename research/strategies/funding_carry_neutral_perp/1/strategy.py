"""Delta-neutral cash-and-carry: spot long + perpetual short of the same asset while funding is persistently high."""

import numpy as np

META = {
    "name": "funding_carry_neutral_perp",
    "version": "1",
    "kind": "perp",
    "universe": ["BTC", "ETH", "SOL", "HYPE", "BTC.SPOT", "ETH.SPOT", "SOL.SPOT", "HYPE.SPOT"],
    "interval": "1h",
    "lookback": 1100,
    "max_leverage": 1.0,
    "max_gross_exposure": 1.0,
    "params": {"window": 72, "z_window": 504, "min_rate_apr": 0.15, "persistence": 0.75, "z_full": 2.0,
               "gross": 0.9},
}

SECONDS_PER_YEAR = 365.0 * 86400.0
SPOT = ".SPOT"


def carry_strength(df, window, z_window, min_rate_apr, persistence, z_full):
    """0..1: how strongly funding says 'longs are paying, persistently, more than usual'. 0 when it does not."""
    if "funding" not in df.columns or window < 2 or z_window < 2 * window or z_full <= 0:
        return 0.0
    rate = df["funding"].to_numpy()
    if len(rate) < z_window or len(df) < 2:
        return 0.0
    rate = rate[-z_window:]
    if np.isnan(rate).mean() > 0.1:                      # too many settlements missing to say anything
        return 0.0
    rate = np.where(np.isnan(rate), 0.0, rate)
    recent = rate[-window:]
    bar_seconds = (df.index[-1] - df.index[-2]).total_seconds()
    apr = recent.mean() * SECONDS_PER_YEAR / bar_seconds
    if apr < min_rate_apr or (recent > 0).mean() < persistence:
        return 0.0
    means = np.lib.stride_tricks.sliding_window_view(rate, window).mean(axis=1)
    spread = means.std(ddof=1)
    if not spread > 0:
        return 0.0
    z = (means[-1] - means.mean()) / spread
    return float(min(max(z / z_full, 0.0), 1.0))


def target_weights(data, params):
    window, z_window = int(params["window"]), int(params["z_window"])
    gross = min(float(params["gross"]), 1.0)             # half in spot, half short: never more than the equity
    weights = {symbol: 0.0 for symbol in data}
    pairs = [s for s in data if not s.endswith(SPOT) and s + SPOT in data]
    if not pairs:
        return weights
    leg = gross / (2.0 * len(pairs))
    for symbol in pairs:
        strength = carry_strength(data[symbol], window, z_window, float(params["min_rate_apr"]),
                                  float(params["persistence"]), float(params["z_full"]))
        weights[symbol] = -strength * leg                # short the perpetual
        weights[symbol + SPOT] = strength * leg          # hold the same notional of the asset
    return weights
