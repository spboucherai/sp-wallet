import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { get, post, setUnauthHandler } from './api';
import { I18n, useT, type Key, type Locale } from './i18n';
import { Asset } from './screens/Asset';
import { Assets } from './screens/Assets';
import type { FuturesView } from './screens/Futures';
import { Gate } from './screens/Gate';
import { Home } from './screens/Home';
import { Btn, EmptyState, haptic, Icon, Skeleton, SkeletonRows, usePullToRefresh } from './ui';
import { prefetchIcons } from './icons';
import { loadLocale } from './i18n-load';
import { useAlertsRuntime, useUnread } from './alerts'; // v6-alerts
import { setAmountLocale } from './amount'; // v8 hardening: amounts follow the screen's language
import { AREAS, type Area } from './nav';

// v10 performance pass — what the first screen needs (the shell, Home, the asset list and page, the lock screen) is the
// first chunk; every other screen is a chunk of its own, fetched when it is opened or — so that a tap never waits — by
// `preloadScreens()` once the first screen is drawn and the browser is idle. Before: one 1 000 kB chunk.
const screens = {
  futures: () => import('./screens/Futures'),      // the Futures terminal: by far the largest; never preloaded
  alerts: () => import('./screens/Alerts'), monitor: () => import('./screens/Monitor'),
  swap: () => import('./screens/Swap'), send: () => import('./screens/Send'), receive: () => import('./screens/Receive'), activity: () => import('./screens/Activity'),
  agents: () => import('./screens/Agents'), research: () => import('./screens/Research'), plan: () => import('./plan'),
  security: () => import('./screens/Security'), settings: () => import('./screens/Settings'),
  developer: () => import('./screens/Developer'),   // v11 Developer / API: opened from Settings, never preloaded
  markets: () => import('./screens/Markets'),       // v11 Markets explorer and venue comparator: opened from the trade area, never preloaded
  private: () => import('./screens/PrivateMarkets'), // v11 private markets (display only): opened from the trade area, never preloaded
  risk: () => import('./screens/Risk'),             // v11 Risk: opened from Settings and Monitor, never preloaded
  nft: () => import('./screens/Nft'),               // NFT (read-only): gallery, collection, item — opened from Assets, never preloaded
};
const Futures = lazy(() => screens.futures().then((m) => ({ default: m.Futures })));
const Alerts = lazy(() => screens.alerts().then((m) => ({ default: m.Alerts })));
const Monitor = lazy(() => screens.monitor().then((m) => ({ default: m.Monitor })));
const Swap = lazy(() => screens.swap().then((m) => ({ default: m.Swap })));
const Send = lazy(() => screens.send().then((m) => ({ default: m.Send })));
const Receive = lazy(() => screens.receive().then((m) => ({ default: m.Receive })));
const Activity = lazy(() => screens.activity().then((m) => ({ default: m.Activity })));
const Agents = lazy(() => screens.agents().then((m) => ({ default: m.Agents })));
const Agent = lazy(() => screens.agents().then((m) => ({ default: m.Agent })));
const Research = lazy(() => screens.research().then((m) => ({ default: m.Research })));
const PlanScreen = lazy(() => screens.plan().then((m) => ({ default: m.PlanScreen })));
const Security = lazy(() => screens.security().then((m) => ({ default: m.Security })));
const Settings = lazy(() => screens.settings().then((m) => ({ default: m.Settings })));
const Developer = lazy(() => screens.developer().then((m) => ({ default: m.Developer })));
const Markets = lazy(() => screens.markets().then((m) => ({ default: m.Markets })));
const PrivateMarkets = lazy(() => screens.private().then((m) => ({ default: m.PrivateMarkets })));
const Risk = lazy(() => screens.risk().then((m) => ({ default: m.Risk })));
const Nfts = lazy(() => screens.nft().then((m) => ({ default: m.Nfts })));
const NftDetail = lazy(() => screens.nft().then((m) => ({ default: m.NftDetail })));
const NftCollection = lazy(() => screens.nft().then((m) => ({ default: m.NftCollection })));
/** After the first screen is drawn: the logo set, then the tab-bar screens, one at a time, each when the browser is idle. A failure is silent (the screen asks again when opened). */
let preloaded = false;
function preloadScreens(): void {
  if (preloaded) return; preloaded = true;
  const idle = (f: () => void) => { if (typeof requestIdleCallback === 'function') requestIdleCallback(f, { timeout: 4000 }); else setTimeout(f, 1500); };
  const queue = [async () => { prefetchIcons(); }, screens.swap, screens.send, screens.activity, screens.settings, screens.receive, screens.security, screens.agents, screens.alerts];
  const next = () => { const f = queue.shift(); if (f) idle(() => { void f().catch(() => {}).then(next); }); };
  setTimeout(next, 1200);
}
/** the place of a screen while its chunk arrives: a title and rows, like most screens */
// v11 interface: what the first screen does not need of the shell (risk indicator, desktop sidebar, header menu) is ONE small
// chunk, asked for as soon as the shell mounts — the first chunk stays what it was (shell-more.tsx).
const shellMore = () => import('./shell-more');
const RiskIndicator = lazy(() => shellMore().then((m) => ({ default: m.RiskIndicator })));
const Sidebar = lazy(() => shellMore().then((m) => ({ default: m.Sidebar })));
const ShellMenu = lazy(() => shellMore().then((m) => ({ default: m.ShellMenu })));
const ScreenSkeleton = () => <div className="space-y-4" aria-busy="true"><Skeleton h="h-9" className="!mt-2 !w-44 !rounded-xl" /><SkeletonRows n={5} /></div>;

