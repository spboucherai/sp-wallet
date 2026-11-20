// The alert dispatcher on its own database: event rules (each fires once, digests, switches), exactly-once across a restart,
// a crash before the commit, two dispatchers at once and out-of-order commits, condition rules (debounce, episodes), delivery
// (quiet hours, hourly cap with ONE summary, zero subscriptions, lock-screen privacy) and the signed webhook.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AlertDispatcher } from '../src/alerts/dispatcher.ts';
import { decryptPush, generateSubscriptionKeys } from '../src/alerts/webpush.ts';
import { verifyWebhook } from '../src/alerts/webhook.ts';
import { addAgent, addPaperAccount, addProposal, addVenueAccount, riskEvent, SIGNER_OK, world, type World } from './alerts-helpers.ts';

let w: World, d: AlertDispatcher, sql: any;
const kinds = async (where?: string) => (await w.alerts(where)).map((a) => a.kind).sort();
const one = async (kind: string) => { const r = await w.alerts(`kind = '${kind}'`); expect(r, kind).toHaveLength(1); return r[0]; };
const settings = async (patch: Record<string, unknown> = {}) => {
  const base = w.store.DEFAULT_SETTINGS;
  await w.store.saveAlertSettings({ ...base, ...patch, rules: { ...base.rules, ...(patch.rules as object) }, thresholds: { ...base.thresholds, ...(patch.thresholds as object) } } as never);
};
const calls: { url: string; headers: Headers; body: Buffer }[] = [];
let pushStatus = 201;

beforeAll(async () => {
  w = await world('alerts_engine'); sql = w.sql; d = w.dispatcher();
  w.env.fetch = (async (url: unknown, init: RequestInit) => { calls.push({ url: String(url), headers: new Headers(init.headers), body: Buffer.from(init.body as Uint8Array | string) }); return new Response(null, { status: pushStatus }); }) as typeof fetch;
  await d.tail();                                                    // cursors are created at the present
});
afterAll(async () => { await sql?.end(); });
beforeEach(async () => {
  await d.tail();                                                    // nothing left over from the previous test
  await sql`truncate alerts restart identity`;
  await sql`delete from alert_state`; await sql`delete from push_subscriptions`;
  await sql`truncate deriv_orders, deriv_fills, deriv_funding, deriv_equity, deriv_accounts, deriv_paper_accounts, proposals`;
  await sql`truncate agents cascade`;
  await settings();
  Object.assign(w.env, { signer: SIGNER_OK, rpc: [], loops: [], backup: null, disk: null, fault: undefined });
  calls.length = 0; pushStatus = 201;
  const health = await import('../src/monitor/health.ts'); health.resetHealthCaches();
});

