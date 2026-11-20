// The CONTRACT of the core wallet API against the real server (audit A1). Real server, own database, a real signer process,
// the owner enrolled and signed in through the real routes; chain reads, fees and prices are scripted; no network.
//
//   1. every operation of the document is called and its answer validated against the response schema of the generated
//      OpenAPI document, in STRICT mode (a member the server returns that the document does not declare fails; so does a
//      value of an open enumeration that is not in its documented list);
//   2. error answers are validated against the error model and must carry a code the operation declares;
//   3. every route Fastify registered under /api/v1 is an operation of the document or belongs to a family documented
//      elsewhere (explicit allow-list), and every operation of the document is a registered route;
//   4. at the end, the list of operations exercised is compared with the document: an operation nobody called fails.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { violations } from './schema-validator.ts';
import { bootWallet, DEST, DEST_LOWER, ORIGIN, RP, USDC, type Res, type Wallet } from './wallet-helpers.ts';

let w: Wallet, doc: any, spec: typeof import('../src/wallet-api/spec.ts'), base = '';
const covered = new Set<string>(), findings: string[] = [];
const opOf = (id: string): any => { for (const item of Object.values(doc.paths) as any[]) for (const o of Object.values(item) as any[]) if (o.operationId === id) return o; throw new Error(`no operation ${id} in the document`); };
/** a 200 answer of `id`, valid against the document in strict mode */
function ok(id: string, r: Res): any {
  expect(r.status, `${id}: ${JSON.stringify(r.json)?.slice(0, 300)}`).toBe(200);
  const schema = opOf(id).responses['200'].content['application/json']?.schema;
  expect(schema, `${id} has no JSON answer in the document`).toBeTruthy();
  const v = violations(doc, schema, r.json, { strict: true });
  expect(v, `${id}:\n  ${v.slice(0, 12).join('\n  ')}`).toEqual([]);
  covered.add(id);
  return r.json;
}
/** an error answer of `id`: the error model, the status, and a code the operation declares */
function err(id: string, r: Res, status: number, code: string): void {
  expect([r.status, r.json?.error], `${id}: ${JSON.stringify(r.json)?.slice(0, 200)}`).toEqual([status, code]);
  expect(violations(doc, doc.components.schemas.Error, r.json, { strict: true }), id).toEqual([]);
  const o = opOf(id), declared = (o['x-spw-errors'] as { status: number; code: string }[]).some((e) => e.status === status && e.code === code);
  expect(declared || (o['x-spw-errors-open'] === true && /^signer_/.test(code)), `${id} answered ${status} ${code}, which the document does not declare`).toBe(true);
  expect(doc['x-spw-error-catalog'][code] ?? (/^signer_/.test(code) ? {} : undefined), `${code} is not in the catalogue`).toBeTruthy();
}
const get = (path: string) => w.api('GET', path);
const draft = (amount: string, o: Record<string, unknown> = {}) => w.api('POST', '/api/v1/transfers/proposals', { network: 'base', asset: USDC.id, to: DEST, amount, ...o }, { idem: crypto.randomUUID() });
/** the first block of a Server-Sent-Events answer, read over a real socket (a stream never ends by itself) */
async function sseHead(path: string): Promise<{ contentType: string; first: string }> {
  const ctl = new AbortController(), res = await fetch(base + path, { headers: { cookie: w.cookie() }, signal: ctl.signal });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader(), dec = new TextDecoder(); let buf = '';
  const timer = setTimeout(() => ctl.abort(), 8000);
  try { while (!/\nevent: [a-z]+\ndata: .*\n\n|^event: [a-z]+\ndata: .*\n\n/.test(buf)) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); } }
  finally { clearTimeout(timer); ctl.abort(); }
  return { contentType: String(res.headers.get('content-type')), first: buf };
}

