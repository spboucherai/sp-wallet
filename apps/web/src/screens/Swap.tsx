import { useQuery } from '@tanstack/react-query';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { get } from '../api';
import { usePortfolio, useSettings } from '../hooks';
import { I18n, useT, type Key } from '../i18n';
import { Card, Coin, fiat, Icon, inputCls, NetDot, Notice, trimAmt } from '../ui';

interface SAsset { key: string; network: string; networkName: string; asset: string; symbol: string; name: string; decimals: number; native?: boolean }
interface Fee { kind: string; symbol: string; network: string; display: string; includedInOutput: boolean; estimated: boolean; usd: number | null }
interface RouteV { id: string; providers: string[]; path: SAsset[]; tags: string[]; pareto: boolean; amountOutDisplay: string; minAmountOutDisplay: string; estimatedSeconds: number | null; expiresAt: number;
  executability: { class: 'verified' | 'opaque' | 'quote_only'; reason?: string }; valuation: { inUsd: number | null; outUsd: number | null; minOutUsd: number | null; extraFeesUsd: number; netUsd: number | null };
  risk: { level: 'low' | 'medium' | 'high'; score: number; flags: { code: string; level: string; detail?: string }[] }; atomic: boolean; refundable: boolean | null; priceImpactBps: number | null;
  steps: { kind: string; provider: string; from: SAsset; to: SAsset; via: string[]; contracts: { network: string; address: string; role: string }[] }[]; fees: Fee[] }
interface Prov { provider: string; status: string; code: string | null; ms: number }
type Mode = 'best_price' | 'fastest' | 'balanced';

