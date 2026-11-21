# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : sdk/python/src/sp_wallet/_models_base.py
# Description      : Base classes of the generated models, and the facts about
#                    the HTTP exchange behind a result.
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

"""Base classes of the generated models, and the facts about the HTTP exchange behind a result."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ConfigDict, PrivateAttr


@dataclass(frozen=True)
class RateLimit:
    """`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds) of an answer; None when the header is absent."""

    limit: int | None
    remaining: int | None
    reset_seconds: float | None


@dataclass(frozen=True)
class ResponseMeta:
    """Facts about the HTTP exchange that produced a result (`result.meta`)."""

    status: int
    request_id: str | None
    #: the Idempotency-Key that was sent (mutating calls)
    idempotency_key: str | None
    #: True when the server answered from its idempotency store (`Idempotent-Replay: true`)
    idempotent_replay: bool
    rate_limit: RateLimit
    #: HTTP attempts made (1 = no retry)
    attempts: int


class ApiModel(BaseModel):
    """An answer of the API. Members the contract does not name are kept (`model_extra`): the API may add fields."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)
    _meta: ResponseMeta | None = PrivateAttr(default=None)

    @property
    def meta(self) -> ResponseMeta | None:
        """Status, request id, idempotency key, rate-limit headers and attempts — set on the top-level object of an answer."""
        return self._meta

    def to_dict(self) -> dict[str, Any]:
        """The answer with the API's own member names (camelCase), JSON-compatible except `Decimal` values."""
        return self.model_dump(by_alias=True)


class RequestModel(BaseModel):
    """A request body: validated locally with the constraints of the contract; unknown members are refused."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    def to_body(self) -> dict[str, Any]:
        """The JSON object to send: the API's member names, members left unset are omitted (the server applies its defaults)."""
        return self.model_dump(by_alias=True, exclude_none=True)


class WriteResult(ApiModel):
    """Answer of an operation the server does not implement yet (the strategy and agent writes answer 501): the
    contract declares no success schema for them, so every member would be in `model_extra`. The implemented writes
    return typed models (`models.OrderPreview`, `PlacedOrder`, `CancelledOrder`, `CommandResult`, `KillSwitchResult`)."""
