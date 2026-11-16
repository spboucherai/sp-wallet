/**
 * Trade → Futures: market data (read-only), PAPER trading, and controlled LIVE trading on a venue account (Hyperliquid testnet
 * or mainnet, passkey per order — see derivatives/Live*.tsx). Which money the selected account moves is on a band that is
 * always on screen: « SIMULATION », « TESTNET — argent fictif », « RÉEL — argent réel ».
 * Phone: sticky market header + tabs (Chart · Book · Trade · Positions). Tablet: chart and book on the left, order panel on
 * the right. Desktop: chart | book + trades | order panel, blotter underneath. This component never listens to the stream:
 * the header, the book, the trades and the chart each subscribe to their own slice of the market store.
 */
import { useQuery } from '@tanstack/react-query';
import { useContext, useEffect, useMemo, useState } from 'react';
import type { Nav } from '../App';
import { errText, I18n, useT } from '../i18n';
import { Btn, Card, Fold, Notice, PageTitle, VenueIcon } from '../ui';
import { AccountsView, VenueStrip } from '../derivatives/Accounts';
import { dapi } from '../derivatives/api';
import { Seg, useLocalState, useMedia, VENUE_NAME } from '../derivatives/bits';
import { Blotter } from '../derivatives/Blotter';
import { BookPanel, LiquidityPanel, TradesPanel } from '../derivatives/Book';
import { Candles, type Overlay } from '../derivatives/Candles';
import { CompareView } from '../derivatives/Compare';
import { priceDp } from '../derivatives/dec';
import { lapi, toneOf, type LiveSummary, type Tone } from '../derivatives/live';
import { AccountSwitch, ModeBand, ModeTag } from '../derivatives/LiveBits';
import { LiveBlotter } from '../derivatives/LiveBlotter';
import { LiveOrderPanel } from '../derivatives/LiveOrderPanel';
import { useLiveAccount } from '../derivatives/liveStore';
import { MarketHeader, MarketPicker, MarketStats, StaleBanner, Veil } from '../derivatives/Market';
import { OrderPanel } from '../derivatives/OrderPanel';
import { RouterView } from '../derivatives/Router';   // router (simulation)
import { hasPaperPrefill, setPaperPrefill } from '../derivatives/routerApi';
import { useMarketStore, useSlice, type MarketStore } from '../derivatives/store';
// >>> v8 GMX trading
import { gmxMarketOf, peekGmxPrefill, setGmxPrefill, useGmx } from '../derivatives/gmx';
import { GmxActivity } from '../derivatives/GmxActivity';
import { GmxCard, GmxLocked } from '../derivatives/GmxCard';
import { GmxOrderPanel } from '../derivatives/GmxOrderPanel';
// <<< v8 GMX trading
import { venueOf, type DerivAccount, type Instrument, type Interval, type Order, type Position, type VenueInfo } from '../derivatives/types';

export type FuturesView = 'terminal' | 'compare' | 'accounts' | 'router';
const DEFAULT_ID = 'hyperliquid:BTC';
/**
 * The accounts that can trade a venue's markets, paper first, and the one in use: the stored choice when it is among them,
 * otherwise the first paper account — a venue account is never selected by default, only by the owner.
 */
function pickAccount(paper: DerivAccount[], live: LiveSummary[], accountId: string | null, venue: string): { paper: DerivAccount[]; live: LiveSummary[]; account: DerivAccount | null; venueAccount: LiveSummary | null } {
  const p = paper.filter((a) => a.venue === venue), l = live.filter((a) => a.venue === venue);
  const venueAccount = p.some((a) => a.id === accountId) ? null : l.find((a) => a.id === accountId) ?? null;
  return { paper: p, live: l, venueAccount, account: venueAccount ? null : p.find((a) => a.id === accountId) ?? p[0] ?? null };
}

