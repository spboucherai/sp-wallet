// Integration-test stack of the two SDKs (TypeScript and Python): the REAL API and the REAL isolated signer, started the way
// scripts/dev-stack.sh does it (bundles of scripts/build.mjs, throwaway signer keystore, broadcast off), on free ports and on
// an own per-run database (services/api/test/test-db.ts). Then the owner flow of scripts/demo-trading-api.mts: setup with a
// software passkey, and API keys created through the routes (prepare → passkey assertion → create).
//
//   node_modules/.bin/tsx packages/trading-sdk/scripts/test-stack.mts [label]
//
// Protocol (one JSON line on stdout, then the process stays up until stdin closes or it receives SIGTERM/SIGINT):
//   {"ok":true,"baseUrl":"http://localhost:<port>","keys":{…},"webhook":{…}}
//   {"ok":false,"skip":true,"reason":"…"}      PostgreSQL is not reachable: the caller reports its tests as SKIPPED
//   {"ok":false,"skip":false,"reason":"…"}     anything else: the caller FAILS
// On exit the two processes are killed, the database is dropped and the temporary directory removed.
// Nothing here can sign a transaction or place an order: no venue account exists and broadcast is off.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, type TestDb } from '../../../services/api/test/test-db.ts';
import { webhookSignature } from '../../../services/api/src/alerts/webhook.ts';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const label = (process.argv[2] ?? 'sdk').replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'sdk';
const say = (o: unknown): void => { process.stdout.write(JSON.stringify(o) + '\n'); };
const children: ChildProcess[] = [];
let db: TestDb | null = null, dir = '', closing = false;

async function shutdown(code: number): Promise<never> {
  if (!closing) {
    closing = true;
    for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
    await new Promise((r) => setTimeout(r, 150));
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    try { await db?.drop(); } catch { /* the global teardown or clean-test-dbs.sh removes it */ }
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  process.exit(code);
}
const freePort = (): Promise<number> => new Promise((res, rej) => { const s = createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });

async function main(): Promise<void> {
  try { db = await createTestDb(`sdk_${label}_${randomBytes(2).toString('hex')}`); }
  catch (e) { say({ ok: false, skip: true, reason: `PostgreSQL is not reachable: ${(e as Error).message || (e as { code?: string }).code || 'connection failed'}` }); process.exit(0); }

  execFileSync('node', ['scripts/build.mjs'], { cwd: ROOT, stdio: 'ignore' }); // the bundles the production processes run
  dir = mkdtempSync(path.join(tmpdir(), 'spw-sdk-stack-'));
  const port = await freePort(), signerPort = await freePort(), base = `http://localhost:${port}`;
  const signerEnv = { ...process.env, SPW_SIGNER_DIR: `${dir}/signer`, SPW_SIGNER_WRAP_KEY: `${dir}/wrap/wrap.key`, SPW_SIGNER_SECRET: randomBytes(32).toString('hex'),
    SPW_ORIGIN: base, SPW_RP_ID: 'localhost', SPW_SIGNER_PORT: String(signerPort) };
  execFileSync('node', ['dist/signer.mjs', 'init'], { cwd: ROOT, env: signerEnv, stdio: 'ignore' });
  const setupToken = execFileSync('node', ['dist/signer.mjs', 'setup-token'], { cwd: ROOT, env: signerEnv, encoding: 'utf8' }).trim();
  children.push(spawn('node', ['dist/signer.mjs', 'serve'], { cwd: ROOT, env: signerEnv, stdio: 'ignore' }));
  const api = spawn('node', ['dist/api.mjs'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...signerEnv, DATABASE_URL: db.url, SPW_SIGNER_URL: `http://127.0.0.1:${signerPort}`, PORT: String(port), SPW_BROADCAST: 'off', SPW_DATA_DIR: `${dir}/data` } });
  children.push(api);
  let apiErr = ''; api.stderr!.on('data', (c: Buffer) => { apiErr = (apiErr + c.toString()).slice(-2000); });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { up = await fetch(`${base}/api/v1/health/live`).then((r) => r.ok, () => false); if (!up) await new Promise((r) => setTimeout(r, 250)); }
  if (!up) throw new Error(`the API did not start: ${apiErr.slice(-400)}`);

  // ---- owner setup and session (software passkey), as scripts/demo-trading-api.mts
  const owner = new TestPasskey('localhost', base);
  let cookie = '';
  async function ownerCall(method: string, p: string, body?: unknown): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await fetch(base + p, { method, headers: { origin: base, 'x-spw-csrf': '1', ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!;
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`);
    return j;
  }
  const o = await ownerCall('POST', '/api/v1/auth/setup/options', {});
  await ownerCall('POST', '/api/v1/auth/setup/verify', { challengeId: o.challengeId, response: owner.register(o.options.challenge), setupToken });

  const ALL = ['wallet:read', 'markets:read', 'orders:read', 'orders:prepare', 'orders:execute', 'orders:cancel', 'positions:read', 'positions:manage', 'strategies:read', 'strategies:manage', 'agents:read', 'agents:manage'];
  const READS = ALL.filter((s) => s.endsWith(':read'));
  async function newKey(name: string, body: Record<string, unknown>): Promise<{ id: string; secret: string }> {
    const p = await ownerCall('POST', '/api/v1/developer/keys/prepare', { name, expiresInDays: 1, ...body });
    const c = await ownerCall('POST', '/api/v1/developer/keys', { intentId: p.intentId, assertion: owner.assert(Buffer.from(p.options.challenge, 'base64url')) });
    return { id: c.key.id, secret: c.secret };
  }
  const keys = {
    /** every read scope + orders:prepare (not an execution scope) */
    reader: await newKey('sdk reader', { scopes: [...READS, 'orders:prepare'], rateLimitPerMin: 600 }),
    /** every scope, bound to a mandate id: reaches the handler of each write operation */
    trader: await newKey('sdk trader', { scopes: ALL, mandateId: randomUUID(), rateLimitPerMin: 600 }),
    /** every scope, NO mandate: execution scopes are inert (403 mandate_required) */
    unbound: await newKey('sdk unbound', { scopes: ALL, rateLimitPerMin: 600 }),
    /** markets:read only */
    narrow: await newKey('sdk narrow', { scopes: ['markets:read'], rateLimitPerMin: 600 }),
    /** 3 calls a minute */
    limited: await newKey('sdk limited', { scopes: ['agents:read'], rateLimitPerMin: 3 }),
    /** revoked below */
    revoked: await newKey('sdk revoked', { scopes: READS }),
  };
  await ownerCall('POST', `/api/v1/developer/keys/${keys.revoked.id}/revoke`, { reason: 'sdk integration test' });

  // a webhook signature produced by the server's own code (services/api/src/alerts/webhook.ts)
  const secret = randomBytes(32).toString('base64url'), timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ app: 'sp-wallet', id: randomUUID(), event: 'key.revoked', ts: new Date().toISOString(), data: { keyId: keys.revoked.id, name: 'sdk revoked', reason: 'sdk integration test — é ü 漢' } });
  say({ ok: true, baseUrl: base, keys, webhook: { secret, timestamp, body, signature: webhookSignature(secret, timestamp, body) } });
}

process.on('SIGTERM', () => { void shutdown(0); });
process.on('SIGINT', () => { void shutdown(0); });
process.stdin.on('end', () => { void shutdown(0); });
process.stdin.on('close', () => { void shutdown(0); });
process.stdin.resume();
main().catch((e: unknown) => { say({ ok: false, skip: false, reason: (e as Error).message }); void shutdown(1); });
