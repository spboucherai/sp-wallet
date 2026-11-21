# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : research/src/spq/purity.py
# Description      : Static purity lint of a strategy source (v8).
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

"""Static purity lint of a strategy source (v8). Pure: parses the text (ast), never imports or runs it.

WHAT THIS IS — AND IS NOT. This is a lint for honest mistakes and research hygiene: it keeps a strategy a function of
its inputs (no files, no clock, no randomness, no hidden state) and tells its author, line by line, what is not
accepted. It is NOT a security boundary. Python cannot confine code running in its own interpreter, and a static
check of Python can always be argued with. The security boundary is the OS sandbox every strategy process runs in
(docs/v8/SANDBOX.md: no network, no fork, one readable strategy directory, one scratch directory) and, behind it, the
signer's own limits. The sandbox tests run with this lint switched off.

THE POLICY (strict, and meant to be explainable in one screen):

1. Imports: only the modules listed in MODULE_API, by their exact dotted name, at module level or inside a function.
   `from M import name` only for names M exposes in MODULE_API (or any public name for the "open" numerical modules).
2. A module is used through its own name only: `np.log(x)`, `stats.norm.cdf(x)`. A module object is never stored,
   passed, put in a container or returned, and an attribute chain may not stop on a sub-module (`la = np.linalg`).
3. The first name after a module must be part of its reviewed API (STRICT modules: the standard-library helpers,
   numpy, pandas) or, for the OPEN numerical modules (scipy.*, statsmodels.*, arch, sklearn.*), any public name that
   is not itself the name of a standard-library or toolchain module (`scipy.stats.os` is refused).
4. No dunder anywhere: no `__x__` name, attribute, keyword pattern, function name or string key. No attribute that
   starts with an underscore.
5. A short list of builtins is refused (open, eval, exec, compile, getattr, setattr, type, globals, locals, vars, dir,
   input, …; `print` is tolerated: the runners keep it away from their own output) and a list of attributes whatever the object (clock, files, pickles, frames, string evaluation,
   `.format`).
6. No `class`, no decorator, no `global` / `nonlocal`, no `async`, no `match` class pattern with keywords, no string
   annotation: nothing does work behind the reader's back at import time.

Every refusal is a line number and a sentence. The library strategies pass unchanged (their hashes do not move).
"""
from __future__ import annotations

import ast
import sys

# --- 1 / 3: modules and their reviewed API --------------------------------------------------------------------------
_NUMPY = """
abs absolute add all allclose amax amin any append arange argmax argmin argpartition argsort around array array_equal
asarray atleast_1d atleast_2d average bincount bool_ broadcast_to cbrt ceil clip column_stack concatenate convolve
copysign corrcoef correlate cos cosh count_nonzero cov cross cummax cummin cumprod cumsum deg2rad degrees delete diag
diagonal diff digitize divide dot dstack e einsum empty empty_like equal errstate exp exp2 expand_dims expm1 eye fabs
finfo flatnonzero flip float32 float64 floor floor_divide fmax fmin full full_like gradient greater greater_equal
histogram hstack hypot identity iinfo inf inner insert int32 int64 interp intersect1d isclose isfinite isin isinf isnan
kron less less_equal linspace log log10 log1p log2 logaddexp logical_and logical_not logical_or logical_xor logspace
max maximum mean median meshgrid min minimum mod multiply nan nan_to_num nanargmax nanargmin nancumprod nancumsum
nanmax nanmean nanmedian nanmin nanpercentile nanprod nanquantile nanstd nansum nanvar ndarray ndim negative newaxis
nonzero not_equal ones ones_like outer pad partition percentile pi polyfit polyval power prod ptp quantile rad2deg
radians ravel reciprocal remainder repeat reshape result_type rint roll rot90 round searchsorted select shape sign
signbit sin sinh size sort split sqrt square squeeze stack std subtract sum swapaxes take take_along_axis tan tanh
tensordot tile trace transpose trapezoid tri tril triu true_divide trunc union1d unique unravel_index vander var vdot
vstack where zeros zeros_like
""".split()
_PANDAS = """
DataFrame Series Index DatetimeIndex RangeIndex MultiIndex Timestamp Timedelta DateOffset NA NaT Categorical Interval
concat merge isna isnull notna notnull to_numeric to_datetime to_timedelta date_range timedelta_range cut qcut unique
factorize get_dummies pivot_table crosstab melt
""".split()

