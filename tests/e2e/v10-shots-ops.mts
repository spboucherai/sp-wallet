/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : tests/e2e/v10-shots-ops.mts
 * Module           : tests
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// v10 design pass — screenshots of the `ops` area: Alerts (inbox + settings), Monitor (« État du système »), Research.
//
//   (cd apps/web && node_modules/.bin/vite build) && npx tsx tests/e2e/v10-shots-ops.mts before|after [names] [configs]
//   (run it twice: V10_OPS_SKIP=alerts-push-on … <label>, then … <label> alerts-push-on — see the end of this file)
//   npx tsx tests/e2e/v10-shots-ops.mts stop        — stops the two servers this script left running
//
// Two throwaway local servers, the same ones the specs use, on this script's OWN ports and databases:
//   · tests/e2e/alerts-server.mts   --port 8683 --db spw_v10_ops_alerts    (real API, seeded alerts, stub signer, fake push service)
//   · tests/e2e/research-server.mts --port 8693 --db spw_v10_ops_research  (real API + the real research runner with the FAKE agent)
// They are left running between two invocations (their token is kept in a file under the OS temp directory), because seeding
// the research jobs takes a few minutes; they serve the built bundle from dist/web, so a rebuild is picked up at once.
//
// What is real and what is staged, so nobody mistakes a picture for a test:
//   · every alert, every research job, every figure comes from those servers (the jobs are run by the real runner);
//   · states the servers cannot be put in are staged IN THE PAGE by rewriting one API answer (page.route): the empty inbox,
//     the inbox skeleton, "no runner configured", "no job yet", and the Monitor variants (all well / a failing loop and the
//     sandbox unavailable / the sandbox off) — the alerts server always has one network down and has no hook for the others;
//   · the push card states are reached by masking browser capabilities in the page (no PushManager, an iPhone user agent,
//     a denied / default / granted permission); "on" subscribes to the server's fake push service like alerts.spec.ts does.
// No key, no seed, no .env, nothing broadcast.
import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrowserContext, Page, Route } from '@playwright/test';
import { ROOT, runShots, settle, type Cfg, type Group, type Scenario } from './v10-shots-lib.mts';

