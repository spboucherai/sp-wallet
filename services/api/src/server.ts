import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import { formatUnits, getNetwork, NETWORKS, normalizeAddress, type NetworkId } from '@spw/core';
import { authRoutes, deviceRoutes, isAuthed, listCreds } from './auth.ts';
import { adapters } from './chains/index.ts';
import { http } from './chains/rpc.ts';
import { config, secureCookies, UserError } from './config.ts';
import { audit, auditList, getSetting, setSetting, sql } from './db.ts';
import { signer } from './signer-client.ts';
import { transferRoutes, view, type ProposalRow } from './transfers.ts';
import { healthCache } from './worker.ts';

const PUBLIC = new Set(['/api/v1/health/live', '/api/v1/auth/state', '/api/v1/auth/setup/options', '/api/v1/auth/setup/verify', '/api/v1/auth/login/options', '/api/v1/auth/login/verify', '/api/v1/auth/logout']);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ttlMs) return c.v as T;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}

const COINGECKO: Record<string, string> = { ETH: 'ethereum', BTC: 'bitcoin', SOL: 'solana', USDC: 'usd-coin', POL: 'polygon-ecosystem-token' };
async function prices(): Promise<Record<string, { usd: number; cad: number }> | null> {
  if (!(await getSetting('prices', true))) return null;
  return cached('prices', 5 * 60_000, async () => {
    try { // only asset ids are sent; never addresses or balances
      const r = await http(`https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(COINGECKO).join(',')}&vs_currencies=usd,cad`);
      if (!r.ok) return null;
      const j = (await r.json()) as Record<string, { usd: number; cad: number }>;
      return Object.fromEntries(Object.entries(COINGECKO).flatMap(([sym, id]) => (j[id] ? [[sym, j[id]]] : [])));
    } catch { return null; }
  });
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: 'warn', redact: ['req.headers.cookie', 'req.headers.authorization'] }, bodyLimit: 64 * 1024, trustProxy: config.trustProxy });
  await app.register(cookie);
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('content-security-policy', CSP).header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer')
      .header('x-frame-options', 'DENY').header('x-robots-tag', 'noindex, nofollow, noarchive')
      .header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=(self), publickey-credentials-create=(self)')
      .header('cross-origin-opener-policy', 'same-origin').header('cross-origin-resource-policy', 'same-origin');
    if (secureCookies) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/api/')) return;
    reply.header('cache-control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // CSRF: strict same-origin + custom header (cannot be set cross-site without CORS, which is never enabled)
      if (req.headers.origin !== config.origin || req.headers['x-spw-csrf'] !== '1') throw new UserError('csrf', 'cross-site request refused', 403);
    }
    if (!PUBLIC.has(path) && !(await isAuthed(req))) throw new UserError('unauthenticated', 'authentication required', 401);
  });

  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number };
    if (e instanceof UserError) return reply.status(e.status).send({ error: e.code, message: e.message });
    if (e instanceof ZodError) return reply.status(400).send({ error: 'bad_request', message: 'invalid request' });
    if (e.statusCode === 429) return reply.status(429).send({ error: 'rate_limited', message: 'too many requests' });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: 'bad_request', message: 'invalid request' });
    req.log.error({ msg: e.message, path: req.url.split('?')[0] });
    return reply.status(500).send({ error: 'internal', message: 'internal error' });
  });

  authRoutes(app);
  deviceRoutes(app);
  transferRoutes(app);

  app.get('/api/v1/health/live', async () => ({ ok: true }));
  app.get('/api/v1/health/ready', async () => {
    const db = await sql`select 1`.then(() => true, () => false);
    const s = await signer.status().then((x) => ({ ok: true, halted: x.halted }), () => ({ ok: false, halted: null }));
    return { db, signer: s, networks: [...healthCache.values()] };
  });

  app.get('/api/v1/networks', async () => Object.values(NETWORKS).map((n) => ({
    id: n.id, name: n.name, family: n.family, chainRef: n.chainRef, native: n.native, tokens: n.tokens, explorerAddr: n.explorerAddr, minConf: n.minConf,
    health: healthCache.get(n.id) ?? null })));
  app.get('/api/v1/assets', async (req) => {
    const q = z.object({ network: z.string().optional() }).parse(req.query);
    return Object.values(NETWORKS).filter((n) => !q.network || n.id === q.network).flatMap((n) => [n.native, ...n.tokens].map((a) => ({ network: n.id, ...a })));
  });

  // One vault, one signer-derived address per chain family. Addresses come from the signer, never from the client.
  app.get('/api/v1/accounts', async () => {
    const st = await signer.status();
    return { keyId: st.keyId, accounts: Object.values(NETWORKS).map((n) => ({ network: n.id, name: n.name, family: n.family, address: st.addresses[n.family], explorer: n.explorerAddr + st.addresses[n.family] })) };
  });

  app.get('/api/v1/portfolio', async () => {
    const st = await signer.status();
    const px = await prices();
    const rows = await Promise.all(Object.values(NETWORKS).map(async (n) => {
      const address = st.addresses[n.family];
      try {
        const b = await cached(`bal:${n.id}`, 12_000, () => adapters[n.id].balances(address));
        return [n.native, ...n.tokens].map((a) => ({ network: n.id, networkName: n.name, asset: a.id, symbol: a.symbol, name: a.name, decimals: a.decimals,
          amount: (b[a.id] ?? 0n).toString(), display: formatUnits(b[a.id] ?? 0n, a.decimals), error: null as string | null }));
      } catch {
        return [n.native, ...n.tokens].map((a) => ({ network: n.id, networkName: n.name, asset: a.id, symbol: a.symbol, name: a.name, decimals: a.decimals, amount: null, display: null, error: 'unavailable' }));
      }
    }));
    const pending = await sql<ProposalRow[]>`select * from proposals where state in ('pending_approval','approved','signed','broadcast','confirming','reorged') order by created_at desc`;
    return { asOf: new Date().toISOString(), prices: px, balances: rows.flat(), pending: pending.map(view), halted: st.halted };
  });

  app.get('/api/v1/activity', async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const out = await sql<ProposalRow[]>`select * from proposals where state <> 'draft' order by created_at desc limit ${q.limit}`;
    const dep = await sql<{ network: string; txid: string; idx: number; asset: string; amount: string; from_addr: string; block: string; block_time: Date | null; seen_at: Date; finalized: string | null }[]>`
      select d.*, c.finalized from deposits d left join scan_cursor c on c.network = d.network order by coalesce(d.block_time, d.seen_at) desc limit ${q.limit}`;
    const items = [
      ...out.map((p) => ({ kind: 'send' as const, at: p.created_at, ...view(p) })),
      ...dep.map((d) => {
        const n = getNetwork(d.network), a = d.asset === 'native' ? n.native : n.tokens.find((t) => t.id === d.asset)!;
        return { kind: 'receive' as const, at: d.block_time ?? d.seen_at, id: `${d.network}:${d.txid}:${d.idx}`, network: d.network, networkName: n.name, asset: d.asset, symbol: a.symbol,
          decimals: a.decimals, amount: d.amount, amountDisplay: formatUnits(BigInt(d.amount), a.decimals), from: d.from_addr, txid: d.txid, explorer: n.explorerTx + d.txid,
          state: Number(d.block) <= Number(d.finalized ?? 0) ? 'finalized' : 'confirming' };
      }),
    ].sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime()).slice(0, q.limit);
    return { items };
  });

  app.get('/api/v1/export/activity.csv', async (_req, reply) => {
    const out = await sql<ProposalRow[]>`select * from proposals where state <> 'draft' order by created_at`;
    const dep = await sql`select * from deposits order by seen_at`;
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
    const lines = ['time_utc,direction,network,symbol,amount_base_units,amount,counterparty,state,txid,fee_estimate_base_units'];
    for (const p of out) lines.push([p.created_at.toISOString(), 'send', p.network, p.symbol, p.amount, formatUnits(BigInt(p.amount), p.decimals), p.to_addr, p.state, p.txid, p.fee_estimate].map(esc).join(','));
    for (const d of dep) { const n = getNetwork(d.network), a = d.asset === 'native' ? n.native : n.tokens.find((t) => t.id === d.asset)!;
      lines.push([(d.block_time ?? d.seen_at).toISOString(), 'receive', d.network, a.symbol, d.amount, formatUnits(BigInt(d.amount), a.decimals), d.from_addr, 'confirmed', d.txid, ''].map(esc).join(',')); }
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="sp-wallet-activity.csv"').send(lines.join('\n') + '\n');
  });

  app.get('/api/v1/addressbook', async () => sql`select id, network, address, label, created_at from address_book order by label`);
  app.post('/api/v1/addressbook', async (req) => {
    const b = z.strictObject({ network: z.string().max(20), address: z.string().max(100), label: z.string().min(1).max(40) }).parse(req.body);
    let address: string;
    try { address = normalizeAddress(getNetwork(b.network).id, b.address); } catch (e) { throw new UserError('bad_address', (e as Error).message); }
    const [r] = await sql`insert into address_book (id, network, address, label) values (${crypto.randomUUID()}, ${b.network}, ${address}, ${b.label})
      on conflict (network, address) do update set label = excluded.label returning id, network, address, label`;
    await audit('addressbook.saved', 'owner', { network: b.network, address, label: b.label });
    return r;
  });
  app.delete('/api/v1/addressbook/:id', async (req) => {
    const id = z.uuid().parse((req.params as { id: string }).id);
    const [r] = await sql`delete from address_book where id = ${id} returning network, address`;
    if (r) await audit('addressbook.removed', 'owner', { network: r.network, address: r.address });
    return { ok: true };
  });

  const Settings = z.strictObject({ locale: z.enum(['fr', 'en']), currency: z.enum(['USD', 'CAD']), hideBalances: z.boolean(), prices: z.boolean() });
  const readSettings = async () => ({ locale: await getSetting('locale', 'fr'), currency: await getSetting('currency', 'CAD'), hideBalances: await getSetting('hideBalances', false), prices: await getSetting('prices', true) });
  app.get('/api/v1/settings', readSettings);
  app.put('/api/v1/settings', async (req) => {
    const b = Settings.partial().parse(req.body);
    for (const [k, v] of Object.entries(b)) await setSetting(k, v);
    cache.delete('prices');
    return readSettings();
  });

  app.get('/api/v1/security/overview', async () => {
    const st = await signer.status(true).catch(() => null);
    const devices = (await listCreds()).map((c) => ({ id: c.id.slice(0, 12), label: c.label, deviceType: c.device_type, backedUp: c.backed_up, createdAt: c.created_at, lastUsedAt: c.last_used_at,
      enrolledOnSigner: !!st?.credentials.some((x) => x.id === c.id) }));
    const sessions = await sql`select created_at, last_seen, ua, ip from sessions where not revoked and expires_at > now() order by last_seen desc limit 20`;
    return {
      signer: st ? { reachable: true, keyId: st.keyId, halted: st.halted, journalLength: st.journalLength, journalHead: st.journalHead, policy: st.policy, spentToday: st.spentToday } : { reachable: false },
      devices, sessions, origin: config.origin, broadcast: config.broadcast,
    };
  });
  app.get('/api/v1/security/devices', async () => (await listCreds()).map((c) => ({ id: c.id.slice(0, 12), label: c.label, createdAt: c.created_at, lastUsedAt: c.last_used_at })));
  app.post('/api/v1/security/emergency-halt', async (req) => {
    await signer.halt(); // one-way from the app: re-enabling requires the CLI on the signer machine
    await audit('halt.on', 'owner', { ip: req.ip });
    return { ok: true, halted: true };
  });
  app.get('/api/v1/security/audit', async (req) => auditList(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query).limit));

  if (config.webDir && existsSync(join(config.webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false, cacheControl: false,
      setHeaders: (res, path) => { res.header('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'); } });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.method !== 'GET') return reply.status(404).send({ error: 'not_found', message: 'not found' });
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    });
  }
  return app;
}
export type { NetworkId };
