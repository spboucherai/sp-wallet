import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  canonicalOrderHashHex, CanonicalOrderSchema, clientOrderIdFor, format, formatCommand, interpret, KEYWORDS, MAX_COMMAND_LENGTH, parse, parseCommand, resolve, resolveCommand,
  type Catalog, type Command, type ParseErrorCode, type Resolution, type ResolutionDefaults, type ResolveRequest,
} from '../src/index.ts';

const NOW = 1_800_000_000_000;
const cmd = (s: string): Command => { const r = parse(s); if (!r.ok) throw new Error(`${s}: ${r.error.code}`); return r.command; };
const err = (s: string): ParseErrorCode | null => { const r = parse(s); return r.ok ? null : r.error.code; };

const catalog: Catalog = {
  instruments: [
    { id: 'hyperliquid:BTC', venue: 'hyperliquid', network: 'mainnet', marketKind: 'perp', base: 'BTC', quote: 'USD', lotSize: '0.001' },
    { id: 'hyperliquid:BTC', venue: 'hyperliquid', network: 'testnet', marketKind: 'perp', base: 'BTC', quote: 'USD', lotSize: '0.001' },
    { id: 'gmx:BTC-USD', venue: 'gmx', network: 'arbitrum', marketKind: 'perp', base: 'BTC', quote: 'USD' },
    { id: 'hyperliquid:ETH', venue: 'hyperliquid', network: 'mainnet', marketKind: 'perp', base: 'ETH', quote: 'USD', lotSize: '0.01' },
    { id: 'kyberswap:WETH-USDC', venue: 'kyberswap', network: 'base', marketKind: 'spot', base: 'ETH', quote: 'USDC', lotSize: '0.0001' },
    { id: 'kyberswap:WETH-USDT', venue: 'kyberswap', network: 'base', marketKind: 'spot', base: 'ETH', quote: 'USDT' },
    { id: 'kyberswap:WETH-USDC', venue: 'kyberswap', network: 'arbitrum', marketKind: 'spot', base: 'ETH', quote: 'USDC' },
    { id: 'kyberswap:cbBTC-USDC', venue: 'kyberswap', network: 'base', marketKind: 'spot', base: 'BTC', quote: 'USDC' },
    { id: 'kyberswap:WBTC-USDC', venue: 'kyberswap', network: 'base', marketKind: 'spot', base: 'BTC', quote: 'USDC' },
  ],
  balances: [{ network: 'base', asset: 'ETH', amount: '2.5' }],
  positions: [{ instrument: 'hyperliquid:BTC', side: 'long', size: '0.5' }, { instrument: 'hyperliquid:ETH', side: 'short', size: '3.333' }],
  referencePricesUsd: { 'hyperliquid:BTC': '50000', 'hyperliquid:ETH': '2500', 'kyberswap:WETH-USDC': '2500' },
};
const defaults: ResolutionDefaults = { spotNetwork: 'base', spotVenueByNetwork: { base: 'kyberswap' }, spotQuote: 'USDC', usdQuotes: ['USDC', 'USDT'], perpVenue: 'hyperliquid', perpNetworkByVenue: { hyperliquid: 'mainnet', gmx: 'arbitrum' },
  perpLeverage: '3', perpMarginMode: 'cross', maxFeeBps: 10, maxSlippageBps: 50, orderTtlMs: 60_000 };
const request: ResolveRequest = { now: NOW, principal: { kind: 'owner', id: 'owner' }, mandateId: null, mode: 'live', idempotencyKey: 'cmd-00000001' };
const res = (s: string, d: ResolutionDefaults = defaults, c: Catalog = catalog, r: ResolveRequest = request): Resolution => resolve(cmd(s), d, c, r);
const orderOf = (r: Resolution) => { if (r.kind !== 'order') throw new Error(`not an order: ${JSON.stringify(r)}`); return r; };
const questions = (r: Resolution) => { if (r.kind !== 'ambiguous') throw new Error(`not ambiguous: ${JSON.stringify(r)}`); return r.questions.map((q) => q.field); };
const unresolvable = (r: Resolution) => { if (r.kind !== 'unresolvable') throw new Error(`resolved: ${JSON.stringify(r)}`); return r.code; };

