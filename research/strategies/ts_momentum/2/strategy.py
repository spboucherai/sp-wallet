"""Time-series momentum: hold an asset while its own past return is positive."""

META = {
    "name": "ts_momentum",
    "version": "2",
    "universe": ["ETH", "LINK", "AAVE"],
    "interval": "1h",
    "lookback": 1500,
    "params": {"window": 720},
}


def target_weights(data, params):
    window = int(params["window"])
    n = len(data)
    weights = {}
    for symbol, df in data.items():
        close = df["close"].to_numpy()
        if len(close) <= window:
            weights[symbol] = 0.0
            continue
        weights[symbol] = 1.0 / n if close[-1] > close[-1 - window] else 0.0
    return weights
