import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build as esbuild } from 'esbuild';
import { defineConfig, type Plugin } from 'vite';

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

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker()],
  build: { outDir: '../../dist/web', emptyOutDir: true, sourcemap: false, assetsInlineLimit: 0, modulePreload: { polyfill: false } },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8650' } },
});
