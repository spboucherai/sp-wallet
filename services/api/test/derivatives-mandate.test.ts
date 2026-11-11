// MANDATE_LIVE end to end inside the process: the REAL execution engine and its routes, the REAL isolated signer class with
// its REAL venue reader (in process, public test mnemonic, real WebAuthn assertions from a software passkey), PostgreSQL
// (database spw_deriv_mandate_test, created here if missing) and the scripted fake of the Hyperliquid exchange + info
// endpoints. No network: a request to any real host fails the test. Also: the fixes of the live engine that came with it.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jurisdictionAck, VENUE_MANDATE_WIND_DOWN_S, venueMandateHash, type VenueMandate } from '@spw/derivatives/live';
import type { OrderRequest } from '@spw/derivatives';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { Signer, SignerError } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';
import { hyperliquidReader } from '../../isolated-signer/src/venue-read.ts';
import { Clock, useDatabase } from './derivatives-helpers.ts';
import { FakeHl, routeFetch } from './hl-fake.ts';

const RP = 'wallet.test', ORIGIN = 'https://wallet.test', BTC = 'hyperliquid:BTC', P = '/api/v1/derivatives/live';
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const ACCOUNT = keys.addresses.evm.toLowerCase();
const b64 = (hexHash: string) => Buffer.from(hexHash, 'hex');
const SHA = 'c0de'.repeat(16), AGENT_ID = 'perp-agent-1';
const POLICY = { allowedInstruments: [BTC], maxLeverage: 3, maxOrderNotional: '500', maxPositionNotional: '1000', maxGrossExposure: '1500', maxOrdersPerDay: 50, maxPriceDeviationBps: 300 };
const MANDATE = { instruments: [{ instrument: BTC, maxLeverage: 3, maxPositionNotional: '600' }], maxOrderNotional: '300', maxGrossExposure: '800', maxOrdersPerDay: 20, maxOrdersPerHour: 10, maxDailyTurnover: '3000',
  floorEquity: '500', days: 10, locale: 'fr', strategySha256: SHA, agentId: AGENT_ID };

let sql: any, lv: typeof import('../src/derivatives/live.ts'), ex: typeof import('../src/derivatives/exec.ts'), pp: typeof import('../src/derivatives/paper.ts'), mm: typeof import('../src/derivatives/mandate.ts'),
  UserError: typeof import('../src/config.ts').UserError;
type Svc = import('../src/derivatives/exec.ts').LiveService;

beforeAll(async () => {
  await useDatabase('deriv_mandate');
  const db = await import('../src/db.ts');
  sql = db.sql;
  await db.migrate();
  await db.migrate(); // the schema is idempotent
  lv = await import('../src/derivatives/live.ts'); ex = await import('../src/derivatives/exec.ts'); pp = await import('../src/derivatives/paper.ts'); mm = await import('../src/derivatives/mandate.ts');
  UserError = (await import('../src/config.ts')).UserError;
});
beforeEach(async () => { await sql`truncate deriv_accounts, deriv_orders, deriv_fills, deriv_funding, deriv_risk_events, deriv_equity, deriv_actions, deriv_mandates`; });
afterAll(async () => { await sql?.end(); });

let seq = 0;
const key = () => `mandate-key-${++seq}-${Math.random().toString(36).slice(2, 10)}`;

