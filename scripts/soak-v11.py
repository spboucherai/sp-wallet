"""V11 soak — PAPER only, on the local stack of the SDK tests (packages/trading-sdk/scripts/test-stack.mts: the real API and
the real signer from dist/, an own database, a software passkey, API keys bound to paper mandates). Nothing is signed for a
venue, nothing is sent anywhere; the only network activity is public market data (the venue feeds the API reads).

    cd sdk/python && SPW_SOAK_MINUTES=30 uv run --extra stream python ../../scripts/soak-v11.py <output directory>

What runs, for SPW_SOAK_MINUTES (default 30):
  - a bar perp agent created from the Momentum template on momentum_xs_perp/2 (BTC, ETH, SOL): backtest through the job
    queue, then PAPER;
  - a market-making agent from its template on BTC, in PAPER (one session);
  - one websocket client of the quote stream (Python SDK), subscribed to BTC quotes of Hyperliquid and to the venue status;
  - every 30 s, through the Python SDK and a key bound to a paper mandate: a resting limit order far under the market,
    cancelled 10 s later, and every fourth round a small market order.
Sampled once a minute into <dir>/samples.jsonl: RSS and CPU time of the API process, its open file descriptors, the database
connections of the stack, the row counts of the tables that grow, the latency of GET /health/live (a proxy for the event
loop: 20 calls, 250 ms apart), the stream client's counters and the server's own stream statistics.
At the end: <dir>/summary.json, and the API log is scanned for error lines. The database is KEPT (SPW_STACK_KEEP=1); the
summary names it — drop it when done.
"""

from __future__ import annotations

import asyncio
import json
import os
import statistics
import subprocess
import sys
import time
import urllib.request
import uuid
from decimal import ROUND_DOWN, Decimal
from pathlib import Path

from sp_wallet import AsyncSPWallet, SPWalletError, SPWalletStream
from sp_wallet.stream import Quote

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/spw-soak").resolve()
MINUTES = float(os.environ.get("SPW_SOAK_MINUTES", "30"))
TABLES = ["orders", "order_events", "risk_decisions", "order_projection_queue", "market_snapshots", "market_snapshot_gaps", "mm_tape", "mm_sessions", "mm_fills", "api_key_usage",
          "api_idempotency", "agent_signals", "agent_order_intents", "agent_jobs", "research_log", "agent_equity", "deriv_orders", "deriv_fills", "deriv_equity", "audit_events", "candles", "agent_leases", "trading_mandates"]  # fmt: skip


def sh(*a: str) -> str:
    return subprocess.run(a, capture_output=True, text=True).stdout.strip()


def psql(db: str, q: str) -> str:
    return sh("psql", "-At", "-d", db, "-c", q)


def owner(control: str, path: str) -> dict:
    with urllib.request.urlopen(f"{control}/owner?path={urllib.request.quote(path, safe='')}", timeout=20) as r:
        return json.loads(r.read())


def sample_process(pid: int) -> dict:
    rss, cpu = (sh("ps", "-o", "rss=,time=", "-p", str(pid)).split() + ["0", "0"])[:2]
    return {"rssMb": round(int(rss) / 1024, 1), "cpuTime": cpu, "fds": len(sh("lsof", "-p", str(pid)).splitlines()) - 1}


async def health_latency(base: str) -> dict:
    ms: list[float] = []
    for _ in range(20):
        t0 = time.perf_counter()
        await asyncio.to_thread(lambda: urllib.request.urlopen(f"{base}/api/v1/health/live", timeout=20).read())
        ms.append((time.perf_counter() - t0) * 1000)
        await asyncio.sleep(0.25)
    ms.sort()
    return {"p50": round(statistics.median(ms), 1), "p95": round(ms[18], 1), "max": round(ms[-1], 1)}


