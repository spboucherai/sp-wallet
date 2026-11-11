// Live derivatives, signer side: the trading key, the venue authorization (passkey), and every refusal of /venue/sign.
// No network: prices are injected, nothing is sent to any venue. The mnemonic is the public BIP-39 test vector.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createHlTrading, hlPinnedAssets, jurisdictionAck, recoverTypedDataSigner, venueAuthorizationHash, venueLeverageHash, venueOrderHash,
  type HlL1SignPayload, type HlUserSignPayload, type OrderRequest, type SignRequest, type VenueAuthorization, type VenueLeverage, type VenueOrder,
} from '@spw/derivatives/live';
import { buildUsdClassTransferTypedDataOnly, l1SignPayload } from '../../../packages/derivatives/src/venues/hyperliquid/signing.ts';
import type { Instrument } from '../../../packages/derivatives/src/models.ts';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys, venuePath } from '../src/keys.ts';
import { Signer } from '../src/signer.ts';
import { Store } from '../src/store.ts';

const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const ACCOUNT = keys.addresses.evm.toLowerCase(), AGENT = keys.venueKey('hyperliquid', 'testnet').address;
const ACK = jurisdictionAck('hyperliquid', 'fr').sha256;
let n = 0;
const uuid = () => `7a1c1f0e-8f5f-4b1e-9c56-${String(++n).padStart(12, '0')}`;
const inst = (symbol: string, szDecimals: number): Instrument => ({ venue: 'hyperliquid', symbol, id: `hyperliquid:${symbol}`, base: symbol, quote: 'USD', kind: 'perpetual', collateral: 'USDC', settlement: '',
  tickSize: '0.1', lotSize: szDecimals === 5 ? '0.00001' : szDecimals === 4 ? '0.0001' : '0.01', minOrderSize: null, minNotional: '10', maxLeverage: '40', marginModes: ['cross', 'isolated'], fundingIntervalSec: 3600, markPriceMethod: '', status: 'active' });
const BTC = inst('BTC', 5), ETH = inst('ETH', 4);
const TTL = 90_000;
const trading = createHlTrading({ network: 'testnet', assets: hlPinnedAssets('testnet'), expiresAfterMs: TTL });

async function setup() {
  const t = { now: Math.floor(Date.now() / 1000) };
  const dir = mkdtempSync(join(tmpdir(), 'spw-venue-'));
  const paths = [join(dir, 'state.json'), join(dir, 'policy.json')] as const;
  const store = new Store(...paths);
  store.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
  const px: { BTC: number; ETH: number; fail: string } = { BTC: 70_000, ETH: 2_000, fail: '' };
  const prices = { get: async (syms: string[]) => { if (px.fail) throw new Error(px.fail); return Object.fromEntries(syms.map((s) => [s, (px as unknown as Record<string, number>)[s]!])); } };
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => t.now, prices);
  const pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 'tok' });
  /** the same files opened again by a new process */
  const restart = () => new Signer(keys, new Store(...paths), { rpId: RP, origin: ORIGIN }, () => t.now, prices);
  return { signer, store, pk, t, px, restart };
}
type World = Awaited<ReturnType<typeof setup>>;

const authorization = (now: number, o: Partial<VenueAuthorization> = {}, policy: Partial<VenueAuthorization['policy']> = {}): VenueAuthorization => ({
  v: 1, authorizationId: uuid(), keyId: keys.keyId, venue: 'hyperliquid', network: 'testnet', account: ACCOUNT, agentAddress: AGENT, agentName: 'spw-live', mode: 'MANUAL_LIVE',
  policy: { allowedInstruments: ['hyperliquid:BTC'], maxLeverage: 3, maxOrderNotional: '200', maxPositionNotional: '400', maxGrossExposure: '600', maxOrdersPerDay: 5, maxPriceDeviationBps: 300, ...policy },
  createdAt: now, expiresAt: now + 30 * 86400, approveNonce: now * 1000, ackSha256: ACK, ...o });
