/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/isolated-signer/src/nft.ts
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

// NFT delivery 2 — what the signer does for NFTs. Three routes, each needing the owner's passkey over the canonical object:
//
//   POST /nft/sign     ONE NFT transfer. The transaction is BUILT here from the intent's semantic fields (packages/core
//                      nft-evm.ts / nft-sol.ts); the request carries no calldata, no instruction, no helper data.
//   POST /utxo/locks   lock or unlock outpoints of a Bitcoin-style network. An ordinary send (`POST /sign`) that names a locked
//                      outpoint among its inputs is refused (signer.ts) — the inscription safety of the BTC path.
//   POST /nft/allow    add or remove a destination of the NFT allow-list (used when the policy's `nft.allowlistOnly` is true).
//
// What this signer verifies ITSELF for a transfer (it makes no chain read): the key, the network and chain id, that `from` is
// its own address, that the destination is not itself, the single-use proposal id, the NFT policy (halt, versions, approval
// window, per-network standard switch, quantity, daily count, fee ceiling, compute budget, allow-list), then the transaction
// it built — re-read by an independent decoder before the passkey is looked at — and the passkey assertion over the intent
// hash. What it CANNOT verify: that the wallet owns the token, and that the contract really is of the named standard. Those
// are established by the API on two endpoints. A wrong claim cannot move another asset or grant an approval: the transaction
// is the safe-transfer call of the named token and nothing else, so it reverts or moves exactly what the intent names.
import { base58 } from '@scure/base';
import { keccak256, type TransactionSerializableEIP1559 } from 'viem';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { buildNftEvmTx, buildNftSolMessage, checkNftPolicy, effectiveNftPolicy, getNetwork, NftAllowIntentSchema, nftAllowHash, NftIntentSchema, nftIntentHash, NftRefusal, nftSolWire, normalizeAddress, outpointKey, UtxoLockIntentSchema, utxoLockHash,
  verifyNftEvmTx, verifyNftSolMessage, type NftIntent, type NftPolicy } from '@spw/core';
import type { Keys } from './keys.ts';
import type { Store, StoredCredential } from './store.ts';

/**
 * `signEvm` / `signSol` are the wallet key's two signature primitives, handed over by signer.ts: this module never holds a
 * private key. They are called exactly once per transfer, after every check and after the passkey was verified.
 */
export interface NftCtx { keys: Pick<Keys, 'keyId' | 'addresses'>; store: Store; now: () => number; verify: (a: AuthenticationResponseJSON, challenge: Uint8Array) => Promise<StoredCredential>; fail: (code: string, msg: string) => Error;
  signEvm: (tx: TransactionSerializableEIP1559) => Promise<string>; signSol: (message: Uint8Array) => Uint8Array }
export interface NftSignResult { raw: string; txid: string; hash: string }
/** outpoint → why and when it was locked (unix s) */
export interface StoredUtxoLock { reason: 'owner' | 'ord' | 'heuristic'; at: number }
/** the most outpoints one network's lock list holds, and the most destinations the allow-list holds */
export const UTXO_LOCKS_MAX = 2000, NFT_ALLOW_MAX = 500;

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const day = (now: number) => new Date(now * 1000).toISOString().slice(0, 10);
const errCode = (e: unknown, fallback: string) => (e instanceof NftRefusal ? e.code : (e as { code?: string }).code ?? fallback);

export function nftPolicyOf(store: Store): NftPolicy { return effectiveNftPolicy(store.policy.nft); }
export function nftStatus(c: NftCtx) {
  const s = c.store.state;
  return { policy: nftPolicyOf(c.store), signedToday: s.nftDaily?.[day(c.now())] ?? 0, allow: Object.entries(s.nftAllow ?? {}).map(([k, v]) => ({ network: k.slice(0, k.indexOf(':')), address: k.slice(k.indexOf(':') + 1), approvedAt: v.at })) };
}
export const utxoLockStatus = (c: NftCtx) => Object.fromEntries(Object.entries(c.store.state.utxoLocks ?? {}).map(([net, m]) => [net, Object.entries(m).map(([outpoint, v]) => ({ outpoint, reason: v.reason, at: v.at }))]));

