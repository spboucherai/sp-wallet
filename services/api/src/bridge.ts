/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/bridge.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-18
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

// Cross-chain USDC through Circle CCTP V2 (docs/swap/providers/cctp.md): burn on the source network, attestation by Circle,
// mint on the destination — always from the wallet to the wallet's own address.
// The API prepares, simulates, polls and relays. It cannot make the signer sign anything else than (1) the burn the owner
// approved with a passkey and (2) the one receiveMessage that matches that approved burn (packages/core/src/cctp.ts).
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { decodeEventLog, encodeFunctionData, erc20Abi, hexToBigInt, hexToNumber, numberToHex } from 'viem';
import { z } from 'zod';
import {
  bridgeOf, buildCctpBurnTxs, buildCctpMintTx, CCTP_ABI, CCTP_ENABLED, CCTP_FINALITY_FAST, CCTP_FINALITY_STANDARD, CCTP_MESSAGE_TRANSMITTER, CCTP_MINTER_SHA256, CCTP_PROXY_SHA256,
  CCTP_TOKEN_MESSENGER, CCTP_TOKEN_MINTER, cctpBurnData, cctpMintRetryBytes, cctpUsdc, checkPolicy, EIP1967_IMPLEMENTATION_SLOT, formatUnits, getNetwork, IntentSchema, intentHash,
  parseUnits, toB64u, toHex, verifyCctpMint, type CctpMintGas, type Intent, type NetworkDef,
} from '@spw/core';
import { listCreds } from './auth.ts';
import { adapterFor } from './chains/index.ts';
import { http, rpcAny, rpcQuorum } from './chains/rpc.ts';
import { config, UserError } from './config.ts';
import { audit, sql } from './db.ts';
import { addressFor, signer } from './signer-client.ts';
import { broadcastNow, failure, move, view, type ProposalRow } from './transfers.ts';
import { checkQuoteRef, idemOf, lostRace, QuoteRef, quoteFingerprint, replayOf } from './prepare-common.ts';
import { assetKey } from '@spw/swap';
import { cctpSolUsdc } from '@spw/core';
import { svHold, svTechnical, type SvCode, type SvParams, type SvHold } from './sv-texts.ts';
// v8 — Solana as source or destination (domain 5): everything Solana-specific lives in bridge-sol.ts
import { cctpEnd, type SolBudget } from '@spw/core';
import { advanceSolBurn, advanceSolMint, advanceSolReclaims, bridgeSolRoutes, cctpSolGuards, createSolBurnProposal, solBurnFacts, solDestination, solMintRetryOptions, solQuoteExtras, solStandardMinFee, type SolBridgeInfo } from './bridge-sol.ts';

// TEST ONLY: a fork has no real attestation service. Never set in production (loud warning, like SPW_RPC_OVERRIDE).
const IRIS = process.env.SPW_IRIS_OVERRIDE ?? 'https://iris-api.circle.com';
if (process.env.SPW_IRIS_OVERRIDE) console.warn(`\n*** SPW_IRIS_OVERRIDE is set: CCTP attestations come from ${IRIS}, NOT from Circle. This must never happen in production. ***\n`);

/** Gas units pinned above what real mainnet transactions used (dossier §4): burn 104–114k, mint 154–187k. */
const GAS = { approve: 70_000n, burnUnsimulated: 200_000n, mintPlan: 240_000n, mintCap: 450_000n };
const sha = (hex: string) => createHash('sha256').update(Buffer.from(hex.slice(2), 'hex')).digest('hex');
const eqAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const now = () => Date.now();

export type BridgePhase = 'burn' | 'attesting' | 'ready' | 'mint_sent' | 'mint_failed' | 'done';
export interface BridgeState {
  provider: 'cctp'; toNetwork: string; fromDomain: number; toDomain: number; speed: 'standard' | 'fast'; maxFee: string; minFinalityThreshold: number; expectedSeconds: number; needsApproval: boolean; simulated: boolean;
  destGasNeed: string; phase: BridgePhase;
  /** why the transfer is waiting, when it is (machine code + detail for the owner) */
  hold?: string | null; holdDetail?: string | null;
  /** v11: the detail as a code of sv-texts.ts + its parameters (the UI translates it; `holdDetail` stays the English sentence) */
  holdCode?: string | null; holdParams?: SvParams | null;
  polls: number; nextAt: number; attestingSince?: number; irisStatus?: string | null; delayReason?: string | null;
  message?: string; attestation?: string; nonce?: string; messageHash?: string; feeExecuted?: string; minted?: string; expirationBlock?: string;
  /** gas parameters are stored BEFORE the signer is asked, so that a crash in between repeats the identical request */
  mint?: { evm?: CctpMintGas; /** v8: a mint on Solana */ sol?: SolBudget; txid?: string; raw?: string; sentAt?: number; lastBroadcastAt?: number; signatures?: number };
  retry?: { evm?: CctpMintGas; sol?: SolBudget; expiresAt: number };
  /** v8: Solana side of a Solana ↔ EVM transfer (event-account deposit and its reclaim; destination token account) */
  sol?: SolBridgeInfo;
  mintedBy?: 'wallet' | 'other'; mintTxid?: string | null; doneAt?: number;
  /** hash of a Fast message whose attestation expired: Circle's answer is ignored until it carries a new one */
  expiredHash?: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Chain guards

/** Pinned proxies, pinned implementations behind them, pinned minter — on every RPC source — and a wallet address without code. */
export async function cctpGuards(n: NetworkDef, me: string): Promise<void> {
  const pin = CCTP_ENABLED[n.id];
  if (!pin) throw new UserError('bridge_not_enabled', `CCTP transfers are not enabled on ${n.name}`, 422);
  const q = <T>(m: string, p: unknown[]) => rpcQuorum<T>(n.rpc, m, p);
  const changed = (what: string) => new UserError('contract_changed', `${what} on ${n.name} is not the reviewed one (Circle may have upgraded it); CCTP transfers are refused until it is reviewed again`, 503);
  for (const [name, proxy, impl] of [['TokenMessengerV2', CCTP_TOKEN_MESSENGER, pin.messengerImpl], ['MessageTransmitterV2', CCTP_MESSAGE_TRANSMITTER, pin.transmitterImpl]] as const) {
    if (sha(await q<string>('eth_getCode', [proxy, 'latest'])) !== CCTP_PROXY_SHA256) throw changed(`the ${name} proxy`);
    const slot = await q<string>('eth_getStorageAt', [proxy, EIP1967_IMPLEMENTATION_SLOT, 'latest']);
    if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(slot) || !eqAddr('0x' + slot.slice(26), impl.address)) throw changed(`the ${name} implementation address`);
    if (sha(await q<string>('eth_getCode', [impl.address, 'latest'])) !== impl.codeSha256) throw changed(`the ${name} implementation`);
  }
  if (sha(await q<string>('eth_getCode', [CCTP_TOKEN_MINTER, 'latest'])) !== CCTP_MINTER_SHA256) throw changed('the TokenMinterV2');
  // an EIP-7702 delegation on the wallet address would run someone's code on every coin received
  if ((await q<string>('eth_getCode', [me, 'latest'])) !== '0x') throw new UserError('account_has_code', 'this wallet address carries code (delegation); transfers are refused', 503);
}

