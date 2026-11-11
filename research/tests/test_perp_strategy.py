"""Strategy contract v2 (META['kind'] = 'perp'): META, weights, identity, purity, describe and signal CLIs.

The spot contract must not move: a META without 'kind' behaves exactly as before, and the spot outputs of the
two CLIs are byte-for-byte what they were."""
from __future__ import annotations

import json
import subprocess
import sys

import numpy as np
import pandas as pd
import pytest

from conftest import ROOT, make_data, write_strategy
from perp_helpers import perp_data, perp_meta
from spq import describe as describe_cli
from spq import signal as signal_cli
from spq.report import load_schema
from spq.strategy import (PurityError, StrategyError, WeightsError, from_function, load_strategy, sha256_file,
                          validate_meta, validate_perp_weights, validate_weights)

SPOT_META = {"name": "s", "version": "1", "universe": ["AAA", "BBB"], "interval": "1h", "lookback": 10, "params": {}}
PERP_META = perp_meta(("BTC", "ETH"), lookback=10, max_leverage=3.0, max_gross=4.0, name="p")
BODY = "return {'BTC': -1.5, 'ETH': 0.5}\n"


def test_perp_meta_validation():
    assert validate_meta(PERP_META)["kind"] == "perp"
    assert validate_meta({**SPOT_META, "kind": "spot"}) and validate_meta(SPOT_META)   # absent = spot
    for change in ({"kind": "future"}, {"kind": None}, {"max_leverage": 0}, {"max_leverage": -1}, {"max_leverage": "2"},
                   {"max_leverage": True}, {"max_leverage": float("inf")}, {"max_leverage": 51.0},
                   {"max_gross_exposure": 0}, {"max_gross_exposure": 6.5},          # > max_leverage x 2 perpetuals
                   {"universe": ["BTC.SPOT"]}, {"universe": ["BTC", "ETH.SPOT"]},   # a spot leg needs its perpetual
                   {"extra": 1}):
        with pytest.raises(StrategyError):
            validate_meta({**PERP_META, **change})
    for key in ("max_leverage", "max_gross_exposure"):
        with pytest.raises(StrategyError, match="missing"):
            validate_meta({k: v for k, v in PERP_META.items() if k != key})
    # the perp keys are refused on a spot META, and so are spot legs: the spot contract has not grown
    for change in ({"max_leverage": 2.0}, {"max_gross_exposure": 1.0}, {"kind": "spot", "max_leverage": 2.0},
                   {"universe": ["AAA", "AAA.SPOT"]}):
        with pytest.raises(StrategyError):
            validate_meta({**SPOT_META, **change})
    ok = perp_meta(("BTC", "BTC.SPOT"), max_leverage=1.0, max_gross=2.0)
    assert validate_meta(ok)["universe"] == ["BTC", "BTC.SPOT"]


def test_perp_weights_validation():
    sym = ["BTC", "ETH", "BTC.SPOT"]
    v = lambda w, lev=2.0, gross=3.0: validate_perp_weights(w, sym, lev, gross)  # noqa: E731
    assert v({"BTC": -2.0, "ETH": 0.5}) == {"BTC": -2.0, "ETH": 0.5, "BTC.SPOT": 0.0}     # missing symbols are 0
    assert v({"BTC": np.float64(-1.0), "ETH": 1, "BTC.SPOT": 1.0})["BTC.SPOT"] == 1.0
    assert v({"BTC": 2.0 + 5e-10})["BTC"] == 2.0 and v({"BTC.SPOT": -5e-10})["BTC.SPOT"] == 0.0   # snapped
    for bad in ({"BTC": 2.1}, {"BTC": -2.1}, {"BTC.SPOT": -0.1}, {"BTC.SPOT": 1.1},      # per-symbol bounds
                {"BTC": 2.0, "ETH": -1.5},                                                # gross 3.5 > 3
                {"BTC": float("nan")}, {"BTC": float("inf")}, {"BTC": "1"}, {"BTC": True}, {"SOL": 0.1}, None, [1.0]):
        with pytest.raises(WeightsError):
            v(bad)
    # the spot validator is untouched: a negative weight is still refused there
    with pytest.raises(WeightsError):
        validate_weights({"BTC": -0.5}, ["BTC"])


