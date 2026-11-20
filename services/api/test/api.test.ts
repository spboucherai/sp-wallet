import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from './test-db.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi, parseTransaction, recoverTransactionAddress } from 'viem';
import { NETWORKS } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { createSignerServer } from '../../isolated-signer/src/server.ts';
import { Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';

const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'k'.repeat(48);
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const owner = new TestPasskey(RP, ORIGIN), attacker = new TestPasskey(RP, ORIGIN);
let signerSrv: Server, app: any, sql: any, adapters: any, cookie = '';
const swapSeen: any[] = [], balanceReads: string[] = [];
const USDC = NETWORKS.base.tokens[0]!.id, DEST = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

async function api(method: string, path: string, body?: unknown, opts: { cookie?: string | null; origin?: string | null; csrf?: boolean; idem?: string } = {}) {
  const headers: Record<string, string> = {};
  const c = opts.cookie === undefined ? cookie : opts.cookie;
  if (c) headers.cookie = c;
  if (method !== 'GET') { if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN; if (opts.csrf !== false) headers['x-spw-csrf'] = '1'; headers['content-type'] = 'application/json'; }
  if (opts.idem) headers['idempotency-key'] = opts.idem;
  const r = await app.inject({ method, url: path, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), setCookie: r.headers['set-cookie'] as string | undefined, headers: r.headers };
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spw-api-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('the-setup-token').digest('hex');
  signerSrv = createSignerServer(new Signer(keys, store, { rpId: RP, origin: ORIGIN }), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, DATABASE_URL: (await createTestDb('api')).url, SPW_SIGNER_SECRET: SECRET,
    SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`, SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
  const db = await import('../src/db.ts');
  sql = db.sql;
  await sql.unsafe('drop schema public cascade; create schema public;');
  await db.migrate();
  adapters = (await import('../src/chains/index.ts')).adapters;
  // Deterministic chain data: the network is never contacted in this suite.
  adapters.base.prepare = async () => ({ section: { evm: { nonce: 7, gasLimit: '90000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000' } }, maxFee: 90_000_000_000_000n, feeEstimate: 50_000_000_000_000n, warnings: [], ttlSec: 120 });
  // two scripted swap providers; the second answers for an attacker's address and must be dropped
  const fake = (id: string, bps: bigint, recipient?: string) => ({ id, name: id,
    capabilities: () => ({ networks: ['base'], crossChain: false, needsKey: false, configured: true, kinds: ['swap' as const], docs: '' }),
    supportsPair: (a: any, b: any) => a.network === 'base' && b.network === 'base',
    quote: async (r: any) => { swapSeen.push(r); const out = (r.amountIn * 2000n * (10_000n - bps)) / 10_000n / 10n ** 12n;
      return [{ id: `${id}-${swapSeen.length}`, provider: id, request: recipient ? { ...r, recipient } : r, steps: [{ kind: 'swap' as const, provider: id, from: r.from, to: r.to, via: ['pool'], contracts: [] }],
        amountOut: out, minAmountOut: (out * 995n) / 1000n, fees: [], estimatedSeconds: 12, priceImpactBps: 4, quotedAt: Date.now(), expiresAt: Date.now() + 30_000, firmness: 'indicative' as const,
        executability: { class: 'opaque' as const, reason: 'test' }, refundable: true, atomic: true }]; } });
  await db.setSetting('prices', false); // the suite never contacts the price source
  // nor a chain. NEXT: the portfolio prefers the adapter's cross-checked read (balancesDetailed) when it has one; it is removed here so that the scripted read below is the one used
  for (const k of Object.keys(adapters)) { delete adapters[k].balancesDetailed; adapters[k].balances = async (a: string) => { balanceReads.push(`${k}:${a}`); return { native: 5n }; }; }
  app = await (await import('../src/server.ts')).buildServer({ swapProviders: [fake('alpha', 10n), fake('beta', 30n), fake('evil', 0n, '0x000000000000000000000000000000000000dEaD')] });
});
afterAll(async () => { await app?.close(); signerSrv?.close(); await sql?.end(); });

describe('access control', () => {
  it('everything is closed without a session; CSRF is enforced', async () => {
    for (const p of ['/api/v1/portfolio', '/api/v1/accounts', '/api/v1/activity', '/api/v1/security/overview', '/api/v1/security/audit', '/api/v1/settings', '/api/v1/health/ready'])
      expect((await api('GET', p, undefined, { cookie: null })).status).toBe(401);
    expect((await api('POST', '/api/v1/transfers/proposals', {}, { cookie: null })).status).toBe(401);
    expect((await api('POST', '/api/v1/security/emergency-halt', {}, { cookie: null })).status).toBe(401);
    expect((await api('POST', '/api/v1/auth/login/options', {}, { cookie: null, origin: 'https://evil.example' })).status).toBe(403);
    expect((await api('POST', '/api/v1/auth/login/options', {}, { cookie: null, csrf: false })).status).toBe(403);
    const live = await api('GET', '/api/v1/health/live', undefined, { cookie: null });
    expect(live.status).toBe(200);
    expect(String(live.headers['content-security-policy'])).toContain("script-src 'self'");
    expect((await api('POST', '/api/v1/sign', {}, { cookie: null })).status).toBe(401);
  });

  it('setup needs the signer token, works once, then closes forever', async () => {
    expect((await api('GET', '/api/v1/auth/state', undefined, { cookie: null })).json).toEqual({ setupRequired: true, authenticated: false });
    let o = (await api('POST', '/api/v1/auth/setup/options', {}, { cookie: null })).json;
    const bad = await api('POST', '/api/v1/auth/setup/verify', { challengeId: o.challengeId, response: attacker.register(o.options.challenge), setupToken: 'wrong-token' }, { cookie: null });
    expect(bad.status).toBe(422);
    o = (await api('POST', '/api/v1/auth/setup/options', {}, { cookie: null })).json;
    const ok = await api('POST', '/api/v1/auth/setup/verify', { challengeId: o.challengeId, response: owner.register(o.options.challenge), setupToken: 'the-setup-token' }, { cookie: null });
    expect(ok.status).toBe(200);
    expect(String(ok.setCookie)).toMatch(/__Host-spw=.*HttpOnly; Secure; SameSite=Strict/);
    expect((await api('POST', '/api/v1/auth/setup/options', {}, { cookie: null })).status).toBe(403);
  });

  it('only the enrolled passkey can log in', async () => {
    let o = (await api('POST', '/api/v1/auth/login/options', {}, { cookie: null })).json;
    const no = await api('POST', '/api/v1/auth/login/verify', { challengeId: o.challengeId, response: attacker.assert(Buffer.from(o.options.challenge, 'base64url')) }, { cookie: null });
    expect(no.status).toBe(401);
    o = (await api('POST', '/api/v1/auth/login/options', {}, { cookie: null })).json;
    const stale = owner.assert(Buffer.from(o.options.challenge, 'base64url'));
    const yes = await api('POST', '/api/v1/auth/login/verify', { challengeId: o.challengeId, response: stale }, { cookie: null });
    expect(yes.status).toBe(200);
    cookie = String(yes.setCookie).split(';')[0]!;
    expect((await api('POST', '/api/v1/auth/login/verify', { challengeId: o.challengeId, response: stale }, { cookie: null })).status).toBe(401); // challenge is single-use
    const acc = await api('GET', '/api/v1/accounts');
    expect(acc.status).toBe(200);
    expect(acc.json.accounts.find((a: any) => a.network === 'base').address).toBe(keys.addresses.evm);
    expect(JSON.stringify(acc.json)).not.toMatch(/abandon|priv/i);
  });
});

describe('transfer lifecycle', () => {
  const draft = (amount = '12.5', idem = crypto.randomUUID()) => api('POST', '/api/v1/transfers/proposals', { network: 'base', asset: USDC, to: DEST, amount }, { idem });

  it('validates input and applies policy before anything is drafted', async () => {
    expect((await api('POST', '/api/v1/transfers/proposals', { network: 'base', asset: USDC, to: DEST, amount: '1' })).status).toBe(400); // no idempotency key
    expect((await draft('0')).status).toBe(400);
    expect((await draft('1.0000001')).status).toBe(400);
    expect((await draft('50.000001')).json.error).toBe('policy');
    const badAddr = await api('POST', '/api/v1/transfers/proposals', { network: 'base', asset: USDC, to: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', amount: '1' }, { idem: crypto.randomUUID() });
    expect(badAddr.json.error).toBe('bad_address');
    const badAsset = await api('POST', '/api/v1/transfers/proposals', { network: 'base', asset: '0xdAC17F958D2ee523a2206206994597C13D831ec7', to: DEST, amount: '1' }, { idem: crypto.randomUUID() });
    expect(badAsset.json.error).toBe('unsupported_asset');
  });

  it('is idempotent', async () => {
    const k = crypto.randomUUID();
    const a = await draft('3', k), b = await draft('3', k);
    expect(a.status).toBe(200);
    expect(b.json.id).toBe(a.json.id);
    expect(a.json.warnings).toContain('new_destination');
  });

  it('a session alone cannot move funds; approval for another intent is refused by the signer', async () => {
    const d = (await draft('5')).json;
    const ra = (await api('POST', `/api/v1/transfers/proposals/${d.id}/request-approval`, {})).json;
    expect(ra.proposal.state).toBe('pending_approval');
    expect(Buffer.from(ra.options.challenge, 'base64url').toString('hex')).toBe(ra.proposal.intentHash);
    const none = await api('POST', `/api/v1/transfers/proposals/${d.id}/approve`, {});
    expect(none.status).toBe(400);
    expect((await api('GET', `/api/v1/transfers/proposals/${d.id}`)).json.state).toBe('pending_approval');
    expect((await api('GET', `/api/v1/transfers/proposals/${d.id}`)).json.txid).toBeNull();

    const d2 = (await draft('5')).json;
    await api('POST', `/api/v1/transfers/proposals/${d2.id}/request-approval`, {});
    const wrong = await api('POST', `/api/v1/transfers/proposals/${d2.id}/approve`, { assertion: owner.assert(Buffer.from(ra.options.challenge, 'base64url')) });
    expect(wrong.status).toBe(422);
    const d3 = (await draft('5')).json;
    const ra3 = (await api('POST', `/api/v1/transfers/proposals/${d3.id}/request-approval`, {})).json;
    const rogue = await api('POST', `/api/v1/transfers/proposals/${d3.id}/approve`, { assertion: attacker.assert(Buffer.from(ra3.options.challenge, 'base64url')) });
    expect(rogue.status).toBe(422);
  });

  it('signs exactly what was approved, and only once', async () => {
    const d = (await draft('12.5')).json;
    const ra = (await api('POST', `/api/v1/transfers/proposals/${d.id}/request-approval`, {})).json;
    const assertion = owner.assert(Buffer.from(ra.options.challenge, 'base64url'));
    const ok = await api('POST', `/api/v1/transfers/proposals/${d.id}/approve`, { assertion });
    expect(ok.status).toBe(200);
    // v11 (B2): this server does not broadcast — the transfer is signed and honestly reported as NOT sent, with a code, never as "broadcast"
    expect(ok.json).toMatchObject({ state: 'not_broadcast', errorCode: 'broadcast_disabled', explorer: null, broadcastAt: null });
    expect(ok.json.error).toMatch(/NOT broadcast/); expect(ok.json.txid).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ok.json.execution).toMatchObject({ kind: 'transfer', state: 'failed', steps: [{ kind: 'send', state: 'failed', code: 'broadcast_disabled', explorer: null }] });
    const [row] = await sql`select raw, txid from proposals where id = ${d.id}`;
    const tx = parseTransaction(row.raw);
    expect(await recoverTransactionAddress({ serializedTransaction: row.raw })).toBe(keys.addresses.evm);
    expect(tx.chainId).toBe(8453);
    expect(tx.nonce).toBe(7);
    expect(tx.to!.toLowerCase()).toBe(USDC.toLowerCase());
    expect(decodeFunctionData({ abi: erc20Abi, data: tx.data! }).args).toEqual([DEST, 12_500_000n]);
    expect((await api('POST', `/api/v1/transfers/proposals/${d.id}/approve`, { assertion })).status).toBe(409);
    expect(JSON.stringify(ok.json)).not.toContain(row.raw);
  });

  it('v11 (B2): a transfer signed with broadcast off does NOT hold the network; a transfer really in flight still does', async () => {
    // the previous test left a signed, never-sent transfer: before v11 it stayed in "broadcast" for ever and every later transfer on Base answered pending_tx
    const [left] = await sql`select id, state from proposals where state = 'not_broadcast'`;
    expect(left).toBeTruthy();
    const d = (await draft('1')).json;
    const free = await api('POST', `/api/v1/transfers/proposals/${d.id}/request-approval`, {});
    expect(free.status, JSON.stringify(free.json)).toBe(200);
    // it is not listed as pending on Home, and its destination did not become a "known" address
    const pf = (await api('GET', '/api/v1/portfolio')).json; // (prices are off for the suite: see beforeAll)
    expect(pf.pending.map((p: any) => p.id)).toContain(d.id); expect(pf.pending.map((p: any) => p.id)).not.toContain(left.id);
    await sql`delete from address_book`; const again = (await draft('1')).json; expect(again.warnings).toContain('new_destination');
    await api('POST', `/api/v1/transfers/proposals/${again.id}/reject`, {});
    // the status route carries the same state, the code, and the unified execution status
    expect((await api('GET', `/api/v1/transfers/${left.id}/status`)).json).toMatchObject({ state: 'not_broadcast', errorCode: 'broadcast_disabled', explorer: null, kind: 'transfer', execution: { state: 'failed' } });
    // a transfer that IS in flight (signed and relayed, not confirmed) blocks the next one, as before
    await sql`update proposals set state = 'broadcast', error = null, error_code = null where id = ${left.id}`;
    const blocked = await api('POST', `/api/v1/transfers/proposals/${d.id}/request-approval`, {});
    expect(blocked.status).toBe(409); expect(blocked.json.error).toBe('pending_tx');
    await sql`update proposals set state = 'finalized' where id = ${left.id}`; // the chain confirmed it
    expect((await api('POST', `/api/v1/transfers/proposals/${d.id}/request-approval`, {})).status).toBe(200);
    await api('POST', `/api/v1/transfers/proposals/${d.id}/reject`, {});
    expect((await api('GET', `/api/v1/transfers/proposals/${d.id}`)).json).toMatchObject({ state: 'rejected', errorCode: 'rejected_by_owner', error: 'rejected by owner' });
  });

  it('v11 (B4): the same Idempotency-Key answers the same draft; the same key with another body is refused', async () => {
    const key = crypto.randomUUID(), body = { network: 'base', asset: USDC, to: DEST, amount: '3' };
    const a = await api('POST', '/api/v1/transfers/proposals', body, { idem: key }), b = await api('POST', '/api/v1/transfers/proposals', body, { idem: key });
    expect(a.status).toBe(200); expect(b.json.id).toBe(a.json.id);
    const other = await api('POST', '/api/v1/transfers/proposals', { ...body, amount: '4' }, { idem: key });
    expect(other.status).toBe(409); expect(other.json.error).toBe('idempotency_mismatch');
    expect((await sql`select count(*)::int as n from proposals where idempotency_key = ${key}`)[0].n).toBe(1);
    await api('POST', `/api/v1/transfers/proposals/${a.json.id}/reject`, {});
  });

  it('reject, tampered stored intent, daily limit and emergency halt all fail closed', async () => {
    const r = (await draft('1')).json;
    expect((await api('POST', `/api/v1/transfers/proposals/${r.id}/reject`, {})).json.state).toBe('rejected');
    expect((await api('POST', `/api/v1/transfers/proposals/${r.id}/request-approval`, {})).status).toBe(409);

    // a compromised API/database swaps the destination after the owner approved the original
    const t = (await draft('2')).json;
    const ra = (await api('POST', `/api/v1/transfers/proposals/${t.id}/request-approval`, {})).json;
    await sql`update proposals set intent = jsonb_set(intent, '{to}', '"0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"') where id = ${t.id}`;
    const tampered = await api('POST', `/api/v1/transfers/proposals/${t.id}/approve`, { assertion: owner.assert(Buffer.from(ra.options.challenge, 'base64url')) });
    expect(tampered.status).toBe(422);

    for (const amt of ['50', '37.5']) { // 12.5 already signed today → reaches the 100 USDC daily limit
      const d = (await draft(amt)).json;
      const a = (await api('POST', `/api/v1/transfers/proposals/${d.id}/request-approval`, {})).json;
      expect((await api('POST', `/api/v1/transfers/proposals/${d.id}/approve`, { assertion: owner.assert(Buffer.from(a.options.challenge, 'base64url')) })).status).toBe(200);
      await sql`update proposals set state = 'finalized' where state = 'broadcast'`;
    }
    expect((await draft('0.01')).json.error).toBe('policy');

    expect((await api('POST', '/api/v1/security/emergency-halt', {})).status).toBe(200);
    expect((await api('GET', '/api/v1/security/overview')).json.signer.halted).toBe(true);
    expect((await draft('0.01')).json.error).toBe('policy');
  });

  it('audit trail is hash-chained, append-only, and free of secrets', async () => {
    const a = (await api('GET', '/api/v1/security/audit?limit=500')).json;
    expect(a.intact).toBe(true);
    expect(a.total).toBeGreaterThan(15);
    await expect(sql`update audit_events set type = 'x' where seq = 1`).rejects.toThrow(/append-only/);
    await expect(sql`delete from audit_events`).rejects.toThrow(/append-only/);
    const dump = JSON.stringify(a) + JSON.stringify(await sql`select * from proposals`) + JSON.stringify(await sql`select * from sessions`);
    expect(dump).not.toMatch(/abandon/);
    expect(dump).not.toContain(Buffer.from(keys.evmPriv).toString('hex'));
    expect(dump).not.toContain(cookie.split('=')[1]);
  });

  it('swap: quotes are for the wallet\'s own addresses, hostile answers are dropped, execution is gated', async () => {
    expect((await api('POST', '/api/v1/swap/quote', { from: 'base:native', to: `base:${USDC}`, amount: '0.01' }, { cookie: null })).status).toBe(401);
    expect((await api('GET', '/api/v1/swap/assets', undefined, { cookie: null })).status).toBe(401);
    const q = await api('POST', '/api/v1/swap/quote', { from: 'base:native', to: `base:${USDC}`, amount: '0.01', recipient: '0x000000000000000000000000000000000000dEaD' });
    expect(q.status).toBe(200);
    expect(swapSeen.every((r) => r.sender === keys.addresses.evm && r.recipient === keys.addresses.evm)).toBe(true); // the client cannot choose the recipient
    expect(q.json.routes.map((r: any) => r.providers[0]).sort()).toEqual(['alpha', 'beta']);
    expect(q.json.providers.find((p: any) => p.provider === 'evil').code).toBe('invalid_quote');
    const best = q.json.routes.find((r: any) => r.id === q.json.best.best_price);
    expect(best.providers).toEqual(['alpha']);
    expect(best.minAmountOut).toBe('19880100'); // 0.01 ETH × 2000 × 0.999 × 0.995, in USDC base units, as a string
    expect(best.minAmountOutDisplay).toBe('19.8801');
    for (const bad of [{ from: 'base:native', to: 'base:native', amount: '1' }, { from: 'base:native', to: 'base:0xdAC17F958D2ee523a2206206994597C13D831ec7', amount: '1' },
      { from: 'base:native', to: `base:${USDC}`, amount: '0' }, { from: 'base:native', to: `base:${USDC}`, amount: '1e3' }, { from: 'nochain:native', to: `base:${USDC}`, amount: '1' }])
      expect((await api('POST', '/api/v1/swap/quote', bad)).status, JSON.stringify(bad)).toBe(400);
    const far = await api('POST', '/api/v1/swap/quote', { from: 'bitcoin:native', to: 'solana:native', amount: '0.001' });
    expect(far.json.reachable).toBe(false); expect(far.json.routes).toEqual([]);
    const sse = await app.inject({ method: 'GET', url: `/api/v1/swap/quote/stream?from=base:native&to=base:${USDC}&amount=0.01`, headers: { cookie } });
    expect(sse.headers['content-type']).toContain('text/event-stream');
    const events = sse.body.split('\n\n').filter(Boolean).map((b: string) => b.split('\n')[0]!.replace('event: ', ''));
    expect(events[0]).toBe('start'); expect(events.filter((e: string) => e === 'route').length).toBe(2); expect(events[events.length - 1]).toBe('done');
    // execution: authenticated, idempotent, only on networks whose router has been reviewed, and refused while halted
    expect((await api('POST', '/api/v1/swap/proposals', { network: 'base', fromAsset: 'native', toAsset: USDC, amount: '0.01' }, { cookie: null, idem: crypto.randomUUID() })).status).toBe(401);
    expect((await api('POST', '/api/v1/swap/proposals', { network: 'base', fromAsset: 'native', toAsset: USDC, amount: '0.01' })).json.error).toBe('idempotency');
    expect((await api('POST', '/api/v1/swap/proposals', { network: 'bitcoin', fromAsset: 'native', toAsset: 'x', amount: '1' }, { idem: crypto.randomUUID() })).json.error).toBe('swap_not_enabled');
    expect((await api('POST', '/api/v1/swap/proposals', { network: 'solana', fromAsset: 'native', toAsset: 'x', amount: '1' }, { idem: crypto.randomUUID() })).json.error).toBe('unsupported_asset'); // Solana is served by Jupiter since V5 (swap-sol.test.ts)
    expect((await api('POST', '/api/v1/swap/proposals', { network: 'base', fromAsset: 'native', toAsset: '0xdAC17F958D2ee523a2206206994597C13D831ec7', amount: '1' }, { idem: crypto.randomUUID() })).json.error).toBe('unsupported_asset');
    expect((await api('POST', '/api/v1/swap/proposals', { network: 'base', fromAsset: 'native', toAsset: 'native', amount: '1' }, { idem: crypto.randomUUID() })).json.error).toBe('same_asset');
    expect((await api('POST', '/api/v1/swap/proposals', { network: 'base', fromAsset: 'native', toAsset: USDC, amount: '0.01', recipient: '0x000000000000000000000000000000000000dEaD' }, { idem: crypto.randomUUID() })).status).toBe(400); // no way to name a recipient
    expect((await api('POST', '/api/v1/swap/proposals', { network: 'base', fromAsset: 'native', toAsset: USDC, amount: '0.01' }, { idem: crypto.randomUUID() })).json.error).toBe('halted'); // the suite halted the signer earlier
    const st = (await api('GET', '/api/v1/swap/providers')).json;
    expect(st.providers.length).toBe(3);
    expect((await api('GET', '/api/v1/swap/execution')).json.networks).toEqual(['base', 'ethereum', 'arbitrum', 'polygon', 'optimism', 'bsc', 'avalanche', 'hyperevm']);
    // the quote log is written without being awaited (swap.ts: `void sql\`insert into swap_quotes …\``): the rows are waited for
    // with a bounded poll that returns as soon as they are there — the assertion is the same
    let rows = await sql`select provider, ok, code from swap_quotes`;
    for (const deadline = Date.now() + 30_000; rows.length < 4 && Date.now() < deadline;) { await new Promise((r) => setTimeout(r, 5)); rows = await sql`select provider, ok, code from swap_quotes`; }
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });

  it('v11: every route carries the normalized card, the server states the executor, the stream has a retry field', async () => {
    const q = (await api('POST', '/api/v1/swap/quote', { from: 'base:native', to: `base:${USDC}`, amount: '0.01' })).json;
    expect(q.executors).toEqual(['kyberswap']); // from the pinned tables, whatever the providers answered
    for (const r of q.routes) {
      // alpha / beta are not executors of this wallet: comparison only, stated by the server
      expect(r).toMatchObject({ executable: false, executor: null });
      expect(r.card).toMatchObject({ routeId: r.id, quoteId: r.id, providers: r.providers, fingerprint: r.fingerprint, amountIn: '10000000000000000', amountInDisplay: '0.01', fromSymbol: 'ETH', toSymbol: 'USDC',
        estimatedOut: r.amountOut, minimumOut: r.minAmountOut, estimatedOutDisplay: r.amountOutDisplay, minimumOutDisplay: r.minAmountOutDisplay,
        networkFee: null, protocolFee: null, // the scripted providers report no fee: null, not zero
        toleranceBps: 50, etaSeconds: 12, executable: false, executor: null, reasonCode: 'opaque', steps: [{ kind: 'swap', network: 'base', toNetwork: 'base', provider: r.providers[0], descriptionCode: 'step_swap' }] });
      expect(r.fingerprint).toMatch(/^[0-9a-f]{32}$/);
      expect(typeof r.card.quotedAt).toBe('number'); expect(r.card.expiresAt).toBeGreaterThan(r.card.quotedAt); expect(Date.now() - r.card.quotedAt).toBeLessThan(10_000);
      expect(r.card.riskFlags).toEqual(r.risk.flags.map((f: any) => f.code)); expect(r.card.riskLevel).toBe(r.risk.level);
      expect(r.card.effectiveSlippageBps).toBeNull(); // prices are off: no reference price, so no figure — never a guess
    }
    expect(new Set(q.routes.map((r: any) => r.fingerprint)).size).toBe(q.routes.length);
    const sse = await app.inject({ method: 'GET', url: `/api/v1/swap/quote/stream?from=base:native&to=base:${USDC}&amount=0.01`, headers: { cookie } });
    expect(sse.body).toMatch(/^event: start\nretry: 3000\ndata: /);
    const blocks = sse.body.split('\n\n').filter(Boolean), data = (b: string) => JSON.parse(b.split('\n').find((l: string) => l.startsWith('data: '))!.slice(6));
    expect(data(blocks[0]!).executors).toEqual(['kyberswap']);
    for (const b of blocks.filter((x: string) => x.startsWith('event: route'))) expect(data(b).card.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(data(blocks[blocks.length - 1]!).executors).toEqual(['kyberswap']);
    // a comparison-only quote cannot be prepared: the reference names a provider this wallet does not execute (checked after the halt in this suite, so only the schema is exercised here)
    const bad = await api('POST', '/api/v1/swap/proposals', { network: 'base', fromAsset: 'native', toAsset: USDC, amount: '0.01', quote: { id: 'x', provider: 'alpha', fingerprint: 'nope', amountOut: '1', minAmountOut: '1', quotedAt: 1 } }, { idem: crypto.randomUUID() });
    expect(bad.status).toBe(400); expect(bad.json.error).toBe('bad_request');
  });

  it('v11: quote streams send a heartbeat and are capped', async () => {
    // a second, bare Fastify instance over the same modules: only the swap routes, a provider that takes its time, a short heartbeat, room for one stream
    const Fastify = (await import('fastify')).default, { swapRoutes } = await import('../src/swap.ts'), { UserError } = await import('../src/config.ts');
    let release: () => void = () => {}; const gate = new Promise<void>((r) => { release = r; });
    const slow = { id: 'slow', name: 'slow', policy: { timeoutMs: 4000 }, capabilities: () => ({ networks: ['base'], crossChain: false, needsKey: false, configured: true, kinds: ['swap' as const], docs: '' }),
      supportsPair: () => true, quote: async () => { await gate; return []; } };
    const f = Fastify(); f.setErrorHandler((e: any, _q, r) => r.status(e instanceof UserError ? e.status : 500).send({ error: e.code ?? 'internal' }));
    swapRoutes(f, { providers: [slow as never], prices: async () => null, heartbeatMs: 25, maxStreams: 1 });
    const url = `/api/v1/swap/quote/stream?from=base:native&to=base:${USDC}&amount=0.01`;
    const first = f.inject({ method: 'GET', url });
    await new Promise((r) => setTimeout(r, 150));
    const second = await f.inject({ method: 'GET', url });
    expect(second.statusCode).toBe(429); expect(second.json().error).toBe('too_many_streams');
    release(); const done = await first;
    expect(done.body.match(/^: keep-alive$/gm)!.length).toBeGreaterThanOrEqual(3); // comment lines while the provider was silent
    expect(done.body).toMatch(/event: done/);
    expect((await f.inject({ method: 'GET', url })).statusCode).toBe(200); // the slot was given back
    expect((await f.inject({ method: 'GET', url: '/api/v1/swap/quote/stream?from=base:native&to=base:native&amount=1' })).statusCode).toBe(400); // a refused request holds no slot
    expect((await f.inject({ method: 'GET', url })).statusCode).toBe(200);
    await f.close();
  });

  it('v11: activity and CSV say what each row is (a GMX order is not a "send"); a swap\'s CSV line says what was received', async () => {
    const mk = (id: string, kind: string, out: string | null, swap: unknown) => sql`insert into proposals (id, idempotency_key, state, kind, network, asset, symbol, decimals, amount, from_addr, to_addr, txid, out_amount, swap)
      values (${id}, ${`act-${id}`}, 'finalized', ${kind}, 'arbitrum', 'native', 'ETH', 18, '1000000000000000', ${keys.addresses.evm}, '0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41', ${'0x' + id.replace(/-/g, '').padEnd(64, '0')}, ${out}, ${swap ? sql.json(swap) : null})`;
    await mk('00000000-0000-4000-8000-00000000a001', 'gmx', null, null);
    await mk('00000000-0000-4000-8000-00000000a002', 'swap', '2500000', { provider: 'kyberswap', toAsset: 'x', toSymbol: 'USDC', toDecimals: 6, expectedOut: '2500000', minOut: '2400000', slippageBps: 50, needsApproval: false, simulated: true });
    const items = (await api('GET', '/api/v1/activity?limit=500')).json.items;
    expect(items.find((i: any) => i.id === '00000000-0000-4000-8000-00000000a001')).toMatchObject({ kind: 'gmx', rawKind: 'gmx', execution: { kind: 'gmx', steps: [{ kind: 'order', state: 'confirmed' }] } });
    expect(items.find((i: any) => i.id === '00000000-0000-4000-8000-00000000a002')).toMatchObject({ kind: 'swap', rawKind: 'swap' });
    expect(items.filter((i: any) => i.kind === 'send').every((i: any) => i.rawKind === 'transfer')).toBe(true);
    const csv = (await app.inject({ method: 'GET', url: '/api/v1/export/activity.csv', headers: { cookie } })).body.split('\n');
    expect(csv[0]).toBe('time_utc,direction,network,symbol,amount_base_units,amount,counterparty,state,txid,fee_estimate_base_units,to_network,to_symbol,received');
    const line = (needle: string) => csv.find((l: string) => l.includes(needle))!.split(',').map((c: string) => c.replace(/^"|"$/g, ''));
    expect(line('a001')[1]).toBe('gmx');
    expect(line('a002')).toMatchObject({ 1: 'swap', 10: 'arbitrum', 11: 'USDC', 12: '2.5' });
    expect(csv.filter((l: string) => l.split(',')[1] === '"send"').length).toBeGreaterThan(3); // plain transfers are still `send`
    await sql`delete from proposals where idempotency_key like 'act-%'`;
  });

  it('v11: Home is served with the signer unreachable — last known addresses, the API\'s own balance reads, and it says so', async () => {
    const sc = await import('../src/signer-client.ts'), { UserError } = await import('../src/config.ts'), status = sc.signer.status;
    const seen = balanceReads;
    const up = (await api('GET', '/api/v1/portfolio')).json;
    expect(up).toMatchObject({ signer: { reachable: true }, halted: true, priceSource: null, pricesAsOf: null, pricesStale: false });
    const accounts = (await api('GET', '/api/v1/accounts')).json; expect(accounts.signerReachable).toBe(true);
    sc.signer.status = async () => { throw new UserError('signer_unreachable', 'the signer is unreachable; nothing was signed', 503); };
    try {
      await new Promise((r) => setTimeout(r, 12_100)); seen.length = 0; // past the 12 s balance cache: the balances below are fresh reads by the API itself
      const down = await api('GET', '/api/v1/portfolio');
      expect(down.status, JSON.stringify(down.json).slice(0, 200)).toBe(200);
      expect(down.json).toMatchObject({ signer: { reachable: false, addressesAsOf: accounts.addressesAsOf }, halted: null }); // the halt flag is unknown, not "false"
      expect(down.json.balances.find((b: any) => b.network === 'base' && b.asset === 'native')).toMatchObject({ amount: '5', error: null });
      expect(seen).toContain(`base:${keys.addresses.evm}`); // read at the address the signer gave earlier
      const acc = (await api('GET', '/api/v1/accounts')).json;
      expect(acc).toMatchObject({ signerReachable: false, keyId: accounts.keyId }); expect(acc.accounts).toEqual(accounts.accounts);
      expect((await sql`select value from settings where key = 'signerAddresses'`)[0].value.addresses.base).toBe(keys.addresses.evm); // kept across a restart of the API
      // nothing that needs the signer pretends to work
      expect((await api('POST', '/api/v1/transfers/proposals', { network: 'base', asset: USDC, to: DEST, amount: '1' }, { idem: crypto.randomUUID() })).json.error).toBe('signer_unreachable');
      // another signer failure (a refusal, not an outage) is not swallowed
      sc.signer.status = async () => { throw new UserError('signer_error', 'refused', 422); };
      expect((await api('GET', '/api/v1/portfolio')).status).toBe(422);
    } finally { sc.signer.status = status; }
    expect((await api('GET', '/api/v1/portfolio')).json.signer.reachable).toBe(true);
  }, 30_000);

  it('logout and revoke-all end access', async () => {
    expect((await api('POST', '/api/v1/security/sessions/revoke-all', {})).status).toBe(200);
    expect((await api('GET', '/api/v1/portfolio')).status).toBe(401);
  });
});
