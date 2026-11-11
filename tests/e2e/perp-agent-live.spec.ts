import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// v7 — the REAL mode of a perp agent against the in-browser mock (`?mock=1`, development build only): no backend, no venue,
// no signer, a simulated passkey. What is real in the mock: the canonical mandate (schema, hash, validity against the
// authorization), the jurisdiction text and its hash, the server's French and English sentences (a copy of live-texts.ts);
// what is not: the engine, the venue (a paper account — play money whatever the network is called) and the signer.
// See apps/web/src/derivatives/{mockLive,mockPerpLive}.ts. The spec starts its own Vite dev server (or uses FUTURES_URL).
// PERP_SHOTS=1 writes docs/v7/screens/*.png.
//   npx playwright test -c tests/e2e/playwright.config.ts perp-agent-live.spec.ts
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5191;
const BASE = process.env.FUTURES_URL ?? `http://localhost:${PORT}`;
const SHOTS = resolve(ROOT, 'docs/v7/screens');
const AGENT = '7e57a9e1-0000-4000-8000-000000000001';
let vite: ChildProcess | null = null;

test.beforeAll(async () => {
  if (process.env.FUTURES_URL) return;
  vite = spawn(resolve(ROOT, 'apps/web/node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], { cwd: resolve(ROOT, 'apps/web'), stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the Vite dev server did not start');
});
test.afterAll(() => { vite?.kill(); });

const errorsOf = (page: Page) => { const errors: string[] = []; page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); }); page.on('pageerror', (e) => errors.push(String(e))); return errors; };
type Scenario = 'paper' | 'no_strategy' | 'ready' | 'small' | 'live' | 'mainnet_locked';
const perp = (page: Page, name: 'scenario' | 'holdStop' | 'exit' | 'stopOpen', ...args: unknown[]) => page.evaluate(([n, a]) => (window as any).__spwMock.perp[n as string](...(a as unknown[])), [name, args] as const);
const liveHook = (page: Page, name: string, ...args: unknown[]) => page.evaluate(([n, a]) => (window as any).__spwMock.live[n as string](...(a as unknown[])), [name, args] as const);
const perpState = (page: Page): Promise<{ state: string; mode: string; accountId: string | null }> => page.evaluate(() => (window as any).__spwMock.perp.state());

const SIZES = [
  { name: 'phone', use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  { name: 'desktop', use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false } },
] as const;

