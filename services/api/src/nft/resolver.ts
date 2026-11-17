// Metadata resolver and media proxy (brief §6 "Metadata and URIs", §7). Everything a creator controls passes through here and
// nowhere else:
//   - a metadata URI (from a chain account or a contract) → a bounded JSON document, normalised, cached with a TTL;
//   - a media URI (from that document) → registered under an OPAQUE id; the browser only ever asks this server for
//     `/api/v1/nfts/media/<id>` — never a third-party host, so no cookie, referrer or IP of the owner reaches a creator's server;
//   - the proxy serves only ids registered that way (an asset of the inventory, or one the owner looked up): it is not an open
//     proxy — there is no URL parameter;
//   - what is served is decided by the BYTES (sniff.ts), with a fixed allow-list, and always with headers that make the response
//     inert if it is opened directly: a sandboxing CSP, nosniff, an explicit disposition.
// Budgets: a per-minute cap in memory and a per-day cap in the database (requests and bytes) on outbound fetches.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { declaredKind, decideMedia, MAX_METADATA_BYTES, normaliseMetadata, parseBoundedJson, resolveUri, safeExternalLink, substituteErc1155Id, type DataSourceStamp, type MediaKind, type MetadataStatus, type NftAsset, type NftMediaRecord } from '@spw/nft';
import type { NftConfig } from './config.ts';
import { defaultFetchDeps, safeFetch, type FetchRefusal, type SafeFetchDeps } from './safe-fetch.ts';
import * as store from './store.ts';

export const TTL = { metadataOkMs: 24 * 3600_000, metadataFailMs: 15 * 60_000, mediaOkMs: 7 * 86_400_000, mediaFailMs: 30 * 60_000 };
const PER_MINUTE = 90;
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
export const mediaIdOf = (sourceUri: string): string => `m${sha(`spw-nft-media-v1\n${sourceUri}`).slice(0, 40)}`;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'text/html': 'html', 'model/gltf-binary': 'glb' };

/**
 * Headers of a proxied file. Every response is sandboxed by its own CSP (unique origin: no cookie, no storage, no access to the
 * wallet's origin) even when opened directly in a tab. HTML is only ever meant for the sandboxed iframe of the item page:
 *   default — no script at all;  `run` (the owner's explicit "run this content") — scripts allowed INSIDE the sandbox, still with
 *   no network (connect-src 'none', no remote subresource), no same origin, no top navigation, no forms, no popups.
 */
export function mediaHeaders(mime: string, kind: MediaKind, id: string, run: boolean): Record<string, string> {
  const html = kind === 'html';
  const csp = html
    ? `sandbox${run ? ' allow-scripts' : ''}; default-src 'none'; ${run ? "script-src 'unsafe-inline' 'unsafe-eval' data: blob:; worker-src blob:; " : ''}img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`
    : `sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'`;
  return {
    'content-type': mime === 'text/html' || mime === 'image/svg+xml' ? `${mime}; charset=utf-8` : mime,
    'content-disposition': `inline; filename="nft-${id.slice(1, 13)}.${EXT[mime] ?? 'bin'}"`,
    'content-security-policy': csp, 'x-content-type-options': 'nosniff', 'x-frame-options': html ? 'SAMEORIGIN' : 'DENY',
    'cross-origin-resource-policy': 'same-origin', 'referrer-policy': 'no-referrer', 'cache-control': 'private, max-age=3600',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=(), publickey-credentials-get=(), publickey-credentials-create=(), fullscreen=()',
  };
}

export interface ResolverDeps { cfg: NftConfig; fetch?: SafeFetchDeps; now: () => Date }
export type MediaAnswer = { ok: true; headers: Record<string, string>; body: Buffer; kind: MediaKind } | { ok: false; status: number; error: string; code: string };

