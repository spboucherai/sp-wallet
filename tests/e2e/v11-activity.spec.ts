/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : tests/e2e/v11-activity.spec.ts
 * Module           : tests
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-16
 * Last Modified    : 2026-11-16
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

// V11 Activity on a real stack (tests/e2e/ui-stack.sh: real API, real isolated signer, throwaway keystore and database; PAPER
// only — the paper engine fills against the venue's public market data, nothing is signed and nothing is sent to a venue).
// The unified timeline: a paper order placed through the owner's routes is in the history, labelled « Simulation », with its
// unified state; the filters (kind, mode) are applied by the server; the order opens on its state transitions; the audit
// chain says it is intact; the CSV link carries the filters. Phone and desktop, French and English, light theme.
//   tests/e2e/ui-stack.sh ac 8820
//   SPW_E2E_BASE=http://localhost:8820 SPW_DEV_DIR=/tmp/spw-ui-ac pnpm e2e v11-activity.spec.ts
import { expect, test } from '@playwright/test';
import { deviceUse, expectNoOverflow, MATRIX, openWallet, paperAccount, SHOTS } from './v11-helpers.ts';

const BTC = 'hyperliquid:BTC';
const TEXT = {
  fr: { paper: 'Simulation', filled: 'Exécuté', orders: 'Ordres', live: 'Réel', intact: 'Chaîne d’audit intacte', none: 'Aucune opération ne correspond à ces filtres.', created: 'Compte de simulation créé', transitions: 'Transitions d’état', security: 'Sécurité' },
  en: { paper: 'Paper', filled: 'Filled', orders: 'Orders', live: 'Live', intact: 'Audit chain intact', none: 'No operation matches these filters.', created: 'Paper account created', transitions: 'State transitions', security: 'Security' },
} as const;

for (const { device, lang } of MATRIX) {
  test.describe(`${device} · ${lang}`, () => {
    test.use(deviceUse(device, lang));
    test(`Activity: one filterable history — a paper order, labelled, with its transitions; audit chain intact (${device}, ${lang})`, async ({ page, context, baseURL }) => {
      const s = await openWallet(page, context, baseURL, { lang }), x = TEXT[lang];
      // a paper account and one filled paper order (owner session; the routes the terminal itself uses)
      const account = await paperAccount(page, s);
      const placed = await page.request.post('/api/v1/trading/orders', { headers: s.headers(), data: { mode: 'paper', accountId: account, instrument: BTC, side: 'buy', type: 'market', size: '0.001' } });
      expect(placed.status(), await placed.text()).toBe(200);

      await page.goto('/activity');
      await expect(page.getByTestId('activity')).toBeVisible({ timeout: 20_000 });
      // the audit chain's verdict is on top
      await expect(page.getByTestId('ac-audit')).toHaveAttribute('data-intact', 'true', { timeout: 20_000 });
      await expect(page.getByTestId('ac-audit')).toContainText(x.intact);
      // the order is in the one list, labelled paper, with a final unified state — and an audit event next to it
      const order = page.locator('[data-testid=ac-item][data-kind=order][data-mode=paper]').first();
      await expect(order).toBeVisible({ timeout: 20_000 });
      await expect(order.getByTestId('ac-mode')).toHaveText(x.paper);
      await expect(order.getByTestId('ac-order-state')).toHaveAttribute('data-state', 'FILLED');
      await expect(order.getByTestId('ac-order-state')).toHaveText(x.filled);
      await expect(page.locator('[data-testid=ac-item][data-code="deriv.paper.account_created"]').first()).toContainText(x.created);
      await expectNoOverflow(page, 'activity');
      await page.screenshot({ path: `${SHOTS}/v11-activity-${device}-${lang}.png` });

      // filter: orders only (server-side) — the CSV link follows
      await page.getByRole('radio', { name: x.orders, exact: true }).click();
      await expect(page.locator('[data-testid=ac-item]:not([data-kind=order])')).toHaveCount(0);
      await expect(order).toBeVisible();
      await expect(page.getByTestId('ac-csv')).toHaveAttribute('href', /activity\.csv\?kind=order$/);
      // … and live only: this wallet has no live order — the filtered empty state, with a way back
      await page.getByRole('radio', { name: x.live, exact: true }).click();
      await expect(page.getByTestId('ac-empty-filtered')).toContainText(x.none);
      await expect(page.getByTestId('ac-csv')).toHaveAttribute('href', /activity\.csv\?kind=order&mode=live$/);
      await page.getByTestId('ac-reset').click();
      await expect(page.getByTestId('ac-csv')).toHaveAttribute('href', /activity\.csv$/);
      await expect(page.locator('[data-testid=ac-item][data-kind=security]').first()).toBeVisible();

      // the order opens on its state transitions (GET /trading/orders/:id → history)
      await order.getByRole('button').first().click();
      const history = order.getByTestId('ac-history');
      await expect(history).toContainText(x.transitions);
      await expect(history.getByTestId('ac-transition').first()).toBeVisible({ timeout: 15_000 });
      await expect(history.getByTestId('ac-transition').last()).toContainText(x.filled);
      await expectNoOverflow(page, 'activity, order open');
      await page.screenshot({ path: `${SHOTS}/v11-activity-order-${device}-${lang}.png` });

      // the CSV the link points at: the new kinds, the paper row says its mode
      const csv = await page.request.get('/api/v1/dashboard/activity.csv?kind=order');
      expect(csv.status()).toBe(200);
      const lines = (await csv.text()).trim().split('\n');
      expect(lines[0]).toContain('time_utc,kind,mode,venue,network,principal');
      expect(lines.slice(1).some((l) => l.includes('"order","paper","hyperliquid"') && l.includes('"FILLED"'))).toBe(true);
      expect(s.errors()).toEqual([]);
    });
  });
}
