// V11 execution on the LIVE path, through the real server, against the faked venue + the REAL isolated signer class (the world of
// perp-live-world.ts: scripted Hyperliquid testnet and mainnet, a software passkey, the signer's own venue reader). No network,
// no real key, nothing leaves the process.
//
//   - SPW_TRADING_API_EXECUTION off: new live risk is refused (403 execution_disabled), nothing is created;
//   - live limits the owner never set: denied by the risk engine;
//   - owner: AWAITING_APPROVAL, approved with the passkey through the EXISTING route, then the venue's truth;
//   - an order through the route that existed before is in the unified table too;
//   - a LIVE trading mandate: compiled, approved at the signer in one passkey ceremony, enforcement table; an API key then places
//     an order that the signer signs under the mandate — with every mainnet lock off (refused, precise code) and on;
//   - an ambiguous submission is UNKNOWN, never FAILED, never retried; the reconciler finds it, or fails it only after the grace;
//   - restart: a new process resolves an UNKNOWN order from the database alone;
//   - paper and live never share a context; the kill switch stops a proposal made before it; revocation reaches the signer.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSignerServer } from '../../isolated-signer/src/server.ts';
import { BTC, fixtureVenues, setMarket, useDatabase } from './derivatives-helpers.ts';
import { AUTH_POLICY, liveWorld, ORIGIN, type LiveWorld } from './perp-live-world.ts';

const SECRET = 'k'.repeat(48), T = '/api/v1/trading', DEV = '/api/v1/developer', L = '/api/v1/derivatives/live';
const ALL = ['wallet:read', 'markets:read', 'orders:read', 'orders:prepare', 'orders:execute', 'orders:cancel', 'positions:read', 'positions:manage'];
let app: any, sql: any, cookie = '', w: LiveWorld, signerSrv: Server, testnet = '', mainnet = '', mod: typeof import('../src/derivatives/index.ts'), derivs: any, ipSeq = 0;

interface Res { status: number; json: any; headers: Record<string, any> }
async function call(method: string, path: string, o: { key?: string | null; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...o.headers };
  if (o.key) headers.authorization = `Bearer ${o.key}`; else { headers.cookie = cookie; if (method !== 'GET') { headers.origin = ORIGIN; headers['x-spw-csrf'] = '1'; } }
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const ip = path.startsWith(DEV) ? `10.202.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}` : undefined;
  const r = await app.inject({ method, url: path, headers, payload: o.body === undefined ? undefined : JSON.stringify(o.body), ...(ip ? { remoteAddress: ip } : {}) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), headers: r.headers };
}
const idem = () => ({ 'idempotency-key': `live-${randomUUID()}` });
const sign = (options: { challenge: string }) => w.pk.assert(Buffer.from(options.challenge, 'base64url'));
async function newKey(): Promise<{ id: string; secret: string }> {
  const p = await call('POST', `${DEV}/keys/prepare`, { body: { name: 'live key', scopes: ALL, expiresInDays: 30, rateLimitPerMin: 600 } });
  const c = await call('POST', `${DEV}/keys`, { body: { intentId: p.json.intentId, assertion: sign(p.json.options) } });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  return { id: c.json.key.id, secret: c.json.secret };
}
const MANDATE = { mode: 'live', instruments: [BTC], orderTypes: ['market', 'limit'], maxCapitalUsd: '400', maxOrderNotionalUsd: '800', maxPositionNotionalUsd: '1000', maxLeverage: '3', maxDailyLossUsd: '50', floorEquityUsd: '100', days: 7,
  frequency: { perMinute: 5, perHour: 20, perDay: 40 }, maxSlippageBps: 100, maxFeeUsd: '5', label: 'live mandate', locale: 'en' };
/** the owner's whole ceremony for a LIVE mandate: create → prepare (the sheet) → approve with the passkey at the signer → bind the key */
async function liveKey(accountId: string, over: Record<string, unknown> = {}) {
  const k = await newKey();
  const m = await call('POST', '/api/v1/mandates', { body: { ...MANDATE, principal: { kind: 'api_key', id: k.id }, accountIds: [accountId], ...over } });
  expect(m.status, JSON.stringify(m.json)).toBe(200);
  const id = m.json.mandate.id as string;
  const prep = await call('POST', `/api/v1/mandates/${id}/approve/prepare`, { body: { locale: 'en' } });
  expect(prep.status, JSON.stringify(prep.json)).toBe(200);
  const a = await call('POST', `/api/v1/mandates/${id}/approve`, { body: { assertion: sign(prep.json.signer.options), bindingAssertion: sign(prep.json.binding.options), acknowledged: true } });
  expect(a.status, JSON.stringify(a.json)).toBe(200);
  const p = await call('POST', `${DEV}/keys/${k.id}/update/prepare`, { body: { changes: { mandateId: id } } });
  expect((await call('POST', `${DEV}/keys/${k.id}/update`, { body: { intentId: p.json.intentId, assertion: sign(p.json.options) } })).status).toBe(200);
  return { ...k, mandateId: id, prep: prep.json, created: m.json.mandate };
}
const LIMITS = { allowedVenues: ['hyperliquid'], allowedInstruments: [BTC], maxOrderNotional: '1000', maxDailyNotional: '20000', maxPositionNotional: { per: {}, default: '1000' }, maxOrderLeverage: '25', maxAccountLeverage: '3', maxGrossExposure: '1500',
  maxNetExposure: '1500', maxAssetExposure: { per: {}, default: '1500' }, maxVenueExposure: { per: {}, default: '1500' }, maxVenueCollateralShareBps: '10000', maxDailyLoss: '200', maxTotalLoss: '400', maxDrawdownBps: '5000', maxOrdersPerMinute: 60 };
