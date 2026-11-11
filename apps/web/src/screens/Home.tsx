import { useQuery } from '@tanstack/react-query';
import { useContext } from 'react';
import { useUnread } from '../alerts';
import { get } from '../api';
import type { Nav, Tab } from '../App';
import { AllocationBar, Spark } from '../chart';
import { useNetworks, usePortfolio, useSettings, type Bal } from '../hooks';
import { I18n, useT } from '../i18n';
import { AnimatedNumber, Card, Change, Coin, fiat, H, haptic, Icon, Money, NetDot, Notice, numFmt, short, Skeleton, SkeletonRows, StatePill, testNotSent, trimAmt } from '../ui';

const FEATURED = ['USDC', 'BTC', 'ETH', 'SOL', 'USDT'];

export function AssetRow({ b, nav, cur, ck, hidden, prices, locale, border }: { b: Bal; nav: Nav; cur: string; ck: 'usd' | 'cad'; hidden: boolean; prices: Record<string, any> | null; locale: string; border: boolean }) {
  const t = useT();
  const m = prices?.[b.symbol], v = m && b.display !== null ? Number(b.display) * m[ck] : null, zero = b.amount === '0';
  return (
    <li><button onClick={() => nav({ tab: 'asset', network: b.network, asset: b.asset })} className={`row-press flex min-h-[68px] w-full items-center gap-3.5 px-5 py-3 text-left ${border ? 'border-t border-line' : ''}`}>
      <Coin sym={b.symbol} net={b.network} />
      <span className="min-w-0 flex-1"><span className="block truncate text-[15.5px] font-semibold leading-tight">{b.name}</span><span className="mt-0.5 block truncate text-[12.5px] text-mute">{b.symbol} · {b.networkName}</span></span>
      {m && zero && <span className="hidden min-[430px]:block"><Spark data={m.spark} /></span>}
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
  const unread = useUnread();
  const ag = useQuery({ queryKey: ['agents'], queryFn: () => get<{ agents: { id: string; state: string }[] }>('/agents'), staleTime: 30_000 });
  const cur = settings.currency, ck = cur === 'USD' ? 'usd' : 'cad';
  const hidden = settings.hideBalances;
  if (pf.isLoading) return <div className="space-y-5" aria-busy="true"><Skeleton h="h-[272px]" className="!rounded-[30px]" /><SkeletonRows n={3} /><SkeletonRows n={4} /></div>;
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
  // allocation: the held value per symbol (the same asset on two networks is one part)
  const bySym = new Map<string, number>(); for (const b of held) { const v = value(b); if (v > 0) bySym.set(b.symbol, (bySym.get(b.symbol) ?? 0) + v); }
  const parts = [...bySym].map(([id, v]) => ({ id, label: id, value: v }));
  const mood = hidden || dayPct === null || Math.abs(dayPct) < 0.005 ? 'flat' : dayPct > 0 ? 'up' : 'down';
  const action = (id: Tab, icon: string, label: string, main = false, disabled = false) =>
    <button onClick={() => { haptic(); go(id); }} disabled={disabled} className="press group flex min-w-0 flex-1 flex-col items-center gap-2 text-[12.5px] font-semibold disabled:opacity-40">
      <span className={`grid h-[52px] w-[52px] place-items-center rounded-full ${main ? 'hero-btn-main' : 'hero-btn'}`}><Icon n={icon} className="h-[21px] w-[21px]" /></span><span className="max-w-full truncate">{label}</span></button>;
  const rowProps = { nav, cur, ck: ck as 'usd' | 'cad', hidden, prices: d.prices, locale };
  const agents = ag.data?.agents ?? [];
  const shortcut = (onClick: () => void, icon: string, title: string, sub: string, badge?: boolean) =>
    <button onClick={onClick} className="card flex min-h-[112px] flex-col items-start justify-between gap-3 p-4 text-left">
      <span className="flex w-full items-center justify-between"><span className="relative grid h-10 w-10 shrink-0 place-items-center rounded-full bg-elev"><Icon n={icon} className="h-[19px] w-[19px]" />{badge && <span className="absolute right-0 top-0 h-2.5 w-2.5 rounded-full bg-danger ring-2 ring-surface" />}</span><Icon n="chev" className="h-4 w-4 text-mute" /></span>
      <span className="block"><span className="block text-[14.5px] font-semibold leading-tight">{title}</span><span className="mt-0.5 block text-[12px] leading-snug text-mute">{sub}</span></span></button>;
  return (
    <div className="space-y-5">
      {d.halted && <Notice tone="danger">{t('haltedBanner')}</Notice>}
      <section className="hero px-6 pb-6 pt-5" data-mood={mood}>
        <span className="hero-edge" aria-hidden="true" />
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium text-white/70">{t('totalEstimate')}</span>
          <button onClick={() => void update({ hideBalances: !hidden })} aria-label={hidden ? t('show') : t('hide')} aria-pressed={hidden} className="press -mr-2.5 grid h-11 w-11 place-items-center rounded-full text-white/75"><Icon n={hidden ? 'eyeOff' : 'eye'} /></button>
        </div>
        <div className="t-display mt-1 text-[clamp(40px,12.6vw,54px)]">
          {d.prices ? <Money hidden={hidden}><AnimatedNumber value={total} format={(v) => fiat(v, cur, locale)} /></Money> : <span className="text-2xl tracking-normal text-white/60">{t('noPrices')}</span>}
        </div>
        <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-white/70">
          {dayPct !== null && !hidden && <span className="hero-chip inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-semibold text-white">
            <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true"><path d={dayPct >= 0 ? 'M6 2l4.5 7h-9z' : 'M6 10L1.5 3h9z'} fill="currentColor" /></svg>{dayPct >= 0 ? '+' : '−'}{numFmt(Math.abs(dayPct), locale, 2, 2)} % {t('today')}</span>}
          <span className="inline-flex items-center gap-2"><span className={`inline-block h-2 w-2 rounded-full ${netState === 'ok' ? 'bg-[#35e7ac]' : netState === 'checking' ? 'pulse-dot bg-white/60' : 'bg-[#f4b65b]'}`} />
            {netState === 'checking' ? t('checking') : t('netsUp', { up, n: list.length })}</span>
        </div>
        <div className="mt-6 flex gap-2">{action('receive', 'down', t('receive'), true)}{action('send', 'up', t('send'), false, d.halted)}{action('swap', 'swap', t('swap'))}{action('agents', 'robot', t('agents'))}</div>
      </section>

      {d.pending.length > 0 && <Card><H>{t('pending')}</H>
        <ul className="space-y-3.5">{d.pending.map((p) => <li key={p.id} className="flex items-center gap-3">
          <Coin sym={p.symbol} net={p.network} size={40} />
          <div className="min-w-0 flex-1"><div className="font-semibold"><Money hidden={hidden}>{trimAmt(p.amountDisplay)} {p.symbol}</Money></div><div className="truncate text-[12.5px] text-mute">{p.networkName} → {short(p.to)}</div></div>
          {testNotSent(p) ? <span className="rounded-full bg-warn/12 px-2 py-0.5 text-[11.5px] font-semibold text-warn">{t('qaSignedNotSent')}</span> : <StatePill state={p.state} />}</li>)}</ul></Card>}

      {held.length > 0 && <Card className="!px-0 !pb-1"><div className="px-5"><H>{t('yourAssets')}</H>
          {parts.length > 1 && !hidden && <div className="mb-4"><AllocationBar parts={parts} label={t('dsAllocation')} otherLabel={t('dsOther')} pct={(s) => `${numFmt(s * 100, locale, s < 0.1 ? 1 : 0)} %`} /></div>}</div>
        <ul>{held.map((b, k) => <AssetRow key={b.network + b.asset} b={b} border={k > 0 || (parts.length > 1 && !hidden)} {...rowProps} />)}</ul></Card>}

      <Card className="!px-0 !pb-0"><div className="px-5"><H>{held.length ? t('popular') : t('assets')}</H></div>
        {/* market cards: logo, name, a real sparkline of the last 7 days, price and 24 h change (text carries the values) */}
        <ul className="no-scrollbar flex snap-x gap-3 overflow-x-auto px-5 pb-4">{featured.filter((f) => !held.includes(f)).map((b) => { const m = d.prices?.[b.symbol];
          return <li key={b.network + b.asset} className="snap-start"><button onClick={() => nav({ tab: 'asset', network: b.network, asset: b.asset })} className="press flex h-full w-[148px] flex-col rounded-[18px] border border-line bg-elev/40 p-3.5 text-left">
            <span className="flex items-center gap-2.5"><Coin sym={b.symbol} net={b.network} size={34} /><span className="min-w-0"><span className="block truncate text-[14px] font-semibold leading-tight">{b.name}</span><span className="block truncate text-[11.5px] text-mute">{b.symbol} · {b.networkName}</span></span></span>
            <span className="mt-3 block h-9">{m && <Spark data={m.spark} w={118} h={36} />}</span>
            <span className="mt-2 block text-[15px] font-semibold leading-tight">{m ? fiat(m[ck], cur, locale) : '—'}</span>
            <span className="mt-0.5 block min-h-[20px]">{m && m.change24h !== null && <Change pct={m.change24h} />}</span></button></li>; })}</ul>
        <button onClick={() => nav({ tab: 'assets' })} className="row-press flex min-h-[56px] w-full items-center justify-between rounded-b-[22px] border-t border-line px-5 py-4 text-left text-[15px] font-semibold text-blue">
          <span>{t('allAssets')} <span className="font-normal text-mute">· {t('tokensCount', { n: d.balances.length })}</span></span><Icon n="chev" className="h-5 w-5" /></button></Card>

      <div className="grid grid-cols-2 gap-3" data-testid="home-shortcuts">
        {shortcut(() => go('agents'), 'robot', t('agents'), agents.length === 0 ? t('dsAgentsNone') : agents.length === 1 ? t('dsAgents1') : t('dsAgentsN', { n: agents.length }))}
        {shortcut(() => go('futures'), 'chart', t('fxFutures'), t('dsFuturesSub'))}
        {shortcut(() => go('alerts'), 'bell', t('alTitle'), unread.unread > 0 ? t('dsAlertsUnread', { n: unread.unread }) : t('dsAlertsNone'), unread.unread > 0)}
        {shortcut(() => go('security'), 'shield', t('security'), t('dsSecuritySub'))}
      </div>

      {netState === 'partial' && <Card><H>{t('networks')}</H>
        <ul className="space-y-2.5">{list.filter((n) => n.health && !n.health.ok).map((n) => <li key={n.id} className="flex items-center justify-between text-[14px]">
          <span className="flex items-center gap-2.5"><NetDot net={n.id} size={22} />{n.name}</span>
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-warn"><Icon n="warn" className="h-3.5 w-3.5" />{n.health!.readable ? t('sendPaused') : t('unavailable')}</span></li>)}</ul>
        <p className="mt-3 text-[12.5px] text-mute">{t('partialNote')}</p></Card>}
      <p className="pb-2 text-center text-[12px] text-mute">{t('mainnet')}</p>
    </div>
  );
}
