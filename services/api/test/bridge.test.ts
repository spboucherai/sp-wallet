// CCTP transfer life cycle against a scripted chain and a scripted attestation service (no network): the real API routes,
// worker steps and signer process boundary. What the real contracts do is proven separately on forks (scripts/fork-cctp.mts).
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from './test-db.ts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, keccak256, numberToHex, pad, parseTransaction, toFunctionSelector, type Hex } from 'viem';
import { CCTP_ABI, CCTP_ENABLED, CCTP_MESSAGE_TRANSMITTER, CCTP_TOKEN_MESSENGER, CCTP_TOKEN_MINTER, cctpBytes32, cctpMintRetryBytes, EIP1967_IMPLEMENTATION_SLOT, encodeCctpMessage, NETWORKS, type CctpMessage, type Intent } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { createSignerServer } from '../../isolated-signer/src/server.ts';
import { Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';

const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'b'.repeat(48);
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), ME = keys.addresses.evm;
const owner = new TestPasskey(RP, ORIGIN);
const CODE = JSON.parse(readFileSync(new URL('./fixtures/cctp-code.json', import.meta.url), 'utf8')) as Record<string, string>; // real mainnet bytecode, so the pinned hashes are exercised
const usdc = (n: string) => NETWORKS[n]!.tokens.find((t) => t.symbol === 'USDC')!.id;
const SEL = { allowance: '0xdd62ed3e', used: toFunctionSelector('usedNonces(bytes32)'), minFee: toFunctionSelector('getMinFeeAmount(uint256)'), burn: '0x8e0250ee', receive: '0x57ecfd28' };
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** One scripted EVM chain behind a JSON-RPC endpoint. */
class Chain {
  head = 1000; nonce = 0; native = 10n ** 17n; allowance = 0n; pending: { hash: string; raw: string }[] = []; receipts = new Map<string, any>(); used = new Set<string>();
  implSlot: Record<string, string>; burnReverts = false; mintReverts: string | null = null; sent: string[] = [];
  constructor(public id: string) { const p = CCTP_ENABLED[id]!; this.implSlot = { [CCTP_TOKEN_MESSENGER.toLowerCase()]: p.messengerImpl.address, [CCTP_MESSAGE_TRANSMITTER.toLowerCase()]: p.transmitterImpl.address }; }
  /** include what is pending; `status` 0 = the transaction reverts */
  mine(status = 1, blocks = 20) {
    for (const t of this.pending) {
      const tx = parseTransaction(t.raw as Hex); this.head += 1; this.nonce = Math.max(this.nonce, tx.nonce! + 1);
      const logs: any[] = [];
      if (status === 1 && tx.to?.toLowerCase() === CCTP_MESSAGE_TRANSMITTER.toLowerCase()) {
        const [message] = decodeFunctionData({ abi: CCTP_ABI, data: tx.data! }).args as [Hex, Hex];
        const nonce = message.slice(2 + 24, 2 + 24 + 64), amount = BigInt('0x' + message.slice(2 + (148 + 68) * 2, 2 + (148 + 100) * 2)), fee = BigInt('0x' + message.slice(2 + (148 + 164) * 2, 2 + (148 + 196) * 2));
        this.used.add(nonce);
        logs.push({ address: usdc(this.id), topics: [TRANSFER, pad('0x0', { size: 32 }), pad(ME as Hex, { size: 32 }).toLowerCase()], data: numberToHex(amount - fee, { size: 32 }) });
      }
      this.receipts.set(t.hash, { status: numberToHex(status), blockNumber: numberToHex(this.head), blockHash: keccak256(t.hash as Hex), transactionHash: t.hash, logs });
    }
    this.pending = []; this.head += blocks;
  }
  rpc(method: string, p: any[]): unknown {
    const err = (message: string) => { throw Object.assign(new Error(message), { rpc: true }); };
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
        if (sel === SEL.minFee) return err('execution reverted');
        if (sel === SEL.burn) return this.burnReverts || this.allowance < 1n ? err('execution reverted: ERC20: transfer amount exceeds allowance') : method === 'eth_call' ? '0x' : '0x1a000';
        if (sel === SEL.receive) { const nonce = d.slice(10 + 64 * 4 + 24, 10 + 64 * 4 + 24 + 64); // message bytes start after two offsets + length
          if (this.used.has(nonce)) return err('execution reverted: Nonce already used');
          return this.mintReverts ? err(`execution reverted: ${this.mintReverts}`) : method === 'eth_call' ? encodeAbiParameters([{ type: 'bool' }], [true]) : '0x2a000'; }
        return err('execution reverted'); }
      case 'eth_sendRawTransaction': { const hash = keccak256(p[0] as Hex); if (!this.pending.some((x) => x.hash === hash) && !this.receipts.has(hash)) { this.pending.push({ hash, raw: p[0] }); this.sent.push(p[0]); }
        const tx = parseTransaction(p[0] as Hex); if (tx.to?.toLowerCase() === usdc(this.id).toLowerCase()) this.allowance = 10n ** 30n; // the exact approval, once mined (close enough for a script)
        return hash; }
      case 'eth_getTransactionReceipt': return this.receipts.get(String(p[0])) ?? null;
      case 'eth_getLogs': return [];
      default: return err(`unscripted ${method}`);
    }
  }
}
const chains: Record<string, Chain> = {};
const iris: { messages: Map<string, unknown>; fees: unknown; allowance: number; calls: string[] } = { messages: new Map(), fees: [{ finalityThreshold: 1000, minimumFee: 1.3 }, { finalityThreshold: 2000, minimumFee: 0 }], allowance: 5e7, calls: [] };
let fake: Server, signerSrv: Server, app: any, sql: any, worker: any, bridge: any, adapters: any, cookie = '', store: Store, signerDir: string;

