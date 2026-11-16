// Live READ-ONLY smoke of the quote engine: the REAL local API (buildServer on a throw-away database, real venue adapters, the
// real websocket server on a local port) and one client that subscribes to BTC quotes on every venue + spot, one order book,
// one trade feed, one candle and the venue statuses, for --seconds (default 60).
// Prints, per venue: messages by type, venue → client latency p50 / p95 (frames that carry the venue's own timestamp), the
// stale flags seen, the status changes, the book integrity (every delta applied, every checksum verified), then the server's
// own counters (GET /api/v1/stream/stats). No key, no account, no order, no signer: every outgoing HTTP request is recorded
// and a trading or account endpoint fails the run.
// Run: npx tsx scripts/smoke-quotes.mts [--seconds 60] [--load "50x100"]     (--load: N connections × M subscriptions, see docs/v11/work/quotes.md)
import { createHash, randomBytes } from 'node:crypto';
import { createTestDb } from '../services/api/test/test-db.ts';
import { applyLevels, bookChecksum, type Level } from '../services/api/src/quotes/shared.ts';
import type { ServerMessage } from '../services/api/src/quotes/protocol.ts';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1]! : d; };
const SECONDS = Number(arg('seconds', '60')), LOAD = arg('load', '');
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
const WS = WebSocket as unknown as new (url: string, o: { headers: Record<string, string> }) => WebSocket;
const open = (): Promise<WebSocket> => new Promise((res, rej) => { const ws = new WS(`ws://127.0.0.1:${port}/api/v1/stream`, { headers: { cookie, origin: ORIGIN } }); ws.onopen = () => res(ws); ws.onerror = (e) => rej(new Error(`websocket: ${(e as ErrorEvent).message ?? 'error'}`)); });
const pct = (a: number[], p: number): string => (a.length ? String(Math.round([...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)]!)) : '—');
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
  const all = [...(await d.data.instruments('hyperliquid')).value.filter((i) => i.status === 'active').map((i) => i.id), ...(await d.data.instruments('edgex').catch(() => ({ value: [] }))).value.filter((i) => i.status === 'active').map((i) => i.id),
    ...(await d.data.instruments('dydx').catch(() => ({ value: [] }))).value.filter((i) => i.status === 'active').map((i) => i.id)];
  const pool = [...new Set(all)].slice(0, Math.max(M, 150));
  console.log(`  load: ${N} connections × ${M} subscriptions (quotes over a pool of ${pool.length} markets of hyperliquid / edgex / dydx; connection 0 also takes books and trades)`);
  const before = usage(), t0 = performance.now(), samples: { cpuPct: number; rssMb: number }[] = [];
  const counts = new Array<number>(N).fill(0), dropped = new Array<number>(N).fill(0), errors: string[] = [], closes: string[] = [], lat: number[] = [];
  const socks: WebSocket[] = [];
  for (let k = 0; k < N; k++) {
    const ws = await open(); socks.push(ws);
    ws.onmessage = (e) => { counts[k]! += 1; const m = JSON.parse(String(e.data)) as ServerMessage; if (m.type === 'dropped') dropped[k]! += m.count; else if (m.type === 'error') errors.push(`${m.code} ${m.message}`); else if (m.type === 'quote' && m.venueTs !== null && k % 10 === 0) lat.push(Date.now() - m.venueTs); };
    ws.onclose = (e) => { if (e.code !== 1000 && e.code !== 1005) closes.push(`conn ${k}: ${e.code} ${e.reason}`); };
    const mine = Array.from({ length: M }, (_, j) => pool[(k * 7 + j) % pool.length]!);
    const channels = k === 0 ? [...mine.slice(0, M - 6).map((id) => ({ type: 'quote', id })), ...ids.filter((i) => !i.startsWith('gmx') && !i.startsWith('spot')).flatMap((id) => [{ type: 'book', id, depth: 20 }, { type: 'trades', id }])] : mine.map((id) => ({ type: 'quote', id }));
    for (let i = 0; i < channels.length; i += 50) ws.send(JSON.stringify({ v: 1, op: 'subscribe', channels: channels.slice(i, i + 50) }));
  }
  let last = usage(), lastT = performance.now();
  const sampler = setInterval(() => { const u = usage(), t = performance.now(); samples.push({ cpuPct: ((u.cpuMs - last.cpuMs) / (t - lastT)) * 100, rssMb: u.rssMb }); last = u; lastT = t; }, 5000);
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  clearInterval(sampler);
  const after = usage(), wall = performance.now() - t0;
  const st = await (await realFetch(`http://127.0.0.1:${port}/api/v1/stream/stats`, { headers: { cookie } })).json() as any;
  console.log('\n== load result');
  line('process (API + the 50 clients)', `CPU ${(((after.cpuMs - before.cpuMs) / wall) * 100).toFixed(1)} % of one core on average; per 5 s: min ${Math.min(...samples.map((s) => s.cpuPct)).toFixed(1)} % max ${Math.max(...samples.map((s) => s.cpuPct)).toFixed(1)} %`);
  line('memory (RSS)', `before ${before.rssMb} MB, after ${after.rssMb} MB, peak sample ${Math.max(...samples.map((s) => s.rssMb))} MB`);
  line('connections / subscriptions', `${st.connections.open} / ${st.subscriptions}; hub channels ${st.hub.channels}, upstream feeds ${st.hub.feeds}`);
  line('frames received by the clients', `${counts.reduce((s, x) => s + x, 0)} (min ${Math.min(...counts)} / max ${Math.max(...counts)} per connection); server rate ${st.messagesPerSec} msg/s`);
  line('conflated / trades dropped', `${st.backpressure.conflated} / ${st.backpressure.tradesDropped} (clients saw ${dropped.reduce((s, x) => s + x, 0)} dropped); book resyncs ${st.backpressure.bookResyncs}; slow consumers closed ${st.backpressure.slowConsumersClosed}`);
  line('venue → client latency (stamped)', `p50 ${pct(lat, 0.5)} ms, p95 ${pct(lat, 0.95)} ms over ${lat.length} frames; server-side lag p50 ${st.lagMs.p50} ms p95 ${st.lagMs.p95} ms`);
  line('upstream', st.hub.venues.map((v: any) => `${v.venue} ${v.status} feeds ${v.feeds} msgs ${v.messages} reconnects ${v.reconnects} gaps ${v.gaps}`).join('; '));
  line('errors / abnormal closes', `${errors.length ? [...new Set(errors)].slice(0, 6).join(' | ') : 'none'} / ${closes.length ? closes.slice(0, 5).join(' | ') : 'none'}`);
  for (const ws of socks) ws.close();
} else {
  // ------------------------------------------------------------------------------------------------ smoke
  const ws = await open();
  const bookId = ids.find((i) => i.startsWith('hyperliquid'))!;
  interface V { quote: number; book: number; trade: number; candle: number; lat: number[]; stale: number; sources: Set<string>; firstQuoteMs: number | null }
  const per = new Map<string, V>(), lastStatus = new Map<string, string>(), statusLog: string[] = [], errors: string[] = [], subscribed: string[] = [];
  const venueOf = (id: string) => id.slice(0, id.indexOf(':')), of = (id: string): V => { const k = venueOf(id); let v = per.get(k); if (!v) { v = { quote: 0, book: 0, trade: 0, candle: 0, lat: [], stale: 0, sources: new Set(), firstQuoteMs: null }; per.set(k, v); } return v; };
  let bids: Level[] = [], asks: Level[] = [], bookSeq: number | null = null, deltas = 0, snapshots = 0, checksumBad = 0, seqBad = 0, heartbeats = 0, droppedMsgs = 0;
  const t0 = Date.now();
  const onData = (m: ServerMessage): void => {
    const now = Date.now();
    if (m.type === 'quote') { const v = of(m.id); v.quote += 1; v.sources.add(m.source); v.firstQuoteMs ??= now - t0; if (m.stale) v.stale += 1; if (m.venueTs !== null) v.lat.push(now - m.venueTs); }
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
