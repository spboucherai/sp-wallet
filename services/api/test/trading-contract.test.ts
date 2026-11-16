// The CONTRACT of the trading API against the real server: every answer of this file — success or error — is validated against
// the OpenAPI document the server generates (closed objects, enums, the codes of `x-spw-errors`). Real server, real signer
// process, real API keys and paper mandates created through the owner routes, fixture-backed venues, own database; no network.
//
// One test per defect the SDK work found (docs/v11/work/contract-resync.md): undeclared members, money as numbers, undeclared
// 422 / 404 codes, the unknown route, write success schemas, the order states, key ↔ mandate binding, the instrument and the
// notional, pagination, and what a preview tells a key about the account.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RISK_CODES } from '@spw/derivatives';
import { MANDATE_DENY_CODES, ORDER_STATES as MACHINE_STATES, RISK_CHECK_IDS as ENGINE_CHECK_IDS, TERMINAL_STATES, UNRESOLVABLE_CODES } from '@spw/trading';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { createSignerServer } from '../../isolated-signer/src/server.ts';
import { Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';
import { BTC, Clock, fixtureVenues, GMX_BTC, setMarket, useDatabase, type Venues } from './derivatives-helpers.ts';

const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'k'.repeat(48), T = '/api/v1/trading', DEV = '/api/v1/developer';
const owner = new TestPasskey(RP, ORIGIN);
const ALL = ['wallet:read', 'markets:read', 'orders:read', 'orders:prepare', 'orders:execute', 'orders:cancel', 'positions:read', 'positions:manage', 'strategies:read', 'strategies:manage', 'agents:read', 'agents:manage'];
const DEC = /^\d+(\.\d+)?$/;
/* eslint-disable @typescript-eslint/no-explicit-any -- JSON answers and the test's own handles */
let app: any, sql: any, cookie = '', clock: Clock, v: Venues, signerSrv: Server, acct = '', doc: any;
let spec: typeof import('../src/trading-api/spec.ts'), read: typeof import('../src/trading-api/read.ts'), shaping: typeof import('../src/trading-api/shaping.ts');
let ipSeq = 0;

interface Res { status: number; json: any; headers: Record<string, any> }
async function call(method: string, path: string, o: { key?: string | null; cookie?: string | null; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...o.headers };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  const c = o.cookie === undefined ? (o.key ? null : cookie) : o.cookie;
  if (c) headers.cookie = c;
  if (c && method !== 'GET') { headers.origin = ORIGIN; headers['x-spw-csrf'] = '1'; }
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const ip = path.startsWith(DEV) ? `10.202.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}` : undefined;
  const r = await app.inject({ method, url: path, headers, payload: o.body === undefined ? undefined : JSON.stringify(o.body), ...(ip ? { remoteAddress: ip } : {}) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), headers: r.headers };
}
const idem = () => ({ 'idempotency-key': `contract-${randomUUID()}` });
const assertion = (options: { challenge: string }) => owner.assert(Buffer.from(options.challenge, 'base64url'));
async function newKey(body: Record<string, unknown> = {}): Promise<{ id: string; secret: string }> {
  const p = await call('POST', `${DEV}/keys/prepare`, { body: { name: 'contract key', scopes: ALL, expiresInDays: 30, rateLimitPerMin: 600, ...body } });
  expect(p.status, JSON.stringify(p.json)).toBe(200);
  const c = await call('POST', `${DEV}/keys`, { body: { intentId: p.json.intentId, assertion: assertion(p.json.options) } });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  return { id: c.json.key.id, secret: c.json.secret };
}
const MANDATE = { mode: 'paper', instruments: [BTC], orderTypes: ['market', 'limit'], maxCapitalUsd: '5000', maxOrderNotionalUsd: '2000', maxPositionNotionalUsd: '4000', maxLeverage: '3', maxDailyLossUsd: '500', floorEquityUsd: '1000', days: 7,
  frequency: { perMinute: 30, perHour: 200, perDay: 400 }, maxSlippageBps: 100, maxFeeUsd: '10', label: 'contract mandate' };
async function mandateFor(keyId: string): Promise<string> {
  const m = await call('POST', '/api/v1/mandates', { body: { ...MANDATE, principal: { kind: 'api_key', id: keyId }, accountIds: [acct] } });
  expect(m.status, JSON.stringify(m.json)).toBe(200);
  expect((await call('POST', `/api/v1/mandates/${m.json.mandate.id}/approve`, { body: {} })).status).toBe(200);
  return m.json.mandate.id as string;
}
async function tradingKey(keyBody: Record<string, unknown> = {}) {
  const k = await newKey(keyBody), mandateId = await mandateFor(k.id);
  const p = await call('POST', `${DEV}/keys/${k.id}/update/prepare`, { body: { changes: { mandateId } } });
  expect(p.status, JSON.stringify(p.json)).toBe(200);
  expect((await call('POST', `${DEV}/keys/${k.id}/update`, { body: { intentId: p.json.intentId, assertion: assertion(p.json.options) } })).status).toBe(200);
  return { ...k, mandateId };
}
const ORDER: Record<string, unknown> = { mode: 'paper', instrument: BTC, side: 'buy', type: 'market', size: '0.01' };
/** the suite shares one paper account: each scenario starts without a BTC position (the owner closes it; paper executes at once) */
async function flatten(): Promise<void> {
  const r = await call('POST', `${T}/positions/${encodeURIComponent(`paper:hyperliquid:${acct}:${BTC}`)}/close`, { body: {}, headers: idem() });
  expect([200, 422], JSON.stringify(r.json)).toContain(r.status);
}

// ---------------------------------------------------------------------------------------------------------------- the document as a validator
/** JSON Schema 2020-12, the subset the document uses; `$ref` is resolved in the document. Returns the violations. */
function violations(schema: any, value: unknown, at = '$'): string[] {
  if (schema === true || schema === undefined) return [];
  if (schema.$ref) return violations(schema.$ref.split('/').slice(1).reduce((o: any, k: string) => o[k], doc), value, at);
  if (schema.anyOf) return schema.anyOf.some((s: any) => violations(s, value, at).length === 0) ? [] : [`${at}: matches no alternative (${JSON.stringify(value)?.slice(0, 80)})`];
  if ('const' in schema) return value === schema.const ? [] : [`${at}: expected ${JSON.stringify(schema.const)}`];
  if (schema.enum) return schema.enum.includes(value) ? [] : [`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`];
  const types: string[] = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const is = (t: string): boolean => (t === 'null' ? value === null : t === 'array' ? Array.isArray(value) : t === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : t === 'integer' ? Number.isInteger(value) : t === 'number' ? typeof value === 'number' : typeof value === t);
  if (types.length && !types.some(is)) return [`${at}: expected ${types.join('|')}, got ${JSON.stringify(value)?.slice(0, 60)}`];
  const out: string[] = [];
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(`${at}: does not match ${schema.pattern}`);
  if (Array.isArray(value)) {
    if (schema.prefixItems) { schema.prefixItems.forEach((s: any, i: number) => out.push(...violations(s, value[i], `${at}[${i}]`))); if (schema.items === false && value.length > schema.prefixItems.length) out.push(`${at}: too many items`); }
    else if (schema.items) value.forEach((x, i) => out.push(...violations(schema.items, x, `${at}[${i}]`)));
  } else if (value !== null && typeof value === 'object') {
    const props = schema.properties ?? {}, o = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in o)) out.push(`${at}.${k}: required`);
    for (const [k, x] of Object.entries(o)) {
      if (props[k]) out.push(...violations(props[k], x, `${at}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${at}.${k}: not declared (the object is closed)`);
    }
  }
  return out;
}
const opOf = (id: string): any => { for (const item of Object.values(doc.paths) as any[]) for (const o of Object.values(item) as any[]) if (o.operationId === id) return o; throw new Error(`no operation ${id}`); };
const seen = new Map<string, Set<string>>();
/** the answer is one the document describes for this operation: its 200 schema, or an error with a declared (status, code) */
function check(id: string, r: Res): Res {
  const op = opOf(id), what = `${id} → ${r.status} ${JSON.stringify(r.json)?.slice(0, 300)}`;
  if (r.status === 200) expect(violations(op.responses['200'].content['application/json'].schema, r.json), what).toEqual([]);
  else {
    expect(violations(doc.components.schemas.Error, r.json), what).toEqual([]);
    expect(op['x-spw-errors'], what).toContainEqual({ status: r.status, code: r.json.error });
    expect(op.responses[String(r.status)].description, what).toContain(`\`${r.json.error}\``);
    seen.set(id, (seen.get(id) ?? new Set()).add(`${r.status} ${r.json.error}`));
  }
  return r;
}
const get = (id: string, path: string, key: string) => call('GET', T + path, { key }).then((r) => check(id, r));
const post = (id: string, path: string, key: string | null, body: unknown, headers: Record<string, string> = idem()) => call('POST', T + path, { ...(key ? { key } : {}), body, headers }).then((r) => check(id, r));

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spw-contract-'));
  signerSrv = createSignerServer(new Signer(deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), new Store(join(dir, 'state.json'), join(dir, 'policy.json')), { rpId: RP, origin: ORIGIN }), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  await useDatabase('trading_contract');
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
  const { adapters } = await import('../src/chains/index.ts');           // chain balances are scripted: the network is never contacted
  for (const a of Object.values(adapters) as any[]) a.balances = async () => ({ native: 1_500_000_000_000_000_000n });
  spec = await import('../src/trading-api/spec.ts'); read = await import('../src/trading-api/read.ts'); shaping = await import('../src/trading-api/shaping.ts');
  doc = (await import('../src/trading-api/openapi.ts')).buildOpenApi();
  const mod = await import('../src/derivatives/index.ts');
  clock = new Clock(); v = fixtureVenues(clock);
  setMarket(v, 50_000);
  app = await (await import('../src/server.ts')).buildServer({ derivatives: mod.createDerivatives({ registry: mod.createRegistry(v.adapters, clock.now), now: clock.now }), gmx: { status: async () => ({ network: 'arbitrum', account: null, positionsError: null, positions: [] }) } as never });
  const a = await call('POST', '/api/v1/derivatives/accounts', { body: { venue: 'hyperliquid', label: 'Contract', collateral: '10000' } });
  expect(a.status, JSON.stringify(a.json)).toBe(200);
  acct = a.json.id; ORDER.accountId = acct;
});
afterAll(async () => { app?.server.closeAllConnections?.(); await app?.close(); signerSrv?.close(); await sql?.end(); });

