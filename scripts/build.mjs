// Bundle each service into a single ESM file (no node_modules needed at runtime).
import { build } from 'esbuild';
const banner = { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" };
for (const [entry, out] of [['services/api/src/main.ts', 'dist/api.mjs'], ['services/isolated-signer/src/main.ts', 'dist/signer.mjs']])
  await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', target: 'node24', format: 'esm', banner, legalComments: 'none', logLevel: 'info' });
