/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/agents/withdrawals.ts
 * Module           : agents
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// V8 hardening — an agent-vault withdrawal is a TRACKED operation.
//
// Before: POST /agents/:id/withdraw signed, broadcast, and answered `{ ok: true, txid }` — it never looked at the receipt, and
// with broadcasting off it still said ok. Now each requested withdrawal is one row of `agent_withdrawals`:
//
//   requested ──► signed ──► broadcast ──► confirmed          (receipt status 1 AND the payment to the owner seen in it)
//       │            │            └──────► failed             (reverted, or the vault's nonce was used by another transaction)
//       │            └───────────────────► not_sent           (broadcasting is off on this server, or it could not be relayed in time)
//       └────────────────────────────────► failed             (the signer refused, or the process died while signing)
//
// ONE id per requested withdrawal: the row is inserted (state `requested`) BEFORE the signer is called, its id is the intent's
// proposalId (the signer's replay rule is per proposal id), and a partial unique index allows one open withdrawal per
// (agent, network, asset). A double tap — or a client retry with the same idempotency key — gets the SAME row back and
// nothing is signed twice. Nothing here changes what the signer verifies: the intent is built exactly as before.
import { randomUUID } from 'node:crypto';
import { decodeEventLog, erc20Abi, hexToBigInt, hexToNumber } from 'viem';
import { formatUnits, getAsset, getNetwork, IntentSchema, vaultKeyId } from '@spw/core';
import { adapterFor } from '../chains/index.ts';
import { rpcAny, rpcQuorum } from '../chains/rpc.ts';
import { config, UserError } from '../config.ts';
import { audit, sql } from '../db.ts';
import { signer } from '../signer-client.ts';

export type WithdrawalState = 'requested' | 'signed' | 'broadcast' | 'confirmed' | 'failed' | 'not_sent';
export const WITHDRAWAL_OPEN: WithdrawalState[] = ['requested', 'signed', 'broadcast'];
export interface WithdrawalRow {
  id: string; agent_id: string; network: string; asset: string; symbol: string; decimals: number; amount: string; from_addr: string; to_addr: string; nonce: number;
  state: WithdrawalState; raw: string | null; txid: string | null; error: string | null; idempotency_key: string | null; arrival: { verified: boolean; received: string | null; block: number | null } | null;
  created_at: Date; updated_at: Date; broadcast_at: Date | null; last_broadcast_at: Date | null; confirmed_at: Date | null;
}
// (table `agent_withdrawals`: db.ts, "v8 hardening")

export interface WithdrawalView { id: string; ok: boolean; state: WithdrawalState; network: string; asset: string; symbol: string; amount: string; txid: string | null; explorer: string | null; error: string | null;
  /** true only when the transaction is mined AND the payment to the owner's address was seen in it */
  arrived: boolean; createdAt: string; updatedAt: string; confirmedAt: string | null;
  /** this answer is an existing withdrawal (double tap / retry): nothing new was signed */
  duplicate?: boolean }
