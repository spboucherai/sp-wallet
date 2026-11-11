import { useQuery } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { get } from '../api';
import type { Nav } from '../App';
import { PriceChart, type Pt } from '../chart';
import { useNetworks, usePortfolio, useSettings } from '../hooks';
import { I18n, useT } from '../i18n';
import { Addr, Card, Change, Coin, CopyBtn, fiat, H, Icon, Money, NetDot, Notice, numFmt, Seg, Skeleton, SkeletonRows, StatePill, trimAmt, when } from '../ui';
import { issuerOf } from '../issuer';

const RANGES = [['1', '1J', '1D'], ['7', '1S', '1W'], ['30', '1M', '1M'], ['365', '1A', '1Y']] as const;
const compact = (n: number | null, cur: string, locale: string) => (n === null ? '—' : new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { style: 'currency', currency: cur, notation: 'compact', maximumFractionDigits: 2 }).format(n));

export function Asset({ network, asset, nav }: { network: string; asset: string; nav: Nav }) {
  const t = useT(); const { locale } = useContext(I18n); const { settings } = useSettings();
  const pf = usePortfolio(), nets = useNetworks();
  const [days, setDays] = useState<'1' | '7' | '30' | '365'>('7'), [hover, setHover] = useState<Pt | null>(null);
  const cur = settings.currency, ck = cur === 'USD' ? 'usd' : 'cad';
  const b = pf.data?.balances.find((x) => x.network === network && x.asset === asset);
  const mk = useQuery({ queryKey: ['market', b?.symbol, days, ck], enabled: !!b, staleTime: 120_000,
    queryFn: () => get<{ points: Pt[]; market: any }>(`/market/${encodeURIComponent(b!.symbol)}?days=${days}&currency=${ck}`) });
  const act = useQuery({ queryKey: ['activity'], queryFn: () => get<{ items: any[] }>('/activity?limit=200'), staleTime: 15_000 });
  if (!b || !pf.data) return <div className="space-y-5" aria-busy="true"><Skeleton h="h-12" className="!w-56 !rounded-xl" /><Skeleton h="h-[420px]" /><Skeleton h="h-40" /><SkeletonRows n={3} /></div>;
  const n = nets.data?.find((x) => x.id === network);
  const m = pf.data.prices?.[b.symbol] ?? mk.data?.market ?? null;
  const price: number | null = m ? m[ck] : null;
  const pts = mk.data?.points ?? [];
  const shown = hover?.p ?? (pts.length ? pts[pts.length - 1]!.p : price);
  const base = pts.length ? pts[0]!.p : null;
  const delta = shown !== null && base ? ((shown - base) / base) * 100 : null;
  const money = (v: number) => fiat(v, cur, locale);
  const priceFmt = (v: number) => new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { style: 'currency', currency: cur, maximumFractionDigits: v < 1 ? 6 : 2 }).format(v);
  const timeFmt = (ts: number) => new Date(ts).toLocaleString(locale === 'fr' ? 'fr-CA' : 'en-CA', days === '1' ? { hour: '2-digit', minute: '2-digit' } : days === '365' ? { month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
  const hidden = settings.hideBalances;
  const value = b.display !== null && price !== null ? Number(b.display) * price : null;
  const others = pf.data.balances.filter((x) => x.symbol === b.symbol && !(x.network === network && x.asset === asset));
  const mine = (act.data?.items ?? []).filter((i) => i.network === network && i.asset === asset).slice(0, 6);
  const iss = asset === 'native' ? null : issuerOf(t, b.symbol, b.name);
  const sgn = (v: number) => `${v > -0.005 ? '+' : '−'}${numFmt(Math.abs(v), locale, 2, 2)} %`;
  const stat = (k: string, v: string) => <div className="rounded-2xl bg-elev/60 p-3.5"><div className="text-[12px] text-mute">{k}</div><div className="mt-0.5 text-[15px] font-semibold">{v}</div></div>;
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2.5 pt-2">
        <button onClick={() => nav({ tab: 'home' })} aria-label={t('back')} className="press -ml-2.5 grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink"><Icon n="chev" className="h-6 w-6 rotate-180" /></button>
        <Coin sym={b.symbol} net={b.network} size={48} />
        <div className="min-w-0"><h1 className="truncate text-[21px] font-semibold leading-tight tracking-[-0.02em]">{b.name}</h1><div className="mt-0.5 flex items-center gap-1.5 text-[13px] text-mute"><span>{b.symbol}</span><span aria-hidden="true">·</span><NetDot net={b.network} size={15} /><span className="truncate">{b.networkName}</span></div></div>
      </div>

      {iss && <div data-testid="asset-issuer"><Notice tone="warn">{t('qaPegNote', { name: b.name, sym: b.symbol, issuer: iss.text })}</Notice></div>}
      <Card className="!pb-4">
        <div className="text-[13px] text-mute">{hover ? timeFmt(hover.t) : t('price')}</div>
        <div className="t-display mt-1.5 text-[clamp(34px,10.5vw,44px)]">{shown !== null && shown !== undefined ? priceFmt(shown) : '—'}</div>
        <div className="mt-2 h-5">{delta !== null && <Change pct={delta} suffix={t(`r_${days}` as never)} />}</div>
        <div className="mt-3">{mk.isLoading ? <div className="skel h-[210px] !rounded-2xl" /> : <PriceChart points={pts} format={priceFmt} formatTime={timeFmt} onHover={setHover} />}</div>
        <div className="mt-4"><Seg label={t('range')} value={days} onChange={(d) => { setDays(d); setHover(null); }} options={RANGES.map(([d, fr, en]) => [d, locale === 'fr' ? fr : en] as const)} /></div>
        {!pf.data.prices && <p className="mt-3 text-[12.5px] text-mute">{t('noPrices')}</p>}
      </Card>

      <Card>
        <div className="flex items-end justify-between gap-3">
          <div><div className="text-[13px] text-mute">{t('yourBalance')}</div>
            <div className="mt-1 text-[28px] font-semibold leading-tight tracking-[-0.025em]"><Money hidden={hidden}>{b.display === null ? '—' : trimAmt(b.display, 8)} <span className="text-mute">{b.symbol}</span></Money></div>
            {value !== null && <div className="text-[14px] text-mute"><Money hidden={hidden}>{money(value)}</Money></div>}</div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <button onClick={() => nav({ tab: 'receive', network })} className="press inline-flex min-h-[50px] items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-[15.5px] font-semibold text-onprimary"><Icon n="down" className="h-[18px] w-[18px]" />{t('receive')}</button>
          <button onClick={() => nav({ tab: 'send', network, asset })} disabled={pf.data.halted} className="press inline-flex min-h-[50px] items-center justify-center gap-2 rounded-2xl bg-elev px-4 text-[15.5px] font-semibold disabled:opacity-40"><Icon n="up" className="h-[18px] w-[18px]" />{t('send')}</button>
        </div>
      </Card>

      {others.length > 0 && <Card className="!px-0 !pb-1"><div className="px-5"><H>{t('otherNetworks', { sym: b.symbol })}</H></div>
        <ul>{others.map((o, k) => <li key={o.network + o.asset}><button onClick={() => nav({ tab: 'asset', network: o.network, asset: o.asset })} className={`row-press flex min-h-[60px] w-full items-center gap-3 px-5 py-2.5 text-left ${k ? 'border-t border-line' : ''}`}>
          <Coin sym={o.symbol} net={o.network} size={36} /><span className="min-w-0 flex-1"><span className="block truncate text-[15px] font-medium leading-tight">{o.networkName}</span>{o.name !== b.name && <span className="mt-0.5 block truncate text-[12px] text-mute">{o.name}</span>}</span>
          <span className={`text-[15px] font-semibold ${o.amount === '0' ? 'text-mute' : ''}`}><Money hidden={hidden}>{o.display === null ? '—' : trimAmt(o.display)}</Money></span><Icon n="chev" className="h-4 w-4 text-mute" /></button></li>)}</ul></Card>}

      {m && <Card><H>{t('marketData')}</H>
        <div className="grid grid-cols-2 gap-3">
          {stat(t('change24h'), m.change24h === null ? '—' : sgn(m.change24h))}
          {stat(t('change7d'), m.change7d === null ? '—' : sgn(m.change7d))}
          {stat(t('marketCap'), compact(m.marketCap, 'USD', locale))}
          {stat(t('volume24h'), compact(m.volume24h, 'USD', locale))}
          {stat(t('range24h'), m.low24h === null || m.high24h === null ? '—' : `${fiat(m.low24h, 'USD', locale)} – ${fiat(m.high24h, 'USD', locale)}`)}
          {stat(t('rank'), m.rank ? `#${m.rank}` : '—')}
        </div>
        <p className="mt-3 text-[12px] text-mute">{t('marketSource')}</p></Card>}

      <Card><H>{t('assetDetails')}</H>
        <dl className="space-y-3 text-[14px]">
          <div className="flex justify-between gap-4"><dt className="text-mute">{t('network')}</dt><dd className="flex items-center gap-2 font-medium"><NetDot net={b.network} size={20} />{b.networkName}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-mute">{t('decimals')}</dt><dd className="font-medium">{b.decimals}</dd></div>
          <div><dt className="text-mute">{asset === 'native' ? t('nativeCoin') : t('contract')}</dt>
            {asset !== 'native' && <dd className="mt-1"><Addr value={asset} /><div className="mt-2 flex gap-2"><CopyBtn text={asset} />{n && <a href={n.explorerAddr + asset} target="_blank" rel="noreferrer noopener" className="press inline-flex min-h-[50px] items-center gap-2 rounded-2xl border border-line px-4 text-[15px] font-medium"><Icon n="ext" className="h-4 w-4" />{t('explorer')}</a>}</div></dd>}</div>
        </dl>
        {asset !== 'native' && <p className="mt-3 text-[12px] text-mute">{t('verifiedToken')}</p>}</Card>

      <Card className="!px-0 !pb-1"><div className="px-5"><H right={<button className="-my-2 min-h-11 min-w-11 text-[13.5px] font-medium text-blue" onClick={() => nav({ tab: 'activity' })}>{t('all')}</button>}>{t('activity')}</H></div>
        {mine.length === 0 ? <p className="px-5 pb-4 text-[14px] text-mute">{t('noActivity')}</p> :
          <ul>{mine.map((i, k) => <li key={i.id} className={`flex items-center gap-3 px-5 py-3 ${k ? 'border-t border-line' : ''}`}>
            <span className={`grid h-9 w-9 place-items-center rounded-full ${i.kind === 'receive' ? 'bg-emerald/10 text-emerald' : 'bg-blue/10 text-blue'}`}><Icon n={i.kind === 'receive' ? 'down' : 'up'} className="h-4 w-4" /></span>
            <span className="min-w-0 flex-1"><span className="block text-[14.5px] font-medium">{i.kind === 'receive' ? t('received') : t('sent')}</span><span className="block text-[12px] text-mute">{when(i.at, locale)}</span></span>
            <span className="text-right"><span className="block text-[14.5px] font-semibold"><Money hidden={hidden}>{i.kind === 'receive' ? '+' : '−'}{trimAmt(i.amountDisplay)}</Money></span><StatePill state={i.state} /></span></li>)}</ul>}</Card>
    </div>
  );
}
