# har_rv_perp / 1

**Hypothesis.** Realised volatility is forecastable from its own daily, weekly and longer averages (the HAR-RV
model of Corsi, 2009), better than from a single trailing window. Sizing a long/short trend position by the
FORECAST volatility, and standing aside when the forecast is far above normal, should give a steadier risk than
sizing by trailing volatility (`ma_trend_perp/1`).

**Mechanism.** Daily realised variance = sum of the 24 squared hourly log-returns of a day (days counted backwards
from the decision bar). Least squares, on the 50 days of the window, of the next day's variance on today's, the
7-day mean and the 14-day mean (the "month" of the original model is shortened to 14 days because the venue only
serves about 208 days of hourly candles). The forecast, annualised, sets the size: `min(max_weight, (target_vol /
N) / forecast_vol)` of equity per asset, on the side of the trend (close above or below its 120-hour mean).
**Regime**: no position in an asset whose forecast volatility is more than 1.5 × its median daily volatility of the
window. One decision per day (the pipeline runs it with `--decision-every har_rv_perp=24`); the model does not
change within a day.

**What would refute it.** A regression on about 35 daily points is weak: if the forecast is no better than the
trailing 7-day mean, this strategy is `ma_trend_perp` with a noisier size, and its results should be read that
way. Refuted if the realised volatility of the strategy is not steadier than that of `ma_trend_perp/1`, or if the
regime filter removes the days that made the money (large trends start with volatility above normal).
Volatility forecasting says nothing about direction: the side is a plain trend rule, and all the directional risk
of trend following remains.

Parameters were written before any backtest on the Hyperliquid data and are not tuned on the test split.
