import { useQuery } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { get } from '../api';
import { useNetworks, useSettings } from '../hooks';
import { I18n, useT } from '../i18n';
import { BridgeFacts, BridgePill, BridgeProgress, type BridgeV } from '../bridge';
import { XswapFacts, XswapPill, XswapProgress, type XswapV } from '../xswap';
import { useQueryClient } from '@tanstack/react-query';
import { PlanList } from '../plan'; // v7 any-to-any plans
import { Addr, Card, Coin, EmptyState, exactAmt, Icon, inputCls, Money, PageTitle, Seg, short, SkeletonRows, StatePill, testNotSent, trimAmt } from '../ui';

interface Item { swap?: { toSymbol: string; receivedDisplay: string | null; minOutDisplay: string } | null; bridge?: BridgeV | null; xswap?: XswapV | null; kind: 'send' | 'receive' | 'swap' | 'bridge'; at: string; id: string; network: string; networkName: string; symbol: string; amount: string; amountDisplay: string; state: string; txid: string | null; explorer: string | null;
  to?: string; from?: string; feeDisplay?: string | null; feeSymbol?: string; error?: string | null; note?: string; confirmations?: number }

export function Activity() {
  const t = useT(); const { locale } = useContext(I18n); const { settings } = useSettings(); const nets = useNetworks();
  const q = useQuery({ queryKey: ['activity'], queryFn: () => get<{ items: Item[] }>('/activity?limit=200'), refetchInterval: 20_000 });
  const qc = useQueryClient();
  const [kind, setKind] = useState<'all' | 'send' | 'receive'>('all'), [net, setNet] = useState(''), [open, setOpen] = useState('');
  const items = (q.data?.items ?? []).filter((i) => (kind === 'all' || i.kind === kind || (kind === 'send' && (i.kind === 'swap' || i.kind === 'bridge'))) && (!net || i.network === net));
  // grouped by calendar day (the device's own): "Aujourd'hui", "Hier", then the date in full
  const loc = locale === 'fr' ? 'fr-CA' : 'en-CA', dayKey = (d: string) => new Date(d).toLocaleDateString('en-CA');
  const today = dayKey(new Date().toISOString()), yesterday = dayKey(new Date(Date.now() - 86_400_000).toISOString());
  const dayLabel = (k: string, at: string) => k === today ? t('dsToday') : k === yesterday ? t('dsYesterday') : new Date(at).toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long', ...(k.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}) });
  const groups: { key: string; label: string; items: Item[] }[] = [];
  for (const i of items) { const k = dayKey(i.at); const g = groups[groups.length - 1]; if (g && g.key === k) g.items.push(i); else groups.push({ key: k, label: dayLabel(k, i.at), items: [i] }); }
  const time = (d: string) => new Date(d).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="space-y-4">
      <PageTitle>{t('activity')}</PageTitle>
      <div className="flex gap-2">
        <div className="flex-1"><Seg role="tablist" value={kind} onChange={setKind} options={[['all', t('all')], ['send', t('sent')], ['receive', t('received')]] as const} /></div>
        <select aria-label={t('network')} className={`${inputCls} w-auto max-w-[42%] py-2`} value={net} onChange={(e) => setNet(e.target.value)}><option value="">{t('allNetworks')}</option>{(nets.data ?? []).map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</select>
      </div>
      <PlanList />
      {q.isLoading ? <SkeletonRows n={5} /> : items.length === 0 ? <EmptyState icon="clock" title={t('noActivity')}>{t('dsNoActivityBody')}</EmptyState> :
        groups.map((g) => <section key={g.key} aria-label={g.label}><h2 className="t-eyebrow mb-2 px-1">{g.label}</h2>
        <Card className="!p-0 overflow-hidden"><ul className="divide-y divide-line">{g.items.map((i) => { const isOpen = open === i.id; return (
          <li key={i.id}>
            <button className="row-press flex min-h-[68px] w-full items-center gap-3 px-4 py-3 text-left" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? '' : i.id)}>
              <Coin sym={i.symbol} net={i.network} size={42} />
              <span className="min-w-0 flex-1"><span className="block font-medium">{i.kind === 'bridge' ? `${t('brActivity')} · ${i.symbol} → ${i.bridge?.toNetworkName ?? ''}` : i.kind === 'swap' ? `${t('swap')} · ${i.symbol} → ${i.swap?.toSymbol ?? ''}` : `${i.kind === 'receive' ? t('received') : t('sent')} · ${i.symbol}`}</span>
                <span className="block truncate text-xs text-mute">{i.networkName} · {time(i.at)}</span></span>
              <span className="text-right"><span className={`block font-semibold ${i.kind === 'receive' ? 'text-emerald' : ''}`}><Money hidden={settings.hideBalances}>{i.kind === 'receive' ? '+' : '−'}{trimAmt(i.amountDisplay)}</Money></span>{testNotSent(i) ? <span className="rounded-full bg-warn/12 px-2 py-0.5 text-[11.5px] font-semibold text-warn">{t('qaSignedNotSent')}</span> : i.kind === 'bridge' && i.bridge ? <BridgePill b={i.bridge} /> : i.xswap ? <XswapPill x={i.xswap} /> : <StatePill state={i.state} />}</span>
            </button>
            {isOpen && <div className="space-y-2.5 border-t border-line bg-bg/60 px-4 py-3 text-[13px]">
              <D k={t('amount')}>{exactAmt(i.amountDisplay)} {i.symbol} <span className="text-mute">({i.amount} {t('baseUnits')})</span></D>
              {i.xswap && <dl className="space-y-1.5"><XswapFacts x={i.xswap} symbol={i.symbol} fromName={i.networkName} /></dl>}
              {i.xswap && <XswapProgress id={i.id} x={i.xswap} symbol={i.symbol} onUpdate={() => void qc.invalidateQueries({ queryKey: ['activity'] })} />}
              {i.kind === 'swap' && i.swap && !i.xswap && <D k={i.swap.receivedDisplay ? t('swReceived') : t('swMinGuaranteed')}>{exactAmt(i.swap.receivedDisplay ?? i.swap.minOutDisplay)} {i.swap.toSymbol}</D>}
              {i.kind === 'bridge' && i.bridge && <dl className="space-y-1.5"><BridgeFacts b={i.bridge} symbol={i.symbol} /></dl>}
              {i.kind === 'bridge' && i.bridge && !testNotSent(i) && <BridgeProgress id={i.id} b={i.bridge} onUpdate={() => void qc.invalidateQueries({ queryKey: ['activity'] })} />}
              {i.to && i.kind !== 'swap' && i.kind !== 'bridge' && <D k={t('to')}><Addr value={i.to} /></D>}
              {i.from && i.kind === 'receive' && <D k={t('from')}><span className="font-mono">{short(i.from)}</span></D>}
              {i.feeDisplay && <D k={t('fee')}>≈ {trimAmt(i.feeDisplay, 9)} {i.feeSymbol}</D>}
              <D k={t('time')}>{new Date(i.at).toISOString()}</D>
              {i.note && <D k={t('note')}>{i.note}</D>}
              {testNotSent(i) ? <D k={t('status')}><span className="text-warn">{t('qaTestNotSent')}</span></D> : i.error && <D k={t('error')}><span className="text-danger">{i.error}</span></D>}
              {i.txid && <D k={t('txid')}><span className="break-all font-mono text-[11.5px]">{i.txid}</span></D>}
              {i.explorer && !testNotSent(i) && <a className="inline-flex min-h-11 items-center gap-1.5 text-blue" href={i.explorer} target="_blank" rel="noreferrer noopener"><Icon n="ext" className="h-4 w-4" />{t('viewExplorer')}</a>}
            </div>}
          </li>); })}</ul></Card></section>)}
    </div>
  );
}
function D({ k, children }: { k: string; children: React.ReactNode }) { return <div><div className="text-[11.5px] uppercase tracking-wide text-mute">{k}</div><div>{children}</div></div>; }