describe('the document and the code agree on the closed lists', () => {
  it('order states, final states, mandate deny reasons, risk checks, engine refusal codes and command codes are the packages\' own lists', () => {
    expect([...spec.ORDER_STATES]).toEqual([...MACHINE_STATES]);
    expect([...spec.FINAL_ORDER_STATES].sort()).toEqual([...TERMINAL_STATES].sort());
    expect([...spec.MANDATE_DENY_REASONS]).toEqual([...MANDATE_DENY_CODES]);
    expect([...spec.RISK_CHECK_IDS]).toEqual([...ENGINE_CHECK_IDS, 'context_complete']);
    expect([...spec.ENGINE_RISK_CODES]).toEqual([...RISK_CODES]);
    expect([...spec.COMMAND_UNRESOLVABLE_CODES]).toEqual([...UNRESOLVABLE_CODES]);
    for (const id of spec.ACCOUNT_RISK_CHECKS) expect(spec.RISK_CHECK_IDS as readonly string[], id).toContain(id);
    for (const c of shaping.ACCOUNT_ENGINE_CODES) expect(RISK_CODES as readonly string[], c).toContain(c);
    expect(doc['x-spw-order-states']).toEqual(MACHINE_STATES.map((state) => ({ state, final: TERMINAL_STATES.includes(state) })));
  });
  it('every operation: its responses are exactly 200 (when implemented) and the statuses of x-spw-errors, sorted and without duplicates', () => {
    for (const o of spec.OPERATIONS) {
      const op = opOf(o.id), errs = op['x-spw-errors'] as { status: number; code: string }[];
      expect(errs, o.id).toEqual(spec.errorsOf(o));
      expect(new Set(errs.map((e) => `${e.status} ${e.code}`)).size, o.id).toBe(errs.length);
      expect([...errs].sort((a, b) => a.status - b.status || (a.code < b.code ? -1 : 1)), o.id).toEqual(errs);
      expect(Object.keys(op.responses).sort(), o.id).toEqual([...(o.implemented ? ['200'] : []), ...new Set(errs.map((e) => String(e.status)))].sort());
      for (const e of errs) expect(op.responses[String(e.status)].description, `${o.id} ${e.status}`).toContain(`\`${e.code}\``);
      expect(errs, o.id).toContainEqual({ status: 401, code: 'unauthenticated' });
      if (!o.implemented) expect(errs, o.id).toContainEqual({ status: 501, code: 'execution_not_wired' });
      if (o.implemented && o.method !== 'GET') expect(op.responses['200'].content['application/json'].schema.type ?? op.responses['200'].content['application/json'].schema.$ref, `${o.id} has a success schema`).toBeTruthy();
    }
    const errs = (id: string) => opOf(id)['x-spw-errors'];
    expect(errs('listMarkets')).toContainEqual({ status: 404, code: 'unknown_venue' });
    expect(errs('getOrderbook')).toContainEqual({ status: 422, code: 'no_orderbook' });
    for (const code of ['execution_disabled', 'mandate_required', 'mandate_denied', 'key_limit_exceeded']) expect(errs('placeOrder'), code).toContainEqual({ status: 403, code });
    for (const code of ['idempotency_conflict', 'idempotency_in_progress']) expect(errs('placeOrder'), code).toContainEqual({ status: 409, code });
    for (const code of ['risk_denied', 'venue_rejected', 'spot_via_swap_screen', 'venue_not_wired']) expect(errs('placeOrder'), code).toContainEqual({ status: 422, code });
    for (const code of ['kill_switch_active', 'read_only_mode']) expect(errs('placeOrder'), code).toContainEqual({ status: 423, code });
    expect(opOf('placeOrder')['x-spw-errors-open']).toBe(true); expect(opOf('getMarket')['x-spw-errors-open']).toBeUndefined();
    // preview and the kill switch take no Idempotency-Key; every other implemented write requires one
    for (const id of ['previewOrder', 'engageKillSwitch']) expect(opOf(id).parameters.some((p: any) => p.name === 'Idempotency-Key'), id).toBe(false);
    for (const id of ['placeOrder', 'cancelOrder', 'closePosition', 'reducePosition', 'runCommand']) expect(opOf(id).parameters.find((p: any) => p.name === 'Idempotency-Key'), id).toMatchObject({ required: true });
  });
  it('the validator of this file refuses what the document does not describe', () => {
    const s = opOf('getBalances').responses['200'].content['application/json'].schema;
    expect(violations(s, { asOf: 'x', balances: [], errors: [], halted: null })).toEqual([]);
    expect(violations(s, { asOf: 'x', balances: [], errors: [], halted: null, extra: 1 })).toEqual(['$.extra: not declared (the object is closed)']);
    expect(violations(s, { asOf: 'x', balances: [], errors: [] })).toEqual(['$.halted: required']);
    expect(violations(doc.components.schemas.Order, { status: 'open' }).some((x) => x.includes('is not one of'))).toBe(true);
  });
});

