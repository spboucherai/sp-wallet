// V8 hardening (B) — an agent-vault withdrawal is tracked from the request to the arrival at the owner's address.
// Real routes, the real signer behind its HTTP boundary (it signs the vault return), a scripted JSON-RPC node that plays the
// chain (nonce, fees, receipt, transaction), a recording broadcaster. No network.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, erc20Abi } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cashLegs, getNetwork, NETWORKS } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { createSignerServer } from '../../isolated-signer/src/server.ts';
import { Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';
import { createTestDb } from './test-db.ts';

const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'w'.repeat(48), NET = 'base';
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const owner = new TestPasskey(RP, ORIGIN);
const RISK = { maxExposurePct: 80, maxLossPct: 5, maxOrderUsd: 20, maxDailyUsd: 100, maxOrdersPerDay: 12, mandateDays: 30, slippageBps: 100 };
let signerSrv: Server, node: Server, app: any, sql: any, cfg: any, wd: typeof import('../src/agents/withdrawals.ts'), cookie = '', rpcBackup: string[] = [], agent: any, signs = 0;
const USDC = cashLegs(getNetwork(NET))[0]!;
// the scripted chain
const chain = { nonce: 7, latestNonce: 7, balances: {} as Record<string, bigint>, receipts: {} as Record<string, unknown>, txs: {} as Record<string, unknown>, sent: [] as string[], broadcastFails: false, down: false };

async function api(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = cookie ? { cookie } : {};
  if (method !== 'GET') Object.assign(headers, { origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' });
  const r = await app.inject({ method, url: `/api/v1${path}`, headers, payload: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), setCookie: r.headers['set-cookie'] as string | undefined };
}
const receiptOk = (w: { txid: string }, o: { status?: number; to?: string; value?: bigint; token?: string } = {}) => ({ status: `0x${o.status ?? 1}`, blockNumber: '0x64', logs: o.token ? [{ address: o.token,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: agent.vaultAddress, to: (o.to ?? keys.addresses.evm) as `0x${string}` } }), data: encodeAbiParameters([{ type: 'uint256' }], [o.value ?? 0n]) }] : [] });

