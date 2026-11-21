/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/test/decimal.test.ts
 * Module           : derivatives
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
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
import { D, DEC_RE, MAX_DIGITS, type Dec } from '../src/index.ts';
import { d, prng, randDec, randDecStr, randInt, s } from './helpers.ts';

const N = 400;

describe('decimal: parsing', () => {
  it('accepts canonical decimals and normalises the output', () => {
    const cases: [string, string][] = [
      ['0', '0'], ['-0', '0'], ['-0.000', '0'], ['0.0', '0'], ['1', '1'], ['-1', '-1'], ['1.50', '1.5'], ['1.05', '1.05'], ['100', '100'],
      ['0.001', '0.001'], ['-0.001', '-0.001'], ['123456789.123456789', '123456789.123456789'], ['10.0100', '10.01'], ['1000000.000000', '1000000'],
    ];
    for (const [input, out] of cases) expect(s(D.from(input)), input).toBe(out);
  });

  it('rejects everything that is not a canonical decimal string', () => {
    const bad = ['', ' ', '+1', '1e5', '1E5', '1e-5', 'NaN', 'Infinity', '-Infinity', '.5', '1.', '01', '00', '-01', ' 1', '1 ', '--1', '1,5', '1.2.3', '0x10', '1_000', '-', '.', '-.5', '1n', '１', '1\n'];
    for (const x of bad) expect(() => D.from(x), JSON.stringify(x)).toThrow(RangeError);
  });

  it('enforces the digit limit', () => {
    const ok = '9'.repeat(MAX_DIGITS);
    expect(s(D.from(ok))).toBe(ok);
    expect(s(D.from(`${'9'.repeat(30)}.${'9'.repeat(MAX_DIGITS - 30)}`))).toBe(`${'9'.repeat(30)}.${'9'.repeat(MAX_DIGITS - 30)}`);
    expect(() => D.from('9'.repeat(MAX_DIGITS + 1))).toThrow(RangeError);
    expect(() => D.from(`1.${'0'.repeat(MAX_DIGITS)}`)).toThrow(RangeError);
    expect(() => D.from('1'.repeat(5000))).toThrow(RangeError);
  });

  it('refuses numbers and other types at run time', () => {
    for (const x of [1, 1.5, NaN, null, undefined, true, {}, { m: 1, s: 0 }, { m: 1n, s: -1 }, { m: 1n, s: 1.5 }]) {
      expect(() => D.from(x as unknown as string)).toThrow(TypeError);
    }
  });

  it('builds from bigint and from a (possibly unnormalised) Dec', () => {
    expect(s(D.from(42n))).toBe('42');
    expect(s(D.from(-7n))).toBe('-7');
    expect(s(D.from({ m: 1500n, s: 3 }))).toBe('1.5');
    expect(D.from({ m: 1500n, s: 3 })).toEqual({ m: 15n, s: 1 });
    expect(s({ m: 0n, s: 5 })).toBe('0');
    expect(s({ m: -5n, s: 3 })).toBe('-0.005');
  });

  it('isValid mirrors from()', () => {
    expect(D.isValid('1.5')).toBe(true);
    expect(D.isValid('1e5')).toBe(false);
    expect(D.isValid(1.5)).toBe(false);
    expect(D.isValid('9'.repeat(MAX_DIGITS + 1))).toBe(false);
  });
});

