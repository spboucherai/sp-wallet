/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/core/test/swap-sol.test.ts
 * Module           : core
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// Jupiter swaps on Solana: what the signer enforces without trusting the provider or the API. Fixtures are real /build answers
// (v1 transactions) recorded with scripts/sim-jupiter.mts --record, with the message the API assembled, the intent, and the
// mainnet simulation of the signed bytes. No network here.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getCompiledTransactionMessageDecoder } from '@solana/kit';
import {
  arrangeJupiterInstructions, associatedTokenAddress, ATA_PROGRAM, buildSolSwapMessage, canonicalBytes, compileSolV1Message, decodeJupiterRoute, decodeSolV1Message, IntentSchema, intentHash, JUPITER_EVENT_AUTHORITY, JUPITER_PROGRAM,
  jupiterMinOut, jupiterProgramAuthority, jupiterRouteToShared, NETWORKS, RENT_TOKEN2022_ACCOUNT_MAX, RENT_TOKEN_ACCOUNT, solAddress, solMessageHash, solV1Wire, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, tokenProgramOf,
  verifyJupiterSwap, verifyKyberSwap, WSOL_MINT, type Intent, type SolIxInput, type SolV1Message,
} from '../src/index.ts';

interface Fx { wallet: string; from: string; to: string; converted: boolean; intent: Intent; message: string; build: any; simulation: any; effects: { spent: string; received: string; rentKept: string } }
const dir = new URL('./fixtures/jupiter-exec/', import.meta.url);
const FX: Record<string, Fx> = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => [f.replace('.json', ''), JSON.parse(readFileSync(new URL(f, dir), 'utf8'))]));
const names = Object.keys(FX);
const bytes = (f: Fx) => new Uint8Array(Buffer.from(f.message, 'base64'));
const N = NETWORKS.solana!, tok = (sym: string) => (sym === 'SOL' ? N.native : N.tokens.find((t) => t.symbol === sym)!);
const mintOf = (sym: string) => (sym === 'SOL' ? WSOL_MINT : tok(sym).id), tpOf = (sym: string) => (sym === 'SOL' ? TOKEN_PROGRAM : tokenProgramOf(tok(sym)));
const toIx = (x: any): SolIxInput => ({ program: x.programId, accounts: x.accounts.map((a: any) => ({ pubkey: a.pubkey, signer: a.isSigner, writable: a.isWritable })), data: new Uint8Array(Buffer.from(x.data, 'base64')) });
const inputs = (m: SolV1Message): SolIxInput[] => m.instructions.map((x) => ({ program: x.program, data: Uint8Array.from(x.data), accounts: x.accounts.map((k) => ({ pubkey: k, signer: k === m.payer, writable: m.keys.indexOf(k) < m.keys.length - m.numReadonlyUnsigned })) }));
const recompile = (m: SolV1Message, ixs: SolIxInput[], o: Partial<{ limit: number; fee: bigint; payer: string; blockhash: string }> = {}) => compileSolV1Message({ payer: o.payer ?? m.payer, blockhash: o.blockhash ?? m.blockhash, instructions: ixs, computeUnitLimit: o.limit ?? m.computeUnitLimit, priorityFeeLamports: o.fee ?? m.priorityFeeLamports, loadedAccountsDataSizeLimit: m.loadedAccountsDataSizeLimit });
const acct = (pubkey: string, writable = false, signer = false) => ({ pubkey, writable, signer });
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const setData = (ix: SolIxInput, f: (d: Buffer) => void) => { const d = Buffer.from(ix.data); f(d); ix.data = new Uint8Array(d); };
const THIRD = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'; // a public address that is none of the recorded wallets
/** the attacker controls the API and the database: the hash in the intent follows whatever bytes he made */
const rehash = (i: Intent, msg: Uint8Array, o: Partial<Intent> = {}, swap: Partial<NonNullable<Intent['swap']>> = {}, sol: Partial<NonNullable<Intent['sol']>> = {}): Intent => ({ ...i, ...o, swap: { ...i.swap!, dataHash: solMessageHash(msg), ...swap }, sol: { ...i.sol!, ...sol } });
type Mut = (x: SolIxInput[], k: number, m: SolV1Message, f: Fx) => Uint8Array | { msg: Uint8Array; intent: Intent };
function mutated(f: Fx, make: Mut): { intent: Intent; msg: Uint8Array } {
  const m = decodeSolV1Message(bytes(f)), x = inputs(m), k = x.findIndex((q) => q.program === JUPITER_PROGRAM);
  const r = make(x, k, m, f);
  return r instanceof Uint8Array ? { intent: rehash(f.intent, r), msg: r } : r;
}
const refuses = (f: Fx, make: Mut, why: RegExp) => { const { intent, msg } = mutated(f, make); expect(() => verifyJupiterSwap(intent, msg)).toThrow(why); };

