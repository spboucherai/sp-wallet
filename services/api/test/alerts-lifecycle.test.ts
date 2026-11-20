// NEXT — alerts for the life-cycle outcomes that are neither "confirmed" nor "failed" (dropped, replaced, expired on-chain,
// recovered), through the real dispatcher on its own database: the audit events are the ones `move` writes
// (`transfer.<state>`, transfers.ts), in the orders the worker really produces (worker.ts `reconcile`):
//   broadcast → dropped → confirming → finalized        dropped, then RECOVERED, then the ordinary confirmation
//   broadcast → replaced → finalized                    replaced, then RECOVERED (and no second "confirmed")
//   broadcast → failed (expired_onchain)                expired — "nothing moved", not a bare failure
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ALERT_DEFS, alertDef, renderAlert, safeParams } from '@spw/core';
import type { AlertDispatcher } from '../src/alerts/dispatcher.ts';
import { decryptPush, generateSubscriptionKeys } from '../src/alerts/webpush.ts';
import { addProposal, SIGNER_OK, world, type World } from './alerts-helpers.ts';

let w: World, d: AlertDispatcher, sql: any;
const calls: { url: string; body: Buffer; headers: Headers }[] = [];
const NEW = ['transfer.dropped', 'transfer.replaced', 'transfer.expired', 'transfer.recovered'];
const kinds = async () => (await w.alerts()).map((a) => a.kind);
const one = async (kind: string) => { const r = await w.alerts(`kind = '${kind}'`); expect(r, kind).toHaveLength(1); return r[0]; };
/** the audit event `move` writes for a transition */
const moved = (id: string, to: string, extra: Record<string, unknown> = {}) => w.db.audit(`transfer.${to}`, 'system', { id, network: 'base', symbol: 'USDC', amount: '25000000', to: '0xto', txid: '0xabc', hash: 'h', error: null, ...extra });
const settings = (patch: Record<string, unknown> = {}) => w.store.saveAlertSettings({ ...w.store.DEFAULT_SETTINGS, ...patch } as never);

beforeAll(async () => {
  w = await world('alerts_lifecycle'); sql = w.sql; d = w.dispatcher();
  w.env.fetch = (async (url: unknown, init: RequestInit) => { calls.push({ url: String(url), headers: new Headers(init.headers), body: Buffer.from(init.body as Uint8Array | string) }); return new Response(null, { status: 201 }); }) as typeof fetch;
  await d.tail();
});
afterAll(async () => { await sql?.end(); });
beforeEach(async () => {
  await d.tail();
  await sql`truncate alerts restart identity`; await sql`delete from alert_state`; await sql`delete from push_subscriptions`; await sql`truncate proposals`;
  await settings();
  Object.assign(w.env, { signer: SIGNER_OK, rpc: [], loops: [], backup: null, disk: null, fault: undefined });
  calls.length = 0;
});

