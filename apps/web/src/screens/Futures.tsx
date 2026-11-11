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
import { Btn, Card, Notice, Skeleton } from '../ui';
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
import { useMarketStore, useSlice, type MarketStore } from '../derivatives/store';
import { venueOf, type DerivAccount, type Instrument, type Interval, type Order, type Position, type VenueInfo } from '../derivatives/types';

export type FuturesView = 'terminal' | 'compare' | 'accounts';
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
  const t = useT();
  const [lastId, setLastId] = useLocalState<string>('spw-fut-market', DEFAULT_ID);
  const [accountId, setAccountId] = useLocalState<string | null>('spw-fut-account', null);
  const [base, setBase] = useLocalState<string>('spw-fut-base', 'BTC');
  const id = routeId || lastId || DEFAULT_ID;
  useEffect(() => { if (routeId && routeId !== lastId) setLastId(routeId); }, [routeId]);   // eslint-disable-line react-hooks/exhaustive-deps
  const venues = useQuery({ queryKey: ['deriv', 'venues'], queryFn: dapi.venues, refetchInterval: 30_000 });
  const instruments = useQuery({ queryKey: ['deriv', 'instruments'], queryFn: () => dapi.instruments(), staleTime: 600_000, refetchInterval: 600_000 });
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-1">
        <div className="hidden items-center gap-2.5 sm:flex"><h1 className="text-[24px] font-semibold tracking-[-0.02em] lg:text-[28px]">{t('fxTitle')}</h1><ModeTag tone={tone} /></div>
        <Seg tabs size="sm" label={t('fxViews')} value={view} onChange={(v) => go(v)} className="w-full sm:w-auto sm:min-w-[330px]" options={[{ id: 'terminal', label: t('fxViewTerminal') }, { id: 'compare', label: t('fxViewCompare') }, { id: 'accounts', label: t('fxViewAccounts') }]} />
      </div>
      <p className="text-[12.5px] leading-snug text-mute" data-testid="paper-banner">{t(tone === 'paper' ? (anyLive ? 'flBannerSimLive' : 'flBannerOff') : tone === 'testnet' ? 'flBannerTestnet' : 'flBannerReal')}</p>
      {venues.isError ? <Notice tone="danger">{t('fxApiDown')} {errText(t, venues.error)}</Notice> : venues.data && !(phone && view === 'terminal') ? <VenueStrip venues={venues.data} compact /> : null}
      {unread.length > 0 && <Notice tone="warn">{t('fxVenueErrors', { venues: unread.map((e) => VENUE_NAME[e.venue as keyof typeof VENUE_NAME] ?? e.venue).join(', ') })}</Notice>}
      {view === 'terminal' && <Terminal id={id} instruments={list} instrumentsLoading={instruments.isLoading} venues={venues.data ?? []} accounts={paper} liveAccounts={live} accountId={accountId} onAccount={setAccountId}
        onMarket={(m) => go('terminal', m)} goAccounts={() => go('accounts')} />}
      {view === 'compare' && <CompareView instruments={list} base={base} onBase={setBase} onOpen={(m) => go('terminal', m)} />}
      {view === 'accounts' && <AccountsView venues={venues.data ?? []} instruments={list} accounts={paper} loading={accounts.isLoading} selected={accountId} onSelect={setAccountId} />}
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
  const [tab, setTab] = useState<'chart' | 'book' | 'trade' | 'positions'>('chart');
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
  const tone: Tone = chosen ? toneOf(chosen) : 'paper';
  const switcher = <AccountSwitch value={chosen?.id ?? ''} onChange={onAccount} choices={[...mine, ...picked.live].map((a) => ({ id: a.id, label: a.label, tone: toneOf(a) }))} />;
  const band = <ModeBand tone={tone} label={chosen?.label} compact={phone} />;
  const unknown = !instrumentsLoading && instruments.length > 0 && !byId.has(id) && meta.error !== null;

  if (unknown) return <Card><div className="space-y-3"><Notice tone="warn">{t('fxUnknownMarket', { id })}</Notice><Btn kind="soft" onClick={() => onMarket(instruments[0]!.id)}>{t('fxOpenDefault', { symbol: instruments[0]!.symbol })}</Btn></div></Card>;
  const pdp = priceDp(instrument?.tickSize, store.ticker?.mark);
  const hasBook = instrument ? instrument.venue !== 'gmx' : true;
  const chart = <Veil store={store}><Candles store={store} interval={interval} onInterval={setIntervalV} overlays={overlays} priceDp={pdp} locale={locale} stale={false} height={phone ? 300 : wide ? 430 : 380} /></Veil>;
  const book = instrument ? (hasBook ? <Veil store={store}><BookPanel store={store} instrument={instrument} rows={phone ? 9 : 10} /></Veil> : <LiquidityPanel store={store} />) : <Skeleton h="h-64" />;
  const trades = instrument && hasBook ? <Veil store={store}><TradesPanel store={store} instrument={instrument} rows={phone ? 14 : wide ? 9 : 14} /></Veil> : null;
  const order = !instrument ? <Skeleton h="h-64" />
    : venueAccount ? <LiveOrderPanel instrument={instrument} account={venueAccount} detail={lv.detail} conn={lv.conn} workerError={lv.workerError} config={liveCfg.data} switcher={switcher} goAccounts={goAccounts} />
    : <OrderPanel store={store} instrument={instrument} account={account} accounts={mine} venue={venue} onAccount={onAccount} goAccounts={goAccounts} switcher={picked.live.length > 0 && account ? switcher : undefined} />;
  const blotter = venueAccount ? <LiveBlotter account={venueAccount} detail={lv.detail} instruments={byId} ttlMs={liveCfg.data?.bounds.orderApprovalTtlMs ?? 90_000} onSelect={onMarket} />
    : <Blotter account={account} detail={d} instruments={byId} onSelect={onMarket} />;
  const nPos = held?.positions.length ?? 0;
  const head = (s: string) => <h3 className="mb-2 text-[13px] font-semibold text-mute">{s}</h3>;
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
      <div className="sticky top-[calc(env(safe-area-inset-top)+64px)] z-[5] lg:top-2">{band}</div>
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
  return <Card className="!p-4"><details data-testid="contract-facts">
    <summary className="flex min-h-11 cursor-pointer items-center text-[13.5px] font-semibold">{t('fxContract', { venue: VENUE_NAME[i.venue], symbol: i.symbol })}</summary>
    <dl className="mt-1 grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
      <div><dt className="text-[11.5px] text-mute">{t('fxCollateral')}</dt><dd>{i.collateral}</dd></div>
      <div><dt className="text-[11.5px] text-mute">{t('fxMaxLeverage')} · {t('fxMarginModes')}</dt><dd>{nf(i.maxLeverage)}× · {i.marginModes.map((m) => t(m === 'cross' ? 'fxCross' : 'fxIsolated')).join(', ')}</dd></div>
      <div><dt className="text-[11.5px] text-mute">{t('fxTickLot')}</dt><dd>{nf(i.tickSize)} · {nf(i.lotSize)} {i.base}</dd></div>
      <div><dt className="text-[11.5px] text-mute">{t('fxMinOrder')}</dt><dd>{i.minNotional ? `${nf(i.minNotional)} USD` : i.minOrderSize ? `${nf(i.minOrderSize)} ${i.base}` : '—'}</dd></div>
      <div className="sm:col-span-2"><dt className="text-[11.5px] text-mute">{t('fxSettlement')}</dt><dd className="leading-snug">{i.settlement}</dd></div>
      <div className="sm:col-span-2"><dt className="text-[11.5px] text-mute">{t('fxMarkMethod')}</dt><dd className="leading-snug">{i.markPriceMethod}</dd></div>
    </dl>
    <p className="mt-2 text-[12px] leading-snug text-mute">{t('fxVenueText')}</p>
  </details></Card>;
}
