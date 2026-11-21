/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/derivatives/worker.ts
 * Module           : derivatives
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
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

// Paper worker: every few seconds, for each paper account with a position or a resting order, feed the latest ticker and book
// of its instruments to the paper engine, apply funding at the venue's funding times with the venue's published rate, record
// margin warnings, simulated liquidations and loss-limit breaches, and snapshot equity once a minute.
//
// The step keeps nothing in memory between runs: every decision is made from the database row of the account (engine state,
// policy, funding cursors) inside one transaction per account. Running it twice on the same inputs, or restarting the process
// between two steps, changes nothing — a book already seen is ignored by the engine, a funding time already applied is behind
// the cursor, fills and funding payments are keyed by their engine ids.
import type { DecStr, Instrument } from '@spw/derivatives';
import { loop } from '../worker.ts';
import { derivatives, type Derivatives } from './index.ts';
import type { MarketFeed, PaperService } from './paper.ts';

export const PAPER_STEP_MS = 3_000;
/** a ticker older than this is not fed to an account (the step waits for fresh data instead) */
export const FEED_MAX_AGE_MS = 15_000;
/** a published funding rate is matched to a funding time when it is stamped within this distance of it */
const FUNDING_MATCH_MS = 5 * 60_000;

export interface StepSummary { accounts: number; fed: number; fills: number; funding: number; liquidations: number; halts: number; errors: string[] }

/** rates the venue applied since `cursor`, keyed by the funding time they belong to */
async function fundingRates(svc: PaperService, inst: Instrument, cursor: number): Promise<Map<number, DecStr> | null> {
  const iv = inst.fundingIntervalSec * 1000;
  try {
    const out = new Map<number, DecStr>();
    for (const r of await svc.data.fundingSince(inst, cursor + 1)) {
      const t = Math.round(r.ts / iv) * iv;
      if (Math.abs(r.ts - t) <= FUNDING_MATCH_MS && t > cursor) out.set(t, r.rate);
    }
    return out;
  } catch { return null; }                                           // unreadable now: funding waits, nothing is skipped
}

export async function paperStep(svc: PaperService, now: number = svc.now()): Promise<StepSummary> {
  const summary: StepSummary = { accounts: 0, fed: 0, fills: 0, funding: 0, liquidations: 0, halts: 0, errors: [] };
  const accounts = await svc.active();
  if (accounts.length === 0) return summary;                         // no exposure anywhere: no venue is called
  summary.accounts = accounts.length;
  const note = (what: string, e: unknown): void => { summary.errors.push(`${what}: ${e instanceof Error ? e.message.slice(0, 160) : 'error'}`); };

  // market data once per instrument, whatever the number of accounts on it
  const live = new Map<string, Omit<MarketFeed, 'fundingRates'>>();
  await Promise.all([...new Set(accounts.flatMap((a) => a.instruments))].map(async (id) => {
    try {
      const inst = await svc.data.instrument(id);
      const [ticker, book] = await Promise.all([svc.data.ticker(inst), svc.data.book(inst)]);
      if (now - ticker.ts > FEED_MAX_AGE_MS) throw new Error(`ticker is ${Math.round((now - ticker.ts) / 1000)} s old`);
      live.set(id, { inst, ticker, book });
    } catch (e) { note(id, e); }
  }));

  const rates = new Map<string, Promise<Map<number, DecStr> | null>>();
  for (const a of accounts) {
    const feeds: MarketFeed[] = [];
    for (const id of a.instruments) {
      const f = live.get(id);
      if (!f) continue;
      const cursor = a.cursors[id];
      let ratesOf: Map<number, DecStr> | null = null;
      if (cursor !== undefined && cursor + f.inst.fundingIntervalSec * 1000 <= now) {
        const key = `${id}:${cursor}`;
        if (!rates.has(key)) rates.set(key, fundingRates(svc, f.inst, cursor));
        ratesOf = await rates.get(key)!;
      }
      feeds.push({ ...f, fundingRates: ratesOf });
    }
    if (feeds.length === 0) continue;
    try {
      const r = await svc.tick(a.id, feeds, now);
      summary.fed += 1; summary.fills += r.fills; summary.funding += r.funding;
      if (r.liquidated) summary.liquidations += 1;
      if (r.halted) summary.halts += 1;
    } catch (e) { note(`account ${a.id}`, e); }
  }
  return summary;
}

export function startDerivativesWorker(d: Derivatives = derivatives()): void {
  let lastError = '';
  loop('deriv-paper', async () => {
    const s = await paperStep(d.paper);
    if (s.fills || s.funding || s.liquidations || s.halts) console.log(`[derivatives] paper: ${s.fed} account(s), ${s.fills} fill(s), ${s.funding} funding payment(s), ${s.liquidations} liquidation(s), ${s.halts} halt(s)`);
    const err = s.errors[0] ?? '';
    if (err && err !== lastError) console.log(`[derivatives] paper: ${s.errors.length} error(s) (${err})`);
    lastError = err;
  }, PAPER_STEP_MS);
}
