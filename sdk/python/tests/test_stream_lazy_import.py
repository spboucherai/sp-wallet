# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : sdk/python/tests/test_stream_lazy_import.py
# Description      : `import sp_wallet` on a base install: the streaming client
#                    is re-exported lazily and `websockets` is needed only to
#                    connect.
# Module           : sdk
# Repository       : https://git.spboucher.ai/sp-wallet
# Project Website  : https://wallet.spboucher.ai
# Created          : 2026-11-15
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
