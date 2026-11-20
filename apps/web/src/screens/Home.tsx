import { lazy, Suspense, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Nav, Tab } from '../App';
import { portfolioGaps, sendBlock, sendBlockKey, useNetworks, usePortfolio, useSettings, type Bal, type Portfolio } from '../hooks';
import { I18n, useT } from '../i18n';
import { cmpDecimal, fiatText, pctText, signOf } from '../money';
import { Card, Coin, EmptyState, ErrorState, H, haptic, Icon, Money, NetDot, Notice, short, Skeleton, SkeletonRows, StatusPill, trimAmt, when } from '../ui';
import { clockText, PriceFreshness, StaleBanner } from '../freshness'; // v11; NEXT W4: balance read time, « not up to date since »
import { LiveSpotTag, overlaySpot, useLiveSpot } from '../quotes-spot'; // v11 live quotes (the quote client itself is fetched on demand)
import { summaryOf, useAssetPrefs, prefKey, type Range, type Summary } from '../wallet';
import { AssetRow, ChangeText, rowValue } from '../wallet-ui';

// v11 interface: Home is the Dashboard. NEXT (design system §5): the balance card, the value history, the allocation, the
// assets held, the recent activity and the tiles — every figure of them from the SERVER (`summary`, /portfolio/history).
// The consolidated panels of v11 (derivative accounts, agents, P&L, risk, system status) stay a chunk of their own, under it.
const DashboardPanels = lazy(() => import('./Dashboard').then((m) => ({ default: m.DashboardPanels })));
// NEXT: what the first paint does not need of the dashboard — the value history, the allocation, the attention strip, the recent
// activity and the tiles — is one chunk (HomeMore.tsx), asked for as soon as Home mounts; its place is held by skeletons.
const more = () => import('./HomeMore');
const HomeValue = lazy(() => more().then((m) => ({ default: m.HomeValue })));
const HomeAttention = lazy(() => more().then((m) => ({ default: m.HomeAttention })));
const HomeRecent = lazy(() => more().then((m) => ({ default: m.HomeRecent })));
const HomePopular = lazy(() => more().then((m) => ({ default: m.HomePopular })));
const FEATURED = ['USDC', 'BTC', 'ETH', 'SOL', 'USDT'];
const RANGE_KEY = 'spw-range';
const held = (b: Bal): boolean => b.amount !== null && b.amount !== '0';

/** the total of a server older than `summary`: the sum of what could be valued, as a decimal string (the client then says it is its own estimate) */
function clientTotal(p: Portfolio, ck: 'usd' | 'cad'): string | null {
  if (!p.prices) return null;
  let cents = 0n; for (const b of p.balances) { const v = rowValue(b, p.prices, ck); if (v !== null) cents += BigInt(v.replace('.', '')); }
  const s = cents.toString().padStart(3, '0'); return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

/**
 * Balance card (design system §4): the aurora over the hero base, eyebrow · display amount · change chip (absolute + %, sign and
 * arrow, the period named) · freshness line · quick actions. The amount shrinks with the viewport and WRAPS rather than be cut.
 */
function BalanceCard({ p, s, total, own, hidden, cur, onHide, pfError, gaps, actions, children }: { p: Portfolio; s: Summary | null; total: string | null; own: boolean; hidden: boolean; cur: string; onHide: () => void; pfError: boolean;
  gaps: { partial: boolean; missing: string[] }; actions: ReactNode; children?: ReactNode }) {
  const t = useT(); const { locale } = useContext(I18n); const { settings } = useSettings();
  const partial = gaps.partial || (s ? !s.complete : false), ch = s?.change24h ?? null;
  return (
    <section className="balance-card px-6 pb-6 pt-5" data-testid="balance-card" data-complete={s ? String(s.complete) : ''} aria-label={t('totalEstimate')}>
      <div className="flex items-center justify-between gap-2">
        <span className="t-eyebrow bc-mute !text-[var(--hero-mute)]">{t('totalEstimate')}</span>
        <button onClick={onHide} aria-label={hidden ? t('show') : t('hide')} aria-pressed={hidden} data-testid="hide-balances" className="press bc-icon-btn -mr-2.5"><Icon n={hidden ? 'eyeOff' : 'eye'} /></button>
      </div>
      <div className="t-display amt mt-1 text-[clamp(2.25rem,11.5vw,3.25rem)]" data-testid="total" data-total={total ?? ''}>
        {total !== null ? (hidden ? <span aria-label={t('nwHiddenAmount')}>••••</span> : fiatText(total, cur, locale)) : <span className="t-title2 bc-mute">{t(settings.prices ? 'dzPricesAway' : 'noPrices')}</span>}
      </div>
      <div className="t-footnote mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        {partial && total !== null && <span className="bc-chip" data-testid="total-partial"><Icon n="warn" className="h-3 w-3" />{t('nxPartialTotal')}</span>}
        {ch && !hidden && <span className="bc-chip" data-testid="change-chip" title={t('nwChange24hNote')}>
          <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true"><path d={signOf(ch.abs) >= 0 ? 'M6 2l4.5 7h-9z' : 'M6 10L1.5 3h9z'} fill="currentColor" /></svg>
          {fiatText(ch.abs, cur, locale, { sign: true })} ({pctText(ch.pct, locale, 2, 2, true)}) · {t('nwOn24h')}</span>}
        {own && total !== null && <span className="bc-mute">{t('nwOwnSum')}</span>}
      </div>
      <div className="t-footnote bc-mute mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`inline-flex items-center gap-1.5 ${pfError ? 'font-semibold text-[var(--hero-ink)]' : ''}`} data-testid="balances-at"><Icon n={pfError ? 'warn' : 'clock'} className="h-3.5 w-3.5" />{t('nxBalancesAt', { time: clockText(p.asOf, locale) })}</span>
        {partial && <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--hero-ink)]" data-testid="freshness-partial"><Icon n="warn" className="h-3.5 w-3.5" />{gaps.missing.length > 0 ? t(gaps.missing.length === 1 ? 'nwPartialNets1' : 'nwPartialNets', { n: gaps.missing.length }) : t('nwPartialOther')}</span>}
        {p.prices && <PriceFreshness hero at={p.pricesAsOf} stale={p.pricesStale} />}
        {children}
      </div>
      <div className="mt-6 flex gap-2" role="group" aria-label={t('nwQuick')}>{actions}</div>
    </section>);
}

