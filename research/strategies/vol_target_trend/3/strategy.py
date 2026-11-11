"""Volatility-targeted trend: trend-following position, scaled down when realised volatility is high.

Universe-generic (version 3): the symbols are whatever the agent trades; same rule and parameters as version 1.
"""

import numpy as np

META = {
    "name": "vol_target_trend",
    "version": "3",
    "universe": ["*"],
    "interval": "1h",
    "lookback": 1000,
    "params": {"fast": 72, "slow": 480, "vol_window": 168, "target_vol": 0.4},
}

SECONDS_PER_YEAR = 365.0 * 86400.0


def target_weights(data, params):
    fast, slow = int(params["fast"]), int(params["slow"])
    vol_window, target_vol = int(params["vol_window"]), float(params["target_vol"])
    n = len(data)
    weights = {}
    for symbol, df in data.items():
        close = df["close"].to_numpy()
        if len(close) < max(fast, slow, vol_window + 1) or fast >= slow or vol_window < 2:
            weights[symbol] = 0.0
            continue
        if not close[-fast:].mean() > close[-slow:].mean():
            weights[symbol] = 0.0
            continue
        bar_seconds = (df.index[-1] - df.index[-2]).total_seconds()
        log_returns = np.diff(np.log(close[-(vol_window + 1):]))
        realised = log_returns.std(ddof=1) * np.sqrt(SECONDS_PER_YEAR / bar_seconds)
        scale = min(1.0, target_vol / realised) if realised > 0 else 0.0
        weights[symbol] = scale / n
    return weights
