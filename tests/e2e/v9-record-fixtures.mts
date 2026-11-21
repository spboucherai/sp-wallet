/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : tests/e2e/v9-record-fixtures.mts
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

// v9: records the API answers the visual regression spec replays (tests/e2e/fixtures/v9/api.json), from the REAL local QA
// stack (qa-real-server.mts: throwaway in-memory seed, broadcast off). Only GET answers of read-only routes are kept; the
// addresses in them belong to that throwaway wallet. Re-run when a screen starts reading a new route.
//
//   npx tsx tests/e2e/v9-record-fixtures.mts [http://localhost:8731]
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { enter, passkeyFile, virtualPasskey } from './qa-helpers.ts';

const BASE = process.argv[2] ?? 'http://localhost:8731';
const PATHS = ['/portfolio', '/networks', '/settings', '/accounts', '/activity?limit=200', '/agents', '/addressbook', '/alerts/unread', '/plans?open=1', '/plans?limit=5',
  '/market/ETH?days=7&currency=cad', '/market/USDC?days=7&currency=cad', '/security/overview', '/security/audit?limit=60', '/swap/providers'];
const browser = await chromium.launch(); const context = await browser.newContext({ baseURL: BASE });
const page = await context.newPage(); const pk = await virtualPasskey(context, page, passkeyFile(Number(new URL(BASE).port)));
await enter(page, pk, 'qa-setup-token');
const out: Record<string, unknown> = { '/auth/state': { setupRequired: false, authenticated: true } };
for (const p of PATHS) {
  const r = await page.evaluate(async (path) => { const x = await fetch('/api/v1' + path, { credentials: 'same-origin' }); return { status: x.status, json: await x.json().catch(() => null) }; }, p);
  if (r.status !== 200) throw new Error(`${p}: ${r.status}`);
  out[p] = r.json; console.log(p, JSON.stringify(r.json).length);
}
// endpoints of the RPC health list are the stack's own configuration: keep the shape, drop the URLs
for (const n of out['/networks'] as { health: { endpoints: { url: string }[] } | null }[]) for (const [k, e] of (n.health?.endpoints ?? []).entries()) e.url = `https://rpc-${k + 1}.example.invalid`;
(out['/security/overview'] as { sessions: unknown[] }).sessions = (out['/security/overview'] as { sessions: unknown[] }).sessions.slice(0, 2);
(out['/security/audit?limit=60'] as { events: unknown[] }).events = (out['/security/audit?limit=60'] as { events: unknown[] }).events.slice(0, 6);
const dir = resolve('tests/e2e/fixtures/v9'); mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'api.json'), JSON.stringify({ recordedAt: new Date().toISOString(), answers: out }));
await pk.save(); await browser.close();
