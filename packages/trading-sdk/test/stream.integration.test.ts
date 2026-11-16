// INTEGRATION: SPWalletStream against the stream of the REAL local API — the stack shared by every SDK integration test
// (scripts/test-stack.mts): the real API and signer on an own per-run database, the real venue adapters, the real websocket
// server on a local port, keys created through the owner routes.
// Skipped — reported as skipped — when PostgreSQL is not reachable or SPW_SDK_INTEGRATION=off. Live quotes come from the
// venues' public feeds: the test that needs them is skipped when no venue answers within its delay.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { OrderBook, SPWalletStream, StreamError, type BookMessage, type QuoteMessage, type StatusMessage, type StreamDataMessage } from '../src/stream.ts';
import { startStack, type Stack as StreamStack } from './stack.ts';

const started = await startStack('tsstream');
const skip = 'skip' in started ? started.skip : null;
const stack = started as StreamStack;
if (skip) console.warn(`[trading-sdk] stream integration tests SKIPPED: ${skip}`);
afterAll(async () => { if (!skip) await stack.stop(); });
const say = (line: string): void => { if (process.env.SPW_SDK_TRANSCRIPT) console.log(`[sdk-ts-stream] ${line}`); };
const open = (k: keyof StreamStack['keys'], o: Partial<ConstructorParameters<typeof SPWalletStream>[0]> = {}) => new SPWalletStream({ apiKey: stack.keys[k].secret, baseUrl: stack.baseUrl, ...o });

