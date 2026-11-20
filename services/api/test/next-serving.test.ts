// NEXT — how balances are served when a source is slow or down (found in the pre-production rehearsal: a cold read of the
// 23 networks took 19 s), and when a snapshot of the wallet's value stays usable although a network could not be read.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NETWORKS, type NetworkDef } from '@spw/core';
import { useTestDatabase } from './test-db.ts';
import type { Adapter } from '../src/chains/rpc.ts';

let sql: any, pf: typeof import('../src/portfolio.ts'), chains: typeof import('../src/chains/index.ts');
const saved: Record<string, Adapter> = {};
const base = NETWORKS.base as NetworkDef, ltc = NETWORKS.litecoin as NetworkDef;
/** a network whose read the test times and answers */
function fake(network: string, o: { delayMs?: number; amount?: bigint | null; fail?: boolean }) {
  const st = { ...o, calls: 0 };
  saved[network] ??= chains.adapters[network]!;
  chains.adapters[network] = { balances: async () => { st.calls += 1; if (st.delayMs) await new Promise((r) => setTimeout(r, st.delayMs)); if (st.fail) throw new Error('down'); return (st.amount === null ? {} : { native: st.amount ?? 0n }) as Record<string, bigint>; } } as unknown as Adapter;
  return st;
}
const read = (nets: NetworkDef[]) => pf.readRows(Object.fromEntries(nets.map((n) => [n.id, 'addr-' + n.id])), (n) => [n.native]);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await useTestDatabase('serving');
  const db = await import('../src/db.ts'); sql = db.sql;
  await db.migrate();
  pf = await import('../src/portfolio.ts'); chains = await import('../src/chains/index.ts');
});
afterAll(async () => { for (const [k, a] of Object.entries(saved)) chains.adapters[k] = a; await sql?.end(); });
beforeEach(async () => { pf.resetBalanceCache(); Object.assign(pf.balTiming, { ttlMs: 40, serveMs: 5_000, waitMs: 60, firstWaitMs: 150 }); await sql`delete from balance_last`; await sql`delete from portfolio_snapshots`; });

describe('serving balances', () => {
  it('a slow source does not hold the answer: the previous read is served, marked stale with its own time; the fresh one lands for the next call', async () => {
    const b = fake('base', { amount: 5n });
    const first = await read([base]);
    expect(first[0]).toMatchObject({ amount: '5', stale: false });
    await wait(60); // past the ttl
    b.delayMs = 300; b.amount = 9n;
    const t = Date.now(), second = await read([base]);
    expect(Date.now() - t).toBeLessThan(250);
    expect(second[0]).toMatchObject({ amount: '5', stale: true, readAt: first[0]!.readAt }); // the old figure, saying it is old
    await wait(350); b.delayMs = 0;
    expect((await read([base]))[0]).toMatchObject({ amount: '9', stale: false });
  });
  it('one read per network whoever asks', async () => {
    const b = fake('base', { amount: 1n, delayMs: 80 });
    await Promise.all([read([base]), read([base]), read([base])]);
    expect(b.calls).toBe(1);
  });
  it('no previous read and a source that does not answer in time: unavailable (slow_source), never zero', async () => {
    fake('base', { amount: 7n, delayMs: 400 });
    const rows = await read([base]);
    expect(rows[0]).toMatchObject({ amount: null, error: 'unavailable', reason: 'slow_source' });
  });
  it('a source that fails outright after a good read: the good read keeps being served as stale, not replaced by "unavailable"', async () => {
    const b = fake('base', { amount: 3n });
    await read([base]); await wait(60);
    b.fail = true;
    expect((await read([base]))[0]).toMatchObject({ amount: '3', stale: true });
    await wait(60);
    expect((await read([base]))[0]).toMatchObject({ amount: '3', stale: true });
  });
  it('past the serving window an old read is no longer shown', async () => {
    const b = fake('base', { amount: 3n });
    await read([base]);
    Object.assign(pf.balTiming, { serveMs: 30 }); await wait(60);
    b.fail = true;
    expect((await read([base]))[0]).toMatchObject({ amount: null, reason: 'network_unavailable' });
  });
});

describe('a snapshot when a network cannot be read', () => {
  const px = { ETH: { usd: 2000, cad: 2800 }, LTC: { usd: 80, cad: 110 } };
  const snap = async () => { pf.portfolioDeps.read = async () => { const rows = await read([base, ltc]); return { rows, px }; }; return pf.writeSnapshot(); };
  it('it held nothing the last time it was read: the point stays usable and says why', async () => {
    fake('base', { amount: 10n ** 18n }); const l = fake('litecoin', { amount: 0n });
    expect((await snap())!.complete).toBe(true);
    await wait(60); l.fail = true; Object.assign(pf.balTiming, { serveMs: 1 }); // the old read can no longer be served
    const r = await snap();
    expect(r, JSON.stringify(r)).toMatchObject({ complete: true, totals: { USD: '2000.00' } });
    const [row] = await sql`select complete, reasons from portfolio_snapshots where currency = 'USD' order by id desc limit 1`;
    expect(row.complete).toBe(true); expect(row.reasons[0]).toMatchObject({ kind: 'carried_zero', network: 'litecoin' });
    expect((await pf.history('1W', 'USD')).points.length).toBe(2);
  });
  it('it held something, or was never read: the point is recorded and never charted', async () => {
    fake('base', { amount: 10n ** 18n }); const l = fake('litecoin', { amount: 5n });
    await snap(); await wait(60); l.fail = true; Object.assign(pf.balTiming, { serveMs: 1 });
    expect((await snap())!.complete).toBe(false);
    await sql`delete from balance_last`; pf.resetBalanceCache();
    expect((await snap())!.complete).toBe(false); // never read: nothing is known about it
    const h = await pf.history('1W', 'USD');
    expect(h.points.length).toBe(1); expect(h.omitted.incomplete).toBe(2);
  });
  it('a zero read more than a week ago proves nothing', async () => {
    fake('base', { amount: 10n ** 18n }); const l = fake('litecoin', { amount: 0n });
    await snap(); await wait(60);
    await sql`update balance_last set read_at = now() - interval '8 days' where network = 'litecoin'`;
    l.fail = true; Object.assign(pf.balTiming, { serveMs: 1 });
    expect((await snap())!.complete).toBe(false);
  });
});
