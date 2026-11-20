import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build as esbuild } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { checkIcons } from './scripts/gen-icons.mts';
import { i18nTables } from './scripts/i18n-split.mts';

// v6-alerts: the service worker (src/sw.ts) is bundled on its own into ONE classic script at the root of the site, /sw.js —
// no hash in its name (the browser re-checks that URL), no import (a classic worker runs everywhere push exists), scope "/".
const sw = async (minify: boolean): Promise<string> =>
  (await esbuild({ entryPoints: ['src/sw.ts'], bundle: true, write: false, format: 'iife', target: 'es2020', minify, legalComments: 'none' })).outputFiles[0]!.text;
const serviceWorker = (): Plugin => ({
  name: 'spw-service-worker',
  async generateBundle() { this.emitFile({ type: 'asset', fileName: 'sw.js', source: await sw(true) }); },
  configureServer(server) {
    server.middlewares.use('/sw.js', (_req, res) => { void sw(false).then((code) => { res.setHeader('content-type', 'text/javascript'); res.setHeader('cache-control', 'no-cache'); res.end(code); }, (e: Error) => { res.statusCode = 500; res.end(e.message); }); });
  },
});

// v9: a build never ships a registry asset or network without its logo (or a declared fallback), nor an SVG that is not sanitised
const iconsCheck = (): Plugin => ({ name: 'spw-icons-check', apply: 'build', buildStart() { const errors = checkIcons(); if (errors.length) throw new Error(`icons:\n  ${errors.join('\n  ')}`); } });

// v10 performance pass: one language at a time. `src/i18n.ts` keeps both languages side by side in `D` (370 kB); here the
// literal is taken out of the app's chunk and written as two tables, `virtual:spw-i18n-fr` / `-en`, each its own chunk
// (src/i18n-load.ts). Dev server and build do the same. The literal must be plain data — `key: ['français', 'English']` —
// and a key without its two non-empty strings stops the build.
const I18N_FILE = fileURLToPath(new URL('./src/i18n.ts', import.meta.url));
const i18nSplit = (): Plugin => {
  const read = () => i18nTables(readFileSync(I18N_FILE, 'utf8'));
  return {
    name: 'spw-i18n-split', enforce: 'pre',
    resolveId(id) { return id === 'virtual:spw-i18n-fr' || id === 'virtual:spw-i18n-en' ? `\0${id}` : null; },
    load(id) {
      if (id !== '\0virtual:spw-i18n-fr' && id !== '\0virtual:spw-i18n-en') return null;
      this.addWatchFile(I18N_FILE);
      return `export default ${JSON.stringify(read()[id.endsWith('fr') ? 'fr' : 'en'])};`;
    },
    transform(code, id) { return id.split('?')[0] === I18N_FILE ? { code: i18nTables(code).stripped, map: null } : null; },
    handleHotUpdate({ file, server }) {
      if (file !== I18N_FILE) return;
      for (const v of ['\0virtual:spw-i18n-fr', '\0virtual:spw-i18n-en']) { const m = server.moduleGraph.getModuleById(v); if (m) server.moduleGraph.invalidateModule(m); }
      server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
};

// NEXT W5: the version shown in Settings is the build's own — the package version and the short commit (`SPW_COMMIT` when the
// build runs outside a git checkout, e.g. from an archive on a node; « nogit » when neither is known). Read by src/version.ts.
const pkgVersion = (JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')) as { version: string }).version;
const commit = (): string => {
  const env = (process.env.SPW_COMMIT ?? '').trim(); if (/^[0-9a-f]{7,40}$/i.test(env)) return env.slice(0, 7);
  try { return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'nogit'; } catch { return 'nogit'; }
};

export default defineConfig({
  define: { __SPW_VERSION__: JSON.stringify(`${pkgVersion} (${commit()})`) },
  plugins: [i18nSplit(), iconsCheck(), react(), tailwindcss(), serviceWorker()],
  build: { outDir: '../../dist/web', emptyOutDir: true, sourcemap: false, assetsInlineLimit: 0, modulePreload: { polyfill: false } },
  // v11 live quotes: `ws: true` so that the dev server also proxies the websocket of the quote engine (/api/v1/stream)
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:8650', ws: true } } },
});