function world() {
  const clock = new Clock(Date.parse('2026-11-11T12:00:00Z'));
  const t = new FakeHl('testnet', clock.now), m = new FakeHl('mainnet', clock.now);
  const dir = mkdtempSync(join(tmpdir(), 'spw-mandate-api-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
  const px: { BTC: number; fail: string } = { BTC: 70_000, fail: '' };
  /** an info request type the venue fails on (502), for the API and for the signer alike */
  const faults: { info: string | null; signerInfo: string | null } = { info: null, signerInfo: null };
  const base = routeFetch([t, m]);
  const failing = (which: 'info' | 'signerInfo') => (async (url: string, init?: RequestInit) => {
    const type = JSON.parse(String(init?.body ?? '{}')).type;
    if (String(url).endsWith('/info') && faults[which] === type) return new Response('bad gateway', { status: 502 });
    return base(url as never, init);
  }) as unknown as typeof fetch;
  const signerInfoCalls: { url: string; type: string }[] = [];
  // the signer's OWN reader, pointed at the fake venue: its real parsing, its real pinned hosts
  const reader = hyperliquidReader(async (url, body) => {
    signerInfoCalls.push({ url, type: (body as { type: string }).type });
    const r = await failing('signerInfo')(url, { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => Math.floor(clock.now() / 1000),
    { get: async (s) => { if (px.fail) throw new Error(px.fail); return Object.fromEntries(s.map((k) => [k, (px as unknown as Record<string, number>)[k]!])); } }, reader);
  const pk = new TestPasskey(RP, ORIGIN);
  const call = async <T>(fn: () => T | Promise<T>): Promise<T> => { try { return await fn(); } catch (e) { if (e instanceof SignerError) throw new UserError(`signer_${e.code}`, e.message, 422); throw e; } };
  const signs: unknown[] = [], mandateSigns: any[] = [];
  const port: import('../src/derivatives/exec.ts').LiveSignerPort = {
    status: () => call(() => signer.status()), venueKey: (v, n) => call(() => signer.venueKey(v, n)),
    venueAuthorize: (a, s) => call(() => signer.venueAuthorize(a, s as never)), venueRevoke: (id) => call(() => signer.venueRevoke(id)),
    venueSign: (p) => { signs.push(p); return call(() => signer.venueSign(p as never)); },
  };
  const mandatePort: import('../src/derivatives/exec.ts').MandateSignerPort = {
    venueMandateApprove: (x, s) => call(() => signer.venueMandateApprove(x, s as never)), venueMandateRevoke: (id) => call(() => signer.venueMandateRevoke(id)),
    venueMandateSign: (p) => { mandateSigns.push(p); return call(() => signer.venueMandateSign(p as never)); },
  };
  const flags = { mainnet: false, mandateMainnet: false };
  const build = (): Svc => lv.createLive({ fetch: failing('info'), signer: port, mandateSigner: mandatePort, now: clock.now, rpId: RP, mainnetEnabled: () => flags.mainnet, mandateMainnetEnabled: () => flags.mandateMainnet,
    credentials: async () => [{ id: pk.id, transports: ['internal'] }], confirmDelayMs: 0 });
  const w = { clock, t, m, signer, store, pk, px, port, flags, faults, signs, mandateSigns, signerInfoCalls, svc: build(),
    /** a minute later (the adapter's local rate budget is a one-minute window on the test clock) */
    next: (ms = 61_000) => clock.advance(ms) };
  return w;
}
type World = ReturnType<typeof world>;
const refusal = async (p: Promise<unknown>) => { const e = await p.then(() => null, (x) => x); return e ? { code: e.code as string, status: e.status as number, message: e.message as string } : null; };
const audits = async (id: string) => (await sql`select type from audit_events where data->>'account' = ${id} order by seq`).map((r: { type: string }) => r.type) as string[];
const events = async (id: string, kind: string) => sql`select * from deriv_risk_events where account_id = ${id} and kind = ${kind} order by id` as Promise<any[]>;
const row = async (id: string, k: string) => (await sql`select * from deriv_orders where account_id = ${id} and client_id = ${k}`)[0];

/** an authorized (MANUAL_LIVE) account, funded on the fake venue, with the venue's leverage setting inside the mandate */
async function live(w: World, o: { network?: 'testnet' | 'mainnet'; leverage?: number | null } = {}) {
  if (w.signer.status().credentials.length === 0) await w.signer.enroll({ credential: w.pk.credential(), setupToken: 'tok' });
  const network = o.network ?? 'testnet', fake = network === 'testnet' ? w.t : w.m;
  fake.fund(ACCOUNT, '1000');
  if (o.leverage !== null) fake.user(ACCOUNT).leverage.set('BTC', { type: 'cross', value: o.leverage ?? 3 });
  const id = (await w.svc.createAccount({ venue: 'hyperliquid', network, label: 'test' })).id as string;
  const prep = await w.svc.prepareAuthorization(id, ex.AuthorizationBodySchema.parse({ policy: POLICY, days: 30, locale: 'fr' }));
  await w.svc.approveAuthorization(id, { assertion: w.pk.assert(b64(prep.hash)) as never, acknowledged: true });
  return id;
}
async function mandate(w: World, id: string, o: Record<string, unknown> = {}) {
  const prep = await w.svc.prepareMandate(id, ex.MandateBodySchema.parse({ ...MANDATE, ...o }));
  const done = await w.svc.approveMandate(id, { assertion: w.pk.assert(b64(prep.hash)) as never, acknowledged: true });
  return { prep, done, m: prep.mandate as VenueMandate };
}
async function mandated(w: World, o: Record<string, unknown> = {}) { const id = await live(w); return { id, ...(await mandate(w, id, o)) }; }
const req = (o: Partial<OrderRequest> = {}): OrderRequest => ({ instrument: BTC, side: 'buy', type: 'limit', size: '0.002', price: '69500', triggerPrice: null, reduceOnly: false, tif: 'gtc', clientId: 'ignored', ...o });
const MARKET_BUY = { type: 'market' as const, tif: 'ioc' as const, price: '70350' }, CLOSE = { side: 'sell' as const, type: 'market' as const, tif: 'ioc' as const, price: '69650', reduceOnly: true };
const ctx = (k = key(), o: Record<string, string> = {}) => ({ strategySha256: SHA, agentId: AGENT_ID, clientId: k, ...o });
const place = (w: World, id: string, o: Partial<OrderRequest> = {}, k = key()) => mm.placeMandateOrder(id, req(o), ctx(k), w.svc);
const body = (o: Record<string, unknown>) => pp.OrderBodySchema.parse({ instrument: BTC, ...o });
const LIMIT = { side: 'buy', type: 'limit', size: '0.002', price: '69500' };

describe('configuration: a second, separate mainnet lock; reasons in French and English', () => {
  it('GET /config says what is available and why not, with a locale', async () => {
    const w = world();
    const en = w.svc.config(), fr = w.svc.config('fr');
    expect(en).toMatchObject({ mainnetEnabled: false, locale: 'en', modes: ['READ_ONLY', 'MANUAL_LIVE', 'MANDATE_LIVE'], mainnet: { enabled: false, code: 'mainnet_disabled' },
      mandateLive: { available: true, code: null, reason: null, mainnet: { enabled: false, code: 'mandate_mainnet_disabled' }, bounds: { maxDays: 30, maxOrdersPerHour: 60, windDownSeconds: 86400, orderTtlMs: 30000 } } });
    expect(en.mainnet.reason).toMatch(/SPW_DERIV_LIVE_MAINNET is not "on"/);
    expect(fr.mainnet.reason).toMatch(/désactivée sur ce serveur \(SPW_DERIV_LIVE_MAINNET/);
    expect(fr.mandateLive.mainnet.reason).toMatch(/SPW_DERIV_LIVE_MAINNET=on ET SPW_DERIV_MANDATE_MAINNET=on/);
    expect(en.reasons.mainnet_disabled).toEqual({ en: en.mainnet.reason, fr: fr.mainnet.reason });
    // each lock alone is not enough
    w.flags.mandateMainnet = true;
    expect(w.svc.config().mandateLive.mainnet).toMatchObject({ enabled: false });
    w.flags.mainnet = true;
    expect(w.svc.config()).toMatchObject({ mainnet: { enabled: true, code: null, reason: null }, mandateLive: { mainnet: { enabled: true, code: null, reason: null } } });
    w.flags.mandateMainnet = false;
    expect(w.svc.config().mandateLive.mainnet.enabled).toBe(false);
    // the process-wide settings: exactly `on`, read at every use
    const before = [process.env.SPW_DERIV_LIVE_MAINNET, process.env.SPW_DERIV_MANDATE_MAINNET];
    try {
      delete process.env.SPW_DERIV_MANDATE_MAINNET; expect(lv.mandateMainnetEnabled()).toBe(false);
      for (const v of ['1', 'true', 'ON', 'on ']) { process.env.SPW_DERIV_MANDATE_MAINNET = v; expect(lv.mandateMainnetEnabled()).toBe(false); }
      process.env.SPW_DERIV_MANDATE_MAINNET = 'on'; expect(lv.mandateMainnetEnabled()).toBe(true); expect(lv.mainnetLiveEnabled()).toBe(before[0] === 'on');
    } finally { if (before[1] === undefined) delete process.env.SPW_DERIV_MANDATE_MAINNET; else process.env.SPW_DERIV_MANDATE_MAINNET = before[1]; }
    // an engine whose signer connection offers no mandate says so, and every mandate entry point refuses
    const none = lv.createLive({ fetch: routeFetch([w.t, w.m]), signer: w.port, now: w.clock.now, rpId: RP, mainnetEnabled: () => false, credentials: async () => [], confirmDelayMs: 0 });
    expect(none.config('fr')).toMatchObject({ modes: ['READ_ONLY', 'MANUAL_LIVE'], mandateLive: { available: false, code: 'mandate_unavailable' } });
    const id = await live(w);
    expect(await refusal(none.prepareMandate(id, ex.MandateBodySchema.parse(MANDATE)))).toMatchObject({ code: 'mandate_unavailable', status: 503 });
    expect(await refusal(none.placeMandateOrder(id, req(), ctx()))).toMatchObject({ code: 'mandate_unavailable', status: 503 });
  });
});

describe('mandate: prepare (what is shown), approve (one passkey), the account holds both modes', () => {
  it('prepare shows the limits, the acknowledgement again, what the signer enforces and trusts, the wind-down; approve stores it on the signer', async () => {
    const w = world(), id = await live(w);
    expect(await w.svc.get(id)).toMatchObject({ mode: 'MANUAL_LIVE', modes: ['MANUAL_LIVE'], mandate: null, pendingMandate: null });
    const prep = await w.svc.prepareMandate(id, ex.MandateBodySchema.parse(MANDATE));
    const ack = jurisdictionAck('hyperliquid', 'fr'), auth = (await w.svc.get(id)).authorization!;
    expect(prep.mandate).toMatchObject({ v: 1, authorizationId: auth.id, venue: 'hyperliquid', network: 'testnet', account: ACCOUNT, strategySha256: SHA, agentId: AGENT_ID, instruments: MANDATE.instruments,
      maxOrderNotional: '300', maxGrossExposure: '800', maxOrdersPerDay: 20, maxOrdersPerHour: 10, maxDailyTurnover: '3000', floorEquity: '500', maxPriceDeviationBps: 300, ackSha256: ack.sha256 });
    expect(prep.mandate.expiresAt - prep.mandate.createdAt).toBe(10 * 86400);
    expect(prep.hash).toBe(Buffer.from(venueMandateHash(prep.mandate)).toString('hex'));
    expect(prep.options.challenge).toBe(b64(prep.hash).toString('base64url'));                                           // the passkey signs the mandate hash
    expect(prep.acknowledgement).toEqual(ack);
    expect(prep).toMatchObject({ locale: 'fr', windDown: { seconds: 86400 }, authorization: { id: auth.id, policy: POLICY } });
    expect(prep.warning).toMatch(/SANS demander votre clé d'accès/);
    expect(prep.enforcedBySigner.join(' ')).toMatch(/lues par le signataire lui-même/);
    expect(prep.trustedBySigner.join(' ')).toMatch(/point d'accès public d'information de la plateforme/);
    expect(prep.notEnforced.join(' ')).toMatch(/consignée, pas vérifiée/);
    expect(prep.windDown.text).toMatch(/Pendant 24 heures/);
    expect((await w.svc.prepareMandate(id, ex.MandateBodySchema.parse({ ...MANDATE, locale: 'en' }))).enforcedBySigner.join(' ')).toMatch(/read by the signer itself/);
    expect(await w.svc.get(id)).toMatchObject({ modes: ['MANUAL_LIVE'], mandate: null, pendingMandate: { mandateId: expect.any(String) } });
    expect(ex.ApproveMandateSchema.safeParse({ assertion: {}, acknowledged: false }).success).toBe(false);                // the confirmation is not optional
    expect(await refusal(w.svc.approveMandate(id, { assertion: w.pk.assert(b64(prep.hash)) as never, acknowledged: true }))).toMatchObject({ code: 'signer_bad_approval' });   // the first preparation was replaced
    expect(await refusal(w.svc.approveMandate(id, { assertion: w.pk.assert(b64(prep.hash)) as never, acknowledged: true }))).toMatchObject({ code: 'bad_state', status: 409 });   // and a refused one is consumed

    const { done, m } = await mandate(w, id);
    expect(done).toMatchObject({ mode: 'MANUAL_LIVE', modes: ['MANUAL_LIVE', 'MANDATE_LIVE'], pendingMandate: null,
      mandate: { id: m.mandateId, phase: 'active', active: true, agentId: AGENT_ID, strategySha256: SHA, revokedAt: null, windDownUntil: null, limits: { maxGrossExposure: '800' } } });
    expect(w.signer.status().venueMandates).toHaveLength(1);
    expect(w.signer.status().venueMandates[0]).toMatchObject({ phase: 'active', mandate: { mandateId: m.mandateId } });
    expect(w.t.exchangeCalls()).toBe(1);                                                                                  // only the authorization's approveAgent: a mandate sends nothing to the venue
    expect(await audits(id)).toEqual(expect.arrayContaining(['deriv.live.mandate_refused', 'deriv.live.mandate_acknowledged', 'deriv.live.mandate_approved']));
    expect((await w.svc.mandateStatus(id)).signer).toMatchObject({ phase: 'active', today: { orders: 0 } });
    expect((await w.svc.list())[0]).toMatchObject({ modes: ['MANUAL_LIVE', 'MANDATE_LIVE'], mandate: { phase: 'active' } });
    // one mandate at a time
    expect(await refusal(w.svc.prepareMandate(id, ex.MandateBodySchema.parse(MANDATE)))).toMatchObject({ code: 'bad_state', status: 409 });
  });

  it('refuses a read-only account, anything wider than the authorization, and bodies outside the bounds', async () => {
    const w = world();
    await w.signer.enroll({ credential: w.pk.credential(), setupToken: 'tok' });
    w.t.fund(ACCOUNT, '1000');
    const ro = (await w.svc.createAccount({ venue: 'hyperliquid', network: 'testnet', label: 'ro' })).id;
    expect(await refusal(w.svc.prepareMandate(ro, ex.MandateBodySchema.parse(MANDATE)))).toMatchObject({ code: 'mode_read_only', status: 422 });
    expect(await refusal(w.svc.approveMandate(ro, { assertion: {} as never, acknowledged: true }))).toMatchObject({ code: 'mode_read_only' });
    expect(await refusal(w.svc.placeMandateOrder(ro, req(), ctx()))).toMatchObject({ code: 'mode_read_only' });
    const id = await live(w);
    const bad = async (o: Record<string, unknown>) => refusal(w.svc.prepareMandate(id, ex.MandateBodySchema.parse({ ...MANDATE, ...o })));
    expect(await bad({ maxGrossExposure: '1500.01' })).toMatchObject({ code: 'bad_policy', status: 400 });
    expect(await bad({ maxOrderNotional: '501', instruments: [{ instrument: BTC, maxLeverage: 3, maxPositionNotional: '600' }] })).toMatchObject({ code: 'bad_policy' });
    expect(await bad({ instruments: [{ instrument: BTC, maxLeverage: 4, maxPositionNotional: '600' }] })).toMatchObject({ code: 'bad_policy' });
    expect(await bad({ instruments: [{ instrument: 'hyperliquid:ETH', maxLeverage: 3, maxPositionNotional: '600' }] })).toMatchObject({ code: 'bad_policy' });
    expect(await bad({ maxOrdersPerDay: 51 })).toMatchObject({ code: 'bad_policy' });
    expect(await bad({ maxPriceDeviationBps: 301 })).toMatchObject({ code: 'bad_policy' });
    expect(await bad({ days: 30 })).toBeNull();                                                                           // the authorization lasts 30 days: just inside
    for (const o of [{ days: 31 }, { maxOrdersPerHour: 61 }, { floorEquity: '0' }, { strategySha256: 'nope' }, { agentId: 'has space' }, { extra: 1 }]) expect(ex.MandateBodySchema.safeParse({ ...MANDATE, ...o }).success).toBe(false);
    // approving with a passkey assertion over something else
    const prep = await w.svc.prepareMandate(id, ex.MandateBodySchema.parse(MANDATE));
    expect(await refusal(w.svc.approveMandate(id, { assertion: w.pk.assert(randomBytes(32)) as never, acknowledged: true }))).toMatchObject({ code: 'signer_bad_approval', status: 422 });
    expect(await w.svc.get(id)).toMatchObject({ modes: ['MANUAL_LIVE'], mandate: null });
    expect(w.signer.status().venueMandates).toHaveLength(0);
    void prep;
    // under the signer's emergency halt no mandate is prepared
    w.signer.halt();
    expect(await bad({})).toMatchObject({ code: 'halted', status: 423 });
  });
});

describe('placeMandateOrder: the same pipeline as a manual order, without the passkey', () => {
  it('a limit order rests, a market order fills, a reduce-only order closes — no passkey, the venue\'s own state decides, manual orders still need the passkey', async () => {
    const w = world(), { id, m } = await mandated(w);
    const k = key(), r = await place(w, id, {}, k);
    expect(r).toMatchObject({ idempotent: false, order: { clientId: k, state: 'open', final: false, source: 'venue', origin: 'mandate', instrument: BTC, side: 'buy', size: '0.002', price: '69500' }, estimate: { notional: '139', source: 'estimate' } });
    expect(r.order.expiresAt! - r.order.nonce!).toBe(30_000);                                                              // a short venue expiry
    expect(w.signs).toHaveLength(0);                                                                                      // /venue/sign (passkey path) was not used
    expect(w.mandateSigns).toHaveLength(1);
    expect(w.mandateSigns[0]).toMatchObject({ mandateId: m.mandateId, context: { order: { clientId: r.order.cloid, reduceOnly: false } } });
    expect(Object.keys(w.mandateSigns[0])).not.toContain('assertion');
    expect(w.t.openOrders(ACCOUNT)).toHaveLength(1);
    expect(await row(id, k)).toMatchObject({ mandate_id: m.mandateId, agent: { mandateId: m.mandateId, agentId: AGENT_ID, strategySha256: SHA }, origin: 'mandate' });
    // the signer read the venue itself: info only, on the testnet host
    expect(new Set(w.signerInfoCalls.map((c) => c.url))).toEqual(new Set(['https://api.hyperliquid-testnet.xyz/info']));
    expect(w.signerInfoCalls.map((c) => c.type)).toEqual(['frontendOpenOrders', 'clearinghouseState', 'activeAssetData']);

    // idempotent: the same key places nothing again and answers the reconciled order
    const again = await place(w, id, { size: '0.004', price: '69000' }, k);
    expect(again).toMatchObject({ idempotent: true, order: { clientId: k, state: 'open', size: '0.002' }, estimate: { notional: '139' } });
    expect(w.t.exchangeCalls('order')).toBe(1); expect(w.mandateSigns).toHaveLength(1);
    expect((await mm.mandateOrder(id, k, w.svc))).toMatchObject({ state: 'open' });
    expect(await mm.mandateOrder(id, 'no-such-order-key', w.svc)).toBeNull();

    // cancel: no passkey, through the authorization
    const c = await mm.cancelMandateOrder(id, k, w.svc);
    expect(c).toMatchObject({ sent: true, order: { state: 'cancelled', final: true } });

    w.next();
    const buy = await place(w, id, MARKET_BUY);
    expect(buy.order).toMatchObject({ state: 'filled', final: true, filled: '0.002', avgFillPrice: '70005', source: 'venue' });
    const s = await mm.mandateAccountState(id, w.svc);
    expect(s).toMatchObject({ accountId: id, network: 'testnet', mode: 'MANUAL_LIVE', modes: ['MANUAL_LIVE', 'MANDATE_LIVE'], canOpen: true, canReduce: true, blocked: null, halted: null, error: null, source: 'venue',
      mandate: { phase: 'active' }, positions: [{ instrument: BTC, side: 'long', size: '0.002', source: 'venue' }] });
    expect(s.state!.equity).toMatch(/^999\./);
    expect(await mm.mandatePositions(id, w.svc)).toHaveLength(1);
    const close = await place(w, id, CLOSE);
    expect(close.order).toMatchObject({ state: 'filled', reduceOnly: true, filled: '0.002' });
    expect(await mm.mandatePositions(id, w.svc)).toEqual([]);
    expect(w.signer.status().venueMandates[0]).toMatchObject({ today: { orders: 2, reduceOnly: 1 } });
    expect((await w.svc.reconcile(id)).divergence).toBeNull();                                                            // mandate orders are the wallet's own: no divergence
    expect(await audits(id)).toEqual(expect.arrayContaining(['deriv.live.mandate_order', 'deriv.live.order_submitted', 'deriv.live.order_filled']));

    // manual mode is unchanged: a proposal waits for the passkey, and is refused without it
    w.next();
    const mk = key(), prop = await w.svc.propose(id, body(LIMIT), mk);
    expect(prop.options).not.toBeNull(); expect(prop.order.state).toBe('risk_checked');
    expect(await refusal(w.svc.approveOrder(id, mk, {} as never))).toMatchObject({ code: 'signer_unknown_credential' });
    const mk2 = key(), prop2 = await w.svc.propose(id, body(LIMIT), mk2);
    expect((await w.svc.approveOrder(id, mk2, w.pk.assert(b64(prop2.hash!)) as never)).order.state).toBe('open');
    // … and a key of a manual order cannot be replayed as a mandate order
    expect(await refusal(place(w, id, {}, mk2))).toMatchObject({ code: 'idempotency', status: 409 });
  });

  it('who asks matters: another strategy version, another agent, no mandate, a malformed request', async () => {
    const w = world(), id = await live(w);
    expect(await refusal(place(w, id))).toMatchObject({ code: 'mandate_none', status: 422 });
    await mandate(w, id);
    expect(await refusal(mm.placeMandateOrder(id, req(), ctx(key(), { strategySha256: 'ab'.repeat(32) }), w.svc))).toMatchObject({ code: 'mandate_mismatch', status: 422 });
    expect(await refusal(mm.placeMandateOrder(id, req(), ctx(key(), { agentId: 'someone-else' }), w.svc))).toMatchObject({ code: 'mandate_mismatch' });
    expect(await refusal(mm.placeMandateOrder(id, req({ price: null }), ctx(), w.svc))).toMatchObject({ code: 'bad_request', status: 400 });
    await expect(mm.placeMandateOrder(id, req(), { ...ctx(), clientId: 'short' }, w.svc)).rejects.toThrow();
    expect(w.mandateSigns).toHaveLength(0); expect(w.t.exchangeCalls('order')).toBe(0);
  });

  it('the API\'s own risk engine refuses first (stored, with its code); what only the signer can see is refused by the signer', async () => {
    const w = world(), { id } = await mandated(w);
    const k1 = key();
    expect(await refusal(place(w, id, { size: '0.005' }, k1))).toMatchObject({ code: 'order_notional_exceeded', status: 422 });   // 347.5 > 300 (mandate), although the authorization allows 500
    expect(await row(id, k1)).toMatchObject({ state: 'rejected', final: true, origin: 'mandate' });
    expect((await events(id, 'order_refused'))[0]).toMatchObject({ code: 'order_notional_exceeded', data: { origin: 'mandate', agentId: AGENT_ID } });
    expect(await refusal(place(w, id, { size: '0.005' }, k1))).toBeNull();                                                // the same key answers the stored refusal, places nothing
    expect(await refusal(place(w, id, { price: '60000' }))).toMatchObject({ code: 'price_deviation' });
    expect(await refusal(place(w, id, { instrument: 'hyperliquid:ETH', size: '0.05', price: '2000' }))).toMatchObject({ code: 'instrument_not_allowed' });
    expect(w.mandateSigns).toHaveLength(0);

    // resting orders: the API's engine does not count them in the exposure, the signer does — 4 × 140 = 560, the fifth would make 700 > 600
    for (let k = 0; k < 4; k++) expect((await place(w, id)).order.state).toBe('open');
    w.next();
    const k5 = key(), r5 = await refusal(place(w, id, {}, k5));
    expect(r5).toMatchObject({ code: 'signer_position_exceeded', status: 422 });
    expect(r5!.message).toMatch(/worst-case BTC position 700/);
    expect(await row(id, k5)).toMatchObject({ state: 'rejected', final: true });
    expect((await row(id, k5)).reject_reason).toMatch(/^not signed: worst-case BTC position/);
    expect(w.t.exchangeCalls('order')).toBe(4);

    // the signer's own price differs from the venue's: refused by the signer, nothing sent
    w.px.BTC = 80_000;
    expect(await refusal(place(w, id, { size: '0.0002' }))).toMatchObject({ code: 'signer_price' });
    w.px.BTC = 70_000; w.px.fail = 'price sources disagree on BTC';
    expect(await refusal(place(w, id, { size: '0.0002' }))).toMatchObject({ code: 'signer_no_price' });
    w.px.fail = '';
    // the signer cannot read the venue itself: fail closed, although the API can
    w.faults.signerInfo = 'clearinghouseState';
    expect(await refusal(place(w, id, { size: '0.0002' }))).toMatchObject({ code: 'signer_venue_unreachable' });
    w.faults.signerInfo = null;
    expect(w.t.exchangeCalls('order')).toBe(4);
    expect((await events(id, 'order_refused')).map((e) => e.code)).toEqual(expect.arrayContaining(['signer_position_exceeded', 'signer_price', 'signer_no_price', 'signer_venue_unreachable']));
  });

  it('floor on the account value, and the leverage setting: said by the API, enforced by the signer', async () => {
    const w = world(), id = await live(w, { leverage: null });                                                           // the venue's default: 20× cross
    await mandate(w, id);
    expect(await refusal(place(w, id))).toMatchObject({ code: 'signer_leverage_setting' });
    const who = { strategySha256: SHA, agentId: AGENT_ID };
    expect(await refusal(mm.setMandateLeverage(id, { instrument: BTC, leverage: 4, marginMode: 'cross' }, who, w.svc))).toMatchObject({ code: 'leverage_exceeded' });
    expect(await refusal(mm.setMandateLeverage(id, { instrument: BTC, leverage: 2, marginMode: 'cross' }, { ...who, agentId: 'x' }, w.svc))).toMatchObject({ code: 'mandate_mismatch' });
    const lev = await mm.setMandateLeverage(id, { instrument: BTC, leverage: 3, marginMode: 'cross' }, who, w.svc);
    expect(lev).toMatchObject({ action: { kind: 'leverage', state: 'confirmed' }, venue: { confirmed: true, leverage: { leverage: '3', marginMode: 'cross' }, source: 'venue' } });
    expect(w.signs).toHaveLength(0);                                                                                      // no passkey path
    expect((await place(w, id, MARKET_BUY)).order.state).toBe('filled');
    // the account value falls below the mandate's floor (500): only reduce-only orders
    w.next();
    w.t.user(ACCOUNT).usdc = '499';
    expect(await refusal(place(w, id))).toMatchObject({ code: 'mandate_floor_equity', status: 422 });
    expect(w.mandateSigns.filter((s) => s.context).length).toBe(2);                                                       // the signer was not even asked
    expect((await place(w, id, CLOSE)).order.state).toBe('filled');
  });

  it('two concurrent calls with the same key place one order', async () => {
    const w = world(), { id } = await mandated(w);
    const k = key(), [a, b] = await Promise.all([place(w, id, {}, k), place(w, id, {}, k)]);
    expect([a.idempotent, b.idempotent].sort()).toEqual([false, true]);
    expect(a.order.state).toBe('open'); expect(b.order.state).toBe('open'); expect(a.order.cloid).toBe(b.order.cloid);
    expect(w.t.exchangeCalls('order')).toBe(1); expect(w.mandateSigns).toHaveLength(1);
  });
});

describe('state machine with the scripted exchange: `unknown` is resolved only by the venue', () => {
  it('answer lost after the venue took the order → the venue\'s own record decides: filled', async () => {
    const w = world(), { id } = await mandated(w);
    for (const fault of ['lost_after', 'garbage_after'] as const) {
      w.t.fault = fault;
      const r = await place(w, id, { ...MARKET_BUY, size: '0.001' });
      expect(r.order).toMatchObject({ state: 'filled', final: true, filled: '0.001', source: 'venue' });
      w.next();
    }
    expect((await events(id, 'order_unknown')).length).toBe(2);
    expect(w.t.exchangeCalls('order')).toBe(2);
  });

  it('request lost before the venue saw it → unknown, never re-sent; after the venue expiry of the signature (30 s) it is "never placed"', async () => {
    const w = world(), { id } = await mandated(w);
    for (const fault of ['lost_before', 'http502_before'] as const) {
      w.t.fault = fault;
      const k = key(), r = await place(w, id, {}, k);
      expect(r.order).toMatchObject({ state: 'unknown', final: false, source: 'local' });
      expect((await place(w, id, {}, k))).toMatchObject({ idempotent: true, order: { state: 'unknown' } });               // asking again sends nothing
      w.clock.advance(34_000);
      expect((await mm.mandateOrder(id, k, w.svc))!.state).toBe('unknown');                                                // 30 s expiry + 5 s grace not over
      w.clock.advance(2_000);
      expect(await mm.mandateOrder(id, k, w.svc)).toMatchObject({ state: 'rejected', final: true, reason: expect.stringMatching(/^never placed/) });
      expect((await place(w, id, {}, k))).toMatchObject({ idempotent: true, order: { state: 'rejected' } });
      w.next();
    }
    expect(w.t.exchangeCalls('order')).toBe(2); expect(w.t.openOrders(ACCOUNT)).toHaveLength(0);
    expect(w.mandateSigns).toHaveLength(2);
  });

  it('a venue refusal is a state, not an exception; the worker reconciles mandate orders like the others', async () => {
    const w = world(), { id } = await mandated(w);
    const r = await place(w, id, { tif: 'alo', price: '70100' });                                                         // post-only that would cross
    expect(r.order).toMatchObject({ state: 'rejected', final: true });
    expect(r.order.reason).toMatch(/Post only order would have immediately matched/);
    const k = key();
    await place(w, id, {}, k);
    w.next();
    // filled on the venue while resting: the reconciliation worker sees it
    w.t.bids = [['69400', '1']]; w.t.asks = [['69450', '1']];
    const o = w.t.openOrders(ACCOUNT)[0]!;
    (w.t as any).fill(w.t.user(ACCOUNT), o, '69500', '0.002'); o.status = 'filled'; o.statusTimestamp = w.clock.now();
    const step = await w.svc.step();
    expect(step).toMatchObject({ accounts: 1, errors: [] });
    expect(await row(id, k)).toMatchObject({ state: 'filled' });
    expect((await w.svc.get(id)).divergence).toBeNull();
  });
});

describe('stopping: kill switch, divergence, revocation, expiry, wind-down', () => {
  it('owner halt and divergence stop mandate orders that can add exposure; reduce-only orders still pass; the kill switch is unchanged', async () => {
    const w = world(), { id } = await mandated(w);
    await place(w, id, MARKET_BUY);
    await w.svc.halt(id, { reason: 'test' });
    const k = key();
    expect(await refusal(place(w, id, {}, k))).toMatchObject({ code: 'halted', status: 422 });
    expect(await row(id, k)).toMatchObject({ state: 'rejected', final: true });
    expect(await mm.mandateAccountState(id, w.svc)).toMatchObject({ canOpen: false, canReduce: true, halted: expect.stringMatching(/halted by the owner/) });
    expect(await refusal(mm.setMandateLeverage(id, { instrument: BTC, leverage: 2, marginMode: 'cross' }, { strategySha256: SHA, agentId: AGENT_ID }, w.svc))).toMatchObject({ code: 'halted', status: 423 });
    expect((await place(w, id, { ...CLOSE, size: '0.001' })).order.state).toBe('filled');
    await w.svc.resume(id);
    w.next();
    expect((await place(w, id)).order.state).toBe('open');

    // a position the wallet did not create: two passes, then new exposure is stopped
    w.t.forcePosition(ACCOUNT, 'BTC', '0.01');
    await w.svc.reconcile(id); w.next(); await w.svc.reconcile(id);
    expect((await w.svc.get(id)).divergence).toMatch(/position hyperliquid:BTC/);
    const r = await refusal(place(w, id));
    expect(r).toMatchObject({ code: 'halted' }); expect(r!.message).toMatch(/differ/);
    expect((await place(w, id, { ...CLOSE, size: '0.001' })).order.state).toBe('filled');                                 // reducing the venue's real position passes

    // the signer's emergency halt: refused by the signer; reduce-only still signed
    w.t.forcePosition(ACCOUNT, 'BTC', '0.002');
    await w.svc.rebase(id);
    w.next();
    w.signer.halt();
    expect(await refusal(place(w, id))).toMatchObject({ code: 'signer_halted' });
    expect((await place(w, id, { ...CLOSE, size: '0.001' })).order.state).toBe('filled');
    expect((await w.svc.cancelAll(id))).toMatchObject({ requested: 1, accepted: 1 });                                    // cancels are signed under the emergency halt
  });

  it('revoking the mandate: no new exposure at once; cancels and reduce-only orders for 24 h; manual trading goes on; then nothing', async () => {
    const w = world(), { id, m } = await mandated(w);
    await place(w, id, MARKET_BUY);
    await place(w, id);                                                                                                   // one resting order
    w.next();
    const rv = await w.svc.revokeMandate(id, { cancelOpenOrders: true, locale: 'fr' });
    expect(rv).toMatchObject({ mode: 'MANUAL_LIVE', modes: ['MANUAL_LIVE'], cancelled: { requested: 1, accepted: 1 }, cancelError: null, locale: 'fr',
      mandate: { id: m.mandateId, phase: 'wind_down', active: false }, windDown: { openPositions: 1, openOrders: 0 } });
    expect(rv.windDown.until).toBe(rv.mandate!.revokedAt! + VENUE_MANDATE_WIND_DOWN_S * 1000 - (rv.mandate!.revokedAt! % 1000));
    expect(rv.windDown.text).toMatch(/NE ferme PAS les positions ouvertes/);
    expect(w.signer.status().venueMandates[0]).toMatchObject({ revoked: true, phase: 'wind_down' });
    expect(await refusal(place(w, id))).toMatchObject({ code: 'mandate_wind_down', status: 422 });
    expect(await refusal(mm.setMandateLeverage(id, { instrument: BTC, leverage: 2, marginMode: 'cross' }, { strategySha256: SHA, agentId: AGENT_ID }, w.svc))).toMatchObject({ code: 'mandate_wind_down' });
    expect(await mm.mandateAccountState(id, w.svc)).toMatchObject({ canOpen: false, canReduce: true });
    // the engine can still close during the wind-down — without a passkey
    w.next();
    expect((await place(w, id, { ...CLOSE, size: '0.001' })).order.state).toBe('filled');
    expect((await w.svc.revokeMandate(id, { cancelOpenOrders: false })).mandate).toMatchObject({ phase: 'wind_down' });   // idempotent
    // the owner trades manually as before (passkey), and can approve a new mandate
    const mk = key(), prop = await w.svc.propose(id, body(LIMIT), mk);
    expect((await w.svc.approveOrder(id, mk, w.pk.assert(b64(prop.hash!)) as never)).order.state).toBe('open');
    // 24 h later the wind-down is over
    w.clock.advance(VENUE_MANDATE_WIND_DOWN_S * 1000);
    expect((await w.svc.get(id)).mandate).toMatchObject({ phase: 'ended' });
    expect(await refusal(place(w, id, { ...CLOSE, size: '0.001' }))).toMatchObject({ code: 'mandate_none' });
    expect((await mm.cancelMandateOrder(id, mk, w.svc)).order.state).toBe('cancelled');                                   // cancels live with the authorization
    const next = await mandate(w, id, { days: 5 });
    expect(next.done).toMatchObject({ modes: ['MANUAL_LIVE', 'MANDATE_LIVE'], mandate: { id: next.m.mandateId, phase: 'active' } });
    expect(await audits(id)).toEqual(expect.arrayContaining(['deriv.live.mandate_revoked']));
  });

  it('an expired mandate winds down the same way', async () => {
    const w = world(), { id } = await mandated(w, { days: 1 });
    await place(w, id, MARKET_BUY);
    w.clock.advance(86_400_000);
    expect((await w.svc.get(id))).toMatchObject({ modes: ['MANUAL_LIVE'], mandate: { phase: 'wind_down', expired: true, revokedAt: null } });
    const r = await refusal(place(w, id));
    expect(r).toMatchObject({ code: 'mandate_wind_down' }); expect(r!.message).toMatch(/has expired/);
    expect((await place(w, id, { ...CLOSE, size: '0.001' })).order.state).toBe('filled');
  });

  it('revoking the AUTHORIZATION stops everything at once: no wind-down, not even a cancel', async () => {
    const w2 = world(), { id: id2 } = await mandated(w2);
    await place(w2, id2);
    const rv = await w2.svc.revoke(id2, { cancelOpenOrders: true });
    expect(rv).toMatchObject({ mode: 'READ_ONLY', modes: ['READ_ONLY'], cancelled: { requested: 1, accepted: 1 }, cancelError: null, mandate: { phase: 'ended' } });
    expect(w2.signer.status().venueMandates[0]).toMatchObject({ revoked: true, phase: 'ended' });
    expect(await refusal(place(w2, id2, CLOSE))).toMatchObject({ code: 'mode_read_only' });
    expect(await mm.mandateAccountState(id2, w2.svc)).toMatchObject({ canOpen: false, canReduce: false, blocked: { code: 'mode_read_only' } });
    // even asked directly, the signer signs nothing for it — not a reduce-only order, not a cancel
    const sent = w2.mandateSigns[0];
    await expect(w2.signer.venueMandateSign(sent)).rejects.toThrow(/authorization of this mandate was revoked/);
  });
});

describe('mainnet: autonomous trading needs BOTH server settings', () => {
  it('SPW_DERIV_LIVE_MAINNET alone authorizes manual trading only; without SPW_DERIV_MANDATE_MAINNET no mandate is prepared, approved or used — nothing reaches the exchange endpoint', async () => {
    const w = world();
    w.flags.mainnet = true;
    const id = await live(w, { network: 'mainnet' });
    expect(w.m.exchangeCalls()).toBe(1);                                                                                  // the authorization's approveAgent (a fake: nothing real is ever reached)
    const r = await refusal(w.svc.prepareMandate(id, ex.MandateBodySchema.parse(MANDATE)));
    expect(r).toMatchObject({ code: 'mandate_mainnet_disabled', status: 403 });
    expect(r!.message).toMatch(/SPW_DERIV_MANDATE_MAINNET=on/);
    expect(await refusal(place(w, id))).toMatchObject({ code: 'mandate_mainnet_disabled', status: 403 });
    w.flags.mandateMainnet = true;
    const { m } = await mandate(w, id);
    expect(m.network).toBe('mainnet');
    // either setting turned off afterwards closes it again
    w.flags.mandateMainnet = false;
    expect(await refusal(place(w, id))).toMatchObject({ code: 'mandate_mainnet_disabled' });
    expect(await refusal(mm.setMandateLeverage(id, { instrument: BTC, leverage: 2, marginMode: 'cross' }, { strategySha256: SHA, agentId: AGENT_ID }, w.svc))).toMatchObject({ code: 'mandate_mainnet_disabled' });
    expect(await mm.mandateAccountState(id, w.svc)).toMatchObject({ canOpen: false, canReduce: false, blocked: { code: 'mandate_mainnet_disabled' } });
    w.flags.mandateMainnet = true; w.flags.mainnet = false;
    expect(await refusal(place(w, id))).toMatchObject({ code: 'mainnet_disabled', status: 403 });
    expect(await refusal(w.svc.approveMandate(id, { assertion: {} as never, acknowledged: true }))).toMatchObject({ code: 'mainnet_disabled' });
    expect(w.m.exchangeCalls()).toBe(1); expect(w.mandateSigns).toHaveLength(0);
    // stopping needs neither
    expect((await w.svc.revokeMandate(id, { cancelOpenOrders: false })).mandate).toMatchObject({ phase: 'wind_down' });
    expect(w.signer.status().venueMandates[0]).toMatchObject({ revoked: true });
  });
});

describe('fixes of the live engine that came with the mandate', () => {
  it('propose(): a concurrent duplicate with the same Idempotency-Key waits for the built proposal; the estimate comes back on a replay', async () => {
    const w = world(), id = await live(w);
    const k = key(), [a, b, c] = await Promise.all([w.svc.propose(id, body(LIMIT), k), w.svc.propose(id, body(LIMIT), k), w.svc.propose(id, body({ ...LIMIT, size: '0.003' }), k)]);
    expect([a.idempotent, b.idempotent, c.idempotent].filter((x) => !x)).toHaveLength(1);
    for (const p of [a, b, c]) {
      expect(p.options).not.toBeNull();                                                                                   // (it was `options: null` for the duplicate)
      expect(p).toMatchObject({ hash: a.hash, order: { state: 'risk_checked', size: '0.002' }, estimate: { notional: '139', initialMargin: expect.any(String), source: 'estimate' } });
      expect(p.options!.challenge).toBe(b64(a.hash!).toString('base64url'));
    }
    const later = await w.svc.propose(id, body(LIMIT), k);
    expect(later).toMatchObject({ idempotent: true, estimate: a.estimate });
    expect((await sql`select count(*)::int as n from deriv_orders where account_id = ${id}`)[0].n).toBe(1);
    // a refused proposal, concurrently: every caller gets the stored refusal, one of them as the error
    const k2 = key(), big = body({ ...LIMIT, size: '0.01' });
    const rs = await Promise.all([w.svc.propose(id, big, k2), w.svc.propose(id, big, k2)].map((p) => p.then((x) => x.order.state, (e) => e.code)));
    expect(rs.sort()).toEqual(['order_notional_exceeded', 'rejected']);
    expect((await w.svc.propose(id, big, k2))).toMatchObject({ idempotent: true, options: null, estimate: null, order: { state: 'rejected' } });
    // a first call that fails before storing anything does not poison the key
    const k3 = key();
    w.faults.info = 'clearinghouseState';
    const both = await Promise.all([w.svc.propose(id, body(LIMIT), k3), w.svc.propose(id, body(LIMIT), k3)].map((p) => refusal(p)));
    expect(both.map((x) => x?.code)).toEqual(['venue_unavailable', 'venue_unavailable']);
    w.faults.info = null;
    expect((await w.svc.propose(id, body(LIMIT), k3)).order.state).toBe('risk_checked');
    // close() replays with its estimate too
    await w.svc.approveOrder(id, k, w.pk.assert(b64(a.hash!)) as never);
    const mk = key(), mp = await w.svc.propose(id, body({ side: 'buy', type: 'market', size: '0.002', slippageBps: 50, tif: 'ioc' }), mk);
    await w.svc.approveOrder(id, mk, w.pk.assert(b64(mp.hash!)) as never);
    const ck = key(), c1 = await w.svc.close(id, { instrument: BTC, fraction: '1' }, ck), c2 = await w.svc.close(id, { instrument: BTC, fraction: '1' }, ck);
    expect(c2).toMatchObject({ idempotent: true, estimate: c1.estimate }); expect(c1.estimate).not.toBeNull();
  });

  it('a mainnet account is refused server-side while mainnet is off, with the reason', async () => {
    const w = world();
    await w.signer.enroll({ credential: w.pk.credential(), setupToken: 'tok' });
    const r = await refusal(w.svc.createAccount({ venue: 'hyperliquid', network: 'mainnet', label: 'm' }));
    expect(r).toMatchObject({ code: 'mainnet_disabled', status: 403 });
    expect(r!.message).toBe(w.svc.config('en').mainnet.reason);
    expect(await w.svc.list()).toEqual([]);
    w.flags.mainnet = true;
    expect((await w.svc.createAccount({ venue: 'hyperliquid', network: 'mainnet', label: 'm' })).mode).toBe('READ_ONLY');
  });

  it('a halt (or a divergence) and an asset-table mismatch at approval END the proposal instead of leaving it approvable', async () => {
    const w = world(), id = await live(w);
    const k = key(), p = await w.svc.propose(id, body(LIMIT), k);
    await sql`update deriv_accounts set divergence = 'order 77 on hyperliquid:BTC rests on the venue and was not placed by the wallet' where id = ${id}`;
    expect(await refusal(w.svc.approveOrder(id, k, w.pk.assert(b64(p.hash!)) as never))).toMatchObject({ code: 'halted', status: 423 });
    expect(await row(id, k)).toMatchObject({ state: 'cancelled', final: true });
    expect((await row(id, k)).reject_reason).toMatch(/^withdrawn: trading was halted before the approval/);
    await sql`update deriv_accounts set divergence = null where id = ${id}`;
    expect(await w.svc.approveOrder(id, k, w.pk.assert(b64(p.hash!)) as never)).toMatchObject({ idempotent: true, order: { state: 'cancelled' } });   // it does not come back
    // a reduce-only proposal is not ended by a halt (it may still be approved)
    const k2 = key(), p2 = await w.svc.propose(id, body(LIMIT), k2);
    const u = w.t.meta.universe, btc = u.findIndex((x: any) => x.name === 'BTC'), eth = u.findIndex((x: any) => x.name === 'ETH');
    [u[btc], u[eth]] = [u[eth], u[btc]];                                                                                  // the venue renumbers BTC and ETH
    w.next(61_000);                                                                                                       // the proposal has 29 s left
    expect(await refusal(w.svc.approveOrder(id, k2, w.pk.assert(b64(p2.hash!)) as never))).toMatchObject({ code: 'asset_table_mismatch', status: 503 });
    expect(await row(id, k2)).toMatchObject({ state: 'cancelled', final: true });
    expect((await row(id, k2)).reject_reason).toMatch(/^withdrawn: live trading is suspended: the venue's asset table/);
    expect(w.signs).toHaveLength(0); expect(w.t.exchangeCalls('order')).toBe(0);
  });

  it('revoke says why cancel-all failed instead of answering `cancelled: null` alone', async () => {
    const w = world(), id = await live(w);
    const k = key(), p = await w.svc.propose(id, body(LIMIT), k);
    await w.svc.approveOrder(id, k, w.pk.assert(b64(p.hash!)) as never);
    w.next();
    w.faults.info = 'frontendOpenOrders';                                                                                 // the venue cannot list the open orders
    const r = await w.svc.revoke(id, { cancelOpenOrders: true, locale: 'fr' });
    expect(r).toMatchObject({ mode: 'READ_ONLY', cancelled: null, cancelError: { code: 'venue_unavailable', message: expect.stringMatching(/502|unavailable|HTTP/i) }, locale: 'fr' });
    expect(r.venueAgent).toMatch(/refuse désormais de l'utiliser/);
    w.faults.info = null;
    // nothing to say when it was not asked for
    expect(await w.svc.revoke(id, { cancelOpenOrders: false })).toMatchObject({ cancelled: null, cancelError: null, locale: 'en' });
  });

  it('server-authored texts follow the locale (English by default, as before); codes do not change', async () => {
    const w = world();
    await w.signer.enroll({ credential: w.pk.credential(), setupToken: 'tok' });
    w.t.fund(ACCOUNT, '1000');
    const id = (await w.svc.createAccount({ venue: 'hyperliquid', network: 'testnet', label: 'test' })).id as string;
    const en = await w.svc.collateral(id), fr = await w.svc.collateral(id, 'fr');
    expect(en).toMatchObject({ locale: 'en', deposits: { supported: false, how: expect.stringMatching(/^docs\/v4\/venues\/hyperliquid.md, section 15: native USDC on Arbitrum/) }, withdrawals: { supported: true, how: expect.stringMatching(/withdraw3 action, signed by the wallet key/) } });
    expect(fr).toMatchObject({ locale: 'fr', deposits: { supported: false, how: expect.stringMatching(/USDC natif sur Arbitrum/) }, withdrawals: { supported: true, how: expect.stringMatching(/withdraw3 signée par la clé du portefeuille/) } });
    const pf = await w.svc.prepareAuthorization(id, ex.AuthorizationBodySchema.parse({ policy: POLICY, days: 30, locale: 'fr' }));
    expect(pf).toMatchObject({ locale: 'fr', agent: { can: ['placer des ordres', 'annuler des ordres', 'changer le levier'], cannot: ['retirer des fonds', 'transférer vers une autre adresse'] } });
    expect(pf.agent.note).toMatch(/le signataire refuse de signer autre chose/);
    expect(pf.whatIsSigned.byMainKey).toMatch(/une seule action approveAgent/); expect(pf.whatIsSigned.byPasskey).toMatch(/SHA-256 de cette autorisation/);
    const pe = await w.svc.prepareAuthorization(id, ex.AuthorizationBodySchema.parse({ policy: POLICY, days: 30, locale: 'en' }));
    expect(pe).toMatchObject({ locale: 'en', agent: { can: ['place orders', 'cancel orders', 'change leverage'], cannot: ['withdraw', 'transfer to another address'] },
      whatIsSigned: { byMainKey: 'one approveAgent action naming the trading key above (the wallet key signs nothing else to trade; its only other venue message is a withdrawal to the wallet\'s own address, approved separately with the passkey)', byPasskey: 'the SHA-256 of this authorization, which includes the hash of the acknowledgement text' } });
    expect(pe.agent.note).toMatch(/^On the venue an API wallet could also move collateral/);
  });
});

describe('routes', () => {
  it('mandate routes need the owner session and the CSRF header; no route places a mandate order; the stream\'s first `status` agrees with the later ones', async () => {
    const w = world(), id = await live(w);
    const token = randomBytes(32).toString('base64url');
    await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
    const cookie = `${(await import('../src/auth.ts')).COOKIE}=${token}`;
    const app = await (await import('../src/server.ts')).buildServer({ live: w.svc });
    const api = async (method: 'GET' | 'POST', path: string, payload?: unknown, o: { cookie?: string | null; csrf?: boolean } = {}) => {
      const headers: Record<string, string> = {};
      if (o.cookie !== null) headers.cookie = o.cookie ?? cookie;
      if (method !== 'GET') { headers.origin = ORIGIN; if (o.csrf !== false) headers['x-spw-csrf'] = '1'; headers['content-type'] = 'application/json'; }
      const r = await app.inject({ method, url: P + path, headers, payload: payload === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(payload) });
      return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() };
    };
    try {
      for (const p of [`/accounts/${id}/mandate`]) expect((await api('GET', p, undefined, { cookie: null })).status, p).toBe(401);
      for (const p of ['prepare', 'approve', 'revoke']) {
        expect((await api('POST', `/accounts/${id}/mandate/${p}`, {}, { cookie: null })).status, p).toBe(401);
        expect((await api('POST', `/accounts/${id}/mandate/${p}`, {}, { csrf: false })).status, p).toBe(403);
      }
      // there is no HTTP way to place an order without a passkey
      for (const p of [`/accounts/${id}/mandate/orders`, `/accounts/${id}/mandate/order`, `/accounts/${id}/mandate/sign`, `/accounts/${id}/mandate/place`, `/accounts/${id}/mandate/leverage`])
        expect((await api('POST', p, { ...req(), ...ctx() })).status, p).toBe(404);
      expect((await api('GET', '/config?locale=fr')).json).toMatchObject({ locale: 'fr', mainnet: { code: 'mainnet_disabled', reason: expect.stringMatching(/désactivée/) }, mandateLive: { available: true } });
      expect((await api('GET', '/config')).json).toMatchObject({ locale: 'en', mainnetEnabled: false });
      expect((await api('GET', `/accounts/${id}/collateral?locale=fr`)).json.deposits.how).toMatch(/USDC natif/);
      expect((await api('POST', '/accounts', { venue: 'hyperliquid', network: 'mainnet' })).json).toMatchObject({ error: 'mainnet_disabled' });
      expect((await api('POST', `/accounts/${id}/mandate/prepare`, { ...MANDATE, days: 31 })).status).toBe(400);
      expect((await api('POST', `/accounts/${id}/mandate/approve`, { assertion: {}, acknowledged: true })).status).toBe(409);
      const prep = await api('POST', `/accounts/${id}/mandate/prepare`, MANDATE);
      expect(prep.status).toBe(200);
      expect((await api('POST', `/accounts/${id}/mandate/approve`, { assertion: w.pk.assert(b64(prep.json.hash)) })).status).toBe(400);   // `acknowledged: true` is required
      const ok = await api('POST', `/accounts/${id}/mandate/approve`, { assertion: w.pk.assert(b64(prep.json.hash)), acknowledged: true });
      expect(ok.status).toBe(200); expect(ok.json).toMatchObject({ mode: 'MANUAL_LIVE', modes: ['MANUAL_LIVE', 'MANDATE_LIVE'], mandate: { phase: 'active' } });
      expect((await api('GET', `/accounts/${id}/mandate`)).json).toMatchObject({ modes: ['MANUAL_LIVE', 'MANDATE_LIVE'], mandate: { id: prep.json.mandate.mandateId }, signer: { phase: 'active' } });

      // the stream: `halt` is the owner's halt in the first `status` event as in the later ones; `halted` is the effective reason
      await sql`update deriv_accounts set divergence = 'order 9 on hyperliquid:BTC rests on the venue and was not placed by the wallet' where id = ${id}`;
      await app.listen({ port: 0, host: '127.0.0.1' });
      const port = (app.server.address() as { port: number }).port, abort = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}${P}/accounts/${id}/stream`, { headers: { cookie }, signal: abort.signal });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader(), dec = new TextDecoder();
      let buf = '';
      const statuses = async (n: number): Promise<any[]> => {
        for (;;) {
          const found = [...buf.matchAll(/event: status\ndata: (.*)\n\n/g)].map((x) => JSON.parse(x[1]!));
          if (found.length >= n) return found;
          const { value, done } = await reader.read();
          if (done) throw new Error('stream ended');
          buf += dec.decode(value, { stream: true });
        }
      };
      const first = (await statuses(1))[0];
      expect(first).toMatchObject({ mode: 'MANUAL_LIVE', modes: ['MANUAL_LIVE', 'MANDATE_LIVE'], halt: null, divergence: expect.stringMatching(/order 9/) });
      expect(first.halted).toMatch(/the venue's state and the wallet's records differ/);                                  // (the first event used to put this text in `halt`)
      await w.svc.halt(id, { reason: 'stream test' });
      const second = (await statuses(2))[1];
      expect(second.halt).toMatch(/halted by the owner: stream test/); expect(second.halted).toBe(second.halt);
      await w.svc.resume(id);
      const third = (await statuses(3))[2];
      expect(third.halt).toBeNull(); expect(third.halted).toMatch(/records differ/);
      abort.abort();

      const rv = await api('POST', `/accounts/${id}/mandate/revoke`, { locale: 'fr' });
      expect(rv.status).toBe(200); expect(rv.json).toMatchObject({ modes: ['MANUAL_LIVE'], mandate: { phase: 'wind_down' }, cancelled: null, cancelError: null, locale: 'fr' });
    } finally { app.server.closeAllConnections?.(); await app.close(); }
  });
});
