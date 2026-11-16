// V11 exec2 on the LIVE path, through the real server, against the scripted venue + the REAL isolated signer class (the world of
// perp-live-world.ts). No network, no real key, nothing leaves the process.
//   - the owner's passkey commits to the FULL trading mandate hash; the stored row is verified again at every use (tamper → unusable);
//   - one principal per live venue account;
//   - the live limits are seeded ONCE from the limits approved before V11, for the owner's own orders only;
//   - risk deny tests that were missing: signer_status, venue_connection; the automatic kill (superviseAuto);
//   - the stop condition signer_unreachable_gte, and the retry of a revocation the signer has not taken;
//   - restart while an order is PARTIALLY_FILLED, through the service;
//   - rate budget: a preview and a creation share one read of the venue account.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSignerServer } from '../../isolated-signer/src/server.ts';
import { BTC, fixtureVenues, setMarket, useDatabase } from './derivatives-helpers.ts';
import { AUTH_POLICY, liveWorld, ORIGIN, type LiveWorld } from './perp-live-world.ts';

const SECRET = 'k'.repeat(48), T = '/api/v1/trading', DEV = '/api/v1/developer', L = '/api/v1/derivatives/live';
const ALL = ['wallet:read', 'markets:read', 'orders:read', 'orders:prepare', 'orders:execute', 'orders:cancel', 'positions:read', 'positions:manage'];
let app: any, sql: any, cookie = '', w: LiveWorld, signerSrv: Server, testnet = '', derivs: any, ipSeq = 0;

