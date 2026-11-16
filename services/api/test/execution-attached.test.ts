// V11 exec2 — stop-loss / take-profit attached to an order by a command, on PAPER, through the real server with a real API key
// bound to a paper mandate (and the owner). Own database; fixture-backed venue; no network.
//
//   - the entry fills → both protective orders are placed, reduce-only, sized to what FILLED, through the same order service;
//   - one cancels the other: the stop-loss executes → the take-profit is cancelled by the supervisor;
//   - an entry that is refused places nothing and closes its attachments with the reason;
//   - a replay places nothing twice;
//   - a resting entry: nothing is placed before it fills; a NEW process completes the attachment from the database alone;
//   - an entry that fills in two parts gets an additional protective order for the second part;
//   - the position is closed by hand → the protective orders are cancelled.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { createSignerServer } from '../../isolated-signer/src/server.ts';
import { Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';
import { BTC, Clock, fixtureVenues, setMarket, useDatabase, type Venues } from './derivatives-helpers.ts';

const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'k'.repeat(48), T = '/api/v1/trading', DEV = '/api/v1/developer';
const owner = new TestPasskey(RP, ORIGIN);
const ALL = ['wallet:read', 'markets:read', 'orders:read', 'orders:prepare', 'orders:execute', 'orders:cancel', 'positions:read', 'positions:manage'];
let app: any, sql: any, cookie = '', clock: Clock, v: Venues, signerSrv: Server, derivs: any, ipSeq = 0;

interface Res { status: number; json: any }
async function call(method: string, path: string, o: { key?: string | null; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...o.headers };
  if (o.key) headers.authorization = `Bearer ${o.key}`; else { headers.cookie = cookie; if (method !== 'GET') { headers.origin = ORIGIN; headers['x-spw-csrf'] = '1'; } }
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const ip = path.startsWith(DEV) ? `10.204.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}` : undefined;
  const r = await app.inject({ method, url: path, headers, payload: o.body === undefined ? undefined : JSON.stringify(o.body), ...(ip ? { remoteAddress: ip } : {}) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() };
}
const idem = () => ({ 'idempotency-key': `att-${randomUUID()}` });
const assertion = (options: { challenge: string }) => owner.assert(Buffer.from(options.challenge, 'base64url'));
const paperAccount = async (label: string): Promise<string> => { const a = await call('POST', '/api/v1/derivatives/accounts', { body: { venue: 'hyperliquid', label, collateral: '10000' } }); expect(a.status, JSON.stringify(a.json)).toBe(200); return a.json.id as string; };
/** a key bound to an approved paper mandate on its OWN paper account (stop and take-profit orders allowed) */
async function trader(over: Record<string, unknown> = {}) {
  const account = await paperAccount(`att-${randomUUID().slice(0, 8)}`);
  const p = await call('POST', `${DEV}/keys/prepare`, { body: { name: 'attached key', scopes: ALL, expiresInDays: 30, rateLimitPerMin: 600 } });
  const c = await call('POST', `${DEV}/keys`, { body: { intentId: p.json.intentId, assertion: assertion(p.json.options) } });
  const m = await call('POST', '/api/v1/mandates', { body: { mode: 'paper', principal: { kind: 'api_key', id: c.json.key.id }, accountIds: [account], instruments: [BTC], orderTypes: ['market', 'limit', 'stop', 'take_profit'], maxCapitalUsd: '5000', maxOrderNotionalUsd: '2000',
    maxPositionNotionalUsd: '4000', maxLeverage: '3', maxDailyLossUsd: '500', floorEquityUsd: '1000', days: 7, frequency: { perMinute: 30, perHour: 200, perDay: 400 }, maxSlippageBps: 100, maxFeeUsd: '10', label: 'attached', ...over } });
  expect(m.status, JSON.stringify(m.json)).toBe(200);
  expect((await call('POST', `/api/v1/mandates/${m.json.mandate.id}/approve`, { body: {} })).status).toBe(200);
  const u = await call('POST', `${DEV}/keys/${c.json.key.id}/update/prepare`, { body: { changes: { mandateId: m.json.mandate.id } } });
  expect((await call('POST', `${DEV}/keys/${c.json.key.id}/update`, { body: { intentId: u.json.intentId, assertion: assertion(u.json.options) } })).status).toBe(200);
  return { id: c.json.key.id as string, secret: c.json.secret as string, account };
}
const cmd = (key: string | null, account: string, text: string, headers = idem(), o: Record<string, unknown> = {}) => call('POST', `${T}/commands`, { ...(key ? { key } : {}), headers, body: { text, mode: 'paper', accountId: account, ...o } });
const attachments = async (parent: string) => sql`select * from order_attachments where parent_id = ${parent} order by role`;
const order = async (id: string) => (await sql`select * from orders where id = ${id}`)[0];
const childrenOf = async (parent: string) => { const out: any[] = []; for (const a of await attachments(parent)) for (const id of a.children) out.push({ role: a.role, ...(await order(id)) }); return out; };
/** the market moves and the paper engine sees it (its worker step), then the orders supervisor runs */
const step = async () => { const s = await (await import('../src/derivatives/worker.ts')).paperStep(derivs.paper); if (s.errors.length) throw new Error(s.errors.join('; ')); return s; };
const move = async (mid: number, o?: Parameters<typeof setMarket>[2]) => { setMarket(v, mid, o); clock.advance(6_000); await step(); await app.execution.orders.reconcile(); };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spw-exec-attached-'));
  signerSrv = createSignerServer(new Signer(deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), new Store(join(dir, 'state.json'), join(dir, 'policy.json')), { rpId: RP, origin: ORIGIN }), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  await useDatabase('execution_attached');
  Object.assign(process.env, { SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`, SPW_DATA_DIR: join(dir, 'data') });
  delete process.env.SPW_API_KEY_PEPPER; delete process.env.SPW_TRADING_API_EXECUTION;
  const db = await import('../src/db.ts');
  sql = db.sql;
  await db.migrate();
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
  cookie = `${(await import('../src/auth.ts')).COOKIE}=${token}`;
  const c = owner.credential();
  await sql`insert into credentials (id, public_key, counter, transports, label) values (${c.id}, ${c.publicKey}, 0, ${sql.json(c.transports)}, 'test passkey')`;
  const mod = await import('../src/derivatives/index.ts');
  clock = new Clock(); v = fixtureVenues(clock);
  setMarket(v, 50_000);
  derivs = mod.createDerivatives({ registry: mod.createRegistry(v.adapters, clock.now), now: clock.now });
  app = await (await import('../src/server.ts')).buildServer({ derivatives: derivs, gmx: { status: async () => ({ network: 'arbitrum', account: null, positionsError: null, positions: [] }) } as never });
  expect((await call('PUT', `${DEV}/command-defaults`, { body: { defaults: { perpVenue: 'hyperliquid', perpNetworkByVenue: { hyperliquid: 'mainnet' }, perpLeverage: '2', perpMarginMode: 'cross', maxFeeBps: 10, maxSlippageBps: 50, orderTtlMs: 60_000 } } })).status).toBe(200);
});
afterAll(async () => { app?.server.closeAllConnections?.(); await app?.close(); signerSrv?.close(); await sql?.end(); });

describe('attached stop-loss and take-profit', () => {
  it('the entry fills → both are placed reduce-only, sized to the fill, under the key\'s mandate; a replay places nothing twice; the stop-loss executes → the take-profit is cancelled', async () => {
    setMarket(v, 50_000); clock.advance(6_000);
    const k = await trader(), h = idem();
    const dry = await cmd(k.secret, k.account, 'LONG BTC-PERP 500 SL 45000 TP 60000', idem(), { dryRun: true });
    expect(dry.json.attached.map((a: any) => [a.role, a.placed, a.order.reduceOnly, a.order.size])).toEqual([['stop_loss', false, true, null], ['take_profit', false, true, null]]);
    expect((await sql`select count(*)::int as n from order_attachments`)[0].n).toBe(0);                 // a dry run stores nothing
    const r = await cmd(k.secret, k.account, 'LONG BTC-PERP 500 SL 45000 TP 60000', h);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const parent = r.json.order.orderId as string;
    expect(r.json.order).toMatchObject({ status: 'FILLED', side: 'buy', filled: '0.01', origin: 'command' });
    expect(r.json.attached.map((a: any) => [a.role, a.state, a.placed, a.placedSize, a.triggerPrice, a.orders.map((o: any) => [o.status, o.size])])).toEqual([
      ['stop_loss', 'active', true, '0.01', '45000', [['SUBMITTED', '0.01']]], ['take_profit', 'active', true, '0.01', '60000', [['SUBMITTED', '0.01']]]]);
    const kids = await childrenOf(parent);
    expect(kids.map((c) => [c.role, c.type, c.side, c.reduce_only, c.record.size, c.principal_kind, c.principal_id, c.origin, c.detail.ocoGroup, c.detail.triggerPrice, c.mode, c.account_id])).toEqual([
      ['stop_loss', 'stop_market', 'sell', true, '0.01', 'api_key', k.id, 'command', `${parent}:stop_loss`, '45000', 'paper', k.account],
      ['take_profit', 'take_profit_market', 'sell', true, '0.01', 'api_key', k.id, 'command', `${parent}:take_profit`, '60000', 'paper', k.account]]);
    // each went through the same service: its own risk decision (strictly reducing), its mandate, its engine row
    for (const c of kids) {
      expect((await sql`select decision, reducing from risk_decisions where order_id = ${c.id} and not preview`)[0]).toMatchObject({ decision: 'allow', reducing: true });
      expect(c.mandate_id).not.toBeNull();
      expect((await sql`select count(*)::int as n from deriv_orders where account_id = ${k.account} and client_id = ${c.id}`)[0].n).toBe(1);
    }
    // replay of the command, and more supervisor passes: the same order, the same two children
    const again = await cmd(k.secret, k.account, 'LONG BTC-PERP 500 SL 45000 TP 60000', h);
    expect([again.status, again.json.order?.orderId ?? again.json.orderId ?? parent]).toEqual([200, parent]);
    await app.execution.orders.reconcile(); await app.execution.orders.attached.supervise();
    expect((await sql`select count(*)::int as n from orders where account_id = ${k.account}`)[0].n).toBe(3);
    // the market falls through the stop: it executes; the supervisor cancels its sibling
    await move(44_900);
    const after = await childrenOf(parent);
    expect(after.map((c) => [c.role, c.state, c.record.filledSize])).toEqual([['stop_loss', 'FILLED', '0.01'], ['take_profit', 'CANCELLED', '0']]);
    expect((await attachments(parent)).map((a: any) => [a.role, a.state, a.reason])).toEqual([['stop_loss', 'closed', 'executed'], ['take_profit', 'closed', 'one cancels the other: the stop-loss executed']]);
    expect((await call('GET', `${T}/positions?mode=paper`, { key: k.secret })).json.positions.filter((p: any) => p.accountId === k.account)).toEqual([]);
    setMarket(v, 50_000); clock.advance(6_000);
  });

  it('an entry that is refused places nothing: its attachments are recorded closed, with the reason', async () => {
    const k = await trader();
    const r = await cmd(k.secret, k.account, 'LONG BTC-PERP 3000 SL 45000 TP 60000');                 // above the mandate's 2 000 USD per order
    expect([r.status, r.json.error], JSON.stringify(r.json)).toEqual([403, 'mandate_denied']);
    const parent = r.json.data.order.orderId as string;
    expect(await order(parent)).toMatchObject({ state: 'REJECTED' });
    expect((await attachments(parent)).map((a: any) => [a.role, a.state, a.children, a.reason])).toEqual([['stop_loss', 'closed', [], 'the entry order was refused (mandate_denied): nothing was placed'], ['take_profit', 'closed', [], 'the entry order was refused (mandate_denied): nothing was placed']]);
    await app.execution.orders.reconcile();
    expect((await sql`select count(*)::int as n from orders where account_id = ${k.account}`)[0].n).toBe(1);        // the refused entry, and nothing else
  });

  it('a resting entry: nothing is placed before it fills; cancelled unfilled → closed with the reason; filled later → a NEW process places the protective orders from the database alone', async () => {
    setMarket(v, 50_000); clock.advance(6_000);
    const k = await trader();
    const a = await cmd(k.secret, k.account, 'LONG BTC-PERP 490 LIMIT 49000 SL 45000 TP 60000');
    expect(a.json.order).toMatchObject({ status: 'SUBMITTED', filled: '0' });
    expect(a.json.attached.map((x: any) => [x.role, x.state, x.placed])).toEqual([['stop_loss', 'pending', false], ['take_profit', 'pending', false]]);
    await app.execution.orders.reconcile();
    expect(await childrenOf(a.json.order.orderId)).toEqual([]);
    expect((await call('DELETE', `${T}/orders/${a.json.order.orderId}`, { key: k.secret, headers: idem() })).json.order.status).toBe('CANCELLED');
    await app.execution.orders.reconcile();
    expect((await attachments(a.json.order.orderId)).map((x: any) => [x.state, x.children.length, /is CANCELLED .* nothing of it filled: nothing was placed/.test(x.reason)])).toEqual([['closed', 0, true], ['closed', 0, true]]);
    // a second resting entry; the market comes to it while "the process is down"; a new process finishes the job
    const b = await cmd(k.secret, k.account, 'LONG BTC-PERP 490 LIMIT 49000 SL 45000 TP 60000');
    const parent = b.json.order.orderId as string;
    setMarket(v, 48_900); clock.advance(6_000); await step();
    expect(await childrenOf(parent)).toEqual([]);
    const { createExecution } = await import('../src/orders/index.ts');
    const fresh = createExecution({ derivatives: derivs, gmx: { status: async () => ({ positions: [] }) } as never });
    await fresh.orders.reconcile();
    expect(await order(parent)).toMatchObject({ state: 'FILLED' });
    expect((await childrenOf(parent)).map((c) => [c.role, c.state, c.reduce_only, c.record.size])).toEqual([['stop_loss', 'SUBMITTED', true, '0.01'], ['take_profit', 'SUBMITTED', true, '0.01']]);
    await fresh.orders.reconcile();
    expect((await childrenOf(parent)).length).toBe(2);
    // the position is closed by hand (the key's own close): the protective orders have nothing left to protect
    const close = await call('POST', `${T}/positions/${encodeURIComponent(`paper:hyperliquid:${k.account}:${BTC}`)}/close`, { key: k.secret, headers: idem(), body: {} });
    expect([close.status, close.json.order?.status], JSON.stringify(close.json)).toEqual([200, 'FILLED']);
    await app.execution.orders.reconcile();
    expect((await childrenOf(parent)).map((c) => c.state)).toEqual(['CANCELLED', 'CANCELLED']);
    expect((await attachments(parent)).map((x: any) => [x.state, x.reason])).toEqual([['closed', 'the position it protected is closed'], ['closed', 'the position it protected is closed']]);
    setMarket(v, 50_000); clock.advance(6_000);
  });

  it('an entry that fills in two parts: the first part is protected at once, the second by an additional order; the owner on paper works the same way', async () => {
    const account = await paperAccount('owner-attached');
    setMarket(v, 50_000, { asks: [['49000', '0.004'], ['51000', '2']] }); clock.advance(6_000);                                // only 0.004 is offered at the limit
    const r = await cmd(null, account, 'LONG BTC-PERP 490 LIMIT 49000 SL 45000 TP 60000');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const parent = r.json.order.orderId as string;
    expect(r.json.order).toMatchObject({ status: 'PARTIALLY_FILLED', filled: '0.004', principal: { kind: 'owner' } });
    expect((await childrenOf(parent)).map((c) => [c.role, c.record.size, c.state])).toEqual([['stop_loss', '0.004', 'SUBMITTED'], ['take_profit', '0.004', 'SUBMITTED']]);
    await move(50_000, { asks: [['49000', '1'], ['51000', '2']] });                                         // the rest is offered
    expect(await order(parent)).toMatchObject({ state: 'FILLED' });
    expect((await childrenOf(parent)).map((c) => [c.role, c.record.size, c.state])).toEqual([['stop_loss', '0.004', 'SUBMITTED'], ['stop_loss', '0.006', 'SUBMITTED'], ['take_profit', '0.004', 'SUBMITTED'], ['take_profit', '0.006', 'SUBMITTED']]);
    expect((await attachments(parent)).map((a: any) => [a.role, a.state, Number(a.placed)])).toEqual([['stop_loss', 'active', 0.01], ['take_profit', 'active', 0.01]]);
    // the take-profit side executes: every stop-loss order is cancelled
    await move(60_500);
    expect((await childrenOf(parent)).map((c) => [c.role, c.state])).toEqual([['stop_loss', 'CANCELLED'], ['stop_loss', 'CANCELLED'], ['take_profit', 'FILLED'], ['take_profit', 'FILLED']]);
    expect((await attachments(parent)).map((a: any) => [a.role, a.state])).toEqual([['stop_loss', 'closed'], ['take_profit', 'closed']]);
    expect((await sql`select count(*)::int as n from orders where projection_error is not null`)[0].n).toBe(0);
    setMarket(v, 50_000); clock.advance(6_000);
  });
});
