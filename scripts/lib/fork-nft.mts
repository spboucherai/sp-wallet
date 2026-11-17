// Shared harness of the two NFT fork proofs (scripts/fork-nft-erc721.mts, fork-nft-erc1155.mts): a LOCAL anvil fork of Ethereum
// mainnet, the real API (HTTP layer, session, CSRF, NFT module with its real providers and resolver, the proposal lifecycle and
// the worker's reconcile loop), the real signer behind its real HTTP boundary (HMAC), a software passkey, a throw-away key.
// NOTHING reaches a real network: every write goes to the fork; the upstream RPC is only read by anvil.
// A fork is not a mainnet execution: gas prices, mempool, MEV and the finality of the real chain are not exercised.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { numberToHex, parseUnits } from 'viem';
import { TestPasskey } from '../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../services/isolated-signer/src/keys.ts';
import { createSignerServer } from '../../services/isolated-signer/src/server.ts';
import { Signer } from '../../services/isolated-signer/src/signer.ts';
import { Store } from '../../services/isolated-signer/src/store.ts';

export const ORIGIN = 'https://wallet.test', RP = 'wallet.test';
export interface ForkStack {
  me: string; fork: string; rpc: <T>(method: string, params?: unknown[]) => Promise<T>;
  api: (method: string, url: string, body?: unknown, idem?: string) => Promise<{ status: number; json: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  pk: TestPasskey; signer: Signer; store: Store; sql: any; settle: (id: string) => Promise<any>; impersonate: (from: string, to: string, data: string) => Promise<void>; close: () => Promise<void>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function startForkStack(o: { port: number; db: string; broadcast?: 'on' | 'off'; upstream?: string }): Promise<ForkStack> {
  const fork = `http://127.0.0.1:${o.port}`, SECRET = 'f'.repeat(48);
  const keys = deriveKeys(generateMnemonic(wordlist, 128)), me = keys.addresses.evm;
  let rid = 0;
  const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => { const r = await fetch(fork, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) });
    const j = (await r.json()) as { result?: T; error?: { message: string } }; if (j.error) throw new Error(j.error.message); return j.result as T; };
  const anvil: ChildProcess = spawn('anvil', ['--fork-url', o.upstream ?? process.env.ETH_RPC ?? 'https://ethereum-rpc.publicnode.com', '--port', String(o.port), '--chain-id', '1', '--silent'], { stdio: 'ignore' });
  let signerSrv: Server | undefined, app: any, sql: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const close = async () => { anvil.kill(); signerSrv?.close(); await app?.close().catch(() => {}); await sql?.end().catch(() => {}); };
  try {
    let up = false;
    for (let k = 0; k < 120 && !up; k++) { try { await rpc('eth_chainId'); up = true; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    if (!up) throw new Error('anvil did not start (is another fork running on this port?)');
    await rpc('anvil_setBalance', [me, numberToHex(parseUnits('1', 18))]);
    const dir = mkdtempSync(join(tmpdir(), 'spw-fork-nft-'));
    const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
    store.state.setupTokenHash = createHash('sha256').update('fork-setup').digest('hex');
    const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN });
    signerSrv = createSignerServer(signer, SECRET).listen(0, '127.0.0.1');
    await new Promise((r) => signerSrv!.once('listening', r));
    Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, DATABASE_URL: `postgres:///${o.db}`, SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`,
      SPW_BROADCAST: o.broadcast ?? 'on', SPW_WORKERS: 'off', SPW_RPC_OVERRIDE: JSON.stringify({ ethereum: [fork, fork] }), NFT_CACHE_DIR: join(dir, 'media') });
    const db = await import('../../services/api/src/db.ts'); sql = db.sql;
    await sql.unsafe('drop schema public cascade; create schema public;'); await db.migrate();
    app = await (await import('../../services/api/src/server.ts')).buildServer({ swapProviders: [], nft: { autoSync: false } });
    const worker = await import('../../services/api/src/worker.ts');
    await worker.refreshHealth();
    const pk = new TestPasskey(RP, ORIGIN); let cookie = '';
    const api = async (method: string, url: string, body?: unknown, idem?: string) => { const r = await app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
      if (r.headers['set-cookie']) cookie = String(r.headers['set-cookie']).split(';')[0]!;
      return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() }; };
    const so = (await api('POST', '/api/v1/auth/setup/options', {})).json;
    const s = await api('POST', '/api/v1/auth/setup/verify', { challengeId: so.challengeId, response: pk.register(so.options.challenge), setupToken: 'fork-setup' });
    if (s.status !== 200) throw new Error(`setup failed: ${JSON.stringify(s.json)}`);
    const settle = async (id: string) => { for (let k = 0; k < 120; k++) { await worker.reconcile(); await rpc('anvil_mine', [numberToHex(3)]); const p = (await api('GET', `/api/v1/nfts/transfer/${id}`)).json;
      if (['finalized', 'failed', 'replaced', 'expired', 'not_broadcast'].includes(p.state)) return p; await new Promise((r) => setTimeout(r, 300)); } throw new Error('the transfer did not settle'); };
    const impersonate = async (from: string, to: string, data: string) => { await rpc('anvil_impersonateAccount', [from]); await rpc('anvil_setBalance', [from, numberToHex(parseUnits('1', 18))]);
      const h = await rpc<string>('eth_sendTransaction', [{ from, to, data, gas: numberToHex(400_000) }]); await rpc('anvil_mine', [numberToHex(1)]); await rpc('anvil_stopImpersonatingAccount', [from]);
      const rc = await rpc<{ status: string } | null>('eth_getTransactionReceipt', [h]); if (!rc || rc.status !== '0x1') throw new Error('the funding transaction of the fork reverted'); };
    return { me, fork, rpc, api, pk, signer, store, sql, settle, impersonate, close };
  } catch (e) { await close(); throw e; }
}
export const expectStatus = (label: string, r: { status: number; json: any }, status: number, code?: string): void => { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (r.status !== status || (code && r.json?.error !== code)) throw new Error(`${label}: expected ${status}${code ? ` ${code}` : ''}, got ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
};
