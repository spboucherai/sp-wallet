// Backend for alerts.spec.ts, in one process: the real API server (alerts, push, monitoring routes, the real dispatcher loop) on
// a scratch PostgreSQL database, the BUILT web bundle, a stub signer that only answers GET /status (no key anywhere, nothing can
// be signed), and a FAKE push service — a local HTTP server that receives what the API sends, decrypts it with the subscription
// key it handed to the browser, and lets the test read it back. No network, no real key, no real transaction.
//
//   npx tsx tests/e2e/alerts-server.mts --port 8681 --db spw_v6_alerts_e2e_phone
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1]! : d; };
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(arg('port', '8681')), DB = arg('db', 'spw_v6_alerts_e2e'), ORIGIN = `http://localhost:${PORT}`;
const listen = (srv: ReturnType<typeof createServer>) => new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as { port: number }).port)));

// a signer that answers its status and nothing else
const signerPort = await listen(createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/status') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ keyId: 'e2e-demo-key', addresses: {}, halted: false, enrollmentOpen: false, credentials: [], policy: { version: 3, perTx: {}, daily: {} }, spentToday: {}, journalHead: null, journalLength: 0 })); return; }
  res.writeHead(404).end('{}');
}));

const { decryptPush, generateSubscriptionKeys } = await import('../../services/api/src/alerts/webpush.ts');
const browserKeys = generateSubscriptionKeys(), pushes: { path: string; urgency: string; ttl: string; vapid: boolean; payload: unknown }[] = [];
const pushPort = await listen(createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    let payload: unknown = null;
    try { payload = JSON.parse(decryptPush(Buffer.concat(chunks), browserKeys).toString()); } catch (e) { payload = { undecryptable: (e as Error).message }; }
    pushes.push({ path: req.url ?? '', urgency: String(req.headers.urgency), ttl: String(req.headers.ttl), vapid: /^vapid t=.+, k=.+$/.test(String(req.headers.authorization)), payload });
    res.writeHead(201).end();
  });
}));

if (!/^[a-z0-9_]+$/.test(DB)) throw new Error('bad database name');
try { execSync(`createdb ${DB}`, { stdio: 'ignore' }); } catch { /* it exists already: its schema is dropped below */ }
const data = mkdtempSync(join(tmpdir(), 'spw-alerts-e2e-')), backups = mkdtempSync(join(tmpdir(), 'spw-alerts-e2e-backup-'));
writeFileSync(join(backups, 'sp-wallet-20261111-0300.sql.gz'), 'not a real dump');
Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: 'localhost', PORT: String(PORT), HOST: '127.0.0.1', DATABASE_URL: `postgres:///${DB}`, SPW_SIGNER_SECRET: 'e'.repeat(48),
  SPW_SIGNER_URL: `http://127.0.0.1:${signerPort}`, SPW_BROADCAST: 'off', SPW_WORKERS: 'off', SPW_WEB_DIR: resolve(ROOT, 'dist/web'), SPW_DATA_DIR: data, SPW_BACKUP_DIR: backups,
  SPW_PUSH_ALLOW_HOSTS: `127.0.0.1:${pushPort}`, SPW_COMMIT: 'e2e' });

const db = await import('../../services/api/src/db.ts'), sql = db.sql;
await sql.unsafe('drop schema public cascade; create schema public;');
await db.migrate();
const app = await (await import('../../services/api/src/server.ts')).buildServer({ swapProviders: [] });
const { alerts, startAlerts } = await import('../../services/api/src/alerts/dispatcher.ts');
const d = await alerts();

