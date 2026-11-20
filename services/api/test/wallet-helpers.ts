// Shared boot of the NEXT wallet-API tests (wallet-contract, wallet-next-api): the REAL server on its own database, a real
// signer process, the owner enrolled and signed in through the real routes; chain reads, fee preparation and prices are
// scripted, and `fetch` answers nothing that is not this machine's signer — no test of these files can reach a network.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NETWORKS, type NetworkDef } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { createSignerServer } from '../../isolated-signer/src/server.ts';
import { Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';
import { useTestDatabase } from './test-db.ts';

export const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'k'.repeat(48);
export const NETS = Object.values(NETWORKS) as NetworkDef[], BASE = NETWORKS.base as NetworkDef, USDC = BASE.tokens.find((t) => t.symbol === 'USDC')!;
/** a destination the wallet pays in these tests, and the same address as chain logs give it (lower case) */
export const DEST = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', DEST_LOWER = DEST.toLowerCase();
export const ETH = 10n ** 18n;
/** scripted CoinGecko: [usd, cad, 24 h change in %] */
export const PRICES: Record<string, [number, number, number]> = { ethereum: [2000, 2800, 5], 'usd-coin': [1, 1.4, 0], bitcoin: [60000, 84000, -2] };

export interface Res { status: number; json: any; body: string; headers: Record<string, any>; setCookie?: string }
export interface Wallet {
  app: any; sql: any; db: typeof import('../src/db.ts'); pf: typeof import('../src/portfolio.ts'); adapters: Record<string, any>; keys: ReturnType<typeof deriveKeys>; owner: TestPasskey; me: string;
  /** every URL `fetch` was asked for that is not the local signer (all of them were answered by the script) */
  outbound: string[];
  api(method: string, path: string, body?: unknown, o?: { cookie?: string | null; idem?: string; headers?: Record<string, string> }): Promise<Res>;
  /** the one-time setup through the real routes (enrols the owner's passkey with the signer's token, opens the session); returns both answers */
  setup(): Promise<{ options: Res; verify: Res }>;
  /** sign in again (after a logout or a revoke-all) */
  login(): Promise<void>;
  cookie(): string;
  /** answers `429 rate_limited` this file received (it should be none: see `api`) */
  rateLimited(): number;
  /** insert a proposal row; returns its id */
  proposal(o?: Record<string, unknown>): Promise<string>;
  deposit(o: { txid: string; asset?: string; amount: string; from?: string; kind?: string | null; origin?: string | null; network?: string; idx?: number; at?: Date; block?: number; detection?: string | null; blockHash?: string | null }): Promise<void>;
  close(): Promise<void>;
}

export async function bootWallet(label: string): Promise<Wallet> {
  const dir = mkdtempSync(join(tmpdir(), `spw-${label}-`));
  const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('the-setup-token').digest('hex');
  const signerSrv: Server = createSignerServer(new Signer(keys, store, { rpId: RP, origin: ORIGIN }), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  delete process.env.APIBRICKS_API_KEY;
  await useTestDatabase(label, { SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`, SPW_DATA_DIR: join(dir, 'data') });
  const realFetch = globalThis.fetch, outbound: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init);   // the signer process of this test, and this test's own server
    outbound.push(url);
    if (url.includes('api.coingecko.com') && url.includes('/market_chart')) return Response.json({ prices: Array.from({ length: 30 }, (_, k) => [1_800_000_000_000 + k * 3_600_000, 2000 + k]) });
    if (url.includes('api.coingecko.com')) { const cur = new URL(url).searchParams.get('vs_currency') === 'usd' ? 0 : 1;
      return Response.json(Object.entries(PRICES).map(([id, p]) => ({ id, current_price: p[cur], last_updated: new Date().toISOString(), price_change_percentage_24h_in_currency: p[2], market_cap: 1e9, total_volume: 1e7, sparkline_in_7d: { price: [1, 2, 3] } }))); }
    return new Response(null, { status: 201 });                               // a push service, a webhook: accepted, nothing leaves this process
  }) as typeof fetch;

  const db = await import('../src/db.ts'), sql = db.sql;
  await sql.unsafe('drop schema public cascade; create schema public;');
  await db.migrate();
  const adapters = (await import('../src/chains/index.ts')).adapters as Record<string, any>, pf = await import('../src/portfolio.ts');
  // chain reads: 0 everywhere through the plain read; Base and Bitcoin through the cross-checked read, with provenance
  const read = (amount: bigint, extra: object = {}) => ({ amount, height: 99, sources: 2, asked: 2, agreed: true, stale: false, ...extra });
  for (const n of NETS) { const a = adapters[n.id]; delete a.balancesDetailed; a.balances = async () => Object.fromEntries([n.native, ...n.tokens].map((x) => [x.id, 0n])); }
  adapters.base.balancesDetailed = async () => ({ assets: Object.fromEntries([BASE.native, ...BASE.tokens].map((a) => [a.id, a.id === 'native' ? read(15n * ETH / 10n) : a.id === USDC.id ? read(250_500_000n) : read(0n)])), unavailable: {} });
  const BTC = NETWORKS.bitcoin as NetworkDef;
  adapters.bitcoin.balancesDetailed = async () => ({ assets: { native: read(1_000_000n, { confirmed: 1_200_000n, pendingOut: 200_000n, pendingIn: 0n }) }, unavailable: Object.fromEntries(BTC.tokens.map((t) => [t.id, 'not_read'])) });
  // fee preparation: deterministic, with one warning of the adapter's own
  adapters.base.prepare = async () => ({ section: { evm: { nonce: 7, gasLimit: '90000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000' } }, maxFee: 90_000_000_000_000n, feeEstimate: 50_000_000_000_000n, warnings: ['network_congested'], ttlSec: 120 });
  pf.resetBalanceCache();
  const app = await (await import('../src/server.ts')).buildServer();
  (await (await import('../src/alerts/dispatcher.ts')).alerts()).deps.fetch = globalThis.fetch;

  const owner = new TestPasskey(RP, ORIGIN);
  let cookie = '', calls = 0, limited = 0;
  const api: Wallet['api'] = async (method, path, body, o = {}) => {
    const headers: Record<string, string> = { ...o.headers }, c = o.cookie === undefined ? cookie : o.cookie;
    if (c) headers.cookie = c;
    if (method !== 'GET') { headers.origin = ORIGIN; headers['x-spw-csrf'] = '1'; headers['content-type'] = 'application/json'; }
    if (o.idem) headers['idempotency-key'] = o.idem;
    // the rate limit is per address (240 a minute): the calls of a file are spread over addresses, 100 each, so that a long file is never refused for its length
    calls += 1;
    const r = await app.inject({ method, url: path, headers, payload: method === 'GET' ? undefined : JSON.stringify(body ?? {}), remoteAddress: `10.210.0.${1 + Math.floor(calls / 100)}` });
    if (r.statusCode === 429 && r.json()?.error === 'rate_limited') limited += 1;
    return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), body: r.body, headers: r.headers, setCookie: r.headers['set-cookie'] as string | undefined };
  };
  const login = async (): Promise<void> => {
    const o = (await api('POST', '/api/v1/auth/login/options', {}, { cookie: null })).json;
    const v = await api('POST', '/api/v1/auth/login/verify', { challengeId: o.challengeId, response: owner.assert(Buffer.from(o.options.challenge, 'base64url')) }, { cookie: null });
    if (v.status !== 200) throw new Error(`login failed: ${JSON.stringify(v.json)}`);
    cookie = String(v.setCookie).split(';')[0]!;
  };
  const setup: Wallet['setup'] = async () => {
    const options = await api('POST', '/api/v1/auth/setup/options', {}, { cookie: null });
    const verify = await api('POST', '/api/v1/auth/setup/verify', { challengeId: options.json.challengeId, response: owner.register(options.json.options.challenge), setupToken: 'the-setup-token', label: 'Mac' }, { cookie: null });
    if (verify.status !== 200) throw new Error(`setup failed: ${JSON.stringify(verify.json)}`);
    cookie = String(verify.setCookie).split(';')[0]!;
    return { options, verify };
  };
  const me = keys.addresses.evm;
  const proposal: Wallet['proposal'] = async (o = {}) => {
    const id = crypto.randomUUID(), r = { id, idempotency_key: `seed-${id}`, state: 'finalized', kind: 'transfer', network: 'base', asset: USDC.id, symbol: 'USDC', decimals: 6, amount: '25000000', from_addr: me, to_addr: DEST, note: '', warnings: sql.json([]), ...o };
    await sql`insert into proposals ${sql(r as never)}`;
    return id;
  };
  const deposit: Wallet['deposit'] = async (d) => {
    await sql`insert into deposits (network, txid, idx, asset, amount, from_addr, block, block_time, kind, origin, detection, block_hash)
      values (${d.network ?? 'base'}, ${d.txid}, ${d.idx ?? 0}, ${d.asset ?? 'native'}, ${d.amount}, ${d.from ?? ''}, ${d.block ?? 100}, ${d.at ?? new Date()}, ${d.kind === undefined ? 'external' : d.kind}, ${d.origin ?? null}, ${d.detection ?? null}, ${d.blockHash ?? null})`;
  };
  return { app, sql, db, pf, adapters, keys, owner, me, outbound, api, setup, login, cookie: () => cookie, rateLimited: () => limited, proposal, deposit,
    close: async () => { await app.close(); signerSrv.close(); await sql.end(); globalThis.fetch = realFetch; } };
}
