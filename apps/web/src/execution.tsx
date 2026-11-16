// Unified execution status (v11): the same steps for a transfer, a swap, a CCTP transfer, a THORChain swap, a GMX order
// transaction and a plan leg — the `execution` object of the API (services/api/src/exec-status.ts), drawn with the shared
// Timeline. Pure presentation: every state word comes from the server's state, nothing is inferred here.
import { useContext } from 'react';
import { useNetworks } from './hooks';
import { hasText, I18n, useT, type Key } from './i18n';
import { Icon, NetworkIcon, ProviderIcon, Timeline, when, type StepState } from './ui';

export type ExecState = 'pending' | 'awaiting_approval' | 'signing' | 'broadcast' | 'confirming' | 'confirmed' | 'failed' | 'refunded' | 'unknown';
export interface ExecStepV { id: string; kind: string; network: string; provider: string | null; state: ExecState; txid: string | null; explorer: string | null; startedAt: string | null; endedAt: string | null; code: string | null }
export interface ExecutionV { kind: string; state: ExecState; steps: ExecStepV[]; updatedAt: string | null }

/** How a step is drawn: done, in progress, not started, or ended without going through (a refund is never drawn as a success). */
export const stepDraw = (s: ExecState): StepState => (s === 'confirmed' ? 'done' : s === 'failed' || s === 'refunded' ? 'failed' : s === 'pending' || s === 'unknown' ? 'next' : 'current');
/** The one-line reason attached to a step: a hold of the CCTP or THORChain flow. (The proposal's own error is shown by the sheet, with its parameters.) */
export const stepReasonKey = (code: string | null): Key | null => (!code ? null : hasText(`brHold_${code}`) ? (`brHold_${code}` as Key) : hasText(`xsHold_${code}`) ? (`xsHold_${code}` as Key) : null);

export function ExecutionTimeline({ exec, testid = 'execution' }: { exec: ExecutionV | null | undefined; testid?: string }) {
  const t = useT(); const { locale } = useContext(I18n); const nets = useNetworks();
  if (!exec || exec.steps.length === 0) return null;
  const name = (id: string) => nets.data?.find((n) => n.id === id)?.name ?? id;
  return <div className="sw-tl" data-testid={testid} data-state={exec.state}><Timeline label={t('svExTitle')} items={exec.steps.map((s) => { const why = stepReasonKey(s.code);
    const onChain = s.network !== 'circle' && s.network !== 'thorchain';
    return { key: s.id, state: stepDraw(s.state), testid: `exec-${s.id}`,
      node: onChain ? <NetworkIcon net={s.network} size={24} /> : <ProviderIcon provider={s.network === 'circle' ? 'cctp' : 'thorchain'} size={24} />,
      title: t(`svExStep_${s.kind}` as Key, { net: name(s.network) }), stateLabel: t(`svExState_${s.state}` as Key),
      children: (why || s.startedAt || s.endedAt || s.explorer) ? <>
        {why && <div>{t(why)}</div>}
        {(s.startedAt || s.endedAt) && <div>{[s.startedAt, s.endedAt].filter(Boolean).map((d) => when(d!, locale)).join(' → ')}</div>}
        {s.explorer && <a className="inline-flex min-h-9 items-center gap-1.5 text-blue" href={s.explorer} target="_blank" rel="noreferrer noopener"><Icon n="ext" className="h-3.5 w-3.5" />{t('svExTx')}</a>}
      </> : undefined }; })} /></div>;
}
