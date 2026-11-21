# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/src/spq/job.py
# Description      : Laboratory commands of a research job (v7): the ONLY
#                    evaluation entry points a job needs.
# Module           : spq
# Repository       : https://git.spboucher.ai/sp-wallet
# Project Website  : https://wallet.spboucher.ai
# Created          : 2026-11-11
# Last Modified    : 2026-11-11
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

"""Laboratory commands of a research job (v7): the ONLY evaluation entry points a job needs.

    python -m spq.job info                                   what the job is and which data it has
    python -m spq.job trial --strategy <dir> [--params JSON] one configuration on train + validation (a counted trial)
    python -m spq.job evaluate --strategy <dir> --out r.json [--claims c.json]
                                                             the standard report on the job's data: selection analyses,
                                                             then THE look at the inner test split (sealed per job)
    python -m spq.job split --data-dir D ...                 (server side) where the test split starts on a data set

The job is described by a JSON file (`--job`, default $SPQ_JOB_FILE):
    {"kind": "spot"|"perp", "symbols": [...], "interval": "1h", "capital_usd": 1000, "data_dir": "...",
     "source": "coinbase"}            # source: spot candle source (spot jobs); perp jobs read the hyperliquid store

Hygiene, enforced here and not left to the caller:
- `trial` goes through Experiment.trial(): only train + validation bars, recorded in the job ledger ($SPQ_JOB_LEDGER).
- `evaluate` is the only command that reaches the inner test split, through Experiment.final_test(). The seal is kept
  ACROSS processes with the job ledger: once a test evaluation is recorded for one strategy.py hash, `evaluate` refuses
  any other hash (TestSplitError). Running it again on the same hash is allowed and is counted again.
- `evaluate` writes the claims file itself, from the report it just computed.

What this cannot do: the job ledger is a file the job's own processes can write. The runner copies it out of reach
as it grows and reports any truncation, and the wallet's server re-runs everything on data the job never had.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .research import JOB_LEDGER_ENV, TestSplitError, read_ledger
from .strategy import StrategyError, load_strategy, sha256_file

JOB_FILE_ENV = "SPQ_JOB_FILE"
CLAIM_KEYS = ("total_return", "sharpe", "max_drawdown", "trades")
#: resampling draws of the standard job evaluation (the metrics of the splits do not depend on it)
JOB_RESAMPLES = 300
JOB_FOLDS = 3


def load_job(path=None) -> dict:
    path = path or os.environ.get(JOB_FILE_ENV)
    if not path:
        raise ValueError(f"no job file: pass --job or set {JOB_FILE_ENV}")
    job = json.loads(Path(path).read_text())
    if job.get("kind") not in ("spot", "perp"):
        raise ValueError("job file: kind must be spot or perp")
    syms = job.get("symbols")
    if not isinstance(syms, list) or not syms or not all(isinstance(s, str) for s in syms):
        raise ValueError("job file: symbols must be a non-empty list")
    for k in ("interval", "data_dir"):
        if not isinstance(job.get(k), str) or not job[k]:
            raise ValueError(f"job file: {k} is required")
    job.setdefault("capital_usd", 1000.0)
    return job


def backtest_argv(job: dict, strategy_dir: str, out: str, *, sha256: str | None = None, ledger: str | None = None,
                  job_ledger: str | None = None, resamples: int = JOB_RESAMPLES, folds: int = JOB_FOLDS) -> list[str]:
    """Arguments of spq.backtest / spq.perp_backtest for the standard evaluation of a job (same on both sides)."""
    argv = ["--strategy", str(strategy_dir), "--symbols", ",".join(job["symbols"]), "--interval", job["interval"],
            "--data-dir", job["data_dir"], "--initial-cash", str(float(job["capital_usd"])), "--out", str(out),
            "--resamples", str(resamples), "--folds", str(folds)]
    if job["kind"] == "spot" and job.get("source"):
        argv += ["--source", job["source"]]
    if sha256:
        argv += ["--sha256", sha256]
    if ledger:
        argv += ["--ledger", str(ledger)]
    if job_ledger:
        argv += ["--job-ledger", str(job_ledger)]
    return argv


def _experiment(job: dict):
    """(experiment, compute_metrics) on the job's data — spot or perp."""
    if job["kind"] == "perp":
        from .data.hyperliquid import load_meta, load_perp_universe
        from .perp_backtest import make_config, parser
        from .perp_metrics import compute_perp_metrics
        from .perp_research import PerpExperiment

        a = parser().parse_args(["--strategy", ".", "--data-dir", job["data_dir"], "--out", "-",
                                 "--initial-cash", str(float(job["capital_usd"]))])
        config = make_config(a, job["interval"], load_meta(job["data_dir"]), job["symbols"])
        data, _q, _fq, _raw = load_perp_universe(job["symbols"], job["interval"], None, None, root=job["data_dir"])
        return PerpExperiment(data, config), compute_perp_metrics
    from .backtest import parser as spot_parser
    from .data import load_universe
    from .engine import BacktestConfig
    from .metrics import compute_metrics
    from .research import Experiment

    # the defaults of the spq.backtest command line (costs, rebalance threshold), so a trial and the report agree
    a = spot_parser().parse_args(["--strategy", ".", "--out", "-", "--initial-cash", str(float(job["capital_usd"]))])
    data, _q = load_universe(job["symbols"], job["interval"], None, None, source=job.get("source"),
                             root=job["data_dir"])
    config = BacktestConfig(interval=job["interval"], fee_bps=a.fee_bps, slippage_bps=a.slippage_bps,
                            initial_cash=a.initial_cash, min_order=a.min_order,
                            rebalance_threshold=a.rebalance_threshold, decision_every=a.decision_every)
    return Experiment(data, config), compute_metrics