async function authorized(w: World, o: Partial<VenueAuthorization> = {}, policy: Partial<VenueAuthorization['policy']> = {}) {
  const a = authorization(w.t.now, o, policy);
  const r = await w.signer.venueAuthorize(a, w.pk.assert(venueAuthorizationHash(a)));
  return { a, r };
}
let nonceSeq = 0;
/** an order as the API builds it: the venue action, the sign request, and the canonical order the owner approves */
function order(w: World, a: VenueAuthorization, o: Partial<OrderRequest> = {}, x: { instrument?: Instrument; nonce?: number; t?: typeof trading } = {}) {
  const instrument = x.instrument ?? BTC, nonce = x.nonce ?? w.t.now * 1000 + ++nonceSeq, t = x.t ?? trading;
  const req: OrderRequest = { instrument: instrument.id, side: 'buy', type: 'limit', size: '0.002', price: '69500', triggerPrice: null, reduceOnly: false, tif: 'gtc', clientId: `k-${nonce}`, ...o };
  const built = t.buildOrder(req, { instrument, nonce }), norm = t.normalizeRequest(req, instrument);
  const canonical: VenueOrder = { v: 1, authorizationId: a.authorizationId, venue: 'hyperliquid', network: a.network, account: a.account, kind: 'order', instrument: norm.instrument, side: norm.side, type: norm.type as VenueOrder['type'],
    size: norm.size, price: norm.price!, triggerPrice: norm.triggerPrice, reduceOnly: norm.reduceOnly, tif: norm.tif, clientId: norm.clientId, nonce, expiresAt: nonce + TTL };
  return { sign: built.sign, action: built.action, canonical, nonce };
}
const send = (w: World, a: VenueAuthorization, b: { sign: SignRequest; canonical?: VenueOrder }, assertion = b.canonical ? w.pk.assert(venueOrderHash(b.canonical)) : undefined) =>
  w.signer.venueSign({ authorizationId: a.authorizationId, sign: b.sign, context: b.canonical ? { order: b.canonical } : undefined, assertion: assertion ?? undefined });
const code = async (p: Promise<unknown>) => { const e = await p.then(() => null, (x) => x); return e ? `${e.code}: ${e.message}` : 'ok'; };
const journal = (w: World, type: string) => w.store.state.journal.filter((j) => j.type === type);

describe('venue trading key', () => {
  it('is a dedicated key per network on its own path — never the wallet key, never a vault key', () => {
    const main = keys.venueKey('hyperliquid', 'mainnet'), test = keys.venueKey('hyperliquid', 'testnet');
    expect(venuePath('hyperliquid', 'mainnet')).toBe("m/44'/60'/9000'/0/0");
    expect(venuePath('hyperliquid', 'testnet')).toBe("m/44'/60'/9000'/0/1");
    expect(main.path).toBe("m/44'/60'/9000'/0/0");
    expect(new Set([main.address, test.address, ACCOUNT, keys.vault(1).address.toLowerCase(), keys.vault(8999).address.toLowerCase()]).size).toBe(5);
    expect(() => keys.vault(9000)).toThrow(/reserved/);          // m/44'/60'/9000'/0/0 would be the mainnet trading key
    expect(() => keys.venueKey('dydx' as never, 'mainnet')).toThrow();
  });
  it('POST /venue/key returns the address, never a key', async () => {
    const w = await setup();
    expect(w.signer.venueKey('hyperliquid', 'testnet')).toEqual({ venue: 'hyperliquid', network: 'testnet', address: AGENT, path: "m/44'/60'/9000'/0/1", account: ACCOUNT });
    expect(() => w.signer.venueKey('gmx', 'mainnet')).toThrow(/unknown venue/);
  });
});

