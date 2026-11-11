// Swap execution (V2): KyberSwap same-chain swaps on the networks listed in KYBER_ENABLED.
// The API prepares and simulates; the isolated signer independently decodes the calldata and enforces recipient, amounts and
// minimum output (packages/core/src/swap-evm.ts). Nothing here can make the signer accept calldata it has not verified.
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { decodeEventLog, encodeFunctionData, erc20Abi, hexToBigInt, hexToNumber, numberToHex } from 'viem';
import { z } from 'zod';
import {
  buildEvmSwapTxs, checkPolicy, formatUnits, getAsset, getNetwork, IntentSchema, intentHash, KYBER_ENABLED, KYBER_NATIVE, KYBER_ROUTER, KYBER_ROUTER_ABI,
  parseUnits, swapDataHash, toB64u, toHex, verifyKyberSwap, type Intent, type NetworkDef,
} from '@spw/core';
import { listCreds } from './auth.ts';
import { adapterFor } from './chains/index.ts';
import { http, rpcAny, rpcQuorum } from './chains/rpc.ts';
import { config, UserError } from './config.ts';
import { audit, sql } from './db.ts';
import { addressFor, signer } from './signer-client.ts';
import { broadcastNow, move, view, type ProposalRow } from './transfers.ts';
import { advanceSolSwap, createSolSwapProposal, recordSolSwapOutcome, solSwapExecInfo } from './swap-exec-sol.ts';

const KYBER_API = 'https://aggregator-api.kyberswap.com';
const CLIENT_ID = process.env.KYBERSWAP_CLIENT_ID ?? 'swap-router';
const U = z.string().regex(/^(0|[1-9]\d{0,77})$/);
const RouteResp = z.object({ code: z.literal(0), data: z.object({ routeSummary: z.object({ tokenIn: z.string(), tokenOut: z.string(), amountIn: U, amountOut: U, gas: U }).passthrough(), routerAddress: z.string() }) });
const BuildResp = z.object({ code: z.literal(0), data: z.object({ amountIn: U, amountOut: U, gas: U, data: z.string().regex(/^0x([0-9a-fA-F]{2})+$/), routerAddress: z.string(), transactionValue: U }) });

async function kyber<T>(net: string, path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  let r: Response;
  try { r = await http(`${KYBER_API}/${net}/api/v1${path}`, { ...init, headers: { 'x-client-id': CLIENT_ID, 'content-type': 'application/json' } }); }
  catch { throw new UserError('provider_unavailable', 'the swap provider did not answer; nothing was signed', 503); }
  const j = await r.json().catch(() => null) as { code?: number; message?: string } | null;
  if (j && typeof j.code === 'number' && [4008, 4009, 4010, 4011].includes(j.code)) throw new UserError('no_route', 'no route for this pair and amount right now', 422);
  const p = schema.safeParse(j);
  if (!p.success) throw new UserError('provider_bad_answer', `the swap provider returned an unexpected answer${j?.message ? `: ${String(j.message).slice(0, 80)}` : ''}`, 502);
  return p.data;
}
const tokenOf = (id: string) => (id === 'native' ? KYBER_NATIVE : id);
const sha = (hex: string) => createHash('sha256').update(Buffer.from(hex.slice(2), 'hex')).digest('hex');

/** The pinned router must still hold the reviewed bytecode on every source, and the wallet address must be a plain account. */
async function chainGuards(n: NetworkDef, me: string): Promise<void> {
  const pin = KYBER_ENABLED[n.id];
  if (!pin) throw new UserError('swap_not_enabled', `swap execution is not enabled on ${n.name} yet (route comparison only)`, 422);
  const code = await rpcQuorum<string>(n.rpc, 'eth_getCode', [KYBER_ROUTER, 'latest']);
  if (sha(code) !== pin.codeSha256) throw new UserError('router_changed', 'the swap router bytecode is not the reviewed one; swaps are refused', 503);
  // an EIP-7702 delegation on the wallet address would run someone's code on every coin received
  if ((await rpcQuorum<string>(n.rpc, 'eth_getCode', [me, 'latest'])) !== '0x') throw new UserError('account_has_code', 'this wallet address carries code (delegation); swaps are refused', 503);
}

