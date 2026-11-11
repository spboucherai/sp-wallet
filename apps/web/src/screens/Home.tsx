import { useContext } from 'react';
import type { Nav, Tab } from '../App';
import { Spark } from '../chart';
import { useNetworks, usePortfolio, useSettings, type Bal } from '../hooks';
import { I18n, useT } from '../i18n';
import { Card, Change, Coin, fiat, H, Icon, Money, NetDot, Notice, numFmt, short, Skeleton, StatePill, testNotSent, trimAmt } from '../ui';

const FEATURED = ['USDC', 'BTC', 'ETH', 'SOL', 'USDT'];

export function AssetRow({ b, nav, cur, ck, hidden, prices, locale, border }: { b: Bal; nav: Nav; cur: string; ck: 'usd' | 'cad'; hidden: boolean; prices: Record<string, any> | null; locale: string; border: boolean }) {
  const t = useT();
  const m = prices?.[b.symbol], v = m && b.display !== null ? Number(b.display) * m[ck] : null, zero = b.amount === '0';
  return (
    <li><button onClick={() => nav({ tab: 'asset', network: b.network, asset: b.asset })} className={`flex w-full items-center gap-3.5 px-5 py-3 text-left transition active:bg-elev/60 ${border ? 'border-t border-line' : ''}`}>
      <Coin sym={b.symbol} net={b.network} />
      <span className="min-w-0 flex-1"><span className="block truncate text-[15.5px] font-semibold leading-tight">{b.name}</span><span className="mt-0.5 block truncate text-[12.5px] text-mute">{b.symbol} · {b.networkName}</span></span>
      {m && zero && <Spark data={m.spark} />}
      <span className="text-right">
        {b.display === null ? <span className="text-[12.5px] text-warn">{t('unavailable')}</span> : zero && m ? <>
          <span className="block text-[15px] font-semibold leading-tight">{fiat(m[ck], cur, locale)}</span>
          <span className="mt-0.5 block">{m.change24h !== null && <Change pct={m.change24h} />}</span></> : <>
          <span className="block text-[15.5px] font-semibold leading-tight"><Money hidden={hidden}>{trimAmt(b.display)}</Money></span>
          <span className="mt-0.5 block text-[12.5px] text-mute">{v !== null ? <Money hidden={hidden}>{fiat(v, cur, locale)}</Money> : ' '}</span></>}
      </span>
    </button></li>);
}

