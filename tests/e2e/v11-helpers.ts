// V11 interface pass — what the `v11-*.spec.ts` files share. They run on a real local stack (tests/e2e/ui-stack.sh or
// scripts/dev-stack.sh: real API, real isolated signer, throwaway keystore and database, PAPER only, broadcast off) with a
// Chromium virtual authenticator. One stack serves every test of a run: the first test does the one-shot owner setup, the
// following ones unlock with the same throwaway passkey (kept in a file under the OS temp directory, per port).
//
//   tests/e2e/ui-stack.sh ui 8840
//   SPW_E2E_BASE=http://localhost:8840 SPW_DEV_DIR=/tmp/spw-ui-ui pnpm e2e v11-dashboard.spec.ts
//
// The matrix of the pass: phone 390×844 and desktop 1280×900, French and English, light theme (+ dark where a spec asks).
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { enter, passkeyFile, probe, unexpectedErrors, virtualPasskey, watch } from './qa-helpers.ts';

export const VIEWPORTS = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 900 } } as const;
export type Device = keyof typeof VIEWPORTS;
export type Lang = 'fr' | 'en';
export type Theme = 'light' | 'dark';
export const MATRIX: { device: Device; lang: Lang }[] = [{ device: 'phone', lang: 'fr' }, { device: 'phone', lang: 'en' }, { device: 'desktop', lang: 'fr' }, { device: 'desktop', lang: 'en' }];
/** `test.use(...)` options of one cell of the matrix */
export const deviceUse = (device: Device, lang: Lang) => ({ viewport: VIEWPORTS[device], isMobile: device === 'phone', hasTouch: device === 'phone', deviceScaleFactor: device === 'phone' ? 2 : 1, locale: lang === 'fr' ? 'fr-CA' : 'en-CA', timezoneId: 'America/Toronto',
  userAgent: device === 'phone' ? 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' });

const DEV_DIR = process.env.SPW_DEV_DIR ?? '/tmp/spw-dev';
const portOf = (baseURL: string | undefined): string => new URL(baseURL ?? 'http://localhost:8650').port || '80';
/** the passkey file belongs to ONE stack: when the stack was restarted (a new setup token), the old credential is forgotten */
function passkeyFor(baseURL: string | undefined): string {
  const f = passkeyFile(`v11-${portOf(baseURL)}`), stamp = `${f}.token`, token = readFileSync(`${DEV_DIR}/setup-token`, 'utf8').trim();
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== token) { rmSync(f, { force: true }); mkdirSync(f.replace(/\/[^/]+$/, ''), { recursive: true }); writeFileSync(stamp, token); }
  return f;
}
export interface Session { errors: () => string[]; headers: () => Record<string, string>; /** after a passkey signature made INSIDE the page (a switch release, an approval): the credential's counter moved — keep it for the next test of the stack */ save: () => Promise<void> }
/** Language and theme are the app's own settings (localStorage), set before the first script runs; then setup or unlock. */
export async function openWallet(page: Page, context: BrowserContext, baseURL: string | undefined, o: { lang?: Lang; theme?: Theme } = {}): Promise<Session> {
  const lang = o.lang ?? 'fr', theme = o.theme ?? 'light';
  await context.addInitScript(([l, t]) => { localStorage.setItem('spw-locale', l!); localStorage.setItem('spw-theme', t!); }, [lang, theme]);
  const w = watch(page);
  const pk = await virtualPasskey(context, page, passkeyFor(baseURL));
  await enter(page, pk, readFileSync(`${DEV_DIR}/setup-token`, 'utf8').trim());
  return { errors: () => unexpectedErrors(w), headers: () => ({ origin: baseURL ?? 'http://localhost:8650', 'x-spw-csrf': '1', 'idempotency-key': `v11-e2e-${randomUUID()}` }), save: pk.save };
}
/** no horizontal scroll of the page, nothing of the screen leaving the viewport */
export async function expectNoOverflow(page: Page, where = ''): Promise<void> {
  const p = await probe(page);
  expect(p.overflow, `horizontal overflow ${where} ${p.wide.join(' | ')}`).toBe(false);
  expect(p.wide, `elements outside the viewport ${where}`).toEqual([]);
}
/** a paper account on a venue (owner session; the route the terminal itself uses); returns its id */
export async function paperAccount(page: Page, s: Session, label = 'Simulation e2e', collateral = '10000', venue = 'hyperliquid'): Promise<string> {
  const list = await page.request.get('/api/v1/derivatives/accounts');
  const j = (await list.json()) as unknown, rows = (Array.isArray(j) ? j : (j as { accounts?: unknown[] }).accounts ?? []) as { id: string; label: string; kind: string; venue: string }[];
  const found = rows.find((a) => a.kind === 'paper' && a.label === label && a.venue === venue);
  if (found) return found.id;
  const r = await page.request.post('/api/v1/derivatives/accounts', { headers: s.headers(), data: { venue, label, collateral } });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()).id as string;
}
export const SHOTS = 'test-results/shots';

/**
 * Navigation of the V11 shell, the same call on a phone and on a desktop:
 *   an area (`home`, `markets`, `trade`, `agents`, `activity`) — the tab bar or the sidebar;
 *   a sub-view (`swap`, `futures`, `explorer`, `compare`, `private`) — its area, then the row under the header;
 *   anything else (`settings`, `security`, `developer`, `monitor`, `risk`, `alerts`, `receive`, `send`, `research`, `lock`) —
 *   the header menu on a phone, the sidebar on a desktop.
 */
const AREA_OF_SUB: Record<string, string> = { swap: 'trade', futures: 'trade', explorer: 'markets', compare: 'markets', private: 'markets' };
export async function navTo(page: Page, id: string): Promise<void> {
  const area = (a: string) => page.locator(`[data-area=${a}]`).locator('visible=true').first();
  if (['home', 'markets', 'trade', 'agents', 'activity'].includes(id)) { await area(id).click(); return; }
  if (AREA_OF_SUB[id]) {
    if ((await page.locator(`[data-testid=nav-sub] [data-sub=${id}]`).count()) === 0) await area(AREA_OF_SUB[id]!).click();
    const sub = page.locator(`[data-testid=nav-sub] [data-sub=${id}]`);
    await sub.waitFor({ timeout: 20_000 });
    if ((await sub.getAttribute('aria-selected')) !== 'true') await sub.click();
    return;
  }
  const menu = page.getByTestId('nav-menu');
  if (await menu.isVisible()) { await menu.click(); await page.getByTestId('nav-menu-sheet').locator(`[data-menu=${id}]`).click(); return; }
  if (id === 'alerts') { await page.getByTestId('alerts-bell').locator('visible=true').first().click(); return; }
  if (id === 'risk') { await page.getByTestId('risk-indicator').locator('visible=true').first().click(); return; }
  await page.locator(`aside [data-menu=${id}]`).click();
}
