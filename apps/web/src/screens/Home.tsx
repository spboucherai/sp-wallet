import { useContext, useState } from 'react';
import type { Tab } from '../App';
import { useNetworks, usePortfolio, useSettings } from '../hooks';
import { I18n, useT } from '../i18n';
import { Btn, Card, Coin, fiat, H, Icon, Money, Notice, short, Skeleton, StatePill, trimAmt } from '../ui';

export function Home({ go }: { go: (t: Tab) => void }) {
  const t = useT(); const { locale } = useContext(I18n);
  const pf = usePortfolio(), nets = useNetworks(); const { settings, update } = useSettings();
  const [zero, setZero] = useState(false);
  const cur = settings.currency, key = cur === 'USD' ? 'usd' : 'cad';
  const hidden = settings.hideBalances;
  if (pf.isLoading) return <div className="space-y-4"><Skeleton h="h-40" /><Skeleton /><Skeleton /><Skeleton /></div>;
  if (!pf.data) return <Notice tone="warn">{t('offline')}</Notice>;
  const d = pf.data;
  const value = (b: { symbol: string; display: string | null }) => (d.prices?.[b.symbol] && b.display !== null ? Number(b.display) * d.prices[b.symbol]![key] : null);
  const total = d.balances.reduce((s, b) => s + (value(b) ?? 0), 0);
  const nonZero = d.balances.filter((b) => b.amount !== '0');
  const rows = (zero ? d.balances : nonZero).slice().sort((a, b) => (value(b) ?? -1) - (value(a) ?? -1));
  return (
    <div className="space-y-4">
      {d.halted && <Notice tone="danger">{t('haltedBanner')}</Notice>}
      <section className="glow rounded-3xl border border-line p-5">
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-mute">{t('totalEstimate')}</span>
          <button onClick={() => void update({ hideBalances: !hidden })} aria-label={hidden ? t('show') : t('hide')} aria-pressed={hidden} className="grid h-10 w-10 place-items-center rounded-full text-mute"><Icon n={hidden ? 'eyeOff' : 'eye'} /></button>
        </div>
        <div className="mt-1 text-[40px] font-semibold leading-tight tracking-tight">
          {d.prices ? <Money hidden={hidden}>{fiat(total, cur, locale)}</Money> : <span className="text-2xl text-mute">{t('noPrices')}</span>}
        </div>
        <div className="mt-1 text-xs text-mute">{d.prices ? `${t('estimate')} · ${cur} · ` : ''}{t('mainnet')}</div>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <Btn onClick={() => go('receive')}><Icon n="down" />{t('receive')}</Btn>
          <Btn kind="soft" onClick={() => go('send')} disabled={d.halted}><Icon n="up" />{t('send')}</Btn>
        </div>
      </section>

      {d.pending.length > 0 && <Card><H>{t('pending')}</H>
        <ul className="space-y-3">{d.pending.map((p) => <li key={p.id} className="flex items-center justify-between gap-3">
          <div className="min-w-0"><div className="font-medium"><Money hidden={hidden}>{trimAmt(p.amountDisplay)} {p.symbol}</Money></div><div className="truncate text-xs text-mute">{p.networkName} → {short(p.to)}</div></div>
          <StatePill state={p.state} /></li>)}</ul></Card>}

      <Card>
        <H right={<button className="text-xs text-blue" onClick={() => setZero(!zero)}>{zero ? t('hideZero') : t('showZero')}</button>}>{t('assets')}</H>
        {rows.length === 0 ? <p className="py-3 text-sm text-mute">{t('emptyWallet')}</p> :
          <ul className="divide-y divide-line">{rows.map((b) => { const v = value(b); return (
            <li key={b.network + b.asset} className="flex items-center gap-3 py-3">
              <Coin sym={b.symbol} />
              <div className="min-w-0 flex-1"><div className="font-medium">{b.symbol}</div><div className="truncate text-xs text-mute">{t('on')} {b.networkName}</div></div>
              <div className="text-right">
                {b.display === null ? <span className="text-xs text-warn">{t('unavailable')}</span> : <>
                  <div className="font-medium"><Money hidden={hidden}>{trimAmt(b.display)}</Money></div>
                  {v !== null && <div className="text-xs text-mute"><Money hidden={hidden}>≈ {fiat(v, cur, locale)}</Money></div>}</>}
              </div>
            </li>); })}</ul>}
      </Card>

      <Card><H>{t('networks')}</H>
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">{(nets.data ?? []).map((n) => (
          <li key={n.id} className="flex items-center justify-between rounded-xl bg-bg px-3 py-2.5 text-sm">
            <span>{n.name}</span>
            <span className={`inline-flex items-center gap-1 text-xs ${n.health?.ok ? 'text-emerald' : 'text-warn'}`}><Icon n={n.health?.ok ? 'check' : 'warn'} className="h-3.5 w-3.5" />{n.health?.ok ? t('operational') : t('degraded')}</span>
          </li>))}</ul>
      </Card>
    </div>
  );
}