// Every screen that has a plain path. The order no longer says anything about the navigation (v11: see AREAS below).
const TABS = [['home', '/', 'home'], ['swap', '/swap', 'swap'], ['agents', '/agents', 'key'], ['receive', '/receive', 'down'], ['send', '/send', 'up'], ['activity', '/activity', 'list'], ['security', '/security', 'shield'], ['settings', '/settings', 'gear']] as const;
export type Tab = (typeof TABS)[number][0] | 'asset' | 'assets' | 'agent' | 'futures' | 'alerts' | 'monitor' | 'research' | 'plan' | 'developer' | 'private' | 'markets' | 'risk' | 'nfts' | 'nft' | 'nftc';
// v11 interface (docs/v11/UI-ARCHITECTURE.md) — FIVE areas, the same on the phone's tab bar and in the desktop sidebar. An area
// is not a screen: it is where a screen lives (the tab that stays lit), and its sub-views are listed under the page header.
export { AREAS, type Area };
/** the area a screen belongs to; null for what the header menu opens (settings, security, developer, system status, risk, alerts) */
export const areaOf = (tab: Tab): Area | null => (tab === 'home' || tab === 'assets' || tab === 'asset' || tab === 'receive' || tab === 'send' || tab === 'nfts' || tab === 'nft' || tab === 'nftc' ? 'home' : tab === 'markets' || tab === 'private' ? 'markets'
  : tab === 'swap' || tab === 'futures' || tab === 'plan' ? 'trade' : tab === 'agents' || tab === 'agent' || tab === 'research' ? 'agents' : tab === 'activity' ? 'activity' : null);
