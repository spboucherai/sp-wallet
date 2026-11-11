/**
 * Market header (price, 24 h change, volume, funding per hour and per the venue's own interval, open interest, freshness) and
 * the market picker (search, venue filter, favourites kept in localStorage). Only these small components listen to the ticker.
 */
import { useQuery } from '@tanstack/react-query';
import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { I18n, useT } from '../i18n';
import { Change, Coin, Icon, inputCls, Notice } from '../ui';
import { dapi } from './api';
import { ageText, Seg, Sheet, Stat, useLocalState, VENUE_NAME, VenueBadge } from './bits';
import { compactUsd, D, dec, fmt, fundingPerHour, pct, priceDp } from './dec';
import { useFreshness, useSlice, type Fresh, type MarketStore } from './store';
import type { Instrument, Ticker, VenueId } from './types';

const DOT: Record<Fresh, string> = { live: 'bg-emerald pulse-dot', reconnecting: 'bg-warn', stale: 'bg-mute', connecting: 'bg-mute' };
/** live / reconnecting / stale, always in words, with the age of the data when it is not live */
export function FreshPill({ store }: { store: MarketStore }) {
  const t = useT(); const f = useFreshness(store);
  const text = f.state === 'live' ? t('fxLiveData') : f.state === 'connecting' ? t('fxConnecting') : `${t(f.state === 'stale' ? 'fxStale' : 'fxReconnecting')}${f.ageMs !== null ? ` · ${t('fxAgo', { age: ageText(f.ageMs) })}` : ''}`;
  return <span role="status" data-testid="freshness" data-state={f.state} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${f.state === 'live' ? 'bg-emerald/10 text-emerald' : f.state === 'reconnecting' ? 'bg-warn/12 text-warn' : 'bg-elev text-mute'}`}>
    {f.state === 'reconnecting' ? <Icon n="spin" className="h-3 w-3" /> : <span className={`h-1.5 w-1.5 rounded-full ${DOT[f.state]}`} aria-hidden="true" />}{text}</span>;
}
/** a line across the terminal while the data is not current */
export function StaleBanner({ store }: { store: MarketStore }) {
  const t = useT(); const f = useFreshness(store);
  if (f.state !== 'stale') return null;
  return <div data-testid="stale-banner"><Notice tone="warn">{t('fxStaleBanner', { age: ageText(f.ageMs) })}</Notice></div>;
}
/** greys its content while the data is stale (the banner and the pill say why) */
export function Veil({ store, children, className = '' }: { store: MarketStore; children: ReactNode; className?: string }) {
  const f = useFreshness(store);
  return <div className={`${className} ${f.state === 'stale' ? 'opacity-50 grayscale' : ''}`} data-stale={f.state === 'stale' || undefined}>{children}</div>;
}

function useNow(ms: number): number { const [n, setN] = useState(() => Date.now()); useEffect(() => { const h = setInterval(() => setN(Date.now()), ms); return () => clearInterval(h); }, [ms]); return n; }
const hms = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60; return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(ss).padStart(2, '0')}`; };
const intervalText = (sec: number) => (sec % 3600 === 0 ? `${sec / 3600} h` : `${Math.round(sec / 60)} min`);

function Funding({ ticker, inst }: { ticker: Ticker; inst: Instrument }) {
  const t = useT(); const { locale } = useContext(I18n); const now = useNow(1000);
  const perHour = fundingPerHour(ticker.funding, inst.fundingIntervalSec);
  if (!perHour) return <>—</>;
  const ms = inst.fundingIntervalSec * 1000, continuous = inst.venue === 'gmx', sign = D.sign(perHour);
  return <span title={t('fxFundingTitle')}>
    <span className="font-semibold">{pct(perHour, 5, locale, true)} / h</span>
    <span className="text-mute"> · {sign > 0 ? t('fxLongsPay') : sign < 0 ? t('fxShortsPay') : t('fxNobodyPays')}</span>
    <span className="block text-[11.5px] font-normal text-mute">{continuous ? t('fxFundingContinuous')
      : <>{inst.fundingIntervalSec !== 3600 ? `${pct(ticker.funding, 5, locale, true)} / ${intervalText(inst.fundingIntervalSec)} · ` : ''}{t('fxFundingEvery', { interval: intervalText(inst.fundingIntervalSec) })} · {t('fxFundingNext', { time: hms(ms - (now % ms)) })}</>}</span>
  </span>;
}