async function gasPrice(n: NetworkDef): Promise<{ baseFee: bigint; tip: bigint; maxFeePerGas: bigint }> {
  const block = await rpcAny<{ baseFeePerGas?: `0x${string}` }>(n.rpc, 'eth_getBlockByNumber', ['latest', false]);
  if (!block.baseFeePerGas) throw new UserError('rpc_degraded', 'network did not report a base fee', 503);
  const baseFee = hexToBigInt(block.baseFeePerGas);
  let tip = 1_000_000n; try { tip = hexToBigInt(await rpcAny<`0x${string}`>(n.rpc, 'eth_maxPriorityFeePerGas', [])); } catch { /* floor */ }
  if (n.id === 'polygon' && tip < 30_000_000_000n) tip = 30_000_000_000n; // Polygon PoS enforces a 30 gwei minimum tip
  return { baseFee, tip, maxFeePerGas: baseFee * 2n + tip };
}
const nativeBalance = async (n: NetworkDef, a: string) => hexToBigInt(await rpcAny<`0x${string}`>(n.rpc, 'eth_getBalance', [a, 'latest']));

// ---------------------------------------------------------------------------------------------------------------------
// Circle's attestation service (Iris): public, keyless, read-only for us except the re-attestation request of an expired Fast message.

const FeeResp = z.array(z.object({ finalityThreshold: z.number().int(), minimumFee: z.number().min(0).max(100) }).passthrough()).min(1).max(8);
const MsgResp = z.object({ messages: z.array(z.object({ status: z.string().max(60), message: z.string().max(4000).nullish(), attestation: z.string().max(2000).nullish(), delayReason: z.string().max(200).nullish(), cctpVersion: z.number().nullish() }).passthrough()).max(20) }).passthrough();

export async function iris(path: string, init?: RequestInit): Promise<{ status: number; json: unknown }> {
  let r: Response;
  try { r = await http(IRIS + path, init); } catch { throw new UserError('provider_unavailable', 'Circle\'s attestation service did not answer', 503); }
  return { status: r.status, json: await r.json().catch(() => null) };
}

/** CCTP fee (USDC base units, rounded up) Circle currently asks for this route and speed. bps may be fractional (1.3). */
export async function cctpFee(n: NetworkDef, dst: NetworkDef, amount: bigint, speed: 'standard' | 'fast'): Promise<bigint> {
  const r = await iris(`/v2/burn/USDC/fees/${cctpEnd(n.id)!.domain}/${cctpEnd(dst.id)!.domain}`);
  const p = FeeResp.safeParse(r.json);
  if (r.status !== 200 || !p.success) throw new UserError('provider_bad_answer', 'Circle\'s fee schedule could not be read', 502);
  const e = p.data.find((x) => x.finalityThreshold === (speed === 'fast' ? CCTP_FINALITY_FAST : CCTP_FINALITY_STANDARD));
  if (!e) throw new UserError('provider_bad_answer', 'Circle\'s fee schedule has no entry for this speed', 502);
  const micro = BigInt(Math.round(e.minimumFee * 10_000)); // bps × 10⁴
  let fee = (amount * micro + 99_999_999n) / 100_000_000n;
  if (speed === 'standard') { // newer messenger builds can enforce an on-chain minimum for Standard (HyperEVM has the switch, at 0 today)
    const min = n.family === 'sol' ? await solStandardMinFee(n, amount) // v8: the Solana program's own minimum (token_messenger.min_fee, 0 today)
      : await rpcAny<`0x${string}`>(n.rpc, 'eth_call', [{ to: CCTP_TOKEN_MESSENGER, data: encodeFunctionData({ abi: CCTP_ABI, functionName: 'getMinFeeAmount', args: [amount] }) }, 'latest']).then(hexToBigInt, () => 0n);
    if (min > fee) fee = min;
  }
  return fee;
}

