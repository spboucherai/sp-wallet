import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build as esbuild } from 'esbuild';
import { defineConfig, type Plugin } from 'vite';
import { checkIcons } from './scripts/gen-icons.mts';

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

export default defineConfig({
  plugins: [iconsCheck(), react(), tailwindcss(), serviceWorker()],
  build: { outDir: '../../dist/web', emptyOutDir: true, sourcemap: false, assetsInlineLimit: 0, modulePreload: { polyfill: false } },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8650' } },
});
