/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : tests/e2e/next-shots.spec.ts
 * Module           : tests
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

// NEXT web — the screenshots of docs/next/screens/web/ (review material, not assertions): every core screen at phone
// (390 × 844) and desktop (1440 × 900) widths, light and dark, French and English, on a real local stack. A throwaway wallet
// is empty, so the populated views are FIXTURE-FED (tests/e2e/fixtures/next/wallet.ts, `page.route` over the real answers):
// a file named `…-fixture.png` shows invented figures; a file named `…-real.png` shows the stack's own (empty) data.
//
//   tests/e2e/ui-stack.sh nextweb 8870
//   NEXT_SHOTS=1 SPW_E2E_BASE=http://localhost:8870 SPW_DEV_DIR=/tmp/spw-ui-nextweb pnpm e2e next-shots.spec.ts
//   NEXT_SHOTS=dash,send …   only the screens named (dash assets asset activity send receive contacts security settings search empty ext)
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { ADDR, IDS, populate } from './fixtures/next/wallet.ts';
import { roomInRateLimit } from './qa-helpers.ts';
import { openWallet, type Lang, type Theme } from './v11-helpers.ts';

const OUT = process.env.NEXT_SHOTS_DIR ?? 'docs/next/screens/web';
const WANT = (process.env.NEXT_SHOTS ?? '').split(',').filter((x) => x && x !== '1');
const want = (id: string): boolean => WANT.length === 0 || WANT.includes(id);
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1440, height: 900 } } as const;
type Size = keyof typeof SIZES;
/** which screens each cell of the matrix captures (≤ 60 files in all) */
const ALL = ['dash', 'assets', 'asset', 'activity', 'send', 'receive', 'contacts', 'security', 'settings', 'search'];
const CELLS: { size: Size; lang: Lang; theme: Theme; screens: string[] }[] = [
  { size: 'phone', lang: 'fr', theme: 'light', screens: [...ALL, 'empty', 'ext'] }, { size: 'desktop', lang: 'fr', theme: 'light', screens: [...ALL, 'empty'] },
  { size: 'phone', lang: 'fr', theme: 'dark', screens: ['dash', 'assets', 'activity', 'security', 'send'] }, { size: 'desktop', lang: 'fr', theme: 'dark', screens: ['dash', 'asset', 'activity', 'security', 'settings'] },
  { size: 'phone', lang: 'en', theme: 'light', screens: ['dash', 'activity', 'send', 'security', 'settings'] }, { size: 'desktop', lang: 'en', theme: 'light', screens: ['dash', 'assets', 'send', 'contacts', 'security'] },
  { size: 'phone', lang: 'en', theme: 'dark', screens: ['dash', 'asset'] }, { size: 'desktop', lang: 'en', theme: 'dark', screens: ['dash', 'activity'] },
];
/** a draft as POST /transfers/proposals answers it (two warnings that ask for an acknowledgement) */
const REVIEW = { id: '99999999-9999-4999-8999-999999999999', state: 'draft', lifecycle: 'draft', network: 'base', networkName: 'Base', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6, amount: '125500000', amountDisplay: '125.5',
  from: ADDR.me, to: ADDR.rent, note: '', memo: null, feeDisplay: '0.0000021', maxFeeDisplay: '0.0000034', feeSymbol: 'ETH', warnings: ['duplicate_recent', 'l1_fee_unknown'], intentHash: '3f'.repeat(32), txid: null, explorer: null, confirmations: 0, error: null,
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 180_000).toISOString() };
test.skip(!process.env.NEXT_SHOTS, 'screenshots are taken on demand (NEXT_SHOTS=1)');