describe('catalogue', () => {
  it('the four kinds exist, are ON by default, with the right severities and group', () => {
    const sev: Record<string, string> = { 'transfer.dropped': 'warning', 'transfer.replaced': 'warning', 'transfer.expired': 'warning', 'transfer.recovered': 'critical' };
    for (const k of NEW) {
      expect(alertDef(k), k).toMatchObject({ group: 'transfers', severity: sev[k], on: true });
      expect(w.store.DEFAULT_SETTINGS.rules[k], k).toBe(true);
      expect(alertDef(k)!.fixed, k).toBeUndefined();                 // the owner can switch them
    }
    expect(ALERT_DEFS.filter((x) => NEW.includes(x.kind))).toHaveLength(4);
  });

  it('the wording says what is known and nothing more; the lock-screen wording carries no amount and no symbol', () => {
    const p = { network: 'Base', symbol: 'USDC', amount: '25', what: '@transfer', was: '@dropped', state: '@confirming' };
    expect(renderAlert('transfer.dropped', p, 'en').body).toBe('Transfer of 25 USDC on Base: the network no longer knows this transaction and it is not confirmed. It stays watched and is recorded if it appears; a new send on this network replaces it.');
    expect(renderAlert('transfer.dropped', p, 'fr').body).toMatch(/^Transfert de 25 USDC sur Base : le réseau ne connaît plus cette transaction.*reste surveillée.*un nouvel envoi sur ce réseau la remplace\.$/);
    expect(renderAlert('transfer.replaced', p, 'en').body).toMatch(/another transaction used the same nonce or the same coins.*re-checked for a day/);
    expect(renderAlert('transfer.expired', p, 'en').body).toMatch(/validity window closed before the network included it\. Nothing moved/);
    expect(renderAlert('transfer.expired', p, 'fr').body).toMatch(/Rien n’a bougé/);
    expect(renderAlert('transfer.recovered', p, 'en')).toEqual({ title: 'Transaction found on the network', body: 'Transfer of 25 USDC on Base: this transaction, reported “not included”, is confirming after all. It did happen: do not make it again.' });
    expect(renderAlert('transfer.recovered', { ...p, was: '@replaced', state: '@confirmed' }, 'fr').body).toBe('Transfert de 25 USDC sur Base : cette transaction, signalée « remplacée », est finalement confirmée. Elle a bien eu lieu : ne la refaites pas.');
    for (const k of NEW) for (const l of ['fr', 'en'] as const) {
      const priv = renderAlert(k, p, l, false).body;
      expect(priv, `${k} ${l}`).not.toMatch(/25|USDC|—|[{}]/);
      expect(priv, `${k} ${l}`).toContain('Base');
      expect(priv.length).toBeGreaterThan(20);
    }
    expect(renderAlert('transfer.recovered', p, 'en', false).body).toBe('Transfer on Base: a transaction you believed lost is confirming. It did happen: do not make it again.');
    expect(safeParams(p)).toEqual({ network: 'Base', what: '@transfer', state: '@confirming' });   // `was`, the amount and the symbol never leave without "details"
    // a dropped transfer is never called failed, lost or cancelled
    for (const l of ['fr', 'en'] as const) expect(`${renderAlert('transfer.dropped', p, l).title} ${renderAlert('transfer.dropped', p, l).body}`).not.toMatch(/fail|échou|lost|perdu|cancel|annul/i);
  });
});

