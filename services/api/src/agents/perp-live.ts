/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/agents/perp-live.ts
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

// Perp agents: the engine's real-world side. Wires the engine (perp-engine.ts) to the derivatives module — venue data through
// the data service, execution through the paper account — and runs one pass per minute. A PAPER agent never reaches the signer
// or a trading endpoint. A LIVE agent (V7) goes through perp-live-cycle.ts: a venue account under a signer-enforced mandate.
import { engineLoop } from '../loop-stats.ts'; // v8
import { D, type DecStr } from '@spw/derivatives';
import { sql } from '../db.ts';
import { derivatives, type Derivatives } from '../derivatives/index.ts';
import { getSeries } from '../market/series.ts';
import type { MarketSymbol } from '../market/types.ts';
import type { LiveService } from '../derivatives/exec.ts';
import { live as sharedLive } from '../derivatives/live.ts';
import { PerpDataError, PerpDataStore, type PerpSeries } from './perp-data.ts';
import { tickLivePerpAgent } from './perp-live-cycle.ts';
import { instrumentId, tickPerpAgent, type PerpAgentRow, type PerpEngineDeps } from './perp-engine.ts';
import { PaperPerpExecutor } from './perp-exec.ts';
import { runPerpSignal } from './perp-signal.ts';
import type { PerpLabDeps } from './perp-strategies.ts';

export interface PerpRuntime { deriv: Derivatives; store: PerpDataStore; deps: PerpEngineDeps; lab: PerpLabDeps;
  /** V7: the live execution engine a LIVE agent trades through (the process-wide one unless a test or a script injects its own) */
  live: () => LiveService }

/** last hourly close of the spot market data, if it is recent: the reference when the venue publishes no index */
async function spotClose(symbol: string): Promise<DecStr | null> {
  try {
    const bar = (await getSeries(symbol as MarketSymbol, '1h', { limit: 1 })).bars.at(-1);
    return bar && Date.now() - bar.ts < 2 * 3_600_000 && bar.close > 0 ? D.str(D.from(bar.close.toFixed(8))) : null;
  } catch { return null; }
}
async function spotCandles(symbol: string, interval: string, fromMs: number): Promise<[number, number, number, number, number, number][]> {
  const rows = await sql<{ ts: Date; open: number; high: number; low: number; close: number; volume: number }[]>`select ts, open, high, low, close, volume from candles
    where source = 'coinbase' and symbol = ${symbol} and interval = ${interval} and ts >= ${new Date(fromMs)} order by ts`;
  return rows.map((r) => [r.ts.getTime(), r.open, r.high, r.low, r.close, r.volume]);
}

export function createPerpRuntime(deriv: Derivatives, o: { signal?: PerpEngineDeps['signal']; weightPerMinute?: number; live?: LiveService; gate?: PerpEngineDeps['gate'] } = {}): PerpRuntime {
  const store = new PerpDataStore(deriv.data, { now: deriv.data.now, spot: spotClose, ...(o.weightPerMinute === undefined ? {} : { weightPerMinute: o.weightPerMinute }) });
  const deps: PerpEngineDeps = {
    now: deriv.data.now,
    gate: o.gate ?? (async (symbols, interval, lookback) => {
      const data: Record<string, PerpSeries> = {}; let bar: number | null = null;
      for (const s of symbols) {
        const g = await store.gate(await deriv.data.instrument(instrumentId(s)), interval, lookback);
        if (bar !== null && g.bar !== bar) throw new PerpDataError('misaligned', `${s}: its last closed bar is not the other instruments'`);
        bar = g.bar; data[s] = g.series;
      }
      if (bar === null) throw new PerpDataError('empty', 'no instrument');
      return { bar, data };
    }),
    signal: o.signal ?? runPerpSignal,
    market: async (symbol) => {
      const inst = await deriv.data.instrument(instrumentId(symbol));
      const [ticker, book] = await Promise.all([deriv.data.ticker(inst, { within: 1_000 }), deriv.data.book(inst, { within: 1_000 })]);
      if (!book) throw new Error(`${inst.venue} has no order book`);
      return { inst, ticker, book };
    },
    executor: (a) => new PaperPerpExecutor(deriv.paper, a.deriv_account_id),
  };
  return { deriv, store, deps, lab: { data: deriv.data, store, spotCandles }, live: () => o.live ?? sharedLive() };
}

let shared: PerpRuntime | null = null;
/** the process-wide runtime, on the derivatives instance the routes and the paper worker share */
export function perpRuntime(): PerpRuntime { return (shared ??= createPerpRuntime(derivatives())); }
/** server.ts (an injected derivatives instance), tests and the simulation script */
export function setPerpRuntime(r: PerpRuntime | null): void { shared = r; }

const backoff = new Map<string, number>();
/** One pass over every perp agent in paper trading or on a venue account. Errors never cross agents; an agent that failed waits two minutes. */
export async function perpEnginePass(rt: PerpRuntime = perpRuntime(), now = Date.now()): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const agents = await sql<PerpAgentRow[]>`select * from agents where kind = 'perp' and ((state = 'PAPER_TRADING' and mode <> 'LIVE') or (mode = 'LIVE' and state in ('LIVE', 'PAUSED', 'STOPPING'))) order by created_at`;
  for (const a of agents) {
    try {
      if ((backoff.get(a.id) ?? 0) > now) { out[a.id] = 'backing off after an error'; continue; }
      out[a.id] = a.mode === 'LIVE' ? await tickLivePerpAgent(a, rt) : await tickPerpAgent(a, rt.deps);
    } catch (e) {
      backoff.set(a.id, now + 2 * 60_000); out[a.id] = `error: ${(e as Error).message.slice(0, 160)}`;
      await sql`insert into research_log (agent_id, kind, title, body) values (${a.id}, 'hold', 'Engine pass interrupted', ${(e as Error).message.slice(0, 300)})`.catch(() => {});
    }
  }
  return out;
}

export function startPerpAgentEngine(everyMs = 60_000): () => void {
  return engineLoop('perp-agent-engine', everyMs, () => perpEnginePass()); // v8: heartbeat in loopStats
}