describe('venue authorization (passkey over the canonical authorization)', () => {
  it('the main key signs exactly the approveAgent of the signer\'s own trading key, and the authorization is stored', async () => {
    const w = await setup();
    const { a, r } = await authorized(w);
    const action = r.approve.action as { type: string; agentAddress: string; agentName: string; hyperliquidChain: string; nonce: number };
    expect(action).toMatchObject({ type: 'approveAgent', agentAddress: AGENT, hyperliquidChain: 'Testnet', nonce: a.approveNonce, agentName: `spw-live valid_until ${a.expiresAt * 1000}` });
    // the signature is the MAIN key's, over the typed data of that very action
    const rebuilt = trading.buildApproveAgent({ agentAddress: AGENT, agentName: action.agentName, nonce: a.approveNonce });
    expect(await recoverTypedDataSigner((rebuilt.sign.payload as HlUserSignPayload).typedData, r.approve.signature)).toBe(ACCOUNT);
    expect(r.hash).toBe(Buffer.from(venueAuthorizationHash(a)).toString('hex'));
    const st = w.signer.status().venues;
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ revoked: false, expired: false, hash: r.hash, today: { orders: 0 } });
    expect(journal(w, 'venue.authorized')[0]!.data).toMatchObject({ authorizationId: a.authorizationId, ackSha256: ACK, mode: 'MANUAL_LIVE' });
  });

  it('refuses without the owner\'s passkey, with another passkey, or when anything changed after approval', async () => {
    const w = await setup();
    const a = authorization(w.t.now);
    expect(await code(w.signer.venueAuthorize(a, undefined))).toMatch(/^bad_approval/);
    expect(await code(w.signer.venueAuthorize(a, new TestPasskey(RP, ORIGIN).assert(venueAuthorizationHash(a))))).toMatch(/^unknown_credential/);
    // approved limits 200 → the API asks for 20000 with the same assertion
    const wider = { ...a, policy: { ...a.policy, maxOrderNotional: '20000', maxPositionNotional: '20000', maxGrossExposure: '20000' } };
    expect(await code(w.signer.venueAuthorize(wider, w.pk.assert(venueAuthorizationHash(a))))).toMatch(/^bad_approval/);
    expect(await code(w.signer.venueAuthorize({ ...a, ackSha256: 'ab'.repeat(32) }, w.pk.assert(venueAuthorizationHash({ ...a, ackSha256: 'ab'.repeat(32) }))))).toMatch(/^acknowledgement/);
    expect(w.signer.status().venues).toHaveLength(0);
    expect(journal(w, 'venue.authorize.denied').length).toBe(4);
  });

  it('refuses an account or a trading address that is not the signer\'s own, MANDATE_LIVE, long expiries and unpinned instruments', async () => {
    const w = await setup();
    const tryIt = (o: Partial<VenueAuthorization>, policy: Partial<VenueAuthorization['policy']> = {}) => { const a = authorization(w.t.now, o, policy); return code(w.signer.venueAuthorize(a, w.pk.assert(venueAuthorizationHash(a)))); };
    expect(await tryIt({ account: '0x' + '11'.repeat(20) })).toMatch(/^wrong_source/);
    expect(await tryIt({ agentAddress: '0x' + '22'.repeat(20) })).toMatch(/^wrong_agent/);                       // an attacker's agent address
    expect(await tryIt({ agentAddress: keys.venueKey('hyperliquid', 'mainnet').address })).toMatch(/^wrong_agent/); // the other network's key
    expect(await tryIt({ mode: 'MANDATE_LIVE' })).toMatch(/^unsupported: MANDATE_LIVE/);
    expect(await tryIt({ expiresAt: w.t.now + 91 * 86400 })).toMatch(/at most 90 days/);
    expect(await tryIt({ createdAt: w.t.now - 3600, approveNonce: (w.t.now - 3600) * 1000 })).toMatch(/not current/);
    expect(await tryIt({ keyId: 'spw-0000000000000000' })).toMatch(/^wrong_key/);
    expect(await tryIt({}, { allowedInstruments: ['hyperliquid:DOGE'] })).toMatch(/not in the signer's pinned testnet asset table/);
    expect(await tryIt({}, { allowedInstruments: ['hyperliquid:SOL'], maxLeverage: 15 })).toMatch(/above the venue maximum/);   // SOL is 10x on testnet
    expect(await tryIt({}, { maxOrderNotional: '1000' })).toMatch(/order limit above the position limit/);
    expect(await code(w.signer.venueAuthorize({ ...authorization(w.t.now), extra: 1 }, w.pk.assert(new Uint8Array(32))))).toMatch(/^bad_request/);
    w.signer.halt();
    expect(await tryIt({})).toMatch(/emergency halt/);
  });

  it('one active authorization per venue account; an id is never recorded twice; mainnet and testnet are separate', async () => {
    const w = await setup();
    const { a } = await authorized(w);
    expect(await code(w.signer.venueAuthorize(a, w.pk.assert(venueAuthorizationHash(a))))).toMatch(/^replay/);
    const b = authorization(w.t.now);
    expect(await code(w.signer.venueAuthorize(b, w.pk.assert(venueAuthorizationHash(b))))).toMatch(/^conflict/);
    const m = authorization(w.t.now, { network: 'mainnet', agentAddress: keys.venueKey('hyperliquid', 'mainnet').address });
    const r = await w.signer.venueAuthorize(m, w.pk.assert(venueAuthorizationHash(m)));
    expect((r.approve.action as { hyperliquidChain: string }).hyperliquidChain).toBe('Mainnet');
    w.signer.venueRevoke(a.authorizationId);
    await w.signer.venueAuthorize(b, w.pk.assert(venueAuthorizationHash(b)));                      // after revocation a new one can be approved
  });
});