/** Expected output right now for an exact input, from the same on-chain-liquidity routes used for execution. Signs nothing. */
export async function kyberQuote(n: NetworkDef, fromAsset: string, toAsset: string, amount: bigint): Promise<bigint> {
  const r = await kyber(n.id, `/routes?tokenIn=${tokenOf(fromAsset)}&tokenOut=${tokenOf(toAsset)}&amountIn=${amount}&excludeRFQSources=true&excludedSources=kyberswap-limit-order-v2,kyberswap-limit-order`, RouteResp);
  return BigInt(r.data.routeSummary.amountOut);
}

export interface PreparedSwap { intent: Intent; data: string; expected: bigint; minOut: bigint; needApprove: boolean; simulated: boolean; feeEstimate: bigint; maxFee: bigint; fn: string }
/**
 * Prepare a firm KyberSwap swap for an address the signer controls (the owner's wallet or an agent vault): guards, balance
 * and allowance, fresh on-chain-liquidity route, calldata verified exactly as the signer will, nonce agreement, gas from the
 * node's own estimate (which is also the simulation) when possible. Throws UserError; signs nothing.
 */
export async function prepareKyberSwap(o: { n: NetworkDef; me: string; keyId: string; fromAsset: string; toAsset: string; amount: bigint; slippageBps: number; policyVersion: number; proposalId: string; ttlSec?: number }): Promise<PreparedSwap> {
  const { n, me } = o;
  let src, dst;
  try { src = getAsset(n.id, o.fromAsset); dst = getAsset(n.id, o.toAsset); } catch { throw new UserError('unsupported_asset', 'asset is not in the wallet registry'); }
  if (src.id === dst.id) throw new UserError('same_asset', 'choose two different assets');
  const amount = o.amount;
  if (amount <= 0n) throw new UserError('bad_amount', 'amount must be greater than zero');
  await chainGuards(n, me);
  const bal = await adapterFor(n.id).balances(me);
  if ((bal[src.id] ?? 0n) < amount) throw new UserError('insufficient_funds', `insufficient ${src.symbol} balance`);
  const allowance = src.id === 'native' ? 0n : hexToBigInt(await rpcAny<`0x${string}`>(n.rpc, 'eth_call', [{ to: src.id, data: encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [me as `0x${string}`, KYBER_ROUTER as `0x${string}`] }) }, 'latest']));
  const needApprove = src.id !== 'native' && allowance < amount;
  // firm route from on-chain liquidity only: off-chain signed orders can expire or be taken before inclusion
  const route = await kyber(n.id, `/routes?tokenIn=${tokenOf(src.id)}&tokenOut=${tokenOf(dst.id)}&amountIn=${amount}&excludeRFQSources=true&excludedSources=kyberswap-limit-order-v2,kyberswap-limit-order`, RouteResp);
  const now = Math.floor(Date.now() / 1000);
  const built = await kyber(n.id, '/route/build', BuildResp, { method: 'POST', body: JSON.stringify({ routeSummary: route.data.routeSummary, sender: me, recipient: me, slippageTolerance: o.slippageBps, deadline: now + 600, source: CLIENT_ID }) });
  if (built.data.routerAddress.toLowerCase() !== KYBER_ROUTER.toLowerCase()) throw new UserError('router_changed', 'the provider answered with another router; refused', 502);
  if (BigInt(built.data.amountIn) !== amount) throw new UserError('provider_bad_answer', 'the provider built another amount', 502);
  const data = built.data.data, expected = BigInt(built.data.amountOut);
  const nonce = hexToNumber(await rpcQuorum<`0x${string}`>(n.rpc, 'eth_getTransactionCount', [me, 'pending']));
  if (nonce !== hexToNumber(await rpcAny<`0x${string}`>(n.rpc, 'eth_getTransactionCount', [me, 'latest']))) throw new UserError('pending_tx', 'a previous transaction from this address is still pending on this network', 409);
  const block = await rpcAny<{ baseFeePerGas?: `0x${string}` }>(n.rpc, 'eth_getBlockByNumber', ['latest', false]);
  if (!block.baseFeePerGas) throw new UserError('rpc_degraded', 'network did not report a base fee', 503);
  const baseFee = hexToBigInt(block.baseFeePerGas);
  let tip = 1_000_000n; try { tip = hexToBigInt(await rpcAny<`0x${string}`>(n.rpc, 'eth_maxPriorityFeePerGas', [])); } catch { /* floor */ }
  const maxFeePerGas = baseFee * 2n + tip;
  const call = { from: me, to: KYBER_ROUTER, data, value: numberToHex(src.id === 'native' ? amount : 0n) };
  let gas: bigint, simulated = false;
  if (!needApprove) {
    const est = await rpcAny<`0x${string}`>(n.rpc, 'eth_estimateGas', [call]).then(hexToBigInt, (e: Error) => { throw new UserError('simulation_failed', `the swap would fail right now: ${e.message.slice(0, 120)}`, 422); });
    gas = (est * 13n) / 10n + 30_000n; simulated = true;
  } else gas = BigInt(built.data.gas) * 2n + 100_000n;
  if (gas > 2_000_000n) gas = 2_000_000n;
  const approveGas = needApprove ? 70_000n : 0n, maxFee = (gas + approveGas) * maxFeePerGas;
  if ((bal.native ?? 0n) < maxFee + (src.id === 'native' ? amount : 0n)) throw new UserError('insufficient_gas', `not enough ${n.native.symbol} on ${n.name} to pay the network fee`);
  const draft = (minOut: bigint): Intent => IntentSchema.parse({
    v: 1, proposalId: o.proposalId, keyId: o.keyId, network: n.id, chainRef: n.chainRef, asset: src.id, symbol: src.symbol, decimals: src.decimals, amount: amount.toString(),
    from: me, to: me, maxFee: maxFee.toString(), createdAt: now, expiresAt: now + (o.ttlSec ?? 75), policyVersion: o.policyVersion,
    swap: { provider: 'kyberswap', toAsset: dst.id, minOut: minOut.toString(), router: KYBER_ROUTER, dataHash: swapDataHash(data), approveGas: approveGas.toString() },
    evm: { nonce, gasLimit: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: tip.toString() },
  });
  let desc;
  try { desc = verifyKyberSwap(draft(1n), data); } catch (e) { throw new UserError('provider_bad_answer', `calldata refused: ${(e as Error).message}`, 502); }
  const floor = (expected * BigInt(10_000 - o.slippageBps)) / 10_000n;
  if (desc.minReturnAmount * 1000n < floor * 999n) throw new UserError('provider_bad_answer', 'the calldata guarantees less than the requested tolerance allows', 502);
  const intent = draft(desc.minReturnAmount);
  buildEvmSwapTxs(intent, data); // exactly what the signer will rebuild
  return { intent, data, expected, minOut: desc.minReturnAmount, needApprove, simulated, feeEstimate: (gas + approveGas) * (baseFee + tip), maxFee, fn: desc.functionName };
}