describe('1, 2 — closed objects and money', () => {
  it('GET /balances and GET /portfolio send nothing the document does not declare; `halted` and `totals.note` are declared', async () => {
    const k = await newKey();
    const b = await get('getBalances', '/balances?network=base', k.secret);
    expect(b.status).toBe(200); expect(b.json.halted).toBe(false);
    const p = await get('getPortfolio', '/portfolio', k.secret);
    expect(p.status).toBe(200); expect(typeof p.json.totals.note).toBe('string'); expect(p.json.halted).toBe(false);
    const halted = opOf('getBalances').responses['200'].content['application/json'].schema.properties.halted;
    expect([violations(halted, null), violations(halted, true), violations(halted, 'no').length]).toEqual([[], [], 1]);
  });
  it('wallet.valueUsd, wallet.balances[].valueUsd and totals.walletUsd are decimal STRINGS, exact products and an exact sum', async () => {
    const reads = read.createReads({ derivatives: () => app.execution.orders.deps.derivatives(), live: () => app.execution.orders.deps.live(), gmx: () => ({ status: async () => ({ network: 'arbitrum', account: null, positionsError: null, positions: [] }) }) as never,
      orders: () => app.execution.orders, prices: async () => ({ ETH: { usd: 3000.1 }, BTC: { usd: 64000 }, POL: { usd: 1e-7 } }) });
    const p = await reads.portfolio({ kind: 'owner' } as never);
    expect(violations(opOf('getPortfolio').responses['200'].content['application/json'].schema, JSON.parse(JSON.stringify(p)))).toEqual([]);
    const priced = p.wallet.balances.filter((x) => x.valueUsd !== null);
    expect(priced.length).toBeGreaterThan(1);
    for (const x of priced) { expect(typeof x.valueUsd).toBe('string'); expect(x.valueUsd).toMatch(DEC); }
    expect(p.wallet.balances.find((x) => x.network === 'base' && x.symbol === 'ETH')!.valueUsd).toBe('4500.15');       // 1.5 × 3000.1, exactly
    expect(p.wallet.valueUsd).toMatch(DEC); expect(p.totals.walletUsd).toBe(p.wallet.valueUsd);
    const micro = (s: string): bigint => { const [i, f = ''] = s.split('.'); return BigInt(i! + f.padEnd(6, '0')); };
    expect(micro(p.wallet.valueUsd!)).toBe(priced.reduce((t, x) => t + micro(x.valueUsd!), 0n));
    expect(read.priceString(1e-7)).toBe('0.0000001'); expect(read.priceString(3000.1)).toBe('3000.1'); expect(read.priceString(Number.NaN)).toBeNull();
    expect(read.usdValue('0.1', '0.2')).toBe('0.02');                                                                    // not 0.020000000000000004
    // through HTTP (no price feed in this suite): null, never a number
    const h = await get('getPortfolio', '/portfolio', (await newKey()).secret);
    for (const x of [h.json.wallet.valueUsd, h.json.totals.walletUsd, ...h.json.wallet.balances.map((y: any) => y.valueUsd)]) expect(x === null || typeof x === 'string').toBe(true);
  });
});