def test_loaded_perp_strategy_identity_purity_and_validation(strategy_dir):
    d = strategy_dir(BODY, meta=PERP_META)
    s = load_strategy(d)
    assert s.kind == "perp" and s.sha256 == sha256_file(d / "strategy.py") and s.static_problems == []
    data = perp_data(20, ("BTC", "ETH"))
    assert s(data) == {"BTC": -1.5, "ETH": 0.5}
    # the hash covers META: changing the leverage cap is another strategy
    other = load_strategy(strategy_dir(BODY, meta={**PERP_META, "max_leverage": 2.0}))
    assert other.sha256 != s.sha256 and other(data) == {"BTC": -1.5, "ETH": 0.5}       # still inside 2x


def test_loaded_perp_strategy_caps(strategy_dir):
    data = perp_data(20, ("BTC", "ETH"))
    tight = load_strategy(strategy_dir(BODY, meta={**PERP_META, "max_leverage": 1.0, "max_gross_exposure": 2.0}))
    with pytest.raises(WeightsError, match="max_leverage is 1"):
        tight(data)
    gross = load_strategy(strategy_dir(BODY, meta={**PERP_META, "max_gross_exposure": 1.9}))
    with pytest.raises(WeightsError, match="gross exposure"):
        gross(data)
    # the purity guard and the static check apply to perp strategies as to spot ones
    with pytest.raises(StrategyError, match="purity"):
        load_strategy(strategy_dir("import os\nreturn {}\n", meta=PERP_META))
    sneaky = load_strategy(strategy_dir("import time\ntime.time()\nreturn {}\n", meta=PERP_META), strict=False)
    with pytest.raises(PurityError):
        sneaky(data)
    # inputs are copy-on-write: writing into the funding column cannot reach the caller's data
    writer = from_function(lambda d, p: (d["BTC"].__setitem__("funding", 9.0), {"BTC": 0.1})[1],
                           perp_meta(("BTC", "ETH")))
    before = data["BTC"]["funding"].copy()
    writer({s_: df.iloc[:] for s_, df in data.items()})
    pd.testing.assert_series_equal(data["BTC"]["funding"], before)


# ------------------------------------------------------------------------------------------------- describe CLI

def describe(args, capsys):
    code = describe_cli.main(args)
    out = capsys.readouterr()
    return code, out.out, out.err


def test_describe_spot_output_is_unchanged_and_perp_needs_contract_2(strategy_dir, capsys):
    spot = strategy_dir("return {s: 0.5 for s in data}\n")
    code, out, err = describe(["--strategy", str(spot)], capsys)
    assert code == 0 and set(json.loads(out)) == {"sha256", "meta"}                 # exactly the version-1 output
    perp = strategy_dir(BODY, meta=PERP_META)
    code, out, err = describe(["--strategy", str(perp)], capsys)
    assert code == 4 and out == "" and "contract 2" in err                           # not offered to a v1 caller
    code, out, err = describe(["--strategy", str(perp), "--contract", "2"], capsys)
    got = json.loads(out)
    assert code == 0 and got["contract"] == 2 and got["kind"] == "perp" and got["sha256"] == sha256_file(perp / "strategy.py")
    assert got["meta"]["max_leverage"] == 3.0 and got["meta"]["max_gross_exposure"] == 4.0
    code, out, err = describe(["--strategy", str(spot), "--contract", "2"], capsys)
    assert code == 0 and json.loads(out)["contract"] == 1 and json.loads(out)["kind"] == "spot"


# --------------------------------------------------------------------------------------------------- signal CLI

def rows(df):
    return [[ts.strftime("%Y-%m-%dT%H:%M:%SZ"), *map(float, r)] for ts, r in zip(df.index, df[["open", "high", "low", "close", "volume"]].to_numpy())]


def payload(data, perps=("BTC", "ETH")):
    return {"candles": {s: rows(df) for s, df in data.items()},
            "funding": {s: [[ts.strftime("%Y-%m-%dT%H:%M:%SZ"), float(f), float(p)] for ts, f, p in
                            zip(data[s].index, data[s]["funding"], data[s]["premium"])] for s in perps}}


def run_signal(tmp_path, directory, sha, body, *extra, capsys=None):
    f = tmp_path / "in.json"
    f.write_text(body if isinstance(body, str) else json.dumps(body))
    code = signal_cli.main(["--strategy", str(directory), "--sha256", sha, "--input", str(f), *extra])
    out = capsys.readouterr()
    return code, out.out, out.err


FUNDING_BODY = """f = data['BTC']['funding'].to_numpy()
return {'BTC': -1.5 if f[-1] > f.mean() else 1.5, 'ETH': float(len(f)) / 100.0}
"""


