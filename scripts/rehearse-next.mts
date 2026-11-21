/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/rehearse-next.mts
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
 * Last Modified    : 2026-11-19
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// Pre-production rehearsal of NEXT — READ-ONLY against the real chains, on a RESTORED COPY of the production database.
//
//   DATABASE_URL=postgres://127.0.0.1/<restored copy> npx tsx scripts/rehearse-next.mts
//
// What it is: the NEXT server code booted on real data (migration included), with the wallet's real PUBLIC addresses (read from
// the copy's own `signerAddresses` setting), reading the real networks through the registry's public endpoints.
// What it cannot do, by construction: sign (the "signer" is a stub that answers `GET /status` and nothing else — no key
// exists in this process), relay (SPW_BROADCAST=off), run agents, strategies, venue workers or alert delivery
// (SPW_WORKERS=off; the loops under test are called by hand). It refuses to run on a database named like the live one.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import dns from 'node:dns';
import net from 'node:net';

const url = process.env.DATABASE_URL ?? '';
if (!/\/spw_[a-z0-9_]*(rehearsal|restore|staging)[a-z0-9_]*$/.test(url)) { console.error('rehearsal: DATABASE_URL must name a restored copy (…rehearsal / …restore / …staging)'); process.exit(2); }
dns.setDefaultResultOrder('ipv4first'); net.setDefaultAutoSelectFamilyAttemptTimeout(2500);

// the stub: a real status SHAPE from a throwaway signer, with the copy's public addresses and passkey ids in it
const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
const { deriveKeys } = await import('../services/isolated-signer/src/keys.ts');
const { Signer } = await import('../services/isolated-signer/src/signer.ts');
const { Store } = await import('../services/isolated-signer/src/store.ts');
const { generateMnemonic } = await import('@scure/bip39'); const { wordlist } = await import('@scure/bip39/wordlists/english.js');
const dir = mkdtempSync(join(tmpdir(), 'spw-rehearsal-'));
const shape = new Signer(deriveKeys(generateMnemonic(wordlist, 256)), new Store(join(dir, 'state.json'), join(dir, 'policy.json')), { rpId: 'wallet.rehearsal', origin: 'https://wallet.rehearsal' }).status() as Record<string, unknown>;
let status: Record<string, unknown> = shape; // completed below with the copy's public addresses and passkey ids
let signerCalls: string[] = [];
const stub = createServer((req, res) => { signerCalls.push(`${req.method} ${req.url}`); req.resume();
  if (req.method === 'GET' && req.url === '/status') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(status)); return; }
  res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'rehearsal', message: 'the rehearsal signer signs nothing' })); }).listen(0, '127.0.0.1');
await new Promise((r) => stub.once('listening', r));

Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.rehearsal', SPW_RP_ID: 'wallet.rehearsal', SPW_SIGNER_SECRET: randomBytes(32).toString('hex'),
  SPW_SIGNER_URL: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`, SPW_BROADCAST: 'off', SPW_WORKERS: 'off', SPW_DATA_DIR: join(dir, 'data'), NODE_ENV: 'production' });

const out: string[] = [];
const say = (s: string) => { out.push(s); console.log(s); };
const timed = async <T>(label: string, f: () => Promise<T>, show?: (v: T) => string): Promise<T | null> => {
  const t = Date.now();
  try { const v = await f(); say(`ok    ${String(Date.now() - t).padStart(6)} ms  ${label}${show ? '  — ' + show(v) : ''}`); return v; }
  catch (e) { say(`FAIL  ${String(Date.now() - t).padStart(6)} ms  ${label}  — ${(e as Error).message.slice(0, 200)}`); return null; }
};

const db = await import('../services/api/src/db.ts');
const [sa] = await db.sql<{ value: { keyId: string; addresses: Record<string, string> } }[]>`select value from settings where key = 'signerAddresses'`;
if (!sa) { console.error('rehearsal: the copy has no signerAddresses setting'); process.exit(2); }
const creds = await db.sql<{ id: string; created_at: Date }[]>`select id, created_at from credentials`;
status = { ...shape, keyId: sa.value.keyId, addresses: sa.value.addresses, credentials: creds.map((c) => ({ id: c.id, addedAt: c.created_at.toISOString(), createdAt: c.created_at.toISOString(), lastUsedAt: null, inCooldown: false, cooldownUntil: null })) };
await timed('migrate (pass 1)', () => db.migrate());
await timed('migrate (pass 2, must change nothing)', () => db.migrate());
const before = await db.sql<{ p: number; d: number; a: number }[]>`select (select count(*)::int from proposals) as p, (select count(*)::int from deposits) as d, (select count(*)::int from audit_events) as a`;
const app = await (await import('../services/api/src/server.ts')).buildServer();
const token = randomBytes(32).toString('base64url');
await db.sql`insert into sessions (id_hash, expires_at, ua) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour', 'rehearsal')`;
const { COOKIE } = await import('../services/api/src/auth.ts');
const get = (path: string) => timed(`GET ${path}`, async () => { const r = await app.inject({ method: 'GET', url: path, headers: { cookie: `${COOKIE}=${token}` } }); if (r.statusCode !== 200) throw new Error(`${r.statusCode} ${r.body.slice(0, 160)}`); return r.headers['content-type']?.toString().includes('json') ? r.json() : r.body; },
  (v: any) => path.startsWith('/api/v1/portfolio/history') ? `${v.points.length} points, omitted incomplete ${v.omitted?.incomplete}`
    : path === '/api/v1/portfolio' ? `${v.balances.length} rows, ${v.balances.filter((b: any) => b.amount === null).length} unavailable, ${v.balances.filter((b: any) => b.agreed === false && b.amount !== null).length} disagreeing, summary complete=${v.summary?.complete} missing=${v.summary?.missing?.length} uncertain=${v.summary?.uncertain?.length} unpriced=${v.summary?.unpriced?.length}`
    : path.startsWith('/api/v1/events') ? `${v.events.length} events, latest ${v.latest}`
    : path.startsWith('/api/v1/security/overview') ? `signer reachable=${v.signer?.reachable !== false}, passkeys api=${v.devices?.length} signer=${v.signerCredentials?.length}, mismatch=${JSON.stringify(v.mismatch)}`
    : path.startsWith('/api/v1/search') ? `assets ${v.assets?.items?.length} contacts ${v.contacts?.items?.length} transactions ${v.transactions?.items?.length}`
    : path.startsWith('/api/v1/analytics') ? `flows assets ${v.flows?.byAsset?.length}, fee networks ${v.fees?.byNetwork?.length}, outcomes ${v.outcomes?.total}`
    : Array.isArray(v) ? `${v.length} rows` : typeof v === 'string' ? `${v.length} bytes` : Object.keys(v).slice(0, 6).join(','));

