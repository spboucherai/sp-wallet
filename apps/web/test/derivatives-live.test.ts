/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/test/derivatives-live.test.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-17
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

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { assetsAtLeverage, buildLive, canonicalProblem, clock, closeProblem, defaultPolicyForm, policyFormOf, inFlight, isUnfunded, liveError, newKey, policyFromForm, remainingMs, samePolicy, sha256Hex, toneOf, venueWords,
  type LiveConfig, type LiveDetail, type LiveOrder, type LiveOrderBody, type VenueOrder } from '../src/derivatives/live.ts';
import { applyLiveEvent, mergeOrder } from '../src/derivatives/liveStore.ts';

const BTC = { id: 'hyperliquid:BTC', venue: 'hyperliquid' as const, tickSize: '0.1', lotSize: '0.00001' };
const BOUNDS: LiveConfig['bounds'] = { maxLeverage: 20, maxOrdersPerDay: 500, minPriceBandBps: 10, maxPriceBandBps: 2000, maxInstruments: 8, maxAuthorizationDays: 90, orderApprovalTtlMs: 90_000 };
const PINNED = [{ instrument: 'hyperliquid:BTC', maxLeverage: 40 }, { instrument: 'hyperliquid:ETH', maxLeverage: 25 }, { instrument: 'hyperliquid:SOL', maxLeverage: 10 }];
const canonical = (o: Partial<VenueOrder> = {}): VenueOrder => ({ v: 1, authorizationId: '5f0c2c1e-8f1a-4d59-9a39-0d7a54a1b111', venue: 'hyperliquid', network: 'testnet', account: `0x${'ab'.repeat(20)}`, kind: 'order', instrument: 'hyperliquid:BTC', side: 'buy',
  type: 'limit', size: '0.001', price: '73000', triggerPrice: null, reduceOnly: false, tif: 'gtc', clientId: `0x${'0'.repeat(32)}`, nonce: 1_800_000_000_000, expiresAt: 1_800_000_090_000, ...o });
const form = { side: 'buy' as const, kind: 'limit' as const, size: '', price: '', trigger: '', reduceOnly: false, postOnly: false };

