"""Strategy loader: identity, META validation, purity guard, weight validation."""
from __future__ import annotations

import builtins
import hashlib
import io
import os
import socket
import time

import numpy as np
import pytest

from conftest import make_data, write_strategy
from spq.strategy import (HashMismatch, PurityError, StrategyError, WeightsError, load_strategy, purity_guard,
                          sha256_file, static_check, validate_meta, validate_weights)

GOOD_META = {"name": "eth_trend", "version": "1", "universe": ["ETH", "LINK"], "interval": "1h", "lookback": 720,
             "params": {"fast": 24, "slow": 168}}


def test_identity_is_the_sha256_of_the_file(strategy_dir):
    d = strategy_dir()
    s = load_strategy(d)
    blob = (d / "strategy.py").read_bytes()
    assert s.sha256 == hashlib.sha256(blob).hexdigest() == sha256_file(d / "strategy.py")
    assert load_strategy(d, s.sha256).sha256 == s.sha256
    assert load_strategy(d, s.sha256.upper()).sha256 == s.sha256
    (d / "strategy.py").write_bytes(blob + b"\n# one more byte\n")
    assert load_strategy(d).sha256 != s.sha256
    with pytest.raises(HashMismatch):
        load_strategy(d, s.sha256)
    assert not list(d.glob("__pycache__"))            # loading leaves nothing behind


def test_hash_mismatch_is_raised_before_any_strategy_code_runs(tmp_path):
    d = write_strategy(tmp_path / "boom", "", raw="raise RuntimeError('module code executed')\n")
    with pytest.raises(HashMismatch):
        load_strategy(d, "0" * 64)
    with pytest.raises(StrategyError, match="failed at import"):
        load_strategy(d)


def test_loader_accepts_the_architecture_example(tmp_path):
    raw = (f"META = {GOOD_META!r}\n"
           "def target_weights(data, params):\n"
           "    return {s: 0.5 for s in data}\n")
    s = load_strategy(write_strategy(tmp_path / "eth_trend" / "1", "", raw=raw))
    assert s.name == "eth_trend" and s.universe == ["ETH", "LINK"] and s.lookback == 720
    assert s.params == {"fast": 24, "slow": 168}
    assert s(make_data(30, ("ETH", "LINK"))) == {"ETH": 0.5, "LINK": 0.5}
    assert load_strategy(tmp_path / "eth_trend" / "1" / "strategy.py").sha256 == s.sha256


@pytest.mark.parametrize("change", [
    {"name": ""}, {"version": 1}, {"universe": []}, {"universe": ["eth"]}, {"universe": ["ETH", "ETH"]},
    {"universe": "ETH"}, {"interval": "1x"}, {"lookback": 0}, {"lookback": 2.5}, {"lookback": True},
    {"params": [1, 2]}, {"params": {"x": float("nan")}}, {"params": {"f": print}}, {"extra": 1},
])
def test_bad_meta_is_refused(change):
    with pytest.raises(StrategyError):
        validate_meta({**GOOD_META, **change})


def test_missing_meta_key_and_missing_pieces(tmp_path, strategy_dir):
    for key in GOOD_META:
        with pytest.raises(StrategyError, match="missing"):
            validate_meta({k: v for k, v in GOOD_META.items() if k != key})
    with pytest.raises(StrategyError, match="no strategy.py"):
        load_strategy(tmp_path / "nowhere")
    with pytest.raises(StrategyError, match="does not define META"):
        load_strategy(write_strategy(tmp_path / "a", "", raw="def target_weights(data, params):\n    return {}\n"))
    with pytest.raises(StrategyError, match="target_weights"):
        load_strategy(write_strategy(tmp_path / "b", "", raw=f"META = {GOOD_META!r}\n"))
    with pytest.raises(StrategyError, match="syntax error"):
        load_strategy(write_strategy(tmp_path / "c", "", raw="def broken(:\n"))


@pytest.mark.parametrize("line,word", [
    ("import os", "os"), ("import socket", "socket"), ("import requests", "requests"), ("import time", "time"),
    ("from datetime import datetime", "datetime"), ("import random", "random"), ("import urllib.request", "urllib"),
    ("from pathlib import Path", "pathlib"), ("import subprocess", "subprocess"), ("from . import helper", "None"),
    ("x = open('/etc/hosts').read()", "open"), ("x = eval('1')", "eval"), ("x = __import__('os')", "__import__"),
    ("import pandas as pd\nx = pd.Timestamp.now()", ".now"), ("import pandas as pd\nx = pd.read_csv('f')", "read_csv"),
    ("import numpy as np\nx = np.load('f')", ".load"), ("x = ().__class__.__subclasses__()", "__subclasses__"),
    ("COUNTER = 0\ndef bump():\n    global COUNTER\n    COUNTER += 1", "global"),
])
def test_static_check_refuses_impure_sources(tmp_path, line, word):
    problems = static_check(line)
    assert problems and word in " ".join(problems)
    raw = line + f"\nMETA = {GOOD_META!r}\ndef target_weights(data, params):\n    return {{}}\n"
    d = write_strategy(tmp_path / "bad", "", raw=raw)
    with pytest.raises(StrategyError, match="purity check"):
        load_strategy(d)


