// Solana NFT account decoders (Borsh, by hand — no dependency): Metaplex Token Metadata (Metadata, MasterEdition, Edition,
// TokenRecord) and Metaplex Core (AssetV1, CollectionV1, plugin header + registry). Pure: bytes in, fields out.
//
// Layouts taken from the programs' own source, read 2026-11-17 (URLs in docs/nft/NFT-SOURCES.md §Layouts):
//   mpl-token-metadata  programs/token-metadata/program/src/state/{mod,metadata,data,master_edition,edition,programmable}.rs, pda.rs
//   mpl-core            programs/mpl-core/src/state/{asset,collection,mod,update_authority}.rs, plugins/{mod,plugin_header,plugin_registry}.rs, instruction.rs
// and checked against real mainnet accounts (services/api/test/fixtures/nft, packages/nft/test/solana.test.ts).
//
// A decoder never guesses: a field that cannot be read is `null` / absent and `complete` is false; trailing optional fields of old
// Metadata accounts (written before the field existed) decode as absent, as the program itself treats them.
import { base58 } from '@scure/base';
import { findProgramAddress } from '@spw/core';

export const TOKEN_METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export const CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
export const BUBBLEGUM_PROGRAM = 'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY';

const enc = new TextEncoder();
const pk = (s: string) => base58.decode(s);
export const metadataPda = (mint: string): string => findProgramAddress([enc.encode('metadata'), pk(TOKEN_METADATA_PROGRAM), pk(mint)], TOKEN_METADATA_PROGRAM);
export const editionPda = (mint: string): string => findProgramAddress([enc.encode('metadata'), pk(TOKEN_METADATA_PROGRAM), pk(mint), enc.encode('edition')], TOKEN_METADATA_PROGRAM);
export const tokenRecordPda = (mint: string, tokenAccount: string): string =>
  findProgramAddress([enc.encode('metadata'), pk(TOKEN_METADATA_PROGRAM), pk(mint), enc.encode('token_record'), pk(tokenAccount)], TOKEN_METADATA_PROGRAM);
export const isSolanaAddress = (s: string): boolean => { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false; try { return base58.decode(s).length === 32; } catch { return false; } };

class Reader {
  o = 0;
  constructor(private b: Uint8Array) {}
  left(): number { return this.b.length - this.o; }
  private need(n: number): void { if (this.o + n > this.b.length) throw new Error('eof'); }
  u8(): number { this.need(1); return this.b[this.o++]!; }
  bool(): boolean { const v = this.u8(); if (v > 1) throw new Error('bool'); return v === 1; }
  u16(): number { this.need(2); const v = this.b[this.o]! | (this.b[this.o + 1]! << 8); this.o += 2; return v; }
  u32(): number { this.need(4); const v = (this.b[this.o]! | (this.b[this.o + 1]! << 8) | (this.b[this.o + 2]! << 16) | (this.b[this.o + 3]! << 24)) >>> 0; this.o += 4; return v; }
  u64(): bigint { this.need(8); let v = 0n; for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(this.b[this.o + k]!); this.o += 8; return v; }
  key(): string { this.need(32); const v = base58.encode(this.b.slice(this.o, this.o + 32)); this.o += 32; return v; }
  str(max = 4096): string { const n = this.u32(); if (n > max) throw new Error('string too long'); this.need(n); const v = new TextDecoder('utf-8').decode(this.b.slice(this.o, this.o + n)); this.o += n; return v; }
  opt<T>(f: () => T): T | null { const t = this.u8(); if (t === 0) return null; if (t !== 1) throw new Error('option tag'); return f(); }
  seek(o: number): void { if (o < 0 || o > this.b.length) throw new Error('seek'); this.o = o; }
}
/** On-chain strings of Token Metadata are padded with NUL to their maximum length. */
const unpad = (s: string): string => s.replace(/\0+$/, '');

