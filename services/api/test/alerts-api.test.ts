/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/alerts-api.test.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// Alerts and monitoring over HTTP: owner session required everywhere, list / unread / mark read, live stream, settings,
// the whole life of a push subscription against a fake push service (a real local HTTP server that decrypts what it receives),
// the webhook secret, the error hook, and the dashboard aggregation on fixtures.
import { createServer, type Server } from 'node:http';
import { statSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AlertDispatcher } from '../src/alerts/dispatcher.ts';
import { decryptPush, generateSubscriptionKeys } from '../src/alerts/webpush.ts';
import { addAgent, addPaperAccount, addProposal, addVenueAccount, ownerCookie, world, type World } from './alerts-helpers.ts';

const ORIGIN = 'https://wallet.test';
let w: World, sql: any, app: any, d: AlertDispatcher, cookie = '', push: Server, pushUrl = '';
const received: { path: string; headers: Record<string, unknown>; body: Buffer }[] = [];
const answer = new Map<string, number>();                            // per-path status of the fake push service
const browser = generateSubscriptionKeys();

async function api(method: string, path: string, body?: unknown, o: { cookie?: string | null } = {}) {
  const headers: Record<string, string> = {};
  const c = o.cookie === undefined ? cookie : o.cookie;
  if (c) headers.cookie = c;
  if (method !== 'GET') { headers.origin = ORIGIN; headers['x-spw-csrf'] = '1'; headers['content-type'] = 'application/json'; }
  const r = await app.inject({ method, url: path, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() };
}

beforeAll(async () => {
  w = await world('alerts_api'); sql = w.sql;
  push = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => { received.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(answer.get(req.url ?? '') ?? 201).end(); });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => push.once('listening', r));
  const port = (push.address() as { port: number }).port;
  pushUrl = `http://127.0.0.1:${port}`;
  process.env.SPW_PUSH_ALLOW_HOSTS = `127.0.0.1:${port}`;             // production accepts only the browsers' push services
  d = w.dispatcher({ fetch, now: Date.now });
  w.mod.setAlerts(d);
  const { UserError } = await import('../src/config.ts');
  app = await (await import('../src/server.ts')).buildServer();
  app.get('/api/v1/__test/router', async () => { throw new UserError('router_changed', 'the swap router bytecode is not the reviewed one; swaps are refused', 503); });
  app.get('/api/v1/__test/other', async () => { throw new UserError('bad_amount', 'nope'); });
  await d.tail();
  cookie = await ownerCookie(sql);
});
afterAll(async () => { await app?.close(); push?.close(); await sql?.end(); });

describe('access', () => {
  it('every alerts, push and monitoring endpoint needs the owner session; writes need the CSRF header', async () => {
    for (const p of ['/api/v1/alerts', '/api/v1/alerts/unread', '/api/v1/alerts/stream', '/api/v1/alerts/settings', '/api/v1/push/key', '/api/v1/push/subscriptions',
      '/api/v1/monitor/capital', '/api/v1/monitor/pnl', '/api/v1/monitor/exposure', '/api/v1/monitor/health'])
      expect((await api('GET', p, undefined, { cookie: null })).status, p).toBe(401);
    for (const [m, p] of [['POST', '/api/v1/alerts/read'], ['PUT', '/api/v1/alerts/settings'], ['POST', '/api/v1/alerts/webhook/secret'], ['POST', '/api/v1/alerts/webhook/test'],
      ['POST', '/api/v1/push/subscriptions'], ['POST', '/api/v1/push/test'], ['DELETE', '/api/v1/push/subscriptions/00000000-0000-4000-8000-000000000000']] as const)
      expect((await api(m, p, {}, { cookie: null })).status, p).toBe(401);
    const r = await app.inject({ method: 'POST', url: '/api/v1/alerts/read', headers: { cookie, 'content-type': 'application/json' }, payload: '{"all":true}' });
    expect(r.statusCode).toBe(403);
  });
});

