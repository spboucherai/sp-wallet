/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/wallet.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
 * Last Modified    : 2026-11-19
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

/**
 * NEXT — typed clients of the core-wallet routes added by NEXT, and their queries. Every figure shown from these comes from
 * the SERVER (portfolio summary, history, flows); nothing here adds up money on the client.
 *
 * Routes that exist on this branch: /portfolio (summary), /portfolio/history, /assets/prefs, /contacts, /addressbook,
 * /security/*, /events. Routes of the branch `next-contract`, not merged when this was written — coded against their
 * description, read defensively, and absent (404) without any error on screen: /analytics, /search, the `network` / `asset`
 * filters and `contactLabel` of the activity routes. `routeMissing` (api.ts) is how « not there yet » is told from a failure.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, put, routeMissing } from './api';

// ------------------------------------------------------------------------------------------------------------------ portfolio summary
export interface Missing { network: string; asset?: string; reason: string }
export interface Summary {
  currency: 'USD' | 'CAD'; total: string | null; complete: boolean; missing: Missing[]; uncertain: { network: string; asset: string; reason: string }[];
  priced: number; unpriced: { network: string; asset: string; symbol: string }[]; stalePrices: string[]; pricesStale: boolean;
  change24h: { abs: string; pct: number; basis: string } | null;
  byNetwork: { network: string; value: string; share: number }[]; byAsset: { symbol: string; value: string; share: number }[];
}
/** the full summary of this branch's server, or null (an older server sends none, or only `{ complete, missing: string[] }`) */
export const summaryOf = (p: { summary?: unknown } | undefined): Summary | null => {
  const s = p?.summary as Partial<Summary> | null | undefined;
  return s && typeof s === 'object' && Array.isArray(s.byAsset) && Array.isArray(s.byNetwork) && 'total' in s ? (s as Summary) : null;
};

// ------------------------------------------------------------------------------------------------------------------ value history
export const RANGES = ['1D', '1W', '1M', '3M', '1Y', 'ALL'] as const;
export type Range = (typeof RANGES)[number];
interface Side { in: string; out: string; net: string }
export interface HistoryFlow { at: string; direction: 'in' | 'out'; scope?: string; symbol?: string; amount?: string; value?: string | null }
export interface History {
  range: Range; currency: 'USD' | 'CAD'; asOf: string; points: { t: string; total: string }[]; first: { t: string; total: string } | null; last: { t: string; total: string } | null;
  valueChange: { abs: string; pct: number | null } | null;
  flows: { from: string | null; to: string | null; external: Side; ownAccounts: Side; net: string; valued: number; complete: boolean;
    unvalued: { refType: string; refId: string; at: string; direction: string; scope: string; network: string; symbol: string; amount: string }[];
    /** not sent by this branch's server (asked of the backend): each flow of the period with its time, for the chart's markers */ events?: HistoryFlow[] };
  estimatedMarketChange: { abs: string; pct: number | null; method: string; estimate: true; complete: boolean } | null;
  omitted: { incomplete: number }; retention: { everyPointDays: number; hourlyDays: number; snapshotEveryMinutes: number };
}
export const useHistory = (range: Range, enabled = true) => useQuery({ queryKey: ['portfolio', 'history', range], queryFn: () => get<History>(`/portfolio/history?range=${range}`), enabled, staleTime: 60_000, refetchInterval: 5 * 60_000, placeholderData: (prev) => prev });

// ------------------------------------------------------------------------------------------------------------------ asset preferences
export interface AssetPref { network: string; asset: string; hidden: boolean; favorite: boolean }
export const prefKey = (network: string, asset: string): string => `${network}:${asset}`;
export type PrefMap = Record<string, AssetPref>;
const toMap = (rows: AssetPref[]): PrefMap => Object.fromEntries(rows.map((r) => [prefKey(r.network, r.asset), r]));
/** apply a change to the map (pure: the optimistic step and its rollback are tested) */
export function withPref(m: PrefMap, network: string, asset: string, patchOf: Partial<Pick<AssetPref, 'hidden' | 'favorite'>>): PrefMap {
  const k = prefKey(network, asset), cur = m[k] ?? { network, asset, hidden: false, favorite: false }, next = { ...cur, ...patchOf };
  const out = { ...m }; if (next.hidden || next.favorite) out[k] = next; else delete out[k];
  return out;
}
export function useAssetPrefs() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['prefs'], staleTime: 60_000, retry: 0,
    queryFn: async (): Promise<PrefMap | null> => { try { return toMap((await get<{ prefs: AssetPref[] }>('/assets/prefs')).prefs); } catch (e) { if (routeMissing(e)) return null; throw e; } } });
  /** optimistic: the row moves at once; the server's row replaces it; a failure puts the previous map back and resolves false */
  const set = async (network: string, asset: string, change: Partial<Pick<AssetPref, 'hidden' | 'favorite'>>): Promise<boolean> => {
    await qc.cancelQueries({ queryKey: ['prefs'] });
    const prev = qc.getQueryData<PrefMap | null>(['prefs']) ?? {};
    qc.setQueryData(['prefs'], withPref(prev, network, asset, change));
    try {
      const r = await put<AssetPref>(`/assets/prefs/${encodeURIComponent(network)}/${encodeURIComponent(asset)}`, change);
      qc.setQueryData<PrefMap | null>(['prefs'], (m) => withPref(m ?? {}, network, asset, { hidden: r.hidden, favorite: r.favorite }));
      return true;
    } catch { qc.setQueryData(['prefs'], prev); return false; }
  };
  return { prefs: q.data ?? {}, /** false on a server without the route: hide / favourite are not offered */ available: q.data !== null && !q.isError, loaded: q.isSuccess, set };
}

// ------------------------------------------------------------------------------------------------------------------ contacts
export interface Contact { id: string; network: string; address: string; label: string; note: string; favorite: boolean; created_at?: string; updatedAt?: string | null }
export const useContacts = () => useQuery({ queryKey: ['contacts'], staleTime: 30_000,
  // a server older than /contacts still has /addressbook (label only)
  queryFn: async (): Promise<Contact[]> => { try { return (await get<{ contacts: Contact[] }>('/contacts')).contacts; } catch (e) { if (!routeMissing(e)) throw e; return (await get<Omit<Contact, 'note' | 'favorite'>[]>('/addressbook')).map((c) => ({ ...c, note: '', favorite: false })); } } });
export const contactsApi = {
  add: (b: { network: string; address: string; label: string }) => post<Contact>('/addressbook', b),
  /** `address` changes where the contact points: `currentAddress` must be the address this screen was showing (the server refuses a stale screen) */
  edit: (id: string, b: { label?: string; note?: string; favorite?: boolean; address?: string; currentAddress?: string }) => patch<Contact>(`/addressbook/${encodeURIComponent(id)}`, b),
  remove: (id: string) => del<{ ok: boolean }>(`/addressbook/${encodeURIComponent(id)}`),
};
const norm = (a: string): string => (/^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a);
/** the contact an address belongs to on a network (EVM addresses compare case-insensitively), or undefined */
export const contactFor = (contacts: readonly Contact[] | undefined, network: string | null | undefined, address: string | null | undefined): Contact | undefined =>
  (!contacts || !network || !address ? undefined : contacts.find((c) => c.network === network && norm(c.address) === norm(address)));
