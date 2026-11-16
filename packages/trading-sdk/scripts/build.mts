// Builds dist/: one ESM bundle (esbuild; the SDK has no dependency to bundle) and the type declarations (tsc).
//   node packages/trading-sdk/scripts/build.mts
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
rmSync(path.join(PKG, 'dist'), { recursive: true, force: true });
await build({ entryPoints: [path.join(PKG, 'src/index.ts')], outfile: path.join(PKG, 'dist/index.js'), bundle: true, platform: 'neutral', target: 'es2022', format: 'esm', legalComments: 'none', logLevel: 'warning' });
execFileSync(path.resolve(PKG, '../../node_modules/.bin/tsc'), ['-p', path.join(PKG, 'tsconfig.build.json')], { stdio: 'inherit' });
// the sources import './x.ts' (repo convention); published declarations must name the emitted modules
for (const f of readdirSync(path.join(PKG, 'dist'), { recursive: true, encoding: 'utf8' })) {
  if (!f.endsWith('.d.ts')) continue;
  const p = path.join(PKG, 'dist', f);
  writeFileSync(p, readFileSync(p, 'utf8').replace(/(from\s+['"]\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1.js$2'));
}
console.log('built packages/trading-sdk/dist (index.js + *.d.ts)');
