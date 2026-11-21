/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/nft/utxo.ts
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

// NFT delivery 2 — Bitcoin inscription safety (NO Ordinals transfer is built: Bitcoin NFTs stay "not supported").
//
// The audit of delivery 1 found that an ordinary BTC send selects coins largest-first with no notion of inscriptions. What
// this module does about it — three layers, the strongest first:
//
//   1. THE SIGNER'S LOCK LIST (authoritative). Outpoints the owner locked with the passkey (`POST /utxo/locks` on the signer).
//      The signer refuses any send or cross-chain swap that names one among its inputs; the API cannot unlock.
//   2. AN ORD SERVER, when `NFT_ORDINALS_API_URL` is set: a self-hosted `ord` (docs.ordinals.com/guides/api.html, read
//      2026-11-17) — `GET /outputs/<address>?type=any` with `Accept: application/json` answers the address's outputs, each with
//      `inscriptions` (ids), `runes` (map), `indexed`, `spent`, `value`. An output that carries an inscription or a rune, or
//      that ord has not indexed, or that ord does not list at all, is excluded from coin selection — automatically, API-side —
//      and proposed to the owner for a signer lock. With the variable set and the server unreachable, Bitcoin sends are refused.
//   3. WITHOUT an ord server: a HEURISTIC, labelled as such — outputs of at most 10 000 sat, and outputs created by a
//      transaction whose witness carries an ordinals-style envelope (OP_FALSE OP_IF "ord"), are flagged "possibly an
//      inscription" and excluded from automatic selection until the owner declares them ordinary coins (per output) or locks
//      them. It is NOT a detection: an inscription on a larger output with no envelope in its own creating transaction (one
//      that was moved since) is not seen. The Receive screen keeps saying so.
//
// The guard below is installed into the coin selection of every Bitcoin-style adapter (chains/btc.ts `utxoGuards`).
import type { Utxo } from '../chains/btc.ts';
import { UserError } from '../config.ts';

export type HttpFn = (url: string, init?: RequestInit) => Promise<Response>;
export interface OrdOutput { outpoint: string; value: number; inscriptions: string[]; runes: string[]; indexed: boolean; spent: boolean }
export interface OrdSource { host: string; outputs(address: string): Promise<OrdOutput[]> }
const OUTPOINT = /^[0-9a-f]{64}:\d{1,10}$/;

/** Adapter of a self-hosted ord server, against the documented JSON of `GET /outputs/<ADDRESS>?type=any`. Anything else is a bad answer. */
export function ordSource(baseUrl: string, http: HttpFn): OrdSource {
  const base = baseUrl.replace(/\/+$/, ''), host = new URL(base).host;
  return { host, async outputs(address) {
    let r: Response;
    try { r = await http(`${base}/outputs/${encodeURIComponent(address)}?type=any`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000), redirect: 'error' }); }
    catch { throw new UserError('ord_unavailable', 'the ord server is unreachable: Bitcoin outputs cannot be classified', 503); }
    if (!r.ok) throw new UserError('ord_unavailable', `the ord server answered ${r.status}: Bitcoin outputs cannot be classified`, 503);
    let j: unknown; try { j = await r.json(); } catch { throw new UserError('ord_bad_answer', 'the ord server did not answer JSON', 502); }
    if (!Array.isArray(j)) throw new UserError('ord_bad_answer', 'the ord server did not answer a list of outputs', 502);
    return j.map((o: Record<string, unknown>): OrdOutput => {
      const runes = o.runes === null || o.runes === undefined ? [] : Array.isArray(o.runes) ? o.runes.map((x) => String(Array.isArray(x) ? x[0] : x)) : typeof o.runes === 'object' ? Object.keys(o.runes as object) : null;
      const ins = o.inscriptions === null || o.inscriptions === undefined ? [] : Array.isArray(o.inscriptions) ? o.inscriptions.map(String) : null;
      if (typeof o.outpoint !== 'string' || !OUTPOINT.test(o.outpoint) || !Number.isSafeInteger(o.value) || runes === null || ins === null || typeof o.indexed !== 'boolean' || typeof o.spent !== 'boolean')
        throw new UserError('ord_bad_answer', 'the ord server answered an output in an unexpected shape', 502);
      return { outpoint: o.outpoint, value: o.value as number, inscriptions: ins.slice(0, 50), runes: runes.slice(0, 50), indexed: o.indexed, spent: o.spent };
    });
  } };
}