describe('command parser — grammar', () => {
  const ok: [string, Command][] = [
    ['BUY ETH 100 USDC', { type: 'spot_buy', asset: 'ETH', amount: '100', quote: 'USDC', venue: null }],
    ['buy eth 100.50 usdc on KyberSwap', { type: 'spot_buy', asset: 'ETH', amount: '100.5', quote: 'USDC', venue: 'kyberswap' }],
    ['ACHETER ETH 100 USDC SUR kyberswap', { type: 'spot_buy', asset: 'ETH', amount: '100', quote: 'USDC', venue: 'kyberswap' }],
    ['achète eth 100 usdc', { type: 'spot_buy', asset: 'ETH', amount: '100', quote: 'USDC', venue: null }],
    ['SELL ETH 0.5', { type: 'spot_sell', asset: 'ETH', amount: { kind: 'abs', value: '0.5' }, quote: null, venue: null }],
    ['SELL ETH 50%', { type: 'spot_sell', asset: 'ETH', amount: { kind: 'pct', value: '50' }, quote: null, venue: null }],
    ['vendre eth 12.5% contre usdt sur kyberswap', { type: 'spot_sell', asset: 'ETH', amount: { kind: 'pct', value: '12.5' }, quote: 'USDT', venue: 'kyberswap' }],
    ['SELL 1INCH 100 FOR USDC', { type: 'spot_sell', asset: '1INCH', amount: { kind: 'abs', value: '100' }, quote: 'USDC', venue: null }],
    ['LONG BTC-PERP 1000', { type: 'perp_open', side: 'long', asset: 'BTC', notional: '1000', leverage: null, limit: null, stopLoss: null, takeProfit: null, venue: null }],
    ['short eth-perp 250.5 x5 limit 2600 sl 2700 tp 2300 on hyperliquid', { type: 'perp_open', side: 'short', asset: 'ETH', notional: '250.5', leverage: '5', limit: '2600', stopLoss: '2700', takeProfit: '2300', venue: 'hyperliquid' }],
    ['LONG BTC-PERP 1000 ON gmx TP 60000 5x SL 45000 LIMITE 49000', { type: 'perp_open', side: 'long', asset: 'BTC', notional: '1000', leverage: '5', limit: '49000', stopLoss: '45000', takeProfit: '60000', venue: 'gmx' }],
    ['LONG BTC-PERP 1000 x2.5', { type: 'perp_open', side: 'long', asset: 'BTC', notional: '1000', leverage: '2.5', limit: null, stopLoss: null, takeProfit: null, venue: null }],
    ['CLOSE BTC-PERP', { type: 'perp_close', asset: 'BTC', pct: null, venue: null }],
    ['fermer btc-perp 25% sur gmx', { type: 'perp_close', asset: 'BTC', pct: '25', venue: 'gmx' }],
    ['CLÔTURER ETH-PERP 100%', { type: 'perp_close', asset: 'ETH', pct: '100', venue: null }],
    ['CANCEL ORDER 0xAbC123', { type: 'cancel_order', id: '0xAbC123' }],
    ['annuler ordre a1b2-c3', { type: 'cancel_order', id: 'a1b2-c3' }],
    ['CANCEL ALL', { type: 'cancel_all', venue: null }],
    ['annuler tout sur hyperliquid', { type: 'cancel_all', venue: 'hyperliquid' }],
    ['SHOW POSITIONS', { type: 'show', topic: 'positions' }], ['afficher soldes', { type: 'show', topic: 'balances' }], ['voir ordres', { type: 'show', topic: 'orders' }], ['Show Risk', { type: 'show', topic: 'risk' }],
    ['montrer risque', { type: 'show', topic: 'risk' }],
    ['STOP ALL AGENTS', { type: 'stop_all_agents' }], ['arrêter tous les agents', { type: 'stop_all_agents' }], ['stop all the agents', { type: 'stop_all_agents' }],
    ['KILL', { type: 'kill' }], ['urgence', { type: 'kill' }], ['   kill   ', { type: 'kill' }],
  ];
  it.each(ok)('%s', (text, expected) => { expect(parse(text)).toEqual({ ok: true, command: expected }); });

  const bad: [string, ParseErrorCode][] = [
    ['', 'empty'], ['    ', 'empty'], ['x'.repeat(MAX_COMMAND_LENGTH + 1), 'too_long'], ['BUY ETH 100 USDC\nKILL', 'bad_character'], ['BUY\tETH 100 USDC', 'bad_character'], ['BUY ETH 100 USDC ‮', 'bad_character'],
    ['BUY ETH 100 USDC 🚀', 'bad_character'], ['HODL', 'unknown_command'], ['please buy some eth', 'unknown_command'], ['BUY', 'expected_asset'], ['BUY 100 ETH USDC', 'expected_asset'], ['BUY ETH', 'expected_amount'],
    ['BUY ETH lots USDC', 'bad_number'], ['BUY ETH 100', 'expected_quote'], ['BUY ETH 100 USDC NOW', 'unexpected_token'], ['BUY ETH -100 USDC', 'bad_number'], ['BUY ETH 1e3 USDC', 'bad_number'], ['BUY ETH 1,000 USDC', 'bad_number'],
    ['BUY ETH 0 USDC', 'bad_number'], ['BUY ETH 0.0 USDC', 'bad_number'], ['BUY ETH 007 USDC', 'bad_number'], ['BUY ETH .5 USDC', 'bad_number'], ['BUY ETH 5. USDC', 'bad_number'], ['BUY ETH +5 USDC', 'bad_number'],
    ['BUY ETH 0x10 USDC', 'bad_number'], ['BUY ETH Infinity USDC', 'bad_number'], ['BUY ETH NaN USDC', 'bad_number'], ['BUY ETH 100 USDC ON', 'expected_venue'], ['BUY ETH 100 USDC ON ../etc', 'expected_venue'],
    ['BUY BTC-PERP 100 USDC', 'expected_asset'], ['BUY ALL 100 USDC', 'expected_asset'], ['SELL ETH', 'expected_amount'], ['SELL ETH 0%', 'bad_percent'], ['SELL ETH 101%', 'bad_percent'], ['SELL ETH %', 'bad_percent'],
    ['SELL ETH 50%%', 'bad_percent'], ['SELL ETH 50 %', 'unexpected_token'], ['SELL ETH 50% FOR', 'expected_quote'], ['LONG BTC 1000', 'expected_perp'], ['LONG -PERP 1000', 'expected_perp'], ['LONG BTC-PERP', 'expected_amount'],
    ['LONG BTC-PERP 50%', 'bad_number'], ['LONG BTC-PERP 1000 x0.5', 'bad_leverage'], ['LONG BTC-PERP 1000 xx', 'bad_leverage'], ['LONG BTC-PERP 1000 x', 'unexpected_token'], ['LONG BTC-PERP 1000 x2 x3', 'duplicate_option'],
    ['LONG BTC-PERP 1000 SL 1 SL 2', 'duplicate_option'], ['LONG BTC-PERP 1000 LIMIT', 'expected_price'], ['LONG BTC-PERP 1000 TP abc', 'bad_number'], ['LONG BTC-PERP 1000 ON a ON b', 'duplicate_option'],
    ['LONG BTC-PERP 1000 MARKET', 'unexpected_token'], ['CLOSE BTC', 'expected_perp'], ['CLOSE BTC-PERP 150%', 'bad_percent'], ['CLOSE BTC-PERP 50', 'unexpected_token'], ['CANCEL', 'expected_keyword'],
    ['CANCEL ORDER', 'expected_id'], ['CANCEL ORDER a b', 'unexpected_token'], ['CANCEL ORDER a;drop', 'expected_id'], ['CANCEL ALL NOW', 'unexpected_token'], ['SHOW', 'expected_keyword'], ['SHOW SECRETS', 'expected_keyword'],
    ['SHOW POSITIONS PLEASE', 'unexpected_token'], ['STOP', 'expected_keyword'], ['STOP ALL', 'expected_keyword'], ['STOP AGENTS', 'expected_keyword'], ['KILL NOW', 'unexpected_token'], ['KILL KILL', 'unexpected_token'],
  ];
  it.each(bad)('refuses %j (%s)', (text, code) => { expect(err(text)).toBe(code); });
  it('reports where it stopped', () => {
    expect(parse('BUY ETH lots USDC')).toMatchObject({ ok: false, error: { token: 2 } });
    expect(parse('LONG BTC-PERP 1000 x2 x3')).toMatchObject({ ok: false, error: { token: 4 } });
    expect(parse('BUY ETH')).toMatchObject({ ok: false, error: { token: 2 } });
  });
  it('refuses anything that is not a string', () => { for (const x of [null, undefined, 5, {}, ['KILL']]) expect(parse(x as unknown as string).ok).toBe(false); });
  it('normalizes numbers to canonical decimals', () => {
    expect(cmd('BUY ETH 100.500 USDC')).toMatchObject({ amount: '100.5' });
    expect(cmd('LONG BTC-PERP 1000.0 x3.0')).toMatchObject({ notional: '1000', leverage: '3' });
  });
  it('every keyword spelling is unique across keywords', () => {
    const all = Object.values(KEYWORDS).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(parseCommand).toBe(parse); expect(formatCommand).toBe(format); expect(resolveCommand).toBe(resolve);
  });
});