describe('in-app alerts', () => {
  it('list with filters, unread count, mark read', async () => {
    const agent = await addAgent(sql, { name: 'Momentum' });
    await d.raise({ kind: 'deposit.received', params: { network: 'Base', symbol: 'ETH', amount: '1.5' }, subject: { type: 'deposit', id: '0x1', network: 'base' } });
    await d.raise({ kind: 'agent.stopped_loss', params: { agent: 'Momentum', reason: 'loss limit reached' }, subject: { type: 'agent', id: agent } });
    await d.raise({ kind: 'conn.down', params: { name: 'Base', minutes: 3 } });
    const all = await api('GET', '/api/v1/alerts');
    expect(all.json).toMatchObject({ unread: 3, critical: 1 });
    expect(all.json.items.map((x: any) => x.kind)).toEqual(['conn.down', 'agent.stopped_loss', 'deposit.received']);
    expect(all.json.items[1]).toMatchObject({ severity: 'critical', group: 'agents', subject: { type: 'agent', id: agent }, readAt: null, params: { agent: 'Momentum', count: 1 } });
    expect((await api('GET', '/api/v1/alerts?severity=critical')).json.items).toHaveLength(1);
    expect((await api('GET', '/api/v1/alerts?group=system')).json.items.map((x: any) => x.kind)).toEqual(['conn.down']);
    expect((await api('GET', `/api/v1/alerts?limit=1&before=${all.json.items[0].id}`)).json.items[0].kind).toBe('agent.stopped_loss');
    expect((await api('GET', '/api/v1/alerts?severity=fatal')).status).toBe(400);
    const read = await api('POST', '/api/v1/alerts/read', { ids: [all.json.items[1].id] });
    expect(read.json).toMatchObject({ unread: 2, critical: 0 });
    expect((await api('GET', '/api/v1/alerts?unread=1')).json.items).toHaveLength(2);
    expect((await api('POST', '/api/v1/alerts/read', { all: true })).json.unread).toBe(0);
    expect((await api('POST', '/api/v1/alerts/read', { ids: [] })).status).toBe(400);
  });

  it('a pinned-code refusal answered by any route becomes a critical alert, once per hour; ordinary errors do not', async () => {
    const before = (await api('GET', '/api/v1/alerts/unread')).json.unread;
    for (let i = 0; i < 3; i++) expect((await api('GET', '/api/v1/__test/router')).status).toBe(503);
    expect((await api('GET', '/api/v1/__test/other')).status).toBe(400);
    // v8: wait for the alert itself (the hook runs after the answer), not for a fixed 150 ms of real time
    let rows: any[] = [];
    for (let i = 0; i < 100 && rows.length === 0; i++) { rows = await w.alerts(`kind = 'security.pin_mismatch'`); if (!rows.length) await new Promise((r) => setTimeout(r, 20)); }
    await new Promise((r) => setTimeout(r, 30)); rows = await w.alerts(`kind = 'security.pin_mismatch'`); // …and still exactly one a moment later
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: 'critical', params: { what: '@router' } });
    expect((await api('GET', '/api/v1/alerts/unread')).json.unread).toBe(before + 1);
  });

  it('the live stream sends the unread count at once and again when an alert arrives', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const ac = new AbortController();
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/alerts/stream`, { headers: { cookie }, signal: ac.signal });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    const reader = r.body!.getReader(), dec = new TextDecoder();
    let text = '';
    const until = async (re: RegExp) => { for (let i = 0; i < 50 && !re.test(text); i++) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); } return re.exec(text); };
    const first = await until(/event: unread\ndata: (\{.*\})\n\n/);
    const n0 = JSON.parse(first![1]!).unread as number;
    text = '';
    await d.raise({ kind: 'deposit.received', params: { network: 'Base' } }); d.changed();
    const next = await until(/event: unread\ndata: (\{.*\})\n\n/);
    expect(JSON.parse(next![1]!).unread).toBe(n0 + 1);
    ac.abort();
    expect((await fetch(`http://127.0.0.1:${port}/api/v1/alerts/stream`)).status).toBe(401);
  });
});