/** Outputs of at most this many satoshis are flagged by the heuristic (inscriptions are usually sent in 330 – 10 000 sat outputs). */
export const HEURISTIC_MAX_SATS = 10_000;
/** `OP_FALSE OP_IF OP_PUSHBYTES_3 "ord"` — the start of an inscription envelope in a witness script */
const ENVELOPE = '0063036f7264';
export type FlagReason = 'signer_locked' | 'ord_inscription' | 'ord_rune' | 'ord_unindexed' | 'ord_unlisted' | 'heuristic_small' | 'heuristic_envelope';
export interface UtxoRow { txid: string; vout: number; outpoint: string; value: number; signerLock: { reason: string; at: number } | null; ord: { inscriptions: string[]; runes: string[] } | null;
  /** every reason this output is kept out of coin selection; empty = spendable by an ordinary send */ excludedBy: FlagReason[];
  /** true when the ONLY reasons are heuristic and the owner declared the output an ordinary coin */ reviewed: boolean; spendable: boolean }

export interface UtxoDeps { ord: OrdSource | null; signerLocks: (network: string) => Promise<Record<string, { reason: string; at: number }>>; reviewed: (network: string) => Promise<ReadonlySet<string>>; }
const envelopeCache = new Map<string, boolean>();

/** Classify the wallet's coins on one network. `rawTx` is only used by the heuristic (Bitcoin, no ord source). */
export async function classifyUtxos(d: UtxoDeps, network: string, address: string, utxos: Utxo[], rawTx: ((txid: string) => Promise<string>) | null): Promise<{ rows: UtxoRow[]; mode: 'ord' | 'heuristic' | 'locks_only'; ordHost: string | null }> {
  const locks = await d.signerLocks(network), key = (u: Utxo) => `${u.txid}:${u.vout}`;
  const bitcoin = network === 'bitcoin';
  let ord: Map<string, OrdOutput> | null = null;
  if (bitcoin && d.ord) ord = new Map((await d.ord.outputs(address)).map((o) => [o.outpoint, o])); // throws when unreachable: fail closed
  const reviewed = bitcoin && !d.ord ? await d.reviewed(network) : new Set<string>();
  const rows: UtxoRow[] = [];
  for (const u of utxos) {
    const k = key(u), by: FlagReason[] = [], lock = locks[k] ?? null;
    if (lock) by.push('signer_locked');
    let ordInfo: UtxoRow['ord'] = null;
    if (ord) {
      const o = ord.get(k);
      if (!o) by.push('ord_unlisted'); // the indexers see a coin ord does not list (ord is behind, or runs without an address index): unknown is not "empty"
      else { ordInfo = { inscriptions: o.inscriptions, runes: o.runes }; if (o.inscriptions.length) by.push('ord_inscription'); if (o.runes.length) by.push('ord_rune'); if (!o.indexed) by.push('ord_unindexed'); }
    } else if (bitcoin) {
      if (u.value <= HEURISTIC_MAX_SATS) by.push('heuristic_small');
      if (rawTx && utxos.length <= 60) {
        let env = envelopeCache.get(u.txid);
        if (env === undefined) { try { env = (await rawTx(u.txid)).toLowerCase().includes(ENVELOPE); envelopeCache.set(u.txid, env); if (envelopeCache.size > 5000) envelopeCache.clear(); } catch { env = false; } }
        if (env) by.push('heuristic_envelope');
      }
    }
    const onlyHeuristic = by.length > 0 && by.every((r) => r.startsWith('heuristic_')), isReviewed = onlyHeuristic && reviewed.has(k);
    rows.push({ txid: u.txid, vout: u.vout, outpoint: k, value: u.value, signerLock: lock, ord: ordInfo, excludedBy: by, reviewed: isReviewed, spendable: by.length === 0 || isReviewed });
  }
  return { rows, mode: ord ? 'ord' : bitcoin ? 'heuristic' : 'locks_only', ordHost: ord ? d.ord!.host : null };
}

/** The guard installed in the coin selection: the outpoints an ordinary send must never choose. */
export function utxoGuard(d: UtxoDeps): (network: string, address: string, utxos: Utxo[], rawTx: (txid: string) => Promise<string>) => Promise<ReadonlySet<string>> {
  return async (network, address, utxos, rawTx) => {
    const { rows } = await classifyUtxos(d, network, address, utxos, rawTx);
    return new Set(rows.filter((r) => !r.spendable).map((r) => r.outpoint));
  };
}
