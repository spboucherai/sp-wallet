/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/wallet-more.ts
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
 * NEXT — the typed clients that only lazily loaded screens need (the Security Center, the dashboard's tiles, the search):
 * kept out of wallet.ts so that the first chunk does not carry them. Same rules: read defensively, a route that is not on
 * this server yet (`routeMissing`) is « not there », never an error on screen.
 */
import { useQuery } from '@tanstack/react-query';
import { get, routeMissing } from './api';
import { isDecimal } from './money';
import type { Range } from './wallet';

// ------------------------------------------------------------------------------------------------------------------ analytics (next-contract)
export interface Analytics { /** fees the wallet paid over the period, in the display currency; null when the server did not value them */ feesPaid: string | null; feesCount: number | null; feesComplete: boolean | null;
  inflow: string | null; outflow: string | null; /** what a plain transfer costs now, per network — shown « where available » */ networkFees: { network: string; symbol: string | null; fee: string | null; fiat: string | null }[] }
const dec = (v: unknown): string | null => (isDecimal(v) ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
/** Read the analytics answer defensively: the route is specified by its description only. A field that is not there is null — never a guess. */
export function readAnalytics(j: unknown): Analytics {
  const a = obj(j), fees = obj(a.feesPaid ?? a.fees), flows = obj(a.flows), ext = obj(flows.external ?? flows);
  const nf = Array.isArray(a.networkFees) ? a.networkFees : Array.isArray(obj(a.fees).now) ? (obj(a.fees).now as unknown[]) : [];
  return {
    feesPaid: dec(fees.total ?? fees.value ?? fees.fiat ?? a.feesPaid), feesCount: typeof fees.count === 'number' ? fees.count : null, feesComplete: typeof fees.complete === 'boolean' ? fees.complete : null,
    inflow: dec(a.inflow ?? ext.in), outflow: dec(a.outflow ?? ext.out),
    networkFees: nf.map((x) => { const r = obj(x); return { network: String(r.network ?? ''), symbol: typeof r.symbol === 'string' ? r.symbol : typeof r.feeSymbol === 'string' ? r.feeSymbol : null, fee: dec(r.fee ?? r.feeDisplay), fiat: dec(r.fiat ?? r.value) }; }).filter((x) => x.network),
  };
}
/** `data === null`: the route is not on this server (the tiles that need it are not shown). */
/** a route this server answered 404 for is not asked again during this browser session (one request less on every load); a new session asks again */
const MISSING_KEY = 'spw-routes-missing';
const knownMissing = (route: string): boolean => { try { return (sessionStorage.getItem(MISSING_KEY) ?? '').split(',').includes(route); } catch { return false; } };
const noteMissing = (route: string): void => { try { const cur = (sessionStorage.getItem(MISSING_KEY) ?? '').split(',').filter(Boolean); if (!cur.includes(route)) sessionStorage.setItem(MISSING_KEY, [...cur, route].join(',')); } catch { /* asked again next time */ } };
export const useAnalytics = (range: Range) => useQuery({ queryKey: ['analytics', range], staleTime: 60_000, retry: 0, refetchInterval: 5 * 60_000,
  queryFn: async (): Promise<Analytics | null> => { if (knownMissing('analytics')) return null; try { return readAnalytics(await get(`/analytics?range=${range}`)); } catch (e) { if (routeMissing(e)) { noteMissing('analytics'); return null; } throw e; } } });

// ------------------------------------------------------------------------------------------------------------------ security
export interface SecDevice { id: string; label: string; deviceType?: string; backedUp?: boolean; createdAt?: string; lastUsedAt?: string | null; enrolledOnSigner?: boolean; credentialId?: string; inCooldown?: boolean; revocable?: boolean }
export interface SecSession { id?: string; current?: boolean; created_at: string; last_seen: string; ua: string; ip?: string; device?: string | null; credential?: string | null }
export interface SignerCredential { id: string; createdAt?: string | null; lastUsedAt?: string | null; inCooldown: boolean; cooldownUntil?: string | null; known: boolean; label: string | null; revocable: boolean }
export interface SecSigner { reachable: boolean; keyId?: string; halted?: boolean; journalLength?: number; journalHead?: string; policy?: { perTx: Record<string, string>; daily: Record<string, string> }; spentToday?: Record<string, string>;
  recoveryExportedAt?: string | null; recoveryVerifiedAt?: string | null; credentialCooldownSec?: number }
export interface SecurityOverview { signer: SecSigner; devices: SecDevice[]; sessions: SecSession[]; origin?: string; broadcast?: boolean;
  /** the SIGNER's list — who can approve. null: the signer is unreachable. undefined: a server older than NEXT. */ signerCredentials?: SignerCredential[] | null;
  mismatch?: { side: 'signer' | 'api'; id: string }[] | null; currentSessionId?: string | null }
export interface Login { seq: number; at: string; credential: string | null; label: string | null; ip: string | null; device: string | null; newDevice: boolean | null; session: string | null }
/** `fallbackMs`: the slow re-read that remains under the event stream */
export const useSecurity = (fallbackMs = 120_000) => useQuery({ queryKey: ['security'], queryFn: () => get<SecurityOverview>('/security/overview'), refetchInterval: fallbackMs });
export const useLogins = () => useQuery({ queryKey: ['logins'], staleTime: 30_000, retry: 0,
  queryFn: async (): Promise<Login[] | null> => { try { return (await get<{ logins: Login[] }>('/security/logins?limit=10')).logins; } catch (e) { if (routeMissing(e)) return null; throw e; } } });
/** ids known to one side only: `mismatch` is a list of `{ side: 'signer' | 'api', id }` (auth.ts `credentialSets`); null = the signer did not answer */
export function mismatchIds(m: SecurityOverview['mismatch']): { apiOnly: string[]; signerOnly: string[]; any: boolean } {
  const rows = Array.isArray(m) ? m : [];
  const apiOnly = rows.filter((r) => r.side === 'api').map((r) => String(r.id)), signerOnly = rows.filter((r) => r.side === 'signer').map((r) => String(r.id));
  return { apiOnly, signerOnly, any: apiOnly.length + signerOnly.length > 0 };
}

// ------------------------------------------------------------------------------------------------------------------ search (next-contract)
export interface SearchHit { type: 'asset' | 'contact' | 'transaction' | 'setting'; id: string; title: string; subtitle: string; /** in-app path to open */ path: string; network?: string; symbol?: string }
/** Read the server's search answer defensively (route specified by its description only); a hit without a usable target is dropped. */
export function readSearch(j: unknown): SearchHit[] {
  const a = obj(j), rows = Array.isArray(a.results) ? a.results : Array.isArray(a.hits) ? a.hits : Array.isArray(j) ? (j as unknown[]) : [];
  const out: SearchHit[] = [];
  for (const x of rows) {
    const r = obj(x), type = String(r.type ?? r.kind ?? ''), network = typeof r.network === 'string' ? r.network : undefined, asset = typeof r.asset === 'string' ? r.asset : undefined;
    const t = type === 'asset' ? 'asset' : type === 'contact' ? 'contact' : type === 'setting' || type === 'settings' ? 'setting' : type === 'transaction' || type === 'transfer' || type === 'activity' || type === 'deposit' ? 'transaction' : null;
    if (!t) continue;
    const path = typeof r.path === 'string' && r.path.startsWith('/') ? r.path : t === 'asset' && network ? `/asset/${network}/${encodeURIComponent(asset ?? 'native')}` : t === 'contact' ? '/contacts' : t === 'transaction' ? `/activity${r.id ? `?tx=${encodeURIComponent(String(r.id))}` : ''}` : null;
    if (!path) continue;
    out.push({ type: t, id: String(r.id ?? path), title: String(r.title ?? r.label ?? r.name ?? r.symbol ?? ''), subtitle: String(r.subtitle ?? r.detail ?? r.networkName ?? ''), path, network, symbol: typeof r.symbol === 'string' ? r.symbol : undefined });
  }
  return out.filter((h) => h.title);
}
/** null: the route is not on this server (the palette then searches its local index only) */
export async function serverSearch(q: string, signal?: AbortSignal): Promise<SearchHit[] | null> {
  if (knownMissing('search')) return null;
  try { return readSearch(await get(`/search?q=${encodeURIComponent(q)}`, { signal, timeoutMs: 8000 })); } catch (e) { if (routeMissing(e)) { noteMissing('search'); return null; } throw e; }
}