export async function fastAllowance(): Promise<bigint | null> {
  const r = await iris('/v2/fastBurn/USDC/allowance').catch(() => null);
  const a = (r?.json as { allowance?: unknown } | null)?.allowance;
  return typeof a === 'number' && a >= 0 ? BigInt(Math.floor(a)) * 1_000_000n : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Preparation

export async function destinationGas(dst: NetworkDef, me: string): Promise<{ need: bigint; balance: bigint; price: Awaited<ReturnType<typeof gasPrice>> }> {
  const price = await gasPrice(dst);
  return { need: GAS.mintPlan * price.maxFeePerGas, balance: await nativeBalance(dst, me), price };
}
export const noGas = (dst: NetworkDef, need: bigint, have: bigint) => new UserError('destination_gas',
  `the wallet holds ${formatUnits(have, dst.native.decimals)} ${dst.native.symbol} on ${dst.name}; about ${formatUnits(need, dst.native.decimals)} is needed there to receive the USDC. Nothing was burned: add ${dst.native.symbol} on ${dst.name} first`, 422);

const Create = z.strictObject({ fromNetwork: z.string().max(24), toNetwork: z.string().max(24), amount: z.string().min(1).max(60), speed: z.enum(['standard', 'fast']).default('standard'), /** v11: the option the owner selected (prepare-common.ts) */ quote: QuoteRef.optional() });
const Quote = z.object({ from: z.string().max(24), to: z.string().max(24), amount: z.string().min(1).max(60) });

/** A CCTP transfer as a quote: USDC in, USDC out less Circle's fee — the fee is a ceiling, so expected = guaranteed. Tolerance 0. */
export const cctpKeys = (from: string, to: string) => ({ fromKey: assetKey({ network: from, asset: cctpEndUsdc(from) }), toKey: assetKey({ network: to, asset: cctpEndUsdc(to) }) });
const cctpEndUsdc = (network: string) => (getNetwork(network).family === 'sol' ? cctpSolUsdc().id : cctpUsdc(network).id);
export const cctpFirm = (from: string, to: string, amount: bigint, fee: bigint) => ({ executor: 'cctp', ...cctpKeys(from, to), amountIn: amount, slippageBps: 0, firmOut: amount - fee, firmMinOut: amount - fee, toDecimals: 6, toSymbol: 'USDC' });
/** The reference of one option of /bridge/quote, in the same shape a route of the swap stream carries. */
export const cctpQuoteRef = (from: string, to: string, amount: bigint, fee: bigint, speed: string, quotedAt: number) => {
  const out = (amount - fee).toString();
  return { id: `cctp-${speed}-${from}-${to}-${amount}`, provider: 'cctp', amountOut: out, minAmountOut: out, quotedAt,
    fingerprint: quoteFingerprint({ provider: 'cctp', ...cctpKeys(from, to), amountIn: amount.toString(), slippageBps: 0, amountOut: out, minAmountOut: out }) };
};

function route(from: string, to: string): { n: NetworkDef; dst: NetworkDef } {
  if (!cctpEnd(from) || !cctpEnd(to)) throw new UserError('bridge_not_enabled', 'CCTP transfers are not enabled between these networks', 422); // v8: the seven EVM networks and Solana
  if (from === to) throw new UserError('same_network', 'choose two different networks');
  return { n: getNetwork(from), dst: getNetwork(to) };
}

export function bridgeRoutes(app: FastifyInstance): void {
  app.get('/api/v1/bridge/execution', async () => ({ enabled: true, provider: 'cctp', asset: 'USDC', networks: [...Object.keys(CCTP_ENABLED), 'solana'], messenger: CCTP_TOKEN_MESSENGER, transmitter: CCTP_MESSAGE_TRANSMITTER }));

  // What a transfer would cost and need, for both speeds. Signs nothing, prepares nothing.
  app.get('/api/v1/bridge/quote', async (req) => {
    const q = Quote.parse(req.query); const { n, dst } = route(q.from, q.to);
    const usdc = { decimals: 6 }; let amount: bigint; // USDC has six decimals on every CCTP network, Solana included
    try { amount = parseUnits(q.amount, usdc.decimals); } catch (e) { throw new UserError('bad_amount', (e as Error).message); }
    if (amount <= 0n) throw new UserError('bad_amount', 'amount must be greater than zero');
    const st = await signer.status(), pin = cctpEnd(n.id)!;
    const destMe = addressFor(st, dst.id); // v8: the wallet's own address on the destination (the same one between EVM networks)
    const [dg, stdFee, fastFee, allowance, solana] = await Promise.all([dst.family === 'sol' ? solDestination(dst, destMe) : destinationGas(dst, destMe), cctpFee(n, dst, amount, 'standard'), pin.fastSource ? cctpFee(n, dst, amount, 'fast') : Promise.resolve(null), pin.fastSource ? fastAllowance() : Promise.resolve(null),
      solQuoteExtras(n, dst, st)]);
    const quotedAt = now();
    const opt = (speed: 'standard' | 'fast', fee: bigint, seconds: number, available: boolean) => ({ speed, available, fee: fee.toString(), feeDisplay: formatUnits(fee, usdc.decimals), minReceive: (amount - fee).toString(), minReceiveDisplay: formatUnits(amount - fee, usdc.decimals), seconds,
      /** v11: what to send back as `quote` when preparing this option */ quote: fee < amount ? cctpQuoteRef(n.id, dst.id, amount, fee, speed, quotedAt) : null });
    return { from: n.id, to: dst.id, fromName: n.name, toName: dst.name, amount: amount.toString(), symbol: 'USDC',
      options: [opt('standard', stdFee, pin.standardSeconds, stdFee < amount), ...(fastFee !== null && pin.fastSeconds !== null ? [opt('fast', fastFee, pin.fastSeconds, fastFee < amount && fastFee > 0n && allowance !== null && allowance >= amount)] : [])],
      destinationGas: { symbol: dst.native.symbol, need: dg.need.toString(), needDisplay: formatUnits(dg.need, dst.native.decimals), balance: dg.balance.toString(), balanceDisplay: formatUnits(dg.balance, dst.native.decimals), enough: dg.balance >= dg.need },
      ...(solana ? { solana } : {}) };
  });

  // Prepare a firm transfer and offer it for passkey approval. The approval covers both legs.
  app.post('/api/v1/bridge/proposals', async (req) => {
    if (!/^[A-Za-z0-9-]{16,64}$/.test(String(req.headers['idempotency-key'] ?? ''))) throw new UserError('idempotency', 'Idempotency-Key header required');
    const b = Create.parse(req.body), idem = idemOf(req.headers, 'bridge', b);
    const again = await replayOf(idem); if (again) return again; // v11 (B4): the same key answers the same transfer
    const { n, dst } = route(b.fromNetwork, b.toNetwork);
    if (n.family === 'sol') return createSolBurnProposal({ n, dst, amount: b.amount, speed: b.speed, quote: b.quote }, idem); // v8: the burn is a Solana transaction (bridge-sol.ts)
    const toSol = dst.family === 'sol'; // v8: the mint will be a Solana transaction, to the wallet's own USDC token account
    const usdc = cctpUsdc(n.id), pin = CCTP_ENABLED[n.id]!, dpin = cctpEnd(dst.id)!;
    let amount: bigint;
    try { amount = parseUnits(b.amount, usdc.decimals); } catch (e) { throw new UserError('bad_amount', (e as Error).message); }
    if (amount <= 0n) throw new UserError('bad_amount', 'amount must be greater than zero');
    if (b.speed === 'fast' && !pin.fastSource) throw new UserError('fast_unavailable', `Circle does not offer Fast Transfer from ${n.name}; Standard takes about ${pin.standardSeconds} s there`, 422);
    const st = await signer.status(true);
    if (st.halted) throw new UserError('halted', 'emergency halt is active', 423);
    const me = addressFor(st, n.id);
    const destMe = addressFor(st, dst.id);
    if (!toSol && destMe !== me) throw new UserError('unsupported_network', 'the destination network is not served by the same address', 503);
    const [busy] = await sql<{ id: string }[]>`select id from proposals where network = ${n.id} and state in ('approved', 'signed', 'broadcast') limit 1`;
    if (busy) throw new UserError('pending_tx', 'a previous transfer or swap on this network is not confirmed yet; wait for it before starting another', 409);
    await cctpGuards(n, me);
    if (toSol) await cctpSolGuards(dst, destMe); else await cctpGuards(dst, me);
    const bal = await adapterFor(n.id).balances(me);
    if (bal[usdc.id] === undefined) throw new UserError('rpc_degraded', 'token balance could not be read; transfer refused', 503);
    if (bal[usdc.id]! < amount) throw new UserError('insufficient_funds', 'insufficient USDC balance');
    // the destination must be able to pay for the mint BEFORE anything is burned
    // v8, toward Solana: the wallet's USDC token account must already exist (the burn names it and cannot be redirected), and SOL must cover the mint
    const sd = toSol ? await solDestination(dst, destMe) : null;
    if (sd && !sd.tokenAccount.exists) throw new UserError('token_account_missing', `the wallet has no USDC token account on ${dst.name} yet (${sd.tokenAccount.address}). Nothing was burned: create it first, then start the transfer again`, 422);
    const dg = sd ?? await destinationGas(dst, me);
    if (dg.balance < dg.need) throw noGas(dst, dg.need, dg.balance);
    if (dg.need > BigInt(st.policy.maxFee[dst.id] ?? '0')) throw new UserError('policy', `the network fee on ${dst.name} is above the signer's fee ceiling right now; the mint could not be signed`, 422);
    const fee = await cctpFee(n, dst, amount, b.speed);
    if (b.speed === 'fast') {
      if (fee === 0n) throw new UserError('fast_unavailable', 'Circle quotes no Fast fee for this route right now; use Standard', 422);
      const allowance = await fastAllowance();
      if (allowance === null || allowance < amount) throw new UserError('fast_unavailable', 'Circle\'s Fast Transfer allowance does not cover this amount right now; use Standard', 422);
    }
    if (fee >= amount) throw new UserError('bad_amount', 'the amount does not cover Circle\'s fee');
    const quote = checkQuoteRef(b.quote, cctpFirm(n.id, dst.id, amount, fee)); // v11 (B6): Circle's fee now against the option that was displayed
    const allowance = hexToBigInt(await rpcAny<`0x${string}`>(n.rpc, 'eth_call', [{ to: usdc.id, data: encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [me as `0x${string}`, CCTP_TOKEN_MESSENGER as `0x${string}`] }) }, 'latest']));
    const needApprove = allowance < amount;
    const nonce = hexToNumber(await rpcQuorum<`0x${string}`>(n.rpc, 'eth_getTransactionCount', [me, 'pending']));
    if (nonce !== hexToNumber(await rpcAny<`0x${string}`>(n.rpc, 'eth_getTransactionCount', [me, 'latest']))) throw new UserError('pending_tx', 'a previous transaction from this address is still pending on this network', 409);
    const price = await gasPrice(n), t0 = Math.floor(now() / 1000), id = randomUUID();
    const draft = (gas: bigint): Intent => IntentSchema.parse({
      v: 1, proposalId: id, keyId: st.keyId, network: n.id, chainRef: n.chainRef, asset: usdc.id, symbol: 'USDC', decimals: usdc.decimals, amount: amount.toString(), from: me, to: me,
      maxFee: ((gas + (needApprove ? GAS.approve : 0n)) * price.maxFeePerGas).toString(), createdAt: t0, expiresAt: t0 + 75, policyVersion: st.policy.version,
      bridge: { provider: 'cctp', toNetwork: dst.id, toDomain: dpin.domain, maxFee: fee.toString(), minFinalityThreshold: b.speed === 'fast' ? CCTP_FINALITY_FAST : CCTP_FINALITY_STANDARD,
        messenger: CCTP_TOKEN_MESSENGER, transmitter: CCTP_MESSAGE_TRANSMITTER, approveGas: (needApprove ? GAS.approve : 0n).toString(), ...(toSol ? { recipient: destMe } : {}) },
      evm: { nonce, gasLimit: gas.toString(), maxFeePerGas: price.maxFeePerGas.toString(), maxPriorityFeePerGas: price.tip.toString() },
    });
    let gas = GAS.burnUnsimulated, simulated = false;
    if (!needApprove) { // the node's own estimate is also the simulation; with an approval pending the burn is simulated again once it is mined
      const est = await rpcAny<`0x${string}`>(n.rpc, 'eth_estimateGas', [{ from: me, to: CCTP_TOKEN_MESSENGER, data: cctpBurnData(draft(gas)) }]).then(hexToBigInt, (e: Error) => { throw new UserError('simulation_failed', `the burn would fail right now: ${e.message.slice(0, 120)}`, 422); });
      gas = (est * 13n) / 10n + 20_000n; simulated = true;
    }
    const intent = draft(gas), maxFee = BigInt(intent.maxFee);
    try { buildCctpBurnTxs(intent); } catch (e) { throw new UserError('simulation_failed', (e as Error).message, 422); } // exactly what the signer will rebuild
    if ((bal.native ?? 0n) < maxFee) throw new UserError('insufficient_gas', `not enough ${n.native.symbol} on ${n.name} to pay the network fee`);
    const verdict = checkPolicy(st.policy, intent, BigInt(st.spentToday[`${n.id}:USDC`] ?? '0'), t0, st.halted);
    if (!verdict.ok) throw new UserError('policy', verdict.reason, 422);
    const hash = intentHash(intent);
    const state: BridgeState = { provider: 'cctp', toNetwork: dst.id, fromDomain: pin.domain, toDomain: dpin.domain, speed: b.speed, maxFee: fee.toString(), minFinalityThreshold: intent.bridge!.minFinalityThreshold,
      expectedSeconds: b.speed === 'fast' ? pin.fastSeconds! : pin.standardSeconds, needsApproval: needApprove, simulated, destGasNeed: dg.need.toString(), phase: 'burn', polls: 0, nextAt: 0,
      ...(sd ? { sol: { recipient: destMe, tokenAccount: sd.tokenAccount.address, nonceRent: sd.nonceRent.toString() } } : {}) };
    const [p] = await sql<ProposalRow[]>`insert into proposals (id, idempotency_key, request_hash, quote_ref, state, kind, network, asset, symbol, decimals, amount, from_addr, to_addr, note, fee_estimate, max_fee, warnings, intent, intent_hash, bridge, expires_at)
      values (${id}, ${idem.key}, ${idem.hash}, ${quote ? sql.json(quote as never) : null}, 'pending_approval', 'bridge', ${n.id}, ${usdc.id}, 'USDC', ${usdc.decimals}, ${amount.toString()}, ${me}, ${me}, ${`bridge → ${dst.name}`}, ${((gas + (needApprove ? GAS.approve : 0n)) * (price.baseFee + price.tip)).toString()}, ${maxFee.toString()},
        ${sql.json(needApprove ? ['swap_needs_approval'] : [])}, ${sql.json(intent as never)}, ${toHex(hash)}, ${sql.json(state as never)}, ${new Date(intent.expiresAt * 1000)})
      on conflict (idempotency_key) do nothing returning *`;
    if (!p) return lostRace(idem);
    await audit('bridge.prepared', 'owner', { id, from: n.id, to: dst.id, amount: amount.toString(), speed: b.speed, cctpMaxFee: fee.toString(), hash: toHex(hash) });
    const creds = await listCreds();
    const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', challenge: new Uint8Array(hash), timeout: 70_000, allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as never })) });
    if (options.challenge !== toB64u(hash)) throw new Error('challenge binding mismatch');
    return { proposal: view(p), intent: p.intent, options };
  });

  const load = async (id: string): Promise<ProposalRow> => {
    const [p] = z.uuid().safeParse(id).success ? await sql<ProposalRow[]>`select * from proposals where id = ${id} and kind = 'bridge'` : [];
    if (!p) throw new UserError('not_found', 'transfer not found', 404);
    return p;
  };

  // "Finish": run the next step now instead of waiting for the worker. Safe to call at any time, any number of times.
  app.post('/api/v1/bridge/proposals/:id/finish', async (req) => {
    const p = await load((req.params as { id: string }).id);
    if (p.state === 'signed') return view(await advanceBridgeBurn(p));
    return view(await advanceBridge(p, { manual: true }));
  });

  // A mint transaction that reverted or was replaced can only be signed again with the owner's passkey.
  app.post('/api/v1/bridge/proposals/:id/retry-mint/options', async (req) => {
    let p = await load((req.params as { id: string }).id);
    p = await advanceBridge(p, { manual: true });
    const b = p.bridge!;
    if (b.phase !== 'mint_failed' || !b.message || !b.messageHash) throw new UserError('bad_state', 'this transfer does not need a new mint signature', 409);
    if (getNetwork(b.toNetwork).family === 'sol') return solMintRetryOptions(p, b); // v8
    const evm = await mintGas(p, b);
    if ('hold' in evm) throw new UserError(evm.hold, evm.detail, 422);
    p = await save(p, { ...b, retry: { evm: evm.evm, expiresAt: now() + 120_000 } });
    const challenge = new Uint8Array(createHash('sha256').update(cctpMintRetryBytes(p.id, b.messageHash, evm.evm)).digest());
    const creds = await listCreds();
    const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', challenge, timeout: 100_000, allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as never })) });
    return { proposal: view(p), options, approval: { proposalId: p.id, messageHash: b.messageHash, gas: evm.evm } };
  });
  app.post('/api/v1/bridge/proposals/:id/retry-mint', async (req) => {
    const body = z.object({ assertion: z.record(z.string(), z.unknown()) }).parse(req.body);
    let p = await load((req.params as { id: string }).id);
    const b = p.bridge!;
    if (b.phase !== 'mint_failed' || !b.retry || b.retry.expiresAt < now() || !b.message || !b.attestation) throw new UserError('bad_state', 'ask for a new approval first', 409);
    const signed = await signer.bridgeMint({ proposalId: p.id, message: b.message, attestation: b.attestation, ...(b.retry.sol ? { sol: b.retry.sol } : { evm: b.retry.evm! }), assertion: body.assertion });
    p = await save(p, { ...b, retry: undefined, ...NO_HOLD, phase: 'mint_sent', mint: { ...(b.retry.sol ? { sol: b.retry.sol } : { evm: b.retry.evm }), txid: signed.txid, raw: signed.raw, sentAt: now(), lastBroadcastAt: now(), signatures: (b.mint?.signatures ?? 1) + 1 } });
    await audit('bridge.mint_resigned', 'owner', { id: p.id, txid: signed.txid });
    if (config.broadcast) await adapterFor(b.toNetwork).broadcast(signed.raw).catch(() => {});
    return view(p);
  });
  bridgeSolRoutes(app, load); // v8: reclaim of the event-account deposit, creation of the wallet's USDC token account on Solana
}

