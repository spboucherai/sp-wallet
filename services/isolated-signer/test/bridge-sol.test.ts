/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/isolated-signer/test/bridge-sol.test.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// Solana ↔ EVM USDC (Circle CCTP V2 on Solana) at the signer boundary: what it builds and signs, and everything it refuses.
// The layouts themselves are checked against real mainnet transactions in packages/core/test/cctp-sol.test.ts; what the real
// programs do with these transactions is proven by mainnet simulation in scripts/sim-solana-cctp.mts.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { decodeFunctionData, parseTransaction, recoverTransactionAddress, type Hex } from 'viem';
import {
  CCTP_ABI, CCTP_MESSAGE_TRANSMITTER, CCTP_SOL_MESSAGE_TRANSMITTER, CCTP_SOL_RECLAIM_WINDOW_SEC, CCTP_SOL_TOKEN_MESSENGER_MINTER, CCTP_TOKEN_MESSENGER, cctpBytes32, cctpEnd, cctpMessageHash, cctpMintRetryBytes, cctpRecipient32, cctpSolBytes32,
  cctpSolMintRetryBytes, cctpSolPda, cctpSolReclaimBytes, cctpSolTokenAccount, decodeSolV1Message, encodeCctpMessage, expectedCctpSolSourceMessage, intentHash, NETWORKS, solTokenAccountHash, verifyAuditChain,
  type CctpMessage, type Intent, type SolBudget, type SolTokenAccountRequest,
} from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../src/keys.ts';
import { authHeader, createSignerServer } from '../src/server.ts';
import { Signer } from '../src/signer.ts';
import { Store } from '../src/store.ts';

// Public BIP-39 test vector mnemonic — holds no funds, never used outside tests.
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const RP = 'wallet.test', ORIGIN = 'https://wallet.test', EVM_ME = keys.addresses.evm, SOL_ME = keys.addresses.solana!;
const OTHER_EVM = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', OTHER_SOL = 'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', USDT_SOL = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const usdc = (n: string) => NETWORKS[n]!.tokens.find((t) => t.symbol === 'USDC')!.id;
const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const ATT = `0x${'22'.repeat(130)}`, DAY = 86_400;

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'spw-bridge-sol-')), nowRef = { t: Math.floor(Date.now() / 1000) };
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json')), signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => nowRef.t), pk = new TestPasskey(RP, ORIGIN);
  store.state.setupTokenHash = createHash('sha256').update('t').digest('hex');
  await signer.enroll({ credential: pk.credential(), setupToken: 't' });
  return { store, signer, pk, nowRef, statePath: join(dir, 'state.json') };
}
let seq = 0;
const pid = () => `8b1c1f0e-8f5f-4b1e-9c56-${String(++seq).padStart(12, '0')}`;
/** USDC burned on Solana for the wallet's own EVM address */
function fromSol(now: number, o: Partial<Intent> = {}, bridge: Partial<NonNullable<Intent['bridge']>> = {}, sol: Partial<NonNullable<Intent['sol']>> = {}): Intent {
  return { v: 1, proposalId: pid(), keyId: keys.keyId, network: 'solana', chainRef: NETWORKS.solana!.chainRef, asset: USDC_SOL, symbol: 'USDC', decimals: 6, amount: '10000000', from: SOL_ME, to: SOL_ME,
    maxFee: '2914480', createdAt: now, expiresAt: now + 50, policyVersion: 4,
    bridge: { provider: 'cctp', toNetwork: 'base', toDomain: 6, maxFee: '0', minFinalityThreshold: 2000, messenger: CCTP_SOL_TOKEN_MESSENGER_MINTER, transmitter: CCTP_SOL_MESSAGE_TRANSMITTER, approveGas: '0', recipient: EVM_ME, ...bridge },
    sol: { recentBlockhash: BLOCKHASH, lastValidBlockHeight: 300_000_000, createAta: false, computeUnitLimit: 80_000, computeUnitPrice: '1000000', ...sol }, ...o };
}
/** USDC burned on Base for the wallet's own USDC token account on Solana */
function toSol(now: number, o: Partial<Intent> = {}, bridge: Partial<NonNullable<Intent['bridge']>> = {}): Intent {
  return { v: 1, proposalId: pid(), keyId: keys.keyId, network: 'base', chainRef: '8453', asset: usdc('base'), symbol: 'USDC', decimals: 6, amount: '10000000', from: EVM_ME, to: EVM_ME,
    maxFee: '270000000000000', createdAt: now, expiresAt: now + 75, policyVersion: 4,
    bridge: { provider: 'cctp', toNetwork: 'solana', toDomain: 5, maxFee: '0', minFinalityThreshold: 2000, messenger: CCTP_TOKEN_MESSENGER, transmitter: CCTP_MESSAGE_TRANSMITTER, approveGas: '70000', recipient: SOL_ME, ...bridge },
    evm: { nonce: 3, gasLimit: '200000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000' }, ...o };
}
/** what Circle returns for the burn of `i` on Solana */
const attestedSol = (i: Intent, o: Partial<CctpMessage> = {}, body: Partial<CctpMessage['body']> = {}, nonce = 'cd'.repeat(32)): Hex => {
  const m = expectedCctpSolSourceMessage(i);
  return encodeCctpMessage({ ...m, nonce, finalityThresholdExecuted: m.minFinalityThreshold, ...o, body: { ...m.body, ...body } });
};
/** what Circle returns for the burn of `i` on an EVM network toward Solana */
const attestedEvm = (i: Intent, o: Partial<CctpMessage> = {}, body: Partial<CctpMessage['body']> = {}, nonce = 'ef'.repeat(32)): Hex => {
  const b = i.bridge!, src = cctpEnd(i.network)!, dst = cctpEnd('solana')!;
  return encodeCctpMessage({ version: 1, sourceDomain: src.domain, destinationDomain: 5, nonce, sender: src.messenger, recipient: dst.messenger, destinationCaller: '0'.repeat(64), minFinalityThreshold: b.minFinalityThreshold, finalityThresholdExecuted: b.minFinalityThreshold, ...o,
    body: { version: 1, burnToken: src.usdc, mintRecipient: cctpRecipient32(dst, SOL_ME), amount: BigInt(i.amount), messageSender: cctpBytes32(i.from), maxFee: BigInt(b.maxFee), feeExecuted: 0n, expirationBlock: 0n, ...body } });
};
const EVM_GAS = { nonce: 4, gasLimit: '240000', maxFeePerGas: '100000000', maxPriorityFeePerGas: '1000000' };
const SOL_GAS: SolBudget = { recentBlockhash: BLOCKHASH, lastValidBlockHeight: 300_000_000, computeUnitLimit: 260_000, computeUnitPrice: '100000' };
/** split a signed v1 transaction and check every signature against its signer key */
function openTx(rawB64: string) {
  const wire = new Uint8Array(Buffer.from(rawB64, 'base64')), n = wire[1]!, msg = wire.subarray(0, wire.length - 64 * n), d = decodeSolV1Message(msg);
  const sigs = Array.from({ length: n }, (_x, k) => wire.subarray(msg.length + 64 * k, msg.length + 64 * (k + 1)));
  return { d, msg, sigs, valid: sigs.map((s, k) => ed25519.verify(s, msg, base58.decode(d.keys[k]!))) };
}

