/**
 * Order panel of a VENUE account (Hyperliquid testnet or mainnet): the live routes only. It builds the order body with exact
 * decimals (size on the lot, prices on the venue's grid — strings, never a JS number), shows the server's live preview (risk
 * verdict on the venue's REAL state + estimate), and hands the order to the approval sheet: proposal → the canonical order →
 * passkey → the state the server reports. Nothing in this file can send an order without that sheet.
 *
 * Sizes are entered in the base asset only: the chart and the book of the terminal are the venue's MAINNET market data, and a
 * testnet account trades at testnet prices — a USD amount converted at the wrong network's price would be the wrong size.
 */
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { I18n, useT, type Key } from '../i18n';
import { Btn, Field, Icon, inputCls, Notice } from '../ui';
import { RISK_CODES } from './api';
import { Row, Seg, Sheet } from './bits';
import { dpOf, fmt, priceDp, usd } from './dec';
import { ApprovalSheet, LeverageSheet } from './LiveApproval';
import { LiveErrNotice, ModeTag, OrderOutcome, SourceTag } from './LiveBits';
import { buildLive, lapi, LIVE_SLIPPAGE_BPS as SLIPPAGE_BPS, liveError, toneOf, type CancelAll, type LiveConfig, type LiveDetail, type LiveErr, type LiveForm, type LiveOrderBody, type LiveSummary } from './live';
import { refreshLive, type LiveConn } from './liveStore';
import type { Instrument } from './types';

function useDebounced<T>(v: T, ms: number): T { const [d, setD] = useState(v); useEffect(() => { const h = setTimeout(() => setD(v), ms); return () => clearTimeout(h); }, [v, ms]); return d; }
const num = (s: string) => s.replace(/[^0-9.,\s ]/g, '');

/** why new orders are stopped, and the ways out — a divergence is explained in plain words, with its two actions */
export function HaltBanner({ account, onDone }: { account: LiveSummary | LiveDetail; onDone?: () => void }) {
  const t = useT(); const qc = useQueryClient();
  const [busy, setBusy] = useState(''), [err, setErr] = useState<LiveErr | null>(null), [ask, setAsk] = useState(false), [note, setNote] = useState('');
  if (!account.halted) return null;
  const run = async (id: string, f: () => Promise<unknown>) => { setBusy(id); setErr(null); setNote(''); try { await f(); await refreshLive(qc, account.id); onDone?.(); } catch (e) { setErr(liveError(e)); } finally { setBusy(''); } };
  return <div className="space-y-2" data-testid="halt-banner" data-kind={account.divergence ? 'divergence' : 'halt'}>
    {account.divergence ? <Notice tone="danger">
      <b className="font-semibold">{t('flDivTitle')}</b> {t('flDivBody')}
      <span className="mt-1 block break-words font-mono text-[11.5px] text-mute">{account.divergence}</span>
      <span className="mt-2 block text-[12.5px]">{t('flDivReconcileHint')}</span>
      <span className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={!!busy} onClick={() => void run('rec', async () => { const r = await lapi.reconcile(account.id); setNote(t(r.divergence ? 'flDivStill' : 'flDivCleared')); })} className="min-h-11 rounded-xl border border-line bg-surface px-3 text-[13px] font-semibold text-ink disabled:opacity-45">{t('flReconcile')}</button>
        <button type="button" disabled={!!busy} onClick={() => setAsk(true)} className="min-h-11 rounded-xl border border-line bg-surface px-3 text-[13px] font-semibold text-ink disabled:opacity-45">{t('flRebase')}</button></span>
    </Notice> : <Notice tone="danger">
      <b className="font-semibold">{t('flHaltTitle')}</b> {t('flHaltBody')}
      <span className="mt-1 block break-words font-mono text-[11.5px] text-mute">{account.halted}</span></Notice>}
    {account.halt && <Btn full kind="soft" busy={busy === 'resume'} onClick={() => void run('resume', () => lapi.resume(account.id))}>{t('flResume')}</Btn>}
    {note && <Notice tone="info">{note}</Notice>}
    {err && <LiveErrNotice err={err} />}
    {ask && <Sheet title={t('flRebaseTitle')} onClose={() => !busy && setAsk(false)}><div className="space-y-3">
      <Notice tone="warn">{t('flRebaseBody')}</Notice>
      <p className="break-words font-mono text-[11.5px] text-mute">{account.divergence}</p>
      <Btn full kind="danger" busy={busy === 'rebase'} onClick={() => void run('rebase', async () => { await lapi.rebase(account.id); setAsk(false); })}>{t('flRebaseConfirm')}</Btn>
      <Btn full kind="ghost" disabled={!!busy} onClick={() => setAsk(false)}>{t('cancel')}</Btn></div></Sheet>}
  </div>;
}

