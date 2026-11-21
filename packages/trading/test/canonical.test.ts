/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading/test/canonical.test.ts
 * Module           : trading
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
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

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { canonicalBytes, type Intent } from '@spw/core';
import { VenueOrderSchema } from '@spw/derivatives/live';
import {
  canonicalOrder, canonicalOrderBytes, canonicalOrderFields, canonicalOrderHash, canonicalOrderHashHex, canonicalOrderJson, CanonicalOrderSchema, highestNamedPrice, ORDER_BODY_EXCLUDED, ORDER_DOMAIN,
  ORDER_MAX_TTL_MS, orderBodyHashHex, parseCanonicalOrderJson, toOrderRequest, type CanonicalOrderInput,
} from '../src/index.ts';
import { NOW, order } from './fixtures.ts';

/** decoder of the framing shared with packages/core/src/intent.ts: domain, 0x00, then [u16 name length][u32 value length] name value */
function decode(bytes: Uint8Array): { domain: string; fields: [string, string][] } {
  const dec = new TextDecoder(), zero = bytes.indexOf(0), fields: [string, string][] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = zero + 1;
  while (at < bytes.length) {
    const kl = view.getUint16(at), vl = view.getUint32(at + 2); at += 6;
    fields.push([dec.decode(bytes.subarray(at, at + kl)), dec.decode(bytes.subarray(at + kl, at + kl + vl))]); at += kl + vl;
  }
  return { domain: dec.decode(bytes.subarray(0, zero)), fields };
}

describe('canonical order — schema', () => {
  it('accepts a well-formed order and normalizes its decimals', () => {
    const o = canonicalOrder(order({ size: '0.100', limitPrice: '50000.0', maxFeeUsd: '5.00', leverage: '3.0' }));
    expect(o.size).toBe('0.1'); expect(o.limitPrice).toBe('50000'); expect(o.maxFeeUsd).toBe('5'); expect(o.leverage).toBe('3');
  });
  const bad: [string, Partial<CanonicalOrderInput>][] = [
    ['both size and notional', { notional: '100' }],
    ['neither size nor notional', { size: null }],
    ['a limit order without a price', { limitPrice: null }],
    ['a market order with a limit price', { type: 'market' }],
    ['a stop without a trigger', { type: 'stop' }],
    ['a limit order with a trigger', { triggerPrice: '49000' }],
    ['an instrument of another venue', { instrument: 'gmx:BTC-USD' }],
    ['an instrument without a symbol', { instrument: 'hyperliquid:' }],
    ['spot with leverage', { marketKind: 'spot', marginMode: null }],
    ['spot with a margin mode', { marketKind: 'spot', leverage: null }],
    ['spot reduce-only', { marketKind: 'spot', leverage: null, marginMode: null, reduceOnly: true }],
    ['an agent without a mandate', { mandateId: null }],
    ['the owner with a mandate', { principal: { kind: 'owner', id: 'owner' } }],
    ['expiry not after creation', { expiresAt: NOW }],
    ['a validity above the maximum', { expiresAt: NOW + ORDER_MAX_TTL_MS + 1 }],
    ['a negative size', { size: '-1' }],
    ['a zero size', { size: '0' }],
    ['a float-looking size', { size: '1e3' }],
    ['a number as a size', { size: 1 as unknown as string }],
    ['a slippage that is not an integer', { maxSlippageBps: 1.5 }],
    ['an unknown field', { extra: 1 } as Partial<CanonicalOrderInput>],
    ['an unknown tif', { tif: 'fok' as 'gtc' }],
    ['an upper-case venue', { venue: 'Hyperliquid' }],
  ];
  it.each(bad)('refuses %s', (_name, over) => { expect(CanonicalOrderSchema.safeParse(order(over)).success).toBe(false); });
  it('accepts spot, market, stop-limit, notional and owner orders', () => {
    expect(CanonicalOrderSchema.safeParse(order({ venue: 'kyberswap', network: 'base', instrument: 'kyberswap:WETH-USDC', marketKind: 'spot', leverage: null, marginMode: null, type: 'market', limitPrice: null, tif: 'ioc' })).success).toBe(true);
    expect(CanonicalOrderSchema.safeParse(order({ type: 'stop', triggerPrice: '49000' })).success).toBe(true);
    expect(CanonicalOrderSchema.safeParse(order({ type: 'take_profit', triggerPrice: '55000', limitPrice: null })).success).toBe(true);
    expect(CanonicalOrderSchema.safeParse(order({ size: null, notional: '1000' })).success).toBe(true);
    expect(CanonicalOrderSchema.safeParse(order({ principal: { kind: 'owner', id: 'owner' }, mandateId: null })).success).toBe(true);
  });
});