describe('order form → live order body', () => {
  it('sends sizes and prices as the decimal strings that were typed, put on the grid — never through a float', () => {
    const { body } = buildLive({ ...form, size: '0,1', price: '73 000,5' }, BTC);
    expect(body).toEqual({ instrument: 'hyperliquid:BTC', side: 'buy', type: 'limit', size: '0.1', price: '73000', triggerPrice: null, reduceOnly: false, tif: 'gtc' });   // 5 significant figures on Hyperliquid: 73000.5 → 73000
    // 0.1 + 0.2 in floats is 0.30000000000000004: a decimal string never is
    expect(buildLive({ ...form, size: '0.30000000000000004', price: '100' }, BTC).body!.size).toBe('0.3');
    expect(buildLive({ ...form, size: '0.123456789', price: '100' }, BTC).body!.size).toBe('0.12345');                   // rounded DOWN to the lot
    expect(buildLive({ ...form, size: '12345678901234567890.123456', price: '1' }, BTC).body!.size).toBe('12345678901234567890.12345');   // beyond double precision
    expect(typeof buildLive({ ...form, size: '1', price: '2' }, BTC).body!.size).toBe('string');
  });
  it('a market order carries no price (the server derives the worst price from the venue\'s book) and no leverage', () => {
    const { body } = buildLive({ ...form, kind: 'market', size: '0.002' }, BTC);
    expect(body).toEqual({ instrument: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.002', price: null, triggerPrice: null, reduceOnly: false, tif: 'ioc', slippageBps: 50 });
    expect(body).not.toHaveProperty('leverage');
    expect(body).not.toHaveProperty('clientId');
  });
  it('a stop carries its trigger and a worst price inside the bound; post-only is alo', () => {
    const stop = buildLive({ ...form, side: 'sell', kind: 'stop', size: '0.01', trigger: '70000' }, BTC).body!;
    expect(stop.type).toBe('stop_market'); expect(stop.triggerPrice).toBe('70000'); expect(stop.price).toBe('69650');   // 50 bps below, on the grid
    expect(buildLive({ ...form, size: '0.01', price: '70000', postOnly: true }, BTC).body!.tif).toBe('alo');
  });
  it('says what is missing instead of building something', () => {
    expect(buildLive({ ...form, size: '0.01' }, BTC)).toEqual({ body: null, problem: null });                            // nothing typed yet: no reproach
    expect(buildLive({ ...form, size: '0.01', price: 'abc' }, BTC).problem).toBe('fxErrPrice');
    expect(buildLive({ ...form, size: '0.000001', price: '70000' }, BTC).problem).toBe('fxErrSizeSmall');
    expect(buildLive({ ...form, size: 'x', price: '70000' }, BTC).problem).toBe('fxErrSize');
    expect(buildLive({ ...form, size: '1', price: '1' }, { ...BTC, lotSize: '0' }).problem).toBe('fxErrInstrument');
  });
});

describe('what the passkey signs must be what was asked for', () => {
  const body: LiveOrderBody = { instrument: 'hyperliquid:BTC', side: 'buy', type: 'limit', size: '0.001', price: '73000', triggerPrice: null, reduceOnly: false, tif: 'gtc' };
  it('accepts the canonical form of the same order', () => {
    expect(canonicalProblem(body, canonical())).toBeNull();
    expect(canonicalProblem({ ...body, size: '0.0010' }, canonical())).toBeNull();                                        // same decimal, other spelling
    // a market order is sent as a limit IOC at its worst price
    expect(canonicalProblem({ ...body, type: 'market', price: null, tif: 'ioc', slippageBps: 50 }, canonical({ type: 'limit', tif: 'ioc', price: '73365' }))).toBeNull();
  });
  it('names the first field that differs', () => {
    expect(canonicalProblem(body, null)).toBe('canonical');
    expect(canonicalProblem(body, canonical({ instrument: 'hyperliquid:ETH' }))).toBe('instrument');
    expect(canonicalProblem(body, canonical({ side: 'sell' }))).toBe('side');
    expect(canonicalProblem(body, canonical({ size: '0.01' }))).toBe('size');
    expect(canonicalProblem(body, canonical({ price: '73001' }))).toBe('price');
    expect(canonicalProblem(body, canonical({ reduceOnly: true }))).toBe('reduceOnly');
    expect(canonicalProblem(body, canonical({ tif: 'ioc' }))).toBe('tif');
    expect(canonicalProblem(body, canonical({ type: 'stop_market', triggerPrice: '70000' }))).toBe('type');
    expect(canonicalProblem(body, canonical({ triggerPrice: '70000' }))).toBe('triggerPrice');
    expect(canonicalProblem({ ...body, type: 'market', price: null }, canonical({ tif: 'gtc' }))).toBe('tif');           // a "market" order that would rest
  });
  it('a close is reduce-only, IOC, on the reducing side, and never larger than the position', () => {
    const pos = { instrument: 'hyperliquid:BTC', side: 'long' as const, size: '0.002' };
    const c = canonical({ side: 'sell', reduceOnly: true, tif: 'ioc', size: '0.002', price: '72000' });
    expect(closeProblem(pos, c)).toBeNull();
    expect(closeProblem(pos, { ...c, size: '0.001' })).toBeNull();
    expect(closeProblem(pos, { ...c, size: '0.003' })).toBe('size');
    expect(closeProblem(pos, { ...c, side: 'buy' })).toBe('side');
    expect(closeProblem(pos, { ...c, reduceOnly: false })).toBe('reduceOnly');
    expect(closeProblem(pos, { ...c, tif: 'gtc' })).toBe('type');
    expect(closeProblem({ ...pos, side: 'short' }, c)).toBe('side');
    expect(closeProblem(pos, null)).toBe('canonical');
  });
});

describe('approval window', () => {
  it('stops three seconds before the server\'s expiry, and corrects the local clock', () => {
    expect(remainingMs(100_000, 10_000)).toBe(87_000);
    expect(remainingMs(100_000, 97_000)).toBe(0);
    expect(remainingMs(100_000, 99_999)).toBe(0);
    expect(remainingMs(null, 0)).toBe(0);
    expect(remainingMs(100_000, 30_000, 20_000)).toBe(87_000);                                                            // this clock runs 20 s ahead of the server's
    expect(clock(87_000)).toBe('1:27'); expect(clock(4_100)).toBe('0:05'); expect(clock(0)).toBe('0:00');
  });
  it('one key per review, in the shape the server accepts', () => {
    const a = newKey('order'), b = newKey('order');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9._:-]{8,100}$/);
  });
});

