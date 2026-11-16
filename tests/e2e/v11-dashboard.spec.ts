import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { enter, passkeyFile, virtualPasskey } from './qa-helpers.ts';
import { deviceUse, expectNoOverflow, MATRIX, openWallet, SHOTS, type Device, type Lang, type Session, type Theme } from './v11-helpers.ts';

// V11 Dashboard (the consolidated panels of Home) on a real local stack: real API, real isolated signer, throwaway keystore
// and database, PAPER only (the paper engine fills against Hyperliquid's public market data; nothing is signed or sent).
//   a paper account with one open position → Home → the position is under « Simulation » and NOT under « Réel »; the risk
//   panel says the kill switch state and that the live limits are not set; the system panel says the signer answers and the
//   audit chain is intact; no page error, no horizontal overflow.
// Phone 390×844 and desktop 1280×900, French and English, light theme; phone French also in dark.
//   tests/e2e/ui-stack.sh db 8810
//   SPW_E2E_BASE=http://localhost:8810 SPW_DEV_DIR=/tmp/spw-ui-db pnpm e2e v11-dashboard.spec.ts
const BTC = 'hyperliquid:BTC';
const TEXT = {
  fr: { paper: 'Simulation', live: 'Réel', killOff: 'Arrêt d’urgence désactivé', limits: /Limites réelles non définies \(\d+\)/, signer: 'Joignable', audit: 'Chaîne d’audit intacte', noPos: 'Aucune position ouverte.' },
  en: { paper: 'Simulation', live: 'Real', killOff: 'Kill switch off', limits: /Live limits not set \(\d+\)/, signer: 'Reachable', audit: 'Audit chain intact', noPos: 'No open position.' },
} as const;

/** one open paper position on the e2e paper account (owner session; the routes the terminal itself uses) */
async function paperPosition(page: Page, s: Session): Promise<void> {
  // (the list is `{ accounts: [...] }`; found by label so that every cell of the matrix reuses the same account)
  const list = (await (await page.request.get('/api/v1/derivatives/accounts')).json()) as { accounts: { id: string; label: string; kind: string }[] };
  let acct = list.accounts.find((a) => a.kind === 'paper' && a.label === 'Tableau de bord e2e')?.id;
  if (!acct) { const c = await page.request.post('/api/v1/derivatives/accounts', { headers: s.headers(), data: { venue: 'hyperliquid', label: 'Tableau de bord e2e', collateral: '10000' } }); expect(c.status(), await c.text()).toBe(200); acct = (await c.json()).id as string; }
  const detail = await (await page.request.get(`/api/v1/derivatives/accounts/${acct}`)).json() as { positions: { instrument: string }[] };
  if (detail.positions.some((p) => p.instrument === BTC)) return;
  const r = await page.request.post(`/api/v1/derivatives/accounts/${acct}/orders`, { headers: s.headers(), data: { instrument: BTC, side: 'buy', type: 'market', size: '0.01', slippageBps: 100 } });
  expect(r.status(), await r.text()).toBe(200);
}

