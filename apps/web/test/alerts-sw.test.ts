/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/test/alerts-sw.test.ts
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

// The service worker's handler logic (pure part) and the built worker itself, run in a fake ServiceWorkerGlobalScope:
// a push becomes a notification in the device's language, a tap opens the right screen, nothing else is in the worker.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { languageOf, notificationFor, safeUrl } from '../src/sw-core.ts';

const payload = (o: Record<string, unknown> = {}) => ({ v: 1, id: 42, kind: 'transfer.confirmed', sev: 'info', ts: 1_800_000_000_000, l: 'fr', d: false, p: { network: 'Base', count: 1 }, s: { type: 'proposal', id: 'p1' }, ...o });

describe('service worker: push → notification', () => {
  it('renders in the language chosen on the device, without details by default', () => {
    expect(notificationFor(payload())).toEqual({ title: 'Transfert confirmé', options: { body: 'Sur Base.', tag: 'spw-42', lang: 'fr', icon: '/icon-192.png', badge: '/icon-192.png', timestamp: 1_800_000_000_000, data: { url: '/activity', id: 42 } } });
    expect(notificationFor(payload({ l: 'en' }))).toMatchObject({ title: 'Transfer confirmed', options: { body: 'On Base.', lang: 'en' } });
    expect(notificationFor(payload({ d: true, p: { network: 'Base', amount: '25', symbol: 'USDC' } })).options.body).toBe('25 USDC envoyés sur Base.');
    // details off: even if amounts were in the payload, the private wording has no place for them
    expect(notificationFor(payload({ d: false, p: { network: 'Base', amount: '25', symbol: 'USDC' } })).options.body).toBe('Sur Base.');
  });
  it('falls back to the browser language, then to French', () => {
    expect(languageOf(undefined, 'en-CA')).toBe('en');
    expect(languageOf(undefined, 'fr-CA')).toBe('fr');
    expect(languageOf(undefined, undefined)).toBe('fr');
    expect(languageOf('en', 'fr-CA')).toBe('en');
    expect(languageOf('de', 'en-US')).toBe('en');
    expect(notificationFor(payload({ l: undefined }), 'en-US').title).toBe('Transfer confirmed');
  });
  it('a critical alert stays on screen and opens the screen it is about', () => {
    const n = notificationFor(payload({ kind: 'agent.stopped_loss', sev: 'critical', p: { agent: 'Momentum' }, s: { type: 'agent', id: '6f1c' } }));
    expect(n).toMatchObject({ title: 'Agent arrêté : limite de perte', options: { body: 'Momentum a atteint sa limite de perte et s’est arrêté.', requireInteraction: true, data: { url: '/agents/6f1c' } } });
    expect(notificationFor(payload({ kind: 'security.signer_halted', sev: 'critical', p: {}, s: null })).options.data.url).toBe('/security');
    expect(notificationFor(payload({ kind: 'conn.down', sev: 'warning', p: { name: 'Base', minutes: 3 }, s: { type: 'network', network: 'base' } })).options).toMatchObject({ body: 'Base ne répond plus depuis 3 min.', data: { url: '/monitor' } });
    expect(notificationFor(payload({ kind: 'system.test', p: {}, s: null })).title).toBe('Notification de test');
  });
  it('always shows something: a malformed or unknown payload gives a generic notification that opens the alerts', () => {
    for (const bad of [null, undefined, 'text', 42, {}, { v: 2, kind: 'x' }, { v: 1 }]) {
      const n = notificationFor(bad, 'fr-CA');
      expect(n).toMatchObject({ title: 'SP Wallet', options: { body: 'Nouvelle alerte. Ouvrez l’application.', data: { url: '/alerts', id: null } } });
    }
    expect(notificationFor(null, 'en-GB').options.body).toBe('New alert. Open the app.');
    expect(notificationFor(payload({ kind: 'future.kind_of_a_newer_server' }))).toMatchObject({ title: 'SP Wallet', options: { data: { url: '/alerts' } } });
  });
  it('only same-origin paths are opened', () => {
    expect(safeUrl('/agents/abc')).toBe('/agents/abc');
    expect(safeUrl('/futures?v=accounts')).toBe('/futures?v=accounts');
    for (const bad of ['https://evil.example/', '//evil.example/x', 'javascript:alert(1)', '', null, 42, '/a b', '/x#<script>']) expect(safeUrl(bad)).toBe('/alerts');
  });
});

