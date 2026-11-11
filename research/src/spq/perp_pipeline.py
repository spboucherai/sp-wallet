"""Run the research pipeline on every PERP strategy version found under a directory (META['kind'] = 'perp').

    uv run python -m spq.perp_pipeline --strategies strategies --data-dir data --out results/2026-11-10-perps \
        --rebalance-threshold 0.05 --decision-every har_rv_perp=24

Each strategy runs on its own META['universe'], on the timestamps common to EVERY series used by the run (so all
the reports share the same bars and the same train / validation / test dates). One version-2 report per strategy
(<out>/<name>-<version>.json). All the trials of all the strategies are merged in <out>/trials.jsonl and the
deflated Sharpe ratio of every report is recomputed with that total: choosing among several strategies is itself
a selection. <out>/summary.md and summary.json hold the tables, with the benchmarks of the whole universe.
"""
from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from .data.hyperliquid import SOURCE, load_meta, load_perp_universe, load_spot_reference
from .dsr import deflated_sharpe_from_returns
from .metrics import compute_metrics
from .perp_backtest import add_cost_arguments, make_config
from .perp_metrics import compute_perp_metrics
from .perp_report import build_perp_report, returns_from_report, write_perp_report
from .perp_research import PerpExperiment
from .pipeline import _fmt, find_strategies
from .report import _unique_trials
from .research import read_ledger
from .robustness import bootstrap_sharpe_ci
from .strategy import is_spot_leg, load_strategy


def _load(job: dict, symbols: list[str]):
    """Data of `symbols` restricted to the bars common to the whole run."""
    data, quality, fq, raw = load_perp_universe(job["all_symbols"], job["interval"], job["start"], job["end"],
                                                root=job["data_dir"], spot_source=job["spot_source"])
    index = next(iter(data.values())).index
    perps = [s for s in job["all_symbols"] if not is_spot_leg(s)]
    spot, spot_q = load_spot_reference(perps, job["interval"], index, root=job["data_dir"], source=job["spot_source"])
    sub = {s: data[s] for s in symbols}
    keep = [s for s in symbols if not is_spot_leg(s)]
    return (sub, {s: quality[s] for s in symbols}, {s: fq[s] for s in keep}, {s: raw[s] for s in keep},
            {s: spot[s] for s in keep if s in spot}, spot_q)


def _config(job: dict, symbols, decision_every: int = 1):
    return make_config(argparse.Namespace(**job["costs"]), job["interval"], load_meta(job["data_dir"]), symbols,
                       decision_every)


def _one(job: dict) -> dict:
    strategy = load_strategy(job["dir"])
    data, quality, fq, raw, spot, spot_q = _load(job, strategy.universe)
    config = _config(job, strategy.universe, job["decision_every"].get(strategy.name, 1))
    notes = job["notes"] + [f"spot benchmark from {job['spot_source']}: {s} {q.n_bars} bars, {q.missing_bars} missing"
                            for s, q in spot_q.items() if s in spot]
    report, _ = build_perp_report(strategy, data, config, quality=quality, funding_quality=fq, funding_raw=raw,
                                  spot_data=spot, ledger=job["ledger"], source=SOURCE, notes=notes,
                                  n_resamples=job["resamples"], seed=job["seed"])
    return report


def universe_benchmarks(job: dict) -> dict:
    """perp_long_1x and spot buy-and-hold of the whole perpetual universe, on each split."""
    perps = [s for s in job["all_symbols"] if not is_spot_leg(s)]
    data, _, _, _, spot, _ = _load(job, perps)
    exp = PerpExperiment(data, _config(job, perps), spot_data=spot)
    out = {"symbols": perps, "buy_and_hold_is_spot": None, "splits": exp.splits.to_report()}
    for split in ("train", "validation", "test"):
        res = exp.benchmarks(split)
        out[split] = {}
        for name in ("perp_long_1x", "buy_and_hold"):
            r = res[name]
            m = compute_perp_metrics(r) if name == "perp_long_1x" else (
                compute_metrics(r) if exp.buy_and_hold_is_spot else compute_perp_metrics(r))
            m["sharpe_ci"] = bootstrap_sharpe_ci(r.returns.to_numpy(), job["interval"], n_samples=job["resamples"],
                                                 seed=job["seed"])["ci"]
            out[split][name] = m
    out["buy_and_hold_is_spot"] = bool(exp.buy_and_hold_is_spot)
    return out


