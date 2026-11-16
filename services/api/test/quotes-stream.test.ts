// Quote engine through the REAL server (buildServer, the single onRequest hook, the trading-API scope guard, the websocket
// plugin) on a local port, with real websocket clients (`ws`) and scripted upstreams. Own database; no network.
// Covers: authentication before the upgrade (session, strict Origin, API key, scope, ticket), per-subscription key
// restrictions, the protocol (snapshot on subscribe, errors, limits, malformed and oversized frames), backpressure with a
// really slow consumer, liveness, session logout / expiry and key revocation closing the socket, graceful shutdown, stats.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { useTestDatabase } from './test-db.ts';
import { fakeUpstream, L, type FakeUp } from './quotes-helpers.ts';
import type { StreamLimits } from '../src/quotes/engine.ts';
import type { ServerMessage } from '../src/quotes/protocol.ts';
import { applyLevels, bookChecksum, type Level } from '../src/quotes/shared.ts';

const ORIGIN = 'https://wallet.test';
let sql: any, buildServer: typeof import('../src/server.ts').buildServer, COOKIE = '', keyModel: typeof import('../src/trading-api/key-model.ts'), pepper = '';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error(`timeout: ${what}`); await sleep(5); } }

async function newSession(): Promise<{ token: string; cookie: string }> {
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (id_hash, expires_at) values (${sha(token)}, now() + interval '1 hour')`;
  return { token, cookie: `${COOKIE}=${token}` };
}
async function newKey(o: { scopes?: string[]; venues?: string[]; instruments?: string[] } = {}): Promise<{ id: string; token: string }> {
  const id = keyModel.newKeyId(), secret = keyModel.newKeySecret();
  await sql`insert into api_keys (id, name, secret_hash, scopes, limits, restrictions, rate_limit_per_min, expires_at)
    values (${id}, 'stream test', ${keyModel.hashSecret(pepper, id, secret)}, ${o.scopes ?? ['markets:read']}, ${sql.json({})}, ${sql.json({ networks: [], venues: o.venues ?? [], instruments: o.instruments ?? [], ipAllow: [] })}, 600, now() + interval '1 day')`;
  return { id, token: keyModel.formatToken(id, secret) };
}

interface World { app: any; port: number; hl: FakeUp; dydx: FakeUp; gmx: FakeUp; engineConns(): number; close(): Promise<void> }
const worlds: World[] = [];
async function boot(limits: Partial<StreamLimits> = {}, hub: Record<string, number> = {}): Promise<World> {
  const hl = fakeUpstream('hyperliquid', { bbo: true }), dydx = fakeUpstream('dydx'), gmx = fakeUpstream('gmx', { book: false, transport: 'poll', staleAfterMs: 20_000 });
  const app = await buildServer({ quotes: { upstreams: [hl.up, dydx.up, gmx.up], hub: { quoteMinIntervalMs: 0, idleGraceMs: 30, ...hub }, limits } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const engine = (await import('../src/quotes/index.ts')).currentQuoteEngine()!;   // the engine of THIS server (the module keeps the one built last)
  const w: World = { app, port: (app.server.address() as { port: number }).port, hl, dydx, gmx, engineConns: () => engine.conns.size, close: async () => { await app.close(); } };
  worlds.push(w);
  return w;
}

interface Client { ws: WebSocket; msgs: ServerMessage[]; closed: { code: number; reason: string } | null; send(m: unknown): void; next<T extends ServerMessage['type']>(type: T, pred?: (m: Extract<ServerMessage, { type: T }>) => boolean): Promise<Extract<ServerMessage, { type: T }>>; of<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[]; untilClosed(): Promise<{ code: number; reason: string }> }
/** resolves with a connected client (after `hello`), or rejects with `{ status, body }` when the server refuses the upgrade */
function connect(w: World, path: string, headers: Record<string, string> = {}, o: { maxPayload?: number } = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${w.port}${path}`, { headers, perMessageDeflate: false, ...o }), taken = new Set<ServerMessage>();
    const c: Client = { ws, msgs: [], closed: null, send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
      of: (type) => c.msgs.filter((m) => m.type === type) as never,
      // the first frame of this type (matching `pred`) that no earlier `next` returned — whether it is already there or still to come
      next: async (type, pred) => { let found: any; await until(() => !!(found = c.msgs.find((m) => m.type === type && !taken.has(m) && (!pred || pred(m as never)))) || c.closed !== null, `a ${type} frame`); if (!found) throw new Error(`closed (${c.closed!.code} ${c.closed!.reason}) before a ${type} frame`); taken.add(found); return found; },
      untilClosed: async () => { await until(() => c.closed !== null, 'the socket to close'); return c.closed!; } };
    ws.on('message', (d) => { const m = JSON.parse(String(d)) as ServerMessage; c.msgs.push(m); if (m.type === 'hello') resolve(c); });
    ws.on('close', (code, reason) => { c.closed = { code, reason: String(reason) }; });
    ws.on('unexpected-response', (_req, res) => { let body = ''; res.on('data', (x) => { body += x; }); res.on('end', () => { let json: any = null; try { json = JSON.parse(body); } catch { /* not JSON */ } reject({ status: res.statusCode, body: json, upgraded: false }); }); });
    ws.on('error', (e) => { if (!c.msgs.length && !(e as any).message?.includes('Unexpected server response')) reject(e); });
  });
}
const refused = async (p: Promise<Client>): Promise<{ status: number; error: string | undefined }> => p.then((c) => { c.ws.close(); return { status: 101, error: undefined }; }, (e) => ({ status: e.status as number, error: e.body?.error as string | undefined }));
const sub = (id: string, type = 'quote', extra: Record<string, unknown> = {}) => ({ type, id, ...extra });

