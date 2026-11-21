/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/record-nft-prepare-fixtures.mts
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

// Records the fixtures of the SOLANA NFT TRANSFER PREPARATION path (services/api/src/nft/transfer.ts `prepareSol`), from LIVE,
// read-only, keyless calls to the wallet's two public Solana endpoints — so that `pnpm test` exercises that path on real
// account bytes (delivery 2 exercised it on the local-validator proof only).
//
// For each standard (Metaplex Core, programmable NFT, legacy Token Metadata, Token-2022) it takes a REAL mainnet NFT and uses
// its REAL on-chain holder as "the wallet" (the preparation takes the wallet's address as a parameter; no key is involved),
// a freshly generated address as destination, and runs the production code: lookup → re-verification on both endpoints →
// intent → the signer's own builder and verifier → `simulateTransaction` with `sigVerify: false`. A simulation signs nothing,
// sends nothing and moves nothing. Every JSON-RPC call is recorded verbatim; the test replays them, which also proves that
// the message built in the test is byte-for-byte the one mainnet simulated (the replay matches on the exact parameters).
//
//   npx tsx scripts/record-nft-prepare-fixtures.mts          → services/api/test/fixtures/nft/sol-prepare.json
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

Object.assign(process.env, { SPW_ORIGIN: 'http://localhost', SPW_RP_ID: 'localhost', DATABASE_URL: 'postgres:///unused', SPW_SIGNER_SECRET: 'x'.repeat(48), SPW_BROADCAST: 'off', SPW_WORKERS: 'off' });
const { DEFAULT_POLICY, defaultNftPolicy, NETWORKS } = await import('@spw/core');
const { rpcOne } = await import('../services/api/src/chains/rpc.ts');
const { solanaProvider } = await import('../services/api/src/nft/solana.ts');
const { prepareNftTransfer } = await import('../services/api/src/nft/transfer.ts');
const { quorumOver, anyOver } = await import('../services/api/src/nft/index.ts');
// base58 (Bitcoin alphabet), local: the scripts directory has no dependency of its own
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58 = { encode(b: Uint8Array): string { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); let out = ''; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; } for (const x of b) { if (x !== 0) break; out = '1' + out; } return out; } };
import type { NftAsset } from '../packages/nft/src/index.ts';