describe('settings', () => {
  it('defaults: every kind listed, criticals on, webhook off, details off, no secret anywhere in the answer', async () => {
    const r = await api('GET', '/api/v1/alerts/settings');
    expect(r.status).toBe(200);
    expect(r.json.settings).toMatchObject({ showDetails: false, capPerHour: 20, quiet: { enabled: false, tz: 'America/Toronto' }, webhook: { enabled: false, url: '', details: false } });
    expect(r.json.kinds.length).toBeGreaterThan(45);
    for (const k of r.json.kinds) if (k.severity === 'critical') expect(k.default, k.kind).toBe(true);
    for (const k of r.json.kinds) if (!k.fixed) expect(r.json.settings.rules[k.kind], k.kind).toBe(k.default);
    expect(r.json.settings.rules['system.test']).toBeUndefined();
    expect(r.json.webhook).toEqual({ secretSet: false });
    expect(JSON.stringify(r.json)).not.toMatch(/privateKey|secret"\s*:\s*"/);
  });
  it('switches, quiet hours and thresholds are validated; an unknown kind or a bad zone is refused', async () => {
    const ok = await api('PUT', '/api/v1/alerts/settings', { rules: { 'deposit.received': false }, quiet: { enabled: true, start: '23:00', end: '06:30' }, thresholds: { stuckMinutes: 45 }, showDetails: true });
    expect(ok.status).toBe(200);
    expect(ok.json.settings).toMatchObject({ rules: { 'deposit.received': false, 'transfer.confirmed': true }, quiet: { enabled: true, start: '23:00', end: '06:30', tz: 'America/Toronto' }, thresholds: { stuckMinutes: 45, staleBars: 3 }, showDetails: true });
    for (const bad of [{ rules: { 'nope.kind': true } }, { rules: { 'system.test': false } }, { quiet: { tz: 'Mars/Olympus' } }, { quiet: { start: '25:00' } }, { thresholds: { stuckMinutes: 1 } }, { capPerHour: 0 }, { extra: 1 },
      { webhook: { url: 'http://insecure.example/x' } }, { webhook: { enabled: true, url: 'https://ok.example/x' } }])
      expect((await api('PUT', '/api/v1/alerts/settings', bad)).status, JSON.stringify(bad)).toBe(400);
    const [last] = await sql`select type, data from audit_events where type = 'alerts.settings' order by seq desc limit 1`;
    expect(last.data).toMatchObject({ off: ['deposit.received'], on: [], quiet: true, webhook: null });
    await api('PUT', '/api/v1/alerts/settings', { rules: { 'deposit.received': true }, quiet: { enabled: false }, showDetails: false });
  });
  it('webhook: the secret is generated on the server, shown once, kept in a 0600 file; the test call is signed', async () => {
    const { verifyWebhook } = await import('../src/alerts/webhook.ts'), { secretsPath } = await import('../src/alerts/secrets.ts');
    const s = await api('POST', '/api/v1/alerts/webhook/secret', {});
    expect(s.json.secret).toMatch(/^[\w-]{43}$/);
    expect(statSync(secretsPath()).mode & 0o777).toBe(0o600);
    expect((await sql`select value from settings where key = 'alerts'`)[0]?.value?.webhook?.secret).toBeUndefined();   // never in the database
    answer.set('/hook', 200);
    // an http receiver is accepted only by the test dispatcher: the route itself insists on https
    expect((await api('PUT', '/api/v1/alerts/settings', { webhook: { enabled: true, url: `${pushUrl}/hook` } })).status).toBe(400);
    await w.store.saveAlertSettings({ ...(await w.store.alertSettings(true)), webhook: { enabled: true, url: `${pushUrl}/hook`, details: false } });
    received.length = 0;
    const t = await api('POST', '/api/v1/alerts/webhook/test', {});
    expect(t.json).toEqual({ ok: true, status: 200, error: null });
    const c = received[0]!;
    expect(verifyWebhook(s.json.secret, String(c.headers['x-spw-timestamp']), String(c.headers['x-spw-signature']), c.body.toString())).toBe(true);
    expect(JSON.parse(c.body.toString())).toMatchObject({ app: 'sp-wallet', kind: 'system.test', title: 'Test notification' });
    const view = await api('GET', '/api/v1/alerts/settings');
    expect(view.json.webhook).toEqual({ secretSet: true });
    expect(JSON.stringify(view.json)).not.toContain(s.json.secret);
    expect(view.json.webhookSample).toMatchObject({ title: 'Transfer confirmed', body: 'On Base.', params: { network: 'Base' } });
    await w.store.saveAlertSettings({ ...(await w.store.alertSettings(true)), webhook: { enabled: false, url: '', details: false } });
  });
});

