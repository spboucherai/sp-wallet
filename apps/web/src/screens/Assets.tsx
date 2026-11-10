import { useContext, useMemo, useState } from 'react';
import type { Nav } from '../App';
import { useNetworks, usePortfolio, useSettings } from '../hooks';
import { I18n, useT } from '../i18n';
import { Card, Chips, Icon, inputCls, Skeleton } from '../ui';
import { AssetRow } from './Home';

/** Every supported asset, searchable, filterable by network. */
export function Assets({ nav }: { nav: Nav }) {
  const t = useT(); const { locale } = useContext(I18n); const { settings } = useSettings();
  const pf = usePortfolio(), nets = useNetworks();
  const [q, setQ] = useState(''), [net, setNet] = useState('');
  const cur = settings.currency, ck = (cur === 'USD' ? 'usd' : 'cad') as 'usd' | 'cad';
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (pf.data?.balances ?? []).filter((b) => (!net || b.network === net) && (!s || b.symbol.toLowerCase().includes(s) || b.name.toLowerCase().includes(s) || b.networkName.toLowerCase().includes(s)))
      .sort((a, b) => Number(b.amount !== '0' && b.amount !== null) - Number(a.amount !== '0' && a.amount !== null) || Number(b.asset === 'native') - Number(a.asset === 'native') || a.symbol.localeCompare(b.symbol));
  }, [pf.data, q, net]);
  if (!pf.data) return <Skeleton h="h-96" />;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 pt-1">
        <button onClick={() => nav({ tab: 'home' })} aria-label={t('back')} className="-ml-2 grid h-11 w-11 place-items-center rounded-full"><Icon n="chev" className="h-6 w-6 rotate-180" /></button>
        <h1 className="text-[26px] font-semibold tracking-[-0.02em]">{t('allAssets')}</h1>
      </div>
      <input className={inputCls} type="search" placeholder={t('search')} aria-label={t('search')} value={q} onChange={(e) => setQ(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <Chips label={t('network')} value={net} onChange={setNet} options={[{ id: '', label: t('all') }, ...(nets.data ?? []).map((n) => ({ id: n.id, label: n.name, net: n.id }))]} />
      <Card className="!px-0 !py-1">
        {rows.length === 0 ? <p className="px-5 py-6 text-center text-[14px] text-mute">{t('noMatch')}</p> :
          <ul>{rows.map((b, k) => <AssetRow key={b.network + b.asset} b={b} border={k > 0} nav={nav} cur={cur} ck={ck} hidden={settings.hideBalances} prices={pf.data!.prices} locale={locale} />)}</ul>}
      </Card>
    </div>
  );
}