export function Futures({ instrument: routeId, view = 'terminal', nav }: { instrument?: string; view?: FuturesView; nav: Nav }) {
  const t = useT(); const { locale } = useContext(I18n);
  const [lastId, setLastId] = useLocalState<string>('spw-fut-market', DEFAULT_ID);
  const [accountId, setAccountId] = useLocalState<string | null>('spw-fut-account', null);
  const [base, setBase] = useLocalState<string>('spw-fut-base', 'BTC');
  const id = routeId || lastId || DEFAULT_ID;
  useEffect(() => { if (routeId && routeId !== lastId) setLastId(routeId); }, [routeId]);   // eslint-disable-line react-hooks/exhaustive-deps
  const venues = useQuery({ queryKey: ['deriv', 'venues'], queryFn: dapi.venues, refetchInterval: 30_000 });
  const instruments = useQuery({ queryKey: ['deriv', 'instruments', locale], queryFn: () => dapi.instruments(undefined, locale), staleTime: 600_000, refetchInterval: 600_000 });   // v8: settlement and mark-price sentences in the screen's language
  const accounts = useQuery({ queryKey: ['deriv', 'accounts'], queryFn: dapi.accounts, refetchInterval: 6000 });
  const go = (v: FuturesView, inst = id) => nav({ tab: 'futures', asset: inst, view: v === 'terminal' ? undefined : v });
  const phone = !useMedia('(min-width: 768px)');
  const paper = useMemo(() => (accounts.data ?? []).filter((a) => a.kind === 'paper'), [accounts.data]);
  // venue accounts of controlled live trading; a backend without the live routes simply has none
  const liveQ = useQuery({ queryKey: ['deriv', 'live', 'accounts'], queryFn: lapi.accounts, refetchInterval: 15_000, retry: 0 });
  const live = useMemo(() => liveQ.data ?? [], [liveQ.data]);
  const sel = pickAccount(paper, live, accountId, venueOf(id));
  const tone: Tone = sel.venueAccount ? toneOf(sel.venueAccount) : 'paper', anyLive = live.some((a) => a.mode === 'MANUAL_LIVE');
  const list = instruments.data?.instruments ?? [], unread = instruments.data?.errors ?? [];
  // >>> v8 GMX trading: GMX has no venue account — its status (settings, authorization, wallet, positions read from the chain) is one read; a backend without the routes has none
  const { locale: gxLocale } = useContext(I18n);
  const gmx = useGmx(gxLocale).data;
  const gxReal = view === 'terminal' && !!gmx?.tradable && !!gmxMarketOf(gmx, id);   // this market's order panel moves real money
  // <<< v8 GMX trading

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        {/* the large title (the shell collapses it into the header on scroll) with the mode of the selected account beside it, on every screen size */}
        <div className="w-full min-w-0 sm:w-auto"><PageTitle right={<ModeTag tone={/* v8 GMX trading */ gxReal ? 'mainnet' : tone} className="ml-2 shrink-0" />}>{t('fxTitle')}</PageTitle></div>
        <Seg tabs size="sm" label={t('fxViews')} value={view} onChange={(v) => go(v)} className="w-full sm:w-auto sm:min-w-[330px]" options={[{ id: 'terminal', label: t('fxViewTerminal') }, { id: 'compare', label: t('fxViewCompare') }, { id: 'router', label: t('rxTab') }, { id: 'accounts', label: t('fxViewAccounts') }]} />
      </div>
      <p className="px-0.5 text-[12.5px] leading-snug text-mute" data-testid="paper-banner">{t(/* v8 GMX trading */ gxReal ? 'gxBannerReal' : tone === 'paper' ? (anyLive ? 'flBannerSimLive' : 'flBannerOff') : tone === 'testnet' ? 'flBannerTestnet' : 'flBannerReal')}</p>
      {venues.isError ? <Notice tone="danger"><b className="block font-semibold">{t('dzFxVenueCut')}</b>{t('fxApiDown')} {errText(t, venues.error)}</Notice> : venues.data && !(phone && view === 'terminal') ? <VenueStrip venues={venues.data} compact /> : null}
      {unread.length > 0 && <Notice tone="warn"><b className="block font-semibold">{t('dzFxVenueCut')}</b>{t('fxVenueErrors', { venues: unread.map((e) => VENUE_NAME[e.venue as keyof typeof VENUE_NAME] ?? e.venue).join(', ') })}</Notice>}
      {view === 'terminal' && <Terminal id={id} instruments={list} instrumentsLoading={instruments.isLoading} venues={venues.data ?? []} accounts={paper} liveAccounts={live} accountId={accountId} onAccount={setAccountId}
        onMarket={(m) => go('terminal', m)} goAccounts={() => go('accounts')} />}
      {view === 'compare' && <CompareView instruments={list} base={base} onBase={setBase} onOpen={(m) => go('terminal', m)} />}
      {/* router (simulation): the only action is to open the PAPER order panel, pre-filled */}
      {view === 'router' && <RouterView accounts={paper} onOpenPaper={(p, account) => { setPaperPrefill(p); if (account) setAccountId(account); go('terminal', p.instrument); }}
        /* >>> v8 GMX trading: when GMX is tradable, a GMX candidate can pre-fill the GMX order panel */ gmx={gmx} onOpenGmx={(p) => { setGmxPrefill(p); go('terminal', p.instrument); }} /* <<< v8 GMX trading */ />}
      {view === 'accounts' && <AccountsView venues={venues.data ?? []} instruments={list} accounts={paper} loading={accounts.isLoading} selected={accountId} onSelect={setAccountId} />}
      {/* >>> v8 GMX trading: the GMX « account » is the wallet's own address */}
      {view === 'accounts' && gmx && <GmxCard status={gmx} onOpen={(m) => go('terminal', m)} />}
      {/* <<< v8 GMX trading */}
    </div>
  );
}