const Create = z.strictObject({ network: z.string().max(24), fromAsset: z.string().max(80), toAsset: z.string().max(80), amount: z.string().min(1).max(60), slippageBps: z.number().int().min(1).max(300).default(50) });

export function swapExecRoutes(app: FastifyInstance): void {
  app.get('/api/v1/swap/execution', async () => ({ enabled: true, provider: 'kyberswap', networks: Object.keys(KYBER_ENABLED), router: KYBER_ROUTER, solana: solSwapExecInfo() }));

  // Prepare a firm swap for the owner's wallet, then offer it for passkey approval.
  app.post('/api/v1/swap/proposals', async (req) => {
    const idem = String(req.headers['idempotency-key'] ?? '');
    if (!/^[A-Za-z0-9-]{16,64}$/.test(idem)) throw new UserError('idempotency', 'Idempotency-Key header required');
    const b = Create.parse(req.body);
    const n = getNetwork(b.network);
    if (n.family === 'sol') return createSolSwapProposal(b, idem); // Jupiter: services/api/src/swap-exec-sol.ts
    if (n.family !== 'evm') throw new UserError('swap_not_enabled', 'swap execution is only available on EVM networks and Solana for now', 422);
    let src, dst;
    try { src = getAsset(n.id, b.fromAsset); dst = getAsset(n.id, b.toAsset); } catch { throw new UserError('unsupported_asset', 'asset is not in the wallet registry'); }
    if (src.id === dst.id) throw new UserError('same_asset', 'choose two different assets');
    let amount: bigint;
    try { amount = parseUnits(b.amount, src.decimals); } catch (e) { throw new UserError('bad_amount', (e as Error).message); }
    if (amount <= 0n) throw new UserError('bad_amount', 'amount must be greater than zero');
    const st = await signer.status(true);
    if (st.halted) throw new UserError('halted', 'emergency halt is active', 423);
    const me = addressFor(st, n.id);
    const [busy] = await sql<{ id: string }[]>`select id from proposals where network = ${n.id} and state in ('approved', 'signed', 'broadcast') limit 1`;
    if (busy) throw new UserError('pending_tx', 'a previous transfer or swap on this network is not confirmed yet; wait for it before starting another', 409);
    const id = randomUUID();
    const ps = await prepareKyberSwap({ n, me, keyId: st.keyId, fromAsset: src.id, toAsset: dst.id, amount, slippageBps: b.slippageBps, policyVersion: st.policy.version, proposalId: id });
    const { intent, data } = ps, now = intent.createdAt;
    const verdict = checkPolicy(st.policy, intent, BigInt(st.spentToday[`${n.id}:${src.symbol}`] ?? '0'), now, st.halted);
    if (!verdict.ok) throw new UserError('policy', verdict.reason, 422);
    const hash = intentHash(intent);
    const swap = { provider: 'kyberswap', toAsset: dst.id, toSymbol: dst.symbol, toDecimals: dst.decimals, expectedOut: ps.expected.toString(), minOut: ps.minOut.toString(), slippageBps: b.slippageBps,
      needsApproval: ps.needApprove, simulated: ps.simulated, fn: ps.fn };
    const [p] = await sql<ProposalRow[]>`insert into proposals (id, idempotency_key, state, kind, network, asset, symbol, decimals, amount, from_addr, to_addr, note, fee_estimate, max_fee, warnings, intent, intent_hash, aux, swap, expires_at)
      values (${id}, ${idem}, 'pending_approval', 'swap', ${n.id}, ${src.id}, ${src.symbol}, ${src.decimals}, ${amount.toString()}, ${me}, ${me}, ${`swap → ${dst.symbol}`}, ${ps.feeEstimate.toString()}, ${ps.maxFee.toString()},
        ${sql.json(ps.needApprove ? ['swap_needs_approval'] : [])}, ${sql.json(intent as never)}, ${toHex(hash)}, ${sql.json({ swapData: data })}, ${sql.json(swap)}, ${new Date(intent.expiresAt * 1000)})
      on conflict (idempotency_key) do nothing returning *`;
    if (!p) throw new UserError('conflict', 'duplicate request', 409);
    await audit('swap.prepared', 'owner', { id, network: n.id, from: src.symbol, to: dst.symbol, amount: amount.toString(), minOut: swap.minOut, hash: toHex(hash) });
    const creds = await listCreds();
    const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', challenge: new Uint8Array(hash), timeout: 70_000, allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as never })) });
    if (options.challenge !== toB64u(hash)) throw new Error('challenge binding mismatch');
    return { proposal: view(p), options };
  });
}

