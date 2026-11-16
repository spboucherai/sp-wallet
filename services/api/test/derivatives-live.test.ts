// Controlled live trading, end to end inside the process: the REAL execution engine and its routes, the REAL isolated signer
// class (in process, public test mnemonic, real WebAuthn assertions from a software passkey), PostgreSQL (database
// spw_deriv_live_test, created here if missing) and a scripted fake of the Hyperliquid exchange + info endpoints that recovers
// signers from signatures like the venue does. No network: a request to any real host fails the test.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hlPinnedAssets, hlPinnedMismatch, jurisdictionAck, venueAuthorizationHash, type VenueAuthorization } from '@spw/derivatives/live';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { Signer, SignerError } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';
import { Clock, passkeyVerifier, useDatabase } from './derivatives-helpers.ts';
import { FakeHl, routeFetch } from './hl-fake.ts';

const RP = 'wallet.test', ORIGIN = 'https://wallet.test', BTC = 'hyperliquid:BTC', P = '/api/v1/derivatives/live';
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const ACCOUNT = keys.addresses.evm.toLowerCase(), AGENT = keys.venueKey('hyperliquid', 'testnet').address;
const b64 = (hexHash: string) => Buffer.from(hexHash, 'hex');
const POLICY = { allowedInstruments: [BTC], maxLeverage: 3, maxOrderNotional: '500', maxPositionNotional: '1000', maxGrossExposure: '1500', maxOrdersPerDay: 50, maxPriceDeviationBps: 300 };

let sql: any, lv: typeof import('../src/derivatives/live.ts'), ex: typeof import('../src/derivatives/exec.ts'), pp: typeof import('../src/derivatives/paper.ts'), UserError: typeof import('../src/config.ts').UserError;
type Svc = import('../src/derivatives/exec.ts').LiveService;

beforeAll(async () => {
  await useDatabase('deriv_live');
  const db = await import('../src/db.ts');
  sql = db.sql;
  await db.migrate();
  await db.migrate(); // the schema is idempotent
  lv = await import('../src/derivatives/live.ts'); ex = await import('../src/derivatives/exec.ts'); pp = await import('../src/derivatives/paper.ts');
  UserError = (await import('../src/config.ts')).UserError;
});
beforeEach(async () => { await sql`truncate deriv_accounts, deriv_orders, deriv_fills, deriv_funding, deriv_risk_events, deriv_equity, deriv_actions`; });
afterAll(async () => { await sql?.end(); });

let seq = 0;
const key = () => `live-key-${++seq}-${Math.random().toString(36).slice(2, 10)}`;

