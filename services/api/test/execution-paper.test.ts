// V11 execution on PAPER, through the real server, with a real API key (created and bound with a passkey), a real signer process,
// fixture-backed venues and the paper engine. Own database; no network.
//
//   - end to end over HTTP: preview → place → fill by the paper engine → position → reduce → close → resting order → cancel;
//   - one unified order table for every path (trading API, the routes that existed before, an agent principal);
//   - the store refuses illegal transitions and the history is append-only;
//   - idempotency: one engine request for a key, whatever is replayed;
//   - the risk engine: every check wired (deny cases), kill switch, read-only mode, stale prices, passkey to loosen / release;
//   - mandates: lifecycle, every field refused, a key can do nothing to a mandate, revocation, expiry, stop condition → wind-down,
//     refused venues;
//   - webhooks on every transition.
// Set SPW_EXEC_TRANSCRIPT=<file> to write the HTTP transcript of the end-to-end run (docs/v11/work/exec.md pastes it).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { createSignerServer } from '../../isolated-signer/src/server.ts';
import { Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';
import { BTC, Clock, fixtureVenues, setMarket, useDatabase, type Venues } from './derivatives-helpers.ts';

const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'k'.repeat(48), T = '/api/v1/trading', DEV = '/api/v1/developer', ETH = 'hyperliquid:ETH';
const owner = new TestPasskey(RP, ORIGIN), attacker = new TestPasskey(RP, ORIGIN);
const ALL = ['wallet:read', 'markets:read', 'orders:read', 'orders:prepare', 'orders:execute', 'orders:cancel', 'positions:read', 'positions:manage', 'strategies:read', 'strategies:manage', 'agents:read', 'agents:manage'];
let app: any, sql: any, cookie = '', clock: Clock, v: Venues, signerSrv: Server, hookSrv: Server, hookUrl = '', hooks: typeof import('../src/trading-api/webhooks.ts'), store: typeof import('../src/orders/store.ts');
const received: any[] = [], transcript: string[] = [];
let ipSeq = 0, acct = '';

interface Res { status: number; json: any; headers: Record<string, any> }
async function call(method: string, path: string, o: { key?: string | null; cookie?: string | null; body?: unknown; headers?: Record<string, string>; log?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...o.headers };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  const c = o.cookie === undefined ? (o.key ? null : cookie) : o.cookie;
  if (c) headers.cookie = c;
  if (c && method !== 'GET') { headers.origin = ORIGIN; headers['x-spw-csrf'] = '1'; }
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const ip = path.startsWith(DEV) ? `10.201.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}` : undefined;
  const r = await app.inject({ method, url: path, headers, payload: o.body === undefined ? undefined : JSON.stringify(o.body), ...(ip ? { remoteAddress: ip } : {}) });
  const res = { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), headers: r.headers };
  if (o.log) transcript.push(`${method} ${path}${o.body !== undefined ? ` ${JSON.stringify(o.body)}` : ''}\n  → ${res.status} ${o.log === 'full' ? JSON.stringify(res.json) : o.log}`);
  return res;
}
const idem = () => ({ 'idempotency-key': `exec-${randomUUID()}` });
const assertion = (options: { challenge: string }, who = owner) => who.assert(Buffer.from(options.challenge, 'base64url'));
async function newKey(body: Record<string, unknown> = {}): Promise<{ id: string; secret: string }> {
  const p = await call('POST', `${DEV}/keys/prepare`, { body: { name: 'exec key', scopes: ALL, expiresInDays: 30, rateLimitPerMin: 600, ...body } });
  expect(p.status, JSON.stringify(p.json)).toBe(200);
  const c = await call('POST', `${DEV}/keys`, { body: { intentId: p.json.intentId, assertion: assertion(p.json.options) } });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  return { id: c.json.key.id, secret: c.json.secret };
}
const MANDATE = { mode: 'paper', instruments: [BTC], orderTypes: ['market', 'limit'], maxCapitalUsd: '5000', maxOrderNotionalUsd: '2000', maxPositionNotionalUsd: '4000', maxLeverage: '3', maxDailyLossUsd: '500', floorEquityUsd: '1000', days: 7,
  frequency: { perMinute: 30, perHour: 200, perDay: 400 }, maxSlippageBps: 100, maxFeeUsd: '10', label: 'exec mandate' };
async function mandateFor(principal: { kind: string; id: string }, over: Record<string, unknown> = {}, account = acct): Promise<string> {
  const m = await call('POST', '/api/v1/mandates', { body: { ...MANDATE, principal, accountIds: [account], ...over } });
  expect(m.status, JSON.stringify(m.json)).toBe(200);
  expect((await call('POST', `/api/v1/mandates/${m.json.mandate.id}/approve`, { body: {} })).status).toBe(200);
  return m.json.mandate.id as string;
}
async function bind(keyId: string, mandateId: string): Promise<void> {
  const p = await call('POST', `${DEV}/keys/${keyId}/update/prepare`, { body: { changes: { mandateId } } });
  expect(p.status, JSON.stringify(p.json)).toBe(200);
  expect((await call('POST', `${DEV}/keys/${keyId}/update`, { body: { intentId: p.json.intentId, assertion: assertion(p.json.options) } })).status).toBe(200);
}
async function tradingKey(over: Record<string, unknown> = {}, keyBody: Record<string, unknown> = {}, account = acct) {
  const k = await newKey(keyBody), mandateId = await mandateFor({ kind: 'api_key', id: k.id }, over, account);
  await bind(k.id, mandateId);
  return { ...k, mandateId };
}
/** `accountId` is added once the suite's paper account exists (the wallet gets a second one later) */
const ORDER: Record<string, unknown> = { mode: 'paper', instrument: BTC, side: 'buy', type: 'market', size: '0.02' };
const place = (key: string, body: Record<string, unknown> = {}, headers = idem()) => call('POST', `${T}/orders`, { key, headers, body: { ...ORDER, ...body } });
const setLimits = async (mode: 'paper' | 'live', limits: object) => { await sql`insert into settings (key, value) values (${`risk.limits.${mode}`}, ${sql.json(limits)}) on conflict (key) do update set value = excluded.value`; };
const paperAccount = async (label: string, collateral = '10000'): Promise<string> => { const a = await call('POST', '/api/v1/derivatives/accounts', { body: { venue: 'hyperliquid', label, collateral } }); expect(a.status, JSON.stringify(a.json)).toBe(200); return a.json.id as string; };
const orderRow = async (id: string) => (await sql`select * from orders where id = ${id}`)[0];
const events = async (id: string) => (await sql`select event, from_state, to_state, reason from order_events where order_id = ${id} order by seq`).map((e: any) => `${e.from_state}>${e.to_state}:${e.event}`);
const releaseSwitch = async (kind: 'kill-switch' | 'read-only') => { const p = await call('POST', `/api/v1/risk/${kind}/release/prepare`); return call('POST', `/api/v1/risk/${kind}/release`, { body: p.json.needed ? { assertion: assertion(p.json.options) } : {} }); };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spw-exec-paper-'));
  signerSrv = createSignerServer(new Signer(deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), new Store(join(dir, 'state.json'), join(dir, 'policy.json')), { rpId: RP, origin: ORIGIN }), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  hookSrv = createServer((req, res) => { let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => { received.push(JSON.parse(body)); res.statusCode = 200; res.end('ok'); }); }).listen(0, '127.0.0.1');
  await new Promise((r) => hookSrv.once('listening', r));
  hookUrl = `http://127.0.0.1:${(hookSrv.address() as { port: number }).port}/hook`;
  await useDatabase('execution_paper');
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
  hooks = await import('../src/trading-api/webhooks.ts'); store = await import('../src/orders/store.ts');
  hooks.configureWebhooks({ allowHttp: true });
  const mod = await import('../src/derivatives/index.ts');
  clock = new Clock(); v = fixtureVenues(clock);
  setMarket(v, 50_000);
  app = await (await import('../src/server.ts')).buildServer({ derivatives: mod.createDerivatives({ registry: mod.createRegistry(v.adapters, clock.now), now: clock.now }), gmx: { status: async () => ({ network: 'arbitrum', account: null, positionsError: null, positions: [] }) } as never });
  acct = await paperAccount('Exec');
  ORDER.accountId = acct;
  expect((await call('POST', `${DEV}/webhooks`, { body: { url: hookUrl, events: ['order.updated', 'risk.kill_switch'], label: 'exec' } })).status).toBe(200);
});
afterAll(async () => {
  if (process.env.SPW_EXEC_TRANSCRIPT && transcript.length) writeFileSync(process.env.SPW_EXEC_TRANSCRIPT, `${transcript.join('\n')}\n`);
  app?.server.closeAllConnections?.(); await app?.close(); signerSrv?.close(); hookSrv?.close(); await sql?.end();
});

