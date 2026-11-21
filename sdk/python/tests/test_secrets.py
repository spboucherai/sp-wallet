# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : sdk/python/tests/test_secrets.py
# Description      : The API key is never logged, never in a repr, never in an
#                    error — whatever the server or the network says.
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

"""The API key is never logged, never in a repr, never in an error — whatever the server or the network says."""

from __future__ import annotations

import copy
import logging
import pickle
import traceback
from typing import Any

import httpx
import pytest

from conftest import KEY, NET, fail, ok
from sp_wallet import AsyncSPWallet, SPWallet, redact_secrets

TAIL = KEY[-24:]


def _leaks(text: str) -> bool:
    return KEY in text or TAIL in text or KEY[9:40] in text


def test_not_in_repr_str_vars_or_copies(mock: Any) -> None:
    h = mock([ok()])
    c = h.client
    for text in (repr(c), str(c), repr(vars(c)), repr(c.__dict__), f"{c}", repr(c._key), str(c._key), repr(c._http), repr(dict(c._http.headers)), repr(copy.copy(c))):
        assert not _leaks(text), text
    assert "api_key=<redacted>" in repr(c)
    with pytest.raises(TypeError):
        pickle.dumps(c._key)
    for cls in (SPWallet, AsyncSPWallet):
        assert not _leaks(repr(cls(KEY)))


SCRIPTS: list[list[Any]] = [
    [fail(401, "unauthenticated", f"bad key {KEY}")],
    [fail(403, "insufficient_scope", f"Bearer {KEY} lacks a scope", candidates=[KEY], nested={"deep": [f"x {KEY}"]})],
    [{"status": 500, "text": f"<html>{KEY}</html>"}],
    [httpx.ConnectError(f"connect failed for Authorization: Bearer {KEY}")],
    [{"status": 502, "text": f"upstream said {KEY}"}],
    [httpx.ReadTimeout(f"timed out sending {KEY}")],
]


@pytest.mark.parametrize("steps", SCRIPTS, ids=["401", "403", "500-html", "network", "502", "timeout"])
@pytest.mark.parametrize("write", [False, True], ids=["read", "write"])
def test_not_in_an_error_its_traceback_its_causes_or_its_body(mock: Any, steps: list[Any], write: bool) -> None:
    h = mock(steps, max_retries=0)
    if write:
        e = h.error("create_order", instrument="hyperliquid:BTC", side="buy", order_type="market", size="1")
    else:
        e = h.error("get_portfolio")
    seen: list[str] = []
    x: BaseException | None = e
    while x is not None:  # the error, its explicit cause, its implicit context
        seen += [repr(x), str(x), repr(getattr(x, "body", None)), repr(getattr(x, "__dict__", {})), "".join(traceback.format_exception(x))]
        assert not isinstance(x, httpx.HTTPError), "the transport's exception (it references the request and its headers) must not be chained"
        x = x.__cause__ or x.__context__
    for text in seen:
        assert not _leaks(text), text


def test_nothing_is_logged_with_the_key_even_at_debug(mock: Any, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)  # root: httpx, httpcore, asyncio, sp_wallet — everything
    h = mock([fail(503, "venue_unavailable"), NET, ok({"agents": []}), fail(401, "unauthenticated"), fail(501, "execution_not_wired")])
    h.call("list_agents")
    h.error("list_agents")
    h.error("cancel_order", "o1")
    assert len(h.calls) == 5
    for record in caplog.records:
        text = f"{record.getMessage()} {record.args!r} {record.__dict__!r}"
        assert not _leaks(text), text
        assert "authorization" not in text.lower() or "Bearer" not in text
    assert not [r for r in caplog.records if r.name.startswith("sp_wallet")]  # the SDK itself logs nothing


def test_nothing_is_printed(mock: Any, capsys: pytest.CaptureFixture[str]) -> None:
    h = mock([fail(503, "venue_unavailable"), NET, ok({"agents": []}), fail(401, "unauthenticated")])
    h.call("list_agents")
    h.error("list_agents")
    out = capsys.readouterr()
    assert out.out == ""
    assert out.err == ""


def test_redact_secrets() -> None:
    assert redact_secrets(f"Authorization: Bearer {KEY}") == "Authorization: Bearer spw_live_<redacted>"
    assert redact_secrets("Bearer abc.def-ghi") == "Bearer <redacted>"
    assert redact_secrets("x spw_live_spk_abc_def y", "other") == "x spw_live_<redacted> y"
    assert redact_secrets("custom-secret-1 in text", "custom-secret-1") == "spw_live_<redacted> in text"
