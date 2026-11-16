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
const ScreenSkeleton = () => <div className="space-y-4" aria-busy="true"><Skeleton h="h-9" className="!mt-2 !w-44 !rounded-xl" /><SkeletonRows n={5} /></div>;

const TABS = [['home', '/', 'home'], ['swap', '/swap', 'swap'], ['agents', '/agents', 'key'], ['receive', '/receive', 'down'], ['send', '/send', 'up'], ['activity', '/activity', 'list'], ['security', '/security', 'shield'], ['settings', '/settings', 'gear']] as const;
export type Tab = (typeof TABS)[number][0] | 'asset' | 'assets' | 'agent' | 'futures' | 'alerts' | 'monitor' | 'research' | 'plan' | 'developer' | 'markets';
/** Where to go, with optional pre-selection (asset page, or send/receive pre-filled). */
export interface Route { tab: Tab; network?: string; asset?: string; /** sub-view of a screen (Futures: compare, accounts) */ view?: string }
export type Nav = (r: Route) => void;
const pathOf = (r: Route) => r.tab === 'markets' ? `/markets${r.view === 'compare' ? `?v=compare${r.asset ? `&u=${encodeURIComponent(r.asset)}` : ''}` : ''}` : r.tab === 'developer' ? `/developer${r.view ? `?v=${r.view}` : ''}` : r.tab === 'plan' ? `/plan/${r.asset}` : r.tab === 'research' ? `/research${r.asset ? `?job=${r.asset}` : ''}` : r.tab === 'alerts' ? `/alerts${r.view === 'settings' ? '?v=settings' : ''}` : r.tab === 'monitor' ? '/monitor' : r.tab === 'futures' ? `/futures${r.asset ? `/${encodeURIComponent(r.asset)}` : ''}${r.view ? `?v=${r.view}` : ''}` : r.tab === 'agent' ? `/agents/${r.asset}` : (r.tab === 'asset' ? `/asset/${r.network}/${encodeURIComponent(r.asset ?? 'native')}` : r.tab === 'assets' ? '/assets' : TABS.find((x) => x[0] === r.tab)![1]) + (r.tab !== 'asset' && r.network ? `?n=${r.network}${r.asset ? `&a=${encodeURIComponent(r.asset)}` : ''}` : '');
function routeOf(): Route {
  const m = /^\/asset\/([a-z0-9-]+)\/(.+)$/.exec(location.pathname);
  if (m) return { tab: 'asset', network: m[1], asset: decodeURIComponent(m[2]!) };
  if (location.pathname === '/assets') return { tab: 'assets' };
  const ag = /^\/agents\/([0-9a-f-]{36})$/.exec(location.pathname);
  if (ag) return { tab: 'agent', asset: ag[1] };
  const pl = /^\/plan\/([0-9a-f-]{36})$/.exec(location.pathname);   // v7: a plan's progress view
  if (pl) return { tab: 'plan', asset: pl[1] };
  const q = new URLSearchParams(location.search);
  if (location.pathname === '/alerts') return { tab: 'alerts', view: q.get('v') ?? undefined };   // v6-alerts
  if (location.pathname === '/monitor') return { tab: 'monitor' };
  if (location.pathname === '/markets') return { tab: 'markets', view: q.get('v') ?? undefined, asset: q.get('u') ?? undefined };   // v11 Markets / Compare
  if (location.pathname === '/developer') return { tab: 'developer', view: q.get('v') ?? undefined };   // v11 Developer / API
  if (location.pathname === '/research') return { tab: 'research', asset: q.get('job') ?? undefined }; // v7 research runtime
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
  useEffect(() => { setUnauthHandler(() => { qc.clear(); void qc.invalidateQueries({ queryKey: ['auth'] }); }); }, [qc]);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  // lock when the app has been in the background for a while (server also enforces a 30-minute idle timeout)
  useEffect(() => { const f = () => { if (document.visibilityState === 'visible') void qc.invalidateQueries({ queryKey: ['auth'] }); }; document.addEventListener('visibilitychange', f); return () => document.removeEventListener('visibilitychange', f); }, [qc]);

  let body;
  if (state.isLoading) body = <div className="grid h-full place-items-center text-mute" role="status" aria-label="SP Wallet"><div className="flex flex-col items-center gap-5"><img src="/icon.svg" alt="" width={64} height={64} className="h-16 w-16 rounded-[20px] shadow-e2" /><Icon n="spin" className="h-5 w-5" /></div></div>;
  else if (state.isError || !state.data) body = <Offline retry={() => void state.refetch()} />;
  else if (!state.data.authenticated) body = <Gate setup={state.data.setupRequired} onDone={() => void state.refetch()} />;
  else body = <Shell tab={tab} route={route} nav={nav} go={go} openPath={openPath} locale={locale} lock={async () => { await post('/auth/logout').catch(() => {}); qc.clear(); void state.refetch(); }} />;
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
  const bell = (cls: string) => <button onClick={() => go('alerts')} data-testid="alerts-bell" aria-label={`${t('alBell')}${unread.unread ? ` (${unread.unread})` : ''}`} aria-current={tab === 'alerts' ? 'page' : undefined} className={cls}>
    <span className="relative"><Icon n="bell" />{unread.unread > 0 && <span data-testid="alerts-badge" className={`absolute -right-2 -top-2 grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[10.5px] font-bold leading-none text-white ${unread.critical ? 'bg-danger' : 'bg-blue'}`}>{unread.unread > 99 ? '99+' : unread.unread}</span>}</span>{cls.includes('w-full') && t('alTitle')}</button>;
  const MOBILE: [Tab, string][] = [['home', 'home'], ['swap', 'swap'], ['send', 'up'], ['activity', 'list'], ['settings', 'gear']];
  const trade = tab === 'swap' || tab === 'futures' || tab === 'markets';   // Futures and Markets (v11) live inside the trade area: the five phone tabs stay as they are
  const side = (id: Tab, icon: string, label: Key = id as Key) => { const on = tab === id || (id === 'swap' && tab === 'futures'); return (   // v11: Markets has its own sidebar entry (label `mkTitle`)
    <button key={id} onClick={() => go(id)} aria-current={on ? 'page' : undefined} className={`press flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-[15px] font-medium ${on ? 'bg-primary text-onprimary shadow-e1' : 'text-mute hover:bg-elev hover:text-ink'}`}><Icon n={icon} />{t(label)}</button>); };
  return (
    <div className={`safe-x mx-auto flex min-h-full ${tab === 'futures' ? 'max-w-[1680px]' : 'max-w-6xl'}`}>{ptr}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col p-5 lg:flex">
        <div className="mb-8 flex items-center gap-3 px-2 pt-2"><img src="/icon.svg" alt="" width={36} height={36} className="h-9 w-9 rounded-xl shadow-e1" /><span className="text-[19px] font-semibold tracking-[-0.02em]">SP Wallet</span></div>
        <nav className="space-y-1.5" aria-label="Navigation">{TABS.map(([id, , icon]) => side(id, icon))}{side('markets', 'chart', 'mkTitle')}</nav>
        <div className="mt-auto space-y-1.5">{/* v6-alerts */}
          {bell(`flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-[15px] font-medium transition ${tab === 'alerts' ? 'bg-primary text-onprimary' : 'text-mute hover:bg-elev hover:text-ink'}`)}
          <button onClick={() => go('monitor')} aria-current={tab === 'monitor' ? 'page' : undefined} className={`flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-[15px] font-medium transition ${tab === 'monitor' ? 'bg-primary text-onprimary' : 'text-mute hover:bg-elev hover:text-ink'}`}><Icon n="bars" />{t('moTitle')}</button>
          <button onClick={lock} className="flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-[15px] font-medium text-mute hover:bg-elev hover:text-ink"><Icon n="lock" />{t('logout')}</button>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header ref={header} className="app-header safe-t nav-glass sticky top-0 z-10 lg:hidden">
          <div className="app-header-row flex items-center justify-between px-5 py-2.5">
            <div className="app-brand flex items-center gap-2.5"><img src="/icon.svg" alt="" width={32} height={32} className="h-8 w-8 rounded-[10px]" /><span className="app-brand-name text-[17px] font-semibold tracking-[-0.02em]">SP Wallet</span></div>
            <span ref={mini} className="app-mini-title" aria-hidden="true" data-testid="mini-title" />
            <div className="flex items-center gap-1">
              {bell(`grid h-11 w-11 place-items-center rounded-full ${tab === 'alerts' ? 'bg-elev text-ink' : 'text-mute'}`)}
              <button onClick={() => go('security')} aria-label={t('security')} aria-current={tab === 'security' ? 'page' : undefined} className={`grid h-11 w-11 place-items-center rounded-full ${tab === 'security' ? 'bg-elev text-ink' : 'text-mute'}`}><Icon n="shield" /></button>
              <button onClick={lock} aria-label={t('logout')} className="grid h-11 w-11 place-items-center rounded-full text-mute"><Icon n="lock" /></button>
            </div>
          </div>
        </header>
        <main key={tab === 'futures' || tab === 'markets' ? tab : tab + (route.network ?? '') + (route.asset ?? '')} className={`rise mx-auto w-full px-5 pb-[calc(env(safe-area-inset-bottom)+8rem)] pt-2 lg:pb-12 ${tab === 'futures' ? 'max-w-none lg:pt-6' : tab === 'markets' ? 'max-w-none lg:pt-8' : 'max-w-xl lg:max-w-2xl lg:pt-10'}`}>
          {trade && <div role="tablist" aria-label={t('fxTradeArea')} className={`mb-3 mt-1 flex gap-1 rounded-2xl bg-elev p-1 ${tab === 'futures' || tab === 'markets' ? 'max-w-md' : ''}`}>{([['swap', 'fxSpot'], ['futures', 'fxFutures'], ['markets', 'mkTab']] as const).map(([id, k]) =>
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => { if (tab !== id) go(id); }} className={`min-h-11 flex-1 rounded-xl px-3 text-[14px] font-semibold transition ${tab === id ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(15,23,42,0.12)]' : 'text-mute hover:text-ink'}`}>{t(k)}</button>)}</div>}
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
          {tab === 'research' && <Research nav={nav} job={route.asset} />}{/* v7 research runtime */}
          </Suspense>
          {tab === 'alerts' && <Suspense fallback={<Skeleton h="h-72" />}><Alerts view={route.view === 'settings' ? 'settings' : 'list'} open={openPath} setView={(v) => nav({ tab: 'alerts', view: v === 'settings' ? 'settings' : undefined })} /></Suspense>}
          {tab === 'monitor' && <Suspense fallback={<Skeleton h="h-72" />}><Monitor open={openPath} /></Suspense>}
        </main>
        <nav aria-label="Navigation" className="tabbar safe-b nav-glass fixed inset-x-0 bottom-0 z-10 lg:hidden">
          <div className="mx-auto flex max-w-xl items-end px-2 pt-1.5">{MOBILE.map(([id, icon]) => { const on = tab === id || (id === 'home' && (tab === 'asset' || tab === 'assets')) || (id === 'swap' && (tab === 'futures' || tab === 'markets'));
            return id === 'send'
              ? <button key={id} onClick={() => { haptic(); go(id); }} aria-current={on ? 'page' : undefined} aria-label={t('send')} className="flex flex-1 flex-col items-center gap-1 text-[11px] font-semibold text-ink">
                  <span className="tab-fab -mt-6 grid h-[56px] w-[56px] place-items-center rounded-full bg-primary text-onprimary ring-4 ring-bg"><Icon n="up" className="h-6 w-6" /></span><span>{t('send')}</span></button>
              : <button key={id} onClick={() => { haptic(); go(id); }} aria-current={on ? 'page' : undefined} className={`press relative flex min-h-[52px] flex-1 flex-col items-center justify-center gap-1 text-[11px] ${on ? 'font-semibold text-ink' : 'font-medium text-mute'}`}>
                  <span className={`grid h-7 w-12 place-items-center rounded-full transition-colors ${on ? 'bg-elev' : ''}`}><Icon n={icon} className="h-[22px] w-[22px]" /></span><span>{t(id as Key)}</span></button>; })}</div>
        </nav>
      </div>
    </div>
  );
}