let owner: { token: string; cookie: string };
beforeAll(async () => {
  await useTestDatabase('quotes_stream', { SPW_DATA_DIR: mkdtempSync(join(tmpdir(), 'spw-quotes-')), SPW_API_KEY_PEPPER: 'p'.repeat(48) });
  const db = await import('../src/db.ts'); sql = db.sql; await db.migrate();
  ({ buildServer } = await import('../src/server.ts')); ({ COOKIE } = await import('../src/auth.ts'));
  keyModel = await import('../src/trading-api/key-model.ts'); pepper = (await import('../src/trading-api/secrets.ts')).apiKeyPepper();
  owner = await newSession();
});
afterEach(async () => { while (worlds.length) await worlds.pop()!.close().catch(() => {}); });
afterAll(async () => { await sql?.end({ timeout: 2 }); });

const own = () => ({ cookie: owner.cookie, origin: ORIGIN });

describe('authentication happens before the upgrade', () => {
  it('browser stream: the owner session AND the exact Origin, or a plain HTTP refusal — never an upgraded socket', async () => {
    const w = await boot();
    expect(await refused(connect(w, '/api/v1/stream'))).toEqual({ status: 401, error: 'unauthenticated' });
    expect(await refused(connect(w, '/api/v1/stream', { cookie: `${COOKIE}=${'x'.repeat(43)}`, origin: ORIGIN }))).toEqual({ status: 401, error: 'unauthenticated' });
    // the session cookie rides on a websocket handshake from ANY page: without the right Origin it opens nothing
    expect(await refused(connect(w, '/api/v1/stream', { cookie: owner.cookie, origin: 'https://evil.example' }))).toEqual({ status: 403, error: 'origin_refused' });
    expect(await refused(connect(w, '/api/v1/stream', { cookie: owner.cookie, origin: `${ORIGIN}.evil.example` }))).toEqual({ status: 403, error: 'origin_refused' });
    expect(await refused(connect(w, '/api/v1/stream', { cookie: owner.cookie, origin: 'http://wallet.test' }))).toEqual({ status: 403, error: 'origin_refused' });
    expect(await refused(connect(w, '/api/v1/stream', { cookie: owner.cookie }))).toEqual({ status: 403, error: 'origin_refused' });   // no Origin at all
    expect(await refused(connect(w, '/api/v1/stream', { cookie: owner.cookie, origin: 'null' }))).toEqual({ status: 403, error: 'origin_refused' });
    expect((await w.app.inject({ method: 'GET', url: '/api/v1/stream', headers: { cookie: owner.cookie } })).json()).toMatchObject({ error: 'origin_refused' });   // the same answer without an upgrade
    const c = await connect(w, '/api/v1/stream', own());
    expect(c.msgs[0]).toMatchObject({ v: 1, type: 'hello', heartbeatMs: 15_000, limits: { maxSubscriptions: 300, maxFrameBytes: 16 * 1024 } });
    // an API key is accepted under /api/v1/trading/ only
    const k = await newKey();
    expect(await refused(connect(w, '/api/v1/stream', { authorization: `Bearer ${k.token}` }))).toEqual({ status: 403, error: 'key_path_forbidden' });
    // a plain GET (no upgrade) on the stream route is not a page
    const plain = await w.app.inject({ method: 'GET', url: '/api/v1/stream', headers: { cookie: owner.cookie, origin: ORIGIN } });
    expect(plain.statusCode).toBe(404);
    expect(plain.headers['content-security-policy']).toContain("connect-src 'self' wss://wallet.test;");
    const st = await w.app.inject({ method: 'GET', url: '/api/v1/stream/stats', headers: { cookie: owner.cookie } });
    expect(st.json()).toMatchObject({ protocol: 1, connections: { open: 1, byPrincipal: { owner: 1 }, refused: 6 } });
    expect((await w.app.inject({ method: 'GET', url: '/api/v1/stream/stats' })).statusCode).toBe(401);
    expect((await w.app.inject({ method: 'GET', url: '/api/v1/stream/stats', headers: { authorization: `Bearer ${k.token}` } })).json()).toMatchObject({ error: 'key_path_forbidden' });
    c.ws.close();
  });

  it('API stream: a key in the Authorization header with markets:read; never a key in the query string; the cookie still needs the Origin', async () => {
    const w = await boot(), T = '/api/v1/trading/stream';
    const k = await newKey(), noScope = await newKey({ scopes: ['wallet:read', 'orders:read'] });
    const c = await connect(w, T, { authorization: `Bearer ${k.token}` });
    expect(c.msgs[0]).toMatchObject({ type: 'hello' });
    expect(await refused(connect(w, T, { authorization: `Bearer ${noScope.token}` }))).toEqual({ status: 403, error: 'insufficient_scope' });
    expect(await refused(connect(w, T, { authorization: `Bearer ${k.token.slice(0, -2)}xx` }))).toEqual({ status: 401, error: 'unauthenticated' });
    expect(await refused(connect(w, T))).toEqual({ status: 401, error: 'unauthenticated' });
    for (const q of [`?key=${k.token}`, `?token=${k.token}`, `?authorization=${encodeURIComponent(`Bearer ${k.token}`)}`, `?ticket=${k.token}`]) expect((await refused(connect(w, T + q))).status, q).toBe(401);
    expect(await refused(connect(w, T, { authorization: `Bearer ${k.token}`, cookie: owner.cookie, origin: ORIGIN }))).toEqual({ status: 403, error: 'mixed_credentials' });
    // the owner's browser may use this endpoint too — under the same Origin rule
    expect(await refused(connect(w, T, { cookie: owner.cookie, origin: 'https://evil.example' }))).toEqual({ status: 403, error: 'origin_refused' });
    const o = await connect(w, T, own());
    const st = (await w.app.inject({ method: 'GET', url: '/api/v1/stream/stats', headers: { cookie: owner.cookie } })).json();
    expect(st.connections.byPrincipal).toEqual({ api_key: 1, owner: 1 });
    c.ws.close(); o.ws.close();
  });

  it('a stream ticket: single use, short-lived, bound to the principal that asked for it, never mixed with another credential', async () => {
    const w = await boot({ ticketTtlMs: 400 }), T = '/api/v1/trading/stream';
    const k = await newKey({ venues: ['hyperliquid'] }), noScope = await newKey({ scopes: ['wallet:read'] });
    const ask = async (headers: Record<string, string>) => w.app.inject({ method: 'POST', url: `${T}/ticket`, headers: { 'content-type': 'application/json', ...headers }, payload: '{}' });
    expect((await ask({})).statusCode).toBe(403);                                   // no credential: the CSRF check answers first
    expect((await ask({ authorization: `Bearer ${noScope.token}` })).json()).toMatchObject({ error: 'insufficient_scope' });
    expect((await ask({ cookie: owner.cookie })).json()).toMatchObject({ error: 'csrf' });   // the owner's POST needs Origin + the CSRF header like every other
    const r = await ask({ authorization: `Bearer ${k.token}` });
    expect(r.statusCode).toBe(200);
    const t1 = r.json() as { ticket: string; url: string; ttlMs: number; expiresAt: number };
    expect(t1).toMatchObject({ ttlMs: 400, protocol: 1 }); expect(t1.ticket).toMatch(/^spw_tkt_[A-Za-z0-9_-]{32}$/); expect(t1.url).toBe(`${T}?ticket=${t1.ticket}`);
    expect(t1.ticket).not.toContain(k.token.slice(-20));
    // a browser: no header at all, any Origin — the ticket is the credential
    const c = await connect(w, t1.url, { origin: 'https://some-app.example' });
    c.send({ op: 'subscribe', channels: [sub('hyperliquid:BTC'), sub('dydx:BTC')] });
    await c.next('subscribed'); expect((await c.next('error')).code).toBe('restricted');   // the key's restrictions came with the ticket
    expect(await refused(connect(w, t1.url))).toEqual({ status: 401, error: 'unauthenticated' });   // single use
    const t2 = (await ask({ authorization: `Bearer ${k.token}` })).json().ticket as string;
    expect(await refused(connect(w, `${T}?ticket=${t2}`, { authorization: `Bearer ${k.token}` }))).toEqual({ status: 403, error: 'mixed_credentials' });
    expect(await refused(connect(w, `${T}?ticket=${t2}`))).toEqual({ status: 401, error: 'unauthenticated' });   // presented once — with a second credential — it is spent
    const t3 = (await ask({ authorization: `Bearer ${k.token}` })).json().ticket as string;
    await sleep(450);
    expect(await refused(connect(w, `${T}?ticket=${t3}`))).toEqual({ status: 401, error: 'unauthenticated' });   // expired
    expect(await refused(connect(w, `/api/v1/stream?ticket=${(await ask({ authorization: `Bearer ${k.token}` })).json().ticket}`))).toEqual({ status: 401, error: 'unauthenticated' });   // tickets open the trading stream only
    // the owner can take one too (cookie + CSRF), e.g. for a page of another origin he controls
    const ot = (await ask({ cookie: owner.cookie, origin: ORIGIN, 'x-spw-csrf': '1' })).json().ticket as string;
    const oc = await connect(w, `${T}?ticket=${ot}`);
    const st = (await w.app.inject({ method: 'GET', url: '/api/v1/stream/stats', headers: { cookie: owner.cookie } })).json();
    expect(st.tickets).toMatchObject({ issued: 5, used: 2, pending: 1 });   // pending: the one shown to the wrong path was never presented where tickets are read — it expires by itself expect(st.tickets.refused).toBeGreaterThanOrEqual(3);
    expect(st.connections.byPrincipal).toEqual({ api_key: 1, owner: 1 });
    c.ws.close(); oc.ws.close();
  });

  it('a key restricted to venues or instruments is refused per subscription, the rest of its subscriptions go through', async () => {
    const w = await boot();
    const k = await newKey({ venues: ['hyperliquid', 'gmx'], instruments: ['hyperliquid:BTC', 'gmx:BTC'] });
    const c = await connect(w, '/api/v1/trading/stream', { authorization: `Bearer ${k.token}` });
    c.send({ op: 'subscribe', reqId: 'r1', channels: [sub('hyperliquid:BTC'), sub('hyperliquid:ETH'), sub('dydx:BTC'), sub('gmx:BTC'), sub('hyperliquid:ETH', 'book'), sub('*', 'status')] });
    await c.next('subscribed', (m) => m.key === 'status|*|');
    expect(c.of('subscribed').map((m) => m.key)).toEqual(['quote|hyperliquid:BTC|', 'quote|gmx:BTC|', 'status|*|']);
    expect(c.of('error').map((m) => [m.code, m.channel?.id, m.reqId])).toEqual([['restricted', 'hyperliquid:ETH', 'r1'], ['restricted', 'dydx:BTC', 'r1'], ['restricted', 'hyperliquid:ETH', 'r1']]);
    expect(w.hl.log).toEqual(['open ticker BTC', 'open bbo BTC']); expect(w.dydx.feeds.length).toBe(0);   // nothing was opened upstream for a refused market
    c.ws.close();
  });
});

