import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { z } from 'zod';
import {
  assertTransition, buildBtcTx, buildEvmTx, buildSolMessage, checkPolicy, formatUnits, getAsset, getNetwork, IntentSchema, intentHash,
  legacyState, lifecycleOf, normalizeAddress, parseUnits, pluginFor, toB64u, toHex, type Intent, type ProposalState,
} from '@spw/core';
import { adapterFor } from './chains/index.ts';
import { simulateSol } from './chains/sol.ts';
import { config, UserError } from './config.ts';
import { audit, sql, walletEvent } from './db.ts';
import { listCreds } from './auth.ts';
import { addressFor, signer } from './signer-client.ts';
import type { BridgeState } from './bridge.ts';
import { xswapView, type XswapState } from './xswap-state.ts';
import { svText, type SvCode, type SvParams } from './sv-texts.ts';
import { existingFor, idemOf, type QuoteRecord } from './prepare-common.ts';
import { executionOf } from './exec-status.ts';

/** The patch that records WHY a proposal ended: English sentence (API clients), code and parameters (the UI translates them). */
export const failure = (code: SvCode | (string & {}), params: SvParams = {}, message?: string) => ({
  error: (message ?? svText(code as SvCode, params)).slice(0, 300), error_code: code, error_params: Object.keys(params).length ? sql.json(params as never) : null });

export interface ProposalRow {
  id: string; state: ProposalState; version: number; network: string; asset: string; symbol: string; decimals: number; amount: string;
  from_addr: string; to_addr: string; note: string; memo: string | null; aux: Record<string, unknown> | null;
  kind: 'transfer' | 'swap' | 'bridge' | 'xswap' | 'gmx' /* v8: a GMX order action, followed by derivatives/gmx-exec.ts */ | 'nft' /* NFT delivery 2: one NFT transfer; its intent is an NftIntent (nft/transfer-routes.ts) */;
  /** NFT delivery 2: the review the owner approved (on-chain identifiers, simulation verdict) — nft/transfer.ts `NftReview` */ nft?: Record<string, unknown> | null; xswap?: XswapState | null; bridge: BridgeState | null; swap: { provider: string; toAsset: string; toSymbol: string; toDecimals: number; expectedOut: string; minOut: string; slippageBps: number; needsApproval: boolean; simulated: boolean } | null;
  pre_raw: string | null; pre_txid: string | null; pre_state: string | null; out_amount: string | null; fee_estimate: string | null; max_fee: string | null; warnings: string[];
  intent: Intent | null; intent_hash: string | null; raw: string | null; txid: string | null; block_ref: string | null; confirmations: number; error: string | null;
  /** v11: machine-readable reason behind `error` (the UI translates it; `error` stays the English fallback for API clients) */
  error_code?: string | null; error_params?: Record<string, string | number> | null;
  /** v11: the quote the owner was shown, next to the firm figures of the preparation (prepare-common.ts) */
  quote_ref?: QuoteRecord | null;
  created_at: Date; updated_at: Date; expires_at: Date | null; broadcast_at: Date | null; last_broadcast_at: Date | null; finalized_at: Date | null;
  /** NEXT (life cycle v2, db.ts): a relay started; since when no source knows the transaction; the negative verdict being repeated; the fee charged */
  relay_attempted_at?: Date | null; unseen_since?: Date | null; neg_verdict?: string | null; neg_since?: Date | null; neg_streak?: number; fee_paid?: string | null;
}