it('fixtures: at least eight recorded pairs, both ways of SOL, a token account creation, Token-2022, genuine and rewritten instructions', () => {
  expect(names.length).toBeGreaterThanOrEqual(8);
  const all = Object.values(FX);
  expect(all.some((f) => f.from === 'SOL') && all.some((f) => f.to === 'SOL')).toBe(true);
  expect(all.some((f) => f.converted) && all.some((f) => !f.converted)).toBe(true);
  expect(all.some((f) => tok(f.to).program === 'token2022') && all.some((f) => tok(f.from).program === 'token2022')).toBe(true);
  expect(all.some((f) => BigInt(f.effects.rentKept) > 0n)).toBe(true);
});

describe('v1 message codec (cross-checked against @solana/kit)', () => {
  it.each(names)('%s: decodes like @solana/kit, re-encodes to the same bytes, has no lookup table', (name) => {
    const msg = bytes(FX[name]!), m = decodeSolV1Message(msg);
    const kit = getCompiledTransactionMessageDecoder().decode(msg) as any;
    expect(kit.version).toBe(1);
    expect('addressTableLookups' in kit).toBe(false);
    expect(kit.staticAccounts).toEqual(m.keys);
    expect([kit.header.numSignerAccounts, kit.header.numReadonlySignerAccounts, kit.header.numReadonlyNonSignerAccounts]).toEqual([m.numSigners, m.numReadonlySigned, m.numReadonlyUnsigned]);
    expect(kit.lifetimeToken).toBe(m.blockhash);
    expect(kit.configMask).toBe(15);
    expect(kit.configValues.map((v: any) => BigInt(v.value))).toEqual([m.priorityFeeLamports, BigInt(m.computeUnitLimit), BigInt(m.loadedAccountsDataSizeLimit)]);
    expect(kit.instructionHeaders.map((h: any) => m.keys[h.programAccountIndex])).toEqual(m.instructions.map((x) => x.program));
    kit.instructionPayloads.forEach((p: any, k: number) => { expect(p.instructionAccountIndices.map((q: number) => m.keys[q])).toEqual(m.instructions[k]!.accounts); expect(Buffer.from(p.instructionData).equals(Buffer.from(m.instructions[k]!.data))).toBe(true); });
    expect(Buffer.from(recompile(m, inputs(m))).equals(Buffer.from(msg))).toBe(true);
    expect(msg.length + 64).toBeLessThanOrEqual(4096);
    const wire = solV1Wire(new Uint8Array(64).fill(7), msg);
    expect(wire.length).toBe(msg.length + 64); expect(Buffer.from(wire.subarray(0, msg.length)).equals(Buffer.from(msg))).toBe(true); expect(wire[wire.length - 1]).toBe(7);
  });
  it('refuses anything that is not a strict v1 message', () => {
    const msg = bytes(FX[names[0]!]!);
    const v0 = Uint8Array.from(msg); v0[0] = 0x80;
    expect(() => decodeSolV1Message(v0)).toThrow(/lookup-table transactions are refused/);
    expect(() => decodeSolV1Message(msg.slice(1))).toThrow(/not a v1/);
    expect(() => decodeSolV1Message(new Uint8Array(Buffer.concat([msg, Buffer.from([0])])))).toThrow(/trailing/);
    expect(() => decodeSolV1Message(msg.slice(0, msg.length - 1))).toThrow(/truncated/);
    const mask = Uint8Array.from(msg); mask[4] = 0x1f; expect(() => decodeSolV1Message(mask)).toThrow(/config mask/); // a heap request would shift every field after it
    const dup = Uint8Array.from(msg); dup.set(dup.subarray(42, 74), 74); expect(() => decodeSolV1Message(dup)).toThrow(/duplicate/);
    const idx = Uint8Array.from(msg), m = decodeSolV1Message(msg); idx[42 + m.keys.length * 32 + 16] = 0; expect(() => decodeSolV1Message(idx)).toThrow(/program index/);
    expect(() => solV1Wire(new Uint8Array(63), msg)).toThrow();
    expect(() => compileSolV1Message({ payer: m.payer, blockhash: m.blockhash, instructions: [{ program: SYSTEM_PROGRAM, accounts: [acct(THIRD, true, true)], data: new Uint8Array(1) }], computeUnitLimit: 1, priorityFeeLamports: 0n, loadedAccountsDataSizeLimit: 1 })).toThrow(/another signer/);
  });
});