beforeAll(async () => {
  w = await bootWallet('wallet_contract');
  spec = await import('../src/wallet-api/spec.ts');
  doc = (await import('../src/wallet-api/openapi.ts')).buildWalletOpenApi();
  base = await w.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => { await w?.close(); });

describe('the document and the server name the same routes', () => {
  it('every /api/v1 route is in the wallet contract or in a family documented elsewhere; every operation is a registered route', () => {
    const registered: { method: string; url: string }[] = w.app.routeTable.filter((r: any) => r.url.startsWith('/api/') && r.method !== 'HEAD' && r.method !== 'OPTIONS');
    expect(registered.length).toBeGreaterThan(150);
    const key = (m: string, u: string) => `${m} ${u}`, ops = new Set(spec.OPERATIONS.map((o) => key(o.method, o.path))), families = Object.keys(spec.OTHER_FAMILIES);
    const elsewhere = (url: string) => families.some((p) => url === p || url.startsWith(`${p}/`));
    const undocumented = registered.filter((r) => !ops.has(key(r.method, r.url)) && !elsewhere(r.url)).map((r) => key(r.method, r.url));
    expect(undocumented, 'routes registered under /api that no contract documents: add them to wallet-api/spec.ts (or to OTHER_FAMILIES with where they are documented)').toEqual([]);
    const have = new Set(registered.map((r) => key(r.method, r.url)));
    expect(spec.OPERATIONS.filter((o) => !have.has(key(o.method, o.path))).map((o) => o.id), 'operations of the contract that the server does not register').toEqual([]);
    // an operation of the wallet contract never hides under an allow-listed prefix, and the allow-list has no dead prefix
    expect(spec.OPERATIONS.filter((o) => elsewhere(o.path)).map((o) => o.id)).toEqual([]);
    expect(families.filter((p) => !registered.some((r) => r.url === p || r.url.startsWith(`${p}/`))), 'allow-listed prefixes no route uses').toEqual([]);
    for (const r of registered) expect(r.url.startsWith('/api/v1/'), r.url).toBe(true);
  });
});

describe('authentication and setup', () => {
  it('state, the one-time setup, sign-in, and their refusals', async () => {
    ok('healthLive', await w.api('GET', '/api/v1/health/live', undefined, { cookie: null }));
    expect(ok('authState', await w.api('GET', '/api/v1/auth/state', undefined, { cookie: null }))).toEqual({ setupRequired: true, authenticated: false });
    err('getPortfolio', await w.api('GET', '/api/v1/portfolio', undefined, { cookie: null }), 401, 'unauthenticated');
    const s = await w.setup();
    ok('setupOptions', s.options); ok('setupVerify', s.verify);
    err('setupOptions', await w.api('POST', '/api/v1/auth/setup/options', {}, { cookie: null }), 403, 'setup_closed');
    const o = ok('loginOptions', await w.api('POST', '/api/v1/auth/login/options', {}, { cookie: null }));
    const stranger = new TestPasskey(RP, ORIGIN);
    err('loginVerify', await w.api('POST', '/api/v1/auth/login/verify', { challengeId: o.challengeId, response: stranger.assert(Buffer.from(o.options.challenge, 'base64url')) }, { cookie: null }), 401, 'login_failed');
    err('loginVerify', await w.api('POST', '/api/v1/auth/login/verify', { challengeId: o.challengeId, response: w.owner.assert(Buffer.from(o.options.challenge, 'base64url')) }, { cookie: null }), 401, 'challenge_expired'); // single-use
    const o2 = (await w.api('POST', '/api/v1/auth/login/options', {}, { cookie: null })).json;
    ok('loginVerify', await w.api('POST', '/api/v1/auth/login/verify', { challengeId: o2.challengeId, response: w.owner.assert(Buffer.from(o2.options.challenge, 'base64url')) }, { cookie: null }));
    expect(ok('authState', await get('/api/v1/auth/state'))).toEqual({ setupRequired: false, authenticated: true });
    // a mutating call without the same-origin proof
    const r = await w.app.inject({ method: 'PUT', url: '/api/v1/settings', headers: { cookie: w.cookie(), 'content-type': 'application/json' }, payload: '{}' });
    err('putSettings', { status: r.statusCode, json: r.json(), body: r.body, headers: r.headers }, 403, 'csrf');
  });
});

describe('wallet reads', () => {
  it('networks, assets, accounts, preferences, market', async () => {
    const nets = ok('listNetworks', await get('/api/v1/networks'));
    expect(nets.length).toBeGreaterThan(20);
    expect(ok('listAssets', await get('/api/v1/assets?network=base')).every((a: any) => a.network === 'base')).toBe(true);
    ok('listAssets', await get('/api/v1/assets'));
    expect(ok('listAccounts', await get('/api/v1/accounts')).accounts.find((a: any) => a.network === 'base').address).toBe(w.me);
    ok('setAssetPref', await w.api('PUT', `/api/v1/assets/prefs/base/${USDC.id}`, { favorite: true }));
    err('setAssetPref', await w.api('PUT', '/api/v1/assets/prefs/base/0xdAC17F958D2ee523a2206206994597C13D831ec7', { hidden: true }), 404, 'unsupported_asset');
    err('setAssetPref', await w.api('PUT', `/api/v1/assets/prefs/base/${USDC.id}`, {}), 400, 'bad_request');
    expect(ok('getAssetPrefs', await get('/api/v1/assets/prefs')).prefs).toHaveLength(1);
    const m = ok('getMarket', await get('/api/v1/market/ETH?days=7&currency=usd'));
    expect(m.points.length).toBeGreaterThan(5); expect(m.market).toMatchObject({ usd: 2000, source: 'coingecko' });
    expect(ok('getMarket', await get('/api/v1/market/NOPE'))).toEqual({ symbol: 'NOPE', points: [], market: null });
    err('getMarket', await get('/api/v1/market/ETH?days=3'), 400, 'bad_request');
    ok('healthReady', await get('/api/v1/health/ready'));
  });

  it('portfolio (provenance, prices, summary) and its history', async () => {
    const p = ok('getPortfolio', await get('/api/v1/portfolio'));
    expect(p.summary).toMatchObject({ currency: 'CAD', priced: 3 });
    expect(p.balances.find((b: any) => b.network === 'bitcoin' && b.asset === 'native')).toMatchObject({ confirmed: '1200000', pendingOut: '200000' });
    expect(p.prices.ETH).toMatchObject({ usd: 2000, cad: 2800 });
    await w.pf.writeSnapshot(new Date(Date.now() - 3_600_000)); await w.pf.writeSnapshot(new Date());
    const h = ok('getPortfolioHistory', await get('/api/v1/portfolio/history?range=1D'));
    expect(h.points.length).toBe(2); expect(h.estimatedMarketChange).toMatchObject({ estimate: true });
    ok('getPortfolioHistory', await get('/api/v1/portfolio/history?range=ALL&currency=USD'));
    err('getPortfolioHistory', await get('/api/v1/portfolio/history?range=2D'), 400, 'bad_request');
  });
});

describe('address book and settings', () => {
  it('contacts: create, list both shapes, edit, refuse a stale edit, delete', async () => {
    const c = ok('saveContact', await w.api('POST', '/api/v1/addressbook', { network: 'base', address: DEST, label: 'Alice' }));
    err('saveContact', await w.api('POST', '/api/v1/addressbook', { network: 'base', address: 'not-an-address', label: 'x' }), 400, 'bad_address');
    expect(ok('listAddressBook', await get('/api/v1/addressbook'))).toHaveLength(1);
    expect(ok('updateContact', await w.api('PATCH', `/api/v1/addressbook/${c.id}`, { note: 'landlord', favorite: true }))).toMatchObject({ label: 'Alice', note: 'landlord', favorite: true });
    err('updateContact', await w.api('PATCH', `/api/v1/addressbook/${c.id}`, { address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', currentAddress: '0x0000000000000000000000000000000000000001' }), 409, 'stale_contact');
    err('updateContact', await w.api('PATCH', `/api/v1/addressbook/${crypto.randomUUID()}`, { label: 'x' }), 404, 'not_found');
    expect(ok('listContacts', await get('/api/v1/contacts')).contacts[0]).toMatchObject({ label: 'Alice', favorite: true });
    const tmp = (await w.api('POST', '/api/v1/addressbook', { network: 'base', address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', label: 'Temp' })).json;
    err('updateContact', await w.api('PATCH', `/api/v1/addressbook/${tmp.id}`, { address: DEST, currentAddress: tmp.address }), 409, 'duplicate_contact');
    ok('deleteContact', await w.api('DELETE', `/api/v1/addressbook/${tmp.id}`));
  });
  it('settings', async () => {
    expect(ok('getSettings', await get('/api/v1/settings'))).toMatchObject({ locale: 'fr', currency: 'CAD', theme: 'system' });
    expect(ok('putSettings', await w.api('PUT', '/api/v1/settings', { theme: 'dark' }))).toMatchObject({ theme: 'dark', currency: 'CAD' });
    err('putSettings', await w.api('PUT', '/api/v1/settings', { theme: 'sepia' }), 400, 'bad_request');
  });
});

describe('transfers', () => {
  it('prepare, read, freeze, approve with the passkey, reject — the proposal view at every step', async () => {
    err('createTransfer', await w.api('POST', '/api/v1/transfers/proposals', { network: 'base', asset: USDC.id, to: DEST, amount: '1' }), 400, 'idempotency');
    err('createTransfer', await draft('0'), 400, 'bad_amount');
    err('createTransfer', await draft('1', { to: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' }), 400, 'bad_address');
    err('createTransfer', await draft('1', { asset: '0xdAC17F958D2ee523a2206206994597C13D831ec7' }), 400, 'unsupported_asset');
    err('createTransfer', await draft('50.000001'), 422, 'policy');
    err('createTransfer', await draft('1', { extra: true }), 400, 'bad_request');
    const key = crypto.randomUUID(), body = { network: 'base', asset: USDC.id, to: DEST, amount: '3' };
    const d = ok('createTransfer', await w.api('POST', '/api/v1/transfers/proposals', body, { idem: key }));
    expect(d).toMatchObject({ state: 'draft', lifecycle: 'draft', finalized: false, watched: false, feePaid: null, warnings: ['network_congested'] }); // Alice is a contact: no `new_destination`
    err('createTransfer', await w.api('POST', '/api/v1/transfers/proposals', { ...body, amount: '4' }, { idem: key }), 409, 'idempotency_mismatch');
    expect(ok('getTransfer', await get(`/api/v1/transfers/proposals/${d.id}`)).id).toBe(d.id);
    err('getTransfer', await get(`/api/v1/transfers/proposals/${crypto.randomUUID()}`), 404, 'not_found');
    err('getTransfer', await get('/api/v1/transfers/proposals/not-a-uuid'), 404, 'not_found');
    const ra = ok('requestApproval', await w.api('POST', `/api/v1/transfers/proposals/${d.id}/request-approval`, {}));
    expect(ra.proposal).toMatchObject({ state: 'pending_approval', lifecycle: 'awaiting_confirmation' });
    expect(Buffer.from(ra.options.challenge, 'base64url').toString('hex')).toBe(ra.proposal.intentHash);
    err('approveTransfer', await w.api('POST', `/api/v1/transfers/proposals/${d.id}/approve`, {}), 400, 'bad_request');
    const signed = ok('approveTransfer', await w.api('POST', `/api/v1/transfers/proposals/${d.id}/approve`, { assertion: w.owner.assert(Buffer.from(ra.options.challenge, 'base64url')) }));
    expect(signed).toMatchObject({ state: 'not_broadcast', lifecycle: 'not_sent', errorCode: 'broadcast_disabled', explorer: null });   // this server does not broadcast
    err('approveTransfer', await w.api('POST', `/api/v1/transfers/proposals/${d.id}/approve`, { assertion: {} }), 409, 'bad_state');
    expect(ok('getTransferStatus', await get(`/api/v1/transfers/${d.id}/status`))).toMatchObject({ state: 'not_broadcast', kind: 'transfer' });
    // a signer refusal is the signer's own code (the operation's error list is open for it)
    const d2 = (await draft('2')).json, ra2 = (await w.api('POST', `/api/v1/transfers/proposals/${d2.id}/request-approval`, {})).json;
    const refused = await w.api('POST', `/api/v1/transfers/proposals/${d2.id}/approve`, { assertion: new TestPasskey(RP, ORIGIN).assert(Buffer.from(ra2.options.challenge, 'base64url')) });
    expect(refused.status).toBe(422); err('approveTransfer', refused, 422, refused.json.error); expect(refused.json.error).toMatch(/^signer_/);
    expect(ok('getTransfer', await get(`/api/v1/transfers/proposals/${d2.id}`))).toMatchObject({ state: 'failed', lifecycle: 'failed' });
    const d3 = (await draft('1')).json;
    expect(ok('rejectTransfer', await w.api('POST', `/api/v1/transfers/proposals/${d3.id}/reject`, {}))).toMatchObject({ state: 'rejected', lifecycle: 'rejected', errorCode: 'rejected_by_owner' });
    err('rejectTransfer', await w.api('POST', `/api/v1/transfers/proposals/${d3.id}/reject`, {}), 409, 'bad_state');
    err('requestApproval', await w.api('POST', `/api/v1/transfers/proposals/${d3.id}/request-approval`, {}), 409, 'bad_state');
  });

  it('every stored state has a view that the contract accepts; `state` never leaves its frozen vocabulary', async () => {
    const frozen = doc.components.schemas.ProposalState.enum as string[], lifecycles = new Set<string>();
    expect(frozen).not.toContain('dropped');
    const { STATES } = await import('@spw/core');
    // the database allows one transaction in flight per network: the three in-flight states are seeded on three networks
    const elsewhere: Record<string, string> = { approved: 'ethereum', signed: 'arbitrum', broadcast: 'optimism' };
    for (const state of STATES) {
      const id = await w.proposal({ state, ...(elsewhere[state] ? { network: elsewhere[state], asset: 'native', symbol: 'ETH', decimals: 18 } : {}), txid: `0x${(STATES.indexOf(state) + 10).toString(16).padStart(64, 'a')}`, idempotency_key: `state-${state}`, ...(state === 'signed' ? { relay_attempted_at: new Date() } : {}), ...(state === 'finalized' ? { fee_paid: '21000000000000', finalized_at: new Date() } : {}) });
      const v = ok('getTransfer', await get(`/api/v1/transfers/proposals/${id}`));
      expect(frozen, state).toContain(v.state); lifecycles.add(v.lifecycle);
      if (state === 'dropped') expect(v).toMatchObject({ state: 'failed', lifecycle: 'dropped', watched: true, finalized: false });
      if (state === 'finalized') expect(v).toMatchObject({ lifecycle: 'confirmed', finalized: true, feePaid: '21000000000000', feePaidDisplay: '0.000021' });
      if (state === 'signed') expect(v.lifecycle).toBe('broadcasting');
    }
    const exp = await w.proposal({ state: 'failed', error_code: 'expired_onchain', error: 'x', idempotency_key: 'state-expired-onchain' });
    expect(ok('getTransfer', await get(`/api/v1/transfers/proposals/${exp}`)).lifecycle).toBe('expired');
    // other kinds: their own sections are free-form here, the common members are checked
    await w.proposal({ kind: 'swap', network: 'base', asset: 'native', symbol: 'ETH', decimals: 18, amount: '10000000000000000', out_amount: '19900000', idempotency_key: 'kind-swap',
      swap: w.sql.json({ provider: 'kyberswap', toAsset: USDC.id, toSymbol: 'USDC', toDecimals: 6, expectedOut: '20000000', minOut: '19800000', slippageBps: 50, needsApproval: false, simulated: true }) });
    for (const p of await w.sql`select id from proposals`) ok('getTransfer', await get(`/api/v1/transfers/proposals/${p.id}`));
    expect([...lifecycles].sort()).toEqual([...doc.components.schemas.Lifecycle['x-spw-values']].filter((l: string) => l !== 'signed' && l !== 'expired').concat('expired').sort());
  });
});

describe('activity, exports, events', () => {
  it('activity (operations and receipts) and the two CSV exports', async () => {
    await w.sql`insert into scan_cursor (network, cursor, finalized) values ('base', 500, 400)`;
    await w.deposit({ txid: `0x${'11'.repeat(32)}`, amount: '1500000000000000000', from: DEST_LOWER, block: 300 });
    await w.deposit({ txid: `0x${'22'.repeat(32)}`, asset: USDC.id, amount: '19900000', from: '0x1111111254eeb25477b68fb85ed929f73a960582', kind: 'internal', origin: 'swap', block: 450 });
    await w.deposit({ txid: `0x${'33'.repeat(32)}`, amount: '7', kind: 'external', detection: 'aggregate', blockHash: `0x${'33'.repeat(32)}`, block: 451 });
    const a = ok('listActivity', await get('/api/v1/activity?limit=500'));
    expect(new Set(a.items.map((i: any) => i.kind))).toEqual(new Set(['send', 'swap', 'receive']));
    expect(a.items.find((i: any) => i.kind === 'receive' && i.from === DEST_LOWER)).toMatchObject({ contactLabel: 'Alice', state: 'finalized', depositKind: 'external' });
    expect(a.items.find((i: any) => i.kind === 'send').contactLabel).toBe('Alice');
    ok('listActivity', await get(`/api/v1/activity?network=base&asset=${USDC.id}`));
    err('listActivity', await get('/api/v1/activity?limit=0'), 400, 'bad_request');
    for (const [id, path, head] of [['exportActivityCsv', '/api/v1/export/activity.csv', 'time_utc,direction,'], ['dashboardActivityCsv', '/api/v1/dashboard/activity.csv', 'time_utc,kind,']] as const) {
      const r = await get(path);
      expect(r.status).toBe(200); expect(String(r.headers['content-type'])).toMatch(/^text\/csv/);
      expect(opOf(id).responses['200'].content['text/csv']).toBeTruthy(); expect(r.body.startsWith(head)).toBe(true); expect(r.body.endsWith(',contact_label\n') || r.body.split('\n')[0]!.endsWith(',contact_label')).toBe(true);
      covered.add(id);
    }
  });

  it('events: catch-up, reset, and the stream', async () => {
    const e = ok('listEvents', await get('/api/v1/events?after=0'));
    expect(e.events.length).toBeGreaterThan(5); expect(e.reset).toBe(false);
    for (const t of new Set<string>(e.events.map((x: any) => x.type))) expect(Object.keys(spec.EVENT_TYPES), t).toContain(t);
    expect(ok('listEvents', await get('/api/v1/events?after=999999'))).toMatchObject({ reset: true, events: [] });
    err('listEvents', await get('/api/v1/events?after=-1'), 400, 'bad_request');
    const s = await sseHead(`/api/v1/events/stream?after=${e.latest}`);
    expect(s.contentType).toMatch(/text\/event-stream/); expect(s.first).toMatch(/event: hello\ndata: \{"from":\d+\}/);
    expect(opOf('streamEvents').responses['200'].content['text/event-stream']).toBeTruthy(); covered.add('streamEvents');
  });
});

describe('alerts and push', () => {
  it('list, counters, read, settings, the stream, webhook and push devices', async () => {
    const d = await (await import('../src/alerts/dispatcher.ts')).alerts();
    await d.raise({ kind: 'transfer.recovered', params: { network: 'Base', symbol: 'USDC', amount: '25', what: '@transfer', was: '@dropped', state: '@confirming' }, subject: { type: 'proposal', id: 'p1', network: 'base' } });
    await d.raise({ kind: 'deposit.received', params: { network: 'Base', symbol: 'ETH', amount: '1.5' }, subject: { type: 'deposit', id: '0x1', network: 'base' } });
    await d.raise({ kind: 'system.api_restarted', params: {} });
    const l = ok('listAlerts', await get('/api/v1/alerts'));
    expect(l.items.length).toBeGreaterThanOrEqual(3); expect(l.critical).toBeGreaterThanOrEqual(1);
    ok('listAlerts', await get('/api/v1/alerts?severity=critical&group=transfers&unread=1&limit=5'));
    err('listAlerts', await get('/api/v1/alerts?severity=loud'), 400, 'bad_request');
    ok('unreadAlerts', await get('/api/v1/alerts/unread'));
    expect(ok('readAlerts', await w.api('POST', '/api/v1/alerts/read', { ids: [l.items[0].id] })).unread).toBe(l.unread - 1);
    ok('readAlerts', await w.api('POST', '/api/v1/alerts/read', { all: true }));
    err('readAlerts', await w.api('POST', '/api/v1/alerts/read', { ids: [] }), 400, 'bad_request');
    const s = ok('getAlertSettings', await get('/api/v1/alerts/settings'));
    for (const k of ['transfer.dropped', 'transfer.replaced', 'transfer.expired', 'transfer.recovered']) expect(s.settings.rules[k], k).toBe(true);
    ok('putAlertSettings', await w.api('PUT', '/api/v1/alerts/settings', { rules: { 'deposit.received': false }, showDetails: true }));
    err('putAlertSettings', await w.api('PUT', '/api/v1/alerts/settings', { rules: { 'no.such.kind': true } }), 400, 'bad_request');
    const sse = await sseHead('/api/v1/alerts/stream');
    expect(sse.contentType).toMatch(/text\/event-stream/); expect(sse.first).toMatch(/event: unread\ndata: \{"unread":\d+,"critical":\d+,"lastId":\d+\}/); covered.add('streamAlerts');
    expect(ok('rotateWebhookSecret', await w.api('POST', '/api/v1/alerts/webhook/secret', {})).secret.length).toBeGreaterThan(20);
    await w.api('PUT', '/api/v1/alerts/settings', { webhook: { url: 'https://hooks.example.test/spw', enabled: true } });
    ok('testWebhook', await w.api('POST', '/api/v1/alerts/webhook/test', {}));
    ok('pushKey', await get('/api/v1/push/key'));
    const { generateSubscriptionKeys } = await import('../src/alerts/webpush.ts'), k = generateSubscriptionKeys();
    const sub = ok('subscribePush', await w.api('POST', '/api/v1/push/subscriptions', { endpoint: 'https://fcm.googleapis.com/fcm/send/contract', keys: { p256dh: k.p256dh, auth: k.auth }, label: 'Phone', locale: 'en' }));
    err('subscribePush', await w.api('POST', '/api/v1/push/subscriptions', { endpoint: 'https://evil.example/push', keys: { p256dh: k.p256dh, auth: k.auth } }), 400, 'bad_request');
    expect(ok('listPushSubscriptions', await get('/api/v1/push/subscriptions'))).toHaveLength(1);
    ok('updatePushSubscription', await w.api('PATCH', `/api/v1/push/subscriptions/${sub.id}`, { label: 'iPhone' }));
    err('updatePushSubscription', await w.api('PATCH', `/api/v1/push/subscriptions/${crypto.randomUUID()}`, { label: 'x' }), 404, 'not_found');
    expect(ok('testPush', await w.api('POST', '/api/v1/push/test', {})).results).toHaveLength(1);
    ok('deletePushSubscription', await w.api('DELETE', `/api/v1/push/subscriptions/${sub.id}`));
    err('testPush', await w.api('POST', '/api/v1/push/test', {}), 404, 'not_found');
    // the only things `fetch` was asked for outside this machine's signer: the scripted price source, push service and webhook
    for (const u of w.outbound) expect(u, u).toMatch(/^https:\/\/(api\.coingecko\.com|fcm\.googleapis\.com|hooks\.example\.test)\//);
  });
});

describe('dashboard, analytics, search', () => {
  it('dashboard aggregates', async () => {
    ok('dashboardStatus', await get('/api/v1/dashboard/status'));
    ok('dashboardSummary', await get('/api/v1/dashboard/summary'));
    const a = ok('dashboardActivity', await get('/api/v1/dashboard/activity?limit=200'));
    expect(a.errors).toEqual([]); expect(a.items.some((i: any) => i.wallet?.contactLabel === 'Alice')).toBe(true);
    const only = ok('dashboardActivity', await get(`/api/v1/dashboard/activity?network=base&asset=${USDC.id}&limit=200`));
    expect(only.items.length).toBeGreaterThan(0); expect(only.items.every((i: any) => i.source === 'wallet' && i.wallet.asset === USDC.id)).toBe(true);
    err('dashboardActivity', await get('/api/v1/dashboard/activity?cursor=AAAA'), 400, 'invalid_cursor');
  });
  it('analytics and search', async () => {
    for (const range of ['1M', '3M', '1Y', 'ALL']) expect(ok('getAnalytics', await get(`/api/v1/analytics?range=${range}`)).range).toBe(range);
    ok('getAnalytics', await get('/api/v1/analytics?currency=USD'));
    err('getAnalytics', await get('/api/v1/analytics?range=1W'), 400, 'bad_request');
    const s = ok('search', await get('/api/v1/search?q=alice'));
    expect(s.contacts.items[0]).toMatchObject({ type: 'contact', label: 'Alice', matched: 'label' });
    for (const q of ['usdc', 'base', '0x70997970', '25', '1.5', USDC.id, `0x${'11'.repeat(32)}`]) ok('search', await get(`/api/v1/search?q=${encodeURIComponent(q)}`));
    err('search', await get('/api/v1/search?q=a'), 400, 'bad_request');
  });
});

describe('security (described as the code is today), then the end of the session', () => {
  it('overview, audit, passkeys, adding a passkey, the halt, logout and revoke-all', async () => {
    const o = ok('securityOverview', await get('/api/v1/security/overview'));
    expect(o.signer).toMatchObject({ reachable: true, halted: false }); expect(o.devices).toHaveLength(1); expect(o.sessions.length).toBeGreaterThan(0);
    expect(ok('securityAudit', await get('/api/v1/security/audit?limit=500')).intact).toBe(true);
    expect(ok('listDevices', await get('/api/v1/security/devices'))).toHaveLength(1);
    const phone = new TestPasskey(RP, ORIGIN);
    const d1 = ok('deviceOptions', await w.api('POST', '/api/v1/security/devices/options', {}));
    const d2 = ok('deviceVerify', await w.api('POST', '/api/v1/security/devices/verify', { challengeId: d1.challengeId, response: phone.register(d1.options.challenge), label: 'Phone' }));
    err('deviceConfirm', await w.api('POST', '/api/v1/security/devices/confirm', { pendingId: 'nope', assertion: {} }), 400, 'expired');
    ok('deviceConfirm', await w.api('POST', '/api/v1/security/devices/confirm', { pendingId: d2.pendingId, assertion: w.owner.assert(Buffer.from(d2.options.challenge, 'base64url')) }));
    expect(ok('securityOverview', await get('/api/v1/security/overview')).devices.every((x: any) => x.enrolledOnSigner)).toBe(true);
    // the halt: one-way; afterwards the signer's policy refuses every transfer
    expect(ok('emergencyHalt', await w.api('POST', '/api/v1/security/emergency-halt', {}))).toEqual({ ok: true, halted: true });
    expect(ok('getPortfolio', await get('/api/v1/portfolio')).halted).toBe(true);
    err('createTransfer', await draft('0.01'), 422, 'policy');
    // the signer unreachable: reads still answer, and say so
    const sc = await import('../src/signer-client.ts'), { UserError } = await import('../src/config.ts'), status = sc.signer.status;
    sc.signer.status = async () => { throw new UserError('signer_unreachable', 'the signer is unreachable; nothing was signed', 503); };
    try {
      expect(ok('securityOverview', await get('/api/v1/security/overview')).signer).toEqual({ reachable: false });
      expect(ok('listAccounts', await get('/api/v1/accounts')).signerReachable).toBe(false);
      expect(ok('getPortfolio', await get('/api/v1/portfolio'))).toMatchObject({ halted: null, signer: { reachable: false } });
      err('createTransfer', await draft('0.01'), 503, 'signer_unreachable');
    } finally { sc.signer.status = status; }
    ok('logout', await w.api('POST', '/api/v1/auth/logout', {}));
    err('getSettings', await get('/api/v1/settings'), 401, 'unauthenticated');
    await w.login();
    ok('revokeAllSessions', await w.api('POST', '/api/v1/security/sessions/revoke-all', {}));
    err('getSettings', await get('/api/v1/settings'), 401, 'unauthenticated');
  });
});

describe('coverage', () => {
  it('every operation of the document was called and validated', () => {
    const all = spec.OPERATIONS.map((o) => o.id);
    expect(all.filter((id) => !covered.has(id)), 'operations of the contract that this file never exercised').toEqual([]);
    expect(covered.size).toBe(all.length);
    expect(findings).toEqual([]);
  });
  it('the whole file stays well inside the rate limit of one address (240 a minute): a 429 would be a false failure', async () => {
    const left = Number((await w.api('GET', '/api/v1/health/live', undefined, { cookie: null })).headers['x-ratelimit-remaining']);
    expect(left).toBeGreaterThan(40);
  });
});
