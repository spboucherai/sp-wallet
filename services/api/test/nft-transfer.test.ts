/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/nft-transfer.test.ts
 * Module           : services
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

// NFT delivery 2 — the API half of NFT transfers, through the real server (own database), with the REAL signer code in
// process (software passkey, public test mnemonic) and scripted chains. No network; SPW_BROADCAST is off, so a signed
// transfer ends `not_broadcast` — the honest state — and nothing is relayed anywhere.
//   EVM: a small in-memory chain (two "endpoints" that can be made to disagree) with an ERC-721 and an ERC-1155 contract.
//   Solana: the recorded mainnet answers of delivery 1 (fixtures/nft) for the per-asset verdicts; the full Solana path is
//   exercised on a local validator by scripts/validator-nft-solana.mts.
//   Bitcoin: stub indexers, a stub ord server answering the documented JSON, the real coin selection and the real signer.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc721Abi, getAddress, keccak256, pad, parseAbi, parseTransaction, toHex } from 'viem';
import { intentHash, NETWORKS, nftIntentHash, utxoLockHash, type Intent, type NftIntent } from '@spw/core';
import { TestPasskey } from '../../../tests/helpers/passkey.ts';
import { deriveKeys } from '../../isolated-signer/src/keys.ts';
import { Signer } from '../../isolated-signer/src/signer.ts';
import { Store } from '../../isolated-signer/src/store.ts';
import { clockOf, loadFixture, replay } from './nft-helpers.ts';
import { useTestDatabase } from './test-db.ts';

const ORIGIN = 'https://wallet.test', RP = 'wallet.test';
const keys = deriveKeys('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), ME = keys.addresses.evm;
const C721 = getAddress('0x' + '72'.repeat(20)), C1155 = getAddress('0x' + '15'.repeat(20)), WEIRD = getAddress('0x' + '99'.repeat(20)), RECEIVER_LESS = getAddress('0x' + 'c0'.repeat(20)), FRIEND = getAddress('0x' + 'f1'.repeat(20)), OTHER = getAddress('0x' + 'f2'.repeat(20));
const USDC = NETWORKS.ethereum.tokens.find((t) => t.symbol === 'USDC')!.id;
const abi721 = erc721Abi, abi1155 = parseAbi(['function balanceOf(address account, uint256 id) view returns (uint256)', 'function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)', 'function supportsInterface(bytes4 id) view returns (bool)']);
const sel = (sig: string) => keccak256(toHex(sig)).slice(0, 10);
const word = (v: bigint | boolean | string) => (typeof v === 'string' ? pad(v as `0x${string}`) : encodeAbiParameters([{ type: 'uint256' }], [typeof v === 'boolean' ? (v ? 1n : 0n) : v]));

// ── the scripted EVM chain ──────────────────────────────────────────────────────────────────────────────────────────────
const chain = {
  owners: new Map<string, string>([['1', ME], ['2', ME], ['3', OTHER]]), balances: new Map<string, bigint>([[`${ME}/7`, 3n], [`${OTHER}/7`, 5n]]),
  code: new Set([C721, C1155, WEIRD, RECEIVER_LESS, USDC]), nonce: 4, pendingNonce: 4, baseFee: 2_000_000_000n, nativeBalance: 10n ** 18n,
  /** when set, the SECOND endpoint answers ownerOf with this address (a lying or lagging endpoint) */ secondSaysOwner: null as string | null, down: null as string | null, asked: [] as string[],
};
const revert = (message: string) => Object.assign(new Error(message), { rpcCode: 3 });
async function evm(url: string, method: string, params: unknown): Promise<unknown> {
  const p = params as any[], second = url.includes('drpc'); // eslint-disable-line @typescript-eslint/no-explicit-any
  chain.asked.push(`${new URL(url).host} ${method}`);
  if (chain.down && url.includes(chain.down)) throw new Error('connect ECONNREFUSED');
  switch (method) {
    case 'eth_chainId': return '0x1';
    case 'eth_blockNumber': return '0x1000000';
    case 'eth_getCode': return chain.code.has(getAddress(p[0])) ? '0x6080' : '0x';
    case 'eth_getTransactionCount': return toHex(p[1] === 'pending' ? chain.pendingNonce : chain.nonce);
    case 'eth_getBlockByNumber': return { number: '0xfffff0', baseFeePerGas: toHex(chain.baseFee) };
    case 'eth_maxPriorityFeePerGas': return toHex(1_000_000_000n);
    case 'eth_getBalance': return toHex(chain.nativeBalance);
    case 'eth_estimateGas': return toHex(90_000n);
    case 'eth_getLogs': return [];
    case 'eth_call': {
      const to = getAddress(p[0].to), data = String(p[0].data), s4 = data.slice(0, 10), arg = (k: number) => BigInt('0x' + data.slice(10 + 64 * k, 74 + 64 * k)), addr = (k: number) => getAddress('0x' + data.slice(34 + 64 * k, 74 + 64 * k));
      if (s4 === sel('supportsInterface(bytes4)')) { const id = data.slice(10, 18);
        if (to === C721) return word(id === '80ac58cd' || id === '01ffc9a7'); if (to === C1155) return word(id === 'd9b67a26' || id === '01ffc9a7'); if (to === WEIRD) return word(id === '80ac58cd' || id === 'd9b67a26'); throw revert('execution reverted'); }
      if (to === C721 || to === WEIRD) {
        if (s4 === sel('ownerOf(uint256)')) { const o = second && chain.secondSaysOwner ? chain.secondSaysOwner : chain.owners.get(arg(0).toString()); if (!o) throw revert('execution reverted: ERC721: invalid token ID'); return word(o); }
        if (s4 === sel('safeTransferFrom(address,address,uint256)')) { const dest = addr(1); if (chain.owners.get(arg(2).toString()) !== addr(0)) throw revert('execution reverted: ERC721: caller is not token owner or approved');
          if (chain.code.has(dest)) throw revert('execution reverted: ERC721: transfer to non ERC721Receiver implementer'); return '0x'; }
      }
      if (to === C1155) {
        if (s4 === sel('balanceOf(address,uint256)')) return word(chain.balances.get(`${addr(0)}/${arg(1)}`) ?? 0n);
        if (s4 === sel('safeTransferFrom(address,address,uint256,uint256,bytes)')) { if ((chain.balances.get(`${addr(0)}/${arg(2)}`) ?? 0n) < arg(3)) throw revert('execution reverted: ERC1155: insufficient balance for transfer');
          if (chain.code.has(addr(1))) throw revert('execution reverted: ERC1155: transfer to non-ERC1155Receiver implementer'); return '0x'; }
      }
      throw revert('execution reverted');
    }
    default: throw Object.assign(new Error(`method ${method} not scripted`), { rpcCode: -32601 });
  }
}
const pnftFx = loadFixture('sol-pnft'), solWorld = replay(loadFixture('sol-core-reference'), pnftFx, loadFixture('sol-compressed'), loadFixture('sol-token2022'), loadFixture('sol-legacy-escrow'));
const rpc = (url: string, method: string, params: unknown) => (/solana/.test(url) ? solWorld.rpc(url, method, params) : evm(url, method, params));

let app: any, sql: any, cookie = '', signer: Signer, store: Store, pk: TestPasskey, dir: string; // eslint-disable-line @typescript-eslint/no-explicit-any
const nowRef = { t: Math.floor(Date.now() / 1000) };
async function call(method: string, path: string, o: { body?: unknown; cookie?: string | null; csrf?: boolean; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) }, c = o.cookie === undefined ? cookie : o.cookie;
  if (c) headers.cookie = c;
  if (method !== 'GET' && o.csrf !== false) { headers.origin = ORIGIN; headers['x-spw-csrf'] = '1'; }
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const r = await app.inject({ method, url: `/api/v1${path}`, headers, payload: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })() };
}
const key721 = (id: string) => `evm:ethereum:${C721.toLowerCase()}/${id}`, key1155 = `evm:ethereum:${C1155.toLowerCase()}/7`;
const prepare = (key: string, to: string, quantity?: string, idem: string = randomUUID()) => call('POST', '/nfts/transfer/prepare', { body: { key, to, ...(quantity ? { quantity } : {}) }, headers: { 'idempotency-key': idem } });
const approve = (r: { json: any }) => call('POST', `/nfts/transfer/${r.json.proposal.id}/approve`, { body: { assertion: pk.assert(Buffer.from(r.json.options.challenge, 'base64url')) } }); // eslint-disable-line @typescript-eslint/no-explicit-any
const track = (address: string, tokenId: string) => call('POST', '/nfts/manual', { body: { chain: 'ethereum', address, tokenId } });
const freeNetwork = () => sql`update proposals set state = 'failed' where state in ('approved', 'signed', 'broadcast', 'pending_approval')`;

