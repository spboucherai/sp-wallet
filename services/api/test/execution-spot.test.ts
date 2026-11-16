// V11 exec2 — spot orders in the unified order table. Real server, real signer process (public test mnemonic), own database.
// NO network: the swap proposal flow behind an owner's order is either a fake `SpotPort` that writes the proposal row the real
// route would write, or the real in-process port with the signer halted (the route then refuses before any provider or chain
// is asked). Nothing is signed for a chain and nothing is sent anywhere.
//
//   - who may place a spot order here: the owner, live, as an exact-input swap; everything else is refused with its own code;
//   - owner: order → swap proposal → AWAITING_APPROVAL (approval path + WebAuthn request) → the proposal's own states, projected;
//   - cancellable while it waits; idempotent; kill switch / read-only before the proposal exists;
//   - the default port calls the swap route in process with the owner's own session;
//   - swaps prepared in the Swap screen and spot agents' swaps are the same table: GET /orders has one source;
//   - the kill switch stops a spot agent's BUY at the row itself (paper and live), and lets a sale into cash through.
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
import { Clock, fixtureVenues, setMarket, useDatabase } from './derivatives-helpers.ts';

const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'k'.repeat(48), T = '/api/v1/trading', DEV = '/api/v1/developer';
const owner = new TestPasskey(RP, ORIGIN);
const ALL = ['wallet:read', 'markets:read', 'orders:read', 'orders:prepare', 'orders:execute', 'orders:cancel', 'positions:read', 'positions:manage', 'agents:read', 'agents:manage'];
let app: any, sql: any, cookie = '', signerSrv: Server, signer: Signer, spot: typeof import('../src/orders/spot.ts'), ipSeq = 0, ME = '', USDC = '';
const port = { proposals: 0, withdrawals: 0, sessions: [] as any[], requests: [] as any[] };

