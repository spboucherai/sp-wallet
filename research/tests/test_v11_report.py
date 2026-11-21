# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/tests/test_v11_report.py
# Description      : Version-3 report: additive over version 2, itemised gross
#                    -> net, execution model, engine parity, data bias, journal
#                    — and REPRODUCIBLE: the same run twice gives
#                    byte-identical reports.
# Module           : research
# Repository       : https://git.spboucher.ai/sp-wallet
# Project Website  : https://wallet.spboucher.ai
# Created          : 2026-11-15
# Last Modified    : 2026-11-15
#
# =============================================================================
# AUTHOR & PROFESSIONAL AFFILIATION
# =============================================================================
#
# Author           : Simon-Pierre Boucher
# Position         : Professor of Finance
# Institution      : Université du Québec en Outaouais (UQO)
# Department       : Département des sciences administratives
# Organization     : SP Boucher
#
# Website          : https://spboucher.ai
# Git              : https://git.spboucher.ai
#
# =============================================================================
# OFFICIAL CONTACT DIRECTORY
# =============================================================================
#
# General          : info@spboucher.ai
# Professional     : contact@spboucher.ai
# Direct           : simon@spboucher.ai
# Research         : research@spboucher.ai
# Development      : dev@spboucher.ai
# Support          : support@spboucher.ai
# Security/Admin   : admin@spboucher.ai
# Notifications    : notifications@spboucher.ai
#
# Preferred Contact: support@spboucher.ai
#
# =============================================================================
# COPYRIGHT & INTELLECTUAL PROPERTY
# =============================================================================
#
# Copyright (c) 2026
# Simon-Pierre Boucher
#
# All rights reserved where applicable.
#
# This file is governed by the applicable project license,
# copyright notices, institutional agreements and relevant law.
#
# Unless expressly authorized by the applicable license or
# rights holder, copying, redistribution, sublicensing,
# publication and commercial exploitation are not permitted.
#
# Existing third-party rights and notices remain unaffected.
#
# =============================================================================
# CONFIDENTIALITY & SECURITY
# =============================================================================
#
# Classification   : Public
# Distribution     : Public repository; use is governed by the project license
# Security Contact : admin@spboucher.ai
#
# Access to this source does not independently grant permission
# to redistribute or disclose confidential materials.
#
# Do not embed credentials, private keys, access tokens,
# certificates or confidential personal information.
#
# =============================================================================
# LICENSE & MAINTENANCE
# =============================================================================
#
# License          : None specified (no license file in this repository)
# Maintainer       : Simon-Pierre Boucher
# Technical Contact: dev@spboucher.ai
#
# =============================================================================
# END OF SP BOUCHER SOURCE HEADER
# =============================================================================

"""Version-3 report: additive over version 2, itemised gross -> net, execution model, engine parity, data bias,
journal — and REPRODUCIBLE: the same run twice gives byte-identical reports. Versions 1 and 2 keep working."""
from __future__ import annotations

import argparse
import hashlib
import json
import re

import pytest

from conftest import ROOT
from v11_helpers import AS_OF, synthetic_store

from spq import v11_pipeline as vp
from spq.data.multivenue import data_bias, load_multivenue, snapshot_hash
from spq.execution import ExecutionModel
from spq.perp_report import load_schema_v2, validate_report_v2
from spq.report import validate_report
from spq.report_v3 import build_report_v3, code_sha256, validate_report_v3, write_report_v3
from spq.research import read_ledger
from spq.strategy import load_strategy


@pytest.fixture(scope="module")
def store(tmp_path_factory):
    root = tmp_path_factory.mktemp("v11store")
    manifest = synthetic_store(root, n=1700)
    (root / "manifest.json").write_text(json.dumps(manifest))
    return root, manifest


def job(store, rel, tmp, symbols=None, axes=None, seed=0):
    root, manifest = store
    ledger = tmp / f"{rel.replace('/', '-')}.jsonl"
    ledger.unlink(missing_ok=True)
    return {"dir": rel, "symbols": symbols, "axes": axes or {}, "interval": "1h", "start": manifest["range"][0],
            "end": manifest["range"][1], "data_dir": str(root), "as_of": AS_OF, "ledger": str(ledger),
            "manifest_name": "manifest.json", "manifest_sha": manifest["snapshot_sha256"], "seed": seed, "resamples": 200}


