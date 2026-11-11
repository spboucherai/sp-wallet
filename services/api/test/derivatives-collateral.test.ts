// Collateral of a venue account, end to end inside the process: the REAL collateral service and its routes, the REAL isolated
// signer class (public test mnemonic, real WebAuthn assertions from a software passkey), PostgreSQL (database
// spw_deriv_collateral_test, created here if missing), the scripted fake of the Hyperliquid endpoints extended with the venue's
// ledger and the `withdraw3` action (it recovers the signer from the signature, like the venue), and a fake of the wallet's
// chain side. No network: a request to any real host fails the test; nothing is broadcast (SPW_BROADCAST=off).
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi, parseTransaction } from 'viem';
import { intentHash, type Intent } from '@spw/core';
import { HL_BRIDGE_PINS, recoverTypedDataSigner, venueWithdrawalHash, type HlBridgePin, type VenueWithdrawal } from '@spw/derivatives/live';
import { buildWithdraw3TypedDataOnly } from '../../../packages/derivatives/src/venues/hyperliquid/signing.ts';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { Signer, SignerError } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';
import { Clock, useDatabase } from './derivatives-helpers.ts';
import { FakeHl } from './hl-fake.ts';

const RP = 'wallet.test', ORIGIN = 'https://wallet.test';
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const ME = keys.addresses.evm, ACCOUNT = ME.toLowerCase(), PIN = HL_BRIDGE_PINS.mainnet!, OTHER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

let sql: any, lv: typeof import('../src/derivatives/live.ts'), co: typeof import('../src/derivatives/collateral.ts'), cr: typeof import('../src/derivatives/collateral-routes.ts'), UserError: typeof import('../src/config.ts').UserError;
type Svc = import('../src/derivatives/collateral.ts').CollateralService;
type Chain = import('../src/derivatives/collateral.ts').CollateralChain;

beforeAll(async () => {
  await useDatabase('deriv_collateral');
  const db = await import('../src/db.ts');
  sql = db.sql;
  await db.migrate();
  await db.migrate();
  lv = await import('../src/derivatives/live.ts'); co = await import('../src/derivatives/collateral.ts'); cr = await import('../src/derivatives/collateral-routes.ts');
  UserError = (await import('../src/config.ts')).UserError;
});
beforeEach(async () => { await sql`truncate deriv_accounts, deriv_collateral, proposals, deposits`; });
afterAll(async () => { await sql?.end(); });

type Fault = null | 'lost_before' | 'lost_after' | 'garbage_after';
/** the venue's ledger, account mode and withdraw3 on top of the scripted fake (shapes read live on mainnet, 2026-11-11) */
class VenueWithLedger {
  readonly fake: FakeHl;
  ledger = new Map<string, { time: number; hash: string; delta: Record<string, unknown> }[]>();
  abstraction = 'default';
  fault: Fault = null; faultAlways = false;
  usedNonces = new Set<number>();
  pending: { user: string; destination: string; net: string; time: number }[] = [];
  exchanges: any[] = [];
  constructor(fake: FakeHl) { this.fake = fake; }
  private entries(user: string) { const k = user.toLowerCase(); if (!this.ledger.has(k)) this.ledger.set(k, []); return this.ledger.get(k)!; }
  /** the venue credits a bridge deposit: ledger entry whose hash is the Arbitrum transaction, balance up */
  credit(user: string, txid: string, usdc: string): void {
    const u = this.fake.user(user); u.funded = true; u.usdc = String(Number(u.usdc) + Number(usdc));
    this.entries(user).push({ time: this.fake.now(), hash: txid, delta: { type: 'deposit', usdc: Number(usdc).toFixed(1).replace(/\.0$/, '.0') } });
  }
  /** the validators paid out: ledger entry `withdraw` (usdc = received, fee, nonce in µs); returns what arrived on the wallet */
  payout(k = 0): { txid: string; amount: string; seenAt: number } {
    const p = this.pending.splice(k, 1)[0]!, txid = `0x${createHash('sha256').update(`payout-${p.time}`).digest('hex')}`;
    this.entries(p.user).push({ time: this.fake.now(), hash: `0x${'ab'.repeat(32)}`, delta: { type: 'withdraw', usdc: p.net, nonce: p.time * 1000, fee: '1.0' } });
    return { txid, amount: String(Math.round(Number(p.net) * 1e6)), seenAt: this.fake.now() };
  }
  fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url)), body = JSON.parse(String(init?.body ?? '{}'));
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.host !== this.fake.host) throw new Error(`no fake venue for ${u.host}: the tests must never reach a real endpoint`);
    if (u.pathname === '/info' && body.type === 'userNonFundingLedgerUpdates') return json(this.entries(body.user).filter((e) => e.time >= body.startTime));
    if (u.pathname === '/info' && body.type === 'userAbstraction') return json(this.abstraction);
    if (u.pathname === '/info' && body.type === 'spotClearinghouseState') return json({ balances: this.abstraction === 'default' ? [] : [{ coin: 'USDC', token: 0, total: this.fake.user(body.user).usdc, hold: '0.0' }] });
    if (u.pathname === '/exchange' && body.action?.type === 'withdraw3') {
      this.exchanges.push(body);
      const fault = this.fault; if (!this.faultAlways) this.fault = null;
      const timeout = () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; return e; };
      if (fault === 'lost_before') throw timeout();
      const answer = await this.withdraw(body);
      if (fault === 'lost_after') throw timeout();
      if (fault === 'garbage_after') return new Response('<html>upstream error</html>', { status: 200 });
      return json(answer);
    }
    return this.fake.fetch(url as never, init);
  }) as unknown as typeof fetch;
  private async withdraw(b: any): Promise<unknown> {
    const a = b.action, err = (response: string) => ({ status: 'err', response });
    if (Object.keys(a).join() !== 'type,hyperliquidChain,signatureChainId,destination,amount,time' || b.nonce !== a.time || b.vaultAddress !== null) return err(`fake: malformed withdraw3 ${JSON.stringify(b).slice(0, 400)}`);
    if (a.hyperliquidChain !== (this.fake.net === 'mainnet' ? 'Mainnet' : 'Testnet')) return err('fake: wrong chain');
    const td = buildWithdraw3TypedDataOnly({ network: this.fake.net, destination: a.destination, amount: a.amount, time: a.time, signatureChainId: a.signatureChainId }).typedData;
    const signer = await recoverTypedDataSigner(td, b.signature), u = this.fake.users.get(signer);
    if (!u?.funded) return err(`Must deposit before performing actions. User: ${signer}`);
    if (this.usedNonces.has(a.time)) return err('Invalid nonce: duplicate nonce');
    if (Number(u.usdc) < Number(a.amount)) return err('Insufficient balance for withdrawal');
    this.usedNonces.add(a.time);
    u.usdc = String(Math.round((Number(u.usdc) - Number(a.amount)) * 1e6) / 1e6);
    this.pending.push({ user: signer, destination: a.destination, net: String(Math.round((Number(a.amount) - 1) * 1e6) / 1e6), time: a.time });
    return { status: 'ok', response: { type: 'default' } };
  }
}