describe('event rules', () => {
  it('history is not replayed: only what happens after the first pass alerts', async () => {
    await sql`delete from alert_cursors where source = 'audit'`;
    await w.db.audit('deposit.seen', 'chain', { network: 'base', txid: '0xold', asset: 'native', amount: '1000000000000000000' });
    expect(await d.tail()).toBe(0);
    await w.db.audit('deposit.seen', 'chain', { network: 'base', txid: '0xnew', asset: 'native', amount: '1500000000000000000' });
    expect(await d.tail()).toBe(1);
    const a = await one('deposit.received');
    expect(a.params).toEqual({ network: 'Base', symbol: 'ETH', amount: '1.5' });
    expect(a.subject).toMatchObject({ type: 'deposit', id: '0xnew' });
    expect(a).toMatchObject({ severity: 'info', source: 'audit', delivery: 'pending' });
  });

  it('every audit rule fires exactly once, with codes and parameters (not sentences)', async () => {
    await settings({ rules: { 'deriv.position_opened': true } });
    const agent = await addAgent(sql, { name: 'Momentum' }), paper = await addPaperAccount(sql), venue = await addVenueAccount(sql);
    const tr = await addProposal(sql), trFail = await addProposal(sql, { state: 'failed', error: 'reverted on-chain' });
    const sw = await addProposal(sql, { kind: 'swap', symbol: 'ETH', decimals: 18, amount: '500000000000000000', swap: { toSymbol: 'USDC' } }), swFail = await addProposal(sql, { kind: 'swap', state: 'failed' });
    const br = await addProposal(sql, { kind: 'bridge', bridge: { toNetwork: 'arbitrum', phase: 'done' } }), brFail = await addProposal(sql, { kind: 'bridge', state: 'failed', bridge: { toNetwork: 'arbitrum' } });
    const order = randomUUID();
    await sql`insert into agent_orders (id, agent_id, mode, from_asset, to_asset, from_symbol, to_symbol, amount_in, state) values (${order}, ${agent}, 'LIVE', 'a', 'b', 'USDC', 'ETH', 1000000, 'filled')`;
    await sql`insert into deriv_orders (account_id, client_id, instrument, side, type, size, reduce_only, tif, status, created_at, updated_at, state, final)
      values (${venue}, 'c-1', 'hyperliquid:BTC', 'buy', 'limit', 0.01, false, 'gtc', 'filled', now(), now(), 'filled', true)`;
    await sql`insert into sessions (id_hash, expires_at, ua, ip, created_at) values ('old', now() + interval '1 hour', 'Mozilla/5.0 (Macintosh) Chrome/130', '198.51.100.1', now() - interval '1 day')`;
    await sql`insert into sessions (id_hash, expires_at, ua, ip) values ('new', now() + interval '1 hour', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/605', '203.0.113.9')`;
    const ev: [string, string, Record<string, unknown>][] = [
      ['transfer.broadcast', 'system', { id: tr }], ['transfer.finalized', 'system', { id: tr }], ['transfer.failed', 'system', { id: trFail, error: 'reverted on-chain' }],
      ['transfer.finalized', 'system', { id: sw }], ['transfer.failed', 'system', { id: swFail }],
      ['transfer.finalized', 'system', { id: br }], ['bridge.done', 'chain', { id: br, to: 'arbitrum', minted: '24990000' }], ['transfer.failed', 'system', { id: brFail }], ['bridge.mint_reverted', 'chain', { id: br }],
      ['agent.order_filled', 'chain', { agent, id: order }],
      ['agent.stopped', 'engine', { id: agent, reason: 'loss limit reached: equity 80.00 USD against 100.00 USD allocated (limit 15 %); positions were sold to USDC' }],
      ['agent.stopped', 'engine', { id: agent, reason: 'mandate expired' }], ['agent.stopped', 'engine', { id: agent, reason: 'the approved strategy no longer matches the mandate' }],
      ['mandate.revoked', 'owner', { agent }], ['agent.order_refused', 'signer', { agent, reason: 'daily limit exceeded' }],
      ['deriv.paper.fill', 'paper-engine', { account: paper, fill: 'paper-f-1', clientId: 'p1', instrument: 'hyperliquid:BTC', side: 'buy', size: '0.5', price: '100000' }],
      ['deriv.paper.fill', 'paper-engine', { account: paper, fill: 'paper-f-2', clientId: 'p2', instrument: 'hyperliquid:BTC', side: 'sell', size: '0.5', price: '101000' }],
      ['deriv.paper.liquidation', 'paper-engine', { account: paper, positions: 2 }], ['deriv.paper.halt', 'paper-engine', { account: paper, code: 'daily_loss_exceeded' }],
      ['deriv.live.halt', 'owner', { account: venue, reason: 'manual stop' }], ['deriv.live.order_rejected', 'owner', { account: venue, clientId: 'c-0', reason: 'venue said no' }],
      ['deriv.live.order_filled', 'reconciler', { account: venue, clientId: 'c-1', filled: '0.01', avgFillPrice: '100500', final: true }],
      ['deriv.live.policy_replaced', 'owner', { account: venue, maxLeverage: '3' }],
      ['device.added', 'owner', { credential: 'abc', label: 'YubiKey' }], ['login.failed', 'unknown', { why: 'bad assertion', ip: '192.0.2.4' }], ['login.failed', 'unknown', { why: 'bad assertion', ip: '192.0.2.5' }],
      ['login.ok', 'owner', { credential: 'abc', ip: '203.0.113.9' }], ['login.ok', 'owner', { credential: 'abc', ip: '203.0.113.9' }],
      ['addressbook.saved', 'owner', { network: 'base', address: '0x1', label: 'x' }], ['swap.settled', 'chain', { id: sw }],
    ];
    for (const [t, actor, data] of ev) await w.db.audit(t, actor, data);
    await d.tail();
    expect(await kinds()).toEqual(['agent.mandate_revoked', 'agent.order_filled', 'agent.stopped', 'agent.stopped_loss', 'agent.stopped_mandate', 'bridge.confirmed', 'bridge.failed', 'bridge.failed',
      'deriv.halt', 'deriv.live.filled', 'deriv.loss_limit', 'deriv.order_rejected', 'deriv.paper.filled', 'deriv.paper.filled', 'deriv.paper.liquidation', 'deriv.position_closed', 'deriv.position_opened', 'deriv.position_opened',
      'security.login_failed', 'security.new_device', 'security.passkey_added', 'security.policy_changed', 'security.signer_refused', 'swap.confirmed', 'swap.failed', 'transfer.confirmed', 'transfer.failed'].sort());
    expect(await d.tail()).toBe(0);                                  // a second pass adds nothing
    expect((await one('transfer.confirmed')).params).toEqual({ network: 'Base', symbol: 'USDC', amount: '25' });
    expect((await one('swap.confirmed')).params).toEqual({ network: 'Base', symbol: 'ETH', amount: '0.5', toSymbol: 'USDC' });
    expect((await one('bridge.confirmed')).params).toMatchObject({ network: 'Base', to: 'Arbitrum One', amount: '24.99' });
    expect((await one('agent.stopped_loss'))).toMatchObject({ severity: 'critical', subject: { type: 'agent', id: agent } });
    expect((await one('agent.order_filled')).params).toEqual({ agent: 'Momentum', from: 'USDC', to: 'ETH', count: 1 });
    expect((await one('deriv.loss_limit'))).toMatchObject({ severity: 'warning', params: { mode: '@paper', scope: '@daily' } });   // a paper account is simulated: not a critical
    expect((await one('deriv.halt')).severity).toBe('critical');
    expect((await one('deriv.position_closed')).params).toMatchObject({ account: 'Paper HL', mode: '@paper', instrument: 'hyperliquid:BTC' });
    expect((await one('security.login_failed'))).toMatchObject({ count: 2, params: { count: 2, ip: '192.0.2.5' } });
    expect((await one('security.new_device')).params).toEqual({ device: 'Safari · iPhone', ip: '203.0.113.9' });                    // once, although the device signed in twice
    expect((await one('security.passkey_added')).severity).toBe('critical');
    for (const a of await w.alerts()) expect(JSON.stringify(a.params)).not.toMatch(/0xto|0xfrom/);                                  // no address in any alert
  });

  it('risk events and the research log: digests, signal failures in a row, pinned code', async () => {
    const paper = await addPaperAccount(sql), venue = await addVenueAccount(sql), agent = await addAgent(sql, { name: 'Trend' });
    await riskEvent(sql, paper, 'margin_warning', 'margin_warning', 'maintenance margin 480 has reached 80 % of equity 600');
    await riskEvent(sql, paper, 'order_refused', 'leverage_exceeded', 'leverage 12 exceeds 5');
    await riskEvent(sql, paper, 'order_refused', 'order_notional_exceeded', 'order notional too large');
    await riskEvent(sql, venue, 'order_refused', 'signer', 'refused by the signer: daily order count reached');
    await riskEvent(sql, venue, 'divergence', 'state_divergence', 'position hyperliquid:BTC: venue 0.2, wallet records 0.1');
    await riskEvent(sql, venue, 'divergence_cleared', null, 'agree again');
    await riskEvent(sql, paper, 'liquidation', 'liquidated', 'simulated liquidation');   // alerts for this come from the audit chain: ignored here
    for (let i = 0; i < 2; i++) await sql`insert into research_log (agent_id, kind, title, body) values (${agent}, 'hold', 'No valid signal: holding', 'weights sum to more than 1')`;
    await d.tail();
    expect(await kinds(`kind = 'agent.signal_failures'`)).toEqual([]);                    // two failures: below the threshold of three
    await sql`insert into research_log (agent_id, kind, title, body) values (${agent}, 'hold', 'No valid signal: holding', 'weights sum to more than 1')`;
    await sql`insert into research_log (agent_id, kind, title, body) values (${agent}, 'hold', 'No valid signal: holding', 'again')`;
    await sql`insert into research_log (agent_id, kind, title, body) values (${agent}, 'hold', 'Order not placed', 'the swap router bytecode is not the reviewed one; swaps are refused')`;
    await sql`insert into research_log (agent_id, kind, title, body) values (${agent}, 'note', 'Backtest', 'ok')`;
    await d.tail(); await d.tail();
    expect(await kinds()).toEqual(['agent.signal_failures', 'deriv.divergence', 'deriv.divergence_cleared', 'deriv.margin_warning', 'deriv.order_rejected', 'security.pin_mismatch', 'security.signer_refused']);
    expect(await one('deriv.order_rejected')).toMatchObject({ count: 2, params: { account: 'Paper HL', mode: '@paper', count: 2, reason: 'order notional too large' } });
    expect((await one('deriv.divergence')).severity).toBe('critical');
    expect((await one('agent.signal_failures')).params).toEqual({ agent: 'Trend', count: 3 });
    expect((await one('security.pin_mismatch'))).toMatchObject({ severity: 'critical', params: { what: '@router' } });
  });

  it('agent fills: one alert per agent per window, or one per order when the digest is off', async () => {
    const a = await addAgent(sql, { name: 'A' }), b = await addAgent(sql, { name: 'B' });
    for (const agent of [a, a, a, b]) await w.db.audit('agent.order_filled', 'chain', { agent, id: randomUUID() });
    await d.tail();
    const rows = await w.alerts();
    expect(rows.map((r) => [r.params.agent, r.count])).toEqual([['A', 3], ['B', 1]]);
    await sql`update alerts set read_at = now()`;
    await w.db.audit('agent.order_filled', 'chain', { agent: a, id: randomUUID() });
    await d.tail();
    expect((await w.alerts(`params->>'agent' = 'A'`))[0]).toMatchObject({ count: 4, read_at: null });   // the digest is unread again
    await settings({ thresholds: { agentDigestMinutes: 0 } });
    for (let i = 0; i < 2; i++) await w.db.audit('agent.order_filled', 'chain', { agent: b, id: randomUUID() });
    await d.tail();
    expect(await w.alerts(`params->>'agent' = 'B'`)).toHaveLength(3);
  });

  it('a rule switched off produces nothing — and the event is consumed, not kept for later', async () => {
    await settings({ rules: { 'deposit.received': false } });
    await w.db.audit('deposit.seen', 'chain', { network: 'base', txid: '0xa', asset: 'native', amount: '1' });
    await w.db.audit('device.added', 'owner', { label: 'Key' });
    await d.tail();
    expect(await kinds()).toEqual(['security.passkey_added']);
    await settings();
    expect(await d.tail()).toBe(0);
  });

  it('a rule that fails on one event does not stop the others', async () => {
    await w.db.audit('agent.order_filled', 'chain', { agent: 'not-a-uuid', id: 'not-a-uuid' });   // the lookup of the order fails in SQL
    await w.db.audit('device.added', 'owner', { label: 'Key' });
    await d.tail();
    expect(await kinds()).toEqual(['security.passkey_added']);
    expect(await d.tail()).toBe(0);
  });
});

