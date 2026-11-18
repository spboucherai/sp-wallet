// Native cross-chain swaps through THORChain (docs/swap/providers/thorchain.md): one transfer of the source asset to the
// current Asgard vault with the memo `=:ASSET:DEST:LIMIT`, always from the wallet to the wallet's own address.
// The API prepares, cross-checks, relays and tracks. It cannot make the signer pay another vault: the signer rebuilds the memo
// and the transaction itself and asks its own THORNode operators whether the vault is genuine (services/isolated-signer/src/vaults.ts).
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { decodeEventLog, encodeFunctionData, erc20Abi, hexToBigInt, hexToNumber, numberToHex, pad, toEventSelector } from 'viem';
import { z } from 'zod';
import {
  buildThorMemo, buildXswapBtcTx, buildXswapEvmTxs, checkPolicy, checkThorVault, fetchThorViews, formatUnits, fromThorAmount, getNetwork, IntentSchema, intentHash, parseUnits, pickThorVault,
  THOR_ASSETS, THOR_EXPIRY_SECONDS, THOR_MIN_OPERATORS, THOR_ROUTER_ABI, THOR_ROUTERS, thorAsset, THORNODE_OPERATORS, thorOpReturnSize, thorTxId, thorVaultAddress, toB64u, toHex, toThorAmount,
  utxoPaymentTo, verifyXswap, xswapDepositData, type Intent, type NetworkDef, type ThorAnswer, type ThorAsset, type ThorGet, type ThorVaultVerdict, type ThorVaultWant,
} from '@spw/core';
import { listCreds } from './auth.ts';
import { sourceOf } from './chains/btc.ts';
import { adapterFor } from './chains/index.ts';
import { rpcAny, rpcOne, rpcQuorum } from './chains/rpc.ts';
import { config, UserError } from './config.ts';
import { audit, sql } from './db.ts';
import { addressFor, signer } from './signer-client.ts';
import { broadcastNow, failure, move, view, type ProposalRow } from './transfers.ts';
import type { SvCode, SvParams } from './sv-texts.ts';
import { checkQuoteRef, idemOf, lostRace, QuoteRef, replayOf } from './prepare-common.ts';
import { assetKey } from '@spw/swap';
import { xswapNext, xswapTerminal, type OutboundSeen, type ThorStatus, type XswapObs, type XswapState } from './xswap-state.ts';

/** Second line of defence: the vault must hold, on-chain, at least this many times the amount in the source asset. */
export const EVIDENCE_MULTIPLE = 100n;
/** Quotes of two operators must agree on the expected output within this. */
const QUOTE_TOLERANCE_BPS = 100n;
const ZERO = '0x0000000000000000000000000000000000000000';
const TRANSFER_OUT = toEventSelector('TransferOut(address,address,address,uint256,string)');
const sha = (hexStr: string) => createHash('sha256').update(Buffer.from(hexStr.slice(2), 'hex')).digest('hex');
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const now = () => Date.now();

export const thorGet: ThorGet = async (url) => {
  // one attempt, eight seconds: the operators are asked in parallel and a slow one simply does not count
  const r = await fetch(url, { headers: { accept: 'application/json', 'x-client-id': 'sp-wallet' }, signal: AbortSignal.timeout(8000), redirect: 'error' });
  const t = await r.text();
  if (t.length > 600_000) throw new Error('response too large');
  let j: unknown; try { j = JSON.parse(t); } catch { throw new Error(`non-JSON answer (HTTP ${r.status})`); }
  if (!r.ok) throw Object.assign(new Error(typeof (j as { message?: unknown })?.message === 'string' ? (j as { message: string }).message.slice(0, 160) : `HTTP ${r.status}`), { status: r.status });
  return j;
};

// ---------------------------------------------------------------------------------------------------------------------
// Quotes: asked from every operator with the wallet's own addresses; at least two must answer and agree.

const D = z.string().regex(/^(0|[1-9]\d{0,38})$/);
const QuoteSchema = z.looseObject({ memo: z.string().min(5).max(250), expected_amount_out: D, expiry: z.number().int().positive(), recommended_min_amount_in: D, dust_threshold: D.optional(), router: z.string().optional(),
  inbound_address: z.string().max(160), max_streaming_quantity: z.number().int().nonnegative().optional(), total_swap_seconds: z.number().int().nonnegative().optional(),
  fees: z.looseObject({ asset: z.string().max(120), affiliate: D, outbound: D, liquidity: D }) });
export type ThorQuote = z.infer<typeof QuoteSchema>;
export const toleranceLimit = (expected: bigint, bps: number) => (expected * BigInt(10_000 - bps)) / 10_000n;

export interface AgreedQuote { operators: string[]; expected: bigint; limit: bigint; outboundFee: bigint; liquidityFee: bigint; minAmountIn: bigint; seconds: number | null; memo: string }
/**
 * Compare the operators' quotes with what this wallet builds. Each quote's own `memo` must be, byte for byte, the memo this
 * wallet writes for that quote's numbers (same asset spelling, same destination, limit = expected less the tolerance): this
 * proves THORChain reads our memo as the swap we mean. The limit kept is the one of the LOWEST quote.
 */
