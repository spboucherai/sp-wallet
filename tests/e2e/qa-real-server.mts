/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : tests/e2e/qa-real-server.mts
 * Module           : tests
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-17
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// The REAL backend for qa-real.spec.ts and for manual QA passes, booted in one process on its OWN port and scratch database
// (nothing is shared with scripts/dev-stack.sh): the real API server with the real swap/bridge providers, the real
// isolated-signer class behind its real HMAC channel, PostgreSQL (database dropped and recreated) and the built web bundle.
// Modelled on tests/e2e/live-real-server.mts.
//
// KEYS. The wallet seed is a fresh BIP-39 phrase generated IN MEMORY; never printed, never written, gone with the process.
// No existing key, seed or secrets file is read. The signer's state goes to a temporary directory.
//
// NETWORK. Public reads only (RPC nodes, price feeds, quotes, exchanges' public data). SPW_BROADCAST is forced off, and on
// top of it every outgoing request is inspected here: a JSON-RPC call that would relay a signed transaction, and any request
// to Hyperliquid's MAINNET exchange endpoint, is refused before it leaves the process.
//
//   npx tsx tests/e2e/qa-real-server.mts --port 8690 --db spw_qa_polish [--workers on] [--fork base,arbitrum] [--traffic file.json]
//
// `--fork base,arbitrum` (needs anvil) points those networks at LOCAL forks and gives the throwaway wallet 0.05 ETH on each
// and 250 USDC on Base, so the funded flows (send review, swap review, CCTP review, agent gas reserve) can be walked up to
// the passkey. They are private chains on 127.0.0.1: nothing on them exists anywhere else, and broadcasting stays off all
// the same. Fork RPC ports are the web port + 1, + 2…; `anvil_*` methods there are how a test funds an agent's vault.
//
// The forks run as `spw-qa-fork` processes (not `anvil`): `pkill -f anvil` between fork proofs does not touch them. If this
// server is killed with SIGKILL they stay behind: `pkill -f spw-qa-fork`.
//
// `--workers on` starts what main.ts starts (health, reconciliation, market data, paper derivatives, agent engine), so
// backtests find candles and paper agents trade by themselves.
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { deriveKeys } from '../../services/isolated-signer/src/keys.ts';
import { exchangePrices } from '../../services/isolated-signer/src/prices.ts';
import { createSignerServer } from '../../services/isolated-signer/src/server.ts';
import { dealTokenRpc } from '../../scripts/lib/fork-helpers.mts';
import { Signer } from '../../services/isolated-signer/src/signer.ts';
import { Store } from '../../services/isolated-signer/src/store.ts';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1]! : d; };
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(arg('port', '8690')), DB = arg('db', 'spw_qa_polish'), TRAFFIC = arg('traffic', ''), SETUP_TOKEN = arg('setup-token', 'qa-setup-token'), WORKERS = arg('workers', 'off') === 'on';
const FORK = arg('fork', '');
const ORIGIN = `http://localhost:${PORT}`, RP = 'localhost', SECRET = 'q'.repeat(48);
if (!/^[a-z_0-9]+$/.test(DB)) throw new Error('bad database name');
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamilyAttemptTimeout(2500);

// ── the guard: nothing signed may leave this process ─────────────────────────────────────────────────────────────────────
const SEND = /"(eth_sendRawTransaction|eth_sendTransaction|sendTransaction|sendrawtransaction|broadcast_tx_(sync|async|commit)|submit)"/;
const realFetch = globalThis.fetch, traffic: Record<string, number> = {};
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const refuse = (why: string) => { traffic[`REFUSED ${u.host} ${why}`] = (traffic[`REFUSED ${u.host} ${why}`] ?? 0) + 1; throw new Error(`QA stack: refusing ${why} to ${u.host}`); };
  if (u.host === 'api.hyperliquid.xyz' && u.pathname !== '/info') refuse(`a Hyperliquid MAINNET ${u.pathname} request`);
  if (typeof init?.body === 'string' && u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && SEND.test(init.body) && /"method"/.test(init.body)) refuse('a transaction broadcast');
  traffic[u.host] = (traffic[u.host] ?? 0) + 1;
  return realFetch(input, init);
}) as typeof fetch;
delete process.env.SPW_DERIV_LIVE_MAINNET;
if (TRAFFIC) setInterval(() => { try { writeFileSync(TRAFFIC, JSON.stringify(traffic, null, 1)); } catch { /* the directory may not exist yet */ } }, 2000).unref();

