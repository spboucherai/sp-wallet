// NEXT — hidden / favourite assets and the editable address book: what is stored, what is refused, what is announced.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from './test-db.ts';

let sql: any, app: any;
const token = 'p'.repeat(43), H = { cookie: `__Host-spw=${token}`, origin: 'https://wallet.test', 'x-spw-csrf': '1', 'content-type': 'application/json' };
const call = (method: string, url: string, body?: unknown) => app.inject({ method, url, headers: H, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
const A1 = '0x' + '1a'.repeat(20), A2 = '0x' + '2b'.repeat(20);

beforeAll(async () => {
  await useTestDatabase('prefs');
  const db = await import('../src/db.ts'); sql = db.sql;
  await db.migrate();
  app = await (await import('../src/server.ts')).buildServer();
  await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
});
afterAll(async () => { await app?.close(); await sql?.end(); });
beforeEach(async () => { await sql`delete from asset_prefs`; await sql`delete from address_book`; await sql`truncate wallet_events restart identity`; });

describe('asset preferences', () => {
  it('hidden and favourite are stored per network and asset, changed one at a time, and announced to the other devices', async () => {
    expect((await call('GET', '/api/v1/assets/prefs')).json()).toEqual({ prefs: [] });
    expect((await call('PUT', '/api/v1/assets/prefs/base/native', { hidden: true })).json()).toMatchObject({ network: 'base', asset: 'native', hidden: true, favorite: false });
    expect((await call('PUT', '/api/v1/assets/prefs/base/native', { favorite: true })).json()).toMatchObject({ hidden: true, favorite: true }); // the other flag is kept
    expect((await call('PUT', '/api/v1/assets/prefs/base/native', { hidden: false })).json()).toMatchObject({ hidden: false, favorite: true });
    expect((await call('GET', '/api/v1/assets/prefs')).json().prefs).toHaveLength(1);
    await call('PUT', '/api/v1/assets/prefs/base/native', { favorite: false });
    expect((await call('GET', '/api/v1/assets/prefs')).json().prefs).toEqual([]); // back to default: not listed
    expect((await sql`select type from wallet_events`).map((r: any) => r.type)).toEqual(Array(4).fill('settings.asset_pref'));
  });
  it('refuses an asset outside the registry, an empty change and unknown fields', async () => {
    expect((await call('PUT', '/api/v1/assets/prefs/base/0xdeadbeef', { hidden: true })).statusCode).toBe(404);
    expect((await call('PUT', '/api/v1/assets/prefs/nowhere/native', { hidden: true })).statusCode).toBe(404);
    expect((await call('PUT', '/api/v1/assets/prefs/base/native', {})).statusCode).toBe(400);
    expect((await call('PUT', '/api/v1/assets/prefs/base/native', { hidden: true, price: 1 })).statusCode).toBe(400);
  });
});

describe('address book', () => {
  const add = async (address = A1, label = 'Alice') => (await call('POST', '/api/v1/addressbook', { network: 'base', address, label })).json();
  it('label, note and favourite can be edited; favourites come first', async () => {
    const a = await add(), b = await add(A2, 'Bob');
    const r = (await call('PATCH', `/api/v1/addressbook/${b.id}`, { label: 'Bob (pro)', note: 'facture 12', favorite: true })).json();
    expect(r).toMatchObject({ id: b.id, label: 'Bob (pro)', note: 'facture 12', favorite: true, address: b.address });
    expect((await call('GET', '/api/v1/contacts')).json().contacts.map((c: any) => c.label)).toEqual(['Bob (pro)', 'Alice']);
    expect((await call('GET', '/api/v1/addressbook')).json().find((c: any) => c.id === a.id)).toMatchObject({ label: 'Alice' }); // the route shipped clients read is unchanged
  });
  it('changing where a contact points needs the address the client believes is current, and is a security event', async () => {
    const a = await add();
    expect((await call('PATCH', `/api/v1/addressbook/${a.id}`, { address: A2 })).statusCode).toBe(409);
    expect((await call('PATCH', `/api/v1/addressbook/${a.id}`, { address: A2, currentAddress: A2 })).json().error).toBe('stale_contact');
    const ok = (await call('PATCH', `/api/v1/addressbook/${a.id}`, { address: A2, currentAddress: a.address })).json();
    expect(ok.address.toLowerCase()).toBe(A2);
    const ev = await sql`select type, data from wallet_events order by id desc limit 1`;
    expect(ev[0].type).toBe('security.contact_address_changed'); expect(ev[0].data).toMatchObject({ from: a.address, label: 'Alice' });
  });
  it('refuses an invalid address, a duplicate of another contact, and an unknown contact', async () => {
    const a = await add(), b = await add(A2, 'Bob');
    expect((await call('PATCH', `/api/v1/addressbook/${a.id}`, { address: 'nope', currentAddress: a.address })).json().error).toBe('bad_address');
    expect((await call('PATCH', `/api/v1/addressbook/${a.id}`, { address: b.address, currentAddress: a.address })).json().error).toBe('duplicate_contact');
    expect((await call('PATCH', '/api/v1/addressbook/00000000-0000-4000-8000-000000000000', { label: 'x' })).statusCode).toBe(404);
  });
});

describe('settings', () => {
  it('appearance is part of the account: default system, stored, validated', async () => {
    expect((await call('GET', '/api/v1/settings')).json().theme).toBe('system');
    expect((await call('PUT', '/api/v1/settings', { theme: 'dark' })).json()).toMatchObject({ theme: 'dark', locale: 'fr' });
    expect((await call('PUT', '/api/v1/settings', { theme: 'neon' })).statusCode).toBe(400);
  });
});
