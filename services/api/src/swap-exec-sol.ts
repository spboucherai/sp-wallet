// Swap execution on Solana through Jupiter (Swap API V2 "Router", GET /build — to be labelled "Metis" towards the owner).
// The API asks for the instructions of a v1 transaction (no address lookup tables), arranges them in the only shape the
// signer accepts (packages/core/src/swap-sol.ts), verifies them exactly as the signer will, and simulates the exact bytes.
// Nothing here can make the signer accept a transaction it has not decoded and checked itself.
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { z } from 'zod';
import {
  arrangeJupiterInstructions, associatedTokenAddress, ATA_PROGRAM, BPF_UPGRADEABLE_LOADER, checkPolicy, compileSolV1Message, decodeSolV1Message, formatUnits, getAsset, getNetwork, IntentSchema, intentHash,
  JUPITER_PIN, JUPITER_PROGRAM, parseUnits, RENT_TOKEN_ACCOUNT, solAddress, SOL_SIGNATURE_FEE, solMessageHash, solV1Wire, SYSTEM_PROGRAM, toB64u, toHex, TOKEN_PROGRAM, tokenProgramOf,
  verifyJupiterSwap, WSOL_MINT, type AssetDef, type Intent, type JupiterSwapFacts, type NetworkDef, type SolIxInput,
} from '@spw/core';
import { listCreds } from './auth.ts';
import { adapterFor } from './chains/index.ts';
import { http, rpcAny, rpcQuorum } from './chains/rpc.ts';
import { config, UserError } from './config.ts';
import { audit, sql } from './db.ts';
import { rpcOverridden } from './rpc-override.ts';
import { addressFor, signer } from './signer-client.ts';
import { broadcastNow, move, view, type ProposalRow } from './transfers.ts';

/** The label Jupiter's licence requires for any use of the API other than Ultra (SDK & API License Agreement §2.3). */
export const JUPITER_LABEL = 'Jupiter (Metis)';
const JUP_API = () => process.env.SPW_JUPITER_API ?? 'https://api.jup.ag/swap/v2';
const RENT_SYSTEM = 890_880n, MAX_CU = 400_000, MAX_PRICE = 2_000_000n, LOADED_DATA_LIMIT = 64 * 1024 * 1024;
const pubkey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const u64 = z.string().regex(/^(0|[1-9]\d{0,19})$/);
const Ix = z.object({ programId: pubkey, accounts: z.array(z.object({ pubkey, isSigner: z.boolean(), isWritable: z.boolean() })).max(255), data: z.string().max(4096).regex(/^[A-Za-z0-9+/]*={0,2}$/) });
/** GET /build with transactionVersion=1: no compute-budget instructions, no lookup tables, the price as a field. */
const BuildV1 = z.object({
  inputMint: pubkey, outputMint: pubkey, inAmount: u64, outAmount: u64, swapMode: z.literal('ExactIn'), slippageBps: z.number().int().min(0).max(10_000),
  routePlan: z.array(z.object({ swapInfo: z.object({ label: z.string().min(1).max(64) }) })).min(1).max(32),
  computeBudgetInstructions: z.array(Ix).max(0), setupInstructions: z.array(Ix).max(16), swapInstruction: Ix, cleanupInstruction: Ix.nullable(),
  otherInstructions: z.array(Ix).max(0), tipInstruction: z.null().optional(), platformFee: z.null().optional(),
  addressesByLookupTableAddress: z.record(z.string(), z.unknown()).nullable().refine((r) => !r || Object.keys(r).length === 0, 'lookup tables in a v1 answer'),
  transactionVersion: z.literal(1), computeUnitPrice: u64,
});
type Build = z.infer<typeof BuildV1>;
const toIx = (x: z.infer<typeof Ix>): SolIxInput => ({ program: x.programId, accounts: x.accounts.map((a) => ({ pubkey: a.pubkey, signer: a.isSigner, writable: a.isWritable })), data: new Uint8Array(Buffer.from(x.data, 'base64')) });
const mintOf = (a: AssetDef) => (a.id === 'native' ? WSOL_MINT : a.id);
const programOf = (a: AssetDef) => (a.id === 'native' ? TOKEN_PROGRAM : tokenProgramOf(a));

