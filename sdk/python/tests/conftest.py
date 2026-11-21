# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : sdk/python/tests/conftest.py
# Description      : Mocked transport for the unit tests: an
#                    httpx.MockTransport that records every request and answers
#                    from a script.
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

"""Mocked transport for the unit tests: an httpx.MockTransport that records every request and answers from a script.

Every unit test runs against BOTH clients (`kind` = "sync" | "async"): `Harness.call("get_market", "BTC")` calls the
method on SPWallet, or runs the coroutine of AsyncSPWallet.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest

from sp_wallet import AsyncSPWallet, SPWallet

KEY = "spw_live_spk_0123456789ab_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"
ROOT = Path(__file__).resolve().parents[3]
OPENAPI = json.loads((ROOT / "docs" / "openapi" / "trading-v1.json").read_text())
P = "/api/v1/trading"


@dataclass
class Recorded:
    method: str
    url: httpx.URL
    raw_path: str  # as sent on the wire (percent-encoded), without the query
    query: dict[str, str]
    headers: dict[str, str]
    body: bytes | None


Step = Any  # dict(status=…, json=…, text=…, headers=…) | an exception class/instance to raise


def ok(body: Any = None, **headers: str) -> dict[str, Any]:
    return {"status": 200, "json": {} if body is None else body, "headers": headers}


def fail(status: int, error: str, message: str = "refused", headers: dict[str, str] | None = None, **extra: Any) -> dict[str, Any]:
    return {"status": status, "json": {"error": error, "message": message, **extra}, "headers": headers or {}}


NET = httpx.ConnectError("connection refused")
TIMEOUT = httpx.ReadTimeout("timed out")


class Harness:
    def __init__(self, kind: str, steps: list[Step] | Callable[[Recorded, int], Step], **opts: Any) -> None:
        self.kind = kind
        self.calls: list[Recorded] = []
        self.sleeps: list[float] = []
        self._steps = steps

        def answer(request: httpx.Request) -> httpx.Response:
            raw = request.url.raw_path.decode()
            rec = Recorded(
                request.method, request.url, raw.split("?")[0], dict(request.url.params), {k.lower(): v for k, v in request.headers.items()}, request.content or None
            )
            self.calls.append(rec)
            n = len(self.calls) - 1
            step = self._steps(rec, n) if callable(self._steps) else self._steps[min(n, len(self._steps) - 1)]
            if isinstance(step, BaseException):
                raise step
            headers = {"x-request-id": f"req-{n + 1}", **step.get("headers", {})}
            if "text" in step:
                return httpx.Response(step["status"], text=step["text"], headers=headers)
            return httpx.Response(step["status"], json=step.get("json"), headers=headers)

        common: dict[str, Any] = {"base_url": "https://wallet.test", "_random": lambda: 0.5, **opts}
        if kind == "sync":
            self.client: Any = SPWallet(KEY, http_client=httpx.Client(transport=httpx.MockTransport(answer)), _sleep=self.sleeps.append, **common)
        else:

            async def a_answer(request: httpx.Request) -> httpx.Response:
                return answer(request)

            async def a_sleep(s: float) -> None:
                self.sleeps.append(s)

            self.client = AsyncSPWallet(KEY, http_client=httpx.AsyncClient(transport=httpx.MockTransport(a_answer)), _sleep=a_sleep, **common)

    def call(self, name: str, /, *args: Any, **kwargs: Any) -> Any:
        out = getattr(self.client, name)(*args, **kwargs)
        return asyncio.run(_await(out)) if self.kind == "async" else out

    def collect(self, name: str, /, *args: Any, **kwargs: Any) -> list[Any]:
        """Every item of a paginating iterator (`iter_orders`, `iter_activity`), for either client."""
        it = getattr(self.client, name)(*args, **kwargs)
        if self.kind == "sync":
            return list(it)

        async def drain() -> list[Any]:
            return [x async for x in it]

        return asyncio.run(drain())

    def error(self, name: str, /, *args: Any, **kwargs: Any) -> Any:
        try:
            self.call(name, *args, **kwargs)
        except Exception as e:
            return e
        raise AssertionError(f"{name} did not raise")


async def _await(x: Any) -> Any:
    return await x


@pytest.fixture(params=["sync", "async"])
def kind(request: pytest.FixtureRequest) -> str:
    return str(request.param)


@pytest.fixture
def mock(kind: str) -> Callable[..., Harness]:
    def make(steps: list[Step] | Callable[[Recorded, int], Step], **opts: Any) -> Harness:
        return Harness(kind, steps, **opts)

    return make
