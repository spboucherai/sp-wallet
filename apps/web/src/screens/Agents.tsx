import { startAuthentication } from '@simplewebauthn/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { get, post } from '../api';
import type { Nav } from '../App';
import { PriceChart } from '../chart';
import { errText, I18n, useT, type Key } from '../i18n';
import { Addr, Btn, Card, Coin, CopyBtn, Field, fiat, H, Icon, inputCls, Notice, Skeleton, trimAmt, when } from '../ui';
// >>> v6 perp agents (simulation only): their form and their detail page live in PerpAgent.tsx
import { Seg } from '../derivatives/bits';
import { PerpAgentDetail, PerpAgentForm } from './PerpAgent';
// <<< v6 perp agents

interface AgentV { id: string; name: string; mission: string; state: string; mode: string; network: string; networkName: string; cash: string; universe: string[]; interval: string; capitalUsdc: string; vaultAddress: string;
  risk: { maxExposurePct: number; maxLossPct: number; maxOrderUsd: number; maxDailyUsd: number; maxOrdersPerDay: number; mandateDays: number; slippageBps: number }; strategyVersionId: string | null; mandateId: string | null; stopReason: string | null; lastBar: string | null }
const STATE_TONE: Record<string, string> = { LIVE: 'text-emerald bg-emerald/10', PAPER_TRADING: 'text-blue bg-blue/10', AWAITING_APPROVAL: 'text-warn bg-warn/12', PAUSED: 'text-warn bg-warn/12', STOPPED: 'text-mute bg-elev', FAILED: 'text-danger bg-danger/10' };
export function AgentState({ state }: { state: string }) {
  const t = useT();
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${STATE_TONE[state] ?? 'text-mute bg-elev'}`}><Icon n={state === 'LIVE' ? 'check' : state === 'FAILED' ? 'x' : 'clock'} className="h-3 w-3" />{t(`ag_${state}` as Key)}</span>;
}
// what GET /agents/networks returns: everything is derived from the wallet's token registry, nothing is listed here
interface Repr { asset: string; assetSymbol: string; name: string; kind: 'native' | 'token' | 'wrapped' | 'pegged'; issuer: string | null }
interface Sym { symbol: string; sources: string[]; live: boolean; defaultAsset: string | null; data: Record<string, { status: string; fresh: boolean } | null>; representations: Repr[] }
interface Net { id: string; name: string; native: string; enabled: boolean; cash: { symbol: string; asset: string; name: string }[]; defaultCash: string | null; feeWarning: boolean;
  gas: { reserve: string; perOrder: string; perOrderUsd: number | null; gasPriceGwei: number } | null; symbols: Sym[] }

export function Agents({ nav }: { nav: Nav }) {
  const t = useT(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['agents'], queryFn: () => get<{ agents: AgentV[] }>('/agents'), refetchInterval: 30_000 });
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const [kind, setKind] = useState<'spot' | 'perp'>('spot'); // v6: which kind of agent the form creates
  const nets = useQuery({ queryKey: ['agent-networks'], queryFn: () => get<{ networks: Net[]; maxSymbols: number; maxLiveSymbols: number }>('/agents/networks'), staleTime: 60_000, enabled: open });
  const [f, setF] = useState({ name: '', mission: '', capital: '100', network: 'base', cash: '', universe: [] as string[], assets: {} as Record<string, string>, interval: '1h', maxExposurePct: 50, maxLossPct: 5, maxOrderUsd: 25, maxDailyUsd: 100, maxOrdersPerDay: 12 });
  const net = nets.data?.networks.find((n) => n.id === f.network), maxSym = nets.data?.maxSymbols ?? 12;
  const cash = f.cash || net?.defaultCash || net?.cash[0]?.symbol || 'USDC';
  const symOf = (x: string) => net?.symbols.find((y) => y.symbol === x);
  const reprOf = (y: Sym) => y.representations.find((r) => r.asset === (f.assets[y.symbol] ?? y.defaultAsset));
  const chosen = f.universe.map(symOf).filter((y): y is Sym => !!y);
  const paperOnly = chosen.filter((y) => !y.live).map((y) => y.symbol);
  const wrapped = chosen.map(reprOf).filter((r): r is Repr => !!r && (r.kind === 'wrapped' || r.kind === 'pegged'));
  const undecided = chosen.some((y) => !reprOf(y));
  const create = async () => {
    setBusy(true); setErr('');
    try {
      const a = await post<AgentV>('/agents', { name: f.name.trim(), mission: f.mission.trim(), network: f.network, universe: f.universe, cash, assets: Object.fromEntries(chosen.flatMap((y) => { const r = reprOf(y); return r ? [[y.symbol, r.asset]] : []; })), interval: f.interval, capitalUsdc: f.capital,
        risk: { maxExposurePct: f.maxExposurePct, maxLossPct: f.maxLossPct, maxOrderUsd: f.maxOrderUsd, maxDailyUsd: f.maxDailyUsd, maxOrdersPerDay: f.maxOrdersPerDay, mandateDays: 30, slippageBps: 50 } });
      await qc.invalidateQueries({ queryKey: ['agents'] }); setOpen(false); nav({ tab: 'agent', asset: a.id });
    } catch (e) { setErr(errText(t, e)); } finally { setBusy(false); }
  };
  const num = (k: keyof typeof f, label: string, suffix: string, min: number, max: number) => <Field label={label}><div className="flex items-center gap-2">
    <input className={inputCls} inputMode="decimal" value={String(f[k])} onChange={(e) => setF({ ...f, [k]: Math.max(min, Math.min(max, Number(e.target.value.replace(/[^0-9.]/g, '')) || 0)) })} /><span className="w-12 shrink-0 text-[13px] text-mute">{suffix}</span></div></Field>;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between pt-2"><h1 className="text-[30px] font-semibold tracking-[-0.02em]">{t('agents')}</h1>
        <Btn kind="soft" onClick={() => setOpen(!open)}><Icon n={open ? 'x' : 'key'} className="h-4 w-4" />{open ? t('cancel') : t('agNew')}</Btn></div>
      <Notice tone="info">{t('agIntro')}</Notice>
      {/* >>> v6 perp agents: the kind of agent; a perp agent has its own form */}
      {open && <Seg<'spot' | 'perp'> value={kind} onChange={setKind} label={t('paKindLabel')} options={[{ id: 'spot', label: t('paKindSpot') }, { id: 'perp', label: t('paKindPerp') }]} />}
      {open && kind === 'perp' && <Card><PerpAgentForm nav={nav} onCreated={async () => { await qc.invalidateQueries({ queryKey: ['agents'] }); setOpen(false); }} /></Card>}
      {/* <<< v6 perp agents */}
      {open && kind === 'spot' && <Card className="space-y-4">
        <Field label={t('agName')}><input className={inputCls} maxLength={40} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="ETH Trend" /></Field>
        <Field label={t('agMission')}><textarea className={`${inputCls} min-h-[72px] resize-none`} maxLength={400} value={f.mission} onChange={(e) => setF({ ...f, mission: e.target.value })} /></Field>
        <Field label={t('agNetwork')} hint={t('agNetworkNote')}><select className={inputCls} value={f.network} onChange={(e) => setF({ ...f, network: e.target.value, universe: [], assets: {}, cash: '' })}>
          {(nets.data?.networks ?? [{ id: 'base', name: 'Base', enabled: true } as Net]).map((n) => <option key={n.id} value={n.id} disabled={!n.enabled}>{n.name}{n.enabled ? '' : ` — ${t('agNetOff')}`}</option>)}</select></Field>
        {net?.feeWarning && <Notice tone="warn">{t('agFeeWarn', { cost: net.gas?.perOrderUsd != null ? t('agFeeCost', { usd: net.gas.perOrderUsd.toFixed(2) }) : '' })}</Notice>}
        {net && net.cash.length > 1 && <Field label={t('agCash')}><select className={inputCls} value={cash} onChange={(e) => setF({ ...f, cash: e.target.value })}>{net.cash.map((c) => <option key={c.symbol} value={c.symbol}>{c.symbol} — {c.name}</option>)}</select></Field>}
        <div><div className="mb-2 text-[13px] text-mute">{t('agUniverse', { cash })}</div>
          {nets.isLoading || !net ? <Skeleton h="h-16" /> : <div className="flex flex-wrap gap-2">{net.symbols.map((y) => { const on = f.universe.includes(y.symbol), full = !on && f.universe.length >= maxSym, r = reprOf(y), ready = !!(y.data['1h'] ?? y.data['1d']); return (
            <button key={y.symbol} role="checkbox" aria-checked={on} disabled={full} title={`${y.representations.map((x) => x.name).join(' / ')} · ${y.sources.join(', ')}`} onClick={() => setF({ ...f, universe: on ? f.universe.filter((x) => x !== y.symbol) : [...f.universe, y.symbol] })}
              className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-[14px] font-medium ${on ? 'border-primary bg-primary text-onprimary' : 'border-line'} ${full ? 'opacity-40' : ''}`}><Coin sym={y.symbol} size={22} />{y.symbol}
              {r && r.assetSymbol !== y.symbol && <span className="text-[12px] font-normal opacity-80">{r.assetSymbol}</span>}
              {!y.live && <span className="rounded-full bg-warn/15 px-1.5 text-[10.5px] font-semibold text-warn">{t('agPaperOnly')}</span>}
              {!ready && <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-label={t('agNoData')} title={t('agNoData')} />}</button>); })}</div>}
          <p className="mt-2 text-[12.5px] text-mute">{t('agUniverseNote', { max: maxSym, live: nets.data?.maxLiveSymbols ?? 11 })}</p>
          {chosen.filter((y) => y.representations.length > 1).map((y) => <div key={y.symbol} className="mt-3"><Field label={`${y.symbol} — ${t('agRepr')}`}><select className={inputCls} value={reprOf(y)?.asset ?? ''} onChange={(e) => setF({ ...f, assets: { ...f.assets, [y.symbol]: e.target.value } })}>
            {!reprOf(y) && <option value="">—</option>}{y.representations.map((x) => <option key={x.asset} value={x.asset}>{x.assetSymbol} — {x.name} ({x.kind === 'native' ? t('agReprNative') : x.kind === 'token' ? t('agReprToken') : t('agIssuer', { issuer: x.issuer ?? '?' })})</option>)}</select></Field></div>)}
          {wrapped.length > 0 && <div className="mt-3"><Notice tone="warn">{t('agIssuerNote', { assets: wrapped.map((r) => `${r.assetSymbol} — ${r.issuer}`).join(' ; ') })}</Notice></div>}
          {paperOnly.length > 0 && <div className="mt-3"><Notice tone="info">{t('agPaperOnlyNote', { assets: paperOnly.join(', ') })}</Notice></div>}
          {net?.gas && <p className="mt-2 text-[12.5px] text-mute">{t('agGasReserve', { amount: trimAmt(net.gas.reserve, 6), sym: net.native })}{net.gas.perOrderUsd != null && ` ${t('agFeeShare', { usd: net.gas.perOrderUsd.toFixed(net.gas.perOrderUsd < 0.1 ? 4 : 2), pct: ((100 * net.gas.perOrderUsd) / Math.max(1, f.maxOrderUsd)).toFixed(1) })}`}</p>}</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('agCapital')}><div className="flex items-center gap-2"><input className={inputCls} inputMode="decimal" value={f.capital} onChange={(e) => setF({ ...f, capital: e.target.value.replace(',', '.').replace(/[^0-9.]/g, '') })} /><span className="w-12 shrink-0 text-[13px] text-mute">{cash}</span></div></Field>
          <Field label={t('agInterval')}><select className={inputCls} value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })}><option value="1h">1 h</option><option value="1d">1 j / 1 d</option></select></Field>
          {num('maxExposurePct', t('agMaxExposure'), '%', 1, 100)}{num('maxLossPct', t('agMaxLoss'), '%', 1, 100)}
          {num('maxOrderUsd', t('agMaxOrder'), 'USD', 1, 100000)}{num('maxDailyUsd', t('agMaxDaily'), 'USD', 1, 1000000)}
        </div>
        <Notice tone="warn">{t('agLossNote')}</Notice>
        {err && <Notice tone="danger">{err}</Notice>}
        <Btn full busy={busy} disabled={f.name.trim().length < 2 || !f.universe.length || f.universe.length > maxSym || undecided || !net?.enabled || !(Number(f.capital) > 0)} onClick={() => void create()}>{t('agCreate')}</Btn>
      </Card>}
      {q.isLoading ? <Skeleton h="h-40" /> : (q.data?.agents.length ?? 0) === 0 ? !open && <Card><p className="py-6 text-center text-[14px] text-mute">{t('agNone')}</p></Card> :
        <div className="space-y-3">{q.data!.agents.map((a) => <button key={a.id} onClick={() => nav({ tab: 'agent', asset: a.id })} className="card flex w-full items-center gap-3.5 p-4 text-left">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-elev"><Icon n="swap" /></span>
          <span className="min-w-0 flex-1"><span className="block truncate text-[16px] font-semibold">{a.name}</span><span className="block truncate text-[12.5px] text-mute">{a.universe.join(' · ')} · {a.capitalUsdc} {a.cash ?? 'USDC'} · {a.networkName}</span>{(a as { kind?: string }).kind === 'perp' && <span className="mt-0.5 inline-block rounded-md border border-blue/35 bg-blue/8 px-1.5 text-[10.5px] font-bold uppercase tracking-[0.06em] text-blue">{t('paListTag')}</span>}</span>
          <AgentState state={a.state} /><Icon n="chev" className="h-4 w-4 text-mute" /></button>)}</div>}
    </div>
  );
}

