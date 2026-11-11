// Hyperliquid trading: price/size rules, action building, describe() round trips, tampering, submit. No network.
import { describe, expect, it } from 'vitest';
import { VenueError, type Instrument, type OrderRequest, type SignRequest } from '../../src/index.ts';
import {
  createHlHttp, createHlNonceSource, createHlTrading, hlCloid, hlFormatPrice, hlFormatSize, hlNonceInWindow, hlQuantizePrice, hlSigFigs, hlTickAt, hlWire, l1SignPayload,
  buildUsdClassTransferTypedDataOnly, buildWithdraw3TypedDataOnly, recoverTypedDataSigner, type HlL1SignPayload, type HlUserSignPayload,
} from '../../src/venues/hyperliquid/index.ts';
import { privateKeyToAddress } from 'viem/accounts';
import { SDK_TEST_KEY, replay, signWith, universe, type Route } from './helpers.ts';

const { assets, instruments } = universe('mainnet');
const BTC = instruments.get('BTC')!, ETH = instruments.get('ETH')!, DOGE = instruments.get('DOGE')!;
const NOW = 1_794_366_000_000;
const trading = createHlTrading({ network: 'mainnet', assets, now: () => NOW });
const order = (o: Partial<OrderRequest> = {}): OrderRequest => ({ instrument: BTC.id, side: 'buy', type: 'limit', size: '0.001', price: '73000', triggerPrice: null, reduceOnly: false, tif: 'gtc', clientId: 'order-1', ...o });
const rejected = (f: () => unknown): string => { try { f(); } catch (e) { if (e instanceof VenueError && e.code === 'rejected') return e.message; throw e; } throw new Error('not rejected'); };
const clone = <T>(x: T): T => structuredClone(x);
const payloadOf = (s: SignRequest) => s.payload as HlL1SignPayload;

describe('price and size rules (tick and lot size page)', () => {
  it('documented price examples', () => {
    expect(hlFormatPrice('1234.5', 0)).toEqual({ ok: true, wire: '1234.5' });           // "1234.5 is valid"
    expect(hlFormatPrice('1234.56', 0).ok).toBe(false);                                 // "1234.56 is not (too many significant figures)"
    expect(hlFormatPrice('0.001234', 0)).toEqual({ ok: true, wire: '0.001234' });       // "0.001234 is valid"
    expect(hlFormatPrice('0.0012345', 0).ok).toBe(false);                               // "more than 6 decimal places"
    expect(hlFormatPrice('0.01234', 1)).toEqual({ ok: true, wire: '0.01234' });         // szDecimals = 1
    expect(hlFormatPrice('0.012345', 1).ok).toBe(false);                                // "more than 6 - szDecimals decimal places"
    expect(hlFormatPrice('123456', 0)).toEqual({ ok: true, wire: '123456' });           // "Integer prices are always allowed"
    expect(hlFormatPrice('12345.6', 0).ok).toBe(false);                                 // "even though 12345.6 is not"
  });
  it('documented size example', () => {
    expect(hlFormatSize('1.001', 3)).toEqual({ ok: true, wire: '1.001' });
    expect(hlFormatSize('1.0001', 3).ok).toBe(false);
  });
  it('trailing zeros are removed for the wire, never counted against the request', () => {
    expect(hlFormatPrice('73000.0', 5)).toEqual({ ok: true, wire: '73000' });
    expect(hlFormatPrice('1670.10', 4)).toEqual({ ok: true, wire: '1670.1' });
    expect(hlFormatSize('0.00100', 5)).toEqual({ ok: true, wire: '0.001' });
    expect(hlWire('100.50')).toBe('100.5');
    expect(hlSigFigs('0.001234')).toBe(4);
    expect(hlSigFigs('1234.5')).toBe(5);
    expect(hlSigFigs('100')).toBe(3);
  });
  it('refuses zero, negatives, exponents and anything that is not a canonical decimal', () => {
    for (const bad of ['0', '0.0', '-1', '1e3', '01', '.5', '1.', ' 1', 'NaN', '']) { expect(hlFormatPrice(bad, 2).ok, bad).toBe(false); expect(hlFormatSize(bad, 2).ok, bad).toBe(false); }
    expect(hlFormatPrice(1 as never, 2).ok).toBe(false);
  });
  it('BTC (szDecimals 5): one decimal at most, five significant figures', () => {
    expect(hlFormatPrice('73699', 5).ok).toBe(true);
    expect(hlFormatPrice('73699.5', 5).ok).toBe(false);  // six significant figures
    expect(hlFormatPrice('9999.5', 5).ok).toBe(true);
    expect(hlFormatPrice('9999.55', 5).ok).toBe(false);
    expect(hlFormatSize('0.00001', 5).ok).toBe(true);
    expect(hlFormatSize('0.000001', 5).ok).toBe(false);
  });
  it('the step at a price, and explicit rounding onto the grid', () => {
    expect(hlTickAt('73699', 5)).toBe('1');
    expect(hlTickAt('9999.5', 5)).toBe('0.1');
    expect(hlTickAt('1670.1', 4)).toBe('0.1');
    expect(hlTickAt('0.17567', 0)).toBe('0.00001');
    expect(hlTickAt('0.063173', 0)).toBe('0.000001');
    expect(hlTickAt('0.0000123', 0)).toBe('0.000001'); // capped by the 6-decimal rule
    expect(hlTickAt('123456', 0)).toBe('1');
    expect(hlQuantizePrice('73699.56', 5, 'down')).toBe('73699');
    expect(hlQuantizePrice('73699.56', 5, 'up')).toBe('73700');
    expect(hlQuantizePrice('99999.5', 5, 'up')).toBe('100000');
    expect(hlQuantizePrice('0.999999', 0, 'up')).toBe('1');
    for (const [p, d] of [['73699.56', 5], ['0.0631734', 0], ['1670.123', 4], ['99999.5', 5]] as const) for (const m of ['down', 'up'] as const) expect(hlFormatPrice(hlQuantizePrice(p, d, m), d).ok).toBe(true);
  });
});