function world() {
  const clock = new Clock(Date.parse('2026-11-11T12:00:00Z'));
  const t = new FakeHl('testnet', clock.now), m = new FakeHl('mainnet', clock.now);
  const dir = mkdtempSync(join(tmpdir(), 'spw-live-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
  const px: { BTC: number; fail: string } = { BTC: 70_000, fail: '' };
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => Math.floor(clock.now() / 1000), { get: async (s) => { if (px.fail) throw new Error(px.fail); return Object.fromEntries(s.map((k) => [k, (px as unknown as Record<string, number>)[k]!])); } });
  const pk = new TestPasskey(RP, ORIGIN);
  // what services/api/src/signer-client.ts does over HTTP: a signer refusal becomes a 422 `signer_<code>`
  const call = async <T>(fn: () => T | Promise<T>): Promise<T> => { try { return await fn(); } catch (e) { if (e instanceof SignerError) throw new UserError(`signer_${e.code}`, e.message, 422); throw e; } };
  const signs: unknown[] = [];
  /** V11: `lost` = the signer does its work and stores it, but its answer never reaches the API (timeout, relay drop) */
  const fault: { authorize: null | 'lost' } = { authorize: null };
  const port: import('../src/derivatives/exec.ts').LiveSignerPort = {
    status: () => call(() => signer.status()), venueKey: (v, n) => call(() => signer.venueKey(v, n)),
    venueAuthorize: async (a, s) => { const r = await call(() => signer.venueAuthorize(a, s as never)); if (fault.authorize === 'lost') { fault.authorize = null; throw new UserError('signer_unreachable', 'the signer is unreachable; nothing was signed', 503); } return r; },
    venueAuthorization: (id) => call(() => signer.venueAuthorization(id)),
    venueRevoke: (id) => call(() => signer.venueRevoke(id)),
    venueSign: (p) => { signs.push(p); return call(() => signer.venueSign(p as never)); },
  };
  const flags = { mainnet: false };
  const build = (): Svc => lv.createLive({ fetch: routeFetch([t, m]), signer: port, now: clock.now, rpId: RP, mainnetEnabled: () => flags.mainnet, credentials: async () => [{ id: pk.id, transports: ['internal'] }], confirmDelayMs: 0,
    verifyOwner: passkeyVerifier(pk, RP, ORIGIN) });
  const w = { clock, t, m, signer, store, pk, px, port, flags, signs, fault, svc: build(), restart: () => { w.svc = build(); return w.svc; },
    /** a minute later (the adapter's local rate budget is a one-minute window on the test clock) */
    next: (ms = 61_000) => clock.advance(ms) };
  return w;
}
type World = ReturnType<typeof world>;
const refusal = async (p: Promise<unknown>) => { const e = await p.then(() => null, (x) => x); return e ? { code: e.code as string, status: e.status as number, message: e.message as string } : null; };
const audits = async (id: string) => (await sql`select type from audit_events where data->>'account' = ${id} order by seq`).map((r: { type: string }) => r.type) as string[];
const events = async (id: string, kind?: string) => (kind ? sql`select * from deriv_risk_events where account_id = ${id} and kind = ${kind} order by id` : sql`select * from deriv_risk_events where account_id = ${id} order by id`) as Promise<any[]>;
const row = async (id: string, k: string) => (await sql`select * from deriv_orders where account_id = ${id} and client_id = ${k}`)[0];

/** an account on a network, enrolled passkey, funded on the fake venue, authorized with the passkey */
async function account(w: World, o: { network?: 'testnet' | 'mainnet'; fund?: string | null; policy?: Record<string, unknown> } = {}) {
  if (w.signer.status().credentials.length === 0) await w.signer.enroll({ credential: w.pk.credential(), setupToken: 'tok' });
  const network = o.network ?? 'testnet', fake = network === 'testnet' ? w.t : w.m;
  if (o.fund !== null) fake.fund(ACCOUNT, o.fund ?? '1000');
  const a = await w.svc.createAccount({ venue: 'hyperliquid', network, label: 'test' });
  return a.id as string;
}
async function authorize(w: World, id: string, policy: Record<string, unknown> = {}) {
  const prep = await w.svc.prepareAuthorization(id, ex.AuthorizationBodySchema.parse({ policy: { ...POLICY, ...policy }, days: 30, locale: 'fr' }));
  const done = await w.svc.approveAuthorization(id, { assertion: w.pk.assert(b64(prep.hash)) as never, acknowledged: true });
  return { prep, done };
}
async function live(w: World, o: Parameters<typeof account>[1] = {}) { const id = await account(w, o); await authorize(w, id, o.policy); return id; }
const body = (o: Record<string, unknown>) => pp.OrderBodySchema.parse({ instrument: BTC, ...o });
const LIMIT = { side: 'buy', type: 'limit', size: '0.002', price: '69500' };
const MARKET = { side: 'buy', type: 'market', size: '0.002', slippageBps: 50, tif: 'ioc' };
async function place(w: World, id: string, o: Record<string, unknown> = LIMIT, k = key()) {
  const p = await w.svc.propose(id, body(o), k);
  const r = await w.svc.approveOrder(id, k, w.pk.assert(b64(p.hash!)) as never);
  return { k, p, order: r.order };
}

/** V11: lifting the owner's halt and re-basing need the passkey over the prepared intent */
async function resume(w: World, id: string) { const p = await w.svc.prepareRisk(id, 'resume'); return w.svc.resume(id, p.needed ? w.pk.assert(b64(p.hash)) : undefined); }
async function rebase(w: World, id: string) { const p = await w.svc.prepareRisk(id, 'rebase'); return w.svc.rebase(id, w.pk.assert(b64(p.hash!))); }

describe('pinned asset table and canonical commitments', () => {
  it('the pinned table matches the recorded venue meta of both networks, and a renumbered venue is detected', async () => {
    const w = world();
    for (const net of ['mainnet', 'testnet'] as const) {
      const liveTable = await w.svc.deps.venues.get(net).adapter.assets();
      expect(hlPinnedMismatch(net, liveTable)).toBeNull();
      for (const p of hlPinnedAssets(net)) expect(liveTable.find((a) => a.symbol === p.symbol)).toMatchObject({ asset: p.asset, szDecimals: p.szDecimals, maxLeverage: p.maxLeverage });
      const moved = liveTable.map((a) => (a.symbol === 'BTC' ? { ...a, asset: 999 } : a));
      expect(hlPinnedMismatch(net, moved)).toMatch(/BTC moved from index/);
      expect(hlPinnedMismatch(net, liveTable.map((a) => (a.symbol === 'ETH' ? { ...a, szDecimals: 3 } : a)))).toMatch(/ETH: lot decimals changed/);
      expect(hlPinnedMismatch(net, liveTable.filter((a) => a.symbol !== 'SOL'))).toMatch(/SOL is no longer/);
    }
  });
});

describe('a venue account starts READ_ONLY and nothing trades', () => {
  it('account creation derives the addresses on the signer; orders, leverage and cancel-all are refused; the venue\'s trading endpoint is never called', async () => {
    const w = world(), id = await account(w);
    const a = await w.svc.get(id);
    expect(a).toMatchObject({ mode: 'READ_ONLY', kind: 'venue', network: 'testnet', account: ACCOUNT, agentAddress: AGENT, authorization: null, tradable: false });
    expect(a.agentAddress).not.toBe(a.account);
    expect(a.venueState).toMatchObject({ source: 'venue', error: null, state: { equity: '1000', withdrawable: '1000' }, positions: [], openOrders: [] });
    expect((await w.svc.createAccount({ venue: 'hyperliquid', network: 'testnet', label: 'again' })).id).toBe(id);      // one account per venue and network
    expect(await refusal(w.svc.propose(id, body(LIMIT), key()))).toMatchObject({ code: 'mode_read_only', status: 422 });
    expect(await refusal(w.svc.preview(id, body(LIMIT)))).toMatchObject({ code: 'mode_read_only' });
    expect(await refusal(w.svc.proposeLeverage(id, { instrument: BTC, leverage: 2, marginMode: 'cross' }))).toMatchObject({ code: 'mode_read_only' });
    expect(await refusal(w.svc.cancelAll(id))).toMatchObject({ code: 'mode_read_only' });
    expect(await refusal(w.svc.close(id, { instrument: BTC, fraction: '1' }))).toMatchObject({ code: 'mode_read_only' });
    expect(w.t.exchangeCalls()).toBe(0);
    expect(w.signs).toHaveLength(0);
    expect((await w.svc.collateral(id))).toMatchObject({ withdrawable: '1000', asset: 'USDC', source: 'venue', deposits: { supported: false }, withdrawals: { supported: true } });   // testnet: no deposit route; withdrawals are built (v6, collateral.ts)
    expect(await w.svc.active()).toEqual([]);                                                                            // the worker has nothing to do
  });
});

describe('authorization: passkey, jurisdiction acknowledgement, the venue\'s own confirmation', () => {
  it('prepare shows the acknowledgement and commits to its hash; approve registers the trading key and records the acknowledgement', async () => {
    const w = world(), id = await account(w);
    const prep = await w.svc.prepareAuthorization(id, ex.AuthorizationBodySchema.parse({ policy: POLICY, days: 30, locale: 'fr' }));
    const ack = jurisdictionAck('hyperliquid', 'fr');
    expect(prep.acknowledgement).toEqual(ack);
    expect(prep.acknowledgement.text).toContain('pas un avis juridique');
    expect(prep.acknowledgement.text).not.toMatch(/est (légal|autorisé|permis)/i);
    expect(jurisdictionAck('hyperliquid', 'en').text).toContain('It is not a legal clearance');
    const auth = prep.authorization as VenueAuthorization;
    expect(auth).toMatchObject({ venue: 'hyperliquid', network: 'testnet', account: ACCOUNT, agentAddress: AGENT, mode: 'MANUAL_LIVE', ackSha256: ack.sha256, policy: POLICY });
    expect(auth.expiresAt - auth.createdAt).toBe(30 * 86400);
    expect(prep.hash).toBe(Buffer.from(venueAuthorizationHash(auth)).toString('hex'));
    expect(prep.options.challenge).toBe(b64(prep.hash).toString('base64url'));                                           // the passkey signs the authorization hash
    expect(prep.options.allowCredentials).toEqual([{ id: w.pk.id, type: 'public-key', transports: ['internal'] }]);
    expect(ex.ApproveAuthorizationSchema.safeParse({ assertion: {}, acknowledged: false }).success).toBe(false);          // the confirmation is not optional
    expect((await w.svc.get(id)).mode).toBe('READ_ONLY');

    const done = await w.svc.approveAuthorization(id, { assertion: w.pk.assert(b64(prep.hash)) as never, acknowledged: true });
    expect(done).toMatchObject({ mode: 'MANUAL_LIVE', tradable: true, authorization: { id: auth.authorizationId, hash: prep.hash, active: true, ackSha256: ack.sha256, policy: POLICY } });
    expect(done.policy).toMatchObject({ mode: 'MANUAL_LIVE', allowedInstruments: [BTC], maxLeverage: '3', maxOrderNotional: '500', maxGrossExposure: '1500', maxOrdersPerDay: 50 });
    // the venue itself lists the trading key as an API wallet of the account, with the authorization's expiry
    expect(w.t.user(ACCOUNT).agents.get(AGENT)).toEqual({ name: 'spw-live', validUntil: auth.expiresAt * 1000 });
    expect(w.t.exchangeCalls()).toBe(1); expect(w.t.exchangeCalls('approveAgent')).toBe(1);
    expect(await audits(id)).toEqual(['deriv.live.account_created', 'deriv.live.acknowledged', 'deriv.live.authorized']);
    const [acked] = await sql`select data from audit_events where type = 'deriv.live.acknowledged' and data->>'account' = ${id}`;
    expect(acked.data).toMatchObject({ ackSha256: ack.sha256, locale: 'fr', version: ack.version, authorizationId: auth.authorizationId });
    expect(await refusal(w.svc.approveAuthorization(id, { assertion: w.pk.assert(b64(prep.hash)) as never, acknowledged: true }))).toMatchObject({ code: 'bad_state' });
    expect(await refusal(w.svc.prepareAuthorization(id, ex.AuthorizationBodySchema.parse({ policy: POLICY, days: 30, locale: 'en' })))).toMatchObject({ code: 'bad_state', status: 409 });
  });

  it('a wrong passkey changes nothing; an unfunded account stops at the venue\'s documented refusal and the signer authorization is revoked', async () => {
    const w = world(), id = await account(w, { fund: null });
    const prep = await w.svc.prepareAuthorization(id, ex.AuthorizationBodySchema.parse({ policy: POLICY, days: 30, locale: 'en' }));
    expect(await refusal(w.svc.approveAuthorization(id, { assertion: new TestPasskey(RP, ORIGIN).assert(b64(prep.hash)) as never, acknowledged: true }))).toMatchObject({ code: 'signer_unknown_credential', status: 422 });
    expect(w.signer.status().venues).toHaveLength(0);
    expect(w.t.exchangeCalls()).toBe(0);
    const again = await w.svc.prepareAuthorization(id, ex.AuthorizationBodySchema.parse({ policy: POLICY, days: 30, locale: 'en' }));
    const r = await refusal(w.svc.approveAuthorization(id, { assertion: w.pk.assert(b64(again.hash)) as never, acknowledged: true }));
    expect(r).toMatchObject({ code: 'venue_rejected', status: 422 });
    expect(r!.message).toContain(`Must deposit before performing actions. User: ${ACCOUNT}`);
    expect(w.signer.status().venues[0]).toMatchObject({ revoked: true });                                                  // nothing dangles on the signer
    expect((await w.svc.get(id))).toMatchObject({ mode: 'READ_ONLY', authorization: null });
    // the acknowledgement is recorded once the signer has verified the passkey over it — not for the failed attempt
    expect(await audits(id)).toEqual(['deriv.live.account_created', 'deriv.live.acknowledged', 'deriv.live.authorization_failed']);
    // limits the signer would refuse are refused before the passkey prompt
    expect(await refusal(w.svc.prepareAuthorization(id, ex.AuthorizationBodySchema.parse({ policy: { ...POLICY, allowedInstruments: ['hyperliquid:DOGE'] }, days: 30, locale: 'en' })))).toMatchObject({ code: 'bad_policy' });
    expect(await refusal(w.svc.prepareAuthorization(id, ex.AuthorizationBodySchema.parse({ policy: { ...POLICY, maxOrderNotional: '5000' }, days: 30, locale: 'en' })))).toMatchObject({ code: 'bad_policy' });
    expect(ex.AuthorizationBodySchema.safeParse({ policy: POLICY, days: 91, locale: 'en' }).success).toBe(false);
  });

  it('the API-side policy can be tightened, never widened past the authorization', async () => {
    const w = world(), id = await live(w);
    const p = (await w.svc.get(id)).policy;
    expect((await w.svc.setPolicy(id, { ...p, maxOrderNotional: '100', maxOrdersPerDay: 5 })).policy).toMatchObject({ maxOrderNotional: '100', maxOrdersPerDay: 5 });
    for (const wider of [{ maxOrderNotional: '501' }, { maxLeverage: '4' }, { maxGrossExposure: '1500.01' }, { allowedInstruments: [BTC, 'hyperliquid:ETH'] }, { maxOrdersPerDay: 51 }, { mode: 'MANDATE_LIVE' }, { halt: 'x' }])
      expect(await refusal(w.svc.setPolicy(id, { ...p, ...wider } as never)), JSON.stringify(wider)).toMatchObject({ code: 'bad_policy', status: 400 });
  });
});

describe('order: proposal → passkey → signer → venue → reconciliation', () => {
  it('a resting limit order: every state is persisted, the challenge is the order hash, the venue confirms it open, a cancel needs no passkey', async () => {
    const w = world(), id = await live(w), k = key();
    const preview = await w.svc.preview(id, body(LIMIT));
    expect(preview).toMatchObject({ risk: { ok: true }, estimate: { notional: '139', initialMargin: '6.95', leverage: '20', source: 'estimate' }, venueState: { source: 'venue' } });
    expect(await sql`select count(*)::int as n from deriv_orders`).toEqual([{ n: 0 }]);                                  // a preview stores nothing

    const p = await w.svc.propose(id, body(LIMIT), k);
    expect(p).toMatchObject({ idempotent: false, order: { clientId: k, state: 'risk_checked', final: false, source: 'local', instrument: BTC, side: 'buy', size: '0.002', price: '69500' } });
    expect(p.canonical).toMatchObject({ kind: 'order', network: 'testnet', account: ACCOUNT, instrument: BTC, side: 'buy', type: 'limit', size: '0.002', price: '69500', triggerPrice: null, reduceOnly: false, tif: 'gtc' });
    expect(p.canonical!.clientId).toMatch(/^0x[0-9a-f]{32}$/);
    expect(p.canonical!.expiresAt - p.canonical!.nonce).toBe(90_000);                                                     // ≤ 2 minutes
    expect(p.options!.challenge).toBe(b64(p.hash!).toString('base64url'));
    expect(w.t.exchangeCalls('order')).toBe(0); expect(w.signs).toHaveLength(0);                                          // nothing signed, nothing sent before the passkey

    const r = await w.svc.approveOrder(id, k, w.pk.assert(b64(p.hash!)) as never);
    expect(r.order).toMatchObject({ state: 'open', final: false, source: 'venue', filled: '0' });
    expect(r.order.venueOrderId).toMatch(/^\d+$/);
    const resting = w.t.openOrders(ACCOUNT);
    expect(resting).toHaveLength(1);
    expect(resting[0]).toMatchObject({ coin: 'BTC', side: 'B', limitPx: '69500', origSz: '0.002', cloid: p.canonical!.clientId, tif: 'Gtc' });
    // what was sent carried the venue expiry the owner approved, and the trading key signed it (the fake recovered an approved API wallet)
    const sent = w.t.calls.find((c) => c.type === 'order')!.body;
    expect(sent).toMatchObject({ nonce: p.canonical!.nonce, expiresAfter: p.canonical!.expiresAt, vaultAddress: null });
    expect(await audits(id)).toEqual(expect.arrayContaining(['deriv.live.order_proposed', 'deriv.live.order_submitted', 'deriv.live.order_open']));

    w.next();
    const c = await w.svc.cancelOrder(id, k);
    expect(c).toMatchObject({ sent: true, venue: { outcome: 'accepted' }, order: { state: 'cancelled', final: true, source: 'venue' } });
    expect(w.t.openOrders(ACCOUNT)).toHaveLength(0);
    expect(w.signs.map((s: any) => !!s.assertion)).toEqual([true, false]);                                                // order: passkey; cancel: none
    expect((await w.svc.cancelOrder(id, k))).toMatchObject({ sent: false, order: { state: 'cancelled' } });               // already final: nothing is sent again
    expect(w.t.exchangeCalls('cancelByCloid')).toBe(1);
  });

  it('a market order fills: fills, average price and position come from the venue; a partial fill is said to be partial', async () => {
    const w = world(), id = await live(w);
    const a = await place(w, id, MARKET);
    expect(a.p.canonical).toMatchObject({ type: 'limit', tif: 'ioc', price: '70355' });                                   // a market order is an IOC limit at its worst price
    expect(a.order).toMatchObject({ state: 'filled', final: true, filled: '0.002', avgFillPrice: '70005', source: 'venue' });
    const d = await w.svc.get(id);
    expect(d.fills).toHaveLength(1);
    expect(d.fills[0]).toMatchObject({ instrument: BTC, side: 'buy', price: '70005', size: '0.002', clientId: a.p.canonical!.clientId, source: 'venue' });
    expect(d.venueState.positions).toEqual([expect.objectContaining({ instrument: BTC, side: 'long', size: '0.002', entryPrice: '70005', source: 'venue' })]);

    w.next();
    w.t.asks = [['70005', '0.001']];                                                                                      // only half of the size is on offer
    const b = await place(w, id, { ...MARKET, size: '0.003' });
    expect(b.order).toMatchObject({ state: 'partially_filled', final: true, filled: '0.001', avgFillPrice: '70005' });
    expect(b.order.reason).toMatch(/remainder not filled/);
    w.next();
    const s = await w.svc.reconcile(id);
    expect(s.divergence).toBeNull();                                                                                      // 0.003 long = what the wallet's own fills explain
    expect((await w.svc.get(id)).venueState.positions[0]).toMatchObject({ size: '0.003' });
    expect((await sql`select count(*)::int as n from deriv_equity where account_id = ${id}`)[0].n).toBeGreaterThan(0);
  });

  it('a venue refusal is final and carries the venue\'s words; a risk refusal never reaches the signer', async () => {
    const w = world(), id = await live(w);
    const post = await place(w, id, { side: 'buy', type: 'limit', size: '0.002', price: '70010', tif: 'alo' });
    expect(post.order).toMatchObject({ state: 'rejected', final: true, filled: '0' });
    expect(post.order.reason).toContain('Post only order would have immediately matched');
    expect((await row(id, post.k)).venue_answer).toMatchObject({ status: 'ok', response: { type: 'order' } });         // the venue's own answer is kept
    expect(w.t.openOrders(ACCOUNT)).toHaveLength(0);
    w.next();
    const none = await place(w, id, { side: 'buy', type: 'market', size: '0.002', price: '70000', tif: 'ioc' });           // worst price below the best ask: nothing can match
    expect(none.order.state).toBe('rejected');
    expect(none.order.reason).toContain('could not immediately match');

    w.next();
    const before = w.signs.length, k = key();
    expect(await refusal(w.svc.propose(id, body({ ...LIMIT, size: '0.01' }), k))).toMatchObject({ code: 'order_notional_exceeded', status: 422 });   // 700 > 500
    expect(await refusal(w.svc.propose(id, body({ ...LIMIT, price: '60000' }), key()))).toMatchObject({ code: 'price_deviation' });
    expect(await refusal(w.svc.propose(id, body({ ...LIMIT, instrument: 'hyperliquid:ETH', price: w.t.ethMark(), size: '0.1' }), key()))).toMatchObject({ code: 'instrument_not_allowed', status: 422 });
    expect(await refusal(w.svc.propose(id, body({ ...LIMIT, price: '69500.5' }), key()))).toMatchObject({ code: 'price_not_on_tick' });
    expect(await refusal(w.svc.propose(id, body({ ...LIMIT, size: '0.0001' }), key()))).toMatchObject({ code: 'below_min_notional' });
    expect(await refusal(w.svc.propose(id, body({ ...LIMIT, leverage: '5' }), key()))).toMatchObject({ code: 'bad_request', status: 400 });
    expect(w.signs.length).toBe(before);
    expect(await row(id, k)).toMatchObject({ state: 'rejected', final: true, signature: null });
    expect((await events(id, 'order_refused')).map((e) => e.code)).toEqual(expect.arrayContaining(['order_notional_exceeded', 'price_deviation', 'price_not_on_tick', 'below_min_notional']));
    expect(await refusal(w.svc.approveOrder(id, 'no-such-order-key', {} as never))).toMatchObject({ code: 'unknown_order', status: 404 });
  });

  it('the signer has the last word: its own price, the passkey, a tampered action — a refused order is never sent', async () => {
    const w = world(), id = await live(w);
    // (a) the signer's own exchange price is far from the price the API saw on the venue
    w.px.BTC = 60_000;
    const k1 = key(), p1 = await w.svc.propose(id, body(LIMIT), k1);
    const r1 = await refusal(w.svc.approveOrder(id, k1, w.pk.assert(b64(p1.hash!)) as never));
    expect(r1).toMatchObject({ code: 'signer_price', status: 422 });
    expect(r1!.message).toMatch(/more than 300 bps away from the signer's own BTC price 60000/);
    expect((await row(id, k1))).toMatchObject({ state: 'rejected', final: true, signature: null });
    w.px.BTC = 70_000; w.px.fail = 'price sources disagree on BTC';
    w.next();
    const k2 = key(), p2 = await w.svc.propose(id, body(LIMIT), k2);
    expect(await refusal(w.svc.approveOrder(id, k2, w.pk.assert(b64(p2.hash!)) as never))).toMatchObject({ code: 'signer_no_price' });
    w.px.fail = '';
    // (b) an assertion made for another order, and no assertion at all
    w.next();
    const k3 = key(), p3 = await w.svc.propose(id, body(LIMIT), k3), k4 = key(), p4 = await w.svc.propose(id, body({ ...LIMIT, size: '0.003' }), k4);
    expect(await refusal(w.svc.approveOrder(id, k4, w.pk.assert(b64(p3.hash!)) as never))).toMatchObject({ code: 'signer_bad_approval' });
    void p4;
    // (c) the stored action is changed after the proposal was shown (a compromised API): the signer compares it with what was approved
    w.next();
    const k5 = key(), p5 = await w.svc.propose(id, body(LIMIT), k5), stored = await row(id, k5);
    const big = await w.svc.deps.venues.get('testnet').trading().buildOrder({ instrument: BTC, side: 'buy', type: 'limit', size: '0.005', price: '69500', triggerPrice: null, reduceOnly: false, tif: 'gtc', clientId: k5 },
      { instrument: await w.svc.deps.venues.get('testnet').instrument(BTC), nonce: Number(stored.nonce) });
    await sql`update deriv_orders set action = ${big.action as never}::json, sign_request = ${big.sign as never}::json where account_id = ${id} and client_id = ${k5}`;
    const r5 = await refusal(w.svc.approveOrder(id, k5, w.pk.assert(b64(p5.hash!)) as never));
    expect(r5).toMatchObject({ code: 'signer_mismatch' });
    expect(r5!.message).toMatch(/differ \(size\)/);
    expect(w.t.exchangeCalls('order')).toBe(0);                                                                          // none of the five reached the venue
    expect(w.signer.status().venues[0]!.today.orders).toBe(0);
    await place(w, id, LIMIT, k3);                                                                                        // the untouched proposal is still approvable
    expect(w.t.exchangeCalls('order')).toBe(1);
  });
});

describe('idempotency: a retry can never place a second order', () => {
  it('same Idempotency-Key, double approval, approval after the end: one order on the venue', async () => {
    const w = world(), id = await live(w), k = key();
    const pair = await Promise.all([w.svc.propose(id, body(LIMIT), k), w.svc.propose(id, body(LIMIT), k)]);
    expect(pair.map((x) => x.idempotent).sort()).toEqual([false, true]);
    // exactly one call creates the proposal; which of the two is a matter of timing, and so is what the other one sees: the row
    // is inserted ('proposed') before its hash is computed ('risk_checked'), and the losing call may read it in between. It then
    // has no hash and nothing to approve YET — never another hash. (Asserting `again.hash === p.hash` here failed about every
    // second run of this test alone.)
    const p = pair.find((x) => !x.idempotent)!, again = pair.find((x) => x.idempotent)!;
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/); expect(p.options).not.toBeNull();
    if (again.hash === null) expect(again).toMatchObject({ options: null, order: { state: 'proposed' } }); else expect(again.hash).toBe(p.hash);
    expect(await w.svc.propose(id, body(LIMIT), k)).toMatchObject({ idempotent: true, hash: p.hash, order: { state: 'risk_checked' } }); // once it is built, every retry gets the same proposal
    expect((await w.svc.propose(id, body(LIMIT), k)).options).not.toBeNull();
    expect((await w.svc.propose(id, body({ ...LIMIT, size: '0.004' }), k))).toMatchObject({ idempotent: true, order: { size: '0.002' } });   // the key decides, not the body
    expect((await sql`select count(*)::int as n from deriv_orders where account_id = ${id}`)[0].n).toBe(1);
    const assertion = w.pk.assert(b64(p.hash!)) as never;
    const both = await Promise.all([w.svc.approveOrder(id, k, assertion), w.svc.approveOrder(id, k, assertion)]);
    expect(both.map((x) => x.idempotent).sort()).toEqual([false, true]);
    expect(w.t.exchangeCalls('order')).toBe(1);
    expect(w.signs).toHaveLength(1);
    const later = await w.svc.approveOrder(id, k, w.pk.assert(b64(p.hash!)) as never);
    expect(later).toMatchObject({ idempotent: true, order: { state: 'open' } });
    const after = await w.svc.propose(id, body(LIMIT), k);
    expect(after).toMatchObject({ idempotent: true, options: null, order: { state: 'open' } });                           // nothing left to approve
    expect(w.t.exchangeCalls('order')).toBe(1);
    expect(w.t.openOrders(ACCOUNT)).toHaveLength(1);
    // a refused proposal keeps its key too
    const bad = key();
    await refusal(w.svc.propose(id, body({ ...LIMIT, size: '0.01' }), bad));
    expect(await w.svc.propose(id, body(LIMIT), bad)).toMatchObject({ idempotent: true, options: null, order: { state: 'rejected' } });
  });
});

describe('unknown outcomes are resolved by the venue, never by assumption', () => {
  it('timeout AFTER the venue took the order → unknown → found by its client id', async () => {
    const w = world(), id = await live(w);
    w.t.fault = 'lost_after';
    const a = await place(w, id, LIMIT);
    expect(a.order).toMatchObject({ state: 'open', source: 'venue' });                                                    // looked up at once by cloid
    expect((await events(id, 'order_unknown'))).toHaveLength(1);
    expect(await audits(id)).not.toContain('deriv.live.order_submitted');                                                 // the HTTP answer never said so
    expect(w.t.exchangeCalls('order')).toBe(1);

    w.next();
    w.t.fault = 'garbage_after';                                                                                          // an unreadable answer to a market order that did fill
    const b = await place(w, id, MARKET);
    expect(b.order).toMatchObject({ state: 'filled', final: true, filled: '0.002', avgFillPrice: '70005' });
  });

  it('timeout BEFORE the venue saw it → unknown while the signature can still land → never placed once it has expired', async () => {
    const w = world(), id = await live(w);
    w.t.fault = 'lost_before';
    const a = await place(w, id, LIMIT);
    expect(a.order).toMatchObject({ state: 'unknown', final: false, source: 'local' });
    expect(a.order.reason).toMatch(/may or may not exist/);
    w.next(30_000);
    await w.svc.reconcile(id);
    expect((await row(id, a.k)).state).toBe('unknown');                                                                   // 30 s: the signed action is still valid on the venue
    w.next(70_000);
    await w.svc.reconcile(id);
    expect(await row(id, a.k)).toMatchObject({ state: 'rejected', final: true });
    expect((await row(id, a.k)).reject_reason).toMatch(/never placed/);
    expect(w.t.exchangeCalls('order')).toBe(1);                                                                           // never sent again
    expect(await audits(id)).toContain('deriv.live.order_never_placed');

    w.t.fault = 'http502_before';
    const b = await place(w, id, LIMIT);
    expect(b.order.state).toBe('unknown');
  });

  it('restart between signing and sending: nothing is re-signed or re-sent; the venue decides what happened', async () => {
    const w = world(), id = await live(w);
    const prepare = async () => {
      const k = key(), p = await w.svc.propose(id, body(LIMIT), k), r = await row(id, k);
      // the process got the signature, stored it, and died
      const signed = await w.port.venueSign({ authorizationId: p.canonical!.authorizationId, sign: r.sign_request, context: { order: r.request }, assertion: w.pk.assert(b64(p.hash!)) });
      await sql`update deriv_orders set state = 'signed', signature = ${sql.json(signed.signature)} where account_id = ${id} and client_id = ${k}`;
      return { k, r, signature: signed.signature };
    };
    // (a) it died before sending
    const a = await prepare();
    const svc = w.restart();
    await svc.reconcile(id);
    expect((await row(id, a.k)).state).toBe('unknown');
    expect(await refusal(svc.approveOrder(id, a.k, {} as never))).toBeNull();                                             // an approval retried after the restart does nothing
    expect(w.t.exchangeCalls('order')).toBe(0);
    w.next(100_000);
    await svc.reconcile(id);
    expect(await row(id, a.k)).toMatchObject({ state: 'rejected', final: true });
    expect(w.t.exchangeCalls('order')).toBe(0);

    // (b) it died after the venue received the order
    const b = await prepare();
    await w.t.fetch('https://api.hyperliquid-testnet.xyz/exchange' as never, { method: 'POST', body: JSON.stringify({ action: b.r.action, nonce: Number(b.r.nonce), signature: b.signature, vaultAddress: null, expiresAfter: Number(b.r.nonce) + 90_000 }) });
    const svc2 = w.restart();
    await svc2.reconcile(id);
    expect(await row(id, b.k)).toMatchObject({ state: 'open', final: false });
    expect(w.t.exchangeCalls('order')).toBe(1);

    // (c) it died while waiting for the signer: no signature was stored, so nothing can have been sent
    const k = key();
    await w.svc.propose(id, body(LIMIT), k);
    await sql`update deriv_orders set state = 'authorized', updated_at = ${new Date(w.clock.now())} where account_id = ${id} and client_id = ${k}`;
    await w.restart().reconcile(id);
    expect((await row(id, k)).state).toBe('authorized');
    w.next();
    await w.svc.reconcile(id);
    expect(await row(id, k)).toMatchObject({ state: 'rejected', final: true });
    expect((await row(id, k)).reject_reason).toMatch(/nothing was sent/);
  });

  it('a proposal that is not approved in time expires locally; nothing was signed', async () => {
    const w = world(), id = await live(w), k = key();
    const p = await w.svc.propose(id, body(LIMIT), k);
    w.next(95_000);
    expect(await refusal(w.svc.approveOrder(id, k, w.pk.assert(b64(p.hash!)) as never))).toMatchObject({ code: 'proposal_expired', status: 410 });
    expect(await row(id, k)).toMatchObject({ state: 'cancelled', final: true, signature: null });
    const k2 = key();
    await w.svc.propose(id, body(LIMIT), k2);
    expect((await w.svc.cancelOrder(id, k2))).toMatchObject({ sent: false, order: { state: 'cancelled' } });               // withdrawn before approval: a local row only
    expect(w.signs).toHaveLength(0); expect(w.t.exchangeCalls('order')).toBe(0);
  });
});

describe('reconciliation worker and divergence', () => {
  it('fills, funding and order states come from the venue; a resting order that fills later is picked up', async () => {
    const w = world(), id = await live(w);
    const a = await place(w, id, LIMIT);
    expect(await w.svc.active()).toEqual([id]);
    w.next();
    // the market comes down to the resting bid: the venue fills it (as its matching engine would)
    const o = w.t.openOrders(ACCOUNT)[0]!;
    (w.t as any).fill(w.t.user(ACCOUNT), o, '69500', '0.002'); o.status = 'filled'; o.statusTimestamp = w.clock.now();
    w.t.user(ACCOUNT).funding.push({ time: w.clock.now(), hash: `0x${'0'.repeat(64)}`, delta: { type: 'funding', coin: 'BTC', usdc: '-0.0123', szi: '0.002', fundingRate: '0.0000125' } });
    const s = await w.svc.step();
    expect(s).toMatchObject({ accounts: 1, reconciled: 1, fills: 1, funding: 1, divergences: 0, errors: [] });
    expect(await row(id, a.k)).toMatchObject({ state: 'filled', final: true });
    const d = await w.svc.get(id);
    expect(d.orders[0]).toMatchObject({ state: 'filled', filled: '0.002', avgFillPrice: '69500', source: 'venue' });
    expect(d.funding).toEqual([expect.objectContaining({ instrument: BTC, amount: '-0.0123', source: 'venue' })]);
    w.next();
    expect(await w.svc.step()).toMatchObject({ reconciled: 0, fills: 0, divergences: 0 });                                // nothing left in flight; a second pass changes nothing
  });

  it('an order the wallet did not place, or a position its fills do not explain, halts new orders until it clears', async () => {
    const w = world(), id = await live(w);
    const seen: string[] = [];
    w.svc.subscribe(id, (ev) => { seen.push(ev.event); });
    const foreign = w.t.foreignOrder(ACCOUNT, { px: '65000', sz: '0.001' });
    expect((await w.svc.reconcile(id)).divergence).toBeNull();                                                            // seen once: could be a race, not yet a divergence
    w.next();
    const r = await w.svc.reconcile(id);
    expect(r.divergence).toMatch(new RegExp(`order ${foreign} on hyperliquid:BTC rests on the venue and was not placed by the wallet`));
    expect((await w.svc.get(id))).toMatchObject({ mode: 'MANUAL_LIVE' });
    expect((await w.svc.get(id)).halted).toMatch(/records differ/);
    expect((await events(id, 'divergence'))).toHaveLength(1);
    expect(await audits(id)).toContain('deriv.live.divergence');
    expect(seen).toEqual(expect.arrayContaining(['account', 'risk']));
    w.next();
    expect(await refusal(w.svc.propose(id, body(LIMIT), key()))).toMatchObject({ code: 'halted', status: 422 });
    expect(await refusal(w.svc.proposeLeverage(id, { instrument: BTC, leverage: 2, marginMode: 'cross' }))).toMatchObject({ code: 'halted', status: 423 });
    w.next();
    await w.svc.reconcile(id);
    expect((await events(id, 'divergence'))).toHaveLength(1);                                                             // the same divergence is recorded once
    w.t.removeOrder(ACCOUNT, foreign);
    w.next();
    expect((await w.svc.reconcile(id)).divergence).toBeNull();
    expect((await events(id, 'divergence_cleared'))).toHaveLength(1);
    w.next();
    await place(w, id, LIMIT);                                                                                            // trading again

    // a position that the wallet's fills do not explain (a trade from another interface, a liquidation)
    w.next();
    w.t.forcePosition(ACCOUNT, 'BTC', '0.005');
    await w.svc.reconcile(id); w.next();
    const p = await w.svc.reconcile(id);
    expect(p.divergence).toMatch(/position hyperliquid:BTC: venue 0.005, wallet records 0/);
    w.next();
    expect(await refusal(w.svc.propose(id, body(LIMIT), key()))).toMatchObject({ code: 'halted' });
    // the way out stays open: a reduce-only order that reduces the venue's real position is still proposed
    const close = await w.svc.close(id, { instrument: BTC, fraction: '0.5' });
    expect(close).toMatchObject({ order: { state: 'risk_checked', reduceOnly: true, side: 'sell', size: '0.0025' }, slippageBoundBps: 50 });
    w.next();
    expect((await rebase(w, id)).divergence).toBeNull();                                                               // the owner accepts the venue's positions as the reference
    w.next();
    expect((await w.svc.reconcile(id)).divergence).toBeNull();
  });
});

describe('kill switch: halt, cancel-all and close are three separate actions', () => {
  it('halt stops new orders only; cancel-all cancels resting orders only; close is a passkey-approved reduce-only order with a stated bound', async () => {
    const w = world(), id = await live(w);
    await place(w, id, MARKET);                                                                                           // a position: 0.002 long
    w.next();
    const resting = await place(w, id, LIMIT);                                                                            // and a resting order
    w.next();
    const pending = key();
    await w.svc.propose(id, body(LIMIT), pending);                                                                        // and a proposal waiting for the passkey
    const signsBefore = w.signs.length, sentBefore = w.t.exchangeCalls();

    const h = await w.svc.halt(id, { reason: 'test' });
    expect(h.halt).toMatch(/^halted by the owner: test/);
    expect(w.signs.length).toBe(signsBefore); expect(w.t.exchangeCalls()).toBe(sentBefore);                               // a halt signs nothing and sends nothing
    expect(w.t.openOrders(ACCOUNT)).toHaveLength(1);                                                                      // the resting order is still there
    expect(h.venueState.positions).toHaveLength(1);                                                                       // the position is still open
    expect(await row(id, pending)).toMatchObject({ state: 'cancelled', final: true });                                    // the unapproved proposal is withdrawn
    w.next();
    expect(await refusal(w.svc.propose(id, body(LIMIT), key()))).toMatchObject({ code: 'halted' });
    expect(await refusal(w.svc.propose(id, body({ ...MARKET, side: 'sell', size: '0.005', reduceOnly: true }), key()))).toMatchObject({ code: 'reduce_only_would_flip' });

    w.next();
    const c = await w.svc.cancelAll(id);
    expect(c).toMatchObject({ requested: 1, accepted: 1, failed: [], remaining: [], source: 'venue' });
    expect(w.t.openOrders(ACCOUNT)).toHaveLength(0);
    expect(await row(id, resting.k)).toMatchObject({ state: 'cancelled', final: true });
    expect((await w.svc.get(id)).venueState.positions).toHaveLength(1);                                                   // cancel-all closed nothing
    expect(w.signs[w.signs.length - 1]).not.toHaveProperty('assertion');                                                  // and needed no passkey

    w.next();
    const k = key(), close = await w.svc.close(id, { instrument: BTC, fraction: '1', slippageBps: 30 }, k);
    expect(close).toMatchObject({ slippageBoundBps: 30, worstPrice: '69786', order: { state: 'risk_checked', side: 'sell', size: '0.002', reduceOnly: true, origin: 'close' } });   // 69995 × (1 − 0.003), rounded UP onto the venue's grid: a sell never accepts less than the bound
    expect(close.canonical).toMatchObject({ reduceOnly: true, type: 'limit', tif: 'ioc', price: '69786' });
    expect((await w.svc.get(id)).venueState.positions).toHaveLength(1);                                                   // proposing closed nothing
    expect((await refusal(w.svc.approveOrder(id, k, {} as never)))!.code).toMatch(/^signer_(bad_approval|unknown_credential)$/);   // not without the passkey
    w.next();
    const k2 = key(), close2 = await w.svc.close(id, { instrument: BTC, fraction: '1' }, k2);
    const done = await w.svc.approveOrder(id, k2, w.pk.assert(b64(close2.hash!)) as never);
    expect(done.order).toMatchObject({ state: 'filled', final: true, filled: '0.002', avgFillPrice: '69995' });
    expect((await w.svc.get(id)).venueState.positions).toHaveLength(0);
    expect(await refusal(w.svc.close(id, { instrument: BTC, fraction: '1' }))).toMatchObject({ code: 'no_position' });

    w.next();
    expect((await resume(w, id)).halt).toBeNull();
    await place(w, id, LIMIT);
    expect(await audits(id)).toEqual(expect.arrayContaining(['deriv.live.halt', 'deriv.live.cancel_all', 'deriv.live.close_proposed', 'deriv.live.resume']));
  });

  it('revoking needs no passkey and is permanent: proposals are refused, the signer signs nothing, resting orders are named', async () => {
    const w = world(), id = await live(w);
    await place(w, id, LIMIT);
    w.next();
    const r = await w.svc.revoke(id, { cancelOpenOrders: false });
    expect(r).toMatchObject({ mode: 'READ_ONLY', tradable: false, authorization: { active: false } });
    expect(r.warning).toMatch(/1 order\(s\) still rest on the venue/);
    expect(r.warning).toBe("1 order(s) still rest on the venue. The wallet can no longer cancel them (a revoked authorization signs nothing): cancel them in the venue's own interface, or approve a new authorization and cancel.");   // v8: default en, byte for byte
    { // v8 hardening (D2): the same warning in the body's locale
      const wf = world(), idf = await live(wf);
      await place(wf, idf, LIMIT); wf.next();
      const rf = await wf.svc.revoke(idf, { cancelOpenOrders: false, locale: 'fr' });
      expect(rf.locale).toBe('fr'); expect(rf.warning).toMatch(/^1 ordre\(s\) restent sur la plateforme\. Le portefeuille ne peut plus les annuler/);
    }
    expect(w.signer.status().venues[0]).toMatchObject({ revoked: true });
    expect(await refusal(w.svc.propose(id, body(LIMIT), key()))).toMatchObject({ code: 'mode_read_only' });
    expect(await refusal(w.svc.cancelAll(id))).toMatchObject({ code: 'mode_read_only' });
    // even if the API insisted, the signer refuses a revoked authorization
    const c = w.svc.deps.venues.get('testnet').trading().buildCancel({ instrument: await w.svc.deps.venues.get('testnet').instrument(BTC), venueOrderId: '1001', nonce: w.clock.now() });
    expect(await refusal(w.port.venueSign({ authorizationId: r.authorization!.id, sign: c.sign }))).toMatchObject({ code: 'signer_revoked' });

    // with cancelOpenOrders the resting orders are cancelled first, then the authorization is revoked
    const w2 = world(), id2 = await live(w2);
    await place(w2, id2, LIMIT);
    w2.next();
    const r2 = await w2.svc.revoke(id2, { cancelOpenOrders: true });
    expect(r2).toMatchObject({ mode: 'READ_ONLY', warning: null, cancelled: { requested: 1, accepted: 1 } });
    expect(w2.t.openOrders(ACCOUNT)).toHaveLength(0);
    // a new authorization can be approved afterwards (new id, new passkey approval)
    w2.next();
    await authorize(w2, id2);
    expect((await w2.svc.get(id2)).mode).toBe('MANUAL_LIVE');
  });
});

describe('leverage', () => {
  it('needs the passkey over its canonical form, is confirmed by the venue\'s own setting, and stays within the authorization', async () => {
    const w = world(), id = await live(w);
    const p = await w.svc.proposeLeverage(id, { instrument: BTC, leverage: 3, marginMode: 'cross' });
    expect(p).toMatchObject({ canonical: { kind: 'leverage', instrument: BTC, leverage: 3, marginMode: 'cross' }, current: { leverage: '20', marginMode: 'cross' }, action: { state: 'risk_checked' } });
    expect(p.options.challenge).toBe(b64(p.hash).toString('base64url'));
    expect((await refusal(w.svc.approveLeverage(id, p.action.id, {} as never)))!.code).toMatch(/^signer_(bad_approval|unknown_credential)$/);
    w.next();
    const p2 = await w.svc.proposeLeverage(id, { instrument: BTC, leverage: 3, marginMode: 'cross' });
    const r = await w.svc.approveLeverage(id, p2.action.id, w.pk.assert(b64(p2.hash)) as never);
    expect(r).toMatchObject({ idempotent: false, action: { state: 'confirmed' }, venue: { confirmed: true, leverage: { leverage: '3', marginMode: 'cross' }, source: 'venue' } });
    expect(w.t.user(ACCOUNT).leverage.get('BTC')).toEqual({ type: 'cross', value: 3 });
    expect((await w.svc.approveLeverage(id, p2.action.id, w.pk.assert(b64(p2.hash)) as never)).idempotent).toBe(true);
    expect(w.t.exchangeCalls('updateLeverage')).toBe(1);
    expect(await refusal(w.svc.proposeLeverage(id, { instrument: BTC, leverage: 4, marginMode: 'cross' }))).toMatchObject({ code: 'leverage_exceeded' });
    expect(await refusal(w.svc.proposeLeverage(id, { instrument: 'hyperliquid:ETH', leverage: 2, marginMode: 'cross' }))).toMatchObject({ code: 'instrument_not_allowed' });
    // the order preview now uses the venue's setting
    w.next();
    expect((await w.svc.preview(id, body(LIMIT))).estimate).toMatchObject({ leverage: '3', initialMargin: '46.333333333333333334' });
  });
});

describe('asset table and mainnet locks', () => {
  it('a venue whose asset table no longer matches the pinned one is not traded', async () => {
    const w = world(), id = await live(w);
    const u = w.t.meta.universe, btc = u.findIndex((x: any) => x.name === 'BTC'), eth = u.findIndex((x: any) => x.name === 'ETH');
    [u[btc], u[eth]] = [u[eth], u[btc]];                                                                                  // the venue renumbers BTC and ETH
    w.next(120_000);
    const r = await refusal(w.svc.propose(id, body(LIMIT), key()));
    expect(r).toMatchObject({ code: 'asset_table_mismatch', status: 503 });
    expect(r!.message).toMatch(/BTC moved from index 3 to 4/);
    expect(await refusal(w.svc.preview(id, body(LIMIT)))).toMatchObject({ code: 'asset_table_mismatch' });
    expect(await refusal(w.svc.proposeLeverage(id, { instrument: BTC, leverage: 2, marginMode: 'cross' }))).toMatchObject({ code: 'asset_table_mismatch' });
    expect(w.signs).toHaveLength(0); expect(w.t.exchangeCalls('order')).toBe(0);
  });

  it('mainnet with the server setting off: read-only account, every proposal refused with a clear message, the mainnet exchange endpoint never called; testnet works', async () => {
    const w = world();
    expect(w.svc.config()).toMatchObject({ mainnetEnabled: false, mandateLive: { available: false } });
    // v6: a mainnet venue account is not even created while the setting is off (it was created READ_ONLY before); one that exists stays, read-only
    expect(await refusal(w.svc.createAccount({ venue: 'hyperliquid', network: 'mainnet', label: 'm' }))).toMatchObject({ code: 'mainnet_disabled', status: 403 });
    w.flags.mainnet = true;
    const main = await account(w, { network: 'mainnet' });
    w.flags.mainnet = false;
    expect((await w.svc.get(main))).toMatchObject({ mode: 'READ_ONLY', network: 'mainnet', mainnetEnabled: false, tradable: false, agentAddress: keys.venueKey('hyperliquid', 'mainnet').address });
    const r = await refusal(w.svc.prepareAuthorization(main, ex.AuthorizationBodySchema.parse({ policy: POLICY, days: 30, locale: 'fr' })));
    expect(r).toMatchObject({ code: 'mainnet_disabled', status: 403 });
    expect(r!.message).toMatch(/SPW_DERIV_LIVE_MAINNET/);
    for (const p of [() => w.svc.propose(main, body(LIMIT), key()), () => w.svc.preview(main, body(LIMIT)), () => w.svc.proposeLeverage(main, { instrument: BTC, leverage: 2, marginMode: 'cross' })])
      expect(await refusal(p())).toMatchObject({ code: 'mainnet_disabled', status: 403 });
    // V11: the ways out are not behind the mainnet lock — on this account they are refused because it is read-only (nothing to cancel or close)
    for (const p of [() => w.svc.close(main, { instrument: BTC, fraction: '1' }), () => w.svc.cancelAll(main)]) expect(await refusal(p())).toMatchObject({ code: 'mode_read_only', status: 422 });
    const test = await live(w);                                                                                           // the same wallet on testnet
    expect((await place(w, test, LIMIT)).order.state).toBe('open');
    expect(w.m.exchangeCalls()).toBe(0);

    // the setting is turned off AFTER an account was authorized: both locks hold
    w.flags.mainnet = true;
    await authorize(w, main);
    expect(w.m.exchangeCalls('approveAgent')).toBe(1);                                                                    // (a fake: nothing real is ever reached)
    w.flags.mainnet = false;
    w.next();
    expect(await refusal(w.svc.propose(main, body(LIMIT), key()))).toMatchObject({ code: 'mainnet_disabled' });
    const trading = w.svc.deps.venues.get('mainnet').trading(), inst = await w.svc.deps.venues.get('mainnet').instrument(BTC);
    const built = trading.buildOrder({ instrument: BTC, side: 'buy', type: 'limit', size: '0.002', price: '69500', triggerPrice: null, reduceOnly: false, tif: 'gtc', clientId: 'direct' }, { instrument: inst, nonce: w.clock.now() });
    await expect(trading.submit(built.action, { r: `0x${'1'.repeat(64)}`, s: `0x${'1'.repeat(64)}`, v: 27 }, w.clock.now())).rejects.toThrow(/mainnet exchange endpoint is closed to new risk/);
    expect(w.m.exchangeCalls()).toBe(1);                                                                                  // still only the approval made while it was on
    // mainnet and testnet are separate keys and separate authorizations
    const st = w.signer.status().venues;
    expect(new Set(st.map((v) => v.authorization.agentAddress)).size).toBe(2);
    expect(new Set(st.map((v) => v.authorization.network))).toEqual(new Set(['mainnet', 'testnet']));
  });
});

describe('routes', () => {
  it('every live route needs the owner session and the CSRF header; the whole flow works over HTTP', async () => {
    const w = world();
    await w.signer.enroll({ credential: w.pk.credential(), setupToken: 'tok' });
    w.t.fund(ACCOUNT, '1000');
    const token = randomBytes(32).toString('base64url');
    await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
    const cookie = `${(await import('../src/auth.ts')).COOKIE}=${token}`;
    const app = await (await import('../src/server.ts')).buildServer({ live: w.svc });
    const api = async (method: 'GET' | 'POST', path: string, payload?: unknown, o: { cookie?: string | null; idem?: string; csrf?: boolean } = {}) => {
      const headers: Record<string, string> = {};
      if (o.cookie !== null) headers.cookie = o.cookie ?? cookie;
      if (method !== 'GET') { headers.origin = ORIGIN; if (o.csrf !== false) headers['x-spw-csrf'] = '1'; headers['content-type'] = 'application/json'; }
      if (o.idem) headers['idempotency-key'] = o.idem;
      const r = await app.inject({ method, url: P + path, headers, payload: payload === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(payload) });
      return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() };
    };
    try {
      const zero = '00000000-0000-4000-8000-000000000000';
      for (const p of ['/config', '/jurisdiction', '/accounts', `/accounts/${zero}`, `/accounts/${zero}/collateral`, `/accounts/${zero}/stream`]) expect((await api('GET', p, undefined, { cookie: null })).status, p).toBe(401);
      const posts = ['/venue-key', '/accounts', `/accounts/${zero}/authorization/prepare`, `/accounts/${zero}/authorization/approve`, `/accounts/${zero}/authorization/revoke`, `/accounts/${zero}/policy`, `/accounts/${zero}/orders/preview`,
        `/accounts/${zero}/orders`, `/accounts/${zero}/orders/some-client-id/approve`, `/accounts/${zero}/orders/some-client-id/cancel`, `/accounts/${zero}/leverage`, `/accounts/${zero}/leverage/${zero}/approve`, `/accounts/${zero}/halt`,
        `/accounts/${zero}/resume`, `/accounts/${zero}/cancel-all`, `/accounts/${zero}/close`, `/accounts/${zero}/rebase`, `/accounts/${zero}/reconcile`,
        `/accounts/${zero}/authorization/recover`, `/accounts/${zero}/policy/prepare`, `/accounts/${zero}/policy/approve`, `/accounts/${zero}/resume/prepare`, `/accounts/${zero}/rebase/prepare`];
      for (const p of posts) {
        expect((await api('POST', p, {}, { cookie: null, idem: key() })).status, p).toBe(401);
        expect((await api('POST', p, {}, { csrf: false, idem: key() })).status, p).toBe(403);
      }
      expect(w.t.calls).toHaveLength(0);

      expect((await api('GET', '/config')).json).toMatchObject({ mainnetEnabled: false, bounds: { maxAuthorizationDays: 90, orderApprovalTtlMs: 90000 } });
      const j = (await api('GET', '/jurisdiction')).json;
      expect(j.fr.sha256).toBe(jurisdictionAck('hyperliquid', 'fr').sha256); expect(j.en.text).toContain('not legal advice');
      expect((await api('POST', '/venue-key', { venue: 'hyperliquid', network: 'testnet' })).json).toMatchObject({ address: AGENT, account: ACCOUNT });
      expect((await api('POST', '/venue-key', { venue: 'dydx', network: 'mainnet' })).status).toBe(404);
      const created = await api('POST', '/accounts', { venue: 'hyperliquid', network: 'testnet', label: 'HL testnet' });
      expect(created.status).toBe(200);
      const id = created.json.id as string;
      expect((await api('GET', '/accounts')).json.accounts).toEqual([expect.objectContaining({ id, mode: 'READ_ONLY', kind: 'venue' })]);
      expect((await api('GET', `/accounts/${zero}`)).status).toBe(404);
      expect((await api('POST', `/accounts/${id}/authorization/prepare`, { policy: POLICY, days: 120, locale: 'fr' })).status).toBe(400);
      const prep = await api('POST', `/accounts/${id}/authorization/prepare`, { policy: POLICY, days: 30, locale: 'fr' });
      expect(prep.status).toBe(200);
      expect((await api('POST', `/accounts/${id}/authorization/approve`, { assertion: w.pk.assert(b64(prep.json.hash)) })).status).toBe(400);   // `acknowledged: true` is required
      const ok = await api('POST', `/accounts/${id}/authorization/approve`, { assertion: w.pk.assert(b64(prep.json.hash)), acknowledged: true });
      expect(ok.status).toBe(200); expect(ok.json.mode).toBe('MANUAL_LIVE');

      expect((await api('POST', `/accounts/${id}/orders`, { instrument: BTC, ...LIMIT })).status).toBe(400);                 // no Idempotency-Key
      expect((await api('POST', `/accounts/${id}/orders`, { instrument: BTC, ...LIMIT, clientId: 'x' }, { idem: key() })).status).toBe(400);
      const k = key(), prop = await api('POST', `/accounts/${id}/orders`, { instrument: BTC, ...LIMIT }, { idem: k });
      expect(prop.status).toBe(200); expect(prop.json.order.state).toBe('risk_checked');
      const too = await api('POST', `/accounts/${id}/orders`, { instrument: BTC, ...LIMIT, size: '0.01' }, { idem: key() });
      expect(too.status).toBe(422); expect(too.json.error).toBe('order_notional_exceeded');
      expect((await api('POST', `/accounts/${id}/orders/${k}/approve`, {})).status).toBe(400);
      const appr = await api('POST', `/accounts/${id}/orders/${k}/approve`, { assertion: w.pk.assert(b64(prop.json.hash)) });
      expect(appr.status).toBe(200); expect(appr.json.order).toMatchObject({ state: 'open', source: 'venue' });
      w.next();
      expect((await api('POST', `/accounts/${id}/halt`, { reason: 'route test' })).json.halt).toMatch(/route test/);
      expect((await api('POST', `/accounts/${id}/cancel-all`)).json).toMatchObject({ requested: 1, accepted: 1 });
      expect((await api('POST', `/accounts/${id}/close`, { instrument: BTC, fraction: '1' })).json.error).toBe('no_position');
      w.next();
      const rec = await api('POST', `/accounts/${id}/reconcile`);
      expect(rec.status).toBe(200); expect(rec.json.account.orders.find((o: any) => o.clientId === k).state).toBe('cancelled');
      expect((await api('GET', `/accounts/${id}/collateral`)).json).toMatchObject({ withdrawable: '1000', source: 'venue' });
      expect((await api('POST', `/accounts/${id}/authorization/revoke`, {})).json.mode).toBe('READ_ONLY');
    } finally { app.server.closeAllConnections?.(); await app.close(); }
  });
});