def test_static_check_accepts_numerical_code():
    src = ("import math\nimport numpy as np\nimport pandas as pd\nfrom scipy import stats\nfrom arch import arch_model\n"
           "from statsmodels.tsa.stattools import adfuller\nfrom sklearn.linear_model import LinearRegression\n"
           "def f(df):\n    return float(np.log(df['close']).diff().rolling(5).std().iloc[-1])\n")
    assert static_check(src) == []


def test_runtime_guard_blocks_network_files_clock_and_randomness():
    real_open, real_time = builtins.open, time.time
    with purity_guard():
        for call in (lambda: open(__file__), lambda: io.open(__file__), lambda: os.open(__file__, os.O_RDONLY),
                     lambda: socket.socket(), lambda: socket.create_connection(("127.0.0.1", 9)),
                     lambda: socket.getaddrinfo("example.com", 80), lambda: time.time(), lambda: time.time_ns(),
                     lambda: time.sleep(0), lambda: os.urandom(4), lambda: os.system("true"),
                     lambda: np.random.rand(2), lambda: np.random.default_rng(), lambda: np.random.normal()):
            with pytest.raises(PurityError):
                call()
        with purity_guard():                      # re-entrant
            with pytest.raises(PurityError):
                time.time()
        with pytest.raises(PurityError):          # still active after the inner block
            time.time()
        assert float(np.arange(5).mean()) == 2.0  # numerical code is unaffected
    assert builtins.open is real_open and time.time is real_time
    assert isinstance(time.time(), float) and open(__file__).close() is None


def test_guard_is_applied_to_loaded_strategies_and_restored_on_error(strategy_dir):
    # v8: the static lint now refuses numpy.random outright; loaded unchecked (strict=False), the runtime guard is
    # what stops the draw
    d = strategy_dir("import numpy as np\nreturn {s: float(np.random.rand()) / 2 for s in data}\n")
    with pytest.raises(StrategyError, match="numpy.random"):
        load_strategy(d)
    s = load_strategy(d, strict=False)
    with pytest.raises(PurityError, match="random"):
        s(make_data(20))
    assert np.random.rand() < 1.0                   # entry points are restored after the failure
    # strict=False lets a researcher run an unchecked file; the runtime guard still applies
    d = strategy_dir("import time\nreturn {s: time.time() % 1 / 2 for s in data}\n")
    loose = load_strategy(d, strict=False)
    assert loose.static_problems
    with pytest.raises(PurityError, match="clock"):
        loose(make_data(20))


def test_validate_weights():
    u = ["A", "B", "C"]
    assert validate_weights({"A": 0.5, "B": 0.25}, u) == {"A": 0.5, "B": 0.25, "C": 0.0}
    assert validate_weights({}, u) == {"A": 0.0, "B": 0.0, "C": 0.0}
    assert validate_weights({"A": np.float64(1.0), "B": 0, "C": np.int64(0)}, u) == {"A": 1.0, "B": 0.0, "C": 0.0}
    snapped = validate_weights({"A": 1 / 3 + 3e-10, "B": 1 / 3, "C": 1 / 3}, u)       # rounding noise only
    assert sum(snapped.values()) <= 1.0 and snapped["A"] == pytest.approx(1 / 3)
    assert validate_weights({"A": -1e-12, "B": 1.0 + 1e-12}, u) == {"A": 0.0, "B": 1.0, "C": 0.0}
    for bad, msg in [
        ({"A": 1.01}, "outside"), ({"A": -0.01}, "outside"), ({"A": 0.6, "B": 0.6}, "sum"),
        ({"A": float("nan")}, "finite"), ({"A": float("inf")}, "finite"), ({"A": "0.5"}, "not a number"),
        ({"A": None}, "not a number"), ({"A": True}, "not a number"), ({"Z": 0.1}, "outside the universe"),
        ([0.5, 0.5], "dict"), (None, "dict"), ({"A": 0.34, "B": 0.34, "C": 0.34}, "sum"),
    ]:
        with pytest.raises(WeightsError, match=msg):
            validate_weights(bad, u)
