# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/src/spq/perp_report.py
# Description      : Backtest report, schema version 2 (perpetual futures):
#                    schema/backtest-report-v2.schema.json.
# Module           : spq
# Repository       : https://git.spboucher.ai/sp-wallet
# Project Website  : https://wallet.spboucher.ai
# Created          : 2026-11-10
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

"""Backtest report, schema version 2 (perpetual futures): schema/backtest-report-v2.schema.json.

Every key of the version-1 report is present with the same meaning, so a consumer written for version 1 keeps
working; version 2 adds the perp metrics, the benchmark `perp_long_1x`, the exact ledger, the liquidation log, the
funding summary and two checks (`ledger`, `funding_alignment`). How to read it: docs/v4/quant-perps.md.

A report states what was measured, on which data, with which costs. It never says a strategy is profitable.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .data.core import Quality, bars_per_year, interval_seconds
from .data.hyperliquid import FundingQuality, check_funding_alignment
from .dsr import deflate_for_job, deflated_sharpe_from_returns
from .metrics import compute_metrics, equity_points
from .perp_engine import PerpConfig, PerpResult, run_perp_backtest
from .perp_metrics import compute_perp_metrics, ledger_report, perp_lot_pnls
from .perp_research import PerpExperiment, funding_stress
from .report import _unique_trials
from .research import one_at_a_time_grid, read_job_trials, read_ledger
from .robustness import (bootstrap_sharpe_ci, lookahead_check, monte_carlo, parameter_sensitivity, stress_windows,
                         walk_forward)
from .strategy import Strategy, is_spot_leg

SCHEMA_V2_PATH = Path(__file__).resolve().parents[2] / "schema" / "backtest-report-v2.schema.json"
SCHEMA_VERSION = 2

MODEL_NOTES = [
    "cross-margin account in USDC; weights are signed fractions of account equity (negative = short)",
    "decision on the closed bar, fill at the next bar's open; taker fee on traded notional and slippage in bps",
    "funding: every hourly settlement is charged at the open of the bar that starts at its hour, on the position "
    "held coming into that bar: amount = -signed size x perpetual open x rate (Hyperliquid pays on the ORACLE "
    "price; historical oracle prices are not served, the perpetual's own price is used instead)",
    "initial margin = notional / leverage, checked at order time: reducing orders always execute, orders adding "
    "exposure are cut pro rata to the free collateral or refused below the minimum order",
    "maintenance margin = notional x flat fraction (Hyperliquid: half of the initial margin at maximum leverage); "
    "NO margin tiers by size",
    "liquidation is intrabar: with every long at the bar's low and every short at its high together, the account "
    "is liquidated where margin equity = maintenance margin, at that price, plus taker fee and a penalty; the WHOLE "
    "account is closed (no partial liquidation, no backstop, no auto-deleveraging)",
    "highs and lows are trade prices of the perpetual, not the venue's mark price (which is smoother): wicks "
    "liquidate here that might not on the venue",
    "equity <= 0 marks the run wiped out: equity stays at 0, the unpaid loss is reported as bad debt",
    "ledger in exact decimals; average entry price rounded half-even at 18 decimals, sizes truncated to the lot",
]


def load_schema_v2(path=None) -> dict:
    return json.loads(Path(path or SCHEMA_V2_PATH).read_text())


def validate_report_v2(report: dict, schema: dict | None = None) -> None:
    import jsonschema

    jsonschema.Draft202012Validator(schema or load_schema_v2()).validate(report)


def funding_summary(data: dict, start, end, interval: str) -> dict:
    """Per perpetual, on [start, end): what funding looked like (rates per bar; annualised with the bar count)."""
    N = bars_per_year(interval)
    out = {}
    for s, df in data.items():
        if is_spot_leg(s) or "funding" not in df.columns:
            continue
        f = df["funding"][(df.index >= start) & (df.index < end)]
        v = f.dropna().to_numpy()
        if len(v) == 0:
            out[s] = {"bars": int(len(f)), "bars_with_funding": 0}
            continue
        out[s] = {"bars": int(len(f)), "bars_with_funding": int(len(v)), "mean_rate_per_bar": float(v.mean()),
                  "mean_rate_annualised": float(v.mean() * N), "min_rate": float(v.min()), "max_rate": float(v.max()),
                  "positive_fraction": float((v > 0).mean()), "sum_of_rates": float(v.sum())}
        if "premium" in df.columns:
            p = df["premium"][(df.index >= start) & (df.index < end)].dropna().abs()
            out[s]["median_abs_premium"] = float(p.median()) if len(p) else None
    return out


def _liquidation_log(res: PerpResult) -> list[dict]:
    return [{"ts": e["ts"].isoformat(), "reason": e["reason"], "positions": e["positions"],
             "margin_equity_before": e["margin_equity_before"], "equity_after": e["equity_after"]}
            for e in res.liquidations]


def build_perp_report(
    strategy: Strategy,
    data: dict,
    config: PerpConfig,
    *,
    quality: dict[str, Quality] | None = None,
    funding_quality: dict[str, FundingQuality] | None = None,
    funding_raw: dict | None = None,
    spot_data: dict | None = None,
    fractions=(0.6, 0.2, 0.2),
    grid: list[dict] | None = None,
    ledger=None,
    job_ledger=None,
    n_folds: int = 4,
    n_resamples: int = 2000,
    seed: int = 0,
    source: str | None = None,
    notes: list[str] | None = None,
    extra: dict | None = None,
    funding_intervals: dict | None = None,
    generated_at: str | None = None,
    validate: bool = True,
    capture: dict | None = None,
) -> tuple[dict, PerpExperiment]:
    """Full pipeline for ONE perp strategy version with the parameters of its META (same order as build_report:
    selection analyses on train + validation, then the single look at the test split, then benchmarks and checks)."""
    if strategy.kind != "perp":
        raise ValueError(f"strategy {strategy.name!r} is not a perp strategy (META['kind'] = 'perp')")
    notes = list(notes or [])
    exp = PerpExperiment(data, config, fractions=fractions, ledger=ledger, spot_data=spot_data)
    symbols = exp.symbols
    if sorted(symbols) != sorted(strategy.universe):
        notes.append(f"symbols {symbols} differ from META['universe'] {strategy.universe}")
    if config.interval != strategy.meta["interval"]:
        notes.append(f"interval {config.interval} differs from META['interval'] {strategy.meta['interval']}")

    # 1. development range only -------------------------------------------------------------------------------
    grid = grid if grid is not None else one_at_a_time_grid(strategy.params)
    if strategy.params not in grid:
        grid = [strategy.params, *grid]
    sensitivity = parameter_sensitivity(exp, strategy, grid)
    folds = walk_forward(exp, strategy, grid, n_folds=n_folds)
    runs = {s: exp.run(strategy, s) for s in ("train", "validation")}

    # 2. the single look at the test split --------------------------------------------------------------------
    test = exp.final_test(strategy)
    runs["test"] = test
    metrics = {s: compute_perp_metrics(res) for s, res in runs.items()}
    r = test.returns.to_numpy()

    # 3. benchmarks, resampling, checks -----------------------------------------------------------------------
    bench = exp.benchmarks("test")
    benchmarks = {name: (compute_perp_metrics(res) if isinstance(res, PerpResult) else compute_metrics(res))
                  for name, res in bench.items()}
    split_benchmarks = {}
    for split in ("train", "validation"):
        b = exp.benchmarks(split)
        split_benchmarks[split] = {name: {k: m[k] for k in ("total_return", "sharpe", "max_drawdown")}
                                   for name, m in ((n_, compute_perp_metrics(x) if isinstance(x, PerpResult)
                                                    else compute_metrics(x)) for n_, x in b.items())
                                   if name in ("perp_long_1x", "buy_and_hold")}
    boot = bootstrap_sharpe_ci(r, config.interval, n_samples=n_resamples, seed=seed)
    bh_boot = bootstrap_sharpe_ci(bench["buy_and_hold"].returns.to_numpy(), config.interval,
                                  n_samples=n_resamples, seed=seed)
    perp_boot = bootstrap_sharpe_ci(bench["perp_long_1x"].returns.to_numpy(), config.interval,
                                    n_samples=n_resamples, seed=seed)
    mc = monte_carlo(r, perp_lot_pnls(test), config.initial_cash, n_samples=n_resamples, seed=seed)
    stress = stress_windows(test.equity, bench["perp_long_1x"].equity) if not test.wiped_out else []
    full = exp.lookahead_data()
    t0, t1 = exp.splits.window("test")
    week = max(2, int(7 * 86400 // interval_seconds(config.interval)))
    fstress = funding_stress(test, bench["perp_long_1x"], full, t0, t1, window_bars=week,
                             bars_per_year=bars_per_year(config.interval))

    trials = _unique_trials(read_ledger(ledger), config.interval) if ledger else exp.trials
    dsr = deflated_sharpe_from_returns(r, [t.get("validation_sharpe_per_bar") for t in trials])
    dsr["n_trials"] = max(len(trials), 1)
    if job_ledger:  # v7: a research job's trials count against this strategy (see spq.dsr.deflate_for_job)
        dsr = deflate_for_job(dsr, r, [t.get("validation_sharpe_per_bar") for t in trials],
                              read_job_trials(job_ledger))
    dsr["sharpe_split"], dsr["trial_sharpes_split"] = "test", "validation"
    test_looks = (len([t for t in read_ledger(ledger) if t.get("kind") == "test" and t["strategy"] == strategy.name])
                  if ledger else len(exp.test_evaluations))

    look = lookahead_check(strategy, full, config, start=t0, runner=run_perp_backtest)
    ledger_ok = all(res.ledger["reconciles"] for res in runs.values()) and all(
        res.ledger["reconciles"] for res in bench.values() if isinstance(res, PerpResult))
    align = (check_funding_alignment(full, funding_raw, funding_intervals) if funding_raw
             else {"status": "fail", "detail": "no funding settlement series was supplied"})
    quality = quality or {}
    funding_quality = funding_quality or {}
    dq_ok = bool(quality) and all(q.ok() for q in quality.values()) and all(q.ok() for q in funding_quality.values())
    if not quality:
        notes.append("no data-quality record was supplied: data_quality is reported as fail")
    for s, q in quality.items():
        if q.missing_bars or q.duplicates_dropped or q.ohlc_violations or q.off_grid:
            notes.append(f"{s}: {q.missing_bars} missing bars (longest gap {q.max_gap_bars}), "
                         f"{q.duplicates_dropped} duplicates dropped, {q.ohlc_violations} OHLC violations, "
                         f"{q.off_grid} off-grid timestamps; missing bars are not filled")
    for s, q in funding_quality.items():
        if q.missing or q.off_grid or q.duplicates_dropped or q.non_finite:
            notes.append(f"{s} funding: {q.missing} missing settlements (longest gap {q.max_gap}), {q.off_grid} "
                         f"off-grid, {q.duplicates_dropped} duplicates dropped; missing settlements are charged as 0")
    if not getattr(exp, "buy_and_hold_is_spot", False):
        notes.append("no spot candles were supplied: benchmarks.buy_and_hold is the perpetual's own price held "
                     "at 1x WITHOUT funding, not a spot position")
    if align["status"] != "pass":
        notes.append(f"funding alignment: {json.dumps(align['detail'], default=str)[:400]}")
    index = next(iter(full.values())).index
    notes += [
        "equity_curve is the test split, valued at the close of each bar (timestamps are bar-open times, UTC)",
        *MODEL_NOTES,
        "max_drawdown and worst_intrabar_drawdown are positive fractions; sharpe/sortino/volatility are annualised "
        f"with {bars_per_year(config.interval):.0f} bars per year (24/7 market), risk-free rate 0",
        "parameters on the test split are META['params']; the sensitivity grid never selects them",
        f"look-ahead check: {look['detail']}",
    ]
    perps = [s for s in symbols if not is_spot_leg(s)]

    report = {
        "schema_version": SCHEMA_VERSION,
        "kind": "perp",
        "generated_at": generated_at or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "strategy_sha256": strategy.sha256,
        "strategy": {"name": strategy.name, "version": strategy.meta["version"], "meta": strategy.meta},
        "config": {
            "symbols": symbols, "interval": config.interval,
            "start": index[0].isoformat(), "end": index[-1].isoformat(),
            "fee_bps": config.fee_bps, "slippage_bps": config.slippage_bps, "initial_cash": config.initial_cash,
            "min_order": config.min_order, "rebalance_threshold": config.rebalance_threshold,
            "decision_every": config.decision_every, "params": strategy.params, "source": source,
            "bars": int(len(index)), "split_fractions": list(fractions),
            # ------------------------------------------------------------------------------------- perps
            "venue": source, "taker_fee_bps": config.taker_fee_bps, "maker_fee_bps": config.maker_fee_bps,
            "liquidity": config.liquidity,
            "leverage": config.leverage or float(strategy.meta["max_leverage"]),
            "max_leverage": float(strategy.meta["max_leverage"]),
            "max_gross_exposure": float(strategy.meta["max_gross_exposure"]),
            "venue_max_leverage": {s: config.venue_leverage(s) for s in perps},
            "maintenance_fraction": {s: config.maintenance(s) for s in perps},
            "liquidation_penalty_bps": config.liquidation_penalty_bps,
            "size_decimals": {s: int(config.size_decimals.get(s, config.default_size_decimals)) for s in symbols},
            "spot_fee_bps": config.spot_fee_bps, "spot_slippage_bps": config.spot_slippage_bps,
            "funding_reference_price": "index column" if any("index" in full[s].columns for s in perps)
            else "perpetual open at the settlement hour",
        },
        "splits": exp.splits.to_report(),
        "metrics": metrics,
        "benchmarks": benchmarks,
        "robustness": {
            "walk_forward": folds,
            "bootstrap_sharpe_ci": boot["ci"],
            "bootstrap": {**{k: v for k, v in boot.items() if k != "ci"}, "split": "test",
                          "buy_and_hold_sharpe_ci": bh_boot["ci"], "perp_long_1x_sharpe_ci": perp_boot["ci"]},
            "parameter_sensitivity": sensitivity,
            "trials_tested": dsr["n_trials"],
            "deflated_sharpe": dsr["deflated_sharpe"],
            "deflated_sharpe_detail": dsr,
            "monte_carlo": mc,
            "stress_windows": stress,
            "funding_stress_windows": fstress,
            "test_evaluations": int(test_looks),
            "benchmarks_by_split": split_benchmarks,
        },
        "checks": {
            "lookahead": look["status"],
            "data_quality": "pass" if dq_ok else "fail",
            "ledger": "pass" if ledger_ok else "fail",
            "funding_alignment": align["status"],
            "notes": notes,
            "data_quality_detail": {s: q.to_dict() for s, q in quality.items()},
            "funding_quality_detail": {s: q.to_dict() for s, q in funding_quality.items()},
            "funding_alignment_detail": align["detail"],
        },
        "ledger": {s: ledger_report(res) for s, res in runs.items()},
        "liquidations": {s: _liquidation_log(res) for s, res in runs.items()},
        "funding": {s: funding_summary(full if s == "test" else exp.dev_data(), *exp.splits.window(s),
                                       config.interval) for s in ("train", "validation", "test")},
        "equity_curve": equity_points(test.equity),
    }
    if extra:
        report.update(extra)
    if capture is not None:                 # v11: the version-3 builder needs the runs themselves
        capture.update(runs=runs, bench=bench, full=full, lookahead=look)
    if validate:
        validate_report_v2(report)
    return report, exp


def write_perp_report(report: dict, path) -> None:
    validate_report_v2(report)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=1, allow_nan=False) + "\n")


def returns_from_report(report: dict) -> np.ndarray:
    eq = np.array([p[1] for p in report["equity_curve"]], dtype="float64")
    with np.errstate(divide="ignore", invalid="ignore"):
        r = eq[1:] / eq[:-1] - 1.0
    return np.where(np.isfinite(r), r, 0.0)
