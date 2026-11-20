import { useContext, useMemo, useState } from 'react';
import type { Nav } from '../App';
import { useNetworks, usePortfolio, useSettings } from '../hooks';
import { I18n, useT } from '../i18n';
import { Card, Chips, EmptyState, ErrorState, Icon, inputCls, PageTitle, Skeleton, SkeletonRows } from '../ui';
import { AssetRow } from './Home';
import { PriceFreshness, StaleBanner } from '../freshness'; // v11; NEXT W4

/** Every supported asset, searchable, filterable by network; what the wallet holds comes first, under its own heading. */
export function Assets({ nav }: { nav: Nav }) {
  const t = useT(); const { locale } = useContext(I18n); const { settings } = useSettings();
  const pf = usePortfolio(), nets = useNetworks();
  const [q, setQ] = useState(''), [net, setNet] = useState('');
  const cur = settings.currency, ck = (cur === 'USD' ? 'usd' : 'cad') as 'usd' | 'cad';
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    // majors first: the market-cap rank of the price feed; assets without one go last
    const rank = (sym: string) => pf.data?.prices?.[sym]?.rank ?? 9999;
    return (pf.data?.balances ?? []).filter((b) => (!net || b.network === net) && (!s || b.symbol.toLowerCase().includes(s) || b.name.toLowerCase().includes(s) || b.networkName.toLowerCase().includes(s)))
      .sort((a, b) => Number(b.amount !== '0' && b.amount !== null) - Number(a.amount !== '0' && a.amount !== null) || rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol) || Number(b.asset === 'native') - Number(a.asset === 'native') || a.networkName.localeCompare(b.networkName));
  }, [pf.data, q, net]);
  // NEXT W3: a failed load is an error state with a retry, not a skeleton that never ends
  if (!pf.data && pf.isError) return <div className="space-y-4" data-testid="assets-error"><PageTitle onBack={() => nav({ tab: 'home' })} backLabel={t('back')}>{t('allAssets')}</PageTitle><ErrorState title={t('nxErrLoad')} offline={(pf.error as { code?: string } | null)?.code === 'offline'} onRetry={() => void pf.refetch()}>{t('nxErrLoadBody')}</ErrorState></div>;
  if (!pf.data) return <div className="space-y-4" aria-busy="true"><Skeleton h="h-11" className="!w-48 !rounded-xl" /><Skeleton h="h-[52px]" className="!rounded-2xl" /><SkeletonRows n={7} /></div>;
  const held = rows.filter((b) => b.amount !== '0' && b.amount !== null), rest = rows.filter((b) => !(b.amount !== '0' && b.amount !== null));
  const row = (b: (typeof rows)[number], k: number) => <AssetRow key={b.network + b.asset} b={b} border={k > 0} nav={nav} cur={cur} ck={ck} hidden={settings.hideBalances} prices={pf.data!.prices} locale={locale} />;
  return (
    <div className="space-y-4">
      <PageTitle onBack={() => nav({ tab: 'home' })} backLabel={t('back')} right={pf.data?.prices ? <PriceFreshness at={pf.data.pricesAsOf} stale={pf.data.pricesStale} /> : undefined}>{t('allAssets')}</PageTitle>
      <StaleBanner q={pf} />
      <div className="relative"><Icon n="search" className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-mute" />
        <input className={`${inputCls} !pl-11`} type="search" placeholder={t('search')} aria-label={t('search')} value={q} onChange={(e) => setQ(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="search" /></div>
      <Chips label={t('network')} value={net} onChange={setNet} options={[{ id: '', label: t('all') }, ...(nets.data ?? []).map((n) => ({ id: n.id, label: n.name, net: n.id }))]} />
      {/* NFT (read-only): their own screen; they add no amount to the totals — their value is not available, which is not zero */}
      <button onClick={() => nav({ tab: 'nfts' })} className="card row-press flex min-h-[60px] w-full items-center justify-between gap-3 px-5 py-3.5 text-left" data-testid="assets-nft-link">
        <span className="min-w-0"><span className="block text-[15.5px] font-semibold">{t('nfTitle')}</span><span className="block text-[12.5px] text-mute">{t('nfAssetsLine')}</span></span><Icon n="chev" className="h-5 w-5 shrink-0 text-mute" /></button>
      {rows.length === 0 ? <EmptyState icon="search" title={t('noMatch')} /> : <>
        {held.length > 0 && <section aria-label={t('yourAssets')}><h2 className="t-eyebrow mb-2 px-1">{t('yourAssets')} · {held.length}</h2><Card className="!px-0 !py-1"><ul>{held.map(row)}</ul></Card></section>}
        {rest.length > 0 && <section aria-label={t('dsSupported')}>{held.length > 0 && <h2 className="t-eyebrow mb-2 px-1">{t('dsSupported')} · {rest.length}</h2>}<Card className="!px-0 !py-1"><ul className="cv-list">{rest.map(row)}</ul></Card></section>}
      </>}
    </div>
  );
}