def test_signal_v2_output_and_schema(strategy_dir, tmp_path, capsys):
    import jsonschema

    d = strategy_dir(FUNDING_BODY, meta=PERP_META)
    sha = sha256_file(d / "strategy.py")
    data = perp_data(40, ("BTC", "ETH"), seed=3)
    code, out, err = run_signal(tmp_path, d, sha, payload(data), "--contract", "2", capsys=capsys)
    assert code == 0, err
    got = json.loads(out)
    f = data["BTC"]["funding"].to_numpy()[-10:]
    assert got == {"schema_version": 2, "kind": "perp", "strategy_sha256": sha,
                   "as_of": data["BTC"].index[-1].strftime("%Y-%m-%dT%H:%M:%SZ"),
                   "weights": {"BTC": -1.5 if f[-1] > f.mean() else 1.5, "ETH": 0.1},   # the last `lookback` rows
                   "max_leverage": 3.0, "max_gross_exposure": 4.0}
    out_schema = json.loads((ROOT / "schema" / "signal-output-v2.schema.json").read_text())
    in_schema = json.loads((ROOT / "schema" / "signal-input-v2.schema.json").read_text())
    jsonschema.Draft202012Validator(out_schema).validate(got)
    jsonschema.Draft202012Validator(in_schema).validate(payload(data))
    # the version-1 output schema refuses this object: a v1 consumer cannot mistake it for spot weights
    v1 = json.loads((ROOT / "schema" / "signal-output.schema.json").read_text())
    assert not jsonschema.Draft202012Validator(v1).is_valid(got)
    # settlement instants a few ms after the hour (as the venue stamps them) and epoch seconds are accepted
    p = payload(data)
    p["funding"]["BTC"] = [[r[0][:-1] + ".139Z", r[1]] for r in p["funding"]["BTC"]]
    p["funding"]["ETH"] = [[int(pd.Timestamp(r[0]).timestamp()), r[1]] for r in p["funding"]["ETH"]]
    code, out2, err = run_signal(tmp_path, d, sha, p, "--contract", "2", capsys=capsys)
    assert code == 0 and json.loads(out2)["weights"] == got["weights"], err
    # optional mark and index series
    p = payload(data)
    p["mark"] = {"BTC": [[r[0], r[4]] for r in p["candles"]["BTC"]]}
    p["index"] = {"BTC": [[r[0], r[4] * 0.999] for r in p["candles"]["BTC"]]}
    assert run_signal(tmp_path, d, sha, p, "--contract", "2", capsys=capsys)[0] == 0


