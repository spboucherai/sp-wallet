"""Version-2 report: schema, version-1 compatibility, checks, benchmarks, trial counting, CLIs."""
from __future__ import annotations

import copy
import json

import jsonschema
import numpy as np
import pandas as pd
import pytest

from conftest import ROOT, write_strategy
from perp_helpers import perp_data, perp_meta, settlements
from spq import backtest as spot_cli
from spq import perp_backtest as cli
from spq import perp_pipeline as pipeline
from spq.data.core import normalise
from spq.data.hyperliquid import normalise_funding
from spq.perp_engine import PerpConfig
from spq.perp_metrics import PERP_KEYS, compute_perp_metrics, holding_runs
from spq.perp_report import build_perp_report, load_schema_v2, returns_from_report, validate_report_v2
from spq.perp_research import PerpExperiment, funding_regimes
from spq.report import load_schema
from spq.research import read_ledger
from spq.strategy import from_function

SYMS = ("BTC", "ETH")
CONFIG = PerpConfig("1h", rebalance_threshold=0.05, venue_max_leverage={"BTC": 40, "ETH": 25},
                    size_decimals={"BTC": 5, "ETH": 4})


def trend(d, p):
    out = {}
    for s, df in d.items():
        c = df["close"].to_numpy()
        w = int(p["window"])
        out[s] = 0.0 if len(c) <= w else float(np.sign(c[-1] - c[-1 - w])) * p["gross"] / len(d)
    return out


def strategy(lookback=60, **params):
    return from_function(trend, perp_meta(SYMS, lookback=lookback, max_leverage=3.0, max_gross=3.0,
                                          params={"window": 24, "gross": 1.0, **params}, name="trend_perp"))


def inputs(n=2000, seed=1):
    data = perp_data(n, SYMS, seed=seed, sigma=0.01)
    as_of = data["BTC"].index[-1] + pd.Timedelta(hours=2)
    quality = {s: normalise(df[["open", "high", "low", "close", "volume"]], symbol=s, interval="1h",
                            source="hyperliquid", as_of=as_of)[1] for s, df in data.items()}
    raw = {s: settlements(df) for s, df in data.items()}
    fq = {s: normalise_funding(f.reset_index(drop=True), symbol=s, as_of=as_of)[1] for s, f in raw.items()}
    spot = {s: df[["open", "high", "low", "close", "volume"]] * 1.0005 for s, df in data.items()}
    return data, quality, fq, raw, spot


@pytest.fixture(scope="module")
def report():
    data, quality, fq, raw, spot = inputs()
    rep, exp = build_perp_report(strategy(), data, CONFIG, quality=quality, funding_quality=fq, funding_raw=raw,
                                 spot_data=spot, n_resamples=200, source="hyperliquid")
    return rep, exp, data


def test_report_follows_schema_v2_and_keeps_every_v1_key(report):
    rep, _, _ = report
    validate_report_v2(rep)
    assert rep["schema_version"] == 2 and rep["kind"] == "perp"
    json.dumps(rep, allow_nan=False)
    # every version-1 key is there, with a value a version-1 consumer accepts: validate against the version-1
    # schema with only its version constant, its closed key lists and its symbol pattern relaxed
    v1 = copy.deepcopy(load_schema())
    v1["properties"].pop("schema_version")

    def relax(node):
        if isinstance(node, dict):
            node.pop("additionalProperties", None)
            if node.get("description") == "average invested fraction of equity":
                node.pop("maximum", None)             # gross exposure can exceed 1 with leverage
            for v in node.values():
                relax(v)
        elif isinstance(node, list):
            for v in node:
                relax(v)

    relax(v1)
    jsonschema.Draft202012Validator(v1).validate(rep)
    v1m = load_schema()["$defs"]["metrics"]
    for split in ("train", "validation", "test"):
        assert set(v1m["required"]) <= set(rep["metrics"][split]) and set(PERP_KEYS) <= set(rep["metrics"][split])
    assert set(load_schema()["properties"]["config"]["required"]) <= set(rep["config"])
    assert set(load_schema()["properties"]["robustness"]["required"]) <= set(rep["robustness"])
    # ... and the strict version-1 schema refuses it (schema_version is 2): no silent confusion
    assert not jsonschema.Draft202012Validator(load_schema()).is_valid(rep)


