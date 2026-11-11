"""Every perp strategy of the library: contract, purity, valid weights, behaviour on hand-made situations,
and agreement between the backtester and the signal runner."""
from __future__ import annotations

import json
import subprocess
import sys

import numpy as np
import pandas as pd
import pytest

from conftest import LIBRARY, PERP_LIBRARY, ROOT, make_data
from spq.perp_engine import PerpConfig, run_perp_backtest
from spq.strategy import is_spot_leg, load_strategy, sha256_file, validate_perp_weights

EXPECTED = {"ts_momentum_perp", "ma_trend_perp", "zscore_reversion_perp", "pairs_coint_perp", "funding_carry_perp",
            "funding_carry_neutral_perp", "vol_breakout_perp", "har_rv_perp"}
IDS = [f"{d.parent.name}/{d.name}" for d in PERP_LIBRARY]
PERPS = ["BTC", "ETH", "SOL", "HYPE"]


def synthetic(strategy, n, seed, funding=1.25e-5):
    """Random walks with different drifts; a spot leg tracks its perpetual closely; funding has high episodes."""
    drifts = [0.0005, -0.0004, 0.0002, 0.0]
    out = {}
    rng = np.random.default_rng(seed)
    for i, sym in enumerate(s for s in strategy.universe if not is_spot_leg(s)):
        df = make_data(n, (sym,), seed=seed + 31 * i, drift=drifts[i % 4], sigma=0.012, p0=50.0 * (i + 1))[sym]
        f = np.full(n, funding) + rng.normal(0, 2e-6, n)
        for start in range(200 + 150 * i, n, 900):                 # episodes of persistently high funding
            f[start:start + 250] += 6e-5
        out[sym] = df.assign(funding=f, premium=f * 8)
    if strategy.name == "pairs_coint_perp":           # a cointegrated pair: ETH follows BTC plus a stationary spread
        noise = np.zeros(n)
        shocks = rng.normal(0, 0.004, n)
        for t in range(1, n):
            noise[t] = 0.9 * noise[t - 1] + shocks[t]
        btc = out["BTC"]
        factor = 0.05 * np.exp(1.1 * np.log(btc["close"].to_numpy() / 50.0) + noise) * 50.0 / btc["close"].to_numpy()
        eth = btc[["open", "high", "low", "close"]].mul(factor, axis=0)
        eth["open"] = np.concatenate([[eth["close"].iloc[0]], eth["close"].to_numpy()[:-1]])
        eth["high"] = eth[["open", "close"]].max(axis=1) * 1.001
        eth["low"] = eth[["open", "close"]].min(axis=1) * 0.999
        out["ETH"] = eth.assign(volume=1.0, funding=out["ETH"]["funding"], premium=out["ETH"]["premium"])
    for sym in strategy.universe:
        if is_spot_leg(sym):
            base = out[sym[:-5]]
            out[sym] = base[["open", "high", "low", "close", "volume"]] * 1.0004
    return {s: out[s] for s in strategy.universe}


def test_the_perp_library_is_complete_and_the_spot_library_is_untouched():
    assert {d.parent.name for d in PERP_LIBRARY} == EXPECTED
    assert not any(d.parent.name.endswith("_perp") for d in LIBRARY)
    assert {d.parent.name for d in LIBRARY} == {"ts_momentum", "ma_trend", "mean_reversion", "donchian_breakout",
                                                "vol_target_trend", "xs_momentum", "pairs_rotation", "garch_regime"}
    assert all(load_strategy(d).kind == "spot" for d in LIBRARY)
    for d in PERP_LIBRARY:
        readme = (d / "README.md").read_text()
        assert "**Hypothesis.**" in readme and "**Mechanism.**" in readme and "**What would refute it.**" in readme, d
        assert "before any backtest" in readme, d
    assert "directional" in (ROOT / "strategies/funding_carry_perp/1/README.md").read_text()
    lab = " ".join((ROOT / "README.md").read_text().lower().split())
    assert "order-book" in lab and "cannot be backtested" in lab     # microstructure strategies are not faked