describe('authorization limits', () => {
  it('the defaults are valid, cautious, and differ by network only in the price band', () => {
    for (const n of ['testnet', 'mainnet'] as const) {
      const r = policyFromForm(defaultPolicyForm(n, PINNED), BOUNDS, PINNED);
      expect(r.ok).toBe(true);
      // 2026-11-17: the default is « all assets » — every pinned instrument the leverage allows (was BTC alone)
      if (r.ok) { expect(r.policy.allowedInstruments).toEqual(PINNED.map((p) => p.instrument)); expect(r.policy.maxLeverage).toBe(2); expect(r.days).toBe(7); expect(r.policy.maxPriceDeviationBps).toBe(n === 'testnet' ? 1000 : 200); expect(r.policy.maxOrderNotional).toBe('50'); }
    }
  });
  it('refuses what the server would refuse, with the reason', () => {
    // the instrument checks are those of the « choose » mode (the ticked list); « all assets » is covered below
    const f = { ...defaultPolicyForm('testnet', PINNED), scope: 'choose' as const }, bad = (patch: Partial<typeof f>) => { const r = policyFromForm({ ...f, ...patch }, BOUNDS, PINNED); return r.ok ? null : r.problem; };
    expect(bad({ instruments: [] })).toBe('instruments');
    expect(bad({ instruments: ['hyperliquid:DOGE'] })).toBe('instruments');                                              // not pinned: cannot be allowed
    expect(bad({ maxLeverage: '0' })).toBe('leverage'); expect(bad({ maxLeverage: '21' })).toBe('leverage'); expect(bad({ maxLeverage: '2.5' })).toBe('leverage');
    expect(bad({ instruments: ['hyperliquid:SOL'], maxLeverage: '15' })).toBe('leverageVenue');                           // above SOL's venue maximum
    expect(bad({ maxOrderNotional: '0' })).toBe('order'); expect(bad({ maxOrderNotional: '' })).toBe('order');
    expect(bad({ maxOrderNotional: '200' })).toBe('orderAbovePosition');
    expect(bad({ maxPositionNotional: '200' })).toBe('positionAboveGross');
    expect(bad({ maxOrdersPerDay: '501' })).toBe('ordersPerDay');
    expect(bad({ bandBps: '5' })).toBe('band'); expect(bad({ bandBps: '2001' })).toBe('band');
    expect(bad({ days: '91' })).toBe('days'); expect(bad({ days: '0' })).toBe('days');
    const ok = policyFromForm({ ...f, maxOrderNotional: '1 234,50', maxPositionNotional: '2000', maxGrossExposure: '3000' }, BOUNDS, PINNED);
    expect(ok.ok && ok.policy.maxOrderNotional).toBe('1234.5');                                                           // French input → canonical decimal string
  });
  it('« all assets » = every pinned instrument whose venue maximum is at least the leverage; the others are left out and named', () => {
    const all = (lev: string) => { const r = policyFromForm({ ...defaultPolicyForm('mainnet', PINNED), maxLeverage: lev }, BOUNDS, PINNED); return r.ok ? r.policy.allowedInstruments : r.problem; };
    expect(all('2')).toEqual(PINNED.map((p) => p.instrument));
    const max = Math.max(...PINNED.map((p) => p.maxLeverage)), min = Math.min(...PINNED.map((p) => p.maxLeverage)), mid = Math.min(max, BOUNDS.maxLeverage);
    expect(max).toBeGreaterThan(min);                                                                                      // the fixture has assets with different maxima
    const split = assetsAtLeverage(PINNED, String(min + 1));
    expect(split.leftOut.map((p) => p.instrument)).toEqual(PINNED.filter((p) => p.maxLeverage <= min).map((p) => p.instrument));
    expect(split.allowed.length + split.leftOut.length).toBe(PINNED.length);
    expect(all(String(min + 1))).toEqual(split.allowed.map((p) => p.instrument));                                          // the policy carries exactly the assets the form announced
    expect(all(String(mid))).toEqual(PINNED.filter((p) => p.maxLeverage >= mid).map((p) => p.instrument));
    expect(all('0')).toBe('leverage'); expect(all('abc')).toBe('leverage');                                                 // « all » is defined by the leverage: a wrong leverage is said first
    expect(assetsAtLeverage(PINNED, 'abc').leftOut).toEqual([]);
    // every asset of an « all » policy passes the signer's rule: the one leverage never exceeds an allowed asset's venue maximum
    for (const lev of [1, 2, 3, 5, 10, 20]) { const s = assetsAtLeverage(PINNED, lev); expect(s.allowed.every((p) => p.maxLeverage >= lev)).toBe(true); expect(s.leftOut.every((p) => p.maxLeverage < lev)).toBe(true); }
  });
  it('the form that changes an authorization starts from its own limits, and knows whether its list was « all »', () => {
    const base = { maxLeverage: 2, maxOrderNotional: '50', maxPositionNotional: '100', maxGrossExposure: '150', maxOrdersPerDay: 20, maxPriceDeviationBps: 200 };
    const one = policyFormOf({ ...base, allowedInstruments: ['hyperliquid:BTC'] }, 'mainnet', PINNED);
    expect(one.scope).toBe('choose'); expect(one.instruments).toEqual(['hyperliquid:BTC']); expect(one.maxLeverage).toBe('2'); expect(one.maxOrderNotional).toBe('50'); expect(one.bandBps).toBe('200');
    const every = policyFormOf({ ...base, allowedInstruments: PINNED.map((p) => p.instrument) }, 'mainnet', PINNED);
    expect(every.scope).toBe('all');
    const again = policyFromForm({ ...one, scope: 'all' }, BOUNDS, PINNED);                                                 // BTC alone → all assets, same limits
    expect(again.ok && again.policy).toEqual({ ...base, allowedInstruments: PINNED.map((p) => p.instrument) });
    expect(policyFormOf({ ...base, allowedInstruments: ['hyperliquid:GONE', 'hyperliquid:BTC'] }, 'mainnet', PINNED).instruments).toEqual(['hyperliquid:BTC']);   // an asset no longer pinned is dropped
  });
  it('compares the limits the server prepared with those asked for', () => {
    const p = { allowedInstruments: ['hyperliquid:BTC', 'hyperliquid:ETH'], maxLeverage: 2, maxOrderNotional: '50', maxPositionNotional: '100', maxGrossExposure: '150', maxOrdersPerDay: 20, maxPriceDeviationBps: 1000 };
    expect(samePolicy(p, { ...p, allowedInstruments: ['hyperliquid:ETH', 'hyperliquid:BTC'], maxOrderNotional: '50.0' })).toBe(true);
    expect(samePolicy(p, { ...p, maxOrderNotional: '500' })).toBe(false);
    expect(samePolicy(p, { ...p, allowedInstruments: ['hyperliquid:BTC'] })).toBe(false);
    expect(samePolicy(p, { ...p, maxPriceDeviationBps: 2000 })).toBe(false);
  });
  it('hashes the acknowledgement text as displayed', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex('é')).not.toBe(await sha256Hex('e'));
  });
});