describe('command parser — round trip and fuzz', () => {
  const num = fc.tuple(fc.integer({ min: 0, max: 9_999_999 }), fc.integer({ min: 0, max: 9999 })).filter(([a, b]) => a + b > 0).map(([a, b]) => (b === 0 ? String(a) : `${a}.${String(b).padStart(4, '0').replace(/0+$/, '')}`));
  const pct = fc.integer({ min: 1, max: 1000 }).map((n) => (n % 10 === 0 ? String(n / 10) : `${Math.floor(n / 10)}.${n % 10}`));
  const lev = fc.integer({ min: 10, max: 500 }).map((n) => (n % 10 === 0 ? String(n / 10) : `${Math.floor(n / 10)}.${n % 10}`));
  const asset = fc.constantFrom('BTC', 'ETH', 'SOL', 'HYPE', '1INCH', 'USDC', 'WBTC', 'A', 'Z9');
  const venue = fc.option(fc.constantFrom('hyperliquid', 'gmx', 'kyberswap', 'edge-x', 'v2'), { nil: null });
  const opt = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: null });
  const command: fc.Arbitrary<Command> = fc.oneof(
    fc.record({ type: fc.constant('spot_buy' as const), asset, amount: num, quote: asset, venue }),
    fc.record({ type: fc.constant('spot_sell' as const), asset, amount: fc.oneof(fc.record({ kind: fc.constant('abs' as const), value: num }), fc.record({ kind: fc.constant('pct' as const), value: pct })), quote: opt(asset), venue }),
    fc.record({ type: fc.constant('perp_open' as const), side: fc.constantFrom('long' as const, 'short' as const), asset, notional: num, leverage: opt(lev), limit: opt(num), stopLoss: opt(num), takeProfit: opt(num), venue }),
    fc.record({ type: fc.constant('perp_close' as const), asset, pct: opt(pct), venue }),
    fc.record({ type: fc.constant('cancel_order' as const), id: fc.string({ minLength: 1, maxLength: 40, unit: fc.constantFrom(...'abcXYZ019._:-'.split('')) }) }),
    fc.record({ type: fc.constant('cancel_all' as const), venue }),
    fc.record({ type: fc.constant('show' as const), topic: fc.constantFrom('positions' as const, 'balances' as const, 'orders' as const, 'risk' as const) }),
    fc.constant({ type: 'stop_all_agents' as const }), fc.constant({ type: 'kill' as const }),
  );
  it('parse(format(c)) = c for every command', () => {
    fc.assert(fc.property(command, (c) => { expect(parse(format(c))).toEqual({ ok: true, command: c }); }), { numRuns: 1000 });
  });
  it('format(parse(text)) is a fixed point; case and spacing do not matter', () => {
    fc.assert(fc.property(command, fc.boolean(), fc.integer({ min: 1, max: 4 }), (c, lower, spaces) => {
      const canonical = format(c);
      // an order id is case-sensitive: only the keywords and symbols are folded
      const text = (c.type === 'cancel_order' ? `${lower ? 'cancel order' : 'CANCEL ORDER'} ${c.id}` : lower ? canonical.toLowerCase() : canonical).split(' ').join(' '.repeat(spaces));
      const r = parse(text);
      expect(r.ok).toBe(true);
      if (r.ok) { expect(format(r.command)).toBe(canonical); expect(r.command).toEqual(c); }
    }), { numRuns: 500 });
  });
  it('fuzz: parse never throws, and whatever parses is a command the grammar can print back', () => {
    const words = ['BUY', 'SELL', 'LONG', 'SHORT', 'CLOSE', 'CANCEL', 'ORDER', 'ALL', 'ON', 'FOR', 'SHOW', 'POSITIONS', 'STOP', 'AGENTS', 'KILL', 'LIMIT', 'SL', 'TP', 'ETH', 'BTC-PERP', 'USDC', '100', '0.5', '50%', 'x3', 'gmx', '-1', '1e9', '%', 'x', '', '--', 'DROP TABLE'];
    // the last branch mixes real commands in (sometimes damaged), so that the 'it parsed' side of the property is exercised on every seed
    const text = fc.oneof(fc.string({ maxLength: 80 }), fc.tuple(command, fc.constantFrom('', '', ' x', ' 1e9', ' %')).map(([c, tail]) => format(c) + tail), fc.array(fc.constantFrom(...words), { maxLength: 9 }).map((w) => w.join(' ')), fc.array(fc.oneof(fc.constantFrom(...words), fc.string({ maxLength: 6 })), { maxLength: 8 }).map((w) => w.join(' ')));
    let parsed = 0;
    fc.assert(fc.property(text, (s) => {
      const r = parse(s);
      if (!r.ok) { expect(interpret(s, defaults, catalog, request).resolution).toBeNull(); return; }
      parsed += 1;
      expect(parse(format(r.command))).toEqual({ ok: true, command: r.command });
    }), { numRuns: 3000 });
    expect(parsed).toBeGreaterThan(0);                                                                     // the generator does reach valid commands
  });
  it('garbage never yields an order', () => {
    // text made only of characters and words that are not command verbs can never parse, so it can never resolve to an order
    const junk = fc.array(fc.oneof(fc.constantFrom('ETH', 'BTC-PERP', 'USDC', '100', '50%', 'x3', 'ON', 'ALL', 'ORDER', 'LIMIT', 'SL', 'TP', 'AGENTS', 'POSITIONS', 'gmx', 'please', 'now'), fc.string({ maxLength: 8, unit: fc.constantFrom(...'0123456789.%-_$#@!?,;:()[]{}<>*/\\\'"'.split('')) })), { maxLength: 10 }).map((w) => w.join(' '));
    fc.assert(fc.property(junk, (s) => {
      const out = interpret(s, defaults, catalog, request);
      expect(out.parsed.ok).toBe(false); expect(out.resolution).toBeNull();
    }), { numRuns: 2000 });
  });
  it('a valid command with trailing or leading junk is not an order', () => {
    fc.assert(fc.property(command, fc.constantFrom('!', 'please', ';', '&& KILL', '100', 'ETH', '--force'), fc.boolean(), (c, junk, before) => {
      if (c.type === 'perp_open' && !before && (junk === '100' || junk === 'ETH')) return;               // still a parse error, covered below
      const s = before ? `${junk} ${format(c)}` : `${format(c)} ${junk}`;
      expect(parse(s).ok).toBe(false);
    }), { numRuns: 500 });
    expect(parse('LONG BTC-PERP 1000 100').ok).toBe(false); expect(parse('LONG BTC-PERP 1000 ETH').ok).toBe(false);
  });
});