// ── Token Metadata ──────────────────────────────────────────────────────────────────────────────────────────────────────
export const TOKEN_STANDARDS = ['NonFungible', 'FungibleAsset', 'Fungible', 'NonFungibleEdition', 'ProgrammableNonFungible', 'ProgrammableNonFungibleEdition'] as const;
export type TokenStandardName = (typeof TOKEN_STANDARDS)[number];
export interface TmMetadata {
  updateAuthority: string; mint: string; name: string; symbol: string; uri: string; sellerFeeBasisPoints: number;
  creators: { address: string; verified: boolean; share: number }[] | null;
  primarySaleHappened: boolean; isMutable: boolean; editionNonce: number | null;
  /** null: the field is absent (accounts written before token standards existed) */
  tokenStandard: TokenStandardName | null;
  collection: { verified: boolean; key: string } | null;
  uses: { useMethod: number; remaining: string; total: string } | null;
  collectionDetails: { kind: 'V1'; size: string } | { kind: 'V2' } | null;
  programmableConfig: { ruleSet: string | null } | null;
  /** false when a trailing optional field could not be read (it is then reported absent, like the program does) */
  complete: boolean;
}
export function decodeTmMetadata(data: Uint8Array): TmMetadata {
  const r = new Reader(data);
  if (r.u8() !== 4) throw new Error('not a MetadataV1 account');
  const updateAuthority = r.key(), mint = r.key(), name = unpad(r.str(200)), symbol = unpad(r.str(60)), uri = unpad(r.str(1024)), sellerFeeBasisPoints = r.u16();
  const creators = r.opt(() => { const n = r.u32(); if (n > 5) throw new Error('creators'); return Array.from({ length: n }, () => ({ address: r.key(), verified: r.bool(), share: r.u8() })); });
  const primarySaleHappened = r.bool(), isMutable = r.bool();
  const out: TmMetadata = { updateAuthority, mint, name, symbol, uri, sellerFeeBasisPoints, creators, primarySaleHappened, isMutable, editionNonce: null, tokenStandard: null, collection: null, uses: null, collectionDetails: null, programmableConfig: null, complete: true };
  try {
    out.editionNonce = r.opt(() => r.u8());
    out.tokenStandard = r.opt(() => { const v = TOKEN_STANDARDS[r.u8()]; if (!v) throw new Error('token standard'); return v; });
    out.collection = r.opt(() => ({ verified: r.bool(), key: r.key() }));
    out.uses = r.opt(() => { const m = r.u8(); if (m > 2) throw new Error('use method'); return { useMethod: m, remaining: r.u64().toString(), total: r.u64().toString() }; });
    out.collectionDetails = r.opt(() => { const v = r.u8(); if (v === 0) return { kind: 'V1' as const, size: r.u64().toString() }; if (v === 1) { r.u64(); return { kind: 'V2' as const }; } throw new Error('collection details'); });
    out.programmableConfig = r.opt(() => { if (r.u8() !== 0) throw new Error('programmable config'); return { ruleSet: r.opt(() => r.key()) }; });
  } catch { out.complete = false; }
  return out;
}
export type TmEdition = { kind: 'master'; supply: string; maxSupply: string | null } | { kind: 'edition'; parent: string; edition: string };
export function decodeTmEdition(data: Uint8Array): TmEdition {
  const r = new Reader(data), key = r.u8();
  if (key === 6 || key === 2) { const supply = r.u64().toString(); return { kind: 'master', supply, maxSupply: r.opt(() => r.u64().toString()) }; }
  if (key === 1) return { kind: 'edition', parent: r.key(), edition: r.u64().toString() };
  throw new Error('not an edition account');
}
export const TOKEN_STATES = ['unlocked', 'locked', 'listed'] as const;
export const TOKEN_DELEGATE_ROLES: Record<number, string> = { 0: 'Sale', 1: 'Transfer', 2: 'Utility', 3: 'Staking', 4: 'Standard', 5: 'LockedTransfer', 255: 'Migration' };
export interface TmTokenRecord { state: (typeof TOKEN_STATES)[number]; ruleSetRevision: string | null; delegate: string | null; delegateRole: string | null }
export function decodeTmTokenRecord(data: Uint8Array): TmTokenRecord {
  const r = new Reader(data);
  if (r.u8() !== 11) throw new Error('not a TokenRecord account');
  r.u8(); // bump
  const state = TOKEN_STATES[r.u8()];
  if (!state) throw new Error('token state');
  const ruleSetRevision = r.opt(() => r.u64().toString()), delegate = r.opt(() => r.key());
  const delegateRole = r.opt(() => { const v = r.u8(); return TOKEN_DELEGATE_ROLES[v] ?? `role_${v}`; });
  return { state, ruleSetRevision, delegate, delegateRole };
}

// ── Metaplex Core ───────────────────────────────────────────────────────────────────────────────────────────────────────
export const CORE_PLUGIN_TYPES = ['Royalties', 'FreezeDelegate', 'BurnDelegate', 'TransferDelegate', 'UpdateDelegate', 'PermanentFreezeDelegate', 'Attributes', 'PermanentTransferDelegate', 'PermanentBurnDelegate',
  'Edition', 'MasterEdition', 'AddBlocker', 'ImmutableMetadata', 'VerifiedCreators', 'Autograph', 'BubblegumV2', 'FreezeExecute', 'PermanentFreezeExecute', 'Groups'] as const;
export type CoreAuthority = { type: 'None' } | { type: 'Owner' } | { type: 'UpdateAuthority' } | { type: 'Address'; address: string };
export interface CorePlugin { type: string; authority: CoreAuthority; offset: number; /** FreezeDelegate / PermanentFreezeDelegate */ frozen?: boolean; /** Royalties */ basisPoints?: number;
  /** Attributes plugin: on-chain key/value pairs */ attributes?: { key: string; value: string }[] }
export interface CorePlugins { plugins: CorePlugin[]; externalCount: number; /** false when the registry could not be fully read */ complete: boolean }
export interface CoreAsset {
  owner: string;
  updateAuthority: { type: 'None' } | { type: 'Address'; address: string } | { type: 'Collection'; address: string };
  name: string; uri: string; seq: string | null; plugins: CorePlugins;
}
export interface CoreCollection { updateAuthority: string; name: string; uri: string; numMinted: number; currentSize: number; plugins: CorePlugins }

