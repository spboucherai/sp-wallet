// Backend for nft-send.spec.ts (NFT delivery 2) — one process: the REAL API (source, through tsx) with the BUILT web bundle and
// a real isolated signer process (throwaway keystore), own PostgreSQL database. Two chains are local, so that a transfer can be
// approved and followed to finality without touching a real network:
//
//   Ethereum → a LOCAL anvil FORK of mainnet (port + 10). The current holders of BAYC #1 and #2 (read on the fork) are
//              impersonated to hand them to this stack's wallet; broadcasting is ON and goes to the fork only. A small loop
//              runs the worker's `reconcile` and mines blocks (workers are otherwise off).
//   Bitcoin  → a scripted Esplora (port + 11 and port + 12, the two "independent indexers") that answers three confirmed
//              outputs for the wallet's address: 60 000, 9 000 and 546 sat. Nothing is ever broadcast there.
//
// Every other network keeps its real public endpoints, READ-ONLY (as in nft-server.mts). A fork is not a mainnet execution.
//
//   node scripts/build.mjs && (cd apps/web && node_modules/.bin/vite build)
//   pkill -f anvil; sleep 3; npx tsx tests/e2e/nft-send-server.mts --port 8880      → prints READY; SPW_DEV_DIR=/tmp/spw-nft-send-e2e-8880
//   SPW_E2E_BASE=http://localhost:8880 SPW_DEV_DIR=/tmp/spw-nft-send-e2e-8880 pnpm e2e nft-send.spec.ts
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { encodeFunctionData, erc721Abi, getAddress, numberToHex, parseUnits } from 'viem';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1]! : d; };
const ROOT = resolve(new URL('../..', import.meta.url).pathname), port = Number(arg('port', '8880')), db = arg('db', `spw_dev_nft_send_e2e_${port}`), dir = `/tmp/spw-nft-send-e2e-${port}`;
const FORK = `http://127.0.0.1:${port + 10}`, BAYC = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const secret = randomBytes(32).toString('hex');
const signerEnv = { ...process.env, SPW_SIGNER_DIR: `${dir}/signer`, SPW_SIGNER_WRAP_KEY: `${dir}/wrap/wrap.key`, SPW_SIGNER_SECRET: secret, SPW_ORIGIN: `http://localhost:${port}`, SPW_RP_ID: 'localhost', SPW_SIGNER_PORT: String(port + 1) };
execFileSync('node', [`${ROOT}/dist/signer.mjs`, 'init'], { env: signerEnv, stdio: 'ignore' });
writeFileSync(`${dir}/setup-token`, execFileSync('node', [`${ROOT}/dist/signer.mjs`, 'setup-token'], { env: signerEnv }));
const signerProc = spawn('node', [`${ROOT}/dist/signer.mjs`, 'serve'], { env: signerEnv, stdio: 'ignore' });
const anvil = spawn('anvil', ['--fork-url', process.env.ETH_RPC ?? 'https://ethereum-rpc.publicnode.com', '--port', String(port + 10), '--chain-id', '1', '--silent'], { stdio: 'ignore' });
try { execFileSync('createdb', [db], { stdio: 'ignore' }); } catch { /* exists */ }
execFileSync('psql', ['-q', '-d', db, '-c', 'drop schema public cascade; create schema public;'], { stdio: 'ignore' });

// ── the scripted Esplora (Bitcoin) ───────────────────────────────────────────────────────────────────────────────────────
const { NETWORKS } = await import('@spw/core');
const T = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const COINS = [{ txid: T(0xa1), vout: 0, value: 60_000 }, { txid: T(0xa2), vout: 1, value: 9_000 }, { txid: T(0xa3), vout: 0, value: 546 }];
const esplora = createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x'), send = (body: unknown, type = 'application/json') => { res.writeHead(200, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (u.pathname === '/blocks/tip/height') return send('900000', 'text/plain');
  if (/^\/block-height\/\d+$/.test(u.pathname)) return send(NETWORKS.bitcoin.chainRef, 'text/plain');
  if (/^\/address\/[^/]+\/utxo$/.test(u.pathname)) return send(COINS.map((c) => ({ ...c, status: { confirmed: true, block_height: 899_000 } })));
  if (/^\/address\/[^/]+\/txs$/.test(u.pathname)) return send([]);
  if (/^\/address\/[^/]+$/.test(u.pathname)) return send({ chain_stats: { funded_txo_sum: 69_546, spent_txo_sum: 0 }, mempool_stats: { spent_txo_sum: 0 } });
  if (u.pathname === '/fee-estimates') return send({ 3: 2, 6: 2 });
  if (/^\/tx\/[0-9a-f]{64}\/hex$/.test(u.pathname)) return send('0200000001' + '00'.repeat(60), 'text/plain'); // no inscription envelope in it
  res.writeHead(404); res.end('not found');
});
await new Promise<void>((r) => esplora.listen(port + 11, '127.0.0.1', r));
const esplora2 = createServer((req, res) => esplora.emit('request', req, res));
await new Promise<void>((r) => esplora2.listen(port + 12, '127.0.0.1', r));

