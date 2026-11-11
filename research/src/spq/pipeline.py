"""Run the full research pipeline on every strategy version found under a directory.

    uv run python -m spq.pipeline --strategies strategies --symbols ETH,BTC,LINK,SOL --interval 1h \
        --start 2024-11-10 --end 2026-11-10 --data-dir data --out results/2026-11-10 \
        --rebalance-threshold 0.05 --min-order 5 --decision-every garch_regime=24

For each strategy: one report (<out>/<name>-<version>.json). All the trials of all the strategies are merged
in <out>/trials.jsonl and the deflated Sharpe ratio of every report is then recomputed with that total number of
trials: choosing among eight strategies is itself a selection, so each one is deflated by everything that was tried.
A summary table is written to <out>/summary.md and <out>/summary.json.
"""
from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from .data import cross_source_deviation, load_universe
from .dsr import deflated_sharpe_from_returns
from .engine import BacktestConfig
from .report import _unique_trials, build_report, test_returns_from_report, write_report
from .research import read_ledger
from .strategy import load_strategy


def find_strategies(root) -> list[Path]:
    return sorted(p.parent for p in Path(root).glob("*/*/strategy.py"))


def _one(job: dict) -> dict:
    strategy = load_strategy(job["dir"])
    data, quality = load_universe(job["symbols"], job["interval"], job["start"], job["end"], root=job["data_dir"],
                                  source=job["source"])
    config = BacktestConfig(interval=job["interval"], fee_bps=job["fee_bps"], slippage_bps=job["slippage_bps"],
                            initial_cash=job["initial_cash"], min_order=job["min_order"],
                            rebalance_threshold=job["rebalance_threshold"],
                            decision_every=job["decision_every"].get(strategy.name, 1))
    report, _ = build_report(strategy, data, config, quality=quality, ledger=job["ledger"], source=job["source"],
                             notes=job["notes"], n_resamples=job["resamples"], seed=job["seed"])
    return report


def _fmt(x, pct=False, nd=2):
    if x is None:
        return "n/a"
    return f"{100 * x:+.1f} %" if pct else f"{x:.{nd}f}"


def summary_rows(reports: list[dict]) -> list[dict]:
    rows = []
    for rep in reports:
        m, rob = rep["metrics"]["test"], rep["robustness"]
        rows.append({
            "strategy": f"{rep['strategy']['name']}/{rep['strategy']['version']}", "sha256": rep["strategy_sha256"],
            **{k: m[k] for k in ("total_return", "cagr", "volatility", "sharpe", "sortino", "max_drawdown", "calmar",
                                 "turnover", "trades", "win_rate", "profit_factor", "fees_paid", "slippage_paid",
                                 "exposure")},
            "sharpe_ci": rob["bootstrap_sharpe_ci"], "own_trials": rob["deflated_sharpe_detail"].get("own_trials"),
            "trials_tested": rob["trials_tested"], "deflated_sharpe": rob["deflated_sharpe"],
            "validation_sharpe": rep["metrics"]["validation"]["sharpe"],
            "train_sharpe": rep["metrics"]["train"]["sharpe"],
            "lookahead": rep["checks"]["lookahead"], "data_quality": rep["checks"]["data_quality"],
        })
    bench = reports[0]["benchmarks"]
    for name in ("buy_and_hold", "equal_weight"):
        b = bench[name]
        rows.append({"strategy": f"benchmark: {name}", **{k: b[k] for k in (
            "total_return", "cagr", "volatility", "sharpe", "sortino", "max_drawdown", "calmar", "turnover", "trades",
            "win_rate", "profit_factor", "fees_paid", "slippage_paid", "exposure")},
            "sharpe_ci": reports[0]["robustness"]["bootstrap"]["buy_and_hold_sharpe_ci"] if name == "buy_and_hold"
            else None})
    return rows


