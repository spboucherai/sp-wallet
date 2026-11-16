"""Backtest report, schema version 3 (V11): schema/backtest-report-v3.schema.json.

Every key of the version-2 report is present with the same meaning (a version-2 reader keeps working on the keys it
knows; the version-1 and version-2 writers and schemas are untouched). Version 3 adds:

- `execution_model`   latency, slippage model, the fee table used (per venue, with source and date), funding
                      interval per venue, accounts (one per venue) — what a fill costs and why;
- `engine_parity`     the live engine's sizing and stop rules that were applied, each with its file:line, and what
                      they did in each split (decisions scaled, stop);
- `metrics.<split>.gross_to_net`   price PnL -> funding -> fees -> slippage -> latency -> net, in USD and as
                      returns, with the Sharpe ratio before and after costs;
- `venue_accounts`    per split and per account (venue): margin equity, margin utilisation, funding received/paid;
- `data_bias`         survivorship, listing-date truncation, missing-bar ratio, stale-price ratio, outage gaps;
- `journal`           strategy hash, code version (hash of the lab's source), data snapshot hash, parameters, seed:
                      what is needed to reproduce the report byte for byte.

REPRODUCIBILITY. A version-3 report contains no wall-clock time: `generated_at` is the capture time of the data
snapshot. Same strategy file, same lab source, same data, same seed -> the same bytes (tests/test_report_v3.py).
The trial ledger is an INPUT of the deflated Sharpe ratio: a run must start from the same ledger to reproduce.
"""
from __future__ import annotations

import hashlib
import json
import platform
from dataclasses import replace
from pathlib import Path

import numpy as np

from . import __version__
from .data.core import bars_per_year
from .data.venues import SPOT_VENUE, fee_table, split_symbol, venue
from .execution import ExecutionModel, parity_report
from .metrics import _num, sharpe_ratio
from .perp_engine import PerpConfig, PerpResult, run_perp_backtest
from .perp_report import build_perp_report
from .strategy import Strategy

SCHEMA_V3_PATH = Path(__file__).resolve().parents[2] / "schema" / "backtest-report-v3.schema.json"
SCHEMA_VERSION = 3
LAB_ROOT = Path(__file__).resolve().parents[2]


def load_schema_v3(path=None) -> dict:
    return json.loads(Path(path or SCHEMA_V3_PATH).read_text())


def validate_report_v3(report: dict, schema: dict | None = None) -> None:
    import jsonschema

    jsonschema.Draft202012Validator(schema or load_schema_v3()).validate(report)


def code_sha256() -> str:
    """Hash of the lab's own source: every src/spq/**/*.py, the parameter files (engine parity, book calibration)
    and the v3 schema."""
    h = hashlib.sha256()
    files = sorted((LAB_ROOT / "src" / "spq").rglob("*.py")) + sorted((LAB_ROOT / "src" / "spq" / "params").glob("*.json")) + [SCHEMA_V3_PATH]
    for f in files:
        h.update(str(f.relative_to(LAB_ROOT)).encode() + b"\0" + f.read_bytes() + b"\0")
    return h.hexdigest()


