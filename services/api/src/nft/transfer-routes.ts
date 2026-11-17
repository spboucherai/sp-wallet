// NFT delivery 2 — routes and lifecycle of NFT transfers, the Bitcoin outpoint lock list and the NFT allow-list. Owner session
// only (the global hook of server.ts authenticates every /api/ path; API keys exist only under /api/v1/trading/).
//
// An NFT transfer is a row of `proposals` (kind 'nft'): the SAME table, idempotency keys, states (`pending_approval` → `approved`
// → `signed` → `broadcast` | `not_broadcast` → `confirming` → `finalized`, `reorged`, `failed`), expiry loop, reconcile loop,
// finality thresholds and re-broadcast rules as a fund transfer (worker.ts) — nothing parallel. What differs: the intent is an
// NftIntent, and the signature is asked of the signer's NFT route.
//
//   POST /api/v1/nfts/transfer/prepare        {key, to, quantity?} + Idempotency-Key → review + passkey challenge (= intent hash)
//   POST /api/v1/nfts/transfer/:id/approve    {assertion} → signer → broadcast (honours SPW_BROADCAST: off = `not_broadcast`)
//   GET  /api/v1/nfts/transfer/:id            state, review, execution
//   GET  /api/v1/nfts/transfers               the NFT transfers, newest first
//   GET  /api/v1/nfts/allow · POST /api/v1/nfts/allow/prepare · POST /api/v1/nfts/allow/approve       allow-list (passkey)
//   GET  /api/v1/utxo-locks?network= · POST /api/v1/utxo-locks/prepare · POST /api/v1/utxo-locks/approve   lock list (passkey)
//   POST /api/v1/utxo-locks/review            declare a heuristically flagged output an ordinary coin (or take that back)
//   (rejecting a prepared transfer: the existing POST /api/v1/transfers/proposals/:id/reject)
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { z } from 'zod';
import { getNetwork, NETWORKS, NftAllowIntentSchema, nftAllowHash, normalizeAddress, toB64u, toHex, UtxoLockIntentSchema, utxoLockHash, type NetworkDef, type NftAllowIntent, type UtxoLockIntent } from '@spw/core';
import { NftProviderError, parseNftKey, type NftAsset, type NftEvent } from '@spw/nft';
import { listCreds } from '../auth.ts';
import { adapterFor } from '../chains/index.ts';
import { config, UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import { challengeFor, existingFor, idemOf } from '../prepare-common.ts';
import { addressFor, type SignerStatus } from '../signer-client.ts';
import { broadcastNow, destinationWarnings, failure, load, move, proposalHooks, view, type ProposalRow } from '../transfers.ts';
import { scanContractArrivals } from './arrivals.ts';
import type { RpcFn } from './provider.ts';
import type { NftService } from './service.ts';
import * as store from './store.ts';
import { blocked, prepareNftTransfer, transferVerdict, type TransferDeps } from './transfer.ts';
import { classifyUtxos, type UtxoDeps } from './utxo.ts';

export interface SignerApi { status(fresh?: boolean): Promise<SignerStatus>; nftSign(intent: unknown, assertion: unknown): Promise<{ raw: string; txid: string; hash: string }>;
  utxoLocks(request: unknown, assertion: unknown): Promise<{ network: string; action: string; changed: number; locked: number; hash: string }>; nftAllow(request: unknown, assertion: unknown): Promise<{ network: string; address: string; action: string; entries: number; hash: string }> }
export interface TransferRoutesDeps { nft: NftService; transfer: TransferDeps; signer: SignerApi; utxo: UtxoDeps; rpc: RpcFn; now: () => Date }

const Key = z.string().min(5).max(260).refine((k) => { try { parseNftKey(k); return true; } catch { return false; } });
const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });
const nftView = (p: ProposalRow) => ({ ...view(p), nft: p.nft ?? null });
const refOf = (key: string) => { const k = parseNftKey(key), [address, tokenId] = k.family === 'evm' ? k.assetId.split('/') : [k.assetId, undefined]; return { chain: k.chainId, address: address!, tokenId }; };
async function passkeyOptions(hash: Uint8Array, ttlSec: number): Promise<unknown> {
  const creds = await listCreds();
  const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required', challenge: new Uint8Array(hash), timeout: ttlSec * 1000, allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as never })) });
  if (options.challenge !== toB64u(hash)) throw new Error('challenge binding mismatch');
  return options;
}
const wrap = async <T>(f: () => Promise<T>): Promise<T> => { try { return await f(); } catch (e) { if (e instanceof NftProviderError) throw blocked(e.code === 'provider_disagreement' ? 'rpc_disagreement' : e.code, `the chain could not be read reliably (${e.source}: ${e.code}); nothing was prepared`, { source: e.source }, e.code === 'not_found' ? 404 : 503); throw e; } };

