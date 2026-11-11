// v9 design pass: screenshots of every screen against the REAL local QA stack (tests/e2e/qa-real-server.mts), phone
// (390×844 @3x) and desktop (1440×900), light and dark, French — into docs/v9/screens/<label>/ as WebP.
//
//   npx tsx tests/e2e/qa-real-server.mts --port 8731 --db spw_v9_design --workers on --fork base,arbitrum
//   npx tsx tests/e2e/v9-shots.mts after [http://localhost:8731] [only-screen,only-screen…] [phone-light,desktop-dark…]
//
// The wallet is the throwaway one of that stack (in-memory seed, broadcast off). Needs `cwebp` to convert; keeps PNG otherwise.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { enter, passkeyFile, virtualPasskey } from './qa-helpers.ts';

const label = process.argv[2] ?? 'after', BASE = process.argv[3] ?? 'http://localhost:8731', only = (process.argv[4] ?? '').split(',').filter(Boolean), onlyCfg = (process.argv[5] ?? '').split(',').filter(Boolean);
const OUT = resolve('docs/v9/screens', label); mkdirSync(OUT, { recursive: true });
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const api = (page: Page, method: string, path: string, body?: unknown) => page.evaluate(async ([m, p, b]) => { const r = await fetch('/api/v1' + p, { method: m as string, credentials: 'same-origin', headers: m === 'GET' ? {} : { 'x-spw-csrf': '1', 'content-type': 'application/json' }, body: m === 'GET' ? undefined : JSON.stringify(b ?? {}) }); return { status: r.status, json: await r.json().catch(() => null) }; }, [method, path, body] as const);

const CONFIGS = [
  { id: 'phone-light', viewport: { width: 390, height: 844 }, dsf: 3, theme: 'light', mobile: true },
  { id: 'phone-dark', viewport: { width: 390, height: 844 }, dsf: 3, theme: 'dark', mobile: true },
  { id: 'desktop-light', viewport: { width: 1440, height: 900 }, dsf: 1, theme: 'light', mobile: false },
  { id: 'desktop-dark', viewport: { width: 1440, height: 900 }, dsf: 1, theme: 'dark', mobile: false },
].filter((c) => !onlyCfg.length || onlyCfg.includes(c.id));

const settle = async (page: Page, ms = 1800) => { await page.waitForTimeout(ms); await page.waitForFunction(() => document.querySelectorAll('.animate-pulse, .skel').length === 0, null, { timeout: 12_000 }).catch(() => {}); await page.waitForTimeout(350); };
async function shot(page: Page, name: string, cfg: (typeof CONFIGS)[number], fullPage = false) {
  const png = join(tmpdir(), `v9-${process.pid}.png`), base = join(OUT, `${name}-${cfg.id}`);
  await page.screenshot({ path: png, fullPage, animations: 'disabled' });
  try { execFileSync('cwebp', ['-quiet', '-q', '72', ...(cfg.mobile ? ['-resize', '600', '0'] : []), png, '-o', `${base}.webp`]); } catch { await page.screenshot({ path: `${base}.png`, fullPage }); }
  rmSync(png, { force: true });
  console.log(`${label}/${name}-${cfg.id}`);
}

const browser = await chromium.launch();
for (const cfg of CONFIGS) {
  const context = await browser.newContext({ baseURL: BASE, viewport: cfg.viewport, deviceScaleFactor: cfg.dsf, isMobile: cfg.mobile, hasTouch: cfg.mobile, locale: 'fr-CA', colorScheme: cfg.theme as 'light' | 'dark' });
  await context.addInitScript((t) => { localStorage.setItem('spw-theme', t); localStorage.setItem('spw-locale', 'fr'); }, cfg.theme);
  const page = await context.newPage();
  const want = (n: string) => !only.length || only.includes(n);
  if (want('gate')) { await page.goto('/'); await settle(page, 900); await shot(page, 'gate', cfg); }
  const pk = await virtualPasskey(context, page, passkeyFile(Number(new URL(BASE).port)));
  await enter(page, pk, 'qa-setup-token');
  // seed once: two paper agents, an address-book entry (idempotent enough: skipped when agents exist)
  const agents = await api(page, 'GET', '/agents');
  let list: { id: string }[] = (agents.json?.agents ?? agents.json ?? []) as never;
  if (Array.isArray(list) && list.length === 0) {
    await api(page, 'POST', '/agents', { name: 'Momentum Base', mission: 'Suivre la tendance sur ETH et BTC, prudemment.', network: 'base', universe: ['ETH', 'BTC'], interval: '1h', capitalUsdc: '60' });
    await api(page, 'POST', '/agents', { name: 'Panier Arbitrum', mission: '', network: 'arbitrum', universe: ['ETH', 'ARB', 'LINK'], interval: '1h', capitalUsdc: '40' });
    await api(page, 'POST', '/addressbook', { network: 'base', address: '0x000000000000000000000000000000000000dEaD', label: 'Coffre froid' });
    list = ((await api(page, 'GET', '/agents')).json?.agents ?? []) as never;
  }
  const SCREENS: [string, string, ((p: Page) => Promise<void>)?][] = [
    ['home', '/'], ['assets', '/assets'], ['asset-eth', '/asset/base/native'], ['asset-usdc', `/asset/base/${USDC}`], ['receive', '/receive'], ['send', '/send'],
    ['send-review', '/send', async (p) => { await p.locator('textarea').fill('0x000000000000000000000000000000000000dEaD'); await p.locator('input[inputmode="decimal"]').fill('1.5'); await p.getByRole('button', { name: /^Vérifier|^Review/ }).click(); await p.getByText(/Vous envoyez|You send/).waitFor({ timeout: 30_000 }).catch(() => {}); }],
    ['activity', '/activity'], ['swap', '/swap'],
    ['swap-quote', '/swap', async (p) => { await p.locator('input[inputmode="decimal"]').first().fill('25').catch(() => {}); await p.waitForTimeout(9000); }],
    ['agents', '/agents'], ...(list[0] ? [['agent', `/agents/${list[0].id}`] as [string, string]] : []),
    ['futures', '/futures'], ['futures-accounts', '/futures?v=accounts'], ['futures-compare', '/futures?v=compare'], ['futures-router', '/futures?v=router'],
    ['alerts', '/alerts'], ['alerts-settings', '/alerts?v=settings'], ['monitor', '/monitor'], ['security', '/security'], ['settings', '/settings'], ['research', '/research'],
  ];
  for (const [name, path, act] of SCREENS) {
    if (!want(name)) continue;
    try { await page.goto(path); await settle(page, name.startsWith('futures') ? 4500 : 1800); if (act) { await act(page); await settle(page, 600); } await shot(page, name, cfg); if (cfg.mobile && ['home', 'asset-eth', 'security', 'agent'].includes(name)) await shot(page, `${name}-full`, cfg, true); }
    catch (e) { console.log(`FAILED ${name}-${cfg.id}: ${String(e).slice(0, 200)}`); }
  }
  await pk.save(); await context.close();
}
await browser.close();
