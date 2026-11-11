// Native cross-chain swap (THORChain): what the owner approves — vault address included — and the progress of the swap,
// shared by Swap and Activity. A refund is shown as a refund, never as a success.
import { useState } from 'react';
import { post } from './api';
import { errText, useT, type Key } from './i18n';
import { Btn, Icon, Notice, trimAmt } from './ui';

export interface XswapV {
  provider: string; toNetwork: string; toNetworkName: string; toSymbol: string;
  stage: 'review' | 'sending' | 'sent' | 'observed' | 'outbound' | 'received' | 'refunded' | 'failed';
  expectedOutDisplay: string; minOutDisplay: string; outboundFeeDisplay: string; liquidityFeeDisplay: string; estimatedSeconds: number | null; slippageBps: number;
  vault: string; vaultExplorer: string; memo: string; router: string | null; operators: string[]; quoteOperators: string[]; vaultMembers: number; evidenceMultiple: number; evidenceTransfersOut: number | null;
  needsApproval: boolean; approvalState: string | null; hold: string | null; holdDetail: string | null; refundPlanned: boolean;
  outTxid: string | null; outKind: 'out' | 'refund' | null; outExplorer: string | null; receivedDisplay: string | null; refundedDisplay: string | null; done: boolean;
}
const dur = (s: number | null) => (s === null ? '—' : s < 90 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`);
const ORDER = ['sent', 'observed', 'outbound', 'received'] as const;
const AT: Record<XswapV['stage'], number> = { review: -1, failed: -1, sending: 0, sent: 1, observed: 2, outbound: 3, received: 4, refunded: 4 };
const TONE: Record<XswapV['stage'], string> = { review: 'text-warn bg-warn/12', sending: 'text-blue bg-blue/10', sent: 'text-blue bg-blue/10', observed: 'text-blue bg-blue/10', outbound: 'text-blue bg-blue/10', received: 'text-emerald bg-emerald/10', refunded: 'text-warn bg-warn/12', failed: 'text-danger bg-danger/10' };

/** Status is always icon + text, never colour alone. */
export function XswapPill({ x }: { x: XswapV }) {
  const t = useT();
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${TONE[x.stage]}`}><Icon n={x.stage === 'received' ? 'check' : x.stage === 'failed' ? 'x' : x.stage === 'refunded' ? 'warn' : 'clock'} className="h-3 w-3" />{t(`xsStage_${x.stage}` as Key)}</span>;
}

/** Everything the passkey approval covers, vault address and memo in full. */
export function XswapFacts({ x, symbol, fromName }: { x: XswapV; symbol: string; fromName: string }) {
  const t = useT();
  const row = (k: string, v: React.ReactNode) => <div className="flex justify-between gap-3"><dt className="shrink-0 text-mute">{k}</dt><dd className="min-w-0 text-right">{v}</dd></div>;
  return <>
    {row(t('xsRoute'), `${fromName} → ${x.toNetworkName} · THORChain`)}
    {x.receivedDisplay ? row(t('swReceived'), `${trimAmt(x.receivedDisplay, 10)} ${x.toSymbol}`) : x.refundedDisplay ? row(t('xsRefunded'), `${trimAmt(x.refundedDisplay, 10)} ${symbol}`) : row(t('swMinGuaranteed'), `${trimAmt(x.minOutDisplay, 10)} ${x.toSymbol}`)}
    {!x.done && row(t('swExpected'), `${trimAmt(x.expectedOutDisplay, 10)} ${x.toSymbol}`)}
    {row(t('xsOutboundFee'), `${trimAmt(x.outboundFeeDisplay, 8)} ${x.toSymbol} · ${t('swIncluded')}`)}
    {row(t('xsTime'), `≈ ${dur(x.estimatedSeconds)}`)}
    {x.approvalState && row(t('swApproval'), t(`swAppr_${x.approvalState}` as Key))}
    <div><dt className="text-mute">{t('xsVault')}</dt><dd className="break-all font-mono text-[12px]">{x.vault}</dd>
      <dd className="text-[12px] text-mute">{t('xsVaultBy', { n: x.operators.length, ops: x.operators.join(', '), members: x.vaultMembers })}</dd></div>
    <div><dt className="text-mute">{t('xsMemo')}</dt><dd className="break-all font-mono text-[12px]">{x.memo}</dd></div>
  </>;
}

