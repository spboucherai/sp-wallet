"""Moving-average trend following: hold an asset while its fast average is above its slow average."""

META = {
    "name": "ma_trend",
    "version": "1",
    "universe": ["ETH", "BTC", "LINK", "SOL"],
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
