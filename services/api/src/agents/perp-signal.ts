/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/agents/perp-signal.ts
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

// Signal runner for perp agents: `python -m spq.signal --contract 2` in a separate process with an almost empty environment
// (no secret, no database URL), a timeout and a bounded output, inside the OS sandbox of lab.ts (v8) — exactly as the spot runner (live.ts).
// Any deviation throws, and the engine holds.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { labExec, RESEARCH_DIR, SIGNAL_MAX_RSS_MB } from './lab.ts';
import type { PerpInterval, PerpSeries } from './perp-data.ts';
import type { PerpSignal } from './perp-engine.ts';

const SIGNAL_TIMEOUT_MS = 60_000;

/** signal-input-v2: candles + funding per perpetual; nothing dated after the last closed bar's open */
export function perpSignalInput(data: Record<string, PerpSeries>, interval: PerpInterval): { input: string; last: number } {
  const syms = Object.keys(data);
  if (!syms.length) throw new Error('no series');
  const first = data[syms[0]!]!, last = first.bars.at(-1)?.ts;
  if (last === undefined || syms.some((s) => data[s]!.bars.at(-1)?.ts !== last || data[s]!.bars.length !== first.bars.length)) throw new Error('series are not aligned on the same closed bars');
  const candles = Object.fromEntries(syms.map((s) => [s, data[s]!.bars.map((b) => [Math.floor(b.ts / 1000), b.open, b.high, b.low, b.close, b.volume])]));
  const funding = Object.fromEntries(syms.map((s) => [s, data[s]!.funding.filter((f) => f.ts <= last).map((f) => (f.premium === null ? [Math.floor(f.ts / 1000), f.rate] : [Math.floor(f.ts / 1000), f.rate, f.premium]))]));
  return { input: JSON.stringify({ candles, funding, interval, as_of: new Date(last).toISOString().replace('.000Z', 'Z') }), last };
}

export async function runPerpSignal(strategy: { path: string; sha256: string }, data: Record<string, PerpSeries>, interval: PerpInterval): Promise<PerpSignal> {
  const dir = path.resolve(RESEARCH_DIR, strategy.path);
  if (!dir.startsWith(path.join(RESEARCH_DIR, 'strategies') + path.sep) || !existsSync(path.join(dir, 'strategy.py'))) throw new Error('strategy directory is not inside research/strategies');
  if (!/^[0-9a-f]{64}$/.test(strategy.sha256)) throw new Error('bad strategy hash');
  const { input, last } = perpSignalInput(data, interval);
  let r;
  try { r = await labExec(['spq.signal', '--contract', '2', '--strategy', dir, '--sha256', strategy.sha256, '--input', '-'], { timeoutMs: SIGNAL_TIMEOUT_MS, stdin: input, strategyDir: dir, maxOut: 100_000, onOverflow: 'kill', maxRssMb: SIGNAL_MAX_RSS_MB }); }
  catch (e) { throw new Error(`signal runner could not start: ${(e as Error).message}`); }
  if (r.killed === 'timeout') throw new Error('signal timed out');
  if (r.killed === 'output') throw new Error('signal output too large');
  if (r.killed === 'memory') throw new Error('signal used too much memory');
  if (r.code === null) throw new Error(`signal runner could not start: ${r.err.trim().split('\n').pop()?.slice(0, 200) ?? ''}`);
  if (r.code !== 0) throw new Error(`signal exit ${r.code}: ${r.err.trim().split('\n').pop()?.slice(0, 200) ?? ''}`);
  try {
    const j = JSON.parse(r.out) as { schema_version?: number; kind?: string; strategy_sha256?: string; as_of?: string; weights?: Record<string, number>; max_leverage?: number; max_gross_exposure?: number };
    if (j.schema_version !== 2 || j.kind !== 'perp') throw new Error('not a contract-2 (perp) signal');
    if (j.strategy_sha256 !== strategy.sha256) throw new Error('signal computed by another strategy hash');
    if (!j.as_of || Date.parse(j.as_of) !== last) throw new Error('signal is not for the last closed bar');
    if (!j.weights || typeof j.weights !== 'object' || typeof j.max_leverage !== 'number' || typeof j.max_gross_exposure !== 'number') throw new Error('no weights or no leverage bounds');
    return { weights: j.weights, maxLeverage: j.max_leverage, maxGrossExposure: j.max_gross_exposure };
  } catch (e) { throw new Error(`unreadable signal: ${(e as Error).message}`); }
}
