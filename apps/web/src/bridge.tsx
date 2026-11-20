// Cross-chain USDC transfer (Circle CCTP): progress of the two legs and the "finish" action, shared by Swap and Activity.
import { useState, type ReactNode } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { get, post } from './api';
import { ApprovalOutcomePanel, useApprovalOutcome } from './approvalUi';
import { useContext } from 'react';
import { errText, I18n, useT, type Key } from './i18n';
import { holdDetail } from './sv';
import { AssetIcon, Btn, Fact, Icon, NetworkIcon, Notice, ProviderIcon, Tag, Timeline, trimAmt, type StepState, type Tone } from './ui';

export interface BridgeV {
  provider: string; toNetwork: string; toNetworkName: string; speed: 'standard' | 'fast'; expectedSeconds: number;
  stage: 'review' | 'burning' | 'attesting' | 'ready' | 'minting' | 'mint_failed' | 'done' | 'failed';
  cctpMaxFeeDisplay: string; minReceiveDisplay: string; feeExecutedDisplay: string | null; receivedDisplay: string | null; destGasSymbol: string; destGasNeedDisplay: string;
  needsApproval: boolean; approvalState: string | null; hold: string | null; holdDetail: string | null; holdCode?: string | null; holdParams?: Record<string, string | number> | null; irisStatus: string | null; delayReason: string | null;
  mintTxid: string | null; mintExplorer: string | null; mintedBy: 'wallet' | 'other' | null; canFinish: boolean; needsPasskey: boolean;
  /** v8: the Solana side of a Solana ↔ EVM transfer */
  sol?: { role: 'source' | 'destination'; symbol: string; recipient: string | null; tokenAccount: string | null; nonceRentDisplay: string | null; eventAccount: string | null; depositDisplay: string | null;
    reclaimableAt: string | null; reclaimEstimated: boolean; reclaimState: 'pending' | 'locked' | 'available' | 'failed' | 'sent' | 'done' | null; reclaimError: string | null; reclaimTxid: string | null; reclaimExplorer: string | null; reclaimedDisplay: string | null } | null;
}
// v8 — Solana: holds and errors worded in the `sc` block; anything else keeps its existing wording
const SC_HOLDS = ['token_account_missing', 'mint_expired', 'account_frozen', 'rent_changed', 'account_not_plain', 'denylisted'];
const holdKey = (h: string): Key => (SC_HOLDS.includes(h) ? `scHold_${h}` : `brHold_${h}`) as Key;
const SC_ERRS = ['token_account_missing', 'reclaim_not_yet', 'rent_changed', 'contract_changed', 'denylisted', 'account_frozen', 'fee_ceiling'];
/** error text of the Solana bridge routes: a translated sentence for their own codes (with the server's figures when it gives some), the common wording otherwise */
export function scErrText(t: (k: Key, v?: Record<string, string | number>) => string, e: unknown): string {
  const x = e as { code?: string; message?: string };
  if (x?.code && SC_ERRS.includes(x.code)) return x.message && /\d/.test(x.message) && x.code !== 'token_account_missing' ? `${t(`scE_${x.code}` as Key)} (${x.message})` : t(`scE_${x.code}` as Key);
  return errText(t as never, e);
}
const day = (iso: string, locale: string) => new Date(iso).toLocaleString(locale === 'fr' ? 'fr-CA' : 'en-CA', { dateStyle: 'medium', timeStyle: 'short' });
export const bridgeDur = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`);
const ORDER = ['burning', 'attesting', 'minting', 'done'] as const;
const TONE: Record<BridgeV['stage'], Tone> = { review: 'warn', burning: 'info', attesting: 'info', ready: 'warn', minting: 'info', mint_failed: 'danger', done: 'ok', failed: 'danger' };

// ── v10: small pieces shared by the review sheets of this area (Swap, bridge, THORChain, plans). Local to the area. ─────
/** A long technical value of a receipt (fingerprint, transaction id, vault, memo): label above, the WHOLE value below, monospace. */
export function LongFact({ k, children, sub, mute, testid }: { k: ReactNode; children: ReactNode; sub?: ReactNode; mute?: boolean; testid?: string }) {
  return <div className="fact sw-longfact" data-testid={testid}><dt>{k}</dt><dd className={`break-all font-mono text-[12px] leading-relaxed ${mute ? 'text-mute' : ''}`}>{children}</dd>{sub && <dd className="sw-longfact-sub">{sub}</dd>}</div>;
}
/** One amount of a review (what leaves, what is guaranteed) with its real logo: static text — never animated, never shortened. */
export function ReviewAmount({ label, sym, net, children, sub }: { label: ReactNode; sym: string; net?: string; children: ReactNode; sub?: ReactNode }) {
  return <div className="flex items-start gap-3.5"><AssetIcon sym={sym} net={net} size={44} ring="var(--elev)" />
    <div className="min-w-0 flex-1"><div className="text-[13px] text-mute">{label}</div>
      <div className="t-display break-words text-[clamp(25px,7.6vw,32px)] !leading-[1.12]">{children}</div>
      {sub && <div className="mt-1 text-[13px] text-mute">{sub}</div>}</div></div>;
}
/** The arrow between the two amounts of a review. */
export function ReviewArrow() { return <div className="flex h-7 w-11 items-center justify-center text-mute" aria-hidden="true"><Icon n="down" className="h-4 w-4" /></div>; }
/** A link to a block explorer, 44 px high. */
export function ExplorerLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="inline-flex min-h-11 items-center gap-1.5 text-[14px] font-medium text-blue" href={href} target="_blank" rel="noreferrer noopener"><Icon n="ext" className="h-4 w-4" />{children}</a>;
}

/** Status is always icon + text, never colour alone. */
export function BridgePill({ b }: { b: BridgeV }) {
  const t = useT();
  return <Tag tone={TONE[b.stage]} icon={b.stage === 'done' ? 'check' : b.stage === 'failed' || b.stage === 'mint_failed' ? 'x' : 'clock'}>{t(`brStage_${b.stage}` as Key)}</Tag>;
}

/** The four steps, what the transfer is waiting for, and the finish / approve-again action. `onUpdate` receives the fresh proposal. `fromNetwork` (when known) puts the source network's logo on the first step. */
export function BridgeProgress({ id, b, onUpdate, fromNetwork }: { id: string; b: BridgeV; onUpdate: (p: any) => void; fromNetwork?: string }) {
  const t = useT(); const [busy, setBusy] = useState(false), [err, setErr] = useState(''); const ap = useApprovalOutcome<any>();
  const at = b.stage === 'ready' ? 1 : b.stage === 'mint_failed' ? 2 : ORDER.indexOf(b.stage as (typeof ORDER)[number]);
  const finish = async () => {
    setBusy(true); setErr('');
    let assertion;
    try {
      if (!b.needsPasskey) { onUpdate(await post(`/bridge/proposals/${id}/finish`)); return; }
      // the single automatic mint signature is spent: a new one needs the passkey, over the exact new transaction
      const o = await post<{ proposal: any; options: any }>(`/bridge/proposals/${id}/retry-mint/options`);
      if (!o.proposal.bridge?.needsPasskey) { onUpdate(o.proposal); return; }
      assertion = await startAuthentication({ optionsJSON: o.options });
    } catch (e) { const m = errText(t, e); if (m) setErr(m); return; } finally { if (!assertion) setBusy(false); }
    // NEXT W1: the approval leaves the browser — a lost answer is settled by the transfer read from the server, never by the error
    await ap.run({ submit: () => post<any>(`/bridge/proposals/${id}/retry-mint`, { assertion }), read: () => get<any>(`/transfers/proposals/${id}`), applied: (p) => !p.bridge?.needsPasskey || p.bridge.stage !== b.stage }, (o) => {
      if (o.kind === 'refused') { const m = errText(t, o.error); if (m) setErr(m); return; }
      onUpdate(o.kind === 'answered' ? o.value : o.state); if (o.kind === 'read' && !o.applied) setErr(t('nxNotReceived'));
    });
    setBusy(false);
  };
  if (b.stage === 'review' || b.stage === 'failed') return null;
  const node = (s: (typeof ORDER)[number]) => (s === 'burning' ? (fromNetwork ? <NetworkIcon net={fromNetwork} size={24} /> : undefined) : s === 'attesting' ? <ProviderIcon provider="cctp" size={24} /> : <NetworkIcon net={b.toNetwork} size={24} />);
  return (
    <div className="space-y-3">
      <div className="sw-tl"><Timeline label={t('brProgress')} items={ORDER.map((s, k) => { const done = b.stage === 'done' || k < at, cur = k === at && b.stage !== 'done', bad = cur && b.stage === 'mint_failed';
        const state: StepState = done ? 'done' : bad ? 'failed' : cur ? 'current' : 'next';
        return { key: s, state, node: node(s), title: t(`brStep_${s}` as Key, { net: b.toNetworkName }), stateLabel: bad ? t('brStage_mint_failed') : t(done ? 'dzBrStepDone' : cur ? 'dzBrStepNow' : 'dzBrStepNext') }; })} /></div>
      {b.stage === 'attesting' && !b.hold && <p className="text-[13px] text-mute">{t('brWaitAttest', { time: bridgeDur(b.expectedSeconds) })}{b.delayReason ? ` (${b.delayReason})` : ''}</p>}
      {b.hold && b.stage !== 'done' && <Notice tone={b.stage === 'mint_failed' || b.hold === 'message_mismatch' || b.hold === 'contract_changed' ? 'danger' : 'warn'}>{t(holdKey(b.hold))}{b.holdDetail ? <span className="block text-mute" data-testid="hold-detail">{holdDetail(t, b)}</span> : null}</Notice>}
      {b.stage !== 'done' && <p className="text-[12.5px] text-mute">{t('brSafe')}</p>}
      {b.stage === 'done' && b.mintedBy === 'other' && <p className="text-[13px] text-mute">{t('brMintedByOther')}</p>}
      {err && !ap.locked && <Notice tone="danger">{err}</Notice>}
      <ApprovalOutcomePanel ap={ap} />
      {b.mintExplorer && <ExplorerLink href={b.mintExplorer}>{t('brViewMint', { net: b.toNetworkName })}</ExplorerLink>}
      {b.canFinish && !ap.locked && <Btn full kind={b.needsPasskey ? 'primary' : 'soft'} busy={busy} onClick={() => void finish()}><Icon n={b.needsPasskey ? 'key' : 'check'} className="h-4 w-4" />{b.needsPasskey ? t('brFinishPasskey') : t('brFinish')}</Btn>}
      {b.sol?.role === 'source' && b.sol.reclaimState && <SolDeposit id={id} b={b} onUpdate={onUpdate} />}
    </div>);
}

/** v8 — the refundable deposit of the message account of a burn made on Solana: where it stands, and "récupérer le dépôt" (passkey) once the program allows it. */
export function SolDeposit({ id, b, onUpdate }: { id: string; b: BridgeV; onUpdate: (p: any) => void }) {
  const t = useT(); const { locale } = useContext(I18n); const [busy, setBusy] = useState(false), [err, setErr] = useState(''); const ap = useApprovalOutcome<any>();
  const s = b.sol!; const st = s.reclaimState!;
  const reclaim = async () => {
    setBusy(true); setErr('');
    let assertion;
    try {
      const o = await post<{ proposal: any; options: any }>(`/bridge/proposals/${id}/reclaim/options`);
      assertion = await startAuthentication({ optionsJSON: o.options });
    } catch (e) { const m = scErrText(t, e); if (m) setErr(m); setBusy(false); return; }
    // NEXT W1: a lost answer is settled by the transfer read from the server (its reclaim state), never by the error
    await ap.run({ submit: () => post<any>(`/bridge/proposals/${id}/reclaim`, { assertion }), read: () => get<any>(`/transfers/proposals/${id}`), applied: (p) => (p.bridge?.sol?.reclaimState ?? st) !== st }, (o) => {
      if (o.kind === 'refused') { const m = scErrText(t, o.error); if (m) setErr(m); return; }
      onUpdate(o.kind === 'answered' ? o.value : o.state); if (o.kind === 'read' && !o.applied) setErr(t('nxNotReceived'));
    });
    setBusy(false);
  };
  const vars = { dep: trimAmt(s.depositDisplay ?? '0', 9), date: s.reclaimableAt ? day(s.reclaimableAt, locale) : '—', got: trimAmt(s.reclaimedDisplay ?? '0', 9) };
  return (
    <div className="rounded-2xl bg-elev/60 p-4 text-[13.5px]" data-testid="sol-deposit" data-state={st}>
      <div className="mb-1.5 flex items-center gap-2"><NetworkIcon net="solana" size={18} /><span className="t-eyebrow">{t('scReclaimTitle')}</span></div>
      <p className={st === 'done' ? 'flex gap-1.5 text-emerald' : ''}>{st === 'done' && <Icon n="check" className="mt-0.5 h-4 w-4 shrink-0" />}<span>{t(`scReclaim_${st}` as Key, vars)}</span></p>
      {st === 'failed' && s.reclaimError && <p className="mt-1 text-mute">{s.reclaimError}</p>}
      {err && !ap.locked && <div className="mt-2"><Notice tone="danger">{err}</Notice></div>}
      <ApprovalOutcomePanel ap={ap} className="mt-2" />
      {(st === 'available' || st === 'failed') && !ap.locked && <div className="mt-3"><Btn full kind="primary" busy={busy} onClick={() => void reclaim()}><Icon n="key" className="h-4 w-4" />{t('scReclaimBtn')}</Btn></div>}
      {s.reclaimExplorer && <div className="mt-1"><ExplorerLink href={s.reclaimExplorer}>{t('scReclaimView')}</ExplorerLink></div>}
    </div>);
}

/** Amount, fee and guarantee lines of a transfer, for the review sheet and the activity list. */
export function BridgeFacts({ b, symbol }: { b: BridgeV; symbol: string }) {
  const t = useT(); const { locale } = useContext(I18n); const s = b.sol;
  const toNet = <span className="inline-flex items-center gap-1.5 align-middle"><NetworkIcon net={b.toNetwork} size={16} />{b.toNetworkName}</span>;
  return <>
    <Fact k={t('brSpeed')}>{`${t(`brSpeed_${b.speed}` as Key)} · ≈ ${bridgeDur(b.expectedSeconds)}`}</Fact>
    <Fact k={b.feeExecutedDisplay !== null ? t('brFeeTaken') : t('brFeeMax')}>{`${trimAmt(b.feeExecutedDisplay ?? b.cctpMaxFeeDisplay, 6)} ${symbol}`}</Fact>
    <Fact k={b.receivedDisplay ? t('swReceived') : t('swMinGuaranteed')}>{`${trimAmt(b.receivedDisplay ?? b.minReceiveDisplay, 6)} ${symbol} · `}{toNet}</Fact>
    {b.stage === 'review' && <Fact k={t('brDestGas')}>{`≈ ${trimAmt(b.destGasNeedDisplay, 8)} ${b.destGasSymbol} · `}{toNet}</Fact>}
    {b.approvalState && <Fact k={t('swApproval')}>{t(`swAppr_${b.approvalState}` as Key)}</Fact>}
    {s?.role === 'source' && s.depositDisplay && <Fact k={t('scDeposit')}>{s.reclaimState === 'done' ? t('scDepositBack', { dep: trimAmt(s.depositDisplay, 9) }) : t(s.reclaimEstimated ? 'scDepositValEst' : 'scDepositVal', { dep: trimAmt(s.depositDisplay, 9), date: s.reclaimableAt ? day(s.reclaimableAt, locale) : '—' })}</Fact>}
    {s?.role === 'destination' && s.tokenAccount && <LongFact k={<>{t('scRecipient')} · <span className="text-ink">{t('scRecipientVal')}</span></>} mute>{s.tokenAccount}</LongFact>}
    {s?.role === 'destination' && s.nonceRentDisplay && b.stage === 'review' && <Fact k={t('scNonceRent')}>{t('scNonceRentVal', { rent: trimAmt(s.nonceRentDisplay, 9) })}</Fact>}
  </>;
}