describe('exactly once', () => {
  it('a restart neither repeats nor loses an event', async () => {
    for (const l of ['a', 'b', 'c']) await w.db.audit('device.added', 'owner', { label: l });
    expect(await d.tail()).toBe(3);
    const d2 = w.dispatcher();                                       // a new process: no memory, same database
    expect(await d2.tail()).toBe(0);
    await w.db.audit('device.added', 'owner', { label: 'while-down' });   // written while no dispatcher runs
    const d3 = w.dispatcher();
    expect(await d3.tail()).toBe(1);
    expect(await d.tail()).toBe(0);
    expect((await w.alerts()).map((a) => a.params.label)).toEqual(['a', 'b', 'c', 'while-down']);
  });

  it('a crash before the commit leaves no alert and no cursor move; the next pass does the work once', async () => {
    const [before] = await sql`select cursor from alert_cursors where source = 'audit'`;
    await w.db.audit('device.added', 'owner', { label: 'x' });
    await w.db.audit('deposit.seen', 'chain', { network: 'base', txid: '0xb', asset: 'native', amount: '1' });
    w.env.fault = (_s, src) => { if (src === 'audit') throw new Error('power cut'); };
    await expect(d.tail()).rejects.toThrow('power cut');
    expect(await w.alerts()).toHaveLength(0);                        // the alerts written in that transaction are gone with it
    expect((await sql`select cursor from alert_cursors where source = 'audit'`)[0].cursor).toBe(before.cursor);
    w.env.fault = undefined;
    expect(await w.dispatcher().tail()).toBe(2);
    expect(await w.dispatcher().tail()).toBe(0);
    expect(await kinds()).toEqual(['deposit.received', 'security.passkey_added']);
  });

  it('two dispatchers at the same time produce each alert once', async () => {
    for (let i = 0; i < 20; i++) await w.db.audit('device.added', 'owner', { label: `k${i}` });
    const [a, b] = await Promise.all([w.dispatcher().tail(), w.dispatcher().tail()]);
    expect(a + b).toBe(20);
    expect(await w.alerts()).toHaveLength(20);
  });

  it('a risk event that commits late (lower id, visible after a higher one) is still alerted once', async () => {
    const venue = await addVenueAccount(sql);
    await d.tail();
    const slow = await sql.reserve();
    await slow`begin`;
    await slow`insert into deriv_risk_events (account_id, ts, kind, code, message, data) values (${venue}, now(), 'divergence', 'state_divergence', 'late', '{}')`;   // takes the lower id, not committed
    await riskEvent(sql, venue, 'divergence_cleared', null, 'early');   // higher id, committed first
    expect(await d.tail()).toBe(1);
    expect(await kinds()).toEqual(['deriv.divergence_cleared']);
    await slow`commit`; slow.release();
    expect(await d.tail()).toBe(1);                                  // found in the overlap window behind the cursor
    expect(await d.tail()).toBe(0);
    expect(await w.dispatcher().tail()).toBe(0);
    expect(await kinds()).toEqual(['deriv.divergence', 'deriv.divergence_cleared']);
  });
});