export function Home({ go, nav }: { go: (t: Tab) => void; nav: Nav }) {
  const t = useT(); const { locale } = useContext(I18n);
  const pf = usePortfolio(), nets = useNetworks(); const { settings, update } = useSettings();
  const cur = settings.currency, ck = cur === 'USD' ? 'usd' : 'cad';
  const hidden = settings.hideBalances;
  if (pf.isLoading) return <div className="space-y-5"><Skeleton h="h-56" /><Skeleton h="h-72" /></div>;
  if (!pf.data) return <Notice tone="warn">{t('offline')}</Notice>;
  const d = pf.data;
  const value = (b: Bal) => (d.prices?.[b.symbol] && b.display !== null ? Number(b.display) * d.prices[b.symbol]![ck] : 0);
  const total = d.balances.reduce((s, b) => s + value(b), 0);
  // 24 h change of the whole portfolio, from each holding's own 24 h change
  const prev = d.balances.reduce((s, b) => { const c = d.prices?.[b.symbol]?.change24h; return s + (c === null || c === undefined ? value(b) : value(b) / (1 + c / 100)); }, 0);
  const dayPct = total > 0 && prev > 0 ? ((total - prev) / prev) * 100 : null;
  const held = d.balances.filter((b) => b.amount !== null && b.amount !== '0').sort((a, b) => value(b) - value(a));
  // nothing held yet: show a short list of well-known assets (one per symbol) with live prices instead of a wall of zeros
  const featured = FEATURED.flatMap((s) => { const c = d.balances.filter((b) => b.symbol === s); // the native coin; else the original issue rather than a bridged or pegged copy (USDT on Base is "Bridged USDT"); USDC stays on Base, where this wallet lives
    const orig = (b: Bal) => !/bridged|binance-peg|\(.*bridge.*\)/i.test(b.name);
    return c.length ? [c.find((b) => b.asset === 'native') ?? (s === 'USDC' ? c.find((b) => b.network === 'base') : undefined) ?? c.find((b) => b.network === 'ethereum' && orig(b)) ?? c.find(orig) ?? c[0]!] : []; });
  const list = nets.data ?? [], checked = list.filter((n) => n.health), up = checked.filter((n) => n.health!.ok).length;
  const netState = checked.length < list.length || list.length === 0 ? 'checking' : up === list.length ? 'ok' : 'partial';
  const action = (id: Tab, icon: string, label: string, main = false, disabled = false) =>
    <button onClick={() => go(id)} disabled={disabled} className={`flex min-h-[52px] flex-1 items-center justify-center gap-2 rounded-2xl text-[15px] font-semibold transition active:scale-[0.98] disabled:opacity-40 ${main ? 'hero-btn-main' : 'hero-btn'}`}><Icon n={icon} className="h-[18px] w-[18px]" />{label}</button>;
  const rowProps = { nav, cur, ck: ck as 'usd' | 'cad', hidden, prices: d.prices, locale };
  return (
    <div className="space-y-5">
      {d.halted && <Notice tone="danger">{t('haltedBanner')}</Notice>}
      <section className="hero p-6">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium text-white/65">{t('totalEstimate')}</span>
          <button onClick={() => void update({ hideBalances: !hidden })} aria-label={hidden ? t('show') : t('hide')} aria-pressed={hidden} className="-mr-2 -mt-1 grid h-11 w-11 place-items-center rounded-full text-white/70"><Icon n={hidden ? 'eyeOff' : 'eye'} /></button>
        </div>
        <div className="mt-2 font-[family-name:var(--font-display)] text-[46px] font-semibold leading-none tracking-[-0.03em]">
          {d.prices ? <Money hidden={hidden}>{fiat(total, cur, locale)}</Money> : <span className="text-2xl text-white/60">{t('noPrices')}</span>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-white/65">
          {dayPct !== null && !hidden && <span className="inline-flex items-center gap-1 rounded-full bg-white/12 px-2 py-0.5 font-semibold text-white">
            <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true"><path d={dayPct >= 0 ? 'M6 2l4.5 7h-9z' : 'M6 10L1.5 3h9z'} fill="currentColor" /></svg>{dayPct >= 0 ? '+' : '−'}{numFmt(Math.abs(dayPct), locale, 2, 2)} % {t('today')}</span>}
          <span className="inline-flex items-center gap-2"><span className={`inline-block h-2 w-2 rounded-full ${netState === 'ok' ? 'bg-[#35e7ac]' : netState === 'checking' ? 'pulse-dot bg-white/60' : 'bg-[#f4b65b]'}`} />
            {netState === 'checking' ? t('checking') : t('netsUp', { up, n: list.length })}</span>
        </div>
        <div className="mt-6 flex gap-3">{action('receive', 'down', t('receive'), true)}{action('send', 'up', t('send'), false, d.halted)}</div>
      </section>

      {d.pending.length > 0 && <Card><H>{t('pending')}</H>
        <ul className="space-y-3.5">{d.pending.map((p) => <li key={p.id} className="flex items-center gap-3">
          <Coin sym={p.symbol} net={p.network} size={40} />
          <div className="min-w-0 flex-1"><div className="font-semibold"><Money hidden={hidden}>{trimAmt(p.amountDisplay)} {p.symbol}</Money></div><div className="truncate text-[12.5px] text-mute">{p.networkName} → {short(p.to)}</div></div>
          {testNotSent(p) ? <span className="rounded-full bg-warn/12 px-2 py-0.5 text-[11.5px] font-semibold text-warn">{t('qaSignedNotSent')}</span> : <StatePill state={p.state} />}</li>)}</ul></Card>}

      {held.length > 0 && <Card className="!px-0 !pb-1"><div className="px-5"><H>{t('yourAssets')}</H></div>
        <ul>{held.map((b, k) => <AssetRow key={b.network + b.asset} b={b} border={k > 0} {...rowProps} />)}</ul></Card>}

      <Card className="!px-0 !pb-0"><div className="px-5"><H>{held.length ? t('popular') : t('assets')}</H></div>
        <ul>{featured.filter((f) => !held.includes(f)).map((b, k) => <AssetRow key={b.network + b.asset} b={{ ...b, amount: '0' }} border={k > 0} {...rowProps} />)}</ul>
        <button onClick={() => nav({ tab: 'assets' })} className="flex w-full items-center justify-between border-t border-line px-5 py-4 text-left text-[15px] font-semibold text-blue">
          <span>{t('allAssets')} <span className="font-normal text-mute">· {t('tokensCount', { n: d.balances.length })}</span></span><Icon n="chev" className="h-5 w-5" /></button></Card>

      {netState === 'partial' && <Card><H>{t('networks')}</H>
        <ul className="space-y-2.5">{list.filter((n) => n.health && !n.health.ok).map((n) => <li key={n.id} className="flex items-center justify-between text-[14px]">
          <span className="flex items-center gap-2.5"><NetDot net={n.id} />{n.name}</span>
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-warn"><Icon n="warn" className="h-3.5 w-3.5" />{n.health!.readable ? t('sendPaused') : t('unavailable')}</span></li>)}</ul>
        <p className="mt-3 text-[12.5px] text-mute">{t('partialNote')}</p></Card>}
      <p className="pb-2 text-center text-[12px] text-mute">{t('mainnet')}</p>
    </div>
  );
}
