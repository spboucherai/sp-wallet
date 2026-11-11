"""Probabilistic and Deflated Sharpe Ratio.

Bailey, D. H. & López de Prado, M. (2014), "The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest
Overfitting and Non-Normality", Journal of Portfolio Management 40(5).

Everything here is in PER-PERIOD units (the Sharpe ratio of one bar, not annualised):

    PSR(SR*) = Phi( (SR - SR*) * sqrt(T - 1) / sqrt(1 - g3*SR + (g4 - 1)/4 * SR^2) )
    SR0      = sqrt(V[SR_n]) * ( (1 - gamma) * Phi^-1(1 - 1/N) + gamma * Phi^-1(1 - 1/(N e)) )
    DSR      = PSR(SR0)

SR: observed Sharpe ratio of the selected strategy, T: number of returns, g3: skewness, g4: kurtosis (3 for a
normal distribution, NOT excess kurtosis), N: number of independent trials, V[SR_n]: variance of the trials' Sharpe
ratios, gamma: Euler-Mascheroni constant. SR0 is the Sharpe ratio one expects from the best of N skill-less trials.
DSR is the probability that the true Sharpe ratio is positive once that selection is accounted for; the paper's
reading is that a value below 0.95 does not reject "no skill".

Caveats: trials are rarely independent (a parameter grid is highly correlated), so the nominal N overstates the
number of independent trials and makes the DSR conservative; the formula assumes the returns are stationary and
ignores serial correlation.
"""
from __future__ import annotations

import math

import numpy as np
from scipy import stats

EULER_GAMMA = 0.5772156649015329


def expected_max_sharpe(n_trials: int, var_trials: float) -> float:
    """SR0: expected maximum Sharpe ratio (per period) among `n_trials` trials with true Sharpe 0."""
    if n_trials < 1:
        raise ValueError("n_trials must be >= 1")
    if n_trials == 1 or not var_trials > 0:
        return 0.0
    z1 = stats.norm.ppf(1.0 - 1.0 / n_trials)
    z2 = stats.norm.ppf(1.0 - 1.0 / (n_trials * math.e))
    return math.sqrt(var_trials) * ((1.0 - EULER_GAMMA) * z1 + EULER_GAMMA * z2)


def probabilistic_sharpe(sr: float, sr_benchmark: float, n_obs: int, skew: float = 0.0, kurtosis: float = 3.0) -> float:
    """PSR: probability that the true per-period Sharpe exceeds `sr_benchmark`. NaN when undefined."""
    if n_obs < 2 or not math.isfinite(sr):
        return float("nan")
    radicand = 1.0 - skew * sr + (kurtosis - 1.0) / 4.0 * sr * sr
    if radicand <= 0:
        return float("nan")
    return float(stats.norm.cdf((sr - sr_benchmark) * math.sqrt(n_obs - 1) / math.sqrt(radicand)))


def deflated_sharpe(sr: float, n_obs: int, skew: float, kurtosis: float, n_trials: int, var_trials: float) -> float:
    return probabilistic_sharpe(sr, expected_max_sharpe(n_trials, var_trials), n_obs, skew, kurtosis)


def deflated_sharpe_from_returns(returns, trial_sharpes) -> dict:
    """DSR of a return series given the per-period Sharpe ratios of ALL the trials that were run.

    `trial_sharpes` must include every configuration tried (the selected one too). Returns the inputs with the
    result so that the report shows exactly what went into the number.
    """
    r = np.asarray(returns, dtype="float64")
    trials = np.asarray([s for s in trial_sharpes if s is not None and math.isfinite(s)], dtype="float64")
    n_trials = max(int(len(trials)), 1)
    var_trials = float(trials.var(ddof=1)) if len(trials) > 1 else 0.0
    sd = r.std(ddof=1) if len(r) > 1 else 0.0
    if len(r) < 3 or not sd > 0:
        return {"deflated_sharpe": None, "sharpe_per_bar": None, "expected_max_sharpe_per_bar": None,
                "n_obs": int(len(r)), "skew": None, "kurtosis": None, "n_trials": n_trials,
                "var_trial_sharpes": var_trials}
    sr = float(r.mean() / sd)
    skew = float(stats.skew(r))
    kurt = float(stats.kurtosis(r, fisher=False))
    sr0 = expected_max_sharpe(n_trials, var_trials)
    dsr = probabilistic_sharpe(sr, sr0, len(r), skew, kurt)
    return {
        "deflated_sharpe": dsr if math.isfinite(dsr) else None,
        "probabilistic_sharpe_vs_zero": probabilistic_sharpe(sr, 0.0, len(r), skew, kurt),
        "sharpe_per_bar": sr,
        "expected_max_sharpe_per_bar": sr0,
        "n_obs": int(len(r)),
        "skew": skew,
        "kurtosis": kurt,
        "n_trials": n_trials,
        "var_trial_sharpes": var_trials,
    }