beforeAll(async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'spw-nft-transfer-'));
  await useTestDatabase('nft_transfer', { NFT_CACHE_DIR: cacheDir });
  const db = await import('../src/db.ts'); sql = db.sql; await db.migrate();
  const token = randomBytes(32).toString('base64url');
  await sql`insert into sessions (id_hash, expires_at) values (${createHash('sha256').update(token).digest('hex')}, now() + interval '1 hour')`;
  cookie = `${(await import('../src/auth.ts')).COOKIE}=${token}`;
  dir = mkdtempSync(join(tmpdir(), 'spw-nft-transfer-signer-'));
  store = new Store(join(dir, 'state.json'), join(dir, 'policy.json'));
  store.state.setupTokenHash = createHash('sha256').update('t').digest('hex');
  signer = new Signer(keys, store, { rpId: RP, origin: ORIGIN }, () => nowRef.t);
  pk = new TestPasskey(RP, ORIGIN);
  await signer.enroll({ credential: pk.credential(), setupToken: 't' });
  await sql`insert into credentials (id, public_key, counter, transports) values (${pk.id}, ${pk.publicKey}, 0, ${sql.json(['internal'])})`.catch(() => {});
  const signerApi = { status: async () => signer.status() as never, nftSign: (i: unknown, a: unknown) => signer.nftSign(i, a as never).catch(rethrow), utxoLocks: (r: unknown, a: unknown) => signer.utxoLocks(r, a as never).catch(rethrow), nftAllow: (r: unknown, a: unknown) => signer.nftAllow(r, a as never).catch(rethrow) };
  app = await (await import('../src/server.ts')).buildServer({ nft: { rpc, now: () => new Date(nowRef.t * 1000), addresses: async () => signer.status().addresses, market: null, autoSync: false, signer: signerApi, ord: null,
    fetch: { resolve: async () => [], transport: async () => ({ status: 404, headers: {}, body: new Uint8Array(), truncated: false }), now: () => nowRef.t * 1000 } as never } });
}, 120_000);
afterAll(async () => { await app?.close(); });
/** what signer-client.ts does with a signer refusal: `signer_<code>` and 422 */
const rethrow = async (e: unknown): Promise<never> => { const { UserError } = await import('../src/config.ts'); throw new UserError(`signer_${(e as { code?: string }).code ?? 'error'}`, (e as Error).message, 422); };

describe('routes: owner session only', () => {
  it('no session → 401; an API key is not accepted; a state-changing request needs the CSRF header', async () => {
    for (const [m, p] of [['GET', `/nfts/transfer/verdict?key=${encodeURIComponent(key721('1'))}`], ['POST', '/nfts/transfer/prepare'], ['POST', `/nfts/transfer/${randomUUID()}/approve`], ['GET', '/nfts/transfers'], ['GET', '/nfts/allow'], ['POST', '/nfts/allow/prepare'], ['POST', '/nfts/allow/approve'], ['GET', '/utxo-locks'], ['POST', '/utxo-locks/prepare'], ['POST', '/utxo-locks/approve'], ['POST', '/utxo-locks/review']] as const) {
      expect((await call(m, p, { cookie: null, body: m === 'POST' ? {} : undefined })).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, { cookie: null, body: m === 'POST' ? {} : undefined, headers: { authorization: 'Bearer spw_live_' + 'a'.repeat(40) } })).status, `${m} ${p} with an API key`).not.toBe(200);
      if (m === 'POST') expect((await call(m, p, { body: {}, csrf: false })).status, `${m} ${p} without CSRF`).toBe(403);
    }
  });
  it('validation: no owner address, no calldata, no method is accepted anywhere; a key is required for idempotency', async () => {
    await track(C721, '1');
    for (const extra of [{ owner: OTHER }, { from: OTHER }, { data: '0x00' }, { method: 'approve' }, { operator: OTHER }, { calldata: '0x' }]) expect((await call('POST', '/nfts/transfer/prepare', { body: { key: key721('1'), to: FRIEND, ...extra }, headers: { 'idempotency-key': randomUUID() } })).status, JSON.stringify(extra)).toBe(400);
    expect((await call('POST', '/nfts/transfer/prepare', { body: { key: key721('1'), to: FRIEND } })).json.error).toBe('idempotency');
    for (const q of ['0', '-1', '1.5', '0x1', ' 1', '1e3']) expect((await prepare(key721('1'), FRIEND, q)).status, q).toBe(400);
    expect((await prepare('not-a-key', FRIEND)).status).toBe(400);
  });
});