const keys = deriveKeys(generateMnemonic(wordlist, 128));                                             // throwaway seed, in memory only
let signerSrv: Server | undefined, app: { close: () => Promise<void>; listen: (o: { port: number; host: string }) => Promise<string>; server: { closeAllConnections?: () => void } } | undefined;
const forks: ChildProcess[] = [];
let stopping = false;
const stop = async () => { stopping = true; for (const f of forks) f.kill(); signerSrv?.close(); app?.server.closeAllConnections?.(); await app?.close().catch(() => {}); process.exit(0); };
process.on('SIGTERM', () => void stop()); process.on('SIGINT', () => void stop());

execSync(`dropdb --if-exists ${DB} && createdb ${DB}`);
rmSync(join(tmpdir(), 'spw-qa', `passkey-${PORT}.json`), { force: true });                           // a fresh stack: the virtual passkey of the previous one is void
const dir = mkdtempSync(join(tmpdir(), 'spw-qa-'));
const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
store.state.setupTokenHash = createHash('sha256').update(SETUP_TOKEN).digest('hex');
if (FORK) {
  // per network: public RPC to fork from, chain id, and (Base only) the USDC contract + a holder to take 250 USDC from, on the fork
  const DEF: Record<string, { rpc: string; chain: number; usdc?: string }> = { base: { rpc: process.env.BASE_RPC ?? 'https://mainnet.base.org', chain: 8453, usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }, arbitrum: { rpc: process.env.ARBITRUM_RPC ?? 'https://arb1.arbitrum.io/rpc', chain: 42161 } };
  const WHALE = process.env.USDC_WHALE ?? '0xF977814e90dA44bFA03b6295A0616a897441aceC', override: Record<string, string[]> = {}, maxFee: Record<string, string> = {};
  const me = keys.addresses.evm, pad = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  for (const [k, id] of FORK.split(',').entries()) {
    const d = DEF[id]; if (!d) throw new Error(`--fork supports ${Object.keys(DEF).join(', ')}`);
    const url = `http://127.0.0.1:${PORT + 1 + k}`;
    // v10 — two faults of this harness made the wallet look EMPTY on the page (no balance, no price change chip) while
    // /health/live still answered:
    //  1. the forks were plain `anvil` processes: the `pkill -f anvil` that the fork proofs (scripts/fork-*.mts) need between
    //     two runs — from this terminal or any other session on the machine — killed them, and nothing noticed. They now run
    //     under the process name `spw-qa-fork` (argv0), which that cleanup does not match, and if one of them exits while
    //     the stack is up the stack says so and stops (a test then fails on a refused connection, with the reason here).
    //  2. the fork followed the head of a public RPC: every first read of a slot went upstream, uncached, and was refused when
    //     the endpoint throttled. The block is pinned (anvil caches a pinned block on disk) and upstream errors are retried.
    const head = await realFetch(d.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) }).then((r) => r.json() as Promise<{ result?: string }>).catch(() => ({ result: undefined }));
    const pin = head.result ? ['--fork-block-number', String(Number(BigInt(head.result)) - 5)] : [];
    const child = spawn('anvil', ['--fork-url', d.rpc, ...pin, '--port', String(PORT + 1 + k), '--chain-id', String(d.chain), '--retries', '8', '--fork-retry-backoff', '400', '--timeout', '20000', '--silent'], { stdio: 'ignore', detached: true, argv0: 'spw-qa-fork' });
    child.on('exit', (code, signal) => { if (stopping) return; console.error(`\n*** QA stack: the local fork of ${id} (port ${PORT + 1 + k}) exited (code ${code}, signal ${signal}). Balances can no longer be read: stopping. Start a fresh stack. ***`); process.exit(1); });
    forks.push(child);
    let rid = 0;
    const rpc = async (method: string, params: unknown[] = []) => { const r = await realFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) }); const j = await r.json() as { result?: unknown; error?: { message: string } }; if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
    for (let n = 0; n < 160; n++) { try { await rpc('eth_chainId'); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    await rpc('anvil_setBalance', [me, '0x' + (5n * 10n ** 16n).toString(16)]);
    // 250 USDC on the local fork. Since the V11 final validation the balance is WRITTEN in the token's storage and read back through
    // balanceOf (scripts/lib/fork-helpers.mts dealTokenRpc); USDC_WHALE=<holder> still takes it from a holder by an (impersonated)
    // transfer, now checked. The unchecked transfer from a fixed holder failed silently once that address held nothing.
    if (d.usdc) {
      if (process.env.USDC_WHALE) { await rpc('anvil_impersonateAccount', [WHALE]); await rpc('anvil_setBalance', [WHALE, '0x' + (10n ** 18n).toString(16)]);
        await rpc('eth_sendTransaction', [{ from: WHALE, to: d.usdc, data: `0xa9059cbb${pad(me)}${(250_000000n).toString(16).padStart(64, '0')}` }]);
        await rpc('anvil_stopImpersonatingAccount', [WHALE]); }
      else await dealTokenRpc(rpc as never, d.usdc, me, 250_000000n, id);
      const got = BigInt(await rpc('eth_call', [{ to: d.usdc, data: `0x70a08231${pad(me)}` }, 'latest']) as string);
      if (got !== 250_000000n) throw new Error(`the throwaway wallet holds ${got} base units of USDC on the ${id} fork, 250000000 expected: the funding did not land`);
    }
    override[id] = [url, url]; maxFee[id] = '5000000000000000';
  }
  process.on('exit', () => { stopping = true; for (const f of forks) f.kill(); });
  process.env.SPW_RPC_OVERRIDE = JSON.stringify(override);
  // anvil reports a 1 gwei priority fee (far above the real one on these networks): raise the fee ceiling for the forks only
  store.policy = { ...store.policy, maxFee: { ...store.policy.maxFee, ...maxFee } };
}
const signerCore = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, undefined, exchangePrices());   // the signer's OWN prices (Coinbase + Kraken), as in production
signerSrv = createSignerServer(signerCore, SECRET).listen(0, '127.0.0.1');
await new Promise((r) => signerSrv!.once('listening', r));
Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, PORT: String(PORT), HOST: '127.0.0.1', DATABASE_URL: `postgres:///${DB}`, SPW_SIGNER_SECRET: SECRET,
  SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`, SPW_BROADCAST: 'off', SPW_WORKERS: WORKERS ? 'on' : 'off', SPW_WEB_DIR: resolve(ROOT, arg('web', 'dist/web')), SPW_RESEARCH_DIR: resolve(ROOT, 'research') });
const { config } = await import('../../services/api/src/config.ts');
if (config.broadcast) throw new Error('refusing to run: broadcasting is on');
const db = await import('../../services/api/src/db.ts');
await db.migrate();
const { mainnetLiveEnabled, startLiveWorker } = await import('../../services/api/src/derivatives/live.ts');
if (mainnetLiveEnabled()) throw new Error('refusing to run: the mainnet setting is on');
app = await (await import('../../services/api/src/server.ts')).buildServer() as never;                // default providers: real public quotes
await app!.listen({ port: PORT, host: '127.0.0.1' });
if (WORKERS) {
  const { startWorkers } = await import('../../services/api/src/worker.ts');
  const { startMarketWorker, getSeries, assertFresh } = await import('../../services/api/src/market/index.ts');
  const { startDerivativesWorker } = await import('../../services/api/src/derivatives/worker.ts');
  const { startAgentEngine } = await import('../../services/api/src/agents/live.ts');
  startWorkers(); startMarketWorker(); startDerivativesWorker(); startLiveWorker();
  startAgentEngine({ series: async (s, i, limit) => (await getSeries(s as never, i as never, { limit })).bars, assertFresh: async (s, i) => { await assertFresh(s as never, i as never); } });
} else startLiveWorker();
if (FORK) {
  // v10: the stack is READY only when the API's own chain adapters read the funded balances from the forks (this also warms
  // anvil's cache with the registry's token reads, so the first page does not start a burst of upstream requests)
  const { adapters } = await import('../../services/api/src/chains/index.ts');
  for (const id of FORK.split(',')) {
    let native = 0n, err = '';
    for (let n = 0; n < 6 && native === 0n; n++) { try { native = (await adapters[id]!.balances(keys.addresses.evm)).native ?? 0n; } catch (e) { err = e instanceof Error ? e.message : String(e); await new Promise((r) => setTimeout(r, 1500)); } }
    if (native === 0n) throw new Error(`QA stack: the API cannot read the wallet's balance on the fork of ${id}${err ? ` (${err})` : ''}`);
  }
}
console.log(`READY ${ORIGIN} account ${keys.addresses.evm.toLowerCase()} db ${DB} workers ${WORKERS ? 'on' : 'off'} broadcast OFF${FORK ? ` fork ${FORK} on ports ${PORT + 1}+` : ''}`);
