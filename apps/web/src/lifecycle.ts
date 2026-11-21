/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/lifecycle.ts
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
 * NEXT — the life cycle of a transfer as the three clients show it: ONE vocabulary (design system §3), driven by the API field
 * `lifecycle`. Tone, symbol and word come from the generated tokens (`LIFECYCLE_STATUS`); a server older than `lifecycle`
 * gives `state` only, and the SAME mapping as the server's is applied (`lifecycleOf` of packages/core/src/state.ts — imported,
 * not copied). No React here: tested in test/next-lifecycle.test.ts.
 */
import { lifecycleOf as coreLifecycleOf, STATES, type ProposalState } from '../../../packages/core/src/state';
import { LIFECYCLE_STATUS, type LifecycleKey, type Tone } from './tokens.gen';

export type { LifecycleKey, Tone };
export const LIFECYCLE_KEYS = Object.keys(LIFECYCLE_STATUS) as LifecycleKey[];
export const isLifecycle = (v: unknown): v is LifecycleKey => typeof v === 'string' && Object.hasOwn(LIFECYCLE_STATUS, v);
/** what a row of the API says about itself */
export interface HasLifecycle { lifecycle?: string | null; state?: string | null; errorCode?: string | null; relayAttemptedAt?: string | null; watched?: boolean; finalized?: boolean }

/** the life-cycle value of a row: the server's own when it sends one this client knows, else derived from `state` as the server does */
export function lifecycleOf(p: HasLifecycle): LifecycleKey {
  if (isLifecycle(p.lifecycle)) return p.lifecycle;
  // an old server reports `dropped` as failed + errorCode `dropped`: the same projection, read backwards
  if (p.state === 'failed' && p.errorCode === 'dropped') return 'dropped';
  const s = (STATES as readonly string[]).includes(p.state ?? '') ? (p.state as ProposalState) : 'draft';
  return coreLifecycleOf(s, { relayAttempted: !!p.relayAttemptedAt, errorCode: p.errorCode ?? null });
}
export const statusOf = (l: LifecycleKey): { tone: Tone; symbol: string; fr: string; en: string } => LIFECYCLE_STATUS[l];
export const lifecycleLabel = (l: LifecycleKey, locale: string): string => LIFECYCLE_STATUS[l][locale === 'fr' ? 'fr' : 'en'];
/** The token file names SF Symbols for the native apps; the web draws its own icon of the same meaning, keyed by the life-cycle
 *  value itself — so a symbol renamed in the tokens never changes or breaks what the web shows. */
const ICON: Record<LifecycleKey, string> = {
  draft: 'pencil', awaiting_confirmation: 'tap', awaiting_signature: 'key', signed: 'seal', broadcasting: 'radio', pending: 'clock', confirming: 'clockCheck',
  confirmed: 'checkCircle', failed: 'stop', replaced: 'refresh', dropped: 'question', expired: 'hourglass', rejected: 'hand', not_sent: 'pauseCircle',
};
export const lifecycleIcon = (l: LifecycleKey): string => ICON[l];

/** nothing more will happen (the worker may still re-check `replaced`, and `dropped` stays watched: neither is `done`) */
export const lifecycleDone = (l: LifecycleKey): boolean => l === 'confirmed' || l === 'failed' || l === 'expired' || l === 'rejected' || l === 'not_sent';
/** the row is still moving (or watched): a screen keeps reading it */
export const lifecycleLive = (l: LifecycleKey, watched = false): boolean => !lifecycleDone(l) && (l !== 'replaced' || watched);
/** states that need their explanation on screen, always (design system §3) */
export const needsExplanation = (l: LifecycleKey): boolean => l === 'dropped' || l === 'replaced' || l === 'expired' || l === 'failed' || l === 'not_sent';

/** the forward path of a transfer, in order */
export const PATH: readonly LifecycleKey[] = ['awaiting_confirmation', 'awaiting_signature', 'signed', 'broadcasting', 'pending', 'confirming', 'confirmed'];
export type StepState = 'done' | 'current' | 'next' | 'failed';
export interface TimelineStep { key: LifecycleKey; state: StepState; /** the time this step was reached, when the row carries it */ at: string | null }
/** the times a row carries, by the step they belong to (all optional: a server gives what it recorded) */
export interface LifecycleTimes { createdAt?: string | null; approvedAt?: string | null; signedAt?: string | null; relayAttemptedAt?: string | null; broadcastAt?: string | null; confirmedAt?: string | null; finalizedAt?: string | null; updatedAt?: string | null }
const TIME_OF: Partial<Record<LifecycleKey, keyof LifecycleTimes>> = { awaiting_confirmation: 'createdAt', awaiting_signature: 'approvedAt', signed: 'signedAt', broadcasting: 'relayAttemptedAt', pending: 'broadcastAt', confirming: 'confirmedAt', confirmed: 'finalizedAt' };
/**
 * The timeline of a transfer: the forward path up to where it is, then — when it left the path (failed, replaced, dropped,
 * expired, rejected, not sent) — that end as the last step. A step past the current one is `next`; `confirmed` alone is a
 * finished last step. For an off-path end, how far the transfer went is read from what the row proves: a relay started
 * (`relayAttemptedAt`) or a transaction id exists.
 */
export function timelineOf(p: HasLifecycle & LifecycleTimes & { txid?: string | null }): TimelineStep[] {
  const l = lifecycleOf(p), at = (k: LifecycleKey): string | null => { const f = TIME_OF[k]; return (f && p[f]) || null; };
  const on = PATH.indexOf(l);
  if (on >= 0) return PATH.map((k, i) => ({ key: k, state: i < on || l === 'confirmed' ? 'done' : i === on ? 'current' : 'next', at: i <= on ? at(k) : null }));
  // off the path: the steps that certainly happened, then the end
  const reached: LifecycleKey = l === 'rejected' || (l === 'expired' && !p.txid && !p.relayAttemptedAt) ? 'awaiting_confirmation'
    : l === 'not_sent' ? 'signed' : p.txid || p.relayAttemptedAt || l === 'dropped' || l === 'replaced' ? 'broadcasting' : 'awaiting_confirmation';
  const upTo = PATH.indexOf(reached);
  const head: TimelineStep[] = PATH.slice(0, upTo + 1).map((k) => ({ key: k, state: 'done' as const, at: at(k) }));
  return [...head, { key: l, state: l === 'failed' ? 'failed' : 'current', at: p.updatedAt ?? null }];
}