export function view(p: ProposalRow) {
  const n = getNetwork(p.network);
  return {
    // `state` keeps the vocabulary shipped clients know (their enums are closed): `dropped` reads `failed` there, with its code.
    // `lifecycle` is the NEXT vocabulary, the same on web, macOS and iOS; `finalized` tells "in a block" from "final".
    id: p.id, state: legacyState(p.state), lifecycle: lifecycleOf(p.state, { relayAttempted: !!p.relay_attempted_at, errorCode: p.error_code }), finalized: p.state === 'finalized',
    watched: p.state === 'dropped' || p.state === 'replaced', network: p.network, networkName: n.name, asset: p.asset, symbol: p.symbol, decimals: p.decimals,
    amount: p.amount, amountDisplay: formatUnits(BigInt(p.amount), p.decimals), from: p.from_addr, to: p.to_addr, note: p.note, memo: p.memo,
    feeEstimate: p.fee_estimate, maxFee: p.max_fee, feeSymbol: n.native.symbol, feeDecimals: n.native.decimals,
    feeDisplay: p.fee_estimate ? formatUnits(BigInt(p.fee_estimate), n.native.decimals) : null,
    maxFeeDisplay: p.max_fee ? formatUnits(BigInt(p.max_fee), n.native.decimals) : null,
    warnings: p.warnings, intentHash: p.intent_hash, txid: p.txid, explorer: p.txid && p.state !== 'not_broadcast' ? n.explorerTx + p.txid : null,
    confirmations: p.confirmations, error: p.error, errorCode: p.error_code ?? null, errorParams: p.error_params ?? null, createdAt: p.created_at, updatedAt: p.updated_at, expiresAt: p.expires_at,
    broadcastAt: p.broadcast_at, finalizedAt: p.finalized_at, relayAttemptedAt: p.relay_attempted_at ?? null,
    feePaid: p.fee_paid ?? null, feePaidDisplay: p.fee_paid ? formatUnits(BigInt(p.fee_paid), n.native.decimals) : null,
    kind: p.kind ?? 'transfer',
    swap: p.swap ? { provider: p.swap.provider, toAsset: p.swap.toAsset, toSymbol: p.swap.toSymbol, slippageBps: p.swap.slippageBps, needsApproval: p.swap.needsApproval, simulated: p.swap.simulated,
      expectedOut: p.swap.expectedOut, expectedOutDisplay: formatUnits(BigInt(p.swap.expectedOut), p.swap.toDecimals), minOut: p.swap.minOut, minOutDisplay: formatUnits(BigInt(p.swap.minOut), p.swap.toDecimals),
      received: p.out_amount, receivedDisplay: p.out_amount ? formatUnits(BigInt(p.out_amount), p.swap.toDecimals) : null,
      approvalTxid: p.pre_txid, approvalState: p.pre_raw ? (p.pre_state ?? 'pending') : null,
      /** provider-specific facts shown on the review sheet (Solana: licence label, venues, priority fee, token-account rent) */
      detail: (p.swap as { detail?: Record<string, unknown> }).detail ?? null } : null,
    bridge: p.bridge ? bridgeView(p, p.bridge) : null,
    xswap: p.xswap ? xswapView(p, p.xswap) : null,
    // v11, additive: one status shape for every kind (exec-status.ts), and the quote the owner was shown next to the firm figures
    execution: executionOf(p),
    nft: p.nft ?? null, // NFT delivery 2
    quote: p.quote_ref ? { ...p.quote_ref, quotedOutDisplay: formatUnits(BigInt(p.quote_ref.quotedOut), outDecimals(p)), firmOutDisplay: formatUnits(BigInt(p.quote_ref.firmOut), outDecimals(p)) } : null,
  };
}

/** Decimals of what the proposal delivers: the destination asset of a swap, the asset itself for a transfer or a CCTP transfer. */
const outDecimals = (p: ProposalRow): number => p.xswap?.toDecimals ?? p.swap?.toDecimals ?? p.decimals;