/** After signing: mine the exact-amount approval if there is one, simulate the swap against the real state, then relay it. */
export async function advanceSwap(p: ProposalRow): Promise<ProposalRow> {
  if (p.state !== 'signed' || !p.raw || !p.intent) return p;
  if (getNetwork(p.network).family === 'sol') return advanceSolSwap(p);
  const n = getNetwork(p.network), a = adapterFor(p.network);
  const fail = (error: string) => move(p, 'failed', { error });
  if (!config.broadcast) return broadcastNow(p);
  if (p.expires_at && Date.now() - p.expires_at.getTime() > 8 * 60_000) return fail('the swap could not be sent in time; nothing was swapped');
  if (p.pre_raw && p.pre_state !== 'confirmed') {
    await a.broadcast(p.pre_raw).catch(() => {});
    const rc = await rpcAny<{ status: `0x${string}` } | null>(n.rpc, 'eth_getTransactionReceipt', [p.pre_txid]).catch(() => null);
    if (!rc) { if (p.pre_state !== 'sent') await sql`update proposals set pre_state = 'sent', updated_at = now() where id = ${p.id}`; return p; }
    if (hexToNumber(rc.status) !== 1) return fail('the token approval reverted; nothing was swapped');
    await sql`update proposals set pre_state = 'confirmed', updated_at = now() where id = ${p.id}`;
    await audit('swap.approval_confirmed', 'chain', { id: p.id, txid: p.pre_txid });
  }
  // last gate before the swap leaves: it must succeed against the current chain state
  const data = (p.aux as { swapData?: string } | null)?.swapData;
  const sim = await rpcAny<string>(n.rpc, 'eth_call', [{ from: p.from_addr, to: KYBER_ROUTER, data, value: numberToHex(p.asset === 'native' ? BigInt(p.amount) : 0n) }, 'latest']).then(() => null, (e: Error & { rpcCode?: number }) => (e.rpcCode !== undefined ? e.message : 'unreachable'));
  if (sim === 'unreachable') return p; // try again on the next tick
  if (sim !== null) return fail(`the swap would revert now (${sim.slice(0, 100)}); it was not sent${p.pre_raw ? '. The exact-amount approval stays in place for the next attempt' : ''}`);
  return broadcastNow(p);
}

