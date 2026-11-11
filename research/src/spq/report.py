"""Build and validate the JSON backtest report of docs/v3/ARCHITECTURE.md ("Backtest report").

A report states what was measured, on which data, with which costs. It never says a strategy is profitable.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .data.core import Quality, bars_per_year
from .dsr import deflate_for_job, deflated_sharpe_from_returns
from .engine import BacktestConfig
from .metrics import compute_metrics, equity_points, lot_pnls
from .research import Experiment, one_at_a_time_grid, read_job_trials, read_ledger
from .robustness import (bootstrap_sharpe_ci, lookahead_check, monte_carlo, parameter_sensitivity, stress_windows,
                         walk_forward)
from .strategy import Strategy

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "schema" / "backtest-report.schema.json"
SCHEMA_VERSION = 1


def load_schema(path=None) -> dict:
    return json.loads(Path(path or SCHEMA_PATH).read_text())


def validate_report(report: dict, schema: dict | None = None) -> None:
    """Raise jsonschema.ValidationError if the report does not follow the committed schema."""
    import jsonschema

    jsonschema.Draft202012Validator(schema or load_schema()).validate(report)


def _unique_trials(records: list[dict], interval: str) -> list[dict]:
    seen, out = set(), []
    for t in records:
        if t.get("kind") != "trial" or t.get("interval") != interval:
            continue
        key = (t["sha256"], json.dumps(t["params"], sort_keys=True, default=str), tuple(t.get("symbols", [])))
        if key not in seen:
            seen.add(key)
            out.append(t)
    return out


def build_report(
    strategy: Strategy,
    data: dict,
    config: BacktestConfig,
    *,
    quality: dict[str, Quality] | None = None,
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
) -> tuple[dict, Experiment]:
    """Full pipeline for ONE strategy version with the parameters of its META.

    Order matters and is fixed: (1) everything that compares configurations runs on train + validation only,
    (2) the test split is evaluated once with META['params'], (3) benchmarks, resampling and checks.
    The grid is a robustness analysis: it never changes the parameters used on the test split. If the grid shows
    better parameters, write a new strategy version (new hash) and count it as a new trial.
    """
    notes = list(notes or [])
    exp = Experiment(data, config, fractions=fractions, ledger=ledger)
    symbols = exp.symbols
    if not strategy.generic and sorted(symbols) != sorted(strategy.universe):  # v5: a generic universe has no list to differ from
        notes.append(f"symbols {symbols} differ from META['universe'] {strategy.universe}")
    if config.interval != strategy.meta["interval"]:
        notes.append(f"interval {config.interval} differs from META['interval'] {strategy.meta['interval']}")

    # 1. development range only -------------------------------------------------------------------------------
    grid = grid if grid is not None else one_at_a_time_grid(strategy.params)
    if strategy.params not in grid:
        grid = [strategy.params, *grid]
    sensitivity = parameter_sensitivity(exp, strategy, grid)
    folds = walk_forward(exp, strategy, grid, n_folds=n_folds)
    metrics = {s: compute_metrics(exp.run(strategy, s)) for s in ("train", "validation")}

    # 2. the single look at the test split --------------------------------------------------------------------
    test = exp.final_test(strategy)
    metrics["test"] = compute_metrics(test)
    r = test.returns.to_numpy()

    # 3. benchmarks, resampling, checks -----------------------------------------------------------------------
    bench = exp.benchmarks("test")
    benchmarks = {name: compute_metrics(res) for name, res in bench.items()}
    boot = bootstrap_sharpe_ci(r, config.interval, n_samples=n_resamples, seed=seed)
    bench_boot = bootstrap_sharpe_ci(bench["buy_and_hold"].returns.to_numpy(), config.interval,
                                     n_samples=n_resamples, seed=seed)
    mc = monte_carlo(r, lot_pnls(test), config.initial_cash, n_samples=n_resamples, seed=seed)
    stress = stress_windows(test.equity, bench["buy_and_hold"].equity)

    trials = _unique_trials(read_ledger(ledger), config.interval) if ledger else exp.trials
    dsr = deflated_sharpe_from_returns(r, [t.get("validation_sharpe_per_bar") for t in trials])
    dsr["n_trials"] = max(len(trials), 1)
    if job_ledger:  # v7: a research job's trials count against this strategy (see spq.dsr.deflate_for_job)
        dsr = deflate_for_job(dsr, r, [t.get("validation_sharpe_per_bar") for t in trials],
                              read_job_trials(job_ledger))
    dsr["sharpe_split"], dsr["trial_sharpes_split"] = "test", "validation"
    test_looks = (len([t for t in read_ledger(ledger) if t.get("kind") == "test" and t["strategy"] == strategy.name])
                  if ledger else len(exp.test_evaluations))

    full = exp.lookahead_data()
    look = lookahead_check(strategy, full, config, start=exp.splits.test[0])
    quality = quality or {}
    dq_ok = all(q.ok() for q in quality.values()) if quality else False
    if not quality:
        notes.append("no data-quality record was supplied: data_quality is reported as fail")
    for s, q in quality.items():
        if q.missing_bars or q.duplicates_dropped or q.ohlc_violations or q.off_grid:
            notes.append(f"{s}: {q.missing_bars} missing bars (longest gap {q.max_gap_bars}), "
                         f"{q.duplicates_dropped} duplicates dropped, {q.ohlc_violations} OHLC violations, "
                         f"{q.off_grid} off-grid timestamps; missing bars are not filled")
    index = next(iter(full.values())).index
    notes += [
        "equity_curve is the test split, valued at the close of each bar (timestamps are bar-open times, UTC)",
        "decisions use closed bars only; fills at the next bar's open; fee and slippage on traded notional",
        "max_drawdown is a positive fraction; sharpe/sortino/volatility are annualised with "
        f"{bars_per_year(config.interval):.0f} bars per year (24/7 market), risk-free rate 0",
        "parameters on the test split are META['params']; the sensitivity grid never selects them",
        f"look-ahead check: {look['detail']}",
    ]

    report = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "strategy_sha256": strategy.sha256,
        "strategy": {"name": strategy.name, "version": strategy.meta["version"], "meta": strategy.meta},
        "config": {
            "symbols": symbols, "interval": config.interval,
            "start": index[0].isoformat(), "end": index[-1].isoformat(),
            "fee_bps": config.fee_bps, "slippage_bps": config.slippage_bps, "initial_cash": config.initial_cash,
            "min_order": config.min_order, "rebalance_threshold": config.rebalance_threshold,
            "decision_every": config.decision_every, "params": strategy.params, "source": source,
            "bars": int(len(index)), "split_fractions": list(fractions),
        },
        "splits": exp.splits.to_report(),
        "metrics": metrics,
        "benchmarks": benchmarks,
        "robustness": {
            "walk_forward": folds,
            "bootstrap_sharpe_ci": boot["ci"],
            "bootstrap": {**{k: v for k, v in boot.items() if k != "ci"}, "split": "test",
                          "buy_and_hold_sharpe_ci": bench_boot["ci"]},
            "parameter_sensitivity": sensitivity,
            "trials_tested": dsr["n_trials"],
            "deflated_sharpe": dsr["deflated_sharpe"],
            "deflated_sharpe_detail": dsr,
            "monte_carlo": mc,
            "stress_windows": stress,
            "test_evaluations": int(test_looks),
        },
        "checks": {
            "lookahead": look["status"],
            "data_quality": "pass" if dq_ok else "fail",
            "notes": notes,
            "data_quality_detail": {s: q.to_dict() for s, q in quality.items()},
        },
        "equity_curve": equity_points(test.equity),
    }
    if extra:
        report.update(extra)
    validate_report(report)
    return report, exp


def write_report(report: dict, path) -> None:
    validate_report(report)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=1, allow_nan=False) + "\n")


def test_returns_from_report(report: dict) -> np.ndarray:
    eq = np.array([p[1] for p in report["equity_curve"]], dtype="float64")
    return eq[1:] / eq[:-1] - 1.0


test_returns_from_report.__test__ = False
