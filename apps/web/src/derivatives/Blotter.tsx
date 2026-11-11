/**
 * Bottom of the terminal: positions (with partial closes), open orders (cancel), order history, fills, funding, PnL (equity
 * curve) and risk events of the selected PAPER account. Values come from the account routes; nothing is recomputed locally
 * except the notional shown beside a size.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { PriceChart } from '../chart';
import { errText, I18n, useT, type Key } from '../i18n';
import { Notice } from '../ui';
import { dapi, riskRefusal } from './api';
import { DataTable, PaperTag, Pnl, Seg, SideTag, Stat, timeOf, type Col } from './bits';
import { D, dec, dpOf, fmt, pct, priceDp, usd } from './dec';
import { RiskVerdict } from './OrderPanel';
import type { AccountDetail, DerivAccount, Fill, FundingPayment, Instrument, Order, Position, RiskEvent } from './types';

export type BlotterTab = 'positions' | 'orders' | 'history' | 'fills' | 'funding' | 'pnl' | 'risk';
const sym = (id: string) => id.slice(id.indexOf(':') + 1);
const mini = 'inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-line px-2.5 text-[12.5px] font-semibold text-ink transition hover:bg-elev disabled:opacity-45';

export function Blotter({ account, detail, instruments, onSelect }: { account: DerivAccount | null; detail: AccountDetail | undefined; instruments: Map<string, Instrument>; onSelect: (id: string) => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const [tab, setTab] = useState<BlotterTab>('positions');
  const [busy, setBusy] = useState(''), [err, setErr] = useState<{ code?: string; reason?: string; text?: string } | null>(null);
  const positions = detail?.positions ?? account?.positions ?? [], open = detail?.openOrders ?? account?.openOrders ?? [];
  const px = (id: string, v: string | null | undefined) => (v ? fmt(v, { dp: priceDp(instruments.get(id)?.tickSize, v), locale }) : '—');
  const sz = (id: string, v: string) => fmt(v, { dp: Math.min(8, dpOf(instruments.get(id)?.lotSize ?? '0.0001')), locale, trim: true });
  const market = (id: string) => <button type="button" onClick={() => onSelect(id)} className="-my-2 inline-flex min-h-11 items-center font-semibold underline decoration-line underline-offset-4 hover:decoration-ink" aria-label={t('fxOpenMarket', { symbol: sym(id) })}>{sym(id)}</button>;
  const run = async (id: string, f: () => Promise<unknown>) => {
    setBusy(id); setErr(null);
    try { await f(); } catch (e) { const r = riskRefusal(e); setErr(r ?? { text: errText(t, e) || t('fxErrGeneric') }); }
    finally { setBusy(''); void qc.invalidateQueries({ queryKey: ['deriv', 'accounts'] }); void qc.invalidateQueries({ queryKey: ['deriv', 'account'] }); }
  };
  if (!account) return <p className="py-8 text-center text-[13.5px] text-mute">{t('fxBlotterNoAccount')}</p>;

  const posCols: Col<Position>[] = [
    { id: 'm', label: t('fxMarket'), head: true, cell: (p) => market(p.instrument) },
    { id: 'side', label: t('fxDirection'), head: true, cell: (p) => <SideTag side={p.side} /> },
    { id: 'size', label: t('fxSize'), num: true, cell: (p) => <>{sz(p.instrument, p.size)} <span className="text-mute">≈ {usd(D.mul(dec(p.size) ?? D.zero, dec(p.markPrice) ?? D.zero), locale)}</span></> },
    { id: 'entry', label: t('fxEntry'), num: true, cell: (p) => px(p.instrument, p.entryPrice) },
    { id: 'mark', label: t('fxMark'), num: true, cell: (p) => px(p.instrument, p.markPrice) },
    { id: 'liq', label: <>{t('fxLiqShort')} <em className="not-italic text-warn">({t('estimate')})</em></>, num: true, cell: (p) => px(p.instrument, p.liquidationPrice) },
    { id: 'lev', label: t('fxLeverage'), num: true, cell: (p) => `${fmt(p.leverage, { dp: 1, locale, trim: true })}×` },
    { id: 'margin', label: t('fxMargin'), num: true, cell: (p) => usd(p.margin, locale) },
    { id: 'upnl', label: t('fxUnrealized'), num: true, cell: (p) => <b className="font-semibold"><Pnl value={p.unrealizedPnl} locale={locale} /></b> },
    { id: 'rpnl', label: t('fxRealized'), num: true, cell: (p) => <Pnl value={p.realizedPnl} locale={locale} /> },
    { id: 'fund', label: t('fxFundingPaid'), num: true, cell: (p) => (p.fundingPaid === null ? '—' : usd(p.fundingPaid, locale, true)) },
    { id: 'close', label: t('fxClosePos'), cell: (p) => <span className="inline-flex gap-1.5" role="group" aria-label={t('fxCloseAria', { symbol: sym(p.instrument) })}>
      {(['0.25', '0.5', '1'] as const).map((fr) => <button key={fr} type="button" disabled={!!busy} className={mini} onClick={() => void run(`c${p.instrument}${fr}`, () => dapi.close(account.id, p.instrument, fr, crypto.randomUUID()))}
        aria-label={t('fxCloseFrac', { pct: fr === '1' ? 100 : fr === '0.5' ? 50 : 25, symbol: sym(p.instrument) })}>{fr === '1' ? '100' : fr === '0.5' ? '50' : '25'} %</button>)}</span> },
  ];
  const orderCols = (withCancel: boolean): Col<Order>[] => [
    { id: 'm', label: t('fxMarket'), head: true, cell: (o) => market(o.instrument) },
    { id: 'side', label: t('fxSideCol'), head: true, cell: (o) => <SideTag side={o.side} /> },
    { id: 'type', label: t('fxOrderType'), cell: (o) => <>{t(`fxType_${o.type}` as Key)}{o.reduceOnly ? <span className="text-mute"> · {t('fxReduceOnly')}</span> : null}{o.tif === 'alo' ? <span className="text-mute"> · {t('fxPostOnly')}</span> : null}</> },
    { id: 'size', label: t('fxSize'), num: true, cell: (o) => sz(o.instrument, o.size) },
    { id: 'filled', label: t('fxFilled'), num: true, cell: (o) => sz(o.instrument, o.filled) },
    { id: 'price', label: t('fxPrice'), num: true, cell: (o) => (o.type === 'limit' || o.type.endsWith('_limit') ? px(o.instrument, o.price) : o.avgFillPrice ? px(o.instrument, o.avgFillPrice) : t('fxAtMarket')) },
    { id: 'trig', label: t('fxTriggerPrice'), num: true, cell: (o) => px(o.instrument, o.triggerPrice) },
    { id: 'st', label: t('fxStatus'), cell: (o) => <span className="inline-flex rounded-full bg-elev px-2 py-0.5 text-[11.5px] font-semibold">{t(`fxSt_${o.status}` as Key)}</span> },
    { id: 'at', label: t('fxTime'), cell: (o) => <span className="text-mute">{timeOf(o.createdAt, locale, true)}</span> },
    ...(withCancel ? [{ id: 'x', label: '', cell: (o: Order) => <button type="button" disabled={!!busy} className={mini} onClick={() => void run(`x${o.clientId}`, () => dapi.cancel(account.id, o.clientId))} aria-label={t('fxCancelAria', { symbol: sym(o.instrument) })}>{t('fxCancelOrder')}</button> }]
      : [{ id: 'why', label: t('fxReason'), cell: (o: Order) => <span className="text-mute">{o.rejectReason ?? '—'}</span> }]),
  ];
  const fillCols: Col<Fill>[] = [
    { id: 'm', label: t('fxMarket'), head: true, cell: (f) => market(f.instrument) },
    { id: 'side', label: t('fxSideCol'), head: true, cell: (f) => <><SideTag side={f.side} />{f.liquidation && <span className="ml-2 rounded-full bg-danger/10 px-2 py-0.5 text-[11.5px] font-semibold text-danger">{t('fxLiquidation')}</span>}</> },
    { id: 'price', label: t('fxPrice'), num: true, cell: (f) => px(f.instrument, f.price) },
    { id: 'size', label: t('fxSize'), num: true, cell: (f) => sz(f.instrument, f.size) },
    { id: 'fee', label: t('fxFee'), num: true, cell: (f) => `${fmt(f.fee, { dp: 4, locale })} ${f.feeAsset}` },
    { id: 'pnl', label: t('fxClosedPnl'), num: true, cell: (f) => <Pnl value={f.closedPnl} locale={locale} /> },
    { id: 'at', label: t('fxTime'), cell: (f) => <span className="text-mute">{timeOf(f.ts, locale, true)}</span> },
  ];
  const fundCols: Col<FundingPayment>[] = [
    { id: 'm', label: t('fxMarket'), head: true, cell: (f) => market(f.instrument) },
    { id: 'amt', label: t('fxAmount'), num: true, head: true, cell: (f) => <Pnl value={f.amount} locale={locale} dp={4} /> },
    { id: 'rate', label: t('fxRate'), num: true, cell: (f) => pct(f.rate, 5, locale, true) },
    { id: 'size', label: t('fxSize'), num: true, cell: (f) => sz(f.instrument, f.size) },
    { id: 'at', label: t('fxTime'), cell: (f) => <span className="text-mute">{timeOf(f.ts, locale, true)}</span> },
  ];
  const evCols: Col<RiskEvent>[] = [
    { id: 'k', label: t('fxEvent'), head: true, cell: (e) => { const k = t(`fxEv_${e.kind}` as Key); return k.startsWith('fxEv ') ? e.kind : k; } },
    { id: 'm', label: t('fxMarket'), cell: (e) => (e.instrument ? sym(e.instrument) : '—') },
    { id: 'd', label: t('fxDetail'), cell: (e) => <span className="whitespace-normal text-mute">{e.detail}</span> },
    { id: 'at', label: t('fxTime'), cell: (e) => <span className="text-mute">{timeOf(e.ts, locale, true)}</span> },
  ];
  const eq = detail?.equityHistory ?? [];
  const first = dec(eq[0]?.equity), lastEq = dec(account.state.equity), change = first && lastEq ? D.sub(lastEq, first) : null;
  const realized = positions.reduce((a, p) => D.add(a, dec(p.realizedPnl) ?? D.zero), D.zero), unreal = positions.reduce((a, p) => D.add(a, dec(p.unrealizedPnl) ?? D.zero), D.zero);
  const n = (k: number) => (k ? ` (${k})` : '');
  return (
    <div data-testid="blotter">
      <div className="mb-3 flex items-center gap-2">
        <Seg tabs size="sm" label={t('fxBlotter')} value={tab} onChange={(v) => { setTab(v); setErr(null); }} className="min-w-0 flex-1" options={[
          { id: 'positions', label: `${t('fxPositions')}${n(positions.length)}` }, { id: 'orders', label: `${t('fxOpenOrders')}${n(open.length)}` }, { id: 'history', label: t('fxOrderHistory') },
          { id: 'fills', label: t('fxFills') }, { id: 'funding', label: t('fxFunding') }, { id: 'pnl', label: t('fxPnl') }, { id: 'risk', label: `${t('fxRiskEvents')}${n(detail?.riskEvents.length ?? 0)}` }]} />
        <PaperTag className="hidden sm:inline-flex" />
      </div>
      {err && <div className="mb-3">{err.code ? <RiskVerdict code={err.code} reason={err.reason ?? ''} /> : <Notice tone="danger">{err.text}</Notice>}</div>}
      <div role="tabpanel" aria-label={t('fxBlotter')}>
        {tab === 'positions' && <DataTable label={t('fxPositions')} cols={posCols} rows={positions} rowKey={(p) => p.instrument} empty={t('fxNoPositions')} />}
        {tab === 'orders' && <DataTable label={t('fxOpenOrders')} cols={orderCols(true)} rows={open} rowKey={(o) => o.clientId} empty={t('fxNoOpenOrders')} />}
        {tab === 'history' && <DataTable label={t('fxOrderHistory')} cols={orderCols(false)} rows={detail?.orders ?? []} rowKey={(o) => o.clientId} empty={t('fxNoHistory')} />}
        {tab === 'fills' && <DataTable label={t('fxFills')} cols={fillCols} rows={detail?.fills ?? []} rowKey={(f) => f.id} empty={t('fxNoFills')} />}
        {tab === 'funding' && <DataTable label={t('fxFunding')} cols={fundCols} rows={detail?.funding ?? []} rowKey={(f) => `${f.instrument}${f.ts}`} empty={t('fxNoFunding')} />}
        {tab === 'risk' && <DataTable label={t('fxRiskEvents')} cols={evCols} rows={detail?.riskEvents ?? []} rowKey={(e) => `${e.ts}${e.kind}${e.detail}`} empty={t('fxNoRiskEvents')} />}
        {tab === 'pnl' && <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t('fxEquity')}>{usd(account.state.equity, locale)}</Stat>
            <Stat label={t('fxSinceStart')}><Pnl value={change ? D.str(change) : null} locale={locale} /></Stat>
            <Stat label={t('fxUnrealized')}><Pnl value={D.str(unreal)} locale={locale} /></Stat>
            <Stat label={t('fxRealizedOpen')}><Pnl value={D.str(realized)} locale={locale} /></Stat>
          </div>
          {eq.length >= 2 ? <PriceChart points={eq.map((p) => ({ t: p.ts, p: Number(p.equity) }))} format={(v) => usd(v.toFixed(2), locale)} formatTime={(ts) => timeOf(ts, locale, true)} />
            : <p className="py-8 text-center text-[13.5px] text-mute">{t('fxNoEquity')}</p>}
          <p className="text-[12px] leading-snug text-mute">{t('fxPnlNote')}</p>
        </div>}
      </div>
    </div>
  );
}
