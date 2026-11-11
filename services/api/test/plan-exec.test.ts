// The plan saga through the REAL API routes, worker steps and signer process boundary, against scripted chains, a scripted
// attestation service and scripted leg quotes (no network). A plan "USDC on Base → LINK on Arbitrum" is "bridge then swap":
// its first leg is a real CCTP proposal walked to the mint; its second leg is refused by the swap route's own guard (the
// scripted chain carries no reviewed router), which is exactly what must pause a plan. What the real contracts and the real
// KyberSwap do is proven on forks (scripts/fork-plan.mts). Database: spw_test_plan, created here.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, keccak256, numberToHex, pad, parseTransaction, toFunctionSelector, type Hex } from 'viem';
import { CCTP_ABI, CCTP_ENABLED, CCTP_MESSAGE_TRANSMITTER, CCTP_TOKEN_MESSENGER, CCTP_TOKEN_MINTER, cctpBytes32, EIP1967_IMPLEMENTATION_SLOT, encodeCctpMessage, NETWORKS, type Intent } from '@spw/core';
import { assetKey, type AssetRef, type LegQuote, type PlanLegSpec } from '@spw/swap';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { createSignerServer } from '../../isolated-signer/src/server.ts';
import { Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';

const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'p'.repeat(48), DB = 'spw_test_plan';
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), ME = keys.addresses.evm;
const owner = new TestPasskey(RP, ORIGIN);
const CODE = JSON.parse(readFileSync(new URL('./fixtures/cctp-code.json', import.meta.url), 'utf8')) as Record<string, string>; // real mainnet bytecode, so the pinned hashes are exercised
const tok = (n: string, s: string) => NETWORKS[n]!.tokens.find((t) => t.symbol === s)!.id;
const USDC_B: AssetRef = { network: 'base', asset: tok('base', 'USDC') }, USDC_A: AssetRef = { network: 'arbitrum', asset: tok('arbitrum', 'USDC') }, LINK_A: AssetRef = { network: 'arbitrum', asset: tok('arbitrum', 'LINK') };
const K = (a: AssetRef) => `${a.network}:${a.asset}`;
const SEL = { allowance: '0xdd62ed3e', used: toFunctionSelector('usedNonces(bytes32)'), minFee: toFunctionSelector('getMinFeeAmount(uint256)'), burn: '0x8e0250ee', receive: '0x57ecfd28' };
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** One scripted EVM chain behind a JSON-RPC endpoint (the CCTP part of services/api/test/bridge.test.ts). */
class Chain {
  head = 1000; nonce = 0; native = 10n ** 17n; allowance = 0n; pending: { hash: string; raw: string }[] = []; receipts = new Map<string, any>(); used = new Set<string>(); implSlot: Record<string, string>;
  constructor(public id: string) { const p = CCTP_ENABLED[id]!; this.implSlot = { [CCTP_TOKEN_MESSENGER.toLowerCase()]: p.messengerImpl.address, [CCTP_MESSAGE_TRANSMITTER.toLowerCase()]: p.transmitterImpl.address }; }
  mine(blocks = 20) {
    for (const t of this.pending) {
      const tx = parseTransaction(t.raw as Hex); this.head += 1; this.nonce = Math.max(this.nonce, tx.nonce! + 1);
      const logs: any[] = [];
      if (tx.to?.toLowerCase() === CCTP_MESSAGE_TRANSMITTER.toLowerCase()) {
        const [message] = decodeFunctionData({ abi: CCTP_ABI, data: tx.data! }).args as [Hex, Hex];
        const nonce = message.slice(2 + 24, 2 + 24 + 64), amount = BigInt('0x' + message.slice(2 + (148 + 68) * 2, 2 + (148 + 100) * 2)), fee = BigInt('0x' + message.slice(2 + (148 + 164) * 2, 2 + (148 + 196) * 2));
        this.used.add(nonce);
        logs.push({ address: tok(this.id, 'USDC'), topics: [TRANSFER, pad('0x0', { size: 32 }), pad(ME as Hex, { size: 32 }).toLowerCase()], data: numberToHex(amount - fee, { size: 32 }) });
      }
      this.receipts.set(t.hash, { status: '0x1', blockNumber: numberToHex(this.head), blockHash: keccak256(t.hash as Hex), transactionHash: t.hash, logs });
    }
    this.pending = []; this.head += blocks;
  }
  rpc(method: string, p: any[]): unknown {
    const err = (message: string) => { throw new Error(message); };
    switch (method) {
      case 'eth_chainId': return numberToHex(Number(NETWORKS[this.id]!.chainRef));
      case 'eth_blockNumber': return numberToHex(this.head);
      case 'eth_getBlockByNumber': return { number: numberToHex(this.head), baseFeePerGas: '0x989680' };
      case 'eth_maxPriorityFeePerGas': return '0xf4240';
      case 'eth_getBalance': return numberToHex(this.native);
      case 'eth_getTransactionCount': return numberToHex(p[1] === 'pending' ? this.nonce + this.pending.length : this.nonce);
      case 'eth_getCode': { const a = String(p[0]).toLowerCase();
        if (a === CCTP_TOKEN_MESSENGER.toLowerCase() || a === CCTP_MESSAGE_TRANSMITTER.toLowerCase()) return CODE.proxy;
        if (a === CCTP_TOKEN_MINTER.toLowerCase()) return CODE.minter;
        return CODE[a] ?? '0x'; }
      case 'eth_getStorageAt': return p[1] === EIP1967_IMPLEMENTATION_SLOT ? pad((this.implSlot[String(p[0]).toLowerCase()] ?? '0x0') as Hex, { size: 32 }).toLowerCase() : pad('0x0', { size: 32 });
      case 'eth_estimateGas': case 'eth_call': { const d = String(p[0].data), sel = d.slice(0, 10);
        if (sel === SEL.allowance) return numberToHex(this.allowance, { size: 32 });
        if (sel === SEL.used) return numberToHex(this.used.has(d.slice(10, 74)) ? 1 : 0, { size: 32 });
        if (sel === SEL.burn) return this.allowance < 1n ? err('execution reverted: ERC20: transfer amount exceeds allowance') : method === 'eth_call' ? '0x' : '0x1a000';
        if (sel === SEL.receive) return method === 'eth_call' ? encodeAbiParameters([{ type: 'bool' }], [true]) : '0x2a000';
        return err('execution reverted'); }
      case 'eth_sendRawTransaction': { const hash = keccak256(p[0] as Hex); if (!this.pending.some((x) => x.hash === hash) && !this.receipts.has(hash)) this.pending.push({ hash, raw: p[0] });
        const tx = parseTransaction(p[0] as Hex); if (tx.to?.toLowerCase() === tok(this.id, 'USDC').toLowerCase()) this.allowance = 10n ** 30n;
        return hash; }
      case 'eth_getTransactionReceipt': return this.receipts.get(String(p[0])) ?? null;
      case 'eth_getLogs': return [];
      default: return err(`unscripted ${method}`);
    }
  }
}
const chains: Record<string, Chain> = {};
const iris = { messages: new Map<string, unknown>() };
// the scripted market of the plan quotes, and the scripted balances the planner reads
const market = { linkPerUsdc: 100_000_000_000n /* 1 USDC (6 dec) → 0.1 LINK (18 dec) */, quotes: 0 };
const balances = new Map<string, bigint>();
const quoteLeg = () => async (leg: PlanLegSpec, amountIn: bigint): Promise<LegQuote | null> => {
  market.quotes += 1;
  const gas = (network: string) => ({ kind: 'network' as const, asset: { network, asset: 'native' }, amount: 20_000_000_000_000n, includedInOutput: false, estimated: true });
  if (leg.kind === 'bridge') { const fee = leg.speed === 'fast' ? (amountIn * 13n + 99_999n) / 100_000n : 0n; return { amountOut: amountIn - fee, minAmountOut: amountIn - fee, seconds: leg.speed === 'fast' ? 8 : 1140, fees: [{ kind: 'protocol', asset: leg.to, amount: fee, includedInOutput: true, estimated: false }, gas(leg.from.network), gas(leg.to.network)] }; }
  const out = amountIn * market.linkPerUsdc;
  return { amountOut: out, minAmountOut: (out * 995n) / 1000n, seconds: 45, fees: [gas(leg.from.network)] };
};
let fake: Server, signerSrv: Server, app: any, sql: any, worker: any, bridge: any, plans: any, cookie = '', store: Store;