@pytest.fixture(scope="module")
def report(store, tmp_path_factory):
    tmp = tmp_path_factory.mktemp("ledgers")
    j = job(store, "strategies/momentum_xs_perp/2", tmp, axes={"momentum_bars": [168]})
    return vp.run_one(j), j


def test_v3_is_additive_over_v2_and_validates(report):
    rep, _ = report
    validate_report_v3(rep)
    assert rep["schema_version"] == 3 and rep["kind"] == "perp" and rep["generated_at"] == AS_OF
    v2 = load_schema_v2()
    assert set(v2["required"]) <= set(rep)                              # every version-2 key is still there
    for split in ("train", "validation", "test"):
        assert set(v2["$defs"]["perp_metrics"]["required"]) <= set(rep["metrics"][split])
    with pytest.raises(Exception):
        validate_report_v2(rep)                                         # ... but a version-3 report says it is one
    assert rep["checks"]["lookahead"] == "pass" and rep["checks"]["ledger"] == "pass"
    assert rep["checks"]["funding_alignment"] == "pass" and rep["checks"]["data_quality"] == "pass"


def test_gross_to_net_is_the_exact_ledger_itemised(report):
    rep, _ = report
    for split in ("train", "validation", "test"):
        g, led = rep["metrics"][split]["gross_to_net"], rep["ledger"][split]
        net = (g["price_pnl"] + g["funding"] - g["trading_fees"] - g["liquidation_penalties"] - g["slippage"]
               - g["latency"] + g["bad_debt_written_off"])
        assert net == pytest.approx(g["net_pnl"], abs=1e-6)
        assert g["net_pnl"] == pytest.approx(float(led["final_equity"]) - float(led["initial"]), abs=1e-9)
        assert float(led["latency"]) == pytest.approx(g["latency"]) and led["reconciles"] is True
        assert g["return_net"] == pytest.approx(g["net_pnl"] / 1000.0)
        if rep["metrics"][split]["trades"]:
            assert g["latency"] > 0 and g["slippage"] > 0 and g["trading_fees"] > 0
            assert g["return_gross"] > g["return_net"] - g["funding"] / 1000.0 - 1e-12   # costs only ever subtract
    assert rep["metrics"]["test"]["sharpe"] == rep["metrics"]["test"]["gross_to_net"]["sharpe_net"]


def test_execution_model_engine_parity_data_bias_and_journal_sections(report, store):
    rep, j = report
    ex = rep["execution_model"]
    assert ex["latency"]["latency_s"] == 60.0 and ex["latency"]["model"] == "adverse_bound"
    assert ex["slippage"]["model"] == "sqrt_impact" and ex["slippage"]["half_spread_bps"]["BTC"] > 0
    hl = ex["fees"]["fee_table"]["hyperliquid"]
    assert (hl["taker_bps"], hl["maker_bps"], hl["funding_interval_s"]) == (4.5, 1.5, 3600) and hl["source"] and hl["checked"]
    assert ex["funding"] == {"hyperliquid": {"interval_s": 3600, "model": "settlement"}}
    par = rep["engine_parity"]
    assert par["applied"] is True and par["file"] == "research/src/spq/params/engine-parity.json"
    assert par["parameters"]["max_leverage"]["value"] == 2
    assert all(re.fullmatch(r"services/api/src/agents/[a-z-]+\.ts:\d+", p["source"]) for p in par["parameters"].values())
    assert set(par["observed"]) == {"train", "validation", "test"} and "stop" in par["observed"]["test"]
    bias = rep["data_bias"]
    assert bias["survivorship"]["universe_fixed_ex_post"] is True
    assert set(bias["per_symbol"]) == {"BTC", "ETH", "SOL"}
    for b in bias["per_symbol"].values():
        assert b["missing_bar_ratio"] == 0.0 and b["stale_price_ratio"] == 0.0 and b["outage_gaps"] == []
    assert bias["listing_date_truncation"]["common_start"].startswith("2026-01-01")
    jr = rep["journal"]
    s = load_strategy(ROOT / j["dir"])
    assert jr["strategy"] == {"name": s.name, "version": "2", "sha256": s.sha256} and rep["strategy_sha256"] == s.sha256
    assert jr["code"]["code_sha256"] == code_sha256() and jr["parameters"] == s.params and jr["seed"] == 0
    data, *_ = load_multivenue(["BTC", "ETH", "SOL"], "1h", j["start"], j["end"], root=store[0], as_of=AS_OF)
    assert jr["data"]["sha256"] == snapshot_hash(data) and jr["data"]["manifest_snapshot_sha256"] == store[1]["snapshot_sha256"]
    assert set(rep["venue_accounts"]["test"]) == {"hyperliquid"}
    sens = rep["robustness"]["execution_sensitivity"]
    assert sens["split"] == "validation" and "latency_300s" in sens["runs"]         # never the test split
    assert any(k.startswith("pre_v11_model") for k in sens["runs"])


