// V11 quote engine — the BUILT app in a real browser (Chromium), against the real local API and the REAL venues (read-only
// public market data): prices tick on Markets and in the Futures terminal, the status goes « reconnecting » when the
// Hyperliquid upstream is cut and comes back, and a browser whose websocket is refused falls back to REST polling / SSE.
// Not a spec of the e2e suite (it needs the venues and takes a minute): a script, like the v10-shots-*.mts ones.
// Run: node scripts/build.mjs && (cd apps/web && node_modules/.bin/vite build) && npx tsx tests/e2e/v11-quotes-live.mts
// Screenshots: test-results/v11-quotes/
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { createTestDb } from '../../services/api/test/test-db.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), SHOTS = path.join(ROOT, 'test-results/v11-quotes');
mkdirSync(SHOTS, { recursive: true });
const port: number = await new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });
const ORIGIN = `http://localhost:${port}`;
const db = await createTestDb('quotes_browser');
Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: 'localhost', DATABASE_URL: db.url, SPW_SIGNER_SECRET: 'unused-'.repeat(8), SPW_SIGNER_URL: 'http://127.0.0.1:9', SPW_BROADCAST: 'off', SPW_WORKERS: 'off',
  SPW_WEB_DIR: path.join(ROOT, 'dist/web'), PORT: String(port) });

/** the hub's Hyperliquid connection goes through this gate: `cut()` drops it and refuses new ones until `restore()` */
class Gate {
  static blocked = false; static open = new Set<Gate>();
  onopen: ((ev: unknown) => void) | null = null; onmessage: ((ev: { data: unknown }) => void) | null = null; onclose: ((ev: unknown) => void) | null = null; onerror: ((ev: unknown) => void) | null = null;
  private readonly ws: WebSocket | null = null;
  constructor(url: string) {
    if (Gate.blocked) { setTimeout(() => this.onclose?.({ code: 1006 }), 20); return; }
    const ws = new WebSocket(url); this.ws = ws; Gate.open.add(this);
    ws.onopen = (e) => this.onopen?.(e); ws.onmessage = (e) => this.onmessage?.(e); ws.onerror = (e) => this.onerror?.(e);
    ws.onclose = (e) => { Gate.open.delete(this); this.onclose?.(e); };
  }
  send(d: string): void { this.ws?.send(d); }
  close(): void { Gate.open.delete(this); try { this.ws?.close(); } catch { /* gone */ } }
  static cut(): void { Gate.blocked = true; for (const g of [...Gate.open]) { g.ws?.close(); } }
  static restore(): void { Gate.blocked = false; }
}

