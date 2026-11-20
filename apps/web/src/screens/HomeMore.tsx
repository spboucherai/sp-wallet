/**
 * NEXT dashboard — the parts of Home that the first paint does not need, in a chunk of their own (Home.tsx mounts them
 * lazily, behind skeletons of their size): the value history with its range selector, the allocation, the attention strip,
 * the recent activity and the period's tiles. Every figure is the SERVER's (`summary`, /portfolio/history, /analytics).
 */
import { useQuery } from '@tanstack/react-query';
import { useContext, useMemo, useState } from 'react';
import { get } from '../api';
import type { Nav, Tab } from '../App';
import { useUnread } from '../alerts';
import { Allocation } from '../chart';
import type { Bal, Proposal } from '../hooks';
import { I18n, useT, type Key } from '../i18n';
import { lifecycleOf } from '../lifecycle';
import { cmpDecimal, fiatText, pctText } from '../money';
import { Card, Coin, fiat, H, Icon, Money, Notice, Seg, Skeleton, StatTile, trimAmt, when } from '../ui';
import { Spark } from '../spark';
import { ValueChart, type FlowMark } from '../value-chart';
import type { VPoint } from '../value-geom';
import { useContacts, useHistory, type History, type Range, type Summary } from '../wallet';
import { useAnalytics } from '../wallet-more';
import { RangeSelector, TransactionRow } from '../tx-row';
import { ChangeText, useFallbackInterval } from '../wallet-ui';
import { foldInternal, type WalletItem } from '../walletItems';

/** the recent movements of the wallet (one read shared by the chart's flow markers, the attention strip and the list) */
function useRecent() {
  const ms = useFallbackInterval(30_000, 180_000);
  return useQuery({ queryKey: ['activity', 'recent'], queryFn: () => get<{ items: WalletItem[] }>('/activity?limit=40'), refetchInterval: ms, staleTime: 10_000 });
}