describe('command resolution — queries and controls', () => {
  it('queries and controls resolve without defaults', () => {
    expect(resolve(cmd('SHOW RISK'), {}, { instruments: [] }, request)).toEqual({ kind: 'query', query: 'risk' });
    expect(resolve(cmd('CANCEL ORDER abc'), {}, { instruments: [] }, request)).toEqual({ kind: 'control', control: { type: 'cancel_order', id: 'abc' } });
    expect(resolve(cmd('CANCEL ALL'), {}, { instruments: [] }, request)).toEqual({ kind: 'control', control: { type: 'cancel_all', venue: null } });
    expect(resolve(cmd('CANCEL ALL ON gmx'), {}, { instruments: [] }, request)).toEqual({ kind: 'control', control: { type: 'cancel_all', venue: 'gmx' } });
    expect(resolve(cmd('STOP ALL AGENTS'), {}, { instruments: [] }, request)).toEqual({ kind: 'control', control: { type: 'stop_all_agents' } });
    expect(resolve(cmd('KILL'), {}, { instruments: [] }, request)).toEqual({ kind: 'control', control: { type: 'kill_switch_on' } });
  });
});

describe('command resolution — orders', () => {
  it('BUY: a spot market order for a notional of the quote', () => {
    const r = orderOf(res('BUY ETH 100 USDC'));
    expect(r.order).toEqual({ v: 1, venue: 'kyberswap', network: 'base', instrument: 'kyberswap:WETH-USDC', marketKind: 'spot', side: 'buy', type: 'market', size: null, notional: '100', limitPrice: null, triggerPrice: null,
      reduceOnly: false, tif: 'ioc', maxSlippageBps: 50, maxFeeUsd: '0.1', leverage: null, marginMode: null, clientOrderId: clientOrderIdFor('kyberswap', request.principal, 'cmd-00000001'), mode: 'live',
      principal: { kind: 'owner', id: 'owner' }, mandateId: null, createdAt: NOW, expiresAt: NOW + 60_000 });
    expect(r.hash).toBe(canonicalOrderHashHex(r.order)); expect(r.attached).toEqual([]);
    expect(CanonicalOrderSchema.safeParse(r.order).success).toBe(true);
  });
  it('SELL: a quantity, or a share of the supplied balance, rounded down to the lot', () => {
    expect(orderOf(res('SELL ETH 0.5')).order).toMatchObject({ side: 'sell', size: '0.5', notional: null, instrument: 'kyberswap:WETH-USDC', maxFeeUsd: '1.25' });       // 0.5 × 2 500 × 10 bps
    expect(orderOf(res('SELL ETH 50%')).order.size).toBe('1.25');
    expect(orderOf(res('SELL ETH 33.333%')).order.size).toBe('0.8333');                                                                                                  // 0.833325 down to 0.0001
    expect(orderOf(res('SELL ETH 100%')).order.size).toBe('2.5');
    expect(orderOf(res('SELL ETH 1 FOR USDT', { ...defaults }, { ...catalog, referencePricesUsd: { ...catalog.referencePricesUsd, 'kyberswap:WETH-USDT': '2500' } })).order.instrument).toBe('kyberswap:WETH-USDT');
  });
  it('LONG / SHORT: a perp order by notional with the leverage of the command or of the defaults', () => {
    const r = orderOf(res('LONG BTC-PERP 1000'));
    expect(r.order).toMatchObject({ venue: 'hyperliquid', network: 'mainnet', instrument: 'hyperliquid:BTC', marketKind: 'perp', side: 'buy', type: 'market', notional: '1000', size: null, leverage: '3', marginMode: 'cross', tif: 'ioc',
      reduceOnly: false, maxFeeUsd: '1', maxSlippageBps: 50 });
    expect(orderOf(res('SHORT BTC-PERP 1000 x5 LIMIT 51000')).order).toMatchObject({ side: 'sell', type: 'limit', limitPrice: '51000', leverage: '5', tif: 'gtc' });
    expect(orderOf(res('LONG BTC-PERP 1000 ON gmx')).order).toMatchObject({ venue: 'gmx', network: 'arbitrum', instrument: 'gmx:BTC-USD' });
  });
  it('SL / TP become reduce-only trigger orders attached to the entry, with their own client ids', () => {
    const r = orderOf(res('LONG BTC-PERP 1000 LIMIT 50000 SL 48000 TP 55000'));
    expect(r.attached.map((a) => a.role)).toEqual(['stop_loss', 'take_profit']);
    expect(r.attached[0]!.order).toMatchObject({ side: 'sell', type: 'stop', triggerPrice: '48000', limitPrice: null, reduceOnly: true, notional: '1000', leverage: null, marginMode: null, tif: 'gtc' });
    expect(r.attached[1]!.order).toMatchObject({ side: 'sell', type: 'take_profit', triggerPrice: '55000', reduceOnly: true });
    expect(new Set([r.order.clientOrderId, ...r.attached.map((a) => a.order.clientOrderId)]).size).toBe(3);
    expect(r.attached.every((a) => a.hash === canonicalOrderHashHex(a.order) && CanonicalOrderSchema.safeParse(a.order).success)).toBe(true);
    const s = orderOf(res('SHORT ETH-PERP 500 SL 2700 TP 2300'));
    expect(s.attached.map((a) => a.order.side)).toEqual(['buy', 'buy']);
  });
  it('a stop or a target on the wrong side of the entry is refused', () => {
    expect(unresolvable(res('LONG BTC-PERP 1000 LIMIT 50000 SL 51000'))).toBe('inconsistent_prices');
    expect(unresolvable(res('LONG BTC-PERP 1000 LIMIT 50000 TP 49000'))).toBe('inconsistent_prices');
    expect(unresolvable(res('SHORT BTC-PERP 1000 SL 49000'))).toBe('inconsistent_prices');                                          // against the reference price 50 000
    expect(unresolvable(res('LONG BTC-PERP 1000 ON gmx SL 60000 TP 55000'))).toBe('inconsistent_prices');                           // no entry price known: still stop < target
    expect(orderOf(res('LONG BTC-PERP 1000 ON gmx SL 40000 TP 55000')).attached).toHaveLength(2);
  });
  it('CLOSE: a reduce-only market order against the supplied position', () => {
    expect(orderOf(res('CLOSE BTC-PERP')).order).toMatchObject({ side: 'sell', size: '0.5', reduceOnly: true, type: 'market', tif: 'ioc', leverage: null, marginMode: null, maxFeeUsd: '25' });
    expect(orderOf(res('CLOSE BTC-PERP 25%')).order.size).toBe('0.125');
    expect(orderOf(res('CLOSE ETH-PERP 50%')).order).toMatchObject({ side: 'buy', size: '1.66' });                                   // 1.6665 down to the lot 0.01
    expect(orderOf(res('CLOSE ETH-PERP 100%')).order.size).toBe('3.333');
    expect(unresolvable(res('CLOSE BTC-PERP ON gmx'))).toBe('no_position');
    expect(unresolvable(res('CLOSE ETH-PERP 0.1%'))).toBe('zero_size');
  });
  it('an agent or API key carries its mandate; the mode is the request\'s', () => {
    const r = orderOf(res('LONG BTC-PERP 1000', defaults, catalog, { ...request, principal: { kind: 'agent', id: 'agent-1' }, mandateId: '6f1d2c3a-4b5e-4f70-8a91-b2c3d4e5f601', mode: 'paper' }));
    expect(r.order).toMatchObject({ principal: { kind: 'agent', id: 'agent-1' }, mandateId: '6f1d2c3a-4b5e-4f70-8a91-b2c3d4e5f601', mode: 'paper' });
    expect(unresolvable(res('LONG BTC-PERP 1000', defaults, catalog, { ...request, principal: { kind: 'agent', id: 'agent-1' } }))).toBe('invalid_order');
  });
});

