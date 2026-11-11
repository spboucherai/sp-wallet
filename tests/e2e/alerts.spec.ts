import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// Alerts and system status against the real API (tests/e2e/alerts-server.mts: real routes, real dispatcher loop, PostgreSQL,
// the BUILT web bundle, a stub signer, a fake push service). Chromium, notification permission granted in the context.
//
// Push: headless Chromium has no push service to subscribe to, so `PushManager.subscribe` is replaced in the page by one that
// returns the subscription of the fake push service (endpoint + keys). Everything else is real: the app registers the real
// /sw.js, posts the subscription, the API encrypts (RFC 8291) and signs (VAPID) and POSTs to the fake push service, which
// decrypts; the decrypted payload is then handed to the REAL service worker through the DevTools protocol
// (ServiceWorker.deliverPushMessage) and the notification it shows is read back from the registration.
//
//   (cd apps/web && node_modules/.bin/vite build) && npx playwright test -c tests/e2e/playwright.config.ts alerts.spec.ts
// ALERTS_SHOTS=1 writes the screenshots to docs/v6/screens/.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = resolve(ROOT, 'docs/v6/screens');
const SIZES = [
  { name: 'phone', port: 8681, use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  { name: 'desktop', port: 8682, use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false } },
] as const;

// the full browser in its new headless mode: the old headless shell answers "denied" to every notification permission
test.use({ channel: 'chromium' });