// ---- demo data (invented): two agents, a paper account, a testnet venue account, their equity history, a few feeds
const now = Date.now(), H = 3_600_000, at = (ms: number) => new Date(now - ms);
let vault = 0;
const agent = async (name: string, state: string, capital: number, o: { stopReason?: string; mandate?: { expiresAt: number } } = {}) => { const id = randomUUID();
  await sql`insert into agents (id, name, state, interval, universe, risk, vault_index, vault_address, last_bar, capital_usdc, stop_reason, mandate_id, mandate)
    values (${id}, ${name}, ${state}, '1h', ${sql.json(['BTC', 'ETH'])}, ${sql.json({})}, ${++vault}, ${`0x${id.replace(/-/g, '').padEnd(40, '0').slice(0, 40)}`}, ${at(H)}, ${String(capital * 1e6)}, ${o.stopReason ?? null},
      ${o.mandate ? randomUUID() : null}, ${o.mandate ? sql.json(o.mandate) : null})`; return id; };
const live = await agent('Momentum BTC/ETH', 'LIVE', 500, { mandate: { expiresAt: Math.floor((now + 60 * H) / 1000) } });   // the real rule will say it expires within 72 h
const paperAgent = await agent('Mean reversion', 'PAPER_TRADING', 1000), stopped = await agent('Breakout', 'STOPPED', 250, { stopReason: 'loss limit reached' });
const eq = (id: string, mode: string, ago: number, v: number, pos: Record<string, number>) => sql`insert into agent_equity (agent_id, ts, mode, equity_usd, positions) values (${id}, ${at(ago)}, ${mode}, ${v}, ${sql.json(pos)}) on conflict do nothing`;
for (const [ago, v] of [[40 * 24 * H, 500], [8 * 24 * H, 512.4], [30 * H, 531.1], [H, 538.75]] as const) await eq(live, 'LIVE', ago, v, { USDC: 300, ETH: 0.08 });
for (const [ago, v] of [[12 * 24 * H, 1000], [26 * H, 968.2], [H, 957.4]] as const) await eq(paperAgent, 'PAPER', ago, v, { USDC: 400, BTC: 0.004, ETH: 0.05 });
await eq(stopped, 'PAPER', 3 * 24 * H, 212.5, { USDC: 212.5 });
const paper = randomUUID(), venue = randomUUID();
await sql`insert into deriv_paper_accounts (id, venue, network, label, initial_collateral, state, policy) values (${paper}, 'hyperliquid', 'mainnet', 'Papier Hyperliquid', 10000,
  ${sql.json({ collateral: '10000', positions: [{ instrument: 'hyperliquid:BTC', side: 'short', size: '0.02', markPrice: '101250' }, { instrument: 'hyperliquid:ETH', side: 'long', size: '1.5', markPrice: '3420' }] })}, ${sql.json({ halt: null })})`;
await sql`insert into deriv_accounts (id, venue, network, account, agent_address, label, mode, policy, meta) values (${venue}, 'hyperliquid', 'testnet', '0x00000000000000000000000000000000000e2e00', '0x00000000000000000000000000000000000e2e01', 'Hyperliquid testnet', 'MANUAL_LIVE', ${sql.json({})}, ${sql.json({})})`;
for (const [id, ago, v] of [[paper, 9 * 24 * H, 10000], [paper, 25 * H, 10112.3], [paper, 60_000, 10184.9], [venue, 2 * 24 * H, 999], [venue, 60_000, 1003.2]] as const)
  await sql`insert into deriv_equity (account_id, ts, equity, collateral, margin_used, unrealized_pnl) values (${id}, ${at(ago)}, ${v}, ${v}, 120, 0)`;
for (const [s, c] of [['BTC', 101250], ['ETH', 3420]] as const) for (const src of ['coinbase', 'kraken', 'bitstamp']) await sql`insert into candles (source, symbol, interval, ts, open, high, low, close, volume) values (${src}, ${s}, '1h', ${at(H)}, ${c}, ${c}, ${c}, ${c}, 1)`;
for (const [p, ok] of [['kyberswap', true], ['jupiter', true], ['lifi', false]] as const) await sql`insert into swap_quotes (search_id, provider, from_key, to_key, amount_in, ms, ok) values (${randomUUID()}, ${p}, 'a', 'b', 1, 140, ${ok})`;
const worker = await import('../../services/api/src/worker.ts');
for (const [n, ok] of [['ethereum', true], ['base', true], ['arbitrum', true], ['solana', true], ['bitcoin', true], ['polygon', false]] as const)
  worker.healthCache.set(n, { network: n, ok, readable: ok, identityVerified: ok, height: 1, endpoints: [{ url: 'https://rpc.example', ok, ms: ok ? 84 : null }, { url: 'https://rpc2.example', ok, ms: ok ? 131 : null }], checkedAt: new Date().toISOString() } as never);

