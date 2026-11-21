# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : sdk/python/src/sp_wallet/_async_client.py
# Description      : AsyncSPWallet — asynchronous client of the SP Trading API
#                    (docs/openapi/trading-v1.json), on httpx.AsyncClient.
# Module           : sp_wallet
# Repository       : https://git.spboucher.ai/sp-wallet
# Project Website  : https://wallet.spboucher.ai
# Created          : 2026-11-15
# Last Modified    : 2026-11-17
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

"""AsyncSPWallet — asynchronous client of the SP Trading API (docs/openapi/trading-v1.json), on httpx.AsyncClient.

This file is the SOURCE of the synchronous client: `_client.py` is generated from it by scripts/gen_sync.py
(a test fails when the two differ). Edit this file, then run `uv run python scripts/gen_sync.py`.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from decimal import Decimal
from typing import Any, Literal

import httpx

from . import models as m
from ._base import BaseClient, Call, M, Retry, seg
from ._util import decimal_str, is_terminal_order
from .errors import ConfigurationError, ServerError, WaitTimeout

Mode = Literal["paper", "live"]
#: research = analysis and backtests, never an order; paper = explicit simulation; live = a real venue under an owner-approved mandate
AgentMode = Literal["research", "paper", "live"]
Decimalish = Any  # str | int | decimal.Decimal — never a float (refused at call time)


class AsyncSPWallet(BaseClient):
    """Client of the SP Trading API.

        client = AsyncSPWallet(api_key="spw_live_…")            # or SP_WALLET_API_KEY; base URL: SP_WALLET_BASE_URL
        balances = await client.get_balances()

    api_key              `spw_live_…` (default: environment variable SP_WALLET_API_KEY). Never logged, never in a repr or an error.
    base_url             default: SP_WALLET_BASE_URL, else https://wallet.spboucher.ai (http:// is accepted for localhost only)
    timeout              per attempt, seconds (default 30)
    max_retries          retries after the first attempt (default 2)
    user_agent           appended to `sp-wallet-python/<version>`
    http_client          your own httpx.AsyncClient (proxies, TLS settings…); it is not closed by this client
    send_timestamp       send `X-SPW-Timestamp` with mutating calls (the server refuses a call more than 300 s from its clock)
    max_retry_delay      longest wait accepted before a retry, seconds (default 30); a 429 asking for more is raised at once

    Execution (create_order, close/reduce a position, order commands, strategies, agents) needs — besides the scope — a key
    bound to a trading mandate approved by the wallet's owner; otherwise the API refuses it (`MandateRequired`). An order
    outside that mandate is `MandateDenied`; a refusal of the risk engine (or the kill switch) is `RiskDenied`; a live
    order while the server keeps live execution closed is `ExecutionDisabled`. Paper orders are simulated by the wallet.
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float = 30.0,
        max_retries: int = 2,
        user_agent: str | None = None,
        http_client: httpx.AsyncClient | None = None,
        allow_insecure_http: bool = False,
        send_timestamp: bool = False,
        max_retry_delay: float = 30.0,
        _sleep: Callable[[float], Awaitable[None]] | None = None,
        _random: Callable[[], float] | None = None,
    ) -> None:
        super().__init__(
            api_key, base_url=base_url, timeout=timeout, max_retries=max_retries, user_agent=user_agent,
            allow_insecure_http=allow_insecure_http, send_timestamp=send_timestamp, max_retry_delay=max_retry_delay, _random=_random,
        )  # fmt: skip
        self._owns_http = http_client is None
        # no default header carries the key: it is added per request, so the httpx client's repr and state never show it
        self._http = http_client if http_client is not None else httpx.AsyncClient(follow_redirects=False, trust_env=True)
        self._sleep = _sleep if _sleep is not None else asyncio.sleep

    async def aclose(self) -> None:
        """Closes the HTTP connections (not those of an `http_client` you passed)."""
        if self._owns_http:
            await self._http.aclose()

    async def __aenter__(self) -> AsyncSPWallet:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    # ============================================================================================================ markets
    async def list_markets(
        self, *, venue: str | None = None, kind: Literal["perpetual", "spot"] | None = None, q: str | None = None, limit: int | None = None
    ) -> m.MarketList:
        """GET /markets — instruments across venues and the spot market-data symbols. Not paginated: `total` and
        `truncated` tell when `limit` cut the list."""
        return await self._get(m.MarketList, "/markets", {"venue": venue, "kind": kind, "q": q, "limit": limit})

    async def get_market(self, symbol: str) -> m.MarketDetail:
        """GET /markets/{symbol} — `venue:symbol`; a bare symbol that exists on several venues raises AmbiguousSymbol (with `candidates`)."""
        return await self._get(m.MarketDetail, f"/markets/{seg(symbol, 'symbol')}")

    async def get_orderbook(self, symbol: str, *, depth: int | None = None) -> m.Orderbook:
        """GET /markets/{symbol}/orderbook — levels are (price, size) decimal strings."""
        return await self._get(m.Orderbook, f"/markets/{seg(symbol, 'symbol')}/orderbook", {"depth": depth})

    async def get_candles(
        self, symbol: str, *, interval: Literal["1m", "5m", "15m", "1h", "4h", "1d"] | None = None, limit: int | None = None
    ) -> m.Candles:
        """GET /markets/{symbol}/candles — closed bars."""
        return await self._get(m.Candles, f"/markets/{seg(symbol, 'symbol')}/candles", {"interval": interval, "limit": limit})

    async def compare_markets(
        self,
        *,
        underlying: str | None = None,
        side: Literal["long", "short"] | None = None,
        notional: Decimalish = None,
        leverage: Decimalish = None,
        horizon_hours: Decimalish = None,
        liquidity: Literal["taker", "maker"] | None = None,
        min_net_edge_bps: Decimalish = None,
    ) -> m.MarketComparison:
        """GET /markets/compare — the estimated cost of one position on every venue that lists the underlying.
        Estimates, never a recommendation."""
        dec = lambda v, what: None if v is None else decimal_str(v, what)  # noqa: E731
        query = {
            "underlying": underlying, "side": side, "notional": dec(notional, "notional"), "leverage": dec(leverage, "leverage"),
            "horizonHours": dec(horizon_hours, "horizon_hours"), "liquidity": liquidity, "minNetEdgeBps": dec(min_net_edge_bps, "min_net_edge_bps"),
        }  # fmt: skip
        return await self._get(m.MarketComparison, "/markets/compare", query)

    async def list_private_markets(
        self, *, delisted: bool | None = None, size: Decimalish = None, side: Literal["long", "short"] | None = None
    ) -> m.PrivateMarkets:
        """GET /private-markets — synthetic contracts on private companies, venue by venue. Display only: none is tradable."""
        query = {"delisted": delisted, "size": None if size is None else decimal_str(size, "size"), "side": side}
        return await self._get(m.PrivateMarkets, "/private-markets", query)

    async def get_private_market(
        self,
        market_id: str,
        *,
        size: Decimalish = None,
        side: Literal["long", "short"] | None = None,
        interval: Literal["1h", "1d"] | None = None,
        limit: int | None = None,
    ) -> m.PrivateMarketDetail:
        """GET /private-markets/{id} — one contract (`venue:symbol`): definition, valuation breakdown, candles, top of book."""
        query = {"size": None if size is None else decimal_str(size, "size"), "side": side, "interval": interval, "limit": limit}
        return await self._get(m.PrivateMarketDetail, f"/private-markets/{seg(market_id, 'market_id')}", query)

    async def get_private_market_company(
        self,
        slug: str,
        *,
        size: Decimalish = None,
        side: Literal["long", "short"] | None = None,
        interval: Literal["1h", "1d"] | None = None,
        limit: int | None = None,
    ) -> m.PrivateMarketCompanyDetail:
        """GET /private-markets/companies/{slug} — every contract on one company, side by side (never merged)."""
        query = {"size": None if size is None else decimal_str(size, "size"), "side": side, "interval": interval, "limit": limit}
        return await self._get(m.PrivateMarketCompanyDetail, f"/private-markets/companies/{seg(slug, 'slug')}", query)

    # ============================================================================================================ portfolio
    async def get_portfolio(self) -> m.Portfolio:
        """GET /portfolio — wallet value and derivative accounts; paper and live are never added together."""
        return await self._get(m.Portfolio, "/portfolio")

    async def get_balances(self, *, network: str | None = None) -> m.Balances:
        """GET /balances — on-chain balances (`amount`: integer string in the asset's smallest unit; `display`: decimal string)."""
        return await self._get(m.Balances, "/balances", {"network": network})

    async def get_positions(self, *, mode: Mode | None = None, venue: str | None = None) -> m.Positions:
        """GET /positions — open positions, each with its `mode`."""
        return await self._get(m.Positions, "/positions", {"mode": mode, "venue": venue})

    async def get_activity(self, *, limit: int | None = None, cursor: str | None = None) -> m.Activity:
        """GET /activity — one page of wallet activity and fills, newest first; `next_cursor` is the `cursor` of the next page."""
        return await self._get(m.Activity, "/activity", {"limit": limit, "cursor": cursor})

    async def iter_activity(self, *, limit: int | None = None, max_items: int | None = None) -> AsyncIterator[m.ActivityItem]:
        """Every activity item, newest first, page after page (`limit` is the page size; `max_items` stops early)."""
        self._check_max_items(max_items)
        cursor: str | None = None
        n = 0
        while max_items is None or n < max_items:
            page = await self.get_activity(limit=limit, cursor=cursor)
            for item in page.items:
                if max_items is not None and n >= max_items:
                    return
                n += 1
                yield item
            cursor = self._next_cursor(cursor, page.next_cursor)
            if cursor is None:
                return

    # ---------------------------------------------------------------------------------------------------- NFTs (read-only)
    # There is no NFT write in this API: transfers are the owner's (passkey), and no marketplace action exists in this version.
    async def list_nfts(
        self, *, network: str | None = None, collection: str | None = None, status: Literal["in_wallet", "left", "tracked"] | None = None, q: str | None = None,
        sort: Literal["recent", "name"] | None = None, spam: Literal["hide", "show", "only"] | None = None, limit: int | None = None, cursor: str | None = None,
    ) -> m.NftList:
        """GET /nfts — one page of the wallet's NFTs (what the chain confirmed as held). NFTs carry no value:
        `valuation.state` is `unavailable` (never zero, never a floor)."""
        return await self._get(m.NftList, "/nfts", {"network": network, "collection": collection, "status": status, "q": q, "sort": sort, "spam": spam, "limit": limit, "cursor": cursor})

    async def get_nft(self, key: str) -> m.NftDetail:
        """GET /nfts/item — one NFT of the wallet by its `key` (`family:network:asset-id`): on-chain facts, creator metadata and sources, kept apart."""
        return await self._get(m.NftDetail, "/nfts/item", {"key": key})

    async def get_nft_activity(self, key: str, *, limit: int | None = None, cursor: str | None = None, type: str | None = None) -> m.NftActivity:  # noqa: A002
        """GET /nfts/activity — on-chain events of one NFT of the wallet. A transfer is never a sale: `price` is set only
        when a payment of the same transaction was linked by a decoded marketplace event."""
        return await self._get(m.NftActivity, "/nfts/activity", {"key": key, "limit": limit, "cursor": cursor, "type": type})

    async def get_nft_market(self, *, network: str, address: str, token_id: str | None = None) -> m.NftMarket:
        """GET /nfts/market — market data of ANY NFT named by its chain identifiers, ONE ROW PER SOURCE (asking price, best
        offer, last sale, collection floor). A source without its key answers `needs_key`. Amounts are exact base-unit
        strings; `token_id` is a string (it can be as large as 2**256 - 1)."""
        return await self._get(m.NftMarket, "/nfts/market", {"network": network, "address": address, "tokenId": token_id})

    async def get_nft_market_events(
        self, *, network: str, address: str, token_id: str | None = None, provider: str | None = None, type: str | None = None,  # noqa: A002
        after: str | None = None, before: str | None = None, cursor: str | None = None, limit: int | None = None,
    ) -> m.NftMarketEvents:
        """GET /nfts/market/events — sales, listings and offers each market source reports. A `next_cursor` goes back as
        `cursor` together with its `provider`."""
        return await self._get(m.NftMarketEvents, "/nfts/market/events", {"network": network, "address": address, "tokenId": token_id, "provider": provider, "type": type, "after": after, "before": before, "cursor": cursor, "limit": limit})

    async def get_risk(self) -> m.Risk:
        """GET /risk — kill switch, signer limits, capability locks, account policies."""
        return await self._get(m.Risk, "/risk")

    async def engage_kill_switch(self, reason: str | None = None) -> m.KillSwitchResult:
        """POST /risk/kill-switch — blocks every NEW risk, for every principal, venue and mode. Cancels and strictly
        reducing orders still pass. Needs `positions:manage`, no mandate, no Idempotency-Key (engaging a switch that is on
        changes nothing). A key cannot release it: only the owner can, with the passkey."""
        body = self._body(m.KillSwitchRequest, reason=reason if reason is not None else "")
        return await self._safe_post(m.KillSwitchResult, "/risk/kill-switch", body, None)

    # ============================================================================================================ orders
    async def list_orders(
        self, *, mode: Mode | None = None, venue: str | None = None, open: bool | None = None, limit: int | None = None, cursor: str | None = None
    ) -> m.Orders:
        """GET /orders — one page, newest first; `open=True` keeps the orders that are not final; `next_cursor` is the
        `cursor` of the next page."""
        return await self._get(m.Orders, "/orders", {"mode": mode, "venue": venue, "open": open, "limit": limit, "cursor": cursor})

    async def iter_orders(
        self, *, mode: Mode | None = None, venue: str | None = None, open: bool | None = None, limit: int | None = None, max_items: int | None = None
    ) -> AsyncIterator[m.Order]:
        """Every order, newest first, page after page (`limit` is the page size; `max_items` stops early)."""
        self._check_max_items(max_items)
        cursor: str | None = None
        n = 0
        while max_items is None or n < max_items:
            page = await self.list_orders(mode=mode, venue=venue, open=open, limit=limit, cursor=cursor)
            for order in page.orders:
                if max_items is not None and n >= max_items:
                    return
                n += 1
                yield order
            cursor = self._next_cursor(cursor, page.next_cursor)
            if cursor is None:
                return

    async def get_order(self, order_id: str) -> m.OrderDetail:
        """GET /orders/{id} — one order, its fills and its history."""
        return await self._get(m.OrderDetail, f"/orders/{seg(order_id, 'order_id')}")

    async def preview_order(
        self,
        *,
        side: Literal["buy", "sell"],
        order_type: Literal["limit", "market", "stop_market", "stop_limit", "take_profit_market", "take_profit_limit"],
        instrument: str | None = None,
        exchange: str | None = None,
        symbol: str | None = None,
        size: Decimalish = None,
        notional: Decimalish = None,
        notional_usdc: Decimalish = None,
        mode: Mode = "paper",
        price: Decimalish = None,
        trigger_price: Decimalish = None,
        reduce_only: bool | None = None,
        tif: Literal["gtc", "ioc", "alo"] | None = None,
        slippage_bps: int | None = None,
        leverage: Decimalish = None,
        max_fee_usd: Decimalish = None,
        client_order_id: str | None = None,
        account_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> m.OrderPreview:
        """POST /orders/preview — every check the order would meet and an estimate; creates nothing. Scope `orders:prepare`.

        `instrument` is `venue:symbol` (or give `exchange` + `symbol`). Size the order with exactly one of `size` (base
        units) and `notional` (quote currency: the SERVER converts it at the order's own price, else at the mark it
        reads, rounded down to the lot — the answer carries the size used). `notional_usdc` is the same field under the
        name of the quick-start examples. Amounts are decimal strings, `Decimal` or `int`; never a float. `mode` defaults
        to "paper". What would refuse the order is in `refusals` (`would_execute` False), not an exception. Pass
        `idempotency_key` to see the exact order `create_order` with the same key would place.
        """
        body = self._order_body(
            side=side, order_type=order_type, instrument=instrument, exchange=exchange, symbol=symbol, size=size, notional=notional,
            notional_usdc=notional_usdc, mode=mode, price=price, trigger_price=trigger_price, reduce_only=reduce_only, tif=tif,
            slippage_bps=slippage_bps, leverage=leverage, max_fee_usd=max_fee_usd, client_order_id=client_order_id, account_id=account_id,
        )  # fmt: skip
        return await self._safe_post(m.OrderPreview, "/orders/preview", body, idempotency_key)

    async def create_order(
        self,
        *,
        side: Literal["buy", "sell"],
        order_type: Literal["limit", "market", "stop_market", "stop_limit", "take_profit_market", "take_profit_limit"],
        instrument: str | None = None,
        exchange: str | None = None,
        symbol: str | None = None,
        size: Decimalish = None,
        notional: Decimalish = None,
        notional_usdc: Decimalish = None,
        mode: Mode = "paper",
        price: Decimalish = None,
        trigger_price: Decimalish = None,
        reduce_only: bool | None = None,
        tif: Literal["gtc", "ioc", "alo"] | None = None,
        slippage_bps: int | None = None,
        leverage: Decimalish = None,
        max_fee_usd: Decimalish = None,
        client_order_id: str | None = None,
        account_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> m.PlacedOrder:
        """POST /orders — place an order (same arguments as `preview_order`). Scope `orders:execute` AND a key bound to
        an owner-approved trading mandate that covers it (MandateRequired / MandateDenied otherwise). Read
        `result.order.status`: paper orders are usually FILLED at once; a resting order is SUBMITTED; UNKNOWN is not a
        failure. A refusal after the order was created raises with `error.order`. On OutcomeUnknown, re-send with the
        error's `idempotency_key` or read the order: never with a new key."""
        body = self._order_body(
            side=side, order_type=order_type, instrument=instrument, exchange=exchange, symbol=symbol, size=size, notional=notional,
            notional_usdc=notional_usdc, mode=mode, price=price, trigger_price=trigger_price, reduce_only=reduce_only, tif=tif,
            slippage_bps=slippage_bps, leverage=leverage, max_fee_usd=max_fee_usd, client_order_id=client_order_id, account_id=account_id,
        )  # fmt: skip
        return await self._write(m.PlacedOrder, "POST", "/orders", body, idempotency_key)

    async def cancel_order(self, order_id: str, *, idempotency_key: str | None = None) -> m.CancelledOrder:
        """DELETE /orders/{id} — cancel. A key cancels its own orders only; no mandate is needed and the kill switch never stops a cancel."""
        return await self._write(m.CancelledOrder, "DELETE", f"/orders/{seg(order_id, 'order_id')}", None, idempotency_key)

    async def run_command(
        self, text: str, *, mode: Mode = "paper", account_id: str | None = None, dry_run: bool = False, idempotency_key: str | None = None
    ) -> m.CommandResult:  # CommandQuery | CommandControl | CommandDryRun | CommandExecuted
        """POST /commands — one line of the deterministic command grammar (`LONG BTC-PERP 500 x2`, `CLOSE BTC-PERP 50%`,
        `CANCEL ORDER <id>`, `SHOW POSITIONS`, `KILL`). `dry_run=True` answers what it resolves to and does nothing.
        The result is one of four models — `CommandQuery`, `CommandControl`, `CommandDryRun` (its `order` is the canonical
        order) and `CommandExecuted` (its `order` is the placed order): narrow with isinstance. A command the owner's defaults do not settle raises
        AmbiguousCommand (with `questions`): nothing was executed."""
        if not isinstance(text, str) or not text.strip():
            raise ConfigurationError("a command is one non-empty line of text")
        body = self._body(m.CommandRequest, text=text, mode=mode, account_id=account_id, dry_run=dry_run)
        return await self._write(m.CommandResult, "POST", "/commands", body, idempotency_key)

    async def wait_for_order(
        self, order_id: str, *, timeout: float = 60.0, poll_interval: float = 1.0, until: Callable[[m.Order], bool] | None = None
    ) -> m.OrderDetail:
        """Reads the order until it is final — its `status` is FILLED, CANCELLED, REJECTED or FAILED, by the closed enum
        of the contract — or `until(order)` is true. UNKNOWN is not final and not a failure: the wait continues. Raises WaitTimeout — which is not an order
        failure — when `timeout` seconds elapse first; `error.last` is the last answer."""
        done = until if until is not None else is_terminal_order
        started = time.monotonic()
        while True:
            last = await self.get_order(order_id)
            if done(last.order):
                return last
            left = timeout - (time.monotonic() - started)
            if left <= 0:
                raise WaitTimeout(
                    f"order {order_id} is not final after {timeout:g} s (last status: {last.order.status}); it has not failed — keep reading it", last
                )
            await self._sleep(min(poll_interval, left))

    # ============================================================================================================ positions
    async def close_position(self, position_id: str, *, slippage_bps: int | None = None, idempotency_key: str | None = None) -> m.PlacedOrder:
        """POST /positions/{id}/close — a strictly reduce-only market order on the whole position (`id` from
        get_positions). Passes the kill switch."""
        body = self._body(m.ClosePositionRequest, slippage_bps=slippage_bps)
        return await self._write(m.PlacedOrder, "POST", f"/positions/{seg(position_id, 'position_id')}/close", body, idempotency_key)

    async def reduce_position(
        self, position_id: str, *, fraction: Decimalish, slippage_bps: int | None = None, idempotency_key: str | None = None
    ) -> m.PlacedOrder:
        """POST /positions/{id}/reduce — `fraction` in (0, 1]: a decimal string or a Decimal."""
        body = self._body(m.ReducePositionRequest, fraction=decimal_str(fraction, "fraction"), slippage_bps=slippage_bps)
        return await self._write(m.PlacedOrder, "POST", f"/positions/{seg(position_id, 'position_id')}/reduce", body, idempotency_key)

    # ============================================================================================================ strategies
    async def list_strategies(self, *, kind: Literal["spot", "perp"] | None = None) -> m.Strategies:
        """GET /strategies — strategy library and the versions pinned to agents."""
        return await self._get(m.Strategies, "/strategies", {"kind": kind})

    async def create_strategy(self, *, kind: Literal["spot", "perp"], path: str, agent_id: str, idempotency_key: str | None = None) -> m.StrategyResult:
        """POST /strategies — pin a library strategy version (`path`) to ONE agent and queue its backtest. Approves nothing."""
        body = self._body(m.CreateStrategyRequest, kind=kind, path=path, agent_id=agent_id)
        return await self._write(m.StrategyResult, "POST", "/strategies", body, idempotency_key)

    async def backtest_strategy(
        self, strategy_id: str, *, symbols: list[str] | None = None, interval: Literal["1h", "1d"] | None = None, idempotency_key: str | None = None
    ) -> m.JobResult:
        """POST /strategies/{id}/backtest — an asynchronous job: read it with `get_job(result.job.id)` or `wait_for_job`."""
        body = self._body(m.BacktestRequest, symbols=symbols, interval=interval)
        return await self._write(m.JobResult, "POST", f"/strategies/{seg(strategy_id, 'strategy_id')}/backtest", body, idempotency_key)

    async def start_strategy(self, strategy_id: str, *, mode: AgentMode, agent_id: str | None = None, idempotency_key: str | None = None) -> m.AgentResult:
        """POST /strategies/{id}/start — starts the agent the version is pinned to, in `mode`."""
        body = self._body(m.StartRequest, mode=mode, agent_id=agent_id)
        return await self._write(m.AgentResult, "POST", f"/strategies/{seg(strategy_id, 'strategy_id')}/start", body, idempotency_key)

    async def stop_strategy(self, strategy_id: str, *, reason: str | None = None, idempotency_key: str | None = None) -> m.AgentResult:
        """POST /strategies/{id}/stop."""
        body = self._body(m.StopRequest, reason=reason)
        return await self._write(m.AgentResult, "POST", f"/strategies/{seg(strategy_id, 'strategy_id')}/stop", body, idempotency_key)

    # ============================================================================================================ agents
    # Managing agents needs `agents:manage` and NO trading mandate on the key: research and paper sign nothing. Starting an agent
    # LIVE needs a mandate the OWNER approved for that agent with the passkey (409 `mandate_required` otherwise).
    async def list_agents(self) -> m.Agents:
        """GET /agents."""
        return await self._get(m.Agents, "/agents")

    async def list_agent_templates(self) -> m.AgentTemplates:
        """GET /agents/templates — the built-in agents: family, engine, the modes each can run in."""
        return await self._get(m.AgentTemplates, "/agents/templates")

    async def get_agent(self, agent_id: str) -> m.AgentDetail:
        """GET /agents/{id} — one agent: model, strategy, limits, mandate reference, backtest reports (labelled), worker state."""
        return await self._get(m.AgentDetail, f"/agents/{seg(agent_id, 'agent_id')}")

    async def list_agent_signals(self, agent_id: str, *, mode: AgentMode, limit: int | None = None, before: int | None = None) -> m.AgentSignals:
        """GET /agents/{id}/signals — the signal history of one agent in ONE mode (`mode` is required; `before`: unix ms)."""
        query = {"mode": self._agent_mode(mode), "limit": limit, "before": before}
        return await self._get(m.AgentSignals, f"/agents/{seg(agent_id, 'agent_id')}/signals", query)

    async def list_agent_journal(self, agent_id: str, *, mode: AgentMode, limit: int | None = None, before: int | None = None) -> m.AgentJournal:
        """GET /agents/{id}/journal — decisions, orders, fills, errors, risk denials and state changes of one agent in ONE mode."""
        query = {"mode": self._agent_mode(mode), "limit": limit, "before": before}
        return await self._get(m.AgentJournal, f"/agents/{seg(agent_id, 'agent_id')}/journal", query)

    async def list_agent_orders(
        self, agent_id: str, *, mode: AgentMode, limit: int | None = None, before: int | None = None, open: bool | None = None
    ) -> m.AgentOrders:
        """GET /agents/{id}/orders — the orders of one agent in ONE mode, in the unified order states."""
        query = {"mode": self._agent_mode(mode), "limit": limit, "before": before, "open": open}
        return await self._get(m.AgentOrders, f"/agents/{seg(agent_id, 'agent_id')}/orders", query)

    async def get_agent_performance(self, agent_id: str, *, mode: AgentMode) -> m.AgentPerformance:
        """GET /agents/{id}/performance — computed from the records of ONE mode; paper and live are never added; a backtest is never here."""
        return await self._get(m.AgentPerformance, f"/agents/{seg(agent_id, 'agent_id')}/performance", {"mode": self._agent_mode(mode)})

    async def get_job(self, job_id: str) -> m.JobResult:
        """GET /jobs/{id} — one agent job (a backtest, a wind-down): status and result."""
        return await self._get(m.JobResult, f"/jobs/{seg(job_id, 'job_id')}")

    async def wait_for_job(self, job_id: str, *, timeout: float = 60.0, poll_interval: float = 1.0) -> m.JobResult:
        """Reads a job until it is `done`, `failed` or `cancelled`. Raises WaitTimeout — which is not a job failure — when
        `timeout` seconds elapse first; `error.last` is the last answer."""
        started = time.monotonic()
        while True:
            last = await self.get_job(job_id)
            if last.job.status in ("done", "failed", "cancelled"):
                return last
            left = timeout - (time.monotonic() - started)
            if left <= 0:
                raise WaitTimeout(f"job {job_id} is not finished after {timeout:g} s (status: {last.job.status}); it has not failed — keep reading it", last)
            await self._sleep(min(poll_interval, left))

    async def create_agent(
        self,
        *,
        name: str,
        template: str | None = None,
        kind: Literal["spot", "perp"] | None = None,
        universe: list[str] | None = None,
        venues: list[str] | None = None,
        mission: str | None = None,
        strategy_path: str | None = None,
        interval: Literal["1h", "4h", "1d"] | None = None,
        capital_usdc: Decimalish = None,
        risk: dict[str, Any] | None = None,
        config: dict[str, Any] | None = None,
        mode: Literal["research", "paper"] | None = None,
        idempotency_key: str | None = None,
    ) -> m.AgentResult:
        """POST /agents — from a `template` (see `list_agent_templates`), or a perp agent (`kind="perp"` + `universe`).
        `mode` is "research" (default: created, not running) or "paper"; never live. Nothing is signed."""
        body = self._body(
            m.CreateAgentRequest, name=name, template=template, kind=kind, universe=universe, venues=venues, mission=mission, strategy_path=strategy_path,
            interval=interval, capital_usdc=None if capital_usdc is None else decimal_str(capital_usdc, "capital_usdc"), risk=risk, config=config, mode=mode,
        )  # fmt: skip
        if risk is not None:
            body["risk"] = self._limits(risk)
        return await self._write(m.AgentResult, "POST", "/agents", body, idempotency_key)

    async def start_agent(self, agent_id: str, *, mode: AgentMode, idempotency_key: str | None = None) -> m.AgentResult:
        """POST /agents/{id}/start — `mode`: "research", "paper" or "live" (live only under an owner-approved mandate for this agent)."""
        body = self._body(m.StartRequest, mode=mode)
        return await self._write(m.AgentResult, "POST", f"/agents/{seg(agent_id, 'agent_id')}/start", body, idempotency_key)

    async def pause_agent(self, agent_id: str, *, reason: str | None = None, idempotency_key: str | None = None) -> m.AgentResult:
        """POST /agents/{id}/pause — no new exposure."""
        body = self._body(m.StopRequest, reason=reason)
        return await self._write(m.AgentResult, "POST", f"/agents/{seg(agent_id, 'agent_id')}/pause", body, idempotency_key)

    async def stop_agent(self, agent_id: str, *, reason: str | None = None, idempotency_key: str | None = None) -> m.AgentResult:
        """POST /agents/{id}/stop — always allowed; the safe wind-down."""
        body = self._body(m.StopRequest, reason=reason)
        return await self._write(m.AgentResult, "POST", f"/agents/{seg(agent_id, 'agent_id')}/stop", body, idempotency_key)

    async def backtest_agent(
        self, agent_id: str, *, version_id: str | None = None, hours: int | None = None, idempotency_key: str | None = None
    ) -> m.JobResult:
        """POST /agents/{id}/backtest — an asynchronous job (always a BACKTEST, labelled as such): read it with `get_job` / `wait_for_job`."""
        body = self._body(m.AgentBacktestRequest, version_id=version_id, hours=hours)
        return await self._write(m.JobResult, "POST", f"/agents/{seg(agent_id, 'agent_id')}/backtest", body, idempotency_key)

    # ============================================================================================================ meta
    async def openapi(self) -> m.OpenApiDocument:
        """GET /openapi.json — the OpenAPI 3.1 document served by the wallet (`.to_dict()` for the plain document)."""
        return await self._get(m.OpenApiDocument, "/openapi.json")

    # ============================================================================================================ internals
    def _order_body(
        self,
        *,
        side: str,
        order_type: str,
        mode: str,
        reduce_only: Any,
        tif: Any,
        slippage_bps: Any,
        leverage: Any,
        max_fee_usd: Any,
        client_order_id: Any,
        account_id: Any,
        **sizing: Any,
    ) -> dict[str, Any]:
        # a notional travels as it is: the server reads the price and computes the size
        instrument, size, notional, price, trigger = self._order_fields(**sizing)
        return self._body(
            m.OrderRequest, mode=mode, account_id=account_id, instrument=instrument, side=side, type=order_type, size=size, notional=notional,
            price=price, trigger_price=trigger, reduce_only=reduce_only, tif=tif, slippage_bps=slippage_bps,
            leverage=None if leverage is None else decimal_str(leverage, "leverage"),
            max_fee_usd=None if max_fee_usd is None else decimal_str(max_fee_usd, "max_fee_usd"), client_order_id=client_order_id,
        )  # fmt: skip

    @staticmethod
    def _limits(risk: dict[str, Any]) -> dict[str, Any]:
        """An agent's limits are JSON numbers, strings or booleans (not amounts of money): whole numbers go as numbers, anything
        fractional as a decimal string — never a binary float."""
        out: dict[str, Any] = {}
        for k, v in risk.items():
            if isinstance(v, (bool, str, int)):
                out[k] = v
            elif isinstance(v, Decimal) and v.is_finite():
                out[k] = int(v) if v == v.to_integral_value() else format(v, "f")
            else:
                raise ConfigurationError(f"risk.{k}: pass an int, a bool, a Decimal or a decimal string — not a float")
        return out

    @staticmethod
    def _agent_mode(mode: Any) -> str:
        """The per-agent reads are ONE mode per call: required here, although the API would fall back on the agent's current one."""
        if mode not in ("research", "paper", "live"):
            raise ConfigurationError('`mode` is required: "research", "paper" or "live" — one mode per call, an answer never mixes two')
        return str(mode)

    @staticmethod
    def _check_max_items(max_items: int | None) -> None:
        if max_items is not None and (isinstance(max_items, bool) or not isinstance(max_items, int) or max_items < 0):
            raise ConfigurationError("max_items must be a non-negative integer")

    @staticmethod
    def _next_cursor(current: str | None, following: str | None) -> str | None:
        if following is not None and following == current:
            raise ServerError("the server returned the cursor it was given: the list would never end", code="invalid_response", status=200)
        return following

    async def _get(self, model: type[M], path: str, query: Mapping[str, Any] | None = None) -> M:
        call = self._prepare("GET", path, query, None, None)
        data, meta = await self._send(call)
        return self._parse(model, data, meta, call)

    async def _write(self, model: type[M], method: str, path: str, body: Any, idempotency_key: str | None) -> M:
        call = self._prepare(method, path, None, body, idempotency_key, "write")
        data, meta = await self._send(call)
        return self._parse(model, data, meta, call)

    async def _safe_post(self, model: type[M], path: str, body: Any, idempotency_key: str | None) -> M:
        """A POST the contract declares without an Idempotency-Key: retried and reported like a read."""
        call = self._prepare("POST", path, None, body, idempotency_key, "safe")
        data, meta = await self._send(call)
        return self._parse(model, data, meta, call)

    async def _send(self, call: Call) -> tuple[Any, Any]:
        attempt = 0
        while True:
            failure: Exception | None = None
            response: httpx.Response | None = None
            try:
                response = await self._http.request(
                    call.method, call.url, params=call.params or None, content=call.content, headers=self._headers(call), timeout=call.timeout
                )
            except httpx.HTTPError as exc:
                failure = exc
            # decided OUTSIDE the except block: the transport's exception (which references the request and its
            # Authorization header) must not become the context of what this SDK raises
            if response is None:
                assert failure is not None
                outcome: Any = self._transport_failed(call, attempt, failure)
            else:
                outcome = self._answered(call, attempt, response.status_code, response.headers, response.text)
            if isinstance(outcome, Retry):
                await self._sleep(outcome.delay)
                attempt += 1
                continue
            return outcome  # type: ignore[no-any-return]
