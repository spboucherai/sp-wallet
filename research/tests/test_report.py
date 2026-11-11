"""The JSON report: content, schema validation, and the backtest CLI end to end."""
from __future__ import annotations

import copy
import json

import jsonschema
import numpy as np
import pandas as pd
import pytest

from conftest import ROOT, make_data
from spq import backtest as backtest_cli
from spq.data import normalise
from spq.engine import BacktestConfig
from spq.report import build_report, load_schema, validate_report
from spq.research import TestSplitError, read_ledger
from spq.strategy import load_strategy

ARCHITECTURE_KEYS = {
    "top": {"strategy_sha256", "config", "splits", "metrics", "benchmarks", "robustness", "checks", "equity_curve"},
    "config": {"symbols", "interval", "start", "end", "fee_bps", "slippage_bps", "initial_cash"},
    "metrics": {"total_return", "cagr", "volatility", "sharpe", "sortino", "max_drawdown", "calmar", "turnover",
                "trades", "win_rate", "profit_factor", "fees_paid", "exposure"},
    "robustness": {"walk_forward", "bootstrap_sharpe_ci", "parameter_sensitivity", "trials_tested",
                   "deflated_sharpe"},
    "checks": {"lookahead", "data_quality", "notes"},
}
STRATEGY = ROOT / "strategies" / "ma_trend" / "1"
SYMBOLS = ("ETH", "LINK")


@pytest.fixture(scope="module")
def built():
    data = make_data(4000, SYMBOLS, seed=4, drift=0.0001)
    quality = {s: normalise(df, symbol=s, interval="1h", source="synthetic", as_of="2030-01-01")[1]
               for s, df in data.items()}
    strategy = load_strategy(STRATEGY)
    cfg = BacktestConfig("1h", fee_bps=10, slippage_bps=10, rebalance_threshold=0.05)
    report, exp = build_report(strategy, data, cfg, quality=quality, n_resamples=300, source="synthetic")
    return report, exp, strategy, data


def test_report_has_everything_the_architecture_document_lists(built):
    report, exp, strategy, data = built
    assert ARCHITECTURE_KEYS["top"] <= set(report)
    assert ARCHITECTURE_KEYS["config"] <= set(report["config"])
    assert set(report["splits"]) == set(report["metrics"]) == {"train", "validation", "test"}
    for split in report["metrics"].values():
        assert ARCHITECTURE_KEYS["metrics"] <= set(split)
    assert ARCHITECTURE_KEYS["metrics"] <= set(report["benchmarks"]["buy_and_hold"])
    assert {"equal_weight", "buy_and_hold_ETH", "buy_and_hold_LINK"} <= set(report["benchmarks"])
    assert ARCHITECTURE_KEYS["robustness"] <= set(report["robustness"])
    assert ARCHITECTURE_KEYS["checks"] <= set(report["checks"])
    assert report["strategy_sha256"] == strategy.sha256
    assert report["config"]["symbols"] == list(SYMBOLS) and report["config"]["fee_bps"] == 10
    assert report["checks"]["lookahead"] == "pass" and report["checks"]["data_quality"] == "pass"
    json.dumps(report, allow_nan=False)            # strict JSON: no NaN, no Infinity


