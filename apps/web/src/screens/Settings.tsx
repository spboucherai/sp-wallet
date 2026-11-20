// NEXT — Settings (design system §5): appearance (system / light / dark), language, currency — all three kept in the ACCOUNT
// and applied on every device — privacy (hide balances, prices), notifications, the state of the networks, version.
// On a desktop: two panes — where to go on the left, the preferences on the right.
import { useContext, useState } from 'react';
import type { Tab } from '../App';
import { useNetworks, useSettings, type SettingsT } from '../hooks';
import { applyTheme, cacheTheme, currentTheme, type ThemePref } from '../theme';
import { I18n, useT } from '../i18n';
import { Btn, Card, Fold, H, Icon, NetworkIcon, Notice, PageTitle, Seg, Tag, Toggle } from '../ui';
import { APP_VERSION } from '../version';

export function Settings({ lock, go }: { lock: () => void; go: (t: Tab) => void }) {
  const t = useT(); const { locale, setLocale } = useContext(I18n); const { settings, update } = useSettings(); const nets = useNetworks();
  const [failed, setFailed] = useState(false);
  const save = (patch: Partial<SettingsT>) => { setFailed(false); void update(patch).then((ok) => { if (!ok) setFailed(true); }); };
  // NEXT: appearance belongs to the account (`settings.theme`); it is applied at once here and on the other devices at their next read
  const theme: ThemePref = settings.theme ?? currentTheme();
  const setTheme = (v: ThemePref) => { applyTheme(v); cacheTheme(v); if (settings.theme !== undefined) save({ theme: v }); };
  const list = nets.data ?? [], ok = list.filter((n) => n.health?.ok).length, bad = list.filter((n) => n.health && !n.health.ok);
  const row = (label: string, hint: string | null, control: React.ReactNode) => <div className="flex min-h-11 items-center justify-between gap-4"><span className="min-w-0"><span className="t-body block">{label}</span>{hint && <span className="t-footnote block text-mute">{hint}</span>}</span>{control}</div>;
  const exit = <Card className="space-y-3">
    <a href="/api/v1/export/activity.csv" className="btn press inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[var(--radius-md)] bg-elev px-5 text-[0.96875rem] font-medium"><Icon n="down" className="h-4 w-4" />{t('exportCsv')}</a>
    <Btn kind="ghost" full onClick={lock}><Icon n="lock" />{t('logout')}</Btn></Card>;
  return (
    <div className="space-y-4" data-testid="settings">
      <PageTitle>{t('settings')}</PageTitle>
      {failed && <Notice tone="danger" testid="settings-failed">{t('nwSetFailed')}</Notice>}
      <div className="panes panes-side space-y-4 lg:space-y-0">
        <div className="min-w-0 space-y-4">
          {/* one grouped list of destinations: everything the five areas of the navigation do not hold (v11: the same list as the header menu) */}
          <nav aria-label={t('settings')} className="card overflow-hidden">{([['security', 'shield', t('securityLink')], ['contacts', 'users', t('nwContacts')], ['risk', 'stop', t('v11NavRiskCard')], ['alerts', 'bell', t('alTitle')], ['developer', 'key', t('dvTitle')], ['monitor', 'bars', t('moTitle')], ['research', 'search', t('rjTitle')]] as const).map(([id, icon, label]) =>
            <button key={id} onClick={() => go(id)} data-dest={id} className="row row-press">
              <span className="disc" aria-hidden="true"><Icon n={icon} className="h-[1.125rem] w-[1.125rem]" /></span>
              <span className="t-body-strong flex-1">{label}</span><Icon n="chev" className="h-5 w-5 text-mute" /></button>)}</nav>
          <div className="hidden lg:block">{exit}</div>
        </div>
        <div className="min-w-0 space-y-4">
          <Card className="space-y-5">
            <div data-testid="set-appearance"><H>{t('nwSetAppearance')}</H><Seg label={t('nwSetAppearance')} testid="theme-seg" value={theme} options={[['system', t('nwThemeSystem')], ['light', t('light')], ['dark', t('dark')]]} onChange={setTheme} />
              <p className="t-footnote mt-2 text-mute">{t(theme === 'system' ? 'nwSetAppearanceSystem' : 'nwSetAppearanceNote')}</p></div>
            <div><H>{t('language')}</H><Seg label={t('language')} testid="lang-seg" value={locale} options={[['fr', 'Français'], ['en', 'English']]} onChange={(l) => { setLocale(l); save({ locale: l }); }} /></div>
            <div><H>{t('currency')}</H><Seg label={t('currency')} testid="currency-seg" value={settings.currency} options={[['CAD', 'CAD'], ['USD', 'USD']]} onChange={(c) => save({ currency: c })} /></div>
            <p className="t-footnote text-mute">{t('nwSetSynced')}</p>
          </Card>
          <Card className="space-y-3"><H>{t('nwSetPrivacy')}</H>
            {row(t('hide'), t('nwSetHideNote'), <Toggle label={t('hide')} testid="set-hide" on={settings.hideBalances} onChange={(v) => save({ hideBalances: v })} />)}
            {row(t('prices'), t('pricesNote'), <Toggle label={t('prices')} testid="set-prices" on={settings.prices} onChange={(v) => save({ prices: v })} />)}
          </Card>
          <Card><H>{t('nwSetNotifications')}</H>
            <p className="t-callout reading text-mute">{t('nwSetNotificationsBody')}</p>
            <Btn kind="soft" className="mt-3" onClick={() => { history.pushState({ spw: 1 }, '', '/alerts?v=settings'); dispatchEvent(new PopStateEvent('popstate')); window.scrollTo(0, 0); }} data-testid="set-notifications"><Icon n="bell" className="h-4 w-4" />{t('nwSetNotificationsGo')}</Btn></Card>
          <Card><H right={list.length > 0 ? <Tag tone={bad.length ? 'warn' : 'ok'} icon={bad.length ? 'warn' : 'check'} testid="nets-summary">{t('netsUp', { up: ok, n: list.length })}</Tag> : undefined}>{t('rpcStatus')}</H>
            {bad.length > 0 && <ul className="mb-2 space-y-1.5">{bad.map((n) => <li key={n.id} className="t-callout flex items-center justify-between gap-3"><span className="flex min-w-0 items-center gap-2"><NetworkIcon net={n.id} size={20} /><span className="truncate">{n.name}</span></span><span className="t-footnote inline-flex items-center gap-1 text-caution"><Icon n="warn" className="h-3.5 w-3.5" />{n.health!.readable ? t('sendPaused') : t('unavailable')}</span></li>)}</ul>}
            <Fold summary={t('nwSetNetsDetail', { n: list.length })} testid="nets-detail">
              <ul className="space-y-3">{list.map((n) => <li key={n.id}>
                <div className="t-footnote flex items-center justify-between gap-3"><span className="flex min-w-0 items-center gap-2 font-medium"><NetworkIcon net={n.id} size={20} /><span className="truncate">{n.name}</span></span><span className={`inline-flex items-center gap-1 ${n.health?.identityVerified ? 'text-positive' : 'text-caution'}`}><Icon n={n.health?.identityVerified ? 'check' : 'warn'} className="h-3.5 w-3.5" />{n.health?.identityVerified ? t('identityOk') : t('identityKo')}</span></div>
                <div className="t-micro mt-1 space-y-0.5 text-mute">{(n.health?.endpoints ?? []).map((e) => <div key={e.url} className="flex justify-between gap-3"><span className="truncate font-mono">{e.url}</span><span className={e.ok ? '' : 'text-caution'}>{e.ok ? `${e.ms} ms` : t('unavailable')}</span></div>)}
                  {n.health?.height && <div>{t('block')} {n.health.height.toLocaleString(locale === 'fr' ? 'fr-CA' : 'en-CA')}</div>}</div></li>)}</ul></Fold></Card>
          <Card><H>{t('nwSetAbout')}</H>
            <p className="t-callout text-mute">SP Wallet · {t('version')} <span data-testid="app-version" className="font-mono text-ink">{APP_VERSION}</span></p>
            <p className="t-footnote mt-1 text-mute">{t('mainnet')}</p></Card>
          <div className="lg:hidden">{exit}</div>
        </div>
      </div>
    </div>
  );
}
