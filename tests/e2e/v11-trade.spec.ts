/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : tests/e2e/v11-trade.spec.ts
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

// V11 interface — Trade, on a real local stack (PAPER only: the paper engine fills against the venue's public market data;
// nothing is signed, nothing is sent to a venue). Through the UI, end to end:
//   picker fed by the markets hub (a market the wallet cannot trade is labelled and opens its read-only sheet) →
//   paper order: preview → confirmation sheet with EVERY check of the unified risk engine and the mandate line → place → filled →
//   the unified blotter shows the position under « Simulation » (never under « Réel ») and the order with its state in words and
//   its transitions → close from the unified blotter;
//   command line: dry run first, the questions when the line does not settle everything, then the execution on paper.
//   tests/e2e/ui-stack.sh ui 8840 && SPW_E2E_BASE=http://localhost:8840 SPW_DEV_DIR=/tmp/spw-ui-ui pnpm e2e v11-trade.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { deviceUse, expectNoOverflow, MATRIX, openWallet, paperAccount, SHOTS } from './v11-helpers.ts';

const BTC = 'hyperliquid:BTC';
const W = {
  fr: { order: /^Ordre$/, positions: /^Positions/, size: 'Taille', review: /vérifier l’ordre BTC/, confirm: 'Confirmer l’ordre simulé', place: 'Placer l’ordre simulé', filled: 'Exécuté', paper: 'Simulation', live: 'Réel',
    mandate: /Sans objet : c’est votre session/, noSig: /Aucune signature : compte simulé/, history: /^Historique$/, closeConfirm: /Confirmer la fermeture/, dry: 'Aperçu — rien n’a été envoyé', questions: /La commande ne dit pas tout/, run: 'Exécuter en simulation', liveOff: /Réel indisponible/ },
  en: { order: /^Trade$/, positions: /^Positions/, size: 'Size', review: /review the BTC order/, confirm: 'Confirm the simulated order', place: 'Place the simulated order', filled: 'Filled', paper: 'Paper', live: 'Live',
    mandate: /Not applicable: this is your session/, noSig: /No signature: paper account/, history: /^Order history$/, closeConfirm: /Confirm the market close/, dry: 'Preview — nothing was sent', questions: /does not settle everything/, run: 'Run on paper', liveOff: /Live unavailable/ },
} as const;

