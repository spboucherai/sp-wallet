/**
 * The two passkey-approved actions of a venue account, each in its own sheet:
 *   order / close :  proposal (POST …/orders or …/close, with ONE Idempotency-Key per review) → the canonical order shown field
 *                    by field + estimate + countdown → passkey → approve → the order's state, from the server;
 *   leverage      :  proposal → canonical → passkey → approve → the venue's own setting read back.
 *
 * Safety of the screen itself:
 *  - the proposal is made once per key (a double click or a re-render cannot make a second one); "prepare again" takes a new key;
 *  - the approve button exists only while the proposal is approvable: not expired (3 s margin), and equal to what was asked;
 *  - a cancelled or failed passkey prompt, an expiry, or closing the sheet WITHDRAWS the proposal on the server (no passkey
 *    needed), so nothing approvable is left behind; the only thing ever re-sent as is, is an approval whose answer was lost;
 *  - `unknown` is shown as being checked on the venue, with no button that could send the order again.
 */
import { startAuthentication } from '@simplewebauthn/browser';
import { useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useRef, useState } from 'react';
import { I18n, useT, type Key } from '../i18n';
import { Btn, Icon, Notice } from '../ui';
import { Row, Sheet } from './bits';
import { fmt, usd } from './dec';
import { CanonicalRows, Countdown, LiveErrNotice, ModeBand, OrderOutcome, SourceTag } from './LiveBits';
import { canonicalProblem, closeProblem, inFlight, lapi, liveError, newKey, remainingMs, toneOf, type LeverageProposal, type LeverageResult, type LiveErr, type LiveOrder, type LiveOrderBody, type LiveSummary, type Proposal } from './live';
import { refreshLive } from './liveStore';
import type { Instrument, Position } from './types';

export type ApprovalRequest = { kind: 'order'; body: LiveOrderBody } | { kind: 'close'; position: Position; fraction: string };
type Phase = 'proposing' | 'ready' | 'passkey' | 'sending' | 'resend' | 'done' | 'void';
const local = (key: string, detail = ''): LiveErr => ({ key, code: key, status: 0, detail, consumed: true, retry: false });

