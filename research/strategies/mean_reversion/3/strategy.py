"""Mean reversion: buy an asset in proportion to how far it trades below its recent average (z-score).

Universe-generic (version 3): the symbols are whatever the agent trades; same rule and parameters as version 1.
"""

import numpy as np

META = {
    "name": "mean_reversion",
    "version": "3",
    "universe": ["*"],
    "interval": "1h",
    "lookback": 200,
    "params": {"window": 48, "z_full": 2.0},
}


def target_weights(data, params):
    window, z_full = int(params["window"]), float(params["z_full"])
    n = len(data)
    weights = {}
    for symbol, df in data.items():
        close = df["close"].to_numpy()
        if len(close) < window or window < 2 or z_full <= 0:
            weights[symbol] = 0.0
            continue
        recent = close[-window:]
        std = recent.std(ddof=1)
        if not std > 0:
            weights[symbol] = 0.0
            continue
        z = (close[-1] - recent.mean()) / std
        weights[symbol] = float(np.clip(-z / z_full, 0.0, 1.0)) / n
    return weights