for (const { device, lang } of MATRIX) {
  test.describe(`trade · ${device} · ${lang}`, () => {
    test.use(deviceUse(device, lang));
    const phone = device === 'phone';
    const panel = async (page: Page, name: RegExp) => { if (phone) await page.getByRole('tablist', { name: /Panneaux du terminal|Terminal panels/ }).getByRole('tab', { name }).click(); };

    test('paper order through the UI: hub picker → preview with every risk check → place → filled → unified blotter → close', async ({ page, context, baseURL }) => {
      test.setTimeout(240_000);
      const s = await openWallet(page, context, baseURL, { lang }), w = W[lang];
      const acct = await paperAccount(page, s, `Simulation ${device} ${lang}`);
      await page.addInitScript((id) => { localStorage.setItem('spw-fut-account', JSON.stringify(id)); }, acct);
      await page.goto(`/futures/${encodeURIComponent(BTC)}`);
      await expect(page.getByTestId('terminal')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('terminal')).toHaveAttribute('data-tone', 'paper');
      await expectNoOverflow(page, 'terminal');

      // the picker: fed by the markets hub — a dYdX market is labelled (the venue's terms exclude Canada) and still usable on paper;
      // its read-only sheet has no order form
      await page.getByTestId('market-picker').first().click();
      const dlg = page.getByRole('dialog', { name: /Choisir un marché|Choose a market/ });
      await expect(dlg.getByTestId('market-list')).toBeVisible({ timeout: 20_000 });
      await dlg.getByRole('searchbox').fill('dydx');
      const blocked = dlg.getByTestId('market-not-tradable').first();
      await expect(blocked).toContainText(w.liveOff, { timeout: 30_000 });
      await expect(blocked).toHaveAttribute('data-reason', /jurisdiction/);
      await page.screenshot({ path: `${SHOTS}/v11-trade-picker-${device}-${lang}.png` });
      await dlg.getByTestId('market-info').first().click();
      const sheet = page.getByTestId('mk-sheet');
      await expect(sheet).toBeVisible({ timeout: 20_000 });
      await expect(sheet.getByRole('button', { name: /Acheter|Vendre|Buy|Sell|Long|Short/ })).toHaveCount(0);   // read-only: nothing that looks like an order
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);

      // the order form (the existing paper panel), then its confirmation sheet with the unified checks
      await panel(page, w.order);
      await page.getByRole('textbox', { name: w.size }).fill('500');
      await expect(page.getByTestId('preview')).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: w.review }).click();
      const confirm = page.getByRole('dialog', { name: w.confirm });
      const checks = confirm.getByTestId('unified-checks');
      await expect(checks).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
      await expect(checks).toHaveAttribute('data-decision', 'allow');
      await expect(checks.getByTestId('uc-mandate')).toContainText(w.mandate);
      await expect(checks.getByTestId('uc-approval')).toContainText(w.noSig);
      await checks.getByTestId('uc-list').locator('summary').click();
      expect(await checks.getByTestId('uc-check').count()).toBeGreaterThanOrEqual(20);          // every check of the engine, not a summary
      await expect(checks.locator('[data-testid=uc-check][data-id=kill_switch]')).toHaveAttribute('data-ok', 'true');
      await expect(checks.locator('[data-testid=uc-check][data-ok=false][data-exempt=false]')).toHaveCount(0);
      await page.screenshot({ path: `${SHOTS}/v11-trade-confirm-${device}-${lang}.png` });
      await confirm.getByRole('button', { name: w.place }).click();
      await expect(page.getByTestId('order-result')).toBeVisible({ timeout: 30_000 });

      // unified blotter: the position is under « Simulation », there is no live list, the order reads « Exécuté »
      await panel(page, w.positions);
      const ub = page.getByTestId('unified-blotter');
      await ub.scrollIntoViewIfNeeded();
      const pos = ub.locator(`[data-testid=ub-position][data-instrument="${BTC}"][data-mode=paper][data-account="${acct}"]`);
      await expect(pos.first()).toBeVisible({ timeout: 30_000 });
      await expect(ub.getByTestId('ub-paper')).toContainText(w.paper);
      await expect(ub.getByTestId('ub-live')).toHaveCount(0);
      await page.screenshot({ path: `${SHOTS}/v11-trade-unified-${device}-${lang}.png`, fullPage: true });
      await ub.getByRole('tab', { name: w.history }).click();
      const order = ub.locator(`[data-testid=ub-order][data-status=FILLED][data-account="${acct}"]`).first();   // this test's own account: other specs of the stack have theirs
      await expect(order).toBeVisible({ timeout: 20_000 });
      await expect(order.getByTestId('order-state')).toContainText(w.filled);
      await order.getByTestId('ub-history').click();
      await expect(order.getByTestId('ub-transitions')).toContainText(w.filled, { timeout: 20_000 });
      await expectNoOverflow(page, 'unified blotter');

      // close from the unified blotter (two taps: nothing closes on one)
      await ub.getByRole('tab', { name: w.positions }).click();
      await pos.first().getByTestId('ub-close').click();
      await pos.first().getByRole('button', { name: w.closeConfirm }).click();
      await expect(ub.locator(`[data-testid=ub-position][data-instrument="${BTC}"][data-mode=paper][data-account="${acct}"]`)).toHaveCount(0, { timeout: 30_000 });
      expect(s.errors(), s.errors().join('\n')).toEqual([]);
    });

    test('command line: questions when the line does not say everything, a dry run first, then the paper execution', async ({ page, context, baseURL }) => {
      test.setTimeout(240_000);
      const s = await openWallet(page, context, baseURL, { lang }), w = W[lang];
      const acct = await paperAccount(page, s, `Simulation ${device} ${lang}`);
      await page.addInitScript((id) => { localStorage.setItem('spw-fut-account', JSON.stringify(id)); }, acct);
      // start from no stored default: the command must ASK
      const reset = await page.request.put('/api/v1/developer/command-defaults', { headers: s.headers(), data: { defaults: {} } });
      expect(reset.status(), await reset.text()).toBe(200);
      await page.goto(`/futures/${encodeURIComponent(BTC)}`);
      await expect(page.getByTestId('terminal')).toBeVisible({ timeout: 30_000 });
      await panel(page, w.order);
      const cmd = page.getByTestId('cmdline');
      await cmd.scrollIntoViewIfNeeded();
      await expect(cmd.getByTestId('mode-tag')).toHaveAttribute('data-tone', 'paper');

      // not a command → said in words, nothing executed
      await cmd.getByTestId('cmd-input').fill('ACHETE TOUT');
      await cmd.getByTestId('cmd-preview').click();
      await expect(cmd.getByTestId('cmd-problem')).toHaveAttribute('data-kind', 'parse', { timeout: 20_000 });

      // a line that leaves things open → the questions; each answer goes into the line or into the owner's defaults
      await cmd.getByTestId('cmd-input').fill('LONG BTC-PERP 300');
      await cmd.getByTestId('cmd-preview').click();
      await expect(cmd.getByTestId('cmd-questions')).toContainText(w.questions, { timeout: 30_000 });
      await page.screenshot({ path: `${SHOTS}/v11-trade-cmd-questions-${device}-${lang}.png` });
      const answers: Record<string, string> = { venue: 'hyperliquid', network: 'mainnet', leverage: '2', marginMode: 'cross', maxFeeBps: '20', maxSlippageBps: '100', orderTtlMs: '60', instrument: BTC };
      for (let k = 0; k < 10; k++) {
        const dry = cmd.getByTestId('cmd-dry'), q = cmd.getByTestId('cmd-question').first();
        await dry.or(q).first().waitFor({ timeout: 30_000 });
        if (await dry.isVisible()) break;
        const field = (await q.getAttribute('data-field'))!;
        const option = q.locator(`[data-option="${answers[field]}"]`);
        if (await option.count()) await option.click();
        else if (await q.locator('[data-option]').count()) await q.locator('[data-option]').first().click();
        else { await q.getByRole('textbox').fill(answers[field] ?? '1'); await q.getByRole('button').click(); }
        await expect(cmd.getByTestId('cmd-note')).toBeVisible({ timeout: 20_000 });
        await page.waitForTimeout(400);
      }
      const dry = cmd.getByTestId('cmd-dry');
      await expect(dry).toContainText(w.dry, { timeout: 30_000 });
      await expect(dry.getByTestId('cmd-canonical')).toHaveAttribute('data-instrument', BTC);
      await expect(dry.getByTestId('cmd-canonical')).toHaveAttribute('data-side', 'buy');
      await page.screenshot({ path: `${SHOTS}/v11-trade-cmd-dry-${device}-${lang}.png` });
      // nothing was placed by the dry run
      const before = await (await page.request.get('/api/v1/trading/orders?limit=100')).json() as { orders: { id: string }[] };
      await dry.getByTestId('cmd-run').click();
      const done = cmd.getByTestId('cmd-done');
      await expect(done).toHaveAttribute('data-kind', 'order', { timeout: 30_000 });
      await expect(done).toHaveAttribute('data-status', /^(FILLED|SUBMITTED|PARTIALLY_FILLED)$/);
      const after = await (await page.request.get('/api/v1/trading/orders?limit=100')).json() as { orders: { id: string; mode: string }[] };
      expect(after.orders.length).toBe(before.orders.length + 1);
      expect(after.orders.every((o) => o.mode === 'paper')).toBe(true);

      // a query, then the close by command (dry run, then run)
      await cmd.getByTestId('cmd-input').fill('SHOW POSITIONS');
      await cmd.getByTestId('cmd-preview').click();
      await expect(cmd.getByTestId('cmd-query')).toHaveAttribute('data-query', 'positions', { timeout: 20_000 });
      await cmd.getByTestId('cmd-input').fill('CLOSE BTC-PERP ON hyperliquid');
      await cmd.getByTestId('cmd-preview').click();
      await expect(cmd.getByTestId('cmd-dry')).toBeVisible({ timeout: 30_000 });
      await cmd.getByTestId('cmd-run').click();
      await expect(cmd.getByTestId('cmd-done')).toHaveAttribute('data-kind', 'order', { timeout: 30_000 });
      await expectNoOverflow(page, 'command line');
      expect(s.errors(), s.errors().join('\n')).toEqual([]);
    });
  });
}