describe('Jupiter instruction decoding and the minimum-output formula', () => {
  it.each(names)('%s: decodes the instruction Jupiter built and the one that is signed', (name) => {
    const f = FX[name]!, raw = toIx(f.build.swapInstruction), r = decodeJupiterRoute(raw.data, raw.accounts.length);
    expect(r.kind).toBe(f.converted ? 'route_v2' : 'shared_accounts_route_v2');
    expect(r.inAmount).toBe(BigInt(f.build.inAmount)); expect(r.quotedOut).toBe(BigInt(f.build.outAmount)); expect(r.slippageBps).toBe(f.build.slippageBps);
    expect(r.legs).toBe(f.build.routePlan.length);
    const facts = verifyJupiterSwap(f.intent, bytes(f));
    expect(facts.kind).toBe('shared_accounts_route_v2');
    expect([facts.inAmount, facts.quotedOut, facts.slippageBps, facts.legs]).toEqual([r.inAmount, r.quotedOut, r.slippageBps, r.legs]);
    expect(facts.minOut.toString()).toBe(f.intent.swap!.minOut);
    // the simulated output recorded on mainnet respects the verified minimum, and the input is spent exactly
    expect(BigInt(f.effects.received)).toBeGreaterThanOrEqual(facts.minOut); expect(f.effects.spent).toBe(f.intent.amount);
  });
  it('minimum output = floor(quoted × (10000 − bps) / 10000), a lower bound of what the program enforces (it rounds up)', () => {
    expect(jupiterMinOut(302062281n, 50)).toBe(300551969n); // Jupiter's own otherAmountThreshold for this quote was 300551970
    expect(jupiterMinOut(1_000_000n, 0)).toBe(1_000_000n); expect(jupiterMinOut(1_000_000n, 10_000)).toBe(0n); expect(jupiterMinOut(9_999n, 1)).toBe(9_998n); expect(jupiterMinOut((1n << 64n) - 1n, 1)).toBe(18444899399302180659n);
    for (let q = 1n; q < 3000n; q += 7n) for (const bps of [1, 30, 50, 100, 300]) { const exact = Number(q) * (10_000 - bps) / 10_000, m = jupiterMinOut(q, bps); expect(Number(m)).toBeLessThanOrEqual(exact); expect(Number(m) + 1).toBeGreaterThan(exact); }
  });
  it('refuses every other instruction of the program, fees and odd values', () => {
    const f = Object.values(FX).find((x) => !x.converted)!, ix = toIx(f.build.swapInstruction);
    const withData = (g: (d: Buffer) => void) => { const d = Buffer.from(ix.data); g(d); return new Uint8Array(d); };
    for (const disc of ['e517cb977ae3ad2a' /* route */, 'c1209b3341d69c81' /* shared_accounts_route */, 'd033ef977b2bed5c' /* exact_out_route */, '9d8ab85215f4f324' /* exact_out_route_v2 */, '3560e5cad8bbfa18' /* shared_accounts_exact_out_route_v2 */, 'a0752c34dc4d5140' /* route_with_attestation */, '252ef97ec9a238ca', '3ec6d6c1d59f6cd2' /* claim */])
      expect(() => decodeJupiterRoute(withData((d) => Buffer.from(disc, 'hex').copy(d)), 20)).toThrow(/not allowed/);
    expect(() => decodeJupiterRoute(withData((d) => d.writeUInt16LE(1, 27)), 20)).toThrow(/platform fee/);
    expect(() => decodeJupiterRoute(withData((d) => d.writeUInt16LE(1, 29)), 20)).toThrow(/positive-slippage/);
    expect(() => decodeJupiterRoute(withData((d) => d.writeUInt16LE(10_001, 25)), 20)).toThrow(/slippage/);
    expect(() => decodeJupiterRoute(withData((d) => d.writeUInt32LE(0, 31)), 20)).toThrow(/route plan/);
    expect(() => decodeJupiterRoute(ix.data.slice(0, 30), 20)).toThrow(/too short/);
  });
});