describe('/venue/sign — orders', () => {
  it('signs an approved order with the trading key and counts it', async () => {
    const w = await setup(), { a } = await authorized(w);
    const o = order(w, a);
    const r = await send(w, a, o);
    expect(r).toMatchObject({ kind: 'order', signer: AGENT, hash: Buffer.from(venueOrderHash(o.canonical)).toString('hex') });
    expect(await recoverTypedDataSigner((o.sign.payload as HlL1SignPayload).typedData, r.signature)).toBe(AGENT);
    expect(w.signer.status().venues[0]).toMatchObject({ lastNonce: o.nonce, today: { orders: 1, cancels: 0 } });
    expect(journal(w, 'venue.sign.ok')[0]!.data).toMatchObject({ kind: 'order', instrument: 'hyperliquid:BTC', side: 'buy', size: '0.002', price: '69500', notional: '139', mid: '70000' });
    // a market order is an IOC limit at its worst price: that is what the owner approves
    const mkt = order(w, a, { type: 'market', tif: 'ioc', price: '70300' });
    expect(mkt.canonical).toMatchObject({ type: 'limit', tif: 'ioc', price: '70300' });
    await send(w, a, mkt);
    // a reduce-only order is not exempt: the signer cannot see positions, so the passkey is required all the same
    const ro = order(w, a, { side: 'sell', reduceOnly: true, type: 'market', tif: 'ioc', price: '69700' });
    expect(await code(send(w, a, ro, null as never))).toMatch(/^bad_approval: MANUAL_LIVE/);
  });

  it('unknown, revoked and expired authorizations sign nothing — a revoked one not even after a restart', async () => {
    const w = await setup(), { a } = await authorized(w);
    expect(await code(w.signer.venueSign({ authorizationId: uuid(), sign: order(w, a).sign }))).toMatch(/^not_found/);
    w.signer.venueRevoke(a.authorizationId);
    expect(await code(send(w, a, order(w, a)))).toMatch(/^revoked/);
    const c = trading.buildCancel({ instrument: BTC, clientId: 'x', nonce: w.t.now * 1000 + 999 });
    expect(await code(send(w, a, { sign: c.sign }))).toMatch(/^revoked/);                               // not even a cancel
    const again = w.restart();
    expect(again.status().venues[0]).toMatchObject({ revoked: true });
    expect(await code(again.venueSign({ authorizationId: a.authorizationId, sign: order(w, a).sign }))).toMatch(/^revoked/);
    expect(() => w.signer.venueRevoke(uuid())).toThrow(/unknown venue authorization/);

    const w2 = await setup(), { a: b } = await authorized(w2, { expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    w2.t.now += 3601;
    expect(await code(send(w2, b, order(w2, b)))).toMatch(/^expired: authorization expired/);
  });

  it('enforces its own stored policy: instrument, notional, daily count', async () => {
    const w = await setup(), { a } = await authorized(w);
    expect(await code(send(w, a, order(w, a, { price: '2000', size: '0.01' }, { instrument: ETH })))).toMatch(/^policy: hyperliquid:ETH is not allowed/);
    expect(await code(send(w, a, order(w, a, { size: '0.003' })))).toMatch(/^policy: order notional 208.5 is above the authorized 200/);
    // a stop far above the limit price is valued at its trigger price
    expect(await code(send(w, a, order(w, a, { type: 'stop_limit', side: 'sell', size: '0.0029', price: '68500', triggerPrice: '69000' })))).toMatch(/order notional 200.1 is above/);
    for (let k = 0; k < 5; k++) await send(w, a, order(w, a));
    expect(await code(send(w, a, order(w, a)))).toMatch(/^policy: daily order count reached/);
    w.t.now += 86400;                                                                                   // the next UTC day
    await send(w, a, order(w, a));
  });

  it('price sanity against the signer\'s own exchange price; no price, no signature', async () => {
    const w = await setup(), { a } = await authorized(w);
    expect(await code(send(w, a, order(w, a, { price: '73000', size: '0.001' })))).toMatch(/^price: price 73000 is more than 300 bps away from the signer's own BTC price 70000/);
    expect(await code(send(w, a, order(w, a, { price: '67000' })))).toMatch(/^price: /);
    expect(await code(send(w, a, order(w, a, { type: 'stop_market', side: 'sell', reduceOnly: true, price: '69000', triggerPrice: '60000' })))).toMatch(/^price: trigger price 60000/);
    w.px.BTC = 35_000;                                                                                  // the API's view and the signer's differ by half
    expect(await code(send(w, a, order(w, a)))).toMatch(/^price: /);
    w.px.fail = 'price sources disagree on BTC';
    expect(await code(send(w, a, order(w, a)))).toMatch(/^no_price: .*price sources disagree/);
    expect(w.signer.status().venues[0]!.today.orders).toBe(0);
  });

  it('replayed client id, stale nonce, expired or over-long window', async () => {
    const w = await setup(), { a } = await authorized(w);
    const first = order(w, a, { clientId: 'same-key' });
    await send(w, a, first);
    expect(await code(send(w, a, first))).toMatch(/^stale_nonce/);                                      // the very same request again
    expect(await code(send(w, a, order(w, a, { clientId: 'same-key' })))).toMatch(/^replay: an order with this client id/);
    expect(await code(send(w, a, order(w, a, { clientId: 'reuse' }, { nonce: first.nonce })))).toMatch(/^stale_nonce: nonce already used/);
    expect(await code(send(w, a, order(w, a, {}, { nonce: w.t.now * 1000 - 200_000 })))).toMatch(/^expired|^stale_nonce: nonce is stale/);
    // the venue's rule: once 100 nonces are stored, anything at or below the lowest of them is refused; in between is fine
    const big = await setup(), { a: b2 } = await authorized(big, {}, { maxOrdersPerDay: 500 });
    const base = big.t.now * 1000;
    for (let k = 0; k < 100; k++) await send(big, b2, { sign: trading.buildCancel({ instrument: BTC, venueOrderId: String(k + 1), nonce: base + 100 + 2 * k }).sign });
    expect(await code(send(big, b2, order(big, b2, {}, { nonce: base + 100 })))).toMatch(/^stale_nonce: nonce already used/);
    expect(await code(send(big, b2, order(big, b2, {}, { nonce: base + 50 })))).toMatch(/^stale_nonce: nonce is below the lowest/);
    await send(big, b2, order(big, b2, {}, { nonce: base + 101 }));                                     // unused, above the lowest: out of order is allowed
    expect(await code(send(w, a, order(w, a, {}, { nonce: w.t.now * 1000 + 120_000 })))).toMatch(/^policy: nonce is dated in the future/);
    const long = createHlTrading({ network: 'testnet', assets: hlPinnedAssets('testnet'), expiresAfterMs: 600_000 });
    const o = order(w, a, {}, { t: long }); o.canonical.expiresAt = o.nonce + 600_000;
    expect(await code(send(w, a, o))).toMatch(/^policy: validity window longer than 120 s/);
    const never = createHlTrading({ network: 'testnet', assets: hlPinnedAssets('testnet') });
    expect(await code(send(w, a, order(w, a, {}, { t: never })))).toMatch(/^policy: the action carries no venue expiry/);
    // the approval window passes between proposal and approval
    const late = order(w, a);
    w.t.now += 200;
    expect(await code(send(w, a, late))).toMatch(/^expired: approval window expired/);
  });

  it('missing or wrong passkey assertion', async () => {
    const w = await setup(), { a } = await authorized(w);
    const o = order(w, a);
    expect(await code(send(w, a, o, null as never))).toMatch(/^bad_approval: MANUAL_LIVE/);
    expect(await code(send(w, a, o, new TestPasskey(RP, ORIGIN).assert(venueOrderHash(o.canonical))))).toMatch(/^unknown_credential/);
    expect(await code(send(w, a, o, w.pk.assert(venueOrderHash({ ...o.canonical, size: '0.001' }))))).toMatch(/^bad_approval/);   // an assertion made for another order
    expect(await code(send(w, a, o, w.pk.assert(venueOrderHash(o.canonical), { origin: 'https://evil.test' })))).toMatch(/^bad_approval/);
    expect(await code(send(w, a, o, w.pk.assert(venueOrderHash(o.canonical), { uv: false })))).toMatch(/^bad_approval/);
    expect(w.signer.status().venues[0]!.today.orders).toBe(0);
    await send(w, a, o);                                                                                // nothing above consumed the order
  });

  it('an action tampered after the approval is refused, whichever side is changed', async () => {
    const w = await setup(), { a } = await authorized(w);
    const shown = order(w, a, { size: '0.001' });
    const assertion = w.pk.assert(venueOrderHash(shown.canonical));
    // (a) the payload is swapped for a larger order, the approved context is kept
    const bigger = order(w, a, { size: '0.0028', clientId: 'k-swap' }, { nonce: shown.nonce });
    expect(await code(w.signer.venueSign({ authorizationId: a.authorizationId, sign: bigger.sign, context: { order: shown.canonical }, assertion }))).toMatch(/^mismatch: .*\(size\)/);
    // (b) the context is changed to match the swapped payload: the assertion no longer covers it
    expect(await code(w.signer.venueSign({ authorizationId: a.authorizationId, sign: bigger.sign, context: { order: bigger.canonical }, assertion: w.pk.assert(venueOrderHash(shown.canonical)) }))).toMatch(/^bad_approval/);
    // (c) side, price, reduce-only, client id
    for (const [field, change] of [['side', { side: 'sell' }], ['price', { price: '69600' }], ['reduce-only', { reduceOnly: true }], ['time in force', { tif: 'alo' }], ['client id', { clientId: 'other' }]] as const) {
      const t2 = order(w, a, { size: '0.001', clientId: field === 'client id' ? 'other' : `k-${shown.nonce}`, ...change }, { nonce: shown.nonce });
      expect(await code(w.signer.venueSign({ authorizationId: a.authorizationId, sign: t2.sign, context: { order: shown.canonical }, assertion: w.pk.assert(venueOrderHash(shown.canonical)) }))).toMatch(new RegExp(`^mismatch: .*\\(${field}\\)`));
    }
    // (d) the typed data no longer matches the action (hash of another action)
    const forged = structuredClone(shown.sign) as SignRequest & { payload: HlL1SignPayload };
    (forged.payload.action as { orders: { s: string }[] }).orders[0]!.s = '0.002';
    expect(await code(w.signer.venueSign({ authorizationId: a.authorizationId, sign: forged, context: { order: shown.canonical }, assertion: w.pk.assert(venueOrderHash(shown.canonical)) }))).toMatch(/^rejected: .*typed data does not match/);
    // (e) two orders in one action
    const two = structuredClone(shown.action); two.orders.push({ ...two.orders[0]!, c: undefined as never }); delete (two.orders[1] as { c?: string }).c;
    const td = l1SignPayload(two as never, { network: 'testnet', nonce: shown.nonce, expiresAfter: shown.nonce + TTL }).typedData;
    expect(await code(w.signer.venueSign({ authorizationId: a.authorizationId, sign: { venue: 'hyperliquid', network: 'testnet', kind: 'hl_l1', payload: { scheme: 'l1', action: two, nonce: shown.nonce, vaultAddress: null, expiresAfter: shown.nonce + TTL, typedData: td } },
      context: { order: shown.canonical }, assertion: w.pk.assert(venueOrderHash(shown.canonical)) }))).toMatch(/^unsupported: exactly one order/);
    expect(w.signer.status().venues[0]!.today.orders).toBe(0);
  });

  it('anything that is not an order, a cancel or a leverage change is refused: `other`, a smuggled approveAgent, a transfer', async () => {
    const w = await setup(), { a } = await authorized(w);
    const nonce = w.t.now * 1000 + 50, exp = nonce + TTL;
    const l1 = (action: Record<string, unknown>, vault: string | null = null): SignRequest => ({ venue: 'hyperliquid', network: 'testnet', kind: 'hl_l1',
      payload: { scheme: 'l1', action, nonce, vaultAddress: vault, expiresAfter: exp, typedData: l1SignPayload(action as never, { network: 'testnet', nonce, vaultAddress: vault, expiresAfter: exp }).typedData } });
    const tryIt = (sign: SignRequest) => code(w.signer.venueSign({ authorizationId: a.authorizationId, sign, context: {}, assertion: w.pk.assert(new Uint8Array(32)) }));
    // correctly hashed L1 actions that an agent key COULD sign on the venue
    expect(await tryIt(l1({ type: 'vaultTransfer', vaultAddress: '0x' + 'aa'.repeat(20), isDeposit: true, usd: 1000000 }))).toMatch(/^unsupported: this payload is not an order.*vaultTransfer/);
    expect(await tryIt(l1({ type: 'agentSendAsset', destination: ACCOUNT, sourceDex: '', destinationDex: 'spot', token: 'USDC', amount: '10' }))).toMatch(/^unsupported: .*agentSendAsset/);
    expect(await tryIt(l1({ type: 'subAccountTransfer', subAccountUser: '0x' + 'bb'.repeat(20), isDeposit: true, usd: 5 }))).toMatch(/^unsupported/);
    expect(await tryIt(l1({ type: 'updateIsolatedMargin', asset: 3, isBuy: true, ntli: 1 }))).toMatch(/^unsupported/);
    expect(await tryIt(l1({ type: 'scheduleCancel' }))).toMatch(/^unsupported/);
    // an agent approval for an attacker's address, as a user-signed request and dressed up as an L1 action
    const evil = trading.buildApproveAgent({ agentAddress: '0x' + '66'.repeat(20), agentName: 'evil', nonce });
    expect(await tryIt(evil.sign)).toMatch(/^unsupported: an agent approval can only be signed through \/venue\/authorize/);
    expect(await tryIt(l1(evil.action as never))).toMatch(/^unsupported: .*approveAgent/);
    // a user-signed transfer (spot ⇄ perp) and a withdrawal-shaped request
    const xfer = buildUsdClassTransferTypedDataOnly({ network: 'testnet', amount: '25', toPerp: false, nonce });
    expect(await tryIt({ venue: 'hyperliquid', network: 'testnet', kind: 'hl_user', payload: { scheme: 'user', action: xfer.action, typedData: xfer.typedData } })).toMatch(/^unsupported: this payload is not an order.*usdClassTransfer/);
    expect(await tryIt({ venue: 'hyperliquid', network: 'testnet', kind: 'raw', payload: { hash: '0x' + '00'.repeat(32) } })).toMatch(/^rejected: .*unknown sign request kind/);
    // an order on behalf of a vault / sub-account, a builder fee, a mainnet payload under a testnet authorization
    const o = order(w, a);
    expect(await tryIt(l1(o.action as never, '0x' + 'cc'.repeat(20)))).toMatch(/^unsupported: sub-accounts and vaults/);
    expect(await tryIt(l1({ ...o.action, builder: { b: '0x' + 'dd'.repeat(20), f: 10 } }))).toMatch(/^rejected/);
    const main = createHlTrading({ network: 'mainnet', assets: hlPinnedAssets('mainnet'), expiresAfterMs: TTL }).buildOrder({ instrument: 'hyperliquid:BTC', side: 'buy', type: 'limit', size: '0.001', price: '69500', triggerPrice: null, reduceOnly: false, tif: 'gtc', clientId: 'm' }, { instrument: BTC, nonce });
    expect(await tryIt(main.sign)).toMatch(/^wrong_venue/);
    expect(await tryIt({ ...main.sign, network: 'testnet' })).toMatch(/^rejected: .*typed data does not match/);   // relabelled: the phantom agent is the mainnet one
    expect(journal(w, 'venue.sign.ok')).toHaveLength(0);
  });

  it('asset table: the signer reads indices through its own pinned table, not the API\'s', async () => {
    const w = await setup(), { a } = await authorized(w);
    // the API (or a changed venue) numbers BTC as 0 — on testnet the pinned table says index 0 is SOL
    const wrongTable = createHlTrading({ network: 'testnet', assets: [{ symbol: 'BTC', asset: 0, szDecimals: 5, maxLeverage: 40, isolatedOnly: false, delisted: false }], expiresAfterMs: TTL });
    const o = order(w, a, { price: '69500', size: '0.01' }, { t: wrongTable });
    expect(await code(send(w, a, o))).toMatch(/^mismatch: .*\(instrument\)/);                             // the owner approved "BTC", the payload trades SOL
    const sizeOnSol = order(w, a, { size: '0.00123' }, { t: wrongTable });
    expect(await code(send(w, a, sizeOnSol))).toMatch(/^rejected: .*not valid for SOL/);                   // 5 decimals of size do not exist on SOL
    const unknown = createHlTrading({ network: 'testnet', assets: [{ symbol: 'BTC', asset: 77, szDecimals: 5, maxLeverage: 40, isolatedOnly: false, delisted: false }], expiresAfterMs: TTL });
    expect(await code(send(w, a, order(w, a, {}, { t: unknown })))).toMatch(/^rejected: .*asset 77, which is not in the testnet asset table/);
  });

  it('emergency halt stops orders and leverage changes; cancels are still signed', async () => {
    const w = await setup(), { a } = await authorized(w);
    w.signer.halt();
    expect(await code(send(w, a, order(w, a)))).toMatch(/^policy: emergency halt/);
    const c = trading.buildCancel({ instrument: BTC, clientId: 'k-1', nonce: w.t.now * 1000 + 500 });
    expect((await send(w, a, { sign: c.sign })).kind).toBe('cancel');
  });
});

describe('/venue/sign — cancels and leverage', () => {
  it('a cancel needs no passkey, but must be for an allowed instrument and a fresh nonce', async () => {
    const w = await setup(), { a } = await authorized(w);
    const byCloid = trading.buildCancel({ instrument: BTC, clientId: 'k-1', nonce: w.t.now * 1000 + 1 });
    const r = await send(w, a, { sign: byCloid.sign });
    expect(r.kind).toBe('cancel');
    expect(await recoverTypedDataSigner((byCloid.sign.payload as HlL1SignPayload).typedData, r.signature)).toBe(AGENT);
    await send(w, a, { sign: trading.buildCancel({ instrument: BTC, venueOrderId: '123456', nonce: w.t.now * 1000 + 2 }).sign });
    expect(await code(send(w, a, { sign: trading.buildCancel({ instrument: ETH, venueOrderId: '9', nonce: w.t.now * 1000 + 3 }).sign }))).toMatch(/^policy: hyperliquid:ETH is not allowed/);
    expect(await code(send(w, a, { sign: byCloid.sign }))).toMatch(/^stale_nonce/);
    expect(w.signer.status().venues[0]!.today).toEqual({ orders: 0, cancels: 2, leverage: 0 });
  });

  it('a leverage change needs the passkey over its canonical form and stays at or below the authorized maximum', async () => {
    const w = await setup(), { a } = await authorized(w);
    const lev = (leverage: number, marginMode: 'cross' | 'isolated' = 'cross') => {
      const nonce = w.t.now * 1000 + ++nonceSeq, b = trading.buildUpdateLeverage({ instrument: BTC, leverage, marginMode, nonce });
      const canonical: VenueLeverage = { v: 1, authorizationId: a.authorizationId, venue: 'hyperliquid', network: 'testnet', account: ACCOUNT, kind: 'leverage', instrument: BTC.id, leverage, marginMode, nonce, expiresAt: nonce + TTL };
      return { sign: b.sign, canonical };
    };
    const go = (x: ReturnType<typeof lev>, canonical = x.canonical, assertion: unknown = w.pk.assert(venueLeverageHash(canonical))) =>
      code(w.signer.venueSign({ authorizationId: a.authorizationId, sign: x.sign, context: { leverage: canonical }, assertion: assertion as never }));
    expect(await go(lev(3))).toBe('ok');
    expect(await go(lev(4))).toMatch(/^policy: leverage 4 is above the authorized 3/);
    expect(await go(lev(2), undefined, null)).toMatch(/^bad_approval: MANUAL_LIVE/);
    const shown = lev(2), sent = lev(3);
    expect(await go(sent, { ...shown.canonical, nonce: sent.canonical.nonce, expiresAt: sent.canonical.expiresAt })).toMatch(/^mismatch/);   // shows 2x, signs 3x
    expect(await go(lev(2, 'isolated'), { ...lev(2, 'isolated').canonical })).toMatch(/^mismatch/);                                          // context of another nonce
    expect(w.signer.status().venues[0]!.today.leverage).toBe(1);
  });
});