describe('3, 4 — the error codes each operation really answers are declared', () => {
  it('422 no_orderbook, unsupported_interval; 404 unknown_venue, unknown_instrument, unknown_market, unknown_order, unknown_network; 409 ambiguous_symbol; 400', async () => {
    const k = (await newKey()).secret, codes = async (id: string, path: string) => { const r = await get(id, path, k); return [r.status, r.json.error]; };
    expect(await codes('getOrderbook', `/markets/${encodeURIComponent(GMX_BTC)}/orderbook`)).toEqual([422, 'no_orderbook']);
    expect(await codes('getMarket', '/markets/nowhere:XYZ')).toEqual([404, 'unknown_venue']);
    expect(await codes('getMarket', '/markets/hyperliquid:NOPE')).toEqual([404, 'unknown_instrument']);
    expect(await codes('getMarket', '/markets/ZZZZZZ')).toEqual([404, 'unknown_market']);
    expect(await codes('getMarket', '/markets/spot:ZZZZZZ')).toEqual([404, 'unknown_market']);
    expect(await codes('getOrderbook', '/markets/nowhere:XYZ/orderbook')).toEqual([404, 'unknown_venue']);
    expect(await codes('getCandles', '/markets/hyperliquid:NOPE/candles')).toEqual([404, 'unknown_instrument']);
    expect(await codes('listMarkets', '/markets?venue=nowhere')).toEqual([404, 'unknown_venue']);
    expect(await codes('listMarkets', '/markets?limit=0')).toEqual([400, 'bad_request']);
    expect(await codes('getOrder', '/orders/nope-nope-nope')).toEqual([404, 'unknown_order']);
    expect(await codes('getOrder', `/orders/agent:${randomUUID()}`)).toEqual([404, 'unknown_order']);
    expect(await codes('getBalances', '/balances?network=nope')).toEqual([404, 'unknown_network']);
    expect(await codes('compareMarkets', '/markets/compare?underlying=ZZZZ&side=long&notional=1000')).toEqual([404, 'unknown_underlying']);
    const amb = await get('getMarket', '/markets/BTC', k);
    expect([amb.status, amb.json.error]).toEqual([409, 'ambiguous_symbol']); expect(amb.json.candidates).toContain(BTC);
    const narrow = (await newKey({ scopes: ['markets:read'] })).secret;
    expect((await get('getPortfolio', '/portfolio', narrow)).json.error).toBe('insufficient_scope');
    expect((await check('getMarket', await call('GET', `${T}/markets/${BTC}`, { key: 'spw_live_spk_000000000000_' + 'A'.repeat(43) }))).json.error).toBe('unauthenticated');
    const restricted = (await newKey({ restrictions: { venues: ['gmx'] } })).secret;
    expect((await get('getMarket', `/markets/${BTC}`, restricted)).json.error).toBe('restricted');
    expect((await get('listMarkets', '/markets?venue=hyperliquid', restricted)).json.error).toBe('restricted');
  });
  it('the write side: mandate_required, idempotency, spot refusals, venue_not_wired, unknown_account, no_position, unknown_position, not_your_order, execution_disabled', async () => {
    await flatten();
    const k = await tradingKey(), unbound = await newKey();
    expect((await post('placeOrder', '/orders', unbound.secret, ORDER)).json.error).toBe('mandate_required');
    const upv = await post('previewOrder', '/orders/preview', unbound.secret, ORDER, {});
    expect([upv.status, upv.json.error]).toEqual([403, 'mandate_required']);                       // not 400 invalid_order about a mandateId the caller never sent
    expect((await post('closePosition', `/positions/paper:hyperliquid:${acct}:${BTC}/close`, unbound.secret, {})).json.error).toBe('mandate_required');
    expect((await post('placeOrder', '/orders', k.secret, ORDER, {})).json.error).toBe('idempotency');
    expect((await post('placeOrder', '/orders', k.secret, ORDER, { ...idem(), 'x-spw-timestamp': '1000000000' })).json.error).toBe('stale_request');
    expect((await post('placeOrder', '/orders', k.secret, { ...ORDER, instrument: 'spot:BTC' })).json.error).toBe('spot_execution_requires_agent_vault');
    const ownerSpot = await post('placeOrder', '/orders', null, { ...ORDER, instrument: 'spot:BTC' });
    expect([ownerSpot.status, ownerSpot.json.error]).toEqual([422, 'spot_via_swap_screen']);
    const gmx = await post('placeOrder', '/orders', null, { mode: 'live', instrument: GMX_BTC, side: 'buy', type: 'market', size: '0.01' });
    expect([gmx.status, gmx.json.error]).toEqual([422, 'venue_not_wired']);
    expect((await post('placeOrder', '/orders', k.secret, { ...ORDER, accountId: randomUUID() })).json.error).toBe('unknown_account');
    expect((await post('placeOrder', '/orders', k.secret, { ...ORDER, instrument: 'hyperliquid:NOPE' })).json.error).toBe('unknown_instrument');
    expect((await post('placeOrder', '/orders', k.secret, { ...ORDER, type: 'market', price: '50000' })).json.error).toBe('bad_request');
    const live = await post('placeOrder', '/orders', null, { mode: 'live', instrument: BTC, side: 'buy', type: 'market', size: '0.01' });
    expect([422, 403]).toContain(live.status);                                                    // no venue account here (`no_account`); with one: 403 execution_disabled (execution-live.test.ts)
    const np = await post('closePosition', `/positions/paper:hyperliquid:${acct}:hyperliquid:ETH/close`, null, {});
    expect([np.status, np.json.error]).toEqual([422, 'no_position']);
    expect((await post('reducePosition', '/positions/not-a-position/reduce', null, { fraction: '0.5' })).json.error).toBe('unknown_position');
    expect((await post('closePosition', '/positions/live:gmx:wallet:x/close', null, {})).json.error).toBe('close_in_app');
    const resting = await post('placeOrder', '/orders', k.secret, { ...ORDER, type: 'limit', price: '49500', size: '0.01' });
    expect(resting.status, JSON.stringify(resting.json)).toBe(200);
    const other = await tradingKey();
    const nyo = check('cancelOrder', await call('DELETE', `${T}/orders/${resting.json.order.id}`, { key: other.secret, headers: idem() }));
    expect([nyo.status, nyo.json.error]).toEqual([403, 'not_your_order']);
    expect(check('cancelOrder', await call('DELETE', `${T}/orders/nope-nope-nope`, { key: k.secret, headers: idem() })).json.error).toBe('unknown_order');
    expect(check('cancelOrder', await call('DELETE', `${T}/orders/${resting.json.order.id}`, { key: k.secret, headers: idem() })).json.order.status).toBe('CANCELLED');
    const nw = await post('createAgent', '/agents', null, { kind: 'perp', name: 'contract agent', universe: ['BTC'] });
    expect([nw.status, nw.json.error]).toEqual([501, 'execution_not_wired']);
    // out of mandate: 403 mandate_denied, the reasons from the closed list, the REJECTED order attached
    const md = await post('placeOrder', '/orders', k.secret, { ...ORDER, size: '0.05' });
    expect([md.status, md.json.error]).toEqual([403, 'mandate_denied']);
    expect(md.json.data.reasons).toContain('ORDER_NOTIONAL_EXCEEDED');
    for (const r of md.json.data.reasons) expect(spec.MANDATE_DENY_REASONS as readonly string[]).toContain(r);
    expect(md.json.data.order).toMatchObject({ status: 'REJECTED', final: true, rejectCode: 'mandate_denied' });
    // the same key with another body: 409, observable now that the first answer is stored
    const h = idem();
    expect((await post('placeOrder', '/orders', k.secret, ORDER, h)).status).toBe(200);
    const again = await post('placeOrder', '/orders', k.secret, ORDER, h);
    expect(again.status).toBe(200); expect(again.headers['idempotent-replay']).toBe('true');
    const conflict = await post('placeOrder', '/orders', k.secret, { ...ORDER, size: '0.011' }, h);
    expect([conflict.status, conflict.json.error]).toEqual([409, 'idempotency_conflict']);
  });
});

describe('5 — an unknown route under the prefix answers the API\'s error model', () => {
  it('unknown path, deeper path, a known path with another method: 404 { error: not_found, message } for a key and for the owner; 401 without credentials', async () => {
    const k = (await newKey({ scopes: ['markets:read'] })).secret;
    for (const [method, path] of [['GET', '/nope'], ['GET', '/orders/a/b/c'], ['POST', '/nope'], ['PUT', '/orders'], ['PATCH', '/markets'], ['DELETE', '/markets'], ['GET', '/']] as const) {
      const r = await call(method, T + path, { key: k, ...(method === 'GET' || method === 'DELETE' ? {} : { body: {} }) });
      expect([r.status, r.json], `${method} ${path}`).toEqual([404, { error: 'not_found', message: spec.NOT_FOUND.message }]);
      expect(violations(doc.components.schemas.Error, r.json)).toEqual([]);
      const o = await call(method, T + path, method === 'GET' || method === 'DELETE' ? {} : { body: {} });
      expect([o.status, o.json.error], `owner ${method} ${path}`).toEqual([404, 'not_found']);
    }
    const anon = await call('GET', `${T}/nope`, { cookie: null });
    expect([anon.status, anon.json.error]).toEqual([401, 'unauthenticated']);
    expect(doc['x-spw-not-found']).toEqual({ status: 404, error: 'not_found' });
    expect(process.env.SPW_WEB_DIR).toBeUndefined();          // this instance serves no web directory: the answer does not come from its not-found handler
    expect((await call('GET', `${T}/markets?limit=1`, { key: k })).status).toBe(200);               // the declared operations are untouched
  });
});

