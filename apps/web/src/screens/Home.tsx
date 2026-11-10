import { useContext } from 'react';
import type { Tab } from '../App';
import { useNetworks, usePortfolio, useSettings } from '../hooks';
import { I18n, useT } from '../i18n';
import { Card, Coin, fiat, H, Icon, Money, NetDot, Notice, short, Skeleton, StatePill, trimAmt } from '../ui';

export function Home({ go }: { go: (t: Tab) => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const pf = usePortfolio(), nets = useNetworks(); const { settings, update } = useSettings();
  const cur = settings.currency, key = cur === 'USD' ? 'usd' : 'cad';
  const hidden = settings.hideBalances;
  if (pf.isLoading) return <div className="space-y-5"><Skeleton h="h-56" /><Skeleton h="h-72" /></div>;
  if (!pf.data) return <Notice tone="warn">{t('offline')}</Notice>;
  const d = pf.data;
  const value = (b: { symbol: string; display: string | null }) => (d.prices?.[b.symbol] && b.display !== null ? Number(b.display) * d.prices[b.symbol]![key] : null);
  const total = d.balances.reduce((s, b) => s + (value(b) ?? 0), 0);
  // funded assets first (by value), then USDC everywhere, then the rest
  const rows = d.balances.slice().sort((a, b) => (value(b) ?? 0) - (value(a) ?? 0) || Number(b.symbol === 'USDC') - Number(a.symbol === 'USDC'));
  const list = nets.data ?? [], checked = list.filter((n) => n.health), up = checked.filter((n) => n.health!.ok).length;
  const netState = checked.length < list.length || list.length === 0 ? 'checking' : up === list.length ? 'ok' : 'partial';
  const action = (id: Tab, icon: string, label: string, main = false, disabled = false) =>
    <button onClick={() => go(id)} disabled={disabled} className={`flex min-h-[52px] flex-1 items-center justify-center gap-2 rounded-2xl text-[15px] font-semibold transition active:scale-[0.98] disabled:opacity-40 ${main ? 'hero-btn-main' : 'hero-btn'}`}><Icon n={icon} className="h-[18px] w-[18px]" />{label}</button>;
  return (
    <div className="space-y-5">
      {d.halted && <Notice tone="danger">{t('haltedBanner')}</Notice>}
      <section className="hero p-6">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium text-white/65">{t('totalEstimate')}</span>
          <button onClick={() => void update({ hideBalances: !hidden })} aria-label={hidden ? t('show') : t('hide')} aria-pressed={hidden} className="-mr-2 grid h-10 w-10 place-items-center rounded-full text-white/70"><Icon n={hidden ? 'eyeOff' : 'eye'} /></button>
        </div>
        <div className="mt-2 font-[family-name:var(--font-display)] text-[44px] font-semibold leading-none tracking-[-0.03em]">
          {d.prices ? <Money hidden={hidden}>{fiat(total, cur, locale)}</Money> : <span className="text-2xl text-white/60">{t('noPrices')}</span>}
        </div>
        <div className="mt-3 flex items-center gap-2 text-[12.5px] text-white/60">
          <span className={`inline-block h-2 w-2 rounded-full ${netState === 'ok' ? 'bg-[#35e7ac]' : netState === 'checking' ? 'pulse-dot bg-white/60' : 'bg-[#f4b65b]'}`} />
          {netState === 'checking' ? t('checking') : t('netsUp', { up, n: list.length })}{d.prices ? ` · ${cur}` : ''}
        </div>
        <div className="mt-6 flex gap-3">{action('receive', 'down', t('receive'), true)}{action('send', 'up', t('send'), false, d.halted)}</div>
      </section>

      {d.pending.length > 0 && <Card><H>{t('pending')}</H>
        <ul className="space-y-3.5">{d.pending.map((p) => <li key={p.id} className="flex items-center gap-3">
          <Coin sym={p.symbol} net={p.network} size={40} />
          <div className="min-w-0 flex-1"><div className="font-semibold"><Money hidden={hidden}>{trimAmt(p.amountDisplay)} {p.symbol}</Money></div><div className="truncate text-[12.5px] text-mute">{p.networkName} → {short(p.to)}</div></div>
          <StatePill state={p.state} /></li>)}</ul></Card>}

      <Card className="!px-0 !pb-1">
        <div className="px-5"><H>{t('assets')}</H></div>
        <ul>{rows.map((b, k) => { const v = value(b); const zero = b.amount === '0'; return (
          <li key={b.network + b.asset} className={`flex items-center gap-3.5 px-5 py-3 ${k ? 'border-t border-line' : ''}`}>
            <Coin sym={b.symbol} net={b.network} />
            <div className="min-w-0 flex-1"><div className="text-[15.5px] font-semibold leading-tight">{b.name}</div><div className="mt-0.5 truncate text-[12.5px] text-mute">{b.symbol} · {b.networkName}</div></div>
            <div className="text-right">
              {b.display === null ? <span className="text-[12.5px] text-warn">{t('unavailable')}</span> : <>
                <div className={`text-[15.5px] font-semibold leading-tight ${zero ? 'text-mute' : ''}`}><Money hidden={hidden}>{trimAmt(b.display)}</Money></div>
                <div className="mt-0.5 text-[12.5px] text-mute">{v !== null ? <Money hidden={hidden}>{fiat(v, cur, locale)}</Money> : ' '}</div></>}
            </div>
          </li>); })}</ul>
      </Card>

      {netState === 'partial' && <Card><H>{t('networks')}</H>
        <ul className="space-y-2.5">{list.filter((n) => n.health && !n.health.ok).map((n) => <li key={n.id} className="flex items-center justify-between text-[14px]">
          <span className="flex items-center gap-2.5"><NetDot net={n.id} />{n.name}</span>
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-warn"><Icon n="warn" className="h-3.5 w-3.5" />{n.health!.readable ? t('sendPaused') : t('unavailable')}</span></li>)}</ul>
        <p className="mt-3 text-[12.5px] text-mute">{t('partialNote')}</p></Card>}
      <p className="pb-2 text-center text-[12px] text-mute">{t('mainnet')}</p>
    </div>
  );
}