describe('protocol', () => {
  it('subscribe → `subscribed` with the last known value and its age at once, then live messages; unsubscribe; ping', async () => {
    const w = await boot();
    const a = await connect(w, '/api/v1/stream', own());
    a.send({ v: 1, op: 'subscribe', reqId: 7, channels: [sub('hyperliquid:BTC'), sub('hyperliquid:BTC', 'book', { depth: 5 }), sub('hyperliquid:BTC', 'trades'), sub('hyperliquid:BTC', 'candle', { interval: '5m' }), sub('*', 'status')] });
    const s0 = await a.next('subscribed', (m) => m.key === 'status|*|');
    expect(a.of('subscribed').map((m) => [m.key, m.snapshot === null, m.snapshotAgeMs, m.source, m.staleAfterMs, m.reqId])).toEqual([
      ['quote|hyperliquid:BTC|', true, null, 'hyperliquid-ws', 15_000, 7], ['book|hyperliquid:BTC|5', true, null, 'hyperliquid-ws', 15_000, 7], ['trades|hyperliquid:BTC|', true, null, 'hyperliquid-ws', 15_000, 7],
      ['candle|hyperliquid:BTC|5m', true, null, 'hyperliquid-ws', 15_000, 7], ['status|*|', false, 0, null, null, 7]]);
    expect((s0.snapshot as any[]).map((x) => [x.venue, x.status])).toEqual([['hyperliquid', 'reconnecting'], ['dydx', 'idle'], ['gmx', 'idle']]);
    w.hl.status('connected');
    expect(await a.next('status')).toMatchObject({ venue: 'hyperliquid', status: 'connected', transport: 'stream' });
    w.hl.feed('bbo', 'BTC').sink.quote({ bid: '65085', bidSize: '1.5', ask: '65086', askSize: '2', venueTs: Date.now() - 30 });
    w.hl.feed('ticker', 'BTC').sink.quote({ mark: '65087', index: '65115', funding: '0.0000125', openInterest: '36159.5', venueTs: null });
    w.hl.feed('book', 'BTC').sink.book({ bids: L(['65085', '1.5'], ['65084', '3']), asks: L(['65086', '2']), venueTs: Date.now() - 20 });
    w.hl.feed('book', 'BTC').sink.book({ bids: L(['65085', '0.5'], ['65084', '3']), asks: L(['65086', '2']), venueTs: Date.now() - 10 });
    w.hl.feed('trades', 'BTC').sink.trades([{ id: 't1', price: '65085', size: '0.1', side: 'sell', ts: Date.now() - 5 }]);
    w.hl.feeds.find((f) => f.spec.kind === 'candle')!.sink.candle({ ts: 1_794_798_600_000, open: '65000', high: '65100', low: '64990', close: '65085', volume: '12.5' });
    await a.next('candle');
    expect(a.of('quote').at(-1)).toMatchObject({ id: 'hyperliquid:BTC', bid: '65085', ask: '65086', mid: '65085.5', mark: '65087', index: '65115', last: null, seq: 2, source: 'hyperliquid-ws', stale: false });
    expect(a.of('book').map((m) => [m.kind, m.seq, m.prevSeq, m.depth])).toEqual([['snapshot', 1, null, 5], ['delta', 2, 1, 5]]);
    expect(a.of('trade')[0]).toMatchObject({ trades: [{ id: 't1', side: 'sell' }], snapshot: true });
    expect(a.of('candle')[0]).toMatchObject({ interval: '5m', close: '65085' });

    // a second connection: ONE upstream, and the last value is there at once, with its age
    await sleep(60);
    const b = await connect(w, '/api/v1/stream', own());
    b.send({ op: 'subscribe', channels: [sub('hyperliquid:BTC'), sub('hyperliquid:BTC', 'book', { depth: 5 }), sub('hyperliquid:BTC', 'trades')] });
    await b.next('subscribed', (m) => m.key === 'trades|hyperliquid:BTC|');
    const [bq, bb, bt] = b.of('subscribed');
    expect(bq!.snapshot).toMatchObject({ type: 'quote', mark: '65087', bid: '65085', seq: 2 }); expect(bq!.snapshotAgeMs).toBeGreaterThanOrEqual(50);
    expect(bb!.snapshot).toMatchObject({ type: 'book', kind: 'snapshot', seq: 2, prevSeq: null, bids: [['65085', '0.5'], ['65084', '3']] });
    expect(bt!.snapshot).toMatchObject({ type: 'trade', snapshot: true, trades: [{ id: 't1' }] });
    expect(w.hl.log.filter((l) => l.startsWith('open')).length).toBe(5);             // ticker, bbo, book, trades, candle — once
    w.hl.feed('book', 'BTC').sink.book({ bids: L(['65084', '3']), asks: L(['65086', '2']), venueTs: null });
    expect(await b.next('book')).toMatchObject({ kind: 'delta', seq: 3, prevSeq: 2, bids: [['65085', '0']] });   // follows the snapshot it was given

    // subscribing again to a channel one already has = "the snapshot again" (a client that found a hole)
    b.send({ op: 'subscribe', reqId: 'again', channels: [sub('hyperliquid:BTC', 'book', { depth: 5 })] });
    expect((await b.next('subscribed', (m) => m.reqId === 'again')).snapshot).toMatchObject({ kind: 'snapshot', seq: 3 });
    b.send({ op: 'unsubscribe', reqId: 'u', channels: [sub('hyperliquid:BTC'), sub('hyperliquid:NOPE')] });
    await b.next('unsubscribed', (m) => m.channel.id === 'hyperliquid:NOPE');
    const n = b.of('quote').length;
    w.hl.feed('ticker', 'BTC').sink.quote({ mark: '65090', venueTs: null });
    await a.next('quote', (q) => q.mark === '65090'); await sleep(20);
    expect(b.of('quote').length).toBe(n);
    b.send({ op: 'ping', t: 42 });
    expect(await b.next('pong')).toMatchObject({ v: 1, t: 42 });
    a.ws.close(); b.ws.close();
    await until(() => w.hl.open().length === 0, 'the upstream feeds to be released after the idle grace');
  });

  it('malformed, unknown and unsupported requests get an `error` frame with a stable code; the connection stays usable', async () => {
    const w = await boot();
    const c = await connect(w, '/api/v1/stream', own());
    const errorOf = async (frame: unknown) => { c.send(frame); return (await c.next('error')); };
    expect(await errorOf('not json at all')).toMatchObject({ v: 1, code: 'bad_frame' });
    c.ws.send(Buffer.from('{"op":"ping"}'), { binary: true }); expect(await c.next('error')).toMatchObject({ code: 'bad_frame' });   // binary frames are not part of the protocol
    expect(await errorOf({ v: 2, op: 'ping' })).toMatchObject({ code: 'unsupported_version' });
    expect(await errorOf({ op: 'order', channels: [] })).toMatchObject({ code: 'bad_message' });
    expect(await errorOf({ op: 'subscribe', channels: [] })).toMatchObject({ code: 'bad_message' });
    expect(await errorOf({ op: 'subscribe', channels: [{ type: 'quote', id: 'hyperliquid:BTC', side: 'buy' }] })).toMatchObject({ code: 'bad_message' });   // unknown field
    expect(await errorOf({ op: 'subscribe', channels: [sub('hyperliquid:BTC', 'book', { depth: 7 })] })).toMatchObject({ code: 'bad_message' });
    expect(await errorOf({ op: 'subscribe', channels: [sub('<script>')] })).toMatchObject({ code: 'bad_message' });
    expect(await errorOf({ op: 'subscribe', reqId: 3, channels: [sub('hyperliquid:NOPE')] })).toMatchObject({ code: 'unknown_instrument', channel: { id: 'hyperliquid:NOPE' }, reqId: 3 });
    expect(await errorOf({ op: 'subscribe', channels: [sub('binance:BTC')] })).toMatchObject({ code: 'unknown_instrument' });
    expect(await errorOf({ op: 'subscribe', channels: [sub('gmx:BTC', 'book')] })).toMatchObject({ code: 'unsupported_channel' });
    expect(w.hl.feeds.length + w.gmx.feeds.length).toBe(0);
    c.send({ op: 'subscribe', channels: [sub('hyperliquid:BTC')] });
    expect(await c.next('subscribed')).toMatchObject({ key: 'quote|hyperliquid:BTC|' });
    c.ws.close();
  });

  it('limits: frame size, subscriptions per connection, frames per second, connections per principal', async () => {
    const w = await boot({ maxSubscriptions: 3, maxMessagesPerSec: 5, maxConnectionsOwner: 2, maxConnectionsPerKey: 1, maxFrameBytes: 2048 });
    const c = await connect(w, '/api/v1/stream', own());
    expect(c.msgs[0]).toMatchObject({ limits: { maxSubscriptions: 3, maxFrameBytes: 2048, maxMessagesPerSec: 5 } });
    c.send({ op: 'subscribe', channels: [sub('hyperliquid:BTC'), sub('hyperliquid:ETH'), sub('hyperliquid:SOL'), sub('dydx:BTC'), sub('hyperliquid:BTC')] });
    expect(await c.next('error')).toMatchObject({ code: 'too_many_subscriptions', channel: { id: 'dydx:BTC' } });
    await c.next('subscribed', (m) => m.key === 'quote|hyperliquid:BTC|' && c.of('subscribed').length === 4);   // the one it already has is answered again, not counted twice
    // more frames than the bucket holds (burst = 2 × 5): the excess is refused, the connection survives
    for (let k = 0; k < 25; k++) c.send({ op: 'ping', t: k });
    await until(() => c.of('pong').length + c.of('error').filter((e) => e.code === 'rate_limited').length === 25, 'the answers to 25 pings');
    expect(c.of('pong').length).toBeGreaterThanOrEqual(8); expect(c.of('pong').length).toBeLessThanOrEqual(11);
    expect(c.of('error').some((e) => e.code === 'rate_limited')).toBe(true); expect(c.closed).toBeNull();
    // … but a client that keeps flooding (20 refusals in a row) is closed
    for (let k = 0; k < 60; k++) c.send({ op: 'ping' });
    expect(await c.untilClosed()).toMatchObject({ code: 4002 });
    // an oversized frame closes the connection (1009), whatever it contains
    const big = await connect(w, '/api/v1/stream', own());
    big.send({ op: 'ping', pad: 'x'.repeat(4000) });
    expect((await big.untilClosed()).code).toBe(1009);
    // connections per principal
    const c1 = await connect(w, '/api/v1/stream', own()), c2 = await connect(w, '/api/v1/stream', own());
    expect(await refused(connect(w, '/api/v1/stream', own()))).toEqual({ status: 429, error: 'too_many_connections' });
    const k = await newKey();
    const k1 = await connect(w, '/api/v1/trading/stream', { authorization: `Bearer ${k.token}` });       // the owner's limit is not the key's
    expect(await refused(connect(w, '/api/v1/trading/stream', { authorization: `Bearer ${k.token}` }))).toEqual({ status: 429, error: 'too_many_connections' });
    c1.ws.close(); await c1.untilClosed(); await until(() => w.engineConns() === 2, 'the slot to be free');
    const c3 = await connect(w, '/api/v1/stream', own());                           // a closed connection frees its slot
    c2.ws.close(); c3.ws.close(); k1.ws.close();
  });
});

