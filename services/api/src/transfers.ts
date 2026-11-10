import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { z } from 'zod';
import {
  assertTransition, buildBtcTx, buildEvmTx, buildSolMessage, checkPolicy, formatUnits, getAsset, getNetwork, IntentSchema, intentHash,
  normalizeAddress, parseUnits, toB64u, toHex, type Intent, type NetworkDef, type ProposalState,
} from '@spw/core';
import { adapters } from './chains/index.ts';
import { simulateSol } from './chains/sol.ts';
import { config, UserError } from './config.ts';
import { audit, sql } from './db.ts';
import { listCreds } from './auth.ts';
import { signer, type SignerStatus } from './signer-client.ts';

export interface ProposalRow {
  id: string; state: ProposalState; version: number; network: string; asset: string; symbol: string; decimals: number; amount: string;
  from_addr: string; to_addr: string; note: string; fee_estimate: string | null; max_fee: string | null; warnings: string[];
  intent: Intent | null; intent_hash: string | null; raw: string | null; txid: string | null; block_ref: string | null; confirmations: number; error: string | null;
  created_at: Date; updated_at: Date; expires_at: Date | null; broadcast_at: Date | null; last_broadcast_at: Date | null; finalized_at: Date | null;
}

export function view(p: ProposalRow) {
  const n = getNetwork(p.network);
  return {
    id: p.id, state: p.state, network: p.network, networkName: n.name, asset: p.asset, symbol: p.symbol, decimals: p.decimals,
    amount: p.amount, amountDisplay: formatUnits(BigInt(p.amount), p.decimals), from: p.from_addr, to: p.to_addr, note: p.note,
    feeEstimate: p.fee_estimate, maxFee: p.max_fee, feeSymbol: n.native.symbol, feeDecimals: n.native.decimals,
    feeDisplay: p.fee_estimate ? formatUnits(BigInt(p.fee_estimate), n.native.decimals) : null,
    maxFeeDisplay: p.max_fee ? formatUnits(BigInt(p.max_fee), n.native.decimals) : null,
    warnings: p.warnings, intentHash: p.intent_hash, txid: p.txid, explorer: p.txid ? n.explorerTx + p.txid : null,
    confirmations: p.confirmations, error: p.error, createdAt: p.created_at, updatedAt: p.updated_at, expiresAt: p.expires_at,
    broadcastAt: p.broadcast_at, finalizedAt: p.finalized_at,
  };
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

const fromFor = (n: NetworkDef, st: SignerStatus) => st.addresses[n.family];
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

const Create = z.strictObject({ network: z.string().max(20), asset: z.string().max(80), to: z.string().min(1).max(100), amount: z.string().min(1).max(80), note: z.string().max(80).default('') });

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
    const st = await signer.status(true);
    const from = fromFor(n, st);
    if (to === from) throw new UserError('bad_address', 'destination is this wallet');
    const prep = await adapters[n.id].prepare({ asset: asset.id, from, to, amount });
    const now = Math.floor(Date.now() / 1000);
    const probe = { network: n.id, symbol: asset.symbol, amount: amount.toString(), maxFee: prep.maxFee.toString(), to, policyVersion: st.policy.version, createdAt: now, expiresAt: now + 30 } as Intent;
    const verdict = checkPolicy(st.policy, probe, BigInt(st.spentToday[`${n.id}:${asset.symbol}`] ?? '0'), now, st.halted);
    if (!verdict.ok) throw new UserError('policy', verdict.reason, 422);
    const warnings = [...prep.warnings, ...(await destinationWarnings(n.id, to))];
    const id = randomUUID();
    const [p] = await sql<ProposalRow[]>`insert into proposals (id, idempotency_key, state, network, asset, symbol, decimals, amount, from_addr, to_addr, note, fee_estimate, max_fee, warnings, expires_at)
      values (${id}, ${idem}, 'draft', ${n.id}, ${asset.id}, ${asset.symbol}, ${asset.decimals}, ${amount.toString()}, ${from}, ${to}, ${b.note}, ${prep.feeEstimate.toString()}, ${prep.maxFee.toString()}, ${sql.json(warnings)}, now() + interval '15 minutes') returning *`;
    await audit('transfer.draft', 'owner', { id, network: n.id, symbol: asset.symbol, amount: amount.toString(), to });
    return view(p!);
  });

  app.get('/api/v1/transfers/proposals/:id', async (req) => view(await load((req.params as { id: string }).id)));
  app.get('/api/v1/transfers/:id/status', async (req) => { const v = view(await load((req.params as { id: string }).id)); return { id: v.id, state: v.state, txid: v.txid, confirmations: v.confirmations, error: v.error, explorer: v.explorer }; });

  // freeze the exact chain parameters, re-simulate, and issue the approval challenge = intent hash
  app.post('/api/v1/transfers/proposals/:id/request-approval', async (req) => {
    let p = await load((req.params as { id: string }).id);
    if (p.state !== 'draft' && p.state !== 'pending_approval') throw new UserError('bad_state', `proposal is ${p.state}`, 409);
    const n = getNetwork(p.network), st = await signer.status(true);
    if (st.halted) throw new UserError('halted', 'emergency halt is active', 423);
    const prep = await adapters[n.id].prepare({ asset: p.asset, from: p.from_addr, to: p.to_addr, amount: BigInt(p.amount) });
    const now = Math.floor(Date.now() / 1000);
    const intent = IntentSchema.parse({
      v: 1, proposalId: p.id, keyId: st.keyId, network: n.id, chainRef: n.chainRef, asset: p.asset, symbol: p.symbol, decimals: p.decimals,
      amount: p.amount, from: p.from_addr, to: p.to_addr, maxFee: prep.maxFee.toString(), createdAt: now, expiresAt: now + prep.ttlSec,
      policyVersion: st.policy.version, ...prep.section,
    });
    // The API builds the same bytes the signer will rebuild; unsupported shapes fail here, before approval.
    try { if (n.family === 'evm') buildEvmTx(intent); else if (n.family === 'btc') buildBtcTx(intent); else { buildSolMessage(intent); await simulateSol(n, intent); } }
    catch (e) { if (e instanceof UserError) throw e; throw new UserError('simulation_failed', (e as Error).message); }
    const verdict = checkPolicy(st.policy, intent, BigInt(st.spentToday[`${n.id}:${p.symbol}`] ?? '0'), now, st.halted);
    if (!verdict.ok) throw new UserError('policy', verdict.reason, 422);
    const hash = intentHash(intent);
    const patch = { intent: sql.json(intent as never), intent_hash: toHex(hash), max_fee: prep.maxFee.toString(), fee_estimate: prep.feeEstimate.toString(), expires_at: new Date(intent.expiresAt * 1000) };
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
    p = await move(p, 'approved');
    let signed: { raw: string; txid: string; hash: string };
    try { signed = await signer.sign(p.intent, body.assertion); }
    catch (e) { await move(p, 'failed', { error: (e as Error).message.slice(0, 300) }); throw e; }
    if (signed.hash !== p.intent_hash) { await move(p, 'failed', { error: 'signer hash mismatch' }); throw new UserError('hash_mismatch', 'signer returned a different intent hash', 500); }
    p = await move(p, 'signed', { raw: signed.raw, txid: signed.txid });
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
    await adapters[p.network as keyof typeof adapters].broadcast(p.raw);
    return await move(p, 'broadcast', { broadcast_at: new Date(), last_broadcast_at: new Date(), error: null });
  } catch (e) {
    await sql`update proposals set error = ${'broadcast attempt failed: ' + (e as Error).message.slice(0, 200)}, updated_at = now() where id = ${p.id}`;
    return (await sql<ProposalRow[]>`select * from proposals where id = ${p.id}`)[0]!;
  }
}
