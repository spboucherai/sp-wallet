// v9: the Receive QR carries the network's logo in its centre — only acceptable if it still scans. This renders the QR of
// EVERY network's address on the real local QA stack, exactly as the phone shows it (and also at 1x and photographed small,
// blurred and rotated by the decoder script), and decodes each picture with an independent decoder (OpenCV QRCodeDetector,
// tests/e2e/v9-qr-scan.py). Any address that does not decode to the exact address of the page fails the run.
//
//   npx tsx tests/e2e/v9-qr-scan.mts [http://localhost:8731]      (needs python3 with opencv: `pip install opencv-python`)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { enter, passkeyFile, virtualPasskey } from './qa-helpers.ts';

const BASE = process.argv[2] ?? 'http://localhost:8731', dir = mkdtempSync(join(tmpdir(), 'spw-qr-'));
const browser = await chromium.launch(); const cases: { file: string; address: string; network: string; dsf: number; control?: boolean }[] = [];
for (const dsf of [3, 1]) {
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 }, deviceScaleFactor: dsf, isMobile: true, hasTouch: true, locale: 'fr-CA' });
  const page = await context.newPage(); const pk = await virtualPasskey(context, page, passkeyFile(Number(new URL(BASE).port)));
  await enter(page, pk, 'qa-setup-token');
  const accounts = await page.evaluate(async () => (await (await fetch('/api/v1/accounts', { credentials: 'same-origin' })).json()).accounts as { network: string; name: string; address: string }[]);
  await page.goto('/receive');
  for (const a of accounts) {
    await page.getByRole('radio', { name: a.name, exact: true }).click();   // in-app switch: no reload (the API rate-limits every request)
    await page.locator(`img[alt="QR ${a.address}"]`).waitFor({ timeout: 20_000 }); await page.getByTestId('qr-logo').waitFor();
    await page.waitForFunction(() => { const i = document.querySelector('[data-testid=qr-logo] img') as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth > 0; }); await page.waitForTimeout(250);
    const file = join(dir, `${a.network}-${dsf}x.png`); await page.getByTestId('qr-card').screenshot({ path: file });
    cases.push({ file, address: a.address, network: a.network, dsf });
    // control: the same code with the logo hidden — a miss that also happens here is the degradation, not the logo
    await page.addStyleTag({ content: '[data-testid=qr-logo]{visibility:hidden}' }).then(async (tag) => { const f2 = join(dir, `${a.network}-${dsf}x-nologo.png`); await page.getByTestId('qr-card').screenshot({ path: f2 }); cases.push({ file: f2, address: a.address, network: a.network, dsf, control: true }); await tag.evaluate((e) => (e as HTMLElement).remove()); });
  }
  await pk.save(); await context.close();
}
await browser.close();
writeFileSync(join(dir, 'cases.json'), JSON.stringify(cases));
try { process.stdout.write(execFileSync('python3', [new URL('./v9-qr-scan.py', import.meta.url).pathname, join(dir, 'cases.json')], { encoding: 'utf8' })); }
catch (e) { process.stdout.write(String((e as { stdout?: string }).stdout ?? e)); process.exit(1); }
