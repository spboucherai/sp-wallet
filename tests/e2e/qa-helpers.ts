// Shared by qa-real.spec.ts and the manual QA walk: a Chromium VIRTUAL authenticator whose credential can be saved to a file
// and loaded again, so several browser sessions can use the one-shot owner setup of a single stack. The credential is a
// throwaway test passkey for a throwaway wallet; the file lives under test-results/ (git-ignored).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrowserContext, CDPSession, Page } from '@playwright/test';

/** Where the throwaway virtual passkey of the stack on `port` is kept between browser sessions (deleted by qa-real-server.mts at boot). */
export const passkeyFile = (port: number | string): string => join(tmpdir(), 'spw-qa', `passkey-${port}.json`);
export interface QaPasskey { cdp: CDPSession; authenticatorId: string; save: () => Promise<void> }
export async function virtualPasskey(context: BrowserContext, page: Page, file: string): Promise<QaPasskey> {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  if (existsSync(file)) for (const credential of JSON.parse(readFileSync(file, 'utf8')) as never[]) await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
  const save = async () => { const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId }); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(credentials)); };
  return { cdp, authenticatorId, save };
}
/** Open the wallet: first-time setup when the stack is fresh, passkey unlock otherwise. Works in French and English. */
export async function enter(page: Page, pk: QaPasskey, setupToken: string): Promise<'setup' | 'unlock' | 'open'> {
  await page.goto('/');
  const token = page.getByRole('textbox'), unlock = page.getByRole('button', { name: /Déverrouiller|Unlock/ }), home = page.getByText(/Valeur totale estimée|Estimated total value/);
  await token.or(unlock).or(home).first().waitFor({ timeout: 30_000 });
  if (await home.isVisible()) return 'open';
  if (await token.isVisible()) {
    await token.fill(setupToken);
    await page.getByRole('button', { name: /Créer ma clé|Create my passkey/ }).click();
    await home.waitFor({ timeout: 30_000 });
    await pk.save();
    return 'setup';
  }
  await unlock.click();
  await home.waitFor({ timeout: 30_000 });
  await pk.save();   // the signature counter moved
  return 'unlock';
}
/** Console errors, page errors and failed/4xx/5xx requests of a page, for the QA report. */
export function watch(page: Page): { errors: string[]; failed: string[] } {
  const errors: string[] = [], failed: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`));
  page.on('requestfailed', (r) => { if (!/quote\/stream/.test(r.url())) failed.push(`${r.method()} ${new URL(r.url()).pathname} ${r.failure()?.errorText ?? ''}`); });
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
  return { errors, failed };
}
/** Layout probes run inside the page: horizontal overflow, elements leaving the viewport, interactive elements under 44 px.
 *  (A string, not a function: tsx/esbuild wraps named inner functions with a helper that does not exist in the page.) */
const PROBE = `(() => {
  const vw = window.innerWidth, out = { overflow: document.documentElement.scrollWidth > vw, wide: [], small: [] };
  const label = (e) => e.tagName.toLowerCase() + '[' + (e.getAttribute('aria-label') || e.innerText || '').trim().slice(0, 40).replace(/\\s+/g, ' ') + ']';
  for (const e of Array.from(document.querySelectorAll('main *, [role=dialog] *'))) { const r = e.getBoundingClientRect(); if (r.width > 0 && (r.right > vw + 1 || r.left < -1) && !e.closest('.overflow-x-auto, .no-scrollbar')) out.wide.push(label(e) + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); }
  for (const e of Array.from(document.querySelectorAll('button, a[href], select, input:not([type=hidden]):not([type=checkbox]), [role=radio], [role=tab], [role=checkbox], [role=switch]'))) { const r = e.getBoundingClientRect(); if (r.width > 0 && r.height > 0 && (r.height < 43.5 || r.width < 43.5)) out.small.push(label(e) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
  out.wide = out.wide.slice(0, 12); out.small = Array.from(new Set(out.small)).slice(0, 40);
  return out;
})()`;
export const probe = (page: Page): Promise<{ overflow: boolean; wide: string[]; small: string[] }> => page.evaluate(PROBE);
