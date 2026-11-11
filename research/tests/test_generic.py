"""Universe-generic strategies (v5): META['universe'] == ['*'] means "any set of symbols, chosen by the agent".

The symbols then come from the input (the candles' keys for a signal, --symbols for a backtest), 1 to 12 of them within
META['min_symbols'] / META['max_symbols']; weights are validated against that list. Fixed universes are unchanged.
"""
from __future__ import annotations

import json
import subprocess
import sys

import pytest

from conftest import ROOT, make_data, write_strategy
from spq import backtest as backtest_cli
from spq import describe as describe_cli
from spq.strategy import StrategyError, load_strategy, resolve_symbols, sha256_file, validate_meta

LIB = ROOT / "strategies"
GENERIC_META = {"name": "g", "version": "3", "universe": ["*"], "interval": "1h", "lookback": 10, "params": {"w": 0.9}}
TWELVE = ["AAVE", "AVAX", "BNB", "BTC", "DOGE", "ETH", "LINK", "LTC", "POL", "SOL", "UNI", "XRP"]
# SHA-256 of every strategy.py that existed before v5: the contract change must not alter one byte of them
BEFORE_V5 = {
    "donchian_breakout/1": "8fe7d9f18bda8429e6203db8486d337b7b56c745fe3f1e420ef657aa5a04ecc7",
    "donchian_breakout/2": "d729f97e5d46da2576e260e31b978173c2915dd0e73f99d0fb4433ea03ae6684",
    "garch_regime/1": "18436bddf4ccecd82199cd3df1ceaf611776949dfa6098ed0fa88b8159a42b58",
    "ma_trend/1": "525c537560317ac341500ac9e8cf483eb062b019635845b27da5f25e869632ff",
    "ma_trend/2": "e1ff1b3a8c0266491555f1c74ec0080e8591c98ef8762153a302a5158010f860",
    "mean_reversion/1": "7a52c148911f4eb622315e7dabbd27d2a6cc7174f16e4069144d70fe4233c7ea",
    "pairs_rotation/1": "735aa3dbf9a88ddf95d76f3c595f63ea5cc405f0900542a1598b0cf2dcf671ee",
    "ts_momentum/1": "6af24ef3a50168f54460728664d4707a71a4e9221425e14cd2c40f24932a028d",
    "ts_momentum/2": "e93de5942c8e5b0cf2b611acad2b5c853a3da268552146a880e9cffd51772243",
    "vol_target_trend/1": "573bfef18374cdbbfb98b58d660d5e89de0818f71e5cedb043535207d08e2647",
    "vol_target_trend/2": "86592cd4d69e6b8ab5b2f6ab5c2605c4966667a3a8c542c40f138a60b1c4f0ae",
    "xs_momentum/1": "3c19533da51804d6e9003b541943e13243afb06626ad46fcceeb055c5ee85bfc",
}


def payload(symbols, n=12):
    data = make_data(n, tuple(symbols))
    return {"candles": {s: [[ts.strftime("%Y-%m-%dT%H:%M:%SZ"), *map(float, row)] for ts, row in
                            zip(df.index, df.to_numpy())] for s, df in data.items()}}


def run_signal(directory, pl, tmp_path):
    f = tmp_path / "in.json"
    f.write_text(json.dumps(pl))
    p = subprocess.run([sys.executable, "-m", "spq.signal", "--strategy", str(directory), "--sha256",
                        sha256_file(directory / "strategy.py"), "--input", str(f)], capture_output=True, text=True,
                       cwd=tmp_path, timeout=120)
    return p.returncode, p.stdout, p.stderr


def test_fixed_universe_strategies_keep_their_hashes():
    for rel, digest in BEFORE_V5.items():
        assert sha256_file(LIB / rel / "strategy.py") == digest, rel
        assert not load_strategy(LIB / rel).generic


def test_meta_accepts_a_generic_universe_and_its_bounds():
    assert validate_meta(dict(GENERIC_META))["universe"] == ["*"]
    assert validate_meta({**GENERIC_META, "min_symbols": 3, "max_symbols": 8})["min_symbols"] == 3
    for bad in ({"universe": ["*", "ETH"]}, {"universe": ["*", "*"]}, {"min_symbols": 0}, {"max_symbols": 13},
                {"min_symbols": 5, "max_symbols": 4}, {"min_symbols": 2.0}, {"min_symbols": True}, {"extra": 1}):
        with pytest.raises(StrategyError):
            validate_meta({**GENERIC_META, **bad})
    with pytest.raises(StrategyError):   # the bounds mean nothing for a fixed universe
        validate_meta({**GENERIC_META, "universe": ["ETH", "LINK"], "min_symbols": 2})


def test_resolve_symbols():
    assert resolve_symbols(GENERIC_META, ["ETH"]) == ["ETH"]
    assert resolve_symbols(GENERIC_META, TWELVE) == TWELVE
    for bad in (None, [], [*TWELVE, "ADA"], ["ETH", "ETH"], ["eth"], ["E"], ["ETH-USD"], ["*"], [1]):
        with pytest.raises(StrategyError):
            resolve_symbols(GENERIC_META, bad)
    with pytest.raises(StrategyError):
        resolve_symbols({**GENERIC_META, "min_symbols": 3}, ["ETH", "LINK"])
    fixed = {**GENERIC_META, "universe": ["ETH", "LINK"]}
    assert resolve_symbols(fixed, None) == ["ETH", "LINK"] and resolve_symbols(fixed, ["BTC"]) == ["BTC"]