describe('web push subscriptions', () => {
  const sub = (path: string, extra: Record<string, unknown> = {}) => ({ endpoint: `${pushUrl}${path}`, keys: { p256dh: browser.p256dh, auth: browser.auth }, label: 'iPhone de test', locale: 'fr', ...extra });
  const decrypted = (path: string) => received.filter((r) => r.path === path).map((r) => JSON.parse(decryptPush(r.body, browser).toString()));

  it('the VAPID key pair is generated on the server and only the public key is served; the file is 0600', async () => {
    const { secretsPath } = await import('../src/alerts/secrets.ts');
    const k = await api('GET', '/api/v1/push/key');
    expect(Buffer.from(k.json.publicKey, 'base64url')).toHaveLength(65);
    expect(Object.keys(k.json)).toEqual(['publicKey']);
    expect(statSync(secretsPath()).mode & 0o777).toBe(0o600);
    expect((await api('GET', '/api/v1/push/key')).json.publicKey).toBe(k.json.publicKey);   // stable across calls
  });

  it('subscribe (per device, with a label), test notification, real alert, rename, expiry (410/404) and removal', async () => {
    expect((await api('POST', '/api/v1/push/test', {})).status).toBe(404);                // nothing subscribed: said, not an error 500
    await d.deliver();                                                                    // what was raised before any device existed stays in the app
    expect(received.filter((r) => r.path.startsWith('/push'))).toHaveLength(0);
    expect((await api('POST', '/api/v1/push/subscriptions', sub('/x', { endpoint: 'https://evil.example/push' }))).status).toBe(400);
    expect((await api('POST', '/api/v1/push/subscriptions', sub('/x', { endpoint: 'http://169.254.169.254/latest' }))).status).toBe(400);
    expect((await api('POST', '/api/v1/push/subscriptions', { ...sub('/x'), keys: { p256dh: 'short', auth: browser.auth } })).status).toBe(400);
    const a = await api('POST', '/api/v1/push/subscriptions', sub('/push/a'));
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ label: 'iPhone de test', locale: 'fr', service: '127.0.0.1', failures: 0, lastOkAt: null });
    expect(JSON.stringify(a.json)).not.toContain(browser.auth);       // keys are write-only
    const again = await api('POST', '/api/v1/push/subscriptions', sub('/push/a', { label: '', locale: 'en' }));
    expect(again.json).toMatchObject({ id: a.json.id, label: 'iPhone de test', locale: 'en' });   // same device: updated, not duplicated
    const b = await api('POST', '/api/v1/push/subscriptions', sub('/push/b', { label: 'Mac' }));
    expect((await api('GET', '/api/v1/push/subscriptions')).json.map((s: any) => s.label)).toEqual(['iPhone de test', 'Mac']);

    // the test button: the real path, a harmless payload, in the device's language
    received.length = 0;
    const t = await api('POST', '/api/v1/push/test', { id: a.json.id });
    expect(t.json.results).toEqual([{ id: a.json.id, ok: true, status: 201, removed: false, error: null }]);
    expect(received[0]!.headers).toMatchObject({ 'content-encoding': 'aes128gcm', ttl: '14400', urgency: 'normal' });
    expect(String(received[0]!.headers.authorization)).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(decrypted('/push/a')[0]).toMatchObject({ v: 1, kind: 'system.test', l: 'en', d: false });
    expect(received.some((r) => r.path === '/push/b')).toBe(false);

    // a real alert goes to both devices, each in its language, without the amount
    received.length = 0;
    await d.raise({ kind: 'deposit.received', params: { network: 'Base', symbol: 'ETH', amount: '1.5' }, subject: { type: 'deposit', id: '0x2', network: 'base' } });
    expect(await d.deliver()).toMatchObject({ sent: 1 });
    expect(decrypted('/push/a')[0]).toMatchObject({ kind: 'deposit.received', l: 'en', p: { network: 'Base' } });
    expect(decrypted('/push/b')[0]).toMatchObject({ kind: 'deposit.received', l: 'fr', p: { network: 'Base' } });
    expect(JSON.stringify((decrypted('/push/a')[0] as { p: unknown }).p)).not.toMatch(/1\.5|ETH/); // v8: the parameters only, not ids or timestamps
    expect((await api('GET', '/api/v1/push/subscriptions')).json[0].lastOkAt).toBeGreaterThan(0);

    expect((await api('PATCH', `/api/v1/push/subscriptions/${b.json.id}`, { label: 'MacBook' })).json.label).toBe('MacBook');
    // device A's subscription expired at the push service: removed automatically; B answers 500 once: kept
    answer.set('/push/a', 410); answer.set('/push/b', 500);
    const t2 = await api('POST', '/api/v1/push/test', {});
    expect(t2.json.results.find((r: any) => r.id === a.json.id)).toMatchObject({ ok: false, removed: true, status: 410 });
    expect(t2.json.results.find((r: any) => r.id === b.json.id)).toMatchObject({ ok: false, removed: false, status: 500 });
    expect((await api('GET', '/api/v1/push/subscriptions')).json.map((s: any) => [s.label, s.failures])).toEqual([['MacBook', 1]]);
    answer.set('/push/b', 404);
    await d.raise({ kind: 'security.passkey_added', params: { label: 'k' } }); await d.deliver();
    expect((await api('GET', '/api/v1/push/subscriptions')).json).toEqual([]);
    // explicit removal
    answer.clear();
    const c = await api('POST', '/api/v1/push/subscriptions', sub('/push/c'));
    expect((await api('DELETE', `/api/v1/push/subscriptions/${c.json.id}`, {})).json).toEqual({ ok: true });
    expect((await api('GET', '/api/v1/push/subscriptions')).json).toEqual([]);
    expect((await sql`select count(*)::int as n from audit_events where type in ('alerts.push_subscribed', 'alerts.push_unsubscribed')`)[0].n).toBe(5);
  });
});

