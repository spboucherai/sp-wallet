// Records a real, read-only API answer as a test fixture: { recordedAt, url, status, body }.
//   node packages/swap/test/fixtures/record.mjs <provider-dir> <name> <url>
// Nothing here signs or sends anything; it is one GET.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [dir, name, url] = process.argv.slice(2);
if (!dir || !name || !url) { console.error('usage: record.mjs <provider-dir> <name> <url>'); process.exit(2); }
const t0 = Date.now();
const r = await fetch(url, { headers: { accept: 'application/json', 'x-client-id': 'sp-wallet' }, redirect: 'error', signal: AbortSignal.timeout(25_000) });
const text = await r.text();
let body; try { body = JSON.parse(text); } catch { body = text; }
const out = join(dirname(fileURLToPath(import.meta.url)), dir, `${name}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ recordedAt: new Date().toISOString(), url, status: r.status, body }, null, 2) + '\n');
console.log(`${r.status} ${Date.now() - t0}ms ${name} ${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 700)}`);
