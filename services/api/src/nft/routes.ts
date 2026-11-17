// NFT routes — /api/v1/nfts/* (delivery 1: READ-ONLY). Owner session only: the global hook of server.ts authenticates every
// /api/ path, and an API key is refused here (these paths are not under /api/v1/trading/). No route takes an owner address: the
// wallet's addresses come from the signer. There is no transfer, approval or market-write route in this module.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NETWORKS } from '@spw/core';
import { NftProviderError, parseNftKey } from '@spw/nft';
import { UserError } from '../config.ts';
import { audit } from '../db.ts';
import type { NftService } from './service.ts';
import type { Resolver } from './resolver.ts';
import { transferVerdict } from './transfer.ts';
import type { SignerApi } from './transfer-routes.ts';

const Key = z.string().min(5).max(260).refine((k) => { try { parseNftKey(k); return true; } catch { return false; } });
const Chain = z.string().max(24).refine((c) => !!(NETWORKS as Record<string, unknown>)[c]);
const STATUS: Partial<Record<string, number>> = { not_found: 404, bad_identifier: 400, unsupported_chain: 422, unsupported_standard: 422, provider_rate_limited: 429, provider_not_configured: 503, provider_unavailable: 503, provider_bad_answer: 502, provider_disagreement: 502, provider_method_unsupported: 503, budget_exhausted: 429 };
/** A provider failure leaves this module as a stable code + the source that failed; never a URL, a key or a response body. */
const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
  try { return await f(); } catch (e) {
    if (e instanceof NftProviderError) { const detail = /^[a-z0-9_:]{1,60}$/.test(e.message.split('(')[1]?.replace(')', '') ?? '') ? e.message.split('(')[1]!.replace(')', '') : null;
      throw Object.assign(new UserError(`nft_${e.code}`, `NFT source ${e.source}: ${e.code}`, STATUS[e.code] ?? 502), { data: { source: e.source, code: e.code, detail } }); }
    throw e;
  }
};
const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

