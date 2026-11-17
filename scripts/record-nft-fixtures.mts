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

const all = { ...sol, ...evm }, want = process.argv.slice(2);
for (const [name, run] of Object.entries(all)) { if (want.length && !want.includes(name)) continue; try { await run(); } catch (e) { console.log(`${name}: FAILED ${(e as Error).message}`); } }