def gross_to_net(res: PerpResult, interval: str) -> dict:
    """Itemised result of one run. `price_pnl` is realised + unrealised PnL at fill reference prices (the bar
    opens), before any cost; every later line is one cost or income. The identity
    net_pnl = price_pnl + funding - trading_fees - liquidation_penalties - slippage - latency + bad debt written off
    is the engine's exact ledger."""
    led = res.ledger
    f = lambda k: float(led[k])  # noqa: E731
    latency = float(led.get("latency", 0))
    initial = f("initial")
    price = f("realised_pnl") + f("unrealised_pnl")
    pen = f("liquidation_penalties")
    net = f("final_equity") - initial
    N = bars_per_year(interval)
    eq = res.equity.to_numpy(dtype="float64")
    cc = res.cost_curve
    gross_eq = eq + cc["fees"].to_numpy() + cc["slippage"].to_numpy() + cc["latency"].to_numpy() - cc["funding"].to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        gr = gross_eq[1:] / gross_eq[:-1] - 1.0
    gr = np.where(np.isfinite(gr), gr, 0.0)
    mean_eq = float(eq.mean()) if len(eq) else 0.0
    costs = f("fees") + f("slippage") + latency
    return {
        "price_pnl": _num(price), "funding": _num(f("funding")), "trading_fees": _num(f("fees") - pen),
        "liquidation_penalties": _num(pen), "slippage": _num(f("slippage")), "latency": _num(latency),
        "bad_debt_written_off": _num(f("bad_debt_written_off")), "net_pnl": _num(net),
        "return_gross": _num(price / initial), "return_after_funding": _num((price + f("funding")) / initial),
        "return_net": _num(net / initial),
        "sharpe_gross": _num(sharpe_ratio(gr, N)), "sharpe_net": _num(sharpe_ratio(res.returns.to_numpy(), N)),
        "cost_drag_bps_of_mean_equity": _num(costs / mean_eq * 1e4) if mean_eq > 0 else None,
        "costs_over_gross_profit": _num(costs / price) if price > 0 else None,
    }


def venue_accounts(res: PerpResult) -> dict:
    """Per account (venue): collateral use and funding. Margin utilisation = initial margin in use / margin equity
    of THAT account (no transfer between venues is modelled)."""
    out = {}
    names = res.accounts or ["main"]
    fund, trades = res.funding, res.trades
    for nm in names:
        me = res.account_margin_equity[nm].to_numpy()
        ut = res.account_margin_utilisation[nm].to_numpy()
        used = ut[(ut > 0) & np.isfinite(ut)]
        syms = [s for s in res.symbols if (split_symbol(s)[1] if res.config.execution is not None else "main") == nm] \
            if len(names) > 1 else list(res.symbols)
        f = fund[fund["symbol"].isin(syms)]["amount"] if len(fund) else []
        t = trades[trades["symbol"].isin(syms)] if len(trades) else trades
        active = me[me != 0]
        out[nm] = {
            "symbols": syms,
            "margin_equity_min": _num(active.min()) if len(active) else None,
            "margin_equity_last": _num(me[-1]) if len(me) else None,
            "margin_utilisation_mean": _num(used.mean()) if len(used) else 0.0,
            "margin_utilisation_max": _num(used.max()) if len(used) else 0.0,
            "funding_pnl": _num(float(sum(f))) if len(f) else 0.0,
            "fees": _num(float(sum(t["fee"]))) if len(t) else 0.0,
            "slippage": _num(float(sum(t["slippage"]))) if len(t) else 0.0,
            "latency": _num(float(sum(t["latency"]))) if len(t) else 0.0,
            "traded_notional": _num(float(sum(t["notional"]))) if len(t) else 0.0,
            "fills": int(len(t)),
            "liquidations": int(sum(1 for e in res.liquidations if e.get("account") == nm)),
        }
    return out


def parity_observed(res: PerpResult) -> dict:
    c = res.counters
    return {"decisions_scaled_down": int(c["parity_scaled"]), "smallest_scale_factor": _num(c["parity_min_factor"]),
            "orders_below_minimum_trade": int(c["orders_skipped"]), "orders_cut_by_margin": int(c["orders_cut"]),
            "orders_refused_by_margin": int(c["orders_refused"]), "orders_over_daily_cap": int(c["orders_daily_cap"]),
            "orders_delayed_beyond_one_bar": int(c["orders_latency_capped"]), "stop": res.stop}