@pytest.mark.parametrize("directory", PERP_LIBRARY, ids=IDS)
def test_perp_strategy_contract(directory):
    s = load_strategy(directory)                      # strict: passes the static purity check
    assert s.kind == "perp" and s.static_problems == [] and s.sha256 == sha256_file(directory / "strategy.py")
    assert s.name == directory.parent.name and s.meta["version"] == directory.name and s.meta["interval"] == "1h"
    perps = [x for x in s.universe if not is_spot_leg(x)]
    assert set(perps) <= set(PERPS) and s.meta["max_leverage"] <= 2.0 and s.lookback <= 1200
    lev, cap = s.meta["max_leverage"], s.meta["max_gross_exposure"]

    full = synthetic(s, s.lookback + 600, seed=5)
    active = False
    for end in range(s.lookback, s.lookback + 600, 67):
        view = {sym: df.iloc[end - s.lookback:end] for sym, df in full.items()}
        before = {sym: df.copy() for sym, df in view.items()}
        raw = s.raw(view)
        w = validate_perp_weights(raw, s.universe, lev, cap)
        assert set(w) == set(s.universe) and sum(abs(x) for x in w.values()) <= cap + 1e-9
        assert all(0 <= w[x] <= 1 for x in s.universe if is_spot_leg(x))
        assert s.raw(view) == raw                     # pure: same inputs, same output
        for sym in view:
            pd.testing.assert_frame_equal(view[sym], before[sym])   # inputs are not modified
        active |= any(x != 0 for x in w.values())
    assert active, "the strategy never took a position on the synthetic data"

    # degenerate inputs never raise and never produce an invalid allocation
    tiny = {sym: df.iloc[:3] for sym, df in full.items()}
    assert all(x == 0 for x in validate_perp_weights(s.raw(tiny), s.universe, lev, cap).values())
    flat = {sym: df.assign(open=10.0, high=10.0, low=10.0, close=10.0).iloc[:s.lookback] for sym, df in full.items()}
    validate_perp_weights(s.raw(flat), s.universe, lev, cap)
    no_funding = {sym: df.drop(columns=[c for c in ("funding", "premium") if c in df.columns]).iloc[:s.lookback]
                  for sym, df in full.items()}
    validate_perp_weights(s.raw(no_funding), s.universe, lev, cap)
    nan_funding = {sym: (df.assign(funding=np.nan) if "funding" in df.columns else df).iloc[:s.lookback]
                   for sym, df in full.items()}
    validate_perp_weights(s.raw(nan_funding), s.universe, lev, cap)
    subset = s.universe[:1] if s.name != "pairs_coint_perp" else s.universe
    validate_perp_weights(s.raw({sym: full[sym].iloc[:s.lookback] for sym in subset}), subset, lev, cap)
    # the default sensitivity grid (every numeric parameter halved and doubled) stays inside the caps
    from spq.research import one_at_a_time_grid

    view = {sym: df.iloc[-s.lookback:] for sym, df in full.items()}
    for params in one_at_a_time_grid(s.params):
        validate_perp_weights(s.raw(view, params), s.universe, lev, cap)


@pytest.mark.parametrize("directory", PERP_LIBRARY, ids=IDS)
def test_perp_strategy_runs_in_the_backtester_and_the_signal_runner(directory, tmp_path):
    s = load_strategy(directory)
    every = 24 if s.name == "har_rv_perp" else (4 if s.name == "pairs_coint_perp" else 1)
    n = s.lookback + (24 * 12 if every == 24 else 300)
    data = synthetic(s, n, seed=9)
    res = run_perp_backtest(s, data, PerpConfig("1h", rebalance_threshold=0.05, decision_every=every))
    assert len(res.decisions) > 0 and np.isfinite(res.equity.to_numpy()).all() and (res.equity > 0).all()
    assert res.ledger["reconciles"] and not res.wiped_out and res.liquidations == []
    assert res.exposure.max() <= s.meta["max_gross_exposure"] * 1.25      # prices move between two rebalancings

    perps = [x for x in s.universe if not is_spot_leg(x)]
    stamp = lambda ts: ts.strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
    payload = {
        "candles": {sym: [[stamp(ts), *map(float, row)] for ts, row in
                          zip(df.index[-s.lookback:], df[["open", "high", "low", "close", "volume"]].to_numpy()[-s.lookback:])]
                    for sym, df in data.items()},
        "funding": {sym: [[stamp(ts), float(f)] for ts, f in zip(data[sym].index[-s.lookback:],
                                                                data[sym]["funding"].to_numpy()[-s.lookback:])]
                    for sym in perps}}
    f = tmp_path / "in.json"
    f.write_text(json.dumps(payload))
    cmd = [sys.executable, "-m", "spq.signal", "--strategy", str(directory), "--sha256", s.sha256, "--input", str(f)]
    p = subprocess.run(cmd + ["--contract", "2"], capture_output=True, text=True, cwd=ROOT, timeout=300)
    assert p.returncode == 0, p.stderr
    out = json.loads(p.stdout)
    last_bar = data[perps[0]].index[-1]
    assert out["schema_version"] == 2 and out["strategy_sha256"] == s.sha256 and out["as_of"] == stamp(last_bar)
    if res.decisions.index[-1] == last_bar:           # the engine's entry point = the backtest's last decision
        assert out["weights"] == pytest.approx(res.decisions.iloc[-1].to_dict(), abs=1e-12)
    # a caller that only knows the spot contract gets nothing
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT, timeout=300)
    assert p.returncode == 2 and p.stdout == ""
    p = subprocess.run([sys.executable, "-m", "spq.describe", "--strategy", str(directory)], capture_output=True,
                       text=True, cwd=ROOT, timeout=120)
    assert p.returncode == 4 and p.stdout == ""


