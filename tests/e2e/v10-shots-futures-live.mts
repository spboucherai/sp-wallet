// v10 design pass — screenshots of the area `futures-live`: live derivatives accounts (Hyperliquid testnet / mainnet), their
// authorization, order approval, collateral sheets, and GMX. Everything runs against the in-browser dev mock (`?mock=1`):
// no backend, no venue, no signer, a simulated passkey (apps/web/src/derivatives/mock*.ts).
//
//   npx tsx tests/e2e/v10-shots-futures-live.mts before|after [only-name,…] [phone-light,desktop-dark…]
//
// V10_DUMP=<dir> also writes, for the phone-light config, the text of every approval / authorization sheet (one text node
// per line, in reading order) to <dir>/<before|after>/<name>.txt — the before/after comparison of what a sheet shows.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { runShots, startVite, type Cfg, type Scenario } from './v10-shots-lib.mts';

const PORT = Number(process.env.V10_VITE_PORT ?? 5340);
const LABEL = process.argv[2] === 'before' ? 'before' : 'after', DUMP = process.env.V10_DUMP;
const ETH = 'gmx:ETH/USD [WETH-USDC]', BTC = 'gmx:BTC/USD [BTC-USDC]';
const LIVE = '/futures?v=accounts&mock=1&mainnet=1&gmx=';            // the simulated server setting for mainnet starts ON; no GMX scenario
type Net = 'testnet' | 'mainnet';

const hook = (page: Page, group: 'live' | 'gmx' | 'collateral', name: string, ...args: unknown[]) => page.evaluate(([g, n, a]) => { const m = (window as any).__spwMock; return (g === 'collateral' ? m.live.collateral : m[g as string])[n as string](...(a as unknown[])); }, [group, name, args] as const);
const mark = (page: Page) => page.evaluate(async () => Number((await (await fetch('/api/v1/derivatives/market?instrument=hyperliquid%3ABTC')).json()).ticker.mark));
const px = async (page: Page, k: number) => String(Math.round((await mark(page)) * k));
const tab = async (page: Page, cfg: Cfg, name: 'Graphique' | 'Carnet' | 'Ordre' | 'Positions') => { if (cfg.mobile) await page.getByRole('tab', { name: new RegExp(`^${name}( \\(\\d+\\))?$`) }).click(); };
const view = (page: Page, name: 'Terminal' | 'Comptes') => page.getByRole('tablist', { name: 'Vues' }).getByRole('tab', { name }).click();
const top = async (loc: Locator, offset = 96) => { await loc.evaluate((el, o) => { const y = el.getBoundingClientRect().top + scrollY - (o as number); scrollTo(0, Math.max(0, y)); }, offset); };
const state = (loc: Locator, attr: string, v: string | RegExp, timeout = 25_000) => loc.page().waitForFunction(([sel, a, s, re]) => { const el = document.querySelector(sel as string); const x = el?.getAttribute(a as string) ?? ''; return re ? new RegExp(s as string).test(x) : x === s; },
  [`[data-testid="${(loc as any)._tid}"]`, attr, typeof v === 'string' ? v : v.source, typeof v !== 'string'] as const, { timeout });
const T = (page: Page, tid: string): Locator => { const l = page.getByTestId(tid); (l as any)._tid = tid; return l; };
/** the text a sheet shows, one text node per line, in reading order */
const dump = async (page: Page, cfg: Cfg, name: string, tid: string) => {
  if (!DUMP || cfg.id !== 'phone-light') return;
  const text = await page.getByTestId(tid).first().evaluate((el) => { const out: string[] = []; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); while (w.nextNode()) { const s = (w.currentNode.textContent ?? '').replace(/\s+/g, ' ').trim(); if (s) out.push(s); } return out.join('\n'); });
  mkdirSync(join(DUMP, LABEL), { recursive: true }); writeFileSync(join(DUMP, LABEL, `${name}.txt`), text + '\n');
};