export function agreeQuotes(quotes: { operator: string; quote: ThorQuote }[], dst: ThorAsset, destination: string, bps: number, router: string | null): AgreedQuote {
  if (quotes.length < 2) throw new UserError('provider_unavailable', `fewer than two THORNode operators returned a quote (${quotes.length}); nothing was prepared`, 503);
  let lo: bigint | null = null, hi = 0n, outboundFee = 0n, liquidityFee = 0n, minIn = 0n, seconds: number | null = null;
  for (const { operator, quote: q } of quotes) {
    const bad = (why: string) => new UserError('provider_bad_answer', `THORNode operator ${operator}: ${why}; nothing was prepared`, 502);
    const expected = BigInt(q.expected_amount_out);
    if (q.fees.asset !== dst.notation) throw bad('fees are not in the output asset');
    if (BigInt(q.fees.affiliate) !== 0n) throw bad('quote carries an affiliate fee');
    if ((q.max_streaming_quantity ?? 1) > 1) throw new UserError('amount_would_stream', 'THORChain would split this amount into a streaming swap, which this wallet does not execute', 422);
    if (router === null ? q.router !== undefined : !q.router || !eq(q.router, router)) throw bad('quote names another router');
    const limit = toleranceLimit(expected, bps);
    if (limit <= 0n) throw new UserError('no_route', 'the amount is too small for this pair', 422);
    if (buildThorMemo(dst, destination, limit) !== q.memo) throw bad(`the memo THORChain expects (${q.memo.slice(0, 90)}) is not the memo this wallet builds`);
    if (lo === null || expected < lo) lo = expected; if (expected > hi) hi = expected;
    if (BigInt(q.fees.outbound) > outboundFee) outboundFee = BigInt(q.fees.outbound);
    if (BigInt(q.fees.liquidity) > liquidityFee) liquidityFee = BigInt(q.fees.liquidity);
    if (BigInt(q.recommended_min_amount_in) > minIn) minIn = BigInt(q.recommended_min_amount_in);
    if (q.total_swap_seconds !== undefined && (seconds === null || q.total_swap_seconds > seconds)) seconds = q.total_swap_seconds;
  }
  if ((hi - lo!) * 10_000n > lo! * QUOTE_TOLERANCE_BPS) throw new UserError('quotes_disagree', 'THORNode operators disagree on the price by more than 1 %; nothing was prepared', 503);
  const limit = toleranceLimit(lo!, bps);
  return { operators: quotes.map((q) => q.operator), expected: lo!, limit, outboundFee, liquidityFee, minAmountIn: minIn, seconds, memo: buildThorMemo(dst, destination, limit) };
}

export async function fetchQuotes(src: ThorAsset, dst: ThorAsset, amount1e8: bigint, destination: string, bps: number, get: ThorGet = thorGet): Promise<{ operator: string; quote: ThorQuote }[]> {
  const q = new URLSearchParams({ from_asset: src.notation, to_asset: dst.notation, amount: amount1e8.toString(), destination, liquidity_tolerance_bps: String(bps) });
  const ask = (ops: typeof THORNODE_OPERATORS) => Promise.all(ops.map(async (o) => {
    try { const p = QuoteSchema.safeParse(await get(`${o.base}/thorchain/quote/swap?${q}`)); return p.success ? { operator: o.id, quote: p.data } : { operator: o.id, error: 'malformed quote' }; }
    catch (e) { return { operator: o.id, error: (e as Error).message }; }
  }));
  let rs = await ask(THORNODE_OPERATORS);
  const good = (x: typeof rs) => x.flatMap((r) => ('quote' in r ? [r as { operator: string; quote: ThorQuote }] : []));
  // a node that lags answers "refusing quote on node with stale state" within milliseconds, a busy one times out: those (only) are asked once more
  if (good(rs).length < 2) { const again = rs.filter((r) => 'error' in r && /stale state|timeout|aborted|fetch failed/i.test(r.error as string)).map((r) => THORNODE_OPERATORS.find((o) => o.id === r.operator)!);
    if (again.length) { const second = await ask(again); rs = rs.map((r) => second.find((s) => s.operator === r.operator && 'quote' in s) ?? r); } }
  const ok = good(rs);
  if (ok.length < 2) {
    const why = rs.flatMap((r) => ('error' in r ? [r.error as string] : []));
    const refusal = why.find((m) => /dust|min swap amount|not enough asset|halt|paused|not available|less than price limit|too small/i.test(m));
    if (refusal) throw new UserError('no_route', `THORChain cannot do this swap right now: ${refusal.slice(0, 140)}`, 422);
  }
  return ok;
}

