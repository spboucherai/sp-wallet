import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const swapSeen: any[] = [];
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
  Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, DATABASE_URL: 'postgres:///spw_test', SPW_SIGNER_SECRET: SECRET,
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
        amountOut: out, minAmountOut: (out * 995n) / 1000n, fees: [], estimatedSeconds: 12, priceImpactBps: 4, expiresAt: Date.now() + 30_000, firmness: 'indicative' as const,
        executability: { class: 'opaque' as const, reason: 'test' }, refundable: true, atomic: true }]; } });
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
    expect(ok.json.state).toBe('broadcast');
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

  it('refuses a second transfer on a network while the first is still unconfirmed', async () => {
    // the previous test left a proposal in "broadcast" (test mode never confirms it)
    const d = (await draft('1')).json;
    const blocked = await api('POST', `/api/v1/transfers/proposals/${d.id}/request-approval`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toBe('pending_tx');
    await sql`update proposals set state = 'finalized' where state = 'broadcast'`; // the chain confirmed it
    expect((await api('POST', `/api/v1/transfers/proposals/${d.id}/request-approval`, {})).status).toBe(200);
    await api('POST', `/api/v1/transfers/proposals/${d.id}/reject`, {});
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

  it('swap: quotes are for the wallet\'s own addresses, hostile answers are dropped, execution is disabled', async () => {
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
    expect((await api('POST', '/api/v1/swap/execute', {})).status).toBe(423);
    const st = (await api('GET', '/api/v1/swap/providers')).json;
    expect(st.executionEnabled).toBe(false); expect(st.providers.length).toBe(3);
    const rows = await sql`select provider, ok, code from swap_quotes`;
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });

  it('logout and revoke-all end access', async () => {
    expect((await api('POST', '/api/v1/security/sessions/revoke-all', {})).status).toBe(200);
    expect((await api('GET', '/api/v1/portfolio')).status).toBe(401);
  });
});