/** Trade opens on the sub-view used last (spot by default: the terminal is the largest chunk and is fetched only when asked for) */
const TRADE_KEY = 'spw-trade-view';
const lastTrade = (): 'swap' | 'futures' => { try { return localStorage.getItem(TRADE_KEY) === 'futures' ? 'futures' : 'swap'; } catch { return 'swap'; } };
const areaHome = (a: Area): Tab => (a === 'trade' ? lastTrade() : a);
/** Where to go, with optional pre-selection (asset page, or send/receive pre-filled). */
export interface Route { tab: Tab; network?: string; asset?: string; /** sub-view of a screen (Futures: compare, accounts) */ view?: string }
export type Nav = (r: Route) => void;
export const pathOf = (r: Route): string => r.tab === 'nfts' ? `/nfts${r.view ? `?v=${r.view}` : ''}` : r.tab === 'nft' ? `/nft/${encodeURIComponent(r.asset ?? '')}` : r.tab === 'nftc' ? `/nfts/c/${encodeURIComponent(r.asset ?? '')}` : r.tab === 'risk' ? `/risk${r.asset ? `?mandate=${encodeURIComponent(r.asset)}` : ''}` : r.tab === 'markets' ? `/markets${r.view === 'compare' ? `?v=compare${r.asset ? `&u=${encodeURIComponent(r.asset)}` : ''}` : ''}` : r.tab === 'private' ? `/private-markets${r.asset ? `/${encodeURIComponent(r.asset)}` : ''}${r.view ? `?v=${r.view}` : ''}` : r.tab === 'developer' ? `/developer${r.view ? `?v=${r.view}` : ''}` : r.tab === 'plan' ? `/plan/${r.asset}` : r.tab === 'research' ? `/research${r.asset ? `?job=${r.asset}` : ''}` : r.tab === 'alerts' ? `/alerts${r.view === 'settings' ? '?v=settings' : ''}` : r.tab === 'monitor' ? '/monitor' : r.tab === 'futures' ? `/futures${r.asset ? `/${encodeURIComponent(r.asset)}` : ''}${r.view ? `?v=${r.view}` : ''}` : r.tab === 'agent' ? `/agents/${r.asset}` : (r.tab === 'asset' ? `/asset/${r.network}/${encodeURIComponent(r.asset ?? 'native')}` : r.tab === 'assets' ? '/assets' : TABS.find((x) => x[0] === r.tab)![1]) + (r.tab !== 'asset' && r.network ? `?n=${r.network}${r.asset ? `&a=${encodeURIComponent(r.asset)}` : ''}` : '');
/** v11: paths that name an AREA or an older place — each is answered by the screen that holds it today (the address bar is corrected in place) */
const ALIASES: Record<string, () => Route> = { '/trade': () => ({ tab: lastTrade() }), '/dashboard': () => ({ tab: 'home' }), '/compare': () => ({ tab: 'markets', view: 'compare' }), '/spot': () => ({ tab: 'swap' }), '/perps': () => ({ tab: 'futures' }), '/api': () => ({ tab: 'developer' }), '/system': () => ({ tab: 'monitor' }) };
export function routeOf(): Route {
  const alias = ALIASES[location.pathname.replace(/\/+$/, '') || '/'];
  if (alias) { const r = alias(); history.replaceState(null, '', pathOf(r)); return r; }
  const m = /^\/asset\/([a-z0-9-]+)\/(.+)$/.exec(location.pathname);
  if (m) return { tab: 'asset', network: m[1], asset: decodeURIComponent(m[2]!) };
  if (location.pathname === '/assets') return { tab: 'assets' };
  const ag = /^\/agents\/([0-9a-f-]{36})$/.exec(location.pathname);
  if (ag) return { tab: 'agent', asset: ag[1] };
  const pl = /^\/plan\/([0-9a-f-]{36})$/.exec(location.pathname);   // v7: a plan's progress view
  if (pl) return { tab: 'plan', asset: pl[1] };
  const q = new URLSearchParams(location.search);
  const nf = /^\/(nft|nfts\/c)\/(.+)$/.exec(location.pathname);   // NFT item /nft/<key>, collection /nfts/c/<key>
  if (nf) { try { return { tab: nf[1] === 'nft' ? 'nft' : 'nftc', asset: decodeURIComponent(nf[2]!) }; } catch { return { tab: 'nfts' }; } }
  if (location.pathname === '/nfts') return { tab: 'nfts', view: q.get('v') ?? undefined };
  if (location.pathname === '/alerts') return { tab: 'alerts', view: q.get('v') ?? undefined };   // v6-alerts
  if (location.pathname === '/monitor') return { tab: 'monitor' };
  if (location.pathname === '/markets') return { tab: 'markets', view: q.get('v') ?? undefined, asset: q.get('u') ?? undefined };   // v11 Markets / Compare
  if (location.pathname === '/developer') return { tab: 'developer', view: q.get('v') ?? undefined };   // v11 Developer / API
  if (location.pathname === '/risk') return { tab: 'risk', asset: q.get('mandate') ?? undefined };   // v11 Risk; `?mandate=<id>` opens that mandate
  if (location.pathname === '/research') return { tab: 'research', asset: q.get('job') ?? undefined }; // v7 research runtime
  const pm = /^\/private-markets(?:\/(.+))?$/.exec(location.pathname);   // v11: /private-markets, /private-markets/<venue:symbol>
  if (pm) return { tab: 'private', asset: pm[1] ? decodeURIComponent(pm[1]) : undefined, view: q.get('v') ?? undefined };
  const fu = /^\/futures(?:\/(.+))?$/.exec(location.pathname);   // /futures, /futures/<venue:symbol>
  if (fu) return { tab: 'futures', asset: fu[1] ? decodeURIComponent(fu[1]) : undefined, view: q.get('v') ?? undefined };
  return { tab: TABS.find((t) => t[1] === location.pathname)?.[0] ?? 'home', network: q.get('n') ?? undefined, asset: q.get('a') ?? undefined };
}