def execution_section(config: PerpConfig, symbols) -> dict:
    ex: ExecutionModel = config.execution
    venues = sorted({split_symbol(s)[1] for s in symbols})
    half = {s: float(ex.half_spread_bps.get(s, venue(split_symbol(s)[1]).default_half_spread_bps)) for s in symbols}
    return {
        "latency": {
            "model": ex.latency_model, "latency_s": ex.latency_s, "order_spacing_s": ex.order_spacing_s,
            "statement": "decision on the bar's close; a buy fills at open + f x (high - open), a sell at open - f x "
                         "(open - low) of the NEXT bar, f = min(1, sqrt(delay / bar length)); the k-th exposure-adding "
                         "order of a decision is delayed by k x order_spacing_s more. A bound, always against the "
                         "order; booked as the cost line `latency`"},
        "slippage": {
            "model": ex.slippage_model, "impact_coefficient": ex.impact_coefficient,
            "impact_window_bars": ex.impact_window_bars, "max_impact_bps": ex.max_impact_bps, "half_spread_bps": half,
            "book_based": {s: {"n_snapshots": p.get("n_snapshots"), "quantile": ex.book_quantile}
                           for s, p in sorted(ex.book_profiles.items())},
            "calibration": ex.calibration or "none: venue-table half spreads, square-root formula only",
            "statement": "cost_bps = half spread + Y x sigma_bar x sqrt(order notional / mean USD volume per bar), "
                         "sigma and volume on the bars before the fill; where a recorded depth profile is supplied "
                         "the cost is read on it instead (never below the half spread)"},
        "fees": {"liquidity": config.liquidity, "per_venue": ex.venue_fees, "fee_table": fee_table(venues)},
        "funding": {v: {"interval_s": venue(v).funding_interval_s, "model": venue(v).funding_model}
                    for v in venues if v != SPOT_VENUE},
        "accounts": {"model": ex.accounts, "capital_split": dict(ex.capital_split) or "equal shares",
                     "statement": "one cross-margin account per venue with its own collateral, margin check and "
                                  "liquidation; no transfer between venues; a liquidated account's loss beyond its "
                                  "collateral is written off (it cannot reach another venue)"},
        "liquidation": "perpetuals: exact intrabar model of version 2, per account; spot legs: not applicable "
                       "(unlevered, never liquidated)",
    }