interface Res { status: number; json: any }
async function call(method: string, path: string, o: { key?: string | null; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...o.headers };
  if (o.key) headers.authorization = `Bearer ${o.key}`; else { headers.cookie = cookie; if (method !== 'GET') { headers.origin = ORIGIN; headers['x-spw-csrf'] = '1'; } }
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const ip = path.startsWith(DEV) ? `10.204.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}` : undefined;
  const r = await app.inject({ method, url: path, headers, payload: o.body === undefined ? undefined : JSON.stringify(o.body), ...(ip ? { remoteAddress: ip } : {}) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() };
}
const idem = () => ({ 'idempotency-key': `x2l-${randomUUID()}` });
const sign = (options: { challenge: string }) => w.pk.assert(Buffer.from(options.challenge, 'base64url'));
async function newKey(): Promise<{ id: string; secret: string }> {
  const p = await call('POST', `${DEV}/keys/prepare`, { body: { name: 'x2 live key', scopes: ALL, expiresInDays: 30, rateLimitPerMin: 600 } });
  const c = await call('POST', `${DEV}/keys`, { body: { intentId: p.json.intentId, assertion: sign(p.json.options) } });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  return { id: c.json.key.id, secret: c.json.secret };
}
const MANDATE = { mode: 'live', instruments: [BTC], orderTypes: ['market', 'limit'], maxCapitalUsd: '400', maxOrderNotionalUsd: '800', maxPositionNotionalUsd: '1000', maxLeverage: '3', maxDailyLossUsd: '50', floorEquityUsd: '100', days: 7,
  frequency: { perMinute: 5, perHour: 20, perDay: 40 }, maxSlippageBps: 100, maxFeeUsd: '5', label: 'x2 live mandate', locale: 'en' };
async function createAndPrepare(accountId: string, keyId: string, over: Record<string, unknown> = {}) {
  const m = await call('POST', '/api/v1/mandates', { body: { ...MANDATE, principal: { kind: 'api_key', id: keyId }, accountIds: [accountId], ...over } });
  expect(m.status, JSON.stringify(m.json)).toBe(200);
  const id = m.json.mandate.id as string, prep = await call('POST', `/api/v1/mandates/${id}/approve/prepare`, { body: { locale: 'en' } });
  expect(prep.status, JSON.stringify(prep.json)).toBe(200);
  return { id, prep: prep.json };
}
async function bind(keyId: string, mandateId: string) {
  const p = await call('POST', `${DEV}/keys/${keyId}/update/prepare`, { body: { changes: { mandateId } } });
  return call('POST', `${DEV}/keys/${keyId}/update`, { body: { intentId: p.json.intentId, assertion: sign(p.json.options) } });
}
async function liveKey(accountId: string, over: Record<string, unknown> = {}) {
  const k = await newKey(), { id, prep } = await createAndPrepare(accountId, k.id, over);
  const a = await call('POST', `/api/v1/mandates/${id}/approve`, { body: { assertion: sign(prep.signer.options), bindingAssertion: sign(prep.binding.options), acknowledged: true } });
  expect(a.status, JSON.stringify(a.json)).toBe(200);
  expect((await bind(k.id, id)).status).toBe(200);
  return { ...k, mandateId: id, prep };
}
const LIMITS = { allowedVenues: ['hyperliquid'], allowedInstruments: [BTC], maxOrderNotional: '1000', maxDailyNotional: '20000', maxPositionNotional: { per: {}, default: '1000' }, maxOrderLeverage: '25', maxAccountLeverage: '3', maxGrossExposure: '1500',
  maxNetExposure: '1500', maxAssetExposure: { per: {}, default: '1500' }, maxVenueExposure: { per: {}, default: '1500' }, maxVenueCollateralShareBps: '10000', maxDailyLoss: '200', maxTotalLoss: '400', maxDrawdownBps: '5000', maxOrdersPerMinute: 60 };
const order = (accountId: string, body: Record<string, unknown> = {}) => ({ mode: 'live', accountId, instrument: BTC, side: 'buy', type: 'market', size: '0.005', ...body });
const signerMandate = (id: string) => (w.signer.status() as any).venueMandates.find((m: any) => m.mandate.mandateId === id);
const mandateOf = async (id: string) => (await call('GET', `/api/v1/mandates/${id}`)).json.mandate;
const flat = () => { const u = w.t.user(w.ACCOUNT); u.positions.clear(); u.orders = u.orders.filter((o: any) => o.status !== 'open'); app.execution.risk.invalidate(); };

beforeAll(async () => {
  await useDatabase('execution_exec2_live');
  delete process.env.SPW_API_KEY_PEPPER; delete process.env.SPW_RISK_CONTEXT_TTL_MS;
  process.env.SPW_TRADING_API_EXECUTION = 'on';
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
  const mod = await import('../src/derivatives/index.ts');
  const v = fixtureVenues(w.clock);
  setMarket(v, 70_000);
  derivs = mod.createDerivatives({ registry: mod.createRegistry(v.adapters, w.clock.now), now: w.clock.now });
  // the wallet as it comes from V10: an authorized venue account whose policy the owner chose, BEFORE the V11 server first starts
  testnet = await w.authorise('testnet');
  w.t.user(w.ACCOUNT).leverage.set('BTC', { type: 'cross', value: 3 });
  app = await (await import('../src/server.ts')).buildServer({ derivatives: derivs, live: w.svc, gmx: { status: async () => ({ network: 'arbitrum', account: null, positionsError: null, positions: [] }) } as never });
  await app.ready();
});
afterAll(async () => { delete process.env.SPW_TRADING_API_EXECUTION; delete process.env.SPW_RISK_CONTEXT_TTL_MS; app?.server.closeAllConnections?.(); await app?.close(); signerSrv?.close(); await sql?.end(); });

describe('default live limits at deployment: the one-time seed', () => {
  it('seedFromV10 (pure): the minimum over the accounts, the union of the allow-lists, nothing invented', async () => {
    const { seedFromV10, LIVE_REQUIRED } = await import('../src/risk/limits.ts');
    const policy = (o: Record<string, unknown> = {}) => ({ mode: 'MANUAL_LIVE', allowedInstruments: ['hyperliquid:BTC'], halt: null, maxDataAgeMs: 5000, maxDeviationBps: '100', maxMarkIndexBps: '100', maxLeverage: '3', maxOrderNotional: '300', maxGrossExposure: '800',
      maxPositionNotional: '500', minFreeCollateral: '10', minLiquidationDistanceBps: '1500', maxDailyLoss: '40', maxTotalLoss: '160', maxOrdersPerMinute: 4, maxOrdersPerDay: 50, ...o });
    const one = seedFromV10([{ id: 'a', venue: 'hyperliquid', network: 'mainnet', policy: policy(), authorizationPolicy: { maxLeverage: 5 } }]);
    expect(one.limits).toEqual({ allowedVenues: ['hyperliquid'], allowedInstruments: ['hyperliquid:BTC'], maxOrderNotional: '300', maxPositionNotional: { per: {}, default: '500' }, maxGrossExposure: '800', maxAccountLeverage: '3', maxOrderLeverage: '5',
      maxDailyLoss: '40', maxTotalLoss: '160', maxOrdersPerMinute: 4, maxOrdersPerDay: 50, minLiquidationDistanceBps: '1500' });
    expect(one.notSeeded).toEqual(['maxDailyNotional', 'maxNetExposure', 'maxAssetExposure', 'maxVenueExposure', 'maxVenueCollateralShareBps', 'maxDrawdownBps']);
    expect(one.sources.map((s) => s.field).sort()).toEqual(Object.keys(one.limits).sort());              // every seeded value says where it came from
    for (const k of one.notSeeded) expect(LIVE_REQUIRED).toContain(k);
    // two accounts: never looser than either
    const two = seedFromV10([{ id: 'a', venue: 'hyperliquid', network: 'mainnet', policy: policy(), authorizationPolicy: { maxLeverage: 5 } },
      { id: 'b', venue: 'hyperliquid', network: 'testnet', policy: policy({ allowedInstruments: ['hyperliquid:ETH'], maxOrderNotional: '10000', maxLeverage: '2', maxDailyLoss: '5000', maxTotalLoss: '100', maxOrdersPerMinute: 30, maxOrdersPerDay: 400, minLiquidationDistanceBps: '500' }), authorizationPolicy: { maxLeverage: 10 } }]);
    expect(two.limits).toMatchObject({ allowedInstruments: ['hyperliquid:BTC', 'hyperliquid:ETH'], maxOrderNotional: '300', maxAccountLeverage: '2', maxOrderLeverage: '5', maxDailyLoss: '40', maxTotalLoss: '100', maxOrdersPerMinute: 4, minLiquidationDistanceBps: '1500' });
    expect(two.limits.maxOrdersPerDay).toBe(50);
    // a value one account does not have is not seeded at all (never guessed from the other); defaults that are already stricter are left alone
    const gap = seedFromV10([{ id: 'a', venue: 'hyperliquid', network: 'mainnet', policy: policy({ maxOrdersPerMinute: 60, maxOrdersPerDay: 500, minLiquidationDistanceBps: '100' }), authorizationPolicy: { maxLeverage: 5 } },
      { id: 'b', venue: 'hyperliquid', network: 'testnet', policy: { allowedInstruments: ['hyperliquid:BTC'], maxOrderNotional: 'abc' }, authorizationPolicy: null }]);
    expect(Object.keys(gap.limits).sort()).toEqual(['allowedInstruments', 'allowedVenues']);
    expect(gap.notSeeded).toHaveLength(13);
    // no authorized account: nothing
    expect(seedFromV10([])).toMatchObject({ limits: {}, sources: [] });
    expect(seedFromV10([]).notSeeded).toHaveLength(15);
  });

  it('a wallet that comes from V10: the owner\'s own order is judged on what he had approved; the six limits with no equivalent still deny, by name; a key sees none of it; the seed is written once', async () => {
    const lv = (await call('GET', '/api/v1/risk/limits/live')).json;
    const [acc] = await sql`select policy, venue_authorization from deriv_accounts where id = ${testnet}`;
    expect(lv.seed.accounts).toEqual([{ id: testnet, venue: 'hyperliquid', network: 'testnet' }]);
    expect(lv.seed.limits).toMatchObject({ allowedVenues: ['hyperliquid'], allowedInstruments: [...acc.policy.allowedInstruments].sort(), maxOrderNotional: String(acc.policy.maxOrderNotional), maxGrossExposure: String(acc.policy.maxGrossExposure),
      maxPositionNotional: { per: {}, default: String(acc.policy.maxPositionNotional) }, maxAccountLeverage: String(acc.policy.maxLeverage), maxOrderLeverage: String(acc.venue_authorization.policy.maxLeverage),
      maxDailyLoss: String(acc.policy.maxDailyLoss), maxTotalLoss: String(acc.policy.maxTotalLoss) });
    expect(acc.venue_authorization.policy.maxLeverage).toBe(AUTH_POLICY.maxLeverage);
    expect(lv).toMatchObject({ stored: {}, ownerOrdersRefused: true, automationOrdersRefused: true, missing: ['maxDailyNotional', 'maxNetExposure', 'maxAssetExposure', 'maxVenueExposure', 'maxVenueCollateralShareBps', 'maxDrawdownBps'] });
    expect(lv.missingForAutomation).toHaveLength(15);
    expect((await sql`select data from audit_events where type = 'risk.limits_seeded'`)[0].data).toMatchObject({ accounts: [testnet], notSeeded: lv.missing });
    // the owner's order: refused only for the six
    const r = await call('POST', `${T}/orders`, { headers: idem(), body: order(testnet, { type: 'limit', price: '69000', size: '0.002' }) });
    expect([r.status, r.json.error, [...r.json.data.failed].sort()]).toEqual([422, 'risk_denied', ['asset_exposure', 'collateral_concentration', 'daily_notional', 'drawdown', 'net_exposure', 'venue_exposure']]);
    // …and a seeded limit binds him: the seed is a limit, not a bypass
    const big = await call('POST', `${T}/orders/preview`, { body: order(testnet, { type: 'limit', price: '69000', size: '0.02' }) });   // 1 380 USD
    if (Number(acc.policy.maxOrderNotional) < 1380) expect(big.json.risk.checks.find((c: any) => c.id === 'order_notional')).toMatchObject({ ok: false, limit: String(acc.policy.maxOrderNotional) });
    // an API key or an agent: every capital limit is missing
    expect(await app.execution.risk.limitsFor('live', 'api_key')).toEqual({});
    expect(await app.execution.risk.limitsFor('live', 'agent')).toEqual({});
    // once: a policy changed afterwards (or a new account) does not move the seed
    await sql`update deriv_accounts set policy = jsonb_set(policy, '{maxOrderNotional}', '"999999"') where id = ${testnet}`;
    const again = await app.execution.risk.seedLiveLimits();
    expect([again.at, again.limits.maxOrderNotional]).toEqual([lv.seed.at, lv.seed.limits.maxOrderNotional]);
    await sql`update deriv_accounts set policy = ${sql.json(acc.policy)} where id = ${testnet}`;
    // the owner sets the six (a loosening: passkey) — his orders pass; keys are still refused for the nine he never stored himself
    const six = { maxDailyNotional: '20000', maxNetExposure: '1500', maxAssetExposure: { per: {}, default: '1500' }, maxVenueExposure: { per: {}, default: '1500' }, maxVenueCollateralShareBps: '10000', maxDrawdownBps: '5000' };
    expect((await call('POST', '/api/v1/risk/limits/live', { body: { limits: six } })).json.error).toBe('passkey_required');
    const p = await call('POST', '/api/v1/risk/limits/live/prepare', { body: { limits: six } });
    expect((await call('POST', '/api/v1/risk/limits/live/approve', { body: { assertion: sign(p.json.options) } })).status).toBe(200);
    const after = (await call('GET', '/api/v1/risk/limits/live')).json;
    expect([after.missing, after.ownerOrdersRefused, after.missingForAutomation.length, after.automationOrdersRefused]).toEqual([[], false, 9, true]);
    const ok = await call('POST', `${T}/orders`, { headers: idem(), body: order(testnet, { type: 'limit', price: '69000', size: '0.002' }) });
    expect(ok.json.order?.status, JSON.stringify(ok.json)).toBe('AWAITING_APPROVAL');
    await call('DELETE', `${T}/orders/${ok.json.order.id}`, { headers: idem() });
    // from here the suite works with a complete stored set (it applies to keys too)
    const full = await call('POST', '/api/v1/risk/limits/live/prepare', { body: { limits: LIMITS } });
    expect((await call('POST', '/api/v1/risk/limits/live/approve', { body: { assertion: sign(full.json.options) } })).status).toBe(200);
    expect((await call('GET', '/api/v1/risk/limits/live')).json.missingForAutomation).toEqual([]);
  });
});

describe('the passkey commits to the FULL trading mandate hash', () => {
  it('the sheet shows it; without the second assertion, or with one over anything else, nothing is approved and nothing reaches the signer', async () => {
    w.next();
    const { tradingMandateHashHex } = await import('@spw/trading');
    const k = await newKey(), { id, prep } = await createAndPrepare(testnet, k.id);
    expect(prep.hash).toBe(tradingMandateHashHex(prep.mandate));
    expect(prep.binding).toMatchObject({ domain: 'SPW-TRADING-MANDATE-APPROVAL-v1', intent: { v: 1, kind: 'trading_mandate_approval', mandateId: id, tradingMandateHash: prep.hash, principal: `api_key:${k.id}`, mode: 'live',
      signer: { shape: 'SPW-VENUE-MANDATE-v1', mandateHash: prep.signer.hash } } });
    expect(prep.binding.options.challenge).toBe(Buffer.from(prep.binding.hash, 'hex').toString('base64url'));
    expect(prep.binding.options.challenge).not.toBe(prep.signer.options.challenge);
    const none = await call('POST', `/api/v1/mandates/${id}/approve`, { body: { assertion: sign(prep.signer.options), acknowledged: true } });
    expect([none.status, none.json.error]).toEqual([403, 'passkey_required']);
    // the signer's assertion presented as the binding: a real passkey signature, over the wrong challenge
    const wrong = await call('POST', `/api/v1/mandates/${id}/approve`, { body: { assertion: sign(prep.signer.options), bindingAssertion: sign(prep.signer.options), acknowledged: true } });
    expect([wrong.status, wrong.json.error]).toEqual([403, 'bad_approval']);
    expect(signerMandate(id)).toBeUndefined();
    expect((await mandateOf(id)).state).toBe('pending_signer');
    const ok = await call('POST', `/api/v1/mandates/${id}/approve`, { body: { assertion: sign(prep.signer.options), bindingAssertion: sign(prep.binding.options), acknowledged: true } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.mandate).toMatchObject({ state: 'active', integrity: { ok: true, reason: null }, approval: { domain: 'SPW-TRADING-MANDATE-APPROVAL-v1', tradingMandateHash: prep.hash, signerMandateHash: prep.signer.hash, hash: prep.binding.hash } });
    expect(JSON.stringify(ok.json.mandate)).not.toContain('authenticatorData');                          // the assertion itself never leaves
    expect(signerMandate(id)).toMatchObject({ hash: prep.signer.hash, phase: 'active' });
    // the binding intent is single-use
    expect((await sql`select count(*)::int as n from settings where key = ${`mandate.intent.approve.${id}`}`)[0].n).toBe(0);
    expect((await call('POST', `/api/v1/mandates/${id}/revoke`, { body: {} })).status).toBe(200);
  });

  it('an approved mandate whose row is altered — an API-only field, the hash with it, the approval, the passkey — is unusable; restored, it works; the supervisor revokes a tampered one at the signer', async () => {
    w.next(); flat();
    const { tradingMandateHashHex } = await import('@spw/trading');
    const k = await liveKey(testnet);
    const [orig] = await sql`select mandate, hash, approval from trading_mandates where id = ${k.mandateId}`;
    const restore = async () => { await sql`update trading_mandates set mandate = ${sql.json(orig.mandate)}, hash = ${orig.hash}, approval = ${sql.json(orig.approval)} where id = ${k.mandateId}`; };
    const attempt = () => call('POST', `${T}/orders`, { key: k.secret, headers: idem(), body: order(testnet, { size: '0.001' }) });
    const refused = async (label: string, reason: RegExp) => {
      w.next();
      const signs = w.orderSigns(), r = await attempt();
      expect([r.status, r.json.error], `${label}: ${JSON.stringify(r.json)}`).toEqual([403, 'mandate_integrity']);
      expect(w.orderSigns(), label).toBe(signs);                                                         // nothing reached the signer
      const m = await mandateOf(k.mandateId);
      expect(m.integrity.ok, label).toBe(false);
      expect(m.integrity.reason, label).toMatch(reason);
      const pv = await call('POST', `${T}/orders/preview`, { key: k.secret, body: order(testnet, { size: '0.001' }) });
      expect(pv.json.refusals.find((x: any) => x.stage === 'mandate'), label).toMatchObject({ code: 'mandate_integrity' });
    };
    const first = await attempt();
    expect(first.json.order?.status, JSON.stringify(first.json)).toBe('FILLED');
    w.next();
    // 1 — an API-only field (the daily loss limit) raised in the row
    const wider = { ...orig.mandate, maxDailyLossUsd: '999999', orderTypes: ['market', 'limit', 'stop', 'take_profit'], stopConditions: [] };
    await sql`update trading_mandates set mandate = ${sql.json(wider)} where id = ${k.mandateId}`;
    await refused('API-only fields altered', /does not hash to its recorded hash/);
    // 2 — and the recorded hash rewritten to match: it is no longer the hash the passkey approved
    await sql`update trading_mandates set hash = ${tradingMandateHashHex(wider)} where id = ${k.mandateId}`;
    await refused('hash rewritten', /another mandate or another hash/);
    // 3 — and the stored intent rewritten to name the new hash: the stored intent is no longer the one that was hashed, and the assertion is not over it
    const forged = { ...orig.approval, intent: { ...orig.approval.intent, tradingMandateHash: tradingMandateHashHex(wider) } };
    await sql`update trading_mandates set approval = ${sql.json(forged)} where id = ${k.mandateId}`;
    await refused('intent rewritten', /not intact/);
    const { canonicalIntentHash } = await import('../src/derivatives/exec.ts'), { hex } = await import('@spw/derivatives/live');
    await sql`update trading_mandates set approval = ${sql.json({ ...forged, hash: hex(canonicalIntentHash('SPW-TRADING-MANDATE-APPROVAL-v1', forged.intent)) })} where id = ${k.mandateId}`;
    await refused('intent and its hash rewritten', /does not verify/);
    // 4 — the approval removed
    await restore();
    await sql`update trading_mandates set approval = null where id = ${k.mandateId}`;
    await refused('approval removed', /no passkey approval/);
    // 5 — the row pointed at another principal
    await restore();
    const other = await newKey();
    await sql`update trading_mandates set principal_id = ${other.id} where id = ${k.mandateId}`;
    expect((await call('POST', `${DEV}/keys/${other.id}/update/prepare`, { body: { changes: { mandateId: k.mandateId } } })).json.error).toBe('mandate_integrity');   // the binding of a key is verified when it is prepared
    await sql`update trading_mandates set principal_id = ${k.id} where id = ${k.mandateId}`;
    // 6 — the passkey that approved it is no longer enrolled
    const [cred] = await sql`select * from credentials`;
    await sql`delete from credentials where id = ${cred.id}`;
    await refused('passkey removed', /no longer enrolled/);
    await sql`insert into credentials ${sql(cred)}`;
    // restored exactly: usable again
    w.next();
    expect((await mandateOf(k.mandateId)).integrity).toEqual({ ok: true, reason: null });
    const again = await attempt();
    expect(again.json.order?.status, JSON.stringify(again.json)).toBe('FILLED');
    // a tampered ACTIVE mandate is ended by the supervisor, at the signer too
    await sql`update trading_mandates set mandate = ${sql.json(wider)} where id = ${k.mandateId}`;
    expect((await app.execution.mandates.supervise()).stopped).toContain(k.mandateId);
    expect((await mandateOf(k.mandateId)).state).toBe('revoked');
    expect(signerMandate(k.mandateId)).toMatchObject({ revoked: true });
    expect((await sql`select data from audit_events where type = 'mandate.revoked' order by seq desc limit 1`)[0].data).toMatchObject({ mandateId: k.mandateId, reason: 'key_compromise' });
    await restore(); flat();
  });

  it('one principal per live venue account: a perp agent\'s derivative mandate holds the account too; a revoked holder frees it at once', async () => {
    w.next();
    const k = await liveKey(testnet), k2 = await newKey();
    const second = await call('POST', '/api/v1/mandates', { body: { ...MANDATE, principal: { kind: 'api_key', id: k2.id }, accountIds: [testnet] } });
    expect([second.status, second.json.error, second.json.data.holder.principal]).toEqual([409, 'account_has_active_mandate', `api_key:${k.id}`]);
    expect((await call('POST', `/api/v1/mandates/${k.mandateId}/revoke`, { body: {} })).status).toBe(200);
    // an agent's derivative mandate, as the perp-agent runtime stores it (deriv_mandates), is a holder as well
    const { holder } = await (async () => {
      const dm = randomUUID(), now = Math.floor(w.clock.now() / 1000);
      await sql`insert into deriv_mandates (id, account_id, authorization_id, state, mandate, hash, ack, prepared_at, approved_at) values (${dm}, ${testnet}, ${randomUUID()}, 'active', ${sql.json({ agentId: 'agent-77', expiresAt: now + 3600 })}, 'h', ${sql.json({})}, now(), now())`;
      const r = await call('POST', '/api/v1/mandates', { body: { ...MANDATE, principal: { kind: 'api_key', id: k2.id }, accountIds: [testnet] } });
      await sql`delete from deriv_mandates where id = ${dm}`;
      return { holder: r.json.data?.holder, dm };
    })();
    expect(holder).toMatchObject({ via: 'derivative_mandate', principal: 'agent:agent-77' });
    w.next();
    const free = await liveKey(testnet);                                                                 // the wind-down of the revoked one does not block
    expect((await mandateOf(free.mandateId)).state).toBe('active');
    expect((await call('POST', `/api/v1/mandates/${free.mandateId}/revoke`, { body: {} })).status).toBe(200);
  });
});

describe('risk checks and stops that had no test', () => {
  const canonical = (over: Record<string, unknown> = {}) => { const now = w.clock.now(); return { v: 1, venue: 'hyperliquid', network: 'testnet', instrument: BTC, marketKind: 'perp', side: 'buy', type: 'limit', size: '0.002', notional: null, limitPrice: '69000', triggerPrice: null,
    reduceOnly: false, tif: 'gtc', maxSlippageBps: 50, maxFeeUsd: '1', leverage: null, marginMode: null, clientOrderId: `x2-${randomUUID()}`, mode: 'live', principal: { kind: 'owner', id: 'owner' }, mandateId: null, createdAt: now, expiresAt: now + 60_000, ...over }; };

  it('signer_status: a halted signer, then an unreachable one, deny a live order — through the HTTP API; a cancel still passes', async () => {
    w.next(); flat();
    const risk = app.execution.risk, real = risk.deps.signerStatus;
    const rest = await call('POST', `${T}/orders`, { headers: idem(), body: order(testnet, { type: 'limit', price: '69000', size: '0.002' }) });
    expect(rest.json.order?.status, JSON.stringify(rest.json)).toBe('AWAITING_APPROVAL');
    for (const [label, fake] of [['halted', async () => ({ halted: true })], ['unreachable', async () => { throw new Error('connect ECONNREFUSED'); }]] as const) {
      risk.deps.signerStatus = fake as never; risk.invalidate();
      const r = await call('POST', `${T}/orders`, { headers: idem(), body: order(testnet, { type: 'limit', price: '69000', size: '0.002' }) });
      expect([r.status, r.json.error, r.json.data.failed], label).toEqual([422, 'risk_denied', ['signer_status']]);
      expect(r.json.data.order, label).toMatchObject({ status: 'REJECTED', reasonCode: 'RISK_DENIED' });
    }
    const c = await call('DELETE', `${T}/orders/${rest.json.order.id}`, { headers: idem() });
    expect([c.status, c.json.order.status]).toEqual([200, 'CANCELLED']);
    risk.deps.signerStatus = real; risk.invalidate();
    expect((await call('POST', `${T}/orders/preview`, { body: order(testnet, { type: 'limit', price: '69000', size: '0.002' }) })).json.risk.decision).toBe('allow');
  });

  it('venue_connection: when the venue\'s market cannot be read the connection check denies new risk', async () => {
    w.next();
    const risk = app.execution.risk;
    expect((await risk.evaluateOrder(canonical(), { accountId: testnet, preview: true })).decision).toBe('allow');
    let seen: string[] | null = null;
    for (const type of ['metaAndAssetCtxs', 'l2Book', 'allMids', 'meta']) {
      w.next(); w.faults.info = type; risk.invalidate();
      const ev = await risk.evaluateOrder(canonical(), { accountId: testnet, preview: true }).catch(() => null);
      w.faults.info = null;
      if (ev && ev.failed.includes('venue_connection')) { seen = ev.failed; expect(ev.decision).toBe('deny'); expect(ev.checks.find((c: any) => c.id === 'venue_connection')).toMatchObject({ ok: false, exempt: false }); break; }
    }
    expect(seen, 'no fault on the venue\'s market read made the connection check fail').not.toBeNull();
    risk.invalidate(); w.next();
    expect((await risk.evaluateOrder(canonical(), { accountId: testnet, preview: true })).decision).toBe('allow');
  });

  it('the automatic kill (superviseAuto): the live mainnet book reaches the total-loss limit, then the drawdown limit → the supervisor engages the kill switch; an unreadable book does not trip it', async () => {
    w.next();
    const risk = app.execution.risk;
    expect(await risk.superviseAuto()).toBeNull();                                                       // no authorized mainnet account: nothing to watch
    w.flags.mainnet = true; w.flags.mandateMainnet = true;
    const mainnet = await w.authorise('mainnet');
    risk.invalidate();
    expect(await risk.superviseAuto()).toBeNull();                                                       // readable, no loss
    expect((await risk.switches()).killSwitch.on).toBe(false);
    // a realised loss of 450 USD on the mainnet account (limit 400)
    await sql`insert into deriv_fills (account_id, fill_id, instrument, side, price, size, fee, fee_asset, closed_pnl, ts) values (${mainnet}, 'loss-1', ${BTC}, 'sell', 60000, 0.045, 0, 'USDC', -450, ${new Date(w.clock.now())})`;
    w.faults.info = 'clearinghouseState';
    expect(await risk.superviseAuto()).toBeNull();                                                       // the book cannot be read: it is not tripped on a guess
    w.faults.info = null;
    const why = await risk.superviseAuto();
    expect(why).toMatch(/^total loss limit reached: PnL -450/);
    expect((await risk.switches()).killSwitch).toMatchObject({ on: true, by: { kind: 'system', id: 'supervisor' } });
    expect((await sql`select data from audit_events where type = 'risk.kill_switch' order by seq desc limit 1`)[0].data).toMatchObject({ engaged: true, by: 'system:supervisor' });
    expect(await risk.superviseAuto()).toBeNull();                                                       // once
    const denied = await call('POST', `${T}/orders`, { headers: idem(), body: order(testnet, { type: 'limit', price: '69000', size: '0.002' }) });
    expect([denied.status, denied.json.error]).toEqual([423, 'kill_switch_active']);
    const rel = async () => { const p = await call('POST', '/api/v1/risk/kill-switch/release/prepare'); return call('POST', '/api/v1/risk/kill-switch/release', { body: { assertion: sign(p.json.options) } }); };
    expect((await rel()).json.killSwitch.on).toBe(false);
    // drawdown: the loss is gone, the equity is far below the highest it has been
    await sql`delete from deriv_fills where fill_id = 'loss-1'`;
    const x = await risk.exposure('live-mainnet');
    await sql`insert into settings (key, value) values ('risk.peak.live-mainnet', ${sql.json({ equity: String(Number(x.equity) * 3), at: 1 })}) on conflict (key) do update set value = excluded.value`;
    expect(await risk.superviseAuto()).toMatch(/^drawdown limit reached/);
    expect((await rel()).json.killSwitch.on).toBe(false);
    // with the automatic stops switched off (a loosening: passkey) nothing trips
    const p = await call('POST', '/api/v1/risk/auto/prepare', { body: { auto: { totalLoss: false, drawdown: false, dailyLoss: false } } });
    expect((await call('POST', '/api/v1/risk/auto', { body: { auto: { totalLoss: false, drawdown: false, dailyLoss: false } } })).json.error).toBe('passkey_required');
    expect((await call('POST', '/api/v1/risk/auto', { body: { auto: { totalLoss: false, drawdown: false, dailyLoss: false }, assertion: sign(p.json.options) } })).status).toBe(200);
    expect(await risk.superviseAuto()).toBeNull();
    expect((await call('POST', '/api/v1/risk/auto', { body: { auto: { totalLoss: true, drawdown: true, dailyLoss: false } } })).status).toBe(200);   // switching them back on is free
    await sql`delete from settings where key = 'risk.peak.live-mainnet'`;
    w.flags.mainnet = false; w.flags.mandateMainnet = false;
  });

  it('signer_unreachable_gte: the signer stays unreachable past the mandate\'s bound → stop; the revocation the signer could not take is asked again until it has it', async () => {
    w.next(); flat();
    const mandates = app.execution.mandates, realStatus = mandates.deps.signerStatus, realRevoke = w.mandatePort.venueMandateRevoke;
    const k = await liveKey(testnet, { stopConditions: [{ kind: 'signer_unreachable_gte', ms: 120_000 }] });
    expect((await mandates.supervise()).stopped).toEqual([]);
    mandates.deps.signerStatus = async () => { throw new Error('connect ECONNREFUSED'); };
    w.mandatePort.venueMandateRevoke = async () => { throw new Error('connect ECONNREFUSED'); };
    expect((await mandates.supervise()).stopped).toEqual([]);                                            // the outage starts being measured
    w.clock.advance(60_000);
    expect((await mandates.supervise()).stopped).toEqual([]);                                            // 60 s: inside the bound
    w.clock.advance(61_000);
    expect((await mandates.supervise()).stopped).toEqual([k.mandateId]);
    let m = await mandateOf(k.mandateId);
    expect(m).toMatchObject({ state: 'revoked', stop: { code: 'STOP_SIGNER_UNREACHABLE_GTE' } });
    expect(m.revocation).toMatchObject({ signerRevoked: false });
    expect(signerMandate(k.mandateId)).toMatchObject({ revoked: false });                                // the signer never heard of it…
    const r = await call('POST', `${T}/orders`, { key: k.secret, headers: idem(), body: order(testnet, { size: '0.001' }) });
    expect([r.status, r.json.error]).toEqual([403, 'mandate_denied']);                                   // …but the API accepts nothing under it from that instant
    // still unreachable: asked again, still not taken
    await mandates.supervise();
    expect((await mandateOf(k.mandateId)).revocation.signerRevoked).toBe(false);
    // back: the next pass revokes the signer's copy
    mandates.deps.signerStatus = realStatus; w.mandatePort.venueMandateRevoke = realRevoke;
    await mandates.supervise();
    m = await mandateOf(k.mandateId);
    expect(m.revocation).toMatchObject({ signerRevoked: true, signerError: null });
    expect(signerMandate(k.mandateId)).toMatchObject({ revoked: true });
    await mandates.supervise();                                                                           // nothing left to retry
    expect((await sql`select count(*)::int as n from trading_mandates where state = 'revoked' and mode = 'live' and revocation->>'signerRevoked' = 'false'`)[0].n).toBe(0);
  });
});

describe('restart and rate budget', () => {
  it('restart while an order is PARTIALLY_FILLED: a new process finds the partial fill at the venue, then the rest, from the database and the venue alone', async () => {
    w.next(); flat();
    const o = await call('POST', `${T}/orders`, { headers: idem(), body: order(testnet, { type: 'limit', price: '69000', size: '0.004' }) });
    expect(o.json.order?.status, JSON.stringify(o.json)).toBe('AWAITING_APPROVAL');
    const id = o.json.order.id as string;
    const a = await call('POST', o.json.approval.approve.path, { body: { assertion: w.pk.assert(w.b64(o.json.approval.hash)) } });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect((await call('GET', `${T}/orders/${id}`)).json.order.status).toBe('SUBMITTED');
    // the venue fills a quarter of it while no process of ours is looking
    const u = w.t.user(w.ACCOUNT), vo = u.orders.find((x: any) => x.cloid === id)!;
    expect(vo, 'the resting order at the scripted venue').toBeTruthy();
    (w.t as any).fill(u, vo, '69000', '0.001');
    const { createExecution } = await import('../src/orders/index.ts');
    const fresh = createExecution({ derivatives: derivs, live: w.svc, gmx: { status: async () => ({ positions: [] }) } as never });
    w.next(5_000);
    await w.svc.step();
    await fresh.orders.reconcile();
    let row = (await sql`select state, record from orders where id = ${id}`)[0];
    expect([row.state, row.record.filledSize]).toEqual(['PARTIALLY_FILLED', '0.001']);
    expect((await sql`select event, to_state from order_events where order_id = ${id} order by seq desc limit 1`)[0]).toMatchObject({ event: 'reconciled_found', to_state: 'PARTIALLY_FILLED' });
    // a second new process, later: the rest filled meanwhile
    (w.t as any).fill(u, vo, '69000', '0.003'); vo.status = 'filled'; vo.statusTimestamp = w.clock.now();
    const fresh2 = createExecution({ derivatives: derivs, live: w.svc, gmx: { status: async () => ({ positions: [] }) } as never });
    w.next(5_000);
    await w.svc.step();
    await fresh2.orders.reconcile();
    row = (await sql`select state, record, projection_error from orders where id = ${id}`)[0];
    expect([row.state, row.record.filledSize, row.projection_error]).toEqual(['FILLED', '0.004', null]);
    const g = await call('GET', `${T}/orders/${id}`);
    expect(g.json.fills.map((f: any) => f.size).sort()).toEqual(['0.001', '0.003']);
    expect(g.json.history.map((h: any) => h.to)).toEqual(['VALIDATED', 'AWAITING_APPROVAL', 'APPROVED', 'SUBMITTING', 'SUBMITTED', 'PARTIALLY_FILLED', 'FILLED']);
    flat();
  });

  it('rate budget: a preview and a creation share ONE read of the venue account; with the sharing off each evaluation reads it; a fill drops the shared copy at once', async () => {
    const risk = app.execution.risk;
    const accountReads = () => w.t.calls.filter((c: any) => c.path === '/info' && c.type === 'clearinghouseState').length;
    const run = async () => {
      w.next(); flat();
      const reads0 = accountReads(), book0 = { ...risk.bookReads };
      const body = order(testnet, { type: 'limit', price: '69000', size: '0.002' });
      expect((await call('POST', `${T}/orders/preview`, { body })).json.risk.decision).toBe('allow');
      const o = await call('POST', `${T}/orders`, { headers: idem(), body });
      expect(o.json.order?.status, JSON.stringify(o.json)).toBe('AWAITING_APPROVAL');
      const out = { venue: accountReads() - reads0, fresh: risk.bookReads.fresh - book0.fresh, shared: risk.bookReads.shared - book0.shared };
      await call('DELETE', `${T}/orders/${o.json.order.id}`, { headers: idem() });
      return out;
    };
    const on = await run();
    process.env.SPW_RISK_CONTEXT_TTL_MS = '0';
    const off = await run();
    delete process.env.SPW_RISK_CONTEXT_TTL_MS;
    // three evaluations (the preview, and the two of a creation): one book read when shared, three when not
    expect([on.fresh, off.shared]).toEqual([1, 0]);
    expect(off.fresh).toBeGreaterThanOrEqual(3);
    expect(on.shared).toBeGreaterThanOrEqual(1);
    expect(on.venue).toBeLessThan(off.venue);
    expect(off.venue - on.venue).toBeGreaterThanOrEqual(2);
    // invalidation: an engine row that changes (here: a new order row) and a fill both drop the shared copy
    w.next(); flat();
    const body = order(testnet, { type: 'limit', price: '69000', size: '0.002' });
    await call('POST', `${T}/orders/preview`, { body });
    let b = { ...risk.bookReads };
    await call('POST', `${T}/orders/preview`, { body });
    expect([risk.bookReads.fresh - b.fresh, risk.bookReads.shared - b.shared]).toEqual([0, 2]);          // nothing changed: both evaluations of a preview (the service's and the engine's own gate) take the shared copy
    await sql`insert into order_projection_queue (engine, ref) values ('deriv', ${`${testnet}:nothing`})`;   // what the trigger does on any engine row change
    b = { ...risk.bookReads };
    await call('POST', `${T}/orders/preview`, { body });
    expect([risk.bookReads.fresh - b.fresh, risk.bookReads.shared - b.shared]).toEqual([1, 1]);
    await sql`delete from order_projection_queue where ref = ${`${testnet}:nothing`}`;
    // a position that changed at the venue is seen once the shared copy is dropped (and never later than the TTL)
    w.t.forcePosition(w.ACCOUNT, 'BTC', '0.004');
    risk.invalidate('live-testnet');
    const pv = await call('POST', `${T}/orders/preview`, { body });
    expect(pv.json.risk.derived.positionBefore).toBe('0.004');
    flat();
  });
});
