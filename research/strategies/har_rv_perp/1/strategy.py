"""HAR-RV volatility forecast used for sizing and regime: trend position scaled by tomorrow's forecast volatility."""

import numpy as np

META = {
    "name": "har_rv_perp",
    "version": "1",
    "kind": "perp",
    "universe": ["BTC", "ETH", "SOL", "HYPE"],
    "interval": "1h",
    "lookback": 1200,
    "max_leverage": 2.0,
    "max_gross_exposure": 4.0,
    "params": {"day": 24, "week_days": 7, "month_days": 14, "trend_window": 120, "target_vol": 0.6,
               "max_weight": 0.5, "regime_mult": 1.5},
}

DAYS_PER_YEAR = 365.0


def har_forecast(close, day, week_days, month_days):
    """(forecast of the next day's realised variance, median daily realised variance of the window), or None.

    Daily realised variance = sum of the squared one-bar log-returns of a block of `day` bars; the blocks are
    counted backwards from the newest bar. HAR (Corsi 2009): RV[t+1] = a + b RV[t] + c mean(RV[t-w+1..t])
    + d mean(RV[t-m+1..t]), fitted by least squares on the blocks of the window itself.
    """
    r2 = np.diff(np.log(close)) ** 2
    days = len(r2) // day
    if day < 2 or week_days < 2 or month_days <= week_days or days < month_days + 12:
        return None
    rv = r2[len(r2) - days * day:].reshape(days, day).sum(axis=1)
    csum = np.concatenate([[0.0], np.cumsum(rv)])
    t = np.arange(month_days - 1, days)                       # blocks that have a full "month" behind them
    x = np.column_stack([np.ones(len(t)), rv[t], (csum[t + 1] - csum[t + 1 - week_days]) / week_days,
                         (csum[t + 1] - csum[t + 1 - month_days]) / month_days])
    coef = np.linalg.lstsq(x[:-1], rv[t[1:]], rcond=None)[0]  # row of block t explains block t+1
    forecast = float(x[-1] @ coef)
    floor = float(rv[rv > 0].min()) if (rv > 0).any() else 0.0
    return max(forecast, floor), float(np.median(rv))


def target_weights(data, params):
    day, week_days, month_days = int(params["day"]), int(params["week_days"]), int(params["month_days"])
    trend_window = int(params["trend_window"])
    target_vol, max_weight = float(params["target_vol"]), min(float(params["max_weight"]), 1.0)
    regime_mult = float(params["regime_mult"])
    n = len(data)
    weights = {}
    for symbol, df in data.items():
        close = df["close"].to_numpy()
        weights[symbol] = 0.0
        if trend_window < 2 or len(close) < trend_window + 1:
            continue
        fit = har_forecast(close, day, week_days, month_days)
        if fit is None:
            continue
        forecast, median = fit
        if not forecast > 0 or forecast > regime_mult * regime_mult * median:   # variance: the multiple is squared
            continue                                                           # turbulent regime: stand aside
        bars_per_day = 86400.0 / (df.index[-1] - df.index[-2]).total_seconds()
        vol = np.sqrt(forecast * bars_per_day / day * DAYS_PER_YEAR)           # annualised forecast volatility
        side = float(np.sign(close[-1] - close[-trend_window:].mean()))
        weights[symbol] = side * min(max_weight, target_vol / n / vol)
    return weights