describe('6, 7, 9, 12 — the write side answers what the document declares', () => {
  it('preview → place → order → positions → reduce → close → resting limit → cancel, each answer validated; notional sized by the server', async () => {
    await flatten();
    const k = await tradingKey();
    const m = await get('getMarket', `/markets/${BTC}`, k.secret);
    expect(m.status).toBe(200);
    const inst = m.json.instrument;
    for (const f of ['lotSize', 'tickSize', 'maxLeverage']) expect(inst[f], f).toMatch(DEC);
    expect(inst).toMatchObject({ id: BTC, venue: 'hyperliquid', kind: 'perpetual', status: 'active' }); expect('minOrderSize' in inst && 'minNotional' in inst).toBe(true);
    const declared = opOf('getMarket').responses['200'].content['application/json'].schema.properties.instrument.anyOf.find((x: any) => x.type === 'object');
    expect(declared.required).toEqual(expect.arrayContaining(['lotSize', 'tickSize', 'minOrderSize', 'minNotional', 'maxLeverage', 'status'])); expect(Object.keys(declared.properties)).toContain('category');

    const pv = await post('previewOrder', '/orders/preview', k.secret, ORDER, {});
    expect(pv.status, JSON.stringify(pv.json)).toBe(200);
    expect(pv.json).toMatchObject({ wouldExecute: true, refusals: [], account: { id: acct, withheld: false } });
    expect(pv.json.account.equity).toMatch(DEC); expect(pv.json.account.freeCollateral).toMatch(DEC);

    // `notional`: the server divides by the mark read now (50 000) and rounds DOWN to the lot
    const lot = Number(inst.lotSize);
    const pn = await post('previewOrder', '/orders/preview', k.secret, { ...ORDER, size: undefined, notional: '777' }, {});
    expect(pn.status, JSON.stringify(pn.json)).toBe(200);
    const sized = Number(pn.json.order.size);
    expect(pn.json.order.size).toBe(pn.json.resolved.size); expect(pn.json.order.notional).toBeNull();
    expect(sized * 50_000).toBeLessThanOrEqual(777); expect((sized + lot) * 50_000).toBeGreaterThan(777);
    expect(pn.json.order.size).toBe(shaping.sizeFromNotional('777', '50000', inst.lotSize));
    const pl = await post('previewOrder', '/orders/preview', k.secret, { ...ORDER, size: undefined, type: 'limit', price: '40000', notional: '800' }, {});
    expect(pl.json.order.size).toBe('0.02');                                                       // a limit order: its own price is the reference
    expect((await post('previewOrder', '/orders/preview', k.secret, { ...ORDER, notional: '100' }, {})).status).toBe(400);       // both
    expect((await post('previewOrder', '/orders/preview', k.secret, { ...ORDER, size: undefined }, {})).status).toBe(400);       // neither
    const tiny = await post('previewOrder', '/orders/preview', k.secret, { ...ORDER, size: undefined, notional: '0.0001' }, {});
    expect([tiny.status, tiny.json.error]).toEqual([422, 'below_min_size']);
    expect((await post('previewOrder', '/orders/preview', k.secret, { ...ORDER, size: undefined, type: 'limit', notional: '100' }, {})).json.error).toBe('invalid_order');
    v.hl.down = true; clock.advance(120_000);
    const stale = await post('previewOrder', '/orders/preview', k.secret, { ...ORDER, size: undefined, notional: '777' }, {});
    expect(stale.status, JSON.stringify(stale.json)).toBe(503);                                    // a stale or unreadable mark is never used to size an order
    v.hl.down = false; clock.advance(120_000); setMarket(v, 50_000);                               // past the data service's failure back-off

    const o = await post('placeOrder', '/orders', k.secret, { ...ORDER, size: undefined, notional: '777' });
    expect(o.status, JSON.stringify(o.json)).toBe(200);
    expect(o.json).toMatchObject({ idempotent: false, approval: null, order: { status: 'FILLED', final: true, engineStatus: 'filled', size: pn.json.order.size, filled: pn.json.order.size, mode: 'paper' } });
    const id = o.json.order.id as string;
    const g = await get('getOrder', `/orders/${id}`, k.secret);
    expect(g.json.order).toMatchObject({ id, status: 'FILLED', final: true }); expect(g.json.fills.length).toBeGreaterThan(0); expect(g.json.history.length).toBeGreaterThan(2);
    const pos = (await call('GET', `${T}/positions?mode=paper`, { key: k.secret })).json.positions.find((x: any) => x.instrument === BTC);
    expect(pos).toBeTruthy();
    const rd = await post('reducePosition', `/positions/${encodeURIComponent(pos.id)}/reduce`, k.secret, { fraction: '0.5' });
    expect(rd.status, JSON.stringify(rd.json)).toBe(200); expect(rd.json.order).toMatchObject({ status: 'FILLED', reduceOnly: true, side: 'sell' });
    const cl = await post('closePosition', `/positions/${encodeURIComponent(pos.id)}/close`, k.secret, {});
    expect(cl.status, JSON.stringify(cl.json)).toBe(200); expect(cl.json.order).toMatchObject({ status: 'FILLED', reduceOnly: true });
    const rest = await post('placeOrder', '/orders', k.secret, { ...ORDER, type: 'limit', price: '49500' });
    expect(rest.json.order).toMatchObject({ status: 'SUBMITTED', final: false, engineStatus: 'open' });
    const cx = check('cancelOrder', await call('DELETE', `${T}/orders/${rest.json.order.id}`, { key: k.secret, headers: idem() }));
    expect(cx.json).toMatchObject({ changed: true, order: { status: 'CANCELLED', final: true } });
    const cx2 = check('cancelOrder', await call('DELETE', `${T}/orders/${rest.json.order.id}`, { key: k.secret, headers: idem() }));
    expect(cx2.json).toMatchObject({ changed: false, sent: false });
  });
  it('12 — a preview tells a key without wallet:read / positions:read nothing about the account', async () => {
    await flatten();
    const prepOnly = await tradingKey({ scopes: ['orders:prepare', 'markets:read'] });
    const withPos = await tradingKey({ scopes: ['orders:prepare', 'positions:read'] });
    const big = { ...ORDER, size: '5' };                                                           // 250 000 USD on a 10 000 USD account: the account checks fail
    const a = await post('previewOrder', '/orders/preview', prepOnly.secret, big, {}), b = await post('previewOrder', '/orders/preview', withPos.secret, big, {});
    expect(a.status, JSON.stringify(a.json)).toBe(200); expect(b.status).toBe(200);
    expect(b.json.account).toMatchObject({ withheld: false }); expect(b.json.account.equity).toMatch(DEC); expect(b.json.risk.derived.positionBefore).toMatch(DEC);
    expect(a.json.account).toEqual({ id: acct, venue: 'hyperliquid', network: b.json.account.network, withheld: true });
    expect('positionBefore' in a.json.risk.derived || 'positionAfter' in a.json.risk.derived).toBe(false);
    expect(a.json.risk.derived.size).toBe('5');                                                    // the order's own figures stay
    expect(a.json.wouldExecute).toBe(false); expect(a.json.refusals.map((r: any) => r.code)).toEqual(b.json.refusals.map((r: any) => r.code));     // the verdict is the same
    for (const c of a.json.risk.checks) if (spec.ACCOUNT_RISK_CHECKS.includes(c.id)) expect([c.observed, c.detail], c.id).toEqual([null, shaping.WITHHELD]);
    expect(a.json.risk.checks.map((c: any) => [c.id, c.ok])).toEqual(b.json.risk.checks.map((c: any) => [c.id, c.ok]));
    if (a.json.engine.estimate) for (const f of ['freeCollateralAfter', 'liquidationPrice']) expect(f in a.json.engine.estimate, f).toBe(false);
    // the sentences that quote the account's figures to the other key appear nowhere in this answer
    const flat = JSON.stringify(a.json);
    expect(b.json.risk.checks.some((c: any) => spec.ACCOUNT_RISK_CHECKS.includes(c.id) && c.observed !== null)).toBe(true);
    for (const c of b.json.risk.checks) if (spec.ACCOUNT_RISK_CHECKS.includes(c.id) && c.detail.length > 12) expect(flat, c.id).not.toContain(c.detail);
    // the owner session always reads its own account
    expect((await post('previewOrder', '/orders/preview', null, ORDER, {})).json.account.withheld).toBe(false);
  });
  it('12 (unit) — shapePreview withholds exactly the account figures and nothing for a principal that may read them', () => {
    const out = { refusals: [{ stage: 'risk', code: 'risk_denied', message: 'gross_exposure: 250000 above 30000' }, { stage: 'risk', code: 'risk_denied', message: 'order_notional: 250000 above 100000' },
      { stage: 'engine', code: 'insufficient_collateral', message: 'needs 83333, free 10000' }, { stage: 'engine', code: 'price_not_on_tick', message: 'tick 0.5' }],
    risk: { checks: [{ id: 'gross_exposure', ok: false, observed: '250000', limit: '30000', detail: 'd1' }, { id: 'order_notional', ok: false, observed: '250000', limit: '100000', detail: 'd2' }], derived: { size: '5', positionBefore: '1', positionAfter: '6' } },
    engine: { name: 'paper', risk: { ok: false, code: 'insufficient_collateral', reason: 'needs 83333, free 10000' }, estimate: { fee: '1', freeCollateralAfter: '9', liquidationPrice: { value: '1' }, rejectReason: 'free 10000' } },
    account: { id: 'a', venue: 'v', network: 'n', equity: '10000', freeCollateral: '9000' } };
    const key = (scopes: string[]) => ({ kind: 'api_key', scopes }) as never;
    expect(shaping.shapePreview({ kind: 'owner' } as never, out)).toEqual({ ...out, account: { ...out.account, withheld: false } });
    for (const s of ['wallet:read', 'positions:read']) expect(shaping.shapePreview(key(['orders:prepare', s]), out).account).toMatchObject({ equity: '10000', withheld: false });
    const h = shaping.shapePreview(key(['orders:prepare', 'markets:read', 'orders:read']), out);
    expect(h.account).toEqual({ id: 'a', venue: 'v', network: 'n', withheld: true });
    expect(h.risk.derived).toEqual({ size: '5' });
    expect(h.risk.checks).toEqual([{ id: 'gross_exposure', ok: false, observed: null, limit: '30000', detail: shaping.WITHHELD }, out.risk.checks[1]]);
    expect(h.refusals.map((r) => r.message)).toEqual([`gross_exposure: ${shaping.WITHHELD}`, 'order_notional: 250000 above 100000', shaping.WITHHELD, 'tick 0.5']);
    expect(h.engine).toEqual({ name: 'paper', risk: { ok: false, code: 'insufficient_collateral', reason: shaping.WITHHELD }, estimate: { fee: '1', rejectReason: shaping.WITHHELD } });
    expect(JSON.stringify(h)).not.toMatch(/10000"|9000"|83333/);
  });
  it('commands: an ambiguous command answers 409 with the questions; dry runs and queries validate; the kill switch blocks new risk, not exits', async () => {
    await flatten();
    const k = await tradingKey();
    expect((await call('PUT', `${DEV}/command-defaults`, { body: { defaults: {} } })).status).toBe(200);
    const cmd = (text: string, o: Record<string, unknown> = {}, key: string | null = k.secret) => post('runCommand', '/commands', key, { text, mode: 'paper', accountId: acct, ...o });
    const amb = await cmd('LONG BTC-PERP 500', { dryRun: true });
    expect([amb.status, amb.json.error]).toEqual([409, 'ambiguous_command']);
    expect(amb.json.data.questions.length).toBeGreaterThan(0); for (const q of amb.json.data.questions) expect(q).toMatchObject({ field: expect.any(String), options: expect.any(Array), message: expect.any(String) });
    expect((await cmd('FROBNICATE THE MARKET')).json.error).toBe('parse_error');
    expect((await call('PUT', `${DEV}/command-defaults`, { body: { defaults: { perpVenue: 'hyperliquid', perpNetworkByVenue: { hyperliquid: 'mainnet' }, perpLeverage: '2', perpMarginMode: 'cross', maxFeeBps: 10, maxSlippageBps: 50, orderTtlMs: 60_000 } } })).status).toBe(200);
    const dry = await cmd('LONG BTC-PERP 500', { dryRun: true });
    expect(dry.status, JSON.stringify(dry.json)).toBe(200);
    expect(dry.json).toMatchObject({ kind: 'order', dryRun: true, executed: false, order: { instrument: BTC, side: 'buy' } }); expect(dry.json.hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await call('GET', `${T}/orders?limit=1`, { key: k.secret })).json.orders.every((o: any) => o.origin !== 'command')).toBe(true);       // a dry run placed nothing
    const run = await cmd('LONG BTC-PERP 500');
    expect(run.status, JSON.stringify(run.json)).toBe(200);
    expect(run.json).toMatchObject({ kind: 'order', executed: true, order: { status: 'FILLED', final: true, origin: 'command' } });
    expect((await cmd('SHOW POSITIONS')).json).toMatchObject({ kind: 'query', query: 'positions' });
    expect((await cmd('SHOW ORDERS')).json.kind).toBe('query');
    expect((await cmd(`CANCEL ORDER ${run.json.order.id}`, { dryRun: true })).json).toMatchObject({ kind: 'control', control: { type: 'cancel_order' }, executed: false });
    expect((await cmd('KILL', { dryRun: true })).json).toMatchObject({ kind: 'control', control: { type: 'kill_switch_on' }, executed: false });
    const stop = await cmd('STOP ALL AGENTS');
    expect([501, 403]).toContain(stop.status);
    const reader = await newKey({ scopes: ['orders:prepare', 'markets:read'] });
    expect((await cmd('LONG BTC-PERP 500', {}, reader.secret)).json.error).toBe('insufficient_scope');

    // the kill switch, engaged by a key (no Idempotency-Key, no mandate needed)
    const ks = check('engageKillSwitch', await call('POST', `${T}/risk/kill-switch`, { key: k.secret, body: { reason: 'contract test' } }));
    expect(ks.status).toBe(200); expect(ks.json.killSwitch).toMatchObject({ on: true, reason: 'contract test', by: { kind: 'api_key', id: k.id } });
    const risk = await get('getRisk', '/risk', k.secret);
    expect(risk.json.engine.killSwitch.on).toBe(true);
    const blocked = await post('placeOrder', '/orders', k.secret, ORDER);
    expect([blocked.status, blocked.json.error]).toEqual([423, 'kill_switch_active']);
    expect(blocked.json.data.failed).toContain('kill_switch'); expect(blocked.json.data.order).toMatchObject({ status: 'REJECTED', final: true });
    for (const c of blocked.json.data.checks) expect(spec.RISK_CHECK_IDS as readonly string[]).toContain(c.id);
    const pos = (await call('GET', `${T}/positions?mode=paper`, { key: k.secret })).json.positions.find((x: any) => x.instrument === BTC);
    const exit = await post('closePosition', `/positions/${encodeURIComponent(pos.id)}/close`, k.secret, {});
    expect(exit.status, JSON.stringify(exit.json)).toBe(200); expect(exit.json.order.status).toBe('FILLED');           // an exit still passes
    const p = await call('POST', '/api/v1/risk/kill-switch/release/prepare');
    expect((await call('POST', '/api/v1/risk/kill-switch/release', { body: p.json.needed ? { assertion: assertion(p.json.options) } : {} })).status).toBe(200);
    expect((await post('placeOrder', '/orders', k.secret, ORDER)).status).toBe(200);
  });
});