// Keyless limit: 0.5 request/s shared with the quote path (measured: 5 requests per 10 s). One call every 2.1 s from here.
let nextCall = 0;
export async function jupiterBuild(q: Record<string, string>): Promise<Build | { noRoute: true }> {
  const wait = nextCall - Date.now(); nextCall = Math.max(Date.now(), nextCall) + (rpcOverridden ? 0 : 2100); // no pacing against a test double
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const key = process.env.JUPITER_API_KEY?.trim();
  let r: Response;
  try { r = await http(`${JUP_API()}/build?${new URLSearchParams(q)}`, key ? { headers: { 'x-api-key': key } } : {}); }
  catch { throw new UserError('provider_unavailable', 'the swap provider did not answer; nothing was signed', 503); }
  const j = await r.json().catch(() => null) as { error?: unknown } | null;
  if (r.status === 429) throw new UserError('provider_busy', 'the swap provider is rate-limiting requests; try again in a few seconds', 503);
  if (r.status === 400 && typeof j?.error === 'string' && ['No routes found', 'Insufficient liquidity'].includes(j.error)) return { noRoute: true };
  const p = BuildV1.safeParse(j);
  if (!r.ok || !p.success) throw new UserError('provider_bad_answer', `the swap provider returned an unexpected answer${typeof j?.error === 'string' ? `: ${j.error.slice(0, 80)}` : ''}`, 502);
  return p.data;
}

type Acct = { owner: string; executable: boolean; lamports: number; data: [string, string] | { parsed?: { type?: string; info?: Record<string, any> } } } | null;
let codeCheckedAt = 0;
/**
 * The pinned aggregator program must still be the reviewed deployment on every source: an upgrade rewrites the ProgramData
 * header (slot of last deployment), and the executable itself is re-hashed every six hours. The wallet address must be a
 * plain system account, and a Token-2022 mint must carry neither a transfer fee nor a transfer hook.
 */
export async function jupiterGuards(n: NetworkDef, me: string, assets: AssetDef[]): Promise<void> {
  if ((await rpcQuorum<string>(n.rpc, 'getGenesisHash', [])) !== n.chainRef) throw new UserError('rpc_degraded', 'cluster identity mismatch; swap refused', 503);
  const changed = () => new UserError('router_changed', 'the Jupiter program is not the reviewed deployment (it was upgraded or replaced); swaps are refused', 503);
  const prog = (await rpcQuorum<{ value: Acct }>(n.rpc, 'getAccountInfo', [JUPITER_PROGRAM, { encoding: 'base64', commitment: 'finalized' }], (a, b) => JSON.stringify(a.value) === JSON.stringify(b.value))).value;
  const pd = prog && Array.isArray(prog.data) ? Buffer.from(prog.data[0], 'base64') : null;
  if (!prog || !pd || prog.owner !== BPF_UPGRADEABLE_LOADER || !prog.executable || pd.length !== 36 || pd.readUInt32LE(0) !== 2 || JUPITER_PIN.programData !== solAddress(pd.subarray(4, 36))) throw changed();
  const head = (await rpcQuorum<{ value: Acct }>(n.rpc, 'getAccountInfo', [JUPITER_PIN.programData, { encoding: 'base64', commitment: 'finalized', dataSlice: { offset: 0, length: 45 } }], (a, b) => JSON.stringify(a.value?.data) === JSON.stringify(b.value?.data) && a.value?.owner === b.value?.owner)).value;
  const h = head && Array.isArray(head.data) ? Buffer.from(head.data[0], 'base64') : null;
  if (!head || !h || head.owner !== BPF_UPGRADEABLE_LOADER || h.length !== 45 || h.readUInt32LE(0) !== 3 || Number(h.readBigUInt64LE(4)) !== JUPITER_PIN.lastDeploySlot || h[12] !== 1 || solAddress(h.subarray(13, 45)) !== JUPITER_PIN.upgradeAuthority) throw changed();
  if (!rpcOverridden && Date.now() - codeCheckedAt > 6 * 3600_000) { // 2.9 MB per source: not on every swap
    for (const u of n.rpc) {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(40_000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [JUPITER_PIN.programData, { encoding: 'base64', commitment: 'finalized' }] }) })
        .then((x) => x.json() as Promise<{ result?: { value: Acct } }>).catch(() => null);
      const d = r?.result?.value && Array.isArray(r.result.value.data) ? Buffer.from(r.result.value.data[0], 'base64') : null;
      if (!d) throw new UserError('rpc_degraded', 'could not read the Jupiter program to check it; swap refused', 503);
      if (createHash('sha256').update(d.subarray(45)).digest('hex') !== JUPITER_PIN.codeSha256) throw changed();
    }
    codeCheckedAt = Date.now();
  }
  const w = (await rpcQuorum<{ value: Acct }>(n.rpc, 'getAccountInfo', [me, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }], (a, b) => a.value?.owner === b.value?.owner && a.value?.executable === b.value?.executable)).value;
  if (!w || w.owner !== SYSTEM_PROGRAM || w.executable) throw new UserError('account_not_plain', 'this wallet address is not a plain system account; swaps are refused', 503);
  for (const a of assets) {
    if (a.program !== 'token2022') continue;
    const m = (await rpcQuorum<{ value: Acct }>(n.rpc, 'getAccountInfo', [a.id, { encoding: 'jsonParsed', commitment: 'finalized' }], (x, y) => JSON.stringify(x.value?.data) === JSON.stringify(y.value?.data))).value;
    const info = m && !Array.isArray(m.data) ? m.data.parsed?.info : undefined;
    if (!info) throw new UserError('rpc_degraded', `could not read the ${a.symbol} mint; swap refused`, 503);
    for (const e of (info.extensions ?? []) as { extension: string; state?: Record<string, any> }[]) {
      if (e.extension === 'transferFeeConfig' && (Number(e.state?.newerTransferFee?.transferFeeBasisPoints ?? 1) !== 0 || Number(e.state?.olderTransferFee?.transferFeeBasisPoints ?? 1) !== 0))
        throw new UserError('token_has_fee', `${a.symbol} currently charges a transfer fee; swaps of it are refused`, 422);
      if (e.extension === 'transferHook' && e.state?.programId) throw new UserError('token_has_hook', `${a.symbol} runs a transfer hook program; swaps of it are refused`, 422);
    }
  }
}