/** A cross-chain transfer as shown to the owner: route, Circle's fee, progress of the second leg. Message bytes stay server-side. */
function bridgeView(p: ProposalRow, b: BridgeState) {
  const d = getNetwork(b.toNetwork);
  // one word for the whole transfer: the burn follows the proposal state, then the mint has its own progress
  const stage = ['failed', 'expired', 'rejected', 'replaced'].includes(p.state) ? 'failed' : p.state === 'pending_approval' ? 'review'
    : b.phase === 'burn' ? 'burning' : b.phase === 'attesting' ? 'attesting' : b.phase === 'ready' ? 'ready' : b.phase === 'mint_sent' ? 'minting' : b.phase === 'mint_failed' ? 'mint_failed' : 'done';
  return { provider: b.provider, toNetwork: b.toNetwork, toNetworkName: d.name, speed: b.speed, expectedSeconds: b.expectedSeconds, stage, phase: b.phase,
    cctpMaxFee: b.maxFee, cctpMaxFeeDisplay: formatUnits(BigInt(b.maxFee), p.decimals), minReceiveDisplay: formatUnits(BigInt(p.amount) - BigInt(b.maxFee), p.decimals),
    feeExecutedDisplay: b.feeExecuted !== undefined ? formatUnits(BigInt(b.feeExecuted), p.decimals) : null, received: b.phase === 'done' ? (p.out_amount ?? b.minted ?? null) : null,
    receivedDisplay: b.phase === 'done' && (p.out_amount ?? b.minted) ? formatUnits(BigInt((p.out_amount ?? b.minted)!), p.decimals) : null,
    destGasSymbol: d.native.symbol, destGasNeedDisplay: formatUnits(BigInt(b.destGasNeed), d.native.decimals), needsApproval: b.needsApproval, simulated: b.simulated,
    approvalTxid: p.pre_txid, approvalState: p.pre_raw ? (p.pre_state ?? 'pending') : null,
    hold: b.hold ?? null, holdDetail: b.holdDetail ?? null, holdCode: b.hold ? b.holdCode ?? null : null, holdParams: b.hold ? b.holdParams ?? null : null, irisStatus: b.irisStatus ?? null, delayReason: b.delayReason ?? null, polls: b.polls, attested: !!b.message,
    mintTxid: b.mintTxid ?? b.mint?.txid ?? null, mintExplorer: (b.mintTxid ?? b.mint?.txid) ? d.explorerTx + (b.mintTxid ?? b.mint!.txid) : null, mintedBy: b.mintedBy ?? null,
    canFinish: !['failed', 'review', 'done', 'burning'].includes(stage), needsPasskey: b.phase === 'mint_failed',
    sol: b.sol ? solBridgeView(p, b) : null };
}

/** v8 — the Solana side of a Solana ↔ EVM transfer: the refundable event-account deposit and its reclaim, or the token account credited. */
function solBridgeView(p: ProposalRow, b: BridgeState) {
  const s = b.sol!, sn = getNetwork('solana'), r = s.reclaim, source = getNetwork(p.network).family === 'sol';
  const burned = ['confirming', 'finalized', 'reorged'].includes(p.state);
  // when the deposit comes back: five days after the event account was created (before the burn is mined: an estimate from now)
  const reclaimableAt = s.reclaimableAt ?? (source && !['failed', 'expired', 'rejected', 'replaced'].includes(p.state) ? Math.floor(Date.now() / 1000) + 5 * 86400 : null);
  const reclaimState = !source || !s.deposit ? null : r?.state === 'done' ? 'done' : r?.state === 'sent' ? 'sent' : !burned || !s.eventAccount ? 'pending'
    : s.reclaimableAt && Date.now() / 1000 >= s.reclaimableAt && b.message ? (r?.state === 'failed' ? 'failed' : 'available') : 'locked';
  return { role: source ? 'source' : 'destination', symbol: sn.native.symbol, recipient: s.recipient ?? null, tokenAccount: s.tokenAccount ?? null,
    nonceRentDisplay: s.nonceRent ? formatUnits(BigInt(s.nonceRent), 9) : null,
    eventAccount: s.eventAccount ?? null, deposit: s.deposit ?? null, depositDisplay: s.deposit ? formatUnits(BigInt(s.deposit), 9) : null,
    reclaimableAt: reclaimableAt ? new Date(reclaimableAt * 1000).toISOString() : null, reclaimEstimated: !s.reclaimableAt, reclaimState,
    reclaimError: r?.state === 'failed' ? (r.error ?? null) : null, reclaimTxid: r?.txid ?? null, reclaimExplorer: r?.txid ? sn.explorerTx + r.txid : null,
    reclaimedDisplay: r?.received ? formatUnits(BigInt(r.received), 9) : null };
}

