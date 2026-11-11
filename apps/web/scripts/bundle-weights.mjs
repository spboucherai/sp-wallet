// What weighs in the web bundle, by source file (minified bytes): `node apps/web/scripts/bundle-weights.mjs [entry] [top]`.
// esbuild with a metafile, production defines (the dev-only mocks are removed, as in the Vite build), no splitting: the
// figure is each module's share of everything reachable from the entry — used in the v10 performance pass to decide what
// leaves the first chunk. Nothing is written.
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), entry = process.argv[2] ?? 'src/main.tsx', top = Number(process.argv[3] ?? 30);
const r = await build({ entryPoints: [resolve(root, entry)], bundle: true, write: false, minify: true, metafile: true, format: 'esm', target: 'es2022', jsx: 'automatic', outdir: '/tmp/unused',
  define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true', 'process.env.NODE_ENV': '"production"' }, loader: { '.svg': 'text', '.png': 'base64', '.webp': 'base64', '.css': 'empty' }, logLevel: 'silent',
  plugins: [{ name: 'raw', setup(b) { b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: resolve(a.resolveDir, a.path.replace(/\?raw$/, '')), namespace: 'raw' })); b.onLoad({ filter: /.*/, namespace: 'raw' }, () => ({ contents: '', loader: 'text' })); } }] });
const out = Object.values(r.metafile.outputs)[0], rows = Object.entries(out.inputs).map(([f, v]) => [f.replace(/^.*node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?/, 'npm:').replace(/^(npm:(?:@[^/]+\/)?[^/]+).*/, '$1').replace(/^.*apps\/web\//, '').replace(/^.*packages\//, 'packages/'), v.bytesInOutput]);
const by = new Map(); for (const [f, n] of rows) by.set(f, (by.get(f) ?? 0) + n);
const total = out.bytes; console.log(`total ${(total / 1024).toFixed(0)} kB minified (everything reachable from ${entry}, one file)`);
for (const [f, n] of [...by].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${String((n / 1024).toFixed(1)).padStart(8)} kB  ${((100 * n) / total).toFixed(1).padStart(5)} %  ${f}`);
