# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : sdk/python/examples/stream_quotes.py
# Description      : Live quotes over the wallet's websocket, with
#                    reconnection.
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

"""Live quotes over the wallet's websocket, with reconnection. Read-only: nothing here places, signs or cancels anything.

    pip install "sp-wallet-python[stream]"        # the optional dependency `websockets`
    SP_WALLET_API_KEY=spw_live_… [SP_WALLET_BASE_URL=http://localhost:8650] uv run --extra stream python examples/stream_quotes.py

The key needs the scope `markets:read`; it travels in the Authorization header of the handshake, never in the URL.
SP_WALLET_STREAM_QUOTES (default 5): how many quotes to print before the example stops; it also stops after 20 s.
"""

from __future__ import annotations

import asyncio
import os

from sp_wallet import SPWalletStream, StreamError
from sp_wallet.stream import Quote


async def main() -> None:
    wanted = int(os.environ.get("SP_WALLET_STREAM_QUOTES", "5"))
    stream = SPWalletStream(base_url=os.environ.get("SP_WALLET_BASE_URL", "https://wallet.spboucher.ai"))  # the key: SP_WALLET_API_KEY
    stream.on("open", lambda hello: print(f"connected: connection {hello['connId'][:8]}…, heartbeat every {hello['heartbeatMs']} ms"))
    # the client reconnects by itself (exponential backoff with jitter) and subscribes again; the server then sends fresh snapshots
    stream.on("close", lambda c: print(f"connection closed; {'reconnecting' if c.get('will_reconnect') else 'not reconnecting'}"))
    stream.on("error", lambda e: print(f"stream error: {e.code}"))

    async def read() -> None:
        await stream.subscribe([{"type": "status", "id": "hyperliquid"}, {"type": "quote", "id": "hyperliquid:BTC"}])
        n = 0
        async for m in stream:  # every data message, in order; ends when the stream is closed
            if not isinstance(m, Quote):
                continue
            # prices and sizes are decimal STRINGS; `stale` says the quote is older than its freshness bound
            print(f"quote {m.id}: bid {m.bid or 'n/a'} ask {m.ask or 'n/a'} mark {m.mark or 'n/a'}{' (stale)' if m.stale else ''}")
            n += 1
            if n >= wanted:
                return

    try:
        await asyncio.wait_for(read(), timeout=20)
    except asyncio.TimeoutError:
        print("no more quotes within 20 s (the venue may be unreachable)")
    except StreamError as e:
        # a refusal that a retry cannot fix (a key without markets:read, a revoked key, an unknown instrument)
        print(f"refused: {e.code}")
    finally:
        await stream.close()
    print("done")


if __name__ == "__main__":
    asyncio.run(main())