// ---------------------------------------------------------------------------------------------------------------------
// Leg 1 after signing: mine the exact-amount approval if there is one, simulate the burn against the real state, relay it.

export async function advanceBridgeBurn(p: ProposalRow): Promise<ProposalRow> {
  if (p.kind !== 'bridge' || p.state !== 'signed' || !p.raw || !p.intent) return p;
  if (getNetwork(p.network).family === 'sol') return advanceSolBurn(p); // v8
  const n = getNetwork(p.network), a = adapterFor(p.network);
  const fail = (code: SvCode, params?: SvParams) => move(p, 'failed', failure(code, params));
  if (!config.broadcast) return broadcastNow(p);
  if (p.expires_at && Date.now() - p.expires_at.getTime() > 8 * 60_000) return fail('bridge_late');
  if (p.pre_raw && p.pre_state !== 'confirmed') {
    await a.broadcast(p.pre_raw).catch(() => {});
    const rc = await rpcAny<{ status: `0x${string}` } | null>(n.rpc, 'eth_getTransactionReceipt', [p.pre_txid]).catch(() => null);
    if (!rc) { if (p.pre_state !== 'sent') await sql`update proposals set pre_state = 'sent', updated_at = now() where id = ${p.id}`; return p; }
    if (hexToNumber(rc.status) !== 1) return fail('bridge_approval_reverted');
    await sql`update proposals set pre_state = 'confirmed', updated_at = now() where id = ${p.id}`;
    await audit('bridge.approval_confirmed', 'chain', { id: p.id, txid: p.pre_txid });
  }
  // last gate before the burn leaves: it must succeed against the current chain state
  const sim = await rpcAny<string>(n.rpc, 'eth_call', [{ from: p.from_addr, to: CCTP_TOKEN_MESSENGER, data: cctpBurnData(p.intent) }, 'latest']).then(() => null, (e: Error & { rpcCode?: number }) => (e.rpcCode !== undefined ? e.message : 'unreachable'));
  if (sim === 'unreachable') return p; // try again on the next tick
  if (sim !== null) return fail(p.pre_raw ? 'burn_would_revert_approved' : 'burn_would_revert', { detail: sim.slice(0, 100) });
  return broadcastNow(p);
}