describe('canonical order — bytes and hash', () => {
  it('uses the framing of packages/core/src/intent.ts', () => {
    const intent: Intent = { v: 1, proposalId: '6f1d2c3a-4b5e-4f70-8a91-b2c3d4e5f601', keyId: 'owner-key-0001', network: 'ethereum', chainRef: '1', asset: 'native', symbol: 'ETH', decimals: 18, amount: '1000',
      from: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222', maxFee: '1', createdAt: 1_800_000_000, expiresAt: 1_800_000_300, policyVersion: 1,
      evm: { nonce: 0, gasLimit: '21000', maxFeePerGas: '1', maxPriorityFeePerGas: '1' } };
    const core = decode(canonicalBytes(intent));
    expect(core.domain).toBe('SPW-INTENT-v1');
    expect(core.fields.slice(0, 3)).toEqual([['v', '1'], ['proposalId', intent.proposalId], ['keyId', intent.keyId]]);
    const mine = decode(canonicalOrderBytes(order()));
    expect(mine.domain).toBe(ORDER_DOMAIN);
    expect(mine.fields).toEqual(canonicalOrderFields(order()));
  });
  it('is pinned: the bytes of a known order hash to a known value', () => {
    expect(canonicalOrderHashHex(order())).toBe('f40ee88eb7d3912ebb689ef89e2d4b452b80fcb33cd816e6b20459c660c3d5cd');
    // independently: SHA-256 (node:crypto) of bytes framed by this test's own encoder from the field list
    const enc = new TextEncoder(), parts: Buffer[] = [Buffer.from(ORDER_DOMAIN), Buffer.from([0])];
    for (const [k, v] of canonicalOrderFields(order())) { const h = Buffer.alloc(6); h.writeUInt16BE(enc.encode(k).length, 0); h.writeUInt32BE(enc.encode(v).length, 2); parts.push(h, Buffer.from(k), Buffer.from(v)); }
    expect(createHash('sha256').update(Buffer.concat(parts)).digest('hex')).toBe(canonicalOrderHashHex(order()));
    expect(canonicalOrderFields(order())).toEqual([
      ['v', '1'], ['venue', 'hyperliquid'], ['network', 'mainnet'], ['instrument', 'hyperliquid:BTC'], ['marketKind', 'perp'], ['side', 'buy'], ['type', 'limit'], ['size', '0.1'], ['notional', ''], ['limitPrice', '50000'],
      ['triggerPrice', ''], ['reduceOnly', '0'], ['tif', 'gtc'], ['maxSlippageBps', '50'], ['maxFeeUsd', '5'], ['leverage', '3'], ['marginMode', 'cross'], ['mode', 'live'], ['principal.kind', 'agent'], ['principal.id', 'agent-1'],
      ['mandateId', '6f1d2c3a-4b5e-4f70-8a91-b2c3d4e5f601'], ['clientOrderId', '0x0123456789abcdef0123456789abcdef'], ['createdAt', '1800000000000'], ['expiresAt', '1800000060000'],
    ]);
  });
  it('gives 32 bytes, the same for equal orders and for equivalent decimal spellings', () => {
    expect(canonicalOrderHash(order())).toHaveLength(32);
    expect(canonicalOrderHashHex(order())).toBe(canonicalOrderHashHex(order()));
    expect(canonicalOrderHashHex(order({ size: '0.10', limitPrice: '50000.00' }))).toBe(canonicalOrderHashHex(order()));
  });
  it('covers every field of the schema exactly once', () => {
    const names = canonicalOrderFields(order()).map(([k]) => k.split('.')[0]!);
    expect([...new Set(names)].sort()).toEqual(Object.keys(CanonicalOrderSchema.shape).sort());
    expect(new Set(canonicalOrderFields(order()).map(([k]) => k)).size).toBe(canonicalOrderFields(order()).length);
  });
  const changes: Partial<CanonicalOrderInput>[] = [
    { venue: 'gmx', instrument: 'gmx:BTC' }, { network: 'testnet' }, { instrument: 'hyperliquid:ETH' }, { side: 'sell' }, { type: 'stop', triggerPrice: '49000' }, { size: '0.2' }, { size: null, notional: '0.1' },
    { limitPrice: '50001' }, { reduceOnly: true }, { tif: 'alo' }, { maxSlippageBps: 51 }, { maxFeeUsd: '6' }, { leverage: '4' }, { leverage: null }, { marginMode: 'isolated' }, { marginMode: null },
    { clientOrderId: '0x0123456789abcdef0123456789abcdee' }, { mode: 'paper' }, { principal: { kind: 'api_key', id: 'agent-1' } }, { principal: { kind: 'agent', id: 'agent-2' } },
    { mandateId: '6f1d2c3a-4b5e-4f70-8a91-b2c3d4e5f602' }, { createdAt: NOW + 1 }, { expiresAt: NOW + 60_001 },
  ];
  it.each(changes)('changes with %j', (over) => { expect(canonicalOrderHashHex(order(over))).not.toBe(canonicalOrderHashHex(order())); });
  it('never confuses a size with a notional of the same value, or an empty field with its neighbour', () => {
    expect(canonicalOrderHashHex(order({ size: '100', notional: null, limitPrice: '50000' }))).not.toBe(canonicalOrderHashHex(order({ size: null, notional: '100', limitPrice: '50000' })));
  });
  it('body hash ignores exactly the excluded fields', () => {
    expect(ORDER_BODY_EXCLUDED).toEqual(['clientOrderId', 'createdAt', 'expiresAt']);
    expect(orderBodyHashHex(order({ clientOrderId: 'another-client-id', createdAt: NOW + 5, expiresAt: NOW + 70_000 }))).toBe(orderBodyHashHex(order()));
    for (const over of changes) {
      const keys = Object.keys(over);
      if (keys.every((k) => (ORDER_BODY_EXCLUDED as readonly string[]).includes(k))) continue;
      expect(orderBodyHashHex(order(over))).not.toBe(orderBodyHashHex(order()));
    }
  });
  it('property: two orders have the same hash exactly when their canonical fields are equal', () => {
    const dec = fc.tuple(fc.integer({ min: 1, max: 999_999 }), fc.integer({ min: 0, max: 999 })).map(([a, b]) => (b === 0 ? String(a) : `${a}.${String(b).padStart(3, '0')}`));
    const arb = fc.record({ size: dec, limitPrice: dec, side: fc.constantFrom('buy' as const, 'sell' as const), reduceOnly: fc.boolean(), maxSlippageBps: fc.integer({ min: 0, max: 10_000 }), tif: fc.constantFrom('gtc' as const, 'ioc' as const, 'alo' as const) });
    fc.assert(fc.property(arb, arb, (a, b) => {
      const x = order(a), y = order(b);
      const same = JSON.stringify(canonicalOrderFields(x)) === JSON.stringify(canonicalOrderFields(y));
      expect(canonicalOrderHashHex(x) === canonicalOrderHashHex(y)).toBe(same);
    }), { numRuns: 300 });
  });
});