describe('backpressure with a really slow consumer', () => {
  it('quotes and books are conflated to the latest, trades are dropped with a counter, a healthy client on the same hub is not affected', async () => {
    const w = await boot({ lowWaterBytes: 8 * 1024, highWaterBytes: 512 * 1024 * 1024 });
    const slow = await connect(w, '/api/v1/stream', own()), fast = await connect(w, '/api/v1/stream', own());
    const channels = [sub('hyperliquid:BTC'), sub('hyperliquid:ETH'), sub('hyperliquid:BTC', 'book'), sub('hyperliquid:BTC', 'trades')];
    slow.send({ op: 'subscribe', channels }); fast.send({ op: 'subscribe', channels });
    await slow.next('subscribed', (m) => m.key === 'trades|hyperliquid:BTC|'); await fast.next('subscribed', (m) => m.key === 'trades|hyperliquid:BTC|');
    w.hl.status('connected');
    (slow.ws as any)._socket.pause();                                               // the client stops reading: the kernel buffers fill, then the server's
    const N = 6000, pad = 'x'.repeat(40);
    for (let k = 1; k <= N; k++) {
      w.hl.feed('ticker', 'BTC').sink.quote({ mark: String(60000 + k), venueTs: null }); w.hl.feed('ticker', 'ETH').sink.quote({ mark: String(1800 + k), venueTs: null });
      w.hl.feed('book', 'BTC').sink.book({ bids: Array.from({ length: 20 }, (_, i): [string, string] => [String(60000 - i), `${k}.${i}`]), asks: L(['60001', String(k)]), venueTs: null });
      w.hl.feed('trades', 'BTC').sink.trades([{ id: `t${k}-${pad}`, price: '60000', size: '1', side: 'buy', ts: Date.now() }]);
      await new Promise((r) => setImmediate(r));                                    // one upstream burst per turn of the event loop, as in production
    }
    await until(() => fast.of('quote').filter((q) => q.id === 'hyperliquid:BTC').at(-1)?.mark === String(60000 + N), 'the healthy client to have everything');
    const s1 = (await w.app.inject({ method: 'GET', url: '/api/v1/stream/stats', headers: { cookie: owner.cookie } })).json();
    expect(s1.backpressure.conflated).toBeGreaterThan(1000); expect(s1.backpressure.tradesDropped).toBeGreaterThan(1000); expect(s1.backpressure.queuedNow).toBeLessThanOrEqual(3);   // bounded: one entry per channel
    // the healthy client got every message, in order
    expect(fast.of('quote').filter((q) => q.id === 'hyperliquid:BTC').length).toBe(N); expect(fast.of('trade').reduce((s, t) => s + t.trades.length, 0)).toBe(N); expect(fast.of('dropped').length).toBe(0);
    (slow.ws as any)._socket.resume();
    await until(() => slow.of('quote').some((q) => q.id === 'hyperliquid:BTC' && q.mark === String(60000 + N)) && slow.of('quote').some((q) => q.id === 'hyperliquid:ETH' && q.mark === String(1800 + N)) && slow.of('dropped').length > 0, 'the slow client to catch up');
    // it has the LATEST of everything, far fewer messages, an explicit count of the trades it did not get, and a book it can trust
    expect(slow.of('quote').length).toBeLessThan(N); expect(slow.closed).toBeNull();
    const droppedTotal = slow.of('dropped').at(-1)!.total, got = slow.of('trade').reduce((s, t) => s + t.trades.length, 0);
    expect(slow.of('dropped')[0]).toMatchObject({ v: 1, channel: 'trades', id: 'hyperliquid:BTC' }); expect(got + droppedTotal).toBe(N);   // delivered + declared dropped = everything: nothing lost silently
    await until(() => slow.of('book').at(-1)?.seq === N, 'the last book');
    let seq: number | null = null, bids: Level[] = [], asks: Level[] = [];
    for (const b of slow.of('book')) {
      if (b.kind === 'delta') { expect(b.prevSeq, `delta ${b.seq}`).toBe(seq); bids = applyLevels(bids, b.bids, 'bids', b.depth); asks = applyLevels(asks, b.asks, 'asks', b.depth); }   // never a delta over a hole
      else { bids = b.bids; asks = b.asks; }
      seq = b.seq; expect(bookChecksum(bids, asks), `checksum of ${b.seq}`).toBe(b.checksum);
    }
    expect(slow.of('book').filter((b) => b.kind === 'snapshot').length).toBeGreaterThan(1);
    expect(asks).toEqual([['60001', String(N)]]); expect(bids[0]).toEqual(['60000', `${N}.0`]);
    slow.ws.close(); fast.ws.close();
  });

  it('a client that stays over the high-water mark is disconnected (4003) and the others go on', async () => {
    const w = await boot({ lowWaterBytes: 512 * 1024 * 1024, highWaterBytes: 256 * 1024, overMs: 150 });   // no conflation here: the buffer really grows
    const slow = await connect(w, '/api/v1/stream', own()), fast = await connect(w, '/api/v1/stream', own());
    slow.send({ op: 'subscribe', channels: [sub('hyperliquid:BTC', 'trades')] }); fast.send({ op: 'subscribe', channels: [sub('hyperliquid:BTC', 'trades')] });
    await slow.next('subscribed'); await fast.next('subscribed');
    (slow.ws as any)._socket.pause();
    const pad = 'x'.repeat(600);
    for (let k = 1; k <= 30_000 && w.engineConns() === 2; k++) { w.hl.feed('trades', 'BTC').sink.trades([{ id: `t${k}-${pad}`, price: '1', size: '1', side: 'buy', ts: Date.now() }]); if (k % 200 === 0) await sleep(2); }
    await until(() => w.engineConns() === 1, 'the slow client to be cut');
    const st = (await w.app.inject({ method: 'GET', url: '/api/v1/stream/stats', headers: { cookie: owner.cookie } })).json();
    expect(st.backpressure.slowConsumersClosed).toBe(1); expect(st.connections.open).toBe(1);
    (slow.ws as any)._socket.resume();
    expect(await slow.untilClosed()).toMatchObject({ code: expect.any(Number) });   // 4003 when the close frame got through, 1006 when the server had to cut the connection
    expect([4003, 1006]).toContain(slow.closed!.code);
    w.hl.feed('trades', 'BTC').sink.trades([{ id: 'after', price: '1', size: '1', side: 'buy', ts: Date.now() }]);
    await fast.next('trade', (m) => m.trades[0]!.id === 'after');
    fast.ws.close();
  });
});

