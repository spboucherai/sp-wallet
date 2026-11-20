import { useQuery } from '@tanstack/react-query';
import { useContext, useEffect, useState } from 'react';
import { get } from '../api';
import type { Nav } from '../App';
import { PriceChart, type Pt } from '../chart';
import { sendBlock, sendBlockKey, useNetworks, usePortfolio, useSettings } from '../hooks';
import { backOr } from '../nav';
import { I18n, useT } from '../i18n';
import { Addr, Btn, Card, Change, Coin, CopyBtn, EmptyState, ErrorState, Fact, fiat, H, Icon, Money, NetDot, Notice, numFmt, Seg, Skeleton, SkeletonRows, StatTile, trimAmt } from '../ui';
import { issuerOf } from '../issuer';
import { PriceFreshness, StaleBanner } from '../freshness'; // v11; NEXT W4
import { fiatText, mulDecimal } from '../money';
import { LiveSpotTag, useLiveSpot } from '../quotes-spot'; // v11 live quotes (the quote client itself is fetched on demand)
import { prefKey, useAssetPrefs, useContacts } from '../wallet';
import { TransactionRow } from '../tx-row';
import { rowValue, useFallbackInterval } from '../wallet-ui';
import { foldInternal, itemsOfAsset, type WalletItem } from '../walletItems';

/** GET /activity returns at most this many rows; without a server-side asset filter, an empty result inside a FULL window is not « no activity » */
export const ACTIVITY_WINDOW = 500;
const RANGES = [['1', '1J', '1D'], ['7', '1S', '1W'], ['30', '1M', '1M'], ['365', '1A', '1Y']] as const;
const compact = (n: number | null, cur: string, locale: string) => (n === null ? '—' : new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { style: 'currency', currency: cur, notation: 'compact', maximumFractionDigits: 2 }).format(n));
/**
 * Was the answer filtered by the server? The `network` / `asset` filters of GET /activity belong to a branch not merged when this
 * was written, and a server without them ignores the parameters: the answer is then every movement. It is taken as filtered
 * only when it holds nothing else than this asset (pure: tested).
 */
export const serverFiltered = (items: readonly Pick<WalletItem, 'network' | 'asset'>[], network: string, asset: string): boolean => items.length > 0 && items.every((i) => i.network === network && i.asset === asset);