function world() {
  const clock = new Clock(Date.parse('2026-11-11T12:00:00Z'));
  const t = new VenueWithLedger(new FakeHl('testnet', clock.now)), m = new VenueWithLedger(new FakeHl('mainnet', clock.now));
  const dir = mkdtempSync(join(tmpdir(), 'spw-coll-'));
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('tok').digest('hex');
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => Math.floor(clock.now() / 1000), { get: async (s) => Object.fromEntries(s.map((k) => [k, 70_000])) });
  const pk = new TestPasskey(RP, ORIGIN);
  const call = async <T>(fn: () => T | Promise<T>): Promise<T> => { try { return await fn(); } catch (e) { if (e instanceof SignerError) throw new UserError(`signer_${e.code}`, e.message, 422); throw e; } };
  const seen = { sign: [] as unknown[], withdraw: [] as unknown[] };
  const port: import('../src/derivatives/collateral.ts').CollateralSignerPort = {
    status: () => call(() => signer.status()),
    sign: (i, a) => { seen.sign.push(i); return call(() => signer.sign(i, a as never)); },
    venueWithdraw: (x, a) => { seen.withdraw.push(x); return call(() => signer.venueWithdraw(x, a as never)); },
  };
  const flags = { mainnet: true };
  const chain = { usdc: 40_000_000n, native: 10n ** 15n, elsewhere: [] as { network: string; name: string; usdc: string }[], guard: null as null | (() => never), live: true, arrivals: [] as { txid: string; amount: string; seenAt: number }[], prepared: 0, guards: 0 };
  const fakeChain: Chain = {
    guards: async (pin: HlBridgePin) => { chain.guards++; expect(pin).toBe(PIN); if (chain.guard) chain.guard(); },
    liveness: async () => ({ ok: chain.live, checkedAt: clock.now(), checked: 3, credited: chain.live ? 3 : 0, samples: [], detail: chain.live ? '3 of the 3 most recent deposits into the bridge are in the venue\'s ledger' : 'none of the 3 most recent deposits into the bridge is in the venue\'s ledger' }),
    balances: async () => ({ usdc: chain.usdc, native: chain.native }),
    elsewhere: async () => chain.elsewhere,
    prepare: async (_pin, from, amount) => { chain.prepared++; expect(from).toBe(ME); expect(amount > 0n).toBe(true);
      return { section: { evm: { nonce: 7, gasLimit: '90000', maxFeePerGas: '100000000', maxPriorityFeePerGas: '1000000' } }, maxFee: 9_000_000_000_000n, feeEstimate: 4_500_000_000_000n, warnings: [], ttlSec: 180 }; },
    arrivals: async (_pin, _me, since) => chain.arrivals.filter((x) => x.seenAt >= since),
  };
  const routed = (async (url: string, init?: RequestInit) => { const host = new URL(String(url)).host; const f = [t, m].find((x) => x.fake.host === host); if (!f) throw new Error(`no fake venue for ${host}`); return f.fetch(url as never, init); }) as unknown as typeof fetch;
  const build = (): Svc => new co.CollateralService({ live: lv.createLive({ fetch: routed, signer: { ...port, venueKey: (v: string, n: string) => call(() => signer.venueKey(v, n)) } as never, now: clock.now, rpId: RP, mainnetEnabled: () => flags.mainnet,
    credentials: async () => [{ id: pk.id, transports: ['internal'] }], confirmDelayMs: 0 }), signer: port, chain: fakeChain });
  const w = { clock, t, m, signer, store, pk, port, seen, flags, chain, svc: build(), restart: () => { w.svc = build(); return w.svc; }, next: (ms = 61_000) => clock.advance(ms) };
  return w;
}
type World = ReturnType<typeof world>;
const refusal = async (p: Promise<unknown>) => { const e = await p.then(() => null, (x) => x); return e ? { code: e.code as string, status: e.status as number, message: e.message as string } : null; };
const audits = async (id: string) => (await sql`select type from audit_events where data->>'account' = ${id} and type like 'deriv.collateral.%' order by seq`).map((r: { type: string }) => r.type.replace('deriv.collateral.', '')) as string[];