async def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    api_log = OUT / "api.log"
    api_log.write_text("")
    env = {**os.environ, "SPW_STACK_KEEP": "1", "SPW_STACK_API_LOG": str(api_log), "SPW_MM_MIN_PAPER_MINUTES": "1"}
    stack = subprocess.Popen([str(ROOT / "node_modules/.bin/tsx"), str(ROOT / "packages/trading-sdk/scripts/test-stack.mts"), "soak"], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
    info = json.loads(await asyncio.to_thread(stack.stdout.readline))
    if not info.get("ok"):
        raise SystemExit(f"the stack did not start: {info}")
    base, control, key, db = info["baseUrl"], info["control"], info["keys"]["trader"]["secret"], info["kept"]["database"].rsplit("/", 1)[-1]
    pid = int(info["kept"]["apiPid"])
    account = info["paper"]["accountId"]  # the key's own paper account (the agents get accounts of their own: the venue then has several)
    notes: list[str] = [f"stack {base}, database {db}, API pid {pid}, started {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}"]
    print(notes[0], flush=True)
    counters = {"quotes": 0, "status": 0, "streamErrors": 0, "streamCloses": 0, "ordersPlaced": 0, "ordersCancelled": 0, "marketOrders": 0, "orderErrors": 0}
    errors: list[str] = []
    samples = (OUT / "samples.jsonl").open("w")

    async with AsyncSPWallet(api_key=key, base_url=base) as w:
        # ---- the two agents
        momentum = await w.create_agent(name="Soak momentum", template="momentum", strategy_path="momentum_xs_perp/2", capital_usdc="10000")
        aid = momentum.agent.id
        job = await w.backtest_agent(aid)
        done = await w.wait_for_job(job.job.id, timeout=900, poll_interval=5)
        notes.append(f"momentum agent {aid[:8]}: backtest job {done.job.status}")
        try:
            started = await w.start_agent(aid, mode="paper")
            notes.append(f"momentum agent: paper start → state {started.agent.state} mode {started.agent.mode}")
        except SPWalletError as e:
            notes.append(f"momentum agent: paper start REFUSED {e.code}: {e}")
        try:
            mm = await w.create_agent(name="Soak market making", template="market-making", universe=["BTC"], capital_usdc="2000")
            mid = mm.agent.id
            s2 = await w.start_agent(mid, mode="paper")
            notes.append(f"market-making agent {mid[:8]}: paper start → state {s2.agent.state} mode {s2.agent.mode}")
        except SPWalletError as e:
            mid = ""
            notes.append(f"market-making agent: REFUSED {e.code}: {e}")
        print("\n".join(notes[1:]), flush=True)

        # ---- the stream client
        stream = SPWalletStream(api_key=key, base_url=base)
        stream.on("error", lambda e: (counters.__setitem__("streamErrors", counters["streamErrors"] + 1), errors.append(f"stream error {getattr(e, 'code', e)}")))
        stream.on("close", lambda c: counters.__setitem__("streamCloses", counters["streamCloses"] + 1))

        async def read_stream() -> None:
            await stream.subscribe([{"type": "status", "id": "hyperliquid"}, {"type": "quote", "id": "hyperliquid:BTC"}, {"type": "quote", "id": "spot:BTC"}])
            async for msg in stream:
                counters["quotes" if isinstance(msg, Quote) else "status"] += 1

        reader = asyncio.create_task(read_stream())

        # ---- the order loop
        async def orders() -> None:
            k = 0
            while True:
                k += 1
                try:
                    mk = await w.get_market("hyperliquid:BTC")
                    mark = Decimal(str(mk.ticker.mark))
                    px = (mark * Decimal("0.985")).quantize(Decimal("1"), rounding=ROUND_DOWN)
                    o = await w.create_order(side="buy", order_type="limit", instrument="hyperliquid:BTC", size="0.001", price=str(px), mode="paper", account_id=account, client_order_id=f"soak-{uuid.uuid4().hex[:20]}")
                    counters["ordersPlaced"] += 1
                    await asyncio.sleep(10)
                    await w.cancel_order(o.order.id)
                    counters["ordersCancelled"] += 1
                    if k % 4 == 0:
                        side = "buy" if (k // 4) % 2 else "sell"
                        await w.create_order(side=side, order_type="market", instrument="hyperliquid:BTC", size="0.001", mode="paper", account_id=account, slippage_bps=100, client_order_id=f"soak-{uuid.uuid4().hex[:20]}")
                        counters["marketOrders"] += 1
                except Exception as e:  # noqa: BLE001 — a soak records every failure and goes on
                    counters["orderErrors"] += 1
                    errors.append(f"order loop: {type(e).__name__} {getattr(e, 'code', '')}: {str(e)[:200]}")
                await asyncio.sleep(20)

        trader = asyncio.create_task(orders())

        # ---- sampling
        t0 = time.time()
        first: dict | None = None
        last: dict = {}
        while True:
            row: dict = {"t": round(time.time() - t0), "at": time.strftime("%H:%M:%SZ", time.gmtime()), **sample_process(pid)}
            row["dbConnections"] = int(psql(db, f"select count(*) from pg_stat_activity where datname = '{db}' and pid <> pg_backend_pid()") or 0)
            row["tables"] = {t: int(psql(db, f"select count(*) from {t}") or -1) for t in TABLES}
            row["health"] = await health_latency(base)
            row["client"] = dict(counters)
            try:
                st = owner(control, "/api/v1/stream/stats")
                row["stream"] = {k: st.get(k) for k in ("connections", "subscriptions", "messages", "backpressure", "upstream", "reconnects", "gaps") if k in st} or st
            except Exception as e:  # noqa: BLE001
                row["stream"] = {"error": str(e)[:120]}
            samples.write(json.dumps(row) + "\n")
            samples.flush()
            first = first or row
            last = row
            print(f"t+{row['t']:>4}s rss {row['rssMb']} MB fds {row['fds']} db {row['dbConnections']} health p95 {row['health']['p95']} ms max {row['health']['max']} ms quotes {counters['quotes']} orders {counters['ordersPlaced']}/{counters['ordersCancelled']} errors {len(errors)}", flush=True)
            if time.time() - t0 >= MINUTES * 60:
                break
            await asyncio.sleep(max(0.0, 60 - (time.time() - t0) % 60))

        # ---- the end state
        end: dict = {"notes": notes, "minutes": MINUTES, "first": first, "last": last, "clientErrors": errors[:40], "clientErrorCount": len(errors)}
        for name, agent_id in (("momentum", aid), ("marketMaking", mid)):
            if not agent_id:
                continue
            try:
                a = await w.get_agent(agent_id)
                end[name] = {"state": a.agent.state, "mode": a.agent.mode}
            except Exception as e:  # noqa: BLE001
                end[name] = {"error": str(e)[:200]}
        for path, name in (("/api/v1/stream/stats", "streamStats"), ("/api/v1/risk/state", "risk"), ("/api/v1/agents/runtime/status", "runtime")):
            try:
                v = owner(control, path)
                end[name] = v if name != "risk" else {"switches": v.get("switches"), "decisions": len(v.get("decisions", []))}
            except Exception as e:  # noqa: BLE001
                end[name] = {"error": str(e)[:200]}
        if mid:
            try:
                end["mmSession"] = owner(control, f"/api/v1/mm/agents/{mid}")
            except Exception as e:  # noqa: BLE001
                end["mmSession"] = {"error": str(e)[:200]}
        trader.cancel()
        reader.cancel()
        await stream.close()

    log = api_log.read_text(errors="replace").splitlines()
    bad = [ln for ln in log if any(x in ln.lower() for x in ("error", "unhandled", "exception", "fatal", '"level":50', '"level":60'))]
    end["apiLog"] = {"lines": len(log), "errorLines": len(bad), "firstErrorLines": [b[:300] for b in bad[:25]]}
    end["database"] = db
    end["tableGrowth"] = {t: [first["tables"][t], last["tables"][t]] for t in TABLES} if first else {}
    (OUT / "summary.json").write_text(json.dumps(end, indent=1, default=str))
    print(json.dumps({k: end[k] for k in ("notes", "tableGrowth", "apiLog", "clientErrorCount")}, indent=1, default=str)[:6000])
    stack.stdin.close()
    stack.wait(timeout=30)


asyncio.run(main())