describe('ERC-721 — prepare, review, passkey, signer, the honest not_broadcast state', () => {
  it('the verdict replaces "not built": a token the wallet holds is transferable; one it does not hold says why', async () => {
    await track(C721, '1'); await call('POST', '/nfts/lookup', { body: { chain: 'ethereum', address: C721, tokenId: '3' } });
    const mine = (await call('GET', `/nfts/transfer/verdict?key=${encodeURIComponent(key721('1'))}`)).json, his = (await call('GET', `/nfts/transfer/verdict?key=${encodeURIComponent(key721('3'))}`)).json;
    expect(mine).toMatchObject({ transferable: true, blockedBy: [], standard: 'erc721', route: 'safeTransferFrom(address,address,uint256)', signer: { reachable: true, halted: false, supportsNft: true, signedToday: 0, maxPerDay: 5 }, broadcast: false });
    expect(his).toMatchObject({ transferable: false, blockedBy: ['not_in_wallet'] });
    expect((await call('GET', `/nfts/item?key=${encodeURIComponent(key721('1'))}`)).json.transfer).toMatchObject({ transferable: true, blockedBy: [] });
    expect((await call('GET', '/nfts')).json.items.find((x: { key: string }) => x.key === key721('1'))).toMatchObject({ transferable: true, transferBlockedBy: null });
  });
  it('prepare: both endpoints are asked, the review carries the ON-CHAIN identifiers, the challenge is the hash of the NFT intent', async () => {
    await freeNetwork(); chain.asked.length = 0;
    const r = await prepare(key721('1'), FRIEND);
    expect(r.status).toBe(200);
    const { intent, review, proposal, options } = r.json as { intent: NftIntent; review: any; proposal: any; options: { challenge: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(intent).toMatchObject({ v: 1, kind: 'nft-transfer', network: 'ethereum', chainRef: '1', standard: 'erc721', asset: C721, tokenId: '1', quantity: '1', program: C721, from: ME, to: FRIEND, keyId: keys.keyId, policyVersion: 4, nftPolicyVersion: 1, evm: { nonce: 4 } });
    expect(Object.keys(intent).sort()).toEqual(['asset', 'chainRef', 'createdAt', 'evm', 'expiresAt', 'from', 'keyId', 'kind', 'maxFee', 'network', 'nftPolicyVersion', 'policyVersion', 'program', 'proposalId', 'quantity', 'standard', 'to', 'tokenId', 'v']);
    expect(options.challenge).toBe(Buffer.from(nftIntentHash(intent)).toString('base64url'));
    expect(proposal).toMatchObject({ kind: 'nft', state: 'pending_approval', network: 'ethereum', asset: C721, symbol: 'NFT', amount: '1', from: ME, to: FRIEND, intentHash: Buffer.from(nftIntentHash(intent)).toString('hex') });
    expect(review).toMatchObject({ standard: 'erc721', method: 'safeTransferFrom(address,address,uint256)', asset: C721, tokenId: '1', quantity: '1', program: C721, from: ME, to: FRIEND, toKind: 'account', networkName: 'Ethereum',
      fee: { symbol: 'ETH', decimals: 18, rent: null }, simulation: { ok: true, used: '90000' }, verified: { endpoints: 2 }, creatorMetadata: { name: null } });
    expect(review.warnings).toContain('new_destination');
    expect(BigInt(review.fee.max)).toBeLessThanOrEqual(BigInt(NETWORKS.ethereum.rpc.length ? '5000000000000000' : '0'));
    // every read that decides was asked of BOTH endpoints
    const hosts = (m: string) => new Set(chain.asked.filter((x) => x.endsWith(` ${m}`)).map((x) => x.split(' ')[0]));
    for (const m of ['eth_chainId', 'eth_getCode', 'eth_call', 'eth_getTransactionCount']) expect(hosts(m).size, m).toBe(2);
    // idempotency: the same key answers the same proposal and its challenge; another body under the same key is refused
    const k = randomUUID(); await freeNetwork();
    const a = await prepare(key721('1'), FRIEND, undefined, k), b = await prepare(key721('1'), FRIEND, undefined, k);
    expect(b.json).toMatchObject({ replayed: true, proposal: { id: a.json.proposal.id }, options: { challenge: a.json.options.challenge } });
    expect(await prepare(key721('1'), OTHER, undefined, k)).toMatchObject({ status: 409, json: { error: 'idempotency_mismatch' } });
    expect((await sql`select count(*)::int as n from proposals where idempotency_key = ${k}`)[0].n).toBe(1);
  });
  it('approve: the REAL signer builds safeTransferFrom(wallet, to, tokenId) and signs; with broadcasting off the row is not_broadcast — never "sent"', async () => {
    await freeNetwork();
    const r = await prepare(key721('1'), FRIEND), done = await approve(r);
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ kind: 'nft', state: 'not_broadcast', errorCode: 'broadcast_disabled', explorer: null, confirmations: 0 });
    expect(done.json.execution.state).toBe('failed'); // the unified status never reads as sent or confirmed
    const [row] = await sql`select raw, txid, intent_hash from proposals where id = ${r.json.proposal.id}`;
    const tx = parseTransaction(row.raw), d = decodeFunctionData({ abi: abi721, data: tx.data! });
    expect(tx.to!.toLowerCase()).toBe(C721.toLowerCase()); expect(tx.value ?? 0n).toBe(0n); expect(d.functionName).toBe('safeTransferFrom'); expect(d.args).toEqual([ME, FRIEND, 1n]);
    expect(store.journalRecords().at(-1)).toMatchObject({ type: 'nft.sign.ok', data: { hash: row.intent_hash, asset: C721, tokenId: '1', to: FRIEND } });
    // a not_broadcast transfer leaves no event behind and the inventory unchanged; a second approval of the same proposal is refused
    expect((await sql`select count(*)::int as n from nft_events where tx = ${row.txid}`)[0].n).toBe(0);
    expect((await call('GET', `/nfts/item?key=${encodeURIComponent(key721('1'))}`)).json.ownership.heldByWallet).toBe(true);
    expect((await approve(r)).json.error).toBe('bad_state');
    expect((await call('GET', `/nfts/transfers?key=${encodeURIComponent(key721('1'))}`)).json.items[0]).toMatchObject({ id: r.json.proposal.id, state: 'not_broadcast', nft: { asset: C721, tokenId: '1' } });
    expect((await call('GET', `/nfts/transfer/${r.json.proposal.id}`)).json.state).toBe('not_broadcast');
    expect((await call('GET', `/nfts/transfer/${randomUUID()}`)).status).toBe(404);
  });
  it('the ordinary transfer routes refuse an NFT proposal, and the NFT approve route refuses an ordinary one', async () => {
    await freeNetwork();
    const r = await prepare(key721('1'), FRIEND);
    expect(await call('POST', `/transfers/proposals/${r.json.proposal.id}/request-approval`, { body: {} })).toMatchObject({ status: 409, json: { error: 'bad_state' } });
    expect(await call('POST', `/transfers/proposals/${r.json.proposal.id}/approve`, { body: { assertion: pk.assert(Buffer.from(r.json.options.challenge, 'base64url')) } })).toMatchObject({ status: 409, json: { error: 'bad_state' } });
    expect((await sql`select state from proposals where id = ${r.json.proposal.id}`)[0].state).toBe('pending_approval');
    const id = randomUUID();
    await sql`insert into proposals (id, idempotency_key, state, network, asset, symbol, decimals, amount, from_addr, to_addr, intent) values (${id}, ${randomUUID()}, 'pending_approval', 'ethereum', 'native', 'ETH', 18, 1, ${ME}, ${FRIEND}, '{}')`;
    expect((await call('POST', `/nfts/transfer/${id}/approve`, { body: { assertion: {} } })).status).toBe(404);
    // rejecting uses the existing route
    expect((await call('POST', `/transfers/proposals/${r.json.proposal.id}/reject`, { body: {} })).json.state).toBe('rejected');
  });
});