export function MarketHeader({ store, instrument, onPick, compact }: { store: MarketStore; instrument: Instrument | null; onPick: () => void; compact: boolean }) {
  const t = useT(); const { locale } = useContext(I18n);
  const ticker = useSlice(store, 'ticker'); const fresh = useFreshness(store);
  const stale = fresh.state === 'stale';
  const pdp = priceDp(instrument?.tickSize, ticker?.mark), change = dec(ticker?.change24h);
  const oi = dec(ticker?.openInterest), mark = dec(ticker?.mark);
  const picker = <button type="button" onClick={onPick} aria-haspopup="dialog" aria-label={t('fxPickMarket')} data-testid="market-picker" className="flex min-h-12 min-w-0 items-center gap-2.5 rounded-2xl border border-line bg-surface py-1.5 pl-2 pr-3 text-left transition hover:bg-elev">
    <Coin sym={instrument?.base ?? '…'} size={32} />
    <span className="min-w-0"><span className="block truncate text-[15.5px] font-semibold leading-tight">{instrument ? `${instrument.base}-${instrument.quote}` : '…'} <span className="font-normal text-mute">{t('fxPerp')}</span></span>
      <span className="block truncate text-[11.5px] leading-tight text-mute">{instrument ? `${VENUE_NAME[instrument.venue]}${instrument.symbol !== instrument.base ? ` · ${instrument.symbol}` : ''}` : ''}</span></span>
    <Icon n="chev" className="h-4 w-4 shrink-0 rotate-90 text-mute" /></button>;
  const price = <div className={`min-w-0 text-right ${stale ? 'opacity-50 grayscale' : ''}`}>
    <div className="truncate text-[22px] font-semibold leading-tight tracking-[-0.01em]" data-testid="mark-price" aria-label={t('fxMarkPrice')}>{ticker ? fmt(ticker.mark, { dp: pdp, locale }) : '—'}</div>
    <div className="flex items-center justify-end gap-2">{change ? <Change pct={D.toNumber(D.mul(change, D.from(100n)))} suffix=" 24 h" /> : <span className="text-[13px] text-mute">—</span>}</div></div>;
  const stats = ticker && instrument && <>
    <Stat wrap label={t('fxIndex')}>{ticker.index ? fmt(ticker.index, { dp: pdp, locale }) : '—'}</Stat>
    <Stat wrap label={t('fxVolume24h')}>{ticker.volume24h ? compactUsd(ticker.volume24h, locale) : '—'}</Stat>
    <Stat wrap label={t('fxOpenInterest')}>{oi ? <>{fmt(oi, { dp: oi.s > 2 ? 2 : oi.s, locale })} {instrument.base}{mark ? <span className="text-mute"> ≈ {compactUsd(D.mul(oi, mark), locale)}</span> : null}</> : '—'}</Stat>
    <Stat wrap label={t('fxFundingLabel')}><Funding ticker={ticker} inst={instrument} /></Stat>
  </>;
  if (compact) return <div data-testid="market-header">
    <div className="flex items-center justify-between gap-3">{picker}{price}</div>
    <div className="mt-2 flex items-center gap-2"><FreshPill store={store} />{instrument && <span className="truncate text-[11.5px] text-mute">{t('fxMarkLabel')}</span>}</div>
  </div>;
  return <div className="flex flex-wrap items-center gap-x-6 gap-y-3" data-testid="market-header">
    {picker}{price}
    <div className={`flex min-w-0 flex-1 flex-wrap items-start gap-x-7 gap-y-2 ${stale ? 'opacity-50 grayscale' : ''}`}>{stats}</div>
    <FreshPill store={store} />
  </div>;
}
/** the same figures as a wrapping grid, for the phone layout (under the sticky header) */
export function MarketStats({ store, instrument }: { store: MarketStore; instrument: Instrument | null }) {
  const t = useT(); const { locale } = useContext(I18n);
  const ticker = useSlice(store, 'ticker'); const fresh = useFreshness(store);
  if (!ticker || !instrument) return null;
  const pdp = priceDp(instrument.tickSize, ticker.mark), oi = dec(ticker.openInterest), mark = dec(ticker.mark);
  return <div className={`grid grid-cols-3 gap-x-4 gap-y-2 ${fresh.state === 'stale' ? 'opacity-50 grayscale' : ''}`} data-testid="market-stats">
    <Stat label={t('fxIndex')}>{ticker.index ? fmt(ticker.index, { dp: pdp, locale }) : '—'}</Stat>
    <Stat label={t('fxVolume24h')}>{ticker.volume24h ? compactUsd(ticker.volume24h, locale) : '—'}</Stat>
    <Stat label={t('fxOpenInterest')}>{oi && mark ? compactUsd(D.mul(oi, mark), locale) : '—'}</Stat>
    <div className="col-span-3 min-w-0"><div className="text-[11.5px] text-mute">{t('fxFundingLabel')}</div><div className="text-[13.5px]"><Funding ticker={ticker} inst={instrument} /></div></div>
  </div>;
}

