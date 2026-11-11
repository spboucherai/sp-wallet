import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { z } from 'zod';
import {
  assertTransition, buildBtcTx, buildEvmTx, buildSolMessage, checkPolicy, formatUnits, getAsset, getNetwork, IntentSchema, intentHash,
  normalizeAddress, parseUnits, pluginFor, toB64u, toHex, type Intent, type ProposalState,
} from '@spw/core';
import { adapterFor } from './chains/index.ts';
import { simulateSol } from './chains/sol.ts';
import { config, UserError } from './config.ts';
import { audit, sql } from './db.ts';
import { listCreds } from './auth.ts';
import { addressFor, signer } from './signer-client.ts';
import type { BridgeState } from './bridge.ts';
import { xswapView, type XswapState } from './xswap-state.ts';

export interface ProposalRow {
  id: string; state: ProposalState; version: number; network: string; asset: string; symbol: string; decimals: number; amount: string;
  from_addr: string; to_addr: string; note: string; memo: string | null; aux: Record<string, unknown> | null;
  kind: 'transfer' | 'swap' | 'bridge' | 'xswap'; xswap?: XswapState | null; bridge: BridgeState | null; swap: { provider: string; toAsset: string; toSymbol: string; toDecimals: number; expectedOut: string; minOut: string; slippageBps: number; needsApproval: boolean; simulated: boolean } | null;
  pre_raw: string | null; pre_txid: string | null; pre_state: string | null; out_amount: string | null; fee_estimate: string | null; max_fee: string | null; warnings: string[];
  intent: Intent | null; intent_hash: string | null; raw: string | null; txid: string | null; block_ref: string | null; confirmations: number; error: string | null;
  created_at: Date; updated_at: Date; expires_at: Date | null; broadcast_at: Date | null; last_broadcast_at: Date | null; finalized_at: Date | null;
}

export function view(p: ProposalRow) {
  const n = getNetwork(p.network);
  return {
    id: p.id, state: p.state, network: p.network, networkName: n.name, asset: p.asset, symbol: p.symbol, decimals: p.decimals,
    amount: p.amount, amountDisplay: formatUnits(BigInt(p.amount), p.decimals), from: p.from_addr, to: p.to_addr, note: p.note, memo: p.memo,
    feeEstimate: p.fee_estimate, maxFee: p.max_fee, feeSymbol: n.native.symbol, feeDecimals: n.native.decimals,
    feeDisplay: p.fee_estimate ? formatUnits(BigInt(p.fee_estimate), n.native.decimals) : null,
    maxFeeDisplay: p.max_fee ? formatUnits(BigInt(p.max_fee), n.native.decimals) : null,
    warnings: p.warnings, intentHash: p.intent_hash, txid: p.txid, explorer: p.txid ? n.explorerTx + p.txid : null,
    confirmations: p.confirmations, error: p.error, createdAt: p.created_at, updatedAt: p.updated_at, expiresAt: p.expires_at,
    broadcastAt: p.broadcast_at, finalizedAt: p.finalized_at,
    kind: p.kind ?? 'transfer',
    swap: p.swap ? { provider: p.swap.provider, toAsset: p.swap.toAsset, toSymbol: p.swap.toSymbol, slippageBps: p.swap.slippageBps, needsApproval: p.swap.needsApproval, simulated: p.swap.simulated,
      expectedOut: p.swap.expectedOut, expectedOutDisplay: formatUnits(BigInt(p.swap.expectedOut), p.swap.toDecimals), minOut: p.swap.minOut, minOutDisplay: formatUnits(BigInt(p.swap.minOut), p.swap.toDecimals),
      received: p.out_amount, receivedDisplay: p.out_amount ? formatUnits(BigInt(p.out_amount), p.swap.toDecimals) : null,
      approvalTxid: p.pre_txid, approvalState: p.pre_raw ? (p.pre_state ?? 'pending') : null,
      /** provider-specific facts shown on the review sheet (Solana: licence label, venues, priority fee, token-account rent) */
      detail: (p.swap as { detail?: Record<string, unknown> }).detail ?? null } : null,
    bridge: p.bridge ? bridgeView(p, p.bridge) : null,
    xswap: p.xswap ? xswapView(p, p.xswap) : null,
  };
}

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
    hold: b.hold ?? null, holdDetail: b.holdDetail ?? null, irisStatus: b.irisStatus ?? null, delayReason: b.delayReason ?? null, polls: b.polls, attested: !!b.message,
    mintTxid: b.mintTxid ?? b.mint?.txid ?? null, mintExplorer: (b.mintTxid ?? b.mint?.txid) ? d.explorerTx + (b.mintTxid ?? b.mint!.txid) : null, mintedBy: b.mintedBy ?? null,
    canFinish: !['failed', 'review', 'done', 'burning'].includes(stage), needsPasskey: b.phase === 'mint_failed' };
}

