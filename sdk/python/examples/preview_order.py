# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : sdk/python/examples/preview_order.py
# Description      : Preview an order, with every outcome handled.
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

"""Preview an order, with every outcome handled. Needs a key with `orders:prepare`, bound to a trading mandate (a key
previews the order it could place).

    SP_WALLET_API_KEY=spw_live_… uv run python examples/preview_order.py

A preview creates, signs and sends nothing. What would refuse the order is in `refusals` — a preview that says "no" is a
normal answer (HTTP 200), not an exception. Placing (`create_order`, see paper_order.py) additionally needs
`orders:execute` AND a key bound to a trading mandate approved by the wallet's owner.
"""

from __future__ import annotations

from sp_wallet import AmbiguousSymbol, MandateRequired, RateLimited, ScopeDenied, ServiceUnavailable, SPWallet, ValidationError


def main() -> None:
    with SPWallet() as client:
        try:
            # `notional` is in the quote currency: the SERVER reads the price and computes the size, rounded down to the lot
            preview = client.preview_order(mode="paper", exchange="hyperliquid", symbol="BTC", side="buy", order_type="market", notional="100")
            limit = preview.meta.rate_limit
            print(f"preview: would execute={preview.would_execute}; rate limit {limit.remaining}/{limit.limit}")
            size = preview.resolved.size if preview.resolved else "?"
            print(f"order: {preview.order.side} {size} {preview.order.instrument} ({preview.order.type}), hash {preview.hash[:16]}…")
            failed = sum(1 for c in preview.risk.checks if not c.ok)
            print(f"approval: {preview.approval.by}; risk engine: {preview.risk.decision} ({len(preview.risk.checks)} checks, {failed} failed)")
            for r in preview.refusals:
                print(f"refusal [{r.stage}] {r.code}: {r.message}")
            # the account's figures are answered only to a key that may read them (wallet:read or positions:read)
            if preview.account.withheld:
                print("account figures: withheld (this key cannot read the account)")
            else:
                print(f"account: equity {preview.account.equity}, free collateral {preview.account.free_collateral}")
        except MandateRequired:
            print("this key is not bound to an owner-approved trading mandate: there is no order it could place, so nothing to preview")
        except ScopeDenied as e:
            print(f"the key lacks a scope: {e}")
        except AmbiguousSymbol as e:
            print(f"name the venue: {', '.join(e.candidates)}")
        except RateLimited as e:
            print(f"rate limited; retry in {e.retry_after} s")
        except ServiceUnavailable as e:
            print(f"a venue or the signer cannot be read now ({e.code}): nothing was done")
        except ValidationError as e:
            print(f"refused request ({e.code}): {e}")
    print("done")


if __name__ == "__main__":
    main()