export function MarketPicker({ instruments, current, onPick, onClose }: { instruments: Instrument[]; current: string; onPick: (id: string) => void; onClose: () => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const [q, setQ] = useState(''), [venue, setVenue] = useState<VenueId | 'all' | 'fav'>('all');
  const [favs, setFavs] = useLocalState<string[]>('spw-fut-favs', []);
  const tk = useQuery({ queryKey: ['deriv', 'tickers'], queryFn: () => dapi.tickers(), refetchInterval: 8000 });
  const byId = useMemo(() => new Map((tk.data?.tickers ?? []).map((x) => [x.instrument, x])), [tk.data]);
  const venues = useMemo(() => [...new Set(instruments.map((i) => i.venue))], [instruments]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return instruments.filter((i) => (i.status !== 'halted' || i.id === current) && (venue === 'all' || (venue === 'fav' ? favs.includes(i.id) : i.venue === venue)) && (!s || i.symbol.toLowerCase().includes(s) || i.base.toLowerCase().includes(s) || VENUE_NAME[i.venue].toLowerCase().includes(s)))
      .sort((a, b) => Number(favs.includes(b.id)) - Number(favs.includes(a.id)) || Number(byId.get(b.id)?.volume24h ?? 0) - Number(byId.get(a.id)?.volume24h ?? 0) || a.symbol.localeCompare(b.symbol)).slice(0, 80);
  }, [instruments, q, venue, favs, byId, current]);
  return <Sheet wide title={t('fxPickMarket')} onClose={onClose}>
    <div className="space-y-3">
      <div className="relative"><Icon n="search" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-mute" />
        <input type="search" role="searchbox" aria-label={t('fxSearchMarket')} placeholder={t('fxSearchMarket')} className={`${inputCls} pl-10`} value={q} onChange={(e) => setQ(e.target.value)} autoCapitalize="off" autoCorrect="off" /></div>
      <Seg size="sm" label={t('fxVenueFilter')} value={venue} onChange={setVenue} options={[{ id: 'all', label: t('fxAll') }, { id: 'fav', label: `★ ${t('fxFavs')}` }, ...venues.map((v) => ({ id: v, label: VENUE_NAME[v] ?? v }))]} />
      {rows.length === 0 ? <p className="py-8 text-center text-[13.5px] text-mute">{venue === 'fav' && !q ? t('fxNoFavs') : t('fxNoMarket')}</p> :
        <ul className="-mx-2" data-testid="market-list">{rows.map((i) => { const x = byId.get(i.id), fav = favs.includes(i.id), ch = dec(x?.change24h); return <li key={i.id} className={`flex items-center gap-1 rounded-2xl px-1 ${i.id === current ? 'bg-elev' : ''}`}>
          <button type="button" aria-pressed={fav} aria-label={t(fav ? 'fxUnfav' : 'fxFav', { symbol: `${i.symbol} ${VENUE_NAME[i.venue]}` })} onClick={() => setFavs(fav ? favs.filter((f) => f !== i.id) : [...favs, i.id])}
            className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${fav ? 'text-warn' : 'text-mute'}`}><svg viewBox="0 0 24 24" className="h-5 w-5" fill={fav ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.2-4.1 5.8-.8z" /></svg></button>
          <button type="button" onClick={() => onPick(i.id)} aria-current={i.id === current ? 'true' : undefined} className="flex min-h-[56px] min-w-0 flex-1 items-center gap-3 rounded-2xl px-1.5 py-2 text-left">
            <Coin sym={i.base} size={34} />
            <span className="min-w-0 flex-1"><span className="block truncate text-[14.5px] font-semibold">{i.base}-{i.quote}{i.symbol !== i.base && i.venue === 'gmx' ? <span className="font-normal text-mute"> {i.symbol.replace(/^[^[]*/, '')}</span> : null}</span>
              <span className="mt-0.5 flex items-center gap-2"><VenueBadge venue={i.venue} />{i.status !== 'active' && <span className="text-[11.5px] text-warn">{t(i.status === 'halted' ? 'fxHaltedShort' : 'fxReduceOnly')}</span>}</span></span>
            <span className="shrink-0 text-right"><span className="block text-[14px] font-medium">{x ? fmt(x.mark, { dp: priceDp(i.tickSize, x.mark), locale }) : '—'}</span>
              {ch ? <Change pct={D.toNumber(D.mul(ch, D.from(100n)))} /> : <span className="text-[12.5px] text-mute">—</span>}</span>
          </button></li>; })}</ul>}
    </div>
  </Sheet>;
}