/** the kill switch: three separate, explicit actions — stop new orders, cancel resting orders, (close positions: in the blotter) */
export function LiveControls({ account, openOrders }: { account: LiveSummary; openOrders: number }) {
  const t = useT(); const qc = useQueryClient();
  const [busy, setBusy] = useState(''), [err, setErr] = useState<LiveErr | null>(null), [ask, setAsk] = useState(false), [res, setRes] = useState<CancelAll | null>(null), [note, setNote] = useState(false);
  const run = async (id: string, f: () => Promise<unknown>) => { setBusy(id); setErr(null); try { await f(); } catch (e) { setErr(liveError(e)); } finally { setBusy(''); void refreshLive(qc, account.id); } };
  const off = account.network === 'mainnet' && !account.mainnetEnabled;
  return <fieldset className="rounded-2xl border border-line p-3" data-testid="live-controls"><legend className="px-1 text-[12.5px] font-semibold text-mute">{t('flControls')}</legend>
    <div className="space-y-2">
      {!account.halt && <Btn full kind="ghost" busy={busy === 'halt'} onClick={() => void run('halt', async () => { await lapi.halt(account.id, 'interface'); setNote(true); })}><Icon n="stop" className="h-4 w-4" />{t('flHalt')}</Btn>}
      {note && account.halt && <p className="text-[12px] leading-snug text-mute">{t('flHaltNote')}</p>}
      <Btn full kind="ghost" disabled={off || !!busy} onClick={() => { setRes(null); setErr(null); setAsk(true); }}><Icon n="x" className="h-4 w-4" />{t('flCancelAll')}{openOrders ? ` (${openOrders})` : ''}</Btn>
      <p className="text-[11.5px] leading-snug text-mute">{t('flControlsHint')}</p>
      {err && !ask && <LiveErrNotice err={err} />}
    </div>
    {ask && <Sheet title={t('flCancelAllTitle')} onClose={() => !busy && setAsk(false)}><div className="space-y-3" data-testid="cancel-all-sheet">
      {!res && <Notice tone="warn">{t('flCancelAllBody')}</Notice>}
      {res && <Notice tone={res.failed.length || (res.remaining?.length ?? 0) > 0 ? 'warn' : 'ok'}><div data-testid="cancel-all-result">{t('flCancelAllDone', { requested: res.requested, accepted: res.accepted, remaining: res.remaining === null ? '?' : res.remaining.length })}
        {res.failed.map((f) => <span key={`${f.venueOrderId}`} className="mt-1 block break-words font-mono text-[11.5px] text-mute">{f.instrument} {f.venueOrderId}: {f.error}</span>)}</div></Notice>}
      {err && <LiveErrNotice err={err} />}
      {!res && <Btn full kind="danger" busy={busy === 'all'} onClick={() => void run('all', async () => setRes(await lapi.cancelAll(account.id)))}>{t('flCancelAllConfirm')}</Btn>}
      <Btn full kind="ghost" disabled={!!busy} onClick={() => setAsk(false)}>{t(res ? 'fxClose' : 'cancel')}</Btn></div></Sheet>}
  </fieldset>;
}