describe('derivations', () => {
  it.each(names)('%s: the wallet\'s token accounts, the program authority and its shared accounts are the derived ones', (name) => {
    const f = FX[name]!, facts = verifyJupiterSwap(f.intent, bytes(f)), jup = facts.message.instructions.find((x) => x.program === JUPITER_PROGRAM)!;
    expect(facts.sourceAccount).toBe(associatedTokenAddress(f.wallet, mintOf(f.from), tpOf(f.from)));
    expect(facts.destinationAccount).toBe(associatedTokenAddress(f.wallet, mintOf(f.to), tpOf(f.to)));
    const raw = toIx(f.build.swapInstruction), pos = f.converted ? [1, 2] : [2, 5]; // Jupiter's own answer names the same accounts
    expect([raw.accounts[pos[0]!]!.pubkey, raw.accounts[pos[1]!]!.pubkey]).toEqual([facts.sourceAccount, facts.destinationAccount]);
    const id = jup.data[8]!, auth = jupiterProgramAuthority(id);
    expect(jup.accounts.slice(0, 12)).toEqual([auth, f.wallet, facts.sourceAccount, associatedTokenAddress(auth, facts.inMint, tpOf(f.from)), associatedTokenAddress(auth, facts.outMint, tpOf(f.to)), facts.destinationAccount,
      facts.inMint, facts.outMint, tpOf(f.from), tpOf(f.to), JUPITER_EVENT_AUTHORITY, JUPITER_PROGRAM]);
    if (!f.converted) expect(raw.accounts[0]!.pubkey).toBe(auth); // Jupiter's own shared-accounts instruction uses the PDA we derive
  });
  it('Token-2022 mints use the Token-2022 program for the account derivation', () => {
    const p = tok('PYUSD'); expect(p.program).toBe('token2022');
    expect(associatedTokenAddress(FX['usdc-pyusd']!.wallet, p.id, TOKEN_2022_PROGRAM)).not.toBe(associatedTokenAddress(FX['usdc-pyusd']!.wallet, p.id, TOKEN_PROGRAM));
    expect(solAddress(new Uint8Array(32))).toBe(SYSTEM_PROGRAM);
  });
});

describe('arrangement of Jupiter\'s answer (API side)', () => {
  it.each(names)('%s: rebuilding from the recorded /build answer gives the recorded message, byte for byte', (name) => {
    const f = FX[name]!, m = decodeSolV1Message(bytes(f)), id = m.instructions.find((x) => x.program === JUPITER_PROGRAM)!.data[8]!;
    const a = arrangeJupiterInstructions({ setup: f.build.setupInstructions.map(toIx), swap: toIx(f.build.swapInstruction), cleanup: f.build.cleanupInstruction ? toIx(f.build.cleanupInstruction) : null, authorityId: id });
    expect(a.converted).toBe(f.converted);
    expect(Buffer.from(recompile(m, a.instructions)).equals(Buffer.from(bytes(f)))).toBe(true);
    // what Jupiter built, taken as is (its own order, its own instruction type), is refused unless it already is the signed form
    const asIs = [...f.build.setupInstructions.map(toIx), toIx(f.build.swapInstruction), ...(f.build.cleanupInstruction ? [toIx(f.build.cleanupInstruction)] : [])];
    const msg = recompile(m, asIs);
    if (f.converted) expect(() => verifyJupiterSwap(rehash(f.intent, msg), msg)).toThrow(/only the shared-accounts form is signed|unexpected|missing|token-account/);
  });
  it('the rewrite keeps the route plan and swaps the wallet for the program authority in every leg', () => {
    const f = Object.values(FX).find((x) => x.converted)!, raw = toIx(f.build.swapInstruction), out = jupiterRouteToShared(raw, 3);
    expect(Buffer.from(out.data.subarray(9)).equals(Buffer.from(raw.data.subarray(8)))).toBe(true); expect(out.data[8]).toBe(3);
    expect(out.accounts.length).toBe(raw.accounts.length + 2);
    expect(out.accounts.slice(12).some((a) => a.pubkey === f.wallet || a.pubkey === raw.accounts[1]!.pubkey || a.pubkey === raw.accounts[2]!.pubkey)).toBe(false);
    expect(out.accounts.filter((a) => a.signer).map((a) => a.pubkey)).toEqual([f.wallet]);
    expect(() => jupiterRouteToShared(out, 0)).toThrow(/not a route_v2/);
    const alt = structuredClone(raw); alt.accounts[7]!.pubkey = THIRD; expect(() => jupiterRouteToShared(alt, 0)).toThrow(/alternate destination/);
  });
});

