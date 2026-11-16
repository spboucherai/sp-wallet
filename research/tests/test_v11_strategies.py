"""Every V11 strategy: contract, purity lint, valid weights, behaviour on hand-made situations, the mandatory
look-ahead check under the V11 execution model, and agreement between the backtester and the signal runner."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from conftest import LIBRARY, PERP_LIBRARY, ROOT, V11_LIBRARY, make_series
from v11_helpers import AS_OF, synthetic_store

from spq.data.multivenue import load_multivenue
from spq.execution import ExecutionModel, load_parity
from spq.perp_engine import PerpConfig, run_perp_backtest
from spq.purity import check
from spq.research import one_at_a_time_grid
from spq.robustness import lookahead_check
from spq.signal import compute_signal, iso_z
from spq.strategy import is_spot_leg, load_strategy, sha256_file, validate_perp_weights

IDS = [f"{d.parent.name}/{d.name}" for d in V11_LIBRARY]
EXPECTED = {"momentum_xs_perp/1", "momentum_xs_perp/2", "mean_reversion_bands_perp/1", "mean_reversion_bands_perp/2",
            "statarb_basket_perp/1", "basis_cash_carry/1", "funding_arb_cross_venue/1"}
PINNED = ["BTC", "ETH", "SOL"]                       # packages/derivatives/src/live/hl-assets.ts: the live-pinned set
GENERIC_SYMBOLS = ["BTC", "ETH", "LINK", "SOL", "AAVE"]


def symbols_of(s):
    return GENERIC_SYMBOLS if s.generic else s.universe


def _ou(n, rng, rho, sigma):
    x = np.zeros(n)
    e = rng.normal(0, sigma, n)
    for t in range(1, n):
        x[t] = rho * x[t - 1] + e[t]
    return x


def _frame(close, idx, volume=1e5):
    o = np.concatenate([[close[0]], close[:-1]])
    return pd.DataFrame({"open": o, "high": np.maximum(o, close) * 1.0005, "low": np.minimum(o, close) * 0.9995,
                         "close": close, "volume": volume}, index=idx)


def synthetic(s, n, seed=5):
    """Data on which the strategy's own hypothesis is TRUE (it must then take positions), in the lab's symbols."""
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2026-01-01", periods=n, freq="1h", tz="UTC", name="ts")
    syms = symbols_of(s)
    out = {}
    if s.name == "funding_arb_cross_venue":
        raise AssertionError("use the synthetic store")
    perps = [x for x in syms if not is_spot_leg(x)]
    market = np.cumsum(rng.normal(0, 0.004, n))
    second = np.cumsum(rng.normal(0, 0.003, n))
    for i, sym in enumerate(perps):
        if s.name == "momentum_xs_perp":             # persistent, different drifts: winners keep winning
            close = 100.0 * (i + 1) * np.exp(np.cumsum(rng.normal((i - (len(perps) - 1) / 2) * 0.0006, 0.006, n)))
        elif s.name == "mean_reversion_bands_perp":  # a range: fast reversion around a level, with rare shocks
            x = _ou(n, rng, 0.9, 0.012)
            close = 100.0 * (i + 1) * np.exp(x)
        elif s.name == "statarb_basket_perp":        # two common factors + a mean-reverting residual per asset
            beta1, beta2 = 0.6 + 0.2 * i, (-1) ** i * 0.5
            close = 100.0 * (i + 1) * np.exp(beta1 * market + beta2 * second + _ou(n, rng, 0.9, 0.006))
        else:
            close = make_series(n, seed + 7 * i, sigma=0.006, p0=100.0 * (i + 1))["close"].to_numpy()
        f = np.full(n, 1.0e-6 if s.name == "basis_cash_carry" else 1.0e-5) + rng.normal(0, 1e-7, n)
        for a in range(250, n, 800):                 # episodes of persistently high funding (about 80 % a year)
            f[a:a + 400] += 8e-5
        out[sym] = _frame(close, idx).assign(funding=f, premium=f * 4)
    for sym in syms:
        if is_spot_leg(sym):
            base = out[sym[:-5]]
            out[sym] = base[["open", "high", "low", "close", "volume"]] / 1.0006      # the perpetual trades 6 bps rich
    return {x: out[x] for x in syms}


@pytest.fixture(scope="module")
def xvenue_data(tmp_path_factory):
    root = tmp_path_factory.mktemp("store")
    synthetic_store(root, n=1700)
    data, *_ = load_multivenue(["BTC", "BTC@EDGEX", "ETH", "ETH@EDGEX", "SOL", "SOL@EDGEX"], "1h", root=root, as_of=AS_OF)
    return data


def data_for(s, n, xvenue):
    if s.name == "funding_arb_cross_venue":
        return {k: v.iloc[:n] for k, v in xvenue.items()}
    return synthetic(s, n)


def v11_config(symbols):
    par, _, _ = load_parity()
    return PerpConfig(interval="1h", initial_cash=1000.0, venue_max_leverage={s: 20.0 for s in symbols},
                      size_decimals={s: 4 for s in symbols}, execution=ExecutionModel(), parity=par)


def test_the_v11_library_is_complete_and_the_older_libraries_are_untouched():
    assert set(IDS) == EXPECTED
    assert not ({d.parent.name for d in V11_LIBRARY} & {d.parent.name for d in LIBRARY + PERP_LIBRARY})
    assert (ROOT / "strategies_xvenue" / "funding_arb_cross_venue" / "1").is_dir()     # outside the API's library
    assert not (ROOT / "strategies" / "funding_arb_cross_venue").exists()
    for name in ("momentum_xs_perp", "mean_reversion_bands_perp"):                     # audit defect D1
        assert load_strategy(ROOT / "strategies" / name / "2").universe == PINNED
        one, two = [(ROOT / "strategies" / name / v / "strategy.py").read_text() for v in ("1", "2")]
        assert one.split("def ", 1)[1] == two.split("def ", 1)[1]                      # the same code, another universe


@pytest.mark.parametrize("directory", V11_LIBRARY, ids=IDS)
def test_v11_strategy_contract_and_purity(directory, xvenue_data):
    source = (directory / "strategy.py").read_text()
    assert check(source) == []                                         # the purity lint of docs/v8/SANDBOX.md
    s = load_strategy(directory)                                       # strict loader
    assert s.kind == "perp" and s.static_problems == [] and s.sha256 == sha256_file(directory / "strategy.py")
    assert s.name == directory.parent.name and s.meta["version"] == directory.name and s.meta["interval"] == "1h"
    assert s.meta["max_leverage"] <= 1.0 and s.meta["max_gross_exposure"] <= 1.0 and s.lookback <= 1000
    readme = (directory / "README.md").read_text()
    for part in ("**Hypothesis.**", "**Signal.**", "**Parameters.**", "**Costs assumed.**", "**Failure modes.**",
                 "**Result"):
        assert part in readme, (directory, part)
    assert "before any backtest" in readme
    syms = symbols_of(s)
    lev, cap = s.meta["max_leverage"], s.meta["max_gross_exposure"]
    full = data_for(s, s.lookback + 700, xvenue_data)
    active = False
    for end in range(s.lookback, s.lookback + 700, 61):
        view = {sym: df.iloc[end - s.lookback:end] for sym, df in full.items()}
        before = {sym: df.copy() for sym, df in view.items()}
        raw = s.raw(view)
        w = validate_perp_weights(raw, syms, lev, cap)
        assert set(w) == set(syms) and sum(abs(x) for x in w.values()) <= cap + 1e-9
        assert all(0 <= w[x] <= 1 for x in syms if is_spot_leg(x))
        assert s.raw(view) == raw                                      # pure: same inputs, same output
        for sym in view:
            pd.testing.assert_frame_equal(view[sym], before[sym])     # inputs are not modified
        active |= any(x != 0 for x in w.values())
    assert active, "the strategy never took a position on data where its hypothesis holds"
    # degenerate inputs never raise and never produce an invalid allocation
    tiny = {sym: df.iloc[:3] for sym, df in full.items()}
    assert all(x == 0 for x in validate_perp_weights(s.raw(tiny), syms, lev, cap).values())
    flat = {sym: df.assign(open=10.0, high=10.0, low=10.0, close=10.0).iloc[:s.lookback] for sym, df in full.items()}
    validate_perp_weights(s.raw(flat), syms, lev, cap)
    for change in (lambda df: df.drop(columns=[c for c in ("funding", "premium") if c in df.columns]),
                   lambda df: df.assign(funding=np.nan) if "funding" in df.columns else df):
        validate_perp_weights(s.raw({sym: change(df).iloc[:s.lookback] for sym, df in full.items()}), syms, lev, cap)
    validate_perp_weights(s.raw({syms[0]: full[syms[0]].iloc[:s.lookback]}), syms[:1], lev, cap)
    view = {sym: df.iloc[-s.lookback:] for sym, df in full.items()}
    for params in one_at_a_time_grid(s.params):                        # every numeric parameter halved and doubled
        validate_perp_weights(s.raw(view, params), syms, lev, cap)


@pytest.mark.parametrize("directory", V11_LIBRARY, ids=IDS)
def test_v11_strategy_passes_the_lookahead_check_under_the_v11_execution_model(directory, xvenue_data):
    s = load_strategy(directory)
    data = data_for(s, s.lookback + 500, xvenue_data)
    look = lookahead_check(s, data, v11_config(list(data)), start=next(iter(data.values())).index[s.lookback],
                           runner=run_perp_backtest)
    assert look["status"] == "pass", look
    res = run_perp_backtest(s, data, v11_config(list(data)))
    assert res.ledger["reconciles"] and (len(res.decisions) > 300 or res.stop is not None)


def test_market_neutral_strategies_are_neutral_by_construction(xvenue_data):
    mom = load_strategy(ROOT / "strategies/momentum_xs_perp/2")
    full = synthetic(mom, mom.lookback + 300)
    w = mom({k: v.iloc[-mom.lookback:] for k, v in full.items()})
    assert max(w, key=w.get) == "SOL" and min(w, key=w.get) == "BTC"            # the drifts given by `synthetic`
    assert w["SOL"] > 0 > w["BTC"]
    # the book only changes on its rebalance anchor (every 24 closes), not on every bar
    seq = [mom({k: v.iloc[e - mom.lookback:e] for k, v in full.items()}) for e in range(mom.lookback, mom.lookback + 49)]
    assert len({tuple(round(x, 12) for x in d.values()) for d in seq}) <= 3
    carry = load_strategy(ROOT / "strategies/basis_cash_carry/1")
    full = synthetic(carry, carry.lookback + 700)
    on = [carry({k: v.iloc[e - carry.lookback:e] for k, v in full.items()}) for e in range(carry.lookback, carry.lookback + 700, 50)]
    assert any(w["BTC"] < 0 for w in on) and any(w["BTC"] == 0 for w in on)     # in during the episode, out after it
    for w in on:
        for sym in ("BTC", "ETH", "SOL"):
            assert w[sym] == -w[sym + ".SPOT"] and w[sym] <= 0                  # short perp = long spot, never reversed
    arb = load_strategy(ROOT / "strategies_xvenue/funding_arb_cross_venue/1")
    for e in range(arb.lookback, 1700, 97):
        w = arb({k: v.iloc[e - arb.lookback:e] for k, v in xvenue_data.items()})
        for sym in ("BTC", "ETH", "SOL"):
            assert w[sym] == -w[sym + "@EDGEX"]                                 # delta-neutral per underlying
    stat = load_strategy(ROOT / "strategies/statarb_basket_perp/1")
    full = synthetic(stat, stat.lookback + 400)
    for e in range(stat.lookback, stat.lookback + 400, 53):
        view = {k: v.iloc[e - stat.lookback:e] for k, v in full.items()}
        w = np.array(list(stat(view).values()))
        if not w.any():
            continue
        rets = np.diff(np.log(np.column_stack([v["close"].to_numpy()[-337:] for v in view.values()])), axis=0)
        book = rets @ w
        market = rets.mean(axis=1)
        assert abs(np.corrcoef(book, market)[0, 1]) < 0.35                      # the factors are hedged out


def test_statarb_parameters_come_from_the_window_ending_at_the_decision_bar():
    s = load_strategy(ROOT / "strategies/statarb_basket_perp/1")
    full = synthetic(s, s.lookback + 60)
    view = {k: v.iloc[:s.lookback] for k, v in full.items()}
    w = s(view)
    # bars older than the estimation window do not matter; the last bar does
    older = {k: v.assign(close=np.where(np.arange(len(v)) < len(v) - 340, v["close"] * 3.0, v["close"])) for k, v in view.items()}
    assert s(older) == w
    bumped = {k: (v.assign(close=np.where(np.arange(len(v)) == len(v) - 1, v["close"] * 1.2, v["close"])) if k == "BTC" else v)
              for k, v in view.items()}
    assert s(bumped) != w


@pytest.mark.parametrize("rel", ["momentum_xs_perp/1", "momentum_xs_perp/2", "mean_reversion_bands_perp/1",
                                 "mean_reversion_bands_perp/2", "statarb_basket_perp/1"])
def test_signal_runner_agrees_with_the_backtester_including_a_generic_perp_universe(rel):
    directory = ROOT / "strategies" / rel
    s = load_strategy(directory)
    data = synthetic(s, s.lookback + 40)
    payload = {
        "candles": {k: [[iso_z(t), *map(float, r)] for t, r in zip(v.index, v[["open", "high", "low", "close", "volume"]].to_numpy())]
                    for k, v in data.items()},
        "funding": {k: [[iso_z(t), float(x)] for t, x in zip(v.index, v["funding"])] for k, v in data.items()},
        "interval": "1h", "as_of": iso_z(next(iter(data.values())).index[-1]),
    }
    out = compute_signal(directory, s.sha256, payload, contract=2)
    assert out["schema_version"] == 2 and out["kind"] == "perp" and list(out["weights"]) == list(data)
    view = {k: v.iloc[-s.lookback:] for k, v in data.items()}
    assert out["weights"] == pytest.approx(s(view), abs=1e-12)
    if s.generic:
        from spq.signal import InputError

        two = {**payload, "candles": dict(list(payload["candles"].items())[:2]),
               "funding": dict(list(payload["funding"].items())[:2])}
        if s.meta.get("min_symbols", 1) > 2:
            with pytest.raises(InputError):                             # fewer symbols than META['min_symbols']
                compute_signal(directory, s.sha256, two, contract=2)
