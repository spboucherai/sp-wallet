import { useContext, useEffect, useMemo, useState } from 'react';
import type { Nav } from '../App';
import { useNetworks, usePortfolio, useSettings, type Bal } from '../hooks';
import { I18n, useT } from '../i18n';
import { Card, Chips, EmptyState, ErrorState, Fold, Icon, inputCls, Notice, PageTitle, Skeleton, SkeletonRows } from '../ui';
import { PriceFreshness, StaleBanner } from '../freshness'; // v11; NEXT W4
import { prefKey, useAssetPrefs } from '../wallet';
import { AssetRow } from '../wallet-ui';

export type AssetFilter = 'all' | 'held' | 'fav';
const isHeld = (b: Bal): boolean => b.amount !== '0' && b.amount !== null;
/** does a row match the search? name, symbol, network (name or id) and — NEXT — the contract address (whole or a part of it, case-insensitive) */
export const matchesAsset = (b: Pick<Bal, 'symbol' | 'name' | 'networkName' | 'network' | 'asset'>, q: string): boolean => {
  const s = q.trim().toLowerCase(); if (!s) return true;
  return b.symbol.toLowerCase().includes(s) || b.name.toLowerCase().includes(s) || b.networkName.toLowerCase().includes(s) || b.network.includes(s) || (b.asset !== 'native' && s.length >= 4 && b.asset.toLowerCase().includes(s));
};

/**
 * Every supported asset: search (name, symbol, network, contract address), filters (held, favourites, network), favourites and
 * hidden assets kept on the SERVER (the three clients agree). Hiding is display only: a hidden asset is still read, still
 * counted in the total — the screen says so — and can still be opened and sent from « Masqués ».
 */