/** Sign one NFT transfer. Every refusal has a stable code and is journaled; nothing is recorded as spent on a refusal. */
export async function nftSign(c: NftCtx, rawIntent: unknown, assertion?: AuthenticationResponseJSON): Promise<NftSignResult> {
  const st = c.store, now = c.now();
  const parsed = NftIntentSchema.safeParse(rawIntent);
  if (!parsed.success) throw c.fail('bad_request', 'malformed NFT intent'); // unknown fields (calldata, instructions, data, aux…) end here
  const i: NftIntent = parsed.data;
  let hash: Uint8Array;
  try { hash = nftIntentHash(i); } catch { throw c.fail('bad_request', 'malformed NFT intent'); }
  const deny = (code: string, msg: string): never => {
    st.log('nft.sign.denied', { proposalId: i.proposalId, hash: hex(hash), code, msg });
    st.save();
    throw c.fail(code, msg);
  };
  if (i.keyId !== c.keys.keyId) deny('wrong_key', 'intent targets another key');
  let net;
  try { net = getNetwork(i.network); } catch { return deny('wrong_chain', 'unknown network'); }
  if (i.chainRef !== net.chainRef) deny('wrong_chain', 'chain identity mismatch');
  if (net.family !== 'evm' && net.family !== 'sol') deny('nft_unsupported_family', 'NFT transfers are built for EVM networks and Solana only');
  const own = c.keys.addresses[net.id];
  if (!own) deny('wrong_chain', 'no key for this network');
  if (i.from !== own) deny('wrong_source', 'source address is not controlled by this signer');
  if (i.to === own) deny('self_send', 'destination equals source');
  if (st.state.used[i.proposalId] !== undefined) deny('replay', 'proposal already signed');

  const today = day(now);
  try { checkNftPolicy({ policy: st.policy, signedToday: st.state.nftDaily?.[today] ?? 0, nowSec: now, halted: st.state.halted, allowed: new Set(Object.keys(st.state.nftAllow ?? {})) }, i); }
  catch (e) { return deny(errCode(e, 'policy'), (e as Error).message); }

  // Build the transaction from the intent alone, then read it back with the independent decoder: both must hold before the
  // approval is even looked at.
  let build: () => Promise<{ raw: string; txid: string }>;
  try {
    if (net.family === 'evm') {
      const tx = buildNftEvmTx(i);
      verifyNftEvmTx(tx as unknown as Record<string, unknown>, i);
      build = async () => { const raw = await c.signEvm(tx); return { raw, txid: keccak256(raw as `0x${string}`) }; };
    } else {
      const msg = buildNftSolMessage(i);
      verifyNftSolMessage(msg, i);
      build = async () => { const sig = c.signSol(msg); return { raw: Buffer.from(nftSolWire(sig, msg)).toString('base64'), txid: base58.encode(sig) }; };
    }
  } catch (e) { return deny(errCode(e, 'nft_unsupported'), (e as Error).message); }

  // The passkey assertion's challenge IS the NFT intent hash: the approval is bound to these exact fields.
  if (!assertion) deny('bad_approval', 'an NFT transfer needs the owner\'s passkey');
  try { await c.verify(assertion!, hash); } catch (e) { deny(errCode(e, 'bad_approval'), (e as Error).message); }

  // Replay marker and daily count are persisted BEFORE a signature is released.
  st.state.used[i.proposalId] = i.expiresAt;
  (st.state.nftDaily ??= {})[today] = (st.state.nftDaily[today] ?? 0) + 1;
  st.prune(now);
  const out = await build!();
  st.log('nft.sign.ok', { proposalId: i.proposalId, hash: hex(hash), network: i.network, standard: i.standard, asset: i.asset, ...(i.tokenId !== undefined ? { tokenId: i.tokenId } : {}), quantity: i.quantity, program: i.program, to: i.to, txid: out.txid,
    ...(i.sol?.ruleSet ? { ruleSet: i.sol.ruleSet } : {}), ...(i.sol?.collection ? { collection: i.sol.collection } : {}) });
  st.save();
  return { ...out, hash: hex(hash) };
}

/** Shared checks of the two list intents: key, single use, policy version, approval window, passkey. */
async function listApproval(c: NftCtx, kind: string, r: { requestId: string; keyId: string; createdAt: number; expiresAt: number; policyVersion: number }, hash: Uint8Array, assertion: AuthenticationResponseJSON | undefined, pre: (deny: (code: string, msg: string) => never) => void): Promise<void> {
  const st = c.store, now = c.now();
  const deny = (code: string, msg: string): never => { st.log(`${kind}.denied`, { requestId: r.requestId, hash: hex(hash), code, msg }); st.save(); throw c.fail(code, msg); };
  if (r.keyId !== c.keys.keyId) deny('wrong_key', 'request targets another key');
  if (st.state.used[r.requestId] !== undefined) deny('replay', 'request already applied');
  if (r.policyVersion !== st.policy.version) deny('policy', 'policy version changed');
  if (r.expiresAt <= now) deny('policy', 'approval window expired');
  if (r.createdAt > now + 60 || r.expiresAt - r.createdAt > st.policy.maxApprovalTtlSec) deny('policy', 'validity window is not acceptable');
  pre(deny);
  if (!assertion) deny('bad_approval', 'this change needs the owner\'s passkey');
  try { await c.verify(assertion!, hash); } catch (e) { deny(errCode(e, 'bad_approval'), (e as Error).message); }
  st.state.used[r.requestId] = r.expiresAt;
}