export function nftRoutes(app: FastifyInstance, nft: NftService, resolver: Resolver, o: { autoSync: boolean; signer?: SignerApi } = { autoSync: true }): void {
  const P = '/api/v1/nfts';
  const summary = (a: ReturnType<NftService['present']>) => { const img = a.media.find((m) => m.role === 'image') ?? a.media[0] ?? null;
    return { key: a.key, chain: a.chainId, family: a.family, standard: a.standard, assetId: a.assetId, tokenId: a.tokenId, name: a.metadata.name, onchainName: a.metadata.onchainName, collection: a.collection ? { key: a.collection.key, name: a.collection.name, verifiedOnChain: a.collection.verifiedOnChain } : null,
      quantity: a.quantity, state: a.ownership.state, inWallet: a.ownership.heldByWallet, origin: a.origin, metadataStatus: a.metadata.status, image: img ? { id: img.id, kind: img.kind, status: img.status } : null,
      transferable: a.capabilities.transferable, transferBlockedBy: a.capabilities.transferBlockedBy[0] ?? null, firstSeen: a.firstSeen, verifiedAt: a.verifiedAt, goneAt: a.goneAt, stale: a.ownership.source.freshness === 'stale',
      // delivery 3: an indexer's spam signal, as that indexer's statement
      spam: a.indexerFlags?.spam ? { by: a.indexerFlags.by } : null }; };

  app.get(`${P}/capabilities`, async () => nft.capabilities());

  app.get(P, async (req) => {
    const q = z.object({ chain: Chain.optional(), collection: Key.optional(), status: z.enum(['in_wallet', 'left', 'tracked']).optional(), q: z.string().trim().max(80).optional(), sort: z.enum(['recent', 'name']).default('recent'), spam: z.enum(['hide', 'show', 'only']).default('hide'),
      cursor: z.coerce.number().int().min(0).max(100_000).default(0), limit: z.coerce.number().int().min(1).max(100).default(48) }).parse(req.query);
    if (o.autoSync) void nft.sync({ onlyStale: true }).catch(() => {}); // refresh in the background; this answer is what is stored now
    const r = await nft.list({ chain: q.chain, collection: q.collection, status: q.status, q: q.q || undefined, sort: q.sort, limit: q.limit, offset: q.cursor, spam: q.spam });
    // value: an NFT has no value this wallet can establish — it says so instead of counting zero or a floor price
    return { items: r.items.map(summary), total: r.total, hiddenSpam: r.hiddenSpam, cursor: q.cursor + r.items.length < r.total ? q.cursor + r.items.length : null, sync: nft.syncState(), valuation: { state: 'unavailable', reason: 'no_reliable_valuation' }, asOf: new Date().toISOString() };
  });

  app.post(`${P}/sync`, limit(6), async (req) => {
    const b = z.strictObject({ chain: Chain.optional() }).parse(req.body ?? {});
    return nft.sync({ chain: b.chain });
  });

  app.get(`${P}/item`, async (req) => {
    const q = z.object({ key: Key }).parse(req.query);
    const a = await nft.get(q.key);
    if (!a) throw new UserError('nft_not_found', 'this NFT is not in the inventory; use the lookup to open it', 404);
    // delivery 2: the per-asset transfer verdict (facts of the asset + the signer's NFT policy when it can be read)
    const policy = o.signer ? (await o.signer.status().catch(() => null))?.nft?.policy ?? null : null;
    return { ...a, transfer: transferVerdict(a, policy) };
  });

  app.get(`${P}/activity`, limit(60), async (req) => {
    const q = z.object({ key: Key, cursor: z.string().max(400).optional(), limit: z.coerce.number().int().min(1).max(50).default(20), type: z.enum(['mint', 'transfer', 'transfer-in', 'transfer-out', 'burn', 'sale', 'list', 'delist', 'offer', 'cancel-offer', 'accept-offer', 'escrow', 'unknown']).optional(), more: z.enum(['1']).optional() }).parse(req.query);
    return wrap(() => nft.activity(q.key, { cursor: q.cursor ?? null, limit: q.limit, type: q.type, more: q.more === '1' }));
  });

  app.get(`${P}/collections`, async () => ({ items: await nft.collections() }));
  app.get(`${P}/collection`, limit(60), async (req) => { const q = z.object({ key: Key }).parse(req.query); return wrap(() => nft.collection(q.key)); });

  // explicit lookup of any asset (the owner typed its identifier): rate-limited — each one costs chain reads and a fetch of creator metadata
  app.post(`${P}/lookup`, limit(20), async (req) => {
    const b = z.strictObject({ chain: Chain, address: z.string().trim().min(26).max(64), tokenId: z.string().trim().max(80).optional() }).parse(req.body);
    return wrap(() => nft.lookup(b.chain, b.address, b.tokenId || undefined));
  });

  app.post(`${P}/refresh-metadata`, limit(10), async (req) => { const b = z.strictObject({ key: Key }).parse(req.body); return wrap(() => nft.refreshMetadata(b.key)); });

  app.post(`${P}/manual`, limit(20), async (req) => {
    const b = z.strictObject({ chain: Chain, address: z.string().trim().min(26).max(64), tokenId: z.string().trim().max(80).optional() }).parse(req.body);
    const a = await wrap(() => nft.manualAdd(b.chain, b.address, b.tokenId || undefined));
    await audit('nft.tracked', 'owner', { key: a.key, inWallet: a.ownership.heldByWallet });
    return a;
  });
  app.delete(`${P}/manual`, async (req) => {
    const q = z.object({ key: Key }).parse(req.query);
    const removed = await nft.manualRemove(q.key);
    if (removed) await audit('nft.untracked', 'owner', { key: q.key });
    return { ok: true, removed };
  });

  app.get(`${P}/receive`, async () => ({ items: await nft.receive() }));

  // media proxy: an opaque id registered when an asset was loaded — never a URL. Bytes are sniffed; headers make the answer inert.
  app.get(`${P}/media/:id`, limit(240), async (req, reply) => {
    const id = z.string().regex(/^m[0-9a-f]{40}$/).parse((req.params as { id: string }).id), q = z.object({ run: z.enum(['1']).optional(), info: z.enum(['1']).optional() }).parse(req.query);
    const r = await resolver.serveMedia(id, q.run === '1');
    // `info=1`: what the file IS (decided from its bytes), for the player to choose an element — no bytes
    if (q.info === '1') return r.ok ? { status: 'available', mime: r.headers['content-type']!.split(';')[0], kind: r.kind, bytes: r.body.length } : { status: r.error, code: r.code };
    if (!r.ok) return reply.status(r.status).send({ error: r.error, message: `media ${r.error === 'media_blocked' ? 'blocked' : 'unavailable'}: ${r.code}`, data: { code: r.code } });
    for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
    return reply.send(r.body);
  });
}