interface Call { host: string; method: string; params: unknown; result?: unknown; error?: { code?: number; message: string } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** live call with patience for the public endpoints' rate limits; `calls` records the FINAL answer of each call */
function recorder(calls: Call[] | null) {
  return async (url: string, method: string, params: unknown): Promise<unknown> => {
    const host = new URL(url).host;
    for (let k = 0; ; k++) {
      await sleep(400);
      try { const result = await rpcOne<unknown>(url, method, params as unknown[]); calls?.push({ host, method, params, result }); return result; }
      catch (e) { const x = e as Error & { rpcCode?: number };
        if (/429|too many requests/i.test(x.message) && k < 8) { await sleep(4000); continue; }
        calls?.push({ host, method, params, error: { code: x.rpcCode, message: x.message.slice(0, 300) } }); throw e; }
    }
  };
}
const CORE_REF = 'CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j';
/** a public address with many NFTs of every kind (the one behind fixtures/nft/sol-inventory.json) */
const PUBLIC_HOLDER = process.env.NFT_REC_HOLDER ?? '68KUHsNdR8er6DtWkWneEbJWoDme2MWLoHcwLawJ7gt';
const WANT = ['metaplex-core', 'metaplex-pnft', 'metaplex-token-metadata', 'spl-token-2022'] as const;
const freshAddress = (): string => base58.encode(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
const status = (wallet: string) => ({ keyId: 'spw-prepare-fixture', addresses: { solana: wallet }, halted: false, enrollmentOpen: false, credentials: [], policy: DEFAULT_POLICY, spentToday: {}, journalHead: null, journalLength: 0,
  nft: { policy: defaultNftPolicy(), signedToday: 0, allow: [] }, utxoLocks: {} });

const probe = recorder(null), p0 = solanaProvider({ rpc: probe, now: () => new Date(), dasUrl: null });
const candidates: Record<string, { address: string; wallet: string }[]> = { 'metaplex-core': [], 'metaplex-pnft': [], 'metaplex-token-metadata': [], 'spl-token-2022': [] };
const ref = await p0.lookup('solana', { address: CORE_REF }, null);
if (ref.ownership.owner.state === 'known') candidates['metaplex-core']!.push({ address: CORE_REF, wallet: ref.ownership.owner.value });
console.log(`reading the public inventory of ${PUBLIC_HOLDER} …`);
const inv = await p0.inventory('solana', PUBLIC_HOLDER, { manual: [], max: 200 });
console.log(`  sections: ${inv.sections.map((s) => `${s.section}=${s.status}(${s.count}${s.code ? `, ${s.code}` : ''})`).join(' ')}`);
const why = new Map<string, number>(); for (const a of inv.assets) { const k = `${a.standard}:${a.capabilities.transferBlockedBy.join('+') || 'transferable'}`; why.set(k, (why.get(k) ?? 0) + 1); }
console.log(`  ${[...why].map(([k, n]) => `${k} ×${n}`).join(' · ')}`);
for (const a of inv.assets) if (a.capabilities.transferable && candidates[a.standard]) candidates[a.standard]!.push({ address: a.mintAddress ?? a.assetId, wallet: PUBLIC_HOLDER });
for (const extra of (process.env.NFT_REC_EXTRA ?? '').split(',').filter(Boolean)) { try { const a = await p0.lookup('solana', { address: extra }, null); if (a.ownership.owner.state === 'known' && candidates[a.standard]) candidates[a.standard]!.unshift({ address: extra, wallet: a.ownership.owner.value }); } catch { /* not usable */ } }
console.log(Object.entries(candidates).map(([k, v]) => `${k}: ${v.length} candidate(s)`).join(' · '));

const cases: unknown[] = [];
for (const standard of WANT) {
  let done = false;
  for (const c of candidates[standard]!.slice(0, 6)) {
    const calls: Call[] = [], rpc = recorder(calls), now = new Date(), clock = () => now, to = freshAddress(), proposalId = randomUUID();
    try {
      const provider = solanaProvider({ rpc, now: clock, dasUrl: null });
      const a: NftAsset = await provider.lookup('solana', { address: c.address }, c.wallet);
      if (!a.ownership.heldByWallet || a.standard !== standard) { console.log(`  ${standard} ${c.address}: not usable (held=${a.ownership.heldByWallet}, standard=${a.standard})`); continue; }
      const prep = await prepareNftTransfer({ quorum: quorumOver(rpc), any: anyOver(rpc), lookup: (chain, r, w) => provider.lookup(chain, r, w), now: clock }, a, status(c.wallet) as never, c.wallet, to, 1n, proposalId);
      cases.push({ standard, address: c.address, wallet: c.wallet, to, proposalId, now: now.toISOString(), calls,
        observed: { hash: prep.hash, program: prep.intent.program, method: prep.review.method, computeUnits: prep.review.simulation.used, fee: prep.review.fee.max, rent: prep.review.fee.rent, toKind: prep.review.toKind, accounts: prep.review.accounts.length } });
      console.log(`  ${standard.padEnd(26)} ${c.address}  holder ${c.wallet}  → simulated on mainnet: ${prep.review.simulation.used} CU, fee ${prep.review.fee.max} + rent ${prep.review.fee.rent} lamports, ${prep.review.accounts.length} accounts, ${calls.length} calls`);
      done = true; break;
    } catch (e) { console.log(`  ${standard} ${c.address}: ${(e as { code?: string }).code ?? ''} ${(e as Error).message.slice(0, 160)}`); }
  }
  if (!done) console.log(`  ${standard}: NO CASE RECORDED`);
}
const out = new URL('../services/api/test/fixtures/nft/sol-prepare.json', import.meta.url);
// a standard that could not be recorded in this run (the public endpoints rate-limit) keeps its previous recording
try { const { readFileSync } = await import('node:fs'); const prev = (JSON.parse(readFileSync(out, 'utf8')) as { cases: { standard: string }[] }).cases;
  for (const p of prev) if (!cases.some((c) => (c as { standard: string }).standard === p.standard)) { cases.push(p); console.log(`  ${p.standard}: kept from the previous recording`); } } catch { /* no previous file */ }
if (!cases.length) { console.log('nothing recorded: the fixture is left as it is'); process.exit(1); }
writeFileSync(out, `${JSON.stringify({ recordedAt: new Date().toISOString(), provenance: 'LIVE-RECORDED keyless on Solana mainnet (api.mainnet-beta.solana.com, solana-rpc.publicnode.com): the JSON-RPC calls of a transfer PREPARATION — lookup, re-verification, simulateTransaction with sigVerify:false. The "wallet" of each case is the real on-chain holder; nothing was signed or sent.',
  genesis: NETWORKS.solana.chainRef, cases })}\n`);
console.log(`${cases.length} case(s) written to services/api/test/fixtures/nft/sol-prepare.json`);
process.exit(0);