def test_running_twice_gives_byte_identical_reports(report, store, tmp_path):
    rep, j = report
    first = json.dumps(rep, indent=1, allow_nan=False)
    again = vp.run_one(job(store, j["dir"], tmp_path, axes=j["axes"]))
    assert json.dumps(again, indent=1, allow_nan=False) == first
    h1, h2 = write_report_v3(rep, tmp_path / "a.json"), write_report_v3(again, tmp_path / "b.json")
    assert h1 == h2 == hashlib.sha256((tmp_path / "a.json").read_bytes()).hexdigest()
    assert (tmp_path / "a.json").read_bytes() == (tmp_path / "b.json").read_bytes()
    assert rep["generated_at"] == AS_OF == rep["journal"]["data"]["captured_at"]    # the data's time, not the clock's
    other = vp.run_one(job(store, j["dir"], tmp_path, axes=j["axes"], seed=1))      # the seed is part of the journal
    assert other["journal"]["seed"] == 1 and json.dumps(other) != json.dumps(rep)


def test_every_run_writes_the_ledger_and_refuses_to_run_without_one(report, store):
    rep, j = report
    recs = read_ledger(j["ledger"])
    trials = [r for r in recs if r["kind"] == "trial"]
    assert len(trials) == 2 and len([r for r in recs if r["kind"] == "test"]) == 1   # META params + one grid cell
    assert rep["robustness"]["trials_tested"] == 2 and rep["robustness"]["test_evaluations"] == 1
    assert rep["robustness"]["deflated_sharpe"] is None or 0.0 <= rep["robustness"]["deflated_sharpe"] <= 1.0
    s = load_strategy(ROOT / j["dir"])
    data, quality, fq, fraw, clock = load_multivenue(["BTC", "ETH", "SOL"], "1h", root=store[0], as_of=AS_OF)
    cfg = vp.make_config(["BTC", "ETH", "SOL"], "1h", store[0])
    common = dict(data_bias=data_bias(["BTC", "ETH", "SOL"], data, quality, clock, "1h"), data_snapshot={"sha256": "0" * 64},
                  generated_at=AS_OF)
    with pytest.raises(ValueError, match="ledger"):
        build_report_v3(s, data, cfg, ledger=None, **common)
    from dataclasses import replace

    with pytest.raises(ValueError, match="ExecutionModel"):
        build_report_v3(s, data, replace(cfg, execution=None), ledger=j["ledger"], **common)
    assert isinstance(cfg.execution, ExecutionModel) and cfg.execution.latency_s > 0


def test_cross_venue_report_has_one_account_per_venue_and_interval_aware_funding(store, tmp_path):
    rep = vp.run_one(job(store, "strategies_xvenue/funding_arb_cross_venue/1", tmp_path))
    validate_report_v3(rep)
    assert rep["config"]["symbols"] == ["BTC", "BTC@EDGEX", "ETH", "ETH@EDGEX", "SOL", "SOL@EDGEX"]
    assert rep["checks"]["funding_alignment"] == "pass" and rep["checks"]["lookahead"] == "pass"
    assert rep["execution_model"]["funding"]["edgex"] == {"interval_s": 14400, "model": "settlement"}
    assert set(rep["execution_model"]["fees"]["fee_table"]) == {"edgex", "hyperliquid"}
    for split in ("train", "validation", "test"):
        acc = rep["venue_accounts"][split]
        assert set(acc) == {"hyperliquid", "edgex"} and acc["edgex"]["symbols"] == ["BTC@EDGEX", "ETH@EDGEX", "SOL@EDGEX"]
        assert 0 <= acc["hyperliquid"]["margin_utilisation_max"] <= 1.0
    g = rep["metrics"]["train"]["gross_to_net"]
    if rep["metrics"]["train"]["trades"]:
        assert rep["venue_accounts"]["train"]["hyperliquid"]["funding_pnl"] + rep["venue_accounts"]["train"]["edgex"]["funding_pnl"] \
            == pytest.approx(g["funding"], abs=1e-9)                    # funding capture, split by venue
    assert rep["data_bias"]["per_symbol"]["BTC@EDGEX"]["venue"] == "edgex"


