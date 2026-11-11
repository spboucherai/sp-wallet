/**
 * Bottom of the terminal: positions (with partial closes), open orders (cancel), order history, fills, funding, PnL (equity
 * curve) and risk events of the selected PAPER account. Values come from the account routes; nothing is recomputed locally
 * except the notional shown beside a size. Dense tables on a wide screen, stacked rows on a phone (bits `DataTable`).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { PriceChart } from '../chart';
import { errText, I18n, useT, type Key } from '../i18n';
import { Btn, Coin, Icon, Notice, Stat as Tile, StatGrid, Tag, type Tone } from '../ui';
import { dapi, RISK_CODES, riskRefusal } from './api';
import { DataTable, Empty, PaperTag, Pnl, Seg, SideTag, timeOf, type Col } from './bits';
import { D, dec, dpOf, fmt, pct, priceDp, usd } from './dec';
import { RiskVerdict } from './OrderPanel';
import type { AccountDetail, DerivAccount, Fill, FundingPayment, Instrument, Order, Position, RiskEvent } from './types';

export type BlotterTab = 'positions' | 'orders' | 'history' | 'fills' | 'funding' | 'pnl' | 'risk';
const sym = (id: string) => id.slice(id.indexOf(':') + 1);
const mini = 'press inline-flex min-h-11 min-w-11 shrink-0 whitespace-nowrap items-center justify-center rounded-xl bg-elev px-3 text-[13px] font-semibold text-ink disabled:opacity-45';
/** an order's state: a word and an icon, the colour only repeats them */
const ORDER_TONE: Record<string, [Tone, string]> = { filled: ['ok', 'check'], open: ['info', 'clock'], pending: ['info', 'clock'], partially_filled: ['info', 'clock'], triggered: ['info', 'bolt'], cancelled: ['mute', 'x'], rejected: ['danger', 'x'] };