/** the period's figures over the chart: change of value, what entered and left, and the ESTIMATED effect of prices — never a « return » */
function HistoryFigures({ h, cur, hidden, scrub }: { h: History; cur: string; hidden: boolean; scrub: VPoint | null }) {
  const t = useT(); const { locale } = useContext(I18n);
  const vc = h.valueChange, em = h.estimatedMarketChange;
  const time = (ms: number) => new Date(ms).toLocaleString(locale === 'fr' ? 'fr-CA' : 'en-CA', h.range === '1D' ? { hour: '2-digit', minute: '2-digit' } : h.range === '1W' || h.range === '1M' ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', year: 'numeric' });
  return <div data-testid="history-figures">
    <div className="t-footnote text-mute">{scrub ? time(scrub.t) : t('nwValueChange')}</div>
    <div className="t-title2 amt mt-0.5 min-h-[1.65rem]" data-testid="history-headline">{hidden ? '••••' : scrub ? fiatText(scrub.total, cur, locale) : vc ? <ChangeText abs={vc.abs} pct={vc.pct} cur={cur} /> : '—'}</div>
    {!hidden && <dl className="t-footnote mt-2 flex flex-wrap gap-x-5 gap-y-1 text-mute">
      <div className="flex gap-1.5"><dt>{t('nwNetFlows')}</dt><dd className="font-semibold text-ink" data-testid="net-flows">{fiatText(h.flows.net, cur, locale, { sign: true })}</dd></div>
      {em && <div className="flex gap-1.5" title={t('nwEstMarketNote')}><dt>{t('nwEstMarket')}</dt><dd className="font-semibold text-ink" data-testid="est-market">≈ {fiatText(em.abs, cur, locale, { sign: true })}</dd></div>}
    </dl>}
  </div>;
}

function ValueHistory({ range, setRange, cur, hidden }: { range: Range; setRange: (r: Range) => void; cur: string; hidden: boolean }) {
  const t = useT(); const { locale } = useContext(I18n);
  const q = useHistory(range), recent = useRecent(); const [scrub, setScrub] = useState<VPoint | null>(null);
  const h = q.data;   // the previous range stays drawn while the next one loads (placeholderData): no flash of skeleton
  const loc = locale === 'fr' ? 'fr-CA' : 'en-CA';
  const timeFmt = (ms: number) => new Date(ms).toLocaleString(loc, h?.range === '1D' ? { hour: '2-digit', minute: '2-digit' } : h?.range === '1Y' || h?.range === 'ALL' ? { month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
  // what entered and left, marked on the time axis: the server's own list when it sends one (asked of the backend), else the
  // recent movements read for this screen — external deposits and FINAL plain sends only
  const marks: FlowMark[] = useMemo(() => {
    if (h?.flows.events?.length) return h.flows.events.map((f) => ({ t: new Date(f.at).getTime(), direction: f.direction, label: t(f.direction === 'in' ? 'nwFlowIn' : 'nwFlowOut', { amount: f.value ? fiatText(f.value, cur, locale) : `${f.amount ?? ''} ${f.symbol ?? ''}`.trim(), date: when(f.at, locale) }) }));
    return foldInternal(recent.data?.items ?? []).filter((i) => (i.kind === 'receive' && i.depositKind !== 'internal') || (i.kind === 'send' && lifecycleOf(i) === 'confirmed'))
      .map((i) => ({ t: new Date(i.at).getTime(), direction: i.kind === 'receive' ? 'in' as const : 'out' as const, label: t(i.kind === 'receive' ? 'nwFlowIn' : 'nwFlowOut', { amount: `${trimAmt(i.amountDisplay)} ${i.symbol}`, date: when(i.at, locale) }) }));
  }, [h, recent.data, cur, locale]);   // eslint-disable-line react-hooks/exhaustive-deps
  const old = q.isError && (q.error as { status?: number } | null)?.status === 404;
  const extreme = (dir: 1 | -1) => h!.points.reduce((m, p) => (cmpDecimal(p.total, m) * dir > 0 ? p.total : m), h!.points[0]!.total);
  return (
    <Card className="!pb-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2"><h2 className="t-headline">{t('nwValueHistory')}</h2>
        <div className="w-full sm:w-auto sm:min-w-[19rem]"><RangeSelector value={range} onChange={(r) => { setScrub(null); setRange(r); }} /></div></div>
      {!h ? (q.isError ? <div data-testid="history-error" className="t-callout flex items-center justify-between gap-3 py-6 text-mute"><span>{t(old ? 'nwHistoryOld' : 'nwHistoryErr')}</span>{!old && <button className="link" onClick={() => void q.refetch()}>{t('retry')}</button>}</div>
        : <div aria-busy="true"><Skeleton h="h-12" className="!w-48 !rounded-xl" /><Skeleton h="h-[200px]" className="mt-3 !rounded-2xl" /></div>) : <div data-testid="history" data-range={h.range} data-fetching={q.isFetching}>
        <HistoryFigures h={h} cur={cur} hidden={hidden} scrub={scrub} />
        <div className={`mt-3 ${hidden ? 'mask' : ''}`} aria-hidden={hidden || undefined}>
          <ValueChart rows={h.points} snapshotEveryMs={h.retention.snapshotEveryMinutes * 60_000} flows={marks} onScrub={setScrub} format={(v) => fiatText(v, cur, locale)} formatTime={timeFmt} scrubHint={t('nwChartKeys')}
            summary={h.first && h.last && h.points.length >= 2 ? t('nwChartSummary', { from: when(h.first.t, locale), to: when(h.last.t, locale), first: fiatText(h.first.total, cur, locale), last: fiatText(h.last.total, cur, locale), min: fiatText(extreme(-1), cur, locale), max: fiatText(extreme(1), cur, locale) })
              : t('nwNoHistory', { n: h.retention.snapshotEveryMinutes })} /></div>
        <ul className="t-footnote mt-3 space-y-1 text-mute">
          <li>{t('nwEstMarketNote')}{h.estimatedMarketChange && !h.estimatedMarketChange.complete ? ` ${t('nwEstPartial', { n: h.flows.unvalued.length })}` : ''}</li>
          {marks.length > 0 && h.points.length >= 2 && <li data-testid="flows-legend">{t('nwFlowsLegend')}</li>}
          {h.omitted.incomplete > 0 && <li data-testid="history-omitted">{t('nwOmitted', { n: h.omitted.incomplete })}</li>}
        </ul></div>}
    </Card>);
}

/** the value history, then the allocation — by asset or by network, the server's own split */
export function HomeValue({ range, setRange, cur, hidden, summary: s, netName }: { range: Range; setRange: (r: Range) => void; cur: string; hidden: boolean; summary: Summary | null; netName: (id: string) => string }) {
  const t = useT(); const { locale } = useContext(I18n);
  const [split, setSplit] = useState<'asset' | 'network'>('asset');
  const parts = s ? (split === 'asset' ? s.byAsset.map((a) => ({ id: a.symbol, label: a.symbol, share: a.share, value: fiatText(a.value, cur, locale) })) : s.byNetwork.map((n) => ({ id: n.network, label: netName(n.network), share: n.share, value: fiatText(n.value, cur, locale) }))) : [];
  return <>
    <ValueHistory range={range} setRange={setRange} cur={cur} hidden={hidden} />
    {parts.length > 0 && <Card><div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2"><h2 className="t-headline">{t('nwAlloc')}</h2>
      <div className="min-w-[13.5rem]"><Seg compact testid="alloc-split" label={t('nwAlloc')} value={split} onChange={setSplit} options={[['asset', t('nwByAsset')], ['network', t('nwByNetwork')]]} /></div></div>
      <Allocation parts={parts} hidden={hidden} label={t('dsAllocation')} otherLabel={t('dsOther')} pct={(x) => pctText(x * 100, locale, x < 0.1 ? 1 : 0)} />
      {s && !s.complete && <p className="t-footnote mt-3 text-mute">{t('nwAllocPartial')}</p>}</Card>}
  </>;
}

/** what needs the owner's attention — the strip is not drawn at all when there is nothing */
export function HomeAttention({ pending, nav, go }: { pending: Proposal[]; nav: Nav; go: (t: Tab) => void }) {
  const t = useT(); const unread = useUnread(), recent = useRecent();
  const items = foldInternal(recent.data?.items ?? []);
  const watched = items.filter((i) => i.watched || ['dropped', 'replaced'].includes(lifecycleOf(i))), toApprove = pending.filter((p) => lifecycleOf(p) === 'awaiting_confirmation');
  const attention: { id: string; tone: 'warn' | 'danger' | 'info'; text: string; cta: string; go: () => void }[] = [
    ...(unread.unread > 0 ? [{ id: 'alerts', tone: unread.critical ? 'danger' as const : 'info' as const, text: t(unread.unread === 1 ? 'nwAttAlerts1' : 'nwAttAlerts', { n: unread.unread }), cta: t('nwAttOpen'), go: () => go('alerts') }] : []),
    ...(watched.length > 0 ? [{ id: 'watched', tone: 'warn' as const, text: t(watched.length === 1 ? 'nwAttWatched1' : 'nwAttWatched', { n: watched.length }), cta: t('activity'), go: () => nav({ tab: 'activity', asset: watched[0]!.id }) }] : []),
    ...(toApprove.length > 0 ? [{ id: 'approve', tone: 'info' as const, text: t(toApprove.length === 1 ? 'nwAttApprove1' : 'nwAttApprove', { n: toApprove.length }), cta: t('activity'), go: () => go('activity') }] : []),
  ];
  if (attention.length === 0) return null;
  return <section aria-label={t('nwAttention')} data-testid="attention" className="space-y-2">{attention.map((x) =>
    <Notice key={x.id} tone={x.tone} action={<button className="link" onClick={x.go}>{x.cta}<Icon n="chev" className="h-4 w-4" /></button>}><span data-attention={x.id}>{x.text}</span></Notice>)}</section>;
}

/** the five latest movements, then the tiles of the selected period */
export function HomeRecent({ range, cur, hidden, nav, go, netName }: { range: Range; cur: string; hidden: boolean; nav: Nav; go: (t: Tab) => void; netName: (id: string) => string }) {
  const t = useT(); const { locale } = useContext(I18n);
  const recent = useRecent(), contacts = useContacts(), analytics = useAnalytics(range), hist = useHistory(range);
  const latest = foldInternal(recent.data?.items ?? []).slice(0, 5);
  const loc = locale === 'fr' ? 'fr-CA' : 'en-CA';
  const rowTime = (at: string) => { const dt = new Date(at), today = new Date().toDateString() === dt.toDateString(); return dt.toLocaleString(loc, today ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
  const a = analytics.data ?? null, flows = hist.data?.flows ?? null, rangeName = t(`nwRL_${range}` as Key);
  return <>
    <Card className="!px-0 !pb-0"><div className="px-[var(--card-padding)]"><H right={<button className="link -my-2" data-testid="see-all-activity" onClick={() => go('activity')}>{t('nwSeeAll')}<Icon n="chev" className="h-4 w-4" /></button>}>{t('nwRecent')}</H></div>
      {!recent.data ? (recent.isError ? <p className="t-callout px-[var(--card-padding)] pb-5 text-mute" data-testid="recent-error">{t('nxActivityErr')} <button className="link" onClick={() => void recent.refetch()}>{t('retry')}</button></p> : <div className="px-[var(--card-padding)] pb-5" aria-busy="true"><Skeleton h="h-14" /></div>)
        : latest.length === 0 ? <p className="t-callout px-[var(--card-padding)] pb-5 text-mute" data-testid="recent-empty">{t('nwNoRecent')}</p>
        : <ul data-testid="recent-activity" className="pb-1">{latest.map((i) => <li key={i.id}><TransactionRow i={i} contacts={contacts.data} hidden={hidden} time={rowTime(i.at)} onOpen={() => nav({ tab: 'activity', asset: i.id })} /></li>)}</ul>}</Card>

    {(flows || a) && <section aria-label={t('nwTiles', { range: rangeName })} data-testid="tiles"><h2 className="t-eyebrow mb-2 px-1">{t('nwTiles', { range: rangeName })}</h2>
      <div className="grid grid-cols-2 gap-3">
        {flows && <StatTile testid="tile-in" label={t('nwTileIn')} value={<Money hidden={hidden}>{fiatText(flows.external.in, cur, locale)}</Money>} note={t('nwTileFlowsNote')} />}
        {flows && <StatTile testid="tile-out" label={t('nwTileOut')} value={<Money hidden={hidden}>{fiatText(flows.external.out, cur, locale)}</Money>} note={flows.complete ? t('nwTileFlowsNote') : t('nwEstPartial', { n: flows.unvalued.length })} />}
        {a?.feesPaid != null && <StatTile testid="tile-fees" label={t('nwTileFees')} value={<Money hidden={hidden}>{fiatText(a.feesPaid, cur, locale)}</Money>} note={a.feesCount !== null ? t('nwTileFeesNote', { n: a.feesCount }) : undefined} />}
        {a?.networkFees.slice(0, 1).map((f) => <StatTile key={f.network} testid="tile-fee-now" label={t('nwTileFeeNow')} value={f.fiat !== null ? `≈ ${fiatText(f.fiat, cur, locale)}` : f.fee !== null ? `≈ ${trimAmt(f.fee, 9)} ${f.symbol ?? ''}` : '—'} note={netName(f.network)} />)}
      </div></section>}
  </>;
}

/** market cards of well-known assets the wallet does not hold: logo, name, a real sparkline of the last 7 days, price and 24 h change (text carries the values) */
export function HomePopular({ featured, title, prices, ck, cur, count, nav }: { featured: Bal[]; title: string; prices: Record<string, { usd: number; cad: number; change24h: number | null; spark: number[] }> | null; ck: 'usd' | 'cad'; cur: string; count: number; nav: Nav }) {
  const t = useT(); const { locale } = useContext(I18n);
  return <Card className="!px-0 !pb-0"><div className="px-[var(--card-padding)]"><H>{title}</H></div>
    <ul className="no-scrollbar flex snap-x gap-3 overflow-x-auto px-[var(--card-padding)] pb-4">{featured.map((b) => { const m = prices?.[b.symbol];
      return <li key={b.network + b.asset} className="snap-start"><button onClick={() => nav({ tab: 'asset', network: b.network, asset: b.asset })} className="press flex h-full w-[9.25rem] flex-col rounded-[var(--radius-md)] border border-line bg-elev/40 p-3.5 text-left">
        <span className="flex items-center gap-2.5"><Coin sym={b.symbol} net={b.network} size={34} /><span className="min-w-0"><span className="t-callout block truncate font-semibold leading-tight">{b.name}</span><span className="t-micro block truncate text-mute">{b.symbol} · {b.networkName}</span></span></span>
        {m && <><span className="mt-3 block h-9"><Spark data={m.spark} w={118} h={36} /></span>
        <span className="t-body-strong mt-2 block leading-tight">{fiat(m[ck], cur, locale)}</span>
        <span className="t-footnote mt-0.5 block min-h-[1.25rem]">{m.change24h !== null && <ChangeText pct={m.change24h} />}</span></>}</button></li>; })}</ul>
    <button onClick={() => nav({ tab: 'assets' })} className="row row-press justify-between rounded-b-[var(--radius-lg)] border-t border-line font-semibold text-accent">
      <span>{t('allAssets')} <span className="font-normal text-mute">· {t('tokensCount', { n: count })}</span></span><Icon n="chev" className="h-5 w-5" /></button></Card>;
}