describe('buildOrder', () => {
  it('limit gtc / ioc / alo', () => {
    for (const [tif, wire] of [['gtc', 'Gtc'], ['ioc', 'Ioc'], ['alo', 'Alo']] as const) {
      const { action } = trading.buildOrder(order({ tif }), { instrument: BTC, nonce: NOW });
      expect(action).toEqual({ type: 'order', orders: [{ a: 0, b: true, p: '73000', s: '0.001', r: false, t: { limit: { tif: wire } }, c: hlCloid('order-1') }], grouping: 'na' });
      expect(Object.keys(action.orders[0]!)).toEqual(['a', 'b', 'p', 's', 'r', 't', 'c']);
    }
  });
  it('market = immediate-or-cancel limit at the request\'s worst price; the price is mandatory', () => {
    const { action } = trading.buildOrder(order({ type: 'market', side: 'sell', price: '70000', tif: 'ioc', reduceOnly: true }), { instrument: BTC, nonce: NOW });
    expect(action.orders[0]).toMatchObject({ b: false, p: '70000', r: true, t: { limit: { tif: 'Ioc' } } });
    expect(rejected(() => trading.buildOrder(order({ type: 'market', price: null, tif: 'ioc' }), { instrument: BTC, nonce: NOW }))).toMatch(/worst acceptable price/);
    expect(rejected(() => trading.buildOrder(order({ type: 'market', tif: 'gtc' }), { instrument: BTC, nonce: NOW }))).toMatch(/tif must be ioc/);
  });
  it('stop and take-profit orders, market and limit', () => {
    const t = (type: OrderRequest['type']) => trading.buildOrder(order({ type, side: 'sell', price: '69000', triggerPrice: '70000', reduceOnly: true }), { instrument: BTC, nonce: NOW }).action.orders[0]!.t;
    expect(t('stop_market')).toEqual({ trigger: { isMarket: true, triggerPx: '70000', tpsl: 'sl' } });
    expect(t('stop_limit')).toEqual({ trigger: { isMarket: false, triggerPx: '70000', tpsl: 'sl' } });
    expect(t('take_profit_market')).toEqual({ trigger: { isMarket: true, triggerPx: '70000', tpsl: 'tp' } });
    expect(t('take_profit_limit')).toEqual({ trigger: { isMarket: false, triggerPx: '70000', tpsl: 'tp' } });
    expect(Object.keys((t('stop_market') as { trigger: object }).trigger)).toEqual(['isMarket', 'triggerPx', 'tpsl']); // SDK order
    expect(rejected(() => trading.buildOrder(order({ type: 'stop_market', triggerPrice: null }), { instrument: BTC, nonce: NOW }))).toMatch(/triggerPrice is required/);
    expect(rejected(() => trading.buildOrder(order({ type: 'stop_market', triggerPrice: '70000', tif: 'ioc' }), { instrument: BTC, nonce: NOW }))).toMatch(/tif must be gtc/);
    expect(rejected(() => trading.buildOrder(order({ triggerPrice: '70000' }), { instrument: BTC, nonce: NOW }))).toMatch(/no trigger price/);
  });
  it('off-tick and off-lot requests are refused, never rounded', () => {
    const off = (o: Partial<OrderRequest>, i: Instrument = BTC) => { try { trading.buildOrder(order({ instrument: i.id, ...o }), { instrument: i, nonce: NOW }); } catch (e) { return (e as VenueError).detail; } return null; };
    expect(off({ price: '73000.5' })).toMatchObject({ offTick: true });        // 6 significant figures
    expect(off({ price: '7300.55' })).toMatchObject({ offTick: true });        // 2 decimals, BTC allows 1
    expect(off({ size: '0.000001' })).toMatchObject({ offLot: true });
    expect(off({ type: 'stop_limit', triggerPrice: '70000.55' })).toMatchObject({ offTick: true });
    expect(off({ price: '0.12345', size: '100' }, DOGE)).toBeNull();           // DOGE szDecimals 0: 6 decimals allowed, 5 significant figures
    expect(off({ price: '0.012345', size: '1000' }, DOGE)).toBeNull();
    expect(off({ price: '0.123456', size: '100' }, DOGE)).toMatchObject({ offTick: true });
    expect(off({ price: '0.0123456', size: '100' }, DOGE)).toMatchObject({ offTick: true });
    expect(off({ size: '10.5' }, DOGE)).toMatchObject({ offLot: true });
    expect(off({ price: '0' })).toMatchObject({ offTick: true });
    expect(off({ size: '0' })).toMatchObject({ offLot: true });
  });
  it('refuses malformed requests, foreign or delisted instruments, bad nonces', () => {
    const delisted = [...instruments.values()].find((i) => i.status === 'halted')!;
    expect(rejected(() => trading.buildOrder(order({ instrument: delisted.id, size: '1', price: '1' }), { instrument: delisted, nonce: NOW }))).toMatch(/delisted/);
    expect(rejected(() => trading.buildOrder(order({ instrument: ETH.id }), { instrument: BTC, nonce: NOW }))).toMatch(/differ/);
    expect(rejected(() => trading.buildOrder(order(), { instrument: { ...BTC, venue: 'dydx' }, nonce: NOW }))).toMatch(/not a Hyperliquid instrument/);
    expect(rejected(() => trading.buildOrder(order(), { instrument: { ...BTC, lotSize: '0.001' }, nonce: NOW }))).toMatch(/lot size differs/);
    expect(rejected(() => trading.buildOrder(order({ instrument: 'hyperliquid:NOPE' }), { instrument: { ...BTC, symbol: 'NOPE', id: 'hyperliquid:NOPE' }, nonce: NOW }))).toMatch(/not in the mainnet asset table/);
    expect(rejected(() => trading.buildOrder(order({ size: 0.001 as never }), { instrument: BTC, nonce: NOW }))).toMatch(/malformed/);
    expect(rejected(() => trading.buildOrder(order({ side: 'long' as never }), { instrument: BTC, nonce: NOW }))).toMatch(/malformed/);
    expect(rejected(() => trading.buildOrder(order({ clientId: '' }), { instrument: BTC, nonce: NOW }))).toMatch(/clientId/);
    for (const nonce of [0, -1, 1.5, NaN]) expect(rejected(() => trading.buildOrder(order(), { instrument: BTC, nonce }))).toMatch(/nonce/);
  });
  it('cloid: deterministic, 128 bits, distinct per clientId, a cloid passes through', () => {
    const a = hlCloid('order-1');
    expect(a).toMatch(/^0x[0-9a-f]{32}$/);
    expect(hlCloid('order-1')).toBe(a);
    expect(hlCloid('order-2')).not.toBe(a);
    expect(hlCloid(a)).toBe(a);
    expect(hlCloid('0x' + 'AB'.repeat(16))).not.toBe('0x' + 'AB'.repeat(16)); // upper case is not a cloid: hashed like any id
  });
  it('the sign request carries the phantom agent of the action', () => {
    const { action, sign } = trading.buildOrder(order(), { instrument: BTC, nonce: NOW });
    expect(sign).toMatchObject({ venue: 'hyperliquid', network: 'mainnet', kind: 'hl_l1' });
    const p = payloadOf(sign);
    expect(p).toMatchObject({ scheme: 'l1', nonce: NOW, vaultAddress: null, expiresAfter: null });
    expect(p.typedData).toEqual(l1SignPayload(action as never, { network: 'mainnet', nonce: NOW }).typedData);
    expect(p.typedData.message.source).toBe('a');
    expect(JSON.parse(JSON.stringify(sign))).toEqual(sign); // plain JSON: it can travel to the signer unchanged
  });
  it('expiresAfter, when configured, is nonce + the configured delay and is part of the hash', () => {
    const t = createHlTrading({ network: 'testnet', assets: universe('testnet').assets, expiresAfterMs: 60_000 });
    const btc = universe('testnet').instruments.get('BTC')!;
    const { sign } = t.buildOrder(order(), { instrument: btc, nonce: NOW });
    expect(payloadOf(sign).expiresAfter).toBe(NOW + 60_000);
    expect(payloadOf(sign).typedData.message.source).toBe('b');
    expect(t.describe(sign).detail.expiresAfter).toBe(NOW + 60_000);
  });
});

