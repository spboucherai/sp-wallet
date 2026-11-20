// NEXT — the wallet event stream: ids only grow, a client resumes where it stopped, a position that cannot be resumed is
// told so, nothing is served without a session. The SSE route is read over a real socket.
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from './test-db.ts';

let sql: any, app: any, db: typeof import('../src/db.ts'), ev: typeof import('../src/events.ts'), base = '';
const token = 'e'.repeat(43), cookie = `__Host-spw=${token}`;
const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers: { cookie, ...headers } });

beforeAll(async () => {
  await useTestDatabase('events');
  db = await import('../src/db.ts'); sql = db.sql;
  await db.migrate();
  ev = await import('../src/events.ts');
  app = await (await import('../src/server.ts')).buildServer();
  await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => { await app?.close(); await sql?.end(); });
beforeEach(async () => { await sql`truncate wallet_events restart identity`; });

/** Read an SSE response until `until` events with an id were seen (or the time is up); returns the parsed events. */
async function readStream(path: string, headers: Record<string, string>, until: number, during?: () => Promise<void>): Promise<{ id: number | null; event: string; data: any }[]> {
  const ctl = new AbortController(), out: { id: number | null; event: string; data: any }[] = [];
  const res = await fetch(base + path, { headers: { cookie, ...headers }, signal: ctl.signal });
  expect(res.status).toBe(200); expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
  const reader = res.body!.getReader(), dec = new TextDecoder();
  const timer = setTimeout(() => ctl.abort(), 8000);
  let buf = '', fired = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k: number;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, k); buf = buf.slice(k + 2);
        const f: Record<string, string> = {};
        for (const line of block.split('\n')) { const c = line.indexOf(': '); if (c > 0) f[line.slice(0, c)] = line.slice(c + 2); }
        if (f.event) out.push({ id: f.id ? Number(f.id) : null, event: f.event, data: f.data ? JSON.parse(f.data) : null });
      }
      if (!fired && during && out.length) { fired = true; await during(); }
      if (out.filter((e) => e.id !== null).length >= until) break;
    }
  } catch { /* aborted */ } finally { clearTimeout(timer); ctl.abort(); }
  return out;
}

describe('the event log', () => {
  it('needs a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/events' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/events/stream' })).statusCode).toBe(401);
  });
  it('catch-up: rows after a position, in order, with the newest id', async () => {
    for (const t of ['transfer.state', 'deposit.seen', 'transfer.state']) await db.walletEvent(t, 'ref-' + t, { n: 1 });
    const all = (await get('/api/v1/events?after=0')).json();
    expect(all.reset).toBe(false); expect(all.events.map((e: any) => e.id)).toEqual([1, 2, 3]); expect(all.latest).toBe(3); expect(all.more).toBe(false);
    expect(all.events[1]).toMatchObject({ type: 'deposit.seen', ref: 'ref-deposit.seen', data: { n: 1 } });
    const tail = (await get('/api/v1/events?after=2')).json();
    expect(tail.events.map((e: any) => e.id)).toEqual([3]);
    expect((await get('/api/v1/events?after=3')).json().events).toEqual([]);
    const page = (await get('/api/v1/events?after=0&limit=2')).json();
    expect(page.events.length).toBe(2); expect(page.more).toBe(true);
    expect((await get('/api/v1/events?after=-1')).statusCode).toBe(400);
  });
  it('a position ahead of the log (restored database) or behind what is kept is answered `reset`', async () => {
    await db.walletEvent('a', null); await db.walletEvent('b', null);
    expect((await get('/api/v1/events?after=99')).json()).toMatchObject({ reset: true, latest: 2 });
    await sql`insert into wallet_events (id, type) values (50, 'c')`; await sql`delete from wallet_events where id < 50`;
    expect((await get('/api/v1/events?after=10')).json()).toMatchObject({ reset: true, latest: 50 });
    expect((await get('/api/v1/events?after=49')).json()).toMatchObject({ reset: false }); // nothing between 49 and 50 was lost
  });
  it('retention keeps recent rows and always the newest one', async () => {
    await sql`insert into wallet_events (at, type) values (now() - interval '40 days', 'old1'), (now() - interval '35 days', 'old2'), (now() - interval '1 day', 'recent')`;
    expect(await ev.pruneEvents()).toBe(2);
    expect((await sql`select type from wallet_events`).map((r: any) => r.type)).toEqual(['recent']);
    await sql`update wallet_events set at = now() - interval '90 days'`;
    expect(await ev.pruneEvents()).toBe(0); // a quiet wallet keeps its position
  });
  it('audit entries a client must hear about become events; the mirrored set is the documented one', async () => {
    expect(db.WALLET_EVENT_TYPES.source).toBe(ev.MIRRORED.source);
    await db.audit('device.added', 'owner', { id: 'cred-1' });
    await db.audit('login.failed', 'unknown', { why: 'x' });
    await db.audit('transfer.finalized', 'system', { id: 'p1' }); // written by `move` itself, not mirrored twice
    await db.audit('addressbook.saved', 'owner', { network: 'base' });
    expect((await ev.eventsAfter(0)).map((e) => [e.type, e.ref])).toEqual([['device.added', 'cred-1'], ['addressbook.saved', null]]);
  });
});

describe('the stream', () => {
  it('resumes after Last-Event-ID, then delivers what happens while connected — each with its id', async () => {
    for (let k = 0; k < 3; k++) await db.walletEvent('transfer.state', 'p', { k });
    const got = await readStream('/api/v1/events/stream', { 'last-event-id': '1' }, 4, async () => { await db.walletEvent('deposit.seen', 'd', {}); await db.walletEvent('halt.on', null, {}); });
    expect(got[0]).toMatchObject({ event: 'hello', id: null, data: { from: 1 } });
    expect(got.slice(1).map((e) => [e.id, e.event])).toEqual([[2, 'transfer.state'], [3, 'transfer.state'], [4, 'deposit.seen'], [5, 'halt.on']]);
    expect(got[1]!.data).toMatchObject({ id: 2, type: 'transfer.state', ref: 'p', data: { k: 1 } });
  });
  it('without a position it starts from now; an impossible position gets `reset` with the id to continue from', async () => {
    await db.walletEvent('a', null); await db.walletEvent('b', null);
    const fresh = await readStream('/api/v1/events/stream', {}, 1, async () => { await db.walletEvent('c', null); });
    expect(fresh.map((e) => [e.id, e.event])).toEqual([[null, 'hello'], [3, 'c']]);
    const lost = await readStream('/api/v1/events/stream?after=500', {}, 1);
    expect(lost[0]).toMatchObject({ event: 'reset', id: 3, data: { latest: 3 } });
  });
});