def summary_markdown(rows: list[dict], reports: list[dict]) -> str:
    c = reports[0]["config"]
    s = reports[0]["splits"]
    out = [
        f"# Library strategies on {', '.join(c['symbols'])} at {c['interval']} ({c['source']})",
        "",
        f"Data {c['start']} to {c['end']} ({c['bars']} common closed bars). Train {s['train'][0][:10]} to "
        f"{s['train'][1][:10]}, validation {s['validation'][0][:10]} to {s['validation'][1][:10]}, "
        f"**test {s['test'][0][:10]} to {s['test'][1][:10]}**.",
        f"Costs: fee {c['fee_bps']} bps + slippage {c['slippage_bps']} bps on traded notional; initial cash "
        f"{c['initial_cash']} USD; minimum order {c['min_order']} USD; rebalance threshold {c['rebalance_threshold']}.",
        "Parameters are the defaults written in each META before any backtest; nothing was selected on the test split.",
        "",
        "Test split:",
        "",
        "| Strategy | Return | CAGR | Vol | Sharpe | Sharpe 95 % CI | Sortino | Max DD | Calmar | Turnover | Trades | "
        "Win rate | Profit factor | Fees + slippage (USD) | Exposure | Trials | Deflated Sharpe |",
        "|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for r in rows:
        ci = r.get("sharpe_ci")
        ci_s = f"[{_fmt(ci[0])}, {_fmt(ci[1])}]" if ci and ci[0] is not None else "n/a"
        costs = (r["fees_paid"] or 0) + (r["slippage_paid"] or 0)
        out.append(
            f"| {r['strategy']} | {_fmt(r['total_return'], True)} | {_fmt(r['cagr'], True)} | "
            f"{_fmt(r['volatility'], True)} | {_fmt(r['sharpe'])} | {ci_s} | {_fmt(r['sortino'])} | "
            f"{_fmt(-r['max_drawdown'] if r['max_drawdown'] is not None else None, True)} | {_fmt(r['calmar'])} | "
            f"{_fmt(r['turnover'], nd=1)} | {r['trades']} | {_fmt(r['win_rate'])} | {_fmt(r['profit_factor'])} | "
            f"{costs:.2f} | {_fmt(r['exposure'])} | {r.get('trials_tested', '')} | "
            f"{_fmt(r.get('deflated_sharpe'), nd=3) if 'deflated_sharpe' in r else ''} |")
    out += [
        "",
        "Return, CAGR, Vol and Max DD in percent; Sharpe and Sortino annualised (8 760 bars per year, risk-free 0); "
        "turnover = traded notional / average equity over the split; win rate and profit factor on closed lots.",
        "Trials = distinct (strategy, parameters) configurations run on train + validation across the whole library; "
        "the deflated Sharpe ratio (Bailey & López de Prado 2014) is the probability that the true Sharpe ratio is "
        "positive given that many trials. Below 0.95, 'no skill' is not rejected.",
        "",
    ]
    return "\n".join(out)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m spq.pipeline", description=__doc__.split("\n")[0])
    p.add_argument("--strategies", default="strategies")
    p.add_argument("--symbols", required=True)
    p.add_argument("--interval", default="1h")
    p.add_argument("--start", default=None)
    p.add_argument("--end", default=None)
    p.add_argument("--data-dir", required=True)
    p.add_argument("--source", default="coinbase")
    p.add_argument("--cross-source", default="kraken", help="second source for a deviation note, if files exist")
    p.add_argument("--fee-bps", type=float, default=10.0)
    p.add_argument("--slippage-bps", type=float, default=10.0)
    p.add_argument("--initial-cash", type=float, default=1000.0)
    p.add_argument("--min-order", type=float, default=0.0)
    p.add_argument("--rebalance-threshold", type=float, default=0.0)
    p.add_argument("--decision-every", action="append", default=[], metavar="NAME=N")
    p.add_argument("--resamples", type=int, default=2000)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--out", required=True)
    a = p.parse_args(argv)

    out = Path(a.out)
    (out / "ledger").mkdir(parents=True, exist_ok=True)
    symbols = [s.strip().upper() for s in a.symbols.split(",") if s.strip()]
    notes = []
    for s in symbols:
        dev = cross_source_deviation(a.data_dir, s, a.interval, a.source, a.cross_source)
        if dev:
            notes.append(f"{s}: close vs {a.cross_source} on {dev['bars']} common bars: median |diff| "
                         f"{dev['median_abs_rel_diff']:.5f}, max {dev['max_abs_rel_diff']:.5f} (relative)")
    every = {k: int(v) for k, v in (x.split("=") for x in a.decision_every)}
    dirs = [d for d in find_strategies(a.strategies) if load_strategy(d).kind == "spot"]  # perps: spq.perp_pipeline
    jobs = []
    for d in dirs:
        name = d.parent.name
        ledger = out / "ledger" / f"{name}-{d.name}.jsonl"
        ledger.unlink(missing_ok=True)
        jobs.append({"dir": str(d), "symbols": symbols, "interval": a.interval, "start": a.start, "end": a.end,
                     "data_dir": a.data_dir, "source": a.source, "fee_bps": a.fee_bps, "slippage_bps": a.slippage_bps,
                     "initial_cash": a.initial_cash, "min_order": a.min_order,
                     "rebalance_threshold": a.rebalance_threshold, "decision_every": every, "ledger": str(ledger),
                     "notes": notes, "resamples": a.resamples, "seed": a.seed})
    with ProcessPoolExecutor(max_workers=a.workers) as pool:
        reports = list(pool.map(_one, jobs))

    records = [r for j in jobs for r in read_ledger(j["ledger"])]
    (out / "trials.jsonl").write_text("".join(json.dumps(r) + "\n" for r in records))
    trials = _unique_trials(records, a.interval)
    sharpes = [t.get("validation_sharpe_per_bar") for t in trials]
    for rep in reports:
        own = rep["robustness"]["deflated_sharpe_detail"]
        dsr = deflated_sharpe_from_returns(test_returns_from_report(rep), sharpes)
        dsr.update({"n_trials": len(trials), "sharpe_split": "test", "trial_sharpes_split": "validation",
                    "scope": "all strategies and parameter sets of this pipeline run",
                    "own_trials": own["n_trials"], "own_deflated_sharpe": own["deflated_sharpe"]})
        rep["robustness"].update({"trials_tested": len(trials), "deflated_sharpe": dsr["deflated_sharpe"],
                                  "deflated_sharpe_detail": dsr})
        write_report(rep, out / f"{rep['strategy']['name']}-{rep['strategy']['version']}.json")
    rows = summary_rows(reports)
    (out / "summary.json").write_text(json.dumps(rows, indent=1) + "\n")
    md = summary_markdown(rows, reports)
    (out / "summary.md").write_text(md)
    print(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