for (const size of SIZES) {
  const phone = size.name === 'phone', BASE = `http://localhost:${size.port}`;
  test.describe(`alerts and system status — ${size.name}`, () => {
    test.use({ ...size.use, locale: 'fr-CA', baseURL: BASE });
    let server: ChildProcess | null = null, log = '', token = '', stoppedAgent = '';
    test.beforeAll(async () => {
      if (!existsSync(resolve(ROOT, 'dist/web/sw.js'))) throw new Error('dist/web is missing or has no sw.js: build the web bundle first (cd apps/web && node_modules/.bin/vite build)');
      server = spawn(resolve(ROOT, 'node_modules/.bin/tsx'), ['tests/e2e/alerts-server.mts', '--port', String(size.port), '--db', `spw_v6_alerts_e2e_${size.name}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      server.stdout!.on('data', (d) => { log += String(d); }); server.stderr!.on('data', (d) => { log += String(d); });
      for (let i = 0; i < 160 && !/READY/.test(log); i++) { if (server.exitCode !== null) break; await new Promise((r) => setTimeout(r, 250)); }
      const m = /READY \S+ token (\S+) agent (\S+)/.exec(log);
      if (!m) throw new Error(`the alerts backend did not start:\n${log.slice(-2000)}`);
      token = m[1]!; stoppedAgent = m[2]!;
    });
    test.afterAll(async () => { server?.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 500)); });
    const shot = async (page: Page, name: string, fullPage = true) => { if (process.env.ALERTS_SHOTS !== '1') return; mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/alerts-${size.name}-${name}.png`, fullPage }); };
    const call = (page: Page, method: string, path: string, body?: unknown) => page.evaluate(async ([m, p, b]) => {
      const r = await fetch(`/api/v1${p}`, { method: m as string, headers: m === 'GET' ? {} : { 'x-spw-csrf': '1', 'content-type': 'application/json' }, body: m === 'GET' ? undefined : JSON.stringify(b ?? {}) });
      return r.json();
    }, [method, path, body] as const);

    test('bell with unread count, alerts list, live update, deep link, push permission flow, service worker push, system status', async ({ page, context }) => {
      test.setTimeout(120_000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
      if (process.env.ALERTS_DEBUG) { page.on('response', (r) => { if (r.status() >= 400) void r.text().then((t) => console.log(r.status(), r.request().method(), r.url().replace(BASE, ''), t.slice(0, 200)), () => {}); }); page.on('console', (m) => console.log('console', m.type(), m.text())); }
      await context.addCookies([{ name: 'spw', value: token, url: BASE }]);
      await context.grantPermissions(['notifications'], { origin: BASE });
      // the only stand-in: the browser's push service (see the header)
      await page.addInitScript(() => {
        const b = (s: string) => { const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/')), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };
        let current: unknown = null;
        PushManager.prototype.getSubscription = async function () { return current as PushSubscription | null; };
        PushManager.prototype.subscribe = async function (o?: PushSubscriptionOptionsInit) {
          const s = await (await fetch('/api/v1/__e2e/subscription')).json() as { endpoint: string; p256dh: string; auth: string };
          current = { endpoint: s.endpoint, options: { applicationServerKey: o?.applicationServerKey instanceof Uint8Array ? o.applicationServerKey.buffer : o?.applicationServerKey, userVisibleOnly: true },
            getKey: (n: string) => b(n === 'p256dh' ? s.p256dh : s.auth), unsubscribe: async () => { current = null; return true; } };
          return current as PushSubscription;
        };
      });

      // ---- the bell, on the home screen
      await page.goto('/');
      const bell = page.getByTestId('alerts-bell').filter({ visible: true }), badge = page.getByTestId('alerts-badge').filter({ visible: true });
      await expect(bell).toBeVisible();
      const u0 = await call(page, 'GET', '/alerts/unread') as { unread: number; critical: number };
      expect(u0.unread).toBeGreaterThanOrEqual(7);
      expect(u0.critical).toBe(1);
      await expect(badge).toHaveText(String(u0.unread));
      await expect(bell).toHaveAttribute('aria-label', `Alertes (${u0.unread})`);
      // the five phone tabs are untouched
      if (phone) await expect(page.getByRole('navigation').getByRole('button')).toHaveText(['Accueil', 'Échanger', 'Envoyer', 'Activité', 'Réglages']);
      await shot(page, 'home-bell', false);

      // ---- the list
      await bell.click();
      await expect(page).toHaveURL(/\/alerts$/);
      const list = page.getByTestId('alerts-list');
      await expect(list.locator('button')).toHaveCount(u0.unread + 4);                    // already read: 3 seeded + the restart notice of this boot
      await expect(list.locator('[data-kind="agent.stopped_loss"]')).toContainText('Agent arrêté : limite de perte');
      await expect(list.locator('[data-kind="agent.stopped_loss"]')).toContainText('Critique');
      await expect(list.locator('[data-kind="mandate.expiring"]')).toContainText('Le mandat de Momentum BTC/ETH expire dans moins de 72 h.');   // produced by the real rule, not seeded
      await expect(list.locator('[data-kind="deriv.paper.filled"]')).toContainText('(papier, simulé)');
      await expect(page.getByTestId('alerts-unread')).toHaveText(`${u0.unread} non lue(s)`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await shot(page, 'list');
      await page.getByRole('radio', { name: 'Critique' }).click();
      await expect(list.locator('button')).toHaveCount(1);
      await page.getByRole('radio', { name: 'Toutes' }).click();
      await page.getByRole('radio', { name: 'Système' }).click();
      await expect(list.locator('[data-kind="conn.down"]')).toBeVisible();
      await expect(list.locator('[data-kind="agent.stopped_loss"]')).toHaveCount(0);
      await page.getByRole('radio', { name: 'Tous les domaines' }).click();

      // ---- live: an alert raised on the server appears without a reload (SSE)
      await call(page, 'POST', '/__e2e/raise', { kind: 'deposit.received', params: { network: 'Base', symbol: 'USDC', amount: '25' }, subject: { type: 'deposit', id: '0xlive', network: 'base' } });
      await expect(badge).toHaveText(String(u0.unread + 1), { timeout: 10_000 });
      await expect(list.locator('button').first()).toContainText('25 USDC reçus sur Base.');

      // ---- deep link: the alert opens the agent it is about, and is read
      await list.locator('[data-kind="agent.stopped_loss"]').click();
      await expect(page).toHaveURL(new RegExp(`/agents/${stoppedAgent}$`));
      await expect(badge).toHaveText(String(u0.unread));
      await page.goBack();
      await expect(list.locator('[data-kind="agent.stopped_loss"]')).toHaveAttribute('data-unread', 'false');
      await page.getByRole('button', { name: 'Tout marquer comme lu' }).click();
      await expect(page.getByTestId('alerts-badge')).toHaveCount(0);
      await expect(page.getByTestId('alerts-unread')).toHaveText('0 non lue(s)');

      // ---- settings: permission flow
      await page.getByRole('tab', { name: 'Réglages' }).click();
      await expect(page).toHaveURL(/\/alerts\?v=settings$/);
      const state = page.getByTestId('push-state');
      await expect(state).toHaveAttribute('data-state', 'off');
      await expect(page.getByTestId('push-preview')).toContainText('Sur Base.');             // details off by default: no amount in a notification
      await expect(page.getByTestId('webhook-sample')).not.toContainText('25');
      await shot(page, 'settings');
      await page.getByRole('button', { name: 'Activer les notifications' }).click();
      await expect(state).toHaveAttribute('data-state', 'on', { timeout: 15_000 });
      await expect(page.getByTestId('push-devices')).toContainText('cet appareil');
      expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/'))?.active?.scriptURL)).toBe(`${BASE}/sw.js`);
      expect(await page.evaluate(() => Notification.permission)).toBe('granted');

      // ---- "send a test notification": the API encrypts and signs, the fake push service decrypts
      await page.getByTestId('push-devices').getByRole('button', { name: 'Tester' }).click();
      await expect(page.getByText('Notification de test envoyée (1).')).toBeVisible();
      type Seen = { path: string; urgency: string; vapid: boolean; payload: { kind: string; l: string; d: boolean; p: Record<string, unknown> } };
      let pushes = await call(page, 'GET', '/__e2e/pushes') as Seen[];
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toMatchObject({ path: '/push/e2e-device', urgency: 'normal', vapid: true, payload: { v: 1, kind: 'system.test', l: 'fr', d: false } });

      // ---- a real alert: pushed without its amount, then shown by the REAL service worker in the device's language
      await call(page, 'POST', '/__e2e/raise', { kind: 'deposit.received', params: { network: 'Base', symbol: 'ETH', amount: '1.5' }, subject: { type: 'deposit', id: '0xpush', network: 'base' } });
      await expect.poll(async () => (await call(page, 'GET', '/__e2e/pushes') as Seen[]).length).toBe(2);
      pushes = await call(page, 'GET', '/__e2e/pushes') as Seen[];
      expect(pushes[1]!.payload).toMatchObject({ kind: 'deposit.received', d: false, p: { network: 'Base' } });
      expect(JSON.stringify(pushes[1]!.payload)).not.toMatch(/1\.5|ETH/);
      const cdp = await context.newCDPSession(page);
      const registrationId = await new Promise<string>((done) => {
        cdp.on('ServiceWorker.workerRegistrationUpdated', (e: { registrations: { registrationId: string; scopeURL: string }[] }) => { const r = e.registrations.find((x) => x.scopeURL.startsWith(BASE)); if (r) done(r.registrationId); });
        void cdp.send('ServiceWorker.enable');
      });
      for (const p of pushes) await cdp.send('ServiceWorker.deliverPushMessage', { origin: BASE, registrationId, data: JSON.stringify(p.payload) });
      const shown = () => page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration('/'))!.getNotifications()).map((n) => ({ title: n.title, body: n.body, lang: n.lang, url: (n.data as { url: string }).url })));
      await expect.poll(shown).toEqual(expect.arrayContaining([
        { title: 'Notification de test', body: 'Les notifications fonctionnent sur cet appareil.', lang: 'fr', url: '/monitor' },
        { title: 'Dépôt reçu', body: 'Sur Base.', lang: 'fr', url: '/activity' }]));

      // ---- "show details": the owner's choice, visible before it applies
      await page.getByRole('switch', { name: 'Afficher les détails dans les notifications' }).click();
      await expect(page.getByTestId('push-preview')).toContainText('25 USDC envoyés sur Base.');
      await call(page, 'POST', '/__e2e/raise', { kind: 'deposit.received', params: { network: 'Base', symbol: 'ETH', amount: '2' }, subject: { type: 'deposit', id: '0xpush2', network: 'base' } });
      await expect.poll(async () => (await call(page, 'GET', '/__e2e/pushes') as Seen[]).length).toBe(3);
      expect((await call(page, 'GET', '/__e2e/pushes') as Seen[])[2]!.payload).toMatchObject({ d: true, p: { amount: '2', symbol: 'ETH' } });
      await page.getByRole('switch', { name: 'Afficher les détails dans les notifications' }).click();
      await expect(page.getByTestId('push-preview')).toContainText('Sur Base.');

      // a rule can be switched off
      await page.getByRole('button', { name: /^Transferts/ }).click();
      await page.getByRole('switch', { name: 'Dépôt reçu' }).click();
      await expect(page.getByRole('switch', { name: 'Dépôt reçu' })).toHaveAttribute('aria-checked', 'false');
      expect(await call(page, 'POST', '/__e2e/raise', { kind: 'deposit.received', params: { network: 'Base' } })).toMatchObject({ made: false });
      await page.getByRole('switch', { name: 'Dépôt reçu' }).click();
      await shot(page, 'settings-push-on');

      // removing this device unsubscribes it
      await page.getByTestId('push-devices').getByRole('button', { name: 'Retirer' }).click();
      await expect(state).toHaveAttribute('data-state', 'off');
      expect(await call(page, 'GET', '/push/subscriptions')).toEqual([]);

      // ---- system status
      if (phone) { await page.getByRole('navigation').getByRole('button', { name: 'Réglages' }).click(); await page.getByRole('button', { name: 'État du système' }).click(); }
      else await page.getByRole('button', { name: 'État du système' }).click();
      await expect(page).toHaveURL(/\/monitor$/);
      const mon = page.getByTestId('monitor-screen');
      await expect(mon.getByText('Sources en panne : Polygon')).toBeVisible();
      await expect(page.getByTestId('monitor-capital')).toContainText('Coffres d’agents');
      await expect(page.getByTestId('monitor-capital')).toContainText(/538,75\s\$/);         // LIVE vault, last snapshot
      await expect(page.getByTestId('monitor-capital')).toContainText(/10\s184,90\s\$/);     // paper account: shown, tagged simulated
      await expect(mon.getByText('Trois choses différentes, jamais additionnées')).toBeVisible();
      await expect(page.getByTestId('monitor-pnl')).toContainText('Momentum BTC/ETH');
      await expect(page.getByTestId('monitor-pnl')).toContainText(/\+26,35\s\$/);            // 7 d: 538.75 − 512.40
      await expect(page.getByTestId('monitor-connectors')).toContainText('Signataire');
      await expect(page.getByTestId('monitor-connectors')).toContainText('Polygon');
      await expect(page.getByTestId('monitor-loops')).toContainText('alerts');
      await expect(mon.getByText('e2e-demo-key')).toBeVisible();
      await expect(mon.getByText(/intact \(\d+ événements\)/)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await shot(page, 'monitor');

      // English
      await page.evaluate(() => localStorage.setItem('spw-locale', 'en'));
      await page.goto('/alerts');
      await expect(page.getByRole('heading', { name: 'Alerts' })).toBeVisible();
      await expect(page.getByTestId('alerts-list').locator('[data-kind="agent.stopped_loss"]')).toContainText('Agent stopped: loss limit');
      await shot(page, 'list-en');
      await page.evaluate(() => localStorage.setItem('spw-locale', 'fr'));
      expect(errors).toEqual([]);
    });
  });
}