def test_schema_v2_refuses_reports_without_the_new_checks(report):
    rep, _, _ = report
    for path in (("checks", "ledger"), ("checks", "funding_alignment"), ("benchmarks", "perp_long_1x"),
                 ("metrics", "test", "funding_pnl"), ("metrics", "test", "liquidations"), ("ledger",), ("kind",)):
        bad = copy.deepcopy(rep)
        node = bad
        for k in path[:-1]:
            node = node[k]
        node.pop(path[-1])
        with pytest.raises(jsonschema.ValidationError):
            validate_report_v2(bad)
    bad = copy.deepcopy(rep)
    bad["checks"]["ledger"] = "maybe"
    with pytest.raises(jsonschema.ValidationError):
        validate_report_v2(bad)
    bad = copy.deepcopy(rep)
    bad["schema_version"] = 1
    with pytest.raises(jsonschema.ValidationError):
        validate_report_v2(bad)
    assert load_schema_v2()["properties"]["checks"]["required"][-2:] == ["ledger", "funding_alignment"]


def test_report_contents(report):
    rep, exp, data = report
    c = rep["checks"]
    assert (c["lookahead"], c["data_quality"], c["ledger"], c["funding_alignment"]) == ("pass",) * 4
    t = rep["metrics"]["test"]
    assert t["bars"] == 400 and t["trades"] > 0 and t["funding_payments"] > 0 and t["wiped_out"] is False
    assert 0 < t["gross_leverage_mean"] <= t["gross_leverage_max"] <= 3.0 + 1e-9
    assert t["long_exposure"] >= 0 and t["short_exposure"] >= 0
    assert t["exposure"] == pytest.approx(t["long_exposure"] + t["short_exposure"])
    assert t["net_leverage_mean"] == pytest.approx(t["long_exposure"] - t["short_exposure"])
    assert 0 < t["time_in_market"] <= 1 and t["avg_holding_hours"] == t["avg_holding_bars"] > 0
    assert t["worst_intrabar_drawdown"] >= t["max_drawdown"] - 1e-12
    assert 0 < t["margin_utilisation_mean"] <= t["margin_utilisation_max"]
    # ledger: exact strings that add up
    from decimal import Decimal as D

    from spq.margin import exact

    for split in ("train", "validation", "test"):
        led = rep["ledger"][split]
        assert led["reconciles"] is True
        with exact():                                    # a sum that raises instead of rounding
            total = (D(led["initial"]) + D(led["realised_pnl"]) + D(led["funding"]) - D(led["fees"])
                     - D(led["slippage"]) + D(led["unrealised_pnl"]) + D(led["bad_debt_written_off"]))
            assert total == D(led["final_equity"])
        assert float(led["final_equity"]) == pytest.approx(rep["metrics"][split]["final_equity"], rel=1e-9)
        assert float(led["funding"]) == pytest.approx(rep["metrics"][split]["funding_pnl"], rel=1e-9, abs=1e-12)
    # benchmarks: spot buy-and-hold (spot engine: v1 metrics) and perp long 1x including funding (v2 metrics)
    b = rep["benchmarks"]
    assert {"buy_and_hold", "perp_long_1x", "perp_long_1x_BTC", "perp_long_1x_ETH"} <= set(b)
    assert "funding_pnl" not in b["buy_and_hold"] and b["perp_long_1x"]["funding_pnl"] < 0   # longs paid (rate > 0)
    assert b["perp_long_1x"]["trades"] == 2 and b["perp_long_1x"]["gross_leverage_max"] < 1.2
    # the 1x perp differs from spot by the funding it paid (plus the small price and cost differences of the fixture)
    assert b["perp_long_1x"]["total_return"] < b["buy_and_hold"]["total_return"] + 0.01
    rob = rep["robustness"]
    assert len(rob["bootstrap"]["perp_long_1x_sharpe_ci"]) == 2 and len(rob["bootstrap"]["buy_and_hold_sharpe_ci"]) == 2
    assert rob["trials_tested"] == 5 and rob["test_evaluations"] == 1 and len(rob["walk_forward"]) == 4
    assert len(rob["parameter_sensitivity"]) == 5 and all("error" not in r for r in rob["parameter_sensitivity"])
    assert set(rob["benchmarks_by_split"]) == {"train", "validation"}
    regimes = [w["regime"] for w in rob["funding_stress_windows"]]
    assert "highest funding" in regimes and "lowest funding" in regimes
    for w in rob["funding_stress_windows"]:
        assert rep["splits"]["test"][0] <= w["window"][0] <= w["window"][1] <= rep["splits"]["test"][1]
    f = rep["funding"]["test"]["BTC"]
    assert f["bars_with_funding"] == 400 and f["mean_rate_annualised"] == pytest.approx(f["mean_rate_per_bar"] * 8760)
    assert rep["config"]["maintenance_fraction"] == {"BTC": 0.0125, "ETH": 0.02}      # half the IM at 40x / 25x
    assert rep["config"]["fee_bps"] == 4.5 and rep["config"]["leverage"] == 3.0
    assert np.allclose(returns_from_report(rep), exp.final_test(strategy()).returns.to_numpy(), atol=1e-6)