describe('command resolution — ambiguity is asked, never guessed', () => {
  it('with no defaults at all, every open point is a question', () => {
    expect(questions(res('BUY ETH 100 USDC', {}))).toEqual(['venue', 'network', 'maxFeeBps', 'maxSlippageBps', 'orderTtlMs']);
    expect(questions(res('SELL ETH 1', {}))).toEqual(['quote', 'venue', 'network', 'maxFeeBps', 'maxSlippageBps', 'orderTtlMs']);
    expect(questions(res('LONG BTC-PERP 1000', {}))).toEqual(['venue', 'network', 'leverage', 'marginMode', 'maxFeeBps', 'maxSlippageBps', 'orderTtlMs']);
    expect(questions(res('CLOSE BTC-PERP', {}))).toEqual(['venue', 'network', 'maxFeeBps', 'maxSlippageBps', 'orderTtlMs']);
  });
  it('lists the candidates it knows', () => {
    const r = res('LONG BTC-PERP 1000', {});
    if (r.kind !== 'ambiguous') throw new Error('expected questions');
    expect(r.questions.find((q) => q.field === 'venue')!.options).toEqual(['gmx', 'hyperliquid']);
    expect(r.questions.find((q) => q.field === 'marginMode')!.options).toEqual(['cross', 'isolated']);
    const s = res('SELL ETH 1', { ...defaults, spotQuote: undefined });
    if (s.kind !== 'ambiguous') throw new Error('expected questions');
    expect(s.questions).toEqual([expect.objectContaining({ field: 'quote', options: ['USDC', 'USDT'] })]);
  });
  it('a venue is never inferred, even when only one venue lists the asset', () => {
    expect(questions(res('LONG ETH-PERP 100', { ...defaults, perpVenue: undefined }))).toEqual(['venue', 'network']);
    expect(questions(res('BUY ETH 100 USDC', { ...defaults, spotVenueByNetwork: {} }))).toEqual(['venue']);
  });
  it('the network of a perp venue comes from the defaults: mainnet is never assumed', () => {
    expect(questions(res('LONG BTC-PERP 1000', { ...defaults, perpNetworkByVenue: { gmx: 'arbitrum' } }))).toEqual(['network']);
    expect(orderOf(res('LONG BTC-PERP 1000', { ...defaults, perpNetworkByVenue: { hyperliquid: 'testnet' } })).order.network).toBe('testnet');
  });
  it('several instruments for one symbol → a question with the candidates', () => {
    const r = res('BUY BTC 100 USDC');
    if (r.kind !== 'ambiguous') throw new Error('expected a question');
    expect(r.questions).toEqual([expect.objectContaining({ field: 'instrument', options: ['kyberswap:WBTC-USDC', 'kyberswap:cbBTC-USDC'] })]);
  });
  it('the command overrides the default venue; the fee cap, slippage and leverage are never invented', () => {
    expect(orderOf(res('LONG BTC-PERP 1000 ON gmx')).order.venue).toBe('gmx');
    expect(questions(res('LONG BTC-PERP 1000', { ...defaults, maxFeeBps: undefined }))).toEqual(['maxFeeBps']);
    expect(questions(res('LONG BTC-PERP 1000', { ...defaults, maxSlippageBps: undefined }))).toEqual(['maxSlippageBps']);
    expect(questions(res('LONG BTC-PERP 1000', { ...defaults, perpLeverage: undefined }))).toEqual(['leverage']);
    expect(orderOf(res('LONG BTC-PERP 1000 x2', { ...defaults, perpLeverage: undefined })).order.leverage).toBe('2');
    expect(questions(res('LONG BTC-PERP 1000', { ...defaults, maxFeeBps: 1.5 }))).toEqual(['maxFeeBps']);
    expect(questions(res('LONG BTC-PERP 1000', { ...defaults, orderTtlMs: 0 }))).toEqual(['orderTtlMs']);
  });
  it('what cannot be resolved at all says why', () => {
    expect(unresolvable(res('BUY DOGE 100 USDC'))).toBe('no_instrument');
    expect(unresolvable(res('LONG DOGE-PERP 100'))).toBe('no_instrument');
    expect(unresolvable(res('LONG ETH-PERP 100 ON gmx'))).toBe('no_instrument');
    expect(unresolvable(res('SELL ETH 50%', defaults, { ...catalog, balances: [] }))).toBe('missing_balance');
    expect(unresolvable(res('SELL ETH 50%', defaults, { ...catalog, balances: [{ network: 'arbitrum', asset: 'ETH', amount: '9' }] }))).toBe('missing_balance');
    expect(unresolvable(res('SELL ETH 1', defaults, { ...catalog, referencePricesUsd: {} }))).toBe('missing_reference_price');
    expect(unresolvable(res('CLOSE BTC-PERP', defaults, { ...catalog, referencePricesUsd: {} }))).toBe('missing_reference_price');
    expect(unresolvable(res('BUY ETH 100 USDC', { ...defaults, usdQuotes: [] }))).toBe('fee_cap_not_expressible');
    expect(unresolvable(res('SELL ETH 0.00001'))).toBe('zero_size');
    expect(unresolvable(res('LONG BTC-PERP 1000', defaults, { ...catalog, instruments: [{ id: 'edgex:BTC', venue: 'edgex', network: 'mainnet', marketKind: 'perp', base: 'BTC', quote: 'USD' }] }, request))).toBe('no_instrument');
    expect(unresolvable(res('LONG BTC-PERP 1000 ON edgex', { ...defaults, perpNetworkByVenue: { edgex: 'mainnet' } }, { ...catalog, instruments: [{ id: 'edgex:BTC', venue: 'edgex', network: 'mainnet', marketKind: 'perp', base: 'BTC', quote: 'USD' }] }))).toBe('no_client_id_format');
  });
});