// =========================================================================================================================
// V11 Phase B — the audited defects of docs/v11/audit-parts/derivatives-exec-signer.md, each with its refusal cases

describe('V11 B-02: the mainnet server lock closes new risk, never the way out', () => {
  it('with SPW_DERIV_LIVE_MAINNET off after positions exist: cancel, cancel-all and a reduce-only close still work; a new order, a leverage change and a new authorization do not', async () => {
    const w = world();
    w.flags.mainnet = true;
    const main = await live(w, { network: 'mainnet' });
    const resting = await place(w, main, LIMIT), resting2 = await place(w, main, { ...LIMIT, price: '69400' });
    w.next();
    expect((await place(w, main, MARKET)).order.state).toBe('filled');                                                     // a long of 0.002 BTC on the (fake) mainnet venue
    expect(w.m.openOrders(ACCOUNT)).toHaveLength(2);
    w.flags.mainnet = false;                                                                                                // the setting is forgotten at a restart
    w.restart(); w.next();
    expect(await w.svc.get(main)).toMatchObject({ mode: 'MANUAL_LIVE', mainnetEnabled: false, tradable: false });
    // new risk: refused, nothing reaches the venue
    const sent = w.m.exchangeCalls(), signed = w.signs.length;
    expect(await refusal(w.svc.propose(main, body(LIMIT), key()))).toMatchObject({ code: 'mainnet_disabled', status: 403 });
    expect(await refusal(w.svc.preview(main, body(MARKET)))).toMatchObject({ code: 'mainnet_disabled' });
    expect(await refusal(w.svc.proposeLeverage(main, { instrument: BTC, leverage: 2, marginMode: 'cross' }))).toMatchObject({ code: 'mainnet_disabled' });
    expect(await refusal(w.svc.createAccount({ venue: 'hyperliquid', network: 'mainnet', label: 'again' }))).toMatchObject({ code: 'mainnet_disabled' });
    // "reduce-only" is not a password: a reduce-only order that would not reduce is refused by the risk engine
    expect(await refusal(w.svc.propose(main, body({ ...MARKET, reduceOnly: true }), key()))).toMatchObject({ code: 'reduce_only_would_increase' });
    expect(await refusal(w.svc.propose(main, body({ ...MARKET, side: 'sell', size: '0.005', reduceOnly: true }), key()))).toMatchObject({ code: 'reduce_only_would_flip' });
    expect(w.m.exchangeCalls()).toBe(sent); expect(w.signs.length).toBe(signed);
    // the ways out
    const c1 = await w.svc.cancelOrder(main, resting.k);
    expect(c1).toMatchObject({ sent: true, venue: { outcome: 'accepted' }, order: { state: 'cancelled', final: true } });
    w.next();
    expect(await w.svc.cancelAll(main)).toMatchObject({ requested: 1, accepted: 1, failed: [], remaining: [] });
    expect(await row(main, resting2.k)).toMatchObject({ state: 'cancelled', final: true });
    w.next();
    const k = key(), close = await w.svc.close(main, { instrument: BTC, fraction: '1' }, k);
    expect(close).toMatchObject({ order: { state: 'risk_checked', reduceOnly: true, side: 'sell', size: '0.002' } });
    expect((await w.svc.approveOrder(main, k, w.pk.assert(b64(close.hash!)) as never)).order).toMatchObject({ state: 'filled', final: true, filled: '0.002' });
    expect((await w.svc.get(main)).venueState.positions).toHaveLength(0);
    expect(w.m.exchangeCalls('cancel') + w.m.exchangeCalls('cancelByCloid')).toBe(2);
    // the adapter's own lock reads the action: anything that is not all reduce-only is not sent
    const trading = w.svc.deps.venues.get('mainnet').trading(), inst = await w.svc.deps.venues.get('mainnet').instrument(BTC), sig = { r: `0x${'1'.repeat(64)}`, s: `0x${'1'.repeat(64)}`, v: 27 };
    const open = trading.buildOrder({ instrument: BTC, side: 'buy', type: 'limit', size: '0.002', price: '69500', triggerPrice: null, reduceOnly: false, tif: 'gtc', clientId: 'direct-open' }, { instrument: inst, nonce: w.clock.now() });
    const before = w.m.exchangeCalls();
    await expect(trading.submit(open.action, sig, w.clock.now())).rejects.toThrow(/closed to new risk/);
    const mixed = { ...(open.action as { orders: object[] }), orders: [{ ...(open.action as { orders: { r: boolean }[] }).orders[0]!, r: true }, (open.action as { orders: object[] }).orders[0]!] };
    await expect(trading.submit(mixed, sig, w.clock.now())).rejects.toThrow(/closed to new risk/);                          // one reduce-only order does not carry another
    const lev = trading.buildUpdateLeverage({ instrument: inst, leverage: 2, marginMode: 'cross', nonce: w.clock.now() + 1 });
    await expect(trading.submit(lev.action, sig, w.clock.now() + 1)).rejects.toThrow(/closed to new risk/);
    expect(w.m.exchangeCalls()).toBe(before);
    expect(await audits(main)).toEqual(expect.arrayContaining(['deriv.live.cancel_sent', 'deriv.live.cancel_all', 'deriv.live.close_proposed']));
  });
});