// ── live venue accounts ───────────────────────────────────────────────────────────────────────────────────────────────────
const create = async (page: Page, net: Net, fund?: string) => {
  if (fund !== undefined) await hook(page, 'live', 'fund', net, fund);
  await page.getByTestId(`live-create-${net}`).getByRole('button').click();
  await page.getByTestId(`live-account-${net}`).waitFor();
  await page.getByTestId(`live-account-${net}`).getByTestId('collateral-panel').waitFor();
};
const authForm = async (page: Page, net: Net) => {
  await page.getByTestId(`live-account-${net}`).getByTestId('authorize').click();
  const sheet = T(page, 'authorize-sheet'); await sheet.waitFor();
  await sheet.getByRole('textbox', { name: 'Valeur maximale par ordre' }).fill('200');
  await sheet.getByRole('textbox', { name: 'Position maximale par marché' }).fill('400');
  await sheet.getByRole('textbox', { name: 'Exposition brute maximale' }).fill('600');
  return sheet;
};
const authReview = async (page: Page, net: Net) => { const sheet = await authForm(page, net); await sheet.getByRole('button', { name: /Continuer/ }).click(); await state(sheet, 'data-step', 'review'); return sheet; };
const authorize = async (page: Page, net: Net) => {
  const sheet = await authReview(page, net); await sheet.getByTestId('ack-check').check(); await sheet.getByTestId('auth-approve').click();
  await page.waitForFunction((n) => document.querySelector(`[data-testid="live-account-${n}"]`)?.getAttribute('data-mode') === 'MANUAL_LIVE', net, { timeout: 15_000 });
};
/** a live account, authorised, selected, in the terminal with the order tab open */
const terminal = async (page: Page, cfg: Cfg, net: Net) => {
  await create(page, net); await authorize(page, net); await view(page, 'Terminal');
  await page.waitForFunction((n) => document.querySelector('[data-testid="terminal"]')?.getAttribute('data-tone') === n, net, { timeout: 15_000 });
  await tab(page, cfg, 'Ordre'); await page.locator('[data-testid="order-panel"][data-account-kind="venue"]').waitFor();
};
const form = async (page: Page, o: { kind?: 'Au marché' | 'À cours limité'; price?: string; size: string; side?: 'Short' }) => {
  const p = page.getByTestId('order-panel');
  if (o.side) await p.getByRole('radio', { name: o.side }).click();
  if (o.kind) await p.getByRole('radio', { name: o.kind, exact: true }).click();
  if (o.price !== undefined) await p.getByRole('textbox', { name: /Prix limite/ }).fill(o.price);
  await p.getByRole('textbox', { name: 'Taille' }).fill(o.size);
};
const review = async (page: Page) => {
  await page.getByTestId('preview').getByText('Valeur notionnelle').waitFor();
  await page.waitForFunction(() => !(document.querySelector('[data-testid="live-review"]') as HTMLButtonElement | null)?.disabled);
  await page.getByTestId('live-review').click();
  const sheet = T(page, 'approval-sheet'); await state(sheet, 'data-phase', 'ready'); return sheet;
};
const approve = (sheet: Locator) => sheet.getByRole('button', { name: /Approuver avec la clé d’accès/ }).click();
const outcome = (page: Page, s: string) => state(T(page, 'live-outcome'), 'data-state', s);
const closeSheet = (sheet: Locator) => sheet.getByRole('button', { name: 'Fermer', exact: true }).last().click();
/** one order from the form to its outcome, the sheet closed */
const order = async (page: Page, cfg: Cfg, o: Parameters<typeof form>[1], end: string) => { await tab(page, cfg, 'Ordre'); await form(page, o); const s = await review(page); await approve(s); await outcome(page, end); await closeSheet(s); };

