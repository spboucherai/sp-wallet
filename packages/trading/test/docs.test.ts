/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading/test/docs.test.ts
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

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generatedDocBlocks, readDocBlock, REFERENCE_AUTHORIZATION, REFERENCE_MANDATE, validateTradingMandate, writeDocBlock } from '../src/index.ts';
import { validateVenueAuthorization } from '@spw/derivatives/live';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const src = fileURLToPath(new URL('../src/', import.meta.url));
const update = process.env['UPDATE_DOCS'] === '1';

describe('documentation generated from the code', () => {
  const blocks = generatedDocBlocks();
  for (const file of Object.keys(blocks)) {
    for (const name of Object.keys(blocks[file]!)) {
      it(`${file} — ${name} is what the code renders`, () => {
        const path = join(root, file);
        expect(existsSync(path), `${file} is missing`).toBe(true);
        const doc = readFileSync(path, 'utf8'), want = blocks[file]![name]!;
        if (update) { const next = writeDocBlock(doc, name, want); if (next !== doc) writeFileSync(path, next); return; }
        // out of date? run: UPDATE_DOCS=1 pnpm vitest run packages/trading/test/docs.test.ts
        expect(readDocBlock(doc, name), `the GENERATED:${name} block of ${file} is missing`).not.toBeNull();
        expect(readDocBlock(doc, name)).toBe(want);
      });
    }
  }
  it('block helpers', () => {
    const doc = 'a\n<!-- GENERATED:x -->\nold\n<!-- /GENERATED:x -->\nb';
    expect(readDocBlock(doc, 'x')).toBe('old');
    expect(readDocBlock(writeDocBlock(doc, 'x', 'new\nlines'), 'x')).toBe('new\nlines');
    expect(writeDocBlock(doc, 'x', 'old')).toBe(doc);
    expect(readDocBlock(doc, 'y')).toBeNull();
    expect(() => writeDocBlock(doc, 'y', 'z')).toThrow();
  });
  it('the reference mandate and authorization used by the tables are valid objects', () => {
    expect(() => validateTradingMandate(REFERENCE_MANDATE, REFERENCE_MANDATE.createdAt)).not.toThrow();
    expect(() => validateVenueAuthorization(REFERENCE_AUTHORIZATION, REFERENCE_AUTHORIZATION.createdAt)).not.toThrow();
  });
});

describe('the package is pure', () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
  walk(src);
  it('has source files to check', () => { expect(files.length).toBeGreaterThanOrEqual(10); });
  it.each(files.map((f) => [f.slice(src.length), f]))('%s: no I/O, no clock, no randomness, no float arithmetic on money', (_n, path) => {
    const code = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const imports = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
    for (const i of imports) expect(i.startsWith('./') || i.startsWith('../') || ['zod', '@noble/hashes/sha2.js', '@spw/core', '@spw/derivatives', '@spw/derivatives/live'].includes(i), `unexpected import ${i}`).toBe(true);
    for (const banned of [/\bDate\.now\b/, /\bnew Date\(\)/, /\bMath\.random\b/, /\bprocess\./, /\bfetch\(/, /\bsetTimeout\b/, /\bsetInterval\b/, /\bcrypto\.random/, /\brandomUUID\b/, /\bperformance\.now\b/, /\brequire\(/, /\bparseFloat\b/, /\btoFixed\b/, /\bD\.toNumber\b/])
      expect(banned.test(code), `${banned} must not appear`).toBe(false);
  });
});