/** Optimistic state change: only succeeds from the expected state and version. */
export async function move(p: ProposalRow, to: ProposalState, patch: Record<string, unknown> = {}): Promise<ProposalRow> {
  assertTransition(p.state, to);
  const [r] = await sql<ProposalRow[]>`update proposals set ${sql({ ...patch, state: to, version: p.version + 1, updated_at: new Date() } as never)}
    where id = ${p.id} and state = ${p.state} and version = ${p.version} returning *`;
  if (!r) throw new UserError('conflict', 'proposal changed concurrently; reload', 409);
  await audit(`transfer.${to}`, 'system', { id: p.id, network: p.network, symbol: p.symbol, amount: p.amount, to: p.to_addr, txid: r.txid, hash: r.intent_hash, error: r.error });
  return r;
}

const load = async (id: string): Promise<ProposalRow> => {
  if (!z.uuid().safeParse(id).success) throw new UserError('not_found', 'proposal not found', 404);
  const [p] = await sql<ProposalRow[]>`select * from proposals where id = ${id}`;
  if (!p) throw new UserError('not_found', 'proposal not found', 404);
  return p;
};

async function destinationWarnings(network: string, to: string): Promise<string[]> {
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

const Create = z.strictObject({ network: z.string().max(20), asset: z.string().max(80), to: z.string().min(1).max(130), amount: z.string().min(1).max(80), note: z.string().max(80).default(''), memo: z.string().max(120).optional() });

export function transferRoutes(app: FastifyInstance): void {
  // draft + validation + simulation + policy pre-check
  app.post('/api/v1/transfers/proposals', async (req) => {
    const idem = String(req.headers['idempotency-key'] ?? '');
    if (!/^[A-Za-z0-9-]{16,64}$/.test(idem)) throw new UserError('idempotency', 'Idempotency-Key header required');
    const [dup] = await sql<ProposalRow[]>`select * from proposals where idempotency_key = ${idem}`;
    if (dup) return view(dup);
    const b = Create.parse(req.body);
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
    const warnings = [...prep.warnings, ...(await destinationWarnings(n.id, to))];
    const id = randomUUID();
    const [p] = await sql<ProposalRow[]>`insert into proposals (id, idempotency_key, state, network, asset, symbol, decimals, amount, from_addr, to_addr, note, memo, fee_estimate, max_fee, warnings, expires_at)
      values (${id}, ${idem}, 'draft', ${n.id}, ${asset.id}, ${asset.symbol}, ${asset.decimals}, ${amount.toString()}, ${from}, ${to}, ${b.note}, ${memo ?? null}, ${prep.feeEstimate.toString()}, ${prep.maxFee.toString()}, ${sql.json(warnings)}, now() + interval '15 minutes') returning *`;
    await audit('transfer.draft', 'owner', { id, network: n.id, symbol: asset.symbol, amount: amount.toString(), to });
    return view(p!);
  });

  app.get('/api/v1/transfers/proposals/:id', async (req) => view(await load((req.params as { id: string }).id)));
  app.get('/api/v1/transfers/:id/status', async (req) => { const v = view(await load((req.params as { id: string }).id)); return { id: v.id, state: v.state, txid: v.txid, confirmations: v.confirmations, error: v.error, explorer: v.explorer }; });

  // freeze the exact chain parameters, re-simulate, and issue the approval challenge = intent hash
  app.post('/api/v1/transfers/proposals/:id/request-approval', async (req) => {
    let p = await load((req.params as { id: string }).id);
    if (p.state !== 'draft' && p.state !== 'pending_approval') throw new UserError('bad_state', `proposal is ${p.state}`, 409);
    if (p.kind === 'swap') throw new UserError('bad_state', 'a swap is prepared once; start a new one', 409);
    if (p.kind === 'bridge') throw new UserError('bad_state', 'a cross-chain transfer is prepared once; start a new one', 409);
    if (p.kind === 'xswap') throw new UserError('bad_state', 'a cross-chain swap is prepared once; start a new one', 409);
    const n = getNetwork(p.network), st = await signer.status(true);
    if (st.halted) throw new UserError('halted', 'emergency halt is active', 423);
    // One transfer in flight per network: a second one prepared before the first is confirmed would reuse the same
    // nonce / sequence / coins, and on some chains (Sui) could even lock those coins until the epoch ends.
    const [busy] = await sql<{ id: string }[]>`select id from proposals where network = ${p.network} and id <> ${p.id} and state in ('approved', 'signed', 'broadcast') limit 1`;
    if (busy) throw new UserError('pending_tx', 'a previous transfer on this network is not confirmed yet; wait for it before sending another', 409);
    const prep = await adapterFor(n.id).prepare({ asset: p.asset, from: p.from_addr, to: p.to_addr, amount: BigInt(p.amount), memo: p.memo ?? undefined });
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
    if (p.expires_at && p.expires_at.getTime() < Date.now()) { await move(p, 'expired', { error: 'approval window expired' }); throw new UserError('expired', 'approval window expired; start again', 410); }
    // one transfer or swap in flight per network, checked again at the moment of approval
    const [busy] = await sql<{ id: string }[]>`select id from proposals where network = ${p.network} and id <> ${p.id} and state in ('approved', 'signed', 'broadcast') limit 1`;
    if (busy) throw new UserError('pending_tx', 'a previous transfer or swap on this network is not confirmed yet', 409);
    // a cross-chain mint being signed or sent on this network uses the same nonce space
    const [minting] = await sql<{ id: string }[]>`select id from proposals where kind = 'bridge' and bridge->>'toNetwork' = ${p.network} and bridge->>'phase' = 'mint_sent' and state in ('confirming', 'finalized', 'reorged') limit 1`;
    if (minting) throw new UserError('pending_tx', 'a cross-chain transfer is being received on this network; wait for it', 409);
    p = await move(p, 'approved');
    let signed: { raw: string; txid: string; hash: string; pre?: { raw: string; txid: string } };
    try { signed = await signer.sign(p.intent, body.assertion, p.aux ?? undefined); }
    catch (e) { await move(p, 'failed', { error: (e as Error).message.slice(0, 300) }); throw e; }
    if (signed.hash !== p.intent_hash) { await move(p, 'failed', { error: 'signer hash mismatch' }); throw new UserError('hash_mismatch', 'signer returned a different intent hash', 500); }
    p = await move(p, 'signed', { raw: signed.raw, txid: signed.txid, ...(signed.pre ? { pre_raw: signed.pre.raw, pre_txid: signed.pre.txid } : {}) });
    if (p.kind === 'swap') { const { advanceSwap } = await import('./swap-exec.ts'); return view(await advanceSwap(p)); }
    if (p.kind === 'bridge') { const { advanceBridgeBurn } = await import('./bridge.ts'); return view(await advanceBridgeBurn(p)); }
    if (p.kind === 'xswap') { const { advanceXswapSend } = await import('./xswap.ts'); return view(await advanceXswapSend(p)); }
    return view(await broadcastNow(p));
  });

  app.post('/api/v1/transfers/proposals/:id/reject', async (req) => {
    const p = await load((req.params as { id: string }).id);
    if (p.state !== 'draft' && p.state !== 'pending_approval') throw new UserError('bad_state', `proposal is ${p.state}`, 409);
    return view(await move(p, 'rejected', { error: 'rejected by owner' }));
  });
}

/** Relay signed bytes. A returned hash is not success: state stays "broadcast" until the chain confirms. */
export async function broadcastNow(p: ProposalRow): Promise<ProposalRow> {
  if (!p.raw) return p;
  if (!config.broadcast) return move(p, 'broadcast', { broadcast_at: new Date(), last_broadcast_at: new Date(), error: 'broadcast disabled (test mode)' });
  try {
    await adapterFor(p.network).broadcast(p.raw);
    return await move(p, 'broadcast', { broadcast_at: new Date(), last_broadcast_at: new Date(), error: null });
  } catch (e) {
    await sql`update proposals set error = ${'broadcast attempt failed: ' + (e as Error).message.slice(0, 200)}, updated_at = now() where id = ${p.id}`;
    return (await sql<ProposalRow[]>`select * from proposals where id = ${p.id}`)[0]!;
  }
}
