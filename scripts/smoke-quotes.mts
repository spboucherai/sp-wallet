/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/smoke-quotes.mts
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// Live READ-ONLY smoke of the quote engine: the REAL local API (buildServer on a throw-away database, real venue adapters, the
// real websocket server on a local port) and one client that subscribes to BTC quotes on every venue + spot, one order book,
// one trade feed, one candle and the venue statuses, for --seconds (default 60).
// Prints, per venue: messages by type, venue → client latency p50 / p95 (frames that carry the venue's own timestamp), the
// stale flags seen, the status changes, the book integrity (every delta applied, every checksum verified), then the server's
// own counters (GET /api/v1/stream/stats). No key, no account, no order, no signer: every outgoing HTTP request is recorded
// and a trading or account endpoint fails the run.
// Run: npx tsx scripts/smoke-quotes.mts [--seconds 60] [--load "50x100"]
// --load N×M: N client connections × M subscriptions each, held for --seconds. The clients run in a CHILD process, so the CPU and
// memory printed are those of the API process alone (docs/v11/work/quotes.md).
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createTestDb } from '../services/api/test/test-db.ts';
import { applyLevels, bookChecksum, type Level } from '../services/api/src/quotes/shared.ts';
import type { ServerMessage } from '../services/api/src/quotes/protocol.ts';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1]! : d; };
const SECONDS = Number(arg('seconds', '60')), LOAD = arg('load', '');
const pct = (a: number[], p: number): string => (a.length ? String(Math.round([...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)]!)) : '—');
type HeaderSocket = new (url: string, o: { headers: Record<string, string> }) => WebSocket;

if (process.argv.includes('--load-client')) {
  // ------------------------------------------------------------------------------------------------ the clients of a load run (child process)
  const c = JSON.parse(process.env.SPW_LOAD_CLIENT!) as { port: number; cookie: string; origin: string; n: number; m: number; seconds: number; pool: string[]; extra: unknown[] };
  const counts = new Array<number>(c.n).fill(0), dropped = new Array<number>(c.n).fill(0), errors: string[] = [], closes: string[] = [], lat: number[] = [], socks: WebSocket[] = [];
  let seqBreaks = 0; const bookSeq = new Map<string, number>(), stamp = new Map<string, number>();
  for (let k = 0; k < c.n; k++) {
    const ws: WebSocket = await new Promise((res, rej) => { const w = new (WebSocket as unknown as HeaderSocket)(`ws://127.0.0.1:${c.port}/api/v1/stream`, { headers: { cookie: c.cookie, origin: c.origin } }); w.onopen = () => res(w); w.onerror = () => rej(new Error('websocket refused')); });
    socks.push(ws);
    ws.onmessage = (e) => {
      counts[k]! += 1;
      const m = JSON.parse(String(e.data)) as ServerMessage;
      if (m.type === 'dropped') dropped[k]! += m.count;
      else if (m.type === 'error') errors.push(`${m.code} ${m.message}`);
      else if (m.type === 'quote' && m.venueTs !== null && k % 10 === 0) { const key = `${k}|${m.id}`; if ((stamp.get(key) ?? 0) < m.venueTs) lat.push(Date.now() - m.venueTs); stamp.set(key, m.venueTs); }   // only an update the venue itself stamped
      else if (m.type === 'book') { const key = `${k}|${m.id}`; if (m.kind === 'delta' && bookSeq.has(key) && bookSeq.get(key) !== m.prevSeq) seqBreaks += 1; bookSeq.set(key, m.seq); }
    };
    ws.onclose = (e) => { if (!done) closes.push(`conn ${k}: ${e.code} ${e.reason}`); };
    const mine = Array.from({ length: c.m }, (_, j) => c.pool[(k * 7 + j) % c.pool.length]!);
    const channels = k === 0 ? [...mine.slice(0, c.m - c.extra.length).map((id) => ({ type: 'quote', id })), ...c.extra] : mine.map((id) => ({ type: 'quote', id }));
    for (let i = 0; i < channels.length; i += 50) ws.send(JSON.stringify({ v: 1, op: 'subscribe', channels: channels.slice(i, i + 50) }));
  }
  let done = false;
  await new Promise((r) => setTimeout(r, c.seconds * 1000));
  done = true;
  process.stdout.write(`${JSON.stringify({ frames: counts.reduce((s, x) => s + x, 0), min: Math.min(...counts), max: Math.max(...counts), dropped: dropped.reduce((s, x) => s + x, 0), errors: [...new Set(errors)].slice(0, 6), closes: closes.slice(0, 5), latP50: pct(lat, 0.5), latP95: pct(lat, 0.95), latN: lat.length, seqBreaks })}\n`);
  for (const ws of socks) ws.close();
  setTimeout(() => process.exit(0), 300);
  await new Promise(() => {});
}
const ORIGIN = 'http://127.0.0.1';
const db = await createTestDb('smoke_quotes');
Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: '127.0.0.1', DATABASE_URL: db.url, SPW_SIGNER_SECRET: 'unused-'.repeat(8), SPW_SIGNER_URL: 'http://127.0.0.1:9', SPW_BROADCAST: 'off', SPW_WORKERS: 'off',
  ...(LOAD ? { SPW_STREAM_MAX_CONN_OWNER: '500', SPW_STREAM_MAX_CONN: '500' } : {}) });