describe('errors: which sentence, and what may be offered next', () => {
  const api = (status: number, code: string, message = 'details from the server') => new ApiError(status, code, message);
  it('halted is two moments', () => {
    expect(liveError(api(422, 'halted'), 'propose')).toMatchObject({ key: 'halted', consumed: true, retry: false });
    expect(liveError(api(423, 'halted'), 'approve')).toMatchObject({ key: 'halted_423', consumed: true, retry: false });
  });
  it('a signer refusal or an expiry consumes the proposal; only a lost answer is sent again', () => {
    for (const c of ['signer_price', 'signer_no_price', 'signer_bad_approval', 'signer_unknown_credential', 'signer_policy', 'signer_mismatch', 'signer_expired', 'signer_revoked', 'signer_stale_nonce', 'signer_replay'])
      expect(liveError(api(422, c), 'approve')).toMatchObject({ key: c, consumed: true, retry: false });
    expect(liveError(api(422, 'signer_something_new'), 'approve')).toMatchObject({ key: 'signer_other', code: 'signer_something_new', consumed: true });
    expect(liveError(api(410, 'proposal_expired'), 'approve')).toMatchObject({ key: 'proposal_expired', consumed: true, retry: false });
    expect(liveError(api(503, 'signer_unreachable'), 'approve')).toMatchObject({ key: 'signer_unreachable', consumed: true, retry: false });   // the server marked the order "not signed"
    expect(liveError(api(0, 'offline', 'offline'), 'approve')).toMatchObject({ key: 'offline', consumed: false, retry: true });
    expect(liveError(api(500, 'error', 'error'), 'approve')).toMatchObject({ key: 'other', consumed: false, retry: true, detail: '' });
  });
  it('at proposal a 422 is stored under the key; a transport failure may be retried with the same key', () => {
    expect(liveError(api(422, 'price_deviation'), 'propose')).toMatchObject({ key: 'other', code: 'price_deviation', consumed: true, retry: false });   // a risk code: its sentence is `rk_price_deviation`
    expect(liveError(api(503, 'venue_unavailable'), 'propose')).toMatchObject({ key: 'venue_unavailable', consumed: false, retry: true });
    expect(liveError(api(503, 'asset_table_mismatch'), 'propose')).toMatchObject({ key: 'asset_table_mismatch', consumed: false, retry: false });
    expect(liveError(api(403, 'mainnet_disabled'), 'propose')).toMatchObject({ key: 'mainnet_disabled', status: 403, consumed: false, retry: false });
  });
  it('a dismissed passkey prompt is not an error of the server', () => {
    const e = Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' });
    expect(liveError(e, 'approve')).toMatchObject({ key: 'passkey_cancelled', consumed: true, retry: false });
    expect(liveError(new Error('boom'), 'approve')).toMatchObject({ key: 'passkey_failed', consumed: true });
  });
  it('extracts the venue\'s own words from the API message', () => {
    const m = 'the venue did not register the trading key: Must deposit before performing actions. User: 0xe06252f11d8beac14b7f8a026dd02febdba1400f — the authorization was revoked on the signer, nothing can trade. Fund the venue account first if the venue asks for a deposit, then prepare a new authorization.';
    expect(venueWords(m)).toBe('Must deposit before performing actions. User: 0xe06252f11d8beac14b7f8a026dd02febdba1400f');
    expect(isUnfunded(m)).toBe(true);
    expect(venueWords('something else entirely')).toBe('something else entirely');
    expect(isUnfunded('Order has invalid price.')).toBe(false);
  });
  it('every code has a French and an English sentence', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/i18n.ts'), 'utf8');
    const live = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/derivatives/live.ts'), 'utf8');
    const known = [...live.slice(live.indexOf('const KNOWN = new Set(['), live.indexOf(']);', live.indexOf('const KNOWN = new Set(['))).matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]!);
    expect(known.length).toBeGreaterThan(40);
    const need = [...known.map((c) => `flE_${c}`), 'flE_halted_423', 'flE_signer_other', 'flE_other', 'flE_passkey_cancelled', 'flE_passkey_failed', 'flE_canonical_mismatch',
      ...['proposed', 'risk_checked', 'authorized', 'signed', 'submitted', 'unknown', 'open', 'partially_filled', 'filled', 'cancelled', 'rejected'].flatMap((s) => [`flSt_${s}`, `flOut_${s}`]), 'flOut_partially_filled_final',
      'flTif_gtc', 'flTif_ioc', 'flTif_alo', 'flLev_confirmed', 'flLev_rejected', 'flLev_unknown', 'flToneSim', 'flToneTestnet', 'flToneReal',
      ...['instruments', 'tooManyInstruments', 'leverage', 'leverageVenue', 'order', 'position', 'gross', 'orderAbovePosition', 'positionAboveGross', 'ordersPerDay', 'band', 'days'].map((p) => `flPol_${p}`)];
    for (const k of need) { const m = new RegExp(`\\b${k}: \\['([^']+)',\\s*'([^']+)'\\]`).exec(src); expect(m, k).not.toBeNull(); expect(m![1]!.length, k).toBeGreaterThan(3); expect(m![2]!.length, k).toBeGreaterThan(3); }
    // the three labels can never be confused with each other, in either language
    const tone = (k: string) => new RegExp(`\\b${k}: \\['([^']+)',\\s*'([^']+)'\\]`).exec(src)!;
    expect(tone('flToneTestnet')[1]).toMatch(/Testnet.*fictif/); expect(tone('flToneReal')[1]).toMatch(/Réel.*réel/); expect(tone('flToneReal')[2]).toMatch(/real money/i);
    // the live keys form ONE contiguous block
    const first = src.indexOf('\n  fl'), end = src.indexOf('// end of the `fl` block');
    expect(first).toBeGreaterThan(0); expect(end).toBeGreaterThan(first);
    expect(/\n  fl[A-Z]/.test(src.slice(end))).toBe(false);
  });
});

