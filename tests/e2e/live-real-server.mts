/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : tests/e2e/live-real-server.mts
 * Module           : tests
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// The REAL backend for futures-live-real.spec.ts, booted in one process: the real API server (live routes, market data, auth),
// the real isolated-signer class behind its real HMAC channel, PostgreSQL (scratch database, dropped and recreated), and the
// built web bundle served by the API itself (no mock in it). Modelled on scripts/hl-live-testnet.mts.
//
// KEYS. The wallet seed is a fresh BIP-39 phrase generated IN MEMORY here; it is never printed, never written, and is gone
// when the process ends. No existing key, seed or secrets file is read. The signer's state goes to a temporary directory.
//
// NETWORK. Hyperliquid TESTNET only for anything signed. Every outgoing request is counted by host and path (written to
// `--traffic <file>` once a second), and a request to the MAINNET exchange endpoint (api.hyperliquid.xyz/exchange) is refused
// here before it leaves the process — on top of the server's own lock (SPW_DERIV_LIVE_MAINNET is forced off). Mainnet is only
// ever READ (public market data, `/info`), exactly as the Futures terminal does in production.
//
//   npx tsx tests/e2e/live-real-server.mts --port 8672 --db spw_live_ui_e2e --traffic test-results/live-real-traffic.json
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { deriveKeys } from '../../services/isolated-signer/src/keys.ts';
import { exchangePrices } from '../../services/isolated-signer/src/prices.ts';
import { createSignerServer } from '../../services/isolated-signer/src/server.ts';
import { Signer } from '../../services/isolated-signer/src/signer.ts';
import { Store } from '../../services/isolated-signer/src/store.ts';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1]! : d; };
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(arg('port', '8672')), DB = arg('db', 'spw_live_ui_e2e'), TRAFFIC = arg('traffic', ''), SETUP_TOKEN = arg('setup-token', 'e2e-setup-token');
const ORIGIN = `http://localhost:${PORT}`, RP = 'localhost', SECRET = 'e'.repeat(48);
if (!/^[a-z_0-9]+$/.test(DB)) throw new Error('bad database name');

// ── the guard: nothing may reach Hyperliquid's MAINNET exchange endpoint from this process ───────────────────────────────
const realFetch = globalThis.fetch, traffic: Record<string, number> = {};
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const k = `${u.host}${u.host.includes('hyperliquid') ? u.pathname : ''}`;
  if (u.host === 'api.hyperliquid.xyz' && u.pathname !== '/info') { traffic[`REFUSED ${k}`] = (traffic[`REFUSED ${k}`] ?? 0) + 1; throw new Error(`refusing a request to Hyperliquid MAINNET ${u.pathname}: only public reads (/info) leave this process`); }
  traffic[k] = (traffic[k] ?? 0) + 1;
  return realFetch(input, init);
}) as typeof fetch;
delete process.env.SPW_DERIV_LIVE_MAINNET;                                                            // the server's own mainnet lock stays closed, whatever the shell says
if (TRAFFIC) setInterval(() => { try { writeFileSync(TRAFFIC, JSON.stringify(traffic)); } catch { /* the directory may not exist yet */ } }, 1000).unref();

const keys = deriveKeys(generateMnemonic(wordlist, 128));                                             // throwaway seed, in memory only
let signerSrv: Server | undefined, app: { close: () => Promise<void>; listen: (o: { port: number; host: string }) => Promise<string>; server: { closeAllConnections?: () => void } } | undefined;
const stop = async () => { signerSrv?.close(); app?.server.closeAllConnections?.(); await app?.close().catch(() => {}); if (TRAFFIC) { try { writeFileSync(TRAFFIC, JSON.stringify(traffic)); } catch { /* ignore */ } } process.exit(0); };
process.on('SIGTERM', () => void stop()); process.on('SIGINT', () => void stop());

execSync(`dropdb --if-exists ${DB} && createdb ${DB}`);
const dir = mkdtempSync(join(tmpdir(), 'spw-live-ui-'));
const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
store.state.setupTokenHash = createHash('sha256').update(SETUP_TOKEN).digest('hex');
const signerCore = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, undefined, exchangePrices());   // the signer's OWN prices (Coinbase + Kraken), as in production
signerSrv = createSignerServer(signerCore, SECRET).listen(0, '127.0.0.1');
await new Promise((r) => signerSrv!.once('listening', r));
Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, PORT: String(PORT), HOST: '127.0.0.1', DATABASE_URL: `postgres:///${DB}`, SPW_SIGNER_SECRET: SECRET,
  SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`, SPW_BROADCAST: 'off', SPW_WORKERS: 'off', SPW_WEB_DIR: resolve(ROOT, 'dist/web') });
const db = await import('../../services/api/src/db.ts');
await db.migrate();
const { mainnetLiveEnabled, startLiveWorker } = await import('../../services/api/src/derivatives/live.ts');
if (mainnetLiveEnabled()) throw new Error('refusing to run: the mainnet setting is on');
app = await (await import('../../services/api/src/server.ts')).buildServer({ swapProviders: [] }) as never;
startLiveWorker();                                                                                    // the reconciliation worker: it only reads the venue (and has nothing to do for a READ_ONLY account)
await app!.listen({ port: PORT, host: '127.0.0.1' });
console.log(`READY ${ORIGIN} account ${keys.addresses.evm.toLowerCase()} db ${DB}`);