for (const size of SIZES) {
  test.describe(`perp agent live — ${size.name}`, () => {
    test.use({ ...size.use, locale: 'fr-CA' });
    const shot = async (page: Page, name: string, fullPage = false) => {
      if (process.env.PERP_SHOTS !== '1') return;
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: `${SHOTS}/${size.name}-${name}.png`, fullPage });
    };
    /** the agent page with the mock's scripted agent in a scenario (`&perp=`; the mock lives in the page, a full load starts the scenario again) */
    const open = async (page: Page, scenario: Scenario) => {
      await page.goto(`${BASE}/agents/${AGENT}?mock=1&perp=${scenario}`);
      await expect(page.getByRole('heading', { name: 'BTC momentum' })).toBeVisible({ timeout: 30_000 });   // the dev server compiles the page on its first load
    };
    /** read the agent again without reloading the page: back to the list, then the agent */
    const refresh = async (page: Page) => {
      await page.getByRole('button', { name: 'Retour' }).click();
      await page.getByRole('button', { name: /BTC momentum/ }).click();
      await expect(page.getByRole('heading', { name: 'BTC momentum' })).toBeVisible();
    };
    const golive = (page: Page) => page.getByTestId('pl-golive');
    const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

    test('go-live checklist: each step names the next action; the account step sends to Futures → Comptes', async ({ page }) => {
      const errors = errorsOf(page);
      // 1 — nothing approved: the strategy is the next step; the page is a SIMULATION and says so
      await open(page, 'no_strategy');
      await expect(page.getByText('SIMULATION').first()).toBeVisible();
      await expect(page.getByTestId('agent-band')).toHaveCount(0);
      await expect(golive(page)).toHaveAttribute('data-next', 'strategy');
      await expect(page.getByTestId('pl-step-strategy')).toHaveAttribute('data-state', 'next');
      await expect(page.getByTestId('pl-step-account')).toHaveAttribute('data-state', 'later');
      await expect(page.getByTestId('pl-next')).toHaveText('Choisir et approuver une stratégie');
      await golive(page).scrollIntoViewIfNeeded();
      await shot(page, '01-wizard-strategy');
      // approving the tested version moves the checklist on
      await page.getByRole('button', { name: 'Approuver cette version' }).click();
      await expect(golive(page)).toHaveAttribute('data-next', 'account');
      await expect(page.getByTestId('pl-step-strategy')).toHaveAttribute('data-state', 'done');
      await expect(page.getByTestId('pl-step-strategy')).toContainText('son empreinte sera inscrite dans le mandat');

      // 2 — no venue account: created and authorised by the owner in Futures → Comptes, linked from here
      await expect(page.getByTestId('pl-account-why')).toHaveAttribute('data-code', 'no_account');
      await expect(page.getByTestId('pl-step-funded')).toContainText('Pourquoi 50 USDC');
      await golive(page).scrollIntoViewIfNeeded();
      await shot(page, '02-wizard-account');
      await page.getByTestId('pl-next').click();
      await expect(page).toHaveURL(/\/futures\?v=accounts/);
      await expect(page.getByTestId('live-card')).toBeVisible();
      // the accounts view speaks of mandates with the V6 config: available, and locked on mainnet by a SERVER SETTING (the server's own French sentence)
      await expect(page.getByTestId('mandate-mode-note')).toContainText('Il s’active depuis la page d’un agent');
      await expect(page.getByTestId('mandate-mainnet-setting')).toContainText('réglage du serveur');
      await expect(page.getByTestId('mandate-mainnet-setting')).toContainText('SPW_DERIV_LIVE_MAINNET=on ET SPW_DERIV_MANDATE_MAINNET=on');
      await expect(page.getByTestId('mandate-mainnet-setting').getByRole('button')).toHaveCount(0);
      await expect(page.getByTestId('mandate-mainnet-setting').getByRole('checkbox')).toHaveCount(0);
      await shot(page, '03-accounts-mandate-setting', true);

      // 3 — an authorised account below the minimum: the funded step is next, with the computed minimum explained
      await open(page, 'small');
      await expect(golive(page)).toHaveAttribute('data-next', 'fund');
      await expect(page.getByTestId('pl-step-account')).toHaveAttribute('data-state', 'done');
      await expect(page.getByTestId('pl-step-account')).toContainText('testnet — argent fictif');
      await expect(page.getByTestId('pl-funded-why')).toHaveAttribute('data-code', 'below_minimum');
      await expect(page.getByTestId('pl-funded-why')).toContainText('Il en faut au moins 50');
      await expect(page.getByTestId('pl-fund-why')).toContainText('l’ordre minimal de la plateforme est de 10 USD');
      await expect(page.getByTestId('pl-next')).toHaveText(/Voir comment alimenter le compte/);
      await golive(page).scrollIntoViewIfNeeded();
      await shot(page, '04-wizard-fund');
      await noOverflow(page);
      expect(errors).toEqual([]);
    });

    test('mandate review: limits from the agent\'s settings, the acknowledgement checkbox is mandatory, ONE passkey, then LIVE on the testnet', async ({ page }) => {
      const errors = errorsOf(page);
      await open(page, 'ready');
      await expect(golive(page)).toHaveAttribute('data-next', 'mandate');
      for (const s of ['strategy', 'account', 'funded']) await expect(page.getByTestId(`pl-step-${s}`)).toHaveAttribute('data-state', 'done');
      await expect(page.getByTestId('pl-step-mandate')).toHaveAttribute('data-state', 'next');
      await golive(page).scrollIntoViewIfNeeded();
      await shot(page, '05-wizard-mandate-next');
      await page.getByTestId('pl-next').click();
      const sheet = page.getByTestId('mandate-sheet');
      await expect(sheet).toHaveAttribute('data-phase', 'form');
      await expect(sheet.getByTestId('mode-band')).toHaveAttribute('data-tone', 'testnet');
      // the reference capital is the venue account's value, not a field; a duration beyond what the authorization leaves: nothing to prepare
      await expect(sheet.getByTestId('mandate-capital')).toContainText('1 000,00 USDC — la valeur du compte de la plateforme');
      await expect(sheet.getByTestId('mandate-capital').getByRole('textbox')).toHaveCount(0);
      await sheet.getByRole('textbox', { name: 'Durée du mandat' }).fill('31');
      await expect(sheet.getByTestId('mandate-problem')).toContainText(/La durée doit être de 1 à 2[89] jours/);
      await expect(sheet.getByTestId('mandate-continue')).toBeDisabled();
      await sheet.getByRole('textbox', { name: 'Durée du mandat' }).fill('14');
      await shot(page, '06-mandate-form');
      await sheet.getByTestId('mandate-continue').click();
      await expect(sheet).toHaveAttribute('data-phase', 'review');

      // what is shown before the passkey: the server's warning, every limit, the pinned strategy hash, the network, the texts
      await expect(sheet.getByTestId('mandate-warning')).toContainText('SANS demander votre clé d\'accès');
      await expect(sheet.getByTestId('mandate-network')).toHaveText('testnet — argent fictif');
      await expect(sheet.getByTestId('mandate-sha')).toHaveText('c0de5eed'.repeat(8));
      const limits = sheet.getByTestId('mandate-limits');
      await expect(limits).toContainText('BTC : levier max. / position max.');
      await expect(limits).toContainText('2× / 1 000,00 $');
      await expect(limits).toContainText('Plancher de valeur du compte');
      await expect(limits).toContainText('900,00 $');                                  // 1 000 less the 10 % total-loss limit
      await expect(sheet.getByTestId('ack-text')).toContainText('Hyperliquid — conditions de la plateforme et votre juridiction (Québec, Canada)');
      await expect(sheet.getByTestId('mandate-enforced')).toContainText('lues par le signataire lui-même');
      await expect(sheet.getByTestId('mandate-trusted')).toContainText('point d\'accès public d\'information de la plateforme');
      await expect(sheet.getByTestId('mandate-not-enforced')).toContainText('consignée, pas vérifiée');
      await expect(sheet.getByTestId('mandate-winddown')).toContainText('Pendant 24 heures');
      await expect(sheet.getByTestId('mandate-integrity')).toHaveCount(0);
      await shot(page, '07-mandate-review-top');
      // the checkbox is mandatory
      await expect(sheet.getByTestId('mandate-approve')).toBeDisabled();
      await expect(sheet.getByTestId('mandate-approve')).toHaveText(/testnet/);
      await sheet.getByTestId('mandate-approve').scrollIntoViewIfNeeded();
      await shot(page, '08-mandate-review-bottom');
      // a dismissed passkey prompt consumes nothing on the venue and leaves the agent in simulation
      await sheet.getByTestId('ack-check').check();
      await liveHook(page, 'passkey', 'cancel');
      await sheet.getByTestId('mandate-approve').click();
      await expect(sheet).toHaveAttribute('data-phase', 'void');
      await expect(sheet.getByTestId('live-error')).toHaveAttribute('data-code', 'passkey_cancelled');
      expect((await perpState(page)).mode).toBe('PAPER');
      await sheet.getByTestId('mandate-again').click();
      await sheet.getByTestId('mandate-continue').click();
      await expect(sheet).toHaveAttribute('data-phase', 'review');
      await sheet.getByTestId('ack-check').check();
      await sheet.getByTestId('mandate-approve').click();                                // ONE passkey prompt
      await expect(sheet.getByTestId('mandate-done')).toBeVisible();
      expect(await perpState(page)).toMatchObject({ state: 'LIVE', mode: 'LIVE' });
      await shot(page, '09-mandate-approved');
      await sheet.getByTestId('mandate-close').click();

      // the page is now the LIVE page of a TESTNET agent: the band says play money, never « réel »
      const band = page.getByTestId('agent-band');
      await expect(band).toHaveAttribute('data-tone', 'testnet');
      await expect(band).toContainText('Testnet — argent fictif');
      await expect(page.getByTestId('pl-signal-note')).toHaveText('Sur le testnet : signaux calculés sur les barres du marché réel ; ordres exécutés sur le carnet du testnet, argent fictif.');
      await expect(page.getByTestId('agent-live-state')).toContainText('En marche');
      await expect(page.getByTestId('agent-live-state')).not.toContainText('Réel');
      await expect(page.getByText('SIMULATION', { exact: true })).toHaveCount(0);
      await expect(page.getByTestId('pl-mandate-phase')).toHaveText('En vigueur');
      await noOverflow(page);
      expect(errors).toEqual([]);
    });

    test('LIVE testnet agent: venue account, mandate card with the signer\'s counters, holds in plain words, pause, stop → wind-down → STOPPED flat', async ({ page }) => {
      const errors = errorsOf(page);
      await open(page, 'live');
      const band = page.getByTestId('agent-band');
      await expect(band).toHaveAttribute('data-tone', 'testnet');
      await expect(band.getByTestId('mode-band')).toContainText('Testnet — argent fictif');
      await expect(page.getByText('Réel — argent réel')).toHaveCount(0);
      // the venue account: read on the venue, one long position
      const acct = page.getByTestId('pl-account');
      await expect(acct).toHaveAttribute('data-network', 'testnet');
      await expect(acct.getByTestId('mode-tag')).toHaveAttribute('data-tone', 'testnet');
      await expect(acct).toContainText('Capital de référence : 1 000,00 USDC');
      await expect(acct.getByText('BTC', { exact: true }).first()).toBeVisible();
      await expect(acct).toContainText(/Long|Achat/i);
      await shot(page, '10-live-top');
      // the mandate card: limits, expiry, the signer's counters of the day
      const mandate = page.getByTestId('pl-mandate');
      await expect(mandate).toHaveAttribute('data-phase', 'active');
      await expect(mandate.getByTestId('pl-usage')).toContainText('Ordres ajoutant de l’exposition');
      await expect(mandate.getByTestId('pl-usage')).toContainText('1 / 48');
      await expect(mandate.getByTestId('pl-floor')).toContainText('Plancher 900,00 USDC');
      await mandate.scrollIntoViewIfNeeded();
      await shot(page, '11-live-mandate-card');
      // holds and refusals: our sentence (what happened, what to do), then the server's own words
      const holds = page.getByTestId('pl-holds');
      await expect(holds.locator('[data-code="signer_position_exceeded"]')).toContainText('la position sur ce marché aurait pu dépasser la limite du mandat');
      await expect(holds.locator('[data-code="signer_position_exceeded"]')).toContainText('worst-case BTC position');
      await expect(holds.locator('[data-code="live_cooldown"]')).toContainText('L’agent attend sa prochaine passe');
      await holds.scrollIntoViewIfNeeded();
      await shot(page, '12-live-holds-refusals');
      // controls: what pause and stop do is written; a manual order's effect is explained
      const controls = page.getByTestId('pl-controls');
      await expect(controls).toContainText('Les positions ouvertes sont CONSERVÉES');
      await expect(controls).toContainText('sans clé d’accès');
      await expect(controls.getByTestId('pl-manual-warn')).toContainText('crée une divergence');
      await controls.scrollIntoViewIfNeeded();
      await shot(page, '13-live-controls');
      await controls.getByTestId('pl-pause').click();
      await expect(page.getByTestId('pl-paused')).toContainText('Ses positions restent ouvertes');
      await expect(page.getByTestId('agent-live-state')).toHaveAttribute('data-state', 'PAUSED');
      expect((await perpState(page)).state).toBe('PAUSED');
      await page.getByTestId('pl-paused').scrollIntoViewIfNeeded();
      await shot(page, '14-live-paused');
      await controls.getByTestId('pl-resume').click();
      await expect(page.getByTestId('agent-live-state')).toHaveAttribute('data-state', 'LIVE');

      // the Futures terminal says an agent drives this account
      await page.goto(`${BASE}/futures?v=accounts&mock=1`);
      const note = page.getByTestId('live-account-testnet').getByTestId('agent-on-account');
      await expect(note).toContainText('Compte piloté par l’agent « BTC momentum »');
      await expect(note).toContainText('un ordre manuel sur ce compte');
      await note.scrollIntoViewIfNeeded();
      await shot(page, '15-terminal-account-used-by-agent');
      await note.getByRole('link', { name: /Voir l’agent/ }).click();
      await expect(page.getByRole('heading', { name: 'BTC momentum' })).toBeVisible();

      // stop: no passkey; the mandate is revoked, the wind-down starts, the engine closes with reduce-only orders
      await perp(page, 'holdStop', true);
      await page.getByTestId('pl-stop').click();
      const stop = page.getByTestId('pl-stop-sheet');
      await expect(stop.getByTestId('mode-band')).toHaveAttribute('data-tone', 'testnet');
      await expect(stop).toContainText('Positions ouvertes sur le compte : 1.');
      await shot(page, '16-stop-confirm');
      await stop.getByTestId('pl-stop-confirm').click();
      await expect(stop.getByTestId('pl-stop-done')).toContainText('Pendant 24 heures');
      await expect(stop.getByTestId('pl-stop-result')).toContainText('stopping: 1 position(s) still open (long');
      await stop.getByRole('button', { name: 'Fermer' }).last().click();
      await expect(page.getByTestId('pl-stopping')).toContainText('Positions encore ouvertes : 1.');
      await expect(page.getByTestId('pl-stopping')).toContainText(/Fermetures encore possibles pendant (23 h \d\d min|24 h 00 min)/);
      await expect(page.getByTestId('agent-live-state')).toHaveAttribute('data-state', 'STOPPING');
      await expect(page.getByTestId('pl-exit')).toHaveAttribute('data-code', 'owner_stop');
      await expect(page.getByTestId('pl-mandate')).toHaveAttribute('data-phase', 'wind_down');
      await expect(page.getByTestId('pl-controls')).toHaveCount(0);                       // nothing left to pause or stop
      await page.getByTestId('pl-exit').scrollIntoViewIfNeeded();
      await shot(page, '17-stopping-wind-down');
      await page.getByTestId('pl-mandate').scrollIntoViewIfNeeded();
      await shot(page, '18-stopping-mandate-countdown');
      // the engine closes (reduce-only), the agent is STOPPED and flat; the band still names the testnet
      await perp(page, 'holdStop', false);
      await expect.poll(async () => (await perpState(page)).state, { timeout: 15_000 }).toBe('STOPPED');
      await refresh(page);
      await expect(page.getByTestId('agent-live-state')).toHaveAttribute('data-state', 'STOPPED');
      await expect(page.getByTestId('agent-band')).toHaveAttribute('data-tone', 'testnet');
      await expect(page.getByTestId('pl-account')).toContainText('Aucune position');
      await expect(page.getByTestId('pl-exit')).toContainText('Vous avez arrêté l’agent');
      await expect(page.getByTestId('pl-exit-detail')).toContainText('every position was closed with reduce-only orders');
      await expect(page.getByTestId('pl-open-left')).toHaveCount(0);
      await expect(page.getByTestId('pa-start-paper')).toHaveText('Revenir en simulation');
      await expect(golive(page)).toHaveAttribute('data-next', 'mandate');                 // a NEW mandate is needed each time
      await shot(page, '19-stopped-flat');
      await noOverflow(page);
      expect(errors).toEqual([]);
    });

    test('refusals: the agent leaves LIVE on a divergence; the mainnet-autonomous lock is a server setting, in the server\'s words', async ({ page }) => {
      const errors = errorsOf(page);
      await open(page, 'live');
      await perp(page, 'holdStop', true);
      await perp(page, 'exit', 'divergence', 'the venue\'s state and the wallet\'s records differ (order 9000001 on hyperliquid:BTC rests on the venue and was not placed by the wallet): the agent leaves LIVE');
      await refresh(page);
      const exit = page.getByTestId('pl-exit');
      await expect(exit).toHaveAttribute('data-code', 'divergence');
      await expect(exit).toContainText('ne correspond plus à ce que le portefeuille a enregistré');
      await expect(exit).toContainText('rests on the venue and was not placed by the wallet');
      await expect(page.getByTestId('agent-band')).toHaveAttribute('data-tone', 'testnet');
      await shot(page, '20-exit-divergence');
      await perp(page, 'holdStop', false);
      await expect.poll(async () => (await perpState(page)).state, { timeout: 15_000 }).toBe('STOPPED');

      // the agent stopped WITHOUT being able to close: the open position is the first thing the page says
      await open(page, 'live');
      await perp(page, 'stopOpen', 'signer_no_authorization');
      await refresh(page);
      const left = page.getByTestId('pl-open-left');
      await expect(left).toContainText('1 position(s) RESTENT OUVERTES');
      await expect(left).toContainText('long');
      await expect(left.getByRole('button', { name: /Ouvrir ce compte dans le terminal Futures/ })).toBeVisible();
      await expect(page.getByTestId('pl-exit')).toHaveAttribute('data-code', 'signer_no_authorization');
      await shot(page, '20b-stopped-positions-left-open');

      // mainnet: the account is authorised (manual trading with a passkey works), autonomous trading is locked by the server
      await open(page, 'mainnet_locked');
      await expect(golive(page)).toHaveAttribute('data-next', 'locked');
      await expect(golive(page).getByTestId('mode-tag')).toHaveAttribute('data-tone', 'mainnet');
      await expect(page.getByTestId('pl-step-account')).toContainText('réseau principal — ARGENT RÉEL');
      await expect(page.getByTestId('pl-step-mandate')).toHaveAttribute('data-state', 'locked');
      const lock = page.getByTestId('server-lock');
      await expect(lock).toContainText('fermée par un réglage du serveur');
      await expect(lock).toContainText('Ce n’est pas un interrupteur de cette application');
      await expect(lock.getByTestId('server-lock-reason')).toContainText('la négociation autonome (mandat) sur le MAINNET de Hyperliquid est désactivée sur ce serveur : elle exige SPW_DERIV_LIVE_MAINNET=on ET SPW_DERIV_MANDATE_MAINNET=on');
      await expect(page.getByTestId('pl-next')).toHaveCount(0);                           // no primary action: nothing here can open it
      await expect(golive(page).getByRole('checkbox')).toHaveCount(0);
      await expect(golive(page).getByRole('switch')).toHaveCount(0);
      // the page itself is still a simulation: the agent trades nothing real
      await expect(page.getByText('SIMULATION').first()).toBeVisible();
      await expect(page.getByTestId('agent-band')).toHaveCount(0);
      await golive(page).scrollIntoViewIfNeeded();
      await shot(page, '21-mainnet-locked-server-setting');
      await noOverflow(page);
      expect(errors).toEqual([]);
    });
  });
}
