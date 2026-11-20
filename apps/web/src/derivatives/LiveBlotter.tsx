/**
 * Bottom of the terminal for a VENUE account. Positions and resting orders are the venue's own (`venueState`, source: venue);
 * the history is the wallet's record of every proposal and what became of it; fills and funding were read from the venue by
 * the reconciliation worker. Closing a position is a proposal approved with the passkey; cancelling an order needs none.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { PriceChart } from '../chart';
import { I18n, useT, type Key } from '../i18n';
import { Icon, Notice, Stat as Tile, StatGrid, Tag } from '../ui';
import { RISK_CODES } from './api';
import { DataTable, Pnl, Seg, SideTag, timeOf, type Col } from './bits';
import { D, dec, dpOf, fmt, pct, priceDp, usd } from './dec';
import { ApprovalSheet } from './LiveApproval';
import { LiveErrNotice, LiveStatePill, ModeTag, SourceTag } from './LiveBits';
import { inFlight, lapi, liveError, toneOf, type LiveDetail, type LiveErr, type LiveFunding, type LiveOrder, type LiveRiskEvent, type LiveSummary } from './live';
import { refreshLive } from './liveStore';
import type { BlotterTab } from './Blotter';
import type { Fill, Instrument, Order, Position } from './types';

const sym = (id: string) => id.slice(id.indexOf(':') + 1);
const mini = 'press inline-flex min-h-11 min-w-11 shrink-0 whitespace-nowrap items-center justify-center rounded-xl border border-line px-3 text-[0.8125rem] font-semibold text-ink hover:bg-elev disabled:opacity-45';
/** a resting order as the venue lists it, with the wallet's own record of it when the wallet placed it */
interface Resting { o: Order; ours: LiveOrder | null }

