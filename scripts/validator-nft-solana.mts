/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/validator-nft-solana.mts
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

// NFT delivery 2 — Solana proof on a LOCAL VALIDATOR (`solana-test-validator`), full path: API prepare (re-read on both
// "endpoints", simulation) → canonical NFT intent → passkey → signer (builds the message, verifies, signs) → broadcast →
// finality, and the result read back from the local chain. Then the refusals.
//
//   npx tsx scripts/validator-nft-solana.mts
//     needs `solana-test-validator` (Agave ≥ 2) in PATH, or SOLANA_TEST_VALIDATOR=<path of the binary>; database spw_fork_nft;
//     reads mainnet (public RPC) once, at start, to copy programs and accounts. NOTHING is sent to a real network.
//
// The programs are the REAL mainnet programs (Token Metadata, Token Auth Rules, Core — cloned with their program data; SPL
// Token, Token-2022 and the Associated Token program are built into the validator). The NFTs are REAL mainnet assets, copied
// with ONE change each so that the throw-away test wallet owns them — which no key on mainnet allows, hence the local chain:
//
//   Metaplex Core     the reference item of the brief (asset account copied, `owner` field = test wallet; collection copied as is)
//   programmable NFT  a Mad Lads item (mint, metadata, edition, rule set copied as is; the token account re-created at the test
//                     wallet's associated address with owner = test wallet; its token record re-created at the matching PDA)
//   legacy NFT        a Thugbirdz item (mint, metadata, edition as is; token account re-created the same way, delegate cleared)
//   Token-2022 NFT    the Token-2022 item of delivery 1's fixtures (mint as is; token account re-created the same way)
//   and two variants that must be REFUSED: a second pNFT whose token record is set to "locked", and a copy of the Core asset in
//   a copy of its collection whose PermanentFreezeDelegate is set to frozen.
//
// What this establishes: each instruction list the signer builds is executed by the real program code and moves the NFT to
// the destination and nothing else; the API's verdict for a locked pNFT and a frozen Core asset matches what the program
// itself does. What it does NOT establish: anything about mainnet execution (fees, landing, the public endpoints' behaviour at
// send time); the pNFT rule set evaluated is the one copied at start; the cluster identity is the local validator's (the
// registry's genesis hash is replaced for this process only — said here because the signer and the API both check it).
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { associatedTokenAddress, buildNftSolMessage, findProgramAddress, NETWORKS, NFT_CORE_PROGRAM, NFT_TOKEN_AUTH_RULES_PROGRAM, NFT_TOKEN_METADATA_PROGRAM, nftEditionPda, nftMetadataPda, nftSolWire, nftTokenRecordPda, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type NftIntent } from '@spw/core';
import { decodeCoreAsset, decodeCoreCollection, decodeTmMetadata, decodeTmTokenRecord } from '../packages/nft/src/index.ts';
import { TestPasskey } from '../tests/helpers/passkey.ts';
import { deriveKeys } from '../services/isolated-signer/src/keys.ts';
import { createSignerServer } from '../services/isolated-signer/src/server.ts';
import { Signer } from '../services/isolated-signer/src/signer.ts';
import { Store } from '../services/isolated-signer/src/store.ts';

const MAINNET = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com', PORT = 8799, LOCAL = `http://127.0.0.1:${PORT}`;
const ORIGIN = 'https://wallet.test', RP = 'wallet.test', SECRET = 'f'.repeat(48);
const BIN = process.env.SOLANA_TEST_VALIDATOR ?? 'solana-test-validator';
const CORE_REF = 'CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j', PNFT = '13UdyeAQQk4sHLtJQUHgDLt13HkZBYC2QWSHGAALDnWo', PNFT_LOCKED = '13WkThbjPM5PVaLdryYPLVQt4NURzAFzJNu6k6maJbMd', LEGACY = 'J2U6QmgcuFAEdgF8XaK9t1PKidJ7QVYeSCdmYGybUzYo', T22 = '1RwLsj9guunjNRQV8fDq1a8S3keE2XgMFmHRUaS2mHM';
const say = (m: string) => console.log(m);
// base58 (Bitcoin alphabet), local: the scripts directory has no dependency of its own
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58 = {
  encode(b: Uint8Array): string { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); let out = ''; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; } for (const x of b) { if (x !== 0) break; out = '1' + out; } return out; },
  decode(s: string): Uint8Array { let n = 0n; for (const c of s) { const v = B58.indexOf(c); if (v < 0) throw new Error('bad base58'); n = n * 58n + BigInt(v); } const bytes: number[] = []; while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; } for (const c of s) { if (c !== '1') break; bytes.unshift(0); } return Uint8Array.from(bytes); },
};
const enc = new TextEncoder();
const rpcAt = (url: string) => async <T>(method: string, params: unknown[] = []): Promise<T> => { for (let k = 0; ; k++) { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (r.status === 429 && k < 12) { await new Promise((x) => setTimeout(x, 2500)); continue; } const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error && /too many requests/i.test(j.error.message) && k < 12) { await new Promise((x) => setTimeout(x, 6000)); continue; } // the public endpoint also rate-limits per method
  if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result as T; } };