async function account(w: World, network: 'mainnet' | 'testnet' = 'mainnet', fund: string | null = null) {
  if (w.signer.status().credentials.length === 0) await w.signer.enroll({ credential: w.pk.credential(), setupToken: 'tok' });
  if (fund !== null) (network === 'mainnet' ? w.m : w.t).fake.fund(ACCOUNT, fund);
  const a = await w.svc.deps.live.createAccount({ venue: 'hyperliquid', network, label: 'test' });
  return a.id as string;
}
const proposal = async (opId: string) => (await sql`select p.* from proposals p join deriv_collateral c on c.proposal_id = p.id where c.id = ${opId}`)[0];
/** what the wallet's own worker does when the chain confirms / reverts the transfer (the worker is off in tests) */
const chainSays = async (opId: string, state: string, error: string | null = null) => { await sql`update proposals set state = ${state}, confirmations = 3, error = ${error} where id = (select proposal_id from deriv_collateral where id = ${opId})`; };
async function deposited(w: World, id: string, amount = '10') {
  const prep = await w.svc.prepareDeposit(id, { amount });
  const done = await w.svc.approveDeposit(id, prep.operation.id, w.pk.assert(intentHash(prep.intent)));
  return { prep, op: done.operation };
}

describe('status: what the two sheets show', () => {
  it('names the pinned route, the minimum, who is credited, the wallet side and its limits', async () => {
    const w = world(), id = await account(w, 'mainnet', '25');
    const s = await w.svc.status(id);
    expect(s).toMatchObject({ account: ACCOUNT, network: 'mainnet', mainnetEnabled: true,
      route: { id: 'arbitrum-bridge2', network: 'arbitrum', networkName: 'Arbitrum One', bridge: PIN.bridge, asset: 'USDC', token: PIN.usdc, venueMinimum: '5', minimum: '6', expectedSeconds: 60, credits: 'sender', venueFee: '0', legacy: true, codeSha256: PIN.codeSha256 },
      withdrawal: { fee: '1', expectedSeconds: 240, destination: ACCOUNT, payoutNetworkName: 'Arbitrum One', arrivalTracked: true, available: '25' },
      wallet: { address: ME, network: 'arbitrum', usdc: '40', gasSymbol: 'ETH', limits: { perTransfer: '50', perDay: '100', spentToday: '0', maxNow: '40' }, elsewhere: [] },
      deposit: { available: true, reason: null }, withdraw: { available: true, reason: null }, operations: [] });
    expect(s.venueBalance).toMatchObject({ abstraction: 'default', equity: '25', withdrawable: '25', total: '25', error: null });
  });

  it('says why nothing can be deposited: server setting, testnet, no USDC here but elsewhere, no gas', async () => {
    const w = world(), id = await account(w), tid = await account(w, 'testnet');
    w.flags.mainnet = false;
    expect((await w.svc.status(id))).toMatchObject({ deposit: { available: false, reason: 'mainnet_disabled' }, withdraw: { available: false, reason: 'mainnet_disabled' } });
    expect((await w.svc.status(tid))).toMatchObject({ route: null, wallet: null, deposit: { available: false, reason: 'no_route' }, withdraw: { available: true }, withdrawal: { payoutNetworkName: 'Arbitrum Sepolia', arrivalTracked: false } });
    w.flags.mainnet = true;
    w.chain.usdc = 2_000_000n; w.chain.elsewhere = [{ network: 'base', name: 'Base', usdc: '31.5' }];
    expect((await w.svc.status(id)).deposit).toEqual({ available: false, reason: 'usdc_elsewhere', bridgeFrom: [{ network: 'base', name: 'Base', usdc: '31.5' }] });
    w.chain.elsewhere = [];
    expect((await w.svc.status(id)).deposit).toMatchObject({ available: false, reason: 'no_usdc' });
    w.chain.usdc = 40_000_000n; w.chain.native = 0n;
    expect((await w.svc.status(id)).deposit).toMatchObject({ available: false, reason: 'no_gas' });
  });

  it('reads the collateral where a "unified account" keeps it', async () => {
    const w = world(), id = await account(w, 'mainnet', '18.5');
    w.m.abstraction = 'unifiedAccount';
    const s = await w.svc.status(id);
    expect(s.venueBalance).toMatchObject({ abstraction: 'unifiedAccount', spotUsdc: '18.5', total: '18.5' });
    expect(s.withdrawal.available).toBe('18.5');
  });
});

