/**
 * Order book (depth bars, spread in basis points, grouping), recent trades, and — for GMX, which has no order book — the
 * liquidity / price-impact / funding-and-borrowing panel. Each component subscribes to its own slice of the market store.
 * v10: the rows keep a fixed height and a fixed grid, so a new book is a text change and a bar that scales (a transform — no
 * layout, no transition): nothing else moves at 8 commits a second.
 */
import { memo, useContext, useMemo, useState } from 'react';
import { I18n, useT } from '../i18n';
import { Notice } from '../ui';
import { Empty, Row, timeOf } from './bits';
import { compactUsd, D, dec, dpOf, fmt, naturalStep, pct, priceDp } from './dec';
import { groupBook, type BookRow } from './reducers';
import { useSlice, type MarketStore } from './store';
import type { Instrument } from './types';

const MULTS = [1, 2, 5, 10, 50, 100];
const GRID = 'grid grid-cols-[1fr_1fr_1fr] items-center gap-2 px-2';

const Level = memo(function Level({ r, side, pdp, sdp, locale }: { r: BookRow; side: 'bid' | 'ask'; pdp: number; sdp: number; locale: string }) {
  return <div className={`relative h-[23px] text-[0.78125rem] leading-none ${GRID}`}>
    <span className={`absolute inset-y-px right-0 w-full origin-right ${side === 'bid' ? 'bg-emerald/14' : 'bg-danger/12'}`} style={{ transform: `scaleX(${r.depth.toFixed(3)})` }} aria-hidden="true" />
    <span className={`relative font-semibold ${side === 'bid' ? 'text-emerald' : 'text-danger'}`}>{fmt(r.price, { dp: pdp, locale })}</span>
    <span className="relative text-right">{fmt(r.size, { dp: sdp, locale })}</span>
    <span className="relative text-right text-mute">{fmt(r.total, { dp: sdp, locale })}</span>
  </div>;
});
/** the book before its first snapshot: rows of the final height, bars of plausible depths */
function BookSkeleton({ rows }: { rows: number }) {
  const bar = (k: number) => <div key={k} className="flex h-[23px] items-center px-2"><div className="skel h-3 !rounded-md" style={{ width: `${38 + ((k * 37) % 55)}%` }} /></div>;
  return <div aria-hidden="true" data-testid="book-skeleton"><div className="mb-2 flex items-center justify-between"><div className="skel h-9 w-32 !rounded-xl" /><div className="skel h-3 w-20 !rounded-md" /></div>
    {Array.from({ length: rows }, (_, k) => bar(k))}<div className="skel my-1.5 h-8 !rounded-lg" />{Array.from({ length: rows }, (_, k) => bar(k + 3))}</div>;
}