/**
 * Lock or unlock outpoints. BOTH directions need the passkey: an API that could unlock would defeat the list, and one that
 * could lock at will could freeze the wallet's coins. Locking is allowed under the emergency halt (it only restricts);
 * unlocking is not (it widens what can be spent).
 */
export async function utxoLocksApply(c: NftCtx, raw: unknown, assertion?: AuthenticationResponseJSON): Promise<{ network: string; action: string; changed: number; locked: number; hash: string }> {
  const st = c.store, now = c.now();
  const parsed = UtxoLockIntentSchema.safeParse(raw);
  if (!parsed.success) throw c.fail('bad_request', 'malformed lock request');
  const r = parsed.data;
  let hash: Uint8Array;
  try { hash = utxoLockHash(r); } catch { throw c.fail('bad_request', 'malformed lock request'); }
  await listApproval(c, 'utxo.locks', r, hash, assertion, (deny) => {
    let net; try { net = getNetwork(r.network); } catch { return deny('wrong_chain', 'unknown network'); }
    if (net.family !== 'btc') deny('wrong_chain', 'outpoint locks exist on Bitcoin-style networks only');
    if (r.action === 'unlock' && st.state.halted) deny('policy', 'emergency halt is active: nothing is unlocked');
    const have = Object.keys(st.state.utxoLocks?.[r.network] ?? {}).length;
    if (r.action === 'lock' && have + r.outpoints.length > UTXO_LOCKS_MAX) deny('policy', 'too many locked outpoints on this network');
  });
  const list = ((st.state.utxoLocks ??= {})[r.network] ??= {});
  let changed = 0;
  for (const o of r.outpoints) {
    const k = outpointKey(o);
    if (r.action === 'lock') { if (!list[k]) changed += 1; list[k] = { reason: r.reason, at: now }; }
    else if (list[k]) { delete list[k]; changed += 1; }
  }
  st.prune(now);
  st.log('utxo.locks.ok', { requestId: r.requestId, hash: hex(hash), network: r.network, action: r.action, reason: r.reason, outpoints: r.outpoints.map(outpointKey), changed, locked: Object.keys(list).length });
  st.save();
  return { network: r.network, action: r.action, changed, locked: Object.keys(list).length, hash: hex(hash) };
}

/** Add or remove a destination of the NFT allow-list. Passkey each time; adding is refused under the emergency halt. */
export async function nftAllowApply(c: NftCtx, raw: unknown, assertion?: AuthenticationResponseJSON): Promise<{ network: string; address: string; action: string; entries: number; hash: string }> {
  const st = c.store, now = c.now();
  const parsed = NftAllowIntentSchema.safeParse(raw);
  if (!parsed.success) throw c.fail('bad_request', 'malformed allow-list request');
  const r = parsed.data, hash = nftAllowHash(r), key = `${r.network}:${r.address}`;
  await listApproval(c, 'nft.allow', r, hash, assertion, (deny) => {
    let net; try { net = getNetwork(r.network); } catch { return deny('wrong_chain', 'unknown network'); }
    if (net.family !== 'evm' && net.family !== 'sol') deny('wrong_chain', 'the NFT allow-list exists on EVM networks and Solana only');
    try { if (normalizeAddress(r.network, r.address) !== r.address) throw new Error('not normalized'); } catch (e) { deny('bad_request', `invalid address: ${(e as Error).message}`); }
    if (r.address === c.keys.addresses[net.id]) deny('self_send', 'the wallet itself is never an NFT destination');
    if (r.action === 'add' && st.state.halted) deny('policy', 'emergency halt is active: no destination is added');
    if (r.action === 'add' && Object.keys(st.state.nftAllow ?? {}).length >= NFT_ALLOW_MAX && !st.state.nftAllow?.[key]) deny('policy', 'the allow-list is full');
  });
  const list = (st.state.nftAllow ??= {});
  if (r.action === 'add') list[key] = { at: now }; else delete list[key];
  st.prune(now);
  st.log('nft.allow.ok', { requestId: r.requestId, hash: hex(hash), network: r.network, address: r.address, action: r.action, entries: Object.keys(list).length });
  st.save();
  return { network: r.network, address: r.address, action: r.action, entries: Object.keys(list).length, hash: hex(hash) };
}

/** The lock an ordinary send would violate, if any: the first input of `inputs` that is on the lock list of `network`. */
export function lockedInput(store: Store, network: string, inputs: { txid: string; vout: number }[]): string | null {
  const list = store.state.utxoLocks?.[network];
  if (!list) return null;
  for (const o of inputs) if (list[outpointKey(o)]) return outpointKey(o);
  return null;
}