describe('7 — order states', () => {
  it('every order row carries one of the twelve states, the engine\'s word and a boolean `final`; agent swaps are projected truthfully', async () => {
    const agentId = randomUUID();
    await sql`insert into agents (id, name, universe, risk, vault_index, vault_address, state, mode) values (${agentId}, 'Contract agent', ${sql.json(['BTC'])}, ${sql.json({})}, 9301, '0x0', 'PAPER_TRADING', 'PAPER')`;
    const swaps: [string, string | null, string, boolean][] = [['prepared', null, 'VALIDATED', false], ['signed', null, 'APPROVED', false], ['broadcast', null, 'SUBMITTED', false], ['filled', null, 'FILLED', true],
      ['failed', 'the swap reverted on-chain; only the network fee was spent', 'FAILED', true], ['failed', 'refused by the signer: over the daily limit', 'REJECTED', true], ['skipped', null, 'CANCELLED', true], ['a_new_word', null, 'UNKNOWN', false]];
    const ids: string[] = [];
    for (const [i, [state, reason]] of swaps.entries()) {
      const id = randomUUID(); ids.push(id);
      await sql`insert into agent_orders (id, agent_id, ts, mode, from_asset, to_asset, from_symbol, to_symbol, amount_in, state, reason) values (${id}, ${agentId}, ${new Date(clock.now() - 86_400_000 - i * 1000)}, ${i % 2 ? 'LIVE' : 'PAPER'}, 'usdc', 'native', 'USDC', 'ETH', 1000000, ${state}, ${reason})`;
    }
    const k = (await newKey()).secret;
    const all = await get('listOrders', '/orders?limit=500', k);
    expect(all.status).toBe(200);
    for (const o of all.json.orders) { expect(spec.ORDER_STATES as readonly string[], o.id).toContain(o.status); expect(o.final, o.id).toBe(TERMINAL_STATES.includes(o.status)); expect('engineStatus' in o).toBe(true); }
    expect(all.json.orders.some((o: any) => !o.id.startsWith('agent:') && o.engineStatus === 'filled' && o.status === 'FILLED')).toBe(true);
    for (const [i, [state, , status, final]] of swaps.entries()) {
      const row = all.json.orders.find((o: any) => o.id === `agent:${ids[i]}`);
      expect(row, state).toMatchObject({ status, final, engineStatus: state, venue: 'spot', type: 'swap' });
      expect((await get('getOrder', `/orders/agent:${ids[i]}`, k)).json.order).toMatchObject({ status, final, engineStatus: state });
    }
    const open = await get('listOrders', '/orders?open=true&venue=spot', k), closed = await get('listOrders', '/orders?open=false&venue=spot', k);
    expect(open.json.orders.map((o: any) => o.engineStatus).sort()).toEqual(['a_new_word', 'broadcast', 'prepared', 'signed']);
    expect(closed.json.orders.every((o: any) => o.final === true)).toBe(true); expect(closed.json.orders).toHaveLength(4);
    expect((await get('listOrders', '/orders?open=true&limit=500', k)).json.orders.every((o: any) => o.final === false)).toBe(true);
    expect(read.agentSwapStatus('failed', null)).toBe('FAILED');
  });
});