#: STRICT modules: exactly these names (dotted entries are sub-modules that may be imported or walked through)
MODULE_API: dict[str, set[str]] = {
    "__future__": {"annotations"},
    "math": {"acos", "acosh", "asin", "asinh", "atan", "atan2", "atanh", "cbrt", "ceil", "comb", "copysign", "cos",
             "cosh", "degrees", "dist", "e", "erf", "erfc", "exp", "exp2", "expm1", "fabs", "factorial", "floor", "fmod",
             "frexp", "fsum", "gamma", "gcd", "hypot", "inf", "isclose", "isfinite", "isinf", "isnan", "isqrt", "lcm",
             "ldexp", "lgamma", "log", "log10", "log1p", "log2", "modf", "nan", "perm", "pi", "pow", "prod", "radians",
             "remainder", "sin", "sinh", "sqrt", "sumprod", "tan", "tanh", "tau", "trunc"},
    "statistics": {"correlation", "covariance", "fmean", "geometric_mean", "harmonic_mean", "linear_regression", "mean",
                   "median", "median_high", "median_low", "mode", "multimode", "pstdev", "pvariance", "quantiles",
                   "stdev", "variance", "NormalDist", "StatisticsError"},
    "itertools": {"accumulate", "batched", "chain", "combinations", "combinations_with_replacement", "compress", "count",
                  "cycle", "dropwhile", "filterfalse", "groupby", "islice", "pairwise", "permutations", "product",
                  "repeat", "starmap", "takewhile", "zip_longest"},
    "functools": {"partial", "reduce"},
    "collections": {"Counter", "OrderedDict", "defaultdict", "deque", "namedtuple"},
    "typing": {"Any", "Callable", "Dict", "Iterable", "List", "Mapping", "Optional", "Sequence", "Tuple", "Union"},
    "warnings": {"catch_warnings", "simplefilter", "filterwarnings"},
    "numpy": set(_NUMPY) | {"linalg", "lib"},
    "numpy.linalg": {"cholesky", "cond", "det", "eig", "eigh", "eigvals", "eigvalsh", "inv", "lstsq", "matrix_rank",
                     "norm", "pinv", "qr", "slogdet", "solve", "svd", "LinAlgError"},
    "numpy.lib": {"stride_tricks"},
    "numpy.lib.stride_tricks": {"sliding_window_view"},
    "pandas": set(_PANDAS),
}
#: OPEN numerical modules: any public name that is not a module name (rule 3). The value lists their sub-modules.
OPEN_MODULES: dict[str, set[str]] = {
    "scipy": {"stats", "optimize", "signal", "special", "linalg", "interpolate", "ndimage"},
    "scipy.stats": set(), "scipy.optimize": set(), "scipy.signal": set(), "scipy.special": set(), "scipy.linalg": set(),
    "scipy.interpolate": set(), "scipy.ndimage": set(),
    "statsmodels": {"api", "tsa", "regression", "robust", "stats"},
    "statsmodels.api": {"tsa", "stats", "robust"}, "statsmodels.tsa": {"api", "stattools", "arima", "holtwinters"},
    "statsmodels.tsa.api": set(), "statsmodels.tsa.stattools": set(), "statsmodels.tsa.arima": {"model"},
    "statsmodels.tsa.arima.model": set(), "statsmodels.tsa.holtwinters": set(),
    "statsmodels.regression": {"linear_model", "rolling"}, "statsmodels.regression.linear_model": set(),
    "statsmodels.regression.rolling": set(), "statsmodels.robust": set(), "statsmodels.stats": set(),
    "arch": {"univariate"}, "arch.univariate": set(),
    "sklearn": {"linear_model", "preprocessing", "covariance", "decomposition", "cluster", "ensemble", "mixture",
                "neighbors", "tree", "svm", "metrics"},
    **{f"sklearn.{m}": set() for m in ("linear_model", "preprocessing", "covariance", "decomposition", "cluster",
                                       "ensemble", "mixture", "neighbors", "tree", "svm", "metrics")},
}
ALLOWED_MODULES = set(MODULE_API) | set(OPEN_MODULES)
#: names that are modules of the standard library or of the toolchain: never an attribute reached through a module
MODULE_NAMES = set(sys.stdlib_module_names) | {
    "numpy", "np", "pandas", "pd", "scipy", "sp", "statsmodels", "sm", "sklearn", "arch", "joblib", "pyarrow", "psycopg",
    "threadpoolctl", "patsy", "pytz", "dateutil", "six", "packaging", "setuptools", "pip", "ctypeslib", "core", "compat",
    "testing", "distutils", "f2py", "common", "externals", "utils", "util", "tools", "misc", "datasets", "io", "lib",
    "char", "rec", "ma", "matlib", "emath", "polynomial", "fft", "random", "version", "conftest", "tests", "sandbox",
}

