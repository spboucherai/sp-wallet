"""v7 research jobs: the job ledger hook, the job's commands (trial / evaluate with a cross-process seal / split),
the static lint that never executes, and the deflated Sharpe ratio that counts a job's trials."""
from __future__ import annotations

import json

import numpy as np
import pytest

from conftest import make_data, write_strategy
from spq import job as jobmod
from spq import lint
from spq.dsr import deflate_for_job, deflated_sharpe_from_returns
from spq.engine import BacktestConfig
from spq.report import build_report
from spq.research import JOB_LEDGER_ENV, Experiment, read_job_trials, read_ledger
from spq.strategy import load_strategy

META = {"name": "rj_test", "version": "1", "universe": ["AAA", "BBB"], "interval": "1h", "lookback": 60,
        "params": {"fast": 8, "slow": 40}}
BODY = """
fast, slow = int(params["fast"]), int(params["slow"])
out = {}
for s, df in data.items():
    c = df["close"].to_numpy()
    out[s] = 0.5 if len(c) >= slow and c[-fast:].mean() > c[-slow:].mean() else 0.0
return out
"""


@pytest.fixture
def job(tmp_path, monkeypatch):
    """A job directory: data files, a job file, a ledger path in the environment."""
    data = make_data(900, seed=3)
    root = tmp_path / "data" / "coinbase"
    root.mkdir(parents=True)
    for s, df in data.items():
        out = df.reset_index()
        out["ts"] = (out["ts"].astype("int64") // 10**9).astype("int64") if str(out["ts"].dtype).endswith("ns, UTC]") \
            else out["ts"].map(lambda t: int(t.timestamp()))
        out.to_csv(root / f"{s}_1h.csv", index=False)
    jf = tmp_path / "JOB.json"
    jf.write_text(json.dumps({"kind": "spot", "symbols": ["AAA", "BBB"], "interval": "1h", "capital_usd": 1000,
                              "data_dir": str(tmp_path / "data"), "source": "coinbase"}))
    ledger = tmp_path / "ledger" / "trials.jsonl"
    monkeypatch.setenv(JOB_LEDGER_ENV, str(ledger))
    monkeypatch.setenv(jobmod.JOB_FILE_ENV, str(jf))
    return {"dir": tmp_path, "ledger": ledger, "data": data, "file": jf}


def lines(path):
    return [json.loads(x) for x in path.read_text().splitlines() if x.strip()] if path.exists() else []


# ------------------------------------------------------------------------------------------------- the ledger hook

def test_every_experiment_appends_to_the_job_ledger_whatever_ledger_the_caller_passes(tmp_path, monkeypatch):
    data = make_data(400, seed=1)
    s = load_strategy(write_strategy(tmp_path / "s", BODY, META))
    job_ledger = tmp_path / "job.jsonl"
    monkeypatch.setenv(JOB_LEDGER_ENV, str(job_ledger))
    exp = Experiment(data, BacktestConfig("1h"))                       # no ledger asked for
    exp.trial(s)
    exp.trial(s, {"fast": 4, "slow": 40})
    exp.trial(s)                                                       # cached: not a new trial
    assert [r["kind"] for r in lines(job_ledger)] == ["trial", "trial"]
    own = tmp_path / "own.jsonl"
    exp2 = Experiment(data, BacktestConfig("1h"), ledger=own)          # a private ledger does not hide the trial
    exp2.trial(s)
    exp2.final_test(s)
    assert [r["kind"] for r in lines(own)] == ["trial", "test"]
    assert [r["kind"] for r in lines(job_ledger)] == ["trial", "trial", "trial", "test"]
    exp3 = Experiment(data, BacktestConfig("1h"), ledger=job_ledger)   # the same file twice: one line, not two
    exp3.trial(s)
    assert len(lines(job_ledger)) == 5
    monkeypatch.delenv(JOB_LEDGER_ENV)
    Experiment(data, BacktestConfig("1h")).trial(s)                    # without the variable: as before v7
    assert len(lines(job_ledger)) == 5


def test_the_job_ledger_is_read_defensively(tmp_path):
    p = tmp_path / "l.jsonl"
    p.write_text("\n".join([
        json.dumps({"kind": "trial", "validation_sharpe_per_bar": 0.01}),
        json.dumps({"kind": "trial", "validation_sharpe_per_bar": 1e9}),      # absurd: counted, number dropped
        json.dumps({"kind": "trial", "validation_sharpe_per_bar": "0.5"}),    # not a number
        json.dumps({"kind": "trial", "validation_sharpe_per_bar": float("nan")}),
        json.dumps({"kind": "test"}),
        json.dumps({"kind": "something else"}),
        "not json at all",
        json.dumps([1, 2, 3]),
        "",
    ]) + "\n")
    r = read_job_trials(p)
    assert r["count"] == 8                      # every non-empty line is something the job did
    assert r["sharpes"] == [0.01]
    assert r["unreadable"] == 3
    assert read_job_trials(tmp_path / "missing") == {"count": 0, "sharpes": [], "unreadable": 0}


# --------------------------------------------------------------------------------------------- deflated Sharpe ratio

def test_a_jobs_trials_raise_the_bar_and_its_numbers_can_never_lower_it():
    rng = np.random.default_rng(0)
    r = rng.normal(0.0008, 0.01, 2000)
    own = [0.01, -0.02, 0.03, 0.0, 0.015]
    base = deflated_sharpe_from_returns(r, own)
    # 300 more trials with dispersed Sharpe ratios: more trials and at least the same variance -> a lower DSR
    wide = {"count": 300, "sharpes": list(rng.normal(0, 0.03, 300)), "unreadable": 0}
    d = deflate_for_job(base, r, own, wide)
    assert d["n_trials"] == 305 and d["n_trials_job"] == 300 and d["n_trials_this_run"] == 5
    assert d["var_trial_sharpes"] >= base["var_trial_sharpes"]
    assert d["deflated_sharpe"] < base["deflated_sharpe"]
    assert d["expected_max_sharpe_per_bar"] > base["expected_max_sharpe_per_bar"]
    # an agent that writes 300 identical Sharpe ratios to shrink the variance: the variance of the server's own
    # trials is the floor, the count still rises
    flat = {"count": 300, "sharpes": [0.0] * 300, "unreadable": 0}
    f = deflate_for_job(base, r, own, flat)
    assert f["var_trial_sharpes"] == pytest.approx(base["var_trial_sharpes"])
    assert f["n_trials"] == 305 and f["deflated_sharpe"] < base["deflated_sharpe"]
    # a job that recorded nothing changes nothing
    z = deflate_for_job(base, r, own, {"count": 0, "sharpes": [], "unreadable": 0})
    assert z["deflated_sharpe"] == pytest.approx(base["deflated_sharpe"]) and z["n_trials"] == 5
    assert base["n_trials"] == 5                                       # the input was not modified


def test_the_report_counts_the_jobs_trials(tmp_path):
    data = make_data(700, seed=5)
    s = load_strategy(write_strategy(tmp_path / "s", BODY, META))
    job_ledger = tmp_path / "job.jsonl"
    job_ledger.write_text("".join(json.dumps({"kind": "trial", "validation_sharpe_per_bar": 0.02 * (i % 5 - 2)}) + "\n"
                                  for i in range(40)))
    plain, _ = build_report(s, data, BacktestConfig("1h"), n_resamples=50, n_folds=2)
    counted, _ = build_report(s, data, BacktestConfig("1h"), n_resamples=50, n_folds=2, job_ledger=job_ledger)
    n = plain["robustness"]["trials_tested"]
    assert counted["robustness"]["trials_tested"] == n + 40
    d = counted["robustness"]["deflated_sharpe_detail"]
    assert d["n_trials_job"] == 40 and d["n_trials_this_run"] == n
    assert counted["metrics"] == plain["metrics"]                      # only the statistical bar moved


# ------------------------------------------------------------------------------------------------------- spq.lint

def test_lint_parses_and_hashes_but_never_executes(tmp_path, capsys):
    ok = write_strategy(tmp_path / "ok", "", raw="X = 1 / 0\nMETA = {}\n\n\ndef target_weights(data, params):\n    return {}\n")
    assert lint.main(["--strategy", str(ok)]) == 0                     # importing it would raise ZeroDivisionError
    out = json.loads(capsys.readouterr().out)
    assert out["problems"] == [] and len(out["sha256"]) == 64
    bad = write_strategy(tmp_path / "bad", "", raw="import socket\nimport os\n\n\ndef target_weights(data, params):\n"
                                                    "    return {'x': open('/etc/passwd').read()}\n")
    assert lint.main(["--strategy", str(bad)]) == 3
    problems = json.loads(capsys.readouterr().out)["problems"]
    assert any("socket" in p for p in problems) and any("'open'" in p for p in problems)
    assert lint.main(["--strategy", str(tmp_path / "nothing")]) == 2
    big = write_strategy(tmp_path / "big", "", raw="# " + "x" * (lint.MAX_BYTES + 1) + "\n")
    assert lint.main(["--strategy", str(big)]) == 2
    link = tmp_path / "link"
    link.mkdir()
    (link / "strategy.py").symlink_to(ok / "strategy.py")
    assert lint.main(["--strategy", str(link)]) == 2                   # a symbolic link is not a strategy file


# -------------------------------------------------------------------------------------------------------- spq.job

def test_trial_runs_on_train_and_validation_only_and_is_counted(job, capsys):
    d = write_strategy(job["dir"] / "cand", BODY, META)
    assert jobmod.main(["trial", "--strategy", str(d)]) == 0
    out = json.loads(capsys.readouterr().out)
    assert set(out) == {"strategy_sha256", "params", "train", "validation"}
    assert jobmod.main(["trial", "--strategy", str(d), "--params", '{"fast": 4}']) == 0
    assert json.loads(capsys.readouterr().out)["params"] == {"fast": 4, "slow": 40}
    recs = lines(job["ledger"])
    assert [r["kind"] for r in recs] == ["trial", "trial"]
    assert recs[1]["params"] == {"fast": 4, "slow": 40}


def test_evaluate_writes_the_report_and_the_claims_and_seals_the_inner_test_split_across_processes(job, capsys):
    a = write_strategy(job["dir"] / "a", BODY, META)
    out, claims = job["dir"] / "report.json", job["dir"] / "claims.json"
    assert jobmod.main(["evaluate", "--strategy", str(a), "--out", str(out), "--claims", str(claims)]) == 0
    capsys.readouterr()
    report, c = json.loads(out.read_text()), json.loads(claims.read_text())
    assert c["train"]["sharpe"] == report["metrics"]["train"]["sharpe"]
    assert c["inner_test"]["total_return"] == report["metrics"]["test"]["total_return"]
    assert c["summary"] == "" and c["trials"] == len(lines(job["ledger"]))
    assert report["config"]["initial_cash"] == 1000.0
    tests = [r for r in lines(job["ledger"]) if r["kind"] == "test"]
    assert len(tests) == 1 and tests[0]["sha256"] == report["strategy_sha256"]
    assert jobmod.sealed_hash(job["ledger"]) == report["strategy_sha256"]
    # another version after the look: refused, in a NEW process state (nothing in memory links the two calls)
    b = write_strategy(job["dir"] / "b", BODY, {**META, "params": {"fast": 12, "slow": 40}})
    assert jobmod.main(["evaluate", "--strategy", str(b), "--out", str(job["dir"] / "r2.json")]) == 7
    assert "already evaluated" in capsys.readouterr().err
    assert not (job["dir"] / "r2.json").exists()
    assert len([r for r in lines(job["ledger"]) if r["kind"] == "test"]) == 1
    # the same version again is allowed (and counted again)
    assert jobmod.main(["evaluate", "--strategy", str(a), "--out", str(out)]) == 0
    assert len([r for r in lines(job["ledger"]) if r["kind"] == "test"]) == 2


def test_split_reports_the_boundaries_the_laboratory_itself_uses(job, capsys):
    assert jobmod.main(["split", "--kind", "spot", "--symbols", "AAA,BBB", "--interval", "1h",
                        "--data-dir", str(job["dir"] / "data"), "--source", "coinbase"]) == 0
    s = json.loads(capsys.readouterr().out)
    idx = job["data"]["AAA"].index
    assert (s["bars"], s["dev_bars"], s["test_bars"]) == (900, 720, 180)
    assert s["start"] == idx[0].isoformat() and s["test_start"] == idx[720].isoformat() and s["last"] == idx[-1].isoformat()
    assert jobmod.main(["info"]) == 0
    assert json.loads(capsys.readouterr().out)["bars"] == 900


def test_wrong_kind_and_missing_job_file_fail_with_one_line(job, capsys, monkeypatch):
    perp = write_strategy(job["dir"] / "p", "return {}\n", {**META, "kind": "perp", "max_leverage": 2.0,
                                                           "max_gross_exposure": 1.0})
    assert jobmod.main(["trial", "--strategy", str(perp)]) == 2
    assert "the job is a spot job" in capsys.readouterr().err
    monkeypatch.delenv(jobmod.JOB_FILE_ENV)
    assert jobmod.main(["info"]) == 2
    assert "no job file" in capsys.readouterr().err


def test_the_standard_arguments_are_the_same_on_both_sides():
    j = {"kind": "spot", "symbols": ["BTC", "ETH"], "interval": "1h", "capital_usd": 1000, "data_dir": "/d",
         "source": "coinbase"}
    assert jobmod.backtest_argv(j, "/s", "/o.json", sha256="ab") == [
        "--strategy", "/s", "--symbols", "BTC,ETH", "--interval", "1h", "--data-dir", "/d", "--initial-cash", "1000.0",
        "--out", "/o.json", "--resamples", "300", "--folds", "3", "--source", "coinbase", "--sha256", "ab"]
    p = jobmod.backtest_argv({**j, "kind": "perp"}, "/s", "/o.json", ledger="/l", job_ledger="/j")
    assert "--source" not in p and p[-4:] == ["--ledger", "/l", "--job-ledger", "/j"]
    assert read_ledger("/nonexistent/ledger") == []
