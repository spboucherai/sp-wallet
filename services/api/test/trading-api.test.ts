// SP Trading API (V11) through the real server: API keys (passkey-approved creation, hash-only storage, expiry, revocation,
// rotation, widening), the principal and the default-deny guard (EVERY route of the application outside /api/v1/trading/ refuses a
// valid key), scopes, restrictions, rate limits, failed-auth throttling, the usage log, replay protection, the read side on
// fixture-backed venues + a real signer process + the paper engine, the 501 write surface, webhooks, and the OpenAPI document.
// Own database; no network (venues replay recorded answers, chain balances are scripted, webhooks go to a local receiver).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { createSignerServer } from '../../isolated-signer/src/server.ts';
import { Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';
import { BTC, Clock, GMX_BTC, fixtureVenues, setMarket, useDatabase, type Venues } from './derivatives-helpers.ts';

const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'k'.repeat(48), T = '/api/v1/trading', DEV = '/api/v1/developer';
const owner = new TestPasskey(RP, ORIGIN), attacker = new TestPasskey(RP, ORIGIN);
const ALL = ['wallet:read', 'markets:read', 'orders:read', 'orders:prepare', 'orders:execute', 'orders:cancel', 'positions:read', 'positions:manage', 'strategies:read', 'strategies:manage', 'agents:read', 'agents:manage'];
const READS = ALL.filter((s) => s.endsWith(':read'));
let app: any, sql: any, cookie = '', clock: Clock, v: Venues, signerSrv: Server, hookSrv: Server, hookUrl = '';
let principal: typeof import('../src/trading-api/principal.ts'), hooks: typeof import('../src/trading-api/webhooks.ts'), spec: typeof import('../src/trading-api/spec.ts');
const received: { headers: Record<string, string>; body: string }[] = [];
let hookStatus = 200, hookNow = Date.now();
const gmxFake = { calls: 0, status: async () => { gmxFake.calls += 1; return { network: 'arbitrum', account: { address: '0x00000000000000000000000000000000000000aa' }, positionsError: null,
  positions: [{ key: '0xkey1', instrument: GMX_BTC, side: 'long', sizeTokens: '0.5', entryPrice: '60000', markPrice: '61000', liquidationPrice: '50000', leverage: '3', collateral: '10000', pnlUsd: '500', source: 'chain' }] }; } };

let ipSeq = 0;
interface Res { status: number; json: any; headers: Record<string, any> }
async function call(method: string, path: string, o: { key?: string | null; cookie?: string | null; body?: unknown; headers?: Record<string, string>; ip?: string; csrf?: boolean } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...o.headers };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  const c = o.cookie === undefined ? (o.key ? null : cookie) : o.cookie;
  if (c) headers.cookie = c;
  if (c && method !== 'GET' && o.csrf !== false) { headers.origin = ORIGIN; headers['x-spw-csrf'] = '1'; }
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  // the key-management routes are limited to 10 calls a minute per address (like the login routes): each owner call of this suite comes from its own address
  const ip = o.ip ?? (path.startsWith(DEV) ? `10.200.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}` : undefined);
  const r = await app.inject({ method, url: path, headers, payload: o.body === undefined ? undefined : JSON.stringify(o.body), ...(ip ? { remoteAddress: ip } : {}) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), headers: r.headers };
}
const idem = () => ({ 'idempotency-key': `test-${randomUUID()}` });
const assertion = (options: { challenge: string }, who = owner) => who.assert(Buffer.from(options.challenge, 'base64url'));
async function newKey(body: Record<string, unknown> = {}): Promise<{ id: string; secret: string; view: any }> {
  const p = await call('POST', `${DEV}/keys/prepare`, { body: { name: 'test key', scopes: READS, expiresInDays: 30, ...body } });
  expect(p.status, JSON.stringify(p.json)).toBe(200);
  const c = await call('POST', `${DEV}/keys`, { body: { intentId: p.json.intentId, assertion: assertion(p.json.options) } });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  return { id: c.json.key.id, secret: c.json.secret, view: c.json.key };
}
const audits = (type: string) => sql`select * from audit_events where type = ${type} order by seq` as Promise<any[]>;