const worker = await import('../services/api/src/worker.ts');
const portfolio = await import('../services/api/src/portfolio.ts');
await timed('health of the 23 networks', () => worker.refreshHealth(), () => { const h = [...worker.healthCache.values()]; return `${h.filter((x) => x.ok).length}/${h.length} ok, readable ${h.filter((x) => x.readable).length}; not ok: ${h.filter((x) => !x.ok).map((x) => x.network).join(', ') || 'none'}`; });
await get('/api/v1/portfolio');
await get('/api/v1/portfolio');
await timed('deposit scan, pass 1 (all networks, incl. native EVM detection)', () => worker.scanDeposits());
await timed('deposit scan, pass 2 (steady state)', () => worker.scanDeposits());
await timed('reconcile (no transfer in flight expected)', () => worker.reconcile());
await timed('portfolio snapshot', () => portfolio.snapshotTick());
await get('/api/v1/portfolio/history?range=1W');
await get('/api/v1/portfolio/history?range=ALL');
await get('/api/v1/analytics?range=ALL');
await get('/api/v1/search?q=usdc');
await get('/api/v1/activity?limit=50');
await get('/api/v1/dashboard/activity');
await get('/api/v1/events?after=0');
await get('/api/v1/security/overview');
await get('/api/v1/security/logins');
await get('/api/v1/contacts');
await get('/api/v1/assets/prefs');
await get('/api/v1/settings');
await get('/api/v1/openapi.json');
await get('/api/v1/health/ready');

const after = await db.sql<{ p: number; d: number; a: number; e: number; s: number }[]>`select (select count(*)::int from proposals) as p, (select count(*)::int from deposits) as d, (select count(*)::int from audit_events) as a, (select count(*)::int from wallet_events) as e, (select count(*)::int from portfolio_snapshots) as s`;
const newDeposits = await db.sql`select network, asset, kind, detection, count(*)::int as n from deposits where seen_at > now() - interval '30 minutes' group by 1,2,3,4 order by 1`;
const chain = await db.auditList(1);
say(`rows  proposals ${before[0]!.p} → ${after[0]!.p}; deposits ${before[0]!.d} → ${after[0]!.d}; audit ${before[0]!.a} → ${after[0]!.a} (chain intact: ${chain.intact}); wallet events ${after[0]!.e}; snapshots ${after[0]!.s}`);
say(`new deposits recorded by the scan: ${newDeposits.length ? newDeposits.map((d) => `${d.network}/${d.asset} ${d.kind} ${d.detection ?? ''} ×${d.n}`).join('; ') : 'none'}`);
say(`signer stub received: ${[...new Set(signerCalls)].join(', ') || 'nothing'} (${signerCalls.length} calls); anything but GET /status would have been refused`);
await app.close(); stub.close(); await db.sql.end();
process.exit(out.some((l) => l.startsWith('FAIL')) ? 1 : 0);
