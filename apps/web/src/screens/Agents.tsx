import { startAuthentication } from '@simplewebauthn/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { get, post } from '../api';
import type { Nav } from '../App';
import { PriceChart } from '../chart';
import { useNetworks } from '../hooks';
import { issuerOf, LIQUID_HINT } from '../issuer';
import { errText, I18n, useT, type Key } from '../i18n';
import { Addr, Btn, Card, Coin, CopyBtn, Field, fiat, H, Icon, inputCls, Notice, numFmt, Skeleton, trimAmt, usdCapital, when } from '../ui';
import { amountOf, sanitizeAmountText } from '../amount'; // v8 hardening
import { AmountProblem } from '../amountUi';
// >>> v6 perp agents (simulation only): their form and their detail page live in PerpAgent.tsx
import { Seg } from '../derivatives/bits';
import { PerpAgentDetail, PerpAgentForm } from './PerpAgent';
import { agentTone, PerpLiveState } from './PerpAgentLive';   // v7 perp live: a live perp agent names the money it moves
// <<< v6 perp agents
import { AgentChecklist, ElsewhereFunds, FundSheet, fundingInProgress, WithdrawSheet, type AgentNet } from './AgentFund';
import { ResearchPanel } from './Research'; // v7 research runtime
import { PaperBookCard, showPaperBook } from './AgentPaper'; // v8 hardening: simulated positions, apart from the real vault

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
  const t = useT(); const qc = useQueryClient(); const { locale } = useContext(I18n); const wnets = useNetworks();
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
  // issuer of every chosen holding AND of the cash leg: from the reviewed wrappers and from the registry's deployment name ("Binance-Peg Ethereum")
  const iss = (r: { assetSymbol: string; name: string; issuer?: string | null }) => issuerOf(t, r.assetSymbol, r.name, r.issuer);
  const cashDef = net?.cash.find((c) => c.symbol === cash), cashIss = cashDef ? iss({ assetSymbol: cashDef.symbol, name: cashDef.name }) : null;
  const cashDec = wnets.data?.find((n) => n.id === f.network)?.tokens.find((x) => x.id.toLowerCase() === cashDef?.asset.toLowerCase())?.decimals;
  const wrapped = [...(cashDef && cashIss ? [`${cashDef.symbol} (${cashDef.name}) — ${cashIss.text}`] : []), ...chosen.map(reprOf).flatMap((r) => { const i = r && iss(r); return r && i ? [`${r.assetSymbol}${r.name !== r.assetSymbol ? ` (${r.name})` : ''} — ${i.text}`] : []; })];
  const noData = !!net && net.symbols.some((y) => !(y.data['1h'] ?? y.data['1d']));
  const undecided = chosen.some((y) => !reprOf(y));
  const create = async () => {
    setBusy(true); setErr('');
    try {
      const a = await post<AgentV>('/agents', { name: f.name.trim(), mission: f.mission.trim(), network: f.network, universe: f.universe, cash, assets: Object.fromEntries(chosen.flatMap((y) => { const r = reprOf(y); return r ? [[y.symbol, r.asset]] : []; })), interval: f.interval, capitalUsdc: amountOf(f.capital, locale) ?? f.capital,
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
      {/* v7 research runtime */}<button data-testid="rj-open" onClick={() => nav({ tab: 'research' })} className="card flex w-full items-center gap-3 p-3.5 text-left"><Icon n="list" /><span className="flex-1 text-[14.5px] font-medium">{t('rjTitle')}</span><Icon n="chev" className="h-4 w-4 text-mute" /></button>
      {/* >>> v6 perp agents: the kind of agent; a perp agent has its own form */}
      {open && <Seg<'spot' | 'perp'> value={kind} onChange={setKind} label={t('paKindLabel')} options={[{ id: 'spot', label: t('paKindSpot') }, { id: 'perp', label: t('paKindPerp') }]} />}
      {open && kind === 'perp' && <Card><PerpAgentForm nav={nav} onCreated={async () => { await qc.invalidateQueries({ queryKey: ['agents'] }); setOpen(false); }} /></Card>}
      {/* <<< v6 perp agents */}
      {open && kind === 'spot' && <Card className="space-y-4">
        <Field label={t('agName')}><input className={inputCls} maxLength={40} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="ETH Trend" /></Field>
        <Field label={t('agMission')}><textarea className={`${inputCls} min-h-[72px] resize-none`} maxLength={400} value={f.mission} onChange={(e) => setF({ ...f, mission: e.target.value })} /></Field>
        <Field label={t('agNetwork')} hint={t('agNetworkNote')}><select className={inputCls} value={f.network} onChange={(e) => setF({ ...f, network: e.target.value, universe: [], assets: {}, cash: '' })}>
          {(nets.data?.networks ?? [{ id: 'base', name: 'Base', enabled: true } as Net]).map((n) => <option key={n.id} value={n.id} disabled={!n.enabled}>{n.name}{n.enabled ? '' : ` — ${t('agNetOff')}`}</option>)}</select></Field>
        {net?.feeWarning && <Notice tone="warn">{t('agFeeWarn', { cost: net.gas?.perOrderUsd != null ? t('agFeeCost', { usd: numFmt(net.gas.perOrderUsd, locale, 2) }) : '' })}</Notice>}
        {net && net.cash.length > 1 && <Field label={t('agCash')}><select className={inputCls} value={cash} onChange={(e) => setF({ ...f, cash: e.target.value })}>{net.cash.map((c) => <option key={c.symbol} value={c.symbol}>{c.symbol} — {c.name}</option>)}</select></Field>}
        {cashDef && cashIss && <p className="-mt-2 text-[12.5px] text-mute" data-testid="cash-issuer">{t('qaCashNote', { net: net!.name, sym: cashDef.symbol, name: cashDef.name, issuer: cashIss.text })}{cashDec !== undefined && cashDec !== 6 ? ` ${t('qaCashDecimals', { dec: cashDec })}` : ''}</p>}
        <div><div className="mb-2 text-[13px] text-mute">{t('agUniverse', { cash })}</div>
          {nets.isLoading || !net ? <Skeleton h="h-16" /> : <div className="flex flex-wrap gap-2">{net.symbols.map((y) => { const on = f.universe.includes(y.symbol), full = !on && f.universe.length >= maxSym, r = reprOf(y), ready = !!(y.data['1h'] ?? y.data['1d']); return (
            <button key={y.symbol} role="checkbox" aria-checked={on} disabled={full} title={`${y.representations.map((x) => x.name).join(' / ')} · ${y.sources.join(', ')}`} onClick={() => setF({ ...f, universe: on ? f.universe.filter((x) => x !== y.symbol) : [...f.universe, y.symbol] })}
              className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-[14px] font-medium ${on ? 'border-primary bg-primary text-onprimary' : 'border-line'} ${full ? 'opacity-40' : ''}`}><Coin sym={y.symbol} size={22} />{y.symbol}
              {r && r.assetSymbol !== y.symbol && <span className="text-[12px] font-normal opacity-80">{r.assetSymbol}</span>}
              {r && r.assetSymbol === y.symbol && iss(r) && <span className="text-[11px] font-normal opacity-80">{t(`qaTag_${iss(r)!.kind}` as Key)}</span>}
              {!y.live && <span className="rounded-full bg-warn/15 px-1.5 text-[10.5px] font-semibold text-warn">{t('agPaperOnly')}</span>}
              {!ready && <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-label={t('agNoData')} title={t('agNoData')} />}</button>); })}</div>}
          <p className="mt-2 text-[12.5px] text-mute">{t('agUniverseNote', { max: maxSym, live: nets.data?.maxLiveSymbols ?? 11 })}</p>
          {noData && <p className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-mute"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden="true" />{t('qaNoDataLegend')}</p>}
          {chosen.filter((y) => y.representations.length > 1).map((y) => { const cur = reprOf(y), liquid = LIQUID_HINT[f.network]?.[y.symbol], hint = liquid && y.representations.some((x) => x.assetSymbol === liquid) ? liquid : null, def = y.representations.find((x) => x.asset === y.defaultAsset);
            // every representation is shown with its name and issuer, one tap each: nothing is hidden in a select
            return <fieldset key={y.symbol} className="mt-3" data-testid={`repr-${y.symbol}`}><legend className="mb-1.5 text-[13px] text-mute">{y.symbol} — {t('agRepr')}</legend>
              <div role="radiogroup" aria-label={`${y.symbol} — ${t('agRepr')}`} className="space-y-2">{y.representations.map((x) => { const on = cur?.asset === x.asset, i = iss(x); return (
                <button key={x.asset} type="button" role="radio" aria-checked={on} onClick={() => setF({ ...f, assets: { ...f.assets, [y.symbol]: x.asset } })} className={`flex w-full items-start gap-3 rounded-2xl border px-3.5 py-3 text-left ${on ? 'border-primary bg-elev/70' : 'border-line'}`}>
                  <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border ${on ? 'border-primary bg-primary text-onprimary' : 'border-line'}`}>{on && <Icon n="check" className="h-3 w-3" />}</span>
                  <span className="min-w-0 flex-1"><span className="block text-[14.5px] font-semibold">{x.assetSymbol} <span className="font-normal text-mute">— {x.name}</span></span>
                    <span className="block text-[12.5px] text-mute">{x.kind === 'native' ? t('agReprNative') : i ? t('agIssuer', { issuer: i.text }) : t('agReprToken')}</span>
                    {(x.asset === y.defaultAsset || x.assetSymbol === hint) && <span className="mt-1 flex flex-wrap gap-1.5">{x.asset === y.defaultAsset && <span className="rounded-full bg-elev px-2 py-0.5 text-[11px] font-semibold text-mute">{t('qaReprDefault')}</span>}{x.assetSymbol === hint && <span className="rounded-full bg-emerald/10 px-2 py-0.5 text-[11px] font-semibold text-emerald">{t('qaReprLiquid', { net: net!.name })}</span>}</span>}</span></button>); })}</div>
              {hint && def && def.assetSymbol !== hint && <p className="mt-1.5 text-[12.5px] text-mute">{t('qaReprHint', { net: net!.name, liquid: hint, sym: y.symbol, def: def.assetSymbol })}</p>}
              {!cur && <p className="mt-1.5 text-[12.5px] text-warn">{t('qaReprChoose', { sym: y.symbol })}</p>}</fieldset>; })}
          {wrapped.length > 0 && <div className="mt-3"><Notice tone="warn">{t('agIssuerNote', { assets: wrapped.join(' ; ') })}</Notice></div>}
          {paperOnly.length > 0 && <div className="mt-3"><Notice tone="info">{t('agPaperOnlyNote', { assets: paperOnly.join(', ') })}</Notice></div>}
          {net?.gas && <p className="mt-2 text-[12.5px] text-mute">{t('agGasReserve', { amount: trimAmt(net.gas.reserve, 6), sym: net.native })}{net.gas.perOrderUsd != null && ` ${t('agFeeShare', { usd: numFmt(net.gas.perOrderUsd, locale, net.gas.perOrderUsd < 0.1 ? 4 : 2), pct: numFmt((100 * net.gas.perOrderUsd) / Math.max(1, f.maxOrderUsd), locale, 1) })}`}</p>}</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('agCapital')}><div className="flex items-center gap-2"><input className={inputCls} inputMode="decimal" value={f.capital} onChange={(e) => setF({ ...f, capital: sanitizeAmountText(e.target.value) })} /><span className="w-12 shrink-0 text-[13px] text-mute" data-testid="capital-unit">USD</span></div><AmountProblem text={f.capital} /></Field>
          <Field label={t('agInterval')}><select className={inputCls} value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value })}><option value="1h">{t('qaIv_1h')}</option><option value="1d">{t('qaIv_1d')}</option></select></Field>
          {num('maxExposurePct', t('agMaxExposure'), '%', 1, 100)}{num('maxLossPct', t('agMaxLoss'), '%', 1, 100)}
          {num('maxOrderUsd', t('agMaxOrder'), 'USD', 1, 100000)}{num('maxDailyUsd', t('agMaxDaily'), 'USD', 1, 1000000)}
        </div>
        <Notice tone="warn">{t('agLossNote')}</Notice>
        {err && <Notice tone="danger">{err}</Notice>}
        <Btn full busy={busy} disabled={f.name.trim().length < 2 || !f.universe.length || f.universe.length > maxSym || undecided || !net?.enabled || !/[1-9]/.test(amountOf(f.capital, locale) ?? '')} onClick={() => void create()}>{t('agCreate')}</Btn>
      </Card>}
      {q.isLoading ? <Skeleton h="h-40" /> : (q.data?.agents.length ?? 0) === 0 ? !open && <Card><p className="py-6 text-center text-[14px] text-mute">{t('agNone')}</p></Card> :
        <div className="space-y-3">{q.data!.agents.map((a) => <button key={a.id} onClick={() => nav({ tab: 'agent', asset: a.id })} className="card flex w-full items-center gap-3.5 p-4 text-left">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-elev"><Icon n="swap" /></span>
          <span className="min-w-0 flex-1"><span className="block truncate text-[16px] font-semibold">{a.name}</span><span className="block truncate text-[12.5px] text-mute">{a.universe.join(' · ')} · {usdCapital(a.capitalUsdc, locale)} · {a.networkName}</span>{(a as { kind?: string }).kind === 'perp' && <span className="mt-0.5 inline-block rounded-md border border-blue/35 bg-blue/8 px-1.5 text-[10.5px] font-bold uppercase tracking-[0.06em] text-blue">{t('paListTag')}</span>}</span>
          {(a as { kind?: string }).kind === 'perp' && agentTone(a) !== 'paper' ? <PerpLiveState a={a} /> : <AgentState state={a.state} />}<Icon n="chev" className="h-4 w-4 text-mute" /></button>)}</div>}
    </div>
  );
}

