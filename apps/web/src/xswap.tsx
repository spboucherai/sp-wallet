// Native cross-chain swap (THORChain): what the owner approves — vault address included — and the progress of the swap,
// shared by Swap and Activity. A refund is shown as a refund, never as a success.
import { useState } from 'react';
import { post } from './api';
import { errText, useT, type Key } from './i18n';
import { holdDetail, propError } from './sv';
import { Btn, exactAmt, Fact, Icon, NetworkIcon, Notice, Tag, testNotSent, Timeline, trimAmt, type StepState, type Tone } from './ui';
import { ExplorerLink, LongFact, ReviewAmount, ReviewArrow } from './bridge';

export interface XswapV {
  provider: string; toNetwork: string; toNetworkName: string; toSymbol: string;
  stage: 'review' | 'sending' | 'sent' | 'observed' | 'outbound' | 'received' | 'refunded' | 'failed';
  expectedOutDisplay: string; minOutDisplay: string; outboundFeeDisplay: string; liquidityFeeDisplay: string; estimatedSeconds: number | null; slippageBps: number;
  vault: string; vaultExplorer: string; memo: string; router: string | null; operators: string[]; quoteOperators: string[]; vaultMembers: number; evidenceMultiple: number; evidenceTransfersOut: number | null;
  needsApproval: boolean; approvalState: string | null; hold: string | null; holdDetail: string | null; holdCode?: string | null; holdParams?: Record<string, string | number> | null; refundPlanned: boolean;
  outTxid: string | null; outKind: 'out' | 'refund' | null; outExplorer: string | null; receivedDisplay: string | null; refundedDisplay: string | null; done: boolean;
}
const dur = (s: number | null) => (s === null ? '—' : s < 90 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`);
const ORDER = ['sent', 'observed', 'outbound', 'received'] as const;
const AT: Record<XswapV['stage'], number> = { review: -1, failed: -1, sending: 0, sent: 1, observed: 2, outbound: 3, received: 4, refunded: 4 };
const TONE: Record<XswapV['stage'], Tone> = { review: 'warn', sending: 'info', sent: 'info', observed: 'info', outbound: 'info', received: 'ok', refunded: 'warn', failed: 'danger' };

/** Status is always icon + text, never colour alone. */
export function XswapPill({ x }: { x: XswapV }) {
  const t = useT();
  return <Tag tone={TONE[x.stage]} icon={x.stage === 'received' ? 'check' : x.stage === 'failed' ? 'x' : x.stage === 'refunded' ? 'warn' : 'clock'}>{t(`xsStage_${x.stage}` as Key)}</Tag>;
}

/** Everything the passkey approval covers, vault address and memo in full. */
export function XswapFacts({ x, symbol, fromName }: { x: XswapV; symbol: string; fromName: string }) {
  const t = useT();
  return <>
    <Fact k={t('xsRoute')}>{`${fromName} → `}<span className="inline-flex items-center gap-1.5 align-middle"><NetworkIcon net={x.toNetwork} size={16} />{x.toNetworkName}</span>{' · THORChain'}</Fact>
    {x.receivedDisplay ? <Fact k={t('swReceived')}>{`${trimAmt(x.receivedDisplay, 10)} ${x.toSymbol}`}</Fact> : x.refundedDisplay ? <Fact k={t('xsRefunded')}>{`${trimAmt(x.refundedDisplay, 10)} ${symbol}`}</Fact> : <Fact k={t('swMinGuaranteed')}>{`${trimAmt(x.minOutDisplay, 10)} ${x.toSymbol}`}</Fact>}
    {!x.done && <Fact k={t('swExpected')}>{`${trimAmt(x.expectedOutDisplay, 10)} ${x.toSymbol}`}</Fact>}
    <Fact k={t('xsOutboundFee')}>{`${trimAmt(x.outboundFeeDisplay, 8)} ${x.toSymbol} · ${t('swIncluded')}`}</Fact>
    <Fact k={t('xsTime')}>{`≈ ${dur(x.estimatedSeconds)}`}</Fact>
    {x.approvalState && <Fact k={t('swApproval')}>{t(`swAppr_${x.approvalState}` as Key)}</Fact>}
    <LongFact k={t('xsVault')} sub={t('xsVaultBy', { n: x.operators.length, ops: x.operators.join(', '), members: x.vaultMembers })}>{x.vault}</LongFact>
    <LongFact k={t('xsMemo')}>{x.memo}</LongFact>
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
      {/* a refund is never drawn as a success: its step is marked « Remboursé », not « fait » */}
      <div className="sw-tl"><Timeline label={t('xsProgress')} items={ORDER.map((s, k) => { const done = k < at, cur = k === at, back = s === 'received' && refund;
        const state: StepState = done ? (back ? 'failed' : 'done') : cur ? 'current' : 'next';
        return { key: s, state, node: done && back ? <Icon n="warn" className="h-[18px] w-[18px]" /> : undefined, title: t((back ? 'xsStep_refunded' : `xsStep_${s}`) as Key, { net: x.toNetworkName }),
          stateLabel: done ? (back ? t('xsStage_refunded') : t('dzBrStepDone')) : cur ? t('dzBrStepNow') : t('dzBrStepNext') }; })} /></div>
      {x.stage === 'refunded' && <Notice tone="warn">{t('xsRefundedNote', { amount: trimAmt(x.refundedDisplay ?? '0', 10), sym: symbol })}</Notice>}
      {x.refundPlanned && !x.done && <Notice tone="warn">{t('xsRefundPlanned')}</Notice>}
      {x.hold && <Notice tone={['vault_churned', 'outbound_mismatch', 'below_minimum'].includes(x.hold) ? 'danger' : 'warn'}>{t(`xsHold_${x.hold}` as Key)}{x.holdDetail ? <span className="block text-mute" data-testid="hold-detail">{holdDetail(t, x)}</span> : null}</Notice>}
      {!x.done && <p className="text-[0.78125rem] text-mute">{t('xsWait', { time: dur(x.estimatedSeconds) })}</p>}
      {err && <Notice tone="danger">{err}</Notice>}
      {x.outExplorer && <ExplorerLink href={x.outExplorer}>{t(x.outKind === 'refund' ? 'xsViewRefund' : 'xsViewOut', { net: x.toNetworkName })}</ExplorerLink>}
      {!x.done && <Btn full kind="soft" busy={busy} onClick={() => void refresh()}><Icon n="check" className="h-4 w-4" />{t('xsRefresh')}</Btn>}
    </div>);
}

/** Review and tracking sheet body: the receipt the passkey signs — every field in full, nothing animated. */
export function XswapSheet({ prop, left, onUpdate }: { prop: any; left: number; onUpdate: (p: any) => void }) {
  const t = useT(); const x = prop.xswap as XswapV;
  return <>
    <div className="rounded-[20px] bg-elev/60 p-4">
      <ReviewAmount label={t('swYouPay')} sym={prop.symbol} net={prop.network}>{exactAmt(prop.amountDisplay)} <span className="text-mute">{prop.symbol}</span></ReviewAmount>
      <ReviewArrow />
      {x.refundedDisplay && !x.receivedDisplay
        ? <ReviewAmount label={t('xsRefunded')} sym={prop.symbol} net={prop.network}>{trimAmt(x.refundedDisplay, 10)} <span className="text-mute">{prop.symbol}</span></ReviewAmount>
        : <ReviewAmount label={x.receivedDisplay ? t('swReceived') : t('swMinGuaranteed')} sym={x.toSymbol} net={x.toNetwork}>{trimAmt(x.receivedDisplay ?? x.minOutDisplay, 10)} <span className="text-mute">{x.toSymbol}</span></ReviewAmount>}
    </div>
    <dl className="receipt mt-2">
      <XswapFacts x={x} symbol={prop.symbol} fromName={prop.networkName} />
      <Fact k={`${t('feeMax')} · ${prop.networkName}`}>{prop.maxFeeDisplay ? `${trimAmt(prop.maxFeeDisplay, 9)} ${prop.feeSymbol}` : '—'}</Fact>
      {prop.intentHash && <LongFact k={t('fingerprint')} mute>{prop.intentHash}</LongFact>}
      {prop.txid && ['broadcast', 'confirming', 'finalized', 'failed'].includes(prop.state) && <LongFact k={t('txid')}>{prop.txid}</LongFact>}
    </dl>
    {prop.state === 'pending_approval' && <div className="mt-3 space-y-3">
      <Notice tone="ok">{t('xsGuarantee', { to: x.toNetworkName })}</Notice>
      <Notice tone="warn">{t('xsTrust', { n: x.operators.length })}</Notice>
      <Notice tone="info">{t('xsRefundRule', { from: prop.networkName })}</Notice>
      {x.needsApproval && <Notice tone="info">{t('swNeedsApproval', { sym: prop.symbol })}</Notice>}
      <Notice tone="info">{t('xsIrreversible')} {t('expiresIn')} {left} s.</Notice>
    </div>}
    {prop.error && ['failed', 'expired', 'rejected'].includes(prop.state) && <div className="mt-3"><Notice tone="danger">{propError(t, prop)}</Notice></div>}
    {/* v11: signed on a server that does not broadcast — nothing was sent to the vault, so there is no progress to show */}
    {testNotSent(prop) ? <div className="mt-3"><Notice tone="warn">{t('qaTestNotSent')}</Notice></div>
      : prop.state !== 'pending_approval' && <div className="mt-4"><XswapProgress id={prop.id} x={x} symbol={prop.symbol} onUpdate={onUpdate} /></div>}
  </>;
}