export interface SolMeta { err: unknown; fee?: number; preBalances?: number[]; postBalances?: number[]; preTokenBalances?: TokBal[]; postTokenBalances?: TokBal[]; unitsConsumed?: number; logs?: string[] | null }
type TokBal = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };
export interface SwapEffects { spent: bigint; received: bigint; lamportsDelta: bigint; fee: bigint; rentKept: bigint; otherLosses: string[] }
/**
 * What a transaction (simulated or confirmed) did to the wallet, from its balance tables. `keys` is the message's own
 * account list (v1: nothing is loaded from tables). Throws when the tables are missing.
 */
export function swapEffects(f: Pick<JupiterSwapFacts, 'message' | 'sourceAccount' | 'destinationAccount' | 'inMint' | 'outMint' | 'creates'>, meta: SolMeta): SwapEffects {
  const keys = f.message.keys, me = keys[0]!;
  if (!meta.preBalances || !meta.postBalances || !meta.preTokenBalances || !meta.postTokenBalances || meta.preBalances.length !== keys.length || meta.fee === undefined) throw new Error('balance tables missing');
  const lam = (k: string, t: number[]) => BigInt(t[keys.indexOf(k)] ?? 0);
  const tok = (k: string, t: TokBal[]) => BigInt(t.find((b) => b.accountIndex === keys.indexOf(k))?.uiTokenAmount.amount ?? '0');
  const fee = BigInt(meta.fee), lamportsDelta = lam(me, meta.postBalances) - lam(me, meta.preBalances);
  const rentKept = f.creates.reduce((s, c) => s + (lam(c, meta.preBalances!) === 0n ? lam(c, meta.postBalances!) : 0n), 0n);
  const solIn = f.inMint === WSOL_MINT, solOut = f.outMint === WSOL_MINT;
  // the wrapped-SOL account is closed at the end: whatever it held before comes back to the wallet as well
  const wsolBefore = solIn ? lam(f.sourceAccount, meta.preBalances) : solOut ? lam(f.destinationAccount, meta.preBalances) : 0n;
  const net = lamportsDelta + fee + rentKept - wsolBefore; // lamports moved by the swap itself
  const spent = solIn ? -net : tok(f.sourceAccount, meta.preTokenBalances) - tok(f.sourceAccount, meta.postTokenBalances);
  const received = solOut ? net : tok(f.destinationAccount, meta.postTokenBalances) - tok(f.destinationAccount, meta.preTokenBalances);
  const otherLosses: string[] = [];
  if (!solIn && !solOut && net !== 0n) otherLosses.push(`lamports ${net}`);
  for (const b of meta.preTokenBalances) {
    const k = keys[b.accountIndex];
    if (b.owner !== me || !k || k === f.sourceAccount || k === f.destinationAccount) continue;
    if (tok(k, meta.postTokenBalances) < BigInt(b.uiTokenAmount.amount)) otherLosses.push(k);
  }
  return { spent, received, lamportsDelta, fee, rentKept, otherLosses };
}