/** The event of an NFT transfer made by this wallet, following the proposal's state; then the asset is read again on-chain. */
export function nftOutcomeRecorder(d: Pick<TransferRoutesDeps, 'nft'>) {
  return async (p: ProposalRow): Promise<void> => {
    if (p.kind !== 'nft' || !p.txid || !p.nft) return;
    const key = String((p.nft as { key?: unknown }).key ?? ''), finality: NftEvent['finality'] | null = p.state === 'finalized' ? 'finalized' : p.state === 'confirming' ? 'confirmed' : p.state === 'broadcast' ? 'pending' : p.state === 'reorged' ? 'reorged' : null;
    const id = `${key}|${p.txid}|spw-transfer`;
    if (!finality) { if (['failed', 'replaced'].includes(p.state)) await sql`delete from nft_events where id = ${id}`; return; }
    const ev: NftEvent = { id, assetKey: key, type: 'transfer-out', interpretation: { by: 'spw:own-transfer', note: 'sent by this wallet (proposal ' + p.id + ')' }, tx: p.txid, index: 'spw-transfer',
      blockRef: getNetwork(p.network).family === 'sol' ? { slot: p.block_ref ?? undefined } : { hash: p.block_ref ?? undefined }, at: (p.broadcast_at ?? p.updated_at).toISOString(), from: p.from_addr, to: p.to_addr, quantity: p.amount, price: null, finality,
      source: { category: 'onchain', source: 'spw-transfer', detail: 'this wallet\'s own transaction, tracked to finality', fetchedAt: new Date().toISOString(), confidence: 'chain_single_source', freshness: 'fresh', covers: ['events'] } };
    await store.upsertEvents([ev]);
    // ownership is what the chain says after the transfer, never what the wallet assumes
    if (finality === 'finalized' || finality === 'confirmed') { const r = refOf(key); await d.nft.lookup(r.chain, r.address, r.tokenId).catch(() => {}); }
  };
}