const A_PORT = 8683, R_PORT = 8693, A_DB = 'spw_v10_ops_alerts', R_DB = 'spw_v10_ops_research';
const STATE = join(tmpdir(), 'spw-v10-ops-shots.json');
interface Srv { pid: number; token: string; agent: string }
interface State { alerts?: Srv; research?: Srv; jobs?: Record<string, string> }
const state: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) as State : {};
const save = () => writeFileSync(STATE, JSON.stringify(state));
const alive = async (port: number) => { try { return (await fetch(`http://localhost:${port}/`)).ok; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function server(kind: 'alerts' | 'research', port: number, db: string): Promise<Srv> {
  const had = state[kind];
  if (had && await alive(port)) return had;
  const log = join(tmpdir(), `spw-v10-ops-${kind}.log`); rmSync(log, { force: true });
  const out = openSync(log, 'a');
  const child = spawn(resolve(ROOT, 'node_modules/.bin/tsx'), [`tests/e2e/${kind}-server.mts`, '--port', String(port), '--db', db], { cwd: ROOT, stdio: ['ignore', out, out], detached: true });
  child.unref();
  for (let i = 0; i < 400; i++) {
    const m = /READY \S+ token (\S+) agent (\S+)/.exec(existsSync(log) ? readFileSync(log, 'utf8') : '');
    if (m) { const s = { pid: child.pid!, token: m[1]!, agent: m[2]! }; state[kind] = s; if (kind === 'research') delete state.jobs; save(); return s; }
    if (child.exitCode !== null) break;
    await sleep(250);
  }
  throw new Error(`the ${kind} server did not start: ${readFileSync(log, 'utf8').slice(-1500)}`);
}

if (process.argv[2] === 'stop') {
  for (const k of ['alerts', 'research'] as const) { const s = state[k]; if (s) { try { process.kill(-s.pid, 'SIGTERM'); } catch { try { process.kill(s.pid, 'SIGTERM'); } catch { /* gone */ } } } }
  rmSync(STATE, { force: true }); console.log('stopped'); process.exit(0);
}
if (!existsSync(resolve(ROOT, 'dist/web/sw.js'))) throw new Error('dist/web is missing: (cd apps/web && node_modules/.bin/vite build) first');

const al = await server('alerts', A_PORT, A_DB), rs = await server('research', R_PORT, R_DB);
const A = `http://localhost:${A_PORT}`, R = `http://localhost:${R_PORT}`;

// ---- research jobs, run once by the real runner with the fake agent (ok → lie → impure → hang+cancel → ok → hang, left running)
const rcall = async (method: string, path: string, body?: unknown): Promise<any> => {
  const r = await fetch(`${R}/api/v1${path}`, { method, headers: { cookie: `spw=${rs.token}`, origin: R, ...(method === 'GET' ? {} : { 'x-spw-csrf': '1', 'content-type': 'application/json' }) }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => null); if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j).slice(0, 300)}`); return j;
};
const budgets = { wallSeconds: 3600, maxTrials: 80, maxDiskMb: 512, maxModelTokens: 5_000_000, maxModelUsd: 10 };
const until = async (id: string, states: string[], ms: number) => { for (const t0 = Date.now(); Date.now() - t0 < ms;) { const j = await rcall('GET', `/research/jobs/${id}`); if (states.includes(j.state)) return j; await sleep(1500); } throw new Error(`job ${id} did not reach ${states.join('/')}`); };
if (!state.jobs) {
  console.log('seeding research jobs (a few minutes)…');
  const jobs: Record<string, string> = {};
  const make = async (mode: string, mission: string, forAgent: boolean, wait: string[], ms = 300_000) => {
    await rcall('POST', '/__e2e/fake-mode', { mode });
    const j = await rcall('POST', '/research/jobs', { mission, ...(forAgent ? { agentId: rs.agent, universe: ['BTC', 'ETH'] } : { kind: 'spot', universe: ['BTC', 'ETH'], interval: '1h' }), capitalUsd: 1000, budgets });
    await until(j.id, wait, ms); return j.id as string;
  };
  jobs.approved = await make('ok', 'Développe une stratégie statistique BTC/ETH, teste-la sur données historiques et prépare une simulation avec un capital virtuel de 1 000 USDC', true, ['submitted']);
  jobs.differs = await make('lie', 'Même mission, sans agent : un brouillon de bibliothèque sur BTC et ETH.', false, ['submitted']);
  jobs.refused = await make('impure', 'Une stratégie qui tente de lire un fichier.', false, ['failed']);
  jobs.cancelled = await make('hang', 'Une tâche qui ne finit pas : elle sera annulée.', false, ['running']);
  await rcall('POST', `/research/jobs/${jobs.cancelled}/cancel`); await until(jobs.cancelled, ['cancelled'], 90_000);
  jobs.submitted = await make('ok', 'Cherche une variante plus prudente : moins de rotation, perte maximale plus faible, mêmes actifs.', true, ['submitted']);
  // the first version is approved and paper trading started (the owner's two explicit actions, done here through the API)
  const first = await rcall('GET', `/research/jobs/${jobs.approved}`);
  await rcall('POST', `/agents/${rs.agent}/strategies/${first.version.id}/approve`); await rcall('POST', `/agents/${rs.agent}/mode`, { mode: 'PAPER' });
  jobs.running = await make('hang', 'Explore un filtre de volatilité sur ETH ; arrête-toi dès que la validation se dégrade.', false, ['running']);
  await sleep(4000);
  state.jobs = jobs; save();
}
const J = state.jobs!;

// ---- scenarios
const cookie = (srv: Srv) => async (page: Page, context: BrowserContext, _cfg: Cfg, base: string) => {
  await context.addCookies([{ name: 'spw', value: srv.token, url: base }]);
  // the push card: browser capabilities as asked by sessionStorage['v10-push'] (default: supported, permission not asked yet)
  // (a string, not a function: tsx wraps named arrow functions in a helper that does not exist in the page)
  await page.addInitScript(`(function () {
    var mode = sessionStorage.getItem('v10-push') || 'off';
    var perm = mode === 'denied' ? 'denied' : mode === 'on' ? 'granted' : 'default';
    try { Object.defineProperty(Notification, 'permission', { get: function () { return perm; }, configurable: true }); Notification.requestPermission = function () { return Promise.resolve(perm); }; } catch (e) {}
    if (mode === 'unsupported' || mode === 'ios') { delete window.PushManager; }
    if (mode === 'ios') Object.defineProperty(navigator, 'userAgent', { get: function () { return 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'; } });
    if (mode === 'on' && 'PushManager' in window) {
      var b = function (s) { var bin = atob(s.replace(/-/g, '+').replace(/_/g, '/')), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };
      var current = null;
      PushManager.prototype.getSubscription = function () { return Promise.resolve(current); };
      PushManager.prototype.subscribe = function (o) {
        return fetch('/api/v1/__e2e/subscription').then(function (r) { return r.json(); }).then(function (s) {
          current = { endpoint: s.endpoint, options: { applicationServerKey: o && o.applicationServerKey && o.applicationServerKey.buffer ? o.applicationServerKey.buffer : (o && o.applicationServerKey), userVisibleOnly: true },
            getKey: function (n) { return b(n === 'p256dh' ? s.p256dh : s.auth); }, unsubscribe: function () { current = null; return Promise.resolve(true); } };
          return current; });
      };
    }
  })()`);
};
type Stage = (page: Page) => Promise<void>;
let staged = false;
/** every scenario goes through here: the previous scenario's staging is removed, this one's is installed, the page reloaded when either applies */
const sc = (name: string, path: string, o: { stage?: Stage; act?: (page: Page, cfg: Cfg) => Promise<void>; full?: boolean; wait?: number; push?: string } = {}): Scenario => ({ name, path, full: o.full, wait: o.wait,
  act: async (page, cfg) => {
    const dirty = staged || !!o.stage || !!o.push || (await page.evaluate(() => sessionStorage.getItem('v10-push'))) !== null;
    await page.unrouteAll({ behavior: 'ignoreErrors' }); staged = !!o.stage;
    await page.evaluate((m) => { if (m) sessionStorage.setItem('v10-push', m); else sessionStorage.removeItem('v10-push'); }, o.push ?? '');
    if (o.stage) await o.stage(page);
    if (dirty) { await page.reload(); await settle(page, o.wait ?? 1500); }
    await o.act?.(page, cfg);
  } });
const rewrite = (page: Page, glob: string | RegExp, f: (json: any) => any): Promise<void> => page.route(glob, async (route: Route) => { const r = await route.fetch(); await route.fulfill({ response: r, json: f(await r.json()) }); });
const toTestId = (id: string) => async (page: Page) => { await page.getByTestId(id).first().evaluate((el) => { const y = el.getBoundingClientRect().top + scrollY - 76; scrollTo(0, Math.max(0, y)); }); };
const health = (f: (h: any) => void): Stage => (page) => rewrite(page, '**/api/v1/monitor/health', (h) => { for (const c of h.connectors) if (c.ok === false) { c.ok = true; c.detail = '2/2 endpoints'; c.ageSec = 12; } f(h); return h; });

const alerts: Group = { base: A, setup: async (page, context, cfg, base) => { await cookie(al)(page, context, cfg, base);
    await page.goto('/alerts'); await page.evaluate(async () => { const h = { 'x-spw-csrf': '1', 'content-type': 'application/json' }; for (const d of await (await fetch('/api/v1/push/subscriptions')).json() as { id: string }[]) await fetch(`/api/v1/push/subscriptions/${d.id}`, { method: 'DELETE', headers: h, body: '{}' }); }); },
  scenarios: [
    sc('alerts-inbox', '/alerts', { full: true }),
    sc('alerts-inbox-critical', '/alerts', { act: async (p) => { await p.getByRole('radio', { name: 'Critique' }).click(); } }),
    sc('alerts-inbox-system', '/alerts', { act: async (p) => { await p.getByRole('radio', { name: 'Système' }).click(); } }),
    sc('alerts-empty', '/alerts', { stage: (p) => rewrite(p, /\/api\/v1\/alerts\?/, (j) => ({ ...j, items: [], unread: 0, critical: 0 })) }),
    sc('alerts-skeleton', '/alerts', { stage: (p) => p.route(/\/api\/v1\/alerts\?/, () => { /* never answered: the loading state */ }), wait: 300 }),
    sc('alerts-settings', '/alerts?v=settings', { full: true }),
    sc('alerts-settings-rules', '/alerts?v=settings', { act: async (p) => { await p.getByRole('button', { name: /^Transferts/ }).click(); await p.getByRole('button', { name: /^Transferts/ }).evaluate((el) => scrollTo(0, el.getBoundingClientRect().top + scrollY - 140)); } }),
    // the system group holds the two kinds that cannot be switched off: they stay listed, locked on
    sc('alerts-settings-rules-fixed', '/alerts?v=settings', { act: async (p) => { await p.getByRole('button', { name: /^Système/ }).click(); await p.locator('[data-fixed]').first().evaluate((el) => scrollTo(0, el.getBoundingClientRect().bottom + scrollY - innerHeight + 150)); } }),
    sc('alerts-settings-thresholds', '/alerts?v=settings', { act: async (p) => { await p.getByText('Seuils', { exact: true }).first().evaluate((el) => scrollTo(0, el.getBoundingClientRect().top + scrollY - 90)); } }),
    sc('alerts-settings-webhook', '/alerts?v=settings', { act: async (p) => { await p.getByTestId('webhook-sample').evaluate((el) => scrollTo(0, el.getBoundingClientRect().top + scrollY - 420)); } }),
    sc('alerts-push-denied', '/alerts?v=settings', { push: 'denied' }),
    sc('alerts-push-unsupported', '/alerts?v=settings', { push: 'unsupported' }),
    sc('alerts-push-ios', '/alerts?v=settings', { push: 'ios' }),
    sc('alerts-push-on', '/alerts?v=settings', { push: 'on', act: async (p) => { await p.getByRole('button', { name: 'Activer les notifications' }).click(); await p.getByTestId('push-state').and(p.locator('[data-state="on"]')).waitFor({ timeout: 15_000 }); await p.getByTestId('push-devices').getByRole('button', { name: 'Tester' }).click(); await p.waitForTimeout(1200); } }),
    sc('monitor', '/monitor', { full: true }),
    sc('monitor-ok', '/monitor', { full: true, stage: health(() => {}) }),
    sc('monitor-failing', '/monitor', { full: true, stage: health((h) => {
      h.loops = [...h.loops, { name: 'reconcile', everyMs: 60_000, runs: 412, lastOkAt: Date.now() - 1_860_000, lastError: 'connect ECONNREFUSED 127.0.0.1:8545', failures: 31, ageSec: 1860, late: true }];
      h.lab = { mode: 'unavailable', ok: false, reason: 'sandbox-exec: Operation not permitted' };
      h.signer = { reachable: true, halted: true }; }) }),
    sc('monitor-system-failing', '/monitor', { stage: health((h) => {
      h.loops = [...h.loops, { name: 'reconcile', everyMs: 60_000, runs: 412, lastOkAt: Date.now() - 1_860_000, lastError: 'connect ECONNREFUSED 127.0.0.1:8545', failures: 31, ageSec: 1860, late: true }];
      h.lab = { mode: 'unavailable', ok: false, reason: 'sandbox-exec: Operation not permitted' }; }), act: toTestId('monitor-loops') }),
    sc('monitor-lab-off', '/monitor', { stage: health((h) => { h.lab = { mode: 'off', ok: false, reason: null }; }), act: toTestId('monitor-lab') }),
    sc('monitor-capabilities', '/monitor', { act: toTestId('monitor-capabilities') }),
  ] };

const openJob = (id: string) => `/research?job=${id}`;
const research: Group = { base: R, setup: cookie(rs), scenarios: [
  sc('research-list', '/research', { full: true }),
  sc('research-empty', '/research', { stage: (p) => rewrite(p, /\/api\/v1\/research\/jobs$/, () => ({ jobs: [] })) }),
  sc('research-norunner', '/research', { stage: async (p) => { await rewrite(p, /\/api\/v1\/research\/jobs$/, () => ({ jobs: [] })); await rewrite(p, '**/api/v1/research/status', (s) => ({ ...s, runnerConfigured: false, lastRunnerContact: null, openJobs: 0 })); } }),
  sc('research-form', '/research', { full: true, act: async (p) => { await p.getByTestId('rj-new').click(); await p.getByTestId('rj-mission').fill('Développe une stratégie statistique BTC/ETH, teste-la sur données historiques et prépare une simulation avec un capital virtuel de 1 000 USDC'); await p.getByTestId('rj-symbols').fill('BTC, ETH, SOL'); await p.getByTestId('rj-budget-minutes').fill('45'); await p.getByTestId('rj-mission').blur(); } }),
  sc('research-job-running', openJob(J.running!), { full: true, wait: 2500 }),
  sc('research-job-submitted', openJob(J.submitted!), { full: true, wait: 2500, act: toTestId('rj-job') }),
  sc('research-job-compare', openJob(J.submitted!), { wait: 2500, act: toTestId('rj-compare') }),
  sc('research-job-approval', openJob(J.submitted!), { wait: 2500, act: async (p) => { await p.getByTestId('rj-actions').evaluate((el) => scrollTo(0, el.getBoundingClientRect().bottom + scrollY - innerHeight + 130)); } }),
  sc('research-job-approved', openJob(J.approved!), { wait: 2500, act: async (p) => { await p.getByTestId('rj-actions').evaluate((el) => scrollTo(0, el.getBoundingClientRect().bottom + scrollY - innerHeight + 130)); } }),
  sc('research-job-differs', openJob(J.differs!), { full: true, wait: 2500, act: toTestId('rj-compare') }),
  sc('research-job-refused', openJob(J.refused!), { full: true, wait: 2500, act: toTestId('rj-job') }),
  sc('research-job-cancelled', openJob(J.cancelled!), { wait: 2500, act: toTestId('rj-job') }),
  sc('research-panel', `/agents/${rs.agent}`, { wait: 2500, act: toTestId('rj-panel') }),
  sc('research-panel-form', `/agents/${rs.agent}`, { wait: 2500, act: async (p) => { await p.getByTestId('rj-panel').getByTestId('rj-new').click(); await p.getByTestId('rj-mission').fill('Cherche une variante plus prudente : moins de rotation, perte maximale plus faible, mêmes actifs.'); await toTestId('rj-panel')(p); } }),
] };

// V10_OPS_SKIP=name,name leaves scenarios out: "Tester" on the push card raises a real test alert, so `alerts-push-on` is shot in
// a pass of its own, after the inbox pictures (V10_OPS_SKIP=alerts-push-on, then `after alerts-push-on`)
const skip = (process.env.V10_OPS_SKIP ?? '').split(',').filter(Boolean);
for (const g of [alerts, research]) g.scenarios = g.scenarios.filter((x) => !skip.includes(x.name));
await runShots('ops', [alerts, research]);
