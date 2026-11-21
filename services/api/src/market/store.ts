/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/market/store.ts
 * Module           : market
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

// Storage of candles and of the quality record. Every write is an idempotent upsert.
import { sql } from '../db.ts';
import type { QualityReport } from './quality.ts';
import { SOURCE_IDS, type BySource, type Candle, type Interval, type MarketSymbol, type SourceId } from './types.ts';

/** Inserts or corrects bars; returns how many rows were actually written (0 when the same bars are stored again). */
export async function upsertCandles(source: SourceId, symbol: MarketSymbol, interval: Interval, bars: Candle[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < bars.length; i += 1000) {
    const rows = bars.slice(i, i + 1000).map((c) => ({ source, symbol, interval, ts: new Date(c.ts), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    const r = await sql`insert into candles ${sql(rows, 'source', 'symbol', 'interval', 'ts', 'open', 'high', 'low', 'close', 'volume')}
      on conflict (source, symbol, interval, ts) do update set open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, volume = excluded.volume
      where (candles.open, candles.high, candles.low, candles.close, candles.volume) is distinct from (excluded.open, excluded.high, excluded.low, excluded.close, excluded.volume)
      returning 1`;
    written += r.length;
  }
  return written;
}

/** upper bound PostgreSQL accepts for a timestamp parameter */
const FOREVER = Date.UTC(9999, 0, 1);
const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);
export async function latestTs(source: SourceId, symbol: MarketSymbol, interval: Interval): Promise<number | null> {
  const [r] = await sql<{ ts: Date }[]>`select ts from candles where source = ${source} and symbol = ${symbol} and interval = ${interval} order by ts desc limit 1`;
  return ms(r?.ts);
}
export async function earliestTs(source: SourceId, symbol: MarketSymbol, interval: Interval): Promise<number | null> {
  const [r] = await sql<{ ts: Date }[]>`select ts from candles where source = ${source} and symbol = ${symbol} and interval = ${interval} order by ts asc limit 1`;
  return ms(r?.ts);
}

type Row = { source: SourceId; ts: Date; open: number; high: number; low: number; close: number; volume: number };
function group(rows: Row[]): BySource {
  const out: BySource = {};
  for (const r of rows) if ((SOURCE_IDS as readonly string[]).includes(r.source)) (out[r.source] ??= []).push({ ts: r.ts.getTime(), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume });
  return out;
}
/** Bars of every source with bar-open time in [from, to], oldest first. */
export async function loadBySource(symbol: MarketSymbol, interval: Interval, from: number, to: number = FOREVER): Promise<BySource> {
  return group(await sql<Row[]>`select source, ts, open, high, low, close, volume from candles
    where symbol = ${symbol} and interval = ${interval} and ts >= ${new Date(from)} and ts <= ${new Date(Math.min(to, FOREVER))} order by ts asc`);
}
/** Bars of every source for the `limit` most recent distinct bar-open times at or before `until`. */
export async function loadLastBySource(symbol: MarketSymbol, interval: Interval, limit: number, until: number = FOREVER): Promise<BySource> {
  const to = new Date(Math.min(until, FOREVER));
  return group(await sql<Row[]>`select source, ts, open, high, low, close, volume from candles
    where symbol = ${symbol} and interval = ${interval} and ts <= ${to} and ts >= (select min(ts) from (
      select distinct ts from candles where symbol = ${symbol} and interval = ${interval} and ts <= ${to} order by ts desc limit ${limit}) t)
    order by ts asc`);
}

export async function saveQuality(symbol: MarketSymbol, r: QualityReport): Promise<void> {
  await sql`insert into market_quality (symbol, interval, checked_at, last_ts, fresh, gaps, max_deviation_bps, status, detail)
    values (${symbol}, ${r.interval}, ${new Date(r.checkedAt)}, ${r.lastTs === null ? null : new Date(r.lastTs)}, ${r.fresh}, ${r.gaps}, ${r.maxDeviationBps}, ${r.status}, ${sql.json(r as never)})
    on conflict (symbol, interval) do update set checked_at = excluded.checked_at, last_ts = excluded.last_ts, fresh = excluded.fresh, gaps = excluded.gaps,
      max_deviation_bps = excluded.max_deviation_bps, status = excluded.status, detail = excluded.detail`;
}
export interface QualityRow { symbol: string; interval: string; checked_at: Date; last_ts: Date | null; fresh: boolean; gaps: number; max_deviation_bps: number | null; status: string; detail: QualityReport }
export const listQuality = () => sql<QualityRow[]>`select * from market_quality order by symbol, interval`;

export interface CoverageRow { source: string; symbol: string; interval: string; bars: number; first_ts: Date; last_ts: Date }
export const coverage = () => sql<CoverageRow[]>`select source, symbol, interval, count(*)::int as bars, min(ts) as first_ts, max(ts) as last_ts
  from candles group by source, symbol, interval order by symbol, interval, source`;
