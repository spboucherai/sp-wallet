"""Donchian channel breakout: enter on a new N-bar high, leave on a new M-bar low.

Universe-generic (version 3): the symbols are whatever the agent trades; same rule and parameters as version 1.
"""

import numpy as np

META = {
    "name": "donchian_breakout",
    "version": "3",
    "universe": ["*"],
    "interval": "1h",
    "lookback": 2200,
    "params": {"entry": 480, "exit": 240},
}


def _is_long(df, entry, exit_):
    """Replay the channel over the window: long if the most recent event is an upside breakout."""
    close = df["close"]
    upper = df["high"].rolling(entry).max().shift(1)   # highest high of the previous `entry` bars
    lower = df["low"].rolling(exit_).min().shift(1)    # lowest low of the previous `exit_` bars
    up = np.nonzero((close > upper).to_numpy())[0]
    down = np.nonzero((close < lower).to_numpy())[0]
    if len(up) == 0:
        return False
    return len(down) == 0 or up[-1] > down[-1]


def target_weights(data, params):
    entry, exit_ = int(params["entry"]), int(params["exit"])
    n = len(data)
    weights = {}
    for symbol, df in data.items():
        if len(df) <= max(entry, exit_) or entry < 1 or exit_ < 1:
            weights[symbol] = 0.0
            continue
        weights[symbol] = 1.0 / n if _is_long(df, entry, exit_) else 0.0
    return weights