def test_pipeline_run_and_verify_reproduce_the_committed_hashes(store, tmp_path, monkeypatch):
    root, _ = store
    monkeypatch.setattr(vp, "RUNS", [("strategies/mean_reversion_bands_perp/2", None, {"window": [24]}),
                                     ("strategies/basis_cash_carry/1", None, {})])
    a = argparse.Namespace(data_dir=str(root), manifest=str(root / "manifest.json"), out=str(tmp_path / "out"),
                           resamples=200, seed=0, workers=1)
    reports, extra = vp.run_all(a)
    hashes = vp.write_all(reports, extra, tmp_path / "out")
    assert set(hashes) == {"mean_reversion_bands_perp-2.json", "basis_cash_carry-1.json", "trials.jsonl", "summary.json",
                           "summary.md"}
    assert extra["n_trials"] == 3 and all(r["robustness"]["trials_tested"] == 3 for r in reports)   # one shared count
    (tmp_path / "out" / "manifest.json").write_text(json.dumps({"reports": hashes}))
    assert vp.main(["verify", "--data-dir", str(root), "--manifest", str(root / "manifest.json"), "--out",
                    str(tmp_path / "out"), "--resamples", "200", "--workers", "1"]) == 0
    md = (tmp_path / "out" / "summary.md").read_text()
    assert "Deflated Sharpe" in md and "basis_cash_carry/1" in md and "Gross to net" in md
    carry = next(r for r in reports if r["strategy"]["name"] == "basis_cash_carry")
    assert set(carry["venue_accounts"]["test"]) == {"hyperliquid", "spot"}          # the spot leg has its own cash


def test_perp_backtest_cli_writes_v3_on_request_and_v2_by_default(store, tmp_path, capsys):
    from spq import perp_backtest

    root, _ = store
    base = ["--strategy", str(ROOT / "strategies/momentum_xs_perp/1"), "--symbols", "BTC,ETH,SOL", "--data-dir",
            str(root), "--resamples", "200", "--grid", '{"momentum_bars": [168]}', "--as-of", AS_OF]
    outs = []
    for i in range(2):                                                  # twice, each from an empty ledger
        out = tmp_path / f"r{i}.json"
        assert perp_backtest.main([*base, "--report-version", "3", "--ledger", str(tmp_path / f"l{i}.jsonl"), "--out",
                                   str(out)]) == 0
        outs.append(out.read_bytes())
    assert outs[0] == outs[1]
    rep = json.loads(outs[0])
    validate_report_v3(rep)
    assert rep["schema_version"] == 3 and rep["config"]["symbols"] == ["BTC", "ETH", "SOL"]    # a generic universe
    assert rep["engine_parity"]["applied"] is True and rep["config"]["leverage"] == 2.0
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1])["report_sha256"] == hashlib.sha256(outs[0]).hexdigest()
    assert perp_backtest.main([*base, "--report-version", "3", "--out", str(tmp_path / "x.json")]) == 2     # no ledger
    two = ["--strategy", str(ROOT / "strategies/momentum_xs_perp/2"), "--data-dir", str(root), "--resamples", "200",
           "--grid", '{"momentum_bars": [168]}', "--spot-source", "coinbase", "--out", str(tmp_path / "v2.json")]
    assert perp_backtest.main(two) == 0                                 # the default is still version 2
    v2 = json.loads((tmp_path / "v2.json").read_text())
    validate_report_v2(v2)
    assert v2["schema_version"] == 2 and "engine_parity" not in v2 and "gross_to_net" not in v2["metrics"]["test"]


def test_committed_v1_and_v2_reports_still_validate_with_their_own_readers():
    v1 = json.loads((ROOT / "results/2026-11-10/ma_trend-1.json").read_text())
    v2 = json.loads((ROOT / "results/2026-11-10-perps/pairs_coint_perp-1.json").read_text())
    validate_report(v1)
    validate_report_v2(v2)
    assert v1["schema_version"] == 1 and v2["schema_version"] == 2
    for bad in (v1, v2):
        with pytest.raises(Exception):
            validate_report_v3(bad)