describe('what the signer refuses (genuine transactions, mutated)', () => {
  const tt = FX['usdc-bonk'] ?? Object.values(FX).find((f) => f.from !== 'SOL' && f.to !== 'SOL')!; // token -> token, destination account already exists
  const si = Object.values(FX).find((f) => f.from === 'SOL')!, so = Object.values(FX).find((f) => f.to === 'SOL')!;
  const other = tok(['JUP', 'USDT', 'BONK'].find((s) => s !== tt.from && s !== tt.to)!);
  const src = associatedTokenAddress(tt.wallet, mintOf(tt.from), tpOf(tt.from));
  it('the genuine transactions pass, and the builder returns the exact bytes to sign', () => {
    for (const f of Object.values(FX)) expect(Buffer.from(buildSolSwapMessage(f.intent, f.message)).equals(Buffer.from(bytes(f)))).toBe(true);
    expect(() => buildSolSwapMessage(tt.intent, '')).toThrow(/base64/); expect(() => buildSolSwapMessage(tt.intent, 'A'.repeat(6000))).toThrow(/base64/);
  });
  const cases: [string, () => Fx, Mut, RegExp][] = [
    ['another destination token account', () => tt, (x, k, m, f) => { x[k]!.accounts[5]!.pubkey = associatedTokenAddress(THIRD, mintOf(f.to), tpOf(f.to)); return recompile(m, x); }, /destination token account is not the wallet's own/],
    ['another source token account', () => tt, (x, k, m, f) => { x[k]!.accounts[2]!.pubkey = associatedTokenAddress(f.wallet, other.id, TOKEN_PROGRAM); return recompile(m, x); }, /source token account is not the wallet's own/],
    ['another transfer authority', () => tt, (x, k, m) => { x[k]!.accounts[1] = acct(THIRD); return recompile(m, x); }, /transfer authority is not the wallet/],
    ['another mint declared', () => tt, (x, k, m) => { x[k]!.accounts[7]!.pubkey = other.id; return recompile(m, x); }, /fixed accounts/],
    ['another token program declared', () => tt, (x, k, m) => { x[k]!.accounts[9]!.pubkey = TOKEN_2022_PROGRAM; return recompile(m, x); }, /fixed accounts/],
    ['another program authority than the derived one', () => tt, (x, k, m) => { x[k]!.accounts[0]!.pubkey = THIRD; return recompile(m, x); }, /fixed accounts/],
    ['authority id changed without its accounts', () => tt, (x, k, m) => { setData(x[k]!, (d) => { d[8] = (d[8]! + 1) % 8; }); return recompile(m, x); }, /fixed accounts/],
    ['a platform fee', () => tt, (x, k, m) => { setData(x[k]!, (d) => d.writeUInt16LE(50, 27)); return recompile(m, x); }, /platform fee/],
    ['a positive-slippage fee', () => tt, (x, k, m) => { setData(x[k]!, (d) => d.writeUInt16LE(50, 29)); return recompile(m, x); }, /positive-slippage fee/],
    ['a lower minimum (quoted amount)', () => tt, (x, k, m) => { setData(x[k]!, (d) => d.writeBigUInt64LE(d.readBigUInt64LE(17) - 1n, 17)); return recompile(m, x); }, /less than the approved minimum/],
    ['a lower minimum (slippage)', () => tt, (x, k, m) => { setData(x[k]!, (d) => d.writeUInt16LE(d.readUInt16LE(25) + 1, 25)); return recompile(m, x); }, /less than the approved minimum/],
    ['another input amount', () => tt, (x, k, m) => { setData(x[k]!, (d) => d.writeBigUInt64LE(d.readBigUInt64LE(9) + 1n, 9)); return recompile(m, x); }, /spends another amount/],
    ['an extra System transfer', () => tt, (x, _k, m, f) => recompile(m, [...x, { program: SYSTEM_PROGRAM, accounts: [acct(f.wallet, true, true), acct(THIRD, true)], data: new Uint8Array(Buffer.concat([Buffer.from([2, 0, 0, 0]), u64(1n)])) }]), /unexpected program 1111/],
    ['an extra Token approve', () => tt, (x, _k, m, f) => recompile(m, [{ program: TOKEN_PROGRAM, accounts: [acct(src, true), acct(THIRD), acct(f.wallet, false, true)], data: new Uint8Array(Buffer.concat([Buffer.from([4]), u64(1n)])) }, ...x]), /unexpected program Token/],
    ['an extra Token setAuthority after the swap', () => tt, (x, _k, m, f) => recompile(m, [...x, { program: TOKEN_PROGRAM, accounts: [acct(src, true), acct(f.wallet, false, true)], data: new Uint8Array([6, 2, 0]) }]), /unexpected program Token/],
    ['an extra Token closeAccount', () => tt, (x, _k, m, f) => recompile(m, [...x, { program: TOKEN_PROGRAM, accounts: [acct(src, true), acct(THIRD, true), acct(f.wallet, false, true)], data: new Uint8Array([9]) }]), /unexpected program Token/],
    ['an unknown program', () => tt, (x, _k, m) => recompile(m, [...x, { program: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', accounts: [], data: new Uint8Array(2) }]), /unexpected program Memo/],
    ['a ComputeBudget instruction', () => tt, (x, _k, m) => recompile(m, [{ program: 'ComputeBudget111111111111111111111111111111', accounts: [], data: new Uint8Array(9) }, ...x]), /unexpected program ComputeBudget/],
    ['two Jupiter instructions', () => tt, (x, k, m) => recompile(m, [...x.slice(0, k + 1), x[k]!, ...x.slice(k + 1)]), /more than one Jupiter instruction/],
    ['no Jupiter instruction', () => tt, (x, k, m) => recompile(m, x.filter((_q, n) => n !== k).concat([{ program: ATA_PROGRAM, accounts: x[0]!.accounts, data: Uint8Array.of(1) }]).slice(0, 1)), /no Jupiter instruction/],
    ['token-account creation for a third party', () => tt, (x, _k, m, f) => recompile(m, [{ program: ATA_PROGRAM, accounts: [acct(f.wallet, true, true), acct(associatedTokenAddress(THIRD, other.id, TOKEN_PROGRAM), true), acct(THIRD), acct(other.id), acct(SYSTEM_PROGRAM), acct(TOKEN_PROGRAM)], data: Uint8Array.of(1) }, ...x]), /not for the wallet's own account/],
    ['token-account creation for an unrelated mint of the wallet', () => tt, (x, _k, m, f) => recompile(m, [{ program: ATA_PROGRAM, accounts: [acct(f.wallet, true, true), acct(associatedTokenAddress(f.wallet, other.id, TOKEN_PROGRAM), true), acct(f.wallet), acct(other.id), acct(SYSTEM_PROGRAM), acct(TOKEN_PROGRAM)], data: Uint8Array.of(1) }, ...x]), /not for the wallet's own account/],
    ['a non-idempotent / unknown ATA instruction', () => tt, (x, _k, m) => { x[0]!.data = Uint8Array.of(2); return recompile(m, x); }, /not CreateIdempotent/],
    ['the same token account created twice', () => tt, (x, _k, m) => recompile(m, [x[0]!, ...x]), /duplicate token-account creation/],
    ['the wallet among the route accounts', () => tt, (x, k, m, f) => { x[k]!.accounts.push(acct(f.wallet)); return recompile(m, x); }, /reaches into the wallet's accounts/],
    ['a leg pointed at the wallet\'s source account', () => tt, (x, k, m) => { x[k]!.accounts[13] = acct(src, true); return recompile(m, x); }, /reaches into the wallet's accounts/],
    ['another registry token account of the wallet among the route accounts', () => tt, (x, k, m, f) => { x[k]!.accounts.push(acct(associatedTokenAddress(f.wallet, other.id, TOKEN_PROGRAM), true)); return recompile(m, x); }, /references another token account of the wallet/],
    ['the wallet\'s Token-2022 account of a registry mint among the route accounts', () => tt, (x, k, m, f) => { x[k]!.accounts.push(acct(associatedTokenAddress(f.wallet, tok('PYUSD').id, TOKEN_2022_PROGRAM), true)); return recompile(m, x); }, /references another token account of the wallet/],
    ['the wallet\'s wrapped-SOL account in a swap that has nothing to do with SOL', () => tt, (x, k, m, f) => { x[k]!.accounts.push(acct(associatedTokenAddress(f.wallet, WSOL_MINT, TOKEN_PROGRAM), true)); return recompile(m, x); }, /references another token account of the wallet/],
    ['a higher priority fee than the approved price gives', () => tt, (x, _k, m) => recompile(m, x, { fee: m.priorityFeeLamports + 1n }), /priority fee does not match/],
    ['another compute-unit limit', () => tt, (x, _k, m) => recompile(m, x, { limit: m.computeUnitLimit + 1 }), /compute-unit limit/],
    ['another blockhash', () => tt, (x, _k, m) => recompile(m, x, { blockhash: THIRD }), /blockhash/],
    ['another fee payer', () => tt, (x, _k, m, f) => ({ msg: recompile(m, x.map((q) => ({ ...q, accounts: q.accounts.map((a) => ({ ...a, signer: false })) })), { payer: THIRD }), intent: f.intent }), /hash|fee payer/],
    ['wrap more than approved', () => si, (x, _k, m) => { setData(x.find((q) => q.program === SYSTEM_PROGRAM)!, (d) => d.writeBigUInt64LE(d.readBigUInt64LE(4) + 1n, 4)); return recompile(m, x); }, /wrapped amount differs/],
    ['SOL sent elsewhere than the wallet\'s wrapped-SOL account', () => si, (x, _k, m) => { x.find((q) => q.program === SYSTEM_PROGRAM)!.accounts[1]!.pubkey = THIRD; return recompile(m, x); }, /not into the wallet's own wrapped-SOL account/],
    ['SOL input without the wrap', () => si, (x, _k, m) => recompile(m, x.filter((q) => q.program !== SYSTEM_PROGRAM)), /missing the SOL wrap/],
    ['another System instruction in place of the transfer', () => si, (x, _k, m) => { setData(x.find((q) => q.program === SYSTEM_PROGRAM)!, (d) => d.writeUInt32LE(1, 0)); return recompile(m, x); }, /SOL transfer is not/],
    ['wrapped SOL closed to a third party (SOL sold)', () => si, (x, _k, m) => { x[x.length - 1]!.accounts[1] = acct(THIRD, true); return recompile(m, x); }, /missing the wrapped-SOL close back to the wallet/],
    ['wrapped SOL closed to a third party (SOL bought)', () => so, (x, _k, m) => { x[x.length - 1]!.accounts[1] = acct(THIRD, true); return recompile(m, x); }, /missing the wrapped-SOL close back to the wallet/],
    ['SOL bought but left wrapped', () => so, (x, _k, m) => recompile(m, x.slice(0, -1)), /missing the wrapped-SOL close/],
    ['SOL bought without creating the wrapped-SOL account', () => so, (x, _k, m) => recompile(m, x.filter((q) => q.program !== ATA_PROGRAM)), /must be created/],
    ['a close instruction when no SOL is involved', () => tt, (x, _k, m, f) => recompile(m, [...x, { program: TOKEN_PROGRAM, accounts: [acct(associatedTokenAddress(f.wallet, mintOf(f.to), tpOf(f.to)), true), acct(f.wallet, true), acct(f.wallet, false, true)], data: Uint8Array.of(9) }]), /unexpected program Token/],
  ];
  it.each(cases)('refuses %s', (_n, f, make, why) => refuses(f(), make, why));

  it('two signers, read-only signers and a co-signing wallet are refused', () => {
    const m = decodeSolV1Message(bytes(tt)), good = bytes(tt);
    const two = Uint8Array.from(good); two[1] = 2; // the second key becomes a signer too
    expect(() => verifyJupiterSwap(rehash(tt.intent, two), two)).toThrow(/exactly one signer/);
    const ro = Uint8Array.from(good); ro[1] = 2; ro[2] = 1;
    expect(() => verifyJupiterSwap(rehash(tt.intent, ro), ro)).toThrow(/exactly one signer/);
    // a third party pays and the wallet co-signs: keys shifted by one, hand-assembled
    const head = Buffer.from(good.subarray(0, 42)); head[1] = 2; head[41] = m.keys.length + 1;
    const body = Buffer.from(good.subarray(42 + m.keys.length * 32)); let o = 16;
    for (let q = 0; q < m.instructions.length; q++) body[o + q * 4]! += 1;
    o += m.instructions.length * 4; for (const ix of m.instructions) { for (let q = 0; q < ix.accounts.length; q++) body[o + q]! += 1; o += ix.accounts.length + ix.data.length; }
    const third = Buffer.from(good.subarray(42 + 32 * 5, 42 + 32 * 6)); third[0]! ^= 0xff; // some other 32-byte key
    const co = new Uint8Array(Buffer.concat([head, third, Buffer.from(good.subarray(42, 42 + m.keys.length * 32)), body]));
    expect(decodeSolV1Message(co).keys[1]).toBe(tt.wallet);
    expect(() => verifyJupiterSwap(rehash(tt.intent, co), co)).toThrow(/exactly one signer/);
  });

  it('the intent binds the message: hash, assets, amounts, fee ceiling, chain parameters', () => {
    const msg = bytes(tt), i = tt.intent, bad = (o: Partial<Intent>, swap: Partial<NonNullable<Intent['swap']>>, why: RegExp, sol: Partial<NonNullable<Intent['sol']>> = {}) => expect(() => verifyJupiterSwap({ ...i, ...o, swap: { ...i.swap!, ...swap }, sol: { ...i.sol!, ...sol } }, msg)).toThrow(why);
    bad({}, { dataHash: 'f'.repeat(64) }, /approved hash/);
    const flipped = Uint8Array.from(msg); flipped[flipped.length - 1]! ^= 1; expect(() => verifyJupiterSwap(i, flipped)).toThrow(/approved hash/);
    bad({}, { toAsset: other.id }, /fixed accounts|destination|token-account creation/);
    bad({ asset: other.id, symbol: other.symbol, decimals: other.decimals }, {}, /source token account|fixed accounts/);
    bad({}, { minOut: (BigInt(i.swap!.minOut) + 1n).toString() }, /less than the approved minimum/);
    bad({}, { minOut: '0' }, /amounts out of range/);
    bad({ amount: (BigInt(i.amount) - 1n).toString() }, {}, /spends another amount/);
    bad({ maxFee: (5000n + decodeSolV1Message(msg).priorityFeeLamports + RENT_TOKEN_ACCOUNT - 1n).toString() }, {}, /fee exceeds approved maximum/); // the creation is counted even though it is idempotent
    bad({}, { router: THIRD }, /pinned Jupiter aggregator/);
    bad({}, { approveGas: '1' }, /no approval step/);
    bad({ to: THIRD }, {}, /deliver to the wallet itself/);
    bad({ decimals: 5 }, {}, /metadata/);
    bad({ chainRef: 'x' }, {}, /chain identity/);
    bad({ memo: 'hi' }, {}, /unexpected intent section/);
    bad({}, { toAsset: i.asset }, /same asset/);
    bad({}, {}, /blockhash/, { recentBlockhash: THIRD });
    bad({}, {}, /compute-unit limit/, { computeUnitLimit: i.sol!.computeUnitLimit - 1 });
    bad({}, {}, /priority fee/, { computeUnitPrice: (BigInt(i.sol!.computeUnitPrice) + 1_000_000n).toString() });
    bad({}, {}, /token-account creation does not match/, { createAta: !i.sol!.createAta });
    // an intent with the other provider's name, or a Jupiter intent on an EVM network, never reaches a signature
    expect(() => verifyJupiterSwap({ ...i, swap: { ...i.swap!, provider: 'kyberswap' } }, msg)).toThrow(/unknown swap provider/);
    expect(() => verifyKyberSwap(i, '0x00')).toThrow(/not an EVM swap intent/);
    expect(() => canonicalBytes({ ...i, swap: { ...i.swap!, provider: 'kyberswap' } })).toThrow(/swaps are only defined/);
    expect(() => IntentSchema.parse({ ...i, swap: { ...i.swap!, provider: 'raydium' } })).toThrow();
    expect(intentHash(i)).not.toEqual(intentHash({ ...i, swap: { ...i.swap!, minOut: '1' } }));
  });

  it('Token-2022: verified with the Token-2022 program; a new Token-2022 account is costed at its bound and limited by the fee ceiling', () => {
    const f = FX['usdc-pyusd']!, facts = verifyJupiterSwap(f.intent, bytes(f));
    expect(facts.destinationAccount).toBe(associatedTokenAddress(f.wallet, tok('PYUSD').id, TOKEN_2022_PROGRAM));
    expect(facts.message.instructions.find((x) => x.program === JUPITER_PROGRAM)!.accounts[9]).toBe(TOKEN_2022_PROGRAM);
    const creates = facts.message.instructions.some((x) => x.program === ATA_PROGRAM);
    expect(facts.rentMax).toBe(creates ? RENT_TOKEN2022_ACCOUNT_MAX : 0n);
    // the destination account derived with the classic Token program is another address: refused
    refuses(f, (x, k, m) => { x[k]!.accounts[5]!.pubkey = associatedTokenAddress(f.wallet, tok('PYUSD').id, TOKEN_PROGRAM); return recompile(m, x); }, /destination token account is not the wallet's own/);
    if (creates) expect(() => verifyJupiterSwap({ ...f.intent, maxFee: (RENT_TOKEN2022_ACCOUNT_MAX + 4999n).toString() }, bytes(f))).toThrow(/fee exceeds/);
  });
});
