/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/record-nft-fixtures.mts
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

// Records the NFT test fixtures from LIVE, read-only, keyless calls (JSON-RPC reads of the wallet's public endpoints and plain
// GETs). Each fixture is the list of calls one scenario made — { host, method, params, result | error } verbatim — with the
// time and the endpoints; the tests replay them (services/api/test/nft-helpers.ts) so the adapters run on real answers.
// Nothing is signed, built or sent; the addresses are public ones (a marketplace's listings, well-known contracts) — never the wallet's.
// Run: npx tsx scripts/record-nft-fixtures.mts [scenario …]      (then: pnpm vitest run services/api/test/nft-*.test.ts packages/nft)
import { mkdirSync, writeFileSync } from 'node:fs';
import { NETWORKS } from '@spw/core';

Object.assign(process.env, { SPW_ORIGIN: 'http://localhost', SPW_RP_ID: 'localhost', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'x'.repeat(48) });
const { rpcOne } = await import('../services/api/src/chains/rpc.ts');
const { solanaProvider } = await import('../services/api/src/nft/solana.ts');
const { evmProvider } = await import('../services/api/src/nft/evm.ts');

const dir = new URL('../services/api/test/fixtures/nft/', import.meta.url);
mkdirSync(dir, { recursive: true });
interface Call { host: string; method: string; params: unknown; result?: unknown; error?: { code?: number; message: string } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function recorder() {
  const calls: Call[] = [];
  const rpc = async (url: string, method: string, params: unknown): Promise<unknown> => {
    const host = new URL(url).host;
    await sleep(350); // public endpoints: stay far under their limits
    try { const result = await rpcOne<unknown>(url, method, params as unknown[]);
      // contract bytecode is only tested for emptiness: its first 32 bytes are kept (the one place a recorded answer is shortened)
      calls.push({ host, method, params, result: method === 'eth_getCode' && typeof result === 'string' && result.length > 66 ? result.slice(0, 66) : result }); return result; }
    catch (e) { const x = e as Error & { rpcCode?: number }; calls.push({ host, method, params, error: { code: x.rpcCode, message: x.message.slice(0, 300) } }); throw e; }
  };
  return { calls, rpc };
}
const save = (name: string, note: string, calls: Call[], extra: Record<string, unknown> = {}) => {
  writeFileSync(new URL(`${name}.json`, dir), `${JSON.stringify({ recordedAt: new Date().toISOString(), note, ...extra, calls })}\n`);
  console.log(`${name.padEnd(34)} ${calls.length} calls  ${(JSON.stringify(calls).length / 1024).toFixed(0)} kB`);
};
const now = () => new Date();
const W_NONE = null;

// ── Solana ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const REF = 'CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j';
const sol: Record<string, () => Promise<void>> = {
  // the brief's reference item: a Metaplex Core asset
  'sol-core-reference': async () => { const r = recorder(), p = solanaProvider({ rpc: r.rpc, now, dasUrl: null });
    const a = await p.lookup('solana', { address: REF }, W_NONE); await p.collection('solana', a.collection!.id); await p.events(a, null);
    save('sol-core-reference', `Metaplex Core asset ${REF} (reference item of docs/nft/NFT-BRIEF.md): lookup, its collection, first page of events`, r.calls); },
  // legacy Metaplex NFT listed on a marketplace: held by an escrow owner, token account frozen
  'sol-legacy-escrow': async () => { const r = recorder(), p = solanaProvider({ rpc: r.rpc, now, dasUrl: null });
    const a = await p.lookup('solana', { address: process.env.NFT_REC_LEGACY ?? 'J2U6QmgcuFAEdgF8XaK9t1PKidJ7QVYeSCdmYGybUzYo' }, W_NONE); await p.events(a, null).catch(() => {});
    save('sol-legacy-escrow', 'legacy Metaplex Token Metadata NFT (a Thugbirdz item listed on Magic Eden at recording time: the unit sits in a token account owned by the marketplace escrow)', r.calls); },
  // programmable NFT
  'sol-pnft': async () => { const r = recorder(), p = solanaProvider({ rpc: r.rpc, now, dasUrl: null });
    await p.lookup('solana', { address: process.env.NFT_REC_PNFT ?? '5FHwu2v4e3M9yUpB2VcJtdDGAngEkWJnoH4VbU4Amm2t' }, W_NONE);
    save('sol-pnft', 'programmable NFT (a Froganas item at recording time): programmable config with a rule set, token record with a delegate, frozen token account', r.calls); },
  // Token-2022 NFT
  'sol-token2022': async () => { const r = recorder(), p = solanaProvider({ rpc: r.rpc, now, dasUrl: null });
    await p.lookup('solana', { address: process.env.NFT_REC_T22 ?? '1RwLsj9guunjNRQV8fDq1a8S3keE2XgMFmHRUaS2mHM' }, W_NONE);
    save('sol-token2022', 'Token-2022 NFT (mint owned by the Token-2022 program, metadata + metadataPointer + groupMemberPointer extensions; found in a marketplace escrow at recording time)', r.calls); },
  // compressed NFT: no account on-chain; known through DAS only
  'sol-compressed': async () => { const r = recorder(), p = solanaProvider({ rpc: r.rpc, now, dasUrl: null });
    await p.lookup('solana', { address: process.env.NFT_REC_CNFT ?? '12XAbDPsEUwVbsN3BZwgdc1uqkTanp7Tds9mEtNEuTH' }, W_NONE);
    save('sol-compressed', 'compressed NFT id (no account on-chain): answered by DAS getAsset on the endpoint that serves it', r.calls); },
  // a burned compressed NFT: the indexer reports `burnt`
  'sol-burned': async () => { const r = recorder(), p = solanaProvider({ rpc: r.rpc, now, dasUrl: null });
    const a = await p.lookup('solana', { address: process.env.NFT_REC_BURNT ?? '1AvLxeY76HV3P2Fm8XeZGAkgdBkq4C2TGgQUFnjomBj' }, W_NONE); console.log(`  ${a.standard} ${a.ownership.state} qty=${a.quantity}`);
    save('sol-burned', 'a burned compressed NFT (DAS reports burnt: true; no account on-chain)', r.calls); },
  // a wallet's whole inventory (public address given on the command line: NFT_REC_OWNER)
  'sol-inventory': async () => { const r = recorder(), p = solanaProvider({ rpc: r.rpc, now, dasUrl: null }), owner = process.env.NFT_REC_OWNER;
    if (!owner) { console.log('sol-inventory: set NFT_REC_OWNER to a public Solana address'); return; }
    const inv = await p.inventory('solana', owner, { manual: [], max: 40 }); console.log(inv.sections, inv.assets.map((a) => `${a.standard} ${a.assetId}`));
    save('sol-inventory', `inventory of the public address ${owner}`, r.calls, { owner }); },
  // things that are not NFTs / do not exist
  'sol-negative': async () => { const r = recorder(), p = solanaProvider({ rpc: r.rpc, now, dasUrl: null });
    for (const address of ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS', 'phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC', '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T'])
      await p.lookup('solana', { address }, W_NONE).then((a) => console.log('unexpected asset', a.key), (e: Error) => console.log(`  ${address} → ${e.message}`));
    save('sol-negative', 'not NFTs: USDC mint (fungible), a wallet address, a Core collection, an address with no account', r.calls); },
};

// ── EVM ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const evm: Record<string, () => Promise<void>> = {
  'evm-lookups': async () => { const r = recorder(), p = evmProvider({ rpc: r.rpc, now, indexers: {}, http: fetch });
    const cases: [string, string, string, string | null][] = [
      ['ethereum', '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', '1', null],        // ERC-721 with ipfs metadata (BAYC #1)
      ['ethereum', '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85', '79233663829379634837589865448569342784712482819484549289560981379859480642508', null], // ERC-721 WITHOUT the metadata extension (ENS base registrar: vitalik.eth)
      ['ethereum', '0x06012c8cf97BEaD5deAe237070F9587f8E7A266d', '1', null],        // pre-standard contract (CryptoKitties): ownerOf answers, ERC-165 does not declare ERC-721
      ['ethereum', '0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB', '1', null],        // non-standard (CryptoPunks): no ownerOf
      ['ethereum', '0xdAC17F958D2ee523a2206206994597C13D831ec7', '1', null],        // an ERC-20 (USDT): not an NFT contract
      ['ethereum', '0x495f947276749Ce646f68AC8c248420045cb7b5e', '81678603736433480652309471562595884520144065466341654349472628651124869562369', '0x62e3a8216Abdbd2e4a84Be700905F4BA02FD8A4E'], // ERC-1155, quantity 1 (OpenSea Shared Storefront; holder taken from a TransferSingle log of the day)
      ['ethereum', '0x0905b2277df5c7dd6c5e3399ece8a36621aebe85', '5', '0xf17017dD78887f7A6d03a81E36FfBdF67eac2B8a'], // ERC-1155, quantity > 1 (holder taken from a TransferSingle log of the day)
      ['ethereum', '0x0905b2277df5c7dd6c5e3399ece8a36621aebe85', '5', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'], // the same ERC-1155 id for an address that holds none
    ];
    for (const [chain, address, tokenId, wallet] of cases) await p.lookup(chain, { address, tokenId }, wallet).then((a) => console.log(`  ${a.standard} ${a.key.slice(0, 70)} owner=${JSON.stringify(a.ownership.owner)} qty=${a.quantity} uri=${a.metadata.sourceUri?.slice(0, 60)}`), (e: Error) => console.log(`  ${address} → ${e.message}`));
    save('evm-lookups', 'Ethereum mainnet reads: ERC-721 (BAYC #1), ERC-721 without metadata (ENS), pre-standard (CryptoKitties), non-standard (CryptoPunks), ERC-20 (USDT), ERC-1155', r.calls, { endpoints: NETWORKS.ethereum!.rpc }); },
};

// EVM transfer logs of one token in the window the public endpoints accept (may legitimately be empty)
evm['evm-events'] = async () => { const r = recorder(), p = evmProvider({ rpc: r.rpc, now, indexers: {}, http: fetch });
  const wallet = process.env.NFT_REC_EV_WALLET ?? '0x62e3a8216Abdbd2e4a84Be700905F4BA02FD8A4E';
  const a = await p.lookup('ethereum', { address: process.env.NFT_REC_EV_CONTRACT ?? '0x495f947276749Ce646f68AC8c248420045cb7b5e', tokenId: process.env.NFT_REC_EV_ID ?? '81678603736433480652309471562595884520144065466341654349472628651124869562369' }, wallet);
  const e = await p.events(a, null); console.log(`  ${e.completeness} ${e.note} events=${e.events.length}`, e.events.map((x) => `${x.type} ×${x.quantity}`));
  save('evm-events', 'ERC-1155 token and its TransferSingle / TransferBatch logs in the most recent blocks the public Ethereum endpoints accept', r.calls, { wallet }); };

// ── market (Magic Eden public API, keyless GETs) ────────────────────────────────────────────────────────────────────────
const market: Record<string, () => Promise<void>> = {
  'market-magiceden': async () => {
    const calls: { url: string; status: number; body: unknown }[] = [];
    const get = async (path: string) => { await sleep(700); const url = `https://api-mainnet.magiceden.dev/v2${path}`, r = await fetch(url, { headers: { accept: 'application/json' } }); const t = await r.text(); let body: unknown = t.slice(0, 500); try { body = JSON.parse(t); } catch { /* text */ } calls.push({ url, status: r.status, body }); return body as any; }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const listed = process.env.NFT_REC_LEGACY ?? 'J2U6QmgcuFAEdgF8XaK9t1PKidJ7QVYeSCdmYGybUzYo';
    for (const mint of [REF, listed]) { const t = await get(`/tokens/${mint}`); if (t?.listStatus === 'listed') await get(`/tokens/${mint}/listings`); if (t?.collection) await get(`/collections/${t.collection}/stats`); }
    await get('/tokens/4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T'); // not a token
    writeFileSync(new URL('market-magiceden.json', dir), `${JSON.stringify({ recordedAt: new Date().toISOString(), note: 'Magic Eden public API answers for the reference Core asset (unlisted) and a listed legacy NFT: token, listings, collection stats', calls })}\n`);
    console.log(`market-magiceden                   ${calls.length} calls`);
  },
};
// ── creator metadata of the reference item, fetched through the wallet's own SSRF-safe fetcher (pinned connection) ───────────
const meta: Record<string, () => Promise<void>> = {
  'sol-core-reference-metadata': async () => {
    const { safeFetch } = await import('../services/api/src/nft/safe-fetch.ts');
    const url = `https://metadata.phygitals.com/${REF}`, r = await safeFetch(url, { maxBytes: 256 * 1024, timeoutMs: 15_000, accept: 'application/json' });
    if (!r.ok) throw new Error(`metadata fetch refused: ${r.code}`);
    const doc = JSON.parse(new TextDecoder().decode(r.bytes)) as { image?: string };
    const img = doc.image ? await safeFetch(doc.image, { maxBytes: 25 * 1024 * 1024, timeoutMs: 30_000, accept: 'image/*' }) : null;
    writeFileSync(new URL('sol-core-reference-metadata.json', dir), `${JSON.stringify({ recordedAt: new Date().toISOString(), note: 'the metadata document the reference Core asset points to, as served that day (verbatim text), and what its image URL answered (type, size, first bytes — the image itself is not stored)',
      url, finalUrl: r.finalUrl, contentType: r.contentType, text: new TextDecoder().decode(r.bytes),
      image: img && img.ok ? { url: doc.image, finalUrl: img.finalUrl, hops: img.hops, contentType: img.contentType, bytes: img.bytes.length, head: Buffer.from(img.bytes.slice(0, 16)).toString('hex') } : { url: doc.image ?? null, error: img && !img.ok ? img.code : 'no image' } })}\n`);
    console.log(`sol-core-reference-metadata        ${r.bytes.length} bytes; image: ${img && img.ok ? `${img.contentType} ${img.bytes.length} bytes, ${img.hops} redirect(s)` : img && !img.ok ? img.code : 'none'}`);
  },
};
const all = { ...sol, ...evm, ...market, ...meta }, want = process.argv.slice(2);
for (const [name, run] of Object.entries(all)) { if (want.length && !want.includes(name)) continue; try { await run(); } catch (e) { console.log(`${name}: FAILED ${(e as Error).message}`); } }