export function view(r: WithdrawalRow, duplicate = false): WithdrawalView {
  const n = getNetwork(r.network);
  // `ok` = it is on its way or done. A withdrawal that was not sent, or failed, is never ok.
  return { id: r.id, ok: r.state === 'broadcast' || r.state === 'confirmed', state: r.state, network: r.network, asset: r.asset, symbol: r.symbol, amount: formatUnits(BigInt(r.amount), r.decimals),
    txid: r.state === 'requested' ? null : r.txid, explorer: r.txid && (r.state === 'broadcast' || r.state === 'confirmed' || (r.state === 'failed' && r.broadcast_at)) ? n.explorerTx + r.txid : null, error: r.error,
    arrived: r.state === 'confirmed' && r.arrival?.verified === true, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(), confirmedAt: r.confirmed_at?.toISOString() ?? null, ...(duplicate ? { duplicate: true } : {}) };
}
const one = async (id: string): Promise<WithdrawalRow> => (await sql<WithdrawalRow[]>`select * from agent_withdrawals where id = ${id}`)[0]!;
async function setState(r: WithdrawalRow, state: WithdrawalState, patch: { error?: string | null; arrival?: WithdrawalRow['arrival'] } = {}): Promise<WithdrawalRow> {
  const [row] = await sql<WithdrawalRow[]>`update agent_withdrawals set state = ${state}, error = ${patch.error ?? null}, arrival = ${patch.arrival ? sql.json(patch.arrival as never) : null},
    broadcast_at = case when ${state} = 'broadcast' then coalesce(broadcast_at, now()) else broadcast_at end, last_broadcast_at = case when ${state} = 'broadcast' then now() else last_broadcast_at end,
    confirmed_at = case when ${state} = 'confirmed' then now() else confirmed_at end, updated_at = now()
    where id = ${r.id} and state = ${r.state} returning *`;
  if (!row) return one(r.id); // another pass moved it first
  if (state === 'confirmed' || state === 'failed' || state === 'not_sent')
    await audit(`agent.withdraw_${state}`, state === 'confirmed' ? 'chain' : 'engine', { agent: r.agent_id, id: r.id, network: r.network, symbol: r.symbol, amount: r.amount, txid: r.txid, ...(patch.error ? { reason: patch.error } : {}) });
  return row;
}

interface AgentLike { id: string; state: string; network: string; vault_index: number; vault_address: string }
/** Request a withdrawal of the whole balance of one asset to the owner's own address. Idempotent (see the header). */
export async function requestWithdrawal(a: AgentLike, b: { asset: string; network?: string; idempotencyKey?: string }): Promise<WithdrawalView> {
  // any EVM network: funds sent to the vault's address on another network than the agent's can always come back
  const n = getNetwork(b.network ?? a.network);
  if (n.family !== 'evm') throw new UserError('unsupported_network', 'agent wallets exist on EVM networks only', 422);
  if (a.state === 'LIVE' && n.id === a.network) throw new UserError('bad_state', 'revoke the mandate before withdrawing', 409);
  const asset = getAsset(n.id, b.asset);
  // a retry with the same key, or a second tap while one is in flight: the same operation, nothing new is signed
  if (b.idempotencyKey) { const [same] = await sql<WithdrawalRow[]>`select * from agent_withdrawals where agent_id = ${a.id} and idempotency_key = ${b.idempotencyKey}`; if (same) return view(same, true); }
  const [open] = await sql<WithdrawalRow[]>`select * from agent_withdrawals where agent_id = ${a.id} and network = ${n.id} and asset = ${asset.id} and state in ${sql(WITHDRAWAL_OPEN)}`;
  if (open) return view(open, true);

  const st = await signer.status(true), owner = st.addresses[n.id]!;
  const bal = await adapterFor(n.id).balances(a.vault_address);
  const nonce = hexToNumber(await rpcQuorum<`0x${string}`>(n.rpc, 'eth_getTransactionCount', [a.vault_address, 'pending']));
  const block = await rpcAny<{ baseFeePerGas?: `0x${string}` }>(n.rpc, 'eth_getBlockByNumber', ['latest', false]);
  const baseFee = hexToBigInt(block.baseFeePerGas ?? '0x0'); let tip = 1_000_000n; try { tip = hexToBigInt(await rpcAny<`0x${string}`>(n.rpc, 'eth_maxPriorityFeePerGas', [])); } catch { /* floor */ }
  const maxFeePerGas = baseFee * 2n + tip, gas = asset.id === 'native' ? 21_000n : 90_000n, fee = gas * maxFeePerGas;
  const amount = asset.id === 'native' ? (bal.native ?? 0n) - fee : (bal[asset.id] ?? 0n);
  if (amount <= 0n) throw new UserError('insufficient_funds', `nothing to withdraw in ${asset.symbol}`);
  if (asset.id !== 'native' && (bal.native ?? 0n) < fee) throw new UserError('insufficient_gas', `the vault needs a little ${n.native.symbol} to pay the network fee`);
  const now = Math.floor(Date.now() / 1000), id = randomUUID();
  const intent = IntentSchema.parse({ v: 1, proposalId: id, keyId: vaultKeyId(st.keyId, a.vault_index), network: n.id, chainRef: n.chainRef, asset: asset.id, symbol: asset.symbol, decimals: asset.decimals, amount: amount.toString(),
    from: a.vault_address, to: owner, maxFee: fee.toString(), createdAt: now, expiresAt: now + 120, policyVersion: st.policy.version,
    evm: { nonce, gasLimit: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: tip.toString() } });

  // the row exists before anything is signed; the partial unique index makes a concurrent second request lose here
  const ins = await sql<WithdrawalRow[]>`insert into agent_withdrawals (id, agent_id, network, asset, symbol, decimals, amount, from_addr, to_addr, nonce, state, idempotency_key)
    values (${id}, ${a.id}, ${n.id}, ${asset.id}, ${asset.symbol}, ${asset.decimals}, ${amount.toString()}, ${a.vault_address}, ${owner}, ${nonce}, 'requested', ${b.idempotencyKey ?? null})
    on conflict do nothing returning *`;
  if (!ins.length) {
    const [other] = await sql<WithdrawalRow[]>`select * from agent_withdrawals where agent_id = ${a.id} and ((network = ${n.id} and asset = ${asset.id} and state in ${sql(WITHDRAWAL_OPEN)}) or idempotency_key = ${b.idempotencyKey ?? ''}) order by created_at desc limit 1`;
    if (other) return view(other, true);
    throw new UserError('busy', 'a withdrawal of this asset is already being prepared', 409);
  }
  let row = ins[0]!, signed;
  try { signed = await signer.vaultReturn(a.vault_index, intent); } // needs no mandate: the signer only ever pays the owner's own address
  catch (e) { await setState(row, 'failed', { error: `refused by the signer: ${(e as Error).message.slice(0, 200)}` }); throw e; }
  row = (await sql<WithdrawalRow[]>`update agent_withdrawals set state = 'signed', raw = ${signed.raw}, txid = ${signed.txid}, updated_at = now() where id = ${id} and state = 'requested' returning *`)[0] ?? await one(id);
  await audit('agent.withdraw', 'owner', { agent: a.id, id, network: n.id, symbol: asset.symbol, amount: amount.toString(), txid: signed.txid });
  return view(await advanceWithdrawal(row));
}

