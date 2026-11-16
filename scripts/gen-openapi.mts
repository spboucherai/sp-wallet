// Writes the OpenAPI 3.1 document of the SP Trading API and its readable index, both generated from the route table
// (services/api/src/trading-api/spec.ts — the same table the server registers its routes from).
//   docs/openapi/trading-v1.json      the document served at GET /api/v1/trading/openapi.json
//   docs/TRADING-API-OPENAPI.md       operations, scopes, parameters, errors
// Run: node scripts/gen-openapi.mts          (--check: write nothing, exit 1 when a committed file differs)
// A test (services/api/test/trading-api-unit.test.ts) fails when the committed files are not what this script writes.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApiJson, openApiMarkdown } from '../services/api/src/trading-api/openapi.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files: [string, string][] = [[join(root, 'docs/openapi/trading-v1.json'), openApiJson()], [join(root, 'docs/TRADING-API-OPENAPI.md'), openApiMarkdown()]];
const check = process.argv.includes('--check');
let stale = 0;
for (const [path, content] of files) {
  let current: string | null = null;
  try { current = readFileSync(path, 'utf8'); } catch { /* not written yet */ }
  if (current === content) { console.log(`up to date  ${path}`); continue; }
  if (check) { stale += 1; console.error(`STALE       ${path} — run: node scripts/gen-openapi.mts`); continue; }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`written     ${path} (${content.length} bytes)`);
}
process.exit(stale ? 1 : 0);