export function Assets({ nav }: { nav: Nav }) {
  const t = useT(); const { locale } = useContext(I18n); void locale; const { settings } = useSettings();
  const pf = usePortfolio(), nets = useNetworks(), prefs = useAssetPrefs();
  const [q, setQ] = useState(''), [net, setNet] = useState(''), [filter, setFilter] = useState<AssetFilter>('all'), [failed, setFailed] = useState(false);
  useEffect(() => { if (!failed) return; const h = setTimeout(() => setFailed(false), 6000); return () => clearTimeout(h); }, [failed]);
  const cur = settings.currency, ck = (cur === 'USD' ? 'usd' : 'cad') as 'usd' | 'cad';
  const pref = (b: Bal) => prefs.prefs[prefKey(b.network, b.asset)];
  const rows = useMemo(() => {
    // majors first: the market-cap rank of the price feed; assets without one go last
    const rank = (sym: string) => pf.data?.prices?.[sym]?.rank ?? 9999;
    const fav = (b: Bal) => Number(!!prefs.prefs[prefKey(b.network, b.asset)]?.favorite);
    return (pf.data?.balances ?? []).filter((b) => (!net || b.network === net) && matchesAsset(b, q) && (filter === 'all' || (filter === 'held' ? isHeld(b) : fav(b) === 1)))
      .sort((a, b) => Number(isHeld(b)) - Number(isHeld(a)) || fav(b) - fav(a) || rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol) || Number(b.asset === 'native') - Number(a.asset === 'native') || a.networkName.localeCompare(b.networkName));
  }, [pf.data, q, net, filter, prefs.prefs]);
  // NEXT W3: a failed load is an error state with a retry, not a skeleton that never ends
  if (!pf.data && pf.isError) return <div className="space-y-4" data-testid="assets-error"><PageTitle onBack={() => nav({ tab: 'home' })} backLabel={t('back')}>{t('allAssets')}</PageTitle><ErrorState title={t('nxErrLoad')} offline={(pf.error as { code?: string } | null)?.code === 'offline'} onRetry={() => void pf.refetch()}>{t('nxErrLoadBody')}</ErrorState></div>;
  if (!pf.data) return <div className="space-y-4" aria-busy="true"><Skeleton h="h-11" className="!w-48 !rounded-xl" /><Skeleton h="h-[52px]" className="!rounded-2xl" /><SkeletonRows n={7} /></div>;
  const visible = rows.filter((b) => !pref(b)?.hidden), hiddenRows = rows.filter((b) => pref(b)?.hidden);
  const held = visible.filter(isHeld), rest = visible.filter((b) => !isHeld(b));
  const nHiddenHeld = (pf.data.balances ?? []).filter((b) => isHeld(b) && pref(b)?.hidden).length;
  const change = (b: Bal, c: { hidden?: boolean; favorite?: boolean }) => { void prefs.set(b.network, b.asset, c).then((ok) => { if (!ok) setFailed(true); }); };
  const controls = (b: Bal) => { if (!prefs.available) return undefined; const p = pref(b), name = `${b.name} (${b.networkName})`;
    return <span className="flex shrink-0 items-center pr-2">
      <button type="button" aria-pressed={!!p?.favorite} aria-label={t(p?.favorite ? 'nwUnfav' : 'nwFav', { name })} data-testid="asset-fav" onClick={() => change(b, { favorite: !p?.favorite })} className={`press grid h-11 w-11 place-items-center rounded-full ${p?.favorite ? 'text-caution' : 'text-mute'}`}><Icon n={p?.favorite ? 'starFill' : 'star'} className="h-5 w-5" /></button>
      <button type="button" aria-pressed={!!p?.hidden} aria-label={t(p?.hidden ? 'nwUnhide' : 'nwHide', { name })} data-testid="asset-hide" onClick={() => change(b, { hidden: !p?.hidden })} className={`press h-11 w-11 place-items-center rounded-full text-mute ${p?.hidden ? 'grid' : 'hidden sm:grid'}`}><Icon n={p?.hidden ? 'eye' : 'eyeOff'} className="h-5 w-5" /></button></span>; };
  const row = (b: Bal) => <AssetRow key={b.network + b.asset} b={b} favorite={!!pref(b)?.favorite} trailing={controls(b)} onOpen={() => nav({ tab: 'asset', network: b.network, asset: b.asset })} cur={cur} ck={ck} hidden={settings.hideBalances} prices={pf.data!.prices} />;
  const filters = [['all', t('all')], ['held', t('nwFilterHeld')], ...(prefs.available ? [['fav', t('nwFilterFav')] as const] : [])] as readonly (readonly [AssetFilter, string])[];
  return (
    <div className="space-y-4" data-testid="assets">
      <PageTitle onBack={() => nav({ tab: 'home' })} backLabel={t('back')} right={pf.data?.prices ? <PriceFreshness at={pf.data.pricesAsOf} stale={pf.data.pricesStale} /> : undefined}>{t('allAssets')}</PageTitle>
      <StaleBanner q={pf} />
      <div className="panes panes-side space-y-4 lg:space-y-0">
        <div className="pane-sticky min-w-0 space-y-3">
          <div className="relative"><Icon n="search" className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-mute" />
            <input className={`${inputCls} !pl-11`} type="search" placeholder={t('nwAssetSearch')} aria-label={t('nwAssetSearch')} value={q} onChange={(e) => setQ(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="search" /></div>
          <div role="group" aria-label={t('nwFilters')} className="flex flex-wrap gap-2" data-testid="asset-filters">{filters.map(([id, label]) =>
            <button key={id} type="button" className="chip press" aria-pressed={filter === id} data-filter={id} onClick={() => setFilter(id)}>{id === 'fav' && <Icon n="star" className="h-4 w-4" />}{label}</button>)}</div>
          <div className="lg:[&>div]:flex-wrap lg:[&>div]:overflow-visible"><Chips label={t('network')} value={net} onChange={setNet} options={[{ id: '', label: t('all') }, ...(nets.data ?? []).map((n) => ({ id: n.id, label: n.name, net: n.id }))]} /></div>
          <p className="t-footnote reading text-mute" data-testid="registry-note">{t('nwRegistryNote')}</p>
        </div>
        <div className="min-w-0 space-y-4">
          {failed && <Notice tone="danger" testid="pref-failed">{t('nwPrefFailed')}</Notice>}
          {/* NFT (read-only): their own screen; they add no amount to the totals — their value is not available, which is not zero */}
          <button onClick={() => nav({ tab: 'nfts' })} className="card row row-press justify-between" data-testid="assets-nft-link">
            <span className="min-w-0"><span className="t-body-strong block">{t('nfTitle')}</span><span className="t-footnote block text-mute">{t('nfAssetsLine')}</span></span><Icon n="chev" className="h-5 w-5 shrink-0 text-mute" /></button>
          {rows.length === 0 ? <EmptyState icon="search" title={t('noMatch')}>{filter === 'fav' && !q ? t('nwNoFav') : undefined}</EmptyState> : <>
            {held.length > 0 && <section aria-label={t('yourAssets')} data-testid="assets-held"><h2 className="t-eyebrow mb-2 px-1">{t('yourAssets')} · {held.length}</h2><Card className="!px-0 !py-1"><ul>{held.map(row)}</ul></Card></section>}
            {rest.length > 0 && <section aria-label={t('dsSupported')} data-testid="assets-rest">{(held.length > 0 || hiddenRows.length > 0) && <h2 className="t-eyebrow mb-2 px-1">{t('dsSupported')} · {rest.length}</h2>}<Card className="!px-0 !py-1"><ul className="cv-list">{rest.map(row)}</ul></Card></section>}
          </>}
          {hiddenRows.length > 0 && <section aria-label={t('nwHiddenTitle')} data-testid="assets-hidden">
            <Fold open={!!q || filter !== 'all' || hiddenRows.length <= 4} summary={<span>{t('nwHiddenTitle')} · {hiddenRows.length}</span>}><Card className="!px-0 !py-1"><ul>{hiddenRows.map(row)}</ul></Card></Fold>
            <p className="t-footnote mt-2 px-1 text-mute" data-testid="hidden-note">{t(nHiddenHeld > 0 ? 'nwHiddenNoteHeld' : 'nwHiddenNote')}</p></section>}
        </div>
      </div>
    </div>
  );
}