type Receipt = { status: `0x${string}`; blockNumber: `0x${string}`; logs: { address: string; topics: [`0x${string}`, ...`0x${string}`[]]; data: `0x${string}` }[] } | null;
const lower = (s: string): string => s.toLowerCase();
/** Did the mined transaction pay the owner? Token: a Transfer(vault → owner, amount) log of the token. Native: the
 *  transaction itself (to = owner, value = amount). */
async function arrival(r: WithdrawalRow, rc: NonNullable<Receipt>): Promise<NonNullable<WithdrawalRow['arrival']>> {
  const n = getNetwork(r.network), block = hexToNumber(rc.blockNumber);
  if (r.asset === 'native') {
    const tx = await rpcAny<{ to: string | null; value: `0x${string}` } | null>(n.rpc, 'eth_getTransactionByHash', [r.txid]).catch(() => null);
    const ok = !!tx && !!tx.to && lower(tx.to) === lower(r.to_addr) && hexToBigInt(tx.value) === BigInt(r.amount);
    return { verified: ok, received: ok ? r.amount : null, block };
  }
  for (const l of rc.logs) { if (lower(l.address) !== lower(r.asset)) continue;
    try { const ev = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics }) as unknown as { eventName: string; args: { from: string; to: string; value: bigint } };
      if (ev.eventName === 'Transfer' && lower(ev.args.from) === lower(r.from_addr) && lower(ev.args.to) === lower(r.to_addr)) return { verified: ev.args.value === BigInt(r.amount), received: ev.args.value.toString(), block }; } catch { /* another event */ } }
  return { verified: false, received: null, block };
}