export function LiveOrderPanel({ instrument, account, detail, conn, workerError, config, switcher, goAccounts }: { instrument: Instrument; account: LiveSummary; detail: LiveDetail | undefined; conn: LiveConn; workerError: string | null;
  config: LiveConfig | undefined; switcher: ReactNode; goAccounts: () => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const tone = toneOf(account), a = detail ?? account;
  const [f, setF] = useState<LiveForm>({ side: 'buy', kind: 'limit', size: '', price: '', trigger: '', reduceOnly: false, postOnly: false });
  const [review, setReview] = useState<LiveOrderBody | null>(null), [last, setLast] = useState<string | null>(null), [lev, setLev] = useState(false);
  const [levRead, setLevRead] = useState<{ instrument: string; account: string; at: number; v: { leverage: string; marginMode: string } } | null>(null);
  const opening = useRef(false);
  const set = (p: Partial<LiveForm>) => { setF((x) => ({ ...x, ...p })); setLast(null); };
  useEffect(() => { setF((x) => ({ ...x, size: '', price: '', trigger: '' })); setLast(null); }, [instrument.id, account.id]);

  const pinned = config?.pinnedAssets[account.network] ?? [];
  const mainnetOff = account.network === 'mainnet' && !account.mainnetEnabled;
  const readOnly = a.mode !== 'MANUAL_LIVE', expired = !!a.authorization?.expired && !readOnly;
  const allowed = a.policy.allowedInstruments.includes(instrument.id), isPinned = !config || pinned.some((p) => p.instrument === instrument.id);
  const canTrade = !mainnetOff && !readOnly && !expired && allowed;
  const built = buildLive(f, instrument);
  const latest = useRef(built); latest.current = built;
  const stable = useDebounced(built.body ? JSON.stringify(built.body) : '', 350);
  const pv = useQuery({ queryKey: ['deriv', 'live', 'preview', account.id, stable], enabled: canTrade && !!stable && !review,
    queryFn: () => { const b = latest.current.body; if (!b) throw new Error('no order'); return Promise.race([lapi.preview(account.id, b), new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), 12_000))]); },
    refetchInterval: 6000, placeholderData: keepPreviousData, retry: 0, staleTime: 0, gcTime: 0 });
  // a preview is shown only for the order on screen: while the form and the debounced body differ, there is none
  const current = !!built.body && stable === JSON.stringify(built.body);
  const preview = current && !pv.isPlaceholderData ? pv.data : undefined, est = preview?.estimate ?? null;
  const refused = preview && preview.risk.ok === false ? preview.risk : null;
  const pvErr = current && pv.isError && !pv.data ? liveError(pv.error) : null;
  // the venue's own leverage setting for this instrument: as the last preview read it, or as a leverage change read it back since
  const fromPreview = pv.data?.estimate && pv.data.request.instrument === instrument.id ? { leverage: pv.data.estimate.leverage, marginMode: pv.data.estimate.marginMode as string } : null;
  const venueLev = levRead && levRead.instrument === instrument.id && levRead.account === account.id && (!fromPreview || levRead.at >= pv.dataUpdatedAt) ? levRead.v : fromPreview;
  const st = detail?.venueState, pdp = priceDp(instrument.tickSize, est?.mark ?? null), sdp = dpOf(instrument.lotSize);
  const long = f.side === 'buy', marketLike = f.kind !== 'limit';
  const lastOrder = last ? detail?.orders.find((o) => o.clientId === last) : undefined;
  const maxLev = Math.max(1, Math.min(a.authorization?.policy.maxLeverage ?? 1, Math.floor(Number(a.policy.maxLeverage)) || 1, Math.floor(Number(instrument.maxLeverage)) || 1, pinned.find((p) => p.instrument === instrument.id)?.maxLeverage ?? 1000));
  const openReview = () => { if (opening.current || review || !built.body || !preview || refused) return; opening.current = true; setLast(null); setReview(built.body); };
  useEffect(() => { if (!review) opening.current = false; }, [review]);

  const sideLabel = (s: 'buy' | 'sell') => <span className="inline-flex items-center gap-1.5"><svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true"><path d={s === 'buy' ? 'M6 2l4.5 7h-9z' : 'M6 10L1.5 3h9z'} fill="currentColor" /></svg>{t(s === 'buy' ? 'fxLong' : 'fxShort')}</span>;
  const check = (on: boolean, onChange: (v: boolean) => void, label: string, hint?: string) => <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-[13.5px]"><input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5 shrink-0 accent-[var(--blue)]" /><span>{label}{hint && <span className="block text-[11.5px] text-mute">{hint}</span>}</span></label>;
  const sizeNote = built.body ? `${fmt(built.body.size, { dp: sdp, locale, trim: true })} ${instrument.base}${est ? ` ≈ ${usd(est.notional, locale)}` : ''}` : null;

  return (
    <div className="space-y-3.5" data-testid="order-panel" data-account-kind="venue" data-network={account.network}>
      <div className="flex items-center justify-between gap-2"><h3 className="text-[15px] font-semibold">{t(tone === 'mainnet' ? 'flOrderReal' : 'flOrderTestnet')}</h3><ModeTag tone={tone} /></div>
      <div className="rounded-2xl bg-elev/70 p-3">
        {switcher}
        {st?.error ? <p className="mt-2 text-[12.5px] leading-snug text-danger" data-testid="venue-unreadable">{t('flUnreadable')} <span className="break-words font-mono text-[11px] text-mute">{st.error}</span></p> : <>
          <div className="mt-1.5 flex items-baseline justify-between text-[12.5px]"><span className="text-mute">{t('fxFreeCollateral')}</span><span className="font-semibold" data-testid="free-collateral">{st?.state ? usd(st.state.freeCollateral, locale) : '—'}</span></div>
          <div className="flex items-baseline justify-between text-[12.5px]"><span className="text-mute">{t('fxEquity')}</span><span className="font-medium">{st?.state ? usd(st.state.equity, locale) : '—'}</span></div>
          <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-mute"><span className="inline-flex items-center gap-1.5"><SourceTag />{t(conn === 'stream' ? 'flConnStream' : conn === 'polling' ? 'flConnPolling' : 'fxConnecting')}</span></div></>}
        {workerError && <p className="mt-1 break-words text-[11.5px] leading-snug text-warn">{t('flWorkerError')} <span className="font-mono text-[11px]">{workerError}</span></p>}
      </div>

      {mainnetOff && <Notice tone="warn"><div data-testid="mainnet-off"><b className="font-semibold">{t('flMainnetOffTitle')}</b> {t('flMainnetOff')}</div></Notice>}
      {!mainnetOff && readOnly && <><Notice tone="info"><div data-testid="live-readonly">{t(a.authorization?.revokedAt ? 'flRevokedNote' : 'flReadOnlyNote')}</div></Notice><Btn full kind="soft" onClick={goAccounts}>{t('flGoAuthorize')}</Btn></>}
      {expired && <><Notice tone="warn">{t('flE_authorization_expired')}</Notice><Btn full kind="soft" onClick={goAccounts}>{t('flGoAuthorize')}</Btn></>}
      {!mainnetOff && !readOnly && !allowed && <Notice tone="warn"><div data-testid="live-not-allowed">{t(isPinned ? 'flNotInAuthorization' : 'flNotPinned', { symbol: instrument.symbol })}</div></Notice>}
      <HaltBanner account={a} />
      {tone === 'testnet' && canTrade && <p className="rounded-xl border border-line px-3 py-2 text-[11.5px] leading-snug text-mute" data-testid="testnet-note">{t('flTestnetPrices')}{est ? <span className="block font-medium text-ink">{t('flTestnetMark', { price: fmt(est.mark, { dp: pdp, locale }) })} <SourceTag /></span> : null}</p>}

      {canTrade && <>
        <div role="radiogroup" aria-label={t('fxDirection')} className="grid grid-cols-2 gap-2">
          {(['buy', 'sell'] as const).map((s) => <button key={s} type="button" role="radio" aria-checked={f.side === s} onClick={() => set({ side: s })}
            className={`min-h-12 rounded-2xl border text-[15px] font-semibold transition ${f.side === s ? (s === 'buy' ? 'border-emerald bg-emerald text-white' : 'border-danger bg-danger text-white') : 'border-line text-mute hover:text-ink'}`}>{sideLabel(s)}</button>)}
        </div>
        <Seg size="sm" label={t('fxOrderType')} value={f.kind} onChange={(kind) => set({ kind })} options={(['market', 'limit', 'stop', 'tp'] as const).map((k) => ({ id: k, label: t(`fxKindShort_${k}` as Key), aria: t(`fxKind_${k}` as Key) }))} />
        {f.kind === 'limit' && <Field label={`${t('fxLimitPrice')} (${instrument.quote})`}><input className={inputCls} inputMode="decimal" autoComplete="off" value={f.price} onChange={(e) => set({ price: num(e.target.value) })} /></Field>}
        {(f.kind === 'stop' || f.kind === 'tp') && <Field label={`${t('fxTriggerPrice')} (${instrument.quote})`} hint={t(f.kind === 'stop' ? 'fxStopHint' : 'fxTpHint')}><input className={inputCls} inputMode="decimal" autoComplete="off" value={f.trigger} onChange={(e) => set({ trigger: num(e.target.value) })} /></Field>}
        <Field label={`${t('fxSize')} (${instrument.base})`} hint={sizeNote ?? (built.problem ? <span className="text-danger">{t(built.problem)}</span> : t('flSizeHint', { lot: fmt(instrument.lotSize, { locale, trim: true }), base: instrument.base }))}>
          <input className={inputCls} inputMode="decimal" autoComplete="off" aria-label={t('fxSize')} value={f.size} placeholder="0" onChange={(e) => set({ size: num(e.target.value) })} /></Field>
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-line px-3 py-2" data-testid="venue-leverage">
          <div className="min-w-0 text-[13px]"><div className="text-mute">{t('flVenueLeverage')}</div><div className="font-semibold">{venueLev ? `${fmt(venueLev.leverage, { locale, trim: true })}× · ${t(venueLev.marginMode === 'cross' ? 'fxCross' : 'fxIsolated')}` : t('flLevUnknown')}</div></div>
          <button type="button" disabled={!!a.halted} onClick={() => setLev(true)} className="min-h-11 shrink-0 rounded-xl border border-line px-3 text-[13px] font-semibold text-ink disabled:opacity-45">{t('flLevChange')}</button></div>
        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2 xl:grid-cols-1">
          {check(f.reduceOnly, (reduceOnly) => set({ reduceOnly }), t('fxReduceOnly'), t('flReduceOnlyHint'))}
          {f.kind === 'limit' && check(f.postOnly, (postOnly) => set({ postOnly }), t('fxPostOnly'), t('fxPostOnlyHint'))}
        </div>
        {marketLike && <p className="text-[11.5px] leading-snug text-mute">{t('flMarketNote', { pct: fmt(String(SLIPPAGE_BPS / 100), { locale, trim: true }) })}</p>}

        {built.body && <div className="rounded-2xl border border-line p-3" aria-live="polite" data-testid="preview">
          <div className="mb-1 flex items-center justify-between"><span className="text-[12.5px] font-semibold">{t('flPreview')}</span><SourceTag source="estimate" /></div>
          {est ? <>
            <Row label={t('fxNotional')}>{usd(est.notional, locale)}</Row><Row label={t('fxInitialMargin')}>{usd(est.initialMargin, locale)}</Row><Row label={t('flFeeMax')}>{usd(est.fee, locale)}</Row>
            {marketLike && <Row label={t('fxWorstPrice')}>{fmt(preview?.request.price ?? null, { dp: pdp, locale })}</Row>}
            <Row label={<>{t('flVenueMark')} <SourceTag /></>}>{fmt(est.mark, { dp: pdp, locale })}</Row>
            <Row label={t('fxFreeAfter')}>{usd(est.freeCollateralAfter, locale)}</Row>
            <p className="mt-1 text-[11.5px] leading-snug text-mute">{t('flLiqNote')}</p></>
            : <p className="py-2 text-[12.5px] text-mute">{pvErr ? t('fxPreviewError') : t('fxLoading')}</p>}
        </div>}
        {pvErr && <LiveErrNotice err={pvErr} />}
        {refused && <Notice tone="danger"><div data-testid="risk-refusal"><b className="font-semibold">{t('fxRefused')}</b> {RISK_CODES.has(refused.code) && !['halted', 'mode_read_only'].includes(refused.code) ? t(`rk_${refused.code}` as Key) : t(`flE_${refused.code}` as Key)}
          {refused.code === 'order_notional_exceeded' && <span className="mt-1 block">{t('flNotionalSigner')}</span>}
          <span className="mt-1 block break-words font-mono text-[11.5px] text-mute">{refused.code} — {refused.reason}</span></div></Notice>}
        {lastOrder && <OrderOutcome order={lastOrder} instrument={instrument} />}

        <button type="button" data-testid="live-review" disabled={!built.body || !!refused || !preview || !!review || instrument.status === 'halted'} onClick={openReview}
          className={`inline-flex min-h-[50px] w-full items-center justify-center gap-2 rounded-2xl px-5 text-[15.5px] font-semibold text-white transition active:scale-[0.98] disabled:opacity-45 ${long ? 'bg-emerald' : 'bg-danger'}`}>
          {sideLabel(f.side)}<span>· {t('fxReview', { base: instrument.base })}</span></button>
        <p className="text-center text-[11.5px] font-medium leading-snug" data-testid="live-foot"><span className={tone === 'mainnet' ? 'text-danger' : 'text-mute'}>{t(tone === 'mainnet' ? 'flFootReal' : 'flFootTestnet')}</span></p>
      </>}

      {!readOnly && <LiveControls account={a} openOrders={st?.openOrders.length ?? 0} />}

      {review && <ApprovalSheet account={a} instrument={instrument} request={{ kind: 'order', body: review }} orders={detail?.orders ?? []} ttlMs={config?.bounds.orderApprovalTtlMs ?? 90_000}
        onClose={(id) => { setReview(null); if (id) { setLast(id); setF((x) => ({ ...x, size: '' })); } }} />}
      {lev && <LeverageSheet account={a} instrument={instrument} max={maxLev} current={venueLev} onRead={(v) => setLevRead({ instrument: instrument.id, account: account.id, at: Date.now(), v })} onClose={() => setLev(false)} />}
    </div>
  );
}
