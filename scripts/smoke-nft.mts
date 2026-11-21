/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/smoke-nft.mts
 * Module           : scripts
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

// NFT read-only smoke (delivery 1): prints what the wallet's own sources establish TODAY, live, for
//   1. the reference item of docs/nft/NFT-BRIEF.md (or any identifier given with --asset [--chain] [--token-id]);
//   2. the NFT inventory of the wallet of a LOCAL DEV STACK — its addresses are read from that stack's database
//      (settings.signerAddresses, written by the API from the signer's answer): --db <name>, default spw_dev; never production;
//   3. optionally the inventory of any PUBLIC address: --sol <address> and/or --evm <address>.
// Read-only: JSON-RPC reads and HTTPS GETs through the SSRF-safe fetcher. Nothing is signed, built, stored or sent.
//   npx tsx scripts/smoke-nft.mts [--db spw_dev] [--sol <address>] [--evm <address>] [--asset <id> --chain solana]
import { NETWORKS, type NetworkDef } from '@spw/core';

Object.assign(process.env, { SPW_ORIGIN: process.env.SPW_ORIGIN ?? 'http://localhost', SPW_RP_ID: process.env.SPW_RP_ID ?? 'localhost', DATABASE_URL: process.env.DATABASE_URL ?? 'postgres:///unused', SPW_SIGNER_SECRET: process.env.SPW_SIGNER_SECRET ?? 'x'.repeat(48) });
const { rpcOne } = await import('../services/api/src/chains/rpc.ts');
const { nftConfig } = await import('../services/api/src/nft/config.ts');
const { solanaProvider } = await import('../services/api/src/nft/solana.ts');
const { evmProvider } = await import('../services/api/src/nft/evm.ts');
const { safeFetch } = await import('../services/api/src/nft/safe-fetch.ts');
const { magicEdenMarket, externalMarketLinks } = await import('../services/api/src/nft/market.ts');
const { decideMedia, normaliseMetadata, parseBoundedJson, resolveUri, substituteErc1155Id } = await import('../packages/nft/src/index.ts');
type Asset = import('../packages/nft/src/index.ts').NftAsset;

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rpc = async (url: string, method: string, params: unknown) => { await sleep(250); return rpcOne<unknown>(url, method, params as unknown[]); };
const now = () => new Date(), cfg = nftConfig();
const sol = solanaProvider({ rpc, now, dasUrl: cfg.solanaDasUrl }), evm = evmProvider({ rpc, now, indexers: cfg.evmIndexers, http: fetch });
const k = (x: { state: string; value?: unknown; reason?: string }) => (x.state === 'known' ? JSON.stringify(x.value) : x.state === 'unknown' && x.reason ? `unknown (${x.reason})` : x.state);
const line = (label: string, v: unknown) => console.log(`  ${label.padEnd(26)} ${v}`);