describe('condition rules', () => {
  const H = 3_600_000;
  it('stuck operations, expiring mandates, stale agents, unknown orders, liquidations, funding — once per episode', async () => {
    await d.conditions();                                            // sets the epoch: nothing before it is looked at
    w.clock.advance(1000);
    const now = w.clock.t;
    await addProposal(sql, { state: 'broadcast', createdAt: new Date(now - 2 * H) });
    await addProposal(sql, { state: 'broadcast', network: 'arbitrum', createdAt: new Date(now - 5 * 60_000) }); // recent: not stuck (another network: one in flight per network)
    await addProposal(sql, { kind: 'bridge', state: 'finalized', bridge: { phase: 'attesting' }, createdAt: new Date(now - 3 * H) });
    await addProposal(sql, { kind: 'bridge', state: 'finalized', bridge: { phase: 'done' }, createdAt: new Date(now - 3 * H) });
    const mid = randomUUID();
    await addAgent(sql, { name: 'Live one', state: 'LIVE', mandateId: mid, mandate: { expiresAt: Math.floor((now + 60 * H) / 1000) }, lastBar: new Date(now - H) });
    await addAgent(sql, { name: 'Sleepy', state: 'PAPER_TRADING', lastBar: new Date(now - 10 * H) });
    await addAgent(sql, { name: 'Stopped', state: 'STOPPED', lastBar: new Date(now - 100 * H) });
    const venue = await addVenueAccount(sql), paper = await addPaperAccount(sql);
    await sql`insert into deriv_orders (account_id, client_id, instrument, side, type, size, reduce_only, tif, status, created_at, updated_at, state, final)
      values (${venue}, 'u-1', 'hyperliquid:ETH', 'buy', 'limit', 1, false, 'gtc', 'open', now(), ${new Date(now - 120_000)}, 'unknown', false),
             (${venue}, 'u-2', 'hyperliquid:ETH', 'buy', 'limit', 1, false, 'gtc', 'open', now(), ${new Date(now - 5_000)}, 'unknown', false)`;
    await sql`insert into deriv_fills (account_id, fill_id, instrument, side, price, size, fee, fee_asset, liquidation, ts) values (${venue}, 'f-liq', 'hyperliquid:ETH', 'sell', 3000, 1, 0, 'USDC', true, ${new Date(now - 500)})`;
    await sql`insert into deriv_funding (account_id, instrument, ts, amount, rate, size) values (${paper}, 'hyperliquid:BTC', ${new Date(now - 400)}, -7.5, 0.0001, 1), (${paper}, 'hyperliquid:BTC', ${new Date(now - 300)}, 0.4, 0.0001, 1),
      (${paper}, 'hyperliquid:BTC', ${new Date(now - 100 * H)}, -90, 0.0001, 1)`;
    await d.conditions();
    expect(await kinds()).toEqual(['agent.data_stale', 'deriv.funding', 'deriv.live.liquidation', 'deriv.order_unknown', 'mandate.expiring', 'transfer.stuck', 'transfer.stuck']);
    expect((await w.alerts(`kind = 'transfer.stuck'`)).map((a) => [a.params.what, a.params.state, a.params.minutes])).toEqual([['@transfer', '@broadcast', 120], ['@bridge', '@attesting', 180]]);
    expect((await one('mandate.expiring'))).toMatchObject({ severity: 'info', params: { agent: 'Live one', hours: 72 } });
    expect((await one('agent.data_stale')).params).toEqual({ agent: 'Sleepy', bars: 9, interval: '1h' });
    expect((await one('deriv.order_unknown'))).toMatchObject({ severity: 'critical', params: { clientId: 'u-1', seconds: 60 } });
    expect((await one('deriv.funding')).params).toMatchObject({ amount: '-7.50', mode: '@paper' });
    expect((await one('deriv.live.liquidation')).severity).toBe('critical');
    expect(await d.conditions()).toBe(0);                            // still true, said once
    expect(await w.dispatcher().conditions()).toBe(0);               // and once across a restart
    w.clock.advance(40 * H);                                         // 20 h left on the mandate
    await d.conditions();
    expect((await w.alerts(`kind = 'mandate.expiring'`)).map((a) => [a.params.hours, a.severity])).toEqual([[72, 'info'], [24, 'warning']]);
  });

  it('signer: unreachable only after the debounce, back once; halt, resume and policy change', async () => {
    await d.conditions();
    w.env.signer = null;
    await d.conditions(); w.clock.advance(30_000); await d.conditions();
    w.env.signer = SIGNER_OK;                                        // a blip shorter than the debounce: nothing
    await d.conditions();
    expect(await kinds()).toEqual([]);
    w.env.signer = null;
    await d.conditions(); w.clock.advance(125_000); await d.conditions(); w.clock.advance(60_000); await d.conditions();
    expect(await kinds()).toEqual(['security.signer_unreachable']);
    expect((await one('security.signer_unreachable'))).toMatchObject({ severity: 'critical', params: { minutes: 2 } });
    w.env.signer = SIGNER_OK;
    await d.conditions(); await d.conditions();
    expect(await kinds()).toEqual(['security.signer_back', 'security.signer_unreachable']);
    w.env.signer = { ...SIGNER_OK, halted: true };
    await d.conditions(); await d.conditions();
    w.env.signer = { ...SIGNER_OK, halted: false, policy: { ...SIGNER_OK.policy, version: 4 } as never };
    await d.conditions(); await w.dispatcher().conditions();
    expect(await kinds()).toEqual(['security.policy_changed', 'security.signer_back', 'security.signer_halted', 'security.signer_unhalted', 'security.signer_unreachable']);
    expect((await one('security.policy_changed')).params).toEqual({ what: '@signer', detail: 'version 4' });
  });

  it('NEXT — passkeys: a revocation is said; a divergence between the signer\'s list and the application\'s table is said once it lasts, and once', async () => {
    await w.db.audit('device.revoked', 'owner', { credential: 'abc', label: 'Old phone', signer: true, sessions: 2 });
    await d.tail();
    expect(await one('security.passkey_revoked')).toMatchObject({ severity: 'warning', params: { label: 'Old phone', count: 2 } });
    // the signer lists a passkey the application's table does not hold
    w.env.signer = { ...SIGNER_OK, credentials: [{ id: 'c'.repeat(27), addedAt: '2026-11-19T00:00:00.000Z' }] } as never;
    await d.conditions(); await d.tail();
    expect(await kinds()).toEqual(['security.passkey_revoked']);     // the first look: it may be an addition in progress
    w.clock.advance(31_000); await d.conditions(); await d.tail();
    expect(await one('security.credential_mismatch')).toMatchObject({ severity: 'critical', params: { count: 1 }, source: 'audit' });
    w.clock.advance(120_000); await d.conditions(); await w.dispatcher().conditions(); await d.tail();   // still true, also after a restart: said once
    expect(await w.alerts(`kind = 'security.credential_mismatch'`)).toHaveLength(1);
    w.env.signer = SIGNER_OK;                                        // the two sides agree again: written to the audit chain, no alert
    await d.conditions(); await d.tail();
    expect((await sql`select type from audit_events where type like 'credentials.%' order by seq`).map((r: { type: string }) => r.type)).toEqual(['credentials.mismatch', 'credentials.reconciled']);
    expect(await kinds()).toEqual(['security.credential_mismatch', 'security.passkey_revoked']);
  });

  it('a flapping feed says nothing; a real outage says down once and back once', async () => {
    const h = (readable: boolean) => [{ network: 'base', ok: readable, readable, identityVerified: true, height: 1, endpoints: [{ url: 'u', ok: readable, ms: 10 }], checkedAt: new Date(w.clock.t).toISOString() }];
    for (let i = 0; i < 12; i++) { w.env.rpc = h(i % 2 === 0); await d.conditions(); w.clock.advance(20_000); }   // down, up, down, up… every 20 s
    expect(await kinds()).toEqual([]);
    w.env.rpc = h(false); await d.conditions();
    for (let i = 0; i < 12; i++) { w.clock.advance(20_000); w.env.rpc = h(false); await d.conditions(); }
    expect(await kinds()).toEqual(['conn.down']);
    expect((await one('conn.down'))).toMatchObject({ params: { name: 'Base', minutes: 3 }, subject: { type: 'network', network: 'base' } });
    w.env.rpc = h(true); await d.conditions(); await d.conditions();
    expect(await kinds()).toEqual(['conn.down', 'conn.up']);
  });

  it('backup older than 36 h, low disk, a loop failing repeatedly, a broken audit chain', async () => {
    const now = w.clock.t;
    w.env.backup = { dir: '/x', lastAt: now - 20 * 3_600_000, files: 3 }; w.env.disk = { path: '/', freePct: 42, freeGb: 100, totalGb: 240 };
    w.env.loops = [{ name: 'reconcile', everyMs: 8000, runs: 9, lastStartAt: now, lastOkAt: now, lastErrorAt: null, lastError: null, failures: 0 }];
    await d.conditions();
    expect(await kinds()).toEqual([]);
    w.env.backup = { dir: '/x', lastAt: now - 40 * 3_600_000, files: 3 }; w.env.disk = { path: '/', freePct: 4.2, freeGb: 10, totalGb: 240 };
    w.env.loops = [{ name: 'reconcile', everyMs: 8000, runs: 9, lastStartAt: now, lastOkAt: null, lastErrorAt: now, lastError: 'connection refused', failures: 6 }];
    await d.conditions(); await d.conditions();
    expect(await kinds()).toEqual(['system.backup_missing', 'system.disk_low', 'system.worker_failing']);
    expect((await one('system.backup_missing')).params).toEqual({ hours: 40 });
    expect((await one('system.worker_failing')).params).toEqual({ loop: 'reconcile', count: 6, reason: 'connection refused' });
    w.env.backup = null;                                             // the API cannot see a backup directory: the rule is skipped, not guessed
    const health = await import('../src/monitor/health.ts');
    await sql`alter table audit_events disable trigger audit_no_update`;
    const [row] = await sql`select seq from audit_events order by seq desc offset 2 limit 1`;
    await sql`update audit_events set data = '{"tampered":true}' where seq = ${row.seq}`;
    await sql`alter table audit_events enable trigger audit_no_update`;
    health.resetHealthCaches();
    await d.conditions(); await d.conditions();
    const broken = await one('security.audit_broken');
    expect(broken).toMatchObject({ severity: 'critical', params: { seq: Number(row.seq) } });
  });
});