describe('command resolution — determinism', () => {
  const texts = ['BUY ETH 100 USDC', 'SELL ETH 50%', 'LONG BTC-PERP 1000 x5 LIMIT 49000 SL 45000 TP 60000', 'SHORT ETH-PERP 250', 'CLOSE BTC-PERP 25%'];
  it.each(texts)('%s: same command + same defaults → same canonical hash, every time', (t) => {
    const a = orderOf(res(t)), b = orderOf(res(t)), c = orderOf(resolve(cmd(t.toLowerCase().replace(/ /g, '   ')), { ...defaults }, JSON.parse(JSON.stringify(catalog)) as Catalog, { ...request }));
    expect(a.hash).toBe(b.hash); expect(a.hash).toBe(c.hash); expect(a).toEqual(c);
    expect(a.attached.map((x) => x.hash)).toEqual(c.attached.map((x) => x.hash));
  });
  it('French and English spellings of one command give the same hash', () => {
    expect(orderOf(res('acheter eth 100 usdc sur kyberswap')).hash).toBe(orderOf(res('BUY ETH 100 USDC ON kyberswap')).hash);
    expect(orderOf(res('fermer btc-perp 25%')).hash).toBe(orderOf(res('CLOSE BTC-PERP 25%')).hash);
  });
  it('different defaults, clock or idempotency key → a different hash', () => {
    const base = orderOf(res('LONG BTC-PERP 1000')).hash;
    expect(orderOf(res('LONG BTC-PERP 1000', { ...defaults, maxSlippageBps: 51 })).hash).not.toBe(base);
    expect(orderOf(res('LONG BTC-PERP 1000', { ...defaults, maxFeeBps: 11 })).hash).not.toBe(base);
    expect(orderOf(res('LONG BTC-PERP 1000', { ...defaults, perpLeverage: '4' })).hash).not.toBe(base);
    expect(orderOf(res('LONG BTC-PERP 1000', defaults, catalog, { ...request, now: NOW + 1 })).hash).not.toBe(base);
    expect(orderOf(res('LONG BTC-PERP 1000', defaults, catalog, { ...request, idempotencyKey: 'cmd-00000002' })).hash).not.toBe(base);
  });
  it('property: resolution is a pure function of its four inputs', () => {
    fc.assert(fc.property(fc.constantFrom(...texts, 'SHOW RISK', 'KILL', 'BUY BTC 5 USDC', 'LONG DOGE-PERP 5'), fc.integer({ min: 0, max: 200 }), fc.boolean(), (t, slip, dropVenue) => {
      const d = { ...defaults, maxSlippageBps: slip, ...(dropVenue ? { perpVenue: undefined, spotVenueByNetwork: {} } : {}) };
      expect(resolve(cmd(t), d, catalog, request)).toEqual(resolve(cmd(t), { ...d }, { ...catalog }, { ...request }));
    }), { numRuns: 200 });
  });
});