/** Optimistic state change: only succeeds from the expected state and version. */
export async function move(p: ProposalRow, to: ProposalState, patch: Record<string, unknown> = {}): Promise<ProposalRow> {
  assertTransition(p.state, to);
  // an `error` written without a code (or cleared) never keeps the code of an earlier one
  if ('error' in patch && !('error_code' in patch)) patch = { ...patch, error_code: null, error_params: null };
  let r: ProposalRow | undefined;
  try {
    [r] = await sql<ProposalRow[]>`update proposals set ${sql({ ...patch, state: to, version: p.version + 1, updated_at: new Date() } as never)}
      where id = ${p.id} and state = ${p.state} and version = ${p.version} returning *`;
  } catch (e) { // NEXT: the database's own one-in-flight rule (db.ts `proposals_one_in_flight`) — two approvals in the same instant
    if ((e as { code?: string; constraint_name?: string }).code === '23505' && /proposals_one_in_flight/.test(String((e as { constraint_name?: string }).constraint_name ?? (e as Error).message)))
      throw new UserError('pending_tx', 'a previous transfer or swap on this network is not confirmed yet', 409);
    throw e;
  }
  if (!r) throw new UserError('conflict', 'proposal changed concurrently; reload', 409);
  await audit(`transfer.${to}`, 'system', { id: p.id, network: p.network, symbol: p.symbol, amount: p.amount, to: p.to_addr, txid: r.txid, hash: r.intent_hash, error: r.error });
  await walletEvent('transfer.state', p.id, { from: p.state, to, lifecycle: lifecycleOf(to, { relayAttempted: !!r.relay_attempted_at, errorCode: r.error_code }), network: p.network, kind: p.kind ?? 'transfer', txid: r.txid, confirmations: r.confirmations, errorCode: r.error_code ?? null });
  return r;
}

/** NFT delivery 2: what follows a tracked state change of a proposal (nft/transfer-routes.ts records the event and refreshes the inventory). Never signs. */
export const proposalHooks: { tracked: ((p: ProposalRow) => Promise<void>)[] } = { tracked: [] };

export const load = async (id: string): Promise<ProposalRow> => {
  if (!z.uuid().safeParse(id).success) throw new UserError('not_found', 'proposal not found', 404);
  const [p] = await sql<ProposalRow[]>`select * from proposals where id = ${id}`;
  if (!p) throw new UserError('not_found', 'proposal not found', 404);
  return p;
};

export async function destinationWarnings(network: string, to: string): Promise<string[]> {
  const w: string[] = [];
  const known = await sql<{ address: string }[]>`select address from address_book where network = ${network}
    union select to_addr from proposals where network = ${network} and state in ('finalized','confirming','broadcast')`;
  if (!known.some((k) => k.address === to)) {
    w.push('new_destination');
    const sig = (a: string) => a.slice(0, 6).toLowerCase() + a.slice(-4).toLowerCase();
    if (known.some((k) => k.address !== to && sig(k.address) === sig(to))) w.push('address_poisoning_suspected');
  }
  return w;
}

/**
 * NEXT — the same payment as a recent one whose fate is not "certainly did not happen": sent, confirming, confirmed, dropped
 * or replaced (both still watched), or failed after a relay had started. The owner is told before approving again; the
 * client makes him tick a box (same treatment as a new destination).
 */
export async function duplicateWarning(network: string, asset: string, to: string, amount: string): Promise<string[]> {
  const [d] = await sql<{ id: string }[]>`select id from proposals where network = ${network} and asset = ${asset} and to_addr = ${to} and amount = ${amount}
    and created_at > now() - interval '24 hours' and kind = 'transfer'
    and (state in ('signed', 'broadcast', 'confirming', 'reorged', 'finalized', 'dropped', 'replaced') or (state = 'failed' and relay_attempted_at is not null)) limit 1`;
  return d ? ['duplicate_recent'] : [];
}