describe('delivery', () => {
  const sub = generateSubscriptionKeys();
  const subscribe = () => sql`insert into push_subscriptions (id, endpoint, p256dh, auth, label, locale) values (${randomUUID()}, 'https://fcm.googleapis.com/fcm/send/abc', ${sub.p256dh}, ${sub.auth}, 'iPhone', 'fr')`;
  const pushes = () => calls.filter((c) => c.url.startsWith('https://fcm.')).map((c) => JSON.parse(decryptPush(c.body, sub).toString()));

  it('with zero subscriptions and no webhook everything still works: alerts stay in the app', async () => {
    await d.raise({ kind: 'deposit.received', params: { network: 'Base', symbol: 'ETH', amount: '1' } });
    expect(await d.deliver()).toEqual({ sent: 0, quiet: 0, capped: 0 });
    expect((await one('deposit.received')).delivery).toBe('inapp');
    expect(calls).toHaveLength(0);
  });

  it('a push carries a kind and parameters, hides amounts by default, and is sent once', async () => {
    await subscribe();
    await d.raise({ kind: 'transfer.confirmed', params: { network: 'Base', symbol: 'USDC', amount: '25' }, subject: { type: 'proposal', id: 'p1' } });
    expect(await d.deliver()).toMatchObject({ sent: 1 });
    expect(await d.deliver()).toMatchObject({ sent: 0 });            // claimed: never sent twice
    const [p] = pushes();
    expect(p).toMatchObject({ v: 1, kind: 'transfer.confirmed', sev: 'info', l: 'fr', d: false, p: { network: 'Base', count: 1 }, s: { type: 'proposal', id: 'p1' } });
    expect(JSON.stringify((p as { p: unknown }).p)).not.toMatch(/25|USDC/); // the parameters only: the timestamp may contain "25"
    expect(calls[0]!.headers.get('urgency')).toBe('normal');
    expect((await one('transfer.confirmed'))).toMatchObject({ delivery: 'sent', channels: { push: { sent: 1, failed: 0, removed: 0 } } });
    await settings({ showDetails: true });
    await d.raise({ kind: 'transfer.confirmed', params: { network: 'Base', symbol: 'USDC', amount: '25' } });
    await d.deliver();
    expect(pushes()[1]).toMatchObject({ d: true, p: { amount: '25', symbol: 'USDC' } });
  });

  it('quiet hours hold back non-critical alerts only', async () => {
    await subscribe();
    const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);
    await settings({ quiet: { enabled: true, start: hhmm(w.clock.t - 3_600_000), end: hhmm(w.clock.t + 3_600_000), tz: 'UTC' } });
    await d.raise({ kind: 'deposit.received', params: { network: 'Base' } });
    await d.raise({ kind: 'security.passkey_added', params: { label: 'k' } });
    expect(await d.deliver()).toEqual({ sent: 1, quiet: 1, capped: 0 });
    expect(pushes().map((p) => p.kind)).toEqual(['security.passkey_added']);
    expect(calls[0]!.headers.get('urgency')).toBe('high');
    expect((await one('deposit.received')).delivery).toBe('quiet');   // in the app, not on the phone
    await d.deliver();
    expect(pushes()).toHaveLength(1);                                // not sent later either
  });

  it('quiet hours follow the owner’s time zone and may cross midnight', () => {
    const q = { enabled: true, start: '22:00', end: '07:00', tz: 'America/Toronto' };
    expect(w.mod.inQuietHours(Date.parse('2026-11-11T04:30:00Z'), q)).toBe(true);    // 23:30 in Toronto
    expect(w.mod.inQuietHours(Date.parse('2026-11-11T11:59:00Z'), q)).toBe(true);    // 06:59
    expect(w.mod.inQuietHours(Date.parse('2026-11-11T12:00:00Z'), q)).toBe(false);   // 07:00
    expect(w.mod.inQuietHours(Date.parse('2026-11-11T20:00:00Z'), q)).toBe(false);   // 15:00
    expect(w.mod.inQuietHours(Date.parse('2026-07-11T02:30:00Z'), q)).toBe(true);    // 22:30 in summer (UTC−4)
    expect(w.mod.inQuietHours(Date.parse('2026-11-11T04:30:00Z'), { ...q, enabled: false })).toBe(false);
    expect(w.mod.inQuietHours(Date.parse('2026-11-11T15:00:00Z'), { ...q, start: '09:00', end: '17:00' })).toBe(true);
  });

  it('a storm is capped per hour: criticals always pass, the rest is summarized ONCE', async () => {
    await subscribe();
    await settings({ capPerHour: 3 });
    w.clock.t = Math.floor(w.clock.t / 3_600_000) * 3_600_000 + 60_000;   // one minute into an hour
    for (let i = 0; i < 10; i++) await d.raise({ kind: 'conn.down', params: { name: `feed ${i}`, minutes: 3 } });
    await d.raise({ kind: 'security.audit_broken', params: { seq: 7 } });
    expect(await d.deliver()).toEqual({ sent: 4, quiet: 0, capped: 7 });
    expect(pushes().map((p) => p.kind)).toEqual(['conn.down', 'conn.down', 'conn.down', 'security.audit_broken']);
    w.clock.advance(20 * 60_000);
    for (let i = 0; i < 5; i++) await d.raise({ kind: 'conn.up', params: { name: `feed ${i}` } });
    expect(await d.deliver()).toEqual({ sent: 0, quiet: 0, capped: 5 });
    expect(await kinds(`kind = 'system.alerts_capped'`)).toEqual([]);
    w.clock.advance(45 * 60_000);                                    // the next hour
    expect(await d.deliver()).toEqual({ sent: 1, quiet: 0, capped: 0 });
    expect((await one('system.alerts_capped'))).toMatchObject({ params: { count: 12 }, delivery: 'sent' });
    expect(pushes().at(-1)).toMatchObject({ kind: 'system.alerts_capped', p: { count: 12 } });
    await d.deliver(); w.clock.advance(3_600_000); await d.deliver();
    expect(await kinds(`kind = 'system.alerts_capped'`)).toHaveLength(1);
    expect(await w.alerts()).toHaveLength(17);                        // every alert is in the app
  });

  it('subscriptions the push service no longer knows are removed; other failures are counted and kept', async () => {
    await subscribe();
    pushStatus = 500;
    await d.raise({ kind: 'security.passkey_added', params: { label: 'a' } }); await d.deliver();
    expect((await sql`select failures, last_error from push_subscriptions`)[0]).toMatchObject({ failures: 1, last_error: 'push service answered 500' });
    pushStatus = 201;
    await d.raise({ kind: 'security.passkey_added', params: { label: 'b' } }); await d.deliver();
    expect((await sql`select failures, last_error, last_ok_at from push_subscriptions`)[0]).toMatchObject({ failures: 0, last_error: null });
    pushStatus = 410;
    await d.raise({ kind: 'security.passkey_added', params: { label: 'c' } }); await d.deliver();
    expect(await sql`select 1 from push_subscriptions`).toHaveLength(0);
    expect((await w.alerts()).at(-1).channels).toEqual({ push: { sent: 0, failed: 0, removed: 1 } });
  });

  it('webhook: off by default; when on, an HMAC-signed body without amounts unless the owner asked for details', async () => {
    const { rotateWebhookSecret } = await import('../src/alerts/secrets.ts');
    await d.raise({ kind: 'transfer.confirmed', params: { network: 'Base', symbol: 'USDC', amount: '25' } }); await d.deliver();
    expect(calls).toHaveLength(0);
    const secret = rotateWebhookSecret();
    await settings({ webhook: { enabled: true, url: 'https://hooks.example/spw', details: false } });
    await d.raise({ kind: 'transfer.confirmed', params: { network: 'Base', symbol: 'USDC', amount: '25' } }); await d.deliver();
    expect(calls).toHaveLength(1);
    const c = calls[0]!, body = c.body.toString();
    expect(c.url).toBe('https://hooks.example/spw');
    expect(verifyWebhook(secret, c.headers.get('x-spw-timestamp')!, c.headers.get('x-spw-signature')!, body, w.clock.t)).toBe(true);
    expect(verifyWebhook(secret, c.headers.get('x-spw-timestamp')!, c.headers.get('x-spw-signature')!, body.replace('Base', 'Bass'), w.clock.t)).toBe(false);
    expect(verifyWebhook('another-secret', c.headers.get('x-spw-timestamp')!, c.headers.get('x-spw-signature')!, body, w.clock.t)).toBe(false);
    expect(verifyWebhook(secret, c.headers.get('x-spw-timestamp')!, c.headers.get('x-spw-signature')!, body, w.clock.t + 10 * 60_000)).toBe(false);   // replayed later
    expect(JSON.parse(body)).toMatchObject({ app: 'sp-wallet', kind: 'transfer.confirmed', severity: 'info', title: 'Transfer confirmed', body: 'On Base.', params: { network: 'Base' } });
    // v8: the amount and the symbol are looked for in the fields that could carry them — over the whole body, "25" also
    // matched digits of the timestamp and of the alert id (same family as the push test above)
    { const j = JSON.parse(body) as { title: string; body: string; params: unknown }; expect(JSON.stringify([j.title, j.body, j.params])).not.toMatch(/25|USDC|0x/); expect(Object.keys(j.params as object)).toEqual(['network']); }
    await settings({ webhook: { enabled: true, url: 'https://hooks.example/spw', details: true } });
    await d.raise({ kind: 'transfer.confirmed', params: { network: 'Base', symbol: 'USDC', amount: '25' } }); await d.deliver();
    expect(JSON.parse(calls[1]!.body.toString())).toMatchObject({ body: '25 USDC sent on Base.', params: { amount: '25' } });
    expect((await w.alerts()).at(-1).channels).toEqual({ webhook: { ok: true, status: 201 } });
  });
});
