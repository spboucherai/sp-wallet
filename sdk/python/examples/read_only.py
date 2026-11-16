"""Read-only tour of the SP Trading API. Needs a key with the read scopes:

    SP_WALLET_API_KEY=spw_live_… [SP_WALLET_BASE_URL=http://localhost:8650] uv run python examples/read_only.py

Nothing here can place an order.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone

from sp_wallet import AmbiguousSymbol, PermissionDenied, ServiceUnavailable, SPWallet, to_decimal


def main() -> None:
    with SPWallet() as client:  # SP_WALLET_API_KEY, SP_WALLET_BASE_URL
        print(f"client: {client!r}")

        def section(name: str, run: Callable[[], str]) -> None:
            try:
                print(f"{name}: {run()}")
            except (PermissionDenied, ServiceUnavailable) as e:
                # a key without the scope, or a venue that cannot be reached, is reported and the tour goes on
                print(f"{name}: {type(e).__name__} ({e.code})")

        def markets() -> str:
            r = client.list_markets(venue="hyperliquid", q="BTC", limit=3)
            rows = ", ".join(f"{m.id} mark={m.mark or 'n/a'} stale={m.stale}" for m in r.markets) or "none"
            return f"{r.total} match, first: {rows}; rate limit {r.meta.rate_limit.remaining}/{r.meta.rate_limit.limit}"

        def orderbook() -> str:
            b = client.get_orderbook("hyperliquid:BTC", depth=1)
            if not b.bids or not b.asks:
                return "empty"
            (bid, bid_size), (ask, _) = b.bids[0], b.asks[0]
            spread = to_decimal(ask) - to_decimal(bid)  # exact: Decimal arithmetic on the API's strings
            return f"best bid {bid} × {bid_size}, best ask {ask}, spread {spread} (prices and sizes are decimal strings)"

        def candles() -> str:
            c = client.get_candles("hyperliquid:BTC", interval="1h", limit=2)
            return ", ".join(f"{datetime.fromtimestamp(k.ts / 1000, tz=timezone.utc):%Y-%m-%dT%H:%MZ} close={k.close}" for k in c.candles) or "none"

        def ambiguous() -> str:
            try:
                client.get_market("BTC")
            except AmbiguousSymbol as e:
                return f'"BTC" is ambiguous, candidates: {", ".join(e.candidates[:4])}…'
            return "not ambiguous"

        def portfolio() -> str:
            p = client.get_portfolio()
            t = p.totals
            figures = f"wallet {t.wallet_usd} USD, live venue equity {t.live_venue_equity}, paper equity {t.paper_equity}"
            return f"{figures} (three separate figures), halted={p.halted}"

        def balances() -> str:
            b = client.get_balances(network="ethereum")
            return f"{len(b.balances)} assets on ethereum, e.g. {', '.join(f'{x.symbol}={x.display}' for x in b.balances[:2])}"

        def risk() -> str:
            r = client.get_risk()
            return f"signer reachable={r.kill_switch.signer_reachable}, halted={r.kill_switch.signer_halted}"

        section("markets", markets)
        section("orderbook", orderbook)
        section("candles", candles)
        section("ambiguous symbol", ambiguous)
        section("portfolio", portfolio)
        section("balances", balances)
        section("positions", lambda: f"{len(client.get_positions().positions)} open")
        section("orders", lambda: f"{len(client.list_orders(limit=5).orders)} recent")
        section("agents", lambda: f"{len(client.list_agents().agents)} agents")
        section("risk", risk)
        print("done")


if __name__ == "__main__":
    main()
