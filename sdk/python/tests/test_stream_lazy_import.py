"""`import sp_wallet` on a base install: the streaming client is re-exported lazily and `websockets` is needed only to connect."""

from __future__ import annotations

import subprocess
import sys

CODE = """
import sys
sys.modules["websockets"] = None            # a base install: `import websockets` raises ImportError
import sp_wallet
assert "sp_wallet.stream" not in sys.modules, "the stream module must not load with the package"
assert {"SPWalletStream", "OrderBook", "StreamError", "book_checksum", "channel_key", "stream"} <= set(sp_wallet.__all__) <= set(dir(sp_wallet))
from sp_wallet import OrderBook, SPWalletStream, StreamError, book_checksum, channel_key
assert sp_wallet.stream.SPWalletStream is SPWalletStream and "sp_wallet.stream" in sys.modules
assert channel_key({"type": "quote", "id": "hyperliquid:BTC"}) and callable(book_checksum) and not OrderBook().ready
s = SPWalletStream("spw_test_x", base_url="http://127.0.0.1:9")   # building one needs no websockets either
assert issubclass(StreamError, Exception) and s is not None
try:
    sp_wallet.no_such_name
except AttributeError as e:
    assert "no_such_name" in str(e)
else:
    raise AssertionError("an unknown attribute must raise AttributeError")
print("ok")
"""


def test_the_package_imports_without_websockets_and_re_exports_the_stream_client_lazily() -> None:
    out = subprocess.run([sys.executable, "-c", CODE], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0 and out.stdout.strip() == "ok", out.stderr
