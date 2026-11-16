"""Cross-sectional momentum with volatility scaling: long the relative winners, short the relative losers."""

import numpy as np

META = {
    "name": "momentum_xs_perp",
    "version": "2",
    "kind": "perp",
    "universe": ["BTC", "ETH", "SOL"],
    "interval": "1h",
    "lookback": 800,
    "max_leverage": 1.0,
    "max_gross_exposure": 1.0,
    "params": {"momentum_bars": 336, "skip_bars": 24, "vol_bars": 168, "target_vol": 0.3, "rebalance_bars": 24,
               "gross": 1.0},
}

SECONDS_PER_YEAR = 365.0 * 86400.0


def _anchor(index, rebalance_bars):
    """(bars to use, bar length in seconds). The signal is computed on the bars up to the last one whose CLOSE is
    a multiple of `rebalance_bars` bars since the epoch: it only changes there, so the book is rebalanced once per
    `rebalance_bars` bars and not on every bar."""
    if len(index) < 2:
        return len(index), 0.0
    step = (index[-1] - index[-2]).total_seconds()
    if not step > 0:
        return len(index), 0.0
    closes_since_epoch = int(round((index[-1].timestamp() + step) / step))
    return len(index) - closes_since_epoch % max(int(rebalance_bars), 1), step


def target_weights(data, params):
    momentum_bars, skip_bars = int(params["momentum_bars"]), int(params["skip_bars"])
    vol_bars, rebalance_bars = int(params["vol_bars"]), int(params["rebalance_bars"])
    target_vol, gross = float(params["target_vol"]), min(float(params["gross"]), 1.0)
    symbols = list(data)
    weights = {symbol: 0.0 for symbol in symbols}
    if len(symbols) < 2 or momentum_bars < 2 or vol_bars < 2 or skip_bars < 0 or target_vol <= 0 or gross <= 0:
        return weights
    used, step = _anchor(data[symbols[0]].index, rebalance_bars)
    need = max(momentum_bars + skip_bars, vol_bars) + 1
    if used < need or not step > 0:
        return weights
    score, vol = [], []
    for symbol in symbols:
        close = data[symbol]["close"].to_numpy()[:used]
        if len(close) < need or not (close > 0).all():
            return weights
        log_close = np.log(close)
        returns = np.diff(log_close[-vol_bars - 1:])
        sigma = returns.std(ddof=1)
        if not sigma > 0:
            return weights
        past = log_close[-1 - skip_bars] - log_close[-1 - skip_bars - momentum_bars]
        score.append(past / (sigma * np.sqrt(momentum_bars)))            # risk-adjusted past return
        vol.append(sigma * np.sqrt(SECONDS_PER_YEAR / step))             # annualised
    score, vol = np.array(score), np.array(vol)
    centred = score - score.mean()                                       # cross-sectional: winners minus losers
    spread = np.abs(centred).sum()
    if not spread > 0:
        return weights
    raw = centred / vol                                                  # inverse-volatility legs
    raw = raw / np.abs(raw).sum()                                        # sum of |weights| = 1
    book_vol = float(np.sqrt(((raw * vol) ** 2).sum()))                  # assets taken as uncorrelated: an upper bound is not claimed
    scale = min(gross, target_vol / book_vol) if book_vol > 0 else 0.0
    for symbol, value in zip(symbols, raw):
        weights[symbol] = float(value * scale)
    return weights
