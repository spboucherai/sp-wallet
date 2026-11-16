"""The asynchronous client: several reads at once.

    SP_WALLET_API_KEY=spw_live_… [SP_WALLET_BASE_URL=http://localhost:8650] uv run python examples/async_read.py
"""

from __future__ import annotations

import asyncio

from sp_wallet import AsyncSPWallet


async def main() -> None:
    async with AsyncSPWallet() as client:
        agents, risk, orders = await asyncio.gather(client.list_agents(), client.get_risk(), client.list_orders(limit=5))
        print(f"agents: {len(agents.agents)}; orders: {len(orders.orders)}; signer halted: {risk.kill_switch.signer_halted}")
        print("done")


if __name__ == "__main__":
    asyncio.run(main())