function overlaysOf(detail: { positions: Position[]; openOrders: Order[] } | null | undefined, id: string, t: ReturnType<typeof useT>, venue = false): Overlay[] {
  if (!detail) return [];
  const out: Overlay[] = [];
  for (const p of detail.positions) if (p.instrument === id) {
    out.push({ price: Number(p.entryPrice), label: `${t('fxEntry')} ${t(p.side === 'long' ? 'fxLong' : 'fxShort')}`, kind: 'entry' });
    if (p.liquidationPrice) out.push({ price: Number(p.liquidationPrice), label: venue ? t('fxLiqShort') : `${t('fxLiqShort')} (${t('estimate')})`, kind: 'liq' });
  }
  for (const o of detail.openOrders) if (o.instrument === id) {
    const side = t(o.side === 'buy' ? 'fxSide_buy' : 'fxSide_sell');
    if (o.type === 'limit') out.push({ price: Number(o.price), label: `${t('fxKindShort_limit')} ${side}`, kind: 'order' });
    else if (o.triggerPrice) out.push({ price: Number(o.triggerPrice), label: `${t(o.type.startsWith('stop') ? 'fxKindShort_stop' : 'fxKindShort_tp')} ${side}`, kind: o.type.startsWith('stop') ? 'stop' : 'tp' });
  }
  return out;
}

