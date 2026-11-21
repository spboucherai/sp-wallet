/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : tests/e2e/mm.spec.ts
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

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// V11 — market making in a real browser on a real stack (scripts/dev-stack.sh: real API with its agent workers in-process, real
// isolated signer, throwaway keystore and database). Nothing is signed for a venue and no order is sent anywhere:
//   (a) PAPER end to end — a market-making agent from the template, started in paper: the session view appears (SIMULATED),
//       with its quotes, or with the hold the engine really reports when the stack has no usable book (the spec asserts what
//       the API says, whichever it is, and writes it to the test's annotations); pull; stop; the session is in the past list.
//       Paper reads Hyperliquid's PUBLIC market data, like every paper agent of this wallet.
//   (b) LIVE with every server lock off (the stack's default) — the checklist is walked as far as the server allows
//       (paper session, evidence with its negative figures, jurisdiction, testnet attestation), then the refusals: the mandate
//       form names the closed lock, the server refuses the creation with a code that is shown verbatim, "start live" stays
//       shut and the server itself answers `mandate_required`; no approval sheet — hence no passkey prompt — is reachable.
//       ONE thing is stubbed, and only for one step: the LIST of live venue accounts (this stack has none, and making one
//       needs a venue), so that the form can be sent at all; the refusal that comes back is the real server's.
//   createdb spw_dev_mm; SPW_MM_MIN_PAPER_MINUTES=1 SPW_DEV_PORT=8811 SPW_DEV_DB=spw_dev_mm SPW_DEV_DIR=/tmp/spw-dev-mm scripts/dev-stack.sh
//   SPW_E2E_BASE=http://localhost:8811 SPW_DEV_DIR=/tmp/spw-dev-mm pnpm e2e mm.spec.ts
// Without SPW_MM_MIN_PAPER_MINUTES=1 the paper step needs 30 minutes: the spec then asserts that everything after it is gated.
const SHOTS = 'test-results/shots';
const LOCK_CODES = ['mainnet_disabled', 'mandate_mainnet_disabled', 'mm_mainnet_disabled', 'mm_testnet_disabled', 'execution_disabled'];
test.use({ locale: 'fr-CA' });
test.setTimeout(8 * 60_000);

const json = async (page: Page, path: string) => (await page.request.get(`/api/v1${path}`)).json();

