import { useContext, useState } from 'react';
import { useNetworks, useSettings } from '../hooks';
import { I18n, useT } from '../i18n';
import { Btn, Card, H, Icon } from '../ui';

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return <div className="flex rounded-xl border border-line p-1" role="radiogroup" aria-label={label}>{options.map(([v, l]) =>
    <button key={v} role="radio" aria-checked={value === v} onClick={() => onChange(v)} className={`min-h-10 flex-1 rounded-lg text-[14px] ${value === v ? 'bg-elev font-medium' : 'text-mute'}`}>{l}</button>)}</div>;
}
function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className={`relative h-8 w-14 shrink-0 rounded-full transition ${on ? 'bg-emerald' : 'bg-elev'}`}><span className={`absolute top-1 h-6 w-6 rounded-full bg-white transition-all ${on ? 'left-7' : 'left-1'}`} /></button>;
}

export function Settings({ lock }: { lock: () => void }) {
  const t = useT(); const { locale, setLocale } = useContext(I18n); const { settings, update } = useSettings(); const nets = useNetworks();
  const [theme, setTheme] = useState(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t('settings')}</h1>
      <Card className="space-y-5">
        <div><H>{t('language')}</H><Seg label={t('language')} value={locale} options={[['fr', 'Français'], ['en', 'English']]} onChange={(l) => { setLocale(l); void update({ locale: l }); }} /></div>
        <div><H>{t('currency')}</H><Seg label={t('currency')} value={settings.currency} options={[['CAD', 'CAD'], ['USD', 'USD']]} onChange={(c) => void update({ currency: c })} /></div>
        <div><H>{t('theme')}</H><Seg label={t('theme')} value={theme} options={[['dark', t('dark')], ['light', t('light')]]} onChange={(v) => { localStorage.setItem('spw-theme', v); document.documentElement.dataset.theme = v; setTheme(v); }} /></div>
        <div className="flex items-center justify-between gap-4"><span>{t('hide')}</span><Toggle label={t('hide')} on={settings.hideBalances} onChange={(v) => void update({ hideBalances: v })} /></div>
        <div className="flex items-center justify-between gap-4"><span><span className="block">{t('prices')}</span><span className="block text-xs text-mute">{t('pricesNote')}</span></span><Toggle label={t('prices')} on={settings.prices} onChange={(v) => void update({ prices: v })} /></div>
      </Card>
      <Card><H>{t('rpcStatus')}</H>
        <ul className="space-y-3 text-[13px]">{(nets.data ?? []).map((n) => <li key={n.id}>
          <div className="flex items-center justify-between"><span className="font-medium">{n.name}</span><span className={`inline-flex items-center gap-1 text-xs ${n.health?.identityVerified ? 'text-emerald' : 'text-warn'}`}><Icon n={n.health?.identityVerified ? 'check' : 'warn'} className="h-3.5 w-3.5" />{n.health?.identityVerified ? t('identityOk') : t('identityKo')}</span></div>
          <div className="mt-1 space-y-0.5 text-xs text-mute">{(n.health?.endpoints ?? []).map((e) => <div key={e.url} className="flex justify-between gap-3"><span className="truncate font-mono">{e.url}</span><span className={e.ok ? '' : 'text-warn'}>{e.ok ? `${e.ms} ms` : t('unavailable')}</span></div>)}
            {n.health?.height && <div>{t('block')} {n.health.height.toLocaleString('en-US')}</div>}</div></li>)}</ul></Card>
      <Card className="space-y-3">
        <a href="/api/v1/export/activity.csv" className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-elev px-4 text-[15px]"><Icon n="down" className="h-4 w-4" />{t('exportCsv')}</a>
        <Btn kind="ghost" full onClick={lock}><Icon n="lock" />{t('logout')}</Btn>
        <p className="text-center text-xs text-mute">SP Wallet · {t('version')} 1.0.0 · {t('mainnet')}</p>
      </Card>
    </div>
  );
}