describe('V11 B-07: protective orders can rest away from the market, and the refusal comes before the passkey', () => {
  it('a reduce-only stop-loss far below the mark is proposed and signed; an entry trigger far away, or a "protective" order that would fire at once, is refused at the proposal', async () => {
    const w = world(), id = await live(w);
    expect((await place(w, id, MARKET)).order.state).toBe('filled');                                                       // long 0.002 BTC; mark 70 000, band of the authorization 300 bps
    w.next();
    const sl = await place(w, id, { side: 'sell', type: 'stop_market', size: '0.002', triggerPrice: '60000', price: '59000', reduceOnly: true });
    expect(await row(id, sl.k)).toMatchObject({ reduce_only: true });
    expect((await row(id, sl.k)).signature).not.toBeNull();                                                                 // the signer signed it: 14 % below its own mid
    expect(['open', 'submitted']).toContain(sl.order.state);
    w.next();
    const tp = await place(w, id, { side: 'sell', type: 'take_profit_market', size: '0.002', triggerPrice: '90000', price: '88000', reduceOnly: true });
    expect((await row(id, tp.k)).signature).not.toBeNull();
    w.next();
    const signed = w.signs.length;
    const refused = async (o: Record<string, unknown>) => refusal(w.svc.propose(id, body(o), key()));
    // an entry (not reduce-only) trigger outside the band: the signer would refuse it — said here, before any passkey prompt
    expect(await refused({ side: 'buy', type: 'stop_market', size: '0.002', triggerPrice: '80000', price: '81000' })).toMatchObject({ code: 'price_deviation', status: 422 });
    expect((await refused({ side: 'buy', type: 'stop_market', size: '0.002', triggerPrice: '80000', price: '81000' }))!.message).toMatch(/the signer applies this rule with its own price and would refuse the order/);
    // reduce-only, but on the side where it fires at once
    expect((await refused({ side: 'sell', type: 'stop_market', size: '0.002', triggerPrice: '80000', price: '79000', reduceOnly: true }))!.message).toMatch(/would fire at once/);
    expect((await refused({ side: 'sell', type: 'take_profit_market', size: '0.002', triggerPrice: '60000', price: '59000', reduceOnly: true }))!.message).toMatch(/would fire at once/);
    // resting but absurd
    expect((await refused({ side: 'sell', type: 'stop_market', size: '0.002', triggerPrice: '20000', price: '19800', reduceOnly: true }))!.message).toMatch(/outside the sanity band/);
    expect(w.signs.length).toBe(signed);                                                                                    // none of these reached the signer
    for (const r of await sql`select reject_reason from deriv_orders where account_id = ${id} and state = 'rejected'`) expect(r.reject_reason).toMatch(/^price_deviation|^reduce_only/);
  });
});