/** One pass of the EVM arrival scan over the contracts the wallet already knows. Never throws; reports what it did. */
export async function scanArrivals(d: Pick<TransferRoutesDeps, 'nft' | 'rpc' | 'signer'>): Promise<{ chain: string; contract: string; found: number; adopted: number; error: string | null }[]> {
  const out: { chain: string; contract: string; found: number; adopted: number; error: string | null }[] = [];
  let addrs: Record<string, string>;
  try { addrs = (await d.signer.status()).addresses; } catch { return out; }
  const rows = await sql<{ chain: string; contract: string }[]>`select distinct chain, lower(asset->>'contractAddress') as contract from nft_assets where family = 'evm' and asset->>'contractAddress' is not null and (in_wallet or origin = 'manual') limit 200`;
  for (const r of rows) {
    const wallet = addrs[r.chain];
    if (!wallet) continue;
    try {
      const [c] = await sql<{ cursor: string; gap: boolean }[]>`select cursor, gap from nft_arrival_scan where chain = ${r.chain} and contract = ${r.contract}`;
      const s = await scanContractArrivals(d.rpc, r.chain, r.contract, wallet, c ? { cursor: Number(c.cursor), gap: c.gap } : null);
      let adopted = 0;
      for (const h of new Map(s.hits.map((x) => [x.tokenId, x])).values()) {
        const a = await d.nft.adopt(r.chain, r.contract, h.tokenId).catch(() => null);
        if (!a) continue; // the chain does not confirm the wallet holds it now (it left again, or the endpoints disagree)
        adopted += 1;
        await store.upsertEvents([{ id: `${a.key}|${h.tx}|${h.logIndex}`, assetKey: a.key, type: 'transfer-in', interpretation: { by: 'spw:evm-transfer-log', note: 'a Transfer log to this wallet, in a finalized block' }, tx: h.tx, index: h.logIndex,
          blockRef: { number: h.block, hash: h.blockHash }, at: null, from: h.from, to: wallet, quantity: h.quantity, price: null, finality: 'finalized', source: { category: 'onchain', source: 'evm-rpc', detail: 'per-contract log scan', fetchedAt: new Date().toISOString(), confidence: 'chain_single_source', freshness: 'fresh', covers: ['events'] } }]);
      }
      await sql`insert into nft_arrival_scan (chain, contract, cursor, gap, scanned_at) values (${r.chain}, ${r.contract}, ${s.next.cursor}, ${s.next.gap}, now()) on conflict (chain, contract) do update set cursor = excluded.cursor, gap = excluded.gap, scanned_at = excluded.scanned_at`;
      out.push({ chain: r.chain, contract: r.contract, found: s.hits.length, adopted, error: null });
    } catch (e) { out.push({ chain: r.chain, contract: r.contract, found: 0, adopted: 0, error: (e as Error).message.slice(0, 80) }); }
  }
  return out;
}