export function Blotter({ account, detail, instruments, onSelect, goAccounts }: { account: DerivAccount | null; detail: AccountDetail | undefined; instruments: Map<string, Instrument>; onSelect: (id: string) => void; /** the empty state's way to the Accounts view */ goAccounts?: () => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const [tab, setTab] = useState<BlotterTab>('positions');
  const [busy, setBusy] = useState(''), [err, setErr] = useState<{ code?: string; reason?: string; text?: string } | null>(null);
  const positions = detail?.positions ?? account?.positions ?? [], open = detail?.openOrders ?? account?.openOrders ?? [];
  const px = (id: string, v: string | null | undefined) => (v ? fmt(v, { dp: priceDp(instruments.get(id)?.tickSize, v), locale }) : '—');
  const sz = (id: string, v: string) => fmt(v, { dp: Math.min(8, dpOf(instruments.get(id)?.lotSize ?? '0.0001')), locale, trim: true });
  const market = (id: string) => <span className="inline-flex items-center gap-2"><Coin sym={instruments.get(id)?.base ?? sym(id)} size={22} />
    <button type="button" onClick={() => onSelect(id)} className="-my-2 inline-flex min-h-11 items-center font-semibold underline decoration-line underline-offset-4 hover:decoration-ink" aria-label={t('fxOpenMarket', { symbol: sym(id) })}>{sym(id)}</button></span>;
  const run = async (id: string, f: () => Promise<unknown>) => {
    setBusy(id); setErr(null);
    try { await f(); } catch (e) { const r = riskRefusal(e); setErr(r ?? { text: errText(t, e) || t('fxErrGeneric') }); }
    finally { setBusy(''); void qc.invalidateQueries({ queryKey: ['deriv', 'accounts'] }); void qc.invalidateQueries({ queryKey: ['deriv', 'account'] }); }
  };
  if (!account) return <Empty icon="chart" title={t('dzFxNoAccountTitle')} testid="blotter-empty" action={goAccounts && <Btn kind="soft" onClick={goAccounts}><Icon n="plus" className="h-4 w-4" />{t('fxCreateAccount')}</Btn>}>{t('fxBlotterNoAccount')}</Empty>;

  const posCols: Col<Position>[] = [
    { id: 'm', label: t('fxMarket'), head: true, cell: (p) => market(p.instrument) },
    { id: 'side', label: t('fxDirection'), head: true, cell: (p) => <SideTag side={p.side} /> },
    { id: 'close', label: t('fxClosePos'), full: true, cell: (p) => <span className="inline-flex gap-1.5" role="group" aria-label={t('fxCloseAria', { symbol: sym(p.instrument) })}>
      {(['0.25', '0.5', '1'] as const).map((fr) => <button key={fr} type="button" disabled={!!busy} className={mini} onClick={() => void run(`c${p.instrument}${fr}`, () => dapi.close(account.id, p.instrument, fr, crypto.randomUUID()))}
        aria-label={t('fxCloseFrac', { pct: fr === '1' ? 100 : fr === '0.5' ? 50 : 25, symbol: sym(p.instrument) })}>{fr === '1' ? '100' : fr === '0.5' ? '50' : '25'} %</button>)}</span> },
    { id: 'size', label: t('fxSize'), num: true, cell: (p) => <>{sz(p.instrument, p.size)} <span className="font-normal text-mute">≈ {usd(D.mul(dec(p.size) ?? D.zero, dec(p.markPrice) ?? D.zero), locale)}</span></> },
    { id: 'entry', label: t('fxEntry'), num: true, cell: (p) => px(p.instrument, p.entryPrice) },
    { id: 'mark', label: t('fxMark'), num: true, cell: (p) => px(p.instrument, p.markPrice) },
    { id: 'liq', label: <>{t('fxLiqShort')} <em className="not-italic text-warn">({t('estimate')})</em></>, num: true, cell: (p) => px(p.instrument, p.liquidationPrice) },
    { id: 'lev', label: t('fxLeverage'), num: true, cell: (p) => `${fmt(p.leverage, { dp: 1, locale, trim: true })}×` },
    { id: 'margin', label: t('fxMargin'), num: true, cell: (p) => usd(p.margin, locale) },
    { id: 'upnl', label: t('fxUnrealized'), num: true, cell: (p) => <b className="font-semibold"><Pnl value={p.unrealizedPnl} locale={locale} /></b> },
    { id: 'rpnl', label: t('fxRealized'), num: true, cell: (p) => <Pnl value={p.realizedPnl} locale={locale} /> },
    { id: 'fund', label: t('fxFundingPaid'), num: true, cell: (p) => (p.fundingPaid === null ? '—' : usd(p.fundingPaid, locale, true)) },
  ];
  const orderCols = (withCancel: boolean): Col<Order>[] => [
    { id: 'm', label: t('fxMarket'), head: true, cell: (o) => market(o.instrument) },
    { id: 'side', label: t('fxSideCol'), head: true, cell: (o) => <SideTag side={o.side} /> },
    { id: 'type', label: t('fxOrderType'), cell: (o) => <>{t(`fxType_${o.type}` as Key)}{o.reduceOnly ? <span className="font-normal text-mute"> · {t('fxReduceOnly')}</span> : null}{o.tif === 'alo' ? <span className="font-normal text-mute"> · {t('fxPostOnly')}</span> : null}</> },
    { id: 'size', label: t('fxSize'), num: true, cell: (o) => sz(o.instrument, o.size) },
    { id: 'filled', label: t('fxFilled'), num: true, cell: (o) => sz(o.instrument, o.filled) },
    { id: 'price', label: t('fxPrice'), num: true, cell: (o) => (o.type === 'limit' || o.type.endsWith('_limit') ? px(o.instrument, o.price) : o.avgFillPrice ? px(o.instrument, o.avgFillPrice) : t('fxAtMarket')) },
    { id: 'trig', label: t('fxTriggerPrice'), num: true, cell: (o) => px(o.instrument, o.triggerPrice) },
    { id: 'st', label: t('fxStatus'), cell: (o) => { const [tone, icon] = ORDER_TONE[o.status] ?? (['mute', 'minus'] as [Tone, string]); return <Tag tone={tone} icon={icon}>{t(`fxSt_${o.status}` as Key)}</Tag>; } },
    { id: 'at', label: t('fxTime'), cell: (o) => <span className="font-normal text-mute">{timeOf(o.createdAt, locale, true)}</span> },
    ...(withCancel ? [{ id: 'x', label: '', cell: (o: Order) => <button type="button" disabled={!!busy} className={mini} onClick={() => void run(`x${o.clientId}`, () => dapi.cancel(account.id, o.clientId))} aria-label={t('fxCancelAria', { symbol: sym(o.instrument) })}>{t('fxCancelOrder')}</button> }]
      : [{ id: 'why', label: t('fxReason'), full: true, cell: (o: Order) => <span className="font-normal text-mute">{o.rejectReason ?? '—'}</span> }]),
  ];
  const fillCols: Col<Fill>[] = [
    { id: 'm', label: t('fxMarket'), head: true, cell: (f) => market(f.instrument) },
    { id: 'side', label: t('fxSideCol'), head: true, cell: (f) => <span className="inline-flex items-center gap-2"><SideTag side={f.side} />{f.liquidation && <Tag tone="danger" icon="warn">{t('fxLiquidation')}</Tag>}</span> },
    { id: 'price', label: t('fxPrice'), num: true, cell: (f) => px(f.instrument, f.price) },
    { id: 'size', label: t('fxSize'), num: true, cell: (f) => sz(f.instrument, f.size) },
    { id: 'fee', label: t('fxFee'), num: true, cell: (f) => `${fmt(f.fee, { dp: 4, locale })} ${f.feeAsset}` },
    { id: 'pnl', label: t('fxClosedPnl'), num: true, cell: (f) => <Pnl value={f.closedPnl} locale={locale} /> },
    { id: 'at', label: t('fxTime'), cell: (f) => <span className="font-normal text-mute">{timeOf(f.ts, locale, true)}</span> },
  ];
  const fundCols: Col<FundingPayment>[] = [
    { id: 'm', label: t('fxMarket'), head: true, cell: (f) => market(f.instrument) },
    { id: 'amt', label: t('fxAmount'), num: true, head: true, cell: (f) => <Pnl value={f.amount} locale={locale} dp={4} /> },
    { id: 'rate', label: t('fxRate'), num: true, cell: (f) => pct(f.rate, 5, locale, true) },
    { id: 'size', label: t('fxSize'), num: true, cell: (f) => sz(f.instrument, f.size) },
    { id: 'at', label: t('fxTime'), cell: (f) => <span className="font-normal text-mute">{timeOf(f.ts, locale, true)}</span> },
  ];
  const evCols: Col<RiskEvent>[] = [
    { id: 'k', label: t('fxEvent'), head: true, cell: (e) => { const k = t(`fxEv_${e.kind}` as Key); return k.startsWith('fxEv ') ? e.kind : k; } },
    { id: 'd', label: t('fxDetail'), full: true, cell: (e) => <span className="block max-w-[560px] whitespace-normal">{e.code && RISK_CODES.has(e.code) ? <span className="block">{t(`rk_${e.code}` as Key)}</span> : null}<span className="block break-words text-[12px] font-normal text-mute">{e.code ? `${e.code} — ` : ''}{e.detail}</span></span> },
    { id: 'at', label: t('fxTime'), cell: (e) => <span className="font-normal text-mute">{timeOf(e.ts, locale, true)}</span> },
  ];
  const eq = detail?.equityHistory ?? [];
  const first = dec(eq[0]?.equity), lastEq = dec(account.state.equity), change = first && lastEq ? D.sub(lastEq, first) : null;
  const realized = positions.reduce((a, p) => D.add(a, dec(p.realizedPnl) ?? D.zero), D.zero), unreal = positions.reduce((a, p) => D.add(a, dec(p.unrealizedPnl) ?? D.zero), D.zero);
  const n = (k: number) => (k ? ` (${k})` : '');
  return (
    <div data-testid="blotter">
      <div className="mb-3 flex items-center gap-2">
        <Seg tabs size="sm" label={t('fxBlotter')} value={tab} onChange={(v) => { setTab(v); setErr(null); }} className="min-w-0 flex-1 md:flex-none" options={[
          { id: 'positions', label: `${t('fxPositions')}${n(positions.length)}` }, { id: 'orders', label: `${t('fxOpenOrders')}${n(open.length)}` }, { id: 'history', label: t('fxOrderHistory') },
          { id: 'fills', label: t('fxFills') }, { id: 'funding', label: t('fxFunding') }, { id: 'pnl', label: t('fxPnl') }, { id: 'risk', label: `${t('fxRiskEvents')}${n(detail?.riskEvents.length ?? 0)}` }]} />
        <span className="ml-auto hidden sm:inline-flex"><PaperTag /></span>
      </div>
      {err && <div className="mb-3">{err.code ? <RiskVerdict code={err.code} reason={err.reason ?? ''} /> : <Notice tone="danger">{err.text}</Notice>}</div>}
      <div role="tabpanel" aria-label={t('fxBlotter')}>
        {tab === 'positions' && <DataTable label={t('fxPositions')} cols={posCols} rows={positions} rowKey={(p) => p.instrument} empty={t('fxNoPositions')} emptyIcon="chart" />}
        {tab === 'orders' && <DataTable label={t('fxOpenOrders')} cols={orderCols(true)} rows={open} rowKey={(o) => o.clientId} empty={t('fxNoOpenOrders')} emptyIcon="clock" />}
        {tab === 'history' && <DataTable label={t('fxOrderHistory')} cols={orderCols(false)} rows={detail?.orders ?? []} rowKey={(o) => o.clientId} empty={t('fxNoHistory')} emptyIcon="list" />}
        {tab === 'fills' && <DataTable label={t('fxFills')} cols={fillCols} rows={detail?.fills ?? []} rowKey={(f) => f.id} empty={t('fxNoFills')} emptyIcon="swap" />}
        {tab === 'funding' && <DataTable label={t('fxFunding')} cols={fundCols} rows={detail?.funding ?? []} rowKey={(f) => `${f.instrument}${f.ts}`} empty={t('fxNoFunding')} emptyIcon="clock" />}
        {tab === 'risk' && <DataTable label={t('fxRiskEvents')} cols={evCols} rows={detail?.riskEvents ?? []} rowKey={(e) => e.id} empty={t('fxNoRiskEvents')} emptyIcon="shield" />}
        {tab === 'pnl' && <div className="space-y-4">
          <StatGrid cols={4}>
            <Tile label={t('fxEquity')} value={usd(account.state.equity, locale)} />
            <Tile label={t('fxSinceStart')} value={<Pnl value={change ? D.str(change) : null} locale={locale} />} />
            <Tile label={t('fxUnrealized')} value={<Pnl value={D.str(unreal)} locale={locale} />} />
            <Tile label={t('fxRealizedOpen')} value={<Pnl value={D.str(realized)} locale={locale} />} />
          </StatGrid>
          {eq.length >= 2 ? <PriceChart points={eq.map((p) => ({ t: p.ts, p: Number(p.equity) }))} format={(v) => usd(v.toFixed(2), locale)} formatTime={(ts) => timeOf(ts, locale, true)} />
            : <Empty icon="chart" title={t('fxNoEquity')} />}
          {account.totals && <StatGrid cols={4}>
            <Tile label={t('fxTotRealized')} value={<Pnl value={account.totals.realizedPnl} locale={locale} />} /><Tile label={t('fxTotFees')} value={usd(account.totals.feesPaid, locale)} />
            <Tile label={t('fxTotFunding')} value={<Pnl value={account.totals.fundingNet} locale={locale} />} /><Tile label={t('fxTotLiquidations')} value={account.totals.liquidations} /></StatGrid>}
          <p className="text-[12px] leading-snug text-mute">{t('fxPnlNote')}</p>
        </div>}
      </div>
    </div>
  );
}