def build_report_v3(
    strategy: Strategy,
    data: dict,
    config: PerpConfig,
    *,
    ledger,
    data_bias: dict,
    data_snapshot: dict,
    generated_at: str,
    parity_raw: dict | None = None,
    funding_intervals: dict | None = None,
    seed: int = 0,
    n_resamples: int = 2000,
    fractions=(0.6, 0.2, 0.2),
    **kwargs,
) -> tuple[dict, object]:
    """Version-3 report of ONE perp strategy version. `config` must carry an ExecutionModel; `ledger` is mandatory
    (every run is recorded); `data_snapshot` = {"sha256", "manifest", ...} identifies the data."""
    if config.execution is None:
        raise ValueError("a version-3 report needs config.execution (spq.execution.ExecutionModel)")
    if not ledger:
        raise ValueError("a version-3 report needs a trial ledger: every run is recorded")
    cap: dict = {}
    report, exp = build_perp_report(strategy, data, config, ledger=ledger, seed=seed, n_resamples=n_resamples,
                                    fractions=fractions, funding_intervals=funding_intervals,
                                    generated_at=generated_at, validate=False, capture=cap, **kwargs)
    runs = cap["runs"]
    for split, res in runs.items():
        report["metrics"][split]["gross_to_net"] = gross_to_net(res, config.interval)
    report["schema_version"] = SCHEMA_VERSION
    report["execution_model"] = execution_section(config, exp.symbols)
    report["venue_accounts"] = {s: venue_accounts(res) for s, res in runs.items()}
    if config.parity is not None:
        # what the engine actually used, not the strategy's bounds
        report["config"]["leverage"] = float(config.parity.max_leverage)
        report["config"]["rebalance_threshold"] = float(config.parity.min_trade_pct) / 100.0
        if parity_raw is None:
            raise ValueError("config.parity is set: pass parity_raw (spq.execution.load_parity()[2]) for the provenance")
        report["engine_parity"] = {"applied": True, **parity_report(parity_raw, "perp"),
                                   "observed": {s: parity_observed(res) for s, res in runs.items()},
                                   "statement": "the owner's DEFAULT limits: weights scaled by one factor to the "
                                                "leverage, gross and position caps; minimum trade; venue minimum x "
                                                "factor; one exposure-adding order per engine pass; loss limits and "
                                                "liquidation stop the agent (flatten at the next open, no further "
                                                "decision). config.rebalance_threshold is replaced by min_trade_pct"}
    else:
        report["engine_parity"] = {"applied": False,
                                   "statement": "engine parity was switched off for this run: the report does NOT "
                                                "describe what an agent with default limits would do"}
    # execution sensitivity on the VALIDATION split (never the test split): what the cost assumptions change
    v0, v1 = exp.splits.window("validation")
    alts = {"pre_v11_model (next open, constant slippage, pooled account, no engine rules)":
            replace(config, execution=None, parity=None),
            "latency_300s": replace(config, execution=replace(config.execution, latency_s=300.0)),
            "impact_coefficient_x3": replace(config, execution=replace(config.execution, impact_coefficient=3.0 * config.execution.impact_coefficient))}
    sens = {"as_reported": {k: report["metrics"]["validation"][k] for k in ("total_return", "sharpe", "max_drawdown")}}
    pooled_ok = all("@" not in s for s in exp.symbols)
    for name, cfg in alts.items():
        if cfg.execution is None and not pooled_ok:
            continue                                  # the pre-v11 engine has no notion of a second venue
        try:
            r = run_perp_backtest(strategy, exp.dev_data(), cfg, start=v0, end=v1)
            eq = r.equity.to_numpy()
            from .metrics import max_drawdown

            sens[name] = {"total_return": _num(eq[-1] / cfg.initial_cash - 1.0),
                          "sharpe": _num(sharpe_ratio(r.returns.to_numpy(), bars_per_year(config.interval))),
                          "max_drawdown": _num(max_drawdown(eq))}
        except Exception as e:  # noqa: BLE001
            sens[name] = {"error": f"{type(e).__name__}: {e}"}
    report["robustness"]["execution_sensitivity"] = {"split": "validation", "runs": sens}
    report["data_bias"] = data_bias
    report["journal"] = {
        "strategy": {"name": strategy.name, "version": strategy.meta["version"], "sha256": strategy.sha256},
        "code": {"spq_version": __version__, "code_sha256": code_sha256(),
                 "python": platform.python_version(), "numpy": np.__version__,
                 "pandas": __import__("pandas").__version__},
        "data": data_snapshot,
        "parameters": strategy.params, "seed": int(seed), "n_resamples": int(n_resamples),
        "split_fractions": list(fractions),
        "reproducibility": "no wall-clock value is in this report: generated_at is the capture time of the data "
                           "snapshot. Same strategy file, lab source, data snapshot, seed and starting ledger "
                           "reproduce it byte for byte",
    }
    report["checks"]["notes"] = [n for n in report["checks"]["notes"]
                                 if not n.startswith("decision on the closed bar, fill at the next bar's open")] + [
        "v11 execution model: see execution_model (latency bound, size-dependent slippage, fees per venue, one "
        "account per venue); engine rules: see engine_parity"]
    validate_report_v3(report)
    return report, exp


def write_report_v3(report: dict, path) -> str:
    """Write the report (sorted keys are NOT used: the builder's own key order is deterministic) and return the
    SHA-256 of the bytes written."""
    validate_report_v3(report)
    blob = (json.dumps(report, indent=1, allow_nan=False) + "\n").encode()
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(blob)
    return hashlib.sha256(blob).hexdigest()