export function App() {
  const qc = useQueryClient();
  const [locale, setLocaleState] = useState<Locale>(() => (localStorage.getItem('spw-locale') === 'en' ? 'en' : 'fr'));
  setAmountLocale(locale);   // v8 hardening: before any screen draws (trimAmt and parseInput read it)
  const [route, setRoute] = useState<Route>(routeOf);
  const tab = route.tab;
  const state = useQuery({ queryKey: ['auth'], queryFn: () => get<{ setupRequired: boolean; authenticated: boolean }>('/auth/state'), staleTime: 0 });
  // v10: the other language's texts are a chunk of their own — the change takes effect once they are there (if they cannot be fetched, the screen stays in the current language)
  const setLocale = useCallback((l: Locale) => { void loadLocale(l).then(() => { localStorage.setItem('spw-locale', l); document.documentElement.lang = l; setLocaleState(l); }, () => {}); }, []);
  const nav = useCallback<Nav>((r) => { history.pushState(null, '', pathOf(r)); setRoute(r); window.scrollTo(0, 0); }, []);
  const go = useCallback((t: Tab) => nav({ tab: t }), [nav]);
  // v6-alerts: open an in-app path (a tapped alert or notification)
  const openPath = useCallback((path: string) => { history.pushState(null, '', path); setRoute(routeOf()); window.scrollTo(0, 0); }, []);
  useEffect(() => { const f = () => setRoute(routeOf()); addEventListener('popstate', f); return () => removeEventListener('popstate', f); }, []);
  useEffect(() => { setUnauthHandler(() => { dispatchEvent(new Event('spw-session-end')); qc.clear(); void qc.invalidateQueries({ queryKey: ['auth'] }); }); }, [qc]);   // v11: the live-quote socket stops knocking once the session is gone (quotes.ts)
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  // lock when the app has been in the background for a while (server also enforces a 30-minute idle timeout)
  useEffect(() => { const f = () => { if (document.visibilityState === 'visible') void qc.invalidateQueries({ queryKey: ['auth'] }); }; document.addEventListener('visibilitychange', f); return () => document.removeEventListener('visibilitychange', f); }, [qc]);

  let body;
  if (state.isLoading) body = <div className="grid h-full place-items-center text-mute" role="status" aria-label="SP Wallet"><div className="flex flex-col items-center gap-5"><img src="/icon.svg" alt="" width={64} height={64} className="h-16 w-16 rounded-[20px] shadow-e2" /><Icon n="spin" className="h-5 w-5" /></div></div>;
  else if (state.isError || !state.data) body = <Offline retry={() => void state.refetch()} />;
  else if (!state.data.authenticated) body = <Gate setup={state.data.setupRequired} onDone={() => void state.refetch()} />;
  else body = <Shell tab={tab} route={route} nav={nav} go={go} openPath={openPath} locale={locale} lock={async () => { dispatchEvent(new Event('spw-session-end')); await post('/auth/logout').catch(() => {}); qc.clear(); void state.refetch(); }} />;
  return <I18n.Provider value={{ locale, setLocale }}>{body}</I18n.Provider>;
}

function Offline({ retry }: { retry: () => void }) {
  const t = useT();
  return <div className="safe-t safe-b mx-auto grid h-full max-w-sm place-items-center px-6"><div className="rise w-full"><EmptyState icon="cloudOff" title={t('offline')} action={<Btn kind="soft" onClick={retry}><Icon n="refresh" className="h-4 w-4" />{t('retry')}</Btn>}>{t('dsOfflineBody')}</EmptyState></div></div>;
}