describe('deposit', () => {
  it('prepare → passkey → signed transfer to the pinned bridge → on-chain → waits for the venue → credited, never before', async () => {
    const w = world(), id = await account(w);
    const prep = await w.svc.prepareDeposit(id, { amount: '10' });
    expect(prep.intent).toMatchObject({ network: 'arbitrum', chainRef: '42161', asset: PIN.usdc, symbol: 'USDC', decimals: 6, amount: '10000000', from: ME, to: PIN.bridge,
      venueDeposit: { venue: 'hyperliquid', venueNetwork: 'mainnet', route: 'arbitrum-bridge2', bridge: PIN.bridge, minAmount: '6000000' } });
    expect(prep.options.challenge).toBe(Buffer.from(intentHash(prep.intent as Intent)).toString('base64url'));
    expect(prep.operation).toMatchObject({ kind: 'deposit', state: 'pending_approval', final: false, amount: '10', chainNetwork: 'arbitrum', bridge: PIN.bridge, balanceBefore: { total: '0' }, overdue: false });
    expect(prep.liveness.ok).toBe(true);
    expect(w.seen.sign).toHaveLength(0);

    const done = await w.svc.approveDeposit(id, prep.operation.id, w.pk.assert(intentHash(prep.intent)));
    expect(done.operation).toMatchObject({ state: 'sent', final: false, proposalState: 'broadcast' });
    const p = await proposal(prep.operation.id);
    const tx = parseTransaction(p.raw), callData = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
    expect([tx.chainId, tx.to?.toLowerCase(), callData.functionName, callData.args]).toEqual([42161, PIN.usdc.toLowerCase(), 'transfer', [PIN.bridge, 10_000_000n]]);
    expect(done.operation.txid).toBe(p.txid);
    expect(w.chain.guards).toBe(2); // at prepare and again at the moment of signing

    // the chain confirms; the venue has not credited yet: the screen must wait
    await chainSays(prep.operation.id, 'confirming'); w.next();
    let op = (await w.svc.operation(id, prep.operation.id)).operation;
    expect(op).toMatchObject({ state: 'awaiting_credit', final: false, overdue: false, check: [], ledger: null, balanceAfter: null });
    // a deposit of the same amount by the same address in ANOTHER transaction is not ours
    w.m.ledger.set(ACCOUNT, [{ time: w.clock.now(), hash: `0x${'77'.repeat(32)}`, delta: { type: 'deposit', usdc: '10.0' } }]); w.next();
    expect((await w.svc.operation(id, prep.operation.id)).operation.state).toBe('awaiting_credit');
    // ten minutes later still nothing: it says what to check, and keeps polling
    w.next(co.DEPOSIT_OVERDUE_MS);
    op = (await w.svc.operation(id, prep.operation.id)).operation;
    expect(op).toMatchObject({ state: 'awaiting_credit', final: false, overdue: true, check: ['tx_success', 'tx_to_bridge', 'amount_min', 'venue_ledger', 'venue_status'] });
    // the venue credits: its ledger names our transaction
    w.m.credit(ACCOUNT, p.txid.toUpperCase().replace('0X', '0x'), '10'); w.next();
    const after = w.restart(); // a new process: the state is in the database
    expect((await after.step()).errors).toEqual([]);
    op = (await after.operation(id, prep.operation.id)).operation;
    expect(op).toMatchObject({ state: 'credited', final: true, overdue: false, error: null, ledger: { type: 'deposit', usdc: '10.0' }, balanceBefore: { total: '0' }, balanceAfter: { total: '10' } });
    expect(await audits(id)).toEqual(['deposit_prepared', 'deposit_signed', 'deposit_confirmed_onchain', 'deposit_credited']);
    expect((await after.status(id)).operations).toHaveLength(1);
  });

  it('refuses before anything is signed: minimum, testnet, server setting, changed contract, unproven route, balance, limits, halt', async () => {
    const w = world(), id = await account(w), tid = await account(w, 'testnet');
    for (const amount of ['5.999999', '5', '1']) expect(await refusal(w.svc.prepareDeposit(id, { amount }))).toMatchObject({ code: 'below_minimum', status: 422, message: expect.stringMatching(/smallest deposit is 6 USDC.*credits nothing under 5 USDC/) });
    expect(await refusal(w.svc.prepareDeposit(tid, { amount: '10' }))).toMatchObject({ code: 'no_route', status: 422 });
    w.flags.mainnet = false;
    expect(await refusal(w.svc.prepareDeposit(id, { amount: '10' }))).toMatchObject({ code: 'mainnet_disabled', status: 403 });
    w.flags.mainnet = true;
    w.chain.guard = () => { throw new UserError('contract_changed', 'the bytecode of the venue bridge on Arbitrum One is not what was reviewed; deposits are refused until it is reviewed again', 503); };
    expect(await refusal(w.svc.prepareDeposit(id, { amount: '10' }))).toMatchObject({ code: 'contract_changed', status: 503 });
    w.chain.guard = () => { throw new UserError('bridge_paused', 'the venue bridge is locked', 503); };
    expect(await refusal(w.svc.prepareDeposit(id, { amount: '10' }))).toMatchObject({ code: 'bridge_paused' });
    w.chain.guard = null; w.chain.live = false;
    expect(await refusal(w.svc.prepareDeposit(id, { amount: '10' }))).toMatchObject({ code: 'route_not_proven', status: 503, message: expect.stringMatching(/none of the 3 most recent deposits/) });
    w.chain.live = true; w.chain.usdc = 8_000_000n; w.chain.elsewhere = [{ network: 'base', name: 'Base', usdc: '31.5' }];
    expect(await refusal(w.svc.prepareDeposit(id, { amount: '10' }))).toMatchObject({ code: 'insufficient_usdc', message: expect.stringMatching(/holds 8 USDC on Arbitrum One; it holds USDC on Base \(31\.5\): move it to Arbitrum One first with the cross-network transfer/) });
    w.chain.usdc = 400_000_000n;
    expect(await refusal(w.svc.prepareDeposit(id, { amount: '50.01' }))).toMatchObject({ code: 'policy', message: expect.stringMatching(/per-transaction limit/) });
    expect(w.chain.prepared).toBe(1);
    w.signer.halt();
    expect(await refusal(w.svc.prepareDeposit(id, { amount: '10' }))).toMatchObject({ code: 'halted', status: 423 });
    expect(w.seen.sign).toHaveLength(0);
    expect(await sql`select count(*)::int as n from deriv_collateral`).toEqual([{ n: 0 }]);
    expect(await sql`select count(*)::int as n from proposals`).toEqual([{ n: 0 }]);
  });

  it('a wrong passkey, an expired window, a tampered intent: nothing is sent and the operation says so', async () => {
    const w = world(), id = await account(w);
    const a = await w.svc.prepareDeposit(id, { amount: '10' });
    expect(await refusal(w.svc.approveDeposit(id, a.operation.id, w.pk.assert(intentHash({ ...a.intent, amount: '11000000' }))))).toMatchObject({ code: 'signer_bad_approval', status: 422 });
    expect((await w.svc.operation(id, a.operation.id)).operation).toMatchObject({ state: 'failed', final: true, txid: null, error: expect.stringMatching(/the signer refused.*Nothing was signed or sent/) });
    expect((await proposal(a.operation.id)).state).toBe('failed');
    // the API's database is tampered with between review and approval: the signer still decides on what it is handed
    const b = await w.svc.prepareDeposit(id, { amount: '10' });
    const evil = { ...b.intent, to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' };
    await sql`update proposals set intent = ${sql.json(evil)} where id = ${b.operation.proposalId}`;
    expect(await refusal(w.svc.approveDeposit(id, b.operation.id, w.pk.assert(intentHash(evil as Intent))))).toMatchObject({ code: 'signer_venue_deposit', message: expect.stringMatching(/not the pinned bridge/) });
    const lowered = { ...b.intent, proposalId: b.intent.proposalId, amount: '5000000' };
    const c = await w.svc.prepareDeposit(id, { amount: '10' });
    await sql`update proposals set intent = ${sql.json({ ...lowered, proposalId: c.intent.proposalId })} where id = ${c.operation.proposalId}`;
    expect(await refusal(w.svc.approveDeposit(id, c.operation.id, w.pk.assert(intentHash({ ...lowered, proposalId: c.intent.proposalId } as Intent))))).toMatchObject({ code: 'signer_venue_deposit', message: expect.stringMatching(/below 6 USDC is refused/) });
    // expired
    const d = await w.svc.prepareDeposit(id, { amount: '10' });
    w.next(181_000);
    expect(await refusal(w.svc.approveDeposit(id, d.operation.id, w.pk.assert(intentHash(d.intent))))).toMatchObject({ code: 'expired', status: 410 });
    expect((await w.svc.operation(id, d.operation.id)).operation).toMatchObject({ state: 'expired', final: true, error: expect.stringMatching(/nothing left the wallet/) });
    expect(w.store.state.journal.filter((j) => j.type === 'sign.ok')).toHaveLength(0);
    // an approved operation cannot be approved twice, a cancelled one not at all
    const e = await w.svc.prepareDeposit(id, { amount: '10' });
    const f = await w.svc.prepareDeposit(id, { amount: '12' }); // replaces the one under review
    expect((await w.svc.operation(id, e.operation.id)).operation).toMatchObject({ state: 'cancelled', final: true });
    expect(await refusal(w.svc.approveDeposit(id, e.operation.id, w.pk.assert(intentHash(e.intent))))).toMatchObject({ code: 'bad_state', status: 409 });
    await w.svc.approveDeposit(id, f.operation.id, w.pk.assert(intentHash(f.intent)));
    expect(await refusal(w.svc.approveDeposit(id, f.operation.id, w.pk.assert(intentHash(f.intent))))).toMatchObject({ code: 'bad_state' });
    expect(await refusal(w.svc.prepareDeposit(id, { amount: '10' }))).toMatchObject({ code: 'deposit_in_progress', status: 409 });
    expect(await refusal(w.svc.cancel(id, f.operation.id))).toMatchObject({ code: 'bad_state' });
  });

  it('a transfer that reverts or is replaced on-chain ends as failed: nothing reached the venue', async () => {
    const w = world(), id = await account(w);
    const { op } = await deposited(w, id);
    await chainSays(op.id, 'failed', 'transaction reverted on-chain'); w.next();
    expect((await w.svc.step()).errors).toEqual([]);
    expect((await w.svc.operation(id, op.id)).operation).toMatchObject({ state: 'failed', final: true, error: 'transaction reverted on-chain; the transfer did not happen on-chain: nothing reached the venue' });
    // and the next deposit is possible again
    await sql`update proposals set state = 'failed'`;
    expect((await w.svc.prepareDeposit(id, { amount: '10' })).operation.state).toBe('pending_approval');
  });

  it('a credit that never appears stays "awaiting", across restarts, and is never reported as done', async () => {
    const w = world(), id = await account(w);
    const { op } = await deposited(w, id);
    await chainSays(op.id, 'finalized');
    for (let k = 0; k < 4; k++) { w.next(3_600_000); const s = w.restart(); expect((await s.step()).errors).toEqual([]); }
    const now = (await w.svc.operation(id, op.id)).operation;
    expect(now).toMatchObject({ state: 'awaiting_credit', final: false, overdue: true, balanceAfter: null, doneAt: null });
    expect((await w.svc.status(id)).operations[0]).toMatchObject({ state: 'awaiting_credit', overdue: true });
    expect(await audits(id)).toEqual(['deposit_prepared', 'deposit_signed', 'deposit_confirmed_onchain']);
  });
});

describe('withdrawal', () => {
  const prepared = async (w: World, id: string, amount = '12.3') => w.svc.prepareWithdraw(id, { amount });
  const approve = (w: World, id: string, p: Awaited<ReturnType<typeof prepared>>) => w.svc.approveWithdraw(id, p.operation.id, w.pk.assert(venueWithdrawalHash(p.withdrawal)));

  it('prepare → passkey → withdraw3 to the wallet\'s own address → venue → ledger and arrival on the wallet → completed', async () => {
    const w = world(), id = await account(w, 'mainnet', '30');
    const p = await prepared(w, id);
    expect(p.withdrawal).toMatchObject({ venue: 'hyperliquid', network: 'mainnet', account: ACCOUNT, destination: ACCOUNT, amount: '12.3', fee: '1' });
    expect(p.options.challenge).toBe(Buffer.from(venueWithdrawalHash(p.withdrawal)).toString('base64url'));
    expect(p).toMatchObject({ receive: '11.3', operation: { kind: 'withdraw', state: 'pending_approval', amount: '12.3', fee: '1', expectedReceive: '11.3', balanceBefore: { withdrawable: '30' } },
      whatIsSigned: { action: { type: 'withdraw3', hyperliquidChain: 'Mainnet', signatureChainId: '0x66eee', destination: ACCOUNT, amount: '12.3', time: p.withdrawal.time } } });
    expect(w.m.exchanges).toHaveLength(0);

    const done = await approve(w, id, p);
    expect(done.operation).toMatchObject({ state: 'submitted', final: false, attempts: 1, error: null });
    expect(w.m.exchanges).toHaveLength(1);
    const sent = w.m.exchanges[0];
    expect(sent).toMatchObject({ action: { type: 'withdraw3', hyperliquidChain: 'Mainnet', signatureChainId: '0x66eee', destination: ACCOUNT, amount: '12.3', time: p.withdrawal.time }, nonce: p.withdrawal.time, vaultAddress: null, expiresAfter: null });
    expect(await recoverTypedDataSigner(buildWithdraw3TypedDataOnly({ network: 'mainnet', destination: ACCOUNT, amount: '12.3', time: p.withdrawal.time }).typedData, sent.signature)).toBe(ACCOUNT);
    expect(w.t.exchanges).toHaveLength(0);

    // accepted by the venue is not "arrived": four minutes of validators, then the wallet's own scan must see the USDC
    w.next();
    expect((await w.svc.operation(id, p.operation.id)).operation).toMatchObject({ state: 'submitted', final: false, overdue: false, arrival: null, ledger: null });
    w.next(co.WITHDRAW_OVERDUE_MS);
    expect((await w.svc.operation(id, p.operation.id)).operation).toMatchObject({ state: 'submitted', overdue: true, check: ['venue_ledger', 'bridge_paused', 'wallet_scan', 'venue_status'] });
    // a transfer from the bridge of another amount is not this withdrawal
    w.chain.arrivals.push({ txid: `0x${'11'.repeat(32)}`, amount: '5000000', seenAt: w.clock.now() }); w.next();
    expect((await w.svc.operation(id, p.operation.id)).operation.state).toBe('submitted');
    const arrived = w.m.payout(); w.chain.arrivals.push(arrived); w.next();
    const after = w.restart();
    expect((await after.step()).errors).toEqual([]);
    expect((await after.operation(id, p.operation.id)).operation).toMatchObject({ state: 'completed', final: true, error: null, txid: arrived.txid, arrival: { txid: arrived.txid, amount: '11300000' },
      ledger: { type: 'withdraw', usdc: '11.3', fee: '1.0', nonce: p.withdrawal.time * 1000 }, balanceBefore: { withdrawable: '30' }, balanceAfter: { withdrawable: '17.7' } });
    expect(await audits(id)).toEqual(['withdraw_prepared', 'withdraw_signed', 'withdraw_submitted', 'withdraw_in_venue_ledger', 'withdraw_arrived', 'withdraw_completed']);
    expect(w.m.exchanges).toHaveLength(1);
  });

  it('refuses before the passkey: fee, balance, server setting, halt; and the venue\'s own refusal is final and shown', async () => {
    const w = world(), id = await account(w, 'mainnet', '30');
    for (const amount of ['1', '0.5']) expect(await refusal(prepared(w, id, amount))).toMatchObject({ code: 'below_fee', status: 422 });
    expect(await refusal(prepared(w, id, '30.01'))).toMatchObject({ code: 'insufficient_collateral', message: expect.stringMatching(/reports 30 USDC withdrawable/) });
    w.flags.mainnet = false;
    expect(await refusal(prepared(w, id))).toMatchObject({ code: 'mainnet_disabled', status: 403 });
    w.flags.mainnet = true;
    const p = await prepared(w, id);
    w.flags.mainnet = false; // switched off between review and approval
    expect(await refusal(approve(w, id, p))).toMatchObject({ code: 'mainnet_disabled' });
    w.flags.mainnet = true;
    expect(w.seen.withdraw).toHaveLength(0);
    // the venue refuses (the balance went away meanwhile): final, with the venue's words, and nothing is retried
    w.m.fake.fund(ACCOUNT, '3');
    expect((await approve(w, id, p)).operation).toMatchObject({ state: 'rejected', final: true, error: 'the venue refused the withdrawal: Insufficient balance for withdrawal' });
    w.next(); await w.svc.step(); w.next(); await w.svc.step();
    expect(w.m.exchanges).toHaveLength(1);
    // an account the venue has never seen
    const w2 = world(), id2 = await account(w2, 'mainnet', null);
    expect(await refusal(prepared(w2, id2, '5'))).toMatchObject({ code: 'insufficient_collateral' });
    w2.signer.halt();
    expect(await refusal(prepared(w2, id2, '5'))).toMatchObject({ code: 'halted' });
  });

  it('a wrong passkey, a tampered destination, an expired window: nothing reaches the venue', async () => {
    const w = world(), id = await account(w, 'mainnet', '30');
    const a = await prepared(w, id);
    expect(await refusal(w.svc.approveWithdraw(id, a.operation.id, w.pk.assert(venueWithdrawalHash({ ...a.withdrawal, amount: '13' }))))).toMatchObject({ code: 'signer_bad_approval' });
    expect((await w.svc.operation(id, a.operation.id)).operation).toMatchObject({ state: 'failed', final: true, error: expect.stringMatching(/the signer refused.*Nothing was sent to the venue/) });
    // the stored withdrawal is rewritten to pay someone else, and the passkey is even asked over the rewritten object
    const b = await prepared(w, id);
    const evil: VenueWithdrawal = { ...b.withdrawal, destination: OTHER };
    await sql`update deriv_collateral set request = ${sql.json({ withdrawal: evil })} where id = ${b.operation.id}`;
    expect(await refusal(w.svc.approveWithdraw(id, b.operation.id, w.pk.assert(venueWithdrawalHash(evil))))).toMatchObject({ code: 'signer_wrong_destination', message: expect.stringMatching(/own address only/) });
    const c = await prepared(w, id);
    w.next(181_000);
    expect(await refusal(approve(w, id, c))).toMatchObject({ code: 'expired', status: 410 });
    expect((await w.svc.operation(id, c.operation.id)).operation).toMatchObject({ state: 'expired', final: true });
    expect(w.m.exchanges).toHaveLength(0);
    expect(w.store.state.journal.filter((j) => j.type === 'venue.withdraw.ok')).toHaveLength(0);
    expect(w.store.state.journal.filter((j) => j.type === 'venue.withdraw.denied').length).toBeGreaterThanOrEqual(2);
  });

  it('answer lost AFTER the venue accepted: unknown, the same bytes again, then the ledger and the wallet decide', async () => {
    const w = world(), id = await account(w, 'mainnet', '30');
    const p = await prepared(w, id);
    w.m.fault = 'lost_after';
    expect((await approve(w, id, p)).operation).toMatchObject({ state: 'unknown', final: false, attempts: 1, error: expect.stringMatching(/outcome is unknown/) });
    w.next(); await w.svc.step(); // re-sends the identical signed action: the venue says the nonce was used
    expect(w.m.exchanges).toHaveLength(2);
    expect(JSON.stringify(w.m.exchanges[1])).toBe(JSON.stringify(w.m.exchanges[0]));
    expect((await w.svc.operation(id, p.operation.id)).operation).toMatchObject({ state: 'unknown', final: false, attempts: 2, error: expect.stringMatching(/Invalid nonce: duplicate nonce.*first one may have been accepted/) });
    expect(w.m.pending).toHaveLength(1); // one withdrawal at the venue, not two
    const arrived = w.m.payout(); w.chain.arrivals.push(arrived); w.next();
    await w.restart().step();
    expect((await w.svc.operation(id, p.operation.id)).operation).toMatchObject({ state: 'completed', final: true, arrival: { amount: '11300000' }, ledger: { fee: '1.0' } });
  });

  it('request lost BEFORE the venue: unknown, then the repeated request is accepted; unreadable answers three times and no trace: given up, never assumed', async () => {
    const w = world(), id = await account(w, 'mainnet', '30');
    const p = await prepared(w, id);
    w.m.fault = 'lost_before';
    expect((await approve(w, id, p)).operation.state).toBe('unknown');
    expect(w.m.pending).toHaveLength(0);
    w.next(); await w.svc.step();
    expect((await w.svc.operation(id, p.operation.id)).operation).toMatchObject({ state: 'submitted', attempts: 2, error: null });
    expect(w.m.pending).toHaveLength(1);

    await sql`update deriv_collateral set final = true`; // the first part is out of the way (same account row: one wallet address)
    const w2 = world(), id2 = await account(w2, 'mainnet', '30');
    const q = await prepared(w2, id2);
    w2.m.fault = 'lost_before'; w2.m.faultAlways = true;
    expect((await approve(w2, id2, q)).operation.state).toBe('unknown');
    for (let k = 0; k < 6; k++) { w2.next(); await w2.restart().step(); }
    expect(w2.m.exchanges).toHaveLength(3); // bounded
    expect((await w2.svc.operation(id2, q.operation.id)).operation).toMatchObject({ state: 'unknown', final: false });
    w2.next(co.WITHDRAW_UNKNOWN_GIVE_UP_MS);
    await w2.svc.step();
    expect((await w2.svc.operation(id2, q.operation.id)).operation).toMatchObject({ state: 'rejected', final: true, error: expect.stringMatching(/30 minutes without any trace.*taken as not made/) });
    expect(w2.m.exchanges).toHaveLength(3);
  });

  it('a process that died between the signature and the request sends the stored bytes after the restart; one that died while asking the signer sends nothing', async () => {
    const w = world(), id = await account(w, 'mainnet', '30');
    const p = await prepared(w, id);
    const s = await w.port.venueWithdraw(p.withdrawal, w.pk.assert(venueWithdrawalHash(p.withdrawal)));
    await sql`update deriv_collateral set state = 'signed', action = ${s.action as never}::json, signature = ${sql.json(s.signature)} where id = ${p.operation.id}`;
    await w.restart().step();
    expect((await w.svc.operation(id, p.operation.id)).operation).toMatchObject({ state: 'submitted', attempts: 1 });
    expect(w.m.exchanges).toHaveLength(1);
    await sql`update deriv_collateral set final = true where id = ${p.operation.id}`; // out of the way
    const q = await prepared(w, id, '5');
    await sql`update deriv_collateral set state = 'approved', updated_at = ${new Date(w.clock.now())} where id = ${q.operation.id}`;
    w.next(); await w.restart().step();
    expect((await w.svc.operation(id, q.operation.id)).operation).toMatchObject({ state: 'failed', final: true, error: expect.stringMatching(/interrupted while asking the signer; nothing was sent/) });
    expect(w.m.exchanges).toHaveLength(1);
  });

  it('testnet: signed for the Testnet chain, sent to the testnet endpoint only, done when the venue\'s ledger shows it (no chain to watch)', async () => {
    const w = world(), id = await account(w, 'testnet', '100');
    w.flags.mainnet = false;
    const p = await prepared(w, id, '20');
    expect(p.whatIsSigned.action).toMatchObject({ hyperliquidChain: 'Testnet', destination: ACCOUNT });
    expect((await approve(w, id, p)).operation).toMatchObject({ state: 'submitted', arrivalTracked: false });
    expect([w.t.exchanges.length, w.m.exchanges.length]).toEqual([1, 0]);
    w.t.payout(); w.next(); await w.svc.step();
    expect((await w.svc.operation(id, p.operation.id)).operation).toMatchObject({ state: 'completed', final: true, arrival: null, txid: null, ledger: { usdc: '19', fee: '1.0' } });
  });
});

describe('routes', () => {
  it('are under …/accounts/:id/collateral/, validate their input, and map refusals to their status', async () => {
    const w = world(), id = await account(w, 'mainnet', '30');
    const app = fastify();
    app.setErrorHandler((err, _req, reply) => { const e = err as Error & { code?: string; status?: number }; return e instanceof UserError ? reply.status(e.status).send({ error: e.code, message: e.message }) : reply.status(e.name === 'ZodError' ? 400 : 500).send({ error: e.name }); });
    cr.collateralRoutes(app, w.svc);
    const P = `/api/v1/derivatives/live/accounts/${id}/collateral`;
    const post = (path: string, payload?: unknown) => app.inject({ method: 'POST', url: P + path, payload: payload as never });
    const st = await app.inject({ method: 'GET', url: `${P}/status` });
    expect(st.statusCode).toBe(200);
    expect(st.json()).toMatchObject({ account: ACCOUNT, route: { bridge: PIN.bridge }, deposit: { available: true } });
    for (const bad of [{ amount: '1e3' }, { amount: '-5' }, { amount: '5.1234567' }, { amount: '10', to: OTHER }, { amount: '10', destination: OTHER }, {}]) {
      expect((await post('/deposit/prepare', bad)).statusCode, JSON.stringify(bad)).toBe(400);
      expect((await post('/withdraw/prepare', bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await post('/deposit/prepare', { amount: '5' })).json()).toMatchObject({ error: 'below_minimum' });
    const d = await post('/deposit/prepare', { amount: '10' });
    expect(d.statusCode).toBe(200);
    const op = d.json().operation.id as string;
    expect((await post(`/deposit/${op}/approve`, {})).statusCode).toBe(400);
    expect((await post(`/withdraw/${op}/approve`, { assertion: {} })).statusCode).toBe(404); // a deposit is not a withdrawal
    expect((await app.inject({ method: 'GET', url: `${P}/operations/${op}` })).json().operation).toMatchObject({ id: op, state: 'pending_approval' });
    expect((await post(`/operations/${op}/cancel`)).json().operation).toMatchObject({ state: 'cancelled', final: true });
    expect((await app.inject({ method: 'GET', url: `/api/v1/derivatives/live/accounts/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/collateral/status` })).statusCode).toBe(404);
    const routes = app.printRoutes({ commonPrefix: false });
    for (const forbidden of ['send', 'transfer', 'usd', 'destination']) expect(routes.includes(forbidden), forbidden).toBe(false);
    await app.close();
  });
});