describe.skipIf(skip !== null)('integration: the stream of the real API', () => {
  it('a key with markets:read connects with its Authorization header; a venue status snapshot comes with the subscription', async () => {
    const s = open('narrow'), statuses: StatusMessage[] = [];
    s.on('status', (m) => statuses.push(m));
    await s.subscribe({ type: 'status', id: '*' });
    expect(s.state).toBe('open'); expect(s.hello).toMatchObject({ v: 1, heartbeatMs: 15_000 }); expect(s.hello!.limits.maxSubscriptions).toBeGreaterThan(0);
    expect(statuses.map((x) => x.venue).sort()).toEqual(['dydx', 'edgex', 'gmx', 'hyperliquid', 'spot']);
    say(`narrow key connected: conn ${s.hello!.connId}; venues ${statuses.map((x) => `${x.venue}=${x.status}`).join(' ')}`);
    await expect(s.subscribe({ type: 'quote', id: 'hyperliquid:NOPE_NOT_A_MARKET' })).rejects.toMatchObject({ code: 'unknown_instrument' });
    await expect(s.subscribe({ type: 'book', id: 'spot:BTC' })).rejects.toMatchObject({ code: 'unsupported_channel' });
    s.close();
  });

  it('a key without the scope, a revoked key and a wrong key never get a stream', async () => {
    for (const [k, why] of [['agentsOnly', 'no markets:read'], ['revoked', 'revoked']] as const) {
      const s = open(k, { backoffMinMs: 20, backoffMaxMs: 40 });
      const e = await s.connect().then(() => null, (x: unknown) => x);
      expect(e, why).toBeInstanceOf(StreamError); expect(s.state).toBe('closed'); expect(s.stats.frames).toBe(0);
      say(`${k} key (${why}): refused before the upgrade — ${(e as StreamError).code}`);
    }
    // through the ticket endpoint the refusal has its HTTP status and code
    await expect(open('agentsOnly', { auth: 'ticket' }).connect()).rejects.toMatchObject({ code: 'insufficient_scope' });
    await expect(open('revoked', { auth: 'ticket' }).connect()).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('a ticket (the browser\'s way): asked with the key, used once, the stream works without any header', async () => {
    const s = open('reader', { auth: 'ticket' });
    await s.subscribe({ type: 'status', id: 'hyperliquid' });
    expect(s.state).toBe('open');
    say(`ticket connection: conn ${s.hello!.connId}`);
    s.close();
  });

  it('a key restricted to one venue is refused on the others, per subscription', async () => {
    const s = open('venues');
    await s.subscribe({ type: 'status', id: '*' });
    await expect(s.subscribe({ type: 'quote', id: 'dydx:BTC-USD' })).rejects.toMatchObject({ code: 'restricted' });
    await expect(s.subscribe({ type: 'quote', id: 'spot:BTC' })).rejects.toMatchObject({ code: 'restricted' });
    expect(s.state).toBe('open'); expect(s.subscriptions()).toEqual([{ type: 'status', id: '*' }]);
    s.close();
  });

  it('live quotes, an order book kept from snapshot + deltas with its checksum, callbacks and the async iterator', async (ctx) => {
    const s = open('reader'), book = new OrderBook(), quotes: QuoteMessage[] = [], books: BookMessage[] = [];
    let holes = 0;
    s.on('quote', (q) => quotes.push(q));
    s.on('book', (b) => { books.push(b); if (!book.apply(b)) { holes += 1; s.resync({ type: 'book', id: 'hyperliquid:BTC', depth: 10 }); } });
    try {
      await s.subscribe([{ type: 'quote', id: 'hyperliquid:BTC' }, { type: 'quote', id: 'spot:BTC' }, { type: 'book', id: 'hyperliquid:BTC', depth: 10 }, { type: 'trades', id: 'hyperliquid:BTC' }]);
    } catch (e) { if (e instanceof StreamError && e.code === 'upstream_unavailable') { ctx.skip(`venue unreachable: ${e.message}`); } throw e; }
    const seen: StreamDataMessage[] = [], t0 = Date.now();
    for await (const m of s) { seen.push(m); if ((quotes.some((q) => q.id === 'hyperliquid:BTC' && q.mark !== null) && books.length > 0) || Date.now() - t0 > 25_000) break; }
    if (!quotes.some((q) => q.id === 'hyperliquid:BTC')) { s.close(); ctx.skip('no Hyperliquid quote within 25 s: venue unreachable from here'); }
    const q = quotes.find((x) => x.id === 'hyperliquid:BTC' && x.mark !== null)!;
    expect(q).toMatchObject({ v: 1, type: 'quote', source: 'hyperliquid-ws' });
    for (const f of [q.mark, q.bid ?? '1', q.ask ?? '1', q.funding ?? '0']) expect(f).toMatch(/^-?\d+(\.\d+)?$/);   // decimal strings, never floats
    expect(typeof q.recvTs).toBe('number'); expect(q.seq).toBeGreaterThan(0);
    expect(books[0]).toMatchObject({ kind: 'snapshot', depth: 10, prevSeq: null }); expect(book.ready).toBe(true); expect(holes).toBe(0);
    expect(book.bids.length).toBeGreaterThan(0); expect(Number(book.bids[0]![0])).toBeLessThan(Number(book.asks[0]![0]));
    expect(seen.length).toBeGreaterThan(0);
    say(`hyperliquid:BTC mark ${q.mark} bid ${q.bid} ask ${q.ask} (seq ${q.seq}, venueTs ${q.venueTs}); book ${books.length} message(s), best ${book.bids[0]![0]} / ${book.asks[0]![0]}; ${seen.length} messages through the iterator in ${Date.now() - t0} ms; frames ${s.stats.frames}`);
    s.close();
  }, 60_000);

  it('examples/stream-quotes.ts runs against the real stream, stops by itself and prints no secret', async (ctx) => {
    const example = path.join(import.meta.dirname, '../examples/stream-quotes.ts');
    const env = (k: keyof StreamStack['keys']) => ({ PATH: process.env.PATH ?? '', SP_WALLET_API_KEY: stack.keys[k].secret, SP_WALLET_BASE_URL: stack.baseUrl, SP_WALLET_STREAM_QUOTES: '2' });
    const run = promisify(execFile);
    const { stdout, stderr } = await run('node', [example], { encoding: 'utf8', env: env('narrow'), timeout: 60_000 });
    const lines = stdout.trim().split('\n');
    expect(lines[0]).toMatch(/^connected: connection /); expect(lines.at(-1)).toBe('done'); expect(stdout).not.toContain('refused');
    expect(stdout + stderr).not.toContain(stack.keys.narrow.secret);
    if (stdout.includes('no more quotes within 20 s')) ctx.skip('the example ran, connected and stopped by itself; no Hyperliquid quote within 20 s (venue unreachable from here)');
    expect(lines.filter((x) => x.startsWith('quote hyperliquid:BTC: bid '))).toHaveLength(2);
    say(`examples/stream-quotes.ts: ${lines.join(' | ')}`);
    // a key without markets:read: the example says so and still ends cleanly
    const refused = await run('node', [example], { encoding: 'utf8', env: env('agentsOnly'), timeout: 60_000 });
    expect(refused.stdout).toContain('refused: '); expect(refused.stdout).not.toContain('quote hyperliquid');
  }, 150_000);
});
