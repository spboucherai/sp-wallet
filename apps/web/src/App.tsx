import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { get, post, setUnauthHandler } from './api';
import { I18n, useT, type Key, type Locale } from './i18n';
import { Activity } from './screens/Activity';
import { Gate } from './screens/Gate';
import { Home } from './screens/Home';
import { Receive } from './screens/Receive';
import { Security } from './screens/Security';
import { Send } from './screens/Send';
import { Settings } from './screens/Settings';
import { Btn, Icon, Notice } from './ui';

const TABS = [['home', '/', 'home'], ['receive', '/receive', 'down'], ['send', '/send', 'up'], ['activity', '/activity', 'list'], ['security', '/security', 'shield'], ['settings', '/settings', 'gear']] as const;
export type Tab = (typeof TABS)[number][0];
const tabOf = (p: string): Tab => TABS.find((t) => t[1] === p)?.[0] ?? 'home';

export function App() {
  const qc = useQueryClient();
  const [locale, setLocaleState] = useState<Locale>(() => (localStorage.getItem('spw-locale') === 'en' ? 'en' : 'fr'));
  const [tab, setTabState] = useState<Tab>(() => tabOf(location.pathname));
  const state = useQuery({ queryKey: ['auth'], queryFn: () => get<{ setupRequired: boolean; authenticated: boolean }>('/auth/state'), staleTime: 0 });
  const setLocale = useCallback((l: Locale) => { localStorage.setItem('spw-locale', l); document.documentElement.lang = l; setLocaleState(l); }, []);
  const go = useCallback((t: Tab) => { history.pushState(null, '', TABS.find((x) => x[0] === t)![1]); setTabState(t); window.scrollTo(0, 0); }, []);
  useEffect(() => { const f = () => setTabState(tabOf(location.pathname)); addEventListener('popstate', f); return () => removeEventListener('popstate', f); }, []);
  useEffect(() => { setUnauthHandler(() => { qc.clear(); void qc.invalidateQueries({ queryKey: ['auth'] }); }); }, [qc]);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  // lock when the app has been in the background for a while (server also enforces a 30-minute idle timeout)
  useEffect(() => { const f = () => { if (document.visibilityState === 'visible') void qc.invalidateQueries({ queryKey: ['auth'] }); }; document.addEventListener('visibilitychange', f); return () => document.removeEventListener('visibilitychange', f); }, [qc]);

  let body;
  if (state.isLoading) body = <div className="grid h-full place-items-center text-mute"><Icon n="spin" className="h-6 w-6" /></div>;
  else if (state.isError || !state.data) body = <Offline retry={() => void state.refetch()} />;
  else if (!state.data.authenticated) body = <Gate setup={state.data.setupRequired} onDone={() => void state.refetch()} />;
  else body = <Shell tab={tab} go={go} lock={async () => { await post('/auth/logout').catch(() => {}); qc.clear(); void state.refetch(); }} />;
  return <I18n.Provider value={{ locale, setLocale }}>{body}</I18n.Provider>;
}

function Offline({ retry }: { retry: () => void }) {
  const t = useT();
  return <div className="mx-auto grid h-full max-w-sm place-items-center px-6"><div className="w-full space-y-4"><Notice tone="warn">{t('offline')}</Notice><Btn full kind="soft" onClick={retry}>{t('retry')}</Btn></div></div>;
}

function Shell({ tab, go, lock }: { tab: Tab; go: (t: Tab) => void; lock: () => void }) {
  const t = useT();
  const item = (id: Tab, icon: string, mobile: boolean) => {
    const on = tab === id;
    return mobile
      ? <button key={id} onClick={() => go(id)} aria-current={on ? 'page' : undefined} className={`flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] ${on ? 'text-emerald' : 'text-mute'}`}><Icon n={icon} className="h-[22px] w-[22px]" /><span>{t(id as Key)}</span></button>
      : <button key={id} onClick={() => go(id)} aria-current={on ? 'page' : undefined} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] ${on ? 'bg-elev text-ink' : 'text-mute hover:text-ink'}`}><Icon n={icon} />{t(id as Key)}</button>;
  };
  return (
    <div className="mx-auto flex min-h-full max-w-6xl">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line p-4 lg:flex">
        <div className="mb-6 flex items-center gap-2.5 px-2"><img src="/icon.svg" alt="" className="h-8 w-8 rounded-lg" /><span className="text-lg font-semibold tracking-tight">SP Wallet</span></div>
        <nav className="space-y-1" aria-label="Navigation">{TABS.map(([id, , icon]) => item(id, icon, false))}</nav>
        <button onClick={lock} className="mt-auto flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] text-mute hover:text-ink"><Icon n="lock" />{t('logout')}</button>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="safe-t sticky top-0 z-10 border-b border-line bg-bg/85 backdrop-blur lg:hidden">
          <div className="flex h-13 items-center justify-between px-4 py-2.5">
            <div className="flex items-center gap-2"><img src="/icon.svg" alt="" className="h-7 w-7 rounded-lg" /><span className="font-semibold tracking-tight">SP Wallet</span></div>
            <button onClick={lock} aria-label={t('logout')} className="grid h-10 w-10 place-items-center rounded-full text-mute"><Icon n="lock" /></button>
          </div>
        </header>
        <main key={tab} className="rise mx-auto w-full max-w-xl px-4 pb-28 pt-4 lg:max-w-2xl lg:pb-10 lg:pt-8">
          {tab === 'home' && <Home go={go} />}
          {tab === 'receive' && <Receive />}
          {tab === 'send' && <Send go={go} />}
          {tab === 'activity' && <Activity />}
          {tab === 'security' && <Security />}
          {tab === 'settings' && <Settings lock={lock} />}
        </main>
        <nav aria-label="Navigation" className="safe-b fixed inset-x-0 bottom-0 z-10 border-t border-line bg-bg/90 backdrop-blur lg:hidden">
          <div className="mx-auto flex max-w-xl px-1 pt-1.5">{TABS.map(([id, , icon]) => item(id, icon, true))}</div>
        </nav>
      </div>
    </div>
  );
}