// ---------------------------------------------------------------------------------------------------------------------
// Leg 2: attestation, then mint. Every step is idempotent and driven only by what is stored in the row, so it resumes after
// a restart, days later, from the worker or from the "finish" button.

export async function save(p: ProposalRow, b: BridgeState): Promise<ProposalRow> {
  const [r] = await sql<ProposalRow[]>`update proposals set bridge = ${sql.json(b as never)}, updated_at = now() where id = ${p.id} returning *`;
  return r!;
}
/** No hold: clears the code, the detail and their parameters together. */
export const NO_HOLD = { hold: null, holdDetail: null, holdCode: null, holdParams: null } as const;
/** Wait with a reason. `h` is a catalogued hold (sv-texts.ts), or a hold code with a free technical message kept as data. */
export const wait = (p: ProposalRow, b: BridgeState, h: string | SvHold, detail: string, ms: number) => save(p, { ...b, ...(typeof h === 'string' ? svTechnical(h, detail) : h), nextAt: now() + ms });
/** 5 s at first, then slower, never above five minutes — and never giving up: burned funds stay mintable for ever. */
const backoff = (polls: number, speed: string) => Math.min(300_000, (speed === 'fast' ? 4_000 : 15_000) * Math.ceil((polls + 1) / 8));

/** The block number the destination's contracts compare a Fast attestation's `expirationBlock` with, or null when it cannot be read.
 *  On Arbitrum the EVM's `block.number` is the Ethereum (L1) block number, while `eth_blockNumber` answers the L2 height, which is
 *  hundreds of millions ahead: comparing with it made every Fast transfer to Arbitrum look expired and never mint. Multicall3's
 *  getBlockNumber() returns what a contract sees. */
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11', GET_BLOCK_NUMBER = '0x42cbb15c';
export async function expiryHead(dst: NetworkDef): Promise<bigint | null> {
  if (dst.id !== 'arbitrum') return rpcAny<`0x${string}`>(dst.rpc, 'eth_blockNumber', []).then(hexToBigInt, () => null);
  return rpcAny<`0x${string}`>(dst.rpc, 'eth_call', [{ to: MULTICALL3, data: GET_BLOCK_NUMBER }, 'latest']).then((h) => (/^0x[0-9a-f]{64}$/i.test(h) ? hexToBigInt(h) : null), () => null);
}