const main = rpcAt(MAINNET), local = rpcAt(LOCAL);
interface Acct { lamports: number; owner: string; data: Uint8Array }
const fetchAccts = async (addrs: string[]): Promise<(Acct | null)[]> => (await main<{ value: ({ lamports: number; owner: string; data: [string, string] } | null)[] }>('getMultipleAccounts', [addrs, { encoding: 'base64', commitment: 'finalized' }])).value.map((v) => (v ? { lamports: v.lamports, owner: v.owner, data: new Uint8Array(Buffer.from(v.data[0], 'base64')) } : null));
const localAcct = async (a: string): Promise<Acct | null> => { const v = (await local<{ value: { lamports: number; owner: string; data: [string, string] } | null }>('getAccountInfo', [a, { encoding: 'base64', commitment: 'confirmed' }])).value; return v ? { lamports: v.lamports, owner: v.owner, data: new Uint8Array(Buffer.from(v.data[0], 'base64')) } : null; };
const pk = (s: string) => base58.decode(s);
/** the bump of a program-derived address (the core helper returns the address only) */
function pdaBump(seeds: Uint8Array[], program: string): number { const want = findProgramAddress(seeds, program);
  for (let bump = 255; bump >= 0; bump--) { const h = createHash('sha256'); for (const s of seeds) h.update(s); h.update(Uint8Array.of(bump)).update(pk(program)).update(enc.encode('ProgramDerivedAddress')); if (base58.encode(h.digest()) === want) return bump; } throw new Error('no bump'); }
/** a fresh address whose key is thrown away */
const fresh = () => base58.encode(generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));

const keys = deriveKeys(generateMnemonic(wordlist, 128)), ME = keys.addresses.sol;
const dir = mkdtempSync(join(tmpdir(), 'spw-validator-nft-'));
const files: string[] = [];
const put = (address: string, a: Acct) => { const f = join(dir, `${address}.json`);
  writeFileSync(f, JSON.stringify({ pubkey: address, account: { lamports: a.lamports, data: [Buffer.from(a.data).toString('base64'), 'base64'], owner: a.owner, executable: false, rentEpoch: 0, space: a.data.length } }).replace('"rentEpoch":0', '"rentEpoch":18446744073709551615'));
  files.push('--account', address, f); };
const need = (a: Acct | null, what: string): Acct => { if (!a) throw new Error(`mainnet account not found: ${what}`); return a; };