def load(name):
    return load_strategy(ROOT / "strategies" / name / "1")


def series(closes, start="2024-01-01"):
    c = np.asarray(closes, float)
    idx = pd.date_range(start, periods=len(c), freq="1h", tz="UTC", name="ts")
    return pd.DataFrame({"open": c, "high": c, "low": c, "close": c, "volume": 1.0, "funding": 1.25e-5}, index=idx)


def test_momentum_goes_long_what_rose_and_short_what_fell():
    s = load("ts_momentum_perp")
    up, down = np.linspace(100, 150, 400), np.linspace(100, 60, 400)
    w = s({"BTC": series(up), "ETH": series(down), "SOL": series(up), "HYPE": series(down)})
    assert w == {"BTC": 0.25, "ETH": -0.25, "SOL": 0.25, "HYPE": -0.25}


def test_ma_trend_sizes_inversely_to_volatility():
    s = load("ma_trend_perp")
    rng = np.random.default_rng(0)
    calm = 100 * np.exp(np.cumsum(0.0008 + rng.normal(0, 0.002, 400)))
    wild = 100 * np.exp(np.cumsum(-0.0030 + rng.normal(0, 0.02, 400)))
    w = s({"BTC": series(calm), "ETH": series(wild), "SOL": series(calm), "HYPE": series(wild)})
    assert w["BTC"] > 0 > w["ETH"] and abs(w["BTC"]) > 3 * abs(w["ETH"])
    assert w["BTC"] == 0.5                                         # capped at max_weight: 0.15 / 0.19 > 0.5
    vol = np.diff(np.log(wild[-169:])).std(ddof=1) * np.sqrt(8760)
    assert w["ETH"] == pytest.approx(-0.6 / 4 / vol)


def test_zscore_reversion_fades_a_spike_exits_at_the_mean_and_stops_on_a_runaway():
    s = load("zscore_reversion_perp")
    rng = np.random.default_rng(1)
    base = 100 + rng.normal(0, 0.2, 300)

    def w(closes):
        return s({"BTC": series(closes), "ETH": series(base), "SOL": series(base), "HYPE": series(base)})["BTC"]

    spike = base.copy()
    spike[-1] += 0.2 * 3                                            # about 3 standard deviations above the mean
    assert w(spike) == -0.25                                        # fade it: short
    dip = base.copy()
    dip[-1] -= 0.2 * 3
    assert w(dip) == 0.25
    back = spike.copy()
    back = np.append(back[1:], 100.0)                               # next bar: back at the mean -> flat
    assert w(back) == 0.0
    runaway = base.copy()
    runaway[-6:] += np.array([0.6, 0.9, 1.3, 2.0, 3.5, 6.0])        # keeps going: |z| > 4 -> stopped out
    assert w(runaway) == 0.0
    assert w(base) == 0.0


def test_pairs_trades_a_stretched_stationary_spread_market_neutral():
    s = load("pairs_coint_perp")
    rng = np.random.default_rng(2)
    n = 800
    common = np.cumsum(rng.normal(0, 0.01, n))
    noise = np.zeros(n)
    for t in range(1, n):
        noise[t] = 0.7 * noise[t - 1] + rng.normal(0, 0.002)        # stationary spread
    btc = 60000 * np.exp(common)
    eth = 3000 * np.exp(1.2 * common + noise)
    calm = s({"BTC": series(btc), "ETH": series(eth)})
    stretched = eth.copy()
    stretched[-1] *= np.exp(3.0 * noise[-336:].std())               # ETH suddenly rich against BTC
    w = s({"BTC": series(btc), "ETH": series(stretched)})
    assert w["ETH"] < 0 < w["BTC"]                                  # short the rich leg, long the other
    beta = w["BTC"] / -w["ETH"]
    assert 1.0 < beta < 1.4 and abs(w["ETH"]) + abs(w["BTC"]) == pytest.approx(1.0)
    assert abs(calm["ETH"]) + abs(calm["BTC"]) in (0.0, pytest.approx(1.0))
    # two independent random walks: the spread is not stationary, nothing is traded
    other = 3000 * np.exp(np.cumsum(rng.normal(0, 0.01, n)))
    w = s({"BTC": series(btc), "ETH": series(other)})
    assert w == {"BTC": 0.0, "ETH": 0.0}