/** The pool behind the memo spelling must be the pinned one: Available, and the only pool with that chain and ticker. */
async function poolGuard(a: ThorAsset, get: ThorGet): Promise<void> {
  const Pools = z.array(z.looseObject({ asset: z.string().max(140), status: z.string().max(30), short_code: z.string().max(10).optional() })).max(400);
  let seen = 0;
  const all = await Promise.all(THORNODE_OPERATORS.map((o) => get(`${o.base}/thorchain/pools`).then((j) => Pools.parse(j), () => null)));
  for (const pools of all) {
    if (!pools) continue;
    const own = pools.filter((p) => p.asset === a.notation);
    if (own.length !== 1 || own[0]!.status !== 'Available') throw new UserError('pool_unavailable', `the THORChain pool ${a.notation.slice(0, 20)} is not available right now`, 422);
    const same = a.memo.includes('.') ? pools.filter((p) => p.asset === a.memo || p.asset.startsWith(`${a.memo}-`)) : pools.filter((p) => p.short_code === a.memo);
    if (same.length !== 1 || same[0]!.asset !== a.notation) throw new UserError('pool_ambiguous', `THORChain now has another pool that the memo spelling ${a.memo} could designate; swaps to this asset are refused until reviewed`, 503);
    seen += 1;
  }
  if (seen >= 2) return;
  throw new UserError('provider_unavailable', 'THORChain pools could not be read from two operators', 503);
}

// ---------------------------------------------------------------------------------------------------------------------
// Vault: the API's own unanimity check (the signer repeats it independently), then what the chain itself shows.

export async function vaultCheck(want: ThorVaultWant, get: ThorGet = thorGet): Promise<ThorVaultVerdict> { return checkThorVault(await fetchThorViews(get), want); }

/** What the wallet's own chain data sources say about the vault. Fakeable by someone who parks that much capital: a second line, not a proof. */
async function vaultEvidence(n: NetworkDef, src: ThorAsset, vault: string, amount: bigint): Promise<XswapState['evidence']> {
  let holds: bigint, transfersOut: number | null = null;
  if (n.family === 'evm') {
    const router = THOR_ROUTERS[n.id]!.address;
    holds = src.asset === 'native' ? hexToBigInt(await rpcQuorum<`0x${string}`>(n.rpc, 'eth_getBalance', [vault, 'latest'], (a, b) => hexToBigInt(a) * 2n > hexToBigInt(b) && hexToBigInt(b) * 2n > hexToBigInt(a)))
      : hexToBigInt(await rpcQuorum<`0x${string}`>(n.rpc, 'eth_call', [{ to: router, data: encodeFunctionData({ abi: THOR_ROUTER_ABI, functionName: 'vaultAllowance', args: [vault as `0x${string}`, src.asset as `0x${string}`] }) }, 'latest'], (a, b) => hexToBigInt(a) * 2n > hexToBigInt(b) && hexToBigInt(b) * 2n > hexToBigInt(a)));
    try { // recent outbound transfers the router recorded for this vault (TransferOut is emitted with msg.sender = the vault)
      const head = hexToNumber(await rpcAny<`0x${string}`>(n.rpc, 'eth_blockNumber', []));
      const logs = await rpcAny<unknown[]>(n.rpc, 'eth_getLogs', [{ address: router, fromBlock: numberToHex(head - 3000), toBlock: 'latest', topics: [TRANSFER_OUT, pad(vault as `0x${string}`).toLowerCase()] }]);
      transfersOut = logs.length;
    } catch { transfersOut = null; }
  } else holds = (await adapterFor(n.id).balances(vault)).native ?? 0n;
  if (holds < amount * EVIDENCE_MULTIPLE) throw new UserError('vault_evidence', `the address the THORNode operators name as vault holds less than ${EVIDENCE_MULTIPLE} times the amount on ${n.name}; this does not look like an Asgard vault and the swap is refused`, 503);
  return { holds: holds.toString(), multiple: Number(holds / amount > 1_000_000n ? 1_000_000n : holds / amount), transfersOut };
}

async function routerGuards(n: NetworkDef, me: string): Promise<void> {
  const pin = THOR_ROUTERS[n.id];
  if (!pin) throw new UserError('xswap_not_enabled', `THORChain swaps from ${n.name} are not enabled`, 422);
  if (sha(await rpcQuorum<string>(n.rpc, 'eth_getCode', [pin.address, 'latest'])) !== pin.codeSha256) throw new UserError('router_changed', 'the THORChain router bytecode is not the reviewed one; swaps are refused', 503);
  if ((await rpcQuorum<string>(n.rpc, 'eth_getCode', [me, 'latest'])) !== '0x') throw new UserError('account_has_code', 'this wallet address carries code (delegation); swaps are refused', 503);
}

// ---------------------------------------------------------------------------------------------------------------------
// Preparation

const Create = z.strictObject({ fromNetwork: z.string().max(24), fromAsset: z.string().max(80), toNetwork: z.string().max(24), toAsset: z.string().max(80), amount: z.string().min(1).max(60), slippageBps: z.number().int().min(1).max(300).default(100), /** v11: the route the owner was looking at (prepare-common.ts) */ quote: QuoteRef.optional() });
const GAS = { approve: 70_000n, depositUnsimulated: 160_000n };