const order = (accountId: string, body: Record<string, unknown> = {}) => ({ mode: 'live', accountId, instrument: BTC, side: 'buy', type: 'market', size: '0.005', ...body });
const orderRow = async (id: string) => (await sql`select * from orders where id = ${id}`)[0];
const states = async (id: string) => (await sql`select to_state, event from order_events where order_id = ${id} order by seq`).map((e: any) => `${e.to_state}:${e.event}`);
const closeAll = async (net: 'testnet' | 'mainnet') => { const u = (net === 'testnet' ? w.t : w.m).user(w.ACCOUNT); u.positions.clear(); u.orders = u.orders.filter((o: any) => o.status !== 'open'); };

beforeAll(async () => {
  await useDatabase('execution_live');
  delete process.env.SPW_API_KEY_PEPPER; delete process.env.SPW_TRADING_API_EXECUTION;
  // the API's own signer client (status: reachable, halted) talks HTTP to the SAME signer instance the live engine uses in process.
  // Its address is read when the API's configuration is first imported, so the listener exists before the world is built.
  let inner: Server | null = null;
  signerSrv = createServer((req, res) => { if (inner) inner.emit('request', req, res); else { res.statusCode = 503; res.end(); } }).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  Object.assign(process.env, { SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}` });
  w = await liveWorld();
  inner = createSignerServer(w.signer, SECRET);
  const db = await import('../src/db.ts');
  sql = db.sql;
  await db.migrate();
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
  cookie = `${(await import('../src/auth.ts')).COOKIE}=${token}`;
  const c = w.pk.credential();
  await sql`insert into credentials (id, public_key, counter, transports, label) values (${c.id}, ${c.publicKey}, 0, ${sql.json(c.transports)}, 'test passkey')`;
  mod = await import('../src/derivatives/index.ts');
  const v = fixtureVenues(w.clock);
  setMarket(v, 70_000);
  derivs = mod.createDerivatives({ registry: mod.createRegistry(v.adapters, w.clock.now), now: w.clock.now });
  app = await (await import('../src/server.ts')).buildServer({ derivatives: derivs, live: w.svc, gmx: { status: async () => ({ network: 'arbitrum', account: null, positionsError: null, positions: [] }) } as never });
  testnet = await w.authorise('testnet');
  // the venue's leverage setting of the instrument, as the owner would set it with the passkey (the mandate allows 3×; the signer refuses to add exposure above it)
  w.t.user(w.ACCOUNT).leverage.set('BTC', { type: 'cross', value: 3 });
});
afterAll(async () => { app?.server.closeAllConnections?.(); await app?.close(); signerSrv?.close(); await sql?.end(); });

describe('locks and defaults', () => {
  it('SPW_TRADING_API_EXECUTION is off by default: a live order is refused 403 execution_disabled and nothing is created; the preview says so', async () => {
    const r = await call('POST', `${T}/orders`, { headers: idem(), body: order(testnet) });
    expect([r.status, r.json.error]).toEqual([403, 'execution_disabled']);
    expect((await sql`select count(*)::int as n from orders`)[0].n).toBe(0);
    expect((await sql`select count(*)::int as n from deriv_orders`)[0].n).toBe(0);
    const p = await call('POST', `${T}/orders/preview`, { body: order(testnet) });
    expect(p.json.refusals.find((x: any) => x.code === 'execution_disabled')).toMatchObject({ stage: 'lock' });
    expect(p.json.wouldExecute).toBe(false);
    expect((await call('GET', '/api/v1/risk/state')).json.locks.find((l: any) => l.id === 'trading_api_execution')).toMatchObject({ on: false });
    for (const bad of ['ON', 'true', '1', 'yes']) { process.env.SPW_TRADING_API_EXECUTION = bad; expect((await call('POST', `${T}/orders`, { headers: idem(), body: order(testnet) })).json.error, bad).toBe('execution_disabled'); }
    process.env.SPW_TRADING_API_EXECUTION = 'on';
  });

  it('live limits the owner never set deny new risk — through the trading API and through the route that existed before', async () => {
    const r = await call('POST', `${T}/orders`, { headers: idem(), body: order(testnet) });
    expect([r.status, r.json.error]).toEqual([422, 'risk_denied']);
    // the one-time seed ran when this server became ready, on a wallet that already had its authorized venue account: the owner's
    // own order is judged on the limits that account's policy and authorization already express. What has no equivalent there is
    // still missing, and still denies.
    expect([...r.json.data.failed].sort()).toEqual(['asset_exposure', 'collateral_concentration', 'daily_notional', 'drawdown', 'net_exposure', 'venue_exposure']);
    const lv = (await call('GET', '/api/v1/risk/limits/live')).json;
    expect(lv).toMatchObject({ stored: {}, ownerOrdersRefused: true, automationOrdersRefused: true, missing: ['maxDailyNotional', 'maxNetExposure', 'maxAssetExposure', 'maxVenueExposure', 'maxVenueCollateralShareBps', 'maxDrawdownBps'] });
    expect(lv.missingForAutomation).toHaveLength(15);
    expect(lv.seed.limits).toMatchObject({ allowedVenues: ['hyperliquid'], allowedInstruments: AUTH_POLICY.allowedInstruments, maxOrderLeverage: String(AUTH_POLICY.maxLeverage) });
    expect(lv.seed.accounts).toEqual([{ id: testnet, venue: 'hyperliquid', network: 'testnet' }]);
    // an API key or an agent sees none of it: every capital limit is still missing for them
    expect(await app.execution.risk.limitsFor('live', 'api_key')).toEqual({});
    expect(await app.execution.risk.limitsFor('live', 'agent')).toEqual({});
    expect(r.json.data.order).toMatchObject({ status: 'REJECTED', reasonCode: 'RISK_DENIED' });
    expect(w.signs).toHaveLength(0);
    const old = await call('POST', `${L}/accounts/${testnet}/orders`, { body: { instrument: BTC, side: 'buy', type: 'limit', size: '0.005', price: '69000' }, headers: idem() });
    expect([old.status, old.json.error]).toEqual([422, 'risk_denied']);
    // the owner sets them: a loosening, with the passkey
    expect((await call('POST', '/api/v1/risk/limits/live', { body: { limits: LIMITS } })).json.error).toBe('passkey_required');
    const p = await call('POST', '/api/v1/risk/limits/live/prepare', { body: { limits: LIMITS } });
    expect(p.json.needed).toBe(true);
    expect((await call('POST', '/api/v1/risk/limits/live/approve', { body: { assertion: sign(p.json.options) } })).status).toBe(200);
    expect((await call('GET', '/api/v1/risk/limits/live')).json.missing).toEqual([]);
  });
});

describe('the owner, live', () => {
  it('an owner order waits AWAITING_APPROVAL; the passkey approval goes through the existing route; the venue says what happened; cancel', async () => {
    const o = await call('POST', `${T}/orders`, { headers: idem(), body: order(testnet, { type: 'limit', price: '69000', size: '0.005' }) });
    expect(o.status, JSON.stringify(o.json)).toBe(200);
    const id = o.json.order.id as string;
    expect(o.json.order).toMatchObject({ status: 'AWAITING_APPROVAL', mode: 'live', network: 'testnet', engine: 'hyperliquid', principal: { kind: 'owner' } });
    expect(id).toMatch(/^0x[0-9a-f]{32}$/);                                                         // the client order id IS the venue's cloid
    expect(o.json.approval).toMatchObject({ by: 'owner_passkey', accountId: testnet, clientId: id, approve: { path: `${L}/accounts/${testnet}/orders/${id}/approve` } });
    expect(w.signs).toHaveLength(0);                                                                  // nothing was signed
    expect(w.t.exchangeCalls('order')).toBe(0);
    const a = await call('POST', o.json.approval.approve.path, { body: { assertion: w.pk.assert(w.b64(o.json.approval.hash)) } });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(a.json.order.state).toBe('open');
    expect((await call('GET', `${T}/orders/${id}`)).json.order).toMatchObject({ status: 'SUBMITTED', engineStatus: 'open', acknowledged: true });
    expect(await states(id)).toEqual(['VALIDATED:validated', 'AWAITING_APPROVAL:approval_requested', 'APPROVED:approved', 'SUBMITTING:submit_started', 'SUBMITTED:venue_accepted']);
    expect([w.signs.length, w.t.exchangeCalls('order')]).toEqual([1, 1]);
    expect((await sql`select cloid from deriv_orders where client_id = ${id}`)[0].cloid).toBe(id);
    const c = await call('DELETE', `${T}/orders/${id}`, { headers: idem() });
    expect([c.status, c.json.order.status, c.json.order.reasonCode], JSON.stringify(c.json)).toEqual([200, 'CANCELLED', 'CANCELLED_BY_REQUEST']);
    expect(w.t.exchangeCalls('cancelByCloid')).toBe(1);
  });

  it('an order through the route that existed before is a unified order too; the kill switch stops a proposal made before it at the approval', async () => {
    w.next();
    const key = `old-${randomUUID()}`;
    const p = await call('POST', `${L}/accounts/${testnet}/orders`, { body: { instrument: BTC, side: 'buy', type: 'market', size: '0.005', slippageBps: 50 }, headers: { 'idempotency-key': key } });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    const g = await call('GET', `${T}/orders/deriv:${testnet}:${key}`);
    expect(g.json.order).toMatchObject({ status: 'AWAITING_APPROVAL', origin: 'legacy', engineStatus: 'risk_checked', mode: 'live' });
    expect((await sql`select decision from risk_decisions where order_id = ${g.json.order.orderId}`)).toEqual([{ decision: 'allow' }]);
    const a = await call('POST', `${L}/accounts/${testnet}/orders/${key}/approve`, { body: { assertion: w.pk.assert(w.b64(p.json.hash)) } });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect((await call('GET', `${T}/orders/deriv:${testnet}:${key}`)).json).toMatchObject({ order: { status: 'FILLED', filled: '0.005' }, fills: [expect.objectContaining({ size: '0.005' })] });
    // a second proposal, then the kill switch, then the approval
    w.next();
    const key2 = `old-${randomUUID()}`;
    const p2 = await call('POST', `${L}/accounts/${testnet}/orders`, { body: { instrument: BTC, side: 'buy', type: 'limit', size: '0.002', price: '69000' }, headers: { 'idempotency-key': key2 } });
    expect(p2.status, JSON.stringify(p2.json)).toBe(200);
    expect((await call('POST', '/api/v1/risk/kill-switch', { body: { reason: 'before approval' } })).json.killSwitch.on).toBe(true);
    const signed = w.signs.length;
    const a2 = await call('POST', `${L}/accounts/${testnet}/orders/${key2}/approve`, { body: { assertion: w.pk.assert(w.b64(p2.json.hash)) } });
    expect([a2.status, a2.json.error]).toEqual([423, 'kill_switch_active']);
    expect(w.signs.length).toBe(signed);                                                                  // the signer was not asked
    expect((await call('GET', `${T}/orders/deriv:${testnet}:${key2}`)).json.order).toMatchObject({ status: 'CANCELLED', reasonCode: 'HALTED_BEFORE_APPROVAL' });
    // the reduce-only close of the position still goes: proposed, approved with the passkey, signed, filled
    const cl = await call('POST', `${T}/positions/${encodeURIComponent(`live:hyperliquid:${testnet}:${BTC}`)}/close`, { headers: idem(), body: {} });
    expect([cl.status, cl.json.order?.status], JSON.stringify(cl.json)).toEqual([200, 'AWAITING_APPROVAL']);
    const a3 = await call('POST', cl.json.approval.approve.path, { body: { assertion: w.pk.assert(w.b64(cl.json.approval.hash)) } });
    expect(a3.status, JSON.stringify(a3.json)).toBe(200);
    expect((await call('GET', `${T}/orders/${cl.json.order.id}`)).json.order).toMatchObject({ status: 'FILLED', reduceOnly: true });   // (the approval went through the old route: the engine's change is projected)
    const rp = await call('POST', '/api/v1/risk/kill-switch/release/prepare');
    expect((await call('POST', '/api/v1/risk/kill-switch/release', { body: { assertion: sign(rp.json.options) } })).json.killSwitch.on).toBe(false);
  });
});

describe('restart', () => {
  it('while an order waits for the passkey, and while one rests at the venue: a new process settles both from the engine rows and the venue', async () => {
    w.next();
    const a = await call('POST', `${T}/orders`, { headers: idem(), body: order(testnet, { type: 'limit', price: '69000', size: '0.002' }) });
    expect(a.json.order?.status, JSON.stringify(a.json)).toBe('AWAITING_APPROVAL');
    w.next();
    const b = await call('POST', `${T}/orders`, { headers: idem(), body: order(testnet, { type: 'limit', price: '68000', size: '0.002' }) });
    expect((await call('POST', b.json.approval.approve.path, { body: { assertion: w.pk.assert(w.b64(b.json.approval.hash)) } })).status).toBe(200);
    expect((await call('GET', `${T}/orders/${b.json.order.id}`)).json.order.status).toBe('SUBMITTED');
    // the API process is gone. Meanwhile the approval window of the first order closes, and the venue cancels the second.
    await sql`delete from order_projection_queue`;
    w.clock.advance(180_000);
    const resting = w.t.user(w.ACCOUNT).orders.find((x: any) => x.cloid === b.json.order.id)!;
    resting.status = 'canceled'; resting.statusTimestamp = w.clock.now();
    // a new process: the engine's own reconciliation worker, then the order reconciler — nothing but the database and the venue
    const { createExecution } = await import('../src/orders/index.ts');
    const fresh = createExecution({ derivatives: derivs, live: w.svc, gmx: { status: async () => ({ positions: [] }) } as never });
    await w.svc.step();
    await fresh.orders.reconcile();
    expect(await orderRow(a.json.order.id)).toMatchObject({ state: 'CANCELLED', reason: 'APPROVAL_EXPIRED' });
    expect(await orderRow(b.json.order.id)).toMatchObject({ state: 'CANCELLED', reason: 'CANCELLED_AT_VENUE' });
    expect((await states(b.json.order.id)).at(-1)).toBe('CANCELLED:reconciled_found');
    expect((await sql`select count(*)::int as n from orders where projection_error is not null`)[0].n).toBe(0);
  });
});

describe('a LIVE trading mandate and an API key', () => {
  let k: Awaited<ReturnType<typeof liveKey>>;

  it('creation compiles for the signer; the approval sheet carries the enforcement table; one passkey ceremony at the signer; refused without it', async () => {
    w.next();
    k = await liveKey(testnet);
    const { TRADING_MANDATE_FIELDS, tradingMandateHashHex } = await import('@spw/trading');
    const { venueMandateHash, hex } = await import('@spw/derivatives/live');
    const by = Object.fromEntries(k.prep.enforcement.map((e: any) => [e.field, e.enforcedBy]));
    expect(Object.keys(by)).toEqual(TRADING_MANDATE_FIELDS);                                               // every field, none left out
    expect(by).toMatchObject({ instruments: 'signer', maxOrderNotionalUsd: 'signer', maxPositionNotionalUsd: 'signer', maxLeverage: 'signer', floorEquityUsd: 'signer', notAfter: 'signer', accounts: 'signer', maxCapitalUsd: 'signer_partial',
      frequency: 'signer_partial', maxSlippageBps: 'signer_partial', orderTypes: 'api_only', maxDailyLossUsd: 'api_only', stopConditions: 'api_only', maxFeeUsd: 'api_only' });
    expect(k.created.enforcement).toEqual(k.prep.enforcement);
    // the compiled derivative mandate: the same id, the API-key convention in strategySha256, the limits derived as documented
    const sm = k.prep.signer.mandate;
    expect(sm).toMatchObject({ mandateId: k.mandateId, venue: 'hyperliquid', network: 'testnet', account: w.ACCOUNT, agentId: k.id, strategySha256: createHash('sha256').update(`spw-principal-v1|api_key|${k.id}`).digest('hex'),
      maxOrderNotional: '800', maxGrossExposure: '1200', maxOrdersPerDay: 40, maxOrdersPerHour: 20, maxDailyTurnover: '32000', floorEquity: '100', maxPriceDeviationBps: 100, instruments: [{ instrument: BTC, maxLeverage: 3, maxPositionNotional: '1000' }] });
    expect(k.prep.signer.hash).toBe(hex(venueMandateHash(sm)));
    expect(k.prep.signer.options.challenge).toBe(Buffer.from(k.prep.signer.hash, 'hex').toString('base64url'));   // what the passkey signs
    expect(k.prep.hash).toBe(tradingMandateHashHex(k.prep.mandate));
    expect(k.prep.principalDescriptor).toBe(`spw-principal-v1|api_key|${k.id}`);
    // the signer holds it, active, under the same id; the API marks it active only after that
    const st = w.signer.status() as any;
    expect(st.venueMandates.find((m: any) => m.mandate.mandateId === k.mandateId)).toMatchObject({ hash: k.prep.signer.hash, phase: 'active' });
    expect((await call('GET', `/api/v1/mandates/${k.mandateId}`)).json.mandate).toMatchObject({ state: 'active', phase: 'active', signer: { shape: 'SPW-VENUE-MANDATE-v1', mandateId: k.mandateId, hash: k.prep.signer.hash, accountId: testnet } });
    expect((await sql`select data from audit_events where type = 'mandate.approved' order by seq desc limit 1`)[0].data).toMatchObject({ mandateId: k.mandateId, passkey: true, mode: 'live' });
    // one venue account serves one principal at a time: a second principal is refused at creation, with the holder; nothing is stored
    const k2 = await newKey(), nMandates = (await sql`select count(*)::int as n from trading_mandates`)[0].n;
    const m2 = await call('POST', '/api/v1/mandates', { body: { ...MANDATE, principal: { kind: 'api_key', id: k2.id }, accountIds: [testnet] } });
    expect([m2.status, m2.json.error], JSON.stringify(m2.json)).toEqual([409, 'account_has_active_mandate']);
    expect(m2.json.data.holder).toEqual({ via: 'trading_mandate', mandateId: k.mandateId, principal: `api_key:${k.id}` });
    expect((await sql`select count(*)::int as n from trading_mandates`)[0].n).toBe(nMandates);
    // what cannot be expressed for the signer is refused at creation, with the field
    for (const [over, code] of [[{ maxLeverage: '2.5' }, 'value_not_expressible'], [{ maxOrderNotionalUsd: '1200', maxPositionNotionalUsd: '1200' }, 'exceeds_authorization'], [{ days: 45 }, 'duration_not_expressible'],
      [{ instruments: [BTC, 'hyperliquid:ETH'] }, 'exceeds_authorization'], [{ frequency: { perMinute: 5, perHour: 20, perDay: 60 } }, 'exceeds_authorization']] as const) {
      const r = await call('POST', '/api/v1/mandates', { body: { ...MANDATE, principal: { kind: 'api_key', id: k2.id }, accountIds: [testnet], ...over } });
      expect([r.status, r.json.error], JSON.stringify(over)).toEqual([422, code]);
    }
  });

  it('the key places an order: mandate → risk engine → the engine\'s mandate path → the signer signs under the mandate → the venue; a replay sends nothing', async () => {
    const before = { signs: w.orderSigns(), calls: w.t.exchangeCalls('order') }, h = idem();
    const pv = await call('POST', `${T}/orders/preview`, { key: k.secret, body: order(testnet) });
    expect(pv.json, JSON.stringify(pv.json.refusals)).toMatchObject({ wouldExecute: true, approval: { required: false, by: 'mandate' }, mandate: { decision: 'allow' }, risk: { decision: 'allow' } });
    const o = await call('POST', `${T}/orders`, { key: k.secret, headers: h, body: order(testnet) });
    expect(o.status, JSON.stringify(o.json)).toBe(200);
    const id = o.json.order.id as string;
    expect(o.json.order).toMatchObject({ status: 'FILLED', filled: '0.005', mode: 'live', principal: { kind: 'api_key', id: k.id }, mandateId: k.mandateId, engine: 'hyperliquid' });
    expect(await states(id)).toEqual(['VALIDATED:validated', 'APPROVED:approved', 'SUBMITTING:submit_started', 'FILLED:reconciled_found']);
    expect((await sql`select reason from order_events where order_id = ${id} and event = 'approved'`)[0].reason).toBe('APPROVED_BY_MANDATE');
    expect([w.orderSigns() - before.signs, w.t.exchangeCalls('order') - before.calls]).toEqual([1, 1]);
    // the request the signer signed: under the mandate, no passkey, the order the API described
    const signed = w.mandateSigns.at(-1);
    expect(signed).toMatchObject({ mandateId: k.mandateId, context: { order: { kind: 'order', instrument: BTC, side: 'buy', size: '0.005', clientId: id, reduceOnly: false } } });
    expect(signed.assertion).toBeUndefined();
    expect((await sql`select origin, mandate_id, agent from deriv_orders where client_id = ${id}`)[0]).toMatchObject({ origin: 'mandate', mandate_id: k.mandateId, agent: { agentId: k.id } });
    // replay
    const again = await call('POST', `${T}/orders`, { key: k.secret, headers: h, body: order(testnet) });
    expect([again.status, again.json.order.id, again.headers['idempotent-replay']]).toEqual([200, id, 'true']);
    expect([w.orderSigns() - before.signs, w.t.exchangeCalls('order') - before.calls]).toEqual([1, 1]);
    // outside the mandate: refused by the API before the signer is asked (and the signer would refuse it too)
    const big = await call('POST', `${T}/orders`, { key: k.secret, headers: idem(), body: order(testnet, { size: '0.012' }) });       // 840 USD > 800
    expect([big.status, big.json.error]).toEqual([403, 'mandate_denied']);
    expect(big.json.data.reasons).toEqual(['ORDER_NOTIONAL_EXCEEDED', 'POSITION_NOTIONAL_EXCEEDED']);                 // and with the 0.005 already held, the position limit of 1 000
    expect(w.orderSigns() - before.signs).toBe(1);
    // a key cannot cancel another principal's order
    const [ownerOrder] = await sql`select id from orders where principal_kind = 'owner' limit 1`;
    expect((await call('DELETE', `${T}/orders/${ownerOrder.id}`, { key: k.secret, headers: idem() })).json.error).toBe('not_your_order');
  });

  it('an ambiguous submission is UNKNOWN — never FAILED, never sent again; the reconciler finds it at the venue', async () => {
    w.next();
    w.t.fault = 'lost_after';                                                                             // the venue took the order; its answer never arrived
    const calls = w.t.exchangeCalls('order');
    const o = await call('POST', `${T}/orders`, { key: k.secret, headers: idem(), body: order(testnet, { type: 'limit', price: '69500', size: '0.002' }) });
    expect(o.status, JSON.stringify(o.json)).toBe(200);
    const id = o.json.order.id as string;
    // the engine reconciles once right after the submission: by its client order id the venue already shows it
    expect(['UNKNOWN', 'SUBMITTED']).toContain(o.json.order.status);
    expect(w.t.exchangeCalls('order')).toBe(calls + 1);
    await app.execution.orders.reconcile();
    expect(await orderRow(id)).toMatchObject({ state: 'SUBMITTED' });
    expect((await states(id)).slice(2)).toEqual(expect.arrayContaining(['SUBMITTING:submit_started']));
    expect(w.t.exchangeCalls('order')).toBe(calls + 1);                                                    // never re-sent
    expect((await call('DELETE', `${T}/orders/${id}`, { key: k.secret, headers: idem() })).json.order.status).toBe('CANCELLED');
  });

  it('…or does not find it: the order stays UNKNOWN inside the grace, and is FAILED (NEVER_PLACED) only once the signed request can no longer be accepted; a new process does it from the database alone', async () => {
    w.next();
    w.t.fault = 'lost_before';                                                                            // the request never reached the venue; from here the API cannot know
    const calls = w.t.exchangeCalls('order');
    const o = await call('POST', `${T}/orders`, { key: k.secret, headers: idem(), body: order(testnet, { type: 'limit', price: '69500', size: '0.002' }) });
    expect(o.status, JSON.stringify(o.json)).toBe(200);
    const id = o.json.order.id as string;
    expect(o.json.order).toMatchObject({ status: 'UNKNOWN', final: false, reasonCode: 'SUBMIT_UNREADABLE_ANSWER', filled: '0' });
    expect(await states(id)).toEqual(['VALIDATED:validated', 'APPROVED:approved', 'SUBMITTING:submit_started', 'UNKNOWN:submit_ambiguous']);
    expect(await app.execution.orders.reconcile()).toMatchObject({ unknown: 0 });                          // asked a moment ago: the next lookup is a few seconds away
    w.clock.advance(6_000);
    expect(await app.execution.orders.reconcile()).toMatchObject({ unknown: 1, resolved: 0 });
    expect(await orderRow(id)).toMatchObject({ state: 'UNKNOWN' });                                        // the venue does not know it, but the signature could still be accepted
    // "restart": another process, with nothing in memory, takes over
    const { createExecution } = await import('../src/orders/index.ts');
    const fresh = createExecution({ derivatives: derivs, live: w.svc, gmx: { status: async () => ({ positions: [] }) } as never });
    w.clock.advance(20_000);
    expect(await fresh.orders.reconcile()).toMatchObject({ unknown: 1, resolved: 0 });
    expect(await orderRow(id)).toMatchObject({ state: 'UNKNOWN' });
    w.clock.advance(20_000);                                                                              // past the expiry of the signed request (30 s) + the venue's grace (5 s)
    expect(await fresh.orders.reconcile()).toMatchObject({ unknown: 1, resolved: 1 });
    expect(await orderRow(id)).toMatchObject({ state: 'FAILED', reason: 'NEVER_PLACED' });
    expect((await states(id)).at(-1)).toBe('FAILED:reconciled_absent');
    expect(w.t.exchangeCalls('order')).toBe(calls + 1);                                                    // one attempt, no blind retry
    expect((await call('GET', `${T}/orders/${id}`, { key: k.secret })).json.order).toMatchObject({ status: 'FAILED', reasonCode: 'NEVER_PLACED', filled: '0' });
  });

  it('paper and live never share a context', async () => {
    w.next();
    const paper = await call('POST', '/api/v1/derivatives/accounts', { body: { venue: 'hyperliquid', label: 'Paper', collateral: '10000' } });
    expect(paper.status, JSON.stringify(paper.json)).toBe(200);
    const po = await call('POST', `${T}/orders`, { headers: idem(), body: { mode: 'paper', accountId: paper.json.id, instrument: BTC, side: 'buy', type: 'market', size: '0.05' } });
    expect(po.json.order?.status, JSON.stringify(po.json)).toBe('FILLED');
    const lv = await call('POST', `${T}/orders`, { key: k.secret, headers: idem(), body: order(testnet) });
    expect(lv.json.order?.status, JSON.stringify(lv.json)).toBe('FILLED');
    const ctx = async (id: string) => (await sql`select context, derived from risk_decisions where order_id = ${id} and not preview`)[0];
    const pc = await ctx(po.json.order.id), lc = await ctx(lv.json.order.id);
    expect([pc.context.book, lc.context.book]).toEqual(['paper', 'live-testnet']);
    const ex = app.execution.risk, px = await ex.exposure('paper'), lx = await ex.exposure('live-testnet'), mx = await ex.exposure('live-mainnet');
    expect(px.positions.map((p: any) => [p.accountId, p.size])).toEqual([[paper.json.id, '0.05']]);
    expect(lx.positions.every((p: any) => p.accountId === testnet)).toBe(true);
    expect(lx.positions.length).toBe(1);
    expect(mx.positions).toEqual([]);
    expect(lx.collateral.map((c: any) => c.accountId)).toEqual([testnet]);
    expect(px.collateral.map((c: any) => c.accountId)).toEqual([paper.json.id]);
    // the paper position (3 500 USD) is far above the live gross-exposure limit (1 500): the live order above was judged without it
    expect(Number(pc.derived.positionAfter)).toBe(0.05);
    expect((await sql`select checks from risk_decisions where order_id = ${lv.json.order.id} and not preview`)[0].checks.find((c: any) => c.id === 'gross_exposure')).toMatchObject({ ok: true });
  });

  it('revocation by the owner reaches the signer: no new exposure is signed, a reduce-only exit still is', async () => {
    w.next();
    const signs = w.orderSigns();
    const rv = await call('POST', `/api/v1/mandates/${k.mandateId}/revoke`, { body: {} });
    expect(rv.status, JSON.stringify(rv.json)).toBe(200);
    expect(rv.json).toMatchObject({ signerRevoked: true, mandate: { state: 'revoked', phase: 'wind_down' } });
    expect((w.signer.status() as any).venueMandates.find((m: any) => m.mandate.mandateId === k.mandateId).phase).toBe('wind_down');
    const open = await call('POST', `${T}/orders`, { key: k.secret, headers: idem(), body: order(testnet) });
    expect([open.status, open.json.error]).toEqual([403, 'mandate_denied']);
    expect(open.json.data.reasons).toEqual(expect.arrayContaining(['MANDATE_REVOKED', 'WIND_DOWN_REDUCING_ONLY']));
    expect(w.orderSigns()).toBe(signs);
    const close = await call('POST', `${T}/positions/${encodeURIComponent(`live:hyperliquid:${testnet}:${BTC}`)}/close`, { key: k.secret, headers: idem(), body: {} });
    expect([close.status, close.json.order?.status], JSON.stringify(close.json)).toEqual([200, 'FILLED']);
    expect(w.orderSigns()).toBe(signs + 1);
    expect(w.mandateSigns.at(-1).context.order).toMatchObject({ reduceOnly: true, side: 'sell' });
  });
});

describe('mainnet: the existing locks, off and on', () => {
  it('each lock that is off refuses the key\'s order with its own code (visible in the preview); with all of them on the signed request reaches the venue', async () => {
    w.next();
    w.flags.mainnet = true; w.flags.mandateMainnet = true;
    mainnet = await w.authorise('mainnet');
    w.m.user(w.ACCOUNT).leverage.set('BTC', { type: 'cross', value: 3 });
    const k = await liveKey(mainnet);
    const before = { signs: w.orderSigns(), calls: w.m.exchangeCalls('order') };
    const attempt = async () => { const o = await call('POST', `${T}/orders`, { key: k.secret, headers: idem(), body: order(mainnet) }); return o; };
    const lockOf = async () => (await call('POST', `${T}/orders/preview`, { key: k.secret, body: order(mainnet) })).json.refusals.filter((r: any) => r.stage === 'lock').map((r: any) => r.code);

    w.flags.mainnet = false;                                                                              // SPW_DERIV_LIVE_MAINNET off
    let o = await attempt();
    expect([o.status, o.json.error]).toEqual([403, 'mainnet_disabled']);
    expect(o.json.data.order).toMatchObject({ status: 'REJECTED', reasonCode: 'VENUE_NOT_ALLOWED', rejectCode: 'mainnet_disabled' });
    expect(await lockOf()).toContain('mainnet_disabled');
    w.flags.mainnet = true; w.flags.mandateMainnet = false;                                               // SPW_DERIV_MANDATE_MAINNET off
    o = await attempt();
    expect([o.status, o.json.error]).toEqual([403, 'mandate_mainnet_disabled']);
    expect(o.json.data.order).toMatchObject({ status: 'REJECTED', rejectCode: 'mandate_mainnet_disabled' });
    expect(await lockOf()).toContain('mandate_mainnet_disabled');
    w.flags.mandateMainnet = true; delete process.env.SPW_TRADING_API_EXECUTION;                          // SPW_TRADING_API_EXECUTION off
    o = await attempt();
    expect([o.status, o.json.error]).toEqual([403, 'execution_disabled']);
    expect(await lockOf()).toEqual(['execution_disabled']);
    expect([w.orderSigns() - before.signs, w.m.exchangeCalls('order') - before.calls]).toEqual([0, 0]);  // none of the three reached the signer or the venue
    // a live mandate cannot be created behind a closed lock either
    w.flags.mandateMainnet = false;
    expect((await call('POST', '/api/v1/mandates', { body: { ...MANDATE, principal: { kind: 'api_key', id: k.id }, accountIds: [mainnet] } })).json.error).toBe('mandate_mainnet_disabled');
    w.flags.mandateMainnet = true; process.env.SPW_TRADING_API_EXECUTION = 'on';

    o = await attempt();
    expect(o.status, JSON.stringify(o.json)).toBe(200);
    expect(o.json.order).toMatchObject({ status: 'FILLED', network: 'mainnet', filled: '0.005' });
    expect([w.orderSigns() - before.signs, w.m.exchangeCalls('order') - before.calls]).toEqual([1, 1]);
    expect(w.mandateSigns.at(-1)).toMatchObject({ mandateId: k.mandateId, context: { order: { network: 'mainnet', clientId: o.json.order.id } } });
    // with the locks closed again the way out stays open: the key's reduce-only close is signed and sent
    w.next();
    w.flags.mainnet = false; w.flags.mandateMainnet = false; delete process.env.SPW_TRADING_API_EXECUTION;
    const close = await call('POST', `${T}/positions/${encodeURIComponent(`live:hyperliquid:${mainnet}:${BTC}`)}/close`, { key: k.secret, headers: idem(), body: {} });
    expect([close.status, close.json.order?.status], JSON.stringify(close.json)).toEqual([200, 'FILLED']);
    expect((await call('POST', `${T}/orders`, { key: k.secret, headers: idem(), body: order(mainnet) })).json.error).toBe('execution_disabled');
    void closeAll;
  });
});