Object.assign(process.env, { SPW_ORIGIN: `http://localhost:${port}`, SPW_RP_ID: 'localhost', PORT: String(port), DATABASE_URL: `postgres:///${db}`, SPW_SIGNER_URL: `http://127.0.0.1:${port + 1}`, SPW_SIGNER_SECRET: secret, SPW_WEB_DIR: `${ROOT}/dist/web`,
  SPW_BROADCAST: 'on', SPW_WORKERS: 'off', NFT_CACHE_DIR: `${dir}/media`, SPW_RPC_OVERRIDE: JSON.stringify({ ethereum: [FORK, FORK], bitcoin: [`http://127.0.0.1:${port + 11}`, `http://127.0.0.1:${port + 12}`] }) });
let rid = 0;
const fork = async <T>(method: string, params: unknown[] = []): Promise<T> => { const r = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) }); const j = (await r.json()) as { result?: T; error?: { message: string } }; if (j.error) throw new Error(j.error.message); return j.result as T; };
let up = false;
for (let k = 0; k < 160 && !up; k++) { try { await fork('eth_chainId'); up = true; } catch { await new Promise((r) => setTimeout(r, 250)); } }
if (!up) { console.error('anvil did not start'); process.exit(1); }

const { migrate } = await import('../../services/api/src/db.ts');
const { buildServer } = await import('../../services/api/src/server.ts');
await migrate();
const app = await buildServer({ swapProviders: [], nft: { autoSync: false } });
const worker = await import('../../services/api/src/worker.ts');
const { signer } = await import('../../services/api/src/signer-client.ts');
let st = null as Awaited<ReturnType<typeof signer.status>> | null;
for (let k = 0; k < 60 && !st; k++) { st = await signer.status(true).catch(() => null); if (!st) await new Promise((r) => setTimeout(r, 250)); }
if (!st) { console.error('the signer did not answer'); process.exit(1); }
const ME = st.addresses.ethereum!;
// the fork: gas for the wallet, and BAYC #1 and #2 handed over by whoever holds them now
await fork('anvil_setBalance', [ME, numberToHex(parseUnits('1', 18))]);
for (const id of [1n, 2n]) {
  const holder = getAddress(`0x${(await fork<string>('eth_call', [{ to: BAYC, data: encodeFunctionData({ abi: erc721Abi, functionName: 'ownerOf', args: [id] }) }, 'latest'])).slice(26)}`);
  await fork('anvil_impersonateAccount', [holder]); await fork('anvil_setBalance', [holder, numberToHex(parseUnits('1', 18))]);
  await fork('eth_sendTransaction', [{ from: holder, to: BAYC, gas: numberToHex(300_000), data: encodeFunctionData({ abi: erc721Abi, functionName: 'transferFrom', args: [holder as `0x${string}`, ME as `0x${string}`, id] }) }]);
  await fork('anvil_mine', [numberToHex(1)]); await fork('anvil_stopImpersonatingAccount', [holder]);
}
await worker.refreshHealth(); // chain identities (the fork answers chain id 1; the scripted Esplora answers the Bitcoin genesis reference)
// the worker's reconcile loop, and blocks on the fork so that a broadcast transfer reaches finality
const tick = setInterval(() => { void worker.reconcile().catch(() => {}).then(() => fork('anvil_mine', [numberToHex(40)]).catch(() => {})); }, 1500);
await app.listen({ port, host: '127.0.0.1' });
console.log(`READY http://localhost:${port} SPW_DEV_DIR=${dir} wallet=${ME} btc=${st.addresses.bitcoin}`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { clearInterval(tick); signerProc.kill(); anvil.kill(); esplora.close(); esplora2.close(); void app.close().finally(() => process.exit(0)); });
