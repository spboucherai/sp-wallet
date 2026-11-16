// The real local API for the STREAM integration tests of the two SDKs (packages/trading-sdk/test/stream.integration.test.ts,
// sdk/python/tests/test_stream_integration.py): buildServer on an own per-run database, the REAL venue adapters (public market
// data), the real websocket server on a local port. No signer and no owner ceremony are needed to read market data: the API
// keys are written straight into the key table with the server's own hash (what the owner routes do after the passkey).
//
//   npx tsx packages/trading-sdk/scripts/stream-stack.mts <label>
//   stdout, ONE line: {"ok":true,"baseUrl":"http://127.0.0.1:PORT","keys":{"reader":{id,secret},"narrow":…,"limited":…,"revoked":…}}
//                  or {"ok":false,"skip":true,"reason":"…"} when PostgreSQL is not reachable
//   stops (server closed, database dropped) when stdin closes.
//
//   reader   every read scope            narrow   markets:read only            limited  agents:read only (no markets:read)
//   revoked  markets:read, revoked       venues   markets:read, restricted to the venue `hyperliquid`
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, type TestDb } from '../../../services/api/test/test-db.ts';

const label = (process.argv[2] ?? 'stream').replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'stream';
const out = (m: unknown): void => { process.stdout.write(`${JSON.stringify(m)}\n`); };
let db: TestDb;
try { db = await createTestDb(`sdk_${label}`); }
catch (e) { out({ ok: false, skip: true, reason: `PostgreSQL is not reachable (${(e as Error).message.split('\n')[0]})` }); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), 'spw-sdk-stream-'));
const port: number = await new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });
const base = `http://127.0.0.1:${port}`;
Object.assign(process.env, { SPW_ORIGIN: base, SPW_RP_ID: '127.0.0.1', DATABASE_URL: db.url, SPW_SIGNER_SECRET: 'unused-'.repeat(8), SPW_SIGNER_URL: 'http://127.0.0.1:9', SPW_BROADCAST: 'off', SPW_WORKERS: 'off',
  SPW_DATA_DIR: dir, SPW_API_KEY_PEPPER: 'stream-stack-pepper-'.repeat(3) });

try {
  const { migrate, sql } = await import('../../../services/api/src/db.ts');
  await migrate();
  const km = await import('../../../services/api/src/trading-api/key-model.ts');
  const { apiKeyPepper } = await import('../../../services/api/src/trading-api/secrets.ts');
  const READS = ['wallet:read', 'markets:read', 'orders:read', 'positions:read', 'strategies:read', 'agents:read'];
  const newKey = async (name: string, scopes: string[], o: { venues?: string[]; revoked?: boolean } = {}) => {
    const id = km.newKeyId(), secret = km.newKeySecret();
    await sql`insert into api_keys (id, name, secret_hash, scopes, limits, restrictions, rate_limit_per_min, expires_at, revoked_at, revoked_reason)
      values (${id}, ${name}, ${km.hashSecret(apiKeyPepper(), id, secret)}, ${scopes}, ${sql.json({})}, ${sql.json({ networks: [], venues: o.venues ?? [], instruments: [], ipAllow: [] })}, 600, now() + interval '1 day',
        ${o.revoked ? new Date() : null}, ${o.revoked ? 'sdk stream integration test' : null})`;
    return { id, secret: km.formatToken(id, secret) };
  };
  const keys = { reader: await newKey('sdk stream reader', READS), narrow: await newKey('sdk stream narrow', ['markets:read']), limited: await newKey('sdk stream limited', ['agents:read']),
    revoked: await newKey('sdk stream revoked', ['markets:read'], { revoked: true }), venues: await newKey('sdk stream venues', ['markets:read'], { venues: ['hyperliquid'] }) };
  const { buildServer } = await import('../../../services/api/src/server.ts');
  const app = await buildServer();
  await app.listen({ port, host: '127.0.0.1' });
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await app.close().catch(() => {}); await sql.end({ timeout: 2 }).catch(() => {}); await db.drop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  };
  process.stdin.on('end', () => { void stop(); }); process.stdin.on('close', () => { void stop(); }); process.stdin.resume();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void stop(); });
  out({ ok: true, baseUrl: base, keys });
} catch (e) {
  out({ ok: false, skip: false, reason: (e as Error).message.split('\n')[0] });
  await db.drop().catch(() => {}); rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}
