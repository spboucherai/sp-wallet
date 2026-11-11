// v10 design pass — the shell: the large title collapsing into the header on scroll, Home and the asset list after the
// performance pass. Real local QA stack (throwaway seed, broadcast off):
//   (cd apps/web && node_modules/.bin/vite build)
//   npx tsx tests/e2e/qa-real-server.mts --port 8830 --db spw_v10_shell --fork base,arbitrum
//   npx tsx tests/e2e/v10-shots-shell.mts after
import { qaEnter, runShots } from './v10-shots-lib.mts';

const BASE = process.env.QA_BASE ?? 'http://localhost:8830';
const scroll = (y: number) => async (page: import('@playwright/test').Page) => { await page.evaluate((v) => scrollTo(0, v), y); await page.waitForTimeout(500); };
await runShots('shell', [{ base: BASE, setup: qaEnter, scenarios: [
  { name: 'home', path: '/' },
  { name: 'assets', path: '/assets' },
  { name: 'assets-title-collapsed', path: '/assets', act: scroll(420), skip: (c) => !c.mobile },
  { name: 'security-title-collapsed', path: '/security', act: scroll(520), skip: (c) => !c.mobile },
  { name: 'activity-title-collapsed', path: '/activity', act: scroll(200), skip: (c) => !c.mobile },
] }]);