describe('V11 B-04: a lost answer of the signer no longer locks the venue account', () => {
  it('the authorization the signer stored is adopted: same bytes, no second passkey, the account goes live; nothing is adopted that the API did not hand over', async () => {
    const w = world(), id = await account(w);
    const prep = await w.svc.prepareAuthorization(id, ex.AuthorizationBodySchema.parse({ policy: POLICY, days: 30, locale: 'fr' }));
    w.fault.authorize = 'lost';
    expect(await refusal(w.svc.approveAuthorization(id, { assertion: w.pk.assert(b64(prep.hash)) as never, acknowledged: true }))).toMatchObject({ code: 'authorization_unknown', status: 503 });
    // the state the audit described: the signer holds it, the API does not, and a new one is refused for 90 days
    expect(w.signer.status().venues).toHaveLength(1);
    expect(await w.svc.get(id)).toMatchObject({ mode: 'READ_ONLY', authorization: null });
    expect(w.t.exchangeCalls('approveAgent')).toBe(0);
    expect(await refusal(w.svc.prepareAuthorization(id, ex.AuthorizationBodySchema.parse({ policy: POLICY, days: 30, locale: 'fr' })))).toMatchObject({ code: 'authorization_orphaned', status: 409 });
    const before = w.store.state.journal.length;
    const r = await w.svc.recover(id);
    expect(r).toMatchObject({ mode: 'MANUAL_LIVE', authorization: { id: prep.authorization.authorizationId, active: true }, recovered: [{ what: 'authorization', outcome: 'adopted', id: prep.authorization.authorizationId }] });
    expect(w.t.exchangeCalls('approveAgent')).toBe(1);                                                                    // the stored approveAgent, sent once
    expect(w.store.state.journal.slice(before).map((j) => j.type)).toEqual([]);                                           // the signer signed and recorded nothing new
    expect(w.signer.status().venues).toHaveLength(1);
    expect((await place(w, id, LIMIT)).order.state).toBe('open');                                                          // and it trades, with the passkey per order
    expect(await audits(id)).toEqual(expect.arrayContaining(['deriv.live.authorization_unknown', 'deriv.live.authorization_recovered', 'deriv.live.acknowledged', 'deriv.live.authorized']));
    expect((await w.svc.recover(id)).recovered).toEqual([]);                                                               // nothing left to recover
  });

  it('an authorization the API has no record of is revoked on the signer (no passkey), and a new one can then be approved', async () => {
    const w = world(), id = await account(w);
    const prep = await w.svc.prepareAuthorization(id, ex.AuthorizationBodySchema.parse({ policy: POLICY, days: 30, locale: 'fr' }));
    w.fault.authorize = 'lost';
    await refusal(w.svc.approveAuthorization(id, { assertion: w.pk.assert(b64(prep.hash)) as never, acknowledged: true }));
    await sql`delete from settings where key = ${`deriv.live.submitted.${id}`}`;                                           // the API's own copy is gone too (a restore, another instance)
    const r = await w.svc.recover(id);
    expect(r).toMatchObject({ mode: 'READ_ONLY', recovered: [{ what: 'authorization', outcome: 'revoked', id: prep.authorization.authorizationId }] });
    expect(w.signer.status().venues[0]).toMatchObject({ revoked: true });
    expect(w.t.exchangeCalls('approveAgent')).toBe(0);                                                                    // nothing was sent to the venue
    w.next();
    expect((await authorize(w, id)).done.mode).toBe('MANUAL_LIVE');                                                        // the account is free again
  });

  it('a stored copy that does not match what the signer holds is never adopted: the signer-side authorization is revoked', async () => {
    const w2 = world(), id2 = await account(w2);
    const p2 = await w2.svc.prepareAuthorization(id2, ex.AuthorizationBodySchema.parse({ policy: POLICY, days: 30, locale: 'fr' }));
    w2.fault.authorize = 'lost';
    await refusal(w2.svc.approveAuthorization(id2, { assertion: w2.pk.assert(b64(p2.hash)) as never, acknowledged: true }));
    const [st] = await sql`select value from settings where key = ${`deriv.live.submitted.${id2}`}`;
    await sql`update settings set value = ${sql.json({ ...st.value, authorization: { ...st.value.authorization, policy: { ...st.value.authorization.policy, maxOrderNotional: '499' } } })} where key = ${`deriv.live.submitted.${id2}`}`;
    expect((await w2.svc.recover(id2)).recovered).toEqual([expect.objectContaining({ outcome: 'revoked' })]);
    expect(await w2.svc.get(id2)).toMatchObject({ mode: 'READ_ONLY' });
  });

  it('a refusal of the signer leaves nothing to recover; adopting on mainnet respects the mainnet lock', async () => {
    const w = world(), id = await account(w);
    const prep = await w.svc.prepareAuthorization(id, ex.AuthorizationBodySchema.parse({ policy: POLICY, days: 30, locale: 'fr' }));
    expect((await refusal(w.svc.approveAuthorization(id, { assertion: w.pk.assert(new Uint8Array(32)) as never, acknowledged: true })))!.code).toBe('signer_bad_approval');
    expect(await sql`select 1 from settings where key = ${`deriv.live.submitted.${id}`}`).toHaveLength(0);
    expect((await w.svc.recover(id)).recovered).toEqual([]);
    void prep;
    w.flags.mainnet = true;
    const main = await account(w, { network: 'mainnet' });
    const pm = await w.svc.prepareAuthorization(main, ex.AuthorizationBodySchema.parse({ policy: POLICY, days: 30, locale: 'fr' }));
    w.fault.authorize = 'lost';
    await refusal(w.svc.approveAuthorization(main, { assertion: w.pk.assert(b64(pm.hash)) as never, acknowledged: true }));
    w.flags.mainnet = false;                                                                                                // the lock is closed meanwhile: live trading is not turned on by a recovery
    expect((await w.svc.recover(main)).recovered).toEqual([expect.objectContaining({ what: 'authorization', outcome: 'revoked' })]);
    expect(await w.svc.get(main)).toMatchObject({ mode: 'READ_ONLY' });
    expect(w.m.exchangeCalls()).toBe(0);
  });
});