async function usedNonce(dst: NetworkDef, nonce: string): Promise<boolean> {
  const r = await rpcQuorum<`0x${string}`>(dst.rpc, 'eth_call', [{ to: CCTP_MESSAGE_TRANSMITTER, data: encodeFunctionData({ abi: CCTP_ABI, functionName: 'usedNonces', args: [`0x${nonce}`] }) }, 'latest']);
  return hexToBigInt(r) !== 0n;
}

/** Someone else submitted the mint (it is permissionless): look for its transaction, best effort, in recent blocks. */
async function findMint(dst: NetworkDef, nonce: string): Promise<string | null> {
  try {
    const head = hexToNumber(await rpcAny<`0x${string}`>(dst.rpc, 'eth_blockNumber', []));
    const logs = await rpcAny<{ transactionHash: string; topics: string[] }[]>(dst.rpc, 'eth_getLogs', [{ address: CCTP_MESSAGE_TRANSMITTER, fromBlock: numberToHex(Math.max(0, head - 2000)), toBlock: 'latest', topics: [null, null, `0x${nonce}`] }]);
    return logs[0]?.transactionHash ?? null;
  } catch { return null; }
}

export async function done(p: ProposalRow, b: BridgeState, by: 'wallet' | 'other', txid: string | null): Promise<ProposalRow> {
  const minted = b.minted ?? null;
  await sql`update proposals set out_amount = ${minted} where id = ${p.id}`;
  const r = await save(p, { ...b, phase: 'done', ...NO_HOLD, retry: undefined, mintedBy: by, mintTxid: txid, doneAt: now() });
  await audit('bridge.done', 'chain', { id: p.id, to: b.toNetwork, minted, feeExecuted: b.feeExecuted ?? null, mintedBy: by, txid });
  return r;
}

/** v8: the wallet's address on the destination network — the source address between EVM networks, the named recipient when Solana is one end. */
const destAddr = (p: ProposalRow): string => p.intent?.bridge?.recipient ?? p.from_addr;
/** Gas parameters for a mint right now, or the reason why it cannot be sent yet. */
async function mintGas(p: ProposalRow, b: BridgeState): Promise<{ evm: CctpMintGas } | { hold: string; detail: string; sv: SvHold }> {
  const held = (sv: SvHold) => ({ hold: sv.hold, detail: sv.holdDetail, sv });
  const dst = getNetwork(b.toNetwork), me = destAddr(p);
  const [busy] = await sql<{ id: string }[]>`select id from proposals where network = ${dst.id} and state in ('approved', 'signed', 'broadcast') limit 1`;
  if (busy) return held(svHold('destination_busy', 'hold_destination_busy', { net: dst.name }));
  const nonce = hexToNumber(await rpcQuorum<`0x${string}`>(dst.rpc, 'eth_getTransactionCount', [me, 'pending']));
  if (nonce !== hexToNumber(await rpcAny<`0x${string}`>(dst.rpc, 'eth_getTransactionCount', [me, 'latest']))) return held(svHold('destination_busy', 'hold_destination_pending', { net: dst.name }));
  const data = encodeFunctionData({ abi: CCTP_ABI, functionName: 'receiveMessage', args: [b.message as `0x${string}`, b.attestation as `0x${string}`] });
  const est = await rpcAny<`0x${string}`>(dst.rpc, 'eth_estimateGas', [{ from: me, to: CCTP_MESSAGE_TRANSMITTER, data }]).then(hexToBigInt, (e: Error & { rpcCode?: number }) => { if (e.rpcCode === undefined) throw e; return e.message; });
  if (typeof est === 'string') return held(svHold('mint_would_fail', 'hold_mint_would_fail', { net: dst.name, detail: est.slice(0, 140) }));
  let gas = (est * 13n) / 10n + 20_000n; if (gas > GAS.mintCap) gas = GAS.mintCap;
  const price = await gasPrice(dst), st = await signer.status();
  const ceiling = BigInt(st.policy.maxFee[dst.id] ?? '0');
  let maxFeePerGas = price.maxFeePerGas;
  if (gas * maxFeePerGas > ceiling) maxFeePerGas = ceiling / gas; // stay under the signer's ceiling when the current price still fits
  if (maxFeePerGas < price.baseFee + price.tip) return held(svHold('fee_above_policy', 'hold_fee_above_policy', { net: dst.name }));
  const balance = await nativeBalance(dst, me);
  if (balance < gas * maxFeePerGas) return held(svHold('destination_gas', 'hold_destination_gas', { sym: dst.native.symbol, net: dst.name, need: formatUnits(gas * maxFeePerGas, 18), have: formatUnits(balance, 18) }));
  return { evm: { nonce, gasLimit: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: (price.tip > maxFeePerGas ? maxFeePerGas : price.tip).toString() } };
}

