"""Long/short time-series momentum on perpetuals: long an asset whose past return is positive, short otherwise."""

import numpy as np

META = {
    "name": "ts_momentum_perp",
    "version": "1",
    "kind": "perp",
    "universe": ["BTC", "ETH", "SOL", "HYPE"],
    "interval": "1h",
    "lookback": 400,
    "max_leverage": 2.0,
    "max_gross_exposure": 2.0,
    "params": {"window": 168, "gross": 1.0},
}


def target_weights(data, params):
    window, gross = int(params["window"]), float(params["gross"])
    n = len(data)
    weights = {}
    for symbol, df in data.items():
        close = df["close"].to_numpy()
        if window < 1 or len(close) < window + 1:
            weights[symbol] = 0.0
            continue
        past = close[-1] / close[-1 - window] - 1.0
        weights[symbol] = float(np.sign(past)) * gross / n
    return weights
