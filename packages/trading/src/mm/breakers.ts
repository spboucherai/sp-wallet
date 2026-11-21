/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/trading/src/mm/breakers.ts
 * Module           : mm
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-15
 * Last Modified    : 2026-11-15
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

// Circuit breakers of a quoting session. Each one, when it trips, PULLS THE QUOTES (cancel all); some also flatten (per the
// configured policy) and some stop the session until a human looks. Pure: a reducer over observations, time is an argument.
// These are API-side controls: the signer knows none of them (docs/V11-MARKET-MAKING.md §5).
import { D, type DecStr } from '@spw/derivatives';

export const BREAKER_CODES = ['data_stale', 'venue_disconnected', 'book_crossed', 'book_thin', 'spread_blowout', 'vol_spike',
  'fill_burst', 'adverse_selection', 'consecutive_rejects', 'drawdown_session', 'drawdown_day', 'kill_switch'] as const;
export type BreakerCode = (typeof BREAKER_CODES)[number];
export type BreakerAction = 'pull' | 'flatten' | 'halt';
export interface BreakerConfig {
  /** book or trade data older than this is not quoted on */
  maxDataAgeMs: number;
  /** best ask − best bid above this many bps of the mid */
  maxSpreadBps: DecStr;
  /** less than this notional (USD) at the best level of either side */
  minTopDepthUsd: DecStr;
  /** volatility above `volSpikeMultiple` × its slow baseline, or above `maxVolBps` outright */
  volSpikeMultiple: number; maxVolBps: number;
  /** more than this many fills inside `fillBurstWindowMs` */
  fillBurstCount: number; fillBurstWindowMs: number;
  /** mean markout of the last `markoutSample` fills at the 10 s horizon below this (bps, negative) */
  minMarkoutBps: DecStr; markoutSample: number;
  consecutiveRejects: number;
  /** session and UTC-day PnL floors, USD (negative numbers as decimal strings) */
  maxSessionLossUsd: DecStr; maxDayLossUsd: DecStr;
  /** how long quotes stay pulled after a transient breaker clears */
  coolDownMs: number;
  /** what a breaker does to the inventory, per code; default `pull` (hold the inventory) */
  action: Partial<Record<BreakerCode, BreakerAction>>;
}
export interface BreakerObservation {
  nowMs: number;
  venueStatus: 'connected' | 'reconnecting' | 'stale' | 'idle';
  /** venue time of the last book; null = none yet */
  bookTs: number | null;
  bid: DecStr | null; bidSize: DecStr | null; ask: DecStr | null; askSize: DecStr | null;
  volBps: number | null; baselineVolBps: number | null;
  /** times of our own recent fills (unix ms) */
  fillTimes: readonly number[];
  /** 10 s markouts (bps) of the most recent fills that have one, oldest first */
  markouts10s: readonly DecStr[];
  consecutiveRejects: number;
  sessionPnlUsd: DecStr; dayPnlUsd: DecStr;
  killSwitch: boolean;
}
export interface BreakerState { /** transient breakers: quotes stay pulled until this time */ until: Partial<Record<BreakerCode, number>>; /** a breaker that stops the session; cleared only by `breakersReset` */ halted: BreakerCode | null }
export interface BreakerVerdict { state: BreakerState; /** codes tripped by THIS observation */ tripped: BreakerCode[]; /** codes in force (tripped now or cooling down) */ active: BreakerCode[]; pull: boolean; flatten: boolean; halted: BreakerCode | null }
export const breakersInit = (): BreakerState => ({ until: {}, halted: null });
/** an operator's decision: the session may quote again */
export const breakersReset = (): BreakerState => breakersInit();

const STICKY: readonly BreakerCode[] = ['consecutive_rejects', 'drawdown_session', 'drawdown_day'];
export const DEFAULT_BREAKER_ACTION: Record<BreakerCode, BreakerAction> = {
  data_stale: 'pull', venue_disconnected: 'pull', book_crossed: 'pull', book_thin: 'pull', spread_blowout: 'pull', vol_spike: 'pull', fill_burst: 'pull', adverse_selection: 'pull',
  consecutive_rejects: 'halt', drawdown_session: 'halt', drawdown_day: 'halt', kill_switch: 'pull',
};

export function stepBreakers(prev: BreakerState, o: BreakerObservation, cfg: BreakerConfig): BreakerVerdict {
  const tripped: BreakerCode[] = [];
  const trip = (c: BreakerCode) => { if (!tripped.includes(c)) tripped.push(c); };
  if (o.killSwitch) trip('kill_switch');
  if (o.venueStatus !== 'connected') trip('venue_disconnected');
  if (o.bookTs === null || o.nowMs - o.bookTs > cfg.maxDataAgeMs) trip('data_stale');
  if (o.bid !== null && o.ask !== null && o.bidSize !== null && o.askSize !== null) {
    const bid = D.from(o.bid), ask = D.from(o.ask);
    if (!D.isPos(bid) || D.lte(ask, bid)) trip('book_crossed');
    else {
      const mid = D.div(D.add(bid, ask), D.from(2n), 12, 'half_even');
      if (D.gt(D.mul(D.sub(ask, bid), D.from(10000n)), D.mul(mid, D.from(cfg.maxSpreadBps)))) trip('spread_blowout');
      const min = D.from(cfg.minTopDepthUsd);
      if (D.lt(D.mul(bid, D.from(o.bidSize)), min) || D.lt(D.mul(ask, D.from(o.askSize)), min)) trip('book_thin');
    }
  } else trip('data_stale');
  if (o.volBps !== null && (o.volBps > cfg.maxVolBps || (o.baselineVolBps !== null && o.baselineVolBps > 0 && o.volBps > cfg.volSpikeMultiple * o.baselineVolBps))) trip('vol_spike');
  if (o.fillTimes.filter((t) => t > o.nowMs - cfg.fillBurstWindowMs).length > cfg.fillBurstCount) trip('fill_burst');
  if (o.markouts10s.length >= cfg.markoutSample) {
    const last = o.markouts10s.slice(-cfg.markoutSample), total = last.reduce((a, b) => D.add(a, D.from(b)), D.zero);
    if (D.lt(total, D.mul(D.from(cfg.minMarkoutBps), D.from(BigInt(last.length))))) trip('adverse_selection');          // mean < threshold, without a division
  }
  if (o.consecutiveRejects >= cfg.consecutiveRejects) trip('consecutive_rejects');
  if (D.lt(D.from(o.sessionPnlUsd), D.from(cfg.maxSessionLossUsd))) trip('drawdown_session');
  if (D.lt(D.from(o.dayPnlUsd), D.from(cfg.maxDayLossUsd))) trip('drawdown_day');

  const actionOf = (c: BreakerCode): BreakerAction => cfg.action[c] ?? DEFAULT_BREAKER_ACTION[c];
  const until: BreakerState['until'] = {};
  for (const [c, t] of Object.entries(prev.until) as [BreakerCode, number][]) if (t > o.nowMs) until[c] = t;
  let halted = prev.halted;
  for (const c of tripped) {
    if (c !== 'kill_switch') until[c] = o.nowMs + cfg.coolDownMs;              // the kill switch is a level, not an event: it ends when it is lifted
    if (halted === null && (STICKY.includes(c) || actionOf(c) === 'halt')) halted = c;
  }
  const active = [...new Set<BreakerCode>([...tripped, ...(Object.keys(until) as BreakerCode[]), ...(halted ? [halted] : [])])];
  return { state: { until, halted }, tripped, active, pull: active.length > 0, flatten: active.some((c) => actionOf(c) === 'flatten'), halted };
}