function Shell({ tab, route, nav, go, lock, openPath, locale }: { tab: Tab; route: Route; nav: Nav; go: (t: Tab) => void; lock: () => void; openPath: (path: string) => void; locale: Locale }) {
  const t = useT(); const qc = useQueryClient();
  const unread = useUnread(); useAlertsRuntime(locale, openPath); // v6-alerts
  // v9: the phone header condenses once the page scrolls (an attribute, not a re-render); pull down on Home/Activity refreshes
  const header = useRef<HTMLElement>(null);
  // v10: large-title collapse — once the page's large title (PageTitle's <h1>) has scrolled under the header, the header carries it
  // in small (iOS style). Read in the same rAF as the scroll flag; one attribute and one text node, no re-render.
  const mini = useRef<HTMLSpanElement>(null);
  useEffect(() => { let raf = 0; const f = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { const h = header.current; if (!h) return; h.toggleAttribute('data-scrolled', scrollY > 6);
    const h1 = scrollY > 6 ? document.querySelector<HTMLElement>('main h1.t-title') : null, gone = !!h1 && h1.getBoundingClientRect().bottom < h.getBoundingClientRect().bottom + 2;
    if (gone && mini.current && mini.current.textContent !== h1!.textContent) mini.current.textContent = h1!.textContent;
    h.toggleAttribute('data-titled', gone); }); }; f(); addEventListener('scroll', f, { passive: true }); return () => { removeEventListener('scroll', f); cancelAnimationFrame(raf); }; }, [tab]);
  useEffect(() => { preloadScreens(); }, []);   // v10: the other screens' chunks, once this one is drawn and the browser is idle
  const ptr = usePullToRefresh(tab === 'home' || tab === 'activity', () => qc.invalidateQueries());
  const area = areaOf(tab);
  useEffect(() => { if (tab === 'swap' || tab === 'futures') { try { localStorage.setItem(TRADE_KEY, tab); } catch { /* private mode */ } } }, [tab]);   // Trade reopens where it was left
  const [menu, setMenu] = useState(false);
  const toArea = (a: Area) => { const to = areaHome(a); if (tab !== to || route.asset || route.view || route.network) go(to); else window.scrollTo({ top: 0 }); };
  const bell = (cls: string) => <button onClick={() => go('alerts')} data-testid="alerts-bell" aria-label={`${t('alBell')}${unread.unread ? ` (${unread.unread})` : ''}`} aria-current={tab === 'alerts' ? 'page' : undefined} className={cls}>
    <span className="relative"><Icon n="bell" />{unread.unread > 0 && <span data-testid="alerts-badge" className={`absolute -right-2 -top-2 grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[10.5px] font-bold leading-none text-white ${unread.critical ? 'bg-danger' : 'bg-blue'}`}>{unread.unread > 99 ? '99+' : unread.unread}</span>}</span>{cls.includes('w-full') && t('alTitle')}</button>;
  const sideCls = 'press flex w-full items-center gap-3 rounded-2xl px-3.5 py-2.5 text-[15px] font-medium';
  // the sub-views of an area, under the header: one row, never wrapping (it scrolls sideways if a translation is long)
  const SUB: Partial<Record<Area, readonly (readonly [string, Key, Route, boolean])[]>> = {
    markets: [['explorer', 'mkViewExplorer', { tab: 'markets' }, tab === 'markets' && route.view !== 'compare'], ['compare', 'mkViewCompare', { tab: 'markets', view: 'compare', asset: tab === 'markets' ? route.asset : undefined }, tab === 'markets' && route.view === 'compare'], ['private', 'pmTab', { tab: 'private' }, tab === 'private']],
    trade: [['swap', 'fxSpot', { tab: 'swap' }, tab === 'swap'], ['futures', 'fxFutures', { tab: 'futures' }, tab === 'futures']],
  };
  const sub = area && tab !== 'plan' ? SUB[area] : undefined;
  const wide = tab === 'futures' || tab === 'markets';
  // the width of the page: forms stay a narrow column; lists, dashboards and operations pages use the desktop's width
  const width = wide ? `max-w-none ${tab === 'futures' ? 'lg:pt-6' : 'lg:pt-8'}` : `lg:pt-10 max-w-xl ${tab === 'home' ? 'lg:max-w-5xl' : tab === 'activity' || tab === 'agents' || tab === 'agent' || tab === 'research' || tab === 'monitor' || tab === 'private' || tab === 'risk' || tab === 'developer' || tab === 'alerts' || tab === 'nfts' || tab === 'nft' || tab === 'nftc' ? 'lg:max-w-4xl' : 'lg:max-w-2xl'}`;
  return (
    <div className={`safe-x mx-auto flex min-h-full ${tab === 'futures' ? 'max-w-[1680px]' : 'max-w-7xl'}`}>{ptr}
      <a href="#main" className="absolute left-0 top-0 h-0 w-0 overflow-hidden focus:fixed focus:left-3 focus:top-3 focus:z-40 focus:h-auto focus:min-h-11 focus:w-auto focus:rounded-xl focus:bg-surface focus:px-4 focus:py-3 focus:shadow-e2">{t('v11NavSkip')}</a>
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col overflow-y-auto p-5 lg:flex">
        <div className="mb-7 flex items-center gap-3 px-2 pt-2"><img src="/icon.svg" alt="" width={36} height={36} className="h-9 w-9 rounded-xl shadow-e1" /><span className="text-[19px] font-semibold tracking-[-0.02em]">SP Wallet</span></div>
        <Suspense fallback={null}><Sidebar tab={tab} area={area} go={go} toArea={toArea} lock={lock} bell={bell(`${sideCls} ${tab === 'alerts' ? 'bg-primary text-onprimary shadow-e1' : 'text-mute hover:bg-elev hover:text-ink'}`)} /></Suspense>
      </aside>
      <div className="min-w-0 flex-1">
        <header ref={header} className="app-header safe-t nav-glass sticky top-0 z-10 lg:hidden">
          <div className="app-header-row flex items-center justify-between gap-1 px-5 py-2.5">
            <div className="app-brand flex min-w-0 items-center gap-2.5"><img src="/icon.svg" alt="" width={32} height={32} className="h-8 w-8 shrink-0 rounded-[10px]" /><span className="app-brand-name truncate text-[17px] font-semibold tracking-[-0.02em] max-[359px]:hidden">SP Wallet</span></div>
            <span ref={mini} className="app-mini-title" aria-hidden="true" data-testid="mini-title" />
            <div className="flex shrink-0 items-center gap-0.5">
              <Suspense fallback={<span className="mx-0.5 h-8 w-[68px] rounded-full bg-elev" aria-hidden="true" />}><RiskIndicator go={go} current={tab === 'risk'} /></Suspense>
              {bell(`grid h-11 w-11 place-items-center rounded-full ${tab === 'alerts' ? 'bg-elev text-ink' : 'text-mute'}`)}
              <button onClick={() => setMenu(true)} data-testid="nav-menu" aria-label={t('v11NavMenu')} aria-haspopup="dialog" aria-expanded={menu} className={`grid h-11 w-11 place-items-center rounded-full ${area === null && tab !== 'alerts' && tab !== 'risk' ? 'bg-elev text-ink' : 'text-mute'}`}><Icon n="list" /></button>
            </div>
          </div>
        </header>
        <main id="main" tabIndex={-1} key={tab === 'futures' || tab === 'markets' ? tab : tab + (route.network ?? '') + (route.asset ?? '')} className={`rise mx-auto w-full px-5 pb-[calc(env(safe-area-inset-bottom)+7rem)] pt-2 outline-none lg:pb-12 ${width}`}>
          {sub && <div role="tablist" aria-label={t(area === 'trade' ? 'fxTradeArea' : 'mkTab')} data-testid="nav-sub" className={`no-scrollbar mb-3 mt-1 flex gap-1 overflow-x-auto rounded-2xl bg-elev p-1 ${wide || tab === 'private' ? 'max-w-xl' : ''}`}>{sub.map(([id, k, to, on]) =>
            <button key={id} role="tab" aria-selected={on} data-sub={id} onClick={() => { if (!on) nav(to); }} className={`min-h-11 flex-1 whitespace-nowrap rounded-xl px-2 text-[13px] font-semibold transition min-[380px]:px-3 min-[380px]:text-[14px] ${on ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(15,23,42,0.12)]' : 'text-mute hover:text-ink'}`}>{t(k)}</button>)}</div>}
          {tab === 'home' && <Home go={go} nav={nav} />}
          {tab === 'assets' && <Assets nav={nav} />}
          {tab === 'asset' && <Asset network={route.network ?? ''} asset={route.asset ?? 'native'} nav={nav} />}
          <Suspense fallback={<ScreenSkeleton />}>
          {tab === 'receive' && <Receive initial={route.network} />}
          {tab === 'send' && <Send go={go} initial={route} />}
          {tab === 'swap' && <Swap />}
          {tab === 'futures' && <Suspense fallback={<Skeleton h="h-72" />}><Futures instrument={route.asset} view={(['compare', 'accounts', 'router'].includes(route.view ?? '') ? route.view : 'terminal') as FuturesView} nav={nav} /></Suspense>}
          {tab === 'agents' && <Agents nav={nav} />}
          {tab === 'agent' && <Agent id={route.asset ?? ''} nav={nav} />}
          {tab === 'activity' && <Activity />}
          {tab === 'plan' && <PlanScreen id={route.asset ?? ''} />}
          {tab === 'security' && <Security />}
          {tab === 'settings' && <Settings lock={lock} go={go} />}
          {tab === 'developer' && <Developer view={route.view} setView={(v) => nav({ tab: 'developer', view: v === 'keys' ? undefined : v })} onBack={() => go('settings')} />}{/* v11 Developer / API */}
          {tab === 'markets' && <Markets view={route.view === 'compare' ? 'compare' : 'explorer'} underlying={route.asset} nav={nav} />}{/* v11 Markets / Compare */}
          {tab === 'risk' && <Risk onBack={() => go('settings')} mandate={route.asset} />}{/* v11 Risk; `/risk?mandate=<id>` */}
          {tab === 'research' && <Research nav={nav} job={route.asset} />}{/* v7 research runtime */}
          {tab === 'private' && <PrivateMarkets instrument={route.asset} view={route.view} nav={nav} />}{/* v11 private markets: display only */}
          {tab === 'nfts' && <Nfts nav={nav} view={route.view} />}{tab === 'nft' && <NftDetail id={route.asset ?? ''} nav={nav} />}{tab === 'nftc' && <NftCollection id={route.asset ?? ''} nav={nav} />}{/* NFT: read-only */}
          </Suspense>
          {tab === 'alerts' && <Suspense fallback={<Skeleton h="h-72" />}><Alerts view={route.view === 'settings' ? 'settings' : 'list'} open={openPath} setView={(v) => nav({ tab: 'alerts', view: v === 'settings' ? 'settings' : undefined })} /></Suspense>}
          {tab === 'monitor' && <Suspense fallback={<Skeleton h="h-72" />}><Monitor open={openPath} /></Suspense>}
        </main>
        <nav aria-label={t('v11NavMain')} data-testid="nav-tabbar" className="tabbar safe-b nav-glass fixed inset-x-0 bottom-0 z-10 lg:hidden">
          <div className="mx-auto flex max-w-xl items-end px-1 pt-1.5">{AREAS.map(([id, icon, label]) => { const on = area === id; return (
            <button key={id} onClick={() => { haptic(); toArea(id); }} data-area={id} aria-current={on ? 'page' : undefined} className={`press relative flex min-h-[52px] min-w-0 flex-1 flex-col items-center justify-center gap-1 text-[11px] ${on ? 'font-semibold text-ink' : 'font-medium text-mute'}`}>
              <span className={`grid h-7 w-12 place-items-center rounded-full transition-colors ${on ? 'bg-elev' : ''}`}><Icon n={icon} className="h-[22px] w-[22px]" /></span><span className="max-w-full truncate px-0.5">{t(label)}</span></button>); })}</div>
        </nav>
        {menu && <Suspense fallback={null}><ShellMenu tab={tab} go={go} lock={lock} onClose={() => setMenu(false)} /></Suspense>}
      </div>
    </div>
  );
}