def test_checks_fail_when_they_should():
    data, quality, fq, raw, spot = inputs(900, seed=2)
    kw = dict(n_resamples=50, n_folds=2)
    # no settlement series -> the alignment cannot be shown; no quality record -> data_quality fails
    rep, _ = build_perp_report(strategy(), data, CONFIG, **kw)
    assert rep["checks"]["funding_alignment"] == "fail" and rep["checks"]["data_quality"] == "fail"
    assert rep["checks"]["ledger"] == "pass"
    assert any("WITHOUT funding" in n for n in rep["checks"]["notes"])                 # no spot data either
    assert "funding_pnl" in rep["benchmarks"]["buy_and_hold"] and rep["benchmarks"]["buy_and_hold"]["funding_pnl"] == 0
    # a funding column shifted by one bar (the settlement of the bar's END): caught
    shifted = {s: df.assign(funding=df["funding"].shift(-1)) for s, df in data.items()}
    rep, _ = build_perp_report(strategy(), shifted, CONFIG, quality=quality, funding_quality=fq, funding_raw=raw,
                               spot_data=spot, **kw)
    assert rep["checks"]["funding_alignment"] == "fail" and rep["checks"]["data_quality"] == "pass"
    # a funding series with a long hole: data quality fails
    holed = {s: f.drop(f.index[100:140]) for s, f in raw.items()}
    fq_bad = {s: normalise_funding(f.reset_index(drop=True), symbol=s, as_of="2100-01-01")[1] for s, f in holed.items()}
    rep, _ = build_perp_report(strategy(), data, CONFIG, quality=quality, funding_quality=fq_bad, funding_raw=raw,
                               spot_data=spot, **kw)
    assert rep["checks"]["data_quality"] == "fail" and any("missing settlements" in n for n in rep["checks"]["notes"])
    with pytest.raises(ValueError, match="not a perp strategy"):
        spot_meta = {"name": "s", "version": "1", "universe": list(SYMS), "interval": "1h", "lookback": 10, "params": {}}
        build_perp_report(from_function(lambda d, p: {}, spot_meta), data, CONFIG)


def test_liquidations_and_wipe_out_are_reported(tmp_path):
    data, quality, fq, raw, spot = inputs(900, seed=5)
    reckless = from_function(lambda d, p: {"BTC": 20.0, "ETH": -19.0},
                             perp_meta(SYMS, lookback=5, max_leverage=20.0, max_gross=40.0, name="reckless_perp"))
    rep, _ = build_perp_report(reckless, data, CONFIG, quality=quality, funding_quality=fq, funding_raw=raw,
                               spot_data=spot, n_resamples=50, n_folds=2)
    validate_report_v2(rep)
    t = rep["metrics"]["test"]
    assert t["liquidations"] >= 1 and len(rep["liquidations"]["test"]) == t["liquidations"]
    first = rep["liquidations"]["test"][0]
    assert first["positions"] and first["reason"] and first["ts"] >= rep["splits"]["test"][0]
    assert rep["checks"]["ledger"] == "pass"
    if t["wiped_out"]:
        assert t["total_return"] == -1.0 and rep["equity_curve"][-1][1] == 0.0
        assert float(rep["ledger"]["test"]["bad_debt_written_off"]) > 0