// ---- alerts already in the list when the owner opens the app
const seed: [number, Parameters<typeof d.raise>[0]][] = [
  [26 * H, { kind: 'system.api_restarted', params: {} }],
  [20 * H, { kind: 'deposit.received', params: { network: 'Base', symbol: 'USDC', amount: '250' }, subject: { type: 'deposit', id: '0xe2e', network: 'base' } }],
  [9 * H, { kind: 'agent.order_filled', params: { agent: 'Momentum BTC/ETH', from: 'USDC', to: 'ETH', count: 3 }, subject: { type: 'agent', id: live } }],
  [7 * H, { kind: 'swap.confirmed', params: { network: 'Base', symbol: 'ETH', amount: '0.05', toSymbol: 'USDC' }, subject: { type: 'proposal', id: randomUUID(), network: 'base' } }],
  [5 * H, { kind: 'deriv.paper.filled', params: { account: 'Papier Hyperliquid', instrument: 'hyperliquid:BTC', side: '@sell', size: '0.02', price: '101310' }, subject: { type: 'account', id: paper } }],
  [3 * H, { kind: 'conn.down', params: { name: 'Polygon', minutes: 3 }, subject: { type: 'network', network: 'polygon' } }],
  [2 * H, { kind: 'deriv.margin_warning', params: { account: 'Papier Hyperliquid', mode: '@paper', reason: 'maintenance margin 480 has reached 80 % of equity 600' }, subject: { type: 'account', id: paper } }],
  [70 * 60_000, { kind: 'agent.stopped_loss', params: { agent: 'Breakout', reason: 'loss limit reached: equity 212.50 USD against 250.00 USD allocated (limit 15 %); positions were sold to USDC' }, subject: { type: 'agent', id: stopped } }],
  [12 * 60_000, { kind: 'security.new_device', params: { device: 'Safari · iPhone', ip: '203.0.113.9' } }],
];
for (const [ago, draft] of seed) await d.raise(draft, { ts: at(ago) });
await sql`update alerts set delivery = 'inapp'`;
await sql`update alerts set read_at = now() where kind in ('system.api_restarted', 'deposit.received', 'agent.order_filled')`;

// ---- test controls (this harness only; behind the session and the CSRF check like every /api/ route)
app.get('/api/v1/__e2e/subscription', async () => ({ endpoint: `http://127.0.0.1:${pushPort}/push/e2e-device`, p256dh: browserKeys.p256dh, auth: browserKeys.auth }));
app.get('/api/v1/__e2e/pushes', async () => pushes);
app.post('/api/v1/__e2e/raise', async (req) => { const made = await d.raise(req.body as never); d.changed(); const sent = await d.deliver(); return { made, sent }; });

const token = randomBytes(32).toString('base64url');
await sql`insert into sessions (id_hash, expires_at, ua, ip) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '2 hours', 'e2e', '127.0.0.1')`;
const store = await import('../../services/api/src/alerts/store.ts');
await store.saveAlertSettings({ ...store.DEFAULT_SETTINGS, thresholds: { ...store.DEFAULT_SETTINGS.thresholds, diskFreePct: 1 } });   // the state of this machine's disk is not part of the test
await app.listen({ port: PORT, host: '127.0.0.1' });
await startAlerts();                                                 // the real loop: tail, conditions (the mandate rule fires here), delivery
await new Promise((r) => setTimeout(r, 1500));
await sql`update alerts set read_at = now() where kind = 'system.api_restarted'`;
console.log(`READY ${ORIGIN} token ${token} agent ${stopped}`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void app.close().then(() => process.exit(0)); });