describe('rules', () => {
  it('dropped: one caution, with what the operation is', async () => {
    const tr = await addProposal(sql, { state: 'dropped' }), sw = await addProposal(sql, { state: 'dropped', kind: 'swap', symbol: 'ETH', decimals: 18, amount: '500000000000000000', swap: { toSymbol: 'USDC' } });
    await moved(tr, 'broadcast'); await moved(tr, 'dropped', { error: 'no longer known to the network' }); await moved(sw, 'dropped');
    expect(await d.tail()).toBe(2);
    const rows = await w.alerts(`kind = 'transfer.dropped'`);
    expect(rows.map((a) => a.params)).toEqual([{ network: 'Base', symbol: 'USDC', amount: '25', what: '@transfer' }, { network: 'Base', symbol: 'ETH', amount: '0.5', what: '@swap' }]);
    expect(rows[0]).toMatchObject({ severity: 'warning', source: 'audit', subject: { type: 'proposal', id: tr, network: 'base' } });
    expect(await d.tail()).toBe(0);                                  // the same events are never announced twice
  });

  it('dropped → confirming → finalized: RECOVERED once (critical), then the ordinary confirmation', async () => {
    const id = await addProposal(sql, { state: 'dropped' });
    await moved(id, 'broadcast'); await moved(id, 'dropped'); await d.tail();
    await moved(id, 'confirming'); await d.tail();
    const r = await one('transfer.recovered');
    expect(r).toMatchObject({ severity: 'critical', params: { network: 'Base', symbol: 'USDC', amount: '25', what: '@transfer', was: '@dropped', state: '@confirming' }, subject: { type: 'proposal', id } });
    await moved(id, 'finalized'); await d.tail();
    expect(await kinds()).toEqual(['transfer.dropped', 'transfer.recovered', 'transfer.confirmed']);   // not recovered a second time
  });

  it('replaced → finalized: RECOVERED says it is confirmed, and "confirmed" is not sent on top of it', async () => {
    const id = await addProposal(sql, { state: 'replaced', kind: 'bridge', bridge: { toNetwork: 'arbitrum', phase: 'burn' } });
    await moved(id, 'broadcast'); await moved(id, 'replaced', { error: 'another transaction used the same nonce' }); await d.tail();
    expect((await one('transfer.replaced'))).toMatchObject({ severity: 'warning', params: { what: '@bridge', network: 'Base' } });
    await moved(id, 'finalized'); await d.tail();
    expect((await one('transfer.recovered')).params).toMatchObject({ was: '@replaced', state: '@confirmed', what: '@bridge' });
    expect(await kinds()).toEqual(['transfer.replaced', 'transfer.recovered']);
  });

  it('the ordinary path is unchanged: confirming says nothing, finalized confirms, a revert fails', async () => {
    const ok = await addProposal(sql), bad = await addProposal(sql, { state: 'failed', error: 'reverted on-chain' });
    for (const s of ['pending_approval', 'approved', 'signed', 'broadcast', 'confirming', 'finalized']) await moved(ok, s);
    await moved(bad, 'broadcast'); await moved(bad, 'failed', { error: 'reverted on-chain' });
    await d.tail();
    expect((await kinds()).sort()).toEqual(['transfer.confirmed', 'transfer.failed']);
    // a reorganisation is not a recovery: confirming → reorged → confirming says nothing
    const re = await addProposal(sql, { state: 'confirming' });
    for (const s of ['broadcast', 'confirming', 'reorged', 'confirming']) await moved(re, s);
    await d.tail();
    expect((await kinds()).sort()).toEqual(['transfer.confirmed', 'transfer.failed']);
  });

  it('expired on-chain is said as "nothing moved"; the approval window passing (nothing signed) says nothing', async () => {
    const id = await addProposal(sql, { state: 'failed', error: 'its validity window closed before the network included it; nothing moved' });
    await sql`update proposals set error_code = 'expired_onchain' where id = ${id}`;
    const never = await addProposal(sql, { state: 'expired', error: 'approval window expired' });
    await sql`update proposals set error_code = 'approval_expired' where id = ${never}`;
    await moved(id, 'broadcast'); await moved(id, 'failed'); await moved(never, 'expired');
    await d.tail();
    expect(await kinds()).toEqual(['transfer.expired']);             // not `transfer.failed`, and nothing for the unsigned one
    expect(await one('transfer.expired')).toMatchObject({ severity: 'warning', params: { network: 'Base', symbol: 'USDC', amount: '25', what: '@transfer' }, subject: { type: 'proposal', id } });
    // a swap keeps its own kind (its reason carries the sentence)
    const sw = await addProposal(sql, { state: 'failed', kind: 'swap', error: 'its validity window closed' });
    await sql`update proposals set error_code = 'expired_onchain' where id = ${sw}`;
    await moved(sw, 'failed'); await d.tail();
    expect((await kinds()).sort()).toEqual(['swap.failed', 'transfer.expired']);
  });

  it('a second drop of the same transfer is announced again, and so is its second recovery', async () => {
    const id = await addProposal(sql, { state: 'dropped' });
    for (const s of ['broadcast', 'dropped', 'confirming', 'reorged', 'dropped', 'finalized']) { await moved(id, s); await d.tail(); }
    expect(await kinds()).toEqual(['transfer.dropped', 'transfer.recovered', 'transfer.dropped', 'transfer.recovered']);
    expect((await w.alerts(`kind = 'transfer.recovered'`)).map((a) => a.params.state)).toEqual(['@confirming', '@confirmed']);
  });

  it('through the real state machine: the events `move` writes are the ones these rules read', async () => {
    const { move, failure } = await import('../src/transfers.ts');
    const row = async (id: string) => (await sql`select * from proposals where id = ${id}`)[0];
    const a = await addProposal(sql, { state: 'broadcast' });
    let p = await move(await row(a), 'dropped', { ...failure('dropped'), confirmations: 0 }); await d.tail();
    expect((await one('transfer.dropped')).subject).toMatchObject({ type: 'proposal', id: a });
    p = await move(p, 'confirming', { confirmations: 1, error: null }); await d.tail();
    expect((await one('transfer.recovered')).params).toMatchObject({ was: '@dropped', state: '@confirming', amount: '25', symbol: 'USDC' });
    await move(p, 'finalized', { finalized_at: new Date() }); await d.tail();
    expect(await kinds()).toEqual(['transfer.dropped', 'transfer.recovered', 'transfer.confirmed']);
    // replaced, then found final; and the on-chain expiry as the worker records it
    const b = await addProposal(sql, { state: 'broadcast' });
    p = await move(await row(b), 'replaced', failure('replaced_onchain', {}, 'nonce consumed by another transaction')); await d.tail();
    await move(p, 'finalized', { finalized_at: new Date(), error: null }); await d.tail();
    const c = await addProposal(sql, { state: 'broadcast' });
    await move(await row(c), 'failed', failure('expired_onchain', {}, 'blockhash expired')); await d.tail();
    expect((await kinds()).slice(3)).toEqual(['transfer.replaced', 'transfer.recovered', 'transfer.expired']);
    expect((await w.alerts(`kind = 'transfer.recovered'`)).map((x) => [x.subject.id, x.params.was, x.params.state])).toEqual([[a, '@dropped', '@confirming'], [b, '@replaced', '@confirmed']]);
  });

  it('the owner\'s switch is respected; no address, hash or transaction id is in any of these alerts', async () => {
    await settings({ rules: { ...w.store.DEFAULT_SETTINGS.rules, 'transfer.dropped': false } });
    const id = await addProposal(sql, { state: 'dropped' });
    await moved(id, 'broadcast'); await moved(id, 'dropped'); await moved(id, 'confirming'); await d.tail();
    expect(await kinds()).toEqual(['transfer.recovered']);           // the recovery of a drop that was not announced is still told
    for (const a of await w.alerts()) expect(JSON.stringify(a.params)).not.toMatch(/0xto|0xfrom|0xabc|"h"/);
  });
});