async function simulate(n: NetworkDef, wire: string, o: { sigVerify: boolean; replaceRecentBlockhash: boolean }): Promise<SolMeta> {
  return (await rpcAny<{ value: SolMeta }>(n.rpc, 'simulateTransaction', [wire, { encoding: 'base64', commitment: 'confirmed', sigVerify: o.sigVerify, replaceRecentBlockhash: o.replaceRecentBlockhash }])).value;
}
const simError = (s: SolMeta) => `${JSON.stringify(s.err).slice(0, 90)} ${(s.logs ?? []).filter((l) => /error|failed|insufficient|exceeded/i.test(l)).slice(-2).join(' | ').slice(0, 180)}`.trim();

export interface PreparedSolSwap {
  intent: Intent; message: string; expected: bigint; minOut: bigint; simulatedOut: bigint; facts: JupiterSwapFacts; effects: SwapEffects;
  labels: string[]; converted: boolean; attempts: number; unitsConsumed: number; networkFee: bigint; rent: bigint; maxFee: bigint; build: unknown;
}
/**
 * Prepare a firm Jupiter swap for an address: guards, balances, a fresh route (up to three, leaving out the venues of a
 * route that could not be put in the verifiable form), the signer's own verification, and a simulation of the exact bytes
 * that proves the swap succeeds now, delivers at least the minimum and touches nothing else of the wallet. Signs nothing.
 */
