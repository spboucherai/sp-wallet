# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/src/spq/strategy.py
# Description      : Strategy contract of docs/v3/ARCHITECTURE.md: loading,
#                    identity, validation and purity guard.
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

"""Strategy contract of docs/v3/ARCHITECTURE.md: loading, identity, validation and purity guard.

A strategy version is a directory containing `strategy.py` with

    META = {"name", "version", "universe", "interval", "lookback", "params"}
    def target_weights(data: dict[str, pandas.DataFrame], params: dict) -> dict[str, float]

Its identity is the SHA-256 of the bytes of `strategy.py`.

Purity ("no network, no clock, no files") is checked in three layers. NONE OF THEM IS A SECURITY BOUNDARY: they are
a lint for honest mistakes and research hygiene. The security boundary is the OS sandbox every process that loads a
strategy runs in (docs/v8/SANDBOX.md) — the tests of that sandbox run with this lint disabled.

1. Static check of the source (spq.purity, AST only): allow-listed modules used through a reviewed API, no dunder
   access of any kind, no module object used as a value, no class / decorator / global state, no string evaluation
   (eval, .format, pandas' eval/query, string annotations), no clock, file or pickle helper.
2. Runtime guard around every call: socket creation, name resolution, builtins.open / io.open / os.open, subprocess,
   time.time & co, the `random` module and the numpy global seedless generators raise `PurityError`.
3. Behavioural checks done by the backtester: the inputs are handed over copy-on-write (mutating them cannot reach the
   engine), and the look-ahead check re-runs the strategy on truncated data and requires identical decisions (this
   proves that the engine leaks no future bar; it cannot see data obtained from outside the inputs).

Known limits: Python cannot confine code running in the same process. Before v8 the static check was a short
deny-list and was trivially evaded (`from typing import sys`, `pd.io.common.os`, `np.ctypeslib`, a generator's
`gi_frame.f_builtins`, a `match` class pattern reading `__globals__`, …: research/tests/evasions.py lists the
patterns tried, all refused now). A stricter lint narrows the room for accidents; it does not make this layer a
sandbox, C-implemented entry points cannot be patched by the runtime guard, and module-level code runs before the
guard is active. What protects the machine is the OS sandbox; what protects the funds is the signer's mandate.
"""
from __future__ import annotations

import ast
import builtins
import hashlib
import importlib.util
import io
import math
import os
import socket
import subprocess
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

from .data.core import interval_seconds

WEIGHT_TOL = 1e-9
META_KEYS = {"name", "version", "universe", "interval", "lookback", "params"}
# Contract v2 (perpetual futures, docs/v4/quant-perps.md). A META without "kind" (or with "kind": "spot") is the
# spot contract above, unchanged. "kind": "perp" adds two mandatory keys: the per-symbol bound of a weight and the
# bound of the sum of absolute weights. A universe symbol ending in ".SPOT" is a spot leg (long-only, fully paid).
KINDS = ("spot", "perp")
PERP_META_KEYS = {"max_leverage", "max_gross_exposure"}
MAX_LEVERAGE_LIMIT = 50.0
SPOT_LEG_SUFFIX = ".SPOT"
# --- v5: universe-generic strategies ------------------------------------------------------------------------------
# META["universe"] == ["*"] means "any set of symbols, chosen by the agent": the symbol list then comes from the input
# (the candles' keys for a signal, --symbols for a backtest), between MIN_SYMBOLS and MAX_SYMBOLS of them, optionally
# narrowed by META["min_symbols"] / META["max_symbols"]. The code hash still pins the behaviour; the agent's mandate
# pins the asset list. A fixed universe (a list of symbols) works exactly as before.
GENERIC = ["*"]
OPTIONAL_META_KEYS = {"min_symbols", "max_symbols"}
MIN_SYMBOLS, MAX_SYMBOLS = 1, 12


def is_generic(meta) -> bool:
    return meta.get("universe") == GENERIC


def symbol_bounds(meta) -> tuple[int, int]:
    return int(meta.get("min_symbols", MIN_SYMBOLS)), int(meta.get("max_symbols", MAX_SYMBOLS))


def _is_symbol(s) -> bool:
    return isinstance(s, str) and 2 <= len(s) <= 10 and s.isascii() and s.isalnum() and s == s.upper()