describe('decimal: arithmetic examples', () => {
  it('adds, subtracts and multiplies exactly', () => {
    expect(s(D.add(d('0.1'), d('0.2')))).toBe('0.3');
    expect(s(D.sub(d('0.3'), d('0.1')))).toBe('0.2');
    expect(s(D.mul(d('0.1'), d('0.2')))).toBe('0.02');
    expect(s(D.mul(d('-1.5'), d('4')))).toBe('-6');
    expect(s(D.sub(d('1'), d('1.000000000000000001')))).toBe('-0.000000000000000001');
    expect(s(D.mul(d('123456789012345678901234567890'), d('0.000000000000000000000000000001')))).toBe('0.12345678901234567890123456789');
  });

  it('never prints -0', () => {
    expect(s(D.neg(d('0')))).toBe('0');
    expect(s(D.mul(d('-1'), d('0')))).toBe('0');
    expect(s(D.sub(d('-1.5'), d('-1.5')))).toBe('0');
    expect(s(D.div(d('-1'), d('3'), 0, 'down'))).toBe('0');
    expect(s(D.quantize(d('-0.4'), d('1'), 'down'))).toBe('0');
  });

  it('divides with an explicit scale and rounding mode', () => {
    expect(s(D.div(d('1'), d('3'), 4, 'down'))).toBe('0.3333');
    expect(s(D.div(d('1'), d('3'), 4, 'up'))).toBe('0.3334');
    expect(s(D.div(d('1'), d('3'), 4, 'half_even'))).toBe('0.3333');
    expect(s(D.div(d('2'), d('3'), 4, 'half_even'))).toBe('0.6667');
    expect(s(D.div(d('-1'), d('3'), 4, 'down'))).toBe('-0.3333');      // towards zero
    expect(s(D.div(d('-1'), d('3'), 4, 'up'))).toBe('-0.3334');        // away from zero
    expect(s(D.div(d('1'), d('-3'), 4, 'up'))).toBe('-0.3334');
    expect(s(D.div(d('-1'), d('-3'), 4, 'up'))).toBe('0.3334');
    expect(s(D.div(d('10'), d('4'), 0, 'down'))).toBe('2');
    expect(s(D.div(d('10'), d('4'), 0, 'up'))).toBe('3');
    expect(s(D.div(d('6'), d('3'), 0, 'up'))).toBe('2');               // exact: no rounding in any mode
    expect(s(D.div(d('0.006'), d('0.3'), 2, 'up'))).toBe('0.02');
    expect(s(D.div(d('0'), d('7'), 5, 'up'))).toBe('0');
  });

  it('half_even breaks ties to the even digit', () => {
    expect(s(D.div(d('0.125'), d('1'), 2, 'half_even'))).toBe('0.12');
    expect(s(D.div(d('0.135'), d('1'), 2, 'half_even'))).toBe('0.14');
    expect(s(D.div(d('0.375'), d('1'), 2, 'half_even'))).toBe('0.38');
    expect(s(D.div(d('-0.125'), d('1'), 2, 'half_even'))).toBe('-0.12');
    expect(s(D.div(d('-0.135'), d('1'), 2, 'half_even'))).toBe('-0.14');
    expect(s(D.div(d('5'), d('2'), 0, 'half_even'))).toBe('2');
    expect(s(D.div(d('7'), d('2'), 0, 'half_even'))).toBe('4');
    expect(s(D.div(d('0.1251'), d('1'), 2, 'half_even'))).toBe('0.13');
  });

  it('refuses division by zero and bad scales or modes', () => {
    expect(() => D.div(d('1'), d('0'), 2, 'down')).toThrow(/division by zero/);
    expect(() => D.div(d('1'), d('3'), -1, 'down')).toThrow(RangeError);
    expect(() => D.div(d('1'), d('3'), 1.5, 'down')).toThrow(RangeError);
    expect(() => D.div(d('1'), d('3'), 1000, 'down')).toThrow(RangeError);
    expect(() => D.div(d('1'), d('3'), 2, 'nearest' as 'down')).toThrow(RangeError);
  });

  it('quantizes to a tick or lot', () => {
    expect(s(D.quantize(d('1.2345'), d('0.01'), 'down'))).toBe('1.23');
    expect(s(D.quantize(d('1.2345'), d('0.01'), 'up'))).toBe('1.24');
    expect(s(D.quantize(d('-1.2345'), d('0.01'), 'down'))).toBe('-1.23');
    expect(s(D.quantize(d('-1.2345'), d('0.01'), 'up'))).toBe('-1.24');
    expect(s(D.quantize(d('1.3'), d('0.5'), 'down'))).toBe('1');
    expect(s(D.quantize(d('1.3'), d('0.5'), 'up'))).toBe('1.5');
    expect(s(D.quantize(d('60123.7'), d('5'), 'down'))).toBe('60120');
    expect(s(D.quantize(d('60123.7'), d('5'), 'up'))).toBe('60125');
    expect(s(D.quantize(d('1.5'), d('0.5'), 'up'))).toBe('1.5');
    expect(s(D.quantize(d('0.00012'), d('0.001'), 'down'))).toBe('0');
    expect(() => D.quantize(d('1'), d('0'), 'down')).toThrow(RangeError);
    expect(() => D.quantize(d('1'), d('-0.1'), 'down')).toThrow(RangeError);
    expect(() => D.quantize(d('1'), d('0.1'), 'half_even' as 'down')).toThrow(RangeError);
  });

  it('compares, negates, takes absolute values', () => {
    expect(D.cmp(d('1.10'), d('1.1'))).toBe(0);
    expect(D.cmp(d('-2'), d('1'))).toBe(-1);
    expect(D.cmp(d('0.0000001'), d('0'))).toBe(1);
    expect(s(D.abs(d('-3.2')))).toBe('3.2');
    expect(s(D.neg(d('3.2')))).toBe('-3.2');
    expect(D.isZero(d('0.000'))).toBe(true);
    expect(D.isZero(d('0.0001'))).toBe(false);
    expect(s(D.min(d('1'), d('2')))).toBe('1');
    expect(s(D.max(d('1'), d('2')))).toBe('2');
    expect(D.isMultiple(d('0.3'), d('0.1'))).toBe(true);
    expect(D.isMultiple(d('0.35'), d('0.1'))).toBe(false);
    expect(D.toNumber(d('1.25'))).toBe(1.25);
  });
});