describe('account state from the stream', () => {
  const order = (o: Partial<LiveOrder>): LiveOrder => ({ clientId: 'k1', cloid: '0x1', instrument: 'hyperliquid:BTC', side: 'buy', type: 'limit', size: '0.001', price: '73000', triggerPrice: null, reduceOnly: false, tif: 'gtc', state: 'unknown', final: false,
    venueOrderId: null, filled: '0', avgFillPrice: null, reason: null, origin: 'owner', hash: null, nonce: 1, expiresAt: 2, canonical: null, createdAt: 1, updatedAt: 10, submittedAt: 5, source: 'local', ...o });
  const detail = (): LiveDetail => ({ id: 'a', venue: 'hyperliquid', network: 'testnet', kind: 'venue', mode: 'MANUAL_LIVE', label: 'x', account: '0x1', agentAddress: '0x2', policy: {} as never, halt: null, divergence: null, halted: null, mainnetEnabled: false, tradable: true,
    authorization: null, pendingAuthorization: null, createdAt: 0, updatedAt: 0, venueState: { state: { equity: '10' } as never, positions: [], openOrders: [], error: null, ts: 1, source: 'venue' }, orders: [order({})], actions: [], fills: [], funding: [], riskEvents: [], equity: [], ts: 0 });
  it('an order event replaces the order with the same client id, never with an older state', () => {
    const d = applyLiveEvent(detail(), 'order', order({ state: 'open', updatedAt: 20, source: 'venue' }));
    expect(d.orders).toHaveLength(1); expect(d.orders[0]!.state).toBe('open');
    expect(mergeOrder(d.orders, order({ state: 'unknown', updatedAt: 15 }))[0]!.state).toBe('open');                     // a late, older event changes nothing
    expect(mergeOrder(d.orders, order({ clientId: 'k2' }))).toHaveLength(2);
  });
  it('an account event that could not read the venue never empties the account', () => {
    const d0 = detail(); d0.venueState.positions = [{ instrument: 'hyperliquid:BTC' } as never];
    const d = applyLiveEvent(d0, 'account', { state: null, positions: [], openOrders: [], error: 'timeout', ts: 9, divergence: null, halt: null, mode: 'MANUAL_LIVE' });
    expect(d.venueState.error).toBe('timeout'); expect(d.venueState.state).toEqual({ equity: '10' });
    const ok = applyLiveEvent(d, 'account', { state: { equity: '11' }, positions: [], openOrders: [], ts: 12, divergence: 'position …', halt: null, mode: 'MANUAL_LIVE', source: 'venue' });
    expect(ok.venueState.error).toBeNull(); expect(ok.venueState.state).toEqual({ equity: '11' }); expect(ok.divergence).toBe('position …');
  });
  it('risk and unknown events', () => {
    expect(applyLiveEvent(detail(), 'risk', { ts: 5, kind: 'halt', code: 'halted', message: 'halted by the owner', data: {} }).riskEvents[0]).toMatchObject({ kind: 'halt', code: 'halted' });
    const d = detail(); expect(applyLiveEvent(d, 'whatever', { x: 1 })).toBe(d); expect(applyLiveEvent(d, 'order', null)).toBe(d);
  });
  it('labels and in-flight states', () => {
    expect(toneOf({ kind: 'paper', network: 'mainnet' })).toBe('paper'); expect(toneOf({ kind: 'venue', network: 'testnet' })).toBe('testnet'); expect(toneOf({ kind: 'venue', network: 'mainnet' })).toBe('mainnet');
    expect(toneOf({ kind: 'venue', network: 'anything-else' })).toBe('mainnet');                                                   // never "play money" by default
    expect(['authorized', 'signed', 'submitted', 'unknown'].every((s) => inFlight(s as never))).toBe(true);
    expect(['open', 'filled', 'rejected', 'cancelled', 'risk_checked'].some((s) => inFlight(s as never))).toBe(false);
  });
});