def resolve_symbols(meta, symbols) -> list[str]:
    """The symbols a run uses. Generic: the given list, validated (distinct tickers, count within the bounds).
    Fixed universe: META['universe'] when nothing is given, else the given list unchanged (as before v5)."""
    if not is_generic(meta):
        return list(meta["universe"]) if symbols is None else list(symbols)
    if symbols is None:
        raise StrategyError("this strategy is universe-generic (META['universe'] == ['*']): the symbols must be given")
    symbols = list(symbols)
    lo, hi = symbol_bounds(meta)
    if len(symbols) < lo or len(symbols) > hi:
        raise StrategyError(f"{len(symbols)} symbols given, this strategy takes between {lo} and {hi}")
    if len(set(symbols)) != len(symbols) or not all(_is_symbol(x) for x in symbols):
        raise StrategyError("symbols must be distinct upper-case tickers (2 to 10 letters or digits)")
    return symbols
# --- end v5 -------------------------------------------------------------------------------------------------------
from .purity import ALLOWED_MODULES, FORBIDDEN_ATTRS, FORBIDDEN_NAMES  # noqa: E402  (v8: the policy tables)

ALLOWED_IMPORTS = {m.split(".")[0] for m in ALLOWED_MODULES}


class StrategyError(Exception):
    """The strategy directory, META or source is not acceptable."""


class HashMismatch(StrategyError):
    """strategy.py does not have the expected SHA-256."""


class PurityError(RuntimeError):
    """The strategy tried to reach the network, a file, the clock or a random source."""


class WeightsError(ValueError):
    """target_weights returned something that is not a valid long-only allocation."""


# ----------------------------------------------------------------------------------------------- identity and META