const live: Scenario[] = [
  { name: 'band-sim', path: '/futures?mock=1&gmx=' },
  { name: 'accounts-empty', path: LIVE, full: true, act: async (page) => { await top(page.getByTestId('live-card')); } },
  { name: 'accounts', path: LIVE, full: true, act: async (page) => { await create(page, 'testnet'); await authorize(page, 'testnet'); await create(page, 'mainnet'); await top(page.getByTestId('live-card')); } },
  { name: 'account-mainnet', path: LIVE, act: async (page) => { await create(page, 'mainnet'); await authorize(page, 'mainnet'); await top(page.getByTestId('live-account-mainnet')); } },
  { name: 'auth-form', path: LIVE, act: async (page, cfg) => { await create(page, 'testnet'); await authForm(page, 'testnet'); await dump(page, cfg, 'auth-form', 'authorize-sheet'); } },
  { name: 'auth-form-problem', path: LIVE, act: async (page) => { await create(page, 'testnet'); const s = await authForm(page, 'testnet'); await s.getByRole('textbox', { name: 'Position maximale par marché' }).fill('100'); await s.getByTestId('policy-problem').scrollIntoViewIfNeeded(); } },
  { name: 'auth-review', path: LIVE, act: async (page, cfg) => { await create(page, 'testnet'); await authReview(page, 'testnet'); await dump(page, cfg, 'auth-review', 'authorize-sheet'); } },
  { name: 'auth-review-signed', path: LIVE, act: async (page) => { await create(page, 'testnet'); const s = await authReview(page, 'testnet'); await s.getByTestId('agent-can').scrollIntoViewIfNeeded(); } },
  { name: 'auth-review-ready', path: LIVE, act: async (page) => { await create(page, 'testnet'); const s = await authReview(page, 'testnet'); await s.getByTestId('ack-check').check(); await s.getByRole('button', { name: /Revenir|Retour|limites/ }).last().scrollIntoViewIfNeeded(); } },
  { name: 'auth-real-review', path: LIVE, act: async (page, cfg) => { await create(page, 'mainnet'); await authReview(page, 'mainnet'); await dump(page, cfg, 'auth-real-review', 'authorize-sheet'); } },
  { name: 'auth-real-ready', path: LIVE, act: async (page) => { await create(page, 'mainnet'); const s = await authReview(page, 'mainnet'); await s.getByTestId('ack-check').check(); await s.getByRole('button', { name: /Revenir|Retour|limites/ }).last().scrollIntoViewIfNeeded(); } },
  { name: 'auth-refused', path: LIVE, act: async (page, cfg) => { await create(page, 'testnet', '0'); const s = await authReview(page, 'testnet'); await s.getByTestId('ack-check').check(); await s.getByTestId('auth-approve').click(); await state(s, 'data-step', 'refused'); await dump(page, cfg, 'auth-refused', 'authorize-sheet'); } },
  { name: 'revoke', path: LIVE, act: async (page, cfg) => { await create(page, 'testnet'); await authorize(page, 'testnet'); await page.getByTestId('live-account-testnet').getByTestId('revoke').click(); await page.getByTestId('revoke-sheet').waitFor(); await dump(page, cfg, 'revoke', 'revoke-sheet'); } },
  { name: 'band-testnet', path: LIVE, act: async (page, cfg) => { await terminal(page, cfg, 'testnet'); await tab(page, cfg, 'Graphique'); } },
  { name: 'band-real', path: LIVE, act: async (page, cfg) => { await terminal(page, cfg, 'mainnet'); await tab(page, cfg, 'Graphique'); } },
  { name: 'order-panel', path: LIVE, full: true, act: async (page, cfg) => { await terminal(page, cfg, 'testnet'); } },
  { name: 'order-preview', path: LIVE, full: true, act: async (page, cfg) => { await terminal(page, cfg, 'testnet'); await form(page, { price: await px(page, 0.99), size: '0,001' }); await page.getByTestId('preview').getByText('Valeur notionnelle').waitFor(); if (cfg.mobile) await top(page.getByTestId('venue-leverage'), 150); } },
  { name: 'order-real', path: LIVE, full: true, act: async (page, cfg) => { await terminal(page, cfg, 'mainnet'); await form(page, { kind: 'Au marché', size: '0,001', side: 'Short' }); await page.getByTestId('preview').getByText('Valeur notionnelle').waitFor(); if (cfg.mobile) await top(page.getByTestId('venue-leverage'), 150); } },
  { name: 'order-refused', path: LIVE, act: async (page, cfg) => { await terminal(page, cfg, 'testnet'); await form(page, { price: await px(page, 0.99), size: '0,01' }); await page.getByTestId('risk-refusal').waitFor(); if (cfg.mobile) await top(page.getByTestId('preview'), 150); } },
  { name: 'order-readonly', path: LIVE, act: async (page, cfg) => { await create(page, 'testnet'); await page.getByTestId('live-account-testnet').getByRole('button', { name: 'Utiliser' }).click().catch(() => {}); await view(page, 'Terminal'); await tab(page, cfg, 'Ordre'); } },
  { name: 'approval-testnet', path: LIVE, act: async (page, cfg) => { await terminal(page, cfg, 'testnet'); await form(page, { price: await px(page, 0.99), size: '0,001' }); await review(page); await dump(page, cfg, 'approval-testnet', 'approval-sheet'); } },
  { name: 'approval-testnet-end', path: LIVE, act: async (page, cfg) => { await terminal(page, cfg, 'testnet'); await form(page, { price: await px(page, 0.99), size: '0,001' }); const s = await review(page); await s.getByRole('button', { name: 'Annuler', exact: true }).scrollIntoViewIfNeeded(); } },
  { name: 'approval-real', path: LIVE, act: async (page, cfg) => { await terminal(page, cfg, 'mainnet'); await form(page, { kind: 'Au marché', size: '0,001' }); await review(page); await dump(page, cfg, 'approval-real', 'approval-sheet'); } },
  { name: 'approval-real-end', path: LIVE, act: async (page, cfg) => { await terminal(page, cfg, 'mainnet'); await form(page, { kind: 'Au marché', size: '0,001' }); const s = await review(page); await s.getByRole('button', { name: 'Annuler', exact: true }).scrollIntoViewIfNeeded(); } },
  { name: 'approval-void', path: LIVE, act: async (page, cfg) => { await terminal(page, cfg, 'testnet'); await hook(page, 'live', 'signerOffsetBps', 1500); await form(page, { price: await px(page, 0.99), size: '0,001' }); const s = await review(page); await approve(s); await state(s, 'data-phase', 'void'); await s.getByTestId('live-error').scrollIntoViewIfNeeded(); } },
  { name: 'approval-open', path: LIVE, act: async (page, cfg) => { await terminal(page, cfg, 'testnet'); await form(page, { price: await px(page, 0.99), size: '0,001' }); const s = await review(page); await approve(s); await outcome(page, 'open'); } },
  { name: 'approval-rejected', path: LIVE, act: async (page, cfg) => { await terminal(page, cfg, 'testnet'); await hook(page, 'live', 'venue', 'reject'); await form(page, { price: await px(page, 0.985), size: '0,001' }); const s = await review(page); await approve(s); await outcome(page, 'rejected'); } },
  { name: 'approval-unknown', path: LIVE, act: async (page, cfg) => { await terminal(page, cfg, 'testnet'); await hook(page, 'live', 'venue', 'unknown'); await form(page, { price: await px(page, 0.99), size: '0,001' }); const s = await review(page); await approve(s); await outcome(page, 'unknown'); } },
  { name: 'leverage', path: LIVE, act: async (page, cfg) => { await terminal(page, cfg, 'testnet'); await page.getByTestId('venue-leverage').getByRole('button').click(); const ls = T(page, 'leverage-sheet'); await ls.waitFor(); await ls.getByRole('slider').fill('2'); } },
  { name: 'leverage-review', path: LIVE, act: async (page, cfg) => { await terminal(page, cfg, 'testnet'); await page.getByTestId('venue-leverage').getByRole('button').click(); const ls = T(page, 'leverage-sheet'); await ls.waitFor(); await ls.getByRole('slider').fill('2'); await ls.getByRole('button', { name: 'Préparer le changement' }).click(); await state(ls, 'data-phase', 'ready'); await dump(page, cfg, 'leverage-review', 'leverage-sheet'); } },
  { name: 'cancel-all', path: LIVE, act: async (page, cfg) => { await terminal(page, cfg, 'testnet'); await page.getByTestId('live-controls').getByRole('button', { name: /Annuler tous/ }).click(); await page.getByTestId('cancel-all-sheet').waitFor(); } },
  { name: 'halted', path: LIVE, act: async (page, cfg) => { await terminal(page, cfg, 'testnet'); await page.getByTestId('live-controls').getByRole('button', { name: 'Suspendre les nouveaux ordres' }).click(); await page.getByTestId('halt-banner').first().waitFor(); await top(page.getByTestId('halt-banner').first(), 160); } },
  { name: 'divergence', path: LIVE, act: async (page, cfg) => { await terminal(page, cfg, 'mainnet'); await hook(page, 'live', 'diverge', 'mainnet', 'position'); await page.locator('[data-testid="halt-banner"][data-kind="divergence"]').first().waitFor({ timeout: 20_000 }); await top(page.getByTestId('halt-banner').first(), 160); } },
  // the blotter with orders in several states: one resting, one filled (a position), one cancelled, one refused by the venue
  ...(['positions', 'orders', 'history', 'fills', 'pnl', 'risk'] as const).map((which): Scenario => ({ name: `blotter-${which}`, path: LIVE, act: async (page, cfg) => {
    await terminal(page, cfg, 'testnet');
    await order(page, cfg, { price: await px(page, 0.99), size: '0,001' }, 'open');
    await tab(page, cfg, 'Positions'); const b = page.getByTestId('blotter');
    await b.getByRole('tab', { name: /^Ordres ouverts/ }).click(); await b.getByRole('button', { name: 'Annuler l’ordre sur BTC' }).click(); await b.getByText('Aucun ordre ouvert.').waitFor();
    await order(page, cfg, { kind: 'Au marché', size: '0,002' }, 'filled');
    await hook(page, 'live', 'venue', 'reject'); await order(page, cfg, { kind: 'À cours limité', price: await px(page, 0.985), size: '0,001' }, 'rejected');
    await order(page, cfg, { price: await px(page, 0.99), size: '0,001', side: 'Short' }, 'open').catch(async () => { await page.getByTestId('approval-sheet').getByRole('button', { name: /Fermer|Annuler/ }).last().click().catch(() => {}); });
    await tab(page, cfg, 'Positions');
    const name = { positions: /^Positions/, orders: /^Ordres ouverts/, history: /^Historique/, fills: /^Exécutions/, pnl: /^(Résultat|P&L|PnL|Rés)/, risk: /^Risque/ }[which];
    await b.getByRole('tab', { name }).click(); await top(b, 150);
  } })),
  { name: 'close-position', path: LIVE, act: async (page, cfg) => { await terminal(page, cfg, 'testnet'); await order(page, cfg, { kind: 'Au marché', size: '0,002' }, 'filled'); await tab(page, cfg, 'Positions'); await page.getByTestId('blotter').getByRole('button', { name: 'Fermer 100 % de la position BTC' }).click(); await state(T(page, 'approval-sheet'), 'data-phase', 'ready'); await dump(page, cfg, 'close-position', 'approval-sheet'); } },
];