describe('describe: build → describe gives back the request', () => {
  const cases: [string, Instrument, Partial<OrderRequest>][] = [
    ['limit gtc buy', BTC, {}],
    ['limit alo sell', BTC, { side: 'sell', tif: 'alo', price: '75000' }],
    ['limit ioc reduce-only', ETH, { instrument: ETH.id, tif: 'ioc', reduceOnly: true, size: '0.0147', price: '1670.1' }],
    ['market sell', BTC, { type: 'market', side: 'sell', tif: 'ioc', price: '70000' }],
    ['stop market', BTC, { type: 'stop_market', side: 'sell', price: '69000', triggerPrice: '70000', reduceOnly: true }],
    ['stop limit', BTC, { type: 'stop_limit', side: 'buy', price: '76000', triggerPrice: '75500' }],
    ['take profit market', ETH, { instrument: ETH.id, type: 'take_profit_market', side: 'sell', size: '1', price: '2300', triggerPrice: '2500', reduceOnly: true }],
    ['take profit limit', DOGE, { instrument: DOGE.id, type: 'take_profit_limit', side: 'sell', size: '190', price: '0.07448', triggerPrice: '0.076', reduceOnly: true }],
    ['trailing zeros in the request', BTC, { size: '0.00100', price: '73000.0' }],
  ];
  it.each(cases)('%s', (_n, instrument, o) => {
    const req = order(o), { sign } = trading.buildOrder(req, { instrument, nonce: NOW }), d = trading.describe(sign);
    expect(d.kind).toBe('order');
    expect(d.orders).toHaveLength(1);
    expect(d.orders![0]).toEqual(trading.normalizeRequest(req, instrument));
    const got = d.orders![0]!;
    // field by field against the request: only the venue-imposed normalisations differ
    expect(got.instrument).toBe(req.instrument);
    expect(got.side).toBe(req.side);
    expect(got.reduceOnly).toBe(req.reduceOnly);
    expect(got.size).toBe(hlWire(req.size));
    expect(got.price).toBe(hlWire(req.price!));
    expect(got.triggerPrice).toBe(req.triggerPrice === null ? null : hlWire(req.triggerPrice));
    expect(got.type).toBe(req.type === 'market' ? 'limit' : req.type);   // a market order IS an IOC limit on this venue
    expect(got.tif).toBe(req.tif);
    expect(got.clientId).toBe(hlCloid(req.clientId));
    expect(d.detail).toMatchObject({ nonce: NOW, vaultAddress: null, expiresAfter: null, grouping: 'na' });
  });
  it('describe survives a JSON round trip of the sign request (key order is preserved)', () => {
    const { sign } = trading.buildOrder(order(), { instrument: BTC, nonce: NOW });
    expect(trading.describe(JSON.parse(JSON.stringify(sign)))).toEqual(trading.describe(sign));
  });
  it('cancel by order id and by client id', () => {
    const a = trading.buildCancel({ instrument: BTC, venueOrderId: '601262932710', nonce: NOW });
    expect(a.action).toEqual({ type: 'cancel', cancels: [{ a: 0, o: 601262932710 }] });
    expect(trading.describe(a.sign)).toMatchObject({ kind: 'cancel', detail: { cancels: [{ instrument: 'hyperliquid:BTC', venueOrderId: '601262932710' }], nonce: NOW } });
    const b = trading.buildCancel({ instrument: ETH, clientId: 'order-1', nonce: NOW });
    expect(b.action).toEqual({ type: 'cancelByCloid', cancels: [{ asset: 1, cloid: hlCloid('order-1') }] });
    expect(trading.describe(b.sign)).toMatchObject({ kind: 'cancel', detail: { cancels: [{ instrument: 'hyperliquid:ETH', clientId: hlCloid('order-1') }] } });
    expect(trading.describe(a.sign).orders).toBeUndefined();
    expect(rejected(() => trading.buildCancel({ instrument: BTC, nonce: NOW }))).toMatch(/exactly one/);
    expect(rejected(() => trading.buildCancel({ instrument: BTC, venueOrderId: '1', clientId: 'x', nonce: NOW }))).toMatch(/exactly one/);
    for (const bad of ['abc', '-1', '1.5', '99999999999999999999', '01']) expect(rejected(() => trading.buildCancel({ instrument: BTC, venueOrderId: bad, nonce: NOW }))).toMatch(/numeric order id/);
  });
  it('leverage change', () => {
    const a = trading.buildUpdateLeverage({ instrument: ETH, leverage: 5, marginMode: 'isolated', nonce: NOW });
    expect(a.action).toEqual({ type: 'updateLeverage', asset: 1, isCross: false, leverage: 5 });
    expect(trading.describe(a.sign)).toMatchObject({ kind: 'leverage', detail: { instrument: 'hyperliquid:ETH', leverage: '5', marginMode: 'isolated' } });
    expect(trading.describe(trading.buildUpdateLeverage({ instrument: BTC, leverage: 3, marginMode: 'cross', nonce: NOW }).sign).detail.marginMode).toBe('cross');
    expect(rejected(() => trading.buildUpdateLeverage({ instrument: ETH, leverage: Number(ETH.maxLeverage) + 1, marginMode: 'cross', nonce: NOW }))).toMatch(/between 1 and/);
    expect(rejected(() => trading.buildUpdateLeverage({ instrument: ETH, leverage: 2.5, marginMode: 'cross', nonce: NOW }))).toMatch(/integer/);
    const iso = [...instruments.values()].find((i) => i.marginModes.length === 1)!;
    expect(rejected(() => trading.buildUpdateLeverage({ instrument: iso, leverage: 1, marginMode: 'cross', nonce: NOW }))).toMatch(/isolated-only/);
  });
  it('agent approval: address, name, expiry — and the typed data is signed by the ACCOUNT key', async () => {
    const agent = '0x5e9ee1089755c3435139848e47e6635505d5a13a';
    const a = trading.buildApproveAgent({ agentAddress: agent.toUpperCase().replace('0X', '0x'), agentName: 'spw-trade valid_until 1800000000000', nonce: NOW });
    expect(a.sign.kind).toBe('hl_user');
    expect(a.action).toEqual({ type: 'approveAgent', hyperliquidChain: 'Mainnet', signatureChainId: '0x66eee', agentAddress: agent, agentName: 'spw-trade valid_until 1800000000000', nonce: NOW });
    expect(trading.describe(a.sign)).toEqual({ kind: 'approve_agent', detail: { agentAddress: agent, agentName: 'spw-trade', validUntil: 1800000000000, nonce: NOW, signatureChainId: '0x66eee', hyperliquidChain: 'Mainnet' } });
    const unnamed = trading.buildApproveAgent({ agentAddress: agent, agentName: null, nonce: NOW });
    expect('agentName' in unnamed.action).toBe(false);
    expect(trading.describe(unnamed.sign).detail).toMatchObject({ agentAddress: agent, agentName: null, validUntil: null });
    const td = (a.sign.payload as HlUserSignPayload).typedData;
    expect(td.domain).toEqual({ name: 'HyperliquidSignTransaction', version: '1', chainId: 0x66eee, verifyingContract: '0x0000000000000000000000000000000000000000' });
    expect(td.primaryType).toBe('HyperliquidTransaction:ApproveAgent');
    expect(await recoverTypedDataSigner(td, await signWith(SDK_TEST_KEY, td))).toBe(privateKeyToAddress(SDK_TEST_KEY).toLowerCase());
    expect(rejected(() => trading.buildApproveAgent({ agentAddress: '0x12', agentName: null, nonce: NOW }))).toMatch(/approveAgent/);
  });
});

