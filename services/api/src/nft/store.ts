// NFT persistence — every table here is a cache of what chains, indexers and creators' servers said (db.ts, block "NFT delivery 1").
// Idempotent: an asset is upserted by its canonical key, an event by its stable id. Nothing in these tables is an authority: the
// chain is re-read when the inventory is synchronised, and will be re-read before any action of delivery 2.
import type { NftAsset, NftEvent } from '@spw/nft';
import { sql } from '../db.ts';
import type { InventorySection } from './provider.ts';

export interface AssetRow { key: string; family: string; chain: string; standard: string; collection_key: string | null; name: string; quantity: string; in_wallet: boolean; origin: string; asset: NftAsset; first_seen: Date; last_seen: Date; verified_at: Date | null; gone_at: Date | null; metadata_refreshed_at: Date | null }
const nameOf = (a: NftAsset) => (a.metadata.name ?? a.metadata.onchainName ?? '').slice(0, 300);

export async function upsertAsset(a: NftAsset, now: Date): Promise<void> {
  const inWallet = a.ownership.heldByWallet;
  await sql`insert into nft_assets (key, family, chain, owner_address, standard, collection_key, name, quantity, in_wallet, origin, asset, first_seen, last_seen, verified_at, gone_at)
    values (${a.key}, ${a.family}, ${a.chainId}, ${a.ownerAddress}, ${a.standard}, ${a.collection?.key ?? null}, ${nameOf(a)}, ${a.quantity}, ${inWallet}, ${a.origin}, ${sql.json(a as never)}, ${now}, ${now}, ${now}, ${inWallet ? null : now})
    on conflict (key) do update set owner_address = excluded.owner_address, standard = excluded.standard, collection_key = excluded.collection_key, name = excluded.name, quantity = excluded.quantity, in_wallet = excluded.in_wallet,
      origin = case when nft_assets.origin = 'lookup' or excluded.origin <> 'lookup' then excluded.origin else nft_assets.origin end,
      asset = excluded.asset, last_seen = excluded.last_seen, verified_at = excluded.verified_at,
      gone_at = case when excluded.in_wallet then null when nft_assets.in_wallet then excluded.last_seen else nft_assets.gone_at end`;
}
/** After a section of a chain was read successfully: what it used to return and no longer does has left the wallet. */
export async function markGone(chain: string, standards: string[], seen: string[], now: Date): Promise<number> {
  const r = await sql`update nft_assets set in_wallet = false, gone_at = ${now}, quantity = 0,
      asset = jsonb_set(jsonb_set(jsonb_set(asset, '{ownership,heldByWallet}', 'false'), '{ownership,state}', '"not_in_wallet"'), '{quantity}', '"0"')
    where chain = ${chain} and in_wallet and origin = 'discovered' and standard in ${sql(standards)} and not (key in ${sql(seen.length ? seen : [''])}) returning key`;
  return r.length;
}
export const getAsset = async (key: string): Promise<AssetRow | null> => (await sql<AssetRow[]>`select * from nft_assets where key = ${key}`)[0] ?? null;
export async function saveAssetJson(a: NftAsset, o: { metadataRefreshed?: Date } = {}): Promise<void> {
  await sql`update nft_assets set asset = ${sql.json(a as never)}, name = ${nameOf(a)}, metadata_refreshed_at = coalesce(${o.metadataRefreshed ?? null}, metadata_refreshed_at) where key = ${a.key}`;
}
export interface ListFilter { chain?: string; collection?: string; status?: 'in_wallet' | 'left' | 'tracked'; q?: string; sort: 'recent' | 'name'; limit: number; offset: number; /** delivery 3 (trading API): only these networks — a key's restriction, applied in SQL so that paging stays exact */ chains?: string[]; /** delivery 3: items an indexer flags as spam are hidden unless asked for — never deleted */ spam?: 'hide' | 'show' | 'only' }
export async function listAssets(f: ListFilter): Promise<{ rows: AssetRow[]; total: number }> {
  const q = f.q ? `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const where = sql`origin <> 'lookup'
    ${f.chain ? sql`and chain = ${f.chain}` : sql``} ${f.chains ? sql`and chain in ${sql(f.chains.length ? f.chains : [''])}` : sql``} ${f.collection ? sql`and collection_key = ${f.collection}` : sql``}
    ${f.status === 'in_wallet' ? sql`and in_wallet` : f.status === 'left' ? sql`and not in_wallet and origin = 'discovered'` : f.status === 'tracked' ? sql`and origin = 'manual'` : sql`and (in_wallet or origin = 'manual' or gone_at > now() - interval '30 days')`}
    ${q ? sql`and (name ilike ${q} or key ilike ${q} or asset->'collection'->>'name' ilike ${q})` : sql``}
    ${f.spam === 'show' ? sql`` : f.spam === 'only' ? sql`and coalesce((asset->'indexerFlags'->>'spam')::boolean, false)` : sql`and not coalesce((asset->'indexerFlags'->>'spam')::boolean, false)`}`;
  const [c] = await sql<{ n: number }[]>`select count(*)::int as n from nft_assets where ${where}`;
  const rows = await sql<AssetRow[]>`select * from nft_assets where ${where} order by ${f.sort === 'name' ? sql`(name = ''), lower(name), key` : sql`in_wallet desc, first_seen desc, key`} limit ${f.limit} offset ${f.offset}`;
  return { rows, total: c!.n };
}
export const collectionCounts = () => sql<{ collection_key: string; chain: string; n: number; name: string | null }[]>`
  select collection_key, chain, count(*)::int as n, max(asset->'collection'->>'name') as name from nft_assets where collection_key is not null and in_wallet group by collection_key, chain order by n desc, collection_key limit 500`;

export async function saveSections(chain: string, sections: InventorySection[], now: Date): Promise<void> {
  for (const s of sections) await sql`insert into nft_sync (chain, section, status, code, unlocked_by, source, count, truncated, synced_at) values (${chain}, ${s.section}, ${s.status}, ${s.code}, ${s.unlockedBy}, ${s.source}, ${s.count}, ${s.truncated}, ${now})
    on conflict (chain, section) do update set status = excluded.status, code = excluded.code, unlocked_by = excluded.unlocked_by, source = excluded.source, count = excluded.count, truncated = excluded.truncated, synced_at = excluded.synced_at`;
}
export const syncRows = () => sql<{ chain: string; section: string; status: string; code: string | null; unlocked_by: string | null; source: string | null; count: number; truncated: boolean; synced_at: Date }[]>`select * from nft_sync order by chain, section`;

// ── manual list ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const manualKeys = async (chain: string): Promise<string[]> => (await sql<{ key: string }[]>`select key from nft_manual where chain = ${chain} order by added_at`).map((r) => r.key);
export const addManual = (key: string, chain: string) => sql`insert into nft_manual (key, chain) values (${key}, ${chain}) on conflict do nothing`;
export async function removeManual(key: string): Promise<boolean> {
  const r = await sql`delete from nft_manual where key = ${key} returning key`;
  if (r.length) await sql`delete from nft_assets where key = ${key} and origin = 'manual' and not in_wallet`;
  return r.length > 0;
}

// ── metadata / media caches ─────────────────────────────────────────────────────────────────────────────────────────────
export interface MetadataRow { uri_hash: string; source_uri: string; resolved_uri: string | null; status: string; error_code: string | null; doc: unknown; content_hash: string | null; fetched_at: Date; expires_at: Date }
export const getMetadata = async (hash: string): Promise<MetadataRow | null> => (await sql<MetadataRow[]>`select * from nft_metadata where uri_hash = ${hash}`)[0] ?? null;
export const putMetadata = (r: Omit<MetadataRow, 'fetched_at'> & { fetched_at: Date }) => sql`insert into nft_metadata (uri_hash, source_uri, resolved_uri, status, error_code, doc, content_hash, fetched_at, expires_at)
  values (${r.uri_hash}, ${r.source_uri.slice(0, 4096)}, ${r.resolved_uri}, ${r.status}, ${r.error_code}, ${r.doc === null ? null : sql.json(r.doc as never)}, ${r.content_hash}, ${r.fetched_at}, ${r.expires_at})
  on conflict (uri_hash) do update set resolved_uri = excluded.resolved_uri, status = excluded.status, error_code = excluded.error_code, doc = excluded.doc, content_hash = excluded.content_hash, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`;
export interface MediaRow { id: string; source_uri: string; resolved_uri: string | null; status: string; error_code: string | null; mime: string | null; kind: string | null; bytes: string | null; sha256: string | null; registered_at: Date; fetched_at: Date | null; expires_at: Date | null; last_access: Date | null }
export const getMedia = async (id: string): Promise<MediaRow | null> => (await sql<MediaRow[]>`select * from nft_media where id = ${id}`)[0] ?? null;
export const registerMedia = (id: string, sourceUri: string, blocked: string | null, now: Date) => sql`insert into nft_media (id, source_uri, status, error_code, registered_at) values (${id}, ${sourceUri}, ${blocked ? 'blocked' : 'not_fetched'}, ${blocked}, ${now})
  on conflict (id) do update set registered_at = excluded.registered_at`;
export const updateMedia = (id: string, p: { status: string; error_code: string | null; resolved_uri?: string | null; mime?: string | null; kind?: string | null; bytes?: number | null; sha256?: string | null; fetched_at: Date; expires_at: Date }) =>
  sql`update nft_media set status = ${p.status}, error_code = ${p.error_code}, resolved_uri = ${p.resolved_uri ?? null}, mime = ${p.mime ?? null}, kind = ${p.kind ?? null}, bytes = ${p.bytes ?? null}, sha256 = ${p.sha256 ?? null}, fetched_at = ${p.fetched_at}, expires_at = ${p.expires_at}, last_access = ${p.fetched_at} where id = ${id}`;
export const touchMedia = (id: string, now: Date) => sql`update nft_media set last_access = ${now} where id = ${id}`;

// ── events ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function upsertEvents(events: NftEvent[]): Promise<void> {
  for (const e of events) await sql`insert into nft_events (id, asset_key, type, tx, idx, block, at, finality, event) values (${e.id}, ${e.assetKey}, ${e.type}, ${e.tx}, ${e.index}, ${e.blockRef.slot ?? e.blockRef.number ?? null}, ${e.at}, ${e.finality}, ${sql.json(e as never)})
    on conflict (id) do update set finality = excluded.finality, event = excluded.event, type = excluded.type`;
}
export async function listEvents(assetKey: string, o: { limit: number; before?: { block: string; id: string } | null; type?: string }): Promise<NftEvent[]> {
  const rows = await sql<{ event: NftEvent }[]>`select event from nft_events where asset_key = ${assetKey} and finality <> 'reorged' ${o.type ? sql`and type = ${o.type}` : sql``}
    ${o.before ? sql`and (coalesce(block, 0), id) < (${o.before.block}::bigint, ${o.before.id})` : sql``} order by coalesce(block, 0) desc, id desc limit ${o.limit}`;
  return rows.map((r) => r.event);
}
export interface ScanRow { asset_key: string; cursor: string | null; complete: boolean; completeness: string; note: string | null; scanned_at: Date }
export const getScan = async (key: string): Promise<ScanRow | null> => (await sql<ScanRow[]>`select * from nft_event_scan where asset_key = ${key}`)[0] ?? null;
export const putScan = (key: string, p: { cursor: string | null; complete: boolean; completeness: string; note: string | null }, now: Date) => sql`insert into nft_event_scan (asset_key, cursor, complete, completeness, note, scanned_at) values (${key}, ${p.cursor}, ${p.complete}, ${p.completeness}, ${p.note}, ${now})
  on conflict (asset_key) do update set cursor = excluded.cursor, complete = excluded.complete, completeness = excluded.completeness, note = excluded.note, scanned_at = excluded.scanned_at`;

// ── budget of outbound requests to creator-controlled hosts ─────────────────────────────────────────────────────────────
export async function consumeBudget(source: string, now: Date, limits: { requests: number; bytes: number }): Promise<boolean> {
  const day = now.toISOString().slice(0, 10);
  const [r] = await sql<{ requests: number; bytes: string }[]>`insert into nft_budget (source, day, requests) values (${source}, ${day}, 1) on conflict (source, day) do update set requests = nft_budget.requests + 1 returning requests, bytes`;
  return r!.requests <= limits.requests && Number(r!.bytes) <= limits.bytes;
}
export const addBudgetBytes = (source: string, now: Date, bytes: number) => sql`update nft_budget set bytes = bytes + ${bytes} where source = ${source} and day = ${now.toISOString().slice(0, 10)}`;
export const budgetToday = async (now: Date) => sql<{ source: string; requests: number; bytes: string }[]>`select source, requests, bytes from nft_budget where day = ${now.toISOString().slice(0, 10)}`;

// ── retention ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export const RETENTION = { lookupDays: 7, goneDays: 30, mediaIdleDays: 30, metadataExtraDays: 30, budgetDays: 14 };
/** Everything that grows is bounded here. Returns what was removed (ids of media whose files the caller deletes). */
export async function pruneNft(now: Date): Promise<{ assets: number; events: number; metadata: number; media: string[]; budgets: number; collections: number }> {
  const d = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const assets = await sql`delete from nft_assets where (origin = 'lookup' and not in_wallet and last_seen < ${d(RETENTION.lookupDays)}) or (origin = 'discovered' and not in_wallet and gone_at < ${d(RETENTION.goneDays)}) returning key`;
  const events = await sql`delete from nft_events e where not exists (select 1 from nft_assets a where a.key = e.asset_key) returning id`;
  await sql`delete from nft_event_scan s where not exists (select 1 from nft_assets a where a.key = s.asset_key)`;
  const metadata = await sql`delete from nft_metadata where expires_at < ${d(RETENTION.metadataExtraDays)} returning uri_hash`;
  const media = await sql<{ id: string }[]>`delete from nft_media where coalesce(last_access, registered_at) < ${d(RETENTION.mediaIdleDays)} and registered_at < ${d(RETENTION.mediaIdleDays)} returning id`;
  const budgets = await sql`delete from nft_budget where day < ${d(RETENTION.budgetDays).toISOString().slice(0, 10)} returning source`;
  const collections = await sql`delete from nft_collections c where fetched_at < ${d(RETENTION.goneDays)} and not exists (select 1 from nft_assets a where a.collection_key = c.key) returning key`;
  return { assets: assets.length, events: events.length, metadata: metadata.length, media: media.map((m) => m.id), budgets: budgets.length, collections: collections.length };
}
/** Media files beyond the cache size cap, least recently used first: their rows go back to `not_fetched`. */
export async function mediaOverCap(capBytes: number): Promise<string[]> {
  const rows = await sql<{ id: string; bytes: string }[]>`select id, bytes from nft_media where status = 'available' order by coalesce(last_access, fetched_at) desc`;
  let sum = 0; const over: string[] = [];
  for (const r of rows) { sum += Number(r.bytes ?? 0); if (sum > capBytes) over.push(r.id); }
  if (over.length) await sql`update nft_media set status = 'not_fetched', bytes = null, expires_at = null where id in ${sql(over)}`;
  return over;
}
export const getCollection = async (key: string) => (await sql<{ data: unknown; fetched_at: Date }[]>`select data, fetched_at from nft_collections where key = ${key}`)[0] ?? null;
export const putCollection = (key: string, chain: string, data: unknown, now: Date) => sql`insert into nft_collections (key, chain, data, fetched_at) values (${key}, ${chain}, ${sql.json(data as never)}, ${now}) on conflict (key) do update set data = excluded.data, fetched_at = excluded.fetched_at`;

// ── delivery 3: market cache (provider answers), collection slugs, the hidden-by-default spam filter ────────────────────
export interface MarketCacheRow { data: unknown; fetched_at: Date }
export const getMarketCache = async (provider: string, kind: string, ref: string): Promise<MarketCacheRow | null> => (await sql<MarketCacheRow[]>`select data, fetched_at from nft_market_cache where provider = ${provider} and kind = ${kind} and ref = ${ref}`)[0] ?? null;
export const putMarketCache = (provider: string, kind: string, ref: string, data: unknown, now: Date) => sql`insert into nft_market_cache (provider, kind, ref, data, fetched_at) values (${provider}, ${kind}, ${ref}, ${sql.json(data as never)}, ${now})
  on conflict (provider, kind, ref) do update set data = excluded.data, fetched_at = excluded.fetched_at`;
export const pruneMarketCache = async (now: Date, maxAgeMs: number): Promise<number> => (await sql`delete from nft_market_cache where fetched_at < ${new Date(now.getTime() - maxAgeMs)} returning provider`).length;
export const putMarketSlug = (collectionKey: string, provider: string, slug: string, now: Date) => sql`insert into nft_market_slug (collection_key, provider, slug, learnt_at) values (${collectionKey}, ${provider}, ${slug}, ${now})
  on conflict (collection_key, provider) do update set slug = excluded.slug, learnt_at = excluded.learnt_at`;
export const marketSlugs = async (collectionKey: string): Promise<Record<string, string>> => Object.fromEntries((await sql<{ provider: string; slug: string }[]>`select provider, slug from nft_market_slug where collection_key = ${collectionKey}`).map((r) => [r.provider, r.slug]));
/** held items per collection (for the opt-in indicative estimate): only what the chain confirmed as held */
export const heldByCollection = () => sql<{ collection_key: string; chain: string; n: number; name: string | null; sample: string }[]>`
  select collection_key, chain, count(*)::int as n, max(asset->'collection'->>'name') as name, min(key) as sample from nft_assets where collection_key is not null and in_wallet and origin <> 'lookup' group by collection_key, chain order by n desc, collection_key limit 200`;
/** one stored item of a collection (inventory or looked-up): the marketplace's identifier of a collection is learnt from its answer about an item */
export const sampleOfCollection = async (collectionKey: string): Promise<AssetRow | null> => (await sql<AssetRow[]>`select * from nft_assets where collection_key = ${collectionKey} order by in_wallet desc, last_seen desc limit 1`)[0] ?? null;
export const spamCount = async (): Promise<number> => (await sql<{ n: number }[]>`select count(*)::int as n from nft_assets where in_wallet and origin <> 'lookup' and coalesce((asset->'indexerFlags'->>'spam')::boolean, false)`)[0]!.n;
export const setBudget = (source: string, day: string, requests: number) => sql`insert into nft_budget (source, day, requests) values (${source}, ${day}, ${requests}) on conflict (source, day) do update set requests = greatest(nft_budget.requests, excluded.requests)`;