const dur = (s: number | null, t: (k: Key, v?: Record<string, string | number>) => string) => (s === null ? t('swUnknownTime') : s < 90 ? `${Math.max(1, Math.round(s))} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

function Picker({ open, onClose, onPick, assets, balances, exclude }: { open: boolean; onClose: () => void; onPick: (a: SAsset) => void; assets: SAsset[]; balances: Map<string, string>; exclude?: string }) {
  const t = useT(); const [q, setQ] = useState('');
  const rows = useMemo(() => { const s = q.trim().toLowerCase();
    return assets.filter((a) => a.key !== exclude && (!s || a.symbol.toLowerCase().includes(s) || a.name.toLowerCase().includes(s) || a.networkName.toLowerCase().includes(s)))
      .sort((a, b) => Number((balances.get(b.key) ?? '0') !== '0') - Number((balances.get(a.key) ?? '0') !== '0') || Number(!!b.native) - Number(!!a.native) || a.symbol.localeCompare(b.symbol)).slice(0, 80); }, [q, assets, balances, exclude]);
  useEffect(() => { if (open) setQ(''); }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/45 lg:items-center" role="dialog" aria-modal="true" aria-label={t('swChoose')} onClick={onClose}>
      <div className="rise flex max-h-[85vh] w-full max-w-xl flex-col rounded-t-3xl bg-surface p-5 lg:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between"><h2 className="text-[18px] font-semibold">{t('swChoose')}</h2>
          <button onClick={onClose} aria-label={t('cancel')} className="grid h-10 w-10 place-items-center rounded-full text-mute"><Icon n="x" /></button></div>
        <input autoFocus className={inputCls} type="search" placeholder={t('search')} aria-label={t('search')} value={q} onChange={(e) => setQ(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <ul className="mt-3 flex-1 overflow-y-auto">{rows.map((a) => { const b = balances.get(a.key); return (
          <li key={a.key}><button onClick={() => { onPick(a); onClose(); }} className="flex w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-left active:bg-elev">
            <Coin sym={a.symbol} net={a.network} size={40} />
            <span className="min-w-0 flex-1"><span className="block truncate text-[15px] font-semibold">{a.symbol} <span className="font-normal text-mute">{a.name}</span></span><span className="block text-[12.5px] text-mute">{a.networkName}</span></span>
            {b && b !== '0' && <span className="text-[13.5px] font-medium">{trimAmt(b)}</span>}</button></li>); })}
          {rows.length === 0 && <li className="py-6 text-center text-[14px] text-mute">{t('noMatch')}</li>}</ul>
      </div>
    </div>);
}

export function Swap() {
  const t = useT(); const { locale } = useContext(I18n); const { settings } = useSettings(); const pf = usePortfolio();
  const assetsQ = useQuery({ queryKey: ['swap-assets'], queryFn: () => get<{ assets: SAsset[] }>('/swap/assets'), staleTime: 600_000 });
  const provQ = useQuery({ queryKey: ['swap-providers'], queryFn: () => get<{ executionEnabled: boolean; providers: { id: string; name: string; state: string; enabled: boolean; p50: number | null; capabilities: { needsKey: boolean; configured: boolean } }[] }>('/swap/providers'), staleTime: 30_000 });
  const assets = assetsQ.data?.assets ?? [];
  const [fromKey, setFromKey] = useState(''), [toKey, setToKey] = useState(''), [amount, setAmount] = useState(''), [slip, setSlip] = useState(50), [mode, setMode] = useState<Mode>('best_price');
  const [pick, setPick] = useState<'from' | 'to' | null>(null), [open, setOpen] = useState('');
  const [routes, setRoutes] = useState<RouteV[]>([]), [best, setBest] = useState<Partial<Record<Mode, string>>>({}), [provs, setProvs] = useState<Prov[]>([]);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'done' | 'error'>('idle'), [reachable, setReachable] = useState(true), [took, setTook] = useState<number | null>(null), [first, setFirst] = useState<number | null>(null);
  const es = useRef<EventSource | null>(null);
  const balances = useMemo(() => new Map((pf.data?.balances ?? []).map((b) => [`${b.network}:${b.asset === 'native' ? 'native' : b.asset.startsWith('0x') ? b.asset.toLowerCase() : b.asset}`, b.display ?? '0'])), [pf.data]);
  const by = (k: string) => assets.find((a) => a.key === k);
  useEffect(() => { // sensible defaults once the registry is loaded
    if (!assets.length || fromKey) return;
    const usdc = assets.find((a) => a.network === 'base' && a.symbol === 'USDC'), eth = assets.find((a) => a.network === 'base' && a.native);
    if (usdc && eth) { setFromKey(usdc.key); setToKey(eth.key); }
  }, [assets, fromKey]);
  const from = by(fromKey), to = by(toKey);
  const cur = settings.currency, rate = pf.data?.prices ? (cur === 'USD' ? 1 : (pf.data.prices.USDC?.cad ?? 0) / (pf.data.prices.USDC?.usd || 1)) : null;
  const money = (usd: number | null) => (usd === null || rate === null ? null : fiat(usd * rate, cur, locale));

  // live quotes: one server-sent stream per (pair, amount, slippage), restarted after a short pause in typing
  useEffect(() => {
    es.current?.close(); setRoutes([]); setBest({}); setProvs([]); setTook(null); setFirst(null); setOpen('');
    if (!from || !to || !/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) { setPhase('idle'); return; }
    setPhase('loading');
    const h = setTimeout(() => {
      const t0 = performance.now();
      const s = new EventSource(`/api/v1/swap/quote/stream?from=${encodeURIComponent(from.key)}&to=${encodeURIComponent(to.key)}&amount=${encodeURIComponent(amount)}&slippageBps=${slip}`);
      es.current = s;
      s.addEventListener('start', (e) => setReachable(JSON.parse((e as MessageEvent).data).reachable));
      s.addEventListener('route', (e) => { const r = JSON.parse((e as MessageEvent).data) as RouteV; setFirst((f) => f ?? Math.round(performance.now() - t0)); setRoutes((rs) => [...rs.filter((x) => x.id !== r.id), r]); });
      s.addEventListener('provider', (e) => setProvs((p) => [...p, JSON.parse((e as MessageEvent).data)]));
      s.addEventListener('done', (e) => { const d = JSON.parse((e as MessageEvent).data); setRoutes(d.routes); setBest(d.best); setTook(Math.round(performance.now() - t0)); setPhase('done'); s.close(); });
      s.addEventListener('error', () => { setPhase((p) => (p === 'done' ? p : 'error')); s.close(); });
    }, 450);
    return () => { clearTimeout(h); es.current?.close(); };
  }, [from?.key, to?.key, amount, slip]);

  const net = (r: RouteV) => r.valuation.netUsd ?? Number(r.minAmountOutDisplay);
  const sorted = [...routes].sort((a, b) => Number(b.id === best[mode]) - Number(a.id === best[mode]) || net(b) - net(a));
  const chosen = sorted[0];
  const flip = () => { setFromKey(toKey); setToKey(fromKey); setAmount(''); };
  const bal = from ? balances.get(from.key) : undefined;
  const riskCls = { low: 'text-emerald bg-emerald/10', medium: 'text-warn bg-warn/12', high: 'text-danger bg-danger/10' } as const;
  const noProviders = (provQ.data?.providers.length ?? 0) === 0;

  const side = (label: string, a: SAsset | undefined, which: 'from' | 'to', body: React.ReactNode) => (
    <div className="rounded-3xl bg-elev/70 p-4">
      <div className="mb-2 flex items-center justify-between text-[13px] text-mute"><span>{label}</span>{which === 'from' && bal !== undefined && <button className="font-medium text-blue" onClick={() => setAmount(bal)}>{t('available')}: {trimAmt(bal, 6)}</button>}</div>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">{body}</div>
        <button onClick={() => setPick(which)} className="flex shrink-0 items-center gap-2 rounded-full bg-surface py-1.5 pl-1.5 pr-3 shadow-sm" aria-label={`${label}: ${a ? `${a.symbol} ${a.networkName}` : t('swChoose')}`}>
          {a ? <><Coin sym={a.symbol} net={a.network} size={32} /><span className="text-left leading-tight"><span className="block text-[15px] font-semibold">{a.symbol}</span><span className="block text-[11px] text-mute">{a.networkName}</span></span></> : <span className="px-2 text-[14px]">{t('swChoose')}</span>}
          <Icon n="chev" className="h-4 w-4 rotate-90 text-mute" /></button>
      </div>
    </div>);

  return (
    <div className="space-y-4">
      <h1 className="pt-2 text-[30px] font-semibold tracking-[-0.02em]">{t('swap')}</h1>
      <Notice tone="info">{t('swQuoteOnly')}</Notice>
      <Card className="!p-3">
        {side(t('swYouPay'), from, 'from', <>
          <input className="w-full bg-transparent text-[30px] font-semibold tracking-tight outline-none placeholder:text-mute/50" inputMode="decimal" placeholder="0" aria-label={t('amount')} value={amount} onChange={(e) => setAmount(e.target.value.replace(',', '.').replace(/[^0-9.]/g, ''))} autoComplete="off" />
          <div className="h-5 text-[13px] text-mute">{chosen?.valuation.inUsd != null ? `≈ ${money(chosen.valuation.inUsd)}` : ' '}</div></>)}
        <div className="relative z-[1] -my-3 flex justify-center"><button onClick={flip} aria-label={t('swFlip')} className="grid h-11 w-11 place-items-center rounded-full border-4 border-surface bg-primary text-onprimary"><Icon n="swap" className="h-5 w-5 rotate-90" /></button></div>
        {side(t('swYouReceive'), to, 'to', <>
          <div className={`text-[30px] font-semibold tracking-tight ${chosen ? '' : 'text-mute/50'}`} aria-live="polite">{chosen ? trimAmt(chosen.amountOutDisplay, 8) : phase === 'loading' ? '…' : '0'}</div>
          <div className="h-5 text-[13px] text-mute">{chosen ? <>{t('swMin')} {trimAmt(chosen.minAmountOutDisplay, 8)}{chosen.valuation.outUsd != null ? ` · ≈ ${money(chosen.valuation.outUsd)}` : ''}</> : ' '}</div></>)}
        <div className="mt-3 flex items-center justify-between px-1 text-[13px]">
          <span className="text-mute">{t('swSlippage')}</span>
          <div className="flex rounded-full bg-elev p-0.5" role="radiogroup" aria-label={t('swSlippage')}>{[30, 50, 100].map((b) => <button key={b} role="radio" aria-checked={slip === b} onClick={() => setSlip(b)} className={`min-h-8 rounded-full px-3 ${slip === b ? 'bg-surface font-semibold shadow-sm' : 'text-mute'}`}>{b / 100} %</button>)}</div>
        </div>
      </Card>

      <div className="flex rounded-2xl bg-elev p-1" role="radiogroup" aria-label={t('swMode')}>{(['best_price', 'fastest', 'balanced'] as Mode[]).map((m) =>
        <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={`min-h-10 flex-1 rounded-xl text-[13.5px] ${mode === m ? 'bg-surface font-semibold shadow-sm' : 'text-mute'}`}>{t(`sw_${m}` as Key)}</button>)}</div>

      {noProviders && <Notice tone="warn">{t('swNoProviders')}</Notice>}
      {phase === 'loading' && routes.length === 0 && <Card><div className="flex items-center gap-3 text-[14px] text-mute"><Icon n="spin" className="h-5 w-5" />{t('swSearching')}</div></Card>}
      {phase === 'error' && <Notice tone="danger">{t('swError')}</Notice>}
      {phase === 'done' && routes.length === 0 && <Notice tone="warn">{reachable ? t('swNoLiquidity') : t('swNoRoute')}</Notice>}

      {sorted.length > 0 && <div className="space-y-3">
        {sorted.map((r, k) => { const isOpen = open === r.id, sel = k === 0; return (
          <section key={r.id} className={`card overflow-hidden ${sel ? 'ring-2 ring-primary' : ''}`}>
            <button className="w-full p-4 text-left" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? '' : r.id)}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><div className="text-[13px] text-mute">{r.providers.join(' → ')}</div>
                  <div className="mt-0.5 text-[22px] font-semibold leading-tight tracking-tight">{trimAmt(r.amountOutDisplay, 8)} <span className="text-mute">{r.path[r.path.length - 1]!.symbol}</span></div>
                  <div className="text-[12.5px] text-mute">{t('swMin')} {trimAmt(r.minAmountOutDisplay, 8)}{r.valuation.netUsd != null ? ` · ${t('swNet')} ${money(r.valuation.netUsd)}` : ''}</div></div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  {r.tags.map((tag) => <span key={tag} className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-onprimary">{t(`sw_${tag}` as Key)}</span>)}
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${riskCls[r.risk.level]}`}><Icon n={r.risk.level === 'low' ? 'check' : 'warn'} className="h-3 w-3" />{t(`swRisk_${r.risk.level}` as Key)}</span>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px]">{r.path.map((p, i) => <span key={i} className="inline-flex items-center gap-1.5">{i > 0 && <Icon n="chev" className="h-3 w-3 text-mute" />}<span className="inline-flex items-center gap-1 rounded-full bg-elev px-2 py-0.5"><NetDot net={p.network} />{p.symbol}</span></span>)}</div>
              <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-mute">
                <span><Icon n="clock" className="mr-1 inline h-3.5 w-3.5" />{dur(r.estimatedSeconds, t)}</span>
                <span>{t('swFees')} {r.valuation.extraFeesUsd > 0 ? money(r.valuation.extraFeesUsd) : '—'}</span>
                {r.priceImpactBps !== null && <span>{t('swImpact')} {(r.priceImpactBps / 100).toFixed(2)} %</span>}
              </div>
            </button>
            {isOpen && <div className="space-y-3 border-t border-line bg-elev/40 p-4 text-[13px]">
              <div><div className="mb-1.5 text-[11.5px] uppercase tracking-wide text-mute">{t('swSteps')}</div>
                <ol className="space-y-2">{r.steps.map((s, i) => <li key={i} className="flex gap-2.5"><span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-onprimary">{i + 1}</span>
                  <span className="min-w-0"><span className="font-medium">{t(`swKind_${s.kind}` as Key)}</span> {s.from.symbol} ({s.from.networkName}) → {s.to.symbol} ({s.to.networkName})
                    <span className="block text-mute">{s.provider}{s.via.length ? ` · ${s.via.slice(0, 4).join(', ')}` : ''}</span></span></li>)}</ol></div>
              {r.fees.length > 0 && <div><div className="mb-1.5 text-[11.5px] uppercase tracking-wide text-mute">{t('swFees')}</div>
                <ul className="space-y-1">{r.fees.map((f, i) => <li key={i} className="flex justify-between gap-3"><span>{t(`swFee_${f.kind}` as Key)}{f.estimated ? ` (${t('estimate')})` : ''}{f.includedInOutput ? ` · ${t('swIncluded')}` : ''}</span><span className="shrink-0">{trimAmt(f.display, 8)} {f.symbol}{f.usd != null ? ` · ${money(f.usd)}` : ''}</span></li>)}</ul></div>}
              <div><div className="mb-1.5 text-[11.5px] uppercase tracking-wide text-mute">{t('swRisk')}</div>
                {r.risk.flags.length === 0 ? <span className="text-mute">—</span> : <ul className="space-y-1">{r.risk.flags.map((f, i) => <li key={i} className="flex gap-2"><Icon n={f.level === 'low' ? 'check' : 'warn'} className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${f.level === 'high' ? 'text-danger' : f.level === 'medium' ? 'text-warn' : 'text-mute'}`} /><span>{t(`swFlag_${f.code}` as Key)}{f.detail ? <span className="text-mute"> — {f.detail}</span> : null}</span></li>)}</ul>}</div>
              <div className="text-mute">{t(`swExec_${r.executability.class}` as Key)}{r.executability.reason ? ` — ${r.executability.reason}` : ''}</div>
            </div>}
          </section>); })}
        <button disabled className="inline-flex min-h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-primary px-5 text-[15.5px] font-semibold text-onprimary opacity-40"><Icon n="lock" className="h-4 w-4" />{t('swExecuteDisabled')}</button>
      </div>}

      {(phase === 'done' || provs.length > 0) && <p className="px-1 text-[12px] text-mute">
        {took !== null && <>{t('swTook', { n: provs.length + new Set(routes.flatMap((r) => r.providers)).size, ms: took })}{first !== null ? ` · ${t('swFirst', { ms: first })}` : ''}. </>}
        {provs.filter((p) => p.status !== 'no_route').map((p) => `${p.provider}: ${p.status === 'skipped' ? t('swSkipped') : p.code ?? p.status}`).join(' · ')}</p>}

      <Picker open={pick !== null} onClose={() => setPick(null)} assets={assets} balances={balances} exclude={pick === 'from' ? toKey : fromKey} onPick={(a) => { if (pick === 'from') setFromKey(a.key); else setToKey(a.key); }} />
    </div>
  );
}
