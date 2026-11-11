"""Volatility-regime filter: daily trend position, switched off when a GARCH(1,1) forecast announces high volatility."""

import numpy as np
from arch import arch_model

META = {
    "name": "garch_regime",
    "version": "1",
    "universe": ["ETH", "BTC", "LINK", "SOL"],
    "interval": "1h",
    "lookback": 4320,
    "params": {"trend_days": 30, "vol_ratio_max": 1.25, "min_days": 120},
}


def _daily_closes(df):
    """Last close of each COMPLETE UTC day (the current, unfinished day is dropped)."""
    index = df.index
    daily = df["close"].groupby(index.floor("D")).last()
    next_bar = index[-1] + (index[-1] - index[-2])
    if next_bar != next_bar.floor("D"):
        daily = daily.iloc[:-1]
    return daily.to_numpy()


def _calm_regime(returns_pct, vol_ratio_max):
    """True if the one-day-ahead GARCH(1,1) volatility is not above vol_ratio_max x the median fitted volatility."""
    model = arch_model(returns_pct, mean="Zero", vol="GARCH", p=1, q=1, rescale=False)
    fit = model.fit(disp="off", show_warning=False)
    if fit.convergence_flag != 0:
        return False
    forecast = float(np.sqrt(fit.forecast(horizon=1, reindex=False).variance.to_numpy()[-1, 0]))
    typical = float(np.median(np.asarray(fit.conditional_volatility)))
    if not (np.isfinite(forecast) and typical > 0):
        return False
    return forecast <= vol_ratio_max * typical


def target_weights(data, params):
    trend_days, min_days = int(params["trend_days"]), int(params["min_days"])
    vol_ratio_max = float(params["vol_ratio_max"])
    n = len(data)
    weights = {}
    for symbol, df in data.items():
        weights[symbol] = 0.0
        if len(df) < 3:
            continue
        daily = _daily_closes(df)
        if len(daily) < max(min_days, trend_days) + 1:
            continue
        if not daily[-1] > daily[-trend_days:].mean():
            continue
        returns_pct = 100.0 * np.diff(np.log(daily))
        if _calm_regime(returns_pct, vol_ratio_max):
            weights[symbol] = 1.0 / n
    return weights
