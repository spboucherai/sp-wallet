// V8 hardening — soak test of the engines running TOGETHER on one scratch database, through simulated hours at accelerated
// time: the spot agent engine (real `tickAgent`, the REAL sandboxed signal runner on a library strategy, paper fills), the
// perp paper engine (real `perpEnginePass` on a scripted venue), the derivatives paper worker (`paperStep`), the alerts
// dispatcher (tail + conditions + deliver), the plan worker (`advancePlans`), the withdrawal worker and the expiry loop.
// Nothing real: no network (fetch is refused), no signer (its URL is a closed port), venue data from the test fixtures with
// a scripted market, bars from a deterministic generator, a scripted clock. The database is a unique scratch one, dropped.
//
//   npx tsx scripts/soak-engines.mts            48 simulated hours, 3 passes per hour
//   SOAK_HOURS=240 SOAK_PASSES=4 node --expose-gc --import tsx scripts/soak-engines.mts     longer; exact heap readings with --expose-gc
//
// Asserts (exit 1 otherwise): no duplicate order (a second and third pass on the same closed bar place nothing; unique client
// ids; one signal row per agent and bar), every bar processed, no pass ended in an error, tables grow at most linearly and
// within a per-hour bound, heap growth bounded, no unhandled rejection, no uncaught exception, no forbidden request.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Clock, fixtureVenues, setMarket } from '../services/api/test/derivatives-helpers.ts';
import { addAgent } from '../services/api/test/alerts-helpers.ts';
import { createTestDb } from '../services/api/test/test-db.ts';

const HOURS = Number(process.env.SOAK_HOURS ?? 48), PASSES = Number(process.env.SOAK_PASSES ?? 3), H = 3_600_000, ORIGIN = 'https://wallet.test';
const ROOT = path.resolve(import.meta.dirname, '..'), LAB_READY = existsSync(path.join(ROOT, 'research/.venv/bin/python'));
const say = (s = ''): void => console.log(s);
const problems: string[] = [], rejections: string[] = [], forbidden: string[] = [];
process.on('unhandledRejection', (e) => { rejections.push(`unhandledRejection: ${String((e as Error)?.message ?? e).slice(0, 160)}`); });
process.on('uncaughtException', (e) => { rejections.push(`uncaughtException: ${String(e?.message ?? e).slice(0, 160)}`); });
globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => { const u = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); forbidden.push(u.slice(0, 80)); throw new Error(`FORBIDDEN request in the soak test: ${u.slice(0, 80)}`); }) as typeof fetch;
const check = (ok: boolean, what: string): void => { if (!ok) problems.push(what); say(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); };

// deterministic hourly bars: N0 of history before the simulation starts, then one more per simulated hour
const N0 = 1100;
function walk(seed: number, p0: number, n: number, start: number): { ts: number; open: number; high: number; low: number; close: number; volume: number }[] {
  let s = seed >>> 0, close = p0; const rnd = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
  return Array.from({ length: n }, (_, i) => { const open = close; close = open * Math.exp(0.012 * (rnd() + rnd() + rnd() - 1.5) + 0.004 * Math.sin(i / 9));
    return { ts: start + i * H, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 1 + rnd() }; });
}

