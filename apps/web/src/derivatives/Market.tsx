/**
 * Market header (price, 24 h change, volume, funding per hour and per the venue's own interval, open interest, freshness) and
 * the market picker (search, venue filter, favourites kept in localStorage). Only these small components listen to the ticker.
 * v10: the mark price is the hero numeral of the terminal; the stream's state is an icon and a word; the picker is the shared
 * bottom sheet. Nothing here animates on a tick: a new price is a text change, nothing else.
 */
import { useQuery } from '@tanstack/react-query';
import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { I18n, useT } from '../i18n';
import { Change, Coin, Icon, inputCls, Notice, Sheet, VenueIcon } from '../ui';
import { dapi } from './api';
import { ageText, Empty, Seg, Stat, useLocalState, VENUE_NAME } from './bits';
import { compactUsd, D, dec, fmt, fundingPerHour, pct, priceDp } from './dec';
import { useFreshness, useSlice, type Fresh, type MarketStore } from './store';
import type { Instrument, Ticker, VenueId } from './types';

const FRESH_TONE: Record<Fresh, string> = { live: 'ok', reconnecting: 'info', stale: 'warn', connecting: 'mute' };
/** live / reconnecting / stale, always an icon and words, with the age of the data when it is not live */
export function FreshPill({ store }: { store: MarketStore }) {
  const t = useT(); const f = useFreshness(store);
  const text = f.state === 'live' ? t('fxLiveData') : f.state === 'connecting' ? t('fxConnecting') : `${t(f.state === 'stale' ? 'fxStale' : 'fxReconnecting')}${f.ageMs !== null ? ` · ${t('fxAgo', { age: ageText(f.ageMs) })}` : ''}`;
  return <span role="status" data-testid="freshness" data-state={f.state} data-tone={FRESH_TONE[f.state]} title={f.state === 'reconnecting' ? t('dzFxReconnect') : undefined} className="tag shrink-0">
    {f.state === 'live' ? <span className="pulse-dot mx-[3px] h-1.5 w-1.5 rounded-full bg-emerald" aria-hidden="true" /> : <Icon n={f.state === 'reconnecting' ? 'spin' : f.state === 'stale' ? 'cloudOff' : 'clock'} className="h-3 w-3" />}{text}</span>;
}
/** a line across the terminal while the data is not current */
export function StaleBanner({ store }: { store: MarketStore }) {
  const t = useT(); const f = useFreshness(store);
  if (f.state !== 'stale') return null;
  return <div data-testid="stale-banner"><Notice tone="warn"><b className="block font-semibold">{t('dzFxStaleTitle')}</b>{t('fxStaleBanner', { age: ageText(f.ageMs) })}</Notice></div>;
}
/** greys its content while the data is stale (the banner and the pill say why); only dims it a little while the stream reconnects */
export function Veil({ store, children, className = '' }: { store: MarketStore; children: ReactNode; className?: string }) {
  const f = useFreshness(store);
  return <div className={`${className} ${f.state === 'stale' ? 'opacity-50 grayscale' : f.state === 'reconnecting' ? 'opacity-80' : ''}`} data-stale={f.state === 'stale' || undefined}>{children}</div>;
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
    <span className="font-normal text-mute"> · {sign > 0 ? t('fxLongsPay') : sign < 0 ? t('fxShortsPay') : t('fxNobodyPays')}</span>
    <span className="block text-[11.5px] font-normal leading-snug text-mute">{continuous ? t('fxFundingContinuous')
      : <>{inst.fundingIntervalSec !== 3600 ? `${pct(ticker.funding, 5, locale, true)} / ${intervalText(inst.fundingIntervalSec)} · ` : ''}{t('fxFundingEvery', { interval: intervalText(inst.fundingIntervalSec) })} · {t('fxFundingNext', { time: hms(ms - (now % ms)) })}</>}</span>
  </span>;
}

/** the asset's logo with the venue's logo as its badge: which contract, where */
function MarketLogo({ instrument, size }: { instrument: Instrument | null; size: number }) {
  if (!instrument) return <span className="skel shrink-0 !rounded-full" style={{ width: size, height: size }} aria-hidden="true" />;
  return <span className="relative shrink-0" style={{ width: size, height: size }}><Coin sym={instrument.base} size={size} /><VenueIcon venue={instrument.venue} size={Math.round(size * 0.44)} className="logo-badge" /></span>;
}

