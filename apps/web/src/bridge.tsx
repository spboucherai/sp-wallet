// Cross-chain USDC transfer (Circle CCTP): progress of the two legs and the "finish" action, shared by Swap and Activity.
import { useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { post } from './api';
import { errText, useT, type Key } from './i18n';
import { Btn, Icon, Notice, trimAmt } from './ui';

export interface BridgeV {
  provider: string; toNetwork: string; toNetworkName: string; speed: 'standard' | 'fast'; expectedSeconds: number;
  stage: 'review' | 'burning' | 'attesting' | 'ready' | 'minting' | 'mint_failed' | 'done' | 'failed';
  cctpMaxFeeDisplay: string; minReceiveDisplay: string; feeExecutedDisplay: string | null; receivedDisplay: string | null; destGasSymbol: string; destGasNeedDisplay: string;
  needsApproval: boolean; approvalState: string | null; hold: string | null; holdDetail: string | null; irisStatus: string | null; delayReason: string | null;
  mintTxid: string | null; mintExplorer: string | null; mintedBy: 'wallet' | 'other' | null; canFinish: boolean; needsPasskey: boolean;
}
export const bridgeDur = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`);
const ORDER = ['burning', 'attesting', 'minting', 'done'] as const;
const TONE: Record<BridgeV['stage'], string> = { review: 'text-warn bg-warn/12', burning: 'text-blue bg-blue/10', attesting: 'text-blue bg-blue/10', ready: 'text-warn bg-warn/12', minting: 'text-blue bg-blue/10', mint_failed: 'text-danger bg-danger/10', done: 'text-emerald bg-emerald/10', failed: 'text-danger bg-danger/10' };

/** Status is always icon + text, never colour alone. */
export function BridgePill({ b }: { b: BridgeV }) {
  const t = useT();
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${TONE[b.stage]}`}><Icon n={b.stage === 'done' ? 'check' : b.stage === 'failed' || b.stage === 'mint_failed' ? 'x' : 'clock'} className="h-3 w-3" />{t(`brStage_${b.stage}` as Key)}</span>;
}

/** The four steps, what the transfer is waiting for, and the finish / approve-again action. `onUpdate` receives the fresh proposal. */
export function BridgeProgress({ id, b, onUpdate }: { id: string; b: BridgeV; onUpdate: (p: any) => void }) {
  const t = useT(); const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const at = b.stage === 'ready' ? 1 : b.stage === 'mint_failed' ? 2 : ORDER.indexOf(b.stage as (typeof ORDER)[number]);
  const finish = async () => {
    setBusy(true); setErr('');
    try {
      if (b.needsPasskey) { // the single automatic mint signature is spent: a new one needs the passkey, over the exact new transaction
        const o = await post<{ proposal: any; options: any }>(`/bridge/proposals/${id}/retry-mint/options`);
        if (o.proposal.bridge?.needsPasskey) { const assertion = await startAuthentication({ optionsJSON: o.options }); onUpdate(await post(`/bridge/proposals/${id}/retry-mint`, { assertion })); }
        else onUpdate(o.proposal);
      } else onUpdate(await post(`/bridge/proposals/${id}/finish`));
    } catch (e) { const m = errText(t, e); if (m) setErr(m); } finally { setBusy(false); }
  };
  if (b.stage === 'review' || b.stage === 'failed') return null;
  return (
    <div className="space-y-3">
      <ol className="space-y-1.5 text-[13.5px]" aria-label={t('brProgress')}>{ORDER.map((s, k) => { const done = b.stage === 'done' || k < at, cur = k === at && b.stage !== 'done';
        return <li key={s} className={`flex items-center gap-2.5 ${done ? '' : cur ? 'font-medium' : 'text-mute'}`} aria-current={cur ? 'step' : undefined}>
          <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${done ? 'bg-emerald/15 text-emerald' : cur ? 'bg-primary text-onprimary' : 'bg-elev text-mute'}`}>{done ? <Icon n="check" className="h-3 w-3" /> : cur ? <Icon n="spin" className="h-3 w-3" /> : k + 1}</span>
          <span>{t(`brStep_${s}` as Key, { net: b.toNetworkName })}{done ? '' : cur ? ' …' : ''}</span></li>; })}</ol>
      {b.stage === 'attesting' && !b.hold && <p className="text-[13px] text-mute">{t('brWaitAttest', { time: bridgeDur(b.expectedSeconds) })}{b.delayReason ? ` (${b.delayReason})` : ''}</p>}
      {b.hold && b.stage !== 'done' && <Notice tone={b.stage === 'mint_failed' || b.hold === 'message_mismatch' || b.hold === 'contract_changed' ? 'danger' : 'warn'}>{t(`brHold_${b.hold}` as Key)}{b.holdDetail ? <span className="block text-mute">{b.holdDetail}</span> : null}</Notice>}
      {b.stage !== 'done' && <p className="text-[12.5px] text-mute">{t('brSafe')}</p>}
      {b.stage === 'done' && b.mintedBy === 'other' && <p className="text-[13px] text-mute">{t('brMintedByOther')}</p>}
      {err && <Notice tone="danger">{err}</Notice>}
      {b.mintExplorer && <a className="inline-flex items-center gap-1.5 text-sm text-blue" href={b.mintExplorer} target="_blank" rel="noreferrer noopener"><Icon n="ext" className="h-4 w-4" />{t('brViewMint', { net: b.toNetworkName })}</a>}
      {b.canFinish && <Btn full kind={b.needsPasskey ? 'primary' : 'soft'} busy={busy} onClick={() => void finish()}><Icon n={b.needsPasskey ? 'key' : 'check'} className="h-4 w-4" />{b.needsPasskey ? t('brFinishPasskey') : t('brFinish')}</Btn>}
    </div>);
}

/** Amount, fee and guarantee lines of a transfer, for the review sheet and the activity list. */
export function BridgeFacts({ b, symbol }: { b: BridgeV; symbol: string }) {
  const t = useT();
  const row = (k: string, v: React.ReactNode) => <div className="flex justify-between gap-3"><dt className="text-mute">{k}</dt><dd className="text-right">{v}</dd></div>;
  return <>
    {row(t('brSpeed'), `${t(`brSpeed_${b.speed}` as Key)} · ≈ ${bridgeDur(b.expectedSeconds)}`)}
    {row(b.feeExecutedDisplay !== null ? t('brFeeTaken') : t('brFeeMax'), `${trimAmt(b.feeExecutedDisplay ?? b.cctpMaxFeeDisplay, 6)} ${symbol}`)}
    {row(b.receivedDisplay ? t('swReceived') : t('swMinGuaranteed'), `${trimAmt(b.receivedDisplay ?? b.minReceiveDisplay, 6)} ${symbol} · ${b.toNetworkName}`)}
    {b.stage === 'review' && row(t('brDestGas'), `≈ ${trimAmt(b.destGasNeedDisplay, 8)} ${b.destGasSymbol} · ${b.toNetworkName}`)}
    {b.approvalState && row(t('swApproval'), t(`swAppr_${b.approvalState}` as Key))}
  </>;
}