export function xswapRoutes(app: FastifyInstance): void {
  app.get('/api/v1/xswap/execution', async () => ({ enabled: true, provider: 'thorchain', minOperators: THOR_MIN_OPERATORS, operators: THORNODE_OPERATORS.map((o) => ({ id: o.id, host: new URL(o.base).host })),
    assets: THOR_ASSETS.map((a) => ({ network: a.network, asset: a.asset, symbol: a.symbol, source: a.source })), routers: Object.fromEntries(Object.entries(THOR_ROUTERS).map(([k, v]) => [k, v.address])) }));

  app.post('/api/v1/xswap/proposals', async (req) => {
    if (!/^[A-Za-z0-9-]{16,64}$/.test(String(req.headers['idempotency-key'] ?? ''))) throw new UserError('idempotency', 'Idempotency-Key header required');
    const b = Create.parse(req.body), idem = idemOf(req.headers, 'xswap', b);
    const again = await replayOf(idem); if (again) return again; // v11 (B4): the same key answers the same swap, without asking the operators again
    let src: ThorAsset, dst: ThorAsset;
    try { src = thorAsset(b.fromNetwork, b.fromAsset); dst = thorAsset(b.toNetwork, b.toAsset); } catch { throw new UserError('xswap_not_enabled', 'this pair cannot be swapped through THORChain by this wallet', 422); }
    if (!src.source) throw new UserError('xswap_not_enabled', `${src.symbol} cannot be the input of a THORChain swap in this wallet`, 422);
    if (src.network === dst.network) throw new UserError('same_network', 'choose assets on two different networks');
    const n = getNetwork(src.network), dn = getNetwork(dst.network);
    let amount: bigint;
    try { amount = parseUnits(b.amount, src.decimals); } catch (e) { throw new UserError('bad_amount', (e as Error).message); }
    if (src.decimals > 8) amount -= amount % 10n ** BigInt(src.decimals - 8); // THORChain credits 8 decimals: nothing finer is sent
    if (amount <= 0n) throw new UserError('bad_amount', 'amount must be greater than zero');
    const amount1e8 = toThorAmount(amount, src.decimals);
    const st = await signer.status(true);
    if (st.halted) throw new UserError('halted', 'emergency halt is active', 423);
    const me = addressFor(st, n.id), dest = addressFor(st, dn.id);
    const [busy] = await sql<{ id: string }[]>`select id from proposals where network = ${n.id} and (state in ('approved', 'signed', 'broadcast')
      or (kind = 'xswap' and state in ('confirming', 'finalized', 'reorged') and coalesce(xswap->>'phase', '') not in ('received', 'refunded'))) limit 1`;
    if (busy) throw new UserError('pending_tx', 'a previous transfer or swap on this network is not finished yet; wait for it before starting another', 409);

    // 1. the vault: named by the operators, confirmed by all that answer, its address derived here from its key
    const answers: ThorAnswer[] = await fetchThorViews(thorGet);
    const vaultPubKey = pickThorVault(answers, src.chain);
    if (!vaultPubKey) throw new UserError('provider_unavailable', 'no THORNode operator could be reached; nothing was prepared', 503);
    const router = n.family === 'evm' ? THOR_ROUTERS[n.id]?.address ?? null : null;
    if (n.family === 'evm' && !router) throw new UserError('xswap_not_enabled', `THORChain swaps from ${n.name} are not enabled`, 422);
    const want: ThorVaultWant = { chain: src.chain, vaultPubKey, router, amount: amount1e8 };
    let verdict: ThorVaultVerdict;
    try { verdict = checkThorVault(answers, want); } catch (e) { throw new UserError('vault_unconfirmed', (e as Error).message, 503); }
    // the destination chain must be running too, or the outbound would wait
    const dstBlocked = answers.flatMap((a) => ('view' in a ? a.view.inbound.filter((x) => x.chain === dst.chain && (x.halted || x.paused)) : []));
    if (dstBlocked.length) throw new UserError('chain_halted', `THORChain reports ${dn.name} halted or paused; nothing was prepared`, 422);
    let vault: string;
    try { vault = thorVaultAddress(vaultPubKey, n.id); } catch (e) { throw new UserError('provider_bad_answer', `vault key refused: ${(e as Error).message}`, 502); }
    if (eq(vault, me)) throw new UserError('provider_bad_answer', 'the vault is the wallet itself', 502);

    // 2. the price: at least two operators, agreeing, each naming exactly the memo this wallet builds
    await poolGuard(src, thorGet); await poolGuard(dst, thorGet);
    const agreed = agreeQuotes(await fetchQuotes(src, dst, amount1e8, dest, b.slippageBps, thorGet), dst, dest, b.slippageBps, router);
    if (amount1e8 < agreed.minAmountIn) throw new UserError('below_minimum', `THORChain's minimum for this swap is ${formatUnits(fromThorAmount(agreed.minAmountIn, src.decimals), src.decimals)} ${src.symbol}: below it, a refund could not pay its own fee and the amount would be lost`, 422);
    const minOut = fromThorAmount(agreed.limit, dst.decimals), expectedOut = fromThorAmount(agreed.expected, dst.decimals);
    if (minOut <= 0n) throw new UserError('no_route', 'the amount is too small for this pair', 422);
    // v11 (B6): what two operators agree on now, against the quote the owner was shown
    const quote = checkQuoteRef(b.quote, { executor: 'thorchain', fromKey: assetKey({ network: src.network, asset: src.asset }), toKey: assetKey({ network: dst.network, asset: dst.asset }), amountIn: amount, slippageBps: b.slippageBps, firmOut: expectedOut, firmMinOut: minOut, toDecimals: dst.decimals, toSymbol: dst.symbol });

    // 3. second line: what the chain itself shows about that address
    const evidence = await vaultEvidence(n, src, vault, amount);

    // 4. the source transaction
    const t0 = Math.floor(now() / 1000), id = randomUUID();
    const bal = await adapterFor(n.id).balances(me);
    const have = bal[src.asset === 'native' ? 'native' : src.asset];
    if (have === undefined) throw new UserError('rpc_degraded', 'balance could not be read; swap refused', 503);
    if (have < amount) throw new UserError('insufficient_funds', `insufficient ${src.symbol} balance`);
    const x = { provider: 'thorchain' as const, toNetwork: dn.id, toAsset: dst.asset, minOut: minOut.toString(), limit: agreed.limit.toString(), memo: agreed.memo, vault, vaultPubKey, router: router ?? '', expiry: t0 + THOR_EXPIRY_SECONDS };
    const base = { v: 1, proposalId: id, keyId: st.keyId, network: n.id, chainRef: n.chainRef, asset: src.asset, symbol: src.symbol, decimals: src.decimals, amount: amount.toString(), from: me, to: vault, createdAt: t0, expiresAt: t0 + 120, policyVersion: st.policy.version };
    let intent: Intent, aux: Record<string, unknown> | undefined, needApprove = false, simulated = false, feeEstimate: bigint;
    if (n.family === 'btc') {
      // fee rate: the higher of the wallet's own estimate and THORChain's recommendation; an under-priced inbound could still be unconfirmed at the next churn
      const prep = await adapterFor(n.id).prepare({ asset: 'native', from: me, to: vault, amount, thor: { extraBytes: thorOpReturnSize(agreed.memo), minRate: verdict.gasRate === null ? 0 : Number(verdict.gasRate) } });
      intent = IntentSchema.parse({ ...base, maxFee: prep.maxFee.toString(), xswap: { ...x, approveGas: '0' }, ...prep.section });
      aux = prep.aux; feeEstimate = prep.feeEstimate;
      try { buildXswapBtcTx(intent, dest, aux); } catch (e) { throw new UserError('simulation_failed', (e as Error).message, 422); } // exactly what the signer will rebuild
    } else {
      await routerGuards(n, me);
      const allowance = src.asset === 'native' ? 0n : hexToBigInt(await rpcAny<`0x${string}`>(n.rpc, 'eth_call', [{ to: src.asset, data: encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [me as `0x${string}`, router as `0x${string}`] }) }, 'latest']));
      needApprove = src.asset !== 'native' && allowance < amount;
      const nonce = hexToNumber(await rpcQuorum<`0x${string}`>(n.rpc, 'eth_getTransactionCount', [me, 'pending']));
      if (nonce !== hexToNumber(await rpcAny<`0x${string}`>(n.rpc, 'eth_getTransactionCount', [me, 'latest']))) throw new UserError('pending_tx', 'a previous transaction from this address is still pending on this network', 409);
      const block = await rpcAny<{ baseFeePerGas?: `0x${string}` }>(n.rpc, 'eth_getBlockByNumber', ['latest', false]);
      if (!block.baseFeePerGas) throw new UserError('rpc_degraded', 'network did not report a base fee', 503);
      const baseFee = hexToBigInt(block.baseFeePerGas);
      let tip = 1_000_000n; try { tip = hexToBigInt(await rpcAny<`0x${string}`>(n.rpc, 'eth_maxPriorityFeePerGas', [])); } catch { /* floor */ }
      // the higher of the wallet's own ceiling and THORChain's recommended gas rate (gwei)
      let maxFeePerGas = baseFee * 2n + tip; const thorRate = (verdict.gasRate ?? 0n) * 1_000_000_000n; if (thorRate > maxFeePerGas) maxFeePerGas = thorRate;
      const draft = (gas: bigint): Intent => IntentSchema.parse({ ...base, maxFee: ((gas + (needApprove ? GAS.approve : 0n)) * maxFeePerGas).toString(), xswap: { ...x, approveGas: (needApprove ? GAS.approve : 0n).toString() },
        evm: { nonce, gasLimit: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: (tip > maxFeePerGas ? maxFeePerGas : tip).toString() } });
      let gas = GAS.depositUnsimulated;
      if (!needApprove) { // the node's own estimate is also the simulation; with an approval pending the deposit is simulated once it is mined
        const est = await rpcAny<`0x${string}`>(n.rpc, 'eth_estimateGas', [{ from: me, to: router, data: xswapDepositData(draft(gas), dest), value: numberToHex(src.asset === 'native' ? amount : 0n) }])
          .then(hexToBigInt, (e: Error) => { throw new UserError('simulation_failed', `the deposit would fail right now: ${e.message.slice(0, 120)}`, 422); });
        gas = (est * 13n) / 10n + 20_000n; simulated = true;
      }
      intent = draft(gas); feeEstimate = (gas + (needApprove ? GAS.approve : 0n)) * (baseFee + tip);
      try { buildXswapEvmTxs(intent, dest); } catch (e) { throw new UserError('simulation_failed', (e as Error).message, 422); }
      if ((bal.native ?? 0n) < BigInt(intent.maxFee) + (src.asset === 'native' ? amount : 0n)) throw new UserError('insufficient_gas', `not enough ${n.native.symbol} on ${n.name} to pay the network fee`);
    }
    const policy = checkPolicy(st.policy, intent, BigInt(st.spentToday[`${n.id}:${src.symbol}`] ?? '0'), t0, st.halted);
    if (!policy.ok) throw new UserError('policy', policy.reason, 422);
    const hash = intentHash(intent);
    const state: XswapState = { provider: 'thorchain', toNetwork: dn.id, toAsset: dst.asset, toSymbol: dst.symbol, toDecimals: dst.decimals, expectedOut: expectedOut.toString(), minOut: minOut.toString(), limit1e8: agreed.limit.toString(),
      memo: agreed.memo, vault, vaultPubKey, router, expiry: x.expiry, outboundFee: fromThorAmount(agreed.outboundFee, dst.decimals).toString(), liquidityFee: fromThorAmount(agreed.liquidityFee, dst.decimals).toString(),
      estimatedSeconds: agreed.seconds, slippageBps: b.slippageBps, operators: verdict.operators, quoteOperators: agreed.operators, churnHeight: verdict.statusSince, vaultMembers: verdict.members, evidence,
      needsApproval: needApprove, simulated, phase: 'sending', polls: 0, nextAt: 0 };
    const swap = { provider: 'thorchain', toAsset: dst.asset, toSymbol: dst.symbol, toDecimals: dst.decimals, expectedOut: expectedOut.toString(), minOut: minOut.toString(), slippageBps: b.slippageBps, needsApproval: needApprove, simulated };
    const [p] = await sql<ProposalRow[]>`insert into proposals (id, idempotency_key, request_hash, quote_ref, state, kind, network, asset, symbol, decimals, amount, from_addr, to_addr, note, fee_estimate, max_fee, warnings, intent, intent_hash, aux, swap, xswap, expires_at)
      values (${id}, ${idem.key}, ${idem.hash}, ${quote ? sql.json(quote as never) : null}, 'pending_approval', 'xswap', ${n.id}, ${src.asset}, ${src.symbol}, ${src.decimals}, ${amount.toString()}, ${me}, ${vault}, ${`swap → ${dst.symbol} (${dn.name})`}, ${feeEstimate.toString()}, ${intent.maxFee},
        ${sql.json(needApprove ? ['swap_needs_approval'] : [])}, ${sql.json(intent as never)}, ${toHex(hash)}, ${aux ? sql.json(aux as never) : null}, ${sql.json(swap)}, ${sql.json(state as never)}, ${new Date(intent.expiresAt * 1000)})
      on conflict (idempotency_key) do nothing returning *`;
    if (!p) return lostRace(idem);
    await audit('xswap.prepared', 'owner', { id, from: `${n.id}:${src.symbol}`, to: `${dn.id}:${dst.symbol}`, amount: amount.toString(), minOut: minOut.toString(), vault, vaultPubKey, memo: agreed.memo, operators: verdict.operators, quoteOperators: agreed.operators, churnHeight: verdict.statusSince, hash: toHex(hash) });
    const creds = await listCreds();
    const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', challenge: new Uint8Array(hash), timeout: 110_000, allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as never })) });
    if (options.challenge !== toB64u(hash)) throw new Error('challenge binding mismatch');
    return { proposal: view(p), intent: p.intent, options };
  });

  // Look now instead of waiting for the worker. Safe at any time, any number of times; it signs nothing.
  app.post('/api/v1/xswap/proposals/:id/refresh', async (req) => {
    const id = (req.params as { id: string }).id;
    const [p] = z.uuid().safeParse(id).success ? await sql<ProposalRow[]>`select * from proposals where id = ${id} and kind = 'xswap'` : [];
    if (!p) throw new UserError('not_found', 'swap not found', 404);
    if (p.state === 'signed') return view(await advanceXswapSend(p));
    return view(await advanceXswap(p, liveDeps, true));
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// After signing: last gates, then relay. Nothing is sent once the vault is in doubt or the validity window is nearly over.

const save = async (p: ProposalRow, b: XswapState): Promise<ProposalRow> => (await sql<ProposalRow[]>`update proposals set xswap = ${sql.json(b as never)}, updated_at = now() where id = ${p.id} returning *`)[0]!;
const wantOf = (p: ProposalRow): { want: ThorVaultWant; dest: string } => { const dest = (p.intent!.xswap!.memo.split(':')[2] ?? ''); return { want: verifyXswap(p.intent!, dest).want, dest }; };
/** A UTXO inbound is never (re)broadcast in the last minutes of its window: it must confirm while the vault it pays is the one that was confirmed. */
export const xswapMayBroadcast = (p: { xswap?: XswapState | null }, nowMs = Date.now()): boolean => !!p.xswap && nowMs / 1000 < p.xswap.expiry - 180;

export async function advanceXswapSend(p: ProposalRow, check: (w: ThorVaultWant) => Promise<ThorVaultVerdict> = vaultCheck): Promise<ProposalRow> {
  if (p.kind !== 'xswap' || p.state !== 'signed' || !p.raw || !p.intent?.xswap || !p.xswap) return p;
  const n = getNetwork(p.network), b = p.xswap;
  const fail = (code: SvCode, params?: SvParams) => move(p, 'failed', failure(code, params));
  const sent = async (q: ProposalRow) => (q.state === 'broadcast' ? save(q, { ...b, phase: 'sent', sentAt: now(), nextAt: 0 }) : q);
  if (!config.broadcast) return sent(await broadcastNow(p));
  if (!xswapMayBroadcast(p)) return fail('xswap_late');
  // the vault must still be the confirmed active vault of the same churn, on a chain that is not halted
  const { want, dest } = wantOf(p);
  try { const v = await check(want); if (v.statusSince !== b.churnHeight) throw new Error('the vault set changed (churn) since the swap was prepared'); }
  catch (e) {
    if (/^only \d+ THORNode/.test((e as Error).message)) return p; // operators unreachable: try again on the next tick, until the window closes
    return fail('xswap_vault_unconfirmed', { detail: (e as Error).message.slice(0, 160) });
  }
  if (n.family === 'evm') {
    const router = THOR_ROUTERS[n.id]!.address;
    if (p.pre_raw && p.pre_state !== 'confirmed') {
      await adapterFor(p.network).broadcast(p.pre_raw).catch(() => {});
      const rc = await rpcAny<{ status: `0x${string}` } | null>(n.rpc, 'eth_getTransactionReceipt', [p.pre_txid]).catch(() => null);
      if (!rc) { if (p.pre_state !== 'sent') await sql`update proposals set pre_state = 'sent', updated_at = now() where id = ${p.id}`; return p; }
      if (hexToNumber(rc.status) !== 1) return fail('xswap_approval_reverted');
      await sql`update proposals set pre_state = 'confirmed', updated_at = now() where id = ${p.id}`;
      await audit('xswap.approval_confirmed', 'chain', { id: p.id, txid: p.pre_txid });
    }
    const sim = await rpcAny<string>(n.rpc, 'eth_call', [{ from: p.from_addr, to: router, data: xswapDepositData(p.intent, dest), value: numberToHex(p.asset === 'native' ? BigInt(p.amount) : 0n) }, 'latest'])
      .then(() => null, (e: Error & { rpcCode?: number }) => (e.rpcCode !== undefined ? e.message : 'unreachable'));
    if (sim === 'unreachable') return p;
    if (sim !== null) return fail(p.pre_raw ? 'deposit_would_revert_approved' : 'deposit_would_revert', { detail: sim.slice(0, 100) });
  }
  return sent(await broadcastNow(p));
}

// ---------------------------------------------------------------------------------------------------------------------
// Tracking: THORChain's status (two operators agreeing) says where to look; only the wallet's own chain adapters say "received".

const StatusSchema = z.looseObject({
  planned_out_txs: z.array(z.looseObject({ refund: z.boolean().optional() })).max(20).nullish(),
  out_txs: z.array(z.looseObject({ id: z.string().max(80), chain: z.string().max(12), to_address: z.string().max(160), memo: z.string().max(300).optional() })).max(20).nullish(),
  stages: z.looseObject({ inbound_observed: z.looseObject({ completed: z.boolean() }) }),
});
/** Reduce one operator's answer; out transactions without a real id (native THORChain) are ignored. */
export function reduceThorStatus(j: unknown): ThorStatus {
  const s = StatusSchema.parse(j);
  return { observed: s.stages.inbound_observed.completed, refundPlanned: (s.planned_out_txs ?? []).some((x) => x.refund === true),
    outs: (s.out_txs ?? []).filter((x) => /^[0-9A-Fa-f]{64}$/.test(x.id) && !/^0+$/.test(x.id)).map((x) => ({ id: x.id.toUpperCase(), chain: x.chain, to: x.to_address, memo: x.memo ?? '' })).sort((a, b) => a.id.localeCompare(b.id)) };
}
/** The most advanced status that at least two operators give identically, or null. */
export function agreeThorStatus(all: ThorStatus[]): ThorStatus | null {
  const groups = new Map<string, { n: number; s: ThorStatus }>();
  for (const s of all) { const k = JSON.stringify(s); const g = groups.get(k); if (g) g.n += 1; else groups.set(k, { n: 1, s }); }
  const ok = [...groups.values()].filter((g) => g.n >= 2).map((g) => g.s);
  ok.sort((a, b) => b.outs.length - a.outs.length || Number(b.observed) - Number(a.observed));
  return ok[0] ?? null;
}

export interface XswapDeps {
  status(inTxid: string): Promise<ThorStatus | null>;
  vaultActive(p: ProposalRow): Promise<boolean | null>;
  outboundSeen(p: ProposalRow, b: XswapState): Promise<OutboundSeen>;
}

/** The outbound (or refund) transaction, read with the wallet's own data sources: it must pay the wallet the expected asset and carry THORChain's memo for this swap. */
async function outboundSeen(p: ProposalRow, b: XswapState): Promise<OutboundSeen> {
  const refund = b.outKind === 'refund', n = getNetwork(refund ? p.network : b.toNetwork), asset = refund ? p.asset : b.toAsset;
  const me = refund ? p.from_addr : addressFor(await signer.status(), b.toNetwork), memo = `${refund ? 'REFUND' : 'OUT'}:${thorTxId(p.txid!)}`, id = b.outTxid!.toLowerCase();
  if (n.family === 'evm') {
    const router = THOR_ROUTERS[n.id]?.address; if (!router) return null;
    let agreed: bigint | 'mismatch' | undefined, minHead = Infinity, block = 0;
    for (const url of n.rpc) { // every RPC source must show the same thing
      const rc = await rpcOne<{ status: `0x${string}`; blockNumber: `0x${string}`; logs: { address: string; topics: [`0x${string}`, ...`0x${string}`[]]; data: `0x${string}` }[] } | null>(url, 'eth_getTransactionReceipt', [`0x${id}`]).catch(() => undefined);
      if (!rc) return null; // not there (yet) or source down: look again later
      let got: bigint | 'mismatch' = 'mismatch';
      if (hexToNumber(rc.status) === 1) for (const l of rc.logs) { if (!eq(l.address, router)) continue;
        try { const ev = decodeEventLog({ abi: THOR_ROUTER_ABI, data: l.data, topics: l.topics });
          if (ev.eventName === 'TransferOut' && eq(ev.args.to, me) && eq(ev.args.asset, asset === 'native' ? ZERO : asset) && ev.args.memo === memo) got = (got === 'mismatch' ? 0n : got) + ev.args.amount; } catch { /* another event */ } }
      if (agreed !== undefined && agreed !== got) return 'mismatch';
      agreed = got; block = hexToNumber(rc.blockNumber);
      minHead = Math.min(minHead, await rpcOne<`0x${string}`>(url, 'eth_blockNumber', []).then(hexToNumber, () => 0));
    }
    if (agreed === undefined) return null;
    return agreed === 'mismatch' ? 'mismatch' : { amount: agreed, confirmed: minHead - block + 1 >= n.minConf };
  }
  if (n.family !== 'btc') return null;
  const sources = n.rpc.map(sourceOf);
  let raw: string | null = null;
  for (const s of sources) { try { raw = await s.rawTx(id); break; } catch { /* next source */ } }
  if (!raw) return null;
  let pay; try { pay = utxoPaymentTo(raw, n.id, me); } catch { return 'mismatch'; }
  if (pay.txid !== id || pay.paid <= 0n || pay.memo !== memo) return 'mismatch';
  let confirmed = false;
  for (const s of sources) { try { const stt = await s.status(id); if (stt.found && stt.confirmed) { confirmed = true; break; } } catch { /* next source */ } }
  return { amount: pay.paid, confirmed };
}

export const liveDeps: XswapDeps = {
  async status(inTxid) {
    const rs = await Promise.all(THORNODE_OPERATORS.map((o) => thorGet(`${o.base}/thorchain/tx/status/${inTxid}`).then(reduceThorStatus, () => null)));
    return agreeThorStatus(rs.filter((x): x is ThorStatus => x !== null));
  },
  async vaultActive(p) {
    try { await vaultCheck(wantOf(p).want); return true; }
    catch (e) { return /^only \d+ THORNode/.test((e as Error).message) ? null : false; }
  },
  outboundSeen,
};

export async function advanceXswap(p: ProposalRow, deps: XswapDeps = liveDeps, manual = false): Promise<ProposalRow> {
  if (p.kind !== 'xswap' || !p.xswap || !p.txid || !['broadcast', 'confirming', 'finalized', 'reorged'].includes(p.state)) return p;
  let b = p.xswap;
  if (xswapTerminal(b)) return p;
  if (b.phase === 'sending') b = { ...b, phase: 'sent', sentAt: b.sentAt ?? now() }; // signed and relayed by an earlier process
  if (!manual && b.nextAt > now()) return p;
  const inTxid = thorTxId(p.txid);
  const obs: XswapObs = { now: now(), sourceState: p.state, status: await deps.status(inTxid).catch(() => null) };
  if (b.phase === 'sent' && p.state === 'broadcast' && !obs.status?.observed) obs.vaultActive = await deps.vaultActive(p).catch(() => null);
  let r = xswapNext(b, obs, inTxid);
  if (r.b.phase === 'outbound') { // the outbound is named: look for it ourselves, in the same pass
    const seen = await deps.outboundSeen(p, r.b).catch(() => null);
    const r2 = xswapNext(r.b, { ...obs, seen }, inTxid);
    r = { b: r2.b, events: [...r.events, ...r2.events] };
  }
  if (r.b.phase === 'received' && r.b.received) await sql`update proposals set out_amount = ${r.b.received} where id = ${p.id}`;
  const saved = await save(p, r.b);
  for (const [type, data] of r.events) await audit(type, type === 'xswap.hold' ? 'system' : 'chain', { id: p.id, ...data });
  return saved;
}

/** Worker tick: every cross-chain swap whose source transaction is out and whose outcome is not known yet. */
export async function advanceXswaps(): Promise<void> {
  const rows = await sql<ProposalRow[]>`select * from proposals where kind = 'xswap' and state in ('broadcast', 'confirming', 'finalized', 'reorged') and coalesce(xswap->>'phase', '') not in ('received', 'refunded') order by created_at`;
  for (const p of rows) { try { await advanceXswap(p); } catch (e) { console.log(`[worker] xswap ${p.id}: ${(e as Error).message}`); } }
}