def test_report_numbers_are_consistent(built):
    report, exp, strategy, data = built
    idx = data["ETH"].index
    assert report["splits"]["train"] == [idx[0].isoformat(), idx[2399].isoformat()]
    assert report["splits"]["test"] == [idx[3200].isoformat(), idx[-1].isoformat()]
    curve = report["equity_curve"]
    assert [curve[0][0], curve[-1][0]] == report["splits"]["test"] and len(curve) == 800
    assert curve[0][1] == 1000.0
    assert curve[-1][1] / 1000 - 1 == pytest.approx(report["metrics"]["test"]["total_return"], abs=1e-8)
    assert report["metrics"]["test"]["bars"] == 800 and report["benchmarks"]["buy_and_hold"]["bars"] == 800
    rob = report["robustness"]
    grid = rob["parameter_sensitivity"]
    assert grid[0]["params"] == strategy.params and len(grid) == 5      # base + fast/slow halved and doubled
    assert rob["trials_tested"] == 5 == rob["deflated_sharpe_detail"]["n_trials"]
    assert rob["test_evaluations"] == 1
    assert 0 <= rob["deflated_sharpe"] <= rob["deflated_sharpe_detail"]["probabilistic_sharpe_vs_zero"] <= 1
    lo, hi = rob["bootstrap_sharpe_ci"]
    assert lo < report["metrics"]["test"]["sharpe"] < hi
    assert len(rob["walk_forward"]) == 4 and all(f["out_of_sample"][1] <= report["splits"]["test"][0]
                                                 for f in rob["walk_forward"])
    assert len(rob["stress_windows"]) == 3 and rob["stress_windows"][0]["benchmark_return"] < 0
    assert rob["monte_carlo"]["bar_returns"]["total_return_p05"] < rob["monte_carlo"]["bar_returns"]["total_return_p95"]
    # a strategy that is in cash part of the time has less exposure than buy-and-hold
    assert report["metrics"]["test"]["exposure"] < report["benchmarks"]["buy_and_hold"]["exposure"]


def test_the_experiment_is_sealed_after_the_report(built):
    report, exp, strategy, data = built
    with pytest.raises(TestSplitError):
        exp.trial(strategy, {"fast": 10, "slow": 100})


def test_schema_accepts_the_report_and_rejects_broken_ones(built):
    report = built[0]
    schema = load_schema()
    jsonschema.Draft202012Validator.check_schema(schema)
    validate_report(report)

    def broken(fn):
        r = copy.deepcopy(report)
        fn(r)
        with pytest.raises(jsonschema.ValidationError):
            validate_report(r)

    for key in ARCHITECTURE_KEYS["top"]:
        broken(lambda r, key=key: r.pop(key))
    for key in ARCHITECTURE_KEYS["config"]:
        broken(lambda r, key=key: r["config"].pop(key))
    for key in ARCHITECTURE_KEYS["metrics"]:
        broken(lambda r, key=key: r["metrics"]["test"].pop(key))
        broken(lambda r, key=key: r["benchmarks"]["buy_and_hold"].pop(key))
    for key in ARCHITECTURE_KEYS["robustness"]:
        broken(lambda r, key=key: r["robustness"].pop(key))
    for key in ARCHITECTURE_KEYS["checks"]:
        broken(lambda r, key=key: r["checks"].pop(key))
    broken(lambda r: r.update(strategy_sha256="abc"))
    broken(lambda r: r.update(strategy_sha256=r["strategy_sha256"].upper()))
    broken(lambda r: r["checks"].update(lookahead="probably"))
    broken(lambda r: r["checks"].update(data_quality=True))
    broken(lambda r: r["metrics"].pop("validation"))
    broken(lambda r: r["metrics"].update(holdout=r["metrics"]["test"]))
    broken(lambda r: r["metrics"]["test"].update(sharpe="1.2"))
    broken(lambda r: r["metrics"]["test"].update(max_drawdown=-0.2))
    broken(lambda r: r["metrics"]["test"].update(win_rate=1.5))
    broken(lambda r: r["metrics"]["test"].update(trades=3.5))
    broken(lambda r: r["metrics"]["test"].update(profitable=True))
    broken(lambda r: r["robustness"].update(trials_tested=0))
    broken(lambda r: r["robustness"].update(deflated_sharpe=1.2))
    broken(lambda r: r["robustness"].update(bootstrap_sharpe_ci=[0.1]))
    broken(lambda r: r["splits"].update(test=["2024-01-01T00:00:00+00:00"]))
    broken(lambda r: r["config"].update(symbols=[]))
    broken(lambda r: r["config"].update(fee_bps=-1))
    broken(lambda r: r.update(equity_curve=[["2024-01-01T00:00:00+00:00", 1000.0]]))
    broken(lambda r: r["equity_curve"].__setitem__(0, ["2024-01-01T00:00:00+00:00", "1000"]))
    # undefined ratios are null, which is valid
    r = copy.deepcopy(report)
    r["metrics"]["test"].update(sharpe=None, profit_factor=None, win_rate=None, calmar=None)
    r["robustness"].update(deflated_sharpe=None, bootstrap_sharpe_ci=[None, None])
    validate_report(r)


