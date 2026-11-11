import { useQuery } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { get } from '../api';
import { useNetworks, useSettings } from '../hooks';
import { I18n, useT } from '../i18n';
import { BridgeFacts, BridgePill, BridgeProgress, type BridgeV } from '../bridge';
import { XswapFacts, XswapPill, XswapProgress, type XswapV } from '../xswap';
import { useQueryClient } from '@tanstack/react-query';
import { PlanList } from '../plan'; // v7 any-to-any plans
import { Addr, Card, Coin, exactAmt, Icon, inputCls, Money, short, Skeleton, StatePill, testNotSent, trimAmt, when } from '../ui';

interface Item { swap?: { toSymbol: string; receivedDisplay: string | null; minOutDisplay: string } | null; bridge?: BridgeV | null; xswap?: XswapV | null; kind: 'send' | 'receive' | 'swap' | 'bridge'; at: string; id: string; network: string; networkName: string; symbol: string; amount: string; amountDisplay: string; state: string; txid: string | null; explorer: string | null;
  to?: string; from?: string; feeDisplay?: string | null; feeSymbol?: string; error?: string | null; note?: string; confirmations?: number }

export function Activity() {
  const t = useT(); const { locale } = useContext(I18n); const { settings } = useSettings(); const nets = useNetworks();
  const q = useQuery({ queryKey: ['activity'], queryFn: () => get<{ items: Item[] }>('/activity?limit=200'), refetchInterval: 20_000 });
  const qc = useQueryClient();
  const [kind, setKind] = useState<'all' | 'send' | 'receive'>('all'), [net, setNet] = useState(''), [open, setOpen] = useState('');
  const items = (q.data?.items ?? []).filter((i) => (kind === 'all' || i.kind === kind || (kind === 'send' && (i.kind === 'swap' || i.kind === 'bridge'))) && (!net || i.network === net));
  return (
    <div className="space-y-4">
      <h1 className="pt-2 text-[30px] font-semibold tracking-[-0.02em]">{t('activity')}</h1>
      <div className="flex gap-2">
        <div className="flex flex-1 rounded-2xl bg-elev p-1" role="tablist">{(['all', 'send', 'receive'] as const).map((k) =>
          <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)} className={`min-h-11 flex-1 rounded-xl text-[13.5px] ${kind === k ? 'bg-surface font-semibold shadow-sm' : 'text-mute'}`}>{t(k === 'all' ? 'all' : k === 'send' ? 'sent' : 'received')}</button>)}</div>
        <select aria-label={t('network')} className={`${inputCls} w-auto max-w-[42%] py-2`} value={net} onChange={(e) => setNet(e.target.value)}><option value="">{t('allNetworks')}</option>{(nets.data ?? []).map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</select>
      </div>
      <PlanList />
      {q.isLoading ? <Skeleton h="h-48" /> : items.length === 0 ? <Card><p className="py-6 text-center text-sm text-mute">{t('noActivity')}</p></Card> :
        <Card className="!p-0"><ul className="divide-y divide-line">{items.map((i) => { const isOpen = open === i.id; return (
          <li key={i.id}>
            <button className="flex w-full items-center gap-3 px-4 py-3.5 text-left" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? '' : i.id)}>
              <Coin sym={i.symbol} net={i.network} size={42} />
              <span className="min-w-0 flex-1"><span className="block font-medium">{i.kind === 'bridge' ? `${t('brActivity')} · ${i.symbol} → ${i.bridge?.toNetworkName ?? ''}` : i.kind === 'swap' ? `${t('swap')} · ${i.symbol} → ${i.swap?.toSymbol ?? ''}` : `${i.kind === 'receive' ? t('received') : t('sent')} · ${i.symbol}`}</span>
                <span className="block truncate text-xs text-mute">{i.networkName} · {when(i.at, locale)}</span></span>
              <span className="text-right"><span className={`block font-semibold ${i.kind === 'receive' ? 'text-emerald' : ''}`}><Money hidden={settings.hideBalances}>{i.kind === 'receive' ? '+' : '−'}{trimAmt(i.amountDisplay)}</Money></span>{testNotSent(i) ? <span className="rounded-full bg-warn/12 px-2 py-0.5 text-[11.5px] font-semibold text-warn">{t('qaSignedNotSent')}</span> : i.kind === 'bridge' && i.bridge ? <BridgePill b={i.bridge} /> : i.xswap ? <XswapPill x={i.xswap} /> : <StatePill state={i.state} />}</span>
            </button>
            {isOpen && <div className="space-y-2.5 border-t border-line bg-bg/60 px-4 py-3 text-[13px]">
              <D k={t('amount')}>{exactAmt(i.amountDisplay)} {i.symbol} <span className="text-mute">({i.amount} {t('baseUnits')})</span></D>
              {i.xswap && <dl className="space-y-1.5"><XswapFacts x={i.xswap} symbol={i.symbol} fromName={i.networkName} /></dl>}
              {i.xswap && <XswapProgress id={i.id} x={i.xswap} symbol={i.symbol} onUpdate={() => void qc.invalidateQueries({ queryKey: ['activity'] })} />}
              {i.kind === 'swap' && i.swap && !i.xswap && <D k={i.swap.receivedDisplay ? t('swReceived') : t('swMinGuaranteed')}>{i.swap.receivedDisplay ?? i.swap.minOutDisplay} {i.swap.toSymbol}</D>}
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
          </li>); })}</ul></Card>}
    </div>
  );
}
function D({ k, children }: { k: string; children: React.ReactNode }) { return <div><div className="text-[11.5px] uppercase tracking-wide text-mute">{k}</div><div>{children}</div></div>; }
