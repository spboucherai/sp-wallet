import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { get, post, setUnauthHandler } from './api';
import { I18n, useT, type Key, type Locale } from './i18n';
import { Activity } from './screens/Activity';
import { Agent, Agents } from './screens/Agents';
import { Asset } from './screens/Asset';
import { Assets } from './screens/Assets';
import type { FuturesView } from './screens/Futures';
import { Gate } from './screens/Gate';
import { Home } from './screens/Home';
import { Receive } from './screens/Receive';
import { Security } from './screens/Security';
import { Send } from './screens/Send';
import { Settings } from './screens/Settings';
import { Swap } from './screens/Swap';
import { Btn, Icon, Notice, Skeleton } from './ui';

// the Futures terminal is its own chunk: the wallet's first load does not pay for it
const Futures = lazy(() => import('./screens/Futures').then((m) => ({ default: m.Futures })));

const TABS = [['home', '/', 'home'], ['swap', '/swap', 'swap'], ['agents', '/agents', 'key'], ['receive', '/receive', 'down'], ['send', '/send', 'up'], ['activity', '/activity', 'list'], ['security', '/security', 'shield'], ['settings', '/settings', 'gear']] as const;
export type Tab = (typeof TABS)[number][0] | 'asset' | 'assets' | 'agent' | 'futures';
/** Where to go, with optional pre-selection (asset page, or send/receive pre-filled). */
export interface Route { tab: Tab; network?: string; asset?: string; /** sub-view of a screen (Futures: compare, accounts) */ view?: string }
export type Nav = (r: Route) => void;
const pathOf = (r: Route) => r.tab === 'futures' ? `/futures${r.asset ? `/${encodeURIComponent(r.asset)}` : ''}${r.view ? `?v=${r.view}` : ''}` : r.tab === 'agent' ? `/agents/${r.asset}` : (r.tab === 'asset' ? `/asset/${r.network}/${encodeURIComponent(r.asset ?? 'native')}` : r.tab === 'assets' ? '/assets' : TABS.find((x) => x[0] === r.tab)![1]) + (r.tab !== 'asset' && r.network ? `?n=${r.network}${r.asset ? `&a=${encodeURIComponent(r.asset)}` : ''}` : '');
function routeOf(): Route {
  const m = /^\/asset\/([a-z0-9-]+)\/(.+)$/.exec(location.pathname);
  if (m) return { tab: 'asset', network: m[1], asset: decodeURIComponent(m[2]!) };
  if (location.pathname === '/assets') return { tab: 'assets' };
  const ag = /^\/agents\/([0-9a-f-]{36})$/.exec(location.pathname);
  if (ag) return { tab: 'agent', asset: ag[1] };
  const q = new URLSearchParams(location.search);
  const fu = /^\/futures(?:\/(.+))?$/.exec(location.pathname);   // /futures, /futures/<venue:symbol>
  if (fu) return { tab: 'futures', asset: fu[1] ? decodeURIComponent(fu[1]) : undefined, view: q.get('v') ?? undefined };
  return { tab: TABS.find((t) => t[1] === location.pathname)?.[0] ?? 'home', network: q.get('n') ?? undefined, asset: q.get('a') ?? undefined };
}

export function App() {
  const qc = useQueryClient();
  const [locale, setLocaleState] = useState<Locale>(() => (localStorage.getItem('spw-locale') === 'en' ? 'en' : 'fr'));
  const [route, setRoute] = useState<Route>(routeOf);
  const tab = route.tab;
  const state = useQuery({ queryKey: ['auth'], queryFn: () => get<{ setupRequired: boolean; authenticated: boolean }>('/auth/state'), staleTime: 0 });
  const setLocale = useCallback((l: Locale) => { localStorage.setItem('spw-locale', l); document.documentElement.lang = l; setLocaleState(l); }, []);
  const nav = useCallback<Nav>((r) => { history.pushState(null, '', pathOf(r)); setRoute(r); window.scrollTo(0, 0); }, []);
  const go = useCallback((t: Tab) => nav({ tab: t }), [nav]);
  useEffect(() => { const f = () => setRoute(routeOf()); addEventListener('popstate', f); return () => removeEventListener('popstate', f); }, []);
  useEffect(() => { setUnauthHandler(() => { qc.clear(); void qc.invalidateQueries({ queryKey: ['auth'] }); }); }, [qc]);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  // lock when the app has been in the background for a while (server also enforces a 30-minute idle timeout)
  useEffect(() => { const f = () => { if (document.visibilityState === 'visible') void qc.invalidateQueries({ queryKey: ['auth'] }); }; document.addEventListener('visibilitychange', f); return () => document.removeEventListener('visibilitychange', f); }, [qc]);

  let body;
  if (state.isLoading) body = <div className="grid h-full place-items-center text-mute"><Icon n="spin" className="h-6 w-6" /></div>;
  else if (state.isError || !state.data) body = <Offline retry={() => void state.refetch()} />;
  else if (!state.data.authenticated) body = <Gate setup={state.data.setupRequired} onDone={() => void state.refetch()} />;
  else body = <Shell tab={tab} route={route} nav={nav} go={go} lock={async () => { await post('/auth/logout').catch(() => {}); qc.clear(); void state.refetch(); }} />;
  return <I18n.Provider value={{ locale, setLocale }}>{body}</I18n.Provider>;
}

function Offline({ retry }: { retry: () => void }) {
  const t = useT();
  return <div className="mx-auto grid h-full max-w-sm place-items-center px-6"><div className="w-full space-y-4"><Notice tone="warn">{t('offline')}</Notice><Btn full kind="soft" onClick={retry}>{t('retry')}</Btn></div></div>;
}

