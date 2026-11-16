"""V11 research run: every V11 strategy on real multi-venue data, version-3 reports, one trial ledger.

    uv run python -m spq v11 run --data-dir data --manifest data-manifests/2026-11-15-v11.json \
        --out results/2026-11-15-v11
    uv run python -m spq v11 verify --data-dir data --manifest data-manifests/2026-11-15-v11.json \
        --out results/2026-11-15-v11          # re-runs everything and compares the report hashes

Each strategy runs on the symbols of RUNS below with the execution model and the engine parity of
docs/TRADING-BACKTESTING.md, parameters = its META (written before any backtest), an explicit small sensitivity
grid (every cell is a recorded trial), the single look at the test split, and the look-ahead check. All the trials
of the run are merged in <out>/trials.jsonl and every deflated Sharpe ratio is recomputed with that total:
choosing among several strategies is itself a selection. <out>/manifest.json holds the SHA-256 of every report.

Nothing here is tuned on the test split, and nothing here says a strategy is profitable.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from .data.hyperliquid import load_meta
from .data.multivenue import data_bias, funding_intervals, load_multivenue, snapshot_hash
from .data.venues import PRIMARY_VENUE, SPOT_VENUE, split_symbol, venue
from .dsr import deflated_sharpe_from_returns
from .execution import ExecutionModel, calibrated_execution, load_parity
from .perp_engine import PerpConfig
from .perp_report import returns_from_report
from .report import _unique_trials
from .report_v3 import build_report_v3, validate_report_v3, write_report_v3
from .research import cartesian_grid, read_ledger
from .strategy import load_strategy

LAB = Path(__file__).resolve().parents[2]
WIDE = ["BTC", "ETH", "SOL", "LINK", "AAVE", "HYPE", "XRP", "DOGE", "AVAX", "BNB"]
#: lot decimals of the non-primary venues (edgeX stepSize from live getMetaData, 2026-11-15)
LOT_DECIMALS = {"edgex": {"BTC": 3, "ETH": 2, "SOL": 1}}

#: (strategy directory relative to research/, symbols or None for META['universe'], sensitivity axes)
RUNS = [
    ("strategies/momentum_xs_perp/1", WIDE, {"momentum_bars": [168, 672], "rebalance_bars": [72]}),
    ("strategies/momentum_xs_perp/2", None, {"momentum_bars": [168, 672], "rebalance_bars": [72]}),
    ("strategies/mean_reversion_bands_perp/1", WIDE, {"window": [24, 96], "max_efficiency": [0.1, 0.4]}),
    ("strategies/mean_reversion_bands_perp/2", None, {"window": [24, 96], "max_efficiency": [0.1, 0.4]}),
    ("strategies/statarb_basket_perp/1", None, {"window": [168, 504], "entry_s": [1.25, 2.0]}),
    ("strategies/basis_cash_carry/1", None, {"enter_net_apr": [0.02, 0.1], "window": [72]}),
    ("strategies_xvenue/funding_arb_cross_venue/1", None, {"enter_net_apr": [0.02, 0.08], "window": [72]}),
]


def one_axis_grid(base: dict, axes: dict) -> list[dict]:
    """The base parameters, then each listed value of each axis in turn (one at a time): a small, explicit grid."""
    grid = [dict(base)]
    for k, values in axes.items():
        for cand in cartesian_grid(base, {k: values})[1:]:
            if cand not in grid:
                grid.append(cand)
    return grid


def make_config(symbols, interval: str, data_dir, *, execution: ExecutionModel | None = None, parity=None,
                initial_cash: float = 1000.0) -> PerpConfig:
    uni = load_meta(data_dir).get("universe", {})
    lev, lots = {}, {}
    for s in symbols:
        base, v = split_symbol(s)
        if v == SPOT_VENUE:
            continue
        if base in uni:                       # the underlying's Hyperliquid maximum leverage is used on every venue
            lev[s] = uni[base]["max_leverage"]
            lots[s] = LOT_DECIMALS.get(v, {}).get(base, uni[base]["size_decimals"]) if v != PRIMARY_VENUE \
                else uni[base]["size_decimals"]
    hl = venue(PRIMARY_VENUE)
    return PerpConfig(interval=interval, taker_fee_bps=hl.taker_bps, maker_fee_bps=hl.maker_bps, liquidity="taker",
                      slippage_bps=2.0, initial_cash=initial_cash, min_order=hl.min_order_usd, rebalance_threshold=0.0,
                      venue_max_leverage=lev, size_decimals=lots,
                      execution=execution or calibrated_execution(symbols), parity=parity)


def run_one(job: dict) -> dict:
    strategy = load_strategy(LAB / job["dir"])
    symbols = job["symbols"] or strategy.universe
    data, quality, fq, fraw, clock = load_multivenue(symbols, job["interval"], job["start"], job["end"],
                                                     root=job["data_dir"], as_of=job["as_of"])
    perp_par, _, raw = load_parity()
    config = make_config(symbols, job["interval"], job["data_dir"], parity=perp_par)
    bias = data_bias(symbols, data, quality, clock, job["interval"], requested_start=job["start"])
    snap = {"sha256": snapshot_hash(data), "manifest": job["manifest_name"],
            "manifest_snapshot_sha256": job["manifest_sha"], "captured_at": job["as_of"],
            "range": [next(iter(data.values())).index[0].isoformat(), next(iter(data.values())).index[-1].isoformat()],
            "bars": int(len(next(iter(data.values()))))}
    spot = {}
    perps = [s for s in symbols if split_symbol(s)[1] != SPOT_VENUE]
    if all(split_symbol(s)[1] == PRIMARY_VENUE for s in perps):     # spot benchmark only for a single-venue universe
        try:
            sdata, _, _, _, _ = load_multivenue([s + ".SPOT" for s in perps], job["interval"], job["start"], job["end"],
                                                root=job["data_dir"], as_of=job["as_of"])
            idx = next(iter(data.values())).index
            if all(idx.isin(df.index).all() for df in sdata.values()):
                spot = {s: sdata[s + ".SPOT"].loc[idx] for s in perps}
        except Exception:  # noqa: BLE001 - no spot file for a symbol: the report says which benchmark it used
            spot = {}
    grid = one_axis_grid(strategy.params, job["axes"])
    notes = [f"V11 run on {', '.join(symbols)}; data snapshot {snap['sha256'][:16]} (manifest {job['manifest_name']})",
             "maximum leverage and maintenance fraction of an instrument on another venue are taken from the same "
             "underlying on Hyperliquid (a simplification: edgeX allows more leverage and a lower maintenance margin)"]
    report, _ = build_report_v3(strategy, data, config, ledger=job["ledger"], data_bias=bias, data_snapshot=snap,
                                generated_at=job["as_of"], parity_raw=raw, funding_intervals=funding_intervals(symbols),
                                seed=job["seed"], n_resamples=job["resamples"], quality=quality, funding_quality=fq,
                                funding_raw=fraw, spot_data=spot, grid=grid, source="multi-venue (see config.symbols)",
                                notes=notes)
    return report


def run_all(a) -> tuple[list[dict], dict]:
    out = Path(a.out)
    (out / "ledger").mkdir(parents=True, exist_ok=True)
    manifest = json.loads(Path(a.manifest).read_text())
    as_of = manifest["captured_at"]
    jobs = []
    for d, symbols, axes in RUNS:
        s = load_strategy(LAB / d)
        ledger = out / "ledger" / f"{s.name}-{s.meta['version']}.jsonl"
        ledger.unlink(missing_ok=True)                  # every run starts from an empty ledger: reproducible
        jobs.append({"dir": d, "symbols": symbols, "axes": axes, "interval": "1h", "start": manifest["range"][0],
                     "end": manifest["range"][1], "data_dir": a.data_dir, "as_of": as_of, "ledger": str(ledger),
                     "manifest_name": Path(a.manifest).name, "manifest_sha": manifest["snapshot_sha256"],
                     "seed": a.seed, "resamples": a.resamples})
    if a.workers > 1:
        with ProcessPoolExecutor(max_workers=a.workers) as pool:
            reports = list(pool.map(run_one, jobs))
    else:
        reports = [run_one(j) for j in jobs]
    records = [r for j in jobs for r in read_ledger(j["ledger"])]
    trials = _unique_trials(records, "1h")
    sharpes = [t.get("validation_sharpe_per_bar") for t in trials]
    for rep in reports:
        own = rep["robustness"]["deflated_sharpe_detail"]
        dsr = deflated_sharpe_from_returns(returns_from_report(rep), sharpes)
        dsr.update({"n_trials": len(trials), "sharpe_split": "test", "trial_sharpes_split": "validation",
                    "scope": "every strategy and parameter set of this V11 run",
                    "own_trials": own["n_trials"], "own_deflated_sharpe": own["deflated_sharpe"]})
        rep["robustness"].update({"trials_tested": len(trials), "deflated_sharpe": dsr["deflated_sharpe"],
                                  "deflated_sharpe_detail": dsr})
        validate_report_v3(rep)
    return reports, {"records": records, "n_trials": len(trials)}


def _pct(x, nd=1):
    return "n/a" if x is None else f"{100 * x:+.{nd}f} %"


def _f(x, nd=2):
    return "n/a" if x is None else f"{x:.{nd}f}"


def summary(reports: list[dict], n_trials: int) -> tuple[list[dict], str]:
    rows = []
    for rep in reports:
        m, rob = rep["metrics"], rep["robustness"]
        t = m["test"]
        rows.append({
            "strategy": f"{rep['strategy']['name']}/{rep['strategy']['version']}", "sha256": rep["strategy_sha256"],
            "symbols": rep["config"]["symbols"],
            **{sp: {"return_net": m[sp]["total_return"], "sharpe_net": m[sp]["sharpe"],
                    "sharpe_gross": m[sp]["gross_to_net"]["sharpe_gross"], "max_drawdown": m[sp]["max_drawdown"],
                    "trades": m[sp]["trades"], "gross_to_net": m[sp]["gross_to_net"],
                    "stop": rep["engine_parity"]["observed"][sp]["stop"]} for sp in ("train", "validation", "test")},
            "test_sharpe_ci": rob["bootstrap_sharpe_ci"], "deflated_sharpe": rob["deflated_sharpe"],
            "trials_tested": rob["trials_tested"], "own_trials": rob["deflated_sharpe_detail"].get("own_trials"),
            "benchmarks_test": {k: {x: b[x] for x in ("total_return", "sharpe", "max_drawdown")}
                                for k, b in rep["benchmarks"].items() if k in ("perp_long_1x", "buy_and_hold")},
            "checks": {k: rep["checks"][k] for k in ("lookahead", "data_quality", "ledger", "funding_alignment")},
            "time_in_market_test": t["time_in_market"], "gross_leverage_mean_test": t["gross_leverage_mean"],
        })
    c, s = reports[0]["config"], reports[0]["splits"]
    ex = reports[0]["execution_model"]
    out = [
        "# V11 strategies on real multi-venue data (version-3 reports)", "",
        f"Data {c['start'][:16]} to {c['end'][:16]} UTC, {c['interval']} bars; train {s['train'][0][:10]} to "
        f"{s['train'][1][:10]}, validation {s['validation'][0][:10]} to {s['validation'][1][:10]}, **test "
        f"{s['test'][0][:10]} to {s['test'][1][:10]}** (dates of the first report; each report states its own).",
        f"Execution: latency {ex['latency']['latency_s']:g} s ({ex['latency']['model']}), slippage "
        f"{ex['slippage']['model']} (Y = {ex['slippage']['impact_coefficient']:g}), taker fees per venue, one account "
        "per venue, ENGINE PARITY ON (default limits of the live perp engine). 1 000 USDC.",
        f"Trials of the whole run: {n_trials}. Parameters are the ones in each META, written before any backtest.", "",
        "## Out of sample (test split), net of every cost", "",
        "| Strategy | Symbols | Net return | Net Sharpe | 95 % CI | Gross Sharpe | Max DD | Fills | Deflated Sharpe | "
        "Stopped by the engine | Checks |",
        "|---|---|---:|---:|---|---:|---:|---:|---:|---|---|",
    ]
    for r in rows:
        t = r["test"]
        ci = r["test_sharpe_ci"]
        ci_s = f"[{_f(ci[0])}, {_f(ci[1])}]" if ci and ci[0] is not None else "n/a"
        chk = "all pass" if all(v == "pass" for v in r["checks"].values()) else \
            ", ".join(f"{k} {v}" for k, v in r["checks"].items() if v != "pass")
        out.append(f"| {r['strategy']} | {len(r['symbols'])} | {_pct(t['return_net'], 2)} | {_f(t['sharpe_net'])} | {ci_s} | "
                   f"{_f(t['sharpe_gross'])} | {_pct(-t['max_drawdown'] if t['max_drawdown'] is not None else None, 2)} | "
                   f"{t['trades']} | {_f(r['deflated_sharpe'], 3)} | {t['stop']['code'] if t['stop'] else 'no'} | {chk} |")
    out += ["", "## Train, validation, test (each split backtested from cash; net)", "",
            "| Strategy | Train return | Train Sharpe | Train stop | Validation return | Validation Sharpe | "
            "Validation stop | Test return | Test Sharpe | Test stop |", "|---|---:|---:|---|---:|---:|---|---:|---:|---|"]
    for r in rows:
        cells = []
        for sp in ("train", "validation", "test"):
            x = r[sp]
            cells += [_pct(x["return_net"], 2), _f(x["sharpe_net"]), x["stop"]["code"] if x["stop"] else "no"]
        out.append(f"| {r['strategy']} | " + " | ".join(cells) + " |")
    out += ["", "## Gross to net on the test split (USD on 1 000 USDC)", "",
            "| Strategy | Price PnL | Funding | Fees | Slippage | Latency | Net PnL |", "|---|---:|---:|---:|---:|---:|---:|"]
    for r in rows:
        g = r["test"]["gross_to_net"]
        out.append(f"| {r['strategy']} | {g['price_pnl']:+.2f} | {g['funding']:+.2f} | {-(g['trading_fees'] + g['liquidation_penalties']):+.2f} | "
                   f"{-g['slippage']:+.2f} | {-g['latency']:+.2f} | {g['net_pnl']:+.2f} |")
    out += ["", "Net Sharpe: annualised with 8 760 bars per year, risk-free 0, on equity after fees, slippage, latency "
            "and funding. Gross Sharpe: the same run with fees, slippage, latency and funding added back (sizes are "
            "the net run's). The interval is a 95 % stationary-block-bootstrap interval of the net test Sharpe ratio. "
            "Deflated Sharpe (Bailey & Lopez de Prado 2014): probability that the true Sharpe ratio is positive given "
            "every trial of the run; below 0.95 'no skill' is not rejected. 'Stopped by the engine': the default loss "
            "limits (3 % in a UTC day, 10 % in total) or a liquidation ended the run — the equity is flat afterwards.", ""]
    return rows, "\n".join(out)


def write_all(reports, extra, out: Path) -> dict:
    hashes = {}
    for rep in reports:
        name = f"{rep['strategy']['name']}-{rep['strategy']['version']}.json"
        hashes[name] = write_report_v3(rep, out / name)
    blob = "".join(json.dumps(r, sort_keys=True) + "\n" for r in extra["records"]).encode()
    (out / "trials.jsonl").write_bytes(blob)
    hashes["trials.jsonl"] = hashlib.sha256(blob).hexdigest()
    rows, md = summary(reports, extra["n_trials"])
    for name, text in (("summary.json", json.dumps({"rows": rows, "n_trials": extra["n_trials"]}, indent=1) + "\n"),
                       ("summary.md", md)):
        (out / name).write_text(text)
        hashes[name] = hashlib.sha256(text.encode()).hexdigest()
    return hashes


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m spq v11", description=__doc__.split("\n")[0])
    p.add_argument("command", choices=("run", "verify"))
    p.add_argument("--data-dir", required=True)
    p.add_argument("--manifest", required=True, help="data manifest (python -m spq data manifest)")
    p.add_argument("--out", required=True)
    p.add_argument("--resamples", type=int, default=2000)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--workers", type=int, default=4)
    a = p.parse_args(argv)
    out = Path(a.out)
    if a.command == "run":
        reports, extra = run_all(a)
        hashes = write_all(reports, extra, out)
        (out / "manifest.json").write_text(json.dumps({"reports": hashes, "code_sha256": reports[0]["journal"]["code"]["code_sha256"],
                                                       "data_manifest": Path(a.manifest).name}, indent=1, sort_keys=True) + "\n")
        print((out / "summary.md").read_text())
        return 0
    committed = json.loads((out / "manifest.json").read_text())["reports"]
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        b = argparse.Namespace(**{**vars(a), "out": tmp})
        reports, extra = run_all(b)
        fresh = write_all(reports, extra, Path(tmp))
    bad = {k: (committed.get(k), fresh.get(k)) for k in sorted(set(committed) | set(fresh)) if committed.get(k) != fresh.get(k)}
    print(json.dumps({"files": len(fresh), "identical": len(fresh) - len(bad), "different": bad}, indent=1))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