const hosts = new Map<string, number>(), bad: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url), method = (init?.method ?? 'GET').toUpperCase();
  if (u.hostname !== '127.0.0.1') {
    hosts.set(`${method} ${u.host}`, (hosts.get(`${method} ${u.host}`) ?? 0) + 1);
    if ((method !== 'GET' && !(method === 'POST' && (u.pathname === '/info' || u.host.includes('squid')))) || /\/exchange|\/private\/|\/orders?\b|\/addresses\//i.test(u.pathname)) bad.push(`${method} ${u.host}${u.pathname}`);
  }
  return realFetch(input as never, init);
}) as typeof fetch;

const { migrate, sql } = await import('../services/api/src/db.ts');
await migrate();
const token = randomBytes(32).toString('base64url');
await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '2 hours')`;
const { COOKIE } = await import('../services/api/src/auth.ts');
const { buildServer } = await import('../services/api/src/server.ts');
const { derivatives } = await import('../services/api/src/derivatives/index.ts');
const app = await buildServer();
await app.listen({ port: 0, host: '127.0.0.1' });
const port = (app.server.address() as { port: number }).port, cookie = `${COOKIE}=${token}`;
const WS = WebSocket as unknown as HeaderSocket;
const open = (): Promise<WebSocket> => new Promise((res, rej) => { const ws = new WS(`ws://127.0.0.1:${port}/api/v1/stream`, { headers: { cookie, origin: ORIGIN } }); ws.onopen = () => res(ws); ws.onerror = (e) => rej(new Error(`websocket: ${(e as ErrorEvent).message ?? 'error'}`)); });
const line = (k: string, v: unknown) => console.log(`  ${k.padEnd(34)} ${String(v)}`);
const usage = (): { cpuMs: number; rssMb: number } => { const c = process.cpuUsage(); return { cpuMs: (c.user + c.system) / 1000, rssMb: Math.round(process.memoryUsage().rss / 1048576) }; };

// the BTC market of each venue, from the venues' own listings
const d = derivatives(), ids: string[] = [];
for (const v of ['hyperliquid', 'edgex', 'dydx', 'gmx'] as const) {
  try { const list = (await d.data.instruments(v, { budgetMs: 15_000 })).value.filter((i) => i.base === 'BTC' && i.status === 'active'); if (list[0]) ids.push(list[0].id); else console.log(`  (${v}: no active BTC market listed)`); }
  catch (e) { console.log(`  (${v}: listing unavailable — ${(e as Error).message})`); }
}
ids.push('spot:BTC');
console.log(`quote engine smoke (read-only)  ${new Date().toISOString()}  api 127.0.0.1:${port}  ${SECONDS} s`);
console.log(`  markets: ${ids.join(', ')}`);