export function LiveBlotter({ account, detail, instruments, ttlMs, onSelect }: { account: LiveSummary; detail: LiveDetail | undefined; instruments: Map<string, Instrument>; ttlMs: number; onSelect: (id: string) => void }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const [tab, setTab] = useState<BlotterTab>('positions');
  const [busy, setBusy] = useState(''), [err, setErr] = useState<LiveErr | null>(null), [note, setNote] = useState('');
  const [closing, setClosing] = useState<{ position: Position; fraction: string } | null>(null);
  const a = detail ?? account, tone = toneOf(account), st = detail?.venueState;
  const positions = st?.positions ?? [], orders = detail?.orders ?? [];
  const resting: Resting[] = (st?.openOrders ?? []).map((o) => ({ o, ours: orders.find((x) => x.cloid !== null && x.cloid === o.clientId) ?? null }));
  const flying = orders.filter((o) => inFlight(o.state) && !o.final);
  const px = (id: string, v: string | null | undefined) => (v ? fmt(v, { dp: priceDp(instruments.get(id)?.tickSize, v), locale }) : '—');
  const sz = (id: string, v: string) => fmt(v, { dp: Math.min(8, dpOf(instruments.get(id)?.lotSize ?? '0.0001')), locale, trim: true });
  const market = (id: string) => <button type="button" onClick={() => onSelect(id)} className="-my-2 inline-flex min-h-11 items-center font-semibold underline decoration-line underline-offset-4 hover:decoration-ink" aria-label={t('fxOpenMarket', { symbol: sym(id) })}>{sym(id)}</button>;
  const off = account.network === 'mainnet' && !account.mainnetEnabled, canAct = a.mode === 'MANUAL_LIVE' && !off;
  const cancel = async (o: LiveOrder) => {
    setBusy(`x${o.clientId}`); setErr(null); setNote('');
    try { const r = await lapi.cancel(account.id, o.clientId); if (r.venue && r.venue.outcome !== 'accepted') setNote(`${t(r.venue.outcome === 'refused' ? 'flCancelRefused' : 'flCancelUnknown')}${r.venue.error ? ` — ${r.venue.error}` : ''}`); }
    catch (e) { setErr(liveError(e)); } finally { setBusy(''); void refreshLive(qc, account.id); }
  };

  const posCols: Col<Position>[] = [
    { id: 'm', label: t('fxMarket'), head: true, cell: (p) => market(p.instrument) },
    { id: 'side', label: t('fxDirection'), head: true, cell: (p) => <SideTag side={p.side} /> },
    { id: 'close', label: t('flClosePos'), full: true, cell: (p) => <span className="inline-flex gap-1.5" role="group" aria-label={t('fxCloseAria', { symbol: sym(p.instrument) })}>
      {(['0.25', '0.5', '1'] as const).map((fr) => <button key={fr} type="button" disabled={!canAct || !!closing} className={mini} onClick={() => { setErr(null); setNote(''); setClosing({ position: p, fraction: fr }); }}
        aria-label={t('fxCloseFrac', { pct: fr === '1' ? 100 : fr === '0.5' ? 50 : 25, symbol: sym(p.instrument) })}>{fr === '1' ? '100' : fr === '0.5' ? '50' : '25'} %</button>)}</span> },
    { id: 'size', label: t('fxSize'), num: true, cell: (p) => <>{sz(p.instrument, p.size)} <span className="text-mute">≈ {usd(D.mul(dec(p.size) ?? D.zero, dec(p.markPrice) ?? D.zero), locale)}</span></> },
    { id: 'entry', label: t('fxEntry'), num: true, cell: (p) => px(p.instrument, p.entryPrice) },
    { id: 'mark', label: t('fxMark'), num: true, cell: (p) => px(p.instrument, p.markPrice) },
    { id: 'liq', label: t('flLiqVenue'), num: true, cell: (p) => px(p.instrument, p.liquidationPrice) },
    { id: 'lev', label: t('fxLeverage'), num: true, cell: (p) => `${fmt(p.leverage, { dp: 1, locale, trim: true })}× · ${t(p.marginMode === 'cross' ? 'fxCross' : 'fxIsolated')}` },
    { id: 'margin', label: t('fxMargin'), num: true, cell: (p) => usd(p.margin, locale) },
    { id: 'upnl', label: t('fxUnrealized'), num: true, cell: (p) => <b className="font-semibold"><Pnl value={p.unrealizedPnl} locale={locale} /></b> },
    { id: 'fund', label: t('fxFundingPaid'), num: true, cell: (p) => (p.fundingPaid === null ? '—' : usd(p.fundingPaid, locale, true)) },
  ];
  const typeCell = (o: { type: string; reduceOnly: boolean; tif: string }) => <>{t(`fxType_${o.type}` as Key)}{o.reduceOnly ? <span className="text-mute"> · {t('fxReduceOnly')}</span> : null}{o.tif === 'alo' ? <span className="text-mute"> · {t('fxPostOnly')}</span> : o.tif === 'ioc' ? <span className="text-mute"> · IOC</span> : null}</>;
  const restCols: Col<Resting>[] = [
    { id: 'm', label: t('fxMarket'), head: true, cell: ({ o }) => market(o.instrument) },
    { id: 'side', label: t('fxSideCol'), head: true, cell: ({ o }) => <SideTag side={o.side} /> },
    { id: 'type', label: t('fxOrderType'), cell: ({ o }) => typeCell(o) },
    { id: 'size', label: t('fxSize'), num: true, cell: ({ o }) => sz(o.instrument, o.size) },
    { id: 'filled', label: t('fxFilled'), num: true, cell: ({ o }) => sz(o.instrument, o.filled) },
    { id: 'price', label: t('fxPrice'), num: true, cell: ({ o }) => px(o.instrument, o.price) },
    { id: 'trig', label: t('fxTriggerPrice'), num: true, cell: ({ o }) => px(o.instrument, o.triggerPrice) },
    { id: 'st', label: t('fxStatus'), cell: ({ ours }) => (ours ? <LiveStatePill state={ours.state} /> : <Tag tone="danger" icon="warn">{t('flForeign')}</Tag>) },
    { id: 'at', label: t('fxTime'), cell: ({ o }) => <span className="text-mute">{timeOf(o.createdAt, locale, true)}</span> },
    { id: 'x', label: '', cell: ({ o, ours }) => (ours ? <button type="button" disabled={!!busy || !canAct} className={mini} onClick={() => void cancel(ours)} aria-label={t('fxCancelAria', { symbol: sym(o.instrument) })}>{t('fxCancelOrder')}</button>
      : <span className="block max-w-[260px] whitespace-normal text-[0.71875rem] leading-snug text-mute">{t('flForeignHint')}</span>) },
  ];
  const histCols: Col<LiveOrder>[] = [
    { id: 'm', label: t('fxMarket'), head: true, cell: (o) => market(o.instrument) },
    { id: 'side', label: t('fxSideCol'), head: true, cell: (o) => <SideTag side={o.side} /> },
    { id: 'st', label: t('fxStatus'), head: true, cell: (o) => <LiveStatePill state={o.state} /> },
    { id: 'type', label: t('fxOrderType'), cell: (o) => <>{typeCell(o)}{o.origin === 'close' ? <span className="text-mute"> · {t('flOriginClose')}</span> : null}</> },
    { id: 'size', label: t('fxSize'), num: true, cell: (o) => sz(o.instrument, o.size) },
    { id: 'filled', label: t('fxFilled'), num: true, cell: (o) => sz(o.instrument, o.filled) },
    { id: 'price', label: t('fxPrice'), num: true, cell: (o) => px(o.instrument, o.avgFillPrice ?? o.price) },
    { id: 'src', label: t('flSource'), cell: (o) => <SourceTag source={o.source} /> },
    { id: 'at', label: t('fxTime'), cell: (o) => <span className="text-mute">{timeOf(o.createdAt, locale, true)}</span> },
    { id: 'why', label: t('fxReason'), full: true, cell: (o) => <span className="block max-w-[420px] whitespace-normal break-words text-[0.75rem] text-mute">{inFlight(o.state) && !o.final ? `${t('flUnknownShort')} ` : ''}{o.reason ?? '—'}</span> },
  ];
  const fillCols: Col<Fill>[] = [
    { id: 'm', label: t('fxMarket'), head: true, cell: (f) => market(f.instrument) },
    { id: 'side', label: t('fxSideCol'), head: true, cell: (f) => <><SideTag side={f.side} />{f.liquidation && <span className="ml-2"><Tag tone="danger" icon="warn">{t('fxLiquidation')}</Tag></span>}</> },
    { id: 'price', label: t('fxPrice'), num: true, cell: (f) => px(f.instrument, f.price) },
    { id: 'size', label: t('fxSize'), num: true, cell: (f) => sz(f.instrument, f.size) },
    { id: 'fee', label: t('fxFee'), num: true, cell: (f) => `${fmt(f.fee, { dp: 4, locale })} ${f.feeAsset}` },
    { id: 'pnl', label: t('fxClosedPnl'), num: true, cell: (f) => <Pnl value={f.closedPnl} locale={locale} /> },
    { id: 'at', label: t('fxTime'), cell: (f) => <span className="text-mute">{timeOf(f.ts, locale, true)}</span> },
  ];
  const fundCols: Col<LiveFunding>[] = [
    { id: 'm', label: t('fxMarket'), head: true, cell: (f) => market(f.instrument) },
    { id: 'amt', label: t('fxAmount'), num: true, head: true, cell: (f) => <Pnl value={f.amount} locale={locale} dp={4} /> },
    { id: 'rate', label: t('fxRate'), num: true, cell: (f) => pct(f.rate, 5, locale, true) },
    { id: 'size', label: t('fxSize'), num: true, cell: (f) => sz(f.instrument, f.size) },
    { id: 'at', label: t('fxTime'), cell: (f) => <span className="text-mute">{timeOf(f.ts, locale, true)}</span> },
  ];
  const evCols: Col<LiveRiskEvent>[] = [
    { id: 'k', label: t('fxEvent'), head: true, cell: (e) => { const k = t(`flEv_${e.kind}` as Key); return k.startsWith('flEv ') || k.startsWith('lEv') ? e.kind : k; } },
    { id: 'd', label: t('fxDetail'), cell: (e) => <span className="block max-w-[560px] whitespace-normal">{e.code && RISK_CODES.has(e.code) ? <span className="block">{t(`rk_${e.code}` as Key)}</span> : null}<span className="block break-words text-[0.75rem] text-mute">{e.code ? `${e.code} — ` : ''}{e.message}</span></span> },
    { id: 'at', label: t('fxTime'), cell: (e) => <span className="text-mute">{timeOf(e.ts, locale, true)}</span> },
  ];
  const eq = detail?.equity ?? [], state = st?.state ?? null;
  const unreal = positions.reduce((x, p) => D.add(x, dec(p.unrealizedPnl) ?? D.zero), D.zero);
  const n = (k: number) => (k ? ` (${k})` : '');
  return (
    <div data-testid="blotter" data-account-kind="venue">
      <div className="mb-3 flex items-center gap-2">
        <Seg tabs size="sm" label={t('fxBlotter')} value={tab} onChange={(v) => { setTab(v); setErr(null); setNote(''); }} className="min-w-0 flex-1" options={[
          { id: 'positions', label: `${t('fxPositions')}${n(positions.length)}` }, { id: 'orders', label: `${t('fxOpenOrders')}${n(resting.length)}` }, { id: 'history', label: t('fxOrderHistory') },
          { id: 'fills', label: t('fxFills') }, { id: 'funding', label: t('fxFunding') }, { id: 'pnl', label: t('fxPnl') }, { id: 'risk', label: `${t('fxRiskEvents')}${n(detail?.riskEvents.length ?? 0)}` }]} />
        <ModeTag tone={tone} className="hidden sm:inline-flex" />
      </div>
      {st?.error && <div className="mb-3"><Notice tone="danger">{t('flUnreadable')} <span className="mt-1 block break-words font-mono text-[0.71875rem] text-mute">{st.error}</span></Notice></div>}
      {flying.length > 0 && <div className="mb-3"><Notice tone="warn"><div data-testid="in-flight">{t('flInFlight', { n: flying.length })}</div></Notice></div>}
      {err && <div className="mb-3"><LiveErrNotice err={err} /></div>}
      {note && <div className="mb-3"><Notice tone="warn">{note}</Notice></div>}
      <div role="tabpanel" aria-label={t('fxBlotter')}>
        {(tab === 'positions' || tab === 'orders') && !st?.error && <p className="mb-2.5 flex flex-wrap items-center gap-1.5 text-[0.75rem] text-mute"><SourceTag />{st ? t('flReadAt', { time: timeOf(st.ts, locale) }) : t('fxLoading')}</p>}
        {tab === 'positions' && !st?.error && <DataTable label={t('fxPositions')} cols={posCols} rows={positions} rowKey={(p) => p.instrument} empty={t('fxNoPositions')} />}
        {tab === 'orders' && !st?.error && <DataTable label={t('fxOpenOrders')} cols={restCols} rows={resting} rowKey={({ o }) => o.venueOrderId ?? o.clientId} empty={t('fxNoOpenOrders')} />}
        {tab === 'history' && <DataTable label={t('fxOrderHistory')} cols={histCols} rows={orders} rowKey={(o) => o.clientId} empty={t('fxNoHistory')} />}
        {tab === 'fills' && <DataTable label={t('fxFills')} cols={fillCols} rows={detail?.fills ?? []} rowKey={(f) => f.id} empty={t('fxNoFills')} />}
        {tab === 'funding' && <DataTable label={t('fxFunding')} cols={fundCols} rows={detail?.funding ?? []} rowKey={(f) => `${f.instrument}${f.ts}`} empty={t('fxNoFunding')} />}
        {tab === 'risk' && <DataTable label={t('fxRiskEvents')} cols={evCols} rows={detail?.riskEvents ?? []} rowKey={(e) => e.id} empty={t('fxNoRiskEvents')} />}
        {tab === 'pnl' && <div className="space-y-4">
          <StatGrid cols={4}>
            <Tile label={t('fxEquity')} value={usd(state?.equity, locale)} /><Tile label={t('fxCollateral')} value={usd(state?.collateral, locale)} />
            <Tile label={t('fxUnrealized')} value={<Pnl value={D.str(unreal)} locale={locale} />} /><Tile label={t('fxWithdrawable')} value={usd(state?.withdrawable, locale)} /></StatGrid>
          {eq.length >= 2 ? <PriceChart points={eq.map((p) => ({ t: p.ts, p: Number(p.equity) }))} format={(v) => usd(v.toFixed(2), locale)} formatTime={(ts) => timeOf(ts, locale, true)} />
            : <div className="flex items-center gap-3 rounded-[18px] bg-elev/50 px-4 py-4 text-[0.84375rem] text-mute"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface"><Icon n="chart" className="h-[18px] w-[18px]" /></span><span className="min-w-0">{t('fxNoEquity')}</span></div>}
          <p className="flex items-start gap-1.5 text-[0.75rem] leading-snug text-mute"><SourceTag /><span className="min-w-0">{t('flPnlNote')}</span></p>
        </div>}
      </div>
      {closing && <ApprovalSheet account={a} instrument={instruments.get(closing.position.instrument)} request={{ kind: 'close', position: closing.position, fraction: closing.fraction }} orders={orders} ttlMs={ttlMs} onClose={() => setClosing(null)} />}
    </div>
  );
}