test('Market making: paper session end to end (SIMULATED), then the live checklist up to the server\'s refusals — no passkey prompt past a refusal', async ({ page, context, baseURL }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const note = (type: string, description: string) => { test.info().annotations.push({ type, description }); console.log(`[mm.spec] ${type}: ${description}`); };
  const headers = { origin: baseURL!, 'x-spw-csrf': '1' };

  await page.goto('/');
  await expect(page.getByText('Configuration initiale')).toBeVisible();
  await page.getByRole('textbox').fill(readFileSync(`${process.env.SPW_DEV_DIR ?? '/tmp/spw-dev'}/setup-token`, 'utf8').trim());
  await page.getByRole('button', { name: /Créer ma clé/ }).click();
  await expect(page.getByText('Valeur totale estimée')).toBeVisible({ timeout: 30_000 });
  // the signature counter of the owner's passkey after setup: it must not move during the live part (no prompt is reachable)
  const signCount = async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials.reduce((n, c) => n + c.signCount, 0);

  // ---------------------------------------------------------------------------------------------------------------- (a) PAPER
  await page.goto('/agents');
  await page.getByTestId('ag2-from-template').click();
  const tpl = page.getByTestId('ag2-template-sheet');
  await expect(tpl.getByTestId('ag2-tpl-market-making')).toBeVisible({ timeout: 60_000 });
  await tpl.getByTestId('ag2-tpl-market-making').click();
  await tpl.getByRole('textbox').first().fill('Tenue e2e');
  await tpl.getByRole('button', { name: 'Créer l’agent' }).click();
  await expect(page).toHaveURL(/\/agents\/[0-9a-f-]{36}/, { timeout: 60_000 });
  const id = /\/agents\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  await expect(page.getByTestId('ag2-panel')).toBeVisible({ timeout: 30_000 });

  const mm = page.getByTestId('mm-section');
  await expect(mm).toBeVisible({ timeout: 30_000 });
  await expect(mm).toHaveAttribute('data-mode', 'paper');
  await expect(mm.getByTestId('mm-simulated').first()).toHaveText('SIMULÉ');
  await expect(mm.getByTestId('mm-paper-note')).toContainText(/^SIMULÉ/);
  await expect(mm.getByTestId('mm-session')).toHaveCount(0);                                         // nothing runs yet
  await expect(mm.getByTestId('mm-pull')).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}/mm-01-created.png`, fullPage: true });

  await page.getByRole('button', { name: /Démarrer en simulation/ }).click();
  await expect(page.getByTestId('ag2-life')).toContainText(/Acti/i, { timeout: 30_000 });
  const session = mm.getByTestId('mm-session');
  await expect(session).toBeVisible({ timeout: 60_000 });                                              // the 2 s poll brings it in
  await expect(session).toHaveAttribute('data-mode', 'paper');
  await expect(session).toHaveAttribute('data-simulated', 'true');
  await expect(session.getByTestId('mm-session-label')).toContainText('PAPER — SIMULATED');
  await expect(session.getByTestId('mm-simulated').first()).toBeVisible();

  // quotes, or the hold: whatever the engine of THIS stack reports, the screen shows the same (given up to 60 s to settle)
  const view = async () => (await json(page, `/mm/agents/${id}?mode=paper`)) as { session: null | { state: string; status: { phase?: string; reason?: string | null; quotes?: unknown[]; activeBreakers?: string[] } }; goLive: { steps: { id: string; done: boolean; missing: string | null }[]; ready: boolean } };
  await expect.poll(async () => { const s = (await view()).session?.status; return (s?.quotes?.length ?? 0) > 0 || ['pulled', 'halted'].includes(s?.phase ?? ''); }, { timeout: 60_000, intervals: [2000] }).toBe(true);
  const now = (await view()).session!.status, quoting = (now.quotes?.length ?? 0) > 0;
  note('paper-session', quoting ? `the stack has a live book: phase ${now.phase}, ${now.quotes!.length} quote(s) resting` : `no usable book on this stack: phase ${now.phase}, reason ${now.reason ?? '—'}, breakers ${(now.activeBreakers ?? []).join(',') || '—'}`);
  if (quoting) {
    await expect(session.getByTestId('mm-quote').first()).toBeVisible({ timeout: 15_000 });
    await expect(session.getByTestId('mm-quote').first()).toContainText(/pb du milieu/);
    await expect(session.getByTestId('mm-position')).toBeVisible();
  } else {
    await expect(session.getByTestId('mm-no-quotes')).toBeVisible({ timeout: 15_000 });
    await expect(session).toHaveAttribute('data-phase', /pulled|halted/);
    if (now.reason) await expect(session.getByTestId('mm-reason')).toContainText(now.reason.slice(0, 20));
  }
  await expect(session.getByTestId('mm-budget')).toContainText(/\/ 1[\s  ]?200/);
  await expect(session.getByTestId('mm-refusals')).toBeVisible();
  await expect(mm.getByTestId('mm-fills').or(mm.getByTestId('mm-no-fills'))).toBeVisible();
  await expect(mm.getByTestId('mm-attribution')).toHaveAttribute('data-mode', 'paper');
  await expect(mm.getByTestId('mm-attribution-label')).toContainText('SIMULATED');
  await page.screenshot({ path: `${SHOTS}/mm-02-paper-session.png`, fullPage: true });

  // the paper session must last long enough for step 1 of the checklist (the stack's own setting)
  const minPaper = (await json(page, '/mm/evidence?locale=fr')).minPaperMinutes as number;
  const walk = minPaper <= 2;
  note('min-paper-minutes', `${minPaper}${walk ? '' : ' — more than this spec waits: the steps after the paper session are asserted gated'}`);
  if (walk) await expect.poll(async () => (await view()).goLive.steps.find((s) => s.id === 'paper')!.done, { timeout: (minPaper * 60 + 45) * 1000, intervals: [5000] }).toBe(true);

  // pull: taken by the engine of the running session (a paper book — nothing on a venue)
  await mm.getByTestId('mm-pull').click();
  await expect(mm.getByTestId('mm-command-result')).toBeVisible({ timeout: 15_000 });
  await expect(mm.getByTestId('mm-commands-note')).toContainText('sous tous les verrous');

  await page.getByRole('button', { name: 'Arrêter', exact: true }).first().click();
  await expect(page.getByTestId('ag2-life')).toContainText(/Arrêt/i, { timeout: 60_000 });
  await expect(mm.getByTestId('mm-session')).toHaveCount(0, { timeout: 60_000 });
  await expect(mm.getByTestId('mm-past-session').first()).toHaveAttribute('data-state', /stopped|abandoned/, { timeout: 30_000 });
  await expect(mm.getByTestId('mm-sessions').getByTestId('mm-simulated').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/mm-03-paper-stopped.png`, fullPage: true });

  // ---------------------------------------------------------------------------------------------------------------- (b) LIVE, locks off
  const signsBefore = await signCount();
  const bounds = (await json(page, '/mm/bounds')) as { locks: Record<'mainnet' | 'testnet', { lock: { code: string; message: string; setting: string } | null; consulted: string[] }> };
  expect(bounds.locks.mainnet.lock, 'this spec runs on a stack with the mainnet locks off').not.toBeNull();
  note('locks', `mainnet ${bounds.locks.mainnet.lock!.code} · testnet ${bounds.locks.testnet.lock?.code ?? 'open'}`);

  await page.getByTestId('ag2-request-live').click();                                                 // "request live" opens the checklist, not the generic mandate sheet
  await expect(mm).toHaveAttribute('data-mode', 'live');
  await expect(page.getByTestId('ag2-mandate-sheet')).toHaveCount(0);
  const flow = mm.getByTestId('mm-golive');
  await expect(flow).toBeVisible({ timeout: 30_000 });
  await expect(flow).toHaveAttribute('data-ready', 'false');
  // the live tab shows no paper figure: the only SIMULATED mark left is on the evidence of step 1, the paper session itself
  await expect(mm.locator('[data-testid="mm-simulated"]:not([data-testid="mm-step-paper"] *)')).toHaveCount(0);
  const stepEl = (s: string) => flow.getByTestId(`mm-step-${s}`);
  await expect(flow.locator('[data-testid^="mm-step-"][data-state]')).toHaveCount(6);

  // the evidence is on the page whatever the step: both results NEGATIVE, the figures to the digit
  const ev = (await json(page, '/mm/evidence?locale=fr')) as { statement: string; evidence: { simulation: { figures: { pnlUsd: string; bpsOfVolume: string } } }; jurisdiction: { text: string } };
  expect([ev.evidence.simulation.figures.pnlUsd, ev.evidence.simulation.figures.bpsOfVolume]).toEqual(['-0.125', '-1.83']);
  await expect(flow.getByTestId('mm-evidence-lab-result')).toContainText('NEGATIVE');
  await expect(flow.getByTestId('mm-evidence-sim-result')).toContainText('NEGATIVE');
  await expect(flow.getByTestId('mm-evidence-sim').locator('[data-figure="pnlUsd"]')).toHaveText('-0.125');
  await expect(flow.getByTestId('mm-evidence-sim').locator('[data-figure="bpsOfVolume"]')).toHaveText('-1.83');
  await expect(flow.getByTestId('mm-evidence-statement')).toHaveText(ev.statement);

  if (!walk) {
    await expect(stepEl('paper')).toHaveAttribute('data-state', 'current');
    for (const s of ['evidence', 'jurisdiction', 'testnet', 'mandate', 'locks']) await expect(stepEl(s)).toHaveAttribute('data-state', 'next');
    for (const t of ['mm-evidence-ack', 'mm-jurisdiction-ack', 'mm-testnet-ack', 'mm-mandate-create']) await expect(flow.getByTestId(t)).toHaveCount(0);
  } else {
    // 1 — the paper session, with its evidence
    await expect(stepEl('paper')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
    await expect(flow.getByTestId('mm-paper-evidence')).toContainText(/Session la plus longue/);
    // 2 — the acknowledgement of the evidence: the server's exact statement, ticked, then recorded
    await expect(stepEl('evidence')).toHaveAttribute('data-state', 'current');
    await expect(flow.getByTestId('mm-jurisdiction-ack')).toHaveCount(0);                              // the next step cannot be acted on yet
    await expect(flow.getByTestId('mm-evidence-ack')).toBeDisabled();
    await flow.getByTestId('mm-evidence-check').check();
    await page.screenshot({ path: `${SHOTS}/mm-04-evidence.png`, fullPage: true });
    await flow.getByTestId('mm-evidence-ack').click();
    await expect(stepEl('evidence')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
    // 3 — the jurisdiction text, verbatim
    await expect(flow.getByTestId('mm-jurisdiction-text')).toHaveText(ev.jurisdiction.text);
    await expect(flow.getByTestId('mm-testnet-ack')).toHaveCount(0);
    await flow.getByTestId('mm-jurisdiction-check').check();
    await flow.getByTestId('mm-jurisdiction-ack').click();
    await expect(stepEl('jurisdiction')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
    // 4 — the testnet step is the owner's: six verifications, then his own words (this spec ran nothing on testnet and says so)
    await expect(flow.getByTestId('mm-testnet-checks').locator('li')).toHaveCount(6);
    await expect(flow.getByTestId('mm-mandate-create')).toHaveCount(0);
    await expect(flow.getByTestId('mm-testnet-ack')).toBeDisabled();
    await flow.getByTestId('mm-testnet-note').fill('court');
    await expect(flow.getByTestId('mm-testnet-ack')).toBeDisabled();
    await flow.getByTestId('mm-testnet-note').fill('e2e : rien lancé sur le testnet ; attestation de test sur une pile jetable');
    await flow.getByTestId('mm-testnet-ack').click();
    await expect(stepEl('testnet')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
    await expect(flow.getByTestId('mm-testnet-attested')).toContainText('attestation de test');

    // 5 — the quoting mandate: this stack has no live venue account, and says so
    await expect(stepEl('mandate')).toHaveAttribute('data-state', 'current');
    await expect(flow.getByTestId('mm-mandate-none')).toBeVisible();
    await flow.getByTestId('mm-mandate-create').click();
    const form = page.getByTestId('mm-form');
    await expect(form).toBeVisible();
    await expect(form.getByTestId('mm-form-no-account')).toBeVisible({ timeout: 15_000 });
    await expect(form.getByTestId('mm-form-create')).toBeDisabled();
    for (const f of ['maxCapitalUsd', 'maxLeverage', 'levelsPerSide', 'minHalfSpreadBps', 'maxDistanceBps', 'hardInventoryUsd', 'quotesPerDay', 'deadManSeconds', 'maxSessionMinutes', 'maxSessionLossUsd', 'days'])
      await expect(form.getByTestId(`mm-max-${f}`), f).toContainText(/Borne compilée : .*\d/);
    await expect(form.getByTestId('mm-max-deadManSeconds')).toContainText('10…120');
    await expect(form.getByTestId('mm-max-days')).toContainText('1…7');
    await expect(form.getByTestId('mm-form-fixed')).toContainText('hyperliquid:BTC');
    await page.screenshot({ path: `${SHOTS}/mm-05-form-no-account.png`, fullPage: true });
    await page.keyboard.press('Escape');
    await expect(form).toHaveCount(0);

    // the server's own answer to a creation, asked directly (an account id this wallet does not have)
    const overview = (await json(page, `/agents/${id}/overview`)) as { strategy: { sha256: string } };
    const body = (accountId: string) => ({ principal: { kind: 'agent', id }, mode: 'live', accountIds: [accountId], instruments: ['hyperliquid:BTC'], marketKinds: ['perp'], orderTypes: ['limit'], maxCapitalUsd: '1000', maxOrderNotionalUsd: '50', maxPositionNotionalUsd: '300', maxLeverage: '1',
      maxDailyLossUsd: '25', floorEquityUsd: '800', days: 1, frequency: { perMinute: 5, perHour: 60, perDay: 200 }, maxSlippageBps: 50, maxFeeUsd: '25', stopConditions: [], strategySha256: overview.strategy.sha256, label: 'MM BTC', locale: 'fr',
      quoting: { terms: { levelsPerSide: 1, minHalfSpreadBps: 2, maxDistanceBps: 150, burstActions: 10, actionsPerMinute: 30, quotesPerHour: 1200, quotesPerDay: 10000, dailyTurnoverUsd: '100000', deadManSeconds: 30 },
        engine: { policy: 'spread_inventory', quoteSizeUsd: '50', softInventoryUsd: '125', hardInventoryUsd: '250', maxSessionMinutes: 60, hours: null, maxSessionLossUsd: '25', stopBeforeExpiryS: 300, breakers: {}, flattenOnStop: false } } });
    const FAKE = '00000000-0000-4000-8000-00000000e2e0';
    const direct = await page.request.post('/api/v1/mandates', { headers, data: body(FAKE) });
    const refused = (await direct.json()) as { error: string; message: string };
    expect(direct.status()).toBeGreaterThanOrEqual(400);
    note('mandate-creation', `POST /mandates → ${direct.status()} ${refused.error}: ${refused.message}`);

    // the same refusal through the form. ONLY the list of accounts is stubbed (one entry, the id above, on mainnet) so that the form can be sent
    await page.route('**/api/v1/derivatives/live/accounts', (r) => r.fulfill({ json: { accounts: [{ id: FAKE, venue: 'hyperliquid', network: 'mainnet', label: 'compte absent (e2e)', account: `0x${'0'.repeat(40)}`, authorization: { active: true, expiresAt: Date.now() + 86_400_000 } }] } }));
    await page.reload();
    await mm.getByRole('radio', { name: 'Réel' }).click();
    await flow.getByTestId('mm-mandate-create').click();
    await form.getByTestId('mm-form-account').selectOption(FAKE);
    await expect(form.getByTestId('mm-form-lock')).toHaveAttribute('data-code', bounds.locks.mainnet.lock!.code);   // the closed lock, said BEFORE anything is sent
    await expect(form.getByTestId('mm-form-lock')).toContainText(bounds.locks.mainnet.lock!.message);
    await expect(form.getByTestId('mm-form-create')).toBeEnabled();
    await form.getByTestId('mm-form-create').click();
    const refusal = form.getByTestId('mm-refusal');
    await expect(refusal).toBeVisible({ timeout: 30_000 });
    await expect(refusal).toHaveAttribute('data-code', refused.error);                                // the server's code …
    await expect(refusal.getByTestId('mm-refusal-message')).toHaveText(refused.message);              // … and its sentence, verbatim
    await expect(page.getByTestId('mm-approval')).toHaveCount(0);                                     // no approval sheet: no passkey prompt
    await page.screenshot({ path: `${SHOTS}/mm-06-creation-refused.png`, fullPage: true });
    await page.unroute('**/api/v1/derivatives/live/accounts');
    await page.keyboard.press('Escape');
    expect(((await json(page, '/mandates')).mandates as { kind: string }[]).filter((m) => m.kind === 'quoting')).toEqual([]);   // nothing was stored
  }

  // 6 — the locks: every consulted setting, the closed one with its code; start stays shut; the server says why
  for (const net of ['mainnet', 'testnet'] as const) {
    const box = flow.getByTestId(`mm-locks-${net}`), l = bounds.locks[net];
    await expect(box).toHaveAttribute('data-open', String(l.lock === null));
    await expect(box.getByTestId('mm-lock-setting')).toHaveCount(l.consulted.length);
    for (const s of l.consulted) await expect(box).toContainText(s);
    if (l.lock) { expect(LOCK_CODES).toContain(l.lock.code); await expect(box.getByTestId('mm-lock-code')).toHaveText(l.lock.code); await expect(box.getByTestId('mm-lock-message')).toHaveText(l.lock.message); }
  }
  await expect(flow.getByTestId('mm-start-live')).toBeDisabled();
  await expect(flow.getByTestId('mm-start-blocked')).toBeVisible();
  await expect(flow.getByTestId('mm-step-missing-mandate')).toContainText('quoting mandate');
  const start = await page.request.post(`/api/v1/agents/${id}/start`, { headers, data: { mode: 'live' } });
  const startRefused = (await start.json()) as { error: string; message: string };
  note('start-live', `POST /agents/:id/start {mode: live} → ${start.status()} ${startRefused.error}: ${startRefused.message}`);
  expect([start.status(), startRefused.error]).toEqual([409, 'mandate_required']);
  expect(((await json(page, `/mm/agents/${id}?mode=live`)) as { session: unknown; sessions: unknown[] })).toMatchObject({ session: null, sessions: [] });   // no live session ever existed
  await expect(mm.getByTestId('mm-session')).toHaveCount(0);

  // no passkey prompt was reachable: no review button, no approval sheet, and the passkey has not signed anything since the paper part
  for (const t of ['mm-mandate-review', 'mm-approval', 'mm-approval-approve']) await expect(page.getByTestId(t)).toHaveCount(0);
  expect(await signCount()).toBe(signsBefore);
  await page.screenshot({ path: `${SHOTS}/mm-07-live-refused.png`, fullPage: true });

  // Risk lists quoting mandates in their own block (none here); Monitor names the two capability lines
  await page.goto('/risk');
  await expect(page.getByTestId('mm-risk-block')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('mm-risk-none')).toBeVisible();
  await page.goto('/monitor');
  await expect(page.getByText('Tenue de marché réelle (Hyperliquid, mainnet)')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Tenue de marché réelle (Hyperliquid, testnet)')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/mm-08-monitor.png`, fullPage: true });
  expect(errors).toEqual([]);
});