describe('delivery', () => {
  const sub = generateSubscriptionKeys();
  const subscribe = () => sql`insert into push_subscriptions (id, endpoint, p256dh, auth, label, locale) values (${randomUUID()}, 'https://fcm.googleapis.com/fcm/send/abc', ${sub.p256dh}, ${sub.auth}, 'iPhone', 'fr')`;
  const pushes = () => calls.filter((c) => c.url.startsWith('https://fcm.')).map((c) => JSON.parse(decryptPush(c.body, sub).toString()));

  it('a recovery passes quiet hours (critical); a drop waits in the app; the push hides the amount by default', async () => {
    await subscribe();
    const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);
    await settings({ quiet: { enabled: true, start: hhmm(w.clock.t - 3_600_000), end: hhmm(w.clock.t + 3_600_000), tz: 'UTC' } });
    const id = await addProposal(sql, { state: 'dropped' });
    await moved(id, 'broadcast'); await moved(id, 'dropped'); await moved(id, 'confirming'); await d.tail();
    expect(await d.deliver()).toEqual({ sent: 1, quiet: 1, capped: 0 });
    const [p] = pushes();
    expect(p).toMatchObject({ kind: 'transfer.recovered', sev: 'critical', d: false, p: { network: 'Base', what: '@transfer', state: '@confirming' }, s: { type: 'proposal', id } });
    expect(JSON.stringify(p.p)).not.toMatch(/25|USDC|dropped/);
    expect(calls[0]!.headers.get('urgency')).toBe('high');
    expect((await one('transfer.dropped')).delivery).toBe('quiet');
  });
});
