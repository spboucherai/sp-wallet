// Writes the OpenAPI 3.1 document of the SP Trading API and its readable index, both generated from the route table
// (services/api/src/trading-api/spec.ts — the same table the server registers its routes from).
//   docs/openapi/trading-v1.json      the document served at GET /api/v1/trading/openapi.json
//   docs/TRADING-API-OPENAPI.md       compact index: operations, scopes, parameters, errors
//   docs/TRADING-API-REFERENCE.md     the reference a person reads (getting started, concepts, one worked example per operation,
//                                     error catalogue) — the Markdown of the page served at GET /api/v1/trading/docs
// and the contract of the SP Wallet core API (services/api/src/wallet-api/spec.ts):
//   docs/openapi/wallet-v1.json             the OpenAPI 3.1 document of everything a wallet client uses outside /api/v1/trading
//   apps/web/src/generated/wallet-api.ts    its TypeScript types for the web app
//   docs/next/SP-WALLET-API.md              the generated sections (route table, error catalogue, life cycle…) between their markers
// Run: node scripts/gen-openapi.mts          (--check: write nothing, exit 1 when a committed file differs)
// A test (services/api/test/trading-api-unit.test.ts) fails when the committed files are not what this script writes.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApiJson, openApiMarkdown } from '../services/api/src/trading-api/openapi.ts';
import { referenceMarkdown } from '../services/api/src/trading-api/reference.ts';
import { applyDocSections, walletOpenApiJson } from '../services/api/src/wallet-api/openapi.ts';
import { generateWalletTypes } from './lib/gen-wallet-types.mts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files: [string, string][] = [[join(root, 'docs/openapi/trading-v1.json'), openApiJson()], [join(root, 'docs/TRADING-API-OPENAPI.md'), openApiMarkdown()],
  [join(root, 'docs/TRADING-API-REFERENCE.md'), referenceMarkdown()]];
// the wallet contract: the document, the web types generated from it, and the generated sections of its guide
const walletJson = walletOpenApiJson(), walletDoc = join(root, 'docs/next/SP-WALLET-API.md');
files.push([join(root, 'docs/openapi/wallet-v1.json'), walletJson], [join(root, 'apps/web/src/generated/wallet-api.ts'), generateWalletTypes(JSON.parse(walletJson))],
  [walletDoc, applyDocSections(readFileSync(walletDoc, 'utf8'))]);
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
