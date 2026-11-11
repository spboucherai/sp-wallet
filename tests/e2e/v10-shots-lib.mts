// v10 design pass — the screenshot harness shared by the per-area scripts (tests/e2e/v10-shots-<area>.mts).
// Every restyled screen is captured BEFORE and AFTER, phone 390×844 @3x and desktop 1440×900, light and dark, French,
// into docs/v10/screens/<before|after>/<area>-<name>-<config>.webp (cwebp; PNG when cwebp is missing).
//
// A script describes GROUPS of scenarios; a group has one base URL and one way in:
//   · the dev mocks (Futures, GMX, live accounts, perp agents): `await startVite(port)` and paths like `/futures?mock=1`;
//   · the real local QA stack (tests/e2e/qa-real-server.mts on the script's OWN port and scratch database, throwaway
//     in-memory seed, broadcast off, local forks): `setup: qaEnter` — Chromium virtual authenticator, setup or unlock;
//   · any other local server (alerts-server.mts, research-server.mts): a `setup` of its own.
// Nothing here reads a key, a seed or an .env file, and nothing is ever broadcast.
//
//   npx tsx tests/e2e/v10-shots-<area>.mts before|after [only-name,only-name…] [phone-light,desktop-dark…]
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { enter, passkeyFile, virtualPasskey } from './qa-helpers.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const CONFIGS = [
  { id: 'phone-light', viewport: { width: 390, height: 844 }, dsf: 3, theme: 'light', mobile: true },
  { id: 'phone-dark', viewport: { width: 390, height: 844 }, dsf: 3, theme: 'dark', mobile: true },
  { id: 'desktop-light', viewport: { width: 1440, height: 900 }, dsf: 1, theme: 'light', mobile: false },
  { id: 'desktop-dark', viewport: { width: 1440, height: 900 }, dsf: 1, theme: 'dark', mobile: false },
] as const;
export type Cfg = (typeof CONFIGS)[number];
export interface Scenario {
  /** file name part: docs/v10/screens/<label>/<area>-<name>-<config>.webp */
  name: string; path: string;
  /** what to do after the page settled (open a sheet, type an amount…) */
  act?: (page: Page, cfg: Cfg) => Promise<void>;
  /** also capture the whole scrolling page (phone only) as <name>-full */
  full?: boolean;
  /** ms to wait after navigation before the capture (default 1800) */
  wait?: number;
  /** skip on these configs (a phone-only sheet, say) */
  skip?: (cfg: Cfg) => boolean;
}
export interface Group { base: string; setup?: (page: Page, context: BrowserContext, cfg: Cfg, base: string) => Promise<void>; scenarios: Scenario[] }

const children: ChildProcess[] = [];
process.on('exit', () => { for (const c of children) c.kill(); });
/** the Vite dev server of apps/web (the `?mock=1` mocks only exist in a development build) */
export async function startVite(port: number): Promise<string> {
  const base = `http://localhost:${port}`;
  try { if ((await fetch(base)).ok) return base; } catch { /* not running: start it */ }
  children.push(spawn(resolve(ROOT, 'apps/web/node_modules/.bin/vite'), ['--port', String(port), '--strictPort'], { cwd: resolve(ROOT, 'apps/web'), stdio: 'ignore' }));
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base)).ok) return base; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`the Vite dev server did not start on ${port}`);
}
/** enter the wallet of a QA stack (first-time setup or passkey unlock) with a Chromium virtual authenticator */
export const qaEnter = async (page: Page, context: BrowserContext, _cfg: Cfg, base: string): Promise<void> => {
  const pk = await virtualPasskey(context, page, passkeyFile(Number(new URL(base).port)));
  await enter(page, pk, process.env.QA_SETUP_TOKEN ?? 'qa-setup-token');
  await pk.save();
};
/** a call to the API from the page (same session, CSRF header) — for seeding a throwaway stack */
export const api = (page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => page.evaluate(async ([m, p, b]) => {
  const r = await fetch('/api/v1' + p, { method: m as string, credentials: 'same-origin', headers: m === 'GET' ? {} : { 'x-spw-csrf': '1', 'content-type': 'application/json' }, body: m === 'GET' ? undefined : JSON.stringify(b ?? {}) });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [method, path, body] as const);
export const settle = async (page: Page, ms = 1800): Promise<void> => {
  await page.waitForTimeout(ms);
  await page.waitForFunction(() => document.querySelectorAll('.animate-pulse, .skel').length === 0, null, { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(350);
};

export async function runShots(area: string, groups: Group[]): Promise<void> {
  const label = process.argv[2] === 'before' ? 'before' : 'after', only = (process.argv[3] ?? '').split(',').filter(Boolean), onlyCfg = (process.argv[4] ?? '').split(',').filter(Boolean);
  const OUT = resolve(ROOT, 'docs/v10/screens', label); mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(); let failed = 0;
  const shot = async (page: Page, name: string, cfg: Cfg, fullPage = false) => {
    const png = join(tmpdir(), `v10-${process.pid}.png`), base = join(OUT, `${area}-${name}-${cfg.id}`);
    await page.screenshot({ path: png, fullPage, animations: 'disabled', caret: 'hide' });
    try { execFileSync('cwebp', ['-quiet', '-q', '72', ...(cfg.mobile ? ['-resize', '600', '0'] : []), png, '-o', `${base}.webp`]); } catch { await page.screenshot({ path: `${base}.png`, fullPage }); }
    rmSync(png, { force: true });
    console.log(`${label}/${area}-${name}-${cfg.id}`);
  };
  for (const cfg of CONFIGS.filter((c) => !onlyCfg.length || onlyCfg.includes(c.id))) for (const g of groups) {
    const todo = g.scenarios.filter((s) => (!only.length || only.includes(s.name)) && !s.skip?.(cfg));
    if (!todo.length) continue;
    const context = await browser.newContext({ baseURL: g.base, viewport: cfg.viewport, deviceScaleFactor: cfg.dsf, isMobile: cfg.mobile, hasTouch: cfg.mobile, locale: 'fr-CA', timezoneId: 'America/Toronto', colorScheme: cfg.theme });
    await context.addInitScript((t) => { localStorage.setItem('spw-theme', t); localStorage.setItem('spw-locale', 'fr'); }, cfg.theme);
    const page = await context.newPage();
    try { await g.setup?.(page, context, cfg, g.base); } catch (e) { console.log(`FAILED setup of ${g.base} (${cfg.id}): ${String(e).slice(0, 300)}`); failed += todo.length; await context.close(); continue; }
    for (const s of todo) {
      try {
        await page.goto(s.path); await settle(page, s.wait ?? 1800);
        if (s.act) { await s.act(page, cfg); await settle(page, 600); }
        await shot(page, s.name, cfg);
        if (s.full && cfg.mobile) await shot(page, `${s.name}-full`, cfg, true);
      } catch (e) { failed += 1; console.log(`FAILED ${area}-${s.name}-${cfg.id}: ${String(e).slice(0, 300)}`); }
    }
    await context.close();
  }
  await browser.close();
  for (const c of children) c.kill();
  console.log(failed ? `${failed} capture(s) FAILED` : 'all captures written');
  process.exit(failed ? 1 : 0);
}
