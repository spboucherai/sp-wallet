/**
 * NEXT — universal search, the LOCAL index: what the app already holds (the registry of assets with the balances, the
 * contacts, the recent movements, the destinations of the settings). Used alone on a server without `GET /search`, and merged
 * under the server's hits otherwise. Pure: tested in test/next-search.test.ts.
 */
import type { SearchHit } from './wallet-more';

export interface IndexAsset { network: string; networkName: string; asset: string; symbol: string; name: string; amount: string | null }
export interface IndexContact { id: string; network: string; address: string; label: string; note?: string }
export interface IndexItem { id: string; kind: string; network: string; networkName: string; symbol: string; amountDisplay: string; txid: string | null; to?: string; from?: string; note?: string; at: string }
export interface Destination { id: string; path: string; title: string; /** other words that find it */ keywords: string }
export interface SearchSources { assets: readonly IndexAsset[]; contacts: readonly IndexContact[]; items: readonly IndexItem[]; destinations: readonly Destination[]; netName: (id: string) => string; txTitle: (i: IndexItem) => string; /** an amount in the owner's language (default: as the server wrote it) */ amount?: (canonical: string) => string }
export const GROUPS = ['asset', 'contact', 'transaction', 'setting'] as const;
export const PER_GROUP = 6;

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** an amount as typed (« 1 250,5 », "1,250.5") reduced to its digits and one decimal point, to compare with a canonical amount */
const digits = (s: string): string => s.replace(/[\s  '’]/g, '').replace(',', '.');
/** how well `text` answers `q`: 3 = equal, 2 = starts with it, 1 = contains it, 0 = no */
const score = (text: string, q: string): number => { const x = fold(text); return x === q ? 3 : x.startsWith(q) ? 2 : x.includes(q) ? 1 : 0; };
const best = (q: string, ...texts: (string | null | undefined)[]): number => Math.max(0, ...texts.map((x) => (x ? score(x, q) : 0)));

/** The hits of the local index for `q`, grouped in the order assets, contacts, transactions, settings; at most PER_GROUP per group. */
export function localSearch(query: string, src: SearchSources): SearchHit[] {
  const q = fold(query.trim()); if (q.length < 2 && !/^\d$/.test(q)) return [];
  const long = q.length >= 4, num = digits(q);
  const top = <T,>(rows: readonly T[], rank: (r: T) => number, make: (r: T) => SearchHit): SearchHit[] => rows.map((r) => [rank(r), r] as const).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, PER_GROUP).map(([, r]) => make(r));
  const assets = top(src.assets, (a) => { const s = best(q, a.symbol, a.name) * 2 + best(q, a.networkName, a.network) + (long && a.asset !== 'native' && fold(a.asset).includes(q) ? 6 : 0); return s > 0 ? s + (a.amount !== null && a.amount !== '0' ? 1 : 0) : 0; },
    (a) => ({ type: 'asset', id: `${a.network}:${a.asset}`, title: a.name, subtitle: `${a.symbol} · ${a.networkName}`, path: `/asset/${a.network}/${encodeURIComponent(a.asset)}`, network: a.network, symbol: a.symbol }));
  const contacts = top(src.contacts, (c) => best(q, c.label) * 2 + best(q, c.note) + (long && fold(c.address).includes(q) ? 4 : 0),
    (c) => ({ type: 'contact', id: c.id, title: c.label, subtitle: `${src.netName(c.network)} · ${c.address.length > 16 ? `${c.address.slice(0, 8)}…${c.address.slice(-6)}` : c.address}`, path: '/contacts', network: c.network }));
  const items = top(src.items, (i) => (long && i.txid && fold(i.txid).includes(q) ? 6 : 0) + (long && ((i.to && fold(i.to).includes(q)) || (i.from && fold(i.from).includes(q))) ? 4 : 0)
      + (/^\d/.test(num) && (i.amountDisplay === num || i.amountDisplay.startsWith(num)) ? 3 : 0) + best(q, i.symbol, i.note) + (best(q, src.txTitle(i)) > 0 ? 1 : 0),
    (i) => ({ type: 'transaction', id: i.id, title: src.txTitle(i), subtitle: `${(src.amount ?? ((x: string) => x))(i.amountDisplay)} ${i.symbol} · ${i.networkName}`, path: `/activity?tx=${encodeURIComponent(i.id)}`, network: i.network, symbol: i.symbol }));
  const settings = top(src.destinations, (d) => best(q, d.title) * 2 + (fold(d.keywords).includes(q) ? 1 : 0), (d) => ({ type: 'setting', id: d.id, title: d.title, subtitle: '', path: d.path }));
  return [...assets, ...contacts, ...items, ...settings];
}
/** the server's hits first, then the local ones it does not already have (same type and same target), regrouped in the fixed order */
export function mergeHits(server: readonly SearchHit[] | null, local: readonly SearchHit[]): SearchHit[] {
  const seen = new Set<string>(), all: SearchHit[] = [];
  for (const h of [...(server ?? []), ...local]) { const k = `${h.type}|${h.path}|${h.type === 'contact' ? h.id : ''}`; if (!seen.has(k)) { seen.add(k); all.push(h); } }
  return GROUPS.flatMap((g) => all.filter((h) => h.type === g).slice(0, PER_GROUP));
}
/** keyboard navigation of the result list: the index reached from `at` (−1: none) with a key, wrapping; null for another key */
export function moveSelection(key: string, at: number, n: number): number | null {
  if (n === 0) return null;
  switch (key) { case 'ArrowDown': return at < 0 ? 0 : (at + 1) % n; case 'ArrowUp': return at <= 0 ? n - 1 : at - 1; case 'Home': return 0; case 'End': return n - 1; default: return null; }
}
