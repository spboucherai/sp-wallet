// Jupiter swap life cycle on Solana against a scripted cluster and a scripted Jupiter API (no network): the real API routes,
// worker steps and signer process boundary. The answers Jupiter gives here are real recorded ones (re-addressed to the test
// wallet); what the real program does with them is proven separately on mainnet by simulation (scripts/sim-jupiter.mts).
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { base58 } from '@scure/base';
import postgres from 'postgres';
import { BPF_UPGRADEABLE_LOADER, decodeSolV1Message, JUPITER_PIN, JUPITER_PROGRAM, jupiterMinOut, NETWORKS, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, verifyJupiterSwap, type Intent } from '@spw/core';
import { buildFor, jupFixture, solAta, solMint, solToken, type JupFixture } from '../../../tests/helpers/jupiter-fixtures.ts';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { createSignerServer } from '../../isolated-signer/src/server.ts';
import { Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';

const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'j'.repeat(48), DB = 'spw_test_jupiter';
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), ME = keys.addresses.solana!;
const owner = new TestPasskey(RP, ORIGIN);
const N = NETWORKS.solana!;
const spki = (k: string) => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(base58.decode(k))]), format: 'der', type: 'spki' });

/** A scripted Solana cluster: the state the API reads, and what a simulation or a confirmed transaction reports. */
class Cluster {
  f!: JupFixture; height = 5000; lamports = 500_000_000n; tokens: Record<string, bigint> = {}; sent: string[] = []; status = new Map<string, any>(); sims = 0; calls: string[] = [];
  blocks = 0; simErr: unknown = null; down: string[] = []; shortfall = 0n; steal: string | null = null;
  pd = { slot: JUPITER_PIN.lastDeploySlot, authority: JUPITER_PIN.upgradeAuthority as string, executable: true }; walletOwner = SYSTEM_PROGRAM; ext: unknown[] = [];
  use(name: string) { this.f = jupFixture(name); this.tokens = { [solToken(this.f.from).symbol]: 10n ** 12n }; return this.f; }
  /** balance tables for a message: the recorded mainnet ones, with the fee of the bytes actually submitted */
  tables(msg: Uint8Array) {
    const m = decodeSolV1Message(msg), s = this.f.simulation, fee = 5000 + Number(m.priorityFeeLamports);
    const post = [...s.postBalances]; post[0]! += s.fee - fee;
    const ptb = structuredClone(s.postTokenBalances), dstIdx = m.keys.indexOf(solAta(ME, this.f.to));
    if (this.shortfall) { if (this.f.to === 'SOL') post[0]! -= Number(this.shortfall); else { const e = ptb.find((b: any) => b.accountIndex === dstIdx); e.uiTokenAmount.amount = (BigInt(e.uiTokenAmount.amount) - this.shortfall).toString(); } }
    const pre = structuredClone(s.preTokenBalances);
    for (const t of [pre, ptb]) for (const b of t) if (b.owner === this.f.wallet) b.owner = ME;
    if (this.steal) { const idx = m.keys.indexOf(this.steal); pre.push({ accountIndex: idx, mint: solMint('JUP'), owner: ME, uiTokenAmount: { amount: '500' } }); ptb.push({ accountIndex: idx, mint: solMint('JUP'), owner: ME, uiTokenAmount: { amount: '100' } }); }
    return { err: null, fee, unitsConsumed: s.unitsConsumed, logs: [], preBalances: s.preBalances, postBalances: post, preTokenBalances: pre, postTokenBalances: ptb };
  }
  /** distinct transactions relayed (the adapter relays to every endpoint, and both endpoints are this double) */
  get unique() { return new Set(this.sent).size; }
  rpc(method: string, p: any[]): unknown {
    this.calls.push(method);
    const err = (message: string, code = -32002) => { throw Object.assign(new Error(message), { rpc: code }); };
    const key = (k: string) => Buffer.from(base58.decode(k));
    switch (method) {
      case 'getGenesisHash': return N.chainRef;
      case 'getBlockHeight': return this.height;
      case 'getBalance': return { value: Number(this.lamports) };
      case 'getLatestBlockhash': return { value: { blockhash: base58.encode(createHash('sha256').update(`block ${++this.blocks}`).digest()), lastValidBlockHeight: this.height + 150 } }; // a new one each time, as on a live cluster
      case 'getTokenAccountsByOwner': return { value: Object.entries(this.tokens).filter(([sym]) => (solToken(sym).program === 'token2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM) === p[1].programId)
        .map(([sym, amount]) => ({ pubkey: solAta(ME, sym), account: { data: { parsed: { info: { mint: solToken(sym).id, tokenAmount: { amount: amount.toString(), decimals: solToken(sym).decimals } } } } } })) };
      case 'getMultipleAccounts': return { value: (p[0] as string[]).map((k) => {
        if (p[1].dataSlice) return { lamports: 1, owner: TOKEN_PROGRAM }; // the aggregator's shared accounts all exist
        const sym = Object.keys(this.tokens).find((s) => solAta(ME, s) === k);
        return sym ? { lamports: 2039280, data: { parsed: { info: { tokenAmount: { amount: this.tokens[sym]!.toString() } } } } } : null; }) };
      case 'getAccountInfo': {
        const k = p[0] as string;
        if (k === JUPITER_PROGRAM) return { value: { owner: BPF_UPGRADEABLE_LOADER, executable: this.pd.executable, lamports: 1, data: [Buffer.concat([Buffer.from([2, 0, 0, 0]), key(JUPITER_PIN.programData)]).toString('base64'), 'base64'] } };
        if (k === JUPITER_PIN.programData) { const h = Buffer.alloc(45); h.writeUInt32LE(3, 0); h.writeBigUInt64LE(BigInt(this.pd.slot), 4); h[12] = 1; key(this.pd.authority).copy(h, 13);
          return { value: { owner: BPF_UPGRADEABLE_LOADER, executable: false, lamports: 1, data: [h.toString('base64'), 'base64'] } }; }
        if (k === ME) return { value: { owner: this.walletOwner, executable: false, lamports: Number(this.lamports), data: ['', 'base64'] } };
        if (N.tokens.some((t) => t.id === k)) return { value: { owner: TOKEN_2022_PROGRAM, executable: false, lamports: 1, data: { parsed: { type: 'mint', info: { decimals: 6, extensions: this.ext } } } } };
        return { value: null }; }
      case 'simulateTransaction': {
        this.sims++;
        const wire = Buffer.from(p[0], 'base64'), msg = new Uint8Array(wire.subarray(0, wire.length - 64));
        if (p[1].sigVerify && !verify(null, msg, spki(decodeSolV1Message(msg).keys[0]!), wire.subarray(wire.length - 64))) return err('Transaction signature verification failure', -32003);
        if (this.simErr) return { value: { err: this.simErr, logs: ['Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: custom program error: 0x1771'], unitsConsumed: 1 } };
        return { value: this.tables(msg) }; }
      case 'sendTransaction': { const wire = Buffer.from(p[0], 'base64'); this.sent.push(p[0]); return base58.encode(wire.subarray(wire.length - 64)); }
      case 'getSignatureStatuses': return { value: [this.status.get(p[0][0]) ?? null] };
      case 'getTransaction': { const raw = this.sent.find((r) => base58.encode(Buffer.from(r, 'base64').subarray(-64)) === p[0]); if (!raw || p[1].maxSupportedTransactionVersion !== 1) return null;
        const wire = Buffer.from(raw, 'base64'); return { slot: 1, meta: this.tables(new Uint8Array(wire.subarray(0, wire.length - 64))) }; }
      default: return err(`unscripted ${method}`);
    }
  }
}
const chain = new Cluster();
const jup: { calls: URLSearchParams[]; answer: (q: URLSearchParams) => { status: number; body: unknown } } = { calls: [], answer: () => ({ status: 200, body: buildFor(chain.f, ME) }) };
let fake: Server, signerSrv: Server, app: any, sql: any, worker: any, exec: any, cookie = '', store: Store;

async function api(method: string, path: string, body?: unknown, idem?: string) {
  const r = await app.inject({ method, url: path, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), setCookie: r.headers['set-cookie'] as string | undefined };
}
const row = async (id: string) => (await sql`select * from proposals where id = ${id}`)[0];
const getP = async (id: string) => (await api('GET', `/api/v1/transfers/proposals/${id}`)).json;
const amountOf = (f: JupFixture) => { const d = solToken(f.from).decimals, s = f.intent.amount.padStart(d + 1, '0'); return `${s.slice(0, -d)}.${s.slice(-d)}`.replace(/\.?0+$/, ''); };
const prepare = (f: JupFixture, o: Record<string, unknown> = {}) => api('POST', '/api/v1/swap/proposals', { network: 'solana', fromAsset: solToken(f.from).id, toAsset: solToken(f.to).id, amount: amountOf(f), slippageBps: 50, ...o }, crypto.randomUUID());
const approve = (prep: any) => api('POST', `/api/v1/transfers/proposals/${prep.json.proposal.id}/approve`, { assertion: owner.assert(Buffer.from(prep.json.options.challenge, 'base64url')) });
const confirm = (id: string, st: 'confirmed' | 'finalized', e: unknown = null) => chain.status.set(id, { confirmations: st === 'finalized' ? null : 3, err: e, confirmationStatus: st, slot: 777 });

beforeAll(async () => {
  const admin = postgres('postgres:///postgres', { max: 1, onnotice: () => {} });
  if (!(await admin`select 1 from pg_database where datname = ${DB}`).length) await admin.unsafe(`create database ${DB}`).catch((e: Error) => { if (!/already exists/.test(e.message)) throw e; });
  await admin.end();
  fake = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x'); let body = '';
    req.on('data', (c) => { body += c; }); req.on('end', () => {
      const send = (status: number, j: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (url.pathname === '/jup/build') { jup.calls.push(url.searchParams); const a = jup.answer(url.searchParams); return send(a.status, a.body); }
      const q = JSON.parse(body);
      if (chain.down.includes(q.method) || chain.down.includes('*')) return send(500, { error: 'down' });
      try { send(200, { jsonrpc: '2.0', id: q.id, result: chain.rpc(q.method, q.params) }); }
      catch (e) { send(200, { jsonrpc: '2.0', id: q.id, error: { code: (e as { rpc?: number }).rpc ?? -32000, message: (e as Error).message } }); }
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => fake.once('listening', r));
  const base = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  const dir = mkdtempSync(join(tmpdir(), 'spw-jup-api-'));
  store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('jup-setup-token').digest('hex');
  signerSrv = createSignerServer(new Signer(keys, store, { rpId: RP, origin: ORIGIN }), SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv.once('listening', r));
  Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, DATABASE_URL: `postgres:///${DB}`, SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`,
    SPW_BROADCAST: 'on', SPW_WORKERS: 'off', SPW_JUPITER_API: `${base}/jup`, SPW_RPC_OVERRIDE: JSON.stringify({ solana: [`${base}/rpc`, `${base}/rpc`] }) });
  const db = await import('../src/db.ts'); sql = db.sql;
  await sql.unsafe('drop schema public cascade; create schema public;'); await db.migrate();
  await import('../src/rpc-override.ts');
  app = await (await import('../src/server.ts')).buildServer({ swapProviders: [] });
  worker = await import('../src/worker.ts'); exec = await import('../src/swap-exec-sol.ts');
  const o = (await api('POST', '/api/v1/auth/setup/options', {})).json;
  const s = await api('POST', '/api/v1/auth/setup/verify', { challengeId: o.challengeId, response: owner.register(o.options.challenge), setupToken: 'jup-setup-token' });
  expect(s.status, JSON.stringify(s.json)).toBe(200); cookie = String(s.setCookie).split(';')[0]!;
});
afterAll(async () => { await app?.close(); signerSrv?.close(); fake?.close(); await sql?.end(); });
beforeEach(async () => {
  await sql`update proposals set state = 'failed' where state not in ('finalized', 'failed', 'expired', 'rejected', 'replaced')`;
  store.state.spent = {}; store.save();
  Object.assign(chain, { height: 5000, lamports: 500_000_000n, sent: [], sims: 0, calls: [], simErr: null, down: [], shortfall: 0n, steal: null, walletOwner: SYSTEM_PROGRAM, ext: [],
    pd: { slot: JUPITER_PIN.lastDeploySlot, authority: JUPITER_PIN.upgradeAuthority, executable: true } });
  chain.status.clear(); jup.calls = []; jup.answer = () => ({ status: 200, body: buildFor(chain.f, ME) });
  chain.use('usdc-bonk');
});

describe('preparation', () => {
  it('prepares a swap from a real Jupiter answer: verified like the signer will, simulated, costed, labelled "Metis"', async () => {
    const f = chain.f, prep = await prepare(f);
    expect(prep.status, JSON.stringify(prep.json)).toBe(200);
    const p = prep.json.proposal, r = await row(p.id), intent = r.intent as Intent;
    expect(p).toMatchObject({ state: 'pending_approval', kind: 'swap', network: 'solana', symbol: 'USDC', from: ME, to: ME, feeSymbol: 'SOL' });
    expect(p.swap).toMatchObject({ provider: 'jupiter', toSymbol: 'BONK', expectedOut: f.build.outAmount, minOut: jupiterMinOut(BigInt(f.build.outAmount), 50).toString(), needsApproval: false, simulated: true });
    expect(p.swap.detail).toMatchObject({ label: 'Jupiter (Metis)', instruction: 'shared_accounts_route_v2', rewritten: false, createsAccount: false, rent: '0', simulatedOut: f.effects.received });
    expect(p.swap.detail.venues).toEqual([...new Set(f.build.routePlan.map((l: any) => l.swapInfo.label))]);
    expect(BigInt(p.swap.detail.networkFee)).toBe(5000n + BigInt(p.swap.detail.priorityFee)); expect(p.feeEstimate).toBe(p.swap.detail.networkFee);
    expect(BigInt(p.maxFee)).toBeLessThanOrEqual(BigInt(store.policy.maxFee.solana!)); // ceiling: fee + the bound of the (idempotent) account creation
    expect(intent.swap).toMatchObject({ provider: 'jupiter', router: JUPITER_PROGRAM, approveGas: '0' }); expect(intent.sol!.computeUnitLimit).toBeLessThanOrEqual(400_000);
    const facts = verifyJupiterSwap(intent, new Uint8Array(Buffer.from(r.aux.swapMessage, 'base64'))); // exactly what the signer will run
    expect(facts.message.payer).toBe(ME); expect(facts.sourceAccount).toBe(solAta(ME, 'USDC')); expect(facts.destinationAccount).toBe(solAta(ME, 'BONK'));
    expect(jup.calls).toHaveLength(1);
    expect(Object.fromEntries(jup.calls[0]!)).toEqual({ inputMint: solMint('USDC'), outputMint: solMint('BONK'), amount: f.intent.amount, taker: ME, slippageBps: '50', transactionVersion: '1' }); // no fee account, no referral, no tip
    expect(chain.sims).toBe(2); expect(chain.sent).toHaveLength(0);
    expect((await api('GET', '/api/v1/swap/execution')).json.solana).toMatchObject({ provider: 'jupiter', label: 'Jupiter (Metis)', program: JUPITER_PROGRAM, lastDeploySlot: JUPITER_PIN.lastDeploySlot });
    // one operation in flight per network is enforced at approval; a swap is prepared once
    expect((await api('POST', `/api/v1/transfers/proposals/${p.id}/request-approval`, {})).json.error).toBe('bad_state');
  });

  it('rewrites a direct route (route_v2) to the shared-accounts form, shows the rent of a new token account', async () => {
    const f = chain.use('usdc-jup'); expect(f.converted).toBe(true);
    const prep = await prepare(f); expect(prep.status, JSON.stringify(prep.json)).toBe(200);
    const d = prep.json.proposal.swap.detail;
    expect(d).toMatchObject({ rewritten: true, instruction: 'shared_accounts_route_v2', createsAccount: true, rent: f.effects.rentKept });
    expect(BigInt(d.rent)).toBeGreaterThan(1_000_000n); expect(prep.json.proposal.warnings).toContain('creates_token_account');
    expect(BigInt(prep.json.proposal.feeEstimate)).toBe(BigInt(d.networkFee) + BigInt(d.rent));
    expect(BigInt(prep.json.proposal.maxFee)).toBeGreaterThanOrEqual(BigInt(d.networkFee) + BigInt(d.rent));
  });

  it.each(['sol-usdc', 'usdc-sol', 'usdc-sol-nowsol', 'usdc-pyusd', 'pyusd-usdc'])('%s: prepared with the recorded mainnet balance changes', async (name) => {
    const f = chain.use(name); chain.lamports = 2_000_000_000n;
    const prep = await prepare(f); expect(prep.status, JSON.stringify(prep.json)).toBe(200);
    expect(prep.json.proposal.swap.detail.simulatedOut).toBe(f.effects.received);
    expect(BigInt(f.effects.received)).toBeGreaterThanOrEqual(BigInt(prep.json.proposal.swap.minOut));
  });

  it('refuses when no verifiable route can be had: three attempts, each leaving out the venues already tried', async () => {
    chain.simErr = { InstructionError: [1, { Custom: 6001 }] };
    const r = await prepare(chain.f);
    expect([r.status, r.json.error]).toEqual([422, 'route_not_verifiable']); expect(r.json.message).toMatch(/nothing was signed/);
    expect(jup.calls).toHaveLength(3);
    const labels = [...new Set(chain.f.build.routePlan.map((l: any) => l.swapInfo.label))].join(',');
    expect(jup.calls[0]!.get('excludeDexes')).toBeNull(); expect(jup.calls[1]!.get('excludeDexes')).toBe(labels); expect(jup.calls[2]!.get('maxAccounts')).toBe('32');
    expect((await sql`select count(*)::int as n from proposals where state = 'pending_approval'`)[0].n).toBe(0);
    chain.simErr = null;
    jup.answer = () => ({ status: 400, body: { error: 'No routes found' } });
    expect((await prepare(chain.f)).json.error).toBe('no_route');
    jup.answer = () => ({ status: 429, body: { code: 429, message: 'Too many requests' } });
    expect((await prepare(chain.f)).json.error).toBe('provider_busy');
  });

  it('refuses a simulation that pays less than the minimum, spends another amount or touches another wallet account', async () => {
    chain.shortfall = BigInt(chain.f.effects.received) - jupiterMinOut(BigInt(chain.f.build.outAmount), 50) + 1n; // one unit under the minimum
    let r = await prepare(chain.f); expect(r.json.error, JSON.stringify(r.json).slice(0, 400)).toBe('route_not_verifiable'); expect(r.json.message).toMatch(/below the guaranteed minimum/);
    chain.shortfall -= 1n; // exactly the minimum: accepted
    r = await prepare(chain.f); expect(r.status, JSON.stringify(r.json)).toBe(200);
    await sql`update proposals set state = 'failed' where id = ${r.json.proposal.id}`; chain.shortfall = 0n;
    const ks = decodeSolV1Message(new Uint8Array(Buffer.from((await row(r.json.proposal.id)).aux.swapMessage, 'base64'))).keys;
    chain.steal = ks.find((k, n) => n > 0 && !chain.f.simulation.preTokenBalances.some((b: any) => b.accountIndex === n))!; // an account of the route turns out to be a token account of the wallet, and loses value
    r = await prepare(chain.f); expect(r.json.error).toBe('route_not_verifiable'); expect(r.json.message).toMatch(/another account of the wallet losing value/);
  });

  it('refuses answers that are not what was asked: a fee, a tip, lookup tables, another amount, another wallet', async () => {
    const good = () => buildFor(chain.f, ME);
    const tries: [string, (b: any) => void, string][] = [
      ['platform fee', (b) => { b.platformFee = { amount: '1', feeBps: 10 }; }, 'provider_bad_answer'],
      ['tip', (b) => { b.tipInstruction = b.cleanupInstruction ?? b.setupInstructions[0]; }, 'provider_bad_answer'],
      ['extra instruction', (b) => { b.otherInstructions = [b.setupInstructions[0]]; }, 'provider_bad_answer'],
      ['version 0', (b) => { b.transactionVersion = 0; }, 'provider_bad_answer'],
      ['lookup tables', (b) => { b.addressesByLookupTableAddress = { [solMint('USDC')]: [solMint('BONK')] }; }, 'provider_bad_answer'],
      ['compute budget instruction', (b) => { b.computeBudgetInstructions = [b.setupInstructions[0]]; }, 'provider_bad_answer'],
      ['another amount', (b) => { b.inAmount = '1'; }, 'provider_bad_answer'],
      ['another output', (b) => { b.outputMint = solMint('JUP'); }, 'provider_bad_answer'],
      ['exact out', (b) => { b.swapMode = 'ExactOut'; }, 'provider_bad_answer'],
    ];
    for (const [name, mut, code] of tries) { jup.answer = () => { const b = good(); mut(b); return { status: 200, body: b }; }; expect((await prepare(chain.f)).json.error, name).toBe(code); }
    jup.answer = () => ({ status: 200, body: chain.f.build }); // built for another wallet (the recorded public address)
    const r = await prepare(chain.f); expect(r.json.error).toBe('route_not_verifiable'); expect(jup.calls.length).toBeGreaterThanOrEqual(3);
    // a platform fee hidden in the instruction itself
    jup.answer = () => { const b = good(), d = Buffer.from(b.swapInstruction.data, 'base64'); d.writeUInt16LE(25, 27); b.swapInstruction.data = d.toString('base64'); return { status: 200, body: b }; };
    const h = await prepare(chain.f); expect(h.json.error).toBe('route_not_verifiable'); expect(h.json.message).toMatch(/platform fee/);
    expect(chain.sent).toHaveLength(0);
  });

  it('guards: the pinned program deployment, a plain wallet account, Token-2022 fees and hooks, balances, policy', async () => {
    const f = chain.f;
    chain.pd.slot += 1; expect((await prepare(f)).json).toMatchObject({ error: 'router_changed' }); chain.pd.slot -= 1;
    chain.pd.authority = ME; expect((await prepare(f)).json.error).toBe('router_changed'); chain.pd.authority = JUPITER_PIN.upgradeAuthority;
    chain.pd.executable = false; expect((await prepare(f)).json.error).toBe('router_changed'); chain.pd.executable = true;
    chain.walletOwner = TOKEN_PROGRAM; expect((await prepare(f)).json.error).toBe('account_not_plain'); chain.walletOwner = SYSTEM_PROGRAM;
    chain.down = ['getGenesisHash']; expect((await prepare(f)).json.error).toBe('rpc_degraded'); chain.down = [];
    expect(jup.calls).toHaveLength(0); // nothing was even asked of Jupiter
    chain.tokens.USDC = 1n; expect((await prepare(f)).json.error).toBe('insufficient_funds'); chain.tokens.USDC = 10n ** 12n;
    chain.lamports = 100_000n; expect((await prepare(f)).json.error).toBe('insufficient_gas'); chain.lamports = 500_000_000n;
    expect((await prepare(f, { toAsset: solToken('USDC').id })).json.error).toBe('same_asset');
    expect((await prepare(f, { toAsset: 'So11111111111111111111111111111111111111112' })).json.error).toBe('unsupported_asset'); // wrapped SOL is not a registry asset: SOL is "native"
    const p = chain.use('usdc-pyusd');
    chain.ext = [{ extension: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 5 }, olderTransferFee: { transferFeeBasisPoints: 0 } } }];
    expect((await prepare(p)).json.error).toBe('token_has_fee');
    chain.ext = [{ extension: 'transferHook', state: { programId: ME } }];
    expect((await prepare(p)).json.error).toBe('token_has_hook');
    chain.ext = [{ extension: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 0 }, olderTransferFee: { transferFeeBasisPoints: 0 } } }, { extension: 'transferHook', state: { programId: null } }];
    expect((await prepare(p)).status).toBe(200);
    // policy as for a send: USDC is capped at 50 per operation
    chain.use('usdc-bonk'); await sql`update proposals set state = 'failed'`;
    jup.answer = () => { const b = buildFor(chain.f, ME), d = Buffer.from(b.swapInstruction.data, 'base64'); b.inAmount = '60000000'; d.writeBigUInt64LE(60_000000n, 9); b.swapInstruction.data = d.toString('base64'); return { status: 200, body: b }; };
    chain.rpc = ((orig) => function (this: Cluster, m: string, q: any[]) { const r: any = orig.call(this, m, q); if (m === 'simulateTransaction' && r.value.preTokenBalances) { const k = decodeSolV1Message(new Uint8Array(Buffer.from(q[0], 'base64').subarray(0, -64))).keys.indexOf(solAta(ME, 'USDC')); r.value.postTokenBalances.find((b: any) => b.accountIndex === k).uiTokenAmount.amount = (BigInt(r.value.preTokenBalances.find((b: any) => b.accountIndex === k).uiTokenAmount.amount) - 60_000000n).toString(); } return r; })(chain.rpc);
    const big = await prepare(chain.f, { amount: '60' });
    delete (chain as any).rpc;
    expect([big.status, big.json.error]).toEqual([422, 'policy']); expect(big.json.message).toMatch(/per-transaction limit for solana:USDC/);
  });
});

describe('approval, sending and outcome', () => {
  it('approve → signed by the signer → simulated with its signature → sent once → confirmed: the outcome is the real balance change', async () => {
    const f = chain.f, prep = await prepare(f), id = prep.json.proposal.id;
    const done = await approve(prep); expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json.state).toBe('broadcast'); expect(chain.unique).toBe(1); expect(chain.sent).toHaveLength(N.rpc.length);
    const wire = Buffer.from(chain.sent[0]!, 'base64'), msg = wire.subarray(0, wire.length - 64), sig = wire.subarray(wire.length - 64);
    expect(msg.toString('base64')).toBe((await row(id)).aux.swapMessage); expect(verify(null, msg, spki(ME), sig)).toBe(true);
    expect(done.json.txid).toBe(base58.encode(sig)); expect(done.json.explorer).toContain(done.json.txid);
    // a second swap or a send on Solana must wait
    expect((await prepare(f)).json.error).toBe('pending_tx');
    // confirmed with a little less than expected, still above the approved minimum
    chain.shortfall = BigInt(f.effects.received) - BigInt(f.build.outAmount) + 1234n; confirm(done.json.txid, 'confirmed'); // lands 1234 units under the quote
    await worker.reconcile();
    let p = await getP(id); expect(p.state).toBe('confirming');
    expect(p.swap.received).toBe((BigInt(f.build.outAmount) - 1234n).toString()); expect(BigInt(p.swap.received)).toBeGreaterThanOrEqual(BigInt(p.swap.minOut)); expect(BigInt(p.swap.received)).toBeLessThan(BigInt(p.swap.expectedOut));
    confirm(done.json.txid, 'finalized'); await worker.reconcile();
    p = await getP(id); expect(p.state).toBe('finalized'); expect(p.swap.receivedDisplay).toBeTruthy();
    expect(chain.unique).toBe(1); expect(chain.sent).toHaveLength(N.rpc.length); // relayed in one round only
    const audit = (await api('GET', '/api/v1/security/audit?limit=200')).json;
    expect(audit.intact).toBe(true);
    const mine = audit.events.filter((e: any) => e.data?.id === id).map((e: any) => e.type);
    expect(mine).toEqual(expect.arrayContaining(['swap.prepared', 'swap.settled', 'transfer.signed', 'transfer.broadcast', 'transfer.finalized']));
    expect(audit.events.find((e: any) => e.type === 'swap.settled' && e.data.id === id).data).toMatchObject({ received: p.swap.received, spent: f.intent.amount, minOut: p.swap.minOut });
    expect(Object.values(store.state.spent)).toEqual([f.intent.amount]); // counted once against the daily limit
  });

  it.each(['usdc-sol', 'sol-usdc'])('%s: the outcome of a swap with SOL on one side comes from the lamport balances', async (name) => {
    const f = chain.use(name); chain.lamports = 2_000_000_000n;
    const prep = await prepare(f), done = await approve(prep); expect(done.json.state, JSON.stringify(done.json)).toBe('broadcast');
    confirm(done.json.txid, 'finalized'); await worker.reconcile();
    const p = await getP(prep.json.proposal.id); expect(p.state).toBe('finalized'); expect(p.swap.received).toBe(f.effects.received);
  });

  it('blockhash expired before the transaction could be sent: failed, nothing sent, nothing moved', async () => {
    const prep = await prepare(chain.f);
    chain.height += 151; // past lastValidBlockHeight
    const r = await approve(prep);
    expect(r.json.state, JSON.stringify(r.json) + JSON.stringify(prep.json).slice(0, 300)).toBe('failed'); expect(r.json.error).toMatch(/expired before it could be sent.*nothing was swapped/); expect(chain.sent).toHaveLength(0);
    await worker.reconcile(); expect(chain.sent).toHaveLength(0);
    expect((await prepare(chain.f)).status).toBe(200); // the network is free again
  });

  it('the swap would fail at the moment of sending: not sent', async () => {
    const prep = await prepare(chain.f);
    chain.simErr = { InstructionError: [1, { Custom: 6001 }] };
    const r = await approve(prep);
    expect(r.json.state).toBe('failed'); expect(r.json.error).toMatch(/would fail now.*6001.*not sent/); expect(chain.sent).toHaveLength(0);
    chain.simErr = null; chain.shortfall = BigInt(chain.f.effects.received) - jupiterMinOut(BigInt(chain.f.build.outAmount), 50) + 1n; // or it would now pay one unit less than the approved minimum
    const prep2 = await (async () => { const s = chain.shortfall; chain.shortfall = 0n; const x = await prepare(chain.f); chain.shortfall = s; return x; })();
    const r2 = await approve(prep2);
    expect(r2.json.state).toBe('failed'); expect(r2.json.error).toMatch(/no longer delivers the approved minimum/); expect(chain.sent).toHaveLength(0);
  });

  it('RPC unreachable: retried, never duplicated', async () => {
    const prep = await prepare(chain.f), id = prep.json.proposal.id;
    chain.down = ['simulateTransaction', 'getBlockHeight'];
    const r = await approve(prep);
    expect(r.json.state).toBe('signed'); expect(chain.sent).toHaveLength(0); // not failed: nothing is known yet
    await worker.reconcile(); expect((await getP(id)).state).toBe('signed');
    chain.down = ['sendTransaction']; // the gate passes, the relay itself fails
    await worker.reconcile();
    let p = await getP(id); expect(p.state).toBe('signed'); expect(p.error).toMatch(/broadcast attempt failed/); expect(chain.sent).toHaveLength(0);
    chain.down = [];
    await worker.reconcile();
    p = await getP(id); expect(p.state).toBe('broadcast'); expect(chain.sent).toHaveLength(N.rpc.length);
    // not seen by the cluster yet: the same signed bytes are relayed again, never a new transaction
    await sql`update proposals set last_broadcast_at = now() - interval '2 minutes' where id = ${id}`;
    await worker.reconcile(); await worker.reconcile();
    expect(chain.sent.length).toBeGreaterThanOrEqual(2 * N.rpc.length); expect(chain.unique).toBe(1);
    expect((await row(id)).txid).toBe(p.txid);
    chain.down = ['*']; await worker.reconcile(); expect((await getP(id)).state).toBe('broadcast'); chain.down = []; // a dead node changes nothing
    confirm(p.txid, 'finalized'); await worker.reconcile();
    expect((await getP(id)).state).toBe('finalized'); expect(Object.values(store.state.spent)).toHaveLength(1);
  });

  it('sent but never included: expires with the blockhash, nothing moved; an on-chain failure records no outcome', async () => {
    const prep = await prepare(chain.f), r = await approve(prep); expect(r.json.state).toBe('broadcast');
    chain.height += 200; await worker.reconcile();
    let p = await getP(prep.json.proposal.id); expect(p.state).toBe('failed'); expect(p.error).toMatch(/expired before inclusion.*no funds moved/); expect(p.swap.received).toBeNull();
    const prep2 = await prepare(chain.f), r2 = await approve(prep2); expect(r2.json.state).toBe('broadcast');
    confirm(r2.json.txid, 'confirmed', { InstructionError: [1, { Custom: 6001 }] }); await worker.reconcile();
    p = await getP(prep2.json.proposal.id); expect(p.state).toBe('failed'); expect(p.error).toMatch(/on-chain error.*6001/); expect(p.swap.received).toBeNull();
  });

  it('a message swapped in the database after preparation is refused by the signer; an expired approval window too', async () => {
    const prep = await prepare(chain.f), id = prep.json.proposal.id;
    const other = chain.use('usdc-jup'); void other;
    const evil = await exec.prepareJupiterSwap({ n: N, me: ME, keyId: keys.keyId, fromAsset: solToken('USDC').id, toAsset: solToken('JUP').id, amount: 25_000000n, slippageBps: 50, policyVersion: store.policy.version, proposalId: crypto.randomUUID(), feeCeiling: 3_000_000n });
    await sql`update proposals set aux = ${sql.json({ swapMessage: evil.message })} where id = ${id}`;
    const r = await approve(prep);
    expect(r.status).toBe(422); expect(r.json.message).toMatch(/message does not match the approved hash/);
    expect((await getP(id)).state).toBe('failed'); expect(chain.sent).toHaveLength(0);
    chain.use('usdc-bonk');
    const late = await prepare(chain.f);
    await sql`update proposals set expires_at = now() - interval '1 second' where id = ${late.json.proposal.id}`;
    expect((await approve(late)).json.error).toBe('expired'); expect(chain.sent).toHaveLength(0);
  });
});

describe('balance effects of a transaction (simulated or confirmed)', () => {
  it.each(['usdc-bonk', 'usdc-jup', 'jup-usdc', 'sol-usdc', 'sol-usdc-nowsol', 'usdc-sol', 'usdc-sol-nowsol', 'usdc-pyusd', 'pyusd-usdc', 'usdc-usdt'])('%s: recorded mainnet simulation → exact input, output, rent, nothing else touched', (name) => {
    const f = jupFixture(name), facts = verifyJupiterSwap(f.intent, new Uint8Array(Buffer.from(f.message, 'base64')));
    const fx = exec.swapEffects(facts, { err: null, ...f.simulation });
    expect(fx.spent.toString()).toBe(f.intent.amount); expect(fx.received.toString()).toBe(f.effects.received); expect(fx.rentKept.toString()).toBe(f.effects.rentKept);
    expect(fx.otherLosses).toEqual([]); expect(fx.received).toBeGreaterThanOrEqual(facts.minOut); expect(fx.fee).toBe(facts.networkFee); expect(fx.rentKept).toBeLessThanOrEqual(facts.rentMax);
    expect(() => exec.swapEffects(facts, { err: null, fee: 5000 })).toThrow(/balance tables missing/);
    expect(() => exec.swapEffects(facts, { err: null, ...f.simulation, preBalances: f.simulation.preBalances.slice(1) })).toThrow(/balance tables missing/);
  });
  it('lamports leaving the wallet beyond fee and rent are reported', () => {
    const f = jupFixture('usdc-bonk'), facts = verifyJupiterSwap(f.intent, new Uint8Array(Buffer.from(f.message, 'base64')));
    const post = [...f.simulation.postBalances]; post[0]! -= 1000;
    expect(exec.swapEffects(facts, { err: null, ...f.simulation, postBalances: post }).otherLosses).toEqual(['lamports -1000']);
  });
});