def test_every_trial_is_counted_across_runs(tmp_path):
    data, quality, fq, raw, spot = inputs(900, seed=6)
    ledger = tmp_path / "ledger.jsonl"
    kw = dict(quality=quality, funding_quality=fq, funding_raw=raw, spot_data=spot, n_resamples=50, n_folds=2,
              ledger=ledger)
    rep1, _ = build_perp_report(strategy(), data, CONFIG, **kw)
    assert rep1["robustness"]["trials_tested"] == 5
    other = from_function(trend, perp_meta(SYMS, lookback=60, max_leverage=3.0, max_gross=3.0,
                                           params={"window": 36, "gross": 1.0}, name="trend_perp_b"))
    rep2, _ = build_perp_report(other, data, CONFIG, **kw)
    assert rep2["robustness"]["trials_tested"] == 10                      # its 5 + the 5 tried before
    assert rep2["robustness"]["deflated_sharpe_detail"]["n_trials"] == 10
    recs = read_ledger(ledger)
    assert sum(r["kind"] == "trial" for r in recs) == 10 and sum(r["kind"] == "test" for r in recs) == 2
    rep3, _ = build_perp_report(strategy(), data, CONFIG, **kw)           # a second look at the same test split
    assert rep3["robustness"]["test_evaluations"] == 2


def test_holding_runs_and_funding_regimes():
    w = np.array([[0, 1], [1, 1], [1, -1], [1, -1], [0, 0], [-1, 0], [-1, 2]], dtype=float)
    assert sorted(holding_runs(w)) == [1, 2, 2, 2, 3]
    idx = pd.date_range("2024-01-01", periods=400, freq="1h", tz="UTC")
    f = np.zeros(400)
    f[50:90] = 1e-3
    f[300:340] = -1e-3
    data = {"X": pd.DataFrame({"funding": f}, index=idx), "X.SPOT": pd.DataFrame({"close": 1.0}, index=idx)}
    regimes = funding_regimes(data, idx[0], idx[-1] + pd.Timedelta(hours=1), window_bars=40, top=1)
    assert [r["regime"] for r in regimes] == ["highest funding", "lowest funding"]
    assert regimes[0]["start"] == idx[50] and regimes[0]["end"] == idx[89] and regimes[0]["mean_rate"] == pytest.approx(1e-3)
    assert regimes[1]["start"] == idx[300] and regimes[1]["mean_rate"] == pytest.approx(-1e-3)
    assert funding_regimes({"X": data["X.SPOT"]}, idx[0], idx[-1], window_bars=40) == []


# ------------------------------------------------------------------------------------------------------- CLIs

BODY = """import numpy as np
out = {}
for s, df in data.items():
    if s.endswith('.SPOT'):
        out[s] = 0.2
        continue
    c = df['close'].to_numpy()
    f = df['funding'].to_numpy()
    out[s] = -0.2 if np.nanmean(f[-12:]) > 0 else float(np.sign(c[-1] - c[0])) * params['gross'] / 2
return out
"""


def store(tmp_path, n=900, seed=3):
    """A local store in the layout of spq.data.hyperliquid / spq.data.fetch."""
    data = perp_data(n, SYMS, seed=seed, sigma=0.01)
    for s, df in data.items():
        (tmp_path / "hyperliquid" / "funding").mkdir(parents=True, exist_ok=True)
        (tmp_path / "coinbase").mkdir(exist_ok=True)
        df[["open", "high", "low", "close", "volume"]].reset_index().to_parquet(tmp_path / "hyperliquid" / f"{s}_1h.parquet", index=False)
        (df[["open", "high", "low", "close", "volume"]] * 1.0003).reset_index().to_parquet(tmp_path / "coinbase" / f"{s}_1h.parquet", index=False)
        settlements(df).reset_index(drop=True).to_parquet(tmp_path / "hyperliquid" / "funding" / f"{s}.parquet", index=False)
    (tmp_path / "hyperliquid" / "meta.json").write_text(json.dumps({"universe": {
        "BTC": {"max_leverage": 40.0, "size_decimals": 5}, "ETH": {"max_leverage": 25.0, "size_decimals": 4}}}))
    return data