export function Agent({ id, nav }: { id: string; nav: Nav }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['agent', id], queryFn: () => get<any>(`/agents/${id}`), refetchInterval: 15_000 });
  const spot = !!q.data && q.data.kind !== 'perp'; // v6: the vault and the spot library do not exist for a perp agent
  const else_ = useQuery({ queryKey: ['agent-elsewhere', id], queryFn: () => get<{ holdings: any[] }>(`/agents/${id}/elsewhere`), refetchInterval: 60_000, enabled: spot });
  const lib = useQuery({ queryKey: ['strategies'], queryFn: () => get<{ strategies: any[] }>('/strategies'), staleTime: 300_000, enabled: spot });
  const [busy, setBusy] = useState(''), [err, setErr] = useState(''), [mandate, setMandate] = useState<any>(null), [note, setNote] = useState('');
  if (q.isLoading || !q.data) return <div className="space-y-4"><Skeleton h="h-40" /><Skeleton h="h-56" /></div>;
  const a = q.data;
  if (a.kind === 'perp') return <PerpAgentDetail a={a} id={id} nav={nav} />; // v6: simulation-only detail page
  const act = async (name: string, fn: () => Promise<unknown>) => { setBusy(name); setErr(''); setNote(''); try { await fn(); await qc.invalidateQueries({ queryKey: ['agent', id] }); await qc.invalidateQueries({ queryKey: ['agents'] }); } catch (e) { const m = errText(t, e); if (m) setErr(m); } finally { setBusy(''); } };
  const prepare = () => act('prepare', async () => setMandate(await post(`/agents/${id}/mandate/prepare`)));
  const approveMandate = () => act('mandate', async () => { const assertion = await startAuthentication({ optionsJSON: mandate.options }); await post(`/agents/${id}/mandate/approve`, { assertion }); setMandate(null); });
  const vaultUsd = (a.vault ?? []).reduce((s: number, x: any) => s + (x.usd ?? 0), 0);
  const eq = (a.equity as any[]).filter((e) => e.mode === (a.state === 'LIVE' ? 'LIVE' : 'PAPER')).map((e) => ({ t: new Date(e.ts).getTime(), p: e.equity_usd }));
  const approved = (a.versions as any[]).find((v) => v.id === a.strategyVersionId);
  const metric = (v: any, split: string, k: string) => { const x = v.metrics?.[split]?.[k]; return typeof x === 'number' ? x : null; };
  const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)} %`), num2 = (x: number | null) => (x === null ? '—' : x.toFixed(2));
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 pt-1"><button onClick={() => nav({ tab: 'agents' })} aria-label={t('back')} className="-ml-2 grid h-11 w-11 place-items-center rounded-full"><Icon n="chev" className="h-6 w-6 rotate-180" /></button>
        <div className="min-w-0 flex-1"><h1 className="truncate text-[24px] font-semibold tracking-tight">{a.name}</h1><div className="text-[13px] text-mute">{a.universe.join(' · ')} · {a.interval} · {a.networkName}</div></div><AgentState state={a.state} /></div>
      {a.mission && <p className="text-[14px] text-mute">{a.mission}</p>}
      {a.stopReason && <Notice tone="warn">{a.stopReason}</Notice>}
      {err && <Notice tone="danger">{err}</Notice>}{note && <Notice tone="ok">{note}</Notice>}

      <Card><H>{t('agVault')}</H>
        <div className="text-[30px] font-semibold tracking-tight">{fiat(vaultUsd, 'USD', locale)}</div>
        <div className="text-[13px] text-mute">{t('agAllocated')} {a.capitalUsdc} {a.cash ?? 'USDC'}</div>
        <ul className="mt-3 divide-y divide-line">{(a.vault ?? []).map((x: any) => <li key={x.asset} className="flex items-center gap-3 py-2.5"><Coin sym={x.symbol} size={32} /><span className="flex-1 text-[15px] font-medium">{x.symbol}{x.role === 'gas' ? <span className="block text-[12px] font-normal text-mute">{t('agGasRole')}</span> : x.assetSymbol && x.assetSymbol !== x.symbol ? <span className="block text-[12px] font-normal text-mute">{t('agHeldAs', { asset: `${x.assetSymbol} — ${x.name}` })}{x.issuer ? ` · ${t('agIssuer', { issuer: x.issuer })}` : ''}</span> : null}</span><span className="text-right text-[14.5px] font-semibold">{trimAmt(x.display, 8)}<span className="block text-[12px] font-normal text-mute">{x.usd !== null ? fiat(x.usd, 'USD', locale) : ''}</span></span></li>)}</ul>
        <div className="mt-3 rounded-2xl bg-elev/70 p-3"><div className="mb-1 text-[12px] text-mute">{t('agVaultAddr', { network: a.networkName })}</div><Addr value={a.vaultAddress} /></div>
        <div className="mt-3 grid grid-cols-2 gap-3"><CopyBtn text={a.vaultAddress} full />
          <Btn kind="soft" onClick={() => nav({ tab: 'send', network: a.network ?? 'base' })}><Icon n="up" className="h-4 w-4" />{t('agFund')}</Btn></div>
        <p className="mt-2 text-[12.5px] text-mute">{t('agFundNote', { cash: a.cash ?? 'USDC', native: (a.vault ?? []).find((x: any) => x.asset === 'native')?.assetSymbol ?? 'ETH', network: a.networkName })}</p>
        {(a.holdings ?? []).some((h: any) => h.kind === 'wrapped' || h.kind === 'pegged') && <div className="mt-3"><Notice tone="warn">{t('agIssuerNote', { assets: (a.holdings as any[]).filter((h) => h.kind === 'wrapped' || h.kind === 'pegged').map((h) => `${h.assetSymbol} — ${h.issuer}`).join(' ; ') })}</Notice></div>}
        {a.state !== 'LIVE' && <div className="mt-3 flex flex-wrap gap-2">{(a.vault ?? []).filter((x: any) => x.amount !== '0').map((x: any) =>
          <Btn key={x.asset} kind="ghost" busy={busy === `w${x.asset}`} onClick={() => act(`w${x.asset}`, async () => { const r = await post<any>(`/agents/${id}/withdraw`, { asset: x.asset }); setNote(`${t('agWithdrawn')} ${r.amount} ${r.symbol}`); })}>{t('agWithdraw')} {x.symbol}</Btn>)}</div>}
        {(else_.data?.holdings ?? []).length > 0 && <div className="mt-4"><Notice tone="warn">{t('agElsewhere', { network: a.networkName })}</Notice>
          <ul className="mt-2 space-y-2">{else_.data!.holdings.map((h: any) => <li key={`${h.network}:${h.asset}`} className="flex items-center gap-3 rounded-2xl border border-line p-3">
            <span className="min-w-0 flex-1"><span className="block font-semibold">{h.display} {h.symbol}</span><span className="block text-[12.5px] text-mute">{h.networkName}{!h.hasGas && h.asset !== 'native' ? ` · ${t('agElsewhereGas', { gas: h.gas })}` : ''}</span></span>
            <Btn kind="soft" busy={busy === `e${h.network}${h.asset}`} onClick={() => act(`e${h.network}${h.asset}`, async () => { const r = await post<any>(`/agents/${id}/withdraw`, { asset: h.asset, network: h.network }); setNote(`${t('agWithdrawn')} ${r.amount} ${r.symbol}`); await qc.invalidateQueries({ queryKey: ['agent-elsewhere', id] }); })}>{t('agWithdraw')}</Btn></li>)}</ul></div>}
      </Card>

      {eq.length > 1 && <Card><H>{t('agEquity')}</H><PriceChart points={eq} format={(v) => fiat(v, 'USD', locale)} formatTime={(ts) => new Date(ts).toLocaleDateString(locale === 'fr' ? 'fr-CA' : 'en-CA', { day: 'numeric', month: 'short' })} /></Card>}

      <Card><H>{t('agStrategy')}</H>
        {(a.versions as any[]).length === 0 ? <p className="text-[14px] text-mute">{t('agNoStrategy')}</p> : <ul className="space-y-3">{(a.versions as any[]).map((v) => <li key={v.id} className="rounded-2xl bg-elev/70 p-3.5">
          <div className="flex items-center justify-between gap-2"><span className="font-semibold">{v.name} <span className="font-normal text-mute">v{v.version}</span></span><span className="rounded-full bg-surface px-2 py-0.5 text-[11.5px] font-semibold">{t(`agV_${v.status}` as Key)}</span></div>
          <div className="mt-1 break-all font-mono text-[11px] text-mute">sha256 {v.code_sha256}</div>
          {v.metrics ? <><div className="mt-2.5 grid grid-cols-3 gap-2 text-center text-[12.5px]">
            {[[t('agTest'), 'test'], [t('agBench'), null]].length && null}
            <div className="rounded-xl bg-surface p-2"><div className="text-mute">{t('agRet')}</div><div className="text-[14px] font-semibold">{pct(metric(v, 'test', 'total_return'))}</div><div className="text-[11px] text-mute">{t('agVs')} {pct(v.benchmarks?.buy_and_hold?.total_return ?? null)}</div></div>
            <div className="rounded-xl bg-surface p-2"><div className="text-mute">Sharpe</div><div className="text-[14px] font-semibold">{num2(metric(v, 'test', 'sharpe'))}</div><div className="text-[11px] text-mute">{t('agVs')} {num2(v.benchmarks?.buy_and_hold?.sharpe ?? null)}</div></div>
            <div className="rounded-xl bg-surface p-2"><div className="text-mute">{t('agDD')}</div><div className="text-[14px] font-semibold">{pct(metric(v, 'test', 'max_drawdown'))}</div><div className="text-[11px] text-mute">{t('agVs')} {pct(v.benchmarks?.buy_and_hold?.max_drawdown ?? null)}</div></div></div>
            <p className="mt-2 text-[12px] text-mute">{t('agReportNote', { trials: v.robustness?.trials_tested ?? '?', dsr: typeof v.robustness?.deflated_sharpe === 'number' ? v.robustness.deflated_sharpe.toFixed(2) : '?', fee: v.config?.fee_bps ?? '?', slip: v.config?.slippage_bps ?? '?' })}</p></>
            : <p className="mt-2 text-[12.5px] text-mute">{v.status === 'backtesting' ? t('agBacktesting') : v.notes ? v.notes : t('agNoReport')}</p>}
          {v.status !== 'approved' && v.metrics && a.state !== 'LIVE' && <Btn kind="soft" full className="mt-3" busy={busy === `a${v.id}`} onClick={() => act(`a${v.id}`, () => post(`/agents/${id}/strategies/${v.id}/approve`))}>{t('agApproveVersion')}</Btn>}
        </li>)}</ul>}
        {a.state !== 'LIVE' && (() => { const have = new Set((a.versions as any[]).map((v) => v.code_sha256)), uni = [...(a.universe as string[])].sort().join(), n = (a.universe as string[]).length;
          // a universe-generic strategy fits any agent whose number of assets is within its bounds; a fixed one needs exactly these assets
          const fit = (lib.data?.strategies ?? []).filter((x) => !have.has(x.sha256) && x.meta.interval === a.interval && (x.generic ? n >= x.minSymbols && n <= x.maxSymbols : [...x.meta.universe].sort().join() === uni));
          return <div className="mt-4"><div className="mb-2 text-[13px] font-semibold text-mute">{t('agLibrary')}</div>
            {lib.isLoading ? <Skeleton h="h-16" /> : fit.length === 0 ? <p className="text-[13px] text-mute">{t('agLibNone', { assets: (a.universe as string[]).join(', '), interval: a.interval })}</p> :
              <ul className="space-y-2">{fit.map((x) => <li key={x.sha256} className="flex items-center gap-3 rounded-2xl border border-line p-3">
                <span className="min-w-0 flex-1"><span className="block font-semibold">{x.meta.name} <span className="font-normal text-mute">v{x.meta.version}</span>{x.generic && <span className="ml-2 rounded-full bg-blue/10 px-2 py-0.5 text-[11px] font-semibold text-blue">{t('agGeneric')}</span>}</span>
                  <span className="block truncate text-[12px] text-mute">{x.generic ? t('agGenericNote', { n: (a.universe as string[]).join(' · ') }) : x.meta.universe.join(' · ')} · {x.meta.interval} · {Object.entries(x.meta.params).map(([k, v]) => `${k} ${String(v)}`).join(', ')}</span></span>
                <Btn kind="soft" busy={busy === `r${x.sha256}`} onClick={() => act(`r${x.sha256}`, () => post(`/agents/${id}/strategies`, { path: x.path.replace(/^strategies\//, '') }))}>{t('agLibTest')}</Btn></li>)}</ul>}
          </div>; })()}
      </Card>

      <Card><H>{t('agControl')}</H>
        <div className="space-y-2.5">
          {approved && ['AWAITING_APPROVAL', 'PAUSED', 'STOPPED', 'CREATED'].includes(a.state) && <Btn kind="soft" full busy={busy === 'paper'} onClick={() => act('paper', () => post(`/agents/${id}/mode`, { mode: 'PAPER' }))}>{t('agStartPaper')}</Btn>}
          {a.state === 'PAPER_TRADING' && <Btn kind="ghost" full busy={busy === 'pause'} onClick={() => act('pause', () => post(`/agents/${id}/mode`, { mode: 'PAUSED' }))}>{t('agPause')}</Btn>}
          {approved && a.state !== 'LIVE' && !mandate && <Btn full busy={busy === 'prepare'} onClick={() => void prepare()}><Icon n="key" />{t('agGoLive')}</Btn>}
          {a.state === 'LIVE' && <Btn kind="danger" full busy={busy === 'revoke'} onClick={() => act('revoke', () => post(`/agents/${id}/revoke`))}><Icon n="stop" />{t('agRevoke')}</Btn>}
          {!approved && <p className="text-[13.5px] text-mute">{t('agNeedsStrategy')}</p>}
        </div>
        {mandate && <div className="mt-4 space-y-3 rounded-2xl border border-line p-4">
          <div className="text-[16px] font-semibold">{t('agMandateTitle')}</div>
          <Notice tone="warn">{t('agMandateWarn')}</Notice>
          <ul className="space-y-1.5 text-[13.5px]">{(mandate.limits as any[]).map((l) => <li key={l.symbol} className="flex justify-between gap-3"><span className="font-medium">{l.symbol}</span><span className="text-mute">{trimAmt(l.maxOrder, 6)} {t('agPerOrder')} · {trimAmt(l.maxDaily, 6)} {t('agPerDay')}</span></li>)}</ul>
          {(mandate.limits as any[]).some((l) => l.kind === 'wrapped' || l.kind === 'pegged') && <Notice tone="warn">{t('agIssuerNote', { assets: (mandate.limits as any[]).filter((l) => l.kind === 'wrapped' || l.kind === 'pegged').map((l) => `${l.assetSymbol} — ${l.issuer}`).join(' ; ') })}</Notice>}
          <dl className="space-y-1.5 text-[13px]"><div className="flex justify-between gap-3"><dt className="text-mute">{t('agMandateNet')}</dt><dd>{mandate.networkName}</dd></div>
            {mandate.gasReserve && <div className="flex justify-between gap-3"><dt className="text-mute">{t('agMandateGas')}</dt><dd>{trimAmt(mandate.gasReserve.required, 6)} {mandate.gasReserve.symbol}</dd></div>}
            <div className="flex justify-between gap-3"><dt className="text-mute">{t('agOrdersDay')}</dt><dd>{mandate.mandate.maxOrdersPerDay}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-mute">{t('agExpires')}</dt><dd>{when(new Date(mandate.mandate.expiresAt * 1000), locale)}</dd></div>
            <div><dt className="text-mute">{t('agStrategyHash')}</dt><dd className="break-all font-mono text-[11px]">{mandate.mandate.strategySha256}</dd></div>
            <div><dt className="text-mute">{t('fingerprint')}</dt><dd className="break-all font-mono text-[11px]">{mandate.hash}</dd></div></dl>
          <Btn full busy={busy === 'mandate'} onClick={() => void approveMandate()}><Icon n="key" />{t('agApproveMandate')}</Btn>
          <Btn full kind="ghost" onClick={() => setMandate(null)}>{t('cancel')}</Btn>
        </div>}
        {a.mandateStatus && <div className="mt-4 text-[13px] text-mute">{t('agMandateState')}: {a.mandateStatus.revoked ? t('agM_revoked') : a.mandateStatus.expired ? t('agM_expired') : t('agM_active')} · {t('agOrdersToday')} {a.mandateStatus.today.orders}/{a.mandateStatus.maxOrdersPerDay}</div>}
      </Card>

      <Card className="!px-0 !pb-1"><div className="px-5"><H>{t('agOrders')}</H></div>
        {(a.orders as any[]).length === 0 ? <p className="px-5 pb-4 text-[14px] text-mute">{t('agNoOrders')}</p> : <ul>{(a.orders as any[]).slice(0, 25).map((o, k) => <li key={o.id} className={`flex items-center gap-3 px-5 py-2.5 ${k ? 'border-t border-line' : ''}`}>
          <span className="min-w-0 flex-1"><span className="block text-[14px] font-medium">{o.from_symbol} → {o.to_symbol} <span className="font-normal text-mute">· {o.mode === 'LIVE' ? t('agLive') : t('agPaper')}</span></span><span className="block truncate text-[12px] text-mute">{when(o.ts, locale)}{o.reason ? ` · ${o.reason}` : ''}</span></span>
          <span className={`rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${o.state === 'filled' ? 'bg-emerald/10 text-emerald' : o.state === 'failed' ? 'bg-danger/10 text-danger' : 'bg-elev text-mute'}`}>{t(`agO_${o.state}` as Key)}</span></li>)}</ul>}</Card>

      <Card><H>{t('agLog')}</H>
        {(a.log as any[]).length === 0 ? <p className="text-[14px] text-mute">{t('agNoLog')}</p> : <ul className="space-y-2.5 text-[13px]">{(a.log as any[]).map((l, k) => <li key={k}><div className="flex justify-between gap-2"><span className="font-medium">{l.title}</span><span className="shrink-0 text-[12px] text-mute">{when(l.ts, locale)}</span></div>{l.body && <div className="whitespace-pre-wrap text-mute">{String(l.body).slice(0, 600)}</div>}</li>)}</ul>}</Card>
    </div>
  );
}
