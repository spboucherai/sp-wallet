// iOS launch images of the installed app (apple-touch-startup-image): the app mark centred on the app's dark background,
// one PNG per iPhone screen size listed below, written to apps/web/public/splash/. Run by hand when the mark changes:
//   npx tsx apps/web/scripts/gen-splash.mts       (prints the <link> tags index.html must carry)
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url)), OUT = join(HERE, '../public/splash'); mkdirSync(OUT, { recursive: true });
/** CSS width × height, device pixel ratio (portrait) */
export const SCREENS: [number, number, number][] = [[390, 844, 3], [393, 852, 3], [402, 874, 3], [430, 932, 3], [440, 956, 3], [375, 812, 3], [414, 896, 2]];
const icon = `data:image/svg+xml;base64,${readFileSync(join(HERE, '../public/icon.svg')).toString('base64')}`;
const browser = await chromium.launch();
for (const [w, h, r] of SCREENS) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: r });
  await page.setContent(`<body style="margin:0;height:100vh;display:grid;place-items:center;background:#06080c"><img src="${icon}" style="width:96px;height:96px;border-radius:28px"></body>`);
  await page.screenshot({ path: join(OUT, `${w * r}x${h * r}.png`) }); await page.close();
  console.log(`<link rel="apple-touch-startup-image" media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait)" href="/splash/${w * r}x${h * r}.png" />`);
}
await browser.close();