describe('liveness, credentials, shutdown', () => {
  it('heartbeat frames; a peer that stops answering pings is terminated; an idle connection is closed', async () => {
    const w = await boot({ heartbeatMs: 80, idleTimeoutMs: 400, recheckMs: 60_000 });
    const idle = await connect(w, '/api/v1/stream', own()), live = await connect(w, '/api/v1/stream', own()), dead = await connect(w, '/api/v1/stream', own());
    live.send({ op: 'subscribe', channels: [sub('hyperliquid:BTC')] }); dead.send({ op: 'subscribe', channels: [sub('hyperliquid:BTC')] });
    await live.next('subscribed'); await dead.next('subscribed');
    expect(await live.next('heartbeat')).toMatchObject({ v: 1, subscriptions: 1 });
    (dead.ws as any)._socket.pause();                                               // it no longer reads: no pong goes back
    expect(await idle.untilClosed()).toMatchObject({ code: 4004, reason: 'idle' });   // nothing subscribed, nothing said
    await until(() => w.engineConns() === 1, 'the dead peer to be terminated');
    expect(live.closed).toBeNull(); expect(live.of('heartbeat').length).toBeGreaterThan(3);
    const st = (await w.app.inject({ method: 'GET', url: '/api/v1/stream/stats', headers: { cookie: owner.cookie } })).json();
    expect(st.clients.deadPeers).toBe(1);
    live.ws.close(); dead.ws.terminate();
  });

  it('logout closes the sockets of THAT session at once (4001); an expired session is closed at the next check; other sessions stay', async () => {
    const w = await boot({ heartbeatMs: 100, recheckMs: 200 });
    const s1 = await newSession(), s2 = await newSession(), s3 = await newSession();
    const a = await connect(w, '/api/v1/stream', { cookie: s1.cookie, origin: ORIGIN }), b = await connect(w, '/api/v1/stream', { cookie: s2.cookie, origin: ORIGIN }), c = await connect(w, '/api/v1/stream', { cookie: s3.cookie, origin: ORIGIN });
    const t0 = Date.now();
    const out = await w.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: s1.cookie, origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' }, payload: '{}' });
    expect(out.statusCode).toBe(200);
    expect(await a.untilClosed()).toEqual({ code: 4001, reason: 'the session ended' });
    expect(Date.now() - t0).toBeLessThan(150);                                      // not at the periodic check: at once
    expect(b.closed).toBeNull();
    await sql`update sessions set expires_at = now() - interval '1 second' where id_hash = ${sha(s2.token)}`;
    expect(await b.untilClosed()).toEqual({ code: 4001, reason: 'the session ended' });
    expect(c.closed).toBeNull();
    expect(await refused(connect(w, '/api/v1/stream', { cookie: s1.cookie, origin: ORIGIN }))).toEqual({ status: 401, error: 'unauthenticated' });   // and it cannot come back
    c.ws.close();
  });

  it('revoking an API key closes its sockets (4001), by header or by ticket; another key is untouched', async () => {
    const w = await boot({ heartbeatMs: 100, recheckMs: 60_000 });
    const k1 = await newKey(), k2 = await newKey();
    const a = await connect(w, '/api/v1/trading/stream', { authorization: `Bearer ${k1.token}` });
    const ticket = (await w.app.inject({ method: 'POST', url: '/api/v1/trading/stream/ticket', headers: { authorization: `Bearer ${k1.token}`, 'content-type': 'application/json' }, payload: '{}' })).json().ticket;
    const viaTicket = await connect(w, `/api/v1/trading/stream?ticket=${ticket}`), other = await connect(w, '/api/v1/trading/stream', { authorization: `Bearer ${k2.token}` });
    const r = await w.app.inject({ method: 'POST', url: `/api/v1/developer/keys/${k1.id}/revoke`, headers: { cookie: owner.cookie, origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' }, payload: JSON.stringify({ reason: 'test' }), remoteAddress: '10.9.9.9' });
    expect(r.statusCode, r.body).toBe(200);
    expect(await a.untilClosed()).toEqual({ code: 4001, reason: 'the API key is no longer active' });
    expect(await viaTicket.untilClosed()).toMatchObject({ code: 4001 });
    expect(other.closed).toBeNull();
    expect(await refused(connect(w, '/api/v1/trading/stream', { authorization: `Bearer ${k1.token}` }))).toEqual({ status: 401, error: 'unauthenticated' });
    // an expired key: closed at the periodic check
    const w2 = await boot({ heartbeatMs: 100, recheckMs: 150 });
    const k3 = await newKey(), e = await connect(w2, '/api/v1/trading/stream', { authorization: `Bearer ${k3.token}` });
    await sql`update api_keys set expires_at = now() - interval '1 second' where id = ${k3.id}`;
    expect(await e.untilClosed()).toMatchObject({ code: 4001 });
    other.ws.close();
  });

  it('graceful shutdown: every client is told (1001 + reason), the upstream feeds are released, the upstreams closed', async () => {
    const w = await boot();
    const a = await connect(w, '/api/v1/stream', own()), k = await newKey(), b = await connect(w, '/api/v1/trading/stream', { authorization: `Bearer ${k.token}` });
    a.send({ op: 'subscribe', channels: [sub('hyperliquid:BTC'), sub('dydx:BTC', 'book')] });
    await a.next('subscribed', (m) => m.key === 'book|dydx:BTC|20');
    await w.app.close();
    expect(await a.untilClosed()).toEqual({ code: 1001, reason: 'server shutting down' });
    expect(await b.untilClosed()).toEqual({ code: 1001, reason: 'server shutting down' });
    expect(w.hl.open().length + w.dydx.open().length).toBe(0); expect(w.hl.closed && w.dydx.closed && w.gmx.closed).toBe(true);
  });

  it('the monitor health answer and the stats carry the engine\'s figures; lag is measured from the venue\'s timestamp', async () => {
    const w = await boot();
    const c = await connect(w, '/api/v1/stream', own());
    c.send({ op: 'subscribe', channels: [sub('hyperliquid:BTC'), sub('gmx:BTC')] });
    await c.next('subscribed', (m) => m.key === 'quote|gmx:BTC|');
    w.hl.status('connected'); w.gmx.status('connected');
    for (let k = 0; k < 20; k++) w.hl.feed('bbo', 'BTC').sink.quote({ bid: String(65000 + k), bidSize: '1', ask: String(65002 + k), askSize: '1', venueTs: Date.now() - 120 });
    w.gmx.feed('ticker', 'BTC').sink.quote({ mark: '65001', venueTs: null });
    await c.next('quote', (q) => q.id === 'gmx:BTC');
    w.hl.status('reconnecting'); w.hl.status('connected');
    const st = (await w.app.inject({ method: 'GET', url: '/api/v1/stream/stats', headers: { cookie: owner.cookie } })).json();
    expect(st).toMatchObject({ subscriptions: 2, upstreamReconnects: 1, hub: { channels: 2, feeds: 3, counters: { quote: 21 } } });
    expect(st.lagMs.samples).toBe(20); expect(st.lagMs.p50).toBeGreaterThanOrEqual(120); expect(st.lagMs.p95).toBeLessThan(1000);   // only frames that carry a venue timestamp are measured
    expect(st.hub.venues.map((v: any) => [v.venue, v.status, v.transport, v.feeds])).toEqual([['hyperliquid', 'connected', 'stream', 2], ['dydx', 'idle', 'stream', 0], ['gmx', 'connected', 'poll', 1]]);
    expect(st.messagesSent).toBeGreaterThanOrEqual(24);
    const h = (await w.app.inject({ method: 'GET', url: '/api/v1/monitor/health', headers: { cookie: owner.cookie } })).json();
    expect(h.quotes).toMatchObject({ connections: 1, subscriptions: 2, upstreamReconnects: 1 }); expect(h.quotes.venues.length).toBe(3);
    c.ws.close();
  });
});
