"""Volatility breakout: follow a move that is large against the volatility that preceded it, for a fixed time."""

import numpy as np

META = {
    "name": "vol_breakout_perp",
    "version": "1",
    "kind": "perp",
    "universe": ["BTC", "ETH", "SOL", "HYPE"],
    "interval": "1h",
    "lookback": 500,
    "max_leverage": 2.0,
    "max_gross_exposure": 2.0,
    "params": {"move_window": 24, "vol_window": 168, "k": 2.0, "hold": 48, "gross": 1.0},
}


def _last_breakout(close, move_window, vol_window, k, hold):
    """Side (+1 / -1) of the most recent breakout among the last `hold` bars, 0 if there is none.

    A breakout at bar t: |log(close[t] / close[t - move_window])| > k x sigma, where sigma is the standard
    deviation of the `vol_window` one-bar log-returns that END where the move starts, scaled to the move's length.
    """
    logp = np.log(close)
    n = len(logp)
    for t in range(n - 1, max(n - 1 - hold, move_window + vol_window - 1), -1):
        start = t - move_window
        move = logp[t] - logp[start]
        returns = np.diff(logp[start - vol_window:start + 1])
        sigma = returns.std(ddof=1) * np.sqrt(move_window)
        if sigma > 0 and abs(move) > k * sigma:
            return 1.0 if move > 0 else -1.0
    return 0.0


def target_weights(data, params):
    move_window, vol_window, hold = int(params["move_window"]), int(params["vol_window"]), int(params["hold"])
    k, gross = float(params["k"]), float(params["gross"])
    n = len(data)
    weights = {}
    for symbol, df in data.items():
        close = df["close"].to_numpy()
        if move_window < 1 or vol_window < 3 or hold < 1 or k <= 0 or len(close) < move_window + vol_window + 1:
            weights[symbol] = 0.0
            continue
        weights[symbol] = _last_breakout(close, move_window, vol_window, k, hold) * gross / n
    return weights