/** every (method, path) registered on the Fastify instance, from its route tree */
function allRoutes(): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [], stack: string[] = [];
  for (const line of (app.printRoutes({ commonPrefix: false }) as string).split('\n')) {
    const m = /^([│ ]*)[├└]── (.*?)(?: \(([A-Z, ]+)\))?$/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    stack[depth] = m[2]!;
    if (m[3]) for (const method of m[3].split(', ')) if (method !== 'HEAD') out.push({ method, path: stack.join('') });
  }
  return out;
}
const concrete = (path: string): string => path.replace(/:(id|sid|wid|opId|actionId|jobId)\b/g, '00000000-0000-4000-8000-000000000000').replace(/:symbol\b/g, 'BTC').replace(/:[A-Za-z]+/g, 'abcdefgh12').replace(/\*$/, 'x');

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spw-trading-api-'));
  signerSrv = createSignerServer(new Signer(deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), new Store(join(dir, 'state.json'), join(dir, 'policy.json')), { rpId: RP, origin: ORIGIN }), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  hookSrv = createServer((req, res) => { let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => { received.push({ headers: req.headers as Record<string, string>, body }); res.statusCode = hookStatus; res.end('ok'); }); }).listen(0, '127.0.0.1');
  await new Promise((r) => hookSrv.once('listening', r));
  hookUrl = `http://127.0.0.1:${(hookSrv.address() as { port: number }).port}/hook`;
  await useDatabase('trading_api');
  Object.assign(process.env, { SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`, SPW_DATA_DIR: join(dir, 'data') });
  delete process.env.SPW_API_KEY_PEPPER;
  const db = await import('../src/db.ts');
  sql = db.sql;
  await db.migrate();
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
  cookie = `${(await import('../src/auth.ts')).COOKIE}=${token}`;
  const c = owner.credential();
  await sql`insert into credentials (id, public_key, counter, transports, label) values (${c.id}, ${c.publicKey}, 0, ${sql.json(c.transports)}, 'test passkey')`;
  // chain balances are scripted: the network is never contacted
  const { adapters } = await import('../src/chains/index.ts');
  for (const a of Object.values(adapters) as any[]) a.balances = async () => ({ native: 1_000_000_000_000_000_000n });
  (adapters.solana as any).balances = async () => { throw new Error('rpc down (scripted)'); };
  principal = await import('../src/trading-api/principal.ts'); hooks = await import('../src/trading-api/webhooks.ts'); spec = await import('../src/trading-api/spec.ts');
  hooks.configureWebhooks({ allowHttp: true, now: () => hookNow });
  const mod = await import('../src/derivatives/index.ts');
  clock = new Clock(); v = fixtureVenues(clock);
  app = await (await import('../src/server.ts')).buildServer({ derivatives: mod.createDerivatives({ registry: mod.createRegistry(v.adapters, clock.now), now: clock.now }), gmx: gmxFake as never });
});
afterAll(async () => { app?.server.closeAllConnections?.(); await app?.close(); signerSrv?.close(); hookSrv?.close(); await sql?.end(); });

describe('API keys', () => {
  it('key management needs the owner session; creation needs a passkey assertion over the canonical intent', async () => {
    for (const [m, p] of [['GET', '/keys'], ['POST', '/keys/prepare'], ['POST', '/keys'], ['GET', '/usage'], ['GET', '/status'], ['GET', '/webhooks'], ['POST', '/webhooks']] as const)
      expect((await call(m, DEV + p, { cookie: null, ...(m === 'POST' ? { body: {}, headers: { origin: ORIGIN, 'x-spw-csrf': '1' } } : {}) })).status, p).toBe(401);
    expect((await call('POST', `${DEV}/keys/prepare`, { body: { name: 'x', scopes: READS, expiresInDays: 30 }, csrf: false })).status).toBe(403);
    for (const bad of [{ name: 'x', scopes: READS }, { name: 'x', scopes: READS, expiresInDays: 366 }, { name: 'x', scopes: ['keys:manage'], expiresInDays: 1 }, { name: 'x', scopes: [], expiresInDays: 1 },
      { name: 'x', scopes: READS, expiresInDays: 1, restrictions: { ipAllow: ['not an ip'] } }, { name: 'x', scopes: READS, expiresInDays: 1, admin: true }])
      expect((await call('POST', `${DEV}/keys/prepare`, { body: bad })).status, JSON.stringify(bad)).toBe(400);

    const p = await call('POST', `${DEV}/keys/prepare`, { body: { name: 'reader', scopes: ['orders:read', 'markets:read', 'markets:read'], expiresInDays: 30, limits: { maxOrderNotionalUsd: 500, maxDailyNotionalUsd: 2000 }, restrictions: { venues: ['hyperliquid'] } } });
    expect(p.status).toBe(200);
    expect(p.json.intent).toMatchObject({ v: 1, action: 'create', origin: ORIGIN, key: { name: 'reader', scopes: ['markets:read', 'orders:read'], limits: { maxOrderNotionalUsd: 500, maxDailyNotionalUsd: 2000 }, mandateId: null } });
    // the challenge commits to the canonical request: SHA-256(tag ‖ canonical JSON), recomputed here from the intent the server showed
    const { canonicalJson, intentChallenge } = await import('../src/trading-api/key-model.ts');
    expect(p.json.options.challenge).toBe(intentChallenge(canonicalJson(p.json.intent)).toString('base64url'));
    expect(p.json.sha256).toBe(intentChallenge(canonicalJson(p.json.intent)).toString('hex'));

    // no assertion, another passkey, an assertion over another challenge: refused — and each attempt consumes the intent
    expect((await call('POST', `${DEV}/keys`, { body: { intentId: p.json.intentId } })).status).toBe(400);
    const stranger = await call('POST', `${DEV}/keys`, { body: { intentId: p.json.intentId, assertion: assertion(p.json.options, attacker) } });
    expect(stranger.status).toBe(401);
    expect((await call('POST', `${DEV}/keys`, { body: { intentId: p.json.intentId, assertion: assertion(p.json.options) } })).json.error).toBe('intent_expired');
    const p2 = await call('POST', `${DEV}/keys/prepare`, { body: { name: 'reader', scopes: ['markets:read'], expiresInDays: 30 } });
    expect((await call('POST', `${DEV}/keys`, { body: { intentId: p2.json.intentId, assertion: owner.assert(randomBytes(32)) } })).status).toBe(401);
    expect((await sql`select count(*)::int as n from api_keys`)[0].n).toBe(0);
    expect((await audits('apikey.approval_failed')).length).toBe(2);

    const k = await newKey({ name: 'reader', scopes: ['orders:read', 'markets:read'], limits: { maxOrderNotionalUsd: 500, maxDailyNotionalUsd: 2000 } });
    expect(k.secret).toMatch(/^spw_live_spk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(k.secret.startsWith(`spw_live_${k.id}_`)).toBe(true);
    expect(k.view).toMatchObject({ status: 'active', scopes: ['markets:read', 'orders:read'], rateLimitPerMin: 120, mandateId: null, limits: { maxOrderNotionalUsd: 500, maxDailyNotionalUsd: 2000 } });
    expect(k.view.expiresAt - k.view.createdAt).toBeGreaterThan(29.9 * 86_400_000);
    expect(k.view.expiresAt - k.view.createdAt).toBeLessThan(30.1 * 86_400_000);
    // the secret is nowhere in the database: only an HMAC under a pepper that is not in the database either
    const secret = k.secret.split('_').slice(4).join('_');
    const dump = JSON.stringify(await sql`select * from api_keys`) + JSON.stringify(await sql`select * from audit_events`) + JSON.stringify(await sql`select * from api_key_intents`);
    expect(dump).not.toContain(secret);
    const [row] = await sql`select * from api_keys where id = ${k.id}`;
    expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.secret_hash).not.toBe(createHash('sha256').update(secret).digest('hex'));
    // the list never shows a secret or a hash
    const list = await call('GET', `${DEV}/keys`);
    expect(JSON.stringify(list.json)).not.toContain(secret);
    expect(JSON.stringify(list.json)).not.toContain(row.secret_hash);
    expect(list.json.keys.find((x: any) => x.id === k.id)).toMatchObject({ name: 'reader', lastUsedAt: null });
    expect((await audits('apikey.created')).at(-1).data).toMatchObject({ key: k.id, scopes: ['markets:read', 'orders:read'] });
  });

  it('a key authenticates on the trading API: no cookie, no CSRF header; anything else is 401 with one message', async () => {
    const k = await newKey();
    const ok = await call('GET', `${T}/markets?venue=hyperliquid&limit=3`, { key: k.secret });
    expect(ok.status).toBe(200);
    expect(ok.headers['ratelimit-limit']).toBe('120');
    expect(Number(ok.headers['ratelimit-remaining'])).toBe(119);
    expect(Number(ok.headers['ratelimit-reset'])).toBeGreaterThan(0);
    expect(ok.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect((await call('GET', `${T}/markets`, { cookie: null })).status).toBe(401);
    const wrong = `spw_live_${k.id}_${randomBytes(32).toString('base64url')}`;
    for (const bad of [wrong, `spw_live_spk_000000000000_${randomBytes(32).toString('base64url')}`, 'spw_live_garbage', k.secret.slice(0, -2)]) {
      const r = await call('GET', `${T}/markets`, { key: bad });
      expect(r.status, bad).toBe(401);
      expect(r.json).toEqual({ error: 'unauthenticated', message: 'authentication required' });
    }
    // key + session cookie in one request: refused (the cookie must never ride on the CSRF-exempt path)
    const mixed = await call('GET', `${T}/markets`, { key: k.secret, cookie });
    expect(mixed.status).toBe(403);
    expect(mixed.json.error).toBe('mixed_credentials');
    // a POST with the key needs neither Origin nor the CSRF header (it reaches the handler: 501 after the checks)
    const kw = await newKey({ scopes: ['orders:prepare'] });
    const post = await call('POST', `${T}/orders/preview`, { key: kw.secret, headers: idem(), body: { mode: 'paper', instrument: BTC, side: 'buy', type: 'market', size: '0.01' } });
    expect(post.status).toBe(501);
    principal.authFailures.reset();
  });

  it('expiry and revocation close the key at once; revocation needs only the session and emits key.revoked', async () => {
    const k = await newKey();
    expect((await call('GET', `${T}/agents`, { key: k.secret })).status).toBe(200);
    await sql`update api_keys set expires_at = now() - interval '1 second' where id = ${k.id}`;
    expect((await call('GET', `${T}/agents`, { key: k.secret })).status).toBe(401);
    expect((await call('GET', `${DEV}/keys`)).json.keys.find((x: any) => x.id === k.id).status).toBe('expired');
    await sql`update api_keys set expires_at = now() + interval '1 day' where id = ${k.id}`;
    expect((await call('GET', `${T}/agents`, { key: k.secret })).status).toBe(200);
    expect((await call('POST', `${DEV}/keys/${k.id}/revoke`, { cookie: null, body: {}, headers: { origin: ORIGIN, 'x-spw-csrf': '1' } })).status).toBe(401);
    const r = await call('POST', `${DEV}/keys/${k.id}/revoke`, { body: { reason: 'laptop lost' } });
    expect(r.status).toBe(200);
    expect(r.json.key).toMatchObject({ status: 'revoked', revokedReason: 'laptop lost' });
    expect((await call('GET', `${T}/agents`, { key: k.secret })).status).toBe(401);
    expect((await call('POST', `${DEV}/keys/${k.id}/revoke`, { body: {} })).status).toBe(200);            // idempotent
    expect((await audits('apikey.revoked')).filter((e: any) => e.data.key === k.id)).toHaveLength(1);
    expect((await call('POST', `${DEV}/keys/spk_000000000000/revoke`, { body: {} })).status).toBe(404);
    // the refused calls of a real key show in its history (the secret was right), with their status
    const usage = await sql`select status, route from api_key_usage where key_id = ${k.id} order by id`;
    expect(usage.map((u: any) => u.status)).toEqual([200, 401, 200, 401]);
    principal.authFailures.reset();
  });

  it('rotation: passkey, new id and secret, same authority, old key dead', async () => {
    const k = await newKey({ scopes: ['markets:read'], limits: { maxOrderNotionalUsd: 100, maxDailyNotionalUsd: null }, rateLimitPerMin: 77 });
    const p = await call('POST', `${DEV}/keys/${k.id}/rotate/prepare`, { body: {} });
    expect(p.json.intent).toMatchObject({ action: 'rotate', keyId: k.id });
    expect((await call('POST', `${DEV}/keys/${k.id}/rotate`, { body: { intentId: p.json.intentId, assertion: assertion(p.json.options, attacker) } })).status).toBe(401);
    const p2 = await call('POST', `${DEV}/keys/${k.id}/rotate/prepare`, { body: {} });
    const other = await newKey();
    expect((await call('POST', `${DEV}/keys/${other.id}/rotate`, { body: { intentId: p2.json.intentId, assertion: assertion(p2.json.options) } })).json.error).toBe('intent_mismatch');  // an approval is for ONE key
    const p3 = await call('POST', `${DEV}/keys/${k.id}/rotate/prepare`, { body: {} });
    const r = await call('POST', `${DEV}/keys/${k.id}/rotate`, { body: { intentId: p3.json.intentId, assertion: assertion(p3.json.options) } });
    expect(r.status).toBe(200);
    expect(r.json.key).toMatchObject({ scopes: ['markets:read'], rateLimitPerMin: 77, rotatedFrom: k.id, limits: { maxOrderNotionalUsd: 100, maxDailyNotionalUsd: null }, expiresAt: k.view.expiresAt });
    expect(r.json.key.id).not.toBe(k.id);
    expect(r.json.secret).not.toBe(k.secret);
    expect((await call('GET', `${T}/markets?venue=hyperliquid&limit=1`, { key: r.json.secret })).status).toBe(200);
    expect((await call('GET', `${T}/markets?venue=hyperliquid&limit=1`, { key: k.secret })).status).toBe(401);
    expect((await audits('apikey.rotated')).at(-1).data).toMatchObject({ from: k.id, to: r.json.key.id });
    principal.authFailures.reset();
  });

  it('narrowing needs the session; widening needs the passkey, and the approval is checked against the key as it is', async () => {
    const k = await newKey({ scopes: ['markets:read', 'orders:read'], limits: { maxOrderNotionalUsd: 100, maxDailyNotionalUsd: 100 } });
    const narrow = await call('POST', `${DEV}/keys/${k.id}/update`, { body: { changes: { scopes: ['markets:read'], rateLimitPerMin: 30, name: 'narrowed' } } });
    expect(narrow.status).toBe(200);
    expect(narrow.json.key).toMatchObject({ scopes: ['markets:read'], rateLimitPerMin: 30, name: 'narrowed' });
    expect((await call('GET', `${T}/orders`, { key: k.secret })).status).toBe(403);                         // effective at once
    for (const changes of [{ scopes: ['markets:read', 'orders:execute'] }, { rateLimitPerMin: 31 }, { mandateId: randomUUID() }, { expiresAt: new Date(k.view.expiresAt + 86_400_000).toISOString() },
      { limits: { maxOrderNotionalUsd: null, maxDailyNotionalUsd: null } }]) {
      const r = await call('POST', `${DEV}/keys/${k.id}/update`, { body: { changes } });
      expect(r.status, JSON.stringify(changes)).toBe(403);
      expect(r.json.error).toBe('passkey_required');
    }
    expect((await call('POST', `${DEV}/keys/${k.id}/update`, { body: { changes: { expiresAt: new Date(k.view.createdAt + 366 * 86_400_000).toISOString() } } })).json.error).toBe('expiry_too_far');
    const mandateId = randomUUID();
    const p = await call('POST', `${DEV}/keys/${k.id}/update/prepare`, { body: { changes: { scopes: ['markets:read', 'orders:execute'], mandateId } } });
    expect(p.json.intent).toMatchObject({ action: 'update', keyId: k.id, widening: ['scopes', 'mandateId'] });
    const u = await call('POST', `${DEV}/keys/${k.id}/update`, { body: { intentId: p.json.intentId, assertion: assertion(p.json.options) } });
    expect(u.status).toBe(200);
    expect(u.json.key).toMatchObject({ scopes: ['markets:read', 'orders:execute'], mandateId, inertScopes: [] });
    expect((await audits('apikey.updated')).at(-1).data).toMatchObject({ key: k.id, widening: ['scopes', 'mandateId'] });
  });
});

describe('default deny', () => {
  it('a valid key with EVERY scope is refused on every route of the application outside /api/v1/trading/', async () => {
    const k = await newKey({ scopes: ALL, mandateId: randomUUID() });
    const routes = allRoutes();
    expect(routes.length).toBeGreaterThan(190);
    expect(routes.some((r) => r.path === '/api/v1/security/emergency-halt') && routes.some((r) => r.path === '/api/v1/developer/keys') && routes.some((r) => r.path.startsWith('/api/v1/research/runner/'))).toBe(true);
    const outside = routes.filter((r) => !r.path.startsWith(`${T}/`));
    expect(outside.length).toBeGreaterThan(170);
    expect(outside.every((r) => r.path.startsWith('/api/'))).toBe(true);                     // this instance serves no static file: every route is an API route
    const answers = new Map<number, number>();
    for (const r of outside) {
      const res = await call(r.method, concrete(r.path), { key: k.secret, ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { body: {} }) });
      answers.set(res.status, (answers.get(res.status) ?? 0) + 1);
      expect([401, 403], `${r.method} ${r.path} answered ${res.status}`).toContain(res.status);
      expect(res.json?.error, `${r.method} ${r.path}`).toBe('key_path_forbidden');
    }
    expect([...answers.keys()]).toEqual([403]);
    // the same key works where it is meant to
    expect((await call('GET', `${T}/agents`, { key: k.secret })).status).toBe(200);
    // … and the prefix is matched as a path, not as a string
    for (const p of ['/api/v1/trading', '/api/v1/tradingx/markets', '/api/v1/trading/../security/overview', '/api/v1//trading/markets']) expect([403, 404], p).toContain((await call('GET', p, { key: k.secret })).status);
    expect((await call('GET', '/api/v1/trading/../security/overview', { key: k.secret })).status).not.toBe(200);
    expect((await call('GET', `${T}/nope`, { key: k.secret })).status).toBe(404);
    // the routes a key can reach are exactly the declared operations, and each one declares its scope
    const inside = routes.filter((r) => r.path.startsWith(`${T}/`)).map((r) => `${r.method} ${r.path.slice(T.length)}`).sort();
    expect(inside).toEqual(spec.OPERATIONS.map((o) => `${o.method} ${o.path}`).sort());
  });

  it('a route without a declared scope is closed, to a key and to the owner', async () => {
    const Fastify = (await import('fastify')).default;
    const a = Fastify();
    a.decorateRequest('principal', null);
    a.addHook('onRequest', async (req) => { req.principal = req.headers['x-as'] === 'owner' ? principal.OWNER : { kind: 'api_key', id: 'spk_000000000001', name: 't', scopes: ALL as never, limits: { maxOrderNotionalUsd: null, maxDailyNotionalUsd: null }, restrictions: { networks: [], venues: [], instruments: [], ipAllow: [] }, mandateId: null, rateLimitPerMin: 1 }; });
    a.addHook('preHandler', principal.scopeGuard);
    a.setErrorHandler((e: any, _req, reply) => reply.status(e.status ?? 500).send({ error: e.code }));
    a.get(`${T}/undeclared`, async () => ({ ok: true }));
    a.get(`${T}/declared`, { config: { scope: 'markets:read' } }, async () => ({ ok: true }));
    a.get('/api/v1/elsewhere', { config: { scope: 'markets:read' } }, async () => ({ ok: true }));
    expect((await a.inject({ url: `${T}/undeclared` })).json()).toEqual({ error: 'scope_undeclared' });
    expect((await a.inject({ url: `${T}/undeclared`, headers: { 'x-as': 'owner' } })).json()).toEqual({ error: 'scope_undeclared' });
    expect((await a.inject({ url: `${T}/declared` })).statusCode).toBe(200);
    expect((await a.inject({ url: '/api/v1/elsewhere' })).json()).toEqual({ error: 'key_path_forbidden' });   // even with a scope declared, even if the gate were bypassed
    expect((await a.inject({ url: '/api/v1/elsewhere', headers: { 'x-as': 'owner' } })).statusCode).toBe(200);
    await a.close();
  });

  it('scopes: a key reaches only the operations whose scope it holds; a refusal is audited and logged', async () => {
    const k = await newKey({ scopes: ['markets:read'] });
    expect((await call('GET', `${T}/markets?venue=hyperliquid&limit=1`, { key: k.secret })).status).toBe(200);
    expect((await call('GET', `${T}/openapi.json`, { key: k.secret })).status).toBe(200);              // any valid key
    for (const op of spec.OPERATIONS.filter((o) => o.scope !== '*' && o.scope !== 'markets:read')) {
      const r = await call(op.method, T + concrete(op.path), { key: k.secret, ...(op.method === 'POST' ? { body: {}, headers: idem() } : op.method === 'DELETE' ? { headers: idem() } : {}) });
      expect(r.status, op.id).toBe(403);
      expect(r.json, op.id).toEqual({ error: 'insufficient_scope', message: `this key lacks the scope ${op.scope}` });
    }
    const denied = (await audits('apikey.denied')).filter((e: any) => e.data.key === k.id);
    expect(denied.length).toBeGreaterThan(10);
    expect(denied[0]).toMatchObject({ actor: `key:${k.id}` });
    expect(await call('GET', `${T}/portfolio`, { key: k.secret }).then((r) => r.status)).toBe(403);
    expect((await audits('apikey.denied')).filter((e: any) => e.data.key === k.id && e.data.route === `${T}/portfolio`)).toHaveLength(1);   // one audit row per key, scope and route per minute
    const usage = await sql`select method, route, status, latency_ms, request_id from api_key_usage where key_id = ${k.id} and status = 403`;
    expect(usage.length).toBeGreaterThan(10);
    expect(usage.every((u: any) => u.route.startsWith(T) && u.request_id.length === 36 && u.latency_ms >= 0)).toBe(true);
  });
});

describe('limits', () => {
  it('rate limit per key, with RateLimit-* headers; another key is not affected', async () => {
    const a = await newKey({ rateLimitPerMin: 3 }), b = await newKey({ rateLimitPerMin: 3 });
    for (const left of [2, 1, 0]) {
      const r = await call('GET', `${T}/agents`, { key: a.secret });
      expect(r.status).toBe(200);
      expect([r.headers['ratelimit-limit'], r.headers['ratelimit-remaining']]).toEqual(['3', String(left)]);
    }
    const over = await call('GET', `${T}/agents`, { key: a.secret });
    expect(over.status).toBe(429);
    expect(over.json).toEqual({ error: 'rate_limited', message: 'too many requests for this key' });
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect(over.headers['ratelimit-remaining']).toBe('0');
    expect((await call('GET', `${T}/agents`, { key: b.secret })).status).toBe(200);
    expect((await sql`select status from api_key_usage where key_id = ${a.id} order by id`).map((u: any) => u.status)).toEqual([200, 200, 200, 429]);
    principal.keyLimiter.reset();
    expect((await call('GET', `${T}/agents`, { key: a.secret })).status).toBe(200);
  });

  it('failed authentications are throttled per address', async () => {
    principal.authFailures.reset();
    const good = await newKey();
    for (let k = 0; k < principal.AUTH_FAILURES_PER_MIN; k++) expect((await call('GET', `${T}/agents`, { key: `spw_live_spk_00000000000${k % 10}_${randomBytes(32).toString('base64url')}`, ip: '198.51.100.7' })).status).toBe(401);
    const blocked = await call('GET', `${T}/agents`, { key: good.secret, ip: '198.51.100.7' });
    expect(blocked.status).toBe(429);
    expect(blocked.json.error).toBe('auth_throttled');
    expect((await call('GET', `${T}/agents`, { key: good.secret, ip: '198.51.100.8' })).status).toBe(200);    // another address is not affected
    principal.authFailures.reset();
    expect((await call('GET', `${T}/agents`, { key: good.secret, ip: '198.51.100.7' })).status).toBe(200);
  });

  it('restrictions: source address, venues, instruments and networks are enforced on reads', async () => {
    const ipKey = await newKey({ restrictions: { ipAllow: ['10.0.0.0/8', '2001:db8::/32'] } });
    expect((await call('GET', `${T}/agents`, { key: ipKey.secret, ip: '10.9.8.7' })).status).toBe(200);
    const far = await call('GET', `${T}/agents`, { key: ipKey.secret, ip: '203.0.113.5' });
    expect(far.status).toBe(403);
    expect(far.json.error).toBe('ip_not_allowed');
    const k = await newKey({ restrictions: { venues: ['hyperliquid'], instruments: [BTC, 'hyperliquid:ETH'], networks: ['base'] } });
    const m = await call('GET', `${T}/markets`, { key: k.secret });
    expect(m.json.markets.map((x: any) => x.id).sort()).toEqual([BTC, 'hyperliquid:ETH'].sort());
    expect((await call('GET', `${T}/markets?venue=gmx`, { key: k.secret })).json.error).toBe('restricted');
    expect((await call('GET', `${T}/markets/${encodeURIComponent(GMX_BTC)}`, { key: k.secret })).status).toBe(403);
    expect((await call('GET', `${T}/markets/hyperliquid:SOL`, { key: k.secret })).status).toBe(403);
    expect((await call('GET', `${T}/markets/BTC`, { key: k.secret })).json.market.id).toBe(BTC);             // a bare symbol is not ambiguous for a key that sees one venue
    expect((await call('GET', `${T}/positions?venue=gmx`, { key: k.secret })).status).toBe(403);
    const b = await call('GET', `${T}/balances`, { key: k.secret });
    expect([...new Set(b.json.balances.map((x: any) => x.network))]).toEqual(['base']);
    expect((await call('GET', `${T}/balances?network=ethereum`, { key: k.secret })).status).toBe(403);
    const before = gmxFake.calls;
    expect((await call('GET', `${T}/positions`, { key: k.secret })).json.positions.every((x: any) => x.venue === 'hyperliquid')).toBe(true);
    expect(gmxFake.calls).toBe(before);                                                                  // a venue the key cannot see is not even read
  });
});

describe('private markets (v11) under the trading prefix', () => {
  it('markets:read opens the three read-only routes; another scope is refused; venue restrictions narrow the answer', async () => {
    const PM = `${T}/private-markets`;
    const none = await newKey({ scopes: ['wallet:read'] });
    for (const path of [PM, `${PM}/hyperliquid:io:ANTH`, `${PM}/companies/anthropic`]) expect((await call('GET', path, { key: none.secret })).json, path).toEqual({ error: 'insufficient_scope', message: 'this key lacks the scope markets:read' });
    const k = await newKey({ scopes: ['markets:read'] });
    const list = await call('GET', PM, { key: k.secret });
    expect(list.status).toBe(200);
    expect(spec.operation('listPrivateMarkets').response!.safeParse(list.json).success).toBe(true);
    // this suite's Hyperliquid replays no builder-dex answer: its reviewed rows come back with the venue's error — never a 5xx, never a price
    expect(list.json.venues.map((x: any) => x.venue)).toEqual(['hyperliquid']);
    expect(list.json.markets.length).toBeGreaterThan(0);
    expect(list.json.markets.every((m: any) => m.venue === 'hyperliquid' && m.error && m.market.price.value === null && m.valuation.impliedValuation.value === null && m.tradable === false)).toBe(true);
    expect((await call('GET', `${PM}/companies/anthropic`, { key: k.secret })).status).toBe(200);
    expect((await call('POST', PM, { key: k.secret, body: {}, headers: idem() })).status).toBe(404);             // read-only: no write route exists
    const gmxOnly = await newKey({ scopes: ['markets:read'], restrictions: { venues: ['gmx'] } });
    const narrowed = await call('GET', PM, { key: gmxOnly.secret });
    expect(narrowed.status).toBe(200);
    expect(narrowed.json.markets).toEqual([]); expect(narrowed.json.venues).toEqual([]); expect(narrowed.json.companies).toEqual([]);
    expect((await call('GET', `${PM}/hyperliquid:io:ANTH`, { key: gmxOnly.secret })).json.error).toBe('restricted');
  });
});

describe('read side', () => {
  let key = '';
  beforeAll(async () => { key = (await newKey({ rateLimitPerMin: 600 })).secret; });
  const get = (path: string) => call('GET', T + path, { key });
  const parsed = (id: string, json: unknown) => { const r = spec.operation(id).response!.safeParse(json); expect(r.success, `${id}: ${JSON.stringify((r as any).error?.issues?.slice(0, 3))}`).toBe(true); };

  it('GET /markets: perpetuals of three venues and the spot symbols, each row with its source time and a stale flag', async () => {
    setMarket(v, 50_000); clock.advance(4_000);
    const r = await get('/markets');
    expect(r.status).toBe(200);
    parsed('listMarkets', r.json);
    expect(r.json.errors).toEqual([]);
    const venues = new Set(r.json.markets.map((x: any) => x.venue));
    expect([...venues].sort()).toEqual(['dydx', 'gmx', 'hyperliquid', 'spot']);
    const btc = r.json.markets.find((x: any) => x.id === BTC);
    expect(btc).toMatchObject({ venue: 'hyperliquid', kind: 'perpetual', symbol: 'BTC', base: 'BTC', mark: '50000', stale: false, source: 'venue' });
    expect(btc.ts).toBe(clock.now());
    const spot = r.json.markets.find((x: any) => x.id === 'spot:BTC');
    expect(spot).toMatchObject({ venue: 'spot', kind: 'spot', quote: 'USD', mark: null, stale: true, status: 'no_data' });        // no bar ingested in this database: said, not invented
    expect((await get('/markets?kind=spot')).json.markets.every((x: any) => x.kind === 'spot')).toBe(true);
    expect((await get('/markets?venue=gmx')).json.markets.every((x: any) => x.venue === 'gmx')).toBe(true);
    expect((await get('/markets?q=btc&kind=perpetual')).json.markets.every((x: any) => /btc/i.test(x.id + x.base))).toBe(true);
    expect((await get('/markets?venue=nope')).status).toBe(404);
    expect((await get('/markets?limit=0')).status).toBe(400);
    const cut = await get('/markets?limit=5');
    expect(cut.json.markets).toHaveLength(5);
    expect(cut.json).toMatchObject({ truncated: true });
    expect(cut.json.total).toBe(r.json.total);
    expect(r.json.truncated).toBe(false);
  });

  it('GET /markets/{symbol}: venue:symbol ids; an ambiguous bare symbol is a 409 with the candidates', async () => {
    const one = await get(`/markets/${BTC}`);
    expect(one.status).toBe(200);
    parsed('getMarket', one.json);
    expect(one.json).toMatchObject({ market: { id: BTC, mark: '50000', stale: false }, instrument: { venue: 'hyperliquid', symbol: 'BTC' }, hasOrderBook: true, source: 'venue' });
    const amb = await get('/markets/BTC');
    expect(amb.status).toBe(409);
    expect(amb.json.error).toBe('ambiguous_symbol');
    expect(amb.json.candidates).toEqual(expect.arrayContaining([BTC, 'dydx:BTC-USD', 'spot:BTC']));
    expect(amb.json.candidates.length).toBeGreaterThanOrEqual(4);
    const spot = await get('/markets/spot:BTC');
    expect(spot.json).toMatchObject({ market: { id: 'spot:BTC', kind: 'spot', stale: true }, instrument: null, source: 'market-data' });
    expect((await get('/markets/hyperliquid:NOPE')).status).toBe(404);
    expect((await get('/markets/NOPENOPE')).status).toBe(404);
    expect((await get('/markets/spot:NOPE')).status).toBe(404);
  });

  it('GET /markets/{symbol}/orderbook and /candles; a venue without a book says so', async () => {
    const b = await get(`/markets/${BTC}/orderbook?depth=1`);
    expect(b.status).toBe(200);
    parsed('getOrderbook', b.json);
    expect(b.json).toMatchObject({ id: BTC, bids: [['49995', '1']], asks: [['50005', '1']], stale: false, source: 'venue' });
    expect((await get(`/markets/${encodeURIComponent(GMX_BTC)}/orderbook`)).json.error).toBe('no_orderbook');
    expect((await get('/markets/spot:BTC/orderbook')).status).toBe(422);
    const c = await get(`/markets/${BTC}/candles?interval=1h&limit=5`);
    expect(c.status).toBe(200);
    parsed('getCandles', c.json);
    expect(c.json.candles).toHaveLength(5);
    expect(c.json.candles[0]).toEqual(expect.objectContaining({ ts: expect.any(Number), open: expect.any(String), close: expect.any(String) }));
    const s = await get('/markets/spot:BTC/candles?interval=1h');
    expect(s.json).toMatchObject({ candles: [], stale: true, ts: null, source: 'market-data' });
    expect((await get('/markets/spot:BTC/candles?interval=1m')).json.error).toBe('unsupported_interval');
    expect((await get(`/markets/${BTC}/candles?interval=2h`)).status).toBe(400);
  });

  it('a venue that cannot be read: stale data is flagged while it is within its bound, then the call is a 503 — never old data as current', async () => {
    v.hl.down = true; clock.advance(5_000);
    const stale = await get(`/markets?venue=hyperliquid&q=BTC`);
    expect(stale.status).toBe(200);
    expect(stale.json.markets.find((x: any) => x.id === BTC)).toMatchObject({ mark: '50000', stale: true });
    clock.advance(4_000_000);                                                                           // beyond every bound, instruments included
    const all = await get('/markets');
    expect(all.status).toBe(200);
    expect(all.json.errors.map((e: any) => e.source)).toEqual(['hyperliquid']);                          // the other sources still answer
    const down = await get('/markets?venue=hyperliquid');
    expect(down.status).toBe(503);
    expect(down.json.error).toBe('venue_unavailable');
    expect((await get(`/markets/${BTC}`)).status).toBe(503);
    expect((await get(`/markets/${BTC}/orderbook`)).status).toBe(503);
    expect((await get(`/markets/${BTC}/candles`)).status).toBe(503);
    v.hl.down = false; clock.advance(2_000);
    setMarket(v, 50_000);
    expect((await get(`/markets/${BTC}`)).status).toBe(200);
  });

  it('GET /balances and /portfolio: real signer addresses, scripted chain balances; one network down is named, the signer down is a 503', async () => {
    const b = await get('/balances');
    expect(b.status).toBe(200);
    parsed('getBalances', b.json);
    expect(b.json.errors).toEqual([{ source: 'solana', message: 'rpc down (scripted)' }]);
    expect(b.json.balances.find((x: any) => x.network === 'base' && x.asset === 'native')).toMatchObject({ amount: '1000000000000000000', display: '1', symbol: 'ETH', error: null });
    expect(b.json.balances.find((x: any) => x.network === 'solana' && x.asset === 'native')).toMatchObject({ amount: null, error: 'unavailable' });
    expect((await get('/balances?network=base')).json.balances.every((x: any) => x.network === 'base')).toBe(true);
    expect((await get('/balances?network=nope')).status).toBe(404);
    const p = await get('/portfolio');
    expect(p.status).toBe(200);
    parsed('getPortfolio', p.json);
    expect(Object.keys(p.json.totals).sort()).toEqual(['liveVenueEquity', 'note', 'paperEquity', 'walletUsd']);
    expect(JSON.stringify(Object.keys(p.json.totals))).not.toMatch(/total|sum|net/i);                    // no figure that adds paper and live
  });

  it('paper positions and orders carry mode=paper; GMX chain positions carry mode=live; nothing is merged', async () => {
    setMarket(v, 50_000); clock.advance(4_000);
    const acct = await call('POST', '/api/v1/derivatives/accounts', { body: { venue: 'hyperliquid', label: 'Paper one', collateral: '10000' } });
    expect(acct.status, JSON.stringify(acct.json)).toBe(200);
    const id = acct.json.id as string, clientId = `trading-api-${randomUUID()}`;
    const o = await call('POST', `/api/v1/derivatives/accounts/${id}/orders`, { body: { instrument: BTC, side: 'buy', type: 'market', size: '0.01', slippageBps: 50 }, headers: { 'idempotency-key': clientId } });
    expect(o.status, JSON.stringify(o.json)).toBe(200);

    const pos = await get('/positions');
    expect(pos.status).toBe(200);
    parsed('listPositions', pos.json);
    const paper = pos.json.positions.filter((x: any) => x.mode === 'paper'), live = pos.json.positions.filter((x: any) => x.mode === 'live');
    expect(paper).toHaveLength(1);
    expect(paper[0]).toMatchObject({ id: `paper:hyperliquid:${id}:${BTC}`, venue: 'hyperliquid', accountId: id, instrument: BTC, side: 'long', size: '0.01', source: 'paper' });
    expect(live).toEqual([expect.objectContaining({ venue: 'gmx', mode: 'live', instrument: GMX_BTC, side: 'long', size: '0.5', source: 'chain' })]);
    expect((await get('/positions?mode=paper')).json.positions.every((x: any) => x.mode === 'paper')).toBe(true);
    expect((await get('/positions?mode=live')).json.positions.every((x: any) => x.mode === 'live')).toBe(true);
    expect((await get('/positions?venue=gmx')).json.positions).toHaveLength(1);

    const orders = await get('/orders');
    parsed('listOrders', orders.json);
    const mine = orders.json.orders.find((x: any) => x.clientId === clientId);
    expect(mine).toMatchObject({ id: `deriv:${id}:${clientId}`, mode: 'paper', venue: 'hyperliquid', instrument: BTC, side: 'buy', type: 'market', status: 'filled', final: true });
    expect((await get('/orders?mode=live')).json.orders.find((x: any) => x.clientId === clientId)).toBeUndefined();
    expect((await get('/orders?open=true')).json.orders.find((x: any) => x.clientId === clientId)).toBeUndefined();
    const one = await get(`/orders/${mine.id}`);
    expect(one.status).toBe(200);
    parsed('getOrder', one.json);
    expect(one.json.fills).toHaveLength(1);
    expect(one.json.fills[0]).toMatchObject({ instrument: BTC, side: 'buy' });
    for (const bad of ['deriv:nope:x', `deriv:${id}:missing`, `gmx:${randomUUID()}`, `agent:${randomUUID()}`, 'x']) expect((await get(`/orders/${bad}`)).status, bad).toBe(404);

    const p = await get('/portfolio');
    expect(p.json.accounts).toEqual([expect.objectContaining({ mode: 'paper', venue: 'hyperliquid', accountId: id })]);
    expect(p.json.totals.liveVenueEquity).toBeNull();                                                    // no venue account: no live figure, and the paper equity is not put in its place
    expect(Number(p.json.totals.paperEquity)).toBeGreaterThan(9_900);
    const act = await get('/activity');
    parsed('getActivity', act.json);
    expect(act.json.items.find((x: any) => x.kind === 'fill')).toMatchObject({ mode: 'paper', venue: 'hyperliquid', instrument: BTC });
  });

  it('GET /risk, /agents, /strategies', async () => {
    const r = await get('/risk');
    expect(r.status).toBe(200);
    parsed('getRisk', r.json);
    expect(r.json.killSwitch).toMatchObject({ signerReachable: true, signerHalted: false });
    expect(r.json.capabilityLocks.map((c: any) => c.id)).toEqual(expect.arrayContaining(['deriv_live_mainnet', 'deriv_mandate_mainnet', 'deriv_gmx_live']));
    expect(r.json.accounts).toEqual([expect.objectContaining({ mode: 'paper', venue: 'hyperliquid' })]);
    expect(r.json.key).toMatchObject({ limitsEnforced: false, mandateId: null });
    const agentId = randomUUID();
    await sql`insert into agents (id, name, universe, risk, vault_index, vault_address, state, mode) values (${agentId}, 'Agent one', ${sql.json(['BTC', 'ETH'])}, ${sql.json({})}, 9001, '0x0', 'PAPER_TRADING', 'PAPER')`;
    await sql`insert into strategy_versions (id, agent_id, name, version, code_sha256, path, status) values (${randomUUID()}, ${agentId}, 'momentum', '1', ${'ab'.repeat(32)}, 'momentum/1', 'approved')`;
    const a = await get('/agents');
    parsed('listAgents', a.json);
    expect(a.json.agents.find((x: any) => x.id === agentId)).toMatchObject({ kind: 'spot', name: 'Agent one', state: 'PAPER_TRADING', tradingMode: 'paper', venue: 'spot', universe: ['BTC', 'ETH'] });
    const s = await get('/strategies');
    expect(s.status).toBe(200);
    parsed('listStrategies', s.json);
    expect(s.json.versions).toEqual([expect.objectContaining({ agentId, name: 'momentum', status: 'approved', kind: 'spot' })]);
    expect((await get('/strategies?kind=perp')).json.versions).toEqual([]);
  }, 120_000);

  it('the signer down: balances and the portfolio are a 503, the risk view says the signer is unreachable', async () => {
    const { signer } = await import('../src/signer-client.ts');
    const real = signer.status;
    signer.status = async () => { throw new (await import('../src/config.ts')).UserError('signer_unreachable', 'the signer is unreachable; nothing was signed', 503); };
    try {
      for (const p of ['/balances', '/portfolio']) { const r = await get(p); expect(r.status, p).toBe(503); expect(r.json.error).toBe('signer_unreachable'); }
      const r = await get('/risk');
      expect(r.status).toBe(200);
      expect(r.json.killSwitch).toMatchObject({ signerReachable: false, signerHalted: null });
      expect(r.json.signerPolicy).toBeNull();
    } finally { signer.status = real; }
  });

  it('GET /openapi.json is the generated document, for any key and for the owner', async () => {
    const { buildOpenApi } = await import('../src/trading-api/openapi.ts');
    const r = await get('/openapi.json');
    expect(r.json).toEqual(JSON.parse(JSON.stringify(buildOpenApi())));
    expect((await call('GET', `${T}/openapi.json`)).status).toBe(200);
    expect((await call('GET', `${T}/openapi.json`, { cookie: null })).status).toBe(401);
  });

  it('the owner session reaches the trading API too (every scope), with the session rules', async () => {
    expect((await call('GET', `${T}/markets?venue=gmx&limit=2`)).status).toBe(200);
    expect((await call('POST', `${T}/orders/preview`, { body: { mode: 'paper', instrument: BTC, side: 'buy', type: 'market', size: '0.01' }, headers: idem(), csrf: false })).status).toBe(403);   // CSRF still applies to the cookie
  });
});

describe('write surface (not wired)', () => {
  const ORDER = { mode: 'paper', instrument: BTC, side: 'buy', type: 'limit', size: '0.01', price: '40000' };
  const BODY: Record<string, unknown> = { previewOrder: ORDER, placeOrder: ORDER, closePosition: {}, reducePosition: { fraction: '0.5' }, createStrategy: { kind: 'spot', path: 'momentum/1' }, backtestStrategy: {}, startStrategy: { mode: 'paper' },
    stopStrategy: {}, createAgent: { kind: 'spot', name: 'Agent', universe: ['BTC'] }, startAgent: { mode: 'paper' }, stopAgent: {} };
  const send = (op: any, o: Record<string, unknown>) => call(op.method, T + concrete(op.path), { ...(op.method === 'POST' ? { body: BODY[op.id] } : {}), ...o });

  it('every write operation answers 501 execution_not_wired — never 2xx — for a key bound to a mandate and for the owner', async () => {
    const k = await newKey({ scopes: ALL, mandateId: randomUUID(), rateLimitPerMin: 600 });
    const writes = spec.OPERATIONS.filter((o) => !o.implemented);
    expect(writes.map((o) => o.id).sort()).toEqual(['backtestStrategy', 'cancelOrder', 'closePosition', 'createAgent', 'createStrategy', 'placeOrder', 'previewOrder', 'reducePosition', 'startAgent', 'startStrategy', 'stopAgent', 'stopStrategy']);
    const before = (await sql`select count(*)::int as n from deriv_orders`)[0].n;
    for (const op of writes) {
      for (const who of [{ key: k.secret }, {}]) {
        const r = await send(op, { ...who, headers: idem() });
        expect(r.status, op.id).toBe(501);
        expect(r.status >= 200 && r.status < 300, op.id).toBe(false);
        expect(r.json.error, op.id).toBe('execution_not_wired');
      }
      // the checks in front of the handler are real: replay header, then validation
      expect((await send(op, { key: k.secret })).json.error, op.id).toBe('idempotency');
      if (op.body && Object.keys(BODY[op.id] as object).length) expect((await call(op.method, T + concrete(op.path), { key: k.secret, headers: idem(), body: { ...(BODY[op.id] as object), surprise: true } })).status, op.id).toBe(400);
    }
    expect((await sql`select count(*)::int as n from deriv_orders`)[0].n).toBe(before);                   // nothing was created
    expect((await sql`select count(*)::int as n from api_idempotency where principal = ${`key:${k.id}`}`)[0].n).toBe(0);   // a 501 is not stored as the answer of a key
    expect((await call('POST', `${T}/orders`, { key: k.secret, headers: idem(), body: { ...ORDER, size: '-1' } })).status).toBe(400);
    expect((await call('POST', `${T}/orders`, { key: k.secret, headers: { 'idempotency-key': 'short' }, body: ORDER })).status).toBe(400);
  });

  it('execution scopes are inert on a key without a mandate: 403 mandate_required before anything else', async () => {
    const k = await newKey({ scopes: ALL });
    expect(k.view.inertScopes).toEqual(['agents:manage', 'orders:cancel', 'orders:execute', 'positions:manage', 'strategies:manage']);
    for (const op of spec.OPERATIONS.filter((o) => !o.implemented)) {
      const r = await send(op, { key: k.secret, headers: idem() });
      if (spec.isExecutionScope(op.scope)) { expect(r.status, op.id).toBe(403); expect(r.json.error, op.id).toBe('mandate_required'); }
      else { expect(op.id).toBe('previewOrder'); expect(r.status).toBe(501); }
    }
  });
});

describe('replay protection (middleware)', () => {
  it('Idempotency-Key: same request → the stored answer; different request → 409; a stale X-SPW-Timestamp → 400', async () => {
    const w = await call('POST', `${DEV}/webhooks`, { body: { url: hookUrl, events: ['key.revoked'], label: 'idem' } });
    expect(w.status, JSON.stringify(w.json)).toBe(200);
    const id = w.json.webhook.id, key = `idem-${randomUUID()}`;
    expect((await call('POST', `${DEV}/webhooks/${id}`, { body: { label: 'a' } })).json.error).toBe('idempotency');
    const first = await call('POST', `${DEV}/webhooks/${id}`, { body: { label: 'first' }, headers: { 'idempotency-key': key } });
    expect(first.status).toBe(200);
    expect(first.headers['idempotent-replay']).toBeUndefined();
    await sql`update api_webhooks set label = 'changed behind' where id = ${id}`;
    const again = await call('POST', `${DEV}/webhooks/${id}`, { body: { label: 'first' }, headers: { 'idempotency-key': key } });
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.json).toEqual(first.json);
    expect((await sql`select label from api_webhooks where id = ${id}`)[0].label).toBe('changed behind');     // the handler did not run again
    const other = await call('POST', `${DEV}/webhooks/${id}`, { body: { label: 'second' }, headers: { 'idempotency-key': key } });
    expect(other.status).toBe(409);
    expect(other.json.error).toBe('idempotency_conflict');
    // a refusal (4xx) is an answer too: it is replayed, not re-run
    const k2 = `idem-${randomUUID()}`;
    const miss = await call('POST', `${DEV}/webhooks/wh_000000000000`, { body: { label: 'x' }, headers: { 'idempotency-key': k2 } });
    expect(miss.status).toBe(404);
    const miss2 = await call('POST', `${DEV}/webhooks/wh_000000000000`, { body: { label: 'x' }, headers: { 'idempotency-key': k2 } });
    expect([miss2.status, miss2.headers['idempotent-replay'], miss2.json.error]).toEqual([404, 'true', 'unknown_webhook']);
    // freshness window
    const now = Math.floor(Date.now() / 1000);
    for (const ts of [String(now - 301), String(now + 301), 'yesterday', '12']) expect((await call('POST', `${DEV}/webhooks/${id}`, { body: { label: 't' }, headers: { 'idempotency-key': `idem-${randomUUID()}`, 'x-spw-timestamp': ts } })).json.error, ts).toBe('stale_request');
    expect((await call('POST', `${DEV}/webhooks/${id}`, { body: { label: 't' }, headers: { 'idempotency-key': `idem-${randomUUID()}`, 'x-spw-timestamp': String(now) } })).status).toBe(200);
    // the namespace of a key is its own: the owner's Idempotency-Key does not collide with a key's
    const k = await newKey({ scopes: ['orders:prepare'] });
    expect((await call('POST', `${T}/orders/preview`, { key: k.secret, headers: { 'idempotency-key': key }, body: { mode: 'paper', instrument: BTC, side: 'buy', type: 'market', size: '0.01' } })).status).toBe(501);
    await call('DELETE', `${DEV}/webhooks/${id}`);
  });
});

describe('webhooks', () => {
  it('owner-managed endpoints; key.revoked is signed and delivered; a failing receiver is retried with backoff; the delivery log tells it', async () => {
    const { verifyWebhook } = await import('../src/alerts/webhook.ts');
    expect((await call('POST', `${DEV}/webhooks`, { body: { url: hookUrl, events: ['nope'] } })).status).toBe(400);
    hooks.configureWebhooks({ allowHttp: false, now: () => hookNow });
    expect((await call('POST', `${DEV}/webhooks`, { body: { url: hookUrl, events: ['key.revoked'] } })).json.error).toBe('bad_webhook_url');   // https only outside tests
    hooks.configureWebhooks({ allowHttp: true, now: () => hookNow });
    const w = await call('POST', `${DEV}/webhooks`, { body: { url: hookUrl, events: ['key.revoked', 'risk.kill_switch'], label: 'ops' } });
    expect(w.status).toBe(200);
    expect(w.json.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const id = w.json.webhook.id, secret = w.json.secret;
    expect(JSON.stringify(await sql`select * from api_webhooks`)).not.toContain(secret);                    // the signing secret is not in the database
    expect(JSON.stringify((await call('GET', `${DEV}/webhooks`)).json)).not.toContain(secret);

    received.length = 0; hookStatus = 200; hookNow = Date.now();
    const k = await newKey();
    await call('POST', `${DEV}/keys/${k.id}/revoke`, { body: { reason: 'test' } });
    await hooks.deliverDue();
    expect(received).toHaveLength(1);
    const d = received[0]!, body = JSON.parse(d.body);
    expect(body).toMatchObject({ app: 'sp-wallet', event: 'key.revoked', data: { keyId: k.id, reason: 'test' } });
    expect(d.headers['x-spw-event']).toBe('key.revoked');
    expect(verifyWebhook(secret, d.headers['x-spw-timestamp']!, d.headers['x-spw-signature']!, d.body, hookNow)).toBe(true);
    expect(verifyWebhook('whsec_wrong', d.headers['x-spw-timestamp']!, d.headers['x-spw-signature']!, d.body, hookNow)).toBe(false);
    expect(verifyWebhook(secret, d.headers['x-spw-timestamp']!, d.headers['x-spw-signature']!, d.body.replace('test', 'tampered'), hookNow)).toBe(false);
    expect(verifyWebhook(secret, d.headers['x-spw-timestamp']!, d.headers['x-spw-signature']!, d.body, hookNow + 301_000)).toBe(false);   // replay window
    expect(d.body).not.toContain(k.secret.split('_').slice(4).join('_'));

    // a receiver that fails: pending, attempt counted, next attempt 30 s later; then delivered
    received.length = 0; hookStatus = 500;
    const k2 = await newKey();
    await call('POST', `${DEV}/keys/${k2.id}/revoke`, { body: {} });
    await hooks.deliverDue();
    let log = (await call('GET', `${DEV}/webhooks/deliveries?webhook=${id}`)).json.deliveries;
    expect(log[0]).toMatchObject({ event: 'key.revoked', state: 'pending', attempts: 1, lastStatus: 500 });
    expect(log[0].nextAttemptAt - hookNow).toBe(30_000);
    const n = received.length;
    await hooks.deliverDue();
    expect(received.length).toBe(n);                                                                     // not due yet: no tight loop
    hookStatus = 200; hookNow += 31_000;
    expect(await hooks.deliverDue()).toEqual({ sent: 1, failed: 0 });
    log = (await call('GET', `${DEV}/webhooks/deliveries?webhook=${id}`)).json.deliveries;
    expect(log[0]).toMatchObject({ state: 'delivered', attempts: 2, lastStatus: 200 });
    // six failed attempts end the delivery
    hookStatus = 503;
    const k3 = await newKey();
    await call('POST', `${DEV}/keys/${k3.id}/revoke`, { body: {} });
    for (let a = 0; a < hooks.WEBHOOK_MAX_ATTEMPTS + 1; a++) { await hooks.deliverDue(); hookNow += 22_000_000; }
    log = (await call('GET', `${DEV}/webhooks/deliveries?webhook=${id}`)).json.deliveries;
    expect(log[0]).toMatchObject({ state: 'failed', attempts: hooks.WEBHOOK_MAX_ATTEMPTS, nextAttemptAt: null });
    expect((await call('GET', `${DEV}/webhooks`)).json.webhooks.find((x: any) => x.id === id).failures).toBeGreaterThanOrEqual(hooks.WEBHOOK_MAX_ATTEMPTS);

    // a disabled endpoint receives nothing; a new secret replaces the old one; deletion removes the secret
    hookStatus = 200; received.length = 0;
    await call('POST', `${DEV}/webhooks/${id}`, { body: { enabled: false }, headers: idem() });
    const k4 = await newKey();
    await call('POST', `${DEV}/keys/${k4.id}/revoke`, { body: {} });
    await hooks.deliverDue();
    expect(received).toHaveLength(0);
    await call('POST', `${DEV}/webhooks/${id}`, { body: { enabled: true }, headers: idem() });
    const rot = await call('POST', `${DEV}/webhooks/${id}/secret`, { body: {} });
    expect(rot.json.secret).not.toBe(secret);
    const k5 = await newKey();
    await call('POST', `${DEV}/keys/${k5.id}/revoke`, { body: {} });
    await hooks.deliverDue();
    expect(verifyWebhook(rot.json.secret, received[0]!.headers['x-spw-timestamp']!, received[0]!.headers['x-spw-signature']!, received[0]!.body, hookNow)).toBe(true);
    expect((await call('DELETE', `${DEV}/webhooks/${id}`)).status).toBe(200);
    const { webhookSecretOf } = await import('../src/trading-api/secrets.ts');
    expect(webhookSecretOf(id)).toBeNull();
    expect((await audits('webhook.created')).length).toBeGreaterThan(0);
  });
});

describe('usage, status, retention', () => {
  it('the usage log holds route patterns and statuses — no query string, no body, no secret; old rows are pruned', async () => {
    const k = await newKey();
    await call('GET', `${T}/markets?venue=hyperliquid&q=SECRETQUERY&limit=1`, { key: k.secret });
    await call('GET', `${T}/markets/${BTC}/candles?limit=2`, { key: k.secret });
    const u = await call('GET', `${DEV}/usage?key=${k.id}`);
    expect(u.status).toBe(200);
    expect(u.json.items.map((x: any) => `${x.method} ${x.route} ${x.status}`)).toEqual([`GET ${T}/markets/:symbol/candles 200`, `GET ${T}/markets 200`]);
    expect(u.json.perKey.find((x: any) => x.keyId === k.id)).toMatchObject({ calls24h: 2, errors24h: 0, callsLastMinute: 2 });
    const dump = JSON.stringify(await sql`select * from api_key_usage`);
    expect(dump).not.toContain('SECRETQUERY');
    expect(dump).not.toContain(k.secret.split('_').slice(4).join('_'));
    expect(dump).not.toContain('Bearer');
    expect((await sql`select last_used_at from api_keys where id = ${k.id}`)[0].last_used_at).not.toBeNull();
    await sql`insert into api_key_usage (key_id, ts, method, route, status, latency_ms, request_id) values (${k.id}, now() - interval '91 days', 'GET', '/old', 200, 1, 'old')`;
    await sql`insert into api_idempotency (principal, key, request_hash, created_at) values ('owner', 'old-key-0001', 'h', now() - interval '2 days')`;
    expect(await principal.pruneTradingApi()).toMatchObject({ usage: 1, idempotency: 1 });
    expect((await sql`select count(*)::int as n from api_key_usage where route = '/old'`)[0].n).toBe(0);
  });

  it('GET /developer/status: the services as they are — execution is reported NOT wired', async () => {
    const s = await call('GET', `${DEV}/status`);
    expect(s.status).toBe(200);
    const by = Object.fromEntries(s.json.services.map((x: any) => [x.id, x]));
    expect(by.database.ok).toBe(true);
    expect(by.signer.ok).toBe(true);
    expect(by['venue:hyperliquid'].ok).toBe(true);
    expect(by.execution).toMatchObject({ ok: false });
    expect(by['market-data'].ok).toBe(false);                                                            // nothing ingested in this database
    expect(s.json.api).toMatchObject({ prefix: T, operations: spec.OPERATIONS.length, implemented: 18 });   // 14 reads + the 3 private-markets reads + compareMarkets (v11)
    expect(s.json.api.notImplemented).toHaveLength(12);
    expect(s.json.rateLimits).toMatchObject({ defaultPerMin: 120, failedAuthPerMinPerAddress: 10 });
  });

  it('existing owner actions are webhook sources: an agent mode change emits agent.updated', async () => {
    const w = await call('POST', `${DEV}/webhooks`, { body: { url: hookUrl, events: ['agent.updated'] } });
    received.length = 0; hookStatus = 200;
    const [a] = await sql`select id from agents limit 1`;
    const r = await call('POST', `/api/v1/agents/${a.id}/mode`, { body: { mode: 'PAUSED' } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    for (let k = 0; k < 40 && received.length === 0; k++) { await new Promise((res) => setTimeout(res, 25)); await hooks.deliverDue(); }
    expect(JSON.parse(received[0]!.body)).toMatchObject({ event: 'agent.updated', data: { agentId: a.id, state: 'PAUSED' } });
    await call('DELETE', `${DEV}/webhooks/${w.json.webhook.id}`);
  });
});
