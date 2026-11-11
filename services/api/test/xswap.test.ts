// THORChain native swap life cycle against scripted THORNode operators and scripted chain adapters (no network): the real API
// routes, worker steps and signer process boundary. Database: postgres:///spw_test_xswap (create it once: `createdb spw_test_xswap`).
// What the real router and a real signed Bitcoin transaction look like is proven separately (scripts/sim-thorchain.mts).
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from './test-db.ts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NETWORKS, THORNODE_OPERATORS, thorVaultAddress, utxoPaymentTo, type Intent, type ThorVaultWant } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { createSignerServer } from '../../isolated-signer/src/server.ts';
import { Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';
import type { XswapObs, XswapState } from '../src/xswap-state.ts';

const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'd'.repeat(48);
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'); // public test vector, no funds
const ME_BTC = keys.addresses.bitcoin!, ME_EVM = keys.addresses.evm, owner = new TestPasskey(RP, ORIGIN);
const KEY = 'thorpub1addwnpepqgwpafz6l99mkevlz7spaezgzcxy5t2896hgm7e6kytqrkmulex4wxjp8az', KEY2 = 'thorpub1addwnpepqvlena222zluk5p3r0s9uey758rd43qedtxf2xalprynuaxp69rscr0jy4h';
const VAULT = thorVaultAddress(KEY, 'bitcoin');
const HOSTS = THORNODE_OPERATORS.map((o) => new URL(o.base).host);

/** The five operators, scripted. Index = position in THORNODE_OPERATORS. */
const net = {
  down: new Set<number>(), status: {} as Record<number, string>, behind: {} as Record<number, number>, halted: new Set<number>(), since: 900,
  quoteDown: new Set<number>(), expected: {} as Record<number, bigint>, memo: {} as Record<number, string>, minIn: '6000', streaming: 1, extraPool: null as string | null,
  reset() { this.down.clear(); this.status = {}; this.behind = {}; this.halted.clear(); this.since = 900; this.quoteDown = new Set([0]); this.expected = {}; this.memo = {}; this.minIn = '6000'; this.streaming = 1; this.extraPool = null; },
};
function thorFake(u: URL): { status: number; body: unknown } {
  const k = HOSTS.indexOf(u.host), p = u.pathname;
  if (net.down.has(k)) return { status: 503, body: { message: 'down' } };
  if (p.endsWith('/thorchain/lastblock')) return { status: 200, body: [{ chain: 'BTC', thorchain: 1000 - (net.behind[k] ?? 0) }] };
  if (p.endsWith('/thorchain/inbound_addresses')) return { status: 200, body: ['BTC', 'ETH'].map((chain) => ({ chain, pub_key: KEY, address: chain === 'BTC' ? VAULT : thorVaultAddress(KEY, 'ethereum'), ...(chain === 'ETH' ? { router: '0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146' } : {}),
    halted: chain === 'BTC' && net.halted.has(k), global_trading_paused: false, chain_trading_paused: false, gas_rate: chain === 'BTC' ? '3' : '15', dust_threshold: '1000', outbound_fee: '1059' })) };
  if (p.endsWith('/thorchain/vaults/asgard')) return { status: 200, body: [{ pub_key: KEY, status: net.status[k] ?? 'ActiveVault', status_since: net.since, chains: ['BTC', 'ETH'], membership: Array(19).fill('n') }, { pub_key: KEY2, status: 'ActiveVault', status_since: net.since, chains: ['BTC', 'ETH'], membership: Array(18).fill('n') }] };
  if (p.endsWith('/thorchain/pools')) return { status: 200, body: [{ asset: 'BTC.BTC', status: 'Available', short_code: 'b' }, { asset: 'ETH.ETH', status: 'Available', short_code: 'e' }, ...(net.extraPool ? [{ asset: net.extraPool, status: 'Available', short_code: 'e' }] : [])] };
  if (p.endsWith('/thorchain/quote/swap')) {
    if (net.quoteDown.has(k)) return { status: 400, body: { code: 3, message: 'refusing quote on node with stale state: invalid request' } };
    const q = u.searchParams, expected = net.expected[k] ?? 2_119_000n, limit = (expected * BigInt(10_000 - Number(q.get('liquidity_tolerance_bps')))) / 10_000n;
    return { status: 200, body: { memo: net.memo[k] ?? `=:e:${q.get('destination')}:${limit}`, expected_amount_out: expected.toString(), expiry: Math.floor(Date.now() / 1000) + 900, recommended_min_amount_in: net.minIn, dust_threshold: '1000', inbound_address: VAULT,
      max_streaming_quantity: net.streaming, total_swap_seconds: 606, fees: { asset: 'ETH.ETH', affiliate: '0', outbound: '12108', liquidity: '4269', total: '16377', slippage_bps: 19, total_bps: 76 } } };
  }
  return { status: 404, body: {} };
}

let app: any, sql: any, store: Store, signerSrv: Server, cookie = '', adapters: any, worker: any, xs: typeof import('../src/xswap.ts'), st: typeof import('../src/xswap-state.ts');
const realFetch = globalThis.fetch;
let coin = 0;
const signerVault = { refuse: null as string | null, calls: [] as ThorVaultWant[] };
const chain = { sent: [] as string[], track: { state: 'broadcast', confirmations: 0 } as any, vaultHolds: 7_000_000_000n, prepared: [] as any[] };

async function api(method: string, path: string, body?: unknown, idem?: string) {
  const r = await app.inject({ method, url: path, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), setCookie: r.headers['set-cookie'] as string | undefined };
}
const row = async (id: string) => (await sql`select * from proposals where id = ${id}`)[0];
const BODY = { fromNetwork: 'bitcoin', fromAsset: 'native', toNetwork: 'ethereum', toAsset: 'native', amount: '0.0006', slippageBps: 100 };
const prepare = (b: Record<string, unknown> = {}) => api('POST', '/api/v1/xswap/proposals', { ...BODY, ...b }, crypto.randomUUID());
async function send() {
  const prep = await prepare(); expect(prep.status, JSON.stringify(prep.json)).toBe(200);
  const id = prep.json.proposal.id as string;
  const ap = await api('POST', `/api/v1/transfers/proposals/${id}/approve`, { assertion: owner.assert(Buffer.from(prep.json.options.challenge, 'base64url')) });
  return { id, prep: prep.json, ap };
}
const OUT = 'AB'.repeat(32);
const deps = (o: { observed?: boolean; out?: 'OUT' | 'REFUND' | null; refundPlanned?: boolean; seen?: any; vaultActive?: boolean | null; agree?: boolean } = {}) => ({
  status: async (inTxid: string) => (o.agree === false ? null : { observed: !!o.observed, refundPlanned: !!o.refundPlanned, outs: o.out ? [{ id: OUT, chain: o.out === 'OUT' ? 'ETH' : 'BTC', to: 'x', memo: `${o.out}:${inTxid}` }] : [] }),
  vaultActive: async () => (o.vaultActive === undefined ? true : o.vaultActive),
  outboundSeen: async () => (o.seen === undefined ? null : o.seen),
});

beforeAll(async () => {
  globalThis.fetch = (async (input: any, init?: any) => { const u = new URL(String(input instanceof Request ? input.url : input)); if (!HOSTS.includes(u.host)) return realFetch(input, init); const r = thorFake(u); return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } }); }) as typeof fetch;
  const dir = mkdtempSync(join(tmpdir(), 'spw-xswap-api-'));
  store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('xswap-setup-token').digest('hex');
  // the signer has its OWN vault view (in production: its own fetches to its own operator list); scripted separately from the API's
  const vaults = { check: async (w: ThorVaultWant) => { signerVault.calls.push(w); if (signerVault.refuse) throw new Error(signerVault.refuse); return { operators: ['a', 'b', 'c'], silent: [], height: 1000, statusSince: 900, gasRate: 3n, dustThreshold: 1000n, outboundFee: 1059n, members: 19 }; } };
  signerSrv = createSignerServer(new Signer(keys, store, { rpId: RP, origin: ORIGIN }, undefined, undefined, undefined, vaults), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, DATABASE_URL: (await createTestDb('xswap')).url, SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`, SPW_BROADCAST: 'on', SPW_WORKERS: 'off' });
  const db = await import('../src/db.ts'); sql = db.sql;
  await sql.unsafe('drop schema public cascade; create schema public;'); await db.migrate();
  adapters = (await import('../src/chains/index.ts')).adapters;
  adapters.bitcoin.balances = async (a: string) => ({ native: a === VAULT ? chain.vaultHolds : 200_000n });
  adapters.bitcoin.prepare = async (d: any) => { chain.prepared.push(d); return { section: { btc: { inputs: [{ txid: (++coin).toString(16).padStart(64, 'c'), vout: 0, value: '200000' }], change: (200_000n - d.amount - 700n).toString(), fee: '700' } }, maxFee: 700n, feeEstimate: 700n, warnings: [], ttlSec: 240 }; };
  adapters.bitcoin.broadcast = async (raw: string) => { chain.sent.push(raw); };
  adapters.bitcoin.track = async () => chain.track;
  app = await (await import('../src/server.ts')).buildServer({ swapProviders: [] });
  worker = await import('../src/worker.ts'); xs = await import('../src/xswap.ts'); st = await import('../src/xswap-state.ts');
  const o = (await api('POST', '/api/v1/auth/setup/options', {})).json;
  const s = await api('POST', '/api/v1/auth/setup/verify', { challengeId: o.challengeId, response: owner.register(o.options.challenge), setupToken: 'xswap-setup-token' });
  expect(s.status, JSON.stringify(s.json)).toBe(200); cookie = String(s.setCookie).split(';')[0]!;
});
afterAll(async () => { globalThis.fetch = realFetch; await app?.close(); signerSrv?.close(); await sql?.end(); });
beforeEach(async () => {
  await sql`update proposals set state = 'failed' where state not in ('finalized', 'failed', 'expired', 'rejected', 'replaced')`;
  await sql`update proposals set xswap = jsonb_set(xswap, '{phase}', '"received"') where kind = 'xswap'`;
  store.state.spent = {}; store.save();
  net.reset(); signerVault.refuse = null; signerVault.calls = []; chain.sent = []; chain.track = { state: 'broadcast', confirmations: 0 }; chain.vaultHolds = 7_000_000_000n; chain.prepared = [];
});

describe('preparation', () => {
  it('is closed without a session, validates the pair and the amount', async () => {
    const saved = cookie; cookie = ''; expect((await prepare()).status).toBe(401); cookie = saved;
    expect((await api('POST', '/api/v1/xswap/proposals', BODY)).json.error).toBe('idempotency');
    for (const [b, code] of [[{ toNetwork: 'bitcoin' }, 'same_network'], [{ fromNetwork: 'dogecoin' }, 'xswap_not_enabled'], [{ toNetwork: 'base' }, 'xswap_not_enabled'], [{ fromNetwork: 'solana' }, 'xswap_not_enabled'],
      [{ amount: '0' }, 'bad_amount'], [{ amount: '0.01' }, 'insufficient_funds'], [{ amount: '0.0009' }, 'policy']] as const) expect((await prepare(b)).json.error, JSON.stringify(b)).toBe(code);
    expect((await prepare({ to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' })).status).toBe(400); // there is no recipient field
    expect((await api('GET', '/api/v1/xswap/execution')).json).toMatchObject({ enabled: true, provider: 'thorchain', minOperators: 3, operators: expect.arrayContaining([expect.objectContaining({ host: 'thornode.thorwallet.org' })]) });
  });
  it('commits to the vault key, its locally derived address and the memo THORChain itself expects; shows who confirmed', async () => {
    const r = await prepare(); expect(r.status, JSON.stringify(r.json)).toBe(200);
    const p = r.json.proposal, i = (await row(p.id)).intent as Intent;
    expect(p).toMatchObject({ kind: 'xswap', state: 'pending_approval', network: 'bitcoin', symbol: 'BTC', amount: '60000', to: VAULT, feeEstimate: '700' });
    expect(p.xswap).toMatchObject({ stage: 'review', toNetwork: 'ethereum', toSymbol: 'ETH', vault: VAULT, memo: `=:e:${ME_EVM}:2097810`, operators: ['liquify', 'rorcual', 'ibs', 'thorwallet', 'keplr'], quoteOperators: ['rorcual', 'ibs', 'thorwallet', 'keplr'],
      vaultMembers: 19, churnHeight: 900, expectedOutDisplay: '0.02119', minOutDisplay: '0.0209781', outboundFeeDisplay: '0.00012108', estimatedSeconds: 606, evidenceMultiple: 116666 });
    expect(i.to).toBe(VAULT); expect(i.xswap).toMatchObject({ provider: 'thorchain', vault: VAULT, vaultPubKey: KEY, memo: `=:e:${ME_EVM}:2097810`, limit: '2097810', minOut: '20978100000000000', router: '', approveGas: '0' });
    expect(i.xswap!.expiry - i.createdAt).toBe(900); expect(i.expiresAt - i.createdAt).toBe(120);
    expect(Buffer.from(r.json.options.challenge, 'base64url').toString('hex')).toBe(p.intentHash); // the passkey approves exactly this intent
    expect(chain.prepared[0]).toMatchObject({ to: VAULT, amount: 60_000n, thor: { extraBytes: 9 + 2 + `=:e:${ME_EVM}:2097810`.length, minRate: 3 } }); // THORChain's fee rate, room for the memo, change forced
  });
  it('keeps the LOWEST quote when operators differ a little, and refuses when they differ by more than 1 %', async () => {
    net.expected = { 1: 2_119_000n, 2: 2_110_000n };
    expect((await prepare()).json.proposal.xswap.memo).toBe(`=:e:${ME_EVM}:2088900`);
    net.expected = { 1: 2_119_000n, 2: 2_090_000n };
    expect((await prepare()).json).toMatchObject({ error: 'quotes_disagree' });
  });
  it.each<[string, () => void, number, string]>([
    ['one operator does not list the vault as active', () => { net.status = { 3: 'RetiringVault' }; }, 503, 'vault_unconfirmed'],
    ['one operator is far behind', () => { net.behind = { 1: 80 }; }, 503, 'vault_unconfirmed'],
    ['one operator reports the chain halted', () => { net.halted.add(2); }, 503, 'vault_unconfirmed'],
    ['only two operators answer', () => { net.down = new Set([0, 1, 4]); }, 503, 'vault_unconfirmed'],
    ['only one operator quotes', () => { net.quoteDown = new Set([0, 1, 2, 3]); }, 503, 'provider_unavailable'],
    ['an operator expects another memo (another destination)', () => { net.memo = { 2: '=:e:0x70997970C51812dc3A010C7d01b50e0d17dc79C8:2097810' }; }, 502, 'provider_bad_answer'],
    ['an operator expects a streaming memo', () => { net.memo = { 2: `=:e:${ME_EVM}:2097810/1/0` }; }, 502, 'provider_bad_answer'],
    ['THORChain would stream the amount', () => { net.streaming = 4; }, 422, 'amount_would_stream'],
    ['the amount is below THORChain\'s minimum (a refund could not pay its fee)', () => { net.minIn = '70000'; }, 422, 'below_minimum'],
    ['another pool could be designated by the memo spelling', () => { net.extraPool = 'ETH.ETH-0X1111111111111111111111111111111111111111'; }, 503, 'pool_ambiguous'],
    ['the chain shows the "vault" holding less than 100 times the amount', () => { chain.vaultHolds = 5_000_000n; }, 503, 'vault_evidence'],
  ])('refuses when %s', async (_l, arrange, status, code) => {
    arrange(); const r = await prepare();
    expect(r.status, JSON.stringify(r.json)).toBe(status); expect(r.json.error).toBe(code);
    expect(await sql`select 1 from proposals where kind = 'xswap' and state = 'pending_approval'`).toHaveLength(0);
  });
});

describe('sending', () => {
  it('signer signs, API re-checks the vault, relays once; one operation in flight on the source network until the outcome is known', async () => {
    const { id, ap } = await send(); expect(ap.status, JSON.stringify(ap.json)).toBe(200);
    expect(ap.json).toMatchObject({ state: 'broadcast', xswap: { stage: 'sent', phase: 'sent' } });
    expect(chain.sent).toHaveLength(1); expect(signerVault.calls).toEqual([{ chain: 'BTC', vaultPubKey: KEY, router: null, amount: '60000' as never }].map((w) => ({ ...w, amount: 60_000n })));
    expect(utxoPaymentTo(chain.sent[0]!, 'bitcoin', VAULT)).toMatchObject({ paid: 60_000n, memo: `=:e:${ME_EVM}:2097810` });
    expect(utxoPaymentTo(chain.sent[0]!, 'bitcoin', ME_BTC).paid).toBe(139_300n);
    expect((await prepare()).json.error).toBe('pending_tx');
    chain.track = { state: 'finalized', confirmations: 6, blockRef: 'b' }; await worker.reconcile();
    expect((await row(id)).state).toBe('finalized');
    expect((await prepare()).json.error).toBe('pending_tx'); // the source is final, the swap is not: still one at a time
    const types = (await sql`select type from audit_events order by seq`).map((r: any) => r.type);
    expect(types).toEqual(expect.arrayContaining(['xswap.prepared', 'transfer.signed', 'transfer.broadcast']));
    expect((await api('GET', '/api/v1/activity')).json.items.find((x: any) => x.id === id)).toMatchObject({ kind: 'swap', xswap: { stage: 'sent' } });
  });
  it('the signer\'s own operators refuse: nothing is signed, nothing is sent', async () => {
    signerVault.refuse = 'THORNode operator ibs does not list this vault; the vault is not confirmed';
    const { id, ap } = await send();
    expect(ap.status).toBe(422); expect(ap.json.error).toBe('signer_vault_unconfirmed'); expect(ap.json.message).toMatch(/does not list this vault/);
    expect((await row(id)).state).toBe('failed'); expect(chain.sent).toHaveLength(0); expect(store.state.spent).toEqual({});
  });
  it('churn between approval and relay: the signed transaction is NOT sent', async () => {
    const prep = await prepare(); const id = prep.json.proposal.id;
    net.status = { 0: 'RetiringVault', 1: 'RetiringVault', 2: 'RetiringVault', 3: 'RetiringVault', 4: 'RetiringVault' }; // the API's view changes; the signer signed a moment before
    const ap = await api('POST', `/api/v1/transfers/proposals/${id}/approve`, { assertion: owner.assert(Buffer.from(prep.json.options.challenge, 'base64url')) });
    expect(ap.json).toMatchObject({ state: 'failed', error: expect.stringMatching(/vault is no longer confirmed.*nothing was sent/) });
    expect(chain.sent).toHaveLength(0);
  });
  it('a new churn height for the same key also stops the relay; unreachable operators only delay it, and the window closes it', async () => {
    let prep = await prepare(); net.since = 950;
    let ap = await api('POST', `/api/v1/transfers/proposals/${prep.json.proposal.id}/approve`, { assertion: owner.assert(Buffer.from(prep.json.options.challenge, 'base64url')) });
    expect(ap.json).toMatchObject({ state: 'failed', error: expect.stringMatching(/churn/) });
    await sql`update proposals set state = 'failed' where id = ${prep.json.proposal.id}`; net.reset(); store.state.spent = {}; store.save();
    prep = await prepare(); const id = prep.json.proposal.id; net.down = new Set([0, 1, 2]);
    ap = await api('POST', `/api/v1/transfers/proposals/${id}/approve`, { assertion: owner.assert(Buffer.from(prep.json.options.challenge, 'base64url')) });
    expect(ap.json.state).toBe('signed'); expect(chain.sent).toHaveLength(0);
    await worker.reconcile(); expect((await row(id)).state).toBe('signed'); // still waiting for three operators
    await sql`update proposals set xswap = jsonb_set(xswap, '{expiry}', ${String(Math.floor(Date.now() / 1000) + 100)}::jsonb) where id = ${id}`; // three minutes before expiry: too late
    net.down.clear(); await worker.reconcile();
    expect(await row(id)).toMatchObject({ state: 'failed', error: expect.stringMatching(/in time; nothing was sent/) }); expect(chain.sent).toHaveLength(0);
  });
  it('a transaction that left the mempool is not relayed again late in its window', async () => {
    const { id } = await send(); expect(chain.sent).toHaveLength(1);
    chain.track = { state: 'broadcast', confirmations: 0, rebroadcast: true };
    await sql`update proposals set last_broadcast_at = now() - interval '2 minutes' where id = ${id}`; await worker.reconcile(); expect(chain.sent).toHaveLength(2); // early: relayed again
    await sql`update proposals set last_broadcast_at = now() - interval '2 minutes', xswap = jsonb_set(xswap, '{expiry}', ${String(Math.floor(Date.now() / 1000) + 60)}::jsonb) where id = ${id}`;
    await worker.reconcile(); expect(chain.sent).toHaveLength(2);
  });
});

describe('tracking (resumes from the stored row; "received" only from the wallet\'s own chain data)', () => {
  it('sent → observed → outbound → received, each step from a freshly loaded row', async () => {
    const { id } = await send(); chain.track = { state: 'finalized', confirmations: 6, blockRef: 'b' }; await worker.reconcile();
    const step = async (d: ReturnType<typeof deps>) => { await sql`update proposals set xswap = jsonb_set(xswap, '{nextAt}', '0') where id = ${id}`; return xs.advanceXswap(await row(id), d); }; // as after a restart
    expect((await step(deps({ agree: false }))).xswap).toMatchObject({ phase: 'sent', polls: 1 }); // operators disagree or are down: nothing moves
    expect((await step(deps())).xswap).toMatchObject({ phase: 'sent' });
    expect((await step(deps({ observed: true }))).xswap).toMatchObject({ phase: 'observed' });
    expect((await step(deps({ observed: true, out: 'OUT' }))).xswap).toMatchObject({ phase: 'outbound', outTxid: OUT, outKind: 'out' }); // named by THORChain, not yet seen by the wallet
    expect((await api('GET', `/api/v1/transfers/proposals/${id}`)).json).toMatchObject({ xswap: { stage: 'outbound', receivedDisplay: null }, swap: { received: null } });
    expect((await step(deps({ observed: true, out: 'OUT', seen: { amount: 21_100_000_000_000_000n, confirmed: false } }))).xswap!.phase).toBe('outbound'); // unconfirmed is not received
    const done = await step(deps({ observed: true, out: 'OUT', seen: { amount: 21_100_000_000_000_000n, confirmed: true } }));
    expect(done.xswap).toMatchObject({ phase: 'received', received: '21100000000000000', hold: null });
    expect((await api('GET', `/api/v1/transfers/proposals/${id}`)).json).toMatchObject({ xswap: { stage: 'received', receivedDisplay: '0.0211', done: true }, swap: { received: '21100000000000000' } });
    expect((await prepare()).status).toBe(200); // the network is free again
    const types = (await sql`select type from audit_events order by seq`).map((r: any) => r.type);
    expect(types.slice(-3)).toEqual(expect.arrayContaining(['xswap.received'])); expect(types).toEqual(expect.arrayContaining(['xswap.observed', 'xswap.outbound']));
  });
  it('a refund is shown as refunded, never as received', async () => {
    const { id } = await send(); chain.track = { state: 'finalized', confirmations: 6, blockRef: 'b' }; await worker.reconcile();
    const step = async (d: ReturnType<typeof deps>) => { await sql`update proposals set xswap = jsonb_set(xswap, '{nextAt}', '0') where id = ${id}`; return xs.advanceXswap(await row(id), d); };
    await step(deps({ observed: true, refundPlanned: true }));
    expect((await api('GET', `/api/v1/transfers/proposals/${id}`)).json.xswap).toMatchObject({ stage: 'observed', refundPlanned: true });
    const r = await step(deps({ observed: true, out: 'REFUND', seen: { amount: 58_900n, confirmed: true } }));
    expect(r.xswap).toMatchObject({ phase: 'refunded', refunded: '58900', outKind: 'refund' }); expect(r.xswap!.received).toBeUndefined(); expect(r.out_amount).toBeNull();
    expect((await api('GET', `/api/v1/transfers/proposals/${id}`)).json).toMatchObject({ xswap: { stage: 'refunded', refundedDisplay: '0.000589', receivedDisplay: null }, swap: { received: null } });
  });
  it('a row left in "sending" by a process that died after the relay is picked up', async () => {
    const { id } = await send();
    await sql`update proposals set xswap = jsonb_set(xswap, '{phase}', '"sending"') where id = ${id}`;
    expect((await xs.advanceXswap(await row(id), deps({ observed: true }))).xswap!.phase).toBe('observed');
  });
});

describe('the rules, without I/O', () => {
  const b0 = (o: Partial<XswapState> = {}): XswapState => ({ provider: 'thorchain', toNetwork: 'ethereum', toAsset: 'native', toSymbol: 'ETH', toDecimals: 18, expectedOut: '21190000000000000', minOut: '20978100000000000', limit1e8: '2097810', memo: 'm', vault: VAULT, vaultPubKey: KEY,
    router: null, expiry: 2_000_000_000, outboundFee: '1', liquidityFee: '1', estimatedSeconds: 606, slippageBps: 100, operators: [], quoteOperators: [], churnHeight: 900, vaultMembers: 19, evidence: { holds: '1', multiple: 1, transfersOut: null }, needsApproval: false, simulated: false,
    phase: 'sent', polls: 0, nextAt: 0, sentAt: 1_000_000, ...o });
  const obs = (o: Partial<XswapObs> = {}): XswapObs => ({ now: 1_000_000, sourceState: 'finalized', status: { observed: false, refundPlanned: false, outs: [] }, ...o });
  const IN = 'CD'.repeat(32), out = (memo: string) => [{ id: OUT, chain: 'ETH', to: 'x', memo }];
  it('churn while the source transaction is unconfirmed raises a hold, and it clears when the deposit is observed', () => {
    const a = st.xswapNext(b0(), obs({ sourceState: 'broadcast', vaultActive: false }), IN);
    expect(a.b).toMatchObject({ phase: 'sent', hold: 'vault_churned' }); expect(a.events).toEqual([['xswap.hold', { hold: 'vault_churned' }]]);
    expect(st.xswapNext(a.b, obs({ sourceState: 'broadcast', vaultActive: false }), IN).events).toEqual([]); // said once
    expect(st.xswapNext(b0(), obs({ sourceState: 'broadcast', vaultActive: null }), IN).b.hold ?? null).toBeNull(); // operators unreachable is not a churn
    expect(st.xswapNext(a.b, obs({ status: { observed: true, refundPlanned: false, outs: [] } }), IN).b).toMatchObject({ phase: 'observed', hold: null });
  });
  it('a deposit THORChain never reports, an outbound it never sends, an outbound the wallet never sees: holds, never success, never given up', () => {
    const late = 1_000_000 + 4 * 3600_000;
    expect(st.xswapNext(b0(), obs({ now: late }), IN).b).toMatchObject({ phase: 'sent', hold: 'not_observed' });
    expect(st.xswapNext(b0(), obs({ now: late, status: null }), IN).b).toMatchObject({ phase: 'sent', hold: 'not_observed' });
    expect(st.xswapNext(b0({ phase: 'observed', observedAt: 1_000_000 }), obs({ now: late, status: { observed: true, refundPlanned: false, outs: [] } }), IN).b).toMatchObject({ phase: 'observed', hold: 'outbound_late' });
    const o = st.xswapNext(b0({ phase: 'outbound', outTxid: OUT, outKind: 'out', outboundAt: 1_000_000 }), obs({ now: late, seen: null }), IN).b;
    expect(o).toMatchObject({ phase: 'outbound', hold: 'outbound_not_seen' }); expect(o.nextAt).toBeGreaterThan(late); expect(o.received).toBeUndefined();
  });
  it('the status endpoint alone never makes a swap "received"', () => {
    const r = st.xswapNext(b0({ phase: 'observed', observedAt: 1_000_000 }), obs({ status: { observed: true, refundPlanned: false, outs: out(`OUT:${IN}`) } }), IN);
    expect(r.b.phase).toBe('outbound'); expect(st.xswapTerminal(r.b)).toBe(false);
    expect(st.xswapNext(r.b, obs({ seen: 'mismatch' }), IN).b).toMatchObject({ phase: 'outbound', hold: 'outbound_mismatch' }); // the named transaction does not pay the wallet
    expect(st.xswapNext(r.b, obs({ seen: { amount: 1n, confirmed: true } }), IN).b).toMatchObject({ phase: 'received', received: '1', hold: 'below_minimum' });
  });
  it('an outbound for another deposit is ignored; a refund wins over an OUT of the same deposit', () => {
    const s = (memos: string[]) => st.xswapNext(b0({ phase: 'observed', observedAt: 1_000_000 }), obs({ status: { observed: true, refundPlanned: false, outs: memos.flatMap(out) } }), IN).b;
    expect(s([`OUT:${'EE'.repeat(32)}`]).phase).toBe('observed'); expect(s([`OUT:${IN}`, `REFUND:${IN}`])).toMatchObject({ phase: 'outbound', outKind: 'refund' });
  });
  it('two operators must give the same status; the most advanced agreed one is used', () => {
    const raw = (observed: boolean, outs: any[] = []) => ({ stages: { inbound_observed: { completed: observed } }, out_txs: outs, planned_out_txs: [{ refund: false }] });
    const a = xs.reduceThorStatus(raw(true)), b = xs.reduceThorStatus(raw(true, [{ id: OUT.toLowerCase(), chain: 'ETH', to_address: 'x', memo: `OUT:${IN}` }])), c = xs.reduceThorStatus(raw(false));
    expect(xs.agreeThorStatus([a, b, c])).toBeNull(); expect(xs.agreeThorStatus([a, a, b])).toEqual(a); expect(xs.agreeThorStatus([a, a, b, b])).toEqual(b); expect(xs.agreeThorStatus([])).toBeNull();
    expect(b.outs[0]!.id).toBe(OUT); expect(xs.reduceThorStatus(raw(true, [{ id: '0'.repeat(64), chain: 'THOR', to_address: 'x', memo: 'OUT:x' }])).outs).toEqual([]);
    expect(() => xs.reduceThorStatus({ stages: {} })).toThrow();
  });
});