def test_missing_quality_record_fails_the_data_check():
    data = make_data(1500, SYMBOLS, seed=5)
    report, _ = build_report(load_strategy(STRATEGY), data, BacktestConfig("1h", rebalance_threshold=0.05),
                             n_resamples=100, grid=[{"fast": 72, "slow": 480}])
    assert report["checks"]["data_quality"] == "fail" and report["robustness"]["trials_tested"] == 1
    assert any("no data-quality record" in n for n in report["checks"]["notes"])


def test_backtest_cli_end_to_end(tmp_path, capsys):
    data = make_data(3000, SYMBOLS, seed=6)
    gap = data["LINK"].index[[700, 701]]
    for sym, df in data.items():
        p = tmp_path / "data" / "coinbase" / f"{sym}_1h.parquet"
        p.parent.mkdir(parents=True, exist_ok=True)
        (df.drop(index=gap) if sym == "LINK" else df).reset_index().to_parquet(p, index=False)
    out, ledger = tmp_path / "out" / "report.json", tmp_path / "trials.jsonl"
    argv = ["--strategy", str(STRATEGY), "--symbols", "ETH,LINK", "--interval", "1h", "--start", "2024-01-01",
            "--end", "2024-05-01", "--fee-bps", "10", "--slippage-bps", "10", "--data-dir", str(tmp_path / "data"),
            "--grid", '{"fast": [48, 72], "slow": [240, 480]}', "--resamples", "200", "--ledger", str(ledger),
            "--out", str(out)]
    assert backtest_cli.main(argv) == 0
    line = json.loads(capsys.readouterr().out)
    report = json.loads(out.read_text())
    validate_report(report)
    assert line["report"] == str(out) and line["strategy_sha256"] == report["strategy_sha256"]
    assert report["config"]["bars"] == 2902 and report["config"]["rebalance_threshold"] == 0.05   # 2904 - 2 missing
    assert report["config"]["start"] == "2024-01-01T00:00:00+00:00"
    assert pd.Timestamp(report["config"]["end"]) == pd.Timestamp("2024-04-30T23:00", tz="UTC")
    assert report["robustness"]["trials_tested"] == 4 and len(read_ledger(ledger)) == 5
    assert any("LINK: 2 missing bars" in n for n in report["checks"]["notes"])
    assert any("common bars kept: 2902" in n for n in report["checks"]["notes"])
    assert report["checks"]["data_quality"] == "pass"

    # a second run adds to the ledger: the trial count is unchanged (same configurations), the test look is counted
    assert backtest_cli.main(argv) == 0
    capsys.readouterr()
    again = json.loads(out.read_text())
    assert again["robustness"]["trials_tested"] == 4 and again["robustness"]["test_evaluations"] == 2
    assert again["metrics"] == report["metrics"] and again["equity_curve"] == report["equity_curve"]

    # refusals: wrong hash, unknown data, bad split
    assert backtest_cli.main(argv + ["--sha256", "0" * 64]) == 2
    assert backtest_cli.main([a if a != "ETH,LINK" else "ETH,DOGE" for a in argv]) == 2
    assert backtest_cli.main(argv + ["--split", "0.9,0.2,0.1"]) == 2
    assert "spq.backtest:" in capsys.readouterr().err


def test_report_never_claims_profitability(built):
    text = json.dumps(built[0]).lower()
    for word in ("profitable", "recommend", "guarantee", "will make"):
        assert word not in text
    assert np.isfinite(built[0]["metrics"]["test"]["total_return"])