/** The four steps, what the swap is waiting for, and "look now". `onUpdate` receives the fresh proposal. */
export function XswapProgress({ id, x, symbol, onUpdate }: { id: string; x: XswapV; symbol: string; onUpdate: (p: any) => void }) {
  const t = useT(); const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const at = AT[x.stage];
  const refresh = async () => { setBusy(true); setErr(''); try { onUpdate(await post(`/xswap/proposals/${id}/refresh`)); } catch (e) { const m = errText(t, e); if (m) setErr(m); } finally { setBusy(false); } };
  if (x.stage === 'review' || x.stage === 'failed') return null;
  const refund = x.stage === 'refunded' || x.outKind === 'refund' || x.refundPlanned;
  return (
    <div className="space-y-3">
      <ol className="space-y-1.5 text-[13.5px]" aria-label={t('xsProgress')}>{ORDER.map((s, k) => { const done = k < at, cur = k === at;
        return <li key={s} className={`flex items-center gap-2.5 ${done ? '' : cur ? 'font-medium' : 'text-mute'}`} aria-current={cur ? 'step' : undefined}>
          <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${done ? (s === 'received' && refund ? 'bg-warn/15 text-warn' : 'bg-emerald/15 text-emerald') : cur ? 'bg-primary text-onprimary' : 'bg-elev text-mute'}`}>{done ? <Icon n={s === 'received' && refund ? 'warn' : 'check'} className="h-3 w-3" /> : cur ? <Icon n="spin" className="h-3 w-3" /> : k + 1}</span>
          <span>{t((s === 'received' && refund ? 'xsStep_refunded' : `xsStep_${s}`) as Key, { net: x.toNetworkName })}{done ? '' : cur ? ' …' : ''}</span></li>; })}</ol>
      {x.stage === 'refunded' && <Notice tone="warn">{t('xsRefundedNote', { amount: trimAmt(x.refundedDisplay ?? '0', 10), sym: symbol })}</Notice>}
      {x.refundPlanned && !x.done && <Notice tone="warn">{t('xsRefundPlanned')}</Notice>}
      {x.hold && <Notice tone={['vault_churned', 'outbound_mismatch', 'below_minimum'].includes(x.hold) ? 'danger' : 'warn'}>{t(`xsHold_${x.hold}` as Key)}{x.holdDetail ? <span className="block text-mute">{x.holdDetail}</span> : null}</Notice>}
      {!x.done && <p className="text-[12.5px] text-mute">{t('xsWait', { time: dur(x.estimatedSeconds) })}</p>}
      {err && <Notice tone="danger">{err}</Notice>}
      {x.outExplorer && <a className="inline-flex items-center gap-1.5 text-sm text-blue" href={x.outExplorer} target="_blank" rel="noreferrer noopener"><Icon n="ext" className="h-4 w-4" />{t(x.outKind === 'refund' ? 'xsViewRefund' : 'xsViewOut', { net: x.toNetworkName })}</a>}
      {!x.done && <Btn full kind="soft" busy={busy} onClick={() => void refresh()}><Icon n="check" className="h-4 w-4" />{t('xsRefresh')}</Btn>}
    </div>);
}

/** Review and tracking sheet body. */
export function XswapSheet({ prop, left, onUpdate }: { prop: any; left: number; onUpdate: (p: any) => void }) {
  const t = useT(); const x = prop.xswap as XswapV;
  return <>
    <div className="rounded-2xl bg-elev/70 p-4">
      <div className="text-[13px] text-mute">{t('swYouPay')}</div>
      <div className="text-[24px] font-semibold tracking-tight">{prop.amountDisplay} <span className="text-mute">{prop.symbol}</span></div>
      <div className="mt-3 text-[13px] text-mute">{x.receivedDisplay ? t('swReceived') : x.refundedDisplay ? t('xsRefunded') : t('swMinGuaranteed')}</div>
      <div className="text-[24px] font-semibold tracking-tight">{x.refundedDisplay && !x.receivedDisplay ? <>{trimAmt(x.refundedDisplay, 10)} <span className="text-mute">{prop.symbol}</span></> : <>{trimAmt(x.receivedDisplay ?? x.minOutDisplay, 10)} <span className="text-mute">{x.toSymbol}</span></>}</div>
    </div>
    <dl className="mt-3 space-y-2 text-[13.5px]">
      <XswapFacts x={x} symbol={prop.symbol} fromName={prop.networkName} />
      <div className="flex justify-between gap-3"><dt className="text-mute">{t('feeMax')} · {prop.networkName}</dt><dd>{prop.maxFeeDisplay ? `${trimAmt(prop.maxFeeDisplay, 9)} ${prop.feeSymbol}` : '—'}</dd></div>
      {prop.intentHash && <div><dt className="text-mute">{t('fingerprint')}</dt><dd className="break-all font-mono text-[11px] text-mute">{prop.intentHash}</dd></div>}
      {prop.txid && ['broadcast', 'confirming', 'finalized', 'failed'].includes(prop.state) && <div><dt className="text-mute">{t('txid')}</dt><dd className="break-all font-mono text-[11px]">{prop.txid}</dd></div>}
    </dl>
    {prop.state === 'pending_approval' && <div className="mt-3 space-y-3">
      <Notice tone="ok">{t('xsGuarantee', { to: x.toNetworkName })}</Notice>
      <Notice tone="warn">{t('xsTrust', { n: x.operators.length })}</Notice>
      <Notice tone="info">{t('xsRefundRule', { from: prop.networkName })}</Notice>
      {x.needsApproval && <Notice tone="info">{t('swNeedsApproval', { sym: prop.symbol })}</Notice>}
      <Notice tone="info">{t('xsIrreversible')} {t('expiresIn')} {left} s.</Notice>
    </div>}
    {prop.error && ['failed', 'expired', 'rejected'].includes(prop.state) && <div className="mt-3"><Notice tone="danger">{prop.error}</Notice></div>}
    {prop.state !== 'pending_approval' && <div className="mt-4"><XswapProgress id={prop.id} x={x} symbol={prop.symbol} onUpdate={onUpdate} /></div>}
  </>;
}
