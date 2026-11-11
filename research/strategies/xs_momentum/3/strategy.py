"""Cross-sectional momentum: hold the assets of the universe with the highest past return.

Universe-generic (version 3): the symbols are whatever the agent trades; same rule and parameters as version 1.
"""

META = {
    "name": "xs_momentum",
    "version": "3",
    "universe": ["*"],
    "min_symbols": 3,
    "interval": "1h",
    "lookback": 1500,
    "params": {"window": 720, "top_k": 2},
}


def target_weights(data, params):
    window, top_k = int(params["window"]), int(params["top_k"])
    past = []
    for symbol, df in data.items():
        close = df["close"].to_numpy()
        if len(close) > window:
            past.append((-(close[-1] / close[-1 - window] - 1.0), symbol))
    weights = {symbol: 0.0 for symbol in data}
    if top_k < 1 or len(data) < 3 or len(past) < 2:   # a ranking needs at least 3 symbols: cash otherwise
        return weights
    winners = sorted(past)[:min(top_k, len(past))]   # best return first, ties broken by symbol
    for _, symbol in winners:
        weights[symbol] = 1.0 / len(winners)
    return weights