/** Move one withdrawal forward by at most one step. Never throws for a network reason: it is tried again at the next pass. */
export async function advanceWithdrawal(r: WithdrawalRow, now = Date.now()): Promise<WithdrawalRow> {
  const n = getNetwork(r.network), age = now - r.created_at.getTime();
  if (r.state === 'requested') return age > 2 * 60_000 ? setState(r, 'failed', { error: 'interrupted during signing; nothing was sent' }) : r; // the signer's replay rule: it cannot be signed again
  if (r.state === 'signed') {
    if (!r.raw || !r.txid) return setState(r, 'failed', { error: 'incomplete withdrawal; nothing was sent' });
    if (!config.broadcast) return setState(r, 'not_sent', { error: 'broadcast is disabled on this server; nothing was sent' });
    if (age > 10 * 60_000) return setState(r, 'not_sent', { error: 'the transaction could not be relayed in time; nothing was sent' });
    try { await adapterFor(n.id).broadcast(r.raw); } catch (e) {
      // "already known" / "nonce too low" may mean an earlier attempt did reach the network: the receipt decides
      const rc = await rpcAny<Receipt>(n.rpc, 'eth_getTransactionReceipt', [r.txid]).catch(() => undefined);
      if (!rc && !/already known|known transaction|already imported/i.test((e as Error).message)) { await sql`update agent_withdrawals set error = ${`not relayed yet: ${(e as Error).message.slice(0, 160)}`}, updated_at = now() where id = ${r.id} and state = 'signed'`; return one(r.id); }
    }
    return setState(r, 'broadcast');
  }
  if (r.state === 'broadcast') {
    const rc = await rpcAny<Receipt>(n.rpc, 'eth_getTransactionReceipt', [r.txid]).catch(() => undefined);
    if (rc === undefined) return r;                                        // the node did not answer: nothing is concluded
    if (rc) {
      if (hexToNumber(rc.status) !== 1) return setState(r, 'failed', { error: 'the transaction reverted on-chain; only the network fee was spent' });
      const arr = await arrival(r, rc);
      return setState(r, 'confirmed', { arrival: arr, error: arr.verified ? null : 'mined, but the payment to your address was not found in the transaction: check the explorer' });
    }
    // not mined yet. If the vault's nonce moved past ours without this transaction, it can never be mined.
    const used = await rpcQuorum<`0x${string}`>(n.rpc, 'eth_getTransactionCount', [r.from_addr, 'latest']).then(hexToNumber, () => null);
    if (used !== null && used > r.nonce) {
      const again = await rpcAny<Receipt>(n.rpc, 'eth_getTransactionReceipt', [r.txid]).catch(() => undefined);
      if (again === null) return setState(r, 'failed', { error: 'another transaction of the vault used the same nonce; this withdrawal was not executed' });
      return r;
    }
    if (r.raw && now - (r.last_broadcast_at?.getTime() ?? 0) > 45_000) { await adapterFor(n.id).broadcast(r.raw).catch(() => {}); await sql`update agent_withdrawals set last_broadcast_at = now() where id = ${r.id}`; }
  }
  return r;
}

/** Worker step: every open withdrawal, one step each. Errors never cross withdrawals. */
export async function advanceWithdrawals(now = Date.now()): Promise<void> {
  for (const r of await sql<WithdrawalRow[]>`select * from agent_withdrawals where state in ${sql(WITHDRAWAL_OPEN)} order by created_at`) {
    try { await advanceWithdrawal(r, now); } catch (e) { console.log(`[worker] withdrawal ${r.id}: ${(e as Error).message.slice(0, 160)}`); }
  }
}
export const listWithdrawals = async (agentId: string, limit = 20): Promise<WithdrawalView[]> =>
  (await sql<WithdrawalRow[]>`select * from agent_withdrawals where agent_id = ${agentId} order by created_at desc limit ${limit}`).map((r) => view(r));
export const getWithdrawal = async (agentId: string, id: string): Promise<WithdrawalView | null> => { const [r] = await sql<WithdrawalRow[]>`select * from agent_withdrawals where id = ${id} and agent_id = ${agentId}`; return r ? view(r) : null; };