describe('monitoring dashboard', () => {
  const H = 3_600_000;
  it('capital, PnL, exposure and health from fixtures — wallet, agents and derivatives kept apart', async () => {
    const { clearMonitorCache } = await import('../src/monitor/routes.ts');
    await sql`truncate deriv_accounts, deriv_paper_accounts, deriv_equity, deriv_fills, deriv_orders, proposals`; await sql`truncate agents cascade`;
    const now = Date.now(), at = (ms: number) => new Date(now - ms);
    const live = await addAgent(sql, { name: 'Live', state: 'LIVE', lastBar: at(H), mandateId: '00000000-0000-4000-8000-000000000001', mandate: { expiresAt: Math.floor((now + 200 * H) / 1000) }, capital: '500000000' });
    const paperAgent = await addAgent(sql, { name: 'Paper', state: 'PAPER_TRADING', lastBar: at(H) });
    await addAgent(sql, { name: 'New', state: 'CREATED' });
    for (const [id, mode, ago, eq, pos] of [[live, 'LIVE', 40 * 24 * H, 500, { USDC: 500 }], [live, 'LIVE', 8 * 24 * H, 520, { USDC: 520 }], [live, 'LIVE', 30 * H, 540, { USDC: 300, ETH: 0.08 }], [live, 'LIVE', 60_000, 561.5, { USDC: 300, ETH: 0.08 }],
      [paperAgent, 'PAPER', 3 * 24 * H, 1000, { USDC: 1000 }], [paperAgent, 'PAPER', 120_000, 950, { USDC: 400, BTC: 0.005, ETH: 0.02 }]] as const)
      await sql`insert into agent_equity (agent_id, ts, mode, equity_usd, positions) values (${id}, ${at(ago)}, ${mode}, ${eq}, ${sql.json(pos)})`;
    const paper = await addPaperAccount(sql, { positions: [{ instrument: 'hyperliquid:BTC', side: 'short', size: '0.01', markPrice: '100000' }, { instrument: 'dydx:ETH-USD', side: 'long', size: '1', markPrice: '3000' }] });
    const venue = await addVenueAccount(sql, { label: 'HL main', meta: { baseline: { 'hyperliquid:BTC': '0.002' }, baselineTs: now - 10 * 24 * H } }), testnet = await addVenueAccount(sql, { label: 'HL test', network: 'testnet' });
    for (const [id, ago, eq] of [[paper, 2 * 24 * H, 10000], [paper, 60_000, 10250.5], [venue, 9 * 24 * H, 2000], [venue, 26 * H, 2100], [venue, 60_000, 2080], [testnet, 60_000, 999]] as const)
      await sql`insert into deriv_equity (account_id, ts, equity, collateral, margin_used, unrealized_pnl) values (${id}, ${at(ago)}, ${eq}, ${eq}, 10, 0)`;
    await sql`insert into deriv_fills (account_id, fill_id, instrument, side, price, size, fee, fee_asset, ts) values (${venue}, 'f1', 'hyperliquid:BTC', 'sell', 100000, 0.012, 0, 'USDC', ${at(H)}), (${venue}, 'f0', 'hyperliquid:BTC', 'buy', 90000, 5, 0, 'USDC', ${at(20 * 24 * H)})`;
    await sql`insert into deriv_orders (account_id, client_id, instrument, side, type, size, reduce_only, tif, status, created_at, updated_at, state, final) values
      (${venue}, 'o1', 'hyperliquid:BTC', 'buy', 'limit', 1, false, 'gtc', 'open', now(), now(), 'open', false), (${venue}, 'o2', 'hyperliquid:BTC', 'buy', 'limit', 1, false, 'gtc', 'filled', now(), now(), 'filled', true)`;
    await sql`insert into deriv_orders (account_id, client_id, instrument, side, type, size, reduce_only, tif, status, created_at, updated_at) values (${paper}, 'p1', 'hyperliquid:BTC', 'buy', 'limit', 1, false, 'gtc', 'open', now(), now())`;
    for (const [s, c] of [['BTC', 100000], ['ETH', 3000]] as const) await sql`insert into candles (source, symbol, interval, ts, open, high, low, close, volume) values ('coinbase', ${s}, '1h', ${at(H)}, ${c}, ${c}, ${c}, ${c}, 1)`;
    await sql`insert into swap_quotes (search_id, provider, from_key, to_key, amount_in, ms, ok) values (${'00000000-0000-4000-8000-000000000002'}, 'kyberswap', 'a', 'b', 1, 120, true)`;
    await addProposal(sql, { kind: 'bridge', state: 'finalized', bridge: { phase: 'attesting' } });
    clearMonitorCache();

    const cap = (await api('GET', '/api/v1/monitor/capital')).json;
    expect(cap.wallet).toEqual({ usd: null, cad: null, assets: 0, unpriced: 0, unavailable: 0 });   // the signer is not reachable in this suite: unknown, not zero
    expect(cap.totals).toEqual({ agentsLiveUsd: 561.5, agentsPaperUsd: 950, derivVenueUsd: 2080, derivPaperUsd: 10250.5, derivTestnetUsd: 999 });
    expect(Object.keys(cap.totals)).not.toContain('total');           // no "universal balance"
    expect(cap.agents.map((a: any) => [a.name, a.mode, a.real, a.equityUsd, a.capitalUsd, a.positions])).toEqual([['Live', 'LIVE', true, 561.5, 500, 1], ['Paper', 'PAPER', false, 950, 1000, 2], ['New', 'PAPER', false, null, 1000, 0]]);
    expect(cap.derivatives.map((a: any) => [a.label, a.kind, a.real, a.equity, a.positions, a.openOrders])).toEqual([['Paper HL', 'paper', false, 10250.5, 2, 1], ['HL main', 'venue', true, 2080, 1, 1], ['HL test', 'venue', false, 999, 0, 0]]);
    expect(cap.counts).toEqual({ agents: { LIVE: 1, PAPER_TRADING: 1, CREATED: 1 }, openPositions: { agents: 3, derivatives: 3 }, openOrders: { agents: 0, derivatives: 2 } });

    const pnl = (await api('GET', '/api/v1/monitor/pnl')).json;
    const L = pnl.agents.find((a: any) => a.name === 'Live');
    expect(L.d7).toMatchObject({ abs: 41.5, pct: 7.98, partial: false });                 // 561.5 − 520 (the last snapshot before the window)
    expect(L.d30).toMatchObject({ abs: 61.5, pct: 12.3, partial: false });                // 561.5 − 500
    expect(L.today.abs === 21.5 || L.today.abs === 0).toBe(true);                         // depends on the hour of the run: base is the 30-h-old or the 1-min-old snapshot
    const P = pnl.agents.find((a: any) => a.name === 'Paper');
    expect(P.d7).toMatchObject({ abs: -50, pct: -5, partial: true });                     // the series is three days old: said
    expect(P.d30).toMatchObject({ abs: -50, partial: true });                             // the series starts inside the 30-day window: said
    expect(pnl.agents.find((a: any) => a.name === 'New')).toBeUndefined();
    const V = pnl.derivatives.find((a: any) => a.label === 'HL main');
    expect(V).toMatchObject({ kind: 'venue', real: true, equity: 2080, d7: { abs: 80, pct: 4, partial: false }, d30: { abs: 80, partial: true } });
    expect(pnl.derivatives.find((a: any) => a.label === 'Paper HL')).toMatchObject({ kind: 'paper', real: false, d7: { abs: 250.5, partial: true } });
    expect(pnl.note).toBe('flows_included');

    const ex = (await api('GET', '/api/v1/monitor/exposure')).json;
    expect(ex.caveat).toBe('spot_and_perp_differ');
    // real: 0.08 ETH spot in the LIVE vault; venue account: baseline 0.002 − 0.012 sold = −0.01 BTC (the fill before the baseline is not counted)
    expect(ex.real).toEqual([{ asset: 'BTC', spotUsd: 0, perpLongUsd: 0, perpShortUsd: 1000, netUsd: -1000, grossUsd: 1000, priced: true }, { asset: 'ETH', spotUsd: 240, perpLongUsd: 0, perpShortUsd: 0, netUsd: 240, grossUsd: 240, priced: true }]);
    expect(ex.simulated).toEqual([{ asset: 'ETH', spotUsd: 60, perpLongUsd: 3000, perpShortUsd: 0, netUsd: 3060, grossUsd: 3060, priced: true }, { asset: 'BTC', spotUsd: 500, perpLongUsd: 0, perpShortUsd: 1000, netUsd: -500, grossUsd: 1500, priced: true }]);

    const h = (await api('GET', '/api/v1/monitor/health')).json;
    const conn = (id: string) => h.connectors.find((c: any) => c.id === id);
    expect(conn('signer')).toMatchObject({ ok: false, detail: 'no answer' });
    expect(conn('database')).toMatchObject({ ok: true });
    expect(conn('rpc:base')).toMatchObject({ ok: null, detail: 'not checked yet' });        // workers are off here: unknown is not shown as healthy
    expect(conn('market:coinbase')).toMatchObject({ ok: true, group: 'market' });
    expect(conn('swap:kyberswap')).toMatchObject({ ok: true });
    expect(conn('bridge:circle')).toMatchObject({ ok: true, detail: '1 transfer(s) awaiting attestation' });
    expect(conn('venue:hyperliquid:mainnet:venue')).toMatchObject({ ok: true });
    expect(conn('venue:hyperliquid:mainnet:paper')).toMatchObject({ ok: true });
    expect(conn('venue:hyperliquid:testnet:venue')).toMatchObject({ ok: true });
    expect(h.audit).toMatchObject({ intact: true });
    expect(h.versions).toMatchObject({ signerKeyId: null, apiVersion: '1.0.0' });
    expect(h.disk.freePct).toBeGreaterThan(0);
    expect(h.signer).toEqual({ reachable: false, halted: null });
    // v8: `capabilities` names the VARIABLES that are missing (SPW_RESEARCH_RUNNER_SECRET is a name, not a secret): the rest of
    // the answer is checked as before, and the capabilities for values
    { const { capabilities: caps, ...rest } = h; expect(JSON.stringify(rest)).not.toMatch(/secret|privateKey|k{48}/i);
      expect(JSON.stringify(caps)).not.toMatch(/privateKey|k{48}|postgres:\/\//i); expect(caps.map((c: any) => c.id)).toContain('research_runner'); }
    expect(h.loops.every((l: any) => typeof l.name === 'string')).toBe(true); expect(h.loopsNote).toBeNull(); expect(h.lab).toBeDefined();
  });
});
