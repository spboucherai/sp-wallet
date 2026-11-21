# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : sdk/python/src/sp_wallet/webhooks.py
# Description      : Verification of the webhooks sent by SP Wallet
#                    (services/api/src/alerts/webhook.ts — `webhookSignature`,
#                    `verifyWebhook`).
# Module           : sp_wallet
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

"""Verification of the webhooks sent by SP Wallet (services/api/src/alerts/webhook.ts — `webhookSignature`, `verifyWebhook`).

    X-SPW-Timestamp: <unix seconds>      X-SPW-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>

Verify over the RAW body (the exact bytes received), before any JSON parsing. Delivery is at-least-once: deduplicate on
the event `id`.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any

from .errors import WebhookVerificationError

WEBHOOK_TOLERANCE_SECONDS = 300


def _raw(body: str | bytes) -> bytes:
    return body.encode("utf-8") if isinstance(body, str) else bytes(body)


def webhook_signature(secret: str, timestamp: int, body: str | bytes) -> str:
    """`v1=<hex>` for a timestamp and a raw body — what the server sends."""
    mac = hmac.new(secret.encode("utf-8"), f"{timestamp}.".encode() + _raw(body), hashlib.sha256)
    return f"v1={mac.hexdigest()}"


def verify_webhook(
    *,
    secret: str,
    timestamp: str | int | None,
    signature: str | None,
    body: str | bytes,
    tolerance_seconds: float = WEBHOOK_TOLERANCE_SECONDS,
    now: float | None = None,
) -> bool:
    """True when the signature is the server's for this body and the timestamp is within the tolerance.

    timestamp   header `X-SPW-Timestamp`        signature   header `X-SPW-Signature`
    body        the raw request body            now         current Unix time in seconds (tests)
    The comparison is constant-time (`hmac.compare_digest`).
    """
    if not secret or not isinstance(signature, str) or timestamp is None or isinstance(timestamp, bool):
        return False
    if isinstance(timestamp, int):
        t = timestamp
    else:
        ts = timestamp.strip()
        if not ts or not ts.lstrip("+-").isascii() or not ts.lstrip("+-").isdigit():
            return False
        t = int(ts)
    if abs((time.time() if now is None else now) - t) > tolerance_seconds:
        return False
    return hmac.compare_digest(webhook_signature(secret, t, body).encode("utf-8"), signature.encode("utf-8"))


def construct_webhook_event(
    *,
    secret: str,
    timestamp: str | int | None,
    signature: str | None,
    body: str | bytes,
    tolerance_seconds: float = WEBHOOK_TOLERANCE_SECONDS,
    now: float | None = None,
) -> dict[str, Any]:
    """Verifies, then parses the event `{app, id, event, ts, data}`; raises WebhookVerificationError when the webhook
    is not authentic or not fresh."""
    if not verify_webhook(secret=secret, timestamp=timestamp, signature=signature, body=body, tolerance_seconds=tolerance_seconds, now=now):
        raise WebhookVerificationError("webhook refused: bad signature or timestamp outside the tolerance")
    try:
        event = json.loads(_raw(body))
    except ValueError as e:
        raise WebhookVerificationError("webhook body is not JSON") from e
    if not isinstance(event, dict):
        raise WebhookVerificationError("webhook body is not a JSON object")
    return event