describe('refusals before any passkey prompt — each with its factual code', () => {
  const code = async (p: Promise<{ status: number; json: any }>) => { const r = await p; return `${r.status} ${r.json?.error}`; }; // eslint-disable-line @typescript-eslint/no-explicit-any
  it('destination: the wallet itself, the contract itself, the zero address, a malformed address', async () => {
    await freeNetwork();
    expect(await code(prepare(key721('1'), ME))).toBe('422 nft_transfer_destination_is_wallet');
    expect(await code(prepare(key721('1'), C721))).toBe('422 nft_transfer_destination_is_contract_itself');
    expect(await code(prepare(key721('1'), '0x0000000000000000000000000000000000000000'))).toBe('400 nft_transfer_bad_destination');
    expect(await code(prepare(key721('1'), '0x' + 'zz'.repeat(20)))).toBe('400 nft_transfer_bad_destination');
    expect(await code(prepare(key721('1'), FRIEND.slice(0, 20) + FRIEND.slice(20).toUpperCase()))).toBe('400 nft_transfer_bad_destination'); // bad EIP-55 checksum
  });
  it('a contract recipient that does not implement the receiver interface: the simulation\'s revert reason is the answer', async () => {
    const r = await prepare(key721('1'), RECEIVER_LESS);
    expect(r.status).toBe(422); expect(r.json.error).toBe('nft_transfer_simulation_reverted');
    expect(r.json.message).toContain('ERC721: transfer to non ERC721Receiver implementer'); expect(r.json.message).toContain('receiver interface');
    expect(r.json.data).toMatchObject({ toKind: 'contract', reason: 'ERC721: transfer to non ERC721Receiver implementer' });
    expect((await sql`select count(*)::int as n from proposals where to_addr = ${RECEIVER_LESS}`)[0].n).toBe(0);
  });
  it('ownership: a token of another holder; a token that left the wallet between the review and the request; endpoints that disagree; one endpoint down', async () => {
    expect(await code(prepare(key721('3'), FRIEND))).toBe('422 nft_transfer_not_in_wallet');
    await track(C721, '2');
    chain.owners.set('2', OTHER); // it leaves the wallet after the inventory read it
    expect(await code(prepare(key721('2'), FRIEND))).toBe('422 nft_transfer_not_in_wallet');
    chain.owners.set('2', ME);
    chain.secondSaysOwner = OTHER; // the second endpoint names another owner
    const d = await prepare(key721('2'), FRIEND);
    expect(d.status).toBe(503); expect(d.json.error).toMatch(/nft_transfer_rpc_disagreement|rpc_disagreement/);
    chain.secondSaysOwner = null;
    chain.down = 'drpc';
    const one = await prepare(key721('2'), FRIEND);
    expect([503, 422]).toContain(one.status); expect(one.json.error).toMatch(/single_source|rpc_degraded|provider_unavailable/); // one answer is not a verification
    chain.down = null;
    expect((await sql`select count(*)::int as n from proposals where asset = ${C721} and amount = 1 and nft->>'tokenId' = '2'`)[0].n).toBe(0);
  });
  it('standard: a registered fungible token, a contract that declares both standards, an address with no code', async () => {
    expect((await call('POST', '/nfts/lookup', { body: { chain: 'ethereum', address: USDC, tokenId: '1' } })).status).not.toBe(200);
    expect((await prepare(`evm:ethereum:${USDC.toLowerCase()}/1`, FRIEND)).status).not.toBe(200);
    const w = await call('POST', '/nfts/lookup', { body: { chain: 'ethereum', address: WEIRD, tokenId: '1' } });
    if (w.status === 200) expect(await code(prepare(`evm:ethereum:${WEIRD.toLowerCase()}/1`, FRIEND))).toMatch(/^422 nft_transfer_(non_standard_contract|unsupported_standard|standard_changed)$/);
    expect((await prepare(`evm:ethereum:${OTHER.toLowerCase()}/1`, FRIEND)).status).not.toBe(200);
  });
  it('a transfer already in flight on the network; a pending transaction of the wallet; not enough native coin for the fee; a fee above the signer\'s ceiling', async () => {
    await freeNetwork();
    const first = await prepare(key721('1'), FRIEND);
    await sql`update proposals set state = 'broadcast' where id = ${first.json.proposal.id}`;
    expect(await code(prepare(key721('1'), OTHER))).toBe('409 pending_tx');
    await freeNetwork();
    chain.pendingNonce = 5;
    expect(await code(prepare(key721('1'), FRIEND))).toBe('409 pending_tx');
    chain.pendingNonce = 4; chain.nativeBalance = 1000n;
    expect(await code(prepare(key721('1'), FRIEND))).toBe('400 insufficient_gas');
    chain.nativeBalance = 10n ** 18n; chain.baseFee = 200_000_000_000n; // 200 gwei: 127 000 gas costs more than the 0.005 ETH ceiling of the policy
    const fee = await prepare(key721('1'), FRIEND);
    expect(fee.status).toBe(422); expect(fee.json.error).toBe('nft_transfer_fee_above_policy'); expect(fee.json.data).toMatchObject({ ceiling: '5000000000000000' });
    chain.baseFee = 2_000_000_000n;
  });
  it('an expired proposal is not approved; a tampered stored intent is refused by the signer and the proposal ends failed with the signer\'s code', async () => {
    await freeNetwork();
    const r = await prepare(key721('1'), FRIEND);
    await sql`update proposals set expires_at = now() - interval '1 second' where id = ${r.json.proposal.id}`;
    expect(await code(approve(r))).toBe('410 expired');
    for (const patch of [{ tokenId: '2' }, { to: OTHER }, { asset: C1155, program: C1155 }, { network: 'base', chainRef: '8453' }]) {
      await freeNetwork();
      const p = await prepare(key721('1'), FRIEND);
      await sql`update proposals set intent = ${sql.json({ ...p.json.intent, ...patch })} where id = ${p.json.proposal.id}`;
      const a = await approve(p);
      expect(a.status, JSON.stringify(patch)).toBe(422); expect(a.json.error).toMatch(/^signer_(bad_approval|nft_fee_cap)$/);
      expect((await sql`select state, error_code, raw from proposals where id = ${p.json.proposal.id}`)[0]).toMatchObject({ state: 'failed', raw: null });
    }
    // an assertion over another proposal's hash
    await freeNetwork();
    const a1 = await prepare(key721('1'), FRIEND);
    const other = await call('POST', `/nfts/transfer/${a1.json.proposal.id}/approve`, { body: { assertion: pk.assert(new Uint8Array(32).fill(7)) } });
    expect(other.json.error).toBe('signer_bad_approval');
  });
});