function Shell({ tab, route, nav, go, lock }: { tab: Tab; route: Route; nav: Nav; go: (t: Tab) => void; lock: () => void }) {
  const t = useT();
  const MOBILE: [Tab, string][] = [['home', 'home'], ['swap', 'swap'], ['send', 'up'], ['activity', 'list'], ['settings', 'gear']];
  const trade = tab === 'swap' || tab === 'futures';   // Futures lives inside the trade area: the five phone tabs stay as they are
  const side = (id: Tab, icon: string) => { const on = tab === id || (id === 'swap' && tab === 'futures'); return (
    <button key={id} onClick={() => go(id)} aria-current={on ? 'page' : undefined} className={`flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-[15px] font-medium transition ${on ? 'bg-primary text-onprimary' : 'text-mute hover:bg-elev hover:text-ink'}`}><Icon n={icon} />{t(id as Key)}</button>); };
  return (
    <div className={`mx-auto flex min-h-full ${tab === 'futures' ? 'max-w-[1680px]' : 'max-w-6xl'}`}>
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col p-5 lg:flex">
        <div className="mb-8 flex items-center gap-3 px-2 pt-2"><img src="/icon.svg" alt="" className="h-9 w-9 rounded-xl" /><span className="text-[19px] font-semibold tracking-tight">SP Wallet</span></div>
        <nav className="space-y-1.5" aria-label="Navigation">{TABS.map(([id, , icon]) => side(id, icon))}</nav>
        <button onClick={lock} className="mt-auto flex items-center gap-3 rounded-2xl px-3.5 py-3 text-[15px] font-medium text-mute hover:bg-elev hover:text-ink"><Icon n="lock" />{t('logout')}</button>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="safe-t nav-glass sticky top-0 z-10 lg:hidden">
          <div className="flex items-center justify-between px-5 py-3">
            <div className="flex items-center gap-2.5"><img src="/icon.svg" alt="" className="h-8 w-8 rounded-[10px]" /><span className="text-[17px] font-semibold tracking-tight">SP Wallet</span></div>
            <div className="flex items-center gap-1">
              <button onClick={() => go('security')} aria-label={t('security')} aria-current={tab === 'security' ? 'page' : undefined} className={`grid h-11 w-11 place-items-center rounded-full ${tab === 'security' ? 'bg-elev text-ink' : 'text-mute'}`}><Icon n="shield" /></button>
              <button onClick={lock} aria-label={t('logout')} className="grid h-11 w-11 place-items-center rounded-full text-mute"><Icon n="lock" /></button>
            </div>
          </div>
        </header>
        <main key={tab === 'futures' ? 'futures' : tab + (route.network ?? '') + (route.asset ?? '')} className={`rise mx-auto w-full px-5 pb-32 pt-3 lg:pb-12 ${tab === 'futures' ? 'max-w-none lg:pt-6' : 'max-w-xl lg:max-w-2xl lg:pt-10'}`}>
          {trade && <div role="tablist" aria-label={t('fxTradeArea')} className={`mb-3 flex gap-1 rounded-2xl bg-elev p-1 ${tab === 'futures' ? 'max-w-sm' : ''}`}>{([['swap', 'fxSpot'], ['futures', 'fxFutures']] as const).map(([id, k]) =>
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => { if (tab !== id) go(id); }} className={`min-h-11 flex-1 rounded-xl px-3 text-[14px] font-semibold transition ${tab === id ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(15,23,42,0.12)]' : 'text-mute hover:text-ink'}`}>{t(k)}</button>)}</div>}
          {tab === 'home' && <Home go={go} nav={nav} />}
          {tab === 'assets' && <Assets nav={nav} />}
          {tab === 'asset' && <Asset network={route.network ?? ''} asset={route.asset ?? 'native'} nav={nav} />}
          {tab === 'receive' && <Receive initial={route.network} />}
          {tab === 'send' && <Send go={go} initial={route} />}
          {tab === 'swap' && <Swap />}
          {tab === 'futures' && <Suspense fallback={<Skeleton h="h-72" />}><Futures instrument={route.asset} view={(['compare', 'accounts'].includes(route.view ?? '') ? route.view : 'terminal') as FuturesView} nav={nav} /></Suspense>}
          {tab === 'agents' && <Agents nav={nav} />}
          {tab === 'agent' && <Agent id={route.asset ?? ''} nav={nav} />}
          {tab === 'activity' && <Activity />}
          {tab === 'security' && <Security />}
          {tab === 'settings' && <Settings lock={lock} go={go} />}
        </main>
        <nav aria-label="Navigation" className="safe-b nav-glass fixed inset-x-0 bottom-0 z-10 border-t border-line lg:hidden">
          <div className="mx-auto flex max-w-xl items-end px-2 pt-2">{MOBILE.map(([id, icon]) => { const on = tab === id || (id === 'home' && (tab === 'asset' || tab === 'assets')) || (id === 'swap' && tab === 'futures');
            return id === 'send'
              ? <button key={id} onClick={() => go(id)} aria-current={on ? 'page' : undefined} aria-label={t('send')} className="flex flex-1 flex-col items-center gap-1 text-[11px] font-medium text-ink">
                  <span className="-mt-5 grid h-[52px] w-[52px] place-items-center rounded-full bg-primary text-onprimary shadow-[0_10px_24px_-8px_rgba(11,16,32,0.55)]"><Icon n="up" className="h-6 w-6" /></span><span>{t('send')}</span></button>
              : <button key={id} onClick={() => go(id)} aria-current={on ? 'page' : undefined} className={`flex min-h-[50px] flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium ${on ? 'text-ink' : 'text-mute'}`}>
                  <Icon n={icon} className="h-6 w-6" /><span>{t(id as Key)}</span></button>; })}</div>
        </nav>
      </div>
    </div>
  );
}
