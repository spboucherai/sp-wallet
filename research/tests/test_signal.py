"""Contract of `python -m spq.signal`: one JSON object on stdout and exit 0, or nothing on stdout and exit != 0."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import jsonschema
import pandas as pd
import pytest

from conftest import ROOT, make_data, write_strategy
from spq import signal as signal_cli
from spq.strategy import sha256_file

META = {"name": "t", "version": "1", "universe": ["AAA", "BBB"], "interval": "1h", "lookback": 10, "params": {"w": 0.4}}
OUT_SCHEMA = json.loads((ROOT / "schema" / "signal-output.schema.json").read_text())
IN_SCHEMA = json.loads((ROOT / "schema" / "signal-input.schema.json").read_text())


def payload(n=12, **kw):
    data = make_data(n, **kw)
    return {"candles": {s: [[ts.strftime("%Y-%m-%dT%H:%M:%SZ"), *map(float, row)] for ts, row in
                            zip(df.index, df.to_numpy())] for s, df in data.items()}}


@pytest.fixture
def env(tmp_path):
    """A valid strategy, its hash, and a runner returning (exit code, stdout, stderr)."""
    d = write_strategy(tmp_path / "strat", "return {s: params['w'] for s in data}\n", meta=META)

    class Env:
        dir = d
        sha = sha256_file(d / "strategy.py")

        def run(self, pl=None, *, strategy=None, sha=None, raw=None, args=()):
            f = tmp_path / "input.json"
            f.write_text(raw if raw is not None else json.dumps(pl if pl is not None else payload()))
            return self.cli(["--strategy", str(strategy or d), "--sha256", sha or
                             (sha256_file(Path(strategy) / "strategy.py") if strategy else self.sha),
                             "--input", str(f), *args])

        def cli(self, argv):
            p = subprocess.run([sys.executable, "-m", "spq.signal", *argv], capture_output=True, text=True,
                               cwd=tmp_path, timeout=120)
            return p.returncode, p.stdout, p.stderr

        def variant(self, body, meta=META, raw=None):
            return write_strategy(tmp_path / f"v{len(list(tmp_path.iterdir()))}", body, meta=meta, raw=raw)

    return Env()


def refused(result, code):
    rc, out, err = result
    assert rc == code, (rc, out, err)
    assert out == "", "nothing may be written on stdout when the signal is refused"
    assert err.startswith("spq.signal:") and len(err.strip().splitlines()) == 1
    return err


def test_success_prints_exactly_one_json_object(env):
    pl = payload()
    jsonschema.Draft202012Validator(IN_SCHEMA).validate(pl)
    rc, out, err = env.run(pl)
    assert rc == 0 and err == ""
    assert out.endswith("\n") and len(out.splitlines()) == 1
    obj = json.loads(out)
    jsonschema.Draft202012Validator(OUT_SCHEMA).validate(obj)
    assert set(obj) == {"strategy_sha256", "as_of", "weights"}
    assert obj["strategy_sha256"] == env.sha
    assert obj["as_of"] == pl["candles"]["AAA"][-1][0] == "2024-01-01T11:00:00Z"   # bar-open time of the last bar
    assert obj["weights"] == {"AAA": 0.4, "BBB": 0.4}


def test_optional_fields_stdin_epoch_timestamps_and_extra_history(env, tmp_path):
    pl = payload(40)
    pl["as_of"], pl["interval"] = pl["candles"]["AAA"][-1][0], "1h"
    for rows in pl["candles"].values():
        for r in rows:
            r[0] = int(pd.Timestamp(r[0]).timestamp())           # epoch seconds are accepted too
    p = subprocess.run([sys.executable, "-m", "spq.signal", "--strategy", str(env.dir), "--sha256", env.sha,
                        "--input", "-"], input=json.dumps(pl), capture_output=True, text=True, cwd=tmp_path)
    assert p.returncode == 0 and json.loads(p.stdout)["as_of"] == "2024-01-02T15:00:00Z"


def test_only_the_last_lookback_bars_reach_the_strategy(env):
    d = env.variant("return {'AAA': min(1.0, len(data['AAA']) / 100), 'BBB': 0.0}\n")
    rc, out, _ = env.run(payload(50), strategy=d)
    assert rc == 0 and json.loads(out)["weights"] == {"AAA": 0.1, "BBB": 0.0}


def test_strategy_prints_do_not_pollute_stdout(env):
    d = env.variant("print('debug noise')\nreturn {s: 0.25 for s in data}\n")
    rc, out, err = env.run(strategy=d)
    assert rc == 0 and json.loads(out)["weights"] == {"AAA": 0.25, "BBB": 0.25} and "debug noise" in err


# ----------------------------------------------------------------------------------------------- refusals: hash

def test_refuses_a_hash_mismatch_without_running_the_strategy(env, tmp_path):
    assert "expected" in refused(env.run(sha="0" * 64), 3)
    (env.dir / "strategy.py").write_text((env.dir / "strategy.py").read_text() + "\n# tampered\n")
    refused(env.run(), 3)                                       # the approved hash no longer matches the file
    bomb = env.variant("", raw="raise SystemExit(0)\n")       # would exit 0 if it were executed
    refused(env.run(strategy=bomb, sha="f" * 64), 3)
    refused(env.run(sha="abc"), 2)                              # not a SHA-256 at all
    refused(env.run(sha="z" * 64), 2)


# ------------------------------------------------------------------------------------------- refusals: strategy

def test_refuses_a_strategy_that_cannot_be_loaded(env, tmp_path):
    refused(env.cli(["--strategy", str(tmp_path / "missing"), "--sha256", "0" * 64, "--input", "x.json"]), 2)
    (tmp_path / "x.json").write_text(json.dumps(payload()))
    refused(env.cli(["--strategy", str(tmp_path / "missing"), "--sha256", "0" * 64, "--input", "x.json"]), 4)
    refused(env.run(strategy=env.variant("", meta={**META, "lookback": 0})), 4)
    refused(env.run(strategy=env.variant("", raw="META = 3\ndef target_weights(d, p):\n    return {}\n")), 4)
    refused(env.run(strategy=env.variant("", raw=f"META = {META!r}\n")), 4)
    refused(env.run(strategy=env.variant("", raw="import os\n" + f"META = {META!r}\n"
                                         "def target_weights(d, p):\n    return {}\n")), 4)
    refused(env.run(strategy=env.variant("return {s: open('/etc/hosts').read() for s in data}\n")), 4)
    refused(env.run(strategy=env.variant("", raw="def broken(:\n")), 4)
    refused(env.run(strategy=env.variant("", raw="raise RuntimeError('x')\n")), 4)


def test_refuses_when_the_strategy_raises_or_is_impure(env):
    assert "ZeroDivisionError" in refused(env.run(strategy=env.variant("return {s: 1 / 0 for s in data}\n")), 5)
    assert "KeyError" in refused(env.run(strategy=env.variant("return {'AAA': data['ZZZ']}\n")), 5)
    # v8: randomness is now refused by the static lint, before any strategy code runs (exit 4 instead of 5: the
    # runtime guard that used to catch it is still there for a file loaded with strict=False — tests/test_strategy.py)
    err = refused(env.run(strategy=env.variant(
        "import numpy as np\nreturn {s: float(np.random.rand()) / 2 for s in data}\n")), 4)
    assert "numpy.random" in err
    refused(env.run(strategy=env.variant("raise SystemExit(0)\n")), 5)   # cannot fake a success by exiting
    refused(env.run(strategy=env.variant("", raw="raise SystemExit(0)\n")), 5)   # nor at import time


# -------------------------------------------------------------------------------------------- refusals: weights

@pytest.mark.parametrize("body", [
    "return {'AAA': 1.2, 'BBB': 0.0}\n",                 # above 1
    "return {'AAA': -0.1, 'BBB': 0.5}\n",                # short
    "return {'AAA': 0.6, 'BBB': 0.6}\n",                 # leverage
    "return {'AAA': float('nan'), 'BBB': 0.1}\n",
    "return {'AAA': float('inf')}\n",
    "return {'AAA': '0.5'}\n",
    "return {'AAA': None}\n",
    "return {'AAA': 0.5, 'ETH': 0.5}\n",                 # symbol outside the universe
    "return [0.5, 0.5]\n",
    "return None\n",
    "return 0.5\n",
])
def test_refuses_invalid_weights(env, body):
    refused(env.run(strategy=env.variant(body)), 6)


# ---------------------------------------------------------------------------------------------- refusals: input

def test_refuses_bad_input(env, tmp_path):
    def edit(fn, n=12):
        pl = payload(n)
        fn(pl)
        return pl

    def drop(pl, sym, rows):
        pl["candles"][sym] = [r for i, r in enumerate(pl["candles"][sym]) if i not in rows]

    cases = {
        "not json": dict(raw="{not json"),
        "json array": dict(raw="[1, 2]"),
        "NaN literal": dict(raw=json.dumps(payload()).replace("100.0", "NaN", 1)),
        "no candles": dict(pl={"as_of": "2024-01-01T11:00:00Z"}),
        "missing symbol": dict(pl=edit(lambda p: p["candles"].pop("BBB"))),
        "extra symbol": dict(pl=edit(lambda p: p["candles"].update(CCC=p["candles"]["AAA"]))),
        "parameter override": dict(pl=edit(lambda p: p.update(params={"w": 1.0}))),
        "wrong interval": dict(pl=edit(lambda p: p.update(interval="5m"))),
        "too few bars": dict(pl=payload(9)),
        "empty series": dict(pl=edit(lambda p: p["candles"].update(AAA=[]))),
        "row of 5": dict(pl=edit(lambda p: p["candles"]["AAA"][3].pop())),
        "string price": dict(pl=edit(lambda p: p["candles"]["AAA"][3].__setitem__(4, "101.5"))),
        "null price": dict(pl=edit(lambda p: p["candles"]["AAA"][3].__setitem__(4, None))),
        "negative price": dict(pl=edit(lambda p: p["candles"]["AAA"][11].__setitem__(4, -1.0))),
        "high below low": dict(pl=edit(lambda p: p["candles"]["AAA"][11].__setitem__(2, 0.01))),
        "bad timestamp": dict(pl=edit(lambda p: p["candles"]["AAA"][3].__setitem__(0, "yesterday"))),
        "newest first": dict(pl=edit(lambda p: p["candles"]["AAA"].reverse())),
        "duplicate bar": dict(pl=edit(lambda p: p["candles"]["AAA"].insert(4, p["candles"]["AAA"][4]))),
        "off grid": dict(pl=edit(lambda p: p["candles"]["AAA"][11].__setitem__(0, "2024-01-01T11:30:00Z"))),
        "gap": dict(pl=edit(lambda p: [drop(p, s, range(50, 57)) for s in ("AAA", "BBB")], n=60)),
        "misaligned": dict(pl=edit(lambda p: drop(p, "BBB", [11]), n=13)),
        "stale as_of": dict(pl=edit(lambda p: p.update(as_of="2024-01-01T12:00:00Z"))),
        "unreadable as_of": dict(pl=edit(lambda p: p.update(as_of="soon"))),
    }
    for name, kw in cases.items():
        rc, out, err = env.run(**kw)
        assert (rc, out) == (2, ""), f"{name}: rc={rc} out={out!r} err={err!r}"
        assert err.startswith("spq.signal: input refused"), name
    refused(env.cli(["--strategy", str(env.dir), "--sha256", env.sha, "--input", str(tmp_path / "absent.json")]), 2)
    refused(env.cli(["--strategy", str(env.dir), "--sha256", env.sha]), 2)            # --input missing
    refused(env.cli(["--strategy", str(env.dir), "--input", "x"]), 2)                   # --sha256 missing


def test_gap_tolerance_is_explicit(env):
    pl = payload(60)
    for s in pl["candles"]:
        del pl["candles"][s][55]                      # one missing bar inside the lookback window of 10
    refused(env.run(pl), 2)                           # 1 of 10 bars missing: above the default 2 %
    rc, out, _ = env.run(pl, args=["--max-missing-fraction", "0.2"])
    assert rc == 0 and json.loads(out)["weights"] == {"AAA": 0.4, "BBB": 0.4}
    refused(env.run(pl, args=["--max-missing-fraction", "0.2", "--max-gap-bars", "0"]), 2)


def test_in_process_entry_point_matches(env, tmp_path, capsys):
    f = tmp_path / "in.json"
    f.write_text(json.dumps(payload()))
    assert signal_cli.main(["--strategy", str(env.dir), "--sha256", env.sha, "--input", str(f)]) == 0
    out = capsys.readouterr().out
    assert json.loads(out)["weights"] == {"AAA": 0.4, "BBB": 0.4}
    assert signal_cli.main(["--strategy", str(env.dir), "--sha256", "1" * 64, "--input", str(f)]) == 3
    assert capsys.readouterr().out == ""