export function ApprovalSheet({ account, instrument, request, orders, ttlMs, onClose }: { account: LiveSummary; instrument: Instrument | undefined; request: ApprovalRequest; /** the account's orders, kept current by the stream */ orders: LiveOrder[];
  ttlMs: number; onClose: (clientId: string | null) => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const tone = toneOf(account);
  const [key, setKey] = useState(() => newKey(request.kind));
  const [phase, setPhase] = useState<Phase>('proposing'), [p, setP] = useState<Proposal | null>(null), [skew, setSkew] = useState(0);
  const [err, setErr] = useState<LiveErr | null>(null), [sent, setSent] = useState<LiveOrder | null>(null);
  const started = useRef<string | null>(null), assertion = useRef<unknown>(null), phaseRef = useRef<Phase>('proposing');
  phaseRef.current = phase;
  const lock = useRef(false);
  /**
   * Nothing approvable stays on the server once the screen has given up on a proposal. The server is asked first what the order
   * is: only a proposal that was never approved is withdrawn (a local row, nothing was signed) — an order that reached the
   * venue is never cancelled from here.
   */
  const withdraw = (k: string) => { void (async () => {
    try { const d = await lapi.account(account.id), o = d.orders.find((x) => x.clientId === k); if (o && (o.state === 'proposed' || o.state === 'risk_checked')) await lapi.cancel(account.id, k); } catch { /* it expires by itself after 90 s */ }
    void refreshLive(qc, account.id);
  })(); };
  const fail = (e: LiveErr, k = key) => { setErr(e); setPhase('void'); withdraw(k); };

  const propose = async (k: string) => {
    setPhase('proposing'); setErr(null); setP(null); assertion.current = null;
    try {
      const r = request.kind === 'order' ? await lapi.propose(account.id, request.body, k) : await lapi.close(account.id, request.position.instrument, request.fraction, k);
      setP(r);
      if (!r.options) { setSent(r.order); setPhase('done'); return; }             // an answer for a key already used: show what that order became
      const why = request.kind === 'order' ? canonicalProblem(request.body, r.canonical) : closeProblem(request.position, r.canonical);
      if (why) { fail(local('canonical_mismatch', why), k); return; }
      setSkew(r.idempotent ? 0 : Date.now() - r.order.updatedAt);
      if (remainingMs(r.expiresAt, Date.now(), r.idempotent ? 0 : Date.now() - r.order.updatedAt) <= 0) { fail(local('proposal_expired'), k); return; }
      setPhase('ready');
    } catch (e) {
      const le = liveError(e, 'propose');
      setErr(le); setPhase(le.retry ? 'resend' : 'void');
    } finally { void refreshLive(qc, account.id); }
  };
  useEffect(() => { if (started.current === key) return; started.current = key; void propose(key); }, [key]);   // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    setPhase('sending'); setErr(null);
    try { const r = await lapi.approveOrder(account.id, key, assertion.current); setSent(r.order); setPhase('done'); }
    catch (e) { const le = liveError(e, 'approve'); if (le.retry) { setErr(le); setPhase('resend'); } else fail(le); }
    finally { void refreshLive(qc, account.id); }
  };
  const approve = async () => {
    if (lock.current || phaseRef.current !== 'ready' || !p?.options) return;     // one prompt, one approval, however fast the button is pressed
    lock.current = true;
    try {
      setPhase('passkey'); setErr(null);
      let a: unknown;
      try { a = await startAuthentication({ optionsJSON: p.options }); }
      catch (e) { fail(liveError(e, 'approve')); return; }
      if (remainingMs(p.expiresAt, Date.now(), skew) <= 0) { fail(local('proposal_expired')); return; }   // the prompt was answered too late: nothing is sent
      assertion.current = a;
      await send();
    } finally { lock.current = false; }
  };
  const again = () => { setSent(null); setKey(newKey(request.kind)); };
  const close = () => {
    if (phase === 'sending' || phase === 'passkey') return;                        // an approval is on its way: its answer must be seen
    if (phase === 'proposing' || phase === 'ready' || (phase === 'resend' && !assertion.current)) withdraw(key);
    onClose(sent || phase === 'resend' ? key : null);
  };

  const current = orders.find((o) => o.clientId === key), order = current && (!sent || current.updatedAt >= sent.updatedAt) ? current : sent;
  const c = p?.canonical ?? null, est = p?.estimate ?? null;
  const title = t(request.kind === 'close' ? 'flCloseTitle' : 'flApproveTitle');
  const passkeyLabel = t(tone === 'mainnet' ? 'flApproveReal' : 'flApproveTestnet');
  return <Sheet title={title} onClose={close}>
    <div className="space-y-3" data-testid="approval-sheet" data-phase={phase}>
      <ModeBand tone={tone} label={account.label} />
      {phase === 'proposing' && <p className="flex items-center gap-2 py-6 text-[13.5px] text-mute"><Icon n="spin" className="h-4 w-4" />{t('flProposing')}</p>}

      {c && phase !== 'proposing' && phase !== 'done' && <>
        <h3 className="text-[13px] font-semibold">{t('flSignedExactly')}</h3>
        <div className={`rounded-2xl bg-elev/70 p-3 ${phase === 'void' ? 'opacity-50' : ''}`}><CanonicalRows c={c} instrument={instrument} /></div>
        {request.kind === 'close' && p?.slippageBoundBps ? <p className="text-[12px] leading-snug text-mute">{t('flCloseBound', { bps: p.slippageBoundBps, pct: fmt(String(p.slippageBoundBps / 100), { locale, trim: true }) })}</p> : null}
        {est && <div className={`rounded-2xl border border-line p-3 ${phase === 'void' ? 'opacity-50' : ''}`}>
          <div className="mb-1 flex items-center justify-between"><span className="text-[12.5px] font-semibold">{t('flEstimate')}</span><SourceTag source="estimate" /></div>
          <Row label={t('fxNotional')}>{usd(est.notional, locale)}</Row><Row label={t('fxInitialMargin')}>{usd(est.initialMargin, locale)}</Row>
          <Row label={t('flFeeMax')}>{usd(est.fee, locale)}</Row><Row label={t('fxFreeAfter')}>{usd(est.freeCollateralAfter, locale)}</Row>
          <Row label={t('flVenueLeverage')}>{fmt(est.leverage, { locale, trim: true })}× · {t(est.marginMode === 'cross' ? 'fxCross' : 'fxIsolated')}</Row>
          <p className="mt-1 text-[11.5px] leading-snug text-mute">{t('flLiqNote')}</p></div>}
        {p?.hash && <p className="break-all font-mono text-[10.5px] leading-snug text-mute">{t('fingerprint')} SHA-256 {p.hash}</p>}
      </>}

      {phase === 'ready' && p?.expiresAt && <Countdown expiresAt={p.expiresAt} skewMs={skew} ttlMs={ttlMs} onExpire={() => { if (phaseRef.current === 'ready') fail(local('proposal_expired')); }} />}
      {phase === 'passkey' && <Notice tone="info">{t('flPasskeyWaiting')}</Notice>}
      {phase === 'sending' && <p className="flex items-center gap-2 text-[13.5px] text-mute"><Icon n="spin" className="h-4 w-4" />{t('flSending')}</p>}
      {err && <LiveErrNotice err={err} tone={err.key === 'passkey_cancelled' ? 'warn' : 'danger'}>{phase === 'void' && <span className="mt-1 block">{t('flVoidNote')}</span>}</LiveErrNotice>}
      {phase === 'done' && order && <><OrderOutcome order={order} instrument={instrument} />
        {inFlight(order.state) && <Notice tone="warn">{t('flUnknownNote')}</Notice>}
        {order.canonical && <details className="rounded-2xl border border-line p-3 text-[13px]"><summary className="cursor-pointer text-[12.5px] font-semibold">{t('flWhatWasSigned')}</summary><div className="mt-2"><CanonicalRows c={order.canonical} instrument={instrument} /></div></details>}</>}

      {phase === 'ready' && <Btn full kind={tone === 'mainnet' ? 'danger' : 'primary'} onClick={() => void approve()}><Icon n="key" className="h-4 w-4" />{passkeyLabel}</Btn>}
      {phase === 'resend' && (assertion.current
        ? <Btn full onClick={() => void send()}>{t('flResendApproval')}</Btn>
        : <Btn full onClick={() => void propose(key)}>{t('retry')}</Btn>)}
      {phase === 'void' && <Btn full kind="soft" onClick={again} data-testid="prepare-again">{t('flPrepareAgain')}</Btn>}
      <Btn full kind="ghost" disabled={phase === 'sending' || phase === 'passkey'} onClick={close}>{t(phase === 'done' ? 'fxClose' : 'cancel')}</Btn>
      {(phase === 'ready' || phase === 'proposing') && <p className="text-center text-[11.5px] leading-snug text-mute">{t('flCancelWithdraws')}</p>}
    </div>
  </Sheet>;
}

