/**
 * The `compare` table for one base asset across venues — a table, never a recommendation: no ranking, no "best" mark. Under
 * it, the contract differences in words (collateral, settlement, funding, leverage, fees) and the reminder that these
 * contracts are not interchangeable (docs/v4/venues/contract-differences.md).
 */
import { useQuery } from '@tanstack/react-query';
import { useContext, useMemo } from 'react';
import { errText, I18n, useT, type Key } from '../i18n';
import { Card, H, Notice, Skeleton } from '../ui';
import { dapi } from './api';
import { DataTable, Seg, VENUE_NAME, VenueBadge, type Col } from './bits';
import { compactUsd, fmt, pct, priceDp } from './dec';
import type { CompareRow, Instrument, VenueId } from './types';

const ORDER: VenueId[] = ['hyperliquid', 'gmx', 'dydx'];
const FIELDS = ['collateral', 'settlement', 'funding', 'leverage', 'fee', 'price'] as const;
const intervalText = (sec: number | null) => (sec === null ? '—' : sec % 3600 === 0 ? `${sec / 3600} h` : `${Math.round(sec / 60)} min`);

export function CompareView({ instruments, base, onBase, onOpen }: { instruments: Instrument[]; base: string; onBase: (b: string) => void; onOpen: (id: string) => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const bases = useMemo(() => { const m = new Map<string, Set<string>>(); for (const i of instruments) (m.get(i.base) ?? m.set(i.base, new Set()).get(i.base)!).add(i.venue);
    return [...m.entries()].filter(([, v]) => v.size > 1).sort((a, b) => b[1].size - a[1].size || Number(b[0] === 'BTC') - Number(a[0] === 'BTC') || Number(b[0] === 'ETH') - Number(a[0] === 'ETH') || a[0].localeCompare(b[0])).map(([b]) => b).slice(0, 8); }, [instruments]);
  const q = useQuery({ queryKey: ['deriv', 'compare', base], queryFn: () => dapi.compare(base), refetchInterval: 10_000 });
  const rows = useMemo(() => [...(q.data ?? [])].sort((a, b) => ORDER.indexOf(a.venue) - ORDER.indexOf(b.venue) || a.instrument.localeCompare(b.instrument)), [q.data]);   // fixed venue order: never by "quality"
  const cols: Col<CompareRow>[] = [
    { id: 'v', label: t('fxVenue'), head: true, cell: (r) => <VenueBadge venue={r.venue} /> },
    { id: 'i', label: t('fxInstrument'), head: true, cell: (r) => <button type="button" onClick={() => onOpen(r.instrument)} className="-my-2 inline-flex min-h-11 items-center text-left font-semibold underline decoration-line underline-offset-4" aria-label={t('fxOpenMarket', { symbol: r.instrument })}>{r.instrument.slice(r.instrument.indexOf(':') + 1)}</button> },
    { id: 'mark', label: t('fxMark'), num: true, cell: (r) => fmt(r.mark, { dp: priceDp('0.01', r.mark), locale }) },
    { id: 'index', label: t('fxIndex'), num: true, cell: (r) => (r.index ? fmt(r.index, { dp: priceDp('0.01', r.index), locale }) : '—') },
    { id: 'fund', label: t('fxFundingPerHour'), num: true, cell: (r) => (r.funding ? <>{pct(r.funding, 5, locale, true)}<span className="block text-[11.5px] text-mute">{r.venue === 'gmx' ? t('fxContinuousShort') : t('fxEveryShort', { interval: intervalText(r.fundingIntervalSec) })}</span></> : '—') },
    { id: 'spread', label: t('fxSpreadBps'), num: true, cell: (r) => (r.spreadBps ? fmt(r.spreadBps, { dp: 2, locale }) : <span className="text-mute">{r.venue === 'gmx' ? t('fxNoBookShort') : '—'}</span>) },
    { id: 'depth', label: t('fxDepth1pct'), num: true, cell: (r) => (r.depthUsd1pct ? compactUsd(r.depthUsd1pct, locale) : <span className="text-mute">{r.venue === 'gmx' ? t('fxNoBookShort') : '—'}</span>) },
    { id: 'fee', label: t('fxTakerFeeBps'), num: true, cell: (r) => (r.takerFeeBps ? fmt(r.takerFeeBps, { dp: 2, locale, trim: true }) : '—') },
    { id: 'lev', label: t('fxMaxLeverage'), num: true, cell: (r) => `${fmt(r.maxLeverage, { dp: 1, locale, trim: true })}×` },
    { id: 'coll', label: t('fxCollateral'), cell: (r) => r.collateral || '—' },
    { id: 'settle', label: t('fxSettlement'), cell: (r) => <span className="block max-w-[320px] whitespace-normal text-[12.5px] leading-snug text-mute md:w-[280px]">{r.settlement || '—'}</span> },
    { id: 'notes', label: t('fxNotes'), cell: (r) => (r.notes.length ? <ul className="max-w-[320px] list-disc space-y-0.5 whitespace-normal pl-4 text-[12.5px] leading-snug text-mute md:w-[280px]">{r.notes.map((n) => <li key={n}>{n}</li>)}</ul> : '—') },
  ];
  const present = ORDER.filter((v) => rows.some((r) => r.venue === v));
  return (
    <div className="space-y-4" data-testid="compare-view">
      <Card>
        <H>{t('fxCompareTitle', { base })}</H>
        {bases.length > 0 && <Seg size="sm" label={t('fxBaseAsset')} value={base} onChange={onBase} options={(bases.includes(base) ? bases : [base, ...bases]).map((b) => ({ id: b, label: b }))} className="mb-3 max-w-xl" />}
        <div className="mb-3"><Notice tone="warn"><b className="font-semibold">{t('fxNotInterchangeable')}</b> {t('fxNotInterchangeableBody')}</Notice></div>
        {q.isLoading ? <Skeleton h="h-40" /> : q.isError ? <Notice tone="danger">{errText(t, q.error) || t('fxErrGeneric')}</Notice>
          : <DataTable label={t('fxCompareTitle', { base })} cols={cols} rows={rows} rowKey={(r) => r.instrument} empty={t('fxCompareEmpty', { base })} />}
        <p className="mt-3 text-[12px] leading-snug text-mute">{t('fxCompareNote')}</p>
      </Card>
      <Card>
        <H>{t('fxDiffTitle')}</H>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">{(present.length ? present : ORDER).map((v) => <section key={v} className="rounded-2xl border border-line p-4" aria-label={VENUE_NAME[v]}>
          <VenueBadge venue={v} />
          <dl className="mt-3 space-y-2.5">{FIELDS.map((k) => <div key={k}><dt className="text-[11.5px] font-semibold uppercase tracking-wide text-mute">{t(`fxDiffField_${k}` as Key)}</dt><dd className="text-[13px] leading-snug">{t(`fxDiff_${v}_${k}` as Key)}</dd></div>)}</dl>
        </section>)}</div>
        <ul className="mt-4 list-disc space-y-1.5 pl-5 text-[13px] leading-snug">{(['fxNever1', 'fxNever2', 'fxNever3', 'fxNever4'] as const).map((k) => <li key={k}>{t(k)}</li>)}</ul>
        <p className="mt-3 text-[12px] leading-snug text-mute">{t('fxDiffSource')}</p>
      </Card>
    </div>
  );
}
