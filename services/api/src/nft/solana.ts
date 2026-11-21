/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/nft/solana.ts
 * Module           : nft
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-17
 * Last Modified    : 2026-11-17
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// Solana NFT provider (read-only). ON-CHAIN TRUTH comes from ordinary RPC reads of the wallet's own endpoints — accounts decoded
// by this server (packages/nft/src/solana.ts): SPL Token / Token-2022 token accounts and mints, Metaplex Token Metadata
// (metadata, edition, pNFT token record), Metaplex Core assets and collections. INDEXED data comes from a DAS endpoint and is
// labelled as such: compressed NFTs exist for this server only through it.
//
// Sections of an inventory, each failing alone:
//   token      getTokenAccountsByOwner (both token programs) → mints with 0 decimals and supply 1 → metadata / edition / token record
//   core       getProgramAccounts(Core, memcmp owner) — an "indexed request" some public endpoints refuse → blocked_by_provider
//   compressed DAS searchAssets(owner, compressed) — needs a DAS-capable endpoint → blocked_by_provider without one
//
// Outbound requests that carry the wallet's Solana address: getTokenAccountsByOwner, getProgramAccounts (memcmp), DAS
// searchAssets — to the hosts of NETWORKS.solana.rpc (already receiving it for balances) and to NFT_SOLANA_DAS_URL when set.
import { associatedTokenAddress, getNetwork, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type NetworkDef } from '@spw/core';
import { BUBBLEGUM_PROGRAM, CORE_PROGRAM, NftProviderError, capabilitiesOf, NONE, UNSUPPORTED, coreAccountKind, decodeCoreAsset, decodeCoreCollection, decodeCoreInstruction, decodeTmEdition, decodeTmMetadata, decodeTmTokenRecord, editionPda, isSolanaAddress, known, metadataPda, nftKey, plainText, tokenRecordPda, unknown,
  type Confidence, type CoreAsset, type CoreCollection, type CorePlugins, type DataSourceStamp, type Known, type NftAsset, type NftCollectionRef, type NftEvent, type NftOwnershipRecord, type NftStandard, type TmMetadata } from '@spw/nft';
import { buildAsset, emptyMetadata, rpcCodeOf, type CollectionInfo, type EventPage, type InventoryResult, type InventorySection, type NftDataProvider, type RpcFn } from './provider.ts';
import { hostOnly } from './config.ts';
import { solanaMarketProgram } from './market/seaport.ts';

const FAMILY = 'sol', CHAIN = 'solana', COMMIT = 'finalized';
const key = (id: string) => nftKey(FAMILY, CHAIN, id);
const b64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));
type Ctx = { context: { slot: number } };
interface RawAccount { owner: string; lamports: number; data: [string, string] | { parsed?: { type: string; info: Record<string, any> }; program?: string }; space?: number } // eslint-disable-line @typescript-eslint/no-explicit-any
interface TokenAcct { pubkey: string; mint: string; owner: string; amount: string; decimals: number; frozen: boolean; delegate: string | null; program: string }
interface DasAsset { id: string; interface: string; content?: { json_uri?: string; metadata?: { name?: string; symbol?: string } }; compression?: { compressed?: boolean; tree?: string; leaf_id?: number; seq?: number };
  grouping?: { group_key: string; group_value: string; verified?: boolean }[]; royalty?: { basis_points?: number }; creators?: { address: string; share: number; verified: boolean }[];
  ownership?: { owner?: string; frozen?: boolean; delegated?: boolean; delegate?: string | null }; mutable?: boolean; burnt?: boolean; authorities?: { address: string }[] }

export interface SolanaDeps { rpc: RpcFn; now: () => Date; /** DAS endpoint: a URL, null = probe the RPC endpoints, 'off' */ dasUrl: string | null | 'off'; network?: NetworkDef }