describe('describe: anything else is refused', () => {
  const built = () => trading.buildOrder(order(), { instrument: BTC, nonce: NOW }).sign;
  /** recomputes the typed data after tampering, as an attacker who controls the API would */
  const rehash = (s: SignRequest): SignRequest => { const p = payloadOf(s); p.typedData = l1SignPayload(p.action as never, { network: s.network, nonce: p.nonce, vaultAddress: p.vaultAddress, expiresAfter: p.expiresAfter }).typedData; return s; };
  const tamper = (f: (p: any, s: any) => void, fix = true): SignRequest => { const s = clone(built()); f(s.payload, s); return fix ? rehash(s) : s; };

  it('a tampered action no longer matches its typed data', () => {
    for (const f of [(p: any) => { p.action.orders[0].s = '1'; }, (p: any) => { p.action.orders[0].b = false; }, (p: any) => { p.action.orders[0].p = '1'; }, (p: any) => { p.action.orders[0].a = 1; },
      (p: any) => { p.nonce += 1; }, (p: any) => { p.vaultAddress = `0x${'1'.repeat(40)}`; }, (p: any) => { p.expiresAfter = NOW; }, (p: any) => { p.action.orders[0].r = true; }])
      expect(rejected(() => trading.describe(tamper(f, false)))).toMatch(/does not match the action/);
  });
  it('tampered typed data is refused', () => {
    expect(rejected(() => trading.describe(tamper((p) => { p.typedData.message.connectionId = `0x${'00'.repeat(32)}`; }, false)))).toMatch(/does not match/);
    expect(rejected(() => trading.describe(tamper((p) => { p.typedData.message.source = 'b'; }, false)))).toMatch(/does not match/);
    expect(rejected(() => trading.describe(tamper((p) => { p.typedData.domain.chainId = 1; }, false)))).toMatch(/does not match/);
    expect(rejected(() => trading.describe(tamper((p) => { p.typedData.domain.name = 'HyperliquidSignTransaction'; }, false)))).toMatch(/does not match/);
    expect(rejected(() => trading.describe(tamper((p) => { p.typedData.primaryType = 'Other'; }, false)))).toMatch(/does not match/);
    expect(rejected(() => trading.describe(tamper((p) => { p.typedData.types.Agent.push({ name: 'x', type: 'string' }); }, false)))).toMatch(/does not match/);
    expect(rejected(() => trading.describe(tamper((p) => { p.typedData.extra = 1; }, false)))).toMatch(/sign payload/);
  });
  it('unexpected extra fields are refused even when the hash is consistent', () => {
    expect(rejected(() => trading.describe(tamper((p) => { p.action.builder = { b: `0x${'1'.repeat(40)}`, f: 10 }; })))).toMatch(/order action/);
    expect(rejected(() => trading.describe(tamper((p) => { p.action.orders[0].x = 1; })))).toMatch(/order action/);
    expect(rejected(() => trading.describe(tamper((p) => { p.action.orders[0].t.limit.extra = true; })))).toMatch(/order action/);
    expect(rejected(() => trading.describe(tamper((p) => { p.action.grouping = 'normalTpsl'; })))).toMatch(/order action/);
    expect(rejected(() => trading.describe(tamper((p) => { p.action.orders = []; })))).toMatch(/order action/);
    expect(rejected(() => trading.describe(tamper((p) => { p.extra = true; })))).toMatch(/sign payload/);
    const cancel = clone(trading.buildCancel({ instrument: BTC, venueOrderId: '5', nonce: NOW }).sign);
    (cancel.payload as any).action.f = true;
    expect(rejected(() => trading.describe(rehash(cancel)))).toMatch(/cancel action/);
    const lev = clone(trading.buildUpdateLeverage({ instrument: BTC, leverage: 2, marginMode: 'cross', nonce: NOW }).sign);
    (lev.payload as any).action.extra = 1;
    expect(rejected(() => trading.describe(rehash(lev)))).toMatch(/updateLeverage action/);
  });
  it('values the builder could not have produced are refused', () => {
    expect(rejected(() => trading.describe(tamper((p) => { p.action.orders[0].p = '73000.55'; })))).toMatch(/price .* is not valid/);
    expect(rejected(() => trading.describe(tamper((p) => { p.action.orders[0].p = '73000.0'; })))).toMatch(/order action/); // trailing zero: not the wire form
    expect(rejected(() => trading.describe(tamper((p) => { p.action.orders[0].s = '0.0000001'; })))).toMatch(/size .* is not valid/);
    expect(rejected(() => trading.describe(tamper((p) => { p.action.orders[0].a = 99999; })))).toMatch(/not in the mainnet asset table/);
    expect(rejected(() => trading.describe(tamper((p) => { p.action.orders[0].a = 10000; })))).toMatch(/not in the mainnet asset table/); // spot asset id
    expect(rejected(() => trading.describe(tamper((p) => { p.action.orders[0].c = '0x12'; })))).toMatch(/order action/);
    expect(rejected(() => trading.describe(tamper((p) => { p.action.orders[0].t = { limit: { tif: 'Fok' } }; })))).toMatch(/order action/);
    expect(rejected(() => trading.describe(tamper((p) => { const o = p.action.orders[0]; p.action.orders[0] = { b: o.b, a: o.a, p: o.p, s: o.s, r: o.r, t: o.t, c: o.c }; })))).toMatch(/canonical order/);
    expect(rejected(() => trading.describe(tamper((p) => { p.action = { grouping: 'na', type: 'order', orders: p.action.orders }; })))).toMatch(/canonical order/);
    expect(rejected(() => trading.describe(tamper((p) => { p.action.orders[0].s = 0.001; }, false)))).toMatch(/cannot be hashed/); // a float cannot even be encoded
    const lev = clone(trading.buildUpdateLeverage({ instrument: ETH, leverage: 2, marginMode: 'cross', nonce: NOW }).sign);
    (lev.payload as any).action.leverage = 500;
    expect(rejected(() => trading.describe(rehash(lev)))).toMatch(/above the maximum/);
  });
  it('a consistent hash of an action this module does not build is `other` — the signer refuses it', () => {
    for (const action of [
      { type: 'agentSendAsset', destination: `0x${'1'.repeat(40)}`, sourceDex: '', destinationDex: 'spot', token: 'USDC', amount: '100', fromSubAccount: '', nonce: NOW },
      { type: 'vaultTransfer', vaultAddress: `0x${'1'.repeat(40)}`, isDeposit: true, usd: 1000000 },
      { type: 'subAccountTransfer', subAccountUser: `0x${'1'.repeat(40)}`, isDeposit: true, usd: 10 },
      { type: 'cDeposit2', wei: 100000000 }, { type: 'scheduleCancel' }, { type: 'noop' }, { type: 'twapOrder', twap: { a: 0, b: true, s: '1', r: false, m: 5, t: false } },
      { type: 'batchModify', modifies: [] }, { type: 'updateIsolatedMargin', asset: 0, isBuy: true, ntli: 1000000 },
    ]) {
      const s = tamper((p) => { p.action = action; });
      expect(trading.describe(s)).toMatchObject({ kind: 'other', detail: { type: action.type } });
      expect(trading.describe(s).orders).toBeUndefined();
    }
  });
  it('wrong venue, wrong network, unknown kind, malformed payload', () => {
    expect(rejected(() => trading.describe({ ...built(), venue: 'dydx' }))).toMatch(/not for Hyperliquid/);
    expect(rejected(() => trading.describe({ ...built(), network: 'testnet' }))).toMatch(/is for testnet/);
    expect(rejected(() => trading.describe({ ...built(), kind: 'raw' }))).toMatch(/unknown sign request kind/);
    expect(rejected(() => trading.describe({ ...built(), payload: null }))).toMatch(/sign payload/);
    expect(rejected(() => trading.describe({ ...built(), payload: { scheme: 'l1' } }))).toMatch(/sign payload/);
    expect(rejected(() => trading.describe(null as never))).toMatch(/not for Hyperliquid/);
    // a testnet action presented to a mainnet describer: its phantom agent says source 'b'
    const testnet = createHlTrading({ network: 'testnet', assets }).buildOrder(order(), { instrument: BTC, nonce: NOW }).sign;
    expect(rejected(() => trading.describe({ ...testnet, network: 'mainnet' }))).toMatch(/does not match/);
  });
  it('user-signed: a tampered approval is refused; transfers and withdrawals are `other`', () => {
    const agent = '0x5e9ee1089755c3435139848e47e6635505d5a13a', other = `0x${'9'.repeat(40)}`;
    const mk = () => clone(trading.buildApproveAgent({ agentAddress: agent, agentName: 'spw-trade', nonce: NOW }).sign);
    const t = (f: (p: any) => void) => { const s = mk(); f(s.payload); return s; };
    expect(rejected(() => trading.describe(t((p) => { p.action.agentAddress = other; })))).toMatch(/does not match/);              // shown one agent, signing another
    expect(rejected(() => trading.describe(t((p) => { p.typedData.message.agentAddress = other; })))).toMatch(/does not match/);
    expect(rejected(() => trading.describe(t((p) => { p.action.agentName = 'x'; })))).toMatch(/does not match/);
    expect(rejected(() => trading.describe(t((p) => { p.action.nonce += 1; })))).toMatch(/does not match/);
    expect(rejected(() => trading.describe(t((p) => { p.action.hyperliquidChain = 'Testnet'; })))).toMatch(/is for Testnet/);
    expect(rejected(() => trading.describe(t((p) => { p.typedData.message.hyperliquidChain = 'Testnet'; })))).toMatch(/does not match/);
    expect(rejected(() => trading.describe(t((p) => { p.typedData.primaryType = 'HyperliquidTransaction:Withdraw'; })))).toMatch(/does not match/);
    expect(rejected(() => trading.describe(t((p) => { p.action.extra = 1; })))).toMatch(/approveAgent action/);
    expect(rejected(() => trading.describe(t((p) => { p.action.agentAddress = agent.toUpperCase().replace('0X', '0x'); })))).toMatch(/approveAgent action/);
    const w = buildWithdraw3TypedDataOnly({ network: 'mainnet', destination: other, amount: '100', time: NOW });
    expect(trading.describe({ venue: 'hyperliquid', network: 'mainnet', kind: 'hl_user', payload: { scheme: 'user', action: w.action, typedData: w.typedData } })).toEqual({ kind: 'other', detail: { type: 'withdraw3', primaryType: 'HyperliquidTransaction:Withdraw' } });
    const u = buildUsdClassTransferTypedDataOnly({ network: 'mainnet', amount: '100', toPerp: false, nonce: NOW });
    expect(trading.describe({ venue: 'hyperliquid', network: 'mainnet', kind: 'hl_user', payload: { scheme: 'user', action: u.action, typedData: u.typedData } }).kind).toBe('other');
    // a withdrawal dressed up as an approval: the typed data is what gets signed, and it does not match
    const s = mk();
    (s.payload as any).typedData = w.typedData;
    expect(rejected(() => trading.describe(s))).toMatch(/does not match/);
  });
});

