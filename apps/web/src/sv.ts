// Server texts (v11, audit B3). The API sends a CODE and its PARAMETERS next to its English sentence; this file turns them
// into the owner's language. Rule: a code that has a text is translated; a code that has none shows the server's sentence as
// it was sent (an honest fallback for a code newer than this bundle) — the English sentence is never appended to a translation.
import { hasText, type Key } from './i18n';

export type T = (k: Key, v?: Record<string, string | number>) => string;
export type Params = Record<string, string | number> | null | undefined;

/** `sv_<code>` (server catalogue), else `e_<code>` (API error codes), else the sentence the server sent. */
export function svText(t: T, code: string | null | undefined, params: Params, fallback?: string | null): string {
  if (code) {
    if (hasText(`sv_${code}`)) return t(`sv_${code}` as Key, params ?? undefined);
    if (hasText(`e_${code}`)) return t(`e_${code}` as Key);
  }
  return fallback ?? code ?? '';
}

/** Why a proposal ended. */
export const propError = (t: T, p: { error?: string | null; errorCode?: string | null; errorParams?: Params } | null | undefined): string =>
  (p ? svText(t, p.errorCode, p.errorParams, p.error) : '');

/** The detail line under a CCTP or THORChain hold. */
export const holdDetail = (t: T, b: { holdCode?: string | null; holdParams?: Params; holdDetail?: string | null }): string => svText(t, b.holdCode, b.holdParams, b.holdDetail);

/** The detail of a risk flag: its figures, or the reason a route is not executed here. Empty when the flag's own label says it all. */
export function flagDetail(t: T, f: { code: string; detail?: string; params?: Params }): string {
  const rc = f.params?.reasonCode;
  if (typeof rc === 'string') return hasText(`svExec_${rc}`) ? t(`svExec_${rc}` as Key) : f.detail ?? '';
  if (f.params && hasText(`svFlagD_${f.code}`)) return t(`svFlagD_${f.code}` as Key, f.params);
  return f.params ? '' : f.detail ?? ''; // parameters without a text: the label alone, never half a sentence
}

/** Why a route is (or is not) executed by the wallet. */
export const execReason = (t: T, e: { class: string; code?: string; reason?: string }): string => (e.code && hasText(`svExec_${e.code}`) ? t(`svExec_${e.code}` as Key) : e.reason ?? '');

export interface Pause { code: string; message: string; params?: Params; reason?: { code: string; params?: Params } | null }
/** What a paused plan says: the pause's own sentence (floor, no funds), else the reason of the step that ended, else the refusal of the preparation. */
export function pauseText(t: T, p: Pause): string {
  if (p.code === 'floor' && p.params) return t('sv_plan_floor', p.params);
  if (p.code === 'no_funds' && p.params) return t('sv_plan_no_funds', p.params);
  if (p.reason) return svText(t, p.reason.code, p.reason.params, p.message);
  return svText(t, p.code, p.params, p.message);
}

/** "il y a 3 min" — coarse on purpose: a freshness indicator, not a clock. */
export function ago(t: T, iso: string | number | null | undefined, now = Date.now()): string {
  if (iso === null || iso === undefined) return '—';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  return s < 90 ? t('svAgoNow') : s < 5400 ? t('svAgoMin', { n: Math.round(s / 60) }) : s < 48 * 3600 ? t('svAgoH', { n: Math.round(s / 3600) }) : t('svAgoD', { n: Math.round(s / 86400) });
}
