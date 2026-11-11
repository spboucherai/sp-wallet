/**
 * Order panel — PAPER ONLY. It builds an `OrderRequest` with exact decimals (size on the lot, prices on the tick), shows the
 * server's preview (risk verdict + estimates) and, after a confirmation sheet, sends the order to the paper engine. There is no
 * live path in this file: a venue account gets `LiveOrderPanel` instead. The panel reads the mark from the store when it needs
 * it; it does not re-render on every tick.
 */
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { errText, I18n, useT, type Key } from '../i18n';
import { Btn, Field, inputCls, Notice } from '../ui';
import { dapi, paperAllowed, riskRefusal } from './api';
import { PaperTag, Row, Seg, ServerSays, Sheet, SideTag, VENUE_NAME } from './bits';
import { D, dec, dpOf, fmt, onTick, parseInput, priceDp, usd, usdToSize, worstPrice, type Dec } from './dec';
import type { MarketStore } from './store';
import type { DerivAccount, Instrument, OrderBody, Placed, VenueInfo } from './types';

/** protection of market-like orders: a market order is bounded by the server at this distance from the book (`slippageBps`); a triggered order carries a worst price this far from its trigger */
export const SLIPPAGE_BPS = 50;
type Kind = 'market' | 'limit' | 'stop' | 'tp';
const TYPE: Record<Kind, OrderBody['type']> = { market: 'market', limit: 'limit', stop: 'stop_market', tp: 'take_profit_market' };
interface Form { side: 'buy' | 'sell'; kind: Kind; unit: 'base' | 'usd'; size: string; lev: number; price: string; trigger: string; reduceOnly: boolean; postOnly: boolean; sl: string; tp: string }
interface Built { body: OrderBody | null; problem: Key | null; sl: Dec | null; tp: Dec | null; ref: Dec | null }

function build(f: Form, inst: Instrument, mark: Dec | null): Built {
  const none = (problem: Key | null): Built => ({ body: null, problem, sl: null, tp: null, ref: null });
  const tick = dec(inst.tickSize), lot = dec(inst.lotSize);
  if (!tick || !lot || !D.isPos(tick) || !D.isPos(lot)) return none('fxErrInstrument');
  if (!mark || !D.isPos(mark)) return none('fxErrNoPrice');
  const v = inst.venue;
  let price: Dec | null = null, trigger: Dec | null = null, ref = mark;
  if (f.kind === 'limit') { const p = parseInput(f.price); if (!p) return none(f.price.trim() ? 'fxErrPrice' : null); price = onTick(D.from(p), tick, v); if (!D.isPos(price)) return none('fxErrPrice'); ref = price; }
  else if (f.kind === 'market') price = null;   // the server derives the worst price from the live book (`slippageBps`)
  else { const p = parseInput(f.trigger); if (!p) return none(f.trigger.trim() ? 'fxErrTrigger' : null); trigger = onTick(D.from(p), tick, v); if (!D.isPos(trigger)) return none('fxErrTrigger'); price = worstPrice(trigger, f.side, SLIPPAGE_BPS, tick, v); ref = trigger; }
  const raw = parseInput(f.size);
  if (!raw) return none(f.size.trim() ? 'fxErrSize' : null);
  const size = f.unit === 'usd' ? usdToSize(D.from(raw), ref, lot) : D.quantize(D.from(raw), lot, 'down');
  if (!D.isPos(size)) return none('fxErrSizeSmall');
  let sl: Dec | null = null, tp: Dec | null = null;
  if (f.kind === 'market' && !f.reduceOnly) {
    if (f.sl.trim()) { const p = parseInput(f.sl); if (!p) return none('fxErrSl'); sl = onTick(D.from(p), tick, v); if (!D.isPos(sl) || (f.side === 'buy' ? D.gte(sl, mark) : D.lte(sl, mark))) return none(f.side === 'buy' ? 'fxErrSlLong' : 'fxErrSlShort'); }
    if (f.tp.trim()) { const p = parseInput(f.tp); if (!p) return none('fxErrTp'); tp = onTick(D.from(p), tick, v); if (!D.isPos(tp) || (f.side === 'buy' ? D.lte(tp, mark) : D.gte(tp, mark))) return none(f.side === 'buy' ? 'fxErrTpLong' : 'fxErrTpShort'); }
  }
  return { body: { instrument: inst.id, side: f.side, type: TYPE[f.kind], size: D.str(size), price: price ? D.str(price) : null, triggerPrice: trigger ? D.str(trigger) : null, reduceOnly: f.reduceOnly,
    tif: f.kind === 'market' ? 'ioc' : f.kind === 'limit' && f.postOnly ? 'alo' : 'gtc', leverage: String(f.lev), ...(f.kind === 'market' ? { slippageBps: SLIPPAGE_BPS } : {}) }, problem: null, sl, tp, ref };
}
function useDebounced<T>(v: T, ms: number): T { const [d, setD] = useState(v); useEffect(() => { const h = setTimeout(() => setD(v), ms); return () => clearTimeout(h); }, [v, ms]); return d; }
const num = (s: string) => s.replace(/[^0-9.,\s ]/g, '');