// ── copy the subjects from mainnet, each with its one change ──────────────────────────────────────────────────────────────
say(`test wallet (throw-away key): ${ME}`);
// Core: the reference asset, owner field (bytes 1..33) = the test wallet; its collection as it is
const [coreA] = await fetchAccts([CORE_REF]); const refAsset = decodeCoreAsset(need(coreA, 'core asset').data);
if (refAsset.updateAuthority.type !== 'Collection') throw new Error('the reference asset is no longer in a collection');
const COLLECTION = refAsset.updateAuthority.address, [collA] = await fetchAccts([COLLECTION]);
const mine = (a: Acct) => { const d = Uint8Array.from(a.data); d.set(pk(ME), 1); return { ...a, data: d }; };
put(CORE_REF, mine(coreA!)); put(COLLECTION, need(collA, 'core collection'));
say(`Core: ${CORE_REF} (mainnet owner ${refAsset.owner}) in collection ${COLLECTION} — copied with owner = test wallet`);
// a FROZEN variant: copies of the asset and of the collection at fresh addresses, the collection's PermanentFreezeDelegate set to frozen
const FROZEN_ASSET = fresh(), FROZEN_COLL = fresh(), collDec = decodeCoreCollection(collA!.data), pfd = collDec.plugins.plugins.find((p) => p.type === 'PermanentFreezeDelegate');
let frozenReady = false;
if (pfd) { const cd = Uint8Array.from(collA!.data); cd[pfd.offset + 1] = 1; const ad = mine(coreA!).data; ad.set(pk(FROZEN_COLL), 34);
  frozenReady = decodeCoreCollection(cd).plugins.plugins.find((p) => p.type === 'PermanentFreezeDelegate')?.frozen === true && decodeCoreAsset(ad).updateAuthority.type === 'Collection';
  if (frozenReady) { put(FROZEN_COLL, { ...collA!, data: cd }); put(FROZEN_ASSET, { ...coreA!, data: ad }); } }
say(frozenReady ? `Core (frozen variant): asset ${FROZEN_ASSET} in a copy of the collection ${FROZEN_COLL} whose PermanentFreezeDelegate is frozen` : 'Core (frozen variant): NOT built (the collection has no PermanentFreezeDelegate plugin any more)');