export function MarketHeader({ store, instrument, onPick, compact }: { store: MarketStore; instrument: Instrument | null; onPick: () => void; compact: boolean }) {
  const t = useT(); const { locale } = useContext(I18n);
  const ticker = useSlice(store, 'ticker'); const fresh = useFreshness(store);
  const stale = fresh.state === 'stale';
  const pdp = priceDp(instrument?.tickSize, ticker?.mark), change = dec(ticker?.change24h);
  const oi = dec(ticker?.openInterest), mark = dec(ticker?.mark);
  const picker = <button type="button" onClick={onPick} aria-haspopup="dialog" aria-label={t('fxPickMarket')} data-testid="market-picker" className="press row-press -ml-1.5 flex min-h-12 min-w-0 items-center gap-2.5 rounded-2xl py-1 pl-1.5 pr-2 text-left">
    <MarketLogo instrument={instrument} size={compact ? 38 : 44} />
    <span className="min-w-0"><span className={`flex items-center gap-1 font-semibold leading-tight tracking-[-0.015em] ${compact ? 'text-[16.5px]' : 'text-[19px]'}`}><span className="truncate">{instrument ? `${instrument.base}-${instrument.quote}` : '…'}</span><Icon n="chev" className="h-4 w-4 shrink-0 rotate-90 text-mute" /></span>
      <span className="mt-0.5 block truncate text-[12px] leading-tight text-mute">{instrument ? `${VENUE_NAME[instrument.venue]}${instrument.symbol !== instrument.base ? ` · ${instrument.symbol}` : ''} · ` : ''}{t('fxPerp')}</span></span></button>;
  const price = <div className={`min-w-0 ${compact ? 'text-right' : ''} ${stale ? 'opacity-50 grayscale' : ''}`}>
    <div className={`t-num truncate ${compact ? 'text-[26px]' : 'text-[34px]'}`} data-testid="mark-price" aria-label={t('fxMarkPrice')}>{ticker ? fmt(ticker.mark, { dp: pdp, locale }) : '—'}</div>
    <div className={`mt-1 flex items-center gap-2 ${compact ? 'justify-end' : ''}`}>{change ? <Change pct={D.toNumber(D.mul(change, D.from(100n)))} suffix=" 24 h" /> : <span className="text-[13px] text-mute">—</span>}</div></div>;
  if (compact) return <div data-testid="market-header">
    <div className="flex items-center justify-between gap-3">{picker}{price}</div>
    <div className="mt-1.5 flex items-center justify-between gap-2"><FreshPill store={store} />{instrument && <span className="truncate text-[11.5px] text-mute">{t('fxMarkLabel')}</span>}</div>
  </div>;
  const stats = ticker && instrument ? <>
    <Stat wrap label={t('fxIndex')}>{ticker.index ? fmt(ticker.index, { dp: pdp, locale }) : '—'}</Stat>
    <Stat wrap label={t('fxVolume24h')}>{ticker.volume24h ? compactUsd(ticker.volume24h, locale) : '—'}</Stat>
    <Stat wrap label={t('fxOpenInterest')}>{oi ? <>{fmt(oi, { dp: oi.s > 2 ? 2 : oi.s, locale })} {instrument.base}{mark ? <span className="font-normal text-mute"> ≈ {compactUsd(D.mul(oi, mark), locale)}</span> : null}</> : '—'}</Stat>
    <Stat wrap label={t('fxFundingLabel')}><Funding ticker={ticker} inst={instrument} /></Stat>
  </> : <>{[72, 64, 110, 150].map((w) => <div key={w} aria-hidden="true"><div className="skel h-3 w-12 !rounded-md" /><div className="skel mt-1.5 h-4 !rounded-md" style={{ width: w }} /></div>)}</>;
  return <div className="flex flex-wrap items-center gap-x-8 gap-y-3" data-testid="market-header">
    {picker}{price}
    <div className={`flex min-w-0 flex-1 flex-wrap items-start gap-x-8 gap-y-2 border-line lg:border-l lg:pl-8 ${stale ? 'opacity-50 grayscale' : ''}`}>{stats}</div>
    <FreshPill store={store} />
  </div>;
}
/** the same figures as a wrapping grid, for the phone layout (under the sticky header) */
export function MarketStats({ store, instrument }: { store: MarketStore; instrument: Instrument | null }) {
  const t = useT(); const { locale } = useContext(I18n);
  const ticker = useSlice(store, 'ticker'); const fresh = useFreshness(store);
  if (!ticker || !instrument) return <div className="grid grid-cols-3 gap-x-4 gap-y-3" aria-hidden="true">{[0, 1, 2].map((k) => <div key={k}><div className="skel h-3 w-12 !rounded-md" /><div className="skel mt-1.5 h-4 w-16 !rounded-md" /></div>)}<div className="skel col-span-3 h-9 !rounded-lg" /></div>;
  const pdp = priceDp(instrument.tickSize, ticker.mark), oi = dec(ticker.openInterest), mark = dec(ticker.mark);
  return <div className={`grid grid-cols-3 gap-x-4 gap-y-3 ${fresh.state === 'stale' ? 'opacity-50 grayscale' : ''}`} data-testid="market-stats">
    <Stat label={t('fxIndex')}>{ticker.index ? fmt(ticker.index, { dp: pdp, locale }) : '—'}</Stat>
    <Stat label={t('fxVolume24h')}>{ticker.volume24h ? compactUsd(ticker.volume24h, locale) : '—'}</Stat>
    <Stat label={t('fxOpenInterest')}>{oi && mark ? compactUsd(D.mul(oi, mark), locale) : '—'}</Stat>
    <div className="col-span-3 min-w-0 border-t border-line pt-3"><div className="text-[11.5px] leading-tight text-mute">{t('fxFundingLabel')}</div><div className="mt-0.5 text-[13.5px]"><Funding ticker={ticker} inst={instrument} /></div></div>
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
    <div className="min-h-[56dvh] space-y-3 lg:min-h-[420px]">
      <div className="relative"><Icon n="search" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-mute" />
        <input type="search" role="searchbox" aria-label={t('fxSearchMarket')} placeholder={t('fxSearchMarket')} className={`${inputCls} pl-10`} value={q} onChange={(e) => setQ(e.target.value)} autoCapitalize="off" autoCorrect="off" /></div>
      <Seg size="sm" label={t('fxVenueFilter')} value={venue} onChange={setVenue} options={[{ id: 'all', label: t('fxAll') }, { id: 'fav', label: `★ ${t('fxFavs')}` }, ...venues.map((v) => ({ id: v, label: <span className="inline-flex items-center gap-1.5"><VenueIcon venue={v} size={16} />{VENUE_NAME[v] ?? v}</span>, aria: VENUE_NAME[v] ?? v }))]} />
      {instruments.length === 0 ? <div className="space-y-1" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map((k) => <div key={k} className="flex items-center gap-3 px-1 py-2.5"><div className="skel h-9 w-9 !rounded-full" /><div className="flex-1 space-y-2"><div className="skel h-3.5 w-24 !rounded-md" /><div className="skel h-3 w-16 !rounded-md" /></div><div className="skel h-3.5 w-16 !rounded-md" /></div>)}</div>
        : rows.length === 0 ? <Empty icon={venue === 'fav' && !q ? 'star' : 'search'} title={venue === 'fav' && !q ? t('fxNoFavs') : t('fxNoMarket')} /> :
        <ul className="-mx-2 divide-y divide-line/70" data-testid="market-list">{rows.map((i) => { const x = byId.get(i.id), fav = favs.includes(i.id), ch = dec(x?.change24h); return <li key={i.id} className={`flex items-center gap-0.5 rounded-2xl px-1 ${i.id === current ? 'bg-elev' : ''}`}>
          <button type="button" aria-pressed={fav} aria-label={t(fav ? 'fxUnfav' : 'fxFav', { symbol: `${i.symbol} ${VENUE_NAME[i.venue]}` })} onClick={() => setFavs(fav ? favs.filter((f) => f !== i.id) : [...favs, i.id])}
            className={`press grid h-11 w-11 shrink-0 place-items-center rounded-full ${fav ? 'text-warn' : 'text-mute/70'}`}><svg viewBox="0 0 24 24" className="h-5 w-5" fill={fav ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.2-4.1 5.8-.8z" /></svg></button>
          <button type="button" onClick={() => onPick(i.id)} aria-current={i.id === current ? 'true' : undefined} className="row-press flex min-h-[60px] min-w-0 flex-1 items-center gap-3 rounded-2xl px-1.5 py-2 text-left">
            <MarketLogo instrument={i} size={38} />
            <span className="min-w-0 flex-1"><span className="block truncate text-[15px] font-semibold leading-tight">{i.base}-{i.quote}{i.symbol !== i.base && i.venue === 'gmx' ? <span className="font-normal text-mute"> {i.symbol.replace(/^[^[]*/, '')}</span> : null}</span>
              <span className="mt-1 flex items-center gap-2 text-[12.5px] leading-tight text-mute"><span className="truncate">{VENUE_NAME[i.venue]}</span>{i.status !== 'active' && <span className="shrink-0 font-medium text-warn">{t(i.status === 'halted' ? 'fxHaltedShort' : 'fxReduceOnly')}</span>}</span></span>
            <span className="shrink-0 text-right"><span className="block text-[14.5px] font-semibold">{x ? fmt(x.mark, { dp: priceDp(i.tickSize, x.mark), locale }) : '—'}</span>
              {ch ? <Change pct={D.toNumber(D.mul(ch, D.from(100n)))} /> : <span className="text-[12.5px] text-mute">—</span>}</span>
          </button></li>; })}</ul>}
    </div>
  </Sheet>;
}