if (LOAD) {
  // ------------------------------------------------------------------------------------------------ load test
  const [N, M] = LOAD.split('x').map(Number) as [number, number];
  // a pool over the three venues that stream: 70 Hyperliquid + 45 edgeX + 35 dYdX markets (fewer when a venue lists fewer)
  const pick = async (v: 'hyperliquid' | 'edgex' | 'dydx', n: number): Promise<string[]> => (await d.data.instruments(v, { budgetMs: 15_000 }).catch(() => ({ value: [] }))).value.filter((i) => i.status === 'active').slice(0, n).map((i) => i.id);
  const pool = [...new Set([...(await pick('hyperliquid', 70)), ...(await pick('edgex', 45)), ...(await pick('dydx', 35))])];
  const extra = ids.filter((i) => !i.startsWith('gmx') && !i.startsWith('spot')).flatMap((id) => [{ type: 'book', id, depth: 20 }, { type: 'trades', id }]);
  console.log(`  load: ${N} connections × ${M} subscriptions for ${SECONDS} s — quotes over a pool of ${pool.length} markets of hyperliquid / edgex / dydx; connection 0 also takes ${extra.length / 2} books and trade feeds. Clients in a child process.`);
  const before = usage(), t0 = performance.now(), samples: { cpuPct: number; rssMb: number }[] = [];
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--load-client'], { stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, SPW_LOAD_CLIENT: JSON.stringify({ port, cookie, origin: ORIGIN, n: N, m: M, seconds: SECONDS, pool, extra }) } });
  let out = ''; child.stdout.on('data', (x) => { out += String(x); });
  let last = usage(), lastT = performance.now();
  const sampler = setInterval(() => { const u = usage(), t = performance.now(); samples.push({ cpuPct: ((u.cpuMs - last.cpuMs) / (t - lastT)) * 100, rssMb: u.rssMb }); last = u; lastT = t; }, 5000);
  // the server's figures are read just before the clients leave
  await new Promise((r) => setTimeout(r, SECONDS * 1000 - 1500));
  const st = await (await realFetch(`http://127.0.0.1:${port}/api/v1/stream/stats`, { headers: { cookie } })).json() as any;
  await new Promise((r) => child.on('exit', r));
  clearInterval(sampler);
  const after = usage(), wall = performance.now() - t0, cl = JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as { frames: number; min: number; max: number; dropped: number; errors: string[]; closes: string[]; latP50: string; latP95: string; latN: number; seqBreaks: number };
  console.log('\n== load result');
  line('API process', `CPU ${(((after.cpuMs - before.cpuMs) / wall) * 100).toFixed(1)} % of one core on average; per 5 s: min ${Math.min(...samples.map((s) => s.cpuPct)).toFixed(1)} % max ${Math.max(...samples.map((s) => s.cpuPct)).toFixed(1)} %`);
  line('memory (RSS)', `before ${before.rssMb} MB, after ${after.rssMb} MB, peak sample ${Math.max(...samples.map((s) => s.rssMb))} MB`);
  line('connections / subscriptions', `${st.connections.open} / ${st.subscriptions}; hub channels ${st.hub.channels}, upstream feeds ${st.hub.feeds}`);
  line('frames received by the clients', `${cl.frames} (min ${cl.min} / max ${cl.max} per connection); server: ${st.messagesSent} sent, ${st.messagesPerSec} msg/s over the last 10 s, ${(st.bytesSent / 1048576).toFixed(1)} MB`);
  line('conflated / trades dropped', `${st.backpressure.conflated} / ${st.backpressure.tradesDropped} (clients saw ${cl.dropped} dropped); book resyncs ${st.backpressure.bookResyncs}; book sequence breaks seen by clients ${cl.seqBreaks}; slow consumers closed ${st.backpressure.slowConsumersClosed}`);
  line('venue → client latency (stamped)', `p50 ${cl.latP50} ms, p95 ${cl.latP95} ms over ${cl.latN} frames; server-side lag p50 ${st.lagMs.p50} ms p95 ${st.lagMs.p95} ms`);
  line('upstream', st.hub.venues.map((v: any) => `${v.venue} ${v.status} feeds ${v.feeds} msgs ${v.messages} reconnects ${v.reconnects} gaps ${v.gaps}`).join('; '));
  line('errors / abnormal closes', `${cl.errors.length ? cl.errors.join(' | ') : 'none'} / ${cl.closes.length ? cl.closes.join(' | ') : 'none'}`);
} else {
  // ------------------------------------------------------------------------------------------------ smoke
  const ws = await open();
  const bookId = ids.find((i) => i.startsWith('hyperliquid'))!;
  interface V { quote: number; book: number; trade: number; candle: number; lat: number[]; stale: number; sources: Set<string>; firstQuoteMs: number | null }
  const per = new Map<string, V>(), stamps = new Map<string, number>(), lastStatus = new Map<string, string>(), statusLog: string[] = [], errors: string[] = [], subscribed: string[] = [];
  const venueOf = (id: string) => id.slice(0, id.indexOf(':')), of = (id: string): V => { const k = venueOf(id); let v = per.get(k); if (!v) { v = { quote: 0, book: 0, trade: 0, candle: 0, lat: [], stale: 0, sources: new Set(), firstQuoteMs: null }; per.set(k, v); } return v; };
  let bids: Level[] = [], asks: Level[] = [], bookSeq: number | null = null, deltas = 0, snapshots = 0, checksumBad = 0, seqBad = 0, heartbeats = 0, droppedMsgs = 0;
  const t0 = Date.now();
  const onData = (m: ServerMessage): void => {
    const now = Date.now();
    if (m.type === 'quote') {
      const v = of(m.id); v.quote += 1; v.sources.add(m.source); v.firstQuoteMs ??= now - t0; if (m.stale) v.stale += 1;
      // a quote is re-sent when any of its parts moves: the latency is taken only when the venue's own timestamp advanced (that part is the one that just arrived)
      if (m.venueTs !== null && (stamps.get(m.id) ?? 0) < m.venueTs) v.lat.push(now - m.venueTs);
      if (m.venueTs !== null) stamps.set(m.id, m.venueTs);
    }
    else if (m.type === 'book') {
      const v = of(m.id); v.book += 1; v.sources.add(m.source); if (m.venueTs !== null) v.lat.push(now - m.venueTs);
      if (m.kind === 'snapshot') { snapshots += 1; bids = m.bids; asks = m.asks; }
      else { deltas += 1; if (m.prevSeq !== bookSeq) seqBad += 1; bids = applyLevels(bids, m.bids, 'bids', m.depth); asks = applyLevels(asks, m.asks, 'asks', m.depth); }
      bookSeq = m.seq;
      if (bookChecksum(bids, asks) !== m.checksum) checksumBad += 1;
    } else if (m.type === 'trade') { const v = of(m.id); v.trade += m.trades.length; v.sources.add(m.source); if (!m.snapshot) for (const t of m.trades) v.lat.push(now - t.ts); }
    else if (m.type === 'candle') of(m.id).candle += 1;
    else if (m.type === 'status' && lastStatus.get(m.venue) !== m.status) { lastStatus.set(m.venue, m.status); statusLog.push(`+${((now - t0) / 1000).toFixed(1)}s ${m.venue} ${m.status} (${m.transport}, ${m.source}${m.detail ? `, ${m.detail}` : ''})`); }
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as ServerMessage;
    if (m.type === 'subscribed') { subscribed.push(`${m.key} [${m.source ?? '—'}${m.snapshotAgeMs !== null && m.snapshot ? `, snapshot ${m.snapshotAgeMs} ms old` : ', no snapshot yet'}]`); const s = m.snapshot as ServerMessage | ServerMessage[] | null; if (s) for (const x of Array.isArray(s) ? s : [s]) onData(x); }
    else if (m.type === 'error') errors.push(`${m.code}: ${m.message}`);
    else if (m.type === 'heartbeat') heartbeats += 1;
    else if (m.type === 'dropped') droppedMsgs += m.count;
    else onData(m);
  };
  let closed = '';
  ws.onclose = (e) => { closed = `${e.code} ${e.reason}`; };
  ws.send(JSON.stringify({ v: 1, op: 'subscribe', reqId: 1, channels: [{ type: 'status', id: '*' }, ...ids.map((id) => ({ type: 'quote', id })), { type: 'book', id: bookId, depth: 20 }, { type: 'trades', id: bookId },
    ...ids.filter((i) => i.startsWith('dydx') || i.startsWith('edgex')).map((id) => ({ type: 'trades', id })), { type: 'candle', id: bookId, interval: '1m' }, { type: 'quote', id: 'hyperliquid:xyz:ANT' }, { type: 'quote', id: 'hyperliquid:NOPE' }] }));
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  const st = await (await realFetch(`http://127.0.0.1:${port}/api/v1/stream/stats`, { headers: { cookie } })).json() as any;
  console.log('\n== subscriptions'); for (const s of subscribed) console.log(`  ${s}`);
  console.log('\n== per venue (messages over the run; latency = client receive time − the venue\'s own timestamp)');
  for (const [venue, v] of per) line(venue, `quotes ${v.quote}  book ${v.book}  trades ${v.trade}  candles ${v.candle}  | latency p50 ${pct(v.lat, 0.5)} ms p95 ${pct(v.lat, 0.95)} ms (${v.lat.length} stamped) | stale flags ${v.stale} | first quote after ${v.firstQuoteMs ?? '—'} ms | ${[...v.sources].join(', ')}`);
  console.log('\n== order book integrity');
  line(bookId, `${snapshots} snapshot(s), ${deltas} delta(s); sequence breaks ${seqBad}; checksum mismatches ${checksumBad}; best bid ${bids[0]?.[0] ?? '—'} / ask ${asks[0]?.[0] ?? '—'}`);
  console.log('\n== venue status events'); for (const s of statusLog) console.log(`  ${s}`);
  console.log('\n== server (GET /api/v1/stream/stats)');
  line('connections / subscriptions', `${st.connections.open} / ${st.subscriptions}`);
  line('messages', `${st.messagesSent} sent, ${st.messagesPerSec}/s over the last 10 s, ${st.bytesSent} bytes`);
  line('backpressure', `conflated ${st.backpressure.conflated}, trades dropped ${st.backpressure.tradesDropped} (client saw ${droppedMsgs}), book resyncs ${st.backpressure.bookResyncs}`);
  line('lag venueTs → socket write', `p50 ${st.lagMs.p50} ms, p95 ${st.lagMs.p95} ms (${st.lagMs.samples} stamped frames)`);
  line('upstream reconnects / gaps', `${st.upstreamReconnects} / ${st.hub.counters.gaps}`);
  for (const v of st.hub.venues) line(`  ${v.venue}`, `${v.status} (${v.transport}), feeds ${v.feeds}, upstream messages ${v.messages}, reconnects ${v.reconnects}, gaps ${v.gaps}, errors ${v.errors}${v.lastError ? ` (last: ${v.lastError})` : ''}`);
  line('heartbeats received', heartbeats);
  line('errors', errors.length ? errors.join(' | ') : 'none');
  line('socket', closed || 'open until the end');
  ws.close();
}
console.log('\n== outgoing HTTP requests (public market data only)');
for (const [k, n] of [...hosts].sort()) line(k, n);
line('trading / account endpoints', bad.length ? `FAILED: ${bad.join(', ')}` : 'none');
await app.close();
await sql.end({ timeout: 2 }).catch(() => {});
await db.drop().catch(() => {});
process.exit(bad.length ? 1 : 0);