function readCorePlugins(data: Uint8Array, r: Reader): CorePlugins {
  if (r.left() === 0) return { plugins: [], externalCount: 0, complete: true };
  const out: CorePlugins = { plugins: [], externalCount: 0, complete: false };
  try {
    if (r.u8() !== 3) return out; // PluginHeaderV1
    const regOff = r.u64();
    if (regOff > BigInt(data.length)) return out;
    r.seek(Number(regOff));
    if (r.u8() !== 4) return out; // PluginRegistryV1
    const n = r.u32();
    if (n > 64) return out;
    for (let k = 0; k < n; k++) {
      const t = r.u8(), a = r.u8();
      const authority: CoreAuthority = a === 0 ? { type: 'None' } : a === 1 ? { type: 'Owner' } : a === 2 ? { type: 'UpdateAuthority' } : a === 3 ? { type: 'Address', address: r.key() } : (() => { throw new Error('authority'); })();
      const offset = Number(r.u64());
      out.plugins.push({ type: CORE_PLUGIN_TYPES[t] ?? `plugin_${t}`, authority, offset });
    }
    out.externalCount = r.u32();
    for (const p of out.plugins) {
      // the plugin's own data starts with its variant index (same order as the plugin types)
      try {
        const q = new Reader(data); q.seek(p.offset); q.u8();
        if (p.type === 'FreezeDelegate' || p.type === 'PermanentFreezeDelegate') p.frozen = q.bool();
        else if (p.type === 'Royalties') p.basisPoints = q.u16();
        else if (p.type === 'Attributes') { const m = q.u32(); if (m <= 200) p.attributes = Array.from({ length: m }, () => ({ key: q.str(400), value: q.str(2000) })); }
      } catch { /* this plugin's data is left undecoded */ }
    }
    out.complete = true;
  } catch { /* partial registry: complete stays false */ }
  return out;
}
export function decodeCoreAsset(data: Uint8Array): CoreAsset {
  const r = new Reader(data);
  if (r.u8() !== 1) throw new Error('not a Core AssetV1 account');
  const owner = r.key(), ua = r.u8();
  const updateAuthority: CoreAsset['updateAuthority'] = ua === 0 ? { type: 'None' } : ua === 1 ? { type: 'Address', address: r.key() } : ua === 2 ? { type: 'Collection', address: r.key() } : (() => { throw new Error('update authority'); })();
  const name = r.str(400), uri = r.str(2048), seq = r.opt(() => r.u64().toString());
  return { owner, updateAuthority, name, uri, seq, plugins: readCorePlugins(data, r) };
}
export function decodeCoreCollection(data: Uint8Array): CoreCollection {
  const r = new Reader(data);
  if (r.u8() !== 5) throw new Error('not a Core CollectionV1 account');
  const updateAuthority = r.key(), name = r.str(400), uri = r.str(2048), numMinted = r.u32(), currentSize = r.u32();
  return { updateAuthority, name, uri, numMinted, currentSize, plugins: readCorePlugins(data, r) };
}
/** First byte of a Core account: what it is. 0 = closed/burned asset (the program leaves a 1-byte account). */
export const coreAccountKind = (data: Uint8Array): 'uninitialized' | 'asset' | 'hashed-asset' | 'collection' | 'other' =>
  (data.length === 0 || data[0] === 0 ? 'uninitialized' : data[0] === 1 ? 'asset' : data[0] === 2 ? 'hashed-asset' : data[0] === 5 ? 'collection' : 'other');

/** Core instruction discriminators that change who holds an asset (instruction.rs, enum order) and where the accounts are. */
export const CORE_IX = { 0: 'CreateV1', 12: 'BurnV1', 14: 'TransferV1', 20: 'CreateV2' } as const;
export function decodeCoreInstruction(dataB58: string, accounts: string[]): { kind: 'mint' | 'transfer' | 'burn'; asset: string; newOwner: string | null; authority: string | null } | null {
  let d: Uint8Array; try { d = base58.decode(dataB58); } catch { return null; }
  const absent = (a: string | undefined) => (!a || a === CORE_PROGRAM ? null : a), ix = d[0];
  if (ix === 14 && accounts.length >= 5) return { kind: 'transfer', asset: accounts[0]!, newOwner: accounts[4]!, authority: absent(accounts[3]) ?? absent(accounts[2]) };
  if (ix === 12 && accounts.length >= 3) return { kind: 'burn', asset: accounts[0]!, newOwner: null, authority: absent(accounts[3]) ?? absent(accounts[2]) };
  if ((ix === 0 || ix === 20) && accounts.length >= 5) return { kind: 'mint', asset: accounts[0]!, newOwner: absent(accounts[4]) ?? absent(accounts[2]) ?? absent(accounts[3]), authority: absent(accounts[2]) };
  return null;
}
