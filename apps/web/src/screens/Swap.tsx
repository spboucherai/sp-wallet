import { useQuery } from '@tanstack/react-query';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { get, post } from '../api';
import { usePortfolio, useSettings } from '../hooks';
import { errText, I18n, useT, type Key } from '../i18n';
import { Btn, Card, Coin, exactAmt, fiat, Icon, inputCls, NetDot, Notice, numFmt, ProviderIcon, StatePill, testNotSent, trimAmt } from '../ui';
import { amountInputText, amountOf, sanitizeAmountText } from '../amount'; // v8 hardening
import { AmountProblem } from '../amountUi';
import { issuerOf } from '../issuer';
import { useQueryClient } from '@tanstack/react-query';
import { BridgeFacts, BridgePill, BridgeProgress, bridgeDur, scErrText } from '../bridge';
import { XswapPill, XswapSheet } from '../xswap';
import { PlanCards } from '../plan'; // v7 any-to-any plans

interface SAsset { key: string; network: string; networkName: string; asset: string; symbol: string; name: string; decimals: number; native?: boolean }
interface Fee { kind: string; symbol: string; network: string; display: string; includedInOutput: boolean; estimated: boolean; usd: number | null }
interface BridgeQuote { options: { speed: 'standard' | 'fast'; available: boolean; feeDisplay: string; minReceiveDisplay: string; seconds: number }[]; destinationGas: { symbol: string; needDisplay: string; balanceDisplay: string; enough: boolean }; toName: string; fromName: string;
  /** v8: Solana as source (refundable deposit) or destination (the wallet's USDC token account, which must exist) */
  solana?: { role: 'source'; depositDisplay: string; networkFeeDisplay: string } | { role: 'destination'; recipient: string; tokenAccount: string; tokenAccountExists: boolean; tokenAccountRentDisplay: string; nonceRentDisplay: string } }