ROW_KEYS = ("total_return", "cagr", "volatility", "sharpe", "sortino", "max_drawdown", "worst_intrabar_drawdown",
            "calmar", "turnover", "trades", "win_rate", "profit_factor", "fees_paid", "slippage_paid", "funding_pnl",
            "exposure", "long_exposure", "short_exposure", "gross_leverage_mean", "gross_leverage_max",
            "net_leverage_mean", "time_in_market", "avg_holding_hours", "liquidations", "wiped_out",
            "margin_utilisation_max")


def summary_rows(reports: list[dict], bench: dict) -> list[dict]:
    rows = []
    for rep in reports:
        m, rob = rep["metrics"], rep["robustness"]
        rows.append({
            "strategy": f"{rep['strategy']['name']}/{rep['strategy']['version']}", "sha256": rep["strategy_sha256"],
            "symbols": rep["config"]["symbols"],
            **{k: m["test"][k] for k in ROW_KEYS},
            "sharpe_ci": rob["bootstrap_sharpe_ci"],
            "train": {k: m["train"][k] for k in ("total_return", "sharpe", "max_drawdown", "liquidations",
                                                 "funding_pnl", "fees_paid", "trades")},
            "validation": {k: m["validation"][k] for k in ("total_return", "sharpe", "max_drawdown", "liquidations",
                                                           "funding_pnl", "fees_paid", "trades")},
            "own_trials": rob["deflated_sharpe_detail"].get("own_trials"),
            "trials_tested": rob["trials_tested"], "deflated_sharpe": rob["deflated_sharpe"],
            "own_benchmarks": {n: {k: b[k] for k in ("total_return", "sharpe", "max_drawdown")}
                               for n, b in rep["benchmarks"].items() if n in ("perp_long_1x", "buy_and_hold")},
            "checks": {k: rep["checks"][k] for k in ("lookahead", "data_quality", "ledger", "funding_alignment")},
        })
    for name in ("perp_long_1x", "buy_and_hold"):
        b = bench["test"][name]
        label = {"perp_long_1x": "benchmark: perp long 1x incl. funding",
                 "buy_and_hold": "benchmark: buy and hold spot" if bench["buy_and_hold_is_spot"]
                 else "benchmark: perp price held, NO funding (no spot data)"}[name]
        rows.append({"strategy": label, "symbols": bench["symbols"], **{k: b.get(k) for k in ROW_KEYS},
                     "sharpe_ci": b["sharpe_ci"],
                     "train": {k: bench["train"][name].get(k) for k in ("total_return", "sharpe", "max_drawdown")},
                     "validation": {k: bench["validation"][name].get(k)
                                    for k in ("total_return", "sharpe", "max_drawdown")}})
    return rows


def _ci(ci):
    return f"[{_fmt(ci[0])}, {_fmt(ci[1])}]" if ci and ci[0] is not None else "n/a"


def _usd(x):
    return "n/a" if x is None else f"{x:+.2f}"


