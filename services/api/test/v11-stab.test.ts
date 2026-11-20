// V11 stabilisation — the pieces that need no signer and no chain: the proposal state machine (B2), the catalogue of server
// texts (B3), idempotency fingerprints (B4), the quote reference check (B6), the unified execution status, RPC endpoint
// health (resilience a), price freshness (c), the quote-log retention (e), activity / CSV kinds (B7).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { canTransition, isTerminal, STATES } from '@spw/core';
import { createTestDb } from './test-db.ts';
import { createGecko, priceStamp } from '../src/gecko.ts';
import { isSvCode, SV, svHold, svTechnical, svText } from '../src/sv-texts.ts';
import { legOutcome, planAdvance, planAttach, planCreate } from '../src/plan-state.ts';

let sql: any, pc: typeof import('../src/prepare-common.ts'), ex: typeof import('../src/exec-status.ts'), rpc: typeof import('../src/chains/rpc.ts'),
  swap: typeof import('../src/swap.ts'), srv: typeof import('../src/server.ts'), extra: typeof import('../src/rpc-extra.ts');
const realFetch = globalThis.fetch;

beforeAll(async () => {
  Object.assign(process.env, { SPW_ORIGIN: 'https://wallet.test', SPW_RP_ID: 'wallet.test', DATABASE_URL: (await createTestDb('v11stab')).url, SPW_SIGNER_SECRET: 'k'.repeat(48), SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
  const db = await import('../src/db.ts'); sql = db.sql;
  await sql.unsafe('drop schema public cascade; create schema public;'); await db.migrate();
  pc = await import('../src/prepare-common.ts'); ex = await import('../src/exec-status.ts'); rpc = await import('../src/chains/rpc.ts');
  swap = await import('../src/swap.ts'); srv = await import('../src/server.ts'); extra = await import('../src/rpc-extra.ts');
});
afterAll(async () => { globalThis.fetch = realFetch; await sql?.end(); });
afterEach(() => { globalThis.fetch = realFetch; rpc.resetRpcHealth(); });

describe('B2 — "signed, not broadcast" is its own terminal state', () => {
  it('is reachable only from `signed`, leads nowhere, and is not one of the in-flight states', () => {
    expect(STATES).toContain('not_broadcast');
    expect(canTransition('signed', 'not_broadcast')).toBe(true);
    for (const s of STATES) if (s !== 'signed') expect(canTransition(s, 'not_broadcast'), s).toBe(false);
    for (const s of STATES) expect(canTransition('not_broadcast', s), s).toBe(false);
    expect(isTerminal('not_broadcast')).toBe(true);
    expect(canTransition('signed', 'broadcast')).toBe(true); // the real path is untouched
  });
  it('the migration turns rows parked in `broadcast` by a non-broadcasting server into `not_broadcast`, and only those', async () => {
    // NEXT: one transaction in flight per network (db.ts `proposals_one_in_flight`) — the two rows are on two networks
    const ins = (id: string, error: string | null, network = 'base') => sql`insert into proposals (id, idempotency_key, state, network, asset, symbol, decimals, amount, from_addr, to_addr, error, broadcast_at)
      values (${id}, ${'k-' + id}, 'broadcast', ${network}, 'native', 'ETH', 18, 1, 'a', 'b', ${error}, now())`;
    const A = '00000000-0000-4000-8000-0000000000a1', B = '00000000-0000-4000-8000-0000000000b2';
    await ins(A, 'broadcast disabled (test mode)'); await ins(B, null, 'arbitrum');
    await (await import('../src/db.ts')).migrate();
    const rows = await sql`select id, state, error_code, broadcast_at from proposals where id in ${sql([A, B])} order by id`;
    expect(rows[0]).toMatchObject({ id: A, state: 'not_broadcast', error_code: 'broadcast_disabled', broadcast_at: null });
    expect(rows[1]).toMatchObject({ id: B, state: 'broadcast', error_code: null }); // really in flight: untouched
    await sql`delete from proposals where id in ${sql([A, B])}`;
  });
  it('a plan leg signed on a non-broadcasting server is a failed attempt with a code — it no longer stays in flight for ever', () => {
    const o = legOutcome({ state: 'not_broadcast', kind: 'swap', confirmations: 0, minConf: 1, error: SV.broadcast_disabled, error_code: 'broadcast_disabled', out_amount: null });
    expect(o).toMatchObject({ kind: 'failed', outcome: 'failed', why: { code: 'broadcast_disabled' } });
    const spec = { kind: 'swap' as const, via: 'kyberswap' as const, from: { network: 'base', asset: 'native' }, to: { network: 'base', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' } };
    const p0 = planCreate({ id: 'p', from: spec.from, to: spec.to, amountIn: 10n, slippageBps: 50, floor: null, legs: [{ spec, planned: { expectedIn: '10', worstIn: '10', expectedOut: '9', worstOut: '8', seconds: null } }], now: 1 });
    const p1 = planAttach(p0, 'prop-1', 10n, 2).plan, p2 = planAdvance(p1, o, 3).plan;
    expect(p2.state).toBe('paused');
    expect(p2.pause).toMatchObject({ code: 'leg_failed', reason: { code: 'broadcast_disabled' } });
    expect(p2.legs[0]).toMatchObject({ state: 'ready', proposalId: null }); expect(p2.legs[0]!.attempts[0]).toMatchObject({ outcome: 'failed', errorCode: 'broadcast_disabled' });
  });
});

describe('B3 — server sentences are codes + parameters', () => {
  it('every code renders its parameters; an unknown parameter is left visible, never invented', () => {
    expect(svText('swap_would_revert', { detail: 'execution reverted: K' })).toBe('the swap would revert now (execution reverted: K); it was not sent');
    expect(svText('plan_floor', { estimate: '9.5', sym: 'USDC', floor: '10' })).toContain('9.5 USDC, below the floor of 10');
    expect(svText('hold_destination_gas', { sym: 'ETH', net: 'Base' })).toContain('{need}');
    expect(isSvCode('broadcast_disabled')).toBe(true); expect(isSvCode('toString')).toBe(false); expect(isSvCode(3)).toBe(false);
  });
  it('a hold stores the hold code, the detail code, the parameters and the English sentence; a technical message stays data', () => {
    expect(svHold('destination_gas', 'hold_destination_gas', { sym: 'ETH', net: 'Base', need: '0.001', have: '0' })).toEqual({ hold: 'destination_gas', holdCode: 'hold_destination_gas',
      holdParams: { sym: 'ETH', net: 'Base', need: '0.001', have: '0' }, holdDetail: 'add ETH on Base: 0.001 is needed to receive the USDC, the wallet holds 0' });
    expect(svTechnical('rpc_degraded', 'rpc http 502')).toMatchObject({ hold: 'rpc_degraded', holdCode: 'hold_technical', holdParams: { detail: 'rpc http 502' }, holdDetail: 'rpc http 502' });
  });
  it('a leg outcome carries the proposal\'s own reason code; a row from before v11 (sentence, no code) gets no invented reason', () => {
    const f = { kind: 'swap', confirmations: 0, minConf: 1, out_amount: null };
    expect(legOutcome({ ...f, state: 'failed', error: 'x', error_code: 'swap_would_revert', error_params: { detail: 'K' } })).toMatchObject({ why: { code: 'swap_would_revert', params: { detail: 'K' } } });
    expect(legOutcome({ ...f, state: 'failed', error: 'an old sentence' }).kind === 'failed' && (legOutcome({ ...f, state: 'failed', error: 'an old sentence' }) as { why?: unknown }).why).toBeUndefined();
    expect(legOutcome({ ...f, state: 'rejected', error: null })).toMatchObject({ reason: 'rejected by owner', why: { code: 'rejected_by_owner' } });
    expect(legOutcome({ ...f, kind: 'xswap', state: 'finalized', error: null, xswap: { phase: 'refunded', refunded: '5' } })).toMatchObject({ outcome: 'refunded', returned: 5n, why: { code: 'plan_refunded' } });
  });
});

describe('B4 — idempotency fingerprints', () => {
  it('the same body in another key order is the same request; another body, or another kind, is not', () => {
    const a = pc.requestHash('swap', { network: 'base', amount: '1', slippageBps: 50 }), b = pc.requestHash('swap', { slippageBps: 50, amount: '1', network: 'base' });
    expect(a).toBe(b); expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(pc.requestHash('swap', { network: 'base', amount: '2', slippageBps: 50 })).not.toBe(a);
    expect(pc.requestHash('xswap', { network: 'base', amount: '1', slippageBps: 50 })).not.toBe(a);
    expect(pc.requestHash('swap', { network: 'base', amount: '1', slippageBps: 50, quote: undefined })).toBe(a); // an absent optional field changes nothing
  });
  it('the key must be well formed', () => {
    expect(() => pc.idemOf({}, 'swap', {})).toThrow(/Idempotency-Key/);
    expect(() => pc.idemOf({ 'idempotency-key': 'short' }, 'swap', {})).toThrow(/Idempotency-Key/);
    expect(pc.idemOf({ 'idempotency-key': 'abcdefgh-12345678' }, 'bridge', { a: 1 })).toMatchObject({ key: 'abcdefgh-12345678', kind: 'bridge' });
  });
  it('an existing row answers itself for the same request and refuses another body or another kind (409)', async () => {
    const id = '00000000-0000-4000-8000-0000000000c3', i = pc.idemOf({ 'idempotency-key': 'idem-existing-000001' }, 'swap', { amount: '1' });
    await sql`insert into proposals (id, idempotency_key, request_hash, kind, state, network, asset, symbol, decimals, amount, from_addr, to_addr) values (${id}, ${i.key}, ${i.hash}, 'swap', 'failed', 'base', 'native', 'ETH', 18, 1, 'a', 'a')`;
    expect((await pc.existingFor(i))!.id).toBe(id);
    expect((await pc.replayOf(i))!).toMatchObject({ replayed: true, options: null, proposal: { id, state: 'failed' } }); // no challenge for a proposal that can no longer be approved
    await expect(pc.existingFor(pc.idemOf({ 'idempotency-key': i.key }, 'swap', { amount: '2' }))).rejects.toMatchObject({ code: 'idempotency_mismatch', status: 409 });
    await expect(pc.existingFor(pc.idemOf({ 'idempotency-key': i.key }, 'bridge', { amount: '1' }))).rejects.toMatchObject({ code: 'idempotency_mismatch', status: 409 });
    expect(await pc.existingFor(pc.idemOf({ 'idempotency-key': 'idem-unknown-00000001' }, 'swap', {}))).toBeNull();
    await expect(pc.lostRace(pc.idemOf({ 'idempotency-key': 'idem-unknown-00000002' }, 'swap', {}))).rejects.toMatchObject({ code: 'conflict' });
    await sql`delete from proposals where id = ${id}`;
  });
});

describe('B6 — the quote the owner saw against the firm preparation', () => {
  const base = { fromKey: 'base:native', toKey: 'base:0xusdc', amountIn: 10n ** 18n, slippageBps: 50, toDecimals: 6, toSymbol: 'USDC' };
  const ref = (o: Partial<{ provider: string; amountOut: string; minAmountOut: string }> = {}) => { const q = { provider: 'kyberswap', amountOut: '2000000000', minAmountOut: '1990000000', ...o };
    return { id: 'r1', quotedAt: 1_800_000_000_000, ...q, fingerprint: pc.quoteFingerprint({ ...q, fromKey: base.fromKey, toKey: base.toKey, amountIn: base.amountIn.toString(), slippageBps: base.slippageBps }) }; };
  it('no reference: nothing is compared (API clients, plan legs)', () => {
    expect(pc.checkQuoteRef(undefined, { ...base, executor: 'kyberswap', firmOut: 1n, firmMinOut: 1n })).toBeNull();
  });
  it('within the tolerance: recorded with the signed deviation in basis points', () => {
    const r = pc.checkQuoteRef(ref(), { ...base, executor: 'kyberswap', firmOut: 1_996_000_000n, firmMinOut: 1_986_020_000n });
    expect(r).toMatchObject({ id: 'r1', provider: 'kyberswap', quotedOut: '2000000000', quotedMinOut: '1990000000', firmOut: '1996000000', deviationBps: -20 });
    expect(pc.checkQuoteRef(ref(), { ...base, executor: 'kyberswap', firmOut: 2_010_000_000n, firmMinOut: 2_000_000_000n })!.deviationBps).toBe(50); // better than shown is fine
    expect(pc.checkQuoteRef(ref(), { ...base, executor: 'kyberswap', firmOut: 1_990_000_000n, firmMinOut: 1n })!.deviationBps).toBe(-50); // exactly the displayed minimum: still honoured
  });
  it('beyond the tolerance: refused with 409 quote_moved and the fresh figures (and their own fingerprint) in the answer', () => {
    let err: any; try { pc.checkQuoteRef(ref(), { ...base, executor: 'kyberswap', firmOut: 1_989_999_999n, firmMinOut: 1_980_049_999n }); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: 'quote_moved', status: 409 });
    expect(err.message).toContain('1989.999999 USDC'); expect(err.message).toContain('1990 USDC');
    expect(err.data).toMatchObject({ deviationBps: -51, slippageBps: 50, quoted: { id: 'r1', amountOutDisplay: '2000', minAmountOutDisplay: '1990' },
      fresh: { provider: 'kyberswap', amountOut: '1989999999', amountOutDisplay: '1989.999999', minAmountOut: '1980049999', symbol: 'USDC' } });
    expect(err.data.fresh.fingerprint).toBe(pc.quoteFingerprint({ provider: 'kyberswap', fromKey: base.fromKey, toKey: base.toKey, amountIn: base.amountIn.toString(), slippageBps: 50, amountOut: '1989999999', minAmountOut: '1980049999' }));
  });
  it('a reference for another provider, another pair / amount / tolerance, or inconsistent amounts is refused before anything else', () => {
    expect(() => pc.checkQuoteRef(ref({ provider: 'lifi' }), { ...base, executor: 'kyberswap', firmOut: 2n, firmMinOut: 1n })).toThrow(expect.objectContaining({ code: 'quote_not_executable', status: 422 }));
    for (const other of [{ amountIn: 2n * 10n ** 18n }, { slippageBps: 100 }, { toKey: 'base:0xdai' }, { fromKey: 'ethereum:native' }])
      expect(() => pc.checkQuoteRef(ref(), { ...base, ...other, executor: 'kyberswap', firmOut: 2_000_000_000n, firmMinOut: 1_990_000_000n })).toThrow(expect.objectContaining({ code: 'quote_mismatch', status: 400 }));
    expect(() => pc.checkQuoteRef({ ...ref(), amountOut: '2000000001' }, { ...base, executor: 'kyberswap', firmOut: 2_000_000_000n, firmMinOut: 1n })).toThrow(expect.objectContaining({ code: 'quote_mismatch' })); // amounts edited after the fingerprint
    expect(() => pc.checkQuoteRef(ref({ amountOut: '5', minAmountOut: '6' }), { ...base, executor: 'kyberswap', firmOut: 9n, firmMinOut: 9n })).toThrow(expect.objectContaining({ code: 'quote_mismatch' }));
    expect(pc.QuoteRef.safeParse({ ...ref(), extra: 1 }).success).toBe(false); expect(pc.QuoteRef.safeParse({ ...ref(), fingerprint: 'zz' }).success).toBe(false);
  });
  it('the server states which executor a PAIR has, from the pinned tables', () => {
    const usdc = (n: string) => ({ network: n, asset: n === 'base' ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' : n === 'arbitrum' ? '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' });
    expect(swap.pairExecutors({ network: 'base', asset: 'native' }, usdc('base'))).toEqual(['kyberswap']);
    expect(swap.pairExecutors({ network: 'solana', asset: 'native' }, usdc('solana'))).toEqual(['jupiter']);
    expect(swap.pairExecutors(usdc('base'), usdc('arbitrum'))).toEqual(['cctp']);
    expect(swap.pairExecutors(usdc('solana'), usdc('base'))).toEqual(['cctp']);
    expect(swap.pairExecutors({ network: 'bitcoin', asset: 'native' }, { network: 'ethereum', asset: 'native' })).toEqual(['thorchain']);
    expect(swap.pairExecutors({ network: 'base', asset: 'native' }, { network: 'arbitrum', asset: 'native' })).toEqual([]);      // a plan may serve it; no single executor does
    expect(swap.pairExecutors({ network: 'tron', asset: 'native' }, { network: 'tron', asset: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' })).toEqual([]);
  });
});

describe('unified execution status', () => {
  const row = (o: Record<string, unknown>): any => ({ id: 'x', kind: 'transfer', state: 'draft', network: 'base', asset: 'native', symbol: 'ETH', decimals: 18, amount: '1', from_addr: '0xa', to_addr: '0xb', txid: null, pre_raw: null, pre_txid: null, pre_state: null,
    error: null, error_code: null, swap: null, bridge: null, xswap: null, broadcast_at: null, finalized_at: null, updated_at: new Date('2026-11-15T10:00:00Z'), ...o });
  const states = (r: any) => ex.executionOf(r).steps.map((s) => `${s.kind}:${s.state}`);
  it('a transfer is one step that follows the proposal; the explorer link exists only once the transaction left', () => {
    for (const [state, want] of [['draft', 'pending'], ['pending_approval', 'awaiting_approval'], ['approved', 'signing'], ['signed', 'signing'], ['broadcast', 'broadcast'], ['confirming', 'confirming'], ['reorged', 'confirming'],
      ['finalized', 'confirmed'], ['failed', 'failed'], ['rejected', 'failed'], ['expired', 'failed'], ['replaced', 'failed'], ['not_broadcast', 'failed']] as const)
      expect(ex.executionOf(row({ state })).state, state).toBe(want);
    expect(ex.executionOf(row({ state: 'signed', txid: '0xabc' })).steps[0]).toMatchObject({ kind: 'send', txid: '0xabc', explorer: null });
    const sent = ex.executionOf(row({ state: 'confirming', txid: '0xabc', broadcast_at: new Date('2026-11-15T09:00:00Z') })).steps[0]!;
    expect(sent.explorer).toMatch(/0xabc$/); expect(sent).toMatchObject({ startedAt: '2026-11-15T09:00:00.000Z', endedAt: null });
    expect(ex.executionOf(row({ state: 'not_broadcast', txid: '0xabc', error_code: 'broadcast_disabled' })).steps[0]).toMatchObject({ state: 'failed', code: 'broadcast_disabled', explorer: null });
    expect(ex.executionOf(row({ state: 'unheard_of' })).state).toBe('unknown');
    expect(ex.executionOf(row({ kind: 'gmx', state: 'broadcast' })).steps.map((s) => s.kind)).toEqual(['order']);
  });
  it('a swap with a token approval: the approval is mined first, the swap waits for it', () => {
    const sw = { provider: 'kyberswap', needsApproval: true };
    expect(states(row({ kind: 'swap', state: 'pending_approval', swap: sw }))).toEqual(['approval:awaiting_approval', 'swap:awaiting_approval']);
    expect(states(row({ kind: 'swap', state: 'signed', swap: sw, pre_raw: '0x1', pre_txid: '0xp' }))).toEqual(['approval:signing', 'swap:pending']);
    expect(states(row({ kind: 'swap', state: 'signed', swap: sw, pre_raw: '0x1', pre_txid: '0xp', pre_state: 'sent' }))).toEqual(['approval:broadcast', 'swap:pending']);
    expect(states(row({ kind: 'swap', state: 'broadcast', swap: sw, pre_raw: '0x1', pre_txid: '0xp', pre_state: 'confirmed' }))).toEqual(['approval:confirmed', 'swap:broadcast']);
    expect(states(row({ kind: 'swap', state: 'failed', error_code: 'swap_approval_reverted', swap: sw, pre_raw: '0x1', pre_txid: '0xp', pre_state: 'sent' }))).toEqual(['approval:failed', 'swap:failed']);
    // relayed, then the proposal ended for another reason: the approval's outcome was never recorded — unknown, not "failed"
    expect(states(row({ kind: 'swap', state: 'failed', error_code: 'swap_late', swap: sw, pre_raw: '0x1', pre_txid: '0xp', pre_state: 'sent' }))).toEqual(['approval:unknown', 'swap:failed']);
    expect(states(row({ kind: 'swap', state: 'rejected', swap: sw }))).toEqual(['swap:failed']);
    expect(ex.executionOf(row({ kind: 'swap', state: 'finalized', swap: { provider: 'jupiter' }, network: 'solana' }))).toMatchObject({ state: 'confirmed', steps: [{ kind: 'swap', provider: 'jupiter' }] });
  });
  it('a CCTP transfer: burn, Circle\'s attestation, mint on the destination — from the stored phase alone', () => {
    const b = (phase: string, o: Record<string, unknown> = {}) => row({ kind: 'bridge', state: 'finalized', network: 'base', txid: '0xburn', bridge: { toNetwork: 'arbitrum', phase, needsApproval: false, ...o } });
    expect(states(row({ kind: 'bridge', state: 'broadcast', txid: '0xburn', bridge: { toNetwork: 'arbitrum', phase: 'burn' } }))).toEqual(['burn:broadcast', 'attestation:pending', 'mint:pending']);
    expect(states(b('attesting', { attestingSince: 1_800_000_000_000 }))).toEqual(['burn:confirmed', 'attestation:confirming', 'mint:pending']);
    expect(ex.executionOf(b('attesting', { hold: 'attestation_late' })).steps[1]).toMatchObject({ network: 'circle', code: 'attestation_late' });
    expect(states(b('ready'))).toEqual(['burn:confirmed', 'attestation:confirmed', 'mint:pending']);
    const sent = ex.executionOf(b('mint_sent', { mint: { txid: '0xmint', sentAt: 1_800_000_100_000 } }));
    expect(sent.state).toBe('broadcast'); expect(sent.steps[2]).toMatchObject({ kind: 'mint', network: 'arbitrum', state: 'broadcast', txid: '0xmint', startedAt: new Date(1_800_000_100_000).toISOString() }); expect(sent.steps[2]!.explorer).toMatch(/0xmint$/);
    expect(ex.executionOf(b('mint_failed', { hold: 'mint_reverted', mint: { txid: '0xmint' } }))).toMatchObject({ state: 'failed', steps: [{}, {}, { state: 'failed', code: 'mint_reverted' }] });
    expect(ex.executionOf(b('done', { mintTxid: '0xother', doneAt: 1_800_000_200_000 }))).toMatchObject({ state: 'confirmed', steps: [{ state: 'confirmed' }, { state: 'confirmed' }, { state: 'confirmed', txid: '0xother', endedAt: new Date(1_800_000_200_000).toISOString() }] });
  });
  it('a THORChain swap: deposit, observation, outbound — a refund is `refunded`, never `confirmed`', () => {
    const x = (phase: string, o: Record<string, unknown> = {}) => row({ kind: 'xswap', state: 'finalized', network: 'bitcoin', txid: 'aa', xswap: { toNetwork: 'ethereum', toSymbol: 'ETH', toDecimals: 18, expectedOut: '1', minOut: '1', outboundFee: '0', liquidityFee: '0',
      vault: 'v', memo: 'm', operators: [], quoteOperators: [], evidence: { multiple: 1, transfersOut: null }, phase, ...o } });
    expect(states(x('sent'))).toEqual(['deposit:confirmed', 'observation:confirming', 'outbound:pending']);
    expect(states(x('observed', { observedAt: 5 }))).toEqual(['deposit:confirmed', 'observation:confirmed', 'outbound:pending']);
    const out = ex.executionOf(x('outbound', { outTxid: 'AB'.repeat(32), outKind: 'out' }));
    expect(out.steps[2]).toMatchObject({ state: 'confirming', network: 'ethereum', txid: 'AB'.repeat(32) }); expect(out.steps[2]!.explorer).toContain('0x' + 'ab'.repeat(32));
    expect(ex.executionOf(x('received', { outTxid: 'AB'.repeat(32), outKind: 'out', received: '5' })).state).toBe('confirmed');
    const back = ex.executionOf(x('refunded', { outTxid: 'CD'.repeat(32), outKind: 'refund', refunded: '5' }));
    expect(back.state).toBe('refunded'); expect(back.steps[2]).toMatchObject({ state: 'refunded', network: 'bitcoin' });
    expect(ex.executionOf(x('observed', { hold: 'outbound_late' })).steps[2]).toMatchObject({ code: 'outbound_late' });
  });
  it('a plan leg without a proposal is one step, not started — or done when the plan recorded it as settled', () => {
    expect(ex.pendingExecution('bridge', 'base')).toMatchObject({ kind: 'bridge', state: 'pending', steps: [{ kind: 'burn', network: 'base', state: 'pending', txid: null }] });
    expect(ex.pendingExecution('xswap', 'bitcoin', true)).toMatchObject({ state: 'confirmed', steps: [{ kind: 'deposit' }] });
  });
});

describe('resilience (a) — RPC endpoint health: ejection and re-admission; the quorum rule itself is not relaxed', () => {
  const A = 'https://a.rpc.test', B = 'https://b.rpc.test', C = 'https://c.rpc.test';
  /** scripted JSON-RPC: per host, a value, 'down' (connection refused) or 'rpcerr' (a JSON-RPC error answer) */
  const serve = (script: Record<string, unknown>) => { const calls: string[] = [];
    globalThis.fetch = (async (input: any) => { const host = new URL(String(input)).origin; calls.push(host); const v = script[host];
      if (v === 'down') throw new TypeError('fetch failed');
      return new Response(JSON.stringify(v === 'rpcerr' ? { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'nope' } } : { jsonrpc: '2.0', id: 1, result: v }), { status: 200 }); }) as typeof fetch;
    return calls; };
  let t = 1_000_000; const now = () => t;
  const q = (urls: string[]) => rpc.rpcQuorum<string>(urls, 'eth_chainId', [], undefined, now);

  it('two endpoints (every network by default): both must answer and agree — exactly as before; a dead one is never ejected', async () => {
    serve({ [A]: '0x1', [B]: '0x1' }); expect(await q([A, B])).toBe('0x1');
    serve({ [A]: '0x1', [B]: 'down' });
    for (let k = 0; k < 6; k++) await expect(q([A, B])).rejects.toMatchObject({ code: 'rpc_degraded', status: 503 });
    expect(rpc.rpcAdmitted([A, B], t)).toEqual({ core: [A, B], probation: [], ejected: [] }); // ejecting B would leave a single source: refused
    serve({ [A]: '0x1', [B]: '0x2' }); await expect(q([A, B])).rejects.toMatchObject({ code: 'rpc_disagreement' });
  }, 20_000);
  it('three endpoints: one degraded endpoint blocks at first, is ejected after three failures, and the two others must still both answer and agree', async () => {
    const calls = serve({ [A]: '0x1', [B]: '0x1', [C]: 'down' });
    for (let k = 0; k < rpc.RPC_EJECT_AFTER; k++) await expect(q([A, B, C])).rejects.toMatchObject({ code: 'rpc_degraded' }); // strict until the endpoint is known to be bad
    expect(rpc.rpcAdmitted([A, B, C], t)).toEqual({ core: [A, B], probation: [], ejected: [C] });
    calls.length = 0; expect(await q([A, B, C])).toBe('0x1'); expect(calls.sort()).toEqual([A, B]); // C is not even asked
    serve({ [A]: '0x1', [B]: '0x2', [C]: 'down' }); await expect(q([A, B, C])).rejects.toMatchObject({ code: 'rpc_disagreement' }); // fails closed on disagreement
    serve({ [A]: '0x1', [B]: 'down', [C]: 'down' }); await expect(q([A, B, C])).rejects.toMatchObject({ code: 'rpc_degraded' });     // never a single source
  }, 30_000);
  it('re-admission: after its pause the endpoint is asked again on probation — silent, it changes nothing and its pause doubles; answering, it is back in', async () => {
    serve({ [A]: '0x1', [B]: '0x1', [C]: 'down' });
    for (let k = 0; k < rpc.RPC_EJECT_AFTER; k++) await q([A, B, C]).catch(() => {});
    t += rpc.RPC_EJECT_MS + 1;
    expect(rpc.rpcAdmitted([A, B, C], t)).toEqual({ core: [A, B], probation: [C], ejected: [] });
    expect(await q([A, B, C])).toBe('0x1'); // probation failed: the call still succeeds on the two healthy endpoints
    const h = rpc.rpcEndpointHealth().find((e) => e.url === C)!; expect(h.ejections).toBe(2); expect(h.ejectedUntil).toBe(t + 2 * rpc.RPC_EJECT_MS);
    t += 2 * rpc.RPC_EJECT_MS + 1; serve({ [A]: '0x1', [B]: '0x1', [C]: '0x1' });
    expect(await q([A, B, C])).toBe('0x1'); expect(rpc.rpcAdmitted([A, B, C], t)).toEqual({ core: [A, B, C], probation: [], ejected: [] });
    // a re-admitted endpoint that DISAGREES makes the read fail closed rather than being outvoted
    serve({ [A]: '0x1', [B]: '0x1', [C]: 'down' }); for (let k = 0; k < rpc.RPC_EJECT_AFTER; k++) await q([A, B, C]).catch(() => {});
    t += rpc.RPC_EJECT_MAX_MS + 1; serve({ [A]: '0x1', [B]: '0x1', [C]: '0x9' });
    await expect(q([A, B, C])).rejects.toMatchObject({ code: 'rpc_disagreement' });
  }, 30_000);
  it('a JSON-RPC error is an answer: it fails the read (as before) but does not count against the endpoint', async () => {
    serve({ [A]: '0x1', [B]: '0x1', [C]: 'rpcerr' });
    for (let k = 0; k < 5; k++) await expect(q([A, B, C])).rejects.toMatchObject({ code: 'rpc_degraded' });
    expect(rpc.rpcAdmitted([A, B, C], t).ejected).toEqual([]);
  });
  it('SPW_RPC_EXTRA adds endpoints to a network; it refuses an unknown network, plain http to a remote host and malformed input', async () => {
    const { NETWORKS } = await import('@spw/core'); const before = [...NETWORKS.base!.rpc];
    try {
      expect(extra.applyRpcExtra(undefined)).toEqual({});
      expect(extra.applyRpcExtra(JSON.stringify({ base: ['https://my-node.example/base', before[0]] }))).toEqual({ base: ['https://my-node.example/base'] }); // an endpoint already pinned is not added twice
      expect(NETWORKS.base!.rpc).toEqual([...before, 'https://my-node.example/base']);
      expect(extra.applyRpcExtra(JSON.stringify({ base: ['http://127.0.0.1:8545'] }))).toEqual({ base: ['http://127.0.0.1:8545'] });
      expect(() => extra.applyRpcExtra('{"nowhere":["https://x.example"]}')).toThrow(/unknown network/);
      expect(() => extra.applyRpcExtra('{"base":["http://remote.example"]}')).toThrow(/only https/);
      expect(() => extra.applyRpcExtra('{"base":"https://x.example"}')).toThrow(/list of URLs/);
      expect(() => extra.applyRpcExtra('not json')).toThrow(/not valid JSON/);
    } finally { NETWORKS.base!.rpc = before; }
  });
});

describe('resilience (c) — price freshness', () => {
  it('the feed says when a value was really fetched, and that a stale-on-error value is stale', async () => {
    let t = 0; const script: (number | unknown)[] = [[{ id: 'bitcoin' }], 500, 500];
    const gecko = createGecko(async () => { const n = script.length > 1 ? script.shift() : script[0]; return typeof n === 'number' ? { ok: false, status: n, json: async () => ({}) } : { ok: true, status: 200, json: async () => n }; }, { now: () => t, pauseMs: 1 });
    expect(gecko.meta('k', 60_000)).toEqual({ fetchedAt: null, stale: true }); // never fetched
    t = 1000; await gecko('k', 60_000, '/p'); expect(gecko.meta('k', 60_000)).toEqual({ fetchedAt: 1000, stale: false });
    t = 62_000; expect(await gecko('k', 60_000, '/p')).toEqual([{ id: 'bitcoin' }]); // the refresh failed: the old value is served…
    expect(gecko.meta('k', 60_000)).toEqual({ fetchedAt: 1000, stale: true });       // …and keeps its real date
  });
  it('each price is dated by the source\'s own update time; old, undated or served-stale prices are flagged', () => {
    const now = Date.parse('2026-11-15T12:00:00Z'), iso = (m: number) => new Date(now - m * 60_000).toISOString();
    expect(priceStamp([iso(2), iso(3)], now - 30_000, false, now, 15 * 60_000)).toEqual({ priceAt: iso(3), stale: false });      // the older of the two currencies
    expect(priceStamp([iso(20), iso(1)], now, false, now, 15 * 60_000)).toEqual({ priceAt: iso(20), stale: true });             // a price the source stopped updating
    expect(priceStamp([iso(1), iso(1)], now - 10 * 60_000, true, now, 15 * 60_000)).toEqual({ priceAt: iso(1), stale: true });  // list served past its refresh window
    expect(priceStamp([undefined, undefined], now - 60_000, false, now, 15 * 60_000)).toEqual({ priceAt: iso(1), stale: false }); // no source date: the fetch time
    expect(priceStamp([undefined], null, false, now, 15 * 60_000)).toEqual({ priceAt: null, stale: true });
    expect(priceStamp([new Date(now + 3_600_000).toISOString()], now - 60_000, false, now, 15 * 60_000).priceAt).toBe(iso(1)); // a date in the future is not trusted
  });
});

describe('resilience (e) — retention of the quote log', () => {
  it('rows older than the retention are deleted, recent ones kept; the 7-day statistics window is never cut', async () => {
    await sql`delete from swap_quotes`;
    const ins = (days: number) => sql`insert into swap_quotes (at, search_id, provider, from_key, to_key, amount_in, ms, ok) values (now() - make_interval(days => ${days}), '00000000-0000-4000-8000-000000000001', 'p', 'a', 'b', 1, 5, true)`;
    for (const d of [0, 6, 29, 31, 90, 400]) await ins(d);
    expect(swap.SWAP_QUOTES_RETENTION_DAYS).toBeGreaterThanOrEqual(8);
    expect(await swap.pruneSwapQuotes(30)).toBe(3);
    expect((await sql`select count(*)::int as n from swap_quotes`)[0].n).toBe(3);
    expect(await swap.pruneSwapQuotes(30)).toBe(0);
  });
});

describe('B7 — what a proposal is in the activity feed and in the CSV', () => {
  it('a GMX order transaction is `gmx`, a native swap is listed with the swaps, the CSV writes the stored kind', () => {
    expect((['transfer', 'swap', 'xswap', 'bridge', 'gmx', undefined] as const).map((k) => srv.activityKind(k as never))).toEqual(['send', 'swap', 'swap', 'bridge', 'gmx', 'send']);
    expect((['transfer', 'swap', 'xswap', 'bridge', 'gmx', undefined] as const).map((k) => srv.csvKind(k as never))).toEqual(['send', 'swap', 'xswap', 'bridge', 'gmx', 'send']);
  });
  it('the CSV says what was delivered only when the chain said it', () => {
    const p = (o: Record<string, unknown>): any => ({ network: 'base', symbol: 'USDC', decimals: 6, out_amount: null, swap: null, bridge: null, xswap: null, ...o });
    expect(srv.csvOutcome(p({ kind: 'transfer' }))).toEqual({ toNetwork: '', toSymbol: '', received: '' });
    expect(srv.csvOutcome(p({ kind: 'swap', swap: { toSymbol: 'ETH', toDecimals: 18 } }))).toEqual({ toNetwork: 'base', toSymbol: 'ETH', received: '' });                       // not settled: no figure
    expect(srv.csvOutcome(p({ kind: 'swap', out_amount: '1500000000000000000', swap: { toSymbol: 'ETH', toDecimals: 18 } })).received).toBe('1.5');
    expect(srv.csvOutcome(p({ kind: 'bridge', out_amount: '9990000', bridge: { toNetwork: 'arbitrum', phase: 'mint_sent' } }))).toEqual({ toNetwork: 'arbitrum', toSymbol: 'USDC', received: '' });
    expect(srv.csvOutcome(p({ kind: 'bridge', out_amount: '9990000', bridge: { toNetwork: 'arbitrum', phase: 'done' } })).received).toBe('9.99');
    expect(srv.csvOutcome(p({ kind: 'xswap', xswap: { toNetwork: 'ethereum', toSymbol: 'ETH', toDecimals: 18, received: '21100000000000000' } }))).toEqual({ toNetwork: 'ethereum', toSymbol: 'ETH', received: '0.0211' });
  });
});