def test_funding_carry_shorts_only_persistent_large_funding_and_the_neutral_version_hedges_it():
    s, neutral = load("funding_carry_perp"), load("funding_carry_neutral_perp")
    n = 1100
    flat = np.full(n, 100.0)
    rng = np.random.default_rng(3)

    def frame(rate):
        return series(flat).assign(funding=rate)

    floor = np.full(n, 1.25e-5) + rng.normal(0, 1e-7, n)            # the venue's floor rate: 10.95 % a year
    high = floor.copy()
    high[-72:] = 6e-5                                               # 52 % a year for three days
    negative = floor.copy()
    negative[-72:] = -6e-5
    erratic = floor.copy()
    erratic[-72:] = np.where(np.arange(72) % 2 == 0, 3e-4, -2e-4)   # large on average, but not persistent
    data = {"BTC": frame(high), "ETH": frame(floor), "SOL": frame(negative), "HYPE": frame(erratic)}
    w = s(data)
    assert w == {"BTC": -0.25, "ETH": 0.0, "SOL": 0.0, "HYPE": 0.0}  # short the payer, at full size (z >> 2)
    spot = {f"{k}.SPOT": series(flat).drop(columns=["funding"]) for k in data}
    w = neutral({**data, **spot})
    assert w["BTC"] == pytest.approx(-0.1125) and w["BTC.SPOT"] == pytest.approx(0.1125)     # 0.9 / (2 x 4)
    assert sum(w.values()) == pytest.approx(0.0) and all(w[k] == 0 for k in ("ETH", "SOL", "HYPE", "ETH.SPOT"))
    # the decision only reads settlements up to the decision bar: appending a future one changes nothing
    later = {k: pd.concat([df, df.iloc[[-1]].set_axis(df.index[[-1]] + pd.Timedelta(hours=1)).assign(funding=-1.0)])
             for k, df in data.items()}
    assert s({k: df.iloc[:-1] for k, df in later.items()}) == s(data)


def test_vol_breakout_follows_a_large_move_for_a_while_then_stands_down():
    s = load("vol_breakout_perp")
    quiet = 100 * (1 + 0.002 * (-1.0) ** np.arange(500))            # +/- 0.2 % every bar, no 24-hour move at all

    def w(closes):
        return s({"BTC": series(closes), "ETH": series(quiet), "SOL": series(quiet), "HYPE": series(quiet)})["BTC"]

    assert w(quiet) == 0.0
    jump = quiet.copy()
    jump[-10:] *= 1.05                                              # +5 % in one bar, 10 bars ago
    assert w(jump) == 0.25
    crash = quiet.copy()
    crash[-10:] *= 0.95
    assert w(crash) == -0.25
    old = quiet.copy()
    old[-120:] *= 1.05                                              # the same jump 120 bars ago: beyond `hold`
    assert w(old) == 0.0


def test_har_forecast_sizes_down_in_volatile_regimes():
    s = load("har_rv_perp")
    rng = np.random.default_rng(5)

    def walk(sig, drift=0.0005):
        return 100 * np.exp(np.cumsum(drift + rng.normal(0, 1, 1200) * sig))

    calm = walk(np.full(1200, 0.003))
    sig = np.full(1200, 0.003)
    sig[-48:] = 0.03                                                # volatility explodes over the last two days
    turbulent = walk(sig)
    steady = walk(np.full(1200, 0.012))
    falling = walk(np.full(1200, 0.003), drift=-0.0005)
    w = s({"BTC": series(calm), "ETH": series(turbulent), "SOL": series(steady), "HYPE": series(falling)})
    assert w["BTC"] == 0.5                                          # low forecast volatility: capped at max_weight
    assert w["ETH"] == 0.0                                          # forecast far above the window's median: aside
    assert 0 < w["SOL"] < 0.25                                      # 0.15 / forecast volatility of about 110 %
    assert w["HYPE"] == -0.5                                        # a falling series is shorted
    # HAR needs enough days: with half the window nothing is forecast
    assert s({"BTC": series(calm[:300])}) == {"BTC": 0.0}
