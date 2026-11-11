"""Guard-evasion patterns tried against the purity lint (v8). Each is the BODY of a strategy.py that reaches something the
contract forbids (a file, the process environment, another module's globals, code built from a string) WITHOUT any of the
names the pre-v8 static check looked for. Every one of them passed that check; every one must now be refused.

`reaches` says what the snippet gets hold of; tests/test_purity_hardening.py checks (a) the lint refuses it, and (b) for the
ones marked `demo`, that the pre-v8 check really let it through and that it really works when executed (so the list is not
a list of imaginary problems).
"""

HEADER = '''META = {"name": "evasion", "version": "1", "universe": ["ETH", "BTC"], "interval": "1h", "lookback": 10, "params": {}}
'''

EVASIONS = {
    # --- modules reached through the allow-listed ones --------------------------------------------------------------
    "from_typing_import_sys": dict(reaches="sys.modules → os", demo=True, body='''
from typing import sys
LEAK = sys.modules["os"].getcwd()
def target_weights(data, params):
    return {}
'''),
    "pandas_io_common_os": dict(reaches="os through pandas internals", demo=True, body='''
import pandas as pd
LEAK = pd.io.common.os.getcwd()
def target_weights(data, params):
    return {}
'''),
    "numpy_ctypeslib": dict(reaches="ctypes (arbitrary native calls)", demo=True, body='''
import numpy as np
LEAK = np.ctypeslib.ctypes.CDLL(None)["getpid"]()
def target_weights(data, params):
    return {}
'''),
    "import_submodule_alias": dict(reaches="ctypes via `import numpy.ctypeslib as c`", demo=False, body='''
import numpy.ctypeslib as c
LEAK = c.ctypes
def target_weights(data, params):
    return {}
'''),
    "dataclasses_sys": dict(reaches="sys.modules through dataclasses", demo=True, body='''
import dataclasses
LEAK = dataclasses.sys.modules["os"].getcwd()
def target_weights(data, params):
    return {}
'''),
    "warnings_sys_modules_posix": dict(reaches="posix.open under the runtime guard", demo=True, body='''
import warnings
LEAK = None
def target_weights(data, params):
    posix = warnings.sys.modules["posix"]
    fd = posix.open(warnings.sys.executable, posix.O_RDONLY)
    posix.close(fd)
    return {"ETH": 0.25}
'''),
    # --- frames and builtins without a single dunder ----------------------------------------------------------------
    "generator_frame_builtins": dict(reaches="f_builtins → __import__", demo=True, body='''
LEAK = (x for x in ()).gi_frame.f_builtins["__import__"]("os").getcwd()
def target_weights(data, params):
    return {}
'''),
    "locals_builtins": dict(reaches="__builtins__ through locals()", demo=True, body='''
LEAK = locals()["__builtins__"]["__import__"]("os").getcwd()
def target_weights(data, params):
    return {}
'''),
    "traceback_frame": dict(reaches="tb_frame.f_globals", demo=False, body='''
def target_weights(data, params):
    try:
        1 / 0
    except ZeroDivisionError as e:
        g = e.__traceback__.tb_frame.f_back.f_globals
    return {}
'''),
    # --- dunder access the attribute check did not see ---------------------------------------------------------------
    "match_class_pattern": dict(reaches="__globals__ through a class pattern", demo=True, body='''
def _f():
    pass
match _f:
    case object(__globals__=g):
        LEAK = g["__builtins__"]["__import__"]("os").getcwd()
def target_weights(data, params):
    return {}
'''),
    "mro_subclasses_by_type": dict(reaches="object.__subclasses__ via type()", demo=False, body='''
LEAK = type(()).__mro__[1]
def target_weights(data, params):
    return {}
'''),
    "format_string_attribute": dict(reaches="attribute walk inside str.format", demo=True, body='''
def _f():
    pass
LEAK = "{0.__code__.co_filename}".format(_f)
def target_weights(data, params):
    return {}
'''),
    # --- code evaluated from strings ---------------------------------------------------------------------------------
    "typing_get_type_hints": dict(reaches="eval of a string annotation", demo=False, body='''
import typing
class A:
    x: "__import__('os').getcwd()"
LEAK = typing.get_type_hints(A)["x"]
def target_weights(data, params):
    return {}
'''),
    "functools_singledispatch": dict(reaches="eval of a string annotation at registration", demo=False, body='''
import functools
@functools.singledispatch
def f(x):
    return 0
@f.register
def g(x: "__import__('os').getcwd()"):
    return 1
def target_weights(data, params):
    return {}
'''),
    "pandas_eval": dict(reaches="pandas' expression evaluator with @variables", demo=True, body='''
import pandas as pd
import typing
m = typing.sys.modules["os"]
LEAK = pd.eval("m.getcwd()", engine="python", local_dict={"m": m})
def target_weights(data, params):
    return {}
'''),
    "numpy_load_pickle": dict(reaches="pickle through numpy", demo=False, body='''
import numpy as np
def target_weights(data, params):
    return {"ETH": float(np.lib.npyio.NpzFile)}
'''),
    # --- work at import, class machinery -----------------------------------------------------------------------------
    "decorator_and_metaclass": dict(reaches="arbitrary work at import through a metaclass", demo=False, body='''
class M(type):
    def __getattr__(cls, name):
        return name
class K(metaclass=M):
    pass
LEAK = K.anything
def target_weights(data, params):
    return {}
'''),
    "module_alias_escape": dict(reaches="a module object stored and used later", demo=False, body='''
import numpy as np
box = [np]
LEAK = box[0].ctypeslib
def target_weights(data, params):
    return {}
'''),
    "getattr_computed_via_operator": dict(reaches="computed attribute name", demo=False, body='''
import functools
get = functools.reduce
def target_weights(data, params):
    x = type(data).mro
    return {}
'''),
}
