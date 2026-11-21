/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/test/hardening-b.test.ts
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

// V8 hardening (B): what the UI says about an agent-vault withdrawal follows the server's state; "ok" (green) only for a
// withdrawal that is mined AND arrived; never a "sent" wording for something not broadcast or not mined.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WD_OPEN, withdrawalNotice, type WdState } from '../src/screens/withdrawTrack';

// the dictionary is not exported: its hd block is read from the source
const S: Record<string, [string, string]> = Object.fromEntries([...readFileSync(new URL('../src/i18n.ts', import.meta.url), 'utf8').matchAll(/^  (hdWd[A-Za-z]+): \['((?:[^'\\]|\\.)*)', '((?:[^'\\]|\\.)*)'\],$/gm)].map((m) => [m[1]!, [m[2]!, m[3]!]]));
describe('agent withdrawal wording', () => {
  it('maps every state; green only when confirmed and arrived; pending states are marked pending', () => {
    const all: WdState[] = ['requested', 'signed', 'broadcast', 'confirmed', 'failed', 'not_sent'];
    for (const state of all) for (const arrived of [true, false]) {
      const n = withdrawalNotice({ state, arrived });
      expect(S[n.key], n.key).toBeDefined();
      expect(n.tone === 'ok').toBe(state === 'confirmed' && arrived);
      expect(n.pending).toBe(WD_OPEN.includes(state));
    }
    expect(withdrawalNotice({ state: 'not_sent', arrived: false }).tone).toBe('warn');
    expect(withdrawalNotice({ state: 'failed', arrived: false }).tone).toBe('danger');
  });
  it('the sentences: not broadcast / not confirmed is said in so many words; "arrivé" only in the confirmed one', () => {
    expect(S.hdWdSigned![0]).toMatch(/Pas encore diffusé/); expect(S.hdWdBroadcast![0]).toMatch(/Pas encore confirmé/);
    expect(S.hdWdNotSent![0]).toMatch(/signé, mais non envoyé/); expect(S.hdWdNotSent![1]).toMatch(/NOT sent/);
    for (const k of ['hdWdSigned', 'hdWdBroadcast', 'hdWdFailed', 'hdWdNotSent', 'hdWdUnverified']) { expect(S[k]![0], k).not.toMatch(/arrivé dans|envoyé vers/); expect(S[k]![1], k).not.toMatch(/arrived in|sent to your/); }
    expect(S.hdWdConfirmed![0]).toMatch(/arrivé dans votre portefeuille principal/);
  });
  it('the withdraw sheet and the other-networks section no longer print the optimistic "sent" sentence', () => {
    const src = readFileSync(new URL('../src/screens/AgentFund.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/qaWdSent|qaWdTest/);
    expect(src.match(/useTrackedWithdrawals\(/g)).toHaveLength(2);
    expect(src).toMatch(/idempotencyKey|wd\.start\(/);
  });
});