async function settle(page: Page): Promise<void> {
  await expect(page.locator('main .skel')).toHaveCount(0, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(450);
}
for (const cell of CELLS) {
  test.describe(`${cell.size} ${cell.lang} ${cell.theme}`, () => {
    test.use({ viewport: SIZES[cell.size], isMobile: cell.size === 'phone', hasTouch: cell.size === 'phone', deviceScaleFactor: 1, locale: cell.lang === 'fr' ? 'fr-CA' : 'en-CA', timezoneId: 'America/Toronto', colorScheme: 'light',
      userAgent: cell.size === 'phone' ? 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' });
    test('screens', async ({ page, context, baseURL }) => {
      test.setTimeout(600_000);
      mkdirSync(OUT, { recursive: true });
      const shot = async (name: string, kind: 'fixture' | 'real', o: { full?: boolean } = {}) => {
        await settle(page);
        const h = await page.evaluate(() => document.documentElement.scrollHeight), full = o.full !== false && h > SIZES[cell.size].height + 4;
        // a page longer than the screen is captured whole (bounded to two or three screens: the files stay small — tests/e2e/next-shots-shrink.py then reduces them to a palette). The phone's tab bar is
        // fixed to the viewport: on such a capture it would be drawn across the middle of the page, so it is left out of it.
        const hide = full ? await page.addStyleTag({ content: '[data-testid=nav-tabbar]{display:none!important}' }) : null;
        await page.screenshot({ path: `${OUT}/${name}-${cell.size}-${cell.theme}-${cell.lang}-${kind}.png`, scale: 'css', animations: 'disabled', ...(full ? { fullPage: true, clip: { x: 0, y: 0, width: SIZES[cell.size].width, height: Math.min(h, Math.round(SIZES[cell.size].height * (cell.size === 'phone' ? 2.6 : 2.1))) } } : {}) });
        await hide?.evaluate((el) => el.remove());
      };
      await openWallet(page, context, baseURL, { lang: cell.lang, theme: cell.theme });
      if (cell.screens.includes('empty') && want('empty')) { await page.goto('/'); await page.getByTestId('balance-card').waitFor(); await shot('dashboard-empty', 'real'); }
      await populate(page);
      // in-app navigation (no reload): the API allows 240 requests a minute per client, static files included — a reload per screen would reach it
      const go = async (path: string, ready: string) => { await roomInRateLimit(page, 60); await page.evaluate((p) => { history.pushState({ spw: 1 }, '', p); dispatchEvent(new PopStateEvent('popstate')); scrollTo(0, 0); }, path); await page.getByTestId(ready).first().waitFor({ timeout: 30_000 }); };
      await page.reload(); await page.getByTestId('balance-card').waitFor({ timeout: 30_000 });   // the fixtures take effect from this read on
      for (const s of cell.screens) {
        if (!want(s) || s === 'empty') continue;
        if (s === 'dash') { await go('/', 'history'); await page.getByTestId('recent-activity').waitFor(); await shot('dashboard', 'fixture'); }
        if (s === 'assets') { await go('/assets', 'assets-held'); await shot('assets', 'fixture'); }
        if (s === 'asset') { await go('/asset/ethereum/native', 'asset-networks'); await shot('asset', 'fixture'); }
        if (s === 'activity') { await go(`/activity?tx=${IDS.dropped}`, 'ac-detail'); await page.evaluate(() => scrollTo(0, 0)); await shot('activity', 'fixture'); }
        if (s === 'send') { await go('/send?n=base', 'send-review'); await page.locator('textarea').first().fill(ADDR.rent); await page.getByPlaceholder(/0[.,]00/).fill(cell.lang === 'fr' ? '125,50' : '125.50'); await shot('send', 'fixture');
          // the review (French, light): the draft is answered by the test — nothing is prepared on the server, nothing can be signed
          if (cell.lang === 'fr' && cell.theme === 'light') {
            await page.route('**/api/v1/transfers/proposals', (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REVIEW) }) : route.fallback()));
            await page.route(`**/api/v1/transfers/proposals/${REVIEW.id}/reject`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
            await page.getByTestId('send-review').click(); await page.getByTestId('send-approve').waitFor(); await shot('send-review', 'fixture');
            await page.getByTestId('send-cancel').click(); await page.getByTestId('send-review').waitFor();
          } }
        if (s === 'receive') { await go('/receive?n=base', 'qr-card'); await shot('receive', 'real'); }
        if (s === 'contacts') { await go('/contacts', 'contact-list'); await shot('contacts', 'fixture'); }
        if (s === 'security') { await go('/security', 'security'); await shot('security', 'fixture'); }
        if (s === 'settings') { await go('/settings', 'settings'); await shot('settings', 'real'); }
        // three of the extended areas (they inherit the tokens and the shared components; they were not redesigned)
        if (s === 'ext') { for (const [path, name] of [['/swap', 'ext-swap'], ['/alerts', 'ext-alerts'], ['/agents', 'ext-agents']] as const) { await roomInRateLimit(page, 60); await page.evaluate((p) => { history.pushState({ spw: 1 }, '', p); dispatchEvent(new PopStateEvent('popstate')); scrollTo(0, 0); }, path); await page.waitForTimeout(2500); await shot(name, 'real'); } }
        if (s === 'search') { await go('/', 'history'); await page.keyboard.press('Control+k'); await page.getByTestId('search-input').fill('usd'); await page.getByTestId('search-results').waitFor(); await shot('search', 'fixture', { full: false }); await page.keyboard.press('Escape'); }
      }
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    });
  });
}