describe('paper, end to end over HTTP with a real key', () => {
  it('preview → place → filled by the paper engine → position → reduce → close → resting order → cancel; webhooks on every transition', async () => {
    const k = await tradingKey();
    transcript.push(`# key ${k.id.replace(/[0-9a-f]{12}$/, '<id>')} — every scope; bound to an approved PAPER trading mandate (BTC, market + limit, 2 000 USD per order)`);

    const pv = await call('POST', `${T}/orders/preview`, { key: k.secret, body: ORDER, log: 'see below' });
    expect(pv.status, JSON.stringify(pv.json)).toBe(200);
    expect(pv.json).toMatchObject({ wouldExecute: true, refusals: [], approval: { required: false, by: 'mandate' }, mandate: { id: k.mandateId, decision: 'allow', reasons: [] }, risk: { decision: 'allow', reducing: false }, engine: { name: 'paper' } });
    expect(pv.json.order).toMatchObject({ v: 1, venue: 'hyperliquid', instrument: BTC, marketKind: 'perp', side: 'buy', type: 'market', size: '0.02', mode: 'paper', principal: { kind: 'api_key', id: k.id }, mandateId: k.mandateId });
    expect(pv.json.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(pv.json.risk.checks.map((c: any) => c.id)).toEqual(expect.arrayContaining(['kill_switch', 'order_notional', 'position_size', 'slippage', 'liquidation_distance', 'context_complete']));
    expect(pv.json.risk.checks.every((c: any) => c.ok)).toBe(true);
    expect(pv.json.engine.estimate).toMatchObject({ source: 'estimate', filledSize: '0.02' });
    transcript.push(`    wouldExecute=${pv.json.wouldExecute} approval=${pv.json.approval.by} risk=${pv.json.risk.decision} (${pv.json.risk.checks.length} checks, all ok) mandate=${pv.json.mandate.decision} hash=${pv.json.hash.slice(0, 16)}… estimate: fee ${pv.json.engine.estimate.fee}, avg ${pv.json.engine.estimate.avgFillPrice}, slippage ${pv.json.engine.estimate.slippageBps} bps, liquidation ${pv.json.engine.estimate.liquidationPrice?.value}`);
    expect((await sql`select count(*)::int as n from orders`)[0].n).toBe(0);                       // a preview creates nothing
    expect((await sql`select count(*)::int as n from risk_decisions where preview`)[0].n).toBeGreaterThan(0);

    const h = idem(), before = app.execution.orders.engineCalls.paper;
    const o = await call('POST', `${T}/orders`, { key: k.secret, headers: h, body: ORDER, log: 'see below' });
    expect(o.status, JSON.stringify(o.json)).toBe(200);
    const id = o.json.order.id as string;
    expect(o.json).toMatchObject({ idempotent: false, approval: null, order: { mode: 'paper', venue: 'hyperliquid', instrument: BTC, side: 'buy', type: 'market', status: 'FILLED', final: true, filled: '0.02', engine: 'paper', origin: 'trading_api', principal: { kind: 'api_key', id: k.id }, mandateId: k.mandateId } });
    transcript.push(`    order ${id.slice(0, 12)}… status=${o.json.order.status} filled=${o.json.order.filled} avg=${o.json.order.avgFillPrice} reason=${o.json.order.reasonCode}`);
    expect(id).toBe(pv.json.order.clientOrderId === id ? id : o.json.order.clientOrderId);
    expect(await events(id)).toEqual(['CREATED>VALIDATED:validated', 'VALIDATED>APPROVED:approved', 'APPROVED>SUBMITTING:submit_started', 'SUBMITTING>FILLED:reconciled_found']);
    // the fill came from the paper engine's own row and fills, not from the answer of the submission
    const eng = (await sql`select * from deriv_orders where account_id = ${acct} and client_id = ${id}`)[0];
    expect(eng).toMatchObject({ status: 'filled' });
    expect((await sql`select count(*)::int as n from deriv_fills where account_id = ${acct} and client_id = ${id}`)[0].n).toBe(1);
    expect((await orderRow(id)).engine_ref).toBe(`${acct}:${id}`);
    expect((await sql`select decision, order_id from risk_decisions where order_id = ${id} and not preview`)).toEqual([{ decision: 'allow', order_id: id }]);

    // the same Idempotency-Key again: the same order, no second request to the engine
    const again = await call('POST', `${T}/orders`, { key: k.secret, headers: h, body: ORDER, log: 'replay: same order, Idempotent-Replay: true' });
    expect([again.status, again.headers['idempotent-replay'], again.json.order.id]).toEqual([200, 'true', id]);
    expect(app.execution.orders.engineCalls.paper).toBe(before + 1);
    expect((await call('POST', `${T}/orders`, { key: k.secret, headers: h, body: { ...ORDER, size: '0.03' } })).json.error).toBe('idempotency_conflict');
    // the order's own key (clientOrderId) with another HTTP key: still the same order, still one engine request
    const viaBody = await place(k.secret, { clientOrderId: h['idempotency-key'] });
    expect([viaBody.status, viaBody.json.idempotent, viaBody.json.order.id]).toEqual([200, true, id]);
    expect(app.execution.orders.engineCalls.paper).toBe(before + 1);
    expect((await place(k.secret, { clientOrderId: h['idempotency-key'], size: '0.03' })).json.error).toBe('idempotency_conflict');
    expect((await sql`select count(*)::int as n from deriv_orders where account_id = ${acct}`)[0].n).toBe(1);

    const pos = await call('GET', `${T}/positions?mode=paper`, { key: k.secret, log: 'see below' });
    const mine = pos.json.positions.find((p: any) => p.accountId === acct);
    expect(mine).toMatchObject({ id: `paper:hyperliquid:${acct}:${BTC}`, side: 'long', size: '0.02' });
    transcript.push(`    position ${mine.side} ${mine.size} ${mine.instrument} entry ${mine.entryPrice}`);

    const red = await call('POST', `${T}/positions/${encodeURIComponent(mine.id)}/reduce`, { key: k.secret, headers: idem(), body: { fraction: '0.5' }, log: 'see below' });
    expect(red.status, JSON.stringify(red.json)).toBe(200);
    expect(red.json.order).toMatchObject({ status: 'FILLED', side: 'sell', reduceOnly: true, filled: '0.01' });
    transcript.push(`    order ${red.json.order.id.slice(0, 12)}… reduce-only sell status=${red.json.order.status} filled=${red.json.order.filled}`);
    const close = await call('POST', `${T}/positions/${encodeURIComponent(mine.id)}/close`, { key: k.secret, headers: idem(), body: {}, log: 'see below' });
    expect(close.status, JSON.stringify(close.json)).toBe(200);
    expect(close.json.order).toMatchObject({ status: 'FILLED', side: 'sell', reduceOnly: true, filled: '0.01' });
    transcript.push(`    order ${close.json.order.id.slice(0, 12)}… reduce-only sell status=${close.json.order.status} filled=${close.json.order.filled}`);
    expect((await call('GET', `${T}/positions?mode=paper`, { key: k.secret })).json.positions.filter((p: any) => p.accountId === acct)).toEqual([]);
    expect((await call('POST', `${T}/positions/${encodeURIComponent(mine.id)}/close`, { key: k.secret, headers: idem(), body: {} })).json.error).toBe('no_position');

    // a resting limit order, then its cancellation
    const rest = await call('POST', `${T}/orders`, { key: k.secret, headers: idem(), body: { ...ORDER, type: 'limit', price: '49000', size: '0.01' }, log: 'see below' });
    expect(rest.status, JSON.stringify(rest.json)).toBe(200);
    expect(rest.json.order).toMatchObject({ status: 'SUBMITTED', final: false, filled: '0', price: '49000' });
    transcript.push(`    order ${rest.json.order.id.slice(0, 12)}… limit buy 0.01 @ 49000 status=${rest.json.order.status}`);
    expect((await call('GET', `${T}/orders?open=true`, { key: k.secret })).json.orders.map((x: any) => x.id)).toEqual([rest.json.order.id]);
    const cancel = await call('DELETE', `${T}/orders/${rest.json.order.id}`, { key: k.secret, headers: idem(), log: 'see below' });
    expect(cancel.status, JSON.stringify(cancel.json)).toBe(200);
    expect(cancel.json.order).toMatchObject({ status: 'CANCELLED', reasonCode: 'CANCELLED_BY_REQUEST', final: true });
    transcript.push(`    order ${rest.json.order.id.slice(0, 12)}… status=${cancel.json.order.status} reason=${cancel.json.order.reasonCode}`);
    expect(await events(rest.json.order.id)).toEqual(['CREATED>VALIDATED:validated', 'VALIDATED>APPROVED:approved', 'APPROVED>SUBMITTING:submit_started', 'SUBMITTING>SUBMITTED:venue_accepted', 'SUBMITTED>SUBMITTED:cancel_requested', 'SUBMITTED>CANCELLED:reconciled_found']);

    const one = await call('GET', `${T}/orders/${id}`, { key: k.secret, log: 'see below' });
    expect(one.status).toBe(200);
    expect(one.json).toMatchObject({ order: { id, status: 'FILLED', canonical: { clientOrderId: id } }, fills: [expect.objectContaining({ instrument: BTC, side: 'buy', size: '0.02' })] });
    expect(one.json.history.map((e: any) => e.to)).toEqual(['VALIDATED', 'APPROVED', 'SUBMITTING', 'FILLED']);
    transcript.push(`    history: ${one.json.history.map((e: any) => `${e.from}→${e.to} (${e.event})`).join(', ')}; fills: ${one.json.fills.length}`);
    const list = await call('GET', `${T}/orders?mode=paper`, { key: k.secret, log: 'see below' });
    expect(list.json.orders).toHaveLength(4);
    transcript.push(`    ${list.json.orders.length} orders: ${list.json.orders.map((x: any) => `${x.side} ${x.type} ${x.status}`).join(' | ')}`);

    // webhooks: one order.updated per transition, signed and delivered
    for (let n = 0; n < 40 && received.filter((e) => e.event === 'order.updated' && e.data.orderId === id).length < 4; n++) { await hooks.deliverDue(); await new Promise((r) => setTimeout(r, 20)); }
    expect(received.filter((e) => e.event === 'order.updated' && e.data.orderId === id).map((e) => e.data.status)).toEqual(['VALIDATED', 'APPROVED', 'SUBMITTING', 'FILLED']);
    expect(received.find((e) => e.event === 'order.updated' && e.data.orderId === rest.json.order.id && e.data.status === 'CANCELLED')?.data).toMatchObject({ mode: 'paper', venue: 'hyperliquid', instrument: BTC, principal: `api_key:${k.id}`, mandateId: k.mandateId });
  });

  it('an order placed through the route that existed before (owner, paper) is in the unified table too — the same engine, projected', async () => {
    const clientId = `legacy-${randomUUID()}`;
    const o = await call('POST', `/api/v1/derivatives/accounts/${acct}/orders`, { body: { instrument: BTC, side: 'buy', type: 'market', size: '0.01', slippageBps: 50 }, headers: { 'idempotency-key': clientId } });
    expect(o.status, JSON.stringify(o.json)).toBe(200);
    const g = await call('GET', `${T}/orders/deriv:${acct}:${clientId}`);
    expect(g.status).toBe(200);
    expect(g.json.order).toMatchObject({ id: `deriv:${acct}:${clientId}`, status: 'FILLED', engineStatus: 'filled', origin: 'legacy', principal: { kind: 'owner', id: 'owner' }, filled: '0.01', engine: 'paper' });
    expect(g.json.history.map((e: any) => `${e.to}:${e.event}`)).toEqual(['VALIDATED:validated', 'AWAITING_APPROVAL:approval_requested', 'APPROVED:approved', 'SUBMITTING:submit_started', 'FILLED:reconciled_found']);
    // the unified risk engine judged it too (the gate in the paper engine), and its decision is linked to the order
    expect((await sql`select decision from risk_decisions where order_id = ${g.json.order.orderId}`)).toEqual([{ decision: 'allow' }]);
    // closing it through the old route: projected as well
    const c = await call('POST', `/api/v1/derivatives/accounts/${acct}/close`, { body: { instrument: BTC, fraction: '1' }, headers: idem() });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    await app.execution.orders.drain();
    expect((await sql`select count(*)::int as n from deriv_orders d where not exists (select 1 from orders o where o.engine_ref = d.account_id::text || ':' || d.client_id)`)[0].n).toBe(0);   // no engine row without its unified order
    expect((await sql`select count(*)::int as n from order_projection_queue`)[0].n).toBe(0);
    expect((await sql`select count(*)::int as n from orders where projection_error is not null`)[0].n).toBe(0);
  });

  it('the store: an illegal transition is refused and changes nothing; the history is append-only', async () => {
    const [filled] = await sql`select * from orders where state = 'FILLED' limit 1`;
    await expect(store.applyEvent(filled.id, { type: 'cancel_requested' }, clock.now())).rejects.toThrow(/illegal order transition/);
    await expect(store.applyEvent(filled.id, { type: 'fill', size: '1', price: '1' }, clock.now())).rejects.toThrow(/illegal order transition/);
    await expect(store.applyEvent(filled.id, { type: 'made_up' } as never, clock.now())).rejects.toThrow();
    expect(await orderRow(filled.id)).toMatchObject({ state: 'FILLED', version: filled.version });
    await expect(sql`update order_events set to_state = 'FAILED' where order_id = ${filled.id}`).rejects.toThrow(/append-only/);
    await expect(sql`delete from order_events where order_id = ${filled.id}`).rejects.toThrow(/append-only/);
    // a fresh order: nothing fills it except a venue-originated event, and never from CREATED
    const id = `test-${randomUUID()}`;
    await store.insertOrder({ id, principal: { kind: 'owner', id: 'owner' }, idempotencyKey: null, bodyHash: null, mode: 'paper', venue: 'hyperliquid', network: 'mainnet', instrument: BTC, marketKind: 'perp', side: 'buy', type: 'market', reduceOnly: false,
      accountId: acct, mandateId: null, canonical: null, orderHash: null, size: '1', engine: 'none', engineRef: null, notionalUsd: null, origin: 'trading_api', detail: {}, createdAt: clock.now() });
    for (const ev of [{ type: 'fill', size: '1', price: '1' }, { type: 'venue_accepted', venueOrderId: '1' }, { type: 'approved', by: 'owner' }, { type: 'submit_started' }] as const) await expect(store.applyEvent(id, ev, clock.now())).rejects.toThrow(/illegal order transition/);
    await store.applyEvent(id, { type: 'validated' }, clock.now());
    await expect(store.applyEvent(id, { type: 'approved', by: 'owner' }, clock.now())).rejects.toThrow(/owner approval must be requested first/);
    await store.applyEvent(id, { type: 'cancel_requested' }, clock.now());
    expect(await orderRow(id)).toMatchObject({ state: 'CANCELLED', reason: 'WITHDRAWN_BEFORE_APPROVAL', version: 2 });
  });

  it('restart: an order of the service that never reached its engine is closed after the grace (nothing was sent); one whose engine row exists is completed from it', async () => {
    const mk = async (state: 'CREATED' | 'VALIDATED' | 'APPROVED' | 'SUBMITTING', ref: string | null) => {
      const id = `orphan-${randomUUID()}`;
      await store.insertOrder({ id, principal: { kind: 'owner', id: 'owner' }, idempotencyKey: `k-${id}`, bodyHash: 'x', mode: 'paper', venue: 'hyperliquid', network: 'mainnet', instrument: BTC, marketKind: 'perp', side: 'buy', type: 'market', reduceOnly: false,
        accountId: acct, mandateId: null, canonical: null, orderHash: null, size: '0.01', engine: 'paper', engineRef: ref, notionalUsd: null, origin: 'trading_api', detail: {}, createdAt: clock.now() });
      const path = { CREATED: [], VALIDATED: ['validated'], APPROVED: ['validated', 'approval_requested', 'approved'], SUBMITTING: ['validated', 'approval_requested', 'approved', 'submit_started'] }[state];
      for (const t of path) await store.applyEvent(id, t === 'approved' ? { type: 'approved', by: 'owner' } : { type: t } as never, clock.now());
      return id;
    };
    const ids = [await mk('CREATED', null), await mk('VALIDATED', null), await mk('APPROVED', `${acct}:never-stored-a`), await mk('SUBMITTING', `${acct}:never-stored-b`)];
    expect((await app.execution.orders.reconcile()).orphans).toBe(0);                             // inside the grace: another process may still be working on them
    for (const id of ids) expect((await orderRow(id)).state).not.toBe('FAILED');
    clock.advance(31_000);
    setMarket(v, 50_000);
    expect((await app.execution.orders.reconcile()).orphans).toBe(4);
    for (const id of ids) expect(await orderRow(id)).toMatchObject({ state: 'FAILED', reason: 'INTERNAL_ERROR', reject_code: 'interrupted' });
    // SUBMITTING with an engine row (the process died after the engine stored and filled it): completed from the engine row, never failed
    const live = await mk('SUBMITTING', null), ref = `${acct}:${live}`;
    await sql`update orders set engine_ref = ${ref} where id = ${live}`;
    const r = await app.execution.orders.deps.derivatives().paper.order(acct, { instrument: BTC, side: 'buy', type: 'market', size: '0.01', price: null, triggerPrice: null, reduceOnly: false, tif: 'ioc', slippageBps: 50 }, live);
    expect(r.order.status).toBe('filled');
    await sql`delete from order_projection_queue`;                                                   // as if the queue had been lost with the process
    clock.advance(31_000); setMarket(v, 50_000);
    await app.execution.orders.reconcile();
    expect(await orderRow(live)).toMatchObject({ state: 'FILLED', reason: 'VENUE_FILLED' });
    await call('POST', `/api/v1/derivatives/accounts/${acct}/close`, { body: { instrument: BTC, fraction: '1' }, headers: idem() });
  });
});

/** every test starts from a flat account, the default paper limits, released switches and a live market */
async function reset(): Promise<void> {
  // (a minute later: the paper account's own policy allows 10 orders a minute)
  v.hl.down = false; v.hl.bookAgeMs = 0; clock.advance(61_000); setMarket(v, 50_000);
  await setLimits('paper', {});
  for (const kind of ['kill-switch', 'read-only'] as const) await releaseSwitch(kind);
  for (const a of (await call('GET', '/api/v1/derivatives/accounts')).json.accounts ?? []) {
    if (a.kind !== 'paper') continue;
    for (const o of a.openOrders ?? []) await call('POST', `/api/v1/derivatives/accounts/${a.id}/orders/${o.clientId}/cancel`, { headers: idem() });
    for (const p of a.positions ?? []) await call('POST', `/api/v1/derivatives/accounts/${a.id}/close`, { body: { instrument: p.instrument, fraction: '1' }, headers: idem() });
  }
}

describe('risk engine', () => {
  beforeEach(reset);
  it('every check is wired: a limit that is exceeded denies the order with that check, and the denied order is a REJECTED row with its decision', async () => {
    const k = await tradingKey();
    const cases: [object, string][] = [
      [{ maxOrderNotional: '100' }, 'order_notional'], [{ maxDailyNotional: '100' }, 'daily_notional'], [{ maxPositionNotional: { per: {}, default: '100' } }, 'position_size'], [{ maxOrderLeverage: '1' }, 'order_leverage'],
      [{ maxAccountLeverage: '0.001' }, 'account_leverage'], [{ maxGrossExposure: '100' }, 'gross_exposure'], [{ maxNetExposure: '100' }, 'net_exposure'], [{ maxAssetExposure: { per: { BTC: '100' } , default: '1000000' } }, 'asset_exposure'],
      [{ maxVenueExposure: { per: { hyperliquid: '100' }, default: '1000000' } }, 'venue_exposure'], [{ maxVenueCollateralShareBps: '1' }, 'collateral_concentration'], [{ maxDailyLoss: '0' }, 'daily_loss'], [{ maxTotalLoss: '0' }, 'total_loss'],
      [{ minLiquidationDistanceBps: '9999' }, 'liquidation_distance'], [{ maxSlippageBps: '0' }, 'slippage'], [{ minLiquidity: { withinBps: '100', multiple: '100000' } }, 'min_liquidity'], [{ maxOrdersPerMinute: 0 }, 'order_rate_minute'],
      [{ maxOrdersPerHour: 0 }, 'order_rate_hour'], [{ maxOrdersPerDay: 0 }, 'order_rate_day'], [{ allowedVenues: ['gmx'] }, 'venue_allowed'], [{ allowedInstruments: [ETH] }, 'instrument_allowed'], [{ minPriceSources: 5 }, 'price_freshness'],
    ];
    for (const [limits, check] of cases) {
      await setLimits('paper', limits);
      // (a small position against a large collateral has no liquidation price at all: that one case needs a large order)
      const p = await call('POST', `${T}/orders/preview`, { key: k.secret, body: check === 'liquidation_distance' ? { ...ORDER, size: '0.55' } : ORDER });
      expect(p.status, check).toBe(200);
      const failed = p.json.risk.checks.filter((c: any) => !c.ok).map((c: any) => c.id);
      expect(failed, JSON.stringify(limits)).toContain(check);
      expect([p.json.wouldExecute, p.json.risk.decision]).toEqual([false, 'deny']);
      expect(p.json.refusals.find((r: any) => r.stage === 'risk')).toMatchObject({ code: 'risk_denied' });
    }
    // two sources that disagree
    await setLimits('paper', { maxSourceDeviationBps: '5' });
    clock.advance(2_000); setMarket(v, 50_000);
    v.hl.ticker = { ...v.hl.ticker, index: '50100' };
    expect((await call('POST', `${T}/orders/preview`, { key: k.secret, body: ORDER })).json.risk.checks.find((c: any) => c.id === 'price_consistency')).toMatchObject({ ok: false, observed: '20' });
    setMarket(v, 50_000);
    // a denied order is still an order: REJECTED, with the engine's check list
    await setLimits('paper', { maxOrderNotional: '100' });
    const o = await place(k.secret);
    expect([o.status, o.json.error]).toEqual([422, 'risk_denied']);
    expect(o.json.data).toMatchObject({ failed: ['order_notional'], order: { status: 'REJECTED', reasonCode: 'RISK_DENIED', rejectCode: 'risk_denied' } });
    expect(await events(o.json.data.order.id)).toEqual(['CREATED>REJECTED:local_rejected']);
    expect((await sql`select decision, failed from risk_decisions where order_id = ${o.json.data.order.id}`)[0]).toMatchObject({ decision: 'deny', failed: ['order_notional'] });
    expect((await sql`select count(*)::int as n from deriv_orders where client_id = ${o.json.data.order.id}`)[0].n).toBe(0);            // the engine was never asked
    // the same limit binds the owner, through the trading API and through the route that existed before
    const own = await call('POST', `${T}/orders`, { headers: idem(), body: ORDER });
    expect([own.status, own.json.error]).toEqual([422, 'risk_denied']);
    const old = await call('POST', `/api/v1/derivatives/accounts/${acct}/orders`, { body: { instrument: BTC, side: 'buy', type: 'market', size: '0.02', slippageBps: 50 }, headers: idem() });
    expect([old.status, old.json.error]).toEqual([422, 'risk_denied']);
    expect(old.json.message).toMatch(/order_notional/);
    await setLimits('paper', {});
  });

  it('limits: tightening is free, loosening needs the passkey over the whole new set — once, and only that set', async () => {
    expect((await call('GET', '/api/v1/risk/limits/live')).json.missing).toEqual(expect.arrayContaining(['allowedVenues', 'maxOrderNotional', 'maxGrossExposure', 'maxTotalLoss']));
    const tight = await call('POST', '/api/v1/risk/limits/paper', { body: { limits: { maxOrderNotional: '5000' } } });
    expect(tight.status, JSON.stringify(tight.json)).toBe(200);
    expect(tight.json.stored).toEqual({ maxOrderNotional: '5000' });
    const loose = await call('POST', '/api/v1/risk/limits/paper', { body: { limits: { maxOrderNotional: '6000' } } });
    expect([loose.status, loose.json.error]).toEqual([403, 'passkey_required']);
    const p = await call('POST', '/api/v1/risk/limits/paper/prepare', { body: { limits: { maxOrderNotional: '6000' } } });
    expect(p.json).toMatchObject({ needed: true, loosened: ['maxOrderNotional'], intent: { mode: 'paper', limits: { maxOrderNotional: '6000' } } });
    expect((await call('POST', '/api/v1/risk/limits/paper/approve', { body: {} })).json.error).toBe('passkey_required');
    expect((await call('POST', '/api/v1/risk/limits/paper/approve', { body: { assertion: assertion(p.json.options, attacker) } })).json.error).toBe('bad_approval');
    expect((await call('POST', '/api/v1/risk/limits/paper/approve', { body: { assertion: owner.assert(randomBytes(32)) } })).json.error).toBe('bad_approval');
    expect((await call('GET', '/api/v1/risk/limits/paper')).json.stored).toEqual({ maxOrderNotional: '5000' });
    const ok = await call('POST', '/api/v1/risk/limits/paper/approve', { body: { assertion: assertion(p.json.options) } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.stored).toEqual({ maxOrderNotional: '6000' });
    expect((await call('POST', '/api/v1/risk/limits/paper/approve', { body: { assertion: assertion(p.json.options) } })).json.error).toBe('bad_state');     // single use
    expect((await call('POST', '/api/v1/risk/limits/paper/prepare', { body: { limits: { maxOrderNotional: '100' } } })).json).toMatchObject({ needed: false });
    // a live limit that was absent denies; setting it is a loosening
    expect((await call('POST', '/api/v1/risk/limits/live', { body: { limits: { maxOrderNotional: '100' } } })).json.error).toBe('passkey_required');
    await setLimits('paper', {});
  });

  it('kill switch: blocks opening for the owner, a key and an agent, on every path; a cancel and a reduce-only close still pass; release needs the passkey', async () => {
    const k = await tradingKey();
    expect((await place(k.secret)).json.order.status).toBe('FILLED');                                  // a position to close later
    const rest = await place(k.secret, { type: 'limit', price: '49000', size: '0.01' });
    expect(rest.json.order.status).toBe('SUBMITTED');
    const agentId = randomUUID();
    await sql`insert into agents (id, name, universe, risk, vault_index, vault_address, state, mode) values (${agentId}, 'Exec agent', ${sql.json(['BTC'])}, ${sql.json({})}, 9101, '0x0', 'PAPER_TRADING', 'PAPER')`;
    const agent = { principal: { kind: 'agent' as const, id: agentId }, mandateId: await mandateFor({ kind: 'agent', id: agentId }, { strategySha256: 'ab'.repeat(32) }) };
    const asAgent = (body: Record<string, unknown> = {}) => app.execution.orders.submit(agent, { ...ORDER, reduceOnly: false, tif: 'gtc', ...body } as never, `agent-${randomUUID()}`, { origin: 'agent' });
    expect((await asAgent({ size: '0.01' })).order).toMatchObject({ status: 'FILLED', origin: 'agent', principal: { kind: 'agent', id: agentId } });

    // a key with positions:manage engages it — without a mandate; nobody but the owner with the passkey releases it
    const plain = await newKey({ scopes: ['positions:manage'] });
    const on = await call('POST', `${T}/risk/kill-switch`, { key: plain.secret, body: { reason: 'test' } });
    expect(on.status, JSON.stringify(on.json)).toBe(200);
    expect(on.json.killSwitch).toMatchObject({ on: true, by: { kind: 'api_key', id: plain.id }, reason: 'test' });
    expect((await call('POST', `${T}/risk/kill-switch`, { key: (await newKey({ scopes: ['orders:execute'] })).secret, body: {} })).json.error).toBe('insufficient_scope');
    for (const path of ['/api/v1/risk/kill-switch/release/prepare', '/api/v1/risk/kill-switch/release']) expect((await call('POST', path, { key: k.secret, body: {} })).status).toBe(403);

    const denied = await place(k.secret);
    expect([denied.status, denied.json.error]).toEqual([423, 'kill_switch_active']);
    expect(denied.json.data.order).toMatchObject({ status: 'REJECTED', reasonCode: 'KILL_SWITCH_ACTIVE' });
    expect((await call('POST', `${T}/orders/preview`, { key: k.secret, body: ORDER })).json.refusals.find((r: any) => r.stage === 'risk')).toMatchObject({ code: 'kill_switch_active' });
    const own = await call('POST', `${T}/orders`, { headers: idem(), body: ORDER });
    expect([own.status, own.json.error]).toEqual([423, 'kill_switch_active']);
    const old = await call('POST', `/api/v1/derivatives/accounts/${acct}/orders`, { body: { instrument: BTC, side: 'buy', type: 'market', size: '0.01', slippageBps: 50 }, headers: idem() });
    expect([old.status, old.json.error]).toEqual([422, 'kill_switch_active']);
    await expect(asAgent()).rejects.toMatchObject({ code: 'kill_switch_active', status: 423 });
    // an increase of an existing position is new risk too; a sell that would flip is not a reduction
    expect((await place(k.secret, { size: '0.001' })).json.error).toBe('kill_switch_active');
    expect((await place(k.secret, { side: 'sell', size: '0.035', reduceOnly: true })).json.data.failed).toContain('reduce_only_valid');          // the position is 0.03
    // a spot agent's swap is stopped before the signer is asked (the guard in front of /mandate/sign)
    const { signerGuards } = await import('../src/signer-client.ts');
    await expect(signerGuards.beforeMandateSign!()).rejects.toMatchObject({ code: 'kill_switch_active' });

    // what removes risk still passes: the cancel, and the reduce-only close (key, agent, owner through the old route)
    const cancel = await call('DELETE', `${T}/orders/${rest.json.order.id}`, { key: k.secret, headers: idem() });
    expect([cancel.status, cancel.json.order.status]).toEqual([200, 'CANCELLED']);
    const posId = `paper:hyperliquid:${acct}:${BTC}`;
    const red = await call('POST', `${T}/positions/${encodeURIComponent(posId)}/reduce`, { key: k.secret, headers: idem(), body: { fraction: '0.5' } });
    expect([red.status, red.json.order?.status], JSON.stringify(red.json)).toEqual([200, 'FILLED']);
    expect((await sql`select checks from risk_decisions where order_id = ${red.json.order.id}`)[0].checks.find((c: any) => c.id === 'kill_switch')).toMatchObject({ ok: true, exempt: true });
    expect((await asAgent({ side: 'sell', size: '0.005', reduceOnly: true })).order.status).toBe('FILLED');
    const oldClose = await call('POST', `/api/v1/derivatives/accounts/${acct}/close`, { body: { instrument: BTC, fraction: '1' }, headers: idem() });
    expect(oldClose.status, JSON.stringify(oldClose.json)).toBe(200);

    // release: not without the passkey, not with another one, not for a key
    expect((await call('POST', '/api/v1/risk/kill-switch/release', { body: {} })).json.error).toBe('passkey_required');
    expect((await call('POST', '/api/v1/risk/kill-switch/release', { body: { assertion: owner.assert(randomBytes(32)) } })).json.error).toBe('bad_state');           // nothing was prepared
    const p = await call('POST', '/api/v1/risk/kill-switch/release/prepare');
    expect(p.json).toMatchObject({ needed: true, intent: { kind: 'kill_switch' } });
    expect((await call('POST', '/api/v1/risk/kill-switch/release', { body: {} })).json.error).toBe('passkey_required');
    expect((await call('POST', '/api/v1/risk/kill-switch/release', { body: { assertion: assertion(p.json.options, attacker) } })).json.error).toBe('bad_approval');
    expect((await call('GET', '/api/v1/risk/state')).json.switches.killSwitch.on).toBe(true);
    const off = await call('POST', '/api/v1/risk/kill-switch/release', { body: { assertion: assertion(p.json.options) } });
    expect([off.status, off.json.killSwitch.on], JSON.stringify(off.json)).toEqual([200, false]);
    expect((await place(k.secret, { size: '0.001' })).json.order.status).toBe('FILLED');
    await call('POST', `/api/v1/derivatives/accounts/${acct}/close`, { body: { instrument: BTC, fraction: '1' }, headers: idem() });

    // the webhook, the audit chain and the alert
    for (let n = 0; n < 40 && received.filter((e) => e.event === 'risk.kill_switch').length < 2; n++) { await hooks.deliverDue(); await new Promise((r) => setTimeout(r, 20)); }
    expect(received.filter((e) => e.event === 'risk.kill_switch').map((e) => e.data)).toEqual([expect.objectContaining({ source: 'risk_engine', engaged: true, by: `api_key:${plain.id}`, reason: 'test' }), expect.objectContaining({ source: 'risk_engine', engaged: false })]);
    expect((await sql`select data from audit_events where type = 'risk.kill_switch' order by seq`).map((a: any) => a.data.engaged)).toEqual([true, false]);
    // the alert comes from the audit event, through the rules of the existing alert dispatcher
    const { deriveAlerts } = await import('../src/alerts/rules.ts'), { alertDef, renderAlert } = await import('@spw/core');
    const rows = await sql`select seq, ts, type, actor, data from audit_events where type = 'risk.kill_switch' order by seq`;
    const drafts = (await Promise.all(rows.map((a: any) => deriveAlerts({ source: 'audit', id: Number(a.seq), ts: a.ts, type: a.type, actor: a.actor, data: a.data }, { q: sql, settings: {} as never })))).flat();
    expect(drafts.map((x: any) => [x.kind, alertDef(x.kind)?.severity])).toEqual([['security.kill_switch_on', 'critical'], ['security.kill_switch_off', 'warning']]);
    expect(renderAlert(drafts[0].kind, drafts[0].params, 'en').body).toMatch(/No new risk is taken on any venue \(api_key:spk_[0-9a-f]{12}\)\. test/);
  });

  it('read-only mode: only a cancel passes — not an opening order, not even a reduce-only close', async () => {
    const k = await tradingKey();
    expect((await place(k.secret)).json.order.status).toBe('FILLED');
    const rest = await place(k.secret, { type: 'limit', price: '49000', size: '0.01' });
    expect((await call('POST', '/api/v1/risk/read-only', { body: { reason: 'maintenance' } })).json.readOnly).toMatchObject({ on: true });
    expect((await place(k.secret)).json.error).toBe('read_only_mode');
    const red = await call('POST', `${T}/positions/${encodeURIComponent(`paper:hyperliquid:${acct}:${BTC}`)}/close`, { key: k.secret, headers: idem(), body: {} });
    expect([red.status, red.json.error]).toEqual([423, 'read_only_mode']);
    expect((await call('POST', `/api/v1/derivatives/accounts/${acct}/close`, { body: { instrument: BTC, fraction: '1' }, headers: idem() })).json.error).toBe('read_only_mode');
    const cancel = await call('DELETE', `${T}/orders/${rest.json.order.id}`, { key: k.secret, headers: idem() });
    expect([cancel.status, cancel.json.order.status]).toEqual([200, 'CANCELLED']);
    expect((await call('POST', '/api/v1/risk/read-only/release', { body: {} })).json.error).toBe('passkey_required');
    expect((await releaseSwitch('read-only')).json.readOnly.on).toBe(false);
    expect((await call('POST', `/api/v1/derivatives/accounts/${acct}/close`, { body: { instrument: BTC, fraction: '1' }, headers: idem() })).status).toBe(200);
  });

  it('a stale price denies a market order but lets a reduce-only limit order through', async () => {
    const k = await tradingKey();
    expect((await place(k.secret)).json.order.status).toBe('FILLED');
    v.hl.down = true; clock.advance(20_000);                                                        // the venue stops answering: no fresh price, no book
    const mkt = await call('POST', `${T}/orders/preview`, { key: k.secret, body: { ...ORDER, size: '0.01' } });
    expect(mkt.status, JSON.stringify(mkt.json)).toBe(200);
    expect(mkt.json.risk.decision).toBe('deny');
    expect(mkt.json.risk.checks.find((c: any) => c.id === 'price_freshness')).toMatchObject({ ok: false });
    const close = await call('POST', `${T}/orders/preview`, { key: k.secret, body: { ...ORDER, side: 'sell', type: 'market', size: '0.01', reduceOnly: true } });
    expect(close.json.risk.checks.find((c: any) => c.id === 'price_freshness')).toMatchObject({ ok: false, exempt: false });   // a market close has no price bound of its own
    const lim = await call('POST', `${T}/orders/preview`, { key: k.secret, body: { ...ORDER, side: 'sell', type: 'limit', price: '49990', size: '0.01', reduceOnly: true } });
    expect(lim.json.risk).toMatchObject({ decision: 'allow', reducing: true });
    expect(lim.json.risk.checks.find((c: any) => c.id === 'price_freshness')).toMatchObject({ ok: true, exempt: true });
    v.hl.down = false; setMarket(v, 50_000);
    await call('POST', `/api/v1/derivatives/accounts/${acct}/close`, { body: { instrument: BTC, fraction: '1' }, headers: idem() });
  });
});

describe('trading mandates', () => {
  beforeEach(reset);
  it('lifecycle of a paper mandate: created (no effect), approved without a passkey, the enforcement table says API only; immutable', async () => {
    const k = await newKey();
    const m = await call('POST', '/api/v1/mandates', { body: { ...MANDATE, principal: { kind: 'api_key', id: k.id }, accountIds: [acct], stopConditions: [{ kind: 'loss_gte', usd: '100' }] } });
    expect(m.status, JSON.stringify(m.json)).toBe(200);
    const id = m.json.mandate.id;
    expect(m.json.mandate).toMatchObject({ state: 'created', phase: 'not_approved', mode: 'paper', principal: { kind: 'api_key', id: k.id }, mandate: { v: 1, mandateId: id, venues: ['hyperliquid'], networks: ['mainnet'], instruments: [BTC], mode: 'paper' } });
    const { tradingMandateHashHex, TRADING_MANDATE_FIELDS } = await import('@spw/trading');
    const { principalDescriptorSha256 } = await import('../src/mandates/service.ts');
    expect(m.json.mandate.hash).toBe(tradingMandateHashHex(m.json.mandate.mandate));
    expect(m.json.mandate.mandate.strategySha256).toBe(principalDescriptorSha256({ kind: 'api_key', id: k.id }));                 // the API-key convention
    expect(m.json.mandate.mandate.strategySha256).toBe(createHash('sha256').update(`spw-principal-v1|api_key|${k.id}`).digest('hex'));
    expect(m.json.mandate.enforcement.map((e: any) => e.field)).toEqual(TRADING_MANDATE_FIELDS);
    expect(m.json.mandate.enforcement.every((e: any) => e.enforcedBy === 'api_only')).toBe(true);
    // not approved: it cannot be bound, and a key bound to nothing cannot place
    expect((await call('POST', `${DEV}/keys/${k.id}/update/prepare`, { body: { changes: { mandateId: id } } })).json.error).toBe('mandate_not_active');
    expect((await place(k.secret)).json.error).toBe('mandate_required');
    const prep = await call('POST', `/api/v1/mandates/${id}/approve/prepare`, { body: {} });
    expect(prep.json).toMatchObject({ mandateId: id, passkey: false, signer: null, hash: m.json.mandate.hash });
    expect(prep.json.enforcement).toHaveLength(TRADING_MANDATE_FIELDS.length);
    const a = await call('POST', `/api/v1/mandates/${id}/approve`, { body: {} });
    expect(a.json.mandate).toMatchObject({ state: 'active', phase: 'active' });
    expect((await sql`select data from audit_events where type = 'mandate.approved' order by seq desc limit 1`)[0].data).toMatchObject({ mandateId: id, passkey: false, mode: 'paper' });
    // there is no route that changes a mandate
    for (const method of ['PUT', 'PATCH', 'DELETE']) expect((await call(method, `/api/v1/mandates/${id}`, { body: { maxOrderNotionalUsd: '999999' } })).status).toBe(404);
    expect((await call('GET', `/api/v1/mandates/${id}`)).json.mandate.mandate).toEqual(m.json.mandate.mandate);
    // invalid mandates are refused at creation, with the field
    for (const [over, code] of [[{ maxOrderNotionalUsd: '99999' }, 'invalid_mandate'], [{ floorEquityUsd: '6000' }, 'invalid_mandate'], [{ instruments: [BTC, 'gmx:BTC-USD'] }, 'invalid_mandate'], [{ principal: { kind: 'api_key', id: 'spk_000000000000' } }, 'unknown_principal'],
      [{ principal: { kind: 'agent', id: randomUUID() } }, 'unknown_principal'], [{ accountIds: [randomUUID()] }, 'unknown_account']] as const) {
      const r = await call('POST', '/api/v1/mandates', { body: { ...MANDATE, principal: { kind: 'api_key', id: k.id }, accountIds: [acct], ...over } });
      expect([r.status >= 400, r.json.error], JSON.stringify(over)).toEqual([true, code]);
    }
  });

  it('an order outside the mandate is refused, field by field — and is a REJECTED order with the reasons', async () => {
    const k = await tradingKey();
    const reasons = async (body: Record<string, unknown>) => (await call('POST', `${T}/orders/preview`, { key: k.secret, body: { ...ORDER, ...body } })).json.mandate?.reasons;
    expect(await reasons({ instrument: ETH, size: '0.1' })).toEqual(['INSTRUMENT_NOT_ALLOWED']);
    expect(await reasons({ size: '0.05' })).toEqual(['ORDER_NOTIONAL_EXCEEDED']);                                         // 2 500 USD > 2 000
    expect(await reasons({ leverage: '5' })).toEqual(['LEVERAGE_EXCEEDED']);
    expect(await reasons({ type: 'stop_market', triggerPrice: '51000', size: '0.01' })).toEqual(['ORDER_TYPE_NOT_ALLOWED']);
    expect(await reasons({ slippageBps: 300 })).toEqual(['SLIPPAGE_ABOVE_MANDATE']);
    expect(await reasons({ maxFeeUsd: '50' })).toEqual(['FEE_ABOVE_MANDATE']);
    expect(await reasons({})).toEqual([]);
    // a venue and an account outside the mandate (in-process: the wallet has no paper account on another venue)
    const { canonicalOrder } = await import('@spw/trading');
    const row = await app.execution.mandates.forPrincipal({ kind: 'api_key', id: k.id }, k.mandateId);
    const base = { v: 1 as const, venue: 'hyperliquid', network: 'mainnet', instrument: BTC, marketKind: 'perp' as const, side: 'buy' as const, type: 'market' as const, size: '0.01', notional: null, limitPrice: null, triggerPrice: null, reduceOnly: false, tif: 'ioc' as const,
      maxSlippageBps: 50, maxFeeUsd: '1', leverage: '2', marginMode: null, clientOrderId: 'client-order-0001', mode: 'paper' as const, principal: { kind: 'api_key' as const, id: k.id }, mandateId: k.mandateId, createdAt: clock.now(), expiresAt: clock.now() + 60_000 };
    const ev = { reducing: false, derived: { size: '0.01', notional: '500', referencePrice: '50000', positionBefore: '0', positionAfter: '0.01' }, market: { instrument: null, ticker: { ts: clock.now() } as never, book: null, hasBook: true }, leverage: '2', accounts: [{ accountId: acct, venue: 'hyperliquid', equity: '10000', marginUsed: '0', freeCollateral: '10000' }] };
    const check = async (over: object, account = acct) => (await app.execution.mandates.check(row, canonicalOrder({ ...base, ...over }), account, ev, null)).reasons;
    expect(await check({})).toEqual([]);
    expect(await check({ venue: 'gmx', instrument: 'gmx:BTC-USD' })).toEqual(expect.arrayContaining(['VENUE_NOT_ALLOWED', 'INSTRUMENT_NOT_ALLOWED', 'ACCOUNT_NOT_ALLOWED']));
    expect(await check({ network: 'testnet' })).toEqual(expect.arrayContaining(['NETWORK_NOT_ALLOWED']));
    expect(await check({}, randomUUID())).toEqual(['ACCOUNT_NOT_ALLOWED']);
    expect(await check({ mode: 'live' })).toEqual(expect.arrayContaining(['MODE_MISMATCH']));
    expect(await check({ principal: { kind: 'api_key', id: 'spk_ffffffffffff' } })).toEqual(['PRINCIPAL_MISMATCH']);
    expect(await check({ expiresAt: clock.now() + 23 * 3600_000, createdAt: clock.now() })).toEqual([]);
    // placing it: 403 with the reasons; the order exists, REJECTED / MANDATE_DENIED; the engine was never asked
    const o = await place(k.secret, { size: '0.05' });
    expect([o.status, o.json.error]).toEqual([403, 'mandate_denied']);
    expect(o.json.data).toMatchObject({ reasons: ['ORDER_NOTIONAL_EXCEEDED'], order: { status: 'REJECTED', reasonCode: 'MANDATE_DENIED', rejectCode: 'mandate_denied' } });
    expect((await sql`select count(*)::int as n from deriv_orders where client_id = ${o.json.data.order.id}`)[0].n).toBe(0);
    expect((await call('GET', `/api/v1/mandates/${k.mandateId}`)).json.mandate.usage).toMatchObject({ ordersRejected: 1, consecutiveRejects: 1, ordersAccepted: 0 });
  });

  it('capital, frequency and loss limits of the mandate; the key\'s own notional limits and restrictions', async () => {
    // capital: 250 USD at leverage 1 against a capital of 100
    const cap = await tradingKey({ maxCapitalUsd: '100', maxOrderNotionalUsd: '300', maxPositionNotionalUsd: '300', maxDailyLossUsd: '50', floorEquityUsd: '10' });
    expect((await call('POST', `${T}/orders/preview`, { key: cap.secret, body: { ...ORDER, size: '0.005', leverage: '1' } })).json.mandate.reasons).toEqual(['CAPITAL_EXCEEDED']);
    expect((await call('POST', `${T}/orders/preview`, { key: cap.secret, body: { ...ORDER, size: '0.005' } })).json.mandate.reasons).toEqual([]);                       // 250 / 3 = 83 USD of margin
    // frequency: one order per minute, hour and day
    const freq = await tradingKey({ frequency: { perMinute: 1, perHour: 1, perDay: 1 } });
    expect((await place(freq.secret, { size: '0.001' })).json.order.status).toBe('FILLED');
    const second = await place(freq.secret, { size: '0.001' });
    expect(second.json.data.reasons).toEqual(['RATE_PER_MINUTE', 'RATE_PER_HOUR', 'RATE_PER_DAY']);
    // a reduction is never stopped by the frequency
    expect((await call('POST', `${T}/positions/${encodeURIComponent(`paper:hyperliquid:${acct}:${BTC}`)}/close`, { key: freq.secret, headers: idem(), body: {} })).json.order.status).toBe('FILLED');
    // loss: the round trip above lost the spread and the fees; a mandate that allows 0.01 USD of loss a day is used up
    const loss = await tradingKey({ maxDailyLossUsd: '0.01' });
    expect((await place(loss.secret, { size: '0.001' })).json.data.reasons).toEqual(['DAILY_LOSS_REACHED']);
    // floor: equity of the mandated account below the floor
    const small = await paperAccount('Small', '4000'), floor = await tradingKey({ floorEquityUsd: '4999', maxCapitalUsd: '5000' }, {}, small);
    expect((await call('POST', `${T}/orders/preview`, { key: floor.secret, body: { ...ORDER, size: '0.001', accountId: small } })).json.mandate.reasons).toEqual(['BELOW_FLOOR_EQUITY']);
    // the wallet now has two paper accounts on the venue: an order names its account
    expect((await call('POST', `${T}/orders/preview`, { key: floor.secret, body: { mode: 'paper', instrument: BTC, side: 'buy', type: 'market', size: '0.001' } })).json.error).toBe('account_required');

    // the key's own limits and restrictions come first, before any order exists
    const lim = await tradingKey({}, { limits: { maxOrderNotionalUsd: 400, maxDailyNotionalUsd: 600 } });
    const big = await place(lim.secret, { size: '0.01' });                                                               // 500 USD
    expect([big.status, big.json.error]).toEqual([403, 'key_limit_exceeded']);
    expect((await place(lim.secret, { size: '0.007' })).json.order.status).toBe('FILLED');                           // 350 USD
    const day = await place(lim.secret, { size: '0.007' });                                                              // 700 USD today
    expect([day.status, day.json.error]).toEqual([403, 'key_limit_exceeded']);
    expect((await sql`select count(*)::int as n from orders where principal_id = ${lim.id}`)[0].n).toBe(1);
    expect((await call('POST', `${T}/positions/${encodeURIComponent(`paper:hyperliquid:${acct}:${BTC}`)}/close`, { key: lim.secret, headers: idem(), body: {} })).json.order.status).toBe('FILLED');   // an exit is not stopped by the key's limits
    const venue = await tradingKey({}, { restrictions: { venues: ['gmx'] } });
    expect((await place(venue.secret)).json.error).toBe('restricted');
    const inst = await tradingKey({}, { restrictions: { instruments: [ETH] } });
    expect((await place(inst.secret)).json.error).toBe('restricted');
    const net = await tradingKey({}, { restrictions: { networks: ['base'] } });
    expect((await place(net.secret)).json.error).toBe('restricted');
  });

  it('a key cannot create, read, approve, alter or revoke a mandate, change a limit or release a switch: every such route refuses a valid key', async () => {
    const k = await tradingKey();
    const routes: [string, string][] = [['GET', '/api/v1/mandates'], ['POST', '/api/v1/mandates'], ['GET', `/api/v1/mandates/${k.mandateId}`], ['POST', `/api/v1/mandates/${k.mandateId}/approve/prepare`], ['POST', `/api/v1/mandates/${k.mandateId}/approve`],
      ['POST', `/api/v1/mandates/${k.mandateId}/revoke`], ['GET', '/api/v1/risk/state'], ['GET', '/api/v1/risk/decisions'], ['GET', '/api/v1/risk/exposure'], ['POST', '/api/v1/risk/kill-switch'], ['POST', '/api/v1/risk/kill-switch/release/prepare'],
      ['POST', '/api/v1/risk/kill-switch/release'], ['POST', '/api/v1/risk/read-only'], ['POST', '/api/v1/risk/read-only/release/prepare'], ['POST', '/api/v1/risk/read-only/release'], ['GET', '/api/v1/risk/limits/live'], ['POST', '/api/v1/risk/limits/live'],
      ['POST', '/api/v1/risk/limits/live/prepare'], ['POST', '/api/v1/risk/limits/live/approve'], ['POST', '/api/v1/risk/auto'], ['POST', '/api/v1/risk/auto/prepare'], ['GET', `${DEV}/command-defaults`], ['PUT', `${DEV}/command-defaults`]];
    const registered = (app.printRoutes({ commonPrefix: false }) as string);
    for (const p of ['/api/v1/mandates', '/api/v1/risk/']) expect(registered).toContain(p.replace('/api/v1/', ''));
    for (const [method, path] of routes) {
      const withKey = await call(method, path, { key: k.secret, ...(method === 'GET' ? {} : { body: {} }) });
      expect([withKey.status, withKey.json.error], `${method} ${path}`).toEqual([403, 'key_path_forbidden']);
      const none = await call(method, path, { cookie: null, ...(method === 'GET' ? {} : { body: {}, headers: { origin: ORIGIN, 'x-spw-csrf': '1' } }) });
      expect(none.status, `${method} ${path}`).toBe(401);
    }
    expect((await call('GET', `/api/v1/mandates/${k.mandateId}`)).json.mandate.state).toBe('active');                          // untouched
    // nor under the trading prefix: there is no mandate route there at all
    expect((await call('POST', `${T}/mandates`, { key: k.secret, body: {} })).status).toBe(404);
  });

  it('revocation: the owner only; from then on only reductions pass; a stop condition engages the same wind-down and cancels what rests', async () => {
    const k = await tradingKey();
    expect((await place(k.secret)).json.order.status).toBe('FILLED');
    const rest = await place(k.secret, { type: 'limit', price: '49000', size: '0.01' });
    const rv = await call('POST', `/api/v1/mandates/${k.mandateId}/revoke`, { body: {} });
    expect(rv.status, JSON.stringify(rv.json)).toBe(200);
    expect(rv.json).toMatchObject({ cancelled: 1, signerRevoked: null, mandate: { state: 'revoked', phase: 'wind_down', revocation: { record: { reason: 'owner_request', revokedBy: { kind: 'owner' } } } } });
    expect((await orderRow(rest.json.order.id)).state).toBe('CANCELLED');
    const open = await place(k.secret, { size: '0.001' });
    expect([open.status, open.json.error]).toEqual([403, 'mandate_denied']);
    expect(open.json.data.reasons).toEqual(['MANDATE_REVOKED', 'WIND_DOWN_REDUCING_ONLY']);
    const close = await call('POST', `${T}/positions/${encodeURIComponent(`paper:hyperliquid:${acct}:${BTC}`)}/close`, { key: k.secret, headers: idem(), body: {} });
    expect([close.status, close.json.order?.status], JSON.stringify(close.json)).toEqual([200, 'FILLED']);
    expect((await call('POST', `${DEV}/keys/${(await newKey()).id}/update/prepare`, { body: { changes: { mandateId: k.mandateId } } })).json.error).toMatch(/mandate_(principal_mismatch|not_active)/);

    // stop condition: two refusals in a row
    const s = await tradingKey({ stopConditions: [{ kind: 'consecutive_rejects_gte', count: 2 }] });
    expect((await place(s.secret, { size: '0.001' })).json.order.status).toBe('FILLED');
    const resting = await place(s.secret, { type: 'limit', price: '49000', size: '0.001' });
    expect(resting.json.order.status).toBe('SUBMITTED');
    for (let n = 0; n < 2; n++) expect((await place(s.secret, { size: '0.05' })).json.error).toBe('mandate_denied');
    expect((await app.execution.mandates.supervise()).stopped).toEqual([s.mandateId]);
    const after = (await call('GET', `/api/v1/mandates/${s.mandateId}`)).json.mandate;
    expect(after).toMatchObject({ state: 'revoked', phase: 'wind_down', stop: { code: 'STOP_CONSECUTIVE_REJECTS_GTE' }, revocation: { record: { reason: 'stop_condition', revokedBy: { kind: 'system' } } } });
    expect((await orderRow(resting.json.order.id)).state).toBe('CANCELLED');
    expect((await place(s.secret, { size: '0.001' })).json.data.reasons).toEqual(expect.arrayContaining(['MANDATE_REVOKED', 'WIND_DOWN_REDUCING_ONLY']));
    expect((await call('POST', `${T}/positions/${encodeURIComponent(`paper:hyperliquid:${acct}:${BTC}`)}/close`, { key: s.secret, headers: idem(), body: {} })).json.order.status).toBe('FILLED');
    expect((await app.execution.mandates.supervise()).stopped).toEqual([]);
  });

  it('GMX (no signer mandate), dYdX and edgeX (jurisdiction) are refused at creation; so is an order on them', async () => {
    const k = await newKey(), body = { ...MANDATE, principal: { kind: 'api_key', id: k.id }, accountIds: [randomUUID()], mode: 'live' };
    const gmx = await call('POST', '/api/v1/mandates', { body: { ...body, venues: ['gmx'], instruments: ['gmx:BTC-USD'] } });
    expect([gmx.status, gmx.json.error]).toEqual([422, 'no_signer_mandate_for_venue']);
    for (const venue of ['dydx', 'edgex']) for (const mode of ['live', 'paper']) {
      const r = await call('POST', '/api/v1/mandates', { body: { ...body, mode, venues: [venue], instruments: [`${venue}:BTC-USD`] } });
      expect([r.status, r.json.error], `${venue} ${mode}`).toEqual([403, 'venue_restricted']);
    }
    expect((await call('POST', '/api/v1/mandates', { body: { ...body, venues: ['kyberswap'], instruments: ['kyberswap:ETH-USDC'], marketKinds: ['spot'], maxLeverage: '1' } })).json.error).toBe('spot_mandate_via_agent_vault');
    expect((await call('POST', '/api/v1/mandates', { body: { ...body, venues: ['hyperliquid', 'gmx'], instruments: [BTC, 'gmx:BTC-USD'] } })).json.error).toBe('no_signer_mandate_for_venue');
    expect((await sql`select count(*)::int as n from trading_mandates where mode = 'live'`)[0].n).toBe(0);
    // orders: a restricted venue is refused for everybody; spot through this endpoint is not offered to a key
    const t = await tradingKey();
    expect((await place(t.secret, { instrument: 'dydx:BTC-USD' })).json.error).toBe('venue_restricted');
    const own = await call('POST', `${T}/orders`, { headers: idem(), body: { ...ORDER, instrument: 'dydx:BTC-USD' } });
    expect([own.status, own.json.error]).toEqual([403, 'venue_restricted']);
    expect((await app.execution.orders.submit({ principal: { kind: 'api_key', id: t.id }, mandateId: t.mandateId }, { ...ORDER, instrument: 'spot:ETH', reduceOnly: false, tif: 'gtc' }, `spot-${randomUUID()}`).catch((e: any) => e.code))).toBe('spot_execution_requires_agent_vault');
    expect((await app.execution.orders.submit({ principal: { kind: 'owner', id: 'owner' }, mandateId: null }, { ...ORDER, instrument: 'spot:ETH', reduceOnly: false, tif: 'gtc' }, `spot-${randomUUID()}`).catch((e: any) => e.code))).toBe('spot_via_swap_screen');
    // live without a venue account, and the server switch (default off) are told apart
    expect((await place(t.secret, { mode: 'live', accountId: undefined })).json.error).toBe('no_account');
  });

  it('commands: the owner\'s defaults settle what the command leaves open; an ambiguous command executes nothing; the scope is the resolved operation\'s', async () => {
    const k = await tradingKey({ orderTypes: ['market', 'limit'], maxSlippageBps: 100 });
    const cmd = (key: string | null, text: string, o: Record<string, unknown> = {}) => call('POST', `${T}/commands`, { ...(key ? { key } : {}), headers: idem(), body: { text, mode: 'paper', accountId: acct, ...o } });
    expect((await call('PUT', `${DEV}/command-defaults`, { body: { defaults: {} } })).status).toBe(200);
    const amb = await cmd(k.secret, 'LONG BTC-PERP 500');
    expect([amb.status, amb.json.error]).toEqual([409, 'ambiguous_command']);
    expect(amb.json.data.questions.map((q: any) => q.field).sort()).toEqual(['leverage', 'marginMode', 'maxFeeBps', 'maxSlippageBps', 'network', 'orderTtlMs', 'venue']);
    expect((await sql`select count(*)::int as n from orders where principal_id = ${k.id}`)[0].n).toBe(0);
    expect((await cmd(k.secret, 'BUY THE DIP')).json.error).toBe('parse_error');
    const d = await call('PUT', `${DEV}/command-defaults`, { body: { defaults: { perpVenue: 'hyperliquid', perpNetworkByVenue: { hyperliquid: 'mainnet' }, perpLeverage: '2', perpMarginMode: 'cross', maxFeeBps: 10, maxSlippageBps: 50, orderTtlMs: 60_000 } } });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect((await call('PUT', `${DEV}/command-defaults`, { body: { defaults: { perpLeverage: 'lots' } } })).status).toBe(400);
    const dry = await cmd(k.secret, 'long btc-perp 500', { dryRun: true });
    expect(dry.status, JSON.stringify(dry.json)).toBe(200);
    expect(dry.json).toMatchObject({ kind: 'order', executed: false, order: { instrument: BTC, side: 'buy', type: 'market', notional: '500', size: null, leverage: '2', maxSlippageBps: 50, maxFeeUsd: '0.5', principal: { kind: 'api_key', id: k.id }, mandateId: k.mandateId } });
    expect((await sql`select count(*)::int as n from orders where principal_id = ${k.id}`)[0].n).toBe(0);
    const go = await cmd(k.secret, 'LONG BTC-PERP 500');
    expect(go.status, JSON.stringify(go.json)).toBe(200);
    expect(go.json).toMatchObject({ kind: 'order', executed: true, order: { status: 'FILLED', origin: 'command', side: 'buy', filled: '0.01' } });   // 500 USD at the mark of 50 000, rounded down to the lot
    const fr = await cmd(k.secret, 'FERMER BTC-PERP 50%');
    expect(fr.status, JSON.stringify(fr.json)).toBe(200);
    expect(fr.json.order).toMatchObject({ status: 'FILLED', side: 'sell', reduceOnly: true });
    expect((await cmd(k.secret, 'SHOW POSITIONS')).json).toMatchObject({ kind: 'query', query: 'positions' });
    const sl = await cmd(k.secret, 'LONG BTC-PERP 100 SL 45000 TP 60000', { dryRun: true });
    expect(sl.json.attached.map((a: any) => [a.role, a.placed, a.order.reduceOnly])).toEqual([['stop_loss', false, true], ['take_profit', false, true]]);
    expect((await cmd(k.secret, 'BUY ETH 100 USDC')).json.error).toBe('spot_execution_requires_agent_vault');
    expect((await cmd(null, 'BUY ETH 100 USDC')).json.error).toBe('spot_via_swap_screen');
    // scopes: a key that may only prepare cannot execute a command; a reader cannot cancel
    const prep = await newKey({ scopes: ['orders:prepare', 'positions:read'] });
    expect((await cmd(prep.secret, 'LONG BTC-PERP 500')).json.error).toBe('insufficient_scope');
    expect((await cmd(prep.secret, 'CANCEL ALL')).json.error).toBe('insufficient_scope');
    expect((await cmd(prep.secret, 'KILL')).json.error).toBe('insufficient_scope');
    expect((await cmd(prep.secret, 'SHOW POSITIONS')).status).toBe(200);
    expect((await cmd(prep.secret, 'LONG BTC-PERP 500', { dryRun: true })).json.error).toBe('mandate_required');
    // KILL engages the kill switch (a key with positions:manage); cancel-all cancels the key's own orders
    const resting = await place(k.secret, { type: 'limit', price: '49000', size: '0.001' });
    const all = await cmd(k.secret, 'CANCEL ALL');
    expect(all.json).toMatchObject({ kind: 'control', executed: true, results: [{ id: resting.json.order.id, ok: true, status: 'CANCELLED' }] });
    expect((await cmd(k.secret, 'URGENCE')).json).toMatchObject({ kind: 'control', control: { type: 'kill_switch_on' }, executed: true, killSwitch: { on: true } });
    expect((await cmd(k.secret, 'LONG BTC-PERP 500')).json.error).toBe('kill_switch_active');
    expect((await cmd(k.secret, 'CLOSE BTC-PERP')).json.order.status).toBe('FILLED');
    expect((await releaseSwitch('kill-switch')).json.killSwitch.on).toBe(false);
  });

  it('expiry: after its end date the mandate lets only reductions through, then nothing', async () => {
    const k = await tradingKey({ days: 1 });
    expect((await place(k.secret, { size: '0.001' })).json.order.status).toBe('FILLED');
    clock.advance(86_400_000 - 30_000); setMarket(v, 50_000);
    expect((await call('POST', `${T}/orders/preview`, { key: k.secret, body: { ...ORDER, size: '0.001' } })).json.mandate.reasons).toEqual(['ORDER_OUTLIVES_MANDATE']);   // it could still execute after the end
    clock.advance(60_000); setMarket(v, 50_000);
    const late = await place(k.secret, { size: '0.001' });
    expect(late.json.data.reasons).toEqual(['MANDATE_ENDED', 'WIND_DOWN_REDUCING_ONLY', 'ORDER_OUTLIVES_MANDATE']);
    expect((await call('GET', `/api/v1/mandates/${k.mandateId}`)).json.mandate).toMatchObject({ state: 'active', phase: 'wind_down' });
    expect((await call('POST', `${T}/positions/${encodeURIComponent(`paper:hyperliquid:${acct}:${BTC}`)}/close`, { key: k.secret, headers: idem(), body: {} })).json.order.status).toBe('FILLED');
    clock.advance(86_400_000 + 60_000); setMarket(v, 50_000);
    expect((await place(k.secret, { size: '0.001' })).json.data.reasons).toEqual(['MANDATE_ENDED', 'ORDER_OUTLIVES_MANDATE']);
    const { verifyKeyBinding } = app.execution.mandates;
    await expect(verifyKeyBinding.call(app.execution.mandates, k.id, k.mandateId)).rejects.toMatchObject({ code: 'mandate_not_active' });
  });
});