async function api(method: string, path: string, body?: unknown, idem?: string) {
  const r = await app.inject({ method, url: path, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), setCookie: r.headers['set-cookie'] as string | undefined };
}
const row = async (id: string) => (await sql`select * from proposals where id = ${id}`)[0];
const getPlan = async (id: string) => (await api('GET', `/api/v1/plans/${id}`)).json;
const quote = async (from: AssetRef, to: AssetRef, amount: string) => (await api('POST', '/api/v1/plans/quote', { from: K(from), to: K(to), amount, slippageBps: 50 })).json;
async function create(amount = '10', o: { floor?: string; speed?: 'standard' | 'fast' } = {}) {
  const q = await quote(USDC_B, LINK_A, amount), p = q.plans.find((x: any) => x.legs[0].speed === (o.speed ?? 'standard'));
  const r = await api('POST', '/api/v1/plans', { from: K(USDC_B), to: K(LINK_A), amount, slippageBps: 50, plan: p.id, ...(o.floor ? { floor: o.floor } : {}) });
  return { r, quoted: p };
}
const approve = (prep: any) => api('POST', `/api/v1/transfers/proposals/${prep.proposal.id}/approve`, { assertion: owner.assert(Buffer.from(prep.options.challenge, 'base64url')) });
/** what Circle would attest for this burn */
function attested(i: Intent) {
  const b = i.bridge!, m = cctpBytes32(CCTP_TOKEN_MESSENGER);
  const message = encodeCctpMessage({ version: 1, sourceDomain: CCTP_ENABLED[i.network]!.domain, destinationDomain: b.toDomain, nonce: createHash('sha256').update(i.proposalId).digest('hex'), sender: m, recipient: m, destinationCaller: '0'.repeat(64), minFinalityThreshold: b.minFinalityThreshold,
    finalityThresholdExecuted: b.minFinalityThreshold, body: { version: 1, burnToken: cctpBytes32(i.asset), mintRecipient: cctpBytes32(i.from), amount: BigInt(i.amount), messageSender: cctpBytes32(i.from), maxFee: BigInt(b.maxFee), feeExecuted: 0n, expirationBlock: 0n } });
  return { messages: [{ status: 'complete', message, attestation: `0x${'33'.repeat(130)}`, cctpVersion: 2, delayReason: null }] };
}
const tick = async () => { await worker.reconcile(); await sql`update proposals set bridge = jsonb_set(bridge, '{nextAt}', '0') where kind = 'bridge'`; await bridge.advanceBridges(); await plans.advancePlans(); };