export async function advanceBridge(p: ProposalRow, o: { manual?: boolean } = {}): Promise<ProposalRow> {
  if (p.kind !== 'bridge' || !p.bridge || !p.intent || !p.txid) return p;
  let b = p.bridge;
  if (b.phase === 'done' || !['confirming', 'finalized', 'reorged'].includes(p.state)) return p; // the burn must be mined and successful first
  if (!o.manual && b.nextAt > now()) return p;
  const dst = getNetwork(b.toNetwork), bridge = bridgeOf(p.intent);

  if (b.phase === 'burn') { p = await save(p, b = { ...b, phase: 'attesting', attestingSince: now(), polls: 0, nextAt: 0 }); await audit('bridge.burned', 'chain', { id: p.id, txid: p.txid }); }
  // v8, a burn on Solana: read when its event account was created — the refundable deposit can be reclaimed five days later
  if (getNetwork(p.network).family === 'sol' && b.sol?.eventAccount && !b.sol.createdAt) { const f = await solBurnFacts(p, b).catch(() => null); if (f) p = await save(p, b = f); }

  if (b.phase === 'attesting') {
    let r; try { r = await iris(`/v2/messages/${b.fromDomain}?transactionHash=${p.txid}`); } catch (e) { return wait(p, b, 'attestation_service', (e as Error).message, 20_000); }
    const parsed = MsgResp.safeParse(r.json);
    const late = now() - (b.attestingSince ?? now()) > (b.expectedSeconds * 3 + 1800) * 1000;
    const pending = (status: string, reason: string | null) => save(p, { ...b, polls: b.polls + 1, nextAt: now() + backoff(b.polls, b.speed), irisStatus: status, delayReason: reason,
      ...(late ? svHold('attestation_late', 'hold_attestation_late') : NO_HOLD) });
    if (r.status === 404 || !parsed.success) return pending(r.status === 404 ? 'not_found' : `http_${r.status}`, null);
    // the answer is untrusted: keep only a message that is exactly the approved burn (the signer re-checks the same way)
    let hit: { message: string; attestation: string; v: ReturnType<typeof verifyCctpMint> } | null = null, why = '';
    // a message set aside as expired is taken back when it is in fact still valid at the destination (wrongly judged expired earlier)
    const exHead = b.expiredHash && dst.family !== 'sol' ? await expiryHead(dst) : null;
    for (const m of parsed.data.messages) {
      if (m.status !== 'complete' || !m.message || !m.attestation) continue;
      try { const v = verifyCctpMint(bridge, m.message, m.attestation); if (v.messageHash === b.expiredHash && !(exHead !== null && exHead < v.msg.body.expirationBlock)) continue; hit = { message: m.message.toLowerCase(), attestation: m.attestation.toLowerCase(), v }; break; } catch (e) { why = (e as Error).message; }
    }
    if (!hit) {
      const m0 = parsed.data.messages[0];
      if (why) return save(p, { ...b, polls: b.polls + 1, nextAt: now() + 120_000, irisStatus: 'mismatch', ...svHold('message_mismatch', 'hold_message_mismatch', { detail: why.slice(0, 160) }) });
      return pending(m0?.status ?? 'empty', m0?.delayReason ?? null);
    }
    p = await save(p, b = { ...b, phase: 'ready', ...NO_HOLD, irisStatus: 'complete', delayReason: null, nextAt: 0, message: hit.message, attestation: hit.attestation, nonce: hit.v.msg.nonce, messageHash: hit.v.messageHash,
      feeExecuted: hit.v.msg.body.feeExecuted.toString(), minted: hit.v.minted.toString(), expirationBlock: hit.v.msg.body.expirationBlock.toString(), mint: undefined });
    await audit('bridge.attested', 'circle', { id: p.id, messageHash: b.messageHash, nonce: b.nonce, feeExecuted: b.feeExecuted });
  }

  if (dst.family === 'sol') return advanceSolMint(p, b, bridge); // v8: the mint is a Solana transaction (bridge-sol.ts)

  if (b.phase === 'ready' || b.phase === 'mint_failed') {
    let used: boolean; try { used = await usedNonce(dst, b.nonce!); } catch (e) { return wait(p, b, 'rpc_degraded', (e as Error).message, 20_000); }
    if (used) return done(p, b, 'other', await findMint(dst, b.nonce!)); // already minted (the contract allows it once): success
    if (b.phase === 'mint_failed') return p; // needs the owner's passkey (retry-mint)
    try { await cctpGuards(dst, destAddr(p)); } catch (e) { return wait(p, b, (e as UserError).code ?? 'rpc_degraded', (e as Error).message, 60_000); }
    // a Fast attestation expires about a day after the burn: ask Circle for a fresh one, then mint with it
    if (b.expirationBlock && b.expirationBlock !== '0') {
      const head = await expiryHead(dst);
      if (head === null && !b.mint?.evm) return wait(p, b, 'rpc_degraded', 'the destination block number could not be read', 20_000);
      if (head !== null && head >= BigInt(b.expirationBlock) && !b.mint?.evm) {
        await iris(`/v2/reattest/0x${b.nonce}`, { method: 'POST' }).catch(() => null);
        await audit('bridge.reattest', 'system', { id: p.id, nonce: b.nonce });
        return save(p, { ...b, phase: 'attesting', expiredHash: b.messageHash, polls: 0, nextAt: now() + 10_000, ...svHold('attestation_expired', 'hold_attestation_expired') });
      }
    }
    // gas parameters are chosen once and stored before the signer is asked: an interrupted attempt repeats the same request
    let evm = b.mint?.evm;
    if (!evm) {
      let g; try { g = await mintGas(p, b); } catch (e) { return wait(p, b, (e as UserError).code ?? 'rpc_degraded', (e as Error).message, 20_000); }
      if ('hold' in g) return wait(p, b, g.sv, g.detail, g.hold === 'destination_gas' ? 60_000 : 30_000);
      try { buildCctpMintTx(bridge, b.message!, b.attestation!, g.evm, BigInt((await signer.status()).policy.maxFee[dst.id] ?? '0')); } catch (e) { return wait(p, b, 'mint_would_fail', (e as Error).message, 120_000); }
      evm = g.evm; p = await save(p, b = { ...b, ...NO_HOLD, mint: { evm } });
    }
    let signed;
    try { signed = await signer.bridgeMint({ proposalId: p.id, message: b.message!, attestation: b.attestation!, evm }); }
    catch (e) {
      const code = (e as UserError).code ?? '';
      if (code === 'signer_unreachable') return wait(p, b, code, (e as Error).message, 15_000);
      // the signer refuses a second passkey-free signature and anything that is not the approved transfer
      return save(p, { ...b, phase: 'mint_failed', ...svTechnical(code || 'signer_refused', (e as Error).message), nextAt: now() + 60_000 });
    }
    p = await save(p, b = { ...b, phase: 'mint_sent', ...NO_HOLD, nextAt: 0, mint: { evm, txid: signed.txid, raw: signed.raw, sentAt: now(), lastBroadcastAt: now(), signatures: b.mint?.signatures ?? 1 } });
    await audit('bridge.mint_signed', 'system', { id: p.id, to: dst.id, txid: signed.txid, messageHash: signed.messageHash, replayed: signed.replayed });
    if (config.broadcast) await adapterFor(dst.id).broadcast(signed.raw).catch(() => {});
  }

  if (b.phase === 'mint_sent' && b.mint?.txid && config.broadcast) {
    const m = b.mint;
    const rc = await rpcAny<{ status: `0x${string}`; blockNumber: `0x${string}`; logs: { address: string; topics: [`0x${string}`, ...`0x${string}`[]]; data: `0x${string}` }[] } | null>(dst.rpc, 'eth_getTransactionReceipt', [m.txid]).catch(() => null);
    if (rc && hexToNumber(rc.status) === 1) {
      const head = await rpcAny<`0x${string}`>(dst.rpc, 'eth_blockNumber', []).then(hexToNumber, () => 0);
      if (head - hexToNumber(rc.blockNumber) + 1 < dst.minConf) return save(p, { ...b, nextAt: now() + 5_000 });
      // what the wallet actually received, from the USDC Transfer event of the mint
      const usdc = cctpUsdc(dst.id).id; let got: bigint | null = null;
      for (const l of rc.logs) { if (!eqAddr(l.address, usdc)) continue;
        try { const ev = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics }); if (ev.eventName === 'Transfer' && eqAddr(ev.args.to, destAddr(p)) && /^0x0{40}$/.test(ev.args.from)) got = ev.args.value; } catch { /* another event */ } }
      return done(p, { ...b, minted: (got ?? BigInt(b.minted ?? '0')).toString() }, 'wallet', m.txid!);
    }
    let used = false; try { used = await usedNonce(dst, b.nonce!); } catch { return save(p, { ...b, nextAt: now() + 10_000 }); }
    if (rc) { // our transaction reverted: either someone minted first (success) or it must be signed again
      if (used) return done(p, b, 'other', await findMint(dst, b.nonce!));
      await audit('bridge.mint_reverted', 'chain', { id: p.id, txid: m.txid });
      return save(p, { ...b, phase: 'mint_failed', ...svHold('mint_reverted', 'hold_mint_reverted', { net: dst.name }) });
    }
    if (used) { // minted, and no receipt for our transaction a moment ago: it may just have been included — look again before crediting someone else
      const again = await rpcAny<{ status: `0x${string}` } | null>(dst.rpc, 'eth_getTransactionReceipt', [m.txid]).catch(() => undefined);
      if (again === undefined || (again && hexToNumber(again.status) === 1)) return save(p, { ...b, nextAt: now() + 3_000 });
      return done(p, b, 'other', await findMint(dst, b.nonce!));
    }
    const latest =await rpcAny<`0x${string}`>(dst.rpc, 'eth_getTransactionCount', [destAddr(p), 'latest']).then(hexToNumber, () => null);
    if (latest !== null && latest > m.evm!.nonce && now() - (m.sentAt ?? 0) > 90_000)
      return save(p, { ...b, phase: 'mint_failed', ...svHold('mint_replaced', 'hold_mint_replaced', { net: dst.name }) });
    if (now() - (m.lastBroadcastAt ?? 0) > 45_000) { await adapterFor(dst.id).broadcast(m.raw!).catch(() => {}); return save(p, { ...b, mint: { ...m, lastBroadcastAt: now() }, nextAt: now() + 5_000 }); }
    return save(p, { ...b, nextAt: now() + 4_000 });
  }
  return p;
}

/** Worker tick: every bridge whose burn is mined and whose mint is not done. */
export async function advanceBridges(): Promise<void> {
  const rows = await sql<ProposalRow[]>`select * from proposals where kind = 'bridge' and state in ('confirming', 'finalized', 'reorged') and coalesce(bridge->>'phase', '') <> 'done' order by created_at`;
  for (const p of rows) { try { await advanceBridge(p); } catch (e) { console.log(`[worker] bridge ${p.id}: ${(e as Error).message}`); } }
  await advanceSolReclaims().catch((e) => console.log(`[worker] reclaims: ${(e as Error).message}`)); // v8: reclaim transactions that were sent
}
