"""Moving-average trend following: hold an asset while its fast average is above its slow average.

Universe-generic (version 3): the symbols are whatever the agent trades; same rule and parameters as version 1.
"""

META = {
    "name": "ma_trend",
    "version": "3",
    "universe": ["*"],
    "interval": "1h",
    "lookback": 1000,
    "params": {"fast": 72, "slow": 480},
}


def target_weights(data, params):
    fast, slow = int(params["fast"]), int(params["slow"])
    n = len(data)
    weights = {}
    for symbol, df in data.items():
        close = df["close"].to_numpy()
        if len(close) < max(fast, slow) or fast >= slow:
            weights[symbol] = 0.0
            continue
        weights[symbol] = 1.0 / n if close[-fast:].mean() > close[-slow:].mean() else 0.0
    return weights