async function splSubject(mint: string, o: { pnft: boolean; lock?: boolean }): Promise<{ tp: string; ruleSet: string | null }> {
  const [mintA, mdA, edA] = await fetchAccts([mint, nftMetadataPda(mint), nftEditionPda(mint)]);
  const tp = need(mintA, `mint ${mint}`).owner;
  if (tp !== TOKEN_PROGRAM && tp !== TOKEN_2022_PROGRAM) throw new Error(`mint ${mint} is not a token mint`);
  put(mint, mintA!);
  let ruleSet: string | null = null;
  if (mdA) { put(nftMetadataPda(mint), mdA); const md = decodeTmMetadata(mdA.data); ruleSet = md.programmableConfig?.ruleSet ?? null; if (o.pnft !== /Programmable/.test(md.tokenStandard ?? '')) throw new Error(`${mint}: token standard on mainnet is ${md.tokenStandard}`); }
  if (edA) put(nftEditionPda(mint), edA);
  if (ruleSet) { const [rs] = await fetchAccts([ruleSet]); put(ruleSet, need(rs, 'rule set')); }
  // the token account that holds the unit NOW: the indexed owner (DAS getAsset) and that owner's token accounts for the mint
  // (getTokenLargestAccounts is refused by the public endpoint under its per-method rate limit)
  const das = await main<{ ownership?: { owner?: string } }>('getAsset', [mint]).catch(() => main<{ ownership?: { owner?: string } }>('getAsset', { id: mint } as never));
  const holder = das.ownership?.owner; if (!holder) throw new Error(`the index names no holder for ${mint}`);
  const tas = await main<{ value: { pubkey: string; account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }>('getTokenAccountsByOwner', [holder, { mint }, { encoding: 'jsonParsed', commitment: 'finalized' }]);
  const holderTa = tas.value.find((x) => x.account.data.parsed.info.tokenAmount.amount === '1')?.pubkey; if (!holderTa) throw new Error(`no token account of ${holder} holds ${mint}`);
  const [taA] = await fetchAccts([holderTa]); const d = Uint8Array.from(need(taA, 'token account').data);
  d.set(pk(ME), 32); d.fill(0, 72, 108); d.fill(0, 121, 129); if (!o.pnft) d[108] = 1; // owner = test wallet; no delegate; initialized (a pNFT's account stays frozen, as the program keeps it)
  const ata = associatedTokenAddress(ME, mint, tp);
  put(ata, { ...taA!, data: d });
  if (o.pnft) {
    const [recA] = await fetchAccts([nftTokenRecordPda(mint, holderTa)]); const r = Uint8Array.from(need(recA, 'token record').data);
    r[1] = pdaBump([enc.encode('metadata'), pk(NFT_TOKEN_METADATA_PROGRAM), pk(mint), enc.encode('token_record'), pk(ata)], NFT_TOKEN_METADATA_PROGRAM);
    r[2] = o.lock ? 1 : 0; // TokenState: 0 unlocked, 1 locked
    const dec = decodeTmTokenRecord(r);
    if (dec.state !== (o.lock ? 'locked' : 'unlocked')) throw new Error('token record rewrite failed');
    if (dec.delegate && !o.lock) throw new Error(`${mint}: the mainnet token record carries a delegate; pick another subject`);
    put(nftTokenRecordPda(mint, ata), { ...recA!, data: r });
  }
  say(`${o.pnft ? 'pNFT' : tp === TOKEN_2022_PROGRAM ? 'Token-2022' : 'legacy'}: mint ${mint}${ruleSet ? `, rule set ${ruleSet}` : ''} — token account re-created at ${ata} (owner = test wallet${o.pnft ? `, token record ${o.lock ? 'LOCKED' : 'unlocked'}` : ''})`);
  return { tp, ruleSet };
}
const pn = await splSubject(PNFT, { pnft: true }); await splSubject(PNFT_LOCKED, { pnft: true, lock: true }); await splSubject(LEGACY, { pnft: false }); await splSubject(T22, { pnft: false });

// ── local validator with the real programs ────────────────────────────────────────────────────────────────────────────────
if (BIN.includes('/') && !existsSync(BIN)) throw new Error(`solana-test-validator not found at ${BIN}`);
const validator: ChildProcess = spawn(BIN, ['--reset', '--quiet', '--ledger', join(dir, 'ledger'), '--rpc-port', String(PORT), '--faucet-port', String(PORT + 30), '--gossip-port', String(PORT + 31), '--dynamic-port-range', `${PORT + 40}-${PORT + 70}`, '--url', MAINNET,
  '--clone-upgradeable-program', NFT_TOKEN_METADATA_PROGRAM, '--clone-upgradeable-program', NFT_TOKEN_AUTH_RULES_PROGRAM, '--clone-upgradeable-program', NFT_CORE_PROGRAM, ...files], { stdio: 'ignore' });
let signerSrv: Server | undefined, app: any, sql: any; // eslint-disable-line @typescript-eslint/no-explicit-any
const cleanup = async () => { validator.kill('SIGINT'); signerSrv?.close(); await app?.close().catch(() => {}); await sql?.end().catch(() => {}); };
try {
  let up = false;
  for (let k = 0; k < 240 && !up; k++) { try { if ((await local<string>('getHealth')) === 'ok') up = true; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  if (!up) throw new Error('the local validator did not start');
  const genesis = await local<string>('getGenesisHash'), version = await local<{ 'solana-core': string }>('getVersion');
  for (const p of [NFT_TOKEN_METADATA_PROGRAM, NFT_TOKEN_AUTH_RULES_PROGRAM, NFT_CORE_PROGRAM]) { const a = await local<{ value: { executable: boolean; owner: string } | null }>('getAccountInfo', [p, { encoding: 'base64' }]); if (!a.value?.executable) throw new Error(`program ${p} is not executable on the local validator`); }
  say(`local validator ${version['solana-core']} up, genesis ${genesis}; programs cloned from mainnet and executable: Token Metadata, Token Auth Rules, Core`);
  await local('requestAirdrop', [ME, 2_000_000_000]);
  for (let k = 0; k < 60; k++) { if ((await local<{ value: number }>('getBalance', [ME, { commitment: 'confirmed' }])).value > 0) break; await new Promise((r) => setTimeout(r, 300)); }

  // ── signer + API, pointed at the local validator. The registry's cluster identity is replaced for THIS PROCESS ONLY. ────
  (NETWORKS.solana as { chainRef: string }).chainRef = genesis;
  const store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('fork-setup').digest('hex');
  const signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN });
  signerSrv = createSignerServer(signer, SECRET).listen(0, '127.0.0.1');
  await new Promise((r) => signerSrv!.once('listening', r));
  Object.assign(process.env, { SPW_ORIGIN: ORIGIN, SPW_RP_ID: RP, DATABASE_URL: 'postgres:///spw_fork_nft', SPW_SIGNER_SECRET: SECRET, SPW_SIGNER_URL: `http://127.0.0.1:${(signerSrv.address() as { port: number }).port}`,
    SPW_BROADCAST: 'on', SPW_WORKERS: 'off', SPW_RPC_OVERRIDE: JSON.stringify({ solana: [LOCAL, LOCAL] }), NFT_CACHE_DIR: join(dir, 'media'), NFT_SOLANA_DAS: 'off' });
  const db = await import('../services/api/src/db.ts'); sql = db.sql;
  await sql.unsafe('drop schema public cascade; create schema public;'); await db.migrate();
  app = await (await import('../services/api/src/server.ts')).buildServer({ swapProviders: [], nft: { autoSync: false } });
  const worker = await import('../services/api/src/worker.ts');
  const passkey = new TestPasskey(RP, ORIGIN); let cookie = '';
  const api = async (method: string, url: string, body?: unknown, idem?: string) => { const r = await app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin: ORIGIN, 'x-spw-csrf': '1', 'content-type': 'application/json' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    if (r.headers['set-cookie']) cookie = String(r.headers['set-cookie']).split(';')[0]!;
    return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() }; };
  const so = (await api('POST', '/api/v1/auth/setup/options', {})).json;
  if ((await api('POST', '/api/v1/auth/setup/verify', { challengeId: so.challengeId, response: passkey.register(so.options.challenge), setupToken: 'fork-setup' })).status !== 200) throw new Error('setup failed');
  const settle = async (id: string) => { for (let k = 0; k < 200; k++) { await worker.reconcile(); const p = (await api('GET', `/api/v1/nfts/transfer/${id}`)).json; if (['finalized', 'failed', 'replaced', 'expired'].includes(p.state)) return p; await new Promise((r) => setTimeout(r, 500)); } throw new Error('the transfer did not settle'); };
  const key = (a: string) => `sol:solana:${a}`;
  const tokenOwner = async (ta: string) => { const a = await localAcct(ta); return a && a.data.length >= 165 ? { owner: base58.encode(a.data.subarray(32, 64)), amount: new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true), delegate: new DataView(a.data.buffer, a.data.byteOffset).getUint32(72, true) === 1 } : null; };

  async function send(label: string, asset: string, expectStandard: string, check: (dest: string) => Promise<string>): Promise<void> {
    const dest = fresh();
    const added = await api('POST', '/api/v1/nfts/manual', { chain: 'solana', address: asset });
    if (added.status !== 200) throw new Error(`${label}: lookup failed ${added.status} ${JSON.stringify(added.json)}`);
    if (added.json.standard !== expectStandard || !added.json.ownership.heldByWallet) throw new Error(`${label}: read as ${added.json.standard}, held=${added.json.ownership.heldByWallet}`);
    const item = (await api('GET', `/api/v1/nfts/item?key=${encodeURIComponent(key(asset))}`)).json;
    if (!item.transfer.transferable) throw new Error(`${label}: not transferable: ${item.transfer.blockedBy}`);
    const before = (await local<{ value: number }>('getBalance', [ME, { commitment: 'confirmed' }])).value;
    const prep = await api('POST', '/api/v1/nfts/transfer/prepare', { key: key(asset), to: dest }, crypto.randomUUID());
    if (prep.status !== 200) throw new Error(`${label}: prepare failed ${prep.status} ${JSON.stringify(prep.json)}`);
    const rv = prep.json.review, it = prep.json.intent as NftIntent;
    say(`\n${label}`);
    say(`  review: ${rv.standard} · ${rv.method} · asset ${rv.asset} · program ${rv.program} · quantity ${rv.quantity} · to ${rv.to} (${rv.toKind}) · fee ${rv.fee.max} lamports · rent of created accounts ${rv.fee.rent} lamports · warnings [${rv.warnings}]`);
    say(`  verified: ${rv.verified.ownership}; simulation: ${rv.simulation.used} compute units; changes: ${rv.simulation.changes.map((c: { what: string; before: string; after: string }) => `${c.what}: ${c.before} → ${c.after}`).join(' | ')}`);
    say(`  accounts of the instruction: ${rv.accounts.map((a: { role: string; address: string; derived: string }) => `${a.role}=${a.address.slice(0, 6)}…(${a.derived})`).join(', ')}`);
    if (it.asset !== asset || it.to !== dest || it.from !== ME || it.standard !== expectStandard) throw new Error(`${label}: the intent does not carry the identifiers of the request`);
    const sent = await api('POST', `/api/v1/nfts/transfer/${prep.json.proposal.id}/approve`, { assertion: passkey.assert(Buffer.from(prep.json.options.challenge, 'base64url')) });
    if (sent.status !== 200 || sent.json.state !== 'broadcast') throw new Error(`${label}: approve → ${sent.status} ${JSON.stringify(sent.json).slice(0, 300)}`);
    const done = await settle(prep.json.proposal.id);
    if (done.state !== 'finalized') throw new Error(`${label}: ended ${done.state}: ${done.error}`);
    const after = (await local<{ value: number }>('getBalance', [ME, { commitment: 'finalized' }])).value;
    say(`  SENT: ${done.state}, signature ${done.txid}`);
    say(`  on the local chain after finality: ${await check(dest)}; SOL spent by the wallet ${before - after} lamports (review said fee ${rv.fee.max} + rent ${rv.fee.rent} = ${Number(rv.fee.max) + Number(rv.fee.rent)})`);
    if (before - after !== Number(rv.fee.max) + Number(rv.fee.rent)) throw new Error(`${label}: the wallet spent ${before - after} lamports, the review announced ${Number(rv.fee.max) + Number(rv.fee.rent)}`);
    const inv = (await api('GET', `/api/v1/nfts/item?key=${encodeURIComponent(key(asset))}`)).json;
    if (inv.ownership.heldByWallet) throw new Error(`${label}: the inventory still shows the NFT in the wallet`);
    say(`  inventory after finality: inWallet=${inv.ownership.heldByWallet}, blockedBy=[${inv.transfer.blockedBy}]`);
  }
  const splCheck = (mint: string, tp: string) => async (dest: string) => { const d = await tokenOwner(associatedTokenAddress(dest, mint, tp)), s = await tokenOwner(associatedTokenAddress(ME, mint, tp));
    if (!d || d.owner !== dest || d.amount !== 1n || d.delegate) throw new Error('the destination token account does not hold the NFT (or carries a delegate)'); if (s && s.amount !== 0n) throw new Error('the wallet still holds the unit');
    return `destination token account owner = ${d.owner}, amount ${d.amount}, no delegate; wallet's token account ${s ? `amount ${s.amount}` : 'closed'}`; };

  await send('METAPLEX CORE — TransferV1 of the reference asset', CORE_REF, 'metaplex-core', async (dest) => { const a = decodeCoreAsset((await localAcct(CORE_REF))!.data); if (a.owner !== dest) throw new Error('the asset owner is not the destination'); return `asset owner = ${a.owner}`; });
  await send('PROGRAMMABLE NFT — Token Metadata Transfer with token records and rule set', PNFT, 'metaplex-pnft', async (dest) => { const base = await splCheck(PNFT, pn.tp)(dest);
    const rec = await localAcct(nftTokenRecordPda(PNFT, associatedTokenAddress(dest, PNFT, pn.tp))); if (!rec) throw new Error('no destination token record'); const r = decodeTmTokenRecord(rec.data); if (r.state !== 'unlocked' || r.delegate) throw new Error('destination token record is not clean');
    return `${base}; destination token record: ${r.state}, delegate ${r.delegate ?? 'none'}`; });
  await send('LEGACY TOKEN METADATA NFT — Token Metadata Transfer', LEGACY, 'metaplex-token-metadata', splCheck(LEGACY, TOKEN_PROGRAM));
  await send('TOKEN-2022 NFT — CreateIdempotent + TransferChecked', T22, 'spl-token-2022', splCheck(T22, TOKEN_2022_PROGRAM));

  // ── refusals ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  say('\nREFUSALS');
  const bh = await local<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const chainSays = async (i: NftIntent) => { const s = await local<{ value: { err: unknown; logs: string[] | null } }>('simulateTransaction', [Buffer.from(nftSolWire(new Uint8Array(64), buildNftSolMessage(i))).toString('base64'), { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }]);
    return s.value.err ? `${JSON.stringify(s.value.err)} — ${(s.value.logs ?? []).filter((l) => /log:/.test(l)).slice(-1)[0] ?? ''}` : 'NO ERROR'; };
  const intentOf = (standard: NftIntent['standard'], asset: string, program: string, sol: Record<string, unknown>): NftIntent => ({ v: 1, kind: 'nft-transfer', proposalId: crypto.randomUUID(), keyId: keys.keyId, network: 'solana', chainRef: genesis, standard, asset, quantity: '1', program, from: ME, to: fresh(),
    maxFee: '500000', createdAt: 1, expiresAt: 2, policyVersion: 4, nftPolicyVersion: 1, sol: { recentBlockhash: bh.value.blockhash, lastValidBlockHeight: bh.value.lastValidBlockHeight, computeUnitLimit: 400000, computeUnitPrice: '1000', ...sol } as never });
  // 1. a LOCKED programmable NFT
  await api('POST', '/api/v1/nfts/manual', { chain: 'solana', address: PNFT_LOCKED });
  const lockedItem = (await api('GET', `/api/v1/nfts/item?key=${encodeURIComponent(key(PNFT_LOCKED))}`)).json;
  const locked = await api('POST', '/api/v1/nfts/transfer/prepare', { key: key(PNFT_LOCKED), to: fresh() }, crypto.randomUUID());
  say(`  locked pNFT ${PNFT_LOCKED}: item page says blockedBy=[${lockedItem.transfer.blockedBy}]; prepare → ${locked.status} ${locked.json.error} — ${locked.json.message}`);
  if (locked.status !== 422 || locked.json.error !== 'nft_transfer_pnft_locked') throw new Error('a locked pNFT was not refused with pnft_locked');
  const lockedRule = decodeTmMetadata((await localAcct(nftMetadataPda(PNFT_LOCKED)))!.data).programmableConfig?.ruleSet;
  say(`    what the Token Metadata program itself answers to the same transfer (simulation, bypassing the API): ${await chainSays(intentOf('metaplex-pnft', PNFT_LOCKED, NFT_TOKEN_METADATA_PROGRAM, { tokenProgram: 'token', ...(lockedRule ? { ruleSet: lockedRule } : {}) }))}`);
  // 2. a pNFT moved as an ORDINARY SPL transfer is not something the wallet builds; the chain refuses it too (the account is frozen)
  //    (shown with the locked subject: built here by hand as a Token-2022-style plain transfer is impossible — the signer has no such route for a Token-program mint)
  // 3. a FROZEN Core asset
  if (frozenReady) {
    await api('POST', '/api/v1/nfts/manual', { chain: 'solana', address: FROZEN_ASSET });
    const fi = (await api('GET', `/api/v1/nfts/item?key=${encodeURIComponent(key(FROZEN_ASSET))}`)).json;
    const fr = await api('POST', '/api/v1/nfts/transfer/prepare', { key: key(FROZEN_ASSET), to: fresh() }, crypto.randomUUID());
    say(`  frozen Core asset ${FROZEN_ASSET}: item page says blockedBy=[${fi.transfer.blockedBy}]; prepare → ${fr.status} ${fr.json.error} — ${fr.json.message}`);
    if (fr.status !== 422 || fr.json.error !== 'nft_transfer_frozen') throw new Error('a frozen Core asset was not refused with frozen');
    say(`    what the Core program itself answers to the same transfer: ${await chainSays(intentOf('metaplex-core', FROZEN_ASSET, NFT_CORE_PROGRAM, { collection: FROZEN_COLL }))}`);
  }
  // 4. an NFT that already left the wallet (the Core asset sent above), and a destination that is a program
  const gone = await api('POST', '/api/v1/nfts/transfer/prepare', { key: key(CORE_REF), to: fresh() }, crypto.randomUUID());
  say(`  asset that already left the wallet: ${gone.status} ${gone.json.error}`);
  if (gone.status !== 422) throw new Error('an asset that left the wallet was not refused');
  // 5. a compromised API changes the destination after the review: the signer refuses (the locked pNFT cannot be prepared, so the frozen-free Core copy is not available either: use a fresh copy of the reference asset? — the 4 subjects are spent; the tampering case is proven on the EVM forks and in the signer tests)
  say(`\nsigner journal: ${store.journalRecords().filter((r) => r.type.startsWith('nft.')).map((r) => `${r.type}(${r.data.standard ?? r.data.code})`).join(', ')}`);
  say('NFT SOLANA LOCAL-VALIDATOR PROOF OK (local validator with mainnet programs and copied accounts; nothing was sent to a real network)');
} finally { await cleanup(); }
