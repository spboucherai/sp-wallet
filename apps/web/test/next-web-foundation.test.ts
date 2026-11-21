/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/test/next-web-foundation.test.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
 * Last Modified    : 2026-11-19
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

// NEXT web — foundation: appearance (system / light / dark), the `X-SPW-Interaction` rule, and the one life-cycle vocabulary.
import { environmentManager, QueryClient, QueryObserver, timeoutManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get, inBackground, INTERACTION_HEADER, INTERACTION_WINDOW_MS, isInteraction, noteUserInput, post, resetUserInput } from '../src/api.ts';
import { lifecycleDone, lifecycleIcon, lifecycleLabel, lifecycleOf, LIFECYCLE_KEYS, needsExplanation, PATH, timelineOf } from '../src/lifecycle.ts';
import { isThemePref, resolveScheme } from '../src/theme.ts';
import { lifecycleOf as coreLifecycleOf, STATES } from '../../../packages/core/src/state.ts';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); resetUserInput(); });
const okFetch = () => vi.fn(async (_u: string, _i: RequestInit) => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
const sent = (f: ReturnType<typeof okFetch>, k = 0): string | undefined => (f.mock.calls[k]![1].headers as Record<string, string>)[INTERACTION_HEADER];

describe('appearance', () => {
  it('system follows the device; light and dark do not', () => {
    expect(resolveScheme('system', true)).toBe('dark'); expect(resolveScheme('system', false)).toBe('light');
    expect(resolveScheme('light', true)).toBe('light'); expect(resolveScheme('dark', false)).toBe('dark');
    expect(['system', 'light', 'dark'].every(isThemePref)).toBe(true); expect(isThemePref('auto')).toBe(false); expect(isThemePref(undefined)).toBe(false);
  });
});

describe('X-SPW-Interaction', () => {
  it('no input of the owner → no request carries it', async () => {
    const f = okFetch(); vi.stubGlobal('fetch', f);
    await get('/portfolio'); await post('/settings', {});
    expect(sent(f, 0)).toBeUndefined(); expect(sent(f, 1)).toBeUndefined();
  });
  it('a request started within the window after a real input carries it; after the window it does not', async () => {
    const f = okFetch(); vi.stubGlobal('fetch', f);
    const t0 = 1_000_000; vi.useFakeTimers(); vi.setSystemTime(t0);
    noteUserInput();
    await get('/portfolio'); expect(sent(f, 0)).toBe('1');
    vi.setSystemTime(t0 + INTERACTION_WINDOW_MS); await get('/portfolio'); expect(sent(f, 1)).toBe('1');
    vi.setSystemTime(t0 + INTERACTION_WINDOW_MS + 1); await get('/portfolio'); expect(sent(f, 2)).toBeUndefined();
  });
  it('a hidden document never counts as interaction; an explicit `interaction: true` does (the approval after a passkey prompt)', () => {
    noteUserInput(5000);
    expect(isInteraction({}, 5001, true)).toBe(true); expect(isInteraction({}, 5001, false)).toBe(false);
    expect(isInteraction({ interaction: true }, 999_999, false)).toBe(true);
    expect(isInteraction({ interaction: false }, 5001, true)).toBe(false);
  });
  it('a background task never sends it — even right after an input, even with `interaction: true`', async () => {
    const f = okFetch(); vi.stubGlobal('fetch', f);
    noteUserInput();
    await inBackground(() => get('/events?after=0')); await inBackground(() => get('/portfolio', { interaction: true }));
    expect(sent(f, 0)).toBeUndefined(); expect(sent(f, 1)).toBeUndefined();
    await get('/portfolio'); expect(sent(f, 2)).toBe('1');   // the flag does not leak out of the background task
    expect(() => inBackground(() => { throw new Error('x'); })).toThrow(); await get('/portfolio'); expect(sent(f, 3)).toBe('1');   // nor after a throw
  });
  it('the timed re-read of a query (refetchInterval) is a background task: the first read is marked, the polls are not', async () => {
    vi.useFakeTimers(); const f = okFetch(); vi.stubGlobal('fetch', f);
    environmentManager.setIsServer(() => false);   // no `window` under vitest: timers are scheduled as in a browser
    // what main.tsx installs
    timeoutManager.setTimeoutProvider({ setTimeout: (cb, ms) => setTimeout(cb, ms) as unknown as number, clearTimeout: (id) => clearTimeout(id as never),
      setInterval: (cb, ms) => setInterval(() => inBackground(cb), ms) as unknown as number, clearInterval: (id) => clearInterval(id as never) });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    noteUserInput();
    const o = new QueryObserver(qc, { queryKey: ['p'], queryFn: () => get('/portfolio'), refetchInterval: 1000 }); const stop = o.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(10);
    expect(f).toHaveBeenCalledTimes(1); expect(sent(f, 0)).toBe('1');                     // opened by the owner
    await vi.advanceTimersByTimeAsync(1000); noteUserInput();                           // the owner is tapping while the poll fires
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (let k = 1; k < f.mock.calls.length; k++) expect(sent(f, k), `poll ${k}`).toBeUndefined();
    stop(); qc.clear();
  });
});

describe('life cycle — one vocabulary', () => {
  it('the fourteen values each have a tone, an icon and a word in both languages', () => {
    expect(LIFECYCLE_KEYS).toHaveLength(14);
    for (const l of LIFECYCLE_KEYS) { expect(lifecycleIcon(l)).toBeTruthy(); expect(lifecycleLabel(l, 'fr')).toBeTruthy(); expect(lifecycleLabel(l, 'en')).toBeTruthy(); }
    expect(lifecycleLabel('dropped', 'fr')).toBe('Non incluse'); expect(lifecycleLabel('confirmed', 'en')).toBe('Confirmed');
  });
  it('reads `lifecycle` when the server sends it, and derives it from `state` exactly as the server does otherwise', () => {
    expect(lifecycleOf({ lifecycle: 'confirming', state: 'finalized' })).toBe('confirming');
    for (const s of STATES) for (const relay of [false, true]) for (const errorCode of [null, 'expired_onchain']) expect(lifecycleOf({ state: s, relayAttemptedAt: relay ? '2026-01-01T00:00:00Z' : null, errorCode })).toBe(coreLifecycleOf(s, { relayAttempted: relay, errorCode }));
    expect(lifecycleOf({ lifecycle: 'a_value_of_the_future', state: 'broadcast' })).toBe('pending');   // unknown value: fall back to state
    expect(lifecycleOf({ state: 'failed', errorCode: 'dropped' })).toBe('dropped');                    // the old servers' projection of `dropped`
    expect(lifecycleOf({ state: 'nonsense' })).toBe('draft');
  });
  it('confirmed is the only success; dropped and replaced are not ends and need their explanation', () => {
    expect(lifecycleDone('confirmed')).toBe(true); expect(lifecycleDone('confirming')).toBe(false); expect(lifecycleDone('dropped')).toBe(false); expect(lifecycleDone('replaced')).toBe(false);
    expect(['dropped', 'replaced', 'expired', 'failed', 'not_sent'].every((l) => needsExplanation(l as never))).toBe(true); expect(needsExplanation('pending')).toBe(false);
  });
  it('timeline: the path up to the current step, with the times the row carries; an off-path end closes it', () => {
    const t = timelineOf({ lifecycle: 'pending', createdAt: 'A', relayAttemptedAt: 'R', broadcastAt: 'B' });
    expect(t.map((s) => s.key)).toEqual([...PATH]); expect(t.find((s) => s.key === 'pending')).toMatchObject({ state: 'current', at: 'B' });
    expect(t.find((s) => s.key === 'broadcasting')).toMatchObject({ state: 'done', at: 'R' }); expect(t.find((s) => s.key === 'confirmed')).toMatchObject({ state: 'next', at: null });
    expect(timelineOf({ lifecycle: 'confirmed' }).every((s) => s.state === 'done')).toBe(true);
    const d = timelineOf({ lifecycle: 'dropped', relayAttemptedAt: 'R', updatedAt: 'U' });
    expect(d.at(-1)).toEqual({ key: 'dropped', state: 'current', at: 'U' }); expect(d.map((s) => s.key)).toContain('broadcasting'); expect(d.map((s) => s.key)).not.toContain('confirmed');
    expect(timelineOf({ lifecycle: 'rejected' }).map((s) => s.key)).toEqual(['awaiting_confirmation', 'rejected']);
    expect(timelineOf({ lifecycle: 'failed', txid: '0xabc' }).at(-1)).toMatchObject({ key: 'failed', state: 'failed' });
    expect(timelineOf({ lifecycle: 'not_sent' }).map((s) => s.key)).toEqual(['awaiting_confirmation', 'awaiting_signature', 'signed', 'not_sent']);
  });
});