def sha256_file(path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def validate_meta(meta) -> dict:
    if not isinstance(meta, dict):
        raise StrategyError("META must be a dict")
    kind = meta.get("kind", "spot")
    if kind not in KINDS:
        raise StrategyError(f"META['kind'] must be one of {list(KINDS)} (absent = spot), got {kind!r}")
    allowed = META_KEYS | {"kind"} | OPTIONAL_META_KEYS | (PERP_META_KEYS if kind == "perp" else set())
    required = META_KEYS | (PERP_META_KEYS if kind == "perp" else set())
    missing = required - meta.keys()
    extra = meta.keys() - allowed
    if missing or extra:
        raise StrategyError(f"META keys: missing {sorted(missing)}, unexpected {sorted(extra)}")
    for k in ("name", "version", "interval"):
        if not isinstance(meta[k], str) or not meta[k]:
            raise StrategyError(f"META[{k!r}] must be a non-empty string")
    try:
        interval_seconds(meta["interval"])
    except ValueError as e:
        raise StrategyError(str(e)) from e
    u = meta["universe"]
    if u == GENERIC:  # v5: any set of symbols, chosen by the agent
        lo, hi = meta.get("min_symbols", MIN_SYMBOLS), meta.get("max_symbols", MAX_SYMBOLS)
        if (any(not isinstance(x, int) or isinstance(x, bool) for x in (lo, hi))
                or not MIN_SYMBOLS <= lo <= hi <= MAX_SYMBOLS):
            raise StrategyError(f"META['min_symbols'] / META['max_symbols'] must be integers with "
                                f"{MIN_SYMBOLS} <= min <= max <= {MAX_SYMBOLS}")
    elif OPTIONAL_META_KEYS & meta.keys():
        raise StrategyError("META['min_symbols'] / META['max_symbols'] only apply to a generic universe ['*']")
    elif (not isinstance(u, list) or not u or len(set(u)) != len(u) or "*" in u
            or not all(isinstance(s, str) and s and s == s.upper() for s in u)):
        raise StrategyError("META['universe'] must be a non-empty list of distinct upper-case symbols, or ['*']")
    lb = meta["lookback"]
    if not isinstance(lb, int) or isinstance(lb, bool) or lb < 1:
        raise StrategyError("META['lookback'] must be a positive integer (number of closed bars the strategy needs)")
    if not isinstance(meta["params"], dict) or not all(isinstance(k, str) for k in meta["params"]):
        raise StrategyError("META['params'] must be a dict with string keys")
    if kind == "perp":
        _validate_perp_meta(meta)
    elif any(s.endswith(SPOT_LEG_SUFFIX) for s in u):
        raise StrategyError(f"'{SPOT_LEG_SUFFIX}' symbols (spot legs) only exist in META['kind'] = 'perp' strategies")
    try:
        import json

        json.dumps(meta, allow_nan=False)
    except (TypeError, ValueError) as e:
        raise StrategyError(f"META must be JSON-serialisable: {e}") from e
    return meta


def _validate_perp_meta(meta: dict) -> None:
    for k in sorted(PERP_META_KEYS):
        v = meta[k]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v <= 0:
            raise StrategyError(f"META[{k!r}] must be a positive finite number")
    if meta["max_leverage"] > MAX_LEVERAGE_LIMIT:
        raise StrategyError(f"META['max_leverage'] above {MAX_LEVERAGE_LIMIT:g} is refused")
    u = meta["universe"]
    perps = [s for s in u if not s.endswith(SPOT_LEG_SUFFIX)]
    if not perps:
        raise StrategyError("a perp strategy needs at least one perpetual in its universe")
    for s in u:
        if s.endswith(SPOT_LEG_SUFFIX) and s[: -len(SPOT_LEG_SUFFIX)] not in perps:
            raise StrategyError(f"spot leg {s!r} has no perpetual {s[: -len(SPOT_LEG_SUFFIX)]!r} in the universe")
    n_spot = len(u) - len(perps)
    n_perps = symbol_bounds(meta)[1] if u == GENERIC else len(perps)   # v11: a generic perp universe (['*'])
    if meta["max_gross_exposure"] > meta["max_leverage"] * n_perps + n_spot + WEIGHT_TOL:
        raise StrategyError("META['max_gross_exposure'] cannot exceed max_leverage x number of perpetuals "
                            "(+ 1 per spot leg)")


def static_check(source: str) -> list[str]:
    """Return the list of purity problems found in the source (empty list = nothing found).

    v8: the policy lives in spq.purity (reviewed module API, no dunder, no module objects as values, no class /
    decorator / string evaluation). It is a lint — the OS sandbox of the process is the security boundary."""
    from .purity import check

    return check(source)


# ------------------------------------------------------------------------------------------------- runtime guard

def _deny(what: str) -> Callable:
    def denied(*_a, **_k):
        raise PurityError(f"strategy code tried to use {what}: target_weights must be a pure function of its inputs")
    return denied


_PATCHES: list[tuple[object, str, str]] = [
    (socket, "socket", "the network (socket)"),
    (socket, "create_connection", "the network (socket)"),
    (socket, "getaddrinfo", "the network (DNS)"),
    (socket, "gethostbyname", "the network (DNS)"),
    (builtins, "open", "a file (open)"),
    (io, "open", "a file (io.open)"),
    (os, "open", "a file (os.open)"),
    (os, "system", "a subprocess"),
    (os, "urandom", "a random source (os.urandom)"),
    (subprocess, "Popen", "a subprocess"),
    (time, "time", "the clock (time.time)"),
    (time, "time_ns", "the clock (time.time_ns)"),
    (time, "localtime", "the clock (time.localtime)"),
    (time, "gmtime", "the clock (time.gmtime)"),
    (time, "sleep", "the clock (time.sleep)"),
    (np.random, "default_rng", "a random source (numpy.random.default_rng)"),
    (np.random, "seed", "a random source (numpy.random.seed)"),
    (np.random, "random", "a random source (numpy.random)"),
    (np.random, "rand", "a random source (numpy.random)"),
    (np.random, "randn", "a random source (numpy.random)"),
    (np.random, "randint", "a random source (numpy.random)"),
    (np.random, "normal", "a random source (numpy.random)"),
    (np.random, "uniform", "a random source (numpy.random)"),
    (np.random, "choice", "a random source (numpy.random)"),
    (np.random, "permutation", "a random source (numpy.random)"),
    (np.random, "shuffle", "a random source (numpy.random)"),
]
_DENIERS = [(obj, name, _deny(what)) for obj, name, what in _PATCHES]
_guard_depth = 0


@contextmanager
def purity_guard():
    """Disable network, file, clock, subprocess and random entry points while a strategy runs (re-entrant)."""
    global _guard_depth
    saved = None
    if _guard_depth == 0:
        saved = [(obj, name, getattr(obj, name)) for obj, name, _ in _DENIERS]
        for obj, name, denier in _DENIERS:
            setattr(obj, name, denier)
    _guard_depth += 1
    try:
        yield
    finally:
        _guard_depth -= 1
        if saved is not None:
            for obj, name, original in saved:
                setattr(obj, name, original)


# ------------------------------------------------------------------------------------------------------ weights

def validate_weights(weights, symbols) -> dict[str, float]:
    """Check a long-only allocation: dict symbol -> finite number in [0, 1], total <= 1, known symbols only.

    Symbols that are not returned get weight 0. Values within 1e-9 of the bounds are snapped onto them.
    """
    if not isinstance(weights, dict):
        raise WeightsError(f"target_weights must return a dict, got {type(weights).__name__}")
    unknown = [s for s in weights if s not in symbols]
    if unknown:
        raise WeightsError(f"weights for symbols outside the universe: {sorted(map(str, unknown))}")
    out: dict[str, float] = {}
    for s in symbols:
        w = weights.get(s, 0.0)
        if isinstance(w, bool) or not isinstance(w, (int, float, np.integer, np.floating)):
            raise WeightsError(f"weight of {s} is not a number: {w!r}")
        w = float(w)
        if not math.isfinite(w):
            raise WeightsError(f"weight of {s} is not finite: {w!r}")
        if w < -WEIGHT_TOL or w > 1.0 + WEIGHT_TOL:
            raise WeightsError(f"weight of {s} is outside [0, 1]: {w!r} (long-only, no leverage)")
        out[s] = min(max(w, 0.0), 1.0)
    total = math.fsum(out.values())
    if total > 1.0 + WEIGHT_TOL:
        raise WeightsError(f"weights sum to {total!r} > 1 (no leverage)")
    if total > 1.0:
        out = {s: w / total for s, w in out.items()}
    return out


def is_spot_leg(symbol: str) -> bool:
    return symbol.endswith(SPOT_LEG_SUFFIX)


def validate_perp_weights(weights, symbols, max_leverage: float, max_gross_exposure: float) -> dict[str, float]:
    """Check a contract-v2 allocation: dict symbol -> finite number, negative = short.

    A perpetual's weight is in [-max_leverage, max_leverage]; a spot leg ('X.SPOT') is in [0, 1]; the sum of
    absolute weights is at most max_gross_exposure. Weights are fractions of account equity (notional / equity).
    Symbols that are not returned get weight 0. Values within 1e-9 of a bound are snapped onto it; anything beyond
    is refused, never scaled down silently.
    """
    if not isinstance(weights, dict):
        raise WeightsError(f"target_weights must return a dict, got {type(weights).__name__}")
    unknown = [s for s in weights if s not in symbols]
    if unknown:
        raise WeightsError(f"weights for symbols outside the universe: {sorted(map(str, unknown))}")
    lev = float(max_leverage)
    out: dict[str, float] = {}
    for s in symbols:
        w = weights.get(s, 0.0)
        if isinstance(w, bool) or not isinstance(w, (int, float, np.integer, np.floating)):
            raise WeightsError(f"weight of {s} is not a number: {w!r}")
        w = float(w)
        if not math.isfinite(w):
            raise WeightsError(f"weight of {s} is not finite: {w!r}")
        lo, hi = (0.0, 1.0) if is_spot_leg(s) else (-lev, lev)
        if w < lo - WEIGHT_TOL or w > hi + WEIGHT_TOL:
            what = "a spot leg is long-only and unlevered" if is_spot_leg(s) else f"max_leverage is {lev:g}"
            raise WeightsError(f"weight of {s} is outside [{lo:g}, {hi:g}]: {w!r} ({what})")
        out[s] = min(max(w, lo), hi)
    gross = math.fsum(abs(w) for w in out.values())
    if gross > float(max_gross_exposure) + WEIGHT_TOL:
        raise WeightsError(f"gross exposure {gross!r} exceeds max_gross_exposure {float(max_gross_exposure):g}")
    return out


# ------------------------------------------------------------------------------------------------------- loader

@dataclass
class Strategy:
    """A loaded strategy version. Call it with (data, params=None) to get validated weights."""

    func: Callable
    meta: dict
    sha256: str
    path: Path | None = None
    guard: bool = True
    static_problems: list[str] = field(default_factory=list)

    @property
    def name(self) -> str:
        return self.meta["name"]

    @property
    def kind(self) -> str:
        return self.meta.get("kind", "spot")

    @property
    def universe(self) -> list[str]:
        return list(self.meta["universe"])

    @property
    def generic(self) -> bool:
        """v5: True when META['universe'] == ['*'] (the symbols come from the input)."""
        return is_generic(self.meta)

    def symbols_for(self, symbols=None) -> list[str]:
        """v5: the symbols of a run, see resolve_symbols."""
        return resolve_symbols(self.meta, symbols)

    @property
    def lookback(self) -> int:
        return int(self.meta["lookback"])

    @property
    def params(self) -> dict:
        return dict(self.meta["params"])

    def raw(self, data: dict, params: dict | None = None):
        p = dict(self.meta["params"] if params is None else params)
        if not self.guard:
            return self.func(data, p)
        with purity_guard():
            return self.func(data, p)

    def validate(self, raw, symbols) -> dict[str, float]:
        """Weight validation of this strategy's contract (spot: [0, 1], sum <= 1; perp: signed, leverage caps)."""
        if self.kind == "perp":
            return validate_perp_weights(raw, list(symbols), self.meta["max_leverage"],
                                         self.meta["max_gross_exposure"])
        return validate_weights(raw, list(symbols))

    def __call__(self, data: dict, params: dict | None = None) -> dict[str, float]:
        return self.validate(self.raw(data, params), list(data.keys()))


def load_strategy(directory, expected_sha256: str | None = None, *, strict: bool = True) -> Strategy:
    """Import `strategy.py` from a strategy version directory.

    The file is hashed first; with `expected_sha256` a different hash raises HashMismatch BEFORE any strategy code
    runs. strict=True (default) refuses sources that fail the static purity check.
    """
    directory = Path(directory)
    path = directory / "strategy.py" if directory.is_dir() else directory
    if path.name != "strategy.py" or not path.is_file():
        raise StrategyError(f"no strategy.py in {directory}")
    blob = path.read_bytes()
    digest = hashlib.sha256(blob).hexdigest()
    if expected_sha256 is not None and digest != expected_sha256.strip().lower():
        raise HashMismatch(f"strategy.py sha256 is {digest}, expected {expected_sha256}")
    try:
        source = blob.decode("utf-8")
    except UnicodeDecodeError as e:
        raise StrategyError(f"strategy.py is not UTF-8: {e}") from e
    problems = static_check(source)
    if problems and strict:
        raise StrategyError("strategy.py fails the purity check: " + "; ".join(problems))
    # Executed from the bytes that were hashed (not re-read from disk), without writing bytecode.
    module_name = f"spq_strategy_{digest[:16]}"
    spec = importlib.util.spec_from_loader(module_name, loader=None, origin=str(path))
    module = importlib.util.module_from_spec(spec)
    module.__file__ = str(path)
    try:
        exec(builtins.compile(source, str(path), "exec"), module.__dict__)  # noqa: S102 - this is the loader
    except Exception as e:  # noqa: BLE001
        raise StrategyError(f"strategy.py failed at import: {type(e).__name__}: {e}") from e
    sys.modules.pop(module_name, None)
    if not hasattr(module, "META"):
        raise StrategyError("strategy.py does not define META")
    meta = validate_meta(module.META)
    func = getattr(module, "target_weights", None)
    if not callable(func):
        raise StrategyError("strategy.py does not define target_weights(data, params)")
    return Strategy(func=func, meta=meta, sha256=digest, path=path, static_problems=problems)


def from_function(func: Callable, meta: dict, *, guard: bool = False) -> Strategy:
    """Wrap an in-memory function (tests, benchmarks). Its identity is the hash of its META, not of a file."""
    import json

    validate_meta(meta)
    digest = hashlib.sha256(("inline:" + json.dumps(meta, sort_keys=True)).encode()).hexdigest()
    return Strategy(func=func, meta=meta, sha256=digest, guard=guard)