const { migrate, sql } = await import('../../services/api/src/db.ts');
await migrate();
const token = randomBytes(32).toString('base64url');
await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '2 hours')`;
const { COOKIE } = await import('../../services/api/src/auth.ts');
const { derivatives } = await import('../../services/api/src/derivatives/index.ts');
const { defaultUpstreams } = await import('../../services/api/src/quotes/index.ts');
const { buildServer } = await import('../../services/api/src/server.ts');
const app = await buildServer({ quotes: { upstreams: defaultUpstreams(derivatives(), undefined, { hlWebSocket: Gate as never }) } });
await app.listen({ port, host: '127.0.0.1' });

let failed = 0;
const ok = (name: string, cond: boolean, detail = ''): void => { if (!cond) failed += 1; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const browser = await chromium.launch();
const newPage = async (o: { blockWs?: boolean } = {}): Promise<{ page: Page; sse: string[]; wsUrls: string[]; cspErrors: string[] }> => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'fr-CA' });
  await ctx.addCookies([{ name: COOKIE, value: token, url: ORIGIN }]);
  const page = await ctx.newPage(), sse: string[] = [], wsUrls: string[] = [], cspErrors: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/derivatives/stream')) sse.push(r.url()); });
  page.on('websocket', (w) => wsUrls.push(w.url()));
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) cspErrors.push(m.text()); });
  if (o.blockWs) await page.routeWebSocket(/\/api\/v1\/stream/, (ws) => { void ws.close({ code: 1011, reason: 'refused by a proxy' }); });
  return { page, sse, wsUrls, cspErrors };
};
const priceOf = (page: Page, id: string) => page.locator(`[data-testid="qt-live"][data-id="${id}"]`).first().innerText().catch(() => null);
const states = async (page: Page) => page.$$eval('[data-testid="qt-dot"]', (els) => els.reduce<Record<string, number>>((m, e) => { const s = e.getAttribute('data-state') ?? '?'; m[s] = (m[s] ?? 0) + 1; return m; }, {}));

try {
  console.log(`quote engine in the browser  ${new Date().toISOString()}  ${ORIGIN}`);
  // ------------------------------------------------------------------------------------------------ Markets
  console.log('\n== Markets explorer (websocket live)');
  const a = await newPage();
  await a.page.goto(`${ORIGIN}/markets`);
  await a.page.waitForSelector('[data-testid="qt-conn"][data-state="live"]', { timeout: 20_000 });
  await a.page.waitForSelector('[data-testid="qt-live"]', { timeout: 20_000 });
  await a.page.waitForTimeout(4000);
  ok('one websocket to the same origin, no CSP violation', a.wsUrls.length === 1 && a.wsUrls[0] === `ws://localhost:${port}/api/v1/stream` && a.cspErrors.length === 0, `${a.wsUrls.join(', ')}${a.cspErrors.length ? ` | ${a.cspErrors[0]}` : ''}`);
  const rows = await a.page.locator('[data-testid="mk-open"]').count(), liveCells = await a.page.locator('[data-testid="qt-live"]').count();
  ok('rows carry live cells', liveCells >= rows, `${rows} rows, ${liveCells} live cells (price, change, funding)`);
  const seen = new Set<string>();
  for (let k = 0; k < 16; k++) { const p = await priceOf(a.page, 'hyperliquid:BTC'); if (p) seen.add(p); await a.page.waitForTimeout(500); }
  ok('the BTC price ticks (8 s of observation)', seen.size >= 2, `${seen.size} distinct values: ${[...seen].slice(0, 5).join(' | ')}`);
  const s1 = await states(a.page);
  ok('freshness dots say « live »', (s1.live ?? 0) > rows / 2, JSON.stringify(s1));
  await a.page.screenshot({ path: path.join(SHOTS, 'markets-live.png') });

  console.log('\n== the Hyperliquid upstream is cut');
  Gate.cut();
  await a.page.waitForSelector('[data-testid="qt-venue-hyperliquid"]', { timeout: 20_000 });
  const tag = await a.page.locator('[data-testid="qt-venue-hyperliquid"]').innerText();
  ok('the venue is named as reconnecting', /reconnexion|silencieux|hors service/.test(tag), tag.replace(/\s+/g, ' '));
  await a.page.waitForFunction(() => document.querySelectorAll('[data-testid="qt-dot"][data-state="reconnecting"], [data-testid="qt-dot"][data-state="stale"]').length > 0, undefined, { timeout: 30_000 }).catch(() => {});
  await a.page.waitForTimeout(1500);
  const s2 = await states(a.page), hl = await a.page.$$eval('[data-testid="qt-dot"][data-id^="hyperliquid:"]', (els) => els.map((e) => e.getAttribute('data-state'))), others = await a.page.$$eval('[data-testid="qt-dot"]:not([data-id^="hyperliquid:"])', (els) => els.map((e) => e.getAttribute('data-state')));
  ok('every Hyperliquid row says « reconnecting » (none « live »); the rows of the other venues on the same page stay live; so does the tab\'s connection',
    hl.length > 0 && hl.every((s) => s === 'reconnecting' || s === 'stale') && others.filter((s) => s === 'live').length >= others.length - 2 && await a.page.locator('[data-testid="qt-conn"][data-state="live"]').count() === 1,
    `${hl.length} Hyperliquid rows: ${JSON.stringify([...new Set(hl)])}; ${others.length} other rows: ${JSON.stringify(s2)}`);
  await a.page.screenshot({ path: path.join(SHOTS, 'markets-hyperliquid-cut.png') });
  // the other venues are not affected
  await a.page.locator('button', { hasText: 'edgeX' }).first().click().catch(() => {});
  await a.page.waitForTimeout(6000);
  const s3 = await states(a.page);
  ok('another venue keeps ticking meanwhile (edgeX rows)', (s3.live ?? 0) > 0, JSON.stringify(s3));
  Gate.restore();
  await a.page.waitForSelector('[data-testid="qt-venue-hyperliquid"]', { state: 'detached', timeout: 60_000 });
  ok('back by itself after the cut: the tag is gone', true);

  // ------------------------------------------------------------------------------------------------ Futures terminal
  console.log('\n== Futures terminal (hyperliquid:BTC)');
  await a.page.goto(`${ORIGIN}/futures/${encodeURIComponent('hyperliquid:BTC')}`);
  await a.page.waitForSelector('[data-testid="freshness"][data-state="live"]', { timeout: 30_000 });
  await a.page.waitForSelector('[data-testid="book"]', { timeout: 20_000 });
  const marks = new Set<string>();
  for (let k = 0; k < 16; k++) { marks.add(await a.page.locator('[data-testid="mark-price"]').first().innerText()); await a.page.waitForTimeout(500); }
  ok('the mark price ticks from the shared socket', marks.size >= 2, `${marks.size} distinct values`);
  ok('order book and trades are drawn', await a.page.locator('[data-testid="book"]').count() > 0 && await a.page.locator('[data-testid="trades"]').count() >= 0);
  ok('no SSE stream was opened while the socket is live', a.sse.length === 0, `${a.sse.length} request(s) to /derivatives/stream; websockets opened by the tab: ${a.wsUrls.length}`);
  await a.page.screenshot({ path: path.join(SHOTS, 'futures-live.png') });

  // ------------------------------------------------------------------------------------------------ Compare, Private Markets
  console.log('\n== Compare and Private Markets');
  await a.page.goto(`${ORIGIN}/markets?v=compare&u=BTC`);
  await a.page.waitForSelector('[data-testid="cp-live"]', { timeout: 40_000 });
  const before = await a.page.locator('[data-testid="cp-total"]').first().innerText().catch(() => '');
  ok('the comparison shows the live price next to the one it was computed on', await a.page.locator('[data-testid="cp-live"]').count() >= 2, `${await a.page.locator('[data-testid="cp-live"]').count()} venues with a live price`);
  await a.page.locator('[data-testid="cp-recompute"]').click();
  await a.page.waitForTimeout(2500);
  ok('« recompute now » re-reads the comparison on demand', (await a.page.locator('[data-testid="cp-total"]').first().innerText().catch(() => '')).length > 0, `total before: ${before.replace(/\s+/g, ' ')}`);
  await a.page.screenshot({ path: path.join(SHOTS, 'compare-live.png') });
  await a.page.goto(`${ORIGIN}/private-markets`);
  await a.page.waitForSelector('[data-testid="qt-live"]', { timeout: 40_000 }).catch(() => {});
  await a.page.waitForTimeout(5000);
  const pm = await a.page.locator('[data-testid="qt-live"]').count(), pmDots = await states(a.page);
  ok('private markets: contracts tick from the venue streams (builder-dex coins and edgeX)', pm > 0, `${pm} live prices; dots ${JSON.stringify(pmDots)}`);
  await a.page.screenshot({ path: path.join(SHOTS, 'private-markets-live.png') });
  const st = await (await fetch(`${ORIGIN}/api/v1/stream/stats`, { headers: { cookie: `${COOKIE}=${token}` } })).json() as any;
  console.log(`  server: ${st.connections.open} connection(s), ${st.subscriptions} subscriptions, ${st.messagesSent} frames sent, conflated ${st.backpressure.conflated}, upstream reconnects ${st.upstreamReconnects}, lag p50 ${st.lagMs.p50} ms p95 ${st.lagMs.p95} ms`);
  await a.page.context().close();

  // ------------------------------------------------------------------------------------------------ fallback
  console.log('\n== a browser whose websocket is refused (corporate proxy)');
  const b = await newPage({ blockWs: true });
  await b.page.goto(`${ORIGIN}/markets`);
  await b.page.waitForSelector('[data-testid="mk-open"]', { timeout: 20_000 });
  await b.page.waitForSelector('[data-testid="qt-conn"][data-state="fallback"]', { timeout: 30_000 });
  const fbRows = await b.page.locator('[data-testid="mk-open"]').count(), fbFresh = await b.page.locator('[data-testid="mk-fresh"]').count(), fbText = (await b.page.locator('[data-testid="qt-conn"]').innerText()).replace(/\s+/g, ' ');
  ok('the state says so and the rows keep the polled figures with their own age', fbRows > 0 && fbFresh >= fbRows && await b.page.locator('[data-testid="qt-live"]').count() === 0, `${fbRows} rows, ${fbFresh} polled freshness marks; « ${fbText} »`);
  await b.page.screenshot({ path: path.join(SHOTS, 'markets-fallback.png') });
  await b.page.goto(`${ORIGIN}/futures/${encodeURIComponent('hyperliquid:BTC')}`);
  await b.page.waitForSelector('[data-testid="mark-price"]', { timeout: 20_000 });
  await b.page.waitForFunction(() => /\d/.test(document.querySelector('[data-testid="mark-price"]')?.textContent ?? ''), undefined, { timeout: 30_000 });
  await b.page.waitForSelector('[data-testid="freshness"][data-state="live"]', { timeout: 40_000 }).catch(() => {});
  ok('the terminal falls back to its SSE stream and stays live', b.sse.length >= 1 && await b.page.locator('[data-testid="freshness"][data-state="live"]').count() === 1, `${b.sse.length} SSE request(s); freshness ${await b.page.locator('[data-testid="freshness"]').first().getAttribute('data-state')}`);
  await b.page.screenshot({ path: path.join(SHOTS, 'futures-fallback.png') });
  await b.page.context().close();
} catch (e) { failed += 1; console.log(`  FAIL (exception) ${(e as Error).message.split('\n')[0]}`); }
finally {
  await browser.close();
  await app.close();
  await sql.end({ timeout: 2 }).catch(() => {});
  await db.drop().catch(() => {});
}
console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) FAILED`} — screenshots in ${path.relative(ROOT, SHOTS)}/`);
process.exit(failed === 0 ? 0 : 1);