beforeAll(async () => {
  const admin = postgres('postgres:///postgres', { max: 1, onnotice: () => {} });
  if ((await admin`select 1 from pg_database where datname = ${DB}`).length === 0) await admin.unsafe(`create database ${DB}`).catch((e: Error) => { if (!/already exists/.test(e.message)) throw e; });
  await admin.end();
  for (const id of ['base', 'arbitrum']) chains[id] = new Chain(id);
  fake = createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      const send = (code: number, o: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const url = new URL(req.url!, 'http://x');
      if (url.pathname.startsWith('/rpc/')) { const j = JSON.parse(body); try { send(200, { jsonrpc: '2.0', id: j.id, result: chains[url.pathname.slice(5)]!.rpc(j.method, j.params) }); } catch (e) { send(200, { jsonrpc: '2.0', id: j.id, error: { code: 3, message: (e as Error).message } }); } return; }
      if (url.pathname.startsWith('/v2/burn/USDC/fees/')) return send(200, [{ finalityThreshold: 1000, minimumFee: 1.3 }, { finalityThreshold: 2000, minimumFee: 0 }]);
      if (url.pathname === '/v2/fastBurn/USDC/allowance') return send(200, { allowance: 5e7 });
      if (url.pathname.startsWith('/v2/messages/')) { const m = iris.messages.get(url.searchParams.get('transactionHash') ?? ''); return m ? send(200, m) : send(404, { error: 'Message not found for provided parameters' }); }
      send(404, {});
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => fake.once('listening', r));
  const base = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  const dir = mkdtempSync(join(tmpdir(), 'spw-plan-api-'));
  store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('plan-setup-token').digest('hex');
  signerSrv = createSignerServer(new Signer(keys, store, { rpId: RP, origin: ORIGIN }), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, DATABASE_URL: `postgres:///${DB}`, SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`,
    SPW_BROADCAST: 'on', SPW_WORKERS: 'off', SPW_IRIS_OVERRIDE: base, SPW_RPC_OVERRIDE: JSON.stringify({ base: [`${base}/rpc/base`, `${base}/rpc/base`], arbitrum: [`${base}/rpc/arbitrum`, `${base}/rpc/arbitrum`] }) });
  const warn = console.warn; console.warn = () => {};
  const db = await import('../src/db.ts'); sql = db.sql;
  await sql.unsafe('drop schema public cascade; create schema public;'); await db.migrate();
  await import('../src/rpc-override.ts');
  const adapters = (await import('../src/chains/index.ts')).adapters;
  adapters.base!.balances = async () => ({ native: chains.base!.native, [USDC_B.asset]: balances.get(assetKey(USDC_B)) ?? 0n });
  app = await (await import('../src/server.ts')).buildServer({ swapProviders: [], plan: { providers: [], quoteLeg, balance: async (a: AssetRef) => balances.get(assetKey(a)) ?? null } });
  console.warn = warn;
  worker = await import('../src/worker.ts'); bridge = await import('../src/bridge.ts'); plans = await import('../src/plan-exec.ts');
  const o = (await api('POST', '/api/v1/auth/setup/options', {})).json;
  const s = await api('POST', '/api/v1/auth/setup/verify', { challengeId: o.challengeId, response: owner.register(o.options.challenge), setupToken: 'plan-setup-token' });
  expect(s.status, JSON.stringify(s.json)).toBe(200); cookie = String(s.setCookie).split(';')[0]!;
});
afterAll(async () => { await app?.close(); signerSrv?.close(); fake?.close(); await sql?.end(); });
beforeEach(async () => {
  await sql`update plans set state = 'stopped' where state in ('active', 'paused')`;
  await sql`update proposals set state = 'failed' where state not in ('finalized', 'failed', 'expired', 'rejected', 'replaced')`;
  await sql`update proposals set bridge = jsonb_set(bridge, '{phase}', '"done"') where kind = 'bridge'`;
  store.state.spent = {}; store.save();
  for (const c of Object.values(chains)) { c.mine(); c.native = 10n ** 17n; }
  chains.base!.allowance = 0n; market.linkPerUsdc = 100_000_000_000n;
  balances.clear(); for (const [a, v] of [[USDC_B, 100_000000n], [USDC_A, 0n], [{ network: 'base', asset: 'native' }, 10n ** 17n], [{ network: 'arbitrum', asset: 'native' }, 10n ** 17n]] as const) balances.set(assetKey(a), v);
});

describe('planning through the API', () => {
  it('is closed without a session; prices candidate plans with a quote for every leg; says why a pair has no plan', async () => {
    const saved = cookie; cookie = '';
    expect((await api('POST', '/api/v1/plans/quote', { from: K(USDC_B), to: K(LINK_A), amount: '10' })).status).toBe(401);
    expect((await api('GET', '/api/v1/plans')).status).toBe(401);
    cookie = saved;
    const q = await quote(USDC_B, LINK_A, '10');
    expect(q.notExecutable).toBeNull();
    expect(q.plans.map((p: any) => [p.legs.map((l: any) => `${l.kind}${l.speed ? `:${l.speed}` : ''}`).join('>'), p.executable, p.expectedOutDisplay, p.worstOutDisplay, p.approvals])).toEqual([
      ['bridge:standard>swap', true, '1', '0.995', 2], ['bridge:fast>swap', true, '0.99987', '0.99487065', 2]]);    // ranked on the guaranteed worst case
    expect(q.plans[0].legs.map((l: any) => l.label)).toEqual(['Circle CCTP', 'KyberSwap']);
    expect(q.plans[0].requirements.gas.map((g: any) => [g.networkName, g.symbol, g.needDisplay, g.ok])).toEqual([['Base', 'ETH', '0.00004', true], ['Arbitrum One', 'ETH', '0.00008', true]]);
    expect(q.plans[0].requirements.limits.map((l: any) => [l.leg, l.symbol, l.networkName, l.needDisplay, l.perTransferDisplay, l.ok])).toEqual([[0, 'USDC', 'Base', '10', '50', true], [1, 'USDC', 'Arbitrum One', '10', '50', true]]);
    // v8: Solana ↔ EVM is a pair like the others — Jupiter, then CCTP from Solana (the leg itself is exercised in bridge-sol.test.ts)
    const sol = await quote({ network: 'solana', asset: 'native' }, USDC_B, '1');
    expect(sol.notExecutable).toBeNull();
    expect(sol.plans.map((p: any) => p.legs.map((l: any) => `${l.label}${l.speed ? `:${l.speed}` : ''}`).join('>')).sort()).toEqual(['Jupiter (Metis)>Circle CCTP:fast', 'Jupiter (Metis)>Circle CCTP:standard']);
    expect((await quote({ network: 'tron', asset: 'native' }, USDC_B, '1'))).toMatchObject({ plans: [], notExecutable: { code: 'network_without_execution', network: 'tron' } });
    expect((await api('POST', '/api/v1/plans/quote', { from: K(USDC_B), to: K(USDC_B), amount: '1' })).json.error).toBe('same_asset');
    expect((await api('POST', '/api/v1/plans/quote', { from: 'base:0x0000000000000000000000000000000000000001', to: K(USDC_B), amount: '1' })).json.error).toBe('unsupported_asset');
    const caps = (await api('GET', '/api/v1/plans/capabilities')).json;
    expect(caps.swap).toMatchObject({ base: 'kyberswap', solana: 'jupiter' }); expect(caps.cctp).toContain('hyperevm'); expect(caps.cctp).toContain('solana'); expect(caps.hub).toBe('USDC');
  });
  it('refuses to START a plan whose leg exceeds the limit of its asset, or that lacks gas somewhere — with the reason, storing nothing', async () => {
    const { r } = await create('60');
    expect(r.status).toBe(422); expect(r.json.error).toBe('plan_not_startable');
    expect(r.json.message).toMatch(/step 1: 60 USDC on Base is above the per-transfer limit of 50 USDC; step 2: 60 USDC on Arbitrum One is above the per-transfer limit of 50 USDC/);
    balances.set('arbitrum:native', 0n);
    const g = await create('10');
    expect(g.r.json.error).toBe('plan_not_startable'); expect(g.r.json.message).toMatch(/about 0\.00008 ETH is needed on Arbitrum One for network fees; the wallet has 0 available there/);
    expect(g.quoted.issues).toEqual([expect.objectContaining({ code: 'gas_missing', blocking: true, network: 'arbitrum', symbol: 'ETH' })]);
    expect(await sql`select 1 from plans where state in ('active', 'paused')`).toHaveLength(0);
    expect(await sql`select 1 from proposals where state = 'pending_approval'`).toHaveLength(0);
    expect((await api('POST', '/api/v1/plans', { from: K(USDC_B), to: K(LINK_A), amount: '10', slippageBps: 50, plan: 'cctp:nonsense' })).json.error).toBe('no_route');
  });
});

describe('execution as a saga', () => {
  it('bridge then swap: leg 1 is a real CCTP proposal walked to the mint; leg 2 is prepared only afterwards, on the amount received; a refused leg pauses the plan', async () => {
    const { r, quoted } = await create('10');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const id = r.json.id as string;
    expect(r.json).toMatchObject({ state: 'active', next: 'prepare', current: 0, steps: 2, holding: { symbol: 'USDC', network: 'base', amountDisplay: '10' }, plannedExpectedDisplay: quoted.expectedOutDisplay, plannedWorstDisplay: quoted.worstOutDisplay });
    expect(r.json.legs.map((l: any) => l.state)).toEqual(['ready', 'pending']);
    expect(await sql`select 1 from proposals where state not in ('failed', 'expired', 'rejected', 'finalized')`).toHaveLength(0);   // creating a plan prepares nothing
    expect((await create('5')).r.json.error).toBe('plan_open');                                                                 // one plan at a time

    const prep = (await api('POST', `/api/v1/plans/${id}/prepare`, {})).json;
    expect(prep.proposal).toMatchObject({ kind: 'bridge', state: 'pending_approval', amount: '10000000', bridge: { toNetwork: 'arbitrum', speed: 'standard' } });
    expect(prep.plan).toMatchObject({ next: 'approve', estimate: { expectedOutDisplay: '1', worstOutDisplay: '0.995' } });
    expect((await row(prep.proposal.id)).idempotency_key).toMatch(/^pl-[0-9a-f]{24}-0-0-0$/);
    // the plan does not approve: without the owner's passkey the worker changes nothing
    await tick(); expect((await getPlan(id)).legs[0].state).toBe('proposed');
    expect((await approve(prep)).status).toBe(200);
    for (let k = 0; k < 4 && (await row(prep.proposal.id)).state !== 'finalized'; k++) { chains.base!.mine(); await tick(); }
    let p = await getPlan(id);
    expect(p).toMatchObject({ state: 'active', next: 'wait', current: 0 }); expect(p.legs[0].state).toBe('in_flight');     // burned, not minted: the plan waits
    expect(p.proposal.bridge.stage).toBe('attesting');
    iris.messages.set(p.proposal.txid, attested((await row(prep.proposal.id)).intent as Intent));
    await tick(); chains.arbitrum!.mine(); await tick();
    p = await getPlan(id);
    expect(p).toMatchObject({ state: 'active', next: 'prepare', current: 1, holding: { symbol: 'USDC', network: 'arbitrum', amount: '10000000' } });
    expect(p.legs.map((l: any) => [l.state, l.actual.inDisplay, l.actual.outDisplay])).toEqual([['settled', '10', '10'], ['ready', null, null]]);
    const audit = (await api('GET', '/api/v1/security/audit?limit=200')).json;
    expect(audit.intact).toBe(true);
    expect(audit.events.find((e: any) => e.type === 'plan.step_ready').data).toMatchObject({ id, step: 2, steps: 2, what: 'USDC → LINK', network: 'arbitrum' });
    for (const t of ['plan.created', 'plan.step_prepared', 'plan.step_sent', 'plan.step_settled']) expect(audit.events.map((e: any) => e.type)).toContain(t);

    // leg 2 goes through the ordinary swap route, with ITS guards: this scripted chain has no reviewed router → refused → paused
    balances.set(assetKey(USDC_A), 10_000000n);
    const l2 = await api('POST', `/api/v1/plans/${id}/prepare`, {});
    expect(l2.status).toBe(200); expect(l2.json.proposal).toBeNull();
    expect(l2.json.plan).toMatchObject({ state: 'paused', next: 'paused', pause: { code: 'router_changed', leg: 1 }, holding: { symbol: 'USDC', network: 'arbitrum', amountDisplay: '10' } });
    expect((await api('POST', `/api/v1/plans/${id}/prepare`, {})).status).toBe(409);
    // réessayer → active again; re-planifier depuis l'actif actuel → a fresh route from USDC on Arbitrum; arrêter ici → final
    expect((await api('POST', `/api/v1/plans/${id}/retry`, {})).json).toMatchObject({ state: 'active', next: 'prepare', pause: null });
    market.linkPerUsdc = 90_000_000_000n;
    const re = (await api('POST', `/api/v1/plans/${id}/replan`, {})).json;
    expect(re).toMatchObject({ state: 'active', replans: 1, steps: 2, current: 1 });
    expect(re.legs.map((l: any) => [l.state, l.kind, l.planned.expectedOutDisplay])).toEqual([['settled', 'bridge', '10'], ['ready', 'swap', '0.9']]);   // re-quoted now
    const st = (await api('POST', `/api/v1/plans/${id}/stop`, {})).json;
    expect(st).toMatchObject({ state: 'stopped', next: 'stopped', holding: { symbol: 'USDC', network: 'arbitrum', amountDisplay: '10' } });
    expect((await api('POST', `/api/v1/plans/${id}/prepare`, {})).status).toBe(409);
    expect((await api('POST', `/api/v1/plans/${id}/stop`, {})).status).toBe(409);
    expect((await api('GET', '/api/v1/plans?open=1')).json.plans).toHaveLength(0);
    expect((await api('GET', '/api/v1/plans')).json.plans[0]).toMatchObject({ id, state: 'stopped' });
  });

  it('the overall floor stops the plan BEFORE a leg is prepared; nothing is signed; the owner may lower it', async () => {
    const hi = await create('10', { floor: '2' });
    expect(hi.r.json.error).toBe('floor_above_estimate');
    const { r } = await create('10', { floor: '0.99' });
    expect(r.status, JSON.stringify(r.json)).toBe(200); expect(r.json.floorDisplay).toBe('0.99');
    const id = r.json.id as string;
    market.linkPerUsdc = 98_000_000_000n;                                // the price moves: the same route now gives 0.98 LINK
    const f = await api('POST', `/api/v1/plans/${id}/prepare`, {});
    expect(f.status).toBe(200); expect(f.json.proposal).toBeNull();
    expect(f.json.plan).toMatchObject({ state: 'paused', pause: { code: 'floor', leg: 0 }, estimate: { expectedOutDisplay: '0.98' }, holding: { symbol: 'USDC', network: 'base', amountDisplay: '10' } });
    expect(f.json.plan.pause.message).toMatch(/estimated now is 0\.98 LINK, below the floor of 0\.99/);
    expect(await sql`select 1 from proposals where state = 'pending_approval'`).toHaveLength(0);
    // retry with the same floor: stopped again; with a lower floor: the leg is prepared
    expect((await api('POST', `/api/v1/plans/${id}/retry`, {})).json.state).toBe('active');
    expect((await api('POST', `/api/v1/plans/${id}/prepare`, {})).json.plan.pause.code).toBe('floor');
    expect((await api('POST', `/api/v1/plans/${id}/retry`, { floor: '0.97' })).json).toMatchObject({ state: 'active', floorDisplay: '0.97' });
    const ok = (await api('POST', `/api/v1/plans/${id}/prepare`, {})).json;
    expect(ok.proposal).toMatchObject({ kind: 'bridge', state: 'pending_approval' });
    // stopping withdraws the unused approval request first
    expect((await api('POST', `/api/v1/plans/${id}/stop`, {})).json.state).toBe('stopped');
    expect((await row(ok.proposal.id)).state).toBe('rejected');
  });

  it('a refused approval pauses the plan; an expired one does not; a second preparation replaces the first; amounts never exceed what the wallet holds', async () => {
    const { r } = await create('10');
    const id = r.json.id as string;
    const a = (await api('POST', `/api/v1/plans/${id}/prepare`, {})).json;
    await api('POST', `/api/v1/transfers/proposals/${a.proposal.id}/reject`, {});
    let p = await getPlan(id);
    expect(p).toMatchObject({ state: 'paused', pause: { code: 'refused', leg: 0 } }); expect(p.legs[0]).toMatchObject({ state: 'ready', attempts: [{ outcome: 'rejected' }] });
    await api('POST', `/api/v1/plans/${id}/retry`, {});
    const b = (await api('POST', `/api/v1/plans/${id}/prepare`, {})).json;
    expect(b.proposal.id).not.toBe(a.proposal.id);
    await sql`update proposals set expires_at = now() - interval '1 minute' where id = ${b.proposal.id}`; await worker.expireStale(); await plans.advancePlans();
    p = await getPlan(id);
    expect(p).toMatchObject({ state: 'active', next: 'prepare', pause: null }); expect(p.legs[0].attempts.map((x: any) => x.outcome)).toEqual(['rejected', 'expired']);
    const c = (await api('POST', `/api/v1/plans/${id}/prepare`, {})).json, d = (await api('POST', `/api/v1/plans/${id}/prepare`, {})).json;   // the page was closed and reopened
    expect(d.proposal.id).not.toBe(c.proposal.id); expect((await row(c.proposal.id)).state).toBe('rejected'); expect((await row(d.proposal.id)).state).toBe('pending_approval');
    expect(d.plan.legs[0].attempts).toHaveLength(4);
    // an approval of the withdrawn request is refused by the ordinary route
    expect((await approve(c)).status).toBe(409);
    await api('POST', `/api/v1/plans/${id}/stop`, {});
    // part of the funds left the wallet between the start and the first leg: the leg is sized on what is really there
    const two = (await create('10')).r.json;
    balances.set(assetKey(USDC_B), 7_000000n);
    const e = (await api('POST', `/api/v1/plans/${two.id}/prepare`, {})).json;
    expect(e.proposal).toMatchObject({ amount: '7000000', kind: 'bridge' }); expect(e.plan.estimate.expectedOutDisplay).toBe('0.7');
    await api('POST', `/api/v1/plans/${two.id}/stop`, {});
    balances.set(assetKey(USDC_B), 0n);
    const three = (await sql`update plans set state = 'active' where id = ${two.id} returning id`)[0];
    expect((await api('POST', `/api/v1/plans/${three.id}/prepare`, {})).json.plan).toMatchObject({ state: 'paused', pause: { code: 'no_funds' } });
  });
});