/** NEXT — Bitcoin-style networks: the coins of the dropped transfers still watched on this network (see `mustSpend`, chains/btc.ts). */
export async function droppedCoins(network: string): Promise<string[][]> {
  const rows = await sql<{ intent: Intent | null }[]>`select intent from proposals where network = ${network} and state = 'dropped' and intent is not null`;
  return rows.map((r) => (r.intent?.btc?.inputs ?? []).map((i) => `${i.txid}:${i.vout}`)).filter((c) => c.length > 0);
}

const Create = z.strictObject({ network: z.string().max(20), asset: z.string().max(80), to: z.string().min(1).max(130), amount: z.string().min(1).max(80), note: z.string().max(80).default(''), memo: z.string().max(120).optional() });

export function transferRoutes(app: FastifyInstance): void {
  // draft + validation + simulation + policy pre-check
  app.post('/api/v1/transfers/proposals', async (req) => {
    const idem = String(req.headers['idempotency-key'] ?? '');
    if (!/^[A-Za-z0-9-]{16,64}$/.test(idem)) throw new UserError('idempotency', 'Idempotency-Key header required');
    const b = Create.parse(req.body), key = idemOf(req.headers, 'transfer', b);
    // the same key answers the same draft; since v11 the same key with ANOTHER body is refused instead of answering a transfer that was not asked for
    const dup = await existingFor(key);
    if (dup) return view(dup);
    const n = getNetwork(b.network);
    const asset = (() => { try { return getAsset(n.id, b.asset); } catch { throw new UserError('unsupported_asset', 'asset is not supported on this network'); } })();
    let to: string, amount: bigint;
    try { to = normalizeAddress(n.id, b.to); } catch (e) { throw new UserError('bad_address', `invalid ${n.name} address: ${(e as Error).message}`); }
    try { amount = parseUnits(b.amount, asset.decimals); } catch (e) { throw new UserError('bad_amount', (e as Error).message); }
    if (amount <= 0n) throw new UserError('bad_amount', 'amount must be greater than zero');
    let memo: string | undefined;
    if (b.memo !== undefined && b.memo !== '') {
      if (!n.memo) throw new UserError('bad_memo', `${n.name} transfers do not carry a memo`);
      if (n.memo === 'uint32' && !/^(0|[1-9]\d{0,9})$/.test(b.memo)) throw new UserError('bad_memo', 'the destination tag must be a whole number');
      if (n.memo === 'uint32' && Number(b.memo) > 0xffffffff) throw new UserError('bad_memo', 'destination tag out of range');
      memo = b.memo;
    }
    const st = await signer.status(true);
    const from = addressFor(st, n.id);
    if (to === from) throw new UserError('bad_address', 'destination is this wallet');
    const prep = await adapterFor(n.id).prepare({ asset: asset.id, from, to, amount, memo });
    const now = Math.floor(Date.now() / 1000);
    const probe = { network: n.id, symbol: asset.symbol, amount: amount.toString(), maxFee: prep.maxFee.toString(), to, policyVersion: st.policy.version, createdAt: now, expiresAt: now + 30 } as Intent;
    const verdict = checkPolicy(st.policy, probe, BigInt(st.spentToday[`${n.id}:${asset.symbol}`] ?? '0'), now, st.halted);
    if (!verdict.ok) throw new UserError('policy', verdict.reason, 422);
    const warnings = [...prep.warnings, ...(await destinationWarnings(n.id, to)), ...(await duplicateWarning(n.id, asset.id, to, amount.toString()))];
    const id = randomUUID();
    const [p] = await sql<ProposalRow[]>`insert into proposals (id, idempotency_key, request_hash, state, network, asset, symbol, decimals, amount, from_addr, to_addr, note, memo, fee_estimate, max_fee, warnings, expires_at)
      values (${id}, ${idem}, ${key.hash}, 'draft', ${n.id}, ${asset.id}, ${asset.symbol}, ${asset.decimals}, ${amount.toString()}, ${from}, ${to}, ${b.note}, ${memo ?? null}, ${prep.feeEstimate.toString()}, ${prep.maxFee.toString()}, ${sql.json(warnings)}, now() + interval '15 minutes') returning *`;
    await audit('transfer.draft', 'owner', { id, network: n.id, symbol: asset.symbol, amount: amount.toString(), to });
    return view(p!);
  });

  app.get('/api/v1/transfers/proposals/:id', async (req) => view(await load((req.params as { id: string }).id)));
  app.get('/api/v1/transfers/:id/status', async (req) => { const v = view(await load((req.params as { id: string }).id)); return { id: v.id, state: v.state, /* NEXT (additive): the same life-cycle members as the full view */ lifecycle: v.lifecycle, finalized: v.finalized, watched: v.watched, feePaid: v.feePaid, feePaidDisplay: v.feePaidDisplay, txid: v.txid, confirmations: v.confirmations, error: v.error, errorCode: v.errorCode, errorParams: v.errorParams, explorer: v.explorer, kind: v.kind, execution: v.execution }; });

  // freeze the exact chain parameters, re-simulate, and issue the approval challenge = intent hash
  app.post('/api/v1/transfers/proposals/:id/request-approval', async (req) => {
    let p = await load((req.params as { id: string }).id);
    if (p.state !== 'draft' && p.state !== 'pending_approval') throw new UserError('bad_state', `proposal is ${p.state}`, 409);
    if (p.kind === 'swap') throw new UserError('bad_state', 'a swap is prepared once; start a new one', 409);
    if (p.kind === 'bridge') throw new UserError('bad_state', 'a cross-chain transfer is prepared once; start a new one', 409);
    if (p.kind === 'xswap') throw new UserError('bad_state', 'a cross-chain swap is prepared once; start a new one', 409);
    if (p.kind === 'nft') throw new UserError('bad_state', 'an NFT transfer is prepared once; start a new one', 409); // NFT delivery 2
    const n = getNetwork(p.network), st = await signer.status(true);
    if (st.halted) throw new UserError('halted', 'emergency halt is active', 423);
    // One transfer in flight per network: a second one prepared before the first is confirmed would reuse the same
    // nonce / sequence / coins, and on some chains (Sui) could even lock those coins until the epoch ends.
    const [busy] = await sql<{ id: string }[]>`select id from proposals where network = ${p.network} and id <> ${p.id} and state in ('approved', 'signed', 'broadcast') limit 1`;
    if (busy) throw new UserError('pending_tx', 'a previous transfer on this network is not confirmed yet; wait for it before sending another', 409);
    // NEXT: a dropped transfer on a Bitcoin-style network is still valid bytes. The new transaction must spend at least one
    // of its coins, so that the two can never both confirm (EVM gets the same property from the nonce, which is reused).
    const mustSpend = n.family === 'btc' ? await droppedCoins(n.id) : [];
    const prep = await adapterFor(n.id).prepare({ asset: p.asset, from: p.from_addr, to: p.to_addr, amount: BigInt(p.amount), memo: p.memo ?? undefined, ...(mustSpend.length ? { mustSpend } : {}) });
    const now = Math.floor(Date.now() / 1000);
    const intent = IntentSchema.parse({
      v: 1, proposalId: p.id, keyId: st.keyId, network: n.id, chainRef: n.chainRef, asset: p.asset, symbol: p.symbol, decimals: p.decimals,
      amount: p.amount, from: p.from_addr, to: p.to_addr, maxFee: prep.maxFee.toString(), createdAt: now, expiresAt: now + prep.ttlSec,
      policyVersion: st.policy.version, ...(p.memo ? { memo: p.memo } : {}), ...prep.section,
    });
    // The API builds the same bytes the signer will rebuild; unsupported shapes fail here, before approval.
    try {
      if (n.family === 'evm') buildEvmTx(intent); else if (n.family === 'btc') buildBtcTx(intent, prep.aux);
      else if (n.family === 'sol') { buildSolMessage(intent); await simulateSol(n, intent); }
      else pluginFor(n).build(intent, n, prep.aux);
    }
    catch (e) { if (e instanceof UserError) throw e; throw new UserError('simulation_failed', (e as Error).message); }
    const verdict = checkPolicy(st.policy, intent, BigInt(st.spentToday[`${n.id}:${p.symbol}`] ?? '0'), now, st.halted);
    if (!verdict.ok) throw new UserError('policy', verdict.reason, 422);
    const hash = intentHash(intent);
    const patch = { aux: prep.aux ? sql.json(prep.aux as never) : null, intent: sql.json(intent as never), intent_hash: toHex(hash), max_fee: prep.maxFee.toString(), fee_estimate: prep.feeEstimate.toString(), expires_at: new Date(intent.expiresAt * 1000) };
    if (p.state === 'draft') p = await move(p, 'pending_approval', patch);
    else { // re-issue: a new immutable version replaces the previous challenge
      const [r] = await sql<ProposalRow[]>`update proposals set ${sql({ ...patch, version: p.version + 1, updated_at: new Date() } as never)} where id = ${p.id} and state = 'pending_approval' and version = ${p.version} returning *`;
      if (!r) throw new UserError('conflict', 'proposal changed concurrently; reload', 409);
      p = r;
    }
    const creds = await listCreds();
    const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', challenge: new Uint8Array(hash), timeout: prep.ttlSec * 1000,
      allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as never })) });
    if (options.challenge !== toB64u(hash)) throw new Error('challenge binding mismatch');
    return { proposal: view(p), intent, options };
  });

  // The HTTP call is not the approval: the passkey assertion over the intent hash is, and only the signer judges it.
  app.post('/api/v1/transfers/proposals/:id/approve', async (req) => {
    const body = z.object({ assertion: z.record(z.string(), z.unknown()) }).parse(req.body);
    let p = await load((req.params as { id: string }).id);
    if (p.state !== 'pending_approval' || !p.intent) throw new UserError('bad_state', `proposal is ${p.state}`, 409);
    // NFT delivery 2: an NFT transfer is approved on its own route (it goes to the signer's NFT route, with an NFT intent)
    if (p.kind === 'nft') throw new UserError('bad_state', 'an NFT transfer is approved through /api/v1/nfts/transfer', 409);
    if (p.expires_at && p.expires_at.getTime() < Date.now()) { await move(p, 'expired', failure('approval_expired')); throw new UserError('expired', 'approval window expired; start again', 410); }
    // one transfer or swap in flight per network, checked again at the moment of approval
    const [busy] = await sql<{ id: string }[]>`select id from proposals where network = ${p.network} and id <> ${p.id} and state in ('approved', 'signed', 'broadcast') limit 1`;
    if (busy) throw new UserError('pending_tx', 'a previous transfer or swap on this network is not confirmed yet', 409);
    // a cross-chain mint being signed or sent on this network uses the same nonce space
    const [minting] = await sql<{ id: string }[]>`select id from proposals where kind = 'bridge' and bridge->>'toNetwork' = ${p.network} and bridge->>'phase' = 'mint_sent' and state in ('confirming', 'finalized', 'reorged') limit 1`;
    if (minting) throw new UserError('pending_tx', 'a cross-chain transfer is being received on this network; wait for it', 409);
    p = await move(p, 'approved');
    let signed: { raw: string; txid: string; hash: string; pre?: { raw: string; txid: string } };
    try { signed = await signer.sign(p.intent, body.assertion, p.aux ?? undefined); }
    catch (e) { const code = (e as { code?: string }).code; await move(p, 'failed', failure(code && /^signer_/.test(code) ? code : 'signer_refused', { detail: (e as Error).message.slice(0, 200) }, (e as Error).message)); throw e; }
    if (signed.hash !== p.intent_hash) { await move(p, 'failed', failure('signer_hash_mismatch')); throw new UserError('hash_mismatch', 'signer returned a different intent hash', 500); }
    p = await move(p, 'signed', { raw: signed.raw, txid: signed.txid, ...(signed.pre ? { pre_raw: signed.pre.raw, pre_txid: signed.pre.txid } : {}) });
    if (p.kind === 'swap') { const { advanceSwap } = await import('./swap-exec.ts'); return view(await advanceSwap(p)); }
    if (p.kind === 'bridge') { const { advanceBridgeBurn } = await import('./bridge.ts'); return view(await advanceBridgeBurn(p)); }
    if (p.kind === 'xswap') { const { advanceXswapSend } = await import('./xswap.ts'); return view(await advanceXswapSend(p)); }
    return view(await broadcastNow(p));
  });

  app.post('/api/v1/transfers/proposals/:id/reject', async (req) => {
    const p = await load((req.params as { id: string }).id);
    if (p.state !== 'draft' && p.state !== 'pending_approval') throw new UserError('bad_state', `proposal is ${p.state}`, 409);
    return view(await move(p, 'rejected', failure('rejected_by_owner')));
  });
}