const db0 = await createTestDb('soak');
let app: any, sql: any;
try {
  Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: 'wallet.test', DATABASE_URL: db0.url, SPW_SIGNER_SECRET: 's'.repeat(48), SPW_SIGNER_URL: 'http://127.0.0.1:9', SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
  delete process.env.SPW_LAB_SANDBOX;
  const db = await import('../services/api/src/db.ts'); sql = db.sql; await db.migrate(); await db.setSetting('prices', false);
  const store = await import('../services/api/src/alerts/store.ts'), alerts = await import('../services/api/src/alerts/dispatcher.ts'); await store.migrateAlerts(true);
  const clock = new Clock(Math.floor(Date.now() / H) * H + 60_000), T_START = clock.now() - 60_000;   // one minute after an hour: the bar before it is closed
  const series: Record<string, ReturnType<typeof walk>> = { ETH: walk(23, 3000, N0 + HOURS + 2, T_START - N0 * H), LINK: walk(31, 15, N0 + HOURS + 2, T_START - N0 * H), BTC: walk(11, 100_000, N0 + HOURS + 2, T_START - N0 * H) };
  const closed = (sym: string, limit: number) => { const b = series[sym]!, n = b.findIndex((x) => x.ts + H > clock.now()); return b.slice(Math.max(0, (n < 0 ? b.length : n) - limit), n < 0 ? b.length : n); };

  // --- the scripted venue, the derivatives instance, the server (routes create the agents exactly as the app does)
  const v = fixtureVenues(clock), mod = await import('../services/api/src/derivatives/index.ts'), wk = await import('../services/api/src/derivatives/worker.ts');
  const dv = mod.createDerivatives({ registry: mod.createRegistry(v.adapters, clock.now), now: clock.now });
  const pl = await import('../services/api/src/agents/perp-live.ts'), eng = await import('../services/api/src/agents/engine.ts'), live = await import('../services/api/src/agents/live.ts');
  const perpWeights = [0.5, 0.5, -0.3, 0, 0.8, -0.6]; let perpCalls = 0;
  const rt = pl.createPerpRuntime(dv, {
    signal: async () => { perpCalls += 1; return { weights: { BTC: perpWeights[Math.floor((clock.now() - T_START) / (6 * H)) % perpWeights.length]! }, maxLeverage: 2, maxGrossExposure: 2 }; },
    gate: async (symbols, _interval, lookback) => { const data: Record<string, any> = {}; let bar = 0;
      for (const s of symbols) { const b = closed(s, lookback); bar = b.at(-1)!.ts; data[s] = { bars: b, funding: b.map((x) => ({ ts: x.ts, rate: 0.0000125, premium: null })), lastClose: String(b.at(-1)!.close.toFixed(2)) }; }
      return { bar, data }; } });
  pl.setPerpRuntime(rt);
  app = await (await import('../services/api/src/server.ts')).buildServer({ swapProviders: [], derivatives: dv });
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '6 hours')`;
  const cookie = `${(await import('../services/api/src/auth.ts')).COOKIE}=${token}`;
  const api = async (method: string, url: string, body?: unknown) => { const r = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie, ...(method !== 'GET' ? { origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' } : {}) }, ...(method !== 'GET' ? { payload: JSON.stringify(body ?? {}) } : {}) });
    if (r.statusCode !== 200) throw new Error(`${method} ${url}: ${r.statusCode} ${r.body.slice(0, 200)}`); return r.json(); };
  const market = (): void => { const mid = Math.round(closed('BTC', 1)[0]!.close); setMarket(v, mid, { bids: [[String(mid - 5), '5'], [String(mid - 10), '5']], asks: [[String(mid + 5), '5'], [String(mid + 10), '5']] }); };
  market();

  // --- agents: two spot agents in paper trading (a library strategy, the real sandboxed signal runner), two perp paper agents
  const st = await import('../services/api/src/agents/strategies.ts'), labStatus = await (await import('../services/api/src/agents/lab.ts')).labStatus();
  const realSignal = LAB_READY && labStatus.ok;
  say(`soak: ${HOURS} simulated hours × ${PASSES} passes, scratch database ${db0.name}; spot signal: ${realSignal ? 'REAL sandboxed laboratory (ma_trend/3)' : `scripted (laboratory sandbox ${labStatus.mode}: ${labStatus.reason})`}`);
  for (const [symbol, b] of Object.entries(series)) for (const source of ['coinbase', 'kraken']) { const x = b[N0 - 1]!; await sql`insert into candles (source, symbol, interval, ts, open, high, low, close, volume) values (${source}, ${symbol}, '1h', ${new Date(Math.floor(Date.now() / H) * H - H)}, ${x.open}, ${x.high}, ${x.low}, ${x.close}, 1)`; }
  const RISK = { maxExposurePct: 80, maxLossPct: 60, maxOrderUsd: 400, maxDailyUsd: 1_000_000, maxOrdersPerDay: 200, mandateDays: 30, slippageBps: 100 };
  const info = realSignal ? await st.describe('ma_trend/3') : { path: 'strategies/ma_trend/3', sha256: createHash('sha256').update(readFileSync(path.join(ROOT, 'research/strategies/ma_trend/3/strategy.py'))).digest('hex') };
  const spot: string[] = [];
  // spot agents are inserted directly (creating one through the route derives its vault address from the signer, and there is none here)
  for (const name of ['Soak spot A', 'Soak spot B']) { const id = await addAgent(sql, { name, state: 'PAPER_TRADING', universe: ['ETH', 'LINK'], capital: '1000000000' }), sv = randomUUID();
    await sql`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, meta, status, report) values (${sv}, ${id}, 'ma_trend', '3', ${info.sha256}, ${info.path}, '{}', 'approved', '{}')`;
    // the daily limits count orders of the REAL day; days pass in seconds here, so they are set very high for the run
    await sql`update agents set strategy_version_id = ${sv}, mode = 'PAPER', risk = ${sql.json({ ...RISK, maxOrdersPerDay: 1_000_000, maxDailyUsd: 1e9 })} where id = ${id}`; spot.push(id); }
  const PRISK = { maxLeverage: 2, maxGrossExposureX: 1.5, maxPositionX: 1, maxDailyLossPct: 50, maxTotalLossPct: 80, slippageBps: 30, minTradePct: 2 };
  const perp: { id: string; acct: string }[] = [];
  for (const name of ['Soak perp A', 'Soak perp B']) { const a = await api('POST', '/agents', { kind: 'perp', name, instruments: ['BTC'], interval: '1h', capitalUsdc: '10000', risk: PRISK }); const sv = randomUUID();
    await sql`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, meta, status, report) values (${sv}, ${a.id}, 'fixed_perp', '1', ${createHash('sha256').update(a.id).digest('hex')}, 'strategies/fixed_perp/1', ${sql.json({ kind: 'perp', lookback: 10, max_leverage: 2, max_gross_exposure: 2 })}, 'approved', '{}')`;
    await sql`update agents set strategy_version_id = ${sv} where id = ${a.id}`; await api('POST', `/agents/${a.id}/mode`, { mode: 'PAPER' }); perp.push({ id: a.id, acct: a.accountId }); }

  // --- the loops
  let spotSignals = 0;
  const spotDeps = (): any => ({ series: async (s: string, _i: string, limit: number) => closed(s, limit), assertFresh: async () => {}, now: clock.now, halted: async () => false, inFlight: async () => false,
    placeLive: async () => { throw new Error('a live order in the soak test'); }, holdings: (a: any) => eng.paperHoldings(a),
    signal: async (s: { path: string; sha256: string }, data: Record<string, any[]>) => { spotSignals += 1; if (realSignal) return live.runSignal(s, data, '1h');
      return Object.fromEntries(Object.keys(data).map((k, i) => [k, (Math.floor((clock.now() - T_START) / (4 * H)) + i) % 3 === 0 ? 0.4 : 0.1])); },
    // paper fill: the last close, minus 0.3 % of costs — exact integer arithmetic on base units is not needed for a simulation
    quote: async (a: any, fromId: string, toId: string, amountIn: bigint) => { const hs = await eng.paperHoldings(a), f = hs.find((h: any) => h.id === fromId)!, t = hs.find((h: any) => h.id === toId)!;
      const px = (sym: string): number => (series[sym] ? closed(sym, 1)[0]!.close : 1), usd = (Number(amountIn) / 10 ** f.decimals) * px(f.symbol) * 0.997;
      return BigInt(Math.floor((usd / px(t.symbol)) * 10 ** Math.min(t.decimals, 12))) * 10n ** BigInt(Math.max(0, t.decimals - 12)); } });
  const dispatcher = new alerts.AlertDispatcher({ now: clock.now, fetch: (async () => new Response(null, { status: 201 })) as typeof fetch, origin: ORIGIN, settleMs: -1e12, allowHttpWebhook: true,
    signerStatus: async () => ({ keyId: 'soak', addresses: {}, halted: false, policy: { version: 1 } }) as never, rpcHealth: () => [], loops: () => [], backup: () => null, disk: async () => null,
    lab: async () => labStatus } as never);
  await dispatcher.tail();
  const { advancePlans } = await import('../services/api/src/plan-exec.ts'), { advanceWithdrawals } = await import('../services/api/src/agents/withdrawals.ts'), { expireStale } = await import('../services/api/src/worker.ts');
  const count = async (q: string): Promise<number> => Number((await sql.unsafe(`select count(*)::int as n from ${q}`))[0].n);
  const tables = async (): Promise<Record<string, number>> => { const names = (await sql`select tablename from pg_tables where schemaname = 'public' order by 1`).map((r: any) => r.tablename as string), out: Record<string, number> = {};
    for (const n of names) out[n] = await count(`"${n}"`); return out; };
  const heap = (): number => { (globalThis as { gc?: () => void }).gc?.(); return Math.round(process.memoryUsage().heapUsed / 1048576); };
  const outcomes: Record<string, number> = {}, errors: string[] = []; let dupSpot = 0, dupPerp = 0, extraSpot = 0;
  const note = (k: string): void => { const key = k.replace(/[0-9.]+/g, 'N').slice(0, 60); outcomes[key] = (outcomes[key] ?? 0) + 1; if (k.startsWith('error')) errors.push(k); };
  const t0 = Date.now(), snap: { hour: number; rows: Record<string, number>; heap: number }[] = [{ hour: 0, rows: await tables(), heap: heap() }];

  for (let h = 0; h < HOURS; h++) {
    for (let p = 0; p < PASSES; p++) {
      clock.t = T_START + h * H + 60_000 + Math.floor((p * (H - 120_000)) / PASSES); market();
      const before = { spot: await count('agent_orders'), perp: await count('deriv_orders'), sig: await count('perp_agent_signals') };
      // the engines and the workers of one pass run CONCURRENTLY, as their timers do in the server
      const agents = await sql`select * from agents where id in ${sql(spot)} order by created_at`;
      const res = await Promise.all([
        (async () => { for (const a of agents) note(`spot: ${await eng.tickAgent(a, spotDeps()).catch((e: Error) => `error: ${e.message}`)}`); })(),
        pl.perpEnginePass(rt, clock.now()).then((o) => { for (const x of Object.values(o)) note(`perp: ${x}`); }),
        wk.paperStep(dv.paper, clock.now()).then((s) => { for (const e of s.errors) errors.push(`paper worker: ${e}`); }),
        dispatcher.tail().then(() => dispatcher.conditions()).then(() => dispatcher.deliver()),
        advancePlans(), advanceWithdrawals(clock.now()), expireStale(),
      ].map((x) => x.catch((e: Error) => { errors.push(`pass error: ${e.message.slice(0, 160)}`); })));
      void res;
      const after = { spot: await count('agent_orders'), perp: await count('deriv_orders'), sig: await count('perp_agent_signals') };
      if (p > 0) { if (after.spot !== before.spot) dupSpot += after.spot - before.spot; if (after.sig !== before.sig) dupPerp += after.sig - before.sig; }
      if (p === 0 && after.spot - before.spot > spot.length * 6) extraSpot += 1;
    }
    if ((h + 1) % Math.max(1, Math.floor(HOURS / 4)) === 0 || h === HOURS - 1) { snap.push({ hour: h + 1, rows: await tables(), heap: heap() }); say(`  hour ${h + 1}/${HOURS}: ${await count('agent_orders')} spot paper orders, ${await count('deriv_orders')} perp paper orders, ${await count('alerts')} alerts, heap ${snap.at(-1)!.heap} MiB, ${Math.round((Date.now() - t0) / 1000)} s`); }
  }

  // --- verdict
  say(`\nran ${HOURS} simulated hours in ${Math.round((Date.now() - t0) / 1000)} s: ${spotSignals} spot signal calls${realSignal ? ' (sandboxed python)' : ''}, ${perpCalls} perp signal calls`);
  say(`outcomes: ${Object.entries(outcomes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}× ${k}`).join('; ')}`);
  check(errors.length === 0, `no pass ended in an error (${errors.length}${errors.length ? `: ${[...new Set(errors)].slice(0, 3).join(' | ')}` : ''})`);
  check(dupSpot === 0, `spot engine: the 2nd and later passes on a closed bar placed no order (${dupSpot} extra)`);
  check(extraSpot === 0, 'spot engine: never more than 6 paper orders per agent on one bar');
  const perBar = await sql`select agent_id, bar, count(*)::int as n from agent_orders group by 1, 2 having count(*) > 6`;
  check(perBar.length === 0, `spot engine: at most 6 orders per (agent, bar) in the table (${perBar.length} bars above)`);
  const lastBars = await sql`select id, last_bar, state from agents where id in ${sql(spot)}`;
  check(lastBars.every((a: any) => a.state === 'PAPER_TRADING' && a.last_bar && a.last_bar.getTime() === closed('ETH', 1)[0]!.ts), `spot engine: every agent processed every bar up to the last closed one and is still running (${lastBars.map((a: any) => `${a.state} ${a.last_bar?.toISOString().slice(5, 16)}`).join(', ')})`);
  const eqRows = await count('agent_equity'); check(eqRows <= (spot.length + perp.length) * (HOURS + 1), `agent_equity: at most one row per agent and bar (${eqRows} rows)`);
  check(dupPerp === 0, `perp engine: the 2nd and later passes on a closed bar wrote no new signal row (${dupPerp} extra)`);
  const sigDup = await sql`select agent_id, bar, count(*)::int as n from perp_agent_signals group by 1, 2 having count(*) > 1`;
  check(sigDup.length === 0 && (await count('perp_agent_signals')) === perp.length * HOURS, `perp engine: exactly one signal row per agent and bar (${await count('perp_agent_signals')} rows for ${perp.length} agents × ${HOURS} bars)`);
  const cid = await sql`select account_id, client_id, count(*)::int as n from deriv_orders group by 1, 2 having count(*) > 1`;
  check(cid.length === 0, `perp engine: every paper order has a unique client id (${await count('deriv_orders')} orders, ${cid.length} duplicated ids)`);
  const alertDup = await sql`select dedupe_key, count(*)::int as n from alerts where dedupe_key is not null group by 1 having count(*) > 1`;
  check(alertDup.length === 0, `alerts: no dedupe key used twice (${await count('alerts')} alerts)`);
  // growth: per simulated hour in the second half vs the first half, and an absolute bound per hour
  const mid = snap[Math.floor(snap.length / 2)]!, end = snap.at(-1)!, first = snap[0]!, grow: string[] = [], bad: string[] = [];
  for (const [tb, n] of Object.entries(end.rows)) { const a = (mid.rows[tb]! - first.rows[tb]!) / Math.max(1, mid.hour), b = (n - mid.rows[tb]!) / Math.max(1, end.hour - mid.hour);
    if (b > 0.05) grow.push(`${tb} ${b.toFixed(1)}/h`);
    if (b > Math.max(2, a * 1.6 + 2) || b > 400) bad.push(`${tb}: ${a.toFixed(1)}/h then ${b.toFixed(1)}/h`); }
  say(`table growth in the second half (rows per simulated hour): ${grow.join(', ') || 'none'}`);
  check(bad.length === 0, `no table grows faster in the second half than in the first, none above 400 rows per hour${bad.length ? ` — ${bad.join('; ')}` : ''}`);
  const stateRows = await count('alert_state'), seen = await count('alert_seen');
  check(stateRows < 200, `alert_state stays small (${stateRows} rows; alert_seen ${seen})`);
  const hMid = mid.heap, hEnd = end.heap;
  check(hEnd - hMid < 64, `heap: ${first.heap} MiB at start, ${hMid} MiB at half, ${hEnd} MiB at the end${(globalThis as { gc?: unknown }).gc ? ' (after gc)' : ' (no --expose-gc: includes garbage)'} — growth in the second half under 64 MiB`);
  check(rejections.length === 0, `no unhandled rejection, no uncaught exception (${rejections.length}${rejections.length ? `: ${rejections[0]}` : ''})`);
  check(forbidden.length === 0, `no outside request was attempted (${forbidden.length}${forbidden.length ? `: ${[...new Set(forbidden)].slice(0, 3).join(', ')}` : ''})`);
} catch (e) { problems.push(`the soak test itself failed: ${(e as Error).stack?.split('\n').slice(0, 4).join(' | ')}`); say(`FAIL ${problems.at(-1)}`); }
finally { app?.server?.closeAllConnections?.(); await app?.close().catch(() => {}); await sql?.end({ timeout: 5 }).catch(() => {}); await db0.drop().catch(() => {}); }
say(problems.length ? `\nSOAK FAILED: ${problems.length} problem(s)` : '\nSOAK PASSED');
process.exit(problems.length ? 1 : 0);