describe('decimal: properties (deterministic PRNG)', () => {
  const eq = (a: Dec, b: Dec): void => { expect(s(a)).toBe(s(b)); };

  it('add and mul are commutative and associative; mul distributes over add', () => {
    const r = prng(1);
    for (let i = 0; i < N; i++) {
      const a = randDec(r, { signed: true }), b = randDec(r, { signed: true }), c = randDec(r, { signed: true });
      eq(D.add(a, b), D.add(b, a));
      eq(D.mul(a, b), D.mul(b, a));
      eq(D.add(D.add(a, b), c), D.add(a, D.add(b, c)));
      eq(D.mul(D.mul(a, b), c), D.mul(a, D.mul(b, c)));
      eq(D.mul(a, D.add(b, c)), D.add(D.mul(a, b), D.mul(a, c)));
    }
  });

  it('a − a = 0, a + 0 = a, a · 1 = a, a + (−a) = 0', () => {
    const r = prng(2);
    for (let i = 0; i < N; i++) {
      const a = randDec(r, { signed: true });
      expect(s(D.sub(a, a))).toBe('0');
      eq(D.add(a, D.zero), a);
      eq(D.mul(a, D.one), a);
      expect(D.isZero(D.add(a, D.neg(a)))).toBe(true);
    }
  });

  it('(a · b) / b gives a back, and a / b · b is within one unit of the last place of a', () => {
    const r = prng(3);
    const ulp = d('0.000000000001');           // 12 decimals
    for (let i = 0; i < N; i++) {
      const a = randDec(r, { signed: true }), b = randDec(r, { signed: true, positive: true });
      // a has at most 9 decimals, so it is representable at scale 20: the division must be exact in every mode
      for (const mode of ['down', 'up', 'half_even'] as const) eq(D.div(D.mul(a, b), b, 20, mode), a);
      const down = D.div(a, b, 12, 'down'), up = D.div(a, b, 12, 'up'), he = D.div(a, b, 12, 'half_even');
      // |down| ≤ |a/b| ≤ |up|, at most one unit apart, and half_even is one of the two
      expect(D.lte(D.abs(D.mul(down, b)), D.abs(a))).toBe(true);
      expect(D.gte(D.abs(D.mul(up, b)), D.abs(a))).toBe(true);
      expect(D.lte(D.abs(D.sub(up, down)), ulp)).toBe(true);
      expect(D.eq(he, down) || D.eq(he, up)).toBe(true);
      // the error of each result, multiplied back, is below |b| · ulp
      for (const q of [down, up, he]) expect(D.lt(D.abs(D.sub(D.mul(q, b), a)), D.mul(D.abs(b), ulp))).toBe(true);
    }
  });

  it('quantize(a, step) is a multiple of step, within one step of a, on the right side', () => {
    const r = prng(4);
    for (let i = 0; i < N; i++) {
      const a = randDec(r, { signed: true }), step = randDec(r, { intDigits: 3, fracDigits: 6, positive: true });
      const down = D.quantize(a, step, 'down'), up = D.quantize(a, step, 'up');
      for (const q of [down, up]) {
        expect(D.isMultiple(q, step)).toBe(true);
        expect(D.lt(D.abs(D.sub(q, a)), step)).toBe(true);
      }
      expect(D.lte(D.abs(down), D.abs(a))).toBe(true);
      expect(D.gte(D.abs(up), D.abs(a))).toBe(true);
      if (D.isMultiple(a, step)) { eq(down, a); eq(up, a); } else eq(D.abs(D.sub(up, down)), step);
      eq(D.quantize(down, step, 'up'), down);           // idempotent
    }
  });

  it('comparison is consistent with subtraction and is a total order', () => {
    const r = prng(5);
    for (let i = 0; i < N; i++) {
      const a = randDec(r, { signed: true, intDigits: 3, fracDigits: 3 }), b = randDec(r, { signed: true, intDigits: 3, fracDigits: 3 }), c = randDec(r, { signed: true, intDigits: 3, fracDigits: 3 });
      expect(D.cmp(a, b)).toBe(D.sign(D.sub(a, b)));
      expect(D.cmp(a, b)).toBe(-D.cmp(b, a) || 0);
      if (D.lte(a, b) && D.lte(b, c)) expect(D.lte(a, c)).toBe(true);
      expect(D.cmp(D.add(a, c), D.add(b, c))).toBe(D.cmp(a, b));     // translation invariant
    }
  });

  it('round-trips: str(from(s)) is the normalised s, from(str(x)) = x, and the output is canonical', () => {
    const r = prng(6);
    for (let i = 0; i < N; i++) {
      const text = randDecStr(r, { signed: true, intDigits: 20, fracDigits: 20 });
      const x = D.from(text);
      const out = D.str(x);
      expect(out).toMatch(DEC_RE);
      expect(out).not.toMatch(/^-0(\.0*)?$/);
      if (out.includes('.')) expect(out.endsWith('0')).toBe(false);
      eq(D.from(out), x);
      expect(D.str(D.from(out))).toBe(out);
      // same value as the input: compare through an independent bigint scaling
      const [i0 = '', f0 = ''] = text.replace('-', '').split('.');
      const big = BigInt(i0 + f0.padEnd(20, '0')) * (text.startsWith('-') ? -1n : 1n);
      eq(D.mul(x, D.from(10n ** 20n)), D.from(big));
    }
  });

  it('a random unnormalised Dec prints like its normalised form', () => {
    const r = prng(7);
    for (let i = 0; i < N; i++) {
      const m = BigInt(randInt(r, -999999, 999999)), sc = randInt(r, 0, 8), pad = randInt(r, 0, 5);
      expect(D.str({ m: m * 10n ** BigInt(pad), s: sc + pad })).toBe(D.str({ m, s: sc }));
    }
  });
});
