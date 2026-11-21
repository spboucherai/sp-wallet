/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : tests/e2e/v10-record-fixtures.mts
 * Module           : tests
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

// v10: records the API answers that v10-visual.spec.ts replays (tests/e2e/fixtures/v10/api.json), from the REAL local QA
// stack (qa-real-server.mts: throwaway in-memory seed, broadcast off, local forks). Unlike the v9 recorder it does not list
// routes: it OPENS each screen of the second design pass and keeps every GET answer the screen asked for (JSON only — no
// stream), so a screen that starts reading a new route is covered by re-running it. Two agents and an address-book entry
// are created first (idempotent). The addresses in the file belong to that throwaway wallet.
//
//   (cd apps/web && node_modules/.bin/vite build)
//   npx tsx tests/e2e/qa-real-server.mts --port 8830 --db spw_v10_shell --fork base,arbitrum
//   npx tsx tests/e2e/v10-record-fixtures.mts [http://localhost:8830]
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { enter, passkeyFile, virtualPasskey } from './qa-helpers.ts';

const BASE = process.argv[2] ?? 'http://localhost:8830';
const browser = await chromium.launch(); const context = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 }, locale: 'fr-CA' });
const page = await context.newPage(); const pk = await virtualPasskey(context, page, passkeyFile(Number(new URL(BASE).port)));
await enter(page, pk, 'qa-setup-token');
const api = (method: string, path: string, body?: unknown) => page.evaluate(async ([m, p, b]) => { const r = await fetch('/api/v1' + p, { method: m as string, credentials: 'same-origin', headers: m === 'GET' ? {} : { 'x-spw-csrf': '1', 'content-type': 'application/json' }, body: m === 'GET' ? undefined : JSON.stringify(b ?? {}) }); return { status: r.status, json: await r.json().catch(() => null) }; }, [method, path, body] as const);
let agents = ((await api('GET', '/agents')).json?.agents ?? []) as { id: string; name: string }[];
if (agents.length === 0) {
  await api('POST', '/agents', { name: 'Momentum Base', mission: 'Suivre la tendance sur ETH et BTC, prudemment.', network: 'base', universe: ['ETH', 'BTC'], interval: '1h', capitalUsdc: '60' });
  await api('POST', '/agents', { name: 'Panier Arbitrum', mission: '', network: 'arbitrum', universe: ['ETH', 'ARB', 'LINK'], interval: '1h', capitalUsdc: '40' });
  await api('POST', '/addressbook', { network: 'base', address: '0x000000000000000000000000000000000000dEaD', label: 'Coffre froid' });
  agents = ((await api('GET', '/agents')).json?.agents ?? []) as { id: string; name: string }[];
}
const out: Record<string, unknown> = { '/auth/state': { setupRequired: false, authenticated: true } };
page.on('response', (r) => {
  const u = new URL(r.url()); if (u.origin !== BASE || !u.pathname.startsWith('/api/v1/') || r.request().method() !== 'GET' || r.status() !== 200) return;
  if (!(r.headers()['content-type'] ?? '').includes('application/json')) return;
  const key = u.pathname.replace('/api/v1', '') + u.search;
  void r.json().then((j) => { out[key] = j; }, () => {});
});
const agent = agents.find((a) => a.name === 'Momentum Base') ?? agents[0]!;
for (const path of ['/', '/swap', '/agents', `/agents/${agent.id}`, '/alerts', '/alerts?v=settings', '/monitor', '/research', '/activity']) {
  await page.goto(path); await page.waitForTimeout(path.startsWith('/agents/') ? 6000 : 3500);
  if (path === '/agents') { await page.getByRole('button', { name: 'Nouvel agent' }).click().catch(() => {}); await page.waitForTimeout(2500); }
  console.log(path, Object.keys(out).length);
}
// the RPC endpoints of the health list are the stack's own configuration: keep the shape, drop the URLs
for (const n of (out['/networks'] ?? []) as { health: { endpoints: { url: string }[] } | null }[]) for (const [k, e] of (n.health?.endpoints ?? []).entries()) e.url = `https://rpc-${k + 1}.example.invalid`;
// the monitoring answer names the machine's data directory: not something to keep in the repository
const scrub = (o: unknown): void => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o as Record<string, unknown>)) { if (typeof v === 'string' && /^\/(Users|home)\//.test(v)) (o as Record<string, unknown>)[k] = '/srv/sp-wallet'; else scrub(v); } };
scrub(out);
const dir = resolve('tests/e2e/fixtures/v10'); mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'api.json'), JSON.stringify({ recordedAt: new Date().toISOString(), agent: agent.id, answers: out }));
console.log(`${Object.keys(out).length} answers → tests/e2e/fixtures/v10/api.json (${Object.keys(out).sort().join(' ')})`);
await pk.save(); await browser.close();
