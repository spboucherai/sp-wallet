/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading/test/idempotency.test.ts
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

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { hlCloid, VenueOrderSchema } from '@spw/derivatives/live';
import { CLIENT_ORDER_ID_FORMATS, clientOrderIdFor, dedupe, dedupeOrder, deriveClientOrderId, formatClientOrderId, IdempotencyError, orderBodyHashHex, type Principal } from '../src/index.ts';
import { NOW, order } from './fixtures.ts';

const agent: Principal = { kind: 'agent', id: 'agent-1' };

describe('client order id', () => {
  it('is deterministic, 256-bit hex, and separates principals and keys', () => {
    const id = deriveClientOrderId(agent, 'key-00000001');
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveClientOrderId(agent, 'key-00000001')).toBe(id);
    expect(deriveClientOrderId(agent, 'key-00000002')).not.toBe(id);
    expect(deriveClientOrderId({ kind: 'agent', id: 'agent-2' }, 'key-00000001')).not.toBe(id);
    expect(deriveClientOrderId({ kind: 'api_key', id: 'agent-1' }, 'key-00000001')).not.toBe(id);
    // length-prefixed fields: moving a character between the principal id and the key gives another id
    expect(deriveClientOrderId({ kind: 'agent', id: 'ab' }, 'cdefghij')).not.toBe(deriveClientOrderId({ kind: 'agent', id: 'abc' }, 'defghijk'));
  });
  it('is pinned', () => { expect(deriveClientOrderId(agent, 'key-00000001')).toBe('9c054762fdb755f5a02d35dd6b84d62ca957b9b7d1852e329746fb91fa5e8fe6'); });
  it('refuses a bad key or principal', () => {
    for (const k of ['short', 'x'.repeat(101), 'has space in it', 'tab\there-0000', '']) expect(() => deriveClientOrderId(agent, k)).toThrow(IdempotencyError);
    expect(() => deriveClientOrderId({ kind: 'robot', id: 'x' } as unknown as Principal, 'key-00000001')).toThrow();
  });
  it('Hyperliquid: 128-bit hex that the adapter passes through unchanged and the signer schema accepts', () => {
    const cloid = clientOrderIdFor('hyperliquid', agent, 'key-00000001');
    expect(cloid).toMatch(/^0x[0-9a-f]{32}$/);
    expect(cloid).toBe(`0x${deriveClientOrderId(agent, 'key-00000001').slice(0, 32)}`);
    expect(hlCloid(cloid)).toBe(cloid);
    expect(VenueOrderSchema.shape.clientId.safeParse(cloid).success).toBe(true);
  });
  it('other venues: the documented forms', () => {
    const id = deriveClientOrderId(agent, 'key-00000001');
    expect(formatClientOrderId('gmx', id)).toBe(id);
    expect(formatClientOrderId('paper', id)).toBe(id);
    expect(formatClientOrderId('dydx', id)).toBe(String(Number.parseInt(id.slice(0, 8), 16)));
    expect(Number(formatClientOrderId('dydx', 'f'.repeat(64)))).toBe(2 ** 32 - 1);
    for (const v of Object.keys(CLIENT_ORDER_ID_FORMATS)) expect(CLIENT_ORDER_ID_FORMATS[v]!.note.length).toBeGreaterThan(5);
  });
  it('a venue without a format is an error, never a default', () => {
    expect(() => clientOrderIdFor('edgex', agent, 'key-00000001')).toThrow(/no client order id format/);
    expect(() => clientOrderIdFor('constructor', agent, 'key-00000001')).toThrow(IdempotencyError);
    expect(clientOrderIdFor('edgex', agent, 'key-00000001', { edgex: { bits: 64, format: (id) => id.slice(0, 16), note: 'test' } })).toHaveLength(16);
    expect(() => formatClientOrderId('gmx', 'not-hex')).toThrow(IdempotencyError);
  });
  it('property: distinct (principal, key) pairs give distinct ids', () => {
    const key = fc.string({ minLength: 8, maxLength: 40, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')) });
    const who = fc.record({ kind: fc.constantFrom('agent' as const, 'api_key' as const, 'owner' as const), id: fc.string({ minLength: 1, maxLength: 12, unit: fc.constantFrom(...'abc123.:-_'.split('')) }) });
    fc.assert(fc.property(who, key, who, key, (p1, k1, p2, k2) => {
      const same = p1.kind === p2.kind && p1.id === p2.id && k1 === k2;
      expect(deriveClientOrderId(p1, k1) === deriveClientOrderId(p2, k2)).toBe(same);
    }), { numRuns: 300 });
  });
});

describe('dedupe', () => {
  const rec = { clientOrderId: '0xabc', bodyHash: orderBodyHashHex(order()) };
  it('no record: a new order', () => { expect(dedupeOrder(null, order())).toEqual({ kind: 'new' }); });
  it('same key, same body: the same order — even when the retry is stamped later', () => {
    expect(dedupeOrder(rec, order())).toEqual({ kind: 'same', clientOrderId: '0xabc' });
    expect(dedupeOrder(rec, order({ createdAt: NOW + 3_000, expiresAt: NOW + 63_000 }))).toEqual({ kind: 'same', clientOrderId: '0xabc' });
    expect(dedupeOrder(rec, order({ size: '0.10' }))).toEqual({ kind: 'same', clientOrderId: '0xabc' });
  });
  it('same key, different body: a conflict', () => {
    for (const over of [{ size: '0.2' }, { side: 'sell' as const }, { limitPrice: '50001' }, { reduceOnly: true }, { mode: 'paper' as const }, { instrument: 'hyperliquid:ETH' }]) {
      const r = dedupeOrder(rec, order(over));
      expect(r.kind).toBe('conflict');
      if (r.kind === 'conflict') { expect(r.existingBodyHash).toBe(rec.bodyHash); expect(r.incomingBodyHash).toBe(orderBodyHashHex(order(over))); }
    }
    expect(dedupe(rec, { bodyHash: 'x' }).kind).toBe('conflict');
  });
});