beforeAll(async () => {
  const db0 = await createTestDb('agent_withdraw');
  const dir = mkdtempSync(join(tmpdir(), 'spw-v8-withdraw-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('the-setup-token').digest('hex');
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN });
  const real = signer.signVaultReturn.bind(signer); signer.signVaultReturn = ((...a: Parameters<typeof real>) => { signs += 1; return real(...a); }) as typeof real;
  signerSrv = createSignerServer(signer, SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  node = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { const j = JSON.parse(b), hex = (x: number | bigint) => `0x${x.toString(16)}`;
    const m: Record<string, () => unknown> = {
      eth_getTransactionCount: () => hex(j.params[1] === 'latest' ? chain.latestNonce : chain.nonce), eth_getBlockByNumber: () => ({ baseFeePerGas: hex(10_000_000n) }), eth_maxPriorityFeePerGas: () => hex(1_000_000n),
      eth_feeHistory: () => ({ baseFeePerGas: Array(21).fill(hex(10_000_000n)), reward: Array(20).fill(['0x0']) }), eth_getTransactionReceipt: () => chain.receipts[j.params[0]] ?? null, eth_getTransactionByHash: () => chain.txs[j.params[0]] ?? null };
    res.setHeader('content-type', 'application/json');
    if (chain.down) { res.statusCode = 503; return res.end('down'); }
    res.end(JSON.stringify(m[j.method] ? { jsonrpc: '2.0', id: j.id, result: m[j.method]!() } : { jsonrpc: '2.0', id: j.id, error: { code: -32601, message: 'not available in this test' } })); }); }).listen(0, '127.0.0.1');
  await new Promise((r) => node.once('listening', r));
  rpcBackup = NETWORKS[NET]!.rpc; NETWORKS[NET]!.rpc = [`http://127.0.0.1:${(node.address() as { port: number }).port}/${NET}`];
  Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, DATABASE_URL: db0.url, SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`, SPW_BROADCAST: 'on', SPW_WORKERS: 'off' });
  const db = await import('../src/db.ts'); sql = db.sql; await db.migrate(); await db.setSetting('prices', false);
  cfg = (await import('../src/config.ts')).config; wd = await import('../src/agents/withdrawals.ts');
  const adapters = (await import('../src/chains/index.ts')).adapters;
  adapters[NET]!.balances = async () => ({ ...chain.balances });
  adapters[NET]!.broadcast = async (raw: string) => { if (chain.broadcastFails) throw new Error('connection refused'); chain.sent.push(raw); };
  app = await (await import('../src/server.ts')).buildServer({ swapProviders: [] });
  const o = (await api('POST', '/auth/setup/options')).json;
  const s = await api('POST', '/auth/setup/verify', { challengeId: o.challengeId, response: owner.register(o.options.challenge), setupToken: 'the-setup-token' });
  expect(s.status).toBe(200); cookie = String(s.setCookie).split(';')[0]!;
  const ts = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000);
  for (const [symbol, close] of Object.entries({ ETH: 2000, LINK: 10 })) for (const source of ['coinbase', 'kraken']) await sql`insert into candles (source, symbol, interval, ts, open, high, low, close, volume) values (${source}, ${symbol}, '1h', ${ts}, ${close}, ${close}, ${close}, ${close}, 1)`;
  const c = await api('POST', '/agents', { name: 'Withdrawer', interval: '1h', capitalUsdc: '100', risk: RISK, network: NET, universe: ['ETH', 'LINK'] });
  expect(c.status, JSON.stringify(c.json)).toBe(200); agent = c.json;
}, 60_000);
afterAll(async () => { NETWORKS[NET]!.rpc = rpcBackup; await app?.close(); signerSrv?.close(); node?.close(); await sql?.end(); });
beforeEach(async () => { await sql`delete from agent_withdrawals`; Object.assign(chain, { nonce: chain.nonce + 1, latestNonce: chain.nonce + 1, receipts: {}, txs: {}, sent: [], broadcastFails: false, down: false, balances: { native: 10n ** 16n, [USDC.id]: 25_000_000n } }); cfg.broadcast = true; signs = 0; });

/** run the worker step until the withdrawal reaches `state` (a pass concludes nothing when the node answers late, e.g. on a loaded machine) */
async function settle(id: string, state: string, now?: number): Promise<any> {
  let w: any;
  for (let i = 0; i < 40; i++) { await wd.advanceWithdrawals(now); w = (await api('GET', `/agents/${agent.id}/withdrawals/${id}`)).json; if (w.state === state) return w; await new Promise((r) => setTimeout(r, 50)); }
  return w;
}

describe('agent vault withdrawal — a tracked operation', () => {
  it('signed → broadcast → confirmed only when the receipt succeeded AND the payment to the owner is in it', async () => {
    const r = await api('POST', `/agents/${agent.id}/withdraw`, { asset: USDC.id });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ ok: true, state: 'broadcast', symbol: 'USDC', amount: '25', arrived: false, confirmedAt: null });
    expect(r.json.explorer).toContain(r.json.txid); expect(chain.sent).toHaveLength(1); expect(signs).toBe(1);
    // not mined yet: still "broadcast", never "confirmed"
    await wd.advanceWithdrawals();
    expect((await api('GET', `/agents/${agent.id}/withdrawals/${r.json.id}`)).json).toMatchObject({ state: 'broadcast', arrived: false });
    // the node is down: nothing is concluded
    chain.down = true; await wd.advanceWithdrawals(); chain.down = false;
    expect((await api('GET', `/agents/${agent.id}/withdrawals/${r.json.id}`)).json.state).toBe('broadcast');
    chain.receipts[r.json.txid] = receiptOk(r.json, { token: USDC.id, value: 25_000_000n });
    await settle(r.json.id, 'confirmed');
    const done = (await api('GET', `/agents/${agent.id}/withdrawals`)).json;
    expect(done.withdrawals).toHaveLength(1);
    expect(done.withdrawals[0]).toMatchObject({ id: r.json.id, ok: true, state: 'confirmed', arrived: true, error: null });
    expect(done.withdrawals[0].confirmedAt).not.toBeNull();
    const types = (await sql`select type from audit_events where type like 'agent.withdraw%' order by seq`).map((x: any) => x.type);
    expect(types).toEqual(['agent.withdraw', 'agent.withdraw_confirmed']);
  });

  it('a double tap — sequential, concurrent, or a retry with the same idempotency key — signs ONCE and returns the same operation', async () => {
    const [a, b] = await Promise.all([api('POST', `/agents/${agent.id}/withdraw`, { asset: USDC.id, idempotencyKey: 'tap-0001' }), api('POST', `/agents/${agent.id}/withdraw`, { asset: USDC.id, idempotencyKey: 'tap-0001' })]);
    const c = await api('POST', `/agents/${agent.id}/withdraw`, { asset: USDC.id });
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(new Set([a.json.id, b.json.id, c.json.id]).size).toBe(1);
    expect(signs).toBe(1); expect(chain.sent).toHaveLength(1);
    expect([a.json.duplicate, b.json.duplicate].filter(Boolean)).toHaveLength(1); expect(c.json.duplicate).toBe(true);
    expect((await sql`select count(*)::int as n from agent_withdrawals`)[0].n).toBe(1);
    // once it is final, the same key still returns it (no second withdrawal); a new request without the key is a new operation
    // (the answer to the losing tap can be the row while it was still `requested`, without a txid yet: read it again)
    const cur = (await api('GET', `/agents/${agent.id}/withdrawals/${a.json.id}`)).json;
    expect(cur.txid).toMatch(/^0x[0-9a-f]{64}$/);
    chain.receipts[cur.txid] = receiptOk(cur, { token: USDC.id, value: 25_000_000n }); await settle(a.json.id, 'confirmed');
    expect((await api('POST', `/agents/${agent.id}/withdraw`, { asset: USDC.id, idempotencyKey: 'tap-0001' })).json).toMatchObject({ id: a.json.id, state: 'confirmed', duplicate: true });
    expect(signs).toBe(1);
  });

  it('broadcasting off: the answer is NOT ok — state not_sent, no explorer link, nothing relayed', async () => {
    cfg.broadcast = false;
    const r = await api('POST', `/agents/${agent.id}/withdraw`, { asset: USDC.id });
    expect(r.json).toMatchObject({ ok: false, state: 'not_sent', explorer: null, arrived: false });
    expect(r.json.error).toMatch(/broadcast is disabled/); expect(chain.sent).toHaveLength(0);
    expect((await api('GET', `/agents/${agent.id}/withdrawals`)).json).toMatchObject({ broadcast: false });
  });

  it('a revert is failed; a mined transaction that does not pay the owner is confirmed but NOT arrived; a replaced nonce is failed', async () => {
    const a = (await api('POST', `/agents/${agent.id}/withdraw`, { asset: USDC.id })).json;
    chain.receipts[a.txid] = receiptOk(a, { status: 0 }); await settle(a.id, 'failed');
    expect((await api('GET', `/agents/${agent.id}/withdrawals/${a.id}`)).json).toMatchObject({ ok: false, state: 'failed', arrived: false });
    const b = (await api('POST', `/agents/${agent.id}/withdraw`, { asset: USDC.id })).json;
    expect(b.id).not.toBe(a.id);
    chain.receipts[b.txid] = receiptOk(b, { token: USDC.id, value: 25_000_000n, to: '0x000000000000000000000000000000000000dEaD' }); await settle(b.id, 'confirmed');
    const bb = (await api('GET', `/agents/${agent.id}/withdrawals/${b.id}`)).json;
    expect(bb).toMatchObject({ state: 'confirmed', arrived: false }); expect(bb.error).toMatch(/not found in the transaction/);
    const c = (await api('POST', `/agents/${agent.id}/withdraw`, { asset: 'native' })).json;
    expect(c.state).toBe('broadcast');
    chain.latestNonce = chain.nonce + 1; await settle(c.id, 'failed');   // the vault's nonce moved on without this transaction
    expect((await api('GET', `/agents/${agent.id}/withdrawals/${c.id}`)).json).toMatchObject({ state: 'failed' });
  });

  it('native coin: arrival is read from the transaction itself (to = owner, value = amount)', async () => {
    const r = (await api('POST', `/agents/${agent.id}/withdraw`, { asset: 'native' })).json;
    chain.receipts[r.txid] = receiptOk(r);
    const [row] = await sql`select amount::text as amount from agent_withdrawals where id = ${r.id}`;
    chain.txs[r.txid] = { to: keys.addresses.evm, value: `0x${BigInt(row.amount).toString(16)}` };
    expect(await settle(r.id, 'confirmed')).toMatchObject({ state: 'confirmed', arrived: true });
  });

  it('a relay that fails keeps the withdrawal signed and retries; after ten minutes it is not_sent; a row stuck in requested fails', async () => {
    chain.broadcastFails = true;
    const r = (await api('POST', `/agents/${agent.id}/withdraw`, { asset: USDC.id })).json;
    expect(r).toMatchObject({ ok: false, state: 'signed', explorer: null });
    chain.broadcastFails = false;
    expect((await settle(r.id, 'broadcast')).state).toBe('broadcast');
    await sql`update agent_withdrawals set state = 'signed' where id = ${r.id}`; chain.broadcastFails = true;
    expect(await settle(r.id, 'not_sent', Date.now() + 11 * 60_000)).toMatchObject({ ok: false, state: 'not_sent' });
    await sql`insert into agent_withdrawals (id, agent_id, network, asset, symbol, decimals, amount, from_addr, to_addr, nonce, state, created_at) values (gen_random_uuid(), ${agent.id}, ${NET}, 'native', 'ETH', 18, 1, '0xa', '0xb', 1, 'requested', now() - interval '5 minutes')`;
    await wd.advanceWithdrawals();
    expect((await sql`select state, error from agent_withdrawals where asset = 'native'`)[0]).toMatchObject({ state: 'failed', error: 'interrupted during signing; nothing was sent' });
  });
});