# --- 5: names and attributes refused whatever the object --------------------------------------------------------------
FORBIDDEN_NAMES = {
    "open", "eval", "exec", "compile", "__import__", "input", "breakpoint", "globals", "locals", "vars", "dir",
    "getattr", "setattr", "delattr", "hasattr", "type", "object", "super", "classmethod", "staticmethod", "property",
    "memoryview", "help", "exit", "quit", "id", "copyright", "credits", "license", "__builtins__",
}
FORBIDDEN_ATTRS = {
    # clock
    "now", "utcnow", "today",
    # files, pickles, sockets, processes
    "read_csv", "read_parquet", "read_json", "read_sql", "read_pickle", "read_excel", "read_table", "read_html",
    "read_feather", "read_hdf", "read_xml", "read_clipboard", "read_fwf", "read_orc", "read_sas", "read_spss",
    "read_stata", "read_sql_query", "read_sql_table", "read_gbq",
    "to_csv", "to_parquet", "to_pickle", "to_json", "to_sql", "to_excel", "to_feather", "to_hdf", "to_clipboard",
    "to_html", "to_latex", "to_markdown", "to_stata", "to_xml", "to_orc", "to_gbq",
    "load", "save", "savez", "savez_compressed", "loadtxt", "savetxt", "genfromtxt", "fromfile", "tofile", "memmap",
    "dump", "dumps", "loads", "system", "popen", "urlopen", "tobytes", "frombuffer", "fromstring",
    # evaluation of strings
    "eval", "query", "format", "format_map", "frompyfunc", "get_type_hints",
    # frames, code objects, object introspection
    "gi_frame", "gi_code", "cr_frame", "cr_code", "ag_frame", "ag_code", "f_back", "f_builtins", "f_globals",
    "f_locals", "f_code", "tb_frame", "tb_next", "co_code", "co_consts", "func_globals", "mro", "modules",
    # native memory
    "ctypes", "ctypeslib", "data_as", "from_address", "from_buffer",
}
_BANNED_STATEMENTS = (ast.ClassDef, ast.Global, ast.Nonlocal, ast.AsyncFunctionDef, ast.AsyncFor, ast.AsyncWith,
                      ast.Await)


def _is_dunder(name: str) -> bool:
    return len(name) > 4 and name.startswith("__") and name.endswith("__")


def _module_ok(name: str) -> bool:
    return name in ALLOWED_MODULES


def _member_problem(module: str, name: str) -> str | None:
    """Why `module.name` is not acceptable (None = fine)."""
    if _is_dunder(name) or name.startswith("_"):
        return f"{module}.{name}: private and dunder names of a module are not part of its API"
    if module in MODULE_API:
        if name not in MODULE_API[module]:
            return f"{module}.{name} is not in the reviewed API of {module} (see spq.purity.MODULE_API)"
        return None
    if name in OPEN_MODULES[module]:
        return None
    if name in MODULE_NAMES:
        return f"{module}.{name} is a module reached through {module}: not allowed"
    return None