const cells: { device: Device; lang: Lang; theme: Theme }[] = [...MATRIX.map((m) => ({ ...m, theme: 'light' as Theme })), { device: 'phone', lang: 'fr', theme: 'dark' }];
for (const { device, lang, theme } of cells) {
  test.describe(`dashboard · ${device} · ${lang} · ${theme}`, () => {
    test.use(deviceUse(device, lang));
    test('paper position under its own mode, risk and system states, no overflow', async ({ page, context, baseURL }) => {
      const s = await openWallet(page, context, baseURL, { lang, theme });
      await paperPosition(page, s);
      await page.goto('/');
      const dash = page.getByTestId('dashboard');
      await expect(dash).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
      const x = TEXT[lang];

      // accounts: the paper account is listed under the paper book
      const paperAccounts = page.getByTestId('db-accounts').locator('[data-book="paper"]');
      await expect(paperAccounts.getByTestId('db-mode-paper')).toHaveText(x.paper);
      expect(await paperAccounts.getByTestId('db-account').count()).toBeGreaterThanOrEqual(1);   // other specs of the same stack have their own paper accounts
      await expect(page.getByTestId('db-accounts').locator('[data-book="live"]').getByTestId('db-account')).toHaveCount(0);

      // positions: under « Simulation », not under « Réel »
      const positions = page.getByTestId('db-positions');
      expect(await positions.locator('[data-book="paper"]').getByTestId('db-position').count()).toBeGreaterThanOrEqual(1);
      await expect(positions.locator(`[data-book="paper"] [data-testid="db-position"][data-instrument="${BTC}"]`).first()).toBeVisible();
      const live = positions.locator('[data-book="live"]');
      await expect(live.getByTestId('db-mode-live')).toHaveText(x.live);
      await expect(live.getByTestId('db-position')).toHaveCount(0);
      await expect(live).toContainText(x.noPos);

      // P&L per mode: three figures in the paper block, none in the live one
      await expect(page.getByTestId('db-pnl').locator('[data-book="paper"]').getByTestId('db-pnl-unrealized')).toBeVisible();
      await expect(page.getByTestId('db-pnl').locator('[data-book="live"]').getByTestId('db-pnl-unrealized')).toHaveCount(0);

      // risk: kill switch state in words, live limits never set on this wallet, nearest liquidation of the paper book
      await expect(page.getByTestId('db-kill')).toHaveText(x.killOff);
      await expect(page.getByTestId('db-limits')).toHaveText(x.limits);
      await expect(page.getByTestId('db-risk').locator('[data-book="paper"]').getByTestId('db-nearest-liq')).toBeVisible();

      // system: the signer of the stack answers, the audit chain is intact; the stream state is said in words
      await expect(page.getByTestId('db-signer')).toContainText(x.signer);
      await expect(page.getByTestId('db-audit')).toContainText(x.audit);
      await expect(page.getByTestId('db-system').getByTestId('qt-conn')).toBeVisible();
      await expect(page.getByTestId('db-freshness')).toBeVisible();
      await expect(page.getByTestId('db-unavailable')).toHaveCount(0);

      expect(await page.evaluate(() => document.documentElement.dataset.theme ?? 'light')).toBe(theme);
      await expectNoOverflow(page, `dashboard ${device} ${lang} ${theme}`);
      await dash.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/v11-dashboard-${device}-${lang}-${theme}.png`, fullPage: true });
      expect(s.errors()).toEqual([]);
    });
  });
}

test.describe('dashboard · narrow phone 320', () => {
  test.use({ ...deviceUse('phone', 'fr'), viewport: { width: 320, height: 700 } });
  test('no horizontal overflow at 320 px', async ({ page, context, baseURL }) => {
    // this test signs with the passkey inside the page (the release below): it holds the authenticator itself, so that the
    // credential's signature counter is saved afterwards — the next test of the run unlocks with the same throwaway passkey
    await context.addInitScript(() => { localStorage.setItem('spw-locale', 'fr'); localStorage.setItem('spw-theme', 'light'); });
    const pk = await virtualPasskey(context, page, passkeyFile(`v11-${new URL(baseURL!).port}`));
    await enter(page, pk, readFileSync(`${process.env.SPW_DEV_DIR ?? '/tmp/spw-dev'}/setup-token`, 'utf8').trim());
    const s = { headers: () => ({ origin: baseURL!, 'x-spw-csrf': '1' }) };
    await paperPosition(page, s);
    await page.goto('/');
    await expect(page.getByTestId('dashboard')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await expectNoOverflow(page, 'dashboard 320');
  });
});

test.describe('dashboard · kill switch', () => {
  test.use(deviceUse('phone', 'fr'));
  test('an engaged kill switch is said on the dashboard', async ({ page, context, baseURL }) => {
    // this test signs with the passkey inside the page (the release below): it holds the authenticator itself, so that the
    // credential's signature counter is saved afterwards — the next test of the run unlocks with the same throwaway passkey
    await context.addInitScript(() => { localStorage.setItem('spw-locale', 'fr'); localStorage.setItem('spw-theme', 'light'); });
    const pk = await virtualPasskey(context, page, passkeyFile(`v11-${new URL(baseURL!).port}`));
    await enter(page, pk, readFileSync(`${process.env.SPW_DEV_DIR ?? '/tmp/spw-dev'}/setup-token`, 'utf8').trim());
    const s = { headers: () => ({ origin: baseURL!, 'x-spw-csrf': '1' }) };
    const on = await page.request.post('/api/v1/risk/kill-switch', { headers: s.headers(), data: { reason: 'e2e dashboard' } });
    expect(on.status(), await on.text()).toBe(200);
    try {
      await page.goto('/');
      await expect(page.getByTestId('db-kill')).toHaveText('Arrêt d’urgence activé', { timeout: 30_000 });
      await expect(page.getByTestId('db-risk-state')).toHaveAttribute('data-level', 'halted');
    } finally {
      // release with the passkey (virtual authenticator) through the Risk screen's own routes, so the next specs start clean
      const released = await page.evaluate(async () => {
        const h = { 'content-type': 'application/json', 'x-spw-csrf': '1' };
        const p = await (await fetch('/api/v1/risk/kill-switch/release/prepare', { method: 'POST', headers: h, body: '{}' })).json();
        if (!p.needed) return (await fetch('/api/v1/risk/kill-switch/release', { method: 'POST', headers: h, body: '{}' })).status;
        const o = p.options, dec = (b: string) => Uint8Array.from(atob(b.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)), enc = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const c = await navigator.credentials.get({ publicKey: { ...o, challenge: dec(o.challenge), allowCredentials: (o.allowCredentials ?? []).map((x: { id: string; type: string }) => ({ ...x, id: dec(x.id) })) } }) as PublicKeyCredential;
        const r = c.response as AuthenticatorAssertionResponse;
        const assertion = { id: c.id, rawId: enc(c.rawId), type: c.type, clientExtensionResults: {}, response: { clientDataJSON: enc(r.clientDataJSON), authenticatorData: enc(r.authenticatorData), signature: enc(r.signature), userHandle: r.userHandle ? enc(r.userHandle) : undefined } };
        return (await fetch('/api/v1/risk/kill-switch/release', { method: 'POST', headers: h, body: JSON.stringify({ assertion }) })).status;
      });
      await pk.save();
      expect(released).toBe(200);
    }
  });
});