export function Agent({ id, nav }: { id: string; nav: Nav }) {
  const t = useT(); const { locale } = useContext(I18n); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['agent', id], queryFn: () => get<any>(`/agents/${id}`), refetchInterval: 15_000 });
  const spot = !!q.data && q.data.kind !== 'perp'; // v6: the vault and the spot library do not exist for a perp agent
  // gas reserve of the agent's network (same query as the creation form)
  const netsQ = useQuery({ queryKey: ['agent-networks'], queryFn: () => get<{ networks: AgentNet[]; feeWarnShare?: number }>('/agents/networks'), staleTime: 60_000, enabled: spot });
  const [sheet, setSheet] = useState<'' | 'fund' | 'withdraw'>('');
  const lib = useQuery({ queryKey: ['strategies'], queryFn: () => get<{ strategies: any[] }>('/strategies'), staleTime: 300_000, enabled: spot });
  const [busy, setBusy] = useState(''), [err, setErr] = useState(''), [mandate, setMandate] = useState<any>(null), [note, setNote] = useState('');
  if (q.isLoading || !q.data) return <div className="space-y-4"><Skeleton h="h-40" /><Skeleton h="h-56" /></div>;
  const a = q.data;
  if (a.kind === 'perp') return <PerpAgentDetail a={a} id={id} nav={nav} />; // v6: simulation-only detail page
  const act = async (name: string, fn: () => Promise<unknown>) => { setBusy(name); setErr(''); setNote(''); try { await fn(); await qc.invalidateQueries({ queryKey: ['agent', id] }); await qc.invalidateQueries({ queryKey: ['agents'] }); } catch (e) { const m = errText(t, e); if (m) setErr(m); } finally { setBusy(''); } };
  const prepare = async () => { setBusy('prepare'); setErr(''); setNote('');
    try { setMandate(await post(`/agents/${id}/mandate/prepare`)); }
    catch (e) { // the two documented refusals, in the owner's language: no gas reserve (with the figures), no signer price
      const m = /holds ([\d.]+) (\w+); live trading on (.+?) needs a gas reserve of ([\d.]+)/.exec((e as { message?: string }).message ?? '');
      setErr((e as { code?: string }).code === 'insufficient_gas' && m ? t('qaAgNoGas', { held: trimAmt(m[1]!, 6), sym: m[2]!, net: m[3]!, need: trimAmt(m[4]!, 6) }) : errText(t, e)); }
    finally { setBusy(''); } };
  const approveMandate = () => act('mandate', async () => { const assertion = await startAuthentication({ optionsJSON: mandate.options }); await post(`/agents/${id}/mandate/approve`, { assertion }); setMandate(null); });
  const vaultUsd = (a.vault ?? []).reduce((s: number, x: any) => s + (x.usd ?? 0), 0);
  const eq = (a.equity as any[]).filter((e) => e.mode === (a.state === 'LIVE' ? 'LIVE' : 'PAPER')).map((e) => ({ t: new Date(e.ts).getTime(), p: e.equity_usd }));
  const approved = (a.versions as any[]).find((v) => v.id === a.strategyVersionId);
  const metric = (v: any, split: string, k: string) => { const x = v.metrics?.[split]?.[k]; return typeof x === 'number' ? x : null; };
  const pct = (x: number | null) => (x === null ? '—' : `${numFmt(x * 100, locale, 1)} %`), num2 = (x: number | null) => (x === null ? '—' : numFmt(x, locale, 2));
  const iss = (r: { assetSymbol: string; name: string; issuer?: string | null }) => issuerOf(t, r.assetSymbol, r.name, r.issuer);
  // every holding with an issuer, cash leg included ("USDC (Binance-Peg USD Coin) — Binance…")
  const issuers: string[] = ((a.holdings ?? []) as any[]).flatMap((h) => { const i = iss(h); return i ? [`${h.assetSymbol}${h.name !== h.assetSymbol ? ` (${h.name})` : ''} — ${i.text}`] : []; });
  // what creation warned about, recomputed from live data so that it stays visible after navigation (and in the owner's language)
  const anet = netsQ.data?.networks.find((n) => n.id === a.network), syms = (a.universe as string[]).filter((x) => x !== a.cash);
  const paperOnly = anet ? syms.filter((x) => anet.symbols.find((y) => y.symbol === x)?.live === false) : [];
  const feeShare = anet?.gas?.perOrderUsd != null && a.risk?.maxOrderUsd > 0 ? anet.gas.perOrderUsd / a.risk.maxOrderUsd : null;
  const stopText = (r: string) => { const loss = /^loss limit reached: equity ([\d.]+) USD against ([\d.]+) USD allocated \(limit ([\d.]+) %\); positions were sold to (\w+)/.exec(r);
    return loss ? t('qaStop_loss', { eq: numFmt(Number(loss[1]), locale, 2), cap: numFmt(Number(loss[2]), locale, 2), lim: loss[3]!, cash: loss[4]! })
      : r === 'stopped by the owner' ? t('qaStop_owner') : r === 'mandate revoked by the owner' ? t('qaStop_revoked') : /^the mandate expired/.test(r) ? t('qaStop_expired') : /no longer matches the mandate/.test(r) ? t('qaStop_mismatch') : r; };
  const orderReason = (r: string) => { const m = /^target ([\d.]+) %$/.exec(r); return m ? t('qaOrderTarget', { pct: numFmt(Number(m[1]), locale, 1) }) : r; };
  const logTitle = (x: string) => ({ 'No valid signal: holding': t('qaLog_hold'), 'No executable quote: order skipped': t('qaLog_noquote'), 'Agent stopped': t('qaLog_stopped') } as Record<string, string>)[x] ?? x;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 pt-1"><button onClick={() => nav({ tab: 'agents' })} aria-label={t('back')} className="-ml-2 grid h-11 w-11 place-items-center rounded-full"><Icon n="chev" className="h-6 w-6 rotate-180" /></button>
        <div className="min-w-0 flex-1"><h1 className="truncate text-[24px] font-semibold tracking-tight">{a.name}</h1><div className="text-[13px] text-mute">{a.universe.join(' · ')} · {a.interval} · {a.networkName}</div></div><AgentState state={a.state} /></div>
      {a.mission && <p className="text-[14px] text-mute">{a.mission}</p>}
      {a.stopReason && <Notice tone="warn">{stopText(a.stopReason)}</Notice>}
      {a.state !== 'LIVE' && <div className="space-y-2" data-testid="agent-warnings">
        {paperOnly.length > 0 && <Notice tone="warn">{t('agPaperOnlyNote', { assets: paperOnly.join(', ') })}</Notice>}
        {syms.length > 11 && <Notice tone="warn">{t('qaWarnTooMany', { n: syms.length })}</Notice>}
        {feeShare !== null && feeShare > (netsQ.data?.feeWarnShare ?? 0.01) && <Notice tone="warn">{t('qaWarnFees', { net: a.networkName, usd: numFmt(anet!.gas!.perOrderUsd!, locale, anet!.gas!.perOrderUsd! < 0.1 ? 4 : 2), pct: numFmt(100 * feeShare, locale, 1), max: a.risk.maxOrderUsd })}</Notice>}</div>}
      {err && <Notice tone="danger">{err}</Notice>}{note && <Notice tone="ok">{note}</Notice>}

      <AgentChecklist a={a} gas={netsQ.data?.networks.find((n) => n.id === a.network)?.gas ?? null} approved={!!approved} busy={busy}
        onFund={() => setSheet('fund')} onStrategy={() => document.getElementById('qa-strategies')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        onPaper={() => void act('paper', () => post(`/agents/${id}/mode`, { mode: 'PAPER' }))} onLive={() => { document.getElementById('qa-control')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); void prepare(); }} />
      {sheet === 'fund' && <FundSheet a={a} gas={netsQ.data?.networks.find((n) => n.id === a.network)?.gas ?? null} nav={nav} onClose={() => { setSheet(''); void qc.invalidateQueries({ queryKey: ['agent', id] }); }} />}
      {sheet === 'withdraw' && <WithdrawSheet a={a} onClose={() => setSheet('')} />}

      <Card><H>{t('agVault')}</H>
        <div className="text-[30px] font-semibold tracking-tight">{fiat(vaultUsd, 'USD', locale)}</div>
        <div className="text-[13px] text-mute" data-testid="agent-capital">{t('agAllocated')} {usdCapital(a.capitalUsdc, locale)}</div>
        {a.state === 'PAPER_TRADING' && <div className="mt-3" data-testid="paper-vault-note"><Notice tone="info">{t('qaPaperVaultNote')}</Notice></div>}
        <ul className="mt-3 divide-y divide-line">{(a.vault ?? []).map((x: any) => <li key={x.asset} className="flex items-center gap-3 py-2.5"><Coin sym={x.symbol} size={32} /><span className="flex-1 text-[15px] font-medium">{x.symbol}{x.role === 'gas' ? <span className="block text-[12px] font-normal text-mute">{t('agGasRole')}</span> : (x.assetSymbol && x.assetSymbol !== x.symbol) || iss(x) ? <span className="block text-[12px] font-normal text-mute">{t('agHeldAs', { asset: x.name && x.name !== x.assetSymbol ? `${x.assetSymbol} — ${x.name}` : x.assetSymbol })}{iss(x) ? ` · ${t('agIssuer', { issuer: iss(x)!.text })}` : ''}</span> : null}</span><span className="text-right text-[14.5px] font-semibold">{trimAmt(x.display, 8)}<span className="block text-[12px] font-normal text-mute">{x.usd !== null ? fiat(x.usd, 'USD', locale) : ''}</span></span></li>)}</ul>
        <div className="mt-3 rounded-2xl bg-elev/70 p-3"><div className="mb-1 text-[12px] text-mute">{t('agVaultAddr', { network: a.networkName })}</div><Addr value={a.vaultAddress} /></div>
        <div className="mt-3 space-y-2.5">
          <Btn full onClick={() => setSheet('fund')}><Icon n="up" className="h-4 w-4" />{fundingInProgress(a.id) ? t('qaFundResume') : t('qaFundOpen')}</Btn>
          <div className="grid grid-cols-2 gap-3"><CopyBtn text={a.vaultAddress} full />
            <Btn kind="soft" disabled={!(a.vault ?? []).some((x: any) => x.amount !== '0')} onClick={() => setSheet('withdraw')}><Icon n="down" className="h-4 w-4" />{t('agWithdraw')}</Btn></div></div>
        <p className="mt-2 text-[12.5px] text-mute">{t('qaFundNote', { cash: a.cash ?? 'USDC', native: (a.vault ?? []).find((x: any) => x.asset === 'native')?.assetSymbol ?? 'ETH', network: a.networkName })}</p>
        {issuers.length > 0 && <div className="mt-3"><Notice tone="warn">{t('agIssuerNote', { assets: issuers.join(' ; ') })}</Notice></div>}
        <ElsewhereFunds a={a} />
      </Card>
      {/* v8 hardening: the paper book, a card of its own — never mixed with the real vault above */}
      {showPaperBook(a) && <PaperBookCard paper={a.paper} />}

      {eq.length > 1 && <Card><H>{t('agEquity')}</H><PriceChart points={eq} format={(v) => fiat(v, 'USD', locale)} formatTime={(ts) => new Date(ts).toLocaleDateString(locale === 'fr' ? 'fr-CA' : 'en-CA', { day: 'numeric', month: 'short' })} /></Card>}

      <div id="qa-strategies" className="scroll-mt-20" /><Card><H>{t('agStrategy')}</H>
        {(a.versions as any[]).length === 0 ? <p className="text-[14px] text-mute">{t('agNoStrategy')}</p> : <ul className="space-y-3">{(a.versions as any[]).map((v) => <li key={v.id} className="rounded-2xl bg-elev/70 p-3.5">
          <div className="flex items-center justify-between gap-2"><span className="font-semibold">{v.name} <span className="font-normal text-mute">v{v.version}</span></span><span className="rounded-full bg-surface px-2 py-0.5 text-[11.5px] font-semibold">{t(`agV_${v.status}` as Key)}</span></div>
          <div className="mt-1 break-all font-mono text-[11px] text-mute">sha256 {v.code_sha256}</div>
          {v.metrics ? <><div className="mt-2.5 grid grid-cols-3 gap-2 text-center text-[12.5px]">
            {[[t('agTest'), 'test'], [t('agBench'), null]].length && null}
            <div className="rounded-xl bg-surface p-2"><div className="text-mute">{t('agRet')}</div><div className="text-[14px] font-semibold">{pct(metric(v, 'test', 'total_return'))}</div><div className="text-[11px] text-mute">{t('agVs')} {pct(v.benchmarks?.buy_and_hold?.total_return ?? null)}</div></div>
            <div className="rounded-xl bg-surface p-2"><div className="text-mute">Sharpe</div><div className="text-[14px] font-semibold">{num2(metric(v, 'test', 'sharpe'))}</div><div className="text-[11px] text-mute">{t('agVs')} {num2(v.benchmarks?.buy_and_hold?.sharpe ?? null)}</div></div>
            <div className="rounded-xl bg-surface p-2"><div className="text-mute">{t('agDD')}</div><div className="text-[14px] font-semibold">{pct(metric(v, 'test', 'max_drawdown'))}</div><div className="text-[11px] text-mute">{t('agVs')} {pct(v.benchmarks?.buy_and_hold?.max_drawdown ?? null)}</div></div></div>
            <p className="mt-2 text-[12px] text-mute">{t('agReportNote', { trials: v.robustness?.trials_tested ?? '?', dsr: typeof v.robustness?.deflated_sharpe === 'number' ? numFmt(v.robustness.deflated_sharpe, locale, 2, 2) : '?', fee: v.config?.fee_bps ?? '?', slip: v.config?.slippage_bps ?? '?' })}</p></>
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

      {/* v7 research runtime */}<ResearchPanel agent={a} nav={nav} />

      <div id="qa-control" className="scroll-mt-20" /><Card><H>{t('agControl')}</H>
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
          {issuers.length > 0 && <Notice tone="warn">{t('agIssuerNote', { assets: issuers.join(' ; ') })}</Notice>}
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
          <span className="min-w-0 flex-1"><span className="block text-[14px] font-medium">{o.from_symbol} → {o.to_symbol} <span className="font-normal text-mute">· {o.mode === 'LIVE' ? t('agLive') : t('agPaper')}</span></span><span className="block truncate text-[12px] text-mute">{when(o.ts, locale)}{o.reason ? ` · ${orderReason(o.reason)}` : ''}</span></span>
          <span className={`rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${o.state === 'filled' ? 'bg-emerald/10 text-emerald' : o.state === 'failed' ? 'bg-danger/10 text-danger' : 'bg-elev text-mute'}`}>{t(`agO_${o.state}` as Key)}</span></li>)}</ul>}</Card>

      <Card><H>{t('agLog')}</H>
        {(a.log as any[]).length === 0 ? <p className="text-[14px] text-mute">{t('agNoLog')}</p> : <ul className="space-y-2.5 text-[13px]">{(a.log as any[]).map((l, k) => <li key={k}><div className="flex justify-between gap-2"><span className="font-medium">{logTitle(l.title)}</span><span className="shrink-0 text-[12px] text-mute">{when(l.ts, locale)}</span></div>{l.body && <div className="whitespace-pre-wrap text-mute">{String(l.body).slice(0, 600)}</div>}</li>)}</ul>}</Card>
    </div>
  );
}