@pytest.mark.parametrize("symbols", [["ETH"], ["ETH", "LINK", "UNI"], TWELVE], ids=["1", "3", "12"])
def test_signal_takes_the_symbols_of_the_input(tmp_path, symbols):
    d = write_strategy(tmp_path / "g", "return {s: params['w'] / len(data) for s in data}\n", meta=GENERIC_META)
    rc, out, err = run_signal(d, payload(symbols), tmp_path)
    assert rc == 0, err
    weights = json.loads(out)["weights"]
    assert list(weights) == symbols and weights == pytest.approx({s: 0.9 / len(symbols) for s in symbols})


def test_signal_refuses_a_weight_for_a_symbol_not_in_the_input(tmp_path):
    d = write_strategy(tmp_path / "g", "return {'ETH': 0.5, 'BTC': 0.3}\n", meta=GENERIC_META)
    rc, out, err = run_signal(d, payload(["ETH", "LINK"]), tmp_path)   # BTC was not supplied
    assert rc == 6 and out == "" and "outside the universe" in err
    assert run_signal(d, payload(["ETH", "BTC"]), tmp_path)[0] == 0


def test_signal_refuses_too_many_too_few_and_malformed_symbols(tmp_path):
    d = write_strategy(tmp_path / "g", "return {s: 0.0 for s in data}\n", meta=GENERIC_META)
    rc, out, err = run_signal(d, payload([*TWELVE, "ADA"]), tmp_path)
    assert rc == 2 and out == "" and "between 1 and 12" in err
    assert run_signal(d, {"candles": {}}, tmp_path)[0] == 2
    assert run_signal(d, payload(["eth"]), tmp_path)[0] == 2
    three = write_strategy(tmp_path / "g3", "return {s: 0.0 for s in data}\n", meta={**GENERIC_META, "min_symbols": 3})
    rc, out, err = run_signal(three, payload(["ETH", "LINK"]), tmp_path)
    assert rc == 2 and "between 3 and 12" in err
    assert run_signal(three, payload(["ETH", "LINK", "UNI"]), tmp_path)[0] == 0


def test_cross_sectional_momentum_needs_three_symbols(tmp_path):
    xs = LIB / "xs_momentum" / "3"
    s = load_strategy(xs)
    assert s.generic and s.meta["min_symbols"] == 3 and s.params == load_strategy(LIB / "xs_momentum" / "1").params
    two = make_data(s.lookback, ("ETH", "LINK"), drift=0.001)
    assert s(two) == {"ETH": 0.0, "LINK": 0.0}                 # the function itself returns cash below 3 symbols
    three = make_data(s.lookback, ("ETH", "LINK", "UNI"), drift=0.001)
    assert sum(s(three).values()) == pytest.approx(1.0)
    rc, _, err = run_signal(xs, payload(["ETH", "LINK"], n=s.lookback), tmp_path)
    assert rc == 2 and "between 3 and 12" in err


def test_generic_versions_carry_the_parameters_of_version_1():
    for name in ("ts_momentum", "ma_trend", "donchian_breakout", "vol_target_trend", "mean_reversion", "xs_momentum"):
        one, three = load_strategy(LIB / name / "1"), load_strategy(LIB / name / "3")
        assert three.generic and three.params == one.params and three.lookback == one.lookback, name
        data = make_data(one.lookback, tuple(one.universe), seed=3, drift=0.0003)
        assert three(data) == one(data), name                   # same rule: same weights on the same data


def test_describe_reports_a_generic_universe(capsys):
    assert describe_cli.main(["--strategy", str(LIB / "xs_momentum" / "3")]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["meta"]["universe"] == ["*"] and out["generic"] is True and (out["min_symbols"], out["max_symbols"]) == (3, 12)
    assert describe_cli.main(["--strategy", str(LIB / "ts_momentum" / "3")]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["generic"] is True and (out["min_symbols"], out["max_symbols"]) == (1, 12) and "min_symbols" not in out["meta"]
    assert describe_cli.main(["--strategy", str(LIB / "ts_momentum" / "1")]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["generic"] is False and out["meta"]["universe"] == ["ETH", "BTC", "LINK", "SOL"] and "min_symbols" not in out


def test_backtest_of_a_generic_strategy_takes_its_symbols_from_the_command_line(tmp_path, capsys):
    symbols = ["ETH", "LINK", "UNI"]
    for sym, df in make_data(900, tuple(symbols), seed=4, drift=0.0002).items():
        f = tmp_path / "data" / "coinbase" / f"{sym}_1h.parquet"
        f.parent.mkdir(parents=True, exist_ok=True)
        df.reset_index().to_parquet(f, index=False)
    d = write_strategy(tmp_path / "g", "return {s: params['w'] / len(data) for s in data}\n", meta=GENERIC_META)
    common = ["--strategy", str(d), "--data-dir", str(tmp_path / "data"), "--folds", "2", "--resamples", "50"]
    assert backtest_cli.main([*common, "--out", str(tmp_path / "none.json")]) == 2          # no symbols: refused
    assert "universe-generic" in capsys.readouterr().err
    assert backtest_cli.main([*common, "--symbols", ",".join(TWELVE + ["ADA"]), "--out", str(tmp_path / "many.json")]) == 2
    capsys.readouterr()
    assert backtest_cli.main([*common, "--symbols", "ETH,LINK,UNI", "--out", str(tmp_path / "r.json")]) == 0
    report = json.loads((tmp_path / "r.json").read_text())
    assert report["config"]["symbols"] == symbols                                           # the report records them
    assert not any("differ from META" in n for n in report["checks"]["notes"])
