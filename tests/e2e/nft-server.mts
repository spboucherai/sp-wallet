// Backend for nft.spec.ts — one process: the REAL API (source, through tsx) with the BUILT web bundle and a real isolated signer
// (throwaway keystore: the wallet of this stack holds nothing and never signs here), own PostgreSQL database, broadcast off,
// workers off. The NFT module is the production one — real Solana / EVM providers reading the public endpoints, real resolver
// and media proxy — plus ONE scripted chain, `testnet`, whose assets point at hostile documents served by a scripted world
// under *.e2e.example (no such host exists: nothing leaves the machine for them). Read-only like the feature itself.
//
//   node scripts/build.mjs && (cd apps/web && node_modules/.bin/vite build)
//   npx tsx tests/e2e/nft-server.mts --port 8870          → prints READY; SPW_DEV_DIR=/tmp/spw-nft-e2e-8870
//   SPW_E2E_BASE=http://localhost:8870 SPW_DEV_DIR=/tmp/spw-nft-e2e-8870 pnpm e2e nft.spec.ts
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1]! : d; };
const ROOT = resolve(new URL('../..', import.meta.url).pathname), port = Number(arg('port', '8870')), db = arg('db', `spw_dev_nft_e2e_${port}`), dir = `/tmp/spw-nft-e2e-${port}`;
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const secret = randomBytes(32).toString('hex');
const signerEnv = { ...process.env, SPW_SIGNER_DIR: `${dir}/signer`, SPW_SIGNER_WRAP_KEY: `${dir}/wrap/wrap.key`, SPW_SIGNER_SECRET: secret, SPW_ORIGIN: `http://localhost:${port}`, SPW_RP_ID: 'localhost', SPW_SIGNER_PORT: String(port + 1) };
execFileSync('node', [`${ROOT}/dist/signer.mjs`, 'init'], { env: signerEnv, stdio: 'ignore' });
writeFileSync(`${dir}/setup-token`, execFileSync('node', [`${ROOT}/dist/signer.mjs`, 'setup-token'], { env: signerEnv }));
const signer = spawn('node', [`${ROOT}/dist/signer.mjs`, 'serve'], { env: signerEnv, stdio: 'ignore' });
try { execFileSync('createdb', [db], { stdio: 'ignore' }); } catch { /* exists */ }
execFileSync('psql', ['-q', '-d', db, '-c', 'drop schema public cascade; create schema public;'], { stdio: 'ignore' });
Object.assign(process.env, { SPW_ORIGIN: `http://localhost:${port}`, SPW_RP_ID: 'localhost', PORT: String(port), DATABASE_URL: `postgres:///${db}`, SPW_SIGNER_URL: `http://127.0.0.1:${port + 1}`, SPW_SIGNER_SECRET: secret, SPW_WEB_DIR: `${ROOT}/dist/web`, SPW_BROADCAST: 'off', SPW_WORKERS: 'off', NFT_CACHE_DIR: `${dir}/media` });

const { NETWORKS } = await import('@spw/core');
const { migrate } = await import('../../services/api/src/db.ts');
const { buildServer } = await import('../../services/api/src/server.ts');
const { nftConfig } = await import('../../services/api/src/nft/config.ts');
const { solanaProvider } = await import('../../services/api/src/nft/solana.ts');
const { evmProvider } = await import('../../services/api/src/nft/evm.ts');
const { buildAsset, emptyMetadata } = await import('../../services/api/src/nft/provider.ts');
const { defaultFetchDeps } = await import('../../services/api/src/nft/safe-fetch.ts');
const { rpcOne } = await import('../../services/api/src/chains/rpc.ts');
const { known, NONE, UNSUPPORTED, NftProviderError } = await import('../../packages/nft/src/index.ts');