function Terminal({ id, instruments, instrumentsLoading, venues, accounts, liveAccounts, accountId, onAccount, onMarket, goAccounts }: { id: string; instruments: Instrument[]; instrumentsLoading: boolean; venues: VenueInfo[]; accounts: DerivAccount[]; liveAccounts: LiveSummary[]; accountId: string | null;
  onAccount: (id: string) => void; onMarket: (id: string) => void; goAccounts: () => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const store = useMarketStore(id);
  const meta = useSlice(store, 'meta');
  const phone = !useMedia('(min-width: 768px)'), wide = useMedia('(min-width: 1360px)');
  const [interval, setIntervalV] = useLocalState<Interval>('spw-fut-interval', '1h');
  const [tab, setTab] = useState<'chart' | 'book' | 'trade' | 'positions'>(() => (hasPaperPrefill(id) || /* v8 GMX trading */ peekGmxPrefill(id) !== null ? 'trade' : 'chart'));   // coming from the router: the order panel first
  const [pick, setPick] = useState(false);
  const instrument = meta.instrument ?? instruments.find((i) => i.id === id) ?? null;
  const byId = useMemo(() => new Map(instruments.map((i) => [i.id, i])), [instruments]);
  const venue = venues.find((v) => v.id === instrument?.venue);
  const picked = useMemo(() => pickAccount(accounts, liveAccounts, accountId, instrument?.venue ?? venueOf(id)), [accounts, liveAccounts, accountId, instrument?.venue, id]);
  const mine = picked.paper, { account, venueAccount } = picked, chosen = venueAccount ?? account;
  const detail = useQuery({ queryKey: ['deriv', 'account', account?.id], enabled: !!account, queryFn: () => dapi.account(account!.id), refetchInterval: (q) => ((q.state.data?.positions.length ?? 0) + (q.state.data?.openOrders.length ?? 0) > 0 ? 3000 : 10_000) });
  const d = account && detail.data?.id === account.id ? detail.data : undefined;
  const lv = useLiveAccount(venueAccount?.id ?? null);
  const liveCfg = useQuery({ queryKey: ['deriv', 'live', 'config', locale], queryFn: () => lapi.config(locale), enabled: !!venueAccount, staleTime: 60_000, refetchInterval: 60_000, retry: 0 });
  const held = venueAccount ? (lv.detail?.venueState.error ? null : lv.detail?.venueState ?? null) : d ?? account;
  const overlays = useMemo(() => overlaysOf(held, id, t, !!venueAccount), [held, id, locale]);   // eslint-disable-line react-hooks/exhaustive-deps
  let tone: Tone = chosen ? toneOf(chosen) : 'paper';   // `let`: v8 GMX trading (below)
  const switcher = <AccountSwitch value={chosen?.id ?? ''} onChange={onAccount} choices={[...mine, ...picked.live].map((a) => ({ id: a.id, label: a.label, tone: toneOf(a) }))} />;
  let band = <ModeBand tone={tone} label={chosen?.label} compact={phone} />;   // `let`: v8 GMX trading (below)
  const unknown = !instrumentsLoading && instruments.length > 0 && !byId.has(id) && meta.error !== null;
  // >>> v8 GMX trading
  const gmxQ = useGmx(locale, venueOf(id) === 'gmx');
  // <<< v8 GMX trading

  if (unknown) return <Card><div className="space-y-3"><Notice tone="warn">{t('fxUnknownMarket', { id })}</Notice><Btn kind="soft" onClick={() => onMarket(instruments[0]!.id)}>{t('fxOpenDefault', { symbol: instruments[0]!.symbol })}</Btn></div></Card>;
  const pdp = priceDp(instrument?.tickSize, store.ticker?.mark);
  const hasBook = instrument ? instrument.venue !== 'gmx' : true;
  const chart = <Veil store={store}><Candles store={store} interval={interval} onInterval={setIntervalV} overlays={overlays} priceDp={pdp} locale={locale} stale={false} height={phone ? 300 : wide ? 480 : 380} /></Veil>;
  const book = instrument ? (hasBook ? <Veil store={store}><BookPanel store={store} instrument={instrument} rows={phone ? 9 : 10} /></Veil> : <LiquidityPanel store={store} />) : <BookSkeleton rows={phone ? 9 : 10} />;
  const trades = instrument && hasBook ? <Veil store={store}><TradesPanel store={store} instrument={instrument} rows={phone ? 14 : wide ? 9 : 14} /></Veil> : null;
  let order = !instrument ? <OrderSkeleton />   // `let`: v8 GMX trading (below)
    : venueAccount ? <LiveOrderPanel instrument={instrument} account={venueAccount} detail={lv.detail} conn={lv.conn} workerError={lv.workerError} config={liveCfg.data} switcher={switcher} goAccounts={goAccounts} />
    : <OrderPanel store={store} instrument={instrument} account={account} accounts={mine} venue={venue} onAccount={onAccount} goAccounts={goAccounts} switcher={picked.live.length > 0 && account ? switcher : undefined} />;
  let blotter = venueAccount ? <LiveBlotter account={venueAccount} detail={lv.detail} instruments={byId} ttlMs={liveCfg.data?.bounds.orderApprovalTtlMs ?? 90_000} onSelect={onMarket} />
    : <Blotter account={account} detail={d} instruments={byId} onSelect={onMarket} goAccounts={goAccounts} />;
  let nPos = held?.positions.length ?? 0;
  // >>> v8 GMX trading: on a market GMX lists for this wallet, the blotter is the wallet's own GMX activity (read from the chain) and, when
  // trading is open, the order panel is GMX's — with the real-money band. Closed: the existing panel stays, followed by why it is closed.
  const gxStatus = gmxQ.data, gxMarket = gmxMarketOf(gxStatus, id);
  if (gxStatus && gxMarket) {
    if (gxStatus.tradable) { tone = 'mainnet'; band = <ModeBand tone="mainnet" label="GMX v2 · Arbitrum" compact />;
      order = <GmxOrderPanel key={gxMarket.market} status={gxStatus} market={gxMarket} onMarket={onMarket} />; }
    else order = <div className="space-y-4">{order}<GmxLocked status={gxStatus} goAccounts={goAccounts} /></div>;
    blotter = <GmxActivity status={gxStatus} market={gxMarket.market} onSelect={onMarket} />;
    nPos = gxStatus.positions.filter((p) => p.market.toLowerCase() === gxMarket.market.toLowerCase()).length;
  }
  // <<< v8 GMX trading
  const head = (s: string) => <h3 className="t-eyebrow mb-2.5">{s}</h3>;
  const picker = pick && <MarketPicker instruments={instruments} current={id} onClose={() => setPick(false)} onPick={(m) => { setPick(false); onMarket(m); }} />;
  const error = meta.error && !store.ticker ? <Notice tone="danger">{t('fxMarketError')}</Notice> : null;
  const facts = instrument && <VenueFacts instrument={instrument} store={store} />;

  if (phone) return (
    <div className="space-y-3" data-testid="terminal" data-layout="phone" data-tone={tone}>
      <div className="nav-glass sticky top-[calc(env(safe-area-inset-top)+64px)] z-[5] -mx-5 space-y-2 border-b border-line px-5 pb-2 pt-2">
        {band}
        <MarketHeader store={store} instrument={instrument} onPick={() => setPick(true)} compact />
        <Seg tabs size="sm" label={t('fxPanels')} value={tab} onChange={setTab} options={[{ id: 'chart', label: t('fxTabChart') }, { id: 'book', label: t(hasBook ? 'fxTabBook' : 'fxTabLiquidity') }, { id: 'trade', label: t('fxTabTrade') },
          { id: 'positions', label: `${t('fxTabPositions')}${nPos ? ` (${nPos})` : ''}` }]} />
      </div>
      <StaleBanner store={store} />{error}
      <div role="tabpanel" aria-label={t('fxPanels')}>
        {tab === 'chart' && <div className="space-y-3"><Card className="!p-4">{chart}</Card><Card className="!p-4"><MarketStats store={store} instrument={instrument} /></Card>{facts}</div>}
        {tab === 'book' && <div className="space-y-3"><Card className="!p-4">{head(t(hasBook ? 'fxBook' : 'fxGmxLiquidity'))}{book}</Card>{trades && <Card className="!p-4">{head(t('fxTrades'))}{trades}</Card>}</div>}
        {tab === 'trade' && <Card className="!p-4">{order}</Card>}
        {tab === 'positions' && <Card className="!p-4">{blotter}</Card>}
      </div>
      {picker}
    </div>
  );
  return (
    <div className="space-y-3" data-testid="terminal" data-layout={wide ? 'desktop' : 'tablet'} data-tone={tone}>
      {/* the band stays on screen while the terminal scrolls; the page colour behind it keeps what scrolls underneath from showing through its wash */}
      <div className="sticky top-[calc(env(safe-area-inset-top)+64px)] z-[5] rounded-xl bg-bg lg:top-2">{band}</div>
      <Card className="!p-4"><MarketHeader store={store} instrument={instrument} onPick={() => setPick(true)} compact={false} /></Card>
      <StaleBanner store={store} />{error}
      {wide ? <div className="grid grid-cols-[minmax(0,1fr)_292px_324px] items-start gap-3">
        <div className="space-y-3"><Card className="!p-4">{chart}</Card>{facts}</div>
        <div className="space-y-3"><Card className="!p-3.5">{head(t(hasBook ? 'fxBook' : 'fxGmxLiquidity'))}{book}</Card>{trades && <Card className="!p-3.5">{head(t('fxTrades'))}{trades}</Card>}</div>
        <Card className="!p-4">{order}</Card>
      </div> : <div className="grid grid-cols-[minmax(0,1fr)_324px] items-start gap-3">
        <div className="space-y-3"><Card className="!p-4">{chart}</Card>
          <div className={`grid gap-3 ${trades ? 'grid-cols-2' : 'grid-cols-1'}`}><Card className="!p-3.5">{head(t(hasBook ? 'fxBook' : 'fxGmxLiquidity'))}{book}</Card>{trades && <Card className="!p-3.5">{head(t('fxTrades'))}{trades}</Card>}</div>{facts}</div>
        <Card className="!p-4">{order}</Card>
      </div>}
      <Card className="!p-4">{blotter}</Card>
      {picker}
    </div>
  );
}

/** what this contract is, in the venue's own terms — two perpetuals on the same asset are not the same contract */
function VenueFacts({ instrument: i }: { instrument: Instrument; store: MarketStore }) {
  const t = useT(); const { locale } = useContext(I18n);
  const nf = (s: string | null) => (s === null ? '—' : s.length > 12 ? Number(s).toExponential(0) : s.replace('.', locale === 'en' ? '.' : ','));
  const dt = 'text-[11.5px] leading-tight text-mute', dd = 'mt-0.5 font-medium leading-snug';
  return <Card className="!px-4 !py-1.5"><Fold testid="contract-facts" summary={<span className="flex min-w-0 items-center gap-2.5 text-ink"><VenueIcon venue={i.venue} size={24} /><span className="min-w-0">{t('fxContract', { venue: VENUE_NAME[i.venue], symbol: i.symbol })}</span></span>}>
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-[13.5px] sm:grid-cols-2">
      <div><dt className={dt}>{t('fxCollateral')}</dt><dd className={dd}>{i.collateral}</dd></div>
      <div><dt className={dt}>{t('fxMaxLeverage')} · {t('fxMarginModes')}</dt><dd className={dd}>{nf(i.maxLeverage)}× · {i.marginModes.map((m) => t(m === 'cross' ? 'fxCross' : 'fxIsolated')).join(', ')}</dd></div>
      <div><dt className={dt}>{t('fxTickLot')}</dt><dd className={dd}>{nf(i.tickSize)} · {nf(i.lotSize)} {i.base}</dd></div>
      <div><dt className={dt}>{t('fxMinOrder')}</dt><dd className={dd}>{i.minNotional ? `${nf(i.minNotional)} USD` : i.minOrderSize ? `${nf(i.minOrderSize)} ${i.base}` : '—'}</dd></div>
      {i.category && <div data-testid="contract-category"><dt className={dt}>{t('exCategory')}</dt><dd className={dd}>{t(`exCategory_${i.category}`)}{i.venue === 'edgex' && i.category === 'pre_ipo' ? <span className="mt-0.5 block text-[12px] font-normal text-mute">{t('exPreIpoNote')}</span> : null}</dd></div>}
      {i.venue === 'edgex' && <div data-testid="edgex-unavailable"><dt className={dt}>{t('exTrading')}</dt><dd className={`${dd} text-warn`}>{t('exTradingUnavailable')}</dd></div>}
      <div className="sm:col-span-2"><dt className={dt}>{t('fxSettlement')}</dt><dd className={dd}>{i.settlement}</dd></div>
      <div className="sm:col-span-2"><dt className={dt}>{t('fxMarkMethod')}</dt><dd className={dd}>{i.markPriceMethod}</dd></div>
    </dl>
    <p className="mb-2 mt-3 text-[12px] leading-snug text-mute">{t('fxVenueText')}</p>
  </Fold></Card>;
}
/** the book before the instrument is known: rows of the final height */
function BookSkeleton({ rows }: { rows: number }) {
  const bar = (k: number) => <div key={k} className="flex h-[23px] items-center"><div className="skel h-3 !rounded-md" style={{ width: `${38 + ((k * 37) % 55)}%` }} /></div>;
  return <div aria-hidden="true">{Array.from({ length: rows }, (_, k) => bar(k))}<div className="skel my-1.5 h-8 !rounded-lg" />{Array.from({ length: rows }, (_, k) => bar(k + 3))}</div>;
}
/** the order panel before the instrument is known: title, account tile, the two directions, the fields, the action */
function OrderSkeleton() {
  return <div className="space-y-4" aria-hidden="true"><div className="flex items-center justify-between"><div className="skel h-5 w-32 !rounded-md" /><div className="skel h-5 w-20 !rounded-md" /></div>
    <div className="skel h-[92px] !rounded-2xl" /><div className="grid grid-cols-2 gap-2"><div className="skel h-[50px] !rounded-2xl" /><div className="skel h-[50px] !rounded-2xl" /></div>
    <div className="skel h-[52px] !rounded-2xl" /><div className="skel h-[52px] !rounded-2xl" /><div className="skel h-11 !rounded-2xl" /><div className="skel h-[52px] !rounded-2xl" /></div>;
}