export function createResolver(deps: ResolverDeps) {
  const { cfg } = deps, fetchDeps = deps.fetch ?? defaultFetchDeps;
  let minute = 0, used = 0;
  const inflight = new Map<string, Promise<void>>();
  const file = (id: string) => join(cfg.cacheDir, id);
  /** one outbound fetch to a creator-controlled host, inside the budgets */
  async function outbound(url: string, o: { maxBytes: number; timeoutMs: number; accept: string }) {
    const now = deps.now(), m = Math.floor(now.getTime() / 60_000);
    if (m !== minute) { minute = m; used = 0; }
    if (++used > PER_MINUTE) return { ok: false as const, code: 'budget_exhausted' as FetchRefusal };
    if (!(await store.consumeBudget('creator-fetch', now, { requests: cfg.dailyRequests, bytes: cfg.dailyBytes }))) return { ok: false as const, code: 'budget_exhausted' as FetchRefusal };
    const r = await safeFetch(url, o, fetchDeps);
    if (r.ok) await store.addBudgetBytes('creator-fetch', now, r.bytes.length);
    return r;
  }
  /** try the candidates in order (gateway failover); the first that answers wins, the last refusal is reported */
  async function fetchFirst(cands: string[], o: { maxBytes: number; timeoutMs: number; accept: string }) {
    let last: { ok: false; code: FetchRefusal; status?: number } = { ok: false, code: 'no_gateway' };
    for (const c of cands) { const r = await outbound(c, o); if (r.ok) return r; last = r; if (r.code === 'budget_exhausted' || r.code === 'too_large') break; }
    return last;
  }
  const statusOf = (code: string): MetadataStatus => (['json_malformed', 'json_not_object', 'json_too_deep', 'json_too_many_nodes'].includes(code) ? 'malformed' : code === 'too_large' || code === 'json_too_large' || code === 'uri_too_long' ? 'too_large'
    : ['timeout', 'connect_failed', 'dns_failed', 'http_error', 'budget_exhausted', 'no_gateway', 'too_many_redirects'].includes(code) ? 'unreachable' : 'blocked');

  /** delivery 3: an image a market source names (collection logo / banner). Same rules as a creator's media: opaque id, fetched by the pinned fetcher, sniffed, served inert */
  async function registerExternalImage(url: string): Promise<string | null> { const m = await registerMediaFor('image', url, null); return m.status === 'blocked' ? null : m.id; }
  async function registerMediaFor(role: NftMediaRecord['role'], sourceUri: string, declaredMime: string | null): Promise<NftMediaRecord> {
    const id = mediaIdOf(sourceUri), r = resolveUri(sourceUri, cfg.gateways, 'media');
    const blocked = r.ok ? null : r.code;
    await store.registerMedia(id, sourceUri.slice(0, 600_000), blocked, deps.now());
    const row = await store.getMedia(id);
    const hint = declaredKind(declaredMime), ext = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(sourceUri)?.[1]?.toLowerCase();
    const byExt: MediaKind = ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'].includes(ext) ? 'image' : ext && ['mp4', 'webm', 'mov'].includes(ext) ? 'video' : ext && ['mp3', 'wav', 'ogg', 'm4a'].includes(ext) ? 'audio' : ext && ['html', 'htm'].includes(ext) ? 'html' : ext === 'glb' ? 'model' : 'unknown';
    return { role, id, sourceUri: sourceUri.length > 2048 ? `${sourceUri.slice(0, 64)}…(${sourceUri.length} characters)` : sourceUri, resolvedUri: row?.resolved_uri ?? (r.ok && r.kind !== 'data' ? r.candidates[0]! : null), declaredMime,
      mime: row?.mime ?? null, kind: (row?.kind as MediaKind | null) ?? (hint !== 'unknown' ? hint : byExt !== 'unknown' ? byExt : role === 'image' ? 'image' : 'unknown'),
      status: blocked ? 'blocked' : ((row?.status as NftMediaRecord['status'] | undefined) ?? 'not_fetched'), errorCode: blocked ?? row?.error_code ?? null, bytes: row?.bytes ?? null };
  }

  return {
    registerExternalImage,
    /** Fill `asset.metadata` and `asset.media` from the asset's metadata URI. Never throws: a failure is a status with a code. */
    async resolveMetadata(asset: NftAsset, o: { force?: boolean } = {}): Promise<NftAsset> {
      const md = asset.metadata, now = deps.now();
      if (!md.sourceUri) { asset.metadata = { ...md, status: 'no_uri' }; asset.media = []; return asset; }
      const uri = asset.standard === 'erc1155' && asset.tokenId ? substituteErc1155Id(md.sourceUri, asset.tokenId) : md.sourceUri;
      const hash = sha(`spw-nft-metadata-v1\n${uri}`);
      let row = o.force ? null : await store.getMetadata(hash);
      if (row && row.expires_at.getTime() <= now.getTime()) row = null;
      if (!row) {
        const r = resolveUri(uri, cfg.gateways, 'metadata');
        let status: MetadataStatus = 'ok', code: string | null = null, doc: unknown = null, resolved: string | null = null, contentHash: string | null = null;
        if (!r.ok) { status = statusOf(r.code); code = r.code; }
        else {
          let text: string | null = null;
          if (r.kind === 'data') { text = new TextDecoder().decode(r.bytes); resolved = null; contentHash = sha(r.bytes); }
          else { const f = await fetchFirst(r.candidates, { maxBytes: MAX_METADATA_BYTES, timeoutMs: 10_000, accept: 'application/json, text/plain;q=0.8, */*;q=0.1' });
            if (!f.ok) { status = statusOf(f.code); code = f.status ? `${f.code}_${f.status}` : f.code; } else { text = new TextDecoder().decode(f.bytes); resolved = f.finalUrl; contentHash = sha(f.bytes); } }
          if (text !== null) { const p = parseBoundedJson(text); if (p.ok) doc = p.value; else { status = statusOf(p.code); code = p.code; } }
        }
        await store.putMetadata({ uri_hash: hash, source_uri: md.sourceUri, resolved_uri: resolved, status, error_code: code, doc, content_hash: contentHash, fetched_at: now, expires_at: new Date(now.getTime() + (status === 'ok' ? TTL.metadataOkMs : TTL.metadataFailMs)) });
        row = (await store.getMetadata(hash))!;
      }
      const stamp: DataSourceStamp = { category: 'creator_metadata', source: 'metadata-uri', detail: row.resolved_uri ? new URL(row.resolved_uri).host : uri.startsWith('data:') ? 'data: URI (on-chain)' : 'not fetched', fetchedAt: row.fetched_at.toISOString(), confidence: 'creator_declared',
        freshness: now.getTime() - row.fetched_at.getTime() > TTL.metadataOkMs ? 'stale' : 'fresh', covers: ['metadata', 'media', 'traits'] };
      const base = { ...md, status: row.status as MetadataStatus, errorCode: row.error_code, resolvedUri: row.resolved_uri, contentHash: row.content_hash, source: stamp };
      asset.sources = [...asset.sources.filter((s) => s.source !== 'metadata-uri'), stamp];
      if (row.status !== 'ok' || !row.doc) { asset.metadata = { ...base, name: null, description: null, externalUrl: null, attributes: [], raw: null }; asset.media = []; return asset; }
      const n = normaliseMetadata(row.doc as Record<string, unknown>);
      asset.metadata = { ...base, name: n.name, description: n.description, externalUrl: safeExternalLink(n.externalUrl)?.href ?? null, attributes: n.attributes, raw: row.doc,
        traitStatistics: { computed: false, reason: asset.standard === 'metaplex-bubblegum' ? 'compressed' : asset.collection && asset.collection.verifiedOnChain.state === 'known' && asset.collection.verifiedOnChain.value === false ? 'collection_unverified' : 'no_collection_index' } };
      const typeOf = (u: string) => n.files.find((f) => f.uri === u)?.type ?? null, media: NftMediaRecord[] = [];
      if (n.image) media.push(await registerMediaFor('image', n.image, typeOf(n.image)));
      if (n.animationUrl && n.animationUrl !== n.image) media.push(await registerMediaFor('animation', n.animationUrl, typeOf(n.animationUrl)));
      for (const f of n.files.filter((x) => x.uri !== n.image && x.uri !== n.animationUrl).slice(0, 8)) media.push(await registerMediaFor('file', f.uri, f.type));
      asset.media = media;
      return asset;
    },

    /** The bytes of a registered media id — fetched on first request, then served from the cache directory. */
    async serveMedia(id: string, run: boolean): Promise<MediaAnswer> {
      if (!/^m[0-9a-f]{40}$/.test(id)) return { ok: false, status: 404, error: 'not_found', code: 'unknown_media' };
      let row = await store.getMedia(id);
      if (!row) return { ok: false, status: 404, error: 'not_found', code: 'unknown_media' };
      const now = deps.now();
      const fresh = (r: store.MediaRow) => !!r.expires_at && r.expires_at.getTime() > now.getTime();
      if (!(row.status === 'available' && fresh(row)) && !(row.status !== 'available' && row.status !== 'not_fetched' && fresh(row))) {
        let job = inflight.get(id);
        if (!job) {
          job = (async () => {
            const src = row!.source_uri, r = resolveUri(src, cfg.gateways, 'media');
            const failed = (status: string, code: string) => store.updateMedia(id, { status, error_code: code, fetched_at: now, expires_at: new Date(now.getTime() + TTL.mediaFailMs) });
            if (!r.ok) { await failed('blocked', r.code); return; }
            let bytes: Uint8Array, declared: string | null, resolved: string | null = null;
            if (r.kind === 'data') { bytes = r.bytes; declared = r.mime; }
            else { const f = await fetchFirst(r.candidates, { maxBytes: cfg.mediaMaxBytes, timeoutMs: 25_000, accept: 'image/*, video/*, audio/*, text/html;q=0.5, */*;q=0.1' });
              if (!f.ok) { await failed(f.code === 'too_large' ? 'too_large' : ['timeout', 'connect_failed', 'dns_failed', 'http_error', 'budget_exhausted', 'too_many_redirects'].includes(f.code) ? 'unreachable' : 'blocked', f.status ? `${f.code}_${f.status}` : f.code); return; }
              bytes = f.bytes; declared = f.contentType; resolved = f.finalUrl; }
            const d = decideMedia(declared, bytes);
            if (!d.ok) { await failed(d.code === 'mime_mismatch' ? 'blocked' : 'unsupported_type', d.code); return; }
            mkdirSync(cfg.cacheDir, { recursive: true, mode: 0o700 });
            writeFileSync(file(id), bytes, { mode: 0o600 });
            await store.updateMedia(id, { status: 'available', error_code: null, resolved_uri: resolved, mime: d.mime, kind: d.kind, bytes: bytes.length, sha256: sha(bytes), fetched_at: now, expires_at: new Date(now.getTime() + TTL.mediaOkMs) });
          })().finally(() => inflight.delete(id));
          inflight.set(id, job);
        }
        await job;
        row = (await store.getMedia(id))!;
      }
      if (row.status !== 'available' || !row.mime || !row.kind) return { ok: false, status: row.status === 'unreachable' ? 502 : row.status === 'too_large' ? 413 : 403, error: row.status === 'unreachable' ? 'media_unreachable' : 'media_blocked', code: row.error_code ?? row.status };
      let body: Buffer;
      try { body = readFileSync(file(id)); } catch { await store.updateMedia(id, { status: 'not_fetched', error_code: null, fetched_at: now, expires_at: now }); return { ok: false, status: 503, error: 'media_unreachable', code: 'cache_miss_retry' }; }
      void store.touchMedia(id, now).catch(() => {});
      return { ok: true, headers: mediaHeaders(row.mime, row.kind as MediaKind, id, run), body, kind: row.kind as MediaKind };
    },
    /** current state of the media records of an asset (after files were fetched by the proxy) */
    async refreshMediaStates(asset: NftAsset): Promise<NftAsset> {
      for (const m of asset.media) { const row = await store.getMedia(m.id); if (row) { m.status = row.status as NftMediaRecord['status']; m.errorCode = row.error_code; m.mime = row.mime; m.bytes = row.bytes; if (row.kind) m.kind = row.kind as MediaKind; if (row.resolved_uri) m.resolvedUri = row.resolved_uri; } }
      return asset;
    },
    removeFiles(ids: string[]): void { for (const id of ids) { try { rmSync(file(id), { force: true }); } catch { /* already gone */ } } },
  };
}
export type Resolver = ReturnType<typeof createResolver>;
