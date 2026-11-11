"""Strategy contract of docs/v3/ARCHITECTURE.md: loading, identity, validation and purity guard.

A strategy version is a directory containing `strategy.py` with

    META = {"name", "version", "universe", "interval", "lookback", "params"}
    def target_weights(data: dict[str, pandas.DataFrame], params: dict) -> dict[str, float]

Its identity is the SHA-256 of the bytes of `strategy.py`.

Purity ("no network, no clock, no files") is enforced in three layers, none of which is a security sandbox:

1. Static check of the source (AST): imports are limited to an allow-list of numerical libraries, and a short list of
   names is refused (open, eval, exec, __import__, .now(), .today(), read_csv, ...).
2. Runtime guard around every call: socket creation, name resolution, builtins.open / io.open / os.open, subprocess,
   time.time & co, the `random` module and the numpy global seedless generators raise `PurityError`.
3. Behavioural checks done by the backtester: the inputs are handed over copy-on-write (mutating them cannot reach the
   engine), and the look-ahead check re-runs the strategy on truncated data and requires identical decisions (this
   proves that the engine leaks no future bar; it cannot see data obtained from outside the inputs).

Known limits: Python cannot confine code running in the same process. C-implemented entry points cannot be patched
(`datetime.datetime.now()` and `pandas.Timestamp.now()` are only caught by the static check), a determined author can
reach the originals through `ctypes`, `gc` or object introspection, and module-level code runs at import time before
the guard is active (it is only covered by the static check). The real protection is the trust-zone design: the
research zone holds no keys, the engine must run the signal process with an OS-level sandbox and a timeout, and the
signer enforces the mandate whatever the strategy says.
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
ALLOWED_IMPORTS = {
    "__future__", "math", "typing", "collections", "itertools", "functools", "dataclasses", "statistics", "warnings",
    "numpy", "pandas", "scipy", "statsmodels", "arch", "sklearn",
}
FORBIDDEN_NAMES = {"open", "eval", "exec", "compile", "__import__", "input", "breakpoint", "globals", "vars",
                   "getattr", "setattr", "delattr", "__builtins__"}
FORBIDDEN_ATTRS = {
    "now", "utcnow", "today", "read_csv", "read_parquet", "read_json", "read_sql", "read_pickle", "read_excel",
    "read_table", "read_html", "to_csv", "to_parquet", "to_pickle", "to_json", "to_sql", "to_excel", "load", "save",
    "savez", "loadtxt", "savetxt", "genfromtxt", "fromfile", "tofile", "memmap", "system", "popen", "urlopen",
    "__globals__", "__builtins__", "__subclasses__", "__code__", "__dict__", "__class__",
}


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
    missing = META_KEYS - meta.keys()
    extra = meta.keys() - META_KEYS
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
    if (not isinstance(u, list) or not u or len(set(u)) != len(u)
            or not all(isinstance(s, str) and s and s == s.upper() for s in u)):
        raise StrategyError("META['universe'] must be a non-empty list of distinct upper-case symbols")
    lb = meta["lookback"]
    if not isinstance(lb, int) or isinstance(lb, bool) or lb < 1:
        raise StrategyError("META['lookback'] must be a positive integer (number of closed bars the strategy needs)")
    if not isinstance(meta["params"], dict) or not all(isinstance(k, str) for k in meta["params"]):
        raise StrategyError("META['params'] must be a dict with string keys")
    try:
        import json

        json.dumps(meta, allow_nan=False)
    except (TypeError, ValueError) as e:
        raise StrategyError(f"META must be JSON-serialisable: {e}") from e
    return meta


def static_check(source: str) -> list[str]:
    """Return the list of purity problems found in the source (empty list = nothing found)."""
    problems: list[str] = []
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return [f"syntax error: {e}"]
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name.split(".")[0] not in ALLOWED_IMPORTS:
                    problems.append(f"line {node.lineno}: import of {a.name!r} is not allowed")
        elif isinstance(node, ast.ImportFrom):
            if node.level or (node.module or "").split(".")[0] not in ALLOWED_IMPORTS:
                problems.append(f"line {node.lineno}: import from {node.module!r} is not allowed")
        elif isinstance(node, ast.Name) and node.id in FORBIDDEN_NAMES:
            problems.append(f"line {node.lineno}: use of {node.id!r} is not allowed")
        elif isinstance(node, ast.Attribute) and node.attr in FORBIDDEN_ATTRS:
            problems.append(f"line {node.lineno}: attribute .{node.attr} is not allowed")
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            problems.append(f"line {node.lineno}: global/nonlocal state is not allowed in a pure function")
    return problems


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
    def universe(self) -> list[str]:
        return list(self.meta["universe"])

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

    def __call__(self, data: dict, params: dict | None = None) -> dict[str, float]:
        return validate_weights(self.raw(data, params), list(data.keys()))


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
