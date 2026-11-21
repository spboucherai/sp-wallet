/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/derivatives/routerApi.ts
 * Module           : derivatives
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

/**
 * Client of the router routes (docs/v4/ROUTER.md): `POST /derivatives/route` and `GET /derivatives/route/assets`. SIMULATION
 * ONLY — neither route places anything. The answer types are the repository's own (type-only imports, erased at build).
 * Also here: the hand-over to the PAPER order panel («Ouvrir sur Hyperliquid en simulation»), which only pre-fills a form.
 */
import { get, post } from '../api';
import type { CostComponent, CostId, Differences, ExecutionEstimate, OrderIntent, Ranking, RankingRow, Reason, RouterSource, TermKey } from '../../../../packages/derivatives/src/router.ts';
import type { VenueId } from './types';

export type { CostComponent, CostId, Differences, ExecutionEstimate, OrderIntent, Ranking, RankingRow, Reason, RouterSource, TermKey };
export interface PolicyCheck { accountId: string; label: string; kind: 'paper' | 'venue'; mode: string; network: string; accepted: boolean | null; code: string | null; reason: string | null; source: 'risk_engine' | 'not_checked' }
export type RoutedCandidate = ExecutionEstimate & { risk: { venue: { accepted: boolean; codes: string[]; note: string }; accounts: PolicyCheck[] } };
export interface RouteAnswer { intent: OrderIntent; candidates: RoutedCandidate[]; ranking: Ranking; differences: Differences; warnings: string[]; errors: { venue: string; message: string }[]; ts: number }
export interface RouteAsset { base: string; venues: { venue: VenueId; name: string; instruments: string[]; restriction: string | null }[]; candidateVenues: number }
/** what the form sends: the intent as the router takes it (decimal strings), plus the accounts whose policy is asked */
export interface RouteBody { base: string; side: 'long' | 'short'; sizeBase?: string; notionalUsd?: string; leverage: string; type: 'market' | 'limit'; price: string | null; reduceOnly: boolean; horizonHours: string; accountIds: string[] }

export const rapi = {
  assets: async (): Promise<RouteAsset[]> => { const j = await get('/derivatives/route/assets'); return Array.isArray(j.assets) ? j.assets : []; },
  /** v8: `locale` (query) selects the language of the engine messages and of the contract terms; the intent is unchanged */
  route: async (body: RouteBody, locale?: string): Promise<RouteAnswer> => {
    const j = await post(`/derivatives/route${locale ? `?locale=${encodeURIComponent(locale)}` : ''}`, body);
    return { intent: j.intent, candidates: Array.isArray(j.candidates) ? j.candidates : [], ranking: j.ranking, differences: j.differences, warnings: Array.isArray(j.warnings) ? j.warnings : [], errors: Array.isArray(j.errors) ? j.errors : [], ts: Number(j.ts) || Date.now() };
  },
};

// ---------------------------------------------------------------- hand-over to the paper order panel (a pre-filled form, nothing more)
export interface PaperPrefill { instrument: string; side: 'buy' | 'sell'; kind: 'market' | 'limit'; unit: 'base'; size: string; lev: number; price: string; reduceOnly: boolean }
const KEY = 'spw-fut-prefill';
export function setPaperPrefill(p: PaperPrefill): void { try { sessionStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode: the panel simply opens empty */ } }
const read = (): PaperPrefill | null => { try { const s = sessionStorage.getItem(KEY); return s ? (JSON.parse(s) as PaperPrefill) : null; } catch { return null; } };
/** is a hand-over waiting for this instrument (the terminal opens its order tab) */
export const hasPaperPrefill = (instrument: string): boolean => read()?.instrument === instrument;
/** the waiting hand-over for this instrument. Reading does not consume it (a state initializer may run twice in development): the panel clears it once mounted. */
export function peekPaperPrefill(instrument: string): PaperPrefill | null { const p = read(); return p && p.instrument === instrument ? p : null; }
/** consumed: the hand-over fills the form once */
export function clearPaperPrefill(instrument: string): void { if (read()?.instrument === instrument) { try { sessionStorage.removeItem(KEY); } catch { /* nothing to clear */ } } }