def _check_kind(strategy, job: dict):
    if strategy.kind != job["kind"]:
        raise StrategyError(f"this is a {strategy.kind} strategy; the job is a {job['kind']} job")


def cmd_info(job: dict, _a) -> int:
    exp, _ = _experiment(job)
    s = exp.splits
    print(json.dumps({"kind": job["kind"], "symbols": job["symbols"], "interval": job["interval"],
                      "capital_usd": job["capital_usd"],
                      "bars": int(len(next(iter(exp.lookahead_data().values())))),
                      "splits": s.to_report(),
                      "note": "these are the splits of the data this job was given; the wallet's server holds a "
                              "later period that no job command can reach"}))
    return 0


def cmd_trial(job: dict, a) -> int:
    strategy = load_strategy(a.strategy)
    _check_kind(strategy, job)
    exp, metrics = _experiment(job)
    params = {**strategy.params, **json.loads(a.params)} if a.params else None
    exp.trial(strategy, params)
    out = {"strategy_sha256": strategy.sha256, "params": params or strategy.params}
    for split in ("train", "validation"):
        m = metrics(exp.run(strategy, split, params))
        out[split] = {k: m.get(k) for k in CLAIM_KEYS}
    print(json.dumps(out))
    return 0


def sealed_hash(ledger_path) -> str | None:
    """The strategy.py hash the job's inner test split was already evaluated for (None: not looked at yet)."""
    for rec in read_ledger(ledger_path) if ledger_path and Path(ledger_path).exists() else []:
        if isinstance(rec, dict) and rec.get("kind") == "test" and isinstance(rec.get("sha256"), str):
            return rec["sha256"]
    return None


def claims_from_report(report: dict, trials: int | None) -> dict:
    m = report.get("metrics", {})
    out = {name: {k: m.get(split, {}).get(k) for k in CLAIM_KEYS}
           for name, split in (("train", "train"), ("validation", "validation"), ("inner_test", "test"))}
    if trials is not None:
        out["trials"] = trials
    out["summary"] = ""
    return out


def cmd_evaluate(job: dict, a) -> int:
    digest = sha256_file(Path(a.strategy) / "strategy.py")
    ledger = os.environ.get(JOB_LEDGER_ENV)
    try:
        seal = sealed_hash(ledger)
    except ValueError:
        seal = None  # an unreadable ledger seals nothing here; the runner's copy still counts every line
    if seal is not None and seal != digest:
        raise TestSplitError(
            f"the inner test split of this job was already evaluated for strategy.py {seal[:12]}...: a second look "
            "with another version is parameter selection on the test split. Submit the version that was evaluated.")
    if job["kind"] == "perp":
        from .perp_backtest import main as run
    else:
        from .backtest import main as run
    code = run(backtest_argv(job, a.strategy, a.out, sha256=digest))
    if code != 0:
        return code
    if a.claims:
        report = json.loads(Path(a.out).read_text())
        n = None
        if ledger and Path(ledger).exists():
            n = sum(1 for line in Path(ledger).read_text(errors="replace").splitlines() if line.strip())
        Path(a.claims).write_text(json.dumps(claims_from_report(report, n), indent=1) + "\n")
    return 0


def cmd_split(_job, a) -> int:
    """Server side: the boundaries the laboratory itself would use on this data set (default 0.6 / 0.2 / 0.2)."""
    job = {"kind": a.kind, "symbols": [s for s in a.symbols.split(",") if s], "interval": a.interval,
           "data_dir": a.data_dir, "source": a.source, "capital_usd": 1000.0}
    exp, _ = _experiment(job)
    s = exp.splits
    dev = len(next(iter(exp.dev_data().values())))
    full = len(next(iter(exp.lookahead_data().values())))
    print(json.dumps({"start": s.train[0].isoformat(), "test_start": s.test[0].isoformat(),
                      "last": s.last["test"].isoformat(), "end": s.test[1].isoformat(),
                      "bars": int(full), "dev_bars": int(dev), "test_bars": int(full - dev)}))
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m spq.job", description=__doc__.split("\n")[0])
    p.add_argument("--job", default=None, help=f"job file (default: ${JOB_FILE_ENV})")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("info")
    t = sub.add_parser("trial")
    t.add_argument("--strategy", required=True)
    t.add_argument("--params", default=None, help="JSON object merged over META['params'] for this trial")
    e = sub.add_parser("evaluate")
    e.add_argument("--strategy", required=True)
    e.add_argument("--out", required=True)
    e.add_argument("--claims", default=None, help="also write the claims file derived from the report")
    s = sub.add_parser("split")
    s.add_argument("--kind", choices=("spot", "perp"), required=True)
    s.add_argument("--symbols", required=True)
    s.add_argument("--interval", required=True)
    s.add_argument("--data-dir", required=True)
    s.add_argument("--source", default=None)
    a = p.parse_args(argv)
    try:
        job = None if a.cmd == "split" else load_job(a.job)
        return {"info": cmd_info, "trial": cmd_trial, "evaluate": cmd_evaluate, "split": cmd_split}[a.cmd](job, a)
    except TestSplitError as e:
        print(f"spq.job: TestSplitError: {e}", file=sys.stderr)
        return 7
    except Exception as e:  # noqa: BLE001 - one line on stderr, non-zero exit
        print(f"spq.job: {type(e).__name__}: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
