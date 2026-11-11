// Bundle each service into a single ESM file (no node_modules needed at runtime).
import { execSync } from 'node:child_process';
import { build } from 'esbuild';
// v6-alerts: the commit shown on the monitoring screen (SPW_COMMIT wins; empty when the build is not made from a git checkout)
let commit = process.env.SPW_COMMIT ?? '';
if (!commit) { try { commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a checkout */ } }
const define = { __SPW_COMMIT__: JSON.stringify(commit) };
const banner = { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" };
for (const [entry, out] of [['services/api/src/main.ts', 'dist/api.mjs'], ['services/isolated-signer/src/main.ts', 'dist/signer.mjs'],
  ['services/research-runner/src/main.ts', 'dist/research-runner.mjs']]) // v7: the research runner, a standalone bundle for a research node
  await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', target: 'node24', format: 'esm', banner, define, legalComments: 'none', logLevel: 'info' });