export function BookPanel({ store, instrument, rows }: { store: MarketStore; instrument: Instrument; rows: number }) {
  const t = useT(); const { locale } = useContext(I18n);
  const book = useSlice(store, 'book');
  const [mult, setMult] = useState(1);
  const base = useMemo(() => (book ? naturalStep([book.bids, book.asks], instrument.tickSize) : instrument.tickSize), [book === null, instrument.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const step = useMemo(() => { const b = dec(base); return b ? D.str(D.mul(b, D.from(BigInt(mult)))) : instrument.tickSize; }, [base, mult, instrument.tickSize]);
  const v = useMemo(() => groupBook(book, step, rows), [book, step, rows]);
  const pdp = Math.min(dpOf(step), priceDp(instrument.tickSize, v.mid)), sdp = Math.min(dpOf(instrument.lotSize), 4);
  if (!book) return <BookSkeleton rows={rows} />;
  return (
    <div data-testid="book">
      <div className="mb-2 flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-[0.78125rem] text-mute">{t('fxGrouping')}
          <select aria-label={t('fxGrouping')} value={mult} onChange={(e) => setMult(Number(e.target.value))} className="min-h-11 rounded-xl border border-line bg-elev/60 px-2.5 text-[0.875rem] font-medium text-ink">
            {MULTS.map((m) => { const b = dec(base); return <option key={m} value={m}>{b ? fmt(D.mul(b, D.from(BigInt(m))), { locale, trim: true }) : m}</option>; })}</select></label>
        <span className="text-right text-[0.71875rem] leading-tight text-mute">{t('fxBookAge', { time: timeOf(book.ts, locale) })}</span>
      </div>
      <div className={`${GRID} border-b border-line pb-1.5 text-[0.6875rem] text-mute`}><span>{t('fxPrice')} ({instrument.quote})</span><span className="text-right">{t('fxSize')} ({instrument.base})</span><span className="text-right">{t('fxCumul')}</span></div>
      <div role="group" aria-label={t('fxAsks')} className="pt-1">
        <div className="px-2 pb-0.5 text-[0.65625rem] font-semibold uppercase tracking-[0.06em] text-danger">▼ {t('fxAsks')}</div>
        {[...v.asks].reverse().map((r) => <Level key={r.price} r={r} side="ask" pdp={pdp} sdp={sdp} locale={locale} />)}
      </div>
      <div className="my-1.5 flex items-center justify-between gap-3 rounded-lg bg-elev px-2.5 py-2 text-[0.78125rem] leading-none" data-testid="spread">
        <span className="text-mute">{t('fxSpread')}</span>
        <span className="font-semibold">{v.spread ? `${fmt(v.spread, { locale, trim: true })} · ${fmt(v.spreadBps, { dp: 2, locale })} ${t('fxBps')}` : '—'}</span>
      </div>
      <div role="group" aria-label={t('fxBids')}>
        {v.bids.map((r) => <Level key={r.price} r={r} side="bid" pdp={pdp} sdp={sdp} locale={locale} />)}
        <div className="px-2 pt-1 text-[0.65625rem] font-semibold uppercase tracking-[0.06em] text-emerald">▲ {t('fxBids')}</div>
      </div>
    </div>
  );
}

export function TradesPanel({ store, instrument, rows }: { store: MarketStore; instrument: Instrument; rows: number }) {
  const t = useT(); const { locale } = useContext(I18n);
  const trades = useSlice(store, 'trades');
  const pdp = priceDp(instrument.tickSize, trades[0]?.price), sdp = Math.min(dpOf(instrument.lotSize), 5);
  if (!trades.length) return <Empty icon="swap" title={t('fxNoTrades')} />;
  return <div data-testid="trades">
    <div className="grid grid-cols-[auto_1fr_1fr] gap-3 border-b border-line px-2 pb-1.5 text-[0.6875rem] text-mute"><span className="w-[58px]">{t('fxTime')}</span><span className="text-right">{t('fxPrice')}</span><span className="text-right">{t('fxSize')}</span></div>
    <div className="pt-1">{trades.slice(0, rows).map((x) => <div key={x.id} className="grid h-[23px] grid-cols-[auto_1fr_1fr] items-center gap-3 px-2 text-[0.78125rem] leading-none">
      <span className="w-[58px] text-mute">{timeOf(x.ts, locale)}</span>
      <span className={`text-right font-semibold ${x.side === 'buy' ? 'text-emerald' : 'text-danger'}`}><span aria-hidden="true">{x.side === 'buy' ? '▲ ' : '▼ '}</span><span className="sr-only">{t(x.side === 'buy' ? 'fxSide_buy' : 'fxSide_sell')} </span>{fmt(x.price, { dp: pdp, locale })}</span>
      <span className="text-right">{fmt(x.size, { dp: sdp, locale })}</span></div>)}</div>
  </div>;
}

/** GMX: what the venue has instead of a book */
export function LiquidityPanel({ store }: { store: MarketStore }) {
  const t = useT(); const { locale } = useContext(I18n);
  const { liquidity: l } = useSlice(store, 'meta');
  const rate = (x: string | undefined) => (x === undefined ? '—' : `${pct(x, 5, locale, true)} / h`);
  const two = (a: string | undefined, b: string | undefined, f: (x: string | undefined) => string) => <span className="block whitespace-nowrap"><span className="block"><span className="font-normal text-mute">{t('fxSide_long')}</span> {f(a)}</span><span className="block"><span className="font-normal text-mute">{t('fxSide_short')}</span> {f(b)}</span></span>;
  const money = (x: string | undefined) => (x === undefined ? '—' : compactUsd(x, locale));
  const group = 'divide-y divide-line/70';
  return (
    <div className="space-y-4" data-testid="gmx-liquidity">
      <Notice tone="info">{t('fxGmxNoBook')}</Notice>
      {!l ? <Empty icon="bars" title={t('fxGmxNoLiquidity')} /> : <>
        <div><h4 className="t-eyebrow mb-1">{t('fxGmxLiquidity')}</h4><div className={group}>
          <Row label={t('fxOpenInterest')}>{two(l.openInterestLongUsd, l.openInterestShortUsd, money)}</Row>
          <Row label={t('fxGmxAvailable')}>{two(l.availableLiquidityLongUsd, l.availableLiquidityShortUsd, money)}</Row>
          <Row label={t('fxGmxCapacity')}>{two(l.capacityLongUsd, l.capacityShortUsd, money)}</Row>
          {l.oracleMin && l.oracleMax && <Row label={t('fxGmxOracle')}><span className="whitespace-nowrap">{fmt(l.oracleMin, { dp: 2, locale })} – {fmt(l.oracleMax, { dp: 2, locale })}</span></Row>}</div></div>
        <div><h4 className="t-eyebrow mb-1">{t('fxGmxRates')}</h4><div className={group}>
          <Row label={t('fxFunding')}>{two(l.fundingRateLongPerHour, l.fundingRateShortPerHour, rate)}</Row>
          <Row label={t('fxGmxBorrow')}>{two(l.borrowingRateLongPerHour, l.borrowingRateShortPerHour, rate)}</Row>
          <Row label={t('fxGmxNet')}>{two(l.netRateLongPerHour, l.netRateShortPerHour, rate)}</Row></div>
          <p className="mt-1.5 text-[0.75rem] leading-snug text-mute">{t('fxGmxRateSign')}</p></div>
        <div><h4 className="t-eyebrow mb-1">{t('fxGmxImpact')}</h4><div className={group}>
          {l.positionFeeFactor && <Row label={t('fxGmxPositionFee')}>{pct(l.positionFeeFactor.balanceImproved, 3, locale)} / {pct(l.positionFeeFactor.balanceNotImproved, 3, locale)}</Row>}
          {l.priceImpact && <Row label={t('fxGmxImpactCap')}>{pct(l.priceImpact.maxFactorPositive, 2, locale, true)} / {l.priceImpact.maxFactorNegative ? `−${pct(l.priceImpact.maxFactorNegative, 2, locale)}` : '—'}</Row>}</div>
          <p className="mt-1.5 text-[0.75rem] leading-snug text-mute">{t('fxGmxImpactNote')}</p></div>
      </>}
    </div>
  );
}