interface Res { status: number; json: any }
async function call(method: string, path: string, o: { key?: string | null; cookie?: string | null; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...o.headers };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  const c = o.cookie === undefined ? (o.key ? null : cookie) : o.cookie;
  if (c) headers.cookie = c;
  if (c && method !== 'GET') { headers.origin = ORIGIN; headers['x-spw-csrf'] = '1'; }
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const ip = path.startsWith(DEV) ? `10.203.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}` : undefined;
  const r = await app.inject({ method, url: path, headers, payload: o.body === undefined ? undefined : JSON.stringify(o.body), ...(ip ? { remoteAddress: ip } : {}) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() };
}
const idem = () => ({ 'idempotency-key': `spot-${randomUUID()}` });
const assertion = (options: { challenge: string }) => owner.assert(Buffer.from(options.challenge, 'base64url'));
const SELL = { mode: 'live', instrument: 'spot:ETH', side: 'sell', type: 'market', size: '0.5' };
const cmd = (key: string | null, text: string, o: Record<string, unknown> = {}, headers = idem()) => call('POST', `${T}/commands`, { ...(key ? { key } : {}), headers, body: { text, mode: 'live', ...o } });
const orderRow = async (id: string) => (await sql`select * from orders where id = ${id}`)[0];
const events = async (id: string) => (await sql`select event, to_state from order_events where order_id = ${id} order by seq`).map((e: any) => `${e.to_state}:${e.event}`);
const proposalOf = async (orderId: string) => (await sql`select * from proposals where id = ${(await orderRow(orderId)).detail.proposalId}`)[0];
const setProposal = async (id: string, patch: Record<string, unknown>) => { await sql`update proposals set ${sql(patch)}, updated_at = now() where id = ${id}`; await app.execution.orders.drain(); };
const releaseSwitch = async (kind: 'kill-switch' | 'read-only') => { const p = await call('POST', `/api/v1/risk/${kind}/release/prepare`); return call('POST', `/api/v1/risk/${kind}/release`, { body: p.json.needed ? { assertion: assertion(p.json.options) } : {} }); };
/** the row POST /api/v1/swap/proposals writes for a prepared KyberSwap swap (swap-exec.ts), with made-up firm figures */
async function insertProposal(req: { network: string; fromAsset: string; toAsset: string; amount: string }, key: string): Promise<{ id: string; hash: string; expiresAt: Date }> {
  const { getAsset, parseUnits } = await import('@spw/core');
  const src = getAsset(req.network, req.fromAsset), dst = getAsset(req.network, req.toAsset), id = randomUUID(), hash = createHash('sha256').update(id).digest('hex'), expiresAt = new Date(Date.now() + 75_000);
  const expected = src.symbol === 'ETH' ? parseUnits(String(Number(req.amount) * 3000), dst.decimals) : parseUnits(String(Number(req.amount) / 3000), dst.decimals);
  await sql`insert into proposals (id, idempotency_key, state, kind, network, asset, symbol, decimals, amount, from_addr, to_addr, note, intent_hash, swap, expires_at)
    values (${id}, ${key}, 'pending_approval', 'swap', ${req.network}, ${src.id}, ${src.symbol}, ${src.decimals}, ${parseUnits(req.amount, src.decimals).toString()}, ${ME}, ${ME}, ${`swap → ${dst.symbol}`}, ${hash},
      ${sql.json({ provider: 'kyberswap', toAsset: dst.id, toSymbol: dst.symbol, toDecimals: dst.decimals, expectedOut: expected.toString(), minOut: ((expected * 995n) / 1000n).toString(), slippageBps: 50, needsApproval: false, simulated: true })}, ${expiresAt})`;
  return { id, hash, expiresAt };
}
const fakePort = () => ({
  async propose(session: any, req: any, key: string) {
    port.proposals += 1; port.sessions.push(session); port.requests.push({ ...req, key });
    const p = await insertProposal(req, key);
    return { id: p.id, state: 'pending_approval', intentHash: p.hash, expiresAt: p.expiresAt.getTime(), options: { challenge: Buffer.from(p.hash, 'hex').toString('base64url'), rpId: RP } };
  },
  async withdraw(session: any, id: string) { port.withdrawals += 1; port.sessions.push(session); await sql`update proposals set state = 'rejected', error_code = 'rejected_by_owner', updated_at = now() where id = ${id} and state = 'pending_approval'`; },
});
async function newKey(): Promise<{ id: string; secret: string }> {
  const p = await call('POST', `${DEV}/keys/prepare`, { body: { name: 'spot key', scopes: ALL, expiresInDays: 30, rateLimitPerMin: 600 } });
  const c = await call('POST', `${DEV}/keys`, { body: { intentId: p.json.intentId, assertion: assertion(p.json.options) } });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  return { id: c.json.key.id, secret: c.json.secret };
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spw-exec-spot-'));
  const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  ME = keys.addresses.evm;
  signer = new Signer(keys, new Store(join(dir, 'state.json'), join(dir, 'policy.json')), { rpId: RP, origin: ORIGIN });
  signerSrv = createSignerServer(signer, SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  await useDatabase('execution_spot');
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
  spot = await import('../src/orders/spot.ts');
  USDC = spot.assetBySymbol('base', 'USDC')!.id;
  const mod = await import('../src/derivatives/index.ts');
  const clock = new Clock(), v = fixtureVenues(clock);
  setMarket(v, 50_000);
  app = await (await import('../src/server.ts')).buildServer({ derivatives: mod.createDerivatives({ registry: mod.createRegistry(v.adapters, clock.now), now: clock.now }), gmx: { status: async () => ({ network: 'arbitrum', account: null, positionsError: null, positions: [] }) } as never });
  await app.ready();
  app.execution.orders.deps.spot = fakePort();
  app.execution.risk.deps.prices = async () => ({ ETH: { usd: 3000, priceAt: new Date().toISOString() } });
});
afterAll(async () => { app?.server.closeAllConnections?.(); await app?.close(); signerSrv?.close(); await sql?.end(); });

describe('who may place a spot order through the trading API', () => {
  it('an API key is refused 403 spot_execution_requires_agent_vault (order, preview, command); the owner: live only, market only, an exact-input sale; what the defaults do not settle is asked', async () => {
    const k = await newKey();
    for (const r of [await call('POST', `${T}/orders/preview`, { key: k.secret, body: SELL }), await cmd(k.secret, 'BUY ETH 100 USDC'), await cmd(k.secret, 'SELL ETH 0.5 FOR USDC', { dryRun: true })])
      expect([r.status, r.json.error], JSON.stringify(r.json)).toEqual([403, 'spot_execution_requires_agent_vault']);
    // POST /orders: a key without a mandate is stopped by the route's own guard; one that has a mandate, by the order service — the same refusal for an agent
    expect((await call('POST', `${T}/orders`, { key: k.secret, headers: idem(), body: SELL })).json.error).toBe('mandate_required');
    for (const kind of ['api_key', 'agent'] as const)
      await expect(app.execution.orders.submit({ principal: { kind, id: kind === 'agent' ? randomUUID() : k.id }, mandateId: randomUUID() }, { ...SELL, reduceOnly: false, tif: 'ioc' }, `k-${randomUUID()}`)).rejects.toMatchObject({ code: 'spot_execution_requires_agent_vault', status: 403 });
    // the owner, nothing settled yet: the network and the quote asset are asked, never assumed
    const amb = await call('POST', `${T}/orders`, { headers: idem(), body: SELL });
    expect([amb.status, amb.json.error]).toEqual([409, 'ambiguous_order']);
    expect(amb.json.data.questions.map((q: any) => q.field)).toEqual(['network', 'quote']);
    expect((await cmd(null, 'SELL ETH 0.5')).json.error).toBe('ambiguous_command');
    expect((await call('PUT', `${DEV}/command-defaults`, { body: { defaults: { spotNetwork: 'base', spotVenueByNetwork: { base: 'kyberswap' }, spotQuote: 'USDC', usdQuotes: ['USDC'], maxFeeBps: 30, maxSlippageBps: 50, orderTtlMs: 60_000 } } })).status).toBe(200);
    for (const [body, code, status] of [[{ ...SELL, mode: 'paper' }, 'spot_paper_not_available', 422], [{ ...SELL, side: 'buy' }, 'spot_buy_needs_quote_amount', 422], [{ ...SELL, type: 'limit', price: '3000' }, 'spot_market_only', 422],
      [{ ...SELL, instrument: 'spot:NOPE' }, 'unsupported_asset', 422]] as const) {
      const r = await call('POST', `${T}/orders`, { headers: idem(), body });
      expect([r.status, r.json.error], JSON.stringify(body)).toEqual([status, code]);
    }
    expect((await cmd(null, 'BUY ETH 100 USDC', { mode: 'paper' })).json.error).toBe('spot_paper_not_available');
    expect((await sql`select count(*)::int as n from orders`)[0].n).toBe(0);                    // none of these created anything
    expect(port.proposals).toBe(0);
  });
});

describe('the owner: a spot order is a swap proposal of the existing flow', () => {
  it('SELL through POST /orders: AWAITING_APPROVAL with the approval path and the passkey request; the session is handed over unchanged; a replay prepares nothing twice; cancel withdraws the proposal', async () => {
    const pv = await call('POST', `${T}/orders/preview`, { body: SELL });
    expect(pv.json).toMatchObject({ wouldExecute: true, refusals: [], approval: { required: true, by: 'owner_passkey' }, engine: { name: 'spot', provider: 'kyberswap' }, risk: { decision: 'allow', reducing: true }, order: { venue: 'kyberswap', network: 'base', instrument: 'kyberswap:ETH-USDC', marketKind: 'spot', side: 'sell', size: '0.5' } });
    const h = idem(), before = port.proposals;
    const o = await call('POST', `${T}/orders`, { headers: h, body: SELL });
    expect(o.status, JSON.stringify(o.json)).toBe(200);
    const id = o.json.order.id as string, p = await proposalOf(id);
    expect(o.json.order).toMatchObject({ status: 'AWAITING_APPROVAL', mode: 'live', venue: 'spot', network: 'base', instrument: 'spot:ETH-USDC', side: 'sell', type: 'market', size: '0.5', engine: 'spot', engineRef: `swap:${p.id}`, origin: 'trading_api',
      principal: { kind: 'owner' }, spot: { provider: 'kyberswap', fromSymbol: 'ETH', toSymbol: 'USDC', amountIn: '0.5', proposalId: p.id } });
    expect(o.json.order.execution.steps.map((s: any) => [s.kind, s.state])).toEqual([['swap', 'awaiting_approval']]);
    expect(o.json.approval).toMatchObject({ by: 'owner_passkey', engine: 'spot', proposalId: p.id, hash: p.intent_hash, approve: { method: 'POST', path: `/api/v1/transfers/proposals/${p.id}/approve` } });
    expect(o.json.approval.options.challenge).toBe(Buffer.from(p.intent_hash, 'hex').toString('base64url'));       // the passkey request of the swap flow itself
    expect(await events(id)).toEqual(['VALIDATED:validated', 'AWAITING_APPROVAL:approval_requested']);
    // what the flow received: the registry assets of the two legs, the exact input, and the owner's own session
    expect(port.requests.at(-1)).toMatchObject({ network: 'base', fromAsset: 'native', toAsset: USDC, amount: '0.5', slippageBps: 50, key: spot.proposalKeyOf(id) });
    expect(port.requests.at(-1).key).toMatch(/^[A-Za-z0-9-]{16,64}$/);
    expect(port.sessions.at(-1)).toEqual({ cookie, origin: ORIGIN, csrf: '1' });
    expect(p.idempotency_key).toBe(spot.proposalKeyOf(id));
    // replay: the same order, no second proposal; another body under the same key is a conflict
    const again = await call('POST', `${T}/orders`, { headers: h, body: SELL });
    expect([again.status, again.json.order.id, port.proposals - before]).toEqual([200, id, 1]);
    expect((await call('POST', `${T}/orders`, { headers: h, body: { ...SELL, size: '0.6' } })).json.error).toBe('idempotency_conflict');
    expect((await sql`select count(*)::int as n from orders where engine = 'spot'`)[0].n).toBe(1);
    // listed with every other order; cancellable while it waits
    expect((await call('GET', `${T}/orders?open=true`)).json.orders.map((x: any) => x.id)).toContain(id);
    const c = await call('DELETE', `${T}/orders/${id}`, { headers: idem() });
    expect([c.status, c.json.order.status, c.json.order.reasonCode], JSON.stringify(c.json)).toEqual([200, 'CANCELLED', 'WITHDRAWN_BEFORE_APPROVAL']);
    expect((await proposalOf(id)).state).toBe('rejected');
    expect(port.withdrawals).toBe(1);
    expect((await call('DELETE', `${T}/orders/${id}`, { headers: idem() })).json).toMatchObject({ changed: false });
  });

  it('BUY and SELL as commands; the proposal\'s own states are projected, with the execution steps: signed → relayed → final, with what was received; once approved a swap cannot be withdrawn', async () => {
    const dry = await cmd(null, 'BUY ETH 100 USDC', { dryRun: true });
    expect(dry.json).toMatchObject({ kind: 'order', executed: false, order: { venue: 'kyberswap', network: 'base', instrument: 'kyberswap:ETH-USDC', side: 'buy', notional: '100', size: null }, preview: { wouldExecute: true } });
    const n = port.proposals;
    const b = await cmd(null, 'BUY ETH 100 USDC');
    expect(b.status, JSON.stringify(b.json)).toBe(200);
    const id = b.json.order.id as string, p = await proposalOf(id);
    expect(b.json).toMatchObject({ kind: 'order', executed: true, order: { status: 'AWAITING_APPROVAL', side: 'buy', instrument: 'spot:ETH-USDC', size: null, notionalUsd: '100', origin: 'command' }, approval: { by: 'owner_passkey', proposalId: p.id } });
    expect([port.proposals - n, port.requests.at(-1).fromAsset, port.requests.at(-1).toAsset, port.requests.at(-1).amount]).toEqual([1, USDC, 'native', '100']);       // a buy spends the quote: exact input
    // the owner approves in the app (the existing route; here its effects on the proposal row, step by step)
    await setProposal(p.id, { state: 'approved' });
    expect((await orderRow(id)).state).toBe('APPROVED');
    await setProposal(p.id, { state: 'signed', raw: '0x02', txid: `0x${'ab'.repeat(32)}` });
    expect((await call('GET', `${T}/orders/${id}`)).json.order).toMatchObject({ status: 'SUBMITTING', engineStatus: 'signed' });
    const late = await call('DELETE', `${T}/orders/${id}`, { headers: idem() });
    expect([late.status, late.json.error]).toEqual([409, 'bad_state']);
    await setProposal(p.id, { state: 'broadcast', broadcast_at: new Date() });
    expect((await call('GET', `${T}/orders/${id}`)).json.order).toMatchObject({ status: 'SUBMITTED', venueOrderId: `0x${'ab'.repeat(32)}` });
    await setProposal(p.id, { state: 'confirming' });
    expect((await orderRow(id)).state).toBe('SUBMITTED');
    await setProposal(p.id, { state: 'finalized', finalized_at: new Date(), out_amount: '33000000000000000' });           // 0.033 ETH received
    const done = (await call('GET', `${T}/orders/${id}`)).json;
    expect(done.order).toMatchObject({ status: 'FILLED', final: true, filled: '0.033', reasonCode: 'VENUE_FILLED', engineStatus: 'finalized' });
    expect(Number(done.order.avgFillPrice)).toBeCloseTo(100 / 0.033, 6);                                               // USDC per ETH
    expect(done.order.execution.steps.map((s: any) => [s.kind, s.state])).toEqual([['swap', 'confirmed']]);
    expect(done.history.map((e: any) => `${e.to}:${e.event}`)).toEqual(['VALIDATED:validated', 'AWAITING_APPROVAL:approval_requested', 'APPROVED:approved', 'SUBMITTING:submit_started', 'SUBMITTED:venue_accepted', 'FILLED:reconciled_found']);
    expect((await orderRow(id)).projection_error).toBeNull();
    // SELL as a command: an absolute quantity, and a percentage of the wallet's balance is asked from the balances (none here → refused, nothing created)
    const s = await cmd(null, 'SELL ETH 0.25 FOR USDC');
    expect(s.json.order).toMatchObject({ status: 'AWAITING_APPROVAL', side: 'sell', size: '0.25' });
    await setProposal((await proposalOf(s.json.order.id)).id, { state: 'expired', error_code: 'approval_expired' });
    expect(await orderRow(s.json.order.id)).toMatchObject({ state: 'CANCELLED', reason: 'APPROVAL_EXPIRED' });
  });

  it('the kill switch refuses a BUY (new risk) before any proposal exists and lets a sale into the cash leg through; read-only mode refuses both', async () => {
    expect((await call('POST', '/api/v1/risk/kill-switch', { body: { reason: 'spot test' } })).status).toBe(200);
    const n = port.proposals;
    const buy = await cmd(null, 'BUY ETH 50 USDC');
    expect([buy.status, buy.json.error]).toEqual([423, 'kill_switch_active']);
    expect(buy.json.data.order).toMatchObject({ status: 'REJECTED', reasonCode: 'KILL_SWITCH_ACTIVE', engineRef: null });
    expect((await cmd(null, 'BUY ETH 50 USDC', { dryRun: true })).json.preview).toMatchObject({ wouldExecute: false, refusals: [{ stage: 'risk', code: 'kill_switch_active' }] });
    expect(port.proposals).toBe(n);                                                                   // the swap flow was never asked
    const sell = await call('POST', `${T}/orders`, { headers: idem(), body: { ...SELL, size: '0.1' } });
    expect([sell.status, sell.json.order?.status], JSON.stringify(sell.json)).toEqual([200, 'AWAITING_APPROVAL']);
    expect(port.proposals).toBe(n + 1);
    // a sale into something that is not a cash leg is new risk
    const { SpotOrders } = await import('../src/orders/spot-orders.ts');
    expect([SpotOrders.addsRisk({ side: 'sell', base: 'ETH', quote: 'USDC' }), SpotOrders.addsRisk({ side: 'sell', base: 'ETH', quote: 'WBTC' }), SpotOrders.addsRisk({ side: 'buy', base: 'ETH', quote: 'USDC' }), SpotOrders.addsRisk({ side: 'sell', base: 'USDC', quote: 'USDT' })]).toEqual([false, true, true, true]);
    expect((await releaseSwitch('kill-switch')).status).toBe(200);
    expect((await call('POST', '/api/v1/risk/read-only', { body: { reason: 'spot test' } })).status).toBe(200);
    const ro = await call('POST', `${T}/orders`, { headers: idem(), body: { ...SELL, size: '0.1' } });
    expect([ro.status, ro.json.error, ro.json.data.order.reasonCode]).toEqual([423, 'read_only_mode', 'READ_ONLY_MODE']);
    expect(port.proposals).toBe(n + 1);
    expect((await releaseSwitch('read-only')).status).toBe(200);
  });

  it('the default port is the swap route of this server, called in process with the owner\'s session: its refusal is the order\'s refusal; without a session nothing is asked', async () => {
    app.execution.orders.deps.spot = spot.injectSpotPort(app);
    signer.halt();                                                    // the swap route refuses on the halt BEFORE any provider or chain is asked: no network here
    try {
      const r = await call('POST', `${T}/orders`, { headers: idem(), body: { ...SELL, size: '0.2' } });
      expect([r.status, r.json.error], JSON.stringify(r.json)).toEqual([423, 'halted']);                // the route's own answer (a missing cookie would have been 401, a missing CSRF header 403)
      expect(r.json.data.order).toMatchObject({ status: 'REJECTED', rejectCode: 'halted', engineRef: null });
      expect((await sql`select count(*)::int as n from proposals where idempotency_key = ${spot.proposalKeyOf(r.json.data.order.orderId)}`)[0].n).toBe(0);
      // the port itself: a session that is not the owner's is refused by the server's own gate
      await expect(spot.injectSpotPort(app).propose({ cookie: 'spw_session=nope', origin: ORIGIN, csrf: '1' }, { network: 'base', fromAsset: 'native', toAsset: USDC, amount: '0.1', slippageBps: 50 }, 'ord-0123456789abcdef0123')).rejects.toMatchObject({ status: 401 });
      await expect(spot.injectSpotPort(app).propose({ cookie: '', origin: ORIGIN, csrf: '1' }, { network: 'base', fromAsset: 'native', toAsset: USDC, amount: '0.1', slippageBps: 50 }, 'ord-0123456789abcdef0123')).rejects.toMatchObject({ code: 'owner_session_required' });
      // a call that carries no session (inside the process) never reaches the flow
      const { OWNER_CALLER } = await import('../src/orders/index.ts');
      await expect(app.execution.orders.submit(OWNER_CALLER, { ...SELL, size: '0.3', reduceOnly: false, tif: 'ioc' }, `nosession-${randomUUID()}`)).rejects.toMatchObject({ code: 'owner_session_required', status: 403 });
    } finally { app.execution.orders.deps.spot = fakePort(); }
  });
});

describe('one order table: swaps of the Swap screen and of the spot agents', () => {
  it('a swap prepared in the Swap screen is adopted with its states; a failure before the transaction left and one after are told apart', async () => {
    const a = await insertProposal({ network: 'base', fromAsset: USDC, toAsset: 'native', amount: '30' }, `screen-${randomUUID()}`);
    const listed = (await call('GET', `${T}/orders?venue=spot`)).json.orders.find((o: any) => o.id === `swap:${a.id}`);
    expect(listed).toMatchObject({ status: 'AWAITING_APPROVAL', origin: 'legacy', engine: 'spot', side: 'buy', instrument: 'spot:ETH-USDC', principal: { kind: 'owner' }, spot: { proposalId: a.id, fromSymbol: 'USDC', toSymbol: 'ETH', amountIn: '30' } });
    await setProposal(a.id, { state: 'failed', error: 'the swap would revert now', error_code: 'swap_would_revert' });
    expect((await call('GET', `${T}/orders/swap:${a.id}`)).json.order).toMatchObject({ status: 'FAILED', reasonCode: 'NOT_SENT' });
    const b = await insertProposal({ network: 'base', fromAsset: 'native', toAsset: USDC, amount: '0.01' }, `screen-${randomUUID()}`);
    await app.execution.orders.drain();
    await setProposal(b.id, { state: 'signed', raw: '0x02', txid: `0x${'cd'.repeat(32)}` });
    await setProposal(b.id, { state: 'broadcast', broadcast_at: new Date() });
    await setProposal(b.id, { state: 'failed', error: 'the swap reverted on-chain', error_code: 'reverted' });
    const failed = (await call('GET', `${T}/orders/swap:${b.id}`)).json;
    expect(failed.order).toMatchObject({ status: 'REJECTED', reasonCode: 'VENUE_REJECTED_AFTER_ACK' });                         // past the venue step no local event closes an order
    expect(failed.order.execution.steps.at(-1)).toMatchObject({ kind: 'swap', state: 'failed', code: 'reverted' });
    expect((await sql`select count(*)::int as n from orders where projection_error is not null`)[0].n).toBe(0);
    const { mapSwapProposal, mapAgentOrder } = spot;
    const s = (state: string, error_code: string | null = null, sent = false) => { const u = mapSwapProposal({ state: state as never, error: null, error_code, broadcast_at: sent ? new Date() : null }); return `${u.state}/${u.reason}`; };
    expect([s('pending_approval'), s('rejected'), s('expired'), s('signed'), s('confirming'), s('reorged'), s('finalized'), s('not_broadcast'), s('replaced'), s('failed', 'signer_refused'), s('failed', 'signer_hash_mismatch'), s('failed', 'swap_approval_reverted'),
      s('failed', 'swap_late'), s('failed', 'x', true), s('???')]).toEqual(['AWAITING_APPROVAL/APPROVAL_REQUESTED', 'CANCELLED/WITHDRAWN_BEFORE_APPROVAL', 'CANCELLED/APPROVAL_EXPIRED', 'SUBMITTING/SUBMIT_STARTED', 'SUBMITTED/VENUE_ACCEPTED', 'SUBMITTED/VENUE_ACCEPTED',
      'FILLED/VENUE_FILLED', 'FAILED/NOT_SENT', 'FAILED/TX_REPLACED', 'REJECTED/SIGNER_REFUSED', 'FAILED/SIGNER_HASH_MISMATCH', 'FAILED/TX_REVERTED', 'FAILED/NOT_SENT', 'FAILED/TX_REVERTED', 'FAILED/INTERNAL_ERROR']);
    const g = (state: string, reason: string | null = null) => { const u = mapAgentOrder(state, reason, 'LIVE'); return `${u.state}/${u.reason}`; };
    expect([g('prepared'), g('signed'), g('broadcast'), g('filled'), g('failed', 'refused by the signer: mandate'), g('failed', 'never signed'), g('failed', 'the swap reverted on-chain; only the network fee was spent'),
      g('failed', 'broadcast is disabled on this server; nothing was sent'), g('failed', 'not included before its deadline')]).toEqual(['APPROVED/APPROVED_BY_MANDATE', 'SUBMITTING/SUBMIT_STARTED', 'SUBMITTED/VENUE_ACCEPTED', 'FILLED/VENUE_FILLED',
      'REJECTED/SIGNER_REFUSED', 'FAILED/SIGNER_INTERRUPTED', 'FAILED/TX_REVERTED', 'FAILED/NOT_SENT', 'FAILED/INTERNAL_ERROR']);
  });

  it('a spot agent\'s swaps, paper and live, are unified orders of the principal agent:<id>; GET /orders has one source and agent:<id> still names the order; the kill switch stops a BUY at the row and lets a sale into cash through', async () => {
    const agentId = randomUUID();
    await sql`insert into agents (id, name, universe, risk, vault_index, vault_address, state, mode, network) values (${agentId}, 'Spot agent', ${sql.json(['ETH'])}, ${sql.json({})}, 9301, '0x0', 'PAPER_TRADING', 'PAPER', 'base')`;
    const ins = (o: { mode: 'PAPER' | 'LIVE'; from: 'USDC' | 'ETH'; state: string; amount: string; received?: string | null }) => { const id = randomUUID(), buy = o.from === 'USDC';
      return sql`insert into agent_orders (id, agent_id, mode, from_asset, to_asset, from_symbol, to_symbol, amount_in, expected_out, received, state, reason, aux)
        values (${id}, ${agentId}, ${o.mode}, ${buy ? USDC : 'native'}, ${buy ? 'native' : USDC}, ${o.from}, ${buy ? 'ETH' : 'USDC'}, ${o.amount}, ${buy ? '10000000000000000' : '30000000'}, ${o.received ?? null}, ${o.state}, 'rebalance', ${sql.json({ usd: 30 })})`.then(() => id); };
    // paper: filled at once by the agents engine
    const paper = await ins({ mode: 'PAPER', from: 'USDC', state: 'filled', amount: '30000000', received: '10000000000000000' });
    const list = (await call('GET', `${T}/orders?mode=paper`)).json.orders;
    expect(list.filter((o: any) => o.id === `agent:${paper}`)).toHaveLength(1);                                         // once: one source
    expect(list.find((o: any) => o.id === `agent:${paper}`)).toMatchObject({ status: 'FILLED', mode: 'paper', venue: 'spot', network: 'base', engine: 'spot', side: 'buy', instrument: 'spot:ETH-USDC', filled: '0.01', principal: { kind: 'agent', id: agentId },
      notionalUsd: '30', spot: { agentId, fromSymbol: 'USDC', toSymbol: 'ETH', amountIn: '30' } });
    expect((await call('GET', `${T}/orders/agent:${paper}`)).json.order).toMatchObject({ id: `agent:${paper}`, status: 'FILLED', avgFillPrice: '3000' });
    expect((await call('GET', `${T}/orders/agent:${paper}`)).json.history.map((e: any) => e.to)).toEqual(['VALIDATED', 'APPROVED', 'SUBMITTING', 'FILLED']);
    // live: prepared (before the signer) → signed → relayed → filled
    const live = await ins({ mode: 'LIVE', from: 'ETH', state: 'prepared', amount: '10000000000000000' });
    const st = async () => (await call('GET', `${T}/orders/agent:${live}`)).json.order;
    expect(await st()).toMatchObject({ status: 'APPROVED', mode: 'live', side: 'sell', size: '0.01', reasonCode: 'APPROVED_BY_MANDATE' });
    await sql`update agent_orders set state = 'signed', txid = ${`0x${'ef'.repeat(32)}`}, updated_at = now() where id = ${live}`;
    expect((await st()).status).toBe('SUBMITTING');
    await sql`update agent_orders set state = 'broadcast', updated_at = now() where id = ${live}`;
    expect(await st()).toMatchObject({ status: 'SUBMITTED', venueOrderId: `0x${'ef'.repeat(32)}` });
    await sql`update agent_orders set state = 'filled', received = '29900000', updated_at = now() where id = ${live}`;
    expect(await st()).toMatchObject({ status: 'FILLED', filled: '0.01', avgFillPrice: '2990' });
    const refused = await ins({ mode: 'LIVE', from: 'ETH', state: 'prepared', amount: '10000000000000000' });
    await sql`update agent_orders set state = 'failed', reason = 'refused by the signer: daily volume limit reached', updated_at = now() where id = ${refused}`;
    expect((await call('GET', `${T}/orders/agent:${refused}`)).json.order).toMatchObject({ status: 'REJECTED', reasonCode: 'SIGNER_REFUSED', reason: 'refused by the signer: daily volume limit reached' });
    // a key restricted to another network does not see them; one restricted to the venue `spot` does
    const caller = (networks: string[], venues: string[]) => ({ principal: { kind: 'api_key' as const, id: 'spk_x' }, mandateId: null, restrictions: { networks, venues, instruments: [] } });
    expect((await app.execution.orders.list(caller(['arbitrum'], []), { limit: 100 })).some((o: any) => o.engine === 'spot')).toBe(false);
    expect((await app.execution.orders.list(caller([], ['spot']), { limit: 100 })).every((o: any) => o.venue === 'spot')).toBe(true);
    expect((await app.execution.orders.list(caller([], ['hyperliquid']), { limit: 100 })).some((o: any) => o.venue === 'spot')).toBe(false);
    expect((await sql`select count(*)::int as n from orders where projection_error is not null`)[0].n).toBe(0);
    expect((await sql`select count(*)::int as n from order_projection_queue`)[0].n).toBe(0);

    // the kill switch, at the row: a BUY (it spends the agent's cash leg) is refused for a paper and for a live-shaped order — before
    // anything is recorded, so before the signer is asked; a sale into cash passes; read-only mode lets nothing through
    expect((await call('POST', '/api/v1/risk/kill-switch', { body: { reason: 'agents' } })).status).toBe(200);
    const n = (await sql`select count(*)::int as n from agent_orders`)[0].n;
    await expect(ins({ mode: 'PAPER', from: 'USDC', state: 'filled', amount: '30000000', received: '1' })).rejects.toThrow(/kill_switch_active: /);
    await expect(ins({ mode: 'LIVE', from: 'USDC', state: 'prepared', amount: '30000000' })).rejects.toThrow(/kill_switch_active: /);
    expect((await sql`select count(*)::int as n from agent_orders`)[0].n).toBe(n);
    await ins({ mode: 'PAPER', from: 'ETH', state: 'filled', amount: '10000000000000000', received: '30000000' });
    await ins({ mode: 'LIVE', from: 'ETH', state: 'prepared', amount: '10000000000000000' });
    expect((await sql`select count(*)::int as n from agent_orders`)[0].n).toBe(n + 2);
    // an agent whose cash leg is another stable: its own cash leg is what counts
    await sql`update agents set cash = 'USDT' where id = ${agentId}`;
    await ins({ mode: 'PAPER', from: 'USDC', state: 'filled', amount: '30000000', received: '1' });                      // not a purchase with ITS cash
    await sql`update agents set cash = 'USDC' where id = ${agentId}`;
    expect((await releaseSwitch('kill-switch')).status).toBe(200);
    expect((await call('POST', '/api/v1/risk/read-only', { body: {} })).status).toBe(200);
    await expect(ins({ mode: 'PAPER', from: 'ETH', state: 'filled', amount: '1', received: '1' })).rejects.toThrow(/read_only_mode: /);
    await expect(ins({ mode: 'LIVE', from: 'ETH', state: 'prepared', amount: '1' })).rejects.toThrow(/read_only_mode: /);
    expect((await releaseSwitch('read-only')).status).toBe(200);
    await ins({ mode: 'PAPER', from: 'USDC', state: 'filled', amount: '30000000', received: '10000000000000000' });      // released: a BUY is recorded again
  });
});

describe('STOP ALL AGENTS', () => {
  it('stops what the agents runtime lets it stop and says what it could not; with nothing stopped it answers 501; the scope is agents:manage', async () => {
    const { agentControl, SPOT_NOT_STOPPED, SPOT_LIVE_REVOKED, SPOT_LIVE_REVOKE_FAILED } = await import('../src/orders/agent-control.ts');
    await sql`update agents set state = 'STOPPED'`;
    const mk = async (o: { kind: 'spot' | 'perp'; state: string; mandate?: string | null }) => { const id = randomUUID();
      await sql`insert into agents (id, name, universe, risk, vault_index, vault_address, state, mode, network, kind, mandate_id) values (${id}, 'A', ${sql.json(['ETH'])}, ${sql.json({})}, ${9400 + Math.floor(Math.random() * 90000)}, '0x0', ${o.state}, ${o.state === 'LIVE' ? 'LIVE' : 'PAPER'}, 'base', ${o.kind}, ${o.mandate ?? null})`; return id; };
    const perp = await mk({ kind: 'perp', state: 'PAPER_TRADING' }), perpBad = await mk({ kind: 'perp', state: 'PAPER_TRADING' }), spotPaper = await mk({ kind: 'spot', state: 'PAPER_TRADING' });
    const spotLive = await mk({ kind: 'spot', state: 'LIVE', mandate: randomUUID() }), spotLiveDown = await mk({ kind: 'spot', state: 'LIVE', mandate: randomUUID() }), idle = await mk({ kind: 'spot', state: 'STOPPED' });
    const calls: string[] = [];
    const control = agentControl({
      stopPerp: async (a) => { calls.push(`perp:${a.id}`); if (a.id === perpBad) throw new Error('venue unavailable'); await sql`update agents set state = 'STOPPED' where id = ${a.id as string}`; },
      revokeSpotMandate: async (a, reason) => { calls.push(`revoke:${a.id}:${reason}`); return a.id !== spotLiveDown; } });
    const r = await control.stopAll('test');
    expect(r.stopped).toEqual([perp]);
    expect(Object.fromEntries(r.notStopped!.map((x) => [x.id, x.reason]))).toEqual({ [perpBad]: 'the perp agent could not be stopped: venue unavailable', [spotPaper]: SPOT_NOT_STOPPED, [spotLive]: SPOT_LIVE_REVOKED, [spotLiveDown]: SPOT_LIVE_REVOKE_FAILED });
    expect(calls).toEqual(expect.arrayContaining([`perp:${perp}`, `revoke:${spotLive}:STOP ALL AGENTS: test`]));
    expect(calls.some((c) => c.includes(idle) || c.includes(spotPaper))).toBe(false);
    expect((await sql`select state from agents where id = ${spotLive}`)[0].state).toBe('LIVE');                          // never written behind the runtime's back, never reported as stopped
    // through the command: partial → 200 with both lists; nothing stopped → 501 with the reasons; dry run does nothing
    app.execution.agents = { stopAll: async () => ({ stopped: [perp], notStopped: [{ id: spotPaper, reason: SPOT_NOT_STOPPED }] }) };
    const partial = await cmd(null, 'STOP ALL AGENTS');
    expect([partial.status, partial.json.executed, partial.json.complete, partial.json.stopped, partial.json.notStopped[0].id]).toEqual([200, true, false, [perp], spotPaper]);
    app.execution.agents = { stopAll: async () => ({ stopped: [], notStopped: [{ id: spotPaper, reason: SPOT_NOT_STOPPED }] }) };
    const none = await cmd(null, 'STOP ALL AGENTS');
    expect([none.status, none.json.error, none.json.data.notStopped[0].reason]).toEqual([501, 'execution_not_wired', SPOT_NOT_STOPPED]);
    app.execution.agents = { stopAll: async () => ({ stopped: [] }) };
    expect((await cmd(null, 'STOP ALL AGENTS')).json).toMatchObject({ executed: true, complete: true, stopped: [] });   // no agent runs: nothing to stop
    let asked = 0; app.execution.agents = { stopAll: async () => { asked += 1; return { stopped: [] }; } };
    expect((await cmd(null, 'STOP ALL AGENTS', { dryRun: true })).json).toMatchObject({ executed: false });
    const k = await call('POST', `${DEV}/keys/prepare`, { body: { name: 'no agents scope', scopes: ['orders:prepare', 'orders:execute', 'positions:manage'], expiresInDays: 30 } });
    const key = await call('POST', `${DEV}/keys`, { body: { intentId: k.json.intentId, assertion: assertion(k.json.options) } });
    expect((await cmd(key.json.secret, 'STOP ALL AGENTS')).json.error).toBe('insufficient_scope');
    expect(asked).toBe(0);
    // the default implementation is wired on the server and uses the functions the agents runtime exports
    const src = (await import('node:fs')).readFileSync(new URL('../src/orders/agent-control.ts', import.meta.url), 'utf8');
    expect(src).toContain(`import('../agents/perp-routes.ts')).perpMode(`); expect(src).toContain(`import('../agents/live.ts')).revokeAgentMandate(`);
  });
});
