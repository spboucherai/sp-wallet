/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/test/perp-live-codes.test.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// v7 perp live: every refusal code of the signer under a mandate (docs/v6/DERIVATIVE-MANDATE.md §2), every hold code of the live
// executor and every exit code has a French AND an English sentence in the `pl` block of i18n.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const i18n = read('../src/i18n.ts'), screen = read('../src/screens/PerpAgentLive.tsx'), doc = read('../../../docs/v6/DERIVATIVE-MANDATE.md');
const list = (name: string): string[] => { const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(screen); if (!m) throw new Error(`no ${name}`); return [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!); };
const pair = (key: string): [string, string] | null => { const m = new RegExp(`\\b${key}: \\[\\s*'((?:[^'\\\\]|\\\\.)+)',\\s*'((?:[^'\\\\]|\\\\.)+)'\\]`).exec(i18n); return m ? [m[1]!, m[2]!] : null; };

describe('perp live: codes have sentences in both languages', () => {
  it('the screen lists exactly the signer codes of the mandate document', () => {
    const m = /stable code:\s*\n\s*`([^`]+)`/.exec(doc);
    expect(m).not.toBeNull();
    const fromDoc = m![1]!.split(',').map((x) => x.trim()).filter(Boolean);
    expect(fromDoc.length).toBe(33);
    expect(list('SIGNER_CODES').sort()).toEqual([...fromDoc].sort());
  });
  it('every signer, executor and exit code has a French and an English sentence', () => {
    const keys = [...list('SIGNER_CODES').map((c) => `plR_signer_${c}`), ...list('EXECUTOR_CODES').map((c) => `plR_${c}`), ...list('EXIT_CODES').map((c) => `plX_${c}`),
      'plR_signer_other', 'plR_other', 'plX_other', 'plR_withdrawn', 'plR_not_signed', 'plR_rejected', 'plR_rejected_earlier', 'plR_mandate_floor_equity'];
    for (const k of keys) {
      const p = pair(k);
      expect(p, k).not.toBeNull();
      expect(p![0].length, k).toBeGreaterThan(40); expect(p![1].length, k).toBeGreaterThan(40);
      expect(p![0], k).not.toBe(p![1]);
    }
  });
  it('the block is contiguous and delimited', () => {
    const a = i18n.indexOf('// >>> v7 perp live'), b = i18n.indexOf('// <<< v7 perp live');
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a);
    const outside = i18n.slice(0, a) + i18n.slice(b);
    expect(/^\s*pl[A-Z][A-Za-z_0-9]*: \[/m.test(outside)).toBe(false);
  });
});