export function nftTransferRoutes(app: FastifyInstance, d: TransferRoutesDeps): void {
  const P = '/api/v1/nfts';
  const record = nftOutcomeRecorder(d);
  proposalHooks.tracked.length = 0; proposalHooks.tracked.push(record); // one recorder per process (a test that builds several servers keeps the last)

  // ── transfer ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  /** what the item page shows instead of delivery 1's "not built": transferable, or blocked with the factual reasons */
  app.get(`${P}/transfer/verdict`, limit(120), async (req) => {
    const q = z.object({ key: Key }).parse(req.query), a = await d.nft.get(q.key, { verify: false });
    if (!a) throw new UserError('nft_not_found', 'this NFT is not in the inventory', 404);
    const st = await d.signer.status().catch(() => null);
    const v = transferVerdict(a, st?.nft?.policy ?? null);
    return { ...v, signer: st ? { reachable: true, halted: st.halted, supportsNft: !!st.nft, signedToday: st.nft?.signedToday ?? null, maxPerDay: st.nft?.policy.maxTransfersPerDay ?? null, allowlistOnly: st.nft?.policy.allowlistOnly ?? null, maxErc1155Quantity: st.nft?.policy.maxErc1155Quantity ?? null } : { reachable: false },
      broadcast: config.broadcast };
  });

  app.post(`${P}/transfer/prepare`, limit(120), async (req) => {
    const b = z.strictObject({ key: Key, to: z.string().trim().min(26).max(64), quantity: z.string().regex(/^[1-9]\d{0,77}$/).default('1') }).parse(req.body);
    const idem = idemOf(req.headers as Record<string, unknown>, 'nft', b), dup = await existingFor(idem);
    if (dup) return { proposal: nftView(dup), intent: dup.intent, review: dup.nft ?? null, options: await challengeFor(dup), replayed: true };
    const r = refOf(b.key), n = getNetwork(r.chain) as NetworkDef;
    const st = await d.signer.status(true), wallet = addressFor(st, n.id);
    const [busy] = await sql<{ id: string }[]>`select id from proposals where network = ${n.id} and state in ('approved', 'signed', 'broadcast') limit 1`;
    if (busy) throw new UserError('pending_tx', 'a previous transfer on this network is not confirmed yet; wait for it before sending another', 409);
    // the asset as the chain says it is NOW, on every endpoint (this also refreshes what the inventory stores)
    const a = await wrap(() => d.nft.lookup(r.chain, r.address, r.tokenId)) as unknown as NftAsset;
    const id = randomUUID();
    const prep = await prepareNftTransfer(d.transfer, a, st, wallet, b.to, BigInt(b.quantity), id);
    const warnings = [...prep.review.warnings, ...(await destinationWarnings(n.id, prep.intent.to))];
    const review = { ...prep.review, warnings };
    const [p] = await sql<ProposalRow[]>`insert into proposals (id, idempotency_key, request_hash, kind, state, network, asset, symbol, decimals, amount, from_addr, to_addr, note, fee_estimate, max_fee, warnings, intent, intent_hash, nft, expires_at)
      values (${id}, ${idem.key}, ${idem.hash}, 'nft', 'pending_approval', ${n.id}, ${prep.intent.asset}, 'NFT', 0, ${prep.intent.quantity}, ${wallet}, ${prep.intent.to}, '', ${prep.feeEstimate.toString()}, ${prep.maxFee.toString()}, ${sql.json(warnings)},
        ${sql.json(prep.intent as never)}, ${prep.hash}, ${sql.json(review as never)}, ${new Date(prep.intent.expiresAt * 1000)}) returning *`;
    await audit('nft.transfer.prepared', 'owner', { id, key: b.key, network: n.id, standard: prep.intent.standard, asset: prep.intent.asset, tokenId: prep.intent.tokenId ?? null, quantity: prep.intent.quantity, to: prep.intent.to, hash: prep.hash });
    return { proposal: nftView(p!), intent: prep.intent, review, options: await passkeyOptions(new Uint8Array(Buffer.from(prep.hash, 'hex')), prep.ttlSec), replayed: false };
  });

  // The HTTP call is not the approval: the passkey assertion over the NFT intent hash is, and only the signer judges it.
  app.post(`${P}/transfer/:id/approve`, limit(120), async (req) => {
    const body = z.object({ assertion: z.record(z.string(), z.unknown()) }).parse(req.body);
    let p = await load((req.params as { id: string }).id);
    if (p.kind !== 'nft') throw new UserError('not_found', 'proposal not found', 404);
    if (p.state !== 'pending_approval' || !p.intent) throw new UserError('bad_state', `proposal is ${p.state}`, 409);
    if (p.expires_at && p.expires_at.getTime() < Date.now()) { await move(p, 'expired', failure('approval_expired')); throw new UserError('expired', 'approval window expired; start again', 410); }
    const [busy] = await sql<{ id: string }[]>`select id from proposals where network = ${p.network} and id <> ${p.id} and state in ('approved', 'signed', 'broadcast') limit 1`;
    if (busy) throw new UserError('pending_tx', 'a previous transfer on this network is not confirmed yet', 409);
    p = await move(p, 'approved');
    let signed: { raw: string; txid: string; hash: string };
    try { signed = await d.signer.nftSign(p.intent, body.assertion); }
    catch (e) { const code = (e as { code?: string }).code; await move(p, 'failed', failure(code && /^signer_/.test(code) ? code : 'signer_refused', { detail: (e as Error).message.slice(0, 200) }, (e as Error).message)); throw e; }
    if (signed.hash !== p.intent_hash) { await move(p, 'failed', failure('signer_hash_mismatch')); throw new UserError('hash_mismatch', 'signer returned a different intent hash', 500); }
    p = await move(p, 'signed', { raw: signed.raw, txid: signed.txid });
    p = await broadcastNow(p); // SPW_BROADCAST=off → `not_broadcast`: signed, deliberately not relayed, never shown as sent
    await record(p).catch(() => {});
    return nftView(p);
  });

  app.get(`${P}/transfer/:id`, async (req) => { const p = await load((req.params as { id: string }).id); if (p.kind !== 'nft') throw new UserError('not_found', 'proposal not found', 404); return nftView(p); });
  app.get(`${P}/transfers`, async (req) => {
    const q = z.object({ key: Key.optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
    const rows = await sql<ProposalRow[]>`select * from proposals where kind = 'nft' ${q.key ? sql`and nft->>'key' = ${q.key}` : sql``} order by created_at desc limit ${q.limit}`;
    return { items: rows.map(nftView) };
  });

  // ── allow-list (signer state; passkey for every change) ───────────────────────────────────────────────────────────────
  app.get(`${P}/allow`, async () => { const st = await d.signer.status(true); return { allowlistOnly: st.nft?.policy.allowlistOnly ?? false, entries: st.nft?.allow ?? [], supported: !!st.nft }; });
  app.post(`${P}/allow/prepare`, limit(12), async (req) => {
    const b = z.strictObject({ network: z.string().max(24), address: z.string().trim().min(26).max(64), action: z.enum(['add', 'remove']) }).parse(req.body);
    const n = (NETWORKS as Record<string, NetworkDef | undefined>)[b.network];
    if (!n || (n.family !== 'evm' && n.family !== 'sol')) throw new UserError('unsupported_network', 'the NFT allow-list exists on EVM networks and Solana only', 422);
    let address: string; try { address = normalizeAddress(n.id, b.address); } catch (e) { throw new UserError('bad_address', `invalid ${n.name} address: ${(e as Error).message}`); }
    const st = await d.signer.status(true), now = Math.floor(d.now().getTime() / 1000);
    const intent: NftAllowIntent = NftAllowIntentSchema.parse({ v: 1, kind: 'nft-allow', requestId: randomUUID(), keyId: st.keyId, network: n.id, action: b.action, address, createdAt: now, expiresAt: now + 180, policyVersion: st.policy.version });
    return { intent, options: await passkeyOptions(nftAllowHash(intent), 180) };
  });
  app.post(`${P}/allow/approve`, limit(12), async (req) => {
    const b = z.object({ intent: NftAllowIntentSchema, assertion: z.record(z.string(), z.unknown()) }).parse(req.body);
    const r = await d.signer.nftAllow(b.intent, b.assertion);
    await audit('nft.allow.changed', 'owner', { network: r.network, address: r.address, action: r.action, hash: r.hash });
    return r;
  });

  // ── Bitcoin-style outpoint lock list ──────────────────────────────────────────────────────────────────────────────────
  const U = '/api/v1/utxo-locks';
  const btcNet = (id: string): NetworkDef => { const n = (NETWORKS as Record<string, NetworkDef | undefined>)[id]; if (!n || n.family !== 'btc') throw new UserError('unsupported_network', 'outpoint locks exist on Bitcoin-style networks only', 422); return n; };
  app.get(U, limit(30), async (req) => {
    const q = z.object({ network: z.string().max(24).default('bitcoin') }).parse(req.query), n = btcNet(q.network);
    const st = await d.signer.status(true), address = addressFor(st, n.id), a = adapterFor(n.id);
    if (!a.utxos) throw new UserError('unsupported_network', 'this network does not list coins', 422);
    const utxos = await a.utxos(address);
    let cls: Awaited<ReturnType<typeof classifyUtxos>> | null = null, ordError: string | null = null;
    try { cls = await classifyUtxos(d.utxo, n.id, address, utxos, a.rawTx ? (t) => a.rawTx!(t) : null); }
    catch (e) { if (!(e instanceof UserError) || !/^ord_/.test(e.code)) throw e; ordError = e.code; cls = await classifyUtxos({ ...d.utxo, ord: null }, n.id, address, utxos, null); }
    const held = new Set(utxos.map((u) => `${u.txid}:${u.vout}`)), locks = st.utxoLocks?.[n.id] ?? [];
    return { network: n.id, address, mode: ordError ? 'ord_unavailable' : cls.mode, ordConfigured: !!d.utxo.ord, ordHost: d.utxo.ord?.host ?? null, ordError, signerSupportsLocks: st.utxoLocks !== undefined,
      // with the ord server configured but unreachable nothing is spendable by an ordinary send (fail closed) — the rows say why
      utxos: cls.rows.map((r) => (ordError ? { ...r, excludedBy: [...r.excludedBy.filter((x) => x === 'signer_locked'), 'ord_unavailable'], spendable: false, reviewed: false } : r)),
      // locks whose outpoint is no longer among the wallet's coins (spent after an unlock elsewhere, or never received): shown, removable
      staleLocks: locks.filter((l) => !held.has(l.outpoint)), symbol: n.native.symbol, decimals: n.native.decimals, transfer: 'not_supported', transferReason: 'ordinals_transfer_not_supported' };
  });
  app.post(`${U}/prepare`, limit(12), async (req) => {
    const b = z.strictObject({ network: z.string().max(24), action: z.enum(['lock', 'unlock']), reason: z.enum(['owner', 'ord', 'heuristic']).default('owner'), outpoints: z.array(z.string().regex(/^[0-9a-f]{64}:\d{1,10}$/)).min(1).max(100) }).parse(req.body);
    const n = btcNet(b.network), st = await d.signer.status(true), now = Math.floor(d.now().getTime() / 1000);
    if (st.utxoLocks === undefined) throw new UserError('signer_too_old', 'the signer does not support outpoint locks yet (its version predates them)', 503);
    const intent: UtxoLockIntent = UtxoLockIntentSchema.parse({ v: 1, kind: 'utxo-locks', requestId: randomUUID(), keyId: st.keyId, network: n.id, action: b.action, reason: b.reason,
      outpoints: [...new Set(b.outpoints)].map((o) => ({ txid: o.slice(0, 64), vout: Number(o.slice(65)) })), createdAt: now, expiresAt: now + 180, policyVersion: st.policy.version });
    return { intent, options: await passkeyOptions(utxoLockHash(intent), 180), hash: toHex(utxoLockHash(intent)) };
  });
  app.post(`${U}/approve`, limit(12), async (req) => {
    const b = z.object({ intent: UtxoLockIntentSchema, assertion: z.record(z.string(), z.unknown()) }).parse(req.body);
    const r = await d.signer.utxoLocks(b.intent, b.assertion);
    await audit('utxo.locks.changed', 'owner', { network: r.network, action: r.action, outpoints: b.intent.outpoints.map((o) => `${o.txid}:${o.vout}`), changed: r.changed, locked: r.locked, hash: r.hash });
    return r;
  });
  /** the owner declares a HEURISTICALLY flagged output an ordinary coin (or takes it back). It never lifts a signer lock or an ord report. */
  app.post(`${U}/review`, limit(30), async (req) => {
    const b = z.strictObject({ network: z.string().max(24), outpoint: z.string().regex(/^[0-9a-f]{64}:\d{1,10}$/), ordinary: z.boolean() }).parse(req.body), n = btcNet(b.network);
    if (b.ordinary) await sql`insert into utxo_reviews (network, outpoint, verdict) values (${n.id}, ${b.outpoint}, 'ordinary') on conflict (network, outpoint) do update set verdict = excluded.verdict, at = now()`;
    else await sql`delete from utxo_reviews where network = ${n.id} and outpoint = ${b.outpoint}`;
    await audit('utxo.review', 'owner', { network: n.id, outpoint: b.outpoint, ordinary: b.ordinary });
    return { ok: true };
  });
}