// ── collateral: deposit / withdraw ───────────────────────────────────────────────────────────────────────────────────────
const depositReview = async (page: Page, amount = '10') => {
  await page.getByTestId('live-account-mainnet').getByTestId('collateral-deposit').click();
  const s = T(page, 'deposit-sheet'); await s.waitFor(); await s.getByTestId('deposit-amount').fill(amount); await s.getByTestId('deposit-review').click(); await state(s, 'data-step', 'review'); return s;
};
const withdrawReview = async (page: Page, amount = '4') => {
  await page.getByTestId('live-account-mainnet').getByTestId('collateral-withdraw').click();
  const s = T(page, 'withdraw-sheet'); await s.waitFor(); await s.getByTestId('withdraw-amount').fill(amount); await s.getByTestId('withdraw-review').click(); await state(s, 'data-step', 'review'); return s;
};
const opState = (page: Page, v: string | RegExp) => state(T(page, 'collateral-op'), 'data-state', v);
const collateral: Scenario[] = [
  { name: 'collateral-panel', path: LIVE, act: async (page) => { await create(page, 'mainnet', '0'); await top(page.getByTestId('live-account-mainnet').getByTestId('collateral-panel'), 220); } },
  { name: 'collateral-elsewhere', path: LIVE, act: async (page) => { await hook(page, 'collateral', 'wallet', '2', [{ network: 'base', name: 'Base', usdc: '31.5' }]); await create(page, 'mainnet', '0'); await top(page.getByTestId('live-account-mainnet').getByTestId('collateral-panel'), 220); } },
  { name: 'deposit-form', path: LIVE, act: async (page, cfg) => { await create(page, 'mainnet', '0'); await page.getByTestId('live-account-mainnet').getByTestId('collateral-deposit').click(); const s = page.getByTestId('deposit-sheet'); await s.waitFor(); await s.getByTestId('deposit-amount').fill('10'); await dump(page, cfg, 'deposit-form', 'deposit-sheet'); } },
  { name: 'deposit-form-problem', path: LIVE, act: async (page) => { await create(page, 'mainnet', '0'); await page.getByTestId('live-account-mainnet').getByTestId('collateral-deposit').click(); const s = page.getByTestId('deposit-sheet'); await s.waitFor(); await s.getByTestId('deposit-amount').fill('5'); await s.getByTestId('deposit-problem').scrollIntoViewIfNeeded(); } },
  { name: 'deposit-review', path: LIVE, act: async (page, cfg) => { await create(page, 'mainnet', '0'); await depositReview(page); await dump(page, cfg, 'deposit-review', 'deposit-sheet'); } },
  { name: 'deposit-review-end', path: LIVE, act: async (page) => { await create(page, 'mainnet', '0'); const s = await depositReview(page); await s.getByTestId('deposit-approve').scrollIntoViewIfNeeded(); await s.getByRole('button').last().scrollIntoViewIfNeeded(); } },
  { name: 'deposit-progress', path: LIVE, act: async (page) => { await create(page, 'mainnet', '0'); await hook(page, 'collateral', 'creditAfter', null); const s = await depositReview(page); await s.getByTestId('deposit-approve').click(); await opState(page, 'awaiting_credit'); } },
  { name: 'deposit-done', path: LIVE, act: async (page) => { await create(page, 'mainnet', '0'); const s = await depositReview(page); await s.getByTestId('deposit-approve').click(); await opState(page, 'credited'); } },
  { name: 'deposit-failed', path: LIVE, act: async (page) => { await create(page, 'mainnet', '0'); await hook(page, 'live', 'passkey', 'bad'); const s = await depositReview(page); await s.getByTestId('deposit-approve').click(); await opState(page, 'failed'); } },
  { name: 'deposit-overdue', path: LIVE, act: async (page) => { await create(page, 'mainnet', '0'); await hook(page, 'collateral', 'creditAfter', null); await hook(page, 'collateral', 'age', 11 * 60_000); const s = await depositReview(page, '12'); await s.getByTestId('deposit-approve').click(); await opState(page, 'awaiting_credit'); await page.getByTestId('collateral-overdue').first().waitFor(); } },
  { name: 'collateral-ops', path: LIVE, act: async (page) => { await create(page, 'mainnet', '0'); const s = await depositReview(page); await s.getByTestId('deposit-approve').click(); await opState(page, 'credited'); await s.getByRole('button', { name: 'Fermer' }).last().click(); await page.getByTestId('collateral-ops').waitFor(); await top(page.getByTestId('live-account-mainnet').getByTestId('collateral-panel'), 120); } },
  { name: 'withdraw-form', path: LIVE, act: async (page, cfg) => { await create(page, 'mainnet', '25'); await page.getByTestId('live-account-mainnet').getByTestId('collateral-withdraw').click(); const s = page.getByTestId('withdraw-sheet'); await s.waitFor(); await s.getByTestId('withdraw-amount').fill('4'); await dump(page, cfg, 'withdraw-form', 'withdraw-sheet'); } },
  { name: 'withdraw-review', path: LIVE, act: async (page, cfg) => { await create(page, 'mainnet', '25'); await withdrawReview(page); await dump(page, cfg, 'withdraw-review', 'withdraw-sheet'); } },
  { name: 'withdraw-progress', path: LIVE, act: async (page) => { await create(page, 'mainnet', '25'); await hook(page, 'collateral', 'payoutAfter', null); const s = await withdrawReview(page); await s.getByTestId('withdraw-approve').click(); await opState(page, 'submitted'); } },
  { name: 'withdraw-done', path: LIVE, act: async (page) => { await create(page, 'mainnet', '25'); const s = await withdrawReview(page); await s.getByTestId('withdraw-approve').click(); await opState(page, 'completed'); } },
];