/** Once a swap is final, read what was actually received from the router's own event. */
export async function recordSwapOutcome(p: ProposalRow): Promise<void> {
  if (p.kind !== 'swap' || !p.txid || p.out_amount !== null) return;
  if (getNetwork(p.network).family === 'sol') return recordSolSwapOutcome(p);
  const n = getNetwork(p.network);
  const rc = await rpcAny<{ logs: { address: string; topics: [`0x${string}`, ...`0x${string}`[]]; data: `0x${string}` }[] } | null>(n.rpc, 'eth_getTransactionReceipt', [p.txid]).catch(() => null);
  for (const l of rc?.logs ?? []) {
    if (l.address.toLowerCase() !== KYBER_ROUTER.toLowerCase()) continue;
    try { const ev = decodeEventLog({ abi: KYBER_ROUTER_ABI, data: l.data, topics: l.topics }) as unknown as { eventName: string; args: { dstReceiver: string; returnAmount: bigint } };
      if (ev.eventName === 'Swapped' && ev.args.dstReceiver.toLowerCase() === p.from_addr.toLowerCase()) {
        await sql`update proposals set out_amount = ${ev.args.returnAmount.toString()} where id = ${p.id}`;
        await audit('swap.settled', 'chain', { id: p.id, txid: p.txid, received: ev.args.returnAmount.toString(), minOut: (p.swap as { minOut?: string } | null)?.minOut });
        return; } } catch { /* another event */ }
  }
}
export { formatUnits };
