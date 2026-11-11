"""Long/short moving-average trend with volatility targeting: side from two means, size from realised volatility."""

import numpy as np

META = {
    "name": "ma_trend_perp",
    "version": "1",
    "kind": "perp",
    "universe": ["BTC", "ETH", "SOL", "HYPE"],
    "interval": "1h",
    "lookback": 400,
    "max_leverage": 2.0,
    "max_gross_exposure": 4.0,
    "params": {"fast": 24, "slow": 120, "vol_window": 168, "target_vol": 0.6, "max_weight": 0.5},
}

SECONDS_PER_YEAR = 365.0 * 86400.0


def target_weights(data, params):
    fast, slow, vol_window = int(params["fast"]), int(params["slow"]), int(params["vol_window"])
    target_vol, max_weight = float(params["target_vol"]), min(float(params["max_weight"]), 1.0)
    n = len(data)
    weights = {}
    for symbol, df in data.items():
        close = df["close"].to_numpy()
        if len(close) < max(slow, vol_window + 1) or fast >= slow or fast < 1 or vol_window < 2:
            weights[symbol] = 0.0
            continue
        side = float(np.sign(close[-fast:].mean() - close[-slow:].mean()))
        bar_seconds = (df.index[-1] - df.index[-2]).total_seconds()
        log_returns = np.diff(np.log(close[-(vol_window + 1):]))
        realised = log_returns.std(ddof=1) * np.sqrt(SECONDS_PER_YEAR / bar_seconds)
        if not realised > 0:
            weights[symbol] = 0.0
            continue
        weights[symbol] = side * min(max_weight, target_vol / n / realised)
    return weights