// ── GMX ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const gmxAccounts = (s: string) => `/futures?v=accounts&mock=1&gmx=${s}`, gmxTerminal = (i: string, s: string) => `/futures/${encodeURIComponent(i)}?mock=1&gmx=${s}`;
const card = async (page: Page) => { await page.getByTestId('gmx-card').waitFor(); await top(page.getByTestId('gmx-card')); };
const gmxAuth = async (page: Page) => { await page.getByTestId('gmx-card').getByTestId('gmx-authorize-open').click(); const s = T(page, 'gmx-authorize'); await s.waitFor(); await s.getByTestId('gmx-auth-leverage').fill('4'); await s.getByTestId('gmx-auth-order').fill('200'); return s; };
const gmxReview = async (page: Page, cfg: Cfg) => {
  await tab(page, cfg, 'Ordre'); const op = page.getByTestId('gmx-order-panel'); await op.waitFor(); await op.getByTestId('gmx-collateral').fill('25');
  await page.locator('[data-testid="gmx-preview"][data-ready="1"]').waitFor(); await page.locator('[data-testid="gmx-verdict"][data-ok="1"]').waitFor();
  await op.getByTestId('gmx-review').click(); const s = T(page, 'gmx-confirm'); await state(s, 'data-phase', 'ready'); return s;
};
const gmxOp = (page: Page, v: string) => page.locator(`[data-testid="gmx-confirm"] [data-testid="gmx-op"][data-state="${v}"]`).waitFor({ timeout: 30_000 });
const gmxOrder = async (page: Page, cfg: Cfg, end: string) => { const s = await gmxReview(page, cfg); await s.getByTestId('gmx-approve').click(); await gmxOp(page, end); await s.getByTestId('gmx-confirm-close').click(); };
const gmx: Scenario[] = [
  ...(['off', 'mainnet-off', 'on', 'contracts', 'halted', 'unreadable', 'expired'] as const).map((s): Scenario => ({ name: `gmx-card-${s}`, path: gmxAccounts(s), full: s === 'off' || s === 'on', act: card })),
  { name: 'gmx-card-ready', path: gmxAccounts('ready'), full: true, act: card },
  { name: 'gmx-card-position', path: gmxAccounts('position'), full: true, act: async (page) => { await card(page); await top(page.getByTestId('gmx-activity'), 140); } },
  { name: 'gmx-card-revoke', path: gmxAccounts('ready'), act: async (page) => { await card(page); await page.getByTestId('gmx-revoke').click(); await top(page.getByTestId('gmx-revoke-confirm'), 420); } },
  { name: 'gmx-auth-form', path: gmxAccounts('on'), act: async (page, cfg) => { await card(page); await gmxAuth(page); await dump(page, cfg, 'gmx-auth-form', 'gmx-authorize'); } },
  { name: 'gmx-auth-review', path: gmxAccounts('on'), act: async (page, cfg) => { await card(page); const s = await gmxAuth(page); await s.getByTestId('gmx-auth-prepare').click(); await state(s, 'data-step', 'review'); await dump(page, cfg, 'gmx-auth-review', 'gmx-authorize'); } },
  { name: 'gmx-auth-review-ready', path: gmxAccounts('on'), act: async (page) => { await card(page); const s = await gmxAuth(page); await s.getByTestId('gmx-auth-prepare').click(); await state(s, 'data-step', 'review'); await s.getByTestId('gmx-ack-check').check(); await s.getByRole('button').last().scrollIntoViewIfNeeded(); } },
  { name: 'gmx-auth-done', path: gmxAccounts('on'), act: async (page) => { await card(page); const s = await gmxAuth(page); await s.getByTestId('gmx-auth-prepare').click(); await state(s, 'data-step', 'review'); await s.getByTestId('gmx-ack-check').check(); await s.getByTestId('gmx-auth-approve').click(); await s.getByTestId('gmx-auth-done').waitFor(); } },
  { name: 'gmx-locked', path: gmxTerminal(ETH, 'off'), act: async (page, cfg) => { await tab(page, cfg, 'Ordre'); await page.getByTestId('gmx-locked').waitFor(); await top(page.getByTestId('gmx-locked'), 150); } },
  { name: 'gmx-order-empty', path: gmxTerminal(ETH, 'ready'), act: async (page, cfg) => { await tab(page, cfg, 'Ordre'); await page.getByTestId('gmx-order-panel').waitFor(); } },
  { name: 'gmx-order', path: gmxTerminal(ETH, 'ready'), full: true, act: async (page, cfg) => { await tab(page, cfg, 'Ordre'); const op = page.getByTestId('gmx-order-panel'); await op.waitFor(); await op.getByTestId('gmx-collateral').fill('25'); await page.locator('[data-testid="gmx-preview"][data-ready="1"]').waitFor(); if (cfg.mobile) await top(page.getByTestId('gmx-derived'), 150); } },
  { name: 'gmx-order-problem', path: gmxTerminal(ETH, 'ready'), act: async (page, cfg) => { await tab(page, cfg, 'Ordre'); const op = page.getByTestId('gmx-order-panel'); await op.waitFor(); await op.getByTestId('gmx-collateral').fill('900'); await op.getByTestId('gmx-problem').waitFor(); if (cfg.mobile) await top(page.getByTestId('gmx-derived'), 150); } },
  { name: 'gmx-confirm', path: gmxTerminal(ETH, 'ready'), act: async (page, cfg) => { await gmxReview(page, cfg); await dump(page, cfg, 'gmx-confirm', 'gmx-confirm'); } },
  { name: 'gmx-confirm-fixed', path: gmxTerminal(ETH, 'ready'), act: async (page, cfg) => { const s = await gmxReview(page, cfg); await s.getByTestId('gmx-fixed').scrollIntoViewIfNeeded(); } },
  { name: 'gmx-confirm-end', path: gmxTerminal(ETH, 'ready'), act: async (page, cfg) => { const s = await gmxReview(page, cfg); await s.getByTestId('gmx-withdraw').scrollIntoViewIfNeeded(); await s.getByRole('button').last().scrollIntoViewIfNeeded(); } },
  { name: 'gmx-pending', path: gmxTerminal(ETH, 'pending'), act: async (page, cfg) => { const s = await gmxReview(page, cfg); await s.getByTestId('gmx-approve').click(); await gmxOp(page, 'created'); } },
  { name: 'gmx-executed', path: gmxTerminal(ETH, 'ready'), act: async (page, cfg) => { await hook(page, 'gmx', 'delays', { keeperMs: 1500 }); const s = await gmxReview(page, cfg); await s.getByTestId('gmx-approve').click(); await gmxOp(page, 'executed'); } },
  { name: 'gmx-cancelled', path: gmxTerminal(ETH, 'keeper-cancel'), act: async (page, cfg) => { await hook(page, 'gmx', 'delays', { keeperMs: 1500 }); const s = await gmxReview(page, cfg); await s.getByTestId('gmx-approve').click(); await gmxOp(page, 'cancelled'); } },
  { name: 'gmx-failed', path: gmxTerminal(ETH, 'ready'), act: async (page, cfg) => { await hook(page, 'gmx', 'signerRefuses'); const s = await gmxReview(page, cfg); await s.getByTestId('gmx-approve').click(); await gmxOp(page, 'failed'); } },
  { name: 'gmx-close-confirm', path: gmxTerminal(BTC, 'position'), act: async (page, cfg) => { await tab(page, cfg, 'Positions'); await page.getByTestId('gmx-position').getByTestId('gmx-position-close').click(); await state(T(page, 'gmx-confirm'), 'data-phase', 'ready'); await dump(page, cfg, 'gmx-close-confirm', 'gmx-confirm'); } },
  { name: 'gmx-positions', path: gmxTerminal(BTC, 'position'), act: async (page, cfg) => { await tab(page, cfg, 'Positions'); await page.getByTestId('gmx-position').waitFor(); await top(page.getByTestId('gmx-activity'), 150); } },
  // an executed order, one the keeper cancelled, one still waiting for the keeper: the three honest states side by side
  { name: 'gmx-activity', path: gmxTerminal(ETH, 'ready'), full: true, act: async (page, cfg) => {
    await hook(page, 'gmx', 'delays', { keeperMs: 1200, cancelMs: 600_000 });
    await gmxOrder(page, cfg, 'executed');
    await hook(page, 'gmx', 'keeper', 'cancel'); await gmxOrder(page, cfg, 'cancelled');
    await hook(page, 'gmx', 'keeper', 'never'); await gmxOrder(page, cfg, 'created');
    await tab(page, cfg, 'Positions'); await page.getByTestId('gmx-operations').waitFor(); await top(page.getByTestId('gmx-operations'), 150);
  } },
  { name: 'gmx-cancel-confirm', path: gmxTerminal(ETH, 'pending'), act: async (page, cfg) => {
    await hook(page, 'gmx', 'delays', { cancelMs: 800 }); await gmxOrder(page, cfg, 'created'); await tab(page, cfg, 'Positions');
    const c = page.getByTestId('gmx-operations').getByTestId('gmx-op').first(); await page.waitForFunction(() => !(document.querySelector('[data-testid="gmx-operations"] [data-testid="gmx-op-cancel"]') as HTMLButtonElement | null)?.disabled, null, { timeout: 20_000 });
    await c.getByTestId('gmx-op-cancel').click(); await state(T(page, 'gmx-confirm'), 'data-phase', 'ready'); await dump(page, cfg, 'gmx-cancel-confirm', 'gmx-confirm');
  } },
];

const base = await startVite(PORT);
await runShots('futures-live', [{ base, scenarios: [...live, ...collateral, ...gmx] }]);
