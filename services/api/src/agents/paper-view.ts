// v8 hardening (D4): the simulated positions of a spot agent, for the agent page. READ-ONLY: one `select` on the paper book the
// engine keeps (`agent_paper`, engine.ts) — nothing is written, nothing is seeded (engine.ts `paperHoldings` seeds the book on the
// first paper tick; this view never does), and the engine is not touched. The real vault is a different field of the answer
// (`vault`): the two are never added together.
import { sql } from '../db.ts';

export interface PaperView {
  /** simulated holdings other than the cash leg, units > 0, in the order of the book's symbols; `usd` is null when no price is known */
  positions: { symbol: string; units: string; usd: number | null }[];
  /** the simulated cash leg, in USD (one unit of the cash leg = 1 USD, as in the engine and in the vault view) */
  cashSymbol: string; cashUsd: number;
  /** when the book was read and priced (ms) */
  asOf: number;
}

/** a float of the paper book as a plain decimal string (no exponent, at most 12 decimals, no trailing zeros) */
export const unitsText = (n: number): string => { const s = n.toFixed(12).replace(/0+$/, '').replace(/\.$/, ''); return s === '-0' || s === '' ? '0' : s; };

/**
 * The paper book of an agent, or null when it has none (the agent never ran in simulation). `priceOf` returns USD prices
 * for market symbols; a symbol without a price is listed with `usd: null`, never dropped and never valued at 0.
 */
export async function paperBookView(agentId: string, cashSymbol: string, order: readonly string[], priceOf: (symbols: string[]) => Promise<Record<string, number>>, now: () => number = Date.now): Promise<PaperView | null> {
  const rows = await sql<{ symbol: string; units: number }[]>`select symbol, units from agent_paper where agent_id = ${agentId}`;
  if (!rows.length) return null;
  const held = rows.filter((r) => r.symbol !== cashSymbol && r.units > 0);
  const rank = (s: string): number => { const i = order.indexOf(s); return i < 0 ? order.length : i; };
  held.sort((a, b) => rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol));
  const px = held.length ? await priceOf(held.map((r) => r.symbol)).catch(() => ({} as Record<string, number>)) : {};
  return {
    positions: held.map((r) => ({ symbol: r.symbol, units: unitsText(r.units), usd: px[r.symbol] === undefined ? null : r.units * px[r.symbol]! })),
    cashSymbol, cashUsd: Math.max(0, rows.find((r) => r.symbol === cashSymbol)?.units ?? 0), asOf: now(),
  };
}