export async function prepareJupiterSwap(o: { n: NetworkDef; me: string; keyId: string; fromAsset: string; toAsset: string; amount: bigint; slippageBps: number; policyVersion: number; proposalId: string; feeCeiling: bigint; ttlSec?: number }): Promise<PreparedSolSwap> {
  const { n, me, amount } = o;
  let src: AssetDef, dst: AssetDef;
  try { src = getAsset(n.id, o.fromAsset); dst = getAsset(n.id, o.toAsset); } catch { throw new UserError('unsupported_asset', 'asset is not in the wallet registry'); }
  if (src.id === dst.id) throw new UserError('same_asset', 'choose two different assets');
  if (amount <= 0n || amount >= 1n << 64n) throw new UserError('bad_amount', 'amount must be greater than zero');
  await jupiterGuards(n, me, [src, dst]);
  const a = adapterFor(n.id);
  const bal = await a.balances(me);
  if (a.disabledAssets?.().some((d) => d === src.id || d === dst.id)) throw new UserError('unsupported_asset', 'this token failed its on-chain identity check and is disabled');
  const srcAta = associatedTokenAddress(me, mintOf(src), programOf(src)), dstAta = associatedTokenAddress(me, mintOf(dst), programOf(dst));
  type Parsed = { value: ({ lamports: number; data: { parsed?: { info?: { tokenAmount?: { amount: string } } } } } | null)[] };
  const ataInfo = await rpcAny<Parsed>(n.rpc, 'getMultipleAccounts', [[srcAta, dstAta], { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  if (src.id === 'native') { if ((bal.native ?? 0n) < amount) throw new UserError('insufficient_funds', 'insufficient SOL balance'); }
  else if (BigInt(ataInfo.value[0]?.data.parsed?.info?.tokenAmount?.amount ?? '0') < amount) throw new UserError('insufficient_funds', `insufficient ${src.symbol} in the wallet's associated token account`);

  let exclude: string[] = [], lastWhy = 'no route for this pair and amount right now', attempts = 0;
  for (; attempts < 3;) {
    attempts++;
    const b = await jupiterBuild({ inputMint: mintOf(src), outputMint: mintOf(dst), amount: amount.toString(), taker: me, slippageBps: String(o.slippageBps), transactionVersion: '1',
      ...(exclude.length ? { excludeDexes: exclude.join(',') } : {}), ...(attempts === 3 ? { maxAccounts: '32' } : {}) });
    if ('noRoute' in b) break;
    const labels = [...new Set(b.routePlan.map((l) => l.swapInfo.label))];
    exclude = [...new Set([...exclude, ...labels])];
    if (b.inputMint !== mintOf(src) || b.outputMint !== mintOf(dst) || BigInt(b.inAmount) !== amount || b.slippageBps !== o.slippageBps) throw new UserError('provider_bad_answer', 'the provider answered for another swap', 502);
    try {
      const expected = BigInt(b.outAmount);
      // program token accounts the shared-accounts form relies on: take the first authority (0..7) that has them all
      let arranged: ReturnType<typeof arrangeJupiterInstructions> | null = null;
      for (let id = 0; id < 8 && !arranged; id++) {
        const c = arrangeJupiterInstructions({ setup: b.setupInstructions.map(toIx), swap: toIx(b.swapInstruction), cleanup: b.cleanupInstruction ? toIx(b.cleanupInstruction) : null, authorityId: id });
        if (!c.converted) { arranged = c; break; }
        const have = await rpcAny<{ value: (object | null)[] }>(n.rpc, 'getMultipleAccounts', [c.programAccounts, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }]);
        if (have.value.every((x) => x !== null)) arranged = c;
      }
      if (!arranged) throw new Error('the aggregator has no shared account for one of the route\'s tokens');
      const bh = await rpcAny<{ value: { blockhash: string; lastValidBlockHeight: number } }>(n.rpc, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
      const compile = (limit: number, price: bigint) => compileSolV1Message({ payer: me, blockhash: bh.value.blockhash, instructions: arranged!.instructions, computeUnitLimit: limit, priorityFeeLamports: (BigInt(limit) * price + 999_999n) / 1_000_000n, loadedAccountsDataSizeLimit: LOADED_DATA_LIMIT });
      const now = Math.floor(Date.now() / 1000);
      const draft = (limit: number, price: bigint, minOut: bigint, maxFee: bigint, createAta: boolean, msg: Uint8Array): Intent => IntentSchema.parse({
        v: 1, proposalId: o.proposalId, keyId: o.keyId, network: n.id, chainRef: n.chainRef, asset: src.id, symbol: src.symbol, decimals: src.decimals, amount: amount.toString(),
        from: me, to: me, maxFee: maxFee.toString(), createdAt: now, expiresAt: now + (o.ttlSec ?? 50), policyVersion: o.policyVersion,
        swap: { provider: 'jupiter', toAsset: dst.id, minOut: minOut.toString(), router: JUPITER_PROGRAM, dataHash: solMessageHash(msg), approveGas: '0' },
        sol: { recentBlockhash: bh.value.blockhash, lastValidBlockHeight: bh.value.lastValidBlockHeight, createAta, computeUnitLimit: limit, computeUnitPrice: price.toString() },
      });
      // first pass at the largest limit an intent can carry: structure check, then units actually used
      const probeMsg = compile(MAX_CU, 0n);
      const probe = verifyJupiterSwap(draft(MAX_CU, 0n, 1n, 10n ** 12n, decodeKept(probeMsg, me, src, dst), probeMsg), probeMsg);
      const s1 = await simulate(n, Buffer.from(solV1Wire(new Uint8Array(64), probeMsg)).toString('base64'), { sigVerify: false, replaceRecentBlockhash: false });
      if (s1.err) throw new Error(`the route fails in simulation (${simError(s1)})`);
      const units = s1.unitsConsumed ?? MAX_CU;
      const limit = Math.ceil(units * 1.25) + 15_000;
      if (limit > MAX_CU) throw new Error('the route needs more compute than a swap may use here');
      // priority fee: Jupiter's suggestion, capped, and lowered if the policy fee ceiling would otherwise be exceeded
      const room = o.feeCeiling - SOL_SIGNATURE_FEE - probe.rentMax;
      if (room < 0n) throw new UserError('fee_ceiling', 'creating the token account for the received asset costs more than the wallet\'s fee ceiling allows', 422);
      let price = BigInt(b.computeUnitPrice); if (price > MAX_PRICE) price = MAX_PRICE;
      if ((BigInt(limit) * price + 999_999n) / 1_000_000n > room) price = (room * 1_000_000n) / BigInt(limit);
      const msg = compile(limit, price);
      const networkFee = SOL_SIGNATURE_FEE + (BigInt(limit) * price + 999_999n) / 1_000_000n, maxFee = networkFee + probe.rentMax;
      const need = maxFee + (src.id === 'native' ? amount : 0n) + (probe.wrapsSol || probe.unwrapsSol ? (ataInfo.value[src.id === 'native' ? 0 : 1] ? 0n : RENT_TOKEN_ACCOUNT) : 0n);
      if ((bal.native ?? 0n) < need + RENT_SYSTEM) throw new UserError('insufficient_gas', `not enough SOL to pay the network fee${probe.creates.length ? ' and the rent of the new token account' : ''}${src.id === 'native' ? ' on top of the amount swapped' : ''} (0.00089088 SOL must remain in the wallet)`);
      const minOut = verifyJupiterSwap(draft(limit, price, 1n, maxFee, probe.creates.length > 0, msg), msg).minOut;
      const floor = (expected * BigInt(10_000 - o.slippageBps)) / 10_000n;
      if (minOut * 1000n < floor * 999n) throw new UserError('provider_bad_answer', 'the instruction guarantees less than the requested tolerance allows', 502);
      const intent = draft(limit, price, minOut, maxFee, probe.creates.length > 0, msg);
      const facts = verifyJupiterSwap(intent, msg); // exactly what the signer will run
      // the exact bytes, against the current state: must succeed, pay at least the minimum and cost nothing else
      const s2 = await simulate(n, Buffer.from(solV1Wire(new Uint8Array(64), msg)).toString('base64'), { sigVerify: false, replaceRecentBlockhash: false });
      if (s2.err) throw new Error(`the swap would fail right now (${simError(s2)})`);
      const fx = swapEffects(facts, s2);
      if (fx.spent !== amount) throw new Error(`simulation spends ${fx.spent} instead of ${amount}`);
      if (fx.received < minOut) throw new Error('simulated output is below the guaranteed minimum');
      if (fx.otherLosses.length) throw new Error('simulation shows another account of the wallet losing value');
      if (fx.fee !== networkFee || fx.rentKept > facts.rentMax) throw new Error('simulated cost differs from the computed cost');
      return { intent, message: Buffer.from(msg).toString('base64'), expected, minOut, simulatedOut: fx.received, facts, effects: fx, labels, converted: arranged.converted, attempts, unitsConsumed: units, networkFee, rent: fx.rentKept, maxFee, build: b };
    } catch (e) {
      if (e instanceof UserError) throw e;
      lastWhy = (e as Error).message; // this route cannot be put in the verifiable form: ask again without its venues
    }
  }
  throw new UserError(attempts === 0 || lastWhy.startsWith('no route') ? 'no_route' : 'route_not_verifiable', attempts > 0 && !lastWhy.startsWith('no route')
    ? `Jupiter offered no route that the signer can verify for this pair right now (${lastWhy.slice(0, 160)}); nothing was signed` : lastWhy, 422);
}
/** does the arranged message create (and keep) a token account for the received or sold asset? (mirrors the signer's rule) */
function decodeKept(msg: Uint8Array, me: string, src: AssetDef, dst: AssetDef): boolean {
  const wsol = src.id === 'native' ? associatedTokenAddress(me, WSOL_MINT, TOKEN_PROGRAM) : dst.id === 'native' ? associatedTokenAddress(me, WSOL_MINT, TOKEN_PROGRAM) : null;
  return decodeSolV1Message(msg).instructions.some((x) => x.program === ATA_PROGRAM && x.accounts[1] !== wsol);
}

const U = z.string().min(1).max(60);
/** POST /api/v1/swap/proposals for a Solana network: prepare, then offer the swap for passkey approval. */
export async function createSolSwapProposal(b: { network: string; fromAsset: string; toAsset: string; amount: string; slippageBps: number }, idem: string) {
  const n = getNetwork(b.network);
  let src, dst;
  try { src = getAsset(n.id, b.fromAsset); dst = getAsset(n.id, b.toAsset); } catch { throw new UserError('unsupported_asset', 'asset is not in the wallet registry'); }
  if (src.id === dst.id) throw new UserError('same_asset', 'choose two different assets');
  let amount: bigint;
  try { amount = parseUnits(U.parse(b.amount), src.decimals); } catch (e) { throw new UserError('bad_amount', (e as Error).message); }
  if (amount <= 0n) throw new UserError('bad_amount', 'amount must be greater than zero');
  const st = await signer.status(true);
  if (st.halted) throw new UserError('halted', 'emergency halt is active', 423);
  const me = addressFor(st, n.id);
  const [busy] = await sql<{ id: string }[]>`select id from proposals where network = ${n.id} and state in ('approved', 'signed', 'broadcast') limit 1`;
  if (busy) throw new UserError('pending_tx', 'a previous transfer or swap on this network is not confirmed yet; wait for it before starting another', 409);
  const ceiling = BigInt(st.policy.maxFee[n.id] ?? '0');
  const id = randomUUID();
  const ps = await prepareJupiterSwap({ n, me, keyId: st.keyId, fromAsset: src.id, toAsset: dst.id, amount, slippageBps: b.slippageBps, policyVersion: st.policy.version, proposalId: id, feeCeiling: ceiling });
  const { intent } = ps, now = intent.createdAt;
  const verdict = checkPolicy(st.policy, intent, BigInt(st.spentToday[`${n.id}:${src.symbol}`] ?? '0'), now, st.halted);
  if (!verdict.ok) throw new UserError('policy', verdict.reason, 422);
  const hash = intentHash(intent);
  const swap = { provider: 'jupiter', toAsset: dst.id, toSymbol: dst.symbol, toDecimals: dst.decimals, expectedOut: ps.expected.toString(), minOut: ps.minOut.toString(), slippageBps: b.slippageBps, needsApproval: false, simulated: true,
    detail: { label: JUPITER_LABEL, venues: ps.labels, instruction: ps.facts.kind, rewritten: ps.converted, simulatedOut: ps.simulatedOut.toString(), networkFee: ps.networkFee.toString(), priorityFee: (ps.networkFee - SOL_SIGNATURE_FEE).toString(),
      rent: ps.rent.toString(), createsAccount: ps.rent > 0n,
      simulatedOutDisplay: formatUnits(ps.simulatedOut, dst.decimals), networkFeeDisplay: formatUnits(ps.networkFee, 9), priorityFeeDisplay: formatUnits(ps.networkFee - SOL_SIGNATURE_FEE, 9), rentDisplay: formatUnits(ps.rent, 9), computeUnits: intent.sol!.computeUnitLimit, lastValidBlockHeight: intent.sol!.lastValidBlockHeight } };
  const [p] = await sql<ProposalRow[]>`insert into proposals (id, idempotency_key, state, kind, network, asset, symbol, decimals, amount, from_addr, to_addr, note, fee_estimate, max_fee, warnings, intent, intent_hash, aux, swap, expires_at)
    values (${id}, ${idem}, 'pending_approval', 'swap', ${n.id}, ${src.id}, ${src.symbol}, ${src.decimals}, ${amount.toString()}, ${me}, ${me}, ${`swap → ${dst.symbol}`}, ${(ps.networkFee + ps.rent).toString()}, ${ps.maxFee.toString()},
      ${sql.json(ps.rent > 0n ? ['creates_token_account'] : [])}, ${sql.json(intent as never)}, ${toHex(hash)}, ${sql.json({ swapMessage: ps.message })}, ${sql.json(swap)}, ${new Date(intent.expiresAt * 1000)})
    on conflict (idempotency_key) do nothing returning *`;
  if (!p) throw new UserError('conflict', 'duplicate request', 409);
  await audit('swap.prepared', 'owner', { id, network: n.id, provider: 'jupiter', from: src.symbol, to: dst.symbol, amount: amount.toString(), minOut: swap.minOut, venues: ps.labels, rewritten: ps.converted, networkFee: swap.detail.networkFee, rent: swap.detail.rent, hash: toHex(hash) });
  const creds = await listCreds();
  const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', challenge: new Uint8Array(hash), timeout: 45_000, allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as never })) });
  if (options.challenge !== toB64u(hash)) throw new Error('challenge binding mismatch');
  return { proposal: view(p), options };
}

const factsOf = (p: ProposalRow): JupiterSwapFacts | null => {
  const m = (p.aux as { swapMessage?: string } | null)?.swapMessage;
  try { return m && p.intent ? verifyJupiterSwap(p.intent, new Uint8Array(Buffer.from(m, 'base64'))) : null; } catch { return null; }
};

/**
 * After signing: last gate before the transaction leaves. A blockhash that is no longer valid means the transaction can
 * never be included: it is failed without being sent (nothing moved). Otherwise the signed bytes are simulated with their
 * signature checked; an unreachable node means "try again on the next tick", never a second transaction.
 */
export async function advanceSolSwap(p: ProposalRow): Promise<ProposalRow> {
  if (p.state !== 'signed' || !p.raw || !p.intent?.sol) return p;
  const n = getNetwork(p.network);
  const fail = async (error: string) => { const r = await move(p, 'failed', { error }); await audit('swap.not_sent', 'system', { id: p.id, reason: error.slice(0, 160) }); return r; };
  if (!config.broadcast) return broadcastNow(p);
  const facts = factsOf(p);
  if (!facts) return fail('the stored swap no longer verifies; it was not sent');
  let height: number, sim: SolMeta;
  try {
    height = await rpcAny<number>(n.rpc, 'getBlockHeight', [{ commitment: 'confirmed' }]);
    if (height > p.intent.sol.lastValidBlockHeight) return await fail('the swap expired before it could be sent (blockhash too old); nothing was swapped');
    sim = await simulate(n, p.raw, { sigVerify: true, replaceRecentBlockhash: false });
  } catch (e) { if ((e as { rpcCode?: number }).rpcCode === undefined) return p; return fail(`the node refused the signed swap (${(e as Error).message.slice(0, 100)}); it was not sent`); }
  if (sim.err) return fail(`the swap would fail now (${simError(sim)}); it was not sent`);
  try {
    const fx = swapEffects(facts, sim);
    if (fx.received < BigInt(p.swap!.minOut) || fx.otherLosses.length || fx.spent !== BigInt(p.amount)) return await fail('the swap no longer delivers the approved minimum in simulation; it was not sent');
  } catch { return fail('the node did not report the simulated balances; the swap was not sent'); }
  return broadcastNow(p);
}

/** Once a Solana swap is confirmed, read what was actually received from the transaction's own balance tables. */
export async function recordSolSwapOutcome(p: ProposalRow): Promise<void> {
  if (p.kind !== 'swap' || !p.txid || p.out_amount !== null) return;
  const n = getNetwork(p.network), facts = factsOf(p);
  if (!facts) return;
  const tx = await rpcAny<{ meta: SolMeta | null } | null>(n.rpc, 'getTransaction', [p.txid, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]).catch(() => null);
  if (!tx?.meta || tx.meta.err) return;
  let fx: SwapEffects; try { fx = swapEffects(facts, tx.meta); } catch { return; }
  await sql`update proposals set out_amount = ${fx.received.toString()} where id = ${p.id} and out_amount is null`;
  await audit('swap.settled', 'chain', { id: p.id, txid: p.txid, received: fx.received.toString(), spent: fx.spent.toString(), minOut: p.swap?.minOut, fee: fx.fee.toString(), rent: fx.rentKept.toString() });
}

export function solSwapExecInfo() { return { provider: 'jupiter', label: JUPITER_LABEL, networks: ['solana'], program: JUPITER_PROGRAM, programData: JUPITER_PIN.programData, lastDeploySlot: JUPITER_PIN.lastDeploySlot }; }