interface RouteV { id: string; executable: boolean; exec?: { via: 'kyberswap' | 'cctp' | 'jupiter' | 'thorchain'; speed?: 'standard' | 'fast' | null } | null; providers: string[]; path: SAsset[]; tags: string[]; pareto: boolean; amountOutDisplay: string; minAmountOutDisplay: string; estimatedSeconds: number | null; expiresAt: number;
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
      .sort((a, b) => Number(!['0', '?'].includes(balances.get(b.key) ?? '0')) - Number(!['0', '?'].includes(balances.get(a.key) ?? '0')) || Number(!!b.native) - Number(!!a.native) || a.symbol.localeCompare(b.symbol)).slice(0, 80); }, [q, assets, balances, exclude]);
  useEffect(() => { if (open) setQ(''); }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/45 lg:items-center" role="dialog" aria-modal="true" aria-label={t('swChoose')} onClick={onClose}>
      <div className="rise flex max-h-[85vh] w-full max-w-xl flex-col rounded-t-3xl bg-surface p-5 lg:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between"><h2 className="text-[18px] font-semibold">{t('swChoose')}</h2>
          <button onClick={onClose} aria-label={t('cancel')} className="grid h-11 w-11 place-items-center rounded-full text-mute"><Icon n="x" /></button></div>
        <input autoFocus className={inputCls} type="search" placeholder={t('search')} aria-label={t('search')} value={q} onChange={(e) => setQ(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <ul className="mt-3 min-h-[50vh] flex-1 overflow-y-auto lg:min-h-[320px]">{rows.map((a) => { const b = balances.get(a.key), iss = issuerOf(t, a.symbol, a.name); return (
          <li key={a.key}><button onClick={() => { onPick(a); onClose(); }} className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-left active:bg-elev">
            <Coin sym={a.symbol} net={a.network} size={40} />
            <span className="min-w-0 flex-1"><span className="block truncate text-[15px] font-semibold">{a.symbol} <span className="font-normal text-mute">{a.name}</span></span><span className="block text-[12.5px] text-mute">{a.networkName}{iss ? <> · <span className="text-warn">{t(`qaTag_${iss.kind}` as Key)}</span> — {iss.text}</> : null}</span></span>
            {b && b !== '0' && b !== '?' && <span className="text-[13.5px] font-medium">{trimAmt(b)}</span>}</button></li>); })}
          {rows.length === 0 && <li className="py-6 text-center text-[14px] text-mute">{t('noMatch')}</li>}</ul>
      </div>
    </div>);
}

export function Swap() {
  const t = useT(); const { locale } = useContext(I18n); const { settings } = useSettings(); const pf = usePortfolio();
  const assetsQ = useQuery({ queryKey: ['swap-assets'], queryFn: () => get<{ assets: SAsset[] }>('/swap/assets'), staleTime: 600_000 });
  const provQ = useQuery({ queryKey: ['swap-providers'], queryFn: () => get<{ executionEnabled: boolean; providers: { id: string; name: string; state: string; enabled: boolean; p50: number | null; capabilities: { needsKey: boolean; configured: boolean } }[] }>('/swap/providers'), staleTime: 30_000 });
  const assets = assetsQ.data?.assets ?? [];
  const [fromKey, setFromKey] = useState(''), [toKey, setToKey] = useState(''), [amountText, setAmount] = useState(''), [slip, setSlip] = useState(50), [mode, setMode] = useState<Mode>('best_price');
  // v8 hardening: the field keeps what was typed (comma or point); `amount` is its canonical reading (amount.ts) — '' while it is empty, invalid or ambiguous
  const amount = amountOf(amountText, locale) ?? '';
  const [pick, setPick] = useState<'from' | 'to' | null>(null), [open, setOpen] = useState(''), [allRoutes, setAllRoutes] = useState(false);
  const [routes, setRoutes] = useState<RouteV[]>([]), [best, setBest] = useState<Partial<Record<Mode, string>>>({}), [provs, setProvs] = useState<Prov[]>([]);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'done' | 'error'>('idle'), [reachable, setReachable] = useState(true), [took, setTook] = useState<number | null>(null), [first, setFirst] = useState<number | null>(null);
  const es = useRef<EventSource | null>(null);
  const qc = useQueryClient();
  const [exec, setExec] = useState<{ proposal: any; options: any } | null>(null), [busy, setBusy] = useState(''), [execErr, setExecErr] = useState(''), [left, setLeft] = useState(0);
  const live = useQuery({ queryKey: ['proposal', exec?.proposal.id], enabled: !!exec && !['pending_approval'].includes(exec.proposal.state), refetchInterval: 3000, queryFn: () => get<any>(`/transfers/proposals/${exec!.proposal.id}`) });
  const prop = live.data ?? exec?.proposal;
  useEffect(() => { if (!exec || exec.proposal.state !== 'pending_approval') return; const tick = () => setLeft(Math.max(0, Math.round((new Date(exec.proposal.expiresAt).getTime() - Date.now()) / 1000))); tick(); const h = setInterval(tick, 500); return () => clearInterval(h); }, [exec]);
  useEffect(() => { if (prop?.state === 'finalized' || prop?.bridge?.stage === 'done' || prop?.xswap?.done) void qc.invalidateQueries({ queryKey: ['portfolio'] }); }, [prop?.state, prop?.bridge?.stage, prop?.xswap?.done, qc]);
  const balances = useMemo(() => new Map((pf.data?.balances ?? []).map((b) => [`${b.network}:${b.asset === 'native' ? 'native' : b.asset.startsWith('0x') ? b.asset.toLowerCase() : b.asset}`, b.display ?? '?'])), [pf.data]);
  const by = (k: string) => assets.find((a) => a.key === k);
  useEffect(() => { // sensible defaults once the registry is loaded
    if (!assets.length || fromKey) return;
    // pre-filled cross-network USDC transfer (link from the venue deposit screen): /swap?bridgeFrom=<network>&bridgeTo=<network>[&amount=…]
    const q = new URLSearchParams(location.search), u = (n: string | null) => assets.find((a) => a.network === n && a.symbol === 'USDC'), bf = u(q.get('bridgeFrom')), bt = u(q.get('bridgeTo'));
    if (bf && bt && bf.key !== bt.key) { setFromKey(bf.key); setToKey(bt.key); const am = q.get('amount'); if (am && /^\d+(\.\d{1,6})?$/.test(am)) setAmount(amountInputText(am, locale)); return; }
    // arriving from "fund the agent": USDC from one network to the agent's network, prefilled once
    try { const pre = JSON.parse(sessionStorage.getItem('spw-swap-prefill') ?? 'null') as { fromNetwork: string; toNetwork: string; symbol: string } | null; sessionStorage.removeItem('spw-swap-prefill');
      const f = pre && assets.find((a) => a.network === pre.fromNetwork && a.symbol === pre.symbol), g = pre && assets.find((a) => a.network === pre.toNetwork && a.symbol === pre.symbol);
      if (f && g) { setFromKey(f.key); setToKey(g.key); return; } } catch { /* no prefill */ }
    const usdc = assets.find((a) => a.network === 'base' && a.symbol === 'USDC'), eth = assets.find((a) => a.network === 'base' && a.native);
    if (usdc && eth) { setFromKey(usdc.key); setToKey(eth.key); }
  }, [assets, fromKey]);
  const from = by(fromKey), to = by(toKey);
  // v7 any-to-any: a cross-network pair also gets multi-leg plans (apps/web/src/plan.tsx); single-leg flows below are unchanged
  const crossNet = !!from && !!to && from.network !== to.network; const [planCount, setPlanCount] = useState(0);
  // USDC -> USDC between two networks served by CCTP: executed by the wallet itself (burn, attestation, mint)
  const brNets = useQuery({ queryKey: ['bridge-exec'], queryFn: () => get<{ networks: string[] }>('/bridge/execution'), staleTime: 600_000 });
  const isBridge = !!from && !!to && from.symbol === 'USDC' && to.symbol === 'USDC' && from.network !== to.network && !!brNets.data?.networks.includes(from.network) && brNets.data.networks.includes(to.network);
  const amountOk = /^\d+(\.\d+)?$/.test(amount) && Number(amount) > 0;
  const [speed, setSpeed] = useState<'standard' | 'fast'>('standard');
  const brQ = useQuery({ queryKey: ['bridge-quote', from?.network, to?.network, amount], enabled: isBridge && amountOk, staleTime: 20_000, retry: false, queryFn: () => get<BridgeQuote>(`/bridge/quote?from=${from!.network}&to=${to!.network}&amount=${encodeURIComponent(amount)}`) });
  const brSpeed = brQ.data?.options.find((o) => o.speed === speed && o.available) ? speed : 'standard';
  // v8, toward Solana: the wallet's USDC token account must exist before anything is burned; creating it is a small passkey-approved transaction
  const brSol = brQ.data?.solana, ataMissing = brSol?.role === 'destination' && !brSol.tokenAccountExists;
  const [ataBusy, setAtaBusy] = useState(false), [ataMsg, setAtaMsg] = useState(''), [ataErr, setAtaErr] = useState('');
  const createAta = async () => {
    setAtaBusy(true); setAtaErr(''); setAtaMsg('');
    try {
      const o = await post<{ requestId: string; options: any }>('/bridge/solana/token-account/options');
      const assertion = await startAuthentication({ optionsJSON: o.options });
      const r = await post<{ sent: boolean }>('/bridge/solana/token-account', { requestId: o.requestId, assertion });
      setAtaMsg(r.sent ? t('scAtaCreating') : t('scAtaNotSent'));
      for (const ms of [4000, 9000, 16000, 30000]) setTimeout(() => void qc.invalidateQueries({ queryKey: ['bridge-quote'] }), ms);
    } catch (e) { const m = scErrText(t, e); if (m) setAtaErr(m); } finally { setAtaBusy(false); }
  };
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

  const prepare = async () => {
    if (!from || !to) return;
    setBusy('prepare'); setExecErr('');
    // a THORChain native swap (two different networks) has its own preparation: vault confirmation, quotes of two operators, memo
    const thor = routes.find((r) => r.executable)?.exec?.via === 'thorchain' && !routes.some((r) => r.executable && r.exec?.via !== 'thorchain');
    try { setExec(isBridge ? await post('/bridge/proposals', { fromNetwork: from.network, toNetwork: to.network, amount, speed: brSpeed }, { 'idempotency-key': crypto.randomUUID() })
      : thor ? await post('/xswap/proposals', { fromNetwork: from.network, fromAsset: from.asset, toNetwork: to.network, toAsset: to.asset, amount, slippageBps: slip }, { 'idempotency-key': crypto.randomUUID() })
      : await post('/swap/proposals', { network: from.network, fromAsset: from.asset, toAsset: to.asset, amount, slippageBps: slip }, { 'idempotency-key': crypto.randomUUID() })); }
    // an address that never received SOL does not exist on Solana: the server reports it as "not a plain account"
    catch (e) { setExecErr((e as { code?: string }).code === 'account_not_plain' && from.network === 'solana' && ['0', undefined].includes(balances.get('solana:native')) ? t('qaSolNotFunded') : scErrText(t, e)); } finally { setBusy(''); }
  };
  const approve = async () => {
    if (!exec) return;
    setBusy('passkey'); setExecErr('');
    try {
      const assertion = await startAuthentication({ optionsJSON: exec.options }); // the challenge is the fingerprint of this exact swap
      setBusy('submit');
      const p = await post(`/transfers/proposals/${exec.proposal.id}/approve`, { assertion });
      setExec({ ...exec, proposal: p });
    } catch (e) { const m = errText(t, e); if (m) setExecErr(m); const fresh = await get<any>(`/transfers/proposals/${exec.proposal.id}`).catch(() => null); if (fresh) setExec({ ...exec, proposal: fresh }); }
    finally { setBusy(''); }
  };
  const closeExec = async () => { if (exec?.proposal.state === 'pending_approval') await post(`/transfers/proposals/${exec.proposal.id}/reject`).catch(() => {}); setExec(null); setExecErr(''); setAmount(''); };
  const net = (r: RouteV) => r.valuation.netUsd ?? Number(r.minAmountOutDisplay);
  const sorted = [...routes].sort((a, b) => Number(b.id === best[mode]) - Number(a.id === best[mode]) || net(b) - net(a));
  const chosen = sorted[0];
  const flip = () => { setFromKey(toKey); setToKey(fromKey); setAmount(''); };
  const bal = from ? balances.get(from.key) : undefined;
  const riskCls = { low: 'text-emerald bg-emerald/10', medium: 'text-warn bg-warn/12', high: 'text-danger bg-danger/10' } as const;
  const noProviders = (provQ.data?.providers.length ?? 0) === 0;
  // display name of a provider id; Jupiter's licence requires its "Metis" label wherever a route of theirs is shown
  const pname = (id: string) => provQ.data?.providers.find((p) => p.id === id)?.name ?? (id === 'jupiter' ? 'Jupiter (Metis)' : id);

  const side = (label: string, a: SAsset | undefined, which: 'from' | 'to', body: React.ReactNode) => (
    <div className="rounded-3xl bg-elev/70 p-4">
      <div className="mb-2 flex items-center justify-between text-[13px] text-mute"><span>{label}</span>{which === 'from' && bal !== undefined && (bal === '?' ? <span className="text-warn">{t('qaBalUnknown')}</span> : <button className="-my-3 min-h-11 font-medium text-blue" onClick={() => setAmount(amountInputText(bal, locale))}>{t('available')}{locale === 'fr' ? ' : ' : ': '}{trimAmt(bal, 6)}</button>)}</div>
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
      <Notice tone="info">{t('swIntro')}</Notice>
      <Card className="!p-3">
        {side(t('swYouPay'), from, 'from', <>
          <input className="w-full bg-transparent text-[30px] font-semibold tracking-tight outline-none placeholder:text-mute/50" inputMode="decimal" placeholder="0" aria-label={t('amount')} value={amountText} onChange={(e) => setAmount(sanitizeAmountText(e.target.value))} autoComplete="off" />
          <AmountProblem text={amountText} />
          <div className="h-5 text-[13px] text-mute">{chosen?.valuation.inUsd != null ? `≈ ${money(chosen.valuation.inUsd)}` : ' '}</div></>)}
        <div className="relative z-[1] -my-3 flex justify-center"><button onClick={flip} aria-label={t('swFlip')} className="grid h-11 w-11 place-items-center rounded-full border-4 border-surface bg-primary text-onprimary"><Icon n="swap" className="h-5 w-5 rotate-90" /></button></div>
        {side(t('swYouReceive'), to, 'to', <>
          <div className={`text-[30px] font-semibold tracking-tight ${chosen ? '' : 'text-mute/50'}`} aria-live="polite">{chosen ? trimAmt(chosen.amountOutDisplay, 8) : phase === 'loading' ? '…' : '0'}</div>
          <div className="h-5 text-[13px] text-mute">{chosen ? <>{t('swMin')} {trimAmt(chosen.minAmountOutDisplay, 8)}{chosen.valuation.outUsd != null ? ` · ≈ ${money(chosen.valuation.outUsd)}` : ''}</> : ' '}</div></>)}
        <div className="mt-3 flex items-center justify-between px-1 text-[13px]">
          <span className="min-w-0 text-mute">{t('swSlippage')}</span>
          <div className="flex shrink-0 rounded-full bg-elev p-0.5" role="radiogroup" aria-label={t('swSlippage')}>{[30, 50, 100].map((b) => <button key={b} role="radio" aria-checked={slip === b} onClick={() => setSlip(b)} className={`min-h-11 whitespace-nowrap rounded-full px-3 ${slip === b ? 'bg-surface font-semibold shadow-sm' : 'text-mute'}`}>{numFmt(b / 100, locale, 1)} %</button>)}</div>
        </div>
      </Card>

      <div className="flex rounded-2xl bg-elev p-1" role="radiogroup" aria-label={t('swMode')}>{(['best_price', 'fastest', 'balanced'] as Mode[]).map((m) =>
        <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={`min-h-11 flex-1 rounded-xl text-[13.5px] ${mode === m ? 'bg-surface font-semibold shadow-sm' : 'text-mute'}`}>{t(`sw_${m}` as Key)}</button>)}</div>

      {crossNet && from && to && <PlanCards from={from} to={to} amount={amount} slip={slip} routes={routes} money={money} pname={pname} onCount={setPlanCount} />}

      {noProviders && <Notice tone="warn">{t('swNoProviders')}</Notice>}
      {phase === 'loading' && routes.length === 0 && <Card><div className="flex items-center gap-3 text-[14px] text-mute"><Icon n="spin" className="h-5 w-5" />{t('swSearching')}</div></Card>}
      {phase === 'error' && <Notice tone="danger">{t('swError')}</Notice>}
      {phase === 'done' && routes.length === 0 && <Notice tone="warn">{reachable ? t('swNoLiquidity') : t('swNoRoute')}</Notice>}

      {sorted.length > 0 && <div className="space-y-3">
        {isBridge && <div className="px-1 text-[12.5px] font-medium text-mute">{t('qaSwOtherRoutes')}</div>}
        {(isBridge && !allRoutes ? sorted.slice(0, 2) : sorted).map((r, k) => { const isOpen = open === r.id, sel = k === 0 && !isBridge; return (
          <section key={r.id} className={`card overflow-hidden ${sel ? 'ring-2 ring-primary' : ''}`}>
            <button className="w-full p-4 text-left" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? '' : r.id)}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><div className="text-[13px] text-mute"><span className="mr-1.5 inline-flex items-center align-[-4px]">{r.providers.map((x, k) => <ProviderIcon key={x + k} provider={x} size={18} className={k ? '-ml-1 ring-2 ring-surface' : ''} />)}</span>{r.providers.map(pname).join(' → ')} · <span className={r.executable && !isBridge ? 'font-semibold text-emerald' : ''}>{r.executable && !isBridge ? t('qaSwExecHere') : t('qaSwCompareOnly')}</span></div>
                  <div className="mt-0.5 text-[22px] font-semibold leading-tight tracking-tight">{trimAmt(r.amountOutDisplay, 8)} <span className="text-mute">{r.path[r.path.length - 1]!.symbol}</span></div>
                  <div className="text-[12.5px] text-mute">{t('swMin')} {trimAmt(r.minAmountOutDisplay, 8)}{r.valuation.netUsd != null ? ` · ${t('swNet')} ${money(r.valuation.netUsd)}` : ''}</div></div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  {crossNet && !r.executable && !r.providers.every((x) => ['cctp', 'kyberswap', 'jupiter', 'thorchain'].includes(x)) && <span data-testid="compare-only" className="rounded-full bg-elev px-2 py-0.5 text-[11px] font-semibold text-mute">{t('pnCompareOnly')}</span>}
                  {r.tags.map((tag) => <span key={tag} className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-onprimary">{t(`sw_${tag}` as Key)}</span>)}
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${riskCls[r.risk.level]}`}><Icon n={r.risk.level === 'low' ? 'check' : 'warn'} className="h-3 w-3" />{t(`swRisk_${r.risk.level}` as Key)}</span>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px]">{r.path.map((p, i) => <span key={i} className="inline-flex items-center gap-1.5">{i > 0 && <Icon n="chev" className="h-3 w-3 text-mute" />}<span className="inline-flex items-center gap-1 rounded-full bg-elev px-2 py-0.5"><NetDot net={p.network} />{p.symbol}</span></span>)}</div>
              <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-mute">
                <span><Icon n="clock" className="mr-1 inline h-3.5 w-3.5" />{dur(r.estimatedSeconds, t)}</span>
                <span>{t('swFees')} {r.valuation.extraFeesUsd > 0 ? money(r.valuation.extraFeesUsd) : '—'}</span>
                {r.priceImpactBps !== null && <span>{t('swImpact')} {numFmt(r.priceImpactBps / 100, locale, 2, 2)} %</span>}
              </div>
            </button>
            {isOpen && <div className="space-y-3 border-t border-line bg-elev/40 p-4 text-[13px]">
              <div><div className="mb-1.5 text-[11.5px] uppercase tracking-wide text-mute">{t('swSteps')}</div>
                <ol className="space-y-2">{r.steps.map((s, i) => <li key={i} className="flex gap-2.5"><span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-onprimary">{i + 1}</span>
                  <span className="min-w-0"><span className="font-medium">{t(`swKind_${s.kind}` as Key)}</span> {s.from.symbol} ({s.from.networkName}) → {s.to.symbol} ({s.to.networkName})
                    <span className="flex items-center gap-1.5 text-mute"><ProviderIcon provider={s.provider} size={14} />{pname(s.provider)}{s.via.length ? ` · ${s.via.slice(0, 4).join(', ')}` : ''}</span></span></li>)}</ol></div>
              {r.fees.length > 0 && <div><div className="mb-1.5 text-[11.5px] uppercase tracking-wide text-mute">{t('swFees')}</div>
                <ul className="space-y-1">{r.fees.map((f, i) => <li key={i} className="flex justify-between gap-3"><span>{t(`swFee_${f.kind}` as Key)}{f.estimated ? ` (${t('estimate')})` : ''}{f.includedInOutput ? ` · ${t('swIncluded')}` : ''}</span><span className="shrink-0">{trimAmt(f.display, 8)} {f.symbol}{f.usd != null ? ` · ${money(f.usd)}` : ''}</span></li>)}</ul></div>}
              <div><div className="mb-1.5 text-[11.5px] uppercase tracking-wide text-mute">{t('swRisk')}</div>
                {r.risk.flags.length === 0 ? <span className="text-mute">—</span> : <ul className="space-y-1">{r.risk.flags.map((f, i) => <li key={i} className="flex gap-2"><Icon n={f.level === 'low' ? 'check' : 'warn'} className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${f.level === 'high' ? 'text-danger' : f.level === 'medium' ? 'text-warn' : 'text-mute'}`} /><span>{t(`swFlag_${f.code}` as Key)}{f.detail ? <span className="text-mute"> — {f.detail}</span> : null}</span></li>)}</ul>}</div>
              <div className="text-mute">{t(`swExec_${r.executability.class}` as Key)}{r.executability.reason ? ` — ${r.executability.reason}` : ''}</div>
            </div>}
          </section>); })}
        {isBridge && sorted.length > 2 && <button className="min-h-11 px-1 text-[13.5px] font-medium text-blue" aria-expanded={allRoutes} onClick={() => setAllRoutes(!allRoutes)}>{allRoutes ? t('qaSwLessRoutes') : t('qaSwMoreRoutes', { n: sorted.length - 2 })}</button>}
        {execErr && !isBridge && <Notice tone="danger">{execErr}</Notice>}
        {isBridge ? null : (() => { const ex = sorted.find((r) => r.executable); return ex
          ? <><Btn full busy={busy === 'prepare'} onClick={() => void prepare()}><Icon n="swap" className="h-4 w-4" />{t('swExecute', { via: pname(ex.providers[0]!) })}</Btn>
              {ex.id !== sorted[0]!.id && <p className="px-1 text-[12.5px] text-mute">{t('swExecNotBest')}</p>}</>
          : crossNet && planCount > 0 ? null /* a startable plan is offered above */ : <><button disabled className="inline-flex min-h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-primary px-5 text-[15.5px] font-semibold text-onprimary opacity-40"><Icon n="lock" className="h-4 w-4" />{t('swExecuteDisabled')}</button>
              <p className="px-1 text-[12.5px] text-mute">{t('swExecWhere')} {t('swSolIntro')}</p></>; })()}
      </div>}

      {isBridge && amountOk && <Card>
        <h2 className="text-[16px] font-semibold">{t('brTitle')}</h2>
        {brQ.isLoading && <p className="mt-2 flex items-center gap-2 text-[13.5px] text-mute"><Icon n="spin" className="h-4 w-4" />{t('swSearching')}</p>}
        {brQ.error ? <div className="mt-2"><Notice tone="danger">{errText(t, brQ.error)}</Notice></div> : null}
        {brQ.data && <div className="mt-2 space-y-3 text-[13.5px]">
          <p className="text-mute">{t('brIntro', { from: brQ.data.fromName, to: brQ.data.toName, gas: brQ.data.destinationGas.symbol })}</p>
          <div className="space-y-2" role="radiogroup" aria-label={t('brSpeed')}>{brQ.data.options.map((o) =>
            <button key={o.speed} role="radio" aria-checked={brSpeed === o.speed} disabled={!o.available} onClick={() => setSpeed(o.speed)} className={`flex w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left ${brSpeed === o.speed ? 'border-primary bg-elev/70' : 'border-line'} ${o.available ? '' : 'opacity-50'}`}>
              <span><span className="block font-medium">{o.speed === 'fast' ? t('brOptFast', { fee: trimAmt(o.feeDisplay, 6) }) : t('brOptStandard')}</span>
                <span className="block text-[12.5px] text-mute">{o.available ? t('brOptTime', { time: bridgeDur(o.seconds) }) : t('brFastUnavailable')}</span></span>
              <span className="shrink-0 text-right font-semibold">{trimAmt(o.minReceiveDisplay, 6)} <span className="text-mute">USDC</span></span></button>)}</div>
          {brQ.data.destinationGas.enough
            ? <p className="text-mute">{t('brDestGasLine', { net: brQ.data.toName, need: trimAmt(brQ.data.destinationGas.needDisplay, 8), have: trimAmt(brQ.data.destinationGas.balanceDisplay, 8), sym: brQ.data.destinationGas.symbol })}</p>
            : <Notice tone="warn">{t('brDestGasMissing', { sym: brQ.data.destinationGas.symbol, net: brQ.data.toName })} {t('brDestGasLine', { net: brQ.data.toName, need: trimAmt(brQ.data.destinationGas.needDisplay, 8), have: trimAmt(brQ.data.destinationGas.balanceDisplay, 8), sym: brQ.data.destinationGas.symbol })}</Notice>}
          {brSol?.role === 'source' && <p className="text-mute" data-testid="sc-source">{t('scSrcIntro', { dep: trimAmt(brSol.depositDisplay, 9) })} {t('scSrcFee', { fee: trimAmt(brSol.networkFeeDisplay, 9) })}</p>}
          {brSol?.role === 'destination' && !ataMissing && <p className="text-mute" data-testid="sc-destination">{t('scDstIntro', { acct: `${brSol.tokenAccount.slice(0, 6)}…${brSol.tokenAccount.slice(-6)}`, rent: trimAmt(brSol.nonceRentDisplay, 9) })}</p>}
          {brSol?.role === 'destination' && ataMissing && <Notice tone="warn"><span data-testid="sc-ata-missing"><b>{t('scAtaMissingTitle')}</b> {t('scAtaMissing', { rent: trimAmt(brSol.tokenAccountRentDisplay, 9) })}</span>
            <span className="mt-1 block break-all font-mono text-[11px] text-mute">{brSol.tokenAccount}</span>
            {ataMsg && <span className="mt-1 block">{ataMsg}</span>}{ataErr && <span className="mt-1 block text-danger">{ataErr}</span>}
            <div className="mt-2"><Btn full kind="soft" busy={ataBusy} onClick={() => void createAta()}><Icon n="key" className="h-4 w-4" />{t('scAtaCreate')}</Btn></div></Notice>}
          {execErr && <Notice tone="danger">{execErr}</Notice>}
          <Btn full busy={busy === 'prepare'} disabled={!brQ.data.destinationGas.enough || ataMissing} onClick={() => void prepare()}><Icon n="swap" className="h-4 w-4" />{t('brExecute', { net: brQ.data.toName })}</Btn>
        </div>}
      </Card>}

      {(phase === 'done' || provs.length > 0) && <p className="px-1 text-[12px] text-mute">
        {took !== null && <>{(() => { const n = provs.length + new Set(routes.flatMap((r) => r.providers)).size; return n === 1 ? t('qaSwProviders1', { ms: took }) : t('swTook', { n, ms: took }); })()}{first !== null ? ` · ${t('swFirst', { ms: first })}` : ''}. </>}
        {provs.filter((p) => p.status !== 'no_route').map((p) => `${pname(p.provider)}${locale === 'fr' ? ' : ' : ': '}${p.status === 'skipped' ? t('swSkipped') : ['unavailable', 'timeout', 'error', 'unsupported'].includes(p.status) ? t(`qaSwSt_${p.status}` as Key) : p.code ?? p.status}`).join(' · ')}</p>}

      {exec && prop && !prop.bridge && !prop.xswap && <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/45 lg:items-center" role="dialog" aria-modal="true" aria-label={t('swReview')}>
        <div className="rise max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-surface p-5 lg:rounded-3xl">
          <div className="mb-3 flex items-center justify-between"><h2 className="text-[20px] font-semibold tracking-tight">{prop.state === 'pending_approval' ? t('swReview') : t('swTracking')}</h2>{testNotSent(prop) ? <span className="rounded-full bg-warn/12 px-2 py-0.5 text-[11.5px] font-semibold text-warn">{t('qaSignedNotSent')}</span> : <StatePill state={prop.state} />}</div>
          <div className="rounded-2xl bg-elev/70 p-4">
            <div className="text-[13px] text-mute">{t('swYouPay')}</div>
            <div className="text-[24px] font-semibold tracking-tight">{exactAmt(prop.amountDisplay)} <span className="text-mute">{prop.symbol}</span></div>
            <div className="mt-3 text-[13px] text-mute">{prop.swap.received ? t('swReceived') : t('swMinGuaranteed')}</div>
            <div className="text-[24px] font-semibold tracking-tight">{trimAmt(prop.swap.receivedDisplay ?? prop.swap.minOutDisplay, 10)} <span className="text-mute">{prop.swap.toSymbol}</span></div>
            {!prop.swap.received && <div className="text-[13px] text-mute">{t('swExpected')} {trimAmt(prop.swap.expectedOutDisplay, 10)} {prop.swap.toSymbol}</div>}
          </div>
          <dl className="mt-3 space-y-2 text-[13.5px]">
            <div className="flex justify-between gap-3"><dt className="text-mute">{t('network')}</dt><dd>{prop.networkName} · {prop.swap.detail?.label ?? 'KyberSwap'}</dd></div>
            {prop.swap.detail && <>
              <div className="flex justify-between gap-3"><dt className="text-mute">{t('swSolRoute')}</dt><dd className="text-right">{(prop.swap.detail.venues as string[]).join(' + ')}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-mute">{t('swSolNetworkFee')}</dt><dd className="text-right">{trimAmt(prop.swap.detail.networkFeeDisplay, 9)} {prop.feeSymbol} <span className="text-mute">({t('swSolPriority')} {trimAmt(prop.swap.detail.priorityFeeDisplay, 9)})</span></dd></div>
              {prop.swap.detail.createsAccount && <div className="flex justify-between gap-3"><dt className="text-mute">{t('swSolRent')}</dt><dd>{trimAmt(prop.swap.detail.rentDisplay, 9)} {prop.feeSymbol}</dd></div>}
              {prop.state === 'pending_approval' && <div className="flex justify-between gap-3"><dt className="text-mute">{t('swSolSimulated')}</dt><dd>{trimAmt(prop.swap.detail.simulatedOutDisplay, 10)} {prop.swap.toSymbol}</dd></div>}
            </>}
            <div className="flex justify-between gap-3"><dt className="text-mute">{t('feeMax')}</dt><dd>{prop.maxFeeDisplay ? `${trimAmt(prop.maxFeeDisplay, 9)} ${prop.feeSymbol}` : '—'}</dd></div>
            {prop.swap.approvalState && <div className="flex justify-between gap-3"><dt className="text-mute">{t('swApproval')}</dt><dd>{t(`swAppr_${prop.swap.approvalState}` as Key)}</dd></div>}
            {prop.intentHash && <div><dt className="text-mute">{t('fingerprint')}</dt><dd className="break-all font-mono text-[11px] text-mute">{prop.intentHash}</dd></div>}
            {prop.txid && ['broadcast', 'confirming', 'finalized', 'failed'].includes(prop.state) && <div><dt className="text-mute">{t('txid')}</dt><dd className="break-all font-mono text-[11px]">{prop.txid}</dd></div>}
          </dl>
          {prop.state === 'pending_approval' && <div className="mt-3 space-y-3">
            <Notice tone="ok">{prop.swap.detail ? t('swSolGuarantee') : t('swGuarantee')}</Notice>
            {prop.swap.detail?.createsAccount && <Notice tone="info">{t('swSolRentNote', { sym: prop.swap.toSymbol })}</Notice>}
            {prop.swap.detail && <Notice tone="info">{t('swSolExpiry')}</Notice>}
            {prop.swap.needsApproval && <Notice tone="info">{t('swNeedsApproval', { sym: prop.symbol })}</Notice>}
            <Notice tone="info">{t('irreversible')} {t('expiresIn')} {left} s.</Notice>
          </div>}
          {prop.error && ['failed', 'expired', 'rejected'].includes(prop.state) && <div className="mt-3"><Notice tone="danger">{prop.error}</Notice></div>}
          {testNotSent(prop) ? <div className="mt-3"><Notice tone="warn">{t('qaTestNotSent')}</Notice></div> : ['signed', 'broadcast', 'confirming'].includes(prop.state) && <p className="mt-3 flex items-center gap-2 text-[13px] text-mute"><Icon n="spin" className="h-4 w-4" />{t('broadcastNote')}</p>}
          {execErr && <div className="mt-3"><Notice tone="danger">{execErr}</Notice></div>}
          {prop.explorer && !testNotSent(prop) && ['broadcast', 'confirming', 'finalized', 'failed'].includes(prop.state) && <a className="mt-3 inline-flex items-center gap-1.5 text-sm text-blue" href={prop.explorer} target="_blank" rel="noreferrer noopener"><Icon n="ext" className="h-4 w-4" />{t('viewExplorer')}</a>}
          <div className="mt-4 space-y-2.5">
            {prop.state === 'pending_approval' && <Btn full busy={!!busy} disabled={left === 0} onClick={() => void approve()}><Icon n="key" />{busy === 'passkey' ? t('approving') : t('approve')}</Btn>}
            <Btn full kind="ghost" disabled={!!busy} onClick={() => void closeExec()}>{prop.state === 'pending_approval' ? t('cancel') : t('swClose')}</Btn>
          </div>
        </div>
      </div>}

      {exec && prop?.bridge && <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/45 lg:items-center" role="dialog" aria-modal="true" aria-label={t('brReview')}>
        <div className="rise max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-surface p-5 lg:rounded-3xl">
          <div className="mb-3 flex items-center justify-between"><h2 className="text-[20px] font-semibold tracking-tight">{prop.state === 'pending_approval' ? t('brReview') : t('brTracking')}</h2><BridgePill b={prop.bridge} /></div>
          <div className="rounded-2xl bg-elev/70 p-4">
            <div className="text-[13px] text-mute">{prop.networkName} → {prop.bridge.toNetworkName}</div>
            <div className="text-[24px] font-semibold tracking-tight">{exactAmt(prop.amountDisplay)} <span className="text-mute">{prop.symbol}</span></div>
          </div>
          <dl className="mt-3 space-y-2 text-[13.5px]">
            <BridgeFacts b={prop.bridge} symbol={prop.symbol} />
            <div className="flex justify-between gap-3"><dt className="text-mute">{t('feeMax')} · {prop.networkName}</dt><dd>{prop.maxFeeDisplay ? `${trimAmt(prop.maxFeeDisplay, 9)} ${prop.feeSymbol}` : '—'}</dd></div>
            {prop.intentHash && <div><dt className="text-mute">{t('fingerprint')}</dt><dd className="break-all font-mono text-[11px] text-mute">{prop.intentHash}</dd></div>}
            {prop.txid && ['broadcast', 'confirming', 'finalized', 'failed'].includes(prop.state) && <div><dt className="text-mute">{t('txid')}</dt><dd className="break-all font-mono text-[11px]">{prop.txid}</dd></div>}
          </dl>
          {prop.state === 'pending_approval' && <div className="mt-3 space-y-3">
            <Notice tone="ok">{t('brGuarantee', { from: prop.networkName, to: prop.bridge.toNetworkName })}{prop.bridge.sol ? ` ${prop.bridge.sol.role === 'source' ? t('scReviewSrc', { to: prop.bridge.toNetworkName }) : t('scReviewDst')}` : ''}</Notice>
            {prop.bridge.needsApproval && <Notice tone="info">{t('qaBrNeedsApproval', { sym: prop.symbol })}</Notice>}
            <Notice tone="info">{t('brIrreversible', { from: prop.networkName, to: prop.bridge.toNetworkName })} {t('expiresIn')} {left} s.</Notice>
          </div>}
          {prop.error && ['failed', 'expired', 'rejected'].includes(prop.state) && <div className="mt-3"><Notice tone="danger">{prop.error}</Notice></div>}
          {testNotSent(prop) && <div className="mt-3"><Notice tone="warn">{t('qaTestNotSent')}</Notice></div>}
          {prop.state !== 'pending_approval' && !testNotSent(prop) && <div className="mt-4"><BridgeProgress id={prop.id} b={prop.bridge} onUpdate={(p) => { setExec({ ...exec, proposal: p }); void qc.invalidateQueries({ queryKey: ['proposal', p.id] }); }} /></div>}
          {execErr && <div className="mt-3"><Notice tone="danger">{execErr}</Notice></div>}
          {prop.explorer && !testNotSent(prop) && ['broadcast', 'confirming', 'finalized', 'failed'].includes(prop.state) && <a className="mt-3 inline-flex items-center gap-1.5 text-sm text-blue" href={prop.explorer} target="_blank" rel="noreferrer noopener"><Icon n="ext" className="h-4 w-4" />{t('viewExplorer')}</a>}
          <div className="mt-4 space-y-2.5">
            {prop.state === 'pending_approval' && <Btn full busy={!!busy} disabled={left === 0} onClick={() => void approve()}><Icon n="key" />{busy === 'passkey' ? t('approving') : t('approve')}</Btn>}
            <Btn full kind="ghost" disabled={!!busy} onClick={() => void closeExec()}>{prop.state === 'pending_approval' ? t('cancel') : t('swClose')}</Btn>
          </div>
        </div>
      </div>}

      {exec && prop?.xswap && <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/45 lg:items-center" role="dialog" aria-modal="true" aria-label={t('xsReview')}>
        <div className="rise max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-surface p-5 lg:rounded-3xl">
          <div className="mb-3 flex items-center justify-between"><h2 className="text-[20px] font-semibold tracking-tight">{prop.state === 'pending_approval' ? t('xsReview') : t('xsTracking')}</h2><XswapPill x={prop.xswap} /></div>
          <XswapSheet prop={prop} left={left} onUpdate={(p) => { setExec({ ...exec, proposal: p }); void qc.invalidateQueries({ queryKey: ['proposal', p.id] }); }} />
          {execErr && <div className="mt-3"><Notice tone="danger">{execErr}</Notice></div>}
          {prop.explorer && ['broadcast', 'confirming', 'finalized', 'failed'].includes(prop.state) && <a className="mt-3 inline-flex items-center gap-1.5 text-sm text-blue" href={prop.explorer} target="_blank" rel="noreferrer noopener"><Icon n="ext" className="h-4 w-4" />{t('viewExplorer')}</a>}
          <div className="mt-4 space-y-2.5">
            {prop.state === 'pending_approval' && <Btn full busy={!!busy} disabled={left === 0} onClick={() => void approve()}><Icon n="key" />{busy === 'passkey' ? t('approving') : t('approve')}</Btn>}
            <Btn full kind="ghost" disabled={!!busy} onClick={() => void closeExec()}>{prop.state === 'pending_approval' ? t('cancel') : t('swClose')}</Btn>
          </div>
        </div>
      </div>}

      <Picker open={pick !== null} onClose={() => setPick(null)} assets={assets} balances={balances} exclude={pick === 'from' ? toKey : fromKey} onPick={(a) => { if (pick === 'from') setFromKey(a.key); else setToKey(a.key); }} />
    </div>
  );
}