/**
 * Relay signed bytes. A returned hash is not success: state stays "broadcast" until the chain confirms.
 *
 * NEXT (life cycle v2):
 *  - `relay_attempted_at` is written BEFORE the network call. From that instant "nothing was sent" can only be said by the
 *    chain: a crash, a time-out or an error answer no longer proves anything (a node may have accepted the bytes).
 *  - a relay error is followed by a look-up of the transaction. If the network already has it — it was accepted by an
 *    earlier attempt whose answer was lost, and may even be mined ("nonce too low", "inputs spent") — the row moves to
 *    `broadcast` and the tracker takes over. Otherwise it stays `signed` and the worker tries again.
 */
export async function broadcastNow(p: ProposalRow): Promise<ProposalRow> {
  const raw = p.raw;
  if (!raw) return p;
  // v11 (B2): broadcasting disabled = the transaction was signed and deliberately NOT relayed. That is its own terminal state:
  // it is not "broadcast" (nothing left this server), it never confirms, and it does not hold the network's in-flight slot.
  if (!config.broadcast) return move(p, 'not_broadcast', failure('broadcast_disabled'));
  const a = adapterFor(p.network);
  if (!p.relay_attempted_at) {
    const [r] = await sql<ProposalRow[]>`update proposals set relay_attempted_at = now() where id = ${p.id} and relay_attempted_at is null returning *`;
    if (r) { p = { ...p, relay_attempted_at: r.relay_attempted_at }; await walletEvent('transfer.relay', p.id, { network: p.network, lifecycle: 'broadcasting', txid: p.txid }); }
  }
  try {
    await a.broadcast(raw);
    return await move(p, 'broadcast', { broadcast_at: new Date(), last_broadcast_at: new Date(), error: null });
  } catch (e) {
    if (p.txid && p.intent && await knownToNetwork(p).catch(() => false))
      return move(p, 'broadcast', { broadcast_at: p.relay_attempted_at ?? new Date(), last_broadcast_at: new Date(), error: null });
    const f = failure('broadcast_attempt_failed', { detail: (e as Error).message.slice(0, 200) });
    await sql`update proposals set error = ${f.error}, error_code = ${f.error_code}, error_params = ${f.error_params}, updated_at = now() where id = ${p.id}`;
    return (await sql<ProposalRow[]>`select * from proposals where id = ${p.id}`)[0]!;
  }
}

/** The intent whose transaction `p.txid` is: a swap / bridge / native swap / GMX order preceded by an approval uses the next nonce. */
export const trackedIntent = (p: ProposalRow): Intent | null =>
  p.intent && (p.kind === 'swap' || p.kind === 'bridge' || p.kind === 'xswap' || p.kind === 'gmx') && p.pre_raw && p.intent.evm
    ? { ...p.intent, evm: { ...p.intent.evm, nonce: p.intent.evm.nonce + 1 } } : p.intent;

/** Does the network have this transaction (in a block, or in a mempool a source can see)? Throws when no source answers. */
export async function knownToNetwork(p: ProposalRow): Promise<boolean> {
  const t = await adapterFor(p.network).track({ txid: p.txid!, intent: trackedIntent(p), blockRef: null, broadcastAt: Date.now() / 1000 });
  return t.seen === true || t.state === 'confirming' || t.state === 'finalized' || (t.state === 'failed' && !!t.blockRef);
}