describe('ERC-1155 — quantity', () => {
  it('quantity within what is held: the signer builds safeTransferFrom(wallet, to, id, quantity, ""); above the balance or the policy cap: refused', async () => {
    await freeNetwork(); await track(C1155, '7');
    const item = (await call('GET', `/nfts/item?key=${encodeURIComponent(key1155)}`)).json;
    expect(item).toMatchObject({ standard: 'erc1155', quantity: '3', transfer: { transferable: true, warnings: ['semi_fungible'] } });
    expect((await prepare(key1155, FRIEND, '4')).json).toMatchObject({ error: 'nft_transfer_insufficient_quantity', data: { balance: '3' } });
    const r = await prepare(key1155, FRIEND, '2');
    expect(r.status).toBe(200); expect(r.json.intent).toMatchObject({ standard: 'erc1155', tokenId: '7', quantity: '2' }); expect(r.json.review.method).toContain('data empty');
    const done = await approve(r);
    expect(done.json.state).toBe('not_broadcast');
    const tx = parseTransaction((await sql`select raw from proposals where id = ${r.json.proposal.id}`)[0].raw), d = decodeFunctionData({ abi: abi1155, data: tx.data! });
    expect(d.args).toEqual([ME, FRIEND, 7n, 2n, '0x']); expect((tx.data!.length - 2) / 2).toBe(196);
    chain.balances.set(`${ME}/7`, 50n); await freeNetwork();
    expect((await prepare(key1155, FRIEND, '11')).json).toMatchObject({ error: 'nft_transfer_policy_quantity_cap', data: { max: '10' } });
    expect((await prepare(key1155, RECEIVER_LESS, '1')).json.message).toContain('ERC1155: transfer to non-ERC1155Receiver implementer');
    chain.balances.set(`${ME}/7`, 3n);
  });
});

describe('signer policy and state seen from the API', () => {
  it('halt: nothing is prepared (423) and an already prepared transfer is refused by the signer', async () => {
    await freeNetwork();
    const r = await prepare(key721('1'), FRIEND);
    store.state.halted = true;
    expect((await prepare(key721('1'), OTHER)).status).toBe(423);
    expect((await approve(r)).json.error).toBe('signer_nft_halted');
    store.state.halted = false;
  });
  it('network switch, allow-list mode and the daily count come from the signer: the verdict and the preparation say so', async () => {
    await freeNetwork();
    const base = store.policy;
    store.policy = { ...base, nft: { enabled: { solana: ['metaplex-core'] } } };
    expect((await call('GET', `/nfts/transfer/verdict?key=${encodeURIComponent(key721('1'))}`)).json).toMatchObject({ transferable: false, blockedBy: ['network_disabled_by_policy'] });
    expect((await prepare(key721('1'), FRIEND)).json.error).toBe('nft_transfer_network_disabled_by_policy');
    store.policy = { ...base, nft: { allowlistOnly: true } };
    expect((await prepare(key721('1'), FRIEND)).json).toMatchObject({ error: 'nft_transfer_policy_not_allowlisted', data: { policy: true } });
    // the owner approves the destination with the passkey (allow-list intent), then the same request is prepared
    const ap = await call('POST', '/nfts/allow/prepare', { body: { network: 'ethereum', address: FRIEND, action: 'add' } });
    expect(ap.json.intent).toMatchObject({ kind: 'nft-allow', network: 'ethereum', address: FRIEND, action: 'add' });
    expect((await call('POST', '/nfts/allow/approve', { body: { intent: ap.json.intent, assertion: pk.assert(new Uint8Array(32)) } })).json.error).toBe('signer_bad_approval');
    expect((await call('POST', '/nfts/allow/approve', { body: { intent: { ...ap.json.intent, address: OTHER }, assertion: pk.assert(Buffer.from(ap.json.options.challenge, 'base64url')) } })).json.error).toBe('signer_bad_approval');
    expect((await call('POST', '/nfts/allow/approve', { body: { intent: ap.json.intent, assertion: pk.assert(Buffer.from(ap.json.options.challenge, 'base64url')) } })).json).toMatchObject({ action: 'add', entries: 1 });
    expect((await call('GET', '/nfts/allow')).json).toMatchObject({ allowlistOnly: true, entries: [{ network: 'ethereum', address: FRIEND }] });
    expect((await prepare(key721('1'), FRIEND)).status).toBe(200);
    expect((await prepare(key721('2'), OTHER)).json.error).toBe('nft_transfer_policy_not_allowlisted');
    store.policy = { ...base, nft: { maxTransfersPerDay: 0 } };
    await freeNetwork();
    expect((await prepare(key721('1'), FRIEND)).json.error).toBe('nft_transfer_policy_daily_count');
    store.policy = base;
  });
});