export function solanaProvider(deps: SolanaDeps): NftDataProvider {
  const net = () => deps.network ?? getNetwork(CHAIN);
  const urls = () => net().rpc;
  const iso = () => deps.now().toISOString();

  /** First endpoint that answers; a JSON-RPC error is an answer and is thrown (it says the method is refused there) only when every endpoint gave one. */
  async function any<T>(method: string, params: unknown, only?: string[]): Promise<{ result: T; host: string }> {
    let last: unknown = new Error('no endpoint');
    // an endpoint that ANSWERS with an error ("this method is refused here") says more than one that is unreachable: its error is the one reported
    for (const u of only ?? urls()) { try { return { result: (await deps.rpc(u, method, params)) as T, host: hostOnly(u) }; } catch (e) { if (rpcCodeOf(e) !== undefined || rpcCodeOf(last) === undefined) last = e; } }
    throw last;
  }
  const fail = (e: unknown, what: string): NftProviderError => {
    if (e instanceof NftProviderError) return e;
    const c = rpcCodeOf(e), m = String((e as Error).message ?? '');
    return new NftProviderError(c === 429 || /429|too many|rate/i.test(m) ? 'provider_rate_limited' : c === -32601 || /method not found|personal token|not supported/i.test(m) ? 'provider_method_unsupported' : c !== undefined ? 'provider_bad_answer' : 'provider_unavailable', 'solana-rpc', what);
  };
  /** The same accounts from EVERY endpoint: agreeing answers are `chain_verified`; one answer only is `chain_single_source`. */
  async function accounts(addrs: string[], encoding: 'base64' | 'jsonParsed'): Promise<{ values: (RawAccount | null)[]; stamp: (covers: DataSourceStamp['covers']) => DataSourceStamp; slot: string }> {
    const rs = await Promise.allSettled(urls().map(async (u) => ({ host: hostOnly(u), r: (await deps.rpc(u, 'getMultipleAccounts', [addrs, { encoding, commitment: COMMIT }])) as Ctx & { value: (RawAccount | null)[] } })));
    const ok = rs.flatMap((r) => (r.status === 'fulfilled' && Array.isArray(r.value.r?.value) && r.value.r.value.length === addrs.length ? [r.value] : []));
    if (!ok.length) throw fail((rs.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined)?.reason ?? new Error('no answer'), 'getMultipleAccounts');
    const best = ok.reduce((a, b) => (b.r.context.slot > a.r.context.slot ? b : a));
    const same = ok.length > 1 && ok.every((x) => JSON.stringify(x.r.value.map((v) => v && [v.owner, v.data])) === JSON.stringify(best.r.value.map((v) => v && [v.owner, v.data])));
    const confidence: Confidence = same ? 'chain_verified' : 'chain_single_source';
    const hosts = (same ? ok : [best]).map((x) => x.host).join(', ') + (ok.length > 1 && !same ? ' (endpoints differ: newest slot used)' : '');
    return { values: best.r.value, slot: String(best.r.context.slot), stamp: (covers) => ({ category: 'onchain', source: 'solana-rpc', detail: hosts, fetchedAt: iso(), blockRef: { slot: String(best.r.context.slot), commitment: COMMIT }, confidence, freshness: 'fresh', covers }) };
  }
  const chunked = async <T>(xs: T[], n: number, f: (c: T[]) => Promise<void>) => { for (let k = 0; k < xs.length; k += n) await f(xs.slice(k, k + n)); };
  const parsedInfo = (a: RawAccount | null) => (a && !Array.isArray(a.data) ? a.data.parsed ?? null : null);
  const rawBytes = (a: RawAccount | null): Uint8Array | null => (a && Array.isArray(a.data) ? b64(a.data[0]) : null);
  const tokenAcct = (pubkey: string, a: RawAccount | null): TokenAcct | null => {
    const p = parsedInfo(a);
    if (!a || !p || p.type !== 'account') return null;
    const i = p.info;
    return { pubkey, mint: String(i.mint), owner: String(i.owner), amount: String(i.tokenAmount?.amount ?? '0'), decimals: Number(i.tokenAmount?.decimals ?? -1), frozen: i.state === 'frozen', delegate: i.delegate && String(i.delegatedAmount?.amount ?? '0') !== '0' ? String(i.delegate) : null, program: a.owner };
  };

  // ── DAS (indexed) ───────────────────────────────────────────────────────────────────────────────────────────────────
  let dasHost: string | null | undefined; // undefined = not probed yet
  async function das<T>(method: string, params: Record<string, unknown>): Promise<{ result: T; host: string }> {
    if (deps.dasUrl === 'off') throw new NftProviderError('provider_not_configured', 'solana-das', 'NFT_SOLANA_DAS=off');
    const cands = deps.dasUrl ? [deps.dasUrl] : urls();
    let last: unknown = null;
    for (const u of cands) {
      try { const result = (await deps.rpc(u, method, params)) as T; dasHost = hostOnly(u); return { result, host: dasHost }; }
      catch (e) { if (rpcCodeOf(e) !== undefined || rpcCodeOf(last) === undefined) last = e; }
    }
    const m = String((last as Error | null)?.message ?? ''), c = rpcCodeOf(last);
    if (/not found|RecordNotFound/i.test(m) && c !== -32601) throw new NftProviderError('not_found', 'solana-das');
    if (c === -32601 || /method not found/i.test(m)) { dasHost = null; throw new NftProviderError('provider_method_unsupported', 'solana-das', 'no configured endpoint serves DAS methods'); }
    throw new NftProviderError(c === 429 || /429|too many/i.test(m) ? 'provider_rate_limited' : 'provider_unavailable', 'solana-das');
  }
  const dasStamp = (host: string, covers: DataSourceStamp['covers']): DataSourceStamp => ({ category: 'indexed', source: 'solana-das', detail: host, fetchedAt: iso(), confidence: 'indexer_reported', freshness: 'unknown', covers });
  function fromDas(d: DasAsset, host: string, wallet: string | null, origin: NftAsset['origin']): NftAsset {
    const owner = d.ownership?.owner ?? null, held = !!wallet && owner === wallet, src = dasStamp(host, ['ownership', 'identity', 'state', 'collection']);
    const g = d.grouping?.find((x) => x.group_key === 'collection');
    const compressed = d.compression?.compressed === true;
    const ownership: NftOwnershipRecord = { state: d.burnt ? 'burned' : owner === null ? 'unknown' : held ? (d.ownership?.delegated ? 'escrow_or_delegated' : 'in_wallet') : 'not_in_wallet', owner: owner ? known(owner) : unknown('indexer gave no owner'), tokenAccount: UNSUPPORTED,
      frozen: typeof d.ownership?.frozen === 'boolean' ? known(d.ownership.frozen) : unknown(), delegate: d.ownership?.delegate ? known(d.ownership.delegate) : d.ownership?.delegated === false ? NONE : unknown(), tokenRecordState: UNSUPPORTED, heldByWallet: held, source: src };
    return buildAsset({ family: FAMILY, chainId: CHAIN, assetId: d.id, key: key(d.id), standard: compressed ? 'metaplex-bubblegum' : d.interface === 'MplCoreAsset' ? 'metaplex-core' : d.interface === 'ProgrammableNFT' ? 'metaplex-pnft' : 'metaplex-token-metadata', ownerAddress: held ? wallet : null,
      mintAddress: compressed ? null : d.id, quantity: d.burnt ? '0' : held || !wallet ? '1' : '0', supply: d.burnt ? known('0') : known('1'),
      collection: g ? { key: key(g.group_value), id: g.group_value, verifiedOnChain: typeof g.verified === 'boolean' ? known(g.verified) : unknown('the indexer does not say whether the collection is verified'), name: null, source: src } : null,
      updateAuthority: d.authorities?.[0]?.address ? known(d.authorities[0].address) : unknown(), creators: Array.isArray(d.creators) ? known(d.creators.map((c) => ({ address: c.address, verified: !!c.verified, share: Number(c.share) || 0 }))) : unknown(),
      tokenProgram: compressed ? BUBBLEGUM_PROGRAM : null, royaltyBps: typeof d.royalty?.basis_points === 'number' ? known(d.royalty.basis_points) : unknown(), extensions: compressed ? [`tree:${d.compression?.tree ?? ''}`, `leaf:${d.compression?.leaf_id ?? ''}`] : [],
      metadata: emptyMetadata(d.content?.json_uri || null, { onchainName: plainText(d.content?.metadata?.name, 200), onchainSymbol: plainText(d.content?.metadata?.symbol, 40), mutable: typeof d.mutable === 'boolean' ? known(d.mutable) : unknown(), traitStatistics: { computed: false, reason: compressed ? 'compressed' : 'no_collection_index' } }),
      ownership, sources: [src], fetchedAt: iso(), origin, explorerUrl: net().explorerAddr.replace('/account/', '/token/') + d.id });
  }

  // ── SPL / Token Metadata ────────────────────────────────────────────────────────────────────────────────────────────
  const collectionOf = (md: TmMetadata, src: DataSourceStamp): NftCollectionRef | null => (md.collection ? { key: key(md.collection.key), id: md.collection.key, verifiedOnChain: known(md.collection.verified), name: null, source: src } : null);
  function splAsset(p: { mint: string; mintAcct: RawAccount; md: TmMetadata | null; edition: ReturnType<typeof decodeTmEdition> | null; holder: TokenAcct | null; holderKnown: boolean; record: ReturnType<typeof decodeTmTokenRecord> | null; recordChecked: boolean; wallet: string | null; origin: NftAsset['origin']; stamp: DataSourceStamp; holderStamp?: DataSourceStamp }): NftAsset {
    const info = parsedInfo(p.mintAcct)!.info, is2022 = p.mintAcct.owner === TOKEN_2022_PROGRAM, supply = String(info.supply);
    const exts: { extension: string; state?: Record<string, unknown> }[] = Array.isArray(info.extensions) ? info.extensions : [];
    const tmExt = exts.find((e) => e.extension === 'tokenMetadata')?.state as { name?: string; symbol?: string; uri?: string; updateAuthority?: string } | undefined;
    const pnft = p.md?.tokenStandard === 'ProgrammableNonFungible' || p.md?.tokenStandard === 'ProgrammableNonFungibleEdition';
    const standard: NftStandard = pnft ? 'metaplex-pnft' : is2022 ? 'spl-token-2022' : p.md ? 'metaplex-token-metadata' : 'spl-token';
    const h = p.holder, held = !!h && !!p.wallet && h.owner === p.wallet && h.amount !== '0';
    const src = p.holderStamp ?? p.stamp;
    const ownership: NftOwnershipRecord = {
      state: supply === '0' ? 'burned' : !h ? 'unknown' : held ? (h.delegate || (p.record && p.record.state !== 'unlocked') ? 'escrow_or_delegated' : 'in_wallet') : 'not_in_wallet',
      owner: h ? known(h.owner) : supply === '0' ? NONE : unknown(p.holderKnown ? 'no token account holds this mint' : 'the holder could not be read (largest-accounts query refused or rate-limited)'),
      tokenAccount: h ? known(h.pubkey) : supply === '0' ? NONE : unknown(), frozen: h ? known(h.frozen) : unknown(), delegate: h ? (h.delegate ? known(h.delegate) : p.record?.delegate ? known(p.record.delegate) : NONE) : unknown(),
      tokenRecordState: pnft ? (p.record ? known(p.record.state) : unknown(p.recordChecked ? 'no token record account' : 'not read')) : UNSUPPORTED, heldByWallet: held, source: src };
    const uri = (p.md?.uri || tmExt?.uri || '').trim() || null;
    return buildAsset({ family: FAMILY, chainId: CHAIN, assetId: p.mint, key: key(p.mint), standard, ownerAddress: held ? p.wallet : null, mintAddress: p.mint, quantity: held ? h!.amount : p.wallet ? '0' : supply, supply: known(supply),
      collection: p.md ? collectionOf(p.md, p.stamp) : null, updateAuthority: p.md ? known(p.md.updateAuthority) : tmExt?.updateAuthority ? known(String(tmExt.updateAuthority)) : NONE,
      creators: p.md ? (p.md.creators ? known(p.md.creators) : NONE) : UNSUPPORTED, tokenProgram: p.mintAcct.owner, royaltyBps: p.md ? known(p.md.sellerFeeBasisPoints) : UNSUPPORTED,
      ruleSet: pnft ? (p.md!.programmableConfig?.ruleSet ? known(p.md!.programmableConfig.ruleSet) : NONE) : UNSUPPORTED,
      extensions: [...exts.map((e) => e.extension), ...(p.edition ? [p.edition.kind === 'master' ? `masterEdition:${p.edition.supply}/${p.edition.maxSupply ?? '∞'}` : `edition:${p.edition.edition}`] : []), ...(info.freezeAuthority ? ['freezeAuthority'] : [])],
      metadata: emptyMetadata(uri, { onchainName: plainText(p.md?.name ?? tmExt?.name, 200), onchainSymbol: plainText(p.md?.symbol ?? tmExt?.symbol, 40), mutable: p.md ? known(p.md.isMutable) : tmExt ? (tmExt.updateAuthority ? known(true) : known(false)) : UNSUPPORTED }),
      ownership, sources: p.holderStamp ? [p.stamp, p.holderStamp] : [p.stamp], fetchedAt: iso(), blockRef: p.stamp.blockRef, origin: p.origin, explorerUrl: net().explorerAddr.replace('/account/', '/token/') + p.mint });
  }
  const tryDecode = <T>(f: () => T): T | null => { try { return f(); } catch { return null; } };
  /** mint accounts + their metadata / edition PDAs, for a list of mints */
  async function mintBundle(mints: string[]) {
    const out = new Map<string, { mintAcct: RawAccount | null; md: TmMetadata | null; edition: ReturnType<typeof decodeTmEdition> | null; stamp: DataSourceStamp }>();
    await chunked(mints, 33, async (c) => {
      const [parsed, raw] = await Promise.all([accounts(c, 'jsonParsed'), accounts(c.flatMap((m) => [metadataPda(m), editionPda(m)]), 'base64')]);
      c.forEach((m, k) => {
        const mdB = rawBytes(raw.values[k * 2] ?? null), edB = rawBytes(raw.values[k * 2 + 1] ?? null);
        out.set(m, { mintAcct: parsed.values[k] ?? null, md: mdB ? tryDecode(() => decodeTmMetadata(mdB)) : null, edition: edB ? tryDecode(() => decodeTmEdition(edB)) : null, stamp: parsed.stamp(['ownership', 'identity', 'state', 'collection']) });
      });
    });
    return out;
  }
  const isNftMint = (a: RawAccount | null): boolean => { const p = parsedInfo(a); return !!a && !!p && p.type === 'mint' && (a.owner === TOKEN_PROGRAM || a.owner === TOKEN_2022_PROGRAM) && Number(p.info.decimals) === 0 && (String(p.info.supply) === '1' || String(p.info.supply) === '0'); };
  async function tokenRecords(pairs: { mint: string; tokenAccount: string }[]) {
    const out = new Map<string, ReturnType<typeof decodeTmTokenRecord> | null>();
    await chunked(pairs, 100, async (c) => { const r = await accounts(c.map((p) => tokenRecordPda(p.mint, p.tokenAccount)), 'base64'); c.forEach((p, k) => { const b = rawBytes(r.values[k] ?? null); out.set(p.mint, b ? tryDecode(() => decodeTmTokenRecord(b)) : null); }); });
    return out;
  }

  // ── Core ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const pluginNames = (p: CorePlugins, prefix: string) => p.plugins.map((x) => `${prefix}:${x.type}${x.frozen ? ':frozen' : ''}`);
  function coreAsset(id: string, a: CoreAsset, coll: CoreCollection | null, wallet: string | null, origin: NftAsset['origin'], stamp: DataSourceStamp): NftAsset {
    const held = !!wallet && a.owner === wallet, all = [...a.plugins.plugins, ...(coll?.plugins.plugins ?? [])];
    const frozen = all.some((p) => (p.type === 'FreezeDelegate' || p.type === 'PermanentFreezeDelegate') && p.frozen === true);
    const del = a.plugins.plugins.find((p) => p.type === 'TransferDelegate' && p.authority.type === 'Address');
    const royalties = all.find((p) => p.type === 'Royalties');
    const immutable = all.some((p) => p.type === 'ImmutableMetadata') || a.updateAuthority.type === 'None';
    const collId = a.updateAuthority.type === 'Collection' ? a.updateAuthority.address : null;
    const complete = a.plugins.complete && (coll ? coll.plugins.complete : true);
    const ownership: NftOwnershipRecord = { state: held ? (del ? 'escrow_or_delegated' : 'in_wallet') : 'not_in_wallet', owner: known(a.owner), tokenAccount: UNSUPPORTED, frozen: complete || frozen ? known(frozen) : unknown('plugin registry not fully decoded'),
      delegate: del && del.authority.type === 'Address' ? known(del.authority.address) : complete ? NONE : unknown(), tokenRecordState: UNSUPPORTED, heldByWallet: held, source: stamp };
    return buildAsset({ family: FAMILY, chainId: CHAIN, assetId: id, key: key(id), standard: 'metaplex-core', ownerAddress: held ? wallet : null, mintAddress: id, quantity: held || !wallet ? '1' : '0', supply: known('1'),
      // membership of a Core collection is written by the Core program itself (update authority = the collection): it cannot be self-declared
      collection: collId ? { key: key(collId), id: collId, verifiedOnChain: known(true), name: coll ? plainText(coll.name, 200) : null, source: stamp } : null,
      updateAuthority: a.updateAuthority.type === 'Address' ? known(a.updateAuthority.address) : a.updateAuthority.type === 'Collection' ? (coll ? known(coll.updateAuthority) : unknown('collection account not read')) : NONE,
      creators: UNSUPPORTED, tokenProgram: CORE_PROGRAM, royaltyBps: royalties?.basisPoints !== undefined ? known(royalties.basisPoints) : complete ? NONE : unknown(),
      extensions: [...pluginNames(a.plugins, 'core'), ...(coll ? pluginNames(coll.plugins, 'core-collection') : [])],
      metadata: emptyMetadata(a.uri.trim() || null, { onchainName: plainText(a.name, 200), mutable: known(!immutable) }), ownership, sources: [stamp], fetchedAt: iso(), blockRef: stamp.blockRef, origin,
      explorerUrl: net().explorerAddr.replace('/account/', '/token/') + id });
  }
  async function coreCollections(ids: string[]): Promise<Map<string, CoreCollection | null>> {
    const out = new Map<string, CoreCollection | null>();
    await chunked([...new Set(ids)], 100, async (c) => { const r = await accounts(c, 'base64'); c.forEach((id, k) => { const a = r.values[k] ?? null, b = rawBytes(a); out.set(id, a && a.owner === CORE_PROGRAM && b ? tryDecode(() => decodeCoreCollection(b)) : null); }); });
    return out;
  }

  const section = (s: string, o: Partial<InventorySection> = {}): InventorySection => ({ section: s, status: 'ok', code: null, unlockedBy: null, source: null, count: 0, truncated: false, ...o });
  const sectionError = (s: string, e: unknown, unlockedBy: string | null): InventorySection => {
    const pe = fail(e, s);
    return section(s, { status: pe.code === 'provider_method_unsupported' || pe.code === 'provider_not_configured' ? 'blocked_by_provider' : 'error', code: pe.code, unlockedBy: pe.code === 'provider_method_unsupported' || pe.code === 'provider_not_configured' ? unlockedBy : null });
  };

  return {
    id: 'solana', family: FAMILY, chains: () => [CHAIN],

    async inventory(_chain, owner, o): Promise<InventoryResult> {
      const assets: NftAsset[] = [], sections: InventorySection[] = [];
      // token accounts
      try {
        const rs = await Promise.all([TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((programId) => any<Ctx & { value: { pubkey: string; account: RawAccount }[] }>('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment: COMMIT }])));
        const held = rs.flatMap((r) => r.result.value.map((v) => tokenAcct(v.pubkey, v.account))).filter((t): t is TokenAcct => !!t && t.decimals === 0 && t.amount === '1');
        const take = held.slice(0, o.max), bundle = await mintBundle(take.map((t) => t.mint));
        const nfts = take.filter((t) => isNftMint(bundle.get(t.mint)?.mintAcct ?? null));
        const pn = nfts.filter((t) => { const s = bundle.get(t.mint)!.md?.tokenStandard; return s === 'ProgrammableNonFungible' || s === 'ProgrammableNonFungibleEdition'; });
        const recs = pn.length ? await tokenRecords(pn.map((t) => ({ mint: t.mint, tokenAccount: t.pubkey }))) : new Map<string, null>();
        for (const t of nfts) { const b = bundle.get(t.mint)!; assets.push(splAsset({ mint: t.mint, mintAcct: b.mintAcct!, md: b.md, edition: b.edition, holder: t, holderKnown: true, record: recs.get(t.mint) ?? null, recordChecked: recs.has(t.mint), wallet: owner, origin: 'discovered', stamp: { ...b.stamp, detail: `${b.stamp.detail}; token accounts from ${rs[0]!.host}` } })); }
        sections.push(section('token', { source: 'solana-rpc', count: nfts.length, truncated: held.length > take.length }));
      } catch (e) { sections.push(sectionError('token', e, null)); }
      // Core assets
      try {
        const r = await any<{ pubkey: string; account: RawAccount }[]>('getProgramAccounts', [CORE_PROGRAM, { encoding: 'base64', commitment: COMMIT, filters: [{ memcmp: { offset: 0, bytes: '2' } }, { memcmp: { offset: 1, bytes: owner } }] }]);
        const rows = r.result.slice(0, o.max).flatMap((x) => { const b = rawBytes(x.account), a = b && tryDecode(() => decodeCoreAsset(b)); return a && a.owner === owner ? [{ id: x.pubkey, a }] : []; });
        const colls = await coreCollections(rows.flatMap((x) => (x.a.updateAuthority.type === 'Collection' ? [x.a.updateAuthority.address] : [])));
        const stamp: DataSourceStamp = { category: 'onchain', source: 'solana-rpc', detail: r.host, fetchedAt: iso(), blockRef: { commitment: COMMIT }, confidence: 'chain_single_source', freshness: 'fresh', covers: ['ownership', 'identity', 'state', 'collection'] };
        for (const x of rows) assets.push(coreAsset(x.id, x.a, x.a.updateAuthority.type === 'Collection' ? colls.get(x.a.updateAuthority.address) ?? null : null, owner, 'discovered', stamp));
        sections.push(section('core', { source: 'solana-rpc', count: rows.length, truncated: r.result.length > o.max }));
      } catch (e) { sections.push(sectionError('core', e, 'SPW_RPC_EXTRA')); }
      // compressed (indexed)
      try {
        let page = 1, n = 0, truncated = false, host = '';
        for (;;) {
          const r = await das<{ total: number; items: DasAsset[] }>('searchAssets', { ownerAddress: owner, compressed: true, page, limit: 100 });
          host = r.host;
          for (const d of r.result.items ?? []) { if (d.compression?.compressed !== true || d.burnt) continue; if (n >= o.max) { truncated = true; break; } assets.push(fromDas(d, r.host, owner, 'discovered')); n++; }
          if (truncated || (r.result.items ?? []).length < 100 || page >= 10) { truncated ||= page >= 10 && (r.result.items ?? []).length === 100; break; }
          page++;
        }
        sections.push(section('compressed', { source: `solana-das (${host})`, count: n, truncated }));
      } catch (e) { sections.push(e instanceof NftProviderError && e.code === 'not_found' ? section('compressed', { source: 'solana-das' }) : sectionError('compressed', e, 'NFT_SOLANA_DAS_URL')); }
      // manual additions that discovery did not return (e.g. Core assets when getProgramAccounts is refused)
      for (const id of o.manual) { if (assets.some((a) => a.assetId === id)) continue; try { const a = await this.lookup(CHAIN, { address: id }, owner); assets.push({ ...a, origin: 'manual' }); } catch { /* kept in the manual list; shown as unverifiable by the service */ } }
      return { assets, sections };
    },

    async lookup(_chain, ref, wallet): Promise<NftAsset> {
      const id = ref.address.trim();
      if (!isSolanaAddress(id)) throw new NftProviderError('bad_identifier', 'solana-rpc', 'not a Solana address');
      const first = await accounts([id], 'base64'), acct = first.values[0] ?? null, stamp = first.stamp(['ownership', 'identity', 'state', 'collection']);
      if (!acct) {
        // no account: a compressed asset id (known to an indexer only), a burned asset, or nothing
        try { const d = await das<DasAsset>('getAsset', { id }); return fromDas(d.result, d.host, wallet, 'lookup'); }
        catch (e) { if (e instanceof NftProviderError && e.code !== 'not_found') throw new NftProviderError('not_found', 'solana-rpc', `no account at this address; indexer: ${e.code}`); throw new NftProviderError('not_found', 'solana-rpc', 'no account at this address'); }
      }
      if (acct.owner === CORE_PROGRAM) {
        const bytes = rawBytes(acct)!, kind = coreAccountKind(bytes);
        if (kind === 'collection') throw new NftProviderError('bad_identifier', 'solana-rpc', 'core_collection');
        if (kind === 'uninitialized') {
          const o: NftOwnershipRecord = { state: 'burned', owner: NONE, tokenAccount: UNSUPPORTED, frozen: UNSUPPORTED, delegate: NONE, tokenRecordState: UNSUPPORTED, heldByWallet: false, source: stamp };
          return buildAsset({ family: FAMILY, chainId: CHAIN, assetId: id, key: key(id), standard: 'metaplex-core', ownerAddress: null, mintAddress: id, quantity: '0', supply: known('0'), tokenProgram: CORE_PROGRAM, metadata: emptyMetadata(null), ownership: o, sources: [stamp], fetchedAt: iso(), blockRef: stamp.blockRef, origin: 'lookup', explorerUrl: net().explorerAddr + id });
        }
        if (kind !== 'asset') throw new NftProviderError('unsupported_standard', 'solana-rpc', `core_${kind}`);
        const a = decodeCoreAsset(bytes);
        const coll = a.updateAuthority.type === 'Collection' ? (await coreCollections([a.updateAuthority.address])).get(a.updateAuthority.address) ?? null : null;
        return coreAsset(id, a, coll, wallet, 'lookup', stamp);
      }
      if (acct.owner !== TOKEN_PROGRAM && acct.owner !== TOKEN_2022_PROGRAM) throw new NftProviderError('unsupported_standard', 'solana-rpc', acct.owner === '11111111111111111111111111111111' ? 'wallet_address' : 'not_a_token_account');
      const parsed = (await accounts([id], 'jsonParsed')).values[0] ?? null, p = parsedInfo(parsed);
      if (p?.type === 'account') return this.lookup(CHAIN, { address: String(p.info.mint) }, wallet); // a token account was given: its mint is the asset
      if (!parsed || p?.type !== 'mint') throw new NftProviderError('unsupported_standard', 'solana-rpc', 'not_a_mint');
      if (!isNftMint(parsed)) throw new NftProviderError('unsupported_standard', 'solana-rpc', 'fungible_token');
      const b = (await mintBundle([id])).get(id)!;
      // the holder: the token account with the unit. An "indexed request" on some endpoints — its failure leaves the holder unknown, never guessed.
      let holder: TokenAcct | null = null, holderKnown = false, holderStamp: DataSourceStamp | undefined, indexedOwner: { owner: string; stamp: DataSourceStamp } | null = null;
      if (String(p.info.supply) !== '0') {
        try {
          const l = await any<Ctx & { value: { address: string; amount: string }[] }>('getTokenLargestAccounts', [id, { commitment: COMMIT }]);
          holderKnown = true;
          const top = l.result.value.find((x) => x.amount !== '0');
          if (top) { const t = await accounts([top.address], 'jsonParsed'); holder = tokenAcct(top.address, t.values[0] ?? null); holderStamp = t.stamp(['ownership', 'state']); }
        } catch {
          // fall back to the wallet's own associated account only (a direct read): says "in this wallet" or leaves the holder unknown
          if (wallet) { try { const r = await any<Ctx & { value: { pubkey: string; account: RawAccount }[] }>('getTokenAccountsByOwner', [wallet, { mint: id }, { encoding: 'jsonParsed', commitment: COMMIT }]); const t = r.result.value.map((v) => tokenAcct(v.pubkey, v.account)).find((x) => x && x.amount !== '0'); if (t) { holder = t; holderKnown = true; } } catch { /* unknown */ } }
          // an indexer's owner is a HINT: the owner's associated token account is then read on-chain, and only that read says who holds the unit
          if (!holder) {
            try {
              const d = await das<DasAsset>('getAsset', { id }), hint = d.result.ownership?.owner;
              if (hint && isSolanaAddress(hint)) {
                const ata = associatedTokenAddress(hint, id, parsed.owner), t = await accounts([ata], 'jsonParsed'), acct2 = tokenAcct(ata, t.values[0] ?? null);
                if (acct2 && acct2.mint === id && acct2.owner === hint && acct2.amount !== '0') { holder = acct2; holderKnown = true; holderStamp = t.stamp(['ownership', 'state']); }
                else indexedOwner = { owner: hint, stamp: dasStamp(d.host, ['ownership']) };
              }
            } catch { /* holder stays unknown */ }
          }
        }
      }
      const pn = b.md?.tokenStandard === 'ProgrammableNonFungible' || b.md?.tokenStandard === 'ProgrammableNonFungibleEdition';
      const recs = pn && holder ? await tokenRecords([{ mint: id, tokenAccount: holder.pubkey }]).catch(() => null) : null;
      const out = splAsset({ mint: id, mintAcct: parsed, md: b.md, edition: b.edition, holder, holderKnown, record: recs?.get(id) ?? null, recordChecked: !!recs, wallet, origin: 'lookup', stamp, holderStamp });
      if (!holder && indexedOwner) {
        // the token account could not be read: the owner is what the indexer says, shown as indexed — not as chain truth
        const held = !!wallet && indexedOwner.owner === wallet;
        out.ownership = { ...out.ownership, state: held ? 'in_wallet' : 'not_in_wallet', owner: known(indexedOwner.owner), heldByWallet: held, source: indexedOwner.stamp };
        out.sources.push(indexedOwner.stamp); out.capabilities = capabilitiesOf(out);
      }
      return out;
    },

    async events(asset, cursor): Promise<EventPage> {
      if (asset.standard === 'metaplex-bubblegum') return { events: [], cursor: null, completeness: 'unavailable', note: 'compressed_history_requires_indexer' };
      const id = asset.assetId, core = asset.standard === 'metaplex-core', LIMIT = 8;
      const targets = core ? [id] : [id, ...(asset.ownership.tokenAccount.state === 'known' ? [asset.ownership.tokenAccount.value] : [])];
      let sigs: { signature: string; slot: number; err: unknown; blockTime: number | null; confirmationStatus?: string }[] = [];
      try { for (const t of targets) sigs.push(...(await any<typeof sigs>('getSignaturesForAddress', [t, { limit: LIMIT * 3, commitment: COMMIT, ...(cursor ? { before: cursor } : {}) }])).result); }
      catch (e) { throw fail(e, 'getSignaturesForAddress'); }
      const seen = new Set<string>();
      sigs = sigs.filter((s) => !s.err && !seen.has(s.signature) && seen.add(s.signature)).sort((a, b) => b.slot - a.slot);
      const page = sigs.slice(0, LIMIT), events: NftEvent[] = [];
      for (const s of page) {
        let tx: any; // eslint-disable-line @typescript-eslint/no-explicit-any
        let host: string;
        try { const r = await any<any>('getTransaction', [s.signature, { encoding: 'jsonParsed', commitment: COMMIT, maxSupportedTransactionVersion: 0 }]); tx = r.result; host = r.host; } catch (e) { throw fail(e, 'getTransaction'); } // eslint-disable-line @typescript-eslint/no-explicit-any
        if (!tx?.meta) continue;
        const src: DataSourceStamp = { category: 'onchain', source: 'solana-rpc', detail: host, fetchedAt: iso(), blockRef: { slot: String(s.slot), commitment: COMMIT }, confidence: 'chain_single_source', freshness: 'fresh', covers: ['events'] };
        const base = { assetKey: asset.key, tx: s.signature, blockRef: { slot: String(s.slot), commitment: COMMIT }, at: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null, price: null, finality: 'finalized' as const, source: src };
        const firstOfTx = events.length;
        if (core) {
          const outer: any[] = tx.transaction.message.instructions ?? [], inner: any[] = tx.meta.innerInstructions ?? []; // eslint-disable-line @typescript-eslint/no-explicit-any
          const all = [...outer.map((ix, k) => ({ ix, idx: String(k) })), ...inner.flatMap((g) => (g.instructions as any[]).map((ix, k) => ({ ix, idx: `${g.index}.${k}` })))]; // eslint-disable-line @typescript-eslint/no-explicit-any
          let n = 0;
          for (const { ix, idx } of all) {
            if (ix.programId !== CORE_PROGRAM || !Array.isArray(ix.accounts) || ix.accounts[0] !== id || typeof ix.data !== 'string') continue;
            const d = decodeCoreInstruction(ix.data, ix.accounts as string[]);
            n++;
            events.push({ ...base, id: `${asset.key}|${s.signature}|${idx}`, index: idx, type: d ? (d.kind === 'mint' ? 'mint' : d.kind === 'burn' ? 'burn' : 'transfer') : 'unknown',
              interpretation: { by: 'spw:core-instruction', note: d ? (d.authority ? `authority ${d.authority}` : null) : 'a Core instruction on this asset that does not move it (plugin, update, …)' }, from: null, to: d?.newOwner ?? null, quantity: '1' });
          }
          if (!n) events.push({ ...base, id: `${asset.key}|${s.signature}|-`, index: '-', type: 'unknown', interpretation: { by: 'spw:core-instruction', note: 'the asset account is referenced by a transaction with no Core instruction on it' }, from: null, to: null, quantity: '0' });
        } else {
          // owner-level balance change of THIS mint in the transaction: who went 1→0, who went 0→1
          const bal = (arr: any[]): Map<string, bigint> => { const m = new Map<string, bigint>(); for (const b of arr ?? []) if (b.mint === id && b.owner) m.set(b.owner, (m.get(b.owner) ?? 0n) + BigInt(b.uiTokenAmount?.amount ?? '0')); return m; }; // eslint-disable-line @typescript-eslint/no-explicit-any
          const pre = bal(tx.meta.preTokenBalances), post = bal(tx.meta.postTokenBalances);
          const owners = new Set([...pre.keys(), ...post.keys()]);
          const lost = [...owners].filter((o) => (pre.get(o) ?? 0n) > (post.get(o) ?? 0n)), gained = [...owners].filter((o) => (post.get(o) ?? 0n) > (pre.get(o) ?? 0n));
          const sum = (m: Map<string, bigint>) => [...m.values()].reduce((a, b) => a + b, 0n), d = sum(post) - sum(pre);
          if (!lost.length && !gained.length) continue; // the mint is referenced but no unit moved between owners (metadata update, delegate, freeze…)
          const type = d > 0n ? 'mint' : d < 0n ? 'burn' : 'transfer';
          const w = asset.ownerAddress;
          events.push({ ...base, id: `${asset.key}|${s.signature}|0`, index: '0', type: type === 'transfer' && w ? (gained.includes(w) ? 'transfer-in' : lost.includes(w) ? 'transfer-out' : 'transfer') : type,
            interpretation: { by: 'spw:token-balance-delta', note: 'from the pre/post token balances of the transaction; a payment in the same transaction is not interpreted as a sale' }, from: lost[0] ?? null, to: gained[0] ?? null, quantity: '1' });
        }
        // delivery 3: a known marketplace PROGRAM invoked in this transaction is NAMED — nothing more. No price is read: the
        // instruction and event layouts of these programs are not decoded here, and a transfer stays a transfer.
        const progs = new Set<string>([...(tx.transaction?.message?.instructions ?? []), ...((tx.meta.innerInstructions ?? []) as any[]).flatMap((g) => g.instructions ?? [])].map((ix: any) => String(ix?.programId ?? ''))); // eslint-disable-line @typescript-eslint/no-explicit-any
        const mp = [...progs].map(solanaMarketProgram).find((x) => x !== null) ?? null;
        if (mp) for (const e of events.slice(firstOfTx)) e.marketProgram = { id: mp.id, name: mp.name, source: mp.source };
      }
      const more = sigs.length > LIMIT || sigs.length >= LIMIT * 3;
      return { events, cursor: more && page.length ? page[page.length - 1]!.signature : null, completeness: core ? 'full' : 'partial',
        note: core ? null : 'history_from_mint_and_current_token_account' };
    },

    async collection(_chain, id): Promise<CollectionInfo> {
      if (!isSolanaAddress(id)) throw new NftProviderError('bad_identifier', 'solana-rpc');
      const r = await accounts([id, metadataPda(id)], 'base64'), a = r.values[0] ?? null, stamp = r.stamp(['collection']);
      if (!a) throw new NftProviderError('not_found', 'solana-rpc');
      if (a.owner === CORE_PROGRAM) {
        const c = tryDecode(() => decodeCoreCollection(rawBytes(a)!));
        if (!c) throw new NftProviderError('unsupported_standard', 'solana-rpc', 'not a Core collection');
        return { key: key(id), id, chain: CHAIN, standard: 'metaplex-core', onchainName: plainText(c.name, 200), uri: c.uri.trim() || null, size: known(String(c.currentSize)), updateAuthority: known(c.updateAuthority), features: pluginNames(c.plugins, 'core-collection'), source: stamp };
      }
      const mdB = rawBytes(r.values[1] ?? null), md = mdB ? tryDecode(() => decodeTmMetadata(mdB)) : null;
      if (!md) throw new NftProviderError('unsupported_standard', 'solana-rpc', 'no metadata account for this collection mint');
      return { key: key(id), id, chain: CHAIN, standard: 'metaplex-token-metadata', onchainName: plainText(md.name, 200), uri: md.uri.trim() || null, size: md.collectionDetails?.kind === 'V1' ? known(md.collectionDetails.size) : unknown('the collection is not sized on-chain'), updateAuthority: known(md.updateAuthority), features: [], source: stamp };
    },
  };
}