describe('nonces', () => {
  it('window (T − 2 days, T + 1 day), exclusive', () => {
    expect(hlNonceInWindow(NOW, NOW)).toBe(true);
    expect(hlNonceInWindow(NOW - 2 * 86_400_000 + 1, NOW)).toBe(true);
    expect(hlNonceInWindow(NOW - 2 * 86_400_000, NOW)).toBe(false);
    expect(hlNonceInWindow(NOW + 86_400_000 - 1, NOW)).toBe(true);
    expect(hlNonceInWindow(NOW + 86_400_000, NOW)).toBe(false);
    expect(hlNonceInWindow(1.5, NOW)).toBe(false);
  });
  it('the nonce source is strictly increasing, even inside one millisecond or when the clock steps back', () => {
    let t = NOW;
    const n = createHlNonceSource(() => t);
    expect([n.next(), n.next(), n.next()]).toEqual([NOW, NOW + 1, NOW + 2]);
    t = NOW - 5000;
    expect(n.next()).toBe(NOW + 3);
    t = NOW + 10;
    expect(n.next()).toBe(NOW + 10);
  });
});

describe('submit', () => {
  const tAssets = universe('testnet'), tBtc = tAssets.instruments.get('BTC')!;
  const setup = (route: Route, o: { network?: 'mainnet' | 'testnet'; allowMainnetExchange?: boolean; now?: number } = {}) => {
    const network = o.network ?? 'testnet', r = replay({ exchange: route });
    const http = createHlHttp({ network, fetch: r.fetchImpl, now: () => o.now ?? NOW });
    const t = createHlTrading({ network, assets: network === 'testnet' ? tAssets.assets : assets, http, now: () => o.now ?? NOW, allowMainnetExchange: o.allowMainnetExchange });
    return { t, calls: r.calls, http };
  };
  const sig = { r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}`, v: 27 };
  const failure = async (p: Promise<unknown>): Promise<VenueError> => { try { await p; } catch (e) { if (e instanceof VenueError) return e; throw e; } throw new Error('no error'); };

  it('resting order: body as the SDK posts it, order id returned', async () => {
    const { t, calls, http } = setup({ body: { status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 77738308 } }] } } } });
    const { action } = t.buildOrder(order(), { instrument: tBtc, nonce: NOW });
    const out = await t.submit(action, sig, NOW);
    expect(out).toMatchObject({ accepted: true, venueOrderIds: ['77738308'], error: null });
    expect(calls[0]!.url).toBe('https://api.hyperliquid-testnet.xyz/exchange');
    expect(calls[0]!.body).toEqual({ action, nonce: NOW, signature: sig, vaultAddress: null, expiresAfter: null });
    expect(Object.keys(calls[0]!.body.action.orders[0])).toEqual(['a', 'b', 'p', 's', 'r', 't', 'c']);
    expect(http.budget.used()).toBe(1);
  });
  it('filled order and a 65-byte hex signature', async () => {
    const { t, calls } = setup({ body: { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.02', avgPx: '1891.4', oid: 77747314 } }] } } } });
    const { action } = t.buildOrder(order({ tif: 'ioc' }), { instrument: tBtc, nonce: NOW });
    const out = await t.submit(action, `0x${'11'.repeat(32)}${'22'.repeat(32)}1c`, NOW);
    expect(out.venueOrderIds).toEqual(['77747314']);
    expect(calls[0]!.body.signature).toEqual({ ...sig, v: 28 });
  });
  it('per-order error → VenueError rejected with the venue\'s words', async () => {
    const { t } = setup({ body: { status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'Order must have minimum value of $10.' }] } } } });
    const e = await failure(t.submit(t.buildOrder(order(), { instrument: tBtc, nonce: NOW }).action, sig, NOW));
    expect(e.code).toBe('rejected');
    expect(e.message).toContain('Order must have minimum value of $10.');
    expect(e.detail.venueOrderIds).toEqual([]);
  });
  it('whole-request error (status err) → rejected', async () => {
    const { t } = setup({ body: { status: 'err', response: 'User or API Wallet 0x1234567890123456789012345678901234567890 does not exist.' } });
    const e = await failure(t.submit(t.buildOrder(order(), { instrument: tBtc, nonce: NOW }).action, sig, NOW));
    expect(e.code).toBe('rejected');
    expect(e.message).toContain('does not exist');
  });
  it('cancel: success, and the documented cancel error', async () => {
    const ok = setup({ body: { status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } } });
    const c = ok.t.buildCancel({ instrument: tBtc, venueOrderId: '5', nonce: NOW });
    expect(await ok.t.submit(c.action, sig, NOW)).toMatchObject({ accepted: true, venueOrderIds: [] });
    const ko = setup({ body: { status: 'ok', response: { type: 'cancel', data: { statuses: [{ error: 'Order was never placed, already canceled, or filled.' }] } } } });
    expect((await failure(ko.t.submit(c.action, sig, NOW))).message).toContain('never placed');
  });
  it('leverage change and agent approval answer with type default', async () => {
    const { t, calls } = setup({ body: { status: 'ok', response: { type: 'default' } } });
    expect((await t.submit(t.buildUpdateLeverage({ instrument: tBtc, leverage: 3, marginMode: 'cross', nonce: NOW }).action, sig, NOW)).accepted).toBe(true);
    const a = t.buildApproveAgent({ agentAddress: `0x${'5'.repeat(40)}`, agentName: null, nonce: NOW });
    expect((await t.submit(a.action, sig, NOW)).accepted).toBe(true);
    expect(calls[1]!.body.action).toEqual({ type: 'approveAgent', hyperliquidChain: 'Testnet', signatureChainId: '0x66eee', agentAddress: `0x${'5'.repeat(40)}`, nonce: NOW });
    expect((await failure(t.submit(a.action, sig, NOW + 1))).message).toMatch(/nonce of the action and of the request differ/);
  });
  it('trigger order waiting for its trigger: accepted, no order id yet', async () => {
    const { t } = setup({ body: { status: 'ok', response: { type: 'order', data: { statuses: ['waitingForTrigger'] } } } });
    const { action } = t.buildOrder(order({ type: 'stop_market', side: 'sell', price: '69000', triggerPrice: '70000', reduceOnly: true }), { instrument: tBtc, nonce: NOW });
    expect(await t.submit(action, sig, NOW)).toMatchObject({ accepted: true, venueOrderIds: [] });
  });
  it('an answer that cannot be read is not a rejection: bad_answer (outcome unknown)', async () => {
    for (const body of [{ status: 'ok' }, { status: 'maybe', response: {} }, 'null', { status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 'x' } }] } } }]) {
      const { t } = setup({ body });
      expect((await failure(t.submit(t.buildOrder(order(), { instrument: tBtc, nonce: NOW }).action, sig, NOW))).code).toBe('bad_answer');
    }
  });
  it('HTTP 429 → rate_limited; 502 → unavailable; 422 → rejected', async () => {
    const act = (t: ReturnType<typeof setup>['t']) => t.buildOrder(order(), { instrument: tBtc, nonce: NOW }).action;
    const a = setup({ status: 429, body: '' }), b = setup({ status: 502, body: 'Bad Gateway' }), c = setup({ status: 422, body: 'Failed to deserialize the JSON body into the target type' });
    expect((await failure(a.t.submit(act(a.t), sig, NOW))).code).toBe('rate_limited');
    expect((await failure(b.t.submit(act(b.t), sig, NOW))).code).toBe('unavailable');
    expect((await failure(c.t.submit(act(c.t), sig, NOW))).code).toBe('rejected');
  });
  it('nothing is sent when the request is not submittable', async () => {
    const { t, calls } = setup({ body: {} });
    const { action } = t.buildOrder(order(), { instrument: tBtc, nonce: NOW });
    expect((await failure(t.submit(action, sig, NOW - 3 * 86_400_000))).message).toMatch(/outside the venue's window/);
    expect((await failure(t.submit(action, { r: '0x1', s: '0x2', v: 5 }, NOW))).code).toBe('rejected');
    expect((await failure(t.submit({ type: 'withdraw3' }, sig, NOW))).code).toBe('unsupported');
    expect((await failure(t.submit({ type: 'usdClassTransfer' }, sig, NOW))).code).toBe('unsupported');
    expect((await failure(t.submit({ ...action, builder: { b: '0x1', f: 1 } }, sig, NOW))).code).toBe('rejected');
    expect((await failure(t.submit(null, sig, NOW))).code).toBe('unsupported');
    expect((await failure(createHlTrading({ network: 'testnet', assets: tAssets.assets }).submit(action, sig, NOW))).code).toBe('unsupported');
    expect(calls.length).toBe(0);
  });
  it('the mainnet exchange endpoint is closed unless explicitly allowed', async () => {
    const closed = setup({ body: {} }, { network: 'mainnet' });
    const { action } = closed.t.buildOrder(order(), { instrument: BTC, nonce: NOW });
    const e = await failure(closed.t.submit(action, sig, NOW));
    expect(e.code).toBe('unsupported');
    expect(e.message).toMatch(/mainnet exchange endpoint is disabled/);
    expect(closed.calls.length).toBe(0);
  });
});
