// v9: scrolling smoothness of a built bundle on a throttled-CPU phone profile, with the API replayed from the recorded
// answers (tests/e2e/fixtures/v9/api.json) so two bundles are compared on identical data.
//
//   npx tsx tests/e2e/v9-perf.mts <web-dir> [label] [--serve port]     e.g. dist/web after
//
// Method: Chromium, 390×844 @3x, touch, CDP CPU throttling ×4. Each screen is scrolled top to bottom with a synthesised
// touch fling (CDP Input.synthesizeScrollGesture, 1 600 px/s); a requestAnimationFrame loop in the page records every
// frame interval during the gesture. Reported: frames, mean fps, 95th-percentile frame time, share of frames over 20 ms
// (a missed 60 Hz frame) and over 34 ms. Headless Chromium on a laptop: a relative before/after figure, not an iPhone.
// `--serve port` only serves the bundle with the replayed API (used for Lighthouse runs) until killed.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const dir = resolve(process.argv[2] ?? 'dist/web'), label = process.argv[3] ?? 'bundle', serveAt = process.argv.indexOf('--serve') > 0 ? Number(process.argv[process.argv.indexOf('--serve') + 1]) : 0;
const authed = !process.argv.includes('--locked');
const FIX = JSON.parse(readFileSync(resolve('tests/e2e/fixtures/v9/api.json'), 'utf8')).answers as Record<string, unknown>;
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname.startsWith('/api/v1/')) {
    const key = u.pathname.replace('/api/v1', '') + u.search;
    const hit = key === '/auth/state' ? { setupRequired: false, authenticated: authed } : FIX[key] ?? (key.startsWith('/market/') ? FIX['/market/ETH?days=7&currency=cad'] : undefined);
    if (key.startsWith('/alerts/stream')) { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.write(': ok\n\n'); return; }
    res.writeHead(hit === undefined ? 404 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(hit ?? { error: 'not_found', message: 'not in the fixtures' })); return;
  }
  let f = join(dir, decodeURIComponent(u.pathname)); if (!f.startsWith(dir) || !existsSync(f) || statSync(f).isDirectory()) f = join(dir, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream', 'cache-control': f.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' }); res.end(readFileSync(f));
});
await new Promise<void>((r) => server.listen(serveAt, '127.0.0.1', r));
const port = (server.address() as { port: number }).port, BASE = `http://localhost:${port}`;
if (serveAt) { console.log(`serving ${dir} on ${BASE} (${authed ? 'unlocked, replayed API' : 'locked'})`); await new Promise(() => {}); }

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'fr-CA' });
const page = await context.newPage(); const cdp = await context.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
const rows: string[] = [];
for (const [name, path] of [['Home', '/'], ['Assets (249 rows)', '/assets'], ['Activity', '/activity'], ['Security', '/security']] as const) {
  await page.goto(BASE + path); await page.waitForTimeout(2500);
  const height = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  // strings, not functions: tsx wraps named inner functions with a helper that does not exist in the page
  await page.evaluate('window.__f = []; window.__on = true; (function () { var last = performance.now(); function tick(t) { window.__f.push(t - last); last = t; if (window.__on) requestAnimationFrame(tick); } requestAnimationFrame(tick); })()');
  const dist = Math.min(height, 9000);
  await cdp.send('Input.synthesizeScrollGesture', { x: 195, y: 600, yDistance: -dist, speed: 1600, gestureSourceType: 'touch' });
  const f = await page.evaluate('window.__on = false; window.__f.slice(1)') as number[];
  const s = [...f].sort((a, b) => a - b), mean = f.reduce((a, b) => a + b, 0) / f.length;
  rows.push(`| ${label} | ${name} | ${Math.round(dist)} px | ${f.length} | ${(1000 / mean).toFixed(1)} | ${s[Math.floor(s.length * 0.95)]!.toFixed(1)} ms | ${((f.filter((x) => x > 20).length / f.length) * 100).toFixed(1)} % | ${((f.filter((x) => x > 34).length / f.length) * 100).toFixed(1)} % |`);
}
console.log('| bundle | screen | scrolled | frames | mean fps | p95 frame | > 20 ms | > 34 ms |\n|---|---|---|---|---|---|---|---|\n' + rows.join('\n'));
await browser.close(); server.close();