export function Asset({ network, asset, nav }: { network: string; asset: string; nav: Nav }) {
  const t = useT(); const { locale } = useContext(I18n); const { settings } = useSettings();
  const pf = usePortfolio(), nets = useNetworks(), prefs = useAssetPrefs(), contacts = useContacts();
  const [days, setDays] = useState<'1' | '7' | '30' | '365'>('7'), [hover, setHover] = useState<Pt | null>(null), [prefFailed, setPrefFailed] = useState(false);
  useEffect(() => { if (!prefFailed) return; const h = setTimeout(() => setPrefFailed(false), 6000); return () => clearTimeout(h); }, [prefFailed]);
  const cur = settings.currency, ck = cur === 'USD' ? 'usd' : 'cad';
  const b = pf.data?.balances.find((x) => x.network === network && x.asset === asset);
  const live = useLiveSpot(b ? [b.symbol] : [])[b?.symbol ?? ''];   // v11 live quotes: the streamed USD price of this symbol, when there is one
  const mk = useQuery({ queryKey: ['market', b?.symbol, days, ck], enabled: !!b, staleTime: 120_000,
    queryFn: () => get<{ points: Pt[]; market: any }>(`/market/${encodeURIComponent(b!.symbol)}?days=${days}&currency=${ck}`) });
  const actMs = useFallbackInterval(30_000, 180_000);
  const act = useQuery({ queryKey: ['activity', 'asset', network, asset], refetchInterval: actMs, staleTime: 15_000,
    queryFn: () => get<{ items: WalletItem[] }>(`/activity?limit=${ACTIVITY_WINDOW}&network=${encodeURIComponent(network)}&asset=${encodeURIComponent(asset)}`) });
  // NEXT W5: « back » returns where the owner came from (the asset list, Home, another asset); on a page opened directly, Home
  const back = () => backOr(() => nav({ tab: 'home' }));
  const backBtn = <button onClick={back} aria-label={t('back')} data-testid="asset-back" className="press -ml-2.5 grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink"><Icon n="chev" className="h-6 w-6 rotate-180" /></button>;
  // NEXT W3: a failed load is an error state with a retry; a network or an asset that does not exist is « not found », not a skeleton for ever
  if (!pf.data && pf.isError) return <div className="space-y-5" data-testid="asset-error"><div className="pt-2">{backBtn}</div><ErrorState title={t('nxErrLoad')} offline={(pf.error as { code?: string } | null)?.code === 'offline'} onRetry={() => void pf.refetch()}>{t('nxErrLoadBody')}</ErrorState></div>;
  if (pf.data && !b) return <div className="space-y-5" data-testid="asset-not-found"><div className="pt-2">{backBtn}</div>
    <EmptyState icon="search" title={t('nxNotFoundTitle')} action={<Btn kind="soft" onClick={() => nav({ tab: 'assets' })}>{t('allAssets')}</Btn>}>{t('nxNotFoundBody')}</EmptyState></div>;
  if (!b || !pf.data) return <div className="space-y-5" aria-busy="true"><Skeleton h="h-12" className="!w-56 !rounded-xl" /><Skeleton h="h-[420px]" /><Skeleton h="h-40" /><SkeletonRows n={3} /></div>;
  const n = nets.data?.find((x) => x.id === network);
  const m = pf.data.prices?.[b.symbol] ?? mk.data?.market ?? null;
  // v11 live quotes: the streamed price when there is one; in another currency than USD it is converted at the rate of the polled reading (said on screen)
  const livePrice: number | null = live && m && m.usd > 0 ? (ck === 'usd' ? live.usd : live.usd * (m.cad / m.usd)) : null;
  const price: number | null = livePrice ?? (m ? m[ck] : null);
  const pts = mk.data?.points ?? [];
  const shown = hover?.p ?? livePrice ?? (pts.length ? pts[pts.length - 1]!.p : price);
  const base = pts.length ? pts[0]!.p : null;
  const delta = shown !== null && base ? ((shown - base) / base) * 100 : null;
  const priceFmt = (v: number) => new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { style: 'currency', currency: cur, maximumFractionDigits: v < 1 ? 6 : 2 }).format(v);
  const timeFmt = (ts: number) => new Date(ts).toLocaleString(locale === 'fr' ? 'fr-CA' : 'en-CA', days === '1' ? { hour: '2-digit', minute: '2-digit' } : days === '365' ? { month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
  const hidden = settings.hideBalances;
  // the holding's value: an exact product of the balance and the price (money.ts), never a float
  const value = price !== null ? mulDecimal(b.display, price) : null;
  // per-network breakdown: every row of this symbol the wallet can hold, this one included
  const same = pf.data.balances.filter((x) => x.symbol === b.symbol), heldElsewhere = same.filter((x) => x.amount !== null && x.amount !== '0');
  const all = act.data?.items ?? [], filtered = serverFiltered(all, network, asset);
  const mine = foldInternal(itemsOfAsset(all, network, asset)).slice(0, 8), windowFull = !filtered && all.length >= ACTIVITY_WINDOW, block = sendBlock(pf.data);
  const iss = asset === 'native' ? null : issuerOf(t, b.symbol, b.name);
  const sgn = (v: number) => `${v > -0.005 ? '+' : '−'}${numFmt(Math.abs(v), locale, 2, 2)} %`;
  const p = prefs.prefs[prefKey(network, asset)];
  const change = (c: { hidden?: boolean; favorite?: boolean }) => { void prefs.set(network, asset, c).then((ok) => { if (!ok) setPrefFailed(true); }); };
  const loc = locale === 'fr' ? 'fr-CA' : 'en-CA';
  const rowTime = (at: string) => new Date(at).toLocaleString(loc, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="space-y-5" data-testid="asset">
      <div className="flex items-center gap-2.5 pt-2">
        {backBtn}
        <Coin sym={b.symbol} net={b.network} size={48} />
        <div className="min-w-0 flex-1"><h1 className="t-title2 truncate">{b.name}</h1><div className="t-footnote mt-0.5 flex items-center gap-1.5 text-mute"><span>{b.symbol}</span><span aria-hidden="true">·</span><NetDot net={b.network} size={15} /><span className="truncate">{b.networkName}</span></div></div>
        {prefs.available && <span className="flex shrink-0 items-center">
          <button type="button" aria-pressed={!!p?.favorite} aria-label={t(p?.favorite ? 'nwUnfav' : 'nwFav', { name: b.name })} data-testid="asset-fav" onClick={() => change({ favorite: !p?.favorite })} className={`press grid h-11 w-11 place-items-center rounded-full ${p?.favorite ? 'text-caution' : 'text-mute'}`}><Icon n={p?.favorite ? 'starFill' : 'star'} className="h-[22px] w-[22px]" /></button>
          <button type="button" aria-pressed={!!p?.hidden} aria-label={t(p?.hidden ? 'nwUnhide' : 'nwHide', { name: b.name })} data-testid="asset-hide" onClick={() => change({ hidden: !p?.hidden })} className="press grid h-11 w-11 place-items-center rounded-full text-mute"><Icon n={p?.hidden ? 'eye' : 'eyeOff'} className="h-[22px] w-[22px]" /></button></span>}
      </div>

      <StaleBanner q={pf} />
      {prefFailed && <Notice tone="danger" testid="pref-failed">{t('nwPrefFailed')}</Notice>}
      {p?.hidden && <Notice tone="info" testid="asset-hidden-note" action={<button className="link" onClick={() => change({ hidden: false })}>{t('nwShowAgain')}</button>}>{t('nwHiddenAsset')}</Notice>}
      {iss && <div data-testid="asset-issuer"><Notice tone="warn">{t('qaPegNote', { name: b.name, sym: b.symbol, issuer: iss.text })}</Notice></div>}
      <div className="panes space-y-5 lg:space-y-0"><div className="min-w-0 space-y-5">
        <Card className="!pb-4">
          <div className="flex items-center justify-between gap-3"><div className="t-footnote text-mute">{hover ? timeFmt(hover.t) : t('price')}</div>
            {livePrice !== null ? <LiveSpotTag converted={ck !== 'usd'} /> : m?.priceAt && <PriceFreshness at={m.priceAt} stale={!!m.stale} />}</div>
          <div className="t-display amt mt-1.5 text-[clamp(2.125rem,10.5vw,2.75rem)]">{shown !== null && shown !== undefined ? priceFmt(shown) : '—'}</div>
          <div className="mt-2 h-5">{delta !== null && <Change pct={delta} suffix={t(`r_${days}` as never)} />}</div>
          <div className="mt-3">{mk.isLoading ? <div className="skel h-[210px] !rounded-2xl" /> : <PriceChart points={pts} format={priceFmt} formatTime={timeFmt} onHover={setHover} />}</div>
          <div className="mt-4"><Seg compact label={t('range')} value={days} onChange={(d) => { setDays(d); setHover(null); }} options={RANGES.map(([d, fr, en]) => [d, locale === 'fr' ? fr : en] as const)} /></div>
          {!pf.data.prices && <p className="t-footnote mt-3 text-mute">{t(settings.prices ? 'dzPricesAway' : 'noPrices')}</p>}
        </Card>

        {m && <Card><H>{t('marketData')}</H>
          <div className="grid grid-cols-2 gap-3">
            <StatTile label={t('change24h')} value={m.change24h === null ? '—' : sgn(m.change24h)} />
            <StatTile label={t('change7d')} value={m.change7d === null ? '—' : sgn(m.change7d)} />
            <StatTile label={t('marketCap')} value={compact(m.marketCap, 'USD', locale)} />
            <StatTile label={t('volume24h')} value={compact(m.volume24h, 'USD', locale)} />
            <StatTile label={t('range24h')} value={m.low24h === null || m.high24h === null ? '—' : `${fiat(m.low24h, 'USD', locale)} – ${fiat(m.high24h, 'USD', locale)}`} />
            <StatTile label={t('rank')} value={m.rank ? `#${m.rank}` : '—'} />
          </div>
          <p className="t-footnote mt-3 text-mute">{t('marketSource')}</p></Card>}
      </div><div className="min-w-0 space-y-5">
        <Card>
          <div className="t-footnote text-mute">{t('yourBalance')}</div>
          <div className="t-title1 amt mt-1" data-testid="asset-balance"><Money hidden={hidden}>{b.display === null ? '—' : trimAmt(b.display, 8)} <span className="text-mute">{b.symbol}</span></Money></div>
          {value !== null && <div className="t-callout text-mute"><Money hidden={hidden}>{fiatText(value, cur, locale)}</Money></div>}
          {b.display === null && <p className="t-footnote mt-1 text-caution">{t('qaBalUnknown')}</p>}
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Btn onClick={() => nav({ tab: 'receive', network })}><Icon n="arrowDown" className="h-[18px] w-[18px]" />{t('receive')}</Btn>
            <Btn kind="soft" onClick={() => nav({ tab: 'send', network, asset })} disabled={block !== null} data-testid="asset-send"><Icon n="arrowUp" className="h-[18px] w-[18px]" />{t('send')}</Btn>
          </div>
          {block && <p className="t-footnote mt-3 text-caution" data-testid="send-blocked">{t(sendBlockKey(block))}</p>}
        </Card>

        {same.length > 1 && <Card className="!px-0 !pb-1"><div className="px-[var(--card-padding)]"><H right={heldElsewhere.length > 0 ? <span className="t-footnote text-mute">{t('nwOnNetworks', { n: heldElsewhere.length })}</span> : undefined}>{t('nwByNetworkOf', { sym: b.symbol })}</H></div>
          <ul data-testid="asset-networks">{same.map((o) => { const here = o.network === network && o.asset === asset, v = rowValue(o, pf.data!.prices, ck);
            return <li key={o.network + o.asset}><button onClick={() => { if (!here) nav({ tab: 'asset', network: o.network, asset: o.asset }); }} aria-current={here ? 'page' : undefined} className={`row row-press ${here ? 'bg-elev/50' : ''}`}>
              <Coin sym={o.symbol} net={o.network} size={36} /><span className="min-w-0 flex-1"><span className="t-body block truncate font-medium leading-tight">{o.networkName}</span>{o.name !== b.name && <span className="t-footnote mt-0.5 block truncate text-mute">{o.name}</span>}</span>
              <span className="shrink-0 text-right"><span className={`t-body-strong amt block ${o.amount === '0' ? 'text-mute' : ''}`}><Money hidden={hidden}>{o.display === null ? '—' : trimAmt(o.display)}</Money></span>
                {v !== null && o.amount !== '0' && <span className="t-footnote block text-mute"><Money hidden={hidden}>{fiatText(v, cur, locale)}</Money></span>}</span>
              {!here && <Icon n="chev" className="h-4 w-4 shrink-0 text-mute" />}</button></li>; })}</ul></Card>}

        <Card><H>{t('assetDetails')}</H>
          <dl>
            <Fact k={t('network')}><span className="inline-flex items-center gap-2"><NetDot net={b.network} size={20} />{b.networkName}</span></Fact>
            <Fact k={t('decimals')}>{b.decimals}</Fact>
            {asset === 'native' ? <Fact k={t('nwKind')}>{t('nativeCoin')}</Fact> : <Fact stack k={t('contract')} testid="asset-contract"><Addr value={asset} />
              <div className="mt-2 flex flex-wrap gap-2"><CopyBtn small text={asset} />{n && <a href={n.explorerAddr + asset} target="_blank" rel="noreferrer noopener" className="btn press inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-md)] border border-line px-5 text-[0.84375rem] font-medium"><Icon n="ext" className="h-4 w-4" />{t('explorer')}</a>}</div></Fact>}
          </dl>
          {asset !== 'native' && <p className="t-footnote mt-3 text-mute">{t('verifiedToken')}</p>}</Card>

        <Card className="!px-0 !pb-1"><div className="px-[var(--card-padding)]"><H right={<button className="link -my-2" onClick={() => nav({ tab: 'activity' })}>{t('all')}<Icon n="chev" className="h-4 w-4" /></button>}>{t('nwMovementsOf', { sym: b.symbol })}</H></div>
          {!act.data ? (act.isError ? <div className="t-callout flex items-center justify-between gap-3 px-[var(--card-padding)] pb-4 text-mute" data-testid="asset-activity-error"><span>{t('nxActivityErr')}</span><Btn kind="soft" className="!min-h-11 shrink-0 !text-[0.84375rem]" onClick={() => void act.refetch()}>{t('retry')}</Btn></div> : <div className="px-[var(--card-padding)] pb-4" aria-busy="true"><Skeleton h="h-12" /></div>)
            : mine.length === 0 ? <p className="t-callout px-[var(--card-padding)] pb-4 text-mute" data-testid="asset-activity-empty" data-window-full={windowFull}>{windowFull ? t('nxActivityWindow', { n: ACTIVITY_WINDOW }) : t('noActivity')}</p> :
            <><ul data-testid="asset-activity" data-server-filtered={filtered}>{mine.map((i) => <li key={i.id}><TransactionRow i={i} contacts={contacts.data} hidden={hidden} time={rowTime(i.at)} onOpen={() => nav({ tab: 'activity', asset: i.id })} /></li>)}</ul>
              {windowFull && <p className="t-footnote border-t border-line px-[var(--card-padding)] py-3 text-mute" data-testid="asset-activity-window">{t('nwWindowNote', { n: ACTIVITY_WINDOW })}</p>}</>}</Card>
      </div></div>
    </div>
  );
}