async function api(method: string, path: string, body?: unknown, idem?: string) {
  const r = await app.inject({ method, url: path, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), setCookie: r.headers['set-cookie'] as string | undefined };
}
const row = async (id: string) => (await sql`select * from proposals where id = ${id}`)[0];
const getP = async (id: string) => (await api('GET', `/api/v1/transfers/proposals/${id}`)).json;
const finish = async (id: string) => (await api('POST', `/api/v1/bridge/proposals/${id}/finish`, {})).json;
/** what Circle would attest for this burn */
function attested(i: Intent, o: Partial<CctpMessage> = {}, body: Partial<CctpMessage['body']> = {}, nonce = createHash('sha256').update(i.proposalId).digest('hex')) {
  const b = i.bridge!, m = cctpBytes32(CCTP_TOKEN_MESSENGER);
  const message = encodeCctpMessage({ version: 1, sourceDomain: CCTP_ENABLED[i.network]!.domain, destinationDomain: b.toDomain, nonce, sender: m, recipient: m, destinationCaller: '0'.repeat(64), minFinalityThreshold: b.minFinalityThreshold,
    finalityThresholdExecuted: b.minFinalityThreshold, ...o, body: { version: 1, burnToken: cctpBytes32(i.asset), mintRecipient: cctpBytes32(i.from), amount: BigInt(i.amount), messageSender: cctpBytes32(i.from), maxFee: BigInt(b.maxFee), feeExecuted: 0n, expirationBlock: 0n, ...body } });
  return { messages: [{ status: 'complete', message, attestation: `0x${'33'.repeat(130)}`, cctpVersion: 2, delayReason: null }] };
}
/** prepare + approve + mine approval and burn: returns the proposal once the burn is final on the source */
async function burn(amount = '10', speed: 'standard' | 'fast' = 'standard') {
  const prep = await api('POST', '/api/v1/bridge/proposals', { fromNetwork: 'base', toNetwork: 'arbitrum', amount, speed }, crypto.randomUUID());
  expect(prep.status, JSON.stringify(prep.json)).toBe(200);
  const id = prep.json.proposal.id as string;
  const ap = await api('POST', `/api/v1/transfers/proposals/${id}/approve`, { assertion: owner.assert(Buffer.from(prep.json.options.challenge, 'base64url')) });
  expect(ap.status, JSON.stringify(ap.json)).toBe(200);
  for (let k = 0; k < 4 && (await getP(id)).state !== 'finalized'; k++) { chains.base!.mine(); await worker.reconcile(); }
  const p = await getP(id); expect(p.state).toBe('finalized');
  return { id, intent: (await row(id)).intent as Intent, prep: prep.json };
}