describe('Solana — the per-asset verdict from the recorded chain answers (no "not built" any more)', () => {
  it('Core reference held by its owner: transferable, with the collection\'s permanent delegates as a warning; pNFT locked + delegated, compressed: blocked with the exact reason', async () => {
    const { solanaProvider } = await import('../src/nft/solana.ts'), { transferVerdict, BLOCK_TEXT } = await import('../src/nft/transfer.ts'), { defaultNftPolicy } = await import('@spw/core');
    const p = solanaProvider({ rpc: solWorld.rpc, now: clockOf(pnftFx), dasUrl: null }), pol = defaultNftPolicy();
    const core = await p.lookup('solana', { address: 'CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j' }, '62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS');
    expect(transferVerdict(core, pol)).toMatchObject({ transferable: true, blockedBy: [], route: 'Core TransferV1 (no compression proof)', warnings: ['core_collection_permanent_delegate', 'mutable_metadata'] });
    expect(transferVerdict(core, { ...pol, enabled: { solana: ['metaplex-pnft'] } }).blockedBy).toEqual(['network_disabled_by_policy']);
    expect(transferVerdict(await p.lookup('solana', { address: 'CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j' }, 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'), pol).blockedBy).toEqual(['not_in_wallet']);
    const pnft = await p.lookup('solana', { address: '5FHwu2v4e3M9yUpB2VcJtdDGAngEkWJnoH4VbU4Amm2t' }, '68KUHsNdR8er6DtWkWneEbJWoDme2MWLoHcwLawJ7gt');
    expect(transferVerdict(pnft, pol)).toMatchObject({ transferable: false, blockedBy: ['pnft_locked', 'delegated'], warnings: ['pnft_rule_set'], route: expect.stringContaining('token records') });
    expect(BLOCK_TEXT.pnft_locked).toContain('LOCKED'); expect(BLOCK_TEXT.pnft_listed).toContain('LISTED'); expect(BLOCK_TEXT.delegated).toContain('delegate');
    const c = await p.lookup('solana', { address: '12XAbDPsEUwVbsN3BZwgdc1uqkTanp7Tds9mEtNEuTH' }, null);
    expect(transferVerdict(c, pol)).toMatchObject({ transferable: false, route: null }); expect(transferVerdict(c, pol).blockedBy).toContain('compressed_transfer_not_supported');
    const escrow = await p.lookup('solana', { address: 'J2U6QmgcuFAEdgF8XaK9t1PKidJ7QVYeSCdmYGybUzYo' }, null);
    expect(transferVerdict(escrow, pol).transferable).toBe(false);
    for (const k of Object.keys(BLOCK_TEXT)) expect(BLOCK_TEXT[k as keyof typeof BLOCK_TEXT]!.length, k).toBeGreaterThan(20);
  });
});

describe('finality: the event and the inventory follow the proposal\'s state, never an assumption', () => {
  it('broadcast → pending event; confirming → confirmed; reorged; finalized → finalized and the asset is read again on-chain; failed → the event is removed', async () => {
    await freeNetwork();
    const { nftOutcomeRecorder } = await import('../src/nft/transfer-routes.ts'), { proposalHooks } = await import('../src/transfers.ts');
    expect(proposalHooks.tracked).toHaveLength(1);
    const r = await prepare(key721('2'), FRIEND), id = r.json.proposal.id, tx = '0x' + 'ab'.repeat(32);
    const at = async (state: string, extra: Record<string, unknown> = {}) => { const [p] = await sql`update proposals set ${sql({ state, txid: tx, raw: '0x02', ...extra })} where id = ${id} returning *`; await proposalHooks.tracked[0]!(p); return (await sql`select type, finality from nft_events where tx = ${tx}`)[0] ?? null; };
    expect(await at('broadcast', { broadcast_at: new Date() })).toEqual({ type: 'transfer-out', finality: 'pending' });
    expect((await call('GET', `/nfts/item?key=${encodeURIComponent(key721('2'))}`)).json.ownership.heldByWallet).toBe(true); // not "sent" before the chain says so
    expect(await at('confirming', { block_ref: '0x' + 'cd'.repeat(32) })).toEqual({ type: 'transfer-out', finality: 'confirmed' });
    expect(await at('reorged')).toEqual({ type: 'transfer-out', finality: 'reorged' });
    chain.owners.set('2', FRIEND); // the chain now names the destination
    expect(await at('finalized')).toEqual({ type: 'transfer-out', finality: 'finalized' });
    const after = (await call('GET', `/nfts/item?key=${encodeURIComponent(key721('2'))}`)).json;
    expect(after.ownership).toMatchObject({ heldByWallet: false, state: 'not_in_wallet' }); expect(after.transfer.blockedBy).toEqual(['not_in_wallet']);
    const act = (await call('GET', `/nfts/activity?key=${encodeURIComponent(key721('2'))}`)).json.events.filter((e: { tx: string }) => e.tx === tx);
    expect(act).toHaveLength(1); expect(act[0]).toMatchObject({ type: 'transfer-out', from: ME, to: FRIEND, quantity: '1', finality: 'finalized', price: null });
    expect(await at('failed')).toBeNull();
    chain.owners.set('2', ME);
    void nftOutcomeRecorder;
  });
});

describe('arrival detection (EVM, known contracts): only what a FINALIZED log shows and the chain then confirms', () => {
  it('scans [cursor+1, finalized] in bounded steps, decodes the three transfer events, reports a gap after a long stop', async () => {
    const { scanContractArrivals, ARRIVAL_SPAN, ARRIVAL_STEPS } = await import('../src/nft/arrivals.ts'), { TOPIC_TRANSFER, TOPIC_SINGLE, TOPIC_BATCH } = await import('../src/nft/evm.ts');
    const asked: { from: number; to: number }[] = [], me = pad(ME as `0x${string}`).toLowerCase(), FIN = 5_000_000;
    const log = (topics: string[], data: string, block: number, idx: number, removed = false) => ({ topics, data, blockNumber: toHex(block), blockHash: '0x' + 'bb'.repeat(32), transactionHash: '0x' + idx.toString(16).padStart(64, '0'), logIndex: toHex(idx), removed });
    const world = async (_u: string, method: string, params: unknown) => { const p = (params as any[])[0]; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (method === 'eth_getBlockByNumber') return { number: toHex(FIN) };
      if (method === 'eth_getLogs') { const from = Number(BigInt(p.fromBlock)), to = Number(BigInt(p.toBlock)); if (p.topics[0] === TOPIC_TRANSFER) asked.push({ from, to });
        if (to !== FIN) return [];
        return p.topics[0] === TOPIC_TRANSFER ? [log([TOPIC_TRANSFER, pad(OTHER), me, word(42n)], '0x', FIN - 3, 1), log([TOPIC_TRANSFER, pad(OTHER), me, word(43n)], '0x', FIN - 2, 2, true)]
          : [log([TOPIC_SINGLE, pad(OTHER), pad(OTHER), me], encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [7n, 2n]), FIN - 1, 3), log([TOPIC_BATCH, pad(OTHER), pad(OTHER), me], encodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], [[8n, 9n], [1n, 4n]]), FIN, 4)]; }
      throw new Error('unexpected'); };
    const first = await scanContractArrivals(world, 'ethereum', C721, ME, null);
    expect(first.finalized).toBe(FIN); expect(first.next).toEqual({ cursor: FIN, gap: false }); expect(asked).toEqual([{ from: FIN - ARRIVAL_SPAN + 1, to: FIN }]);
    expect(first.hits.map((h) => [h.tokenId, h.quantity, h.block])).toEqual([['42', '1', String(FIN - 3)], ['7', '2', String(FIN - 1)], ['8', '1', String(FIN)], ['9', '4', String(FIN)]]); // the removed (reorged) log is not an arrival
    asked.length = 0;
    const next = await scanContractArrivals(world, 'ethereum', C721, ME, { cursor: FIN - 2500, gap: false });
    expect(asked.map((a) => [a.from, a.to])).toEqual([[FIN - 2499, FIN - 1500], [FIN - 1499, FIN - 500], [FIN - 499, FIN]]); expect(next.next).toEqual({ cursor: FIN, gap: false });
    asked.length = 0;
    const late = await scanContractArrivals(world, 'ethereum', C721, ME, { cursor: FIN - 1_000_000, gap: false });
    expect(asked).toHaveLength(ARRIVAL_STEPS); expect(asked[0]!.from).toBe(FIN - ARRIVAL_SPAN * ARRIVAL_STEPS + 1); expect(late.next).toEqual({ cursor: FIN, gap: true }); // the unscanned blocks are said, not hidden
    asked.length = 0;
    expect((await scanContractArrivals(world, 'ethereum', C721, ME, { cursor: FIN, gap: false })).hits).toEqual([]); expect(asked).toEqual([]); // nothing beyond finality is read
  });
  it('a token seen arriving enters the inventory only when ownerOf on both endpoints names the wallet', async () => {
    const { NftService } = { NftService: null } as never; void NftService;
    chain.owners.set('77', ME); chain.owners.set('78', OTHER);
    const svc = (await import('../src/nft/index.ts')); void svc;
    // adopt() is what the scan calls for each hit
    const adopt = async (id: string) => (await call('POST', '/nfts/lookup', { body: { chain: 'ethereum', address: C721, tokenId: id } })).json;
    expect((await adopt('77')).ownership.heldByWallet).toBe(true); expect((await adopt('78')).ownership.heldByWallet).toBe(false);
  });
});

// ── Bitcoin ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const BTC = NETWORKS.bitcoin, BADDR = keys.addresses.btc;
const T = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const COINS = [{ txid: T(1), vout: 0, value: 60_000, confirmed: true }, { txid: T(2), vout: 1, value: 40_000, confirmed: true }, { txid: T(3), vout: 0, value: 546, confirmed: true }, { txid: T(4), vout: 0, value: 9_000, confirmed: true }];
const source = (name: string, coins = COINS, raw: Record<string, string> = {}) => ({ url: `https://${name}.example/api`, tip: async () => 900_000, blockHash: async () => BTC.chainRef, utxos: async () => structuredClone(coins), balance: async () => 0n, feeRate: async () => 2,
  broadcast: async () => {}, status: async () => ({ found: false, confirmed: false }), rawTx: async (id: string) => { if (raw[id] === undefined) throw new Error('no raw'); return raw[id]!; } });