def summary_markdown(rows: list[dict], reports: list[dict], bench: dict, depth: dict | None = None) -> str:
    c = reports[0]["config"]
    s = bench["splits"]
    out = [
        f"# Perpetual-futures strategies on {', '.join(bench['symbols'])} at {c['interval']} ({c['source']})",
        "",
        f"Data {c['start']} to {c['end']} ({c['bars']} common closed bars). Train {s['train'][0][:10]} to "
        f"{s['train'][1][:10]}, validation {s['validation'][0][:10]} to {s['validation'][1][:10]}, "
        f"**test {s['test'][0][:10]} to {s['test'][1][:10]}**.",
        f"Costs: taker fee {c['taker_fee_bps']} bps + slippage {c['slippage_bps']} bps on traded notional "
        f"(fills pay the {c['liquidity']} fee); spot legs and the spot benchmark {c['spot_fee_bps']} + "
        f"{c['spot_slippage_bps']} bps; liquidation penalty {c['liquidation_penalty_bps']} bps of the liquidated "
        f"notional; initial collateral {c['initial_cash']} USDC; minimum order {c['min_order']} USD; rebalance "
        f"threshold {c['rebalance_threshold']}.",
        "Parameters are the ones written in each META before any backtest; nothing was selected on the test split.",
        "",
        "## Test split",
        "",
        "| Strategy | Return | Sharpe | Sharpe 95 % CI | Max DD | Worst intrabar DD | Trades | Fees + slippage (USD) | "
        "Funding PnL (USD) | Gross lev. mean / max | Net lev. mean | Time in market | Avg holding (h) | "
        "Liquidations | Trials | Deflated Sharpe |",
        "|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for r in rows:
        costs = (r["fees_paid"] or 0) + (r["slippage_paid"] or 0)
        liq = "n/a" if r.get("liquidations") is None else f"{r['liquidations']}{' (wiped out)' if r.get('wiped_out') else ''}"
        out.append(
            f"| {r['strategy']} | {_fmt(r['total_return'], True)} | {_fmt(r['sharpe'])} | {_ci(r.get('sharpe_ci'))} | "
            f"{_fmt(-r['max_drawdown'] if r['max_drawdown'] is not None else None, True)} | "
            f"{_fmt(-r['worst_intrabar_drawdown'] if r.get('worst_intrabar_drawdown') is not None else None, True)} | "
            f"{r['trades']} | {costs:.2f} | {_usd(r.get('funding_pnl'))} | "
            f"{_fmt(r.get('gross_leverage_mean'))} / {_fmt(r.get('gross_leverage_max'))} | "
            f"{_fmt(r.get('net_leverage_mean'))} | {_fmt(r.get('time_in_market'))} | "
            f"{_fmt(r.get('avg_holding_hours'), nd=0)} | {liq} | {r.get('trials_tested', '')} | "
            f"{_fmt(r.get('deflated_sharpe'), nd=3) if 'deflated_sharpe' in r else ''} |")
    out += [
        "",
        "## Train, validation and test side by side (each split backtested from cash)",
        "",
        "| Strategy | Train return | Train Sharpe | Train liq. | Validation return | Validation Sharpe | "
        "Validation liq. | Test return | Test Sharpe | Test liq. |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for r in rows:
        t, v = r["train"], r["validation"]
        out.append(f"| {r['strategy']} | {_fmt(t['total_return'], True)} | {_fmt(t['sharpe'])} | "
                   f"{t.get('liquidations', 'n/a')} | {_fmt(v['total_return'], True)} | {_fmt(v['sharpe'])} | "
                   f"{v.get('liquidations', 'n/a')} | {_fmt(r['total_return'], True)} | {_fmt(r['sharpe'])} | "
                   f"{r.get('liquidations') if r.get('liquidations') is not None else 'n/a'} |")
    out += [
        "",
        "Return and drawdowns in percent; Sharpe annualised (8 760 bars per year at 1h, risk-free 0); the interval is a "
        "95 % stationary-block-bootstrap interval of the test Sharpe ratio. Max DD uses bar closes; worst intrabar DD "
        "values every long at the bar's low and every short at its high against the previous closing peak. Funding "
        "PnL < 0 means the strategy paid funding on balance. Leverage = notional / equity at bar closes. Trials = "
        "distinct (strategy, parameters) configurations run on train + validation across the whole run; the deflated "
        "Sharpe ratio (Bailey & López de Prado 2014) is the probability that the true Sharpe ratio is positive given "
        "that many trials. Below 0.95, 'no skill' is not rejected.",
        "",
    ]
    if depth:
        out += ["## History served by the venue (measured)", "",
                "| Perpetual | 1h candles from | 4h candles from | 1d candles from | Funding from |", "|---|---|---|---|---|"]
        for sym, d in depth.items():
            cd = d.get("candles", {})
            cells = [f"{cd[iv]['first'][:10]} ({cd[iv]['days']:.0f} d)" if iv in cd else "n/a"
                     for iv in ("1h", "4h", "1d")]
            cells.append(f"{d['funding']['first'][:10]} ({d['funding']['days']:.0f} d)" if "funding" in d else "n/a")
            out.append(f"| {sym} | " + " | ".join(cells) + " |")
        out.append("")
    return "\n".join(out)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m spq.perp_pipeline", description=__doc__.split("\n")[0])
    p.add_argument("--strategies", default="strategies")
    p.add_argument("--interval", default="1h")
    p.add_argument("--start", default=None)
    p.add_argument("--end", default=None)
    p.add_argument("--data-dir", required=True)
    p.add_argument("--spot-source", default="coinbase")
    add_cost_arguments(p)
    p.add_argument("--decision-every", action="append", default=[], metavar="NAME=N")
    p.add_argument("--resamples", type=int, default=2000)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--depth", default=None, help="JSON file {symbol: measure_depth(...)} to include in the summary")
    p.add_argument("--out", required=True)
    a = p.parse_args(argv)

    out = Path(a.out)
    (out / "ledger").mkdir(parents=True, exist_ok=True)
    dirs = [d for d in find_strategies(a.strategies) if load_strategy(d).kind == "perp"]
    if not dirs:
        print("no perp strategy found", file=sys.stderr)
        return 2
    all_symbols: list[str] = []
    for d in dirs:
        for s in load_strategy(d).universe:
            if s not in all_symbols:
                all_symbols.append(s)
    costs = {k: getattr(a, k) for k in (
        "taker_fee_bps", "maker_fee_bps", "liquidity", "slippage_bps", "liquidation_penalty_bps",
        "maintenance_fraction", "leverage", "spot_fee_bps", "spot_slippage_bps", "initial_cash", "min_order",
        "rebalance_threshold")}
    every = {k: int(v) for k, v in (x.split("=") for x in a.decision_every)}
    base = {"all_symbols": all_symbols, "interval": a.interval, "start": a.start, "end": a.end,
            "data_dir": a.data_dir, "spot_source": a.spot_source, "costs": costs, "decision_every": every,
            "resamples": a.resamples, "seed": a.seed,
            "notes": [f"bars common to every series of the run: {', '.join(all_symbols)}"]}
    jobs = []
    for d in dirs:
        ledger = out / "ledger" / f"{d.parent.name}-{d.name}.jsonl"
        ledger.unlink(missing_ok=True)
        jobs.append({**base, "dir": str(d), "ledger": str(ledger)})
    with ProcessPoolExecutor(max_workers=a.workers) as pool:
        reports = list(pool.map(_one, jobs))
    bench = universe_benchmarks(base)

    records = [r for j in jobs for r in read_ledger(j["ledger"])]
    (out / "trials.jsonl").write_text("".join(json.dumps(r) + "\n" for r in records))
    trials = _unique_trials(records, a.interval)
    sharpes = [t.get("validation_sharpe_per_bar") for t in trials]
    for rep in reports:
        own = rep["robustness"]["deflated_sharpe_detail"]
        dsr = deflated_sharpe_from_returns(returns_from_report(rep), sharpes)
        dsr.update({"n_trials": len(trials), "sharpe_split": "test", "trial_sharpes_split": "validation",
                    "scope": "all perp strategies and parameter sets of this pipeline run",
                    "own_trials": own["n_trials"], "own_deflated_sharpe": own["deflated_sharpe"]})
        rep["robustness"].update({"trials_tested": len(trials), "deflated_sharpe": dsr["deflated_sharpe"],
                                  "deflated_sharpe_detail": dsr})
        write_perp_report(rep, out / f"{rep['strategy']['name']}-{rep['strategy']['version']}.json")
    rows = summary_rows(reports, bench)
    depth = json.loads(Path(a.depth).read_text()) if a.depth else None
    (out / "summary.json").write_text(json.dumps({"rows": rows, "benchmarks": bench, "history_depth": depth},
                                                 indent=1) + "\n")
    md = summary_markdown(rows, reports, bench, depth)
    (out / "summary.md").write_text(md)
    print(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
