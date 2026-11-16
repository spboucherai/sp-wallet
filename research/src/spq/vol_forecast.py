"""Volatility forecasts as a research TOOL: HAR-RV and GARCH(1,1) against simple baselines, evaluated out of
sample with QLIKE and MSE against realised variance.

    rv = daily_realised_variance(hourly_closes)             # sum of squared hourly log returns per UTC day
    table = evaluate(rv, daily_returns, min_train=60)       # expanding window, one-day-ahead, every model

Forecasts (all for NEXT day's variance, using data up to and including today — no look-ahead: the model of day t
is fitted on days <= t and scored on day t+1):
- `random_walk`  tomorrow = today's RV
- `ewma`         exponentially weighted mean of past RV (lambda 0.94, RiskMetrics)
- `har`          Corsi (2009): RV[t+1] = b0 + b1 RV[t] + b2 mean(RV[t-6..t]) + b3 mean(RV[t-29..t]), OLS on the
                 expanding window; a crypto week is 7 days and a month 30 (24/7 market). Forecast floored at half of
                 the smallest RV seen so far (a linear model can go negative).
- `garch`        GARCH(1,1), zero mean, normal errors, fitted on daily close-to-close returns (the `arch` package);
                 its forecast is a variance of DAILY returns, scored against RV like the others.

Losses (Patton 2011: both are robust to noise in the volatility proxy):
- MSE   = mean((RV - h)^2)
- QLIKE = mean(RV / h - log(RV / h) - 1)        (0 for a perfect forecast; punishes under-prediction more)

`har_forecast` is the function another strategy can use for sizing (`har_rv_perp` carries its own copy inside its
hashed file, as a strategy must). Nothing here trades.
"""
from __future__ import annotations

import math
import warnings

import numpy as np
import pandas as pd

WEEK, MONTH = 7, 30
MODELS = ("random_walk", "ewma", "har", "garch")


def daily_realised_variance(close: pd.Series, min_bars: int = 20) -> pd.Series:
    """Sum of squared intraday log returns per UTC day; days with fewer than `min_bars` returns are dropped."""
    r = np.log(close).diff().dropna()
    g = r.groupby(r.index.floor("D"))
    rv = g.apply(lambda x: float((x ** 2).sum()))
    return rv[g.size() >= min_bars]


def daily_returns(close: pd.Series) -> pd.Series:
    last = close.groupby(close.index.floor("D")).last()
    return np.log(last).diff().dropna()


def har_design(rv: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(X, y) with X[t] = [1, RV[t], mean RV[t-6..t], mean RV[t-29..t]] and y[t] = RV[t+1], for t >= MONTH-1."""
    n = len(rv)
    rows, y = [], []
    for t in range(MONTH - 1, n - 1):
        rows.append([1.0, rv[t], rv[t - WEEK + 1:t + 1].mean(), rv[t - MONTH + 1:t + 1].mean()])
        y.append(rv[t + 1])
    return np.array(rows), np.array(y)


def har_forecast(rv_history) -> float | None:
    """One-day-ahead HAR-RV forecast from a history of daily realised variances (oldest first). None when the
    history is too short (fewer than MONTH + 10 days)."""
    rv = np.asarray(rv_history, dtype="float64")
    if len(rv) < MONTH + 10 or not np.isfinite(rv).all():
        return None
    X, y = har_design(rv)
    beta = np.linalg.lstsq(X, y, rcond=None)[0]
    x = np.array([1.0, rv[-1], rv[-WEEK:].mean(), rv[-MONTH:].mean()])
    return float(max(x @ beta, 0.5 * rv.min()))


def ewma_forecast(rv_history, lam: float = 0.94) -> float:
    rv = np.asarray(rv_history, dtype="float64")
    w = lam ** np.arange(len(rv) - 1, -1, -1)
    return float((w * rv).sum() / w.sum())


def garch_forecast(returns_history) -> float | None:
    """One-day-ahead variance of a zero-mean GARCH(1,1) fitted on daily returns. None when the fit fails."""
    from arch import arch_model

    r = np.asarray(returns_history, dtype="float64") * 100.0          # percent: the optimiser's preferred scale
    if len(r) < 50:
        return None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            fit = arch_model(r, mean="Zero", vol="GARCH", p=1, q=1, rescale=False).fit(disp="off", show_warning=False)
            h = float(fit.forecast(horizon=1, reindex=False).variance.to_numpy()[-1, 0]) / 1e4
    except Exception:  # noqa: BLE001 - a failed fit is reported as a missing forecast, not as a zero
        return None
    return h if math.isfinite(h) and h > 0 else None


def qlike(rv, h) -> float:
    ratio = np.asarray(rv, dtype="float64") / np.asarray(h, dtype="float64")
    return float(np.mean(ratio - np.log(ratio) - 1.0))


def mse(rv, h) -> float:
    return float(np.mean((np.asarray(rv, dtype="float64") - np.asarray(h, dtype="float64")) ** 2))


def forecasts(rv: pd.Series, returns: pd.Series, min_train: int = 60) -> pd.DataFrame:
    """Expanding-window one-day-ahead forecasts. Row of day d: the realised variance of d and each model's forecast
    made at the end of day d-1 from days <= d-1."""
    days = rv.index
    out = []
    for i in range(min_train, len(days)):
        hist = rv.iloc[:i].to_numpy()
        rets = returns[returns.index < days[i]].to_numpy()
        out.append({"day": days[i], "rv": float(rv.iloc[i]), "random_walk": float(hist[-1]),
                    "ewma": ewma_forecast(hist), "har": har_forecast(hist), "garch": garch_forecast(rets)})
    return pd.DataFrame(out).set_index("day") if out else pd.DataFrame(columns=["rv", *MODELS])


def evaluate(rv: pd.Series, returns: pd.Series, min_train: int = 60, fractions=(0.6, 0.2, 0.2)) -> dict:
    """QLIKE and MSE of every model on the chronological train / validation / test thirds of the forecast days,
    plus the Mincer-Zarnowitz R^2 (RV regressed on the forecast) on all of them."""
    f = forecasts(rv, returns, min_train)
    n = len(f)
    out: dict = {"forecast_days": int(n), "first": f.index[0].isoformat() if n else None,
                 "last": f.index[-1].isoformat() if n else None, "min_train_days": int(min_train), "splits": {}}
    if n < 10:
        return out
    i1, i2 = int(n * fractions[0]), int(n * (fractions[0] + fractions[1]))
    for name, part in (("train", f.iloc[:i1]), ("validation", f.iloc[i1:i2]), ("test", f.iloc[i2:]), ("all", f)):
        row = {"days": int(len(part))}
        for m in MODELS:
            ok = part[m].notna()
            if ok.sum() < 5:
                row[m] = None
                continue
            y, h = part.loc[ok, "rv"].to_numpy(), part.loc[ok, m].to_numpy(dtype="float64")
            row[m] = {"qlike": qlike(y, h), "mse": mse(y, h), "n": int(ok.sum()),
                      "mean_forecast_over_mean_rv": float(h.mean() / y.mean())}
            if name == "all":
                c = np.corrcoef(y, h)[0, 1]
                row[m]["mincer_zarnowitz_r2"] = float(c * c) if math.isfinite(c) else None
        valid = {m: row[m]["qlike"] for m in MODELS if row.get(m)}
        row["best_qlike"] = min(valid, key=valid.get) if valid else None
        out["splits"][name] = row
    return out
