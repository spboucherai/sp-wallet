/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/approval.ts
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
 * NEXT W1 — the outcome of an approval, shared by every flow that submits a passkey assertion (send, swap, bridge, plans, NFT,
 * agent funding, mandates, futures orders and collateral).
 *
 * Once the approval request has LEFT the browser, what happened is unknown until the server says so:
 *   - the server answered the approval                         → `answered`  (its answer is the state)
 *   - the server answered a refusal (HTTP 4xx, JSON)            → `refused`   (outcome known: this request approved nothing)
 *   - the answer was lost (time-out, network, 5xx, unreadable)  → the state is READ from the server, with retries and back-off:
 *       · a state was read                                      → `read`      (`applied` says whether it shows the approval)
 *       · no state could be read                                → `unknown`   (the screen must say so, and must not offer to send again)
 * Nothing here decides from the error alone that an operation failed. No React, no DOM: tested in test/next-approval.test.ts.
 */
import { ApiError, outcomeUnknown } from './api';

export type ApprovalOutcome<T, S = T> =
  | { kind: 'answered'; value: T }
  | { kind: 'refused'; error: ApiError }
  | { kind: 'read'; state: S; /** the state read shows the effect of the approval (or an end state): nothing is left to approve */ applied: boolean; /** what the lost answer was */ error: unknown }
  | { kind: 'unknown'; error: unknown };

/** A lost answer: no answer, an unreadable one, or a 5xx (a gateway or the server failing AFTER it may have acted). A JSON 4xx is an answer. */
export const answerLost = (e: unknown): boolean => outcomeUnknown(e) || (e as ApiError).status >= 500;

/** pauses between two reads of the state after a lost answer: five reads over about fifteen seconds */
export const READ_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000];
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ReadPlan<S> {
  /** read the operation's state from the server; throws when it cannot be read */
  read: () => Promise<S>;
  /** does this state show that the approval was taken into account (or that the operation ended)? Until it does — the server
   *  may still be working on the request whose answer was lost — the read is repeated. */
  applied: (s: S) => boolean;
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Read the state after a lost answer. Stops at the first state that shows the approval; otherwise returns the LAST state read
 * (`applied: false` — the server itself says the approval is still awaited), or `unknown` when no read succeeded at all.
 */
export async function readOutcome<S>(plan: ReadPlan<S>, error: unknown): Promise<Extract<ApprovalOutcome<never, S>, { kind: 'read' | 'unknown' }>> {
  const waits = plan.backoffMs ?? READ_BACKOFF_MS, sleep = plan.sleep ?? pause;
  let last: { s: S } | null = null;
  for (let k = 0; k <= waits.length; k++) {
    if (k > 0) await sleep(waits[k - 1]!);
    try { const s = await plan.read(); last = { s }; if (plan.applied(s)) return { kind: 'read', state: s, applied: true, error }; }
    catch { /* not readable this time: the next read may be */ }
  }
  return last ? { kind: 'read', state: last.s, applied: false, error } : { kind: 'unknown', error };
}

export interface ApprovalPlan<T, S = T> extends Partial<ReadPlan<S>> {
  /** send the approval (the passkey assertion is already in hand) */
  submit: () => Promise<T>;
  /** called when the answer was lost and the state is about to be read ("checking what happened") */
  onChecking?: (error: unknown) => void;
}

/** Submit an approval and say what is KNOWN of its outcome. Never throws. Without `read`, a lost answer is `unknown` at once. */
export async function submitApproval<T, S = T>(plan: ApprovalPlan<T, S>): Promise<ApprovalOutcome<T, S>> {
  try { return { kind: 'answered', value: await plan.submit() }; }
  catch (e) {
    if (!answerLost(e)) return { kind: 'refused', error: e as ApiError };
    plan.onChecking?.(e);
    if (!plan.read) return { kind: 'unknown', error: e };
    return readOutcome({ read: plan.read, applied: plan.applied ?? (() => true), backoffMs: plan.backoffMs, sleep: plan.sleep }, e);
  }
}

export type CancelOutcome<S> = { kind: 'cancelled' } | { kind: 'failed'; error: unknown; /** the state read after the failure, when it could be read */ state: S | null };
/**
 * Cancel (reject) a draft that was NOT submitted for approval. A failure is returned, never swallowed: the caller keeps the
 * screen as it is and shows it — the draft may be anything by now, and `state` (when readable) says what.
 */
export async function cancelDraft<S>(reject: () => Promise<unknown>, read?: () => Promise<S>): Promise<CancelOutcome<S>> {
  try { await reject(); return { kind: 'cancelled' }; }
  catch (error) {
    let state: S | null = null;
    if (read) { try { state = await read(); } catch { /* unreadable: the error alone is shown */ } }
    return { kind: 'failed', error, state };
  }
}

/**
 * The idempotency key of a draft: the SAME key for the same form content, whatever the number of network retries; a new one
 * when the content changes, or once the server has given a definitive answer for it (`renew`).
 */
export class DraftKey {
  private content: string | null = null; private key = '';
  constructor(private readonly make: () => string = () => crypto.randomUUID()) {}
  for(content: string): string { if (this.content !== content || !this.key) { this.content = content; this.key = this.make(); } return this.key; }
  renew(): void { this.content = null; this.key = ''; }
  /** after a failed creation: keep the key when the answer was lost (the retry must be the same request), renew it after an answered refusal */
  failed(e: unknown): void { if (!answerLost(e)) this.renew(); }
}

/** states of a transfer proposal in which the approval is still awaited: every other state shows that it was approved, or that it ended */
export const proposalApplied = (p: { state: string }): boolean => !['draft', 'pending_approval'].includes(p.state);
/** a draft that no longer exists as something to approve (rejected, expired): cancelling it is already done */
export const proposalGone = (p: { state: string }): boolean => ['rejected', 'expired'].includes(p.state);