describe('V11 B-08: loosening an API-side limit or lifting a halt needs the passkey; tightening and halting stay free', () => {
  it('loosenedFields: which changes allow more', () => {
    const p = ex.liveRiskPolicy(POLICY as never, 'testnet');
    expect(ex.loosenedFields(p, p)).toEqual([]);
    expect(ex.loosenedFields(p, { ...p, maxDailyLoss: '1', maxTotalLoss: '2', maxOrdersPerMinute: 1, maxOrdersPerDay: 1, maxOrderNotional: '1', maxLeverage: '1', minLiquidationDistanceBps: '2000', minFreeCollateral: '50', maxDataAgeMs: 1000, maxDeviationBps: '10', maxMarkIndexBps: '10', allowedInstruments: [] })).toEqual([]);
    for (const [k, v] of Object.entries({ maxDailyLoss: '75.01', maxTotalLoss: '1000000000', minLiquidationDistanceBps: '999', maxDataAgeMs: 5001, maxMarkIndexBps: '1001', maxDeviationBps: '301', maxOrdersPerMinute: 7, maxOrdersPerDay: 51,
      maxLeverage: '4', maxOrderNotional: '500.01', maxGrossExposure: '1501', maxPositionNotional: '1001' })) {
      expect(ex.loosenedFields(p, { ...p, [k]: v } as never), k).toEqual([k]);
    }
    expect(ex.loosenedFields({ ...p, minFreeCollateral: '10' }, { ...p, minFreeCollateral: '9.99' })).toEqual(['minFreeCollateral']);
    expect(ex.loosenedFields({ ...p, allowedInstruments: [] }, p)).toEqual(['allowedInstruments']);
    expect(ex.loosenedFields({ ...p, halt: 'x' }, p)).toEqual(['halt']);
    expect(ex.loosenedFields(p, { ...p, somethingNew: 1 } as never)).toEqual(['somethingNew']);                           // an unknown field that changed counts as loosened
  });

  it('a session alone cannot raise the loss limits; with the passkey over the prepared policy it can — once, and only that policy', async () => {
    const w = world(), id = await live(w), p0 = (await w.svc.get(id)).policy;
    expect(p0).toMatchObject({ maxDailyLoss: '75', maxTotalLoss: '300' });
    // tightening: free
    const tight = { ...p0, maxDailyLoss: '20', maxTotalLoss: '100', minLiquidationDistanceBps: '1500', maxOrderNotional: '100' };
    expect((await w.svc.setPolicy(id, tight)).policy).toMatchObject({ maxDailyLoss: '20', maxTotalLoss: '100' });
    expect(await w.svc.prepareRisk(id, 'policy', { ...tight, maxDailyLoss: '10' })).toMatchObject({ needed: false, options: null });
    // loosening without the passkey: refused, nothing changes — every API-only limit of the audit
    for (const loose of [{ maxDailyLoss: '1000000000' }, { maxTotalLoss: '101' }, { minLiquidationDistanceBps: '0' }, { maxDataAgeMs: 600000 }, { maxMarkIndexBps: '100000' }, { maxDeviationBps: '301' }, { maxOrdersPerMinute: 60 }, { maxOrderNotional: '500' }]) {
      const r = await refusal(w.svc.setPolicy(id, { ...tight, ...loose } as never));
      expect(r, JSON.stringify(loose)).toMatchObject({ code: 'passkey_required', status: 403 });
      expect(r!.message).toContain(Object.keys(loose)[0]);
    }
    expect((await w.svc.get(id)).policy).toMatchObject(tight);
    expect(await refusal(w.svc.approvePolicy(id, w.pk.assert(new Uint8Array(32))))).toMatchObject({ code: 'bad_state' });   // nothing was prepared
    // prepare → the passkey signs the hash of the canonical intent (the whole new policy)
    const next = { ...tight, maxDailyLoss: '60', maxTotalLoss: '250' };
    const prep = await w.svc.prepareRisk(id, 'policy', next);
    expect(prep).toMatchObject({ needed: true, loosened: ['maxDailyLoss', 'maxTotalLoss'], intent: { v: 1, kind: 'policy', accountId: id, policy: next, loosened: ['maxDailyLoss', 'maxTotalLoss'] } });
    expect(prep.hash).toBe(Buffer.from(ex.riskIntentHash(prep.intent!)).toString('hex'));
    expect(prep.options!.challenge).toBe(b64(prep.hash!).toString('base64url'));
    // wrong approvals: none, another passkey, an assertion over something else (an order hash, another policy)
    expect(await refusal(w.svc.approvePolicy(id, undefined))).toMatchObject({ code: 'passkey_required' });
    expect(await refusal(w.svc.approvePolicy(id, new TestPasskey(RP, ORIGIN).assert(b64(prep.hash!))))).toMatchObject({ code: 'bad_approval', status: 403 });
    expect(await refusal(w.svc.approvePolicy(id, w.pk.assert(new Uint8Array(32))))).toMatchObject({ code: 'bad_approval' });
    const other = ex.riskIntentHash({ ...prep.intent!, policy: { ...next, maxDailyLoss: '1000000000' } });
    expect(await refusal(w.svc.approvePolicy(id, w.pk.assert(other)))).toMatchObject({ code: 'bad_approval' });
    expect(await refusal(w.svc.approvePolicy(id, w.pk.assert(b64(prep.hash!), { uv: false })))).toMatchObject({ code: 'bad_approval' });   // no user verification
    expect((await w.svc.get(id)).policy).toMatchObject(tight);
    // the right one
    const good = w.pk.assert(b64(prep.hash!));
    expect((await w.svc.approvePolicy(id, good)).policy).toMatchObject({ maxDailyLoss: '60', maxTotalLoss: '250', minLiquidationDistanceBps: '1500' });
    expect(await refusal(w.svc.approvePolicy(id, good))).toMatchObject({ code: 'bad_state' });                              // single use
    // above what the passkey-approved AUTHORIZATION allows: never, passkey or not
    expect(await refusal(w.svc.prepareRisk(id, 'policy', { ...next, maxOrderNotional: '501' }))).toMatchObject({ code: 'bad_policy' });
    // an expired preparation
    const late = await w.svc.prepareRisk(id, 'policy', { ...next, maxDailyLoss: '70' });
    w.clock.advance(ex.RISK_INTENT_TTL_MS + 1);
    expect(await refusal(w.svc.approvePolicy(id, w.pk.assert(b64(late.hash!))))).toMatchObject({ code: 'proposal_expired', status: 410 });
    expect((await w.svc.get(id)).policy).toMatchObject({ maxDailyLoss: '60' });
    const types = await audits(id);
    expect(types).toEqual(expect.arrayContaining(['deriv.live.risk_change_prepared', 'deriv.live.risk_change_refused', 'deriv.live.policy_replaced']));
    const [last] = await sql`select data from audit_events where type = 'deriv.live.policy_replaced' and data->>'account' = ${id} order by seq desc limit 1`;
    expect(last.data).toMatchObject({ passkey: true, loosened: ['maxDailyLoss', 'maxTotalLoss'] });
  });

  it('halting is free; lifting the halt needs the passkey over the intent that names that very halt', async () => {
    const w = world(), id = await live(w);
    expect(await w.svc.prepareRisk(id, 'resume')).toMatchObject({ needed: false });                                        // no halt: nothing to approve
    expect((await w.svc.resume(id)).halt).toBeNull();
    await w.svc.halt(id, { reason: 'one' });
    expect(await refusal(w.svc.resume(id))).toMatchObject({ code: 'passkey_required', status: 403 });
    expect(await refusal(w.svc.resume(id, w.pk.assert(new Uint8Array(32))))).toMatchObject({ code: 'bad_state' });          // not prepared
    const prep = await w.svc.prepareRisk(id, 'resume');
    expect(prep).toMatchObject({ needed: true, intent: { kind: 'resume', policy: null, subject: expect.stringMatching(/^halted by the owner: one/) } });
    expect(await refusal(w.svc.resume(id, w.pk.assert(new Uint8Array(32))))).toMatchObject({ code: 'bad_approval' });
    expect((await w.svc.get(id)).halt).toMatch(/one/);
    // the halt is replaced meanwhile: the approval of the first one does not lift the second
    w.clock.advance(1000); await w.svc.halt(id, { reason: 'two' });
    expect(await refusal(w.svc.resume(id, w.pk.assert(b64(prep.hash!))))).toMatchObject({ code: 'bad_state' });
    expect((await w.svc.get(id)).halt).toMatch(/two/);
    w.next();
    expect(await refusal(w.svc.propose(id, body(LIMIT), key()))).toMatchObject({ code: 'halted' });
    expect((await resume(w, id)).halt).toBeNull();
    expect((await place(w, id, LIMIT)).order.state).toBe('open');
    // a re-base needs it too
    expect(await refusal(w.svc.rebase(id))).toMatchObject({ code: 'passkey_required' });
    // without a verifier on the server the change is refused, not waved through
    const bare = lv.createLive({ fetch: routeFetch([w.t, w.m]), signer: w.port, now: w.clock.now, rpId: RP, mainnetEnabled: () => false, credentials: async () => [], confirmDelayMs: 0 });
    await w.svc.halt(id, { reason: 'three' });
    expect(await refusal(bare.prepareRisk(id, 'resume'))).toMatchObject({ code: 'passkey_unavailable', status: 503 });
    expect(await refusal(bare.resume(id, w.pk.assert(new Uint8Array(32))))).toMatchObject({ code: 'passkey_unavailable' });
    expect((await w.svc.get(id)).halt).toMatch(/three/);
  });

  it('over HTTP: /policy refuses a loosening, /policy/prepare + /policy/approve and /resume/prepare + /resume carry the passkey', async () => {
    const w = world(), id = await live(w);
    const token = randomBytes(32).toString('base64url');
    await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
    const cookie = `${(await import('../src/auth.ts')).COOKIE}=${token}`;
    const app = await (await import('../src/server.ts')).buildServer({ live: w.svc });
    const api = async (path: string, payload: unknown = {}) => { const r = await app.inject({ method: 'POST', url: `${P}/accounts/${id}${path}`, headers: { cookie, origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' }, payload: JSON.stringify(payload) }); return { status: r.statusCode, json: r.json() }; };
    try {
      const p = (await w.svc.get(id)).policy;
      expect((await api('/policy', { ...p, maxDailyLoss: '10' })).status).toBe(200);
      expect(await api('/policy', { ...p, maxDailyLoss: '500' })).toMatchObject({ status: 403, json: { error: 'passkey_required' } });
      const prep = await api('/policy/prepare', { ...p, maxDailyLoss: '500' });
      expect(prep).toMatchObject({ status: 200, json: { needed: true, loosened: ['maxDailyLoss'] } });
      expect((await api('/policy/approve', {})).status).toBe(400);
      expect(await api('/policy/approve', { assertion: w.pk.assert(new Uint8Array(32)) })).toMatchObject({ status: 403, json: { error: 'bad_approval' } });
      expect((await api('/policy/approve', { assertion: w.pk.assert(b64(prep.json.hash)) })).json.policy).toMatchObject({ maxDailyLoss: '500' });
      expect((await api('/halt', { reason: 'http' })).status).toBe(200);
      expect(await api('/resume')).toMatchObject({ status: 403, json: { error: 'passkey_required' } });
      const rp = await api('/resume/prepare');
      expect(rp.json).toMatchObject({ needed: true, kind: 'resume' });
      expect((await api('/resume', { assertion: w.pk.assert(b64(rp.json.hash)) })).json.halt).toBeNull();
      expect((await api('/authorization/recover')).json.recovered).toEqual([]);
    } finally { await app.close(); }
  });
});