def test_perp_backtest_cli_writes_a_valid_report(tmp_path, capsys):
    store(tmp_path)
    d = write_strategy(tmp_path / "strategies" / "carry_perp" / "1", BODY,
                       meta=perp_meta(("BTC", "ETH", "BTC.SPOT"), lookback=40, max_leverage=2.0, max_gross=2.0,
                                      params={"gross": 1.0}, name="carry_perp"))
    out = tmp_path / "report.json"
    code = cli.main(["--strategy", str(d), "--data-dir", str(tmp_path), "--out", str(out), "--resamples", "50",
                     "--folds", "2", "--ledger", str(tmp_path / "l.jsonl")])
    printed = capsys.readouterr()
    assert code == 0, printed.err
    rep = json.loads(out.read_text())
    validate_report_v2(rep)
    line = json.loads(printed.out)
    assert line["checks"] == {"lookahead": "pass", "data_quality": "pass", "ledger": "pass", "funding_alignment": "pass"}
    assert rep["config"]["symbols"] == ["BTC", "ETH", "BTC.SPOT"] and rep["config"]["source"] == "hyperliquid"
    assert rep["config"]["venue_max_leverage"] == {"BTC": 40.0, "ETH": 25.0}          # read from meta.json
    assert rep["config"]["size_decimals"] == {"BTC": 5, "ETH": 4, "BTC.SPOT": 6}
    assert rep["metrics"]["test"]["long_exposure"] > 0.15                             # the spot leg is held
    assert any("spot benchmark from coinbase" in n for n in rep["checks"]["notes"])
    # refusals: wrong hash, a spot strategy, and the spot CLI given a perp strategy
    assert cli.main(["--strategy", str(d), "--sha256", "0" * 64, "--data-dir", str(tmp_path), "--out", str(out)]) == 2
    assert "sha256" in capsys.readouterr().err
    assert cli.main(["--strategy", str(ROOT / "strategies" / "ma_trend" / "1"), "--data-dir", str(tmp_path),
                     "--out", str(out)]) == 2
    assert "spq.backtest" in capsys.readouterr().err
    assert spot_cli.main(["--strategy", str(d), "--data-dir", str(tmp_path), "--out", str(out)]) == 2
    assert "spq.perp_backtest" in capsys.readouterr().err


def test_perp_pipeline_shares_bars_and_counts_all_trials(tmp_path, capsys):
    store(tmp_path, n=800)
    for name, universe, gross in (("a_perp", ("BTC", "ETH"), 1.0), ("b_perp", ("BTC", "BTC.SPOT"), 0.5)):
        write_strategy(tmp_path / "strategies" / name / "1", BODY,
                       meta=perp_meta(universe, lookback=40, max_leverage=2.0, max_gross=2.0, params={"gross": gross},
                                      name=name))
    write_strategy(tmp_path / "strategies" / "spot_one" / "1", "return {s: 0.5 for s in data}\n",
                   meta={"name": "spot_one", "version": "1", "universe": ["BTC", "ETH"], "interval": "1h",
                         "lookback": 10, "params": {}})
    out = tmp_path / "results"
    code = pipeline.main(["--strategies", str(tmp_path / "strategies"), "--data-dir", str(tmp_path), "--out", str(out),
                          "--resamples", "50", "--workers", "1", "--decision-every", "b_perp=6"])
    md = capsys.readouterr().out
    assert code == 0
    reports = {p.stem: json.loads(p.read_text()) for p in out.glob("*-1.json")}
    assert set(reports) == {"a_perp-1", "b_perp-1"}                       # the spot strategy is not run here
    for rep in reports.values():
        validate_report_v2(rep)
        assert rep["robustness"]["trials_tested"] == 6                    # 3 + 3 configurations, counted together
        assert rep["robustness"]["deflated_sharpe_detail"]["scope"].startswith("all perp strategies")
    assert reports["a_perp-1"]["splits"] == reports["b_perp-1"]["splits"]                # same bars, same dates
    assert reports["b_perp-1"]["config"]["decision_every"] == 6
    summary = json.loads((out / "summary.json").read_text())
    names = [r["strategy"] for r in summary["rows"]]
    assert names == ["a_perp/1", "b_perp/1", "benchmark: perp long 1x incl. funding", "benchmark: buy and hold spot"]
    assert summary["benchmarks"]["symbols"] == ["BTC", "ETH"] and summary["benchmarks"]["buy_and_hold_is_spot"] is True
    assert "## Test split" in md and "Liquidations" in md and (out / "summary.md").read_text().strip() == md.strip()
    assert len((out / "trials.jsonl").read_text().splitlines()) == 8      # 6 trials + 2 test evaluations