export function RiskVerdict({ code, reason }: { code: string; reason: string }) {
  const t = useT();
  const known = t(`rk_${code}` as Key), text = known === `${code}`.replace(/_/g, ' ') || known.startsWith('rk ') ? t('rk_unknown') : known;
  return <Notice tone="danger"><div data-testid="risk-refusal"><b className="font-semibold">{t('fxRefused')}</b> {text}{reason && <span className="mt-1 block break-words font-mono text-[11.5px] text-mute">{code} — {reason}</span>}</div></Notice>;
}

export function OrderPanel({ store, instrument, account, accounts, venue, onAccount, goAccounts, switcher }: { store: MarketStore; instrument: Instrument; account: DerivAccount | null; accounts: DerivAccount[]; venue: VenueInfo | undefined; onAccount: (id: string) => void; goAccounts: () => void;
  /** the terminal's account switcher (paper and venue accounts); without it the panel lists its own paper accounts */ switcher?: ReactNode }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const maxLev = useMemo(() => { const a = dec(instrument.maxLeverage), b = dec(account?.policy.maxLeverage); const m = a && b ? D.min(a, b) : a ?? b ?? D.one; return Math.max(1, Math.floor(D.toNumber(m))); }, [instrument.maxLeverage, account?.policy.maxLeverage]);
  const [f, setF] = useState<Form>({ side: 'buy', kind: 'market', unit: 'usd', size: '', lev: 3, price: '', trigger: '', reduceOnly: false, postOnly: false, sl: '', tp: '' });
  const set = (p: Partial<Form>) => { setF((x) => ({ ...x, ...p })); setDone(null); setErr(null); };
  const [, setPulse] = useState(0);
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ placed: Placed; extra: string[] } | null>(null), [err, setErr] = useState<{ code?: string; reason?: string; text?: string } | null>(null);
  const lev = Math.min(f.lev, maxLev);
  useEffect(() => { const h = setInterval(() => setPulse((n) => n + 1), 1000); return () => clearInterval(h); }, []);
  useEffect(() => { setF((x) => ({ ...x, size: '', price: '', trigger: '', sl: '', tp: '' })); setDone(null); setErr(null); }, [instrument.id]);

  const mark = dec(store.ticker?.mark);
  const built = build({ ...f, lev }, instrument, mark);
  const latest = useRef(built); latest.current = built;
  const marketLike = f.kind !== 'limit';
  const stable = useDebounced(built.body ? JSON.stringify({ ...built.body, price: marketLike ? null : built.body.price, size: f.unit === 'usd' ? `usd:${f.size}` : built.body.size }) : '', 300);
  const pv = useQuery({ queryKey: ['deriv', 'preview', account?.id, stable], enabled: !!account && !!stable && !confirm,
    queryFn: () => { const b = latest.current.body; if (!b || !account) throw new Error('no order'); // never leave « Chargement… » on screen for ever: a preview that takes more than 10 s counts as unavailable and is retried
      return Promise.race([dapi.preview(account.id, b), new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), 10_000))]); }, refetchInterval: 4000, placeholderData: keepPreviousData, retry: 0, staleTime: 0, gcTime: 0 });
  const preview = built.body && stable ? pv.data : undefined;
  const pdp = priceDp(instrument.tickSize, store.ticker?.mark), sdp = dpOf(instrument.lotSize);

  const submit = async () => {
    const b = latest.current; if (!b.body || !account) return;
    setBusy(true); setErr(null);
    try {
      const placed = await dapi.placeOrder(account.id, b.body, crypto.randomUUID());
      const extra: string[] = [];
      const filled = placed.fills.reduce((a, x) => D.add(a, dec(x.size) ?? D.zero), D.zero);
      if (D.isPos(filled) && (b.sl || b.tp)) {
        const tick = D.from(instrument.tickSize), exit = b.body.side === 'buy' ? 'sell' as const : 'buy' as const;
        for (const [trig, type, name] of [[b.sl, 'stop_market', t('fxStopLoss')], [b.tp, 'take_profit_market', t('fxTakeProfit')]] as const) {
          if (!trig) continue;
          try { await dapi.placeOrder(account.id, { instrument: instrument.id, side: exit, type, size: D.str(filled), price: D.str(worstPrice(trig, exit, SLIPPAGE_BPS, tick, instrument.venue)), triggerPrice: D.str(trig), reduceOnly: true, tif: 'gtc' }, crypto.randomUUID()); }
          catch (e) { const r = riskRefusal(e); extra.push(t('fxAttachedFailed', { name, why: r ? t(`rk_${r.code}` as Key) : errText(t, e) })); }
        }
      }
      setDone({ placed, extra }); setConfirm(false); setF((x) => ({ ...x, size: '', sl: '', tp: '' }));
    } catch (e) { const r = riskRefusal(e); setErr(r ?? { text: errText(t, e) || t('fxErrGeneric') }); setConfirm(false); }
    finally { setBusy(false); void qc.invalidateQueries({ queryKey: ['deriv', 'accounts'] }); void qc.invalidateQueries({ queryKey: ['deriv', 'account'] }); }
  };

  // ---- cases where nothing can be simulated: say why, offer nothing that pretends
  if (!paperAllowed(venue)) return (
    <div className="space-y-3" data-testid="order-panel">
      <h3 className="text-[15px] font-semibold">{t('fxOrder')}</h3>
      <Notice tone="warn">{t(instrument.venue === 'dydx' ? 'fxNoPaper_dydx' : instrument.venue === 'gmx' ? 'fxNoPaper_gmx' : 'fxNoPaper_other', { venue: VENUE_NAME[instrument.venue] ?? instrument.venue })}
        {venue?.restriction && <ServerSays text={venue.restriction} className="mt-1.5 text-[12px] text-mute" />}</Notice>
    </div>);
  if (!account) return (
    <div className="space-y-3" data-testid="order-panel">
      <h3 className="text-[15px] font-semibold">{t('fxOrder')}</h3>
      <Notice tone="info">{t('fxNoAccount', { venue: VENUE_NAME[instrument.venue] })}</Notice>
      <Btn full kind="soft" onClick={goAccounts}>{t('fxCreateAccount')}</Btn>
    </div>);

  const est = preview?.estimate ?? null, refused = preview && preview.risk && preview.risk.ok === false ? preview.risk : null;
  // the paper engine's own answer on a copy of the account: a rejection there is not a risk refusal (post-only would cross, margin at fill…)
  const wouldReject = !refused && est?.status === 'rejected' ? est.rejectReason ?? '' : null;
  const allowed = account.policy.allowedInstruments.includes(instrument.id);
  const allow = async () => { setBusy(true); setErr(null); try { await dapi.setPolicy(account.id, { ...account.policy, allowedInstruments: [...account.policy.allowedInstruments, instrument.id] }); await qc.invalidateQueries({ queryKey: ['deriv', 'accounts'] }); } catch (e) { setErr({ text: errText(t, e) || t('fxErrGeneric') }); } finally { setBusy(false); } };
  const long = f.side === 'buy';
  const sizeNote = built.body ? `${fmt(built.body.size, { dp: sdp, locale, trim: true })} ${instrument.base}${built.ref ? ` ≈ ${usd(D.mul(D.from(built.body.size), built.ref), locale)}` : ''}` : null;
  const sideLabel = (s: 'buy' | 'sell') => <span className="inline-flex items-center gap-1.5"><svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true"><path d={s === 'buy' ? 'M6 2l4.5 7h-9z' : 'M6 10L1.5 3h9z'} fill="currentColor" /></svg>{t(s === 'buy' ? 'fxLong' : 'fxShort')}</span>;
  const check = (on: boolean, onChange: (v: boolean) => void, label: string, hint?: string) => <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-[13.5px]"><input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5 shrink-0 accent-[var(--blue)]" /><span>{label}{hint && <span className="block text-[11.5px] text-mute">{hint}</span>}</span></label>;
  const summary = built.body && <>
    <Row label={t('fxDirection')}><SideTag side={long ? 'long' : 'short'} /></Row>
    <Row label={t('fxOrderType')}>{t(`fxKind_${f.kind}` as Key)}{f.reduceOnly ? ` · ${t('fxReduceOnly')}` : ''}{built.body.tif === 'alo' ? ` · ${t('fxPostOnly')}` : ''}</Row>
    <Row label={t('fxSize')}>{sizeNote}</Row>
    {f.kind === 'limit' && <Row label={t('fxLimitPrice')}>{fmt(built.body.price, { dp: pdp, locale })}</Row>}
    {built.body.triggerPrice && <Row label={t('fxTriggerPrice')}>{fmt(built.body.triggerPrice, { dp: pdp, locale })}</Row>}
    {marketLike && <Row label={t('fxWorstPrice')}>{fmt(built.body.price ?? est?.price ?? preview?.request?.price ?? null, { dp: pdp, locale })}</Row>}
    <Row label={t('fxLeverage')}>{lev}×</Row>
    {built.sl && <Row label={t('fxStopLoss')}>{fmt(D.str(built.sl), { dp: pdp, locale })}</Row>}
    {built.tp && <Row label={t('fxTakeProfit')}>{fmt(D.str(built.tp), { dp: pdp, locale })}</Row>}
  </>;
  const estimates = est && <>
    <Row label={t('fxNotional')}>{usd(est.notional, locale)}</Row>
    <Row label={t('fxInitialMargin')}>{usd(est.initialMargin, locale)}</Row>
    <Row label={t('fxFee')}>{usd(est.fee, locale)}</Row>
    <Row label={t('fxAvgPrice')}>{est.avgFillPrice ? fmt(est.avgFillPrice, { dp: pdp, locale }) : '—'}</Row>
    <Row label={t('fxSlippage')}>{est.slippageBps ? `${fmt(est.slippageBps, { dp: 1, locale, sign: true })} ${t('fxBps')}` : '—'}</Row>
    <Row label={<>{t('fxLiqPrice')} <em className="not-italic text-warn">({t('estimate')})</em></>}>{est.liquidationPrice?.value ? fmt(est.liquidationPrice.value, { dp: pdp, locale }) : '—'}</Row>
    <Row label={t('fxFreeAfter')}>{usd(est.freeCollateralAfter, locale)}</Row>
  </>;

  return (
    <div className="space-y-3.5" data-testid="order-panel">
      <div className="flex items-center justify-between gap-2"><h3 className="text-[15px] font-semibold">{t('fxOrder')}</h3><PaperTag /></div>
      <div className="rounded-2xl bg-elev/70 p-3">
        {switcher ?? (accounts.length > 1
          ? <label className="block text-[12px] text-mute">{t('fxAccount')}<select aria-label={t('fxAccount')} value={account.id} onChange={(e) => onAccount(e.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-line bg-surface px-3 text-[14px] text-ink">{accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label>
          : <div className="truncate text-[13px] font-semibold">{account.label}</div>)}
        <div className="mt-1.5 flex items-baseline justify-between text-[12.5px]"><span className="text-mute">{t('fxFreeCollateral')}</span><span className="font-semibold" data-testid="free-collateral">{usd(account.state.freeCollateral, locale)}</span></div>
        <div className="flex items-baseline justify-between text-[12.5px]"><span className="text-mute">{t('fxEquity')}</span><span className="font-medium">{usd(account.state.equity, locale)}</span></div>
      </div>
      {account.policy.halt && <Notice tone="danger">{t('fxHalted')} <span className="font-mono text-[12px]">{account.policy.halt}</span></Notice>}
      {instrument.status !== 'active' && <Notice tone="warn">{t(instrument.status === 'halted' ? 'fxInstHalted' : 'fxInstReduceOnly')}</Notice>}
      {!allowed && <Notice tone="warn"><div data-testid="not-allowed">{t('fxNotAllowed', { symbol: instrument.symbol })}
        <button type="button" disabled={busy} onClick={() => void allow()} className="mt-1 block min-h-11 text-left font-semibold underline">{t('fxAllow', { symbol: instrument.symbol })}</button></div></Notice>}

      <div role="radiogroup" aria-label={t('fxDirection')} className="grid grid-cols-2 gap-2">
        {(['buy', 'sell'] as const).map((s) => <button key={s} type="button" role="radio" aria-checked={f.side === s} onClick={() => set({ side: s })}
          className={`min-h-12 rounded-2xl border text-[15px] font-semibold transition ${f.side === s ? (s === 'buy' ? 'border-emerald bg-emerald text-white' : 'border-danger bg-danger text-white') : 'border-line text-mute hover:text-ink'}`}>{sideLabel(s)}</button>)}
      </div>
      <Seg size="sm" label={t('fxOrderType')} value={f.kind} onChange={(kind) => set({ kind })} options={(['market', 'limit', 'stop', 'tp'] as const).map((k) => ({ id: k, label: t(`fxKindShort_${k}` as Key), aria: t(`fxKind_${k}` as Key) }))} />

      {f.kind === 'limit' && <Field label={`${t('fxLimitPrice')} (${instrument.quote})`}><input className={inputCls} inputMode="decimal" autoComplete="off" value={f.price} placeholder={mark ? fmt(mark, { dp: pdp, locale }) : ''} onChange={(e) => set({ price: num(e.target.value) })} /></Field>}
      {(f.kind === 'stop' || f.kind === 'tp') && <Field label={`${t('fxTriggerPrice')} (${instrument.quote})`} hint={t(f.kind === 'stop' ? 'fxStopHint' : 'fxTpHint')}><input className={inputCls} inputMode="decimal" autoComplete="off" value={f.trigger} onChange={(e) => set({ trigger: num(e.target.value) })} /></Field>}
      <Field label={t('fxSize')} hint={sizeNote ?? (built.problem ? <span className="text-danger">{t(built.problem)}</span> : t('fxSizeHint', { lot: fmt(instrument.lotSize, { locale, trim: true }), base: instrument.base }))}>
        <div className="flex gap-2">
          <input className={`${inputCls} min-w-0 flex-1`} inputMode="decimal" autoComplete="off" aria-label={t('fxSize')} value={f.size} placeholder="0" onChange={(e) => set({ size: num(e.target.value) })} />
          <Seg size="sm" label={t('fxSizeUnit')} value={f.unit} onChange={(unit) => set({ unit, size: '' })} options={[{ id: 'usd', label: 'USD' }, { id: 'base', label: instrument.base.slice(0, 6) }]} className="shrink-0" />
        </div>
      </Field>
      <div>
        <div className="mb-1 flex items-baseline justify-between text-[13px]"><label htmlFor="fx-lev" className="text-mute">{t('fxLeverage')}</label><span className="font-semibold">{lev}×</span></div>
        <input id="fx-lev" type="range" min={1} max={maxLev} step={1} value={lev} disabled={maxLev <= 1} onChange={(e) => set({ lev: Number(e.target.value) })} className="h-11 w-full accent-[var(--blue)]" aria-valuetext={`${lev}×`} />
        <p className="text-[11.5px] leading-snug text-mute">{t('fxLeverageBounds', { policy: fmt(account.policy.maxLeverage, { locale, trim: true }), venue: fmt(instrument.maxLeverage, { locale, trim: true }) })}</p>
      </div>
      <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2 xl:grid-cols-1">
        {check(f.reduceOnly, (reduceOnly) => set({ reduceOnly }), t('fxReduceOnly'), t('fxReduceOnlyHint'))}
        {f.kind === 'limit' && check(f.postOnly, (postOnly) => set({ postOnly }), t('fxPostOnly'), t('fxPostOnlyHint'))}
      </div>
      {f.kind === 'market' && !f.reduceOnly && <fieldset className="rounded-2xl border border-line p-3"><legend className="px-1 text-[12.5px] text-mute">{t('fxAttached')}</legend>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('fxStopLoss')}><input className={inputCls} inputMode="decimal" autoComplete="off" value={f.sl} onChange={(e) => set({ sl: num(e.target.value) })} /></Field>
          <Field label={t('fxTakeProfit')}><input className={inputCls} inputMode="decimal" autoComplete="off" value={f.tp} onChange={(e) => set({ tp: num(e.target.value) })} /></Field>
        </div><p className="mt-1.5 text-[11.5px] leading-snug text-mute">{t('fxAttachedHint')}</p></fieldset>}
      {marketLike && <p className="text-[11.5px] leading-snug text-mute">{t('fxSlippageNote', { pct: fmt(String(SLIPPAGE_BPS / 100), { locale, trim: true }) })}</p>}

      {built.body && <div className="rounded-2xl border border-line p-3" aria-live="polite" data-testid="preview">
        <div className="mb-1 flex items-center justify-between"><span className="text-[12.5px] font-semibold">{t('fxPreview')}</span><PaperTag /></div>
        {est ? estimates : <p className="py-2 text-[12.5px] text-mute">{pv.isError ? t('fxPreviewError') : t('fxLoading')}</p>}
        {est && <p className="mt-1 text-[11.5px] leading-snug text-mute">{t('fxEstimateNote')}{est.liquidationPrice?.method ? <span className="block">{t('fxMethod')} {est.liquidationPrice.method}</span> : null}</p>}
      </div>}
      {refused && (allowed || refused.code !== 'instrument_not_allowed') && <RiskVerdict code={refused.code} reason={refused.reason} />}
      {wouldReject !== null && <Notice tone="warn"><div data-testid="would-reject">{t('fxWouldReject')}{wouldReject && <span className="mt-1 block break-words font-mono text-[11.5px] text-mute">{wouldReject}</span>}</div></Notice>}
      {err && (err.code ? <RiskVerdict code={err.code} reason={err.reason ?? ''} /> : <Notice tone="danger">{err.text}</Notice>)}
      {done && <Notice tone={done.placed.order.status === 'rejected' || done.placed.order.status === 'cancelled' ? 'warn' : 'ok'}><div data-testid="order-result">
        {t(`fxPlaced_${done.placed.order.status}` as Key, { size: fmt(done.placed.order.filled, { dp: sdp, locale, trim: true }), base: instrument.base, price: done.placed.order.avgFillPrice ? fmt(done.placed.order.avgFillPrice, { dp: pdp, locale }) : '—' })}
        {done.placed.order.rejectReason && <span className="mt-1 block font-mono text-[11.5px] text-mute">{done.placed.order.rejectReason}</span>}
        {done.extra.map((x) => <span key={x} className="mt-1 block text-warn">{x}</span>)}</div></Notice>}

      <button type="button" disabled={!built.body || !!refused || wouldReject !== null || !preview || instrument.status === 'halted'} onClick={() => setConfirm(true)}
        className={`inline-flex min-h-[50px] w-full items-center justify-center gap-2 rounded-2xl px-5 text-[15.5px] font-semibold text-white transition active:scale-[0.98] disabled:opacity-45 ${long ? 'bg-emerald' : 'bg-danger'}`}>
        {sideLabel(f.side)}<span>· {t('fxReview', { base: instrument.base })}</span></button>
      <p className="text-center text-[11.5px] text-mute">{t('fxPaperOnly')}</p>

      {confirm && built.body && <Sheet title={t('fxConfirmTitle')} onClose={() => !busy && setConfirm(false)}>
        <div className="space-y-3">
          <div className="flex items-center gap-2"><PaperTag /><span className="text-[13px] text-mute">{account.label} · {VENUE_NAME[instrument.venue]} · {instrument.symbol}</span></div>
          <div className="rounded-2xl bg-elev/70 p-3">{summary}</div>
          {est && <div className="rounded-2xl border border-line p-3">{estimates}</div>}
          <Notice tone="info">{t('fxConfirmNote')}</Notice>
          <Btn full busy={busy} onClick={() => void submit()}>{t('fxConfirm')}</Btn>
          <Btn full kind="ghost" disabled={busy} onClick={() => setConfirm(false)}>{t('cancel')}</Btn>
        </div>
      </Sheet>}
    </div>
  );
}