beforeAll(async () => {
  for (const id of ['base', 'arbitrum']) chains[id] = new Chain(id);
  fake = createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      const send = (code: number, o: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const url = new URL(req.url!, 'http://x');
      if (url.pathname.startsWith('/rpc/')) { const j = JSON.parse(body); try { send(200, { jsonrpc: '2.0', id: j.id, result: chains[url.pathname.slice(5)]!.rpc(j.method, j.params) }); } catch (e) { send(200, { jsonrpc: '2.0', id: j.id, error: { code: 3, message: (e as Error).message } }); } return; }
      iris.calls.push(`${req.method} ${url.pathname}${url.search}`);
      if (url.pathname.startsWith('/v2/burn/USDC/fees/')) return send(200, iris.fees);
      if (url.pathname === '/v2/fastBurn/USDC/allowance') return send(200, { allowance: iris.allowance });
      if (url.pathname.startsWith('/v2/messages/')) { const m = iris.messages.get(url.searchParams.get('transactionHash') ?? ''); return m ? send(200, m) : send(404, { error: 'Message not found for provided parameters' }); }
      if (url.pathname.startsWith('/v2/reattest/')) return send(200, { message: 'Re-attestation successfully requested for nonce.' });
      send(404, {});
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => fake.once('listening', r));
  const base = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  signerDir = mkdtempSync(join(tmpdir(), 'spw-bridge-api-'));
  store = new Store(join(signerDir, 'state.json'), join(signerDir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('bridge-setup-token').digest('hex');
  signerSrv = createSignerServer(new Signer(keys, store, { rpId: RP, origin: ORIGIN }), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, DATABASE_URL: (await createTestDb('bridge')).url, SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`,
    SPW_BROADCAST: 'on', SPW_WORKERS: 'off', SPW_IRIS_OVERRIDE: base, SPW_RPC_OVERRIDE: JSON.stringify({ base: [`${base}/rpc/base`, `${base}/rpc/base`], arbitrum: [`${base}/rpc/arbitrum`, `${base}/rpc/arbitrum`] }) });
  const db = await import('../src/db.ts'); sql = db.sql;
  await sql.unsafe('drop schema public cascade; create schema public;'); await db.migrate();
  await import('../src/rpc-override.ts');
  adapters = (await import('../src/chains/index.ts')).adapters;
  adapters.base.balances = async () => ({ native: chains.base!.native, [usdc('base')]: 100_000000n });
  app = await (await import('../src/server.ts')).buildServer({ swapProviders: [] });
  worker = await import('../src/worker.ts'); bridge = await import('../src/bridge.ts');
  const o = (await api('POST', '/api/v1/auth/setup/options', {})).json;
  const s = await api('POST', '/api/v1/auth/setup/verify', { challengeId: o.challengeId, response: owner.register(o.options.challenge), setupToken: 'bridge-setup-token' });
  expect(s.status, JSON.stringify(s.json)).toBe(200); cookie = String(s.setCookie).split(';')[0]!;
});
afterAll(async () => { await app?.close(); signerSrv?.close(); fake?.close(); await sql?.end(); });
beforeEach(async () => {
  // each test starts from a quiet wallet: nothing in flight, fresh daily counters
  await sql`update proposals set state = 'failed' where state not in ('finalized', 'failed', 'expired', 'rejected', 'replaced')`;
  await sql`update proposals set bridge = jsonb_set(bridge, '{phase}', '"done"') where kind = 'bridge'`;
  store.state.spent = {}; store.save();
  for (const c of Object.values(chains)) { c.mine(); c.native = 10n ** 17n; c.burnReverts = false; c.mintReverts = null; c.sent = []; }
  chains.base!.allowance = 0n; iris.calls = [];
  for (const c of Object.values(chains)) { const p = CCTP_ENABLED[c.id]!; c.implSlot = { [CCTP_TOKEN_MESSENGER.toLowerCase()]: p.messengerImpl.address, [CCTP_MESSAGE_TRANSMITTER.toLowerCase()]: p.transmitterImpl.address }; }
});

describe('preparation', () => {
  it('is closed without a session and validates the route', async () => {
    const saved = cookie; cookie = '';
    expect((await api('POST', '/api/v1/bridge/proposals', { fromNetwork: 'base', toNetwork: 'arbitrum', amount: '10' }, crypto.randomUUID())).status).toBe(401);
    expect((await api('GET', '/api/v1/bridge/quote?from=base&to=arbitrum&amount=10')).status).toBe(401);
    cookie = saved;
    expect((await api('POST', '/api/v1/bridge/proposals', { fromNetwork: 'base', toNetwork: 'arbitrum', amount: '10' })).json.error).toBe('idempotency');
    for (const [b, code] of [[{ fromNetwork: 'base', toNetwork: 'base', amount: '10' }, 'same_network'], [{ fromNetwork: 'base', toNetwork: 'bsc', amount: '10' }, 'bridge_not_enabled'], [{ fromNetwork: 'tron', toNetwork: 'base', amount: '10' }, 'bridge_not_enabled'], [{ fromNetwork: 'solana', toNetwork: 'solana', amount: '10' }, 'same_network'], // v8: Solana ↔ EVM is enabled (bridge-sol.test.ts)
      [{ fromNetwork: 'base', toNetwork: 'arbitrum', amount: '0' }, 'bad_amount'], [{ fromNetwork: 'base', toNetwork: 'arbitrum', amount: '1000' }, 'insufficient_funds'], [{ fromNetwork: 'base', toNetwork: 'arbitrum', amount: '60' }, 'policy']] as const)
      expect((await api('POST', '/api/v1/bridge/proposals', b, crypto.randomUUID())).json.error, JSON.stringify(b)).toBe(code);
    expect((await api('POST', '/api/v1/bridge/proposals', { fromNetwork: 'base', toNetwork: 'arbitrum', amount: '10', to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }, crypto.randomUUID())).status).toBe(400); // no recipient field exists
  });
  it('refuses BEFORE any approval when the destination has no gas, and says what to do', async () => {
    chains.arbitrum!.native = 0n;
    const r = await api('POST', '/api/v1/bridge/proposals', { fromNetwork: 'base', toNetwork: 'arbitrum', amount: '10' }, crypto.randomUUID());
    expect(r.status).toBe(422); expect(r.json.error).toBe('destination_gas'); expect(r.json.message).toMatch(/Nothing was burned: add ETH on Arbitrum One first/);
    expect(await sql`select 1 from proposals where kind = 'bridge' and state = 'pending_approval'`).toHaveLength(0);
    const q = (await api('GET', '/api/v1/bridge/quote?from=base&to=arbitrum&amount=10')).json;
    expect(q.destinationGas).toMatchObject({ symbol: 'ETH', enough: false });
    expect(q.options.map((o: any) => [o.speed, o.fee, o.seconds])).toEqual([['standard', '0', 1140], ['fast', '1300', 8]]); // 1.3 bps of 10 USDC, rounded up
  });
  it('refuses when Circle upgraded a contract (implementation address or code is not the pinned one), on either side', async () => {
    chains.arbitrum!.implSlot[CCTP_MESSAGE_TRANSMITTER.toLowerCase()] = '0x00000000000000000000000000000000000000aa';
    let r = await api('POST', '/api/v1/bridge/proposals', { fromNetwork: 'base', toNetwork: 'arbitrum', amount: '10' }, crypto.randomUUID());
    expect(r.json.error).toBe('contract_changed'); expect(r.json.message).toMatch(/MessageTransmitterV2 implementation address on Arbitrum One/);
    chains.arbitrum!.implSlot[CCTP_MESSAGE_TRANSMITTER.toLowerCase()] = CCTP_ENABLED.base!.transmitterImpl.address; // a real Circle contract, but not the reviewed one for this chain
    r = await api('POST', '/api/v1/bridge/proposals', { fromNetwork: 'base', toNetwork: 'arbitrum', amount: '10' }, crypto.randomUUID());
    expect(r.json.error).toBe('contract_changed');
    chains.base!.implSlot[CCTP_TOKEN_MESSENGER.toLowerCase()] = CCTP_ENABLED.base!.transmitterImpl.address;
    r = await api('POST', '/api/v1/bridge/proposals', { fromNetwork: 'base', toNetwork: 'arbitrum', amount: '10' }, crypto.randomUUID());
    expect(r.json.error).toBe('contract_changed'); expect(r.json.message).toMatch(/TokenMessengerV2 implementation address on Base/);
  });
  it('Fast needs a source that offers it, a fee quote and Circle\'s allowance', async () => {
    iris.allowance = 5;
    expect((await api('POST', '/api/v1/bridge/proposals', { fromNetwork: 'base', toNetwork: 'arbitrum', amount: '10', speed: 'fast' }, crypto.randomUUID())).json.error).toBe('fast_unavailable');
    iris.allowance = 5e7;
  });
});

describe('life cycle', () => {
  it('burn → attestation pending → attested → mint → done; visible in activity and in the audit chain', async () => {
    const { id, intent, prep } = await burn('10');
    expect(prep.proposal).toMatchObject({ kind: 'bridge', state: 'pending_approval', bridge: { stage: 'review', toNetwork: 'arbitrum', speed: 'standard', cctpMaxFeeDisplay: '0', expectedSeconds: 1140, needsApproval: true, destGasSymbol: 'ETH' } });
    // approval then burn, both to the pinned contracts, on the source chain
    const [a, b] = chains.base!.sent.map((r) => parseTransaction(r as Hex));
    expect(a!.to!.toLowerCase()).toBe(usdc('base').toLowerCase()); expect(b!.to!.toLowerCase()).toBe(CCTP_TOKEN_MESSENGER.toLowerCase()); expect(b!.nonce).toBe(a!.nonce! + 1);
    expect((await getP(id)).bridge).toMatchObject({ stage: 'burning', approvalState: 'confirmed' });
    await bridge.advanceBridges(); // Circle has not seen the burn yet
    let p = await getP(id); expect(p.bridge).toMatchObject({ stage: 'attesting', irisStatus: 'not_found', attested: false });
    iris.messages.set(p.txid, { messages: [{ status: 'pending_confirmations', message: '0x', attestation: 'PENDING', cctpVersion: 2, delayReason: null }] });
    p = await finish(id); expect(p.bridge).toMatchObject({ stage: 'attesting', irisStatus: 'pending_confirmations' });
    expect(chains.arbitrum!.sent).toHaveLength(0);
    iris.messages.set(p.txid, attested(intent));
    p = await finish(id); expect(p.bridge).toMatchObject({ stage: 'minting', attested: true, hold: null });
    const mint = parseTransaction(chains.arbitrum!.sent[0] as Hex);
    expect(mint.to!.toLowerCase()).toBe(CCTP_MESSAGE_TRANSMITTER.toLowerCase()); expect(mint.chainId).toBe(42161);
    chains.arbitrum!.mine();
    p = await finish(id);
    expect(p.bridge).toMatchObject({ stage: 'done', receivedDisplay: '10', mintedBy: 'wallet', mintTxid: keccak256(chains.arbitrum!.sent[0] as Hex), canFinish: false });
    expect(chains.arbitrum!.sent).toHaveLength(1);
    await finish(id); await bridge.advanceBridges(); expect(chains.arbitrum!.sent).toHaveLength(1); // finishing again does nothing
    const act = (await api('GET', '/api/v1/activity')).json.items.find((x: any) => x.id === id);
    expect(act).toMatchObject({ kind: 'bridge', bridge: { stage: 'done' } });
    const audit = (await api('GET', '/api/v1/security/audit?limit=200')).json;
    expect(audit.intact).toBe(true);
    for (const t of ['bridge.prepared', 'bridge.approval_confirmed', 'bridge.burned', 'bridge.attested', 'bridge.mint_signed', 'bridge.done']) expect(audit.events.map((e: any) => e.type)).toContain(t);
  });
  it('Fast: the fee ceiling is approved, the fee Circle took is shown, the wallet receives amount − fee', async () => {
    const { id, intent } = await burn('20', 'fast');
    expect(intent.bridge).toMatchObject({ maxFee: '2600', minFinalityThreshold: 1000 });
    iris.messages.set((await getP(id)).txid, attested(intent, {}, { feeExecuted: 2599n, expirationBlock: 99_999_999n }));
    await finish(id); chains.arbitrum!.mine();
    expect((await finish(id)).bridge).toMatchObject({ stage: 'done', receivedDisplay: '19.997401', feeExecutedDisplay: '0.002599', speed: 'fast' });
  });
  it('restart between the two legs: API state is in the database, the approval is in the signer\'s file; the mint still happens days later', async () => {
    const { id, intent } = await burn('10');
    await bridge.advanceBridges();
    // the signer process restarts (new instance from the same files); the API keeps nothing in memory for a bridge
    signerSrv.close();
    const reborn = new Store(join(signerDir, 'state.json'), join(signerDir, 'policy.json'));
    expect(reborn.state.bridges![id]).toMatchObject({ bridge: { toNetwork: 'arbitrum', amount: '10000000' } });
    const port = Number(new URL(process.env.SPW_SIGNER_URL!).port);
    signerSrv = createSignerServer(new Signer(keys, reborn, { rpId: RP, origin: ORIGIN }), SECRET).listen(port, '127.0.0.1');
    await new Promise((r) => signerSrv.once('listening', r));
    store = reborn;
    await sql`update proposals set created_at = now() - interval '6 days', bridge = jsonb_set(bridge, '{attestingSince}', to_jsonb(${Date.now() - 6 * 86400_000}::bigint)) where id = ${id}`;
    iris.messages.set((await getP(id)).txid, attested(intent));
    await sql`update proposals set bridge = jsonb_set(bridge, '{nextAt}', '0') where id = ${id}`;
    await bridge.advanceBridges(); // the worker alone, no button
    chains.arbitrum!.mine(); await sql`update proposals set bridge = jsonb_set(bridge, '{nextAt}', '0') where id = ${id}`; await bridge.advanceBridges();
    expect((await getP(id)).bridge).toMatchObject({ stage: 'done', mintedBy: 'wallet' });
  });
  it('attestation never arriving: polled with a growing delay, flagged late, never failed, never minted', async () => {
    const { id } = await burn('10');
    for (let k = 0; k < 30; k++) await finish(id);
    let r = await row(id);
    expect(r.bridge).toMatchObject({ phase: 'attesting', polls: 30 }); expect(r.bridge.nextAt - Date.now()).toBeGreaterThan(40_000); // backs off
    const before = iris.calls.length; await bridge.advanceBridges(); expect(iris.calls.length).toBe(before); // the worker respects the delay
    await sql`update proposals set bridge = jsonb_set(bridge, '{attestingSince}', to_jsonb(${Date.now() - 3 * 86400_000}::bigint)) where id = ${id}`;
    const p = await finish(id);
    expect(p.state).toBe('finalized'); expect(p.bridge).toMatchObject({ stage: 'attesting', hold: 'attestation_late', canFinish: true });
    expect(p.bridge.holdDetail).toMatch(/not lost/);
    expect(chains.arbitrum!.sent).toHaveLength(0);
    expect(store.state.bridges![id]!.mint).toBeUndefined(); // the signer was never asked
  });
  it('an attestation answer that is not the approved burn is not used (other recipient, other amount), and the right one still works', async () => {
    const { id, intent } = await burn('10'), txid = (await getP(id)).txid;
    iris.messages.set(txid, attested(intent, {}, { mintRecipient: cctpBytes32('0x70997970C51812dc3A010C7d01b50e0d17dc79C8') }));
    let p = await finish(id); expect(p.bridge).toMatchObject({ stage: 'attesting', hold: 'message_mismatch', attested: false }); expect(p.bridge.holdDetail).toMatch(/another address/);
    iris.messages.set(txid, attested(intent, {}, { amount: 9_000000n }));
    p = await finish(id); expect(p.bridge.holdDetail).toMatch(/another amount/);
    iris.messages.set(txid, { messages: [{ status: 'complete', message: 'garbage', attestation: '0x00' }, ...attested(intent).messages] }); // several messages in one answer: only the matching one is kept
    p = await finish(id); expect(p.bridge).toMatchObject({ stage: 'minting', hold: null });
  });
  it('destination gas missing at mint time: waits with a clear message, signs nothing, finishes once the owner adds gas', async () => {
    const { id, intent } = await burn('10');
    iris.messages.set((await getP(id)).txid, attested(intent));
    chains.arbitrum!.native = 0n;
    let p = await finish(id);
    expect(p.bridge).toMatchObject({ stage: 'ready', hold: 'destination_gas', canFinish: true }); expect(p.bridge.holdDetail).toMatch(/add ETH on Arbitrum One/);
    expect(store.state.bridges![id]!.mint).toBeUndefined(); expect(chains.arbitrum!.sent).toHaveLength(0);
    chains.arbitrum!.native = 10n ** 16n;
    p = await finish(id); expect(p.bridge.stage).toBe('minting');
    chains.arbitrum!.mine(); expect((await finish(id)).bridge.stage).toBe('done');
  });
  it('mint already done by someone else (it is permissionless): detected before signing, recorded as success, nothing is signed', async () => {
    const { id, intent } = await burn('10'), att = attested(intent);
    iris.messages.set((await getP(id)).txid, att);
    chains.arbitrum!.used.add(att.messages[0]!.message.slice(2 + 24, 2 + 24 + 64));
    const p = await finish(id);
    expect(p.bridge).toMatchObject({ stage: 'done', mintedBy: 'other', receivedDisplay: '10' });
    expect(store.state.bridges![id]!.mint).toBeUndefined(); expect(chains.arbitrum!.sent).toHaveLength(0);
  });
  it('someone mints while our transaction is pending: ours reverts ("Nonce already used") and the transfer is still a success', async () => {
    const { id, intent } = await burn('10'), att = attested(intent);
    iris.messages.set((await getP(id)).txid, att);
    expect((await finish(id)).bridge.stage).toBe('minting');
    chains.arbitrum!.used.add(att.messages[0]!.message.slice(2 + 24, 2 + 24 + 64));
    chains.arbitrum!.mine(0);
    expect((await finish(id)).bridge).toMatchObject({ stage: 'done', mintedBy: 'other' });
  });
  it('mint reverted for another reason: the single passkey-free signature is spent; a new one needs the owner\'s passkey over the new parameters', async () => {
    const { id, intent } = await burn('10');
    iris.messages.set((await getP(id)).txid, attested(intent));
    await finish(id); chains.arbitrum!.mine(0);
    let p = await finish(id);
    expect(p.bridge).toMatchObject({ stage: 'mint_failed', hold: 'mint_reverted', needsPasskey: true });
    await finish(id); await bridge.advanceBridges(); expect(chains.arbitrum!.sent).toHaveLength(1); // no silent second attempt
    // a compromised API asking the signer directly for other parameters is refused
    const { signer } = await import('../src/signer-client.ts'); const r = await row(id);
    await expect(signer.bridgeMint({ proposalId: id, message: r.bridge.message, attestation: r.bridge.attestation, evm: { ...r.bridge.mint.evm, nonce: r.bridge.mint.evm.nonce + 1 } })).rejects.toMatchObject({ code: 'signer_replay' });
    const o = await api('POST', `/api/v1/bridge/proposals/${id}/retry-mint/options`, {});
    expect(o.status, JSON.stringify(o.json)).toBe(200);
    const evm = (await row(id)).bridge.retry.evm;
    expect(o.json.options.challenge).toBe(createHash('sha256').update(cctpMintRetryBytes(id, r.bridge.messageHash, evm)).digest('base64url'));
    expect((await api('POST', `/api/v1/bridge/proposals/${id}/retry-mint`, { assertion: new TestPasskey(RP, ORIGIN).assert(Buffer.from(o.json.options.challenge, 'base64url')) })).status).toBe(422);
    const ok = await api('POST', `/api/v1/bridge/proposals/${id}/retry-mint`, { assertion: owner.assert(Buffer.from(o.json.options.challenge, 'base64url')) });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200); expect(ok.json.bridge.stage).toBe('minting');
    expect(chains.arbitrum!.sent).toHaveLength(2);
    chains.arbitrum!.mine(); p = await finish(id);
    expect(p.bridge).toMatchObject({ stage: 'done', mintedBy: 'wallet' });
    expect(store.state.bridges![id]!.mint!.signatures).toBe(2);
  });
  it('an interrupted mint (answer lost after the signer signed) repeats the identical request and gets the same bytes: one signature', async () => {
    const { id, intent } = await burn('10');
    iris.messages.set((await getP(id)).txid, attested(intent));
    await finish(id);
    const sentRaw = chains.arbitrum!.sent[0]!, r = await row(id);
    // rewind the API's row to "parameters chosen, nothing signed yet", as after a crash between the signer's answer and the database write
    await sql`update proposals set bridge = ${sql.json({ ...r.bridge, phase: 'ready', mint: { evm: r.bridge.mint.evm } })} where id = ${id}`;
    const p = await finish(id);
    expect(p.bridge.stage).toBe('minting'); expect((await row(id)).bridge.mint.raw).toBe(sentRaw);
    expect(store.state.bridges![id]!.mint!.signatures).toBe(1);
  });
  it('a burn that would revert after the approval is not sent; a tampered row cannot change what the signer signs', async () => {
    const prep = await api('POST', '/api/v1/bridge/proposals', { fromNetwork: 'base', toNetwork: 'arbitrum', amount: '10' }, crypto.randomUUID());
    const id = prep.json.proposal.id;
    // a compromised API/database redirects the transfer after the owner saw it: the passkey approval no longer matches
    await sql`update proposals set intent = jsonb_set(intent, '{to}', '"0x70997970C51812dc3A010C7d01b50e0d17dc79C8"') where id = ${id}`;
    const bad = await api('POST', `/api/v1/transfers/proposals/${id}/approve`, { assertion: owner.assert(Buffer.from(prep.json.options.challenge, 'base64url')) });
    expect(bad.status).toBe(422); expect((await getP(id)).state).toBe('failed');
    const prep2 = await api('POST', '/api/v1/bridge/proposals', { fromNetwork: 'base', toNetwork: 'arbitrum', amount: '10' }, crypto.randomUUID());
    await api('POST', `/api/v1/transfers/proposals/${prep2.json.proposal.id}/approve`, { assertion: owner.assert(Buffer.from(prep2.json.options.challenge, 'base64url')) });
    chains.base!.burnReverts = true; chains.base!.mine(); await worker.reconcile();
    const p = await getP(prep2.json.proposal.id);
    expect(p.state).toBe('failed'); expect(p.error).toMatch(/burn would revert now .* not sent/);
    expect(chains.base!.sent).toHaveLength(1); // only the approval left
  });
  it('one operation in flight: a second bridge on the source is refused while the first is being approved or burned', async () => {
    const prep = await api('POST', '/api/v1/bridge/proposals', { fromNetwork: 'base', toNetwork: 'arbitrum', amount: '10' }, crypto.randomUUID());
    await api('POST', `/api/v1/transfers/proposals/${prep.json.proposal.id}/approve`, { assertion: owner.assert(Buffer.from(prep.json.options.challenge, 'base64url')) });
    expect((await api('POST', '/api/v1/bridge/proposals', { fromNetwork: 'base', toNetwork: 'arbitrum', amount: '10' }, crypto.randomUUID())).json.error).toBe('pending_tx');
  });
});

// ── v11 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('v11 — idempotent preparation, the option the owner selected, restart of the API', () => {
  const BODY = { fromNetwork: 'base', toNetwork: 'arbitrum', amount: '10', speed: 'standard' as const };
  const steps = (e: any) => e.steps.map((s: any) => `${s.kind}:${s.state}`);

  it('B4: the same key and body answer the same transfer with its challenge and ask Circle nothing again; another body is refused; the replayed challenge approves', async () => {
    const key = crypto.randomUUID();
    const a = await api('POST', '/api/v1/bridge/proposals', BODY, key); expect(a.status, JSON.stringify(a.json)).toBe(200);
    iris.calls = [];
    const b = await api('POST', '/api/v1/bridge/proposals', BODY, key);
    expect(b.status).toBe(200); expect(b.json).toMatchObject({ replayed: true, proposal: { id: a.json.proposal.id, state: 'pending_approval', kind: 'bridge' } });
    expect(b.json.options.challenge).toBe(a.json.options.challenge);
    expect(iris.calls).toEqual([]);                                                                       // no fee schedule read, no preparation
    expect(await sql`select 1 from proposals where idempotency_key = ${key}`).toHaveLength(1);
    const other = await api('POST', '/api/v1/bridge/proposals', { ...BODY, amount: '11' }, key);
    expect(other.status).toBe(409); expect(other.json.error).toBe('idempotency_mismatch');
    expect((await api('POST', '/api/v1/bridge/proposals', { ...BODY, speed: 'fast' }, key)).json.error).toBe('idempotency_mismatch');
    const ap = await api('POST', `/api/v1/transfers/proposals/${a.json.proposal.id}/approve`, { assertion: owner.assert(Buffer.from(b.json.options.challenge, 'base64url')) });
    expect(ap.status, JSON.stringify(ap.json)).toBe(200);
    // once approved, the same request still answers the same transfer — without a challenge, and without a second burn
    const c = await api('POST', '/api/v1/bridge/proposals', BODY, key);
    expect(c.json).toMatchObject({ replayed: true, options: null, proposal: { id: a.json.proposal.id } }); expect(c.json.proposal.state).not.toBe('pending_approval');
    expect(await sql`select 1 from proposals where idempotency_key = ${key}`).toHaveLength(1);
  });

  it('B6: the option that was displayed is the one prepared — recorded when Circle\'s fee is unchanged, refused with the fresh figures when it rose', async () => {
    const q = (await api('GET', '/api/v1/bridge/quote?from=base&to=arbitrum&amount=10')).json;
    const [std, fast] = q.options;
    expect(std.quote).toMatchObject({ provider: 'cctp', amountOut: '10000000', minAmountOut: '10000000' }); expect(std.quote.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(fast.quote).toMatchObject({ provider: 'cctp', amountOut: '9998700', minAmountOut: '9998700' }); expect(fast.quote.fingerprint).not.toBe(std.quote.fingerprint);
    const ok = await api('POST', '/api/v1/bridge/proposals', { ...BODY, quote: std.quote }, crypto.randomUUID());
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.proposal.quote).toMatchObject({ provider: 'cctp', quotedOut: '10000000', firmOut: '10000000', deviationBps: 0, quotedOutDisplay: '10', firmOutDisplay: '10' });
    await api('POST', `/api/v1/transfers/proposals/${ok.json.proposal.id}/reject`, {});
    // Circle now asks 5 bps for Standard: the owner was shown 10 USDC, he would receive 9.995
    const before = (await sql`select count(*)::int as n from proposals`)[0].n, fees = iris.fees;
    iris.fees = [{ finalityThreshold: 1000, minimumFee: 1.3 }, { finalityThreshold: 2000, minimumFee: 5 }];
    try {
      const moved = await api('POST', '/api/v1/bridge/proposals', { ...BODY, quote: std.quote }, crypto.randomUUID());
      expect(moved.status).toBe(409);
      expect(moved.json).toMatchObject({ error: 'quote_moved', data: { deviationBps: -5, quoted: { amountOutDisplay: '10' }, fresh: { provider: 'cctp', amountOut: '9995000', amountOutDisplay: '9.995', symbol: 'USDC' } } });
      expect(moved.json.message).toMatch(/price moved/);
      expect((await sql`select count(*)::int as n from proposals`)[0].n).toBe(before);                    // nothing was prepared
      // the fresh figures are themselves a valid reference: accepting them prepares the transfer
      const f = moved.json.data.fresh, again = await api('POST', '/api/v1/bridge/proposals', { ...BODY, quote: { id: 'fresh', provider: f.provider, fingerprint: f.fingerprint, amountOut: f.amountOut, minAmountOut: f.minAmountOut, quotedAt: f.quotedAt } }, crypto.randomUUID());
      expect(again.status, JSON.stringify(again.json)).toBe(200); expect(again.json.proposal.bridge.minReceiveDisplay).toBe('9.995');
      await api('POST', `/api/v1/transfers/proposals/${again.json.proposal.id}/reject`, {});
    } finally { iris.fees = fees; }
    // the reference of the other speed, or of a provider this wallet does not execute, is not accepted for this preparation
    expect((await api('POST', '/api/v1/bridge/proposals', { ...BODY, quote: { ...std.quote, provider: 'lifi' } }, crypto.randomUUID())).json.error).toBe('quote_not_executable');
    expect((await api('POST', '/api/v1/bridge/proposals', { ...BODY, amount: '12', quote: std.quote }, crypto.randomUUID())).json.error).toBe('quote_mismatch');
  });

  it('B3: a hold carries a code and its parameters next to the English sentence; a failure carries an error code', async () => {
    const { id, intent } = await burn('10');
    iris.messages.set((await getP(id)).txid, attested(intent));
    chains.arbitrum!.native = 0n;                                                                         // no gas on the destination at mint time
    const p = await finish(id);
    expect(p.bridge).toMatchObject({ hold: 'destination_gas', holdCode: 'hold_destination_gas', holdParams: { sym: 'ETH', net: 'Arbitrum One', have: '0' } });
    expect(p.bridge.holdDetail).toBe(`add ETH on Arbitrum One: ${p.bridge.holdParams.need} is needed to receive the USDC, the wallet holds 0`);
    expect(p.execution.steps.find((s: any) => s.kind === 'mint')).toMatchObject({ state: 'pending', code: 'destination_gas' });
    chains.arbitrum!.native = 10n ** 17n; await finish(id);
    expect((await getP(id)).bridge).toMatchObject({ hold: null, holdCode: null, holdParams: null, holdDetail: null });   // cleared together
    chains.arbitrum!.mine(); await finish(id);
    chains.base!.allowance = 0n;                                                                          // the next transfer needs its own exact-amount approval
    const prep = await api('POST', '/api/v1/bridge/proposals', BODY, crypto.randomUUID());
    await api('POST', `/api/v1/transfers/proposals/${prep.json.proposal.id}/approve`, { assertion: owner.assert(Buffer.from(prep.json.options.challenge, 'base64url')) });
    chains.base!.burnReverts = true; chains.base!.mine(); await worker.reconcile();
    const failed = await getP(prep.json.proposal.id);
    expect(failed).toMatchObject({ state: 'failed', errorCode: 'burn_would_revert_approved', errorParams: { detail: expect.stringContaining('execution reverted') } });
    expect(failed.execution).toMatchObject({ state: 'failed', steps: [{ kind: 'approval', state: 'confirmed' }, { kind: 'burn', state: 'failed', code: 'burn_would_revert_approved' }, { kind: 'attestation', state: 'pending' }, { kind: 'mint', state: 'pending' }] });
  });

  // LAST in this file: it replaces the module instances (vi.resetModules), as a new API process would
  it('restart of the API between burn and mint, and again with the mint in flight: a fresh process (new modules, only the database and the signer\'s file) resumes and reconciles; the unified status is the same before and after', async () => {
    const { id, intent } = await burn('10');
    await bridge.advanceBridges();                                                                        // burn mined; Circle has not attested yet
    const before = (await getP(id)).execution;
    expect(steps(before)).toEqual(['approval:confirmed', 'burn:confirmed', 'attestation:confirming', 'mint:pending']);
    expect(before).toMatchObject({ kind: 'bridge', state: 'confirming', steps: [{ network: 'base' }, { network: 'base', txid: expect.stringMatching(/^0x/), explorer: expect.stringContaining('basescan') }, { network: 'circle', startedAt: expect.any(String) }, { network: 'arbitrum', txid: null }] });
    const boot = async () => { vi.resetModules(); const db = await import('../src/db.ts'), b = await import('../src/bridge.ts'), t = await import('../src/transfers.ts');
      return { sql: db.sql, b, view: async () => t.view((await db.sql`select * from proposals where id = ${id}`)[0] as never), poke: () => db.sql`update proposals set bridge = jsonb_set(bridge, '{nextAt}', '0') where id = ${id}` }; };

    // ── process 2: knows nothing but the row ──
    const p2 = await boot();
    expect(p2.b).not.toBe(bridge);                                                                        // really other module instances: nothing carried over in memory
    expect((await p2.view()).execution).toEqual(before);
    iris.messages.set((await getP(id)).txid, attested(intent));
    await p2.poke(); await p2.b.advanceBridges();                                                         // its worker alone: attestation verified, mint signed by the signer, relayed
    expect(chains.arbitrum!.sent).toHaveLength(1);
    const mintTxid = keccak256(chains.arbitrum!.sent[0] as Hex), mid = (await p2.view()).execution;
    expect(steps(mid)).toEqual(['approval:confirmed', 'burn:confirmed', 'attestation:confirmed', 'mint:broadcast']);
    expect(mid.steps[3]).toMatchObject({ txid: mintTxid, startedAt: expect.any(String), endedAt: null }); expect(mid.steps[3]!.explorer).toContain(mintTxid);
    await p2.sql.end();

    // ── process 3: starts with the mint still unconfirmed ──
    const p3 = await boot();
    await p3.poke(); await p3.b.advanceBridges();                                                         // not mined yet: nothing changes, nothing is signed again
    expect(steps((await p3.view()).execution)).toEqual(steps(mid)); expect(chains.arbitrum!.sent).toHaveLength(1);
    chains.arbitrum!.mine(); await p3.poke(); await p3.b.advanceBridges();
    const done = await p3.view();
    expect(done.bridge).toMatchObject({ stage: 'done', mintedBy: 'wallet', mintTxid, receivedDisplay: '10' });
    expect(done.execution).toMatchObject({ state: 'confirmed', steps: [{ state: 'confirmed' }, { state: 'confirmed' }, { state: 'confirmed' }, { kind: 'mint', state: 'confirmed', txid: mintTxid, endedAt: expect.any(String) }] });
    await p3.b.advanceBridges(); expect(chains.arbitrum!.sent).toHaveLength(1);                            // reconciled once: a later tick does nothing
    expect(store.state.bridges![id]!.mint!.signatures).toBe(1);                                           // one mint signature across three processes
    await p3.sql.end();
    expect((await getP(id)).execution).toEqual(done.execution);                                           // and the first process reads the same thing from the row
  });
});
