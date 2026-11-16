import { useContext, useState } from 'react';
import type { Tab } from '../App';
import { useNetworks, useSettings } from '../hooks';
import { applyTheme } from '../theme';
import { I18n, useT } from '../i18n';
import { Btn, Card, H, Icon, NetworkIcon, PageTitle, Seg } from '../ui';

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className="grid h-11 w-16 shrink-0 place-items-center"><span className={`relative block h-[31px] w-[52px] rounded-full transition-colors duration-200 ${on ? 'bg-emerald' : 'bg-mute/35'}`}><span className={`absolute left-[2px] top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow-[0_2px_5px_rgba(0,0,0,0.28)] transition-transform duration-200 ease-[var(--ease-spring)] ${on ? 'translate-x-[21px]' : ''}`} /></span></button>;
}

export function Settings({ lock, go }: { lock: () => void; go: (t: Tab) => void }) {
  const t = useT(); const { locale, setLocale } = useContext(I18n); const { settings, update } = useSettings(); const nets = useNetworks();
  const [theme, setTheme] = useState<'light' | 'dark'>(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  return (
    <div className="space-y-4">
      <PageTitle>{t('settings')}</PageTitle>
      {/* one grouped list of destinations (v6-alerts: entry points that leave the five phone tabs as they are) */}
      <nav aria-label={t('settings')} className="card divide-y divide-line overflow-hidden">{([['security', 'shield', t('securityLink'), ''], ['alerts', 'bell', t('alTitle'), ''], ['monitor', 'bars', t('moTitle'), ''], ['developer', 'key', t('dvTitle'), ''], ['agents', 'robot', t('agents'), 'lg:hidden']] as const).map(([id, icon, label, cls]) =>
        <button key={id} onClick={() => go(id)} className={`row-press flex min-h-[64px] w-full items-center gap-3.5 px-4 py-2.5 text-left ${cls}`}>
          <span className="grid h-10 w-10 place-items-center rounded-full bg-elev"><Icon n={icon} className="h-[19px] w-[19px]" /></span>
          <span className="flex-1 text-[15.5px] font-semibold">{label}</span><Icon n="chev" className="h-5 w-5 text-mute" /></button>)}</nav>
      <Card className="space-y-6">
        <div><H>{t('language')}</H><Seg label={t('language')} value={locale} options={[['fr', 'Français'], ['en', 'English']]} onChange={(l) => { setLocale(l); void update({ locale: l }); }} /></div>
        <div><H>{t('currency')}</H><Seg label={t('currency')} value={settings.currency} options={[['CAD', 'CAD'], ['USD', 'USD']]} onChange={(c) => void update({ currency: c })} /></div>
        <div><H>{t('theme')}</H><Seg label={t('theme')} value={theme} options={[['light', t('light')], ['dark', t('dark')]]} onChange={(v) => { localStorage.setItem('spw-theme', v); applyTheme(v); setTheme(v); }} /></div>
        <div className="flex items-center justify-between gap-4"><span>{t('hide')}</span><Toggle label={t('hide')} on={settings.hideBalances} onChange={(v) => void update({ hideBalances: v })} /></div>
        <div className="flex items-center justify-between gap-4"><span><span className="block">{t('prices')}</span><span className="block text-xs text-mute">{t('pricesNote')}</span></span><Toggle label={t('prices')} on={settings.prices} onChange={(v) => void update({ prices: v })} /></div>
      </Card>
      <Card><H>{t('rpcStatus')}</H>
        <ul className="space-y-3 text-[13px]">{(nets.data ?? []).map((n) => <li key={n.id}>
          <div className="flex items-center justify-between gap-3"><span className="flex min-w-0 items-center gap-2 font-medium"><NetworkIcon net={n.id} size={20} /><span className="truncate">{n.name}</span></span><span className={`inline-flex items-center gap-1 text-xs ${n.health?.identityVerified ? 'text-emerald' : 'text-warn'}`}><Icon n={n.health?.identityVerified ? 'check' : 'warn'} className="h-3.5 w-3.5" />{n.health?.identityVerified ? t('identityOk') : t('identityKo')}</span></div>
          <div className="mt-1 space-y-0.5 text-xs text-mute">{(n.health?.endpoints ?? []).map((e) => <div key={e.url} className="flex justify-between gap-3"><span className="truncate font-mono">{e.url}</span><span className={e.ok ? '' : 'text-warn'}>{e.ok ? `${e.ms} ms` : t('unavailable')}</span></div>)}
            {n.health?.height && <div>{t('block')} {n.health.height.toLocaleString('en-US')}</div>}</div></li>)}</ul></Card>
      <Card className="space-y-3">
        <a href="/api/v1/export/activity.csv" className="press inline-flex min-h-[50px] w-full items-center justify-center gap-2 rounded-2xl bg-elev px-4 text-[15.5px] font-medium"><Icon n="down" className="h-4 w-4" />{t('exportCsv')}</a>
        <Btn kind="ghost" full onClick={lock}><Icon n="lock" />{t('logout')}</Btn>
        <p className="text-center text-xs text-mute">SP Wallet · {t('version')} 1.0.0 · {t('mainnet')}</p>
      </Card>
    </div>
  );
}