describe('8 — a key is bound only to a mandate approved for it', () => {
  it('create, update and rotate verify the binding; a key bound to nothing reaches mandate_required', async () => {
    await flatten();
    const other = await newKey(), k = await tradingKey();
    const prep = (body: Record<string, unknown>) => call('POST', `${DEV}/keys/prepare`, { body: { name: 'x', scopes: ALL, expiresInDays: 30, ...body } });
    const ghost = await prep({ mandateId: randomUUID() });
    expect([ghost.status, ghost.json.error]).toEqual([422, 'mandate_not_found']);
    expect((await prep({ mandateId: k.mandateId })).json.error).toBe('mandate_principal_mismatch');                 // approved for another key
    const created = await call('POST', '/api/v1/mandates', { body: { ...MANDATE, principal: { kind: 'api_key', id: other.id }, accountIds: [acct] } });
    const upd = (id: string, mandateId: string) => call('POST', `${DEV}/keys/${id}/update/prepare`, { body: { changes: { mandateId } } });
    expect((await upd(other.id, created.json.mandate.id)).json.error).toBe('mandate_not_active');                   // exists, never approved
    expect((await upd(other.id, k.mandateId)).json.error).toBe('mandate_principal_mismatch');
    expect((await upd(other.id, randomUUID())).json.error).toBe('mandate_not_found');
    // approved, then revoked between the prepare and the approval: the binding is verified again when it is applied
    expect((await call('POST', `/api/v1/mandates/${created.json.mandate.id}/approve`, { body: {} })).status).toBe(200);
    const p = await upd(other.id, created.json.mandate.id);
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect((await call('POST', `/api/v1/mandates/${created.json.mandate.id}/revoke`, { body: {} })).status).toBe(200);
    const late = await call('POST', `${DEV}/keys/${other.id}/update`, { body: { intentId: p.json.intentId, assertion: assertion(p.json.options) } });
    expect([late.status, late.json.error]).toEqual([422, 'mandate_not_active']);
    expect((await sql`select mandate_id from api_keys where id = ${other.id}`)[0].mandate_id).toBeNull();
    expect((await post('placeOrder', '/orders', other.secret, ORDER)).json.error).toBe('mandate_required');
    expect((await sql`select count(*)::int as n from orders where principal_id = ${other.id}`)[0].n).toBe(0);

    // rotation: the mandate names the OLD key id — it is not carried to the new id, and the new key can place nothing
    expect((await post('placeOrder', '/orders', k.secret, ORDER)).status).toBe(200);
    const rp = await call('POST', `${DEV}/keys/${k.id}/rotate/prepare`, { body: {} });
    const r = await call('POST', `${DEV}/keys/${k.id}/rotate`, { body: { intentId: rp.json.intentId, assertion: assertion(rp.json.options) } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.key).toMatchObject({ mandateId: null, rotatedFrom: k.id }); expect(r.json.key.inertScopes).toContain('orders:execute');
    expect(r.json.mandate).toMatchObject({ carried: false, mandateId: k.mandateId, code: 'mandate_principal_mismatch' });
    const after = await post('placeOrder', '/orders', r.json.secret, ORDER);
    expect([after.status, after.json.error]).toEqual([403, 'mandate_required']);
    expect((await call('GET', `${T}/agents`, { key: k.secret })).status).toBe(401);                                    // the old key is dead
    const plain = await newKey({ scopes: ['markets:read'] });
    const rp2 = await call('POST', `${DEV}/keys/${plain.id}/rotate/prepare`, { body: {} });
    expect((await call('POST', `${DEV}/keys/${plain.id}/rotate`, { body: { intentId: rp2.json.intentId, assertion: assertion(rp2.json.options) } })).json.mandate).toBeNull();
    // no api key row points at a mandate that is not its own, approved and active
    const bad = await sql`select k.id from api_keys k left join trading_mandates m on m.id = k.mandate_id where k.mandate_id is not null and k.revoked_at is null and (m.id is null or m.principal_id <> k.id or m.state <> 'active')`;
    expect(bad).toEqual([]);
  });
});

describe('11 — cursor pagination', () => {
  it('GET /orders: pages of 3 over the whole list — unified orders and agent swaps, many with the same timestamp — are the unpaged list, once each', async () => {
    const k = (await newKey()).secret;
    const full = (await get('listOrders', '/orders?limit=500', k)).json;
    expect(full.nextCursor).toBeNull(); expect(full.orders.length).toBeGreaterThan(12);
    expect(new Set(full.orders.map((o: any) => o.createdAt)).size).toBeLessThan(full.orders.length);          // ties on the timestamp: the id breaks them
    for (const filter of ['', '&mode=paper', '&open=false', '&venue=spot', '&venue=hyperliquid']) {
      const want = (await get('listOrders', `/orders?limit=500${filter}`, k)).json.orders.map((o: any) => o.id);
      const got: string[] = []; let cursor: string | null = null, pages = 0;
      do {
        const r: Res = await get('listOrders', `/orders?limit=3${filter}${cursor ? `&cursor=${cursor}` : ''}`, k);
        expect(r.status, JSON.stringify(r.json)).toBe(200);
        expect(r.json.orders.length).toBeLessThanOrEqual(3); if (r.json.nextCursor !== null) expect(r.json.orders).toHaveLength(3);
        got.push(...r.json.orders.map((o: any) => o.id)); cursor = r.json.nextCursor; pages += 1;
      } while (cursor !== null && pages < 200);
      expect(got, filter).toEqual(want); expect(new Set(got).size, filter).toBe(got.length);
    }
    // an order created after the first page is not inserted into the following pages
    const first = (await get('listOrders', '/orders?limit=3', k)).json;
    clock.advance(120_000); setMarket(v, 50_000);                                                  // out of the paper account's orders-per-minute window
    await flatten();
    const tk = await tradingKey(), placed = await post('placeOrder', '/orders', tk.secret, ORDER);
    expect(placed.status, JSON.stringify(placed.json).slice(0, 400)).toBe(200);
    const second = (await get('listOrders', `/orders?limit=3&cursor=${first.nextCursor}`, k)).json;
    expect(second.orders.map((o: any) => o.id)).toEqual(full.orders.slice(3, 6).map((o: any) => o.id));
    // a key restricted to another venue: full pages of what it may see, never a short page caused by hidden rows
    const spotOnly = (await newKey({ restrictions: { venues: ['spot'] } })).secret;
    const sp = (await get('listOrders', '/orders?limit=3', spotOnly)).json;
    expect(sp.orders).toHaveLength(3); expect(sp.orders.every((o: any) => o.venue === 'spot')).toBe(true); expect(sp.nextCursor).not.toBeNull();
    for (const bad of ['AAAA', 'not-base64-json', Buffer.from(JSON.stringify(['1', 'z', 'x'])).toString('base64url'), Buffer.from(JSON.stringify(['x', 'o', 'x'])).toString('base64url')]) {
      const r = await get('listOrders', `/orders?cursor=${bad}`, k);
      expect([r.status, r.json.error], bad).toEqual([400, 'invalid_cursor']);
    }
    expect((await get('listOrders', '/orders?cursor=%20', k)).status).toBe(400);
  });
  it('GET /activity: fills page by page, in one stable order', async () => {
    const k = (await newKey()).secret;
    const full = (await get('getActivity', '/activity?limit=500', k)).json;
    expect(full.nextCursor).toBeNull(); expect(full.items.length).toBeGreaterThan(5); expect(full.items.every((x: any) => x.kind === 'fill' && x.mode === 'paper')).toBe(true);
    const got: string[] = []; let cursor: string | null = null, pages = 0;
    do {
      const r: Res = await get('getActivity', `/activity?limit=2${cursor ? `&cursor=${cursor}` : ''}`, k);
      expect(r.status).toBe(200); got.push(...r.json.items.map((x: any) => x.id)); cursor = r.json.nextCursor; pages += 1;
    } while (cursor !== null && pages < 200);
    expect(got).toEqual(full.items.map((x: any) => x.id)); expect(new Set(got).size).toBe(got.length);
    expect((await get('getActivity', '/activity?cursor=AAAA', k)).json.error).toBe('invalid_cursor');
    // a cursor of the other list is not accepted
    const oc = (await get('listOrders', '/orders?limit=1', k)).json.nextCursor;
    expect((await get('getActivity', `/activity?cursor=${oc}`, k)).json.error).toBe('invalid_cursor');
  });
  it('cursor helpers: a total order, and a round trip', () => {
    const a = { us: '1794790800000000', tag: 'o', id: 'b' }, rows = [a, { ...a, id: 'a' }, { ...a, tag: 'a', id: 'z' }, { ...a, us: '1794790800000001', tag: 'a', id: 'a' }];
    expect([...rows].sort(read.cursorOrder).map((x) => `${x.us.slice(-1)}${x.tag}${x.id}`)).toEqual(['1aa', '0ob', '0oa', '0az']);
    expect(read.decodeCursor(read.encodeCursor(a), ['o', 'a'])).toEqual(a);
    expect(read.decodeCursor(undefined, ['o'])).toBeNull();
    expect(() => read.decodeCursor(read.encodeCursor(a), ['p'])).toThrow(/cursor/);
  });
});

describe('what this file observed', () => {
  it('error answers of at least 40 distinct (operation, status, code) were validated against x-spw-errors', () => {
    const n = [...seen.values()].reduce((t, s) => t + s.size, 0);
    if (process.env.SPW_CONTRACT_TRANSCRIPT) console.log([...seen].map(([id, s]) => `${id}: ${[...s].sort().join(', ')}`).sort().join('\n'));
    expect(n).toBeGreaterThanOrEqual(40);
  });
});