async function showAsset(chain: string, address: string, tokenId?: string): Promise<void> {
  const p = chain === 'solana' ? sol : evm;
  console.log(`\n== asset ${chain} ${address}${tokenId ? ` #${tokenId}` : ''} — ${now().toISOString()}`);
  let a: Asset;
  try { a = await p.lookup(chain, { address, tokenId }, null); } catch (e) { console.log(`  NOT ESTABLISHED: ${(e as Error).message}`); return; }
  line('canonical key', a.key); line('standard', a.standard); line('program', a.tokenProgram ?? '—');
  line('on-chain name', a.metadata.onchainName ?? 'none'); line('on-chain symbol', a.metadata.onchainSymbol ?? 'none'); line('metadata URI', a.metadata.sourceUri ?? 'none');
  line('holder', k(a.ownership.owner)); line('token account', k(a.ownership.tokenAccount)); line('frozen', k(a.ownership.frozen)); line('delegate', k(a.ownership.delegate)); line('pNFT record state', k(a.ownership.tokenRecordState));
  line('supply', k(a.supply)); line('update authority', k(a.updateAuthority)); line('metadata mutable', k(a.metadata.mutable)); line('creators', k(a.creators)); line('royalty (bps)', k(a.royaltyBps)); line('rule set', k(a.ruleSet));
  line('collection', a.collection ? `${a.collection.id} — verified on-chain: ${k(a.collection.verifiedOnChain)} — on-chain name: ${a.collection.name ?? 'not read'}` : 'none declared');
  line('extensions / plugins', a.extensions.join(', ') || 'none');
  for (const s of a.sources) line(`source [${s.category}]`, `${s.source} · ${s.detail} · ${s.confidence}${s.blockRef?.slot ? ` · slot ${s.blockRef.slot}` : ''}`);
  line('transfer', a.capabilities.transferable ? 'possible (facts of the asset; the signer policy and the preparation decide)' : `blocked — ${a.capabilities.transferBlockedBy.join(', ')}`);
  // creator metadata, through the SSRF-safe fetcher
  if (a.metadata.sourceUri) {
    const uri = a.standard === 'erc1155' && a.tokenId ? substituteErc1155Id(a.metadata.sourceUri, a.tokenId) : a.metadata.sourceUri, r = resolveUri(uri, cfg.gateways, 'metadata');
    let text: string | null = null, from = '';
    if (!r.ok) console.log(`  creator metadata: REFUSED (${r.code})`);
    else if (r.kind === 'data') { text = new TextDecoder().decode(r.bytes); from = 'data: URI'; }
    else for (const c of r.candidates) { const f = await safeFetch(c, { maxBytes: 256 * 1024, timeoutMs: 12_000, accept: 'application/json' }); if (f.ok) { text = new TextDecoder().decode(f.bytes); from = new URL(f.finalUrl).host; break; } console.log(`  creator metadata: ${new URL(c).host} → ${f.code}${f.status ? ` ${f.status}` : ''}`); }
    if (text !== null) {
      const j = parseBoundedJson(text);
      if (!j.ok) console.log(`  creator metadata: not usable (${j.code})`);
      else { const n = normaliseMetadata(j.value);
        console.log(`  --- creator metadata (declared by the creator, from ${from}) ---`); line('name', n.name ?? 'none'); line('description', n.description ?? 'none'); line('external link', n.externalUrl ?? 'none'); line('image', n.image ?? 'none'); line('animation', n.animationUrl ?? 'none');
        for (const t of n.attributes) line(`trait ${t.traitType ?? '(unnamed)'}`, `${t.valueText}${t.malformed ? ' (malformed entry)' : ''}`);
        line('rarity / frequency', 'not computed (no complete collection index: unknown denominator)');
        if (n.image) { const ir = resolveUri(n.image, cfg.gateways, 'media');
          if (!ir.ok) line('image file', `REFUSED (${ir.code})`);
          else if (ir.kind === 'data') { const d = decideMedia(ir.mime, ir.bytes); line('image file', d.ok ? `${d.mime}, ${ir.bytes.length} bytes (data: URI)` : `REFUSED (${d.code})`); }
          else { const f = await safeFetch(ir.candidates[0]!, { maxBytes: cfg.mediaMaxBytes, timeoutMs: 30_000, accept: 'image/*' }); if (!f.ok) line('image file', `not fetched (${f.code})`); else { const d = decideMedia(f.contentType, f.bytes); line('image file', d.ok ? `${d.mime} (sniffed), ${f.bytes.length} bytes, from ${new URL(f.finalUrl).host}, ${f.hops} redirect(s)` : `REFUSED (${d.code})`); } } } }
    }
  } else console.log('  creator metadata: no URI declared — name, image and traits cannot be established');
  // market: only when the operator turned the source on
  if (cfg.marketMagicEden && chain === 'solana') { try { const m = await magicEdenMarket({ http: fetch, now }).snapshot(a); line('market [Magic Eden]', `listed ${k(m.listed)} · asking ${k(m.listingPrice)} · collection floor ${k(m.collectionFloor)} (a floor is not this item's value)`); } catch (e) { line('market [Magic Eden]', `unavailable: ${(e as Error).message}`); } }
  else line('market', 'no market source enabled (NFT_MARKET_MAGICEDEN) — price, offers, sales: unavailable');
  line('value', 'unavailable'); for (const l of externalMarketLinks(a)) line(`outside SP Wallet`, `${l.name}: ${l.url}`);
  try { const e = await p.events(a, null); console.log(`  --- activity (${e.completeness}${e.note ? `, ${e.note}` : ''}) ---`); for (const x of e.events) console.log(`  ${(x.at ?? `block ${x.blockRef.number ?? x.blockRef.slot}`).padEnd(26)} ${x.type.padEnd(12)} ${x.from ?? '?'} → ${x.to ?? '?'}  ×${x.quantity}  ${x.tx.slice(0, 20)}…${x.price ? '' : '  (no price: a transfer is not a sale)'}`); if (!e.events.length) console.log('  no event established'); }
  catch (e) { console.log(`  activity: unavailable (${(e as Error).message})`); }
}
async function showInventory(label: string, chain: string, owner: string): Promise<void> {
  const p = chain === 'solana' ? sol : evm;
  try { const inv = await p.inventory(chain, owner, { manual: [], max: cfg.inventoryMax });
    console.log(`  ${chain.padEnd(10)} ${label}: ${inv.assets.length} NFT(s) — ${inv.sections.map((s) => `${s.section}=${s.status}${s.status === 'ok' ? `(${s.count}${s.truncated ? '+' : ''})` : `[${s.code}${s.unlockedBy ? `; unlocked by ${s.unlockedBy}` : ''}]`}`).join('  ')}`);
    for (const a of inv.assets.slice(0, 12)) console.log(`             ${a.standard.padEnd(24)} ${a.assetId}  ${a.metadata.onchainName ?? ''}  [${a.capabilities.transferBlockedBy.join(',')}]`);
    if (inv.assets.length > 12) console.log(`             … ${inv.assets.length - 12} more`);
  } catch (e) { console.log(`  ${chain.padEnd(10)} ${label}: FAILED ${(e as Error).message}`); }
}

await showAsset(arg('chain') ?? 'solana', arg('asset') ?? 'CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j', arg('token-id'));

console.log(`\n== inventory of the local dev stack's wallet (database ${arg('db') ?? 'spw_dev'})`);
let dev: Record<string, string> | null = null;
try { const postgres = (await import('../services/api/node_modules/postgres/src/index.js')).default as (u: string, o: object) => any; const sqlc = postgres(`postgres:///${arg('db') ?? 'spw_dev'}`, { max: 1, onnotice: () => {} }); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [r] = await sqlc`select value from settings where key = 'signerAddresses'`; dev = (r?.value as { addresses?: Record<string, string> } | undefined)?.addresses ?? null; await sqlc.end(); } catch (e) { console.log(`  dev stack database not readable (${(e as Error).message.slice(0, 80)})`); }
if (!dev) console.log('  no address known for a dev stack (start scripts/dev-stack.sh and open the app once) — skipped');
else { await showInventory(dev.solana!, 'solana', dev.solana!); for (const n of (Object.values(NETWORKS) as NetworkDef[]).filter((x) => x.family === 'evm')) await showInventory(dev[n.id]!, n.id, dev[n.id]!);
  console.log('  bitcoin    not read: Ordinals need an ord-aware indexer (none in this version); ordinary BTC sends are not inscription-aware');
  console.log(`  other networks (${(Object.values(NETWORKS) as NetworkDef[]).filter((x) => !['evm', 'sol'].includes(x.family) && x.id !== 'bitcoin').map((x) => x.id).join(', ')}): no NFT adapter — not read`); }
if (arg('sol')) { console.log('\n== inventory of a public Solana address'); await showInventory(arg('sol')!, 'solana', arg('sol')!); }
if (arg('evm')) { console.log('\n== inventory of a public EVM address'); for (const n of ['ethereum', 'base']) await showInventory(arg('evm')!, n, arg('evm')!); }
process.exit(0);
