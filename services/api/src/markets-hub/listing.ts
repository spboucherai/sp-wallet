/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/markets-hub/listing.ts
 * Module           : markets-hub
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

// The unified market listing: perpetual instruments of every venue (derivatives data service) and the spot symbols of the
// market-data engine (consolidated multi-source bars), one row shape for both.
//
// This is the listing of GET /api/v1/trading/markets, moved here unchanged so that there is ONE listing in the service: the
// trading API calls it with its key's restrictions (`Access`), the markets hub builds its explorer on the same reads.
// Nothing is invented: a source that cannot be read is named in `errors`, and a call whose every source fails answers 503.
import { UserError } from '../config.ts';
import { DATA_BOUNDS, venueFailure } from '../derivatives/data.ts';
import type { Derivatives } from '../derivatives/index.ts';
import { getSeries } from '../market/series.ts';
import { listQuality } from '../market/store.ts';
import { activeMarketConfig } from '../market/symbols.ts';
import { INTERVAL_MS, expectedLastTs, isSymbol } from '../market/types.ts';

export const SPOT = 'spot';
export interface MarketRow { id: string; venue: string; kind: 'perpetual' | 'spot'; symbol: string; base: string; quote: string; status: string; mark: string | null; ts: number | null; stale: boolean; [k: string]: unknown }
export type PartialError = { source: string; message: string };
/** what the caller may see (an API key's restrictions; the owner sees everything) */
export interface Access { venue(venue: string): boolean; instrument(id: string | null): boolean; denied(what: string): UserError }
export const OPEN_ACCESS: Access = { venue: () => true, instrument: () => true, denied: (what) => new UserError('restricted', `not allowed on ${what}`, 403) };
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export function createListing(deps: { derivatives: () => Derivatives; now: () => number }) {
  const now = deps.now;

  async function perpRows(venue: string): Promise<MarketRow[]> {
    const d = deps.derivatives(), id = d.registry.get(venue).id;
    const inst = await d.data.instruments(id);
    const tick = await d.data.tickers(id).catch(() => null);
    const byId = new Map((tick?.value ?? []).map((t) => [t.instrument, t]));
    return inst.value.map((i) => {
      const t = byId.get(i.id);
      return { id: i.id, venue: i.venue, kind: 'perpetual' as const, symbol: i.symbol, base: i.base, quote: i.quote, status: i.status, mark: t?.mark ?? null, index: t?.index ?? null, funding: t?.funding ?? null,
        fundingIntervalSec: i.fundingIntervalSec, volume24h: t?.volume24h ?? null, openInterest: t?.openInterest ?? null, maxLeverage: i.maxLeverage, tickSize: i.tickSize, lotSize: i.lotSize, collateral: i.collateral,
        restriction: d.registry.get(venue).restriction, ts: t ? Math.min(t.ts, tick!.ts) : inst.ts, stale: !t || tick!.stale || inst.stale || now() - tick!.ts > DATA_BOUNDS.tickers.maxAge, source: 'venue' };
    });
  }
  async function spotSymbols(): Promise<string[]> { return (await activeMarketConfig()).symbols.filter(isSymbol); }
  async function spotRow(symbol: string, quality?: Awaited<ReturnType<typeof listQuality>>): Promise<MarketRow> {
    const q = (quality ?? await listQuality()).find((x) => x.symbol === symbol && x.interval === '1h');
    const last = await getSeries(symbol, '1h', { limit: 1 }).then((s) => s.bars.at(-1) ?? null, () => null);
    const ts = last ? last.ts + INTERVAL_MS['1h'] : q?.last_ts ? q.last_ts.getTime() + INTERVAL_MS['1h'] : null;
    return { id: `${SPOT}:${symbol}`, venue: SPOT, kind: 'spot', symbol, base: symbol, quote: 'USD', status: q?.status ?? 'no_data', mark: last ? String(last.close) : null, priceKind: 'close of the last consolidated 1h bar',
      priceSource: last?.source ?? null, quality: q ? { fresh: q.fresh, gaps: q.gaps, checkedAt: q.checked_at.getTime() } : null, ts,
      stale: !last || !q?.fresh || last.ts < expectedLastTs('1h', now()) - INTERVAL_MS['1h'], source: 'market-data' };
  }

  async function markets(a: Access, q: { venue?: string; kind?: 'perpetual' | 'spot'; q?: string; limit: number }) {
    const d = deps.derivatives();
    if (q.venue !== undefined && q.venue !== SPOT) d.registry.get(q.venue); // 404 unknown_venue
    if (q.venue !== undefined && !a.venue(q.venue)) throw a.denied(`venue ${q.venue}`);
    const wantPerp = q.kind !== 'spot', wantSpot = q.kind !== 'perpetual' && (q.venue === undefined || q.venue === SPOT) && a.venue(SPOT);
    const venues = wantPerp ? d.registry.list().map((v) => v.id as string).filter((id) => (q.venue === undefined || q.venue === id) && a.venue(id)) : [];
    const errors: PartialError[] = [], rows: MarketRow[] = [];
    let asked = 0, first: unknown = null;
    const got = await Promise.allSettled(venues.map((v) => perpRows(v)));
    if (wantSpot) {   // the few spot symbols first, then the venues in registry order
      asked += 1;
      try { const [symbols, quality] = await Promise.all([spotSymbols(), listQuality()]); rows.push(...await Promise.all(symbols.map((s) => spotRow(s, quality)))); }
      catch (e) { first ??= e; errors.push({ source: SPOT, message: msg(e) }); }
    }
    got.forEach((g, k) => { asked += 1; if (g.status === 'fulfilled') rows.push(...g.value); else { first ??= g.reason; errors.push({ source: venues[k]!, message: msg(venueFailure(g.reason)) }); } });
    if (asked > 0 && errors.length === asked) { const f = venueFailure(first); throw f instanceof UserError && f.status === 503 ? f : new UserError('markets_unavailable', `no market source could be read: ${errors.map((e) => `${e.source}: ${e.message}`).join('; ').slice(0, 300)}`, 503); }
    const needle = q.q?.toLowerCase();
    const out = rows.filter((r) => a.instrument(r.id) && (!needle || r.id.toLowerCase().includes(needle) || r.symbol.toLowerCase().includes(needle) || r.base.toLowerCase().includes(needle)));
    return { markets: out.slice(0, q.limit), total: out.length, truncated: out.length > q.limit, errors, ts: now() };
  }

  return { perpRows, spotSymbols, spotRow, markets };
}
export type Listing = ReturnType<typeof createListing>;