describe('canonical order — JSON', () => {
  it('has a fixed key order, canonical decimals and explicit nulls', () => {
    const shuffled = Object.fromEntries(Object.entries(order({ size: '0.10' })).reverse()) as CanonicalOrderInput;
    const json = canonicalOrderJson(shuffled);
    expect(json).toBe(canonicalOrderJson(order()));
    expect(Object.keys(JSON.parse(json) as object)).toEqual(Object.keys(CanonicalOrderSchema.shape));
    expect(json).toContain('"notional":null');
    expect(json).not.toMatch(/\s/);
  });
  it('round-trips', () => {
    const o = canonicalOrder(order());
    expect(parseCanonicalOrderJson(canonicalOrderJson(o))).toEqual(o);
    expect(canonicalOrderHashHex(parseCanonicalOrderJson(canonicalOrderJson(o)))).toBe(canonicalOrderHashHex(o));
  });
  it('refuses JSON that is not a canonical order', () => { expect(() => parseCanonicalOrderJson('{"v":1}')).toThrow(); });
});

describe('canonical order — helpers', () => {
  it('highestNamedPrice', () => {
    expect(highestNamedPrice({ limitPrice: null, triggerPrice: null })).toBeNull();
    expect(highestNamedPrice({ limitPrice: '10', triggerPrice: null })).toBe('10');
    expect(highestNamedPrice({ limitPrice: '10', triggerPrice: '12' })).toBe('12');
  });
  it('maps to the derivatives OrderRequest', () => {
    const req = toOrderRequest(canonicalOrder(order()), { size: '0.1', worstPrice: null });
    expect(req).toEqual({ instrument: 'hyperliquid:BTC', side: 'buy', type: 'limit', size: '0.1', price: '50000', triggerPrice: null, reduceOnly: false, tif: 'gtc', clientId: '0x0123456789abcdef0123456789abcdef' });
    expect(VenueOrderSchema.shape.clientId.safeParse(req.clientId).success).toBe(true);
    expect(toOrderRequest(canonicalOrder(order({ type: 'market', limitPrice: null, tif: 'ioc' })), { size: '0.1', worstPrice: '50250' })).toMatchObject({ type: 'market', price: '50250' });
    expect(toOrderRequest(canonicalOrder(order({ type: 'stop', triggerPrice: '49000', limitPrice: null })), { size: '0.1', worstPrice: '48755' }).type).toBe('stop_market');
    expect(toOrderRequest(canonicalOrder(order({ type: 'stop', triggerPrice: '49000' })), { size: '0.1', worstPrice: null }).type).toBe('stop_limit');
    expect(toOrderRequest(canonicalOrder(order({ type: 'take_profit', triggerPrice: '55000', limitPrice: null })), { size: '0.1', worstPrice: '54725' }).type).toBe('take_profit_market');
    expect(toOrderRequest(canonicalOrder(order({ type: 'take_profit', triggerPrice: '55000' })), { size: '0.1', worstPrice: null }).type).toBe('take_profit_limit');
    expect(() => toOrderRequest(canonicalOrder(order({ type: 'market', limitPrice: null })), { size: '0.1', worstPrice: null })).toThrow(/worst acceptable price/);
    expect(() => toOrderRequest(canonicalOrder(order({ venue: 'kyberswap', network: 'base', instrument: 'kyberswap:WETH-USDC', marketKind: 'spot', leverage: null, marginMode: null })), { size: '1', worstPrice: null })).toThrow(/perp/);
  });
});