// ── the hostile documents ───────────────────────────────────────────────────────────────────────────────────────────────
const enc = (s: string) => new TextEncoder().encode(s), H = 'https://evil.e2e.example';
const PAGE = `<!doctype html><html><body><h1 id="art">art</h1><p id="js">no-js</p><p id="net">net-untested</p><p id="parent">parent-untested</p>
<script>document.getElementById('js').textContent='js-ran';
try{ parent.document.title='PWNED'; document.getElementById('parent').textContent='parent-reached'; }catch(e){ document.getElementById('parent').textContent='parent-blocked'; }
try{ top.location='https://phish.e2e.example/'; }catch(e){}
fetch('/api/v1/portfolio',{credentials:'include'}).then(function(r){document.getElementById('net').textContent='net-reached-'+r.status;},function(){document.getElementById('net').textContent='net-blocked';});
try{ alert('xss'); }catch(e){}</script></body></html>`;
const pages: Record<string, { type: string; body: Uint8Array }> = {
  [`${H}/meta.json`]: { type: 'application/json', body: enc(JSON.stringify({ name: '<img src=x onerror="document.title=\'PWNED\'">', description: '<script>document.title="PWNED"</script>\nsecond line', external_url: 'javascript:document.title="PWNED"', image: `${H}/pic.svg`, animation_url: `${H}/page.html`,
    attributes: [{ trait_type: '<b>Bold</b>', value: '"><svg onload="document.title=\'PWNED\'">' }, 'loose'], properties: { files: [{ uri: `${H}/fake.png`, type: 'image/png' }, { uri: 'http://169.254.169.254/latest/meta-data/', type: 'image/png' }, { uri: 'https://10.0.0.5/internal.png', type: 'image/png' }] } })) },
  [`${H}/page.html`]: { type: 'text/html', body: enc(PAGE) },
  [`${H}/pic.svg`]: { type: 'image/svg+xml', body: enc('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="document.title=\'PWNED\'"><script>document.title="PWNED"</script><circle cx="5" cy="5" r="4" fill="#3355ff"/></svg>') },
  [`${H}/fake.png`]: { type: 'image/png', body: enc('<html><script>document.title="PWNED"</script></html>') },
};
const fetchDeps = {
  resolve: async (host: string) => (host.endsWith('.e2e.example') ? [{ address: '93.184.216.34', family: 4 as const }] : defaultFetchDeps.resolve(host)),
  transport: async (req: Parameters<typeof defaultFetchDeps.transport>[0]) => { if (!req.url.hostname.endsWith('.e2e.example')) return defaultFetchDeps.transport(req); const p = pages[req.url.href];
    return p ? { status: 200, headers: { 'content-type': p.type }, body: p.body, truncated: false } : { status: 404, headers: {}, body: new Uint8Array(), truncated: false }; },
  now: Date.now,
};
const now = () => new Date();
const stamp = () => ({ category: 'onchain' as const, source: 'test-chain', detail: 'scripted (e2e)', fetchedAt: now().toISOString(), confidence: 'chain_single_source' as const, freshness: 'fresh' as const, covers: ['ownership' as const] });
const hostile = { id: 'test', family: 'test', chains: () => ['testnet'], inventory: async () => ({ assets: [], sections: [] }), events: async () => ({ events: [], cursor: null, completeness: 'unavailable' as const, note: null }), collection: async () => { throw new NftProviderError('not_found', 'test-chain'); },
  lookup: async (_c: string, ref: { address: string }) => { const id = ref.address.replace(/_+$/, ''); if (id !== 'hostile') throw new NftProviderError('not_found', 'test-chain');
    const s = stamp(); return buildAsset({ family: 'test', chainId: 'testnet', assetId: id, key: `test:testnet:${id}`, standard: 'unknown', ownerAddress: null, quantity: '1', metadata: emptyMetadata(`${H}/meta.json`), sources: [s], fetchedAt: s.fetchedAt, origin: 'lookup', explorerUrl: null,
      ownership: { state: 'not_in_wallet', owner: known('someone-else'), tokenAccount: UNSUPPORTED, frozen: UNSUPPORTED, delegate: NONE, tokenRecordState: UNSUPPORTED, heldByWallet: false, source: s } }); } };

await migrate();
const cfg = nftConfig(), rpc = (url: string, method: string, params: unknown) => rpcOne<unknown>(url, method, params as unknown[]);
const app = await buildServer({ nft: { cfg, fetch: fetchDeps, providers: [solanaProvider({ rpc, now, dasUrl: cfg.solanaDasUrl }), evmProvider({ rpc, now, indexers: cfg.evmIndexers, http: fetch }), hostile] as never } });
(NETWORKS as Record<string, unknown>).testnet = { id: 'testnet', family: 'test', name: 'Test chain (e2e)', chainRef: 'x', native: { id: 'native', symbol: 'T', name: 'T', decimals: 0 }, tokens: [], rpc: [], explorerTx: '', explorerAddr: '', minConf: 1 };
await app.listen({ port, host: '127.0.0.1' });
console.log(`READY http://localhost:${port} SPW_DEV_DIR=${dir}`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { signer.kill(); void app.close().finally(() => process.exit(0)); });