def check(source: str) -> list[str]:
    """Return the list of purity problems found in the source (empty list = nothing found)."""
    problems: list[str] = []
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return [f"syntax error: {e}"]

    def bad(node, text: str) -> None:
        problems.append(f"line {getattr(node, 'lineno', '?')}: {text}")

    parents: dict[int, ast.AST] = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[id(child)] = node

    # pass 1 — imports: which local names are modules (name -> dotted module), which were imported as members
    aliases: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if not _module_ok(a.name):
                    bad(node, f"import of {a.name!r} is not allowed")
                elif a.asname:
                    aliases[a.asname] = a.name
                else:  # `import numpy.linalg` binds `numpy`
                    aliases[a.name.split(".")[0]] = a.name.split(".")[0]
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if node.level or not _module_ok(module):
                bad(node, f"import from {node.module!r} is not allowed")
                continue
            for a in node.names:
                if a.name == "*":
                    bad(node, f"from {module} import * is not allowed: name what is used")
                    continue
                why = _member_problem(module, a.name)
                if why:
                    bad(node, why)
                elif f"{module}.{a.name}" in ALLOWED_MODULES:
                    aliases[a.asname or a.name] = f"{module}.{a.name}"

    # pass 2 — everything else
    for node in ast.walk(tree):
        if isinstance(node, _BANNED_STATEMENTS):
            what = {"ClassDef": "class definitions are", "Global": "global state is", "Nonlocal": "nonlocal state is"}
            bad(node, f"{what.get(type(node).__name__, 'async code is')} not allowed in a strategy "
                      "(a strategy is plain functions of its inputs)")
        elif isinstance(node, (ast.FunctionDef, ast.Lambda)):
            if isinstance(node, ast.FunctionDef):
                if _is_dunder(node.name):
                    bad(node, f"a function named {node.name!r} is not allowed")
                if node.decorator_list:
                    bad(node, "decorators are not allowed (they run code at import time)")
            for arg in (*node.args.args, *node.args.kwonlyargs, *node.args.posonlyargs, node.args.vararg, node.args.kwarg):
                if arg is not None and _is_dunder(arg.arg):
                    bad(node, f"a parameter named {arg.arg!r} is not allowed")
        elif isinstance(node, ast.Name):
            if node.id in FORBIDDEN_NAMES or _is_dunder(node.id):
                bad(node, f"use of {node.id!r} is not allowed")
            elif node.id in aliases:
                parent = parents.get(id(node))
                if not (isinstance(parent, ast.Attribute) and parent.value is node) and not isinstance(node.ctx, ast.Store):
                    bad(node, f"the module {node.id!r} may only be used as `{node.id}.name`: a module object is never "
                              "stored, passed or returned")
                elif isinstance(node.ctx, ast.Store):
                    bad(node, f"{node.id!r} is the name of an imported module: it cannot be reassigned")
        elif isinstance(node, ast.Attribute):
            if _is_dunder(node.attr):
                bad(node, f"attribute .{node.attr} is not allowed (no dunder access)")
            elif node.attr.startswith("_"):
                bad(node, f"attribute .{node.attr} is not allowed (private attributes are not part of any API)")
            elif node.attr in FORBIDDEN_ATTRS:
                bad(node, f"attribute .{node.attr} is not allowed")
            parent = parents.get(id(node))
            if isinstance(parent, ast.Attribute) and parent.value is node:
                continue  # an inner link: the outermost attribute of the chain is the one examined below
            chain: list[str] = []
            cur: ast.AST = node
            while isinstance(cur, ast.Attribute):
                chain.append(cur.attr)
                cur = cur.value
            if not (isinstance(cur, ast.Name) and cur.id in aliases):
                continue
            chain.reverse()
            module = aliases[cur.id]
            i = 0
            while i < len(chain):  # walk through sub-modules; stop at the first non-module member
                why = _member_problem(module, chain[i])
                if why:
                    bad(node, why)
                    break
                if f"{module}.{chain[i]}" in ALLOWED_MODULES:
                    module = f"{module}.{chain[i]}"
                    i += 1
                    continue
                break
            else:
                bad(node, f"`{cur.id}.{'.'.join(chain)}` is a module: use one of its functions "
                          "(a module object is never stored, passed or returned)")
        elif isinstance(node, ast.MatchClass):
            for k in node.kwd_attrs:
                if _is_dunder(k) or k.startswith("_") or k in FORBIDDEN_ATTRS:
                    bad(node, f"class pattern reads attribute .{k}: not allowed")
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            if _is_dunder(node.value):
                bad(node, f"the string {node.value!r} names a dunder: not allowed")
        elif isinstance(node, (ast.arg, ast.AnnAssign)):
            ann = node.annotation
            if isinstance(ann, ast.Constant) and isinstance(ann.value, str):
                bad(node, "string annotations are not allowed (they can be evaluated as code)")
        if isinstance(node, ast.FunctionDef) and isinstance(node.returns, ast.Constant) and isinstance(node.returns.value, str):
            bad(node, "string annotations are not allowed (they can be evaluated as code)")
    return sorted(set(problems), key=lambda p: (int(p.split(":")[0].split()[1]) if p.split(":")[0].split()[1].isdigit() else 0, p))