describe('Solana → EVM, first leg: the burn the signer builds, with its own one-time event account', () => {
  it('signs one deposit_for_burn with two signatures — the wallet and a fresh event key — and records the bridge with the event account', async () => {
    const { signer, store, pk, nowRef, statePath } = await setup(), i = fromSol(nowRef.t);
    const out = await signer.sign(i, pk.assert(intentHash(i)));
    const { d, sigs, valid } = openTx(out.raw);
    expect(d.numSigners).toBe(2); expect(valid).toEqual([true, true]); expect(d.keys[0]).toBe(SOL_ME); expect(d.keys[1]).toBe(out.eventAccount);
    expect(out.txid).toBe(base58.encode(sigs[0]!));
    expect(d.instructions.length).toBe(1); expect(d.instructions[0]!.program).toBe(CCTP_SOL_TOKEN_MESSENGER_MINTER);
    const a = d.instructions[0]!.accounts, data = Buffer.from(d.instructions[0]!.data);
    expect(a[0]).toBe(SOL_ME); expect(a[1]).toBe(SOL_ME); expect(a[3]).toBe(cctpSolTokenAccount(SOL_ME)); expect(a[10]).toBe(USDC_SOL); expect(a[11]).toBe(out.eventAccount);
    expect(data.readBigUInt64LE(8)).toBe(10_000_000n); expect(data.readUInt32LE(16)).toBe(6); expect(data.subarray(20, 52).toString('hex')).toBe(cctpBytes32(EVM_ME)); expect(data.subarray(52, 84).every((x) => x === 0)).toBe(true);
    expect(store.state.bridges![i.proposalId]).toMatchObject({ burnTxid: out.txid, sol: { eventAccount: out.eventAccount }, bridge: { fromNetwork: 'solana', toNetwork: 'base', wallet: SOL_ME, recipient: EVM_ME, amount: '10000000', maxFee: '0', minFinalityThreshold: 2000 } });
    expect(store.state.spent[`${new Date(nowRef.t * 1000).toISOString().slice(0, 10)}|solana:USDC`]).toBe('10000000'); // counted like a send
    expect(signer.status().bridges[0]).toMatchObject({ eventAccount: out.eventAccount, reclaimTxid: null });
    expect(store.state.journal.at(-1)).toMatchObject({ type: 'sign.ok', data: { eventAccount: out.eventAccount, recipient: EVM_ME } });
    // only the PUBLIC key of the event account is kept: nothing in the state file can sign for it
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { bridges: Record<string, { sol: Record<string, unknown> }> };
    expect(Object.keys(state.bridges[i.proposalId]!.sol)).toEqual(['eventAccount']);
    // every burn gets another event account
    const j = fromSol(nowRef.t), out2 = await signer.sign(j, pk.assert(intentHash(j)));
    expect(out2.eventAccount).not.toBe(out.eventAccount); expect(openTx(out2.raw).valid).toEqual([true, true]);
  });
  it.each([
    ['another recipient: someone else\'s EVM address', {}, { recipient: OTHER_EVM }, {}, 'unsupported', /not this wallet's own address/],
    ['another recipient: a Solana address', {}, { recipient: OTHER_SOL }, {}, 'unsupported', /EVM address/],
    ['no recipient (such an intent cannot even be hashed: refused before anything else)', {}, { recipient: undefined }, {}, 'undefined', /names the wallet's address/],
    ['a destination that is not the source owner (to ≠ from)', { to: OTHER_SOL }, {}, {}, 'self_send', /wallet itself/],
    ['another owner / payer (from is not this wallet)', { from: OTHER_SOL, to: OTHER_SOL }, {}, {}, 'wrong_source', /not controlled/],
    ['another amount than the one approved', {}, {}, {}, 'bad_approval', /./],
    ['an amount above the per-transfer limit', { amount: '50000001' }, {}, {}, 'policy', /per-transaction limit/],
    ['another mint (USDT)', { asset: USDT_SOL, symbol: 'USDT' }, {}, {}, 'unsupported', /registry USDC/],
    ['another mint under the USDC name', { asset: USDT_SOL }, {}, {}, 'unsupported', /registry USDC/],
    ['a destination domain that is not the destination network\'s', {}, { toDomain: 3 }, {}, 'unsupported', /destination domain/],
    ['a destination outside CCTP', {}, { toNetwork: 'bsc', toDomain: 17 }, {}, 'unsupported', /not enabled/],
    ['Solana as its own destination', {}, { toNetwork: 'solana', toDomain: 5, recipient: SOL_ME }, {}, 'unsupported', /not enabled/],
    ['an unpinned token-messenger program', {}, { messenger: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' }, {}, 'unsupported', /pinned TokenMessengerMinterV2/],
    ['an unpinned transmitter program', {}, { transmitter: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' }, {}, 'unsupported', /pinned MessageTransmitterV2/],
    ['the EVM contracts named as programs', {}, { messenger: CCTP_TOKEN_MESSENGER, transmitter: CCTP_MESSAGE_TRANSMITTER }, {}, 'unsupported', /pinned/],
    ['a CCTP fee above 1 %', {}, { maxFee: '100001', minFinalityThreshold: 1000 }, {}, 'unsupported', /1 %/],
    ['a fee ceiling above the policy (0.003 SOL)', { maxFee: '3000001' }, {}, {}, 'policy', /fee ceiling/],
    ['a fee ceiling that does not cover fee + deposit', { maxFee: '2914479' }, {}, {}, 'unsupported', /exceed the approved maximum/],
    ['a compute budget above the bound', { maxFee: '3000000' }, {}, { computeUnitLimit: 400_000, computeUnitPrice: '0' }, 'unsupported', /compute-unit limit/],
    ['a swap section next to the bridge', { swap: { provider: 'jupiter', toAsset: 'native', minOut: '1', router: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', dataHash: '0'.repeat(64), approveGas: '0' } }, {}, {}, 'undefined', /exclude a swap/],
  ] as [string, Partial<Intent>, Partial<NonNullable<Intent['bridge']>>, Partial<NonNullable<Intent['sol']>>, string, RegExp][])('refuses %s', async (name, o, b, s, code, re) => {
    const { signer, store, pk, nowRef } = await setup(), i = fromSol(nowRef.t, o, b, s);
    if (b.recipient === undefined && 'recipient' in b) delete (i.bridge as { recipient?: string }).recipient;
    let approved: Uint8Array;
    try { approved = intentHash(name.startsWith('another amount') ? { ...i, amount: '9000000' } : i); } catch { approved = new Uint8Array(32); } // an intent the API could not even hash honestly
    const err = await signer.sign(i, pk.assert(approved)).then(() => null, (e: Error & { code: string }) => e);
    expect(err, name).not.toBeNull(); expect(String(err!.code)).toMatch(new RegExp(`^(${code})$`)); expect(err!.message).toMatch(re);
    expect(store.state.bridges ?? {}).toEqual({}); expect(store.state.spent).toEqual({});
  });
  it('refuses any helper data: no instruction, account or event key can be handed to the signer', async () => {
    const { signer, store, pk, nowRef } = await setup();
    for (const aux of [{ swapMessage: 'AAAA' }, { eventAccount: OTHER_SOL }, { eventSecret: '00'.repeat(32) }, { instructions: [] }]) {
      const i = fromSol(nowRef.t);
      await expect(signer.sign(i, pk.assert(intentHash(i)), aux)).rejects.toMatchObject({ code: 'unsupported', message: expect.stringMatching(/no helper data/) });
    }
    expect(store.state.bridges ?? {}).toEqual({});
  });
  it('refuses a replay, a halted signer, and a stale approval', async () => {
    const { signer, pk, nowRef } = await setup(), i = fromSol(nowRef.t);
    await signer.sign(i, pk.assert(intentHash(i)));
    await expect(signer.sign(i, pk.assert(intentHash(i)))).rejects.toMatchObject({ code: 'replay' });
    const late = fromSol(nowRef.t - 100);
    await expect(signer.sign(late, pk.assert(intentHash(late)))).rejects.toMatchObject({ code: 'policy' });
    signer.halt();
    const j = fromSol(nowRef.t);
    await expect(signer.sign(j, pk.assert(intentHash(j)))).rejects.toMatchObject({ code: 'policy' });
  });
});

describe('Solana → EVM, second leg: the EVM mint of a Solana-sourced message', () => {
  async function burned() { const s = await setup(), i = fromSol(s.nowRef.t); const out = await s.signer.sign(i, s.pk.assert(intentHash(i))); return { ...s, i, out }; }
  it('signs the one receiveMessage for the message the approved burn implies, from the wallet\'s EVM address, without a second passkey', async () => {
    const { signer, store, i } = await burned(), message = attestedSol(i);
    const r = await signer.signBridgeMint({ proposalId: i.proposalId, message, attestation: ATT, evm: EVM_GAS });
    const tx = parseTransaction(r.raw as Hex);
    expect(await recoverTransactionAddress({ serializedTransaction: r.raw as never })).toBe(EVM_ME);
    expect(tx.to!.toLowerCase()).toBe(CCTP_MESSAGE_TRANSMITTER.toLowerCase()); expect(tx.chainId).toBe(8453); expect(tx.value ?? 0n).toBe(0n);
    expect(decodeFunctionData({ abi: CCTP_ABI, data: tx.data! }).args).toEqual([message, ATT]);
    expect(r.minted).toBe('10000000'); expect(r.messageHash).toBe(cctpMessageHash(message)); expect(store.state.bridges![i.proposalId]!.mint!.signatures).toBe(1);
    // identical request: same bytes; anything else: refused without the passkey
    expect((await signer.signBridgeMint({ proposalId: i.proposalId, message, attestation: ATT, evm: EVM_GAS })).raw).toBe(r.raw);
    await expect(signer.signBridgeMint({ proposalId: i.proposalId, message, attestation: ATT, evm: { ...EVM_GAS, nonce: 5 } })).rejects.toMatchObject({ code: 'replay' });
  });
  it.each([
    ['minting to another EVM address', {}, { mintRecipient: cctpBytes32(OTHER_EVM) }, /another address/],
    ['minting to the wallet\'s SOLANA token account (not an address on the destination)', {}, { mintRecipient: cctpSolBytes32(cctpSolTokenAccount(SOL_ME)) }, /another address/],
    ['burned by another Solana wallet', {}, { messageSender: cctpSolBytes32(OTHER_SOL) }, /not burned by this wallet/],
    ['whose messageSender is the wallet\'s token account (not the owner key)', {}, { messageSender: cctpSolBytes32(cctpSolTokenAccount(SOL_ME)) }, /not burned by this wallet/],
    ['whose messageSender is the wallet\'s EVM address', {}, { messageSender: cctpBytes32(EVM_ME) }, /not burned by this wallet/],
    ['with another amount', {}, { amount: 10_000_001n }, /another amount/],
    ['burning another mint', {}, { burnToken: cctpSolBytes32(USDT_SOL) }, /another token/],
    ['burning the EVM USDC', {}, { burnToken: cctpBytes32(usdc('base')) }, /another token/],
    ['from another source domain', { sourceDomain: 3 }, {}, /another source domain/],
    ['for another destination domain', { destinationDomain: 3 }, {}, /another destination domain/],
    ['with a destination caller', { destinationCaller: cctpBytes32(OTHER_EVM) }, {}, /destination caller/],
    ['sent by another program than Circle\'s token messenger', { sender: cctpSolBytes32('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4') }, {}, /pinned TokenMessengers/],
    ['sent by the EVM token messenger (not a Solana-sourced message)', { sender: cctpBytes32(CCTP_TOKEN_MESSENGER) }, {}, /pinned TokenMessengers/],
    ['charging a fee the owner did not approve', {}, { feeExecuted: 1n }, /more than the approved/],
    ['with another fee ceiling', {}, { maxFee: 5n }, /another fee ceiling/],
    ['attested below the approved finality', { finalityThresholdExecuted: 1000 }, {}, /below the approved finality/],
    ['without a nonce', { nonce: '0'.repeat(64) }, {}, /no nonce/],
  ] as [string, Partial<CctpMessage>, Partial<CctpMessage['body']>, RegExp][])('refuses a message %s', async (_n, o, body, re) => {
    const { signer, store, i } = await burned();
    await expect(signer.signBridgeMint({ proposalId: i.proposalId, message: attestedSol(i, o, body), attestation: ATT, evm: EVM_GAS })).rejects.toMatchObject({ code: 'unsupported', message: expect.stringMatching(re) });
    expect(store.state.bridges![i.proposalId]!.mint).toBeUndefined();
  });
  it('never twice: a second mint needs the passkey, a message serves one bridge, Solana parameters are not an EVM mint', async () => {
    const { signer, pk, nowRef, i } = await burned(), message = attestedSol(i);
    const j = fromSol(nowRef.t); await signer.sign(j, pk.assert(intentHash(j))); // a second, identical bridge
    await expect(signer.signBridgeMint({ proposalId: i.proposalId, message, attestation: ATT, sol: SOL_GAS })).rejects.toMatchObject({ code: 'bad_request' });
    const first = await signer.signBridgeMint({ proposalId: i.proposalId, message, attestation: ATT, evm: EVM_GAS });
    await expect(signer.signBridgeMint({ proposalId: j.proposalId, message, attestation: ATT, evm: EVM_GAS })).rejects.toMatchObject({ code: 'replay', message: expect.stringMatching(/another bridge/) });
    const g2 = { ...EVM_GAS, nonce: 9 };
    await expect(signer.signBridgeMint({ proposalId: i.proposalId, message, attestation: ATT, evm: g2, assertion: pk.assert(sha(cctpMintRetryBytes(i.proposalId, first.messageHash, EVM_GAS))) })).rejects.toMatchObject({ code: 'bad_approval' });
    const again = await signer.signBridgeMint({ proposalId: i.proposalId, message, attestation: ATT, evm: g2, assertion: pk.assert(sha(cctpMintRetryBytes(i.proposalId, first.messageHash, g2))) });
    expect(again.raw).not.toBe(first.raw);
    await expect(signer.signBridgeMint({ proposalId: pid(), message, attestation: ATT, evm: EVM_GAS })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('Solana → EVM: the event-account deposit back to the wallet', () => {
  async function burned() { const s = await setup(), i = fromSol(s.nowRef.t); const out = await s.signer.sign(i, s.pk.assert(intentHash(i))); return { ...s, i, out, message: attestedSol(i) }; }
  const g: SolBudget = { ...SOL_GAS, computeUnitLimit: 190_000 };
  const challenge = (id: string, ev: string, message: string, b: SolBudget = g) => sha(cctpSolReclaimBytes(id, ev, cctpMessageHash(message), b));
  it('five days later, with the passkey: one reclaim_event_account signed by the wallet alone, for the recorded account, paying the wallet', async () => {
    const { signer, store, pk, nowRef, i, out, message } = await burned();
    await expect(signer.signBridgeReclaim({ proposalId: i.proposalId, message, attestation: ATT, sol: g, assertion: pk.assert(challenge(i.proposalId, out.eventAccount!, message)) })).rejects.toMatchObject({ code: 'policy', message: expect.stringMatching(/five days/) });
    nowRef.t += CCTP_SOL_RECLAIM_WINDOW_SEC + 60;
    await expect(signer.signBridgeReclaim({ proposalId: i.proposalId, message, attestation: ATT, sol: g })).rejects.toMatchObject({ code: 'bad_approval' }); // no passkey
    await expect(signer.signBridgeReclaim({ proposalId: i.proposalId, message, attestation: ATT, sol: g, assertion: pk.assert(challenge(i.proposalId, out.eventAccount!, message, { ...g, computeUnitPrice: '1' })) })).rejects.toMatchObject({ code: 'bad_approval' });
    const r = await signer.signBridgeReclaim({ proposalId: i.proposalId, message, attestation: ATT, sol: g, assertion: pk.assert(challenge(i.proposalId, out.eventAccount!, message)) });
    const { d, valid } = openTx(r.raw);
    expect(d.numSigners).toBe(1); expect(valid).toEqual([true]); expect(d.payer).toBe(SOL_ME); expect(d.instructions.length).toBe(1);
    expect(d.instructions[0]!.program).toBe(CCTP_SOL_MESSAGE_TRANSMITTER); expect(d.instructions[0]!.accounts).toEqual([SOL_ME, cctpSolPda.messageTransmitter(), out.eventAccount]);
    expect(r.eventAccount).toBe(out.eventAccount); expect(store.state.bridges![i.proposalId]!.reclaim).toMatchObject({ txid: r.txid, signatures: 1 });
    expect(verifyAuditChain(store.state.journal)).toBeNull();
  });
  it('refuses another event account, another bridge\'s message, a bridge without event account, an unknown bridge', async () => {
    const { signer, pk, nowRef, i, out, message } = await burned();
    const e = toSol(nowRef.t); await signer.sign(e, pk.assert(intentHash(e))); // an EVM → Solana bridge: no event account
    nowRef.t += 6 * DAY;
    // the request cannot name an account: an extra field is ignored and the challenge is bound to the RECORDED account
    await expect(signer.signBridgeReclaim({ proposalId: i.proposalId, message, attestation: ATT, sol: g, eventAccount: OTHER_SOL, assertion: pk.assert(challenge(i.proposalId, OTHER_SOL, message)) } as never)).rejects.toMatchObject({ code: 'bad_approval' });
    const other = attestedSol(i, {}, { amount: 11_000_000n });
    await expect(signer.signBridgeReclaim({ proposalId: i.proposalId, message: other, attestation: ATT, sol: g, assertion: pk.assert(challenge(i.proposalId, out.eventAccount!, other)) })).rejects.toMatchObject({ code: 'unsupported', message: expect.stringMatching(/another amount/) });
    await expect(signer.signBridgeReclaim({ proposalId: e.proposalId, message: attestedEvm(e), attestation: ATT, sol: g, assertion: pk.assert(challenge(e.proposalId, out.eventAccount!, message)) })).rejects.toMatchObject({ code: 'unsupported', message: expect.stringMatching(/no event account/) });
    await expect(signer.signBridgeReclaim({ proposalId: pid(), message, attestation: ATT, sol: g, assertion: pk.assert(challenge(i.proposalId, out.eventAccount!, message)) })).rejects.toMatchObject({ code: 'not_found' });
    await expect(signer.signBridgeReclaim({ proposalId: i.proposalId, message, attestation: ATT, sol: { ...g, computeUnitLimit: 1_000_000 }, assertion: pk.assert(challenge(i.proposalId, out.eventAccount!, message)) })).rejects.toMatchObject({ code: 'unsupported' });
    signer.halt();
    await expect(signer.signBridgeReclaim({ proposalId: i.proposalId, message, attestation: ATT, sol: g, assertion: pk.assert(challenge(i.proposalId, out.eventAccount!, message)) })).rejects.toMatchObject({ code: 'policy' });
  });
  it('a burn whose deposit was never reclaimed keeps its record after the mint; a reclaimed one is pruned like the others', async () => {
    const { signer, store, pk, nowRef, i, out, message } = await burned();
    await signer.signBridgeMint({ proposalId: i.proposalId, message, attestation: ATT, evm: EVM_GAS });
    nowRef.t += 120 * DAY; store.prune(nowRef.t);
    expect(store.state.bridges![i.proposalId]).toBeDefined();
    await signer.signBridgeReclaim({ proposalId: i.proposalId, message, attestation: ATT, sol: g, assertion: pk.assert(challenge(i.proposalId, out.eventAccount!, message)) });
    store.prune(nowRef.t);
    expect(store.state.bridges![i.proposalId]).toBeUndefined();
  });
});

describe('EVM → Solana: the burn names the wallet\'s own USDC token account; the mint is a Solana transaction the signer builds', () => {
  async function burned(bridge: Partial<NonNullable<Intent['bridge']>> = {}) { const s = await setup(), i = toSol(s.nowRef.t, {}, bridge); const out = await s.signer.sign(i, s.pk.assert(intentHash(i))); return { ...s, i, out }; }
  it('burn: mintRecipient = the associated USDC token account derived from the signer\'s own Solana key', async () => {
    const { store, i, out } = await burned();
    const args = decodeFunctionData({ abi: CCTP_ABI, data: parseTransaction(out.raw as Hex).data! }).args as readonly unknown[];
    expect(args[1]).toBe(5); expect(args[2]).toBe(`0x${cctpSolBytes32(cctpSolTokenAccount(SOL_ME))}`); expect(args[4]).toBe(`0x${'0'.repeat(64)}`);
    expect(await recoverTransactionAddress({ serializedTransaction: out.raw as never })).toBe(EVM_ME);
    expect(store.state.bridges![i.proposalId]).toMatchObject({ bridge: { fromNetwork: 'base', toNetwork: 'solana', wallet: EVM_ME, recipient: SOL_ME } });
    expect(store.state.bridges![i.proposalId]!.sol).toBeUndefined(); expect(out.eventAccount).toBeUndefined();
  });
  it.each([
    ['someone else\'s Solana address as recipient', { recipient: OTHER_SOL }, /not served by the same wallet address/],
    ['an EVM address as recipient', { recipient: EVM_ME }, /./],
    ['no recipient', { recipient: undefined }, /names the wallet's Solana address/],
    ['a wrong destination domain', { toDomain: 6 }, /destination domain/],
  ] as [string, Partial<NonNullable<Intent['bridge']>>, RegExp][])('burn: refuses %s', async (_n, b, re) => {
    const { signer, store, pk, nowRef } = await setup(), i = toSol(nowRef.t, {}, b);
    if (b.recipient === undefined && 'recipient' in b) delete (i.bridge as { recipient?: string }).recipient;
    await expect(signer.sign(i, pk.assert(intentHash(i)))).rejects.toMatchObject({ code: 'unsupported', message: expect.stringMatching(re) });
    expect(store.state.bridges ?? {}).toEqual({});
  });
  it('mint: one receive_message, payer and caller = the wallet, credited account = its own token account; signed once without a passkey', async () => {
    const { signer, store, pk, i } = await burned(), message = attestedEvm(i);
    const r = await signer.signBridgeMint({ proposalId: i.proposalId, message, attestation: ATT, sol: SOL_GAS });
    const { d, valid, sigs } = openTx(r.raw), a = d.instructions[0]!.accounts;
    expect(d.numSigners).toBe(1); expect(valid).toEqual([true]); expect(r.txid).toBe(base58.encode(sigs[0]!)); expect(d.payer).toBe(SOL_ME); expect(d.blockhash).toBe(BLOCKHASH);
    expect(d.instructions.length).toBe(1); expect(d.instructions[0]!.program).toBe(CCTP_SOL_MESSAGE_TRANSMITTER); expect(a.length).toBe(20);
    expect(a[0]).toBe(SOL_ME); expect(a[1]).toBe(SOL_ME); expect(a[15]).toBe(cctpSolTokenAccount(SOL_ME)); expect(a[4]).toBe(cctpSolPda.usedNonce('ef'.repeat(32))); expect(a.slice(9).includes(SOL_ME)).toBe(false);
    expect(r.minted).toBe('10000000'); expect(store.state.bridges![i.proposalId]!.mint).toMatchObject({ txid: r.txid, signatures: 1 });
    expect((await signer.signBridgeMint({ proposalId: i.proposalId, message, attestation: ATT, sol: SOL_GAS })).raw).toBe(r.raw); // identical request: same bytes
    // a Solana transaction that was not included in time needs a new blockhash: that second signature needs the passkey
    const g2 = { ...SOL_GAS, recentBlockhash: 'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', lastValidBlockHeight: 300_000_200 };
    await expect(signer.signBridgeMint({ proposalId: i.proposalId, message, attestation: ATT, sol: g2 })).rejects.toMatchObject({ code: 'replay' });
    await expect(signer.signBridgeMint({ proposalId: i.proposalId, message, attestation: ATT, sol: g2, assertion: pk.assert(sha(cctpSolMintRetryBytes(i.proposalId, r.messageHash, SOL_GAS))) })).rejects.toMatchObject({ code: 'bad_approval' });
    const again = await signer.signBridgeMint({ proposalId: i.proposalId, message, attestation: ATT, sol: g2, assertion: pk.assert(sha(cctpSolMintRetryBytes(i.proposalId, r.messageHash, g2))) });
    expect(openTx(again.raw).d.blockhash).toBe(g2.recentBlockhash); expect(store.state.bridges![i.proposalId]!.mint!.signatures).toBe(2);
    await expect(signer.signBridgeMint({ proposalId: i.proposalId, message, attestation: ATT, evm: EVM_GAS })).rejects.toMatchObject({ code: 'bad_request' }); // EVM parameters are not a Solana mint
  });
  it.each([
    ['minting to the wallet ADDRESS instead of its token account', {}, { mintRecipient: cctpSolBytes32(SOL_ME) }, /another address/],
    ['minting to someone else\'s token account', {}, { mintRecipient: cctpSolBytes32(cctpSolTokenAccount(OTHER_SOL)) }, /another address/],
    ['minting to the wallet\'s EVM address', {}, { mintRecipient: cctpBytes32(EVM_ME) }, /another address/],
    ['with another amount', {}, { amount: 9_999_999n }, /another amount/],
    ['burning another token', {}, { burnToken: cctpBytes32(usdc('arbitrum')) }, /another token/],
    ['from another source domain', { sourceDomain: 3 }, {}, /another source domain/],
    ['for another destination domain', { destinationDomain: 6 }, {}, /another destination domain/],
    ['with a destination caller', { destinationCaller: cctpSolBytes32(OTHER_SOL) }, {}, /destination caller/],
    ['addressed to another program', { recipient: cctpSolBytes32(CCTP_SOL_MESSAGE_TRANSMITTER) }, {}, /pinned TokenMessengers/],
    ['burned by another EVM address', {}, { messageSender: cctpBytes32(OTHER_EVM) }, /not burned by this wallet/],
    ['charging a fee the owner did not approve', {}, { feeExecuted: 1n }, /more than the approved/],
  ] as [string, Partial<CctpMessage>, Partial<CctpMessage['body']>, RegExp][])('mint: refuses a message %s', async (_n, o, body, re) => {
    const { signer, store, i } = await burned();
    await expect(signer.signBridgeMint({ proposalId: i.proposalId, message: attestedEvm(i, o, body), attestation: ATT, sol: SOL_GAS })).rejects.toMatchObject({ code: 'unsupported', message: expect.stringMatching(re) });
    expect(store.state.bridges![i.proposalId]!.mint).toBeUndefined();
  });
  it('mint: bounded cost, one message per bridge, nothing while halted', async () => {
    const { signer, pk, nowRef, i } = await burned(), message = attestedEvm(i);
    await expect(signer.signBridgeMint({ proposalId: i.proposalId, message, attestation: ATT, sol: { ...SOL_GAS, computeUnitLimit: 1_400_000 } })).rejects.toMatchObject({ code: 'unsupported', message: expect.stringMatching(/compute-unit limit/) });
    await expect(signer.signBridgeMint({ proposalId: i.proposalId, message, attestation: ATT, sol: { ...SOL_GAS, computeUnitPrice: '2000001' } })).rejects.toMatchObject({ code: 'unsupported', message: expect.stringMatching(/above the ceiling/) });
    await expect(signer.signBridgeMint({ proposalId: i.proposalId, message, attestation: ATT, sol: { ...SOL_GAS, recentBlockhash: '11111111111111111111111111111111' } })).rejects.toMatchObject({ code: 'unsupported' });
    const j = toSol(nowRef.t); await signer.sign(j, pk.assert(intentHash(j)));
    await signer.signBridgeMint({ proposalId: i.proposalId, message, attestation: ATT, sol: SOL_GAS });
    await expect(signer.signBridgeMint({ proposalId: j.proposalId, message, attestation: ATT, sol: SOL_GAS })).rejects.toMatchObject({ code: 'replay', message: expect.stringMatching(/another bridge/) });
    signer.halt();
    await expect(signer.signBridgeMint({ proposalId: j.proposalId, message: attestedEvm(j, {}, {}, '12'.repeat(32)), attestation: ATT, sol: SOL_GAS })).rejects.toMatchObject({ code: 'policy' });
  });
});

describe('the wallet\'s own USDC token account on Solana', () => {
  const request = (now: number, o: Partial<SolTokenAccountRequest> = {}): SolTokenAccountRequest => ({ v: 1, requestId: pid(), keyId: keys.keyId, network: 'solana', chainRef: NETWORKS.solana!.chainRef, owner: SOL_ME, mint: USDC_SOL, tokenAccount: cctpSolTokenAccount(SOL_ME),
    maxFee: '2048280', createdAt: now, expiresAt: now + 50, policyVersion: 4, sol: { recentBlockhash: BLOCKHASH, lastValidBlockHeight: 300_000_000, computeUnitLimit: 40_000, computeUnitPrice: '100000' }, ...o });
  it('with the passkey: one CreateIdempotent of the wallet\'s own associated USDC account, paid by the wallet', async () => {
    const { signer, store, pk, nowRef } = await setup(), r = request(nowRef.t);
    const out = await signer.signSolTokenAccount(r, pk.assert(solTokenAccountHash(r)));
    const { d, valid } = openTx(out.raw);
    expect(valid).toEqual([true]); expect(d.payer).toBe(SOL_ME); expect(d.instructions.length).toBe(1); expect([...d.instructions[0]!.data]).toEqual([1]);
    expect(d.instructions[0]!.accounts.slice(0, 4)).toEqual([SOL_ME, cctpSolTokenAccount(SOL_ME), SOL_ME, USDC_SOL]);
    expect(out.tokenAccount).toBe(cctpSolTokenAccount(SOL_ME)); expect(store.state.journal.at(-1)!.type).toBe('sol.token_account.ok');
    await expect(signer.signSolTokenAccount(r, pk.assert(solTokenAccountHash(r)))).rejects.toMatchObject({ code: 'replay' });
  });
  it.each([
    ['a token account for someone else', (r: SolTokenAccountRequest) => ({ ...r, owner: OTHER_SOL, tokenAccount: cctpSolTokenAccount(OTHER_SOL) }), 'wrong_source'],
    ['another mint', (r: SolTokenAccountRequest) => ({ ...r, mint: USDT_SOL }), 'unsupported'],
    ['an account that is not the associated one', (r: SolTokenAccountRequest) => ({ ...r, tokenAccount: OTHER_SOL }), 'unsupported'],
    ['a fee ceiling above the policy', (r: SolTokenAccountRequest) => ({ ...r, maxFee: '3000001' }), 'policy'],
    ['a ceiling that does not cover the deposit', (r: SolTokenAccountRequest) => ({ ...r, maxFee: '2000000' }), 'unsupported'],
    ['an expired request', (r: SolTokenAccountRequest) => ({ ...r, createdAt: r.createdAt - 200, expiresAt: r.expiresAt - 200 }), 'policy'],
    ['a window longer than the policy allows', (r: SolTokenAccountRequest) => ({ ...r, expiresAt: r.createdAt + 901 }), 'policy'],
    ['another key id', (r: SolTokenAccountRequest) => ({ ...r, keyId: 'spw-ffffffffffffffff' }), 'wrong_key'],
  ] as [string, (r: SolTokenAccountRequest) => SolTokenAccountRequest, string][])('refuses %s', async (_n, f, code) => {
    const { signer, pk, nowRef } = await setup(), r = f(request(nowRef.t));
    await expect(signer.signSolTokenAccount(r, pk.assert(solTokenAccountHash(r)))).rejects.toMatchObject({ code });
  });
  it('refuses without the passkey, with a passkey over another request, and while halted', async () => {
    const { signer, pk, nowRef } = await setup(), r = request(nowRef.t);
    await expect(signer.signSolTokenAccount(r)).rejects.toMatchObject({ code: 'bad_approval' });
    await expect(signer.signSolTokenAccount(r, pk.assert(solTokenAccountHash(request(nowRef.t))))).rejects.toMatchObject({ code: 'bad_approval' });
    await expect(signer.signSolTokenAccount({ ...r, extra: 1 } as never, pk.assert(solTokenAccountHash(r)))).rejects.toMatchObject({ code: 'bad_request' });
    signer.halt();
    await expect(signer.signSolTokenAccount(r, pk.assert(solTokenAccountHash(r)))).rejects.toMatchObject({ code: 'policy' });
  });
});

describe('over HTTP', () => {
  it('the new routes are authenticated like the others and reach the same checks', async () => {
    const { signer, nowRef } = await setup(), secret = 'h'.repeat(48);
    const srv = createSignerServer(signer, secret).listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const post = async (path: string, body: unknown, auth = true) => { const b = JSON.stringify(body); const r = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { 'x-spw-auth': authHeader(secret, 'POST', path, b) } : {}) }, body: b }); return { status: r.status, json: await r.json() as { error?: string } }; };
    try {
      expect((await post('/bridge/reclaim', { proposalId: pid() }, false)).status).toBe(401);
      expect(await post('/bridge/reclaim', { proposalId: pid(), message: '0x', attestation: '0x', sol: SOL_GAS })).toMatchObject({ status: 404, json: { error: 'not_found' } });
      expect((await post('/sol/token-account', { request: { v: 1 } }, false)).status).toBe(401);
      expect(await post('/sol/token-account', { request: { v: 1, now: nowRef.t } })).toMatchObject({ status: 422, json: { error: 'bad_request' } });
    } finally { srv.close(); }
  });
});