/** leverage is a setting of the VENUE, per instrument: changing it is a signed action, approved with the passkey */
export function LeverageSheet({ account, instrument, max, current, onRead, onClose }: { account: LiveSummary; instrument: Instrument; max: number; current: { leverage: string; marginMode: string } | null;
  /** the venue's own setting, each time the server reads it back */ onRead: (v: { leverage: string; marginMode: string }) => void; onClose: () => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const tone = toneOf(account);
  const [lev, setLev] = useState(() => Math.max(1, Math.min(max, Math.round(Number(current?.leverage ?? 1)) || 1))), [mode, setMode] = useState<'cross' | 'isolated'>(current?.marginMode === 'isolated' ? 'isolated' : 'cross');
  const [phase, setPhase] = useState<'form' | 'proposing' | 'ready' | 'passkey' | 'sending' | 'done' | 'void'>('form');
  const [p, setP] = useState<LeverageProposal | null>(null), [skew, setSkew] = useState(0), [err, setErr] = useState<LiveErr | null>(null), [res, setRes] = useState<LeverageResult | null>(null);
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const lock = useRef(false);
  const busy = phase === 'proposing' || phase === 'passkey' || phase === 'sending';
  const once = async (f: () => Promise<void>) => { if (lock.current) return; lock.current = true; try { await f(); } finally { lock.current = false; } };
  const propose = () => once(async () => {
    if (phaseRef.current !== 'form' && phaseRef.current !== 'void') return;
    setPhase('proposing'); setErr(null);
    try { const r = await lapi.leverage(account.id, { instrument: instrument.id, leverage: lev, marginMode: mode });
      if (r.canonical.instrument !== instrument.id || r.canonical.leverage !== lev || r.canonical.marginMode !== mode) { setErr(local('canonical_mismatch')); setPhase('void'); return; }
      if (r.current) onRead(r.current);
      setP(r); setSkew(Date.now() - r.action.createdAt); setPhase('ready'); }
    catch (e) { setErr(liveError(e, 'propose')); setPhase('void'); }
  });
  const approve = () => once(async () => {
    if (phaseRef.current !== 'ready' || !p) return;
    setPhase('passkey'); setErr(null);
    let a: unknown;
    try { a = await startAuthentication({ optionsJSON: p.options }); } catch (e) { setErr(liveError(e, 'approve')); setPhase('void'); return; }
    if (remainingMs(p.expiresAt, Date.now(), skew) <= 0) { setErr(local('proposal_expired')); setPhase('void'); return; }
    setPhase('sending');
    try { const r = await lapi.approveLeverage(account.id, p.action.id, a); if (r.venue?.leverage) onRead(r.venue.leverage); setRes(r); setPhase('done'); }
    catch (e) { setErr(liveError(e, 'approve')); setPhase('void'); }
    finally { void refreshLive(qc, account.id); void qc.invalidateQueries({ queryKey: ['deriv', 'live', 'preview'] }); }
  });
  const state = res?.action.state;
  return <Sheet title={t('flLevTitle', { symbol: instrument.symbol })} onClose={() => { if (!busy) onClose(); }}>
    <div className="space-y-3" data-testid="leverage-sheet" data-phase={phase}>
      <ModeBand tone={tone} label={account.label} />
      <p className="text-[13px] leading-snug text-mute">{t('flLevIntro')}</p>
      {(phase === 'form' || phase === 'proposing' || phase === 'void') && <>
        <div><div className="mb-1 flex items-baseline justify-between text-[13px]"><label htmlFor="fl-lev" className="text-mute">{t('flLevNew')}</label><span className="font-semibold">{lev}×</span></div>
          <input id="fl-lev" type="range" min={1} max={max} step={1} value={lev} disabled={busy || max <= 1} onChange={(e) => { setLev(Number(e.target.value)); setPhase('form'); setErr(null); }} className="h-11 w-full accent-[var(--blue)]" aria-valuetext={`${lev}×`} />
          <p className="text-[11.5px] leading-snug text-mute">{t('flLevBounds', { max })}{current ? ` ${t('flLevCurrent', { lev: fmt(current.leverage, { locale, trim: true }), mode: t(current.marginMode === 'isolated' ? 'fxIsolated' : 'fxCross') })}` : ''}</p></div>
        <div role="radiogroup" aria-label={t('flLevMode')} className="grid grid-cols-2 gap-2">{(['cross', 'isolated'] as const).filter((m) => instrument.marginModes.includes(m)).map((m) =>
          <button key={m} type="button" role="radio" aria-checked={mode === m} disabled={busy} onClick={() => { setMode(m); setPhase('form'); setErr(null); }} className={`min-h-11 rounded-2xl border text-[14px] font-semibold ${mode === m ? 'border-ink text-ink' : 'border-line text-mute'}`}>{t(m === 'cross' ? 'flLevCross' : 'flLevIsolated')}</button>)}</div>
      </>}
      {p && (phase === 'ready' || phase === 'passkey' || phase === 'sending') && <>
        <h3 className="text-[13px] font-semibold">{t('flSignedExactly')}</h3>
        <div className="rounded-2xl bg-elev/70 p-3" data-testid="canonical">
          <Row label={t('flCInstrument')} strong>{p.canonical.instrument}</Row><Row label={t('flLevNew')} strong>{p.canonical.leverage}×</Row>
          <Row label={t('flLevMode')} strong>{t(p.canonical.marginMode === 'cross' ? 'flLevCross' : 'flLevIsolated')}</Row>
          <Row label={t('flLevNow')}>{p.current ? `${fmt(p.current.leverage, { locale, trim: true })}× · ${t(p.current.marginMode === 'isolated' ? 'fxIsolated' : 'fxCross')}` : '—'} <SourceTag /></Row>
          <Row label={t('flCNetwork')}>{p.canonical.network}</Row></div>
        <p className="break-all font-mono text-[10.5px] leading-snug text-mute">{t('fingerprint')} SHA-256 {p.hash}</p>
        {phase === 'ready' && <Countdown expiresAt={p.expiresAt} skewMs={skew} onExpire={() => { if (phaseRef.current === 'ready') { setErr(local('proposal_expired')); setPhase('void'); } }} />}
      </>}
      {phase === 'passkey' && <Notice tone="info">{t('flPasskeyWaiting')}</Notice>}
      {err && <LiveErrNotice err={err} tone={err.key === 'passkey_cancelled' ? 'warn' : 'danger'} />}
      {phase === 'done' && res && <Notice tone={state === 'confirmed' ? 'ok' : state === 'rejected' ? 'danger' : 'warn'}><div data-testid="leverage-result" data-state={state}>
        {t(`flLev_${state === 'confirmed' || state === 'rejected' ? state : 'unknown'}` as Key, { lev: res.venue?.leverage ? fmt(res.venue.leverage.leverage, { locale, trim: true }) : '—' })}
        {res.action.error && <span className="mt-1 block break-words font-mono text-[11.5px] text-mute">{t('flVenueSays')} {res.action.error}</span>}</div></Notice>}
      {(phase === 'form' || phase === 'void' || phase === 'proposing') && <Btn full busy={phase === 'proposing'} onClick={() => void propose()}>{t(phase === 'void' ? 'flPrepareAgain' : 'flLevPrepare')}</Btn>}
      {(phase === 'ready' || phase === 'passkey' || phase === 'sending') && <Btn full busy={phase !== 'ready'} kind={tone === 'mainnet' ? 'danger' : 'primary'} onClick={() => void approve()}><Icon n="key" className="h-4 w-4" />{t(tone === 'mainnet' ? 'flApproveReal' : 'flApproveTestnet')}</Btn>}
      <Btn full kind="ghost" disabled={busy} onClick={onClose}>{t(phase === 'done' ? 'fxClose' : 'cancel')}</Btn>
    </div>
  </Sheet>;
}