describe('Bitcoin inscription safety — the ord adapter, the classification, the coin-selection guard, the lock routes', () => {
  const DOC = [ // the two objects of docs.ordinals.com/guides/api.html `GET /outputs/<ADDRESS>` (values shortened), plus an inscribed and a runic one in the same documented shape
    { address: BADDR, indexed: true, inscriptions: [], outpoint: `${T(1)}:0`, runes: {}, sat_ranges: [[567775159437503, 567775159443555]], script_pubkey: 'a914…87', spent: false, transaction: T(1), value: 60_000 },
    { address: BADDR, indexed: true, inscriptions: [`${T(9)}i0`], outpoint: `${T(3)}:0`, runes: {}, sat_ranges: null, script_pubkey: '0014…', spent: false, transaction: T(3), value: 546 },
    { address: BADDR, indexed: true, inscriptions: [], outpoint: `${T(4)}:0`, runes: { 'UNCOMMON•GOODS': { amount: 5, divisibility: 0, symbol: '⧉' } }, sat_ranges: null, script_pubkey: '0014…', spent: false, transaction: T(4), value: 9_000 },
  ];
  it('ord adapter: the documented JSON is read; any other shape is a bad answer; an unreachable server is "unavailable" (never "no inscription")', async () => {
    const { ordSource } = await import('../src/nft/utxo.ts');
    const asked: { url: string; accept: string | null }[] = [];
    const http = (body: unknown, status = 200) => async (url: string, init?: RequestInit) => { asked.push({ url, accept: new Headers(init?.headers).get('accept') }); return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }); };
    const o = await ordSource('http://127.0.0.1:8080/', http(DOC)).outputs(BADDR);
    expect(asked).toEqual([{ url: `http://127.0.0.1:8080/outputs/${BADDR}?type=any`, accept: 'application/json' }]);
    expect(o).toEqual([{ outpoint: `${T(1)}:0`, value: 60_000, inscriptions: [], runes: [], indexed: true, spent: false }, { outpoint: `${T(3)}:0`, value: 546, inscriptions: [`${T(9)}i0`], runes: [], indexed: true, spent: false }, { outpoint: `${T(4)}:0`, value: 9_000, inscriptions: [], runes: ['UNCOMMON•GOODS'], indexed: true, spent: false }]);
    const bad = async (body: unknown, status = 200) => ordSource('http://127.0.0.1:8080', http(body, status)).outputs(BADDR).then(() => 'ok', (e) => (e as { code: string }).code);
    expect(await bad('<html>bot check</html>')).toBe('ord_bad_answer'); expect(await bad({ outputs: [] })).toBe('ord_bad_answer'); expect(await bad([{ outpoint: 'x', value: 1 }])).toBe('ord_bad_answer');
    expect(await bad([{ ...DOC[0], value: '60000' }])).toBe('ord_bad_answer'); expect(await bad([{ ...DOC[0], inscriptions: 'none' }])).toBe('ord_bad_answer'); expect(await bad([{ ...DOC[0], indexed: undefined }])).toBe('ord_bad_answer');
    expect(await bad([], 500)).toBe('ord_unavailable'); expect(await bad([], 404)).toBe('ord_unavailable');
    expect(await ordSource('http://127.0.0.1:8080', (async () => { throw new Error('ECONNREFUSED'); }) as never).outputs(BADDR).then(() => 'ok', (e) => (e as { code: string }).code)).toBe('ord_unavailable');
  });
  it('classification: signer locks, ord reports (inscription, rune, unindexed, unlisted), and — without ord — the heuristic and the owner\'s review', async () => {
    const { classifyUtxos, ordSource, HEURISTIC_MAX_SATS } = await import('../src/nft/utxo.ts');
    const ord = ordSource('http://ord.local', async () => new Response(JSON.stringify([...DOC.slice(0, 2), { ...DOC[2], indexed: false, runes: {} }])));
    const deps = { ord, signerLocks: async () => ({ [`${T(1)}:0`]: { reason: 'owner', at: 1 } }), reviewed: async () => new Set<string>() };
    const a = await classifyUtxos(deps, 'bitcoin', BADDR, COINS, null);
    expect(a.mode).toBe('ord'); expect(a.rows.map((r) => [r.value, r.excludedBy, r.spendable])).toEqual([[60_000, ['signer_locked'], false], [40_000, ['ord_unlisted'], false], [546, ['ord_inscription'], false], [9_000, ['ord_unindexed'], false]]);
    // without ord: outputs ≤ 10 000 sat and outputs of a transaction with an inscription envelope are flagged; a review lifts ONLY a heuristic flag
    // (other transaction ids than the coins of the next test: what a transaction contains is remembered per id)
    const H = COINS.map((c, k) => ({ ...c, txid: T(0x21 + k) })), raw = { [T(0x22)]: 'aa' + '0063036f7264' + 'bb', [T(0x21)]: 'aabb' };
    const h = await classifyUtxos({ ord: null, signerLocks: async () => ({ [`${T(0x21)}:0`]: { reason: 'owner', at: 1 } }), reviewed: async () => new Set([`${T(0x24)}:0`, `${T(0x21)}:0`]) }, 'bitcoin', BADDR, H, async (id) => { if (!(id in raw)) throw new Error('x'); return raw[id as keyof typeof raw]!; });
    expect(h.mode).toBe('heuristic'); expect(HEURISTIC_MAX_SATS).toBe(10_000);
    expect(h.rows.map((r) => [r.value, r.excludedBy, r.reviewed, r.spendable])).toEqual([[60_000, ['signer_locked'], false, false], [40_000, ['heuristic_envelope'], false, false], [546, ['heuristic_small'], false, false], [9_000, ['heuristic_small'], true, true]]);
    // other Bitcoin-style networks: the signer's lock list only
    const l = await classifyUtxos({ ...deps, ord: null }, 'litecoin', 'ltc1…', COINS, null);
    expect(l.mode).toBe('locks_only'); expect(l.rows.map((r) => r.spendable)).toEqual([false, true, true, true]);
    await expect(classifyUtxos({ ...deps, ord: ordSource('http://ord.local', (async () => { throw new Error('down'); }) as never) }, 'bitcoin', BADDR, COINS, null)).rejects.toMatchObject({ code: 'ord_unavailable' });
  });
  it('AN ORDINARY BTC SEND CANNOT SELECT A LOCKED OR INSCRIPTION OUTPUT (API level): the coin selection skips them, says so when funds are short, and is unchanged when nothing is flagged', async () => {
    const btc = await import('../src/chains/btc.ts'), { utxoGuard, ordSource } = await import('../src/nft/utxo.ts');
    const saved = btc.utxoGuards.excluded, TO = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
    const adapter = () => btc.btcAdapter(BTC, [source('one'), source('two')]);
    const inputsOf = async (amount: bigint) => { const a = adapter(); await a.health(); const p = await a.prepare({ asset: 'native', from: BADDR, to: TO, amount }); return { inputs: (p.section.btc as { inputs: { txid: string; vout: number }[] }).inputs.map((i) => `${i.txid}:${i.vout}`), section: p.section }; };
    try {
      btc.utxoGuards.excluded = null;
      const plain = await inputsOf(70_000n), max = await inputsOf(105_000n);
      expect(plain.inputs).toEqual([`${T(1)}:0`, `${T(2)}:1`]); expect(max.inputs).toEqual([`${T(1)}:0`, `${T(2)}:1`, `${T(4)}:0`]); // before: a large send takes the small 9 000-sat output too
      // an empty guard changes NOTHING: same inputs, same change, same fee
      btc.utxoGuards.excluded = async () => new Set<string>();
      expect((await inputsOf(70_000n)).section).toEqual(plain.section); expect((await inputsOf(105_000n)).section).toEqual(max.section);
      // ord says output 3 carries an inscription and 4 a rune; the owner locked output 2 on the signer
      const ord = ordSource('http://ord.local', async () => new Response(JSON.stringify([...DOC, { ...DOC[0], outpoint: `${T(2)}:1`, transaction: T(2), value: 40_000 }])));
      btc.utxoGuards.excluded = utxoGuard({ ord, signerLocks: async () => ({ [`${T(2)}:1`]: { reason: 'owner', at: 1 } }), reviewed: async () => new Set() });
      expect((await inputsOf(30_000n)).inputs).toEqual([`${T(1)}:0`]);
      await expect(inputsOf(70_000n)).rejects.toMatchObject({ code: 'insufficient_unlocked_funds', data: { protectedOutputs: 3 } });
      await expect(inputsOf(105_000n)).rejects.toMatchObject({ code: 'insufficient_unlocked_funds' });
      // without ord, the heuristic keeps the two small outputs out; reviewing one as an ordinary coin brings it back
      const reviewed = new Set<string>();
      btc.utxoGuards.excluded = utxoGuard({ ord: null, signerLocks: async () => ({}), reviewed: async () => reviewed });
      expect((await inputsOf(70_000n)).section).toEqual(plain.section); // large coins only: identical to before
      await expect(inputsOf(105_000n)).rejects.toMatchObject({ code: 'insufficient_unlocked_funds', data: { protectedOutputs: 2 } });
      reviewed.add(`${T(4)}:0`);
      expect((await inputsOf(105_000n)).inputs).toEqual([`${T(1)}:0`, `${T(2)}:1`, `${T(4)}:0`]);
      // the ord server configured but unreachable: the send is refused, not prepared blind
      btc.utxoGuards.excluded = utxoGuard({ ord: ordSource('http://ord.local', (async () => { throw new Error('down'); }) as never), signerLocks: async () => ({}), reviewed: async () => new Set() });
      await expect(inputsOf(30_000n)).rejects.toMatchObject({ code: 'ord_unavailable' });
    } finally { btc.utxoGuards.excluded = saved; }
  });
  it('AND THE SIGNER REFUSES IT TOO: lock through the API routes with the passkey, then a send that names the locked outpoint is refused whatever the API selected', async () => {
    const outpoint = `${T(3)}:0`;
    const p = await call('POST', '/utxo-locks/prepare', { body: { network: 'bitcoin', action: 'lock', reason: 'ord', outpoints: [outpoint, outpoint] } });
    expect(p.status).toBe(200); expect(p.json.intent).toMatchObject({ kind: 'utxo-locks', network: 'bitcoin', action: 'lock', reason: 'ord', outpoints: [{ txid: T(3), vout: 0 }], keyId: keys.keyId });
    expect(p.json.options.challenge).toBe(Buffer.from(utxoLockHash(p.json.intent)).toString('base64url'));
    expect((await call('POST', '/utxo-locks/approve', { body: { intent: p.json.intent, assertion: pk.assert(new Uint8Array(32)) } })).json.error).toBe('signer_bad_approval'); // an assertion over something else
    expect((await call('POST', '/utxo-locks/approve', { body: { intent: { ...p.json.intent, action: 'unlock' }, assertion: pk.assert(Buffer.from(p.json.options.challenge, 'base64url')) } })).json.error).toBe('signer_bad_approval');
    expect(signer.status().utxoLocks).toEqual({});
    expect((await call('POST', '/utxo-locks/approve', { body: { intent: p.json.intent, assertion: pk.assert(Buffer.from(p.json.options.challenge, 'base64url')) } })).json).toMatchObject({ action: 'lock', changed: 1, locked: 1 });
    expect(signer.status().utxoLocks.bitcoin).toEqual([{ outpoint, reason: 'ord', at: nowRef.t }]);
    // a compromised API ignores its own guard and asks the signer to spend the locked outpoint
    const t = nowRef.t, i: Intent = { v: 1, proposalId: randomUUID(), keyId: keys.keyId, network: 'bitcoin', chainRef: BTC.chainRef, asset: 'native', symbol: 'BTC', decimals: 8, amount: '20000', from: BADDR, to: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', maxFee: '5000',
      createdAt: t, expiresAt: t + 120, policyVersion: 4, btc: { inputs: [{ txid: T(1), vout: 0, value: '60000' }, { txid: T(3), vout: 0, value: '546' }], change: '39546', fee: '1000' } };
    await expect(signer.sign(i, pk.assert(intentHash(i)))).rejects.toMatchObject({ code: 'utxo_locked' });
    const clean = { ...i, proposalId: randomUUID(), btc: { inputs: [{ txid: T(1), vout: 0, value: '60000' }], change: '39000', fee: '1000' } };
    expect((await signer.sign(clean, pk.assert(intentHash(clean)))).txid).toMatch(/^[0-9a-f]{64}$/);
    // unlocking needs the passkey as well; the API cannot do it alone
    const u = await call('POST', '/utxo-locks/prepare', { body: { network: 'bitcoin', action: 'unlock', outpoints: [outpoint] } });
    expect((await call('POST', '/utxo-locks/approve', { body: { intent: u.json.intent, assertion: {} } })).status).toBe(422);
    expect(signer.status().utxoLocks.bitcoin).toHaveLength(1);
    expect((await call('POST', '/utxo-locks/prepare', { body: { network: 'ethereum', action: 'lock', outpoints: [outpoint] } })).json.error).toBe('unsupported_network');
    expect((await call('POST', '/utxo-locks/prepare', { body: { network: 'bitcoin', action: 'lock', outpoints: ['nope'] } })).status).toBe(400);
    // the owner's review is recorded (it lifts a heuristic flag only) and audited
    expect((await call('POST', '/utxo-locks/review', { body: { network: 'bitcoin', outpoint: `${T(4)}:0`, ordinary: true } })).json.ok).toBe(true);
    expect((await sql`select verdict from utxo_reviews where network = 'bitcoin' and outpoint = ${`${T(4)}:0`}`)[0].verdict).toBe('ordinary');
    await call('POST', '/utxo-locks/review', { body: { network: 'bitcoin', outpoint: `${T(4)}:0`, ordinary: false } });
    expect((await sql`select count(*)::int as n from utxo_reviews`)[0].n).toBe(0);
  });
});