def test_signal_v2_refusals(strategy_dir, tmp_path, capsys):
    d = strategy_dir(FUNDING_BODY, meta=PERP_META)
    sha = sha256_file(d / "strategy.py")
    data = perp_data(40, ("BTC", "ETH"), seed=3)
    good = payload(data)
    last = good["candles"]["BTC"][-1][0]
    nxt = (pd.Timestamp(last) + pd.Timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")

    def refused(body, *extra, code=2, match=""):
        c, out, err = run_signal(tmp_path, d, sha, body, *(extra or ("--contract", "2")), capsys=capsys)
        assert c == code and out == "" and match in err, (c, err)

    def mod(**changes):
        p = json.loads(json.dumps(good))
        for path, value in changes.items():
            node, keys = p, path.split("__")
            for k in keys[:-1]:
                node = node[k]
            if value is None:
                node.pop(keys[-1])
            else:
                node[keys[-1]] = value
        return p

    # a perp strategy is never run for a caller that did not ask for contract 2
    refused(good, "--max-gap-bars", "6", match="contract 2")
    refused(good, "--contract", "1", match="contract 2")
    # THE look-ahead refusal: a settlement, a mark or an index value dated after the decision bar
    refused(mod(funding__BTC=good["funding"]["BTC"] + [[nxt, 0.0001]]), match="after the decision bar")
    refused(mod(mark={"BTC": [[r[0], r[4]] for r in good["candles"]["BTC"]] + [[nxt, 100.0]]}), match="after the decision bar")
    refused(mod(index={"ETH": [[r[0], r[4]] for r in good["candles"]["ETH"]] + [[nxt, 100.0]]}), match="after the decision bar")
    # funding is mandatory, for exactly the perpetuals
    refused(mod(funding=None), match="funding")
    refused(mod(funding__ETH=None), match="exactly the perpetuals")
    refused(mod(funding__SOL=[[last, 0.0]]), match="exactly the perpetuals")
    refused(mod(funding__BTC=[]), match="non-empty")
    refused(mod(funding__BTC=[[last, "0.0001"]]), match="finite numbers")
    refused(mod(funding__BTC=[[last, float("nan")]]), match="")                       # NaN is not JSON
    refused(mod(funding__BTC=[[last]]), match="2 or 3 values")
    refused(mod(funding__BTC=list(reversed(good["funding"]["BTC"]))), match="strictly increasing")
    refused(mod(funding__BTC=[[last[:14] + "30:00Z", 0.0001]]), match="hourly settlement")
    refused(mod(funding__BTC=good["funding"]["BTC"][:-3]), match="no funding settlement")     # hole at the end
    refused(mod(funding__BTC=good["funding"]["BTC"][:33] + good["funding"]["BTC"][34:]), match="no funding settlement")
    refused(mod(mark={"SOL": [[last, 1.0]]}), match="perpetuals of the universe")
    refused(mod(mark={"BTC": [[last, -1.0]]}), match="positive")
    refused(mod(params={"x": 1}), match="unexpected input keys")
    refused(mod(candles__BTC=good["candles"]["BTC"][:5]), match="bars supplied")
    # exit codes of the version-1 runner are kept: hash 3, strategy 4, runtime 5, weights 6
    c, out, err = run_signal(tmp_path, d, "0" * 64, good, "--contract", "2", capsys=capsys)
    assert c == 3 and out == ""
    over = strategy_dir("return {'BTC': -3.5}\n", meta=PERP_META)                     # beyond max_leverage 3
    c, out, err = run_signal(tmp_path, over, sha256_file(over / "strategy.py"), good, "--contract", "2", capsys=capsys)
    assert c == 6 and out == "" and "max_leverage" in err
    gross = strategy_dir("return {'BTC': -3.0, 'ETH': 1.5}\n", meta=PERP_META)        # gross 4.5 > 4
    c, out, err = run_signal(tmp_path, gross, sha256_file(gross / "strategy.py"), good, "--contract", "2", capsys=capsys)
    assert c == 6 and "gross exposure" in err
    boom = strategy_dir("raise RuntimeError('x')\n", meta=PERP_META)
    assert run_signal(tmp_path, boom, sha256_file(boom / "strategy.py"), good, "--contract", "2", capsys=capsys)[0] == 5
    net = strategy_dir("import socket\nsocket.socket()\nreturn {}\n", meta=PERP_META)
    assert run_signal(tmp_path, net, sha256_file(net / "strategy.py"), good, "--contract", "2", capsys=capsys)[0] == 4


def test_signal_spot_contract_is_unchanged(strategy_dir, tmp_path, capsys):
    import jsonschema

    d = strategy_dir("return {s: 0.25 for s in data}\n")
    sha = sha256_file(d / "strategy.py")
    data = make_data(12)
    body = {"candles": {s: rows(df) for s, df in data.items()}}
    code, out, err = run_signal(tmp_path, d, sha, body, capsys=capsys)
    got = json.loads(out)
    assert code == 0 and set(got) == {"strategy_sha256", "as_of", "weights"} and got["weights"] == {"AAA": 0.25, "BBB": 0.25}
    jsonschema.Draft202012Validator(json.loads((ROOT / "schema" / "signal-output.schema.json").read_text())).validate(got)
    # a spot strategy asked through contract 2, or given perp inputs, is refused
    assert run_signal(tmp_path, d, sha, body, "--contract", "2", capsys=capsys)[0] == 2
    assert run_signal(tmp_path, d, sha, {**body, "funding": {}}, capsys=capsys)[0] == 2


def test_signal_v2_as_a_subprocess(strategy_dir, tmp_path):
    d = strategy_dir(FUNDING_BODY, meta=PERP_META)
    data = perp_data(15, ("BTC", "ETH"), seed=8)
    f = tmp_path / "in.json"
    f.write_text(json.dumps(payload(data)))
    cmd = [sys.executable, "-m", "spq.signal", "--strategy", str(d), "--sha256", sha256_file(d / "strategy.py"),
           "--input", str(f)]
    p = subprocess.run(cmd + ["--contract", "2"], capture_output=True, text=True, cwd=ROOT, timeout=120)
    assert p.returncode == 0 and json.loads(p.stdout)["kind"] == "perp" and p.stdout.count("\n") == 1
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT, timeout=120)
    assert p.returncode == 2 and p.stdout == "" and "contract 2" in p.stderr


def test_report_schema_v1_file_is_untouched():
    """The version-1 schema is what existing consumers validate against: it still says schema_version 1."""
    assert load_schema()["properties"]["schema_version"] == {"const": 1}