describe('service worker: the bundled /sw.js in a fake worker scope', () => {
  type Listener = (e: any) => void;
  async function boot(language = 'fr-CA') {
    const out = await build({ entryPoints: [fileURLToPath(new URL('../src/sw.ts', import.meta.url))], bundle: true, write: false, format: 'iife', target: 'es2020' });
    const code = out.outputFiles[0]!.text, listeners = new Map<string, Listener>(), shown: { title: string; options: any }[] = [], opened: string[] = [], messages: unknown[] = [];
    let focused = 0, skipped = false, claimed = false;
    const windows: { url: string; focus: () => Promise<void>; postMessage: (m: unknown) => void }[] = [];
    const scope = {
      addEventListener: (t: string, f: Listener) => { listeners.set(t, f); }, skipWaiting: async () => { skipped = true; }, navigator: { language },
      registration: { showNotification: async (title: string, options: unknown) => { shown.push({ title, options }); } },
      clients: { claim: async () => { claimed = true; }, matchAll: async () => windows, openWindow: async (u: string) => { opened.push(u); } },
    };
    new Function('self', code)(scope);
    const fire = async (type: string, ev: Record<string, unknown> = {}) => { const waits: Promise<unknown>[] = []; listeners.get(type)!({ ...ev, waitUntil: (p: Promise<unknown>) => waits.push(p) }); await Promise.all(waits); };
    const openWindow = () => windows.push({ url: 'https://wallet.test/', focus: async () => { focused += 1; }, postMessage: (m) => messages.push(m) });
    return { code, listeners, shown, opened, messages, fire, openWindow, state: () => ({ focused, skipped, claimed }) };
  }

  it('handles install, activate, push and notificationclick — and has no fetch handler (nothing is cached or intercepted)', async () => {
    const w = await boot();
    expect([...w.listeners.keys()].sort()).toEqual(['activate', 'install', 'notificationclick', 'push']);
    expect(w.code).not.toMatch(/caches\.|importScripts|fetch\(/);
    await w.fire('install'); await w.fire('activate');
    expect(w.state()).toMatchObject({ skipped: true, claimed: true });
  });
  it('a push shows the notification; a push that is not JSON still shows one', async () => {
    const w = await boot('en-US');
    await w.fire('push', { data: { json: () => payload({ l: undefined, kind: 'deposit.received' }) } });
    await w.fire('push', { data: { json: () => { throw new Error('not json'); } } });
    await w.fire('push', { data: null });
    expect(w.shown.map((s) => [s.title, s.options.body])).toEqual([['Deposit received', 'On Base.'], ['SP Wallet', 'New alert. Open the app.'], ['SP Wallet', 'New alert. Open the app.']]);
  });
  it('a tap focuses the open app and tells it where to go; with no window it opens one', async () => {
    const w = await boot();
    let closed = 0;
    const click = (url: unknown) => w.fire('notificationclick', { notification: { close: () => { closed += 1; }, data: { url } } });
    await click('/agents/abc');
    expect(w.opened).toEqual(['/agents/abc']);
    w.openWindow();
    await click('/security');
    await click('https://evil.example/');
    expect(w.opened).toEqual(['/agents/abc']);
    expect(w.messages).toEqual([{ type: 'spw-nav', url: '/security' }, { type: 'spw-nav', url: '/alerts' }]);
    expect(w.state().focused).toBe(2);
    expect(closed).toBe(3);
  });
});
