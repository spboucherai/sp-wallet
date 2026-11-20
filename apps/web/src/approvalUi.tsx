/**
 * NEXT W1 — the screen side of approval.ts: one hook and one panel, used by every flow that submits a passkey approval.
 *
 *   const ap = useApprovalOutcome<State>();
 *   await ap.run({ submit, read, applied }, (o) => { … o is `answered`, `refused` or `read`: a state the SERVER gave … });
 *   <ApprovalOutcomePanel ap={ap} />          // "checking what happened" / "status unknown — do not send again"
 *   <Btn disabled={ap.locked} …>              // while locked: no Approve, no Cancel, no reset of the form
 *
 * `settle` is called for the first outcome and again for the outcome of each "check again": the same code decides what the
 * screen shows whenever the state finally arrives. An `unknown` outcome never reaches it — the panel stays instead.
 */
import { useCallback, useRef, useState } from 'react';
import { readOutcome, submitApproval, type ApprovalOutcome, type ApprovalPlan, type ReadPlan } from './approval';
import { useT } from './i18n';
import { Btn, Icon } from './ui';

export type OutcomePhase = 'idle' | 'checking' | 'unknown';
export type KnownOutcome<T, S> = Exclude<ApprovalOutcome<T, S>, { kind: 'unknown' }>;
export interface ApprovalHandle<S> {
  phase: OutcomePhase;
  /** the approval left the browser and no state read from the server has settled it yet: nothing may be approved, cancelled or reset */
  locked: boolean;
  run: <T>(plan: ApprovalPlan<T, S>, settle: (o: KnownOutcome<T, S>) => void) => Promise<ApprovalOutcome<T, S>>;
  /** read the state again (the panel's button); resolves once the retries are over */
  recheck: () => Promise<void>;
  /** can the state be read again at all? (false: the flow has no read endpoint — the owner checks in Activity) */
  canRecheck: boolean;
}

export function useApprovalOutcome<S>(): ApprovalHandle<S> {
  const [phase, setPhase] = useState<OutcomePhase>('idle'); const [canRecheck, setCan] = useState(false);
  const held = useRef<{ plan: ReadPlan<S> | null; settle: (o: KnownOutcome<any, S>) => void; error: unknown } | null>(null);
  const finish = (o: ApprovalOutcome<any, S>) => { if (o.kind === 'unknown') { setPhase('unknown'); return; } setPhase('idle'); const h = held.current; held.current = null; h?.settle(o); };
  const run = useCallback(async <T,>(plan: ApprovalPlan<T, S>, settle: (o: KnownOutcome<T, S>) => void): Promise<ApprovalOutcome<T, S>> => {
    held.current = { plan: plan.read ? { read: plan.read, applied: plan.applied ?? (() => true), backoffMs: plan.backoffMs, sleep: plan.sleep } : null, settle, error: null };
    setCan(!!plan.read);
    const o = await submitApproval<T, S>({ ...plan, onChecking: (e) => { if (held.current) held.current.error = e; setPhase('checking'); plan.onChecking?.(e); } });
    finish(o); return o;
  }, []);
  const recheck = useCallback(async () => {
    const h = held.current; if (!h?.plan) return;
    setPhase('checking'); finish(await readOutcome(h.plan, h.error));
  }, []);
  return { phase, locked: phase !== 'idle', run, recheck, canRecheck };
}

/** In-app navigation to Activity from anywhere in the tree (App listens to `popstate`). */
export const openActivity = (): void => { history.pushState(null, '', '/activity'); dispatchEvent(new PopStateEvent('popstate')); window.scrollTo(0, 0); };

/**
 * What the owner sees between the moment the approval left and the moment the server said what happened. Never "failed",
 * never an Approve button: `checking` while the state is being read, `unknown` when it could not be — with "check again"
 * and a link to Activity. Renders nothing when there is nothing in doubt.
 */
export function ApprovalOutcomePanel({ ap, className = '' }: { ap: Pick<ApprovalHandle<any>, 'phase' | 'recheck' | 'canRecheck'>; className?: string }) {
  const t = useT();
  if (ap.phase === 'idle') return null;
  if (ap.phase === 'checking') return <div role="status" aria-live="polite" data-testid="approval-checking" className={`flex gap-3 rounded-2xl border border-blue/20 bg-blue/[0.07] p-3.5 text-[13.5px] leading-snug ${className}`}>
    <Icon n="spin" className="mt-0.5 h-4 w-4 shrink-0 text-blue" /><div className="min-w-0"><b className="block font-semibold">{t('nxChecking')}</b>{t('nxCheckingBody')}</div></div>;
  return <div role="alert" data-testid="approval-unknown" className={`space-y-3 rounded-2xl border border-warn/40 bg-warn/[0.09] p-4 text-[13.5px] leading-snug ${className}`}>
    <div className="flex gap-3"><Icon n="warn" className="mt-0.5 h-4 w-4 shrink-0 text-warn" /><div className="min-w-0"><b className="block text-[14.5px] font-semibold">{t('nxUnknownTitle')}</b>{t(ap.canRecheck ? 'nxUnknownBody' : 'nxUnknownBodyNoRead')}</div></div>
    <div className="grid gap-2 sm:grid-cols-2">
      {ap.canRecheck && <Btn kind="soft" data-testid="approval-recheck" onClick={() => void ap.recheck()}><Icon n="refresh" className="h-4 w-4" />{t('nxRecheck')}</Btn>}
      <Btn kind="ghost" data-testid="approval-activity" onClick={openActivity}><Icon n="list" className="h-4 w-4" />{t('nxSeeActivity')}</Btn></div></div>;
}