export function Home({ go, nav }: { go: (t: Tab) => void; nav: Nav }) {
  const t = useT(); const { locale } = useContext(I18n);
  const pf = usePortfolio(), nets = useNetworks(); const { settings, update } = useSettings();
  const prefs = useAssetPrefs();
  const cur = settings.currency, ck = cur === 'USD' ? 'usd' : 'cad';
  const hidden = settings.hideBalances;
  const [range, setRangeState] = useState<Range>(() => { try { const v = sessionStorage.getItem(RANGE_KEY); return (['1D', '1W', '1M', '3M', '1Y', 'ALL'] as const).find((r) => r === v) ?? '1W'; } catch { return '1W'; } });
  const setRange = (r: Range) => { setRangeState(r); try { sessionStorage.setItem(RANGE_KEY, r); } catch { /* this tab only */ } };
  // v11 live quotes: streamed USD prices on top of the polled ones, for the ROWS (held assets first, 40 symbols at most). The total is the server's.
  const liveSyms = useMemo(() => [...new Set([...(pf.data?.balances ?? [])].sort((a, b) => Number(held(b)) - Number(held(a))).map((b) => b.symbol))].slice(0, 40), [pf.data?.balances]);
  const live = useLiveSpot(pf.data?.prices ? liveSyms : []);
  if (pf.isLoading) return <div className="grid gap-5 lg:grid-cols-2" aria-busy="true"><div className="space-y-5"><Skeleton h="h-[272px]" className="!rounded-[var(--radius-xl)]" /><Skeleton h="h-[330px]" /></div><div className="space-y-5"><SkeletonRows n={3} /><SkeletonRows n={4} /></div></div>;
  // NEXT W3: nothing could be read — an error state with a retry, not a bare line
  if (!pf.data) return <div data-testid="home" data-state="error"><ErrorState title={t('nxErrLoad')} offline={(pf.error as { code?: string } | null)?.code === 'offline'} onRetry={() => void pf.refetch()}>{t('nxErrLoadBody')}</ErrorState></div>;
  const d = pf.data, s = summaryOf(d), rowPrices = overlaySpot(d.prices, live);
  const nLive = rowPrices ? Object.values(rowPrices).filter((m) => m.live).length : 0;
  const total = s ? s.total : clientTotal(d, ck);
  // NEXT W4: a network whose balance could not be read is not zero — the total is then labelled partial; W5: one rule for « send »
  const gaps = portfolioGaps(d), block = sendBlock(d);
  const netName = (id: string) => nets.data?.find((n) => n.id === id)?.name ?? d.balances.find((b) => b.network === id)?.networkName ?? id;
  const isHidden = (b: Bal) => !!prefs.prefs[prefKey(b.network, b.asset)]?.hidden, isFav = (b: Bal) => !!prefs.prefs[prefKey(b.network, b.asset)]?.favorite;
  const all = d.balances.filter(held), shown = all.filter((b) => !isHidden(b)).sort((a, b) => Number(isFav(b)) - Number(isFav(a)) || cmpDecimal(rowValue(b, d.prices, ck), rowValue(a, d.prices, ck)));
  const nHidden = all.length - shown.length;
  // nothing held yet: show a short list of well-known assets (one per symbol) with live prices instead of a wall of zeros
  const featured = FEATURED.flatMap((sym) => { const c = d.balances.filter((b) => b.symbol === sym); // the native coin; else the original issue rather than a bridged or pegged copy (USDT on Base is "Bridged USDT"); USDC stays on Base, where this wallet lives
    const orig = (b: Bal) => !/bridged|binance-peg|\(.*bridge.*\)/i.test(b.name);
    return c.length ? [c.find((b) => b.asset === 'native') ?? (sym === 'USDC' ? c.find((b) => b.network === 'base') : undefined) ?? c.find((b) => b.network === 'ethereum' && orig(b)) ?? c.find(orig) ?? c[0]!] : []; });
  const list = nets.data ?? [], checked = list.filter((n) => n.health), up = checked.filter((n) => n.health!.ok).length;
  const netState = checked.length < list.length || list.length === 0 ? 'checking' : up === list.length ? 'ok' : 'partial';
  const action = (id: Tab, icon: string, label: string, main = false, disabled = false) =>
    <button onClick={() => { haptic(); go(id); }} disabled={disabled} className="press group flex min-w-0 flex-1 flex-col items-center gap-2 text-[0.78125rem] font-semibold disabled:opacity-40">
      <span className={`grid h-[52px] w-[52px] place-items-center rounded-full ${main ? 'hero-btn-main' : 'hero-btn'}`}><Icon n={icon} className="h-[21px] w-[21px]" /></span><span className="max-w-full truncate">{label}</span></button>;
  const rowProps = { cur, ck: ck as 'usd' | 'cad', hidden, prices: rowPrices };
  const uncertain = s?.uncertain ?? [], unpriced = s?.unpriced ?? [];
  return (
    <div className="space-y-5" data-testid="home">
      <StaleBanner q={pf} />
      {d.halted && <Notice tone="danger">{t('haltedBanner')}</Notice>}
      {/* v11: the signer node is unreachable — the page still renders from the server's own balance reads, and says what that means */}
      {d.signer && !d.signer.reachable && <Notice tone="warn"><span data-testid="signer-down">{t('svSignerDown', { date: when(d.signer.addressesAsOf, locale) })}</span></Notice>}
      <div className="space-y-5 lg:grid lg:grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)] lg:items-start lg:gap-5 lg:space-y-0" data-testid="dash-columns"><div className="min-w-0 space-y-5">
        <BalanceCard p={d} s={s} total={total} own={!s} hidden={hidden} cur={cur} pfError={pf.isError} gaps={gaps} onHide={() => void update({ hideBalances: !hidden })}
          actions={<>{action('receive', 'arrowDown', t('receive'), true)}{action('send', 'arrowUp', t('send'), false, block !== null)}{action('swap', 'swap', t('swap'))}{action('agents', 'robot', t('agents'))}</>}>
          <span className="inline-flex items-center gap-2"><span className={`inline-block h-2 w-2 rounded-full ${netState === 'ok' ? 'bg-positive' : netState === 'checking' ? 'pulse-dot bg-[var(--hero-mute)]' : 'bg-caution'}`} style={netState === 'ok' ? { background: 'var(--series-s3)' } : undefined} />
            {netState === 'checking' ? t('checking') : t('netsUp', { up, n: list.length })}</span>
          {nLive > 0 && <LiveSpotTag hero n={nLive} converted={ck !== 'usd'} />}
        </BalanceCard>
        {block && <Notice tone="warn"><span data-testid="send-blocked">{t(sendBlockKey(block))}</span></Notice>}
        {gaps.partial && <Notice tone="warn"><span data-testid="partial-note">{t('nxPartialBody', { nets: gaps.missing.join(', ') || '—' })}</span></Notice>}
        {uncertain.length > 0 && <Notice tone="warn"><span data-testid="uncertain-note">{t('nwUncertainBody', { list: [...new Set(uncertain.map((u) => netName(u.network)))].join(', ') })}</span></Notice>}
        {unpriced.length > 0 && <Notice tone="info"><span data-testid="unpriced-note">{t('nwUnpricedBody', { syms: [...new Set(unpriced.map((u) => u.symbol))].join(', ') })}</span></Notice>}

        <div className="lg:hidden"><Suspense fallback={null}><HomeAttention pending={d.pending} nav={nav} go={go} /></Suspense></div>
        <Suspense fallback={<div className="space-y-5" aria-busy="true"><Skeleton h="h-[23rem]" /><Skeleton h="h-40" /></div>}><HomeValue range={range} setRange={setRange} cur={cur} hidden={hidden} summary={s} netName={netName} /></Suspense>

        {shown.length > 0 ? <Card className="!px-0 !pb-0"><div className="px-[var(--card-padding)]"><H right={<button className="link -my-2" data-testid="see-all-assets" onClick={() => nav({ tab: 'assets' })}>{t('nwSeeAll')}<Icon n="chev" className="h-4 w-4" /></button>}>{t('nwHeld')}</H></div>
          <ul data-testid="held-assets">{shown.slice(0, 6).map((b) => <AssetRow key={b.network + b.asset} b={b} favorite={isFav(b)} onOpen={() => nav({ tab: 'asset', network: b.network, asset: b.asset })} {...rowProps} />)}</ul>
          {(shown.length > 6 || nHidden > 0) && <p className="t-footnote border-t border-line px-[var(--card-padding)] py-3 text-mute" data-testid="held-more">{[shown.length > 6 ? t('nwHeldMore', { n: shown.length - 6 }) : '', nHidden > 0 ? t(nHidden === 1 ? 'nwHiddenCounted1' : 'nwHiddenCounted', { n: nHidden }) : ''].filter(Boolean).join(' ')}</p>}</Card>
          : all.length === 0 && <EmptyState icon="down" title={t('nwEmptyTitle')} action={<button className="btn press inline-flex min-h-12 items-center rounded-[var(--radius-md)] bg-primary px-5 font-semibold text-onprimary" onClick={() => go('receive')}>{t('receive')}</button>}>{t('nwEmptyBody')}</EmptyState>}
      </div><div className="min-w-0 space-y-5">
        <div className="hidden lg:block"><Suspense fallback={null}><HomeAttention pending={d.pending} nav={nav} go={go} /></Suspense></div>

        {d.pending.length > 0 && <Card><H>{t('pending')}</H>
          <ul className="space-y-3.5">{d.pending.map((p) => <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Coin sym={p.symbol} net={p.network} size={40} />
            <div className="min-w-0 flex-1"><div className="t-body-strong amt"><Money hidden={hidden}>{trimAmt(p.amountDisplay)} {p.symbol}</Money></div><div className="t-footnote truncate text-mute">{/* v11: a GMX order transaction is not a transfer to the router's address */ (p as { kind?: string }).kind === 'gmx' ? `${t('svKind_gmx')} · ${p.networkName}` : `${p.networkName} → ${short(p.to)}`}</div></div>
            <StatusPill of={p} /></li>)}</ul></Card>}

        <Suspense fallback={<SkeletonRows n={4} />}><HomeRecent range={range} cur={cur} hidden={hidden} nav={nav} go={go} netName={netName} /></Suspense>

        <Suspense fallback={null}><HomePopular featured={featured.filter((f) => !all.includes(f))} title={all.length ? t('popular') : t('assets')} prices={rowPrices} ck={ck} cur={cur} count={d.balances.length} nav={nav} /></Suspense>

        {/* NFT: reachable from the first screen (they were only linked from « all assets », where the owner did not find them) */}
        <button onClick={() => nav({ tab: 'nfts' })} className="card row row-press justify-between" data-testid="home-nft-link">
          <span className="min-w-0"><span className="t-body-strong block">{t('nfTitle')}</span><span className="t-footnote block text-mute">{t('nfAssetsLine')}</span></span><Icon n="chev" className="h-5 w-5 shrink-0 text-mute" /></button>
      </div></div>

      {/* v11: the consolidated view — each panel loads, fails and refreshes on its own */}
      <Suspense fallback={<div className="grid gap-4 lg:grid-cols-2" aria-busy="true"><SkeletonRows n={3} /><SkeletonRows n={3} /></div>}><DashboardPanels nav={nav} /></Suspense>

      {netState === 'partial' && <Card><H>{t('networks')}</H>
        <ul className="space-y-2.5">{list.filter((n) => n.health && !n.health.ok).map((n) => <li key={n.id} className="t-callout flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="flex items-center gap-2.5"><NetDot net={n.id} size={22} />{n.name}</span>
          <span className="t-footnote inline-flex items-center gap-1.5 text-caution"><Icon n="warn" className="h-3.5 w-3.5" />{n.health!.readable ? t('sendPaused') : t('unavailable')}</span></li>)}</ul>
        <p className="t-footnote mt-3 text-mute">{t('partialNote')}</p></Card>}
      <p className="t-footnote pb-2 text-center text-mute">{t('mainnet')}</p>
    </div>
  );
}
